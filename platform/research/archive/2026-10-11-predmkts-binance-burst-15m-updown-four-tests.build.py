"""ARCHIVED 2026-10-11 to research/archive/ on the owner's word; the notebook was last built and committed at be443984; never rebuild it.
It re-runs only from `studies/` (the modules it imports live there): copy it back first; no sys.path line.

Build and execute `2026-10-11-predmkts-binance-burst-15m-updown-four-tests.ipynb`: the three notebooks of the Binance-burst line built on 2026-10-08 and 2026-10-09
(the taker study `...-binance-momentum-15m-updown`, its 22-day re-score `...-momentum-15m-updown-fullwindow` and the maker study `...-binance-burst-maker-15m-updown`)
become one notebook in the "multiple tests" format of `...-burst-15m-updown-buy-near-tests`, re-read on every day the decision tables cover (2026-09-02 to 2026-10-10).
Four fixed rules, no grid, no cell chosen: A the frozen um-009 pair, B the um-012 choice, C A's burst under the fair-value gate, D A's burst as a resting bid on BTC and ETH.
The engines are `mom15_bt` (MTab, Signal, settle), `mom15_diag` (the edge before friction), `mkb15_mk` + `mkb15_study` (the resting bid) on `tf15_bt`; the figures are `tf15_trade_figs`.

Run from `platform/research/studies` with the fund venv (about 15 to 25 minutes):
    ../../../.venv/Scripts/python 2026-10-11-predmkts-binance-burst-15m-updown-four-tests.build.py
    ../../../.venv/Scripts/python 2026-10-11-predmkts-binance-burst-15m-updown-four-tests.build.py --quick     (six days, six placebo draws, written to the temp folder: a debug run)
"""
from __future__ import annotations

import base64
import io
import os
import sys
import tempfile
import time
from pathlib import Path

import nbformat
from nbclient import NotebookClient
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook
from PIL import Image

HERE = Path(__file__).resolve().parent
QUICK = "--quick" in sys.argv
STEM = "2026-10-11-predmkts-binance-burst-15m-updown-four-tests"
NB = (Path(tempfile.gettempdir()) / f"{STEM}-quick.ipynb") if QUICK else (HERE / f"{STEM}.ipynb")
CELLS = []
LABELS = ["A", "B", "C", "D"]
LOW = {k: k.lower() for k in LABELS}
L2_FIGS = True                                   # False: the biggest win and loss keep their notes and fill ladder but lose the anatomy picture (the 3 MB cap)
TITLES = {"A": "the frozen um-009 pair", "B": "the um-012 choice", "C": "A's burst under the fair-value gate", "D": "A's burst as a resting bid, BTC and ETH"}


def md(s):
    CELLS.append(new_markdown_cell(s.strip("\n")))


def code(s, *tags):
    c = new_code_cell(s.strip("\n"))
    if tags:
        c.metadata["tags"] = list(tags)
    CELLS.append(c)


md(r'''
# Does buying the 15-minute Up/Down token after a Binance burst pay, as a taker or as a resting bid, once four fixed rules are read together on one fixed window?

## S0 · Summary

**The question.** A Binance burst (a one-second or a three-minute move of several standard deviations) is followed by a move in the same direction that Polymarket's
15-minute Up/Down book has not fully priced. Does a rule that buys the token the burst points to earn money after the venue's fee and the exact ladder, and is it a taker's or a
resting bid's money? Four fixed rules answer it, each read once on the whole window with the same engine, the same costs and the same split: nothing is tuned, no cell is chosen.

**What this replaces.** Three notebooks of the line become this one: the taker study `2026-10-08-predmkts-binance-momentum-15m-updown` (um-009), its 22-day re-score
`2026-10-08-predmkts-binance-momentum-15m-updown-fullwindow` (um-012) and the maker study `2026-10-09-predmkts-binance-burst-maker-15m-updown` (um-013). They stay in the
folder as they were built. um-009, um-012 and um-013 stay in the ledger as registered reads: each was read on its own pre-registered split and, for um-013, its forward gate has not
opened. This notebook is a new read of fixed rules on a longer window that overlaps theirs, so it is not a replication of any of them and moves no belief on its own.
Everything those three held that bears on the four rules is here, so they can be retired: the four tests with their entries, halves, placebo, planted peek and costs (S3 and S4); the diagnosis of the frozen pair, which splits an entry into the fair value's surprise, the model against the book,
the book's move in the delay, the spread and depth, and the fee, cuts the loss by coin, hour, volatility, moment and side, scores every slice and signal cell with a correction for the number of looks, and scans the book with no signal at all (S5); and the maker's registered forward gate with its code path and its gates F1 to F6 (S5).
''')

code(r'''
from IPython.display import Markdown, display
S0_ANS = display(Markdown("_The answer is written here when the run reaches the verdict._"), display_id=True)
S0_RULES = display(Markdown("_The four rules are drawn here when the run starts._"), display_id=True)
S0_TABLE = display(Markdown("_The tests compared are drawn here when the run finishes._"), display_id=True)
S0_HANDLE = display(Markdown("_The summary card is drawn here when the run finishes._"), display_id=True)
''', "s0")

md(r'''
## S1 · Setup

### S1.1 · Parameters
''')

code(r'''
# ---- the four fixed rules, pre-specified by the owner's brief; no grid, no cell is chosen ----
STUDY_ID = "2026-10-11-predmkts-binance-burst-15m-updown-four-tests"
DESK = "lab/predmkts"
FIRST_DAY, LAST_DAY = "2026-09-02", "2026-10-09"   # the 38 days of the desk's other burst notebook (um-021); a day that does not seat at both delays with its Binance path is dropped in S2
FILL_MS, FILL_MS_D = 250, 150                      # taker: the venue's 150 ms hold plus 100 ms of our own (assumed); the maker's table is the 150 ms one
A_L, A_Z = 1, 2.5                                  # test A: the frozen um-009 pair, a one-second return of at least 2.5 sigma, buy the near token
B_L, B_Z = 180, 3.0                                # test B: the um-012 choice, a 180-second move of at least 3 sigma
FV_MARGIN = 0.05                                   # test C: A's burst, only when the Brownian fair value of the near token clears its ask by this much
D_ASSETS = (0, 1)                                  # test D: BTC and ETH, the same one-second burst as a post-only bid (mkb15_mk.DEFAULT, unchanged)
CLIP_USD, BOOK_USD = 20.0, 1000.0
N_PLACEBO = 200                                    # fair-coin draws at the same firing seconds, per test
PEEK_MARGIN = 5.0                                  # USD an entry: the planted peek must pay at least this much more than the rule
FEE_MULT, SLACK, CLIP_ALT = 2.0, 0.01, (5.0, 100.0)   # the cost table: twice the fee, a cent worse on every fill, other clips
TOP_N = 10                                         # best and worst entries listed a test
VENUE_HOLD_MS = 150                                # the venue's taker hold on crypto markets [1]; the rest of the taker's delay is our own, assumed [U]
LEAK_S, LEAK_MARGIN = 5, 1.0                       # the planted leak: the signal reads this many seconds of the future and must pay this much more (USD an entry)
''', "parameters")

code(r'''
import ast, contextlib, datetime as dt, hashlib, io, json, math, time
from pathlib import Path
import numpy as np, pandas as pd
import matplotlib.pyplot as plt
from IPython.display import HTML, Markdown, display
from fundplat.data import derived
from fundplat.data.predmkts import updown15_pin
from fundplat.data.crypto import ticks
from fundplat.quant.core import figstyle, report as REPORT, summary_card
import tf15_bt as B, tf15_runner as RUNNER, tf15_table as TT, tf15_study as TS, tf15_trade_figs as TF, lift_figs as LF
import mom15_bt as M, mom15_diag as D, mom15_path as P, mom15_full_tweaks as TWK
import mkb15_mk as X, mkb15_study as S
get_ipython().run_line_magic("config", "InlineBackend.print_figure_kwargs = {'bbox_inches': None}")
LF.setup()
plt.rcParams["figure.dpi"] = 84
RUN_AT = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
ASSET = list(TF.COINS)
FIGURES = []
_ms = lambda d_: int(dt.datetime.strptime(d_, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
sgn = lambda v, d=2: f"{v:+,.{d}f}"
pct = lambda v, d=1: f"{v * 100:.{d}f}%"
usd = lambda v, d=0: f"USD {v:,.{d}f}"

# ---- the window: every day that seats at both delays with its Binance path, in date order ----
_d0, _d1 = dt.date.fromisoformat(FIRST_DAY), dt.date.fromisoformat(LAST_DAY)
CANDIDATES = [(_d0 + dt.timedelta(days=i)).isoformat() for i in range((_d1 - _d0).days + 1)]
DAYS, DROPPED = [], []
for d_ in CANDIDATES:
    why_ = [f"no decision table at {fm_} ms" for fm_ in (FILL_MS, FILL_MS_D) if RUNNER.seated(d_, fm_) is None] + (["no Binance 1 s path"] if P.seated(d_) is None else [])
    if why_:
        DROPPED.append((d_, "; ".join(why_)))
    else:
        DAYS.append(d_)
HOURS = 24 * len(DAYS)
_END_MS = _ms(DAYS[-1]) + 86_400_000
CUT_MS = _ms(DAYS[0]) + (_END_MS - _ms(DAYS[0])) // 2          # the middle of the window in time: two halves of equal length
_fmt_t = lambda ms_: dt.datetime.fromtimestamp(ms_ / 1000, dt.timezone.utc).strftime("%m-%d %H:%M")
FIRST_TXT, SECOND_TXT = f"{_fmt_t(_ms(DAYS[0]))} to {_fmt_t(CUT_MS)}", f"{_fmt_t(CUT_MS)} to {_fmt_t(_END_MS)}"
WIN_TXT = f"{DAYS[0][5:]} to {DAYS[-1][5:]} · {HOURS:,}h · {len(DAYS)} days"
print(f"{len(DAYS)} days seat ({DAYS[0]} to {DAYS[-1]}), dropped: {DROPPED or 'none'}; halves cut at {_fmt_t(CUT_MS)} UTC: first {FIRST_TXT}, second {SECOND_TXT}")

t0 = time.time()
TAB = M.MTab(DAYS, fill_ms=FILL_MS)                            # all four coins, the 250 ms table, with the Binance 1 s path (the constructor asserts it equals the table's S)
TABD = M.MTab(DAYS, fill_ms=FILL_MS_D, assets=D_ASSETS)        # the maker's table: BTC and ETH, the 150 ms ladder
print(f"loaded {TAB.W:,} windows (250 ms, four coins) and {TABD.W:,} windows (150 ms, BTC and ETH) in {time.time() - t0:.0f}s")
ROLES = {d_: "all" for d_ in DAYS}
CUTS = D.vol_cuts(TAB)
EX = M.Exit("expiry")
SIG_A, SIG_B = M.Signal(A_L, A_Z), M.Signal(B_L, B_Z)
TITLE = __TITLES__


def fv_gate(tab, side, trig, margin):
    """The fair-value gate of `mom15_full_tweaks.tw_gate` ("fv>=0.05"): the Brownian fair value of the token bought clears its ask by at least `margin`."""
    ask = np.where(side > 0, tab.qa.astype(float), 1.0 - tab.qb.astype(float))
    pus = np.where(side > 0, tab.pu.astype(float), 1.0 - tab.pu.astype(float))
    return trig & ((pus - ask) >= margin) & np.isfinite(ask)


sideA, trigA = SIG_A.fire(TAB)
sideB, trigB = SIG_B.fire(TAB)
trigC = fv_gate(TAB, sideA, trigA, FV_MARGIN)
sideC = np.where(trigC, sideA, 0).astype(np.int8)
sideD, trigD = S.burst(TABD)
T = {}
for k_, sg_, sd_, tr_ in (("A", SIG_A, sideA, trigA), ("B", SIG_B, sideB, trigB), ("C", SIG_A, sideC, trigC)):
    T[k_] = dict(kind="taker", sig=sg_, tab=TAB, side=sd_, trig=tr_, e=M.settle(TAB, sd_, tr_, EX, sg_.lu))
oD, eD = S.run(TABD, sideD, trigD)
T["D"] = dict(kind="maker", sig=M.Signal(*S.SIGNAL), tab=TABD, side=sideD, trig=trigD, e=eD, o=oD)
for k_, t_ in T.items():
    t_["label"], t_["title"] = k_, TITLE[k_]


def half_mask(t, which):
    st_ = t["tab"].w_start[t["e"]["w"]]
    return (st_ < CUT_MS) if which == 0 else (st_ >= CUT_MS)


def placebo_side(t, seed):
    """A fair coin at each of the test's own firing seconds (the same seconds, no information in the side)."""
    rng = np.random.default_rng(seed)
    return np.where(rng.random(t["trig"].shape) < 0.5, 1, -1).astype(np.int8) * t["trig"]


def peek_side(t):
    """The planted peek: the side that wins, at the same firing seconds."""
    return np.where(t["tab"].up, 1, -1).astype(np.int8)[:, None] * t["trig"]


def maker_terms(t):
    """The maker's net split like the taker's: the outcome against the book's mid at the decision (the edge before friction), the price against that mid (the half spread a bid collects), the rebate."""
    e = t["e"]
    mid = 0.5 * (e["bid_seen"] + e["ask_seen"])
    terms = {"edge": (e["won"].astype(float) - mid) * e["shares"], "spread": (mid - e["b"]) * e["shares"], "rebate": -e["fee"]}
    assert np.allclose(sum(terms.values()), e["net"], atol=1e-6), "the maker's terms do not add to its net"
    return terms


def mean_net(x):
    return float(x["net"].mean()) if len(x["net"]) else float("nan")


t0 = time.time()
for k_, t_ in T.items():
    e_, tab_ = t_["e"], t_["tab"]
    t_["s"] = B.summarize(e_, tab_, k_)
    t_["sf"] = B.summarize(B.subset(e_, half_mask(t_, 0)), tab_, k_ + " first half")
    t_["ss"] = B.summarize(B.subset(e_, half_mask(t_, 1)), tab_, k_ + " second half")
    if t_["kind"] == "taker":
        t_["pl"] = np.array([mean_net(M.settle(tab_, placebo_side(t_, 1000 + i_), t_["trig"], EX, t_["sig"].lu)) for i_ in range(N_PLACEBO)])
        pk_ = M.settle(tab_, peek_side(t_), t_["trig"], EX, t_["sig"].lu)
        t_["frame"] = D.entry_frame(tab_, e_, t_["sig"], ROLES, CUTS)
        t_["edge"] = D.edge_stats(t_["frame"])
        t_["wf"] = D.waterfall(t_["frame"])
        t_["terms"] = None
    else:
        t_["pl"], t_["pl_fills"] = S.placebo(tab_, t_["trig"], n=N_PLACEBO)
        _po, pk_ = S.peek(tab_, t_["trig"])
        t_["terms"] = maker_terms(t_)
        ed_ = {nm_: D.cl_mean(v_, e_["slot"]) for nm_, v_ in t_["terms"].items()}
        nm_, se_ = D.cl_mean(e_["net"], e_["slot"])
        t_["edge"] = dict(edge=ed_["edge"][0], edge_lo=ed_["edge"][0] - 1.96 * ed_["edge"][1], edge_hi=ed_["edge"][0] + 1.96 * ed_["edge"][1], friction=nm_ - ed_["edge"][0], net=nm_, net_lo=nm_ - 1.96 * se_, net_hi=nm_ + 1.96 * se_, n=len(e_["net"]))
        _what = {"edge": "outcome against the book's mid at the decision (the edge before friction)", "spread": "the bid against that mid (the half spread a resting bid collects)", "rebate": "maker rebate (20% of the taker fee at the bid)"}
        t_["wf"] = pd.DataFrame([dict(term=k2_, what=_what[k2_], usd=ed_[k2_][0], lo=ed_[k2_][0] - 1.96 * ed_[k2_][1], hi=ed_[k2_][0] + 1.96 * ed_[k2_][1]) for k2_ in ("edge", "spread", "rebate")])
    t_["peek_n"] = int(len(pk_["net"]))
    t_["peek"] = float(pk_["net"].mean()) if len(pk_["net"]) else float("nan")
    t_["p95"] = float(np.nanquantile(t_["pl"], 0.95))
    t_["pl_mean"] = float(np.nanmean(t_["pl"]))
    t_["pl_share_ge"] = float(np.mean(t_["pl"] >= t_["s"]["per"]))
print(f"ran the four tests, {N_PLACEBO} placebo draws each and the planted peeks in {time.time() - t0:.0f}s: " + ", ".join(f"{k_} {T[k_]['s']['n']:,}" for k_ in T))
assert T["D"]["o"]["cfg"] == X.DEFAULT, "test D does not run mkb15_mk.DEFAULT unchanged"
assert (A_L, A_Z) == tuple(S.SIGNAL) and tuple(D_ASSETS) == tuple(S.ASSETS) and FILL_MS_D == S.FILL_MS, "test D's signal, coins or table are not the maker study's"

# ---- the taker on the windows test D filled ----
_kA = pd.DataFrame(dict(st=TAB.w_start[T["A"]["e"]["w"]], a=TAB.w_asset[T["A"]["e"]["w"]], net_taker=T["A"]["e"]["net"]))
_kD = pd.DataFrame(dict(st=TABD.w_start[eD["w"]], a=TABD.w_asset[eD["w"]], net_maker=eD["net"], slot=eD["slot"]))
MATCH = _kD.merge(_kA, on=["st", "a"], how="inner")
_dm = (MATCH["net_maker"] - MATCH["net_taker"]).to_numpy()
MATCH_STAT = dict(n=len(MATCH), n_fills=len(_kD), maker=float(MATCH["net_maker"].mean()), taker=float(MATCH["net_taker"].mean()), diff=float(_dm.mean()), diff_ci=B.slot_boot(MATCH["slot"].to_numpy(), _dm))
_eA = T["A"]["e"]
A_BTC_ETH = B.summarize(B.subset(_eA, _eA["asset"] <= 1), TAB, "A on BTC and ETH")
''')
code(r'''
# ---- the four rules, in words, from the parameters ----
_life = "its whole life" if X.DEFAULT["life_s"] is None else f"{X.DEFAULT['life_s']:g} s"
_rules = pd.DataFrame([
    dict(Test="A", Rule=TITLE["A"], Burst=f"{A_L} s Binance return of at least {A_Z:g} sigma", Gate="none", Order=f"buy the near token {FILL_MS} ms later at the ladder then standing", Coins="all four"),
    dict(Test="B", Rule=TITLE["B"], Burst=f"{B_L} s Binance move of at least {B_Z:g} sigma", Gate="none", Order="the same", Coins="all four"),
    dict(Test="C", Rule=TITLE["C"], Burst=f"A's burst ({A_L} s, {A_Z:g} sigma)", Gate=f"the Brownian fair value of the near token clears its ask by at least {FV_MARGIN:.2f}", Order="the same", Coins="all four"),
    dict(Test="D", Rule=TITLE["D"], Burst=f"A's burst ({A_L} s, {A_Z:g} sigma)", Gate="none",
         Order=f"post-only bid of USD {X.DEFAULT['usd']:g} at the touch, rests at most {_life}, cancelled on a {X.DEFAULT['retrace']:g} sigma retrace, one fill a window, rebate {X.REBATE:.0%} of the taker fee",
         Coins=f"{' and '.join(ASSET[i_].upper() for i_ in D_ASSETS)}, the {FILL_MS_D} ms table")])
S0_RULES.update(Markdown("**The four rules** (all: USD " + f"{CLIP_USD:g}" + " a trade, one entry a window, held to expiry, the market's own taker fee for a taker, the exact ladder, no outcome read to build a signal)\n\n"
                         "| Test | Rule | Burst | Gate | Order | Coins |\n|---|---|---|---|---|---|\n" + "\n".join(f"| {r.Test} | {r.Rule} | {r.Burst} | {r.Gate} | {r.Order} | {r.Coins} |" for r in _rules.itertuples())
                         + f"\n\n**The window.** {len(DAYS)} days, {DAYS[0]} to {DAYS[-1]}, {HOURS:,} hours, one regime, split in time into two halves of equal length ({FIRST_TXT}; {SECOND_TXT}, UTC). "
                         + (f"Dropped for want of a seated table or path: {', '.join(d_ + ' (' + w_ + ')' for d_, w_ in DROPPED)}." if DROPPED else "No day was dropped.")))
''')

