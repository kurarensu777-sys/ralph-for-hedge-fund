"""The out-of-sample and luck figures of a fixed rule (um-021 S5 blocks, 2026-10-11): matplotlib and `fundplat.quant.core.figstyle` only, on the palette of
`lift_figs`. Each function takes what `tf15_oos` returns and draws one figure under the figure rules (a question for a title, the window and hours under it,
findings below, one meaning per colour, solid series, one table).

    oos2w_fig    two weeks against two weeks: each block's cumulative PnL from zero over time before the taker fee (solid) and after it (ink dotted), the blocks' net an entry against the in-sample forecast band
    folds_fig    week against week: each fold's in-sample and out-of-sample net an entry, and the in-sample mean against the out-of-sample mean
    random_fig   the observed net an entry against one or two randomised nulls (a panel a null)
    block_notes, fold_notes, random_rows, burst_rows   the computed findings and the nulls' table each figure carries

Colours: in-sample muted grey, out-of-sample ink, a gain or PASS green, a loss or FAIL red, a null the quantity colour `fees`, thresholds ink and dotted.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Patch

import lift_figs as LF
from fundplat.quant.core import figstyle as fs

N = LF.N
GOOD, BAD = LF.GOOD, LF.BAD
INK, MUTED = N["ink"], N["muted"]
NULL = fs.QUANTITY["fees"]
V_TINT = {"PASS": "green", "FAIL": "rose", "thin": "rose"}


def _canvas(notes, question, window, h_chart, n_tab_rows, ncols=2, widths=(2.3, 1.0), legend_above=0.0, legend_below=0.85, wspace=0.26, title_room=0.3,
            h_top=0.0, gap_top=1.3):
    """A figure of one row of `ncols` panels over one table over the findings; with `h_top` a full-width panel of that height sits above the row,
    `gap_top` inches over it. -> fig, axes (the top panel first when there is one), the table's axes."""
    nb = fs.nlines(notes)
    top_in = 0.85 + title_room + legend_above
    tab_in = 0.27 * (n_tab_rows + 1) + 0.05
    bot_in = 0.12 + nb * fs.LINE_IN + 0.30
    extra = h_top + gap_top if h_top else 0.0
    H = top_in + extra + h_chart + legend_below + tab_in + bot_in
    fig = plt.figure(figsize=(13, H))
    top = 1 - top_in / H
    a_top = None
    if h_top:
        a_top = fig.add_axes([0.07, top - h_top / H, 0.88, h_top / H])
        top -= extra / H
    cb = top - h_chart / H
    gs = fig.add_gridspec(1, ncols, left=0.07, right=0.95, top=top, bottom=cb, wspace=wspace, width_ratios=list(widths)[:ncols])
    axes = ([a_top] if a_top is not None else []) + [fig.add_subplot(gs[0, j]) for j in range(ncols)]
    axt = fig.add_axes([0.07, bot_in / H, 0.88, tab_in / H])
    axt.axis("off")
    fig.suptitle(question, x=0.07, y=1 - 0.18 / H, ha="left", va="top", fontsize=11.5, fontweight="bold", color=INK)
    fig.text(0.07, 1 - 0.58 / H, window, ha="left", va="top", fontsize=8.5, color=MUTED)
    fs.bullets(fig, notes, bottom_in=0.12)
    return fig, axes, axt


def _colw(tb, ws):
    """Set each column's width (fractions of the table's width, one a column)."""
    for (r, c), cell in tb.get_celld().items():
        cell.set_width(ws[c])


def _day_dt(d):
    return datetime.strptime(d, "%Y-%m-%d")


def _times(e):
    return np.array([datetime.fromtimestamp(int(s) * 900 + 900, tz=timezone.utc).replace(tzinfo=None) for s in e["slot"]], dtype=object)


def _f(v, d=3, sign=True):
    return "n/a" if v is None or not np.isfinite(v) else (f"{v:+.{d}f}" if sign else f"{v:.{d}f}")


def _verdict_col(v):
    return GOOD if v == "PASS" else BAD if v in ("FAIL", "thin") else MUTED


DOT = (0, (1, 2.4))                 # the after-fee path, ink and dotted, as in tf15_trade_figs


def _gross(e):
    """Each entry's PnL before the taker fee (payoff less cost), or None when the entries carry neither."""
    if "gross" in e:
        return np.asarray(e["gross"], float)
    if "payoff" in e and "cost" in e:
        return np.asarray(e["payoff"], float) - np.asarray(e["cost"], float)
    return None


