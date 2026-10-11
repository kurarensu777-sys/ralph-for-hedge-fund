"""The analyses of the probability-lifting study (B-0649) that the notebook calls: data checks, curves, models, state against signal, episodes. numpy and pandas only;
the engine is `lift_feat`, the statistics `lift_stats`, the protocol `lift_protocol`, the models `lift_model`. No figure is drawn here."""
from __future__ import annotations

import hashlib
import os
import pickle
from pathlib import Path

import numpy as np
import pandas as pd

import lift_feat as LF
import lift_model as LM
import lift_protocol as P
import lift_stats as ST


# ============================================================================ S2: data checks
def tape_summary(days: dict) -> pd.DataFrame:
    rows = []
    for d, v in days.items():
        c = v.count
        rows.append(dict(day=d, aggtrades=v.n_trades, distinct_ms=v.n_events_table, instants=c["kept"], dropped_edge=c["dropped_edge"], gaps_over_5s=v.gaps["gaps_over_5s"],
                         longest_gap_s=v.gaps["longest_gap_s"], price_lo=float(v.px.min()), price_hi=float(v.px.max()), days_read=",".join(x[5:] for x in v.days_read)))
    return pd.DataFrame(rows)


def klines_check(day: str, hours=(3, 11, 19), symbol="BTCUSDT") -> dict:
    """The tape against the venue's own one-second candles: the last trade at or before the end of each second must equal the candle's close, for three sampled hours.
    The candle count is the venue's trade count, not ours, and is not compared."""
    from fundplat.data.crypto import ticks
    E = LF.load_day(day, symbol)
    ts, px = E["ts"], E["px"]
    d0 = E["day0"]
    n = eq = 0
    worst = 0.0
    for h in hours:
        rows = ticks.klines_1s(symbol, d0 + h * 3_600_000, d0 + (h + 1) * 3_600_000)
        if not rows:
            continue
        o = np.array([r["open_ms"] for r in rows], dtype=np.int64)
        c = np.array([r["close"] for r in rows])
        i = LF.asof(ts, o + 999)
        ok = i >= 0
        d = np.abs(px[i[ok]] - c[ok])
        n += int(ok.sum())
        eq += int((d < 1e-9).sum())
        worst = max(worst, float(d.max()) if ok.any() else 0.0)
    return dict(day=day, seconds=n, equal=eq, share=eq / max(n, 1), worst_usd=worst)


def twap_check(day: str, symbol="BTCUSDT", asset="btc") -> dict:
    """The Binance TWAP-60 stand-in against the markets' recorded outcomes (Up when the end TWAP is at or above the start TWAP)."""
    import updown15_runner as RUN
    E = LF.load_day(day, symbol)
    tw = LF.twap_grid(E)
    rows = RUN.market_rows(day, assets=(asset,))
    n = ok = 0
    for r in rows:
        a0, a1 = tw(np.array([r["start_ms"]]))[0], tw(np.array([r["end_ms"]]))[0]
        if not (np.isfinite(a0) and np.isfinite(a1)):
            continue
        n += 1
        ok += int((a1 >= a0) == (r["outcome"] == "Up"))
    return dict(day=day, windows=n, agree=ok, share=ok / max(n, 1))


# ============================================================================ S3: the scan and its summary
def scan_targets():
    """The exploratory scan targets: every horizon at the delayed entry, and three at the instant itself."""
    return [(P.LAT_BAR_MS, h) for h in LF.HORIZONS_S] + [(0, h) for h in (1.0, 5.0, 10.0)]


def scan_summary(df: pd.DataFrame, t_bar=P.T_BAR) -> dict:
    """Counts the exploratory scan can honestly state: tests run, how many reach the t bar on the later days with the fit-day sign and on every later day, by group."""
    surv = df[(df.t.abs() >= t_bar) & (np.sign(df.rho) == np.sign(df.rho_fit)) & (df.days_same_sign == df.n_days)]
    return dict(n_tests=int(len(df)), n_features=int(df.feature.nunique()), n_targets=int(len(df.groupby(["L_ms", "h_s"]))), survive=int(len(surv)),
                survive_features=int(surv.feature.nunique()), survive_share=float(len(surv) / max(len(df), 1)))


