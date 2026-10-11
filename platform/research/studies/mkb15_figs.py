"""Figures of the maker-side burst study (B-0680). Matplotlib and `fundplat.quant.core.figstyle` only, on the frames of `lift_figs`; each function takes tables the study returned and draws one
figure under the figure rules (a question for a title, the window and hours under it, findings below, one meaning per colour, solid series, thresholds ink and dotted).

    funnel_fig         where bursts go before they become fills, and the fill rate by day against its band (kind sample-funnel-and-coverage)
    luck_fig           the rule's net per fill against 200 coin-side draws, and by half (kind significance-test)
    concentration_fig  net per fill by the price paid, and the cumulative net of the fills ranked best first (kind regime-and-concentration)
    adverse_fig        what a fill earned against what a miss would have, and the wait for a fill (kind signal-decay)
    grid_fig           the sensitivity cells, net per fill with its interval and the fills behind it (kind rule-comparison)
    queue_fig          fills and net per fill as the queue ahead grows (kind sizing-and-fill)
    power_fig          the smallest effect n fills can show, and the days a forward read needs (kind sample-size-and-power)
"""
from __future__ import annotations

import matplotlib.pyplot as plt
import numpy as np

from fundplat.quant.core import figstyle as fs

N, Q = fs.NEUTRAL, fs.QUANTITY
GOOD, BAD = fs.VERDICT["good"], fs.VERDICT["bad"]
PM = fs.IDENTITY["POLYMARKET"]
FILLS, MISSES = Q["basis_dark"], Q["fees"]


def _frame(h, notes, q, sub, ncols=2, wspace=0.28, ratios=None, left=0.07):
    """`lift_figs.frame` with column widths: the same canvas (question over the window line, findings under the panels)."""
    H = h + fs.nlines(notes) * 0.205 + 0.45 + 0.6 + 0.45
    fig = plt.figure(figsize=(13, H))
    bm = fs.bullet_margin(fig, fs.nlines(notes)) + 0.02 + 0.6 / H
    gs = fig.add_gridspec(1, ncols, left=left, right=0.97, top=1 - 1.35 / H, bottom=bm, wspace=wspace, **({"width_ratios": ratios} if ratios else {}))
    axes = [fig.add_subplot(gs[0, j]) for j in range(ncols)]
    fig.suptitle(q, x=0.07, y=1 - 0.18 / H, ha="left", va="top", fontsize=11.5, fontweight="bold", color=N["ink"])
    fig.text(0.07, 1 - 0.58 / H, sub, ha="left", va="top", fontsize=8.5, color=N["muted"])
    fs.bullets(fig, notes, bottom_in=0.12)
    return fig, axes


def _sign(v):
    return GOOD if v >= 0 else BAD


def _wilson(k, n, z=1.96):
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return c - h, c + h


