"""Out-of-sample and luck reads of a fixed rule on the pooled 15-minute table (um-021, 2026-10-11): the day blocks, the weekly folds, the consistency rule and
two randomised nulls. numpy only; every fill goes through `tf15_bt.entries`.

THE SPLITS. Nothing is fitted: the rule is fixed before any day is read, so the in-sample block only sets the FORECAST (the net an entry and its 95% interval by
15-minute slot) and the out-of-sample block is the realisation read against it. `blocks` cuts the days by index (14 in, 14 out, the rest a second out-of-sample
block); `folds` pairs each week with the next one (week i in, week i + 1 out).

THE RULE. `consistent`: PASS when the out-of-sample segment holds at least MIN_N entries, its net an entry is above zero and it lies inside the in-sample 95%
interval; under MIN_N entries it is "thin" (not a pass); otherwise FAIL.

THE NULLS (all causal, the statistic the net an entry):
    random_burst   THE null (the accounting audit, 2026-10-11): the same count of entries per (day, coin) as the test made, drawn uniformly from the seconds that
                   pass every condition of the test except the burst (`burst_pools`), the side the one whose ask passes the gate there, bought at that ask, one
                   entry a window: given a book that passes the gate (and is stale, where the test says so), does the burst's direction add anything? Price-
                   and fee-matched by construction, since every entry passes the same gate. C (no gate) draws from the time mask alone; D (no burst) has none.
    random_side    the test's own decision seconds and clip, the side a coin flip each draw, the limit the drawn side's ask. The far token never passes the
                   price gate, so this null loses by construction: it measures the gate, not the burst. A weaker read, printed, never a gate.
    random_moment  the same count of entries per (day, coin), each at a uniformly drawn window and second with at least t_min seconds left and a finite ask,
                   the side a coin flip. Not price-matched (it pays the market's typical ask, not the gate's); C's random-burst null, with misses retried.
All are exact replays of the engine: `random_burst` runs `B.entries` once a side over the pool's cells (every fill kept) and draws among the filled items;
`random_side` the same over the test's cells; `random_moment` stacks every draw's chosen (window, second) as one-second windows of a row table and runs
`B.entries` on it once a chunk. `burst_agrees`, `side_agrees` and `moment_agrees` replay one draw through `B.entries` on the dense (W, NK) matrices and compare;
`null_faults` checks a draw: one entry a window, the test's count per (day, coin), and every entry's ask under its side's fair value less theta.
"""
from __future__ import annotations

import numpy as np

import tf15_bt as B
import tf15_cands as C

MIN_N = 20


# ============================================================ the splits
def blocks(days, n_is=14, n_oos=14):
    """The day blocks by index: in-sample days[0:n_is] (the forecast), out-of-sample days[n_is:n_is + n_oos], and the rest as a second out-of-sample block.
    -> list of dict(name, role 'forecast' or 'oos', idx, first, last, n_days)."""
    n = len(days)
    cuts = [(0, min(n_is, n), "in-sample", "forecast"), (n_is, min(n_is + n_oos, n), "out-of-sample", "oos"), (n_is + n_oos, n, "out-of-sample 2", "oos")]
    return [dict(name=nm, role=r, idx=np.arange(a, b), first=days[a], last=days[b - 1], n_days=b - a) for a, b, nm, r in cuts if b > a]


def folds(days, week=7):
    """Weeks by index [0:7] [7:14] ... (the last may be short); fold i = (week i in-sample, week i + 1 out-of-sample). -> list of (idx_in, idx_out)."""
    n = len(days)
    weeks = [np.arange(a, min(a + week, n)) for a in range(0, n, week)]
    return [(weeks[i], weeks[i + 1]) for i in range(len(weeks) - 1)]


def segment(e, day_idx):
    """The entries whose day index is in `day_idx`."""
    return B.subset(e, np.isin(np.asarray(e["day"]), np.asarray(day_idx)))


def consistent(s_is, s_oos, min_n=MIN_N):
    """The verdict of an out-of-sample summary against its in-sample forecast: 'thin', 'PASS' or 'FAIL' (see the module's doc)."""
    if s_oos.get("n", 0) < min_n:
        return "thin"
    if not s_is.get("n", 0) or not np.isfinite(s_is.get("per_lo", np.nan)):
        return "FAIL"
    ok = s_oos["per"] > 0 and s_is["per_lo"] <= s_oos["per"] <= s_is["per_hi"]
    return "PASS" if ok else "FAIL"


def _stats(e):
    s = B.summarize(e)
    if not s.get("n", 0):
        return dict(n=0, per=np.nan, per_lo=np.nan, per_hi=np.nan, per_ex_top5=np.nan, win=np.nan, win_needed=np.nan)
    return s


