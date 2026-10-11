"""Figures for the 15-minute Up/Down study (B-0642): drawing only, no model and no data access.

Every function takes plain DataFrames / dicts and returns a matplotlib figure that passes `figstyle.check`
(a question title, the window and hour count, one meaning per colour). The interactive view (`intraday_widget`)
calls the SAME draw functions as the static PNG, so the picture in the Research room is the widget's own frame.

Frames the caller supplies:
  entries : asset, win_start_ms, side (+1 Up / -1 Down), t_entry_ms, ask_best, vwap, shares, fee_usd,
            pnl_gross, pnl_net, won (bool), p_model, mid_up_at_entry, partial (bool)
  windows : asset, win_start_ms, outcome_up (bool), status in STATUS (entered, no_edge, no_depth, late, no_data)
  panel(asset, win_start_ms) -> dict(sec[0..900], bn_rel (ln(S / reference), NaN where no trade yet), p_up,
            up_bid, up_ask, entry=(sec, price, side) or None, depth=dict(sec[n], px[m], size[n, m]) or None)
"""
from __future__ import annotations

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.patches import Patch

from fundplat.quant.core import figstyle as fs

N, V = fs.NEUTRAL, fs.VERDICT
STATUS = ("entered", "no_edge", "no_depth", "late", "no_data")
LETTER = {"entered": "", "no_edge": "e", "no_depth": "d", "late": "l", "no_data": "x"}
WHY = {"no_edge": "no edge at any second", "no_depth": "edge but the book could not fill the clip", "late": "edge only inside the last T_min seconds",
       "no_data": "no book or a Binance gap (excluded by the pre-set rule)"}
DEPTH_CMAP = LinearSegmentedColormap.from_list("depth", [N["surface"], N["ink2"]])


def _hours(h):
    return f"{h:,.0f}h"


def _bars(ax, x, y, color=None, **kw):
    b = ax.bar(x, y, **kw) if color is None else ax.bar(x, y, color=color, **kw)
    return b


def trigger_sec(p):
    """First second at which the momentum signal is on in this panel: |z| >= zmin and the lookback z's agree in sign (panel keys z, zl, zmin); None when
    the panel carries none or it never fires."""
    z, zl, zmin = p.get("z"), p.get("zl"), p.get("zmin")
    if z is None or zmin is None:
        return None
    z = np.asarray(z, float)
    on = np.isfinite(z) & (np.abs(z) >= zmin)
    if zl is not None:
        zl = np.asarray(zl, float)
        on &= np.all(np.sign(zl) == np.sign(z)[:, None], axis=1)
    i = np.nonzero(on)[0]
    return int(np.asarray(p["sec"])[i[0]]) if len(i) else None


def _fair(p):
    """The model's fair value of Up: the calibrated probability of the favoured side put on the Up scale when the panel has it, else the baseline."""
    f = p.get("fair_up")
    return np.asarray(f, float) if f is not None and np.isfinite(np.asarray(f, float)).any() else np.asarray(p["p_up"], float)


def _quotes(ax, x, p, a=1.0, lw=1.6):
    """The market and the model on one probability axis: the Polymarket bid-ask band and its mid (grey), the baseline Brownian P(Up) (ink2, thin),
    the model's fair value (ink, thick), and the edge shaded green where the favoured side's fair value is beyond its ask."""
    x = np.asarray(x, float)
    bid, ask = np.asarray(p["up_bid"], float), np.asarray(p["up_ask"], float)
    ax.fill_between(x, bid, ask, color=N["muted"], alpha=0.35 * a, lw=0)
    ax.plot(x, (bid + ask) / 2, color=N["muted"], lw=0.8 * lw, alpha=a)
    if p.get("fair_up") is not None:
        ax.plot(x, np.asarray(p["p_up"], float), color=N["ink2"], lw=0.7 * lw, alpha=a)
    fv = _fair(p)
    ax.plot(x, fv, color=N["ink"], lw=lw, alpha=a)
    if p.get("edge") is not None and p.get("side") is not None:
        edge, side = np.asarray(p["edge"], float), np.asarray(p["side"], float)
        ref = np.where(side > 0, ask, bid)
        pos = np.isfinite(edge) & (edge > 0) & np.isfinite(ref)
        ax.fill_between(x, fv, ref, where=pos, color=V["good"], alpha=0.30 * a, lw=0)


