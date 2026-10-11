---
topics: [charts]
type: guide
---

# Charts: describing a result

These types show the shape of a series or a run: its path, its distribution, its drawdowns, its decay, its calibration, its ruin odds. The bank's guide, the type list and the rules are in `charts.md`.

## Series and distribution

Read when: a venue series (funding, a premium, a vol) is about to be shown and the reader needs both its path and its shape.

Category: The run

- **Question:** `How has <series> moved, and how is it distributed?`
- **Inputs:** `series` = `{name: (pd.Series on a time index, hex colour)}`, one to three in one unit; `window` = subtitle with the hour count; `ylabel`; `bul` = the findings (list of strings); the cell-8 style (`figstyle.NAMES`, dpi 110).
- **How to draw:**
  - ONE chart: each series a solid line in its identity colour, faint mean and median lines (`figstyle.stat_lines`), a zero line in the axis colour. Never one panel per series.
  - A histogram beside it on the same y axis (middle 99%, the rest folded into the end bins), one overlay per series.
  - ONE table under both, at most nine columns: mean, median, st.dev, skew, 5th and 95th percentile, share above 0; gold marks the series whose mean sits furthest from its median.
  - Legend: names only, above the axes; numbers in the table, findings in bullets.
- **How to read it:** Pass: mean and median agree and skew is small. Fail (a finding, not a defect): a mean far from the median means a few large hours carry it; say so in the first bullet.
- **Pairs with:** Step 0, data and sanity: draw it for series the guard has passed.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_series_and_distribution(series, question, window, ylabel, bul, h=6.2):
    """series: {name: (pd.Series, hex colour)}."""
    N = fs.NEUTRAL
    fig, gs, ax0, axt = fs.fig_tab(h, (3.0, 1.0), top=0.80, hspace=0.5, nb=fs.nlines(bul)); ax0.axis("off")
    ax, axh = (fig.add_subplot(g) for g in gs[0].subgridspec(1, 2, width_ratios=[6, 1], wspace=0.02))
    axh.sharey(ax)
    lo, hi = np.percentile(np.concatenate([s.dropna() for s, _ in series.values()]), [0.5, 99.5])
    rows, gap = [], []
    for name, (s, col) in series.items():
        s = s.dropna()
        ax.plot(s, color=col, lw=1.2, zorder=3, label=name); fs.stat_lines(ax, s, col, with_max=False)
        axh.hist(s.clip(lo, hi), bins=np.linspace(lo, hi, 51), orientation="horizontal", color=col, alpha=0.6)
        rows.append([name, f"{s.mean():+.1f}", f"{s.median():+.1f}", f"{s.std():,.1f}", f"{s.skew():+.2f}", f"{s.quantile(.05):+.1f}", f"{s.quantile(.95):+.1f}", f"{(s > 0).mean():.0%}"])
        gap.append(abs(s.mean() - s.median()))
    for a in (ax, axh):
        a.axhline(0, color=N["axis"])
    pad = (hi - lo) * 0.06
    ax.set_ylim(lo - pad, hi + pad); ax.set_ylabel(ylabel);
    ax.legend(loc="lower left", bbox_to_anchor=(0, 1), ncol=len(series), fontsize=8.5, frameon=False)
    axh.set_xticks([]); axh.tick_params(labelleft=False); axh.grid(False); axh.set_xlabel("hours")
    tb = fs.put_table(axt, rows, ["", "Mean", "Median", "St.dev", "Skew", "5th pct", "95th pct", "Above 0"], first=0.2)
    for i, (_, col) in enumerate(series.values(), 1):
        tb[(i, 0)].get_text().set_color(col)
    k = 1 + int(np.argmax(gap)); fs.gold(tb, k, 1); fs.gold(tb, k, 2)
    fig.suptitle(question, x=0.07, ha="left", size=11.5, weight="bold")
    fig.text(0.07, 1 - 0.55 / fig.get_size_inches()[1], window, color=N["muted"], size=8.5)
    fs.bullets(fig, bul)
    return fig
```

## Win/loss distribution

Read when: a rule has a per-trade P&L and the question is what one trade wins and loses, not the average of them.

Category: The run

- **Question:** `What do the trades win and lose?`
- **Inputs:** `net` (USD per trade); `notes`, `window`.
- **How to draw:**
  - One axes: a histogram of per-trade net, each bar green where its centre is above zero and red below; the legend names the win side and the loss side.
  - The mean and the median net are ink dotted verticals, each labelled with its number.
  - Zero in the quiet axis colour. Findings: the win rate, the mean, the median, the largest win and the largest loss, and whether the mean sits far from the median (a fat tail on one side).
- **How to read it:** Pass: the mean and the median sit on the same side of zero and the mode of the win side is not smaller than the mode of the loss side. Fail: the mean is carried by a few large wins while the median loses, or the losses are deeper and more common than the wins.
- **Pairs with:** `Series and distribution` (a venue series, the same shape); `Rolling win rate` (whether the win rate holds); `Regime and concentration` (which trades carry the net).
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from fundplat.quant.core import figstyle as fs


def draw_win_loss_distribution(net, notes, window, question="What do the trades win and lose?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    net = np.asarray(net, float)
    nb = fs.nlines(notes)
    fig, ax = plt.subplots(figsize=(13, 4.8 + nb * 0.205))
    fig.subplots_adjust(left=0.07, right=0.97, top=1 - 0.9 / fig.get_size_inches()[1], bottom=fs.bullet_margin(fig, nb) + 0.08)
    n, bins, patches = ax.hist(net, bins=30, color=N["muted"])
    for p, c in zip(patches, 0.5 * (bins[:-1] + bins[1:])):
        p.set_facecolor(V["good" if c > 0 else "bad"]); p.set_alpha(0.6)
    ax.axvline(np.mean(net), color=N["ink"], linewidth=1.3, linestyle=":", label=f"mean {np.mean(net):+.1f}")
    ax.axvline(np.median(net), color=N["ink"], linewidth=1.2, linestyle=(0, (1, 1)), label=f"median {np.median(net):+.1f}")
    ax.axvline(0, color=N["axis"], linewidth=1)
    ax.legend(handles=[Patch(facecolor=V["good"], alpha=0.6, label="win"), Patch(facecolor=V["bad"], alpha=0.6, label="loss")] + ax.get_lines(), loc="best", fontsize=8.5, frameon=False)
    ax.set_xlabel("net per trade, USD"); ax.set_ylabel("trades")
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Equity curve

Read when: a rule has a P&L and the question is whether it ends above its hurdle, and how the P&L arrived day by day or trade by trade.

Category: The run

- **Question:** `Does <the rule> make money after costs?`
- **Inputs:** `idx` = time index; `net`, `hurdle` = cumulative P&L arrays on `idx` (the hurdle is the T-bill on the same capital, same units); optional `gross` (before costs), `per` = `(index, values)` of per-day or per-trade P&L, `per_roll` (periods or trades in the rolling mean drawn on the `per` panel) and `per_label`; `window`, `ylabel`, `bul`; the cell-8 style (`figstyle.NAMES`, dpi 110). A trade-ordered study (binary trades) sets `idx` to the trade number on both panels: trades are not evenly spaced, and the notes give the hour span.
- **How to draw:**
  - Net P&L ink and thick; before-costs P&L the basis colour; the hurdle ink, dotted, in the legend. All on ONE chart.
  - Shade between net and hurdle: green above, red below. Green and red mean that and nothing else.
  - A BASE TEST PASS or FAIL tag top right (the last net point against the hurdle's last).
  - Optional lower panel: per-day or per-trade P&L bars, green gain, red loss. With `per_roll`, the rolling mean is a solid ink line and the full-sample mean an ink dotted line labelled at its right end (this is the old `Per-trade PnL over time` chart, folded in). Legend beside the chart.
- **How to read it:** Pass: net ends above the hurdle and green dominates. Fail: red dominates or the tag reads FAIL; a gross line above the hurdle while net is below is a cost problem, say which cost. Per panel, pass: the rolling mean stays above zero through most of the window and the bars mix wins and losses; fail: it crosses zero often, or a few bars carry the net (`Regime and concentration` says which).
- **Pairs with:** Step 1, the unlevered base (1x, costs on): the gate metric ends above the hurdle; the mirror run is a second chart of this type; `Rolling statistics` (whether the share of winners, not the size, is steady); `Regime and concentration` (which trades carry the net).
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_equity_curve(idx, net, hurdle, question, window, ylabel, bul, gross=None, per=None, per_label="P&L per day", per_roll=None, h=5.6):
    """net, hurdle: cumulative P&L on idx; gross: before costs; per: (index, values); per_roll: window of the rolling mean on the per panel. Returns the figure."""
    N, G, R = fs.NEUTRAL, fs.VERDICT["good"], fs.VERDICT["bad"]
    net, hurdle = np.asarray(net, float), np.asarray(hurdle, float)
    two = per is not None
    H = h + 2.0 * two + fs.nlines(bul) * 0.205 + 1.0
    fig, axs = plt.subplots(1 + two, 1, figsize=(13, H), sharex=two, squeeze=False, gridspec_kw={"height_ratios": [3, 1][:1 + two], "hspace": 0.28})
    ax = axs[0, 0]
    if gross is not None:
        ax.plot(idx, gross, color=fs.QUANTITY["basis_dark"], lw=2, label="before costs")
    ax.plot(idx, net, color=N["ink"], lw=2.6, zorder=5, label="net of costs")
    ax.plot(idx, hurdle, color=N["ink"], lw=1.5, ls=":", label="hurdle (T-bill)")
    for m, c, a, t in ((net >= hurdle, G, 0.16, "above"), (net < hurdle, R, 0.22, "below")):
        ax.fill_between(idx, net, hurdle, where=m, interpolate=True, color=c, alpha=a, lw=0, label=t + " the hurdle")
    ax.axhline(0, color=N["axis"]); ax.set_ylabel(ylabel)
    ok = net[-1] > hurdle[-1]
    ax.text(1, 1.012, "BASE TEST " + ("PASS" if ok else "FAIL"), transform=ax.transAxes, ha="right", va="bottom", color=G if ok else R, size=9.5, weight="bold")
    ax.legend(loc="upper left", bbox_to_anchor=(1.005, 1), fontsize=8.5, frameon=False)
    ax.set_title(question, loc="left", pad=24, size=11.5, weight="bold"); ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], size=8.5, va="bottom")
    if two:
        a2, v = axs[1, 0], np.asarray(per[1], float)
        a2.vlines(per[0], 0, v, colors=[G if x > 0 else R for x in v], lw=2.5)
        a2.axhline(0, color=N["ink"]); a2.set_ylabel(per_label)
        if per_roll:
            c = np.concatenate([[0], np.cumsum(v)])
            a2.plot(np.asarray(per[0])[per_roll - 1:], (c[per_roll:] - c[:-per_roll]) / per_roll, color=N["ink"], lw=2.2, label=f"rolling mean, {per_roll}")
            a2.axhline(v.mean(), color=N["ink"], lw=1.3, ls=":")
            a2.text(per[0][-1], v.mean(), f" full-sample mean {v.mean():+.2f} ", ha="right", va="bottom", fontsize=8.5, color=N["ink"])
            a2.legend(loc="upper left", bbox_to_anchor=(1.005, 1), fontsize=8.5, frameon=False)
    fs.finish(fig, bul, top=1 - 0.95 / H, right=0.82)
    return fig
```

