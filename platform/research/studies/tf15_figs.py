"""Figures of the strategy search (B-0654): matplotlib and `fundplat.quant.core.figstyle` only, built on the frame helpers of `lift_figs`. Each function takes the tables
`tf15_report` returns and draws one figure under the figure rules (a question for a title, the window under it, findings below, one meaning per colour, solid series).
"""
from __future__ import annotations

import numpy as np

import lift_figs as LF

N = LF.N
GOOD, BAD = LF.GOOD, LF.BAD
INK = N["ink"]


def grid_fig(cells, chosen, win, bul, q):
    """Validation net USD per entry of every registered cell (bars, sign colour, 95% slot interval), the TRAIN value as an ink tick, the chosen cell marked."""
    names = [c["cfg"]["name"] for c in cells]
    per = np.array([c["validate"].get("per", np.nan) for c in cells], float)
    lo = np.array([c["validate"].get("per_lo", np.nan) for c in cells], float)
    hi = np.array([c["validate"].get("per_hi", np.nan) for c in cells], float)
    tr = np.array([c["train"].get("per", np.nan) for c in cells], float)
    n = len(cells)
    fig, (ax,) = LF.frame(max(4.2, 0.19 * n + 2.2), bul, q, win)
    fig.subplots_adjust(left=0.27)
    y = np.arange(n)
    cols = [GOOD if v >= 0 else BAD for v in np.nan_to_num(per)]
    ax.barh(y, np.nan_to_num(per), color=cols, height=0.7, zorder=3)
    ax.errorbar(np.nan_to_num(per), y, xerr=[np.nan_to_num(per - lo), np.nan_to_num(hi - per)], fmt="none", ecolor=N["ink2"], color=N["ink2"], elinewidth=0.9, capsize=2, zorder=4)
    ax.scatter(np.nan_to_num(tr), y, marker="|", s=90, color=INK, zorder=5, label="the TRAIN days' net per entry")
    ax.axvline(0, color=N["axis"], lw=1.0)
    ax.set_yticks(y)
    ax.set_yticklabels(names, fontsize=7.5)
    ax.invert_yaxis()
    for t in ax.get_yticklabels():
        if t.get_text() == chosen["name"]:
            t.set_fontweight("bold")
    ax.set_xlabel("net USD per entry on the validation days (bars, 95% by slot); ink tick = train days")
    ax.legend(loc="lower right", fontsize=8)
    return fig


def daily_fig(day_tab, win, bul, q):
    """Net USD by test day (bars) with the entries per day printed above."""
    fig, (ax,) = LF.frame(3.6, bul, q, win)
    x = np.arange(len(day_tab))
    net = day_tab["net"].to_numpy(float)
    ax.bar(x, net, color=[GOOD if v >= 0 else BAD for v in net], width=0.6, zorder=3)
    for xi, (v, n) in enumerate(zip(net, day_tab["entries"].to_numpy(float))):
        ax.annotate(f"{int(n)} entries", (xi, v), ha="center", va="bottom" if v >= 0 else "top", fontsize=8.5, color=N["ink2"], xytext=(0, 3 if v >= 0 else -3), textcoords="offset points")
    LF.zero(ax)
    ax.set_xticks(x)
    ax.set_xticklabels([str(d)[5:] for d in day_tab.index])
    ax.set_ylabel("net USD")
    return fig


def equity_fig(eq, ddpath, win, bul, q):
    """Cumulative net by 15-minute slot (a solid line in the model identity) with the drawdown shaded."""
    fig, (ax,) = LF.frame(3.8, bul, q, win)
    x = np.arange(len(eq))
    ax.plot(x, eq, color=LF.MOD, lw=1.8, label="cumulative net USD", zorder=4)
    ax.fill_between(x, eq, eq - ddpath, color=BAD, alpha=0.18, lw=0, label="drawdown from the running peak", zorder=2)
    LF.zero(ax)
    ax.set_xlabel("entry number, in time order")
    ax.set_ylabel("USD")
    ax.legend(loc="upper left", fontsize=8)
    return fig


def delay_fig(dt, win, bul, q, bar=150):
    """Net USD per entry against the order delay: a solid line with its interval; the 150 ms line in ink, dotted."""
    fig, (ax,) = LF.frame(3.8, bul, q, win)
    LF.band(ax, dt["delay_ms"].to_numpy(float), dt["per"].to_numpy(float), (dt["hi"].to_numpy(float) - dt["lo"].to_numpy(float)) / 3.92, LF.PM, "net per entry")
    LF.zero(ax)
    ax.axvline(bar, color=INK, ls=":", lw=1.3, zorder=3)
    ax.annotate(f" {bar} ms, the venue's taker delay", xy=(bar, 0.97), xycoords=("data", "axes fraction"), fontsize=8, color=INK, va="top")
    ax.set_xlabel("delay between the decision and the order reaching the book, ms")
    ax.set_ylabel("net USD per entry")
    return fig


def placebo_fig(real, placebo, win, bul, q, label="the chosen cell"):
    """Net per entry of the placebo draws (bars) against the real cell (ink, dotted line)."""
    fig, (ax,) = LF.frame(3.6, bul, q, win)
    p = np.asarray(placebo, float)
    if len(p) > 1:
        ax.hist(p, bins=min(14, max(4, len(p) // 2)), color=LF.BIN, alpha=0.85, zorder=3, label="placebo draws")
    else:
        ax.bar([0], p, color=LF.BIN, width=0.4, label="placebo", zorder=3)
    ax.axvline(real, color=INK, ls=":", lw=1.6, zorder=4)
    ax.annotate(f" {label}: {real:+.2f}", xy=(real, 0.95), xycoords=("data", "axes fraction"), fontsize=8.5, color=INK, va="top")
    ax.set_xlabel("net USD per entry")
    ax.legend(loc="upper left", fontsize=8)
    return fig


def band_fig(tab, win, bul, q):
    """Win share against the average price paid, by price band: the bars are the win share, the ink ticks the share needed to break even (price plus fee)."""
    fig, (ax,) = LF.frame(3.8, bul, q, win)
    x = np.arange(len(tab))
    win_ = tab["win"].to_numpy(float) * 100
    ax.bar(x, win_, color=[GOOD if w >= b else BAD for w, b in zip(win_, tab["vwap"].to_numpy(float) * 100)], width=0.6, zorder=3, label="win share (green: above the price paid)")
    ax.scatter(x, tab["vwap"].to_numpy(float) * 100, marker="_", s=420, color=INK, zorder=5, label="average price paid")
    for xi, n in zip(x, tab["entries"]):
        ax.annotate(f"{int(n)}", (xi, 0), ha="center", va="bottom", fontsize=8, color=N["ink2"], xytext=(0, 3), textcoords="offset points")
    ax.set_xticks(x)
    ax.set_xticklabels([str(b) for b in tab.index], fontsize=8)
    ax.set_ylabel("percent")
    ax.set_xlabel("price paid a share (entries printed at the foot of each bar)")
    ax.legend(loc="upper left", fontsize=8)
    return fig
