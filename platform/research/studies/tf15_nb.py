"""The notebook generator of the B-0654 strategy search: one candidate spec in, one executed study notebook out.

A candidate's build script (`<stem>.build.py`) holds its SPEC (the words) and calls `build(SPEC)`; everything numeric is computed by the cells from `tf15_study`, `tf15_report`
and the decision tables, never typed. The notebook follows the study structure (S0 to S7, one parameters cell, tagged figures, GATES as data, one fund.study/1 manifest), kind
strategy, format directional, style systematic.
"""
from __future__ import annotations

import base64
import io
import time
from pathlib import Path

import nbformat
from nbclient import NotebookClient
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook
from PIL import Image

HERE = Path(__file__).resolve().parent


class NB:
    def __init__(self):
        self.cells = []

    def md(self, s):
        self.cells.append(new_markdown_cell(s.strip("\n")))

    def code(self, s, *tags):
        c = new_code_cell(s.strip("\n"))
        if tags:
            c.metadata["tags"] = list(tags)
        self.cells.append(c)


def sub(s, spec):
    for k, v in spec.items():
        s = s.replace(f"@@{k}@@", str(v))
    return s


def build(spec: dict, execute: bool = True, out: Path | None = None) -> int:
    nb = NB()
    spec = dict(spec)
    spec.setdefault("TRAIN", ("2026-09-30", "2026-10-01", "2026-10-02"))
    spec.setdefault("VALIDATE", ("2026-10-03", "2026-10-04"))
    spec.setdefault("TEST", ("2026-10-05", "2026-10-06"))
    spec.setdefault("EXTRA", {})
    spec.setdefault("SMOKE", False)
    spec.setdefault("SCORE", "None")                      # a python expression: the choice rule run_candidate reads (None = net an entry)
    spec.setdefault("DEEP", [])                           # extra cells before S5: [("md"|"code", text, tags...)]
    spec.setdefault("EXTRA_FIG_KINDS", {})
    spec.setdefault("CORE_EXTRA", ())                     # gate ids the decision rule reads beside G1 to G7
    spec.setdefault("GRID_LOG", "print")                  # the per-cell log of the grid run: print, or quiet
    spec.setdefault("OWN_MS", 0)                          # our own tick-to-trade on top of the venue hold: the tables are read at 150 + OWN_MS
    spec.setdefault("DPI", 110)                           # the figures' dpi (a notebook with many figures lowers it to stay under 3 MB)
    spec["PRIOR_ROWS"] = "\n".join(f"| {a} | {b} | {c} |" for a, b, c in spec["prior"])
    spec["FALSIFIER_ROWS"] = "\n".join(f"| F{i + 1} | {t} |" for i, t in enumerate(spec["falsifier"]))
    NOTEBOOK = HERE / f"{spec['STEM']}.ipynb"
    # ------------------------------------------------------------------------------------ S0
    nb.md(sub(r'''
# @@TITLE@@

## S0 · Summary

**Research question.** @@QUESTION@@

**The idea.** @@IDEA@@

| | |
|---|---|
| Market | Polymarket 15-minute crypto Up/Down (BTC, ETH, SOL, XRP), driven by Binance spot trades |
| The trade | @@TRADE@@ |
| Costs, always on | the market's own taker fee (rate x p x (1 - p), or the 20% maker rebate for a resting order), the exact ladder walked 150 ms after the decision, the venue's 5-share minimum |
| Money test | net USD per entry out of sample, with a 95% interval over 15-minute slots; win rate beside the share needed to break even; Sharpe; the deflated Sharpe for the number of cells tried |
| Days, in date order | train @@TRAIN_TXT@@; validate @@VALIDATE_TXT@@; test @@TEST_TXT@@ (read once) |
| Found means | the test interval of net per entry above zero, the placebo beaten, the planted peek caught, positive at 150 and 250 ms and at twice the fee, and the sizing gate cleared; otherwise a recorded miss |
| Pre-registration | run @@RUN_ID@@ on the predmkts desk, committed before the engine ran |

The result and its gates are drawn by the last cells.

**Falsifier, written before the test days were read.** The study ends with NO MONEY if any line below holds.

| Id | The study ends if |
|---|---|
@@FALSIFIER_ROWS@@
''', {**spec, "TRAIN_TXT": ", ".join(d[5:] for d in spec["TRAIN"]), "VALIDATE_TXT": ", ".join(d[5:] for d in spec["VALIDATE"]), "TEST_TXT": ", ".join(d[5:] for d in spec["TEST"])}))
    nb.md(sub(r'''
**Prior art** (carried from the desk's books, read 2026-10-07; not re-read today [1])

| Source | What it found | What we take from it |
|---|---|---|
@@PRIOR_ROWS@@
''', spec))
    nb.code(r'''
from IPython.display import Markdown, display
S0_HANDLE = display(Markdown("_The summary card is drawn here when the run finishes._"), display_id=True)
''', "s0")
    # ------------------------------------------------------------------------------------ S1
    nb.md(r'''
## S1 · Setup

### S1.1 · Parameters
''')
    nb.code(sub(r'''
# ---- parameters: ours, never a venue number (the fee, the delay and the minimum order are S1.2) ----
STUDY_ID = "@@STEM@@"
KIND = "strategy"
DESK = "lab/predmkts"
RUN_ID = "@@RUN_ID@@"
TITLE = "@@TITLE@@"
QUESTION = "@@QUESTION_ONE@@"
SEED = 7
TRAIN_DAYS = @@TRAIN@@
VALIDATE_DAYS = @@VALIDATE@@
TEST_DAYS = @@TEST@@
EXTRA_DAYS = @@EXTRA@@
CAND_MODULE, CAND_CLASS = "@@MODULE@@", "@@CLASS@@"
CLIP_USD = 20.0
BOOK_USD = 1000.0
OWN_MS = @@OWN_MS@@                                    # our own tick-to-trade, assumed [U] (the owner, 2026-10-10)
LAT_MS = 150 + OWN_MS                             # the venue's 150 ms taker hold [1] plus ours: the order meets the ladder as of decision + LAT_MS
''', spec), "parameters")
    nb.md(sub(r'''
### S1.2 · Assumptions

| Item | Value | Source |
|---|---|---|
| Taker delay | the venue holds a marketable crypto order 150 ms before matching (changelog 2026-09-04 [1]), plus @@OWN_MS@@ ms of our own tick-to-trade, assumed [U]: the order meets the ladder as of decision + @@LAT_MS@@ ms | venue changelog [1]; the owner (2026-10-10) |
| Taker fee | shares x rate x p x (1 - p), each market's own rate (0.07 on every market read) and exponent 1 | venue fact `fee.formula` [1]; market rows [API] |
| Maker rebate | 20% of the taker fee the counterparty pays, no maker fee | venue fact `fee.category_rates` [1], read 2026-10-04 |
| Minimum order | 5 shares | market rows [API] |
| Clip and book | USD @@CLIP@@ a trade, USD 1,000 book, 1x, one position per window (a resting order: one fill per side per window) | the brief |
| Fill (taker) | the ask ladder of the book row as of decision + 150 ms, four levels, best first, never above the rule's limit | design |
| Fill (resting) | joins the back of the queue (the displayed size at its price is ahead of it and never cancels); fills only from printed trades at or through its price; a cancel lands 150 ms after the Binance event that triggers it | design, conservative |
| Fair value | Brownian P(Up) of the Chainlink 60 s TWAP rule from the Binance trade-implied mid, volatility the 300 s half-life EWMA of 10 s squared returns | the 15-minute study (B-0642) |
| Outcome | the market's own recorded resolution | market rows [API] |
| Clocks | Binance trade time and the venue's book time taken as one clock | caveat |
''', {"CLIP": 20, "OWN_MS": spec["OWN_MS"], "LAT_MS": 150 + int(spec["OWN_MS"])}))
    nb.code(r'''
# ---- the PROSE check: the numbers the S1 tables state, held to the code ----
import tf15_bt as B, tf15_mk as MK, tf15_table as TT, tf15_study as STUDYM
PROSE = {"venue hold": (TT.FILL_MS, LAT_MS - OWN_MS), "clip": (B.CLIP_USD, CLIP_USD), "min shares": (B.MIN_SHARES, 5.0), "rebate": (MK.REBATE, 0.20), "cancel latency": (MK.CANCEL_LAT_MS, 150), "levels": (TT.L, 4)}
BAD = {k_: v_ for k_, (v_, w_) in PROSE.items() if v_ != w_}
assert not BAD, f"the S1 tables no longer describe this run: {BAD}"
print(f"S1 tables: {len(PROSE)} stated numbers equal the code")
''')
    nb.md(r'''
### S1.3 · Data

Every input is a pinned or stored day read through `fundplat.data`: the Binance spot trades (`ticks.day_frame`) and the exact Up-token ladders of every 15-minute market (`updown15_pin.read`, pinned once by the platform's ladder job). One table per day is derived from them and seated in `fundplat.data.derived` (`tf15_runner.py`); the notebook loads those tables.

| source | what | window | guard |
|---|---|---|---|
| `ticks.day_frame` | Binance spot aggTrades BTC, ETH, SOL, XRP | the days of S1.1 and the day before each | the file checksum in the day's meta |
| `updown15_pin.read` | Polymarket Up-token ladder after every event, all four coins | the days of S1.1 | the platform's day manifest digest |
| `updown15.markets` | the market list with fee schedule, reference price and recorded outcome | the days of S1.1 | the platform's coverage check |
''')
    nb.code(sub(r'''
import datetime as dt, json, math, time
import numpy as np, pandas as pd
from IPython.display import HTML, Markdown, display
from fundplat.quant.core import figstyle, report as REPORT, summary_card
import tf15_cands as CANDS, tf15_report as RP, tf15_figs as FIGS, tf15_runner as RUNNER, lift_figs as LF
get_ipython().run_line_magic("config", "InlineBackend.print_figure_kwargs = {'bbox_inches': None}")
LF.setup()
import matplotlib.pyplot as _plt
_plt.rcParams["figure.dpi"] = @@DPI@@
RUN_AT = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
print("loading the seated decision tables (fundplat.data.derived) for", TRAIN_DAYS + VALIDATE_DAYS + TEST_DAYS)
t0 = time.time()
TABS = {"train": B.Tab(TRAIN_DAYS, fill_ms=LAT_MS), "validate": B.Tab(VALIDATE_DAYS, fill_ms=LAT_MS), "test": B.Tab(TEST_DAYS, fill_ms=LAT_MS)}
print({k_: f"{v_.W} windows" for k_, v_ in TABS.items()}, f"{time.time() - t0:.0f}s")
DAYS_ALL = TRAIN_DAYS + VALIDATE_DAYS + TEST_DAYS
HOURS_ALL = 24 * len(DAYS_ALL)
WINDOW = {"from": f"{DAYS_ALL[0]}T00:00Z", "to": f"{(dt.date.fromisoformat(DAYS_ALL[-1]) + dt.timedelta(days=1)).isoformat()}T00:00Z", "hours": HOURS_ALL, "regimes": 1}
pct = lambda v, d=1: f"{v * 100:.{d}f}%"
sgn = lambda v, d=2: f"{v:+,.{d}f}"
usd = lambda v, d=0: f"USD {v:,.{d}f}"
WIN_ALL = f"{DAYS_ALL[0][5:]} to {DAYS_ALL[-1][5:]} · {HOURS_ALL}h · 4 coins"
WIN_VAL = f"{VALIDATE_DAYS[0][5:]} to {VALIDATE_DAYS[-1][5:]} · {24 * len(VALIDATE_DAYS)}h · validation days"
WIN_TEST = f"{TEST_DAYS[0][5:]} to {TEST_DAYS[-1][5:]} · {24 * len(TEST_DAYS)}h · test days"
FIGURES, GATES, CAVEATS = [], [], []
CAND = getattr(__import__(CAND_MODULE), CAND_CLASS)()
assert CAND.id == "@@CAND_ID@@", CAND.id
assert @@SMOKE@@ or (max(TRAIN_DAYS) < min(VALIDATE_DAYS) and max(VALIDATE_DAYS) < min(TEST_DAYS)), "the split is not in date order"
''', spec))
    nb.md(r'''
### S1.4 · Runs

The engine checks run here; every one that can fail is counted.
''')
    nb.code(r'''
import tf15_fv as FVMOD
print("tf15_bt:"); ok_bt = B.selftest()
print("tf15_fv:"); ok_fv = FVMOD.selftest()
print("tf15_mk:"); ok_mk = MK.selftest()
assert ok_bt and ok_fv and ok_mk, "an engine check failed"
_n_bt = len(B.checks())
VERIFY = {"suite": "tf15 engine checks and planted tests", "passed": _n_bt + 6, "total": _n_bt + 6, "books": sum(t_.W for t_ in TABS.values())}      # tf15_bt checks + 2 (fv) + 4 (mk) engine cases above; the planted peek of S4 adds one
''')
    # ------------------------------------------------------------------------------------ S2
    nb.md(r'''
## S2 · Data checks

| question | gate to S3 |
|---|---|
| Is there a book for the windows, is the table the pinned ladder read without looking ahead, and do the engine's planted tests behave? | at least 90% of windows have a book; a planted peek pays far more than random sides |
''')
    nb.code(r'''
# ---- coverage of the tables: windows with a book by the first decision second, and the Binance reference against the venue's published one ----
COV = []
for role_, tab_ in TABS.items():
    for i_, d_ in enumerate(tab_.days):
        arrs_, meta_ = RUNNER.load(d_, LAT_MS)
        COV.append(dict(role=role_, day=d_, windows=int(meta_["windows"]), with_book=int(meta_["ok"]), share=meta_["ok"] / meta_["windows"]))
COV = pd.DataFrame(COV)
display(Markdown("**Windows with a book by the first decision second** (the other windows have no ladder, or a Binance gap over 30 s, and are out before any outcome is read)\n\n| Role | Day | Windows | With a book | Share |\n|---|---|---|---|---|\n" +
                 "\n".join(f"| {r.role} | {r.day} | {r.windows} | {r.with_book} | {pct(r.share)} |" for r in COV.itertuples())))
SHARE = float(COV.with_book.sum() / COV.windows.sum())
_t = TABS["test"]
_basis = np.log(_t.w_a0 / _t.w_ptb) * 1e4
display(Markdown(f"The Binance reference start price sits **{_basis.mean():+.2f} bp** above the venue's published price to beat (sd {_basis.std():.2f} bp over {len(_basis)} test windows): a constant Binance-to-Chainlink basis. The fair value does not use the published price; the rule never needs a number the venue publishes only at the window's end."))
GATES.append({"id": "G1", "section": "S2", "label": "Windows have a book", "name": "at least 90% of windows have a ladder by the first decision second", "reading": f"{pct(SHARE)} of {int(COV.windows.sum())} windows",
              "verdict": "PASS" if SHARE >= 0.9 else "FAIL", "would_change": "a share below 90%"})
''')
    # ------------------------------------------------------------------------------------ S3
    nb.md(sub(r'''
## S3 · Core result

| question | gate to S4 |
|---|---|
| @@S3_Q@@ | the cell chosen on the validation days earns above zero on the train days too; on the test days its net per entry is above zero |

@@S3_NOTE@@
''', spec))
    nb.code(sub(r'''
# ---- the registered grid on the train and validation days; ONE cell is chosen; the test days are read once for it ----
t0 = time.time()
RES = STUDYM.run_candidate(CAND, TABS, log=(print if "@@GRID_LOG@@" == "print" else (lambda s_: None)), score=@@SCORE@@)
print(f"candidate run in {time.time() - t0:.0f}s")
CELLS, CHOSEN, TS = RES["cells"], RES["chosen"], RES["test"]
ENT = TS["entries"]
N_TRIALS = RES["n_trials"]
assert N_TRIALS == @@N_TRIALS@@ and len({c_["cfg"]["name"] for c_ in CELLS}) == N_TRIALS, "the grid is not the registered grid"
print("chosen:", CHOSEN["name"], "| qualified on train and validation:", RES["qualified"])
''', spec))
    nb.code(r'''
# ---- the grid on the validation days (every registered cell), fig:s3-grid ----
_rows = []
for c_ in CELLS:
    tr_, va_ = c_["train"], c_["validate"]
    _rows.append({"cell": c_["cfg"]["name"], "train n": tr_.get("n", 0), "train per": tr_.get("per", np.nan), "valid n": va_.get("n", 0), "valid per": va_.get("per", np.nan), "valid lo": va_.get("per_lo", np.nan),
                  "valid hi": va_.get("per_hi", np.nan), "valid win %": va_.get("win", np.nan) * 100, "valid be %": va_.get("breakeven", np.nan) * 100})
GRID = pd.DataFrame(_rows)
_best = GRID.sort_values("valid per", ascending=False).iloc[0]
_bul = [f"{len(GRID)} cells were registered; {int((GRID['valid per'] > 0).sum())} earn above zero on the validation days and {int(((GRID['valid per'] > 0) & (GRID['train per'] > 0)).sum())} on the train days as well.",
        f"The chosen cell, {CHOSEN['name']}, earned {sgn(GRID.set_index('cell').loc[CHOSEN['name'], 'valid per'])} USD an entry on {int(GRID.set_index('cell').loc[CHOSEN['name'], 'valid n'])} validation entries and {sgn(GRID.set_index('cell').loc[CHOSEN['name'], 'train per'])} on the train days."
        + ("" if RES["qualified"] else " No cell was positive on both, so the best validation cell is read on the test days as a miss by construction."),
        f"The best validation cell is {_best['cell']} at {sgn(_best['valid per'])}; picking the best of {len(GRID)} flatters it, which the deflated Sharpe in S4 prices."]
GRID_MAX = 1000                                   # a grid over this many cells draws its 60 best validation cells and the chosen one (a bar a cell would not fit a page)
if len(CELLS) > GRID_MAX:
    _keep = set(GRID.sort_values("valid per", ascending=False)["cell"].head(60)) | {CHOSEN["name"]}
    _bul.append(f"Drawn: the 60 best validation cells of {len(GRID)} and the chosen cell; the whole grid is read by dimension in S4 and listed in the appendix.")
    _cells_fig = [c_ for c_ in CELLS if c_["cfg"]["name"] in _keep]
else:
    _cells_fig = CELLS
fig = FIGS.grid_fig(_cells_fig, CHOSEN, WIN_VAL, _bul, "Which of the registered cells earn money on the validation days?")
figstyle.show(fig, "fig:s3-grid", FIGURES)
''', "fig:s3-grid")
    nb.code(r'''
# ---- the test days, read once for the chosen cell ----
_d = RP.by_day(ENT, TABS["test"])
display(Markdown(f"**Chosen cell {CHOSEN['name']}, test days {TEST_DAYS[0]} to {TEST_DAYS[-1]}.** {TS['n']} entries; win rate {pct(TS['win'])} (Wilson {pct(TS['win_lo'])} to {pct(TS['win_hi'])}) against {pct(TS['breakeven'])} needed to break even (price plus fee); "
                 f"net {sgn(TS['net'], 0)} USD, {sgn(TS['per'])} an entry (95% by 15-minute slot {sgn(TS['per_lo'])} to {sgn(TS['per_hi'])}); before costs {sgn(TS['gross_per'])} an entry, costs {TS['fee_per']:.2f}."))
display(HTML(_d.round(3).to_html(border=0)))
TEST_FRAME = RP.frame(ENT, TABS["test"])
''')
    nb.code(r'''
_s, _eq, _dd, _ddpath = RP.equity(ENT, TABS["test"])
_bul = [f"{TS['n']} entries of USD {CLIP_USD:g} on the test days: net {sgn(TS['net'], 0)} USD, deepest drawdown {usd(_dd)} ({_dd / BOOK_USD * 100:.1f}% of the USD {BOOK_USD:,.0f} book).",
        f"Win rate {pct(TS['win'])} against {pct(TS['breakeven'])} to break even; the average price paid is {TS['vwap'] * 100:.1f} cents a share.",
        "Entries are in time order; the shaded band is the distance below the running peak."]
fig = FIGS.equity_fig(_eq, _ddpath, WIN_TEST, _bul, "Does the chosen cell grow the book on the test days?")
figstyle.show(fig, "fig:s3-equity", FIGURES)
''', "fig:s3-equity")
    # ------------------------------------------------------------------------------------ S4
    nb.md(r'''
## S4 · Robustness

| question | gate to S6 |
|---|---|
| Is it real: does the placebo earn as much, does a planted peek pay far more, does it survive the delay, twice the fee, both test days, and the number of cells tried? | the rows of the gate table below |
''')
    nb.code(r'''
# ---- placebo and planted peek (the harness would see a leak) ----
PL = RES["placebo"]
PK = RES["peek"]
_pl = np.array([p_["per"] for p_ in PL if p_.get("n", 0) > 0]) if PL else np.array([])
_ref = float(np.quantile(_pl, 0.95)) if len(_pl) > 1 else (float(_pl[0]) if len(_pl) else float("inf"))
_bul = [(f"The chosen cell earns {sgn(TS['per'])} an entry; {len(_pl)} placebo draw(s) at the same instants earn {sgn(float(_pl.mean()))} on average, 95th percentile {sgn(_ref)}." if len(_pl) else "No placebo ran."),
        (f"The planted peek (the same instants, the winner's side) earns {sgn(PK['per'])} an entry on {PK['n']} entries: the harness sees a leak." if PK else "No planted peek ran."),
        "A cell that does not beat its placebo is earning the market's drift, the fee rebate or the spread, not the rule."]
fig = FIGS.placebo_fig(TS["per"], _pl, WIN_TEST, _bul, "Does the chosen cell beat the same trades with no information?")
figstyle.show(fig, "fig:s4-placebo", FIGURES)
''', "fig:s4-placebo")
    nb.code(r'''
# ---- the delay: a taker cell re-run on tables built for each order delay; a resting cell with its post and cancel latencies moved ----
t0 = time.time()
DELAY = RP.delay_table(CAND, CHOSEN, RES["ctx"], TEST_DAYS, delays=(0, 50, 150, 250, 500))
print(f"delay table in {time.time() - t0:.0f}s")
display(HTML(DELAY.round(3).to_html(index=False, border=0)))
_d150 = DELAY.set_index("delay_ms")
_bul = [f"Net per entry: {', '.join(f'{sgn(r_.per)} at {int(r_.delay_ms)} ms' for r_ in DELAY.itertuples())}.",
        "The registered rule is read at 150 ms, the venue's taker delay; the others show how much of any edge is the delay.",
        ("A taker cell re-runs on tables built for each delay." if CAND.family == "taker" else "A resting cell moves its post and cancel latencies together.")]
fig = FIGS.delay_fig(DELAY, WIN_TEST, _bul, "How much of the result is the order delay?")
figstyle.show(fig, "fig:s4-delay", FIGURES)
''', "fig:s4-delay")
    nb.code(r'''
# ---- costs ----
COST = RP.cost_table(CAND, CHOSEN, RES["ctx"], TABS["test"])
display(HTML(COST.round(3).to_html(index=False, border=0)))
''')
    nb.code(r'''
# ---- by day, and the deflated Sharpe for the number of cells tried ----
_bd = RP.by_day(ENT, TABS["test"])
_pos_days = int((_bd["net"] > 0).sum())
DSR = RES["dsr"]
SH = RES["test_sharpe"]
_slot_sh = B.slot_sharpe(ENT, TABS["test"]) if TS["n"] else float("nan")
_daily_sh = TS.get("sharpe_daily", float("nan"))
display(Markdown(f"**Sharpe.** Per entry (mean over standard deviation) {SH['sr']:+.3f} on {SH['n']} entries (skew {SH['skew']:+.1f}, kurtosis {SH['kurt']:.1f}); annualised on 15-minute slots {sgn(_slot_sh, 1)}, on days {sgn(_daily_sh, 1)} (two days: a rough label only). "
                 f"The best of {N_TRIALS} cells is deflated against the spread of the cells' own Sharpe ratios: SR0 {DSR['sr0']:+.3f}, probabilistic {DSR['psr']:.2f}, **deflated {DSR['dsr']:.2f}**." if SH and DSR else "Too few entries for a Sharpe."))
''')
    nb.code(r'''
# ---- days outside the registered split, read AFTER the test days for the cell already chosen (informational, outside the decision rule): an earlier week and a fresh forward day ----
XR = {}
for lab_, days_all_ in EXTRA_DAYS.items():
    days_ = [d_ for d_ in days_all_ if RUNNER.seated(d_, LAT_MS) is not None]
    if len(days_) < len(days_all_):
        print(f"{lab_}: {len(days_all_) - len(days_)} of {len(days_all_)} days are not seated and are left out: {sorted(set(days_all_) - set(days_))}")
    if not days_:
        continue
    try:
        tx_ = B.Tab(days_, fill_ms=LAT_MS)
        xe_ = CAND.run(tx_, CHOSEN, RES["ctx"])
        XR[lab_] = (tx_, xe_, B.summarize(xe_, tx_, lab_))
    except LookupError as e_:
        print(f"{lab_}: not seated ({str(e_)[:100]})")
_rows = [dict(block="registered test days", days=f"{TEST_DAYS[0][5:]} to {TEST_DAYS[-1][5:]}", n=TS["n"], win=TS["win"], breakeven=TS["breakeven"], net=TS["net"], per=TS["per"], lo=TS["per_lo"], hi=TS["per_hi"])]
for lab_, (tx_, xe_, sx_) in XR.items():
    if sx_.get("n", 0):
        _rows.append(dict(block=lab_, days=f"{tx_.days[0][5:]} to {tx_.days[-1][5:]}", n=sx_["n"], win=sx_["win"], breakeven=sx_["breakeven"], net=sx_["net"], per=sx_["per"], lo=sx_["per_lo"], hi=sx_["per_hi"]))
POOL = RP.pool([ENT] + [xe_ for (_, xe_, _) in XR.values()])
SP = B.summarize(POOL)
if SP.get("n", 0):
    _rows.append(dict(block="pooled, all days outside train and validation", days="", n=SP["n"], win=SP["win"], breakeven=SP["breakeven"], net=SP["net"], per=SP["per"], lo=SP["per_lo"], hi=SP["per_hi"]))
XT = pd.DataFrame(_rows)
display(Markdown("**The chosen cell on the days outside the registered split** (read after the test days; none was used to choose it; the earlier week is before the train days, the fresh day after the test days)"))
display(HTML(XT.round(3).to_html(index=False, border=0)))
FRESH = XR.get("fresh day", (None, None, None))[2]
WEEK = XR.get("earlier week", (None, None, None))[2]
GATES.append({"id": "G11", "section": "S4", "label": "Other days, for record", "name": "the chosen cell on an earlier week and a fresh day nobody had read when it was chosen; informational, outside the decision rule",
              "reading": (f"earlier week {sgn(WEEK['per'])} on {WEEK['n']}; fresh day {sgn(FRESH['per'])} on {FRESH['n']}" if WEEK and FRESH and WEEK.get("n", 0) and FRESH.get("n", 0) else (f"earlier week {sgn(WEEK['per'])} on {WEEK['n']}" if WEEK and WEEK.get("n", 0) else "no other day read")),
              "verdict": "INFO", "would_change": "a result on more days"})
GATES.append({"id": "G12", "section": "S4", "label": "Pooled out of sample", "name": "net per entry over every day outside the train and validation days, with a 95% interval over 15-minute slots; informational: the decision rule reads the registered test days",
              "reading": (f"{sgn(SP['per'])} USD an entry on {SP['n']} entries, 95% {sgn(SP['per_lo'])} to {sgn(SP['per_hi'])}" if SP.get("n", 0) else "no entry"), "verdict": "INFO", "would_change": "more days"})
''')
    for kind_, text_, *tags_ in spec["DEEP"]:
        (nb.md if kind_ == "md" else nb.code)(sub(text_, spec), *tags_)
    # ------------------------------------------------------------------------------------ S5
    nb.md(r'''
## S5 · Risk and diagnostics

| question | answer form |
|---|---|
| Where does the money, or the loss, come from: coin, price paid, time left, day? | tables and one figure |
''')
    nb.code(r'''
_ba = RP.by_asset(ENT, TABS["test"])
_bb = RP.by_band(ENT, TABS["test"])
_bl = RP.by_left(ENT, TABS["test"])
display(Markdown("**By coin**")); display(HTML(_ba.round(3).to_html(border=0)))
display(Markdown("**By time left**")); display(HTML(_bl.round(3).to_html(border=0)))
_bul = ["Green bars are price bands where the win share beat the price paid; red where it fell short. The ink tick is the average price paid.",
        f"{int(_bb['entries'].max())} entries in the busiest band; {int((_bb['entries'] < 10).sum())} of {len(_bb)} bands hold fewer than 10, so read those bars as colour, not as numbers.",
        f"Fees and the rebate net to {sgn(TS['fee_per'])} USD an entry on average."]
fig = FIGS.band_fig(_bb, WIN_TEST, _bul, "Does the win share beat the price paid in each price band?")
figstyle.show(fig, "fig:s5-price", FIGURES)
''', "fig:s5-price")
    nb.code(r'''
fig = FIGS.daily_fig(_bd, WIN_TEST, [f"Net by day: " + "; ".join(f"{d_[5:]} {sgn(r_.net, 0)}" for d_, r_ in _bd.iterrows()) + " USD.",
                                       f"{_pos_days} of {len(_bd)} test days earned above zero. {len(_bd)} days of one regime are one observation of the regime, not a promise."], "Did the chosen cell earn on each test day?")
figstyle.show(fig, "fig:s5-daily", FIGURES)
''', "fig:s5-daily")
    # ------------------------------------------------------------------------------------ S6
    nb.md(r'''
## S6 · Decision

| question | decision rule |
|---|---|
| If it passed: what size, can it be filled, what are the limits? | a size only if every gate below passed (`SIZED`); else the rung prints as information only |
''')
    nb.code(sub(r'''
SZ = RP.sizing(ENT, TABS["test"], CLIP_USD)
display(Markdown(f"**Sizing read (information unless every gate passes).** {SZ['per_day']:.0f} fills a day of USD {CLIP_USD:g} (median fill USD {SZ['median_fill_usd']:.1f}), USD {SZ['cost_per_day']:,.0f} deployed a day, net {sgn(SZ['net_per_day'], 0)} USD a day on a USD {BOOK_USD:,.0f} book "
                 f"({sgn(SZ['ret_pct_of_book_per_day'], 1)}% a day), deepest drawdown {usd(SZ['max_dd_usd'])} ({SZ['dd_pct_of_book']:.1f}% of the book). Capacity is the visible depth: a clip of USD 100 changes the fill, see the cost table."))
# ---- the gates, as data ----
def gate(i, label, name, reading, ok, would):
    GATES.append({"id": i, "section": "S4", "label": label, "name": name, "reading": reading, "verdict": "PASS" if ok else "FAIL", "would_change": would})
_lo, _per = TS["per_lo"], TS["per"]
gate("G2", "Net per entry above 0", "the chosen cell's test net per entry is above zero with a 95% interval above zero", f"{sgn(_per)} USD an entry, 95% {sgn(_lo)} to {sgn(TS['per_hi'])}, on {TS['n']} entries", _lo > 0 and _per > 0, "an interval that includes zero")
_pl_ok = bool(len(_pl)) and TS["per"] > _ref
gate("G3", "Beats the placebo", "the cell earns more per entry than the placebo's 95th percentile (or the single blind placebo)", f"{sgn(TS['per'])} against {sgn(_ref)}", _pl_ok, "a placebo that earns as much")
_pk_ok = bool(PK) and PK["n"] > 0 and PK["per"] > max(TS["per"], 0) + 1.0
VERIFY["total"] += 1
VERIFY["passed"] += int(_pk_ok)
gate("G4", "Planted peek caught", "a planted look at the outcome pays far more than the cell", f"peek {sgn(PK['per']) if PK else 'n/a'} against {sgn(TS['per'])}", _pk_ok, "a harness that cannot tell a leak")
_d = DELAY.set_index("delay_ms")
_dok = bool(_d.loc[150, "per"] > 0 and _d.loc[250, "per"] > 0)
gate("G5", "Survives 150 and 250 ms", "net per entry stays above zero at the venue's delay and at 250 ms", f"{sgn(_d.loc[150, 'per'])} at 150 ms, {sgn(_d.loc[250, 'per'])} at 250 ms; {sgn(_d.loc[0, 'per'])} with no delay", _dok, "an edge that lives inside the delay")
_c = COST.set_index("case")
_cname = "fee x2" if CAND.family == "taker" else "no maker rebate"
gate("G6", "Survives costlier fills", "net per entry stays above zero at twice the fee (a resting order: with no rebate)", f"{sgn(_c.loc[_cname, 'per'])} at {_cname}", bool(_c.loc[_cname, "per"] > 0), "a cell whose edge is smaller than a fee")
gate("G7", "Positive on every day", "the net is above zero on every test day", f"{_pos_days} of {len(_bd)} test days above zero", bool(_pos_days == len(_bd) and len(_bd) > 0), "a result carried by one day")
gate("G8", "Chosen on both sides", "the chosen cell is positive on the train days as well as the validation days", f"qualified {RES['qualified']}", bool(RES["qualified"]), "a cell positive on one window only")
gate("G9", "Deflated Sharpe", "the deflated Sharpe, which charges for the number of cells tried, is at least 0.90", f"deflated {DSR['dsr']:.2f}, {N_TRIALS} cells" if DSR and DSR["dsr"] == DSR["dsr"] else "not computable", bool(DSR and DSR["dsr"] == DSR["dsr"] and DSR["dsr"] >= 0.9), "a Sharpe within the luck of the best of N")
_core = ("G1", "G2", "G3", "G4", "G5", "G6", "G7") + @@CORE_EXTRA@@
GV_ = {g_["id"]: g_["verdict"] for g_ in GATES}
SIZED = all(GV_[i_] == "PASS" for i_ in _core)
WORD = "1x" if SIZED else "NO SIZE"
CLASS = "A" if SIZED else ("B" if TS["per"] > 0 else "C")
CLASS_TXT = {"A": "money: every gate passed", "B": "a positive point estimate that the interval, the placebo or the delay does not support", "C": "no money"}[CLASS]
display(Markdown(f"**Decision: {'a USD 20 clip, one position per window, paper only' if SIZED else 'NO SIZE'}.** " + ("Every gate of the rule passed." if SIZED else f"Not passed: {', '.join(g_['label'] for g_ in GATES if g_['verdict'] == 'FAIL' and g_['id'] in _core)}. The rung is information only.")))
GATES.append({"id": "G10", "section": "S6", "label": "Sized only if passed", "name": "the decision rule reads G1 to G7: a size only when all pass, else the rung is information only", "reading": f"{'SIZED' if SIZED else 'NO SIZE'}: {sgn(TS['per'])} USD an entry",
              "verdict": "PASS" if SIZED else "FAIL", "would_change": "any gate it reads"})
''', spec))
    # ------------------------------------------------------------------------------------ S7
    nb.md(r'''
## S7 · Verdict
''')
    nb.code(sub(r'''
# ---- the plain-words answer, from the run's own numbers ----
HEADLINE_MD = (f"**The answer: {'MONEY' if SIZED else 'NO MONEY'}, class {CLASS}.** The chosen cell, {CHOSEN['name']}, earned {sgn(TS['per'])} USD an entry on {TS['n']} test entries "
               f"(95% by slot {sgn(TS['per_lo'])} to {sgn(TS['per_hi'])}), {sgn(TS['net'], 0)} USD net after costs. It won {pct(TS['win'])} of its entries against {pct(TS['breakeven'])} needed to break even. "
               f"Sharpe per entry {SH['sr']:+.3f}, deflated {DSR['dsr']:.2f} over {N_TRIALS} cells. At no delay it earns {sgn(_d.loc[0, 'per'])}, at 150 ms {sgn(_d.loc[150, 'per'])}, at 250 ms {sgn(_d.loc[250, 'per'])}. "
               f"{'The placebo is beaten and the planted peek is caught.' if (_pl_ok and _pk_ok) else 'It does not clear the placebo or the planted-peek test.'} " + "@@WHY_TEXT@@")
display(Markdown(HEADLINE_MD))
''', spec))
    nb.code(r'''
for g_ in GATES:
    assert g_["verdict"] in REPORT.GATE_VERDICTS, g_
    assert len(g_["label"]) <= REPORT.MAX_GATE_LABEL, (g_["label"], len(g_["label"]))
assert len({g_["id"] for g_ in GATES}) == len(GATES)
GATES.sort(key=lambda g_: int(g_["id"][1:]))
GV = {g_["id"]: g_["verdict"] for g_ in GATES}
display(Markdown("**Gates**\n\n| Id | Section | Gate | Reading | Verdict |\n|---|---|---|---|---|\n" + "\n".join(f"| {g_['id']} | {g_['section']} | {g_['label']} | {g_['reading']} | **{g_['verdict']}** |" for g_ in GATES)))
RESULT_LINES = [f"RESULT @@RUN_ID@@ test_entries={TS['n']}", f"RESULT @@RUN_ID@@ test_win_rate_pct={TS['win'] * 100:.2f}", f"RESULT @@RUN_ID@@ test_net_per_entry_usd={TS['per']:.4f}",
                f"RESULT @@RUN_ID@@ test_net_pnl_usd={TS['net']:.2f}", f"RESULT @@RUN_ID@@ test_sharpe_per_entry={SH['sr']:.4f}", f"RESULT @@RUN_ID@@ deflated_sharpe={DSR['dsr']:.3f}",
                f"RESULT @@RUN_ID@@ test_net_ex_best5_usd={TS.get('per_ex_top5', float('nan')):.4f}"]
print("\n".join(RESULT_LINES))
'''.replace("@@RUN_ID@@", spec["RUN_ID"]))
    nb.code(sub(r'''
# ---- the card, the verdict and the manifest ----
_cut = lambda s, n: s if len(s) <= n else s[: n - 1].rstrip() + "."
mk = lambda metric, value, bar="", verdict="", gate=None: {"metric": metric, "value": value, "bar": bar, "verdict": GV[gate] if gate else verdict, **({"gate": gate} if gate else {})}
_wins, _loss = ENT["net"][ENT["net"] > 0], ENT["net"][ENT["net"] <= 0]
PF = float(_wins.sum() / abs(_loss.sum())) if len(_loss) and _loss.sum() != 0 else None
WLR = float(_wins.mean() / abs(_loss.mean())) if len(_wins) and len(_loss) else None
_dly = _bd["net"].to_numpy(float)
_hold_h = float(np.mean(ENT["T"]) / 3600.0) if TS["n"] else None
METRICS = {"ann_return_pct": None, "excess_vs_hurdle_pct": None, "ann_vol_pct": None, "sharpe": (None if _slot_sh != _slot_sh else float(_slot_sh)), "sortino": None, "calmar": None, "psr": float(DSR["psr"]), "dsr": float(DSR["dsr"]),
           "max_dd_pct": SZ["dd_pct_of_book"], "max_dd_days": float(len(TEST_DAYS)), "n_periods": float(len(TEST_DAYS) * 96), "periods_per_year": 96.0 * 365.0,
           "total_return_pct": TS["net"] / BOOK_USD * 100, "n_trades": float(TS["n"]), "trades_per_day": TS["n"] / len(TEST_DAYS), "hit_rate_pct": TS["win"] * 100,
           "profit_factor": PF, "expectancy_bps": TS["per"] / CLIP_USD * 1e4, "win_loss_ratio": WLR, "avg_hold_h": _hold_h, "exposure_pct": None,
           "turnover_ann": float(ENT["cost"].sum() / len(TEST_DAYS) * 365 / BOOK_USD), "fees_pct_of_gross": (float(ENT["fee"].sum() / abs(ENT["gross"].sum()) * 100) if ENT["gross"].sum() else None),
           "worst_period_pct": float(_dly.min() / BOOK_USD * 100), "gross_edge_bps": TS["gross_per"] / CLIP_USD * 1e4, "cost_bps": TS["fee_per"] / CLIP_USD * 1e4,
           "breakeven_cost_bps": TS["gross_per"] / CLIP_USD * 1e4, "capacity_usd": None, "beta_to_underlying": None}
NA = {"ann_return_pct": f"{len(TEST_DAYS)} test days: an annualised return is not meaningful", "excess_vs_hurdle_pct": f"{len(TEST_DAYS)} test days: an annualised excess is not meaningful", "ann_vol_pct": f"{len(TEST_DAYS)} test days: an annualised volatility is not meaningful",
      "sortino": f"{len(TEST_DAYS)} test days: not meaningful", "calmar": f"{len(TEST_DAYS)} test days: not meaningful", "exposure_pct": "exposure over the window was not tracked per second", "capacity_usd": "the ladder depth beyond four levels is not kept",
      "beta_to_underlying": "a binary payoff on Up or Down: no single underlying beta"}
for k_, v_ in list(METRICS.items()):
    if v_ is None or (isinstance(v_, float) and not math.isfinite(v_)):
        METRICS[k_] = None
        NA.setdefault(k_, "no loss or no entry on the test days")
VERDICT = {"word": WORD, "why": [_cut(f"net {sgn(TS['per'])} USD per entry on {TS['n']} test entries, 95% by slot {sgn(TS['per_lo'])} to {sgn(TS['per_hi'])}", 110),
                                 _cut(f"win {pct(TS['win'])} against {pct(TS['breakeven'])} to break even; deflated Sharpe {DSR['dsr']:.2f} over {N_TRIALS} cells", 110),
                                 _cut(f"{sgn(_d.loc[150, 'per'])} per entry at 150 ms, {sgn(_d.loc[0, 'per'])} with no delay", 110)] if not SIZED else [_cut(f"every gate of the decision rule passed on {TS['n']} test entries", 110)],
           "next_bet": _cut("@@NEXT_BET@@", 150)}
CARD = {
    "question": _cut("@@QUESTION_ONE@@", 200),
    "answer": _cut(f"{WORD}, class {CLASS}. {TS['n']} test entries net {sgn(TS['net'], 0)} USD ({sgn(TS['per'])} each, 95% {sgn(TS['per_lo'])} to {sgn(TS['per_hi'])}); win {pct(TS['win'])} vs {pct(TS['breakeven'])} to break even.", 220),
    "implementation": [("Trade", _cut("@@TRADE_SHORT@@", 70)), ("Venue", "Polymarket 15m crypto Up/Down; Binance is input"), ("Rule", _cut(CHOSEN["name"], 70)),
                      ("Size", f"{usd(CLIP_USD)} a trade, {usd(BOOK_USD)} book, 1x"), ("Costs", "taker fee 0.07 x p(1-p) or 20% maker rebate; +150 ms"), ("Window", f"{DAYS_ALL[0][5:]} to {DAYS_ALL[-1][5:]}, {HOURS_ALL}h, 1 regime")],
    "big": [dict(mk("Net per entry", f"{sgn(TS['per'])} USD", f"95% {sgn(TS['per_lo'])} to {sgn(TS['per_hi'])}", gate="G2"), scope="test"),
            dict(mk("Net after costs", f"{sgn(TS['net'], 0)} USD", f"{TS['n']} entries", gate="G2"), scope="test"),
            dict(mk("Win rate", pct(TS["win"]), f"break-even {pct(TS['breakeven'])}", verdict="INFO"), scope="test"),
            dict(mk("Deflated Sharpe", f"{DSR['dsr']:.2f}", "at least 0.90", gate="G9"), scope="test")],
    "blocks": [
        {"title": "Money", "rows": [mk("Net per entry", f"{sgn(TS['per'])} USD", "interval above 0", gate="G2"), mk("Before costs, per entry", f"{sgn(TS['gross_per'])} USD", "", "INFO"), mk("Costs, per entry", f"{TS['fee_per']:.2f} USD", "", "INFO"),
                                    mk("Sharpe per entry", f"{SH['sr']:+.3f}", "", "INFO"), mk("Sharpe, 15-minute slots", sgn(_slot_sh, 1), "", "INFO")]},
        {"title": "Is it real", "rows": [mk("Placebo, 95th percentile", sgn(_ref), "below the cell", gate="G3"), mk("Planted peek", sgn(PK["per"]) if PK else "n/a", "pays more", gate="G4"), mk("Days above zero", f"{_pos_days} of {len(_bd)}", "all", gate="G7"),
                                       mk("Positive on train days", "yes" if RES["qualified"] else "no", "yes", gate="G8"),
                                       mk("Pooled other days, per entry", sgn(SP["per"]) if SP.get("n", 0) else "n/a", "informational", gate="G12")]},
        {"title": "Delay and cost", "rows": [mk("No delay, per entry", sgn(_d.loc[0, "per"]), "", "INFO"), mk("150 ms, per entry", sgn(_d.loc[150, "per"]), "above 0", gate="G5"), mk("250 ms, per entry", sgn(_d.loc[250, "per"]), "above 0", gate="G5"),
                                  mk(_cname.capitalize() if CAND.family == "taker" else "No rebate", sgn(_c.loc[_cname, "per"]), "above 0", gate="G6")]},
        {"title": "Risk, USD", "rows": [mk("Deepest drawdown", sgn(-SZ["max_dd_usd"], 0), f"book {usd(BOOK_USD)}", "INFO"), mk("Worst day", sgn(float(_dly.min()), 0), "", "INFO"), mk("Fills a day", f"{SZ['per_day']:.0f}", "", "INFO"), mk("Net a day", sgn(SZ["net_per_day"], 0), "", "INFO")]},
        {"title": "Checks", "rows": [mk("Windows with a book", pct(SHARE, 0), "90% bar", gate="G1"), mk("Cells tried", f"{N_TRIALS}", "", "INFO"), mk("Engine checks held", f"{VERIFY['passed']} of {VERIFY['total']}", "all", "INFO")]}],
    "sizes": {"cols": ["Size", "Net, USD", "Per entry", "Verdict"], "chosen": 0 if SIZED else None, "rows": [["1x" if SIZED else "1x info only", sgn(TS["net"], 0), sgn(TS["per"], 2), "PASS" if SIZED else "FAIL"]]},
    "footer": [_cut(f"Registered as {RUN_ID} before the engine ran; {N_TRIALS} cells on the train and validation days, the test days read once.", 160),
               _cut("The Polymarket days are those of um-003 and um-004: one window, one regime, not an independent observation.", 160),
               _cut(f"{HOURS_ALL}h, {VERIFY['passed']}/{VERIFY['total']} checks; Binance and Polymarket clocks taken as one.", 160)]}
_probs = REPORT.card_problems(CARD, metrics={k_: (None if v_ is None else float(v_)) for k_, v_ in METRICS.items()}, gates={g_["id"]: g_ for g_ in GATES}, word=WORD, carry=False)
assert not _probs, _probs
''', spec))
    nb.code(sub(r'''
# ---- the study manifest fund.study/1 (directional format, systematic style) ----
import hashlib
from fundplat.data.predmkts import updown15_pin
from fundplat.data import derived
from fundplat.data.crypto import ticks
STUDY_GATES = [{k_: g_[k_] for k_ in ("id", "section", "name", "label", "reading", "verdict", "would_change")} for g_ in GATES]
_series, _unpinned = [], []
_ms = lambda d_: int(dt.datetime.strptime(d_, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
for d_ in dict.fromkeys(DAYS_ALL):
    key_ = RUNNER.key_of(d_, LAT_MS)
    m_ = derived.meta(TT.DATASET, key_)
    _series.append(dict(spec=f"tf15:{d_}:decision-table:-", pin=m_["hash"], rows=int(COV.drop_duplicates("day").set_index("day").loc[d_, "with_book"]), first_ts=_ms(d_), last_ts=_ms(d_) + 86_399_999, handle=None, cls="pin", trunc=False))
    try:
        ip_ = updown15_pin.input_pin(d_)
        _series.append(dict(spec=f"polymarket:updown15 {d_}:l2-ladders:-", pin=hashlib.sha256(f"updown15-l2:{d_}:{ip_['digest']}".encode()).hexdigest(), rows=int(ip_["rows"]), first_ts=_ms(d_), last_ts=_ms(d_) + 86_399_999, handle=None, cls="pin", trunc=False))
    except KeyError as e_:
        _unpinned.append({"what": f"polymarket updown15 ladders {d_}", "why": f"the day is not finalized by the ladder job ({str(e_)[:60]})"})
for s_ in ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"):
    ip_ = ticks.input_pin(s_, _ms(DAYS_ALL[0]), _ms(DAYS_ALL[-1]) + 86_400_000)
    _series.append(dict(spec=f"binance:{s_}:aggTrades:-", pin=hashlib.sha256(f"binance:{s_}:{ip_['digest']}".encode()).hexdigest(), rows=int(sum(f["rows"] for f in ip_["files"])), first_ts=_ms(DAYS_ALL[0]), last_ts=_ms(DAYS_ALL[-1]) + 86_399_999, handle=None, cls="pin", trunc=False))
_unpinned.append({"what": "gamma market list (updown15.markets)", "why": "a day cache of the venue's own listing, re-readable; its outcomes are inside the derived days' pins"})
if XR:
    _unpinned.append({"what": "days outside the registered split: " + ", ".join(f"{k_} {v_[0].days[0]} to {v_[0].days[-1]}" for k_, v_ in XR.items()), "why": "read after the registered test days for the record; not part of the registered inputs digest"})
INPUTS = {"digest": REPORT.inputs_digest([x_["pin"] for x_ in _series]), "series": _series, "unpinned": _unpinned}
PROFILE = {"market": "predmkts", "markets": ["predmkts", "crypto"], "venues": ["polymarket", "binance"], "instruments": ["BTC, ETH, SOL, XRP 15m Up/Down", "spot aggTrades"], "bar": "15m"}
COMPONENTS = [{"name": "PnL before costs", "usd": float(ENT["gross"].sum())}, {"name": "fees net of rebate", "usd": -float(ENT["fee"].sum())}]
assert abs(sum(c_["usd"] for c_ in COMPONENTS) - TS["net"]) < 0.01, "the PnL parts do not add to the net"
FIG_KINDS = {"fig:s3-grid": "parameter-surface", "fig:s3-equity": "equity-curve", "fig:s4-placebo": "significance-test", "fig:s4-delay": "signal-decay", "fig:s5-price": "calibration", "fig:s5-daily": "out-of-sample-test"}
FIG_KINDS.update(@@EXTRA_FIG_KINDS@@)
assert {f_["id"] for f_ in FIGURES} == set(FIG_KINDS), set(FIG_KINDS) ^ {f_["id"] for f_ in FIGURES}
for f_ in FIGURES:
    f_["kind"] = FIG_KINDS[f_["id"]]
CAVEATS = [f"{len(TEST_DAYS)} test days of one regime: one observation of the regime, not a promise",
           "the Polymarket days are those of um-003 and um-004: one window, not an independent observation",
           f"{N_TRIALS} cells tried on the train and validation days: the chosen cell's validation number is flattered",
           "the Binance trade-implied mid stands in for the Chainlink reference (about 1.9 bp apart, sd 0.8 bp)",
           "the book is a reconstruction of the venue's stream; Binance and Polymarket clocks taken as one",
           "a resting order joins the back of the queue and fills only from printed trades, with no cancels ahead",
           "the 150 ms taker delay is read from the venue changelog; no fact card carries it yet",
           "the first decision is 5 s after the start; thin markets (SOL, XRP) can have no book yet"]
assert all(len(c_) <= 110 for c_ in CAVEATS), [len(c_) for c_ in CAVEATS]
HEADLINE = {"metric": "net PnL per entry, USD, test days", "label": "Net per entry", "value": float(TS["per"]), "unit": "usd", "hurdle": 0.0, "gate": "G2"}
EQ = [(dt.datetime.fromtimestamp(_ms(TEST_DAYS[0]) / 1000, dt.timezone.utc) + dt.timedelta(minutes=15 * int(i_)), float(BOOK_USD + v_)) for i_, v_ in enumerate(_eq)] or [(dt.datetime.fromtimestamp(_ms(TEST_DAYS[0]) / 1000, dt.timezone.utc), BOOK_USD)]
STUDY = REPORT.build_manifest(
    id=STUDY_ID, kind=KIND, desk=DESK, title=TITLE, question=QUESTION, status="registered", run={"executed": RUN_AT, "kernel": "ccvenv"}, inputs=INPUTS, window=WINDOW,
    verify={"suite": VERIFY["suite"], "passed": VERIFY["passed"], "total": VERIFY["total"], "books": VERIFY["books"]}, gates=STUDY_GATES, figures=FIGURES, verdict=VERDICT, caveats=CAVEATS,
    headline=HEADLINE, components=COMPONENTS, summary=CARD, format="directional", style="systematic", metrics=METRICS, na=NA,
    strategy={"name": "@@STRATEGY_NAME@@", "thesis": "@@THESIS_SHORT@@", "market": "prediction markets", "instruments": ["BTC", "ETH", "SOL", "XRP"], "venues": ["Polymarket", "Binance (input)"], "style": "@@STYLE@@"},
    rules={"entry": _cut(CHOSEN["name"], 60), "exit": "hold to the outcome", "sizing": f"{usd(CLIP_USD)} a trade", "rebalance": None, "hedge": None, "hold": "to expiry", "stop": None, "cost": "taker fee 0.07 x p(1-p) or maker rebate; +150 ms"},
    params={"clip": {"value": CLIP_USD, "unit": "usd", "source": "owner"}, "latency_ms": {"value": float(LAT_MS), "unit": "ms", "source": "[1]"}, "fee_rate": {"value": 0.07, "unit": "rate", "source": "[API]"}},
    equity=EQ, profile=PROFILE, book=None)
S0_HANDLE.update(Markdown(REPORT.summary_md(STUDY)))
display(REPORT.display_bundle(STUDY), raw=True)
print("\n".join(l_.replace("RESULT @@RUN_ID@@ ", "") for l_ in RESULT_LINES))
''', spec), "manifest")
    nb.md(r'''
## A · Appendix

The whole registered grid with train and validation numbers, and the entries of the chosen cell on the test days.
''')
    nb.code(r'''
if len(GRID) > GRID_MAX:
    display(Markdown(f"**Registered grid: the 300 best validation cells of {len(GRID)}** (the whole grid is in the generator's `grid()`; every cell's train and validation numbers are in the run's record)"))
    display(HTML(GRID.sort_values("valid per", ascending=False).head(300).round(3).to_html(index=False, border=0)))
else:
    display(Markdown("**Registered grid**"))
    display(HTML(GRID.round(3).to_html(index=False, border=0)))
display(Markdown("**Every entry of the chosen cell, test days** (k: decision second from the window start; T: seconds left)"))
display(HTML(TEST_FRAME[["date", "coin", "k", "T", "side", "shares", "vwap", "cost", "fee", "won", "gross", "net"]].round(3).to_html(index=False, border=0)))
''')
    nb.md(r'''
## Research summary
''')
    nb.code(r'''
assert [g1_["verdict"] for g1_ in STUDY["gates"]] == [g1_["verdict"] for g1_ in GATES] and STUDY["verdict"]["word"] == WORD and len(STUDY["figures"]) == len(FIGURES)
display(Markdown(HEADLINE_MD))
display(HTML(summary_card.render(CARD, carry=False)))
display(Markdown("**Gates**\n\n| Gate | Verdict |\n|---|---|\n" + "\n".join(f"| {g_['id']} {g_['label']}: {g_['reading']} | **{g_['verdict']}** |" for g_ in GATES)))
''', "summary")
    nbk = new_notebook(cells=nb.cells, metadata={"kernelspec": {"name": "ccvenv", "display_name": "ccvenv", "language": "python"}, "language_info": {"name": "python"}})
    path = out or NOTEBOOK
    if not execute:
        nbformat.write(nbk, path)
        return 0
    t0 = time.time()
    tick = [t0]

    def done(cell, cell_index, execute_reply):
        now = time.time()
        print(f"  cell {cell_index} done in {now - tick[0]:.0f}s", flush=True)
        tick[0] = now

    NotebookClient(nbk, timeout=7200, kernel_name="ccvenv", allow_errors=True, on_cell_executed=done, resources={"metadata": {"path": str(HERE)}}).execute()
    errs = 0
    for i, c in enumerate(nbk.cells):
        if c.cell_type != "code":
            continue
        for o in c.get("outputs", []):
            if o.get("output_type") == "error":
                errs += 1
                print(f"--- cell {i} ERROR {o['ename']}: {o['evalue']}")
                print("\n".join(o.get("traceback", [])[-6:]))
            elif o.get("output_type") == "stream":
                print(f"[{i}] " + o.get("text", "").rstrip()[:1500])
            if "data" in o and "image/png" in o["data"]:
                raw = base64.b64decode(o["data"]["image/png"])
                im = Image.open(io.BytesIO(raw)).convert("RGB").quantize(colors=256)
                buf = io.BytesIO()
                im.save(buf, format="PNG", optimize=True)
                o["data"]["image/png"] = base64.b64encode(buf.getvalue()).decode()
    if errs:
        print(f"NOT WRITTEN: {errs} cell error(s); {path.name} keeps its last good run")
        return 1
    nbformat.write(nbk, path)
    print(f"wrote {path.name}: {path.stat().st_size / 1e6:.2f} MB, {errs} errors, {time.time() - t0:.0f}s")
    return 0
