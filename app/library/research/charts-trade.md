---
topics: [charts]
type: guide
---

# Charts: can it be traded

These types ask whether a result survives contact with the market and the book: costs, capacity, size and fill, hedges, regimes, correlation with the fund, scenarios. The bank's guide, the type list and the rules are in `charts.md`.

## Cost sensitivity

Read when: a rule nets above the hurdle at the assumed cost and you must show how much more fee, slippage, borrow or delay it survives.

Category: Size and cost

- **Question:** How much cost can the rule take?
- **Inputs:** `cost` (swept cost per fill, increasing, in `xlabel` units), `nets` (label to net USD at each cost; the first is the headline, a second usually out-of-sample), `hurdle` (T-bill USD over the same days), `assumed` (the study's cost), `rows` and `cols` (the table, e.g. a fill-delay ladder, PASS or FAIL last), `notes`, `window`, `xlabel`.
- **How to draw:**
  - One axes: net against cost, one solid line per series with round markers: headline ink, then muted grey, then ink2. Never dashed.
  - Ink dotted labelled thresholds: the T-bill (horizontal) and the break-even cost (vertical, where the headline crosses zero, interpolated). The assumed cost is an ink dashed vertical. Zero is a quiet axis line. Legend `loc='best'`.
  - The table holds the second sweep (late fills, fee tiers), PASS or FAIL per row. Findings: USD lost per unit of cost, and the most passive case as a bound.
- **How to read it:** Pass: no cost up to the pre-registered limit takes the headline below zero (or the hurdle, as the gate says) and the break-even is well right of the assumed cost. Fail: the break-even is at or left of it, or a table row flips the sign.
- **Pairs with:** gate 2 (`research.md#six-gates-size-last`): no cost cell flips the sign.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_cost_sensitivity(cost, nets, hurdle, assumed, rows, cols, notes, window, xlabel="slippage per fill, bp", question="How much cost can the rule take?"):
    N = fs.NEUTRAL
    cost, T = np.asarray(cost, float), dict(color=N["ink"], fontsize=9)
    fig, gs, ax, axt = fs.fig_tab(5.0, (2.4, 1.2), hspace=0.55, nb=fs.nlines(notes))
    for (lab, y), col, w in zip(nets.items(), (N["ink"], N["muted"], N["ink2"]), (2.6, 2.2, 2.0)):
        ax.plot(cost, y, color=col, linewidth=w, marker="o", label=lab)
    y0 = np.asarray(next(iter(nets.values())), float)
    k = np.where((y0[:-1] >= 0) & (y0[1:] < 0))[0]
    be = float(np.interp(0, [y0[k[0] + 1], y0[k[0]]], [cost[k[0] + 1], cost[k[0]]])) if len(k) else None
    ax.axhline(0, color=N["axis"], linewidth=1)
    ax.axhline(hurdle, color=N["ink"], linewidth=1.3, linestyle=":")
    ax.text(cost[-1], hurdle, f"T-bill {hurdle:,.0f} USD ", ha="right", va="bottom", **T)
    ax.axvline(assumed, color=N["ink"], linewidth=1.2, linestyle="--")
    ax.text(assumed, ax.get_ylim()[1], f" assumed {assumed:g}", va="top", **T)
    if be is not None:
        ax.axvline(be, color=N["ink"], linewidth=1.3, linestyle=":")
        ax.text(be, ax.get_ylim()[0], f" break-even {be:.1f}", va="bottom", **T)
    ax.set_xlabel(xlabel); ax.set_ylabel("net P&L, USD")
    ax.legend(loc="best", fontsize=8.5)
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    tb = fs.put_table(axt, rows, cols, first=0.3)
    for i, r in enumerate(rows, 1):
        fs.tint(tb, i, len(cols) - 1, "green" if r[-1] == "PASS" else "rose")
    fs.bullets(fig, notes)
    return fig
```

## Capacity curve

Read when: a strategy has a positive edge at a small size and the question is how large the clip can grow before the cost of trading it eats the edge.

Category: Size and cost

Waits on: a historical size-impact model. Without it the curve is one live depth snapshot (`slippage.vwap_cost`) drawn as if it were a curve; draw it only as a labelled live snapshot, never as a history.

- **Question:** How large can we trade before the edge is gone?
- **Inputs:** `size` traded sizes, ascending; `net` net edge per trade at each size after cost (gross edge less fees and the depth-walk impact from `fundplat.quant.core.slippage.vwap_cost` on a snapshot; a historical model is not built yet); `breakeven` the size where net crosses zero, or None; `clip` the live clip; `others` {label: (array, colour)}, e.g. the edge before cost; axis labels; `table` (cells, cols), a row per size, net edge last.
- **How to draw:**
  - Log x is traded size, y the net edge per trade: a thick ink line, the edge before cost a solid grey line; zero is the axis line.
  - Break-even size and live clip are ink dotted verticals, named mid-plot. A marker on the net line at the clip is green above zero, red otherwise.
  - Table: a few sizes (small, clip, break-even, a large one) with cost and net edge, the net column tinted by its printed sign. Legend lower left. A depth read is a snapshot: the subtitle names its read stamp and the check takes `window_re`.
- **How to read it:** Pass: the clip's marker is green and the break-even is a clear multiple of the clip. Fail: the break-even is at or below the clip, or the net line never turns (the cost model lacks a term; the curve is not evidence).
- **Pairs with:** step 4 (sizing, last) and step 5 (live fill near the assumed cost), `research.md#six-gates-size-last`
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from matplotlib.ticker import FuncFormatter
from fundplat.quant.core import figstyle as fs


def draw_capacity_curve(size, net, breakeven, clip, others, xlabel, ylabel, table, findings, question, window):
    N, V = fs.NEUTRAL, fs.VERDICT
    size, net = np.asarray(size, float), np.asarray(net, float)
    net_clip = float(np.interp(np.log(clip), np.log(size), net))
    fig, gs, ax, axt = fs.fig_tab(7.4, (2.8, 1.4), top=0.80, hspace=0.5, nb=fs.nlines(findings))
    ax.plot(size, net, color=N["ink"], linewidth=2.4, label="net edge after cost")
    for lab, (y, col) in others.items():
        ax.plot(size, y, color=col, linewidth=1.8, label=lab)
    ax.axhline(0, color=N["axis"], linewidth=1)
    for k, name in ((breakeven, "break-even size"), (clip, "live clip")):
        if k:
            ax.axvline(k, color=N["ink"], linestyle=":", linewidth=1.3)
            ax.text(k, 0.5, f"{name} ", transform=ax.get_xaxis_transform(), rotation=90, ha="right", va="center", fontsize=8.5)
    ax.plot([clip], [net_clip], "o", ms=10, color=V["good"] if net_clip > 0 else V["bad"])
    ax.set_xscale("log"); ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:,.0f}")); ax.set_xlabel(xlabel); ax.set_ylabel(ylabel)
    ax.legend(loc="lower left", fontsize=8.5)
    ax.set_title(question, loc="left", fontsize=11.5, fontweight="bold", pad=24)
    ax.text(0, 1.012, window, transform=ax.transAxes, fontsize=8.5, color=N["muted"])
    tb = fs.put_table(axt, table[0], table[1], size=9.5)
    for i, row in enumerate(table[0], 1):
        fs.tint(tb, i, len(table[1]) - 1, "rose" if str(row[-1]).startswith("-") else "green")
    fs.bullets(fig, findings)
    return fig
```

## Sizing and fill

Read when: a ladder of sizes must be checked against room to liquidation, cash and margin, or the live book's fill cost, one rung at a time.

Category: Size and cost

- **Question:** How far can the basis move against us before we are liquidated, at each size?
- **Inputs:** `rungs` labels; `value` the test number per rung (room at the wick, cash needed, round-trip slippage); `threshold` the line it must clear (required room, equity, assumed cost); `higher_is_better` True for room, False for cash and slippage; `thr_label`, `ylabel`; `table` (cells, cols), a row per rung, the rule last; `pick` the chosen rung's index or None. Values come from engine runs and, for fill, a live depth read (`fundplat.quant.core.slippage.vwap_cost`).
- **How to draw:**
  - One bar per rung, value printed above: green clears the line, red misses (pass and fail only, the one place these colours are right).
  - The line is ink, dotted, named in the legend with its number; the legend sits in the headroom (y to 1.35 times the tallest bar or line).
  - Table: a row per rung, at most nine columns, the last the rule tinted green or rose; gold marks the pick.
  - Room, margin and fill are three calls: `higher_is_better=True` for room, `False` for cash against equity and slippage against the assumed cost.
- **How to read it:** Pass: the pick is green on every call (room, margin, fill) and the rung above it is red on at least one. Fail: no rung is green, or the pick is green only on the close-marked number, not the wick.
- **Pairs with:** step 4 (sizing, last: room above the stop plus the worst joint wick) and step 5 (live fill near the assumed cost), `research.md#six-gates-size-last`
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from matplotlib.patches import Patch
from fundplat.quant.core import figstyle as fs