# ============================================================================ S3: curves
def z_curve(coh: ST.Cohort, z, edges=((1, 2), (2, 3), (3, 4), (4, 6), (6, 99))):
    return ST.curve_rows(coh, z, list(edges))


def breakout_curve(coh: ST.Cohort, brk_z, brk_bp, Y0, hs=(1.0, 5.0, 10.0), edges=((0, 1), (1, 2), (2, 4), (4, 99))):
    """After a break of the high (low) of the last 10 s of size |brk_z| second-volatilities: the continuation edge at the delayed entry (cohort) and the share of breaks that
    FALL BACK through the broken level by the horizon (the price h seconds on, read at the instant itself, is back inside the old range).
    Y0 is the [n, horizons] matrix of returns from the instant itself (bp), columns by `hs`."""
    rows = []
    ab = np.abs(brk_z)
    for lo, hi in edges:
        m = (ab > lo) & (ab <= hi) & (brk_z != 0)
        ed, se, win = coh.edge(brk_z, m)
        w = coh.W * m
        for j, (li, hj) in enumerate(coh.cols):
            h = LF.HORIZONS_S[hj]
            if h not in hs or LF.LATENCIES_MS[li] != P.LAT_BAR_MS:
                continue
            y0 = Y0[:, hs.index(h)] * np.sign(brk_z)
            fail = float((w * (y0 < -np.abs(brk_bp))).sum() / max(w.sum(), 1e-9))
            rows.append(dict(bucket=f"{lo:g}-{hi:g}", h_s=h, edge_bp=ed[j], t=ed[j] / se[j] if se[j] else np.nan, win_share=win[j], fall_back=fail, seconds=float(w.sum())))
    return pd.DataFrame(rows)


def by_mask(coh: ST.Cohort, x, masks: dict):
    """The sign-x edge for each named mask -> DataFrame (mask, L, h, edge, se, t, win share, seconds)."""
    rows = []
    for name, m in masks.items():
        ed, se, win = coh.edge(x, m)
        sec = float((coh.W * (m & (x != 0))).sum())
        for j, (li, hj) in enumerate(coh.cols):
            rows.append(dict(group=name, L_ms=LF.LATENCIES_MS[li], h_s=LF.HORIZONS_S[hj], edge_bp=ed[j], se=se[j], t=ed[j] / se[j] if se[j] else np.nan, win_share=win[j], seconds=sec))
    return pd.DataFrame(rows)


def decile_curve(coh: ST.Cohort, x, edges_fit):
    """Weighted mean forward return in each FIT decile of x, with a cluster standard error per decile -> DataFrame (decile, L, h, mean, se, seconds)."""
    b = np.searchsorted(edges_fit, x, side="right")
    rows = []
    for k in range(len(edges_fit) + 1):
        m = b == k
        w = coh.W * m
        sw = w.sum()
        if sw <= 0:
            continue
        mu = (w[:, None] * coh.Y).sum(0) / sw
        S = np.add.reduceat(w[:, None] * (coh.Y - mu), coh.starts, axis=0)
        se = np.sqrt((S * S).sum(0)) / sw
        for j, (li, hj) in enumerate(coh.cols):
            rows.append(dict(decile=k + 1, L_ms=LF.LATENCIES_MS[li], h_s=LF.HORIZONS_S[hj], mean_bp=mu[j], se=se[j], seconds=float(sw)))
    return pd.DataFrame(rows)


# ============================================================================ S3/S4: episodes and the economics of a signal
def episodes(T, x, m, gap_ms=P.EPISODE_GAP_MS):
    """The first row of each episode of a signal: active rows (x != 0 inside the mask) of the same sign closer than `gap_ms` to the previous active row are one episode.
    -> boolean mask of first rows. A trader acts once per episode, so the per-episode edge is the one that can be earned; later rows know more of the burst."""
    act = np.flatnonzero((x != 0) & m)
    first = np.zeros(len(T), bool)
    if len(act) == 0:
        return first
    t = T[act]
    s = np.sign(x[act])
    new = np.ones(len(act), bool)
    new[1:] = ((t[1:] - t[:-1]) >= gap_ms) | (s[1:] != s[:-1])
    first[act[new]] = True
    return first