md(r'''
### S1.2 · Assumptions
''')

code(r'''
_fees = np.unique(np.round(TAB.w_fee.astype(float), 4))
FWD_IN = [d_ for d_ in S.FORWARD_DAYS if d_ in DAYS]
display(Markdown("| Item | Value | Source |\n|---|---|---|\n"
    f"| The venue's taker hold | {VENUE_HOLD_MS} ms: a marketable order on a crypto market is held before matching | venue changelog [1] |\n"
    f"| Our own tick-to-trade | {FILL_MS - VENUE_HOLD_MS} ms from the Binance print to our order at the venue, ASSUMED until a live measurement replaces it | [U] |\n"
    f"| The delay in the taker's engine | {FILL_MS} ms: the order meets the ladder as it stood {FILL_MS} ms after the decision second (tests A to C) | this study |\n"
    f"| The maker's table | {FILL_MS_D} ms: the post meets the book as it stood {FILL_MS_D} ms after the decision second, the cancel lands {X.CANCEL_LAT_MS} ms after a retrace (test D) | `mkb15_mk`, the maker study |\n"
    f"| Taker fee | shares x rate x p x (1 - p), each market's own rate ({', '.join(f'{r_:g}' for r_ in _fees)} in the window), on the price side the trade touches | venue fact `fee.formula` [1] |\n"
    f"| Maker rebate | {X.REBATE:.0%} of the taker fee the print paid, no maker fee | venue fact [1] |\n"
    f"| Minimum order | {B.MIN_SHARES:g} shares for a taker | market rows [API] |\n"
    f"| Fair value | driftless Brownian P(Up) of the 60 s TWAP, no momentum term; used by test C's gate only | the 15-minute study (B-0642) |\n"
    f"| Clip and book | USD {CLIP_USD:g} a trade, USD {BOOK_USD:,.0f} book, 1x, one entry a window, held to expiry | the brief |\n"
    f"| Price limit and first decision | a buy is never above {M.LIMIT}; no decision in the first {M.KMIN} s or with under {M.TMIN} s left | `mom15_bt` [U], fixed before scoring |\n"
    f"| The two halves | cut at {_fmt_t(CUT_MS)} UTC, the middle of the window in time, fixed before any outcome was read; each half is {HOURS // 2:,} hours | this study |\n"
    f"| The forward days of um-013 | {len(FWD_IN)} of its {len(S.FORWARD_DAYS)} registered forward days ({', '.join(d_[5:] for d_ in FWD_IN) or 'none'}) fall inside this window; this notebook reads them descriptively and opens no forward gate: um-013's gate needs all {len(S.FORWARD_DAYS)} seated and the frozen rule read once by `ForwardGate` | owner's word, 2026-10-11 |"))
''')

md(r'''
### S1.3 · Data

Every input is a seated decision table read through `fundplat.data` (`tf15_runner.py`, code `tf15-2026-10-08b`, one UTC day at a time, at the 250 ms and the 150 ms delay) plus the Binance
1-second path of the day (`mom15_path.py`), both pinned in the manifest by their derived hash, with the Polymarket ladder pin (`updown15_pin.input_pin`) and the Binance aggTrades pin (`ticks.input_pin`).
The tables are the BTC, ETH, SOL and XRP 15-minute Up/Down windows; a window without a book at the first decision second is out before any outcome is read.
''')

code(r'''
# ---- helpers every test block uses ----
def row(label, s):
    if s.get("n", 0) == 0:
        return dict(label=label, n=0, win_pct=np.nan, breakeven_pct=np.nan, per_entry=np.nan, lo=np.nan, hi=np.nan, net=0.0, avg_win=np.nan, avg_loss=np.nan, reward_to_risk=np.nan,
                    profit_factor=np.nan, win_needed_pct=np.nan, per_entry_ex_best5=np.nan, best5_share_pct=np.nan)
    return dict(label=label, n=s["n"], win_pct=s["win"] * 100, breakeven_pct=s["breakeven"] * 100, per_entry=s["per"], lo=s["per_lo"], hi=s["per_hi"], net=s["net"], avg_win=s["avg_win"], avg_loss=s["avg_loss"],
                reward_to_risk=s["rr"], profit_factor=s["pf"], win_needed_pct=s["win_needed"] * 100, per_entry_ex_best5=s["per_ex_top5"],
                best5_share_pct=s["top5_share"] * 100 if np.isfinite(s["top5_share"]) else np.nan)


def interval_word(s):
    return "clears zero" if s.get("n", 0) and s["per_lo"] > 0 else ("spans zero" if s.get("n", 0) and s["per_hi"] > 0 else "is below zero")


def by_coin(t):
    e = t["e"]
    return {a_: (B.summarize(B.subset(e, e["asset"] == ai_), t["tab"], a_).get("per", float("nan")) if (e["asset"] == ai_).any() else float("nan")) for ai_, a_ in enumerate(ASSET)}


def answer_line(lab):
    t = T[lab]
    s, sf, ss, ed = t["s"], t["sf"], t["ss"], t["edge"]
    unit = "fills" if t["kind"] == "maker" else "entries"
    coins = ", ".join(f"{a_.upper()} {v_:+.2f}" if v_ == v_ else f"{a_.upper()} no {unit[:-1] if unit == 'fills' else 'entry'}" for a_, v_ in by_coin(t).items())
    return (f"**Test {lab}: {t['title']}.** {s['n']:,} {unit} over {len(DAYS)} days, win rate {s['win']*100:.1f}% (Wilson 95% {s['win_lo']*100:.1f} to {s['win_hi']*100:.1f}) against {s['breakeven']*100:.1f}% to break even on the price paid; "
            f"the mean win is {s['avg_win']:+.2f} USD and the mean loss {s['avg_loss']:+.2f}, reward to risk {s['rr']:.2f}, profit factor {s['pf']:.2f}, so the payoff needs {s['win_needed']*100:.1f}% wins and "
            f"{'gets' if s['win'] > s['win_needed'] else 'does not get'} them. Net {s['per']:+.3f} USD per {unit[:-1] if unit == 'fills' else 'entry'} (95% by 15-minute slot {s['per_lo']:+.2f} to {s['per_hi']:+.2f}, which {interval_word(s)}), {s['net']:+,.0f} USD in all; "
            f"first half {sf.get('per', float('nan')):+.3f} on {sf.get('n', 0):,}, second half {ss.get('per', float('nan')):+.3f} on {ss.get('n', 0):,}. "
            f"Before friction the {unit[:-1] if unit == 'fills' else 'entry'} earns {ed['edge']:+.2f} USD (95% {ed['edge_lo']:+.2f} to {ed['edge_hi']:+.2f}) and friction takes {ed['friction']:+.2f}. "
            f"Without the best 5% of {unit} the net is {s['per_ex_top5']:+.3f}"
            + (f" ({s['top5_share']*100:.0f}% of the net sits in them): a few wins carry everything. " if s["per_ex_top5"] <= 0 < s["per"] else ": the edge survives without its best wins. " if s["per_ex_top5"] > 0 else ". ")
            + f"A fair-coin side at the same seconds earns {t['pl_mean']:+.3f} on average (95th percentile {t['p95']:+.3f} over {len(t['pl'])} draws); the planted peek earns {t['peek']:+.2f}. By coin: {coins}.")


def invariants(lab):
    t = T[lab]
    e, tab, sg = t["e"], t["tab"], t["sig"]
    w, k = e["w"], e["k"]
    z = tab.zlook(sg.L)[w, k]
    gate_ok = bool(np.all(t["trig"][w, k])) and bool(np.all(e["side"] == t["side"][w, k])) and bool(np.all(np.abs(z) >= sg.z - 1e-9)) and bool(np.all(np.sign(z) == e["side"]))
    if lab == "C":
        ask = np.where(e["side"] > 0, tab.qa[w, k].astype(float), 1.0 - tab.qb[w, k].astype(float))
        pus = np.where(e["side"] > 0, tab.pu[w, k].astype(float), 1.0 - tab.pu[w, k].astype(float))
        gate_ok = gate_ok and bool(np.all(pus - ask >= FV_MARGIN))
    rate = tab.w_fee[w].astype(float)
    if t["kind"] == "taker":
        price = bool(np.all((e["vwap"] <= M.LIMIT + 1e-6) & (e["vwap"] >= e["best"] - 1e-6)))
        size = bool(np.all(e["shares"] >= B.MIN_SHARES))
        fee = bool(np.all((e["fee"] > 0) & (e["fee"] <= rate * 0.25 * e["shares"] + 1e-9)))
    else:
        price = bool(np.all(np.abs(e["b"] - np.round(e["bid_seen"], 4)) < 1e-6) and np.all((e["b"] >= X.DEFAULT["p_lo"]) & (e["b"] <= X.DEFAULT["p_hi"])))
        size = bool(np.all((e["shares"] > 0) & (e["shares"] <= e["target"] + 1e-9)))
        fee = bool(np.allclose(e["fee"], -X.REBATE * rate * e["b"] * (1.0 - e["b"]) * e["shares"], atol=1e-9))
    return [("every fill is at a price the book allowed (a buy at or under the limit and at or over the best ask; a resting bid at the best bid it saw)", price),
            ("every fill is a size the venue allows (a buy of at least the minimum; a bid fills at most its target)", size),
            ("every outcome is the venue's own resolution of its window", bool(np.all(e["won"] == ((e["side"] > 0) == tab.up[w])))),
            ("net = payoff - cost - fee for every entry (a maker's fee is minus its rebate)", bool(np.allclose(e["net"], e["payoff"] - e["cost"] - e["fee"]))),
            ("the fee is the market's own (a taker's positive and at most rate x 0.25 a share; a maker's rebate is its share of the taker fee at the bid)", fee),
            (f"every decision had at least {M.TMIN} s left", bool(np.all(e["T"] >= M.TMIN - 1e-9))),
            ("one entry a window", len(set(w.tolist())) == len(w)),
            ("every entry's decision second passed its own gate and bet with the burst", gate_ok)]


def pass_table(rows):
    return "| Check | Result |\n|---|---|\n" + "\n".join(f"| {l_} | {'PASS' if ok_ else 'FAIL'} |" for l_, ok_ in rows)


def trades_df(t, idx):
    e = t["e"]
    d = dict(day=[DAYS[i_] for i_ in e["day"][idx]], coin=[ASSET[i_] for i_ in e["asset"][idx]], near=np.where(e["side"][idx] > 0, "Up", "Down"), second=(M.K0 + e["k"][idx]).astype(int),
             seconds_left=e["T"][idx].astype(int), price_paid=e["vwap"][idx], shares=e["shares"][idx], usd_at_risk=e["cost"][idx], fee=e["fee"][idx], won=e["won"][idx], net=e["net"][idx])
    if t["kind"] == "maker":
        d["queue_ahead"] = e["q"][idx]
        d["filled_after_s"] = (e["t_fill"][idx] - e["t_dec"][idx]) / 1000.0
    return pd.DataFrame(d)


def anat_notes(lab, i):
    """Three findings for the anatomy of entry i, in the test's own terms (the figure's default words are the 10 s, 150 ms buy)."""
    t = T[lab]
    e, tab = t["e"], t["tab"]
    w, k, side = int(e["w"][i]), int(e["k"][i]), int(e["side"][i])
    ask, bid, fair, _lad = TF._frame_token(tab, w, side)
    start = dt.datetime.fromtimestamp(int(tab.w_start[w]) // 1000, tz=dt.timezone.utc)
    z = float(tab.zlook(t["sig"].L)[w, k])
    tok = "Up" if side > 0 else "Down"
    move_bp = (float(tab.S[w, k]) / float(tab.w_a0[w]) - 1.0) * 1e4
    won, net = bool(e["won"][i]), float(e["net"][i])
    vwap, shares, cost, fee = float(e["vwap"][i]), float(e["shares"][i]), float(e["cost"][i]), float(e["fee"][i])
    first = (f"{ASSET[int(e['asset'][i])].upper()} window starting {start:%Y-%m-%d %H:%M} UTC; decision at second {M.K0 + k} ({int(e['T'][i])} s left), Binance {t['sig'].L} s z {z:+.1f}, "
             f"the mid {move_bp:+.0f} bp from the window's start.")
    if t["kind"] == "taker":
        second = (f"The {tok} token asked {ask[k]:.2f} and bid {bid[k]:.2f} against a driftless fair value of {fair[k]:.3f} (ask minus fair {ask[k] - fair[k]:+.3f}). "
                  f"The fill {FILL_MS} ms later paid {vwap:.3f} a share for {shares:.2f} shares (cost {cost:.2f} USD, fee {fee:.2f}).")
        why = f"The size of the result is the position times the distance to settlement: {shares:.2f} shares x {(1 - vwap) if won else -vwap:+.3f} a share, less the {fee:.2f} fee."
    else:
        r = int(np.flatnonzero(t["o"]["is_fill"])[i])
        second = (f"The {tok} token bid {bid[k]:.2f} and asked {ask[k]:.2f} against a driftless fair value of {fair[k]:.3f}. The order rested a post-only bid at {vwap:.2f} behind {float(e['q'][i]):.0f} shares "
                  f"and filled {shares:.2f} of {float(e['target'][i]):.2f} shares {(float(e['t_fill'][i]) - float(e['t_dec'][i])) / 1000:.1f} s after the decision (cost {cost:.2f} USD, rebate {-fee:.3f}); "
                  f"the figure marks the decision second, not the fill.")
        why = f"The size of the result is the position times the distance to settlement: {shares:.2f} shares x {(1 - vwap) if won else -vwap:+.3f} a share, plus the rebate."
    return [first, second, f"It {'won: every share paid 1 USD' if won else 'lost: every share paid 0'}; net {net:+.2f} USD. {why}"]


def ladder_rows(lab, i):
    """The fill ladder of entry i in the traded token's frame (taker), or the resting order's own record (maker). -> (DataFrame, caption)."""
    t = T[lab]
    e, tab = t["e"], t["tab"]
    w, k, side = int(e["w"][i]), int(e["k"][i]), int(e["side"][i])
    ask, bid, fair, _lad = TF._frame_token(tab, w, side)
    tok = f"{ASSET[int(e['asset'][i])].upper()} {'Up' if side > 0 else 'Down'}"
    if t["kind"] == "taker":
        rec = M.l2_record(tab, e, i)
        bpx, bsz = (a_[0] for a_ in B.ladder_of(tab, np.array([w]), np.array([k]), np.array([side]), buy=False))
        paid = rec["ask_take"] * np.nan_to_num(rec["ask_px"])
        df = pd.DataFrame(dict(level=np.arange(1, len(bpx) + 1), bid_size=bsz, bid=bpx, ask=rec["ask_px"], ask_size=rec["ask_sz"], taken_shares=rec["ask_take"], usd_at_risk=paid))
        cap = (f"Fill ladder at second {M.K0 + k} + {FILL_MS} ms, {tok} token: a buy of {CLIP_USD:g} USD walking the asks up to {M.LIMIT}; fair value {fair[k]:.3f}; "
               f"took {rec['ask_take'].sum():.2f} shares for {paid.sum():.2f} USD.")
        return df, cap
    o = t["o"]
    r = int(np.flatnonzero(o["is_fill"])[i])
    df = pd.DataFrame(dict(field=["decision second", "bid posted", "best bid seen", "best ask seen", "shares ahead in the queue", "target shares", "shares filled", "order landed (s)", "filled at (s)",
                                  "order ended (s)", "cancelled on a retrace"],
                           value=[M.K0 + k, o["b"][r], o["bid_seen"][r], o["ask_seen"][r], o["q"][r], o["target"][r], o["filled"][r], o["t_eff"][r] / 1000.0, o["t_fill"][r] / 1000.0, o["t_end"][r] / 1000.0, bool(o["cancelled"][r])]))
    cap = (f"The resting bid, {tok} token: posted at second {M.K0 + k} at the best bid seen, back of the queue, filled only from prints at or through its price; fair value {fair[k]:.3f}; "
           f"filled {o['filled'][r]:.2f} of {o['target'][r]:.2f} shares.")
    return df, cap
''')
md(r'''
## S2 · Data checks

Every input is a seated decision table or Binance path read through `fundplat.data`, one UTC day at a time. The engine's own checks run here and count into `verify`; the planted leak must pay far more than the
real rule; then every test's entries go through the same eight invariants.
''')

code(r'''
# ---- coverage: windows with a book by the first decision second, and the days that seat ----
COV = pd.DataFrame([dict(day=d_, windows=int(TAB.meta[i_]["windows"]), with_book=int((TAB.day == i_).sum()), btc_eth_with_book_150ms=int((TABD.day == i_).sum())) for i_, d_ in enumerate(DAYS)])
SHARE = float(COV.with_book.sum() / COV.windows.sum())
display(Markdown("**Windows with a book**\n\n| Day | Windows | With a book | BTC and ETH with a book, 150 ms table |\n|---|---|---|---|\n" +
                 "\n".join(f"| {r.day} | {r.windows} | {r.with_book} | {r.btc_eth_with_book_150ms} |" for r in COV.itertuples()) +
                 f"\n\n{SHARE:.0%} of windows have a book; the rest are out before any outcome is read. The 250 ms table holds {TAB.W:,} windows, the 150 ms table {TABD.W:,}. "
                 + (f"Dropped: {'; '.join(d_ + ' (' + w_ + ')' for d_, w_ in DROPPED)}." if DROPPED else f"All {len(CANDIDATES)} days from {CANDIDATES[0]} to {CANDIDATES[-1]} seat at both delays with their Binance path: no day was dropped.")))
''')

