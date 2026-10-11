"""Build and execute `2026-09-27-xasset-sofr-hike-tail-put-sofr.ipynb` (research-004, the re-run of research-001 on SOFR and
the FOMC record, board B-0237), committed beside it under the generator rule
(`app/library/craft/research/the-thesis-first-study/the-generator-and-the-three-reviews.md`).

Run from `platform/research/studies` with the fund venv:
    ..\\..\\.venv\\Scripts\\python 2026-09-27-xasset-sofr-hike-tail-put-sofr.build.py
It writes the cells in THE STUDY STRUCTURE (S0-S7, `app/library/craft/research/the-study-structure/`), executes them on
the `ccvenv` kernel, prints every error, re-encodes the PNGs at 256 colours and writes the notebook. Every number the
notebook shows is computed in it; the figure list the manifest carries is the builder's own tag list, in cell order.
"""
from __future__ import annotations

import base64
import io
import sys
from pathlib import Path

import nbformat
from nbclient import NotebookClient
from nbformat.v4 import new_code_cell, new_markdown_cell, new_notebook
from PIL import Image

HERE = Path(__file__).resolve().parent
STEM = "2026-09-27-xasset-sofr-hike-tail-put-sofr"
NB = HERE / f"{STEM}.ipynb"
CELLS: list = []
FIGS: list = []          # (tag, section, title) in cell order


def md(s: str) -> None:
    CELLS.append(new_markdown_cell(s.strip("\n")))


def code(s: str, tags=None, fig=None) -> None:
    c = new_code_cell(s.strip("\n"))
    t = list(tags or [])
    if fig:
        tag, title = fig
        t.append(tag)
        FIGS.append((tag, "S" + tag.split(":s")[1].split("-")[0], title))
    if t:
        c.metadata["tags"] = t
    CELLS.append(c)


# =====================================================================================================
# S0
# =====================================================================================================
md(r"""
# Selling the Fed-hike tail on SOFR: short SR3 puts settled on compounded SOFR, the FOMC record as the regime

## S0 · Summary

| question | answer |
|---|---|
| Does a short out-of-the-money SR3 put, sold every quarter and settled on SR3's own compounded-SOFR rule, earn a volatility premium over the bill once the direction is taken out; and does the owner's trade as sent hold on today's prices? | rendered below from the run |

This is research-001 (`2026-09-27-xasset-sofr-hike-tail-put-bill`, Treasury-bill carrier, 1990 to 2026) re-run on the rates doors of
B-0212: the settle moves to SR3's final-settlement rule on the NY Fed's SOFR, the regimes and the tail events come from
the FOMC's own decision record, and today's forward is an observed SR3 bar. **The SR3 forward is still NOT observed
historically** (no free SR3 futures or options history exists in the fund): the entry forward stays the Treasury bill
curve and the settle is a perfect-foresight proxy for the futures at option expiry. The block below is filled by the
last cell of S7.
""")
code(r"""
from IPython.display import Markdown, display
S0_HANDLE = display(Markdown("_S0 is rendered by the last cell of S7 when the run finishes._"), display_id=True)
""", tags=["s0"])

# =====================================================================================================
# S1
# =====================================================================================================
md(r"""
## S1 · Setup

| question | gate |
|---|---|
| What exactly was run, on what, with which assumptions? | every venue number is a fact card read in this run; the stated numbers equal the code (PROSE) |

### S1.1 · Parameters

Every knob that is OURS (owner-set or `[U]`) lives in the one cell below; the venue's numbers are S1.2.
""")
code(r"""
# ---- parameters: owner-set, study-set or [U]; never a venue number (those are S1.2, read from the cards) ----
STUDY_ID = "2026-09-27-xasset-sofr-hike-tail-put-sofr"
RUN_ID = "research-004"                  # pre-registered in lab/research/results-log.md before this ran
KIND, DESK = "strategy", "lab/research"
TITLE = "Selling the Fed-hike tail on SOFR: short SR3 puts, SR3's own settlement, the FOMC record"
QUESTION = ("Does a short out-of-the-money SR3 put, sold every quarter and settled on compounded SOFR, earn a volatility "
            "premium over the bill once the direction is taken out, and does the owner's trade as sent hold today?")
EQUITY = 1_000_000.0     # owner 2026-09-27: cash collateral earning the 3M bill; every P&L below is EXCESS over it
LOTS = 40                # owner's trade: 40 lots. S6 sweeps it
Z = 1.0                  # strike distance in implied standard deviations above the forward [U, rule parameter]
KAPPA = 1.0              # implied / trailing realized normal vol; 1.0 = the model charges realized vol [U]
SLIP_BP = 0.25           # [U] slippage per option fill
SLIP_FUT_BP = 0.25       # [U] slippage closing the futures an exercised option delivers
MIN_PREM_BP = 0.5        # [U] do not sell an option worth less than this
DD_LIMIT_PCT = 15.0      # [U] desk drawdown limit, % of equity, fixed before S6 runs
STRESS_GRID = (10, 25, 40, 60, 100, 150)   # [U] bp moves of the forward against the book on entry day, vol x 1.5
STRESS_LIMIT_PCT = 25.0  # [U] the worst of them (the margin proxy) capped at this % of equity
FWD_TOL_BP = 5.0         # [U] tolerance on today's forward when solving the owner's quote for its implied vol
WALK_CAP = 0.20          # [U] the highest Polymarket ask a hedge walk will pay
SPLIT = "2022-01-01"     # [U] the one out-of-sample split: 2018-2021 in sample, 2022 on out of sample
NBOOT, BLOCK_Q, SEED = 2000, 4, 7          # [U] bootstrap draws, mean block (quarters), seed
REGIME_MONTHS = 12       # [U] a day is 'hiking' / 'cutting' if the last non-zero FOMC decision within this many months was one
# the owner's trade as sent, 2026-09-27
OWN_CONTRACT, OWN_LOTS, OWN_K_PX, OWN_PREM_USD, OWN_YES, OWN_YES_PX, OWN_HEDGE_USD = "SR3Z26.CME", 40, 95.4375, 3000.0, 22013, 0.015, 660.0
""", tags=["parameters"])

md(r"""
### S1.2 · Assumptions

The contract terms and fees are the CME fact cards (`platform/venues/cme/facts/`), read in the next cell with their
tags and read dates; cmegroup.com refuses every script, so the multiplier and both fees are `[U]` cards, the settlement
method and the strike grid `[1]` (CME's own filings to the CFTC). The compounding is the NY Fed's own rule
(`venues/nyfed`, card `compounding.convention`, tested on its 2018 worked example). The premium is a MODEL: Bachelier
on the forward at `KAPPA` x trailing realized vol, no skew (card `cme history.options`: no SR3 option history exists).
""")
code(r"""
import datetime as dt, math, warnings
import numpy as np, pandas as pd
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter
from fundplat.data.tradfi import rates as RATES, eodhd as EOD, refrates as REFR, fedpolicy as FP
from fundplat.data.predmkts import polymarket as PM
from fundplat.quant.predmkts import match as MATCH
from fundplat.quant.tradfi import rates_options as RO
from fundplat.quant.core import stats as ST, report as REPORT
from fundplat.quant.crypto.backtest import util as BU   # the trial-ledger cells file (trial.py --cells-file)
from pathlib import Path
from venues import facts as FACTS               # the cards: pure JSON, the tag travels with the value
from venues.nyfed import rules as NYR           # the NY Fed's compounding rule, tested on its own worked example

warnings.filterwarnings("ignore", category=DeprecationWarning)
NOW = dt.datetime.now(dt.timezone.utc)
RUN_AT = NOW.strftime("%Y-%m-%dT%H:%MZ")
TODAY = pd.Timestamp(NOW.date())
RNG = np.random.default_rng(SEED)

CARD_IDS = {"USD per bp per contract": ("cme", "contract.multiplier_and_inverse"), "CME fee per option": ("cme", "fee.option.taker"),
            "CME fee per futures": ("cme", "fee.taker.base"), "SR3 final settlement": ("cme", "settlement.price.method"),
            "SR3 option strikes": ("cme", "option.strike.intervals"), "SR3 calendar": ("cme", "expiry.times"),
            "SR3 option history": ("cme", "history.options"), "SOFR compounding": ("nyfed", "compounding.convention"),
            "SOFR publication": ("nyfed", "publication.schedule")}
CARD = {k: FACTS.tagged(*v) for k, v in CARD_IDS.items()}
USD_PER_BP = float(CARD["USD per bp per contract"]["value"])
FEE_OPT, FEE_FUT = float(CARD["CME fee per option"]["value"]), float(CARD["CME fee per futures"]["value"])
STRIKE_STEP_BP = 6.25    # the number in Rule 460A01.E.3's own text; held to the card text on the next line
assert "6.25 basis point" in str(CARD["SR3 option strikes"]["value"]), CARD["SR3 option strikes"]["value"]

INK, GRID, AXIS = "#1f2937", "#e5e7eb", "#9ca3af"
C_BOOK, C_DRIFT, C_VOL, C_COST, C_LOSS, C_HEDGE, C_ALT = "#1f6feb", "#d97706", "#16a34a", "#6b7280", "#dc2626", "#7c3aed", "#0891b2"
plt.rcParams.update({"figure.dpi": 96, "axes.edgecolor": AXIS, "axes.grid": True, "grid.color": GRID,
                     "axes.spines.top": False, "axes.spines.right": False, "font.size": 9})
LEG = dict(frameon=False)
KFMT = FuncFormatter(lambda v, _: f"{v:,.0f}")


def ask(ax, q, sub):
    ax.set_title(q, loc="left", fontsize=11, fontweight="bold", color=INK, pad=18)
    ax.text(0, 1.012, sub, transform=ax.transAxes, fontsize=8, color=C_COST, va="bottom")


def mdt(df, fmt=None):
    # a DataFrame as a markdown table (no tabulate in the venv)
    fmt = fmt or {}
    cols = [str(c) for c in df.columns]
    out = ["| " + " | ".join([df.index.name or ""] + cols) + " |", "|" + "---|" * (len(cols) + 1)]
    for i, r in df.iterrows():
        cells = [("-" if (isinstance(v, float) and np.isnan(v)) else fmt.get(c, "{}").format(v)) for c, v in zip(df.columns, r)]
        out.append("| " + " | ".join([str(i)] + cells) + " |")
    return "\n".join(out)


usd = lambda v: f"USD {v:,.0f}"
sgn = lambda v, d=2: f"{v:+,.{d}f}"

AS = pd.DataFrame([{"item": k, "value": str(c["value"])[:150] + ("..." if len(str(c["value"])) > 150 else ""),
                    "unit": c.get("unit") or "-", "tag": c["tag"], "read": c["read"]} for k, c in CARD.items()]).set_index("item")
AS.index.name = "venue number (card)"
display(Markdown(mdt(AS)))
OURS = pd.DataFrame([("equity", usd(EQUITY), "owner 2026-09-27"), ("lots", f"{LOTS} (USD {LOTS * USD_PER_BP:,.0f} per bp)", "owner's trade"),
                     ("strike rule", f"z {Z:g} implied SD above the entry forward", "[U]"), ("premium", f"Bachelier, kappa {KAPPA:g} x trailing 63-day realized vol", "MODEL [U]"),
                     ("slippage", f"{SLIP_BP:g} bp per option fill, {SLIP_FUT_BP:g} bp per futures close", "[U]"),
                     ("desk limits", f"max drawdown {DD_LIMIT_PCT:g}%, worst stress loss {STRESS_LIMIT_PCT:g}% of equity", "[U], fixed before S6"),
                     ("the entry forward", "Treasury par curve (bills), money-market basis: the SR3 forward is NOT observed", "US Treasury [V]; proxy [U]"),
                     ("the settle", "SR3 final settlement from the NY Fed's SOFR over the reference quarter, applied at option expiry (perfect foresight of the futures)", "rule [1]; timing proxy [U]"),
                     ("regimes", f"hiking / cutting / hold from the FOMC's decisions, {REGIME_MONTHS}-month memory", "Fed + FRED [V]; rule [U]")],
                    columns=["item", "value", "source"]).set_index("item")
OURS.index.name = "our choice"
display(Markdown(mdt(OURS)))
PROSE = {"40 lots": (LOTS, 40), "equity 1M": (EQUITY, 1e6), "z = 1": (Z, 1.0), "kappa = 1": (KAPPA, 1.0),
         "3.0 bp quote": (OWN_PREM_USD / (OWN_LOTS * USD_PER_BP), 3.0), "YES at 1.5c = USD 660": (round(2 * OWN_YES * OWN_YES_PX), OWN_HEDGE_USD),
         "strike grid 6.25 in the rule": (STRIKE_STEP_BP, 6.25)}
BAD = {k: v for k, v in PROSE.items() if v[0] != v[1]}
assert not BAD, f"the S1 tables no longer describe this run: {BAD}"
print(f"run {RUN_AT} · {len(CARD)} cards read · {len(PROSE)} stated numbers held to the code")
""")

