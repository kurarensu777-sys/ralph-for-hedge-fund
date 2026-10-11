"""The protocol of the probability-lifting study (B-0649), frozen before the TEST days are read.

WHAT WAS LOOKED AT BEFORE THIS FILE: the three FIT days (09-30 to 10-02) were scanned feature by feature, and the first scan printed the two validation days beside them, so
the validation days are NOT clean for choosing; they are used to check that a rule fixed on the fit days holds elsewhere. The TEST days (10-05, 10-06) were not read for
any return, feature statistic or outcome. Everything below is fixed from the fit-day scan and the design; the test days confirm or refute it once.

The confirmatory family is six named hypotheses with a fixed direction and fixed horizons; everything else in the study is exploratory and says so.
"""
from __future__ import annotations

import numpy as np

import lift_stats as ST

FIT_DAYS = ("2026-09-30", "2026-10-01", "2026-10-02")
VAL_DAYS = ("2026-10-03", "2026-10-04")
TEST_DAYS = ("2026-10-05", "2026-10-06")
ALL_DAYS = FIT_DAYS + VAL_DAYS + TEST_DAYS
SYMBOL = "BTCUSDT"

LAT_BAR_MS = 150                     # the venue's taker delay, venue changelog 2026-09-04 [1]
CONFIRM_H = (1.0, 5.0, 10.0)         # the confirmatory horizons (s)
T_BAR = 3.0                          # cluster t-statistic a confirmatory edge must reach, in the pre-registered direction
EPISODE_GAP_MS = 5_000               # rows of one signal and sign closer than this are one episode
PURGE_S = 70                         # rows this close to a split boundary are dropped from the earlier side (longest latency + horizon + 9 s)

# H name -> (label, feature, gate, direction). direction +1: trade WITH the sign of the feature; -1: AGAINST it.
#   gate "abs>=a": |feature| >= a;  "nonzero";  "abs==a";  "q80": |feature| at or above the FIT 80th percentile of |feature|
FAMILY = {
    "H1": dict(label="Short-term momentum", feature="z_1s", gate=("abs>=", 1.0), direction=+1, text="the last second moved by at least one second-volatility: it goes on"),
    "H2": dict(label="Momentum acceleration", feature="slopediff_5_30", gate=("q80", None), direction=+1, text="the 5 s slope is far above the 30 s slope: it goes on"),
    "H3": dict(label="Breakout continuation", feature="breakout_z_10s", gate=("nonzero", None), direction=+1, text="price breaks the high or low of the last 10 s: it goes on"),
    "H4": dict(label="Extreme-move reversal", feature="z_1s", gate=("abs>=", 4.0), direction=-1, text="a move of four second-volatilities in a second is followed by the opposite"),
    "H5": dict(label="Multi-horizon confirmation", feature="agree_4", gate=("abs==", 4.0), direction=+1, text="the 1, 3, 5 and 10 s returns all point one way: it goes on"),
    "H6": dict(label="Volatility-conditioned momentum", feature="z_1s", gate=("abs>=", 1.0), direction=+1, text="H1 holds in each volatility tercile (low, middle, high)"),
}
# the strongest-signal rule: among H1, H2, H3, H5 confirmed on the validation days (t >= T_BAR at 150 ms for every confirmatory horizon, positive on each validation day),
# the one with the largest mean edge at (150 ms, 5 s) on the validation days. Ties impossible to break by t: the larger edge decides.
PACK_CANDIDATES = ("H1", "H2", "H3", "H5")

RIDGE_LAMBDAS = (1e-4, 1e-2, 1.0)    # chosen on the validation days
GBM_DEPTHS = (2, 3)
GBM_ROUNDS = 40
MODEL_H = (1.0, 5.0, 10.0, 30.0)     # model targets (s), traded 150 ms after the instant


def thresholds(fit: dict) -> dict:
    """Everything a gate needs that is a quantile, from the FIT days only."""
    out = {}
    for h, spec in FAMILY.items():
        if spec["gate"][0] == "q80":
            out[h] = float(np.quantile(np.abs(ST.stack(fit, spec["feature"])), 0.8))
    sig = ST.stack(fit, "sigma_slow")
    out["vol_edges"] = [float(v) for v in np.quantile(sig, [1 / 3, 2 / 3])]
    return out