def read_blocks(e, days, n_is=14, n_oos=14):
    """Each block's summary and verdict. -> list of dict(block..., s=summary, verdict)."""
    out = []
    bl = blocks(days, n_is, n_oos)
    s_is = None
    for b in bl:
        s = _stats(segment(e, b["idx"]))
        if b["role"] == "forecast":
            s_is, v = s, "forecast"
        else:
            v = consistent(s_is, s)
        out.append(dict(b, s=s, verdict=v))
    return out


def spearman(x, y):
    """Spearman's rank correlation (average ranks for ties); nan with fewer than three finite pairs or no spread."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    ok = np.isfinite(x) & np.isfinite(y)
    if ok.sum() < 3:
        return float("nan")

    def rank(v):
        o = np.argsort(v, kind="mergesort")
        r = np.empty(len(v))
        r[o] = np.arange(1, len(v) + 1)
        for u in np.unique(v):
            m = v == u
            r[m] = r[m].mean()
        return r
    rx, ry = rank(x[ok]), rank(y[ok])
    if rx.std() == 0 or ry.std() == 0:
        return float("nan")
    return float(np.corrcoef(rx, ry)[0, 1])


def read_folds(e, days, week=7):
    """Each fold's in-sample and out-of-sample summary and verdict, and the summary statistics: folds with the out-of-sample net above zero, folds consistent,
    the pooled out-of-sample (every out-of-sample week together) and the Spearman rank correlation of the in-sample and out-of-sample fold means."""
    rows = []
    for i, (a, b) in enumerate(folds(days, week), 1):
        s_in, s_out = _stats(segment(e, a)), _stats(segment(e, b))
        rows.append(dict(fold=i, idx_in=a, idx_out=b, in_days=f"{days[a[0]][5:]}..{days[a[-1]][5:]}", out_days=f"{days[b[0]][5:]}..{days[b[-1]][5:]}",
                         out_n_days=len(b), s_in=s_in, s_out=s_out, verdict=consistent(s_in, s_out)))
    out_idx = np.unique(np.concatenate([r["idx_out"] for r in rows])) if rows else np.zeros(0, int)
    in_idx = np.unique(np.concatenate([r["idx_in"] for r in rows])) if rows else np.zeros(0, int)
    pooled = _stats(segment(e, out_idx))
    pooled_in = _stats(segment(e, in_idx))
    mi = [r["s_in"]["per"] for r in rows]
    mo = [r["s_out"]["per"] for r in rows]
    return dict(rows=rows, pooled=pooled, pooled_in=pooled_in, n_folds=len(rows),
                above=sum(1 for r in rows if r["s_out"].get("n", 0) >= MIN_N and r["s_out"]["per"] > 0),
                consistent=sum(1 for r in rows if r["verdict"] == "PASS"), thin=sum(1 for r in rows if r["verdict"] == "thin"),
                rho=spearman(mi, mo))


# ============================================================ the randomised nulls
def p_one_sided(null, observed):
    """(1 + the draws at or above the observed value) / (draws + 1): the floor is 1 / (draws + 1)."""
    null = np.asarray(null, float)
    null = null[np.isfinite(null)]
    return float((1 + int((null >= observed).sum())) / (len(null) + 1))


def _ex_top5(v):
    v = np.sort(np.asarray(v, float))
    n = len(v)
    k = int(np.ceil(0.05 * n))
    return float(v[:n - k].mean()) if n - k > 0 else float("nan")


def _side_fills(tab, gates, tm, usd):
    """The test's decision cells and both sides' engine fills on them. -> dict(cw, ck, and per side u / d: f filled, n net, fee, ask the limit)."""
    g_up, g_dn = gates
    trig = (g_up | g_dn) & tm
    cw, ck = np.nonzero(trig)
    qa, qd = C.quotes(tab)
    ones = np.ones(trig.shape, np.int8)
    key = cw.astype(np.int64) * tab.NK + ck
    out = dict(cw=cw, ck=ck)
    for s, lim, nm in ((1, qa, "u"), (-1, qd, "d")):
        e = B.entries(tab, ones * s, trig, lim, usd, one_per_window=False)
        f, nt, fe = np.zeros(len(cw), bool), np.zeros(len(cw)), np.zeros(len(cw))
        ix = np.searchsorted(key, np.asarray(e["w"], np.int64) * tab.NK + np.asarray(e["k"]))
        f[ix], nt[ix], fe[ix] = True, e["net"], e["fee"]
        out.update({f"f{nm}": f, f"n{nm}": nt, f"fee{nm}": fe, f"ask{nm}": lim[cw, ck]})
    return out


def _side_cells(tab, gates, tm, usd):
    """The test's decision cells and both sides' engine fills on them. -> (cell w, cell k, filled-if-Up, net-if-Up, filled-if-Down, net-if-Down)."""
    x = _side_fills(tab, gates, tm, usd)
    return x["cw"], x["ck"], x["fu"], x["nu"], x["fd"], x["nd"]


def _side_pick(cw, fu, fd, up):
    """One draw of the random-side null: the side `up` per cell, the first filled cell a window. -> the chosen cells' indices."""
    sel = np.flatnonzero(np.where(up, fu, fd))
    if len(sel) == 0:
        return sel
    ws = cw[sel]
    return sel[np.concatenate([[True], ws[1:] != ws[:-1]])]


