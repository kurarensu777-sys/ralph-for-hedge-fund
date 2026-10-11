"""Planted tests and the causality probe for the probability-lifting study (B-0649). Every check here can fail: `selftest()` plants each fault once and requires the detector to see it.

    causality_probe(E, idx, n)   features recomputed from a tape CUT at the instant equal the full run's (to float32 round-off), and a planted future read is not equal
    shift_dose(...)              the edge of a signal read k instants stale or ahead: stale shifts must not gain, future shifts must grow with k
    shuffle_test(...)            the signal against outcomes permuted in 10-second blocks: no edge left
    leak_flag(...)               a feature that IS the future return makes the harness cry out
"""
from __future__ import annotations

import numpy as np

import lift_feat as LF
import lift_stats as ST


def cut_tape(E: dict, i: int) -> dict:
    """The event table with every row after row i removed: what a trader had at the instant of row i."""
    keys = ("ts", "px", "q", "sq", "n")
    C = {k: E[k][: i + 1] for k in keys}
    C.update(day0=E["day0"], day1=E["day1"], n_trades=E["n_trades"])
    return C


def _close(a, b):
    """Equal to float32 round-off: the slope and R-squared columns are matrix products whose last bits depend on the batch size (1e-7 relative), nothing else differs."""
    return bool(np.allclose(a, b, rtol=1e-4, atol=1e-5, equal_nan=True))


def causality_probe(E: dict, idx: np.ndarray, n: int = 40, seed: int = 11, shift: int = -40):
    """Pick n instants. For each, the features from the tape cut at that instant must equal the full run's values exactly (to round-off), and the same
    probe on a PLANTED future read (features built with shift = -40 instants, i.e. reading 40 rows ahead) must NOT equal the cut-tape values.
    -> dict(n, equal, planted_caught, bad)."""
    rng = np.random.default_rng(seed)
    pick = np.sort(rng.choice(np.arange(len(idx) // 10, len(idx) - len(idx) // 10), size=n, replace=False))
    F_full, _ = LF.features(E, idx[pick])
    F_plant, _ = LF.features(E, idx[pick], shift=shift)
    eq = caught = 0
    bad = []
    for k, p in enumerate(pick):
        i = int(idx[p])
        C = cut_tape(E, i)
        Fc, _ = LF.features(C, np.array([i]))
        same = all(_close(Fc[name][0], F_full[name][k]) for name in Fc)
        eq += int(same)
        if not same:
            bad.append(i)
        diff_plant = any(not _close(Fc[name][0], F_plant[name][k]) for name in Fc)
        caught += int(diff_plant)
    return dict(n=int(n), equal=int(eq), planted_caught=int(caught), bad=bad[:5])


def shift_dose(day, name, mask_fn, ks=(400, 40, 0, -40, -400), L=150, h=5.0, clip=None):
    """The sign-x edge (bp) of feature `name` rebuilt with the table read k instants stale (k > 0) or ahead (k < 0). `day` is a Day built with keep_tape=True.
    Stale reads must not gain over k = 0; future reads must grow as k goes more negative."""
    out = []
    li, hi = ST.L_IDX[L], ST.H_IDX[h]
    y = day.Y[:, li, hi].astype(np.float64)
    if clip is not None:
        y = np.clip(y, -clip, clip)
    for k in ks:
        F, _ = LF.features(day.E, day.idx, shift=k)
        x = F[name]
        m = mask_fn(F)
        w = day.W.astype(np.float64) * m * (x != 0)
        g = np.sign(x) * y
        mu = float((w * g).sum() / max(w.sum(), 1e-9))
        out.append(dict(k=k, edge_bp=mu))
    return out


def shuffle_test(x, mask, Y_col, W, reps=200, seed=5):
    """The outcome series rolled by a random lag of 10% to 90% of the sample (every path intact, every alignment with the signal destroyed) and the sign-x edge
    recomputed. -> dict(real, null_mean, null_sd, z, p) with p = (1 + rolls at or above the real edge) / (rolls + 1)."""
    rng = np.random.default_rng(seed)
    sx = np.sign(x)
    w = W * ((sx != 0) & mask)
    n = len(Y_col)

    def edge(Y):
        return float((w * sx * Y).sum() / max(w.sum(), 1e-9))
    real = edge(Y_col)
    null = np.array([edge(np.roll(Y_col, int(rng.integers(n // 10, n - n // 10)))) for _ in range(reps)])
    return dict(real=real, null_mean=float(null.mean()), null_sd=float(null.std()), z=float((real - null.mean()) / max(null.std(), 1e-12)), p=float((1 + (null >= real).sum()) / (reps + 1)), reps=int(reps))


def leak_flag(x, y, w, thresh=0.5):
    """A feature that correlates with the outcome above `thresh` is a leak: the harness reports it. -> (flagged, rho)."""
    xm, ym = np.average(x, weights=w), np.average(y, weights=w)
    rho = np.average((x - xm) * (y - ym), weights=w) / np.sqrt(np.average((x - xm) ** 2, weights=w) * np.average((y - ym) ** 2, weights=w))
    return bool(abs(rho) > thresh), float(rho)


def selftest() -> bool:
    """Plant each fault once; the detector must catch it."""
    ok = True
    rng = np.random.default_rng(1)
    n = 20000
    y = rng.standard_normal(n)
    w = np.ones(n)
    x_leak = y + 0.1 * rng.standard_normal(n)
    flagged, _ = leak_flag(x_leak, y, w)
    ok &= flagged                                      # a planted leak is flagged
    flagged, _ = leak_flag(rng.standard_normal(n), y, w)
    ok &= not flagged                                  # an honest random feature is not
    # a planted edge shows up against the shuffle null, an absent edge does not
    x = np.sign(y + 0.3 * rng.standard_normal(n))
    r = shuffle_test(x, np.ones(n, bool), y, w, reps=60)
    ok &= r["z"] > 5
    r0 = shuffle_test(np.sign(rng.standard_normal(n)), np.ones(n, bool), y, w, reps=60)
    ok &= abs(r0["z"]) < 3.5
    return bool(ok)
