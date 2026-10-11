---
topics: [charts]
type: guide
---

# Charts: testing a result

These types ask whether a result is real: held-out data, luck, sample size, a fragile parameter, a rival rule, a factor explanation. The bank's guide, the type list and the rules are in `charts.md`.

## Out-of-sample test

Read when: you have a result on the study window and must show it holds on days the rule was not set on (in-sample against out-of-sample, by week, or by halves).

Category: The luck

- **Question:** Does the rule work out of sample?
- **Inputs:** `t` (bar times), `net` and `hurdle` (per-bar net P&L and T-bill accrual, USD), `split` (first out-of-sample time), `rows` and `cols` (the one table: segment, days, trades, net bp, net USD, T-bill USD, PASS or FAIL last; at most nine columns), `key` (a (row, col) to gold), `notes`, `window` (dates, hours, regime, verify() count).
- **How to draw:**
  - One axes, time on x. Each segment's net is cumulated from zero: in-sample muted grey, out-of-sample ink, both solid; its T-bill is ink dotted. Fill between them: green above, red below (sign only). The split is an ink vertical, out-of-sample days shaded grey.
  - A bold PASS or FAIL (green or red) at the top right. Legend `loc='best'`, never over a line.
  - Table under the axes: verdict cells green or rose, the finding's number gold; findings as bullets. By week: a row per week, weekly net as bars; by halves: `split` at the midpoint.
- **How to read it:** Pass: the out-of-sample curve ends above its T-bill line and the table says PASS. Fail: it ends below, the red fill is larger, or too few trades back the segment (say so). A split made after seeing the whole window checks the settings, not the idea.
- **Pairs with:** gate 2 (step 2 of `research.md#six-gates-size-last`): out-of-sample above the hurdle. A fail ends the notebook with no sizing.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np, pandas as pd
from fundplat.quant.core import figstyle as fs


def draw_out_of_sample_test(t, net, hurdle, split, rows, cols, notes, window, question="Does the rule work out of sample?", key=None):
    N, V = fs.NEUTRAL, fs.VERDICT
    t, net, hurdle = pd.DatetimeIndex(t), np.asarray(net, float), np.asarray(hurdle, float)
    fig, gs, ax, axt = fs.fig_tab(5.2, (2.6, 1.0), nb=fs.nlines(notes))
    ax.axvspan(split, t[-1], color=N["axis"], alpha=0.22, linewidth=0)
    for m, col, lab, hl in ((t < split, N["muted"], "in-sample net", None), (t >= split, N["ink"], "out-of-sample net", "T-bill")):
        c, h = np.cumsum(net[m]), np.cumsum(hurdle[m])
        ax.plot(t[m], c, color=col, linewidth=2.4, label=lab)
        ax.plot(t[m], h, color=N["ink"], linewidth=1.3, linestyle=":", label=hl)
        for w, k, a in ((c >= h, "good", 0.16), (c < h, "bad", 0.22)):
            ax.fill_between(t[m], c, h, where=w, interpolate=True, color=V[k], alpha=a, linewidth=0)
    ax.axhline(0, color=N["axis"], linewidth=1); ax.axvline(split, color=N["ink"], linewidth=1.2)
    ok = rows[-1][-1] == "PASS"
    ax.text(1, 1.012, "PASS: net beats the T-bill" if ok else "FAIL: net trails the T-bill", transform=ax.transAxes, ha="right", color=V["good" if ok else "bad"], fontsize=9.5, weight="bold")
    ax.set_ylabel("cumulative P&L, USD")
    ax.legend(loc="best", facecolor=N["surface"], edgecolor="none")
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, weight="bold"); ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    tb = fs.put_table(axt, rows, cols, size=10)
    for i, r in enumerate(rows, 1):
        fs.tint(tb, i, len(cols) - 1, "green" if r[-1] == "PASS" else "rose")
    if key:
        fs.gold(tb, *key)
    fs.bullets(fig, notes)
    return fig