## Drawdown and tail

Read when: the P&L is known and the question is how deep and how long it hurt, and how bad the worst days are.

Category: The run

- **Question:** `How deep were the drawdowns, and how bad is the tail?`
- **Inputs:** `equity` = pd.Series of account value on a DatetimeIndex of at least two days; `window`, `bul`; `n_worst`, `q` (tail percent), both default 5; the cell-8 style (`figstyle.NAMES`, dpi 110).
- **How to draw:**
  - Left: the underwater curve (equity over its running high, minus one) in the verdict red, filled to zero, the worst episodes numbered by rank.
  - Right: a histogram of daily returns in the muted colour; VaR and CVaR as ink dotted lines, named with values in the legend (in headroom above the bars).
  - ONE table under both: worst episodes by rank (under from, trough, last under, depth, days under); gold the deepest, rose the longest.
  - Bullets: max drawdown, share of time under water, the tail's observation count, the regime.
- **How to read it:** Pass: depth inside the pre-registered limit, each episode regained. Fail: depth past the limit, an episode unregained at the last bar, or a CVaR far beyond the VaR (a fat tail on few days: say how many).
- **Pairs with:** Step 3 (a rule must improve max drawdown too), step 4 (drawdown inside the desk limit).
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_drawdown_and_tail(equity, question, window, bul, n_worst=5, q=5, h=7.0):
    """equity: pd.Series of account value on a DatetimeIndex."""
    N, R = fs.NEUTRAL, fs.VERDICT["bad"]
    uw = (equity / equity.cummax() - 1) * 100
    u = uw < 0
    eps = sorted((g.min(), g.idxmin(), g.index[0], g.index[-1]) for _, g in uw[u].groupby((u != u.shift()).cumsum()[u]))[:n_worst]
    span = [(last - s).total_seconds() / 86400 for _, _, s, last in eps]
    d = equity.resample("D").last().pct_change().dropna() * 100
    var = np.percentile(d, q); cvar = d[d <= var].mean()
    fig, gs, ax0, axt = fs.fig_tab(h, (3.0, 1.3), top=0.82, hspace=0.5, nb=fs.nlines(bul)); ax0.axis("off")
    ax, ah = (fig.add_subplot(g) for g in gs[0].subgridspec(1, 2, width_ratios=[1.6, 1]))
    ax.fill_between(uw.index, uw, 0, color=R, alpha=0.22, lw=0); ax.plot(uw, color=R)
    for k, (dp, tr, _, _) in enumerate(eps, 1):
        ax.plot(tr, dp, "o", color=R)
        ax.annotate(str(k), (tr, dp), xytext=(0, -13), textcoords="offset points", ha="center")
    ax.set_ylim(uw.min() * 1.4, 0.25); ax.set_ylabel("drawdown of equity, %")
    ah.hist(d, bins=24, color=N["muted"], alpha=0.6); ah.margins(y=0.7)
    for v, n, ls in ((var, "VaR", ":"), (cvar, "CVaR", (0, (1, 1)))):
        ah.axvline(v, color=N["ink"], ls=ls, label=f"{n} {100 - q}%: {v:+.2f}%")
    ah.set(xlabel="daily return, % of equity", ylabel="days"); ah.legend(loc="upper right", fontsize=8.5, frameon=False)
    cells = [[str(k), *(f"{t:%b %d}" for t in (s, tr, last)), f"{dp:.2f}%", f"{sp:.1f}"] for k, ((dp, tr, s, last), sp) in enumerate(zip(eps, span), 1)]
    tb = fs.put_table(axt, cells, ["Rank", "Under from", "Trough", "Last under", "Depth", "Days under"])
    fs.gold(tb, 1, 4); fs.tint(tb, 1 + int(np.argmax(span)), 5, "rose")
    fig.suptitle(question, x=0.07, ha="left", size=11.5, weight="bold")
    fig.text(0.07, 1 - 0.55 / fig.get_size_inches()[1], window, color=N["muted"], size=8.5)
    fs.bullets(fig, bul)
    return fig
```

## Signal decay

Read when: a signal is claimed and the question is whether the move it predicts is still there at the horizon a trade would hold, net of what a round trip costs.

Category: The edge

- **Question:** `Does <the spread> come back after a stretch, and how fast?`
- **Inputs:** `hz` = horizons; `mean`, `lo`, `hi` = the response at each horizon and its interval, in the units of `cost` (resample days or blocks for the interval, never bars); `cost` = one round trip; `window`, `xlabel`, `ylabel`, `bul`; the cell-8 style (`figstyle.NAMES`, dpi 110).
- **How to draw:**
  - Response curve in the basis dark colour with markers, the interval a light band of the same family, solid line.
  - The cost is an ink, dotted horizontal line labelled at its right end; the zero line is the axis colour.
  - A green dot on every horizon whose lower bound clears the cost: green means pass here and nowhere else.
  - Legend beside the chart. Bullets: the peak, the horizon at the planned hold, the gap to the cost.
- **How to read it:** Pass: the interval's lower edge clears the cost at the horizon the rule would hold. Fail: the curve peaks below the cost, or clears it only at horizons longer than the hold; both mean the thesis cannot pay before any rule is tried.
- **Pairs with:** Step 1, the thesis the base test then trades, and the step 2 cost sweep (a sign that flips at a higher cost shows here first).
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_signal_decay(hz, mean, lo, hi, cost, question, window, xlabel, ylabel, bul, cost_label="round trip", h=5.6):
    """mean, lo, hi: response and interval per horizon, in units of cost. Returns the figure."""
    N, G = fs.NEUTRAL, fs.VERDICT["good"]
    hz, mean, lo, hi = (np.asarray(a, float) for a in (hz, mean, lo, hi))
    H = h + fs.nlines(bul) * 0.205 + 1.0
    fig, ax = plt.subplots(figsize=(13, H))
    ax.fill_between(hz, lo, hi, color=fs.QUANTITY["basis"], alpha=0.25, lw=0, label="95% interval")
    ax.plot(hz, mean, color=fs.QUANTITY["basis_dark"], lw=2.4, marker="o", ms=4, zorder=4, label="mean response")
    clear = lo > cost
    ax.scatter(hz[clear], mean[clear], s=46, color=G, zorder=6, label="interval clears the cost")
    ax.axhline(cost, color=N["ink"], ls=":", lw=1.5, zorder=5)
    ax.annotate(f" {cost_label} {cost:.1f}", xy=(1.003, cost), xycoords=("axes fraction", "data"), va="center", size=9, color=N["ink"], annotation_clip=False)
    ax.axhline(0, color=N["axis"], zorder=1)
    ax.set_xlabel(xlabel); ax.set_ylabel(ylabel); ax.legend(loc="upper left", bbox_to_anchor=(1.005, 1), fontsize=8.5, frameon=False)
    ax.set_title(question, loc="left", pad=24, size=11.5, weight="bold"); ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], size=8.5, va="bottom")
    fs.finish(fig, bul, top=1 - 0.95 / H, right=0.84)
    return fig
```

## Calibration

Read when: a price is read as a probability (a prediction market, an implied vol turned into a hit rate) and the question is whether it is paid as often as it says.

Category: The edge

- **Question:** `Is <the outcome> priced above how often it happens?`
- **Inputs:** Per price bin: `price` (mean implied probability), `hit` (realised share), `lo`, `hi` (the interval on `hit`; cluster by event, not by market, when events hold several markets), all 0 to 1; `window`, `bul`; `positive_is_good` (True when a price above the hit rate pays the side you take); the cell-8 style (`figstyle.NAMES`, dpi 110).
- **How to draw:**
  - Left: realised share against implied probability, one solid line with an interval bar per bin, and the diagonal as an ink, dotted line labelled `priced = paid`.
  - Right: price minus hit rate in points, one bar per bin: green where the gap pays the side taken, red where it costs it. Full colour only where the interval excludes the price; a faint bar is inside the noise.
  - Bin edges and the minimum count per bin go in a bullet; a bin below it is not drawn.