def funnel_fig(stages, day_labels, day_fills, day_bursts, band, window, notes, question="Where do the bursts go before they become fills, and does the fill rate hold from day to day?"):
    """stages: [(label, count)] windows with a burst, with an order posted, with a fill. Left: the counts. Right: the fill rate by day with its Wilson interval, the pooled rate and the band the forward gate holds."""
    fig, (ax, ax2) = _frame(4.0, notes, question, window, ncols=2, wspace=0.42, ratios=[1, 1.5], left=0.17)
    y = np.arange(len(stages))
    top = stages[0][1]
    ax.barh(y, [c for _l, c in stages], color=[Q["fees"], Q["fees"], Q["basis_dark"]][:len(stages)], height=0.55, zorder=3)
    for i, (_l, c) in enumerate(stages):
        ax.annotate(f"{c:,}  ({c / top * 100:.1f}% of bursts)", (c, i), xytext=(5, 0), textcoords="offset points", va="center", fontsize=8.5)
    ax.set_yticks(y)
    ax.set_yticklabels([l for l, _c in stages], fontsize=8.5)
    ax.invert_yaxis()
    ax.set_xlim(0, top * 1.55)
    ax.set_xlabel("windows (BTC and ETH, 15 minutes each)")
    day_fills, day_bursts = np.asarray(day_fills, float), np.asarray(day_bursts, float)
    ok = day_bursts > 0
    x = np.arange(len(day_labels))
    rate = np.where(ok, day_fills / np.maximum(day_bursts, 1), np.nan)
    ci = np.array([_wilson(f, b) if b > 0 else (np.nan, np.nan) for f, b in zip(day_fills, day_bursts)])
    ax2.errorbar(x, rate * 100, yerr=[(rate - ci[:, 0]) * 100, (ci[:, 1] - rate) * 100], fmt="o", color=PM, ecolor=N["ink2"], elinewidth=1.0, capsize=2.5, ms=5, zorder=4, label="a day's fill rate, 95% Wilson")
    pooled = day_fills.sum() / day_bursts.sum() * 100
    ax2.axhline(pooled, color=N["axis"], lw=1.2, zorder=2, label=f"pooled rate {pooled:.1f}%")
    for v, lab in ((band[0] * 100, f"band floor {band[0] * 100:.0f}%"), (band[1] * 100, f"band ceiling {band[1] * 100:.0f}%")):
        ax2.axhline(v, color=N["ink"], ls=":", lw=1.3, zorder=3)
        ax2.annotate(f" {lab}", (0, v), xytext=(0, 3), textcoords="offset points", fontsize=8, color=N["ink"])
    ax2.set_xticks(x[::3])
    ax2.set_xticklabels([day_labels[i] for i in x[::3]], fontsize=8)
    ax2.set_ylim(0, max(55, float(np.nanmax(ci[:, 1]) * 100) + 5))
    ax2.set_ylabel("windows with a fill, % of windows with a burst")
    ax2.set_xlabel("UTC day")
    ax2.legend(loc="upper right", fontsize=8)
    return fig


def luck_fig(placebo, obs, obs_lo, obs_hi, p95, halves, window, notes, question="Does the burst's side earn more per fill than a fair coin's would at the same seconds?"):
    """Left: 200 draws of the same rule with a fair-coin side (grey), the rule's net per fill (ink line, its 95% slot interval above) and the placebo's 95th percentile (ink dotted).
    Right: the rule's net per fill over the whole window and in each half, with 95% intervals; zero is the decision line."""
    fig, (ax, ax2) = _frame(4.2, notes, question, window, ncols=2, wspace=0.28, ratios=[1.3, 1])
    pl = np.asarray(placebo, float)
    pl = pl[np.isfinite(pl)]
    ax.hist(pl, bins=24, color=Q["fees"], alpha=0.85, zorder=3, label=f"coin-side draws ({len(pl)})")
    ymax = ax.get_ylim()[1]
    ax.axvline(obs, color=N["ink"], lw=2.4, zorder=5, label=f"the burst's side {obs:+.2f}")
    ax.errorbar([obs], [ymax * 0.70], xerr=[[obs - obs_lo], [obs_hi - obs]], fmt="o", color=N["ink"], ecolor=N["ink"], elinewidth=1.4, capsize=3, ms=4, zorder=6, label="95% by slot")
    ax.axvline(p95, color=N["ink"], ls=":", lw=1.4, zorder=4)
    ax.annotate(f" draws' 95th percentile {p95:+.2f}", (p95, ymax * 0.50), fontsize=8, color=N["ink"])
    p = (1 + int((pl >= obs).sum())) / (len(pl) + 1)
    ax.set_ylim(0, ymax * 1.08)
    ax.set_xlabel("net USD per fill")
    ax.set_ylabel("draws")
    ax.legend(loc="upper right", fontsize=8)
    ax.set_title(f"one-sided p {p:.3f}: {int((pl >= obs).sum())} of {len(pl)} draws at or above the rule")
    rows = [("the whole window", obs, obs_lo, obs_hi, None)] + [(l, m, lo, hi, n) for l, n, m, lo, hi in halves]
    y = np.arange(len(rows))
    for i, (l, m, lo, hi, n) in enumerate(rows):
        ax2.errorbar([m], [i], xerr=[[m - lo], [hi - m]], fmt="o", color=_sign(m), ecolor=N["ink2"], elinewidth=1.0, capsize=3, ms=7, zorder=4)
        ax2.annotate(f"{m:+.2f}" + (f"  ({n} fills)" if n else ""), (hi, i), xytext=(6, 0), textcoords="offset points", fontsize=8, va="center")
    ax2.axvline(0, color=N["ink"], ls=":", lw=1.3, zorder=3)
    ax2.annotate(" zero", (0, -0.45), fontsize=8, color=N["ink"])
    ax2.set_yticks(y)
    ax2.set_yticklabels([r[0] for r in rows], fontsize=8.5)
    ax2.invert_yaxis()
    ax2.set_xlim(ax2.get_xlim()[0], ax2.get_xlim()[1] + 1.6)
    ax2.set_xlabel("net USD per fill, 95% by slot")
    ax2.set_title("is it the same in both halves?")
    return fig


