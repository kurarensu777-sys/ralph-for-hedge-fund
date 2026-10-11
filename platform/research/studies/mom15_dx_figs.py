"""Figures of the diagnosis of the directional momentum study (B-0662): matplotlib and `fundplat.quant.core.figstyle` only, on the frames of `mom15_diag`. Each function takes tables
the diagnosis returned and draws one figure under the figure rules (a question for a title, the window and hours under it, findings below, one meaning per colour, solid series).

    waterfall_fig    where the USD of an entry goes: the fair value's surprise, the model against the book, the 250 ms, spread and depth, the fee (kind profit-and-loss-attribution)
    calibration_fig  the actual win share against the share the price and fee ask, by price band, and the gap in points (kind calibration)
    clusters_fig     net per entry by coin, UTC block, volatility, time in and with or against the leader (kind regime-and-concentration)
    arms_fig         the edge before friction and the friction of the momentum side, the leader's side and a fair coin at the same seconds (kind rule-comparison)
    lookback_fig     the same split for each lookback at one threshold (kind profit-and-loss-attribution)
    hunt_fig         the t of every slice and signal cell against the best-of-N line (kind significance-test)
    holdout_fig      discovery against hold-out net per entry for every slice (kind out-of-sample-test)
    weeks_fig        the edge before friction, the friction and the net by period with 95% intervals, and by day (kind profit-and-loss-attribution, B-0679)
    drift_fig        what Binance and the token's mid do after the entry (kind signal-decay)
"""
from __future__ import annotations

import numpy as np

import lift_figs as LF
from fundplat.quant.core import figstyle as fs

N, V = fs.NEUTRAL, fs.VERDICT
GOOD, BAD = V["good"], V["bad"]
PM = fs.IDENTITY["POLYMARKET"]
COIN_COL = {"btc": fs.IDENTITY["BTC"], "eth": fs.IDENTITY["ETH"], "sol": fs.IDENTITY["SOL"], "xrp": fs.IDENTITY["XRP"]}
TERMS = ("A", "B", "C", "D", "E")
TERM_NAME = {"A": "fair value's\nsurprise", "B": "model against\nthe book", "C": "book moves\nin 250 ms", "D": "half spread\nand depth", "E": "fee"}


def _steps(ax, wf, title):
    """One waterfall: floating bars for the five terms (gain green, loss red), the net as an ink bar with its interval."""
    t = wf.set_index("term")
    cum = 0.0
    xs = np.arange(len(TERMS) + 1)
    for i, k in enumerate(TERMS):
        v = float(t.loc[k, "usd"])
        ax.bar(i, v, bottom=cum, width=0.62, color=GOOD if v >= 0 else BAD, zorder=3)
        ax.annotate(f"{v:+.2f}", (i, cum + v if v >= 0 else cum), ha="center", va="bottom" if v >= 0 else "top", fontsize=8.5, color=N["ink"], xytext=(0, 3 if v >= 0 else -3), textcoords="offset points")
        if i < len(TERMS) - 1:
            ax.plot([i + 0.31, i + 0.69], [cum + v, cum + v], color=N["axis"], lw=0.9, zorder=2)
        cum += v
    n = float(t.loc["net", "usd"])
    ax.bar(len(TERMS), n, width=0.62, color=N["ink"], zorder=3)
    ax.errorbar([len(TERMS)], [n], yerr=[[n - float(t.loc["net", "lo"])], [float(t.loc["net", "hi"]) - n]], fmt="none", color=N["ink2"], ecolor=N["ink2"], elinewidth=1.0, capsize=3, zorder=4)
    ax.annotate(f"{n:+.2f}", (len(TERMS), n), ha="center", va="top" if n < 0 else "bottom", fontsize=8.5, color=N["ink"], xytext=(0, -14 if n < 0 else 3), textcoords="offset points")
    ax.axhline(0, color=N["axis"], lw=1.0, zorder=1)
    ax.set_xticks(xs)
    ax.set_xticklabels([TERM_NAME[k] for k in TERMS] + ["net per\nentry"], fontsize=8)
    ax.set_title(title, fontsize=9.5)
    ax.set_ylabel("USD an entry")