md(r"""
### S1.3 · Data

| source | what | guard |
|---|---|---|
| `fundplat.data.tradfi.rates.par_yield_curve` | US Treasury par curve 1M to 1Y: the entry forward and the realized vol | not stale; 5 random days re-read (S2) |
| `fundplat.data.tradfi.refrates.sofr` | SOFR by value date, the NY Fed | every value date equal to a fresh NY Fed read, and to FRED's mirror (S2) |
| `fundplat.data.tradfi.fedpolicy` | the target range per day (FRED), every FOMC decision (the Board), the next meetings (the Fed calendar), SR3's newest archived bars (Yahoo `[1]`) | the decision join is verified on every call and raises |
| `fundplat.data.tradfi.eodhd` | MOVE (ICE BofA) | covered from its first requested day |
| `fundplat.data.predmkts.polymarket` | the Fed-decision and rate-level markets, live books (S5.3, S6) | `[API]`, read in this run |

SR3's settle for each reference quarter is compounded daily SOFR over it (card `settlement.price.method`), computed by
`rates_options.sr3_final_settlement` (the NY Fed's compounding rule, tested on its published example) and handed to the engine as `settle=`.
""")
code(r"""
# ---- the Treasury par curve (the entry forward) and MOVE ----
TEN = {"1M": 1 / 12, "2M": 2 / 12, "3M": 0.25, "4M": 4 / 12, "6M": 0.5, "1Y": 1.0}
MMF = RO.MMF
rows, CMETA = RATES.par_yield_curve("1990-01-01", None, with_meta=True)
CUR = pd.DataFrame([{"date": r["date"], **{k: r["tenors"].get(k) for k in TEN}} for r in rows])
CUR["date"] = pd.to_datetime(CUR["date"])
CUR = CUR.set_index("date").sort_index().apply(pd.to_numeric).dropna(subset=["3M", "6M"])
DATES, LAST = CUR.index, CUR.index[-1]
CT = {d: (np.array([TEN[k] for k in TEN if pd.notna(r[k])]), np.array([r[k] for k in TEN if pd.notna(r[k])])) for d, r in CUR.iterrows()}
CM36 = pd.Series([RO.fwd_bp(*CT[d], 0.25, 0.5) for d in DATES], index=DATES)     # constant-maturity 3x6 bill forward, bp
RV63 = CM36.diff().rolling(63).std() * math.sqrt(252)                             # realized normal vol, bp / yr
RV21 = CM36.diff().rolling(21).std() * math.sqrt(252)
SPOT3 = CUR["3M"] * MMF * 100                                                       # the 3M bill, bp, money-market
BILL1 = CUR["1M"] * MMF * 100
LONG = pd.DataFrame([{"date": r["date"], **{k: r["tenors"].get(k) for k in ("2Y", "5Y", "10Y", "30Y")}} for r in rows])
LONG["date"] = pd.to_datetime(LONG["date"])
LONG = LONG.set_index("date").sort_index().apply(pd.to_numeric)
RV_LONG = (LONG.diff() * 100).rolling(21).std().mean(axis=1) * math.sqrt(252)
mv, MVMETA = EOD.eod("MOVE.INDX", "2002-11-13", with_meta=True)
MOVE = pd.Series({pd.Timestamp(r["date"]): r["close"] for r in mv}).sort_index()
assert not CMETA["stale"], "Treasury served from a stale cache"
assert MVMETA["covered_from"] <= "2002-11-13", MVMETA["covered_from"]

# ---- SOFR, the target range, the FOMC record, the next meetings, SR3's archived bars ----
SOFR_ROWS, SMETA = REFR.sofr(with_meta=True)
assert not SMETA["stale"] and not SMETA["error"], SMETA
SOFR = pd.Series({pd.Timestamp(r["date"]): float(r["rate"]) for r in SOFR_ROWS}).sort_index()   # percent, by VALUE date
TGT = pd.DataFrame(FP.fed_target("2017-01-01"))
TGT["date"] = pd.to_datetime(TGT["date"])
TGT = TGT.set_index("date").sort_index()
DEC = pd.DataFrame(FP.fomc_decisions())                     # raises if the meeting / change / FRED join does not verify
DEC["date"] = pd.to_datetime(DEC["meeting_end"])
CHG = pd.DataFrame(FP.fomc_changes())                      # every change by its EFFECTIVE date, 2003 on (the Board): the regime labels
CHG["date"] = pd.to_datetime(CHG["date"])
NEXT = [m for m in FP.fomc_meetings() if not m["held"]]
SR3BAR = {s: FP.sr3_eod(s) for s in (OWN_CONTRACT, "SR3H27.CME")}
assert SR3BAR[OWN_CONTRACT], f"no archived bar for {OWN_CONTRACT}"


# ---- SR3's final settlement: the platform's rates_options.sr3_final_settlement (Rule 46003.A.2, platform 690d99f) ----
QTRS = [RO.sr3_quarter(y, m) for y in range(2018, TODAY.year + 1) for m in (3, 6, 9, 12)]
SETTLE = {(pd.Timestamp(f), pd.Timestamp(q0)): RO.sr3_final_settlement(SOFR_ROWS, q0, q1) for f, q0, q1 in QTRS}
ok_ = [i for i, (f, q0, q1) in enumerate(QTRS) if np.isfinite(SETTLE[(pd.Timestamp(f), pd.Timestamp(q0))])]
i0, i1 = ok_[0], ok_[-1]
assert ok_ == list(range(i0, i1 + 1)), "the SOFR settles are not one contiguous run of quarters"
EXPS = [(pd.Timestamp(f), pd.Timestamp(q0)) for f, q0, _ in QTRS[i0 - 1: i1 + 1]]   # the entry quarter, then every settled one
Q1OF = {pd.Timestamp(q0): pd.Timestamp(q1) for _, q0, q1 in QTRS}
SETTLE = {k: v for k, v in SETTLE.items() if np.isfinite(v)}
# the no-foresight settle: SOFR on the newest value date before the option's expiry (known that morning), held flat
SPOT_SETTLE = {(f, q0): float(SOFR[SOFR.index < f].iloc[-1]) * 100 for (f, q0) in SETTLE}
print(f"Treasury par curve {DATES[0]:%Y-%m-%d} -> {LAST:%Y-%m-%d}, {len(DATES):,} days [V] · SOFR {SOFR.index[0]:%Y-%m-%d} -> "
      f"{SOFR.index[-1]:%Y-%m-%d}, {len(SOFR):,} value dates (NY Fed) · target range to {TGT.index[-1]:%Y-%m-%d} (FRED) · "
      f"{len(DEC)} FOMC decisions {DEC.date.min():%Y-%m-%d} -> {DEC.date.max():%Y-%m-%d} (the Board) · next meetings "
      f"{', '.join(m['end'] for m in NEXT[:3])} · {len(SETTLE)} SR3 reference quarters settled on SOFR, "
      f"{EXPS[1][1]:%Y-%m-%d} -> {Q1OF[EXPS[-1][1]]:%Y-%m-%d} · {OWN_CONTRACT} archived close {SR3BAR[OWN_CONTRACT][-1]['close']:.4f} "
      f"on {SR3BAR[OWN_CONTRACT][-1]['date']} (Yahoo [1])")
""")

md(r"""
### S1.4 · Runs

One engine, `fundplat.quant.tradfi.rates_options.sell_and_hold`, on three settles for the SAME trades: the entry
forward, the strike and the premium are the bill curve's in all three; the settle is the bill forward at option expiry
(research-001's), SR3's final settlement (compounded SOFR over the reference quarter: it KNOWS the quarter's path, a
perfect-foresight proxy for the futures at expiry, the registered carrier), or SOFR at expiry held flat (knows nothing of
the quarter). The true SR3 price at expiry is not observed; the last two bracket it. The SOFR settles use the engine's `settle=` (the rate by reference start, `rates_options.sr3_final_settlement` for SR3's own rule; platform 690d99f). Every book passes
the engine's `verify()` before anything is drawn.
""")
code(r"""
# ==== the engine adapted to pandas; nothing here fetches. The statistics over a result stay in this notebook. ====
bach = np.vectorize(RO.bachelier, otypes=[float])
ncdf, npdf = np.vectorize(RO.norm_cdf, otypes=[float]), np.vectorize(RO.norm_pdf, otypes=[float])


CV = RO.Curve(CT)
SETMAP = {"bill": None, "sofr": {q0.date(): v for (_, q0), v in SETTLE.items()},
          "spot": {q0.date(): v for (_, q0), v in SPOT_SETTLE.items()}}
BOOKS = [0]
RES = {}


def run_res(carrier="sofr", z=None, kappa=None, side="put", width=None, vol=None, skip=None, start=None, offset=0,
            kstrike=None, expiries="sofr"):
    # the engine's own result (per lot, USD); expiries "sofr" = the settled quarters, None = the whole bill history
    BOOKS[0] += 1
    return RO.sell_and_hold(CV, RV63 if vol is None else vol, z=Z if z is None else z,
                            kappa=KAPPA if kappa is None else kappa, kstrike=kstrike, side=side, width=width,
                            start=start, offset=offset, expiries=EXPS if expiries == "sofr" else expiries, settle=SETMAP[carrier],
                            skip=None if skip is None else (lambda t0, F, s: skip(pd.Timestamp(t0), F, s)),
                            usd_per_bp=USD_PER_BP, strike_step_bp=STRIKE_STEP_BP, fee_option=FEE_OPT, fee_futures=FEE_FUT,
                            slip_bp=SLIP_BP, slip_fut_bp=SLIP_FUT_BP, min_prem_bp=MIN_PREM_BP)


def frame(res):
    Q = pd.DataFrame(res["quarters"])
    for c in ("t0", "T", "expiry"):
        Q[c] = pd.to_datetime(Q[c])
    idx = pd.DatetimeIndex(pd.to_datetime(res["days"]))
    D = pd.Series(res["daily"], index=idx, dtype=float)
    Q.attrs["dir"] = pd.Series(res["directional"], index=idx, dtype=float)
    Q.attrs["side"], Q.attrs["width"], Q.attrs["res"] = res["side"], res["width"], res
    return Q, D


def run(**kw):
    return frame(run_res(**kw))


def cut(Q, D, a=None, b=None):
    a, b = pd.Timestamp(a) if a else D.index[0], pd.Timestamp(b) if b else D.index[-1] + pd.Timedelta(days=1)
    Qc = Q[(Q.t0 >= a) & (Q.t0 < b)].copy()
    Qc.attrs = {**Q.attrs, "dir": Q.attrs["dir"][(Q.attrs["dir"].index >= a) & (Q.attrs["dir"].index < b)]}
    return Qc, D[(D.index >= a) & (D.index < b)]


def stress_lot(Q, grid=STRESS_GRID):
    t = Q[Q.traded]
    if not len(t):
        return 0.0
    side = Q.attrs.get("side", "put")
    sg = 1 if side == "put" else -1
    worst = 0.0
    for m in grid:
        v = bach(t.F + sg * m, t.K, 1.5 * t.s, side)
        if Q.attrs.get("width"):
            v = v - bach(t.F + sg * m, t.K2, 1.5 * t.s, side)
        worst = max(worst, float((USD_PER_BP * (v - t.prem)).max()))
    return worst


def metrics(Q, D, lots=None):
    lots = LOTS if lots is None else lots
    p = D * lots
    yrs = max((D.index[-1] - D.index[0]).days / 365.25, 1e-9)
    eq = EQUITY + p.cumsum()
    uw = eq / np.maximum(eq.cummax(), EQUITY) - 1
    r = p / EQUITY
    q = Q.loc[Q.traded, "pnl"] * lots
    down = math.sqrt((np.minimum(r, 0) ** 2).mean())
    under = uw < 0
    runs_ = (under != under.shift()).cumsum()[under]
    dur = max([(g.index[-1] - g.index[0]).days for _, g in uw[under].groupby(runs_)], default=0)
    dirp = Q.attrs["dir"] * lots
    return {"ann %": p.sum() / yrs / EQUITY * 100, "max DD %": uw.min() * 100,
            "Sharpe": r.mean() / r.std() * math.sqrt(252) if r.std() > 0 else np.nan,
            "Sortino": r.mean() / down * math.sqrt(252) if down > 0 else np.nan,
            "worst day %": p.min() / EQUITY * 100, "worst quarter %": q.min() / EQUITY * 100 if len(q) else np.nan,
            "longest under water, days": int(dur), "vol term quarterly": (Q.pnl - Q.dir).values * lots / EQUITY,
            "expired worthless %": (Q.loc[Q.traded, "pay"] <= 0).mean() * 100 if Q.traded.any() else np.nan,
            "quarters sold": int(Q.traded.sum()), "total USD": p.sum(), "premium ann %": float((Q.loc[Q.traded, "prem"] * USD_PER_BP * lots).sum()) / yrs / EQUITY * 100,
            "directional ann %": dirp.sum() / yrs / EQUITY * 100, "volatility ann %": (p.sum() - dirp.sum()) / yrs / EQUITY * 100,
            "stress %": -stress_lot(Q) * lots / EQUITY * 100}


TRIALS = {}                                  # every CHOICE scored (rule parameters, not market assumptions): the deflated Sharpe


def score(name, QD, lots=None):
    m = metrics(*QD, lots=lots)
    TRIALS[name] = m["vol term quarterly"]
    return m


def block_ci(q, per_year):
    # 95% interval of the annual mean of a quarterly series: the stationary bootstrap (fundplat.quant.core.stats)
    sums = ST.stationary_bootstrap_sums(q, BLOCK_Q, NBOOT, RNG)
    return np.percentile(np.array(sums) / len(q) * per_year * 100, [2.5, 97.5])


# ---- the three base books and their verify ----
RES["sofr"], RES["bill"], RES["spot"], RES["call"] = run_res(), run_res(carrier="bill"), run_res(carrier="spot"), run_res(side="call")
Q1, D1 = frame(RES["sofr"])
QB, DB = frame(RES["bill"])
QS, DS = frame(RES["spot"])
QC, DC = frame(RES["call"])
T1 = Q1[Q1.traded]
WIN_FROM, WIN_TO = Q1.t0.min(), Q1["T"].max()
WIN_END = Q1OF[EXPS[-1][1]]                                  # the last day of SOFR the last settle reads
YRS = (WIN_TO - WIN_FROM).days / 365.25
QPY = len(Q1) / YRS
CHK = {}
for nm, res in RES.items():
    CHK.update({f"{nm}: rates_options {k}": bool(v[0]) for k, v in RO.verify(res).items()})
CHK.update({f"rates_options {k}": bool(v[0]) for k, v in {**RO.verify_pricer(), **RO.verify_calendar()}.items()})
CHK["the SOFR book settles every quarter on the SOFR rule"] = all(abs(r.R - SETTLE[(r.expiry, r.expiry + pd.Timedelta(days=5))]) < 1e-9 for r in Q1.itertuples())
CHK["the bill control shares every entry: t0, F, K, premium"] = bool((Q1[["t0", "F", "K", "prem", "traded"]].values == QB[["t0", "F", "K", "prem", "traded"]].values).all())
CHK["the bill and spot controls share every entry too"] = bool((QS[["t0", "F", "K", "prem", "traded"]].values == QB[["t0", "F", "K", "prem", "traded"]].values).all())
CHK["the three books differ only on the settle day"] = bool(np.allclose((D1 - DB)[~D1.index.isin(Q1["T"])], 0, atol=1e-9)
                                                            and np.allclose((DS - DB)[~DS.index.isin(Q1["T"])], 0, atol=1e-9))
CHK["the spot book settles every quarter on SOFR at expiry"] = all(abs(r.R - SPOT_SETTLE[(r.expiry, r.expiry + pd.Timedelta(days=5))]) < 1e-9 for r in QS.itertuples())
print(f"{len(Q1)} quarters, entries {WIN_FROM:%Y-%m-%d} -> expiries {WIN_TO:%Y-%m-%d}, settles read SOFR to {WIN_END:%Y-%m-%d}; "
      f"verify {sum(CHK.values())}/{len(CHK)} " + ("ALL PASS" if all(CHK.values()) else "FAIL: " + ", ".join(k for k, v in CHK.items() if not v)))
assert all(CHK.values())
""")