def _segment(a, xs, gross, c_net, col, tail=False):
    """One segment's cumulative paths stepped over time from zero: before the taker fee solid in `col`, after it (`c_net`, already cumulated) ink and dotted;
    without a gross the net alone, solid in `col`. `tail` repeats the last level to the segment's end (xs carries one more point than the entries). -> the solid path."""
    if gross is None:
        a.step(xs, c_net, where="post", color=col, lw=2.0, zorder=4)
        return c_net
    cg = np.concatenate([[0.0], np.cumsum(gross)])
    if tail:
        cg = np.concatenate([cg, cg[-1:]])
    a.step(xs, cg, where="post", color=col, lw=1.8, zorder=4)
    a.step(xs, c_net, where="post", color=INK, lw=1.4, ls=DOT, zorder=5)
    return cg


def oos2w_fig(e, days, reads, notes, question, window):
    """Left: each block's cumulative PnL from zero against time before the taker fee (solid: in-sample muted, out-of-sample ink) and after it (ink dotted), green or red fill between the after-fee path and zero by sign, an ink vertical
    at each split, the out-of-sample days shaded; each block's verdict over it. Right: each block's net an entry with its 95% slot interval and the net without the
    best 5% (a diamond), the in-sample forecast interval as a band, zero as the decision line. Under them one table, a row a block."""
    rows = []
    for r in reads:
        s = r["s"]
        rows.append([f"{r['name']} ({r['n_days']} days)", f"{r['first'][5:]} to {r['last'][5:]}", f"{s.get('n', 0):,}",
                     _f(s["win"] * 100 if s.get("n") else np.nan, 1, False), _f(s["win_needed"] * 100 if s.get("n") else np.nan, 1, False), _f(s["per"]),
                     f"{_f(s['per_lo'], 2)} to {_f(s['per_hi'], 2)}", _f(s["per_ex_top5"]), r["verdict"]])
    cols = ["Segment", "Days", "Entries", "Win %", "Win % needed", "Net an entry", "95% interval", "Net ex best 5%", "Verdict"]
    fig, (a1, a2), axt = _canvas(notes, question, window, 3.5, len(rows), legend_below=1.45)
    t = _times(e)
    net = np.asarray(e["net"], float)
    gross = _gross(e)
    day = np.asarray(e["day"])
    x_end = _day_dt(days[-1]) + timedelta(days=1)
    lo_all, hi_all = 0.0, 0.0
    for r in reads:
        m = np.isin(day, r["idx"])
        t0, t1 = _day_dt(r["first"]), _day_dt(r["last"]) + timedelta(days=1)
        if r["role"] != "forecast":
            a1.axvspan(t0, t1, color=N["axis"], alpha=0.22, lw=0, zorder=0)
            a1.axvline(t0, color=INK, lw=1.2, zorder=3)
        xs = np.concatenate([[t0], t[m]])
        c = np.concatenate([[0.0], np.cumsum(net[m])])
        col = MUTED if r["role"] == "forecast" else INK
        cg = _segment(a1, xs, gross[m] if gross is not None else None, c, col)
        a1.fill_between(xs, c, 0, where=c >= 0, step="post", interpolate=True, color=GOOD, alpha=0.22, lw=0, zorder=2)
        a1.fill_between(xs, c, 0, where=c < 0, step="post", interpolate=True, color=BAD, alpha=0.32, lw=0, zorder=2)
        lo_all, hi_all = min(lo_all, float(c.min()), float(cg.min())), max(hi_all, float(c.max()), float(cg.max()))
        mid = t0 + (t1 - t0) / 2
        word = "forecast" if r["role"] == "forecast" else r["verdict"]
        a1.text(mid, 1.015, f"{r['name']} · {word}", transform=a1.get_xaxis_transform(), ha="center", va="bottom", fontsize=8.5,
                color=_verdict_col(r["verdict"]), weight="bold")
    a1.axhline(0, color=INK, ls=":", lw=1.3, zorder=3)
    a1.set_xlim(_day_dt(days[0]), x_end)
    pad = (hi_all - lo_all) * 0.08 or 1.0
    a1.set_ylim(lo_all - pad, hi_all + pad)
    a1.xaxis.set_major_locator(mdates.DayLocator(interval=7))
    a1.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d"))
    a1.set_ylabel("USD, cumulative, each block from zero")
    h1 = ([Line2D([], [], color=MUTED, lw=2.0, label="in-sample, before the taker fee (sets the forecast)"), Line2D([], [], color=INK, lw=2.0, label="out-of-sample, before the taker fee"),
           Line2D([], [], color=INK, lw=1.4, ls=DOT, label="after the taker fee (what we keep)")] if gross is not None else
          [Line2D([], [], color=MUTED, lw=2.0, label="in-sample net (sets the forecast)"), Line2D([], [], color=INK, lw=2.0, label="out-of-sample net")])
    h1 += [Patch(facecolor=N["axis"], alpha=0.22, label="out-of-sample days"), Patch(facecolor=GOOD, alpha=0.22, label="after the fee, above zero"),
           Patch(facecolor=BAD, alpha=0.32, label="after the fee, below zero"), Line2D([], [], color=INK, ls=":", lw=1.3, label="zero net after fees")]
    a1.legend(handles=h1, loc="upper center", bbox_to_anchor=(0.5, -0.1), ncol=3, fontsize=8, frameon=False)
    # right: the blocks' net an entry against the forecast band
    s0 = reads[0]["s"]
    x = np.arange(len(reads))
    if s0.get("n"):
        a2.axhspan(s0["per_lo"], s0["per_hi"], color=MUTED, alpha=0.18, lw=0, zorder=1)
    for i, r in enumerate(reads):
        s = r["s"]
        if not s.get("n"):
            continue
        col = MUTED if r["role"] == "forecast" else INK
        a2.errorbar([i], [s["per"]], yerr=[[s["per"] - s["per_lo"]], [s["per_hi"] - s["per"]]], fmt="o", ms=7, color=col, ecolor=col, elinewidth=1.4, capsize=5, zorder=4)
        a2.scatter([i + 0.18], [s["per_ex_top5"]], marker="D", s=34, color=N["ink2"], zorder=5)
        a2.text(i, s["per_hi"], f" n={s['n']:,}", ha="left", va="bottom", fontsize=7.5, color=N["ink2"])
    a2.axhline(0, color=INK, ls=":", lw=1.3, zorder=3)
    a2.set_xticks(x)
    a2.set_xticklabels([("in-sample" if r["role"] == "forecast" else r["name"].replace("out-of-sample", "OOS")) + f"\n{r['n_days']} days" for r in reads], fontsize=8)
    a2.set_xlim(-0.5, len(reads) - 0.4)
    a2.set_title("net an entry by block (95% by slot)", fontsize=9.5, loc="left")
    a2.set_ylabel("net USD an entry")
    h2 = [Line2D([], [], color=INK, marker="o", ls="", label="net an entry, 95% interval"), Line2D([], [], color=N["ink2"], marker="D", ls="", label="without the best 5%"),
          Patch(facecolor=MUTED, alpha=0.18, label="in-sample 95% interval (the forecast)")]
    a2.legend(handles=h2, loc="upper center", bbox_to_anchor=(0.5, -0.16), ncol=1, fontsize=8, frameon=False)
    tb = fs.put_table(axt, rows, cols, size=9)
    _colw(tb, [0.19, 0.11, 0.07, 0.07, 0.10, 0.10, 0.13, 0.11, 0.12])
    for i, r in enumerate(reads, 1):
        if r["verdict"] in V_TINT:
            fs.tint(tb, i, len(cols) - 1, V_TINT[r["verdict"]])
    if len(reads) > 1:
        fs.gold(tb, 2, 5)
    return fig


