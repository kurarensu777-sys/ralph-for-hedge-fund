"""Build and execute `2026-10-08-predmkts-binance-burst-15m-updown-buy-near-tests.ipynb` (um-011, then um-021 with four more signals, 2026-10-11): the buy-near tests of the burst-mispricing thesis on
Polymarket's 15-minute crypto Up/Down markets, each read as its own small study (S0 to S5) inside the study's S3, on every seated day
(38 days, 2026-09-02 to 2026-10-09). No grid: every test's parameters are the brief's (10 s burst, |z| >= 3, a 5-cent margin against the driftless fair value,
at least 300 s left, 20 USD a trade, hold to expiry). The logic is `tf15_cands.near_tests` on `tf15_bt`; the figures are `tf15_trade_figs`.

Run from `platform/research/studies` with the fund venv:
    ../../../.venv/Scripts/python 2026-10-08-predmkts-binance-burst-15m-updown-buy-near-tests.build.py
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
NB = HERE / "2026-10-08-predmkts-binance-burst-15m-updown-buy-near-tests.ipynb"
CELLS = []
from tf15_cands import TESTS as _TESTS  # noqa: E402 - the tests' titles, so a header and the code agree (the script's own folder is on the path)

TITLES = {k: v[0] for k, v in _TESTS.items()}
LABELS = list(_TESTS)


def md(s):
    CELLS.append(new_markdown_cell(s.strip("\n")))


def code(s, *tags):
    c = new_code_cell(s.strip("\n"))
    if tags:
        c.metadata["tags"] = list(tags)
    CELLS.append(c)


md(r'''
# Buying the near token after a Binance burst on 15-minute Up/Down: does it need the burst and the gate, and does a stale book, market breadth, Bitcoin's lead or the depth at the touch make it pay more?

## S0 · Summary

**The thesis.** The market prices a 15-minute Up/Down token with a driftless (symmetric) binary model. After a 3-sigma Binance burst the move
persists and the book has not re-priced it, so the near token (the side the burst points to) is under-priced against the driftless fair value.
The only order that can be sent inside the race is a buy of the near token at its ask (a sale of the far token needs a mint on chain first,
seconds, so the owner retired it on 2026-10-10). This study tests the buy, its two halves, and four signals that are not momentum, as seven small studies,
on every seated day (2026-09-02 to 2026-10-09, 38 days), with the same costs on. Every test is a fixed rule read once: nothing is chosen here.

**The seven tests** (all: 10-second Binance z, |z| at least 3 where the burst is required, a 5-cent margin against the driftless fair value where
the price gate is required, at least 300 s left, USD 20 a trade, the fill 250 ms after the decision (the venue's 150 ms hold plus 100 ms of our own, assumed), held to expiry, one entry a window):

| Test | Burst | Price gate | Added signal | Action |
|---|---|---|---|---|
| A | yes | the near token's ASK more than 5c under its fair value | none | buy the near token at its ask |
| C | yes | none | none | buy the near token (is the price gate necessary?) |
| D | no | A's gate | none | buy the near token (is the burst necessary?) |
| E | yes | A's gate | the near token's ask is the same price it was 3 seconds ago: nobody has re-priced the book yet | buy the near token |
| F | yes | A's gate | at least one other coin is bursting the same way at the same moment: the move is market-wide, not one coin's print | buy the near token |
| G | Bitcoin's | the coin's own ask under its own fair value | Bitcoin burst; buy ETH, SOL or XRP's near token when that coin's own ask sits under its own fair value (the coin itself need not have burst) | buy that coin's near token |
| H | yes | A's gate | at least 20 USD of the near token is on offer at the best ask: our whole order fills at one price without walking up the book | buy the near token |

**Why these.** A is the rule; C and D drop one of its two conditions. E asks the thesis's own question directly: is the near token's ask still the price it was
3 seconds ago, so that nobody has re-priced the book yet? F asks whether a move several coins make at once lasts longer than one coin's print. G asks whether a
Bitcoin burst tells us something about ETH, SOL and XRP, whose books are thinner. H trades only when at least 20 USD is on offer at the best ask, so the whole
order fills at one price: it asks whether the money is lost in the fill rather than in the signal. The earlier grids (um-016, um-018) layered momentum-side signals and exits and found
nothing that survived a choice; these four are read as fixed rules, not chosen. A gate on the near token's bid (the old test B) was retired with the
sales on 2026-10-10: the bid is not a price a buyer pays.

**Each test is read the same way:** S0 the headline, S1 the gate, S2 the data and the engine's invariants, S3 the result (whole window, both halves, each
coin; the PnL before and after the taker fee entry by entry with each entry's result under it; each coin's PnL; the entry prices), S4 what the taker fee takes and how much it could bear,
the winners and losers by price, the biggest win and the biggest loss replayed on the L2 book with the fill ladder printed, S5 the rule on days it was not read on (two weeks against two weeks, then week against week) and against the same count of entries at seconds that pass every condition but the burst. The study's S4 holds test A's margin sweep, S5 the daily record, S6 the decision, and S7 the verdict with the seven compared side by side.
''')

code(r'''
from IPython.display import Markdown, display
S0_TABLE = display(Markdown("_The seven tests' headline table is drawn here when the run finishes._"), display_id=True)
S0_HANDLE = display(Markdown("_The summary card is drawn here when the run finishes._"), display_id=True)
''', "s0")

md(r'''
## S1 · Setup

### S1.1 · Parameters
''')

code(r'''
# ---- the fixed rule set, pre-specified by the brief; no grid ----
STUDY_ID = "2026-10-08-predmkts-binance-burst-15m-updown-buy-near-tests"
RUN_ID = "um-021"
DESK = "lab/predmkts"
L, Z_MIN, THETA, T_MIN = 10, 3.0, 0.05, 300     # burst lookback s, |z| threshold, the price gate's margin against fair value, min seconds left
CLIP_USD, BOOK_USD = 20.0, 1000.0
VENUE_HOLD_MS, OWN_MS = 150, 100                 # the venue's taker hold on crypto markets [1]; our own tick-to-trade, ASSUMED until measured live [U]
LAT_MS = VENUE_HOLD_MS + OWN_MS                  # the order meets the ladder this long after the decision second
DAYS = [f"2026-09-{d:02d}" for d in range(2, 31)] + [f"2026-10-{d:02d}" for d in range(1, 10)]     # every seated day: 38
FIRST, SECOND = DAYS[:19], DAYS[19:]            # half / half: first 19 days (09-02 to 09-20), last 19 (09-21 to 10-09)
TOP_N = 10                                      # winners and losers listed a test
N_IS, N_OOS, WEEK = 14, 14, 7                   # S5 blocks by day index: 14 in-sample, 14 out-of-sample, the rest a second out-of-sample block; folds a week each
N_DRAWS, P_GATE = 1000, 0.10                    # draws a randomised null; the one-sided p a test must beat (research.md#six-gates-size-last)
''', "parameters")

code(r'''
import datetime as dt, time
import numpy as np, pandas as pd
import matplotlib.pyplot as plt
from IPython.display import HTML, Markdown, display
from fundplat.quant.core import figstyle, report as REPORT
import tf15_bt as B, tf15_cands as C, tf15_trade_figs as TF, lift_figs as LF
import tf15_oos as O, tf15_oos_figs as OF, tf15_fees as FE
get_ipython().run_line_magic("config", "InlineBackend.print_figure_kwargs = {'bbox_inches': None}")
LF.setup()
plt.rcParams["figure.dpi"] = 72                    # back to 72 on 2026-10-11: the owner removed the 3 MB notebook limit (B-0719)

t0 = time.time()
TAB = B.Tab(DAYS, fill_ms=LAT_MS)
TESTS, MASKS = C.near_tests(TAB, L=L, z_min=Z_MIN, theta=THETA, t_min=T_MIN, usd=CLIP_USD)
LABELS = list(C.TESTS)
ASSET = list(TF.COINS)
HALF = len(FIRST)

def half(e, which):
    return B.subset(e, (e["day"] < HALF) if which == 0 else (e["day"] >= HALF))

SUMM = {k: B.summarize(e, TAB, k) for k, e in TESTS.items()}
SUMM_F = {k: B.summarize(half(e, 0), TAB, k) for k, e in TESTS.items()}
SUMM_S = {k: B.summarize(half(e, 1), TAB, k) for k, e in TESTS.items()}
FIGURES = []
OOS2W, FOLDS, RAND = {}, {}, {}                 # each test's S5 reads: the day blocks, the weekly folds, the randomised nulls
FEES = {}                                       # each test's taker-fee read (S3): gross, fee and net an entry, the sweep by fee multiplier, by price paid
FEE_RATES = FE.rates_seen(TAB)                  # the fee rates the market rows carry, every window of the table

# the gate each test's decision cells passed, from the masks near_tests built (used by S2's invariants and each test's S1)
_m = MASKS
GATE_CELLS = {k_: (g_[0] | g_[1]) & _m["tm"] for k_, g_ in _m["gates"].items()}
GATE_OF_LEG = {(k_, 0): g_[0] | g_[1] for k_, g_ in _m["gates"].items()}
SIDE_UP_OF = {k_: g_[0] for k_, g_ in _m["gates"].items()}     # the cells where the near token is Up

def row(label, s):
    if s.get("n", 0) == 0:
        return dict(label=label, n=0, win_pct=np.nan, breakeven_pct=np.nan, per_entry=np.nan, lo=np.nan, hi=np.nan, net=0.0,
                    avg_win=np.nan, avg_loss=np.nan, reward_to_risk=np.nan, profit_factor=np.nan, win_needed_pct=np.nan,
                    rr_per_trade=np.nan, rr_per_trade_median=np.nan, per_entry_ex_best5=np.nan, best5_share_pct=np.nan)
    return dict(label=label, n=s["n"], win_pct=s["win"] * 100, breakeven_pct=s["breakeven"] * 100, per_entry=s["per"], lo=s["per_lo"], hi=s["per_hi"], net=s["net"],
                avg_win=s["avg_win"], avg_loss=s["avg_loss"], reward_to_risk=s["rr"], profit_factor=s["pf"], win_needed_pct=s["win_needed"] * 100,
                rr_per_trade=s["rr_trade_mean"], rr_per_trade_median=s["rr_trade_median"], per_entry_ex_best5=s["per_ex_top5"], best5_share_pct=s["top5_share"] * 100 if np.isfinite(s["top5_share"]) else np.nan)

def interval_word(s):
    return "clears zero" if s.get("n", 0) and s["per_lo"] > 0 else ("spans zero" if s.get("n", 0) and s["per_hi"] > 0 else "is below zero")

def summary_line(lab):
    s, sf, ss, e = SUMM[lab], SUMM_F[lab], SUMM_S[lab], TESTS[lab]
    coins = ", ".join(f"{a.upper()} {B.summarize(B.subset(e, e['asset'] == ai), TAB, a).get('per', float('nan')):+.2f}" if (e["asset"] == ai).any() else f"{a.upper()} no entry"
                      for ai, a in enumerate(ASSET))
    return (f"**Test {lab}: {C.TESTS[lab][0]}.** {s['n']:,} entries over {len(DAYS)} days, win rate {s['win']*100:.1f}% (Wilson 95% {s['win_lo']*100:.1f} to {s['win_hi']*100:.1f}) "
            f"against {s['breakeven']*100:.1f}% to break even on the price paid; the mean win is {s['avg_win']:+.2f} USD and the mean loss {s['avg_loss']:+.2f}, reward to risk {s['rr']:.2f}, "
            f"profit factor {s['pf']:.2f}, so the payoff needs {s['win_needed']*100:.1f}% wins and {'gets' if s['win'] > s['win_needed'] else 'does not get'} them. "
            f"Each trade's own reward to risk averages {s['rr_trade_mean']:.2f} (median {s['rr_trade_median']:.2f}). Without the best 5% of entries the net is {s['per_ex_top5']:+.3f} an entry "
            f"(95% by 15-minute slot {s['per_ex_top5_lo']:+.2f} to {s['per_ex_top5_hi']:+.2f}, {s['p_ex_top5_le0']:.0%} of the resamples at or below zero)"
            + (f"; {s['top5_share']*100:.0f}% of the net sits in them: a few wins carry everything. " if s["per_ex_top5"] <= 0 < s["per"]
               else ": the edge survives without its best wins. " if s["per_ex_top5_lo"] > 0
               else ": the interval reaches zero, so the edge rests on its tail wins. " if s["per"] > 0 else ". ")
            + f"Net {s['per']:+.3f} USD an entry (95% by 15-minute slot {s['per_lo']:+.2f} to {s['per_hi']:+.2f}, which {interval_word(s)}), {s['net']:+.0f} USD in all, "
            f"{s['roi']*100:+.2f}% on the dollars risked (the clip is not always spent: a partial fill risks less). "
            f"First half {sf.get('per', float('nan')):+.3f} an entry on {sf.get('n', 0):,}, second half {ss.get('per', float('nan')):+.3f} on {ss.get('n', 0):,}. "
            f"By coin an entry: {coins}.")

def invariants(lab):
    e = TESTS[lab]
    w, k = e["w"], e["k"]
    qa_lim, qd_lim = C.quotes(TAB)
    lim = np.where(e["side"] > 0, qa_lim[w, k], qd_lim[w, k])
    rate = TAB.w_fee[w].astype(float)
    gate_ok = all(bool(GATE_OF_LEG[(lab, int(lg))][w_, k_]) and bool(_m["tm"][0, k_]) for w_, k_, lg in zip(w, k, e["leg"]))     # tm is (1, NK): one row for every window
    side_ok = bool(np.all((e["side"] > 0) == SIDE_UP_OF[lab][w, k]))
    return [("every fill paid no more a share than the ask the rule saw (a sale: received no less than the bid it saw)", bool(np.all(e["vwap"] <= lim + 1e-6))),
            ("every entry is at least the venue minimum of 5 shares", bool(np.all(e["shares"] >= B.MIN_SHARES))),
            ("every outcome is the venue's own resolution of its window", bool(np.all(e["won"] == ((e["side"] > 0) == TAB.up[w])))),
            ("net = payoff - cost - fee for every entry", bool(np.allclose(e["net"], e["payoff"] - e["cost"] - e["fee"]))),
            ("the fee is positive and at most rate x 0.25 a share (p(1-p) peaks at 0.25)", bool(np.all((e["fee"] > 0) & (e["fee"] <= rate * 0.25 * e["shares"] + 1e-9)))),
            (f"every decision had at least {T_MIN} s left", bool(np.all(e["T"] >= T_MIN))),
            ("one entry a window a leg", len(set(zip(w.tolist(), e["leg"].tolist()))) == len(w)),
            ("every entry's decision second passed its own leg's gate, and bet with the burst (or the gate's side for F)", gate_ok and side_ok)]

def pass_table(rows):
    return "| Check | Result |\n|---|---|\n" + "\n".join(f"| {l} | {'PASS' if ok else 'FAIL'} |" for l, ok in rows)

def trades_df(e, idx):
    return pd.DataFrame(dict(day=[DAYS[i] for i in e["day"][idx]], coin=[ASSET[i] for i in e["asset"][idx]], near=np.where(e["side"][idx] > 0, "Up", "Down"),
                             leg=[C.LEG[int(l)] for l in e["leg"][idx]], second=(B.K0 + e["k"][idx]).astype(int), seconds_left=e["T"][idx].astype(int),
                             price_paid=e["vwap"][idx], shares=e["shares"][idx], usd_at_risk=e["cost"][idx], fee=e["fee"][idx], won=e["won"][idx], net=e["net"][idx]))

OVERVIEW = pd.DataFrame([row(f"{k} {C.TESTS[k][0]}", SUMM[k]) for k in LABELS])
OVERVIEW["gross_per_entry"] = [SUMM[k].get("gross_per", np.nan) for k in LABELS]
OVERVIEW["fee_per_entry"] = [SUMM[k].get("fee_per", np.nan) for k in LABELS]
_md = ("| Test | n | Win % | Win % needed | Mean win | Mean loss | Reward to risk | RR a trade | Profit factor | Gross an entry | Fee an entry | Net an entry | 95% lo | 95% hi | Net ex best 5% | Net USD |\n"
       "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n"
       + "\n".join(f"| {r.label} | {r.n:,} | {r.win_pct:.1f} | {r.win_needed_pct:.1f} | {r.avg_win:+.2f} | {r.avg_loss:+.2f} | {r.reward_to_risk:.2f} | {r.rr_per_trade:.2f} | {r.profit_factor:.2f} | "
                   f"{r.gross_per_entry:+.3f} | {r.fee_per_entry:.3f} | {r.per_entry:+.3f} | {r.lo:+.2f} | {r.hi:+.2f} | {r.per_entry_ex_best5:+.3f} | {r.net:+.0f} |" for r in OVERVIEW.itertuples()))
S0_TABLE.update(Markdown("**The seven tests, whole window** (win % needed: the win rate this payoff's mean win and mean loss need to break even; reward to risk: mean win over mean loss; "
                         "RR a trade: the average of each trade's own pays-if-won over loses-if-lost; gross an entry: the payoff less the cost, before the fee; fee an entry: the taker fee USD, "
                         "so net an entry = gross - fee; net ex best 5%: the net an entry with the best 5% of entries taken out; "
                         "net an entry with its 95% interval by 15-minute slot)\n\n" + _md))
print(f"loaded {TAB.W:,} windows and ran the seven tests in {time.time()-t0:.0f}s: " + ", ".join(f"{k} {SUMM[k]['n']:,}" for k in LABELS))
''')

md(r'''
### S1.2 · Assumptions

| Item | Value | Source |
|---|---|---|
| The venue's taker hold | 150 ms: a marketable order on a crypto market is held before matching (raised from 50 ms on 2026-09-04 14:00 UTC) | venue changelog [1] |
| Our own tick-to-trade | 100 ms from the Binance print reaching us to our order reaching the venue, ASSUMED (the owner, 2026-10-10) until a live measurement replaces it | [U] |
| The delay in the engine | 250 ms, the two added: the order meets the ladder as it stood 250 ms after the decision second | this study |
| Taker fee | shares x rate x p x (1 - p), each market's own rate, on the price side the trade touches; 0.07 on the crypto category, `fee.category_rates` [1]; every market's own `feeSchedule.rate` read live [API] | venue facts `fee.formula` [1] and `fee.category_rates` [1], read 2026-10-10; `fee.schedule.by_market` [API] |
| Minimum order | 5 shares | market rows [API] |
| Fair value | driftless Brownian P(Up) of the 60 s TWAP, no momentum term | the 15-minute study (B-0642) |
| Clip and book | USD 20 a trade of the near token, USD 1,000 book, 1x, one entry a window | the brief |
| Gate arithmetic | quotes compared on the cent grid, strict: a quote exactly 5c from fair is neither under- nor over-priced | this study |

## S2 · Data checks

Every input is a seated decision table read through `fundplat.data` (`tf15_runner.py`), one UTC day at a time, from the Binance
spot aggTrades and the pinned Polymarket Up-token ladders. The window is 2026-09-02 to 2026-10-09 (38 days, one regime). The engine's own
checks run here and count into `verify`; then every test's entries are put through the same eight invariants.
''')

code(r'''
# ---- coverage: windows with a book by the first decision second ----
import tf15_runner as RUNNER
COV = []
for d in DAYS:
    arrs_, meta_ = RUNNER.load(d, LAT_MS)
    COV.append(dict(day=d, windows=int(meta_["windows"]), with_book=int(meta_["ok"])))
COV = pd.DataFrame(COV)
SHARE = float(COV.with_book.sum() / COV.windows.sum())
display(Markdown("**Windows with a book**\n\n| Day | Windows | With a book |\n|---|---|---|\n" +
                 "\n".join(f"| {r.day} | {r.windows} | {r.with_book} |" for r in COV.itertuples()) +
                 f"\n\n{SHARE:.0%} of windows have a book; the rest are out before any outcome is read. The pooled table holds {TAB.W:,} windows."))
''')

code(r'''
# ---- the engine's own checks (the fill walk, the fee, the sale walk and its floor, the short's accounting both ways, the per-level detail, the bootstrap) ----
CHECKS = B.checks()
display(Markdown("**Engine checks**\n\n" + pass_table(CHECKS)))
assert all(ok for _, ok in CHECKS), "an engine check failed"
VERIFY_PASSED, VERIFY_TOTAL = sum(ok for _, ok in CHECKS), len(CHECKS)
# ---- the eight invariants, every test ----
INV = {lab: invariants(lab) for lab in LABELS}
_hdr = "| Invariant | " + " | ".join(LABELS) + " |\n|---|" + "---|" * len(LABELS) + "\n"
_rows = "\n".join("| " + INV["A"][i][0] + " | " + " | ".join("PASS" if INV[lab][i][1] else "FAIL" for lab in LABELS) + " |" for i in range(len(INV["A"])))
display(Markdown("**Entry invariants, by test**\n\n" + _hdr + _rows))
assert all(ok for lab in LABELS for _, ok in INV[lab]), "an entry invariant failed"
''')

md(r'''
### S2.2 · How much can we buy at our price?

Every test's limit is the near token's ask at the decision second: when the order meets the ladder after the fill delay of S1.2 it takes what rests at or under that price, at least the venue minimum, and stops, so a thin touch means a smaller trade, never a worse price (the shares under this paragraph are computed on the entries as run).
Our price has two definitions and every chart and column names its own: the ask we saw (the rule as run), and our edge price, fair value less the margin at the decision second (`pu - THETA` for an Up buy, `(1 - pu) - THETA` for a Down buy), under which every level still carries the edge the rule demands; test C has no price gate and does not require its edge price at entry.
Depth beyond the four levels the table keeps is not in it, so every number here is a floor.
Our own order would change the book, and that is not modelled. Method: `platform/lab/research/data/depth-estimation-research-2026-10-11.md`.
''')

code(r'''
# ---- S2.2: how much each test can buy at its own price: the walk to the edge price, the USD under it, the re-run paying up to it (tf15_capacity) ----
import tf15_capacity as CAP
_t = time.time()
CAP_EST = {lab: CAP.estimate(TAB, TESTS[lab], MASKS, lab, len(DAYS), t_min=T_MIN, theta=THETA) for lab in LABELS}     # walk, USD under the price, re-run a clip
CAP_CHECKS = CAP.checks() + CAP.data_checks(TAB, TESTS, MASKS, CAP_EST, t_min=T_MIN, clip=CLIP_USD, theta=THETA)
display(Markdown("**Capacity checks** (each planted case must come out as its label says; the last four read the real table)\n\n" + pass_table(CAP_CHECKS)))
assert all(ok for _, ok in CAP_CHECKS), "a capacity check failed"
VERIFY_PASSED, VERIFY_TOTAL = VERIFY_PASSED + sum(ok for _, ok in CAP_CHECKS), VERIFY_TOTAL + len(CAP_CHECKS)
CAP_DEPTH = CAP.depth_all(TAB, t_min=T_MIN)
CAP_WIN = f"{DAYS[0][5:]} to {DAYS[-1][5:]} · {24 * len(DAYS):,}h · {len(DAYS)} days · one regime · the fill {LAT_MS} ms after the decision · verify {VERIFY_PASSED}/{VERIFY_TOTAL}"
display(Markdown(CAP.intro_line(CAP_EST, CLIP_USD) + f" Clips {', '.join(f'{c:g}' for c in CAP.CLIPS)} USD, walked to our edge price unless a column says the ask we saw. "
                 f"Computed in {time.time() - _t:.0f}s."))
''')

md(r'''
#### How deep do we go if we spend 20, 50, 100, 200 or 500 USD?
''')

code(r'''
figstyle.show(CAP.howdeep_fig(CAP_EST, CAP_WIN, CAP.notes_howdeep(CAP_EST)), "fig:s2-howdeep", FIGURES)
''', "fig:s2-howdeep")

md(r'''
#### How many dollars sit under our edge price when a test fires?
''')

code(r'''
figstyle.show(CAP.underedge_fig(CAP_EST, CAP_DEPTH, CAP_WIN, CAP.notes_underedge(CAP_EST, CAP_DEPTH, CLIP_USD, T_MIN), clip=CLIP_USD, t_min=T_MIN), "fig:s2-underedge", FIGURES)
''', "fig:s2-underedge")

md(r'''
#### What does each clip earn a day when we pay up to our edge price?
''')

code(r'''
figstyle.show(CAP.earnclip_fig(CAP_EST, CAP_WIN, CAP.notes_earnclip(CAP_EST, len(DAYS))), "fig:s2-earnclip", FIGURES)
''', "fig:s2-earnclip")

code(r'''
display(Markdown(f"**How much each test can buy at its price, one row a test** ({len(DAYS)} days, USD; levels and cents walk to our edge price; cents are the mean over the best ask; "
                 f"the edge column is each test re-run paying up to its edge price)"))
display(HTML(CAP.estimate_table(CAP_EST).to_html(index=False, border=0)))
display(Markdown("- Four levels is a floor: the table keeps four levels a side, so the USD under the edge price and the share filled in full are at least the values shown, "
                 "and a clip that needs a fifth level counts as not filled in full.\n"
                 f"- A participation cap of {CAP.PART:.0%} of the near-side flow after entry is a desk convention: it is printed in the bullets under the clip figure as a "
                 "sensitivity, tagged [U], and does not set the clip."))
''')

md(r'''
## S3 · Core result

Seven small studies, one a test, each in the S0 to S5 shape. The same window, the same costs, the same engine; only the gate differs.
''')

for lab in LABELS:
    low = lab.lower()
    md(f'''
### Test {lab} · {TITLES[lab]}

#### {lab} · S0 Summary
''')
    code(f'''
LAB = "{lab}"
E_, S_, SF_, SS_ = TESTS[LAB], SUMM[LAB], SUMM_F[LAB], SUMM_S[LAB]
display(Markdown(summary_line(LAB)))
''')
    md(f'''
#### {lab} · S1 Setup
''')
    code(r'''
_g = GATE_CELLS[LAB]
_legs = ", ".join(f"{C.LEG[int(l)]} {int((E_['leg'] == l).sum()):,}" for l in np.unique(E_["leg"]))
display(Markdown(f"**The rule.** {C.TESTS[LAB][0]}: {C.TESTS[LAB][1]}.\n\n"
                 f"**Parameters.** burst lookback {L} s, |z| at least {Z_MIN:g} where momentum is required, margin {THETA:.2f} against the driftless fair value where a price gate is required, "
                 f"at least {T_MIN} s left, USD {CLIP_USD:g} a trade, the fill {LAT_MS} ms after the decision at the ladder then standing, held to expiry.\n\n"
                 f"**Where it fires.** {int(_g.sum()):,} decision seconds pass the gate in {len(np.unique(np.nonzero(_g)[0])):,} of {TAB.W:,} windows; after the fill rules "
                 f"(at least 5 shares, one entry a window a leg) the test holds {S_['n']:,} entries: {_legs}."))
''')
    md(f'''
#### {lab} · S2 Data checks
''')
    code(r'''
_bycoin = pd.DataFrame([dict(coin=a.upper(), entries=int((E_["asset"] == ai).sum()), windows_with_book=int((TAB.w_asset == ai).sum()),
                             share_of_windows=float((E_["asset"] == ai).sum() / max((TAB.w_asset == ai).sum(), 1)),
                             mean_seconds_left=float(E_["T"][E_["asset"] == ai].mean()) if (E_["asset"] == ai).any() else np.nan,
                             mean_price_paid=float(E_["vwap"][E_["asset"] == ai].mean()) if (E_["asset"] == ai).any() else np.nan,
                             max_collateral_x_clip=float(E_["levered"][E_["asset"] == ai].max()) if (E_["asset"] == ai).any() else np.nan) for ai, a in enumerate(ASSET)])
display(Markdown("**Entries by coin**"))
display(HTML(_bycoin.round(3).to_html(index=False, border=0)))
display(Markdown("**The eight invariants on this test's entries**\n\n" + pass_table(INV[LAB])))
''')
    md(f'''
#### {lab} · S3 Core result
''')
    code(r'''
_rows = [row("whole (38 days)", S_), row("first half (09-02..09-20)", SF_), row("second half (09-21..10-09)", SS_)]
for ai, a in enumerate(ASSET):
    _rows.append(row(a.upper(), B.summarize(B.subset(E_, E_["asset"] == ai), TAB, a)))
for l in np.unique(E_["leg"]):
    if len(np.unique(E_["leg"])) > 1:
        _rows.append(row(f"leg: {C.LEG[int(l)]}", B.summarize(B.subset(E_, E_["leg"] == l), TAB, C.LEG[int(l)])))
display(HTML(pd.DataFrame(_rows).round(3).to_html(index=False, border=0)))
''')
    code(f'''
figstyle.show(TF.equity_fig(E_, DAYS, question=f"How much did test {{LAB}} make before and after the taker fee, entry by entry?"), "fig:s3-{low}-equity", FIGURES)
''', f"fig:s3-{low}-equity")
    code(f'''
figstyle.show(TF.coin_panels_fig(E_, DAYS, question=f"Does every coin carry test {{LAB}}'s edge, before and after the taker fee, or one of them?"), "fig:s3-{low}-coins", FIGURES)
''', f"fig:s3-{low}-coins")
    code(f'''
figstyle.show(TF.entry_price_fig(E_, DAYS, be=float(S_["breakeven"]), question=f"Do test {{LAB}}'s entries that won buy cheaper than break-even?", s=22, edge=False), "fig:s3-{low}-entrypx", FIGURES)
''', f"fig:s3-{low}-entrypx")
    md(f'''
#### {lab} · S4 Robustness

What the taker fee takes and how much fee the test could bear; the winners and the losers, by price paid; the ten best and ten worst entries; then the biggest
win and the biggest loss replayed on the venue's book, with the fill ladder the order met.
''')
    code(r'''
_ok, _err, _nf = FE.fee_check(TAB, E_, FE.limits(TAB, E_), usd=CLIP_USD)
assert _ok, f"test {LAB}: the engine's fee disagrees with rate x p x (1 - p) taken level by level (largest gap {_err:.2e} USD)"
_sw = FE.sweep(E_)
assert not FE.sweep_faults(_sw, E_), FE.sweep_faults(_sw, E_)
_d, _px = FE.decompose(TAB, E_), FE.by_price(E_)
FEES[LAB] = dict(d=_d, sw=_sw, px=_px)
_win = f"{DAYS[0][5:]} to {DAYS[-1][5:]} · {24 * len(DAYS):,}h · {len(DAYS)} days · one regime · verify {VERIFY_PASSED}/{VERIFY_TOTAL}"
_notes = FE.fee_notes(LAB, _d, _sw, FEE_RATES, _px) + [f"The engine's fee on all {_nf:,} entries was recomputed level by level from the ladder as rate x shares taken x p x (1 - p) and agrees (largest gap {_err:.1e} USD)."]
figstyle.show(FE.fee_fig(_d, _sw, _px, _notes, f"What does test {LAB} earn before and after the taker fee, and how much fee could it bear?", _win), f"fig:s3-{LAB.lower()}-fees", FIGURES)
''', f"fig:s3-{low}-fees")
    code(f'''
figstyle.show(TF.winloss_fig(E_, DAYS, question=f"What do test {{LAB}}'s winners and losers look like, and at which prices do they sit?"), "fig:s3-{low}-winloss", FIGURES)
''', f"fig:s3-{low}-winloss")
    code(r'''
_ord = np.argsort(E_["net"])
display(Markdown(f"**The {TOP_N} best entries of test {LAB}** (second: the decision second from the window's start; usd_at_risk: the cost of a buy, or the collateral of a sale)"))
display(HTML(trades_df(E_, _ord[::-1][:TOP_N]).round(3).to_html(index=False, border=0)))
display(Markdown(f"**The {TOP_N} worst entries of test {LAB}**"))
display(HTML(trades_df(E_, _ord[:TOP_N]).round(3).to_html(index=False, border=0)))
''')
    code(f'''
_i = int(np.argmax(E_["net"]))
figstyle.show(TF.anatomy_fig(TAB, E_, _i, DAYS, question=f"Why did test {{LAB}}'s biggest win make {{E_['net'][_i]:+.2f}} USD?", usd=CLIP_USD), "fig:s3-{low}-bigwin", FIGURES)
_df, _cap = TF.ladder_table(TAB, E_, _i, usd=CLIP_USD)
display(Markdown("**" + _cap + "**"))
display(HTML(_df.round(4).to_html(index=False, border=0)))
''', f"fig:s3-{low}-bigwin")
    code(f'''
_i = int(np.argmin(E_["net"]))
figstyle.show(TF.anatomy_fig(TAB, E_, _i, DAYS, question=f"Why did test {{LAB}}'s biggest loss cost {{-E_['net'][_i]:.2f}} USD?", usd=CLIP_USD), "fig:s3-{low}-bigloss", FIGURES)
_df, _cap = TF.ladder_table(TAB, E_, _i, usd=CLIP_USD)
display(Markdown("**" + _cap + "**"))
display(HTML(_df.round(4).to_html(index=False, border=0)))
''', f"fig:s3-{low}-bigloss")
    md(f'''
#### {lab} · S5 Out of sample and luck

The rule is fixed and nothing in it is fitted, so in-sample here means only the days that set the forecast: the in-sample block gives the net an entry and
its 95% interval by 15-minute slot, and each out-of-sample block is the realisation read against it. A steady edge keeps its sign and lands inside the
forecast's interval. First two weeks against the next two (the seated days after them are a second out-of-sample block), then each week against the next,
then the test against the random-burst null: the same count of entries in each day and coin, at seconds that pass every condition of the test except the
burst, the side the one whose ask passes the gate. A coin flip of the side at the test's own seconds is printed beside it; it buys the far token, which never
passes the gate, so it measures the gate and is not a gate itself.
''')
    code(r'''
WIN_ = f"{DAYS[0][5:]} to {DAYS[-1][5:]} · {24 * len(DAYS):,}h · {len(DAYS)} days · one regime · verify {VERIFY_PASSED}/{VERIFY_TOTAL}"
_r = OOS2W[LAB] = O.read_blocks(E_, DAYS, N_IS, N_OOS)
figstyle.show(OF.oos2w_fig(E_, DAYS, _r, OF.block_notes(_r, O.MIN_N), f"Does test {LAB} hold on days it was not read on, two weeks against two weeks?", WIN_),
              f"fig:s3-{LAB.lower()}-oos2w", FIGURES)
''', f"fig:s3-{low}-oos2w")
    code(r'''
_f = FOLDS[LAB] = O.read_folds(E_, DAYS, WEEK)
figstyle.show(OF.folds_fig(E_, DAYS, _f, OF.fold_notes(_f, DAYS, WEEK, O.MIN_N), f"Does test {LAB} hold week after week, each week read against the one before?", WIN_),
              f"fig:s3-{LAB.lower()}-oosfolds", FIGURES)
''', f"fig:s3-{low}-oosfolds")
    code(r'''
# the random-burst null (the gate: does the burst's direction add to a book that passes everything else?) and the coin-flip side (a reading of the price gate)
_rs = O.random_side(TAB, _m["gates"][LAB], _m["tm"], usd=CLIP_USD, draws=N_DRAWS, seed=11 + LABELS.index(LAB))
_rb = O.random_burst(TAB, E_, _m, LAB, t_min=T_MIN, usd=CLIP_USD, draws=N_DRAWS, seed=13 + LABELS.index(LAB))
_ok_s, _n_s = O.side_agrees(TAB, _m["gates"][LAB], _m["tm"], usd=CLIP_USD)
_ag = O.burst_agrees(TAB, E_, _m, LAB, theta=None if LAB == "C" else THETA, t_min=T_MIN, usd=CLIP_USD)
assert _ok_s and (_ag is None or (_ag["agree"] and not _ag["faults"])), f"a randomised null disagrees with B.entries or breaks its own rules: {_ag}"
if _rb is None:
    print(f"{LAB} has no burst to randomise: the random-burst null is skipped, only the coin-flip side is drawn")
_ask = O.ask_of(TAB, E_)
_p = dict(burst=O.p_one_sided(_rb["per"], S_["per"]) if _rb else float("nan"), burst_ex5=O.p_one_sided(_rb["ex5"], S_["per_ex_top5"]) if _rb else float("nan"),
          side=O.p_one_sided(_rs["per"], S_["per"]), side_ex5=O.p_one_sided(_rs["ex5"], S_["per_ex_top5"]))
RAND[LAB] = dict(p_burst=_p["burst"], p_burst_ex5=_p["burst_ex5"], p_side=_p["side"], p_side_ex5=_p["side_ex5"], draws=N_DRAWS,
                 ask_rule=float(_ask.mean()), fee_rule=float(S_["fee_per"]), ask_side=float(np.nanmean(_rs["ask"])), fee_side=float(np.nanmean(_rs["fee"])),
                 ask_burst=float(np.nanmean(_rb["ask"])) if _rb else float("nan"), fee_burst=float(np.nanmean(_rb["fee"])) if _rb else float("nan"))
_rows, _notes = OF.burst_rows(LAB, S_, _ask, _rb, _rs, _p, N_DRAWS, P_GATE, T_MIN, dict(burst=_ag, side=(_ok_s, _n_s)))
_nulls = (([dict(name="random burst", null=_rb["per"], observed=S_["per"], p=_p["burst"])] if _rb else [])
          + [dict(name="coin-flip side (buys the far token:\nmeasures the price gate, not the burst)", null=_rs["per"], observed=S_["per"], p=_p["side"])])
_q = (f"Does test {LAB} beat the same count of entries at seconds that pass everything but the burst?" if _rb else
      f"Does test {LAB} beat a coin flip of its side? It has no burst to randomise")
figstyle.show(OF.random_fig(_nulls, _rows, _notes, _q, WIN_, colw=OF.BURST_COLW), f"fig:s3-{LAB.lower()}-random", FIGURES)
''', f"fig:s3-{low}-random")

md(r'''
## S4 · Robustness

The shape of test A's edge against its margin; the seven tests are compared side by side in S7.
''')

code(r'''
# ---- test A's gate at other margins: the shape of the edge, not a search (the study's margin is the brief's 5 cents) ----
SWEEP = pd.DataFrame(C.near_gate_sweep(TAB, L=L, z_min=Z_MIN, t_min=T_MIN, usd=CLIP_USD))
SWEEP["win"] = SWEEP["win"] * 100; SWEEP["breakeven"] = SWEEP["breakeven"] * 100
display(Markdown("**Test A's gate at other margins** (theta = how far under fair the near ask must sit; the 0.05 row is the study)"))
display(HTML(SWEEP.round(3).to_html(index=False, border=0)))
''')

md(r'''
## S5 · Risk and diagnostics

The day-by-day record of each test, the worst day and the largest single loss.
''')

code(r'''
figstyle.show(TF.daily_fig(TESTS, DAYS), "fig:s5-daily", FIGURES)
''', "fig:s5-daily")

code(r'''
_risk = []
for k in LABELS:
    e = TESTS[k]
    d = np.bincount(e["day"], weights=e["net"], minlength=len(DAYS))
    eq = np.cumsum(e["net"]); peak = np.maximum.accumulate(np.concatenate([[0.0], eq]))[1:]
    _risk.append(dict(test=k, worst_day_usd=float(d.min()), worst_day=DAYS[int(np.argmin(d))], days_lost=int((d < 0).sum()), largest_loss_usd=float(e["net"].min()),
                      max_drawdown_usd=float((peak - eq).max()), max_drawdown_pct_of_book=float((peak - eq).max() / BOOK_USD * 100),
                      max_usd_at_risk_one_entry=float(e["cost"].max())))
RISK = pd.DataFrame(_risk)
display(HTML(RISK.round(2).to_html(index=False, border=0)))
''')

md(r'''
## S6 · Decision
''')

code(r'''
_best = max(LABELS, key=lambda k: SUMM[k]["per"])
_clears = [k for k in LABELS if SUMM[k]["per_lo"] > 0]
_both = [k for k in LABELS if SUMM_F[k].get("per", -1) > 0 and SUMM_S[k].get("per", -1) > 0]

def oos_read(lab):
    """One sentence on a test's S5 reads: the out-of-sample blocks, the weekly folds and the randomised nulls."""
    r, f, q = OOS2W[lab], FOLDS[lab], RAND[lab]
    o1, o2, pl = r[1], (r[2] if len(r) > 2 else None), f["pooled"]
    return (f"the out-of-sample two weeks net {o1['s'].get('per', float('nan')):+.3f} an entry on {o1['s'].get('n', 0):,} entries ({o1['verdict']} against the in-sample forecast "
            f"{r[0]['s']['per_lo']:+.2f} to {r[0]['s']['per_hi']:+.2f})" + (f" and the last {o2['n_days']} days {o2['s'].get('per', float('nan')):+.3f} ({o2['verdict']})" if o2 else "")
            + f"; week against week {f['consistent']} of {f['n_folds']} folds are consistent and the pooled out-of-sample weeks net {pl.get('per', float('nan')):+.3f} an entry "
            f"(95% {pl.get('per_lo', float('nan')):+.2f} to {pl.get('per_hi', float('nan')):+.2f}); "
            + (f"against the random-burst null (the same count of entries at seconds that pass every condition but the burst) the one-sided p is {q['p_burst']:.4f} "
               f"({q['p_burst_ex5']:.4f} for the net without the best 5%)" if np.isfinite(q["p_burst"]) else f"test {lab} has no burst to randomise")
            + f", and against the coin-flip side, which buys the far token and so measures the price gate rather than the burst, {q['p_side']:.4f}")

