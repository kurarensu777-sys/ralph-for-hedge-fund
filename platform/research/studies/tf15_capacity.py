"""How much each buy-near test can buy at its own price (um-021 S2.2, rewritten 2026-10-11): numpy on the pooled table of `tf15_bt`, figures on `figstyle`.
No I/O.

THE FILL RULE. Every test's limit is the near token's ask at the decision second (`tf15_cands.quotes`); 250 ms later `tf15_bt.walk_buy` takes what rests at
or under that price, at least 5 shares, and stops. A thin touch is a smaller trade, never a worse price. `fill_rule` reads, on a test's own entries, the
share that got the whole clip (cost at least the clip less one cent), the share that got less, and the median USD of the smaller trades.
OUR PRICE. Two definitions, each column and chart names its own. (1) The ask we saw: the rule as run. (2) Our edge price: fair value less the margin at the
decision second, `pu - theta` for an Up buy, `(1 - pu) - theta` for a Down buy (`edge_price`), the gate's own threshold, so every level at or under it still
carries the edge the rule demands. Test C has no price gate: the formula is the same, C does not require it at entry, and its edge price can sit under the ask.
THE WALK. `walk_to` walks each entry's ask ladder at its fill second (the ladder 250 ms after the decision, `tf15_bt.ladder_of`, four levels, the Down asks
the mirror of the Up bids) with each trial clip up to a limit, never beyond it: shares, cost, fee, VWAP, levels used, filled in full, and the cents the VWAP
sits over the best ask at the fill. `under_price` is the USD resting at or under a price. Depth past the fourth level is not in the table, so every depth
number is a floor and a clip that needs a fifth level reads as not filled in full.
THE RE-RUN. `rerun_at` re-runs a test through `tf15_bt.entries` with the clip and the limit raised from the ask seen to the edge price (`np.fmax`: where the
edge price is under the ask seen, test C only, the limit stays the ask). The trigger is unchanged; only the fill may walk up. A higher limit and a clip at
least the base clip fill wherever the base filled, so the re-run's windows are a superset of the base test's (checked on the data in `data_checks`).
THE ESTIMATE. One row a test (`estimate`): entries a day; the USD at the ask seen and under the edge price at the fill second; levels used and cents over
the ask at 20 and 100 USD; the largest clip that fills in full for 90% of entries when walking to the edge price; the largest clip whose re-run keeps the
net an entry without the best 5% above zero (the largest such clip, the clips above zero named beside it); what that clip does a day. Participation (10% of the near-side USD
traded after entry) is a sensitivity, [U], never used to set the clip. Our own order would change the book: that is not modelled.
"""
from __future__ import annotations

import numpy as np

import tf15_bt as B

CLIPS = (20.0, 50.0, 100.0, 200.0, 500.0)
LEVELS = 4
FULL_TOL = 0.01                 # filled in full: the cost is at least the clip less a cent (the walk floors shares to 0.01)
FULL_SHARE = 0.90               # the clip that fills in full on at least this share of entries
PART = 0.10                     # the participation convention [U], a sensitivity only
THETA = 0.05
FOCUS = ("A", "E")              # the tests drawn in full; the others in grey
COIN_NAMES = ("btc", "eth", "sol", "xrp")
HIST_EDGES = np.concatenate([[0.0], np.logspace(-2, 6, 801)])     # USD bins for the unconditional quantiles: 100 a decade, under 2.4% apart


# ============================================================ the ladder and our price
def ask_ladder(tab, w, k, side):
    """The near token's ask ladder at (w, k) for `side`, in USD. -> px, sz (N, 4) as `ladder_of` returns them, usd (N, 4) per level (0 where a level
    is empty), cum (N, 4) cumulative USD at levels 1 to 4."""
    px, sz = B.ladder_of(tab, np.asarray(w), np.asarray(k), np.asarray(side), buy=True)
    with np.errstate(invalid="ignore"):
        usd = np.where(np.isfinite(px) & np.isfinite(sz) & (sz > 0) & (px > 0), px.astype(float) * sz, 0.0)
    return px, sz, usd, np.cumsum(usd, axis=1)


def ask_seen(tab, e):
    """The near token's ask at the decision second, in the table's own float32 arithmetic as `tf15_cands.quotes` builds the limit. -> (N,)"""
    w, k, s = np.asarray(e["w"], int), np.asarray(e["k"], int), np.asarray(e["side"], int)
    return np.where(s > 0, tab.qa[w, k].astype(float), (1.0 - tab.qb[w, k]).astype(float))


def edge_price(tab, e, theta=THETA):
    """Our edge price at the decision second: `pu - theta` for an Up buy, `(1 - pu) - theta` for a Down buy. -> (N,)"""
    w, k, s = np.asarray(e["w"], int), np.asarray(e["k"], int), np.asarray(e["side"], int)
    pu = tab.pu[w, k].astype(float)
    return np.where(s > 0, pu - theta, 1.0 - pu - theta)


def _walk_levels(px, sz, usd, limit, rate):
    """`tf15_bt.walk_buy` with the shares taken at each level kept. -> shares, cost, fee (N,), take (N, L)."""
    N, Lv = px.shape
    left = np.full(N, float(usd))
    take = np.zeros((N, Lv))
    cost = np.zeros(N)
    fee = np.zeros(N)
    lim = np.asarray(limit, float)
    for j in range(Lv):
        p, s = px[:, j], sz[:, j]
        good = np.isfinite(p) & np.isfinite(s) & (s > 0) & (p <= lim + 1e-9) & (left >= 0.01) & (p > 0)
        t = np.where(good, np.minimum(s, np.floor(np.where(good, left / np.where(p > 0, p, 1), 0) * 100.0) / 100.0), 0.0)
        take[:, j] = t
        cost += t * np.where(good, p, 0.0)
        fee += t * rate * np.where(good, p * (1.0 - p), 0.0)
        left -= t * np.where(good, p, 0.0)
    return take.sum(axis=1), cost, fee, take


def walk_to(tab, e, clips=CLIPS, limit=None):
    """Walk every entry's ask ladder at its fill second with each clip, never above `limit` (N,) (default: our edge price). -> dict of (N, X) arrays
    shares, cost, fee, vwap, levels (levels the walk took from), full (cost at least the clip less a cent), cents (VWAP over the best ask at the fill,
    cents); and (N,) best, limit, and `clips`."""
    w, k, s = np.asarray(e["w"], int), np.asarray(e["k"], int), np.asarray(e["side"], int)
    px, sz = B.ladder_of(tab, w, k, s, buy=True)
    rate = np.asarray(tab.w_fee, float)[w]
    lim = edge_price(tab, e) if limit is None else np.asarray(limit, float)
    N, X = len(w), len(clips)
    out = {key: np.full((N, X), np.nan) for key in ("shares", "cost", "fee", "vwap", "cents")}
    out["levels"] = np.zeros((N, X), int)
    out["full"] = np.zeros((N, X), bool)
    best = px[:, 0].astype(float) if N else np.zeros(0)
    for j, x in enumerate(clips):
        sh, co, fe, take = _walk_levels(px, sz, float(x), lim, rate)
        ok = sh > 0
        vw = np.where(ok, co / np.where(ok, sh, 1.0), np.nan)
        out["shares"][:, j], out["cost"][:, j], out["fee"][:, j], out["vwap"][:, j] = sh, co, fe, vw
        out["cents"][:, j] = (vw - best) * 100.0
        out["levels"][:, j] = (take > 0).sum(axis=1)
        out["full"][:, j] = co >= float(x) - FULL_TOL
    out.update(best=best, limit=lim, clips=np.asarray(clips, float))
    return out


def under_price(tab, e, price):
    """The USD resting on the near token's ask at or under `price` (N,) at the fill second, four levels (a floor). -> (N,)"""
    px, _, usd, _ = ask_ladder(tab, e["w"], e["k"], e["side"])
    p = np.where(np.isfinite(px), px.astype(float), np.inf)
    return np.sum(np.where(p <= np.asarray(price, float)[:, None] + 1e-9, usd, 0.0), axis=1)