def _weeks(fr):
    """The weeks of the folds in order, each (day indices, label, verdict): week 1 is only ever in-sample, week i + 1 is fold i's out-of-sample week."""
    rows = fr["rows"]
    if not rows:
        return []
    out = [(rows[0]["idx_in"], "week 1 · forecast only", "forecast")]
    for i, r in enumerate(rows, 2):
        out.append((r["idx_out"], f"week {i} · {r['verdict']}" + (f" ({r['out_n_days']} days)" if r["out_n_days"] < 7 else ""), r["verdict"]))
    return out


def _weeks_panel(a, e, days, fr):
    """Each week's PnL cumulated from zero against time, before the taker fee solid and after it ink dotted, an ink vertical at every week boundary, the week's label over its segment; the segment ink when its
    week is read out of sample and PASS or FAIL, muted otherwise (the forecast-only first week, a thin week); green or red fill against zero by sign."""
    t = _times(e)
    net = np.asarray(e["net"], float)
    gross = _gross(e)
    day = np.asarray(e["day"])
    lo_all, hi_all = 0.0, 0.0
    ticks = []
    for idx, label, v in _weeks(fr):
        t0, t1 = _day_dt(days[idx[0]]), _day_dt(days[idx[-1]]) + timedelta(days=1)
        ticks.append(t0)
        m = np.isin(day, idx)
        xs = np.concatenate([[t0], t[m], [t1]])
        c = np.concatenate([[0.0], np.cumsum(net[m])])
        c = np.concatenate([c, c[-1:]])
        col = INK if v in ("PASS", "FAIL") else MUTED
        cg = _segment(a, xs, gross[m] if gross is not None else None, c, col, tail=True)
        a.fill_between(xs, c, 0, where=c >= 0, step="post", interpolate=True, color=GOOD, alpha=0.22, lw=0, zorder=2)
        a.fill_between(xs, c, 0, where=c < 0, step="post", interpolate=True, color=BAD, alpha=0.32, lw=0, zorder=2)
        a.axvline(t0, color=INK, lw=1.0, zorder=3)
        lo_all, hi_all = min(lo_all, float(c.min()), float(cg.min())), max(hi_all, float(c.max()), float(cg.max()))
        a.text(t0 + (t1 - t0) / 2, 1.02, label, transform=a.get_xaxis_transform(), ha="center", va="bottom", fontsize=8,
               color=_verdict_col(v) if v in ("PASS", "FAIL", "thin") else MUTED, weight="bold")
    x_end = _day_dt(days[-1]) + timedelta(days=1)
    a.axvline(x_end, color=INK, lw=1.0, zorder=3)
    a.axhline(0, color=INK, ls=":", lw=1.3, zorder=3)
    a.set_xlim(_day_dt(days[0]), x_end)
    pad = (hi_all - lo_all) * 0.10 or 1.0
    a.set_ylim(lo_all - pad, hi_all + pad)
    a.set_xticks(ticks + [x_end])
    a.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d"))
    a.set_ylabel("USD, each week from zero")
    if gross is not None:
        h = [Line2D([], [], color=INK, lw=1.8, label="before the taker fee, week read out of sample"), Line2D([], [], color=MUTED, lw=1.8, label="before the fee, forecast-only or thin week"),
             Line2D([], [], color=INK, lw=1.4, ls=DOT, label="after the taker fee (what we keep)")]
    else:
        h = [Line2D([], [], color=INK, lw=2.0, label="week read out of sample (PASS or FAIL)"), Line2D([], [], color=MUTED, lw=2.0, label="forecast-only week or thin week")]
    h += [Patch(facecolor=GOOD, alpha=0.22, label="after the fee, above zero"), Patch(facecolor=BAD, alpha=0.32, label="after the fee, below zero"),
          Line2D([], [], color=INK, ls=":", lw=1.3, label="zero net after fees")]
    a.legend(handles=h, loc="upper center", bbox_to_anchor=(0.5, -0.13), ncol=3, fontsize=8, frameon=False)


