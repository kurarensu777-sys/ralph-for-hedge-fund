"""Figures of the directional momentum study (B-0660): matplotlib and `fundplat.quant.core.figstyle` only, on the frames of `lift_figs` and `tf15_figs`. Each function takes tables
the engine returned and draws one figure under the figure rules (a question for a title, the window and hours under it, findings below, one meaning per colour, solid series).

    surface_fig     the lookback x z surface of net USD per entry (kind parameter-surface, the chart bank's recipe)
    exits_fig       every exit of a sweep against the others: net per entry on the validation days with the fit days as a tick (kind rule-comparison)
    win_loss_fig    the per-entry net USD as a histogram, gains and losses in the two verdict colours (kind win-loss-distribution, the chart bank's recipe)
    per_trade_fig   each entry's net in time order with its rolling mean (kind equity-curve: its per panel with a rolling mean)
    rolling_win_fig the share of entries that win over a rolling window, against the full sample and the break-even share (kind rolling-statistics: the win-rate panel)
    ladder_fig      the win share and the break-even share by lookback over every day, with the weeks as marks and the gap in points beside it (kind calibration, B-0679)
    winrate_fig     the share of entries that win, or are positive, by price band, against the share needed to break even (kind calibration)
    windows_fig     every 15-minute window of the test days as a thin bar, by coin and day: won, lost, or no entry (kind session-timeline)
    l2_pages        one panel per entry on its L2 ladder: the levels lifted at entry, the levels sold into at exit, the PnL (kind trade-anatomy)
"""
from __future__ import annotations

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap as Cmap
from matplotlib.patches import Rectangle, Patch

import lift_figs as LF
import mom15_bt as M
from fundplat.quant.core import figstyle as fs

N, V = fs.NEUTRAL, fs.VERDICT
GOOD, BAD = V["good"], V["bad"]
PM = fs.IDENTITY["POLYMARKET"]


def surface_fig(grid, chosen, window, notes, metric="net USD per entry", fmt="{:+.2f}", question="Is the best lookback and threshold on a plateau or on a spike?", hurdle=0.0):
    """grid: DataFrame (rows = lookback, columns = z), chosen: (row, column) or None. The chart bank's parameter surface, with the chosen cell outlined only when there is one."""
    f = fmt.format
    g = grid.to_numpy(float)
    span = np.nanmax(np.abs(g - hurdle)) or 1.0
    fig, gs, ax, axt = fs.fig_tab(5.4, (3, 0.7), top=0.84, nb=fs.nlines(notes))
    ax.imshow(np.nan_to_num(g, nan=hurdle), cmap=Cmap.from_list("g", [BAD, N["surface"], GOOD]), vmin=hurdle - span, vmax=hurdle + span, aspect="auto")
    ax.grid(False)
    for (r, c), v in np.ndenumerate(g):
        ax.text(c, r, f(v) if v == v else "n/a", ha="center", va="center", fontsize=9)
    if chosen is not None:
        i, j = grid.index.get_loc(chosen[0]), grid.columns.get_loc(chosen[1])
        ax.add_patch(Rectangle((j - .5, i - .5), 1, 1, fill=False, edgecolor=N["ink"], linewidth=2.6, label="chosen on validation"))
    ax.set(xticks=range(g.shape[1]), xticklabels=[str(c) for c in grid.columns], xlabel=grid.columns.name, yticks=range(g.shape[0]), yticklabels=[str(r) for r in grid.index], ylabel=grid.index.name)
    ax.legend(handles=[Patch(facecolor=V[k], label=w + " zero") for k, w in (("good", "above"), ("bad", "below"))] + ax.patches, loc="lower left", bbox_to_anchor=(0, 1), ncol=4, frameon=False)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, weight="bold")
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    ok = float((g > hurdle).mean()) if np.isfinite(g).any() else 0.0
    cells = [[f(np.nanmax(g)), f(np.nanmean(g)), f(np.nanmin(g)), f"{np.nansum(g > hurdle) / max(np.isfinite(g).sum(), 1):.0%}", f(hurdle)]]
    tb = fs.put_table(axt, cells, [f"Best cell, {metric}", "Mean cell", "Worst cell", "Cells above zero", "Zero line"])
    fs.tint(tb, 1, 3, "green" if ok > 0.5 else "rose")
    fs.bullets(fig, notes)
    return fig


