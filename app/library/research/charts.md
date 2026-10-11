---
topics: [charts]
type: guide
---

# The chart bank

One chapter per TYPE of chart a study can draw: the question it answers, what to feed it, how to draw and read it, and the code that draws it. A chapter holds a framework and its code, never a gallery: one exemplar per type, no repeats, and the types no study has drawn yet are here too with `Exemplar: none yet`. The chapters sit in three family books so each stays small: `charts-describe.md` (the shape of a series or a run), `charts-test.md` (is a result real) and `charts-trade.md` (can it be traded). This file is the guide and the type list. Kept by `research`; the Research room's Charts view reads all four.

## How the bank works

Read when: about to draw a chart in a study, add a chart type, or tag a figure in a manifest.

- **Pick the type first.** Find the chapter whose question is yours (the table below names its category and its book), copy its code into the figure cell, feed it the notebook's own data. No `fundplat` function draws a chart.
- **A manifest figure carries its type:** `figures[].kind` is the chapter's heading slug (`equity-curve`). An older notebook gains it at its next re-run, never by a hand edit.
- **A type is here because a study drew it, or because it was researched and is waiting for one.** `none yet` marks a type with a chapter and no drawing; a note in brackets after it may say what the first drawing needs. The refused ones are in the last table of `The types`, so nobody re-reads the field to find them again.
- **One exemplar per type,** a real chart named by study stem and figure id. `none yet` is an open invitation: the first study that draws it fills the line in the same commit.
- **A new type is a new chapter** in its family's book, same shape, under 900 tokens, plus a row in the table below. The figure rules bind every snippet (`research.md#figures-one-meaning-per-colour`).
- **A chapter draws the advanced form** (`research.md#what-makes-a-figure-advanced`): at least three of an interval, a stability split, a decision line, a second panel and a tail number. A bare bar, histogram or line is not a chapter. The exemplar is a real study figure, never a mock.
- **The frame is shared.** Every chapter's code imports the helpers below (`boot`, `frame`, `panel`, `band`, `decision`, `vdecision`, `close`); copy that block into the notebook's figure cell once. Unenforced: `figstyle` has no `frame()` yet, so the block is hand-copied.
- **Each chapter carries a `Category:` line** under its `Read when:`, one of eight by the question a reader arrives with (the closed list below); the Charts view groups on it and the table repeats it.
- Held by `platform/research/check_charts.py` (run by `tools/lint.py`): it parses each chapter and RUNS its `draw_` function on a tiny synthetic input (`platform/research/chart_smoke.py`), then puts the figure through `figstyle.check`. A new chapter ships its smoke input in the same commit, or the checker names it. The run proves the code executes and obeys the figure rules, not that the chart is right.

### The frame