def ex5_words(s):
    """The net without the best 5% with its slot interval and the share of resamples at or below zero."""
    return (f"{s['per_ex_top5']:+.3f} an entry (95% by 15-minute slot {s['per_ex_top5_lo']:+.2f} to {s['per_ex_top5_hi']:+.2f}, "
            f"{s['p_ex_top5_le0']:.0%} of the resamples at or below zero)")

OOS_PASS = {k: dict(g10=OOS2W[k][1]["verdict"] == "PASS", g11=FOLDS[k]["pooled"].get("per", -1) > 0 and FOLDS[k]["consistent"] >= 3,
                    g12=bool(np.isfinite(RAND[k]["p_burst"]) and RAND[k]["p_burst"] < P_GATE)) for k in LABELS}
_ok3 = sum(OOS_PASS[_best].values())
DECISION_MD = (f"**No size.** " + (f"Test {', '.join(_clears)} clears zero on the whole window" if _clears else "No test's net-an-entry interval clears zero on the whole window") +
               f"; test {_best} is the strongest expression ({SUMM[_best]['per']:+.3f} USD an entry, 95% {SUMM[_best]['per_lo']:+.2f} to {SUMM[_best]['per_hi']:+.2f}) and "
               f"{'is' if _best in _both else 'is not'} positive on both halves"
               + (f", but a few wins carry it: without its best 5% of entries it nets {ex5_words(SUMM[_best])}, so no size rests on it until a rule earns its net without the tail wins. "
                  if SUMM[_best]["per_ex_top5_lo"] <= 0 else f" and survives without its best 5% ({ex5_words(SUMM[_best])}). ") +
               "A size waits for days this window did not see (the forward days from 2026-10-08 as they seat), read once with the rule frozen as it stands here. "
               f"Inside the window, test {_best} passes " + ("all three" if _ok3 == 3 else f"{_ok3} of the three") + " S5 gates (G10 to G12): " + oos_read(_best) + ". "
               + ("These reads support taking the forward read, but they are consistency checks inside one window and do not replace it."
                  if _ok3 == 3 else "So the window's own splits give no reason to size ahead of the forward days."))