def folds_fig(e, days, fr, notes, question, window):
    """Top, across the width: each week's PnL cumulated from zero over the window before the taker fee (solid) and after it (ink dotted), the week boundaries in ink, each week's label and verdict over it.
    Left: per fold the in-sample week's net an entry (muted) and the out-of-sample week's (ink) with 95% slot intervals, joined, zero as the decision line.
    Right: the in-sample fold mean against the out-of-sample fold mean, a point a fold (green consistent, red not), the 45-degree line, zero lines and the pooled
    out-of-sample (a diamond with its interval). Under them one table, a row a fold."""
    rows = fr["rows"]
    tab = []
    for r in rows:
        si, so = r["s_in"], r["s_out"]
        tab.append([str(r["fold"]), r["in_days"], r["out_days"] + (f" ({r['out_n_days']} days)" if r["out_n_days"] < 7 else ""), f"{si.get('n', 0):,}", _f(si["per"]),
                    f"{so.get('n', 0):,}", _f(so["per"]), _f(so["per_ex_top5"]), r["verdict"]])
    cols = ["Fold", "In-sample week", "Out-of-sample week", "In n", "In net an entry", "Out n", "Out net an entry", "Out ex best 5%", "Verdict"]
    fig, (a0, a1, a2), axt = _canvas(notes, question, window, 3.5, len(tab), widths=(1.6, 1.0), wspace=0.22, legend_below=1.45, h_top=2.4, gap_top=1.55)
    _weeks_panel(a0, e, days, fr)
    x = np.arange(1, len(rows) + 1)
    for i, r in zip(x, rows):
        si, so = r["s_in"], r["s_out"]
        pts = []
        for dx, s, col in ((-0.14, si, MUTED), (0.14, so, INK)):
            if not s.get("n"):
                continue
            a1.errorbar([i + dx], [s["per"]], yerr=[[s["per"] - s["per_lo"]], [s["per_hi"] - s["per"]]], fmt="o", ms=6.5, color=col, ecolor=col, elinewidth=1.3, capsize=4, zorder=4)
            pts.append((i + dx, s["per"]))
        if len(pts) == 2:
            a1.plot([pts[0][0], pts[1][0]], [pts[0][1], pts[1][1]], color=N["axis"], lw=1.2, zorder=3)
        a1.text(i + 0.14, so["per_hi"] if so.get("n") else 0, f" {r['verdict']}", ha="left", va="bottom", fontsize=7.5, color=_verdict_col(r["verdict"]), weight="bold")
    a1.axhline(0, color=INK, ls=":", lw=1.3, zorder=3)
    a1.set_xticks(x)
    a1.set_xticklabels([f"fold {r['fold']}\nin {r['in_days']}\nout {r['out_days']}" for r in rows], fontsize=7.5)
    a1.set_xlim(0.4, len(rows) + 0.75)
    a1.set_title("net an entry, in-sample week then out-of-sample week (95% by slot)", fontsize=9.5, loc="left")
    a1.set_ylabel("net USD an entry")
    h1 = [Line2D([], [], color=MUTED, marker="o", ls="", label="in-sample week"), Line2D([], [], color=INK, marker="o", ls="", label="out-of-sample week"),
          Line2D([], [], color=INK, ls=":", lw=1.3, label="zero net after fees")]
    a1.legend(handles=h1, loc="upper center", bbox_to_anchor=(0.5, -0.24), ncol=3, fontsize=8, frameon=False)
    mi = np.array([r["s_in"]["per"] for r in rows], float)
    mo = np.array([r["s_out"]["per"] for r in rows], float)
    pl, pi = fr["pooled"], fr["pooled_in"]
    vals = np.concatenate([mi[np.isfinite(mi)], mo[np.isfinite(mo)], [pl.get("per_lo", 0) if pl.get("n") else 0, pl.get("per_hi", 0) if pl.get("n") else 0, 0.0]])
    lo, hi = float(np.nanmin(vals)), float(np.nanmax(vals))
    pad = (hi - lo) * 0.12 or 1.0
    lo, hi = lo - pad, hi + pad
    a2.plot([lo, hi], [lo, hi], color=INK, ls=":", lw=1.3, zorder=2)
    a2.axhline(0, color=N["axis"], lw=1.0, zorder=1)
    a2.axvline(0, color=N["axis"], lw=1.0, zorder=1)
    for r, xi, yi in zip(rows, mi, mo):
        if np.isfinite(xi) and np.isfinite(yi):
            a2.scatter([xi], [yi], s=60, color=_verdict_col(r["verdict"]), edgecolors=INK, linewidths=0.6, zorder=4)
            a2.annotate(str(r["fold"]), (xi, yi), xytext=(5, 4), textcoords="offset points", fontsize=8.5, color=INK, weight="bold")
    if pl.get("n") and pi.get("n"):
        a2.errorbar([pi["per"]], [pl["per"]], yerr=[[pl["per"] - pl["per_lo"]], [pl["per_hi"] - pl["per"]]], fmt="D", ms=8, color=INK, ecolor=INK, elinewidth=1.3, capsize=4, zorder=5)
    a2.set_xlim(lo, hi)
    a2.set_ylim(lo, hi)
    a2.set_title("in-sample mean against out-of-sample mean", fontsize=9.5, loc="left")
    a2.set_xlabel("in-sample week, net USD an entry")
    a2.set_ylabel("out-of-sample week, net USD an entry")
    h2 = [Line2D([], [], color=GOOD, marker="o", ls="", label="fold consistent"), Line2D([], [], color=BAD, marker="o", ls="", label="fold not consistent or thin"),
          Line2D([], [], color=INK, marker="D", ls="", label="pooled out-of-sample (95%)"), Line2D([], [], color=INK, ls=":", lw=1.3, label="out = in")]
    a2.legend(handles=h2, loc="upper center", bbox_to_anchor=(0.5, -0.17), ncol=2, fontsize=8, frameon=False)
    tb = fs.put_table(axt, tab, cols, size=9)
    _colw(tb, [0.05, 0.12, 0.17, 0.07, 0.12, 0.07, 0.13, 0.13, 0.14])
    for i, r in enumerate(rows, 1):
        fs.tint(tb, i, len(cols) - 1, V_TINT.get(r["verdict"], "rose"))
    return fig