```

## Significance test

Read when: you must say whether a result is luck: a permutation or block-bootstrap null against the observed value, intervals that keep the clustering, and the deflated Sharpe against the trial count.

Category: The luck

- **Question:** Is the result more than luck?
- **Inputs:** `null` (1-D array of the statistic under the null: positions shifted by whole days, or block-bootstrap draws), `observed` (the same statistic on the real data), `tests` (rows `[test, reading, gate, PASS or FAIL]`: permutation p, day-block bootstrap p, an interval, deflated Sharpe with its trial count), `notes`, `window`, `xlabel`.
- **How to draw:**
  - One axes: the null as a grey histogram (quantity colour `fees`, 40 bins), the observed value as a solid ink vertical line. The legend gives the draws, the observed value and the one-sided p, above the axes.
  - Test the statistic that carries the claim (the funding series for a carry book, spread P&L before costs for a spread rule), not the total. Block lengths and draws go in the table or a bullet.
  - One four-column table under the chart, a row per test with its gate; PASS green, FAIL rose. An interval is a table row, or its own chart of this type (`null` the resampled statistic, zero an ink dotted line).
  - Say how many trials the deflated Sharpe counts, and that a grid or split over one window is one observation re-sliced.
- **How to read it:** Pass: the observed line sits beyond the null's far tail (p below the gate, 0.10 in `research.md`) and the table is all green. Fail: the line sits inside the bulk, or only the total passes while the series that carries the thesis does not. A p at the floor of 1/(draws+1) means the null was never reached, not that p is zero.
- **Pairs with:** gate 2 (step 2 of `research.md#six-gates-size-last`): permutation p below 0.10 on the funding series, not the total; the deflation rule in `app/library/academic/backtest-statistics.md#the-deflated-sharpe-ratio`.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_significance_test(null, observed, tests, notes, window, xlabel, label="the statistic with the positions shifted", question="Is the result more than luck?"):
    N = fs.NEUTRAL
    null = np.asarray(null, float)
    p = (1 + int((null >= observed).sum())) / (len(null) + 1)
    fig, gs, ax, axt = fs.fig_tab(5.0, (2.3, 1.4), hspace=0.55, nb=fs.nlines(notes))
    ax.hist(null, bins=40, color=fs.QUANTITY["fees"], alpha=0.8, label=f"{label} ({len(null):,} draws)")
    ax.axvline(observed, color=N["ink"], linewidth=2.6, label=f"observed {observed:,.0f}, one-sided p {p:.4f}")
    ax.set_xlabel(xlabel); ax.set_ylabel("draws")
    ax.legend(loc="lower right", bbox_to_anchor=(1, 1), facecolor=N["surface"], edgecolor="none")
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, weight="bold"); ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    tb = fs.put_table(axt, tests, ["Test", "Reading", "Gate", "Verdict"], size=10, first=0.5)
    for i, r in enumerate(tests, 1):
        fs.tint(tb, i, 3, "green" if r[3] == "PASS" else "rose")
    fs.bullets(fig, notes)
    return fig