- **How to read it:** Pass: the points sit on the diagonal, or the gap bars are full colour in the direction the thesis needs. Fail: faint bars where the thesis needs a gap, or a gap that changes sign across bins (a bias in one band, not a mispricing).
- **Pairs with:** Step 1, the thesis term: the study's own gate is that the gap's interval stays on one side of zero.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.colors import to_rgba
from fundplat.quant.core import figstyle as fs


def draw_calibration(price, hit, lo, hi, question, window, bul, q2="Where is the gap largest?", positive_is_good=True, h=5.2):
    """Per price bin: price, hit (realised share), lo and hi (its interval), all 0..1. Returns the figure."""
    N, G, R = fs.NEUTRAL, fs.VERDICT["good"], fs.VERDICT["bad"]
    price, hit, lo, hi = (np.asarray(a, float) for a in (price, hit, lo, hi))
    H = h + fs.nlines(bul) * 0.205 + 1.0
    fig, (ax, ax2) = plt.subplots(1, 2, figsize=(13, H), gridspec_kw={"wspace": 0.22})
    ax.plot([0, 1], [0, 1], color=N["ink"], lw=1.3, ls=":")
    ax.text(1, 1, "priced = paid ", ha="right", va="bottom", color=N["ink"], size=9)
    ax.errorbar(price, hit, yerr=[hit - lo, hi - hit], color=fs.QUANTITY["funding"], lw=2.4, marker="o", ms=4, capsize=3)
    ax.set_ylabel("share that happened, with its interval"); ax.set_ylim(0, 1.06)
    gap = (price - hit) * 100
    col = [to_rgba(G if (g > 0) == positive_is_good else R, 1 if s else 0.35) for g, s in zip(gap, (price < lo) | (price > hi))]
    ax2.bar(price, gap, width=0.8 * np.diff(np.sort(price)).min(), color=col); ax2.axhline(0, color=N["ink"])
    ax2.set_ylabel("price minus share that happened, points")
    for a, t, sub in ((ax, question, window), (ax2, q2, "faint bar: the interval reaches the price")):
        a.set_xlabel("average implied probability"); a.set_xlim(0, 1.02)
        a.set_title(t, loc="left", pad=24, size=11.5, weight="bold"); a.text(0, 1.012, sub, transform=a.transAxes, color=N["muted"], size=8.5, va="bottom")
    bm = fs.bullets(fig, bul); fig.subplots_adjust(top=1 - 0.95 / H, bottom=bm + 0.6 / H, left=0.07, right=0.97)
    return fig
```

## Rolling statistics

Read when: the base has passed and the question is whether its edge and its exposure hold through the window or sit in one stretch of it.

Category: The run

- **Question:** Is the edge steady through the window, or does it come and go?
- **Inputs:** `sharpe`, a rolling Sharpe Series (not yet in `fundplat.quant.core.stats`); `beta`, a DataFrame, one column per leg or benchmark, each from `stats.rolling_slope(y, x, window)`; `won`, a 0/1 Series per trade with `roll`, its window, and `brk`, the break-even win rate the payout demands (optional); `full_sharpe`, `full_beta`, the full-sample values; `window` text naming the rolling window, date range and hours; `colors`, one identity colour per beta column. Pinned down: every input rides ONE index (the same trade numbers or the same timestamps, never a Sharpe on days beside a win rate on trades) and ONE window length, and each full-sample value is read off the same series its rolling line is. Any of `sharpe`, `beta`, `won` may be `None` (a binary-payout study feeds `won` alone); at least one is needed.
- **How to draw:**
  - One to three stacked panels on one time axis (a second scale is a second panel, never a twin axis): Sharpe, then betas, then win rate.
  - Sharpe: a solid line, green fill above zero and red below, keyed in the legend. Each beta: a solid line in its leg's identity colour. Win rate: a solid ink line on a 0 to 1 axis, the break-even a loosely dotted ink line (this is the old `Rolling win rate` chart, folded in: the same trade series as a 0/1).
  - The full-sample value is an ink dotted line in each panel, named in the legend with its number. Legends above the panels.
  - One table: full sample, median, min, max and share of windows below the line (zero; the break-even for the win rate) for each panel's series; the first row's share gold.
  - On a trade-indexed axis the x is trades in time order, not a clock, and the notes give the hour span each window covers.
- **How to read it:** Pass: the rolling Sharpe stays on one side of zero in most windows, each beta stays near its dotted line and the win rate stays above the break-even. Fail: the sign flips between windows, the edge sits in one stretch, a beta drifts from its full-sample value, or the win rate crosses the break-even often.
- **Pairs with:** step 2, is it real (the edge holds across the window); `Win/loss distribution` (the trades themselves); `Equity curve` (the size of each trade, where this chart shows the share that wins)
- **Exemplar:** none yet
- **Code:**

```python
import pandas as pd
from fundplat.quant.core import figstyle as fs


def draw_rolling_statistics(window, notes, sharpe=None, beta=None, full_sharpe=None, full_beta=None, colors=None, won=None, roll=None, brk=None,
                            question="Is the edge steady through the window, or does it come and go?"):
    """sharpe: rolling Sharpe Series; beta: DataFrame, one column per leg; full_*: full-sample values; won: 0/1 per trade, roll its window, brk the break-even rate. Any of the three may be None."""
    N, V = fs.NEUTRAL, fs.VERDICT
    rate = None if won is None else pd.Series(won, dtype=float).rolling(roll).mean().dropna()
    panels = [k for k, v in (("sharpe", sharpe), ("beta", beta), ("win", rate)) if v is not None]
    assert panels, "feed at least one of sharpe, beta, won"
    fig, gs, ax, axt = fs.fig_tab(3.4 + 1.9 * len(panels), (1.6 * len(panels), 1.0), top=0.84, nb=fs.nlines(notes)); ax.axis("off")
    axs = [fig.add_subplot(g) for g in gs[0].subgridspec(len(panels), 1, hspace=0.3)]
    for a in axs[1:]:
        a.sharex(axs[0])
    ref = lambda a, v, t, ls=":": a.axhline(v, color=N["ink"], ls=ls, label=t)
    rows = []                                    # (name, series, full-sample value, the line a window is counted below)
    for a, k in zip(axs, panels):
        if k == "sharpe":
            s = sharpe.dropna()
            a.plot(s, color=N["ink2"], lw=2, label="rolling Sharpe")
            for m, c, t in ((s >= 0, "good", "above"), (s < 0, "bad", "below")):
                a.fill_between(s.index, s, 0, where=m, interpolate=True, color=V[c], alpha=0.2, lw=0, label=t + " zero")
            ref(a, full_sharpe, f"full sample {full_sharpe:.2f}"); a.set_ylabel("Sharpe"); rows.append(("Sharpe", s, full_sharpe, 0.0))
        elif k == "beta":
            for c, b in zip(colors or list(fs.IDENTITY.values()), beta.columns):
                a.plot(beta[b], color=c, lw=2, label=f"beta to {b}"); ref(a, full_beta[b], f"full sample, {b} {full_beta[b]:.2f}"); rows.append((f"Beta to {b}", beta[b], full_beta[b], 0.0))
            a.set_ylabel("beta")
        else:
            a.plot(rate, color=N["ink"], lw=2.2, label=f"rolling win rate, {roll} trades")
            full = float(pd.Series(won, dtype=float).mean()); ref(a, full, f"full sample {full:.0%}")
            if brk is not None:
                ref(a, brk, f"break-even {brk:.0%}", (0, (1, 3)))
            a.set_ylim(0, 1.02); a.set_ylabel("share that win"); rows.append(("Win rate", rate, full, brk if brk is not None else 0.0))
        if k != "win":
            a.axhline(0, color=N["axis"])
        a.legend(fontsize=8.5, frameon=False, loc="lower right", bbox_to_anchor=(1, 1), ncol=5)
    for a in axs[:-1]:
        a.tick_params(labelbottom=False)
    fig.suptitle(question, x=0.07, ha="left", size=11.5, weight="bold"); fig.text(0.07, 0.925, window, color=N["muted"], size=8.5)
    cells = [[n, f"{f:.2f}", f"{v.median():.2f}", f"{v.min():.2f}", f"{v.max():.2f}", f"{(v.dropna() < line).mean():.0%}"] for n, v, f, line in rows]
    tb = fs.put_table(axt, cells, ["", "Full sample", "Median", "Min", "Max", "Windows below the line"], first=0.25)
    fs.gold(tb, 1, 5); fs.bullets(fig, notes)
    return fig