# =====================================================================================================
# S2
# =====================================================================================================
md(r"""
## S2 · Data checks

| question | gate to S3 |
|---|---|
| Is SOFR exactly what the NY Fed published, is the curve the Treasury's, is the settle rule the venue's own, and what did the FOMC actually do over the window? | every SOFR value date equals a fresh NY Fed read and FRED's mirror; the curve re-reads; the compounding reproduces the NY Fed's worked example |
""")
code(r"""
# ---- the venue-published asserts ----
fresh = pd.Series({pd.Timestamp(r["date"]): float(r["rate"]) for r in REFR.sofr(refresh=True)}).sort_index()
sh = SOFR.index.intersection(fresh.index)
D_NYFED = int((SOFR[sh] - fresh[sh]).abs().gt(1e-12).sum())
fred = pd.Series({pd.Timestamp(r["date"]): float(r["value"]) for r in FP.fred_sofr("2018-04-02")}).sort_index()
shf = SOFR.index.intersection(fred.index)
D_FRED = int((SOFR[shf] - fred[shf]).abs().gt(1e-9).sum())
pick = RNG.choice(len(DATES), 5, replace=False)
pub = [(DATES[i], RATES.par_on(f"{DATES[i]:%Y-%m-%d}")) for i in pick]
CURVE_OK = all(all(abs(float(p[k]) - CUR.loc[d, k]) < 1e-9 for k in TEN if pd.notna(CUR.loc[d, k]) and k in p) for d, p in pub)
EXAMPLES = [(e.name, e.expected, NYR.FORMULAS[0].fn(**e.inputs)) for f in NYR.FORMULAS for e in f.examples]
RULE_OK = all(abs(a - b) <= 1e-12 for _, a, b in EXAMPLES)
inwin = DEC[(DEC.date >= WIN_FROM - pd.Timedelta(days=100)) & (DEC.date <= WIN_END)]
DGATES = [
    {"id": "D1", "section": "S2", "name": "SOFR is the NY Fed's, to the digit", "label": "SOFR matches NY Fed",
     "reading": f"{len(sh):,} value dates vs a fresh NY Fed read: {D_NYFED} differ; {len(shf):,} vs FRED's mirror: {D_FRED} differ",
     "verdict": "PASS" if D_NYFED == 0 and D_FRED == 0 and len(sh) == len(SOFR) else "FAIL",
     "would_change": "a revision the lake has not merged, or FRED diverging from its source"},
    {"id": "D2", "section": "S2", "name": "the curve is the Treasury's published par curve", "label": "Curve matches Treasury",
     "reading": f"5 random days re-read: {'equal' if CURVE_OK else 'DIFFER'}", "verdict": "PASS" if CURVE_OK else "FAIL",
     "would_change": "a Treasury revision the cache has not merged"},
    {"id": "D3", "section": "S2", "name": "the settle compounds by the NY Fed's own rule", "label": "Settle rule matches",
     "reading": f"sofr.index reproduces {sum(abs(a - b) <= 1e-12 for _, a, b in EXAMPLES)} of {len(EXAMPLES)} rows of the NY Fed's 2018 worked example; "
                f"{len(inwin)} FOMC decisions joined and verified against FRED by the loader",
     "verdict": "PASS" if RULE_OK else "FAIL",
     "would_change": "CME's own SR3 settlement worked example (not reachable: cmegroup.com refuses scripts) disagreeing"}]
print(" · ".join(f"{g['id']} {g['verdict']}: {g['reading']}" for g in DGATES))
""")

code(r"""
# ---- where SOFR sat against the target range, and against the bill the entry forward is built from ----
S2W = SOFR[SOFR.index >= WIN_FROM]
tg = TGT.reindex(S2W.index).ffill()
INSIDE = float(((S2W >= tg.lo - 1e-9) & (S2W <= tg.hi + 1e-9)).mean() * 100)
SPR = (S2W * 100 - BILL1.reindex(S2W.index).ffill())                      # SOFR minus the 1M bill, bp
fig, (a0, a1) = plt.subplots(2, 1, figsize=(12, 6.8), sharex=True, gridspec_kw={"height_ratios": [2.2, 1]})
tgw = TGT[TGT.index >= WIN_FROM]
a0.fill_between(tgw.index, tgw.lo, tgw.hi, color=GRID, step="post", label="FOMC target range (FRED)")
a0.plot(S2W.index, S2W, color=C_BOOK, lw=0.9, label="SOFR (NY Fed)")
for r in inwin[inwin.change_bp != 0].itertuples():
    a0.annotate(f"{r.change_bp:+.0f}", (r.date, r.hi_after + 0.12), fontsize=6.5, color=C_LOSS if r.change_bp > 0 else C_VOL, ha="center")
a0.set_ylabel("% a year"); a0.legend(loc="upper left", fontsize=8, **LEG)
a0.set_ylim(top=S2W.quantile(0.999) + 0.8)
ask(a0, "Where did SOFR sit against the target range, and what did the FOMC do?",
    f"{S2W.index[0]:%Y-%m-%d} -> {S2W.index[-1]:%Y-%m-%d} · SOFR inside the range on {INSIDE:.1f}% of value dates · labels: every decision, bp")
a1.plot(SPR.index, SPR.clip(-40, 60), color=C_ALT, lw=0.7)
a1.axhline(0, color=INK, lw=0.8)
a1.set_ylabel("SOFR - 1M bill, bp (clipped)")
ask(a1, "How far does the bill the forward is built from sit from SOFR?", f"median {SPR.median():+.1f} bp, 5-95% {SPR.quantile(0.05):+.1f} to {SPR.quantile(0.95):+.1f} bp")
plt.subplots_adjust(hspace=0.45); plt.show()
""", fig=("fig:s2-carrier", "Where did SOFR sit against the target range, and against the bill?"))

code(r"""
# ---- each settle, split into what the FOMC decided and how far SOFR drifted in its range ----
DEC_ROWS = []
for r in Q1.itertuples():
    q0 = r.expiry + pd.Timedelta(days=5); q1 = Q1OF[q0]
    vk = SOFR.index[SOFR.index < r.T][-1]                               # the newest SOFR published by the option's expiry
    dd = DEC[(DEC.date >= vk) & (DEC.date < q1)]
    part = float(sum(c * RO.reference_weight(m, q0, q1) for m, c in zip(dd.date, dd.change_bp)))
    DEC_ROWS.append({"T": r.T, "settle": r.R, "sofr at expiry": SOFR[vk] * 100, "decisions": part,
                     "drift": r.R - SOFR[vk] * 100 - part, "bill settle": QB.loc[r.Index, "R"]})
SD = pd.DataFrame(DEC_ROWS).set_index("T")
GAP = SD["settle"] - SD["bill settle"]
fig, (a0, a1) = plt.subplots(1, 2, figsize=(13, 4.6), gridspec_kw={"width_ratios": [3, 2]})
x = np.arange(len(SD))
a0.bar(x, SD.decisions, color=C_BOOK, label="decided in the reference quarter (FOMC, weighted by days in force)")
a0.bar(x, SD.drift, bottom=np.where(np.sign(SD.drift) == np.sign(SD.decisions), SD.decisions, 0), color=C_DRIFT, label="SOFR drift in its range")
a0.axhline(0, color=INK, lw=0.8)
a0.set_xticks(x[::2], [f"{t:%y-%m}" for t in SD.index[::2]], rotation=90, fontsize=7)
a0.set_ylabel("settle minus SOFR at expiry, bp"); a0.legend(loc="lower left", fontsize=8, **LEG)
ask(a0, "How much of each settle did the FOMC decide?", f"{len(SD)} reference quarters · drift median |{SD.drift.abs().median():.1f}| bp, worst {SD.drift.abs().max():.1f} bp")
a1.bar(x, GAP, color=np.where(GAP > 0, C_LOSS, C_VOL))
a1.axhline(0, color=INK, lw=0.8)
a1.set_xticks(x[::4], [f"{t:%y-%m}" for t in SD.index[::4]], rotation=90, fontsize=7)
a1.set_ylabel("SOFR settle - bill settle, bp")
ask(a1, "How far is SR3's settle from research-001's?", f"mean {GAP.mean():+.1f} bp, median {GAP.median():+.1f} bp; red = the SOFR settle is higher (worse for the put seller)")
plt.tight_layout(); plt.show()
SETTLE_BASIS_BP = float(GAP.mean())
""", fig=("fig:s2-settle", "How much of each settle did the FOMC decide, and how far is it from the bill settle?"))

