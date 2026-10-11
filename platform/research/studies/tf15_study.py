"""The protocol every candidate of the B-0654 strategy search goes through. numpy only (plus the table loaders); a notebook calls `run_candidate` and draws what it returns.

THE PROTOCOL (fixed before any candidate was scored; the notebook prints it):
  1. Days in date order: TRAIN fits maps (a calibration, a volatility scale), VALIDATE chooses ONE cell of the candidate's registered grid, TEST is read once for that cell.
  2. The choice: among cells with at least N_MIN entries on both TRAIN and VALIDATE, the one with the best net USD per entry on VALIDATE whose TRAIN net per entry is above zero;
     no such cell -> the best VALIDATE cell is still read on TEST and reported, and the candidate is a miss by construction.
  3. The headline is net USD per entry after the taker fee (or the maker rebate), the spread, the exact ladder walk and the 150 ms delay, with an interval over 15-minute slots.
  4. A candidate is FOUND only when, on TEST, the interval of net per entry is above zero AND the cell beats its placebo (random sides at the same instants) AND a planted peek is
     caught AND the cell clears the sizing gate (S6 of the notebook). Otherwise it is a recorded miss (class B: point estimate above zero, interval includes zero; class C: not above zero).
  5. N for the deflated Sharpe is every cell tried in this search, not the cell chosen.
"""
from __future__ import annotations

import math
import time

import numpy as np

import tf15_bt as B

N_MIN = 30
EULER = 0.5772156649