```

## Monte Carlo and ruin

Read when: a strategy is about to be sized and the desk needs the odds of breaching its drawdown limit, or a pre-registered stop on a series must clear how far it could go in the next weeks, not the one path history happened to draw.

Category: The luck

- **Question:** Does the book stay inside its drawdown limit on resampled paths?
- **Inputs:** `paths`, an (n_paths, n_steps) equity matrix from a trade or block resampler; `limit` (the desk drawdown limit) and `tol` (the breach probability accepted), fractions fixed before the run [U]; optional `stop`, the pre-registered stop as a level on the rebased paths (start = 1, [U]); `window`, `notes`. No resampler in `fundplat` yet.
- **How to draw:**
  - Left: up to `n_show` faint paths, muted inside the limit, red on a breach; muted 25th to 75th and 5th to 95th percentile bands (the fan); the median path ink. A `stop` is an ink dotted horizontal whose legend entry gives the share of paths that touch it, counted on the worst point of each path, not the last (this is the old `Path fan`, folded in: the threshold is a parameter of the scored chart, not a type).
  - Right: each path's max drawdown as a histogram, green inside the limit, red past it; the limit an ink dotted line.
  - One table: paths, breach probability, drawdown (median, 95th pct), result (median, 5th pct), share ending below start; breach cell gold, tinted green or rose.
  - Top right: PASS or FAIL, breach probability against tolerance. Legends in headroom.
- **How to read it:** Pass: breach probability within the tolerance. Fail: the red tail crosses the limit more often than accepted, or the stop sits inside the 5% band so a rung sized to it is liquidated by an ordinary month; size down, never widen the limit. Paths from one window are one result, and a fan is a sketch of one resampling model, which the bullets say.
- **Pairs with:** step 4, sizing (gate 4 in `research.md#six-gates-size-last`)
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_monte_carlo_and_ruin(paths, limit, tol, window, notes, x=None, n_show=60, stop=None, question="Does the book stay inside its drawdown limit on resampled paths?"):
    N, V, P = fs.NEUTRAL, fs.VERDICT, np.percentile
    e = np.asarray(paths, float); e = e / e[:, :1]; x = np.arange(e.shape[1]) if x is None else x
    mdd = (1 - e / np.maximum.accumulate(e, axis=1)).max(axis=1); hit = mdd >= limit; p = hit.mean(); ok = p <= tol; term = e[:, -1] - 1
    fig, gs, ax, axt = fs.fig_tab(6.6, (2.8, 0.7), nb=fs.nlines(notes)); ax.axis("off")
    a1, a2 = (fig.add_subplot(g) for g in gs[0].subgridspec(1, 2, width_ratios=(1.5, 1)))
    for i in range(min(n_show, len(e))):
        a1.plot(x, e[i], color=V["bad"] if hit[i] else N["muted"], alpha=0.3)
    lo, med, hi = P(e, [5, 50, 95], axis=0)
    a1.fill_between(x, lo, hi, color=N["muted"], alpha=0.25, label="5th to 95th percentile")
    q1, q3 = P(e, [25, 75], axis=0)
    a1.fill_between(x, q1, q3, color=N["muted"], alpha=0.35, label="25th to 75th")
    a1.plot(x, med, color=N["ink"], lw=2.2, label="median path")
    if stop is not None:                         # touched on the worst point of each path, not its last
        touch = e.min(axis=1) <= stop if stop < np.median(e[:, -1]) else e.max(axis=1) >= stop
        a1.axhline(stop, color=N["ink"], ls=":", label=f"stop {stop:g}: touched on {touch.mean():.0%} of paths")
    a1.set_ylabel("equity, start = 1")
    a2.hist([mdd[~hit], mdd[hit]], bins=40, stacked=True, color=[V["good"], V["bad"]], alpha=0.6, label=["inside the limit", "breach"])
    a2.axvline(limit, color=N["ink"], ls=":", label=f"desk limit {limit:.0%}")
    a2.xaxis.set_major_formatter("{x:.0%}"); a2.set_xlabel("max drawdown of a path"); a2.set_ylabel("paths")
    for a, loc in ((a1, "upper left"), (a2, "upper right")):
        a.margins(y=0.25); a.legend(loc=loc, frameon=False)
    fig.suptitle(question, x=0.07, ha="left", size=11.5, weight="bold"); fig.text(0.07, 0.925, window, color=N["muted"], size=8.5)
    fig.text(0.97, 0.925, f"{'PASS' if ok else 'FAIL'}: breach {p:.1%} against {tol:.1%}", ha="right", color=V["good" if ok else "bad"], weight="bold")
    cells = [[f"{len(e):,}", *(f"{v:.1%}" for v in (p, *P(mdd, [50, 95]), *P(term, [50, 5]), (term < 0).mean()))]]
    tb = fs.put_table(axt, cells, ["Paths", "Breach", "Median drawdown", "95th drawdown", "Median result", "5th result", "Below start"])
    fs.gold(tb, 1, 1); fs.tint(tb, 1, 1, "green" if ok else "rose"); fs.bullets(fig, notes)
    return fig
```

## Sample funnel and coverage

Read when: a study draws its sample from a larger frame (markets, hours, days, books) and the reader must see what survived each filter and what the sample covers, before any result is shown.

Category: The data

- **Question:** How many of them survive each filter?
- **Inputs:** `steps` (ordered `(label, count)`, never growing, the last is the sample the result stands on), `notes`, `window`.
- **How to draw:**
  - One axes: a horizontal bar per step, first step on top, counts at the bar ends with the share of the first step; log x when the first step is over 100 times the last.
  - Bars are neutral grey (ink2): a count is not a verdict, so no green or red.
  - Findings: what each filter removed and why, the drop-outs that are not filters (a venue that served no history), and what the sample cannot speak for.
- **How to read it:** Pass: every drop has a named reason and the final count is large enough for the test it feeds. Fail: a step with no reason, a drop that could correlate with the outcome (survivorship), or a last step too small for the gate that uses it.
- **Pairs with:** gate 0 (`research.md#six-gates-size-last`): data and sanity; the sample the later gates stand on.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_sample_funnel_and_coverage(steps, notes, window, question="How many of them survive each filter?"):
    N = fs.NEUTRAL
    labels, counts = [s[0] for s in steps], np.array([s[1] for s in steps], float)
    assert (np.diff(counts) <= 0).all() and counts[-1] > 0, "a funnel never grows and never empties"
    nb = fs.nlines(notes)
    fig, ax = plt.subplots(figsize=(13, 2.6 + 0.34 * len(steps) + nb * 0.205))
    fig.subplots_adjust(left=0.30, right=0.97, top=1 - 0.9 / fig.get_size_inches()[1], bottom=fs.bullet_margin(fig, nb) + 0.06)
    y = np.arange(len(steps))[::-1]
    ax.barh(y, counts, color=N["ink2"], height=0.62)
    if counts[0] > 100 * counts[-1]:
        ax.set_xscale("log")
    for yi, c in zip(y, counts):
        ax.text(c * 1.08, yi, f"{c:,.0f}  ({c / counts[0]:.0%})", va="center", fontsize=8.5, color=N["ink"])
    ax.set_xlim(counts[-1] * 0.5 if ax.get_xscale() == "log" else 0, counts[0] * (4 if ax.get_xscale() == "log" else 1.25))
    ax.set_yticks(y); ax.set_yticklabels(labels, fontsize=8.5); ax.grid(axis="y", visible=False)
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Autocorrelation

Read when: a hold, a signal window or a rule's horizon depends on how long a series (a premium, a funding rate, a daily P&L) remembers itself, and one half-life number would hide the shape.

Category: The edge

- **Question:** How long does the series remember itself?
- **Inputs:** `x` (an evenly spaced series), `max_lag` (steps), `step_h` (hours per step), `notes`, `window`.
- **How to draw:**
  - One axes: the autocorrelation at each lag as a bar, ink where it clears the 95% band and grey (ink2) where it does not.
  - The AR(1) curve (`rho` to the lag) is one solid ink line, labelled with `rho` and the half-life in hours. The band (plus or minus 1.96 over the square root of n) is two ink dotted lines with a text label.
  - A partial autocorrelation panel is not drawn: the decision needs the half-life, and that is on the chart.
- **How to read it:** Pass: the bars follow the AR(1) curve and the planned hold is shorter than the half-life. Fail: bars cross zero in a pattern the curve misses (a daily cycle), or the planned hold is longer than the half-life, which bets on the regime, not on the print.
- **Pairs with:** gate 3 and the pre-registered hold (`research.md#six-gates-size-last`); `Signal decay` for the response after a stretch.
- **Exemplar:** none yet (draw this when a half-life printed as a number alone is in doubt)
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_autocorrelation(x, max_lag, step_h, notes, window, question="How long does the series remember itself?"):
    N = fs.NEUTRAL
    x = np.asarray(x, float) - np.mean(x)
    lags = np.arange(1, max_lag + 1)
    acf = np.array([x[:-k] @ x[k:] / (x @ x) for k in lags])
    band, rho = 1.96 / np.sqrt(len(x)), acf[0]
    half = np.log(0.5) / np.log(rho) * step_h if 0 < rho < 1 else float("nan")
    nb = fs.nlines(notes)
    fig, ax = plt.subplots(figsize=(13, 4.4 + nb * 0.205))
    fig.subplots_adjust(left=0.07, right=0.97, top=1 - 0.9 / fig.get_size_inches()[1], bottom=fs.bullet_margin(fig, nb) + 0.08)
    ax.bar(lags, acf, color=[N["ink"] if abs(a) > band else N["ink2"] for a in acf], width=0.6)
    ax.plot(lags, rho ** lags, color=N["ink"], linewidth=2.2, label=f"AR(1) fit: rho {rho:.2f}, half-life {half:.1f} h")
    for b in (band, -band):
        ax.axhline(b, color=N["ink"], linewidth=1.2, linestyle=":")
    ax.text(max_lag, band, f"95% band {band:.2f} ", ha="right", va="bottom", fontsize=8.5, color=N["ink"])
    ax.axhline(0, color=N["axis"], linewidth=1)
    ax.set_xlabel(f"lag, steps of {step_h:g} h"); ax.set_ylabel("autocorrelation"); ax.legend(loc="best", frameon=False)
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Signal and outcome scatter

Read when: a rule trades on a signal (a stretch, a rank, a score) and the question is whether the signal and what follows it move together across trades, before any threshold is chosen.

Category: The edge

- **Question:** Does the signal predict the outcome?
- **Inputs:** `signal` and `outcome` (one pair per trade, bar or market; both in their own units), `bins` (quantile bins, e.g. 10), `xlabel`, `ylabel`, `notes`, `window`.
- **How to draw:**
  - One axes: every pair a small grey dot (muted, translucent); the mean outcome per signal bin as one solid ink line with round markers; zero on both axes in the quiet axis colour.
  - The legend carries the rank correlation and the pair count. No fitted straight line: the binned means show the shape.
  - One figure per signal. Pairs from one window are one observation re-sliced, so the bullets say how many are independent (days, events).
