"""The resting-bid engine of the maker-side burst study (B-0680). numpy only, no I/O. It sits on the decision tables of the strategy search (`tf15_bt.Tab`, `mom15_bt.MTab`) and reuses the
fill model of `tf15_mk` (um-008) with the order driven by a burst signal instead of a fair-value edge.

THE ORDER. At a firing second k of a burst signal (the frozen L = 1 s, z = 2.5 of um-009, BTC and ETH only) with the side s of the burst, the rule rests a post-only BUY on the token of side s
(the Up token for an up burst, the Down token for a down burst), USD 20 of it, for at most LIFE seconds. One fill per window; an order that expires or is cancelled unfilled is replaced at the
next firing second. The fill is held to expiry (the token pays 1 or 0 by the venue's resolution); a maker pays no fee and earns REBATE x the taker fee the print paid.
THE PRICE. `join`: the best bid the trader SAW at the decision second (the book as of t). `improve`: one cent inside it where the spread is two cents or more, else the best bid.
THE FILL MODEL (the same as `tf15_mk`, written before any result and conservative on purpose):
  * the order decided at t rests on the book POST_LAT_MS later; a bid at or above the best ask then is REJECTED (post-only), never a taker fill;
  * it joins the BACK of the queue at its price: the displayed size at prices at or better than its own, in the four levels the table keeps, is ahead of it and never cancels (this is the touch
    level in practice; the ladders pinned for these markets keep ten levels a side, so the queue beyond level four is not needed by a bid at the touch);
  * it fills only from PRINTS: the volume printed after it rests at a price at or through its own (Up bid: px <= b; Down bid at d: Up px >= 1 - d), minus the queue ahead, up to its size;
  * it is cancelled at the first Binance event that retraces the burst by RETRACE sigma (side-signed log move of the Binance mid from the decision-second mid <= -RETRACE x sigma_1s), and the cancel
    lands CANCEL_LAT_MS later; prints inside that gap still fill it (the adverse selection a slow cancel pays). `cancel = "fv"` is um-008's rule instead (the Brownian fair value of the quoted
    side falls below the bid + a margin); `cancel = "none"` rests to the end of the life.
Nothing here reads the outcome except `won` at the end (and the planted peek, which is named).
"""
from __future__ import annotations

import numpy as np

import tf15_bt as B
import tf15_mk as MK

POST_LAT_MS = MK.POST_LAT_MS
CANCEL_LAT_MS = MK.CANCEL_LAT_MS
REBATE = MK.REBATE
K0 = B.K0
TICK = 0.01

DEFAULT = dict(mode="join", life_s=30, cancel="retrace", retrace=1.0, fv_margin=0.0, cancel_lat_ms=CANCEL_LAT_MS, post_lat_ms=POST_LAT_MS, q_mult=1.0, p_lo=0.03, p_hi=0.97, rebate=REBATE,
               usd=B.CLIP_USD)


def name_of(cfg: dict) -> str:
    c = {**DEFAULT, **cfg}
    cancel = {"retrace": f"retrace {c['retrace']:g}s", "fv": f"fv+{c['fv_margin']:g}", "none": "no cancel"}[c["cancel"]]
    life = "expiry" if c["life_s"] is None else f"{c['life_s']:g}s"
    return f"{c['mode']}|life {life}|{cancel}"