def draw_sizing_and_fill(rungs, value, threshold, higher_is_better, thr_label, ylabel, table, findings, question, window, pick=None):
    N, V = fs.NEUTRAL, fs.VERDICT
    value = np.asarray(value, float)
    ok = value >= threshold if higher_is_better else value <= threshold
    fig, gs, ax, axt = fs.fig_tab(7.4, (2.6, 1.7), top=0.80, hspace=0.42, nb=fs.nlines(findings))
    xs = np.arange(len(rungs))
    bars = ax.bar(xs, value, 0.55, color=[V["good"] if k else V["bad"] for k in ok], alpha=0.85)
    ax.bar_label(bars, labels=[f"{v:,.1f}" for v in value], fontsize=9, padding=3)
    ax.axhline(threshold, color=N["ink"], linestyle=":", linewidth=1.5, label=thr_label)
    ax.set_xticks(xs); ax.set_xticklabels(rungs); ax.set_ylabel(ylabel)
    ax.set_ylim(0, max(float(value.max()), threshold) * 1.35)
    key = [Patch(facecolor=V[c], alpha=0.85, label=t) for c, t in (("good", "clears the line"), ("bad", "misses it"))]
    ax.legend(handles=key + ax.get_legend_handles_labels()[0], loc="upper center", ncol=3, fontsize=8.5)
    ax.set_title(question, loc="left", fontsize=11.5, fontweight="bold", pad=24)
    ax.text(0, 1.012, window, transform=ax.transAxes, fontsize=8.5, color=N["muted"])
    tb = fs.put_table(axt, table[0], table[1], size=9.2)
    for i, k in enumerate(ok, 1):
        fs.tint(tb, i, len(table[1]) - 1, "green" if k else "rose")
    if pick is not None:
        fs.gold(tb, pick + 1, 0)
    fs.bullets(fig, findings)
    return fig
```

## Hedge and basis

Read when: a hedge's residual is the claim (basis, hedge ratio, swing, bridge) and the chart must show the ratio or the residual against what a plain static hedge leaves.

Category: The book

- **Question:** Which hedge ratio would have kept the residual smallest, at each horizon?
- **Inputs:** `x` horizons in hours; `ratio` the ratio that keeps the residual smallest at each x; `held` (lo, hi) the ratio the strategy held, or None; `others` {label: (array, colour)} comparison series on x; `table` (cells, cols), at most nine columns; `findings` sentences; `window` the subtitle with the hour count. Ratio, R-squared and swing come from `fundplat.quant`; the function only draws.
- **How to draw:**
  - Log x is the horizon, y the hedge ratio from zero. The study's ratio is an ink line with markers; comparison series (a ratio off raw prints, half the window) are solid lines in their quantity colour, never dashed.
  - The static hedge is an ink dotted threshold with its value in the label; the ratio held is a grey band in the legend, which sits in the empty band under the lines. A table row per horizon; gold marks the number the rule reads.
  - For a basis or spread level against its static value: pass the horizons as x, the residual as `ratio`, and `ref` as the level a plain hedge leaves.
- **How to read it:** Pass: the ratio is inside the held band and the swing at that ratio is below the static column, in both halves of the window. Fail: the ratio leaves the band at the horizons the rule reads, or the halves disagree (the hedge fits one window).
- **Pairs with:** step 3 (a rule against always-hold: adopted only if it improves both the gate metric and the drawdown), `research.md#six-gates-size-last`
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_hedge_and_basis(x, ratio, held, others, table, findings, question, window, ref=1.0, ref_label="the static hedge", gold_cell=(1, 1)):
    N = fs.NEUTRAL
    fig, gs, ax, axt = fs.fig_tab(7.4, (2.8, 1.25), top=0.80, hspace=0.5, nb=fs.nlines(findings))
    if held:
        ax.axhspan(*held, color=N["axis"], alpha=0.4, label="the ratio the strategy held")
    ax.plot(x, ratio, color=N["ink"], linewidth=2.4, marker="o", label="ratio that keeps the residual smallest")
    for lab, (y, col) in others.items():
        ax.plot(x, y, color=col, linewidth=1.8, marker="s", label=lab)
    ax.axhline(ref, color=N["ink"], linewidth=1.2, linestyle=":")
    ax.text(x[0], ref, f" {ref_label}, {ref:.2f}", color=N["ink2"], fontsize=8.5, va="bottom")
    ax.set_xscale("log"); ax.set_xticks(x); ax.set_xticklabels([f"{h}h" for h in x]); ax.minorticks_off()
    ax.set_ylim(0, max(ref, float(np.nanmax(ratio))) * 1.15); ax.set_xlabel("horizon of the move"); ax.set_ylabel("hedge units per unit hedged")
    ax.legend(loc="lower center", ncol=2, fontsize=8.3)
    ax.set_title(question, loc="left", fontsize=11.5, fontweight="bold", pad=24)
    ax.text(0, 1.012, window, transform=ax.transAxes, fontsize=8.5, color=N["muted"])
    tb = fs.put_table(axt, table[0], table[1], size=9.5); fs.gold(tb, *gold_cell)
    fs.bullets(fig, findings)
    return fig
```

## Regime and concentration

Read when: you must show how much of the net sits in which period, state, kind of market, or in the top few trades and days, before the verdict calls it broad.

Category: The run

- **Question:** How much of the net sits in a handful of them?
- **Inputs:** `values` (net USD per unit: trade, day, week, state or kind of market), `hurdle` (T-bill USD over the window), `top_k` (units set aside, e.g. 5), `notes`, `window`, `unit` (plural noun), `rank` (True best first; False keeps the given order, for a regime by week), `question` (re-word for the unit).
- **How to draw:**
  - One axes: each unit's net as a bar (green gain, red loss) and the running net as a solid ink line, best first (time order when `rank=False`); legend `loc='best'`.
  - The total net is an ink dotted horizontal, labelled; with `rank=True` the best `top_k` are shaded grey and labelled.
  - One table: best `top_k`, worst `top_k` and all units, with net, share of the net, net without the cut, above or below the T-bill; gold on the best share.
  - One figure per cut; a regime cut reads one window, so the bullets say how few trades sit in each bar.
- **How to read it:** Pass: the running line rises near straight, the net without the best `top_k` clears the T-bill, and no week or state holds most of it. Fail: the line peaks early and falls, the best few units earn more than the net, or removing them drops it below the hurdle.
- **Pairs with:** none in the six gates; it feeds the S5 diagnostics and the verdict on breadth. Usual pass line: the net without the best five trades against the T-bill.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_regime_and_concentration(values, hurdle, top_k, notes, window, unit="trades", rank=True, question="How much of the net sits in a handful of them?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    s = np.sort(np.asarray(values, float))
    v = s[::-1] if rank else np.asarray(values, float)
    tot, x, od = v.sum(), np.arange(1, len(v) + 1), ", best first" if rank else ", in order"
    fig, gs, ax, axt = fs.fig_tab(4.7, (2.3, 1.3), hspace=0.55, nb=fs.nlines(notes))
    ax.bar(x, v, color=[V["good"] if a > 0 else V["bad"] for a in v])
    ax.plot(x, np.cumsum(v), color=N["ink"], linewidth=2.4, label="running net" + od)
    ax.axhline(tot, color=N["ink"], linewidth=1.3, linestyle=":")
    ax.text(len(v), tot, f"net {tot:,.0f} ", ha="right", va="top")
    ax.axhline(0, color=N["axis"], linewidth=1)
    if rank:
        ax.axvspan(0.5, top_k + 0.5, color=N["axis"], alpha=0.3)
        ax.text(top_k + 0.8, ax.get_ylim()[1], f"best {top_k}", va="top")
    ax.set_xlabel(unit + od); ax.set_ylabel("USD")
    ax.legend(loc="best")
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    cuts = [(f"Best {top_k} {unit}", s[-top_k:].sum()), (f"Worst {top_k} {unit}", s[:top_k].sum()), (f"All {len(v)} {unit}", tot)]
    cells = [[n, f"{a:,.0f}", f"{a / tot:.0%}", f"{tot - a:,.0f}" if i < 2 else "", "above" if tot - a > hurdle else "below"] for i, (n, a) in enumerate(cuts)]
    cols = ["Cut", "Net USD", "Share of the net", "Net without it", f"Vs T-bill {hurdle:,.0f}"]
    fs.gold(fs.put_table(axt, cells, cols, size=9.5, first=0.28), 1, 2)
    fs.bullets(fig, notes)
    return fig
```