def episode_table(days: dict, coh_unw: ST.Cohort, x, m, h_list=(1.0, 5.0, 10.0, 30.0, 60.0), lat=P.LAT_BAR_MS):
    """Per-episode edge (each episode counts once) overall and by day: episodes, per hour, edge in bp at (lat, h), cluster t, win share ex ties."""
    first = episodes(coh_unw.T, x, m)
    rows = []
    hours = len(days) * 24.0
    for h in h_list:
        j = [i for i, (li, hj) in enumerate(coh_unw.cols) if LF.LATENCIES_MS[li] == lat and LF.HORIZONS_S[hj] == h][0]
        ed, se, win = coh_unw.edge(x, first)
        per_day = []
        for k in sorted(set(coh_unw.day)):
            sel = coh_unw.day == k
            sub = P._sub(coh_unw, sel)
            e_k, _, _ = sub.edge(x[sel], first[sel])
            per_day.append(float(e_k[j]))
        rows.append(dict(h_s=h, episodes=int(first.sum()), per_hour=float(first.sum() / hours), edge_bp=float(ed[j]), t=float(ed[j] / se[j]) if se[j] else np.nan, win_share=float(win[j]),
                         per_day=per_day))
    return pd.DataFrame(rows), first


# ============================================================================ S4: models
def names_price(days: dict):
    return [k for k, g in next(iter(days.values())).G.items() if g == "price"]


def fit_models(fit: dict, val: dict, names, clip, targets=P.MODEL_H, lat=P.LAT_BAR_MS, log=print, gbm_stride=8, lin_stride=3):
    """Fit on the FIT days; choose each model's setting on the VALIDATION days by correlation; return the chosen fits and a trial log (one row per fit).
    Targets are the returns from lat ms after the instant held h seconds (clipped at the FIT 99.9th percentile)."""
    Xf, Xv = LM.matrix(fit, names), LM.matrix(val, names)
    prep = LM.Prep(Xf)
    Zf, Zv = prep(Xf), prep(Xv)
    Wf, Wv = ST.stack(fit, "W"), ST.stack(val, "W")
    Yf, Yv = ST.stack(fit, "Y"), ST.stack(val, "Y")
    lin = slice(None, None, lin_stride)           # ridge and logistic read every third row: neighbouring rows are near copies
    li = ST.L_IDX[lat]
    trials, chosen = [], {}
    for h in targets:
        hi = ST.H_IDX[h]
        lim = clip[li, hi]
        yf, yv = np.clip(Yf[:, li, hi], -lim, lim), np.clip(Yv[:, li, hi], -lim, lim)
        best = {}
        for lam in P.RIDGE_LAMBDAS:
            b = LM.fit_ridge(Zf[lin], yf[lin], Wf[lin], lam)
            r = wrho(LM.predict_ridge(b, Zv), yv, Wv)
            trials.append(dict(model="ridge", setting=f"lambda {lam:g}", h_s=h, val_rho=r))
            if "ridge" not in best or r > best["ridge"][0]:
                best["ridge"] = (r, ("ridge", b, lam))
        # logistic on the sign of the move (rows that moved), weights as time
        mf = (yf != 0)[lin]
        for l2 in (1.0, 100.0):
            mdl = LM.fit_logistic(Zf[lin][mf], (yf[lin][mf] > 0).astype(float), Wf[lin][mf], l2)
            pv = LM.predict_logistic(mdl, Zv)
            r = wrho(pv - 0.5, yv, Wv)
            trials.append(dict(model="logistic", setting=f"l2 {l2:g}", h_s=h, val_rho=r))
            if "logistic" not in best or r > best["logistic"][0]:
                best["logistic"] = (r, ("logistic", mdl, l2))
        sub = slice(None, None, gbm_stride)
        binner = LM.Binner(Zf[sub])
        Xb = binner(Zf[sub])
        Xbv = binner(Zv)
        for depth in P.GBM_DEPTHS:
            g = LM.Boosted(depth=depth, rounds=P.GBM_ROUNDS, lr=0.1, min_leaf=1500, l2=100.0).fit(Xb, yf[sub], Wf[sub])
            r = wrho(g.predict(Xbv), yv, Wv)
            trials.append(dict(model="gbm", setting=f"depth {depth}", h_s=h, val_rho=r))
            log(f"  h={h:g}s gbm depth {depth}: validation rho {r:.4f}")
            if "gbm" not in best or r > best["gbm"][0]:
                best["gbm"] = (r, ("gbm", g, depth, binner))
        chosen[h] = {k: v[1] for k, v in best.items()}
    return dict(prep=prep, chosen=chosen, names=names), pd.DataFrame(trials)