def ladder_fig(lad, window, notes, question="Does the win share rise with the lookback only as fast as the break-even share?"):
    """lad: `mom15_report.ladder_frame` (L, period, n, win, lo, hi, be, gap). Left: the win share over every day (solid ink, 95% Wilson band) against the share the price and fee ask (solid grey);
    right: the gap in points, green above zero and red below, with the Wilson whisker, and each period's gap as a mark (circle, square, diamond), zero as the ink dotted line."""
    periods = list(dict.fromkeys(lad["period"]))
    pooled, parts = periods[-1], periods[:-1]
    Ls = sorted(lad["L"].unique())
    x = np.arange(len(Ls))
    P = lad[lad["period"] == pooled].set_index("L").loc[Ls]
    fig, (a, b) = LF.frame(4.2, notes, question, window, ncols=2, wspace=0.22)
    a.fill_between(x, P["lo"] * 100, P["hi"] * 100, color=N["ink"], alpha=0.12, linewidth=0, label="95% Wilson interval of the win share")
    a.plot(x, P["win"] * 100, color=N["ink"], linewidth=2.2, marker="o", label=f"win share, {pooled}")
    a.plot(x, P["be"] * 100, color=N["muted"], linewidth=2.2, marker="s", label="break-even share (price paid plus fee)")
    a.set_xticks(x); a.set_xticklabels([f"{L} s" for L in Ls]); a.set_xlabel("lookback"); a.set_ylabel("percent of entries")
    a.legend(loc="upper left", fontsize=8.5, frameon=False)
    gap = P["gap"].to_numpy(float)
    wk = [(P["lo"] - P["be"]).to_numpy(float) * 100, (P["hi"] - P["be"]).to_numpy(float) * 100]
    b.bar(x, gap, width=0.55, color=[GOOD if g > 0 else BAD for g in gap], alpha=0.75, zorder=2, label=f"win share minus break-even, {pooled}")
    b.errorbar(x, gap, yerr=[gap - wk[0], wk[1] - gap], fmt="none", color=N["ink"], ecolor=N["ink"], elinewidth=1.2, capsize=3, zorder=4)
    for (nm, mk), off in zip(zip(parts, ("o", "s", "D", "^")), np.linspace(-0.2, 0.2, max(len(parts), 1))):
        Q = lad[lad["period"] == nm].set_index("L").loc[Ls]
        b.scatter(x + off, Q["gap"], marker=mk, s=34, color=N["ink2"], zorder=5, label=nm)
    b.axhline(0, color=N["ink"], linewidth=1.1, linestyle=(0, (1, 2.4)), zorder=3)
    b.annotate("zero: the win share only pays the price and fee", (len(Ls) - 0.6, 0), xytext=(0, 5), textcoords="offset points", ha="right", fontsize=8.5)
    b.set_xticks(x); b.set_xticklabels([f"{L} s" for L in Ls]); b.set_xlabel("lookback"); b.set_ylabel("points of win share above break-even")
    lo_ = float(np.nanmin([np.nanmin(wk[0]), np.nanmin(lad["gap"])]))
    b.set_ylim(lo_ - 0.22 * (1.0 + abs(lo_)), max(float(np.nanmax(lad["gap"])), 0.0) + 0.5)
    b.legend(loc="lower left", fontsize=8.5, frameon=False, ncol=2)
    return fig


def exits_fig(rows, chosen_i, window, notes, question="Which exit earns the most on the validation days?"):
    """rows: [{key, ex, fit, validate}] -> bars of the validation net per entry (95% by slot), the fit days' value as an ink tick, the chosen row in bold."""
    names = [r["ex"].name for r in rows]
    per = np.array([r["validate"].get("per", np.nan) for r in rows], float)
    lo = np.array([r["validate"].get("per_lo", np.nan) for r in rows], float)
    hi = np.array([r["validate"].get("per_hi", np.nan) for r in rows], float)
    fit = np.array([r["fit"].get("per", np.nan) for r in rows], float)
    n = len(rows)
    fig, (ax,) = LF.frame(max(3.6, 0.36 * n + 1.4), notes, question, window)
    ax.get_subplotspec().get_gridspec().update(left=0.2)
    y = np.arange(n)
    ax.barh(y, np.nan_to_num(per), color=[GOOD if v >= 0 else BAD for v in np.nan_to_num(per)], height=0.7, zorder=3)
    ax.errorbar(np.nan_to_num(per), y, xerr=[np.nan_to_num(per - lo), np.nan_to_num(hi - per)], fmt="none", ecolor=N["ink2"], color=N["ink2"], elinewidth=0.9, capsize=2, zorder=4)
    ax.scatter(np.nan_to_num(fit), y, marker="|", s=90, color=N["ink"], zorder=5, label="the FIT days' net per entry")
    ax.axvline(0, color=N["axis"], lw=1.0)
    ax.set_yticks(y)
    ax.set_yticklabels(names, fontsize=8.5)
    ax.invert_yaxis()
    for t, i in zip(ax.get_yticklabels(), range(n)):
        if i == chosen_i:
            t.set_fontweight("bold")
    ax.set_xlabel("net USD per entry on the validation days (bars, 95% by slot); ink tick = fit days")
    ax.legend(loc="lower right", fontsize=8)
    return fig