def fill_rule(e, clip=B.CLIP_USD):
    """On a test's own entries: the share that got the whole clip, the share that got less, the median USD of the smaller trades."""
    cost = np.asarray(e["cost"], float)
    full = cost >= clip - FULL_TOL
    n = len(cost)
    return dict(n=n, full=float(full.mean()) if n else np.nan, small=float((~full).mean()) if n else np.nan,
                small_med=float(np.median(cost[~full])) if (~full).any() else np.nan, n_small=int((~full).sum()))


# ============================================================ the re-run with the limit raised to the edge price
_Q = {}


def _quotes(tab):
    """(Up ask seen, Down ask seen, P(Up)) as (W, NK) float64, built once a table."""
    hit = _Q.get(id(tab))
    if hit is None or hit[0] is not tab:
        hit = (tab, tab.qa.astype(float), (1.0 - tab.qb).astype(float), tab.pu.astype(float))
        _Q.clear()
        _Q[id(tab)] = hit
    return hit[1:]


def _rule(tab, masks, lab, t_min, limit, theta):
    g_up, g_dn = masks["gates"][lab]
    side = np.where(g_up, 1, np.where(g_dn, -1, 0))
    trig = (g_up | g_dn) & ((tab.T[None, :] >= t_min) & (tab.T[None, :] <= B.WIN_S))
    qa, qd, pu = _quotes(tab)
    ask = np.where(side > 0, qa, qd)
    if limit == "ask":
        return side, trig, ask
    edge = np.where(side > 0, pu - theta, 1.0 - pu - theta)
    return side, trig, np.fmax(ask, edge)


def rerun_at(tab, masks, lab, clip, t_min, limit="edge", theta=THETA):
    """Test `lab` re-run through `tf15_bt.entries` with `clip` USD a trade and the limit raised from the ask seen to our edge price (limit "edge"),
    or at the ask seen (limit "ask", the rule as run). The trigger is the test's own gate and time mask. -> entries dict in window order."""
    side, trig, lim = _rule(tab, masks, lab, t_min, limit, theta)
    return B.entries(tab, side, trig, lim, usd=float(clip))


def _ex_top(v, pct=5):
    v = np.sort(np.asarray(v, float))
    n = len(v)
    k_ = int(np.ceil(pct / 100.0 * n))
    return float(v[:n - k_].mean()) if n - k_ > 0 else float("nan")


def rerun_curve(tab, masks, lab, ndays, t_min, clips=CLIPS, theta=THETA, n_boot=2000):
    """`rerun_at` at every clip, the rule built once. -> list of dicts: clip, n, per_day, per (net an entry), lo, hi (95% by slot), ex5 (net an entry
    without the best 5%), spent (mean cost), full (share filled in full), day_net (entries a day x net an entry), windows (set)."""
    side, trig, lim = _rule(tab, masks, lab, t_min, "edge", theta)
    rows = []
    for x in clips:
        e = B.entries(tab, side, trig, lim, usd=float(x))
        n = len(e["net"])
        lo, hi = B.slot_boot(e["slot"], e["net"], n_boot=n_boot) if n else (np.nan, np.nan)
        per = float(e["net"].mean()) if n else np.nan
        rows.append(dict(clip=float(x), n=n, per_day=n / ndays, per=per, lo=lo, hi=hi, ex5=_ex_top(e["net"]) if n else np.nan,
                         spent=float(e["cost"].mean()) if n else np.nan, full=float(np.mean(e["cost"] >= float(x) - FULL_TOL)) if n else np.nan,
                         day_net=n / ndays * per if n else np.nan, windows=set(np.asarray(e["w"]).tolist())))
    return rows


def is_superset(base, other):
    """True when every window `base` entered is a window `other` entered too."""
    return set(np.asarray(base["w"]).tolist()) <= set(np.asarray(other["w"]).tolist())


# ============================================================ the depth, unconditional
def hist_quantile(counts, qs):
    """Quantiles (USD) from counts over HIST_EDGES, geometric inside a bin (linear in the first, which starts at 0)."""
    c = np.asarray(counts, float)
    tot = c.sum()
    if tot <= 0:
        return np.full(len(qs), np.nan)
    cum = np.cumsum(c)
    out = []
    for q in qs:
        t = q * tot
        i = int(np.searchsorted(cum, t, side="left"))
        i = min(i, len(c) - 1)
        prev = cum[i - 1] if i > 0 else 0.0
        frac = (t - prev) / c[i] if c[i] > 0 else 0.0
        a, b = HIST_EDGES[i], HIST_EDGES[i + 1]
        out.append(a + frac * (b - a) if a <= 0 else a * (b / a) ** frac)
    return np.array(out)


def _bin_idx(v):
    return np.clip(np.searchsorted(HIST_EDGES, v, side="right") - 1, 0, len(HIST_EDGES) - 2)


def depth_all(tab, t_min=300, bin_s=15, chunk=1500):
    """Cumulative ask USD at levels 1 to 4 over every second of every window with at least `t_min` s left, both tokens (a token-second with no ask is left
    out), by coin; and the USD at the best ask by seconds left (bins of `bin_s` s), by coin. Means are exact; quantiles come from 100-a-decade histograms.
    -> dict: per coin `mean` (4,), `median` (4,), `p10` (4,), `n` (token-seconds); `t_mid` (seconds left at each bin's centre, ascending), per coin
    `touch_q25`, `touch_med`, `touch_q75` over the bins."""
    W, NK = tab.lad.shape[0], tab.lad.shape[2]
    T = np.asarray(tab.T, float)
    keep_k = T >= t_min
    asset = np.asarray(tab.w_asset)
    nb = int(np.ceil(NK / bin_s))
    bins_of = np.arange(NK) // bin_s
    NH = len(HIST_EDGES) - 1
    acc = {a: dict(s=np.zeros(LEVELS), n=np.zeros(LEVELS), h=np.zeros((LEVELS, NH)), th=np.zeros(nb * NH)) for a in range(len(COIN_NAMES))}
    for c0 in range(0, W, chunk):
        lad = tab.lad[c0:c0 + chunk]
        a_ = asset[c0:c0 + chunk]
        has = (np.isfinite(lad[:, 2, :, 0]) & (lad[:, 3, :, 0] > 0), np.isfinite(lad[:, 0, :, 0]) & (lad[:, 1, :, 0] > 0))
        cum = [np.zeros(has[0].shape), np.zeros(has[0].shape)]
        for j in range(LEVELS):
            with np.errstate(invalid="ignore"):
                lv = (lad[:, 2, :, j].astype(float) * lad[:, 3, :, j], (1.0 - lad[:, 0, :, j].astype(float)) * lad[:, 1, :, j])
            for t_ in (0, 1):
                cum[t_] += np.where(np.isfinite(lv[t_]) & (lv[t_] > 0), lv[t_], 0.0)
            for a in range(len(COIN_NAMES)):
                m = a_ == a
                if not m.any():
                    continue
                for t_ in (0, 1):
                    sel = has[t_][m] & keep_k[None, :]
                    v = cum[t_][m][sel]
                    acc[a]["s"][j] += v.sum()
                    acc[a]["n"][j] += len(v)
                    acc[a]["h"][j] += np.bincount(_bin_idx(v), minlength=NH)
                    if j == 0:
                        hk = has[t_][m]
                        kk = np.broadcast_to(bins_of[None, :], hk.shape)[hk]
                        acc[a]["th"] += np.bincount(kk * NH + _bin_idx(cum[t_][m][hk]), minlength=nb * NH)
    t_mid = np.array([T[bins_of == b].mean() for b in range(nb)])
    order = np.argsort(t_mid)
    out = dict(t_mid=t_mid[order], t_min=t_min, bin_s=bin_s)
    for a, name in enumerate(COIN_NAMES):
        if acc[a]["n"][0] == 0:
            continue
        qs = np.array([hist_quantile(acc[a]["h"][j], (0.10, 0.50)) for j in range(LEVELS)])
        th = acc[a]["th"].reshape(nb, NH)
        tq = np.array([hist_quantile(th[b], (0.25, 0.50, 0.75)) for b in range(nb)])[order]
        out[name] = dict(mean=acc[a]["s"] / acc[a]["n"], median=qs[:, 1], p10=qs[:, 0], n=int(acc[a]["n"][0]),
                         touch_q25=tq[:, 0], touch_med=tq[:, 1], touch_q75=tq[:, 2])
    return out


