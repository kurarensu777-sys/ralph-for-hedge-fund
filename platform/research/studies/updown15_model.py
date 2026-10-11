"""Pure model code for the 15-minute Up/Down study (B-0642). numpy and scipy only, no I/O.

Every function takes arrays and returns arrays. Nothing here reads a clock, a file or a venue.
Features are built from rows whose time is <= the decision time t; `asof_idx` is the one place
that rule lives, and the leak planted test in the notebook re-runs it with the rule broken.
"""
from __future__ import annotations

import numpy as np
from scipy.optimize import isotonic_regression
from scipy.special import expit, logit
from scipy.stats import norm

EPS = 1e-6


def asof_idx(ts: np.ndarray, t: np.ndarray, shift_ms: int = 0) -> np.ndarray:
    """Index of the last row with ts <= t + shift_ms; -1 when none. `ts` ascending.
    shift_ms = 0 is the only honest value; the notebook's planted tests move it."""
    return np.searchsorted(ts, np.asarray(t, dtype=np.int64) + int(shift_ms), side="right") - 1


# ---------------------------------------------------------------- the fair value (a), the owner's form
def brownian_p(s_now, s_ref, sigma, t_left):
    """P(Up) = Phi(ln(S_now / S_ref) / (sigma * sqrt(T_left))): driftless, sigma per sqrt(second), T_left seconds."""
    d = np.log(np.asarray(s_now, float) / np.asarray(s_ref, float))
    sd = np.asarray(sigma, float) * np.sqrt(np.maximum(np.asarray(t_left, float), 1.0))
    return norm.cdf(d / np.maximum(sd, 1e-12))


def twap_p(s_now, a_start, sigma, t_left, known_sum, lookback=60.0):
    """Driftless fair value when the market settles on a `lookback`-second TWAP of the end (the venue's
    own rule for these markets, [1] cryptoMarketConfig.twapLookbackSeconds = 60): A_end is the mean price over the last
    `lookback` seconds. `known_sum` is the sum of 1 Hz prices already inside that averaging window at t
    (0 before it opens). With u seconds of the average already known and T seconds left, the unknown
    part adds T * S_now to the sum and ln-variance sigma^2 T^3 / 3 / lookback^2 (integrated Brownian path).
    Before the window opens the average is the mean of a path that starts `T - lookback` ahead:
    variance sigma^2 ((T - L) + L / 3)."""
    s_now = np.asarray(s_now, float)
    T = np.maximum(np.asarray(t_left, float), 0.0)
    L = float(lookback)
    inside = T < L
    # not yet inside the averaging window
    var_out = (np.asarray(sigma, float) ** 2) * (np.maximum(T - L, 0.0) + L / 3.0)
    mean_out = s_now
    # inside: known part plus the future part
    known = np.where(inside, known_sum, 0.0)
    mean_in = (known + T * s_now) / L
    # price variance of A_end is S^2 sigma^2 T^3 / (3 L^2); divide by mean^2 for ln units
    var_in = (np.asarray(sigma, float) ** 2) * T ** 3 / (3.0 * L * L) * (s_now / np.maximum(mean_in, 1e-12)) ** 2
    mean = np.where(inside, mean_in, mean_out)
    var = np.where(inside, var_in, var_out)
    z = np.log(mean / np.asarray(a_start, float)) / np.sqrt(np.maximum(var, 1e-16))
    return norm.cdf(z)


# ---------------------------------------------------------------- volatility (b)
def ewma_var(r: np.ndarray, halflife_s: float, init_var: float | None = None) -> np.ndarray:
    """EWMA of squared per-second log returns, causal: out[i] uses r[:i+1]. lam = 0.5 ** (1 / halflife)."""
    lam = 0.5 ** (1.0 / halflife_s)
    out = np.empty(len(r))
    v = float(np.mean(r[: min(len(r), 600)] ** 2)) if init_var is None else init_var
    r2 = np.asarray(r, float) ** 2
    for i in range(len(r)):
        v = lam * v + (1 - lam) * r2[i]
        out[i] = v
    return out


def ewma_var_fast(r: np.ndarray, halflife_s: float, init_var: float) -> np.ndarray:
    """Same recursion through scipy.signal.lfilter (one pass in C): y[i] = lam y[i-1] + (1 - lam) r2[i]."""
    from scipy.signal import lfilter
    lam = 0.5 ** (1.0 / halflife_s)
    r2 = np.asarray(r, float) ** 2
    y, _ = lfilter([1 - lam], [1, -lam], r2, zi=[lam * init_var])
    return y


def har_design(rv_5m, rv_1h, rv_1d):
    return np.column_stack([np.ones(len(rv_5m)), rv_5m, rv_1h, rv_1d])


def har_fit(rv_target, rv_5m, rv_1h, rv_1d):
    """OLS of the next-interval realised variance on its own 5-minute, 1-hour and 1-day averages (Corsi 2009).
    Returns beta; a negative forecast is floored by the caller."""
    X = har_design(rv_5m, rv_1h, rv_1d)
    beta, *_ = np.linalg.lstsq(X, np.asarray(rv_target, float), rcond=None)
    return beta


def har_predict(beta, rv_5m, rv_1h, rv_1d, floor):
    return np.maximum(har_design(rv_5m, rv_1h, rv_1d) @ beta, floor)