def run(tab: B.Tab, side, trig, cfg: dict | None = None, pu_e=None):
    """Simulate the resting-bid rule over every window. side (W, NK) in {-1, 0, 1}, trig (W, NK) bool -> `orders`: one row per posted order (filled or not), plus counts.
    `pu_e` (E,) is the Brownian P(Up) on the Binance event grid, needed only for cancel = 'fv'."""
    c = {**DEFAULT, **(cfg or {})}
    if c["cancel"] == "fv" and pu_e is None:
        _g, pu_e = MK.fv_grid(tab)
    life_ms = None if c["life_s"] is None else int(round(c["life_s"] * 1000))
    t_end = (B.WIN_S - 5) * 1000
    ww, kk = np.nonzero(trig & (side != 0))
    rows = []
    n_nobook = n_cross = n_price = 0
    i, n = 0, len(ww)
    while i < n:
        w = int(ww[i])
        j = i
        while j < n and ww[j] == w:
            j += 1
        e0, e1 = tab.e_off[w], tab.e_off[w + 1]
        et, eS = tab.e_t[e0:e1], tab.e_S[e0:e1]
        p0, p1 = tab.p_off[w], tab.p_off[w + 1]
        pt, ppx, psz = tab.p_t[p0:p1], tab.p_px[p0:p1], tab.p_sz[p0:p1]
        free_ms = -1
        for m in range(i, j):
            k = int(kk[m])
            t_dec = (K0 + k) * 1000
            if t_dec < free_ms:
                continue
            s = int(side[w, k])
            qb, qa = float(tab.qb[w, k]), float(tab.qa[w, k])
            bid, ask = (qb, qa) if s > 0 else (1.0 - qa, 1.0 - qb)
            if not (np.isfinite(bid) and np.isfinite(ask)):
                n_nobook += 1
                continue
            b = bid
            if c["mode"] == "improve" and 0.04 <= bid < 0.96 and bid + TICK < ask - 1e-9:
                b = bid + TICK
            b = float(np.round(b, 4))
            if not (c["p_lo"] <= b <= c["p_hi"]):
                n_price += 1
                continue
            lad = tab.lad[w, :, k, :].astype(np.float64)                     # the Up ladder as of t + the table's fill delay, in float64: the table keeps float32, and a
            if s > 0:                                                        # float32 mirror (1 - ask) can land a hair under the cent, which would drop the touch from the queue
                lbp, lbs, lask = np.round(lad[0], 4), lad[1], float(lad[2, 0])
            else:
                lbp, lbs, lask = np.round(1.0 - lad[2], 4), lad[3], 1.0 - float(lad[0, 0])
            if not np.isfinite(lask):
                n_nobook += 1
                continue
            if b >= lask - 1e-9:
                n_cross += 1                                                 # post-only: a bid at or through the ask is rejected
                continue
            ahead = (lbp >= b - 1e-9) & np.isfinite(lbp) & np.isfinite(lbs)
            q = float(lbs[ahead].sum()) * c["q_mult"]
            S = np.floor(c["usd"] / b * 100.0) / 100.0
            t_eff = t_dec + int(c["post_lat_ms"])
            t_lim = t_end if life_ms is None else min(t_dec + life_ms, t_end)
            a, z = np.searchsorted(et, [t_dec, t_lim], side="right")
            if c["cancel"] == "retrace":
                r = s * np.log(eS[a:z].astype(float) / float(tab.S[w, k]))
                bad = np.flatnonzero(r <= -c["retrace"] * float(tab.sig[w, k]))
            elif c["cancel"] == "fv":
                v_e = pu_e[e0 + a:e0 + z] if s > 0 else 1.0 - pu_e[e0 + a:e0 + z]
                bad = np.flatnonzero(v_e < b + c["fv_margin"])
            else:
                bad = np.zeros(0, int)
            t_cancel = min(int(et[a + bad[0]]) + int(c["cancel_lat_ms"]), t_lim) if len(bad) else t_lim
            free_ms = t_cancel
            lo, hi = np.searchsorted(pt, [t_eff, t_cancel], side="right")
            filled, t_fill = 0.0, np.nan
            if hi > lo:
                px_, sz_ = ppx[lo:hi], psz[lo:hi]
                hit = (px_ <= b + 1e-9) if s > 0 else (px_ >= 1.0 - b - 1e-9)
                if hit.any():
                    cum = np.cumsum(np.where(hit, sz_, 0.0))
                    filled = float(np.clip(cum[-1] - q, 0.0, S))
                    if filled > 1e-9:
                        t_fill = float(pt[lo + int(np.argmax(cum - q > 1e-9))])
            rows.append((w, k, s, b, q, S, filled, t_dec, t_eff, t_cancel, t_fill, float(len(bad) > 0), bid, ask))
            if filled > 1e-9:
                break                                                        # one fill per window
        i = j
    cols = ("w", "k", "side", "b", "q", "target", "filled", "t_dec", "t_eff", "t_end", "t_fill", "cancelled", "bid_seen", "ask_seen")
    R = np.array(rows, float) if rows else np.zeros((0, len(cols)))
    o = {nm: R[:, j] for j, nm in enumerate(cols)}
    for nm in ("w", "k", "side"):
        o[nm] = o[nm].astype(int)
    o["cancelled"] = o["cancelled"].astype(bool)
    w = o["w"]
    o["won"] = (o["side"] > 0) == tab.up[w] if len(w) else np.zeros(0, bool)
    o["day"], o["slot"], o["asset"], o["T"] = (tab.day[w], tab.slot[w], tab.w_asset[w], tab.T[o["k"]]) if len(w) else (np.zeros(0, int),) * 4
    o["is_fill"] = o["filled"] > 1e-9
    sh, b = o["filled"], o["b"]
    reb = c["rebate"] * (tab.w_fee[w].astype(float) if len(w) else 0.0) * b * (1.0 - b) * sh
    o["rebate"] = reb
    o["cost"] = sh * b
    o["payoff"] = np.where(o["won"], sh, 0.0)
    o["net"] = o["payoff"] - o["cost"] + reb
    o["per_share"] = o["won"].astype(float) - b                              # what one share bought at b would have earned, filled or not (the adverse-selection read)
    o["counts"] = dict(posted=len(w), filled=int(o["is_fill"].sum()), no_book=n_nobook, crossed=n_cross, price_out=n_price)
    o["cfg"] = c
    return o


