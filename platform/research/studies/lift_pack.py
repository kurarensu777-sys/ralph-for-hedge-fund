"""The signal pack of the probability-lifting study (B-0649): the strongest simple signal of the investigation as ONE small, vectorised function over a Binance trade tape.

    events(ts, px)                    one row per distinct trade millisecond (the last price of the millisecond)
    z_one_second(ts, px)              H1: z = ln(p_t / p_(t-1 s)) / s, s the standard deviation of one-second log returns over the 540 s ending 60 s before t
    triggers(ts, z, z0, gap_ms)       the first row of each episode with |z| >= z0 and its side (+1 buy the rise, -1 buy the fall)
    Pack(z0, gap_ms).run(ts, px)      everything above in one call -> dict

Every value stamped t reads trades at or before t and nothing else; `check_against_features` holds it equal to the investigation's feature engine on a day (the notebook
runs it), so the pack and the study cannot drift apart. numpy only, no I/O, no venue: it takes arrays.
"""
from __future__ import annotations

import numpy as np

import lift_feat as LF


def events(ts: np.ndarray, px: np.ndarray):
    """The last trade of each distinct millisecond. ts must be non-decreasing."""
    last = np.concatenate([np.flatnonzero(np.diff(ts) != 0), [len(ts) - 1]])
    return ts[last], px[last]


def z_one_second(ts: np.ndarray, px: np.ndarray) -> np.ndarray:
    """H1's z at every event: the last second's log return over the slow per-second volatility (floored at 1e-6, as in the feature engine)."""
    lp = np.log(px)
    i1 = LF.asof(ts, ts - 1000)
    ret = lp - lp[np.maximum(i1, 0)]
    E = dict(ts=ts, px=px)
    sig = np.maximum(LF.second_grid_vol(E)(ts), 1e-6)
    z = ret / sig
    z[i1 < 0] = 0.0
    return z


def triggers(ts: np.ndarray, z: np.ndarray, z0: float = 1.0, gap_ms: int = 5000):
    """Indices of the first row of each episode (rows with |z| >= z0 of one sign, each closer than gap_ms to the one before) and the side of each."""
    act = np.flatnonzero(np.abs(z) >= z0)
    if len(act) == 0:
        return act, np.zeros(0)
    t, s = ts[act], np.sign(z[act])
    new = np.ones(len(act), bool)
    new[1:] = ((t[1:] - t[:-1]) >= gap_ms) | (s[1:] != s[:-1])
    return act[new], s[new]


class Pack:
    """H1 momentum pack: z0 volatilities in the last second, episodes closer than gap_ms are one."""

    def __init__(self, z0: float = 1.0, gap_ms: int = 5000):
        self.z0, self.gap_ms = z0, gap_ms

    def run(self, ts_raw: np.ndarray, px_raw: np.ndarray) -> dict:
        ts, px = events(ts_raw, px_raw)
        z = z_one_second(ts, px)
        idx, side = triggers(ts, z, self.z0, self.gap_ms)
        return dict(ts=ts, px=px, z=z, trig_idx=idx, trig_ts=ts[idx], trig_side=side, trig_z=z[idx])


def check_against_features(day) -> dict:
    """The pack's z equals the feature engine's z_1s at every instant of a Day (built by lift_stats), to float32 round-off. -> dict(rows, max_abs_diff, equal)."""
    E = day.E
    z = z_one_second(E["ts"], E["px"])[day.idx]
    ref = day.F["z_1s"]
    d = np.abs(z.astype(np.float32) - ref)
    return dict(rows=int(len(ref)), max_abs_diff=float(d.max()), equal=bool(np.allclose(z.astype(np.float32), ref, rtol=1e-4, atol=1e-5)))