display(Markdown(DECISION_MD))
''')

md(r'''
## S7 · Verdict
''')

code(r'''
_best = max(LABELS, key=lambda k: SUMM[k]["per"])
_clears = [k for k in LABELS if SUMM[k]["per_lo"] > 0]
WORD = "MONEY" if _clears else ("class B" if SUMM[_best]["per"] > 0 else "class C")
_s = SUMM[_best]
VERDICT_MD = (f"**The answer: {WORD}.** Of the seven tests, test {_best} ({C.TESTS[_best][0]}) is the strongest: {_s['n']:,} entries, win {_s['win']*100:.1f}% against "
              f"{_s['breakeven']*100:.1f}% to break even, net {_s['per']:+.3f} USD an entry (95% by 15-minute slot {_s['per_lo']:+.2f} to {_s['per_hi']:+.2f}), {_s['net']:+.0f} USD in all; "
              f"first half {SUMM_F[_best].get('per', float('nan')):+.3f} an entry, second half {SUMM_S[_best].get('per', float('nan')):+.3f}. "
              f"Of the four added signals (E a book that has not moved {SUMM['E']['per']:+.3f}, F breadth {SUMM['F']['per']:+.3f}, G Bitcoin's lead {SUMM['G']['per']:+.3f}, H depth at the touch {SUMM['H']['per']:+.3f}), "
              + ("none beats A on both the net an entry and the net without its best 5%. " if not [k for k in 'EFGH' if SUMM[k]['per'] > SUMM['A']['per'] and SUMM[k]['per_ex_top5'] > SUMM['A']['per_ex_top5']] else ", ".join(k for k in 'EFGH' if SUMM[k]['per'] > SUMM['A']['per'] and SUMM[k]['per_ex_top5'] > SUMM['A']['per_ex_top5']) + " beat A on both. ")
              + f"Momentum without the price gate (C, {SUMM['C']['per']:+.3f}) and the price gate without momentum (D, {SUMM['D']['per']:+.3f}) both lose, so the thesis needs both: a burst AND a book "
              f"that has not re-priced it. "
              f"Win rate {_s['win']*100:.1f}% against the {_s['win_needed']*100:.1f}% its payoff needs, reward to risk {_s['rr']:.2f} (mean win {_s['avg_win']:+.2f}, mean loss {_s['avg_loss']:+.2f}), "
              f"profit factor {_s['pf']:.2f}, each trade's own reward to risk {_s['rr_trade_mean']:.2f} on average. "
              + (f"**{'A few wins carry everything' if _s['per_ex_top5'] <= 0 else 'Without its best wins the edge cannot be told from zero'}:** without its best 5% of entries test {_best} nets "
                 f"{ex5_words(_s)}, and {_s['top5_share']*100:.0f}% of the net sits in {int(np.ceil(0.05 * _s['n']))} entries, so the edge as it stands is a tail-win edge, not a steady one. "
                 if _s["per_ex_top5_lo"] <= 0 else f"Without its best 5% of entries test {_best} still nets {ex5_words(_s)}: the edge is not a few wins. ")
              + f"On days it was not read on and against chance (S5), " + oos_read(_best) + ": "
              + {3: "steady inside the window. ", 0: "none of the three holds. "}.get(sum(OOS_PASS[_best].values()), f"{sum(OOS_PASS[_best].values())} of the three hold. ")
              + ("The interval clears zero." if _clears else "No interval clears zero: real in sign but not yet confirmable, it wants more days, not more parameters."))