## Fund-book correlation

Read when: a study is about to be sized and the owner asks what it does to the books the fund already runs.

Category: The book

Waits on: the fund books' returns reader. It returns one daily P&L series and refuses with 0 days, so there is no `rets` matrix to feed.

- **Question:** Does the study add risk to the fund, or spread it?
- **Inputs:** `rets`, daily returns, a column per book with the study's; `w`, a Series of capital weights, the study at its stated size; `study`, its column; `ann`, periods a year; `corr_limit`, the tolerated correlation, set before the run [U]; `window`, `notes`. The fund books' returns reader is not built.
- **How to draw:**
  - Two panels of horizontal bars, one per book, values at the bar ends. Left: correlation with the study, green at or under the limit, red above.
  - Right: each book's marginal contribution to portfolio vol (covariance times weight, over portfolio vol), study first: green under the portfolio vol (adding it lowers risk), red over. Thresholds (the limit, the portfolio vol) are ink dotted lines.
  - Table: weight, correlation, marginal risk and share of risk per book; the study's share gold. Top right: PASS or FAIL.
- **How to read it:** Pass: no book above the limit and the study's marginal risk under the portfolio vol. Fail: a book above the limit, or more risk per unit than the fund carries. A short history makes each correlation a wide estimate: state the day count.
- **Pairs with:** none
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_fund_book_correlation(rets, w, study, ann, corr_limit, window, notes, question="Does the study add risk to the fund, or spread it?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    order = [study, *rets.columns.drop(study)]; books = order[1:]
    corr = rets[books].corrwith(rets[study]).values
    cov = rets[order].cov().values * ann; wv = w.reindex(order).values; sig = np.sqrt(wv @ cov @ wv)
    mcr, share = cov @ wv / sig, wv * (cov @ wv) / sig ** 2
    ok = (corr <= corr_limit).all() and mcr[0] < sig
    fig, gs, ax, axt = fs.fig_tab(6.6, (2.6, 1.3), top=0.84, nb=fs.nlines(notes)); ax.axis("off")
    sg = gs[0].subgridspec(1, 2, wspace=0.35); a1, a2 = fig.add_subplot(sg[0]), fig.add_subplot(sg[1])
    for a, v, names, thr, tl, xl, f in ((a1, corr, books, corr_limit, f"limit {corr_limit:.2f}", "correlation", "{:.2f}"),
                                        (a2, mcr, order, sig, f"portfolio vol {sig:.1%}", "marginal vol, annualised", "{:.1%}")):
        bars = a.barh(range(len(v)), v, color=[V["good"] if t <= thr else V["bad"] for t in v], height=0.6)
        a.bar_label(bars, labels=[f.format(t) for t in v], fontsize=8.5, padding=3)
        a.axvline(thr, color=N["ink"], linestyle=":", label=tl)
        a.set_yticks(range(len(v)), names); a.invert_yaxis(); a.set_xlabel(xl); a.margins(x=0.15)
        a.legend(loc="lower right", bbox_to_anchor=(1, 1))
    a1.set_xlim(-1, 1); a2.xaxis.set_major_formatter(lambda t, _: f"{t:.0%}")
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold"); fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fig.text(0.97, 0.925, "PASS" if ok else "FAIL", ha="right", color=V["good" if ok else "bad"], fontweight="bold")
    cells = [[n, f"{wv[k]:.0%}", f"{corr[k - 1]:+.2f}" if k else "", f"{mcr[k]:.1%}", f"{share[k]:.0%}"] for k, n in enumerate(order)]
    cols = ["Book", "Weight", "Correlation", "Marginal vol", "Risk share"]
    fs.gold(fs.put_table(axt, cells, cols, size=9.5), 1, 4); fs.bullets(fig, notes)
    return fig
```

## Scenario payoff

Read when: a position or a hedge has a payoff that depends on a listed set of outcomes (a meeting, a print, an expiry) and the owner must see each one before any verdict.

Category: The trade

- **Question:** What does each outcome do to us?
- **Inputs:** `labels` the listed outcomes in order; `parts` {leg name: payoff per outcome} (ordered dict of arrays); `net` the total per outcome; `table` (cells, cols) with outcome, chance, each leg and the net, at most nine columns; `findings`; `window`; `ylabel`. Payoffs and chances come from the platform scenario functions.
- **How to draw:**
  - One bar per outcome, legs stacked (gains up, losses down), each leg in its identity colour. Never green or red for a leg: the axis shows the sign.
  - The net is an ink line across each bar with its number beside it; zero is the axis line; the legend sits in the headroom.
  - The table lists outcome, chance, each leg and the net; gold marks the worst net. Chance is read from the table, not drawn.
  - A second hedge size or a two-meeting path is another call with a different `parts`, not a new type.
- **How to read it:** Pass: the net stays inside the loss the owner pre-registered in the worst listed outcome and the hedge flattens the book where the other leg pays. Fail: the worst net is below the limit, or a gap between the outcomes listed and those possible goes unsaid.
- **Pairs with:** none (the payoff is read before any verdict; the worst net feeds the stop in step 4)
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_scenario_payoff(labels, parts, net, table, findings, question, window, ylabel="USD at expiry", colours=None):
    N = fs.NEUTRAL
    colours = colours or (*list(fs.IDENTITY.values())[:2], N["muted"], N["ink2"])
    x, pos, neg, net = np.arange(len(labels)), np.zeros(len(labels)), np.zeros(len(labels)), np.asarray(net, float)
    fig, gs, ax, axt = fs.fig_tab(7.4, (2.6, 1.3), top=0.80, hspace=0.55, nb=fs.nlines(findings))
    for (name, v), col in zip(parts.items(), colours):
        v = np.asarray(v, float)
        ax.bar(x, v, 0.55, bottom=np.where(v >= 0, pos, neg), color=col, label=name)
        pos, neg = pos + np.where(v >= 0, v, 0), neg + np.where(v < 0, v, 0)
    ax.hlines(net, x - 0.36, x + 0.36, color=N["ink"], linewidth=3, label="net")
    for xi, v in zip(x, net):
        ax.annotate(f"{v:,.0f}", (xi, v), xytext=(0, 7 if v >= 0 else -7), textcoords="offset points", fontsize=8.5, fontweight="bold", va="bottom" if v >= 0 else "top", ha="center")
    lo, hi = min(neg.min(), net.min(), 0), max(pos.max(), net.max(), 0)
    ax.set_ylim(lo - 0.12 * (hi - lo), hi + 0.35 * (hi - lo))
    ax.axhline(0, color=N["axis"], linewidth=1); ax.set_xticks(x); ax.set_xticklabels(labels); ax.set_ylabel(ylabel)
    ax.legend(loc="upper left", ncol=len(parts) + 1, fontsize=8.5)
    ax.set_title(question, loc="left", fontsize=11.5, fontweight="bold", pad=24)
    ax.text(0, 1.012, window, transform=ax.transAxes, fontsize=8.5, color=N["muted"])
    tb = fs.put_table(axt, table[0], table[1], size=9.5)
    fs.gold(tb, int(net.argmin()) + 1, len(table[1]) - 1)
    fs.bullets(fig, findings)
    return fig
```

## Trade anatomy

Read when: a rule is described in words and the reader should see one trade from signal to exit, or every entry and exit marked on the series they trade and how much each made, before any statistic over many trades.

Category: The trade

- **Question:** What does one trade look like, from signal to exit?
- **Inputs:** `t` (bar times), `level` (the traded series, e.g. a premium or a price), `anchor` (what it reverts to), `signal` (the rule's input, e.g. z), `entry` and `exit` (bar indices of the signal and of the exit fill; a scalar is one trade, an array is every trade), `lines` (label to level on the signal axis: enter, exit, stop), `net` (USD, one per trade), `side` (+1 the entry buys the rising leg or Up, -1 the falling one or Down; a scalar or one per trade; default +1), `question` (re-word it for many trades: `Where does each trade enter and exit, and for how much?`), `ref` (a reference price and its label, optional: a binary market's strike), `notes`, `window`. The fill is the bar AFTER the signal (`entry + 1`) and the held span runs from that fill to `exit`; an exit before its fill is a data fault and raises.
- **How to draw:**
  - Two panels sharing x: the level and its anchor (ink and ink2, solid), then the signal in ink with the rule's levels as ink dotted labelled lines.
  - Each trade's held bars are shaded green if it made money and red if it lost, on both panels; on the level panel a thin line joins the entry price to the exit price in the same colour. A marker for the signal bar and one for the exit signal, each with a text label when there is one trade.
  - **The entry marker points the way the entry bets** (the owner's rule): an upright triangle for a buy of Up (or a long), an inverted one for a buy of Down (or a short); the exit is a filled square, never a triangle. The shape carries the side, so the reader needs no legend and no colour lookup; colour keys the instrument or the leg, never the side. This holds on every chart that marks entries (`MAE/MFE` drawn on a price path, a trade page in a study). A reference price is an ink dotted horizontal with a text label.
  - One trade: show the median trade by net, never the best one, and say which it is; the bullets split the net into price, fees, slippage and funding. Every trade (the old `Trade marks`, folded in): the bullets give the trade count, the mean hold in bars and minutes, the mean net and the largest winning and losing trades.
- **How to read it:** Pass: the picture matches the words (signal bar, next-open fill, the exit the rule names) and the net is what the rule's average trade makes; with many trades the green spans are not one cluster. Fail: a trade chosen for its looks, one where the fill is not the bar after the signal, or all the green in one afternoon.
- **Pairs with:** gate 1 (`research.md#six-gates-size-last`); `Exit-reason breakdown` for all the trades at once; `Equity curve` (the same trades as per-trade bars, no price).
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from fundplat.quant.core import figstyle as fs


def draw_trade_anatomy(t, level, anchor, signal, entry, exit, lines, net, notes, window, side=1, ref=None, question="What does one trade look like, from signal to exit?"):
    """entry, exit, net, side: one trade, or one value per trade. ref: (price, label) or None."""
    N, V = fs.NEUTRAL, fs.VERDICT
    t, level, signal = np.asarray(t), np.asarray(level, float), np.asarray(signal, float)
    entry, exit, net = (np.atleast_1d(np.asarray(a)) for a in (entry, exit, net))
    side = np.broadcast_to(np.atleast_1d(side), entry.shape)
    if (entry + 1 > exit).any():
        raise ValueError("an exit before its fill (the bar after the signal) is a data fault")
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(13, 5.6 + nb * 0.205), sharex=True, gridspec_kw=dict(height_ratios=(1.4, 1.0), hspace=0.12))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.84, bottom=fs.bullet_margin(fig, nb) + 0.08)
    a1.plot(t, level, color=N["ink"], linewidth=1.8, label="level"); a1.plot(t, np.asarray(anchor, float), color=N["ink2"], linewidth=1.6, label="anchor")
    a2.plot(t, signal, color=N["ink"], linewidth=1.8)
    for name, v in lines.items():
        a2.axhline(v, color=N["ink"], linewidth=1.1, linestyle=":"); a2.text(t[0], v, f" {name}", fontsize=8, va="bottom", color=N["ink"])
    a2.axhline(0, color=N["axis"], linewidth=1)
    for e, x, g in zip(entry, exit, net):
        c = V["good"] if g > 0 else V["bad"]
        for ax in (a1, a2):
            ax.axvspan(t[e + 1], t[x], color=c, alpha=0.12, linewidth=0)
        a1.plot([t[e + 1], t[x]], [level[e + 1], level[x]], color=c, linewidth=1.0, alpha=0.65)     # the fill price to the exit price
    for m, mk, lab in ((side > 0, "^", "entry, buy Up (long)"), (side <= 0, "v", "entry, buy Down (short)")):   # points the way the entry bets
        if m.any():
            a1.scatter(t[entry[m] + 1], level[entry[m] + 1], s=110, marker=mk, color=N["ink"], zorder=6, label=lab)
            a2.scatter(t[entry[m]], signal[entry[m]], s=90, marker=mk, color=N["ink"], zorder=5)
    a1.scatter(t[exit], level[exit], s=58, marker="s", color=N["ink"], zorder=6, label="exit")
    a2.scatter(t[exit - 1], signal[exit - 1], s=60, marker="s", color=N["ink"], zorder=5)
    if len(entry) == 1:
        a2.annotate("signal: order placed", (t[entry[0]], signal[entry[0]]), textcoords="offset points", xytext=(-8, 10), ha="right", fontsize=8.5)
        a2.annotate("exit signal", (t[exit[0] - 1], signal[exit[0] - 1]), textcoords="offset points", xytext=(8, -14), fontsize=8.5)
    if ref is not None:
        a1.axhline(ref[0], color=N["ink"], linewidth=1.0, linestyle=":"); a1.annotate(ref[1], (t[-1], ref[0]), xytext=(-4, 4), textcoords="offset points", ha="right", fontsize=8.5, color=N["ink"])
    h, _ = a1.get_legend_handles_labels()
    a1.legend(handles=h + [Patch(facecolor=V["good"], alpha=0.12, label="held while it won"), Patch(facecolor=V["bad"], alpha=0.12, label="held while it lost")], loc="best", fontsize=8.5, frameon=False)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## MAE/MFE

