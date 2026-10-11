"""Figures of the probability-lifting study (B-0649). Matplotlib and `fundplat.quant.core.figstyle` only; every function takes the DataFrames the analyses return and draws one
figure under the figure rules (a question for a title, the window under it, findings below, one meaning per colour, solid series). Colours: Binance-derived series in the
BINANCE identity, a model in MODEL, Polymarket in POLYMARKET, an edge's sign in the verdict pair (gain, loss), thresholds in ink and dotted.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

from fundplat.quant.core import figstyle as fs

N = fs.NEUTRAL
ID = fs.IDENTITY
GOOD, BAD = fs.VERDICT["good"], fs.VERDICT["bad"]
BIN, MOD, PM = ID["BINANCE"], ID["MODEL"], ID["POLYMARKET"]
LIGHT = 0.22


def setup():
    plt.rcParams.update({"figure.dpi": 110, "figure.facecolor": N["surface"], "axes.facecolor": N["surface"], "savefig.facecolor": N["surface"], "font.size": 9.5, "axes.axisbelow": True,
                         "axes.edgecolor": N["axis"], "axes.labelcolor": N["ink2"], "axes.titlecolor": N["ink"], "axes.titlesize": 10, "axes.titleweight": "bold", "axes.titlelocation": "left",
                         "axes.grid": True, "grid.color": N["grid"], "grid.linewidth": 0.7, "xtick.color": N["muted"], "ytick.color": N["muted"], "legend.frameon": False,
                         "axes.spines.top": False, "axes.spines.right": False, "lines.linewidth": 1.8})


def frame(h, bul, q, sub, ncols=1, nrows=1, wspace=0.28, hspace=0.5, ratios=None, axis_pad=0.6, sharey=False):
    """A figure of `h` inches of chart, room for the findings under it and the question over it. -> fig, list of axes (row-major)."""
    H = h + fs.nlines(bul) * 0.205 + 0.45 + axis_pad + 0.45
    fig = plt.figure(figsize=(13, H))
    bm = fs.bullet_margin(fig, fs.nlines(bul)) + 0.02 + axis_pad / H
    top = 1 - 1.35 / H
    gs = fig.add_gridspec(nrows, ncols, left=0.07, right=0.97, top=top, bottom=bm, wspace=wspace, hspace=hspace, **({"height_ratios": ratios} if ratios else {}))
    axes = [fig.add_subplot(gs[i, j]) for i in range(nrows) for j in range(ncols)]
    fig.suptitle(q, x=0.07, y=1 - 0.18 / H, ha="left", va="top", fontsize=11.5, fontweight="bold", color=N["ink"])
    fig.text(0.07, 1 - 0.58 / H, sub, ha="left", va="top", fontsize=8.5, color=N["muted"])
    fs.bullets(fig, bul, bottom_in=0.12)
    if sharey and len(axes) > 1:
        for a in axes[1:]:
            a.sharey(axes[0])
    return fig, axes


def zero(ax):
    ax.axhline(0, color=N["axis"], lw=1.0, zorder=1)


def thresh(ax, y, label, x=1.003):
    ax.axhline(y, color=N["ink"], ls=":", lw=1.3, zorder=3)
    ax.annotate(f" {label}", xy=(x, y), xycoords=("axes fraction", "data"), va="center", fontsize=8, color=N["ink"], annotation_clip=False)


def signbar(ax, x, y, se=None, width=0.7):
    """Bars coloured by the sign of the value: gain green, loss red; whiskers are 95% intervals."""
    y = np.asarray(y, float)
    cols = [GOOD if v >= 0 else BAD for v in y]
    ax.bar(x, y, width=width, color=cols, zorder=3)
    if se is not None:
        ax.errorbar(x, y, yerr=1.96 * np.asarray(se, float), fmt="none", color=N["ink2"], ecolor=N["ink2"], elinewidth=1.0, capsize=2.5, zorder=4)


def band(ax, x, y, se, col, label=None, marker="o"):
    x, y, se = np.asarray(x, float), np.asarray(y, float), np.asarray(se, float)
    ax.fill_between(x, y - 1.96 * se, y + 1.96 * se, color=col, alpha=LIGHT, lw=0)
    ax.plot(x, y, color=col, marker=marker, ms=3.5, lw=1.9, label=label, zorder=4)


# ---------------------------------------------------------------------------- the figures
def deciles(dec: pd.DataFrame, feature: str, hs, win, bul, lat=150):
    """Mean return after the instant, by FIT bin of the feature (a fifth of the falls, flat, a fifth of the rises), one panel per hold."""
    fig, ax = frame(3.6, bul, f"Does the next move rise with the last move? Return by bin of {feature}", win, ncols=len(hs), sharey=False)
    nb = int(dec.decile.max())
    half = (nb - 1) // 2
    labels = [f"-{k}" for k in range(half, 0, -1)] + ["flat"] + [f"+{k}" for k in range(1, half + 1)]
    for a, h in zip(ax, hs):
        d = dec[(dec.h_s == h) & (dec.L_ms == lat)].sort_values("decile")
        signbar(a, d.decile, d.mean_bp, d.se)
        zero(a)
        a.set_title(f"held {h:g} s, entered {lat} ms later")
        a.set_xlabel("bin of the feature (fifths of the falls, flat, fifths of the rises)")
        a.set_xticks(range(1, nb + 1))
        a.set_xticklabels(labels, fontsize=8)
    ax[0].set_ylabel("mean return, bp")
    return fig


def buckets_line(df: pd.DataFrame, xcol, ycol, secol, hs, win, bul, q, xlabel, ylabel, ref=None, lat=150, labels=None):
    """One panel per hold: a solid line through the buckets (rank order on x), interval band, an optional ink reference line."""
    fig, ax = frame(3.6, bul, q, win, ncols=len(hs))
    for a, h in zip(ax, hs):
        d = df[(df.h_s == h) & (df.L_ms == lat)] if "L_ms" in df else df[df.h_s == h]
        x = np.arange(len(d))
        se = d[secol].to_numpy() if secol else np.zeros(len(d))
        band(a, x, d[ycol], se, BIN)
        a.set_xticks(x)
        a.set_xticklabels(labels if labels is not None else d[xcol].tolist(), rotation=0, fontsize=8)
        if ref is None:
            zero(a)
        else:
            a.axhline(ref, color=N["ink"], ls=":", lw=1.3, zorder=3)
        a.set_title(f"held {h:g} s")
        a.set_xlabel(xlabel)
    ax[0].set_ylabel(ylabel)
    return fig


def horizon_curves(tables: dict, hs_all, win, bul, lat_lo=0, lat_hi=150):
    """Edge against the hold, one panel per signal; two lines: entered at the instant (L = 0) and 150 ms later."""
    fig, ax = frame(3.8, bul, "How long does each signal keep paying? Edge against the holding time", win, ncols=len(tables))
    for a, (name, t) in zip(ax, tables.items()):
        for L, col, lab in ((lat_lo, N["ink2"], "entered at the instant"), (lat_hi, BIN, f"entered {lat_hi} ms later")):
            d = t[t.L_ms == L].sort_values("h_s")
            band(a, d.h_s, d.edge_bp, d.se, col, lab)
        a.set_xscale("log")
        a.set_xticks([0.25, 1, 5, 30, 120, 300])
        a.set_xticklabels(["0.25", "1", "5", "30", "120", "300"])
        zero(a)
        a.set_title(name)
        a.set_xlabel("holding time, s")
    ax[0].set_ylabel("edge, bp")
    ax[-1].legend(loc="upper left", fontsize=8)
    return fig


def by_group(df: pd.DataFrame, group_order, hs, win, bul, q, xlabel, lat=150, ylabel="edge, bp", annotate_seconds=True):
    """Signed edge per group (volatility tercile, seconds left ...), one panel per hold."""
    fig, ax = frame(3.7, bul, q, win, ncols=len(hs))
    for a, h in zip(ax, hs):
        d = df[(df.h_s == h) & (df.L_ms == lat)].set_index("group").reindex(group_order)
        x = np.arange(len(d))
        signbar(a, x, d.edge_bp.fillna(0), d.se.fillna(0))
        zero(a)
        a.set_xticks(x)
        a.set_xticklabels([f"{g}\n{s / 60:,.0f} min" if (annotate_seconds and np.isfinite(s)) else g for g, s in zip(group_order, d.seconds)], fontsize=8)
        a.set_title(f"held {h:g} s")
        a.set_xlabel(xlabel)
    ax[0].set_ylabel(ylabel)
    return fig


def latency_curves(tables: dict, hs, win, bul, bar=150):
    """Edge against the delay between seeing the instant and trading, one panel per hold; a line per signal in the Binance colour and a different marker; the bar in ink."""
    fig, ax = frame(3.8, bul, "Does the edge survive the delay? Edge against the time from signal to trade", win, ncols=len(hs))
    marks = ["o", "s", "^", "D", "v"]
    for a, h in zip(ax, hs):
        for k, (name, t) in enumerate(tables.items()):
            d = t[t.h_s == h].sort_values("L_ms")
            a.plot(d.L_ms, d.edge_bp, color=BIN, marker=marks[k % 5], ms=4.5, lw=1.8, alpha=1.0 - 0.18 * k, label=name)
        a.axvline(bar, color=N["ink"], ls=":", lw=1.3)
        a.annotate(f" {bar} ms taker delay", xy=(bar, 1.0), xycoords=("data", "axes fraction"), va="bottom", fontsize=8, color=N["ink"])
        a.set_xscale("symlog", linthresh=50)
        a.set_xticks([0, 50, 100, 150, 250, 500, 1000])
        a.set_xticklabels(["0", "50", "100", "150", "250", "500", "1000"], fontsize=7.5, rotation=60)
        zero(a)
        a.set_title(f"held {h:g} s", pad=14)
        a.set_xlabel("delay, ms")
    ax[0].set_ylabel("edge, bp")
    ax[0].legend(loc="lower left", fontsize=8)
    return fig


def daily(df: pd.DataFrame, roles: dict, series, win, bul, q, ylabel="edge, bp"):
    """Edge per day for each signal: grouped bars coloured by sign (one panel per signal), day labels carry the role."""
    fig, ax = frame(3.7, bul, q, win, ncols=len(series))
    for a, s in zip(ax, series):
        d = df[df.hyp == s].sort_values("day")
        x = np.arange(len(d))
        signbar(a, x, d.edge_bp, d.se)
        zero(a)
        a.set_xticks(x)
        a.set_xticklabels([f"{r.day[5:]}\n{roles.get(r.day, '')}" for _, r in d.iterrows()], fontsize=7.5)
        a.set_title(s)
    ax[0].set_ylabel(ylabel)
    return fig


def model_bars(rows: pd.DataFrame, win, bul):
    """Out-of-sample correlation and top-minus-bottom decile spread for the simple signal and the three models."""
    fig, ax = frame(3.8, bul, "Does a model beat the simple signal? Correlation and decile spread, out of sample", win, ncols=2)
    x = np.arange(len(rows))
    for a, col, title, se in ((ax[0], "rho", "correlation with the return after the delay", None), (ax[1], "spread_bp", "top decile minus bottom decile, bp", "spread_se")):
        signbar(a, x, rows[col], rows[se] if se else None)
        zero(a)
        a.set_xticks(x)
        a.set_xticklabels(rows.name.tolist(), fontsize=8)
        a.set_title(title)
    return fig


def state_gain(df: pd.DataFrame, win, bul):
    """Log-loss gain of adding the signal to the state, by seconds left, with a window-bootstrap interval, and the mean absolute lift in P(Up)."""
    fig, ax = frame(3.8, bul, "Does the signal tell us more than where the window already is? Gain in log loss", win, ncols=2)
    d = df.reset_index(drop=True)
    x = np.arange(len(d))
    signbar(ax[0], x, d.gain * 1e3, None)
    ax[0].errorbar(x, d.gain * 1e3, yerr=[(d.gain - d.lo) * 1e3, (d.hi - d.gain) * 1e3], fmt="none", color=N["ink2"], ecolor=N["ink2"], elinewidth=1.0, capsize=2.5, zorder=4)
    zero(ax[0])
    ax[0].set_xticks(x)
    ax[0].set_xticklabels(d.rows.tolist(), fontsize=7.5, rotation=15)
    ax[0].set_title("log-loss gain over the state alone, 1/1000")
    ax[1].bar(x, d.mean_abs_lift * 100, color=BIN, width=0.7, zorder=3)
    ax[1].set_xticks(x)
    ax[1].set_xticklabels(d.rows.tolist(), fontsize=7.5, rotation=15)
    ax[1].set_title("mean absolute change in P(Up), points")
    return fig


def dose(rows: pd.DataFrame, win, bul):
    """The planted-leak dose response: the edge when the features are read k rows stale or ahead."""
    fig, ax = frame(3.6, bul, "Does the test see a leak? Edge when the features are read stale or from the future", win)
    a = ax[0]
    d = rows.sort_values("k", ascending=False)
    x = np.arange(len(d))
    a.plot(x, d.edge_bp, color=BIN, marker="o", ms=5, lw=1.9)
    a.set_xticks(x)
    a.set_xticklabels([("stale " if k > 0 else ("ahead " if k < 0 else "")) + (f"{abs(k)} rows" if k != 0 else "as built") for k in d.k], fontsize=8)
    zero(a)
    a.set_ylabel("edge, bp")
    return fig


def assets(df: pd.DataFrame, win, bul, hyps, h=5.0):
    """Edge at 5 s by instrument for each hypothesis, in each asset's identity colour."""
    fig, ax = frame(3.7, bul, "Does the same edge appear in the other coins? Edge by instrument", win, ncols=len(hyps))
    for a, hy in zip(ax, hyps):
        d = df[(df.hyp == hy) & (df.h_s == h)]
        x = np.arange(len(d))
        a.bar(x, d.edge_bp, color=[ID[s.upper()] for s in d.asset], width=0.65, zorder=3)
        a.errorbar(x, d.edge_bp, yerr=1.96 * d.se, fmt="none", color=N["ink2"], ecolor=N["ink2"], elinewidth=1.0, capsize=2.5, zorder=4)
        zero(a)
        a.set_xticks(x)
        a.set_xticklabels([s.upper() for s in d.asset])
        a.set_title(f"{hy}, held {h:g} s")
    ax[0].set_ylabel("edge, bp")
    return fig