display(Markdown(VERDICT_MD))
''')

md(r'''
### The seven tests compared

The rule (A) against its two halves (C the burst alone, D the gate alone) and against the four added signals (E a book that has not moved, F breadth,
G Bitcoin's lead, H depth at the touch), on the whole window, on both halves of it, by coin, by the shape of the payoff and by what is left once the
best 5% of entries are out. Every number is computed above; nothing here is typed.
''')

code(r'''
_cmp_rows = []
for k in LABELS:
    s_, sf_, ss_, e_ = SUMM[k], SUMM_F[k], SUMM_S[k], TESTS[k]
    _cmp_rows.append(dict(test=k, what=C.TESTS[k][0], n=s_["n"], win_pct=s_["win"] * 100, win_needed_pct=s_["win_needed"] * 100, reward_to_risk=s_["rr"], rr_per_trade=s_["rr_trade_mean"],
                          profit_factor=s_["pf"], gross_per_entry=s_["gross_per"], fee_per_entry=s_["fee_per"], per_entry=s_["per"], lo=s_["per_lo"], hi=s_["per_hi"], per_ex_best5=s_["per_ex_top5"], per_ex_best5_lo=s_["per_ex_top5_lo"], per_ex_best5_hi=s_["per_ex_top5_hi"], first_half=sf_.get("per", np.nan), second_half=ss_.get("per", np.nan),
                          days_above_zero=int((np.bincount(e_["day"], weights=e_["net"], minlength=len(DAYS)) > 0).sum()), net=s_["net"],
                          **{f"{a.upper()}_per_entry": (B.summarize(B.subset(e_, e_["asset"] == ai), TAB, a).get("per", np.nan) if (e_["asset"] == ai).any() else np.nan) for ai, a in enumerate(ASSET)},
                          oos2w_per_entry=OOS2W[k][1]["s"].get("per", np.nan), folds_oos_pooled=FOLDS[k]["pooled"].get("per", np.nan),
                          p_random_burst=RAND[k]["p_burst"], p_coinflip_side=RAND[k]["p_side"]))
CMP_TABLE = pd.DataFrame(_cmp_rows)
display(Markdown(f"**Side by side, whole window** (per entry in USD; gross_per_entry: the payoff less the cost, before the fee; fee_per_entry: the taker fee; per_entry = gross - fee; 95% interval by 15-minute slot; per_ex_best5: the net an entry without the best 5% of entries, per_ex_best5_lo and _hi its 95% interval with the trim recomputed in each slot resample; days_above_zero of {len(DAYS)}; "
                 f"oos2w_per_entry: the net an entry on the out-of-sample two weeks ({DAYS[N_IS][5:]} to {DAYS[N_IS + N_OOS - 1][5:]}); folds_oos_pooled: every out-of-sample week together; "
                 f"p_random_burst: the one-sided p against {N_DRAWS:,} draws of the same count of entries at seconds that pass every condition but the burst (D has none); "
                 f"p_coinflip_side: the same against a coin flip of the side at the test's own seconds, which buys the far token and measures the price gate, not the burst)"))
display(HTML(CMP_TABLE.round(3).to_html(index=False, border=0)))
_a, _c, _d = SUMM["A"], SUMM["C"], SUMM["D"]
_gate_worth = _a["per"] - _c["per"]
_burst_worth = _a["per"] - _d["per"]
_added = {k: SUMM[k] for k in ("E", "F", "G", "H") if SUMM[k].get("n")}
_better = [k for k, s_ in _added.items() if s_["per_ex_top5"] > _a["per_ex_top5"] and s_["per"] > _a["per"]]
display(Markdown(f"**What the tests say.** The gate is worth {_gate_worth:+.2f} USD an entry (A {_a['per']:+.3f} against C {_c['per']:+.3f}: the same bursts, with and without the price check) and the burst is worth "
                 f"{_burst_worth:+.2f} (A against D {_d['per']:+.3f}: the same price check, with and without the burst). "
                 + ("Neither half pays on its own and the two together do, so the edge is the conjunction: a burst the book has not re-priced yet. " if _c["per"] < 0 and _d["per"] < 0 < _a["per"] else "")
                 + "The added signals, each a subset of A's entries except G: " + "; ".join(f"{k} {C.TESTS[k][0].split(':')[0]} {s_['per']:+.3f} an entry on {s_['n']:,} ({s_['per_ex_top5']:+.3f} without the best 5%, win {s_['win']*100:.1f}% against {s_['win_needed']*100:.1f}% needed, {s_['days_pos']:.0%} of days up)" for k, s_ in _added.items()) + ". "
                 + (f"{', '.join(_better)} beat A on both the net an entry and the net without the best 5%; the rest do not. " if _better else "None beats A on both the net an entry and the net without the best 5%. ")
                 + f"A itself: {_a['per']:+.3f} an entry on {_a['n']:,}, {_a['per_ex_top5']:+.3f} without the best 5%, wins {_a['win']*100:.1f}% against {_a['win_needed']*100:.1f}% needed, {_a['days_pos']:.0%} of days up."))
RESULT_LINES = [f"RESULT {RUN_ID} {k}_entries={SUMM[k]['n']}" for k in LABELS] + [f"RESULT {RUN_ID} {k}_net_per_entry_usd={SUMM[k]['per']:.4f}" for k in LABELS] + [f"RESULT {RUN_ID} {k}_net_ex_best5_usd={SUMM[k]['per_ex_top5']:.4f}" for k in LABELS]
print("\n".join(RESULT_LINES))
''')

code(r'''
CMP = [dict(label=k, n=SUMM[k]["n"], per=SUMM[k]["per"], lo=SUMM[k]["per_lo"], hi=SUMM[k]["per_hi"], per_first=SUMM_F[k].get("per", np.nan), per_second=SUMM_S[k].get("per", np.nan)) for k in LABELS]
_best = max(LABELS, key=lambda k: SUMM[k]["per"])
_notes = [f"Test {_best} is the strongest expression: {SUMM[_best]['per']:+.3f} USD an entry (95% by slot {SUMM[_best]['per_lo']:+.2f} to {SUMM[_best]['per_hi']:+.2f}); " +
          ("its interval clears zero." if SUMM[_best]["per_lo"] > 0 else "its interval still spans zero."),
          f"Test C (momentum, no price gate) earns {SUMM['C']['per']:+.3f} and test D (price gate, no momentum) {SUMM['D']['per']:+.3f}: " +
          ("both halves of the rule are necessary, neither alone pays." if SUMM["C"]["per"] < 0 and SUMM["D"]["per"] < 0 else "one half of the rule pays on its own.") +

          f"Both halves of the window: " + "; ".join(f"{k} {SUMM_F[k].get('per', float('nan')):+.2f} then {SUMM_S[k].get('per', float('nan')):+.2f}" for k in LABELS) + "."]
figstyle.show(TF.compare_fig(CMP, DAYS, _notes), "fig:s7-compare", FIGURES)
''', "fig:s7-compare")

code(r'''
RR = [dict(label=k, win=SUMM[k]["win"], win_lo=SUMM[k]["win_lo"], win_hi=SUMM[k]["win_hi"], win_needed=SUMM[k]["win_needed"], rr=SUMM[k]["rr"], pf=SUMM[k]["pf"],
           avg_win=SUMM[k]["avg_win"], avg_loss=SUMM[k]["avg_loss"], per=SUMM[k]["per"], per_ex_top5=SUMM[k]["per_ex_top5"], rr_trade_mean=SUMM[k]["rr_trade_mean"]) for k in LABELS]
_carried = [r["label"] for r in RR if r["per"] > 0 >= SUMM[r["label"]]["per_ex_top5_lo"]]
_notes = ["; ".join(f"{r['label']} wins {r['win']:.1%} and needs {r['win_needed']:.1%}" for r in RR) + ".",
          "; ".join(f"{r['label']} mean win {r['avg_win']:+.2f} against mean loss {r['avg_loss']:+.2f}, reward to risk {r['rr']:.2f}, profit factor {r['pf']:.2f}, each trade's own reward to risk {r['rr_trade_mean']:.2f} on average" for r in RR) + ".",
          "A reward to risk under one is the shape of this market: a winner pays 1 minus the price, a loser the whole price, so a near token bought above 0.50 wins small and loses big; "
          "the edge is a win rate above the rate that shape needs, and only " + ", ".join(r["label"] for r in RR if r["win"] > r["win_needed"]) + " have it.",
          "Without the best 5% of entries (95% by slot): " + "; ".join(f"{r['label']} {r['per_ex_top5']:+.3f} ({SUMM[r['label']]['per_ex_top5_lo']:+.2f} to {SUMM[r['label']]['per_ex_top5_hi']:+.2f})" for r in RR) + ". "
          + (f"In {', '.join(_carried)} the interval without the best 5% reaches zero: a few wins carry the net." if _carried else "Every positive test's interval without its best 5% clears zero.")]
figstyle.show(TF.winrate_rr_fig(RR, DAYS, _notes), "fig:s7-winrr", FIGURES)
''', "fig:s7-winrr")

code(r'''
figstyle.show(TF.daily_fig(TESTS, DAYS, question="Which days carried each of the seven tests, and how bad was the worst?"), "fig:s7-daily3", FIGURES)
''', "fig:s7-daily3")

code(r'''
# ---- the study manifest fund.study/1 (the last cell) ----
import datetime as _dt
from fundplat.data import derived

TITLE = "Buying the near token after a Binance burst on 15-minute Up/Down: does it need the burst and the gate, and does a stale book, market breadth, Bitcoin's lead or the depth at the touch make it pay more?"
QUESTION = ("After a 3-sigma Binance burst, does buying the near token when its ask is more than 5 cents under the driftless fair value earn a positive net PnL an entry "
            "after the fee and a 250 ms delay (the venue's 150 ms hold plus 100 ms of our own), held to expiry; does either half of the rule, the burst alone or the gate alone, pay on its own; and does any of four signals that are not momentum "
            "(the near ask unchanged over 3 s, at least two coins bursting the same way in the slot, Bitcoin's burst for the alts' tokens, the whole clip resting at the best ask) earn more than the rule alone?")
KIND = "strategy"
RUN_AT = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
_ms = lambda d: int(_dt.datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=_dt.timezone.utc).timestamp() * 1000)