Read when: a trade's realised P&L is known and the question is how close it came to its best and worst before it closed, so the exit rule and the stop can be judged.

Category: The trade

- **Question:** `How far did each trade run for and against before it closed?`
- **Inputs:** `mae` (per trade, the worst the mark was against the position, USD, zero or negative), `mfe` (per trade, the best it was for the position, USD, zero or positive), `net` (the realised USD per trade, same order), `notes`, `window`. Excursions are read on the marked price path, not on the entry and exit alone.
- **How to draw:**
  - One axes: each trade a dot at its MAE across and its MFE up, green if it closed positive and red if it closed negative.
  - The diagonal MFE = -MAE (the peak equals the trough) is an ink dotted line; dots above it ran further for than against. Zero lines in the quiet axis colour, equal limits.
  - Findings: the mean MAE and MFE, the share of trades whose MFE exceeded the realised net (profit left on the table), and the share whose MAE reached the full loss before the exit.
- **How to read it:** Pass: winners sit well above the diagonal and losers near it. Fail: red dots above the diagonal (a winning trade was given back, so the exit leaks), or winners hugging the diagonal (the entry has no edge, only the exit timing does).
- **Pairs with:** `Trade anatomy` (one trade's path, and the entry-marker rule: a trade's excursions drawn on a price path mark the entry with a triangle that points the way it bets and the exit with a square); `Exit-reason breakdown` (which door leaks the peak); step 3 of `research.md#six-gates-size-last` (the target carries the net, not the luck of the exit).
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from fundplat.quant.core import figstyle as fs