def _side_draw(cw, fu, nu, fd, nd, up):
    """One draw of the random-side null from the precomputed fills: the side `up` per cell, the first filled cell a window. -> the entries' nets."""
    sel = _side_pick(cw, fu, fd, up)
    return np.where(up, nu, nd)[sel] if len(sel) else np.zeros(0)


def random_side(tab, gates, tm, usd=B.CLIP_USD, draws=1000, seed=11):
    """The random-side null: per draw the mean net an entry, the net without the best 5%, the entry count, and the mean ask and fee an entry.
    -> dict(per, ex5, n, ask, fee) of arrays (draws,), cells."""
    x = _side_fills(tab, gates, tm, usd)
    cw = x["cw"]
    rng = np.random.default_rng(seed)
    per, ex5, n = np.full(draws, np.nan), np.full(draws, np.nan), np.zeros(draws, int)
    ask, fee = np.full(draws, np.nan), np.full(draws, np.nan)
    for i in range(draws):
        up = rng.random(len(cw)) < 0.5
        sel = _side_pick(cw, x["fu"], x["fd"], up)
        n[i] = len(sel)
        if len(sel):
            v = np.where(up, x["nu"], x["nd"])[sel]
            per[i], ex5[i] = v.mean(), _ex_top5(v)
            ask[i], fee[i] = np.where(up, x["asku"], x["askd"])[sel].mean(), np.where(up, x["feeu"], x["feed"])[sel].mean()
    return dict(per=per, ex5=ex5, n=n, ask=ask, fee=fee, cells=len(cw))


def side_agrees(tab, gates, tm, usd=B.CLIP_USD, seed=3):
    """One random-side draw two ways: from the precomputed fills, and through `B.entries` on the dense (W, NK) side matrix. -> (agree, n entries)."""
    cw, ck, fu, nu, fd, nd = _side_cells(tab, gates, tm, usd)
    up = np.random.default_rng(seed).random(len(cw)) < 0.5
    fast = _side_draw(cw, fu, nu, fd, nd, up)
    g_up, g_dn = gates
    trig = (g_up | g_dn) & tm
    side = np.zeros(trig.shape, np.int8)
    side[cw, ck] = np.where(up, 1, -1)
    qa, qd = C.quotes(tab)
    e = B.entries(tab, side, trig, np.where(side > 0, qa, qd), usd)
    return bool(len(e["net"]) == len(fast) and np.allclose(np.sort(e["net"]), np.sort(fast))), int(len(fast))


class _Rows:
    """A row table for the engine: each row one (window, second) of the pooled table, as a window of one second (NK = 1)."""

    def __init__(self, tab, w, k):
        self.lad = tab.lad[w, :, k, :][:, :, None, :]
        self.w_fee, self.up = tab.w_fee[w], tab.up[w]
        self.day, self.slot, self.w_asset = tab.day[w], tab.slot[w], tab.w_asset[w]
        self.T = np.zeros(1)
        self.NK = 1


def _moment_pick(tab, counts, rng, qa, qd, kmax, groups):
    """One draw's (window, second, side): per (day, coin) group the test's count of distinct windows, each a uniform second with a finite ask on a coin-flip side."""
    W = tab.W
    r = rng.random(W)
    o = np.lexsort((r, groups))
    g_sorted = groups[o]
    start = np.searchsorted(g_sorted, g_sorted, side="left")
    rank = np.arange(W) - start
    pick = o[rank < counts[g_sorted]]
    side = np.where(rng.random(len(pick)) < 0.5, 1, -1)
    k = np.full(len(pick), -1)
    todo = np.arange(len(pick))
    for _ in range(60):
        if len(todo) == 0:
            break
        kk = rng.integers(0, kmax + 1, len(todo))
        a = np.where(side[todo] > 0, qa[pick[todo], kk], qd[pick[todo], kk])
        ok = np.isfinite(a)
        k[todo[ok]] = kk[ok]
        todo = todo[~ok]
    keep = k >= 0
    return pick[keep], k[keep], side[keep]