def fills(o: dict) -> dict:
    """The fill rows of `orders`, in the field names `tf15_bt.summarize` reads (the maker fee is a negative fee: the rebate)."""
    f = o["is_fill"]
    e = {k: o[k][f] for k in ("w", "k", "side", "won", "payoff", "net", "day", "slot", "asset", "T", "cost", "b", "q", "t_fill", "t_dec", "target", "bid_seen", "ask_seen")}
    e["shares"] = o["filled"][f]
    e["fee"] = -o["rebate"][f]
    e["gross"] = e["payoff"] - e["cost"]
    e["vwap"] = e["b"]
    e["best"] = e["b"]
    e["sold"] = np.zeros(int(f.sum()))
    return e


def with_side(tab, trig, kind: str, seed: int = 0, base=None):
    """The side array of a variant at the SAME firing seconds: 'burst' (the signal's own), 'placebo' (a fair coin at each firing second), 'peek' (the outcome's winner, the planted leak).
    `base` is the signal's own side (W, NK)."""
    if kind == "burst":
        return base
    if kind == "placebo":
        rng = np.random.default_rng(seed)
        return np.where(rng.random(trig.shape) < 0.5, 1, -1).astype(np.int8) * trig
    if kind == "peek":
        return np.where(tab.up, 1, -1).astype(np.int8)[:, None] * trig
    raise ValueError(kind)


def token_mid(tab, w, k, s):
    """The mid of the token of side s at whole-second column k (NaN where the book is one-sided or k is out of range)."""
    k = np.asarray(k)
    ok = (k >= 0) & (k < tab.NK)
    kc = np.clip(k, 0, tab.NK - 1)
    qb, qa = tab.qb[w, kc].astype(float), tab.qa[w, kc].astype(float)
    m = np.where(np.asarray(s) > 0, 0.5 * (qb + qa), 1.0 - 0.5 * (qb + qa))
    return np.where(ok, m, np.nan)


def col_of(t_ms):
    """The decision column of a time in ms since the window start."""
    return np.floor(np.asarray(t_ms, float) / 1000.0).astype(int) - K0


def move_after(tab, o, rows, t0_ms, horizon_s: int, binance: bool = False):
    """The move, in the order's direction, from the second of `t0_ms` to `horizon_s` seconds later: the token's mid (`binance=False`, price units) or the Binance mid (log, in basis points)."""
    w, s = o["w"][rows], o["side"][rows]
    k0 = col_of(t0_ms)
    if binance:
        ok = (k0 >= 0) & (k0 + horizon_s < tab.NK)
        a = np.clip(k0, 0, tab.NK - 1)
        z = np.clip(k0 + horizon_s, 0, tab.NK - 1)
        mv = s * np.log(tab.S[w, z].astype(float) / tab.S[w, a].astype(float)) * 1e4
        return np.where(ok, mv, np.nan)
    return token_mid(tab, w, k0 + horizon_s, s) - token_mid(tab, w, k0, s)