# ============================================================ the prints
def print_volume(tab, e, slice_s=10):
    """USD traded per entry from the window's prints, at the near token's price: `near_win` near-side over the whole window, `near_slice` near-side in
    the `slice_s` s after the decision second, `near_after` near-side from the decision second to expiry; `all_win`, `all_slice`, `all_after` unsigned
    (every print, whatever its side label). One window's rows are p_off[w]:p_off[w + 1], in time order. -> dict of (N,) arrays."""
    w, k, s = np.asarray(e["w"], np.int64), np.asarray(e["k"], np.int64), np.asarray(e["side"], int)
    key = np.asarray(tab.p_w, np.int64) * 10_000_000 + np.asarray(tab.p_t, np.int64)
    px, sz, ps = np.asarray(tab.p_px, float), np.asarray(tab.p_sz, float), np.asarray(tab.p_side, int)
    if not np.all(np.diff(key) >= 0):                                          # the table keeps window order; a window's rows out of time order are sorted here
        o = np.argsort(key, kind="stable")
        key, px, sz, ps = key[o], px[o], sz[o], ps[o]
    cs = lambda v: np.concatenate([[0.0], np.cumsum(v)])                     # noqa: E731
    up_buy, dn_buy = cs(np.where(ps > 0, px * sz, 0.0)), cs(np.where(ps < 0, (1.0 - px) * sz, 0.0))
    up_all, dn_all = cs(px * sz), cs((1.0 - px) * sz)
    off = np.asarray(tab.p_off, np.int64)                                     # p_off slices one window (the same rows whatever their order inside it)
    a0, a1 = off[w], off[w + 1]
    t0 = (B.K0 + k) * 1000
    s0 = np.clip(np.searchsorted(key, w * 10_000_000 + t0, side="right"), a0, a1)
    s1 = np.clip(np.searchsorted(key, w * 10_000_000 + t0 + slice_s * 1000, side="right"), a0, a1)
    near = lambda lo, hi: np.where(s > 0, up_buy[hi] - up_buy[lo], dn_buy[hi] - dn_buy[lo])    # noqa: E731
    alls = lambda lo, hi: np.where(s > 0, up_all[hi] - up_all[lo], dn_all[hi] - dn_all[lo])    # noqa: E731
    return dict(near_win=near(a0, a1), near_slice=near(s0, s1), near_after=near(s0, a1), all_win=alls(a0, a1), all_slice=alls(s0, s1), all_after=alls(s0, a1))


# ============================================================ the estimate
def _largest(clips, ok):
    """The largest clip of an unbroken run of passes from the smallest clip (0 when the smallest fails)."""
    best = 0.0
    for x, g in zip(clips, ok):
        if not g:
            break
        best = float(x)
    return best


def _at(clips, x):
    return list(clips).index(x) if x in list(clips) else None


def estimate(tab, e, masks, lab, ndays, t_min=300, theta=THETA, clips=CLIPS, n_boot=2000):
    """The capacity read of one test. -> dict: `row` (the table's numbers), `walk` (walk_to to the edge price), `curve` (rerun_curve), `usd_ask`,
    `usd_edge` (N,) the USD at or under the ask seen and the edge price at the fill second, `room_c` (N,) the edge price less the ask seen in cents,
    `fill` (fill_rule), `part` (participation clip [U]), `n`."""
    ask = ask_seen(tab, e)
    edge = edge_price(tab, e, theta)
    wk = walk_to(tab, e, clips, edge)
    usd_ask, usd_edge = under_price(tab, e, ask), under_price(tab, e, edge)
    curve = rerun_curve(tab, masks, lab, ndays, t_min, clips, theta, n_boot)
    pv = print_volume(tab, e)
    n = len(ask)
    got = wk["shares"] > 0

    def lv(j):
        m = got[:, j]
        return float(wk["levels"][m, j].mean()) if m.any() else np.nan

    def ct(j):
        m = got[:, j]
        return float(np.mean(wk["cents"][m, j])) if m.any() else np.nan
    full = wk["full"].mean(axis=0) if n else np.zeros(len(clips))
    ex5 = np.array([r["ex5"] for r in curve])
    pos = [float(x) for x, v in zip(clips, ex5) if np.isfinite(v) and v > 0]
    surv = max(pos) if pos else 0.0                                            # the largest clip whose ex-5% net is above zero (not required to be a run)
    js = _at(clips, surv)
    row = dict(n=n, per_day=n / ndays, usd_ask_med=float(np.median(usd_ask)) if n else np.nan, usd_edge_med=float(np.median(usd_edge)) if n else np.nan,
               usd_edge_p10=float(np.percentile(usd_edge, 10)) if n else np.nan, full=full,
               fits={x: float(np.mean(usd_edge >= x - FULL_TOL)) if n else np.nan for x in clips},
               lv=[lv(j) for j in range(len(clips))], ct=[ct(j) for j in range(len(clips))],
               full_clip=_largest(clips, full >= FULL_SHARE), surv_clip=surv, surv_list=pos, base_ex5=_ex_top(e["net"]) if n else np.nan,
               surv_per_day=curve[js]["per_day"] if js is not None else np.nan, surv_day_net=curve[js]["day_net"] if js is not None else np.nan,
               day_notional=surv * curve[js]["per_day"] if js is not None else 0.0, surv_spent=curve[js]["spent"] if js is not None else np.nan,
               room_med=float(np.nanmedian((edge - ask) * 100.0)) if n else np.nan,
               edge_below_ask=float(np.mean(edge < ask - 1e-9)) if n else np.nan)
    v_after = float(np.median(pv["near_after"])) if n else np.nan
    wa = walk_to(tab, e, (B.CLIP_USD,), ask)                                    # the rule as run: the whole clip, and at one level or more
    fa = wa["full"][:, 0]
    one = float(np.mean(wa["levels"][fa, 0] == 1)) if fa.any() else np.nan
    return dict(row=row, one_level=one, walk=wk, curve=curve, usd_ask=usd_ask, usd_edge=usd_edge, room_c=(edge - ask) * 100.0, fill=fill_rule(e), n=n,
                part=PART * v_after, vol_after=v_after, clips=np.asarray(clips, float))


def data_checks(tab, tests, masks, est, t_min=300, clip=B.CLIP_USD, theta=THETA):
    """Checks on the real table, one per property, all tests at once: the walk at the ask seen reproduces every entry's shares and cost; the re-run at the
    ask seen and the base clip reproduces every test (entries and net); every edge re-run's windows are a superset of the base test's; no walk to the edge
    price pays above it. -> list of (label, passed)."""
    labs = list(tests)
    rep_walk, rep_run, sup, cap = True, True, True, True
    for lab in labs:
        e = tests[lab]
        if not len(e["net"]):
            continue
        wk = walk_to(tab, e, (clip,), ask_seen(tab, e))
        rep_walk &= bool(np.allclose(wk["shares"][:, 0], e["shares"]) and np.allclose(wk["cost"][:, 0], e["cost"]))
        r = rerun_at(tab, masks, lab, clip, t_min, limit="ask", theta=theta)
        rep_run &= bool(len(r["net"]) == len(e["net"]) and np.isclose(r["net"].sum(), e["net"].sum()))
        base = set(np.asarray(e["w"]).tolist())
        sup &= all(base <= c["windows"] for c in est[lab]["curve"])
        w = est[lab]["walk"]
        got = w["shares"] > 0
        cap &= bool(np.all(w["vwap"][got] <= np.broadcast_to(w["limit"][:, None], got.shape)[got] + 1e-9))
    return [(f"the walk at the ask seen reproduces every entry's shares and cost, tests {', '.join(labs)}", rep_walk),
            (f"the re-run at the ask seen and {clip:g} USD reproduces every test's entries and net", rep_run),
            ("every re-run to the edge price enters every window its base test entered, at every clip", sup),
            ("no walk to the edge price pays above it", cap)]