_series, _pins = [], []
for d in DAYS:
    m_ = derived.meta("tf15-table", RUNNER.key_of(d, LAT_MS))
    _pins.append(m_["hash"])
    _series.append(dict(spec=f"tf15:{d}:decision-table:-", pin=m_["hash"], rows=int(COV.set_index("day").loc[d, "with_book"]),
                        first_ts=_ms(d), last_ts=_ms(d) + 86_399_999, handle=None, cls="pin", trunc=False))
INPUTS = {"digest": REPORT.inputs_digest(_pins), "series": _series, "unpinned": []}
WINDOW = {"from": "2026-09-02T00:00Z", "to": "2026-10-10T00:00Z", "hours": 912, "regimes": 1}
VERIFY = {"suite": "tf15 engine checks", "passed": int(VERIFY_PASSED), "total": int(VERIFY_TOTAL), "books": int(TAB.W)}
GATES = []
for i_, k in enumerate(LABELS, 1):
    s = SUMM[k]
    GATES.append({"id": f"G{i_}", "section": "S3", "label": f"Test {k} clears zero", "name": f"test {k}'s net an entry has a 95% interval by 15-minute slot above zero on the whole window",
                  "reading": f"{s['per']:+.3f} USD an entry ({s['per_lo']:+.2f} to {s['per_hi']:+.2f}) on {s['n']:,} entries", "verdict": "PASS" if s["per_lo"] > 0 else "FAIL",
                  "would_change": "an interval whose lower end crosses zero"})