def waterfall_fig(wf_a, wf_b, title_a, title_b, window, notes, question="Where does the money of an entry go between the signal and the settlement?"):
    fig, axes = LF.frame(4.0, notes, question, window, ncols=2, wspace=0.18, sharey=True)
    _steps(axes[0], wf_a, title_a)
    _steps(axes[1], wf_b, title_b)
    return fig


def calibration_fig(cal_a, cal_b, label_a, label_b, window, notes, question="Does the momentum side win as often as the price and fee say it should?"):
    """cal_*: `mom15_diag.calibration` over price bands. Left: the actual win share against the price + fee share, a point per band with its Wilson interval, on the break-even diagonal.
    Right: the gap in points with its cluster 95% interval."""
    fig, (ax, ax2) = LF.frame(4.2, notes, question, window, ncols=2, wspace=0.22)
    ax.plot([0, 1], [0, 1], color=N["ink"], ls=":", lw=1.3, zorder=2)
    ax.annotate(" win share = price + fee (break-even)", xy=(0.02, 0.1), xycoords="axes fraction", fontsize=8, color=N["ink"], rotation=0)
    for cal, col, lab, ms, off in ((cal_b, N["muted"], label_b, 5, 0.004), (cal_a, PM, label_a, 7, -0.004)):
        x = cal["price + fee"].to_numpy(float)
        y = cal["win"].to_numpy(float)
        ax.errorbar(x + off, y, yerr=[y - cal["win lo"].to_numpy(float), cal["win hi"].to_numpy(float) - y], fmt="o", color=col, ecolor=col, elinewidth=1.0, capsize=2, ms=ms, label=lab, zorder=4)
    for x, y, n in zip(cal_a["price + fee"], cal_a["win"], cal_a["entries"]):
        ax.annotate(f"{int(n)}", (x, y), xytext=(6, -10), textcoords="offset points", fontsize=7.5, color=N["ink2"])
    ax.set(xlim=(0, 1), ylim=(-0.02, 1.04), xlabel="share the price paid plus the fee asks", ylabel="share that won")
    ax.legend(loc="lower right", fontsize=8)
    k = np.arange(len(cal_a))
    gap = cal_a["win - price - fee (pp)"].to_numpy(float)
    ax2.bar(k, gap, width=0.62, color=[GOOD if g >= 0 else BAD for g in gap], zorder=3)
    ax2.errorbar(k, gap, yerr=[gap - cal_a["fee pp lo"].to_numpy(float), cal_a["fee pp hi"].to_numpy(float) - gap], fmt="none", color=N["ink2"], ecolor=N["ink2"], elinewidth=1.0, capsize=2.5, zorder=4)
    gb = cal_b.set_index(cal_b.columns[0]).reindex(cal_a[cal_a.columns[0]])["win - price - fee (pp)"].to_numpy(float)
    ax2.scatter(k, gb, marker="_", s=380, color=N["ink"], zorder=5, label=f"the same band, {label_b}")
    ax2.axhline(0, color=N["axis"], lw=1.0)
    ax2.set_xticks(k)
    ax2.set_xticklabels([f"{b}\nn = {int(n)}" for b, n in zip(cal_a[cal_a.columns[0]], cal_a["entries"])], fontsize=8)
    ax2.set(xlabel="price paid a share", ylabel="win share minus price minus fee, points")
    ax2.legend(loc="upper left", fontsize=8)
    return fig