def _moment_setup(tab, e, t_min):
    qa, qd = C.quotes(tab)
    kmax = int(np.max(np.flatnonzero(tab.T >= t_min)))
    groups = tab.day.astype(np.int64) * 16 + tab.w_asset.astype(np.int64)
    eg = np.asarray(e["day"], np.int64) * 16 + np.asarray(e["asset"], np.int64)
    counts = np.zeros(int(groups.max()) + 1, np.int64)
    np.add.at(counts, eg, 1)
    return qa, qd, kmax, groups, counts


def _moment_k(w, s, rng, qa, qd, kmax, tries=60):
    """A uniform second in [0, kmax] with a finite ask on side s, in each window w (-1 where `tries` draws found none)."""
    k = np.full(len(w), -1)
    todo = np.arange(len(w))
    for _ in range(tries):
        if len(todo) == 0:
            break
        kk = rng.integers(0, kmax + 1, len(todo))
        ok = np.isfinite(np.where(s[todo] > 0, qa[w[todo], kk], qd[w[todo], kk]))
        k[todo[ok]] = kk[ok]
        todo = todo[~ok]
    return k


def _moment_fill(tab, w, k, s, qa, qd, usd):
    """The engine's fill of each one-second row (window w, second k, side s). -> (filled row mask, net, fee, ask) over the rows."""
    lim = np.where(s > 0, qa[w, k], qd[w, k])
    got = B.entries(_Rows(tab, w, k), s[:, None], np.ones((len(w), 1), bool), lim[:, None], usd)
    f, nt, fe = np.zeros(len(w), bool), np.zeros(len(w)), np.zeros(len(w))
    f[got["w"]], nt[got["w"]], fe[got["w"]] = True, got["net"], got["fee"]
    return f, nt, fe, lim


def random_moment(tab, e, t_min=300, usd=B.CLIP_USD, draws=1000, seed=13, chunk=50, retries=0):
    """The random-moment null for the test whose entries are `e`: per draw the mean net an entry, the net without the best 5%, the entry count and the mean ask
    and fee an entry. `retries` > 0 retries a pick that did not fill at another uniform second of the same window and side, up to that many times (the rule
    retries a later second of its window); 0 keeps the first pick only. -> dict(per, ex5, n, tried, ask, fee) of arrays (draws,)."""
    qa, qd, kmax, groups, counts = _moment_setup(tab, e, t_min)
    rng = np.random.default_rng(seed)
    per, ex5, n, tried = np.full(draws, np.nan), np.full(draws, np.nan), np.zeros(draws, int), np.zeros(draws, int)
    ask, fee = np.full(draws, np.nan), np.full(draws, np.nan)
    for c0 in range(0, draws, chunk):
        ws, ks, ss, ds = [], [], [], []
        for i in range(c0, min(c0 + chunk, draws)):
            w, k, s = _moment_pick(tab, counts, rng, qa, qd, kmax, groups)
            ws.append(w); ks.append(k); ss.append(s); ds.append(np.full(len(w), i))
            tried[i] = len(w)
        w, k, s, d = np.concatenate(ws), np.concatenate(ks), np.concatenate(ss), np.concatenate(ds)
        f, nt, fe, lim = _moment_fill(tab, w, k, s, qa, qd, usd)
        for _ in range(retries):
            todo = np.flatnonzero(~f)
            if len(todo) == 0:
                break
            k2 = _moment_k(w[todo], s[todo], rng, qa, qd, kmax)
            todo, k2 = todo[k2 >= 0], k2[k2 >= 0]
            if len(todo) == 0:
                break
            f2, nt2, fe2, lim2 = _moment_fill(tab, w[todo], k2, s[todo], qa, qd, usd)
            hit = todo[f2]
            f[hit], nt[hit], fe[hit], lim[hit], k[hit] = True, nt2[f2], fe2[f2], lim2[f2], k2[f2]
        dd = d[f]
        for i in np.unique(dd):
            sel = dd == i
            v = nt[f][sel]
            n[i], per[i], ex5[i] = len(v), v.mean(), _ex_top5(v)
            ask[i], fee[i] = lim[f][sel].mean(), fe[f][sel].mean()
    return dict(per=per, ex5=ex5, n=n, tried=tried, ask=ask, fee=fee)