def draw_mae_mfe(mae, mfe, net, notes, window, question="How far did each trade run for and against before it closed?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    mae, mfe, net = (np.asarray(a, float) for a in (mae, mfe, net))
    nb = fs.nlines(notes)
    fig, ax = plt.subplots(figsize=(13, 5.0 + nb * 0.205))
    fig.subplots_adjust(left=0.07, right=0.97, top=1 - 0.9 / fig.get_size_inches()[1], bottom=fs.bullet_margin(fig, nb) + 0.08)
    lim = max(float(np.abs(mae).max()), float(np.abs(mfe).max())) * 1.08
    ax.scatter(mae, mfe, s=26, color=[V["good"] if g > 0 else V["bad"] for g in net], alpha=0.7, linewidths=0, zorder=3)
    ax.plot([-lim, 0], [lim, 0], color=N["ink"], linewidth=1.2, linestyle=":")
    ax.text(-lim * 0.97, lim * 0.97, "peak = trough ", ha="right", va="top", fontsize=8.5, color=N["ink"])
    ax.axhline(0, color=N["axis"], linewidth=1); ax.axvline(0, color=N["axis"], linewidth=1)
    ax.set_xlim(-lim, lim); ax.set_ylim(-lim, lim)
    ax.set_xlabel("maximum adverse excursion, USD"); ax.set_ylabel("maximum favourable excursion, USD")
    ax.legend(handles=[Patch(facecolor=V["good"], alpha=0.7, label="closed green"), Patch(facecolor=V["bad"], alpha=0.7, label="closed red")], loc="best", fontsize=8.5, frameon=False)
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Profit and loss attribution

Read when: a result is a sum (funding, basis, fees, slippage; a rule's saving against holding) and the verdict depends on which part carries it.

Category: The run

- **Question:** Where does the P&L come from?
- **Inputs:** `parts` (component to USD, in the order shown), `compare` (the same keys under a second variant, optional), `labels` (the two variant names), `notes`, `window`.
- **How to draw:**
  - One axes: a horizontal bar per component, the last the net in ink. A component keeps its identity colour from `figstyle.QUANTITY` (funding, basis, fees); any other is ink2. Sign shows by direction, not by green or red.
  - A second variant is drawn as a thinner translucent bar of the same colour under each, keyed in the legend.
  - Values at the bar ends. Findings: the share of the net each part holds and the part that would flip the sign.
- **How to read it:** Pass: the part the thesis names (funding for a carry book) is the largest and positive on its own. Fail: the net is carried by a part the thesis does not name, or the parts cancel to a net near zero.
- **Pairs with:** gate 1 (`research.md#six-gates-size-last`): the gate metric is funding-only for a carry book.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from fundplat.quant.core import figstyle as fs


def draw_pnl_attribution(parts, notes, window, compare=None, labels=("as run", "second variant"), question="Where does the P&L come from?"):
    N, Q = fs.NEUTRAL, fs.QUANTITY
    keys = list(parts)
    nb = fs.nlines(notes)
    fig, ax = plt.subplots(figsize=(13, 3.0 + 0.45 * (len(keys) + 1) + nb * 0.205))
    fig.subplots_adjust(left=0.18, right=0.95, top=1 - 0.9 / fig.get_size_inches()[1], bottom=fs.bullet_margin(fig, nb) + 0.08)
    names = keys + ["Net"]
    y = np.arange(len(names))[::-1]
    for var, off, h, al in ((parts, 0.12 if compare else 0, 0.34 if compare else 0.6, 1.0), (compare, -0.2, 0.22, 0.55)):
        if var is None:
            continue
        v = [var[k] for k in keys] + [sum(var[k] for k in keys)]
        ax.barh(y + off, v, height=h, alpha=al, color=[Q.get(k.lower(), N["ink2"]) for k in keys] + [N["ink"]])
        for yi, x in zip(y + off, v):
            ax.text(x, yi, f" {x:,.0f}", va="center", ha="left" if x >= 0 else "right", fontsize=8.5, color=N["ink"])
    ax.axvline(0, color=N["axis"], linewidth=1)
    ax.set_yticks(y); ax.set_yticklabels(names); ax.set_xlabel("USD"); ax.grid(axis="y", visible=False)
    if compare:
        ax.legend(handles=[Patch(color=N["ink2"], label=labels[0]), Patch(color=N["ink2"], alpha=0.55, label=labels[1])], loc="best", frameon=False)
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Exit-reason breakdown

Read when: a rule can leave by more than one door (target, time stop, hard stop, signal flip) and the verdict depends on which door pays and which leaks.

Category: The trade

- **Question:** Which way out earns, and which way leaks?
- **Inputs:** `reasons` (the exit reason of each trade), `net` (USD per trade, same order), `notes`, `window`.
- **How to draw:**
  - Top: one bar per reason, its total net (green gain, red loss), with the count under the label; zero in the quiet axis colour.
  - Bottom, the one table: per reason the trades, share of trades, mean net, win rate and share of the net; gold on the largest share of the net.
  - **The taxonomy is closed, five doors:** `target` (the rule's own exit signal: a revert to the anchor, a profit target; the spread engine logs it as `revert`), `time` (the maximum hold), `stop` (the hard stop), `flip` (the opposite entry signal) and `end` (the window or the contract closed the trade, not the rule). A study logs `exit_reason` per trade from this list; any other label is a logging fault and the function raises. `end` trades are left out of the bars and the table and counted in a note: the data closed them.
  - A door with under 10 trades is left in the table and called thin in the bullets.
- **How to read it:** Pass: the door the rule is designed around (the target) carries the net and the stop costs less than it saves. Fail: the stop or the time stop earns the net while the target loses (the edge is the luck of the exit), or one door holds under 10 trades but all the profit.
- **Pairs with:** gate 3 (`research.md#six-gates-size-last`): a rule is adopted only if it improves the gate metric and the drawdown; `Trade anatomy` for one trade; `MAE/MFE` (which door leaks the peak: colour its dots by door once the taxonomy is logged).
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_exit_reason_breakdown(reasons, net, notes, window, question="Which way out earns, and which way leaks?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    EXITS = ("target", "time", "stop", "flip", "end")
    r, x = np.asarray(["target" if k == "revert" else k for k in reasons]), np.asarray(net, float)
    assert set(r) <= set(EXITS), f"exit reasons outside the taxonomy: {sorted(set(r) - set(EXITS))}"
    n_end, x, r = (r == "end").sum(), x[r != "end"], r[r != "end"]          # the data closed these, not the rule
    names = sorted(set(r), key=lambda k: -x[r == k].sum())
    tot = np.array([x[r == k].sum() for k in names])
    fig, gs, ax, axt = fs.fig_tab(5.2, (2.2, 1.3), hspace=0.6, nb=fs.nlines(notes))
    ax.bar(range(len(names)), tot, color=[V["good"] if v > 0 else V["bad"] for v in tot])
    ax.axhline(0, color=N["axis"], linewidth=1)
    ax.set_xticks(range(len(names))); ax.set_xticklabels([f"{k}\n{(r == k).sum()} trades" for k in names]); ax.set_ylabel("net, USD")
    if n_end:
        ax.text(1, 1.012, f"{n_end} trades closed by the window's end are left out", transform=ax.transAxes, ha="right", fontsize=8.5, color=N["muted"])
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    cells = [[k, f"{(r == k).sum()}", f"{(r == k).mean():.0%}", f"{x[r == k].mean():,.1f}", f"{(x[r == k] > 0).mean():.0%}", f"{x[r == k].sum() / x.sum():.0%}"] for k in names]
    fs.gold(fs.put_table(axt, cells, ["Exit", "Trades", "Share of trades", "Mean net USD", "Win rate", "Share of the net"], size=9.5, first=0.22), 1, 5)
    fs.bullets(fig, notes)
    return fig
```

## Payoff diagram

Read when: the book's P&L is a function of one move (the premium, the underlying, the rate) and you must show where it turns, where the stop sits and where the venue liquidates it.

Category: The trade

- **Question:** What does a move against us cost, and where do we stop or break?
- **Inputs:** `move` (increasing grid, in `xlabel` units: ONE unit per figure, the series' own, such as premium points, bp or a price percent), `pnl` (USD at each move, costs on), `stop` (the pre-registered stop, same units), `liq` (the move at which the venue liquidates), `notes`, `window`, `xlabel`.
- **How to draw:**
  - One axes: P&L against the move as one solid ink line, shaded green above zero and red below; zero in the quiet axis colour.
  - The stop and the liquidation are ink dotted verticals with text labels carrying the USD at each. Moves are measured at the wick, not the close.
  - One figure per leverage rung if the kink moves with leverage.
  - **The border with `Sizing and fill`:** this chart is the continuous P&L of ONE rung as the move grows (the shape, the kink at liquidation); `Sizing and fill` is one number per rung (the room at the wick) against the room required, to choose the rung. Which rung? `Sizing and fill`. How does this rung lose along the way? Here.
- **How to read it:** Pass: the P&L at the stop is inside the drawdown limit and the stop sits well left of the liquidation. Fail: the liquidation is at or inside the stop plus the worst joint wick.
- **Pairs with:** gate 4 (`research.md#six-gates-size-last`); `Sizing and fill` for the same room at each rung (the border is in How to draw); `Scenario payoff` for discrete outcomes.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
from fundplat.quant.core import figstyle as fs


def draw_payoff_diagram(move, pnl, stop, liq, notes, window, xlabel="move against us, premium points", question="What does a move against us cost, and where do we stop or break?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    m, p = np.asarray(move, float), np.asarray(pnl, float)
    nb = fs.nlines(notes)
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(13, 4.8 + nb * 0.205))
    fig.subplots_adjust(left=0.07, right=0.97, top=1 - 0.9 / fig.get_size_inches()[1], bottom=fs.bullet_margin(fig, nb) + 0.08)
    ax.plot(m, p, color=N["ink"], linewidth=2.4)
    ax.fill_between(m, p, 0, where=p >= 0, color=V["good"], alpha=0.18, linewidth=0)
    ax.fill_between(m, p, 0, where=p < 0, color=V["bad"], alpha=0.18, linewidth=0)
    ax.axhline(0, color=N["axis"], linewidth=1)
    for name, v in (("stop", stop), ("liquidation", liq)):
        ax.axvline(v, color=N["ink"], linewidth=1.3, linestyle=":")
        ax.text(v, ax.get_ylim()[1], f" {name}: {np.interp(v, m, p):,.0f} USD", va="top", ha="left", fontsize=8.5, color=N["ink"])
    ax.set_xlabel(xlabel); ax.set_ylabel("P&L, USD")
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Live candidates

Read when: a study ends in a rule and the owner should see what it would do today, from a live read, beside the history the rule was built on.

Category: The trade

- **Question:** Which ones would the rule take right now?
- **Inputs:** `rows` (one row per candidate, at most eight, best first), `cols` (at most nine), `read_at` (the time of the live read, tagged [API]), `notes`, `window`.
- **How to draw:**
  - One table and nothing else: the candidate, the numbers the rule reads (price, spread, volume, days left) and the one the rule ranks by; the first column bold and left, gold on the ranking column.
  - The subtitle names the live read and the history window apart: the table is a snapshot, not a result.
  - Findings: how many candidates passed the rule's filters, the live cost beside the cost the study assumed, and the clip.
- **How to read it:** Pass: the live cost is at or under the assumed cost and the count is enough to trade the clip. Fail: the live spread is over the assumed cost or fewer candidates exist than the clip needs (gate 5: FLAG).
- **Pairs with:** gate 5 (`research.md#six-gates-size-last`): the live book fills the clip near the assumed cost. A candidate's side is a column of words (Up, Down), the same two things the entry marker's shape says on `Trade anatomy`.
- **Exemplar:** none yet
- **Code:**

```python
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_live_candidates(rows, cols, read_at, notes, window, question="Which ones would the rule take right now?"):
    N = fs.NEUTRAL
    nb = fs.nlines(notes)
    fig, ax = plt.subplots(figsize=(13, 2.4 + 0.36 * len(rows) + nb * 0.205))
    fig.subplots_adjust(left=0.07, right=0.97, top=1 - 0.9 / fig.get_size_inches()[1], bottom=fs.bullet_margin(fig, nb) + 0.03)
    ax.axis("off")
    tb = fs.put_table(ax, rows, cols, size=9.5, first=0.34)
    fs.gold(tb, 1, len(cols) - 1)
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, f"live read {read_at} [API] · history for the rule: {window}", transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Trading calendar

Read when: a book's legs trade in different markets (a stock leg that is shut when its perp is open) and the reader must see which days one side could not be adjusted and what the book did on them.

Category: The data

- **Question:** Which days could only one market trade?
- **Inputs:** `days` (day numbers), `open_by_market` (market to booleans per day), `t` and `series` (the traded spread or P&L over the same days), `colors` (market to a colour from `figstyle.IDENTITY`, else ink2), `notes`, `window`.
- **How to draw:**
  - Top: one row per market, a cell per day in the market's identity colour when open and the grid colour when shut.
  - Bottom: the series as one solid ink line; every day with exactly one market shut shaded red and keyed in the legend.
  - Findings: how many weekdays had one side shut, and the largest move in the series inside such a day.
- **How to read it:** Pass: the series' large moves do not cluster on one-side-shut days, or the book carries no position across them. Fail: the loss sits in the shut days, so the hedge could not be adjusted when it was needed.
- **Pairs with:** `Clock and staleness`; `Exposure over time`; gate 5 in `research.md#six-gates-size-last`.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from fundplat.quant.core import figstyle as fs


def draw_trading_calendar(days, open_by_market, t, series, notes, window, colors=None, question="Which days could only one market trade?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    days = np.asarray(days, float)
    names = list(open_by_market)
    cols = colors or dict(zip(names, (*list(fs.IDENTITY.values())[:2], N["ink2"])))
    O = np.array([np.asarray(open_by_market[k], bool) for k in names])
    one = O.sum(axis=0) == 1
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(13, 5.6 + nb * 0.205), sharex=True, gridspec_kw=dict(height_ratios=(1, 2.2), hspace=0.1))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.84, bottom=fs.bullet_margin(fig, nb) + 0.08)
    for i, k in enumerate(names):
        a1.bar(days, 0.8, bottom=i, width=0.9, color=[cols.get(k, N["ink2"]) if o else N["grid"] for o in O[i]])
    a1.set_yticks([i + 0.4 for i in range(len(names))]); a1.set_yticklabels(names); a1.set_ylim(-0.1, len(names))
    a2.plot(t, series, color=N["ink"], linewidth=1.6)
    for d in days[one]:
        a2.axvspan(d - 0.5, d + 0.5, color=V["bad"], alpha=0.15, linewidth=0)
    a2.legend(handles=[Patch(color=V["bad"], alpha=0.15, label=f"one market shut ({int(one.sum())} days)")], loc="best", frameon=False)
    a2.set_ylabel("spread, points"); a2.set_xlabel("day")
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Cash and headroom by account

Read when: a book's money sits in more than one account or currency (a pool at one venue, a broker account in another currency) and a gain in one cannot meet a call in the other until someone converts and wires it.

Category: The book

- **Question:** Where is the money, and in which account?
- **Inputs:** `t`, `accounts` (account to cumulative USD-equivalent P&L, each in its own currency), `headroom` (the binding account's equity over maintenance, USD), `floor` (the buffer the desk keeps, USD), `notes`, `window`.
- **How to draw:**
  - Top: one solid line per account (ink, ink2, muted in turn), zero in the quiet axis colour; the currency in each label.
  - Bottom: headroom as one solid ink line, the floor an ink dotted horizontal with a text label.
  - Findings: which account runs out first and by how much a gain elsewhere could cover it, given the wire time.
- **How to read it:** Pass: headroom stays above the floor on every hour and no account depends on another's gain within the wire time. Fail: one account's losses are matched by gains the other cannot send in time.
- **Pairs with:** gate 4 in `research.md#six-gates-size-last`; `Sizing and fill` for the same question per leverage rung.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_cash_by_account(t, accounts, headroom, floor, notes, window, question="Where is the money, and in which account?"):
    N = fs.NEUTRAL
    cols = (N["ink"], N["ink2"], N["muted"])
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(13, 5.6 + nb * 0.205), sharex=True, gridspec_kw=dict(height_ratios=(1.6, 1), hspace=0.12))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.84, bottom=fs.bullet_margin(fig, nb) + 0.08)
    for (lab, v), c in zip(accounts.items(), cols):
        a1.plot(t, v, color=c, linewidth=1.8, label=lab)
    a1.axhline(0, color=N["axis"], linewidth=1); a1.legend(loc="best", ncol=len(accounts), fontsize=8.5, frameon=False); a1.set_ylabel("cumulative, USD")
    a2.plot(t, headroom, color=N["ink"], linewidth=1.8)
    a2.axhline(floor, color=N["ink"], linewidth=1.3, linestyle=":")
    a2.text(t[0], floor, f" floor {floor:,.0f}", va="bottom", fontsize=8.5, color=N["ink"])
    a2.set_ylabel("headroom over maintenance, USD")
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Quality by category

Read when: a rule trades many instruments from a venue and the cost it assumes (a half-spread, a depth) must be checked against what each kind of instrument really quotes.

Category: Size and cost

- **Question:** Which kinds of market quote tightly enough to trade?
- **Inputs:** `cats` (category label to count), `spread` (category to median quoted spread, price units), `depth` (category to median depth near the mid, USD), `assumed` (the spread the study assumed), `notes`, `window`.
- **How to draw:**
  - Two horizontal-bar panels side by side, categories in the same order (widest spread first): the spread on the left with the assumed spread as an ink dotted vertical and its label; the depth on the right.
  - Bars in neutral grey (ink2): a spread is not a verdict. Each label carries the category's count.
  - Findings: which categories sit beyond the assumed spread and what share of the sample they hold.
- **How to read it:** Pass: the categories the rule trades quote at or inside the assumed spread, with depth over the clip. Fail: the sample is mostly categories quoting wider than assumed, so the cost sweep (`Cost sensitivity`) is the verdict.
- **Pairs with:** gate 5 in `research.md#six-gates-size-last`; `Sample funnel and coverage`.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_quality_by_category(cats, spread, depth, assumed, notes, window, question="Which kinds of market quote tightly enough to trade?"):
    N = fs.NEUTRAL
    names = sorted(cats, key=lambda k: -spread[k])
    y = np.arange(len(names))[::-1]
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 2.6 + 0.4 * len(names) + nb * 0.205), sharey=True)
    fig.subplots_adjust(left=0.2, right=0.97, top=1 - 1.0 / fig.get_size_inches()[1], bottom=fs.bullet_margin(fig, nb) + 0.1, wspace=0.08)
    a1.barh(y, [spread[k] for k in names], color=N["ink2"], height=0.6)
    a1.axvline(assumed, color=N["ink"], linewidth=1.3, linestyle=":")
    a1.text(assumed, len(names) - 0.4, f" assumed {assumed:g}", fontsize=8.5, color=N["ink"], va="bottom")
    a1.set_yticks(y); a1.set_yticklabels([f"{k} ({cats[k]:,})" for k in names], fontsize=8.5); a1.set_xlabel("median quoted spread")
    a2.barh(y, [depth[k] for k in names], color=N["ink2"], height=0.6); a2.set_xlabel("median depth near the mid, USD")
    for a in (a1, a2):
        a.grid(axis="y", visible=False)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 1 - 0.6 / fig.get_size_inches()[1], window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Cross-venue gap