- **How to read it:** Pass: the binned means rise (or fall) through the threshold the rule uses, over most bins, and the rank correlation survives dropping the three largest pairs. Fail: a flat line, a slope set by a few extremes, or a signal whose pairs cluster in one week.
- **Pairs with:** gate 1 (`research.md#six-gates-size-last`); `Out-of-sample test` when x is the first half and y the later half.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_signal_and_outcome_scatter(signal, outcome, bins, xlabel, ylabel, notes, window, question="Does the signal predict the outcome?"):
    N = fs.NEUTRAL
    x, y = np.asarray(signal, float), np.asarray(outcome, float)
    rho = np.corrcoef(np.argsort(np.argsort(x)), np.argsort(np.argsort(y)))[0, 1]
    edges = np.quantile(x, np.linspace(0, 1, bins + 1))
    idx = np.clip(np.searchsorted(edges, x, side="right") - 1, 0, bins - 1)
    mx = [x[idx == b].mean() for b in range(bins) if (idx == b).any()]
    my = [y[idx == b].mean() for b in range(bins) if (idx == b).any()]
    nb = fs.nlines(notes)
    fig, ax = plt.subplots(figsize=(13, 5.2 + nb * 0.205))
    fig.subplots_adjust(left=0.07, right=0.97, top=1 - 0.9 / fig.get_size_inches()[1], bottom=fs.bullet_margin(fig, nb) + 0.08)
    ax.scatter(x, y, s=10, color=N["muted"], alpha=0.45, linewidths=0, label=f"{len(x):,} pairs")
    ax.plot(mx, my, color=N["ink"], linewidth=2.4, marker="o", label=f"mean per bin ({bins} bins), rank correlation {rho:+.2f}")
    ax.axhline(0, color=N["axis"], linewidth=1); ax.axvline(0, color=N["axis"], linewidth=1)
    ax.set_xlabel(xlabel); ax.set_ylabel(ylabel); ax.legend(loc="best", frameon=False)
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Clock and staleness

Read when: a number mixes two clocks (a stock leg that is shut while its perp trades, a book marked at the close against one marked at fair value) and you must show whether it measures the market or the clocks.

Category: The data

- **Question:** Is the number one clock or two?
- **Inputs:** `marked` (label to series: the same quantity under each marking, evenly spaced days; two or three), `notes`, `window`.
- **How to draw:**
  - One panel per marking, sharing the y axis: each day's value across, the next day's up, one grey dot per day pair, equal limits, zero lines in the axis colour.
  - A solid ink line is the least-squares fit; its slope and the lag-1 correlation go in the legend.
  - Findings: the daily standard deviation under each marking, and which risk numbers (drawdown, Sharpe, a liquidation test) the stale marking may not be used for.
- **How to read it:** Pass: the slope and correlation sit near zero under every marking. Fail: a clearly negative slope under one marking and not the other: the move one day is given back the next, so that marking measures the clock, and no risk number read on it may size a rung.
- **Pairs with:** gate 0 and `law/how-we-know.md#what-would-it-print-if-false`; `Hedge and basis` for the staleness of each leg's price.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_clock_and_staleness(marked, notes, window, unit="USD", question="Is the daily P&L one clock or two?"):
    N = fs.NEUTRAL
    nb = fs.nlines(notes)
    fig, axs = plt.subplots(1, len(marked), figsize=(13, 5.4 + nb * 0.205), sharey=True, squeeze=False)
    axs = axs[0]
    fig.subplots_adjust(left=0.07, right=0.97, top=0.82, bottom=fs.bullet_margin(fig, nb) + 0.1, wspace=0.06)
    lim = max(np.abs(np.asarray(s, float)).max() for s in marked.values()) * 1.08
    for ax, (lab, s) in zip(axs, marked.items()):
        s = np.asarray(s, float)
        a, b = s[:-1], s[1:]
        slope, ac = np.polyfit(a, b, 1)[0], np.corrcoef(a, b)[0, 1]
        ax.scatter(a, b, s=34, color=N["muted"], alpha=0.7, linewidths=0)
        ax.plot([-lim, lim], [-slope * lim, slope * lim], color=N["ink"], linewidth=1.8, label=f"fit: slope {slope:+.2f}, correlation {ac:+.2f}")
        ax.axhline(0, color=N["axis"], linewidth=1); ax.axvline(0, color=N["axis"], linewidth=1)
        ax.set_xlim(-lim, lim); ax.set_ylim(-lim, lim); ax.set_xlabel(f"one day, {unit}")
        ax.legend(loc="upper right", fontsize=8.5, frameon=False); ax.set_title(lab, fontsize=10, loc="left", pad=6)
    axs[0].set_ylabel(f"the next day, {unit}")
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Exposure over time

Read when: a book holds legs that are priced on different clocks or hedged after the fact, and the reader must see how much of the book was unhedged, on which leg and for how long.

Category: The book

- **Question:** Which leg is naked, and for how long?
- **Inputs:** `t` (times), `legs` (leg to USD exposure series, signed), `limit` (the largest net exposure the desk accepts, USD), `stale` (optional: instrument to hours since its last price), `notes`, `window`.
- **How to draw:**
  - Top: each leg as one solid line (ink, ink2, muted in turn), zero in the quiet axis colour.
  - Middle: the net exposure in ink, the limit as two ink dotted lines with a text label; stretches beyond the limit shaded red and keyed in the legend.
  - Bottom (when `stale` is given): hours since each price last moved as solid lines, so a sawtooth shows a shut market.
  - Findings: hours beyond the limit, the largest net, and what the mark is blind to while a leg is stale.
