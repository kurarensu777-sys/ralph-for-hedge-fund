"""Reads of the probability-lifting study (B-0649): the day cache, weighted and cluster-robust statistics, the univariate scan, the conditional curves, the latency table.
numpy and pandas only; the feature engine is `lift_feat`, the models `lift_model`, the planted tests `lift_verify`.

TWO WEIGHTINGS, BOTH REPORTED. A row is one Binance trade millisecond (the board's decision instant). A burst of trades is a burst of near-identical rows, so a per-trade
average over-counts bursts (measured 2026-10-07, fit days: a new 3 s high is followed by a higher price one second later on 69% of trades but on 60% of whole seconds). The
time-weighted view gives each row the time until the next row (capped at 1 s): it equals sampling the as-of price on a 1 ms grid, so a quiet second counts as much as a
busy one. The time-weighted view is the one the gates read; the per-trade view is shown beside it.

STANDARD ERRORS are clustered: every row of the same 10-second block shares one cluster (the sandwich estimator below), because forward returns of neighbouring rows overlap.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import lift_feat as LF

BLOCK_MS = 10_000
H_IDX = {h: i for i, h in enumerate(LF.HORIZONS_S)}
L_IDX = {l: i for i, l in enumerate(LF.LATENCIES_MS)}


# ============================================================================ the day cache
class Day:
    """One UTC day of decision instants: T (ms), W (seconds of dwell, capped at 1), F (features), G (group of each feature), Y [n, latencies, horizons] (bp), S (window state/outcome)."""

    def __init__(self, day: str, symbol: str = "BTCUSDT"):
        E = LF.load_day(day, symbol)
        idx, cnt = LF.instants(E)
        self.day, self.symbol, self.count, self.days_read = day, symbol, cnt, E["days_read"]
        self.n_trades = E["n_day_trades"]
        self.gaps = LF.gap_stats(E)
        self.n_events_table = len(E["ts"])
        self.T = E["ts"][idx]
        dwell = np.diff(E["ts"], append=E["ts"][-1] + 1000)
        self.W = (np.minimum(dwell[idx], 1000) / 1000.0).astype(np.float32)
        self.F, self.G = LF.features(E, idx)
        self.Y = LF.targets(E, idx)
        self.S = LF.state_and_outcome(E, idx)
        self.px = E["px"][idx].astype(np.float64)
        self.E, self.idx = E, idx                      # kept for the planted tests and the causality probe

    def drop_tape(self):
        self.E = None


def load_days(days, symbol="BTCUSDT", keep_tape=False):
    out = {}
    for d in days:
        out[d] = Day(d, symbol)
        if not keep_tape:
            out[d].drop_tape()
    return out


def stack(days: dict, which, keys=None):
    """Concatenate across days in order. which: 'T','W','Y', a feature name, or ('S', name)."""
    ds = list(days.values())
    if which in ("T", "W", "Y", "px"):
        return np.concatenate([getattr(d, which) for d in ds])
    if isinstance(which, tuple):
        return np.concatenate([d.S[which[1]] for d in ds])
    return np.concatenate([d.F[which] for d in ds])


def day_ids(days: dict):
    return np.concatenate([np.full(len(d.T), i) for i, d in enumerate(days.values())])


# ============================================================================ weighted, clustered statistics
def clip_edges(Y_fit, q=0.999):
    """Winsorising limits per (latency, horizon): the 99.9th percentile of |y| on the FIT days. A heavy-tailed return would otherwise decide a correlation alone."""
    return np.nanquantile(np.abs(Y_fit.reshape(len(Y_fit), -1)), q, axis=0).reshape(Y_fit.shape[1:])


def block_ids(T):
    """Dense cluster ids of the 10-second blocks of the stamps T (ms)."""
    return np.unique(T // BLOCK_MS, return_inverse=True)[1]


def wcorr(x, y, w, blk):
    """Weighted Pearson correlation and its cluster-robust standard error (sandwich over the blocks; `blk` = dense ids from `block_ids`). NaN rows are dropped."""
    m = np.isfinite(x) & np.isfinite(y)
    x, y, w, blk = x[m].astype(np.float64), y[m].astype(np.float64), w[m].astype(np.float64), blk[m]
    sw = w.sum()
    if sw <= 0 or len(x) < 50:
        return np.nan, np.nan, 0
    mx, my = (w * x).sum() / sw, (w * y).sum() / sw
    xc, yc = x - mx, y - my
    sxx, syy = (w * xc * xc).sum(), (w * yc * yc).sum()
    if sxx <= 0 or syy <= 0:
        return np.nan, np.nan, int(m.sum())
    den = np.sqrt(sxx * syy)
    rho = (w * xc * yc).sum() / den
    # influence of each row on rho, summed within a block
    u = w * (xc * yc - 0.5 * rho * (xc * xc * np.sqrt(syy / sxx) + yc * yc * np.sqrt(sxx / syy))) / den
    s = np.bincount(blk, weights=u)
    return float(rho), float(np.sqrt((s * s).sum())), int(m.sum())


def wmean_se(v, w, blk):
    """Weighted mean and its cluster-robust standard error (`blk` = dense ids from `block_ids`)."""
    m = np.isfinite(v)
    v, w, blk = v[m].astype(np.float64), w[m].astype(np.float64), blk[m]
    sw = w.sum()
    if sw <= 0:
        return np.nan, np.nan, 0
    mu = (w * v).sum() / sw
    s = np.bincount(blk, weights=w * (v - mu))
    return float(mu), float(np.sqrt((s * s).sum()) / sw), int(m.sum())


def wquantile_edges(x, w, nb=10):
    """Edges (nb - 1 inner cut points) of the weighted quantiles of x, unique."""
    m = np.isfinite(x)
    o = np.argsort(x[m], kind="stable")
    xs, ws = x[m][o], w[m][o].astype(np.float64)
    c = np.cumsum(ws)
    c /= c[-1]
    cuts = np.interp(np.arange(1, nb) / nb, c, xs)
    return np.unique(cuts)


def signed_edges(x, w, per_side=5):
    """Bin edges for a signed feature that piles up at zero: `per_side` equal-weight bins of the negative values, one bin for exactly zero (a flat stretch), `per_side` of the
    positive values, cut on the FIT days. -> edges (2 * (per_side - 1) + 2 of them) giving 2 * per_side + 1 bins."""
    x = np.asarray(x, np.float64)
    neg, pos = x < 0, x > 0
    q = np.arange(1, per_side) / per_side
    en = wquantile_edges_at(x[neg], w[neg], q) if neg.any() else np.array([])
    ep = wquantile_edges_at(x[pos], w[pos], q) if pos.any() else np.array([])
    return np.concatenate([en, [-1e-12, 1e-12], ep])


def wquantile_edges_at(x, w, q):
    o = np.argsort(x, kind="stable")
    xs, ws = x[o], np.asarray(w, np.float64)[o]
    c = np.cumsum(ws)
    c /= c[-1]
    return np.interp(q, c, xs)


def decile_means(x, y, w, edges):
    """Weighted mean of y in each bin of x (bins from `edges`), and the weight in each. NaN y rows dropped."""
    m = np.isfinite(x) & np.isfinite(y)
    b = np.searchsorted(edges, x[m], side="right")
    nb = len(edges) + 1
    sw = np.bincount(b, weights=w[m], minlength=nb)
    sy = np.bincount(b, weights=w[m] * y[m], minlength=nb)
    return np.where(sw > 0, sy / np.maximum(sw, 1e-12), np.nan), sw


def mono(means):
    """Spearman rank correlation of bin index with the bin means (1 = strictly rising)."""
    v = np.asarray(means, float)
    v = v[np.isfinite(v)]
    if len(v) < 3:
        return np.nan
    r = pd.Series(v).rank().to_numpy()
    return float(np.corrcoef(np.arange(len(v)), r)[0, 1])


# ============================================================================ the univariate scan
class Cohort:
    """A set of rows (days) prepared for many correlations at once: the targets Y (winsorised, one column per (latency, horizon)) centred under the weights, so one
    matrix product gives a feature's correlation with every target and the block sums of the influence give every standard error."""

    def __init__(self, days: dict, targets, clip, weighted=True):
        self.T = stack(days, "T")
        self.W = stack(days, "W").astype(np.float64) if weighted else np.ones(len(self.T))
        Y = stack(days, "Y")
        self.cols = [(L_IDX[L], H_IDX[h]) for (L, h) in targets]
        self.Y = np.stack([np.clip(Y[:, li, hi], -clip[li, hi], clip[li, hi]) for li, hi in self.cols], axis=1).astype(np.float64)
        self.Y[~np.isfinite(self.Y)] = 0.0
        self.sw = self.W.sum()
        self.my = (self.W[:, None] * self.Y).sum(0) / self.sw
        self.Yc = self.Y - self.my
        self.syy = (self.W[:, None] * self.Yc * self.Yc).sum(0)
        blk = block_ids(self.T)
        self.starts = np.concatenate([[0], np.flatnonzero(np.diff(blk) != 0) + 1])
        self.day = day_ids(days)
        self.dstarts = {k: None for k in np.unique(self.day)}

    def corr(self, x):
        """-> (rho[T], se[T]) of the feature x with each target, weighted, cluster-robust."""
        x = x.astype(np.float64)
        mx = (self.W * x).sum() / self.sw
        xc = x - mx
        sxx = (self.W * xc * xc).sum()
        if sxx <= 0:
            return np.full(self.Y.shape[1], np.nan), np.full(self.Y.shape[1], np.nan)
        wx = self.W * xc
        sxy = wx @ self.Yc
        den = np.sqrt(sxx * self.syy)
        rho = sxy / den
        a = np.sqrt(self.syy / sxx)
        b = np.sqrt(sxx / self.syy)
        U = (wx[:, None] * self.Yc - 0.5 * rho[None, :] * ((self.W * xc * xc)[:, None] * a[None, :] + self.W[:, None] * self.Yc * self.Yc * b[None, :])) / den[None, :]
        S = np.add.reduceat(U, self.starts, axis=0)
        return rho, np.sqrt((S * S).sum(0))

    def corr_by_day(self, x):
        out = []
        for k in sorted(self.dstarts):
            m = self.day == k
            sub = Cohort.__new__(Cohort)
            sub.W, sub.Y, sub.T = self.W[m], self.Y[m], self.T[m]
            sub.sw = sub.W.sum()
            sub.my = (sub.W[:, None] * sub.Y).sum(0) / sub.sw
            sub.Yc = sub.Y - sub.my
            sub.syy = (sub.W[:, None] * sub.Yc * sub.Yc).sum(0)
            sub.starts = np.concatenate([[0], np.flatnonzero(np.diff(block_ids(sub.T)) != 0) + 1])
            out.append(sub.corr(x[m])[0])
        return np.array(out)                              # [days, targets]

    def bins(self, x, edges):
        """Weighted mean of each target in each bin of x -> [bins, targets], and the weight per bin."""
        b = np.searchsorted(edges, x, side="right")
        nb = len(edges) + 1
        sw = np.bincount(b, weights=self.W, minlength=nb)
        out = np.empty((nb, self.Y.shape[1]))
        for j in range(self.Y.shape[1]):
            out[:, j] = np.bincount(b, weights=self.W * self.Y[:, j], minlength=nb) / np.maximum(sw, 1e-12)
        return out, sw

    def edge(self, x, mask=None):
        """The trade 'go the way the feature points': per target the weighted mean of sign(x) * y in bp over rows with x != 0, its cluster standard error, and the weighted
        win share among rows that moved, ties out (win / (win + lose); a row with no price change is neither) -> (edge[T], se[T], win[T])."""
        sx = np.sign(x).astype(np.float64)
        act = (sx != 0) if mask is None else ((sx != 0) & mask)
        w = self.W * act
        sw = w.sum()
        if sw <= 0:
            nan = np.full(self.Y.shape[1], np.nan)
            return nan, nan, nan
        g = sx[:, None] * self.Y
        mu = (w[:, None] * g).sum(0) / sw
        S = np.add.reduceat(w[:, None] * (g - mu), self.starts, axis=0)
        win = (w[:, None] * (g > 0)).sum(0)
        lose = (w[:, None] * (g < 0)).sum(0)
        hit = np.where(win + lose > 0, win / np.maximum(win + lose, 1e-12), np.nan)
        return mu, np.sqrt((S * S).sum(0)) / sw, hit


