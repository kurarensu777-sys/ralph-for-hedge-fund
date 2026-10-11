"""The resting-order (maker) simulator of the strategy search (B-0654). numpy only, no I/O.

A rule posts a limit BUY on the Up token (bid at b) or on the Down token (a bid at d, which is an Up ASK at 1 - d) and cancels it when Binance moves against the quote.
THE FILL MODEL, written before any result and conservative on purpose:
  * the order is decided at second k and rests on the book POST_LAT_MS later (the same 150 ms the taker pays; a maker pays no delay at the venue, ours is a latency we add);
  * it joins the BACK of the queue at its price (the displayed size at that price when it lands is ahead of it and never cancels), or sits alone one tick inside the touch;
  * it fills only from PRINTS: the volume printed after it rests at a price at or through its price (Up bid: px <= b; Down bid at d: Up px >= 1 - d), minus the queue ahead;
  * it is cancelled at the first Binance event whose fair value for the quoted side falls below b + the cancel margin, and the cancel lands CANCEL_LAT_MS later; prints inside that
    gap still fill it (the adverse selection a slow cancel pays);
  * a fill is held to expiry. The maker fee is nil and the maker earns REBATE x the taker fee that the print paid (venue card fee.category_rates, crypto 20% [1]).
Nothing here reads the outcome except `won` at the end.
"""
from __future__ import annotations

import numpy as np

import tf15_bt as B
import tf15_fv as FV

POST_LAT_MS = 150
CANCEL_LAT_MS = 150
REBATE = 0.20
TICK_SUB = 0.001                  # the market rows carry tick 0.001 [U]; sub-cent levels sit in 0.05% of mid-range book levels (4 Oct), so a sub-cent jump is a sensitivity only
TICK_CENT = 0.01                  # the conservative step: inside the touch by a whole cent, only where the spread is two cents or more


def _tick(best, mode):
    if mode == "improve_sub":
        return TICK_SUB
    return np.where((best >= 0.04) & (best < 0.96), TICK_CENT, TICK_SUB)


def fv_grid(tab: B.Tab, fvp: dict | None = None):
    """P(Up) on the 1 s grid (W, NK) and on the Binance event grid (E,) for the fair-value parameters `fvp`."""
    fvp = fvp or {}
    ref = tab.w_ptb if fvp.get("ref") == "ptb" else tab.w_a0
    pu_g = FV.pu_twap(tab.S, tab.known, tab.sig, tab.T[None, :], ref[:, None], basis=fvp.get("basis", 0.0), kappa=fvp.get("kappa", 1.0), sb=fvp.get("sb", 0.0))
    te = (tab.e_t.astype(float)) / 1000.0
    Te = 900.0 - te
    pu_e = FV.pu_twap(tab.e_S, tab.e_known, tab.e_sig, Te, ref[tab.e_w], basis=fvp.get("basis", 0.0), kappa=fvp.get("kappa", 1.0), sb=fvp.get("sb", 0.0))
    return pu_g, pu_e