code(r"""
# ---- the FOMC record as regimes, and where the rate lands against the forward on each carrier ----
NZ = CHG[CHG.change_bp.fillna(0) != 0].set_index("date")["change_bp"].sort_index()


def regime(day):
    past = NZ[NZ.index <= day]
    if not len(past) or (day - past.index[-1]).days > REGIME_MONTHS * 30.44:
        return "hold"
    return "hiking" if past.iloc[-1] > 0 else "cutting"


DAYS_W = pd.date_range(WIN_FROM, WIN_END)
LAB = pd.Series([regime(d) for d in DAYS_W], index=DAYS_W)
REG_RUNS = LAB.groupby((LAB != LAB.shift()).cumsum()).agg(["first", "size"])
N_REG = len(REG_RUNS)
assert CHG.date.min() < WIN_FROM - pd.Timedelta(days=REGIME_MONTHS * 31), "the change record does not reach one memory before the window"
Q1["regime"] = [regime(t) for t in Q1.t0]
WS = f"{WIN_FROM:%Y-%m-%d} -> {WIN_TO:%Y-%m-%d}, {len(Q1)} quarters, {N_REG} FOMC regimes"
ZM, ZB = Q1.zmiss, QB.zmiss
KURT = float(((ZM - ZM.mean()) ** 4).mean() / ZM.var() ** 2 - 3)
fig, ax = plt.subplots(figsize=(10.5, 4.4))
bins = np.linspace(-6, 6, 37)
ax.hist(ZB.clip(-6, 6), bins=bins, density=True, color=C_COST, alpha=0.45, label="bill settle (research-001's carrier)")
ax.hist(ZM.clip(-6, 6), bins=bins, density=True, color=C_BOOK, alpha=0.55, label="SOFR settle (SR3's rule)")
xs = np.linspace(-6, 6, 200)
ax.plot(xs, npdf(xs), color=INK, lw=1.4, label="the model: N(0, 1)")
ax.axvline(Z, color=INK, ls="--", lw=1.1, label=f"strike rule, z {Z:g}")
ax.set_xlabel("(settle - entry forward) / (realized vol x sqrt(time)), clipped at +/-6")
ax.legend(loc="upper left", fontsize=8, **LEG)
ask(ax, "Is the model the right shape on SOFR?", f"{WS} · SOFR: mean {ZM.mean():+.2f}, sd {ZM.std():.2f}, excess kurtosis {KURT:.1f} (fair 0 / 1 / 0)")
plt.show()
RT = Q1.groupby("regime").agg(quarters=("t0", "size"), fwd_bias=("R", "mean"))
RT["forward bias, bp"] = Q1.assign(fb=Q1.R - Q1.F).groupby("regime").fb.mean()
RT["sd of standardized miss"] = Q1.groupby("regime").zmiss.std()
RT["put paid %"] = Q1[Q1.traded].assign(p=lambda d: d.pay > 0).groupby("regime").p.mean() * 100
RT = RT.drop(columns="fwd_bias"); RT.index.name = "FOMC regime at entry"
MOVES = DEC[(DEC.date >= WIN_FROM) & (DEC.date <= WIN_END)].change_bp.value_counts().sort_index()
display(Markdown(mdt(RT, {"quarters": "{:.0f}", "forward bias, bp": "{:+.1f}", "sd of standardized miss": "{:.2f}", "put paid %": "{:.0f}"})
                 + "\n\nFOMC decisions in the window by size (bp: count): " + ", ".join(f"{k:+.0f}: {v}" for k, v in MOVES.items())
                 + ". Regimes in order (the FOMC's changes by effective date, 2003 on): " + " -> ".join(f"{r['first']} ({r['size']} d)" for _, r in REG_RUNS.iterrows())))
""", fig=("fig:s2-miss", "Is the model the right shape on SOFR?"))

# =====================================================================================================
# S3
# =====================================================================================================
md(r"""
## S3 · Core result

| question | gate to S4 |
|---|---|
| At kappa 1, is there a volatility premium in the short put on SR3's own settle once the direction is taken out? | the volatility term is positive AND its 95% block-bootstrap interval excludes zero. The total, the bill control and the mirror are shown and not graded |
""")
code(r"""
M1, MB, MS, MC = score("base", (Q1, D1)), metrics(QB, DB), metrics(QS, DS), metrics(QC, DC)
VQ = M1["vol term quarterly"]
CI_V = block_ci(VQ, QPY)
CI_T = block_ci(Q1.pnl.values * LOTS / EQUITY, QPY)
LUCK = ST.bootstrap_p_one_sided(VQ, BLOCK_Q, NBOOT, RNG)
NW = ST.newey_west(list(VQ))
TB_ANN = SPOT3.reindex(pd.date_range(WIN_FROM, WIN_TO)).ffill().mean() / 100
CARRIER_ANN = M1["ann %"] - MB["ann %"]
LEVEL_ANN, PATH_ANN = MS["ann %"] - MB["ann %"], M1["ann %"] - MS["ann %"]     # SOFR's level vs bills; the quarter's own path (foresight)
tot, dirc, totb = (D1 * LOTS).cumsum(), (Q1.attrs["dir"] * LOTS).cumsum(), (DB * LOTS).cumsum()
eq = EQUITY + tot
uw = (eq / np.maximum(eq.cummax(), EQUITY) - 1) * 100
fig, (a0, a1) = plt.subplots(2, 1, figsize=(12, 6.6), sharex=True, gridspec_kw={"height_ratios": [3, 1.1]})
a0.plot(tot.index, tot, color=C_BOOK, lw=2.2, label=f"the book, SOFR settle: {M1['ann %']:+.2f}% a year")
a0.plot(dirc.index, dirc, color=C_DRIFT, lw=1.5, label=f"directional term, the lottery: {M1['directional ann %']:+.2f}%")
a0.plot(tot.index, tot - dirc, color=C_VOL, lw=1.5, label=f"volatility term, the craft (costs in it): {M1['volatility ann %']:+.2f}%")
a0.plot(totb.index, totb, color=C_COST, lw=1.2, ls="--", label=f"same trades, bill settle (research-001's carrier): {MB['ann %']:+.2f}%")
a0.plot(DS.index, (DS * LOTS).cumsum(), color=C_ALT, lw=1.2, ls=":", label=f"same trades, SOFR at expiry held flat (no foresight): {MS['ann %']:+.2f}%")
a0.axhline(0, color=INK, ls=":", lw=1.1)
a0.yaxis.set_major_formatter(KFMT); a0.set_ylabel("cumulative excess P&L, USD")
a0.legend(loc="lower left", fontsize=8, **LEG)
ask(a0, "Which term pays the seller on SR3's own settle?", f"{WS} · {LOTS} lots, z {Z:g}, kappa {KAPPA:g}, marked daily on the bill forward; the bill ({TB_ANN:.2f}% a year) is on top")
a1.fill_between(uw.index, uw, 0, color=C_BOOK, alpha=0.7, lw=0)
a1.set_ylabel("drawdown %")
ask(a1, "How deep and how long under water?", f"max {M1['max DD %']:.2f}%, longest {M1['longest under water, days']:,} calendar days")
plt.subplots_adjust(hspace=0.35); plt.show()

T3t = pd.DataFrame({"short put, SR3 final settle (the book)": M1, "short put, SOFR at expiry, no foresight (control)": MS,
                    "short put, bill settle (research-001's carrier)": MB, "short call, SR3 final settle (the mirror)": MC}).T
T3t.index.name = f"{LOTS} lots, kappa {KAPPA:g}"
c1 = ["ann %", "premium ann %", "directional ann %", "volatility ann %", "max DD %", "Sharpe", "worst quarter %", "expired worthless %"]
display(Markdown(mdt(T3t[c1], {c: "{:+.2f}" for c in c1[:7]} | {"expired worthless %": "{:.1f}"})))
G1 = bool(M1["volatility ann %"] > 0 and CI_V[0] > 0)
print(f"G1 {'PASS' if G1 else 'FAIL'}: volatility term {M1['volatility ann %']:+.2f}% a year, 95% {CI_V[0]:+.2f} to {CI_V[1]:+.2f} "
      f"(stationary blocks of {BLOCK_Q} quarters); one-sided p above zero {LUCK['p']:.3f}, Newey-West t {NW['t']:+.2f}; "
      f"the total's interval {CI_T[0]:+.2f} to {CI_T[1]:+.2f}. The carrier moved the book {CARRIER_ANN:+.2f}% a year: {LEVEL_ANN:+.2f}% "
      f"SOFR's level against bills (no foresight), {PATH_ANN:+.2f}% the reference quarter's own path, which the final settle knows. "
      f"On the no-foresight settle the volatility term is {MS['volatility ann %']:+.2f}%")
""", fig=("fig:s3-book", "Which term pays the seller on SR3's own settle?"))

# =====================================================================================================
# S4
# =====================================================================================================
md(r"""
## S4 · Robustness

| question | gates to S6 |
|---|---|
| Does the volatility term hold out of sample, after costs, against today's price of vol and a history-based one; does a rule or a hedge buy more per unit of stress; and how much did we try? | out of sample > 0; no cost cell turns it negative; break-even kappa below the low end of today's band; the MOVE-kappa run positive. A rule is adopted only if it improves the volatility term per unit of stress AND the drawdown per unit of stress |
""")
code(r"""
# ---- the volatility term against kappa, strike held at the kappa-1 rule; today's kappa from the owner's quote on the OBSERVED SR3 forward ----
KSW = np.round(np.arange(0.6, 1.41, 0.05), 2)
WINS = {"full SOFR window": None, f"since {SPLIT[:4]}": SPLIT}
SW = {w: [] for w in WINS}
for k in KSW:
    QD = run(kappa=k, kstrike=1.0)
    for w, a in WINS.items():
        SW[w].append(metrics(*cut(*QD, a, None))["volatility ann %"])
K_BE = {}
for w, ys in SW.items():
    ys = np.array(ys)
    i = np.where(np.diff(np.sign(ys)) > 0)[0]
    K_BE[w] = float(KSW[i[0]] - ys[i[0]] * (KSW[i[0] + 1] - KSW[i[0]]) / (ys[i[0] + 1] - ys[i[0]])) if len(i) else (np.nan if ys[0] < 0 else float(KSW[0]))

MCODE = {"H": 3, "M": 6, "U": 9, "Z": 12}
Z26 = tuple(pd.Timestamp(x) for x in RO.sr3_quarter(2000 + int(OWN_CONTRACT[4:6]), MCODE[OWN_CONTRACT[3]]))
bar = SR3BAR[OWN_CONTRACT][-1]
F_OBS = (100 - float(bar["close"])) * 100                       # the observed SR3 Dec-26 forward, bp (Yahoo [1])
K_OWN = (100 - OWN_K_PX) * 100
QUOTE_BP = OWN_PREM_USD / (OWN_LOTS * USD_PER_BP)
TAU_Z26 = (Z26[0] - TODAY).days / 365
KAPPA_BAND = [RO.implied_s(QUOTE_BP, F_OBS + dF, K_OWN, "put") / math.sqrt(TAU_Z26) / RV63.iloc[-1] for dF in (FWD_TOL_BP, 0, -FWD_TOL_BP)]
KAPPA_TODAY = KAPPA_BAND[1]
KMOVE = (MOVE / RV_LONG.reindex(MOVE.index)).rolling(21).median().clip(0.5, 2.5).reindex(DATES).ffill()
fig, ax = plt.subplots(figsize=(10.5, 4.6))
for (w, c_) in zip(WINS, (C_BOOK, C_DRIFT)):
    ax.plot(KSW, SW[w], color=c_, marker="o", ms=3, lw=1.6, label=f"{w}: break-even {K_BE[w]:.2f}")
ax.axvspan(min(KAPPA_BAND), max(KAPPA_BAND), color=C_VOL, alpha=0.18,
           label=f"today, the owner's quote on {OWN_CONTRACT} {bar['date']}: {min(KAPPA_BAND):.2f} to {max(KAPPA_BAND):.2f}")
ax.axhline(0, color=AXIS, lw=1)
ax.set_xlabel("kappa = implied / trailing realized vol (strike fixed)"); ax.set_ylabel("volatility term, % a year on USD 1M")
ax.legend(loc="upper left", fontsize=8, **LEG)
ask(ax, "How much volatility premium must the market pay on SOFR?", f"{WS} · {LOTS} lots, z {Z:g}; MOVE-implied kappa over the window averaged {KMOVE[(KMOVE.index >= WIN_FROM)].mean():.2f}")
plt.show()
""", fig=("fig:s4-kappa", "How much volatility premium must the market pay on SOFR?"))