code(r'''
# ---- the engines' own checks, and the cross-checks of this study ----
def run_suite(fn):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        ok = bool(fn())
    rows = [l_.strip() for l_ in buf.getvalue().splitlines() if l_.strip().startswith(("ok", "FAIL"))]
    return ok, [(l_.split(" ", 1)[1].strip(), l_.startswith("ok")) for l_ in rows]

CHECKS = [(f"tf15_bt: {l_}", ok_) for l_, ok_ in B.checks()]
for nm_, fn_ in (("mom15_bt", M.selftest), ("mkb15_mk", X.selftest), ("mkb15_study", S.selftest)):
    ok_, rows_ = run_suite(fn_)
    assert ok_ and all(o_ for _, o_ in rows_), f"{nm_} selftest failed"
    CHECKS += [(f"{nm_}: {l_}", o_) for l_, o_ in rows_]
# the study's own cross-checks: each prints FAIL when the property is false
_src = TWK.TW_CODE_FAMILY
_ns = dict(np=np, M=M, B=B)
exec(_src[_src.index("def tw_arrays"):_src.index("def tw_run")], _ns)
_orig = _ns["tw_gate"](TAB, _ns["tw_arrays"](TAB), sideA, trigA, f"fv>={FV_MARGIN:.2f}", SIG_A)
_r_ = M.run_random_side(TAB, SIG_A, EX, 1000)
_m_ = M.settle(TAB, placebo_side(T["A"], 1000), trigA, EX, SIG_A.lu)
_kt = set(zip(TAB.w_start.tolist(), TAB.w_asset.tolist()))
_kd = set(zip(TABD.w_start.tolist(), TABD.w_asset.tolist()))
LEAK = M.run(TAB, M.Signal(A_L, A_Z, lead=LEAK_S), EX)
LEAK_PER = float(LEAK["net"].mean())
CHECKS += [
    ("the Binance 1 s path equals the decision table's S at every whole second of every window (asserted when the tables are built)", True),
    ("the fair-value gate of test C equals mom15_full_tweaks.tw_gate on every cell", bool(np.array_equal(_orig, trigC))),
    ("the placebo draw of this study equals mom15_bt.run_random_side at the same seed", bool(np.array_equal(_r_["net"], _m_["net"]))),
    ("test D runs mkb15_mk.DEFAULT unchanged on the burst, coins and table of the maker study", bool(T["D"]["o"]["cfg"] == X.DEFAULT)),
    ("every window of the maker's 150 ms table is a window of the taker's 250 ms table", _kd <= _kt),
    (f"a planted leak ({LEAK_S} s of the future in the signal) pays more than the real rule by at least USD {LEAK_MARGIN:g} an entry", bool(LEAK_PER >= T["A"]["s"]["per"] + LEAK_MARGIN)),
]
display(Markdown(f"**Engine and cross-checks** ({len(CHECKS)} in all)\n\n" + pass_table(CHECKS)))
assert all(ok_ for _, ok_ in CHECKS), [l_ for l_, ok_ in CHECKS if not ok_]
VERIFY_PASSED, VERIFY_TOTAL = sum(ok_ for _, ok_ in CHECKS), len(CHECKS)
display(Markdown(f"**The planted leak.** Reading {LEAK_S} s of the future in the signal earns {LEAK_PER:+.2f} USD an entry on {len(LEAK['net']):,} entries against {T['A']['s']['per']:+.2f} for the real rule: the harness sees a leak."))
''')

code(r'''
# ---- the eight invariants, every test ----
INV = {lab_: invariants(lab_) for lab_ in T}
_hdr = "| Invariant | " + " | ".join(T) + " |\n|---|" + "---|" * len(T) + "\n"
_rows = "\n".join("| " + INV["A"][i_][0] + " | " + " | ".join("PASS" if INV[lab_][i_][1] else "FAIL" for lab_ in T) + " |" for i_ in range(len(INV["A"])))
display(Markdown("**Entry invariants, by test**\n\n" + _hdr + _rows))
assert all(ok_ for lab_ in T for _, ok_ in INV[lab_]), "an entry invariant failed"
''')

md(r'''
## S3 · Core result

Four small studies, one a test, each in the S0 to S4 shape, then the four compared. The same window, the same split, the same engine; only the rule differs.
''')

code(r'''
RULE_TXT = dict(
    A=f"a Binance return over {A_L} s of at least {A_Z:g} sigma: buy the near token, the side the burst points to",
    B=f"a Binance move over {B_L} s of at least {B_Z:g} sigma: buy the near token",
    C=f"test A's burst, only when the Brownian fair value of the near token clears its ask by at least {FV_MARGIN:.2f}: buy the near token",
    D=f"test A's burst on {' and '.join(ASSET[i_].upper() for i_ in D_ASSETS)}: rest a post-only bid on the burst's side at the touch")
''')

for lab in LABELS:
    low = lab.lower()
    md(f'''
### Test {lab} · {TITLES[lab]}

#### {lab} · S0 Summary
''')
    code('''
LAB = "@L@"
t_ = T[LAB]
E_, S_, SF_, SS_, TAB_ = t_["e"], t_["s"], t_["sf"], t_["ss"], t_["tab"]
display(Markdown(answer_line(LAB)))
'''.replace("@L@", lab))
    md(f'''
#### {lab} · S1 Setup
''')
    code('''
if t_["kind"] == "taker":
    g_ = t_["trig"]
    params_ = (f"lookback {t_['sig'].L} s, |z| at least {t_['sig'].z:g}" + (f", the fair value clears the ask by at least {FV_MARGIN:.2f}" if LAB == "C" else "") +
               f", no decision in the first {M.KMIN} s or with under {M.TMIN} s left, the fill {FILL_MS} ms after the decision at the ladder then standing (the {FILL_MS} ms table), never above {M.LIMIT}, "
               f"USD {CLIP_USD:g} a trade, one entry a window, held to expiry, the market's own taker fee")
    fires_ = (f"{int(g_.sum()):,} decision seconds pass the rule in {int(g_.any(1).sum()):,} of {TAB_.W:,} windows; after the fill rules (at least {B.MIN_SHARES:g} shares, one entry a window) the test holds {S_['n']:,} entries.")
else:
    c_, o_ = t_["o"]["counts"], t_["o"]
    params_ = (f"lookback {t_['sig'].L} s, |z| at least {t_['sig'].z:g}, {' and '.join(ASSET[i_].upper() for i_ in D_ASSETS)} only, on the {FILL_MS_D} ms table (the maker's table: the post meets the book {FILL_MS_D} ms after the decision), "
               f"`mkb15_mk.DEFAULT` unchanged: " + ", ".join(f"{k_} {v_}" for k_, v_ in X.DEFAULT.items()))
    nb_ = int(t_["trig"].any(1).sum())
    fires_ = (f"{int(t_['trig'].sum()):,} decision seconds pass the burst in {nb_:,} of {TAB_.W:,} windows; the rule posted {c_['posted']:,} orders ({c_['crossed']:,} more rejected as post-only crossings, {c_['no_book']:,} with no book, "
              f"{c_['price_out']:,} priced outside {X.DEFAULT['p_lo']:g} to {X.DEFAULT['p_hi']:g}) and {c_['filled']:,} filled: {len(np.unique(E_['w'])) / max(nb_, 1):.1%} of the windows with a burst had a fill.")
display(Markdown(f"**The rule.** {RULE_TXT[LAB]}.\\n\\n**Parameters.** {params_}.\\n\\n**Where it fires.** {fires_}"))
'''.replace("@L@", lab))
    md(f'''
#### {lab} · S2 Data checks
''')
    code('''
_unit = "fills" if t_["kind"] == "maker" else "entries"
_bycoin = pd.DataFrame([dict(coin=a_.upper(), **{_unit: int((E_["asset"] == ai_).sum()), "windows_with_book": int((TAB_.w_asset == ai_).sum()),
                             "share_of_windows": float((E_["asset"] == ai_).sum() / max((TAB_.w_asset == ai_).sum(), 1)),
                             "mean_seconds_left": float(E_["T"][E_["asset"] == ai_].mean()) if (E_["asset"] == ai_).any() else np.nan,
                             "mean_price_paid": float(E_["vwap"][E_["asset"] == ai_].mean()) if (E_["asset"] == ai_).any() else np.nan}) for ai_, a_ in enumerate(ASSET)])
display(Markdown("**By coin** (a coin outside the test has no windows)"))
display(HTML(_bycoin.round(3).to_html(index=False, border=0)))
display(Markdown("**The eight invariants on this test's entries**\\n\\n" + pass_table(INV[LAB])))
''')
    md(f'''
#### {lab} · S3 Core result
''')
    code('''
_rows = [row(f"whole ({len(DAYS)} days)", S_), row(f"first half ({FIRST_TXT})", SF_), row(f"second half ({SECOND_TXT})", SS_)]
for ai_, a_ in enumerate(ASSET):
    if (E_["asset"] == ai_).any():
        _rows.append(row(a_.upper(), B.summarize(B.subset(E_, E_["asset"] == ai_), TAB_, a_)))
display(HTML(pd.DataFrame(_rows).round(3).to_html(index=False, border=0)))
_wf = t_["wf"].copy()
display(Markdown("**Where the money goes, USD " + ("a fill" if t_["kind"] == "maker" else "an entry") + "** (cluster 95% by 15-minute slot; the edge before friction is the outcome against the book's mid at the decision, "
                 + ("the other terms are the friction)" if t_["kind"] == "maker" else "A and B; C, D and E are the friction)")))
display(HTML(_wf.round(3).to_html(index=False, border=0)))
''')
    if lab == "D":
        code('''
ADV = S.adverse(TAB_, t_["o"])
_adv = pd.DataFrame([dict(read=k_, fill=v_[0], miss=v_[1], fill_minus_miss=v_[2], lo=v_[3], hi=v_[4]) for k_, v_ in ADV.items() if isinstance(v_, tuple)])
_dly = ADV["fill delay, s"]
display(Markdown("**The adverse selection of the fills** (`mkb15_study.adverse`: what an order that filled earned against what the same order earned in the windows where it did not fill, and where the token's mid and Binance went after; "
                 f"95% by 15-minute slot; the median fill came {_dly:.1f} s after the order landed)"))
display(HTML(_adv.round(3).to_html(index=False, border=0)))
_cv = ADV["clip value, USD"]
_m5 = ADV["token mid, +5 s"]
display(Markdown(f"A clip-sized order earned {_cv[0]:+.2f} USD when it filled and {_cv[1]:+.2f} when it did not; fill minus miss {_cv[2]:+.2f} (95% {_cv[3]:+.2f} to {_cv[4]:+.2f}). "
                 f"In the 5 s after the fill the token's mid moved {_m5[0] * 100:+.2f} cents our way against {_m5[1] * 100:+.2f} in the misses: fill minus miss {_m5[2] * 100:+.2f} cents (95% {_m5[3] * 100:+.2f} to {_m5[4] * 100:+.2f})."))
''')
    code('''
figstyle.show(TF.equity_fig(E_, DAYS, question=f"How did test {LAB} build the account, entry by entry?"), "fig:s3-@l@-equity", FIGURES)
'''.replace("@l@", low), f"fig:s3-{low}-equity")
    code('''
figstyle.show(TF.trade_pnl_fig(E_, DAYS, question=f"How much did each entry of test {LAB} make, and when?"), "fig:s3-@l@-tradepnl", FIGURES)
'''.replace("@l@", low), f"fig:s3-{low}-tradepnl")
    code('''
figstyle.show(TF.coin_panels_fig(E_, DAYS, question=f"Does every coin carry test {LAB}'s edge, or one of them?"), "fig:s3-@l@-coins", FIGURES)
'''.replace("@l@", low), f"fig:s3-{low}-coins")
    code('''
figstyle.show(TF.entry_price_fig(E_, DAYS, be=float(S_["breakeven"]), question=f"Do test {LAB}'s entries that won buy cheaper than break-even?", s=14, edge=False), "fig:s3-@l@-entrypx", FIGURES)
'''.replace("@l@", low), f"fig:s3-{low}-entrypx")
    md(f'''
#### {lab} · S4 Robustness

The winners and the losers, by price paid; the ten best and ten worst entries; then the biggest win and the biggest loss with the fill ladder the order met. The placebo, the planted peek and the costs are shared below, in S4.
''')
    code('''
figstyle.show(TF.winloss_fig(E_, DAYS, question=f"What do test {LAB}'s winners and losers look like, and at which prices do they sit?"), "fig:s3-@l@-winloss", FIGURES)
'''.replace("@l@", low), f"fig:s3-{low}-winloss")
    code('''
_ord = np.argsort(E_["net"])
display(Markdown(f"**The {TOP_N} best entries of test {LAB}** (second: the decision second from the window's start; usd_at_risk: the cost)"))
display(HTML(trades_df(t_, _ord[::-1][:TOP_N]).round(3).to_html(index=False, border=0)))
display(Markdown(f"**The {TOP_N} worst entries of test {LAB}**"))
display(HTML(trades_df(t_, _ord[:TOP_N]).round(3).to_html(index=False, border=0)))
''')
    for which_, fn_, word_ in (("win", "argmax", "win make {E_['net'][_i]:+.2f} USD"), ("loss", "argmin", "loss cost {-E_['net'][_i]:.2f} USD")):
        if L2_FIGS:
            code(("""
_i = int(np.@fn@(E_["net"]))
figstyle.show(TF.anatomy_fig(TAB_, E_, _i, DAYS, question=f"Why did test {LAB}'s biggest @word@?", notes=anat_notes(LAB, _i), usd=CLIP_USD), "fig:s3-@l@-big@which@", FIGURES)
_df, _cap = ladder_rows(LAB, _i)
display(Markdown("**" + _cap + "**"))
display(HTML(_df.round(4).to_html(index=False, border=0)))
""").replace("@l@", low).replace("@fn@", fn_).replace("@which@", "win" if which_ == "win" else "loss").replace("@word@", word_), f"fig:s3-{low}-big" + ("win" if which_ == "win" else "loss"))
        else:
            code(("""
_i = int(np.@fn@(E_["net"]))
display(Markdown(f"**Test {LAB}'s biggest @which@, {E_['net'][_i]:+.2f} USD.** " + " ".join(anat_notes(LAB, _i))))
_df, _cap = ladder_rows(LAB, _i)
display(Markdown("**" + _cap + "**"))
display(HTML(_df.round(4).to_html(index=False, border=0)))
""").replace("@fn@", fn_).replace("@which@", which_))
md(r'''
### The tests compared

The four rules on the whole window, on both halves, before and after friction, against a fair-coin side at the same seconds and against a planted peek. Every number is computed above; nothing here is typed.
Edge before friction is the outcome against the book's mid at the decision, in USD an entry (a fill, for D); friction is everything between that mid and the account (the book's move in the delay, the spread and depth walked, the fee; for D, minus the half spread a bid collects and the rebate).
''')

code(r'''
_cmp = []
for k_, t_ in T.items():
    s_, ed_ = t_["s"], t_["edge"]
    _cmp.append(dict(test=k_, what=t_["title"], entries=s_["n"], win_pct=s_["win"] * 100, breakeven_pct=s_["breakeven"] * 100, win_needed_pct=s_["win_needed"] * 100, edge_before_friction=ed_["edge"], friction=ed_["friction"],
                     net_per_entry=s_["per"], net_lo=s_["per_lo"], net_hi=s_["per_hi"], first_half=t_["sf"].get("per", np.nan), second_half=t_["ss"].get("per", np.nan), placebo_p95=t_["p95"], peek=t_["peek"],
                     per_ex_best5=s_["per_ex_top5"], net_usd=s_["net"]))
CMP = pd.DataFrame(_cmp)
display(Markdown(f"**The tests compared, whole window** (USD an entry, a fill for D; net with its 95% interval by 15-minute slot; first half {FIRST_TXT}, second half {SECOND_TXT}; placebo p95 = the 95th percentile of {N_PLACEBO} fair-coin draws at the same seconds; peek = the side that wins at the same seconds)"))
display(HTML(CMP.round(3).to_html(index=False, border=0)))
S0_TABLE.update(Markdown(f"**The tests compared** (USD an entry, a fill for D; {len(DAYS)} days, {DAYS[0]} to {DAYS[-1]}; net with its 95% interval by 15-minute slot; first half {FIRST_TXT}, second half {SECOND_TXT}; placebo p95: 95th percentile of {N_PLACEBO} fair-coin draws; peek: the winning side at the same seconds)\n\n"
    "| Test | Entries | Win % | Break-even % | Edge before friction | Friction | Net (95% by slot) | First half | Second half | Placebo p95 | Peek |\n|---|---|---|---|---|---|---|---|---|---|---|\n"
    + "\n".join(f"| {r.test} {r.what} | {r.entries:,} | {r.win_pct:.1f} | {r.breakeven_pct:.1f} | {r.edge_before_friction:+.3f} | {r.friction:+.3f} | {r.net_per_entry:+.3f} ({r.net_lo:+.2f} to {r.net_hi:+.2f}) | {r.first_half:+.3f} | {r.second_half:+.3f} | {r.placebo_p95:+.3f} | {r.peek:+.2f} |" for r in CMP.itertuples())))
_ms_ = MATCH_STAT
display(Markdown(f"**The resting bid against the taker on the same windows.** On the {_ms_['n']:,} windows where test D filled and test A also entered (of D's {_ms_['n_fills']:,} fills), the resting bid netted {_ms_['maker']:+.3f} USD a window against the taker's {_ms_['taker']:+.3f}: "
                 f"the bid is {'better' if _ms_['diff'] > 0 else 'worse'} by {abs(_ms_['diff']):.3f} (95% by slot {_ms_['diff_ci'][0]:+.2f} to {_ms_['diff_ci'][1]:+.2f} on the paired difference). "
                 f"Test A restricted to BTC and ETH earns {A_BTC_ETH['per']:+.3f} on {A_BTC_ETH['n']:,} entries (95% {A_BTC_ETH['per_lo']:+.2f} to {A_BTC_ETH['per_hi']:+.2f})."))
''')

code(r'''
_pos = [k_ for k_ in T if T[k_]["s"]["per"] > 0]
_clr = [k_ for k_ in T if T[k_]["s"]["per_lo"] > 0]
_edge_pos = [k_ for k_ in T if T[k_]["edge"]["edge_lo"] > 0]
display(Markdown("**What the tests say.** " +
    (f"Net an entry is above zero for {', '.join(_pos)}" if _pos else "No test nets above zero an entry") + (f" and its interval by slot clears zero for {', '.join(_clr)}. " if _clr else "; no interval by slot clears zero. ")
    + (f"The edge before friction is above zero (interval clear of zero) for {', '.join(_edge_pos)}; " if _edge_pos else "No test has an edge before friction with an interval clear of zero; ")
    + "; ".join(f"{k_} earns {T[k_]['edge']['edge']:+.2f} before friction and loses {abs(T[k_]['edge']['friction']):.2f} to it" if T[k_]["edge"]["friction"] < 0 else f"{k_} earns {T[k_]['edge']['edge']:+.2f} before friction and gains {T[k_]['edge']['friction']:.2f} from it" for k_ in T) + ". "
    + "Against the placebo: " + "; ".join(f"{k_} {T[k_]['s']['per']:+.3f} against a 95th percentile of {T[k_]['p95']:+.3f} ({'beaten' if T[k_]['s']['per'] > T[k_]['p95'] else 'not beaten'})" for k_ in T) + "."))
display(Markdown("**By half.** " + "; ".join(f"{k_} {T[k_]['sf'].get('per', float('nan')):+.3f} then {T[k_]['ss'].get('per', float('nan')):+.3f}" for k_ in T) + "."))

CMP_FIG = [dict(label=k_, n=T[k_]["s"]["n"], per=T[k_]["s"]["per"], lo=T[k_]["s"]["per_lo"], hi=T[k_]["s"]["per_hi"], per_first=T[k_]["sf"].get("per", np.nan), per_second=T[k_]["ss"].get("per", np.nan)) for k_ in T]
_notes = ["; ".join(f"{k_} {T[k_]['s']['per']:+.3f} (95% {T[k_]['s']['per_lo']:+.2f} to {T[k_]['s']['per_hi']:+.2f}) on {T[k_]['s']['n']:,}" for k_ in T) + ".",
          f"First half {FIRST_TXT} against second half {SECOND_TXT}: " + "; ".join(f"{k_} {T[k_]['sf'].get('per', float('nan')):+.2f} then {T[k_]['ss'].get('per', float('nan')):+.2f}" for k_ in T) + "."]
figstyle.show(TF.compare_fig(CMP_FIG, DAYS, _notes, question="Which of the four rules pays, and does it pay in both halves of the window?", window=WIN_TXT), "fig:s3-compare", FIGURES)
''', "fig:s3-compare")

