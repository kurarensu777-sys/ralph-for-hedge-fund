"""The protocol of the directional momentum study (B-0660). numpy only; a notebook calls these and draws what they return.

THE PROTOCOL (fixed and committed as um-009 before the engine scored a validation or test day; the notebook prints it):
  Days in date order: FIT (09-30, 10-01, 10-02), VALIDATE (10-03, 10-04), TEST (10-05, 10-06). No parameter is fitted: the signal is a causal z-score, so FIT is a second look at a cell
  before the VALIDATE choice. The TEST days are opened ONCE, for the one (signal, exit) pair the stages choose (`TestGate`).
  Stage 1  the base (L = 1 s, z = 2, hold to expiry), scored on FIT and VALIDATE.
  Stage 2  the exit sweep at the base signal: hold, take-profit +1/2/3 sigma, time exit 10/30/60/300 s, trailing stop 1/2 sigma (10 cells). Exit E1 = the choice rule below.
  Stage 3  the signal sweep at E1: lookback L in {1, 5, 10, 30, 60, 180, 300} s x z in {1.5, 2, 2.5, 3} (28 cells) and four two-lookback confirmations at z = 2 (1+60, 10+60, 10+300,
           60+300 s; 4 cells). Signal S* = the choice rule.
  Loop     the exit sweep again at S* (10 cells). Exit E* = the choice rule.
  Stage 4  the pair (S*, E*) is read once on TEST.
THE CHOICE RULE: among cells with at least N_MIN entries on FIT and on VALIDATE, those with a positive net per entry on FIT are QUALIFIED; the chosen cell is the QUALIFIED one with the best
net per entry on VALIDATE; no qualified cell -> the best VALIDATE cell among those with N_MIN entries is carried on and the run is a miss by construction (class C or B).
THE COUNT: every distinct (signal, exit) cell scored on VALIDATE is a trial; the deflated Sharpe is charged for all of them.
FOUND needs, on TEST: the interval of net per entry (15-minute slots resampled) above zero; the placebo (same firing seconds, fair-coin sides) beaten at its 95th percentile; the planted
peek (the winning side at the same seconds) caught; net per entry above zero at the 150 ms and 250 ms fills and at twice the fee; both test days above zero; the deflated Sharpe at least 0.9.
"""
from __future__ import annotations

import numpy as np

import mom15_bt as M
import tf15_study as TS

FIT = ("2026-09-30", "2026-10-01", "2026-10-02")
VALIDATE = ("2026-10-03", "2026-10-04")
TEST = ("2026-10-05", "2026-10-06")
EARLIER_WEEK = ("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29")
FRESH_DAY = ("2026-10-07",)
N_MIN = 30
FILL_MS = 250

# THE FULL-WINDOW RE-SCORE (B-0679, run um-012): the same stages, the same choice rule and the same single opening of the test days, on a chronological split of the whole 09-16..10-07
# sample (22 days, 1 regime): FIT the earliest week, VALIDATE the next, TEST the last 8 days. The days are in date order (a later day never fits a rule that scores an earlier one). The 14 days of
# FIT and VALIDATE choose the pair; the 8 TEST days are read once for it. The frozen pair of um-009 (`FROZEN_PAIR`) and the z = 2 lookback ladder are read on every day AFTER the test read, for
# the record, outside the decision rule.
PROTOCOLS = {
    "um-009": dict(FIT=FIT, VALIDATE=VALIDATE, TEST=TEST, EARLIER_WEEK=EARLIER_WEEK, FRESH_DAY=FRESH_DAY),
    "um-012": dict(
        FIT=("2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"),
        VALIDATE=("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"),
        TEST=("2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"),
        EARLIER_WEEK=(), FRESH_DAY=()),
}
FROZEN_PAIR = (1, 2.5, "expiry")                     # um-009's chosen pair: L = 1 s, z = 2.5, hold to expiry
MULTI = ((1, 60), (10, 60), (10, 300), (60, 300))
BASE = M.Signal(1, 2.0)


def key(sig: M.Signal, ex: M.Exit) -> str:
    return f"{sig.name} -> {ex.name}"


def exit_cells(sig):
    return [(sig, ex) for ex in M.EXITS]


def signal_cells(ex):
    return [(M.Signal(L, z), ex) for L in M.LS for z in M.ZS] + [(M.Signal(a, 2.0, Ll=b), ex) for a, b in MULTI]


class TestGate:
    """The TEST days' table, behind one door. `open` may be called once, with the pair the stages chose; `diag` serves the placebo, the peek, the delay and cost tables of THAT pair."""

    def __init__(self, loader):
        self._loader = loader
        self._tab = None
        self.opened = None

    def open(self, name: str):
        if self.opened is not None:
            raise RuntimeError(f"the test days were already read for {self.opened!r}: they are read once")
        self.opened = name
        self._tab = self._loader()
        return self._tab

    def diag(self):
        if self.opened is None:
            raise RuntimeError("the test days are not open: choose the pair first")
        return self._tab