def predict(models: dict, days: dict, h: float, kind: str):
    """Predictions of one chosen model for `days` (price features only)."""
    X = LM.matrix(days, models["names"])
    Z = models["prep"](X)
    spec = models["chosen"][h][kind]
    if kind == "ridge":
        return LM.predict_ridge(spec[1], Z)
    if kind == "logistic":
        return LM.predict_logistic(spec[1], Z) - 0.5
    return spec[1].predict(spec[3](Z))


def wrho(p, y, w):
    p, y, w = np.asarray(p, float), np.asarray(y, float), np.asarray(w, float)
    pc, yc = p - np.average(p, weights=w), y - np.average(y, weights=w)
    den = np.sqrt(np.average(pc ** 2, weights=w) * np.average(yc ** 2, weights=w))
    return float(np.average(pc * yc, weights=w) / den) if den > 0 else np.nan


def model_eval(pred, coh: ST.Cohort, edges_pred, j):
    """A model's prediction as a signal: the correlation with target column j, the mean outcome in each FIT-decile of the prediction, and the top-minus-bottom spread."""
    y = coh.Y[:, j]
    rho = wrho(pred, y, coh.W)
    b = np.searchsorted(edges_pred, pred, side="right")
    nb = len(edges_pred) + 1
    sw = np.bincount(b, weights=coh.W, minlength=nb)
    sy = np.bincount(b, weights=coh.W * y, minlength=nb)
    dm = sy / np.maximum(sw, 1e-12)
    # cluster se of the top-bottom spread
    top, bot = b == nb - 1, b == 0
    wt, wb = coh.W * top, coh.W * bot
    mt, mb = (wt * y).sum() / wt.sum(), (wb * y).sum() / wb.sum()
    S = np.add.reduceat(wt * (y - mt) / wt.sum() - wb * (y - mb) / wb.sum(), coh.starts)
    se = float(np.sqrt((S * S).sum()))
    return dict(rho=rho, deciles=dm, spread_bp=float(mt - mb), spread_t=float((mt - mb) / se) if se else np.nan, top_bp=float(mt), bottom_bp=float(mb))


# ============================================================================ S4: state against signal
def window_rows(days: dict, min_in=60.0, min_left=10.0):
    """Row mask for the 15-minute question: past the first minute (a TWAP start exists and the move since the start is meaningful) and with 10 s or more left."""
    si, sl = ST.stack(days, "sec_in"), ST.stack(days, "sec_left")
    return (si >= min_in) & (sl >= min_left)