Read when: the same thing is priced on two venues (an outcome on two prediction markets, a perp on two exchanges) and the question is how wide the gap is, what is left after fees and whether the widest ones persist.

Category: Size and cost

- **Question:** How wide is the gap between the venues, and what is left after fees?
- **Inputs:** `gap` (mid gap per matched pair, points), `net` (the same after both venues' fees and the quote), `widest` (label to hourly gap series for the widest pairs, at most three), `t` (their times), `notes`, `window`.
- **How to draw:**
  - Left: two histograms on one axes, the gross gap in muted grey and the net in ink2, zero an ink vertical; the legend gives the count above zero for each.
  - Right: the widest pairs' hourly gaps as solid lines (ink, ink2, muted), zero in the quiet axis colour.
  - Pairs are matched by identity first (`Matches` and their score are in the bullets); an unmatched pair is not a gap.
- **How to read it:** Pass: a clear share of pairs stays above zero net of fees and the widest ones last more than a few hours. Fail: the gap vanishes after fees and the quote, or the widest gaps are one stale print.
- **Pairs with:** `Gap persistence`; `Quality by category`; a cross-venue gap is not an edge until it clears quote, identity, hurdle and access.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_cross_venue_gap(gap, net, t, widest, notes, window, question="How wide is the gap between the venues, and what is left after fees?"):
    N = fs.NEUTRAL
    g, n = np.asarray(gap, float), np.asarray(net, float)
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 4.8 + nb * 0.205), gridspec_kw=dict(width_ratios=(1, 1.3)))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.82, bottom=fs.bullet_margin(fig, nb) + 0.1, wspace=0.18)
    bins = np.linspace(min(g.min(), n.min()), max(g.max(), n.max()), 30)
    a1.hist(g, bins=bins, color=N["muted"], alpha=0.7, label=f"gross: {int((g > 0).sum())} of {len(g)} above zero")
    a1.hist(n, bins=bins, color=N["ink2"], alpha=0.7, label=f"after fees: {int((n > 0).sum())} of {len(n)} above zero")
    a1.axvline(0, color=N["ink"], linewidth=1.3); a1.legend(loc="best", fontsize=8.5, frameon=False)
    a1.set_xlabel("mid gap, points"); a1.set_ylabel("pairs")
    for (lab, s), c in zip(widest.items(), (N["ink"], N["ink2"], N["muted"])):
        a2.plot(t, s, color=c, linewidth=1.6, label=lab)
    a2.axhline(0, color=N["axis"], linewidth=1); a2.legend(loc="best", fontsize=8.5, frameon=False); a2.set_ylabel("hourly gap, points")
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Attribution over time

