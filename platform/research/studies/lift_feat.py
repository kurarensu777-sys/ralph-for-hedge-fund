"""Binance trade-price features and forward returns for the probability-lifting study (B-0649). numpy only; the one reader is `load_day`.

THE ONE RULE: a row stamped t uses trades with time <= t. A decision instant is every distinct trade millisecond (the last trade of that ms, so the
whole ms is known). Every look-back is an as-of read (`asof`, the last event at or before the instant); every forward value is read from the SAME
arrays but is only a TARGET, built in `targets` and never touched by `features`. The feature builder is handed an event table and returns columns,
the target builder is handed the same table and returns other columns; a planted test (`future_shift`) feeds the features a table shifted by k
instants and the gain must grow with k (a feature that cannot see the future is worth nothing when shifted back, a leak is worth more).

Feature GROUPS (the board item says the pinned files carry no aggressor side; they DO carry `buyer_maker`, read 2026-10-07, so flow is a separate,
labelled group and never part of the price-only answer):
    price  uses trade prices and trade times only
    size   price plus trade size (VWAP distance)
    flow   price plus the aggressor side (`buyer_maker`: True means the taker sold)
    state  the 15-minute window the instant sits in (seconds left, move since the start): NOT a next-move signal, kept to separate state from news
"""
from __future__ import annotations

import numpy as np

DAY_MS = 86_400_000
WIN_MS = 900_000
# seconds back from the instant at which the price is read: three sub-second steps, then every second to a minute
OFFS = np.concatenate([[0.0, 0.25, 0.5, 0.75], np.arange(1, 61, dtype=float)])
OFF_MS = np.round(OFFS * 1000).astype(np.int64)
COL = {s: 3 + s for s in range(1, 61)}                 # column of a whole second in OFFS
HORIZONS_S = (0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0)
LATENCIES_MS = (0, 50, 100, 150, 250, 500, 1000)
H_MS = np.round(np.array(HORIZONS_S) * 1000).astype(np.int64)
MAX_AHEAD_MS = int(1000 + 300_000)                     # the longest latency plus the longest horizon: a row needs tape this far ahead
MAX_BEHIND_MS = 60_000
GAP_MS = 5_000                                         # a silence in the tape longer than this is counted in the data checks (it voids nothing)
WINS = (3, 5, 10, 30, 60)


def asof(ts: np.ndarray, t: np.ndarray) -> np.ndarray:
    """Index of the last event with ts <= t, -1 before the first."""
    return np.searchsorted(ts, t, side="right") - 1


def day_ms(day: str) -> int:
    import datetime as dt
    return int(dt.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp() * 1000)


def prev_next(day: str):
    import datetime as dt
    d = dt.date.fromisoformat(day)
    return (d - dt.timedelta(days=1)).isoformat(), (d + dt.timedelta(days=1)).isoformat()


def events_from_frames(frames: list):
    """Trade frames (columns ts_ms, price, qty, buyer_maker; in day order) -> one event table, one row per distinct trade millisecond.
    price is the LAST trade of the ms, qty the summed size, sq the summed signed size (taker buy +, taker sell -), n the trade count."""
    import pandas as pd
    df = pd.concat([f[["ts_ms", "price", "qty", "buyer_maker"]] for f in frames], ignore_index=True)
    ts = df["ts_ms"].to_numpy(np.int64)
    if not np.all(np.diff(ts) >= 0):                    # a stable sort keeps the file's own order inside one ms
        o = np.argsort(ts, kind="stable")
        df = df.iloc[o].reset_index(drop=True)
        ts = df["ts_ms"].to_numpy(np.int64)
    px = df["price"].to_numpy(float)
    q = df["qty"].to_numpy(float)
    sq = np.where(df["buyer_maker"].to_numpy(bool), -q, q)
    first = np.concatenate([[0], np.flatnonzero(np.diff(ts) != 0) + 1])
    last = np.concatenate([first[1:] - 1, [len(ts) - 1]])
    return dict(ts=ts[first], px=px[last], q=np.add.reduceat(q, first), sq=np.add.reduceat(sq, first), n=np.diff(np.concatenate([first, [len(ts)]])),
                n_trades=int(len(df)))