def state_frame(days: dict, drift_bp, mask):
    """The rows of the 15-minute question as arrays. The market pays on a 60 s TWAP at the end, so the state is the expected end average given the path so far, not the last price:
    E[A_end] = (known final-minute prices + the missing ones at the last price) / 60, with the variance of a Brownian average (T - 40 for T >= 60 s left, T^3 / 10800 inside the
    final minute, in units of the per-second variance). z_state is ln(E[A_end] / A_start) over the volatility to the end; z_drift is a model's predicted extra move in the same
    units. up = the TWAP end is at or above the TWAP start (the market's rule); to_end is the realised move from now to the TWAP end (bp)."""
    g = lambda n: ST.stack(days, ("S", n))
    a0, pn, ks, kn = g("a_start").astype(np.float64), g("px_now").astype(np.float64), g("known_sum").astype(np.float64), g("known_n").astype(np.float64)
    full = g("full_move").astype(np.float64)
    to_end = g("fwd_to_end").astype(np.float64)
    sig = ST.stack(days, "sigma_slow").astype(np.float64)
    left = ST.stack(days, "sec_left").astype(np.float64)
    exp_end = np.where(kn > 0, (ks + (60.0 - kn) * pn) / 60.0, pn)
    var_units = np.where(left >= 60.0, left - 40.0, (60.0 - kn) ** 3 / 10800.0)
    den = np.maximum(sig * np.sqrt(np.maximum(var_units, 1e-9)), 1e-6)
    fr = pd.DataFrame(dict(z_state=np.log(exp_end / a0) * 1e4 / den, z_drift=np.asarray(drift_bp, float) / den, up=(full >= 0).astype(float), win=g("win_id"), left=left,
                           w=ST.stack(days, "W").astype(np.float64), T=ST.stack(days, "T"), since=g("ret_since_start").astype(np.float64), to_end=to_end, sig_den=den,
                           exp_move=np.log(exp_end / pn) * 1e4))
    fr = fr[mask & np.isfinite(fr.z_state) & np.isfinite(fr.up) & np.isfinite(fr.z_drift)]
    return fr.reset_index(drop=True)


def logloss(p, y, w):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-(w * (y * np.log(p) + (1 - y) * np.log(1 - p))).sum() / w.sum())


def brier(p, y, w):
    return float((w * (p - y) ** 2).sum() / w.sum())


def fit_state_models(fr_fit: pd.DataFrame):
    """Two nested logistic models of 'the window ends Up', fitted on the FIT rows: the state alone (z_state) and the state plus the drift term. Rows are weighted by time and
    thinned to one row in 5 for speed (the window is one outcome; rows inside it are not independent)."""
    sub = fr_fit.iloc[::5]
    w = sub.w.to_numpy()
    m0 = LM.fit_logistic(sub[["z_state"]].to_numpy(), sub.up.to_numpy(), w, 1.0)
    m1 = LM.fit_logistic(sub[["z_state", "z_drift"]].to_numpy(), sub.up.to_numpy(), w, 1.0)
    return m0, m1


def state_eval(fr: pd.DataFrame, m0, m1, bins=((10, 30), (30, 120), (120, 300), (300, 600), (600, 900)), reps=500, seed=3):
    """Out-of-sample log loss and Brier of the state-only model against state plus signal, overall and by seconds left, with a window-cluster bootstrap of the log-loss gain."""
    p0 = LM.predict_logistic(m0, fr[["z_state"]].to_numpy())
    p1 = LM.predict_logistic(m1, fr[["z_state", "z_drift"]].to_numpy())
    y, w = fr.up.to_numpy(), fr.w.to_numpy()
    out = []
    wins = fr.win.to_numpy()
    uw = np.unique(wins)
    rng = np.random.default_rng(seed)
    idx_by = {u: np.flatnonzero(wins == u) for u in uw}

    def gain(sel):
        return logloss(p0[sel], y[sel], w[sel]) - logloss(p1[sel], y[sel], w[sel])

    rows_sets = [("all", np.ones(len(fr), bool))] + [(f"{lo}-{hi} s left", (fr.left.to_numpy() >= lo) & (fr.left.to_numpy() < hi)) for lo, hi in bins]
    for name, sel in rows_sets:
        if sel.sum() < 100:
            continue
        g = gain(sel)
        # bootstrap whole windows
        wsel = np.unique(wins[sel])
        boots = []
        for _ in range(reps):
            pick = rng.choice(wsel, size=len(wsel), replace=True)
            ii = np.concatenate([idx_by[u] for u in pick])
            ii = ii[sel[ii]]
            boots.append(gain(ii))
        lo, hi = np.percentile(boots, [2.5, 97.5])
        out.append(dict(rows=name, windows=int(len(wsel)), logloss_state=logloss(p0[sel], y[sel], w[sel]), logloss_plus=logloss(p1[sel], y[sel], w[sel]), gain=g, lo=float(lo), hi=float(hi),
                        brier_state=brier(p0[sel], y[sel], w[sel]), brier_plus=brier(p1[sel], y[sel], w[sel]), mean_lift=float(np.average(p1[sel] - p0[sel], weights=w[sel])),
                        mean_abs_lift=float(np.average(np.abs(p1[sel] - p0[sel]), weights=w[sel]))))
    return pd.DataFrame(out), p0, p1


