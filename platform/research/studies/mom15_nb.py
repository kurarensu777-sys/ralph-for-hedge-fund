"""The notebook generator of B-0660 (directional momentum in the 15-minute Up/Down windows): the words are here, every number is computed by the cells from `mom15_*` and the
decision tables. Output: `2026-10-08-predmkts-binance-momentum-15m-updown.ipynb`, kind strategy, format directional, style systematic, run um-009; since 2026-10-10 built through
`mom15_merge` (the diagnosis of the chosen pair on all 22 days sits in its S5; the two diagnosis notebooks are retired).

    ../../../.venv/Scripts/python 2026-10-08-predmkts-binance-momentum-15m-updown.build.py
"""
from __future__ import annotations

import base64
import io
import sys
import time
from pathlib import Path

import nbformat
from nbclient import NotebookClient
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook
from PIL import Image

HERE = Path(__file__).resolve().parent
STEM = "2026-10-08-predmkts-binance-momentum-15m-updown"
RUN_ID = "um-009"


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


def cells(nb: NB):
    # ------------------------------------------------------------------------------------ S0
    nb.md(r'''
# Does a big Binance move predict the next move on Polymarket's 15-minute Up/Down markets, and over what lookback and exit does it pay?

## S0 · Summary
''')
    nb.code(r'''
from IPython.display import Markdown, display
ANS0 = display(Markdown("_The answer is written here when the run finishes._"), display_id=True)
''')
    nb.md(r'''

**Research question.** When Binance moves by z standard deviations over a lookback of L (one second to five minutes), does buying the Polymarket 15-minute Up or Down token in the move's direction 250 ms later earn a positive net PnL per entry after the taker fee, the spread and the delay, and which exit (hold to expiry, take-profit, time exit, trailing stop) harvests it?

**The idea.** A directional momentum trade, not a latency race: the edge claimed is that a large recent move predicts the next one, so the 250 ms between signal and fill is an accepted cost. The earlier study (um-004) tested only the one-second burst and found it does not predict the window's final direction; a slow move (minutes) held to expiry was untested.

| | |
|---|---|
| Market | Polymarket 15-minute crypto Up/Down (BTC, ETH, SOL, XRP), driven by Binance spot trades |
| The trade | a Binance move of at least z sigma over lookback L fires; buy USD 20 of the token in the move's direction 250 ms later on the exact ladder; exit by the rule under test; one entry per window |
| Costs, always on | the market's own taker fee on the way in and on an early exit, the exact ladder walked 250 ms after the decision, the venue's 5-share minimum |
| Money test | net USD per entry out of sample with a 95% interval over 15-minute slots; win rate beside the share needed to break even; Sharpe; the deflated Sharpe for every cell tried |
| Days, in date order | fit, validate and test, listed in S1.1; the test days are opened once, for the one pair the stages choose |
| Four stages | base (hold to expiry), exit sweep, signal sweep (lookback x z, two-lookback confirmation), then the chosen exit x signal on the test days |
| Found means | the test interval of net per entry above zero, the placebo beaten, the planted peek caught, positive at 150 and 250 ms and at twice the fee, both test days above zero, and the sizing gate cleared; otherwise a recorded miss |
| Pre-registration | run um-009 on the predmkts desk, committed before any validation or test day was scored |

The result and its gates are drawn by the last cells.

**Falsifier, written before the validation and test days were scored.** The study ends with NO MONEY if any line below holds.

| Id | The study ends if |
|---|---|
| F1 | the chosen pair's net per entry on the test days is zero or below, or its 95% interval over 15-minute slots includes zero |
| F2 | the pair does not beat the same firing seconds with random sides (placebo, 95th percentile), or the planted peek is not caught |
| F3 | net per entry is not above zero at the 150 ms and 250 ms fills, or not above zero at twice the fee |
| F4 | the pair is not above zero on both test days, or was not positive on the fit days as well as on the validation days |
''')
    nb.md(r'''
**Prior art** (carried from the desk's books, read 2026-10-08; not re-read today [1])

| Source | What it found | What we take from it |
|---|---|---|
| `2026-10-07-predmkts-binance-price-signal-15m-updown` (um-004) | the one-second Binance burst predicts the next 150 ms to 5 s by under a basis point, and its Polymarket backtest earned about +0.9 USD per entry with an interval that spans zero | the fast leg is small; the slow leg (minutes, held to expiry) was never run |
| Young 2026 (OpenMarket, arXiv 2607.26245; read 2026-10-07 [1]) | Polymarket quotes followed large Binance moves by a median 347 ms | a stale book is a latency race; this study accepts the delay and asks about direction instead |
| the B-0654 strategy search (um-005 to um-008) | taker rules at 150 ms die on the fee; every pooled out-of-sample interval includes zero | the fee on both legs is the bar an early exit has to clear |
''')
    nb.code(r'''
from IPython.display import Markdown, display
S0_HANDLE = display(Markdown("_The summary card is drawn here when the run finishes._"), display_id=True)
''', "s0")
    # ------------------------------------------------------------------------------------ S1
    nb.md(r'''
## S1 · Setup

### S1.1 · Parameters
''')
    nb.code(r'''
# ---- parameters: ours, never a venue number (the fee, the delay and the minimum order are S1.2) ----
STUDY_ID = "2026-10-08-predmkts-binance-momentum-15m-updown"
KIND = "strategy"
DESK = "lab/predmkts"
RUN_ID = "um-009"
TITLE = "Does a big Binance move predict the next move on Polymarket's 15-minute Up/Down markets, and over what lookback and exit does it pay?"
QUESTION = "Does buying the 15-minute Up/Down token in the direction of a Binance move of z sigma over lookback L earn a positive net PnL per entry after fees, spread and a 250 ms fill, and which exit pays?"
SEED = 7
FIT_DAYS = ("2026-09-30", "2026-10-01", "2026-10-02")
VALIDATE_DAYS = ("2026-10-03", "2026-10-04")
TEST_DAYS = ("2026-10-05", "2026-10-06")
EARLIER_WEEK = ("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29")
FRESH_DAY = ("2026-10-07",)
LOOKBACKS_S = (1, 5, 10, 30, 60, 180, 300)
Z_GRID = (1.5, 2.0, 2.5, 3.0)
MULTI = ((1, 60), (10, 60), (10, 300), (60, 300))
TP_SIGMA, TIME_EXIT_S, TRAIL_SIGMA = (1, 2, 3), (10, 30, 60, 300), (1, 2)
BASE_L, BASE_Z = 1, 2.0
CLIP_USD = 20.0
BOOK_USD = 1000.0
FILL_MS = 250
LIMIT = 0.97
KMIN_S, TMIN_S = 10, 60
N_MIN = 30
''', "parameters")
    nb.md(r'''
### S1.2 · Assumptions

| Item | Value | Source |
|---|---|---|
| Fill delay | 250 ms between the decision and the order meeting the book (the venue's own taker delay, 150 ms, is read in the delay table of S4) | the owner's brief (B-0660); venue changelog 2026-09-04 [1] |
| Taker fee | shares x rate x p x (1 - p), each market's own rate (0.07 on every market read) and exponent 1, paid on the way in and again on an early exit | venue fact `fee.formula` [1]; market rows [API] |
| Minimum order | 5 shares; an entry under it does not fill and a later firing second of the window is tried | market rows [API] |
| Clip | USD 20 a trade, USD 1,000 book, 1x, one position per window (the four coins may be held together) | the brief |
| Price limit | a token is not bought above 0.97 | design [U] |
| Entry fill | the Up ladder of the book row as of decision + 250 ms (the Down token is the venue's mirror of it), four levels, best first | design |
| Exit fill | the bid ladder as of exit second + 250 ms, four levels, best first; what the bids do not take is held to expiry | design |
| Signal | z = ln(S_t / S_(t-L)) / (sigma sqrt L); S the Binance trade-implied mid, sigma the tables' causal per-second volatility (300 s half-life EWMA of 10 s squared returns) | the 15-minute study (B-0642) |
| Eligible seconds | 10 s after the window starts to 60 s before it ends; the first second whose ladder fills is the entry | design [U], written before scoring |
| Exit unit | one sigma = sigma_t sqrt(L_signal) at the entry second: the std of one lookback move, the unit the trigger is in | design [U], written before scoring |
| Outcome | the market's own recorded resolution | market rows [API] |
| Clocks | Binance trade time and the venue's book time taken as one clock | caveat |
''')
    nb.code(r'''
# ---- the PROSE check: the numbers the S1 tables state, held to the code ----
import mom15_bt as M, mom15_study as ST, mom15_figs as F, mom15_path as P, mom15_report as MR
import tf15_bt as B, tf15_report as RP, tf15_figs as FIGS, tf15_runner as RUNNER, tf15_table as TT, lift_figs as LF
PROSE = {"delay": (ST.FILL_MS, FILL_MS), "clip": (B.CLIP_USD, CLIP_USD), "min shares": (B.MIN_SHARES, 5.0), "price limit": (M.LIMIT, LIMIT), "first decision": (M.KMIN, KMIN_S),
         "last entry left": (M.TMIN, TMIN_S), "levels": (TT.L, 4), "min entries": (ST.N_MIN, N_MIN)}
BAD = {k_: v_ for k_, (v_, w_) in PROSE.items() if v_ != w_}
assert not BAD, f"the S1 tables no longer describe this run: {BAD}"
# the run IS the defaults it claims
assert (ST.FIT, ST.VALIDATE, ST.TEST) == (FIT_DAYS, VALIDATE_DAYS, TEST_DAYS) and ST.EARLIER_WEEK == EARLIER_WEEK and ST.FRESH_DAY == FRESH_DAY
assert M.LS == LOOKBACKS_S and M.ZS == Z_GRID and ST.MULTI == MULTI and (ST.BASE.L, ST.BASE.z) == (BASE_L, BASE_Z)
assert [e_.p for e_ in M.EXITS if e_.kind == "tp"] == list(TP_SIGMA) and [e_.p for e_ in M.EXITS if e_.kind == "time"] == list(TIME_EXIT_S) and [e_.p for e_ in M.EXITS if e_.kind == "trail"] == list(TRAIL_SIGMA)
print(f"S1 tables: {len(PROSE)} stated numbers equal the code; the parameters cell equals the module defaults")
''')
    nb.md(r'''
### S1.3 · Data

Every input is a pinned or stored day read through `fundplat.data`: the Binance spot trades (`ticks.day_frame`) and the exact Up-token ladders of every 15-minute market (`updown15_pin.read`, pinned once by the platform's ladder job). Two derived tables are seated in `fundplat.data.derived` from them: the 1-second decision table of the strategy search built for a 250 ms fill (`tf15_runner.py run --fill-ms 250`) and the Binance 1-second path from ten minutes before each day (`mom15_path.py run`), which carries the lookbacks past the table's own minute.

| source | what | window | guard |
|---|---|---|---|
| `ticks.day_frame` | Binance spot aggTrades BTC, ETH, SOL, XRP | the days of S1.1 and the day before each | the file checksum in the day's meta |
| `updown15_pin.read` | Polymarket Up-token ladder after every event, all four coins | the days of S1.1 | the platform's day manifest digest |
| `updown15.markets` | the market list with fee schedule, reference price and recorded outcome | the days of S1.1 | the platform's coverage check |
| `derived tf15-table` | the 1 s decision table per day, fill delay 250 ms | the days of S1.1 | the derived blob's hash, pinned in the manifest |
| `derived mom15-path` | the 1 s Binance mid per coin, 10 minutes before the day to its last second | the days of S1.1 | the derived blob's hash, pinned in the manifest |
''')
    nb.code(r'''
import datetime as dt, json, math, time
import numpy as np, pandas as pd
from IPython.display import HTML, Markdown, display
from fundplat.quant.core import figstyle, report as REPORT, summary_card
get_ipython().run_line_magic("config", "InlineBackend.print_figure_kwargs = {'bbox_inches': None}")
LF.setup()
RUN_AT = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
assert max(FIT_DAYS) < min(VALIDATE_DAYS) and max(VALIDATE_DAYS) < min(TEST_DAYS), "the split is not in date order"
print("loading the seated decision tables and Binance paths for", FIT_DAYS + VALIDATE_DAYS, "(the test days stay closed until the pair is chosen)")
t0 = time.time()
TABS = {"fit": M.MTab(FIT_DAYS, fill_ms=FILL_MS), "validate": M.MTab(VALIDATE_DAYS, fill_ms=FILL_MS)}
GATE = ST.TestGate(lambda: M.MTab(TEST_DAYS, fill_ms=FILL_MS))
print({k_: f"{v_.W} windows" for k_, v_ in TABS.items()}, f"{time.time() - t0:.0f}s")
DAYS_ALL = FIT_DAYS + VALIDATE_DAYS + TEST_DAYS
HOURS_ALL = 24 * len(DAYS_ALL)
WINDOW = {"from": f"{DAYS_ALL[0]}T00:00Z", "to": f"{(dt.date.fromisoformat(DAYS_ALL[-1]) + dt.timedelta(days=1)).isoformat()}T00:00Z", "hours": HOURS_ALL, "regimes": 1}
pct = lambda v, d=1: f"{v * 100:.{d}f}%"
sgn = lambda v, d=2: f"{v:+,.{d}f}"
usd = lambda v, d=0: f"USD {v:,.{d}f}"
WIN_FV = f"{FIT_DAYS[0][5:]} to {VALIDATE_DAYS[-1][5:]} · {24 * (len(FIT_DAYS) + len(VALIDATE_DAYS))}h · fit and validation days"
WIN_VAL = f"{VALIDATE_DAYS[0][5:]} to {VALIDATE_DAYS[-1][5:]} · {24 * len(VALIDATE_DAYS)}h · validation days"
WIN_TEST = f"{TEST_DAYS[0][5:]} to {TEST_DAYS[-1][5:]} · {24 * len(TEST_DAYS)}h · test days"
FIGURES, GATES, CAVEATS = [], [], []
''')
    nb.md(r'''
### S1.4 · Runs

The engine's own checks run here; every one that can fail is counted.
''')
    nb.code(r'''
print("mom15_bt:"); ok_m = M.selftest()
print("tf15_bt:"); ok_b = B.selftest()
assert ok_m and ok_b, "an engine check failed"
VERIFY = {"suite": "mom15 engine checks and planted tests", "passed": 19, "total": 19, "books": sum(t_.W for t_ in TABS.values())}      # 14 + 5 engine cases above; the planted lead, the planted peek and the test-gate door below add three, held by the gates
''')
    # ------------------------------------------------------------------------------------ S2
    nb.md(r'''
## S2 · Data checks

| question | gate to S3 |
|---|---|
| Is there a book for the windows, is the 1 s Binance path the table's own series, does the sweep's z equal the tables' z, and do the planted tests behave? | at least 90% of windows have a book; the path equals the table at every whole second; the planted lead and the second opening of the test days are caught |
''')
    nb.code(r'''
# ---- coverage of the tables: windows with a book by the first decision second ----
COV = []
for role_, days_ in (("fit", FIT_DAYS), ("validate", VALIDATE_DAYS), ("test", TEST_DAYS)):
    for d_ in days_:
        arrs_, meta_ = RUNNER.load(d_, FILL_MS)
        COV.append(dict(role=role_, day=d_, windows=int(meta_["windows"]), with_book=int(meta_["ok"]), share=meta_["ok"] / meta_["windows"], fill_ms=int(meta_["fill_ms"])))
COV = pd.DataFrame(COV)
assert (COV.fill_ms == FILL_MS).all()
display(Markdown("**Windows with a book by the first decision second** (the other windows have no ladder, or a Binance gap over 30 s, and are out before any outcome is read)\n\n| Role | Day | Windows | With a book | Share |\n|---|---|---|---|---|\n" +
                 "\n".join(f"| {r.role} | {r.day} | {r.windows} | {r.with_book} | {pct(r.share)} |" for r in COV.itertuples())))
SHARE = float(COV.with_book.sum() / COV.windows.sum())
GATES.append({"id": "G1", "section": "S2", "label": "Windows have a book", "name": "at least 90% of windows have a ladder by the first decision second", "reading": f"{pct(SHARE)} of {int(COV.windows.sum())} windows",
              "verdict": "PASS" if SHARE >= 0.9 else "FAIL", "would_change": "a share below 90%"})
''')
    nb.code(r'''
# ---- the 1 s path is the table's series, and the sweep's z is the tables' own z where both exist ----
_t = TABS["fit"]
_eq = bool(np.array_equal(_t.Sg[:, M.PRE:M.PRE + _t.NK].astype(np.float32), _t.S))          # also asserted when a table is built
_dz = {L_: float(np.nanmax(np.abs(_t.zlook(L_) - _t.zl[:, :, i_]))) for i_, L_ in enumerate((10, 30, 60))}
display(Markdown(f"**Path against table.** The 1 s Binance mid equals the table's `S` at every whole second of {_t.W} fit windows: **{_eq}**. The sweep's z for lookbacks 10, 30 and 60 s differs from the tables' own `zl` columns by at most "
                 + ", ".join(f"{v_:.1e} ({L_} s)" for L_, v_ in _dz.items()) + " (the table keeps float32)."))
_ok = _eq and max(_dz.values()) < 1e-3
GATES.append({"id": "G2", "section": "S2", "label": "Path equals the table", "name": "the 1 s path equals the table's S and the sweep's z equals the tables' own z for 10, 30 and 60 s", "reading": f"path equal {_eq}; worst z difference {max(_dz.values()):.1e}",
              "verdict": "PASS" if _ok else "FAIL", "would_change": "a path that drifts from the table"})
''')
    nb.code(r'''
# ---- planted tests: a signal that reads the FUTURE must pay far more, and the test days must open only once ----
_ex0 = M.Exit("expiry")
LEAK = {}
for lead_ in (0, 5, 30):
    sg_ = M.Signal(BASE_L, BASE_Z, lead=lead_)
    es_ = [M.run(TABS[r_], sg_, _ex0) for r_ in ("fit", "validate")]
    LEAK[lead_] = M.summarize(M.pool(es_), None, f"lead {lead_} s")
display(Markdown("**Planted lead** (the base signal reading the Binance mid `lead` seconds from the future, hold to expiry, fit and validation days)\n\n| Lead | Entries | Win | Net per entry |\n|---|---|---|---|\n" +
                 "\n".join(f"| {k_} s{' (the real signal)' if k_ == 0 else ''} | {v_['n']} | {pct(v_['win'])} | {sgn(v_['per'])} |" for k_, v_ in LEAK.items())))
_lead_ok = LEAK[5]["per"] > LEAK[0]["per"] + 1.0 and LEAK[30]["per"] > LEAK[0]["per"] + 1.0
_g = ST.TestGate(lambda: None)
_g.open("planted"); _door = False
try:
    _g.open("a second look")
except RuntimeError:
    _door = True
_early = False
try:
    ST.TestGate(lambda: None).diag()
except RuntimeError:
    _early = True
GATES.append({"id": "G3", "section": "S2", "label": "Planted tests caught", "name": "a 5 s and a 30 s lead pay at least 1 USD an entry more than the real signal; the test days refuse a second opening and a look before the pair is chosen",
              "reading": f"lead 5 s {sgn(LEAK[5]['per'])}, 30 s {sgn(LEAK[30]['per'])}, real {sgn(LEAK[0]['per'])}; second opening refused {_door}, early look refused {_early}", "verdict": "PASS" if (_lead_ok and _door and _early) else "FAIL", "would_change": "a harness that cannot tell a leak"})
VERIFY["total"] += 3
VERIFY["passed"] += int(_lead_ok) + int(_door) + int(_early)
''')
    # ------------------------------------------------------------------------------------ S3
    nb.md(r'''
## S3 · Core result

| question | gate to S4 |
|---|---|
| Does fast momentum predict the window's final direction (stage 1), which exit harvests the most (stage 2), which lookback and threshold (stage 3, then the exit again), and does the chosen pair earn on the test days (stage 4)? | the pair chosen on the validation days earns above zero on the fit days too; on the test days its net per entry is above zero |

**The protocol, fixed before any validation or test day was scored** (run um-009). Stage 1 is the base (L 1 s, z 2, hold to expiry). Stage 2 sweeps ten exits at the base signal. Stage 3 sweeps the lookback x z grid and four two-lookback confirmations at the stage 2 exit. The exit sweep is run again at the stage 3 signal (a slow lookback may change the exit). Stage 4 reads the chosen pair once on the test days. The choice rule at every stage: among cells with at least 30 entries on the fit and on the validation days, those positive on the fit days are qualified; the chosen cell is the qualified one with the best net per entry on the validation days; with none qualified the best validation cell is carried and the run is a miss by construction. The unit of error is a 15-minute slot, never an entry.
''')
    nb.md(r'''
### Does a big move keep going?
''')
    nb.code(r'''
ANS1 = display(Markdown("_The answer is written here when the run reaches the test days._"), display_id=True)
''')
    nb.md(r'''
A move is big when it is several times the usual size of a move over the same look-back. How many times (the threshold z) and how far back (the look-back L) are the two things swept below, in four stages. Every stage is scored on the fit and validation days; the test days stay closed until the pair is chosen.
''')
    nb.code(r'''
# ---- stages 1 to 3 and the loop back: every cell scored on the fit and validation days; the test days stay closed ----
t0 = time.time()
STUDY = ST.Study(TABS["fit"], TABS["validate"], log=print)
ST_OUT = STUDY.run_stages()
print(f"stages run in {time.time() - t0:.0f}s")
S2R, S3R, LOOPR = ST_OUT["stage2"], ST_OUT["stage3"], ST_OUT["loop"]
SIG_STAR, EX_STAR, EX1 = ST_OUT["s_star"], ST_OUT["e_star"], ST_OUT["e1"]
N_TRIALS = ST_OUT["n_trials"]
CHOSEN_KEY = ST.key(SIG_STAR, EX_STAR)
assert N_TRIALS == len({r_["key"] for sw_ in (S2R, S3R, LOOPR) for r_ in sw_["rows"]}), "the trial count is not the distinct cells scored"
display(Markdown("**Tests run, and what each count is.** " + f"Stage 1: 1 cell. Stage 2: {len(S2R['rows'])} cells. Stage 3: {len(S3R['rows'])} cells. Loop back: {len(LOOPR['rows'])} cells. Distinct cells scored on the validation days: **{N_TRIALS}** (the deflated Sharpe is charged for all of them). "
                 f"Stage 4: the one chosen pair, on the test days, once. Everything above is exploratory (fit and validation days); the test read and the days of S4 outside the split are the out-of-sample confirmation."))
''')
    nb.md(r'''
**Stage 1. Does the one-second burst predict the window's final direction?**

The base trade: z at least 2 over one second, buy the direction, hold to expiry. The win share of the momentum side is the direct answer; the price paid is what it has to beat.
''')
    nb.code(r'''
S1R = ST_OUT["stage1"]
_rows = []
for role_ in ("fit", "validate"):
    s_ = S1R[role_]
    _rows.append({"days": role_, "entries": s_["n"], "momentum side won": s_["win"], "Wilson lo": s_["win_lo"], "Wilson hi": s_["win_hi"], "break-even (price + fee)": s_["breakeven"], "gross per entry": s_["gross_per"],
                  "fees per entry": s_["fee_per"], "net per entry": s_["per"], "95% lo": s_["per_lo"], "95% hi": s_["per_hi"]})
_pool = M.pool([S1R["fit"]["entries"], S1R["validate"]["entries"]])
_sp = B.summarize(_pool)
_rows.append({"days": "fit + validate", "entries": _sp["n"], "momentum side won": _sp["win"], "Wilson lo": _sp["win_lo"], "Wilson hi": _sp["win_hi"], "break-even (price + fee)": _sp["breakeven"], "gross per entry": _sp["gross_per"],
              "fees per entry": _sp["fee_per"], "net per entry": _sp["per"], "95% lo": _sp["per_lo"], "95% hi": _sp["per_hi"]})
S1T = pd.DataFrame(_rows)
display(HTML(S1T.round(3).to_html(index=False, border=0)))
_win_beats = _sp["win_lo"] > 0.5
display(Markdown(f"Fast momentum **{'does' if _win_beats else 'does not'} predict the final direction beyond a coin flip**: the momentum side won {pct(_sp['win'])} of {_sp['n']} entries (Wilson {pct(_sp['win_lo'])} to {pct(_sp['win_hi'])}). The book prices the same move: the price paid plus the fee asks {pct(_sp['breakeven'])} to break even. "
                 f"Before costs the base earns {sgn(_sp['gross_per'])} USD an entry; the fee takes {_sp['fee_per']:.2f}; net {sgn(_sp['per'])} (95% by slot {sgn(_sp['per_lo'])} to {sgn(_sp['per_hi'])})."))
''')
    nb.code(r'''
_e1 = S1R["validate"]["entries"]; _tv = TABS["validate"]
_bb1 = MR.band_frame(_e1, _tv)
figstyle.show(F.winrate_fig(_bb1, WIN_VAL, ["Green bars are price bands where the win share beat the break-even share; red where it fell short. The ink tick is the share needed to break even: the price paid plus the fee a share.",
                                           f"{int(_bb1['entries'].max())} entries in the busiest band; {int((_bb1['entries'] < 10).sum())} of {len(_bb1)} bands hold fewer than 10, so read those bars as colour, not as numbers."]), "fig:s3-base-winrate", FIGURES)
''', "fig:s3-base-winrate")
    nb.md(r'''
**Stage 2. Which exit earns the most at the base signal?**

Same signal, ten exits. A take-profit or a trailing stop is measured in sigma of one lookback move, a time exit in seconds; an exit sells into the bid ladder and pays the fee again.
''')
    nb.code(r'''
S2F = MR.cells_frame(S2R)
display(HTML(S2F.round(3).to_html(index=False, border=0)))
_bul = [f"Chosen exit E1: {EX1.name} ({'qualified: positive on the fit days' if S2R['qualified'] else 'no exit was positive on the fit days: the best validation exit is carried and the run is a miss by construction'}).",
        f"{int((S2F['valid per'] > 0).sum())} of {len(S2F)} exits earn above zero on the validation days; the exits that sell before expiry pay the spread and the fee twice.",
        "Bars are net USD per entry on the validation days with a 95% interval over 15-minute slots; the ink tick is the fit days' value."]
figstyle.show(F.exits_fig(S2R["rows"], S2R["chosen"], WIN_VAL, _bul), "fig:s3-exits", FIGURES)
''', "fig:s3-exits")
    nb.md(r'''
**Stage 3. Which lookback and threshold earn the most?**

The lookback L sets the horizon of the prediction: a one-second move predicts seconds, a five-minute move predicts minutes. The grid is every lookback x every threshold, plus four confirmations in which a short and a long lookback both reach z = 2 and agree.
''')
    nb.code(r'''
S3F = MR.cells_frame(S3R)
SURF_V, SURF_F = MR.surface_frame(S3R["rows"], "validate"), MR.surface_frame(S3R["rows"], "fit")
_cs = SIG_STAR
_chosen_cell = (_cs.L, _cs.z) if _cs.Ll is None else None
_wt = {}
for r_ in S3R["rows"]:
    s_ = r_["sig"]
    if s_.Ll is None and s_.z == 2.0:
        _wt[f"{s_.L} s"] = [r_["validate"].get("win", np.nan), r_["validate"].get("breakeven", np.nan)]
_win_tab = pd.DataFrame(_wt, index=["win share", "break-even"])
display(Markdown("**Does a slower move predict the final direction? Win share against the break-even share, z = 2, hold to expiry, validation days**"))
display(HTML((_win_tab * 100).round(1).to_html(border=0)))
_bul = [f"Chosen signal S*: {SIG_STAR.name}{'' if S3R['qualified'] else ' (no cell was positive on the fit days: the best validation cell is carried, a miss by construction)'}; the exit held fixed is {EX1.name}.",
        f"{int((SURF_V.to_numpy() > 0).sum())} of {SURF_V.size} single-lookback cells earn above zero on the validation days and {int((SURF_F.to_numpy() > 0).sum())} on the fit days: the two windows do not agree on where the money is.",
        "Green is a gain, red a loss, in USD per entry after both fees and the 250 ms fill; the outline marks the chosen cell when it is a single-lookback cell."]
figstyle.show(F.surface_fig(SURF_V, _chosen_cell, WIN_VAL, _bul, question="Does any lookback and threshold earn on the validation days, or is the best one a spike?"), "fig:s3-surface-validate", FIGURES)
''', "fig:s3-surface-validate")
    nb.code(r'''
_bul = ["The same grid on the fit days, which chose nothing by itself: a lookback that earns here and loses on the validation days is a result of the days, not of the lookback.",
        f"At z = 2 the win share rises with the lookback, to {pct(float(np.nanmax(_win_tab.loc['win share'].to_numpy())))} at best on the validation days, but the share the price and fee ask rises with it (table above): the slow move is already in the book."]
figstyle.show(F.surface_fig(SURF_F, _chosen_cell, WIN_FV.replace("fit and validation", "fit"), _bul, question="Does the same grid earn on the fit days?"), "fig:s3-surface-fit", FIGURES)
''', "fig:s3-surface-fit")
    nb.code(r'''
display(Markdown("**Every stage 3 cell** (the exit held at E1)"))
display(HTML(S3F.round(3).to_html(index=False, border=0)))
''')
    nb.md(r'''
**Loop back. Does the stage 3 signal change the best exit?**
''')
    nb.code(r'''
LOOPF = MR.cells_frame(LOOPR)
display(HTML(LOOPF.round(3).to_html(index=False, border=0)))
_bul = [f"Chosen exit E*: {EX_STAR.name} at the signal {SIG_STAR.name} ({'qualified' if LOOPR['qualified'] else 'no exit positive on the fit days: a miss by construction'}).",
        f"{int((LOOPF['valid per'] > 0).sum())} of {len(LOOPF)} exits earn above zero on the validation days.", "Bars are net USD per entry on the validation days with a 95% interval over 15-minute slots; the ink tick is the fit days' value."]
figstyle.show(F.exits_fig(LOOPR["rows"], LOOPR["chosen"], WIN_VAL, _bul, question="Does the stage 3 signal change which exit earns the most?"), "fig:s3-exits-loop", FIGURES)
''', "fig:s3-exits-loop")
    nb.md(r'''
**Stage 4. The pair the stages chose, on the test days.** The test days are opened once, for this pair only.
''')
    nb.code(r'''
# ---- the ONE opening of the test days ----
t0 = time.time()
FR = ST.final_read(GATE, SIG_STAR, EX_STAR, ST_OUT["trial_srs"], N_TRIALS)
TTAB, ENT, TSUM = FR["tab"], FR["entries"], FR["summary"]
print(f"test read in {time.time() - t0:.0f}s; opened for {GATE.opened!r}")
assert GATE.opened == CHOSEN_KEY
_d = RP.by_day(ENT, TTAB)
display(Markdown(f"**Chosen pair {CHOSEN_KEY}, test days {TEST_DAYS[0]} to {TEST_DAYS[-1]}.** {TSUM['n']} entries; win rate {pct(TSUM['win'])} (Wilson {pct(TSUM['win_lo'])} to {pct(TSUM['win_hi'])})"
                 + (f" against {pct(TSUM['breakeven'])} needed to break even (price plus fee); " if TSUM['breakeven'] == TSUM['breakeven'] else " (the share of entries with a positive net, since the exit sells early); ")
                 + f"net {sgn(TSUM['net'], 0)} USD, {sgn(TSUM['per'])} an entry (95% by 15-minute slot {sgn(TSUM['per_lo'])} to {sgn(TSUM['per_hi'])}); before costs {sgn(TSUM['gross_per'])} an entry, fees {TSUM['fee_per']:.2f}."))
display(HTML(_d.round(3).to_html(border=0)))
TEST_FRAME = MR.entries_frame(ENT, TTAB)
EARLY = bool((ENT["ke"] >= 0).any())
''')
    nb.code(r'''
_gap1 = _sp["win"] - _sp["breakeven"]
_lead1 = "No" if not _win_beats else ("Yes" if _gap1 > 0 else "Yes, but not by enough to pay")
ANS1.update(Markdown(f"**{_lead1}.** After a move of at least {BASE_Z:g} standard deviations in one second the same side won {pct(_sp['win'])} of {_sp['n']:,} entries held to expiry ({WIN_FV}), "
                     f"against the {pct(_sp['breakeven'])} that the price paid and the fee ask to break even. Slower moves win more often, but their price rises with them (stage 3)."))
''')
    nb.md(r'''
### What does one trade look like?
''')
    nb.code(r'''
ANS2 = display(Markdown("_The answer is written here when the run reaches the test entries._"), display_id=True)
''')
    nb.code(r'''
# ---- one real entry: the middle entry of the test days by net, from the signal to the settlement ----
_o = np.argsort(ENT["net"], kind="stable")
_m = int(_o[len(_o) // 2])
_r = TEST_FRAME.iloc[_m]
_w_, _k_ = int(ENT["w"][_m]), int(ENT["k"][_m])
_z_ = float(TTAB.zlook(SIG_STAR.L)[_w_, _k_])
_open = dt.datetime.fromtimestamp(int(TTAB.w_start[_w_]) / 1000, dt.timezone.utc)
_sig_at = _open + dt.timedelta(seconds=int(_r["entry_s"]))
_tok = "Up" if int(_r["side"]) > 0 else "Down"
_out = ("held to expiry: the token paid " + ("1 USD a share" if bool(_r["won"]) else "nothing")) if _r["exit_s"] < 0 else f"sold {_r['shares']:.0f} shares at {_r['exit_px']:.3f} {int(_r['exit_s'] - _r['entry_s'])} s later"
display(Markdown(f"**The middle entry of the {TSUM['n']} on the test days, by net** ({WIN_TEST})\n\n| Step | What happened |\n|---|---|\n"
                 f"| The window | {_r['coin'].upper()} 15-minute Up/Down, opened {_open:%Y-%m-%d %H:%M} UTC |\n"
                 f"| The signal | at {_sig_at:%H:%M:%S} UTC, {int(_r['T'])} s before expiry, Binance moved {_z_:+.1f} standard deviations over {SIG_STAR.L} s, with the mid at {float(TTAB.S[_w_, _k_]):,.2f} USD |\n"
                 f"| The entry | {FILL_MS} ms later bought the {_tok} token: {_r['shares']:.0f} shares at {_r['vwap']:.3f} on average, USD {_r['cost']:.2f}, fee USD {_r['fee']:.2f} |\n"
                 f"| The exit | {_out} |\n"
                 f"| The result | net {sgn(_r['net'])} USD |"))
_made = float((ENT["net"] > 0).mean())
ANS2.update(Markdown(f"**The average entry pays {TSUM['vwap'] * 100:.1f} cents a share for a token that {'is sold again later' if EARLY else 'pays 1 or 0 at expiry'}, and {pct(_made)} of the {TSUM['n']} test entries made money** ({WIN_TEST}). "
                     f"The figures below show the worst, the middle and the best entries on the order book."))
''')
    nb.code(r'''
# ---- the L2 view of every entry: the full gallery is one HTML page; the notebook shows the worst, the middle and the best 24 by net ----
from pathlib import Path
GALLERY = Path.home() / "fund-data" / "research" / "momentum-15m-updown" / f"l2-gallery-{RUN_ID}.html"
N_GAL = MR.gallery_html(TTAB, ENT, GALLERY, f"{RUN_ID} {CHOSEN_KEY}: every test entry on its L2 ladder", f"{WIN_TEST} · USD {CLIP_USD:g} a clip · fill {FILL_MS} ms")
assert N_GAL == TSUM["n"]
_order = np.argsort(ENT["net"], kind="stable")
_n = len(_order)
_pick = {"worst": _order[:24], "median": _order[max(0, _n // 2 - 12): max(0, _n // 2 - 12) + 24], "best": _order[-24:]}
display(Markdown(f"**L2 gallery.** All {N_GAL} entries of the chosen pair on the test days, each on its ladder with the levels lifted, the levels sold into and the PnL, are in one page: `{GALLERY}`. The three figures below show the worst, the middle and the best 24 entries by net."))
def l2_page(nm_):
    ix_ = _pick[nm_]
    _bul = [f"The {nm_} {len(ix_)} of {_n} entries by net USD; asks above the line are the levels the buy lifted (dark = shares taken, pale = depth left, cut at twice the shares bought).",
            ("Bids below the line are the levels the exit sold into; the black square is the average price received." if EARLY else "A hold to expiry has no exit ladder: the token pays 1 or 0.") + " The black triangle is the average price paid and points the way the entry bets: upright for a buy of Up, inverted for a buy of Down."]
    return F.l2_pages(TTAB, ENT, [int(i_) for i_ in ix_], WIN_TEST, _bul, per_page=24)[0]
''')
    nb.code(r'''
figstyle.show(l2_page("worst"), "fig:s3-l2-worst", FIGURES)
''', "fig:s3-l2-worst")
    nb.code(r'''
figstyle.show(l2_page("median"), "fig:s3-l2-median", FIGURES)
''', "fig:s3-l2-median")
    nb.code(r'''
figstyle.show(l2_page("best"), "fig:s3-l2-best", FIGURES)
''', "fig:s3-l2-best")
    nb.md(r'''
### Does the edge survive the time it takes to fill?
''')
    nb.code(r'''
ANS3 = display(Markdown("_The answer is written here when the run reaches the delay table._"), display_id=True)
''')
    nb.code(r'''
# ---- the delay: the pair re-run on tables built for each fill delay ----
t0 = time.time()
DELAY = MR.delay_table(SIG_STAR, EX_STAR, TEST_DAYS)
print(f"delay table in {time.time() - t0:.0f}s")
display(HTML(DELAY.round(3).to_html(index=False, border=0)))
_dl = DELAY.set_index("delay_ms")
_bul = [f"Net per entry: {', '.join(f'{sgn(r_.per)} at {int(r_.delay_ms)} ms' for r_ in DELAY.itertuples())}.",
        "The registered fill is 250 ms, the owner's brief; the venue's own taker delay is 150 ms; the others show how much of any edge is the delay."]
figstyle.show(FIGS.delay_fig(DELAY, WIN_TEST, _bul, "How much of the result is the order delay?", bar=250), "fig:s3-delay", FIGURES)
''', "fig:s3-delay")
    nb.code(r'''
ANS3.update(Markdown(f"**{'Yes' if _dl.loc[250, 'per'] > 0 else 'No'}.** The pair makes {sgn(_dl.loc[0, 'per'])} USD an entry with no delay, {sgn(_dl.loc[150, 'per'])} at the venue's own 150 ms and {sgn(_dl.loc[250, 'per'])} at our {FILL_MS} ms fill ({WIN_TEST})."))
''')
    nb.md(r'''
### How much money do we make?
''')
    nb.code(r'''
ANS4 = display(Markdown("_The answer is written here when the run reaches the test days._"), display_id=True)
''')
    nb.code(r'''
_s, _eq, _dd, _ddpath = RP.equity(ENT, TTAB)
_bul = [f"{TSUM['n']} entries of USD {CLIP_USD:g} on the test days: net {sgn(TSUM['net'], 0)} USD, deepest drawdown {usd(_dd)} ({_dd / BOOK_USD * 100:.1f}% of the USD {BOOK_USD:,.0f} book).",
        f"Win rate {pct(TSUM['win'])}; the average price paid is {TSUM['vwap'] * 100:.1f} cents a share.", "Entries are in time order; the shaded band is the distance below the running peak."]
figstyle.show(FIGS.equity_fig(_eq, _ddpath, WIN_TEST, _bul, "Does the chosen pair grow the book on the test days?"), "fig:s3-equity", FIGURES)
''', "fig:s3-equity")
    nb.code(r'''
_bd = RP.by_day(ENT, TTAB)
_pos_days = int((_bd["net"] > 0).sum())
figstyle.show(FIGS.daily_fig(_bd, WIN_TEST, ["Net by day: " + "; ".join(f"{d_[5:]} {sgn(r_.net, 0)}" for d_, r_ in _bd.iterrows()) + " USD.", f"{_pos_days} of {len(_bd)} test days earned above zero. Two days of one regime are one observation of the regime, not a promise."], "Did the chosen pair earn on each test day?"), "fig:s3-daily", FIGURES)
''', "fig:s3-daily")
    nb.code(r'''
figstyle.show(F.win_loss_fig(ENT["net"], WIN_TEST, [f"Mean {sgn(float(ENT['net'].mean()))} USD an entry, median {sgn(float(np.median(ENT['net'])))}; best {sgn(float(ENT['net'].max()))}, worst {sgn(float(ENT['net'].min()))}.",
                                                   f"{pct(float((ENT['net'] > 0).mean()))} of entries are positive."], "What does the chosen pair win and lose on one entry?"), "fig:s3-trades", FIGURES)
''', "fig:s3-trades")
    nb.code(r'''
# ---- each entry in time order: the rolling mean net, and the longest runs ----
_ord = np.argsort(ENT["slot"] * 10 + ENT["asset"], kind="stable")
_net_t = np.asarray(ENT["net"], float)[_ord]
_roll = max(10, min(50, len(_net_t) // 8))
_cs = np.concatenate([[0], np.cumsum(_net_t)])
_rm = (_cs[_roll:] - _cs[:-_roll]) / _roll
def _run(v):
    best = cur = 0
    for x_ in v:
        cur = cur + 1 if x_ else 0
        best = max(best, cur)
    return best
_hours = len(TEST_DAYS) * 24
_bul = [f"Mean {sgn(float(_net_t.mean()))} USD an entry; the mean of {_roll} entries in a row runs from {sgn(float(_rm.min()))} to {sgn(float(_rm.max()))} and {pct(float((_rm > 0).mean()), 0)} of those windows are above zero.",
        f"Longest run of winning entries {_run(_net_t > 0)}, of losing entries {_run(_net_t <= 0)}. The {len(_net_t)} entries span {_hours} hours, so {_roll} entries reach back about {_hours * _roll / len(_net_t):.1f} hours.",
        "Entries are in time order, not on a clock: they are not evenly spaced. Green is a gain, red a loss; the ink line is the rolling mean."]
figstyle.show(F.per_trade_fig(_net_t, _roll, float(_net_t.mean()), WIN_TEST, _bul), "fig:s3-pertrade", FIGURES)
''', "fig:s3-pertrade")
    nb.code(r'''
_won_t = (_net_t > 0).astype(float)
_cw = np.concatenate([[0], np.cumsum(_won_t)])
_rw = (_cw[_roll:] - _cw[:-_roll]) / _roll
_brk = TSUM["breakeven"] if (not EARLY and TSUM["breakeven"] == TSUM["breakeven"]) else None
_bul = [f"Full-sample win rate {pct(float(_won_t.mean()))}" + (f" against {pct(_brk)} to break even" if _brk is not None else "") + f"; over {_roll} entries in a row it runs from {pct(float(_rw.min()), 0)} to {pct(float(_rw.max()), 0)}" + (f", above break-even in {pct(float((_rw > _brk).mean()), 0)} of windows." if _brk is not None else "."),
        f"Each window reaches back {_roll} entries, about {_hours * _roll / len(_net_t):.1f} hours. Entries are in time order, not on a clock."]
figstyle.show(F.rolling_win_fig(_won_t, _roll, float(_won_t.mean()), WIN_TEST, _bul, brk=_brk), "fig:s3-rollwin", FIGURES)
''', "fig:s3-rollwin")
    nb.code(r'''
_bb = MR.band_frame(ENT, TTAB)
figstyle.show(F.winrate_fig(_bb, WIN_TEST, ["Green bars are price bands where the win share beat the break-even share (price paid plus fee)" + ("; for an early exit the bars are the share of positive entries, green at one half or more" if EARLY else "") + "; red where it fell short.",
                                           f"{int(_bb['entries'].max())} entries in the busiest band; {int((_bb['entries'] < 10).sum())} of {len(_bb)} bands hold fewer than 10, so read those bars as colour, not as numbers."], early=EARLY), "fig:s3-winrate", FIGURES)
''', "fig:s3-winrate")
    nb.code(r'''
ANS4.update(Markdown(f"**{'We make' if TSUM['net'] > 0 else 'We lose'} {abs(TSUM['net']):,.0f} USD** on {TSUM['n']} entries of USD {CLIP_USD:g} ({WIN_TEST}): {sgn(TSUM['per'])} USD each, 95% by slot {sgn(TSUM['per_lo'])} to {sgn(TSUM['per_hi'])}. "
                     f"The deepest drawdown is {usd(_dd)} on the USD {BOOK_USD:,.0f} book and {_pos_days} of {len(_bd)} test days earn money."))
''')
    nb.md(r'''
**For comparison, the plain one-second burst held to expiry, on the validation days** (the base trade of stage 1).
''')
    nb.code(r'''
# ---- the four charts of the base on the validation days: equity and drawdown, daily PnL, per-entry PnL, win rate against break-even ----
_e1 = S1R["validate"]["entries"]; _tv = TABS["validate"]; _sv = S1R["validate"]
_s, _eq1, _dd1, _ddp1 = RP.equity(_e1, _tv)
_bul = [f"{_sv['n']} entries of USD {CLIP_USD:g} on the validation days: net {sgn(_sv['net'], 0)} USD, deepest drawdown {usd(_dd1)} ({_dd1 / BOOK_USD * 100:.1f}% of the USD {BOOK_USD:,.0f} book).",
        f"Win rate {pct(_sv['win'])} against {pct(_sv['breakeven'])} to break even; the average price paid is {_sv['vwap'] * 100:.1f} cents a share.", "Entries are in time order; the shaded band is the distance below the running peak."]
figstyle.show(FIGS.equity_fig(_eq1, _ddp1, WIN_VAL, _bul, "Does the base trade grow the book on the validation days?"), "fig:s3-base-equity", FIGURES)
''', "fig:s3-base-equity")
    nb.code(r'''
_bd1 = RP.by_day(_e1, _tv)
figstyle.show(FIGS.daily_fig(_bd1, WIN_VAL, ["Net by day: " + "; ".join(f"{d_[5:]} {sgn(r_.net, 0)}" for d_, r_ in _bd1.iterrows()) + " USD.", "Two days of one regime are one observation of the regime, not a promise."], "Did the base trade earn on each validation day?"), "fig:s3-base-daily", FIGURES)
''', "fig:s3-base-daily")
    nb.code(r'''
figstyle.show(F.win_loss_fig(_e1["net"], WIN_VAL, [f"Mean {sgn(_e1['net'].mean())} USD an entry, median {sgn(float(np.median(_e1['net'])))}; best {sgn(float(_e1['net'].max()))}, worst {sgn(float(_e1['net'].min()))}.",
                                                f"{pct(float((_e1['net'] > 0).mean()))} of entries are positive. A held token pays 1 or 0, so the entries pile at two ends."], "What does the base trade win and lose on one entry?"), "fig:s3-base-trades", FIGURES)
''', "fig:s3-base-trades")
    nb.md(r'''
### Which windows did we enter?
''')
    nb.code(r'''
ANS5 = display(Markdown("_The answer is written here when the run reaches the test days._"), display_id=True)
''')
    nb.code(r'''
_won = ENT["net"] > 0
_nwin = int(TTAB.W)
_per_day = ", ".join(f"{d_[5:]} {int((TTAB.day[ENT['w']] == i_).sum())}" for i_, d_ in enumerate(TTAB.days))
_bul = [f"{TSUM['n']} of the {_nwin} windows with a book were entered ({pct(TSUM['n'] / _nwin)}): {int(_won.sum())} made money and {int((~_won).sum())} lost it. Entries by day: {_per_day}.",
        "One bar is one 15-minute window of one coin. The four coins start together, so a column of four bars is one slot and its results move together: that is why every interval in this study is taken by slot.",
        "Grey is a window the rule did not fire in (the move never reached the threshold in the allowed seconds, or the ladder could not fill the minimum order)."]
figstyle.show(F.windows_fig(TTAB, ENT, WIN_TEST, _bul), "fig:s3-windows", FIGURES)
ANS5.update(Markdown(f"**We entered {TSUM['n']} of {_nwin} windows with a book ({pct(TSUM['n'] / _nwin)}); {int(_won.sum())} made money and {int((~_won).sum())} lost it** ({WIN_TEST})."))
''', "fig:s3-windows")
    # ------------------------------------------------------------------------------------ S4
    nb.md(r'''
## S4 · Robustness

| question | gate to S6 |
|---|---|
| Is it real: does the placebo earn as much, does a planted peek pay far more, does it survive the delay, twice the fee, both test days, and the number of cells tried? | the rows of the gate table below |
''')
    nb.md(r'''
**Does the pair beat the same trades with no information?** The placebo fires at the same seconds on a fair-coin side; the planted peek knows the outcome.
''')
    nb.code(r'''
# ---- placebo and planted peek (the harness would see a leak) ----
PL, PK = FR["placebo"], FR["peek"]
_pl = np.array([p_["per"] for p_ in PL if p_.get("n", 0) > 0])
_ref = float(np.quantile(_pl, 0.95)) if len(_pl) > 1 else float("inf")
_bul = [f"The chosen pair earns {sgn(TSUM['per'])} an entry; {len(_pl)} placebo draws (the same firing seconds, a fair-coin side at each) earn {sgn(float(_pl.mean()))} on average, 95th percentile {sgn(_ref)}.",
        f"The planted peek (the same seconds, the side that wins) earns {sgn(PK['per'])} an entry on {PK['n']} entries: the harness sees a leak.",
        "A pair that does not beat its placebo is earning the market's drift, the spread or the fee structure, not the direction."]
figstyle.show(FIGS.placebo_fig(TSUM["per"], _pl, WIN_TEST, _bul, "Does the chosen pair beat the same trades with no information?", label="the chosen pair"), "fig:s4-placebo", FIGURES)
''', "fig:s4-placebo")
    nb.md(r'''
**Does it still lose at twice the fee, a cent worse on every fill, or with a different clip?**
''')
    nb.code(r'''
# ---- costs ----
COST = MR.cost_table(TTAB, SIG_STAR, EX_STAR)
display(HTML(COST.round(3).to_html(index=False, border=0)))
''')
    nb.md(r'''
**How much of the Sharpe ratio is luck?** The best of many cells looks better than it is; the deflated Sharpe charges for every cell tried.
''')
    nb.code(r'''
# ---- by day, and the deflated Sharpe for the number of cells tried ----
DSR, SH = FR["dsr"], FR["sharpe"]
_slot_sh = B.slot_sharpe(ENT, TTAB) if TSUM["n"] else float("nan")
_daily_sh = TSUM.get("sharpe_daily", float("nan"))
display(Markdown(f"**Sharpe.** Per entry (mean over standard deviation) {SH['sr']:+.3f} on {SH['n']} entries (skew {SH['skew']:+.1f}, kurtosis {SH['kurt']:.1f}); annualised on 15-minute slots {sgn(_slot_sh, 1)}, on days {sgn(_daily_sh, 1)} (two days: a rough label only). "
                 f"The best of {N_TRIALS} cells is deflated against the spread of the cells' own Sharpe ratios: SR0 {DSR['sr0']:+.3f}, probabilistic {DSR['psr']:.2f}, **deflated {DSR['dsr']:.2f}**." if SH and DSR else "Too few entries for a Sharpe."))
''')
    nb.md(r'''
**What did the pair do on days nobody used to choose it?** An earlier week and a fresh day, read after the test days. They are for the record and sit outside the decision rule.
''')
    nb.code(r'''
# ---- days outside the registered split, read AFTER the test days for the pair already chosen (informational, outside the decision rule): an earlier week and a fresh forward day ----
XR = {}
for lab_, days_ in (("earlier week", EARLIER_WEEK), ("fresh day", FRESH_DAY)):
    tx_, xe_, sx_ = MR.block(days_, SIG_STAR, EX_STAR, lab_, FILL_MS)
    XR[lab_] = (tx_, xe_, sx_)
_rows = [dict(block="registered test days", days=f"{TEST_DAYS[0][5:]} to {TEST_DAYS[-1][5:]}", n=TSUM["n"], win=TSUM["win"], per=TSUM["per"], lo=TSUM["per_lo"], hi=TSUM["per_hi"], net=TSUM["net"])]
for lab_, (tx_, xe_, sx_) in XR.items():
    _rows.append(dict(block=lab_, days=f"{tx_.days[0][5:]} to {tx_.days[-1][5:]}", n=sx_["n"], win=sx_["win"], per=sx_["per"], lo=sx_["per_lo"], hi=sx_["per_hi"], net=sx_["net"]))
POOL = M.pool([ENT] + [xe_ for (_, xe_, _) in XR.values()])
SP = M.summarize(POOL, None)
_rows.append(dict(block="pooled, all days outside fit and validation", days="", n=SP["n"], win=SP["win"], per=SP["per"], lo=SP["per_lo"], hi=SP["per_hi"], net=SP["net"]))
XT = pd.DataFrame(_rows)
display(Markdown("**The chosen pair on the days outside the registered split** (read after the test days; none was used to choose it; the earlier week is before the fit days, the fresh day after the test days)"))
display(HTML(XT.round(3).to_html(index=False, border=0)))
WEEK, FRESH = XR["earlier week"][2], XR["fresh day"][2]
GATES.append({"id": "G12", "section": "S4", "label": "Other days, for record", "name": "the chosen pair on an earlier week and a fresh day nobody had read when it was chosen; informational, outside the decision rule",
              "reading": f"earlier week {sgn(WEEK['per'])} on {WEEK['n']}; fresh day {sgn(FRESH['per'])} on {FRESH['n']}", "verdict": "INFO", "would_change": "a result on more days"})
GATES.append({"id": "G13", "section": "S4", "label": "Pooled out of sample", "name": "net per entry over every day outside the fit and validation days, with a 95% interval over 15-minute slots; informational: the decision rule reads the registered test days",
              "reading": f"{sgn(SP['per'])} USD an entry on {SP['n']} entries, 95% {sgn(SP['per_lo'])} to {sgn(SP['per_hi'])}", "verdict": "INFO", "would_change": "more days"})
''')
    nb.md(r'''
**Exploratory. Does slow momentum held to expiry pay on days the sweep never saw?**

The sweep chose on the fit and validation days. Here every single-lookback cell (hold to expiry) is read on the earlier week and the fresh day, days no stage touched. It is EXPLORATORY: nothing is chosen from it, no gate reads it, and a cell that looks good here is a hypothesis for a forward, pre-registered run, not a result.
''')
    nb.code(r'''
t0 = time.time()
XTAB = M.MTab(EARLIER_WEEK + FRESH_DAY, fill_ms=FILL_MS)
_rows = {}
for L_ in M.LS:
    _rows[L_] = {}
    for z_ in M.ZS:
        e_ = M.run(XTAB, M.Signal(L_, z_), M.Exit("expiry"))
        s_ = M.summarize(e_, XTAB)
        _rows[L_][z_] = (s_["per"], s_["n"], s_["win"], s_["breakeven"])
GX = pd.DataFrame({z_: {L_: _rows[L_][z_][0] for L_ in M.LS} for z_ in M.ZS})
GX.index.name, GX.columns.name = "lookback L, s", "z threshold"
print(f"unseen-days grid in {time.time() - t0:.0f}s")
_agree = [(L_, z_) for L_ in M.LS for z_ in M.ZS if (SURF_V.loc[L_, z_] > 0) == (GX.loc[L_, z_] > 0)]
_bul = [f"{int((GX.to_numpy() > 0).sum())} of {GX.size} cells earn above zero on these {len(EARLIER_WEEK) + len(FRESH_DAY)} unseen days; the sign agrees with the validation days in {len(_agree)} of {GX.size}.",
        "EXPLORATORY: the cells were not chosen from this read and no gate reads it. A grid is one window re-sliced; a cell here is a hypothesis for a forward run.",
        "Green is a gain, red a loss, in USD per entry after both fees and the 250 ms fill."]
figstyle.show(F.surface_fig(GX, None, f"{EARLIER_WEEK[0][5:]} to {FRESH_DAY[-1][5:]} · {24 * (len(EARLIER_WEEK) + len(FRESH_DAY))}h · unseen days, exploratory", _bul, question="Does slow momentum held to expiry earn on days the sweep never saw?"), "fig:s4-slow", FIGURES)
display(Markdown("**Win share against break-even on the unseen days, z = 2, hold to expiry**"))
display(HTML(pd.DataFrame({f"{L_} s": [_rows[L_][2.0][2] * 100, _rows[L_][2.0][3] * 100, _rows[L_][2.0][1]] for L_ in M.LS}, index=["win share %", "break-even %", "entries"]).round(1).to_html(border=0)))
''', "fig:s4-slow")
    # ------------------------------------------------------------------------------------ S5
    nb.md(r'''
## S5 · Risk and diagnostics - Why do we lose?

| question | answer form |
|---|---|
| Where does the money, or the loss, come from: coin, time left, day, and the fee? | tables by coin, time left and day, and the fee beside the gross |
''')
    nb.code(r'''
ANS6 = display(Markdown("_The answer is written here when the run reaches the test entries._"), display_id=True)
''')
    nb.md(r'''
The tables cut the test entries by coin and by time left, and list every day read. The separate diagnosis study (`2026-10-08-predmkts-binance-momentum-15m-updown-diagnosis`) splits the same pair's result into the edge before friction and the friction itself.
''')
    nb.code(r'''
_ba = RP.by_asset(ENT, TTAB)
_bl = RP.by_left(ENT, TTAB)
display(Markdown("**By coin**")); display(HTML(_ba.round(3).to_html(border=0)))
display(Markdown("**By time left at the entry**")); display(HTML(_bl.round(3).to_html(border=0)))
_days_rows = []
for lab_, tab_, e_ in (("fit", TABS["fit"], STUDY.cells[CHOSEN_KEY]["fit"]["entries"]), ("validate", TABS["validate"], STUDY.cells[CHOSEN_KEY]["validate"]["entries"]), ("test", TTAB, ENT),
                       ("earlier week", XR["earlier week"][0], XR["earlier week"][1]), ("fresh day", XR["fresh day"][0], XR["fresh day"][1])):
    bd_ = RP.by_day(e_, tab_)
    for d_, r_ in bd_.iterrows():
        _days_rows.append(dict(role=lab_, day=d_, entries=int(r_["entries"]), win=r_["win"], per=r_["per"], net=r_["net"]))
display(Markdown("**The chosen pair on every day read** (the role says which stage used the day)"))
display(HTML(pd.DataFrame(_days_rows).round(3).to_html(index=False, border=0)))
''')
    nb.code(r'''
_why = "the fee takes more than the trades earn" if TSUM["per"] < 0 else "the trades earn more than the fee takes"
_coin_net = ", ".join(f"{c_.upper()} {sgn(r_['per'])}" for c_, r_ in _ba.iterrows() if r_["entries"] > 0)
ANS6.update(Markdown(f"**{'We lose' if TSUM['per'] < 0 else 'We do not lose'}: {_why}.** Before the fee a test entry makes {sgn(TSUM['gross_per'])} USD, the fee takes {TSUM['fee_per']:.2f} and the net is {sgn(TSUM['per'])} ({WIN_TEST}). "
                     f"By coin the net per entry is {_coin_net}."))
''')
    # ------------------------------------------------------------------------------------ S6
    nb.md(r'''
## S6 · Decision

| question | decision rule |
|---|---|
| If it passed: what size, can it be filled, what are the limits? | a size only if every gate below passed (`SIZED`); else the rung prints as information only |
''')
    nb.code(r'''
SZ = RP.sizing(ENT, TTAB, CLIP_USD)
display(Markdown(f"**Sizing read (information unless every gate passes).** {SZ['per_day']:.0f} fills a day of USD {CLIP_USD:g} (median fill USD {SZ['median_fill_usd']:.1f}), USD {SZ['cost_per_day']:,.0f} deployed a day, net {sgn(SZ['net_per_day'], 0)} USD a day on a USD {BOOK_USD:,.0f} book "
                 f"({sgn(SZ['ret_pct_of_book_per_day'], 1)}% a day), deepest drawdown {usd(SZ['max_dd_usd'])} ({SZ['dd_pct_of_book']:.1f}% of the book). Capacity is the visible depth: a clip of USD 100 changes the fill, see the cost table."))
def gate(i, label, name, reading, ok, would):
    GATES.append({"id": i, "section": "S4", "label": label, "name": name, "reading": reading, "verdict": "PASS" if ok else "FAIL", "would_change": would})
_lo, _per = TSUM["per_lo"], TSUM["per"]
gate("G4", "Net per entry above 0", "the chosen pair's test net per entry is above zero with a 95% interval above zero", f"{sgn(_per)} USD an entry, 95% {sgn(_lo)} to {sgn(TSUM['per_hi'])}, on {TSUM['n']} entries", _lo > 0 and _per > 0, "an interval that includes zero")
_pl_ok = bool(len(_pl)) and TSUM["per"] > _ref
gate("G5", "Beats the placebo", "the pair earns more per entry than the placebo's 95th percentile (random sides at the same firing seconds)", f"{sgn(TSUM['per'])} against {sgn(_ref)}", _pl_ok, "a placebo that earns as much")
_pk_ok = PK["n"] > 0 and PK["per"] > max(TSUM["per"], 0) + 1.0
VERIFY["total"] += 1
VERIFY["passed"] += int(_pk_ok)
gate("G6", "Planted peek caught", "a planted look at the outcome pays far more than the pair", f"peek {sgn(PK['per'])} against {sgn(TSUM['per'])}", _pk_ok, "a harness that cannot tell a leak")
_dok = bool(_dl.loc[150, "per"] > 0 and _dl.loc[250, "per"] > 0)
gate("G7", "Survives 150 and 250 ms", "net per entry stays above zero at the venue's delay and at 250 ms", f"{sgn(_dl.loc[150, 'per'])} at 150 ms, {sgn(_dl.loc[250, 'per'])} at 250 ms; {sgn(_dl.loc[0, 'per'])} with no delay", _dok, "an edge that lives inside the delay")
_c = COST.set_index("case")
gate("G8", "Survives twice the fee", "net per entry stays above zero at twice the fee", f"{sgn(_c.loc['fee x2', 'per'])} at fee x2", bool(_c.loc["fee x2", "per"] > 0), "an edge smaller than a fee")
gate("G9", "Positive on both days", "the net is above zero on every test day", f"{_pos_days} of {len(_bd)} test days above zero", bool(_pos_days == len(_bd) and len(_bd) > 0), "a result carried by one day")
_qual = bool(S3R["qualified"] and LOOPR["qualified"] and STUDY.cells[CHOSEN_KEY]["fit"].get("per", -1) > 0)
gate("G10", "Chosen on both sides", "the chosen pair is positive on the fit days as well as the validation days", f"fit {sgn(STUDY.cells[CHOSEN_KEY]['fit'].get('per', float('nan')))}, validate {sgn(STUDY.cells[CHOSEN_KEY]['validate'].get('per', float('nan')))}; qualified {_qual}", _qual, "a pair positive on one window only")
gate("G11", "Deflated Sharpe", "the deflated Sharpe, which charges for the number of cells tried, is at least 0.90", f"deflated {DSR['dsr']:.2f}, {N_TRIALS} cells" if DSR and DSR["dsr"] == DSR["dsr"] else "not computable", bool(DSR and DSR["dsr"] == DSR["dsr"] and DSR["dsr"] >= 0.9), "a Sharpe within the luck of the best of N")
_core = ("G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9")
GV_ = {g_["id"]: g_["verdict"] for g_ in GATES}
SIZED = all(GV_[i_] == "PASS" for i_ in _core)
WORD = "1x" if SIZED else "NO SIZE"
CLASS = "A" if SIZED else ("B" if TSUM["per"] > 0 else "C")
CLASS_TXT = {"A": "money: every gate passed", "B": "a positive point estimate that the interval, the placebo or the delay does not support", "C": "no money"}[CLASS]
display(Markdown(f"**Decision: {'a USD 20 clip, one position per window, paper only' if SIZED else 'NO SIZE'}.** " + ("Every gate of the rule passed." if SIZED else f"Not passed: {', '.join(g_['label'] for g_ in GATES if g_['verdict'] == 'FAIL' and g_['id'] in _core)}. The rung is information only.")))
GATES.append({"id": "G14", "section": "S6", "label": "Sized only if passed", "name": "the decision rule reads G1 to G9: a size only when all pass, else the rung is information only", "reading": f"{'SIZED' if SIZED else 'NO SIZE'}: {sgn(TSUM['per'])} USD an entry",
              "verdict": "PASS" if SIZED else "FAIL", "would_change": "any gate it reads"})
''')
    # ------------------------------------------------------------------------------------ S7
    nb.md(r'''
## S7 · Verdict - Is it worth trading?
''')
    nb.code(r'''
ANS7 = display(Markdown("_The answer is written here when the run reaches the verdict._"), display_id=True)
''')
    nb.code(r'''
# ---- the plain-words answer, from the run's own numbers ----
HEADLINE_MD = (f"**The answer: {'MONEY' if SIZED else 'NO MONEY'}, class {CLASS}.** The one-second burst held to expiry won {pct(_sp['win'])} of its entries on the fit and validation days against {pct(_sp['breakeven'])} to break even ({sgn(_sp['per'])} USD an entry). "
               f"The stages chose {CHOSEN_KEY} ({'qualified' if _qual else 'a miss by construction: no cell was positive on the fit days'}); on the test days it earned {sgn(TSUM['per'])} USD an entry on {TSUM['n']} entries "
               f"(95% by slot {sgn(TSUM['per_lo'])} to {sgn(TSUM['per_hi'])}), {sgn(TSUM['net'], 0)} USD net after costs, a win rate of {pct(TSUM['win'])}. Sharpe per entry {SH['sr']:+.3f}, deflated {DSR['dsr']:.2f} over {N_TRIALS} cells. "
               f"At no delay it earns {sgn(_dl.loc[0, 'per'])}, at 150 ms {sgn(_dl.loc[150, 'per'])}, at 250 ms {sgn(_dl.loc[250, 'per'])}. "
               f"{'It beats' if _pl_ok else 'It does not beat'} the placebo (random sides at the same seconds, 95th percentile {sgn(_ref)}); the planted peek {'is' if _pk_ok else 'is not'} caught ({sgn(PK['per'])}). "
               f"On days the sweep never saw, the pair earned {sgn(SP['per'])} an entry pooled with the test days ({SP['n']} entries, 95% {sgn(SP['per_lo'])} to {sgn(SP['per_hi'])}). "
               f"Slow momentum held to expiry wins more often, and the book prices it in: at z = 2 the momentum side's win share rises from {pct(_win_tab.loc['win share'].iloc[0])} at {_win_tab.columns[0]} to {pct(_win_tab.loc['win share'].iloc[-1])} at {_win_tab.columns[-1]}, "
               f"and the share the price and fee ask rises from {pct(_win_tab.loc['break-even'].iloc[0])} to {pct(_win_tab.loc['break-even'].iloc[-1])} (validation days).")
display(Markdown(HEADLINE_MD))
''')
    nb.code(r'''
_failed = [g_["label"] for g_ in GATES if g_["verdict"] == "FAIL" and g_["id"] in _core]
ANS7_TXT = (f"**{'Yes' if SIZED else 'No'}: {WORD}, class {CLASS}.** On the {TSUM['n']} test entries ({WIN_TEST}) the pair makes {sgn(TSUM['per'])} USD each, 95% by slot {sgn(TSUM['per_lo'])} to {sgn(TSUM['per_hi'])}"
            + ("." if SIZED else f", and fails {len(_failed)} of the {len(_core)} gates that decide the size: {', '.join(_failed)}."))
ANS7.update(Markdown(ANS7_TXT)); ANS0.update(Markdown(ANS7_TXT))
''')
    nb.code(r'''
for g_ in GATES:
    assert g_["verdict"] in REPORT.GATE_VERDICTS, g_
    assert len(g_["label"]) <= REPORT.MAX_GATE_LABEL, (g_["label"], len(g_["label"]))
assert len({g_["id"] for g_ in GATES}) == len(GATES)
GATES.sort(key=lambda g_: int(g_["id"][1:]))
GV = {g_["id"]: g_["verdict"] for g_ in GATES}
display(Markdown("**Gates**\n\n| Id | Section | Gate | Reading | Verdict |\n|---|---|---|---|---|\n" + "\n".join(f"| {g_['id']} | {g_['section']} | {g_['label']} | {g_['reading']} | **{g_['verdict']}** |" for g_ in GATES)))
RESULT_LINES = [f"RESULT um-009 test_entries={TSUM['n']}", f"RESULT um-009 test_win_rate_pct={TSUM['win'] * 100:.2f}", f"RESULT um-009 test_net_per_entry_usd={TSUM['per']:.4f}",
                f"RESULT um-009 test_net_pnl_usd={TSUM['net']:.2f}", f"RESULT um-009 test_sharpe_per_entry={SH['sr']:.4f}", f"RESULT um-009 deflated_sharpe={DSR['dsr']:.3f}"]
print("\n".join(RESULT_LINES))
''')
    nb.code(r'''
# ---- the card, the verdict and the manifest ----
_cut = lambda s, n: s if len(s) <= n else s[: n - 1].rstrip() + "."
mk = lambda metric, value, bar="", verdict="", gate=None: {"metric": metric, "value": value, "bar": bar, "verdict": GV[gate] if gate else verdict, **({"gate": gate} if gate else {})}
_wins, _loss = ENT["net"][ENT["net"] > 0], ENT["net"][ENT["net"] <= 0]
PF = float(_wins.sum() / abs(_loss.sum())) if len(_loss) and _loss.sum() != 0 else None
WLR = float(_wins.mean() / abs(_loss.mean())) if len(_wins) and len(_loss) else None
_dly = _bd["net"].to_numpy(float)
_hold_h = float(np.mean(ENT["T"]) / 3600.0) if TSUM["n"] else None
METRICS = {"ann_return_pct": None, "excess_vs_hurdle_pct": None, "ann_vol_pct": None, "sharpe": (None if _slot_sh != _slot_sh else float(_slot_sh)), "sortino": None, "calmar": None, "psr": float(DSR["psr"]), "dsr": float(DSR["dsr"]),
           "max_dd_pct": SZ["dd_pct_of_book"], "max_dd_days": float(len(TEST_DAYS)), "n_periods": float(len(TEST_DAYS) * 96), "periods_per_year": 96.0 * 365.0,
           "total_return_pct": TSUM["net"] / BOOK_USD * 100, "n_trades": float(TSUM["n"]), "trades_per_day": TSUM["n"] / len(TEST_DAYS), "hit_rate_pct": TSUM["win"] * 100,
           "profit_factor": PF, "expectancy_bps": TSUM["per"] / CLIP_USD * 1e4, "win_loss_ratio": WLR, "avg_hold_h": _hold_h, "exposure_pct": None,
           "turnover_ann": float(ENT["cost"].sum() / len(TEST_DAYS) * 365 / BOOK_USD), "fees_pct_of_gross": (float(ENT["fee"].sum() / abs(ENT["gross"].sum()) * 100) if ENT["gross"].sum() else None),
           "worst_period_pct": float(_dly.min() / BOOK_USD * 100), "gross_edge_bps": TSUM["gross_per"] / CLIP_USD * 1e4, "cost_bps": TSUM["fee_per"] / CLIP_USD * 1e4,
           "breakeven_cost_bps": TSUM["gross_per"] / CLIP_USD * 1e4, "capacity_usd": None, "beta_to_underlying": None}
NA = {"ann_return_pct": "two test days: an annualised return is not meaningful", "excess_vs_hurdle_pct": "two test days: an annualised excess is not meaningful", "ann_vol_pct": "two test days: an annualised volatility is not meaningful",
      "sortino": "two test days: not meaningful", "calmar": "two test days: not meaningful", "exposure_pct": "exposure over the window was not tracked per second", "capacity_usd": "the ladder depth beyond four levels is not kept",
      "beta_to_underlying": "a binary payoff on Up or Down: no single underlying beta"}
for k_, v_ in list(METRICS.items()):
    if v_ is None or (isinstance(v_, float) and not math.isfinite(v_)):
        METRICS[k_] = None
        NA.setdefault(k_, "no loss or no entry on the test days")
VERDICT = {"word": WORD, "why": [_cut(f"net {sgn(TSUM['per'])} USD per entry on {TSUM['n']} test entries, 95% by slot {sgn(TSUM['per_lo'])} to {sgn(TSUM['per_hi'])}", 110),
                                 _cut(f"win {pct(TSUM['win'])}; deflated Sharpe {DSR['dsr']:.2f} over {N_TRIALS} cells; base burst won {pct(_sp['win'])} vs {pct(_sp['breakeven'])} to break even", 110),
                                 _cut(f"{sgn(_dl.loc[150, 'per'])} per entry at 150 ms, {sgn(_dl.loc[0, 'per'])} with no delay", 110)] if not SIZED else [_cut(f"every gate of the decision rule passed on {TSUM['n']} test entries", 110)],
           "next_bet": _cut("a forward, pre-registered read of the slow-lookback hold cells on days after 2026-10-07, chosen before the days are read", 150)}
CARD = {
    "question": _cut("Does buying the 15m Up/Down token in the direction of a Binance move over lookback L earn after fees and a 250 ms fill?", 200),
    "answer": _cut(f"{WORD}, class {CLASS}. {TSUM['n']} test entries net {sgn(TSUM['net'], 0)} USD ({sgn(TSUM['per'])} each, 95% {sgn(TSUM['per_lo'])} to {sgn(TSUM['per_hi'])}); win {pct(TSUM['win'])}.", 220),
    "implementation": [("Trade", "Buy the token in a Binance move's direction"), ("Venue", "Polymarket 15m crypto Up/Down; Binance is input"), ("Rule", _cut(CHOSEN_KEY, 70)),
                      ("Size", f"{usd(CLIP_USD)} a trade, {usd(BOOK_USD)} book, 1x"), ("Costs", "taker fee 0.07 x p(1-p) both legs; +250 ms"), ("Window", f"{DAYS_ALL[0][5:]} to {DAYS_ALL[-1][5:]}, {HOURS_ALL}h, 1 regime")],
    "big": [dict(mk("Net per entry", f"{sgn(TSUM['per'])} USD", f"95% {sgn(TSUM['per_lo'])} to {sgn(TSUM['per_hi'])}", gate="G4"), scope="test"),
            dict(mk("Net after costs", f"{sgn(TSUM['net'], 0)} USD", f"{TSUM['n']} entries", gate="G4"), scope="test"),
            dict(mk("Win rate", pct(TSUM["win"]), "", verdict="INFO"), scope="test"),
            dict(mk("Deflated Sharpe", f"{DSR['dsr']:.2f}", "at least 0.90", gate="G11"), scope="test")],
    "blocks": [
        {"title": "Money", "rows": [mk("Net per entry", f"{sgn(TSUM['per'])} USD", "interval above 0", gate="G4"), mk("Before costs, per entry", f"{sgn(TSUM['gross_per'])} USD", "", "INFO"), mk("Costs, per entry", f"{TSUM['fee_per']:.2f} USD", "", "INFO"),
                                    mk("Sharpe per entry", f"{SH['sr']:+.3f}", "", "INFO"), mk("Sharpe, 15-minute slots", sgn(_slot_sh, 1), "", "INFO")]},
        {"title": "Is it real", "rows": [mk("Placebo, 95th percentile", sgn(_ref), "below the pair", gate="G5"), mk("Planted peek", sgn(PK["per"]), "pays more", gate="G6"), mk("Days above zero", f"{_pos_days} of {len(_bd)}", "all", gate="G9"),
                                       mk("Positive on fit days", "yes" if _qual else "no", "yes", gate="G10"), mk("Pooled other days, per entry", sgn(SP["per"]), "informational", gate="G13")]},
        {"title": "Delay and cost", "rows": [mk("No delay, per entry", sgn(_dl.loc[0, "per"]), "", "INFO"), mk("150 ms, per entry", sgn(_dl.loc[150, "per"]), "above 0", gate="G7"), mk("250 ms, per entry", sgn(_dl.loc[250, "per"]), "above 0", gate="G7"),
                                  mk("Fee x2, per entry", sgn(_c.loc["fee x2", "per"]), "above 0", gate="G8")]},
        {"title": "Risk, USD", "rows": [mk("Deepest drawdown", sgn(-SZ["max_dd_usd"], 0), f"book {usd(BOOK_USD)}", "INFO"), mk("Worst day", sgn(float(_dly.min()), 0), "", "INFO"), mk("Fills a day", f"{SZ['per_day']:.0f}", "", "INFO"), mk("Net a day", sgn(SZ["net_per_day"], 0), "", "INFO")]},
        {"title": "Checks", "rows": [mk("Windows with a book", pct(SHARE, 0), "90% bar", gate="G1"), mk("Cells tried", f"{N_TRIALS}", "", "INFO"), mk("Engine checks held", f"{VERIFY['passed']} of {VERIFY['total']}", "all", "INFO")]}],
    "sizes": {"cols": ["Size", "Net, USD", "Per entry", "Verdict"], "chosen": 0 if SIZED else None, "rows": [["1x" if SIZED else "1x info only", sgn(TSUM["net"], 0), sgn(TSUM["per"], 2), "PASS" if SIZED else "FAIL"]]},
    "footer": [_cut(f"Registered as {RUN_ID} before any validation or test day was scored; {N_TRIALS} cells on the fit and validation days, the test days read once.", 160),
               _cut("The Polymarket days are those of um-003 to um-008: one window, one regime, not an independent observation.", 160),
               _cut(f"{HOURS_ALL}h, {VERIFY['passed']}/{VERIFY['total']} checks; Binance and Polymarket clocks taken as one.", 160)]}
_probs = REPORT.card_problems(CARD, metrics={k_: (None if v_ is None else float(v_)) for k_, v_ in METRICS.items()}, gates={g_["id"]: g_ for g_ in GATES}, word=WORD, carry=False)
assert not _probs, _probs
''')
    nb.code(r'''
# ---- the study manifest fund.study/1 (directional format, systematic style) ----
import hashlib
from fundplat.data.predmkts import updown15_pin
from fundplat.data import derived
from fundplat.data.crypto import ticks
STUDY_GATES = [{k_: g_[k_] for k_ in ("id", "section", "name", "label", "reading", "verdict", "would_change")} for g_ in GATES]
_series, _unpinned = [], []
_ms = lambda d_: int(dt.datetime.strptime(d_, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
for d_ in dict.fromkeys(DAYS_ALL):
    m_ = derived.meta(TT.DATASET, RUNNER.key_of(d_, FILL_MS))
    _series.append(dict(spec=f"tf15:{d_}:decision-table-d{FILL_MS}:-", pin=m_["hash"], rows=int(COV.drop_duplicates("day").set_index("day").loc[d_, "with_book"]), first_ts=_ms(d_), last_ts=_ms(d_) + 86_399_999, handle=None, cls="pin", trunc=False))
    mp_ = derived.meta(P.DATASET, P.key_of(d_))
    _series.append(dict(spec=f"mom15:{d_}:binance-1s-path:-", pin=mp_["hash"], rows=int(P.PRE_S + 86_400 + P.POST_S), first_ts=_ms(d_), last_ts=_ms(d_) + 86_399_999, handle=None, cls="pin", trunc=False))
    try:
        ip_ = updown15_pin.input_pin(d_)
        _series.append(dict(spec=f"polymarket:updown15 {d_}:l2-ladders:-", pin=hashlib.sha256(f"updown15-l2:{d_}:{ip_['digest']}".encode()).hexdigest(), rows=int(ip_["rows"]), first_ts=_ms(d_), last_ts=_ms(d_) + 86_399_999, handle=None, cls="pin", trunc=False))
    except KeyError as e_:
        _unpinned.append({"what": f"polymarket updown15 ladders {d_}", "why": f"the day is not finalized by the ladder job ({str(e_)[:60]})"})
for s_ in ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"):
    ip_ = ticks.input_pin(s_, _ms(DAYS_ALL[0]), _ms(DAYS_ALL[-1]) + 86_400_000)
    _series.append(dict(spec=f"binance:{s_}:aggTrades:-", pin=hashlib.sha256(f"binance:{s_}:{ip_['digest']}".encode()).hexdigest(), rows=int(sum(f["rows"] for f in ip_["files"])), first_ts=_ms(DAYS_ALL[0]), last_ts=_ms(DAYS_ALL[-1]) + 86_399_999, handle=None, cls="pin", trunc=False))
_unpinned.append({"what": "gamma market list (updown15.markets)", "why": "a day cache of the venue's own listing, re-readable; its outcomes are inside the derived days' pins"})
_unpinned.append({"what": "days outside the registered split: earlier week and fresh day, and the unseen-days surface of S4", "why": "read after the registered test days for the record; not part of the registered inputs digest"})
INPUTS = {"digest": REPORT.inputs_digest([x_["pin"] for x_ in _series]), "series": _series, "unpinned": _unpinned}
PROFILE = {"market": "predmkts", "markets": ["predmkts", "crypto"], "venues": ["polymarket", "binance"], "instruments": ["BTC, ETH, SOL, XRP 15m Up/Down", "spot aggTrades"], "bar": "15m"}
COMPONENTS = [{"name": "PnL before costs", "usd": float(ENT["gross"].sum())}, {"name": "fees, both legs", "usd": -float(ENT["fee"].sum())}]
assert abs(sum(c_["usd"] for c_ in COMPONENTS) - TSUM["net"]) < 0.01, "the PnL parts do not add to the net"
FIG_KINDS = {"fig:s3-base-equity": "equity-curve", "fig:s3-base-daily": "out-of-sample-test", "fig:s3-base-trades": "win-loss-distribution", "fig:s3-base-winrate": "calibration", "fig:s3-exits": "rule-comparison",
             "fig:s3-surface-validate": "parameter-surface", "fig:s3-surface-fit": "parameter-surface", "fig:s3-exits-loop": "rule-comparison", "fig:s3-equity": "equity-curve", "fig:s3-daily": "out-of-sample-test",
             "fig:s3-trades": "win-loss-distribution", "fig:s3-pertrade": "equity-curve", "fig:s3-rollwin": "rolling-statistics", "fig:s3-winrate": "calibration", "fig:s4-placebo": "significance-test", "fig:s3-delay": "signal-decay", "fig:s3-windows": "exposure-over-time", "fig:s4-slow": "parameter-surface",
             "fig:s3-l2-worst": "trade-anatomy", "fig:s3-l2-median": "trade-anatomy", "fig:s3-l2-best": "trade-anatomy"}
assert {f_["id"] for f_ in FIGURES} == set(FIG_KINDS), set(FIG_KINDS) ^ {f_["id"] for f_ in FIGURES}
for f_ in FIGURES:
    f_["kind"] = FIG_KINDS[f_["id"]]
CAVEATS = ["two test days of one regime: one observation of the regime, not a promise",
           "the Polymarket days are those of um-003 to um-008: one window, not an independent observation",
           f"{N_TRIALS} cells tried on the fit and validation days: the chosen cell's validation number is flattered",
           "the Binance trade-implied mid stands in for the Chainlink reference (about 1.9 bp apart, sd 0.8 bp)",
           "the book is a reconstruction of the venue's stream; Binance and Polymarket clocks taken as one",
           "the fill delay is the owner's 250 ms; the venue's 150 ms is in the delay table",
           "an early exit sells into four bid levels; the rest is held to expiry",
           "the price limit 0.97, the first decision at 10 s and the exit sigma unit are [U], fixed before scoring"]
assert all(len(c_) <= 110 for c_ in CAVEATS), [len(c_) for c_ in CAVEATS]
HEADLINE = {"metric": "net PnL per entry, USD, test days", "label": "Net per entry", "value": float(TSUM["per"]), "unit": "usd", "hurdle": 0.0, "gate": "G4"}
EQ = [(dt.datetime.fromtimestamp(_ms(TEST_DAYS[0]) / 1000, dt.timezone.utc) + dt.timedelta(minutes=15 * int(i_)), float(BOOK_USD + v_)) for i_, v_ in enumerate(_eq)] or [(dt.datetime.fromtimestamp(_ms(TEST_DAYS[0]) / 1000, dt.timezone.utc), BOOK_USD)]
MANIFEST = REPORT.build_manifest(
    id=STUDY_ID, kind=KIND, desk=DESK, title=TITLE, question=QUESTION, status="registered", run={"executed": RUN_AT, "kernel": "ccvenv"}, inputs=INPUTS, window=WINDOW,
    verify={"suite": VERIFY["suite"], "passed": VERIFY["passed"], "total": VERIFY["total"], "books": VERIFY["books"]}, gates=STUDY_GATES, figures=FIGURES, verdict=VERDICT, caveats=CAVEATS,
    headline=HEADLINE, components=COMPONENTS, summary=CARD, format="directional", style="systematic", metrics=METRICS, na=NA,
    strategy={"name": "Directional Binance momentum on 15m Up/Down", "thesis": "a large Binance move over a lookback of seconds to minutes predicts the next move, so the token in its direction is bought", "market": "prediction markets",
              "instruments": ["BTC", "ETH", "SOL", "XRP"], "venues": ["Polymarket", "Binance (input)"], "style": "momentum"},
    rules={"entry": _cut(SIG_STAR.name, 60), "exit": _cut(EX_STAR.name, 60), "sizing": f"{usd(CLIP_USD)} a trade", "rebalance": None, "hedge": None, "hold": "to expiry" if not EARLY else "to the exit rule", "stop": None, "cost": "taker fee 0.07 x p(1-p) both legs; +250 ms"},
    params={"clip": {"value": CLIP_USD, "unit": "usd", "source": "owner"}, "latency_ms": {"value": float(FILL_MS), "unit": "ms", "source": "owner"}, "fee_rate": {"value": 0.07, "unit": "rate", "source": "[API]"}},
    equity=EQ, profile=PROFILE, book=None)
S0_HANDLE.update(Markdown(REPORT.summary_md(MANIFEST)))
display(REPORT.display_bundle(MANIFEST), raw=True)
print("\n".join(l_.replace("RESULT um-009 ", "") for l_ in RESULT_LINES))
''', "manifest")
    nb.md(r'''
## A · Appendix

Every cell of the three sweeps with its fit and validation numbers, and the entries of the chosen pair on the test days.
''')
    nb.code(r'''
display(Markdown("**Stage 2 cells**")); display(HTML(S2F.round(3).to_html(index=False, border=0)))
display(Markdown("**Stage 3 cells**")); display(HTML(S3F.round(3).to_html(index=False, border=0)))
display(Markdown("**Loop back cells**")); display(HTML(LOOPF.round(3).to_html(index=False, border=0)))
display(Markdown("**Every entry of the chosen pair, test days** (entry_s: decision second from the window start; exit_s: -1 = held to expiry; T: seconds left at the entry)"))
display(HTML(TEST_FRAME[["date", "coin", "entry_s", "exit_s", "T", "side", "shares", "vwap", "exit_px", "cost", "fee", "won", "gross", "net"]].round(3).to_html(index=False, border=0)))
''')
    nb.md(r'''
## Research summary
''')
    nb.code(r'''
assert [g1_["verdict"] for g1_ in MANIFEST["gates"]] == [g1_["verdict"] for g1_ in GATES] and MANIFEST["verdict"]["word"] == WORD and len(MANIFEST["figures"]) == len(FIGURES)
display(Markdown(HEADLINE_MD))
display(HTML(summary_card.render(CARD, carry=False)))
display(Markdown("**Gates**\n\n| Gate | Verdict |\n|---|---|\n" + "\n".join(f"| {g_['id']} {g_['label']}: {g_['reading']} | **{g_['verdict']}** |" for g_ in GATES)))
''', "summary")


def build(execute: bool = True, out: Path | None = None, variant: str | None = None) -> int:
    """variant "merged": the study with its diagnosis in S5 (`mom15_merge`, the owner 2026-10-10), the stem unchanged; variant "um-012": the full-window re-score of B-0679 (`mom15_full` edits the cells and names the notebook)."""
    nb = NB()
    cells(nb)
    stem = STEM
    if variant == "merged":                        # the study with its diagnosis folded into S5 (mom15_merge), under this stem
        import mom15_merge as MG
        MG.patch(nb.cells)
    elif variant:
        import mom15_full as FULL
        assert variant == FULL.RUN_ID, variant
        FULL.patch(nb.cells)
        stem = FULL.STEM
    nbk = new_notebook(cells=nb.cells, metadata={"kernelspec": {"name": "ccvenv", "display_name": "ccvenv", "language": "python"}, "language_info": {"name": "python"}})
    path = out or (HERE / f"{stem}.ipynb")
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


if __name__ == "__main__":
    sys.exit(build())