# ------------------------------------------------------------------ cumulative PnL and equity by day
def draw_equity_by_day(days, net, gross, capital, question, window, bul, h=5.6):
    """days: labels; net, gross: DAILY PnL in USD (after / before the taker fee). Top: cumulative PnL on the book (net ink, before fee in
    the basis colour, zero ink dotted) with the equity on the right-hand scale printed as a label, bottom: the daily PnL bars."""
    x = np.arange(len(days))
    cn, cg = np.cumsum(net), np.cumsum(gross)
    H = h + 2.0 + fs.nlines(bul) * 0.205 + 1.0
    fig, (ax, ax2) = plt.subplots(2, 1, figsize=(13, H), sharex=True, gridspec_kw={"height_ratios": [3, 1], "hspace": 0.28})
    ax.plot(x, cg, color=fs.QUANTITY["basis_dark"], lw=2, label="before the taker fee")
    ax.plot(x, cn, color=N["ink"], lw=2.6, zorder=5, label="after the taker fee")
    ax.axhline(0, color=N["ink"], lw=1.4, ls=":", label=f"zero (book of USD {capital:,.0f})")
    ax.fill_between(x, cn, 0, where=cn >= 0, interpolate=True, color=V["good"], alpha=0.16, lw=0, label="above zero")
    ax.fill_between(x, cn, 0, where=cn < 0, interpolate=True, color=V["bad"], alpha=0.22, lw=0, label="below zero")
    ax.set_ylabel("cumulative PnL, USD")
    ax.text(1, 1.012, f"equity at the end USD {capital + cn[-1]:,.0f}", transform=ax.transAxes, ha="right", va="bottom", size=9.5, weight="bold",
            color=V["good"] if cn[-1] > 0 else V["bad"])
    ax.legend(loc="upper left", bbox_to_anchor=(1.005, 1), fontsize=8.5, frameon=False)
    ax.set_title(question, loc="left", pad=24, size=11.5, weight="bold")
    ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], size=8.5, va="bottom")
    net = np.asarray(net, float)
    ax2.bar(x, net, color=[V["good"] if v > 0 else V["bad"] for v in net], width=0.7)
    ax2.axhline(0, color=N["ink"]); ax2.set_ylabel("PnL a day, USD")
    ax2.set_xticks(x[:: max(1, len(x) // 11)]); ax2.set_xticklabels([days[i][5:] for i in x[:: max(1, len(x) // 11)]], size=8.5)
    fs.finish(fig, bul, top=1 - 0.95 / H, right=0.82)
    return fig


def draw_asset_equity(days, per_asset_net, capital, question, window, bul, h=6.2):
    """One panel per asset: cumulative PnL after fee (ink) and the drawdown from its own peak (red fill, the only red here is 'under water')."""
    names = list(per_asset_net)
    x = np.arange(len(days))
    H = h + fs.nlines(bul) * 0.205 + 1.0
    fig, axs = plt.subplots(1, len(names), figsize=(13, H), sharey=True, gridspec_kw={"wspace": 0.08})
    axs = np.atleast_1d(axs)
    for a, k in zip(axs, names):
        c = np.cumsum(per_asset_net[k])
        peak = np.maximum.accumulate(np.concatenate([[0.0], c]))[1:]
        a.fill_between(x, c, peak, where=c < peak, color=V["bad"], alpha=0.22, lw=0, label="under water")
        a.plot(x, c, color=N["ink"], lw=2.2, label="after the taker fee")
        a.axhline(0, color=N["ink"], lw=1.2, ls=":", label="zero")
        a.set_title(f"{k.upper()}  {c[-1]:+,.0f} USD, worst dip {np.min(c - peak):,.0f}", loc="left", size=9.5, pad=18, weight="bold")
        a.set_xticks(x[:: max(1, len(x) // 5)]); a.set_xticklabels([days[i][5:] for i in x[:: max(1, len(x) // 5)]], size=8)
    axs[0].set_ylabel("cumulative PnL, USD")
    axs[0].legend(loc="best", fontsize=8, frameon=False)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    bm = fs.bullets(fig, bul)
    fig.subplots_adjust(top=0.80, bottom=bm + 0.06, left=0.07, right=0.97)
    return fig


# ------------------------------------------------------------------ how often it triggers, and why not
def draw_trigger_rates(windows, entries, question, window, bul, hour_of, h=5.4):
    """Share of windows that entered: by asset, by UTC hour of the window start, by seconds left at the entry (bars of ink; the
    count is on the bar). `hour_of(ms)` -> UTC hour."""
    assets = sorted(windows["asset"].unique())
    H = h + fs.nlines(bul) * 0.205 + 1.0
    fig, (a1, a2, a3) = plt.subplots(1, 3, figsize=(13, H), gridspec_kw={"wspace": 0.28, "width_ratios": [1, 2.2, 1.4]})
    ent = windows["status"].eq("entered")
    share = [ent[windows["asset"] == a].mean() * 100 for a in assets]
    bars = a1.bar(range(len(assets)), share, color=N["ink2"], width=0.6)
    a1.bar_label(bars, labels=[f"{s:.0f}%" for s in share], fontsize=8.5, padding=2)
    a1.set_xticks(range(len(assets))); a1.set_xticklabels([a.upper() for a in assets], size=9)
    a1.set_ylabel("windows with an entry, %"); a1.set_ylim(0, max(share + [1]) * 1.25)
    hr = np.array([hour_of(m) for m in windows["win_start_ms"]])
    hs = [ent[hr == k].mean() * 100 if (hr == k).any() else 0 for k in range(24)]
    a2.bar(range(24), hs, color=N["ink2"], width=0.7); a2.set_xlabel("UTC hour of the window start"); a2.set_xticks(range(0, 24, 3))
    a2.set_ylim(0, max(hs + [1]) * 1.25)
    sl = (900 - (np.asarray(entries["t_entry_ms"]) - np.asarray(entries["win_start_ms"])) / 1000.0) if len(entries) else np.array([])
    edges = np.array([60, 120, 300, 480, 660, 840, 901])
    cnt, _ = np.histogram(sl, bins=edges)
    lab = [f"{int(a)}-{int(b)}" for a, b in zip(edges[:-1], edges[1:] - 1)]
    bars = a3.bar(range(len(cnt)), cnt, color=N["ink2"], width=0.7); a3.bar_label(bars, fontsize=8, padding=2)
    a3.set_xticks(range(len(cnt))); a3.set_xticklabels(lab, size=8, rotation=30); a3.set_xlabel("seconds left at the entry"); a3.set_ylabel("entries")
    for a, t, s in ((a1, question, window), (a2, "Which hours enter most?", "share of that hour's windows"), (a3, "How late do entries come?", "count of entries")):
        a.set_title(t, loc="left", pad=24, size=11 if a is a1 else 10, weight="bold")
        a.text(0, 1.012, s, transform=a.transAxes, color=N["muted"], size=8, va="bottom")
    bm = fs.bullets(fig, bul)
    fig.subplots_adjust(top=1 - 1.0 / H, bottom=bm + 0.8 / H, left=0.06, right=0.98)
    return fig


def draw_reasons(windows, question, window, bul, h=5.2):
    """Why a window did not enter: stacked bars per asset in ink shades, shares of ALL windows; the legend names each reason."""
    assets = sorted(windows["asset"].unique())
    shades = {"entered": N["ink"], "no_edge": N["ink2"], "no_depth": N["muted"], "late": N["axis"], "no_data": N["grid"]}
    H = h + fs.nlines(bul) * 0.205 + 1.0
    fig, ax = plt.subplots(figsize=(13, H))
    left = np.zeros(len(assets))
    for st in STATUS:
        v = np.array([(windows.loc[windows["asset"] == a, "status"] == st).mean() * 100 for a in assets])
        ax.barh(range(len(assets)), v, left=left, color=shades[st], edgecolor=N["surface"], label=("entered" if st == "entered" else WHY[st]))
        for i, (l0, w0) in enumerate(zip(left, v)):
            if w0 > 4:
                ax.text(l0 + w0 / 2, i, f"{w0:.0f}%", ha="center", va="center", size=8.5, color=N["surface"] if st in ("entered", "no_edge") else N["ink"])
        left += v
    ax.set_yticks(range(len(assets))); ax.set_yticklabels([a.upper() for a in assets]); ax.invert_yaxis(); ax.set_xlim(0, 100)
    ax.set_xlabel("share of all windows, %")
    ax.legend(loc="upper left", bbox_to_anchor=(1.005, 1), fontsize=8.5, frameon=False)
    ax.set_title(question, loc="left", pad=24, size=11.5, weight="bold"); ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], size=8.5, va="bottom")
    fs.finish(fig, bul, top=1 - 0.95 / H, right=0.62)
    return fig


def depth_grid(d, win_start_ms, step=0.01):
    """The study's raw depth (ts ms [n], bid_px, bid_sz, ask_px, ask_sz each [n, L], NaN padded) -> the heatmap form
    dict(sec[n], px[m], size[n, m], mid[n], bid_px.., ask_px..): size resting at each price level (bids and asks on one grid)."""
    if "px" in d:
        return d
    ts = np.asarray(d["ts"], float)
    bp, bs, ap, asz = (np.asarray(d[k], float) for k in ("bid_px", "bid_sz", "ask_px", "ask_sz"))
    allp = np.concatenate([bp[np.isfinite(bp)], ap[np.isfinite(ap)]])
    lo, hi = np.floor(allp.min() / step) * step, np.ceil(allp.max() / step) * step
    px = np.round(np.arange(lo, hi + step / 2, step), 4)
    size = np.zeros((len(ts), len(px)))
    for P, S in ((bp, bs), (ap, asz)):
        ok = np.isfinite(P) & np.isfinite(S)
        r, c = np.nonzero(ok)
        j = np.clip(np.round((P[r, c] - lo) / step).astype(int), 0, len(px) - 1)
        np.add.at(size, (r, j), S[r, c])
    best_bid = np.nanmax(np.where(np.isfinite(bp), bp, -np.inf), axis=1)
    best_ask = np.nanmin(np.where(np.isfinite(ap), ap, np.inf), axis=1)
    mid = np.where(np.isfinite(best_bid) & np.isfinite(best_ask), (best_bid + best_ask) / 2, np.nan)
    return dict(sec=(ts - win_start_ms) / 1000.0, px=px, size=size, mid=list(mid))


# ------------------------------------------------------------------ the intraday view
def _outcome_col(row_status, won):
    if row_status != "entered":
        return None
    return V["good"] if won else V["bad"]


def draw_day_strip(day, asset, wins, entries, panel, question, window, bul, h=6.4):
    """One day of one asset, the 96 windows side by side on the clock. Top: Binance ln(S / the window's reference) (ink; zero is the
    window start). Bottom: the model P(Up) (ink), the Polymarket Up bid and ask (ink2 and muted), the entry (marker). A window that
    entered is shaded green if it won, red if it lost; one that did not is drawn dim with the reason letter above it
    (e no edge, d no depth, l late, x no data)."""
    wins = wins[(wins["asset"] == asset)].sort_values("win_start_ms")
    H = h + fs.nlines(bul) * 0.205 + 1.0
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(13, H), sharex=True, gridspec_kw={"height_ratios": [1, 1.5], "hspace": 0.10})
    d0 = wins["win_start_ms"].min() if len(wins) else 0
    ymax = 1e-9
    for _, w in wins.iterrows():
        p = panel(asset, int(w["win_start_ms"]))
        x0 = (int(w["win_start_ms"]) - d0) / 3.6e6
        x = x0 + np.asarray(p["sec"], float) / 3600.0
        entered = w["status"] == "entered"
        e = entries[(entries["asset"] == asset) & (entries["win_start_ms"] == w["win_start_ms"])]
        won = bool(e["won"].iloc[0]) if len(e) else bool(w["outcome_up"])
        col = _outcome_col(w["status"], won)
        a = 1.0 if entered else 0.32
        for ax in (a1, a2):
            if col:
                ax.axvspan(x[0], x[-1], color=col, alpha=0.13, lw=0)
            ax.axvline(x[0], color=N["grid"], lw=0.6)
        a1.plot(x, p["bn_rel"] * 1e4, color=N["ink"], lw=1.0, alpha=a)
        ymax = max(ymax, float(np.nanmax(np.abs(p["bn_rel"] * 1e4))) if np.isfinite(p["bn_rel"]).any() else 0)
        _quotes(a2, x, p, a=a, lw=1.2)
        ts_ = trigger_sec(p)
        if ts_ is not None:
            a2.plot([x0 + ts_ / 3600.0] * 2, [0.0, 0.05], color=N["ink"], lw=1.0, alpha=a)
        if p.get("entry"):
            s_, px_, side_ = p["entry"]
            a2.scatter([x0 + s_ / 3600.0], [px_ if side_ > 0 else 1 - px_], marker="^" if side_ > 0 else "v", s=34, color=col or N["ink"], zorder=6,
                       edgecolor=N["ink"], linewidth=0.6)
        if LETTER[w["status"]]:
            a2.text(x[0] + 0.125, 1.04, LETTER[w["status"]], ha="center", va="bottom", size=7, color=N["muted"])
    a1.axhline(0, color=N["ink"], lw=1.0, ls=":")
    a1.set_ylabel("Binance, bp from\nthe window start"); a2.set_ylabel("probability of Up"); a2.set_ylim(-0.02, 1.02); a2.set_xlim(0, 24)
    a2.set_xticks(range(0, 25, 2)); a2.set_xlabel(f"UTC hour of {day}")
    leg = [plt.Line2D([], [], color=N["ink"], lw=2.4, label="model fair value of Up"), plt.Line2D([], [], color=N["ink2"], lw=1.2, label="baseline Brownian P(Up)"),
           Patch(color=N["muted"], alpha=0.4, label="Polymarket Up bid-ask band"), Patch(color=V["good"], alpha=0.3, label="edge: fair value beyond the ask"),
           plt.Line2D([], [], color=N["ink"], marker="^", lw=0, markerfacecolor=N["surface"], label="entry (up: Up, down: Down)"),
           plt.Line2D([], [], color=N["ink"], lw=1.0, label="momentum trigger (tick at the foot)"),
           Patch(color=V["good"], alpha=0.25, label="entered, won"), Patch(color=V["bad"], alpha=0.3, label="entered, lost")]
    a2.legend(handles=leg, loc="upper left", bbox_to_anchor=(1.005, 1.05), fontsize=8.2, frameon=False)
    a1.set_title(question, loc="left", pad=24, size=11.5, weight="bold"); a1.text(0, 1.012, window, transform=a1.transAxes, color=N["muted"], size=8.5, va="bottom")
    fs.finish(fig, bul, top=1 - 0.95 / H, right=0.80)
    return fig


def draw_window(asset, win_start_ms, w_row, e_row, p, question, window, bul, snap=None, h=8.0, t_min_s=60):
    """One window in three panels on seconds from the start: Binance ln(S / reference) in bp, the model and the Polymarket Up quotes with
    the entry, and the Up book's depth as a ladder heatmap (price level against time, darker is more size). `snap` marks one
    book snapshot (index into depth['sec']) as a vertical line."""
    H = h + fs.nlines(bul) * 0.205 + 1.0
    d = depth_grid(p["depth"], win_start_ms) if p.get("depth") else None
    nrow = 3 if d else 2
    fig, axs = plt.subplots(nrow, 1, figsize=(13, H), sharex=True, gridspec_kw={"height_ratios": [1, 1.3, 1.6][:nrow], "hspace": 0.12})
    a1, a2 = axs[0], axs[1]
    sec = np.asarray(p["sec"], float)
    won = None if e_row is None else bool(e_row["won"])
    col = _outcome_col("entered" if e_row is not None else w_row["status"], won)
    for ax in axs:
        if col:
            ax.axvspan(0, 900, color=col, alpha=0.10, lw=0)
        ax.axvline(900 - t_min_s, color=N["muted"], lw=0.8)
    a1.plot(sec, p["bn_rel"] * 1e4, color=N["ink"], lw=1.6, label="Binance")
    a1.axhline(0, color=N["ink"], lw=1.1, ls=":"); a1.set_ylabel("bp from the start")
    _quotes(a2, sec, p, a=1.0, lw=2.0)
    ts_ = trigger_sec(p)
    if ts_ is not None:
        for ax in axs:
            ax.axvline(ts_, color=N["ink"], lw=1.0)
        a2.text(ts_, 1.0, " trigger", fontsize=8, va="top", color=N["ink"])
    a2.plot([], [], color=N["ink"], lw=2.0, label="model fair value of Up")
    if p.get("fair_up") is not None:
        a2.plot([], [], color=N["ink2"], lw=1.4, label="baseline Brownian P(Up)")
    a2.fill_between([], [], [], color=N["muted"], alpha=0.35, label="Polymarket bid-ask band")
    a2.fill_between([], [], [], color=V["good"], alpha=0.3, label="edge")
    if p.get("entry"):
        s_, px_, side_ = p["entry"]
        a2.scatter([s_], [px_ if side_ > 0 else 1 - px_], marker="^" if side_ > 0 else "v", s=90, color=col or N["ink"], edgecolor=N["ink"], zorder=6,
                   label=f"entry, {'Up' if side_ > 0 else 'Down'} at {px_:.3f}")
    a2.set_ylabel("probability of Up"); a2.set_ylim(-0.02, 1.02)
    a1.legend(loc="upper left", fontsize=8.5, frameon=False); a2.legend(loc="lower left", fontsize=8.5, frameon=False, ncol=5)
    if d:
        a3 = axs[2]
        sz = np.asarray(d["size"], float)
        img = np.log10(1.0 + sz.T)
        a3.imshow(img, aspect="auto", origin="lower", cmap=DEPTH_CMAP, extent=[d["sec"][0], d["sec"][-1], d["px"][0], d["px"][-1]], interpolation="nearest")
        a3.set_ylabel("Up price level"); a3.set_xlabel("seconds from the window start")
        if snap is not None and 0 <= snap < len(d["sec"]):
            a3.axvline(d["sec"][snap], color=N["ink"], lw=1.2)
    else:
        a2.set_xlabel("seconds from the window start")
    a1.set_title(question, loc="left", pad=24, size=11.5, weight="bold"); a1.text(0, 1.012, window, transform=a1.transAxes, color=N["muted"], size=8.5, va="bottom")
    a1.set_xlim(0, 900)
    fs.finish(fig, bul, top=1 - 0.95 / H, right=0.97)
    return fig


def draw_ladder(d, k, question, window, bul, h=4.2):
    """The Up book at snapshot k: bids (left of the spread) and asks as bars of size by price, ink2 and muted; the figure the slider moves."""
    H = h + fs.nlines(bul) * 0.205 + 1.0
    fig, ax = plt.subplots(figsize=(13, H))
    px, sz = np.asarray(d["px"], float), np.asarray(d["size"][k], float)
    mid = d.get("mid", [None] * len(d["sec"]))[k]
    isb = px < mid if mid is not None else px < np.median(px)
    ax.bar(px[isb], sz[isb], width=np.median(np.diff(px)) * 0.9, color=N["ink2"], label="bids")
    ax.bar(px[~isb], sz[~isb], width=np.median(np.diff(px)) * 0.9, color=N["muted"], label="asks")
    ax.set_xlabel("Up price"); ax.set_ylabel("shares resting"); ax.legend(loc="upper right", fontsize=8.5, frameon=False)
    ax.set_title(question, loc="left", pad=24, size=11.5, weight="bold")
    ax.text(0, 1.012, f"{window} · {d['sec'][k]:.0f} s into the window", transform=ax.transAxes, color=N["muted"], size=8.5, va="bottom")
    fs.finish(fig, bul, top=1 - 0.95 / H, right=0.97)
    return fig


# ------------------------------------------------------------------ calibration, break-even, signal, triggers by hour and asset
def draw_calibration(table, question, window, bul, h=5.2):
    """Is the probability of the favoured side paid as often as it says? `table` = stats.calibration_table: bucket, p_mean, win_rate, lo, hi, n.
    Left: realised win rate against the predicted probability with its Wilson interval and the diagonal. Right: predicted minus realised in
    points per bucket, green where the interval holds the prediction (calibrated), red where it does not; the bucket's n is printed."""
    t = table.reset_index(drop=True)
    pm, wr, lo, hi, n = (np.asarray(t[c], float) for c in ("p_mean", "win_rate", "lo", "hi", "n"))
    H = h + fs.nlines(bul) * 0.205 + 1.0
    fig, (ax, ax2) = plt.subplots(1, 2, figsize=(13, H), gridspec_kw={"wspace": 0.22})
    ax.plot([0.4, 1], [0.4, 1], color=N["ink"], lw=1.3, ls=":")
    ax.text(1, 0.4, "predicted = paid ", ha="right", va="bottom", color=N["ink"], size=9)
    ax.errorbar(pm, wr, yerr=[wr - lo, hi - wr], color=N["ink"], lw=2.2, marker="o", ms=4, capsize=3)
    for x_, y_, k in zip(pm, wr, n):
        ax.annotate(f"n={int(k):,}", (x_, y_), textcoords="offset points", xytext=(0, -14), ha="center", size=7.5, color=N["ink2"])
    ax.set_xlabel("predicted probability of the favoured side"); ax.set_ylabel("share that won, with its interval")
    ax.set_xlim(0.45, 1.01); ax.set_ylim(0.3, 1.04)
    gap = (pm - wr) * 100
    inside = (pm >= lo) & (pm <= hi)
    ax2.bar(range(len(t)), gap, color=[V["good"] if k else V["bad"] for k in inside], width=0.7)
    ax2.axhline(0, color=N["ink"]); ax2.set_xticks(range(len(t))); ax2.set_xticklabels(list(t["bucket"]), size=8, rotation=30)
    ax2.set_ylabel("predicted minus won, points"); ax2.set_xlabel("predicted-probability bucket")
    for a_, ttl, sub in ((ax, question, window), (ax2, "Where is the model over- or under-confident?", "green: the interval holds the prediction; red: it does not")):
        a_.set_title(ttl, loc="left", pad=24, size=11.5, weight="bold"); a_.text(0, 1.012, sub, transform=a_.transAxes, color=N["muted"], size=8.5, va="bottom")
    bm = fs.bullets(fig, bul)
    fig.subplots_adjust(top=1 - 0.95 / H, bottom=bm + 0.8 / H, left=0.07, right=0.97)
    return fig


def draw_breakeven_by_price(tbl, question, window, bul, h=5.4):
    """Does the win rate beat the break-even at the price paid? `tbl` = stats.by_price_bucket: bucket, n, win_rate, lo, hi, be, win_minus_be_pp,
    per_entry. A bar of win rate with its Wilson interval per entry-price bucket, an ink mark at the break-even of the fills in that bucket
    (cost plus fee per share), green when the win rate is above it, red when below; n and the PnL per entry under each bucket."""
    t = tbl.reset_index(drop=True)
    x = np.arange(len(t))
    wr, lo, hi, be = (np.asarray(t[c], float) for c in ("win_rate", "lo", "hi", "be"))
    H = h + fs.nlines(bul) * 0.205 + 1.0
    fig, ax = plt.subplots(figsize=(13, H))
    ok = wr > be
    ax.bar(x, wr * 100, width=0.6, color=[V["good"] if k else V["bad"] for k in ok], alpha=0.85)
    ax.vlines(x, lo * 100, hi * 100, color=N["ink"], lw=1.4)
    for yy in (lo, hi):
        ax.hlines(yy * 100, x - 0.08, x + 0.08, color=N["ink"], lw=1.4)
    ax.hlines(be * 100, x - 0.38, x + 0.38, color=N["ink"], lw=2.6, zorder=6, label="break-even win rate of the fills")
    for i, r in t.iterrows():
        ax.text(i, 1.5, f"n={int(r['n']):,}\n{r['per_entry']:+.2f} USD/entry\n{r['win_minus_be_pp']:+.1f} pt", ha="center", va="bottom", size=8, color=N["surface"] if wr[i] * 100 > 22 else N["ink"])
    ax.set_xticks(x); ax.set_xticklabels(list(t["bucket"])); ax.set_xlabel("price paid per share (the fill's average)")
    ax.set_ylabel("entries won, %"); ax.set_ylim(0, 105)
    ax.legend(handles=[plt.Line2D([], [], color=N["ink"], lw=2.6, label="break-even (cost + fee)"),
                       Patch(color=V["good"], alpha=0.85, label="above break-even"), Patch(color=V["bad"], alpha=0.85, label="below")],
              loc="upper left", bbox_to_anchor=(1.005, 1), fontsize=8.5, frameon=False)
    ax.set_title(question, loc="left", pad=24, size=11.5, weight="bold"); ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], size=8.5, va="bottom")
    fs.finish(fig, bul, top=1 - 0.95 / H, right=0.80)
    return fig


def draw_signal(p, question, window, bul, h=5.0):
    """The momentum signal of ONE window: z = ln(S / A0) / (sigma sqrt(t elapsed)) in ink and the 10, 30 and 60 second lookback z's (ink2, muted, axis grey,
    solid); the trigger line at +/- z_min (ink, dotted) and a vertical mark at the trigger second. Panel keys z, zl [n, 3], zmin."""
    sec = np.asarray(p["sec"], float)
    z, zl, zmin = np.asarray(p["z"], float), np.asarray(p["zl"], float), p.get("zmin")
    H = h + fs.nlines(bul) * 0.205 + 1.0
    fig, ax = plt.subplots(figsize=(13, H))
    for k, (c, lab) in enumerate(((N["ink2"], "10 s lookback"), (N["muted"], "30 s lookback"), (N["axis"], "60 s lookback"))):
        if zl.ndim == 2 and zl.shape[1] > k:
            ax.plot(sec, zl[:, k], color=c, lw=1.2, label=lab)
    ax.plot(sec, z, color=N["ink"], lw=2.2, label="z since the window start")
    ax.axhline(0, color=N["axis"], lw=1)
    if zmin is not None:
        for sgn in (1, -1):
            ax.axhline(sgn * zmin, color=N["ink"], lw=1.2, ls=":")
        ax.text(sec[0], zmin, f" z_min {zmin:g}", va="bottom", size=8.5, color=N["ink"])
    ts_ = trigger_sec(p)
    if ts_ is not None:
        ax.axvline(ts_, color=N["ink"], lw=1.2)
        ax.text(ts_, ax.get_ylim()[1], f" trigger at {ts_} s", va="top", size=8.5, color=N["ink"])
    ax.set_xlabel("seconds from the window start"); ax.set_ylabel("z (sigmas)"); ax.set_xlim(0, 900)
    ax.legend(loc="upper left", bbox_to_anchor=(1.005, 1), fontsize=8.5, frameon=False)
    ax.set_title(question, loc="left", pad=24, size=11.5, weight="bold"); ax.text(0, 1.012, window, transform=ax.transAxes, color=N["muted"], size=8.5, va="bottom")
    fs.finish(fig, bul, top=1 - 0.95 / H, right=0.80)
    return fig


def draw_trigger_by_hour_asset(frame, question, window, bul, h=5.4):
    """Windows with a trigger over windows, by UTC hour of the window start, one panel per asset (ink bars, a shared y). `frame` has asset, hour, triggered."""
    assets = sorted(frame["asset"].unique())
    H = h + fs.nlines(bul) * 0.205 + 1.0
    fig, axs = plt.subplots(1, len(assets), figsize=(13, H), sharey=True, gridspec_kw={"wspace": 0.08})
    axs = np.atleast_1d(axs)
    top = 1e-9
    for a_, k in zip(axs, assets):
        g = frame[frame["asset"] == k]
        share = np.array([100.0 * g.loc[g["hour"] == hh, "triggered"].mean() if (g["hour"] == hh).any() else 0.0 for hh in range(24)])
        top = max(top, share.max())
        a_.bar(range(24), share, color=N["ink2"], width=0.75)
        a_.set_xticks(range(0, 24, 6)); a_.set_xlabel("UTC hour")
        a_.set_title(f"{k.upper()}  {100 * g['triggered'].mean():.0f}% of {len(g):,} windows", loc="left", size=9.5, pad=18, weight="bold")
    axs[0].set_ylabel("windows with a trigger, %"); axs[0].set_ylim(0, top * 1.2)
    fig.suptitle(question, x=0.07, ha="left", fontsize=11.5, fontweight="bold", y=0.985)
    fig.text(0.07, 0.925, window, color=N["muted"], fontsize=8.5)
    bm = fs.bullets(fig, bul)
    fig.subplots_adjust(top=0.80, bottom=bm + 0.09, left=0.07, right=0.97)
    return fig


def intraday_widget(days, assets, wins, entries, panel, window_txt, hour_label=lambda ms: ""):
    """The interactive view for a live kernel (JupyterLab): a day and an asset dropdown redraw the day strip; a window dropdown opens one
    window (Binance, model, quotes, entry) and its book depth, and a slider walks the book snapshots. Returns the widget box."""
    import ipywidgets as W
    from IPython.display import display
    dd, da = W.Dropdown(options=days, description="day"), W.Dropdown(options=assets, description="asset")
    dw = W.Dropdown(options=[], description="window", layout=W.Layout(width="260px"))
    sl = W.IntSlider(value=0, min=0, max=0, description="snapshot", continuous_update=False, layout=W.Layout(width="520px"))
    out_day, out_win, out_lad = W.Output(), W.Output(), W.Output()
    state = {"w": None, "d": None}

    def day_rows():
        lo = int(np.datetime64(dd.value + "T00:00:00", "ms").astype("int64"))
        w = wins[(wins["asset"] == da.value) & (wins["win_start_ms"] >= lo) & (wins["win_start_ms"] < lo + 86_400_000)]
        return w.sort_values("win_start_ms")

    def redraw_day(*_):
        w = day_rows()
        dw.options = [(f"{hour_label(int(r.win_start_ms))} {r.status}", int(r.win_start_ms)) for r in w.itertuples()]
        with out_day:
            out_day.clear_output(wait=True)
            if len(w):
                draw_day_strip(dd.value, da.value, w, entries, panel, "Where did the model and the book disagree today?", window_txt,
                                     ["Green windows entered and won, red entered and lost; dim windows did not enter, the letter says why (e no edge, d no depth, l late, x no data)."])
                plt.show()
        redraw_win()

    def redraw_win(*_):
        if dw.value is None:
            return
        w = wins[(wins["asset"] == da.value) & (wins["win_start_ms"] == dw.value)].iloc[0]
        e = entries[(entries["asset"] == da.value) & (entries["win_start_ms"] == dw.value)]
        e = e.iloc[0] if len(e) else None
        p = panel(da.value, int(dw.value))
        state["w"] = p
        d = depth_grid(p["depth"], int(dw.value)) if p.get("depth") else None
        state["d"] = d
        sl.max = max(0, len(d["sec"]) - 1) if d else 0
        with out_win:
            out_win.clear_output(wait=True)
            draw_window(da.value, int(dw.value), w, e, p, "What did the book and the model say in this window?", window_txt,
                        [f"status {w['status']}; the market resolved {'Up' if w['outcome_up'] else 'Down'}."])
            plt.show()
        redraw_ladder()

    def redraw_ladder(*_):
        d = state.get("d")
        with out_lad:
            out_lad.clear_output(wait=True)
            if d:
                draw_ladder(d, min(sl.value, len(d["sec"]) - 1), "How deep was the Up book at this snapshot?", window_txt, ["Bars are shares resting at each price."])
                plt.show()

    dd.observe(redraw_day, "value"); da.observe(redraw_day, "value"); dw.observe(redraw_win, "value"); sl.observe(redraw_ladder, "value")
    box = W.VBox([W.HBox([dd, da, dw]), out_day, out_win, sl, out_lad])
    display(box)
    redraw_day()
    return box