```

## Sample size and power

Read when: a study reports an edge and the question is whether its sample could have told that edge from luck at all.

Category: The luck

Waits on: the minimum-track-record formula, which is not in `fundplat.quant.core.stats` (only `psr_from`). Computing the curve inside a notebook breaks the notebook rule; do not do it until the helper lands.

- **Question:** How many independent days does the study need to tell its edge from luck?
- **Inputs:** `n`, `mde` (ascending n; the smallest effect n independent observations detect at the study's size and power, in `unit`), `n_raw`, `n_eff` (raw and effective count after serial dependence: days over the stationary-bootstrap block length, `fundplat.quant.core.stats.stationary_bootstrap_sums`), `effect` (measured, same unit), `others` {label: (mde array, colour)}, `table` (cells, cols). The notebook computes the curve: the standard error is `stats.psr_from`, the minimum-track-record formula is not in stats yet.
- **How to draw:**
  - Log-log axes, plain-number ticks. The detectable effect is an ink line falling with n; another power is a solid grey line.
  - The measured effect is a named ink dotted horizontal; raw n and effective n are named ink dotted verticals, each with a marker on the curve: green if the effect is at or above it there, red if below.
  - In-figure table, rows raw and effective: n, detectable effect, measured effect, the answer; gold on the detectable effect at the effective n. Legend in the empty upper right.
- **How to read it:** Pass: the marker at the effective n is green: the effect clears the smallest detectable one once blocks are counted. Fail: green at raw n, red at effective n: the sample could not tell this edge from luck; say so, size nothing.
- **Pairs with:** step 2 (is it real: the luck test), `app/library/research/research.md#six-gates-size-last`, with the formulas in `app/library/academic/backtest-statistics.md#the-probabilistic-sharpe-ratio`
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_sample_size_and_power(n, mde, n_raw, n_eff, effect, unit, table, findings, question, window, others=None):
    N, V = fs.NEUTRAL, fs.VERDICT
    n, mde = np.asarray(n, float), np.asarray(mde, float)
    at = lambda k: np.exp(np.interp(np.log(k), np.log(n), np.log(mde)))
    fig, gs, ax, axt = fs.fig_tab(7.4, (2.8, 1.2), top=0.80, hspace=0.5, nb=fs.nlines(findings))
    ax.plot(n, mde, color=N["ink"], linewidth=2.4, label="smallest detectable effect")
    for lab, (y, col) in (others or {}).items():
        ax.plot(n, y, color=col, linewidth=1.8, label=lab)
    ax.axhline(effect, color=N["ink"], linestyle=":")
    ax.text(n[-1], effect, "measured effect ", ha="right", va="bottom", color=N["ink"])
    for k, name, mk in ((n_raw, "raw n", "o"), (n_eff, "effective n", "D")):
        ax.axvline(k, color=N["ink"], linestyle=":")
        ax.text(k, 0.97, name + " ", transform=ax.get_xaxis_transform(), rotation=90, ha="right", va="top", color=N["ink"])
        ax.plot(k, at(k), mk, color=V["good" if effect >= at(k) else "bad"])
    ax.set(xscale="log", yscale="log")
    for a in (ax.xaxis, ax.yaxis):
        a.set_major_formatter("{x:g}"); a.set_minor_formatter("")
    ax.set_xlabel("independent bets or days"); ax.set_ylabel(unit)
    ax.legend(loc="upper right", facecolor=N["surface"], edgecolor="none")
    ax.set_title(question, loc="left", fontsize=11.5, weight="bold", pad=24); ax.text(0, 1.012, window, transform=ax.transAxes, fontsize=8.5, color=N["muted"])
    tb = fs.put_table(axt, *table, size=9.5); fs.gold(tb, 2, 2)
    fs.bullets(fig, findings)
    return fig
```

## Parameter surface

Read when: a rule has a tuned input pair and the study must show the chosen setting is not a spike in a thin grid, or a verdict rests on two inputs the study could not measure (a borrow fee, a financing rate, a fill delay) and the reader must see which values would flip it.

Category: The choice

- **Question:** Is the chosen setting on a plateau or on a spike?
- **Inputs:** `grid` (DataFrame of the gate metric: a `fundplat` run per cell, each passing `verify()`; named index and columns are the inputs), `chosen` (row, column), `hurdle`, `metric`, `window`, `notes`. For an unmeasured pair the grid is the net by assumption, `chosen` is the pair the study used (tagged [U] in the axis names) and two inputs only: more is a parameter search, which a short window cannot carry.
- **How to draw:**
  - A heatmap, values in the cells; the chosen cell outlined thick in ink, its neighbours thin grey.
  - Diverging scale, hurdle as zero: green above, red below, surface colour at it. Key above the map, no colour bar (`figstyle.check` cannot read a gradient).
  - One in-figure table: chosen cell, worst and mean neighbour, best cell, share above the hurdle, the hurdle. PASS or FAIL top right. A grid with no neighbour (one cell) prints FAIL: a plateau was not tested.
- **How to read it:** Pass: the chosen cell and its neighbours clear the hurdle. Fail: a green cell among red or pale ones (a spike), or a hurdle through the middle of the grid. A grid is one window re-sliced: deflate a Sharpe picked from it (`app/library/academic/backtest-statistics.md#the-deflated-sharpe-ratio`). Assumptions (the old `Assumption sensitivity`, folded in): fail when the ringed pair sits within one cell of a red cell, or the green sits only where an input is assumed paid, not charged.
- **Pairs with:** step 3, a rule against always-hold (no parameter search); feeds the deflated Sharpe; gate 2 (`research.md#six-gates-size-last`): no cost cell flips the sign
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from matplotlib.colors import LinearSegmentedColormap as Cmap
from matplotlib.patches import Rectangle, Patch
from fundplat.quant.core import figstyle as fs