code(r'''
def edge_fig(rows, notes):
    N_ = LF.N
    x = np.arange(len(rows))
    net = np.array([r["net"] for r in rows]); lo = np.array([r["lo"] for r in rows]); hi = np.array([r["hi"] for r in rows])
    ed = np.array([r["edge"] for r in rows]); elo = np.array([r["edge_lo"] for r in rows]); ehi = np.array([r["edge_hi"] for r in rows]); fr = np.array([r["friction"] for r in rows])
    fig, (ax,) = LF.frame(4.4, notes, "Where does each test's money go: an edge before friction that survives it, or one the friction takes?", WIN_TXT)
    ax.bar(x, net, width=0.46, color=[LF.GOOD if v >= 0 else LF.BAD for v in net], zorder=3, label="net an entry (bars, 95% by slot)")
    ax.errorbar(x, net, yerr=[net - lo, hi - net], fmt="none", color=N_["ink"], ecolor=N_["ink"], elinewidth=1.1, capsize=4, zorder=4)
    ax.errorbar(x - 0.3, ed, yerr=[ed - elo, ehi - ed], fmt="o", color=N_["ink2"], ecolor=N_["ink2"], capsize=3, ms=6, zorder=5, label="edge before friction (95% by slot)")
    ax.scatter(x + 0.3, fr, marker="s", s=48, color=N_["ink"], zorder=5, label="friction")
    LF.zero(ax)
    ax.set_xticks(x)
    ax.set_xticklabels([r["label"] for r in rows])
    ax.set_ylabel("USD an entry")
    ax.legend(loc="best", fontsize=8, frameon=False)
    return fig

EDGE_ROWS = [dict(label=k_, net=T[k_]["s"]["per"], lo=T[k_]["s"]["per_lo"], hi=T[k_]["s"]["per_hi"], edge=T[k_]["edge"]["edge"], edge_lo=T[k_]["edge"]["edge_lo"], edge_hi=T[k_]["edge"]["edge_hi"], friction=T[k_]["edge"]["friction"]) for k_ in T]
_notes = ["; ".join(f"{r['label']} edge {r['edge']:+.2f} (95% {r['edge_lo']:+.2f} to {r['edge_hi']:+.2f}), friction {r['friction']:+.2f}, net {r['net']:+.2f}" for r in EDGE_ROWS) + ".",
          "Edge before friction is the outcome against the book's mid at the decision; the net is the edge plus the friction, so the bar is the sum of the other two marks."]
figstyle.show(edge_fig(EDGE_ROWS, _notes), "fig:s3-edge", FIGURES)
''', "fig:s3-edge")

code(r'''
RR = [dict(label=k_, win=T[k_]["s"]["win"], win_lo=T[k_]["s"]["win_lo"], win_hi=T[k_]["s"]["win_hi"], win_needed=T[k_]["s"]["win_needed"], rr=T[k_]["s"]["rr"], pf=T[k_]["s"]["pf"], avg_win=T[k_]["s"]["avg_win"],
           avg_loss=T[k_]["s"]["avg_loss"], per=T[k_]["s"]["per"], per_ex_top5=T[k_]["s"]["per_ex_top5"], rr_trade_mean=T[k_]["s"]["rr_trade_mean"]) for k_ in T]
_carried = [r["label"] for r in RR if r["per"] > 0 >= r["per_ex_top5"]]
_notes = ["; ".join(f"{r['label']} wins {r['win']:.1%} and needs {r['win_needed']:.1%}" for r in RR) + ".",
          "; ".join(f"{r['label']} mean win {r['avg_win']:+.2f} against mean loss {r['avg_loss']:+.2f}, reward to risk {r['rr']:.2f}, profit factor {r['pf']:.2f}, each trade's own reward to risk {r['rr_trade_mean']:.2f} on average" for r in RR) + ".",
          "A reward to risk under one is the shape of this market: a winner pays 1 minus the price, a loser the whole price, so a token bought above 0.50 wins small and loses big; the edge is a win rate above the rate that shape needs, and only "
          + (", ".join(r["label"] for r in RR if r["win"] > r["win_needed"]) or "no test") + " has it.",
          "Without the best 5% of entries: " + "; ".join(f"{r['label']} {r['per_ex_top5']:+.3f}" for r in RR) + ". " + (f"A few wins carry everything in {', '.join(_carried)}: the net turns negative once the best 5% are out." if _carried else "Every positive test survives without its best 5%.")]
figstyle.show(TF.winrate_rr_fig(RR, DAYS, _notes, window=WIN_TXT), "fig:s3-winrr", FIGURES)
''', "fig:s3-winrr")

md(r'''
## S4 · Robustness

The four tests against a fair-coin side at the same seconds, against a planted peek, at higher costs and under the count of every rule looked at on the way to them.
''')

md(r'''
**Does each test beat the same trades with no information?** The placebo fires at each test's own seconds on a fair-coin side; the planted peek knows the outcome. A rule that does not beat its placebo is earning the market's drift,
the spread or the fee structure, not the direction; a peek that does not pay far more means the harness cannot see a leak.
''')

code(r'''
def placebo_panels(notes):
    fig, axes = LF.frame(5.8, notes, "Does each test beat the same trades with a fair-coin side?", WIN_TXT, ncols=2, nrows=2, hspace=0.6, wspace=0.16)
    for ax, (k_, t_) in zip(axes, T.items()):
        p_ = t_["pl"][np.isfinite(t_["pl"])]
        ax.hist(p_, bins=20, color=LF.BIN, alpha=0.85, zorder=3)
        ax.axvline(t_["s"]["per"], color=LF.N["ink"], ls=":", lw=1.6, zorder=4)
        ax.axvline(t_["p95"], color=LF.N["ink2"], ls=":", lw=1.2, zorder=4)
        ax.set_title(f"{k_} · {t_['title']}", fontsize=9.5)
        ax.annotate(f" the rule {t_['s']['per']:+.2f}", xy=(t_["s"]["per"], 0.95), xycoords=("data", "axes fraction"), fontsize=8, color=LF.N["ink"], va="top")
        ax.set_xlabel("net USD per " + ("fill" if t_["kind"] == "maker" else "entry"))
        ax.set_ylabel("draws")
    return fig

PEEK = pd.DataFrame([dict(test=k_, rule=t_["s"]["per"], placebo_mean=t_["pl_mean"], placebo_p95=t_["p95"], draws_at_or_above_the_rule=t_["pl_share_ge"], peek=t_["peek"], peek_minus_rule=t_["peek"] - t_["s"]["per"],
                          peek_entries=t_["peek_n"]) for k_, t_ in T.items()])
_notes = ["; ".join(f"{k_}: the rule {t_['s']['per']:+.2f} an entry, {len(t_['pl'])} placebo draws average {t_['pl_mean']:+.2f}, 95th percentile {t_['p95']:+.2f}" for k_, t_ in T.items()) + ".",
          "The planted peek (the same seconds, the side that wins) earns " + "; ".join(f"{k_} {t_['peek']:+.2f} on {t_['peek_n']:,}" for k_, t_ in T.items()) + ": the harness sees a leak in every test.",
          "The ink dotted line is the rule, the grey dotted line the placebo's 95th percentile."]
figstyle.show(placebo_panels(_notes), "fig:s4-placebo", FIGURES)
display(HTML(PEEK.round(3).to_html(index=False, border=0)))
''', "fig:s4-placebo")

md(r'''
**Does it still lose, or win, at twice the fee, a cent worse on every fill, or with another clip? And what does the bid do with a worse queue?**
''')

code(r'''
WANT_D = ("the primary", "no rebate", "twice the queue", "four times the queue", "front of the queue", "no cancel", "a cent inside the touch")
COST = {}
for k_, t_ in T.items():
    rows_ = []
    if t_["kind"] == "taker":
        cases_ = [("as run", {}), (f"fee x{FEE_MULT:g}", dict(fee_mult=FEE_MULT)), (f"a cent worse on every fill", dict(slack=SLACK))] + [(f"clip USD {c_:g}", dict(usd=c_)) for c_ in CLIP_ALT]
        for lab_, kw_ in cases_:
            e_ = M.settle(t_["tab"], t_["side"], t_["trig"], EX, t_["sig"].lu, **kw_)
            rows_.append((lab_, B.summarize(e_, t_["tab"], lab_)))
    else:
        for nm_, cfg_ in S.GRID:
            if nm_ in WANT_D:
                rows_.append((nm_, B.summarize(S.run(t_["tab"], t_["side"], t_["trig"], cfg_)[1], t_["tab"], nm_)))
    COST[k_] = pd.DataFrame([dict(test=k_, case=lab_, n=s_.get("n", 0), win=s_.get("win", np.nan), per=s_.get("per", np.nan), lo=s_.get("per_lo", np.nan), hi=s_.get("per_hi", np.nan), net=s_.get("net", 0.0)) for lab_, s_ in rows_])
COSTS = pd.concat(COST.values(), ignore_index=True)
N_SENS = int(len(COSTS))
display(Markdown("**Cost and fill sensitivity** (net an entry, USD; a taker's cases are the cost table of the earlier notebooks, the bid's are cells of the maker study's own sensitivity grid: read, none chosen)"))
display(HTML(COSTS.round(3).to_html(index=False, border=0)))
COST_OK, COST_MIN = {}, {}
for k_ in T:
    c_ = COST[k_].set_index("case")["per"]
    COST_MIN[k_] = float(c_[[f"fee x{FEE_MULT:g}", "a cent worse on every fill"] if T[k_]["kind"] == "taker" else ["no rebate", "twice the queue"]].min())
    COST_OK[k_] = (bool(c_[f"fee x{FEE_MULT:g}"] > 0 and c_["a cent worse on every fill"] > 0) if T[k_]["kind"] == "taker" else bool(c_["no rebate"] > 0 and c_["twice the queue"] > 0))
''')

md(r'''
**How many rules were looked at on the way to these four, and is the best of them luck?** Each test here is a fixed rule read once. The rules themselves were found or chosen on days inside this window, in earlier notebooks:
the count below charges the deflated Sharpe for all of them (the spread of the cells' Sharpe ratios is the one grid that recorded them, um-012's; the charge is the one the earlier notebooks used, and it is harsh: the grid holds exits whose Sharpe on a few entries is large).
''')

code(r'''
def find_grids():
    for p_ in [Path.cwd(), *Path.cwd().parents]:
        g_ = p_ / "lab" / "predmkts" / "data" / "grids"
        if g_.is_dir():
            return g_
    raise FileNotFoundError("lab/predmkts/data/grids not found above the kernel's cwd")

def read_grid(run):
    return [json.loads(l_) for l_ in (find_grids() / f"{run}.jsonl").read_text(encoding="utf-8").splitlines() if l_.strip()]

G9, G12 = read_grid("um-009"), read_grid("um-012")
N_MOM = len({r_["cell"]["cfg"] for r_ in G9 + G12})
_fam = TWK.TW_CODE_FAMILY
N_BASES = _fam.split("TW_BASES = ")[1].split("\n")[0].count("M.Signal(")
N_GATES = len(ast.literal_eval(_fam.split("TW_GATES = ")[1].split("\nA_X")[0]))
N_FAMILY, N_MAKER, N_HERE = N_BASES * N_GATES, len(S.GRID), len(T)
N_TRIALS = N_MOM + N_FAMILY + N_MAKER + N_HERE
TRIAL_SRS = [r_["sharpe"] for r_ in G12 if r_.get("status") == "kept"]
TRIALS = pd.DataFrame([
    dict(count="the tests of this notebook", what="A, B, C and D, each a fixed rule read once on the whole window", cells=N_HERE),
    dict(count="the parents of A and B", what="the distinct lookback x z x exit cells scored by um-009 and um-012 (the frozen pair and the 180 s choice came out of them)", cells=N_MOM),
    dict(count="the parent of C", what=f"the entry-rule family of um-012's S5: {N_BASES} base signals x {N_GATES} gates (the fair-value gate came out of it)", cells=N_FAMILY),
    dict(count="the parent of D", what="the maker study's sensitivity grid, one thing changed a cell (the BTC and ETH cut was found in its design window)", cells=N_MAKER),
    dict(count="charged to the deflated Sharpe", what="all of the above", cells=N_TRIALS),
    dict(count="read and not charged", what="the cost and fill cells of this S4, none chosen from", cells=N_SENS)])
DSR = {}
for k_, t_ in T.items():
    st_ = TS.sharpe_stats(t_["e"]["net"])
    DSR[k_] = dict(sr=st_["sr"], n=st_["n"], **TS.deflated_sharpe(st_["sr"], st_["n"], st_["skew"], st_["kurt"], TRIAL_SRS, N_TRIALS))
display(Markdown("**Counted trials**"))
display(HTML(TRIALS.to_html(index=False, border=0)))
display(Markdown(f"**Sharpe per entry and its deflation** (per-entry mean over standard deviation, not annualised; SR0 is the Sharpe the best of {N_TRIALS} cells would show by luck, from the spread of {len(TRIAL_SRS)} recorded cell Sharpe ratios)\n\n"
                 "| Test | Entries | Sharpe per entry | SR0 | Probabilistic | Deflated |\n|---|---|---|---|---|---|\n"
                 + "\n".join(f"| {k_} | {d_['n']:,} | {d_['sr']:+.3f} | {d_['sr0']:+.3f} | {d_['psr']:.2f} | {d_['dsr']:.2f} |" for k_, d_ in DSR.items())))
''')

md(r'''
## S5 · Risk and diagnostics

The day-by-day record of each test, the worst day, the deepest drawdown and the most any one entry put at risk.
''')

code(r'''
_notes = [f"{k_}: worst day {DAYS[int(np.argmin(np.bincount(t_['e']['day'], weights=t_['e']['net'], minlength=len(DAYS))))]} at {np.bincount(t_['e']['day'], weights=t_['e']['net'], minlength=len(DAYS)).min():+.0f} USD, "
          f"{int((np.bincount(t_['e']['day'], weights=t_['e']['net'], minlength=len(DAYS)) < 0).sum())} of {len(DAYS)} days lost." for k_, t_ in T.items()]
figstyle.show(TF.daily_fig({k_: t_["e"] for k_, t_ in T.items()}, DAYS, notes=_notes, question="Which days carried each of the four tests, and how bad was the worst?", window=WIN_TXT), "fig:s5-daily", FIGURES)
''', "fig:s5-daily")

code(r'''
_risk = []
for k_, t_ in T.items():
    e_ = t_["e"]
    d_ = np.bincount(e_["day"], weights=e_["net"], minlength=len(DAYS))
    order_ = np.lexsort((e_["asset"], e_["slot"]))
    eq_ = np.cumsum(e_["net"][order_]); peak_ = np.maximum.accumulate(np.concatenate([[0.0], eq_]))[1:]
    _risk.append(dict(test=k_, worst_day_usd=float(d_.min()), worst_day=DAYS[int(np.argmin(d_))], days_lost=int((d_ < 0).sum()), days=len(DAYS), largest_loss_usd=float(e_["net"].min()),
                      max_drawdown_usd=float((peak_ - eq_).max()), max_drawdown_pct_of_book=float((peak_ - eq_).max() / BOOK_USD * 100), max_usd_at_risk_one_entry=float(e_["cost"].max())))
RISK = pd.DataFrame(_risk)
display(HTML(RISK.round(2).to_html(index=False, border=0)))
''')
md(r'''
### Why does test A lose? The diagnosis of the frozen pair

The diagnosis the momentum and full-window notebooks held, read on this window for test A (the frozen um-009 pair), so those notebooks are not needed to read it. One identity does most of the work: for an entry,
net = shares x (won - (price paid + fee) / shares), so the actual win share against the share the price and fee ask IS the net, and it splits into five named terms read on the same entries: what the outcome did
against the fair value (A), what the fair value said against the book's mid at the decision (B), what the book did in the delay to the fill (C), what spread and depth took (D), and the fee (E). A and B together are
the edge before friction; C, D and E are the friction. Nothing is chosen, tuned or re-fitted here. The unit of error is a 15-minute slot (the four coins that start together move together), so every interval and every
test clusters on it; the first half of the window is the discovery sample and the second half the hold-out. Every slice, signal cell and structural cell is counted and corrected for the number of places looked.
''')

code(r'''
import mom15_dx_figs as DF
t0 = time.time()
SEED, N_BOOT, N_PERM, COIN_DRAWS, TOP_K, N_MIN_DX = 7, 4000, 4000, 20, 10, 30
pfmt = lambda p_: "< 0.001" if p_ < 0.001 else f"= {p_:.3f}"
mag = lambda v, d=2: f"{abs(v):,.{d}f}"
LABEL_NAMES = {"coin": "coin", "tod": "UTC block", "vol": "volatility", "timing": "time into the window", "lead": "side against the fair value"}
DX_SIG = SIG_A
HOLD_DAYS = tuple(d_ for d_ in DAYS if _ms(d_) >= CUT_MS)             # the second half: the hold-out of the hunt; the first half is discovery
DX_ROLES = {d_: ("second half" if d_ in HOLD_DAYS else "first half") for d_ in DAYS}
FRM = D.entry_frame(TAB, T["A"]["e"], DX_SIG, DX_ROLES, CUTS)
_by_time = np.where(TAB.w_start[FRM["w"].to_numpy()] < CUT_MS, "first half", "second half")
DX_CHECK = {"half_cut_is_a_day_boundary": bool((_by_time == FRM["role"].to_numpy()).all()),
            "frame_equals_test_A": bool(len(FRM) == T["A"]["s"]["n"] and abs(float(FRM["net"].sum()) - T["A"]["s"]["net"]) < 0.005)}
FRM_1, FRM_2 = FRM[FRM["role"] == "first half"].reset_index(drop=True), FRM[FRM["role"] == "second half"].reset_index(drop=True)
_sh = FRM["shares"].to_numpy()
_tot = ((FRM["won"] - FRM["pu_side"]) + (FRM["pu_side"] - FRM["mid_dec"]) + (FRM["mid_dec"] - FRM["mid_fill"]) + (FRM["mid_fill"] - FRM["vwap"]) - FRM["fee"] / FRM["shares"]) * _sh
DX_DMAX = float(np.abs(_tot - FRM["net"]).max())
_nobid = int(sum(1 for w_, k_, s_ in zip(T["A"]["e"]["w"], T["A"]["e"]["k"], T["A"]["e"]["side"]) if not np.isfinite(B.ladder_of(TAB, np.array([w_]), np.array([k_]), np.array([s_]), buy=False)[0][0, 0])))
DX_CHECK["terms_add_to_net"] = bool(DX_DMAX < 1e-3)
display(Markdown(f"**The frame.** Test A's {len(FRM):,} entries as one row each (the frame of `mom15_diag.entry_frame`), {len(FRM_1):,} in the first half and {len(FRM_2):,} in the second; volatility terciles cut at {CUTS[1][0]:.2f} and {CUTS[1][1]:.2f} times the coin's median sigma, "
                 f"read from every window at one fixed second, never from entries. The five terms add to the net on every entry: the largest difference is {DX_DMAX:.1e} USD. {_nobid} entr{'y' if _nobid == 1 else 'ies'} met a book with no bid at the fill second; the mid there is the best ask, so the half spread is nil. "
                 f"The first half, the second half and the whole window are the same entries test A holds above: {'yes' if all(DX_CHECK.values()) else 'NO, see DX_CHECK'}."))
''')

