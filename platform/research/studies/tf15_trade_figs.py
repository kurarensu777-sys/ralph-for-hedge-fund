"""Trade-level figures of the 15-minute Up/Down strategy search (B-0654): matplotlib and `fundplat.quant.core.figstyle` only, on the frames of `lift_figs`.
Each function takes the `entries` dict `tf15_bt.entries` returns (one numpy row per trade, in time order) and draws one figure under the figure rules
(a question for a title, the window and hours under it, findings below, one meaning per colour, solid series).

    equity_fig           cumulative PnL over entries before the taker fee (solid) and after it (ink dotted, a dot per trade), each entry's net as a bar below
    trade_pnl_fig        per-trade net as bars at the entry's timestamp (other notebooks; equity_fig's second panel holds the same)
    rolling_winrate_fig  the share of the last `win` entries that won, against break-even and a coin flip
    rolling_pnl_fig      the mean net of the last `win` entries, against zero
    entry_price_fig      the entry price against time, Up and Down markers, against the break-even price

Colours: a gain or a win is green, a loss red, the strategy's own series in MODEL, thresholds (break-even, zero) in ink and dotted, the coin-flip line muted.
"""
from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from matplotlib.legend_handler import HandlerTuple
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from matplotlib.ticker import MaxNLocator

import lift_figs as LF
from fundplat.quant.core import figstyle as fs

N = LF.N
GOOD, BAD = LF.GOOD, LF.BAD
INK = N["ink"]
MOD = LF.MOD                                                    # the strategy's own series
SLOT_DAYS = 900.0 / 86_400.0                                    # one 15-minute slot in date units


def _times(e):
    """One datetime per entry (UTC, naive), from its slot id."""
    return np.array([datetime.fromtimestamp(int(s) * 900, tz=timezone.utc).replace(tzinfo=None) for s in e["slot"]], dtype=object)


def _window_str(e, days):
    """The subtitle when the notebook passes none: the day span and its hours."""
    return f"{days[0][5:]} to {days[-1][5:]} · {24 * len(days):,}h · {len(days)} days"


def _fmt_time(ax, fig):
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d %H:%M"))
    for lab in ax.get_xticklabels():
        lab.set_rotation(45)
        lab.set_ha("right")


DOT = (0, (1, 2.4))                                             # the after-fee path: ink and dotted (figstyle allows a dotted line only in ink)
LBL_GROSS, LBL_NET = "before the taker fee", "after the taker fee (what we keep)"


def gross_of(e):
    """Each entry's PnL before the taker fee (payoff less cost), or None when the entries dict carries neither `gross` nor `payoff` and `cost`."""
    if "gross" in e:
        return np.asarray(e["gross"], float)
    if "payoff" in e and "cost" in e:
        return np.asarray(e["payoff"], float) - np.asarray(e["cost"], float)
    return None


def fee_paths(ax, gross, net, col, lw=1.8, dot_lw=1.4, x0=0):
    """The two cumulative PnL paths over entries on `ax`: before the taker fee solid in `col`, after it ink and dotted; with `gross` None only the net, solid in `col`.
    -> the two cumulative arrays (each from zero; the first is None without a gross)."""
    xx = np.arange(x0, x0 + len(net) + 1)
    c_net = np.concatenate([[0.0], np.cumsum(net)])
    if gross is None:
        ax.step(xx, c_net, where="post", color=col, lw=lw, zorder=4, label="cumulative net")
        return None, c_net
    c_gr = np.concatenate([[0.0], np.cumsum(gross)])
    ax.step(xx, c_gr, where="post", color=col, lw=lw, zorder=4, label=LBL_GROSS)
    ax.step(xx, c_net, where="post", color=INK, lw=dot_lw, ls=DOT, zorder=6, label=LBL_NET)
    return c_gr, c_net


def _end_labels(ax, pairs):
    """Each path's last value written at its right end, the higher one above its line and the lower one under it, so the two never sit on each other."""
    pairs = [p for p in pairs if p[0] is not None]
    order = sorted(range(len(pairs)), key=lambda i: pairs[i][0][-1])
    for rank, i in enumerate(order):
        c, col, word = pairs[i]
        up = rank == len(order) - 1
        ax.annotate((f"{word} " if word else "") + f"{c[-1]:+,.0f}", (len(c) - 1, c[-1]), xytext=(4, 3 if up else -3), textcoords="offset points", ha="left",
                    va="bottom" if up else "top", fontsize=8, color=col, weight="bold", annotation_clip=False)


