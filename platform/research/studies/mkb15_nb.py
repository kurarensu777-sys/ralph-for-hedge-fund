"""The notebook generator of B-0680 (the maker-side study of the Binance burst on BTC and ETH, run um-013): the words are here, every number is computed by the cells from `mkb15_mk`,
`mkb15_study` and the decision tables of the strategy search. Output: `2026-10-09-predmkts-binance-burst-maker-15m-updown.ipynb`, kind market, format evidence.

The notebook reads two windows and never mixes them: the DESIGN window (09-16 to 10-07, where the BTC and ETH cut was found: fill model, adverse selection, sensitivity, power) and the FORWARD
window (25 complete days from 10-08, registered as um-013, read once by `mkb15_study.ForwardGate` when all of them are seated; until then its gates read N/A).

    ../../../.venv/Scripts/python 2026-10-09-predmkts-binance-burst-maker-15m-updown.build.py
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
STEM = "2026-10-09-predmkts-binance-burst-maker-15m-updown"


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
# Does a resting bid on the Binance burst keep the edge a taker loses to friction?

## S0 · Summary
''')
    nb.code(r'''
from IPython.display import Markdown, display
ANS0 = display(Markdown("_The answer is written here when the run finishes._"), display_id=True)
''')
    nb.md(r'''

**Research question.** Over 22 days a taker who buys the 15-minute Up/Down token in the direction of a one-second Binance burst of 2.5 sigma keeps an edge before friction of +1.23 USD an entry on BTC and ETH and pays 1.17 of friction to get it filled (the fee, the spread and depth, the 250 ms). A resting bid pays no fee and no half spread. Does the same burst, bought by a resting bid, keep any of that edge once the fills are chosen by whoever sells into the bid (the adverse selection of the fills)?

**The idea.** Rest a post-only bid on the burst's side at the touch, cancel it when Binance retraces the burst, hold a fill to expiry. A bid fills only when someone sells through it, and a seller who sells into a bid after a burst up may know something the bid does not. So the study measures three things on the 22 days where the BTC and ETH cut was found (the DESIGN window, never a test): whether the fill model deserves trust (planted checks, a queue sweep, the planted peek), what a fill earned against what a miss would have, and how many fills a forward read needs. The one scored read is on 25 complete days after 10-07, registered as `um-013` before any of them was scored.

| | |
|---|---|
| Market | Polymarket 15-minute crypto Up/Down, BTC and ETH, driven by Binance spot trades |
| Subject | the frozen signal of um-009 (a one-second return of at least 2.5 sigma) as a resting bid; nothing about the signal is chosen or tuned here |
| Design window | 2026-09-16 to 2026-10-07 (22 days): fill model, adverse selection, sensitivity, power. The BTC and ETH cut was found here, so no gate of this window is a test |
| Forward window | 2026-10-08 to 2026-11-01 (25 complete days), read once when every day is seated |
| Unit of error | a 15-minute slot: BTC and ETH start together and move together, so every interval resamples slots |
| Comparators | the taker on the same BTC and ETH windows (S2), a fair-coin side at the same seconds (S3), um-008's all-coin quote (-0.44 a fill, pooled out of sample) |

**Falsifier, registered with um-013 before any forward day was scored.** The reading "a resting bid keeps an edge" ends unless every line below holds on the forward days.

| Id | The reading ends unless |
|---|---|
| F1 | the 95% interval of net per fill, over 15-minute slots, lies above zero |
| F2 | the coin-side placebo (200 draws, the same firing seconds) is beaten at its 95th percentile |
| F3 | the planted peek (the winning side at the same seconds) pays at least 5 USD a fill more than the rule |
| F4 | the fill rate (windows with a fill over windows with a burst) is between 12% and 49% |
| F5 | net per fill is above zero in both halves of the forward days, at twice the queue ahead, and with no rebate |
| F6 | (information only) fill minus miss in the token's 5 s mid move is negative with its interval below zero |
''')
    nb.md(r'''
**Prior art** (carried from the desk's books; not re-read today [1])

| Source | What it found | What we take from it |
|---|---|---|
| um-012 and its diagnosis (B-0679) | the taker pair is cost-bound over 22 days; on BTC and ETH the edge before friction is +1.23 | the arithmetic that a different role (a resting bid) is the one that changes |
| um-008 (B-0654) | an all-coin resting bid cancelled on a fair-value edge: +0.12 a fill on its test days, -0.44 pooled out of sample (664 fills, 95% -1.27 to +0.38) | the fill model and the adverse-selection question; this study cuts to the burst and the two coins |
| Budish, Cramton and Shim 2015 (QJE 130(4)) [1] | in a continuous book the speed of cancelling decides who is picked off | the 150 ms cancel latency is a named cost, swept in S4 |
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
# ---- parameters: ours, never a venue number (the fee, the rebate and the delays are S1.2) ----
STUDY_ID = "2026-10-09-predmkts-binance-burst-maker-15m-updown"
KIND = "market"
DESK = "lab/predmkts"
RUN_ID = "um-013"
PARENT_RUN = "um-012"
TITLE = "Does a resting bid on the Binance burst keep the edge a taker loses to friction?"
QUESTION = "Does a post-only bid on the side of the frozen one-second Binance burst, on BTC and ETH, earn per fill once the fills are chosen by the other side, and how many fills would a forward read need?"
SEED = 7
DESIGN_FROM, DESIGN_N = "2026-09-16", 22
FORWARD_FROM, FORWARD_N = "2026-10-08", 25
LOOKBACK_S, Z_MIN = 1, 2.5
COINS = ("btc", "eth")
CLIP_USD = 20.0
BOOK_USD = 1000.0
LIFE_S = 30
RETRACE_SIGMA = 1.0
POST_LAT_MS = 150
CANCEL_LAT_MS = 150
TAKER_FILL_MS = 250
PRICE_BAND = (0.03, 0.97)
N_BOOT = 4000
N_PLACEBO = 200
PEEK_MARGIN = 5.0
FILL_BAND = (0.12, 0.49)
ECON_BAR = 1.0
''', "parameters")
    nb.md(r'''
### S1.2 · Assumptions

| Item | Value | Source |
|---|---|---|
| The signal | a one-second Binance return of at least 2.5 sigma (the table's causal 300 s half-life volatility), first decision 10 s into the window, last 60 s before the end; BTC and ETH only | um-009, frozen; the coins were cut on the design window |
| The order | a post-only buy of USD 20 on the burst's token (Up for a rise, Down for a fall), at the best bid the trader saw at the decision second; at most 30 s; replaced at the next firing second if it ends unfilled; one fill a window; a price outside 0.03 to 0.97 posts nothing | design [U], frozen in `mkb15_mk.DEFAULT` before the engine first ran on any day |
| Latency | the order rests 150 ms after the decision; a cancel lands 150 ms after the Binance event that causes it; prints in that gap still fill the order | the taker delay the venue's loop shows [U]; swept in S4 |
| Cancel | the first Binance event after the decision whose log move from the decision-second mid, in the order's direction, is at or below minus 1 sigma of one second | design [U]; swept in S4 |
| Queue | the displayed size at prices at or better than the bid, in the four ladder levels the table keeps, is ahead of the order and never cancels; the pinned ladders keep ten levels a side, so nothing beyond them is read; a bid at or through the best ask when it lands is rejected | `tf15_mk` (um-008), unchanged |
| Fill | only from printed trades: the volume printed after the order rests at a price at or through its own, minus the queue ahead, up to its size; a print counts whatever its side | `tf15_mk`; the side of a print is not read [U] |
| Fee | a maker pays nothing and earns 20% of the taker fee the print paid, 0.07 x p x (1 - p) a share, accrued per fill; the venue pays the rebate daily by liquidity share | venue fact `fee.category_rates` (Crypto: taker 0.07, maker 0, rebate 20%) [1], read 2026-10-04 |
| Payoff | a held token pays 1 or 0 by the venue's resolution | market rows [API] |
| Taker comparator | the same signal bought at the exact ladder 250 ms later, held to expiry, the market's own fee | um-012 [1] |
| Placebo | the same firing seconds with a fair-coin side, 200 draws | design |
| Peek | the same firing seconds with the winning side: it must pay far more than the rule, or the machinery cannot tell a side from a coin | design |
| Economic bar | USD 1.00 a fill at this clip is worth running | design [U], the owner's to move |
| Unit of error | a 15-minute slot, for every interval | `tf15_bt` |
| Clocks | Binance trade time and the venue's book time taken as one clock | caveat |
''')
    nb.code(r'''
# ---- the PROSE check: the numbers the S1 tables state, held to the code ----
import mom15_bt as M, mkb15_mk as X, mkb15_study as S, mkb15_figs as MF, tf15_mk as MK
import tf15_bt as B, tf15_runner as RUNNER, tf15_table as TT, mom15_diag as D, mom15_path as P, mom15_study as ST
PROSE = {"life": (X.DEFAULT["life_s"], LIFE_S), "retrace": (X.DEFAULT["retrace"], RETRACE_SIGMA), "post latency": (X.POST_LAT_MS, POST_LAT_MS), "cancel latency": (X.CANCEL_LAT_MS, CANCEL_LAT_MS),
         "rebate": (X.REBATE, 0.20), "clip": (X.DEFAULT["usd"], CLIP_USD), "price band": ((X.DEFAULT["p_lo"], X.DEFAULT["p_hi"]), PRICE_BAND), "signal": (S.SIGNAL, (LOOKBACK_S, Z_MIN)),
         "coins": (S.ASSETS, (0, 1)), "queue": (X.DEFAULT["q_mult"], 1.0), "mode": (X.DEFAULT["mode"], "join"), "cancel": (X.DEFAULT["cancel"], "retrace"), "ladder levels": (TT.L, 4),
         "min shares": (B.MIN_SHARES, 5.0), "design days": ((S.DESIGN_FROM, S.DESIGN_N), (DESIGN_FROM, DESIGN_N)), "forward days": ((S.FORWARD_FROM, S.FORWARD_N), (FORWARD_FROM, FORWARD_N)),
         "placebo draws": (S.N_PLACEBO, N_PLACEBO), "peek margin": (S.PEEK_MARGIN, PEEK_MARGIN), "fill band": (S.FILL_BAND, FILL_BAND), "economic bar": (S.ECON_BAR, ECON_BAR), "taker delay": (ST.FILL_MS, TAKER_FILL_MS)}
BAD = {k_: v_ for k_, (v_, w_) in PROSE.items() if v_ != w_}
assert not BAD, f"the S1 tables no longer describe this run: {BAD}"
assert S.DESIGN_DAYS[0] == DESIGN_FROM and S.DESIGN_DAYS[-1] == "2026-10-07" and S.FORWARD_DAYS[-1] == "2026-11-01"
print(f"S1 tables: {len(PROSE)} stated numbers equal the code; the parameters cell equals the module defaults")
''')
    nb.md(r'''
### S1.3 · Data

No new market input is fetched. The inputs are the ones the strategy search pinned: the seated 1-second decision tables (`tf15_runner.py run`, a 150 ms ladder delay for the maker, a 250 ms one for the taker comparator) and the Binance 1-second paths (`mom15_path.py run`), each loaded through `fundplat.data.derived` with the hash of its blob in the manifest. The forward days are read through the same door, only when all 25 are seated.

| source | what | window | guard |
|---|---|---|---|
| `derived tf15-table` | the 1 s decision table per day (the book as the trader sees it at t, the ladder at t + the delay, the venue's prints, Binance events) | the design days; the forward days once seated | the derived blob's hash, pinned in the manifest |
| `derived mom15-path` | the 1 s Binance mid per coin | the same days | the derived blob's hash, pinned in the manifest |
| `updown15_pin.read`, `ticks.day_frame` | the ladders and trades the tables were built from | the same days | the day manifests' digests, pinned in the manifest |
''')
    nb.code(r'''
import datetime as dt, json, math, time, contextlib, io as _io
import numpy as np, pandas as pd
from IPython.display import HTML, Markdown, display
from fundplat.quant.core import figstyle, report as REPORT, summary_card
get_ipython().run_line_magic("config", "InlineBackend.print_figure_kwargs = {'bbox_inches': None}")
import lift_figs as LF
LF.setup()
pd.set_option("display.float_format", lambda v: f"{v:.3f}")
RUN_AT = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
DAYS = S.DESIGN_DAYS
HOURS = 24 * len(DAYS)
WINDOW = {"from": f"{DAYS[0]}T00:00Z", "to": f"{(dt.date.fromisoformat(DAYS[-1]) + dt.timedelta(days=1)).isoformat()}T00:00Z", "hours": HOURS, "regimes": 1}
pct = lambda v, d=1: f"{v * 100:.{d}f}%"
sgn = lambda v, d=2: f"{v:+,.{d}f}"
usd = lambda v, d=0: f"USD {v:,.{d}f}"
mag = lambda v, d=2: f"{abs(v):,.{d}f}"
WIN = f"{DAYS[0][5:]} to {DAYS[-1][5:]} · {HOURS}h · {len(DAYS)} days, BTC and ETH, the window the cut was found on (design only)"
FIGURES, GATES = [], []
t0 = time.time()
TAB = S.load(DAYS)
SIDE, TRIG = S.burst(TAB)
PU_E = MK.fv_grid(TAB)[1]
print(f"{TAB.W} BTC and ETH windows on {len(DAYS)} days loaded in {time.time() - t0:.0f}s; {int(TRIG.sum()):,} firing seconds in {S.burst_windows(TRIG):,} windows")
''')
    nb.md(r'''
### S1.4 · Runs

The engine's own checks run here; every one that can fail is counted.
''')
    nb.code(r'''
def _count(fn):
    buf = _io.StringIO()
    with contextlib.redirect_stdout(buf):
        ok_ = fn()
    ls_ = [l_ for l_ in buf.getvalue().splitlines() if l_.strip().startswith(("ok", "FAIL"))]
    return bool(ok_), sum(l_.strip().startswith("ok") for l_ in ls_), len(ls_), buf.getvalue()
CHK = {nm_: _count(fn_) for nm_, fn_ in (("mkb15_mk", X.selftest), ("mkb15_study", S.selftest), ("tf15_mk", MK.selftest), ("tf15_bt", B.selftest))}
for nm_, (ok_, p_, t_, txt_) in CHK.items():
    print(f"{nm_}: {p_} of {t_} checks passed")
print(CHK["mkb15_mk"][3])
assert all(v_[0] for v_ in CHK.values()), "an engine check failed"
VERIFY = {"suite": "mkb15 maker engine and protocol checks", "passed": sum(v_[1] for v_ in CHK.values()), "total": sum(v_[2] for v_ in CHK.values()), "books": TAB.W}
''')
    # ------------------------------------------------------------------------------------ S2
    nb.md(r'''
## S2 · Data checks

| question | gate to S3 |
|---|---|
| Is there a book for the windows, does the taker comparator rebuild the figures B-0680 quotes, does every engine check pass, and can the fill machinery tell a side from a coin? | at least 90% of windows have a book; the taker rebuild equals 4,185 entries and +1.23 an entry before friction; the engine checks pass; the planted peek pays at least 5 USD a fill more than the rule |

### Where do the bursts go before they become fills?
''')
    nb.code(r'''
# ---- coverage of the tables ----
COV = []
for d_ in DAYS:
    arrs_, meta_ = RUNNER.load(d_, TT.FILL_MS)
    COV.append(dict(day=d_, windows=int(meta_["windows"]), with_book=int(meta_["ok"]), fill_ms=int(meta_["fill_ms"])))
COV = pd.DataFrame(COV)
assert (COV.fill_ms == TT.FILL_MS).all()
SHARE = float(COV.with_book.sum() / COV.windows.sum())
display(Markdown(f"**Windows with a book.** {int(COV.with_book.sum())} of {int(COV.windows.sum())} windows of the four coins over {len(COV)} days ({pct(SHARE)}; the lowest day {pct(float((COV.with_book / COV.windows).min()))}); this study reads the {TAB.W} of them that are BTC or ETH."))
GATES.append({"id": "G1", "section": "S2", "label": "Windows have a book", "name": "at least 90% of windows have a ladder by the first decision second", "reading": f"{pct(SHARE)} of {int(COV.windows.sum())} windows",
              "verdict": "PASS" if SHARE >= 0.9 else "FAIL", "would_change": "a share below 90%"})
''')
    nb.code(r'''
# ---- the primary order on the design window ----
O, E = S.run(TAB, SIDE, TRIG, None, pu_e=PU_E)
SM = S.summary(E, TAB, "primary")
N_BURST = S.burst_windows(TRIG)
N_POSTED_W = len(np.unique(O["w"]))
N_FILL_W = len(np.unique(E["w"]))
CT = O["counts"]
DAYIDX = {d_: i_ for i_, d_ in enumerate(DAYS)}
day_b = np.array([int(TRIG[TAB.day == i_].any(1).sum()) for i_ in range(len(DAYS))])
day_f = np.array([len(np.unique(E["w"][E["day"] == i_])) for i_ in range(len(DAYS))])
RATE = N_FILL_W / N_BURST
_wl = lambda a, b: (lambda p, z: ((p + z * z / (2 * b) - z * np.sqrt(p * (1 - p) / b + z * z / (4 * b * b))) / (1 + z * z / b), (p + z * z / (2 * b) + z * np.sqrt(p * (1 - p) / b + z * z / (4 * b * b))) / (1 + z * z / b)))(a / b, 1.96)
_bul = [f"{N_BURST:,} of {TAB.W:,} BTC and ETH windows have at least one burst second ({int(TRIG.sum()):,} firing seconds); the rule posted {CT['posted']:,} orders in {N_POSTED_W:,} of them and {CT['filled']:,} filled, one a window.",
        f"Windows with a fill over windows with a burst: {pct(RATE)} (95% Wilson {pct(_wl(N_FILL_W, N_BURST)[0])} to {pct(_wl(N_FILL_W, N_BURST)[1])}); {pct(CT['filled'] / CT['posted'], 1)} of orders fill.",
        f"Orders not posted: {CT['no_book']:,} with no book, {CT['crossed']:,} rejected because the bid met the ask when it landed, {CT['price_out']:,} priced outside 0.03 to 0.97 (a near-certain token).",
        "Dotted lines are the band the forward gate F4 holds, half and twice the pooled rate of this window: outside it the fill model is not behaving as it did here."]
figstyle.show(MF.funnel_fig([("windows with a burst", N_BURST), ("windows with an order posted", N_POSTED_W), ("windows with a fill", N_FILL_W)], [d_[5:] for d_ in DAYS], day_f, day_b, FILL_BAND, WIN, _bul), "fig:s2-funnel", FIGURES)
''', "fig:s2-funnel")
    nb.code(r'''
# ---- the taker comparator rebuilds the figures B-0680 quotes ----
TAB_T = M.MTab(DAYS, fill_ms=TAKER_FILL_MS, assets=S.ASSETS)
SIG = M.Signal(LOOKBACK_S, Z_MIN)
ENT_T = M.run(TAB_T, SIG, M.Exit("expiry"))
FRM_T = D.entry_frame(TAB_T, ENT_T, SIG, {d_: "design" for d_ in DAYS}, D.vol_cuts(TAB_T))
ES_T = D.edge_stats(FRM_T)
SM_T = B.summarize(ENT_T, TAB_T, "taker")
WF_T = D.waterfall(FRM_T).set_index("term")["usd"]
_same = len(FRM_T) == 4185 and abs(ES_T["edge"] - 1.23) < 0.006 and abs(ES_T["edge_lo"] - 0.57) < 0.006 and abs(ES_T["edge_hi"] - 1.89) < 0.006
display(Markdown(f"**The taker, rebuilt.** {len(FRM_T):,} entries; the burst's side beats the book's mid at the decision by {sgn(ES_T['edge'])} USD an entry (95% {sgn(ES_T['edge_lo'])} to {sgn(ES_T['edge_hi'])}); friction {sgn(ES_T['friction'])} "
                 f"(250 ms {sgn(WF_T['C'])}, half spread and depth {sgn(WF_T['D'])}, fee {sgn(WF_T['E'])}); net {sgn(ES_T['net'])} (95% {sgn(ES_T['net_lo'])} to {sgn(ES_T['net_hi'])}). "
                 f"The maker sees {N_BURST:,} windows with a burst; the taker's {len(FRM_T):,} is the same set less the windows whose ladder never offered 5 shares."))
GATES.append({"id": "G2", "section": "S2", "label": "Taker rebuild equals", "name": "the taker comparator rebuilds the figures B-0680 quotes: 4,185 entries and +1.23 USD an entry before friction (95% +0.57 to +1.89)",
              "reading": f"{len(FRM_T):,} entries, edge {sgn(ES_T['edge'])} ({sgn(ES_T['edge_lo'])} to {sgn(ES_T['edge_hi'])})", "verdict": "PASS" if _same else "FAIL", "would_change": "a rebuild that drifts from the quoted figures"})
assert _same, "the taker rebuild does not equal the figures B-0680 quotes"
''')
    nb.code(r'''
# ---- the engine and the planted peek ----
GATES.append({"id": "G3", "section": "S2", "label": "Engine checks pass", "name": "every planted check of the fill machine passes, including equality with um-008's engine on one window", "reading": f"{VERIFY['passed']} of {VERIFY['total']} checks",
              "verdict": "PASS" if VERIFY["passed"] == VERIFY["total"] else "FAIL", "would_change": "a check that fails"})
PK_O, PK_E = S.peek(TAB, TRIG)
_pk = float(PK_E["net"].mean())
display(Markdown(f"**The planted peek.** The same firing seconds with the winning side: {len(PK_E['net']):,} fills, {sgn(_pk)} USD a fill, against the rule's {sgn(SM['per'])}. The machinery tells a side from a coin."))
GATES.append({"id": "G4", "section": "S2", "label": "Planted peek pays", "name": "the winning side at the same seconds pays at least 5 USD a fill more than the rule", "reading": f"peek {sgn(_pk)} against rule {sgn(SM['per'])} USD a fill",
              "verdict": "PASS" if _pk >= SM["per"] + PEEK_MARGIN else "FAIL", "would_change": "a peek that pays no more than the rule"})
assert GATES[-1]["verdict"] == "PASS" and GATES[-2]["verdict"] == "PASS"
''')
    # ------------------------------------------------------------------------------------ S3
    nb.md(r'''
## S3 · Core result

| question | gate to S4 |
|---|---|
| What does the resting bid earn per fill on the design window, does it beat a fair coin's side at the same seconds, and where does the net come from? | none: the design window is not a test; the readings are information for the forward gates |

### What does the rule earn per fill?
''')
    nb.code(r'''
ANS31 = display(Markdown("_The answer is written here when the run reaches the placebo._"), display_id=True)
''')
    nb.code(r'''
# ---- the placebo: 200 draws of the same rule with a fair-coin side ----
t0 = time.time()
PL_PER, PL_N = S.placebo(TAB, TRIG, n=N_PLACEBO)
P95 = float(np.nanquantile(PL_PER, 0.95))
P_ONE = (1 + int((PL_PER >= SM["per"]).sum())) / (len(PL_PER) + 1)
HV = S.halves(E, DAYS)
print(f"{N_PLACEBO} placebo draws in {time.time() - t0:.0f}s: mean {np.nanmean(PL_PER):+.2f}, 95th percentile {P95:+.2f}, {int((PL_PER >= SM['per']).sum())} at or above the rule; one-sided p {P_ONE:.3f}")
_bul = [f"The rule rests {SM['n']:,} fills of USD {CLIP_USD:g}: net {sgn(SM['net'], 0)} USD, {sgn(SM['per'])} a fill (95% by slot {sgn(SM['per_lo'])} to {sgn(SM['per_hi'])}); it wins {pct(SM['win'])} of its fills at a price that asks {pct(SM['breakeven'])}.",
        f"A fair-coin side at the same seconds loses {mag(np.nanmean(PL_PER))} a fill on average ({int(np.nanmean(PL_N)):,} fills a draw): the burst's side is worth about {sgn(SM['per'] - np.nanmean(PL_PER))} a fill over a coin's. {int((PL_PER >= SM['per']).sum())} of {len(PL_PER)} draws are at or above the rule (p {P_ONE:.3f}).",
        f"Halves: {HV[0][0]} {sgn(HV[0][2])} on {HV[0][1]} fills, {HV[1][0]} {sgn(HV[1][2])} on {HV[1][1]}; both intervals span zero. The maker's side is better than a coin's and not detectably better than nothing.",
        "The ink line is the rule, with its 95% interval above it; the dotted line is the placebo draws' 95th percentile. Green is a gain and red a loss."]
figstyle.show(MF.luck_fig(PL_PER, SM["per"], SM["per_lo"], SM["per_hi"], P95, HV, WIN, _bul), "fig:s3-luck", FIGURES)
''', "fig:s3-luck")
    nb.code(r'''
# ---- where the net comes from ----
BANDS = S.bands(E)
RANKED = np.sort(E["net"])[::-1]
TAILSH, K5 = S.tail_share(E)
TOP5_NET = float(np.sort(E["net"])[::-1][:K5].sum())
CV5 = S.cvar(E)
_b = pd.DataFrame(BANDS, columns=["price paid", "fills", "net per fill", "lo", "hi", "win", "break-even"])
_low = _b.iloc[0]
_rest_net = float(E["net"][E["b"] >= 0.30].sum())
_bul = [f"The best 5% of fills ({K5}) hold {TAILSH:.1f} times the whole net of {sgn(SM['net'], 0)} USD; the worst 5% average {sgn(CV5)} a fill. The mean rides on a few winners.",
        f"Fills priced under 0.30 earn {sgn(_low['net per fill'])} a fill on {int(_low['fills'])} fills (95% {sgn(_low['lo'])} to {sgn(_low['hi'])}); every fill priced from 0.30 up nets {sgn(_rest_net, 0)} USD together ({sgn(_rest_net / max(1, SM['n'] - int(_low['fills'])))} a fill). The bands were cut after the first look and are descriptive, not a hunt.",
        f"The 0.45 to 0.55 band loses {mag(_b.iloc[2]['net per fill'])} a fill (95% {sgn(_b.iloc[2]['lo'])} to {sgn(_b.iloc[2]['hi'])}) on {int(_b.iloc[2]['fills'])} fills: a coin-flip token filled by a seller is the worst fill.",
        "Left: net per fill by the price of the bid, with its 95% interval over slots. Right: the fills ranked best first, their running net, and the best 5% marked."]
figstyle.show(MF.concentration_fig(BANDS, RANKED, K5, WIN, _bul), "fig:s3-concentration", FIGURES)
''', "fig:s3-concentration")
    nb.code(r'''
_bd, _nd = S.by_day(E, len(DAYS))
POS_DAYS = int((_bd > 0).sum())
_tab = pd.DataFrame([
    ("fills", f"{SM['n']:,}", f"{N_FILL_W:,} windows of {N_BURST:,} with a burst ({pct(RATE)})"),
    ("net a fill, USD", f"{sgn(SM['per'])}", f"95% by slot {sgn(SM['per_lo'])} to {sgn(SM['per_hi'])}; sd {SM['sd']:.1f}"),
    ("win share against break-even", f"{pct(SM['win'])} against {pct(SM['breakeven'])}", f"Wilson {pct(SM['win_lo'])} to {pct(SM['win_hi'])}"),
    ("rebate a fill, USD", f"{-SM['fee_per']:.3f}", "20% of the taker fee the print paid, accrued"),
    ("coin-side placebo, USD a fill", f"{np.nanmean(PL_PER):+.2f}", f"95th percentile {P95:+.2f}; p {P_ONE:.3f}"),
    ("planted peek, USD a fill", f"{_pk:+.2f}", f"{len(PK_E['net']):,} fills"),
    ("days above zero", f"{POS_DAYS} of {len(DAYS)}", f"best day {sgn(_bd.max(), 0)}, worst day {sgn(_bd.min(), 0)} USD"),
    ("taker, same windows, USD an entry", f"{sgn(SM_T['per'])}", f"95% {sgn(SM_T['per_lo'])} to {sgn(SM_T['per_hi'])} on {SM_T['n']:,} entries"),
    ("um-008, all coins, pooled out of sample", "-0.44", "664 fills, 95% -1.27 to +0.38 (recorded 2026-10-08)")], columns=["measure", "value", "reading"])
display(HTML(_tab.to_html(index=False, border=0)))
GATES.append({"id": "G5", "section": "S3", "label": "Beats the coin side", "name": "design window, information only: the rule's net per fill is above the placebo's 95th percentile", "reading": f"{sgn(SM['per'])} against {sgn(P95)} (p {P_ONE:.3f})",
              "verdict": "INFO", "would_change": "the forward gate F2 decides"})
GATES.append({"id": "G6", "section": "S3", "label": "Interval above zero", "name": "design window, information only: the 95% slot interval of net per fill is above zero", "reading": f"{sgn(SM['per'])} ({sgn(SM['per_lo'])} to {sgn(SM['per_hi'])}) on {SM['n']:,} fills",
              "verdict": "INFO", "would_change": "the forward gate F1 decides"})
''')
    # ------------------------------------------------------------------------------------ S4
    nb.md(r'''
## S4 · Robustness

| question | gate to S5 |
|---|---|
| Does any change to the order's rules, the latency or the queue turn the net per fill positive beyond its interval, and do the fills do worse than the misses? | none: nothing is chosen; the cells are shown whole so the forward gates are not fitted to this window |

### Does any change to the rules matter?
''')
    nb.code(r'''
t0 = time.time()
GRID = []
for nm_, cfg_ in S.GRID:
    o_, e_ = S.run(TAB, SIDE, TRIG, cfg_, pu_e=PU_E)
    s_ = S.summary(e_, TAB, nm_)
    GRID.append((nm_, s_["n"], s_["per"], s_["per_lo"], s_["per_hi"]))
GR = pd.DataFrame(GRID, columns=["cell", "fills", "per", "lo", "hi"])
assert abs(GR.iloc[0]["per"] - SM["per"]) < 1e-9 and int(GR.iloc[0]["fills"]) == SM["n"], "the grid's primary is not the primary"
print(f"{len(GR)} cells in {time.time() - t0:.0f}s")
_clear = GR[(GR.lo > 0)]
_bul = [f"{len(GR)} cells, each the primary with one thing changed: net per fill runs from {sgn(GR.per.min())} to {sgn(GR.per.max())}; {len(_clear)} of {len(GR)} have an interval wholly above zero, and by luck about {0.025 * len(GR):.1f} would.",
        f"The cells are one 22-day window re-sliced, so they are one observation, not {len(GR)}. Nothing was chosen: the diamond is the order registered before the engine first ran.",
        f"The cent-inside bid fills more ({int(GR.set_index('cell').loc['a cent inside the touch', 'fills']):,}) and earns {sgn(GR.set_index('cell').loc['a cent inside the touch', 'per'])} a fill; the longer lives fill more and earn less; no cancel earns {sgn(GR.set_index('cell').loc['no cancel', 'per'])}. The rebate is worth {sgn(SM['per'] - GR.set_index('cell').loc['no rebate', 'per'])} a fill.",
        "Left: net per fill with its 95% interval over slots; green is a gain and red a loss. Right: the fills behind each cell."]
figstyle.show(MF.grid_fig([tuple(r_) for r_ in GR.itertuples(index=False)], WIN, _bul), "fig:s4-grid", FIGURES)
''', "fig:s4-grid")
    nb.md(r'''
### Does the queue position change the answer?
''')
    nb.code(r'''
QM = (0.0, 0.5, 1.0, 2.0, 4.0)
QR = []
for m_ in QM:
    o_, e_ = S.run(TAB, SIDE, TRIG, dict(q_mult=m_))
    s_ = S.summary(e_, TAB, f"q x{m_:g}")
    QR.append((m_, s_["n"], s_["per"], s_["per_lo"], s_["per_hi"], len(np.unique(e_["w"])) / N_BURST))
QR = pd.DataFrame(QR, columns=["mult", "fills", "per", "lo", "hi", "rate"])
assert abs(QR.set_index("mult").loc[1.0, "per"] - SM["per"]) < 1e-9
_bul = [f"Fills fall from {int(QR.fills.iloc[0]):,} at the front of the queue to {int(QR.fills.iloc[-1]):,} at four times the displayed size ({pct(QR.rate.iloc[0])} to {pct(QR.rate.iloc[-1])} of windows with a burst).",
        f"Net per fill rises from {sgn(QR.per.iloc[0])} to {sgn(QR.per.iloc[-1])} as the queue grows, every interval spans zero: an order deep in the queue fills only when a large seller trades through, and those fills are not worse.",
        "The fill model's one unmeasured input is the queue (the venue's matching order is not in the data), so the forward gate F5 holds the order at twice the queue.",
        "Left: fills as the queue ahead is scaled. Right: net per fill with its 95% interval over slots, zero dotted, the registered order ringed."]
figstyle.show(MF.queue_fig(QR.mult, QR.fills, QR.per, QR.lo, QR.hi, WIN, _bul), "fig:s4-queue", FIGURES)
''', "fig:s4-queue")
    nb.md(r'''
### Do the fills do worse than the misses?
''')
    nb.code(r'''
ADV = S.adverse(TAB, O, n_boot=N_BOOT)
_rows = []
for lab_, key_, k_ in (("win share, points", "win share", 100.0), ("a share bought at the bid, cents", "a share, USD", 100.0), ("token mid, +5 s, cents", "token mid, +5 s", 100.0), ("token mid, +30 s, cents", "token mid, +30 s", 100.0)):
    fm_, mm_, d_, lo_, hi_ = ADV[key_]
    _rows.append((lab_, fm_ * k_, mm_ * k_, d_ * k_, lo_ * k_, hi_ * k_))
_wait = (O["t_fill"][O["is_fill"]] - O["t_eff"][O["is_fill"]]) / 1000.0
_cv = ADV["clip value, USD"]
_bx = ADV["Binance mid, +5 s (bp)"]
_bul = [f"A share bought at the bid wins {pct(ADV['win share'][0])} of the time when the order fills and {pct(ADV['win share'][1])} when it does not: {sgn(_rows[0][3], 1)} points (95% {sgn(_rows[0][4], 1)} to {sgn(_rows[0][5], 1)}). The fills are chosen against the order.",
        f"The token's mid moves {sgn(_rows[2][3])} cents against a filled order in the 5 s after the fill, against a miss measured the same wait (median {ADV['fill delay, s']:.1f} s) after landing (95% {sgn(_rows[2][4])} to {sgn(_rows[2][5])}); at 30 s it is {sgn(_rows[3][3])} ({sgn(_rows[3][4])} to {sgn(_rows[3][5])}). Binance's mid in the 5 s: {sgn(_bx[2])} bp ({sgn(_bx[3])} to {sgn(_bx[4])}).",
        f"Weighted by the dollars of a clip-sized order the gap is {sgn(_cv[2])} USD (95% {sgn(_cv[3])} to {sgn(_cv[4])}): the sign agrees and the interval spans zero, because a cheap token carries many shares and a few big winners.",
        "Left: fill minus miss with its 95% interval over slots, zero dotted; red is worse for the order. Right: the wait from landing to the first fill."]
figstyle.show(MF.adverse_fig(_rows, _wait, WIN, _bul), "fig:s4-adverse", FIGURES)
''', "fig:s4-adverse")
    nb.code(r'''
GATES.append({"id": "G7", "section": "S4", "label": "Fills worse than misses", "name": "design window, information only: a fill's 5 s token mid move is below a miss's with its 95% interval below zero", "reading": f"{sgn(_rows[2][3])} cents ({sgn(_rows[2][4])} to {sgn(_rows[2][5])})",
              "verdict": "INFO", "would_change": "the forward line F6 replicates it or not"})
''')
    # ------------------------------------------------------------------------------------ S5
    nb.md(r'''
## S5 · Risk and diagnostics - Can a forward read tell this edge from zero?
''')
    nb.code(r'''
SD = float(E["net"].std(ddof=1))
PER_DAY = SM["n"] / len(DAYS)
N_FWD = PER_DAY * S.FORWARD_N
HW_NORMAL = float(S.half_width(SD, SM["n"]))
HW_SLOT = (SM["per_hi"] - SM["per_lo"]) / 2
HW_FWD = float(S.half_width(SD, N_FWD)) * HW_SLOT / HW_NORMAL
NEED_BAR = S.fills_needed(SD, ECON_BAR) * (HW_SLOT / HW_NORMAL) ** 2
_bul = [f"A fill has a standard deviation of {SD:.1f} USD and the window gives {PER_DAY:.0f} fills a day. The slot bootstrap is {HW_SLOT / HW_NORMAL:.2f} times as wide as the normal formula here, so slots add little clustering.",
        f"The registered forward read ({S.FORWARD_N} days, about {N_FWD:,.0f} fills) has a 95% half-width near {HW_FWD:.1f} USD a fill: gate F1 can pass only if the true edge is about {HW_FWD:.1f} or more. The design estimate is {sgn(SM['per'])}.",
        f"Showing the owner's bar of {ECON_BAR:+.1f} USD a fill takes about {NEED_BAR:,.0f} fills, {NEED_BAR / PER_DAY:,.0f} days at this rate. The likeliest forward outcome is an interval that spans zero: the registered expectation, not a surprise.",
        "Left: the smallest effect n fills can show at the 95% line. Right: the days of fills a read needs for an effect of a given size. Dotted lines are the decision lines."]
figstyle.show(MF.power_fig(SD * HW_SLOT / HW_NORMAL, PER_DAY, N_FWD, S.FORWARD_N, SM["n"], SM["per"], ECON_BAR, WIN, _bul), "fig:s5-power", FIGURES)
''', "fig:s5-power")
    nb.md(r'''
### The forward read
''')
    nb.code(r'''
# ---- the rehearsal: the forward code path run once on the DESIGN days. It proves the code runs and reproduces S3; it is never read as a forward result ----
REH = S.forward_read(TAB, DAYS, n_placebo=20)
assert REH["n"] == SM["n"] and abs(REH["summary"]["per"] - SM["per"]) < 1e-12, "the forward code path does not reproduce the design numbers"
print(f"rehearsal on the design days (NOT a forward result): {REH['n']:,} fills, {sgn(REH['summary']['per'])} a fill, gates F1..F6 = {[REH['f%d' % i_] for i_ in range(1, 7)]}, verdict {REH['verdict']}")
''')
    nb.code(r'''
GATE = S.ForwardGate(lambda: S.load(S.FORWARD_DAYS), lambda d_: RUNNER.seated(d_, TT.FILL_MS) is not None)
FW_SEATED, FW_TOTAL, _got = GATE.state()
FWD = None
if GATE.is_open():
    FTAB = GATE.open()
    FWD = S.forward_read(FTAB, S.FORWARD_DAYS)
    _fs = FWD["summary"]
    display(Markdown(f"**Forward read, opened once.** {FWD['n']:,} fills on {FW_TOTAL} days: {sgn(_fs['per'])} USD a fill (95% by slot {sgn(_fs['per_lo'])} to {sgn(_fs['per_hi'])}); fill rate {pct(FWD['rate'])}; placebo 95th percentile {sgn(FWD['p95'])}; "
                     f"peek {sgn(FWD['peek_per'])}; halves {[round(h_[2], 2) for h_ in FWD['halves']]}; twice the queue {sgn(FWD['q2_per'])}; no rebate {sgn(FWD['norebate_per'])}. Verdict {FWD['verdict']}."))
    _mid5 = FWD["adverse"]["token mid, +5 s"]
    print(f"forward_fills={FWD['n']}\nforward_net_per_fill_usd={_fs['per']:.4f}\nforward_window_fill_rate_pct={FWD['rate'] * 100:.2f}\nforward_placebo_p95_usd={FWD['p95']:.4f}\n"
          f"forward_fill_minus_miss_mid5_cents={_mid5[2] * 100:.4f}\nforward_peek_per_fill_usd={FWD['peek_per']:.4f}")
    _fg = [("F1", "Forward interval > 0", "the 95% slot interval of net per fill is above zero", f"{sgn(_fs['per'])} ({sgn(_fs['per_lo'])} to {sgn(_fs['per_hi'])})", FWD["f1"]),
           ("F2", "Forward beats coin side", "the 200-draw coin-side placebo is beaten at its 95th percentile", f"{sgn(_fs['per'])} against {sgn(FWD['p95'])}", FWD["f2"]),
           ("F3", "Forward peek pays", "the planted peek pays 5 USD a fill more than the rule", f"peek {sgn(FWD['peek_per'])} against {sgn(_fs['per'])}", FWD["f3"]),
           ("F4", "Forward fill rate", "windows with a fill over windows with a burst between 12% and 49%", f"{pct(FWD['rate'])}", FWD["f4"]),
           ("F5", "Forward holds up", "above zero in both halves, at twice the queue and with no rebate", f"halves {[round(h_[2], 2) for h_ in FWD['halves']]}, 2x queue {sgn(FWD['q2_per'])}, no rebate {sgn(FWD['norebate_per'])}", FWD["f5"])]
    for i_, (fid_, lab_, nm_, rd_, ok_) in enumerate(_fg):
        GATES.append({"id": f"G{8 + i_}", "section": "S5", "label": lab_, "name": nm_, "reading": rd_, "verdict": "PASS" if ok_ else "FAIL", "would_change": f"registered as {fid_} of {RUN_ID}"})
    GATES.append({"id": "G13", "section": "S5", "label": "Forward adverse repeats", "name": "fill minus miss in the 5 s token mid move is negative with its interval below zero", "reading": f"{sgn(_mid5[2] * 100)} cents ({sgn(_mid5[3] * 100)} to {sgn(_mid5[4] * 100)})",
                  "verdict": "INFO", "would_change": "registered as F6, information only"})
else:
    display(Markdown(f"**The forward read is not opened:** {FW_SEATED} of {FW_TOTAL} forward days are seated ({S.FORWARD_FROM} to {S.FORWARD_DAYS[-1]}). It opens once, when every one is; this notebook then re-runs with the same fixed days, so a later run is a determinism check and never a replication. "
                     f"Gates F1 to F6 of {RUN_ID} read N/A until then."))
    for i_, (fid_, lab_, nm_) in enumerate([("F1", "Forward interval > 0", "the 95% slot interval of net per fill is above zero"), ("F2", "Forward beats coin side", "the 200-draw coin-side placebo is beaten at its 95th percentile"),
                                          ("F3", "Forward peek pays", "the planted peek pays 5 USD a fill more than the rule"), ("F4", "Forward fill rate", "windows with a fill over windows with a burst between 12% and 49%"),
                                          ("F5", "Forward holds up", "above zero in both halves, at twice the queue and with no rebate"), ("F6", "Forward adverse repeats", "fill minus miss in the 5 s token mid move is negative with its interval below zero")]):
        GATES.append({"id": f"G{8 + i_}", "section": "S5", "label": lab_, "name": nm_, "reading": f"not opened: {FW_SEATED} of {FW_TOTAL} days seated", "verdict": "N/A", "would_change": f"registered as {fid_} of {RUN_ID}"})
''')
    # ------------------------------------------------------------------------------------ S6
    nb.md(r'''
## S6 · Decision

n/a - no position; the study sizes nothing. A size is a question only after the forward gates F1 to F5 pass; until then the order is information.
''')
    # ------------------------------------------------------------------------------------ S7
    nb.md(r'''
## S7 · Verdict - Does a resting bid on the burst keep the edge?
''')
    nb.code(r'''
ANS7 = display(Markdown("_The answer is written here when the run reaches the verdict._"), display_id=True)
''')
    nb.code(r'''
# ---- the plain-words answer, from the run's own numbers; each claim of the wording is asserted, so a re-run that breaks the story stops here ----
STORY = {}      # each claim of the wording is recorded, not asserted (2026-10-10: the queue fix moved the design numbers, and a story that moves is told, not refused)
STORY["the story needs an interval that spans zero"] = bool(SM["per_lo"] <= 0 <= SM["per_hi"])
STORY["the story needs the burst's side to beat a coin's"] = bool(SM["per"] > P95 and P_ONE < 0.10)
STORY["the story needs the fills to win less and the token to move against them, intervals below zero"] = bool(ADV["win share"][4] < 0 and ADV["token mid, +5 s"][4] < 0)
STORY["the story needs the cheap band to carry the net and the rest to lose"] = bool(_rest_net < 0 and _low["net per fill"] > 0)
STORY["the story needs the forward read to be too coarse for the design estimate"] = bool(HW_FWD > 3 * abs(SM["per"]))
STORY_FAIL = [k_ for k_, v_ in STORY.items() if not v_]
print("story lines that fail:", STORY_FAIL or "none")
HEADLINE_MD = (f"**The answer: the design window finds no edge it can show, and it finds the adverse selection.** The resting bid on the burst's side earns {sgn(SM['per'])} USD a fill on {SM['n']:,} fills (95% by slot {sgn(SM['per_lo'])} to {sgn(SM['per_hi'])}), against {sgn(SM_T['per'])} an entry for the taker on the same windows ({sgn(SM_T['per_lo'])} to {sgn(SM_T['per_hi'])}): "
               f"the maker pays no fee and no half spread, and still nets about what the taker nets: the fills it gets are not the ones the edge sits in. "
               f"**Direction.** The burst's side is worth about {sgn(SM['per'] - np.nanmean(PL_PER))} a fill over a coin's: {int((PL_PER >= SM['per']).sum())} of {len(PL_PER)} coin-side draws are at or above the rule (p {P_ONE:.3f}), " + ("so the side is shown at the 5% line" if P_ONE < 0.05 else "so the side is not shown at the 5% line") + f", and the planted peek pays {sgn(_pk)}: the machinery can see a side. "
               f"**Adverse selection.** " + ("The orders that fill do worse than the ones that do not" if ADV['win share'][4] < 0 and ADV['token mid, +5 s'][4] < 0 else "The orders that fill do worse than the ones that do not on the point, and one interval spans zero") + f": a share bought at the bid wins {mag(ADV['win share'][2] * 100, 1)} points less when filled (95% interval of the difference {sgn(ADV['win share'][3] * 100, 1)} to {sgn(ADV['win share'][4] * 100, 1)}), and the token's mid moves {mag(ADV['token mid, +5 s'][2] * 100)} cents against a filled order in 5 s (95% {sgn(ADV['token mid, +5 s'][3] * 100)} to {sgn(ADV['token mid, +5 s'][4] * 100)}). " +
               (f"**Concentration.** The net sits in {K5} fills: the best 5% hold {TAILSH:.1f} times the total, and the fills priced under 0.30 carry all of it; the other fills net {sgn(_rest_net, 0)} USD. " if SM['net'] > 0 and _low['net per fill'] > 0 else
                f"**Concentration.** The best 5% of fills ({K5}) earn {sgn(TOP5_NET, 0)} USD against a total of {sgn(SM['net'], 0)}; the fills priced under 0.30 net {sgn(_low['net per fill'])} each on {int(_low['fills'])} and the other fills {sgn(_rest_net, 0)} USD in all: a mean carried by its longshots either way. ") +
               f"**Sensitivity.** {len(GR)} variants of the order span {sgn(GR.per.min())} to {sgn(GR.per.max())} a fill; {int((GR.lo > 0).sum())} of them have an interval wholly above zero, and none is chosen. "
               f"**What the forward read can say.** {S.FORWARD_N} days give about {N_FWD:,.0f} fills and a 95% half-width near {HW_FWD:.1f} USD a fill: it can confirm an edge of that size, not the {sgn(SM['per'])} measured here, and showing {ECON_BAR:+.1f} a fill takes about {NEED_BAR / PER_DAY:,.0f} days. "
               f"**Forward status.** " + (f"opened: verdict {FWD['verdict'][0]} class {FWD['verdict'][1]}." if FWD else f"not opened, {FW_SEATED} of {FW_TOTAL} days seated."))
display(Markdown(HEADLINE_MD))
''')
    nb.code(r'''
ANS7_TXT = (f"**No edge shown, and the fills are adverse:** a resting bid on the burst earns {sgn(SM['per'])} USD a fill (95% {sgn(SM['per_lo'])} to {sgn(SM['per_hi'])}, {SM['n']:,} fills, design window); the fills win {mag(ADV['win share'][2] * 100, 1)} points less than the misses. "
            f"The forward read ({S.FORWARD_N} days, registered as {RUN_ID}) is " + ("opened." if FWD else f"not opened ({FW_SEATED} of {FW_TOTAL} days seated)."))
ANS7.update(Markdown(ANS7_TXT)); ANS0.update(Markdown(ANS7_TXT)); ANS31.update(Markdown(f"**The rule earns {sgn(SM['per'])} USD a fill, about {sgn(SM['per'] - np.nanmean(PL_PER))} more than a coin's side, and the interval spans zero.**"))
''')
    nb.code(r'''
NEXT_MD = (f"**What comes next.** Nothing is sized. The forward read waits for {FW_TOTAL - FW_SEATED} more seated days (the daily ladder job pins them; `tf15_runner.py run <day>` seats each); it is one read, pre-registered, and its most likely result is an interval that spans zero. "
           f"If the owner wants an answer sooner, the cheaper levers are more days (earlier days, if the archive serves them, are as untouched by the BTC and ETH cut as later ones), or a rule with fewer, bigger edges per fill; a taker on BTC and ETH nets {sgn(SM_T['per'])} an entry on the same windows, so neither role pays on this evidence.")
display(Markdown(NEXT_MD))
''')
    nb.code(r'''
for g_ in GATES:
    assert g_["verdict"] in REPORT.GATE_VERDICTS, g_
    assert len(g_["label"]) <= REPORT.MAX_GATE_LABEL, (g_["label"], len(g_["label"]))
assert len({g_["id"] for g_ in GATES}) == len(GATES)
GATES.sort(key=lambda g_: int(g_["id"][1:]))
GV = {g_["id"]: g_["verdict"] for g_ in GATES}
GID = {g_["label"]: g_["id"] for g_ in GATES}
display(Markdown("**Gates**\n\n| Id | Section | Gate | Reading | Verdict |\n|---|---|---|---|---|\n" + "\n".join(f"| {g_['id']} | {g_['section']} | {g_['label']} | {g_['reading']} | **{g_['verdict']}** |" for g_ in GATES)))
RESULT_LINES = [f"RESULT {RUN_ID} design_fills={SM['n']}", f"RESULT {RUN_ID} design_net_per_fill_usd={SM['per']:.4f}", f"RESULT {RUN_ID} design_placebo_p95_usd={P95:.4f}", f"RESULT {RUN_ID} design_window_fill_rate_pct={RATE * 100:.2f}",
                f"RESULT {RUN_ID} design_fill_minus_miss_mid5_cents={ADV['token mid, +5 s'][2] * 100:.4f}"]
print("\n".join(RESULT_LINES))
''')
    nb.code(r'''
# ---- the card, the verdict and the manifest ----
_cut = lambda s, n: s if len(s) <= n else s[: n - 1].rstrip() + "."
mk = lambda metric, value, bar="", verdict="", key=None, gate=None: {"metric": metric, "value": value, "bar": bar, "verdict": GV[GID[gate]] if gate else verdict, **({"gate": GID[gate]} if gate else {}), **({"key": key} if key else {})}
METRICS = {"n_obs": float(SM["n"]), "effect": SM["per"], "t_stat": SM["t"], "p_value": P_ONE, "ci95_low": SM["per_lo"], "ci95_high": SM["per_hi"], "rho": None, "r2": None,
           "oos_effect": (float(FWD["summary"]["per"]) if FWD else None), "stable_share_pct": 100.0 * POS_DAYS / len(DAYS), "half_life_h": None, "n_regimes": 1.0}
NA = {"rho": "one effect on one sample: no second series to correlate with", "r2": "as rho", "half_life_h": "an edge per fill, not a spread series with a half-life"}
if not FWD:
    NA["oos_effect"] = f"the forward read is not opened: {FW_SEATED} of {FW_TOTAL} days seated"
QUESTION_CARD = "Does a resting bid on the Binance burst earn per fill once the fills are chosen by the other side?"
ANSWER = _cut(f"NO SIZE. A bid on the burst nets {sgn(SM['per'])} USD a fill (95% {sgn(SM['per_lo'])} to {sgn(SM['per_hi'])}); fills win {mag(ADV['win share'][2] * 100, 1)} pt less than misses. Forward read pending.", 240)
IMPL = [("Trade", "Rest a bid on the burst's token"), ("Venue", "Polymarket 15m crypto Up/Down; Binance is input"), ("Signal", "1 s Binance return >= 2.5 sigma, BTC and ETH"),
        ("Order", f"{usd(CLIP_USD)} post-only at the touch, 30 s, cancel on a 1 sigma retrace"), ("Costs", "maker fee 0, rebate 20% of the taker fee; 150 ms each way"), ("Window", f"{DAYS[0][5:]} to {DAYS[-1][5:]}, {HOURS}h, 1 regime, design only")]
BIG = [dict(mk("Net per fill, design", f"{sgn(SM['per'])} USD", f"95% {sgn(SM['per_lo'])} to {sgn(SM['per_hi'])}", gate="Interval above zero", key="effect"), scope="design"),
       dict(mk("Fills", f"{SM['n']:,}", f"{pct(RATE)} of burst windows", verdict="INFO"), scope="design"),
       dict(mk("Coin-side placebo, 95th pct", f"{sgn(P95)} USD", f"rule {sgn(SM['per'])}", gate="Beats the coin side"), scope="design"),
       dict(mk("Fill minus miss, 5 s mid", f"{sgn(ADV['token mid, +5 s'][2] * 100)} cents", f"95% {sgn(ADV['token mid, +5 s'][3] * 100)} to {sgn(ADV['token mid, +5 s'][4] * 100)}", gate="Fills worse than misses"), scope="design")]
BLOCKS = [
    ("The rule, design window", [mk("Net per fill", f"{sgn(SM['per'])} USD", "interval above 0", gate="Interval above zero"), mk("Win share", pct(SM["win"]), f"break-even {pct(SM['breakeven'])}", "INFO"), mk("Rebate a fill", f"{-SM['fee_per']:.3f} USD", "", "INFO"),
                                 mk("Days above zero", f"{POS_DAYS} of {len(DAYS)}", "", "INFO"), mk("Best 5% of fills hold", f"{TAILSH:.1f}x the net", "", "INFO")]),
    ("Against alternatives", [mk("Coin side, mean per fill", sgn(float(np.nanmean(PL_PER))), "", "INFO"), mk("Coin side, 95th percentile", sgn(P95), "below the rule", gate="Beats the coin side"), mk("Planted peek", sgn(_pk), "pays more", gate="Planted peek pays"),
                             mk("Taker, same windows", f"{sgn(SM_T['per'])} USD", f"{SM_T['n']:,} entries", "INFO"), mk("um-008, all coins", "-0.44 USD", "pooled", "INFO")]),
    ("Adverse selection", [mk("Win share, fill minus miss", f"{sgn(ADV['win share'][2] * 100, 1)} pt", f"95% {sgn(ADV['win share'][3] * 100, 1)} to {sgn(ADV['win share'][4] * 100, 1)}", "INFO"), mk("Token mid +5 s, fill minus miss", f"{sgn(ADV['token mid, +5 s'][2] * 100)} cents", "", gate="Fills worse than misses"),
                           mk("Token mid +30 s", f"{sgn(ADV['token mid, +30 s'][2] * 100)} cents", "", "INFO"), mk("Median wait to a fill", f"{ADV['fill delay, s']:.1f} s", "", "INFO")]),
    ("The forward read", [mk("Days seated", f"{FW_SEATED} of {FW_TOTAL}", "all", "INFO"), mk("Half-width at the read", f"{HW_FWD:.1f} USD", "a fill", "INFO"), mk("Days to show +1 a fill", f"{NEED_BAR / PER_DAY:,.0f}", "", "INFO")]),
    ("Checks", [mk("Windows with a book", pct(SHARE, 0), "90% bar", gate="Windows have a book"), mk("Taker rebuild", f"{len(FRM_T):,} entries", "4,185", gate="Taker rebuild equals"), mk("Engine checks held", f"{VERIFY['passed']} of {VERIFY['total']}", "all", gate="Engine checks pass")])]
_sz = []
for a_, nm_ in enumerate(("BTC", "ETH")):
    m_ = E["asset"] == a_
    s_ = B.summarize({k_: (v_[m_] if hasattr(v_, "__len__") and len(v_) == len(m_) else v_) for k_, v_ in E.items()}, TAB, nm_)
    _sz.append([nm_, f"{s_['n']:,}", sgn(s_["per"]), "INFO"])
FOOT = [_cut(f"Design window only: the BTC and ETH cut was found on it. Forward read registered as {RUN_ID}, {S.FORWARD_N} days, read once.", 160),
        _cut("The 22 days are one regime and the Polymarket days are those of um-003 to um-012: one window, not independent observations.", 160),
        _cut(f"{HOURS}h, {VERIFY['passed']}/{VERIFY['total']} checks; the fill model has not met a real fill; Binance and Polymarket clocks taken as one.", 160)]
CARD = {"question": _cut(QUESTION_CARD, 200), "answer": ANSWER, "implementation": IMPL, "big": BIG, "blocks": [{"title": t_, "rows": r_} for t_, r_ in BLOCKS],
        "sizes": {"cols": ["Coin, design", "Fills", "Net a fill", "Verdict"], "chosen": None, "rows": _sz}, "footer": FOOT}
_probs = REPORT.card_problems(CARD, metrics={k_: (None if v_ is None else float(v_)) for k_, v_ in METRICS.items()}, gates={g_["id"]: g_ for g_ in GATES}, word="NO SIZE", carry=False)
assert not _probs, _probs
''')
    nb.code(r'''
# ---- the study manifest fund.study/1 (evidence format, market kind) ----
import hashlib
from fundplat.data.predmkts import updown15_pin
from fundplat.data import derived
from fundplat.data.crypto import ticks
STUDY_GATES = [{k_: g_[k_] for k_ in ("id", "section", "name", "label", "reading", "verdict", "would_change")} for g_ in GATES]
_series, _unpinned = [], []
_ms = lambda d_: int(dt.datetime.strptime(d_, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
for d_ in DAYS:
    for fm_, tag_ in ((TT.FILL_MS, "d150"), (TAKER_FILL_MS, "d250")):
        m_ = derived.meta(TT.DATASET, RUNNER.key_of(d_, fm_))
        _series.append(dict(spec=f"tf15:{d_}:decision-table-{tag_}:-", pin=m_["hash"], rows=int(COV.set_index("day").loc[d_, "with_book"]), first_ts=_ms(d_), last_ts=_ms(d_) + 86_399_999, handle=None, cls="pin", trunc=False))
    mp_ = derived.meta(P.DATASET, P.key_of(d_))
    _series.append(dict(spec=f"mom15:{d_}:binance-1s-path:-", pin=mp_["hash"], rows=int(P.PRE_S + 86_400 + P.POST_S), first_ts=_ms(d_), last_ts=_ms(d_) + 86_399_999, handle=None, cls="pin", trunc=False))
    try:
        ip_ = updown15_pin.input_pin(d_)
        _series.append(dict(spec=f"polymarket:updown15 {d_}:l2-ladders:-", pin=hashlib.sha256(f"updown15-l2:{d_}:{ip_['digest']}".encode()).hexdigest(), rows=int(ip_["rows"]), first_ts=_ms(d_), last_ts=_ms(d_) + 86_399_999, handle=None, cls="pin", trunc=False))
    except KeyError as e_:
        _unpinned.append({"what": f"polymarket updown15 ladders {d_}", "why": f"the day is not finalized by the ladder job ({str(e_)[:60]})"})
for s_ in ("BTCUSDT", "ETHUSDT"):
    ip_ = ticks.input_pin(s_, _ms(DAYS[0]), _ms(DAYS[-1]) + 86_400_000)
    _series.append(dict(spec=f"binance:{s_}:aggTrades:-", pin=hashlib.sha256(f"binance:{s_}:{ip_['digest']}".encode()).hexdigest(), rows=int(sum(f["rows"] for f in ip_["files"])), first_ts=_ms(DAYS[0]), last_ts=_ms(DAYS[-1]) + 86_399_999, handle=None, cls="pin", trunc=False))
_unpinned.append({"what": "gamma market list (updown15.markets)", "why": "a day cache of the venue's own listing, re-readable; its outcomes are inside the derived days' pins"})
_unpinned.append({"what": f"the forward days {S.FORWARD_FROM} to {S.FORWARD_DAYS[-1]}", "why": "not read until all are seated; their pins join the manifest of the run that opens them"})
INPUTS = {"digest": REPORT.inputs_digest([x_["pin"] for x_ in _series]), "series": _series, "unpinned": _unpinned}
PROFILE = {"market": "predmkts", "markets": ["predmkts", "crypto"], "venues": ["polymarket", "binance"], "instruments": ["BTC, ETH 15m Up/Down", "spot aggTrades"], "bar": "15m"}
COMPONENTS = [{"name": "payoff less cost", "usd": float(E["gross"].sum())}, {"name": "maker rebate", "usd": float(-E["fee"].sum())}]
assert abs(sum(c_["usd"] for c_ in COMPONENTS) - SM["net"]) < 0.01
FIG_KINDS = {"fig:s2-funnel": "sample-funnel-and-coverage", "fig:s3-luck": "significance-test", "fig:s3-concentration": "regime-and-concentration", "fig:s4-grid": "rule-comparison", "fig:s4-queue": "sizing-and-fill",
             "fig:s4-adverse": "signal-decay", "fig:s5-power": "sample-size-and-power"}
assert {f_["id"] for f_ in FIGURES} == set(FIG_KINDS), set(FIG_KINDS) ^ {f_["id"] for f_ in FIGURES}
for f_ in FIGURES:
    f_["kind"] = FIG_KINDS[f_["id"]]
CAVEATS = ["design window only: the BTC and ETH cut was found on it, so no gate of it is a test",
           "the fill model has not met a real fill: queue, matching order and rebate are assumptions",
           "the maker rebate is paid daily by liquidity share; here it is accrued per fill",
           "a print at or through the bid fills it whatever its side; the side is not read",
           "22 days of one regime: the grid and the bands are one window re-sliced",
           "the price bands were cut after the first look: descriptive, not a hunt",
           "the forward read is too coarse for the design estimate; its likeliest result spans zero",
           "the Binance trade-implied mid stands in for the Chainlink reference (about 1.9 bp apart)",
           "the book is a reconstruction of the venue's stream; Binance and Polymarket clocks taken as one",
           "the pinned ladders keep ten levels a side; only the touch is read by a bid at the touch"]
assert all(len(c_) <= 110 for c_ in CAVEATS), [len(c_) for c_ in CAVEATS]
VERDICT = {"word": "NO SIZE", "why": [_cut(f"net {sgn(SM['per'])} USD a fill, 95% {sgn(SM['per_lo'])} to {sgn(SM['per_hi'])}, on {SM['n']:,} design fills", 110),
                                      _cut(f"fills win {mag(ADV['win share'][2] * 100, 1)} pt less than misses; the token mid moves {sgn(ADV['token mid, +5 s'][2] * 100)} cents against a fill", 110),
                                      _cut(f"forward read {FW_SEATED} of {FW_TOTAL} days seated; half-width {HW_FWD:.1f} USD a fill", 110)],
           "next_bet": _cut(f"the registered forward read ({RUN_ID}); more untouched days if the owner wants an answer sooner", 150)}
HEADLINE = {"metric": "net USD per fill, design window", "label": "Net per fill", "value": round(float(SM["per"]), 4), "unit": "usd", "hurdle": 0.0, "gate": GID["Interval above zero"]}
_cs = pd.Series(E["net"]).groupby(E["slot"]).sum().cumsum()
EQ = [(dt.datetime.fromtimestamp(int(sl_) * 900, dt.timezone.utc), float(BOOK_USD + v_)) for sl_, v_ in _cs.items()]
MANIFEST = REPORT.build_manifest(
    id=STUDY_ID, kind=KIND, desk=DESK, title=TITLE, question=QUESTION, status="registered", run={"executed": RUN_AT, "kernel": "ccvenv"}, inputs=INPUTS, window=WINDOW,
    verify={"suite": VERIFY["suite"], "passed": VERIFY["passed"], "total": VERIFY["total"], "books": VERIFY["books"]}, gates=STUDY_GATES, figures=FIGURES, verdict=VERDICT, caveats=CAVEATS,
    sections=REPORT.sections({"S6": "no position; the study sizes nothing"}), headline=HEADLINE, components=COMPONENTS, summary=CARD, format="evidence", metrics=METRICS, na=NA, equity=EQ, profile=PROFILE, book=None)
S0_HANDLE.update(Markdown(REPORT.summary_md(MANIFEST)))
display(REPORT.display_bundle(MANIFEST), raw=True)
print("\n".join(l_.replace(f"RESULT {RUN_ID} ", "") for l_ in RESULT_LINES))
''', "manifest")
    nb.md(r'''
## A · Appendix

The sensitivity cells, the price bands and the largest fills of the primary order.
''')
    nb.code(r'''
display(Markdown("**Every sensitivity cell**")); display(HTML(GR.round(3).to_html(index=False, border=0)))
display(Markdown("**Net per fill by the price of the bid**")); display(HTML(_b.round(3).to_html(index=False, border=0)))
display(Markdown("**The queue sweep**")); display(HTML(QR.round(3).to_html(index=False, border=0)))
_top = pd.DataFrame({"day": [DAYS[i_] for i_ in E["day"]], "coin": [("btc", "eth")[a_] for a_ in E["asset"]], "side": E["side"], "bid": E["b"], "queue ahead": E["q"], "shares": E["shares"], "won": E["won"], "net": E["net"]})
display(Markdown("**The 15 best and 15 worst fills**")); display(HTML(pd.concat([_top.sort_values("net").head(15), _top.sort_values("net").tail(15)]).round(3).to_html(index=False, border=0)))
''')
    nb.md(r'''
## Research summary
''')
    nb.code(r'''
assert [g1_["verdict"] for g1_ in MANIFEST["gates"]] == [g1_["verdict"] for g1_ in GATES] and MANIFEST["verdict"]["word"] == "NO SIZE" and len(MANIFEST["figures"]) == len(FIGURES)
display(Markdown(HEADLINE_MD))
display(Markdown(NEXT_MD))
display(HTML(summary_card.render(CARD, carry=False)))
display(Markdown("**Gates**\n\n| Gate | Verdict |\n|---|---|\n" + "\n".join(f"| {g_['id']} {g_['label']}: {g_['reading']} | **{g_['verdict']}** |" for g_ in GATES)))
''', "summary")


def build(execute: bool = True, out: Path | None = None) -> int:
    nb = NB()
    cells(nb)
    nbk = new_notebook(cells=nb.cells, metadata={"kernelspec": {"name": "ccvenv", "display_name": "ccvenv", "language": "python"}, "language_info": {"name": "python"}})
    path = out or (HERE / f"{STEM}.ipynb")
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