def moment_agrees(tab, e, t_min=300, usd=B.CLIP_USD, seed=5):
    """One random-moment draw two ways: the row table, and `B.entries` on the dense (W, NK) side, trigger and limit matrices. -> (agree, n entries)."""
    qa, qd, kmax, groups, counts = _moment_setup(tab, e, t_min)
    w, k, s = _moment_pick(tab, counts, np.random.default_rng(seed), qa, qd, kmax, groups)
    got = B.entries(_Rows(tab, w, k), s[:, None], np.ones((len(w), 1), bool), np.where(s > 0, qa[w, k], qd[w, k])[:, None], usd)
    side = np.zeros((tab.W, tab.NK), np.int8)
    trig = np.zeros((tab.W, tab.NK), bool)
    side[w, k], trig[w, k] = s, True
    dense = B.entries(tab, side, trig, np.where(side > 0, qa, qd), usd)
    return bool(len(dense["net"]) == len(got["net"]) and np.allclose(np.sort(dense["net"]), np.sort(got["net"]))), int(len(got["net"]))


# ============================================================ the random-burst null (the accounting audit, 2026-10-11: findings 2 and 3)
def ask_of(tab, e):
    """The ask each entry's rule saw at its decision second on its own side (the limit the fill honoured)."""
    qa, qd = C.quotes(tab)
    w, k = np.asarray(e["w"], np.int64), np.asarray(e["k"], np.int64)
    return np.where(np.asarray(e["side"]) > 0, qa[w, k], qd[w, k])


def burst_pools(tab, masks, lab, usd=B.CLIP_USD):
    """The cells test `lab`'s random-burst null draws from: every condition of the test except the burst, a side at a time, before the time mask
    (`masks` is what `tf15_cands.near_tests` returns). A and F: the price gate (F's breadth is other coins bursting, a burst condition, so it goes with the burst).
    E: the gate and the near ask unchanged over 3 s. G: the gate on ETH, SOL and XRP. H: the gate and the clip resting at the best ask. C (no gate): every
    second with a finite ask on that side (`random_burst` reads it with `random_moment`). D (no burst): None. -> (pool_up, pool_dn) or None."""
    if lab == "D":
        return None
    qa, qd = C.quotes(tab)
    if lab == "C":
        return np.isfinite(qa), np.isfinite(qd)
    p_up, p_dn = masks["nup_up"], masks["nup_dn"]
    if lab in ("A", "F"):
        return p_up, p_dn
    if lab == "E":
        su, sd = C.ask_still(tab, 3)
        return p_up & su, p_dn & sd
    if lab == "G":
        alt = (np.asarray(tab.w_asset) != 0)[:, None]
        return p_up & alt, p_dn & alt
    if lab == "H":
        with np.errstate(invalid="ignore"):
            return p_up & (tab.qas.astype(float) * qa >= usd), p_dn & (tab.qbs.astype(float) * qd >= usd)
    raise KeyError(f"no random-burst pool for test {lab}: name its conditions other than the burst here")


def _targets(tab, e):
    """(the (day, coin) group of every window, the test's entry count per group)."""
    groups = tab.day.astype(np.int64) * 16 + tab.w_asset.astype(np.int64)
    counts = np.zeros(int(groups.max()) + 1, np.int64)
    np.add.at(counts, np.asarray(e["day"], np.int64) * 16 + np.asarray(e["asset"], np.int64), 1)
    return groups, counts


def _burst_items(tab, pools, tm, usd):
    """Every (cell, side) the pools allow inside the time mask and the engine's fill of it: `B.entries` on the dense (W, NK) side, trigger and limit
    matrices, every fill kept (not one a window), the limit the side's own ask at t. -> dict over the FILLED items in (window, second, side) order:
    w, k, side, net, fee, ask, both (the cell passes on both sides: a coin flip each draw), and cells (the pool's cells, filled or not)."""
    qa, qd = C.quotes(tab)
    p_up, p_dn = pools[0] & tm, pools[1] & tm
    ones = np.ones(p_up.shape, np.int8)
    parts = []
    for s, pool, lim in ((1, p_up, qa), (-1, p_dn, qd)):
        e = B.entries(tab, ones * s, pool, lim, usd, one_per_window=False)
        w, k = np.asarray(e["w"], np.int64), np.asarray(e["k"], np.int64)
        parts.append(dict(w=w, k=k, side=np.full(len(w), s, np.int8), net=np.asarray(e["net"], float), fee=np.asarray(e["fee"], float), ask=lim[w, k]))
    it = {c: np.concatenate([p_[c] for p_ in parts]) for c in parts[0]}
    o = np.lexsort((it["side"], it["k"], it["w"]))
    it = {c: v[o] for c, v in it.items()}
    it["both"] = (p_up & p_dn)[it["w"], it["k"]]
    bi = np.flatnonzero(it["both"])
    it["both_ix"], it["both_inv"] = bi, np.unique(it["w"][bi] * tab.NK + it["k"][bi], return_inverse=True)[1]
    it["cells"] = int((p_up | p_dn).sum())
    return it