def equity_fig(e, days, notes=None, question="How did the account build, entry by entry?", window=None, fees=True, bars=True):
    """Top: the cumulative PnL over entries, before the taker fee as a solid line in the model identity and after it as an ink dotted path with a small dot per
    entry (green won, red lost), each path's total at its right end, the zero line. With `bars` a second panel: each entry's net as a bar at its time (green gain,
    red loss). `fees=False` (or entries without a payoff and cost) draws the net alone, solid."""
    net = np.asarray(e["net"], float)
    won = np.asarray(e["won"], bool)
    gross = gross_of(e) if fees else None
    n = len(net)
    if notes is None:
        notes = [f"{n:,} entries, {int(won.sum()):,} won ({won.mean() if n else float('nan'):.1%})."]
        if gross is not None:
            g, f = float(gross.sum()), float(gross.sum() - net.sum())
            notes.append(f"Before the taker fee {g:+,.2f} USD; the fee takes {f:,.2f}" + (f" ({f / g:.0%} of the gross)" if g > 0 else " (the gross is not positive)")
                         + f"; after it {float(net.sum()):+,.2f} USD, {float(net.mean()) if n else float('nan'):+.3f} an entry.")
        else:
            notes.append(f"Net {float(net.sum()):+,.2f} USD, {float(net.mean()) if n else float('nan'):+.3f} an entry.")
        if n:
            notes.append(f"Largest single win {float(net.max()):+.2f} USD, largest single loss {float(net.min()):+.2f} USD, after the fee.")
    if bars:
        fig, (ax, a2) = LF.frame(5.6, notes, question, window or _window_str(e, days), nrows=2, ratios=[3.0, 1.35], hspace=0.42, axis_pad=0.75)
    else:
        fig, (ax,) = LF.frame(3.8, notes, question, window or _window_str(e, days))
    c_gr, c_net = fee_paths(ax, gross, net, MOD)
    if n:
        ax.scatter(np.arange(1, n + 1), c_net[1:], s=3, c=[GOOD if w else BAD for w in won], zorder=5, edgecolors="none", alpha=0.6)
    _end_labels(ax, [(c_gr, MOD, "before"), (c_net, INK, "after" if c_gr is not None else "net")])
    LF.zero(ax)
    ax.set_xlim(0, max(n, 1) * 1.07)
    ax.set_xlabel("entry, in time order")
    ax.set_ylabel("USD, cumulative")
    ax.set_title("cumulative PnL over entries" + (", before and after the taker fee" if c_gr is not None else ""), fontsize=9.5, loc="left")
    ax.legend(loc="lower right", bbox_to_anchor=(1.0, 1.0), ncol=2, fontsize=8, frameon=False)       # over the panel, never on the data
    if bars:
        if n:
            a2.vlines(_times(e), 0, net, colors=[GOOD if v >= 0 else BAD for v in net], lw=1.0, zorder=3)
            a2.set_xlim(datetime.strptime(days[0], "%Y-%m-%d"), datetime.strptime(days[-1], "%Y-%m-%d") + timedelta(days=1))
            a2.xaxis.set_major_locator(mdates.DayLocator(interval=max(1, len(days) // 12)))
            a2.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d"))
        LF.zero(a2)
        a2.set_title("each entry's PnL after the taker fee, at its time", fontsize=9.5, loc="left")
        a2.set_xlabel("UTC day")
        a2.set_ylabel("USD an entry")
    return fig


def trade_pnl_fig(e, days, notes=None, question="How much did each entry make, and when?", window=None):
    """Per-trade net as a bar at the entry's timestamp (green gain, red loss), the zero line."""
    net = np.asarray(e["net"], float)
    notes = list(notes) if notes is not None else [f"{len(net)} entries; {int(np.sum(net > 0))} gained, {int(np.sum(net <= 0))} lost, total {float(net.sum()):+.2f} USD."]
    fig, (ax,) = LF.frame(3.6, notes, question, window or _window_str(e, days))
    x = _times(e)
    ax.bar(x, net, width=SLOT_DAYS * 0.6, color=[GOOD if v >= 0 else BAD for v in net], zorder=3)
    LF.zero(ax)
    _fmt_time(ax, fig)
    ax.set_ylabel("net USD an entry")
    return fig


def rolling_winrate_fig(e, days, notes=None, question="Does the win rate hold through the window?", win=30, be=0.607, window=None):
    """The share of the last `win` entries that won (a solid line in the model identity), the break-even share in ink dotted with a label, the coin-flip line muted."""
    won = np.asarray(e["won"], float)
    n = len(won)
    c = np.concatenate([[0.0], np.cumsum(won)])
    rate = (c[win:] - c[:-win]) / win
    x = np.arange(win, n + 1)
    notes = list(notes) if notes is not None else [f"Over {win} entries in a row the win rate runs from {float(rate.min()):.0%} to {float(rate.max()):.0%}; break-even is {be:.0%}."]
    fig, (ax,) = LF.frame(3.6, notes, question, window or _window_str(e, days))
    ax.plot(x, rate, color=MOD, lw=2.0, marker="o", ms=3, label=f"rolling win rate, {win} entries", zorder=4)
    LF.thresh(ax, be, f"break-even {be:.0%}")
    ax.axhline(0.5, color=N["muted"], ls=":", lw=1.0, zorder=2)
    ax.annotate(" half (a coin flip)", xy=(0.0, 0.5), xycoords=("axes fraction", "data"), va="center", fontsize=8, color=N["muted"])
    ax.set_ylim(0, 1.02)
    ax.set_xlabel("entry, in time order")
    ax.set_ylabel("share of entries that win")
    ax.legend(loc="lower right", fontsize=8, frameon=False)
    return fig


def rolling_pnl_fig(e, days, notes=None, question="Does the mean entry stay above zero?", win=30, window=None):
    """The mean net of the last `win` entries (a solid line in the model identity), the zero line in ink dotted."""
    net = np.asarray(e["net"], float)
    n = len(net)
    c = np.concatenate([[0.0], np.cumsum(net)])
    rm = (c[win:] - c[:-win]) / win
    x = np.arange(win, n + 1)
    notes = list(notes) if notes is not None else [f"Over {win} entries in a row the mean net runs from {float(rm.min()):+.2f} to {float(rm.max()):+.2f} USD; it is above zero in {int(np.sum(rm > 0))} of {len(rm)} windows."]
    fig, (ax,) = LF.frame(3.6, notes, question, window or _window_str(e, days))
    ax.plot(x, rm, color=MOD, lw=2.0, marker="o", ms=3, label=f"rolling mean net, {win} entries", zorder=4)
    LF.thresh(ax, 0.0, "zero")
    ax.set_xlabel("entry, in time order")
    ax.set_ylabel("mean net USD an entry")
    ax.legend(loc="upper right", fontsize=8, frameon=False)
    return fig


def entry_price_fig(e, days, notes=None, question="Do the entries that won buy cheaper than break-even?", be=0.607, window=None, s=52, edge=True):
    """Entry price against time: Up entries as ^ and Down as v, each green won / red lost, the break-even price in ink dotted, a legend for the markers and the sign.
    `s` is the marker area and `edge` draws the ink outline; a study with thousands of entries passes a smaller `s` and `edge=False` (the outline is most of the PNG)."""
    vwap = np.asarray(e["vwap"], float)
    side = np.asarray(e["side"], int)
    won = np.asarray(e["won"], bool)
    up = side > 0
    notes = list(notes) if notes is not None else [f"{int(up.sum())} Up and {int((~up).sum())} Down entries; {int(won.sum())} of {len(won)} won, break-even price {be:.0%}."]
    fig, (ax,) = LF.frame(3.6, notes, question, window or _window_str(e, days))
    x = _times(e)
    ek = dict(edgecolors=N["ink"], linewidths=0.8) if edge else dict(edgecolors="none")
    ax.scatter(x[up], vwap[up], marker="^", s=s, c=[GOOD if w else BAD for w in won[up]], zorder=4, **ek)
    ax.scatter(x[~up], vwap[~up], marker="v", s=s, c=[GOOD if w else BAD for w in won[~up]], zorder=4, **ek)
    LF.thresh(ax, be, f"break-even {be:.0%}")
    handles = [Line2D([], [], marker="^", linestyle="", color=N["muted"], label="Up entry"),
               Line2D([], [], marker="v", linestyle="", color=N["muted"], label="Down entry"),
               Patch(facecolor=GOOD, label="won"), Patch(facecolor=BAD, label="lost")]
    ax.set_ylim(0, 1)
    _fmt_time(ax, fig)
    ax.set_ylabel("price paid a share")
    ax.legend(handles=handles, loc="upper left", fontsize=8, ncol=4, frameon=False)
    return fig


def entry_exit_fig(e, days, notes=None, question="Where did each trade enter, and where did it resolve?", window=None):
    """Each trade as a stem from its entry price (a triangle, Up or Down) to its settlement (a dot at won $1 or lost $0), green won / red lost."""
    vwap = np.asarray(e["vwap"], float)
    side = np.asarray(e["side"], int)
    won = np.asarray(e["won"], bool)
    n = len(vwap)
    x = np.arange(n)
    notes = list(notes) if notes is not None else [f"{n} entries; {int(won.sum())} resolved $1, {int((~won).sum())} resolved $0."]
    fig, (ax,) = LF.frame(3.9, notes, question, window or _window_str(e, days))
    for i in range(n):
        ax.plot([x[i], x[i]], [vwap[i], 1.0 if won[i] else 0.0], color=GOOD if won[i] else BAD, lw=0.6, alpha=0.45, zorder=2)
    up = side > 0
    ax.scatter(x[up], vwap[up], marker="^", s=44, c=np.where(won[up], GOOD, BAD), zorder=4, edgecolors=N["ink"], linewidths=0.7)
    ax.scatter(x[~up], vwap[~up], marker="v", s=44, c=np.where(won[~up], GOOD, BAD), zorder=4, edgecolors=N["ink"], linewidths=0.7)
    ax.scatter(x, np.where(won, 1.0, 0.0), marker="o", s=30, c=np.where(won, GOOD, BAD), zorder=4, edgecolors=N["ink"], linewidths=0.7)
    ax.set_ylim(-0.06, 1.06)
    ax.set_yticks([0, 1])
    ax.set_yticklabels(["lost $0", "won $1"])
    ax.set_xlabel("entry, in time order")
    ax.set_ylabel("price at entry → settlement")
    return fig


# ============================================================ the figures' own check
def selftest() -> bool:
    """Build a small synthetic entries dict and render each figure, then run it through the figure-rules check. -> all ok?"""
    matplotlib_use = getattr(plt, "use", None)
    if matplotlib_use is not None:
        plt.use("Agg")
    LF.setup()
    rng = np.random.default_rng(0)
    n = 120
    days = ["2026-07-15", "2026-07-16", "2026-07-17"]
    day = np.repeat(np.arange(len(days)), n // len(days))
    slot = day * 96 + (np.arange(n) % (n // len(days))) * 2
    asset = rng.integers(0, 4, n)
    side = rng.choice([-1, 1], size=n)
    won = rng.random(n) < 0.55
    net = np.where(won, np.abs(rng.normal(0.9, 0.4, n)), -np.abs(rng.normal(0.8, 0.4, n)))
    vwap = np.clip(rng.normal(0.6, 0.15, n), 0.1, 0.95)
    e = dict(net=net, won=won, vwap=vwap, side=side, slot=slot, day=day, asset=asset)
    ok = True
    calls = [("equity_fig", lambda: equity_fig(e, days)),
             ("trade_pnl_fig", lambda: trade_pnl_fig(e, days)),
             ("rolling_winrate_fig", lambda: rolling_winrate_fig(e, days)),
             ("rolling_pnl_fig", lambda: rolling_pnl_fig(e, days)),
             ("entry_price_fig", lambda: entry_price_fig(e, days))]
    for name, make in calls:
        try:
            fig = make()
            fs.check(fig, name)
            plt.close(fig)
            print(f"  {'ok  ' if True else 'FAIL'} {name}")
        except Exception as exc:                                    # noqa: BLE001 - the self-test reports the first fault per figure
            ok = False
            print(f"  FAIL {name}: {exc}")
    return bool(ok)


if __name__ == "__main__":
    sys.exit(0 if selftest() else 1)


# ============================================================ the per-test figures of the six-test study (um-011)
import pandas as pd                                                  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap              # noqa: E402
import tf15_bt as B                                                  # noqa: E402

COINS = ("btc", "eth", "sol", "xrp")
COIN_COL = {"btc": fs.IDENTITY["BTC"], "eth": fs.IDENTITY["ETH"], "sol": fs.IDENTITY["SOL"], "xrp": fs.IDENTITY["XRP"]}
BIN, PM = LF.BIN, LF.PM


def _ci(e):
    return B.slot_boot(e["slot"], e["net"]) if len(e["net"]) else (np.nan, np.nan)


def coin_panels_fig(e, days, notes=None, question="Does every coin carry the edge, or one of them?", window=None, fees=True):
    """One row of four panels, one a coin, on one USD scale: the cumulative PnL over the coin's entries before the taker fee (solid, the coin's identity colour)
    and after it (ink, dotted), each path's total at its right end, the zero line. `fees=False` (or entries without a payoff and cost) draws the net alone, solid."""
    bul = notes
    if bul is None:
        bul = []
        for ai, c in enumerate(COINS):
            sub = B.subset(e, np.asarray(e["asset"]) == ai)
            n = len(sub["net"])
            if n == 0:
                bul.append(f"{c.upper()}: no entry.")
                continue
            lo, hi = _ci(sub)
            bul.append(f"{c.upper()}: {n} entries, {int(sub['won'].sum())} won ({sub['won'].mean():.0%}), net {sub['net'].sum():+.2f} USD, "
                       f"{sub['net'].mean():+.3f} an entry (95% by slot {lo:+.2f} to {hi:+.2f}).")
    fig, axes = LF.frame(3.3, bul, question, window or _window_str(e, days), ncols=4, wspace=0.12, axis_pad=0.95, sharey=True)
    with_gross = False
    for ai, c in enumerate(COINS):
        ax = axes[ai]
        sub = B.subset(e, np.asarray(e["asset"]) == ai)
        net = np.asarray(sub["net"], float)
        gross = gross_of(sub) if fees else None
        n = len(net)
        ax.set_title(f"{c.upper()} · {n:,} entries", fontsize=9.5, loc="left")
        if n:
            c_gr, c_net = fee_paths(ax, gross, net, COIN_COL[c], lw=1.7, dot_lw=1.3)
            with_gross = with_gross or c_gr is not None
            _end_labels(ax, [(c_gr, COIN_COL[c], ""), (c_net, INK, "")])
            ax.set_xlim(0, n * 1.22)
            ax.xaxis.set_major_locator(MaxNLocator(nbins=5, integer=True))
        else:
            ax.text(0.5, 0.75, "no entry", transform=ax.transAxes, ha="center", va="center", fontsize=9, color=N["muted"])
            ax.set_xticks([])
        LF.zero(ax)
        ax.set_xlabel("entry, in time order")
        if ai:
            ax.tick_params(labelleft=False)
    axes[0].set_ylabel("USD, cumulative")
    if with_gross:
        h = [tuple(Line2D([], [], color=COIN_COL[c], lw=1.7) for c in COINS), Line2D([], [], color=INK, lw=1.3, ls=DOT)]
        axes[0].legend(h, [LBL_GROSS + " (each coin in its own colour)", LBL_NET], handler_map={tuple: HandlerTuple(ndivide=None, pad=0.0)}, handlelength=4.0,
                       loc="upper left", bbox_to_anchor=(0.0, -0.2), ncol=2, fontsize=8, frameon=False)      # under the row, never on the data
    return fig


PRICE_EDGES = (0.0, 0.30, 0.50, 0.70, 0.85, 1.0001)
PRICE_LABELS = ("<0.30", "0.30-0.50", "0.50-0.70", "0.70-0.85", "0.85+")


def price_buckets(e):
    """Per price-paid bucket: n, mean net and its slot interval, win rate and its Wilson interval, the bucket's break-even (cost + fee a share), the bucket's net."""
    vwap, net, won, slot = (np.asarray(e[k_]) for k_ in ("vwap", "net", "won", "slot"))
    idx = np.clip(np.searchsorted(PRICE_EDGES, vwap, side="right") - 1, 0, len(PRICE_LABELS) - 1)
    rows = []
    for b in range(len(PRICE_LABELS)):
        m = idx == b
        n = int(m.sum())
        if n == 0:
            rows.append(dict(bucket=PRICE_LABELS[b], n=0, per=np.nan, lo=np.nan, hi=np.nan, win=np.nan, wlo=np.nan, whi=np.nan, be=np.nan, net=0.0))
            continue
        lo, hi = B.slot_boot(slot[m], net[m])
        wl, wh = B.wilson(int(won[m].sum()), n)
        be = float((np.asarray(e["cost"])[m] + np.asarray(e["fee"])[m]).sum() / np.asarray(e["shares"])[m].sum())
        rows.append(dict(bucket=PRICE_LABELS[b], n=n, per=float(net[m].mean()), lo=lo, hi=hi, win=float(won[m].mean()), wlo=wl, whi=wh, be=be, net=float(net[m].sum())))
    return pd.DataFrame(rows)


def winloss_fig(e, days, notes=None, question="What do the winners and the losers look like, at which prices do they sit, and do a few wins carry everything?", window=None):
    """Top row: the distribution of net an entry (won green, lost red); the mean net by price paid with its slot interval; the win rate by price paid (Wilson 95%) against
    the bucket's own break-even (an ink dotted path). Bottom row: each trade's own reward to risk (what it pays if it wins over the most it can lose, log scale, won green,
    lost red, even money as the decision line); the cumulative net with every entry against the same book without its best 5% of entries; the net an entry with the best 1%,
    5% and 10% of entries taken out, green or red by sign."""
    net, won = np.asarray(e["net"], float), np.asarray(e["won"], bool)
    n = len(net)
    PB = price_buckets(e)
    S = B.summarize(e)
    srt_idx = np.argsort(net)[::-1]
    k5 = max(1, int(np.ceil(0.05 * n)))
    top5, tot = float(net[srt_idx[:k5]].sum()), float(net.sum())
    share = ("more than the whole total" if top5 > tot > 0 else f"{top5 / tot:.0%} of the total" if tot > 0 else "against a total that is not positive")
    best = PB.dropna(subset=["per"]).sort_values("per", ascending=False)
    risk = np.asarray(e["cost"], float) + np.asarray(e["fee"], float)
    rr_t = (np.asarray(e["shares"], float) - risk) / np.maximum(risk, 1e-9)
    bul = notes if notes is not None else [
        f"{n} entries: {int(won.sum())} won (mean {net[won].mean():+.2f} USD, median {np.median(net[won]):+.2f}), {int((~won).sum())} lost "
        f"(mean {net[~won].mean():+.2f}, median {np.median(net[~won]):+.2f}); largest win {net.max():+.2f}, largest loss {net.min():+.2f}.",
        f"Win rate {S['win']:.1%} (Wilson 95% {S['win_lo']:.1%} to {S['win_hi']:.1%}) against the {S['win_needed']:.1%} this payoff needs; reward to risk {S['rr']:.2f} "
        f"(mean win over mean loss), profit factor {S['pf']:.2f}; each trade's own reward to risk averages {S['rr_trade_mean']:.2f} (median {S['rr_trade_median']:.2f}).",
        f"The best 5% of entries ({k5}) made {top5:+.2f} USD, {share} of {tot:+.2f}; without them the net is {S['per_ex_top5']:+.3f} an entry "
        f"(95% by slot {S.get('per_ex_top5_lo', np.nan):+.2f} to {S.get('per_ex_top5_hi', np.nan):+.2f}, {S.get('p_ex_top5_le0', np.nan):.0%} of the resamples at or below zero; "
        f"without the best 1% {S['per_ex_top1']:+.3f}, without the best 10% {S['per_ex_top10']:+.3f}): "
        + ("the edge survives without its best wins." if S.get("per_ex_top5_lo", np.nan) > 0 else
           "the interval reaches zero, so the edge rests on its tail wins." if S["per"] > 0 else "there is no edge to carry."),
        f"By price paid the strongest bucket is {best.iloc[0]['bucket']} ({best.iloc[0]['per']:+.3f} an entry on {int(best.iloc[0]['n'])}, 95% by slot {best.iloc[0]['lo']:+.2f} to "
        f"{best.iloc[0]['hi']:+.2f}); the weakest is {best.iloc[-1]['bucket']} ({best.iloc[-1]['per']:+.3f} on {int(best.iloc[-1]['n'])}).",
    ]
    fig, axes = LF.frame(7.6, bul, question, window or _window_str(e, days), ncols=3, nrows=2, wspace=0.3, hspace=0.5)
    a1, a2, a3, a4, a5, a6 = axes
    lo_, hi_ = float(net.min()), float(net.max())
    bins = np.linspace(lo_, hi_ if hi_ > lo_ else lo_ + 1.0, 41)
    a1.hist(net[won], bins=bins, color=GOOD, alpha=0.85, label="won")
    a1.hist(net[~won], bins=bins, color=BAD, alpha=0.85, label="lost")
    a1.axvline(0, color=N["axis"], lw=1.0)
    a1.set_title("net an entry, won and lost", fontsize=9.5, loc="left")
    a1.set_xlabel("net USD an entry")
    a1.set_ylabel("entries")
    a1.legend(loc="upper right", fontsize=8, frameon=False)
    x = np.arange(len(PB))
    per = PB["per"].to_numpy()
    ok = np.isfinite(per)
    a2.bar(x[ok], per[ok], color=[GOOD if v >= 0 else BAD for v in per[ok]], zorder=3)
    a2.errorbar(x[ok], per[ok], yerr=[per[ok] - PB["lo"].to_numpy()[ok], PB["hi"].to_numpy()[ok] - per[ok]], fmt="none", color=N["ink"], ecolor=N["ink"], elinewidth=1.0, capsize=3, zorder=4)
    ymax = float(np.nanmax(PB["hi"].to_numpy())) if ok.any() else 1.0
    for i_, r in PB.iterrows():
        a2.text(i_, ymax, f"n={int(r['n'])}", ha="center", va="bottom", fontsize=7.5, color=N["ink2"])
    LF.zero(a2)
    a2.set_xticks(x)
    a2.set_xticklabels(PRICE_LABELS, fontsize=8)
    a2.set_title("mean net by price paid (95% by slot)", fontsize=9.5, loc="left")
    a2.set_xlabel("price paid a share")
    a2.set_ylabel("mean net USD an entry")
    win = PB["win"].to_numpy()
    a3.errorbar(x[ok], win[ok], yerr=[win[ok] - PB["wlo"].to_numpy()[ok], PB["whi"].to_numpy()[ok] - win[ok]], fmt="o", color=MOD, ecolor=MOD, capsize=3,
                label="win rate (95% Wilson)", zorder=4)
    a3.plot(x[ok], PB["be"].to_numpy()[ok], color=N["ink"], ls=":", lw=1.3, marker="_", ms=14, label="break-even: price paid + fee", zorder=3)
    a3.set_ylim(0, 1.02)
    a3.set_xticks(x)
    a3.set_xticklabels(PRICE_LABELS, fontsize=8)
    a3.set_title("win rate against break-even, by price paid", fontsize=9.5, loc="left")
    a3.set_xlabel("price paid a share")
    a3.set_ylabel("share of entries that win")
    a3.legend(loc="lower right", fontsize=8, frameon=False)
    # each trade's own reward to risk
    xi = np.arange(n)
    a4.scatter(xi, np.maximum(rr_t, 1e-3), s=9, c=[GOOD if w_ else BAD for w_ in won], edgecolors="none", zorder=4)
    a4.set_yscale("log")
    a4.axhline(1.0, color=N["ink"], ls=":", lw=1.3, zorder=3)
    a4.text(0, 1.0, " even money", va="bottom", ha="left", fontsize=8, color=N["ink"])
    a4.set_title(f"each trade's reward to risk, mean {S['rr_trade_mean']:.2f}, median {S['rr_trade_median']:.2f}", fontsize=9.5, loc="left")
    a4.set_xlabel("entry, in time order")
    a4.set_ylabel("pays if won / loses if lost")
    # the book with and without its best 5%
    keep = np.ones(n, bool)
    keep[srt_idx[:k5]] = False
    lev_all = np.concatenate([[0.0], np.cumsum(net)])
    lev_ex = np.concatenate([[0.0], np.cumsum(np.where(keep, net, 0.0))])
    a5.step(np.arange(n + 1), lev_all, where="post", color=MOD, lw=1.6, label="every entry", zorder=4)
    a5.step(np.arange(n + 1), lev_ex, where="post", color=N["ink2"], lw=1.6, label=f"without the best 5% ({k5} entries)", zorder=4)
    LF.zero(a5)
    a5.set_title("cumulative net, with and without the best 5%", fontsize=9.5, loc="left")
    a5.set_xlabel("entry, in time order")
    a5.set_ylabel("USD")
    a5.legend(loc="upper left", fontsize=8, frameon=False)
    # the net an entry with the best entries taken out
    trims = [("all", S["per"]), ("ex best 1%", S["per_ex_top1"]), ("ex best 5%", S["per_ex_top5"]), ("ex best 10%", S["per_ex_top10"])]
    vals = np.array([v for _, v in trims], float)
    a6.bar(np.arange(4), vals, color=[GOOD if v >= 0 else BAD for v in vals], zorder=3)
    for i_, v in enumerate(vals):
        a6.text(i_, v, f"{v:+.2f}", ha="center", va="bottom" if v >= 0 else "top", fontsize=8, color=N["ink2"])
    LF.zero(a6)
    a6.set_xticks(np.arange(4))
    a6.set_xticklabels([t for t, _ in trims], fontsize=8)
    a6.set_title("net an entry with the best entries taken out", fontsize=9.5, loc="left")
    a6.set_ylabel("net USD an entry")
    return fig


def _frame_token(tab, w, side):
    """The window's book in the TRADED token's frame: best ask, best bid, fair value (NK,) and the fill ladder (4, NK, L) as bid px, bid sz, ask px, ask sz.
    The Down token is the venue's mirror of the Up book: a Down ask at 1 - an Up bid (same size), a Down bid at 1 - an Up ask."""
    qa, qb, pu = tab.qa[w].astype(float), tab.qb[w].astype(float), tab.pu[w].astype(float)
    lad = tab.lad[w].astype(float)
    if side > 0:
        return qa, qb, pu, lad
    return 1.0 - qb, 1.0 - qa, 1.0 - pu, np.stack([1.0 - lad[2], lad[3], 1.0 - lad[0], lad[1]])


def depth_cells(lad, bins=100):
    """(NK, bins) resting size a 1-cent price bin from a fill ladder (4, NK, L): both sides, every level."""
    NK = lad.shape[1]
    cell = np.zeros((NK, bins))
    for lv in range(lad.shape[2]):
        for pxs, szs in ((lad[0, :, lv], lad[1, :, lv]), (lad[2, :, lv], lad[3, :, lv])):
            ok = np.isfinite(pxs) & np.isfinite(szs) & (szs > 0)
            b = np.clip(np.floor(pxs[ok] * bins + 1e-9).astype(int), 0, bins - 1)
            np.add.at(cell, (np.flatnonzero(ok), b), szs[ok])
    return cell


def anatomy_fig(tab, e, i, days, question, notes=None, usd=20.0):
    """One entry from the Binance print to the settlement, in the traded token's frame: the Binance mid against the price to beat (top), the token's ask, bid and
    driftless fair value with the entry (a triangle pointing the way it bets) and the settlement square (middle), and the resting size of the fill ladder through
    the window, grey by size (bottom)."""
    w, k, side = int(e["w"][i]), int(e["k"][i]), int(e["side"][i])
    coin = COINS[int(e["asset"][i])]
    ask, bid, fair, lad = _frame_token(tab, w, side)
    sec = np.arange(B.K0, B.K0 + tab.NK).astype(float)
    kd = B.K0 + k
    path = tab.path[w].astype(float)
    xpath = np.arange(-60, 901)
    ref = float(tab.w_ptb[w]) if np.isfinite(tab.w_ptb[w]) else float(tab.w_a0[w])
    start = datetime.fromtimestamp(int(tab.w_start[w]) // 1000, tz=timezone.utc)
    z = float(tab.zl[w, k, 0])
    won, net = bool(e["won"][i]), float(e["net"][i])
    move_bp = (float(tab.S[w, k]) / float(tab.w_a0[w]) - 1.0) * 1e4
    tok = "Up" if side > 0 else "Down"
    leg = int(e["leg"][i]) if "leg" in e else 0
    vwap, shares, cost, fee = float(e["vwap"][i]), float(e["shares"][i]), float(e["cost"][i]), float(e["fee"][i])
    if leg == 1:
        how = (f"This was a SALE of the far {'Down' if side > 0 else 'Up'} token for {usd:g} USD at its bid: {shares:.2f} shares minted and sold at {1 - vwap:.3f}, "
               f"so the position was long {shares:.2f} {tok} at {vwap:.3f} with {cost:.2f} USD of collateral at risk, {cost / usd:.1f}x the clip.")
    else:
        how = f"The fill 150 ms later paid {vwap:.3f} a share for {shares:.2f} shares (cost {cost:.2f} USD, fee {fee:.2f}), never above the {ask[k]:.2f} ask seen at the decision."
    why = f"The size of the result is the position times the distance to settlement: {shares:.2f} shares x {(1 - vwap) if won else -vwap:+.3f} a share, less the {fee:.2f} fee."
    bul = notes if notes is not None else [
        f"{coin.upper()} window starting {start:%Y-%m-%d %H:%M} UTC; decision at second {kd} ({int(e['T'][i])} s left), Binance 10 s z {z:+.1f}, "
        f"the mid {move_bp:+.0f} bp from the window's start.",
        f"The {tok} token asked {ask[k]:.2f} and bid {bid[k]:.2f} against a driftless fair value of {fair[k]:.3f} (ask minus fair {ask[k] - fair[k]:+.3f}). {how}",
        f"It {'won: every share paid 1 USD' if won else 'lost: every share paid 0'}; net {net:+.2f} USD. {why}",
    ]
    win_s = f"{start:%Y-%m-%d %H:%M} UTC · one 15-minute window (0.25h) · {coin.upper()} · study window {days[0][5:]} to {days[-1][5:]}, {24 * len(days):,}h"
    fig, (a1, a2, a3) = LF.frame(8.6, bul, question, win_s, nrows=3, hspace=0.55)
    mk = "^" if side > 0 else "v"
    shade = GOOD if won else BAD
    a1.plot(xpath, path, color=BIN, lw=1.5, label="Binance mid (1 s)", zorder=3)
    a1.axhline(ref, color=N["ink"], ls=":", lw=1.3, zorder=3)
    a1.annotate(f"price to beat {ref:,.2f}", (900, ref), xytext=(-4, 3), textcoords="offset points", ha="right", va="bottom", fontsize=8, color=N["ink"])
    a1.axvline(kd, color=N["ink"], lw=0.9, zorder=2)
    a1.axvspan(kd, 900, color=shade, alpha=0.10, lw=0, zorder=1)
    a1.scatter([kd], [path[60 + kd]], marker=mk, s=95, color=N["ink"], zorder=6, label=f"decision: buy {tok}")
    a1.set_title("Binance", fontsize=9.5, loc="left")
    a1.set_ylabel("USD")
    a1.legend(loc="upper center", bbox_to_anchor=(0.5, -0.14), ncol=2, fontsize=8, frameon=False)      # under the panel, never on the data
    a2.plot(sec, ask, color=PM, lw=1.5, label=f"{tok} best ask", zorder=3)
    a2.plot(sec, bid, color=N["ink2"], lw=1.2, label=f"{tok} best bid", zorder=3)
    a2.plot(sec, fair, color=MOD, lw=1.5, label="driftless fair value", zorder=3)
    a2.axvspan(kd, 900, color=shade, alpha=0.10, lw=0, zorder=1)
    a2.axvline(kd, color=N["ink"], lw=0.9, zorder=2)
    a2.scatter([kd], [vwap], marker=mk, s=120, color=N["ink"], zorder=6, label=f"paid {vwap:.3f} a share")
    a2.scatter([sec[-1]], [1.0 if won else 0.0], marker="s", s=70, color=shade, zorder=6, edgecolors=N["ink"], linewidths=0.7, label="settled")
    a2.set_ylim(0, 1)
    a2.set_title(f"the {tok} token on Polymarket", fontsize=9.5, loc="left")
    a2.set_ylabel("price a share")
    a2.legend(loc="upper center", bbox_to_anchor=(0.5, -0.14), ncol=5, fontsize=8, frameon=False)      # under the panel, never on the data
    cell = depth_cells(lad)
    grey = LinearSegmentedColormap.from_list("grey", [N["surface"], N["grid"], N["axis"], N["muted"], N["ink2"], N["ink"]])
    vmax = float(np.percentile(cell[cell > 0], 95)) if (cell > 0).any() else 1.0
    a3.imshow(cell.T, origin="lower", aspect="auto", cmap=grey, vmin=0.0, vmax=vmax, extent=[sec[0], sec[-1], 0.0, 1.0], interpolation="nearest", zorder=2)
    mid = (ask + bid) / 2.0
    okm = np.isfinite(mid)
    a3.plot(sec[okm], mid[okm], color=N["ink"], lw=1.1, ls=(0, (1, 2.4)), zorder=4)
    if okm.any():
        a3.annotate("mid", (sec[okm][-1], mid[okm][-1]), xytext=(-6, 8), textcoords="offset points", ha="right", fontsize=8, color=N["ink"])
    a3.scatter([kd], [vwap], marker=mk, s=120, color=N["ink"], zorder=6)
    a3.set_ylim(0, 1)
    a3.set_title("resting size on the fill ladder (4 levels a side), grey by size", fontsize=9.5, loc="left")
    a3.set_xlabel("seconds into the window")
    a3.set_ylabel("price a share")
    a3.grid(False)
    for a_ in (a1, a2, a3):
        a_.set_xlim(-60, 900)
    return fig


def ladder_table(tab, e, i, usd=20.0):
    """The fill ladder of one entry in the traded token's frame, with the shares the walk took at each level. -> (DataFrame, caption)."""
    w, k, side = int(e["w"][i]), int(e["k"][i]), int(e["side"][i])
    ask, bid, fair, lad = _frame_token(tab, w, side)
    leg = int(e["leg"][i]) if "leg" in e else 0
    bpx, bsz, apx, asz = lad[0, k], lad[1, k], lad[2, k], lad[3, k]
    if leg == 0:
        take = B.buy_levels(apx, asz, usd, float(ask[k]))
        paid = take * np.nan_to_num(apx)
        how = f"a buy of {usd:g} USD of {'Up' if side > 0 else 'Down'} at no worse than the {ask[k]:.2f} ask seen at the decision"
    else:
        far_bid = 1.0 - apx                                     # the far token's bids are the mirror of the near token's asks
        want = np.floor(usd / far_bid[0] * 100.0) / 100.0 if np.isfinite(far_bid[0]) and far_bid[0] > 0 else 0.0
        take = B.sell_levels(far_bid, asz, want, floor=1.0 - float(ask[k]))
        paid = take * np.nan_to_num(apx)                        # the collateral left at risk a level: shares x (1 - sale price)
        how = (f"a sale of {usd:g} USD of the far {'Down' if side > 0 else 'Up'} token at no worse than its {1 - ask[k]:.2f} bid seen at the decision "
               f"(shown as the near token bought at 1 - the sale price)")
    df = pd.DataFrame(dict(level=np.arange(1, len(apx) + 1), bid_size=bsz, bid=bpx, ask=apx, ask_size=asz, taken_shares=take, usd_at_risk=paid))
    cap = (f"Fill ladder at second {B.K0 + k} + 150 ms, {COINS[int(e['asset'][i])].upper()} {'Up' if side > 0 else 'Down'} token: {how}; "
           f"fair value {fair[k]:.3f}; took {take.sum():.2f} shares for {paid.sum():.2f} USD at risk.")
    return df, cap


def compare_fig(rows, days, notes, question="Which expression of the thesis pays, and which does not?", window=None):
    """Left: the net an entry of each test with its 95% slot interval (green gain, red loss). Right: the same on the first and second halves of the window
    (ink2 circles, ink squares)."""
    labels = [r["label"] for r in rows]
    x = np.arange(len(rows))
    per = np.array([r["per"] for r in rows], float)
    lo = np.array([r["lo"] for r in rows], float)
    hi = np.array([r["hi"] for r in rows], float)
    fig, (a1, a2) = LF.frame(4.4, notes, question, window or f"{days[0][5:]} to {days[-1][5:]} · {24 * len(days):,}h · {len(days)} days", ncols=2, wspace=0.22)
    a1.bar(x, per, color=[GOOD if v >= 0 else BAD for v in per], zorder=3)
    a1.errorbar(x, per, yerr=[per - lo, hi - per], fmt="none", color=N["ink"], ecolor=N["ink"], elinewidth=1.1, capsize=4, zorder=4)
    for i_, r in enumerate(rows):
        a1.text(i_, max(hi[i_], 0) + 0.04, f"n={r['n']}", ha="center", va="bottom", fontsize=8, color=N["ink2"])
    LF.zero(a1)
    a1.set_xticks(x)
    a1.set_xticklabels(labels)
    a1.set_title("net an entry, whole window (95% by slot)", fontsize=9.5, loc="left")
    a1.set_ylabel("net USD an entry")
    f1 = np.array([r["per_first"] for r in rows], float)
    f2 = np.array([r["per_second"] for r in rows], float)
    a2.scatter(x - 0.12, f1, marker="o", s=55, color=N["ink2"], zorder=4, label="first half")
    a2.scatter(x + 0.12, f2, marker="s", s=55, color=N["ink"], zorder=4, label="second half")
    for i_ in range(len(rows)):
        a2.plot([x[i_] - 0.12, x[i_] + 0.12], [f1[i_], f2[i_]], color=N["axis"], lw=1.0, zorder=3)
    LF.zero(a2)
    a2.set_xticks(x)
    a2.set_xticklabels(labels)
    a2.set_title("net an entry, first half against second half", fontsize=9.5, loc="left")
    a2.set_ylabel("net USD an entry")
    a2.legend(loc="best", fontsize=8, frameon=False)
    return fig


def daily_fig(ents: dict, days, notes=None, question="Which days carried each test, and how bad was the worst?", window=None):
    """Six panels, one a test: the day's net as a bar (green gain, red loss) over the window, the worst day labelled."""
    nd = len(days)
    bul = notes
    if bul is None:
        bul = []
        for lab, e in ents.items():
            d = np.bincount(np.asarray(e["day"], int), weights=np.asarray(e["net"], float), minlength=nd) if len(e["net"]) else np.zeros(nd)
            eq = np.cumsum(d)
            dd = float((np.maximum.accumulate(np.concatenate([[0.0], eq]))[1:] - eq).max())
            bul.append(f"{lab}: worst day {days[int(np.argmin(d))]} at {d.min():+.0f} USD, {int((d < 0).sum())} of {nd} days lost, peak-to-trough on daily closes {dd:.0f} USD.")
    nrow = max(1, int(np.ceil(len(ents) / 2)))
    fig, axes = LF.frame(2.4 * nrow, bul, question, window or f"{days[0][5:]} to {days[-1][5:]} · {24 * nd:,}h · {nd} days", ncols=2, nrows=nrow, hspace=0.55, wspace=0.16)
    x = np.arange(nd)
    for ax in axes[len(ents):]:
        ax.axis("off")
    for ax, (lab, e) in zip(axes, ents.items()):
        d = np.bincount(np.asarray(e["day"], int), weights=np.asarray(e["net"], float), minlength=nd) if len(e["net"]) else np.zeros(nd)
        ax.bar(x, d, color=[GOOD if v >= 0 else BAD for v in d], zorder=3)
        j = int(np.argmin(d))
        ax.annotate(f"{d[j]:+.0f}", (j, d[j]), xytext=(0, -10), textcoords="offset points", ha="center", va="top", fontsize=7.5, color=N["ink"])
        LF.zero(ax)
        ax.set_title(f"{lab} · net by UTC day, total {d.sum():+.0f} USD", fontsize=9.5, loc="left")
        ax.set_xticks(x[::3])
        ax.set_xticklabels([days[i_][5:] for i_ in x[::3]], fontsize=7.5)
        ax.set_ylabel("USD")
    return fig


def winrate_rr_fig(rows, days, notes, question="Does each test win often enough for the size of its wins against its losses?", window=None):
    """Left: each test's win rate with its Wilson 95% interval (the model identity) against the win rate its own payoff needs to break even
    (|mean loss| / (mean win + |mean loss|), an ink dotted path). Right: reward to risk (mean win over mean loss) as a bar, green where the win rate
    clears the needed rate and red where it does not, the profit factor written over each bar, even money as the decision line."""
    labels = [r["label"] for r in rows]
    x = np.arange(len(rows))
    win = np.array([r["win"] for r in rows], float)
    wlo = np.array([r["win_lo"] for r in rows], float)
    whi = np.array([r["win_hi"] for r in rows], float)
    need = np.array([r["win_needed"] for r in rows], float)
    rr = np.array([r["rr"] for r in rows], float)
    pf = np.array([r["pf"] for r in rows], float)
    per = np.array([r["per"] for r in rows], float)
    ex5 = np.array([r["per_ex_top5"] for r in rows], float)
    rrt = np.array([r["rr_trade_mean"] for r in rows], float)
    fig, (a1, a2, a3) = LF.frame(4.4, notes, question, window or f"{days[0][5:]} to {days[-1][5:]} · {24 * len(days):,}h · {len(days)} days", ncols=3, wspace=0.3)
    a3.bar(x, ex5, color=[GOOD if v >= 0 else BAD for v in ex5], zorder=3, label="without the best 5% of entries")
    a3.scatter(x, per, marker="o", s=40, color=N["ink"], zorder=5, label="every entry")
    for i_ in range(len(rows)):
        a3.text(i_, min(ex5[i_], 0) - 0.04, f"RR/trade {rrt[i_]:.2f}", ha="center", va="top", fontsize=7.5, color=N["ink2"])
    LF.zero(a3)
    a3.set_xticks(x)
    a3.set_xticklabels(labels)
    a3.set_title("net an entry without the best 5% (dot: with every entry)", fontsize=9.5, loc="left")
    a3.set_ylabel("net USD an entry")
    a3.legend(loc="lower left", fontsize=8, frameon=False)
    a1.errorbar(x, win, yerr=[win - wlo, whi - win], fmt="o", color=MOD, ecolor=MOD, capsize=4, label="win rate (95% Wilson)", zorder=4)
    a1.plot(x, need, color=N["ink"], ls=":", lw=1.3, marker="_", ms=16, label="win rate needed at this reward to risk", zorder=3)
    a1.set_ylim(0, 1.0)
    a1.set_xticks(x)
    a1.set_xticklabels(labels)
    a1.set_title("win rate against the rate the payoff needs", fontsize=9.5, loc="left")
    a1.set_ylabel("share of entries that win")
    a1.legend(loc="lower left", fontsize=8, frameon=False)
    a2.bar(x, rr, color=[GOOD if w_ > n_ else BAD for w_, n_ in zip(win, need)], zorder=3)
    for i_ in range(len(rows)):
        a2.text(i_, rr[i_] + 0.02, f"PF {pf[i_]:.2f}", ha="center", va="bottom", fontsize=8, color=N["ink2"])
    a2.axhline(1.0, color=N["ink"], ls=":", lw=1.3, zorder=3)
    a2.text(-0.4, 1.0, " even money", va="bottom", ha="left", fontsize=8, color=N["ink"])
    a2.set_ylim(0, max(float(np.nanmax(rr)) * 1.25, 1.2))
    a2.set_xticks(x)
    a2.set_xticklabels(labels)
    a2.set_title("reward to risk, mean win over mean loss (green: win rate above the rate needed)", fontsize=9.5, loc="left")
    a2.set_ylabel("mean win / mean loss")
    return fig


# ============================================================ the deep-dive grid figures (um-014, um-015)
def dimension_fig(cells, dims, chosen, days_txt, notes, score_key="per_ex_top5", score_label="net an entry without the best 5%, USD",
                  question="Which settings of each dimension earn, on the train days and on the validation days?"):
    """One panel a grid dimension: the mean score over every cell sharing a level, on the train days (ink2 circles) and the validation days (ink squares),
    the chosen cell's level shaded gold, zero as the decision line. A dimension whose levels all sit below zero on both sides is one the grid cannot rescue."""
    rows = [{**c["cfg"], "train": c["train"].get(score_key, np.nan), "validate": c["validate"].get(score_key, np.nan)} for c in cells]
    df = pd.DataFrame(rows)
    ncol = 4
    nrow = int(np.ceil(len(dims) / ncol))
    fig, axes = LF.frame(2.9 * nrow, notes, question, days_txt, ncols=ncol, nrows=nrow, hspace=0.6, wspace=0.28)
    for ax, d in zip(axes, dims):
        lv = list(dict.fromkeys(df[d].tolist()))
        lv = sorted(lv, key=lambda v: (isinstance(v, str), v))
        x = np.arange(len(lv))
        tr = np.array([df.loc[df[d] == v, "train"].mean() for v in lv], float)
        va = np.array([df.loc[df[d] == v, "validate"].mean() for v in lv], float)
        j = lv.index(chosen[d])
        ax.axvspan(j - 0.4, j + 0.4, color=fs.TABLE["gold"], lw=0, zorder=1)
        ax.scatter(x, tr, marker="o", s=42, color=N["ink2"], zorder=4, label="train days")
        ax.scatter(x, va, marker="s", s=42, color=N["ink"], zorder=4, label="validation days")
        ax.plot(x, tr, color=N["ink2"], lw=1.0, zorder=3)
        ax.plot(x, va, color=N["ink"], lw=1.0, zorder=3)
        LF.zero(ax)
        ax.set_xticks(x)
        ax.set_xticklabels([str(v) for v in lv], fontsize=8)
        ax.set_title(f"{d} (chosen {chosen[d]})", fontsize=9.5, loc="left")
        ax.set_ylabel(score_label, fontsize=8)
    for ax in axes[len(dims):]:
        ax.axis("off")
    axes[0].legend(loc="best", fontsize=8, frameon=False)
    return fig


def tradeoff_fig(cells, chosen, days_txt, notes, score_key="per_ex_top5", score_label="net an entry without the best 5%, USD",
                 question="Do the cells that earn on the train days earn on the validation days too?"):
    """Every cell as a dot at (train score, validation score); the chosen cell as a magenta star; zero on both axes. Dots in the top-right quadrant earned on both."""
    tr = np.array([c["train"].get(score_key, np.nan) for c in cells], float)
    va = np.array([c["validate"].get(score_key, np.nan) for c in cells], float)
    names = [c["cfg"]["name"] for c in cells]
    j = names.index(chosen["name"])
    fig, (ax,) = LF.frame(4.6, notes, question, days_txt)
    ax.scatter(tr, va, s=12, color=N["ink2"], alpha=0.55, edgecolors="none", zorder=3, label="a cell of the grid")
    ax.scatter([tr[j]], [va[j]], s=160, marker="*", color=MOD, zorder=5, edgecolors=N["ink"], linewidths=0.6, label=f"chosen: {chosen['name']}")
    ax.axhline(0, color=N["axis"], lw=1.0)
    ax.axvline(0, color=N["axis"], lw=1.0)
    ax.set_xlabel(f"train days: {score_label}")
    ax.set_ylabel(f"validation days: {score_label}")
    ax.legend(loc="best", fontsize=8, frameon=False)
    return fig


# ============================================================ the loss anatomy figures (um-016)
def mae_mfe_fig(mae, mfe, net, days, notes, question="How far did each trade run for and against before it closed?", window=None):
    """The chart bank's MAE/MFE: each trade a dot at its worst mark across and its best mark up (USD on the position, marks on the near bid), green if it closed
    positive and red if not, the diagonal where the peak equals the trough as an ink dotted line, zero lines, equal limits."""
    mae, mfe, net = (np.asarray(a, float) for a in (mae, mfe, net))
    fig, (ax,) = LF.frame(5.0, notes, question, window or f"{days[0][5:]} to {days[-1][5:]} · {24 * len(days):,}h · {len(days)} days")
    lim = max(float(np.abs(mae).max()), float(np.abs(mfe).max()), 1.0) * 1.08
    ax.scatter(mae, mfe, s=18, c=[GOOD if g > 0 else BAD for g in net], alpha=0.7, edgecolors="none", zorder=3)
    ax.plot([-lim, 0], [lim, 0], color=N["ink"], lw=1.2, ls=":")
    ax.text(-lim * 0.97, lim * 0.97, "peak = trough ", ha="right", va="top", fontsize=8.5, color=N["ink"])
    ax.axhline(0, color=N["axis"], lw=1); ax.axvline(0, color=N["axis"], lw=1)
    ax.set_xlim(-lim, lim); ax.set_ylim(-lim, lim)
    ax.set_xlabel("maximum adverse excursion, USD (the worst the near bid marked the position)")
    ax.set_ylabel("maximum favourable excursion, USD")
    ax.legend(handles=[Patch(facecolor=GOOD, alpha=0.7, label="closed green"), Patch(facecolor=BAD, alpha=0.7, label="closed red")], loc="lower right", fontsize=8.5, frameon=False)
    return fig


def split_fig(tables: dict, days, notes, question="Where do the losses sit: by time of day, time left, price paid, spread and burst size?", window=None):
    """One panel a split: the mean net an entry by bucket as bars (green gain, red loss) with the entry count over each; `tables` maps a panel caption to a
    DataFrame with columns bucket, n, per (from a groupby). Up to eight panels, two rows."""
    names = list(tables)
    ncol = 4
    nrow = int(np.ceil(len(names) / ncol))
    fig, axes = LF.frame(2.9 * nrow, notes, question, window or f"{days[0][5:]} to {days[-1][5:]} · {24 * len(days):,}h · {len(days)} days", ncols=ncol, nrows=nrow, hspace=0.7, wspace=0.28)
    for ax, name in zip(axes, names):
        t = tables[name]
        x = np.arange(len(t))
        per = t["per"].to_numpy(float)
        ax.bar(x, per, color=[GOOD if v >= 0 else BAD for v in per], zorder=3)
        top = float(np.nanmax(per)) if len(per) else 0.0
        for i_, n_ in enumerate(t["n"].to_numpy()):
            ax.text(i_, max(top, 0) + 0.05, f"n={int(n_)}", ha="center", va="bottom", fontsize=7, color=N["ink2"])
        LF.zero(ax)
        ax.set_xticks(x)
        ax.set_xticklabels([str(b) for b in t["bucket"]], fontsize=7, rotation=30, ha="right")
        ax.set_title(name, fontsize=9.5, loc="left")
        ax.set_ylabel("net USD an entry", fontsize=8)
    for ax in axes[len(names):]:
        ax.axis("off")
    return fig


# ============================================================ steady or jumpy (um-020)
def steady_fig(curves: dict, days, notes, question="Which variant climbs steadily, and which jumps?", window=None):
    """Small multiples, one a variant: the cumulative net stepped (the model identity) with its straight-line fit (ink dotted), the drawdown shaded red,
    the caption carrying the line's r2, the share of trading days above zero and the deepest drawdown. `curves` maps a caption to an entries dict and its
    summary: {label: (e, s)}."""
    names = list(curves)
    ncol = 3
    nrow = int(np.ceil(len(names) / ncol))
    fig, axes = LF.frame(2.9 * nrow, notes, question, window or f"{days[0][5:]} to {days[-1][5:]} · {24 * len(days):,}h · {len(days)} days", ncols=ncol, nrows=nrow, hspace=0.62, wspace=0.22)
    for ax, name in zip(axes, names):
        e, s = curves[name]
        net = np.asarray(e["net"], float)
        n = len(net)
        levels = np.concatenate([[0.0], np.cumsum(net)])
        xx = np.arange(n + 1)
        peak = np.maximum.accumulate(levels)
        ax.step(xx, levels, where="post", color=MOD, lw=1.5, zorder=4)
        ax.fill_between(xx, levels, peak, step="post", color=BAD, alpha=0.18, lw=0, zorder=2)
        if n >= 3:
            x = np.arange(1, n + 1, dtype=float)
            slope, icpt = np.polyfit(x, levels[1:], 1)
            ax.plot(x, slope * x + icpt, color=N["ink"], lw=1.1, ls=(0, (1, 2.4)), zorder=5)
        LF.zero(ax)
        ax.set_title(name, fontsize=8.5, loc="left")
        ax.text(0.02, 0.97, f"r2 {s.get('eq_r2', float('nan')):.2f} · days up {s.get('days_pos', float('nan')):.0%} · worst dip {s.get('max_dd', float('nan')):.0f} USD · {s.get('per', float('nan')):+.2f} an entry",
                transform=ax.transAxes, ha="left", va="top", fontsize=7.5, color=N["ink2"], zorder=6)
        ax.set_ylabel("USD", fontsize=8)
        ax.tick_params(labelsize=7.5)
    for ax in axes[len(names):]:
        ax.axis("off")
    return fig