def draw_parameter_surface(grid, chosen, hurdle, metric, window, notes, fmt="{:.2f}", question="Is the chosen setting on a plateau or on a spike?"):
    N, V = fs.NEUTRAL, fs.VERDICT; f = fmt.format
    g = grid.to_numpy(float); i, j = grid.index.get_loc(chosen[0]), grid.columns.get_loc(chosen[1])
    nb = [v for (r, c), v in np.ndenumerate(g) if abs(r - i) < 2 and abs(c - j) < 2 and (r, c) != (i, j)]
    ok = bool(nb) and min([g[i, j], *nb]) > hurdle; span = abs(g - hurdle).max() or 1
    fig, gs, ax, axt = fs.fig_tab(6.6, (3, 0.7), top=0.84, nb=fs.nlines(notes))
    ax.imshow(g, cmap=Cmap.from_list("g", [V["bad"], N["surface"], V["good"]]), vmin=hurdle - span, vmax=hurdle + span, aspect="auto"); ax.grid(False)
    [ax.text(c, r, f(v), ha="center", va="center") for (r, c), v in np.ndenumerate(g)]
    for x, y, dx, dy, col, lw, lab in ((j - 1, i - 1, 3, 3, "ink2", 1, "neighbours"), (j, i, 1, 1, "ink", 2.6, "chosen")):
        ax.add_patch(Rectangle((x - .5, y - .5), dx, dy, fill=False, edgecolor=N[col], linewidth=lw, label=lab))
    ax.set(xticks=range(g.shape[1]), xticklabels=grid.columns, xlabel=grid.columns.name, yticks=range(g.shape[0]), yticklabels=grid.index, ylabel=grid.index.name)
    ax.legend(handles=[Patch(facecolor=V[k], label=w + " the hurdle") for k, w in (("good", "above"), ("bad", "below"))] + ax.patches,
              loc="lower left", bbox_to_anchor=(0, 1), ncol=4, frameon=False)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, weight="bold"); fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fig.text(0.97, 0.925, ("PASS: neighbours clear it" if ok else "FAIL: a neighbour misses") if nb else "FAIL: no neighbour to test", ha="right", color=V["good" if ok else "bad"])
    cells = [[f(g[i, j]), *(map(f, (min(nb), np.mean(nb))) if nb else ("-", "-")), f(g.max()), f"{(g > hurdle).mean():.0%}", f(hurdle)]]
    tb = fs.put_table(axt, cells, [f"{metric}, chosen", "Worst neighbour", "Mean neighbour", "Best cell", "Above hurdle", "Hurdle"])
    fs.tint(tb, 1, 1, "green" if ok else "rose"); fs.bullets(fig, notes)
    return fig