md(r'''
**Where does the money of an entry go?** The five terms, on each half and on the whole window.
''')

code(r'''
WF_A, WF_1, WF_2 = D.waterfall(FRM), D.waterfall(FRM_1), D.waterfall(FRM_2)
ES_A, ES_1, ES_2 = D.edge_stats(FRM), D.edge_stats(FRM_1), D.edge_stats(FRM_2)
_wa = WF_A.set_index("term")["usd"]
_wf = pd.concat([WF_1.assign(sample=f"first half, {len(FRM_1):,} entries"), WF_2.assign(sample=f"second half, {len(FRM_2):,} entries"), WF_A.assign(sample=f"all {len(DAYS)} days, {len(FRM):,} entries")])[["sample", "term", "what", "usd", "lo", "hi"]]
display(Markdown("**The five terms, USD an entry** (95% by 15-minute slot)"))
display(HTML(_wf.round(3).to_html(index=False, border=0)))
_shares = float(FRM["shares"].mean())
display(Markdown(f"In share terms: a USD {CLIP_USD:g} clip buys {_shares:.1f} shares on average, so the edge of {sgn(ES_A['edge'])} USD is {ES_A['edge'] / _shares * 100:+.1f} points of win share over the book's mid, and the friction of {mag(ES_A['friction'])} USD asks {-ES_A['friction'] / _shares * 100:.1f} points. "
                 f"The pair wins {pct(float(FRM['won'].mean()))} of its entries against a mid of {pct(float(FRM['mid_dec'].mean()))} at the decision, a volume-weighted price of {pct(float(FRM['vwap'].mean()))} and {pct(float(FRM['q'].mean()))} with the fee."))
_bul = [f"First half: the outcome beats the book's mid at the decision by {sgn(ES_1['edge'])} USD an entry (95% {sgn(ES_1['edge_lo'])} to {sgn(ES_1['edge_hi'])}); friction {sgn(ES_1['friction'])}; net {sgn(ES_1['net'])}.",
        f"Second half: edge {sgn(ES_2['edge'])} (95% {sgn(ES_2['edge_lo'])} to {sgn(ES_2['edge_hi'])}), friction {sgn(ES_2['friction'])}, net {sgn(ES_2['net'])}. Whole window: edge {sgn(ES_A['edge'])}, friction {sgn(ES_A['friction'])}: the book's move in the delay {sgn(_wa['C'])}, half spread and depth {sgn(_wa['D'])}, fee {sgn(_wa['E'])}.",
        "Green is a term that adds to the entry, red one that takes from it, the ink bar is the net with its 95% interval over 15-minute slots. A is the outcome against the fair value, B the fair value against the book, C the book's move in the delay."]
figstyle.show(DF.waterfall_fig(WF_1, WF_2, f"first half, {len(FRM_1):,} entries", f"second half, {len(FRM_2):,} entries", WIN_TXT, _bul, question="Where does the money of test A's entry go between the signal and the settlement, in each half?"), "fig:s5-waterfall", FIGURES)
''', "fig:s5-waterfall")

md(r'''
**Where do the losses sit?** The same five terms cut by the labels fixed in `mom15_diag.py` before any slice was read: the coin, the six-hour UTC block, the volatility tercile, the time into the window, and whether the burst points with or against the token the
fair value already favours. The cluster-by-slot Wald test asks whether the net (or the edge before friction) per entry is the same at every level of a label; five labels were tried, so a p must be under 0.01 to count at the 5% level.
''')

code(r'''
ORD = {"coin": list(D.COINS), "tod": list(D.TOD_LABELS), "vol": list(D.VOL_LABELS), "timing": list(D.TIMING_LABELS), "lead": ["with the leader", "against the leader"]}
CL_A = D.clustering(FRM, n_perm=N_PERM, seed=SEED)
WB = {d_: D.waterfall_by(FRM, d_, ORD[d_]) for d_ in D.DIMS}
for d_ in D.DIMS:
    display(Markdown(f"**By {LABEL_NAMES[d_]}, all {len(DAYS)} days, USD an entry.** Wald p of equal net across levels: whole window {CL_A['wald'][d_][2]:.3f}, first half {D.wald_equal_means(FRM_1, d_)[2]:.3f}, second half {D.wald_equal_means(FRM_2, d_)[2]:.3f}; "
                     f"of equal edge before friction: {CL_A['wald_edge'][d_][2]:.3f}"))
    display(HTML(WB[d_].round(3).to_html(index=False, border=0)))
SV_A, WS_A, DY_A = CL_A["slot_var"], CL_A["worst"], CL_A["day"]
display(Markdown(f"**Time clustering.** The nets of one slot are correlated, because the four coins start together and resolve together: the variance of the slot sums is {SV_A['ratio']:.2f} times what a shuffle of the same nets inside each day gives (shuffle p {pfmt(SV_A['p'])}). "
                 f"The worst tenth of slots ({WS_A['slots']} of {WS_A['of']}) holds {pct(WS_A['obs'], 0)} of the total loss against {pct(WS_A['null_mean'], 0)} for a shuffle (p {pfmt(WS_A['p'])}). "
                 f"Between days, the spread of the day means is {'beyond' if DY_A['p'] < 0.05 else 'within'} what a shuffle across days gives (p = {DY_A['p']:.2f}, {DY_A['days']} days)."))
SP = {d_: D.slice_pair(FRM_2, FRM, d_, ORD[d_]) for d_ in D.DIMS}
_split = [LABEL_NAMES[d_] for d_ in D.DIMS if CL_A["wald"][d_][2] < 0.05 / len(D.DIMS)]
_lose = [(r_["test net"], d_, r_[d_]) for d_ in D.DIMS for _, r_ in SP[d_].iterrows() if r_["test n"] >= 30]
_worst = min(_lose) if _lose else (float("nan"), "", "")
_bul = [f"Wald p, equal net per entry across levels, whole window: " + "; ".join(f"{LABEL_NAMES[d_]} {CL_A['wald'][d_][2]:.2f}" for d_ in D.DIMS) + f". Five labels were tried, so a p must be under {0.05 / 5:.2f} to count at the 5% level.",
        f"Largest losing slice in the second half: {_worst[2]} ({sgn(_worst[0])} USD an entry). The intervals are wide: read the dots as colour, the ticks as a second look.",
        f"Dot and whisker: the second half's net per entry with its 95% interval over slots; ink tick: the same level over all {len(DAYS)} days. Green is above zero, red below."]
figstyle.show(DF.clusters_fig([(d_, SP[d_]) for d_ in D.DIMS], WIN_TXT, _bul, names=LABEL_NAMES), "fig:s5-clusters", FIGURES)
''', "fig:s5-clusters")

md(r'''
**Are the losses in line with the probabilities the price implies?** The price paid is the market's probability of the win; the fee is a cost on top. If the actual win share equals the price, the market is calibrated and the loss is the fee and the spread;
if it is below, the burst picks the wrong side; if it is above, there is an edge in the direction.
''')

code(r'''
FRM["band"] = FRM["band"].astype(str); FRM_2["band"] = FRM_2["band"].astype(str); FRM_1["band"] = FRM_1["band"].astype(str)
BANDS = sorted(FRM["band"].unique(), key=lambda s_: float(s_.strip("(]").split(",")[0]))
def fixcal(c_):
    """A Wilson or cluster interval can sit a rounding error inside its own point when every entry of a band won or lost: clip the interval to contain the point, so the figure never draws a negative error."""
    c_ = c_.copy()
    c_["win lo"], c_["win hi"] = np.minimum(c_["win lo"], c_["win"]), np.maximum(c_["win hi"], c_["win"])
    c_["fee pp lo"], c_["fee pp hi"] = np.minimum(c_["fee pp lo"], c_["win - price - fee (pp)"]), np.maximum(c_["fee pp hi"], c_["win - price - fee (pp)"])
    return c_

CAL_A = D.calibration(FRM, "band", order=BANDS)
CAL_2 = D.calibration(FRM_2, "band", order=[b_ for b_ in BANDS if b_ in set(FRM_2["band"])], min_n=1)
CAL_ALL = pd.concat([D.calibration(f_.assign(all="all entries"), "all").assign(sample=nm_) for f_, nm_ in ((FRM_1, "first half"), (FRM_2, "second half"), (FRM, f"all {len(DAYS)} days"))]).drop(columns="all")
display(Markdown("**Actual win share against the price and the fee, by price paid a share, whole window.** `win - price` is the calibration of the market's price at the entry; `win - price - fee` is what is left for the trader. Intervals are 95% by slot."))
display(HTML(CAL_A.round(3).to_html(index=False, border=0)))
display(Markdown("**All entries in one row, by half**")); display(HTML(CAL_ALL.round(3).to_html(index=False, border=0)))
_ca = CAL_ALL[CAL_ALL["sample"].str.startswith("all")].iloc[0]
_bul = [f"Whole window: the burst's side won {pct(_ca['win'])} against {pct(_ca['price'])} paid and {pct(_ca['price + fee'])} with the fee: {sgn(_ca['win - price (pp)'], 1)} points over the price (95% {sgn(_ca['pp lo'], 1)} to {sgn(_ca['pp hi'], 1)}), {sgn(_ca['win - price - fee (pp)'], 1)} after the fee (95% {sgn(_ca['fee pp lo'], 1)} to {sgn(_ca['fee pp hi'], 1)}).",
        f"Left: each dot is a price band, on the diagonal where the win share equals price plus fee. Right: the gap in points, bars for the whole window, ink ticks for the second half; bands with few entries are colour, not numbers."]
figstyle.show(DF.calibration_fig(fixcal(CAL_A), fixcal(CAL_2), f"all {len(DAYS)} days", "second half", WIN_TXT, _bul), "fig:s5-calibration", FIGURES)
''', "fig:s5-calibration")

md(r'''
**Is the burst's direction worth anything beyond buying the favourite?** Three arms at exactly the same firing seconds: the burst's side; the token the fair value already favours; a fair coin (the mean of 20 draws).
''')

code(r'''
FR_ARMS, ARM_SUM = D.arms(TAB, DX_SIG, EX, DX_ROLES, CUTS, seeds=COIN_DRAWS)
AT = D.arm_terms(FR_ARMS)
DIFFS = {"burst minus favourite": D.arm_diff(FR_ARMS["momentum"], FR_ARMS["leader"]), "burst minus a coin": D.arm_diff(FR_ARMS["momentum"], FR_ARMS["coin"], "net_avg"), "favourite minus a coin": D.arm_diff(FR_ARMS["leader"], FR_ARMS["coin"], "net_avg")}
display(Markdown(f"**The three arms, USD an entry, all {len(DAYS)} days**"))
display(HTML(AT.round(3).to_html(index=False, border=0)))
display(Markdown("**Differences in net per entry on the windows both arms entered** (95% by slot)"))
display(HTML(pd.DataFrame(DIFFS).T.round(3).to_html(border=0)))
_dm, _dl, _dc = DIFFS["burst minus favourite"], DIFFS["favourite minus a coin"], DIFFS["burst minus a coin"]
_atx = AT.set_index("arm")
_bul = [f"The burst's side earns an edge of {sgn(_atx.loc['momentum', 'edge'])} USD before friction, the favourite {sgn(_atx.loc['leader', 'edge'])}, a fair coin {sgn(_atx.loc['coin', 'edge'])}; the friction is {sgn(_atx.loc['momentum', 'friction'])}, {sgn(_atx.loc['leader', 'friction'])} and {sgn(_atx.loc['coin', 'friction'])}.",
        f"Burst minus favourite: {sgn(_dm['mean'])} USD an entry (95% {sgn(_dm['lo'])} to {sgn(_dm['hi'])}). The favourite earns {sgn(_dl['mean'])} more than a coin (95% {sgn(_dl['lo'])} to {sgn(_dl['hi'])}), the burst {sgn(_dc['mean'])} more."]
figstyle.show(DF.arms_fig(AT, DIFFS, WIN_TXT, _bul), "fig:s5-arms", FIGURES)
''', "fig:s5-arms")

md(r'''
**Does a slower lookback leave more after the friction?** The same split on each lookback at one threshold (z 2.5), hold to expiry, the edge before friction against the friction and the net; the cells of the earlier grid whole, with the four two-lookback cells,
are scored for the hunt below.
''')

code(r'''
t0 = time.time()
LOOKBACKS_S, Z_GRID, MULTI, SHOW_Z = M.LS, M.ZS, ((1, 60), (10, 60), (10, 300), (60, 300)), 2.5
CELL_FR = {}
for sg_ in [M.Signal(L_, z_) for L_ in LOOKBACKS_S for z_ in Z_GRID] + [M.Signal(a_, 2.0, Ll=b_) for a_, b_ in MULTI]:
    e_ = M.run(TAB, sg_, EX)
    CELL_FR[sg_.name] = D.entry_frame(TAB, e_, sg_, DX_ROLES, CUTS) if len(e_["w"]) else pd.DataFrame()
CT = D.cell_table(CELL_FR)
CTZ = CT[CT["cell"].str.endswith(f"|z{SHOW_Z:g}") & ~CT["cell"].str.contains(r"\+")].reset_index(drop=True)
display(Markdown(f"**Signal cells at z = {SHOW_Z:g}, hold to expiry, all {len(DAYS)} days** ({len(CELL_FR)} cells scored in {time.time() - t0:.0f}s)"))
display(HTML(CTZ.round(3).to_html(index=False, border=0)))
_cz = CTZ.set_index("cell")
display(Markdown("Edge before friction by lookback: " + ", ".join(f"{c_.split('|')[0]} {sgn(r_['edge'])}" for c_, r_ in _cz.iterrows()) + " USD an entry; friction " + ", ".join(f"{c_.split('|')[0]} {sgn(r_['friction'])}" for c_, r_ in _cz.iterrows())
                 + "; net " + ", ".join(f"{c_.split('|')[0]} {sgn(r_['net'])}" for c_, r_ in _cz.iterrows()) + ". "
                 + ("At least one lookback has a net interval wholly above zero." if (_cz["lo"] > 0).any() else "No lookback has a net interval wholly above zero.")))
''')

md(r'''
**Is there an edge in any slice or signal cell, after correcting for the number of places looked?** Every one- and two-label slice of the pair, and every signal cell of the earlier grid whole and cut by coin, is scored once. The t of each is the cluster t of its
net per entry. Three corrections: Holm over every hypothesis, and a slot bootstrap of the maximum t of the whole family under the null of no edge (centred nets, whole slots resampled), which gives the line the best of N reaches by luck alone.
Discovery is the first half of the window; hold-out is the second.
''')

code(r'''
t0 = time.time()
FAM = {"chosen " + DX_SIG.name + " hold": FRM, **{k_: v_ for k_, v_ in CELL_FR.items() if k_ != DX_SIG.name}}      # the pair's own cell is its "all entries" and slices: not a second time
HUNT, HI = D.hunt(FAM, hold_days=HOLD_DAYS, n_boot=N_BOOT, seed=SEED, min_n=N_MIN_DX)
HUNT_BEST = HUNT.iloc[0]
display(Markdown(f"**The twelve highest t among {HI['n_hyp']} hypotheses** ({time.time() - t0:.0f}s; p_raw one-sided; p_holm over all; p_maxt = the share of null bootstrap draws whose best hypothesis reaches this t)"))
display(HTML(HUNT.head(12)[["family", "hypothesis", "entries", "win", "price", "per", "t", "p_raw", "p_holm", "p_maxt", "disc_per", "hold_n", "hold_per"]].round(3).to_html(index=False, border=0)))
SEL, SI = D.selection_check(HUNT, k=TOP_K)
display(Markdown(f"**The {SI['k']} best on the first half, read on the second** ({len(HOLD_DAYS)} days)"))
display(HTML(SEL.round(3).to_html(index=False, border=0)))
_bul = [f"The best of {HI['n_hyp']} is {HUNT_BEST['hypothesis']} (t = {HUNT_BEST['t']:.2f}, raw p = {HUNT_BEST['p_raw']:.3f}); luck alone gives a best t of {HI['expected_best_t']:.2f} on average and {HI['q95_best_t']:.2f} at its 95th percentile. Corrected p of the best: Holm {HUNT_BEST['p_holm']:.2f}, max-t {HUNT_BEST['p_maxt']:.2f}.",
        f"{HI['n_raw_05']} hypotheses have a raw one-sided p under 0.05 (about {0.05 * HI['n_hyp']:.0f} would by luck if none had an edge); {HI['n_holm_05']} survive Holm and {HI['n_maxt_05']} the max-t line. "
        f"The {SI['k']} that looked best on the first half earned {sgn(SI['disc_per'])} USD an entry where they were found and {sgn(SI['hold_per'])} on the second ({pct(SI['hold_share_pos'], 0)} of them above zero); every hypothesis averages {sgn(SI['all_hold_per'])} there.",
        "Each dot is one slice or signal cell, ranked by t; the five highest are ink. The two dotted lines are the t of a single test at the 5% level and the best-of-N line."]
figstyle.show(DF.hunt_fig(HUNT, HI, WIN_TXT, _bul), "fig:s5-hunt", FIGURES)
''', "fig:s5-hunt")

md(r'''
**What does the market do after we buy?** Binance and the token's mid after the entry, in the entry's direction, at one, five and thirty seconds. The book's move over the signal's own lookback against the fair value's move shows how much of the burst the book had already taken at the decision.
''')

code(r'''
FWD, RESP = D.forward(FRM)
display(HTML(FWD.round(3).to_html(index=False, border=0)))
_f = FWD.set_index(["source", "after"])
_dly = float((FRM["mid_dec"] - FRM["mid_fill"]).mean() * 100)
_bul = [f"Binance moves {sgn(_f.loc[('Binance mid', '+1 s'), 'mean'])} bp our way in one second, {sgn(_f.loc[('Binance mid', '+5 s'), 'mean'])} in five and {sgn(_f.loc[('Binance mid', '+30 s'), 'mean'])} in thirty; the token's mid moves {sgn(_f.loc[('token mid', '+1 s'), 'mean'])}, {sgn(_f.loc[('token mid', '+5 s'), 'mean'])} and {sgn(_f.loc[('token mid', '+30 s'), 'mean'])} cents.",
        f"In the signal's own second the book's mid moved {RESP['book_cents']:.2f} cents our way while the fair value moved {RESP['fair_cents']:.2f}: the book had taken {pct(RESP['ratio'], 0)} of the model's reaction by the decision, and the delay to the fill took back a further {_dly:.2f} cents a share on average.",
        f"Bars are means with 95% intervals over slots, green when the market moves our way, all {len(DAYS)} days."]
figstyle.show(DF.drift_fig(FWD, WIN_TXT, _bul), "fig:s5-drift", FIGURES)
''', "fig:s5-drift")