def candidates(tab: B.Tab, pu_g, cfg):
    """Vectorised posting candidates: for each (window, second, side) the price b a resting bid would take, the queue ahead and the value. -> dict of flat arrays."""
    out = []
    step = int(cfg.get("step_s", 5))
    ks = np.arange(int(cfg.get("k_start", 10)) - B.K0, tab.NK - int(cfg.get("t_end_left", 20)) + B.K0 - 1, step)
    ks = ks[(ks >= 0) & (tab.T[ks] >= cfg.get("t_end_left", 20))]
    lad = tab.lad[:, :, ks, :]                      # (W, 4, nk, L)
    bid0, bsz0, ask0, asz0 = lad[:, 0, :, 0], lad[:, 1, :, 0], lad[:, 2, :, 0], lad[:, 3, :, 0]
    mode = cfg.get("mode", "join")
    improve = mode != "join"
    for side in cfg.get("sides", (1, -1)):
        if side > 0:
            best, bsz = bid0, bsz0
            other = ask0
            v = pu_g[:, ks]
            b = best + (_tick(best, mode) if improve else 0.0)
            q = np.zeros_like(bsz) if improve else bsz
            inside = b < other - 1e-9
        else:
            best = 1.0 - ask0                        # the Down best bid
            bsz = asz0
            other = 1.0 - bid0                        # the Down best ask
            v = 1.0 - pu_g[:, ks]
            b = best + (_tick(best, mode) if improve else 0.0)
            q = np.zeros_like(bsz) if improve else bsz
            inside = b < other - 1e-9
        b = np.round(b.astype(np.float64), 4)
        edge = v - b
        ok = np.isfinite(b) & np.isfinite(q) & inside & (edge >= cfg.get("post_margin", 0.0)) & (b >= cfg.get("p_lo", 0.02)) & (b <= cfg.get("p_hi", 0.98))
        w, j = np.nonzero(ok)
        out.append(dict(w=w, k=ks[j], side=np.full(len(w), side), b=b[w, j], q=q[w, j], v=v[w, j]))
    c = {key: np.concatenate([o[key] for o in out]) for key in out[0]}
    order = np.lexsort((c["k"], c["side"], c["w"]))
    return {key: val[order] for key, val in c.items()}


def run(tab: B.Tab, cfg: dict, fvp: dict | None = None, pu=None, usd=B.CLIP_USD, rebate=REBATE, cancel_lat_ms=CANCEL_LAT_MS, post_lat_ms=POST_LAT_MS):
    """Simulate the posting rule over every window. -> entries dict (same fields as `tf15_bt.entries`: one row per filled order)."""
    pu_g, pu_e = pu if pu is not None else fv_grid(tab, fvp)
    cd = candidates(tab, pu_g, cfg)
    life_ms = int(cfg.get("life_s", 30)) * 1000
    cm = cfg.get("cancel_margin", 0.0)
    rows = []
    n = len(cd["w"])
    i = 0
    while i < n:
        w, side = int(cd["w"][i]), int(cd["side"][i])
        j = i
        while j < n and cd["w"][j] == w and cd["side"][j] == side:
            j += 1
        e0, e1 = tab.e_off[w], tab.e_off[w + 1]
        et = tab.e_t[e0:e1]
        v_e = pu_e[e0:e1] if side > 0 else 1.0 - pu_e[e0:e1]
        p0, p1 = tab.p_off[w], tab.p_off[w + 1]
        pt, ppx, psz = tab.p_t[p0:p1], tab.p_px[p0:p1], tab.p_sz[p0:p1]
        free_ms = -1
        for m in range(i, j):
            k = int(cd["k"][m])
            t_dec = (B.K0 + k) * 1000
            if t_dec < free_ms:
                continue
            b, q = float(cd["b"][m]), float(cd["q"][m])
            t_eff = t_dec + post_lat_ms
            t_life = t_dec + life_ms
            t_end = (B.WIN_S - 5) * 1000
            a, z = np.searchsorted(et, [t_dec, min(t_life, t_end)], side="right")
            bad = np.flatnonzero(v_e[a:z] < b + cm)
            t_cancel = (int(et[a + bad[0]]) + cancel_lat_ms) if len(bad) else min(t_life, t_end)
            free_ms = t_cancel
            lo, hi = np.searchsorted(pt, [t_eff, t_cancel], side="right")
            if hi <= lo:
                continue
            px_, sz_ = ppx[lo:hi], psz[lo:hi]
            hit = (px_ <= b + 1e-9) if side > 0 else (px_ >= 1.0 - b - 1e-9)
            if not hit.any():
                continue
            S = np.floor(usd / b * 100.0) / 100.0
            cum = np.cumsum(np.where(hit, sz_, 0.0))
            filled = float(np.clip(cum[-1] - q, 0.0, S))
            if filled < 1e-9:
                continue
            first = int(np.argmax(cum - q > 1e-9))
            rows.append((w, k, side, b, filled, float(pt[lo + first]), float(t_cancel), float(cd["v"][m]), q))
            break                                                    # one fill per side per window
        i = j
    if not rows:
        return B._empty()
    R = np.array(rows)
    w, k, s, b, sh = R[:, 0].astype(int), R[:, 1].astype(int), R[:, 2].astype(int), R[:, 3], R[:, 4]
    won = (s > 0) == tab.up[w]
    cost = sh * b
    reb = rebate * tab.w_fee[w] * b * (1.0 - b) * sh
    payoff = np.where(won, sh, 0.0)
    net = payoff - cost + reb
    return dict(w=w, k=k, side=s, shares=sh, cost=cost, fee=-reb, vwap=b, best=b, won=won, payoff=payoff, net=net, gross=payoff - cost, day=tab.day[w], slot=tab.slot[w],
                asset=tab.w_asset[w], T=tab.T[k], sold=np.zeros(len(w)), t_fill=R[:, 5], t_cancel=R[:, 6], v=R[:, 7], q=R[:, 8])