def choose(rows):
    """rows: [{fit, validate, ...}] -> (index, qualified). See THE CHOICE RULE."""
    ok = [i for i, r in enumerate(rows) if r["fit"].get("n", 0) >= N_MIN and r["validate"].get("n", 0) >= N_MIN]
    qual = [i for i in ok if r_per(rows[i]["fit"]) > 0]
    pool = qual or ok or [i for i, r in enumerate(rows) if r["validate"].get("n", 0) > 0] or list(range(len(rows)))
    return max(pool, key=lambda i: r_per(rows[i]["validate"], -1e9)), bool(qual)


def r_per(s, default=-1e9):
    v = s.get("per", default) if s.get("n", 0) else default
    return default if v != v else v


class Study:
    """Scores cells on the FIT and VALIDATE tables and remembers every one (the trial count)."""

    def __init__(self, fit, validate, log=print):
        self.tabs = {"fit": fit, "validate": validate}
        self.cells = {}
        self.log = log

    def score(self, sig, ex):
        k = key(sig, ex)
        if k not in self.cells:
            row = dict(sig=sig, ex=ex, key=k)
            for role, tab in self.tabs.items():
                e = M.run(tab, sig, ex)
                s = M.summarize(e, tab, k)
                s["entries"] = e
                row[role] = s
            self.cells[k] = row
        return self.cells[k]

    def sweep(self, cells, title):
        rows = [self.score(s, e) for s, e in cells]
        i, qual = choose(rows)
        self.log(f"{title}: {len(rows)} cells, chosen {rows[i]['key']} (qualified {qual}): fit {r_per(rows[i]['fit']):+.3f} validate {r_per(rows[i]['validate']):+.3f} USD an entry")
        return dict(title=title, rows=rows, chosen=i, qualified=qual)

    def run_stages(self):
        out = {}
        out["stage1"] = self.score(BASE, M.EXITS[0])
        out["stage2"] = self.sweep(exit_cells(BASE), "stage 2, the exit sweep at the base signal")
        e1 = out["stage2"]["rows"][out["stage2"]["chosen"]]["ex"]
        out["e1"] = e1
        out["stage3"] = self.sweep(signal_cells(e1), f"stage 3, the signal sweep at the exit {e1.name}")
        s_star = out["stage3"]["rows"][out["stage3"]["chosen"]]["sig"]
        out["s_star"] = s_star
        out["loop"] = self.sweep(exit_cells(s_star), f"loop back, the exit sweep at the signal {s_star.name}")
        e_star = out["loop"]["rows"][out["loop"]["chosen"]]["ex"]
        out["e_star"] = e_star
        out["final"] = (s_star, e_star)
        out["n_trials"] = len(self.cells)
        out["trial_srs"] = [c["validate"]["per"] / c["validate"]["sd"] for c in self.cells.values() if c["validate"].get("n", 0) > 2 and c["validate"].get("sd", 0) > 0]
        return out


def final_read(gate: TestGate, sig, ex, trial_srs, n_trials, n_placebo=20):
    """The one read of TEST for the chosen pair, with its Sharpe, deflated Sharpe, placebo draws and planted peek. -> dict"""
    tab = gate.open(key(sig, ex))
    e = M.run(tab, sig, ex)
    s = M.summarize(e, tab, key(sig, ex))
    out = dict(tab=tab, entries=e, summary=s)
    if len(e["net"]) > 2:
        st = TS.sharpe_stats(e["net"])
        out["sharpe"] = st
        out["dsr"] = TS.deflated_sharpe(st["sr"], st["n"], st["skew"], st["kurt"], trial_srs, n_trials)
    else:
        out["sharpe"], out["dsr"] = None, None
    out["placebo"] = [M.summarize(M.run_random_side(tab, sig, ex, 100 + i), tab, f"placebo {i}") for i in range(n_placebo)]
    out["peek"] = M.summarize(M.run_peek(tab, sig, ex), tab, "planted peek")
    return out


def verdict(summary, placebo, peek):
    """-> (word, class, reasons) by the rule in the module docstring (the sizing gates are the notebook's S6)."""
    t = summary
    if t.get("n", 0) < N_MIN:
        return "NO MONEY", "C", [f"only {t.get('n', 0)} test entries"]
    pls = np.array([p["per"] for p in placebo if p.get("n", 0) > 0])
    ref = float(np.quantile(pls, 0.95)) if len(pls) > 1 else float("inf")
    placebo_ok = bool(len(pls)) and t["per"] > ref
    peek_ok = peek.get("n", 0) > 0 and peek["per"] > max(t["per"], 0) + 1.0
    if t["per_lo"] > 0 and t["per"] > 0 and placebo_ok and peek_ok:
        return "MONEY", "A", [f"placebo 95th percentile {ref:+.2f}", f"peek {peek['per']:+.2f}"]
    return "NO MONEY", ("B" if t["per"] > 0 else "C"), [f"placebo 95th percentile {ref:+.2f}", f"peek {peek.get('per', float('nan')):+.2f}"]