# ============================================================ the module's own checks
def _fake_tab():
    """Three windows of one slot, three decision seconds, theta 0.05.
    Window 0 (an Up buy, Up won): pu 0.62 so the edge price is 0.57; the ask seen is 0.50 every second; the Up asks are 0.50 x 60, 0.52 x 100, 0.55 x 100,
    0.60 x 100 at seconds 1 and 2 (the fourth level over the edge price), but at second 0 they moved a cent up (0.51 x 60, ...) by the time the order met them. Up bids 0.48 x 30, 0.47 x 40.
    Window 1 (a Down buy, Up lost): pu 0.30 so the Down edge price is 0.65; no Up asks; Up bids 0.40 x 50, 0.39 x 50, so the Down asks are 0.60 x 50 and
    0.61 x 50 and the Down ask seen is 0.60.
    Window 2 (an Up buy, Up won): pu 0.52 so the edge price 0.47 sits under the Up ask 0.50 x 100; Up bids 0.45 x 10.
    Prints: window 0 a buy of Up of 10 shares at 0.50 at 6.5 s, a sale of 4 at 0.48 at 20 s, a buy of Up of 6 at 0.52 at 30 s; window 1 a buy of Up of 100
    at 0.40 at 6.2 s."""
    t = object.__new__(B.Tab)
    NK = 3
    lad = np.full((3, 4, NK, 4), np.nan, np.float32)
    for k in range(NK):
        lad[0, 2, k, :], lad[0, 3, k, :] = ([0.51, 0.53, 0.56, 0.61] if k == 0 else [0.50, 0.52, 0.55, 0.60]), [60.0, 100.0, 100.0, 100.0]
        lad[0, 0, k, :2], lad[0, 1, k, :2] = [0.48, 0.47], [30.0, 40.0]
        lad[1, 0, k, :2], lad[1, 1, k, :2] = [0.40, 0.39], [50.0, 50.0]
        lad[2, 2, k, :1], lad[2, 3, k, :1] = [0.50], [100.0]
        lad[2, 0, k, :1], lad[2, 1, k, :1] = [0.45], [10.0]
    t.lad, t.w_fee, t.up = lad, np.array([0.07, 0.07, 0.07]), np.array([True, False, True])
    t.W, t.NK = 3, NK
    t.day, t.slot, t.w_asset = np.array([0, 0, 0]), np.array([100, 100, 100]), np.array([0, 1, 2])
    t.T = (B.WIN_S - (B.K0 + np.arange(NK))).astype(float)
    t.pu = np.repeat(np.array([[0.62], [0.30], [0.52]], np.float32), NK, axis=1)
    t.qa = np.repeat(np.array([[0.50], [np.nan], [0.50]], np.float32), NK, axis=1)
    t.qb = np.repeat(np.array([[0.48], [0.40], [0.45]], np.float32), NK, axis=1)
    t.p_w = np.array([0, 0, 0, 1], np.int64)
    t.p_t = np.array([6500, 20000, 30000, 6200], np.int64)
    t.p_px = np.array([0.50, 0.48, 0.52, 0.40], np.float32)
    t.p_sz = np.array([10.0, 4.0, 6.0, 100.0], np.float32)
    t.p_side = np.array([1, -1, 1, 1], np.int8)
    t.p_off = np.array([0, 3, 4, 4])
    return t


def checks():
    """Each check as (label, passed); the PLANTED cases must come out the way the label says, so a broken walk, limit, mirror or re-run is caught."""
    out = []
    t = _fake_tab()
    e = dict(w=np.array([0, 1, 2]), k=np.array([1, 1, 1]), side=np.array([1, -1, 1]))
    edge = edge_price(t, e)
    out.append(("our edge price is pu - theta for an Up buy and (1 - pu) - theta for a Down buy (0.57, 0.65, 0.47)", np.allclose(edge, [0.57, 0.65, 0.47], atol=1e-6)))
    wk = walk_to(t, e, (20.0, 50.0, 500.0), edge)
    out.append(("20 USD to the edge price on 0.50 x 60, 0.52 x 100 takes one level, in full, at 0 c over the best ask",
                wk["levels"][0, 0] == 1 and bool(wk["full"][0, 0]) and abs(wk["cents"][0, 0]) < 1e-9))
    vw50 = 50.0 / (60.0 + 38.46)
    out.append(("PLANTED: 50 USD must use two levels (60 at 0.50 is 30 USD, then 38.46 at 0.52), in full, VWAP 0.5078",
                wk["levels"][0, 1] == 2 and bool(wk["full"][0, 1]) and abs(wk["vwap"][0, 1] - 49.9992 / 98.46) < 1e-6 and abs(wk["vwap"][0, 1] - vw50) < 1e-4))
    out.append(("PLANTED: 500 USD stops at the edge price 0.57 with a fourth level at 0.60 resting: three levels, 137 USD, not in full", wk["levels"][0, 2] == 3 and abs(wk["cost"][0, 2] - 137.0) < 1e-4
                and not wk["full"][0, 2]))
    out.append(("PLANTED: an edge price under the ask (0.47 against 0.50) fills nothing: 0 shares, 0 levels, not in full, 0 USD under it",
                wk["shares"][2, 0] == 0 and wk["levels"][2, 0] == 0 and not wk["full"][2, 0] and under_price(t, e, edge)[2] == 0.0))
    ua, ue = under_price(t, e, ask_seen(t, e)), under_price(t, e, edge)
    out.append(("the Down asks mirror the Up bids: 30 USD at the Down ask seen 0.60, 60.5 USD under the Down edge price 0.65",
                abs(ua[1] - 30.0) < 1e-4 and abs(ue[1] - 60.5) < 1e-4 and abs(ask_seen(t, e)[1] - 0.60) < 1e-6))
    px, sz = B.ladder_of(t, e["w"], e["k"], e["side"], buy=True)
    rate = np.full(3, 0.07)
    sh, co, fe, _ = B.walk_buy(px, sz, 50.0, edge, rate)
    out.append(("the levelled walk is tf15_bt.walk_buy: same shares, cost and fee at 50 USD", np.allclose(sh, wk["shares"][:, 1]) and np.allclose(co, wk["cost"][:, 1])
                and np.allclose(fe, wk["fee"][:, 1])))
    out.append(("the fee is rate x p(1 - p) a share (two levels at 50 USD)", abs(wk["fee"][0, 1] - 0.07 * (60 * 0.25 + 38.46 * 0.52 * 0.48)) < 1e-6))
    g_up = np.zeros((3, 3), bool)
    g_dn = np.zeros((3, 3), bool)
    g_up[0, 0] = g_up[2, 0] = True
    g_dn[1, 0] = True
    masks = {"gates": {"T": (g_up, g_dn)}}
    base = rerun_at(t, masks, "T", 20.0, 300, limit="ask")
    run = rerun_at(t, masks, "T", 20.0, 300, limit="edge")
    out.append(("the re-run at the ask seen misses window 0 (the asks moved a cent up in 250 ms) and enters windows 1 and 2",
                sorted(base["w"].tolist()) == [1, 2]))
    out.append(("PLANTED: the re-run to the edge price is a superset in windows of the base test's and adds window 0 at 0.51",
                is_superset(base, run) and sorted(run["w"].tolist()) == [0, 1, 2] and abs(run["vwap"][run["w"] == 0][0] - 0.51) < 1e-6))
    out.append(("PLANTED: the base test is not a superset of the re-run (window 0 missing), and the check says so", not is_superset(run, base)))
    out.append(("where the edge price is under the ask seen (window 2) the re-run keeps the ask as its limit and fills as the base does",
                abs(run["cost"][run["w"] == 2][0] - base["cost"][base["w"] == 2][0]) < 1e-9))
    run_none = B.entries(t, np.where(g_up, 1, np.where(g_dn, -1, 0)), g_up | g_dn, np.full((3, 3), 0.40), usd=20.0)
    out.append(("PLANTED: a limit under every ask gives no entry", len(run_none["net"]) == 0))
    fr = fill_rule(dict(cost=np.array([20.0, 19.995, 12.0, 6.0])), 20.0)
    out.append(("the fill rule counts 19.99 USD or more as the whole 20 USD clip: half in full, the smaller trades' median 9 USD",
                abs(fr["full"] - 0.5) < 1e-12 and abs(fr["small_med"] - 9.0) < 1e-12))
    pv = print_volume(t, dict(w=np.array([0, 1]), k=np.array([1, 1]), side=np.array([1, -1])))
    out.append(("near-side USD from the entry second to expiry is 8.12 for the Up buyer (the sale is not near-side)", abs(pv["near_after"][0] - 8.12) < 1e-4))
    out.append(("PLANTED: a buy of Up is not near-side for a buyer of Down (0), but counts in the unsigned total (60 USD at the Down price)",
                abs(pv["near_slice"][1]) < 1e-9 and abs(pv["all_slice"][1] - 60.0) < 1e-4))
    out.append(("the largest clip is the end of an unbroken run of passes (a pass after a fail does not count)", _largest((20, 50, 100, 200), [True, True, False, True]) == 50.0))
    out.append(("PLANTED: a clip that fails at the smallest size is 0", _largest((20, 50), [False, True]) == 0.0))
    h = np.bincount(_bin_idx(np.array([1.0, 10.0, 100.0])), minlength=len(HIST_EDGES) - 1)
    out.append(("the histogram median of 1, 10 and 100 USD is 10 USD within one bin", abs(hist_quantile(h, (0.5,))[0] / 10.0 - 1) < 0.03))
    return out