def remaining_move(fr: pd.DataFrame, drift_bp_pred, bins=((10, 30), (30, 120), (120, 300), (300, 600), (600, 900))):
    """Does the signal predict the MOVE TO THE END of the window beyond the state? Within each seconds-left bin, the weighted correlation of the predicted drift with the
    realised move to the window end, and the slope in bp of realised per predicted bp (a slope of 1 means the drift persists to the end, 0 that it dies out)."""
    rows = []
    d = np.asarray(drift_bp_pred, float)
    for lo, hi in bins:
        sel = ((fr.left >= lo) & (fr.left < hi)).to_numpy() & np.isfinite(fr.to_end.to_numpy())
        if sel.sum() < 100:
            continue
        w = fr.w.to_numpy()[sel]
        y = fr.to_end.to_numpy()[sel] - fr.exp_move.to_numpy()[sel]       # the move to the end beyond what the average already holds
        x = d[sel]
        xc, yc = x - np.average(x, weights=w), y - np.average(y, weights=w)
        slope = float(np.average(xc * yc, weights=w) / np.average(xc * xc, weights=w))
        rho = float(np.average(xc * yc, weights=w) / np.sqrt(np.average(xc * xc, weights=w) * np.average(yc * yc, weights=w)))
        rows.append(dict(left=f"{lo}-{hi} s", rho=rho, slope=slope, mean_pred_bp=float(np.average(np.abs(x), weights=w)), sd_to_end_bp=float(np.sqrt(np.average(yc * yc, weights=w)))))
    return pd.DataFrame(rows)


# ============================================================================ per-day, concentration, weighting
def daily_edges(days: dict, clip, th: dict, hyps=("H1", "H3", "H5"), h=5.0, lat=P.LAT_BAR_MS, roles=None):
    """The edge of each hypothesis on each day -> DataFrame (day, hyp, edge_bp, se, t, win_share, seconds)."""
    rows = []
    for d, v in days.items():
        one = {d: v}
        M = P.masks(one, th)
        coh = ST.Cohort(one, [(lat, h)], clip)
        for hy in hyps:
            x, m = M[hy]
            ed, se, win = coh.edge(x, m)
            rows.append(dict(day=d, hyp=hy, edge_bp=float(ed[0]), se=float(se[0]), t=float(ed[0] / se[0]) if se[0] else np.nan, win_share=float(win[0]),
                             seconds=float((coh.W * (m & (x != 0))).sum()), role=(roles or {}).get(d, "")))
    return pd.DataFrame(rows)