code(r"""
# ---- out of sample, the MOVE-implied kappa, costs, timing, the ancestor's carrier and window ----
split = pd.Timestamp(SPLIT)
QO = cut(Q1, D1, split, None)
M_O = metrics(*QO)
M_I = metrics(*cut(Q1, D1, None, split))
QH, DH = run(kappa=1.0, kstrike=1.0, vol=RV63 * KMOVE)
M_H = metrics(QH, DH)
CS = {}
keep = SLIP_BP
for sl in (0.125, 0.25, 0.5, 1.0):
    SLIP_BP = sl
    CS[sl] = metrics(*run())["volatility ann %"]
SLIP_BP = keep
OFF = {o: score(f"offset {o}", run(offset=o))["volatility ann %"] for o in (0, 5, 10)}
for z in (0.5, 1.5):
    TRIALS[f"z {z}"] = metrics(*run(z=z))["vol term quarterly"]
QA, DA = run(carrier="bill", expiries=None)                   # research-001's book: bills, 1990 on
M_A = metrics(QA, DA)
fig, ax = plt.subplots(figsize=(10.5, 4.4))
po = QO[1] * LOTS
ax.plot(po.index, po.cumsum(), color=C_BOOK, lw=1.8, label=f"the book: {M_O['ann %']:+.2f}% a year")
ax.plot(po.index, (po - QO[0].attrs["dir"] * LOTS).cumsum(), color=C_VOL, lw=1.8, label=f"volatility term: {M_O['volatility ann %']:+.2f}%")
ax.axhline(0, color=AXIS, lw=1); ax.yaxis.set_major_formatter(KFMT); ax.set_ylabel("cumulative since the split, USD")
ax.legend(loc="upper left", fontsize=8, **LEG)
ask(ax, "Did it keep paying after the split?", f"{SPLIT} -> {WIN_TO:%Y-%m-%d}, {len(QO[0])} quarters, z {Z:g} fixed; in sample the volatility term was {M_I['volatility ann %']:+.2f}%")
plt.show()
ET = pd.DataFrame({n: {k: m[k] for k in ("ann %", "directional ann %", "volatility ann %", "max DD %", "quarters sold")}
                   for n, m in (("research-001's book: bills 1990 on", M_A), ("bills, the SOFR window, same trades", MB),
                                ("SOFR settle, the SOFR window (the book)", M1), (f"SOFR settle, in sample to {SPLIT[:4]}", M_I),
                                (f"SOFR settle, out of sample from {SPLIT[:4]}", M_O), ("SOFR settle, MOVE-implied kappa", M_H))}).T
ET.index.name = f"{LOTS} lots, kappa {KAPPA:g}"
display(Markdown(mdt(ET, {c: "{:+.2f}" for c in ET.columns[:4]} | {"quarters sold": "{:.0f}"})))
T2 = pd.DataFrame({"reading": {
    "slippage 0.125 / 0.25 / 0.5 / 1.0 bp, volatility term": " / ".join(f"{v:+.2f}%" for v in CS.values()),
    "entry 0 / 5 / 10 days after expiry, volatility term": " / ".join(f"{v:+.2f}%" for v in OFF.values()),
    "today's kappa (the owner's quote on the observed forward, +/- tolerance)": f"{KAPPA_TODAY:.2f} ({min(KAPPA_BAND):.2f} to {max(KAPPA_BAND):.2f}); MOVE-implied today {KMOVE.iloc[-1]:.2f}"}})
T2.index.name = "S4"
display(Markdown(mdt(T2)))
G2, G3 = bool(M_O["volatility ann %"] > 0), bool(min(CS.values()) > 0)
G4 = bool(np.isfinite(K_BE["full SOFR window"]) and K_BE["full SOFR window"] < min(KAPPA_BAND))
G5 = bool(M_H["volatility ann %"] > 0)
print(f"G2 {'PASS' if G2 else 'FAIL'} out of sample {M_O['volatility ann %']:+.2f}% · G3 {'PASS' if G3 else 'FAIL'} worst cost cell {min(CS.values()):+.2f}% · "
      f"G4 {'PASS' if G4 else 'FAIL'} break-even kappa {K_BE['full SOFR window']:.2f} vs today's low {min(KAPPA_BAND):.2f} · "
      f"G5 {'PASS' if G5 else 'FAIL'} MOVE-kappa run {M_H['volatility ann %']:+.2f}%")
""", fig=("fig:s4-oos", "Did it keep paying after the split?"))

code(r"""
# ---- a rule or a hedge, each read per unit of stress; one rule reads the FOMC record (no lookahead: the last decision before entry) ----
VARS = {"always, unhedged": (Q1, D1),
        "skip when > 1 hike priced (bills)": run(skip=lambda t0, F, s: F - SPOT3.get(t0, F) > 25),
        "skip when vol is rising": run(skip=lambda t0, F, s: RV21.get(t0, 0) > RV63.get(t0, 0)),
        "skip in an FOMC hiking regime": run(skip=lambda t0, F, s: regime(t0 - pd.Timedelta(days=1)) == "hiking"),
        "put spread 25 bp": run(width=25), "put spread 50 bp": run(width=50)}
R3 = {}
for k, QD in VARS.items():
    m = score(k, QD) if k != "always, unhedged" else M1
    st = max(-m["stress %"], 1e-9)
    R3[k] = {"ann %": m["ann %"], "volatility ann %": m["volatility ann %"], "max DD %": m["max DD %"], "stress %": -st,
             "quarters sold": m["quarters sold"], "vol term per 1% stress": m["volatility ann %"] / st, "max DD per 1% stress": m["max DD %"] / st}
T3 = pd.DataFrame(R3).T
T3.index.name = f"{LOTS} lots, kappa {KAPPA:g}"
b3 = T3.loc["always, unhedged"]
T3["adopted"] = ["base"] + [("yes" if (r["vol term per 1% stress"] > b3["vol term per 1% stress"] and r["max DD per 1% stress"] >= b3["max DD per 1% stress"]) else "no")
                            for _, r in T3.iloc[1:].iterrows()]
fig, (a0, a1) = plt.subplots(1, 2, figsize=(12.5, 4.2))
y_ = np.arange(len(T3))
cols_ = [C_BOOK] + [C_VOL if a == "yes" else C_COST for a in T3["adopted"].iloc[1:]]
a0.barh(y_, T3["vol term per 1% stress"], color=cols_)
a0.set_yticks(y_, T3.index); a0.invert_yaxis(); a0.axvline(0, color=AXIS, lw=1)
a0.set_xlabel("volatility term, % a year per 1% of stress")
ask(a0, "Which buys more premium per unit of risk?", f"{WIN_FROM:%Y-%m} -> {WIN_TO:%Y-%m}, SOFR settle · green = adopted")
a1.barh(y_, T3["max DD per 1% stress"], color=cols_)
a1.set_yticks(y_, [""] * len(y_)); a1.invert_yaxis()
a1.set_xlabel("max drawdown % per 1% of stress")
ask(a1, "At what drawdown?", "same rows")
plt.tight_layout(); plt.show()
display(Markdown(mdt(T3, {c: "{:+.2f}" for c in ("ann %", "volatility ann %", "max DD %", "stress %")}
                     | {"quarters sold": "{:.0f}", "vol term per 1% stress": "{:+.3f}", "max DD per 1% stress": "{:+.3f}"})))
ADOPT = [k for k, v in T3["adopted"].items() if v == "yes"]
BEST = max(ADOPT, key=lambda k: T3.loc[k, "vol term per 1% stress"]) if ADOPT else "always, unhedged"

# ---- how much we tried: the deflated Sharpe of the volatility term over every scored choice (per quarter) ----
uniq = {}
for k, v in TRIALS.items():
    v = np.asarray(v, float)
    if v.std() > 0:
        uniq.setdefault(round(float(v.mean() / v.std(ddof=1)), 6), v)
SRS = np.array(list(uniq))
N_T = len(SRS)
DSR = float(ST.dsr(list(VQ), N_T, float(SRS.var(ddof=1)))) if N_T > 1 else float("nan")
PSR = float(ST.psr(list(VQ)))
print(("adopted: " + ", ".join(ADOPT) + f"; S6 sizes {BEST}") if ADOPT else "nothing adopted; S6 sizes always-sell, unhedged")
print(f"volatility term per quarter: PSR {PSR:.2f} above zero, deflated Sharpe {DSR:.2f} over {N_T} distinct choices")

# ---- the same choices as the sweep's cells for the trial ledger (the Lab's TRIALS column): every scored choice, duplicates included ----
GRID = next(p for p in [Path.cwd(), *Path.cwd().parents] if (p / "lab" / "research").is_dir()) / "lab" / "research" / "data" / "grids" / f"{RUN_ID}.jsonl"
OK_ = {k: v for k, v in TRIALS.items() if len(v) >= 3 and np.std(v) > 0}
CELLS = [{"cell": {"variant": k}, "status": "kept", "returns": [round(float(x), 12) for x in v]} for k, v in OK_.items()]
DROP = [(k, "fewer than 3 quarters or a zero-variance path") for k in TRIALS if k not in OK_]
print(f"trial cells: {RUN_ID} already in {GRID.name}, not appended again (a run is written once)" if BU.read_trial_cells(GRID, RUN_ID)
      else BU.write_trial_cells(GRID, CELLS, DROP, run=RUN_ID))
""", fig=("fig:s4-rules", "Which rule or hedge buys more premium per unit of risk?"))

# =====================================================================================================
# S5
# =====================================================================================================
md(r"""
## S5 · Risk and diagnostics

| question | answer form |
|---|---|
| Which quarters hurt, what did the FOMC do in them, and what would a per-meeting "50+ bps increase" contract have paid on the record? How bad does the trade as sent get on today's prices? | the loss quarters with their decisions; tails and stress; the owner's trade on live Polymarket and the observed SR3 forward |

### S5.1 · The tail, quarter by quarter, against the FOMC record

A per-meeting "50+ bps increase" YES pays USD 1 on one decision of 50 bp or more. Below, the owner's size of it per
meeting (S1.1) is paid on the ACTUAL decisions between each entry and the option's expiry. Its PRICE is not modelled
here: what Polymarket and Kalshi charged for it is research-003 and research-002.
""")
code(r"""
HROWS = []
for r in Q1.itertuples():
    dd = DEC[(DEC.date > r.t0) & (DEC.date <= r.T)]
    HROWS.append({"T": f"{r.T:%Y-%m-%d}", "put P&L": r.pnl * LOTS if r.traded else 0.0, "YES paid": OWN_YES * int((dd.change_bp >= 50).sum()),
                  "decisions": " ".join(f"{c:+.0f}" for c in dd.change_bp if c != 0) or "-", "settle %": r.R / 100, "strike %": r.K / 100,
                  "regime": r.regime})
HT = pd.DataFrame(HROWS).set_index("T")
LOSSQ = HT[HT["put P&L"] < 0]
COVER = float(HT.loc[LOSSQ.index, "YES paid"].sum() / -LOSSQ["put P&L"].sum() * 100) if len(LOSSQ) else float("nan")
fig, ax = plt.subplots(figsize=(12.5, 4.6))
x = np.arange(len(HT))
ax.bar(x - 0.2, HT["put P&L"], width=0.4, color=np.where(HT["put P&L"] < 0, C_LOSS, C_BOOK), label=f"short put P&L, {LOTS} lots, SOFR settle")
ax.bar(x + 0.2, HT["YES paid"], width=0.4, color=C_HEDGE, label=f"'50+ bps increase' YES paid on the record, {OWN_YES:,} a meeting")
for i, (t, r) in enumerate(HT.iterrows()):
    if r["decisions"] != "-":
        ax.annotate(r["decisions"], (i, max(r["put P&L"], r["YES paid"], 0)), textcoords="offset points", xytext=(0, 3), ha="center", fontsize=6, rotation=90, color=INK)
ax.axhline(0, color=INK, lw=0.8)
ax.set_xticks(x[::2], [t[2:7] for t in HT.index[::2]], rotation=90, fontsize=7)
ax.yaxis.set_major_formatter(KFMT); ax.set_ylabel("USD per quarter")
ask(ax, "When the put lost, did a 50+ decision pay?", f"{WS} · labels: the decisions between entry and expiry, bp · the YES paid {COVER:.0f}% of the put losses, before its cost")
plt.show()
TS = ST.tail_stats(list(Q1.loc[Q1.traded, "pnl"] * LOTS / EQUITY * 100))
display(Markdown(f"**The {len(LOSSQ)} quarters the put lost** (P&L at {LOTS} lots, USD):\n\n"
                 + mdt(LOSSQ, {"put P&L": "{:,.0f}", "YES paid": "{:,.0f}", "settle %": "{:.3f}", "strike %": "{:.3f}"})
                 + f"\n\nQuarterly P&L on equity: VaR 95% {TS['VaR 95%']:+.2f}%, CVaR 95% {TS['CVaR 95%']:+.2f}%, skew {TS['skew']:+.2f}, "
                 f"kurtosis {TS['kurtosis']:.1f}, worst {TS['worst']:+.2f}%; the stress grid (forward against the book on entry day, vol x 1.5) "
                 f"loses {M1['stress %']:.2f}% of equity at its worst"))
""", fig=("fig:s5-tail", "When the put lost, did a 50+ decision pay?"))