```

## Rule comparison

Read when: you test the same strategy under alternative rules, arms, entry hours, exits or holds against always-on.

Category: The choice

- **Question:** Does a rule beat always-on?
- **Inputs:** `names` (the arms, base first), `net` and `dd` (each arm's net P&L and max drawdown in USD, drawdown negative), `notes`, `window`. Arms come from costs and the data's own time constant, never a search; a grid of settings is one observation re-sliced, and the notes say so.
- **How to draw:**
  - One axes, grouped bars per arm: net P&L (ink2) and max drawdown (muted grey), one USD scale (a second scale is a second panel).
  - The base arm's net and drawdown are ink dotted lines across every arm, keyed in the legend above. Zero is a quiet axis line.
  - One table under the axes: rule, net, max drawdown, verdict. The base row gold; ADOPT green only when the arm beats the base on net AND drawdown, else 'not adopted' rose.
- **How to read it:** Pass: an arm is adopted only if it improves both net and drawdown against always-on. Fail: an arm buys return with drawdown (or the reverse). A registered setting that may be a lone green cell is `Parameter surface`, not an arm here.
- **Pairs with:** gate 3 (step 3 of `research.md#six-gates-size-last`): adopted ONLY if it improves BOTH the gate metric and max drawdown; no parameter search; `Parameter surface` for the plateau check.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_rule_comparison(names, net, dd, notes, window, question="Does a rule beat always-on?"):
    N = fs.NEUTRAL
    net, dd = np.asarray(net, float), np.asarray(dd, float)
    adopt = [False] + [bool(n > net[0] and d > dd[0]) for n, d in zip(net[1:], dd[1:])]
    fig, gs, ax, axt = fs.fig_tab(4.4, (2.2, 1.3), hspace=0.55, nb=fs.nlines(notes))
    x = np.arange(len(names))
    ax.bar(x - 0.19, net, width=0.36, color=N["ink2"], label="net P&L")
    ax.bar(x + 0.19, dd, width=0.36, color=N["muted"], label="max drawdown")
    for y, lab in ((net[0], f"base arm: net {net[0]:,.0f}, drawdown {dd[0]:,.0f}"), (dd[0], None)):
        ax.axhline(y, color=N["ink"], linewidth=1.3, linestyle=":", label=lab)
    ax.axhline(0, color=N["axis"], linewidth=1); ax.set_xticks(x, names, fontsize=8.5); ax.set_ylabel("USD")
    ax.legend(loc="lower right", bbox_to_anchor=(1, 1), ncol=3, facecolor=N["surface"], edgecolor="none")
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, weight="bold"); ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    rows = [[n, f"{a:,.0f}", f"{b:,.0f}", "base" if i == 0 else "ADOPT" if adopt[i] else "not adopted"] for i, (n, a, b) in enumerate(zip(names, net, dd))]
    tb = fs.put_table(axt, rows, ["Rule", "Net USD", "Max drawdown USD", "Verdict"], size=10, first=0.4)
    fs.gold(tb, 1, 0)
    for i in range(1, len(rows)):
        fs.tint(tb, i + 1, 3, "green" if adopt[i] else "rose")
    fs.bullets(fig, notes)
    return fig
```

## Factor regression

Read when: a study shows a profit and the question is how much of it is alpha and how much is exposure to named factors (market, rates, carry, momentum).

Category: The luck

Waits on: a joint fit. `stats.newey_west` fits ONE regressor, so factors fed one at a time give marginal slopes, which this chart would draw as betas: wrong as drawn. Do not draw it until the joint fit lands.

- **Question:** Is the return alpha, or only exposure to named factors?
- **Inputs:** `est` (DataFrame by term: `coef`, `lo`, `hi`, `t`, Newey-West 95%; the intercept row is `alpha`), `r2`, `hurdle` (the gate's alpha, same units), `window`, `notes`. `fundplat.quant.core.stats.newey_west(y, x)` fits ONE regressor and returns `effect`, `ci_low`, `ci_high`, `t` (rename them), so factors one at a time give marginal slopes, not partial betas; the joint fit is not built yet.
- **How to draw:**
  - Two panels: alpha alone on the left (its unit is not a beta's), betas on the right, a bar per term with an ink interval and caps. Error bars and caps are ink.
  - Alpha is green when its whole interval is above the hurdle, red when below, muted when it spans it. Betas are neutral dark grey: an exposure is not good or bad. The hurdle is an ink dotted line on the alpha panel.
  - One in-figure table: estimate, interval and Newey-West t per term, a closing R squared row, the alpha t gold. Top right: PASS or FAIL.
- **How to read it:** Pass: the alpha interval is above the hurdle with the betas in. Fail: it spans or sits under the hurdle. A big market beta with a small alpha is a levered index, not a strategy.
- **Pairs with:** step 2, is it real (alpha must survive the factors)
- **Exemplar:** none yet
- **Code:**

```python
from matplotlib.patches import Patch
from fundplat.quant.core import figstyle as fs