def win_loss_fig(net, window, notes, question="What do the trades win and lose?"):
    """The chart bank's win/loss distribution (kind win-loss-distribution): per-entry net as a histogram, green above zero and red below, the mean and the median as ink dotted verticals."""
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
    ax.set_xlabel("net per entry, USD"); ax.set_ylabel("entries")
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig


def per_trade_fig(net, roll, full, window, notes, question="How did the P&L arrive trade by trade?"):
    """The chart bank's per-trade P&L over time (kind equity-curve: its per panel with a rolling mean): each entry's net as a thin bar in time order, the rolling mean as a solid ink line, the full-sample mean dotted."""
    net = np.asarray(net, float)
    x = np.arange(1, len(net) + 1)
    c = np.concatenate([[0], np.cumsum(net)])
    rm = (c[roll:] - c[:-roll]) / roll
    xr = np.arange(roll, len(net) + 1)
    nb = fs.nlines(notes)
    fig, ax = plt.subplots(figsize=(13, 4.8 + nb * 0.205))
    fig.subplots_adjust(left=0.07, right=0.97, top=1 - 0.9 / fig.get_size_inches()[1], bottom=fs.bullet_margin(fig, nb) + 0.08)
    ax.bar(x, net, width=0.8, color=[V["good"] if v > 0 else V["bad"] for v in net])
    ax.plot(xr, rm, color=N["ink"], linewidth=2.2, label=f"rolling mean, {roll} entries")
    ax.axhline(full, color=N["ink"], linewidth=1.3, linestyle=":")
    ax.text(len(net), full, f" full-sample mean {full:+.2f} ", ha="right", va="bottom", fontsize=8.5, color=N["ink"])
    ax.axhline(0, color=N["axis"], linewidth=1)
    ax.set_xlabel("entries in time order"); ax.set_ylabel("net per entry, USD")
    ax.legend(loc="best", fontsize=8.5, frameon=False)
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig


def rolling_win_fig(won, roll, full, window, notes, brk=None, question="Does the win rate hold through the window?"):
    """The chart bank's rolling win rate (kind rolling-statistics: the win-rate panel): the share of the last `roll` entries that won, against the full-sample rate and the break-even rate."""
    w = np.asarray(won, float)
    c = np.concatenate([[0], np.cumsum(w)])
    rate = (c[roll:] - c[:-roll]) / roll
    x = np.arange(roll, len(w) + 1)
    nb = fs.nlines(notes)
    fig, ax = plt.subplots(figsize=(13, 4.8 + nb * 0.205))
    fig.subplots_adjust(left=0.07, right=0.97, top=1 - 0.9 / fig.get_size_inches()[1], bottom=fs.bullet_margin(fig, nb) + 0.08)
    ax.plot(x, rate, color=N["ink"], linewidth=2.2, marker="o", ms=3, label=f"rolling win rate, {roll} entries")
    ax.axhline(full, color=N["ink"], linewidth=1.3, linestyle=":", label=f"full sample {full:.0%}")
    if brk is not None:
        ax.axhline(brk, color=N["ink"], linewidth=1.1, linestyle=(0, (1, 1)), label=f"break-even {brk:.0%}")
    ax.set_ylim(0, 1.02)
    ax.set_xlabel("entries in time order"); ax.set_ylabel("share of entries that win")
    ax.legend(loc="best", fontsize=8.5, frameon=False)
    ax.set_title(question, loc="left", pad=24, fontsize=11.5, fontweight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], fontsize=8.5)
    fs.bullets(fig, notes)
    return fig