md(r"""
### S5.2 · The trade as sent, on today's prices

The owner's trade: short 40 SR3 Dec-26 95.4375 puts, hedged with Polymarket "50+ bps increase" YES on the October and
December meetings (S1.1). The meeting dates are the Fed's own calendar; the forward is SR3Z26's archived close (Yahoo
`[1]`), beside the one Polymarket's decision markets imply on top of the latest SOFR.
""")
code(r"""
# ---- live Polymarket: the Fed-decision events for the next three meetings, and the rate-level ("hit before 2027") event ----
OUTV = {"50+ bps decrease": -50, "25 bps decrease": -25, "No change": 0, "25 bps increase": 25, "50+ bps increase": 50}
MEET = ["Oct", "Dec", "Jan"]
KDATE = {}
for m in NEXT:
    e = pd.Timestamp(m["end"])
    lab_ = {10: "Oct", 12: "Dec", 1: "Jan"}.get(e.month)
    if lab_ and lab_ not in KDATE:
        KDATE[lab_] = e
assert set(KDATE) == set(MEET), KDATE
PEV, LEVEL_EV, cur, pages = {}, None, None, 0
while pages < 40 and (len(PEV) < 3 or LEVEL_EV is None):
    pg = PM.events_keyset_raw(limit=100, cursor=cur, order="volume24hr", ascending=False, closed=False)
    for e in pg.get("events") or []:
        t = (e.get("title") or "").strip().lower()
        for m, word in (("Oct", "october"), ("Dec", "december"), ("Jan", "january")):
            if t == f"fed decision in {word}?":
                PEV[m] = e
        if t == "what will fed rate hit before 2027?":
            LEVEL_EV = e
    cur, pages = pg.get("next_cursor"), pages + 1
    if not cur:
        break
assert set(PEV) == set(MEET) and LEVEL_EV is not None, (sorted(PEV), LEVEL_EV is None)
PX = {}
for m in MEET:
    for mk in PEV[m]["markets"]:
        r = PM.parse_market(mk, PEV[m])
        if r["group_item_title"] in OUTV and not r.get("closed"):
            PX[(m, r["group_item_title"])] = r
PMID = {m: {o: 0.5 * (PX[(m, o)]["best_bid"] + PX[(m, o)]["best_ask"]) for o in OUTV} for m in MEET}
PN = {m: {o: v / sum(PMID[m].values()) for o, v in PMID[m].items()} for m in MEET}
EXPV = {m: sum(PN[m][o] * OUTV[o] for o in OUTV) for m in MEET}
KT = pd.DataFrame({m: {**{o: PMID[m][o] * 100 for o in OUTV}, "sum of mids": sum(PMID[m].values()) * 100, "expected move bp": EXPV[m]} for m in MEET}).T
KT.index = [f"{m} ({KDATE[m]:%Y-%m-%d})" for m in MEET]
KT.index.name = "meeting (Fed calendar)"
display(Markdown(f"**Polymarket 'Fed Decision in ...?' mids in cents, read {NOW:%Y-%m-%d %H:%MZ} [API].** Prices under 1c sit near the tick.\n\n"
                 + mdt(KT, {c: "{:.1f}" for c in KT.columns})))

S0R = SOFR.iloc[-1] * 100
UPPER0_PCT, LOWER0_PCT = float(TGT.hi.iloc[-1]), float(TGT.lo.iloc[-1])
W = {m: RO.reference_weight(KDATE[m], Z26[1], Z26[2]) for m in MEET}
F_PM = S0R + sum(EXPV[m] * W[m] for m in MEET)
CAL = {}
for name, F in ((f"{OWN_CONTRACT} archived close, {bar['date']} (Yahoo [1])", F_OBS), (f"latest SOFR {SOFR.index[-1]:%Y-%m-%d} + Polymarket's priced moves", F_PM)):
    sv = [RO.implied_s(QUOTE_BP, F + dF, K_OWN, "put") / math.sqrt(TAU_Z26) for dF in (-FWD_TOL_BP, 0, FWD_TOL_BP)]
    CAL[name] = {"forward %": F / 100, "strike above fwd, bp": K_OWN - F, "implied vol bp/yr": sv[1],
                 f"range, fwd +/-{FWD_TOL_BP:g} bp": f"{sv[2]:.0f} to {sv[0]:.0f}", "vs realized 63d": sv[1] / RV63.iloc[-1]}
CALT = pd.DataFrame(CAL).T
CALT.index.name = "the Dec-26 forward"
SIG_TODAY = list(CAL.values())[0]["implied vol bp/yr"]
WJ = W["Jan"]
display(Markdown(f"**What does the owner's {QUOTE_BP:.1f} bp at {OWN_K_PX} imply?** Target range {LOWER0_PCT:.2f}-{UPPER0_PCT:.2f}% "
                 f"(FRED, {TGT.index[-1]:%Y-%m-%d}), SOFR {SOFR.iloc[-1]:.2f}% on {SOFR.index[-1]:%Y-%m-%d} (NY Fed). Realized vol of the 3x6 bill "
                 f"forward is {RV63.iloc[-1]:.0f} bp/yr, MOVE {MOVE.iloc[-1]:.0f}. The option expires {Z26[0]:%Y-%m-%d}; the reference quarter runs "
                 f"{Z26[1]:%Y-%m-%d} -> {Z26[2]:%Y-%m-%d}, so January's move counts at weight {WJ:.3f} and is PRICED, not decided, on expiry.\n\n"
                 + mdt(CALT, {"forward %": "{:.4f}", "strike above fwd, bp": "{:.1f}", "implied vol bp/yr": "{:.0f}", "vs realized 63d": "{:.2f}"})))
""")

code(r"""
# ---- the 27 paths as the option settles: Oct and Dec DECIDED, January PRICED; at executable prices ----
HIKE50 = {m: PX[(m, "50+ bps increase")] for m in MEET}
book = {m: PM.book(HIKE50[m]["token_ids"][0]) for m in MEET}


def walk(bk, n, row, cap=WALK_CAP):
    # fill n YES up the ask ladder, no level above `cap`: (filled, average price, fee USD from the market's own fee fields)
    left, cost, fee = n, 0.0, 0.0
    for px, sz in bk["asks"]:
        if px > cap:
            break
        q = min(left, sz)
        cost += q * px
        fee += MATCH.pm_taker_fee(px, row.get("fee_rate"), row.get("fee_exponent"), row.get("fees_enabled"), contracts=q) or 0.0
        left -= q
        if left <= 0:
            break
    got = n - max(left, 0)
    return got, (cost / got if got else float("nan")), fee


EXE = {m: walk(book[m], OWN_YES, HIKE50[m]) for m in ("Oct", "Dec")}
HEDGE_EXEC = sum(g * p + f for g, p, f in EXE.values())
PREM_EXEC = OWN_PREM_USD - OWN_LOTS * (FEE_OPT + SLIP_BP * USD_PER_BP)
EXER = OWN_LOTS * (FEE_FUT + SLIP_FUT_BP * USD_PER_BP)
key = {0: "No change", 25: "25 bps increase", 50: "50+ bps increase"}
settle = lambda o, d, jp: S0R + o + d + WJ * jp


def net_exec(o, d, jp):
    R = settle(o, d, jp)
    loss = OWN_LOTS * USD_PER_BP * max(R - K_OWN, 0.0) + (EXER if R > K_OWN else 0.0)
    return PREM_EXEC - loss + OWN_YES * ((o >= 50) + (d >= 50)) - HEDGE_EXEC


P9 = pd.DataFrame([{"Oct / Dec decided": f"{o} / {d}", "P %": PN["Oct"][key[o]] * PN["Dec"][key[d]] * 100,
                    "YES paid USD": OWN_YES * ((o >= 50) + (d >= 50)), **{f"net, Jan priced +{jp}": net_exec(o, d, jp) for jp in (0, 25, 50)}}
                   for o in (0, 25, 50) for d in (0, 25, 50)]).set_index("Oct / Dec decided")
display(Markdown("The 27 rows at executable prices (premium after the CME fee card and one tick of slippage; YES at Polymarket's live asks "
                 "plus its fee; the futures fee card on exercise). The settle is today's SOFR plus the decided moves plus January's priced move "
                 "at its weight: SOFR's drift in its range is NOT in it (S2 measured it). P multiplies the two meetings as if independent [U].\n\n"
                 + mdt(P9, {"P %": "{:.1f}", "YES paid USD": "{:,.0f}", **{c: "{:,.0f}" for c in P9.columns if c.startswith("net")}})))
cells_ = P9[[c for c in P9.columns if c.startswith("net")]]
WORST27 = (cells_.stack().idxmin(), cells_.stack().min())
ARITH_OK = all(abs(a - b) < 1 for a, b in ((OWN_LOTS * QUOTE_BP * USD_PER_BP, OWN_PREM_USD), (2 * OWN_YES * OWN_YES_PX, OWN_HEDGE_USD)))
""")

code(r"""
# ---- what the 27 rows leave out, on one chart ----
X = []
for name, o, d, jp, note in (("-25 / -25 / -25", -25, -25, -25, "cuts: the puts expire, the YES cost is lost"),
                              ("75 / 25 / 0", 75, 25, 0, "a 75 bp hike: '50+' pays the same USD 1, the puts lose 25 bp more"),
                              ("75 / 75 / +50", 75, 75, 50, "a 2022-style run: the loss is linear, the hedge is capped"),
                              ("50 / 50 / +100", 50, 50, 100, "two 50s and a market pricing more on expiry")):
    X.append({"scenario (Oct / Dec / Jan priced)": name, "Z26 at expiry %": settle(o, d, jp) / 100,
              "YES paid USD": OWN_YES * ((o >= 50) + (d >= 50)), "net USD": net_exec(o, d, jp), "why it matters": note})
XT = pd.DataFrame(X).set_index("scenario (Oct / Dec / Jan priced)")
fig, ax = plt.subplots(figsize=(11, 5))
xr = np.linspace(S0R - 10, S0R + 190, 300)
puts = PREM_EXEC - OWN_LOTS * USD_PER_BP * np.maximum(xr - K_OWN, 0) - np.where(xr > K_OWN, EXER, 0)
for n_, c_, lab in ((0, C_COST, "no YES paid"), (1, C_HEDGE, "one YES paid"), (2, C_ALT, "both YES paid")):
    ax.plot(xr / 100, puts + n_ * OWN_YES - HEDGE_EXEC, color=c_, lw=1.8, label=f"net, {lab}")
    for o in (0, 25, 50):
        for d in (0, 25, 50):
            if (o >= 50) + (d >= 50) == n_:
                ax.scatter([settle(o, d, jp) / 100 for jp in (0, 25, 50)], [net_exec(o, d, jp) for jp in (0, 25, 50)], color=c_, s=24, zorder=5)
for nm, r in XT.iterrows():
    ax.annotate(nm, (r["Z26 at expiry %"], r["net USD"]), textcoords="offset points", xytext=(-8, 8), ha="right", fontsize=7, color=INK)
    ax.scatter([r["Z26 at expiry %"]], [r["net USD"]], facecolors="none", edgecolors=INK, s=50, zorder=6)
ax.axvline(K_OWN / 100, color=AXIS, ls=":", lw=1.2)
ax.axvline(F_OBS / 100, color=C_BOOK, ls="--", lw=1.0, label=f"{OWN_CONTRACT} forward today [1]")
ax.axhline(0, color=AXIS, lw=1)
ax.yaxis.set_major_formatter(KFMT)
ax.set_xlabel(f"SR3 Dec-26 at the {Z26[0]:%d %b} expiry, rate %"); ax.set_ylabel("net P&L at executable prices, USD")
ax.legend(loc="lower left", fontsize=8, **LEG)
ask(ax, "Where does the hedge stop matching the loss?", f"dots: the 27 rows; open circles: paths the table leaves out; strike {K_OWN / 100:.4f}% dotted; Polymarket read {NOW:%Y-%m-%d %H:%MZ}")
plt.show()
display(Markdown(mdt(XT, {"Z26 at expiry %": "{:.3f}", "YES paid USD": "{:,.0f}", "net USD": "{:,.0f}"})))
""", fig=("fig:s5-as-sent", "Where does the owner's hedge stop matching the loss?"))