def selftest() -> bool:
    ok = True

    def line(label, cond):
        nonlocal ok
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        ok &= bool(cond)

    # one synthetic window: a bid at 0.48 behind 30 shares, prints of 20 + 25 at <= 0.48 fill 15 of 40
    class T:                                                     # the smallest table the simulator reads
        pass
    t = T()
    t.W, t.NK = 1, 891
    t.T = (900 - (5 + np.arange(891))).astype(float)
    t.lad = np.full((1, 4, 891, 4), np.nan, np.float32)
    t.lad[0, 0, :, 0] = 0.48; t.lad[0, 1, :, 0] = 30.0; t.lad[0, 2, :, 0] = 0.50; t.lad[0, 3, :, 0] = 30.0
    t.up = np.array([True]); t.w_fee = np.array([0.07]); t.day = np.array([0]); t.slot = np.array([1]); t.w_asset = np.array([0])
    t.e_off = np.array([0, 3]); t.e_t = np.array([20000, 30000, 40000], np.int32); t.e_S = np.full(3, 100.0, np.float32)
    t.e_known = np.zeros(3, np.float32); t.e_sig = np.full(3, 1e-4, np.float32); t.e_w = np.zeros(3, np.int32)
    t.p_off = np.array([0, 3]); t.p_t = np.array([16000, 17000, 18000], np.int32); t.p_px = np.array([0.48, 0.47, 0.50], np.float32)
    t.p_sz = np.array([20.0, 25.0, 99.0], np.float32); t.p_w = np.zeros(3, np.int32)
    pu_g = np.full((1, 891), 0.60)
    pu_e = np.full(3, 0.60)
    cfg = dict(step_s=1000, k_start=10, post_margin=0.05, sides=(1,), life_s=60, cancel_margin=0.02, mode="join", t_end_left=20)
    e = run(t, cfg, pu=(pu_g, pu_e), usd=19.2)
    line("posts at second 10, fills 45 printed - 30 ahead = 15 of 40 shares at 0.48", len(e["w"]) == 1 and abs(e["shares"][0] - 15.0) < 1e-9 and abs(e["vwap"][0] - 0.48) < 1e-6)
    line("a print at 0.50 (above the bid) is not a fill; the rebate is 20% of the taker fee", abs(e["fee"][0] + 0.2 * 0.07 * 0.48 * 0.52 * 15) < 1e-6)
    t.p_t = np.array([16000, 31000, 32000], np.int32)
    cfg2 = dict(cfg, cancel_margin=0.05)
    e2 = run(t, cfg2, pu=(pu_g, np.array([0.60, 0.40, 0.40])), usd=19.2, cancel_lat_ms=150)
    line("a cancel at the first adverse event (30.0 s + 150 ms) leaves the later prints unfilled", len(e2["w"]) == 0)
    t.p_t = np.array([30050, 30100, 30200], np.int32)
    e3 = run(t, cfg2, pu=(pu_g, np.array([0.60, 0.40, 0.40])), usd=19.2, cancel_lat_ms=150)
    line("prints inside the cancel latency still fill it (adverse selection is paid)", len(e3["w"]) == 1)
    return bool(ok)


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