Read when: about to draw any chart in the bank (every chapter's code calls these).

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs

N, Q, V, I = fs.NEUTRAL, fs.QUANTITY, fs.VERDICT, fs.IDENTITY


def boot(x, stat=np.mean, n=4000, seed=11):
    """Bootstrap draws of a statistic: the interval every estimate ships with (95% = the 2.5 and 97.5 percentiles)."""
    r = np.random.default_rng(seed)
    x = np.asarray(x, float)
    return np.array([stat(x[r.integers(0, len(x), len(x))]) for _ in range(n)])


def frame(question, window, notes, h=5.6, nrow=1, ncol=1, top=0.83, **kw):
    """The house canvas: the question as the title, the window under it, findings below. Returns (fig, axes grid)."""
    nb = fs.nlines(notes)
    fig, axs = plt.subplots(nrow, ncol, figsize=(13, h + nb * 0.205), squeeze=False)
    fig.subplots_adjust(left=0.07, right=0.97, top=top, bottom=fs.bullet_margin(fig, nb) + 0.10, **kw)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    for a in axs.ravel():
        a.spines[["top", "right"]].set_visible(False)
        a.tick_params(labelsize=8.5)
    return fig, axs


def panel(ax, title, xlabel=None, ylabel=None):
    """A panel's caption, top-left, in ink: the reader never guesses which panel is which."""
    ax.set_title(title, fontsize=10, loc="left", pad=6, color=N["ink"])
    ax.set_xlabel(xlabel or "", fontsize=9)
    ax.set_ylabel(ylabel or "", fontsize=9)


def band(ax, x, lo, hi, colour, label=None):
    ax.fill_between(x, lo, hi, color=colour, alpha=0.16, linewidth=0, label=label)


def decision(ax, y, label):
    """A threshold on the Y axis (a hurdle, a cost, a rate): ink, dotted, labelled."""
    ax.axhline(y, color=N["ink"], linewidth=1.1, linestyle=(0, (1, 2.4)))
    ax.annotate(label, (ax.get_xlim()[1], y), xytext=(-4, 4), textcoords="offset points", ha="right", fontsize=8.5)


def vdecision(ax, x, label):
    """A threshold on the X axis (a drawdown limit, a stop, a break-even size): pick by where the threshold lives."""
    ax.axvline(x, color=N["ink"], linewidth=1.1, linestyle=(0, (1, 2.4)))
    ax.annotate(label, (x, ax.get_ylim()[1]), xytext=(4, -4), textcoords="offset points", ha="left", va="top", fontsize=8.5)


def close(fig, notes, kind, top=0.86, **kw):
    """Findings below, then the house check (colour, question title, window hours, tables, axes), then return the figure."""
    fs.finish(fig, notes, top=top, **kw)
    fs.check(fig, kind)
    return fig
```

## The types

Read when: about to pick the type of a chart.

| Type | Kind id | Category | Book | Exemplar |
|---|---|---|---|---|
| Series and distribution | `series-and-distribution` | The run | `charts-describe.md` | none yet |
| Win/loss distribution | `win-loss-distribution` | The run | `charts-describe.md` | none yet |
| Equity curve | `equity-curve` | The run | `charts-describe.md` | none yet |
| Drawdown and tail | `drawdown-and-tail` | The run | `charts-describe.md` | none yet |
| Signal decay | `signal-decay` | The edge | `charts-describe.md` | none yet |
| Calibration | `calibration` | The edge | `charts-describe.md` | none yet |
| Rolling statistics | `rolling-statistics` | The run | `charts-describe.md` | none yet |
| Monte Carlo and ruin | `monte-carlo-and-ruin` | The luck | `charts-describe.md` | none yet |
| Sample funnel and coverage | `sample-funnel-and-coverage` | The data | `charts-describe.md` | none yet |
| Autocorrelation | `autocorrelation` | The edge | `charts-describe.md` | none yet |
| Signal and outcome scatter | `signal-and-outcome-scatter` | The edge | `charts-describe.md` | none yet |
| Clock and staleness | `clock-and-staleness` | The data | `charts-describe.md` | none yet |
| Exposure over time | `exposure-over-time` | The book | `charts-describe.md` | none yet |
| Book depth over time | `book-depth-over-time` | Size and cost | `charts-describe.md` | none yet |
| Premium over realized | `premium-over-realized` | The edge | `charts-describe.md` | none yet |
| Gap persistence | `gap-persistence` | The edge | `charts-describe.md` | none yet |
| Entry map | `entry-map` | The run | `charts-describe.md` | none yet |
| Lead and lag | `lead-and-lag` | The edge | `charts-describe.md` | none yet |
| Steadiness | `steadiness` | The run | `charts-describe.md` | none yet |
| Distribution against model | `distribution-against-model` | The edge | `charts-describe.md` | none yet |
| Leak probe | `leak-probe` | The data | `charts-describe.md` | none yet |
| Out-of-sample test | `out-of-sample-test` | The luck | `charts-test.md` | none yet |
| Significance test | `significance-test` | The luck | `charts-test.md` | none yet |
| Sample size and power | `sample-size-and-power` | The luck | `charts-test.md` | none yet |
| Parameter surface | `parameter-surface` | The choice | `charts-test.md` | none yet |
| Rule comparison | `rule-comparison` | The choice | `charts-test.md` | none yet |
| Factor regression | `factor-regression` | The luck | `charts-test.md` | none yet |
| Stress windows | `stress-windows` | The luck | `charts-test.md` | none yet |
| Selection check | `selection-check` | The choice | `charts-test.md` | none yet |
| Entry-time sensitivity | `entry-time-sensitivity` | The luck | `charts-test.md` | none yet |
| Cost sensitivity | `cost-sensitivity` | Size and cost | `charts-trade.md` | none yet |
| Capacity curve | `capacity-curve` | Size and cost | `charts-trade.md` | none yet |
| Sizing and fill | `sizing-and-fill` | Size and cost | `charts-trade.md` | none yet |
| Hedge and basis | `hedge-and-basis` | The book | `charts-trade.md` | none yet |
| Regime and concentration | `regime-and-concentration` | The run | `charts-trade.md` | none yet |
| Fund-book correlation | `fund-book-correlation` | The book | `charts-trade.md` | none yet |
| Scenario payoff | `scenario-payoff` | The trade | `charts-trade.md` | none yet |
| Trade anatomy | `trade-anatomy` | The trade | `charts-trade.md` | none yet |
| MAE/MFE | `mae-mfe` | The trade | `charts-trade.md` | none yet |
| Profit and loss attribution | `profit-and-loss-attribution` | The run | `charts-trade.md` | none yet |
| Exit-reason breakdown | `exit-reason-breakdown` | The trade | `charts-trade.md` | none yet |
| Payoff diagram | `payoff-diagram` | The trade | `charts-trade.md` | none yet |
| Live candidates | `live-candidates` | The trade | `charts-trade.md` | none yet |
| Trading calendar | `trading-calendar` | The data | `charts-trade.md` | none yet |
| Cash and headroom by account | `cash-and-headroom-by-account` | The book | `charts-trade.md` | none yet |
| Quality by category | `quality-by-category` | Size and cost | `charts-trade.md` | none yet |
| Cross-venue gap | `cross-venue-gap` | Size and cost | `charts-trade.md` | none yet |
| Attribution over time | `attribution-over-time` | The run | `charts-trade.md` | none yet |
| Rebalance path | `rebalance-path` | The book | `charts-trade.md` | none yet |
| Adverse selection | `adverse-selection` | The trade | `charts-trade.md` | none yet |
| Edge by slice | `edge-by-slice` | The run | `charts-trade.md` | none yet |

### The eight categories

Read when: about to pick a type by the question in your head, or to name the category of a new chapter.

| Category | The reader arrives asking | Types |
|---|---|---|
| The run | Did it make money, and how did it arrive? | 11 |
| The edge | Is the signal real, and how long does it last? | 8 |
| The luck | Could this be chance? | 7 |
| The choice | Was the setting chosen, or found? | 3 |
| The trade | What one position did, from signal to exit? | 7 |
| Size and cost | Can we trade it at size, and at what cost? | 6 |
| The book | What the fund is holding? | 5 |
| The data | Is the number measuring the market? | 4 |

The closed list is `check_charts.CATEGORIES`; the app reads the same eight in `app/shared/research.ts`.

### Folded into another type

Five types were cut in a review of the bank because each drew the survivor's data with one element more. Nobody re-adds them; a manifest `kind` that names one is a `kind` fault and is re-tagged at the study's next re-run.

| Type | Folded into | What moved |
|---|---|---|
| Rolling win rate | Rolling statistics | the win rate is a panel on the same trade index (`won`, `roll`, `brk`) |
| Per-trade PnL over time | Equity curve | the `per` panel draws the bars; `per_roll` adds the rolling mean |
| Path fan | Monte Carlo and ruin | the stop is a parameter of the scored chart (`stop`), beside the 25 to 75 band |
| Assumption sensitivity | Parameter surface | the same net-minus-hurdle map for two unmeasured inputs; the study's assumption is the chosen cell, tagged [U] |
| Trade marks | Trade anatomy | every trade on the series: `entry`, `exit`, `net`, `side` as arrays, `ref` for the reference price |

### Drawn in a study, held by an existing chapter

Read when: about to add a chart type because a study draws something the table does not name, or to tag a figure whose drawing is not obvious.

An audit of study notebooks' figure cells and manifests added types to the bank and found the drawings below to be variants of a type that already exists: pass the chapter's inputs, do not add a type. A manifest `kind` is the chapter's slug; a figure tagged with another one is re-tagged at its study's next re-run.

| What the study draws | Held by | How |
|---|---|---|
| Entry price against time, a marker per side, win or loss | `Trade anatomy` | the many-trade form: `entry`, `side`, `net`; `ref` is the break-even price |
| One window, one day, one signal on the clock; the order ladder at each entry | `Trade anatomy`, `Book depth over time` | the depth panel is the heat map; the ladder pages are the walk of the order, not a type |
| Win share against price paid, break-even tick, by band | `Calibration` | `price` is the price paid plus fee; the tick is the break-even share |
| Edge or net against hold, order delay, or offset around a signal | `Signal decay` | the x axis is the delay or the offset; negative offsets show what moved first |
| Mean return by decile of a feature, share that go on after a break | `Signal and outcome scatter` | `bins` quantile bins |
| Equity by instrument, net by day, net by time bucket | `Equity curve`, `Regime and concentration` | one panel an instrument; `rank=False` for days and buckets |
| Tests side by side with an interval, win rate against the win rate its payoff needs, models or benchmarks | `Rule comparison` | arms are the tests; a bar with no interval is redrawn with one |
| Why a window did not enter; entry rate by hour, lane or time left | `Sample funnel and coverage` | the steps are the reasons |
| Money of one entry from signal to settlement; edge against friction by week or by lookback | `Profit and loss attribution`, `Attribution over time` | `parts` per entry; per week is `parts` per period |
| Log-loss gain of a signal over the state, by time left | `Factor regression` | the state is the factor; `est` rows are the time-left buckets |
| Share of the edge in the best few minutes | `Regime and concentration` | the running line is the share curve |
| Hedge coverage by quarter; a policy rate's move against the market's forecast by meeting | `Hedge and basis`, `Calibration` | per period or event, one unit |
| Which leg closes a gap, by state | `Profit and loss attribution` | `parts` are the legs' responses with their t |
| Risk against size with the limits and the binding size; the cost of a fill against the clip | `Sizing and fill`, `Capacity curve` | `thr_label` names each limit |
| Basis jump against hours shut; a day against the next | `Clock and staleness` | the x is the gap between prints |
| Net against one input the study could not measure (a premium multiple, queue position) | `Parameter surface` | one-column grid, the chosen value marked [U] |
| Two bars of two numbers; a table as the whole figure | none: see the refused table | redraw as the per-outcome dumbbell or return the table to the cell |

### Researched and refused

A survey of public funding and basis notebooks and a read of the tearsheet tools drew these, and they have no chapter. A chart is kept for the question it forces. The reasons: 1 one window (a spread over configurations is one observation re-sliced), 2 one subject (breadth, small multiples, venue picks), 3 two clocks (a dual axis), 4 no decision behind it.

| Chart | Reason | Reopens when |
|---|---|---|
| Dual-axis price against cumulative funding | 3 | never: stacked panels on a shared x |
| Box or strip of Sharpe across configurations | 1 | the configurations are separate windows |
| Universe breadth over time, small multiples per asset | 2 | a study holds a basket |
| Q-Q plot against the normal | 4 | a downstream step assumes normality |
| Position-state ribbon over price | 4 | the ribbon decides something the rule table does not |
| Candlestick bars of a rate | 4 | never: it hides the hourly cadence |
| Pie of venue usage, cross-venue band chart, ranked arbitrage table | 2 | a screener, not a study (a dashboard's) |
| Monthly returns heatmap, calendar-year return bars, return quantiles by period (the tearsheet tools: QuantStats, pyfolio) | 1 | the window spans several full years |
| Rolling beta against a benchmark | 4 | a benchmark decides something; `Factor regression` and `Rolling statistics` hold the form |
| Order-book screenshot | 4 | never: `Live candidates` and the gate 5 table carry the number |
| Two bars of two quotes (venue A pays, venue B charges) | 4 | never: the per-outcome dumbbell (`Cross-venue gap`) carries it with the gap and the count |
| A table drawn as the whole figure | 4 | never: a table is a cell's output; a figure carries a panel with the table as its second part |