def winrate_fig(tab, window, notes, question="Does the win share beat the break-even share in each price band?", early=False):
    """tab: `mom15_report.band_frame` (entries, win, vwap, breakeven). A held token wins when it pays; its break-even share is the price paid plus the fee a share. An early exit has no
    break-even share, so its bars are the share of entries with a positive net, against one half."""
    fig, (ax,) = LF.frame(3.8, notes, question, window)
    x = np.arange(len(tab))
    win_ = tab["win"].to_numpy(float) * 100
    be = tab["breakeven"].to_numpy(float) * 100
    if early:
        ax.bar(x, win_, color=[GOOD if w >= 50 else BAD for w in win_], width=0.6, zorder=3, label="share of entries with a positive net (green: at least half)")
    else:
        ax.bar(x, win_, color=[GOOD if w >= b else BAD for w, b in zip(win_, be)], width=0.6, zorder=3, label="win share (green: above the break-even share)")
        ax.scatter(x, be, marker="_", s=420, color=N["ink"], zorder=5, label="break-even share (price paid plus fee)")
    for xi, n in zip(x, tab["entries"]):
        ax.annotate(f"{int(n)}", (xi, 0), ha="center", va="bottom", fontsize=8, color=N["ink2"], xytext=(0, 3), textcoords="offset points")
    ax.set_xticks(x)
    ax.set_xticklabels([str(b) for b in tab.index], fontsize=8)
    ax.set_ylabel("percent")
    ax.set_xlabel("price paid a share (entries printed at the foot of each bar)")
    ax.legend(loc="upper left", fontsize=8)
    return fig


def windows_strip(days, hour, day_idx, lane, lanes, status, window, notes, question="Which windows did we enter?"):
    """Every 15-minute window as one thin bar, one lane a market, one panel a day (kind exposure-over-time): `status` is +1 where the entry made money, -1 where it lost, 0 where the window
    had a book and the rule did not fire. `hour` is the window's start in hours of the UTC day."""
    nd, nl = len(days), len(lanes)
    fig, axes = LF.frame(0.35 * nl * nd + 0.9 * nd + 0.8, notes, question, window, nrows=nd, hspace=0.75)
    hour, day_idx, lane, status = (np.asarray(a) for a in (hour, day_idx, lane, status))
    for d, ax in enumerate(axes):
        idx = np.flatnonzero(day_idx == d)
        cols = [GOOD if status[i] > 0 else BAD if status[i] < 0 else N["grid"] for i in idx]
        ax.bar(hour[idx], 0.8, width=0.2, bottom=lane[idx] - 0.4, color=cols, align="edge", zorder=3)
        ax.set_yticks(range(nl))
        ax.set_yticklabels(lanes, fontsize=8)
        ax.set_ylim(-0.6, nl - 0.4)
        ax.invert_yaxis()
        ax.set_xlim(0, 24)
        ax.set_xticks(range(0, 25, 3))
        ax.set_title(days[d], loc="left", fontsize=8.5, color=N["ink2"], pad=3)
        ax.grid(False)
        for sp in ("top", "right"):
            ax.spines[sp].set_visible(False)
    axes[-1].set_xlabel("hour of the day, UTC")
    H = fig.get_size_inches()[1]
    fig.legend(handles=[Patch(color=GOOD, label="entered, made money"), Patch(color=BAD, label="entered, lost money"), Patch(color=N["grid"], label="window with a book, no entry")],
               loc="upper left", bbox_to_anchor=(0.065, 1 - 0.78 / H), ncol=3, frameon=False, fontsize=8)
    return fig


def windows_fig(tab, e, window, notes, question="Which windows did we enter?"):
    """`windows_strip` for the momentum table `tab` and the entries `e` of one pair on it: four lanes (the coins), one panel a day."""
    net = {int(w): float(n) for w, n in zip(e["w"], e["net"])}
    idx = np.arange(tab.W)
    status = [0 if int(w) not in net else (1 if net[int(w)] > 0 else -1) for w in idx]
    hour = (np.asarray(tab.w_start, np.int64) % 86_400_000) / 3_600_000.0
    return windows_strip(tab.days, hour, tab.day, np.asarray(tab.w_asset), ["BTC", "ETH", "SOL", "XRP"], status, window, notes, question)


# ============================================================ the L2 view of an entry
def _bars(ax, px, sz, take, sign):
    """Ladder levels as bars at their price, `sign` +1 up (asks) or -1 down (bids); the shares taken solid, the depth left light."""
    ok = np.isfinite(px) & np.isfinite(sz) & (sz > 0)
    w = 0.006
    for p, s, t in zip(px[ok], sz[ok], take[ok]):
        ax.bar(p, sign * s, width=w, color=PM, alpha=0.28, zorder=2)
        if t > 0:
            ax.bar(p, sign * t, width=w, color=PM, zorder=3)