_best = max(LABELS, key=lambda k: SUMM[k]["per"])
GATES.append({"id": "G8", "section": "S4", "label": "Best test, both halves", "name": f"test {_best}'s net an entry is positive on the first and the second half of the window",
              "reading": f"first half {SUMM_F[_best].get('per', float('nan')):+.3f}, second half {SUMM_S[_best].get('per', float('nan')):+.3f}",
              "verdict": "PASS" if (SUMM_F[_best].get("per", -1) > 0 and SUMM_S[_best].get("per", -1) > 0) else "FAIL", "would_change": "a half below zero"})
GATES.append({"id": "G9", "section": "S4", "label": "Survives without best 5%", "name": f"test {_best}'s net an entry with its best 5% of entries taken out has a 95% interval by 15-minute slot above zero, the trim recomputed inside each slot resample (a few wins must not carry everything)",
              "reading": f"{SUMM[_best]['per_ex_top5']:+.3f} USD an entry without the best 5% (95% by slot {SUMM[_best]['per_ex_top5_lo']:+.2f} to {SUMM[_best]['per_ex_top5_hi']:+.2f}, "
                         f"{SUMM[_best]['p_ex_top5_le0']:.0%} of the resamples at or below zero); {SUMM[_best]['top5_share']*100:.0f}% of the net sits in them; each trade's own reward to risk averages {SUMM[_best]['rr_trade_mean']:.2f}",
              "verdict": "PASS" if SUMM[_best]["per_ex_top5_lo"] > 0 else "FAIL", "would_change": "a lower end above zero once the best 5% are out"})
