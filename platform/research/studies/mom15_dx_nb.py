"""The diagnosis cells of B-0662 (why the directional momentum pair of um-009 loses): the words are here, every number is computed by the cells from `mom15_diag` and the decision tables
of the strategy search. Since 2026-10-10 these cells build no notebook of their own: `mom15_merge` lifts them into S5 of `2026-10-08-predmkts-binance-momentum-15m-updown.ipynb` (the
owner: one notebook, not three); the two diagnosis notebooks are retired. `cells(nb)` is the bank; its S0 to S2 and S6 to S7 are dropped or rewritten by the merge.
"""
from __future__ import annotations

from nbformat.v4 import new_code_cell, new_markdown_cell


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
# Why does the chosen momentum pair lose, where do the losses sit, and is there an edge anywhere inside it?

## S0 · Summary
''')
    nb.code(r'''
from IPython.display import Markdown, display
ANS0 = display(Markdown("_The answer is written here when the run finishes._"), display_id=True)
''')
    nb.md(r'''

**Research question.** The directional momentum study (um-009) ended NO MONEY: its chosen pair, buy the 15-minute Up/Down token in the direction of a one-second Binance move of 2.5 sigma and hold to expiry, lost on the test days. This study reasons the failure through instead of accepting it. Are the losses clustered? Are they in line with the probabilities the entry price implies? Is there any sub-regime where the actual win share clears break-even, and does it survive the number of places that were looked?

**The idea.** One identity does most of the work: for an entry, net = shares x (won - (price paid + fee) / shares). So the actual win share against the share the price and fee ask IS the net, and it splits into named terms: what the outcome did against the fair value, what the fair value said against the book, what the book did in the 250 ms, what spread and depth took, and the fee. Each term is read on the same entries, so the failure gets a name instead of a guess.

| | |
|---|---|
| Market | Polymarket 15-minute crypto Up/Down (BTC, ETH, SOL, XRP), driven by Binance spot trades |
| Subject | the pair um-009 froze, read again; nothing is chosen, tuned or re-fitted here |
| Primary sample | the pair's test entries (the days um-009 opened once); every table also shows the same pair over all the days read, as a cross-check |
| Three questions | clustering (by coin, UTC block, volatility, time into the window, with or against the leader, by slot and by day), probability alignment (actual against price and fee, by price band and label), edge hunt (every slice and signal cell, with a correction for the number looked at) |
| A fourth, from the owner's note of 2026-10-08 | the goal is a tradeable strategy, so where is the next edge: a structural scan of the book with no Binance signal, the near-certain buy rule re-read, and what a resting order would keep |
| Unit of error | a 15-minute slot: the four coins that start together move together, so every interval and every test clusters on it |
| Status | exploratory, opened after the um-009 verdict; the slices, bins and family are fixed in `mom15_diag.py` and counted below |

The result and its gates are drawn by the last cells.

**Falsifier, written before the slices were read.** The reading "the pair has no edge to find, it is cost-bound" ends if any line below holds.

| Id | The reading ends if |
|---|---|
| F1 | the edge before friction is above the friction at the 95% level on the test entries |
| F2 | the actual win share clears the price plus the fee at the 95% level |
| F3 | the burst's side beats buying the token that is already ahead, at the same seconds, at the 95% level |
| F4 | some slice or signal cell clears the best-of-N line (a slot bootstrap of the maximum t over every hypothesis tried) |
| F5 | a structural cell (price paid x time left, no Binance signal at all) clears its own best-of-N line, or the near-certain buy rule of um-006 earns above zero at the 95% level over all days read |
''')
    nb.md(r'''