- **How to read it:** Pass: the net stays inside the limit and every breach is shorter than the time the hedge takes to place. Fail: a stretch of breach that the daily mark hides (a stale leg), or a net that drifts out and stays out.
- **Pairs with:** gate 4 and the stop in `research.md#six-gates-size-last`; `Clock and staleness` for what stale marks do to a P&L.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_exposure_over_time(t, legs, limit, notes, window, stale=None, question="Which leg is naked, and for how long?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    cols = (N["ink"], N["ink2"], N["muted"])
    t, net = np.asarray(t), sum(np.asarray(v, float) for v in legs.values())
    nr = 3 if stale else 2
    nb = fs.nlines(notes)
    fig, axs = plt.subplots(nr, 1, figsize=(13, 3.2 + 1.7 * nr + nb * 0.205), sharex=True, gridspec_kw=dict(height_ratios=[1.5, 1.2, 0.8][:nr], hspace=0.15))
    fig.subplots_adjust(left=0.07, right=0.97, top=1 - 0.95 / fig.get_size_inches()[1], bottom=fs.bullet_margin(fig, nb) + 0.07)
    for (lab, v), c in zip(legs.items(), cols):
        axs[0].plot(t, v, color=c, linewidth=1.8, label=lab)
    axs[0].axhline(0, color=N["axis"], linewidth=1); axs[0].legend(loc="best", ncol=len(legs), fontsize=8.5, frameon=False); axs[0].set_ylabel("USD per leg")
    axs[1].plot(t, net, color=N["ink"], linewidth=2.0)
    axs[1].fill_between(t, 0, net, where=np.abs(net) > limit, color=V["bad"], alpha=0.25, linewidth=0, label=f"net beyond the limit ({np.mean(np.abs(net) > limit):.0%} of the time)")
    for b in (limit, -limit):
        axs[1].axhline(b, color=N["ink"], linewidth=1.2, linestyle=":")
    axs[1].text(t[0], limit, f" limit {limit:,.0f}", va="bottom", fontsize=8.5, color=N["ink"])
    axs[1].axhline(0, color=N["axis"], linewidth=1); axs[1].legend(loc="best", fontsize=8.5, frameon=False); axs[1].set_ylabel("net, USD")
    if stale:
        for (lab, h), c in zip(stale.items(), cols):
            axs[2].plot(t, h, color=c, linewidth=1.6, label=lab)
        axs[2].legend(loc="best", ncol=len(stale), fontsize=8.5, frameon=False); axs[2].set_ylabel("hours stale")
    axs[0].set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    axs[0].text(0, 1.012, window, transform=axs[0].transAxes, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Book depth over time

Read when: a rule's fill depends on size that may not be there (a tail, a size deep in the book) and the reader must see where the size actually rested, and when.

Category: Size and cost

- **Question:** Where did the size rest, and how far out?
- **Inputs:** `t_s` (seconds into the window), `cell` (n_time x n_price resting size: a column per instant, a row per price bin; `book_cells` builds it from the book frames), `mid` (the mid series, NaN where the book is one-sided), `window`, `notes`.
- **How to draw:**
  - One panel. A column per instant, a row per price 0 to 1, filled grey by resting size on a ramp drawn from the NEUTRAL steps alone (surface to ink). Size is the only thing the grey means; there is never a second scale. The bank has no sequential hue ramp and every hue is taken (amber and blue are the legs, the asset colours are assets, green and red are verdicts), so a magnitude is lightness, not hue.
  - `imshow`, never `pcolormesh`: `figstyle.check` reads a pcolormesh's default colour as off-palette.
  - The mid is an ink dotted reference line, labelled on the line, never in a legend box (a box sits over the book). `figstyle.check` allows a dotted ink threshold path; it is not a series, so the solid-series rule does not bite.
  - Hairlines at 0.05 and 0.95 mark the tail. The findings carry the size resting outside them and the median size within 2c of the touch.
- **How to read it:** the dark bands are the sizes a rule could actually have taken, at the prices they sat at, for as long as they sat there. A dark band far from the mid is size a tail rule could have hit; a blank cell is a price with no order at all. A rule sized from the top of book is readable here as a rule that filled in the pale margin.
- **Pairs with:** `Sizing and fill` (what the fill cost), `Clock and staleness` (whether the book and the mark share a clock), and `law/how-we-know.md#what-would-it-print-if-false`.
- **Exemplar:** none yet
- **Not enforced:** `figstyle.check` does not read an `imshow` colormap. A viridis grid passed it when planted, so the grey-only ramp binds by this chapter alone. A coloured magnitude ramp would be a change to `figstyle`, not a local choice.
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
from fundplat.quant.core import figstyle as fs


def book_cells(frames, bins=100):
    """(n_time, bins) resting size per 1c price bin, and the mid series, from [t, [[px,sz]..], [[px,sz]..]] frames (px in 1/10,000, each side best first)."""
    cell = np.zeros((len(frames), bins))
    for i, (_, bid, ask) in enumerate(frames):
        for p, z in bid + ask:
            cell[i, min(bins - 1, p // 100)] += z
    mid = np.full(len(frames), np.nan)
    for i, (_, bid, ask) in enumerate(frames):
        if bid and ask:
            mid[i] = (bid[0][0] + ask[0][0]) / 20000
    return cell, mid


def draw_book_depth_over_time(t_s, cell, mid, window, notes, question="Where did the size rest, and how far out?"):
    """Resting size through the book over one window: a column per instant, a row per price, grey by size. The mid is a dotted ink reference line."""
    N = fs.NEUTRAL
    grey = LinearSegmentedColormap.from_list("grey", [N["surface"], N["grid"], N["axis"], N["muted"], N["ink2"], N["ink"]])
    nb = fs.nlines(notes)
    fig, ax = plt.subplots(figsize=(13, 5.6 + nb * 0.205))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.83, bottom=fs.bullet_margin(fig, nb) + 0.10)
    vmax = float(np.percentile(cell[cell > 0], 95)) if (cell > 0).any() else 1.0
    ax.imshow(cell.T, origin="lower", aspect="auto", cmap=grey, vmin=0.0, vmax=vmax,
              extent=[t_s[0], t_s[-1], 0.0, 1.0], interpolation="nearest")
    ok = np.isfinite(mid)
    ax.plot(t_s[ok], mid[ok], color=N["ink"], linewidth=1.6, linestyle=(0, (1, 2.4)))
    last_t, last_p = t_s[ok][-1], mid[ok][-1]
    ax.annotate("mid", (last_t, last_p), xytext=(-6, 12), textcoords="offset points",
                ha="right", fontsize=9, color=N["ink"])
    ax.axhline(0.05, color=N["axis"], linewidth=0.8); ax.axhline(0.95, color=N["axis"], linewidth=0.8)
    ax.set_xlim(t_s[0], t_s[-1]); ax.set_ylim(0.0, 1.0)
    ax.set_xlabel("seconds into the window"); ax.set_ylabel("price")
    ax.set_yticks([0.0, 0.25, 0.5, 0.75, 1.0])
    ax.tick_params(labelsize=8.5)
    for sp in ("top", "right"):
        ax.spines[sp].set_visible(False)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.finish(fig, notes, top=0.83)
    return fig
```

## Premium over realized

Read when: a short-option or short-vol book earns the gap between the vol the market charges (implied) and the vol that then occurs (realized), and the gate metric is that gap.

Category: The edge

- **Question:** Does the market charge more than what then happens?
- **Inputs:** `t`, `implied` and `realized` (vol points, realized measured over the same horizon after each stamp), `by_period` (period label to mean spread, e.g. by year or quarter), `notes`, `window`.
- **How to draw:**
  - Left: implied and realized as two solid lines (ink and muted); the gap between them shaded green where implied is above realized (the seller gains) and red where below, keyed in the legend.
  - Right: the mean spread per period as bars (green positive, red negative) with the share of stamps where implied exceeded realized as text over each bar.
  - Daily stamps overlap, so the bullets state the count of independent horizons, not of stamps.
- **How to read it:** Pass: the mean spread is positive in most periods and the share above half. Fail: one period carries the mean, or the spread flips sign in the periods that hold the stress.
- **Pairs with:** a vol-term gate; `Regime and concentration` for how much sits in one period.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from fundplat.quant.core import figstyle as fs


def draw_premium_over_realized(t, implied, realized, by_period, notes, window, question="Does the market charge more than what then happens?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    t, iv, rv = np.asarray(t), np.asarray(implied, float), np.asarray(realized, float)
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 4.8 + nb * 0.205), gridspec_kw=dict(width_ratios=(2.2, 1)))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.82, bottom=fs.bullet_margin(fig, nb) + 0.1, wspace=0.18)
    a1.plot(t, iv, color=N["ink"], linewidth=1.8); a1.plot(t, rv, color=N["muted"], linewidth=1.8)
    a1.fill_between(t, iv, rv, where=iv >= rv, color=V["good"], alpha=0.25, linewidth=0)
    a1.fill_between(t, iv, rv, where=iv < rv, color=V["bad"], alpha=0.25, linewidth=0)
    a1.legend(handles=[Patch(color=N["ink"], label="implied"), Patch(color=N["muted"], label="realized"), Patch(color=V["good"], alpha=0.25, label="seller gains"), Patch(color=V["bad"], alpha=0.25, label="seller loses")], loc="best", ncol=2, fontsize=8.5, frameon=False)
    a1.set_ylabel("vol, points")
    names, vals = list(by_period), np.array(list(by_period.values()), float)
    a2.bar(range(len(vals)), vals, color=[V["good"] if v > 0 else V["bad"] for v in vals]); a2.axhline(0, color=N["axis"], linewidth=1)
    a2.set_xticks(range(len(vals))); a2.set_xticklabels(names, fontsize=8.5); a2.set_ylabel("mean implied minus realized, points")
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, f"{window} · {np.mean(iv > rv):.0%} of stamps implied above realized", color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Gap persistence

Read when: a gap between two prices (two venues, a premium) is a candidate trade and the question is whether it lasts long enough to trade or closes before an order can reach it.

Category: The edge

- **Question:** Does the gap last long enough to trade?
- **Inputs:** `first` and `second` (the same pairs' gaps at two reads, in points), `half_lives` (hours, one per pair, `nan` where the gap never decays), `hours_apart` (between the reads), `notes`, `window`.
- **How to draw:**
  - Left: one dot per pair, the first read across and the second up, equal limits, ink dotted diagonal (no change) and zero lines in the axis colour. Dots above the diagonal widened, below narrowed.
  - Right: a histogram of half-lives in hours in muted grey, the median an ink dotted vertical with a label; the pairs that never decay are counted in the legend, not drawn.
- **How to read it:** Pass: dots hug the diagonal and the median half-life is longer than the time to place both legs. Fail: dots collapse toward zero on the second read: the gap is a stale quote, not an edge.
- **Pairs with:** `Autocorrelation` for one series; the cross-venue gap chapter below; `law/how-we-know.md#a-shared-window-is-one-result` (two reads inside one regime are one result).
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_gap_persistence(first, second, half_lives, hours_apart, notes, window, question="Does the gap last long enough to trade?"):
    N = fs.NEUTRAL
    a, b, h = np.asarray(first, float), np.asarray(second, float), np.asarray(half_lives, float)
    lim = float(max(np.abs(a).max(), np.abs(b).max())) * 1.08
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 5.0 + nb * 0.205), gridspec_kw=dict(width_ratios=(1, 1)))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.82, bottom=fs.bullet_margin(fig, nb) + 0.1, wspace=0.18)
    a1.scatter(a, b, s=22, color=N["muted"], alpha=0.7, linewidths=0)
    a1.plot([-lim, lim], [-lim, lim], color=N["ink"], linewidth=1.2, linestyle=":")
    a1.axhline(0, color=N["axis"], linewidth=1); a1.axvline(0, color=N["axis"], linewidth=1)
    a1.set_xlim(-lim, lim); a1.set_ylim(-lim, lim); a1.set_xlabel("gap at the first read, points"); a1.set_ylabel(f"the same pair {hours_apart:g} h later, points")
    ok = h[np.isfinite(h)]
    a2.hist(ok, bins=20, color=N["muted"])
    a2.axvline(np.median(ok), color=N["ink"], linewidth=1.3, linestyle=":")
    a2.text(np.median(ok), a2.get_ylim()[1], f" median {np.median(ok):.1f} h", va="top", fontsize=8.5, color=N["ink"])
    a2.set_xlabel("half-life, hours"); a2.set_ylabel("pairs"); a2.set_title(f"{len(ok)} pairs; {int((~np.isfinite(h)).sum())} never decayed", fontsize=9.5, loc="left", pad=6)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Entry map

Read when: a rule enters some of many fixed windows (short-dated markets, sessions, days) across several lanes, and the reader must see which it entered, how each ended and whether the lanes differ, before any total.

Category: The run