# =====================================================================================================
# S6
# =====================================================================================================
md(r"""
## S6 · Decision

| question | decision rule |
|---|---|
| How many lots per USD 1M, and can the hedge be filled? | the most lots whose max drawdown stays inside the desk limit AND whose worst stress loss stays under the stress limit, solved; printed as INFORMATION ONLY unless G1 to G5 all passed. Each hedge leg fills fully within half a cent of the assumed price |
""")
code(r"""
Q4, D4 = VARS[BEST]
s_lot = stress_lot(Q4)
N_STRESS = STRESS_LIMIT_PCT / 100 * EQUITY / s_lot if s_lot > 0 else float("inf")
lo, hi = 1.0, 5000.0
for _ in range(40):
    mid = 0.5 * (lo + hi)
    lo, hi = (mid, hi) if metrics(Q4, D4, lots=mid)["max DD %"] > -DD_LIMIT_PCT else (lo, mid)
N_DD = lo
PICK = int(math.floor(min(N_STRESS, N_DD)))
BIND = "stress" if N_STRESS < N_DD else "drawdown"
LN = np.array([10, 20, 40, 80, 160, 320, 640])
LM = {n: metrics(Q4, D4, lots=n) for n in LN}
fig, ax = plt.subplots(figsize=(10, 4.4))
ax.plot(LN, [-LM[n]["stress %"] for n in LN], color=C_LOSS, marker="o", label="worst stress-grid loss %")
ax.plot(LN, [-LM[n]["max DD %"] for n in LN], color=C_BOOK, marker="o", label="max drawdown %")
ax.axhline(STRESS_LIMIT_PCT, color=C_LOSS, ls="--", lw=1.1, label=f"stress limit {STRESS_LIMIT_PCT:g}% [U]")
ax.axhline(DD_LIMIT_PCT, color=C_BOOK, ls="--", lw=1.1, label=f"drawdown limit {DD_LIMIT_PCT:g}% [U]")
ax.axvline(PICK, color=INK, ls=":", lw=1.2)
ax.text(PICK, ax.get_ylim()[1] * 0.92, f" {PICK} lots: {BIND} binds", fontsize=8, color=INK)
ax.set_xscale("log", base=2); ax.set_xticks(LN, [str(n) for n in LN])
ax.set_xlabel("lots per USD 1M"); ax.set_ylabel("% of equity"); ax.legend(loc="upper left", fontsize=8, **LEG)
ask(ax, "What binds as size grows?", f"{BEST} · {WS} · kappa {KAPPA:g} · information only unless G1-G5 pass")
plt.show()
M4 = metrics(Q4, D4, lots=PICK)
SIZED = G1 and G2 and G3 and G4 and G5
print(f"S6: {PICK} lots ({BEST}) - {BIND} binds; {M4['ann %']:+.2f}% a year, volatility term {M4['volatility ann %']:+.2f}%, "
      f"max drawdown {M4['max DD %']:.2f}%" + ("" if SIZED else ". INFORMATION ONLY: a gate of G1-G5 failed, NO SIZE"))
""", fig=("fig:s6-size", "What binds as size grows?"))

code(r"""
# ---- execution: the owner's legs on Polymarket's live books, January, the level strip, and CME puts as the cap ----
N_JAN = int(round(OWN_LOTS * USD_PER_BP * 50 * WJ))
gotJ, pxJ, feeJ = walk(book["Jan"], N_JAN, HIKE50["Jan"])
LV = {}
for mk in LEVEL_EV["markets"]:
    r = PM.parse_market(mk, LEVEL_EV)
    t = str(r["group_item_title"]).strip()
    if t.startswith("↑") and not r.get("closed"):
        LV[float(t.lstrip("↑ ").rstrip("%"))] = r
loss_at = lambda u: OWN_LOTS * USD_PER_BP * max(S0R + (u - UPPER0_PCT) * 100 - K_OWN, 0.0)
rungs = sorted(u for u in LV if loss_at(u) > 0)
STRIP, prev = [], 0.0
for u in rungs:
    n = int(round(loss_at(u) - prev))
    prev = loss_at(u)
    g, p, f = walk(PM.book(LV[u]["token_ids"][0]), n, LV[u])
    STRIP.append({"level": u, "contracts": n, "filled": g, "avg": p, "cost": g * p + f})
STRIP = pd.DataFrame(STRIP)
S_LO, S_HI = (RO.implied_s(QUOTE_BP, F_OBS + dF, K_OWN, "put") for dF in (FWD_TOL_BP, -FWD_TOL_BP))
JH = [{"hedge": f"Polymarket January '50+ bps increase' x {N_JAN:,}", "cost USD": gotJ * pxJ + feeJ, "cost over fwd band": "-",
       "filled below cap %": gotJ / N_JAN * 100 if N_JAN else np.nan, "worst loss left USD": np.nan}]
if len(STRIP):
    JH.append({"hedge": f"Polymarket 'hit {min(rungs):.2f}% ... {max(rungs):.2f}% before 2027' strip", "cost USD": STRIP.cost.sum(),
               "cost over fwd band": "-", "filled below cap %": STRIP.filled.sum() / STRIP.contracts.sum() * 100, "worst loss left USD": np.nan})
for w in (6.25, 12.5, 18.75, 25.0):
    k2 = K_OWN + w
    cst = lambda s_: OWN_LOTS * USD_PER_BP * float(RO.bachelier(F_OBS, k2, s_, "put")) + OWN_LOTS * (FEE_OPT + SLIP_BP * USD_PER_BP)
    c_mid = cst(SIG_TODAY * math.sqrt(TAU_Z26))
    JH.append({"hedge": f"buy {OWN_LOTS} Dec-26 {100 - k2 / 100:.4f} puts", "cost USD": c_mid, "cost over fwd band": f"{cst(S_LO):,.0f} to {cst(S_HI):,.0f}",
               "filled below cap %": np.nan, "worst loss left USD": OWN_LOTS * USD_PER_BP * w + EXER - (PREM_EXEC - c_mid)})
JHT = pd.DataFrame(JH).set_index("hedge")
CME = JHT[JHT.index.str.startswith("buy")]
REC = CME[CME["cost USD"] <= 0.5 * PREM_EXEC]["worst loss left USD"].idxmin() if (CME["cost USD"] <= 0.5 * PREM_EXEC).any() else CME["cost USD"].idxmin()
FILL = pd.DataFrame({m: {"size": n, "filled %": walk(book[m], n, HIKE50[m])[0] / n * 100, "avg price": walk(book[m], n, HIKE50[m])[1],
                         "vs assumed 1.5c": walk(book[m], n, HIKE50[m])[1] - OWN_YES_PX, "top ask size": book[m]["asks"][0][1] if book[m]["asks"] else 0}
                     for m, n in (("Oct", OWN_YES), ("Dec", OWN_YES), ("Jan", N_JAN))}).T
FILL.index.name = f"Polymarket '50+ bps increase', asks up to {WALK_CAP:.2f}"
display(Markdown(f"January size = {OWN_LOTS} lots x USD {USD_PER_BP:g} x 50 bp x {WJ:.3f}; it pays on {KDATE['Jan']:%d %b}, after the "
                 f"{Z26[0]:%d %b} expiry, so it works only if sold on expiry at whatever January is priced (untested [U]). The level strip buys, at each "
                 f"'hit X%' rung, the extra USD the puts lose between rungs (upper bound {UPPER0_PCT:.2f}% today): it pays on the December level, before "
                 "expiry. CME puts: Bachelier at the quote's implied vol on the observed forward, no skew, so a LOWER BOUND on cost [U]. Pick rule: the "
                 "smallest worst loss among puts costing at most half the premium.\n\n"
                 + mdt(JHT, {"cost USD": "{:,.0f}", "filled below cap %": "{:.0f}", "worst loss left USD": "{:,.0f}"})
                 + "\n\n" + mdt(FILL, {"size": "{:,.0f}", "filled %": "{:.0f}", "avg price": "{:.4f}", "vs assumed 1.5c": "{:+.4f}", "top ask size": "{:,.0f}"})))
GF = {m: bool(r["filled %"] >= 99.9 and r["vs assumed 1.5c"] <= 0.005 + 1e-9) for m, r in FILL.iterrows()}
print("fills: " + " · ".join(f"{m} {'PASS' if v else 'FLAG'}" for m, v in GF.items()) + " (CME SR3 option books are not in the fund [U])")
""")

# =====================================================================================================
# S7
# =====================================================================================================
md(r"""
## S7 · Verdict

The gates, the conclusion and the manifest are rendered below from the run's own objects; no number in them is typed.
""")
code(r"""
# ---- GATES: every gate as data; the table, S0 and the manifest render from it ----
pf = lambda b: "PASS" if b else "FAIL"
GATES = DGATES + [
    {"id": "G1", "section": "S3", "name": "a volatility premium at kappa 1 on SR3's SOFR settle, 95% interval excludes 0", "label": "Vol premium above 0",
     "reading": f"{M1['volatility ann %']:+.2f}% a year, 95% {CI_V[0]:+.2f} to {CI_V[1]:+.2f}; p above zero {LUCK['p']:.3f}",
     "threshold": "> 0 and the interval above 0", "verdict": pf(G1), "would_change": "more SOFR quarters, or observed SR3 option prices replacing the model"},
    {"id": "G2", "section": "S4", "name": f"the volatility term holds out of sample (from {SPLIT[:4]})", "label": "Out of sample", "reading": f"{M_O['volatility ann %']:+.2f}% over {len(QO[0])} quarters",
     "threshold": "> 0", "verdict": pf(G2), "would_change": "a second split; one is all the window carries"},
    {"id": "G3", "section": "S4", "name": "no cost cell turns the volatility term negative", "label": "Survives costs", "reading": " / ".join(f"{v:+.2f}%" for v in CS.values()),
     "threshold": "every cell > 0", "verdict": pf(G3), "would_change": "CME's own fee schedule replacing the [U] cards"},
    {"id": "G4", "section": "S4", "name": "today's price of vol clears the break-even", "label": "Clears break-even", "reading": f"break-even kappa {K_BE['full SOFR window']:.2f} vs today {min(KAPPA_BAND):.2f} to {max(KAPPA_BAND):.2f}",
     "threshold": "break-even below today's low", "verdict": pf(G4), "would_change": "an observed SR3 option chain instead of one quote"},
    {"id": "G5", "section": "S4", "name": "a history-based price of vol (MOVE-implied kappa) keeps it positive", "label": "MOVE-priced vol", "reading": f"{M_H['volatility ann %']:+.2f}%",
     "threshold": "> 0", "verdict": pf(G5), "would_change": "SR3 option history (none free, card cme history.options)"},
    {"id": "G6", "section": "S4", "name": "a rule or a hedge buys more premium per unit of stress", "label": "Skip rule", "reading": ", ".join(ADOPT) if ADOPT else "none adopted",
     "threshold": "better per unit of stress on premium AND drawdown", "verdict": "PASS" if ADOPT else "INFO", "would_change": "a longer SOFR window"},
    {"id": "G7", "section": "S6", "name": "size", "label": "Size rung", "reading": f"{PICK} lots per USD 1M ({BIND} binds)" if SIZED else f"information only: {PICK} lots ({BIND} binds)",
     "threshold": "only after G1-G5", "verdict": "PASS" if SIZED else "INFO", "would_change": "G1-G5 all passing"},
    {"id": "G8", "section": "S6", "name": "the owner's hedge legs fill near 1.5c on Polymarket's live books", "label": "Hedge fills", "reading": " · ".join(f"{m} {FILL.loc[m, 'filled %']:.0f}% at {FILL.loc[m, 'avg price'] * 100:.1f}c" for m in FILL.index),
     "threshold": "full fill within 0.5c", "verdict": "PASS" if all(GF.values()) else "FLAG", "would_change": "depth on the '50+ bps increase' books"}]
display(Markdown(REPORT.gate_table_md(GATES)))
WORD = "SIZE ON THE MODEL" if SIZED else "NO SIZE"
NEXT_BET = ("archive SR3 futures daily (fedpolicy.archive_sr3 on a schedule, the owner's call on Yahoo) so the entry forward stops being "
            "a bill proxy; then re-run this study with the observed forward from its first archived quarter")
WHY = [f"the volatility term on SR3's own settle is {M1['volatility ann %']:+.2f}% a year, 95% {CI_V[0]:+.2f} to {CI_V[1]:+.2f}, over {len(Q1)} quarters: {'it clears' if G1 else 'it does not clear'} zero",
       f"the carrier moved the book {CARRIER_ANN:+.2f}% a year against research-001's bill settle on the same trades, but SOFR's level against bills is only {LEVEL_ANN:+.2f}% of it: {PATH_ANN:+.2f}% is the reference quarter's path the final settle knows (2022's hikes), a property of the proxy, not of the market",
       f"the direction paid {M1['directional ann %']:+.2f}% a year: the lottery, not the craft",
       f"the SR3 forward is NOT observed: the strike and premium come from the bill curve, and the settle is SR3's final settlement applied at option expiry (perfect foresight of the futures)"]
CONC = {"verd": WORD, "ws": WS, "verify": f"verify {sum(CHK.values())}/{len(CHK)}", "ann": M1["ann %"], "dir": M1["directional ann %"], "vol": M1["volatility ann %"],
        "carrier": CARRIER_ANN, "basis": SETTLE_BASIS_BP, "cover": COVER, "loss_q": len(LOSSQ), "worst27": WORST27, "arith": ARITH_OK}
L = [f"**Verdict: {WORD}.** {WS}; {CONC['verify']}. One SOFR window of {YRS:.1f} years: one observation, however many quarters it holds.", ""]
L += [f"- **What the book made on SOFR:** {sgn(M1['ann %'])}% a year over the bill at {LOTS} lots, max drawdown {M1['max DD %']:.2f}%; "
      f"{sgn(M1['directional ann %'])}% of it is the direction and {sgn(M1['volatility ann %'])}% the volatility term. research-001's book on bills from "
      f"{QA.t0.min():%Y} made {sgn(M_A['ann %'])}% ({sgn(M_A['volatility ann %'])}% volatility term): the SOFR window is a different regime mix, not a replication.",
      f"- **The carrier:** on the same trades, SR3's final settle moved the book {sgn(CARRIER_ANN)}% a year against the bill settle, though it sat only "
      f"{sgn(SETTLE_BASIS_BP, 1)} bp from it on average. Split: {sgn(LEVEL_ANN)}% is SOFR's level against bills (the book settled on SOFR at expiry, no "
      f"foresight, makes {sgn(MS['ann %'])}%, volatility term {sgn(MS['volatility ann %'])}%) and {sgn(PATH_ANN)}% is the reference quarter's own path, "
      f"which a settle three months early could not know: the damage is 2022's hike quarters, not a level basis. The true SR3 price at expiry sits "
      f"between the two SOFR settles and is not observed. The FOMC's decisions explain each final settle to a median {SD.drift.abs().median():.1f} bp.",
      f"- **The tail is the FOMC's big moves:** the put lost in {len(LOSSQ)} of {len(Q1)} quarters; a per-meeting '50+ bps increase' YES at the owner's size would "
      f"have paid {COVER:.0f}% of those losses on the record, before its price (research-002, research-003).",
      f"- **Today's price:** the owner's {QUOTE_BP:.1f} bp at {OWN_K_PX} on the observed {OWN_CONTRACT} forward ({F_OBS / 100:.4f}%, {bar['date']}) implies kappa "
      f"{KAPPA_TODAY:.2f}; the SOFR window's break-even is {K_BE['full SOFR window']:.2f}.",
      f"- **The trade as sent:** the arithmetic {'checks' if ARITH_OK else 'does NOT check'}; worst of the 27 executable rows {WORST27[0][0]} with January "
      f"{WORST27[0][1].split('+')[1]}: {usd(WORST27[1])}; a 2022-style run nets {usd(XT.loc['75 / 75 / +50', 'net USD'])}. Cap it with CME puts "
      f"({REC}) or the level strip, not a per-meeting contract.",
      f"- **What this could not have detected:** a forward bias or a vol premium that lives in the SR3 market itself (its forward and its options "
      f"are not observed), and anything before 2018.",
      f"- **Next bet (printed, not registered):** {NEXT_BET}."]
display(Markdown("\n".join(L)))
print(f"metrics for remeasure.py: vol_term_ann_pct={M1['volatility ann %']:.3f} excess_ann_pct={M1['ann %']:.3f} "
      f"carrier_effect_ann_pct={CARRIER_ANN:.3f} settle_basis_bp={SETTLE_BASIS_BP:.2f} worthless_pct={M1['expired worthless %']:.2f} "
      f"max_dd_pct={M1['max DD %']:.3f} breakeven_kappa={K_BE['full SOFR window']:.3f}")
""")