def concentration_fig(bands, ranked, k5, window, notes, question="Where does the net of the fills come from: which price, and how few fills?"):
    """bands: [(label, n, per, lo, hi, win, breakeven)]. Left: net per fill by the price paid, interval whiskers, the fills behind each. Right: cumulative net of the fills ranked best first;
    the best 5% are marked and zero is the decision line."""
    fig, (ax, ax2) = _frame(4.2, notes, question, window, ncols=2, wspace=0.28, ratios=[1.15, 1])
    x = np.arange(len(bands))
    for i, (_l, n, per, lo, hi, _w, _b) in enumerate(bands):
        if n == 0:
            continue
        ax.bar(i, per, width=0.6, color=_sign(per), zorder=3)
        ax.errorbar([i], [per], yerr=[[per - lo], [hi - per]], fmt="none", color=N["ink2"], ecolor=N["ink2"], elinewidth=1.0, capsize=3, zorder=4)
        ax.annotate(f"n {n}", (i, hi if per >= 0 else lo), xytext=(0, 4 if per >= 0 else -10), textcoords="offset points", ha="center", fontsize=8, color=N["ink2"])
    ax.axhline(0, color=N["ink"], ls=":", lw=1.3, zorder=3)
    ax.set_xticks(x)
    ax.set_xticklabels([b[0] for b in bands], fontsize=8)
    ax.set_xlabel("price paid a share (the bid)")
    ax.set_ylabel("net USD per fill, 95% by slot")
    r = np.asarray(ranked, float)
    c = np.cumsum(r)
    ax2.plot(np.arange(1, len(c) + 1), c, color=PM, lw=2.0, zorder=4, label="cumulative net, best fill first")
    ax2.axvline(k5, color=N["ink"], ls=":", lw=1.3, zorder=3)
    ax2.annotate(f" best 5%: {k5} fills", (k5, c.max() * 0.35), fontsize=8, color=N["ink"])
    ax2.axhline(0, color=N["axis"], lw=1.0, zorder=2)
    ax2.annotate(f" peak {c.max():+,.0f}", (int(np.argmax(c)) + 1, c.max()), fontsize=8, color=N["ink2"], va="bottom")
    ax2.annotate(f"all {len(c):,} fills {c[-1]:+,.0f} ", (len(c), c[-1]), fontsize=8, color=_sign(c[-1]), ha="right", va="top")
    ax2.set_xlabel("fills, ranked best to worst")
    ax2.set_ylabel("cumulative net, USD")
    ax2.legend(loc="lower center", fontsize=8)
    return fig


def adverse_fig(rows, waits, window, notes, question="Do the orders that fill do worse than the ones that do not?"):
    """rows: [(label, fill mean, miss mean, diff, lo, hi)] in one common unit (points or cents). Left: the fill minus the miss with its slot interval, zero the decision line.
    Right: the wait from landing to the first fill, in seconds (the count behind the fills)."""
    fig, (ax, ax2) = _frame(4.0, notes, question, window, ncols=2, wspace=0.35, ratios=[1.6, 1], left=0.24)
    y = np.arange(len(rows))
    for i, (_l, fm, mm, d, lo, hi) in enumerate(rows):
        ax.errorbar([d], [i], xerr=[[d - lo], [hi - d]], fmt="o", color=_sign(d), ecolor=N["ink2"], elinewidth=1.0, capsize=3, ms=7, zorder=4)
        ax.annotate(f"{d:+.2f}  (fills {fm:+.2f}, misses {mm:+.2f})", (hi, i), xytext=(6, 0), textcoords="offset points", fontsize=8, va="center")
    ax.axvline(0, color=N["ink"], ls=":", lw=1.3, zorder=3)
    ax.set_yticks(y)
    ax.set_yticklabels([r[0] for r in rows], fontsize=8.5)
    ax.invert_yaxis()
    ax.set_xlim(min(r[4] for r in rows) * 1.2 - 0.5, max(r[5] for r in rows) + 7)
    ax.set_xlabel("fill minus miss, 95% by slot (points of a share, or cents)")
    w = np.asarray(waits, float)
    ax2.hist(np.clip(w, 0, 30), bins=30, color=FILLS, alpha=0.85, zorder=3)
    med = float(np.median(w))
    ax2.axvline(med, color=N["ink"], ls=":", lw=1.3, zorder=4)
    ax2.annotate(f" median {med:.1f} s", (med, ax2.get_ylim()[1] * 0.9), fontsize=8, color=N["ink"])
    ax2.set_xlabel("seconds from landing to the first fill (30 s life)")
    ax2.set_ylabel("fills")
    ax2.set_title("when the fills come")
    return fig