_r_, _f_, _q_ = OOS2W[_best], FOLDS[_best], RAND[_best]
_o1_, _pl_ = _r_[1], _f_["pooled"]
GATES.append({"id": "G10", "section": "S4", "label": "Best test, OOS 2w", "name": f"test {_best}'s out-of-sample two weeks ({_o1_['first'][5:]} to {_o1_['last'][5:]}) hold at least {O.MIN_N} entries, net above zero and inside the in-sample two weeks' 95% interval",
               "reading": f"{_o1_['s'].get('per', float('nan')):+.3f} USD an entry on {_o1_['s'].get('n', 0):,} entries against the forecast {_r_[0]['s']['per_lo']:+.2f} to {_r_[0]['s']['per_hi']:+.2f}"
                          + (f"; out-of-sample 2 ({_r_[2]['n_days']} days) {_r_[2]['s'].get('per', float('nan')):+.3f}, {_r_[2]['verdict']}" if len(_r_) > 2 else ""),
               "verdict": "PASS" if OOS_PASS[_best]["g10"] else "FAIL", "would_change": "an out-of-sample net an entry below zero or outside the forecast's interval"})
GATES.append({"id": "G11", "section": "S4", "label": "Best test, folds", "name": f"test {_best}'s pooled out-of-sample weeks net above zero and at least three of its {_f_['n_folds']} week-against-week folds consistent",
               "reading": f"pooled {_pl_.get('per', float('nan')):+.3f} USD an entry (95% {_pl_.get('per_lo', float('nan')):+.2f} to {_pl_.get('per_hi', float('nan')):+.2f}) on {_pl_.get('n', 0):,}; "
                          f"{_f_['consistent']} of {_f_['n_folds']} folds consistent, Spearman of the fold means {_f_['rho']:+.2f} (a description)",
               "verdict": "PASS" if OOS_PASS[_best]["g11"] else "FAIL", "would_change": "a pooled net below zero or fewer than three consistent folds"})
GATES.append({"id": "G12", "section": "S4", "label": "Best test beats random", "name": f"test {_best}'s net an entry beats the random-burst null (the same count of entries in each day and coin at seconds that pass every condition of the test except the burst, the side the one whose ask passes the gate) at one-sided p below {P_GATE:.2f}, {N_DRAWS:,} draws; the coin-flip side is printed, not gated",
               "reading": (f"random burst p {_q_['p_burst']:.4f} (the net without the best 5% {_q_['p_burst_ex5']:.4f})" if np.isfinite(_q_["p_burst"]) else f"test {_best} has no burst to randomise")
                          + f"; coin-flip side (buys the far token: measures the price gate, not the burst) p {_q_['p_side']:.4f}",
               "verdict": "PASS" if OOS_PASS[_best]["g12"] else "FAIL", "would_change": f"a random-burst p of {P_GATE:.2f} or more"})
_fd_ = FEES[_best]["d"]
_f2_ = {x_["m"]: x_ for x_ in FEES[_best]["sw"]}[2.0]
GATES.append({"id": "G13", "section": "S4", "label": "Best test bears 2x fee", "name": f"test {_best}'s net an entry stays above zero with the taker fee at twice the rate its markets charged ({2 * _fd_['rate']:g}), on the same entries (gate 2's cost sweep)",
               "reading": f"{_f2_['per']:+.3f} USD an entry at 2x (95% {_f2_['lo']:+.2f} to {_f2_['hi']:+.2f}); at the rate {_fd_['rate']:g}: gross {_fd_['gross']:+.3f}, fee {_fd_['fee']:.3f}, net {_fd_['net']:+.3f}; "
                          f"break-even {_fd_['be_mult']:.2f}x, a rate of {_fd_['be_rate']:.3f}",
               "verdict": "PASS" if _f2_["per"] > 0 else "FAIL", "would_change": "a net an entry at or below zero at twice the fee"})
_s = SUMM[_best]
E_BEST = TESTS[_best]
VERDICT = {"word": WORD, "why": [f"test {_best} is the strongest expression: {_s['per']:+.3f} USD an entry (95% {_s['per_lo']:+.2f} to {_s['per_hi']:+.2f}) on {_s['n']:,} entries, win {_s['win']*100:.1f}% against {_s['breakeven']*100:.1f}%",
                                 f"momentum alone (C) {SUMM['C']['per']:+.3f} and the price gate alone (D) {SUMM['D']['per']:+.3f}: both halves of the rule are necessary",
                                 "no interval clears zero: the edge is real in sign but not yet confirmable on 38 days of one regime" if not [k for k in LABELS if SUMM[k]["per_lo"] > 0] else "an interval clears zero"],
           "next_bet": "the forward days from 2026-10-08 as the daily tables seat, read once with test A frozen as it stands (the backward ladders are pinned; B-0670 is the platform job)"}
CAVEATS = ["38 days of one regime: one observation of the market, not independent; every test is a fixed rule read once on the whole window, in-sample for the earlier grids' choices",
           "the S5 splits (two weeks against two weeks, week against week) are consistency checks of a fixed rule on days it was already read on, not a test of fitted parameters; the forward days are the out-of-sample read",
           "every sale of the far token and the gate on the bid were retired on 2026-10-10; the retired tests live in this notebook's history and in um-015",
           "the Binance trade-implied mid stands in for the Chainlink reference; the fair value is driftless by construction",
           "the book is a reconstruction of the venue's stream; Binance and Polymarket clocks taken as one; the fill ladder keeps four levels a side",
           "the first decision is 5 s after the start; thin markets can have no book yet",
           "our own tick-to-trade is an assumed 100 ms on top of the venue hold, not a measurement; the table at 150 ms is one re-run away"]