def draw_factor_regression(est, alpha, r2, hurdle, window, notes, alpha_label="alpha, % a year", question="Is the return alpha, or only exposure to named factors?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    bet = est.drop(index=alpha); a = est.loc[alpha]; ok = a["lo"] > hurdle
    ac = V["good"] if ok else V["bad"] if a["hi"] < hurdle else N["muted"]
    fig, gs, ax, axt = fs.fig_tab(6.4, (2.7, 1.3), top=0.84, nb=fs.nlines(notes)); ax.axis("off")
    a1, a2 = gs[0].subgridspec(1, 2, wspace=0.12, width_ratios=(1, max(len(bet), 1))).subplots()
    for p, d, col in ((a1, est.loc[[alpha]], ac), (a2, bet, N["ink2"])):
        p.bar(d.index, d["coef"], color=col, yerr=[d["coef"] - d["lo"], d["hi"] - d["coef"]], error_kw=dict(color=N["ink"]), capsize=4); p.axhline(0, color=N["axis"])
    a1.axhline(hurdle, color=N["ink"], linestyle=":", linewidth=1.5, label="hurdle"); a1.set_ylabel(alpha_label); a2.set_ylabel("beta per unit of factor")
    a2.legend(handles=[Patch(facecolor=c, label=l) for c, l in ((V["good"], "alpha clears hurdle"), (V["bad"], "alpha below"), (N["muted"], "interval spans"), (N["ink2"], "factor beta"))]
                      + a1.lines[-1:], loc="lower right", bbox_to_anchor=(1, 1), ncol=5, frameon=False)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, weight="bold"); fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fig.text(0.97, 0.925, "PASS: alpha clears the hurdle" if ok else "FAIL: alpha misses the hurdle", ha="right", color=V["good" if ok else "bad"])
    cells = [[n, *map("{:+.2f}".format, r[["coef", "lo", "hi"]]), f"{r.t:+.1f}"] for n, r in est.iterrows()] + [["R squared", f"{r2:.2f}", "", "", ""]]
    tb = fs.put_table(axt, cells, ["Term", "Estimate", "95% low", "95% high", "t (Newey-West)"], first=0.25)
    fs.gold(tb, 1, 4); fs.tint(tb, 1, 4, "green" if ok else "rose"); fs.bullets(fig, notes)
    return fig