def l2_panel(ax, rec, e, i, tab, label):
    """One entry: asks above the line (what was lifted), bids below it (what an early exit sold into), the volume-weighted prices as ink markers (a triangle pointing the way the entry bets, a square for the exit), the PnL as the title colour."""
    shares, net = float(e["shares"][i]), float(e["net"][i])
    ax.axhline(0, color=N["axis"], lw=0.8, zorder=1)
    _bars(ax, np.asarray(rec["ask_px"], float), np.asarray(rec["ask_sz"], float), rec["ask_take"], +1)
    top = 2.2 * shares                                                   # deeper levels are cut at the frame: the shares taken stay readable
    bottom = 2.2 * shares
    if rec["bid_px"] is not None:
        _bars(ax, np.asarray(rec["bid_px"], float), np.asarray(rec["bid_sz"], float), rec["bid_take"], -1)
    ent = float(e["cost"][i]) / shares
    ax.scatter([ent], [0], marker="^" if int(e["side"][i]) > 0 else "v", s=40, color=N["ink"], zorder=5)     # points the way the entry bets
    xs = [float(p) for p in np.asarray(rec["ask_px"], float) if np.isfinite(p)]
    if rec["bid_px"] is not None:
        xs += [float(p) for p in np.asarray(rec["bid_px"], float) if np.isfinite(p)]
        ex = float(e["exit_px"][i]) if np.isfinite(e["exit_px"][i]) else None
        if ex is not None:
            ax.scatter([ex], [0], marker="s", s=26, color=N["ink"], zorder=5)
        how = f"sold {e['sold'][i]:.0f} at {ex:.3f}" if ex is not None else "no bid: held"
    else:
        how = "held: pays " + ("1" if e["won"][i] else "0")
    lo, hi = (min(xs + [ent]), max(xs + [ent])) if xs else (ent, ent)
    ax.set_xlim(lo - 0.015, hi + 0.015)
    ax.set_ylim(-bottom if rec["bid_px"] is not None else -0.12 * top, 1.18 * top)
    ax.tick_params(labelsize=5.5, length=2, pad=1)
    ax.set_yticks([])
    ax.grid(False)
    for sp in ("left", "right", "top"):
        ax.spines[sp].set_visible(False)
    ax.set_title(f"{label}  {net:+.2f} USD", fontsize=6.8, loc="left", pad=2, color=GOOD if net >= 0 else BAD, fontweight="bold")
    ax.text(0.01, 0.97, f"buy {shares:.0f} at {ent:.3f}; {how}", transform=ax.transAxes, fontsize=5.6, va="top", color=N["ink2"])


def l2_pages(tab, e, idx, window, notes, per_page=24, ncols=4, question="Where did each entry fill on the order book, and what did it earn?", labels=None):
    """-> list of figures, `per_page` entries each, `idx` the entry numbers in the order drawn. Asks (what the buy lifted) above the line, bids (what the exit sold into) below,
    the solid part of a bar is the shares taken, the pale part the depth left, the triangle the average price paid (upright for a buy of Up, inverted for a buy of Down), the square the average price received."""
    pages = []
    coin = ["btc", "eth", "sol", "xrp"]
    for p0 in range(0, len(idx), per_page):
        chunk = idx[p0: p0 + per_page]
        nrows = int(np.ceil(len(chunk) / ncols))
        H = 1.4 + 1.5 * nrows + fs.nlines(notes) * 0.205 + 0.45
        fig = plt.figure(figsize=(13, H))
        bm = fs.bullet_margin(fig, fs.nlines(notes)) + 0.02
        top = 1 - 1.3 / H
        gs = fig.add_gridspec(nrows, ncols, left=0.03, right=0.985, top=top, bottom=bm, wspace=0.12, hspace=0.62)
        for j, i in enumerate(chunk):
            ax = fig.add_subplot(gs[j // ncols, j % ncols])
            rec = M.l2_record(tab, e, i)
            t0 = int(e["k"][i]) + M.K0
            lab = (labels[j + p0] if labels is not None else f"#{i} {coin[int(e['asset'][i])]} {tab.days[int(e['day'][i])][5:]}") + f" t+{t0}s"
            l2_panel(ax, rec, e, i, tab, lab)
        fig.suptitle(question, x=0.03, y=1 - 0.18 / H, ha="left", va="top", fontsize=11.5, fontweight="bold", color=N["ink"])
        fig.text(0.03, 1 - 0.58 / H, window, ha="left", va="top", fontsize=8.5, color=N["muted"])
        fs.bullets(fig, notes, bottom_in=0.12, x=0.03)
        pages.append(fig)
    return pages