def clusters_fig(blocks, window, notes, names=None, question="Where do the losses of the chosen pair sit: which coin, hour, volatility, moment or side?"):
    """blocks: [(dimension name, DataFrame from `mom15_diag.slice_pair`)] -> one forest plot. The dot and whisker are the TEST entries' net per entry (cluster 95%), the ink tick the same level over every day read."""
    rows = [(d, r) for d, t in blocks for _, r in t.iterrows()]
    n = len(rows)
    fig, (ax,) = LF.frame(max(4.0, 0.3 * n + 1.2), notes, question, window)
    ax.get_subplotspec().get_gridspec().update(left=0.27, right=0.87)
    y = np.arange(n)
    names = names or {}
    for i, (d, r) in enumerate(rows):
        v = float(r["test net"])
        col = GOOD if v >= 0 else BAD
        ax.errorbar([v], [i], xerr=[[v - float(r["test lo"])], [float(r["test hi"]) - v]], fmt="o", color=col, ecolor=N["ink2"], elinewidth=1.0, capsize=2.5, ms=6, zorder=4)
        ax.scatter([float(r["all net"])], [i], marker="|", s=110, color=N["ink"], zorder=5)
        ax.annotate(f"{int(r['test n'])} test, {int(r['all n'])} all", (1.0, i), xycoords=("axes fraction", "data"), xytext=(6, 0), textcoords="offset points", fontsize=7.5, color=N["ink2"], va="center", annotation_clip=False)
    ax.axvline(0, color=N["axis"], lw=1.0)
    lab = [f"{names.get(d, d)}: {r[d] if d in r.index else r.iloc[0]}" for d, r in rows]
    ax.set_yticks(y)
    ax.set_yticklabels(lab, fontsize=8.5)
    ax.invert_yaxis()
    last = None
    for i, (d, r) in enumerate(rows):
        if last is not None and d != last:
            ax.axhline(i - 0.5, color=N["grid"], lw=1.0, zorder=1)
        last = d
    ax.set_xlabel("net USD per entry on the TEST days (dot, 95% by slot); ink tick = the same level over every day read")
    return fig


def arms_fig(arm_terms, diffs, window, notes, question="Does the direction of the burst add anything to buying the token that is already ahead?"):
    """arm_terms: `mom15_diag.arm_terms`; diffs: {label: dict from arm_diff}. Edge before friction (green), friction (red), net (ink tick) for each arm."""
    fig, (ax, ax2) = LF.frame(3.8, notes, question, window, ncols=2, wspace=0.28, ratios=None)
    k = np.arange(len(arm_terms))
    names = {"momentum": "the burst's side", "leader": "the side already ahead", "coin": "a fair coin"}
    ax.bar(k - 0.19, arm_terms["edge"], width=0.36, color=[GOOD if v >= 0 else BAD for v in arm_terms["edge"]], zorder=3)
    ax.bar(k + 0.19, arm_terms["friction"], width=0.36, color=BAD, zorder=3)
    ax.scatter(k, arm_terms["net"], marker="_", s=420, color=N["ink"], zorder=5, label="net (ink tick)")
    for i, r in arm_terms.iterrows():
        ax.annotate(f"{r['edge']:+.2f}", (i - 0.19, max(r["edge"], 0)), ha="center", va="bottom", fontsize=8, xytext=(0, 2), textcoords="offset points")
        ax.annotate(f"{r['friction']:+.2f}", (i + 0.19, r["friction"]), ha="center", va="top", fontsize=8, xytext=(0, -2), textcoords="offset points")
    ax.axhline(0, color=N["axis"], lw=1.0)
    ax.set_xticks(k)
    ax.set_xticklabels([f"{names.get(a, a)}\nnet {v:+.2f}" for a, v in zip(arm_terms["arm"], arm_terms["net"])], fontsize=8.5)
    ax.set_ylabel("USD an entry (left bar: edge before friction; right bar: friction)")
    ax.legend(loc="upper right", fontsize=8)
    labs = list(diffs)
    y = np.arange(len(labs))
    for i, lb in enumerate(labs):
        d = diffs[lb]
        ax2.errorbar([d["mean"]], [i], xerr=[[d["mean"] - d["lo"]], [d["hi"] - d["mean"]]], fmt="o", color=GOOD if d["mean"] >= 0 else BAD, ecolor=N["ink2"], elinewidth=1.0, capsize=3, ms=6, zorder=4)
        ax2.annotate(f"{d['mean']:+.2f}", (d["hi"], i), xytext=(6, 0), textcoords="offset points", fontsize=8, va="center")
    ax2.axvline(0, color=N["axis"], lw=1.0)
    ax2.set_yticks(y)
    ax2.set_yticklabels(labs, fontsize=8.5)
    ax2.invert_yaxis()
    ax2.set_xlabel("difference in net USD per entry, same windows (95% by slot)")
    return fig