md(r'''
**Is there an edge in the order book itself, with no Binance signal?** The burst is not the only place to look. Here no signal is used and no side is chosen: USD 20 of each token (Up and Down) is bought at the first second of each time-left band whose ladder fills,
held to expiry, on the same exact ladder with the fee. The net per entry by the price paid reads how the book prices a token against how often it pays. The family is the price bands x the time bands and their cuts by coin and by token, counted and corrected as in the hunt above.
''')

code(r'''
t0 = time.time()
SC = D.structural_scan(TAB, DX_SIG, EX, DX_ROLES, CUTS)
CAL_SC = D.calibration(SC, "pband", order=list(D.SCAN_P_LABELS), min_n=30)
SC_2 = SC[SC["role"] == "second half"].reset_index(drop=True)
CAL_SC_2 = D.calibration(SC_2, "pband", order=[b_ for b_ in D.SCAN_P_LABELS if b_ in set(SC_2["pband"])], min_n=1)
HUNT_SC, HI_SC = D.hunt({"chosen scan": SC}, hold_days=HOLD_DAYS, n_boot=N_BOOT, seed=SEED, min_n=N_MIN_DX, dims=("pband", "tband", "coin", "tok"))
PV = SC.pivot_table(index="pband", columns="tband", values="net", aggfunc="mean").reindex(index=list(D.SCAN_P_LABELS), columns=list(D.SCAN_T_LABELS))
PN = SC.pivot_table(index="pband", columns="tband", values="net", aggfunc="size").reindex(index=list(D.SCAN_P_LABELS), columns=list(D.SCAN_T_LABELS)).fillna(0).astype(int)
display(Markdown(f"**Net USD per entry by the price paid (rows) and the time left (columns), all {len(DAYS)} days** ({len(SC):,} entries, {HI_SC['n_hyp']} hypotheses scored in {time.time() - t0:.0f}s)")); display(HTML(PV.round(2).to_html(border=0)))
display(Markdown("**Entries in each cell**")); display(HTML(PN.to_html(border=0)))
display(Markdown("**Win share against price and fee by price band**")); display(HTML(CAL_SC.round(3).to_html(index=False, border=0)))
display(Markdown(f"**The highest t among the {HI_SC['n_hyp']} structural hypotheses**")); display(HTML(HUNT_SC.head(8)[["by", "hypothesis", "entries", "win", "price", "per", "t", "p_raw", "p_holm", "p_maxt", "hold_n", "hold_per"]].round(3).to_html(index=False, border=0)))
_scb = CAL_SC.set_index("pband")
_big = _scb[_scb["entries"] >= 300]
_cheap = _scb.loc["(0.0, 0.1]"] if "(0.0, 0.1]" in _scb.index else None
_pos = int((PV.to_numpy() > 0).sum()); _cells = int(np.isfinite(PV.to_numpy()).sum())
SC_BEST = HUNT_SC.iloc[0]
_bul = [f"No signal: {len(SC):,} first-fill entries of both tokens over {len(DAYS)} days. In every price band of 300 entries or more the win share is within {float(_big['win - price (pp)'].abs().max()):.1f} points of the price paid; the fee and the spread are the whole loss ({_cells - _pos} of {_cells} price x time cells are below zero).",
        f"The best of {HI_SC['n_hyp']} structural hypotheses is {SC_BEST['hypothesis']} (t = {SC_BEST['t']:.2f}, max-t p = {SC_BEST['p_maxt']:.2f}); {HI_SC['n_maxt_05']} survive the best-of-N line of {HI_SC['q95_best_t']:.2f}. Left: every dot is a price band over the whole window (cyan) and the second half (grey); right: the gap after the fee, bars the whole window, ink ticks the second half."]
figstyle.show(DF.calibration_fig(fixcal(CAL_SC), fixcal(CAL_SC_2), f"all {len(DAYS)} days", "second half", WIN_TXT, _bul, question="Does the book price a token as often as it pays, at any price or time left?"), "fig:s5-structure", FIGURES)
''', "fig:s5-structure")

md(r'''
**Does buying near-certain tokens pay?** um-006 BUYS the token that asks at least 0.85 or 0.92 when the fair value clears its ask by a margin theta; it does not short anything. Its recorded out-of-sample point (the earlier week and its test days at a 150 ms fill) was the only positive one of the desk.
The same family is replayed here at the taker's delay on this window and split into the five terms.
''')

code(r'''
NC = {}
for a_lo_ in (0.85, 0.92):
    for th_ in (0.0, 0.02, 0.04):
        NC[(a_lo_, th_)] = D.near_certain(TAB, DX_SIG, EX, DX_ROLES, CUTS, a_lo_, th_)
_rows = []
for (a_lo_, th_), f_ in NC.items():
    es_ = D.edge_stats(f_)
    wf_ = D.waterfall(f_).set_index("term")["usd"]
    _rows.append({"ask at least": a_lo_, "fair value over ask": th_, "entries": len(f_), "win": f_["won"].mean(), "price + fee": f_["q"].mean(), "A": wf_["A"], "B": wf_["B"], "C": wf_["C"], "D": wf_["D"], "E": wf_["E"],
                  "net": es_["net"], "net lo": es_["net_lo"], "net hi": es_["net_hi"], "second-half net": float(f_[f_["role"] == "second half"]["net"].mean()), "second-half n": int((f_["role"] == "second half").sum())})
NCT = pd.DataFrame(_rows)
display(Markdown(f"**The near-certain family on all {len(DAYS)} days, USD an entry** (A fair value's surprise, B model against the book, C the delay, D spread and depth, E fee; net with its 95% interval by slot)"))
display(HTML(NCT.round(3).to_html(index=False, border=0)))
NC_REG = NC[(0.92, 0.04)]
NC_2 = NC_REG[NC_REG["role"] == "second half"].reset_index(drop=True)
WF_NC_2, WF_NC_A = D.waterfall(NC_2), D.waterfall(NC_REG)
ES_NC = D.edge_stats(NC_REG)
_bul = [f"The registered cell of um-006 (ask at least 0.92, fair value over the ask by 0.04) over all {len(DAYS)} days: {ES_NC['n']:,} entries, net {sgn(ES_NC['net'])} USD an entry (95% {sgn(ES_NC['net_lo'])} to {sgn(ES_NC['net_hi'])}); second half {sgn(float(NC_2['net'].mean()))} on {len(NC_2):,}.",
        f"The fair value says the token is worth {sgn(WF_NC_A.set_index('term').loc['B', 'usd'])} USD more than the book's mid; the outcome then lands {sgn(WF_NC_A.set_index('term').loc['A', 'usd'])} against the fair value.",
        "Left panel the second half, right panel the whole window. Green adds to an entry, red takes from it, the ink bar is the net with its 95% interval over slots."]
figstyle.show(DF.waterfall_fig(WF_NC_2, WF_NC_A, f"um-006's cell, second half, {len(NC_2):,} entries", f"um-006's cell, all {len(NC_REG):,} entries", WIN_TXT, _bul, question="Where does the money of the near-certain buy go, and is the fair value's gap real?"), "fig:s5-nearcertain", FIGURES)
''', "fig:s5-nearcertain")

code(r'''
# ---- the diagnosis's answer, from the run's own numbers; each claim of the wording is recorded in STORY, so a window that breaks the story is told here and still builds ----
STORY = {}
_cn = FRM.groupby("coin")["net"].mean()
_ce = WB["coin"].set_index("coin")
STORY["the story needs a positive edge before friction over the window"] = bool(ES_A["edge"] > 0 and ES_A["edge_lo"] > 0)
STORY["the story needs the friction to exceed the edge in both halves"] = bool(ES_1["friction"] < -ES_1["edge"] and ES_2["friction"] < -ES_2["edge"])
STORY["the story needs the burst's side to equal the favourite's"] = bool(_dm["lo"] <= 0 <= _dm["hi"])
STORY["the story needs no hypothesis to survive the correction"] = bool(HI["n_maxt_05"] == 0 and HI["n_holm_05"] == 0)
STORY["the story needs the win share to sit on the price"] = bool(_ca["pp lo"] <= 0 <= _ca["pp hi"])
STORY["the story needs no structural cell and no near-certain edge"] = bool(HI_SC["n_maxt_05"] == 0 and ES_NC["net_lo"] <= 0)
STORY["the story needs the coin to split the nets"] = bool(CL_A["wald"]["coin"][2] < 0.05)
STORY["the story needs the other labels not to split them"] = bool(all(CL_A["wald"][d_][2] > 0.05 for d_ in ("tod", "vol", "timing")))
STORY_FAIL = [k_ for k_, v_ in STORY.items() if not v_]
print("story lines that fail:", STORY_FAIL or "none")
DX_MD = (f"**Why test A loses.** The side the burst picks beats the book's mid at the decision by {sgn(ES_A['edge'])} USD an entry over the window (95% {sgn(ES_A['edge_lo'])} to {sgn(ES_A['edge_hi'])}; first half {sgn(ES_1['edge'])}, second {sgn(ES_2['edge'])}); "
         f"the friction between the decision and the settlement takes {mag(ES_A['friction'])} ({mag(ES_1['friction'])} and {mag(ES_2['friction'])}): the book's move in the delay {mag(_wa['C'])}, spread and depth {mag(_wa['D'])}, the fee {mag(_wa['E'])}. Net {sgn(ES_A['net'])}. "
         f"**Where.** Net by coin: " + ", ".join(f"{c_.upper()} {sgn(_cn[c_])}" for c_ in D.COINS if c_ in _cn.index) + f" (Wald p {CL_A['wald']['coin'][2]:.3f}; edge before friction p {CL_A['wald_edge']['coin'][2]:.3f}); the other labels: "
         + ", ".join(f"{LABEL_NAMES[d_]} {CL_A['wald'][d_][2]:.2f}" for d_ in ("tod", "vol", "timing", "lead")) + f". The slot sums vary {SV_A['ratio']:.2f} times what a shuffle gives, so {len(DAYS)} days of four coins carry fewer independent observations than entries. "
         f"**Probabilities.** The win share is {sgn(_ca['win - price (pp)'], 1)} points over the price paid (95% {sgn(_ca['pp lo'], 1)} to {sgn(_ca['pp hi'], 1)}) and {sgn(_ca['win - price - fee (pp)'], 1)} after the fee. "
         f"**Direction.** Buying the token already ahead at the same seconds nets {sgn(_atx.loc['leader', 'net'])} against the burst's {sgn(_atx.loc['momentum', 'net'])} (burst minus favourite {sgn(_dm['mean'])}, 95% {sgn(_dm['lo'])} to {sgn(_dm['hi'])}). "
         f"**The looks.** Of {HI['n_hyp']} slices and signal cells the best has t = {HUNT_BEST['t']:.2f} against {HI['q95_best_t']:.2f} for the best of {HI['n_hyp']} by luck; {HI['n_maxt_05']} survive; the {SI['k']} best on the first half earn {sgn(SI['hold_per'])} on the second. "
         f"**No signal.** In the structural scan {HI_SC['n_maxt_05']} of {HI_SC['n_hyp']} cells clear the best-of-N line (best t = {SC_BEST['t']:.2f}); the near-certain buy of um-006 nets {sgn(ES_NC['net'])} (95% {sgn(ES_NC['net_lo'])} to {sgn(ES_NC['net_hi'])}, {ES_NC['n']:,} entries). "
         f"**After the entry** Binance moves {sgn(_f.loc[('Binance mid', '+5 s'), 'mean'])} bp and the token's mid {sgn(_f.loc[('token mid', '+5 s'), 'mean'])} cents our way in five seconds. "
         + (f"Story lines this window does not bear out: {'; '.join(STORY_FAIL)}." if STORY_FAIL else "Every story line of the diagnosis holds on this window."))
display(Markdown(DX_MD))
''')

md(r'''
### The maker's forward gate (um-013, registered)

The maker study's forward read was registered as um-013 before any day after the design window was scored: 25 complete days from 2026-10-08, read ONCE by `mkb15_study.ForwardGate` when every one is seated, its gates F1 to F6 fixed. The gate and its code path
are carried here unchanged in rule and numbers (`mkb15_study.forward_read`, `ForwardGate`, `FORWARD_DAYS`). Reading the window's own days is a description and not that read: the gate counts seated days, never the days of this window.
''')

code(r'''
# ---- the rehearsal: the forward code path run once on this window's BTC and ETH days. It proves the code runs and reproduces test D; it is never read as a forward result ----
REH = S.forward_read(TABD, DAYS, n_placebo=20)
REH_OK = bool(REH["n"] == T["D"]["s"]["n"] and abs(REH["summary"]["per"] - T["D"]["s"]["per"]) < 1e-12)
print(f"rehearsal on this window's days (NOT a forward result): {REH['n']:,} fills, {sgn(REH['summary']['per'])} a fill, gates F1..F6 = {[REH['f%d' % i_] for i_ in range(1, 7)]}, verdict {REH['verdict']}; equals test D: {REH_OK}")
assert REH_OK, "the forward code path does not reproduce test D"
GATE = S.ForwardGate(lambda: S.load(S.FORWARD_DAYS), lambda d_: RUNNER.seated(d_, TT.FILL_MS) is not None)
FW_SEATED, FW_TOTAL, _got = GATE.state()
FWD_READ = None
_FG = [("F1", "Forward interval > 0", "the 95% slot interval of net per fill is above zero"), ("F2", "Forward beats coin side", "the 200-draw coin-side placebo is beaten at its 95th percentile"),
       ("F3", "Forward peek pays", f"the planted peek pays {S.PEEK_MARGIN:g} USD a fill more than the rule"), ("F4", "Forward fill rate", f"windows with a fill over windows with a burst between {S.FILL_BAND[0]:.0%} and {S.FILL_BAND[1]:.0%}"),
       ("F5", "Forward holds up", "above zero in both halves, at twice the queue and with no rebate"), ("F6", "Forward adverse repeats", "fill minus miss in the 5 s token mid move is negative with its interval below zero")]
FW_ROWS = []
if GATE.is_open():
    FTAB = GATE.open()
    FWD_READ = S.forward_read(FTAB, S.FORWARD_DAYS)
    _fs = FWD_READ["summary"]
    _mid5 = FWD_READ["adverse"]["token mid, +5 s"]
    display(Markdown(f"**Forward read, opened once.** {FWD_READ['n']:,} fills on {FW_TOTAL} days: {sgn(_fs['per'])} USD a fill (95% by slot {sgn(_fs['per_lo'])} to {sgn(_fs['per_hi'])}); fill rate {pct(FWD_READ['rate'])}; placebo 95th percentile {sgn(FWD_READ['p95'])}; "
                     f"peek {sgn(FWD_READ['peek_per'])}; halves {[round(h_[2], 2) for h_ in FWD_READ['halves']]}; twice the queue {sgn(FWD_READ['q2_per'])}; no rebate {sgn(FWD_READ['norebate_per'])}. Verdict {FWD_READ['verdict']}."))
    _rd = [f"{sgn(_fs['per'])} ({sgn(_fs['per_lo'])} to {sgn(_fs['per_hi'])})", f"{sgn(_fs['per'])} against {sgn(FWD_READ['p95'])}", f"peek {sgn(FWD_READ['peek_per'])} against {sgn(_fs['per'])}", f"{pct(FWD_READ['rate'])}",
           f"halves {[round(h_[2], 2) for h_ in FWD_READ['halves']]}, 2x queue {sgn(FWD_READ['q2_per'])}, no rebate {sgn(FWD_READ['norebate_per'])}", f"{sgn(_mid5[2] * 100)} cents ({sgn(_mid5[3] * 100)} to {sgn(_mid5[4] * 100)})"]
    _ok = [FWD_READ["f1"], FWD_READ["f2"], FWD_READ["f3"], FWD_READ["f4"], FWD_READ["f5"], None]
    for (fid_, lab_, nm_), rd_, ok_ in zip(_FG, _rd, _ok):
        FW_ROWS.append(dict(fid=fid_, label=lab_, name=nm_, reading=rd_, verdict=("INFO" if ok_ is None else "PASS" if ok_ else "FAIL")))
else:
    display(Markdown(f"**The forward read is not opened:** {FW_SEATED} of {FW_TOTAL} forward days are seated ({S.FORWARD_FROM} to {S.FORWARD_DAYS[-1]}; seated so far: {', '.join(d_[5:] for d_ in _got) or 'none'}). It opens once, when every one is; "
                     f"a later run of this notebook then reads the same fixed days, a determinism check and never a replication. Gates F1 to F6 of um-013 read N/A until then. "
                     f"The rehearsal above ran the same code path on this window's {len(DAYS)} days and reproduces test D's {REH['n']:,} fills and {sgn(REH['summary']['per'])} USD a fill."))
    for fid_, lab_, nm_ in _FG:
        FW_ROWS.append(dict(fid=fid_, label=lab_, name=nm_, reading=f"not opened: {FW_SEATED} of {FW_TOTAL} days seated", verdict="N/A"))
''')
md(r'''
## S6 · Decision

The decision rule reads the gates: a test is sized only if it passes every one of its seven; otherwise the rung prints as information only.
''')