def random_fig(nulls, tests, notes, question, window, colw=(0.30, 0.46, 0.11, 0.13)):
    """One panel a null, side by side: the null's net an entry as the grey histogram (40 bins), the observed value as a solid ink vertical, the null's 90th
    percentile (where p = 0.10) ink and dotted; the legend above each panel with the draws, the observed value and the one-sided p. Under them one four-column
    table: Test, Reading, Gate, Verdict (a row whose verdict is neither PASS nor FAIL is a reading, not a gate, and stays untinted). `nulls` is a list of
    dict(name, null, observed, p); `colw` the table's column widths."""
    fig, axes, axt = _canvas(notes, question, window, 2.9, len(tests), ncols=len(nulls), widths=(1.0,) * len(nulls), legend_above=0.62, legend_below=0.6,
                             wspace=0.18, title_room=0.1)
    for a, nl in zip(axes, nulls):
        v = np.asarray(nl["null"], float)
        v = v[np.isfinite(v)]
        obs = float(nl["observed"])
        lo, hi = min(float(v.min()), obs), max(float(v.max()), obs)
        pad = (hi - lo) * 0.06 or 0.1
        a.hist(v, bins=40, color=NULL, alpha=0.8, label=f"{nl['name']} ({len(v):,} draws)", zorder=3)
        q90 = float(np.quantile(v, 0.90))
        a.axvline(q90, color=INK, ls=":", lw=1.3, zorder=4, label=f"the null's 90th percentile {q90:+.3f} (p = 0.10)")
        a.axvline(obs, color=INK, lw=2.6, zorder=5, label=f"observed {obs:+.3f}, one-sided p {nl['p']:.4f}")
        a.set_xlim(lo - pad, hi + pad)
        a.set_xlabel("net USD an entry")
        a.set_ylabel("draws")
        a.legend(loc="lower left", bbox_to_anchor=(0, 1.0), fontsize=8, frameon=False)
    tb = fs.put_table(axt, tests, ["Test", "Reading", "Gate", "Verdict"], size=9)
    _colw(tb, list(colw))
    for i, r in enumerate(tests, 1):
        if r[3] in ("PASS", "FAIL"):
            fs.tint(tb, i, 3, "green" if r[3] == "PASS" else "rose")
    return fig