def grid_fig(cells, window, notes, question="Does any change to the order's rules turn the net per fill positive beyond its interval?"):
    """cells: [(label, fills, per, lo, hi)], the first is the primary. Left: net per fill with its 95% slot interval, zero the decision line. Right: the fills behind each."""
    fig, (ax, ax2) = _frame(max(4.2, 0.27 * len(cells) + 1.4), notes, question, window, ncols=2, wspace=0.05, ratios=[3.2, 1], left=0.22)
    ax2.sharey(ax)
    y = np.arange(len(cells))
    for i, (_l, n, per, lo, hi) in enumerate(cells):
        ax.errorbar([per], [i], xerr=[[per - lo], [hi - per]], fmt="o" if i else "D", color=_sign(per), ecolor=N["ink2"], elinewidth=1.0, capsize=2.5, ms=7 if i else 8, zorder=4)
    ax.axvline(0, color=N["ink"], ls=":", lw=1.3, zorder=3)
    ax.set_yticks(y)
    ax.set_yticklabels([c[0] + ("  (primary)" if i == 0 else "") for i, c in enumerate(cells)], fontsize=8.5)
    ax.invert_yaxis()
    ax.set_xlabel("net USD per fill, 95% by slot (diamond: the primary)")
    ax2.barh(y, [c[1] for c in cells], color=MISSES, height=0.6, zorder=3)
    for i, c in enumerate(cells):
        ax2.annotate(f"{c[1]:,}", (c[1], i), xytext=(4, 0), textcoords="offset points", fontsize=8, va="center")
    ax2.tick_params(labelleft=False)
    ax2.set_xlim(0, max(c[1] for c in cells) * 1.3)
    ax2.set_xlabel("fills")
    return fig


def queue_fig(mults, fills, per, lo, hi, window, notes, question="Does the net per fill depend on how far back in the queue the order sits?"):
    """Left: fills as the queue ahead is scaled (0 = front of the queue, 1 = the displayed size). Right: net per fill with its 95% slot interval; zero is the decision line, the primary (1x) is marked."""
    fig, (ax, ax2) = _frame(4.0, notes, question, window, ncols=2, wspace=0.28)
    x = np.arange(len(mults))
    lab = [f"{m:g}x" if m else "front" for m in mults]
    ax.bar(x, fills, width=0.6, color=MISSES, zorder=3)
    for i, f in enumerate(fills):
        ax.annotate(f"{int(f):,}", (i, f), xytext=(0, 3), textcoords="offset points", ha="center", fontsize=8.5)
    ax.set_xticks(x)
    ax.set_xticklabels(lab)
    ax.set_xlabel("queue ahead of the order, times the displayed size")
    ax.set_ylabel("fills (one a window)")
    ax.set_title("fewer fills the further back it sits")
    per, lo, hi = (np.asarray(a, float) for a in (per, lo, hi))
    ax2.errorbar(x, per, yerr=[per - lo, hi - per], fmt="o", color=PM, ecolor=N["ink2"], elinewidth=1.0, capsize=3, ms=6, zorder=4)
    ax2.plot(x, per, color=PM, lw=1.6, zorder=3)
    ax2.axhline(0, color=N["ink"], ls=":", lw=1.3, zorder=3)
    ax2.annotate(" zero", (x[0] - 0.3, 0), xytext=(0, 3), textcoords="offset points", fontsize=8, color=N["ink"])
    one = list(mults).index(1.0)
    ax2.scatter([one], [per[one]], s=130, facecolors="none", edgecolors=N["ink"], linewidths=1.6, zorder=6, label="the primary")
    ax2.set_xticks(x)
    ax2.set_xticklabels(lab)
    ax2.set_xlabel("queue ahead of the order, times the displayed size")
    ax2.set_ylabel("net USD per fill, 95% by slot")
    ax2.set_title("the fills that survive a deeper queue are not better, only fewer")
    ax2.legend(loc="upper left", fontsize=8)
    return fig


