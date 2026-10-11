"""Fair values for the strategy search (B-0654). numpy and scipy only, no I/O; every input is a column of the decision table.

    pu_twap(...)     the Brownian P(Up) of the Chainlink 60 s TWAP rule, with (a) a reference that is the venue's published price to beat or our own
                     Binance TWAP of the start, (b) a constant Binance-to-Chainlink basis, (c) a multiplier on the volatility, (d) a variance floor for the
                     basis noise that remains when the averaging window is nearly closed.
    Calibration      an isotonic map of logit(p) fitted on TRAIN instants only (`fit_iso` / `apply_iso`).
The formula is `updown15_model.twap_p` with one extra variance term; with sb = 0, kappa = 1 and the own reference it equals it to the last digit (tested).
"""
from __future__ import annotations

import numpy as np
from scipy.stats import norm

import updown15_model as M

TWAP_S = 60.0


def pu_twap(S, known, sig, T, a_ref, basis=0.0, kappa=1.0, sb=0.0):
    """P(Up). S: the Binance mid now; known: sum of the 1 Hz prices already inside the final 60 s average; sig: per sqrt(second) volatility; T: seconds left;
    a_ref: the start reference. `basis` is ln(Binance / Chainlink) removed from every Binance price (a constant, fitted on train windows); `kappa` scales sigma;
    `sb` is the standard deviation of the leftover basis noise in log units, added to the variance of the end average."""
    f = np.exp(-basis)
    S = np.asarray(S, float) * f
    known = np.asarray(known, float) * f
    sig = np.asarray(sig, float) * kappa
    T = np.maximum(np.asarray(T, float), 0.0)
    L = TWAP_S
    inside = T < L
    var_out = sig ** 2 * (np.maximum(T - L, 0.0) + L / 3.0)
    mean_in = (np.where(inside, known, 0.0) + T * S) / L
    var_in = sig ** 2 * T ** 3 / (3.0 * L * L) * (S / np.maximum(mean_in, 1e-12)) ** 2
    mean = np.where(inside, mean_in, S)
    var = np.where(inside, var_in, var_out) + sb ** 2
    z = np.log(mean / np.asarray(a_ref, float)) / np.sqrt(np.maximum(var, 1e-16))
    return norm.cdf(z)


def fit_iso(p, y, nbin=100):
    """Isotonic calibration on equal-count bins of p (M.fit_isotonic); the returned map is (xs, ys)."""
    return M.fit_isotonic(np.asarray(p, float), np.asarray(y, float), nbin=nbin)


def apply_iso(cal, p):
    return M.apply_isotonic(cal, np.asarray(p, float))


def selftest() -> bool:
    ok = True
    rng = np.random.default_rng(3)
    n = 500
    S = 100 * np.exp(rng.normal(0, 0.001, n))
    a0 = np.full(n, 100.0)
    sig = np.full(n, 1e-4)
    T = rng.uniform(1, 899, n)
    known = np.where(T < 60, (60 - T) * S, 0.0)
    ref = M.twap_p(S, a0, sig, T, known, 60.0)
    mine = pu_twap(S, known, sig, T, a0)
    c1 = float(np.max(np.abs(ref - mine))) < 1e-12
    print(f"  {'ok  ' if c1 else 'FAIL'} equals updown15_model.twap_p with the extras off (max diff {np.max(np.abs(ref - mine)):.1e})")
    ok &= c1
    a = lambda x: np.array([float(x)])      # noqa: E731
    kn = a(58 * 100.01)                   # 58 s of the final average already known, all at +1 bp
    far = pu_twap(a(100.01), kn, a(1e-4), a(2.0), a(100.0))[0]
    flo = pu_twap(a(100.01), kn, a(1e-4), a(2.0), a(100.0), sb=1e-4)[0]
    c2 = flo < far - 0.1 and 0.5 < flo < 0.9
    print(f"  {'ok  ' if c2 else 'FAIL'} basis noise keeps a 1 bp lead at 2 s left below certainty (p {flo:.3f}; without it {far:.3f})")
    ok &= c2
    return bool(ok)


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