def concentration(curves: dict, win, bul):
    """Share of a signal's total edge earned in its best x% of minutes (a curve per signal, ink diagonal = evenly spread)."""
    fig, ax = frame(3.8, bul, "Is the edge spread over the day or in a few bursts? Share of the edge in the best minutes", win)
    a = ax[0]
    marks = ["o", "s", "^"]
    for k, (name, (x, y)) in enumerate(curves.items()):
        keep = np.unique(np.linspace(0, len(x) - 1, 300).astype(int))
        a.plot(x[keep] * 100, y[keep] * 100, color=BIN, marker=marks[k % 3], markevery=25, ms=5, lw=1.8, alpha=1.0 - 0.2 * k, label=name)
    a.plot([0, 100], [0, 100], color=N["ink"], ls=":", lw=1.3)
    a.annotate(" even spread", xy=(100, 100), va="center", fontsize=8, color=N["ink"])
    a.set_xlabel("best minutes, % of minutes with the signal")
    a.set_ylabel("share of total edge, %")
    a.legend(loc="lower right", fontsize=8)
    return fig


def top_features(scan: pd.DataFrame, win, bul, h=5.0, n=14):
    """The strongest features of the exploratory scan, fit-day against validation-day correlation at one hold."""
    d = scan[(scan.h_s == h) & (scan.L_ms == 150)].copy()
    d["a"] = d.t.abs()
    d = d.sort_values("a", ascending=False).head(n).iloc[::-1]
    fig, ax = frame(0.32 * n + 1.2, bul, "Which price features carry the next move? Correlation with the return held 5 s", win, ncols=2, sharey=True)
    fig.subplots_adjust(left=0.14)
    y = np.arange(len(d))
    for a, col, title in ((ax[0], "rho_fit", "fit days"), (ax[1], "rho", "validation days")):
        a.barh(y, d[col], color=[GOOD if v >= 0 else BAD for v in d[col]], height=0.65, zorder=3)
        a.axvline(0, color=N["axis"], lw=1.0)
        a.set_title(title)
        a.set_yticks(y)
        a.set_yticklabels(d.feature, fontsize=8)
        a.grid(axis="y", visible=False)
    return fig