# ============================================================ the findings under each figure (computed; the notebook cell passes the reads)
NET_NOTE = "Solid lines are the PnL before the taker fee, dotted ink lines after it; every verdict and number here is after the fee."


def block_notes(reads, min_n=20):
    """One bullet a block (the forecast, then each out-of-sample block with its verdict and what would flip it), then the hurdle and the split."""
    f0 = reads[0]["s"]
    lo, hi = f0.get("per_lo", np.nan), f0.get("per_hi", np.nan)
    out = []
    nxt = next((r for r in reads if r["role"] != "forecast"), None)
    if nxt is not None and nxt["s"].get("n"):
        s1 = nxt["s"]
        span = f"The next {nxt['n_days']} days ({nxt['first'][5:]} to {nxt['last'][5:]}) net {s1['per']:+.3f} USD an entry on {s1['n']:,} entries"
        if nxt["verdict"] == "PASS":
            out.append(f"Yes. {span}, above zero and inside the {lo:+.2f} to {hi:+.2f} the first {reads[0]['n_days']} days forecast.")
        elif nxt["verdict"] == "thin":
            out.append(f"Too few entries to say. {span}, under {min_n}.")
        else:
            out.append(f"No. {span}, " + ("below zero" if s1["per"] <= 0 else "outside the forecast") + f"; the first {reads[0]['n_days']} days forecast {lo:+.2f} to {hi:+.2f}.")
    for r in reads:
        s = r["s"]
        head = f"{r['name'].capitalize()}, {r['first'][5:]} to {r['last'][5:]} ({r['n_days']} days): {s.get('n', 0):,} entries"
        if not s.get("n"):
            out.append(head + ", so there is nothing to read.")
            continue
        head += f", {s['per']:+.3f} USD an entry (95% by slot {s['per_lo']:+.2f} to {s['per_hi']:+.2f}), {s['per_ex_top5']:+.3f} without the best 5%"
        floor = max(0.0, lo)
        if r["role"] == "forecast":
            out.append(head + ": the forecast.")
        elif r["verdict"] == "thin":
            out.append(head + f": thin, under {min_n} entries, not a pass.")
        elif r["verdict"] == "PASS":
            m = min(s["per"] - floor, hi - s["per"])
            out.append(head + f": PASS, above zero and inside the forecast; it flips if the net an entry moves {m:.3f} (about {m * s['n']:,.0f} USD over its entries).")
        else:
            why = "below zero" if s["per"] <= 0 else ("under the forecast's interval" if s["per"] < lo else "above the forecast's interval")
            d = floor - s["per"] if s["per"] < floor else s["per"] - hi
            out.append(head + f": FAIL, {why}; it would pass if the net an entry moved {d:.3f} (about {d * s['n']:,.0f} USD over its entries) into {floor:+.2f} to {hi:+.2f}.")
    return out + [NET_NOTE, "The hurdle is zero net after fees. The blocks are cut by date, not on the results."]