def seasonal_profile(r2: np.ndarray, minute_of_day: np.ndarray) -> np.ndarray:
    """Mean squared 1 s return by minute of the UTC day (1440 values), from the rows given (training days only)."""
    prof = np.full(1440, np.nan)
    sums = np.bincount(minute_of_day, weights=r2, minlength=1440)
    cnt = np.bincount(minute_of_day, minlength=1440)
    ok = cnt > 0
    prof[ok] = sums[ok] / cnt[ok]
    # smooth over +/- 15 minutes, circular, so a thin minute does not set the volatility
    k = 31
    pad = np.concatenate([prof[-(k // 2):], prof, prof[: k // 2]])
    sm = np.convolve(np.nan_to_num(pad, nan=np.nanmean(prof)), np.ones(k) / k, mode="valid")
    return sm


# ---------------------------------------------------------------- logistic regression (c)
def fit_logit(X: np.ndarray, y: np.ndarray, l2: float = 1.0, iters: int = 50, w: np.ndarray | None = None):
    """Ridge-penalised logistic regression by IRLS. Returns (mu, sd, beta): features are standardised with
    the TRAINING rows' mean and sd (never the full sample), beta[0] is the intercept on the standardised scale."""
    mu = X.mean(axis=0)
    sd = X.std(axis=0)
    sd[sd < 1e-12] = 1.0
    Z = np.column_stack([np.ones(len(X)), (X - mu) / sd])
    y = np.asarray(y, float)
    wt = np.ones(len(y)) if w is None else np.asarray(w, float)
    b = np.zeros(Z.shape[1])
    P = np.eye(Z.shape[1]) * l2
    P[0, 0] = 0.0
    for _ in range(iters):
        p = expit(Z @ b)
        g = Z.T @ (wt * (y - p)) - P @ b
        h = (Z * (wt * p * (1 - p))[:, None]).T @ Z + P + 1e-9 * np.eye(Z.shape[1])
        step = np.linalg.solve(h, g)
        b = b + step
        if np.max(np.abs(step)) < 1e-7:
            break
    return mu, sd, b


def predict_logit(model, X: np.ndarray) -> np.ndarray:
    mu, sd, b = model
    return expit(np.column_stack([np.ones(len(X)), (X - mu) / sd]) @ b)


# ---------------------------------------------------------------- calibration
def fit_platt(p: np.ndarray, y: np.ndarray):
    """Platt scaling: y ~ sigmoid(a * logit(p) + b), fitted on the rows given (the earlier window only)."""
    x = logit(np.clip(p, EPS, 1 - EPS))
    mu, sd, b = fit_logit(x[:, None], y, l2=1e-6)
    # fold the standardisation back so the map is a, c on the raw logit
    a = b[1] / sd[0]
    c = b[0] - b[1] * mu[0] / sd[0]
    return a, c


def apply_platt(cal, p: np.ndarray) -> np.ndarray:
    a, c = cal
    return expit(a * logit(np.clip(p, EPS, 1 - EPS)) + c)


def fit_isotonic(p: np.ndarray, y: np.ndarray, nbin: int = 200):
    """Isotonic calibration on `nbin` equal-count bins of p (monotone map, scipy's pool-adjacent-violators)."""
    order = np.argsort(p)
    ps, ys = np.asarray(p)[order], np.asarray(y, float)[order]
    edges = np.linspace(0, len(ps), nbin + 1).astype(int)
    xs = np.array([ps[a:b].mean() for a, b in zip(edges[:-1], edges[1:]) if b > a])
    ym = np.array([ys[a:b].mean() for a, b in zip(edges[:-1], edges[1:]) if b > a])
    wt = np.array([b - a for a, b in zip(edges[:-1], edges[1:]) if b > a], float)
    iso = isotonic_regression(ym, weights=wt, increasing=True).x
    return xs, iso


def apply_isotonic(cal, p: np.ndarray) -> np.ndarray:
    xs, iso = cal
    return np.clip(np.interp(p, xs, iso), EPS, 1 - EPS)


# ---------------------------------------------------------------- scoring
def log_loss(p: np.ndarray, y: np.ndarray) -> float:
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    y = np.asarray(y, float)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((np.asarray(p, float) - np.asarray(y, float)) ** 2))


def calibration_bins(p: np.ndarray, y: np.ndarray, edges=None):
    """-> (mean p, observed rate, n) per bin; the curve and its sample sizes."""
    edges = np.linspace(0, 1, 11) if edges is None else np.asarray(edges)
    idx = np.clip(np.digitize(p, edges) - 1, 0, len(edges) - 2)
    mp, fy, n = [], [], []
    for k in range(len(edges) - 1):
        m = idx == k
        n.append(int(m.sum()))
        mp.append(float(np.mean(p[m])) if m.any() else np.nan)
        fy.append(float(np.mean(y[m])) if m.any() else np.nan)
    return np.array(mp), np.array(fy), np.array(n)


def wilson(k: int, n: int, z: float = 1.96):
    """Wilson score interval for a share k / n."""
    if n <= 0:
        return (np.nan, np.nan)
    ph = k / n
    den = 1 + z * z / n
    c = (ph + z * z / (2 * n)) / den
    h = z * np.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / den
    return (float(c - h), float(c + h))


def cluster_block_ci(values: np.ndarray, clusters: np.ndarray, reps: int = 2000, seed: int = 7, q=(5, 95)):
    """Cluster bootstrap of a sum: resample whole clusters (days, or windows) with replacement."""
    rng = np.random.default_rng(seed)
    u, inv = np.unique(clusters, return_inverse=True)
    tot = np.bincount(inv, weights=values, minlength=len(u))
    draws = rng.integers(0, len(u), size=(reps, len(u)))
    sums = tot[draws].sum(axis=1)
    return float(np.percentile(sums, q[0])), float(np.percentile(sums, q[1]))