def diff_boot(slots_a, a, slots_b, b, n_boot: int = 4000, seed: int = 7):
    """The difference of two means (a minus b) with a 95% interval resampling 15-minute slots of both groups together. -> (diff, lo, hi)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    ma, mb = np.isfinite(a), np.isfinite(b)
    sa, sb = np.asarray(slots_a)[ma], np.asarray(slots_b)[mb]
    a, b = a[ma], b[mb]
    if len(a) == 0 or len(b) == 0:
        return (np.nan, np.nan, np.nan)
    u = np.unique(np.concatenate([sa, sb]))
    ia, ib = np.searchsorted(u, sa), np.searchsorted(u, sb)
    A_s, A_n = np.bincount(ia, weights=a, minlength=len(u)), np.bincount(ia, minlength=len(u)).astype(float)
    B_s, B_n = np.bincount(ib, weights=b, minlength=len(u)), np.bincount(ib, minlength=len(u)).astype(float)
    ix = np.random.default_rng(seed).integers(0, len(u), size=(n_boot, len(u)))
    est = A_s[ix].sum(1) / np.maximum(A_n[ix].sum(1), 1) - B_s[ix].sum(1) / np.maximum(B_n[ix].sum(1), 1)
    return (float(a.mean() - b.mean()), float(np.quantile(est, 0.025)), float(np.quantile(est, 0.975)))


# ============================================================ the engine's own checks
class _T:
    """The smallest table the engine reads: one window, 891 seconds, a bid at 0.48 (30 shares) over an ask at 0.50 (30 shares)."""

    def __init__(self, prints, events, up=True, ev_S=None):
        self.W, self.NK = 1, 891
        self.T = (900 - (5 + np.arange(891))).astype(float)
        self.lad = np.full((1, 4, 891, 4), np.nan, np.float32)
        self.lad[0, 0, :, 0], self.lad[0, 1, :, 0], self.lad[0, 2, :, 0], self.lad[0, 3, :, 0] = 0.48, 30.0, 0.50, 30.0
        self.qb = np.full((1, 891), 0.48, np.float32)
        self.qa = np.full((1, 891), 0.50, np.float32)
        self.S = np.full((1, 891), 100.0, np.float32)
        self.sig = np.full((1, 891), 1e-3, np.float32)
        self.up = np.array([up])
        self.w_fee = np.array([0.07], np.float32)
        self.day, self.slot, self.w_asset = np.array([0]), np.array([1]), np.array([0])
        ev = events
        self.e_off = np.array([0, len(ev)])
        self.e_t = np.array([e[0] for e in ev], np.int32)
        self.e_S = np.array([e[1] for e in ev], np.float32)
        pr = prints
        self.p_off = np.array([0, len(pr)])
        self.p_t = np.array([p[0] for p in pr], np.int32)
        self.p_px = np.array([p[1] for p in pr], np.float32)
        self.p_sz = np.array([p[2] for p in pr], np.float32)


def _fire(t, k=5, s=1):
    side = np.zeros((1, t.NK), np.int8)
    side[0, k] = s
    trig = np.zeros((1, t.NK), bool)
    trig[0, k] = True
    return side, trig


def selftest() -> bool:
    ok = True

    def line(label, cond):
        nonlocal ok
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        ok &= bool(cond)

    base = dict(life_s=60, usd=19.2)
    flat = [(20000, 100.0), (30000, 100.0), (40000, 100.0)]
    # 1. the queue: a bid at 0.48 behind 30 shares, prints 20 + 25 at <= 0.48 fill 15 of 40; a print at 0.50 is no fill; the rebate is 20% of the taker fee at the bid
    t = _T([(16000, 0.48, 20.0), (17000, 0.47, 25.0), (18000, 0.50, 99.0)], flat)
    side, trig = _fire(t, 5, 1)                                          # second 10
    o = run(t, side, trig, base)
    e = fills(o)
    line("posts at 0.48 behind 30, 45 printed through its price: fills 15 of 40 shares", len(e["w"]) == 1 and abs(e["shares"][0] - 15.0) < 1e-9 and abs(e["b"][0] - 0.48) < 1e-9)
    line("a print above the bid is not a fill; the rebate is 20% of the taker fee at the bid", abs(e["fee"][0] + 0.2 * 0.07 * 0.48 * 0.52 * 15) < 1e-6)
    line("a won share nets 1 - 0.48 plus the rebate; the net adds to payoff - cost + rebate", abs(e["net"][0] - (15.0 * 1.0 - 15.0 * 0.48 + 0.2 * 0.07 * 0.48 * 0.52 * 15)) < 1e-9)
    # 2. price priority: prints only above the bid never fill; queue sweep is monotone and an enormous queue fills nothing
    t2 = _T([(16000, 0.49, 99.0), (17000, 0.50, 99.0)], flat)
    line("prints only above the bid never fill it", run(t2, *_fire(t2), base)["counts"]["filled"] == 0)
    sh = [float(run(t, side, trig, dict(base, q_mult=m))["filled"].sum()) for m in (0.0, 1.0, 2.0, 1e9)]
    line("filled shares fall as the queue ahead grows (0, 1x, 2x, huge): 40, 15, 0, 0", sh[0] == 40.0 and sh[1] == 15.0 and sh[2] == 0.0 and sh[3] == 0.0)
    # 3. the cancel on a retrace: an event 1.5 sigma_1s below the decision mid cancels at its time + the latency; later prints do not fill, prints inside the gap do
    ret = [(20000, 100.0), (30000, 100.0 * np.exp(-1.5e-3)), (40000, 100.0)]
    t3 = _T([(16000, 0.48, 20.0), (31000, 0.47, 99.0)], ret)
    line("a retrace past 1 sigma at 30.0 s cancels at 30.15 s: the print at 31 s does not fill (only 20 - 30 queue = none, so the order stays empty)", run(t3, *_fire(t3), base)["counts"]["filled"] == 0)
    t4 = _T([(30100, 0.47, 99.0)], ret)
    line("a print inside the cancel latency (30.10 s) still fills it: the adverse selection of a slow cancel is paid", run(t4, *_fire(t4), base)["counts"]["filled"] == 1)
    t5 = _T([(31000, 0.47, 99.0)], ret)
    line("the same print at 31 s fills a no-cancel order and not the retrace-cancelled one", run(t5, *_fire(t5), dict(base, cancel="none"))["counts"]["filled"] == 1 and run(t5, *_fire(t5), base)["counts"]["filled"] == 0)
    line("a retrace smaller than the threshold (0.5 sigma) does not cancel", run(_T([(35000, 0.47, 99.0)], [(30000, 100.0 * np.exp(-0.5e-3))]), *_fire(t5), base)["counts"]["filled"] == 1)
    # 4. post-only: a bid at or through the landing ask is rejected, not filled
    t6 = _T([(16000, 0.48, 99.0)], flat)
    t6.lad[0, 2, 5:, 0] = 0.48                                           # the ask drops to the bid before the order lands
    o6 = run(t6, *_fire(t6), base)
    line("a bid that lands at or through the best ask is rejected (post-only), never filled", o6["counts"]["crossed"] == 1 and o6["counts"]["posted"] == 0)
    # 5. improve: a cent inside the touch posts alone (queue 0) and pays one cent more per share
    o7 = run(t, side, trig, dict(base, mode="improve"))
    line("improve posts a cent above the touch with no queue ahead and fills 40 shares at 0.49", abs(o7["b"][0] - 0.49) < 1e-9 and abs(o7["q"][0]) < 1e-9 and abs(o7["filled"][0] - 39.0) < 1.01)
    # 6. a down burst rests a bid on the Down token at 1 - the Up ask: Up prints at >= 1 - d fill it
    t8 = _T([(16000, 0.52, 60.0)], flat)
    o8 = run(t8, *_fire(t8, 5, -1), dict(base, q_mult=0.0))
    line("a Down bid at 0.50 (the Up ask) fills from an Up print at 0.52 (>= 1 - 0.50)", o8["counts"]["filled"] == 1 and abs(o8["b"][0] - 0.50) < 1e-9)
    # 6b. the queue of a Down bid is read off the float32 table in float64: an Up ask of 0.34 stored as float32 mirrors to 0.65999997 in float32, a hair under the bid of 0.66,
    #     which read as no queue at the touch before 2026-10-10 (a quarter of all orders posted at the front of the queue); the 299 shares ahead must be seen, and so must the 0.60 case
    for ask_, sz_ in ((0.34, 299.0), (0.60, 3190.87)):
        t10 = _T([(16000, ask_ + 0.02, 500.0)], flat)
        t10.lad[0, 0, :, 0], t10.lad[0, 1, :, 0], t10.lad[0, 2, :, 0], t10.lad[0, 3, :, 0] = ask_ - 0.01, 50.0, ask_, sz_
        t10.qb[:], t10.qa[:] = ask_ - 0.01, ask_
        o10 = run(t10, *_fire(t10, 5, -1), base)
        line(f"a Down bid at {1 - ask_:.2f} sees the {sz_:g} shares ahead of it at the touch (the float32 mirror of the Up ask {ask_:.2f} rounds under the cent)", o10["counts"]["posted"] == 1 and abs(o10["q"][0] - sz_) < 1e-3)     # the size is float32 in the table
    # 7. the peek and the placebo keep the firing seconds
    tr_ = np.array([[False, True, False]])
    tt = type("X", (), {"up": np.array([False])})()
    pk, pl = with_side(tt, tr_, "peek"), with_side(tt, tr_, "placebo", 3)
    line("the planted peek takes the winner's side and the placebo a coin's, at the firing seconds only", pk[0, 1] == -1 and pk[0, 0] == 0 and pl[0, 1] in (-1, 1) and pl[0, 0] == 0)
    # 8. equals tf15_mk on the same window (um-008's rule at the same price, queue and prints) when the cancel is um-008's own
    tt2 = _T([(16000, 0.48, 20.0), (17000, 0.47, 25.0), (18000, 0.50, 99.0)], flat)
    pu_g = np.full((1, 891), 0.60)
    e_mk = MK.run(tt2, dict(step_s=1000, k_start=10, post_margin=0.05, sides=(1,), life_s=60, cancel_margin=0.02, mode="join", t_end_left=20), pu=(pu_g, np.full(3, 0.60)), usd=19.2)
    o_mk = run(tt2, *_fire(tt2, 5, 1), dict(base, cancel="fv", fv_margin=0.02), pu_e=np.full(3, 0.60))
    line("tf15_mk (um-008) and this engine post the same bid, fill the same shares and net the same on one window",
         len(e_mk["w"]) == 1 and abs(e_mk["shares"][0] - o_mk["filled"][0]) < 1e-9 and abs(e_mk["net"][0] - o_mk["net"][0]) < 1e-6)
    # 9. the difference bootstrap: equal groups give a zero difference, a shifted group a positive one with an interval that excludes zero
    sl = np.repeat(np.arange(60), 5)
    d0 = diff_boot(sl, np.tile([0.0, 1.0, 0.0, 1.0, 0.0], 60), sl, np.tile([0.0, 1.0, 0.0, 1.0, 0.0], 60))
    d1 = diff_boot(sl, np.tile([1.0, 2.0, 1.0, 2.0, 1.0], 60), sl, np.tile([0.0, 1.0, 0.0, 1.0, 0.0], 60))
    line("the slot bootstrap of a difference: 0 for equal groups, +1 with an interval clear of zero for a shift of one", abs(d0[0]) < 1e-12 and d0[1] <= 0 <= d0[2] and abs(d1[0] - 1) < 1e-9 and d1[1] > 0)
    # 10. the move after a fill is read in the order's direction on the token's mid
    t9 = _T([], flat)
    t9.qb[0, 20:] = 0.58
    t9.qa[0, 20:] = 0.60
    o9 = dict(w=np.array([0]), side=np.array([1]))
    mv = move_after(t9, o9, np.array([0]), np.array([20000]), 5)
    mv_dn = move_after(t9, dict(w=np.array([0]), side=np.array([-1])), np.array([0]), np.array([20000]), 5)
    line("a token mid that steps from 0.49 to 0.59 reads +0.10 for an Up order and the mirror -0.10 for a Down order",
         abs(float(mv[0]) - 0.10) < 1e-6 and abs(float(mv_dn[0]) + 0.10) < 1e-6)
    t9.S[0, 20:] = 100.0 * np.exp(2e-4)
    bm = move_after(t9, o9, np.array([0]), np.array([20000]), 5, binance=True)
    line("a Binance mid up 2 bp in the 5 s reads +2 bp for an Up order", abs(float(bm[0]) - 2.0) < 1e-3)
    return bool(ok)


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