def bins_panels(dfs: dict, labels, win, bul, q, xlabel, ylabel="mean return, bp", hold=5.0, lat=150):
    """Mean return after the instant by bin of a feature, one panel per feature (a dict name -> decile_curve frame), a solid line with an interval band and the zero line."""
    fig, ax = frame(3.6, bul, q, win, ncols=len(dfs))
    for a, (name, d) in zip(ax, dfs.items()):
        d = d[(d.h_s == hold) & (d.L_ms == lat)].sort_values("decile")
        x = np.arange(len(d))
        band(a, x, d.mean_bp, d.se, BIN)
        zero(a)
        a.set_xticks(x)
        a.set_xticklabels(labels, fontsize=7.5, rotation=0)
        a.set_title(name)
        a.set_xlabel(xlabel, fontsize=8.5)
    ax[0].set_ylabel(ylabel)
    return fig


def breakout_fig(df: pd.DataFrame, hs, win, bul):
    """After a break of the last 10 s range: the share that go on (left) and the share that fall back through the broken level (right), by size of the break, a line per hold."""
    fig, ax = frame(3.7, bul, "Do breakouts continue or fail? Share that go on and share that fall back, by size of the break", win, ncols=2)
    buckets = list(dict.fromkeys(df.bucket))
    marks = ["o", "s", "^"]
    for a, col, title, ref in ((ax[0], "win_share", "share that go on after the delay (ties out)", 0.5), (ax[1], "fall_back", "share back through the broken level by the hold", None)):
        for k, h in enumerate(hs):
            d = df[df.h_s == h]
            a.plot(range(len(d)), d[col], color=BIN, marker=marks[k], ms=4.5, lw=1.8, alpha=1.0 - 0.28 * k, label=f"held {h:g} s")
        if ref is not None:
            a.axhline(ref, color=N["ink"], ls=":", lw=1.3)
        a.set_xticks(range(len(buckets)))
        a.set_xticklabels(buckets, fontsize=8)
        a.set_title(title)
        a.set_xlabel("size of the break, second-volatilities of the last 10 s")
    ax[0].legend(loc="lower left", fontsize=8)
    return fig