code(r"""
# ---- the study manifest fund.study/1 (short_vol format): built by fundplat's report helpers, validated on build, S0 filled from it ----
FIG_TAGS = __FIGS__
p_ = D1 * LOTS
r_ = list(p_ / EQUITY)
PPY = len(D1) / ((D1.index[-1] - D1.index[0]).days / 365.25)
eqv = list(EQUITY + p_.cumsum())
tms = list(D1.index)
qp = Q1.loc[Q1.traded]
METRICS = {"ann_return_pct": M1["ann %"] + TB_ANN, "excess_vs_hurdle_pct": M1["ann %"], "ann_vol_pct": float(np.std(r_, ddof=1) * math.sqrt(PPY) * 100),
           "sharpe": ST.sharpe(r_, PPY), "sortino": ST.sortino(r_, PPY), "calmar": ST.calmar(r_, PPY), "psr": PSR, "dsr": DSR,
           "max_dd_pct": M1["max DD %"], "max_dd_days": ST.max_dd_days(eqv, tms), "n_periods": len(r_), "periods_per_year": PPY,
           "premium_ann_pct": M1["premium ann %"], "vrp_pts": None, "worthless_pct": M1["expired worthless %"],
           "worst_loss_x_premium": float((qp.pnl.min()) / (qp.prem * USD_PER_BP).mean()) if len(qp) else None,
           "var95_pct": TS["VaR 95%"], "cvar95_pct": TS["CVaR 95%"], "skew": TS["skew"], "kurtosis": TS["kurtosis"],
           "breakeven_kappa": K_BE["full SOFR window"], "stress_loss_pct": M1["stress %"], "recovery_days": ST.recovery_days(eqv, tms)}
NA = {"vrp_pts": "the premium is MODELLED at kappa x realized vol; no SR3 option prices exist in the fund (card cme history.options)"}
for k_ in ("calmar", "recovery_days", "breakeven_kappa", "dsr"):
    if METRICS[k_] is None or not np.isfinite(METRICS[k_]):
        NA[k_] = {"calmar": "no drawdown", "recovery_days": "the deepest drawdown had not recovered by the last day",
                  "breakeven_kappa": "the volatility term does not cross zero on the swept kappa range", "dsr": "one distinct trial"}[k_]
STUDY = REPORT.build_manifest(
    id=STUDY_ID, kind=KIND, desk=DESK, title=TITLE, question=QUESTION, status="registered",
    run={"executed": RUN_AT, "kernel": "ccvenv", "run_id": RUN_ID},
    window={"from": WIN_FROM.to_pydatetime(), "to": WIN_END.to_pydatetime(), "hours": int((WIN_END - WIN_FROM).days * 24), "regimes": int(N_REG)},
    verify={"suite": "rates_options verify + study checks", "passed": int(sum(CHK.values())), "total": len(CHK), "books": int(BOOKS[0])},
    gates=GATES, figures=[{"id": t_, "section": s_, "title": ti_} for t_, s_, ti_ in FIG_TAGS],
    verdict={"word": WORD, "why": WHY, "next_bet": NEXT_BET,
             "next": {"metric": "vol term on observed SR3 forwards", "predict": "n/a", "window": "from the first archived SR3 quarter"}},
    caveats=["one SOFR window (2018 on), one observation; research-001's 1990-2026 bill window is a different regime mix, not a replication",
             "the SR3 forward is NOT observed: entry forward, strike and premium come from the Treasury bill curve",
             "the settle is SR3's final settlement (compounded SOFR) applied at option expiry: a perfect-foresight proxy for the futures price then; SOFR at expiry held flat is the no-foresight bracket",
             "the premium is a model (Bachelier, kappa x realized vol, no skew); the multiplier and both CME fees are [U] cards",
             "daily marks are on the bill forward; the jump to the SOFR settle lands on the expiry day"],
    headline={"metric": "volatility term, % a year on equity (excess over the bill)", "label": "Vol term", "value": M1["volatility ann %"], "unit": "pct_ann", "hurdle": 0.0},
    components=[{"name": "premium collected", "usd": float((qp.prem * USD_PER_BP * LOTS).sum())},
                {"name": "carrier level: SOFR at expiry minus bill settle, same trades", "usd": float(((DS - DB) * LOTS).sum()), "ann_pct": LEVEL_ANN},
                {"name": "carrier path: final settle minus SOFR at expiry (the proxy's foresight)", "usd": float(((D1 - DS) * LOTS).sum()), "ann_pct": PATH_ANN},
                {"name": "directional term (the lottery)", "usd": float((Q1.attrs["dir"] * LOTS).sum()), "ann_pct": M1["directional ann %"]},
                {"name": "volatility term (the craft, costs in it)", "usd": float(p_.sum() - (Q1.attrs["dir"] * LOTS).sum()), "ann_pct": M1["volatility ann %"]}],
    format="short_vol", metrics=METRICS, na=NA,
    strategy={"name": "short SR3 hike-tail put", "thesis": "implied vol above what the rate then does: the volatility premium",
              "market": "rates", "instruments": ["SR3 quarterly options (CME)", "Polymarket Fed-decision contracts (the owner's hedge)"],
              "venues": ["cme", "nyfed", "polymarket"], "style": "short_vol"},
    rules={"entry": f"each quarterly expiry: sell the next put z {Z:g} SD above fwd",
           "exit": "hold to expiry; exercised futures closed at once", "sizing": f"{LOTS} lots per USD 1M (info only unless G1-G5 pass)",
           "rebalance": None, "hedge": "none in the base book", "hold": "sell every quarter", "stop": "none",
           "cost": f"USD {FEE_OPT:g} opt + {FEE_FUT:g} fut per lot, {SLIP_BP:g} bp slip [U]"},
    params={"lots": {"value": LOTS, "unit": "contracts", "source": "owner"}, "z": {"value": Z, "unit": "SD", "source": "[U]"},
            "kappa": {"value": KAPPA, "unit": "x realized", "source": "[U]"}, "usd_per_bp": {"value": USD_PER_BP, "unit": "USD", "source": CARD["USD per bp per contract"]["tag"]},
            "fee_option": {"value": FEE_OPT, "unit": "USD", "source": CARD["CME fee per option"]["tag"]}, "fee_futures": {"value": FEE_FUT, "unit": "USD", "source": CARD["CME fee per futures"]["tag"]},
            "slip_bp": {"value": SLIP_BP, "unit": "bp", "source": "[U]"}},
    profile={"market": "rates", "venues": ["cme", "nyfed", "polymarket"],
             "instruments": ["SR3 quarterly options", "Polymarket Fed contracts"], "bar": "1d"},
    book={"at": f"{LOTS} lots per USD 1M", "legs": [{"side": "SELL", "instrument": f"SR3 put, z {Z:g} SD", "qty": LOTS, "unit": "lots"}]},
    equity=[(t_, float(v_)) for t_, v_ in zip(tms, eqv)])
REPORT.validate_manifest(STUDY, tagged=[t_ for t_, _, _ in FIG_TAGS])
S0_HANDLE.update(Markdown(REPORT.summary_md(STUDY)))
display(REPORT.display_bundle(STUDY), raw=True)
""", tags=["manifest"])

md(r"""
## A · Appendix

n/a - nothing to detail beyond the figures above; research-001's own notebook sits beside this one in the family, `2026-09-27-xasset-sofr-hike-tail-put-bill.ipynb` (named `2026-09-sofr-tail-thesis` until 2026-09-28).
""")


# =====================================================================================================
def main() -> int:
    figs = repr([(t, s, ti) for t, s, ti in FIGS])
    for c in CELLS:
        if c.cell_type == "code" and "__FIGS__" in c.source:
            c.source = c.source.replace("__FIGS__", figs)
    nb = new_notebook(cells=CELLS, metadata={
        "kernelspec": {"name": "ccvenv", "display_name": "ccvenv", "language": "python"},
        "language_info": {"name": "python"}})
    t0 = __import__("time").time()
    tick = [t0]

    def done(cell, cell_index, execute_reply):
        now = __import__("time").time()
        print(f"  cell {cell_index} done in {now - tick[0]:.0f}s", flush=True)
        tick[0] = now

    NotebookClient(nb, timeout=5400, kernel_name="ccvenv", allow_errors=True, on_cell_executed=done,
                   resources={"metadata": {"path": str(HERE)}}).execute()
    errs = 0
    for i, c in enumerate(nb.cells):
        if c.cell_type != "code":
            continue
        for o in c.get("outputs", []):
            if o.get("output_type") == "error":
                errs += 1
                print(f"--- cell {i} ERROR {o['ename']}: {o['evalue']}")
                print("\n".join(o.get("traceback", [])[-6:]))
            elif o.get("output_type") == "stream":
                print(f"[{i}] " + o.get("text", "").rstrip()[:3000])
            if "data" in o and "image/png" in o["data"]:
                raw = base64.b64decode(o["data"]["image/png"])
                im = Image.open(io.BytesIO(raw)).convert("RGB").quantize(colors=256)
                buf = io.BytesIO()
                im.save(buf, format="PNG", optimize=True)
                o["data"]["image/png"] = base64.b64encode(buf.getvalue()).decode()
    nbformat.write(nb, NB)
    print(f"wrote {NB.name}: {NB.stat().st_size / 1e6:.2f} MB, {errs} errors, {__import__('time').time() - t0:.0f}s")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