Read when: a P&L is a sum of parts (funding, basis, fees, an edge and its friction) and the reader must see which part carried each stretch, not only which carried the total.

Category: The run

- **Question:** `Which part of the P&L carried each stretch of the window?`
- **Inputs:** `t` (one date per period), `parts` (component to USD per period, same length; `funding`, `basis` and `fees` keep their colours), `worst` (periods set aside, default 5), `notes`, `window`.
- **How to draw:**
  - Left: each part's cumulative P&L as a solid line in its identity colour, the total in ink and heavier, zero in the axis colour.
  - Right: per part, the correlation of its period P&L with the period total (a dot with a 95% interval from resampling periods) and, beside it, the share of the worst `worst` periods that part holds.
  - Findings: each part's total, the part that moves the total and the part that holds the worst periods.
- **How to read it:** Pass: the part the thesis names rises and the worst periods are not one part's. Fail: the named part is flat and another moves the total, or one part holds the worst periods (the book is that part's risk).
- **Pairs with:** `Profit and loss attribution` (the same parts as one bridge); `Equity curve`; `Regime and concentration`.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_attribution_over_time(t, parts, notes, window, worst=5, question="Which part of the P&L carried each stretch of the window?"):
    N, Q = fs.NEUTRAL, fs.QUANTITY
    key = {"funding": Q["funding"], "basis": Q["basis"], "fees": Q["fees"]}
    cols = {k: key.get(k, [N["ink2"], N["muted"]][i % 2]) for i, k in enumerate(parts)}
    P = {k: np.asarray(v, float) for k, v in parts.items()}
    tot = sum(P.values())
    bad = np.argsort(tot)[:worst]
    g = np.random.default_rng(11)
    ix = g.integers(0, len(tot), (1000, len(tot)))
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 5.0 + nb * 0.205), gridspec_kw=dict(width_ratios=(1.8, 1)))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.82, bottom=fs.bullet_margin(fig, nb) + 0.10, wspace=0.26)
    for k, v in P.items():
        a1.plot(t, np.cumsum(v), color=cols[k], linewidth=1.8, label=f"{k} {v.sum():+,.0f}")
    a1.plot(t, np.cumsum(tot), color=N["ink"], linewidth=2.6, label=f"total {tot.sum():+,.0f}")
    a1.axhline(0, color=N["axis"], linewidth=1)
    a1.xaxis.set_major_formatter(mdates.ConciseDateFormatter(a1.xaxis.get_major_locator()))
    a1.set_ylabel("cumulative P&L, USD"); a1.set_title("the path, by part", loc="left", fontsize=10); a1.legend(loc="best", fontsize=8.5)
    for j, (k, v) in enumerate(P.items()):
        rho = float(np.corrcoef(v, tot)[0, 1])
        d = np.array([np.corrcoef(v[i], tot[i])[0, 1] for i in ix])
        a2.errorbar([rho], [j], xerr=[[rho - np.nanpercentile(d, 2.5)], [np.nanpercentile(d, 97.5) - rho]], fmt="o", color=cols[k], ecolor=N["ink2"], capsize=3, ms=7)
        share = v[bad].sum() / tot[bad].sum() if tot[bad].sum() else np.nan
        a2.annotate(f"{share:+.0%} of the worst {worst}", (1.0, j), xycoords=("axes fraction", "data"), xytext=(6, 0), textcoords="offset points", va="center", fontsize=8, annotation_clip=False)
    a2.axvline(0, color=N["axis"], linewidth=1)
    a2.set_yticks(range(len(P))); a2.set_yticklabels(list(P), fontsize=8.5); a2.set_ylim(len(P) - 0.5, -0.5); a2.set_xlim(-1.1, 1.1)
    a2.set_xlabel("correlation with the period total, 95% over resamples"); a2.set_title("which part drives a period", loc="left", fontsize=10)
    fig.subplots_adjust(right=0.86)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Rebalance path

Read when: a rule re-strikes a hedge or a weight inside a band and the reader must see how often it acted, where the book sat against what it was asked for, and what acting cost.

Category: The book

- **Question:** `How often did the rule rebalance, and what did it cost?`
- **Inputs:** `t` (dates), `target` (the ratio the rule asks for), `held` (the ratio the book carried), `events` (indices of the rebalances), `cost` (USD per event), `band` (half-width, optional), `limit` (the cost the desk allows, USD, set before the run [U], optional), `ylabel`, `notes`, `window`.
- **How to draw:**
  - Top: the target as a muted solid line, the band shaded in the axis colour, the held ratio an ink step, a dot at each rebalance.
  - Bottom: each event's cost as a stem, the running cost an ink step, the limit an ink dotted horizontal; the legend gives the share of the cost in the three largest events.
  - Findings: the count, the total cost against the carry it protects, and the largest event.