def lookback_fig(ct, window, notes, question="Does a slower move leave more edge after the friction than the one-second burst?"):
    fig, (ax,) = LF.frame(3.8, notes, question, window)
    k = np.arange(len(ct))
    ax.bar(k - 0.19, ct["edge"], width=0.36, color=[GOOD if v >= 0 else BAD for v in ct["edge"]], zorder=3, label="edge before friction")
    ax.bar(k + 0.19, ct["friction"], width=0.36, color=BAD, zorder=3, label="friction (250 ms, spread and depth, fee)")
    ax.errorbar(k, ct["net"], yerr=[ct["net"] - ct["lo"], ct["hi"] - ct["net"]], fmt="_", ms=14, color=N["ink"], ecolor=N["ink2"], elinewidth=1.0, capsize=3, zorder=5, label="net (ink, 95% by slot)")
    ax.axhline(0, color=N["axis"], lw=1.0)
    ax.set_xticks(k)
    ax.set_xticklabels([c.split("|")[0].replace("s", " s") for c in ct["cell"]], fontsize=8.5)
    ax.set_xlabel("lookback of the signal")
    ax.set_ylabel("USD an entry")
    ax.legend(loc="lower right", fontsize=8)
    return fig


def hunt_fig(res, info, window, notes, question=None):
    n = info["n_hyp"]
    question = question or f"Does any of the {n} slices and signal cells clear the line that luck alone would reach?"
    fig, (ax,) = LF.frame(4.0, notes, question, window)
    ax.get_subplotspec().get_gridspec().update(right=0.84)
    t = np.sort(res["t"].to_numpy(float))[::-1]
    x = np.arange(1, len(t) + 1)
    ax.scatter(x, t, s=11, color=N["muted"], zorder=3)
    ax.scatter(x[:5], t[:5], s=26, color=N["ink"], zorder=4)
    LF.thresh(ax, 1.645, "one-sided 5%, one test")
    LF.thresh(ax, info["q95_best_t"], f"best of {n}, 5% by luck")
    ax.axhline(0, color=N["axis"], lw=1.0)
    ax.set(xlabel="slices and cells, best first", ylabel="t of the net per entry (cluster by slot)")
    ax.set_xlim(0, len(t) + 1)
    return fig


def holdout_fig(res, window, notes, k: int = 10, question="Do the slices that looked best before the test days still earn on them?"):
    ok = res[(res["disc_n"] >= 20) & (res["hold_n"] >= 20)]
    top = ok.sort_values("disc_t", ascending=False).head(k)
    fig, (ax,) = LF.frame(4.2, notes, question, window)
    ax.scatter(ok["disc_per"], ok["hold_per"], s=12, color=N["muted"], zorder=3, label=f"each of the {len(ok)} slices and cells")
    ax.scatter(top["disc_per"], top["hold_per"], s=34, color=N["ink"], zorder=4, label=f"the {len(top)} best on the days before")
    ax.axhline(0, color=N["axis"], lw=1.0)
    ax.axvline(0, color=N["axis"], lw=1.0)
    ax.set(xlabel="net USD per entry on the days before the test days (where each was found)", ylabel="net USD per entry on the test days and the fresh day")
    ax.legend(loc="lower right", fontsize=8)
    return fig