code(r'''
# ---- the gates: one list, read by the decision rule, the verdict, the card and the manifest ----
GATES, GID = [], {}
_q = lambda xs: ', '.join(f"'{x}'" for x in xs)

def gate(key, sec, label, name, reading, ok, would_change, verdict=None):
    assert len(label) <= REPORT.MAX_GATE_LABEL, label
    GATES.append(dict(id=f"G{len(GATES) + 1}", section=sec, label=label, name=name, reading=reading, verdict=verdict or ("PASS" if ok else "FAIL"), would_change=would_change))
    GID[key] = GATES[-1]["id"]

gate("cover", "S2", "Windows have a book", "at least 90% of the window's markets have a book by the first decision second", f"{SHARE:.1%} of {int(COV.windows.sum()):,} windows", SHARE >= 0.9, "a share under 90%")
gate("checks", "S2", "Engine checks hold", "every engine check, cross-check and entry invariant passes", f"{VERIFY_PASSED} of {VERIFY_TOTAL} checks; {sum(ok_ for lab_ in T for _, ok_ in INV[lab_])} of {sum(len(INV[lab_]) for lab_ in T)} invariants", True, "one check failing")
gate("leak", "S2", "Planted leak caught", f"a signal that reads {LEAK_S} s of the future pays at least USD {LEAK_MARGIN:g} an entry more than the real rule", f"{LEAK_PER:+.2f} against {T['A']['s']['per']:+.2f}", LEAK_PER >= T["A"]["s"]["per"] + LEAK_MARGIN, "a leak that does not show")
for k_, t_ in T.items():
    s_, d_ = t_["s"], DSR[k_]
    unit_ = "fill" if t_["kind"] == "maker" else "entry"
    gate((k_, "zero"), "S3", f"{k_}: clears zero", f"test {k_}'s net a {unit_} has a 95% interval by 15-minute slot above zero on the whole window", f"{s_['per']:+.3f} USD ({s_['per_lo']:+.2f} to {s_['per_hi']:+.2f}) on {s_['n']:,}", s_["per_lo"] > 0, "an interval whose lower end crosses zero")
    gate((k_, "placebo"), "S4", f"{k_}: beats placebo", f"test {k_}'s net a {unit_} is above the 95th percentile of {len(t_['pl'])} fair-coin draws at the same seconds", f"{s_['per']:+.3f} against {t_['p95']:+.3f}", s_["per"] > t_["p95"], "a placebo draw at or above the rule")
    gate((k_, "halves"), "S4", f"{k_}: both halves", f"test {k_}'s net a {unit_} is above zero in the first and in the second half of the window", f"{t_['sf'].get('per', float('nan')):+.3f} then {t_['ss'].get('per', float('nan')):+.3f}", t_["sf"].get("per", -1) > 0 and t_["ss"].get("per", -1) > 0, "a half below zero")
    gate((k_, "tail"), "S4", f"{k_}: without best 5%", f"test {k_}'s net a {unit_} stays above zero with its best 5% of entries taken out (a few wins must not carry everything)", f"{s_['per_ex_top5']:+.3f} USD; {s_['top5_share'] * 100:.0f}% of the net sits in the best 5%" if np.isfinite(s_["top5_share"]) else f"{s_['per_ex_top5']:+.3f} USD", s_["per_ex_top5"] > 0, "a net above zero once the best 5% are out")
    cs_ = COST[k_].set_index("case")["per"]
    cost_txt = (f"fee x{FEE_MULT:g} {cs_[f'fee x{FEE_MULT:g}']:+.3f}, a cent worse {cs_['a cent worse on every fill']:+.3f}" if t_["kind"] == "taker" else f"no rebate {cs_['no rebate']:+.3f}, twice the queue {cs_['twice the queue']:+.3f}")
    gate((k_, "cost"), "S4", f"{k_}: survives costs", f"test {k_}'s net a {unit_} stays above zero " + (f"at twice the fee and a cent worse on every fill" if t_["kind"] == "taker" else "with no rebate and at twice the queue ahead"), cost_txt, COST_OK[k_], "a cost case below zero")
    gate((k_, "dsr"), "S4", f"{k_}: deflated Sharpe", f"the deflated Sharpe of test {k_}, charged for {N_TRIALS} counted cells, is at least 0.90", f"deflated {d_['dsr']:.2f} (per-entry Sharpe {d_['sr']:+.3f}, SR0 {d_['sr0']:+.3f})", bool(d_["dsr"] == d_["dsr"] and d_["dsr"] >= 0.9), "a Sharpe within the luck of the best of N")
    gate((k_, "peek"), "S4", f"{k_}: peek caught", f"the planted peek pays at least USD {PEEK_MARGIN:g} a {unit_} more than test {k_}", f"{t_['peek']:+.2f} against {s_['per']:+.2f}", t_["peek"] >= s_["per"] + PEEK_MARGIN, "a peek that does not pay more")
gate("dx_terms", "S5", "Terms add to the net", "A + B + C + D + E equals the net on every entry of test A, and the frame is test A's entries", f"largest difference {DX_DMAX:.1e} USD on {len(FRM):,} entries; frame equals test A: {DX_CHECK['frame_equals_test_A']}", all(DX_CHECK.values()), "a term left out")
gate("dx_edge", "S5", "Edge exceeds friction", "test A's net, the edge before friction minus the friction, has a 95% interval above zero", f"edge {sgn(ES_A['edge'])}, friction {sgn(ES_A['friction'])}, net {sgn(ES_A['net'])} USD ({sgn(ES_A['net_lo'])} to {sgn(ES_A['net_hi'])})", ES_A["net_lo"] > 0, "an interval wholly above zero")
gate("dx_cal", "S5", "Win clears price + fee", "the actual win share exceeds the share the price and fee ask, with a 95% interval above zero", f"{sgn(_ca['win - price - fee (pp)'], 1)} points ({sgn(_ca['fee pp lo'], 1)} to {sgn(_ca['fee pp hi'], 1)}); over the price alone {sgn(_ca['win - price (pp)'], 1)}", bool(_ca["fee pp lo"] > 0), "an interval wholly above zero")
gate("dx_arm", "S5", "Burst beats favourite", "the burst's side nets more per entry than buying the token already ahead at the same seconds, with a 95% interval above zero", f"{sgn(_dm['mean'])} USD an entry ({sgn(_dm['lo'])} to {sgn(_dm['hi'])}); the favourite beats a coin by {sgn(_dl['mean'])}", bool(_dm["lo"] > 0), "an interval wholly above zero")
gate("dx_hunt", "S5", "A slice clears best-of-N", "some slice or signal cell has a max-t p under 0.05 across every hypothesis scored", f"best t {HUNT_BEST['t']:.2f} against the {HI['q95_best_t']:.2f} line; {HI['n_maxt_05']} of {HI['n_hyp']} survive", HI["n_maxt_05"] > 0, "a hypothesis above the line")
gate("dx_hold", "S5", "Best slices hold out", "the ten best slices of the first half earn above zero on the second half", f"{sgn(SI['disc_per'])} where found, {sgn(SI['hold_per'])} on the second half; baseline {sgn(SI['all_hold_per'])}", bool(SI["hold_per"] > 0), "selected slices that keep their level")
gate("dx_sc", "S5", "A structural cell clears", "some price x time-left cell, or its cut by coin or token, has a max-t p under 0.05 across every structural hypothesis", f"best t {SC_BEST['t']:.2f} against the {HI_SC['q95_best_t']:.2f} line; {HI_SC['n_maxt_05']} of {HI_SC['n_hyp']} survive", HI_SC["n_maxt_05"] > 0, "a structural cell above the line")
gate("dx_nc", "S5", "Near-certain buy pays", "um-006's registered cell nets above zero over the window, with a 95% interval above zero", f"{sgn(ES_NC['net'])} USD an entry ({sgn(ES_NC['net_lo'])} to {sgn(ES_NC['net_hi'])}) on {ES_NC['n']:,} entries", bool(ES_NC["net_lo"] > 0), "an interval wholly above zero")
for r_ in FW_ROWS:
    gate(("fw", r_["fid"]), "S5", r_["label"], r_["name"], r_["reading"], False, f"registered as {r_['fid']} of um-013", verdict=r_["verdict"])
CORE = {k_: [GID[(k_, w_)] for w_ in ("zero", "placebo", "halves", "tail", "cost", "dsr", "peek")] for k_ in T}
GV = {g_["id"]: g_["verdict"] for g_ in GATES}
for k_, t_ in T.items():
    t_["fails"] = [g_["label"].split(": ")[1] for g_ in GATES if g_["id"] in CORE[k_] and g_["verdict"] != "PASS"]
    t_["word"] = "MONEY" if not t_["fails"] else "NO MONEY"
    t_["cls"] = "A" if not t_["fails"] else ("B" if t_["s"]["per"] > 0 else "C")
SIZED = any(t_["word"] == "MONEY" for t_ in T.values())
BEST = max(T, key=lambda k_: T[k_]["s"]["per"])
gate("sized", "S6", "Sized only if passed", "a test is sized only if it passes every gate of S3 and S4", ("1x on " + ", ".join(k_ for k_ in T if T[k_]["word"] == "MONEY")) if SIZED else f"NO SIZE: test {BEST} {T[BEST]['s']['per']:+.3f} USD", SIZED, "a test passing all seven gates")
GV = {g_["id"]: g_["verdict"] for g_ in GATES}
for g_ in GATES:
    assert g_["verdict"] in REPORT.GATE_VERDICTS, g_
assert len({g_["id"] for g_ in GATES}) == len(GATES)
_bs = T[BEST]["s"]
DECISION_MD = ("**" + ("Size: 1x, USD " + f"{CLIP_USD:g} a trade, on " + ", ".join(k_ for k_ in T if T[k_]["word"] == "MONEY") if SIZED else "No size") + ".** " +
               (f"Test {', '.join(k_ for k_ in T if T[k_]['word'] == 'MONEY')} passes all seven gates of S3 and S4. " if SIZED else "No test passes all seven gates of S3 and S4. ") +
               f"The strongest is test {BEST} ({T[BEST]['title']}): {_bs['per']:+.3f} USD per {'fill' if T[BEST]['kind'] == 'maker' else 'entry'} (95% by slot {_bs['per_lo']:+.2f} to {_bs['per_hi']:+.2f}) on {_bs['n']:,}, and it "
               + ("passes every gate. " if not T[BEST]["fails"] else f"fails the gates {_q(T[BEST]['fails'])}. ") +
               "Each test: " + "; ".join(f"{k_} {T[k_]['word']}, class {T[k_]['cls']}" + (f" (fails {_q(T[k_]['fails'])})" if T[k_]["fails"] else "") for k_ in T) + ". "
               "A size waits for days this window did not see, read once with the rule frozen as it stands here; the forward days from 2026-10-11 seat as the daily tables are built.")
display(Markdown(DECISION_MD))
''')

md(r'''
## S7 · Verdict
''')

code(r'''
WORD = "1x" if SIZED else "NO SIZE"
CLASS = "A" if SIZED else ("B" if any(t_["cls"] == "B" for t_ in T.values()) else "C")
VERDICT_TABLE = pd.DataFrame([dict(test=k_, rule=t_["title"], verdict=f"{t_['word']}, class {t_['cls']}", net_per_entry=t_["s"]["per"], lo=t_["s"]["per_lo"], hi=t_["s"]["per_hi"], gates_failed=", ".join(t_["fails"]) or "none") for k_, t_ in T.items()])
display(Markdown("**The verdict of each test**"))
display(HTML(VERDICT_TABLE.round(3).to_html(index=False, border=0)))
_a, _d = T["A"], T["D"]
_per_test = " ".join(f"Test {k_} ({t_['title']}): {t_['s']['n']:,} {'fills' if t_['kind'] == 'maker' else 'entries'}, win {t_['s']['win']*100:.1f}% against {t_['s']['breakeven']*100:.1f}% to break even, net {t_['s']['per']:+.3f} USD an entry "
                     f"(95% by slot {t_['s']['per_lo']:+.2f} to {t_['s']['per_hi']:+.2f}), {t_['word']} class {t_['cls']}" + (f", failing the gates {_q(t_['fails'])}." if t_["fails"] else ".") for k_, t_ in T.items())
_peeks = ", ".join(f"{k_} {T[k_]['peek']:+.1f}" for k_ in T)
_p95s = ", ".join(f"{k_} {T[k_]['p95']:+.2f}" for k_ in T)
_dsrs = ", ".join(f"{k_} {DSR[k_]['dsr']:.2f}" for k_ in T)
_lead = (f"**The answer: {'MONEY' if SIZED else 'NO MONEY'}, class {CLASS}.** Over {len(DAYS)} days ({DAYS[0]} to {DAYS[-1]}, {HOURS:,} hours, one regime) "
         + (f"test {', '.join(k_ for k_ in T if T[k_]['word'] == 'MONEY')} passes every gate. " if SIZED else "none of the four fixed rules passes every gate. "))
HEADLINE_MD = (_lead + _per_test + f" The edge before friction is {_a['edge']['edge']:+.2f} for A and {_d['edge']['edge']:+.2f} for D, the friction {_a['edge']['friction']:+.2f} and {_d['edge']['friction']:+.2f}. "
               f"The planted peeks pay {_peeks} an entry, so the harness sees a leak; the placebo 95th percentiles are {_p95s}. "
               f"On the {MATCH_STAT['n']:,} windows both entered, the resting bid nets {MATCH_STAT['maker']:+.3f} against the taker's {MATCH_STAT['taker']:+.3f}. "
               f"{N_TRIALS} rules were looked at on the way to these four; the deflated Sharpe after that charge is {_dsrs}.")
HEADLINE_MD += (f" **Why test A loses.** The edge before friction is {sgn(ES_A['edge'])} USD an entry and the friction {sgn(ES_A['friction'])}; {HI['n_maxt_05']} of {HI['n_hyp']} slices and signal cells clear the best-of-N line "
                f"(best t {HUNT_BEST['t']:.2f} against {HI['q95_best_t']:.2f}); {HI_SC['n_maxt_05']} of {HI_SC['n_hyp']} structural cells clear theirs; the near-certain buy of um-006 nets {sgn(ES_NC['net'])}. "
                f"**Maker forward gate (um-013).** {FW_SEATED} of {FW_TOTAL} forward days seated: " + ("not opened, gates F1 to F6 N/A." if FWD_READ is None else f"opened, verdict {FWD_READ['verdict']}."))
display(Markdown(HEADLINE_MD))
S0_ANS.update(Markdown(HEADLINE_MD))
''')

code(r'''
display(Markdown("**Gates**\n\n| Id | Section | Gate | Reading | Verdict |\n|---|---|---|---|---|\n" + "\n".join(f"| {g_['id']} | {g_['section']} | {g_['label']} | {g_['reading']} | **{g_['verdict']}** |" for g_ in GATES)))
RESULT_LINES = [f"RESULT four-tests {k_}_entries={T[k_]['s']['n']}" for k_ in T] + [f"RESULT four-tests {k_}_net_per_entry_usd={T[k_]['s']['per']:.4f}" for k_ in T] \
    + [f"RESULT four-tests {k_}_edge_before_friction_usd={T[k_]['edge']['edge']:.4f}" for k_ in T] + [f"RESULT four-tests {k_}_placebo_p95_usd={T[k_]['p95']:.4f}" for k_ in T] + [f"RESULT four-tests {k_}_peek_usd={T[k_]['peek']:.4f}" for k_ in T]
print("\n".join(RESULT_LINES))
''')

code(r'''
# ---- the card, the metrics and the verdict (the best test is the headline) ----
_cut = lambda s_, n_: s_ if len(s_) <= n_ else s_[: n_ - 1].rstrip() + "."
mk = lambda metric, value, bar="", verdict="", gate=None: {"metric": metric, "value": value, "bar": bar, "verdict": GV[gate] if gate else verdict, **({"gate": gate} if gate else {})}
TB = T[BEST]
E_BEST, S_BEST, TAB_BEST = TB["e"], TB["s"], TB["tab"]
_o = np.lexsort((E_BEST["asset"], E_BEST["slot"]))                       # time order: the equity line and the drawdown read the entries as they came
_net_o = E_BEST["net"][_o]
_eq = np.cumsum(_net_o)
_peak = np.maximum.accumulate(np.concatenate([[0.0], _eq]))[1:]
_max_dd = float((_peak - _eq).max())
_wins, _loss = E_BEST["net"][E_BEST["net"] > 0], E_BEST["net"][E_BEST["net"] <= 0]
PF = float(_wins.sum() / abs(_loss.sum())) if len(_loss) and _loss.sum() != 0 else None
WLR = float(_wins.mean() / abs(_loss.mean())) if len(_wins) and len(_loss) else None
_dly = np.bincount(E_BEST["day"], weights=E_BEST["net"], minlength=len(DAYS))
_slot_sh = B.slot_sharpe(E_BEST, TAB_BEST)
_hold_h = float(np.mean(B.WIN_S - (E_BEST["t_fill"] / 1000.0)) / 3600.0) if TB["kind"] == "maker" else float(np.mean(E_BEST["T"]) / 3600.0)
METRICS = {"ann_return_pct": None, "excess_vs_hurdle_pct": None, "ann_vol_pct": None, "sharpe": (None if _slot_sh != _slot_sh else float(_slot_sh)), "sortino": None, "calmar": None, "psr": float(DSR[BEST]["psr"]), "dsr": float(DSR[BEST]["dsr"]),
           "max_dd_pct": _max_dd / BOOK_USD * 100, "max_dd_days": float(len(DAYS)), "n_periods": float(len(DAYS) * 96), "periods_per_year": 96.0 * 365.0,
           "total_return_pct": float(S_BEST["net"] / BOOK_USD * 100), "n_trades": float(S_BEST["n"]), "trades_per_day": float(S_BEST["n"] / len(DAYS)), "hit_rate_pct": float(S_BEST["win"] * 100),
           "profit_factor": PF, "expectancy_bps": float(S_BEST["per"] / CLIP_USD * 1e4), "win_loss_ratio": WLR, "avg_hold_h": _hold_h, "exposure_pct": None,
           "turnover_ann": float(E_BEST["cost"].sum() / len(DAYS) * 365 / BOOK_USD), "fees_pct_of_gross": (float(E_BEST["fee"].sum() / abs(E_BEST["gross"].sum()) * 100) if E_BEST["gross"].sum() else None),
           "worst_period_pct": float(_dly.min() / BOOK_USD * 100), "gross_edge_bps": float(S_BEST["gross_per"] / CLIP_USD * 1e4), "cost_bps": float(S_BEST["fee_per"] / CLIP_USD * 1e4),
           "breakeven_cost_bps": float(S_BEST["gross_per"] / CLIP_USD * 1e4), "capacity_usd": None, "beta_to_underlying": None}
NA = {"ann_return_pct": f"{len(DAYS)} days of one regime: an annualised return is not meaningful", "excess_vs_hurdle_pct": "no hurdle on a fixed rule", "ann_vol_pct": f"{len(DAYS)} days: an annualised volatility is not meaningful",
      "sortino": "not computed on a fixed rule", "calmar": "not meaningful on one regime", "exposure_pct": "exposure over the window was not tracked per second", "capacity_usd": "the ladder depth beyond four levels is not kept",
      "beta_to_underlying": "a binary payoff on Up or Down: no single underlying beta"}
for k_, v_ in list(METRICS.items()):
    if v_ is None or (isinstance(v_, float) and not math.isfinite(v_)):
        METRICS[k_] = None
        NA.setdefault(k_, "no loss or no entry in the window")
_nm = [k_ for k_ in T if T[k_]["word"] == "MONEY"]
VERDICT = {"word": WORD, "why": [_cut(f"test {BEST} is the strongest: {S_BEST['per']:+.3f} USD an entry, 95% by slot {S_BEST['per_lo']:+.2f} to {S_BEST['per_hi']:+.2f}, on {S_BEST['n']:,}", 110),
                                 _cut(f"{len(_nm)} of {len(T)} tests pass every gate; the failures: " + "; ".join(f"{k_} {', '.join(T[k_]['fails']) or 'none'}" for k_ in T), 110) if not SIZED else _cut(f"test {', '.join(_nm)} passes every gate", 110),
                                 _cut(f"edge before friction A {T['A']['edge']['edge']:+.2f}, B {T['B']['edge']['edge']:+.2f}, C {T['C']['edge']['edge']:+.2f}, D {T['D']['edge']['edge']:+.2f} a fill or entry", 110)],
           "next_bet": _cut("the forward days from 2026-10-11 as the daily tables seat, read once with the four rules frozen as they stand; um-013's own forward gate opens at its 25 days", 150)}
_big = []
for k_, t_ in T.items():
    _big.append(dict(mk(f"Net an entry, {k_}", f"{sgn(t_['s']['per'])} USD", f"95% {sgn(t_['s']['per_lo'])} to {sgn(t_['s']['per_hi'])}", gate=GID[(k_, "zero")]), scope="whole"))
_blocks = [
    {"title": "Edge before friction", "rows": [mk(f"Edge before friction, {k_}", f"{sgn(t_['edge']['edge'])} USD", f"95% {sgn(t_['edge']['edge_lo'])} to {sgn(t_['edge']['edge_hi'])}", "INFO") for k_, t_ in T.items()]
                                           + [mk(f"Friction, {k_}", f"{sgn(t_['edge']['friction'])} USD", "", "INFO") for k_, t_ in T.items()]},
    {"title": "Is it real", "rows": [mk(f"Placebo 95th pct, {k_}", sgn(t_["p95"]), "below the rule", gate=GID[(k_, "placebo")]) for k_, t_ in T.items()]
                                   + [mk(f"Planted peek, {k_}", sgn(t_["peek"]), "pays more", gate=GID[(k_, "peek")]) for k_, t_ in T.items()]},
    {"title": "Halves and the tail", "rows": [mk(f"First and second half, {k_}", f"{sgn(t_['sf'].get('per', float('nan')))} / {sgn(t_['ss'].get('per', float('nan')))}", "both above 0", gate=GID[(k_, "halves")]) for k_, t_ in T.items()]
                                            + [mk(f"Without best 5%, {k_}", sgn(t_["s"]["per_ex_top5"]), "above 0", gate=GID[(k_, "tail")]) for k_, t_ in T.items()]},
    {"title": "Costs and Sharpe", "rows": [mk(f"Cost cases, {k_}", sgn(COST_MIN[k_]), "above 0", gate=GID[(k_, "cost")]) for k_ in T]
                                  + [mk(f"Deflated Sharpe, {k_}", f"{DSR[k_]['dsr']:.2f}", "at least 0.90", gate=GID[(k_, "dsr")]) for k_ in T]},
    {"title": "Why test A loses", "rows": [mk("Win minus price and fee", f"{sgn(_ca['win - price - fee (pp)'], 1)} pt", f"95% {sgn(_ca['fee pp lo'], 1)} to {sgn(_ca['fee pp hi'], 1)}", gate=GID["dx_cal"]),
                                           mk("Burst minus favourite", f"{sgn(_dm['mean'])} USD", f"95% {sgn(_dm['lo'])} to {sgn(_dm['hi'])}", gate=GID["dx_arm"]),
                                           mk("Best t against best-of-N", f"{HUNT_BEST['t']:.2f} / {HI['q95_best_t']:.2f}", f"{HI['n_maxt_05']} of {HI['n_hyp']} survive", gate=GID["dx_hunt"]),
                                           mk("Ten best, first then second half", f"{sgn(SI['disc_per'])} / {sgn(SI['hold_per'])}", "USD an entry", gate=GID["dx_hold"]),
                                           mk("Structural cells surviving", f"{HI_SC['n_maxt_05']} of {HI_SC['n_hyp']}", "", gate=GID["dx_sc"]),
                                           mk("Near-certain buy", f"{sgn(ES_NC['net'])} USD", f"95% {sgn(ES_NC['net_lo'])} to {sgn(ES_NC['net_hi'])}", gate=GID["dx_nc"])]},
    {"title": "Maker forward gate (um-013)", "rows": [mk("Forward days seated", f"{FW_SEATED} of {FW_TOTAL}", "all", "INFO"), mk("Gates F1 to F6", "N/A" if FWD_READ is None else "read", "all 25 days", "INFO")]},
    {"title": "Checks", "rows": [mk("Windows with a book", pct(SHARE, 0), "90% bar", gate=GID["cover"]), mk("Engine checks held", f"{VERIFY_PASSED} of {VERIFY_TOTAL}", "all", gate=GID["checks"]), mk("Planted leak", f"{LEAK_PER:+.2f} USD", "pays more", gate=GID["leak"]), mk("Terms add to the net", f"{DX_DMAX:.0e} USD", "under 1e-3", gate=GID["dx_terms"]),
                                   mk("Counted cells charged", f"{N_TRIALS}", "", "INFO")]}]
CARD = {
    "question": _cut("Does buying the 15m Up/Down token after a Binance burst earn after fees, as a taker or as a resting bid?", 200),
    "answer": _cut(f"{WORD}. Best is test {BEST}: {sgn(S_BEST['per'])} USD an entry (95% {sgn(S_BEST['per_lo'])} to {sgn(S_BEST['per_hi'])}) on {S_BEST['n']:,}; {len(_nm)} of {len(T)} tests pass every gate.", 240),
    "implementation": [("Trade", "Buy the near token after a Binance burst, hold to expiry"), ("Venue", "Polymarket 15m crypto Up/Down; Binance is input"),
                      ("Rules", _cut(f"A {A_L} s z{A_Z:g}, B {B_L} s z{B_Z:g}, C A plus fair-value gate, D A as a bid", 70)), ("Size", f"{usd(CLIP_USD)} a trade, {usd(BOOK_USD)} book, 1x"),
                      ("Costs", _cut(f"taker fee, +{FILL_MS} ms; bid rebate {X.REBATE:.0%}, {FILL_MS_D} ms", 70)), ("Window", f"{DAYS[0][5:]} to {DAYS[-1][5:]}, {HOURS}h, 1 regime")],
    "big": _big, "blocks": _blocks,
    "sizes": {"cols": ["Size", "Net, USD", "Per entry", "Verdict"], "chosen": 0 if SIZED else None, "rows": [["1x" if SIZED else "1x info only", sgn(S_BEST["net"], 0), sgn(S_BEST["per"], 2), "PASS" if SIZED else "FAIL"]]},
    "footer": [_cut(f"A new read of fixed rules on {len(DAYS)} days; um-009, um-012 and um-013 stay registered reads in the ledger.", 160),
               _cut("The days overlap those of um-004 to um-013: one window, one regime, not an independent observation.", 160),
               _cut(f"{HOURS}h, {VERIFY_PASSED}/{VERIFY_TOTAL} checks; Binance and Polymarket clocks taken as one.", 160)]}
_probs = REPORT.card_problems(CARD, metrics={k_: (None if v_ is None else float(v_)) for k_, v_ in METRICS.items()}, gates={g_["id"]: g_ for g_ in GATES}, word=WORD, carry=False)
assert not _probs, _probs
''')