def selftest() -> bool:
    ok = True
    for label, cond in checks():
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        ok &= bool(cond)
    return bool(ok)


# ============================================================ the figures (figstyle rules: a question for a title, the window and hours under it,
# findings below, one meaning per colour, series solid, thresholds ink and dotted)
def _fig_imports():
    import matplotlib.pyplot as plt
    from fundplat.quant.core import figstyle as fs
    return plt, fs


def _frame(h, bul, q, sub, nrows=1, ncols=1, width_ratios=None, height_ratios=None, hspace=0.5, wspace=0.28, axis_pad=0.6):
    """`lift_figs.frame` with column and row ratios. -> fig, list of axes (row-major)."""
    plt, fs = _fig_imports()
    N = fs.NEUTRAL
    H = h + fs.nlines(bul) * 0.205 + 0.45 + axis_pad + 0.45
    fig = plt.figure(figsize=(13, H))
    bm = fs.bullet_margin(fig, fs.nlines(bul)) + 0.02 + axis_pad / H
    top = 1 - 1.35 / H
    kw = {}
    if width_ratios:
        kw["width_ratios"] = width_ratios
    if height_ratios:
        kw["height_ratios"] = height_ratios
    gs = fig.add_gridspec(nrows, ncols, left=0.07, right=0.97, top=top, bottom=bm, wspace=wspace, hspace=hspace, **kw)
    axes = [fig.add_subplot(gs[i, j]) for i in range(nrows) for j in range(ncols)]
    fig.suptitle(q, x=0.07, y=1 - 0.18 / H, ha="left", va="top", fontsize=11.5, fontweight="bold", color=N["ink"])
    fig.text(0.07, 1 - 0.58 / H, sub, ha="left", va="top", fontsize=8.5, color=N["muted"])
    fs.bullets(fig, bul, bottom_in=0.12)
    return fig, axes


def _logx(ax, clips, labels=None):
    ax.set_xscale("log")
    ax.set_xticks(list(clips))
    ax.set_xticklabels(labels if labels is not None else [f"{c:g}" for c in clips], fontsize=8)
    ax.minorticks_off()
    ax.set_xlim(clips[0] / 1.25, clips[-1] * 1.25)


def _vline(ax, x, label, ink, y=0.97, ha="left", fs_=7.8, va="top"):
    ax.axvline(x, color=ink, ls=":", lw=1.3, zorder=3)
    ax.annotate(f" {label} " if ha == "left" else f"{label} ", xy=(x, y), xycoords=("data", "axes fraction"), ha=ha, va=va, fontsize=fs_, color=ink,
                annotation_clip=False)


def _hline(ax, y, label, ink, x=0.01, va="bottom", ha="left", fs_=7.8):
    ax.axhline(y, color=ink, ls=":", lw=1.3, zorder=3)
    ax.annotate(label, xy=(x, y), xycoords=("axes fraction", "data"), ha=ha, va=va, fontsize=fs_, color=ink, annotation_clip=False)


def _label_ends(ax, x, ys, labels, cols, gap=0.075, dx=1.22):
    """Labels at the right end of several lines, nudged apart in axes fraction so none overlaps another."""
    lo, hi = ax.get_ylim()
    log = ax.get_yscale() == "log"
    to_f = (lambda v: (np.log10(v) - np.log10(lo)) / (np.log10(hi) - np.log10(lo))) if log else (lambda v: (v - lo) / (hi - lo))
    items = sorted([(to_f(y), lab, c) for y, lab, c in zip(ys, labels, cols) if np.isfinite(y) and (y > 0 or not log)], key=lambda t: t[0])
    pos = []
    for f, _, _ in items:
        pos.append(max(f, pos[-1] + gap) if pos else f)
    if pos and pos[-1] > 0.98:
        pos = [p - (pos[-1] - 0.98) for p in pos]
    for (f, lab, c), p in zip(items, pos):
        ax.annotate(lab, xy=(x, f), xycoords=("data", "axes fraction"), xytext=(x * dx, p), textcoords=("data", "axes fraction"), va="center", ha="left",
                    fontsize=8.5, color=c, fontweight="bold", annotation_clip=False,
                    arrowprops=dict(arrowstyle="-", color=c, lw=0.6, shrinkA=1, shrinkB=1))


def _cols(fs, labs):
    """A and E in their own colours (the study's series: the model magenta for A, ink for E), every other test grey."""
    N = fs.NEUTRAL
    own = {FOCUS[0]: fs.IDENTITY["MODEL"], FOCUS[1]: N["ink"]}
    return {lab: own.get(lab, N["muted"]) for lab in labs}


def _usd(v):
    return f"{v:,.0f}" if np.isfinite(v) else "n/a"