def scan(fit: dict, other: dict, feats, targets, clip):
    """For every feature and target (L ms, h s): the FIT days' time-weighted correlation, and on `other` (validation or test days) the time-weighted and per-trade correlation,
    the direction accuracy, the decile spread with the FIT edges, its monotonicity and the number of days whose correlation has the FIT sign.
    -> DataFrame (one row per feature, latency, horizon), and the FIT decile edges per feature."""
    cf = Cohort(fit, targets, clip)
    co = Cohort(other, targets, clip)
    cu = Cohort(other, targets, clip, weighted=False)
    rows, edges_all = [], {}
    for f in feats:
        xf = stack(fit, f)
        xo = stack(other, f)
        edges = wquantile_edges(xf.astype(np.float64), cf.W)
        edges_all[f] = edges
        rf, sef = cf.corr(xf)
        ro, seo = co.corr(xo)
        ru, _ = cu.corr(xo)
        ed, ese, hit = co.edge(xo)
        dm, _ = co.bins(xo.astype(np.float64), edges)
        dmf, _ = cf.bins(xf.astype(np.float64), edges)
        pdv = co.corr_by_day(xo)
        for j, (L, h) in enumerate(targets):
            rows.append(dict(feature=f, L_ms=L, h_s=h, rho_fit=rf[j], t_fit=rf[j] / sef[j] if sef[j] else np.nan, rho=ro[j], se=seo[j], t=ro[j] / seo[j] if seo[j] else np.nan,
                             rho_pertrade=ru[j], edge_bp=ed[j], edge_t=ed[j] / ese[j] if ese[j] else np.nan, win_share=hit[j], spread_bp=(dm[-1, j] - dm[0, j]) if len(dm) > 1 else np.nan, mono=mono(dm[:, j]), mono_fit=mono(dmf[:, j]),
                             days_same_sign=int(np.sum(np.sign(pdv[:, j]) == np.sign(rf[j]))), n_days=pdv.shape[0], per_day=list(pdv[:, j])))
    return pd.DataFrame(rows), edges_all