code(r'''
# ---- the study manifest fund.study/1 (directional format, systematic style) ----
TITLE_NB = "Does buying the 15-minute Up/Down token after a Binance burst pay, as a taker or as a resting bid, once four fixed rules are read together on every day the decision tables cover?"
QUESTION = (f"On every seated day from {DAYS[0]} to {DAYS[-1]}, does buying the near token after a Binance burst earn a positive net PnL after the venue's fee and the exact ladder: as a taker on a {A_L} s return of {A_Z:g} sigma (A), "
            f"on a {B_L} s move of {B_Z:g} sigma (B), on A's burst only when the fair value clears the ask by {FV_MARGIN:.2f} (C), or as a post-only bid on BTC and ETH (D)?")
KIND = "strategy"
_ms2 = _ms
_series, _unpinned = [], []
for d_ in DAYS:
    for fm_ in (FILL_MS, FILL_MS_D):
        m_ = derived.meta(TT.DATASET, RUNNER.key_of(d_, fm_))
        _series.append(dict(spec=f"tf15:{d_}:decision-table-d{fm_}:-", pin=m_["hash"], rows=int(COV.set_index("day").loc[d_, "with_book"] if fm_ == FILL_MS else COV.set_index("day").loc[d_, "btc_eth_with_book_150ms"]) or 1,
                            first_ts=_ms2(d_), last_ts=_ms2(d_) + 86_399_999, handle=None, cls="pin", trunc=False))
    mp_ = derived.meta(P.DATASET, P.key_of(d_))
    _series.append(dict(spec=f"mom15:{d_}:binance-1s-path:-", pin=mp_["hash"], rows=int(P.PRE_S + 86_400 + P.POST_S), first_ts=_ms2(d_), last_ts=_ms2(d_) + 86_399_999, handle=None, cls="pin", trunc=False))
    try:
        ip_ = updown15_pin.input_pin(d_)
        _series.append(dict(spec=f"polymarket:updown15 {d_}:l2-ladders:-", pin=hashlib.sha256(f"updown15-l2:{d_}:{ip_['digest']}".encode()).hexdigest(), rows=int(ip_["rows"]), first_ts=_ms2(d_), last_ts=_ms2(d_) + 86_399_999, handle=None, cls="pin", trunc=False))
    except KeyError as e_:
        _unpinned.append({"what": f"polymarket updown15 ladders {d_}", "why": f"the day is not finalized by the ladder job ({str(e_)[:60]})"})
for s_ in ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"):
    ip_ = ticks.input_pin(s_, _ms2(DAYS[0]), _ms2(DAYS[-1]) + 86_400_000)
    _series.append(dict(spec=f"binance:{s_}:aggTrades:-", pin=hashlib.sha256(f"binance:{s_}:{ip_['digest']}".encode()).hexdigest(), rows=int(sum(f["rows"] for f in ip_["files"])), first_ts=_ms2(DAYS[0]), last_ts=_ms2(DAYS[-1]) + 86_399_999, handle=None, cls="pin", trunc=False))
_unpinned.append({"what": "gamma market list (updown15.markets)", "why": "a day cache of the venue's own listing, re-readable; its outcomes are inside the derived days' pins"})
_unpinned.append({"what": "the ledger grids lab/predmkts/data/grids/um-009.jsonl and um-012.jsonl (the counted trials and the spread of their Sharpe ratios)", "why": "read from the repo's ledger, outside the registered inputs digest"})
_unpinned.append({"what": f"the forward days {S.FORWARD_FROM} to {S.FORWARD_DAYS[-1]} of um-013 beyond this window", "why": "not read until all are seated; the pins of the run that opens the gate join its manifest"})
INPUTS = {"digest": REPORT.inputs_digest([x_["pin"] for x_ in _series]), "series": _series, "unpinned": _unpinned}
WINDOW = {"from": f"{DAYS[0]}T00:00Z", "to": f"{(dt.date.fromisoformat(DAYS[-1]) + dt.timedelta(days=1)).isoformat()}T00:00Z", "hours": HOURS, "regimes": 1}
VERIFY = {"suite": "tf15, mom15 and mkb15 engine checks and cross-checks", "passed": int(VERIFY_PASSED), "total": int(VERIFY_TOTAL), "books": int(TAB.W)}
STUDY_GATES = [{k_: g_[k_] for k_ in ("id", "section", "name", "label", "reading", "verdict", "would_change")} for g_ in GATES]
COMPONENTS = [{"name": "PnL before costs", "usd": float(E_BEST["gross"].sum())}, {"name": "fees (a rebate is negative)", "usd": -float(E_BEST["fee"].sum())}]
assert abs(sum(c_["usd"] for c_ in COMPONENTS) - S_BEST["net"]) < 0.01, "the PnL parts do not add to the net"
FIG_KINDS = {"waterfall": "profit-and-loss-attribution", "clusters": "regime-and-concentration", "calibration": "calibration", "arms": "rule-comparison", "hunt": "significance-test", "drift": "signal-decay", "structure": "calibration", "nearcertain": "profit-and-loss-attribution",
             "equity": "equity-curve", "tradepnl": "equity-curve", "coins": "equity-curve", "entrypx": "calibration", "winloss": "win-loss-distribution", "bigwin": "trade-anatomy", "bigloss": "trade-anatomy",
             "compare": "rule-comparison", "edge": "profit-and-loss-attribution", "winrr": "win-loss-distribution", "placebo": "significance-test", "daily": "regime-and-concentration"}
for f_ in FIGURES:
    f_["kind"] = FIG_KINDS[f_["id"].split("-")[-1]]
CAVEATS = [f"{len(DAYS)} days of one regime: one observation of the market, not independent entries; the tests overlap the earlier notebooks' days",
           "every rule was found or chosen on days inside this window (um-009, um-012, the entry-rule family, the maker design): none is out of sample here",
           f"{len(FWD_IN)} days of um-013's registered forward window are read here as part of the new window; its own gate stays closed",
           f"the {N_TRIALS} counted cells charge the deflated Sharpe; the spread of their Sharpe ratios is um-012's grid alone",
           "the Binance trade-implied mid stands in for the Chainlink reference; the fair value is driftless by construction",
           "the book is a reconstruction of the venue's stream; Binance and Polymarket clocks taken as one; the fill ladder keeps four levels a side",
           "the S5 diagnosis reads test A on the same window as the tests; its slices overlap, so the hunt counts are not independent",
           f"the maker forward gate is not opened: {FW_SEATED} of {FW_TOTAL} days seated; the rehearsal of its code path runs on this window",
           f"our own tick-to-trade is an assumed {FILL_MS - VENUE_HOLD_MS} ms on top of the venue hold, not a measurement; the maker's table is the {FILL_MS_D} ms one",
           "the maker fill model is the engine's conservative one (back of the queue, filled only from prints), not a measured live fill",
           f"the halves are cut at {_fmt_t(CUT_MS)} UTC, the middle of the window; the two halves share one regime",
           "venue numbers (the hold, the fee formula, the rebate) are carried from the earlier notebooks' tagged cards, not re-read today"]
HEADLINE = {"metric": f"net PnL per entry, USD, whole window, test {BEST}", "label": "Net per entry", "value": float(S_BEST["per"]), "unit": "usd", "hurdle": 0.0, "gate": GID[(BEST, "zero")]}
EQ = [(dt.datetime.fromtimestamp(int(s_) * 900, dt.timezone.utc) + dt.timedelta(minutes=15), float(BOOK_USD + v_)) for s_, v_ in zip(E_BEST["slot"][_o], _eq)]
STRATEGY = {"name": "Buy the near token after a Binance burst, 15m Up/Down", "thesis": "a Binance burst persists and the Polymarket book has not re-priced it: bought by a taker on a one-second or a three-minute burst, behind a fair-value gate, or as a resting bid",
            "market": "prediction markets", "instruments": ["BTC", "ETH", "SOL", "XRP"], "venues": ["Polymarket", "Binance (input)"], "style": "momentum"}
RULES = {"entry": _cut(f"test {BEST}: " + {"A": f"{A_L} s z>={A_Z:g}", "B": f"{B_L} s z>={B_Z:g}", "C": f"{A_L} s z>={A_Z:g}, fv-ask>={FV_MARGIN:.2f}", "D": f"{A_L} s z>={A_Z:g}, post-only bid"}[BEST], 60),
         "exit": "hold to the outcome", "sizing": f"USD {CLIP_USD:g} a trade", "rebalance": None, "hedge": None, "hold": "to expiry", "stop": None, "cost": _cut(f"taker fee 0.07 x p(1-p), +{FILL_MS} ms; bid rebate {X.REBATE:.0%}", 60)}
PARAMS = {"clip": {"value": CLIP_USD, "unit": "usd", "source": "owner"}, "latency_ms": {"value": float(FILL_MS), "unit": "ms", "source": "[U]"}, "venue_hold_ms": {"value": float(VENUE_HOLD_MS), "unit": "ms", "source": "[1]"},
          "maker_table_ms": {"value": float(FILL_MS_D), "unit": "ms", "source": "[1]"}, "fee_rate": {"value": 0.07, "unit": "rate", "source": "[API]"}, "rebate_share": {"value": float(X.REBATE), "unit": "share of taker fee", "source": "[1]"},
          "fv_margin": {"value": FV_MARGIN, "unit": "usd a share", "source": "owner"}, "z_a": {"value": A_Z, "unit": "sigma", "source": "owner"}, "z_b": {"value": B_Z, "unit": "sigma", "source": "owner"}}
PROFILE = {"market": "predmkts", "markets": ["predmkts", "crypto"], "venues": ["polymarket", "binance"], "instruments": ["BTC, ETH, SOL, XRP 15m Up/Down", "spot aggTrades"], "bar": "15m"}
STUDY = REPORT.build_manifest(id=STUDY_ID, kind=KIND, desk=DESK, title=TITLE_NB, question=QUESTION, status="run", run={"executed": RUN_AT, "kernel": "ccvenv"}, inputs=INPUTS, window=WINDOW, verify=VERIFY, gates=STUDY_GATES,
    figures=FIGURES, verdict=VERDICT, caveats=CAVEATS, headline=HEADLINE, components=COMPONENTS, summary=CARD, format="directional", style="systematic", metrics=METRICS, na=NA, strategy=STRATEGY, rules=RULES,
    params=PARAMS, equity=EQ, profile=PROFILE, book=None)
S0_HANDLE.update(Markdown(REPORT.summary_md(STUDY)))
display(REPORT.display_bundle(STUDY), raw=True)
print("\n".join(l_.replace("RESULT four-tests ", "") for l_ in RESULT_LINES))
''', "manifest")

md(r'''
## A · Appendix

The four tests day by day, and where the logic lives: the engines are `mom15_bt` (the taker), `mkb15_mk` and `mkb15_study` (the resting bid), `mom15_diag` (the edge before friction) and `tf15_bt`; the figures are `tf15_trade_figs`.
''')

code(r'''
_dayrows = []
for i_, d_ in enumerate(DAYS):
    r_ = {"day": d_}
    for k_, t_ in T.items():
        m_ = t_["e"]["day"] == i_
        r_[f"{k_} n"] = int(m_.sum())
        r_[f"{k_} net"] = float(t_["e"]["net"][m_].sum())
    _dayrows.append(r_)
display(Markdown("**Entries and net USD by UTC day** (D counts fills)"))
display(HTML(pd.DataFrame(_dayrows).round(2).to_html(index=False, border=0)))
display(Markdown("**Every signal cell of the diagnosis, hold to expiry, whole window**"))
display(HTML(CT.round(3).to_html(index=False, border=0)))
display(Markdown(f"**The 40 highest of the {HI['n_hyp']} hypotheses scored** (the whole table is `HUNT`)"))
display(HTML(HUNT.head(40)[["family", "by", "hypothesis", "entries", "win", "price", "per", "t", "p_raw", "p_holm", "p_maxt", "disc_n", "disc_per", "hold_n", "hold_per"]].round(3).to_html(index=False, border=0)))
''')

md(r'''
## Research summary
''')

code(r'''
assert [g1_["verdict"] for g1_ in STUDY["gates"]] == [g1_["verdict"] for g1_ in GATES] and STUDY["verdict"]["word"] == WORD and len(STUDY["figures"]) == len(FIGURES)
display(Markdown(HEADLINE_MD))
display(HTML(summary_card.render(CARD, carry=False)))
display(Markdown("**Gates**\n\n| Gate | Verdict |\n|---|---|\n" + "\n".join(f"| {g_['id']} {g_['label']}: {g_['reading']} | **{g_['verdict']}** |" for g_ in GATES)))
''', "summary")

# ---- the build ----
for c_ in CELLS:
    c_.source = c_.source.replace("__TITLES__", repr(TITLES))
if QUICK:
    for c_ in CELLS:
        if c_.cell_type == "code" and "parameters" in c_.metadata.get("tags", []):
            c_.source = c_.source.replace('FIRST_DAY, LAST_DAY = "2026-09-02", "2026-10-09"', 'FIRST_DAY, LAST_DAY = "2026-10-04", "2026-10-09"').replace("N_PLACEBO = 200", "N_PLACEBO = 6")

nbk = new_notebook(cells=CELLS, metadata={"kernelspec": {"name": "ccvenv", "display_name": "ccvenv", "language": "python"}, "language_info": {"name": "python"}})
t0 = time.time()
NotebookClient(nbk, timeout=7200, kernel_name="ccvenv", allow_errors=True, resources={"metadata": {"path": str(HERE)}}).execute()
for c in nbk.cells:
    if c.cell_type != "code":
        continue
    for o in c.get("outputs", []):
        if "data" in o and "image/png" in o["data"]:
            raw = base64.b64decode(o["data"]["image/png"])
            im = Image.open(io.BytesIO(raw)).convert("RGB").quantize(colors=64)
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
_tmp = NB.with_name(NB.name + ".tmp")
nbformat.write(nbk, str(_tmp))
os.replace(_tmp, NB)                              # written only now, at the end, in one step
print(f"wrote {NB.name}: {NB.stat().st_size/1e6:.2f} MB, 0 errors, {time.time()-t0:.0f}s")
