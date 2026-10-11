"""chart_smoke - one tiny synthetic input per chart type, so check_charts can RUN each chapter's draw_ function.

`SMOKE[slug]` is a list of `(case, factory)`; the factory returns the keyword arguments of the chapter's
`draw_` function. The data is seeded noise, 40 to 300 points, never a market: it proves the code runs and its figure
passes `figstyle.check`, not that a chart is right. A second case sits where the first would not reach a branch
(a one-cell grid, a chart without its optional panel).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from fundplat.quant.core import figstyle as fs

WINDOW = "Jan 01 - Jan 31 2026 · 720h · synthetic smoke input"
NOTES = ["First finding, with its interval and what would flip it.", "Second finding, one bullet each."]
ID = list(fs.IDENTITY.values())


def style():
    """The rcParams of a study's cell 8 (`figstyle.NAMES`): the chapters' code assumes them, as a notebook sets them before any figure."""
    n = fs.NAMES
    return {"figure.dpi": 110, "figure.facecolor": n["SURF"], "axes.facecolor": n["SURF"], "savefig.facecolor": n["SURF"], "font.size": 9.5, "axes.axisbelow": True,
            "axes.edgecolor": n["AXIS"], "axes.labelcolor": n["INK2"], "axes.titlecolor": n["INK"], "axes.titlesize": 11.5, "axes.titleweight": "bold", "axes.titlelocation": "left",
            "axes.grid": True, "grid.color": n["GRID"], "grid.linewidth": 0.7, "xtick.color": n["MUTED"], "ytick.color": n["MUTED"], "legend.frameon": False,
            "axes.spines.top": False, "axes.spines.right": False, "lines.linewidth": 1.8}


def _rng():
    return np.random.default_rng(7)


def _days(n=60):
    return pd.date_range("2026-01-01", periods=n, freq="D")


def _hours(n=240):
    return pd.date_range("2026-01-01", periods=n, freq="h")


def _trades(n=160):
    return _rng().normal(0.3, 2.0, n)


def series_and_distribution():
    r = _rng(); i = _hours()
    return dict(series={"funding": (pd.Series(r.normal(0.01, 0.02, len(i)), i), ID[0]), "premium": (pd.Series(r.normal(0, 0.03, len(i)), i), ID[1])},
                question="How has it moved, and how is it spread?", window=WINDOW, ylabel="rate, % an hour", bul=NOTES)


def win_loss():
    return dict(net=_trades(), notes=NOTES, window=WINDOW)


def equity(per=True, roll=None):
    r = _rng(); i = _days(); d = r.normal(5, 20, len(i))
    kw = dict(idx=i, net=np.cumsum(d), hurdle=np.cumsum(np.full(len(i), 2.0)), question="Does the rule make money after costs?", window=WINDOW,
              ylabel="cumulative P&L, USD", bul=NOTES, gross=np.cumsum(d + 3))
    if per:
        kw["per"] = (np.arange(1, len(i) + 1) if roll else i, d)
    if roll:
        kw["per_roll"] = roll
        kw["per_label"] = "net per trade, USD"
    return kw


def drawdown_and_tail():
    r = _rng(); i = _days(90)
    return dict(equity=pd.Series(1000 * np.cumprod(1 + r.normal(0.002, 0.01, len(i))), i), question="How deep and how long did it fall?", window=WINDOW, bul=NOTES)


def signal_decay():
    hz = np.array([1, 2, 4, 8, 16, 32.0]); m = 6 * np.exp(-hz / 12)
    return dict(hz=hz, mean=m, lo=m - 1.5, hi=m + 1.5, cost=1.0, question="How long does the response last?", window=WINDOW,
                xlabel="horizon, hours", ylabel="response, bp", bul=NOTES)


def calibration():
    p = np.linspace(0.05, 0.95, 10)
    return dict(price=p, hit=np.clip(p - 0.05, 0, 1), lo=np.clip(p - 0.12, 0, 1), hi=np.clip(p + 0.02, 0, 1), question="Are the prices calibrated?", window=WINDOW, bul=NOTES)


def rolling_statistics(win=True, beta=True):
    r = _rng(); i = np.arange(1, 121)
    kw = dict(sharpe=pd.Series(np.sin(i / 15) + 0.3, i), full_sharpe=0.3, window=WINDOW, notes=NOTES)
    if beta:
        kw.update(beta=pd.DataFrame({"BTC": 0.4 + 0.1 * np.sin(i / 20), "ETH": 0.2 + 0.05 * np.cos(i / 20)}, index=i), full_beta={"BTC": 0.4, "ETH": 0.2})
    if win:
        kw.update(won=pd.Series((r.random(len(i)) < 0.55).astype(float), i), roll=30, brk=0.5)
    return kw


def monte_carlo(stop=True):
    r = _rng()
    p = np.cumprod(1 + r.normal(0.001, 0.02, (300, 90)), axis=1)
    kw = dict(paths=np.hstack([np.ones((300, 1)), p]), limit=0.15, tol=0.05, window=WINDOW, notes=NOTES)
    if stop:
        kw["stop"] = 0.85
    return kw


def sample_funnel():
    return dict(steps=[("markets listed", 1000), ("with a book", 640), ("with a fill", 310), ("in the window", 120)], notes=NOTES, window=WINDOW)


def autocorrelation():
    r = _rng(); x = np.zeros(400)
    for k in range(1, 400):
        x[k] = 0.8 * x[k - 1] + r.normal()
    return dict(x=x, max_lag=40, step_h=1.0, notes=NOTES, window=WINDOW)


def signal_outcome():
    r = _rng(); s = r.normal(size=300)
    return dict(signal=s, outcome=0.3 * s + r.normal(size=300), bins=10, xlabel="signal", ylabel="outcome, bp", notes=NOTES, window=WINDOW)


def clock_and_staleness():
    r = _rng(); i = _days(40); a = pd.Series(r.normal(0, 10, 40), i)
    return dict(marked={"close to close": a, "settled": a.shift(1).fillna(0)}, notes=NOTES, window=WINDOW)


def exposure_over_time():
    r = _rng(); t = _hours(120)
    return dict(t=t, legs={"leg A": pd.Series(1000 + r.normal(0, 50, 120), t), "leg B": pd.Series(-950 + r.normal(0, 50, 120), t)}, limit=300.0, notes=NOTES, window=WINDOW,
                stale={"leg A": pd.Series(r.random(120) * 2, t)})


def book_depth():
    r = _rng(); n_t, n_p = 80, 30
    return dict(t_s=np.arange(n_t) * 10.0, cell=r.random((n_t, n_p)) * 100, mid=0.5 + 0.01 * np.sin(np.arange(n_t) / 8), window=WINDOW, notes=NOTES)


def premium_over_realized():
    r = _rng(); t = _days(120)
    return dict(t=t, implied=20 + r.normal(0, 2, 120), realized=17 + r.normal(0, 3, 120), by_period={"Q1": 2.5, "Q2": 3.1, "Q3": 1.8}, notes=NOTES, window=WINDOW)


def gap_persistence():
    r = _rng()
    return dict(first=r.normal(0, 5, 30), second=r.normal(0, 5, 30), half_lives=np.append(r.random(29) * 40, np.nan), hours_apart=24.0, notes=NOTES, window=WINDOW)


def oos():
    r = _rng(); t = _days(80)
    return dict(t=t, net=r.normal(3, 10, 80), hurdle=np.full(80, 1.0), split=t[50],
                rows=[["In sample", "50", "30", "12.0", "150", "50", "PASS"], ["Out of sample", "30", "14", "6.0", "40", "30", "PASS"]],
                cols=["Segment", "Days", "Trades", "Net bp", "Net USD", "T-bill USD", "Verdict"], notes=NOTES, window=WINDOW)


def significance():
    return dict(null=_rng().normal(0, 1, 2000), observed=1.8, tests=[["Permutation p", "0.04", "< 0.10", "PASS"], ["Block bootstrap p", "0.08", "< 0.10", "PASS"]],
                notes=NOTES, window=WINDOW, xlabel="funding captured, USD")


def sample_size_power():
    n = np.arange(10, 200, 10.0); m = 40 / np.sqrt(n)
    return dict(n=n, mde=m, n_raw=120, n_eff=60, effect=5.0, unit="bp a day", table=([["raw", "120", "3.7"], ["effective", "60", "5.2"]], ["", "n", "detectable effect"]),
                findings=NOTES, question="How many independent days does the study need?", window=WINDOW, others={"a looser size": (m * 0.8, ID[3])})


def parameter_surface(one=False):
    if one:
        g = pd.DataFrame([[1.5]], index=pd.Index([2.0], name="entry z"), columns=pd.Index([10], name="half-life"))
        return dict(grid=g, chosen=(2.0, 10), hurdle=1.0, metric="net bp", window=WINDOW, notes=NOTES)
    g = pd.DataFrame(np.arange(25, dtype=float).reshape(5, 5) / 5 - 1, index=pd.Index([1, 1.5, 2, 2.5, 3.0], name="entry z"), columns=pd.Index([6, 8, 10, 12, 14], name="half-life"))
    return dict(grid=g, chosen=(2, 10), hurdle=0.0, metric="net bp", window=WINDOW, notes=NOTES)


def rule_comparison():
    return dict(names=["always on", "after 10:00", "stop at 3z"], net=[120.0, 150.0, 90.0], dd=[-60.0, -40.0, -30.0], notes=NOTES, window=WINDOW)


def factor_regression():
    est = pd.DataFrame({"coef": [4.0, 0.5, 0.2], "lo": [1.0, 0.3, -0.1], "hi": [7.0, 0.7, 0.5], "t": [2.6, 5.0, 1.3]}, index=["alpha", "market", "rates"])
    return dict(est=est, alpha="alpha", r2=0.31, hurdle=3.0, window=WINDOW, notes=NOTES)


def stress_windows(few=False):
    t = np.arange(1, 121.0)
    sh = {"crash": (20, 30), "delisting": (60, 66), "policy": (100, 108)}
    return dict(t=t, equity=np.cumsum(_rng().normal(2, 10, 120)), shocks={"crash": sh["crash"]} if few else sh, stop=-80.0, notes=NOTES, window=WINDOW)


def cost_sensitivity():
    c = np.array([0, 1, 2, 3, 4, 5.0])
    return dict(cost=c, nets={"all days": 500 - 60 * c, "out of sample": 200 - 35 * c}, hurdle=40.0, assumed=2.0,
                rows=[["0 s", "500", "PASS"], ["1 s", "350", "PASS"]], cols=["Delay", "Net USD", "Verdict"], notes=NOTES, window=WINDOW)


def capacity_curve():
    s = np.array([1, 2, 5, 10, 20, 50.0])
    return dict(size=s, net=5 - 0.12 * s, breakeven=41.0, clip=10.0, others={"before cost": (np.full(6, 5.0), ID[3])}, xlabel="clip, contracts", ylabel="net edge per trade, USD",
                table=([[f"{x:g}", f"{5 - 0.12 * x:.2f}"] for x in s], ["Clip", "Net edge"]), findings=NOTES, question="How large can we trade before the edge is gone?", window=WINDOW)


def sizing_and_fill():
    return dict(rungs=["1x", "2x", "3x"], value=[9.0, 5.0, 2.0], threshold=4.0, higher_is_better=True, thr_label="required room", ylabel="room at the wick, %",
                table=([["1x", "9.0", "PASS"], ["2x", "5.0", "PASS"], ["3x", "2.0", "FAIL"]], ["Rung", "Room", "Rule"]), findings=NOTES,
                question="How far can the basis move against us at each size?", window=WINDOW, pick=1)


def hedge_and_basis():
    x = np.array([1, 4, 8, 24, 72.0])
    return dict(x=x, ratio=0.95 + 0.01 * np.log(x), held=(0.9, 1.1), others={"R-squared": (np.linspace(0.6, 0.9, 5), ID[3])},
                table=([["1 h", "0.95", "0.60"], ["72 h", "1.00", "0.90"]], ["Horizon", "Ratio", "R-squared"]), findings=NOTES, question="Does the hedge ratio hold across horizons?", window=WINDOW)


def regime_and_concentration():
    return dict(values=_trades(120), hurdle=5.0, top_k=5, notes=NOTES, window=WINDOW)


def fund_book_correlation():
    r = _rng(); i = _days(90)
    rets = pd.DataFrame({"study": r.normal(0, 0.01, 90), "carry": r.normal(0, 0.008, 90), "vol": r.normal(0, 0.012, 90)}, index=i)
    return dict(rets=rets, w=pd.Series({"study": 0.2, "carry": 0.5, "vol": 0.3}), study="study", ann=365, corr_limit=0.5, window=WINDOW, notes=NOTES)


def scenario_payoff():
    return dict(labels=["no hike", "25 bp", "50 bp"], parts={"put": np.array([-10.0, 20.0, 60.0]), "bill": np.array([5.0, 5.0, 5.0])}, net=np.array([-5.0, 25.0, 65.0]),
                table=([["no hike", "60%", "-10", "5", "-5"], ["25 bp", "30%", "20", "5", "25"], ["50 bp", "10%", "60", "5", "65"]], ["Outcome", "Chance", "put", "bill", "Net"]),
                findings=NOTES, question="What does each outcome pay?", window=WINDOW)


def trade_anatomy(many=False):
    r = _rng(); t = _hours(120); lvl = np.cumsum(r.normal(0, 1, 120)); sig = (lvl - lvl.mean()) / lvl.std()
    kw = dict(t=t, level=lvl, anchor=np.full(120, lvl.mean()), signal=sig, lines={"enter": 2.0, "exit": 0.5}, notes=NOTES, window=WINDOW)
    if many:
        kw.update(entry=[10, 50, 85], exit=[25, 70, 110], net=[12.0, -4.0, 9.0], side=[1, -1, 1], ref=(float(lvl.mean()), "price to beat"))
    else:
        kw.update(entry=10, exit=25, net=12.0)
    return kw


def mae_mfe():
    r = _rng(); n = 100
    return dict(mae=-np.abs(r.normal(3, 2, n)), mfe=np.abs(r.normal(4, 2, n)), net=r.normal(1, 3, n), notes=NOTES, window=WINDOW)


def pnl_attribution():
    return dict(parts={"funding": 120.0, "basis": -30.0, "fees": -25.0}, notes=NOTES, window=WINDOW, compare={"funding": 100.0, "basis": -10.0, "fees": -40.0})


def exit_reason():
    r = _rng(); n = 120
    return dict(reasons=r.choice(["target", "time", "stop", "flip", "end"], n), net=r.normal(0.5, 3, n), notes=NOTES, window=WINDOW)


def payoff_diagram():
    m = np.linspace(0, 10, 50)
    return dict(move=m, pnl=40 - 12 * m, stop=4.0, liq=8.0, notes=NOTES, window=WINDOW)


def live_candidates():
    return dict(rows=[["A", "0.52", "3.1", "TAKE"], ["B", "0.48", "2.0", "SKIP"]], cols=["Market", "Price", "Edge bp", "Rule"], read_at="2026-01-31 12:00 UTC [API]", notes=NOTES, window=WINDOW)


def trading_calendar():
    d = np.arange(1, 32)
    return dict(days=d, open_by_market={"NYSE": (d % 7) > 1, "KRX": (d % 7) != 3}, t=d, series=np.cumsum(_rng().normal(0, 1, 31)), notes=NOTES, window=WINDOW)


def cash_by_account():
    r = _rng(); t = _days(60)
    return dict(t=t, accounts={"broker": pd.Series(np.cumsum(r.normal(2, 8, 60)), t), "exchange": pd.Series(np.cumsum(r.normal(1, 5, 60)), t)},
                headroom=pd.Series(500 + np.cumsum(r.normal(0, 8, 60)), t), floor=300.0, notes=NOTES, window=WINDOW)


def quality_by_category():
    return dict(cats={"sports": 120, "crypto": 80, "politics": 40}, spread={"sports": 0.02, "crypto": 0.01, "politics": 0.04}, depth={"sports": 800.0, "crypto": 1500.0, "politics": 300.0},
                assumed=0.02, notes=NOTES, window=WINDOW)


def cross_venue_gap():
    r = _rng(); t = _hours(96); g = r.normal(1.5, 1.0, 60)
    return dict(gap=g, net=g - 0.8, t=t, widest={"pair A": pd.Series(r.normal(2, 1, 96), t), "pair B": pd.Series(r.normal(1, 1, 96), t)}, notes=NOTES, window=WINDOW)

def entry_map():
    r = _rng()
    hour = np.tile(np.arange(0, 24, 0.25), 6)                        # 96 windows, 3 lanes, 2 days
    lane = np.tile(np.repeat(["BTC", "ETH", "SOL"], 96), 2)
    day = np.repeat(["Oct 05", "Oct 06"], 288)
    return dict(day=day, hour=hour, lane=lane, status=r.choice([1, -1, 0], len(hour), p=[0.5, 0.4, 0.1]), be=0.52, notes=NOTES, window=WINDOW)


def lead_lag():
    lag = np.arange(-1000, 1001, 100.0); t = np.arange(0, 2001, 100.0)
    c = {"BTC": 0.4 * np.exp(-((lag - 300) / 350) ** 2), "ETH": 0.3 * np.exp(-((lag - 500) / 400) ** 2)}
    return dict(lag=lag, corr=c, lo={k: v - 0.04 for k, v in c.items()}, hi={k: v + 0.04 for k, v in c.items()},
                resp_t=t, resp={"BTC": 1 - np.exp(-t / 500), "ETH": 0.8 * (1 - np.exp(-t / 800))}, delay=250.0, notes=NOTES, window=WINDOW)


def steadiness():
    r = _rng(); n = 200; d = np.repeat(np.arange(40), 5)
    return dict(net=r.normal(0.4, 2.0, n), day=d, r2_min=0.8, others={"all coins": (r.normal(0.2, 2.5, n), d)}, notes=NOTES, window=WINDOW)


def dist_model():
    r = _rng()
    return dict(z=np.concatenate([r.normal(-0.6, 1.1, 150), r.standard_t(4, 30)]), cut=-2.0, notes=NOTES, window=WINDOW)


def leak():
    a = np.array([-18, -6, 0, 6, 18.0]); e = np.array([-0.2, 0.1, 0.4, 0.9, 2.1])
    return dict(ahead=a, edge=e, lo=e - 0.3, hi=e + 0.3, notes=NOTES, window=WINDOW)


def attr():
    r = _rng(); t = pd.date_range("2026-01-01", periods=60, freq="D")
    return dict(t=t, parts={"funding": r.normal(10, 4, 60), "basis": r.normal(0, 30, 60), "fees": -2.0 + r.normal(0, 0.3, 60), "other": r.normal(0, 5, 60)}, notes=NOTES, window=WINDOW)


def rebalance():
    r = _rng(); t = pd.date_range("2026-01-01", periods=240, freq="h")
    tg = 0.8 + 0.1 * np.sin(np.arange(240) / 30); held = np.empty(240); h = 0.8; ev = []
    for i in range(240):
        if abs(tg[i] - h) > 0.06:
            h = tg[i]; ev.append(i)
        held[i] = h
    return dict(t=t, target=tg, held=held, events=ev, cost=np.abs(r.normal(40, 15, len(ev))), band=0.06, limit=200.0, notes=NOTES, window=WINDOW)


def adverse():
    r = _rng()
    rows = [("the move after the fill, 5 s", 0.10, 0.45, -0.35, -0.62, -0.08), ("the settlement", 0.50, 0.52, -0.02, -0.15, 0.11), ("the first-minute mid", 0.2, 0.1, 0.10, -0.05, 0.26)]
    return dict(rows=rows, waits=r.gamma(2.0, 4.0, 300), notes=NOTES, window=WINDOW)


def slice():
    r = _rng(); rows = []
    for dim, levs in (("coin", ["BTC", "ETH", "SOL"]), ("hour", ["00-08", "08-16", "16-24"]), ("side", ["Up", "Down"])):
        for l in levs:
            v = float(r.normal(0.4, 0.5)); rows.append((dim, l, v, v - 0.6, v + 0.6, int(r.integers(40, 300)), v + 0.1))
    return dict(slices=rows, overall=0.35, notes=NOTES, window=WINDOW)


def selection():
    r = _rng(); fit = r.normal(0.5, 1.0, 120)
    return dict(fit=fit, hold=0.2 * fit + r.normal(0, 1, 120), luck=2.6, single=1.645, top=8, chosen=int(np.argmax(fit)), notes=NOTES, window=WINDOW)


def entry_time():
    r = _rng(); s = pd.date_range("2026-01-01", periods=150, freq="12h")
    v = np.cumsum(r.normal(0, 30, 150)) + 400
    return dict(start=s, value=v, registered=(s[0], float(v[0])), hurdle=100.0, notes=NOTES, window=WINDOW)


SMOKE = {
    "series-and-distribution": [("two series", series_and_distribution)],
    "win-loss-distribution": [("trades", win_loss)],
    "equity-curve": [("with the per panel", lambda: equity(True)), ("without it", lambda: equity(False)), ("per trade, rolling mean", lambda: equity(True, roll=20))],
    "drawdown-and-tail": [("daily equity", drawdown_and_tail)],
    "signal-decay": [("six horizons", signal_decay)],
    "calibration": [("ten bins", calibration)],
    "rolling-statistics": [("sharpe, betas, win rate", rolling_statistics), ("sharpe and betas", lambda: rolling_statistics(win=False)), ("win rate only", lambda: rolling_statistics(beta=False))],
    "monte-carlo-and-ruin": [("with a stop", monte_carlo), ("without", lambda: monte_carlo(False))],
    "sample-funnel-and-coverage": [("four steps", sample_funnel)],
    "autocorrelation": [("AR(1)", autocorrelation)],
    "signal-and-outcome-scatter": [("deciles", signal_outcome)],
    "clock-and-staleness": [("two markings", clock_and_staleness)],
    "exposure-over-time": [("two legs", exposure_over_time)],
    "book-depth-over-time": [("a ladder", book_depth)],
    "premium-over-realized": [("implied and realized", premium_over_realized)],
    "gap-persistence": [("thirty pairs", gap_persistence)],
    "out-of-sample-test": [("one split", oos)],
    "significance-test": [("a null", significance)],
    "sample-size-and-power": [("a curve", sample_size_power)],
    "parameter-surface": [("5 by 5", parameter_surface), ("one cell", lambda: parameter_surface(True))],
    "rule-comparison": [("three arms", rule_comparison)],
    "factor-regression": [("two factors", factor_regression)],
    "stress-windows": [("three shocks", stress_windows)],
    "cost-sensitivity": [("a sweep", cost_sensitivity)],
    "capacity-curve": [("six sizes", capacity_curve)],
    "sizing-and-fill": [("three rungs", sizing_and_fill)],
    "hedge-and-basis": [("five horizons", hedge_and_basis)],
    "regime-and-concentration": [("trades", regime_and_concentration)],
    "fund-book-correlation": [("three books", fund_book_correlation)],
    "scenario-payoff": [("three outcomes", scenario_payoff)],
    "trade-anatomy": [("one trade", trade_anatomy), ("three trades", lambda: trade_anatomy(True))],
    "mae-mfe": [("trades", mae_mfe)],
    "profit-and-loss-attribution": [("with a second variant", pnl_attribution)],
    "exit-reason-breakdown": [("four doors", exit_reason)],
    "payoff-diagram": [("a kink", payoff_diagram)],
    "live-candidates": [("two rows", live_candidates)],
    "trading-calendar": [("two markets", trading_calendar)],
    "cash-and-headroom-by-account": [("two accounts", cash_by_account)],
    "quality-by-category": [("three categories", quality_by_category)],
    "cross-venue-gap": [("two pairs", cross_venue_gap)],
    "entry-map": [("two days, three lanes", entry_map)],
    "lead-and-lag": [("two series", lead_lag)],
    "steadiness": [("one variant and a rival", steadiness)],
    "distribution-against-model": [("a heavy left tail", dist_model)],
    "leak-probe": [("five shifts", leak)],
    "attribution-over-time": [("four parts", attr)],
    "rebalance-path": [("five rebalances", rebalance)],
    "adverse-selection": [("three measures", adverse)],
    "edge-by-slice": [("three dimensions", slice)],
    "selection-check": [("120 tries", selection)],
    "entry-time-sensitivity": [("150 re-runs", entry_time)],
}