- **Question:** `Which windows did we enter, and how did each end?`
- **Inputs:** `day`, `hour` (the start of each window, hours of the day), `lane` (the instrument or market), `status` (+1 entered and made money, -1 entered and lost, 0 a window with a book and no entry), `be` (the win share the payout needs, optional), `width_h` (a window's length in hours), `notes`, `window`.
- **How to draw:**
  - Left: one bar per window, one row per lane, a block of rows per day; green made money, red lost, grey no entry. Lanes that open together make a column of bars: the findings say the interval is by slot, not by window.
  - Right: per lane, the share of entries that won (ink dot, 95% Wilson interval) and the share of windows entered (muted square); the break-even win share is an ink dotted vertical.
  - Findings: the entered count, the win share against break-even, and the lane with the fewest entries.
- **How to read it:** Pass: every lane enters most windows and its win share sits above the break-even line with the interval clear of it. Fail: a lane that enters little (the rule is another strategy there), a stretch of red across all lanes at once (one event, not several), or a win share under the line.
- **Pairs with:** `Sample funnel and coverage` (why a window did not enter); `Regime and concentration` (which days carried the net); `Trading calendar` (windows one side could not trade).
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from fundplat.quant.core import figstyle as fs


def draw_entry_map(day, hour, lane, status, notes, window, be=None, width_h=0.25, question="Which windows did we enter, and how did each end?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    day, hour, lane, status = (np.asarray(a) for a in (day, hour, lane, status))
    days, lanes = list(dict.fromkeys(day.tolist())), list(dict.fromkeys(lane.tolist()))
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 2.4 + 0.3 * len(days) * (len(lanes) + 1) + nb * 0.205), gridspec_kw=dict(width_ratios=(2.4, 1)))
    fig.subplots_adjust(left=0.08, right=0.97, top=0.83, bottom=fs.bullet_margin(fig, nb) + 0.10, wspace=0.24)
    row = {(d, l): k * (len(lanes) + 1) + j for k, d in enumerate(days) for j, l in enumerate(lanes)}
    ys = np.array([row[(d, l)] for d, l in zip(day.tolist(), lane.tolist())])
    col = {1: V["good"], -1: V["bad"], 0: N["grid"]}
    a1.bar(hour, 0.8, width=width_h * 0.85, bottom=ys, align="edge", color=[col[int(s)] for s in status], linewidth=0)
    a1.set_yticks([row[(d, l)] + 0.4 for d in days for l in lanes])
    a1.set_yticklabels([f"{d}  {l}" if j == 0 else l for d in days for j, l in enumerate(lanes)], fontsize=7.5)
    a1.set_xlim(0, 24); a1.set_xticks(range(0, 25, 3)); a1.invert_yaxis(); a1.grid(False)
    a1.set_xlabel("hour of the day"); a1.set_title("every window, one bar each", loc="left", fontsize=10)
    a1.legend(handles=[Patch(color=V["good"], label="entered, made money"), Patch(color=V["bad"], label="entered, lost money"), Patch(color=N["grid"], label="window with a book, no entry")],
              loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=3, fontsize=8)

    def wilson(k, n, z=1.96):
        p = k / n if n else np.nan
        d = 1 + z * z / max(n, 1)
        c, h = (p + z * z / (2 * max(n, 1))) / d, z * np.sqrt(p * (1 - p) / max(n, 1) + z * z / (4 * max(n, 1) ** 2)) / d
        return p, c - h, c + h

    for j, l in enumerate(lanes):
        m = lane == l
        n_in, won = int((m & (status != 0)).sum()), int((m & (status > 0)).sum())
        for off, (k, n), mk, c, lab in ((0.0, (won, n_in), "o", N["ink"], "won, of entries"), (0.28, (n_in, int(m.sum())), "s", N["muted"], "entered, of windows")):
            p, lo, hi = wilson(k, n)
            a2.errorbar([p], [j + off], xerr=[[p - lo], [hi - p]], fmt=mk, color=c, ecolor=N["ink2"], capsize=3, ms=6, label=lab if j == 0 else None)
    if be is not None:
        a2.axvline(be, color=N["ink"], linewidth=1.1, linestyle=":")
        a2.annotate("break-even win share", (be, 1.0), xycoords=("data", "axes fraction"), xytext=(4, -4), textcoords="offset points", va="top", fontsize=8.5)
    a2.set_yticks([j + 0.14 for j in range(len(lanes))]); a2.set_yticklabels(lanes, fontsize=8.5); a2.invert_yaxis()
    a2.set_xlim(0, 1); a2.set_ylim(len(lanes) - 0.5, -0.5); a2.set_xlabel("share, 95% Wilson interval")
    a2.legend(loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=2, fontsize=8)
    a2.set_title("by lane", loc="left", fontsize=10)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Lead and lag

Read when: two series are said to move one after the other (a venue and its follower, a signal and its response) and the question is who moves first and how much of the move is left when our order lands.

Category: The edge

- **Question:** `Which series leads, and by how long?`
- **Inputs:** `lag` (signed lags, the follower after the leader), `corr` (label to the correlation of changes at each lag; one to three), `resp_t` and `resp` (label to the follower's mean move in the direction of a large leader move, at each time after it), `delay` (our order delay, the unit of `lag`), optional `lo` and `hi` (a band per label from resampled slots or days, never rows), `unit`, `notes`, `window`.
- **How to draw:**
  - Left: correlation against lag, a solid line per label with a light band and a dot at its peak; zero lag in the axis colour, the order delay an ink dotted vertical.
  - Right: the response against time after the move, solid per label, the delay an ink dotted vertical; the legend names the share still to come at the delay.
  - Findings: each peak and its lag, the share left at the delay and what would flip it.
- **How to read it:** Pass: the peak sits at a positive lag and a real share of the response is still to come at the delay. Fail: the peak is at or below the delay, or the response is complete before the order lands: the lead exists and cannot be traded.
- **Pairs with:** `Signal decay` (the response net of a round trip); `Autocorrelation` (a series against itself); `Clock and staleness` (a stale quote is a clock fault, not a lead).
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_lead_and_lag(lag, corr, resp_t, resp, delay, notes, window, lo=None, hi=None, unit="ms", question="Which series leads, and by how long?"):
    N = fs.NEUTRAL
    lag, resp_t = np.asarray(lag, float), np.asarray(resp_t, float)
    cols = [N["ink"], N["ink2"], N["muted"]]
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 5.0 + nb * 0.205))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.82, bottom=fs.bullet_margin(fig, nb) + 0.10, wspace=0.22)
    for (lab, c), col in zip(corr.items(), cols):
        c = np.asarray(c, float)
        k = int(np.nanargmax(c))
        if lo is not None and lab in lo:
            a1.fill_between(lag, lo[lab], hi[lab], color=col, alpha=0.16, linewidth=0)
        a1.plot(lag, c, color=col, linewidth=1.8, label=f"{lab}: peak {c[k]:.2f} at {lag[k]:+.0f} {unit}")
        a1.scatter([lag[k]], [c[k]], s=34, color=col, zorder=4)
    a1.axvline(0, color=N["axis"], linewidth=1)
    a1.axvline(delay, color=N["ink"], linewidth=1.1, linestyle=":")
    a1.annotate("our order delay", (delay, a1.get_ylim()[1]), xytext=(4, -4), textcoords="offset points", ha="left", va="top", fontsize=8.5)
    a1.set_xlabel(f"lag of the follower after the leader, {unit}"); a1.set_ylabel("correlation of the changes")
    a1.set_title("who moves first", loc="left", fontsize=10); a1.legend(loc="best", fontsize=8.5)
    for (lab, r), col in zip(resp.items(), cols):
        r = np.asarray(r, float)
        left = 1 - np.interp(delay, resp_t, r) / r[-1] if r[-1] else np.nan
        a2.plot(resp_t, r, color=col, linewidth=1.8, label=f"{lab}: {left:.0%} still to come at the delay")
    a2.axhline(0, color=N["axis"], linewidth=1)
    a2.axvline(delay, color=N["ink"], linewidth=1.1, linestyle=":")
    a2.set_xlabel(f"{unit} after a large move of the leader"); a2.set_ylabel("follower's mean move, in the move's direction")
    a2.set_title("what is left when the order lands", loc="left", fontsize=10); a2.legend(loc="best", fontsize=8.5)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Steadiness

Read when: a rule's net is positive and the question is whether it arrives day after day or in a few jumps, before a window of a week or two is trusted.

Category: The run

- **Question:** `Does the book climb steadily, or in jumps?`
- **Inputs:** `net` (per entry, in time order), `day` (the day of each entry), `r2_min` (the steadiness gate, set before the run [U]), `others` (label to `(net, day)` for rival variants), `notes`, `window`.
- **How to draw:**
  - Left: the cumulative daily net as a solid step, the drawdown from its running peak shaded red, its straight-line fit an ink dotted line; the legend carries the share of days up and the worst dip.
  - Right: r-squared of the straight line per variant, a dot with a 95% interval from resampling the days, the gate an ink dotted vertical.
  - Findings: the day count (a few days cannot be steady), r-squared with its interval, the worst dip against the net.