```

## Stress windows

Read when: a study spans more than one regime and the book's behaviour in named, dated shocks (a crash, a delisting, a policy surprise) is part of the verdict. On a one-regime window there is nothing to test against: the function raises instead of drawing one observation.

Category: The luck

- **Question:** How did the book do in the named shocks?
- **Inputs:** `t` (days, increasing), `equity` (cumulative net USD at each `t`), `shocks` (name to `(start, end)` in the units of `t`, dated before the run and listed in the pre-registration), `stop` (the pre-registered loss limit, USD, negative [U]), `notes`, `window`.
- **How to draw:**
  - The figure is the per-shock table (the owner's call: an equity curve with date bands is `Equity curve` plus shading, and inert on a single-regime window). One row per shock: days, net, worst single step, maximum drawdown inside it and a verdict against the stop; rose on a loss, green on a gain.
  - Above it one bar per shock, its maximum drawdown inside the shock, red where it passes the stop, grey inside it; the stop an ink dotted line with a text label.
  - Shocks are named by date, never picked after seeing the curve. A shock outside the window is left out and the bullets say so; fewer than two inside is an error.
- **How to read it:** Pass: no shock's drawdown passes the pre-registered stop and the book's gains are not all outside the shocks. Fail: a shock's drawdown passes the stop, or the whole edge is earned in calm hours the shocks never touch.
- **Pairs with:** gate 2 (`research.md#six-gates-size-last`) when the window holds two regimes; `law/how-we-know.md#a-shared-window-is-one-result` (a shock inside one regime is still one regime); `Equity curve` for the path itself.
- **Exemplar:** none yet (waits for a study that spans more than one regime)
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_stress_windows(t, equity, shocks, stop, notes, window, question="How did the book do in the named shocks?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    t, eq = np.asarray(t, float), np.asarray(equity, float)
    rows = []
    for name, (a, b) in shocks.items():
        m = (t >= a) & (t <= b)
        if m.sum() < 2:
            continue                             # a shock outside the window is left out; the bullets say so
        e = eq[m]
        rows.append((name, int(m.sum()) - 1, e[-1] - e[0], np.diff(e).min(), (e - np.maximum.accumulate(e)).min()))
    if len(rows) < 2:
        raise ValueError("fewer than two named shocks inside the window: one regime, nothing to test")
    fig, gs, ax, axt = fs.fig_tab(5.2, (1.5, 1.7), hspace=0.55, nb=fs.nlines(notes))
    dd = np.array([r[4] for r in rows])
    ax.bar(range(len(rows)), dd, color=[V["bad"] if v < stop else N["ink2"] for v in dd])
    ax.axhline(stop, color=N["ink"], linewidth=1.5, linestyle=":")
    ax.text(len(rows) - 0.5, stop, f"pre-registered stop {stop:,.0f} [U] ", ha="right", va="bottom", fontsize=8.5, color=N["ink"])
    ax.axhline(0, color=N["axis"], linewidth=1)
    ax.set_xticks(range(len(rows)), [r[0] for r in rows]); ax.set_ylabel("max drawdown in the shock, USD")
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    cells = [[r[0], f"{r[1]}", f"{r[2]:,.0f}", f"{r[3]:,.0f}", f"{r[4]:,.0f}", "PASS" if r[4] >= stop else "FAIL"] for r in rows]
    tb = fs.put_table(axt, cells, ["Shock", "Days", "Net USD", "Worst step USD", "Max drawdown USD", "Against the stop"], size=9.5, first=0.24)
    for i, r in enumerate(rows, 1):
        fs.tint(tb, i, 2, "rose" if r[2] < 0 else "green"); fs.tint(tb, i, 5, "green" if r[4] >= stop else "rose")
    fs.bullets(fig, notes)
    return fig
```

## Selection check

Read when: a setting, a slice or a feature was picked as the best of many, and the question is whether the best is more than luck would pick and whether it still earns where it was not found.

Category: The choice

- **Question:** `Did the best of many tries earn more than luck alone would give?`
- **Inputs:** `fit` (the score of every try where it was found, such as t of the net per entry), `hold` (the same tries on days they never saw), `luck` (the level the best of this many tries reaches by luck alone: the 95th percentile of the maximum under a permutation null), `top`, `chosen` (an index, optional), `single` (the one-test level, optional), `unit`, `notes`, `window`.
- **How to draw:**
  - Left: the tries ranked by fit score, the best `top` in ink, `luck` and `single` ink dotted horizontals with their labels.
  - Right: fit against hold, one dot per try, the best in ink, the chosen one a star in the model identity colour, zero in the axis colour; the legend counts the best that earn on the held-out days.
  - Findings: the best score against `luck`, how many of the best hold out, and how many tries were made (the n of the luck line).
- **How to read it:** Pass: the best clears the luck line and most of the top stay above zero held out. Fail: the best sits under the line (a spike picked from noise), or the top fall to zero held out (the winner's curse). Tries that share one window are one observation re-sliced.
- **Pairs with:** `Parameter surface` (the plateau); `Out-of-sample test`; `Significance test`; `app/library/academic/backtest-statistics.md#the-deflated-sharpe-ratio`.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_selection_check(fit, hold, luck, notes, window, top=10, chosen=None, single=None, unit="t of the net per entry", question="Did the best of many tries earn more than luck alone would give?"):
    N, I = fs.NEUTRAL, fs.IDENTITY
    fit, hold = np.asarray(fit, float), np.asarray(hold, float)
    order = np.argsort(-fit)
    best = order[:top]
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 4.8 + nb * 0.205))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.82, bottom=fs.bullet_margin(fig, nb) + 0.10, wspace=0.24)
    x = np.arange(1, len(fit) + 1)
    a1.scatter(x, fit[order], s=12, color=N["muted"], zorder=3, label=f"each of the {len(fit)} tries")
    a1.scatter(x[:top], fit[order][:top], s=28, color=N["ink"], zorder=4, label=f"the {top} best")
    for lev, lab in ((luck, f"best of {len(fit)} by luck alone"), (single, "one test, one-sided 5%")):
        if lev is not None:
            a1.axhline(lev, color=N["ink"], linewidth=1.1, linestyle=":")
            a1.annotate(lab, (0.99, lev), xycoords=("axes fraction", "data"), xytext=(0, 4), textcoords="offset points", ha="right", fontsize=8.5)
    a1.axhline(0, color=N["axis"], linewidth=1)
    a1.set_xlabel("tries, best first"); a1.set_ylabel(unit); a1.set_title("did the best clear luck", loc="left", fontsize=10); a1.legend(loc="best", fontsize=8.5)
    a2.scatter(fit, hold, s=12, color=N["muted"], zorder=3, label="a try")
    a2.scatter(fit[best], hold[best], s=30, color=N["ink"], zorder=4, label=f"the {top} best: {int((hold[best] > 0).sum())} earn on held-out days")
    if chosen is not None:
        a2.scatter([fit[chosen]], [hold[chosen]], s=170, marker="*", color=I["MODEL"], edgecolors=N["ink"], linewidths=0.6, zorder=5, label="the chosen one")
    a2.axhline(0, color=N["axis"], linewidth=1); a2.axvline(0, color=N["axis"], linewidth=1)
    a2.set_xlabel("where it was found"); a2.set_ylabel("on days it never saw"); a2.set_title("did it hold out", loc="left", fontsize=10); a2.legend(loc="best", fontsize=8.5)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Entry-time sensitivity