def drift_fig(fwd, window, notes, question="Does the market keep moving our way after we buy, and by how much?"):
    fig, axes = LF.frame(3.6, notes, question, window, ncols=2, wspace=0.22)
    for ax, src, unit in zip(axes, ("Binance mid", "token mid"), ("basis points", "cents")):
        d = fwd[fwd["source"] == src]
        k = np.arange(len(d))
        v = d["mean"].to_numpy(float)
        ax.bar(k, v, width=0.55, color=[GOOD if x >= 0 else BAD for x in v], zorder=3)
        ax.errorbar(k, v, yerr=[v - d["lo"].to_numpy(float), d["hi"].to_numpy(float) - v], fmt="none", color=N["ink2"], ecolor=N["ink2"], elinewidth=1.0, capsize=3, zorder=4)
        for i, x in enumerate(v):
            ax.annotate(f"{x:+.2f}", (i, 0), ha="center", va="bottom", fontsize=8.5, color=N["ink"], xytext=(0, 4), textcoords="offset points")
        ax.axhline(0, color=N["axis"], lw=1.0)
        ax.set_xticks(k)
        ax.set_xticklabels(d["after"], fontsize=9)
        ax.set_title(f"{src}, in our direction ({unit})", fontsize=9.5)
        ax.set_ylabel(unit)
    return fig


def weeks_fig(wk, days, window, notes, question="Does the split of an entry into edge and friction hold in every week?"):
    """wk: DataFrame (period, edge, edge_lo, edge_hi, friction, net, net_lo, net_hi), the last row the whole window; days: DataFrame (date, edge, net) by day.
    Left: per period the edge before friction (green above zero) and the friction (red) as bars, the net as an ink dot with its 95% interval over slots, zero as the ink dotted line.
    Right: per day the net per entry as bars (green above zero, red below) and the edge as an ink dot, so one good or bad day cannot pass for a week."""
    fig, (a, b) = LF.frame(4.3, notes, question, window, ncols=2, wspace=0.18, ratios=None)
    x = np.arange(len(wk))
    w = 0.26
    a.bar(x - w, wk["edge"], width=w, color=[GOOD if v > 0 else BAD for v in wk["edge"]], alpha=0.8, zorder=3, label="edge before friction")
    a.bar(x, wk["friction"], width=w, color=BAD, alpha=0.45, zorder=3, label="friction")
    a.errorbar(x - w, wk["edge"], yerr=[wk["edge"] - wk["edge_lo"], wk["edge_hi"] - wk["edge"]], fmt="none", color=N["ink2"], ecolor=N["ink2"], elinewidth=1.1, capsize=3, zorder=5)
    a.errorbar(x + w, wk["net"], yerr=[wk["net"] - wk["net_lo"], wk["net_hi"] - wk["net"]], fmt="o", color=N["ink"], ecolor=N["ink"], ms=5, elinewidth=1.3, capsize=3, zorder=6, label="net (95% by slot)")
    a.axhline(0, color=N["ink"], linewidth=1.1, linestyle=(0, (1, 2.4)), zorder=2)
    a.set_xticks(x); a.set_xticklabels([str(p).replace(" (", chr(10) + "(") for p in wk["period"]], fontsize=8.5)
    a.set_ylabel("USD an entry")
    y0, y1 = a.get_ylim()
    a.set_ylim(y0 - 0.18 * (y1 - y0), y1)
    a.legend(loc="lower left", fontsize=8.5, frameon=False, ncol=3)
    d = np.arange(len(days))
    b.bar(d, days["net"], width=0.7, color=[GOOD if v > 0 else BAD for v in days["net"]], alpha=0.75, zorder=3, label="net per entry")
    b.scatter(d, days["edge"], s=22, color=N["ink"], zorder=5, label="edge before friction")
    b.axhline(0, color=N["ink"], linewidth=1.1, linestyle=(0, (1, 2.4)), zorder=2)
    b.set_xticks(d[:: max(1, len(d) // 11)]); b.set_xticklabels([str(v)[5:] for v in days["date"]][:: max(1, len(d) // 11)], fontsize=8, rotation=45)
    b.set_ylabel("USD an entry"); b.set_xlabel("day (UTC)")
    y0, y1 = b.get_ylim()
    b.set_ylim(y0 - 0.15 * (y1 - y0), y1)
    b.legend(loc="lower left", fontsize=8.5, frameon=False, ncol=2)
    return fig