- **How to read it:** Pass: the interval's lower end clears the gate and no dip is the size of the run. Fail: r-squared under the gate, or a net carried by one jump (days up near half while the total is high). Resampled days drop their order, so the interval says how straight this set of days could look, not how straight the path was.
- **Pairs with:** `Equity curve` (does it end above the hurdle); `Regime and concentration` (the best few days); `Rolling statistics` (the edge week by week).
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_steadiness(net, day, r2_min, notes, window, others=None, question="Does the book climb steadily, or in jumps?"):
    N, V = fs.NEUTRAL, fs.VERDICT

    def daily(n, d):
        n, d = np.asarray(n, float), np.asarray(d)
        return np.array([n[d == u].sum() for u in np.unique(d)])

    def r2(x):
        c, t = np.cumsum(x), np.arange(1, len(x) + 1)
        return float(1 - np.var(c - np.polyval(np.polyfit(t, c, 1), t)) / np.var(c)) if np.var(c) > 0 else 0.0

    def r2_ci(x, n=1000, seed=11):
        g = np.random.default_rng(seed)
        return np.percentile([r2(x[g.integers(0, len(x), len(x))]) for _ in range(n)], [2.5, 97.5])

    runs = {"this variant": daily(net, day), **{k: daily(*v) for k, v in (others or {}).items()}}
    x = runs["this variant"]
    c, t = np.cumsum(x), np.arange(1, len(x) + 1)
    peak = np.maximum.accumulate(np.maximum(c, 0))
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 4.8 + nb * 0.205), gridspec_kw=dict(width_ratios=(1.6, 1)))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.82, bottom=fs.bullet_margin(fig, nb) + 0.10, wspace=0.24)
    a1.fill_between(t, c, peak, step="post", color=V["bad"], alpha=0.18, linewidth=0, label=f"under water: worst dip {np.max(peak - c):,.0f}")
    a1.step(t, c, where="post", color=N["ink"], linewidth=2.0, label=f"cumulative net, {np.mean(x > 0):.0%} of days up")
    a1.plot(t, np.polyval(np.polyfit(t, c, 1), t), color=N["ink"], linewidth=1.2, linestyle=":", label="its straight-line fit")
    a1.axhline(0, color=N["axis"], linewidth=1)
    a1.set_xlabel("trading day"); a1.set_ylabel("cumulative net, USD"); a1.set_title("the path", loc="left", fontsize=10); a1.legend(loc="best", fontsize=8.5)
    for j, (lab, v) in enumerate(runs.items()):
        lo, hi = r2_ci(v)
        p = r2(v)
        a2.errorbar([p], [j], xerr=[[p - lo], [hi - p]], fmt="o", color=N["ink"] if j == 0 else N["muted"], ecolor=N["ink2"], capsize=3, ms=7)
    a2.axvline(r2_min, color=N["ink"], linewidth=1.1, linestyle=":")
    a2.annotate("steadiness gate", (r2_min, 1.0), xycoords=("data", "axes fraction"), xytext=(4, -4), textcoords="offset points", va="top", fontsize=8.5)
    a2.set_yticks(range(len(runs))); a2.set_yticklabels(list(runs), fontsize=8.5); a2.set_ylim(len(runs) - 0.5, -0.5)
    a2.set_xlim(0, 1); a2.set_xlabel("r-squared of the straight line, 95% over resampled days"); a2.set_title("how straight", loc="left", fontsize=10)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Distribution against model

Read when: a price, a strike or a size is set from a model of how far the outcome can land from its forecast (normal, a fixed width), and the question is whether what happened has that shape.

Category: The edge

- **Question:** `Is the model the right shape?`
- **Inputs:** `z` (outcome minus the model's centre, over its width, one per observation in time order), `cut` (the strike rule's z, optional), `groups` (label to the same z per era; default the halves and all), `xlabel`, `notes`, `window`.
- **How to draw:**
  - Left: `z` as a density histogram in muted grey, the model's N(0, 1) an ink dotted curve, the cut an ink dotted vertical; its label gives the share beyond it against the model's.
  - Middle and right: the mean (fair 0) and the standard deviation (fair 1) per group, a dot with a 95% interval from resampling observations, the fair value an ink dotted vertical.
  - Findings: the mean, the width, the tail beyond the cut against the model, and the era where it differs.
- **How to read it:** Pass: both intervals cover the fair value in every group and the tail beyond the cut is no heavier than the model's. Fail: the centre is off (the model prices the width and misses the centre), the width changes by era, or the tail is heavier: the strike was priced on a shape the data does not have.
- **Pairs with:** `Calibration` (a price against how often it pays); `Significance test`. The refused Q-Q plot reopens here: this is the downstream step that assumes normality.
- **Exemplar:** none yet
- **Code:**

```python
import math
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_distribution_against_model(z, notes, window, cut=None, groups=None, xlabel="standardized outcome, (actual - model centre) / model width", question="Is the model the right shape?"):
    N = fs.NEUTRAL
    z = np.asarray(z, float)
    groups = groups or {"first half": z[: len(z) // 2], "second half": z[len(z) // 2:], "all": z}
    g = np.random.default_rng(11)
    nb = fs.nlines(notes)
    fig, (a1, a2, a3) = plt.subplots(1, 3, figsize=(13, 4.8 + nb * 0.205), gridspec_kw=dict(width_ratios=(1.7, 1, 1)))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.82, bottom=fs.bullet_margin(fig, nb) + 0.10, wspace=0.34)
    x = np.linspace(-6, 4, 200)
    a1.hist(np.clip(z, -6, 4), bins=np.linspace(-6, 4, 41), density=True, color=N["muted"], alpha=0.7, label="what happened")
    a1.plot(x, np.exp(-x * x / 2) / math.sqrt(2 * math.pi), color=N["ink"], linewidth=1.3, linestyle=":", label="the model: N(0, 1)")
    if cut is not None:
        a1.axvline(cut, color=N["ink"], linewidth=1.1, linestyle=":")
        actual = float(np.mean(z <= cut) if cut < 0 else np.mean(z >= cut))
        model = 0.5 * math.erfc(abs(cut) / math.sqrt(2))
        a1.annotate(f"beyond the cut: {actual:.1%} against {model:.1%}", (cut, a1.get_ylim()[1]), xytext=(4, -4), textcoords="offset points", va="top", fontsize=8.5)
    a1.set_xlabel(xlabel, fontsize=8.5); a1.set_ylabel("density"); a1.set_title("the shape", loc="left", fontsize=10); a1.legend(loc="upper right", fontsize=8.5)
    for ax, stat, fair, cap in ((a2, np.mean, 0.0, "centre (fair 0)"), (a3, np.std, 1.0, "width (fair 1)")):
        for j, (lab, v) in enumerate(groups.items()):
            v = np.asarray(v, float)
            d = np.array([stat(v[g.integers(0, len(v), len(v))]) for _ in range(1000)])
            p = float(stat(v))
            ax.errorbar([p], [j], xerr=[[p - np.percentile(d, 2.5)], [np.percentile(d, 97.5) - p]], fmt="o", color=N["ink"], ecolor=N["ink2"], capsize=3, ms=6)
        ax.axvline(fair, color=N["ink"], linewidth=1.1, linestyle=":")
        ax.set_yticks(range(len(groups))); ax.set_yticklabels(list(groups), fontsize=8.5); ax.set_ylim(len(groups) - 0.5, -0.5)
        ax.set_xlabel("95% over resamples", fontsize=8.5); ax.set_title(cap, loc="left", fontsize=10)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Leak probe

Read when: a feature set is built from joins on timestamps and the result looks good, and the question is whether the pipeline could see the future.

Category: The data

- **Question:** `Does the edge change when the features are shown the future?`
- **Inputs:** `ahead` (rows the features are moved earlier: positive is the future, 0 is as built, negative is stale), `edge` (the measured edge at each shift, one unit), optional `lo` and `hi`, `unit` (the axis label), `notes`, `window`.
- **How to draw:**
  - Left: the edge against rows ahead as one solid line with markers and a light band; the as-built edge an ink dotted horizontal; PASS in green when every shift ahead gains and every stale one loses, FAIL in red when not.
  - Right: the change from the as-built edge per shift as ink2 bars (the sign says nothing about money here, so no green or red).
  - Findings: the as-built edge, the edge at the largest shift ahead and at the largest stale shift, and the unit of a row.
- **How to read it:** Pass: the edge rises when the features are shown ahead and falls when they are stale, so a leak would show and the as-built result is not one. Fail: no response (the probe cannot see, and says nothing about the study) or a gain at stale shifts (a future the shift does not explain).
- **Pairs with:** `Clock and staleness`; `Significance test` (placebo draws); step 0 of `research.md#six-gates-size-last`.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_leak_probe(ahead, edge, notes, window, lo=None, hi=None, unit="edge, bp", question="Does the edge change when the features are shown the future?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    ahead, edge = np.asarray(ahead, float), np.asarray(edge, float)
    o = np.argsort(ahead)
    ahead, edge = ahead[o], edge[o]
    built = float(edge[ahead == 0][0])
    sees = bool(np.all(edge[ahead > 0] > built) and np.all(edge[ahead < 0] < built))
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 4.8 + nb * 0.205), gridspec_kw=dict(width_ratios=(1.5, 1)))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.82, bottom=fs.bullet_margin(fig, nb) + 0.10, wspace=0.24)
    if lo is not None:
        a1.fill_between(ahead, np.asarray(lo, float)[o], np.asarray(hi, float)[o], color=N["ink2"], alpha=0.16, linewidth=0)
    a1.plot(ahead, edge, color=N["ink"], linewidth=2.0, marker="o", markersize=5, label="edge when the features are moved")
    a1.axhline(built, color=N["ink"], linewidth=1.1, linestyle=":")
    a1.annotate("as built", (a1.get_xlim()[1], built), xytext=(-4, 4), textcoords="offset points", ha="right", fontsize=8.5)
    a1.axvline(0, color=N["axis"], linewidth=1)
    a1.set_xlabel("rows the features are read ahead (negative: stale)"); a1.set_ylabel(unit)
    a1.set_title("the dose and the response", loc="left", fontsize=10); a1.legend(loc="best", fontsize=8.5)
    a1.text(0.99, 0.97, "PASS: the harness sees the future" if sees else "FAIL: no response to the future", transform=a1.transAxes, ha="right", va="top", fontsize=10,
            fontweight="bold", color=V["good"] if sees else V["bad"])
    d = edge - built
    a2.bar(np.arange(len(d)), d, color=N["ink2"], zorder=3)
    a2.axhline(0, color=N["axis"], linewidth=1)
    a2.set_xticks(np.arange(len(d))); a2.set_xticklabels([f"{a:+.0f}" for a in ahead], fontsize=8.5)
    a2.set_xlabel("rows ahead"); a2.set_ylabel(f"change from as built, {unit.split(',')[-1].strip()}")
    a2.set_title("what the future adds", loc="left", fontsize=10)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```