def fold_notes(fr, days, week=7, min_n=20):
    """The folds' summary statistics as bullets: folds above zero and consistent, the pooled out-of-sample, the rank correlation, the short last week."""
    pl, last = fr["pooled"], fr["rows"][-1]
    pooled = (f"Pooled out-of-sample (every out-of-sample week together, {days[week][5:]} to {days[-1][5:]}): {pl['n']:,} entries, {pl['per']:+.3f} USD an entry "
              f"(95% by slot {pl['per_lo']:+.2f} to {pl['per_hi']:+.2f}), {pl['per_ex_top5']:+.3f} without the best 5%; "
              + ("the interval clears zero." if pl["per_lo"] > 0 else "the interval spans zero." if pl["per_hi"] > 0 else "the interval is below zero.")) if pl.get("n") else "No out-of-sample entry."
    head = (f"{'Yes' if pl.get('n') and pl['per'] > 0 and fr['consistent'] * 2 > fr['n_folds'] else 'Not clearly'}. {fr['above']} of {fr['n_folds']} weeks net above zero after the week before, "
            f"and {fr['consistent']} of {fr['n_folds']} agree with it (at least {min_n} entries, above zero, inside the earlier week's 95% interval)"
            + (f"; {fr['thin']} too thin to count." if fr["thin"] else "."))
    return [head, pooled, NET_NOTE,
            f"The last week has {last['out_n_days']} days ({last['out_days']}), the days left after the last full week.",
            "Each week's net: " + "; ".join(f"week {i} ({d}) {s.get('net', 0.0):+,.0f} USD on {s.get('n', 0):,} entries" for i, (d, s) in
                                            enumerate([(fr["rows"][0]["in_days"], fr["rows"][0]["s_in"])] + [(r["out_days"], r["s_out"]) for r in fr["rows"]], 1)) + "."]


def random_rows(s, rs, rm, p, draws, gate, t_min, agree_n):
    """The four-column table and the bullets of the randomised nulls. `s` the test's summary, `rs` and `rm` what `tf15_oos.random_side` and `random_moment`
    return, `p` = (p side, p moment, p side without the best 5%), `agree_n` = (entries in the side replay, entries in the moment replay). -> (rows, notes)."""
    obs, obs5 = float(s["per"]), float(s["per_ex_top5"])
    p_s, p_m, p_5 = p
    med_s, med_m, med_5 = float(np.nanmedian(rs["per"])), float(np.nanmedian(rm["per"])), float(np.nanmedian(rs["ex5"]))
    ps = lambda v: f"{v:.4f}" + (" (the floor)" if v <= 1 / (draws + 1) + 1e-12 else "")       # noqa: E731
    vd = lambda v: "PASS" if v < gate else "FAIL"                                              # noqa: E731
    rows = [["Random side", f"{obs:+.3f} an entry against a null median {med_s:+.3f}; p {ps(p_s)}", f"p < {gate:.2f}", vd(p_s)],
            ["Random moment", f"{obs:+.3f} an entry against a null median {med_m:+.3f}; p {ps(p_m)}", f"p < {gate:.2f}", vd(p_m)],
            ["Random side, ex best 5%", f"{obs5:+.3f} an entry against a null median {med_5:+.3f}; p {ps(p_5)}", f"p < {gate:.2f}", vd(p_5)]]
    notes = [f"Random side: p {ps(p_s)} on {draws:,} draws. The null keeps the test's own decision seconds and clip and flips the side ({rs['n'].mean():,.0f} entries a draw "
             f"on average against the test's {s['n']:,}): " + ("the burst's direction carries information." if p_s < gate else "the direction adds nothing a coin flip does not."),
             f"Random moment: p {ps(p_m)}. The null puts the test's count of entries in each day and coin at a random window, a random second with at least {t_min} s left and a "
             f"random side ({rm['tried'].mean():,.0f} tried and {rm['n'].mean():,.0f} filled a draw on average): "
             + ("the rule beats bets placed at random." if p_m < gate else "the rule does not beat bets placed at random."),
             f"Without the best 5% (ex best 5%) the test nets {obs5:+.3f} an entry against a random-side null median of {med_5:+.3f}: p {ps(p_5)}.",
             "Days are not shifted here: the signal lives inside one 15-minute window, so moving a day's entries to another day breaks nothing the rule depends on; "
             f"the entries are randomised instead. A p at the floor 1/{draws + 1:,} means no draw reached the observed value, not that p is zero.",
             f"Both nulls replay one draw through the engine on the dense window-by-second matrices and agree with the fast path ({agree_n[0]:,} and {agree_n[1]:,} entries)."]
    return rows, notes


BURST_COLW = (0.53, 0.28, 0.08, 0.11)          # the burst table's columns: the coin-flip row's name is long
COINFLIP = "coin-flip side (buys the far token: measures the price gate, not the burst)"