def _burst_pick(it, groups, counts, W, rng):
    """One draw: per (day, coin) group the test's count of distinct windows. The law is that of walking every fillable (cell, side) in a uniformly random order
    and keeping the first of each window until the group's count is met (a miss is retried, as the rule retries a later second): a window's key is the least
    of its n items' uniform keys, drawn as 1 - V^(1/n), and the item inside it is uniform. Where both sides pass a cell a coin flip keeps one side.
    -> indices into the items (one a window)."""
    sel = np.arange(len(it["w"]))
    if len(it["both_ix"]):
        up = rng.random(int(it["both_inv"].max()) + 1) < 0.5
        valid = np.ones(len(sel), bool)
        bi = it["both_ix"]
        valid[bi] = (it["side"][bi] > 0) == up[it["both_inv"]]
        sel = sel[valid]
    ws = it["w"][sel]
    n_w = np.bincount(ws, minlength=W)
    start = np.concatenate([[0], np.cumsum(n_w)[:-1]])
    elig = n_w > 0
    key = np.full(W, np.inf)
    key[elig] = 1.0 - rng.random(int(elig.sum())) ** (1.0 / n_w[elig])
    o = np.lexsort((key, groups))
    gs = groups[o]
    rank = np.arange(W) - np.searchsorted(gs, gs, side="left")
    take = o[(rank < counts[gs]) & np.isfinite(key[o])]
    return sel[start[take] + np.minimum((rng.random(len(take)) * n_w[take]).astype(np.int64), n_w[take] - 1)]


def _avail(it, groups, counts):
    """Per group the count a draw can reach: the test's count, or fewer when the pool has fewer windows with a fillable item."""
    have = np.bincount(groups[np.unique(it["w"])], minlength=len(counts))[:len(counts)]
    return np.minimum(counts, have)


def random_burst(tab, e, masks, lab, t_min=300, usd=B.CLIP_USD, draws=1000, seed=17, retries=3):
    """The random-burst null of test `lab` whose entries are `e`: the same count of entries per (day, coin), drawn uniformly from the seconds that pass every
    condition of the test except the burst (`burst_pools`), the side the one whose ask passes there (a coin flip when both do), bought at that side's ask
    through the engine, one entry a window. It asks: given a book that passes the gate (and is stale, where the test says so), does the burst's direction add
    anything? C has no gate, so its null is the time mask alone (`random_moment`, a miss retried up to `retries` times in its window); D has no burst: None.
    -> dict(per, ex5, n, ask, fee) of arrays (draws,), target (the test's count), reach (the count the pool allows), cells, how ('pool' or 'moment')."""
    pools = burst_pools(tab, masks, lab, usd)
    if pools is None:
        return None
    if lab == "C":
        r = random_moment(tab, e, t_min=t_min, usd=usd, draws=draws, seed=seed, retries=retries)
        r.update(target=int(len(e["net"])), reach=int(len(e["net"])), cells=int((np.isfinite(C.quotes(tab)[0]) & masks["tm"]).sum()), how="moment")
        return r
    it = _burst_items(tab, pools, masks["tm"], usd)
    groups, counts = _targets(tab, e)
    rng = np.random.default_rng(seed)
    out = {c: np.full(draws, np.nan) for c in ("per", "ex5", "ask", "fee")}
    out["n"] = np.zeros(draws, int)
    for i in range(draws):
        j = _burst_pick(it, groups, counts, tab.W, rng)
        out["n"][i] = len(j)
        if len(j):
            v = it["net"][j]
            out["per"][i], out["ex5"][i], out["ask"][i], out["fee"][i] = v.mean(), _ex_top5(v), it["ask"][j].mean(), it["fee"][j].mean()
    out.update(target=int(counts.sum()), reach=int(_avail(it, groups, counts).sum()), cells=it["cells"], how="pool")
    return out


def null_faults(tab, w, k, side, groups, want, theta=None):
    """What is wrong with one null draw's entries (w, k, side): two entries in one window; a (day, coin) count other than `want`; with `theta`, an entry whose
    ask (on the cent grid, as the gate reads it) is not under its side's fair value less theta. -> list of faults (empty when the draw is sound)."""
    w, k, side = np.asarray(w, np.int64), np.asarray(k, np.int64), np.asarray(side)
    out = []
    if len(np.unique(w)) != len(w):
        out.append(f"{len(w) - len(np.unique(w))} windows hold two entries")
    got = np.bincount(groups[w], minlength=len(want))[:len(want)]
    if not np.array_equal(got, want):
        out.append(f"the count differs from the test's in {int((got != want).sum())} (day, coin) groups ({int(got.sum())} entries against {int(np.sum(want))})")
    if theta is not None:
        qa, qd = C.quotes(tab)
        ask = np.round(np.where(side > 0, qa[w, k], qd[w, k]), 4)
        pu = tab.pu.astype(float)[w, k]
        fair = np.where(side > 0, pu, 1.0 - pu)
        bad = ~(ask < fair - theta)
        if bad.any():
            out.append(f"{int(bad.sum())} entries' ask is not under fair minus {theta:g} on their side")
    return out