def masks(days: dict, th: dict) -> dict:
    """For each hypothesis: (x, gate mask) on `days`, where x is the signed signal (direction applied) the trade follows. H6 gives three entries, by volatility tercile."""
    out = {}
    sig = ST.stack(days, "sigma_slow")
    for h, spec in FAMILY.items():
        x = ST.stack(days, spec["feature"]).astype(np.float64)
        kind, a = spec["gate"]
        m = {"abs>=": lambda: np.abs(x) >= a, "nonzero": lambda: x != 0, "abs==": lambda: np.abs(x) == a, "q80": lambda: np.abs(x) >= th[h]}[kind]()
        xs = spec["direction"] * x
        if h == "H6":
            e = th["vol_edges"]
            out["H6 low vol"] = (xs, m & (sig < e[0]))
            out["H6 mid vol"] = (xs, m & (sig >= e[0]) & (sig < e[1]))
            out["H6 high vol"] = (xs, m & (sig >= e[1]))
        else:
            out[h] = (xs, m)
    return out


def family_table(days: dict, clip, th: dict, horizons=CONFIRM_H, lat=LAT_BAR_MS):
    """The confirmatory family on `days`: per hypothesis and horizon the edge in bp at `lat` ms, its cluster standard error and t, the win share ex ties, the time-weight in
    the gate (seconds) and the edge on each day."""
    import pandas as pd
    tg = [(lat, h) for h in horizons]
    coh = ST.Cohort(days, tg, clip)
    M = masks(days, th)
    rows = []
    for name, (x, m) in M.items():
        ed, se, win = coh.edge(x, m)
        per_day = []
        for k in sorted(set(coh.day)):
            sel = coh.day == k
            sub = _sub(coh, sel)
            e_k, _, _ = sub.edge(x[sel], m[sel])
            per_day.append(e_k)
        for j, h in enumerate(horizons):
            rows.append(dict(hyp=name, h_s=h, L_ms=lat, edge_bp=ed[j], se=se[j], t=ed[j] / se[j] if se[j] else np.nan, win_share=win[j],
                             seconds=float((coh.W * (m & (x != 0))).sum()), per_day=[float(p[j]) for p in per_day]))
    return pd.DataFrame(rows)


def _sub(coh, sel):
    s = ST.Cohort.__new__(ST.Cohort)
    s.W, s.Y, s.T, s.cols = coh.W[sel], coh.Y[sel], coh.T[sel], coh.cols
    s.sw = s.W.sum()
    s.starts = np.concatenate([[0], np.flatnonzero(np.diff(ST.block_ids(s.T)) != 0) + 1])
    return s


# ============================================================================ the decision rules, written before the validation or test days were scored
def _ok(df) -> bool:
    """A hypothesis row set holds when the edge has t >= T_BAR at every confirmatory horizon and is positive on every day that had gate rows."""
    if not (df.t >= T_BAR).all():
        return False
    return all(all((np.isnan(p) or p > 0) for p in pd_) for pd_ in df.per_day)


def decide(fam_val, fam_test) -> dict:
    """hypothesis -> 'CONFIRMED' (the rule holds on the validation days AND on the test days), 'REJECTED, MOVES THE OTHER WAY' (t <= -T_BAR at every horizon on the test days),
    else 'NOT CONFIRMED'."""
    out = {}
    for hyp in fam_val.hyp.unique():
        v = fam_val[fam_val.hyp == hyp].sort_values("h_s")
        t = fam_test[fam_test.hyp == hyp].sort_values("h_s")
        if _ok(v) and _ok(t):
            out[hyp] = "CONFIRMED"
        elif (t.t <= -T_BAR).all():
            out[hyp] = "REJECTED, MOVES THE OTHER WAY"
        else:
            out[hyp] = "NOT CONFIRMED"
    return out


def choose_pack(fam_val):
    """The strongest simple signal, from the validation days alone: among the candidates that hold on the validation days, the largest edge at (150 ms, 5 s)."""
    best = None
    for h in PACK_CANDIDATES:
        v = fam_val[fam_val.hyp == h].sort_values("h_s")
        if _ok(v):
            e = float(v[v.h_s == 5.0].edge_bp.iloc[0])
            if best is None or e > best[0]:
                best = (e, h)
    return best[1] if best else None