# ============================================================ the deflated Sharpe ratio
def _phi(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _phi_inv(p):
    # Acklam's rational approximation, enough for the SR0 benchmark
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
    pl = 0.02425
    if p < pl:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > 1 - pl:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def sharpe_stats(x):
    x = np.asarray(x, float)
    n = len(x)
    if n < 3 or x.std(ddof=1) == 0:
        return dict(n=n, sr=float("nan"), skew=float("nan"), kurt=float("nan"))
    m, s = x.mean(), x.std(ddof=1)
    z = (x - m) / s
    return dict(n=n, sr=float(m / s), skew=float((z ** 3).mean()), kurt=float((z ** 4).mean()))


def deflated_sharpe(sr, n, skew, kurt, trial_srs, n_trials):
    """Bailey and Lopez de Prado (2014): DSR = PSR(SR0), SR0 = sqrt(V) ((1 - g) Phi^-1(1 - 1/N) + g Phi^-1(1 - 1/(N e))). Per-entry Sharpe (not annualised)."""
    v = float(np.var(np.asarray(trial_srs, float), ddof=1)) if len(trial_srs) > 1 else float("nan")
    N = max(int(n_trials), 2)
    sr0 = math.sqrt(v) * ((1 - EULER) * _phi_inv(1 - 1.0 / N) + EULER * _phi_inv(1 - 1.0 / (N * math.e))) if v == v else float("nan")
    den = 1 - skew * sr + (kurt - 1) / 4.0 * sr * sr
    if not (den > 0) or n < 3 or sr0 != sr0:
        return dict(sr0=sr0, psr=float("nan"), dsr=float("nan"))
    psr0 = _phi(sr * math.sqrt(n - 1) / math.sqrt(den))
    dsr = _phi((sr - sr0) * math.sqrt(n - 1) / math.sqrt(den))
    return dict(sr0=sr0, psr=psr0, dsr=dsr)


# ============================================================ one candidate
class Candidate:
    """A candidate is an id, a grid of cells and four methods. Subclasses fill them in; the protocol below is the same for all."""

    id = "c0"
    title = "candidate"
    family = "taker"                         # taker | maker
    placebo_n = 20                           # a placebo that draws randomly is run this many times; a deterministic one once

    def grid(self):                          # list of dicts, each with a unique "name"
        raise NotImplementedError

    def fit(self, tab):                      # what is learned on TRAIN only
        return {}

    def run(self, tab, cfg, ctx, **kw):      # -> entries dict
        raise NotImplementedError

    def placebo(self, tab, cfg, ctx, seed):  # same instants, random sides
        return None

    def peek(self, tab, cfg, ctx):           # same instants, the true winner's side (must pay far more)
        return None


def _cell_stats(cand, tab, cfg, ctx):
    e = cand.run(tab, cfg, ctx)
    s = B.summarize(e, tab, cfg["name"])
    s["entries"] = e
    return s


def run_candidate(cand: Candidate, tabs: dict, log=print, with_sweeps=True, score=None):
    """tabs: {"train": Tab, "validate": Tab, "test": Tab}. -> a results dict (cells, choice, test, placebo, peek, sweeps, dsr).
    `score` (a function of a cell's summary dict, default the net USD an entry) is the number the choice reads: a cell qualifies when its TRAIN score is above zero,
    and the qualified cell with the best VALIDATE score is chosen. A study that must not be carried by a few wins passes the net an entry without the best 5%."""
    t0 = time.time()
    sc = score or (lambda s: s.get("per", -1e9))
    ctx = cand.fit(tabs["train"])
    cells = []
    for cfg in cand.grid():
        row = dict(cfg=cfg)
        for role in ("train", "validate"):
            s = _cell_stats(cand, tabs[role], cfg, ctx)
            row[role] = s
        cells.append(row)
        log(f"  {cfg['name']:34s} train n={row['train'].get('n', 0):5d} per {row['train'].get('per', float('nan')):+7.3f} | validate n={row['validate'].get('n', 0):5d} per {row['validate'].get('per', float('nan')):+7.3f}")
    ok = [c for c in cells if c["train"].get("n", 0) >= N_MIN and c["validate"].get("n", 0) >= N_MIN]
    pos = [c for c in ok if sc(c["train"]) > 0]
    pool = pos if pos else ok
    if not pool:
        pool = [c for c in cells if c["validate"].get("n", 0) > 0] or cells
    chosen = max(pool, key=lambda c: sc(c["validate"]) if c["validate"].get("n", 0) else -1e9)
    qualified = bool(pos)
    cfg = chosen["cfg"]
    test = _cell_stats(cand, tabs["test"], cfg, ctx)
    res = dict(cand=cand.id, cells=cells, chosen=cfg, qualified=qualified, test=test, ctx=ctx, seconds=None)
    # trial Sharpes (per entry) of every cell on validate, for the deflation
    srs = [c["validate"]["per"] / c["validate"]["sd"] for c in cells if c["validate"].get("n", 0) > 2 and c["validate"].get("sd", 0) > 0]
    res["trial_srs"] = srs
    res["n_trials"] = len(cells)
    e = test["entries"]
    if len(e["net"]) > 2:
        st = sharpe_stats(e["net"])
        res["test_sharpe"] = st
        res["dsr"] = deflated_sharpe(st["sr"], st["n"], st["skew"], st["kurt"], srs, len(cells))
    else:
        res["test_sharpe"] = None
        res["dsr"] = None
    if with_sweeps:
        first = cand.placebo(tabs["test"], cfg, ctx, 100)
        res["placebo"] = None if first is None else [B.summarize(first, tabs["test"], "placebo 0")] + [B.summarize(cand.placebo(tabs["test"], cfg, ctx, 100 + i), tabs["test"], f"placebo {i}") for i in range(1, cand.placebo_n)]
        pk = cand.peek(tabs["test"], cfg, ctx)
        res["peek"] = B.summarize(pk, tabs["test"], "planted peek") if pk is not None else None
    res["seconds"] = round(time.time() - t0, 1)
    return res


def verdict(res, min_n=30):
    """-> (word, klass, reasons). FOUND needs the test interval above zero, the placebo beaten and the peek caught; the sizing gate is the notebook's S6."""
    t = res["test"]
    reasons = []
    if t.get("n", 0) < min_n:
        return "NO MONEY", "C", [f"only {t.get('n', 0)} test entries"]
    lo, per = t["per_lo"], t["per"]
    pl = res.get("placebo")
    placebo_ok = True
    if pl:
        pls = np.array([p["per"] for p in pl if p.get("n", 0) > 0])
        ref = float(np.quantile(pls, 0.95)) if len(pls) > 1 else (float(pls[0]) if len(pls) else float("inf"))
        placebo_ok = bool(len(pls)) and per > ref
        reasons.append(f"placebo {'95th pct ' if len(pls) > 1 else ''}{ref:+.2f} vs {per:+.2f}")
    pk = res.get("peek")
    peek_ok = pk is not None and pk.get("n", 0) > 0 and pk["per"] > max(per, 0) + 1.0
    reasons.append(f"peek {pk.get('per', float('nan')):+.2f}" if pk is not None else "no planted peek ran")
    if pl is None:
        placebo_ok = False
        reasons.append("no placebo ran")
    if lo > 0 and per > 0 and placebo_ok and peek_ok:
        return "MONEY", "A", reasons
    if per > 0:
        return "NO MONEY", "B", reasons + [f"interval {t['per_lo']:+.2f} to {t['per_hi']:+.2f} includes zero"]
    return "NO MONEY", "C", reasons