**Prior art** (carried from the desk's books, read 2026-10-08; not re-read today [1])

| Source | What it found | What we take from it |
|---|---|---|
| `2026-10-08-predmkts-binance-momentum-15m-updown` (um-009) | the chosen pair lost on the test days with an interval that spans zero; every early exit lost more; slow lookbacks won more often at an equally higher price | the verdict is a fact; this study asks why |
| the B-0654 strategy search (um-005 to um-008) | taker rules at 150 ms die on the fee; the pooled out-of-sample interval of each includes zero | the fee is a named term here, not a residual |
| Young 2026 (OpenMarket, arXiv 2607.26245; read 2026-10-07 [1]) | Polymarket quotes followed large Binance moves by a median 347 ms | the 250 ms term C measures how much of the move the book takes back before the fill |
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
STUDY_ID = "2026-10-08-predmkts-binance-momentum-15m-updown-diagnosis"
KIND = "market"
DESK = "lab/predmkts"
PARENT_STEM = "2026-10-08-predmkts-binance-momentum-15m-updown"
PARENT_RUN = "um-009"
TITLE = "Why does the chosen momentum pair lose, where do the losses sit, and is there an edge anywhere inside it?"
QUESTION = "Where do the losses of the um-009 pair cluster, do they match the probabilities the price implies, and does any sub-regime clear break-even after correcting for the number of looks?"
SEED = 7
FIT_DAYS = ("2026-09-30", "2026-10-01", "2026-10-02")
VALIDATE_DAYS = ("2026-10-03", "2026-10-04")
TEST_DAYS = ("2026-10-05", "2026-10-06")
EARLIER_WEEK = ("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29")
FRESH_DAY = ("2026-10-07",)
PAIR_L, PAIR_Z, PAIR_EXIT = 1, 2.5, "hold to expiry"
LOOKBACKS_S = (1, 5, 10, 30, 60, 180, 300)
Z_GRID = (1.5, 2.0, 2.5, 3.0)
MULTI = ((1, 60), (10, 60), (10, 300), (60, 300))
SHOW_Z = 2.5
CLIP_USD = 20.0
BOOK_USD = 1000.0
FILL_MS = 250
N_MIN = 30
N_BOOT = 4000
N_PERM = 4000
COIN_DRAWS = 20
TOP_K = 10
HOLD_OUT_DAYS = TEST_DAYS + FRESH_DAY
''', "parameters")
    nb.md(r'''
### S1.2 · Assumptions

| Item | Value | Source |
|---|---|---|
| The pair | buy USD 20 of the token in the direction of a one-second Binance move of at least 2.5 sigma, the first eligible second whose ladder fills, one entry per window, hold to expiry | um-009, frozen by its protocol |
| Fill | the exact ladder 250 ms after the decision, best level first, four levels deep, never above 0.97, at least 5 shares | the owner's brief (B-0660); um-009 [1] |
| Taker fee | shares x rate x p x (1 - p), the market's own rate, paid on entry only (the pair holds to expiry) | venue fact `fee.formula` [1]; market rows [API] |
| Edge before friction | the outcome against the book's mid at the decision, times the shares: won - mid(t), the Up book's best bid and ask as of the decision second | design |
| Fair value | the tables' Brownian P(Up) of the Chainlink 60 s TWAP rule from the Binance state at the decision | the 15-minute study (B-0642) |
| The leader | the token whose fair value is above one half at the decision second | design |
| The five terms | A = won - fair value; B = fair value - book mid at the decision; C = book mid at the decision - book mid at the fill ladder; D = book mid at the fill - volume-weighted price paid; E = - fee a share; A + B + C + D + E = net a share, asserted on every entry | design |
| Volatility terciles | the cuts of sigma over the coin's own median, read from every window at second 300, never from entries | design [U] |
| UTC blocks and time-in bins | four six-hour blocks; 10-20, 20-40, 40-90 and 90+ s into the window | design [U], fixed before any slice was read |
| Unit of error | a 15-minute slot, for every standard error, Wald test and bootstrap | `tf15_bt` |
| Hunt family | every one- and two-label slice of the pair (coin, UTC block, volatility, time in, side), and every signal cell of the um-009 grid (hold to expiry) whole and cut by coin | design; counted in S4 |
| Discovery and hold-out | discovery = the days before the test days; hold-out = the test days and the fresh day | design |
| Clocks | Binance trade time and the venue's book time taken as one clock | caveat |
''')
    nb.code(r'''
# ---- the PROSE check: the numbers the S1 tables state, held to the code ----
import mom15_bt as M, mom15_study as ST, mom15_diag as D, mom15_dx_figs as DF
import tf15_bt as B, tf15_report as RP, tf15_runner as RUNNER, tf15_table as TT, lift_figs as LF
PROSE = {"delay": (ST.FILL_MS, FILL_MS), "clip": (B.CLIP_USD, CLIP_USD), "min shares": (B.MIN_SHARES, 5.0), "price limit": (M.LIMIT, 0.97), "levels": (TT.L, 4), "min entries": (ST.N_MIN, N_MIN),
         "blocks": (len(D.TOD_LABELS), 4), "time bins": (len(D.TIMING_LABELS), 4), "time edges": (D.TIMING_EDGES, (10, 20, 40, 90, 841))}
BAD = {k_: v_ for k_, (v_, w_) in PROSE.items() if v_ != w_}
assert not BAD, f"the S1 tables no longer describe this run: {BAD}"
assert (ST.FIT, ST.VALIDATE, ST.TEST, ST.EARLIER_WEEK, ST.FRESH_DAY) == (FIT_DAYS, VALIDATE_DAYS, TEST_DAYS, EARLIER_WEEK, FRESH_DAY)
assert M.LS == LOOKBACKS_S and M.ZS == Z_GRID and ST.MULTI == MULTI
print(f"S1 tables: {len(PROSE)} stated numbers equal the code; the parameters cell equals the module defaults")
''')
    nb.md(r'''
### S1.3 · Data

No new input is read. The inputs are the ones um-009 pinned: the seated 1-second decision tables built for a 250 ms fill (`tf15_runner.py run --fill-ms 250`) and the Binance 1-second paths (`mom15_path.py run`), each loaded through `fundplat.data.derived` with the hash of its blob in the manifest. The test days are read here a second time, for the one pair um-009 froze and with no choice open to this study; the rebuild is asserted to equal um-009's own printed result before anything is cut (S2).

| source | what | window | guard |
|---|---|---|---|
| `derived tf15-table` | the 1 s decision table per day, fill delay 250 ms | every day of S1.1 | the derived blob's hash, pinned in the manifest |
| `derived mom15-path` | the 1 s Binance mid per coin | every day of S1.1 | the derived blob's hash, pinned in the manifest |
| `updown15_pin.read`, `ticks.day_frame` | the ladders and trades the two tables above were built from | every day of S1.1 | the day manifests' digests, pinned in the manifest |
''')
    nb.code(r'''
import datetime as dt, json, math, time, contextlib, io as _io
import numpy as np, pandas as pd
from IPython.display import HTML, Markdown, display
from fundplat.quant.core import figstyle, report as REPORT, summary_card
get_ipython().run_line_magic("config", "InlineBackend.print_figure_kwargs = {'bbox_inches': None}")
LF.setup()
pd.set_option("display.float_format", lambda v: f"{v:.3f}")
RUN_AT = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
DAYS_ALL = FIT_DAYS + VALIDATE_DAYS + TEST_DAYS + EARLIER_WEEK + FRESH_DAY
ROLES = {d_: r_ for r_, ds_ in (("fit", FIT_DAYS), ("validate", VALIDATE_DAYS), ("test", TEST_DAYS), ("earlier week", EARLIER_WEEK), ("fresh day", FRESH_DAY)) for d_ in ds_}
HOURS_ALL = 24 * len(DAYS_ALL)
WINDOW = {"from": f"{min(DAYS_ALL)}T00:00Z", "to": f"{(dt.date.fromisoformat(max(DAYS_ALL)) + dt.timedelta(days=1)).isoformat()}T00:00Z", "hours": HOURS_ALL, "regimes": 1}
pct = lambda v, d=1: f"{v * 100:.{d}f}%"
sgn = lambda v, d=2: f"{v:+,.{d}f}"
usd = lambda v, d=0: f"USD {v:,.{d}f}"
mag = lambda v, d=2: f"{abs(v):,.{d}f}"
pfmt = lambda p_: "< 0.001" if p_ < 0.001 else f"= {p_:.3f}"
LABEL_NAMES = {"coin": "coin", "tod": "UTC block", "vol": "volatility", "timing": "time into the window", "lead": "side against the fair value"}
WIN_TEST = f"{TEST_DAYS[0][5:]} to {TEST_DAYS[-1][5:]} · {24 * len(TEST_DAYS)}h · the pair's test days"
WIN_ALL = f"{min(DAYS_ALL)[5:]} to {max(DAYS_ALL)[5:]} · {HOURS_ALL}h · every day read, 15 days of one regime"
WIN_BOTH = f"{WIN_TEST.split(' · ')[0]} test, {min(DAYS_ALL)[5:]} to {max(DAYS_ALL)[5:]} all · {HOURS_ALL}h of 15 days, one regime"
FIGURES, GATES, CAVEATS = [], [], []
t0 = time.time()
TAB = M.MTab(DAYS_ALL, fill_ms=FILL_MS)
CUTS = D.vol_cuts(TAB)
print(f"{TAB.W} windows on {len(DAYS_ALL)} days loaded in {time.time() - t0:.0f}s; volatility terciles cut at {CUTS[1][0]:.2f} and {CUTS[1][1]:.2f} times the coin's median sigma")
''')
    nb.md(r'''
### S1.4 · Runs

The engine's own checks and the diagnosis module's own checks run here; every one that can fail is counted.
''')
    nb.code(r'''
def _count(fn):
    buf = _io.StringIO()
    with contextlib.redirect_stdout(buf):
        ok_ = fn()
    ls_ = [l_ for l_ in buf.getvalue().splitlines() if l_.strip().startswith(("ok", "FAIL"))]
    return bool(ok_), sum(l_.strip().startswith("ok") for l_ in ls_), len(ls_), buf.getvalue()
CHK = {nm_: _count(fn_) for nm_, fn_ in (("mom15_bt", M.selftest), ("tf15_bt", B.selftest), ("mom15_diag", D.selftest))}
for nm_, (ok_, p_, t_, txt_) in CHK.items():
    print(f"{nm_}: {p_} of {t_} checks passed")
    if nm_ == "mom15_diag":
        print(txt_)
assert all(v_[0] for v_ in CHK.values()), "an engine or diagnosis check failed"
VERIFY = {"suite": "mom15 engine and diagnosis checks", "passed": sum(v_[1] for v_ in CHK.values()), "total": sum(v_[2] for v_ in CHK.values()), "books": TAB.W}
''')
    # ------------------------------------------------------------------------------------ S2
    nb.md(r'''
## S2 · Data checks

| question | gate to S3 |
|---|---|
| Is there a book for the windows, does the rebuild of the pair equal um-009's own printed result, and do the five terms add to the net on every entry? | at least 90% of windows have a book; the 720 test entries and their net equal um-009's to the cent; the terms add to the net |
''')
    nb.code(r'''
# ---- coverage of the tables: windows with a book by the first decision second ----
COV = []
for d_ in DAYS_ALL:
    arrs_, meta_ = RUNNER.load(d_, FILL_MS)
    COV.append(dict(role=ROLES[d_], day=d_, windows=int(meta_["windows"]), with_book=int(meta_["ok"]), share=meta_["ok"] / meta_["windows"], fill_ms=int(meta_["fill_ms"])))
COV = pd.DataFrame(COV)
assert (COV.fill_ms == FILL_MS).all()
SHARE = float(COV.with_book.sum() / COV.windows.sum())
display(Markdown(f"**Windows with a book by the first decision second.** {int(COV.with_book.sum())} of {int(COV.windows.sum())} windows over {len(COV)} days ({pct(SHARE)}; the lowest day {pct(float(COV.share.min()))}). The others have no ladder, or a Binance gap over 30 s, and are out before any outcome is read."))
GATES.append({"id": "G1", "section": "S2", "label": "Windows have a book", "name": "at least 90% of windows have a ladder by the first decision second", "reading": f"{pct(SHARE)} of {int(COV.windows.sum())} windows",
              "verdict": "PASS" if SHARE >= 0.9 else "FAIL", "would_change": "a share below 90%"})
''')
    nb.code(r'''
# ---- the rebuild of the pair against um-009's own printed result ----
SIG, EXIT = M.Signal(PAIR_L, PAIR_Z), M.Exit("expiry")
ENT_ALL = M.run(TAB, SIG, EXIT)
FRM = D.entry_frame(TAB, ENT_ALL, SIG, ROLES, CUTS)
FRM_T = FRM[FRM["role"] == "test"].reset_index(drop=True)
from pathlib import Path
import nbformat
PARENT = nbformat.read(str(Path(PARENT_STEM + ".ipynb")), as_version=4)
_txt = "\n".join(o_.get("text", "") for c_ in PARENT.cells if c_.cell_type == "code" for o_ in c_.get("outputs", []) if o_.get("output_type") == "stream")
_allout = _txt + "\n".join(str(o_.get("data", {}).get("text/markdown", "")) for c_ in PARENT.cells if c_.cell_type == "code" for o_ in c_.get("outputs", []))
_get = lambda key_: float(next(l_.split("=")[1] for l_ in _txt.splitlines() if l_.startswith(key_ + "=")))
P_N, P_NET, P_WIN, P_PER = _get("test_entries"), _get("test_net_pnl_usd"), _get("test_win_rate_pct"), _get("test_net_per_entry_usd")
assert f"{M.Signal(PAIR_L, PAIR_Z).name} -> {PAIR_EXIT}" in _allout, "the parent notebook does not name this pair as its chosen pair"
_rb = dict(n=len(FRM_T), net=float(FRM_T["net"].sum()), win=float(FRM_T["won"].mean() * 100), per=float(FRM_T["net"].mean()))
display(Markdown(f"**Rebuild against {PARENT_RUN}.** The pair {SIG.name} -> {PAIR_EXIT} on the test days: {_rb['n']} entries, net {sgn(_rb['net'])} USD, win {_rb['win']:.2f}%, {sgn(_rb['per'], 4)} USD an entry. "
                 f"The parent notebook printed {int(P_N)} entries, net {sgn(P_NET)} USD, win {P_WIN:.2f}%, {sgn(P_PER, 4)} an entry."))
_same = (_rb["n"] == int(P_N)) and abs(_rb["net"] - P_NET) < 0.006 and abs(_rb["win"] - P_WIN) < 0.006 and abs(_rb["per"] - P_PER) < 0.00006
GATES.append({"id": "G2", "section": "S2", "label": "Rebuild equals um-009", "name": "the pair's test entries, net and win rate equal the parent notebook's printed result to the digits it printed", "reading": f"{_rb['n']} entries, net {sgn(_rb['net'])} USD, win {_rb['win']:.2f}%",
              "verdict": "PASS" if _same else "FAIL", "would_change": "a rebuild that drifts from the parent run"})
assert _same, "the rebuild does not equal um-009"
''')
    nb.code(r'''
# ---- the five terms add to the net on every entry, and the one-sided books are named ----
_sh = FRM["shares"].to_numpy()
_tot = ((FRM["won"] - FRM["pu_side"]) + (FRM["pu_side"] - FRM["mid_dec"]) + (FRM["mid_dec"] - FRM["mid_fill"]) + (FRM["mid_fill"] - FRM["vwap"]) - FRM["fee"] / FRM["shares"]) * _sh
_dmax = float(np.abs(_tot - FRM["net"]).max())
_nobid = int(sum(1 for w_, k_, s_ in zip(ENT_ALL["w"], ENT_ALL["k"], ENT_ALL["side"]) if not np.isfinite(B.ladder_of(TAB, np.array([w_]), np.array([k_]), np.array([s_]), buy=False)[0][0, 0])))
display(Markdown(f"**The five terms.** On all {len(FRM)} entries the terms add to the net: the largest difference is {_dmax:.1e} USD. {_nobid} entr{'y' if _nobid == 1 else 'ies'} met a book with no bid at the fill second; the book mid there is the best ask, so the half spread is nil."))
GATES.append({"id": "G3", "section": "S2", "label": "Terms add to the net", "name": "A + B + C + D + E equals the net on every entry", "reading": f"largest difference {_dmax:.1e} USD on {len(FRM)} entries", "verdict": "PASS" if _dmax < 1e-3 else "FAIL", "would_change": "a term left out"})
''')
    # ------------------------------------------------------------------------------------ S3
    nb.md(r'''
## S3 · Core result

| question | gate to S4 |
|---|---|
| Where does the money of an entry go, are the losses clustered, and do they match the probabilities the price implies? | the edge before friction is above the friction; the win share clears price plus fee |

### Where does the money go?
''')
    nb.code(r'''
ANS31 = display(Markdown("_The answer is written here when the run reaches the five terms._"), display_id=True)
''')
    nb.md(r'''
The five terms of the identity, on the test entries and on the same pair over all the days read. A positive A or B is the signal being right against the fair value and the book; C, D and E are the cost of getting the order filled.
''')
    nb.code(r'''
WF_T, WF_A = D.waterfall(FRM_T), D.waterfall(FRM)
ES_T, ES_A = D.edge_stats(FRM_T), D.edge_stats(FRM)
_out = FRM[FRM["role"] != "test"].reset_index(drop=True)
ES_O = D.edge_stats(_out)
_wt = WF_T.set_index("term")["usd"]; _wa = WF_A.set_index("term")["usd"]
_bul = [f"Test entries: the outcome beats the book's mid at the decision by {sgn(ES_T['edge'])} USD an entry (95% {sgn(ES_T['edge_lo'])} to {sgn(ES_T['edge_hi'])}); the friction is {sgn(ES_T['friction'])}: the 250 ms {sgn(_wt['C'])}, half spread and depth {sgn(_wt['D'])}, fee {sgn(_wt['E'])}. Net {sgn(ES_T['net'])}.",
        f"All {len(FRM)} entries of the 15 days: edge {sgn(ES_A['edge'])} (95% {sgn(ES_A['edge_lo'])} to {sgn(ES_A['edge_hi'])}), friction {sgn(ES_A['friction'])}, net {sgn(ES_A['net'])} (95% {sgn(ES_A['net_lo'])} to {sgn(ES_A['net_hi'])}).",
        "Green is a term that adds to the entry, red one that takes from it, the ink bar is the net with its 95% interval over 15-minute slots. A is the outcome against the fair value, B the fair value against the book, C the book's move in the 250 ms."]
figstyle.show(DF.waterfall_fig(WF_T, WF_A, f"the {len(FRM_T)} test entries", f"all {len(FRM)} entries, 15 days", WIN_BOTH, _bul), "fig:s3-waterfall", FIGURES)
''', "fig:s3-waterfall")
    nb.code(r'''
display(Markdown("**The five terms, USD an entry** (95% by 15-minute slot)"))
_wf = pd.concat([WF_T.assign(sample=f"test, {len(FRM_T)} entries"), WF_A.assign(sample=f"all days, {len(FRM)} entries")])[["sample", "term", "what", "usd", "lo", "hi"]]
display(HTML(_wf.round(3).to_html(index=False, border=0)))
_pw = _wt["A"] + _wt["B"]
_shares_t = float(FRM_T["shares"].mean())
display(Markdown(f"In share terms: a USD {CLIP_USD:g} clip buys {_shares_t:.1f} shares, so the edge of {sgn(ES_T['edge'])} USD is {ES_T['edge'] / _shares_t * 100:+.1f} points of win share over the book's mid, and the friction of {mag(ES_T['friction'])} USD asks {-ES_T['friction'] / _shares_t * 100:.1f} points. "
                 f"The pair wins {pct(float(FRM_T['won'].mean()))} of its test entries against a mid of {pct(float(FRM_T['mid_dec'].mean()))} at the decision, a volume-weighted price of {pct(float(FRM_T['vwap'].mean()))} and {pct(float(FRM_T['q'].mean()))} with the fee."))
GATES.append({"id": "G4", "section": "S3", "label": "Edge exceeds friction", "name": "the net on the test entries, edge before friction minus friction, is above zero with a 95% interval above zero", "reading": f"edge {sgn(ES_T['edge'])}, friction {sgn(ES_T['friction'])}, net {sgn(ES_T['net'])} USD (95% {sgn(ES_T['net_lo'])} to {sgn(ES_T['net_hi'])})",
              "verdict": "PASS" if ES_T["net_lo"] > 0 else "FAIL", "would_change": "an interval wholly above zero"})
''')
    nb.code(r'''
ANS31.update(Markdown(f"**The burst's side beats the book's mid by {sgn(ES_T['edge'])} USD an entry before friction, and friction takes {mag(ES_T['friction'])}, so the net is {sgn(ES_T['net'])}** (the {len(FRM_T)} test entries, {WIN_TEST.split(' · ')[0]}). "
                      f"Over all {len(FRM)} entries the edge is {sgn(ES_A['edge'])} and the friction {mag(ES_A['friction'])}."))
''')
    nb.md(r'''
### Are the losses clustered?
''')
    nb.code(r'''
ANS32 = display(Markdown("_The answer is written here when the run reaches the clustering tests._"), display_id=True)
''')
    nb.md(r'''
Each label cuts the pair's entries once: the coin, the six-hour UTC block, the volatility tercile, the time into the window, and whether the burst points with or against the token the fair value already favours. The share of the loss is the slice's part of the sum of the negative nets. The Wald test asks, with slots as clusters, whether the net per entry is the same at every level of a label.
''')
    nb.code(r'''
ORD = {"coin": list(D.COINS), "tod": list(D.TOD_LABELS), "vol": list(D.VOL_LABELS), "timing": list(D.TIMING_LABELS), "lead": ["with the leader", "against the leader"]}
SP = {d_: D.slice_pair(FRM_T, FRM, d_, ORD[d_]) for d_ in D.DIMS}
CL_T, CL_A = D.clustering(FRM_T, n_perm=N_PERM, seed=SEED), D.clustering(FRM, n_perm=N_PERM, seed=SEED)
for d_ in D.DIMS:
    display(Markdown(f"**By {LABEL_NAMES[d_]}.** Wald test of equal net per entry: test p = {CL_T['wald'][d_][2]:.3f}, all days p = {CL_A['wald'][d_][2]:.3f}"))
    display(HTML(SP[d_].round(3).to_html(index=False, border=0)))
''')
    nb.code(r'''
_lab = LABEL_NAMES
_worst = min(((r_["test net"], d_, r_[d_]) for d_ in D.DIMS for _, r_ in SP[d_].iterrows() if r_["test n"] >= 30))
_bul = [f"Wald p, equal net per entry across levels, test then all days: " + "; ".join(f"{_lab[d_]} {CL_T['wald'][d_][2]:.2f} / {CL_A['wald'][d_][2]:.2f}" for d_ in D.DIMS) + f". Five labels were tried, so a p must be under {0.05 / 5:.2f} to count at the 5% level.",
        f"Largest losing slice on the test entries: {_worst[2]} ({sgn(_worst[0])} USD an entry). The intervals are wide: read the dots as colour, the ticks as a second look.",
        "Dot and whisker: the test entries' net per entry with its 95% interval over slots; ink tick: the same level over all 15 days. Green is above zero, red below."]
figstyle.show(DF.clusters_fig([(d_, SP[d_]) for d_ in D.DIMS], WIN_BOTH, _bul, names=LABEL_NAMES), "fig:s3-clusters", FIGURES)
''', "fig:s3-clusters")
    nb.code(r'''
SV_T, SV_A, WS_T, WS_A, DY_T, DY_A = CL_T["slot_var"], CL_A["slot_var"], CL_T["worst"], CL_A["worst"], CL_T["day"], CL_A["day"]
display(Markdown(f"**Time clustering.** The nets of one slot are correlated, because the four coins start together and resolve together. The variance of the slot sums is {SV_T['ratio']:.2f} times what a shuffle of the same nets inside each day gives on the test entries (shuffle p {pfmt(SV_T['p'])}) and {SV_A['ratio']:.2f} times over all days (p {pfmt(SV_A['p'])}). "
                 f"The worst tenth of slots ({WS_T['slots']} of {WS_T['of']} on the test days) holds {pct(WS_T['obs'], 0)} of the total loss against {pct(WS_T['null_mean'], 0)} for a shuffle (p {pfmt(WS_T['p'])}); over all days {pct(WS_A['obs'], 0)} against {pct(WS_A['null_mean'], 0)} (p {pfmt(WS_A['p'])}). "
                 f"Between days, the spread of the day means is {'beyond' if DY_A['p'] < 0.05 else 'within'} what a shuffle across days gives (all days p = {DY_A['p']:.2f}, {DY_A['days']} days)."))
_dayrows = FRM.groupby(["role", "date"]).agg(entries=("net", "size"), win=("won", "mean"), price_fee=("q", "mean"), edge=("edge", "mean"), net=("net", "mean")).reset_index()
display(Markdown("**By day** (the pair over every day read; the role says which stage of um-009 used the day)"))
display(HTML(_dayrows.round(3).to_html(index=False, border=0)))
_posd = int((_dayrows["net"] > 0).sum())
GATES.append({"id": "G5", "section": "S3", "label": "Losses bunch by a label", "name": "net per entry differs by coin (cluster-robust Wald, test and all days, each under 0.05)", "reading": f"coin p = {CL_T['wald']['coin'][2]:.3f} on the test entries, {CL_A['wald']['coin'][2]:.3f} on all days; {_posd} of {len(_dayrows)} days above zero",
              "verdict": "INFO", "would_change": "a label that no longer splits the nets"})
''')
    nb.code(r'''
_split = [LABEL_NAMES[d_] for d_ in D.DIMS if CL_A["wald"][d_][2] < 0.05]
_cn = FRM.groupby("coin")["net"].mean()
ANS32.update(Markdown(f"**{('Only the ' + ' and '.join(_split) + ' splits') if _split else 'No label splits'} the loss.** Net per entry by coin over all days is " + ", ".join(f"{c_.upper()} {sgn(_cn[c_])}" for c_ in D.COINS if c_ in _cn.index)
                      + f"; the other labels (time of day, volatility, time into the window, with or against the leader) show no detectable split (all days, {WIN_ALL.split(' · ')[0]})."))
''')
    nb.md(r'''
### Are the losses in line with the probabilities?
''')
    nb.code(r'''
ANS33 = display(Markdown("_The answer is written here when the run reaches the calibration._"), display_id=True)
''')
    nb.md(r'''
The price paid is the market's probability of the win; the fee is a cost on top. If the actual win share equals the price, the market is calibrated and the loss is the fee and the spread; if it is below the price, the burst picks the wrong side; if it is above, there is an edge in the direction.
''')
    nb.code(r'''
FRM_T["band"] = FRM_T["band"].astype(str); FRM["band"] = FRM["band"].astype(str)
BANDS = [b_ for b_ in sorted(FRM["band"].unique(), key=lambda s_: float(s_.strip("(]").split(",")[0]))]
CAL_T = D.calibration(FRM_T, "band", order=[b_ for b_ in BANDS if b_ in set(FRM_T["band"])], min_n=1)
CAL_A = D.calibration(FRM, "band", order=BANDS)
CAL_T_ALL = D.calibration(FRM_T.assign(all="all entries"), "all")
CAL_A_ALL = D.calibration(FRM.assign(all="all entries"), "all")
display(Markdown("**Actual win share against the price and the fee, by price paid a share.** `win - price` is the calibration of the market's price at the entry; `win - price - fee` is what is left for the trader. Intervals are 95% by slot."))
display(Markdown(f"Test entries ({len(FRM_T)})")); display(HTML(CAL_T.round(3).to_html(index=False, border=0)))
display(Markdown(f"All days ({len(FRM)})")); display(HTML(CAL_A.round(3).to_html(index=False, border=0)))
display(Markdown("**All entries in one row**")); display(HTML(pd.concat([CAL_T_ALL.assign(sample="test"), CAL_A_ALL.assign(sample="all days")]).drop(columns="all").round(3).to_html(index=False, border=0)))
''')
    nb.code(r'''
_ct, _ca = CAL_T_ALL.iloc[0], CAL_A_ALL.iloc[0]
_bul = [f"Test entries: the burst's side won {pct(_ct['win'])} against {pct(_ct['price'])} paid and {pct(_ct['price + fee'])} with the fee: {sgn(_ct['win - price (pp)'], 1)} points over the price (95% {sgn(_ct['pp lo'], 1)} to {sgn(_ct['pp hi'], 1)}), {sgn(_ct['win - price - fee (pp)'], 1)} after the fee (95% {sgn(_ct['fee pp lo'], 1)} to {sgn(_ct['fee pp hi'], 1)}).",
        f"All days: {pct(_ca['win'])} against {pct(_ca['price'])} and {pct(_ca['price + fee'])}: {sgn(_ca['win - price (pp)'], 1)} over the price (95% {sgn(_ca['pp lo'], 1)} to {sgn(_ca['pp hi'], 1)}), {sgn(_ca['win - price - fee (pp)'], 1)} after the fee (95% {sgn(_ca['fee pp lo'], 1)} to {sgn(_ca['fee pp hi'], 1)}).",
        "Left: each dot is a price band, on the diagonal where the win share equals price plus fee; numbers are the test entries in the band. Right: the gap in points, bars for the test entries, ink ticks for all days; bands with few entries are colour, not numbers."]
figstyle.show(DF.calibration_fig(CAL_T, CAL_A, "test entries", "all days", WIN_BOTH, _bul), "fig:s3-calibration", FIGURES)
''', "fig:s3-calibration")
    nb.code(r'''
CAL_LAB = {}
for d_ in ("coin", "vol", "lead", "timing"):
    CAL_LAB[d_] = D.calibration(FRM, d_, order=ORD[d_])
    display(Markdown(f"**By {LABEL_NAMES[d_]}, all days** (win share against price and fee)"))
    display(HTML(CAL_LAB[d_][[d_, "entries", "win", "price", "price + fee", "win - price (pp)", "pp lo", "pp hi", "win - price - fee (pp)", "fee pp lo", "fee pp hi"]].round(3).to_html(index=False, border=0)))
_gap_ok = _ct["fee pp lo"] > 0
GATES.append({"id": "G6", "section": "S3", "label": "Win clears price + fee", "name": "the actual win share exceeds the share the price and fee ask, with a 95% interval above zero, on the test entries", "reading": f"{sgn(_ct['win - price - fee (pp)'], 1)} points (95% {sgn(_ct['fee pp lo'], 1)} to {sgn(_ct['fee pp hi'], 1)}); over the price alone {sgn(_ct['win - price (pp)'], 1)}",
              "verdict": "PASS" if _gap_ok else "FAIL", "would_change": "an interval wholly above zero"})
''')
    nb.code(r'''
_inline = _ca["pp lo"] <= 0 <= _ca["pp hi"]
ANS33.update(Markdown(f"**{'Yes' if _inline else 'No'}: the burst's side won {pct(_ca['win'])} of its entries against {pct(_ca['price'])} paid,** {sgn(_ca['win - price (pp)'], 1)} points over the price (95% {sgn(_ca['pp lo'], 1)} to {sgn(_ca['pp hi'], 1)}) and {sgn(_ca['win - price - fee (pp)'], 1)} after the fee (all days, {WIN_ALL.split(' · ')[0]}). "
                      + ("The price is a fair read of the win chance, so the loss is the fee and the spread." if _inline else "The price is not a fair read of the win chance.")))
''')
    # ------------------------------------------------------------------------------------ S4
    nb.md(r'''
## S4 · Robustness

| question | gate to S6 |
|---|---|
| Is the edge the burst's direction or just the favourite, does a slower lookback leave more after the friction, does any slice survive the number of places looked, and does the market keep moving our way after the entry? | the rows of the gate table below |

### Is the direction of the burst worth anything beyond buying the favourite?
''')
    nb.code(r'''
ANS41 = display(Markdown("_The answer is written here when the run reaches the three arms._"), display_id=True)
''')
    nb.md(r'''
Three arms at exactly the same firing seconds: the burst's side; the token the fair value already favours; a fair coin (the mean of 20 draws). The burst and the favourite point the same way when the burst goes with the leader and opposite ways when it goes against it.
''')
    nb.code(r'''
FR_ARMS, ARM_SUM = D.arms(TAB, SIG, EXIT, ROLES, CUTS, seeds=COIN_DRAWS)
AT = D.arm_terms(FR_ARMS)
DIFFS = {"burst minus favourite": D.arm_diff(FR_ARMS["momentum"], FR_ARMS["leader"]), "burst minus a coin": D.arm_diff(FR_ARMS["momentum"], FR_ARMS["coin"], "net_avg"), "favourite minus a coin": D.arm_diff(FR_ARMS["leader"], FR_ARMS["coin"], "net_avg")}
display(Markdown("**The three arms, USD an entry, all days**"))
display(HTML(AT.round(3).to_html(index=False, border=0)))
display(Markdown("**Differences in net per entry on the windows both arms entered** (95% by slot)"))
display(HTML(pd.DataFrame(DIFFS).T.round(3).to_html(border=0)))
_dm, _dl, _dc = DIFFS["burst minus favourite"], DIFFS["favourite minus a coin"], DIFFS["burst minus a coin"]
_ag = FR_ARMS["momentum"][FR_ARMS["momentum"]["lead"] == "against the leader"]["w"]
_agm = FR_ARMS["momentum"].set_index("w").loc[_ag, "net"].mean(); _agl = FR_ARMS["leader"].set_index("w").reindex(_ag)["net"].mean()
_bul = [f"The burst's side earns an edge of {sgn(AT.set_index('arm').loc['momentum', 'edge'])} USD before friction, the favourite {sgn(AT.set_index('arm').loc['leader', 'edge'])}, a fair coin {sgn(AT.set_index('arm').loc['coin', 'edge'])}; the friction is {sgn(AT.set_index('arm').loc['momentum', 'friction'])}, {sgn(AT.set_index('arm').loc['leader', 'friction'])} and {sgn(AT.set_index('arm').loc['coin', 'friction'])}.",
        f"Burst minus favourite: {sgn(_dm['mean'])} USD an entry (95% {sgn(_dm['lo'])} to {sgn(_dm['hi'])}). The information in the burst is which side is ahead: the favourite earns {sgn(_dl['mean'])} more than a coin (95% {sgn(_dl['lo'])} to {sgn(_dl['hi'])}), the burst {sgn(_dc['mean'])} more.",
        f"On the {len(_ag)} firing seconds where the burst goes against the favourite, the burst's side nets {sgn(_agm)} an entry and the favourite's {sgn(_agl)}."]
figstyle.show(DF.arms_fig(AT, DIFFS, WIN_ALL, _bul), "fig:s4-arms", FIGURES)
''', "fig:s4-arms")
    nb.code(r'''
GATES.append({"id": "G7", "section": "S4", "label": "Burst beats favourite", "name": "the burst's side nets more per entry than buying the token already ahead at the same seconds, with a 95% interval above zero", "reading": f"{sgn(_dm['mean'])} USD an entry (95% {sgn(_dm['lo'])} to {sgn(_dm['hi'])}); the favourite beats a coin by {sgn(_dl['mean'])}",
              "verdict": "PASS" if _dm["lo"] > 0 else "FAIL", "would_change": "an interval wholly above zero"})
''')
    nb.code(r'''
_same = _dm["lo"] <= 0 <= _dm["hi"]
ANS41.update(Markdown(f"**{'No' if _same else 'Yes'}: the burst's side nets {sgn(_dm['mean'])} USD an entry more than buying the token already ahead** (95% {sgn(_dm['lo'])} to {sgn(_dm['hi'])}; all days, {WIN_ALL.split(' · ')[0]}). The favourite itself beats a fair coin by {sgn(_dl['mean'])}."))
''')
    nb.md(r'''
### Does a slower lookback leave more after the friction?
''')
    nb.code(r'''
ANS42 = display(Markdown("_The answer is written here when the run reaches the lookback table._"), display_id=True)
''')
    nb.md(r'''
um-009 found that slower moves win more often but at an equally higher price. The same split on each lookback at one threshold, hold to expiry, over all days: the edge before friction against the friction, and the net.
''')
    nb.code(r'''
t0 = time.time()
CELL_FR = {}
for sg_ in [M.Signal(L_, z_) for L_ in LOOKBACKS_S for z_ in Z_GRID] + [M.Signal(a_, 2.0, Ll=b_) for a_, b_ in MULTI]:
    e_ = M.run(TAB, sg_, EXIT)
    CELL_FR[sg_.name] = D.entry_frame(TAB, e_, sg_, ROLES, CUTS) if len(e_["w"]) else pd.DataFrame()
CT = D.cell_table(CELL_FR)
print(f"{len(CELL_FR)} signal cells scored in {time.time() - t0:.0f}s")
CTZ = CT[CT["cell"].str.endswith(f"|z{SHOW_Z:g}") & ~CT["cell"].str.contains(r"\+")].reset_index(drop=True)
display(Markdown(f"**Signal cells at z = {SHOW_Z:g}, hold to expiry, all days**"))
display(HTML(CTZ.round(3).to_html(index=False, border=0)))
_cz = CTZ.set_index("cell")
_bul = [f"Edge before friction by lookback: " + ", ".join(f"{c_.split('|')[0]} {sgn(r_['edge'])}" for c_, r_ in _cz.iterrows()) + " USD an entry.",
        f"Friction falls from {sgn(_cz.iloc[0]['friction'])} at {_cz.index[0].split('|')[0]} to {sgn(_cz.iloc[-1]['friction'])} at {_cz.index[-1].split('|')[0]} as the price plus fee a slow move asks rises from {pct(_cz.iloc[0]['price_fee'], 0)} to {pct(_cz.iloc[-1]['price_fee'], 0)}: near 0 or 1 the fee a share is small, and so is the win-share margin left.",
        f"Net by lookback: " + ", ".join(f"{c_.split('|')[0]} {sgn(r_['net'])}" for c_, r_ in _cz.iterrows()) + ". No lookback has a net interval wholly above zero." if not (_cz["lo"] > 0).any() else "At least one lookback has a net interval above zero; see the search over slices below for the correction."]
figstyle.show(DF.lookback_fig(CTZ, WIN_ALL, _bul), "fig:s4-lookback", FIGURES)
''', "fig:s4-lookback")
    nb.code(r'''
_anyl = bool((_cz["lo"] > 0).any())
ANS42.update(Markdown(f"**{'Yes, at least one' if _anyl else 'No'}: net per entry by lookback runs from {sgn(float(_cz['net'].min()))} to {sgn(float(_cz['net'].max()))} USD an entry and " + ("a lookback has an interval above zero" if _anyl else "no lookback has an interval wholly above zero") + f"** (z = {SHOW_Z:g}, hold to expiry, all days, {WIN_ALL.split(' · ')[0]})."))
''')
    nb.md(r'''
### Is there an edge in any slice, after correcting for the number of places looked?
''')
    nb.code(r'''
ANS43 = display(Markdown("_The answer is written here when the run reaches the search._"), display_id=True)
''')
    nb.md(r'''
Every one- and two-label slice of the pair, and every signal cell of the um-009 grid whole and cut by coin, is scored once on all days. The t of each is the cluster t of its net per entry. Three corrections: Holm over every hypothesis, and a slot bootstrap of the maximum t of the whole family under the null of no edge (centred nets, whole slots resampled) which gives the line that the best of N reaches by luck alone. Discovery is every day before the test days; hold-out is the test days and the fresh day.
''')
    nb.code(r'''
t0 = time.time()
FAM = {"chosen " + SIG.name + " hold": FRM, **{k_: v_ for k_, v_ in CELL_FR.items() if k_ != SIG.name}}      # the pair's own cell is its "all entries" and slices: not a second time
HUNT, HI = D.hunt(FAM, hold_days=HOLD_OUT_DAYS, n_boot=N_BOOT, seed=SEED, min_n=N_MIN)
print(f"{HI['n_hyp']} hypotheses scored in {time.time() - t0:.0f}s")
_top = HUNT.head(12)[["family", "hypothesis", "entries", "win", "price", "per", "t", "p_raw", "p_holm", "p_maxt", "disc_per", "hold_n", "hold_per"]]
display(Markdown(f"**The twelve highest t among {HI['n_hyp']} hypotheses** (p_raw one-sided; p_holm over all; p_maxt = the share of null bootstrap draws whose best hypothesis reaches this t)"))
display(HTML(_top.round(3).to_html(index=False, border=0)))
_best = HUNT.iloc[0]
_bul = [f"The best of {HI['n_hyp']} is {_best['hypothesis']} (t = {_best['t']:.2f}, raw p = {_best['p_raw']:.3f}); luck alone gives a best t of {HI['expected_best_t']:.2f} on average and {HI['q95_best_t']:.2f} at its 95th percentile. Corrected p of the best: Holm {_best['p_holm']:.2f}, max-t {_best['p_maxt']:.2f}.",
        f"{HI['n_raw_05']} hypotheses have a raw one-sided p under 0.05 (about {0.05 * HI['n_hyp']:.0f} would by luck if none had an edge); {HI['n_holm_05']} survive Holm and {HI['n_maxt_05']} the max-t line.",
        "Each dot is one slice or signal cell, ranked by t; the five highest are ink. The two dotted lines are the t of a single test at the 5% level and the best-of-N line."]
figstyle.show(DF.hunt_fig(HUNT, HI, WIN_ALL, _bul), "fig:s4-hunt", FIGURES)
''', "fig:s4-hunt")
    nb.code(r'''
SEL, SI = D.selection_check(HUNT, k=TOP_K)
display(Markdown(f"**The {SI['k']} best on the discovery days, read on the hold-out days** (the test days and the fresh day, {sum(1 for d_ in HOLD_OUT_DAYS)} days)"))
display(HTML(SEL.round(3).to_html(index=False, border=0)))
_bul = [f"The {SI['k']} slices that looked best before the test days earned {sgn(SI['disc_per'])} USD an entry where they were found and {sgn(SI['hold_per'])} on the hold-out days ({pct(SI['hold_share_pos'], 0)} of them above zero). Every hypothesis averages {sgn(SI['all_hold_per'])} on the hold-out days.",
        f"A search that finds structure should keep some of it out of sample; here the selected slices fall to the level of the rest. Rank correlation of discovery and hold-out net over all {HI.get('rank_corr_n', 0)} hypotheses: {HI.get('rank_corr', float('nan')):.2f}, but the hypotheses overlap (the same entries sit in many), so it overstates the evidence.",
        "Each dot is one slice or signal cell; ink dots are the best on the discovery days."]
figstyle.show(DF.holdout_fig(HUNT, WIN_ALL, _bul, k=TOP_K), "fig:s4-holdout", FIGURES)
''', "fig:s4-holdout")
    nb.code(r'''
_pcl = HI["n_maxt_05"] == 0
GATES.append({"id": "G8", "section": "S4", "label": "A slice clears best-of-N", "name": "some slice or signal cell has a max-t p under 0.05 across every hypothesis scored", "reading": f"best t {_best['t']:.2f} against the {HI['q95_best_t']:.2f} line; {HI['n_maxt_05']} of {HI['n_hyp']} survive",
              "verdict": "FAIL" if _pcl else "PASS", "would_change": "a hypothesis above the line"})
GATES.append({"id": "G9", "section": "S4", "label": "Best slices hold out", "name": "the ten best slices of the discovery days earn above zero on the hold-out days", "reading": f"{sgn(SI['disc_per'])} where found, {sgn(SI['hold_per'])} on the hold-out; baseline {sgn(SI['all_hold_per'])}",
              "verdict": "PASS" if SI["hold_per"] > 0 else "FAIL", "would_change": "selected slices that keep their level"})
''')
    nb.code(r'''
ANS43.update(Markdown(f"**{'No' if HI['n_maxt_05'] == 0 else 'Yes'}: the best of {HI['n_hyp']} slices and signal cells reaches t = {_best['t']:.2f}, and luck alone reaches {HI['q95_best_t']:.2f} at its 95th percentile.** {HI['n_maxt_05']} of them clear that line (all days, {WIN_ALL.split(' · ')[0]}); "
                      f"the ten best on the discovery days earn {sgn(SI['disc_per'])} USD an entry where they were found and {sgn(SI['hold_per'])} on the hold-out days."))
''')
    nb.md(r'''
### What does the market do after we buy?
''')
    nb.code(r'''
ANS44 = display(Markdown("_The answer is written here when the run reaches the forward moves._"), display_id=True)
''')
    nb.md(r'''
Binance and the token's mid after the entry, in the entry's direction, at one, five and thirty seconds. The book's move over the signal's own lookback against the fair value's move shows how much of the burst the book had already taken at the decision.
''')
    nb.code(r'''
FWD, RESP = D.forward(FRM)
FWD_T, RESP_T = D.forward(FRM_T)
display(Markdown("**All days**")); display(HTML(FWD.round(3).to_html(index=False, border=0)))
display(Markdown("**Test entries**")); display(HTML(FWD_T.round(3).to_html(index=False, border=0)))
_f = FWD.set_index(["source", "after"])
_bul = [f"Over all days Binance moves {sgn(_f.loc[('Binance mid', '+1 s'), 'mean'])} bp our way in one second, {sgn(_f.loc[('Binance mid', '+5 s'), 'mean'])} in five and {sgn(_f.loc[('Binance mid', '+30 s'), 'mean'])} in thirty; the token's mid moves {sgn(_f.loc[('token mid', '+1 s'), 'mean'])}, {sgn(_f.loc[('token mid', '+5 s'), 'mean'])} and {sgn(_f.loc[('token mid', '+30 s'), 'mean'])} cents. A true momentum is there, and it is small.",
        f"In the signal's own second the book's mid moved {RESP['book_cents']:.2f} cents our way while the fair value moved {RESP['fair_cents']:.2f}: the book had taken {pct(RESP['ratio'], 0)} of the model's reaction by the decision, and the 250 ms to the fill took back a further {-sum(FRM['mid_dec'] - FRM['mid_fill']) / len(FRM) * 100:.2f} cents a share on average.",
        f"Bars are means with 95% intervals over slots, green when the market moves our way, all 15 days. The test entries alone: Binance {', '.join(sgn(v_) for v_ in FWD_T[FWD_T['source'] == 'Binance mid']['mean'])} bp, token {', '.join(sgn(v_) for v_ in FWD_T[FWD_T['source'] == 'token mid']['mean'])} cents at the same horizons."]
figstyle.show(DF.drift_fig(FWD, WIN_ALL, _bul), "fig:s4-drift", FIGURES)
''', "fig:s4-drift")
    nb.code(r'''
_b5, _t5 = float(_f.loc[("Binance mid", "+5 s"), "mean"]), float(_f.loc[("token mid", "+5 s"), "mean"])
ANS44.update(Markdown(f"**{'Slightly' if (_b5 > 0 and _t5 > 0) else 'No'}: five seconds after an entry Binance has moved {sgn(_b5)} bp and the token's mid {sgn(_t5)} cents our way** (all days, {WIN_ALL.split(' · ')[0]}); the book had already taken {pct(RESP['ratio'], 0)} of the model's reaction at the decision."))
''')
    nb.md(r'''
### Is there an edge in the order book itself, with no Binance signal?
''')
    nb.code(r'''
ANS45 = display(Markdown("_The answer is written here when the run reaches the structural scan._"), display_id=True)
''')
    nb.md(r'''
The burst is not the only place to look. Here no signal is used and no side is chosen: USD 20 of each token (Up and Down) is bought at the first second of each time-left band whose ladder fills, held to expiry, on the same exact ladder 250 ms later with the fee. The net per entry by the price paid reads how the book prices a token against how often it pays. The family is the seven price bands x five time bands, and their cuts by coin and by token, counted and corrected as in the search over slices above.
''')
    nb.code(r'''
t0 = time.time()
SC = D.structural_scan(TAB, SIG, EXIT, ROLES, CUTS)
SC_T = SC[SC["role"] == "test"].reset_index(drop=True)
CAL_SC = D.calibration(SC, "pband", order=list(D.SCAN_P_LABELS), min_n=30)
CAL_SC_T = D.calibration(SC_T, "pband", order=[b_ for b_ in D.SCAN_P_LABELS if b_ in set(SC_T["pband"])], min_n=1)
HUNT_SC, HI_SC = D.hunt({"chosen scan": SC}, hold_days=HOLD_OUT_DAYS, n_boot=N_BOOT, seed=SEED, min_n=N_MIN, dims=("pband", "tband", "coin", "tok"))
print(f"{len(SC)} entries, {HI_SC['n_hyp']} hypotheses scored in {time.time() - t0:.0f}s")
PV = SC.pivot_table(index="pband", columns="tband", values="net", aggfunc="mean").reindex(index=list(D.SCAN_P_LABELS), columns=list(D.SCAN_T_LABELS))
PN = SC.pivot_table(index="pband", columns="tband", values="net", aggfunc="size").reindex(index=list(D.SCAN_P_LABELS), columns=list(D.SCAN_T_LABELS)).fillna(0).astype(int)
display(Markdown("**Net USD per entry by the price paid (rows) and the time left (columns), all days**")); display(HTML(PV.round(2).to_html(border=0)))
display(Markdown("**Entries in each cell**")); display(HTML(PN.to_html(border=0)))
display(Markdown("**Win share against price and fee by price band, all days**")); display(HTML(CAL_SC.round(3).to_html(index=False, border=0)))
display(Markdown(f"**The highest t among the {HI_SC['n_hyp']} structural hypotheses**")); display(HTML(HUNT_SC.head(8)[["by", "hypothesis", "entries", "win", "price", "per", "t", "p_raw", "p_holm", "p_maxt", "hold_n", "hold_per"]].round(3).to_html(index=False, border=0)))
''')
    nb.code(r'''
_scb = CAL_SC.set_index("pband")
_big = _scb[_scb["entries"] >= 300]
_cheap = _scb.loc["(0.0, 0.1]"]
_pos = int((PV.to_numpy() > 0).sum()); _cells = int(np.isfinite(PV.to_numpy()).sum())
_sc_best = HUNT_SC.iloc[0]
_bul = [f"No signal: {len(SC)} first-fill entries of both tokens over {len(DAYS_ALL)} days. In every price band of 300 entries or more the win share is within {float(_big['win - price (pp)'].abs().max()):.1f} points of the price paid; the fee and the spread are the whole loss ({_cells - _pos} of {_cells} price x time cells are below zero).",
        f"The cheapest tokens are the one band that is off: bought at {pct(_cheap['price'])} on average they won {pct(_cheap['win'])} ({sgn(_cheap['win - price (pp)'], 1)} points, {int(_cheap['entries'])} entries): the tick is one cent, which floors what a certain loser can ask, so cheap tokens are over-priced at the ask, and buying them is the worst cell ({sgn(_cheap['net per entry'])} USD an entry).",
        f"The best of {HI_SC['n_hyp']} structural hypotheses is {_sc_best['hypothesis']} (t = {_sc_best['t']:.2f}, max-t p = {_sc_best['p_maxt']:.2f}); {HI_SC['n_maxt_05']} survive the best-of-N line of {HI_SC['q95_best_t']:.2f}. Left: every dot is a price band on all days (cyan) and on the test days (grey); right: the gap after the fee, bars all days, ink ticks the test days."]
figstyle.show(DF.calibration_fig(CAL_SC, CAL_SC_T, "all days", "test days", WIN_ALL, _bul, question="Does the book price a token as often as it pays, at any price or time left?"), "fig:s4-structure", FIGURES)
''', "fig:s4-structure")
    nb.code(r'''
ANS45.update(Markdown(f"**{'No' if HI_SC['n_maxt_05'] == 0 else 'Yes'}: buying tokens with no signal loses to the fee and the spread in {_cells - _pos} of {_cells} price-by-time cells, and {HI_SC['n_maxt_05']} of {HI_SC['n_hyp']} structural hypotheses clear the best-of-N line** (all days, {WIN_ALL.split(' · ')[0]}). "
                      f"The cheapest tokens (under 10 cents) are the one band that is off: they win {abs(_cheap['win - price (pp)']):.1f} points {'less' if _cheap['win - price (pp)'] < 0 else 'more'} often than their price implies."))
''')
    nb.md(r'''
### Does buying near-certain tokens pay?
''')
    nb.code(r'''
ANS46 = display(Markdown("_The answer is written here when the run reaches the near-certain family._"), display_id=True)
''')
    nb.md(r'''
um-006 BUYS the token that asks at least 0.85 or 0.92 when the fair value clears its ask by a margin theta; it does not short anything. Its recorded out-of-sample point (the earlier week and the test days at a 150 ms fill) was the only positive one of the desk. Here the same family is replayed at 250 ms on all 15 days and split into the five terms.
''')
    nb.code(r'''
NC = {}
for a_lo_ in (0.85, 0.92):
    for th_ in (0.0, 0.02, 0.04):
        NC[(a_lo_, th_)] = D.near_certain(TAB, SIG, EXIT, ROLES, CUTS, a_lo_, th_)
_rows = []
for (a_lo_, th_), f_ in NC.items():
    es_ = D.edge_stats(f_)
    wf_ = D.waterfall(f_).set_index("term")["usd"]
    _rows.append({"ask at least": a_lo_, "fair value over ask": th_, "entries": len(f_), "win": f_["won"].mean(), "price + fee": f_["q"].mean(), "A": wf_["A"], "B": wf_["B"], "C": wf_["C"], "D": wf_["D"], "E": wf_["E"],
                  "net": es_["net"], "net lo": es_["net_lo"], "net hi": es_["net_hi"], "test net": float(f_[f_["role"] == "test"]["net"].mean()), "test n": int((f_["role"] == "test").sum())})
NCT = pd.DataFrame(_rows)
display(Markdown("**The near-certain family on all 15 days, USD an entry** (A fair value's surprise, B model against the book, C the 250 ms, D spread and depth, E fee; net with its 95% interval by slot)"))
display(HTML(NCT.round(3).to_html(index=False, border=0)))
NC_REG = NC[(0.92, 0.04)]
NC_T = NC_REG[NC_REG["role"] == "test"].reset_index(drop=True)
WF_NC_T, WF_NC_A = D.waterfall(NC_T), D.waterfall(NC_REG)
ES_NC = D.edge_stats(NC_REG)
_by = {r_: (int((NC_REG["role"] == r_).sum()), float(NC_REG[NC_REG["role"] == r_]["net"].mean())) for r_ in ("fit", "validate", "test", "earlier week", "fresh day")}
_bul = [f"The registered cell of um-006 (ask at least 0.92, fair value over the ask by 0.04) over all days: {ES_NC['n']} entries, net {sgn(ES_NC['net'])} USD an entry (95% {sgn(ES_NC['net_lo'])} to {sgn(ES_NC['net_hi'])}); the test days {sgn(_by['test'][1])} on {_by['test'][0]}. By role: " + ", ".join(f"{k_} {sgn(v_[1])} on {v_[0]}" for k_, v_ in _by.items()) + ".",
        f"The fair value says the token is worth {sgn(WF_NC_A.set_index('term').loc['B', 'usd'])} USD more than the book's mid; the outcome then lands {sgn(WF_NC_A.set_index('term').loc['A', 'usd'])} against the fair value. The gap is the model's own error: the book prices a near-certain token right and the Brownian model overstates it.",
        "Left panel the test entries, right panel all days. Green adds to an entry, red takes from it, the ink bar is the net with its 95% interval over slots."]
figstyle.show(DF.waterfall_fig(WF_NC_T, WF_NC_A, f"um-006's cell, {len(NC_T)} test entries", f"um-006's cell, all {len(NC_REG)} entries", WIN_BOTH, _bul, question="Where does the money of the near-certain buy go, and is the fair value's gap real?"), "fig:s4-nearcertain", FIGURES)
''', "fig:s4-nearcertain")
    nb.code(r'''
_scp = _sc_best["p_maxt"]
GATES.append({"id": "G10", "section": "S4", "label": "A structural cell clears", "name": "some price x time-left cell, or its cut by coin or token, has a max-t p under 0.05 across every structural hypothesis", "reading": f"best t {_sc_best['t']:.2f} against the {HI_SC['q95_best_t']:.2f} line; {HI_SC['n_maxt_05']} of {HI_SC['n_hyp']} survive; {int((HUNT_SC['t'] > 2).sum())} cells have t above 2",
              "verdict": "PASS" if HI_SC["n_maxt_05"] > 0 else "FAIL", "would_change": "a structural cell above the line"})
GATES.append({"id": "G11", "section": "S4", "label": "Near-certain buy pays", "name": "um-006's registered cell nets above zero over all days read, with a 95% interval above zero", "reading": f"{sgn(ES_NC['net'])} USD an entry (95% {sgn(ES_NC['net_lo'])} to {sgn(ES_NC['net_hi'])}) on {ES_NC['n']} entries; um-006 recorded +0.27 at 150 ms",
              "verdict": "PASS" if ES_NC["net_lo"] > 0 else "FAIL", "would_change": "an interval wholly above zero"})
''')
    nb.code(r'''
ANS46.update(Markdown(f"**{'Yes' if ES_NC['net_lo'] > 0 else 'No'}: um-006's registered cell nets {sgn(ES_NC['net'])} USD an entry over {ES_NC['n']} entries** (95% {sgn(ES_NC['net_lo'])} to {sgn(ES_NC['net_hi'])}; all days, {WIN_ALL.split(' · ')[0]}); the test days alone give {sgn(_by['test'][1])}."))
''')
    nb.md(r'''
### What would a resting order keep?
''')
    nb.code(r'''
ANS47 = display(Markdown("_The answer is written here when the run reaches the resting-order ceiling._"), display_id=True)
''')
    nb.md(r'''
A taker pays the 250 ms, the spread and depth and the fee. The venue charges a maker no fee and rebates a share of the taker fees [1], so the friction of a resting order is not the taker's friction, and what remains is the adverse selection: a resting buy fills most when the market has moved against it. The taker data above cannot measure that, so this is a ceiling, not a result.
''')
    nb.code(r'''
_mk = FRM[FRM["coin"].isin(["btc", "eth"])]
_tk = D.waterfall(_mk.reset_index(drop=True)).set_index("term")["usd"]
_ceil = D.edge_stats(_mk)
MK = dict(edge=_ceil["edge"], edge_lo=_ceil["edge_lo"], edge_hi=_ceil["edge_hi"], taker_friction=_ceil["friction"], fee=_tk["E"], spread=_tk["D"], delay=_tk["C"], taker_net=_ceil["net"])
display(Markdown(f"**BTC and ETH, all days, {len(_mk)} entries.** Edge before friction {sgn(MK['edge'])} USD an entry (95% {sgn(MK['edge_lo'])} to {sgn(MK['edge_hi'])}). A taker's friction is {sgn(MK['taker_friction'])}: the 250 ms {sgn(MK['delay'])}, half spread and depth {sgn(MK['spread'])}, fee {sgn(MK['fee'])}. "
                 f"A maker pays no fee (venue fact `fee.maker`, 0 USDC [1], read 2026-10-04; a 20% rebate of taker fees for crypto, `fee.category_rates` [1]) and no half spread, so the ceiling of a resting order that filled at the decision mid on every burst is the edge itself, {sgn(MK['edge'])}. "
                 f"The fills it would actually get are the ones where the price comes to it, which are the entries that lose the edge: um-008, a Binance-informed passive quote on all four coins, recorded -0.44 USD a fill pooled out of sample (95% -1.27 to +0.38) [1]. The BTC and ETH cut of a passive design has not been run."))
''')
    nb.code(r'''
ANS47.update(Markdown(f"**At most {sgn(MK['edge'])} USD an entry, the edge itself, and that is a ceiling and not a result:** a resting order pays no fee and no half spread, but it fills most when the price moves against it, which this data cannot measure (BTC and ETH, {len(_mk)} entries, all days, {WIN_ALL.split(' · ')[0]})."))
''')
    # ------------------------------------------------------------------------------------ S5
    nb.md(r'''
## S5 · Risk and diagnostics - Which coins hold the edge, and how long would it take to confirm?

| question | answer form |
|---|---|
| Where is the edge before friction, and which coins and sides pay the friction? | the terms by coin and by side, and the power needed to confirm what remains |
''')
    nb.code(r'''
ANS5 = display(Markdown("_The answer is written here when the run reaches the coin cuts._"), display_id=True)
''')
    nb.code(r'''
WB_C_T, WB_C_A = D.waterfall_by(FRM_T, "coin", D.COINS), D.waterfall_by(FRM, "coin", D.COINS)
WB_L_A = D.waterfall_by(FRM, "lead", ORD["lead"])
display(Markdown("**The terms by coin, test entries, USD an entry**")); display(HTML(WB_C_T.round(2).to_html(index=False, border=0)))
display(Markdown("**The terms by coin, all days, USD an entry**")); display(HTML(WB_C_A.round(2).to_html(index=False, border=0)))
display(Markdown("**The terms by side against the fair value, all days**")); display(HTML(WB_L_A.round(2).to_html(index=False, border=0)))
WE_COIN = (CL_A["wald_edge"]["coin"], CL_T["wald_edge"]["coin"])
_c = WB_C_A.set_index("coin")
display(Markdown(f"**The edge before friction is not the same on every coin.** Wald test of equal edge across coins: all days p = {WE_COIN[0][2]:.4f}, test entries p = {WE_COIN[1][2]:.3f}. Over all days the edge interval is wholly above zero on "
                 f"{', '.join(c_.upper() for c_ in D.COINS if _c.loc[c_, 'edge lo'] > 0) or 'no coin'} and not on {', '.join(c_.upper() for c_ in D.COINS if _c.loc[c_, 'edge lo'] <= 0) or 'none'}. "
                 f"Friction is {mag(_c.loc['btc', 'friction'])} on BTC and {mag(_c.loc['sol', 'friction'])} on SOL: the thinner books pay more for spread and depth. This is a coin cut of one window, a hypothesis for a forward read and not a finding."))
''')
    nb.code(r'''
# ---- what it would take to confirm the best remaining cut (BTC and ETH together) at the net it shows ----
_be = FRM[FRM["coin"].isin(["btc", "eth"])].reset_index(drop=True)
_mb, _sb = D.cl_mean(_be["net"].to_numpy(), _be["slot"].to_numpy())
_days_have = len(DAYS_ALL)
_need = _days_have * (2.8 * _sb / _mb) ** 2 if _mb > 0 else float("inf")
BE_ROW = dict(entries=len(_be), net=_mb, se=_sb, t=_mb / _sb, days_to_confirm=_need)
_eb = D.edge_stats(_be)
display(Markdown(f"**BTC and ETH only, all days.** {len(_be)} entries, edge before friction {sgn(_eb['edge'])} USD (95% {sgn(_eb['edge_lo'])} to {sgn(_eb['edge_hi'])}), friction {sgn(_eb['friction'])}, net {sgn(_mb)} (95% {sgn(_eb['net_lo'])} to {sgn(_eb['net_hi'])}), t = {BE_ROW['t']:.2f}. "
                 f"At that net and that spread, 80% power at the 5% level (one-sided) needs about {_need:,.0f} days of the same entries, against {_days_have} read. The cut was found by looking at four coins on this window, so a forward, pre-registered read is the only test."))
''')
    nb.code(r'''
_yes = [c_.upper() for c_ in D.COINS if _c.loc[c_, "edge lo"] > 0]
_no = [c_.upper() for c_ in D.COINS if _c.loc[c_, "edge lo"] <= 0]
ANS5.update(Markdown(f"**The edge before friction is wholly above zero on {' and '.join(_yes) or 'no coin'} and not on {' and '.join(_no) or 'none'}, and confirming BTC and ETH at the net they show would take about {_need:,.0f} days of the same entries, against {_days_have} read** (all days, {WIN_ALL.split(' · ')[0]})."))
''')
    # ------------------------------------------------------------------------------------ S6
    nb.md(r'''
## S6 · Decision

n/a - no position; the study measures why a rule loses and sizes nothing. What the next candidate should aim at is in S7.
''')
    # ------------------------------------------------------------------------------------ S7
    nb.md(r'''
## S7 · Verdict - Why do we lose?
''')
    nb.code(r'''
ANS7 = display(Markdown("_The answer is written here when the run reaches the verdict._"), display_id=True)
''')
    nb.code(r'''
# ---- the plain-words answer, from the run's own numbers; each claim of the wording is asserted, so a re-run that breaks the story stops here ----
assert ES_T["edge"] > 0 and ES_A["edge"] > 0 and ES_A["edge_lo"] > 0, "the story needs a positive edge before friction over all days"
assert ES_T["friction"] < -ES_T["edge"] and ES_A["friction"] < -ES_A["edge"], "the story needs the friction to exceed the edge"
assert _dm["lo"] <= 0 <= _dm["hi"], "the story needs the burst's side to equal the favourite's"
assert HI["n_maxt_05"] == 0 and HI["n_holm_05"] == 0, "the story needs no hypothesis to survive the correction"
assert all(CL_A["wald"][d_][2] > 0.05 for d_ in ("tod", "vol", "timing")) and CL_A["wald"]["coin"][2] < 0.05, "the story needs the coin, and no other label, to split the nets"
assert _ca["pp lo"] <= 0 <= _ca["pp hi"] and _ca["fee pp hi"] < 2.5, "the story needs the win share to sit on the price"
_wa = WF_A.set_index("term")["usd"]
HEADLINE_MD = (f"**The answer: the pair is cost-bound, and nothing inside it survives the correction for the looks.** On the {len(FRM_T)} test entries the side the burst picks beats the book's mid at the decision by {sgn(ES_T['edge'])} USD an entry (95% {sgn(ES_T['edge_lo'])} to {sgn(ES_T['edge_hi'])}; "
               f"{sgn(ES_A['edge'])} over all {len(FRM)} entries of the 15 days, 95% {sgn(ES_A['edge_lo'])} to {sgn(ES_A['edge_hi'])}): the signal is not noise. The friction between the decision and the settlement takes {mag(ES_T['friction'])} on the test entries ({mag(ES_A['friction'])} over all days), more than the edge: "
               f"the book moves {mag(_wa['C'])} against the order in the 250 ms, spread and depth take {mag(_wa['D'])} and the fee {mag(_wa['E'])} (all days). Net {sgn(ES_T['net'])} on the test entries, {sgn(ES_A['net'])} over all days. "
               f"**Clustering.** The loss does not sit in a time of day, a volatility regime or the early or late part of the window: no split of the net by those labels is detectable (Wald p {CL_A['wald']['tod'][2]:.2f}, {CL_A['wald']['vol'][2]:.2f}, {CL_A['wald']['timing'][2]:.2f} over all days; a failure to split is not proof of equality). The one label that splits it is the coin: net by coin over all days is "
               + ", ".join(f"{c_} {sgn(_c.loc[c_, 'net'])}" for c_ in D.COINS) + f" (Wald p {CL_A['wald']['coin'][2]:.3f} over all days and {CL_T['wald']['coin'][2]:.3f} on the test entries; five labels were tried, the line is {0.05 / 5:.2f}, so this is suggestive and not settled). The edge before friction sits in BTC and ETH ({sgn(_c.loc['btc', 'edge'])} and {sgn(_c.loc['eth', 'edge'])}) and not in SOL or XRP ({sgn(_c.loc['sol', 'edge'])} and {sgn(_c.loc['xrp', 'edge'])}), and the friction is larger on SOL and XRP ({mag(_c.loc['sol', 'friction'])} and {mag(_c.loc['xrp', 'friction'])} against {mag(_c.loc['btc', 'friction'])} and {mag(_c.loc['eth', 'friction'])}). "
               f"The nets of one slot are correlated (variance {SV_A['ratio']:.2f} times a shuffle), so 15 days of four coins carry fewer independent observations than entries. "
               f"**Probabilities.** The losses are in line with the probabilities: the winning share is {sgn(_ca['win - price (pp)'], 1)} points over the price paid (all days, 95% {sgn(_ca['pp lo'], 1)} to {sgn(_ca['pp hi'], 1)}; test entries {sgn(_ct['win - price (pp)'], 1)}, 95% {sgn(_ct['pp lo'], 1)} to {sgn(_ct['pp hi'], 1)}) and {sgn(_ca['win - price - fee (pp)'], 1)} after the fee (all days). The price is a fair read of the win chance, so there is no sign of adverse selection in the burst's side (a share below the price) and no sign of a hidden edge (a share above it beyond the interval); the loss is the fee and the spread paid for a margin of about {(_ca['win - price (pp)']):.1f} points. "
               f"**Edge.** Most of the information is which side is ahead, not the burst: buying the token already ahead at the same seconds nets {sgn(AT.set_index('arm').loc['leader', 'net'])} against the burst's {sgn(AT.set_index('arm').loc['momentum', 'net'])} (difference {sgn(_dm['mean'])}, 95% {sgn(_dm['lo'])} to {sgn(_dm['hi'])}). "
               f"Of {HI['n_hyp']} slices and signal cells the best has t = {_best['t']:.2f} against {HI['q95_best_t']:.2f} for the best of {HI['n_hyp']} by luck; none survives, and the ten best of the days before the test days earn {sgn(SI['hold_per'])} on the days after. "
               f"Slow lookbacks leave the same shape: the edge before friction stays near {sgn(float(CTZ['edge'].iloc[-1]))} to {sgn(float(CTZ['edge'].max()))} and the friction falls with the price, to a net near zero ({sgn(float(CTZ['net'].iloc[-2]))} at {CTZ['cell'].iloc[-2].split('|')[0]}, {sgn(float(CTZ['net'].iloc[-1]))} at {CTZ['cell'].iloc[-1].split('|')[0]}).")
assert HI_SC["n_maxt_05"] == 0 and ES_NC["net_lo"] <= 0, "the story needs no structural cell and no near-certain edge"
HEADLINE_MD += (f" **No structural edge either.** With no Binance signal and no side chosen, the win share is within {float(_big['win - price (pp)'].abs().max()):.1f} points of the price paid in every price band of 300 entries or more, and none of {HI_SC['n_hyp']} price x time x coin x token cells survives the best-of-N line (best t = {_sc_best['t']:.2f}). "
                f"The near-certain buy of um-006 nets {sgn(ES_NC['net'])} over all days (95% {sgn(ES_NC['net_lo'])} to {sgn(ES_NC['net_hi'])}, {ES_NC['n']} entries) at 250 ms: its fair-value gap (B {sgn(WF_NC_A.set_index('term').loc['B', 'usd'])}) is cancelled by the outcome against the model (A {sgn(WF_NC_A.set_index('term').loc['A', 'usd'])}), so the +0.27 recorded at 150 ms was noise around zero.")
display(Markdown(HEADLINE_MD))
''')
    nb.code(r'''
ANS7_TXT = (f"**We lose to cost, not to a missing signal:** the burst's side beats the book's mid by {sgn(ES_T['edge'])} USD an entry on the test entries, friction takes {mag(ES_T['friction'])}, and nothing inside the pair survives the correction for the looks "
            f"({len(FRM_T)} test entries, {WIN_TEST.split(' · ')[0]}).")
ANS7.update(Markdown(ANS7_TXT)); ANS0.update(Markdown(ANS7_TXT))
''')
    nb.code(r'''
NEXT_MD = (f"**Where the next tradeable edge is.** Not in a taker rule on this book: the book prices a token as often as it pays at every price and time left (the structural scan above), the near-certain gate is the model's error (S4.6), and the taker's friction ({mag(ES_A['friction'])} USD an entry over all days: the 250 ms {mag(_wa['C'])}, spread and depth {mag(_wa['D'])}, fee {mag(_wa['E'])}) is larger than the burst's edge before friction ({sgn(ES_A['edge'])}). "
           f"The one place a measured edge exists is the burst on BTC and ETH, {sgn(MK['edge'])} USD an entry before friction (95% {sgn(MK['edge_lo'])} to {sgn(MK['edge_hi'])}), against a taker's {mag(MK['taker_friction'])}. A different ROLE is what changes that arithmetic: a resting order pays no fee and no half spread [1], so its ceiling is the edge itself, and the open question is the adverse selection of its fills, which no taker data can answer. "
           f"**The next candidate is therefore a maker-side study of the burst on BTC and ETH only**, with a fill model on printed trades (um-008's design, cut to the two coins and to the burst seconds), pre-registered before any day after 10-07 is read; um-008's all-coin quote recorded -0.44 a fill, so the cut is a hypothesis and the ceiling is not a claim. "
           f"Taker-side, confirming the BTC and ETH net of {sgn(_mb)} (t = {BE_ROW['t']:.2f}) at its observed size needs about {_need:,.0f} days of entries and is the weaker lead.")
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
FALS = {"F1": GV["G4"] == "PASS", "F2": GV["G6"] == "PASS", "F3": GV["G7"] == "PASS", "F4": GV["G8"] == "PASS", "F5": GV["G10"] == "PASS" or GV["G11"] == "PASS"}
print("falsifier lines that hold:", [k_ for k_, v_ in FALS.items() if v_] or "none")
assert not any(FALS.values()), "a falsifier line holds: the cost-bound reading is not supported"
RESULT_LINES = [f"RESULT B-0662 diag_entries={len(FRM_T)}", f"RESULT B-0662 diag_edge_per_entry_usd={ES_T['edge']:.4f}", f"RESULT B-0662 diag_friction_per_entry_usd={ES_T['friction']:.4f}",
                f"RESULT B-0662 diag_net_per_entry_usd={ES_T['net']:.4f}", f"RESULT B-0662 diag_hunt_hypotheses={HI['n_hyp']}", f"RESULT B-0662 diag_hunt_best_t={_best['t']:.3f}", f"RESULT B-0662 diag_hunt_maxt_survivors={HI['n_maxt_05']}"]
print("\n".join(RESULT_LINES))
''')
    nb.code(r'''
# ---- the card, the verdict and the manifest ----
_cut = lambda s, n: s if len(s) <= n else s[: n - 1].rstrip() + "."
def mk(metric, value, bar="", verdict="", key=None, gate=None):
    r_ = {"metric": metric, "value": value, "bar": bar, "verdict": GV[GID[gate]] if gate else verdict}
    if gate:
        r_["gate"] = GID[gate]
    if key:
        r_["key"] = key
    return r_
_days_pos = int((FRM.groupby("date")["edge"].mean() > 0).sum())
METRICS = {"n_obs": float(len(FRM_T)), "effect": ES_T["edge"], "t_stat": ES_T["edge_t"], "p_value": ES_T["edge_p"], "ci95_low": ES_T["edge_lo"], "ci95_high": ES_T["edge_hi"], "rho": None, "r2": None,
           "oos_effect": ES_O["edge"], "stable_share_pct": 100.0 * _days_pos / FRM["date"].nunique(), "half_life_h": None, "n_regimes": 1.0}
NA = {"rho": "one effect on one sample: no second series to correlate with", "r2": "as rho", "half_life_h": "an edge per entry, not a spread series with a half-life"}
_g = lambda i_: GATES[[x_["id"] for x_ in GATES].index(i_)]
QUESTION_CARD = "Why does the um-009 momentum pair lose, where do the losses sit, and does any slice of it earn after correcting for the looks?"
ANSWER = _cut(f"NO SIZE. The burst's side beats the book's mid by {sgn(ES_T['edge'])} USD an entry; friction takes {mag(ES_T['friction'])}. Cost-bound: no slice or structural cell survives. Next: a maker on BTC and ETH.", 240)
IMPL = [("Pair", f"{SIG.name}, {PAIR_EXIT}, USD {CLIP_USD:g} a trade"), ("Sample", f"{len(FRM_T)} test entries; {len(FRM)} over {len(DAYS_ALL)} days"), ("Split", "A fair value, B model vs book, C 250 ms, D spread, E fee"),
        ("Unit", "15-minute slot, cluster tests"), ("Venue", "Polymarket 15m crypto Up/Down; paper only"), ("Window", f"{min(DAYS_ALL)[5:]} to {max(DAYS_ALL)[5:]}, {HOURS_ALL}h, 1 regime")]
BIG = [dict(mk("Edge before friction, an entry", f"{sgn(ES_T['edge'])} USD", f"friction {sgn(ES_T['friction'])}", gate="Edge exceeds friction", key="effect"), scope="test"),
       dict(mk("Net per entry", f"{sgn(ES_T['net'])} USD", f"95% {sgn(ES_T['net_lo'])} to {sgn(ES_T['net_hi'])}", gate="Edge exceeds friction"), scope="test"),
       dict(mk("Win share minus price and fee", f"{sgn(_ct['win - price - fee (pp)'], 1)} pt", f"95% {sgn(_ct['fee pp lo'], 1)} to {sgn(_ct['fee pp hi'], 1)}", gate="Win clears price + fee"), scope="test"),
       dict(mk("Best slice t, of all tried", f"{_best['t']:.2f}", f"best of {HI['n_hyp']} by luck {HI['q95_best_t']:.2f}", gate="A slice clears best-of-N"), scope="all days")]
_wt_ = WF_T.set_index("term")["usd"]
BLOCKS = [
    ("Where the money goes, test", [mk("A fair value's surprise", f"{sgn(_wt_['A'])} USD"), mk("B model against the book", f"{sgn(_wt_['B'])} USD"), mk("C book moves in 250 ms", f"{sgn(_wt_['C'])} USD"),
                                    mk("D half spread and depth", f"{sgn(_wt_['D'])} USD"), mk("E fee", f"{sgn(_wt_['E'])} USD"), mk("Edge before friction, all days", f"{sgn(ES_A['edge'])} USD", f"95% {sgn(ES_A['edge_lo'])} to {sgn(ES_A['edge_hi'])}", "INFO")]),
    ("Probabilities", [mk("Win share, test", pct(_ct["win"]), f"price {pct(_ct['price'])}", "INFO"), mk("Price plus fee, test", pct(_ct["price + fee"]), "", "INFO"),
                       mk("Win minus price, all days", f"{sgn(_ca['win - price (pp)'], 1)} pt", f"95% {sgn(_ca['pp lo'], 1)} to {sgn(_ca['pp hi'], 1)}", "INFO"), mk("Win minus price and fee, all", f"{sgn(_ca['win - price - fee (pp)'], 1)} pt", f"95% {sgn(_ca['fee pp lo'], 1)} to {sgn(_ca['fee pp hi'], 1)}", "INFO")]),
    ("Clustering, Wald p, all days", [mk("By coin", f"{CL_A['wald']['coin'][2]:.3f}", "", gate="Losses bunch by a label")] + [mk(f"By {_lab[d_]}", f"{CL_A['wald'][d_][2]:.2f}", "", "INFO") for d_ in ("tod", "vol", "timing", "lead")]
                                     + [mk("Slot variance over a shuffle", f"{SV_A['ratio']:.2f}x", "", "INFO")]),
    ("Direction", [mk("Burst minus favourite", f"{sgn(_dm['mean'])} USD", f"95% {sgn(_dm['lo'])} to {sgn(_dm['hi'])}", gate="Burst beats favourite"), mk("Favourite minus a fair coin", f"{sgn(_dl['mean'])} USD", f"95% {sgn(_dl['lo'])} to {sgn(_dl['hi'])}", "INFO"),
                   mk("Binance after 5 s, our way", f"{sgn(_f.loc[('Binance mid', '+5 s'), 'mean'])} bp", "", "INFO")]),
    ("Edge hunt", [mk("Hypotheses scored", f"{HI['n_hyp']}", "", "INFO"), mk("Raw p under 0.05", f"{HI['n_raw_05']}", f"by luck about {0.05 * HI['n_hyp']:.0f}", "INFO"), mk("Survive the max-t line", f"{HI['n_maxt_05']}", "", gate="A slice clears best-of-N"),
                   mk("Ten best, found then held out", f"{sgn(SI['disc_per'])} / {sgn(SI['hold_per'])}", "", gate="Best slices hold out")]),
    ("Structure and near-certain", [mk("Structural cells scored", f"{HI_SC['n_hyp']}", "", "INFO"), mk("Survive the max-t line", f"{HI_SC['n_maxt_05']}", "", gate="A structural cell clears"),
                                    mk("Cheapest band, win minus price", f"{sgn(_cheap['win - price (pp)'], 1)} pt", f"n = {int(_cheap['entries'])}", "INFO"), mk("Near-certain buy, all days", f"{sgn(ES_NC['net'])} USD", f"95% {sgn(ES_NC['net_lo'])} to {sgn(ES_NC['net_hi'])}", gate="Near-certain buy pays")]),
    ("Checks", [mk("Windows with a book", pct(SHARE, 0), "90% bar", gate="Windows have a book"), mk("Rebuild equals the parent run", f"{_rb['n']} entries", "", gate="Rebuild equals um-009"), mk("Engine and diagnosis checks", f"{VERIFY['passed']} of {VERIFY['total']}", "all", "INFO")])]
_sz = []
for c_ in D.COINS:
    r_ = _c.loc[c_]
    _sz.append([c_.upper(), f"{int(r_['entries']):,}", f"{sgn(r_['net'])}", "FAIL" if r_["net hi"] < 0 else ("PASS" if r_["net lo"] > 0 else "INFO")])
FOOT = [_cut(f"Exploratory, opened after the um-009 verdict; the test days are read a second time for the one frozen pair. {HI['n_hyp']} hypotheses scored, counted.", 160),
        _cut("The 15 days are one regime and the Polymarket days are those of um-003 to um-009: one window, not an independent observation.", 160),
        _cut(f"{HOURS_ALL}h, {VERIFY['passed']}/{VERIFY['total']} checks; the Binance and Polymarket clocks are taken as one.", 160)]
CARD = {"question": _cut(QUESTION_CARD, 200), "answer": ANSWER, "implementation": IMPL, "big": BIG, "blocks": [{"title": t_, "rows": r_} for t_, r_ in BLOCKS],
        "sizes": {"cols": ["Coin, all days", "Entries", "Net an entry", "Verdict"], "chosen": None, "rows": _sz}, "footer": FOOT}
_probs = REPORT.card_problems(CARD, metrics={k_: (None if v_ is None else float(v_)) for k_, v_ in METRICS.items()}, gates={g_["id"]: g_ for g_ in GATES}, word="NO SIZE", carry=False)
assert not _probs, _probs
''')
    nb.code(r'''
# ---- the study manifest fund.study/1 (evidence format, market kind) ----
import hashlib
from fundplat.data.predmkts import updown15_pin
from fundplat.data import derived
from fundplat.data.crypto import ticks
import mom15_path as P
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
    ip_ = ticks.input_pin(s_, _ms(min(DAYS_ALL)), _ms(max(DAYS_ALL)) + 86_400_000)
    _series.append(dict(spec=f"binance:{s_}:aggTrades:-", pin=hashlib.sha256(f"binance:{s_}:{ip_['digest']}".encode()).hexdigest(), rows=int(sum(f["rows"] for f in ip_["files"])), first_ts=_ms(min(DAYS_ALL)), last_ts=_ms(max(DAYS_ALL)) + 86_399_999, handle=None, cls="pin", trunc=False))
_unpinned.append({"what": "gamma market list (updown15.markets)", "why": "a day cache of the venue's own listing, re-readable; its outcomes are inside the derived days' pins"})
_unpinned.append({"what": f"the parent notebook {PARENT_STEM}.ipynb, read for its printed result in S2", "why": "a committed file of this repo, compared by value, not a data input"})
INPUTS = {"digest": REPORT.inputs_digest([x_["pin"] for x_ in _series]), "series": _series, "unpinned": _unpinned}
PROFILE = {"market": "predmkts", "markets": ["predmkts", "crypto"], "venues": ["polymarket", "binance"], "instruments": ["BTC, ETH, SOL, XRP 15m Up/Down", "spot aggTrades"], "bar": "15m"}
COMPONENTS = [{"name": "edge before friction", "usd": float(FRM["edge"].sum())}, {"name": "friction", "usd": float(FRM["net"].sum() - FRM["edge"].sum())}]
assert abs(sum(c_["usd"] for c_ in COMPONENTS) - float(FRM["net"].sum())) < 0.01
FIG_KINDS = {"fig:s3-waterfall": "profit-and-loss-attribution", "fig:s3-clusters": "regime-and-concentration", "fig:s3-calibration": "calibration", "fig:s4-arms": "rule-comparison", "fig:s4-lookback": "profit-and-loss-attribution",
             "fig:s4-hunt": "significance-test", "fig:s4-holdout": "out-of-sample-test", "fig:s4-drift": "signal-decay",
             "fig:s4-structure": "calibration", "fig:s4-nearcertain": "profit-and-loss-attribution"}
assert {f_["id"] for f_ in FIGURES} == set(FIG_KINDS), set(FIG_KINDS) ^ {f_["id"] for f_ in FIGURES}
for f_ in FIGURES:
    f_["kind"] = FIG_KINDS[f_["id"]]
CAVEATS = ["exploratory: opened after the um-009 verdict, nothing pre-registered; the family is counted",
           "the test days are read a second time for the one frozen pair; the rebuild equals um-009 to the cent",
           "15 days of one regime: the slices are one window re-sliced, the intervals are wide",
           "slices overlap (the same entries sit in many), so the hunt's counts are not independent",
           "the fair value is the tables' Brownian TWAP model; term A is the outcome against it, not an edge",
           "the Binance trade-implied mid stands in for the Chainlink reference (about 1.9 bp apart)",
           "the book is a reconstruction of the venue's stream; Binance and Polymarket clocks taken as one",
           "volatility, UTC and time-in bins are [U] design choices fixed before any slice was read",
           "a one-sided book (no bid) uses the best ask as the mid, so the half spread is nil there",
           "the maker ceiling is arithmetic on taker entries: no resting order was simulated here"]
assert all(len(c_) <= 110 for c_ in CAVEATS), [len(c_) for c_ in CAVEATS]
VERDICT = {"word": "NO SIZE", "why": [_cut(f"edge {sgn(ES_T['edge'])} USD, friction {sgn(ES_T['friction'])}, net {sgn(ES_T['net'])} an entry on {len(FRM_T)} test entries", 110),
                                      _cut(f"win share {sgn(_ct['win - price (pp)'], 1)} pt over the price, {sgn(_ct['win - price - fee (pp)'], 1)} pt after the fee", 110),
                                      _cut(f"no slice of {HI['n_hyp']}, no structural cell, no near-certain gate clears its line", 110)],
           "next_bet": _cut(f"a maker-side study of the burst on BTC and ETH only: edge {sgn(MK['edge'])} before friction, a taker's friction {mag(MK['taker_friction'])}, a maker's none", 150)}
assert all(len(w_) <= 110 for w_ in VERDICT["why"])
HEADLINE = {"metric": "edge before friction, USD an entry, test", "label": "Edge, USD", "value": round(float(ES_T["edge"]), 4), "unit": "usd", "hurdle": round(float(-ES_T["friction"]), 4), "gate": GID["Edge exceeds friction"]}
_cs = FRM_T.groupby("slot")["net"].sum().cumsum()
EQ = [(dt.datetime.fromtimestamp(int(sl_) * 900, dt.timezone.utc), float(BOOK_USD + v_)) for sl_, v_ in _cs.items()]
MANIFEST = REPORT.build_manifest(
    id=STUDY_ID, kind=KIND, desk=DESK, title=TITLE, question=QUESTION, status="run", run={"executed": RUN_AT, "kernel": "ccvenv"}, inputs=INPUTS, window=WINDOW,
    verify={"suite": VERIFY["suite"], "passed": VERIFY["passed"], "total": VERIFY["total"], "books": VERIFY["books"]}, gates=STUDY_GATES, figures=FIGURES, verdict=VERDICT, caveats=CAVEATS,
    sections=REPORT.sections({"S6": "no position; the study sizes nothing"}), headline=HEADLINE, components=COMPONENTS, summary=CARD, format="evidence", metrics=METRICS, na=NA, equity=EQ, profile=PROFILE, book=None)
S0_HANDLE.update(Markdown(REPORT.summary_md(MANIFEST)))
display(REPORT.display_bundle(MANIFEST), raw=True)
print("\n".join(l_.replace(f"RESULT B-0662 ", "") for l_ in RESULT_LINES))
''', "manifest")
    nb.md(r'''
## A · Appendix

Every hypothesis of the edge hunt with its discovery and hold-out numbers, every signal cell, and the largest losses of the pair on the test days.
''')
    nb.code(r'''
display(Markdown(f"**Every hypothesis scored ({HI['n_hyp']})**"))
display(HTML(HUNT[["family", "by", "hypothesis", "entries", "win", "price", "per", "t", "p_raw", "p_holm", "p_maxt", "disc_n", "disc_per", "hold_n", "hold_per"]].round(3).to_html(index=False, border=0)))
display(Markdown("**Every signal cell, hold to expiry, all days**")); display(HTML(CT.round(3).to_html(index=False, border=0)))
display(Markdown("**The 15 largest losses of the pair on the test days**"))
display(HTML(FRM_T.sort_values("net").head(15)[["date", "coin", "entry_s", "side", "lead", "shares", "vwap", "pu_side", "mid_dec", "won", "fee", "edge", "net"]].round(3).to_html(index=False, border=0)))
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