- **How to read it:** Pass: the held ratio stays in the band, rebalances are few and the running cost stays under the limit and under the carry. Fail: the cost passes the limit, or one event is most of it (a stale mark, not a rule).
- **Pairs with:** `Hedge and basis` (the ratio against horizons); `Exposure over time` (what was naked between rebalances); `Cost sensitivity`.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_rebalance_path(t, target, held, events, cost, notes, window, band=None, limit=None, ylabel="hedge ratio", question="How often did the rule rebalance, and what did it cost?"):
    N = fs.NEUTRAL
    t, target, held = np.asarray(t), np.asarray(target, float), np.asarray(held, float)
    events, cost = np.asarray(events, int), np.asarray(cost, float)
    top3 = float(np.sort(cost)[::-1][:3].sum() / cost.sum()) if len(cost) and cost.sum() else float("nan")
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(13, 6.2 + nb * 0.205), sharex=True, gridspec_kw=dict(height_ratios=(2.2, 1), hspace=0.32))
    fig.subplots_adjust(left=0.07, right=0.97, top=0.85, bottom=fs.bullet_margin(fig, nb) + 0.08)
    if band is not None:
        a1.fill_between(t, target - band, target + band, color=N["axis"], alpha=0.45, linewidth=0, label=f"the band, plus or minus {band:g}")
    a1.plot(t, target, color=N["muted"], linewidth=1.5, label="the ratio the rule asks for")
    a1.step(t, held, where="post", color=N["ink"], linewidth=2.2, label="the ratio held")
    a1.scatter(t[events], held[events], s=40, color=N["ink"], zorder=5, label=f"a rebalance: {len(events)}")
    a1.set_ylabel(ylabel); a1.set_title("the ratio and its band", loc="left", fontsize=10); a1.legend(loc="best", fontsize=8.5)
    run = np.zeros(len(t))
    for i, c in zip(events, cost):
        run[i:] += c
    a2.vlines(t[events], 0, cost, color=N["ink2"], linewidth=2.0, label=f"cost of one rebalance; the largest three hold {top3:.0%}")
    a2.step(t, run, where="post", color=N["ink"], linewidth=2.0, label=f"cumulative cost {run[-1]:,.0f}")
    if limit is not None:
        a2.axhline(limit, color=N["ink"], linewidth=1.1, linestyle=":")
        a2.annotate("cost limit", (a2.get_xlim()[1], limit), xytext=(-4, 4), textcoords="offset points", ha="right", fontsize=8.5)
    a2.xaxis.set_major_formatter(mdates.ConciseDateFormatter(a2.xaxis.get_major_locator()))
    a2.set_ylabel("USD"); a2.set_title("what acting cost", loc="left", fontsize=10); a2.legend(loc="best", fontsize=8.5)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.935, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Adverse selection

Read when: an order rests and fills only when the market comes to it (a maker quote, a limit at a level), and the question is whether the orders that fill are the worse draws.

Category: The trade

- **Question:** `Do the orders that fill do worse than the ones that do not?`
- **Inputs:** `rows` (one per measure: label, mean of the fills, mean of the misses, their difference, lo, hi, all in one unit), `waits` (seconds from landing to the first fill, per fill), `life` (the order's life, seconds), `unit`, `notes`, `window`.
- **How to draw:**
  - Left: the fill minus the miss per measure, a dot (green above zero, red below) with its 95% interval from resampled slots or days, zero an ink dotted vertical, both means in the label.
  - Right: the wait to the first fill as a histogram, its median an ink dotted vertical.
  - Findings: each difference with its interval, the fill rate and the median wait.
- **How to read it:** Pass: the interval sits on or above zero, so the fills are no worse than the misses. Fail: it sits below zero: the market moves against an order just after it fills, and a backtest that counts every posted order as a fill at its price overstates the edge.
- **Pairs with:** `Sizing and fill` (the book's fill cost); `Sample size and power`; `Significance test`.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_adverse_selection(rows, waits, notes, window, life=30.0, unit="points of a share", question="Do the orders that fill do worse than the ones that do not?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    w = np.asarray(waits, float)
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 4.6 + nb * 0.205), gridspec_kw=dict(width_ratios=(1.7, 1)))
    fig.subplots_adjust(left=0.20, right=0.97, top=0.82, bottom=fs.bullet_margin(fig, nb) + 0.10, wspace=0.34)
    for i, (lab, fill, miss, d, lo, hi) in enumerate(rows):
        a1.errorbar([d], [i], xerr=[[d - lo], [hi - d]], fmt="o", color=V["good"] if d > 0 else V["bad"], ecolor=N["ink2"], capsize=3, ms=7, zorder=4)
        a1.annotate(f"{d:+.2f}  (fills {fill:+.2f}, misses {miss:+.2f})", (hi, i), xytext=(6, 0), textcoords="offset points", fontsize=8, va="center")
    a1.axvline(0, color=N["ink"], linewidth=1.2, linestyle=":")
    a1.set_yticks(range(len(rows))); a1.set_yticklabels([r[0] for r in rows], fontsize=8.5)
    lo_, hi_ = min(r[4] for r in rows), max(r[5] for r in rows)
    a1.set_xlim(lo_ - 0.15 * (hi_ - lo_), hi_ + 1.1 * (hi_ - lo_)); a1.set_ylim(len(rows) - 0.5, -0.5)
    a1.set_xlabel(f"fill minus miss, 95% interval ({unit})"); a1.set_title("what filling costs", loc="left", fontsize=10)
    a2.hist(np.clip(w, 0, life), bins=30, color=N["muted"], alpha=0.85, zorder=3)
    a2.axvline(float(np.median(w)), color=N["ink"], linewidth=1.2, linestyle=":")
    a2.annotate(f"median {np.median(w):.1f} s", (np.median(w), a2.get_ylim()[1]), xytext=(4, -4), textcoords="offset points", va="top", fontsize=8.5)
    a2.set_xlabel(f"seconds from landing to the first fill ({life:g} s life)"); a2.set_ylabel("fills"); a2.set_title("when the fills come", loc="left", fontsize=10)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```

## Edge by slice

Read when: an edge is claimed over the whole sample and the question is whether it holds in each cut (instrument, hour, side, price band, week) or one cut carries it.

Category: The run

- **Question:** `Does the edge hold in every slice, or does one carry it?`
- **Inputs:** `slices` (one tuple per slice: dimension, level, net, lo, hi, n, and optionally the same level over every day read), `overall` (the net of all entries, optional), `unit`, `notes`, `window`.
- **How to draw:**
  - Left: one row per slice, grouped by dimension with a grey rule between groups; a dot (green above zero, red below) with its 95% interval (clustered by slot, event or day, never by trade), an ink tick for the all-days level, the overall net an ink dotted vertical.
  - Right: the count behind each row as bars on the same rows.
  - Findings: how many slices were cut (a slice found after looking is a hypothesis), the slice furthest from the overall net and the thinnest count.
- **How to read it:** Pass: most intervals sit on the same side of zero and no slice is far from the overall net. Fail: one slice is the whole edge while the rest cross zero, or the counts are too small for the interval to mean anything.
- **Pairs with:** `Regime and concentration` (how much of the net sits in a handful); `Selection check` (slices found on fit days still earning on held-out days); `Sample size and power`.
- **Exemplar:** none yet
- **Code:**

```python
import numpy as np
import matplotlib.pyplot as plt
from fundplat.quant.core import figstyle as fs


def draw_edge_by_slice(slices, notes, window, overall=None, unit="net USD per entry", question="Does the edge hold in every slice, or does one carry it?"):
    N, V = fs.NEUTRAL, fs.VERDICT
    n = len(slices)
    nb = fs.nlines(notes)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 2.6 + 0.3 * n + nb * 0.205), sharey=True, gridspec_kw=dict(width_ratios=(3, 1)))
    fig.subplots_adjust(left=0.22, right=0.97, top=0.85, bottom=fs.bullet_margin(fig, nb) + 0.10, wspace=0.08)
    y = np.arange(n)
    for i, s in enumerate(slices):
        dim, lev, v, lo, hi, cnt = s[:6]
        a1.errorbar([v], [i], xerr=[[v - lo], [hi - v]], fmt="o", color=V["good"] if v > 0 else V["bad"], ecolor=N["ink2"], capsize=2.5, ms=6, zorder=4)
        if len(s) > 6:
            a1.scatter([s[6]], [i], marker="|", s=110, color=N["ink"], zorder=5)
        if i and dim != slices[i - 1][0]:
            a1.axhline(i - 0.5, color=N["grid"], linewidth=1.0)
    a2.barh(y, [s[5] for s in slices], color=N["muted"], height=0.6, zorder=3)
    a1.axvline(0, color=N["axis"], linewidth=1)
    if overall is not None:
        a1.axvline(overall, color=N["ink"], linewidth=1.1, linestyle=":")
        a1.annotate("all entries", (overall, -0.7), xytext=(4, 0), textcoords="offset points", fontsize=8.5)
    a1.set_yticks(y); a1.set_yticklabels([f"{s[0]}: {s[1]}" for s in slices], fontsize=8.5); a1.invert_yaxis()
    a1.set_xlabel(f"{unit}, dot with 95% interval" + ("; tick = the same level over every day read" if any(len(s) > 6 for s in slices) else ""))
    a1.set_title("the edge in each slice", loc="left", fontsize=10)
    a2.set_xlabel("entries"); a2.set_title("the count behind it", loc="left", fontsize=10)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.935, window, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig
```