def load_day(day: str, symbol: str = "BTCUSDT"):
    """The event table for [day - 1, day, day + 1) through the data layer (the day files are stored and checksummed there), the slice that is the day,
    and what was read. A neighbour day that is not published is simply absent (the first/last minute of the study then has no look-back/look-ahead and drops)."""
    from fundplat.data.crypto import ticks
    p, n = prev_next(day)
    frames, got = [], []
    for d in (p, day, n):
        try:
            frames.append(ticks.day_frame("spot", "aggTrades", symbol, d))
            got.append(d)
        except Exception:                                # NotPublished or absent: the day simply is not there
            if d == day:
                raise
    E = events_from_frames(frames)
    E["days_read"] = got
    E["n_day_trades"] = int(len(frames[got.index(day)]))
    E["day"] = day
    E["day0"], E["day1"] = day_ms(day), day_ms(day) + DAY_MS
    return E


def second_grid_vol(E: dict):
    """A causal slow per-second volatility: the sample sd of one-second log returns over the 540 whole seconds ending 60 s before the instant. Built on a whole-second
    as-of grid over the table; `sig_at(t)` reads it as of the instant (the grid second floor(t/1000) - 60 and the 540 before it)."""
    ts, px = E["ts"], E["px"]
    g0 = (ts[0] // 1000 + 1) * 1000
    g = g0 + 1000 * np.arange(int((ts[-1] - g0) // 1000), dtype=np.int64)
    lp = np.log(px[asof(ts, g)])
    r = np.diff(lp, prepend=lp[0])
    c = np.concatenate([[0.0], np.cumsum(r * r)])

    def sig_at(t):
        k = (t - g0) // 1000 - 60
        lo = np.clip(k - 540, 0, len(g))
        hi = np.clip(k, 0, len(g))
        n = np.maximum(hi - lo, 1)
        return np.sqrt(np.maximum((c[hi] - c[lo]) / n, 0.0))
    return sig_at


def instants(E: dict):
    """Row indices of the decision instants of the day: every distinct trade millisecond in [day0, day1) that has 60 s of tape behind it and 301 s ahead (the longest
    look-ahead read), so the first minute and the last five minutes of the table drop. There is NO rule about gaps in the tape: an earlier cut of this module dropped
    instants with a hole of 5 s or more in the next minute, which looks at the future and so keeps busy stretches (removed 2026-10-07, before any test day was read).
    A quiet stretch is a real state (the last trade stands); tape holes are looked for in the data checks (`gap_stats`) and the venue's candles."""
    ts = E["ts"]
    inday = (ts >= E["day0"]) & (ts < E["day1"])
    ok = inday & (ts >= ts[0] + MAX_BEHIND_MS) & (ts <= ts[-1] - MAX_AHEAD_MS)
    i = np.flatnonzero(ok)
    return i, dict(day_events=int(inday.sum()), kept=int(len(i)), dropped_edge=int(inday.sum()) - int(len(i)))


def gap_stats(E: dict):
    """Silences in the tape inside the day: how many gaps of GAP_MS or more, and the longest (seconds)."""
    ts = E["ts"]
    m = (ts >= E["day0"]) & (ts < E["day1"])
    d = np.diff(ts[m])
    return dict(gaps_over_5s=int((d > GAP_MS).sum()), longest_gap_s=float(d.max() / 1000.0) if len(d) else 0.0)


def features(E: dict, idx: np.ndarray, chunk: int = 60_000, shift: int = 0):
    """All features at the instants `idx`, in chunks. `shift` > 0 reads the table k instants EARLIER (stale), < 0 later (a planted leak); 0 is the study.
    -> (dict name -> float32 array, dict name -> group)."""
    ts, px = E["ts"], E["px"]
    lp = np.log(px)
    cq = np.concatenate([[0.0], np.cumsum(E["q"])])
    cpv = np.concatenate([[0.0], np.cumsum(E["q"] * px)])
    csq = np.concatenate([[0.0], np.cumsum(E["sq"])])
    sig_at = second_grid_vol(E)
    out, group = {}, {}
    for a in range(0, len(idx), chunk):
        ii = np.clip(idx[a:a + chunk] - shift, 0, len(ts) - 1)
        t = ts[ii]
        m = len(ii)
        I = asof(ts, t[:, None] - OFF_MS[None, :])                 # [m, 64] row of the price at each offset
        Q = (lp[np.maximum(I, 0)] - lp[ii][:, None]).astype(np.float32)   # log price minus the current one; Q[:, 0] == 0
        X = np.concatenate([Q[:, 63:3:-1], np.zeros((m, 1), np.float32)], axis=1)   # chronological, 1 s apart: X[:, 60] now, X[:, 0] 60 s ago
        D = np.diff(X, axis=1)                                     # one-second returns, D[:, -1] the last second
        sig = sig_at(t).astype(np.float32)
        sig = np.maximum(sig, 1e-6)
        part = {}
        grp = {}

        def put(name, v, g="price"):
            part[name] = np.asarray(v, dtype=np.float32)
            grp[name] = g

        bp = 1e4
        # ------------------------------------------------------------------ returns per look-back, signed (bp) and in sigmas
        put("ret_250ms", -Q[:, 1] * bp)
        put("ret_500ms", -Q[:, 2] * bp)
        put("ret_1s", -Q[:, COL[1]] * bp)
        for w in WINS:
            put(f"ret_{w}s", -Q[:, COL[w]] * bp)
        put("z_1s", -Q[:, COL[1]] / sig)
        for w in WINS:
            put(f"z_{w}s", -Q[:, COL[w]] / (sig * np.sqrt(w)))
        put("last250_ret", -Q[:, 1] * bp)
        put("prior750_ret", (Q[:, 1] - Q[:, COL[1]]) * bp)
        sg = np.stack([np.sign(part[f"ret_{w}s"]) for w in (1, 3, 5, 10)], axis=1)
        put("agree_4", sg.sum(1))                                     # H5: the 1, 3, 5 and 10 s returns agree (+4 all up, -4 all down)
        put("agree_6", sg.sum(1) + np.sign(part["ret_30s"]) + np.sign(part["ret_60s"]))
        # ------------------------------------------------------------------ momentum / trend
        S = np.sign(D)
        for w in WINS:
            Dw, Sw = D[:, -w:], S[:, -w:]
            nz = np.maximum((Sw != 0).sum(1), 1)
            put(f"fracpos_{w}s", (Sw > 0).sum(1) / nz)
            put(f"signcons_{w}s", Sw.sum(1) / w)
            Y = X[:, 60 - w:]                                       # w + 1 points
            x = np.arange(w + 1, dtype=np.float32)
            xc = x - x.mean()
            yc = Y - Y.mean(1, keepdims=True)
            sxy = yc @ xc
            sxx = float((xc * xc).sum())
            syy = (yc * yc).sum(1)
            slope = sxy / sxx
            put(f"slope_{w}s", slope * bp)
            put(f"r2_{w}s", np.where(syy > 0, sxy * sxy / (sxx * np.maximum(syy, 1e-30)), 0.0))
            hi_all, lo_all = Y.max(1), Y.min(1)                     # window including now
            hi_pr, lo_pr = X[:, 60 - w:60].max(1), X[:, 60 - w:60].min(1)   # window before now
            rng = np.maximum(hi_all - lo_all, 1e-9)
            put(f"pctrange_{w}s", (0 - lo_all) / rng)
            put(f"dist_hi_{w}s", -hi_all * bp)                      # >= 0: how far below the window high
            put(f"dist_lo_{w}s", -lo_all * bp)                      # <= 0: how far above the window low (as a negative number)
            brk = np.maximum(0, -hi_pr) - np.maximum(0, lo_pr)      # >0 an upside breakout of the prior window, <0 downside
            put(f"breakout_{w}s", brk * bp)
            put(f"breakout_z_{w}s", brk / (sig * np.sqrt(w)))
            put(f"newhi_{w}s", (X[:, 60] > hi_pr).astype(np.float32) - (X[:, 60] < lo_pr).astype(np.float32))
            put(f"range_{w}s", (hi_all - lo_all) * bp)
            put(f"tsince_hi_{w}s", w - Y.argmax(1))
            put(f"tsince_lo_{w}s", w - Y.argmin(1))
            put(f"hilo_recency_{w}s", (w - Y.argmax(1)) - (w - Y.argmin(1)))   # >0: the low is more recent than the high (price turning up)
            put(f"distmean_{w}s", -Y.mean(1) * bp)
            put(f"rv_{w}s", np.sqrt((Dw * Dw).mean(1)) * bp)
            put(f"maxabs_{w}s", np.abs(Dw).max(1) * bp)
        # records (new running highs/lows of the minute) among the last N seconds
        cmx = np.maximum.accumulate(X, axis=1)
        cmn = np.minimum.accumulate(X, axis=1)
        rec_hi = X[:, 1:] > cmx[:, :-1]
        rec_lo = X[:, 1:] < cmn[:, :-1]
        for nn in (10, 30):
            put(f"nrec_hi_{nn}s", rec_hi[:, -nn:].sum(1))
            put(f"nrec_lo_{nn}s", rec_lo[:, -nn:].sum(1))
            put(f"nrec_net_{nn}s", rec_hi[:, -nn:].sum(1) - rec_lo[:, -nn:].sum(1))
        del cmx, cmn, rec_hi, rec_lo
        # run of same-direction one-second moves (signed)
        s0 = S[:, -1]
        run = np.cumprod(S[:, ::-1] == s0[:, None], axis=1).sum(1) * (s0 != 0)
        put("run_1s", run * s0)
        # sub-second step returns: four 250 ms steps of the last second
        q4 = np.stack([Q[:, 0] - Q[:, 1], Q[:, 1] - Q[:, 2], Q[:, 2] - Q[:, 3], Q[:, 3] - Q[:, COL[1]]], axis=1)
        s4 = np.sign(q4)
        put("fracpos_1s", (s4 > 0).sum(1) / np.maximum((s4 != 0).sum(1), 1))
        put("signcons_1s", s4.sum(1) / 4.0)
        put("rv_1s", np.sqrt((q4 * q4).sum(1)) * bp)
        # ------------------------------------------------------------------ acceleration
        put("acc_1s", (D[:, -1] - D[:, -2]) * bp)
        put("acc_3s_10s", (-Q[:, COL[3]] - 0.3 * -Q[:, COL[10]]) * bp)
        put("acc_5s_30s", (-Q[:, COL[5]] - (5 / 30) * -Q[:, COL[30]]) * bp)
        sl5, sl30 = part["slope_5s"], part["slope_30s"]
        put("slopediff_5_30", sl5 - sl30)
        Yp = X[:, 50:56]                                            # the 5 s before the last 5 s
        xp = np.arange(6, dtype=np.float32)
        xpc = xp - xp.mean()
        put("dslope_5s", sl5 - ((Yp - Yp.mean(1, keepdims=True)) @ xpc / float((xpc * xpc).sum())) * bp)
        put("dret_5s", part["ret_5s"] - (X[:, 55] - X[:, 50]) * bp)
        put("volacc_5_30", part["rv_5s"] / np.maximum(part["rv_30s"], 1e-6))
        put("volacc_10_60", part["rv_10s"] / np.maximum(part["rv_60s"], 1e-6))
        # ------------------------------------------------------------------ over-extension / reversion
        big = np.abs(-Q[:, COL[1]]) > 3 * sig
        put("big1s", big.astype(np.float32) * np.sign(-Q[:, COL[1]]))
        put("revert250", np.sign(part["ret_1s"]) * np.sign(part["last250_ret"]) * -1)         # 1 when the last 250 ms went against the second
        # ------------------------------------------------------------------ size and flow groups (labelled)
        for w in (5, 30, 60):
            j = I[:, COL[w]]
            cqw = cq[ii + 1] - cq[j + 1]
            vw = (cpv[ii + 1] - cpv[j + 1]) / np.maximum(cqw, 1e-12)
            put(f"vwapdist_{w}s", np.log(px[ii] / np.maximum(vw, 1e-9)) * bp, "size")
        for w in (1, 3, 5, 10, 30):
            j = I[:, COL[w]]
            cqw = cq[ii + 1] - cq[j + 1]
            put(f"imb_{w}s", np.where(cqw > 0, (csq[ii + 1] - csq[j + 1]) / np.maximum(cqw, 1e-12), 0.0), "flow")
        j5 = I[:, COL[5]]
        put("qty_5s", np.log1p(cq[ii + 1] - cq[j5 + 1]), "size")
        # ------------------------------------------------------------------ window state (not a next-move signal)
        wstart = (t // WIN_MS) * WIN_MS
        put("sec_left", (wstart + WIN_MS - t) / 1000.0, "state")
        put("sec_in", (t - wstart) / 1000.0, "state")
        put("sigma_slow", sig * bp, "state")
        for k, v in part.items():
            out.setdefault(k, []).append(v)
        group.update(grp)
    return {k: np.concatenate(v) if len(v) > 1 else v[0] for k, v in out.items()}, group


def twap_grid(E: dict, with_known: bool = False):
    """The market's reference is a Chainlink 60 s TWAP; the Binance stand-in is the mean of the 60 whole-second as-of last-trade prices ending at a whole second.
    -> twap(t_ms), defined for a whole second t_ms whose 60-second look-back is on the table, else NaN. With `with_known` also known(t_ms, end_ms): the sum and the count of the
    whole-second prices of the final minute of a window that exist at t_ms (zero until the final minute starts)."""
    ts, px = E["ts"], E["px"]
    g0 = (ts[0] // 1000 + 1) * 1000
    n = int((ts[-1] - g0) // 1000) + 1
    g = g0 + 1000 * np.arange(n, dtype=np.int64)
    P = px[asof(ts, g)]
    cum = np.concatenate([[0.0], np.cumsum(P)])

    def twap(t):
        k = (np.asarray(t) - g0) // 1000
        ok = (k >= 59) & (k < n)
        kk = np.clip(k, 59, n - 1)
        return np.where(ok, (cum[kk + 1] - cum[kk - 59]) / 60.0, np.nan)

    def known(t, end):
        k_now = (np.asarray(t) - g0) // 1000
        k_first = (np.asarray(end) - 59_000 - g0) // 1000
        cnt = np.clip(k_now - k_first + 1, 0, 60)
        hi = np.clip(k_now + 1, 0, n)
        lo = np.clip(hi - cnt, 0, n)
        return cum[hi] - cum[lo], cnt
    return (twap, known) if with_known else twap


def state_and_outcome(E: dict, idx: np.ndarray):
    """The 15-minute window of each instant. The market pays Up when the TWAP-60 at the end is at or above the TWAP-60 at the start. The state is known at t: the start
    reference A_start, the move since it (bp), and how much of the final minute's average already exists (`known_sum`, `known_n`). The outcome A_end is a TARGET (NaN where the
    window end is past the table)."""
    ts, px = E["ts"], E["px"]
    t = ts[idx]
    ws = (t // WIN_MS) * WIN_MS
    we = ws + WIN_MS
    tw, known = twap_grid(E, with_known=True)
    a0 = tw(ws)
    a1 = tw(we)
    ks, kn = known(t, we)
    pn = px[idx]
    since = np.log(pn / a0) * 1e4
    to_end = np.log(a1 / pn) * 1e4
    full = np.log(a1 / a0) * 1e4
    return dict(ret_since_start=since.astype(np.float32), fwd_to_end=to_end.astype(np.float32), full_move=full.astype(np.float32), a_start=a0.astype(np.float64),
                known_sum=ks.astype(np.float64), known_n=kn.astype(np.int16), px_now=pn.astype(np.float64), win_id=(ws // WIN_MS).astype(np.int64))


def targets(E: dict, idx: np.ndarray):
    """Forward log returns in bp. F[:, l, h] = ln p(t + L_l + h) / p(t + L_l): the position taken L later, held h. Signed; the absolute value is |F|.
    Entry price is the as-of price at t + L (the last trade then), never the next."""
    ts, px = E["ts"], E["px"]
    lp = np.log(px)
    t = ts[idx]
    F = np.empty((len(idx), len(LATENCIES_MS), len(H_MS)), np.float32)
    for li, L in enumerate(LATENCIES_MS):
        a = lp[asof(ts, t + L)]
        for hi, H in enumerate(H_MS):
            F[:, li, hi] = (lp[asof(ts, t + L + H)] - a) * 1e4
    return F