def power_fig(sd, per_day, n_fwd, days_fwd, design_n, design_effect, bar, window, notes, question="Can the forward read tell this edge from zero, and how many days would it take?"):
    """Left: the 95% half-width of a mean of n fills (the smallest effect n fills can show), n on a log axis; the forward read, the design sample, the design estimate and the owner's bar are marked.
    Right: the days of fills a forward read needs to show an effect of a given size."""
    fig, (ax, ax2) = _frame(4.2, notes, question, window, ncols=2, wspace=0.28)
    n = np.logspace(2, 4.3, 120)
    hw = 1.96 * sd / np.sqrt(n)
    ax.plot(n, hw, color=N["ink"], lw=2.2, zorder=4, label="smallest effect n fills can show (95%)")
    ax.set(xscale="log", yscale="log")
    for v, lab, a in ((n_fwd, f"forward read: {n_fwd:,.0f} fills in {days_fwd} days", "left"), (design_n, f"design window: {design_n:,.0f} fills", "right")):
        ax.axvline(v, color=N["ink"], ls=":", lw=1.3, zorder=3)
        ax.annotate(f" {lab}" if a == "left" else f"{lab} ", (v, 0.20 if a == "left" else 0.30), xycoords=("data", "axes fraction"), fontsize=8, va="center", ha=a)
    for v, lab in ((design_effect, f"design estimate {design_effect:+.2f}"), (bar, f"owner's bar {bar:+.2f}")):
        ax.axhline(v, color=N["ink"], ls=":", lw=1.3, zorder=3)
        ax.annotate(f" {lab}", (n[0], v), xytext=(2, 3), textcoords="offset points", fontsize=8, color=N["ink"])
    h_fwd = 1.96 * sd / np.sqrt(n_fwd)
    ax.scatter([n_fwd], [h_fwd], s=60, color=BAD if h_fwd > design_effect else GOOD, zorder=6, label=f"at the forward read: {h_fwd:.2f}")
    ax.set_xlabel("fills")
    ax.set_ylabel("USD per fill")
    ax.set_yticks([0.25, 0.5, 1, 2, 4, 8])
    ax.xaxis.set_major_formatter("{x:g}")
    ax.yaxis.set_major_formatter("{x:g}")
    ax.yaxis.set_minor_formatter("")
    ax.legend(loc="upper right", fontsize=8)
    d = np.linspace(0.25, 3.0, 100)
    days = (1.96 * sd / d) ** 2 / per_day
    ax2.plot(d, days, color=PM, lw=2.2, zorder=4)
    ax2.set_yscale("log")
    ax2.axhline(days_fwd, color=N["ink"], ls=":", lw=1.3, zorder=3)
    ax2.annotate(f" the registered forward read, {days_fwd} days", (0.27, days_fwd), xytext=(0, 3), textcoords="offset points", fontsize=8, color=N["ink"])
    ax2.axvline(bar, color=N["ink"], ls=":", lw=1.3, zorder=3)
    need = (1.96 * sd / bar) ** 2 / per_day
    ax2.scatter([bar], [need], s=60, color=BAD, zorder=6)
    ax2.annotate(f" {need:,.0f} days to show {bar:+.1f}", (bar, need), xytext=(4, 6), textcoords="offset points", fontsize=8)
    ax2.set_xlabel("effect to show, USD per fill")
    ax2.set_ylabel(f"days of fills ({per_day:.0f} a day)")
    ax2.yaxis.set_major_formatter("{x:g}")
    ax2.yaxis.set_minor_formatter("")
    return fig