def howdeep_fig(EST, window, notes, question="How deep do we go if we spend 20, 50, 100, 200 or 500 USD?"):
    """Every test's entries, the ask ladder at the fill second walked with each clip up to OUR EDGE PRICE, never beyond. Top left: the share of A's and E's
    entries that used 1, 2, 3 or 4 levels in full or could not fill in full, stacked a clip. Bottom left: the mean levels used (on the entries that got any
    fill), every test. Right: the cents the VWAP sits over the best ask (median, 25th to 75th band for A and E; the median in grey for the others), the
    median room to the edge price (edge price less the ask seen) for A and E as dotted ink decision lines."""
    plt, fs = _fig_imports()
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch
    N, BAD = fs.NEUTRAL, fs.VERDICT["bad"]
    INK = N["ink"]
    labs = list(EST)
    col = _cols(fs, labs)
    clips = EST[labs[0]]["clips"]
    fig, ax = _frame(5.8, notes, question, window, nrows=2, ncols=2, width_ratios=(1.0, 1.05), height_ratios=(1.15, 1.0), hspace=0.55, wspace=0.30)
    gs = ax[0].get_subplotspec().get_gridspec()
    ax[1].remove()
    ax[3].remove()
    a1, a2 = ax[0], ax[2]
    a3 = fig.add_subplot(gs[:, 1])
    # top left: stacked shares, A and E side by side a clip
    shades = (N["grid"], N["axis"], N["muted"], N["ink2"])
    xs = np.arange(len(clips))
    for off, lab in ((-0.2, FOCUS[0]), (0.2, FOCUS[1])):
        if lab not in EST:
            continue
        wk = EST[lab]["walk"]
        n = max(len(wk["best"]), 1)
        bottom = np.zeros(len(clips))
        for lv_ in range(1, LEVELS + 1):
            sh = ((wk["levels"] == lv_) & wk["full"]).sum(axis=0) / n
            a1.bar(xs + off, sh, width=0.36, bottom=bottom, color=shades[lv_ - 1], edgecolor=N["surface"], lw=0.6, zorder=3)
            bottom += sh
        nf = (~wk["full"]).sum(axis=0) / n
        a1.bar(xs + off, nf, width=0.36, bottom=bottom, color=BAD, edgecolor=N["surface"], lw=0.6, zorder=3)
        for i in range(len(clips)):
            a1.annotate(lab, (xs[i] + off, 1.0), xytext=(0, 2), textcoords="offset points", ha="center", va="bottom", fontsize=8, color=col[lab], fontweight="bold")
    a1.set_xticks(xs)
    a1.set_xticklabels([f"{c:g}" for c in clips], fontsize=8)
    a1.set_ylim(0, 1.12)
    a1.set_yticks([0, 0.25, 0.5, 0.75, 1.0])
    a1.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:.0%}"))
    a1.set_ylabel("share of entries")
    a1.set_title(f"tests {FOCUS[0]} and {FOCUS[1]}: levels used, walking to our edge price", fontsize=9.5, loc="left", pad=14)
    a1.grid(axis="x", visible=False)
    h1 = [Patch(facecolor=shades[i], label=f"{i + 1} level" + ("s" if i else "")) for i in range(LEVELS)] + [Patch(facecolor=BAD, label="not filled in full")]
    a1.legend(handles=h1, loc="upper left", bbox_to_anchor=(1.0, 1.0), fontsize=7.5, frameon=False, handlelength=1.0, borderaxespad=0.2)
    # bottom left: mean levels used, every test
    ends = []
    for lab in labs:
        y = np.array(EST[lab]["row"]["lv"], float)
        own = lab in FOCUS
        a2.plot(clips, y, color=col[lab], lw=2.2 if own else 1.2, marker="o", ms=4 if own else 3, zorder=5 if own else 4)
        ends.append(y[-1])
    _logx(a2, clips)
    a2.set_ylim(0.8, LEVELS + 0.3)
    a2.set_yticks(range(1, LEVELS + 1))
    a2.set_ylabel("mean levels used")
    a2.set_xlabel("clip, USD (log)", fontsize=8.5)
    a2.set_title("every test: mean levels used (entries that got a fill)", fontsize=9.5, loc="left")
    _hline(a2, LEVELS, "four levels: the table holds no more", INK, x=0.01, va="bottom")
    _label_ends(a2, clips[-1] * 1.02, ends, labs, [col[lab] for lab in labs], gap=0.085, dx=1.08)
    # right: cents over the best ask, with the room to the edge price
    ends, ymax = [], 0.0
    for lab in labs:
        wk = EST[lab]["walk"]
        got = wk["shares"] > 0
        q = np.array([np.percentile(wk["cents"][got[:, j], j], [25, 50, 75]) if got[:, j].any() else [np.nan] * 3 for j in range(len(clips))])
        q[:, 1] = np.array(EST[lab]["row"]["ct"], float)                       # the line is the mean (what the order pays on average), the band the quartiles
        own = lab in FOCUS
        if own:
            a3.fill_between(clips, q[:, 0], q[:, 2], color=col[lab], alpha=0.14, lw=0, zorder=2)
            ymax = max(ymax, float(np.nanmax(q[:, 2])))
        a3.plot(clips, q[:, 1], color=col[lab], lw=2.2 if own else 1.1, marker="o", ms=4 if own else 3, zorder=5 if own else 4)
        ends.append(q[-1, 1])
        ymax = max(ymax, float(np.nanmax(q[:, 1])))
    rooms = {lab: EST[lab]["row"]["room_med"] for lab in FOCUS if lab in EST}
    for i, (lab, r) in enumerate(sorted(rooms.items(), key=lambda t: t[1])):
        _hline(a3, r, f"{lab}: our edge price, the room we have ({r:.1f} c, median)", INK, x=0.01, va="top" if i == 0 and len(rooms) > 1 else "bottom")
    ymax = max(ymax, max(rooms.values()) if rooms else 0.0)
    a3.set_ylim(-0.3, ymax * 1.15 + 0.5)
    _logx(a3, clips)
    a3.set_xlabel("clip, USD (log)", fontsize=8.5)
    a3.set_ylabel("cents a share the VWAP pays over the best ask")
    a3.set_title("cents the order pays over the best ask, walking to our edge price", fontsize=9.5, loc="left")
    a3.legend(handles=[Line2D([], [], color=N["ink2"], lw=2.0, marker="o", ms=4, label="mean, entries that got a fill"),
                       Patch(facecolor=N["ink2"], alpha=0.14, label=f"25th to 75th percentile, {FOCUS[0]} and {FOCUS[1]}")],
               loc="upper left", fontsize=7.8, frameon=True, facecolor=N["surface"], edgecolor="none", framealpha=1.0)
    _label_ends(a3, clips[-1] * 1.02, ends, labs, [col[lab] for lab in labs], gap=0.036, dx=1.08)
    return fig