# ============================================================================ conditional curves
def curve_rows(coh: Cohort, x, edges_abs, mask=None, labels=None):
    """The continuation edge after a move of size |x| in each bucket of `edges_abs` ((lo, hi) pairs): trade WITH the sign of x. One row per bucket and target:
    mean of sign(x) * y in bp, its cluster standard error, the win share among rows that moved, and the time-weight in the bucket (seconds)."""
    ax = np.abs(x)
    rows = []
    for k, (lo, hi) in enumerate(edges_abs):
        m = (ax >= lo) & (ax < hi)
        if mask is not None:
            m = m & mask
        ed, se, hit = coh.edge(x, m)
        wsec = float((coh.W * m).sum())
        for j, (li, hi_) in enumerate(coh.cols):
            rows.append(dict(bucket=labels[k] if labels else f"{lo:g}-{hi:g}", lo=lo, hi=hi, L_ms=LF.LATENCIES_MS[li], h_s=LF.HORIZONS_S[hi_], edge_bp=ed[j], se=se[j],
                             t=ed[j] / se[j] if se[j] else np.nan, win_share=hit[j], seconds=wsec))
    return pd.DataFrame(rows)


def all_targets():
    return [(L, h) for L in LF.LATENCIES_MS for h in LF.HORIZONS_S]


def lat_table(coh: Cohort, x, mask=None):
    """Signal x observed at t, traded at t + L, held h: the edge in bp for every (L, h). -> DataFrame with edge, se, t, hit."""
    ed, se, hit = coh.edge(x, mask)
    rows = [dict(L_ms=LF.LATENCIES_MS[li], h_s=LF.HORIZONS_S[hi], edge_bp=ed[j], se=se[j], t=ed[j] / se[j] if se[j] else np.nan, win_share=hit[j]) for j, (li, hi) in enumerate(coh.cols)]
    return pd.DataFrame(rows)