def concentration_curve(coh: ST.Cohort, x, m, j=0, bucket_ms=60_000):
    """Edge earned per clock minute, minutes with the signal sorted best first -> (fraction of those minutes, cumulative share of the total edge)."""
    sx = np.sign(x)
    w = coh.W * ((sx != 0) & m)
    g = w * sx * coh.Y[:, j]
    minute = (coh.T // bucket_ms)
    _, inv = np.unique(minute, return_inverse=True)
    c = np.bincount(inv, weights=g)
    has = np.bincount(inv, weights=w) > 0
    c = np.sort(c[has])[::-1]
    tot = c.sum()
    cum = np.cumsum(c) / tot if tot != 0 else np.zeros(len(c))
    return np.arange(1, len(c) + 1) / len(c), cum


def weighting_table(days: dict, clip, th: dict, hyps=("H1", "H3", "H5"), h=5.0, lat=P.LAT_BAR_MS):
    """The same edge averaged per trade (every row once) and per second of time (rows weighted by how long the state lasted)."""
    rows = []
    M = P.masks(days, th)
    for wname, wt in (("per trade", False), ("per second", True)):
        coh = ST.Cohort(days, [(lat, h)], clip, weighted=wt)
        for hy in hyps:
            x, m = M[hy]
            ed, se, win = coh.edge(x, m)
            rows.append(dict(weighting=wname, hyp=hy, edge_bp=float(ed[0]), t=float(ed[0] / se[0]), win_share=float(win[0])))
    return pd.DataFrame(rows)


def inputs_block(symbols, lo_ms: int, hi_ms: int) -> dict:
    """The manifest's `inputs`: each Binance symbol's day files (ticks.input_pin's digest hashed with the symbol) and the one read that cannot be fingerprinted."""
    import hashlib
    from fundplat.data.crypto import ticks
    from fundplat.quant.core import report as REPORT
    series = []
    for s in symbols:
        ip = ticks.input_pin(s, lo_ms, hi_ms)
        series.append(dict(spec=f"binance:{s}:aggTrades:-", pin=hashlib.sha256(f"binance:{s}:{ip['digest']}".encode()).hexdigest(), rows=int(sum(f["rows"] for f in ip["files"])),
                           first_ts=lo_ms, last_ts=hi_ms - 1, handle=None, cls="pin", trunc=False))
    unpinned = [{"what": "gamma market list (updown15.markets), used only to check the TWAP stand-in against recorded outcomes", "why": "a day cache of the venue's own listing, re-readable"}]
    return {"digest": REPORT.inputs_digest([x["pin"] for x in series]), "series": series, "unpinned": unpinned}


# ============================================================================ the three slow steps, with an optional DEV cache (never on in a final run)
def _dev_cache(name, key, fn):
    """Run fn(); when the environment variable LIFT_DEV_CACHE names a folder, keep and reuse the result there, keyed by `key`. A development aid so a notebook can be
    rebuilt without redoing a ten-minute step; the final build of a notebook runs with the variable unset and so computes everything."""
    d = os.environ.get("LIFT_DEV_CACHE")
    if not d:
        return fn()
    path = Path(d) / f"{name}-{hashlib.md5(repr(key).encode()).hexdigest()[:12]}.pkl"
    if path.exists():
        return pickle.loads(path.read_bytes())
    out = fn()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pickle.dumps(out, protocol=5))
    return out


def run_scan(fit, val, names, targets, clip):
    return _dev_cache("scan", (list(fit), list(val), len(names), targets), lambda: ST.scan(fit, val, names, targets, clip))


def run_models(fit, val, names, clip, targets, log=print):
    return _dev_cache("models", (list(fit), list(val), len(names), tuple(targets), P.GBM_ROUNDS, P.RIDGE_LAMBDAS, P.GBM_DEPTHS), lambda: fit_models(fit, val, names, clip, targets=targets, log=log))


def asset_family(symbol, fit_days, oos_days, hyps=("H1", "H3", "H5")):
    """H1, H3 and H5 on another coin over the out-of-sample days, with that coin's own fit-day thresholds and limits -> DataFrame with an `asset` column."""
    def go():
        f_ = ST.load_days(fit_days, symbol)
        o_ = ST.load_days(oos_days, symbol)
        clip_ = ST.clip_edges(ST.stack(f_, "Y"))
        th_ = P.thresholds(f_)
        ft = P.family_table(o_, clip_, th_)
        ft = ft[ft.hyp.isin(hyps)].copy()
        ft["asset"] = symbol[:-4].lower()
        return ft
    return _dev_cache("asset", (symbol, tuple(fit_days), tuple(oos_days)), go)