def underedge_fig(EST, DEP, window, notes, clip=B.CLIP_USD, t_min=300, question="How many dollars sit under our edge price when a test fires?"):
    """Left: per test, the USD resting at or under our edge price at the fill second (median dot, 10th to 90th whisker, 25th to 75th thick), the USD at or
    under the ask we saw beside it as a muted hollow marker, the clip as a dotted ink vertical. Middle: the share of entries where 20, 50, 100 and 200 USD
    fit under the edge price. Right: the median USD at the best ask by seconds left, every window, both tokens, a line a coin, the entry cut as a vertical."""
    plt, fs = _fig_imports()
    from matplotlib.lines import Line2D
    N = fs.NEUTRAL
    INK = N["ink"]
    labs = list(EST)
    col = _cols(fs, labs)
    fig, ax = _frame(4.9, notes, question, window, ncols=3, width_ratios=(1.0, 0.42, 1.0), wspace=0.08)
    a1, at, a2 = ax
    ys = np.arange(len(labs))[::-1]
    lo_x, hi_x = np.inf, 0.0
    for y, lab in zip(ys, labs):
        u = EST[lab]["usd_edge"]
        ua = EST[lab]["usd_ask"]
        if not len(u):
            continue
        p10, p25, p50, p75, p90 = np.percentile(np.maximum(u, 0.5), [10, 25, 50, 75, 90])
        a1.plot([p10, p90], [y, y], color=col[lab], lw=1.2, solid_capstyle="butt", zorder=3)
        a1.plot([p25, p75], [y, y], color=col[lab], lw=5.0, solid_capstyle="butt", zorder=4)
        a1.plot([p50], [y], "o", ms=7, color=col[lab], markeredgecolor=N["surface"], zorder=5)
        a1.annotate(f"{p50:,.0f}", (p50, y), xytext=(0, 7), textcoords="offset points", ha="center", va="bottom", fontsize=7.5, color=INK)
        ma = float(np.median(np.maximum(ua, 0.5)))
        a1.plot([ma], [y - 0.30], "D", ms=5, color=N["muted"], markerfacecolor="none", markeredgecolor=N["muted"], markeredgewidth=1.2, zorder=5)
        lo_x, hi_x = min(lo_x, p10, ma), max(hi_x, p90)
    a1.set_xscale("log")
    a1.set_xlim(max(0.35, lo_x / 1.8), hi_x * 1.8)
    a1.set_ylim(-0.8, len(labs) - 0.4)
    a1.set_yticks(ys)
    a1.set_yticklabels(labs, fontsize=9.5, fontweight="bold")
    for t_, lab in zip(a1.get_yticklabels(), labs):
        t_.set_color(col[lab] if lab in FOCUS else N["ink2"])
    a1.grid(axis="y", visible=False)
    _vline(a1, clip, f"{clip:g} USD clip", INK, y=1.0, va="bottom")
    a1.set_xlabel("USD on the near token's ask at the fill second (log; at least: four levels)", fontsize=8.5)
    a1.set_title("USD at or under our edge price, a test", fontsize=9.5, loc="left", pad=14)
    fig.legend(handles=[Line2D([], [], color=N["ink2"], lw=5.0, label="25th to 75th"), Line2D([], [], color=N["ink2"], lw=1.2, label="10th to 90th"),
                       Line2D([], [], color=N["ink2"], marker="o", ls="", ms=6, label="median"),
                       Line2D([], [], color=N["muted"], marker="D", ls="", ms=5, markerfacecolor="none", markeredgecolor=N["muted"], label="median at the ask we saw")],
               loc="upper right", bbox_to_anchor=(0.97, 1 - 0.40 / fig.get_size_inches()[1]), ncol=4, fontsize=8, frameon=False)
    # middle: the share where a clip fits under the edge price
    at.axis("off")
    at.set_ylim(a1.get_ylim())
    fit_clips = [x for x in (20.0, 50.0, 100.0, 200.0) if x in EST[labs[0]]["row"]["fits"]]
    xs = np.linspace(0.12, 0.92, len(fit_clips))
    at.text(0.5, len(labs) - 0.25, "share of entries where\nthe clip fits under it", ha="center", va="bottom", fontsize=8, color=N["ink2"])
    for x_, c_ in zip(xs, fit_clips):
        at.text(x_, len(labs) - 0.55, f"{c_:g}", ha="center", va="center", fontsize=8, color=N["ink2"], fontweight="bold")
    for y, lab in zip(ys, labs):
        for x_, c_ in zip(xs, fit_clips):
            at.text(x_, y, f"{EST[lab]['row']['fits'][c_]:.0%}", ha="center", va="center", fontsize=8, color=INK)
    # right: the touch by seconds left, every window
    COL = {c: fs.IDENTITY[c.upper()] for c in COIN_NAMES}
    t = DEP["t_mid"]
    hs = []
    for c in COIN_NAMES:
        if c not in DEP:
            continue
        a2.plot(t, DEP[c]["touch_med"], color=COL[c], lw=1.9, zorder=4)
        hs.append(Line2D([], [], color=COL[c], lw=1.9, label=c.upper()))
    a2.set_yscale("log")
    a2.set_xlim(t.max() + 10, 0)
    vals = np.concatenate([DEP[c]["touch_med"] for c in COIN_NAMES if c in DEP])
    vals = vals[np.isfinite(vals) & (vals > 0)]
    y_lo, y_hi = min(float(vals.min()), clip) / 1.4, max(float(vals.max()), clip) * 1.9
    a2.set_ylim(y_lo, y_hi)
    nice = [v for v in (1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 300, 500, 1000, 2000, 5000) if y_lo <= v <= y_hi]
    a2.set_yticks(nice)
    a2.set_yticklabels([f"{v:,}" for v in nice])
    a2.minorticks_off()
    _vline(a2, t_min, f"{t_min} s left: no entry after", INK, y=0.97, ha="right")
    _hline(a2, clip, f"{clip:g} USD", INK, x=0.62, ha="left", va="bottom")
    a2.set_xlabel("seconds left in the window")
    a2.set_ylabel("median USD at the best ask (log)")
    a2.yaxis.set_label_position("right")
    a2.yaxis.tick_right()
    a2.set_title("every window, both tokens: USD at the best ask", fontsize=9.5, loc="left", pad=14)
    a2.legend(handles=hs, loc="lower left", fontsize=8, ncol=4, frameon=True, facecolor=N["surface"], edgecolor="none", framealpha=1.0)
    return fig


def earnclip_fig(EST, window, notes, question="What does each clip earn a day when we pay up to our edge price?"):
    """Small multiples, one a test: the re-run's net an entry against the clip (95% band by slot) and the net an entry without the best 5% (muted), zero as
    the dotted ink decision line; the largest clip whose ex-5% net stays above zero marked green, or a red marker at the smallest clip when none does; the
    net a day at the marked clip (entries a day x net an entry) in the corner. The eighth panel holds the key."""
    plt, fs = _fig_imports()
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch
    N, MOD = fs.NEUTRAL, fs.IDENTITY["MODEL"]
    GOOD, BAD = fs.VERDICT["good"], fs.VERDICT["bad"]
    INK = N["ink"]
    labs = list(EST)
    ncol = 4
    nrow = int(np.ceil((len(labs) + 1) / ncol))
    fig, ax = _frame(2.85 * nrow, notes, question, window, nrows=nrow, ncols=ncol, hspace=0.62, wspace=0.34)
    for a, lab in zip(ax, labs):
        cv, r = EST[lab]["curve"], EST[lab]["row"]
        x = np.array([c["clip"] for c in cv])
        y = np.array([c["per"] for c in cv]); lo = np.array([c["lo"] for c in cv]); hi = np.array([c["hi"] for c in cv]); ex = np.array([c["ex5"] for c in cv])
        a.fill_between(x, lo, hi, color=MOD, alpha=0.16, lw=0, zorder=2)
        a.plot(x, y, color=MOD, lw=2.0, marker="o", ms=3.5, zorder=4)
        a.plot(x, ex, color=N["muted"], lw=1.6, marker="o", ms=3, zorder=4)
        a.axhline(0, color=INK, ls=":", lw=1.3, zorder=3)
        _logx(a, x)
        a.tick_params(axis="x", labelsize=7)
        surv = r["surv_clip"]
        if surv > 0:
            j = list(x).index(surv)
            a.plot([x[j]], [ex[j]], "o", ms=9, color=GOOD, zorder=6)
            txt = f"edge survives to {surv:g} USD\n{r['surv_day_net']:+,.0f} USD a day there"
        else:
            a.plot([x[0]], [ex[0]], "o", ms=9, color=BAD, zorder=6)
            txt = "no clip keeps the edge\nwithout its best 5%"
        lo_y, hi_y = float(np.nanmin(np.r_[lo, ex])), float(np.nanmax(np.r_[hi, 0.0]))
        span = hi_y - min(lo_y, 0.0)
        a.set_ylim(min(lo_y, 0.0) - 0.08 * span, hi_y + 0.42 * span)
        a.text(0.03, 0.97, txt, transform=a.transAxes, ha="left", va="top", fontsize=7.5, color=INK)
        a.set_title(f"{lab} · {cv[0]['per_day']:,.0f} entries a day at {x[0]:g} USD", fontsize=8.5, loc="left")
    for a in ax[len(labs):]:
        a.axis("off")
    ax[0].set_ylabel("net an entry, USD")
    if len(labs) > ncol:
        ax[ncol].set_ylabel("net an entry, USD")
    for a in ax[max(0, len(labs) - ncol):len(labs)]:
        a.set_xlabel("clip, USD (log)", fontsize=8)
    if len(ax) > len(labs):
        k = ax[len(labs)]
        k.legend(handles=[Line2D([], [], color=MOD, lw=2.0, marker="o", ms=3.5, label="net an entry, paying up to\nour edge price"),
                          Patch(facecolor=MOD, alpha=0.16, label="95% by 15-minute slot"),
                          Line2D([], [], color=N["muted"], lw=1.6, marker="o", ms=3, label="net an entry without\nthe best 5% of entries"),
                          Line2D([], [], color=INK, ls=":", lw=1.3, label="zero"),
                          Line2D([], [], color=GOOD, marker="o", ls="", ms=9, label="the edge survives to here"),
                          Line2D([], [], color=BAD, marker="o", ls="", ms=9, label="no clip survives")],
                 loc="center left", fontsize=8, frameon=False)
    return fig