def burst_agrees(tab, e, masks, lab, theta, t_min=300, usd=B.CLIP_USD, seed=19):
    """One random-burst draw two ways, the drawn items and `B.entries` on the dense (W, NK) side, trigger and limit matrices with only the drawn cells live,
    and the draw's faults (`null_faults`: one a window, the test's count per (day, coin), and the gate on every entry's own side; C checks only the first two).
    -> dict(agree, n, faults); None for D."""
    pools = burst_pools(tab, masks, lab, usd)
    if pools is None:
        return None
    groups, counts = _targets(tab, e)
    if lab == "C":
        ok, n = moment_agrees(tab, e, t_min=t_min, usd=usd, seed=seed)
        return dict(agree=ok, n=n, faults=[])
    it = _burst_items(tab, pools, masks["tm"], usd)
    j = _burst_pick(it, groups, counts, tab.W, np.random.default_rng(seed))
    w, k, s = it["w"][j], it["k"][j], it["side"][j]
    side = np.zeros((tab.W, tab.NK), np.int8)
    trig = np.zeros((tab.W, tab.NK), bool)
    side[w, k], trig[w, k] = s, True
    qa, qd = C.quotes(tab)
    dense = B.entries(tab, side, trig, np.where(side > 0, qa, qd), usd)
    agree = bool(len(dense["net"]) == len(j) and np.allclose(np.sort(dense["net"]), np.sort(it["net"][j])))
    return dict(agree=agree, n=int(len(j)), faults=null_faults(tab, w, k, s, groups, _avail(it, groups, counts), theta))