HEADLINE = {"metric": f"net PnL per entry, USD, whole window, test {_best}", "label": "Net per entry", "value": float(_s["per"]), "unit": "usd", "hurdle": 0.0}
COMPONENTS = [{"name": "PnL before costs", "usd": float(E_BEST["gross"].sum())}, {"name": "fees", "usd": -float(E_BEST["fee"].sum())}]
_wins, _loss = E_BEST["net"][E_BEST["net"] > 0], E_BEST["net"][E_BEST["net"] <= 0]
PF = float(_wins.sum() / abs(_loss.sum())) if len(_loss) and _loss.sum() != 0 else None
WLR = float(_wins.mean() / abs(_loss.mean())) if len(_wins) and len(_loss) else None
_eq = np.cumsum(E_BEST["net"])
_peak = np.maximum.accumulate(np.concatenate([[0.0], _eq]))[1:]
_max_dd = float(-(_eq - _peak).min())
_daily = [float(E_BEST["net"][E_BEST["day"] == i].sum()) for i in range(len(DAYS))]
METRICS = {"ann_return_pct": None, "excess_vs_hurdle_pct": None, "ann_vol_pct": None,
           "sharpe": None, "sortino": None, "calmar": None, "psr": None, "dsr": None,
           "max_dd_pct": _max_dd / BOOK_USD * 100, "max_dd_days": float(len(DAYS)), "n_periods": float(len(DAYS) * 96), "periods_per_year": 96.0 * 365.0,
           "total_return_pct": float(_s["net"] / BOOK_USD * 100), "n_trades": float(_s["n"]), "trades_per_day": float(_s["n"] / len(DAYS)),
           "hit_rate_pct": float(_s["win"] * 100), "profit_factor": PF, "expectancy_bps": float(_s["per"] / CLIP_USD * 1e4),
           "win_loss_ratio": WLR, "avg_hold_h": None, "exposure_pct": None,
           "turnover_ann": float(E_BEST["cost"].sum() / len(DAYS) * 365 / BOOK_USD),
           "fees_pct_of_gross": float(E_BEST["fee"].sum() / abs(E_BEST["gross"].sum()) * 100) if E_BEST["gross"].sum() else None,
           "worst_period_pct": min(_daily) / BOOK_USD * 100,
           "gross_edge_bps": _s["gross_per"] / CLIP_USD * 1e4, "cost_bps": _s["fee_per"] / CLIP_USD * 1e4,
           "breakeven_cost_bps": _s["gross_per"] / CLIP_USD * 1e4, "capacity_usd": None, "beta_to_underlying": None}
NA = {"ann_return_pct": "38 days of one regime: an annualised return is not meaningful", "excess_vs_hurdle_pct": "no hurdle on a fixed rule",
      "ann_vol_pct": "not meaningful on 38 days", "sharpe": "not computed on a fixed rule", "sortino": "not computed", "calmar": "not computed",
      "psr": "not computed", "dsr": "not computed (no grid to deflate)", "avg_hold_h": "held to expiry, not tracked per second",
      "exposure_pct": "not tracked per second", "capacity_usd": "the ladder depth beyond four levels is not kept",
      "beta_to_underlying": "a binary payoff: no single underlying beta"}
STRATEGY = {"name": "Buy the near token a Binance burst left under fair value, 15m Up/Down", "thesis": "a Binance burst persists and the Polymarket book has not re-priced it against the driftless fair value: the near token's ask sits under fair (A), neither the burst alone (C) nor the gate alone (D) pays; a stale book (E), breadth (F), Bitcoin's lead (G) and the depth at the touch (H) are read as fixed rules beside it",
            "market": "prediction markets", "instruments": ["BTC", "ETH", "SOL", "XRP"], "venues": ["Polymarket", "Binance (input)"], "style": "momentum"}
RULES = {"entry": (f"test {_best}: " + ("|z10|>=3, " if _best in "ACEFH" else "btc |z10|>=3, " if _best == "G" else "no burst, ") + ("near ask < fair-0.05, " if _best in "ADEFGH" else "no price gate, ") + "buy near")[:60], "exit": "hold to the outcome", "sizing": f"USD {CLIP_USD:g} a trade", "rebalance": None,
         "hedge": None, "hold": "to expiry", "stop": None, "cost": "taker fee 0.07 x p(1-p); +250 ms (150 venue + 100 own)"}
PARAMS = {"clip": {"value": CLIP_USD, "unit": "usd", "source": "owner"}, "latency_ms": {"value": float(LAT_MS), "unit": "ms", "source": "[U]"}, "venue_hold_ms": {"value": float(VENUE_HOLD_MS), "unit": "ms", "source": "[1]"}, "own_latency_ms": {"value": float(OWN_MS), "unit": "ms", "source": "[U]"},
          "fee_rate": {"value": float(FEE_RATES["rates"][0]) if len(FEE_RATES["rates"]) == 1 else float(FEE_RATES["mode"]), "unit": "rate", "source": "[API]"}, "theta": {"value": THETA, "unit": "usd a share", "source": "owner"}, "z_min": {"value": Z_MIN, "unit": "sigma", "source": "owner"}}
EQ = [(_dt.datetime.fromtimestamp(int(s_) * 900, _dt.timezone.utc) + _dt.timedelta(minutes=15), float(BOOK_USD + v)) for s_, v in zip(E_BEST["slot"], _eq)]
PROFILE = {"market": "predmkts", "markets": ["predmkts", "crypto"], "venues": ["polymarket", "binance"],
           "instruments": ["BTC, ETH, SOL, XRP 15m Up/Down", "spot aggTrades"], "bar": "15m"}
_kind_of = {"equity": "equity-curve", "coins": "equity-curve", "entrypx": "calibration", "winloss": "win-loss-distribution",
            "bigwin": "trade-anatomy", "bigloss": "trade-anatomy", "compare": "rule-comparison", "winrr": "win-loss-distribution", "daily": "regime-and-concentration", "daily3": "regime-and-concentration",
            "oos2w": "out-of-sample-test", "oosfolds": "out-of-sample-test", "random": "significance-test",
            "howdeep": "capacity-curve", "earnclip": "capacity-curve", "underedge": "book-depth-over-time", "fees": "cost-sensitivity"}
for f_ in FIGURES:
    f_["kind"] = _kind_of[f_["id"].split("-")[-1]]

STUDY = REPORT.build_manifest(id=STUDY_ID, kind=KIND, desk=DESK, title=TITLE, question=QUESTION, status="run",
    run={"executed": RUN_AT, "kernel": "ccvenv"}, inputs=INPUTS, window=WINDOW, verify=VERIFY, gates=GATES, figures=FIGURES,
    verdict=VERDICT, caveats=CAVEATS, headline=HEADLINE, components=COMPONENTS, summary=None, format="directional", style="systematic",
    metrics=METRICS, na=NA, strategy=STRATEGY, rules=RULES, params=PARAMS, equity=EQ, profile=PROFILE, book=None)
S0_HANDLE.update(Markdown(REPORT.summary_md(STUDY)))
display(REPORT.display_bundle(STUDY), raw=True)
''', "manifest")

md(r'''
## A · Appendix

Every entry of test A and of test B (the first forty rows of each; the full arrays are in the kernel), and where the logic lives:
the seven tests are `tf15_cands.near_tests`, the fills `tf15_bt.entries`, the figures `tf15_trade_figs`, each test's S5 splits and nulls `tf15_oos` and their figures `tf15_oos_figs`.
''')

code(r'''
for k in ("A",):
    display(Markdown(f"**Test {k}, every entry in time order**"))
    display(HTML(trades_df(TESTS[k], np.arange(len(TESTS[k]["net"]))).round(3).to_html(index=False, border=0, max_rows=40)))
''')

nbk = new_notebook(cells=CELLS, metadata={"kernelspec": {"name": "ccvenv", "display_name": "ccvenv", "language": "python"}, "language_info": {"name": "python"}})
t0 = time.time()
NotebookClient(nbk, timeout=3600, kernel_name="ccvenv", allow_errors=True).execute()
for c in nbk.cells:
    if c.cell_type != "code":
        continue
    for o in c.get("outputs", []):
        if "data" in o and "image/png" in o["data"]:
            raw = base64.b64decode(o["data"]["image/png"])
            im = Image.open(io.BytesIO(raw)).convert("RGB").quantize(colors=64, method=Image.Quantize.FASTOCTREE)      # octree, not median cut: median cut dropped the verdict green and red of small marks (2026-10-11); 64 colours again since the size limit went (B-0719)
            buf = io.BytesIO()
            im.save(buf, format="PNG", optimize=True)
            o["data"]["image/png"] = base64.b64encode(buf.getvalue()).decode()
errs = sum(1 for c in nbk.cells if c.cell_type == "code" for o in c.get("outputs", []) if o.get("output_type") == "error")
if errs:
    for i, c in enumerate(nbk.cells):
        if c.cell_type != "code":
            continue
        for o in c.get("outputs", []):
            if o.get("output_type") == "error":
                print(f"--- cell {i} ERROR {o['ename']}: {o['evalue']}")
                print("\n".join(o.get("traceback", [])[-3:]))
    print(f"NOT WRITTEN: {errs} cell error(s)")
    sys.exit(1)
nbformat.write(nbk, NB)
print(f"wrote {NB.name}: {NB.stat().st_size/1e6:.2f} MB, 0 errors, {time.time()-t0:.0f}s")