Read when: a study ran from one start time and the result may depend on when the position was opened (a hold, a carry, a static hedge).

Category: The luck

- **Question:** `How much of the result is the entry hour?`
- **Inputs:** `start` (the entry time of each re-run), `value` (its gate metric or net, one number), `registered` (`(start, value)` of the run the study registered), `hurdle`, `unit`, `notes`, `window`.
- **How to draw:**
  - Left: one dot per re-run against its entry time, the 5th to 95th percentile band shaded, the registered run ringed, the hurdle an ink dotted horizontal.
  - Right: the same values as a histogram, the registered run an ink vertical with the percentile it sits at in the label, the hurdle an ink dotted vertical.
  - Findings: the count of re-runs, the band, the registered percentile and the share of re-runs above the hurdle.
- **How to read it:** Pass: the registered run sits in the middle of the band and the band's lower end clears the hurdle. Fail: it sits at an edge (the registered start was the lucky one) or the band straddles the hurdle (the answer is the start date). Re-runs overlap, so they are one window re-sliced: the spread is path dependence, not a sampling interval.
- **Pairs with:** `Monte Carlo and ruin` (resampled paths); `Out-of-sample test`; `law/how-we-know.md#a-shared-window-is-one-result`.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_entry_time_sensitivity(start, value, registered, notes, window, hurdle=0.0, unit="net P&L, USD", question="How much of the result is the entry hour?"):
    N = fs.NEUTRAL
    start, value = np.asarray(start), np.asarray(value, float)
    lo, hi = np.percentile(value, [5, 95])
    r_start, r_val = registered
    pct = float(np.mean(value <= r_val))
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 4.8 + nb * 0.205), gridspec_kw=dict(width_ratios=(1.7, 1)))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.82, bottom=fs.bullet_margin(fig, nb) + 0.10, wspace=0.24)
    a1.axhspan(lo, hi, color=N["axis"], alpha=0.35, linewidth=0, label=f"5th to 95th percentile: {lo:+,.0f} to {hi:+,.0f}")
    a1.scatter(start, value, s=9, color=N["ink2"], alpha=0.7, linewidths=0, zorder=3, label=f"one re-run from each entry: {len(value):,}")
    a1.scatter([r_start], [r_val], s=70, facecolors="none", edgecolors=N["ink"], linewidths=1.6, zorder=5, label="the registered entry")
    a1.axhline(hurdle, color=N["ink"], linewidth=1.1, linestyle=":")
    a1.annotate("hurdle", (a1.get_xlim()[1], hurdle), xytext=(-4, 4), textcoords="offset points", ha="right", fontsize=8.5)
    a1.xaxis.set_major_formatter(mdates.ConciseDateFormatter(a1.xaxis.get_major_locator()))
    a1.set_xlabel("entry time of the re-run"); a1.set_ylabel(unit); a1.set_title("by entry", loc="left", fontsize=10); a1.legend(loc="best", fontsize=8.5)
    a2.hist(value, bins=30, color=N["muted"], alpha=0.85, zorder=3)
    a2.axvline(r_val, color=N["ink"], linewidth=1.6)
    a2.axvline(hurdle, color=N["ink"], linewidth=1.1, linestyle=":")
    a2.annotate(f"registered: {pct:.0%} of re-runs sit at or below it", (r_val, a2.get_ylim()[1]), xytext=(-4, -4), textcoords="offset points", ha="right", va="top", fontsize=8.5)
    a2.set_xlabel(unit); a2.set_ylabel("re-runs"); a2.set_title("how often each level occurred", loc="left", fontsize=10)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```