# ============================================================ the words under the figures and the table (every number from the arrays, none typed)
def intro_line(EST, clip=B.CLIP_USD):
    """The fill rule's computed shares for the focus tests."""
    parts = []
    for lab in FOCUS:
        if lab not in EST:
            continue
        f = EST[lab]["fill"]
        wk_one = EST[lab].get("one_level")
        one = f" ({wk_one:.0%} of those at one price level)" if wk_one is not None and np.isfinite(wk_one) else ""
        parts.append(f"test {lab}: {f['full']:.0%} of {f['n']:,} entries got the whole {clip:g} USD{one}, {f['small']:.0%} got a smaller trade, "
                     f"a median {f['small_med']:.2f} USD when they did")
    return "The fill rule on the entries as run: " + "; ".join(parts) + "."


def notes_howdeep(EST):
    clips = list(EST[next(iter(EST))]["clips"])
    j20, j100 = _at(clips, 20.0), _at(clips, 100.0)
    out = []
    for lab in FOCUS:
        if lab not in EST:
            continue
        r = EST[lab]["row"]
        out.append(f"Test {lab}, walking to our edge price: at 20 USD it uses {r['lv'][j20]:.2f} levels on average and pays {r['ct'][j20]:.2f} c over the best ask on average, "
                   f"{r['full'][j20]:.0%} of entries filled in full; at 100 USD {r['lv'][j100]:.2f} levels, {r['ct'][j100]:.2f} c, {r['full'][j100]:.0%} in full. "
                   f"The median room to the edge price is {r['room_med']:.1f} c.")
    rooms = [(lab, EST[lab]["row"]) for lab in FOCUS if lab in EST]
    used = [lab for lab, r in rooms if np.isfinite(r["ct"][j100]) and r["ct"][j100] >= r["room_med"]]
    out.append("Is the room used up? " + (f"For {', '.join(used)} the mean cost at 100 USD reaches the median room." if used else
               "No: at 100 USD the order pays on average " + " and ".join(f"{lab} {r['ct'][j100]:.2f} c of a {r['room_med']:.1f} c room" for lab, r in rooms)
               + "; the book runs out of size under the edge price before the price walks up to it."))
    oth = [lab for lab in EST if lab not in FOCUS]
    out.append("The other tests at 100 USD, mean levels and mean cents: " + ", ".join(f"{lab} {EST[lab]['row']['lv'][j100]:.2f} and {EST[lab]['row']['ct'][j100]:.2f} c" for lab in oth)
               + (f". Test C has no price gate: its edge price is under the ask seen on {EST['C']['row']['edge_below_ask']:.0%} of its entries, which then fill nothing at that price."
                  if "C" in EST else "."))
    out.append("Four levels is a floor: a clip that needs a fifth level counts as not filled in full, so the red share is an upper bound. Our own order would change the book; that is not modelled.")
    return out


def notes_underedge(EST, DEP, clip=B.CLIP_USD, t_min=300):
    out = []
    for lab in FOCUS:
        if lab not in EST:
            continue
        r = EST[lab]["row"]
        out.append(f"Test {lab}: a median {_usd(r['usd_edge_med'])} USD sits under our edge price at the fill second (10th percentile {_usd(r['usd_edge_p10'])}), against "
                   f"{_usd(r['usd_ask_med'])} at the ask we saw; {r['fits'][20.0]:.0%} of entries fit 20 USD under the edge price and {r['fits'][100.0]:.0%} fit 100 USD.")
    t = DEP["t_mid"]
    coins = [c for c in COIN_NAMES if c in DEP]
    early, late, tail = t >= 600, (t >= t_min) & (t < 450), t < 120
    out.append("The book thins into expiry. Median USD at the best ask, 900 to 600 s left against 450 to 300 s and the last two minutes: "
               + ", ".join(f"{c.upper()} {_usd(float(np.nanmedian(DEP[c]['touch_med'][early])))}, {_usd(float(np.nanmedian(DEP[c]['touch_med'][late])))} "
                           f"and {_usd(float(np.nanmedian(DEP[c]['touch_med'][tail])))}" for c in coins) + ".")
    out.append("Every number is at least the value shown: the table keeps four levels a side. The pinned archive holds ten; a re-seat could widen the ladder, not done here.")
    return out


def notes_earnclip(EST, ndays):
    out = []
    surv = {lab: EST[lab]["row"] for lab in EST if EST[lab]["row"]["surv_clip"] > 0}
    clips = list(EST[next(iter(EST))]["clips"])

    def run_txt(r):
        below = [f"{x:g}" for x in clips if x not in r["surv_list"]]
        return f"above zero at {', '.join(f'{x:g}' for x in r['surv_list'])} USD" + (f", not at {', '.join(below)}" if below else "")
    out.append("The largest clip whose net an entry without the best 5% is above zero: "
               + "; ".join(f"{lab} {r['surv_clip']:g} USD ({run_txt(r)}), {r['surv_day_net']:+,.0f} USD a day there on {r['surv_per_day']:,.1f} entries a day, each spending a mean {r['surv_spent']:,.0f} USD of the clip" for lab, r in surv.items())
               + ("; " if surv else "") + (", ".join(lab for lab in EST if lab not in surv) + " at no clip" if len(surv) < len(EST) else "") + ".")
    out.append(f"For most tests the edge fails the steady rule (no loss once the best 5% of entries go) before the book runs out: {len(EST) - len(surv)} of {len(EST)} tests "
               f"keep no clip at all, whatever the depth. A day's net is entries a day x net an entry at that clip, on these {ndays} days of one regime; "
               "a clip chosen as the best of five on the same days flatters it.")
    j20 = _at(clips, 20.0)
    out.append("Paying up adds entries the ask seen missed (the book moved in the 250 ms), and every re-run enters every window its base test entered. At 20 USD the net "
               "without the best 5%, re-run against the rule as run: " + ", ".join(f"{lab} {EST[lab]['curve'][j20]['ex5']:+.3f} against {EST[lab]['row']['base_ex5']:+.3f}"
                                                                              for lab in FOCUS if lab in EST)
               + ". Test C has no price gate; where its edge price is under the ask seen its limit stays the ask.")
    out.append(f"Participation sensitivity [U], not used to set the clip: {PART:.0%} of the median near-side USD traded from the entry second to expiry is "
               + ", ".join(f"{lab} {_usd(EST[lab]['part'])}" for lab in EST) + " USD. The prints' side labels are uncertain.")
    return out


def estimate_table(EST):
    """The estimate, one row a test, nine columns, plain-word headers."""
    import pandas as pd
    out = []
    for lab, d in EST.items():
        r = d["row"]
        clips = list(d["clips"])
        j20, j100 = _at(clips, 20.0), _at(clips, 100.0)
        out.append({"Test": lab, "Entries a day": f"{r['per_day']:,.1f}",
                    "USD at the ask we saw (median entry)": _usd(r["usd_ask_med"]),
                    "USD under our edge price (median, 10th pct)": f"{_usd(r['usd_edge_med'])} ({_usd(r['usd_edge_p10'])})",
                    "At 20 USD: levels used, cents over the ask": f"{r['lv'][j20]:.2f}, {r['ct'][j20]:.2f} c",
                    "At 100 USD: levels used, cents over the ask, filled in full": f"{r['lv'][j100]:.2f}, {r['ct'][j100]:.2f} c, {r['full'][j100]:.0%}",
                    f"Largest clip that fills in full for {FULL_SHARE:.0%} of entries": _usd(r["full_clip"]) if r["full_clip"] > 0 else "none",
                    "Largest clip where the edge survives without the best 5%": _usd(r["surv_clip"]) if r["surv_clip"] > 0 else "none",
                    "What we can do a day, USD (that clip x entries a day)": _usd(r["day_notional"]) if r["surv_clip"] > 0 else "none"})
    return pd.DataFrame(out)


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