# ============================================================ the self-test: each rule once right, each planted fault caught
def selftest() -> bool:
    ok = True

    def rec(label, cond):
        nonlocal ok
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        ok &= bool(cond)

    days = [f"d{i:02d}" for i in range(38)]
    bl = blocks(days)
    rec("blocks on 38 days are 14, 14 and 10 days", [b["n_days"] for b in bl] == [14, 14, 10] and bl[0]["role"] == "forecast")
    fo = folds(days)
    rec("folds on 38 days are five, the last out-of-sample week 3 days", len(fo) == 5 and len(fo[-1][1]) == 3 and list(fo[0][1]) == list(range(7, 14)))
    s_is = dict(n=200, per=0.5, per_lo=0.1, per_hi=0.9)
    rec("an out-of-sample mean inside the forecast and above zero is PASS", consistent(s_is, dict(n=50, per=0.4)) == "PASS")
    # planted faults: each must not pass
    rec("planted: below zero is FAIL", consistent(s_is, dict(n=50, per=-0.2)) == "FAIL")
    rec("planted: above the forecast's interval is FAIL", consistent(s_is, dict(n=50, per=1.5)) == "FAIL")
    rec("planted: 19 entries is thin, not a pass", consistent(s_is, dict(n=19, per=0.4)) == "thin")
    rec("planted: inside an interval that spans zero but below zero is FAIL", consistent(dict(n=200, per=0.1, per_lo=-0.5, per_hi=0.7), dict(n=50, per=-0.1)) == "FAIL")
    e = dict(day=np.array([0, 3, 14, 20, 30]), net=np.array([1.0, 2.0, 3.0, 4.0, 5.0]))
    rec("segment keeps only the named days", list(segment(e, np.arange(14, 28))["net"]) == [3.0, 4.0])
    rec("p one-sided: an observed value above every draw is at the floor 1/(draws + 1)", abs(p_one_sided(np.zeros(999), 1.0) - 1 / 1000) < 1e-12)
    rec("p one-sided: an observed value equal to every draw is 1", p_one_sided(np.ones(9), 1.0) == 1.0)
    rec("spearman of a monotone pair is 1, of a reversed pair -1", abs(spearman([1, 2, 3, 4], [2, 5, 7, 9]) - 1) < 1e-12 and abs(spearman([1, 2, 3], [3, 2, 1]) + 1) < 1e-12)
    # the random-side draw on a fake table: one window, one cell, Up wins; side Up fills 10 shares at 0.80 (net 10 - 8 - fee), Down at 0.22 fills
    t = B._fake_tab(1)
    t.W, t.NK = 1, 1
    t.qa, t.qb = np.array([[0.80]], np.float32), np.array([[0.78]], np.float32)
    g = (np.array([[True]]), np.array([[False]]))
    cw, ck, fu, nu, fd, nd = _side_cells(t, g, np.array([[True]]), 20.0)
    rec("random side on one cell: the Up draw wins, the Down draw loses", len(cw) == 1 and fu[0] and nu[0] > 0 and fd[0] and nd[0] < 0)
    rec("random side: a draw keeps the first filled cell a window",
        list(_side_draw(np.array([0, 0, 1]), np.array([False, True, True]), np.array([9.0, 1.0, 2.0]), np.array([True, True, True]), np.array([7.0, 8.0, 3.0]),
                        np.array([True, True, True]))) == [1.0, 2.0])
    # the random-burst null on a fake table: 4 windows of 3 seconds, groups (day 0, coin 0) = windows 0, 1 and (day 0, coin 1) = windows 2, 3; the Up ask 0.40
    # and the Up bid 0.38 everywhere (so the Down ask is 0.62), fair Up 0.60 except window 1 second 2 (0.40), theta 0.05: Up passes the gate at 11 of the 12
    # cells, Down at none; the test made 1 entry in group 0 and 2 in group 1
    ft = object.__new__(B.Tab)
    ft.W, ft.NK = 4, 3
    ft.lad = np.full((4, 4, 3, 4), np.nan)
    ft.lad[:, 0, :, 0], ft.lad[:, 1, :, 0], ft.lad[:, 2, :, 0], ft.lad[:, 3, :, 0] = 0.38, 100.0, 0.40, 100.0
    ft.qa, ft.qb = np.full((4, 3), 0.40, np.float32), np.full((4, 3), 0.38, np.float32)
    ft.pu = np.full((4, 3), 0.60, np.float32)
    ft.pu[1, 2] = 0.40
    ft.w_fee, ft.up = np.full(4, 0.07), np.array([True, False, True, False])
    ft.day, ft.slot, ft.w_asset, ft.T = np.zeros(4, np.int16), np.array([1, 1, 1, 1]), np.array([0, 0, 1, 1]), np.array([600.0, 599.0, 598.0])
    th = 0.05
    qa_, qd_ = C.quotes(ft)
    pools = (np.round(qa_, 4) < ft.pu.astype(float) - th, np.round(qd_, 4) < (1.0 - ft.pu.astype(float)) - th)
    tm1 = np.ones((1, 3), bool)
    fe_ = dict(day=np.array([0, 0, 0]), asset=np.array([0, 1, 1]), net=np.zeros(3))
    it = _burst_items(ft, pools, tm1, 20.0)
    groups, counts = _targets(ft, fe_)
    want = _avail(it, groups, counts)
    rng = np.random.default_rng(0)
    picks = [_burst_pick(it, groups, counts, ft.W, rng) for _ in range(200)]
    rec("random burst: the pool is the 11 gate-passing Up cells, every one filled", it["cells"] == 11 and len(it["w"]) == 11 and np.all(it["side"] == 1))
    rec("random burst: 200 draws, each sound (one a window, the test's count per group, every ask under fair minus theta on its side)",
        all(not null_faults(ft, it["w"][j], it["k"][j], it["side"][j], groups, want, th) for j in picks))
    sec = np.concatenate([it["k"][j][it["w"][j] == 0] for j in picks])
    rec("random burst: the second inside a window is uniform (each of window 0's three seconds drawn at least 20 times)", np.bincount(sec, minlength=3).min() >= 20)
    j0 = picks[0]
    w_, k_, s_ = it["w"][j0].copy(), it["k"][j0].copy(), it["side"][j0].copy()
    g0 = np.flatnonzero(groups[w_] == 0)[0]
    w_bad, k_bad = w_.copy(), k_.copy()
    w_bad[g0], k_bad[g0] = 1, 2
    rec("planted: a null entry at a second the gate refuses (fair 0.40, ask 0.40) is caught", any("not under fair" in f for f in null_faults(ft, w_bad, k_bad, s_, groups, want, th)))
    rec("planted: a draw one entry short of the test's count is caught", any("count differs" in f for f in null_faults(ft, w_[1:], k_[1:], s_[1:], groups, want, th)))
    rec("planted: a draw with two entries in one window is caught", any("two entries" in f for f in null_faults(ft, np.r_[w_, w_[:1]], np.r_[k_, k_[:1]], np.r_[s_, s_[:1]], groups, want, th)))
    side = np.zeros((4, 3), np.int8)
    trig = np.zeros((4, 3), bool)
    side[w_, k_], trig[w_, k_] = s_, True
    dense = B.entries(ft, side, trig, np.where(side > 0, qa_, qd_), 20.0)
    rec("random burst: one draw replayed through B.entries on the dense matrices gives the same entries", len(dense["net"]) == len(j0) and np.allclose(np.sort(dense["net"]), np.sort(it["net"][j0])))
    return bool(ok)


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