def burst_rows(lab, s, e_ask, rb, rs, p, draws, gate, t_min, agree):
    """The table and the bullets of test `lab`'s nulls since the accounting audit (2026-10-11): the random-burst null is the gate, the coin-flip side a reading.
    `s` the test's summary, `e_ask` the asks its entries saw, `rb` what `tf15_oos.random_burst` returns (None for D), `rs` what `random_side` returns,
    `p` = dict(burst, burst_ex5, side, side_ex5), `agree` = dict(burst, side) of (agree, n) or the `burst_agrees` dict. -> (rows, notes)."""
    obs, obs5 = float(s["per"]), float(s["per_ex_top5"])
    ps = lambda v: "n/a" if not np.isfinite(v) else f"{v:.4f}" + (" (the floor)" if v <= 1 / (draws + 1) + 1e-12 else "")       # noqa: E731
    vd = lambda v: "PASS" if np.isfinite(v) and v < gate else "FAIL"                                                              # noqa: E731
    pt = lambda v: "n/a" if not np.isfinite(v) else f"{v:.4f}"                                                                    # noqa: E731 (the table: the floor is named in the bullets)
    med = lambda a: float(np.nanmedian(a))                                                                                         # noqa: E731
    rows, notes = [], []
    if rb is not None:
        rows += [["Random burst", f"{obs:+.3f} against null median {med(rb['per']):+.3f}; p {pt(p['burst'])}", f"p < {gate:.2f}", vd(p["burst"])],
                 ["Random burst, ex best 5%", f"{obs5:+.3f} against null median {med(rb['ex5']):+.3f}; p {pt(p['burst_ex5'])}", f"p < {gate:.2f}", vd(p["burst_ex5"])]]
        if rb["how"] == "moment":
            pool = f"random seconds with at least {t_min} s left, a coin-flip side (test {lab} has no price gate, so the time mask is all it shares)"
        else:
            pool = f"random seconds that pass every condition of test {lab} except the burst ({rb['cells']:,} cells with at least {t_min} s left), one entry a window"
        notes.append(f"{'Yes' if vd(p['burst']) == 'PASS' else 'No'}. Test {lab} nets {obs:+.3f} USD an entry against a median {med(rb['per']):+.3f} for the same number of entries "
                     f"at {pool}: p {ps(p['burst'])} on {draws:,} draws, so " + ("the burst's direction adds to the net." if vd(p["burst"]) == "PASS" else
                                                                                "the burst's direction adds nothing a random second does not."))
        notes.append(f"Without the best 5% it nets {obs5:+.3f} an entry (95% by slot {s['per_ex_top5_lo']:+.2f} to {s['per_ex_top5_hi']:+.2f}) against a "
                     f"median {med(rb['ex5']):+.3f}: p {ps(p['burst_ex5'])}.")
    else:
        notes.append(f"{'Yes' if vd(p['side']) == 'PASS' else 'No'}. Test {lab} has no burst, so only a coin flip for the side to buy is drawn: it nets {obs:+.3f} USD an entry "
                     f"against a median {med(rs['per']):+.3f} (p {ps(p['side'])} on {draws:,} draws).")
    rows.append([COINFLIP[0].upper() + COINFLIP[1:], f"{obs:+.3f} against null median {med(rs['per']):+.3f}; p {pt(p['side'])}", "not a gate", "reading"])
    gated = rb is None or rb["how"] == "pool"
    notes.append(f"Coin-flip side (a reading, not a gate): p {ps(p['side'])}. It flips the side at the test's own seconds ({rs['n'].mean():,.0f} entries a draw against "
                 f"the test's {s['n']:,}); "
                 + ("it buys the far token, which sits over its fair value wherever the near one passes, so it measures the price gate, not the burst." if gated else
                    f"test {lab} has no price gate, so the flip buys the token the burst points away from."))
    price = [f"the rule {np.mean(e_ask):.3f} and {s['fee_per']:.3f} USD"]
    if rb is not None:
        price.append(f"the random burst {np.nanmean(rb['ask']):.3f} and {np.nanmean(rb['fee']):.3f}")
    price.append(f"the coin-flip side {np.nanmean(rs['ask']):.3f} and {np.nanmean(rs['fee']):.3f}")
    notes.append("Mean ask and mean taker fee an entry: " + "; ".join(price) + ".")
    notes.append(f"A p at the floor 1/{draws + 1:,} means no draw reached the observed value, not that p is zero.")
    ag = [f"the coin-flip side ({agree['side'][1]:,} entries)"]
    if agree.get("burst") is not None:
        ag.insert(0, f"the random burst ({agree['burst']['n']:,} entries)")
    notes.append("One draw of each null replayed through the engine matches the fast path: " + " and ".join(ag) + ".")
    return rows, notes
