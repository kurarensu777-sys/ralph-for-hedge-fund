"""The stale-book study (um-023, 2026-10-11): test E of um-021 read as a full strategy. numpy and pandas on the pooled table of `tf15_bt`, the registered grid
`tf15_cands.BuyNearStale`, figures on `fundplat.quant.core.figstyle` and the frames of `lift_figs`. No I/O.

THE RULE. E is rule A (a 10 s Binance |z| of at least 3, the near token's ask more than theta under the driftless fair value, at least t_min seconds left, buy the
near token at no worse than its ask, hold to expiry, one entry a window) plus a book that has not moved: definition (a) the near ask equals the ask n seconds
earlier (`ask_still`, E as built), (b) it is unchanged at every second of the last n, (c) the ask and its size at the touch are unchanged at every second.
THE LIMIT. Two fill limits are read side by side, never chosen: the ask seen at the decision second (E as built: the fill takes what rests at or under it 250 ms
later and stops) and our edge price, fair value less theta (`fmax` with the ask seen, as `tf15_capacity` builds it), under which every level still carries the
edge the rule asks for.
THE GRID. `run_grid` scores every registered cell once on the pooled 38-day table and splits each cell's entries by day into train and validate (a cell has
nothing to fit, and one entry a window never crosses a day, so this equals running each split's table alone; `selftest` checks it on a fake table).
`choose` is `tf15_study.run_candidate`'s protocol with the net an entry without the best 5% as the score.
THE DELAY. `entries_delayed` moves every decision j whole seconds later before `tf15_bt.entries` fills it: on a table seated at 250 ms the order then meets the
ladder of second k + j, i.e. 1,000 x j + 250 ms after the decision (the engine's own fill path; `tf15_bt.entries`' `delay_extra_k` argument is accepted and
never read, so it cannot be used for this).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.lines import Line2D
from matplotlib.patches import Patch, Rectangle

import lift_figs as LF
import tf15_bt as B
import tf15_cands as C
import tf15_study as S
from fundplat.quant.core import figstyle as fs

N = LF.N
GOOD, BAD = LF.GOOD, LF.BAD
INK, INK2, MUTED = N["ink"], N["ink2"], N["muted"]
DEF_COL = {"a": fs.IDENTITY["MODEL"], "b": INK2, "c": MUTED}            # (a) is E as built, the study's own series; (b) and (c) the stricter readings
DEF_MK = {"a": "o", "b": "s", "c": "D"}
DEF_NAME = {"a": "(a) ask now = ask n s ago", "b": "(b) ask unchanged every second", "c": "(c) ask and size unchanged every second"}
RULE_COL = {"E": fs.IDENTITY["MODEL"], "cell": INK2, "A": MUTED}
RULE_MK = {"E": "o", "cell": "s", "A": "D"}
NAN = float("nan")


# ============================================================ entries and their numbers
def by_days(e, idx):
    """The entries whose day index is in `idx`."""
    return B.subset(e, np.isin(np.asarray(e["day"]), np.asarray(idx)))


def stats(e):
    """`tf15_bt.summarize` with the keys this study reads always present (NaN on no entry)."""
    s = B.summarize(e)
    if not s.get("n", 0):
        s = dict(n=0)
    for k in ("per", "per_lo", "per_hi", "per_ex_top5", "per_ex_top1", "win", "win_needed", "breakeven", "sd", "net", "gross_per", "fee_per", "top5_share"):
        s.setdefault(k, NAN)
    return s


def entries_delayed(tab, side, trig, lim, j=0, usd=B.CLIP_USD):
    """`tf15_bt.entries` with every decision moved j whole seconds later: the order of decision second k meets the ladder of column k + j (on a table seated at
    f ms that is 1,000 j + f ms after the decision), never above the limit the rule saw at k; one entry a window, a miss retries at the next decision. The rows
    keep the DECISION second in `k` and its seconds left in `T`."""
    if j <= 0:
        return B.entries(tab, side, trig, lim, usd)
    s2 = np.zeros_like(side)
    t2 = np.zeros_like(trig)
    l2 = np.full(lim.shape, np.nan)
    s2[:, j:], t2[:, j:], l2[:, j:] = side[:, :-j], trig[:, :-j], lim[:, :-j]
    e = B.entries(tab, s2, t2, l2, usd)
    e["k"] = np.asarray(e["k"]) - j
    e["T"] = tab.T[e["k"]] if len(e["k"]) else e["T"]
    return e


def limit_of(tab, cfg, side, lim, form):
    """The fill limit: `ask` the ask seen (the rule as built), `edge` our edge price fair value less theta, never under the ask seen (`tf15_capacity._rule`)."""
    if form == "ask":
        return lim
    pu = C.stale_cache(tab)["pu"]
    return np.fmax(lim, np.where(side > 0, pu - cfg["theta"], 1.0 - pu - cfg["theta"]))


def run_cell(cand, tab, cfg, form=None, usd=B.CLIP_USD, fee_mult=1.0, slip=0.0, delay_k=0):
    """One cell of `BuyNearStale` with a limit form (None: the cell's own `limit`, else the ask seen), a fee multiplier, a slippage allowance added to the
    limit (USD a share) and an extra delay in seconds."""
    form = form or cfg.get("limit", "ask")
    side, trig, lim, _ = cand.triggers(tab, cfg, {})
    lim = limit_of(tab, cfg, side, lim, form) + slip
    t = C._scaled_fee(tab, fee_mult) if fee_mult != 1.0 else tab
    return entries_delayed(t, side, trig, lim, delay_k, usd)


# ============================================================ the stale-window sweep (S3.2)
def sweep(cand, tab, roles, ns, base, forms=("ask", "edge")):
    """Every stale definition at every window n (n = 0 is rule A, the same for all three), everything else fixed at `base` (a cell dict), each limit form,
    read on the design days (train and validate) and the test days. -> dict (form, kind, n, part) -> stats."""
    out = {}
    design = np.concatenate([roles["train"], roles["validate"]])
    for form in forms:
        for kind in C.STALE_DEFS:
            for n in ns:
                if n == 0 and kind != "a":
                    for part in ("design", "test"):
                        out[(form, kind, 0, part)] = out[(form, "a", 0, part)]
                    continue
                e = run_cell(cand, tab, dict(base, kind=kind, n=int(n)), form)
                out[(form, kind, n, "design")] = stats(by_days(e, design))
                out[(form, kind, n, "test")] = stats(by_days(e, roles["test"]))
    return out


def sweep_notes(sw, form, ns, n_e=3):
    """The findings under one sweep figure: each definition's best window on the design days, E's window, and how each reads on the test days."""
    out = []
    for kind in C.STALE_DEFS:
        d = [(n, sw[(form, kind, n, "design")]) for n in ns]
        best = max(d, key=lambda t: t[1]["per_ex_top5"] if np.isfinite(t[1]["per_ex_top5"]) else -1e9)
        se, te = sw[(form, kind, n_e, "design")], sw[(form, kind, n_e, "test")]
        pos = [n for n, s in d if s["per_ex_top5"] > 0]
        out.append(f"{DEF_NAME[kind]}: at {n_e} s {se['per']:+.2f} USD an entry on {se['n']:,} design entries (95% {se['per_lo']:+.2f} to {se['per_hi']:+.2f}), "
                   f"{se['per_ex_top5']:+.2f} without the best 5%; the best design window is {best[0]} s ({best[1]['per_ex_top5']:+.2f} without the best 5%); "
                   + (f"positive without the best 5% at {', '.join(str(n) for n in pos)} s" if pos else "never positive without the best 5%")
                   + f"; on the test days {te['per']:+.2f} on {te['n']:,} at {n_e} s.")
    a0 = sw[(form, "a", 0, "design")]
    out.append(f"n = 0 is rule A with no stale condition: {a0['per']:+.2f} an entry on {a0['n']:,} design entries, {a0['per_ex_top5']:+.2f} without the best 5%. "
               "Each point is one rule read on the same days, so neighbouring windows share most of their entries: the curve's shape is one observation, not twelve.")
    return out


def sweep_fig(sw, form, ns, window, notes, n_e=3, question=None):
    """Four rows (net an entry with its 95% slot interval; the net without the best 5%; the entry count; the win rate less the rate the payoff needs, in
    points) by two columns (the design days, the test days), each definition a line in its identity colour against the window n; zero is the decision line
    and E's 3 s is marked."""
    lim_word = "the ask seen" if form == "ask" else "our edge price"
    q = question or f"How does the edge change with how long the book has not moved, with the limit at {lim_word}?"
    fig, axes = LF.frame(9.4, notes, q, window, ncols=2, nrows=4, hspace=0.42, wspace=0.16)
    rows = [("per", "net USD an entry (95% by slot)"), ("per_ex_top5", "net an entry without the best 5%"), ("n", "entries"),
            ("margin", "win rate less the rate needed, points")]
    x = np.asarray(ns, float)
    for c, part in enumerate(("design", "test")):
        for r, (key, lab) in enumerate(rows):
            ax = axes[2 * r + c]
            for kind in C.STALE_DEFS:
                ss = [sw[(form, kind, n, part)] for n in ns]
                if key == "margin":
                    y = np.array([(s["win"] - s["win_needed"]) * 100 if s.get("n") else NAN for s in ss])
                elif key == "n":
                    y = np.array([s.get("n", 0) for s in ss], float)
                else:
                    y = np.array([s[key] for s in ss], float)
                if key == "per":
                    lo = np.array([s["per_lo"] for s in ss], float)
                    hi = np.array([s["per_hi"] for s in ss], float)
                    ax.fill_between(x, lo, hi, color=DEF_COL[kind], alpha=0.13, lw=0, zorder=2)
                ax.plot(x, y, color=DEF_COL[kind], marker=DEF_MK[kind], ms=4, lw=1.7, zorder=4, label=DEF_NAME[kind])
            if key != "n":
                ax.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
            ax.axvline(n_e, color=INK, ls=":", lw=1.0, zorder=3)
            ax.set_ylabel(lab, fontsize=8)
            ax.set_xticks(x)
            ax.set_xticklabels([str(int(v)) for v in x])
            ax.tick_params(labelsize=7.5)
            if r == 0:
                ax.set_title(("design days (train and validate)" if part == "design" else "test days") + f" · limit at {lim_word}", fontsize=9.5, loc="left")
                ax.text(n_e, 0.97, f" E: {n_e} s", transform=ax.get_xaxis_transform(), ha="left", va="top", fontsize=7.5, color=INK)
            if r == 3:
                ax.set_xlabel("stale window n, seconds (0 = rule A, no stale condition)")
    h = [Line2D([], [], color=DEF_COL[k], marker=DEF_MK[k], lw=1.7, label=DEF_NAME[k]) for k in C.STALE_DEFS]
    h.append(Line2D([], [], color=INK, ls=":", lw=1.2, label="zero (decision line) and E's window"))
    axes[0].legend(handles=h, loc="lower left", bbox_to_anchor=(0.0, 1.13), ncol=4, fontsize=8, frameon=False)
    return fig


# ============================================================ the registered grid (S3.3)
GRID_KEYS = ("n", "per", "per_lo", "per_hi", "per_ex_top5", "win", "win_needed", "sd", "net", "breakeven")


def _light(s):
    return {k: (s.get(k, NAN) if k != "n" else int(s.get("n", 0))) for k in GRID_KEYS}


def run_grid(cand, tab, cells, roles, log=None):
    """Every cell once on the pooled table, its entries split by day into train and validate. -> list of dict(cfg, train, validate) of light stats."""
    rows = []
    for i, c in enumerate(cells):
        e = cand.run(tab, c, {})
        rows.append(dict(cfg=c, train=_light(stats(by_days(e, roles["train"]))), validate=_light(stats(by_days(e, roles["validate"])))))
        if log and (i + 1) % 200 == 0:
            log(f"  {i + 1} of {len(cells)} cells scored")
    return rows


def choose(rows, key="per_ex_top5", n_min=S.N_MIN):
    """`tf15_study.run_candidate`'s choice: among cells with at least n_min entries on train and validate, those whose train score is above zero; the best
    validate score among them (none: among all cells with enough entries, a miss by construction). -> (chosen row, qualified)."""
    sc = lambda s: s.get(key, NAN) if np.isfinite(s.get(key, NAN)) else -1e9                                    # noqa: E731
    ok = [r for r in rows if r["train"]["n"] >= n_min and r["validate"]["n"] >= n_min]
    pos = [r for r in ok if sc(r["train"]) > 0]
    pool = pos or ok or [r for r in rows if r["validate"]["n"] > 0] or rows
    return max(pool, key=lambda r: sc(r["validate"]) if r["validate"]["n"] else -1e9), bool(pos)


def deflated(rows, e_test):
    """The test Sharpe a entry and its deflation over every registered cell (the trial Sharpes are the cells' validate per / sd). -> (sharpe stats, dsr dict)."""
    srs = [r["validate"]["per"] / r["validate"]["sd"] for r in rows if r["validate"]["n"] > 2 and r["validate"]["sd"] > 0]
    if len(e_test["net"]) < 3:
        return None, None
    st = S.sharpe_stats(e_test["net"])
    return st, S.deflated_sharpe(st["sr"], st["n"], st["skew"], st["kurt"], srs, len(rows))


def grid_frame(rows):
    """One row a cell: its levels and its train and validate numbers."""
    out = []
    for r in rows:
        c, t, v = r["cfg"], r["train"], r["validate"]
        out.append(dict(cell=c["name"], kind=c["kind"], n_s=c["n"], theta=c["theta"], z=c["z_min"], L=c["L"], t_min=c["t_min"], band=c["band"],
                        train_n=t["n"], train_per=t["per"], train_ex5=t["per_ex_top5"], valid_n=v["n"], valid_per=v["per"], valid_lo=v["per_lo"],
                        valid_hi=v["per_hi"], valid_ex5=v["per_ex_top5"]))
    return pd.DataFrame(out)


def neighbours(cand, cfg):
    """The cells one level away from `cfg` in one dimension (the plateau), in the order of the grid's levels."""
    lv = cand.levels()
    out = []
    for d, levels in lv.items():
        i = list(levels).index(cfg[d])
        for j in (i - 1, i + 1):
            if 0 <= j < len(levels):
                out.append((d, levels[j], cand.cell(**{**{k: cfg[k] for k in lv}, d: levels[j]})))
    return out


def surface_grid(cand, tab, cfg, roles, part, key="per_ex_top5"):
    """The n x theta map at the chosen cell's other levels, read on `part` days: -> DataFrame (index n, columns theta) of `key`."""
    lv = cand.levels()
    g = pd.DataFrame(index=pd.Index(lv["n"], name="stale window n, s"), columns=pd.Index(lv["theta"], name="discount to fair value, USD a share"), dtype=float)
    for n in lv["n"]:
        for th in lv["theta"]:
            e = cand.run(tab, dict(cand.cell(**{**{k: cfg[k] for k in lv}, "n": n, "theta": th})), {})
            g.loc[n, th] = stats(by_days(e, roles[part]))[key]
    return g


def surface_fig(gv, gt, chosen, window, notes, question="Is the chosen setting on a broad plateau or on a lone spike?"):
    """Two heat maps (validation days, test days) of the net an entry without the best 5% over n x theta at the chosen cell's other levels, the value in each
    cell, the chosen cell outlined in ink and its neighbours in grey, a diverging scale around zero (green above, red below); one table under them; PASS or
    FAIL top right (the chosen cell and every neighbour above zero on the validation days)."""
    V = fs.VERDICT
    nb = fs.nlines(notes)
    H = 4.6 + 1.2 + 0.25 * 2 + nb * fs.LINE_IN + 0.9
    fig = plt.figure(figsize=(13, H))
    top = 1 - 1.35 / H
    tab_h = 0.62 / H
    bot = (0.12 + nb * fs.LINE_IN + 0.35) / H
    gs = fig.add_gridspec(1, 2, left=0.08, right=0.97, top=top, bottom=bot + tab_h + 0.75 / H, wspace=0.18)
    axs = [fig.add_subplot(gs[0, 0]), fig.add_subplot(gs[0, 1])]
    axt = fig.add_axes([0.08, bot, 0.89, tab_h])
    axt.axis("off")
    fig.suptitle(question, x=0.07, y=1 - 0.18 / H, ha="left", va="top", fontsize=11.5, fontweight="bold", color=INK)
    fig.text(0.07, 1 - 0.58 / H, window, ha="left", va="top", fontsize=8.5, color=MUTED)
    fs.bullets(fig, notes, bottom_in=0.12)
    span = float(np.nanmax(np.abs(np.concatenate([gv.to_numpy(float).ravel(), gt.to_numpy(float).ravel()])))) or 1.0
    cmap = LinearSegmentedColormap.from_list("g", [V["bad"], N["surface"], V["good"]])
    i, j = gv.index.get_loc(chosen[0]), gv.columns.get_loc(chosen[1])
    for ax, g, ttl in ((axs[0], gv, "validation days"), (axs[1], gt, "test days (read once)")):
        a = g.to_numpy(float)
        ax.imshow(a, cmap=cmap, vmin=-span, vmax=span, aspect="auto")
        ax.grid(False)
        for (r, c), v in np.ndenumerate(a):
            ax.text(c, r, "n/a" if not np.isfinite(v) else f"{v:+.2f}", ha="center", va="center", fontsize=8.5, color=INK)
        ax.add_patch(Rectangle((j - 1.5, i - 1.5), 3, 3, fill=False, edgecolor=INK2, linewidth=1.0))
        ax.add_patch(Rectangle((j - 0.5, i - 0.5), 1, 1, fill=False, edgecolor=INK, linewidth=2.6))
        ax.set_xticks(range(a.shape[1]))
        ax.set_xticklabels([f"{v:g}" for v in g.columns])
        ax.set_yticks(range(a.shape[0]))
        ax.set_yticklabels([str(v) for v in g.index])
        ax.set_xlabel(g.columns.name)
        ax.set_ylabel(g.index.name)
        ax.set_title(ttl + ": net an entry without the best 5%, USD", fontsize=9.5, loc="left")
    a = gv.to_numpy(float)
    nbv = [v for (r, c), v in np.ndenumerate(a) if abs(r - i) < 2 and abs(c - j) < 2 and (r, c) != (i, j) and np.isfinite(v)]
    ok = bool(nbv) and min([a[i, j], *nbv]) > 0
    fig.text(0.97, 1 - 0.58 / H, ("PASS: the chosen cell and its neighbours clear zero" if ok else "FAIL: a neighbour sits at or below zero") if nbv else "FAIL: no neighbour",
             ha="right", va="top", fontsize=9, color=V["good" if ok else "bad"], weight="bold")
    axs[0].legend(handles=[Patch(facecolor=V["good"], label="above zero"), Patch(facecolor=V["bad"], label="below zero"),
                           Patch(facecolor="none", edgecolor=INK, linewidth=2.2, label="chosen"), Patch(facecolor="none", edgecolor=INK2, label="neighbours")],
                  loc="lower left", bbox_to_anchor=(0, 1.07), ncol=4, fontsize=8, frameon=False)
    at = gt.to_numpy(float)
    nbt = [v for (r, c), v in np.ndenumerate(at) if abs(r - i) < 2 and abs(c - j) < 2 and (r, c) != (i, j) and np.isfinite(v)]
    f = lambda v: "n/a" if not np.isfinite(v) else f"{v:+.2f}"                                                       # noqa: E731
    cells = [["validation", f(a[i, j]), f(min(nbv)) if nbv else "-", f(np.mean(nbv)) if nbv else "-", f(np.nanmax(a)), f"{np.mean(a[np.isfinite(a)] > 0):.0%}", "0.00"],
             ["test", f(at[i, j]), f(min(nbt)) if nbt else "-", f(np.mean(nbt)) if nbt else "-", f(np.nanmax(at)), f"{np.mean(at[np.isfinite(at)] > 0):.0%}", "0.00"]]
    tb = fs.put_table(axt, cells, ["Days", "Chosen cell", "Worst neighbour", "Mean neighbour", "Best cell", "Share above zero", "Hurdle"], size=9)
    fs.tint(tb, 1, 2, "green" if ok else "rose")
    fs.gold(tb, 2, 1)
    return fig


def rules_fig(rules, days_test, window, notes, question="Does the chosen setting beat test E as built and rule A on the test days?"):
    """Left: each rule's net an entry on the test days with its 95% slot interval (bar green above zero, red below) and the net without the best 5% (ink
    diamond), zero as the decision line. Right: each rule's cumulative net on the test days entry by entry, in its identity colour. One table under them.
    `rules` maps a label ("E", "cell", "A") to (title, entries on the test days, stats)."""
    labs = list(rules)
    rows = []
    for lab in labs:
        t, e, s = rules[lab]
        d = np.bincount(np.asarray(e["day"]) - min(days_test), weights=np.asarray(e["net"], float), minlength=len(days_test)) if s.get("n") else np.zeros(len(days_test))
        rows.append([t, f"{s.get('n', 0):,}", f"{s['win'] * 100:.1f}" if s.get("n") else "n/a", f"{s['win_needed'] * 100:.1f}" if s.get("n") else "n/a",
                     f"{s['per']:+.3f}", f"{s['per_lo']:+.2f} to {s['per_hi']:+.2f}", f"{s['per_ex_top5']:+.3f}", f"{int((d > 0).sum())} of {len(days_test)}"])
    cols = ["Rule", "Entries", "Win %", "Win % needed", "Net an entry", "95% interval", "Net ex best 5%", "Days up"]
    nb = fs.nlines(notes)
    H = 3.6 + 1.0 + 0.27 * (len(rows) + 1) + nb * fs.LINE_IN + 1.9
    fig = plt.figure(figsize=(13, H))
    top = 1 - 1.35 / H
    tab_h = 0.27 * (len(rows) + 1) / H
    bot = (0.12 + nb * fs.LINE_IN + 0.35) / H
    gs = fig.add_gridspec(1, 2, left=0.07, right=0.97, top=top, bottom=bot + tab_h + 0.95 / H, wspace=0.22, width_ratios=(1.0, 1.6))
    a1, a2 = fig.add_subplot(gs[0, 0]), fig.add_subplot(gs[0, 1])
    axt = fig.add_axes([0.07, bot, 0.90, tab_h])
    axt.axis("off")
    fig.suptitle(question, x=0.07, y=1 - 0.18 / H, ha="left", va="top", fontsize=11.5, fontweight="bold", color=INK)
    fig.text(0.07, 1 - 0.58 / H, window, ha="left", va="top", fontsize=8.5, color=MUTED)
    fs.bullets(fig, notes, bottom_in=0.12)
    x = np.arange(len(labs))
    for i, lab in enumerate(labs):
        t, e, s = rules[lab]
        if not s.get("n"):
            continue
        a1.bar([i], [s["per"]], color=GOOD if s["per"] >= 0 else BAD, width=0.6, zorder=3)
        a1.errorbar([i], [s["per"]], yerr=[[s["per"] - s["per_lo"]], [s["per_hi"] - s["per"]]], fmt="none", color=INK, ecolor=INK, elinewidth=1.1, capsize=4, zorder=4)
        a1.scatter([i + 0.2], [s["per_ex_top5"]], marker="D", s=36, color=INK, zorder=5)
        a1.text(i, max(s["per_hi"], 0), f" n={s['n']:,}", ha="center", va="bottom", fontsize=7.5, color=INK2)
        net = np.asarray(e["net"], float)
        a2.step(np.arange(len(net) + 1), np.concatenate([[0.0], np.cumsum(net)]), where="post", color=RULE_COL.get(lab, MUTED), lw=2.0, label=t, zorder=4)
    a1.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
    a1.set_xticks(x)
    a1.set_xticklabels([rules[lab][0].split(":")[0] for lab in labs], fontsize=8)
    a1.set_title("net an entry, test days (95% by slot)", fontsize=9.5, loc="left")
    a1.set_ylabel("net USD an entry")
    a1.legend(handles=[Patch(facecolor=GOOD, label="net above zero"), Patch(facecolor=BAD, label="net below zero"),
                       Line2D([], [], color=INK, marker="D", ls="", label="without the best 5%")], loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=3, fontsize=7.5, frameon=False)
    a2.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
    a2.set_title("cumulative net on the test days, entry by entry", fontsize=9.5, loc="left")
    a2.set_xlabel("entry, in time order")
    a2.set_ylabel("USD")
    a2.legend(loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=3, fontsize=8, frameon=False)
    tb = fs.put_table(axt, rows, cols, size=9, first=0.27)
    for i, r in enumerate(rows, 1):
        fs.tint(tb, i, 4, "green" if rules[labs[i - 1]][2].get("per", -1) > 0 else "rose")
    return fig


# ============================================================ latency (S4.2)
def latency_rows(cand, tabs, cfg, base_ms=250, extra=(1, 2, 3, 5), n_base=None):
    """Net an entry and entries at each delay: one row a seated table (`tabs` maps ms -> table) and one row a whole-second shift of the base table.
    -> list of dict(ms, how, s, fill_share, total, lost_n, lost_per, kept_n, kept_per, new_n, new_per).
    The timing audit (2026-10-11, finding 1) showed the net an entry alone hides a survivor effect: a later order with its limit at the ask seen loses the
    entries whose book re-priced, which were the best ones. So each row also carries the total USD and the base (250 ms) net of the entries the delay loses
    (`lost_n`, `lost_per`), of those it keeps (`kept_n`, `kept_per`) and of the windows it adds (`new_n`, `new_per`). Windows are matched on the base table, so
    only the whole-second rows (the same table) are split; a row of another seated table has NaN there."""
    rows = []
    base = run_cell(cand, tabs[base_ms], cfg)
    bw = {int(w): float(v) for w, v in zip(base["w"], base["net"])}

    def split(e, same):
        if not same:
            return dict(lost_n=0, lost_per=NAN, kept_n=0, kept_per=NAN, new_n=0, new_per=NAN)
        dw = {int(w): float(v) for w, v in zip(e["w"], e["net"])}
        lost = [bw[w] for w in bw if w not in dw]
        kept = [bw[w] for w in bw if w in dw]
        new = [dw[w] for w in dw if w not in bw]
        m = lambda v: float(np.mean(v)) if v else NAN                                                                   # noqa: E731
        return dict(lost_n=len(lost), lost_per=m(lost), kept_n=len(kept), kept_per=m(kept), new_n=len(new), new_per=m(new))

    for ms, t in sorted(tabs.items()):
        e = base if ms == base_ms else run_cell(cand, t, cfg)
        rows.append(dict(ms=int(ms), how="seated table", s=stats(e), **split(e, ms == base_ms)))
    for j in extra:
        e = run_cell(cand, tabs[base_ms], cfg, delay_k=j)
        rows.append(dict(ms=int(base_ms + 1000 * j), how=f"{base_ms} ms table + {j} s", s=stats(e), **split(e, True)))
    rows.sort(key=lambda r: r["ms"])
    nb = n_base or next(r["s"]["n"] for r in rows if r["ms"] == base_ms)
    for r in rows:
        r["fill_share"] = r["s"].get("n", 0) / nb if nb else NAN
        r["total"] = float(r["s"].get("net", 0.0)) if r["s"].get("n") else 0.0
    return rows


def repricing_split(tab, e, after_s=5):
    """The timing audit's split of a rule's entries: those whose near ask `after_s` seconds after the decision sits above the ask seen (the book re-priced
    toward the burst), the same, or below. -> dict part -> (entries, net an entry, net USD), part in ("higher", "same", "lower")."""
    w, k, s = np.asarray(e["w"], int), np.asarray(e["k"], int), np.asarray(e["side"], int)
    if not len(w):
        return {p: (0, NAN, 0.0) for p in ("higher", "same", "lower")}
    qa, qd = C.quotes(tab)
    k2 = np.minimum(k + int(after_s), tab.NK - 1)
    seen = np.where(s > 0, qa[w, k], qd[w, k])
    later = np.where(s > 0, qa[w, k2], qd[w, k2])
    later = np.where(np.isfinite(later), later, seen)
    net = np.asarray(e["net"], float)
    parts = {"higher": later > seen + 1e-6, "same": np.abs(later - seen) <= 1e-6, "lower": later < seen - 1e-6}
    return {p: (int(m.sum()), float(net[m].mean()) if m.any() else NAN, float(net[m].sum())) for p, m in parts.items()}


def crossing(rows):
    """The first delay where the net an entry turns from above zero to at or below it (linear between the two delays), or None."""
    for a, b in zip(rows, rows[1:]):
        ya, yb = a["s"]["per"], b["s"]["per"]
        if np.isfinite(ya) and np.isfinite(yb) and ya > 0 >= yb:
            return a["ms"] + (b["ms"] - a["ms"]) * ya / (ya - yb)
    return None


def latency_fig(lat, window, notes, base_ms=250, question="How much do we lose if our order arrives a second late?"):
    """Four panels against the delay (log scale), a line a rule in its identity colour, the study's 250 ms marked as the assumption [U]. Top left: the net an
    entry with its 95% slot interval, zero the decision line, each rule's zero crossing labelled. Top right: the total net USD (the survivor effect the
    per-entry net hides). Bottom left: the base-delay net an entry of the base entries the delay LOSES (solid) and of those it KEEPS (ink dotted), whole-second
    rows only. Bottom right: the share of the base entries' count that still fills. `lat` maps a label to (title, latency_rows)."""
    fig, axes = LF.frame(7.4, notes, question, window, nrows=2, ncols=2, hspace=0.42, wspace=0.2)
    a1, a2, a3, a4 = axes
    for lab, (t, rows) in lat.items():
        x = np.array([r["ms"] for r in rows], float)
        y = np.array([r["s"]["per"] for r in rows], float)
        lo = np.array([r["s"]["per_lo"] for r in rows], float)
        hi = np.array([r["s"]["per_hi"] for r in rows], float)
        col, mk = RULE_COL.get(lab, MUTED), RULE_MK.get(lab, "o")
        a1.fill_between(x, lo, hi, color=col, alpha=0.14, lw=0, zorder=2)
        a1.plot(x, y, color=col, marker=mk, ms=5, lw=1.9, zorder=4, label=t)
        cx = crossing(rows)
        if cx is not None:
            a1.annotate(f"{t.split(':')[0]} crosses zero near {cx:,.0f} ms", (cx, 0), xytext=(6, 14), textcoords="offset points", fontsize=8, color=INK,
                        arrowprops=dict(arrowstyle="-", color=INK, lw=0.8))
        a2.plot(x, [r["total"] for r in rows], color=col, marker=mk, ms=5, lw=1.9, zorder=4, label=t)
        for r in rows:
            if r["ms"] == rows[0]["ms"] or r["ms"] == rows[-1]["ms"] or r["ms"] == base_ms:
                a2.annotate(f"{r['total']:+,.0f}", (r["ms"], r["total"]), xytext=(0, 6), textcoords="offset points", ha="center", fontsize=7.5, color=col)
        sp = [r for r in rows if r["kept_n"] and r["ms"] != base_ms]
        if sp:
            xs = np.array([r["ms"] for r in sp], float)
            a3.plot(xs, [r["lost_per"] for r in sp], color=col, marker=mk, ms=5, lw=1.9, zorder=4, label=f"{t.split(':')[0]}: entries the delay loses")
            a3.plot(xs, [r["kept_per"] for r in sp], color=INK, marker=mk, ms=4, lw=1.3, ls=":", zorder=5, label=f"{t.split(':')[0]}: entries it keeps")
            for r in sp:
                a3.annotate(f"{r['lost_n']:,}", (r["ms"], r["lost_per"]), xytext=(0, 6), textcoords="offset points", ha="center", fontsize=7, color=col)
        a4.plot(x, [r["fill_share"] for r in rows], color=col, marker=mk, ms=5, lw=1.9, zorder=4)
    ticks = next(iter(lat.values()))[1]
    for ax in (a1, a2, a3, a4):
        ax.set_xscale("log")
        ax.axvline(base_ms, color=INK, ls=":", lw=1.1, zorder=3)
        ax.set_xticks([r["ms"] for r in ticks])
        ax.set_xticklabels([f"{r['ms']:,}" for r in ticks], fontsize=7.5, rotation=45)
        ax.minorticks_off()
    for ax in (a1, a2, a3):
        ax.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
    a1.text(base_ms, 0.97, f" {base_ms} ms: the study's assumption [U]", transform=a1.get_xaxis_transform(), fontsize=8, color=INK, va="top")
    a1.set_ylabel("net USD an entry (95% by slot)")
    a1.set_title("net an entry against the delay", fontsize=9.5, loc="left")
    a1.legend(loc="upper right", fontsize=8, frameon=False)
    a2.set_ylabel("net USD, all entries")
    a2.set_title("the total: what the delay costs in dollars", fontsize=9.5, loc="left")
    a3.set_ylabel(f"net USD an entry at {base_ms} ms")
    a3.set_title(f"the {base_ms} ms net of the entries a later order loses and keeps (count lost above)", fontsize=9.5, loc="left")
    a3.legend(loc="best", ncol=2, fontsize=7.5, frameon=False)
    a3.set_xlabel("delay from the decision second to the ladder the order meets, ms (log scale)")
    a4.axhline(1.0, color=INK, ls=":", lw=1.0, zorder=3)
    a4.set_ylabel(f"entries / entries at {base_ms} ms")
    a4.set_xlabel("delay, ms (log scale)")
    a4.set_title("how many entries still fill", fontsize=9.5, loc="left")
    return fig


# ============================================================ costs (S4.3)
def cost_read(cand, tab, cfg, idx, mults=(0.0, 0.5, 1.0, 1.5, 2.0, 3.0), slips=(0.0, 0.01, 0.02)):
    """The fee sweep (the fee recomputed as multiplier x the market's own rate, the same entries) and the slippage sweep (the limit raised by s USD a share
    over the ask seen), on the days `idx`. -> dict(fee=[(m, stats)], slip=[(s, stats)], gross, fee_per, net, be_mult, rate)."""
    fee = [(m, stats(by_days(run_cell(cand, tab, cfg, fee_mult=m), idx))) for m in mults]
    slip = [(s, stats(by_days(run_cell(cand, tab, cfg, slip=s), idx))) for s in slips]
    e = by_days(run_cell(cand, tab, cfg), idx)
    g, f = float(np.mean(e["gross"])) if len(e["net"]) else NAN, float(np.mean(e["fee"])) if len(e["net"]) else NAN
    glo, ghi = B.slot_boot(e["slot"], e["gross"]) if len(e["net"]) else (NAN, NAN)
    flo, fhi = B.slot_boot(e["slot"], e["fee"]) if len(e["net"]) else (NAN, NAN)
    rates = np.unique(np.round(tab.w_fee[np.asarray(e["w"])].astype(float), 6)) if len(e["net"]) else np.zeros(0)
    return dict(fee=fee, slip=slip, gross=g, gross_lo=glo, gross_hi=ghi, fee_per=f, fee_lo=flo, fee_hi=fhi, net=g - f, be_mult=g / f if f > 0 else NAN,
                rates=rates, shares=float(np.mean(e["shares"])) if len(e["net"]) else NAN, stats=stats(e))


def cost_fig(costs, window, notes, question="How much more taker fee can the edge bear before it is gone?"):
    """Left: the bridge an entry for each rule (gross, the fee in the fees colour, net; gross and net green or red by sign, each with its 95% slot interval).
    Middle: the net an entry at fee multipliers 0 to 3 with intervals, a line a rule, zero the decision line, each rule's break-even multiplier a labelled
    vertical. Right: the net an entry with the limit raised 0, 1 and 2 cents over the ask seen. One table under them. `costs` maps a label to (title, cost_read)."""
    labs = list(costs)
    rows = []
    for lab in labs:
        t, c = costs[lab]
        s2 = dict(c["fee"]).get(2.0, {})
        rate = c["rates"][0] if len(c["rates"]) == 1 else NAN
        rows.append([t.split(":")[0], f"{c['gross']:+.3f}", f"{c['fee_per']:.3f}", f"{c['net']:+.3f}", f"{c['fee_per'] / c['gross'] * 100:.0f}%" if c["gross"] > 0 else "n/a",
                     f"{c['be_mult']:.2f}x", f"{c['be_mult'] * rate:.3f}" if np.isfinite(rate) else "n/a", f"{s2.get('per', NAN):+.3f}",
                     f"{dict(c['slip']).get(0.02, {}).get('per', NAN):+.3f}"])
    cols = ["Rule", "Gross an entry", "Fee an entry", "Net an entry", "Fee / gross", "Break-even fee", "Break-even rate", "Net at fee x2", "Net at +2c"]
    nb = fs.nlines(notes)
    H = 3.8 + 1.0 + 0.27 * (len(rows) + 1) + nb * fs.LINE_IN + 1.9
    fig = plt.figure(figsize=(13, H))
    top = 1 - 1.35 / H
    tab_h = 0.27 * (len(rows) + 1) / H
    bot = (0.12 + nb * fs.LINE_IN + 0.35) / H
    gs = fig.add_gridspec(1, 3, left=0.07, right=0.97, top=top, bottom=bot + tab_h + 0.95 / H, wspace=0.28, width_ratios=(1.1, 1.2, 0.9))
    a1, a2, a3 = (fig.add_subplot(gs[0, j]) for j in range(3))
    axt = fig.add_axes([0.07, bot, 0.90, tab_h])
    axt.axis("off")
    fig.suptitle(question, x=0.07, y=1 - 0.18 / H, ha="left", va="top", fontsize=11.5, fontweight="bold", color=INK)
    fig.text(0.07, 1 - 0.58 / H, window, ha="left", va="top", fontsize=8.5, color=MUTED)
    fs.bullets(fig, notes, bottom_in=0.12)
    xt, xl = [], []
    for i, lab in enumerate(labs):
        t, c = costs[lab]
        x0 = i * 4
        s = c["stats"]
        for dx, v, lo, hi, col in ((0, c["gross"], c["gross_lo"], c["gross_hi"], GOOD if c["gross"] >= 0 else BAD),
                                   (1, -c["fee_per"], -c["fee_hi"], -c["fee_lo"], fs.QUANTITY["fees"]),
                                   (2, s["per"], s["per_lo"], s["per_hi"], GOOD if s["per"] >= 0 else BAD)):
            a1.bar([x0 + dx], [v], color=col, width=0.8, zorder=3)
            a1.errorbar([x0 + dx], [v], yerr=[[v - lo], [hi - v]], fmt="none", color=INK, ecolor=INK, elinewidth=1.0, capsize=3, zorder=4)
        xt += [x0, x0 + 1, x0 + 2]
        xl += [f"{t.split(':')[0]}\ngross", "fee", "net"]
        col = RULE_COL.get(lab, MUTED)
        m = np.array([r[0] for r in c["fee"]], float)
        y = np.array([r[1]["per"] for r in c["fee"]], float)
        a2.fill_between(m, [r[1]["per_lo"] for r in c["fee"]], [r[1]["per_hi"] for r in c["fee"]], color=col, alpha=0.14, lw=0, zorder=2)
        a2.plot(m, y, color=col, marker=RULE_MK.get(lab, "o"), ms=5, lw=1.9, zorder=4, label=t.split(":")[0])
        if np.isfinite(c["be_mult"]) and c["be_mult"] <= 3.5:
            a2.axvline(c["be_mult"], color=INK, ls=":", lw=1.0, zorder=3)
            a2.text(c["be_mult"], 0.97 - 0.08 * i, f" {t.split(':')[0]} breaks even at {c['be_mult']:.2f}x", transform=a2.get_xaxis_transform(), fontsize=7.5, color=INK, va="top")
        sx = np.array([r[0] for r in c["slip"]], float) * 100
        a3.fill_between(sx, [r[1]["per_lo"] for r in c["slip"]], [r[1]["per_hi"] for r in c["slip"]], color=col, alpha=0.14, lw=0, zorder=2)
        a3.plot(sx, [r[1]["per"] for r in c["slip"]], color=col, marker=RULE_MK.get(lab, "o"), ms=5, lw=1.9, zorder=4)
    a1.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
    a1.set_xticks(xt)
    a1.set_xticklabels(xl, fontsize=7.5)
    a1.set_ylabel("USD an entry (95% by slot)")
    a1.set_title("gross, fee, net an entry", fontsize=9.5, loc="left")
    a2.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
    a2.axvline(1.0, color=INK2, lw=0.8, zorder=1)
    a2.set_xlabel("fee multiplier (1 = the market's own rate)")
    a2.set_ylabel("net USD an entry")
    a2.set_title("the fee sweep", fontsize=9.5, loc="left")
    a2.legend(loc="lower left", fontsize=8, frameon=False)
    a3.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
    a3.set_xticks([0, 1, 2])
    a3.set_xlabel("limit raised over the ask seen, cents")
    a3.set_ylabel("net USD an entry")
    a3.set_title("the slippage sweep", fontsize=9.5, loc="left")
    a1.legend(handles=[Patch(facecolor=GOOD, label="above zero"), Patch(facecolor=BAD, label="below zero"), Patch(facecolor=fs.QUANTITY["fees"], label="the taker fee")],
              loc="upper center", bbox_to_anchor=(0.5, -0.16), ncol=3, fontsize=7.5, frameon=False)
    tb = fs.put_table(axt, rows, cols, size=8.5)
    for i, lab in enumerate(labs, 1):
        fs.tint(tb, i, 7, "green" if dict(costs[lab][1]["fee"]).get(2.0, {}).get("per", -1) > 0 else "rose")
    return fig


# ============================================================ slices (S4.4)
HOUR_BLOCKS = ((0, 4), (4, 8), (8, 12), (12, 16), (16, 20), (20, 24))
LEFT_EDGES = (0, 300, 450, 600, 750, 900)
DOW = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def slices(e, tab, days):
    """The net an entry with its 95% slot interval and the count, by coin, by UTC hour block of the window's start, by seconds left at entry, by the price
    paid and by day of the week. -> list of (dimension, level, per, lo, hi, n)."""
    import datetime as dt
    import tf15_trade_figs as TF
    w = np.asarray(e["w"])
    hour = (np.asarray(tab.w_start)[w] // 3_600_000) % 24
    dow = np.array([dt.date.fromisoformat(days[d]).weekday() for d in np.asarray(e["day"])], int) if len(w) else np.zeros(0, int)
    px = np.asarray(e["vwap"], float)
    T = np.asarray(e["T"], float)
    cuts = [("coin", [(a.upper(), np.asarray(e["asset"]) == i) for i, a in enumerate(TF.COINS)]),
            ("UTC hour", [(f"{a:02d}-{b:02d}", (hour >= a) & (hour < b)) for a, b in HOUR_BLOCKS]),
            ("seconds left", [(f"{a}-{b}", (T >= a) & (T < b)) for a, b in zip(LEFT_EDGES[:-1], LEFT_EDGES[1:])]),
            ("price paid", [(lab, (px >= a) & (px < b)) for lab, a, b in zip(TF.PRICE_LABELS, TF.PRICE_EDGES[:-1], TF.PRICE_EDGES[1:])]),
            ("weekday", [(DOW[i], dow == i) for i in range(7)])]
    out = []
    for dim, levels in cuts:
        for lev, m in levels:
            if m.sum() == 0:
                out.append((dim, lev, NAN, NAN, NAN, 0))
                continue
            s = stats(B.subset(e, m))
            out.append((dim, lev, s["per"], s["per_lo"], s["per_hi"], int(s["n"])))
    return out


def slices_fig(sl, overall, window, notes, question="Does the edge hold in every group of trades, or does one group carry it?"):
    """The chart bank's edge by slice for two rules: one row a slice, grouped by dimension; each rule's net an entry with its 95% slot interval (circle E,
    square the chosen cell, green above zero, red below), each rule's overall net a labelled ink dotted vertical; the counts on the same rows on the right.
    `sl` maps a label to (title, slices rows); `overall` maps a label to its overall net."""
    labs = list(sl)
    keys = [k for k in dict.fromkeys((r[0], r[1]) for r in sl[labs[0]][1]) if any(r[5] for lab in labs for r in sl[lab][1] if (r[0], r[1]) == k)]
    n = len(keys)
    nb = fs.nlines(notes)
    H = 1.9 + 0.24 * n + nb * fs.LINE_IN + 0.9
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, H), sharey=True, gridspec_kw=dict(width_ratios=(3, 1)))
    fig.subplots_adjust(left=0.17, right=0.97, top=1 - 1.25 / H, bottom=fs.bullet_margin(fig, nb) + 0.55 / H, wspace=0.06)
    fig.suptitle(question, x=0.07, y=1 - 0.18 / H, ha="left", va="top", fontsize=11.5, fontweight="bold", color=INK)
    fig.text(0.07, 1 - 0.58 / H, window, ha="left", va="top", fontsize=8.5, color=MUTED)
    fs.bullets(fig, notes, bottom_in=0.12)
    y0 = {k: i for i, k in enumerate(keys)}
    for j, lab in enumerate(labs):
        dy = (j - (len(labs) - 1) / 2) * 0.28
        cnt = np.zeros(n)
        for dim, lev, v, lo, hi, c in sl[lab][1]:
            if (dim, lev) not in y0:
                continue
            i = y0[(dim, lev)]
            cnt[i] = c
            if np.isfinite(v):
                a1.errorbar([v], [i + dy], xerr=[[v - lo], [hi - v]] if np.isfinite(lo) else None, fmt=RULE_MK.get(lab, "o"), color=GOOD if v > 0 else BAD,
                            ecolor=INK2, elinewidth=0.9, capsize=2, ms=5.5, zorder=4)
        a2.barh(np.arange(n) + dy, cnt, height=0.26, color=RULE_COL.get(lab, MUTED), zorder=3)
        a1.axvline(overall[lab], color=INK, ls=":", lw=1.0, zorder=3)
        a1.text(overall[lab], -0.9 - 0.6 * j, f" {sl[lab][0].split(':')[0]} all entries {overall[lab]:+.2f}", fontsize=7.5, color=INK, va="center")
    for i in range(1, n):
        if keys[i][0] != keys[i - 1][0]:
            a1.axhline(i - 0.5, color=N["grid"], lw=1.0)
    a1.axvline(0, color=N["axis"], lw=1.0)
    a1.set_yticks(np.arange(n))
    a1.set_yticklabels([f"{d}: {l}" for d, l in keys], fontsize=8)
    a1.set_ylim(n - 0.5, -1.6 - 0.6 * len(labs))
    a1.set_xlabel("net USD an entry, 95% by 15-minute slot")
    a1.set_title("the edge in each slice", fontsize=9.5, loc="left")
    a2.set_xlabel("entries")
    a2.set_title("the count behind it", fontsize=9.5, loc="left")
    h = [Line2D([], [], color=INK2, marker=RULE_MK.get(lab, "o"), ls="", label=sl[lab][0].split(":")[0]) for lab in labs]
    h += [Patch(facecolor=GOOD, label="above zero"), Patch(facecolor=BAD, label="below zero")]
    h += [Patch(facecolor=RULE_COL.get(lab, MUTED), label=f"count, {sl[lab][0].split(':')[0]}") for lab in labs]
    a1.legend(handles=h, loc="lower left", bbox_to_anchor=(0, 1.04), ncol=6, fontsize=7.5, frameon=False)
    return fig


# ============================================================ steadiness (S4.5)
def daily(e, nd):
    return np.bincount(np.asarray(e["day"], int), weights=np.asarray(e["net"], float), minlength=nd) if len(e["net"]) else np.zeros(nd)


def r2_line(x):
    c, t = np.cumsum(x), np.arange(1, len(x) + 1)
    return float(1 - np.var(c - np.polyval(np.polyfit(t, c, 1), t)) / np.var(c)) if len(x) > 2 and np.var(c) > 0 else NAN


def r2_ci(x, n=1000, seed=11):
    g = np.random.default_rng(seed)
    v = [r2_line(x[g.integers(0, len(x), len(x))]) for _ in range(n)]
    return tuple(np.nanpercentile(v, [2.5, 97.5]))


def weeks(e, days, week=7):
    """Each week's net an entry with its 95% slot interval and count. -> list of dict(label, s)."""
    out = []
    for a in range(0, len(days), week):
        idx = np.arange(a, min(a + week, len(days)))
        out.append(dict(label=f"{days[idx[0]][5:]}..{days[idx[-1]][5:]}", n_days=len(idx), s=stats(by_days(e, idx))))
    return out


def steady_fig(ents, days, r2_min, window, notes, question="Does the account climb steadily, or in jumps?"):
    """Left: the cumulative daily net of each rule (identity colours, solid steps) with its straight-line fit (ink dotted). Middle: each week's net an entry
    with its 95% slot interval, a marker a rule, green above zero and red below, zero the decision line. Right: the r-squared of each rule's straight line with
    a 95% interval over resampled days, the steadiness gate [U] an ink dotted vertical. `ents` maps a label to (title, entries on every day)."""
    nd = len(days)
    fig, (a1, a2, a3) = LF.frame(4.4, notes, question, window, ncols=3, wspace=0.3)
    t = np.arange(1, nd + 1)
    for j, (lab, (ttl, e)) in enumerate(ents.items()):
        x = daily(e, nd)
        c = np.cumsum(x)
        a1.plot(np.concatenate([[0], t]), np.concatenate([[0.0], c]), color=RULE_COL.get(lab, MUTED), lw=2.0, marker=".", ms=4, zorder=4, label=ttl.split(":")[0])
        if nd > 2:
            a1.plot(t, np.polyval(np.polyfit(t, c, 1), t), color=INK, lw=1.0, ls=":", zorder=3)
        wk = weeks(e, days)
        dx = (j - (len(ents) - 1) / 2) * 0.22
        for i, w in enumerate(wk):
            s = w["s"]
            if s.get("n"):
                a2.errorbar([i + dx], [s["per"]], yerr=[[s["per"] - s["per_lo"]], [s["per_hi"] - s["per"]]], fmt=RULE_MK.get(lab, "o"), color=GOOD if s["per"] > 0 else BAD,
                            ecolor=INK2, elinewidth=0.9, capsize=2.5, ms=6, zorder=4)
        r = r2_line(x)
        lo, hi = r2_ci(x)
        a3.errorbar([r], [j], xerr=[[r - lo], [hi - r]], fmt=RULE_MK.get(lab, "o"), color=RULE_COL.get(lab, MUTED), ecolor=INK2, capsize=3, ms=7, zorder=4)
    a1.axhline(0, color=N["axis"], lw=1.0)
    a1.set_xlabel("day of the window (daily closes)")
    a1.set_ylabel("cumulative net, USD")
    a1.set_title("the path, and its straight-line fit (dotted)", fontsize=9.5, loc="left")
    a1.legend(loc="upper left", fontsize=8, frameon=False)
    wk = weeks(next(iter(ents.values()))[1], days)
    a2.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
    a2.set_xticks(np.arange(len(wk)))
    a2.set_xticklabels([w["label"] + (f"\n({w['n_days']} days)" if w["n_days"] < 7 else "") for w in wk], fontsize=7, rotation=30, ha="right")
    a2.set_ylabel("net USD an entry (95% by slot)")
    a2.set_title("week by week", fontsize=9.5, loc="left")
    a2.legend(handles=[Line2D([], [], color=INK2, marker=RULE_MK.get(lab, "o"), ls="", label=ttl.split(":")[0]) for lab, (ttl, _) in ents.items()],
              loc="lower left", fontsize=7.5, frameon=False)
    a3.axvline(r2_min, color=INK, ls=":", lw=1.1)
    a3.text(r2_min, 1.0, f" gate {r2_min:.2f} [U]", transform=a3.get_xaxis_transform(), fontsize=8, va="bottom", color=INK)
    a3.set_yticks(range(len(ents)))
    a3.set_yticklabels([ttl.split(":")[0] for ttl, _ in ents.values()], fontsize=8)
    a3.set_ylim(len(ents) - 0.5, -0.5)
    a3.set_xlim(0, 1)
    a3.set_xlabel("r-squared of the straight line, 95% over resampled days")
    a3.set_title("how straight", fontsize=9.5, loc="left")
    return fig


# ============================================================ exits (S4.6)
EXIT_HOLDS = (60, 120, 300)


def exit_variants(tab, e):
    """Hold to expiry against a sale at the near bid after 60, 120 and 300 s and a take-profit when the near bid reaches 0.95, on the same entries
    (`tf15_exits`: the sale walks the bid ladder of its second, the fee on the way out, what is unsold is held). -> dict name -> entries."""
    import tf15_exits as X
    out = {"hold to expiry": e}
    if not len(e["net"]):
        return out
    for h in EXIT_HOLDS:
        ke = X.exit_second(tab, e, X.time_stop(tab, e, h), min_hold=1, through_last=True)
        out[f"sell at the bid after {h} s"] = X.apply_exit(tab, e, ke, reason=f"t{h}")
    ke = X.exit_second(tab, e, X.take_profit(tab, e, 0.95), min_hold=1)
    out["take profit at 0.95"] = X.apply_exit(tab, e, ke, reason="tp95")
    return out


def exits_fig(ex, window, notes, question="Does selling early beat holding to expiry?"):
    """Left: each exit's net an entry with its 95% slot interval, a marker a rule, green above zero and red below, zero the decision line. Right: what the exit
    is worth against holding the SAME entries (the difference an entry, 95% by slot), zero the decision line. One table under them. `ex` maps a label to
    (title, exit_variants)."""
    labs = list(ex)
    names = list(next(iter(ex.values()))[1])
    rows = []
    for nm in names:
        r = [nm]
        for lab in labs:
            v, base = ex[lab][1][nm], ex[lab][1]["hold to expiry"]
            s = stats(v)
            d = np.asarray(v["net"], float) - np.asarray(base["net"], float)
            n_ex = int((np.asarray(v.get("ke", -np.ones(len(d))), int) >= 0).sum())
            r += [f"{n_ex:,}", f"{s['per']:+.3f}", f"{d.mean():+.3f}" if len(d) else "n/a"]
        rows.append(r)
    cols = ["Exit"] + [c for lab in labs for c in (f"{ex[lab][0].split(':')[0]} exited", "net an entry", "worth an entry")]
    nb = fs.nlines(notes)
    H = 3.6 + 1.0 + 0.27 * (len(rows) + 1) + nb * fs.LINE_IN + 1.7
    fig = plt.figure(figsize=(13, H))
    top = 1 - 1.35 / H
    tab_h = 0.27 * (len(rows) + 1) / H
    bot = (0.12 + nb * fs.LINE_IN + 0.35) / H
    gs = fig.add_gridspec(1, 2, left=0.07, right=0.97, top=top, bottom=bot + tab_h + 1.05 / H, wspace=0.22)
    a1, a2 = fig.add_subplot(gs[0, 0]), fig.add_subplot(gs[0, 1])
    axt = fig.add_axes([0.07, bot, 0.90, tab_h])
    axt.axis("off")
    fig.suptitle(question, x=0.07, y=1 - 0.18 / H, ha="left", va="top", fontsize=11.5, fontweight="bold", color=INK)
    fig.text(0.07, 1 - 0.58 / H, window, ha="left", va="top", fontsize=8.5, color=MUTED)
    fs.bullets(fig, notes, bottom_in=0.12)
    x = np.arange(len(names))
    for j, lab in enumerate(labs):
        dx = (j - (len(labs) - 1) / 2) * 0.22
        base = ex[lab][1]["hold to expiry"]
        for i, nm in enumerate(names):
            v = ex[lab][1][nm]
            s = stats(v)
            if s.get("n"):
                a1.errorbar([i + dx], [s["per"]], yerr=[[s["per"] - s["per_lo"]], [s["per_hi"] - s["per"]]], fmt=RULE_MK.get(lab, "o"), color=GOOD if s["per"] > 0 else BAD,
                            ecolor=INK2, elinewidth=0.9, capsize=2.5, ms=6, zorder=4)
                d = np.asarray(v["net"], float) - np.asarray(base["net"], float)
                lo, hi = B.slot_boot(np.asarray(v["slot"]), d)
                if i:
                    a2.errorbar([i + dx], [d.mean()], yerr=[[d.mean() - lo], [hi - d.mean()]], fmt=RULE_MK.get(lab, "o"), color=GOOD if d.mean() > 0 else BAD,
                                ecolor=INK2, elinewidth=0.9, capsize=2.5, ms=6, zorder=4)
    for ax in (a1, a2):
        ax.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
        ax.set_xticks(x)
        ax.set_xticklabels([nm.replace("sell at the bid after", "bid after") for nm in names], fontsize=7.5, rotation=15, ha="right")
    a1.set_ylabel("net USD an entry (95% by slot)")
    a1.set_title("net an entry, each exit", fontsize=9.5, loc="left")
    a2.set_ylabel("exit minus hold, USD an entry (95% by slot)")
    a2.set_title("what the exit is worth against holding the same entries", fontsize=9.5, loc="left")
    a1.legend(handles=[Line2D([], [], color=INK2, marker=RULE_MK.get(lab, "o"), ls="", label=ex[lab][0].split(":")[0]) for lab in labs]
              + [Patch(facecolor=GOOD, label="above zero"), Patch(facecolor=BAD, label="below zero")], loc="upper center", bbox_to_anchor=(0.5, -0.2), ncol=4, fontsize=7.5, frameon=False)
    fs.put_table(axt, rows, cols, size=8.5, first=0.2)
    return fig


# ============================================================ risk (S5)
def risk_read(e, nd, book=1000.0, stop_day=60.0, dd_limit=150.0):
    """The daily record and the path: worst day, largest loss, the deepest drawdown (entry by entry) and its share of the net, the share of the net in the best
    5% and 1% of entries, entries a day (mean, sd), the days the daily stop would have fired, whether the drawdown limit was crossed."""
    d = daily(e, nd)
    net = np.asarray(e["net"], float)
    eq = np.cumsum(net)
    peak = np.maximum.accumulate(np.concatenate([[0.0], eq]))[1:]
    dd = peak - eq if len(eq) else np.zeros(0)
    srt = np.sort(net)[::-1]
    tot = float(net.sum())
    cnt = np.bincount(np.asarray(e["day"], int), minlength=nd) if len(net) else np.zeros(nd)
    top = lambda p: float(srt[: int(np.ceil(p * len(srt)))].sum() / tot) if tot > 0 and len(srt) else NAN                # noqa: E731
    return dict(daily=d, worst_day=float(d.min()), worst_idx=int(np.argmin(d)), days_lost=int((d < 0).sum()), largest_loss=float(net.min()) if len(net) else NAN,
                max_dd=float(dd.max()) if len(dd) else 0.0, dd_path=dd, dd_over_net=float(dd.max() / tot) if tot > 0 and len(dd) else NAN, top5=top(0.05), top1=top(0.01),
                per_day=float(cnt.mean()), per_day_sd=float(cnt.std(ddof=1)) if nd > 1 else NAN, stop_days=[int(i) for i in np.flatnonzero(d <= -stop_day)],
                dd_crossed=bool(len(dd) and dd.max() >= dd_limit), net=tot, book=book)


def risk_fig(risks, days, stop_day, dd_limit, window, notes, question="How far did the account fall, and would our stop and loss limit have fired?"):
    """Left: each rule's net by day (green gain, red loss; a panel a rule stacked), the daily stop [U] an ink dotted line. Right: the drawdown from the running
    peak entry by entry, a line a rule, the drawdown limit [U] an ink dotted line. One table under them. `risks` maps a label to (title, risk_read)."""
    labs = list(risks)
    rows = []
    for lab in labs:
        t, r = risks[lab]
        g = lambda v, f: f.format(v) if np.isfinite(v) else "n/a"                                                       # noqa: E731
        rows.append([t.split(":")[0], f"{r['worst_day']:+.0f} ({days[r['worst_idx']][5:]})", g(r["largest_loss"], "{:+.2f}"), f"{r['max_dd']:.0f}", g(r["dd_over_net"], "{:.2f}"),
                     g(r["top5"] * 100, "{:.0f}%"), g(r["top1"] * 100, "{:.0f}%"), f"{r['per_day']:.1f} (sd {r['per_day_sd']:.1f})", str(len(r["stop_days"]))])
    cols = ["Rule", "Worst day, USD", "Largest loss", "Deepest drawdown", "Drawdown / net", "Net in best 5%", "Net in best 1%", "Entries a day", "Stop days"]
    nb = fs.nlines(notes)
    H = 4.2 + 1.0 + 0.27 * (len(rows) + 1) + nb * fs.LINE_IN + 1.3
    fig = plt.figure(figsize=(13, H))
    top = 1 - 1.35 / H
    tab_h = 0.27 * (len(rows) + 1) / H
    bot = (0.12 + nb * fs.LINE_IN + 0.35) / H
    gs = fig.add_gridspec(len(labs), 2, left=0.07, right=0.97, top=top, bottom=bot + tab_h + 0.75 / H, wspace=0.2, hspace=0.45, width_ratios=(1.4, 1.0))
    ad = [fig.add_subplot(gs[i, 0]) for i in range(len(labs))]
    a2 = fig.add_subplot(gs[:, 1])
    axt = fig.add_axes([0.07, bot, 0.90, tab_h])
    axt.axis("off")
    fig.suptitle(question, x=0.07, y=1 - 0.18 / H, ha="left", va="top", fontsize=11.5, fontweight="bold", color=INK)
    fig.text(0.07, 1 - 0.58 / H, window, ha="left", va="top", fontsize=8.5, color=MUTED)
    fs.bullets(fig, notes, bottom_in=0.12)
    x = np.arange(len(days))
    for ax, lab in zip(ad, labs):
        t, r = risks[lab]
        d = r["daily"]
        ax.bar(x, d, color=[GOOD if v >= 0 else BAD for v in d], zorder=3)
        ax.axhline(-stop_day, color=INK, ls=":", lw=1.1, zorder=4)
        ax.text(len(days) - 0.5, -stop_day, f"daily stop -{stop_day:.0f} [U]", fontsize=7.5, color=INK, ha="right", va="bottom")
        ax.axhline(0, color=N["axis"], lw=1.0)
        ax.set_xticks(x[::4])
        ax.set_xticklabels([days[i][5:] for i in x[::4]], fontsize=7)
        ax.set_ylabel("USD a day", fontsize=8)
        ax.set_title(f"{t.split(':')[0]}: net by UTC day, total {d.sum():+.0f} USD", fontsize=9, loc="left")
        a2.plot(np.arange(1, len(r["dd_path"]) + 1), -r["dd_path"], color=RULE_COL.get(lab, MUTED), lw=1.6, zorder=4, label=t.split(":")[0])
    a2.axhline(-dd_limit, color=INK, ls=":", lw=1.2, zorder=3)
    a2.text(1, -dd_limit, f" drawdown limit -{dd_limit:.0f} USD [U]", fontsize=8, color=INK, va="bottom")
    a2.axhline(0, color=N["axis"], lw=1.0)
    deep = max([float(np.max(r["dd_path"])) for _, r in risks.values() if len(r["dd_path"])] + [dd_limit])
    a2.set_ylim(-deep * 1.15, deep * 0.08)
    a2.set_xlabel("entry, in time order")
    a2.set_ylabel("below the running peak, USD")
    a2.set_title("drawdown, entry by entry", fontsize=9.5, loc="left")
    a2.legend(loc="lower right", fontsize=8, frameon=False)
    tb = fs.put_table(axt, rows, cols, size=8.5)
    for i, lab in enumerate(labs, 1):
        fs.tint(tb, i, 3, "rose" if risks[lab][1]["dd_crossed"] else "green")
    return fig


# ============================================================ capacity with the ask-seen limit (S6), beside tf15_capacity.rerun_curve (the edge price)
def curve_ask(tab, masks, lab, ndays, t_min, clips, n_boot=2000):
    """`tf15_capacity.rerun_curve`'s rows with the limit at the ask seen (the rule as built) instead of the edge price."""
    import tf15_capacity as CAP
    side, trig, lim = CAP._rule(tab, masks, lab, t_min, "ask", CAP.THETA)
    rows = []
    for x in clips:
        e = B.entries(tab, side, trig, lim, usd=float(x))
        n = len(e["net"])
        lo, hi = B.slot_boot(e["slot"], e["net"], n_boot=n_boot) if n else (NAN, NAN)
        per = float(e["net"].mean()) if n else NAN
        rows.append(dict(clip=float(x), n=n, per_day=n / ndays, per=per, lo=lo, hi=hi, ex5=CAP._ex_top(e["net"]) if n else NAN,
                         spent=float(e["cost"].mean()) if n else NAN, full=float(np.mean(e["cost"] >= float(x) - CAP.FULL_TOL)) if n else NAN,
                         day_net=n / ndays * per if n else NAN))
    return rows


def clip_fig(curves, window, notes, question="Does a bigger order keep the edge if we drop the few best trades?"):
    """Left: the net an entry with its 95% slot interval against the clip (log), a line a rule and limit (the rule's identity colour; the edge-price form
    drawn with square markers), zero the decision line. Right: the net an entry without the best 5% against the clip, the same lines, zero the decision line,
    the largest clip above zero marked. `curves` maps (label, form) to (title, rows)."""
    fig, (a1, a2) = LF.frame(4.2, notes, question, window, ncols=2, wspace=0.24)
    for (lab, form), (t, rows) in curves.items():
        x = np.array([r["clip"] for r in rows], float)
        col = RULE_COL.get(lab, MUTED)
        mk = "o" if form == "ask" else "s"
        lw = 1.5 if form == "ask" else 2.3
        a1.fill_between(x, [r["lo"] for r in rows], [r["hi"] for r in rows], color=col, alpha=0.10, lw=0, zorder=2)
        a1.plot(x, [r["per"] for r in rows], color=col, marker=mk, ms=5, lw=lw, zorder=4, label=f"{t.split(':')[0]}, limit at {'the ask seen' if form == 'ask' else 'our edge price'}")
        y5 = np.array([r["ex5"] for r in rows], float)
        a2.plot(x, y5, color=col, marker=mk, ms=5, lw=lw, zorder=4)
        pos = x[y5 > 0]
        if len(pos):
            a2.scatter([pos.max()], [y5[x == pos.max()][0]], s=110, facecolors="none", edgecolors=INK, linewidths=1.4, zorder=5)
    for ax in (a1, a2):
        ax.set_xscale("log")
        ax.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
        xs = [r["clip"] for r in next(iter(curves.values()))[1]]
        ax.set_xticks(xs)
        ax.set_xticklabels([f"{v:g}" for v in xs])
        ax.minorticks_off()
        ax.set_xlabel("clip, USD a trade (log scale)")
    a1.set_ylabel("net USD an entry (95% by slot)")
    a1.set_title("net an entry against the clip", fontsize=9.5, loc="left")
    a1.legend(loc="upper left", fontsize=7.5, frameon=False)
    a2.set_ylabel("net an entry without the best 5%, USD")
    a2.set_title("without the best 5% (ringed: the largest clip above zero)", fontsize=9.5, loc="left")
    return fig


# ============================================================ the live form of a chosen cell
def live_rule(cfg, usd=B.CLIP_USD):
    """The chosen cell as a `tf15_live.LayeredRule` when its stale definition is (a) (`stale_s` = n), or None with the reason: (b) and (c) need the history
    of every second (and for (c) the size at the touch), which `tf15_live.State` does not carry for sizes; a live rule for them is a change to `tf15_live`."""
    import tf15_live as LV
    if cfg["kind"] != "a":
        return None, f"definition ({cfg['kind']}) is not `LayeredRule.stale_s` (endpoints only); its live form needs `tf15_live` to read every second" + (" and the touch size" if cfg["kind"] == "c" else "")
    return LV.LayeredRule(L=cfg["L"], z_min=cfg["z_min"], theta=cfg["theta"], band=C.STALE_BANDS[cfg["band"]], t_min=cfg["t_min"], stale_s=cfg["n"], usd=usd,
                          name=cfg["name"]), ""


# ============================================================ the tuning, second pass (um-023 re-run, 2026-10-11): small, walk-forward, a plateau
# The owner: "make sure we tune E well." The first pass searched 1,944 cells on one split and its argmax lost the test week. This pass keeps only the
# parameters with a mechanism in the thesis (the stale window, the stale definition, the discount to fair value, the fill limit), fixes the rest at E's values, chooses on
# every week before the one it is applied to (an expanding walk-forward), and picks the best SMOOTHED score along the window, so a lone spike cannot win.
TUNE_LEVELS = dict(kind=("a", "b", "c"), n=(1, 2, 3, 4, 5, 6, 8, 10, 12), theta=(0.03, 0.05, 0.08), limit=("ask", "edge"))
TUNE_FIXED = dict(z_min=3.0, L=10, t_min=300, band="any")
TUNE_N_MIN = 60
LIMIT_NAME = {"ask": "the ask seen", "edge": "our edge price"}
DOT = (0, (1, 2.4))                                                    # the after-fee path, ink and dotted, as in tf15_trade_figs
WEEK_COL = {"tuned": INK2, "E": fs.IDENTITY["MODEL"], "A": MUTED}      # E as built keeps its colour of the whole notebook; the tuned record is the cell's ink2
WEEK_MK = {"tuned": "s", "E": "o", "A": "D"}


def tune_cell(kind="a", n=3, theta=0.05, limit="ask", fixed=None):
    """One cell of the second-pass grid: a `BuyNearStale` cell at the fixed levels plus its fill limit, named `<kind><n>|th<theta>|<limit>`."""
    c = C.BuyNearStale.cell(kind=kind, n=n, theta=theta, **(fixed or TUNE_FIXED))
    c.update(limit=limit, name=f"{kind}{int(n)}|th{theta:g}|{limit}")
    return c


def tune_grid(levels=None):
    """Every cell of the levels, definition-major (the grid names its own levels; nothing iterates a shared dict)."""
    lv = levels or TUNE_LEVELS
    return [tune_cell(k, n, th, f) for k in lv["kind"] for n in lv["n"] for th in lv["theta"] for f in lv["limit"]]


def run_tune(cand, tab, cells, log=None):
    """Each cell once on the pooled table at its own limit. -> dict name -> entries (every seated day) in time order ((slot, asset), `tf15_bt.concat`)."""
    out = {}
    for i, c in enumerate(cells):
        out[c["name"]] = B.concat(run_cell(cand, tab, c))
        if log and (i + 1) % 54 == 0:
            log(f"  {i + 1} of {len(cells)} cells run")
    return out


def ex5_point(net, pct=5):
    """The net an entry without the best ceil(pct% x n) entries (`tf15_bt.summarize`'s per_ex_top5)."""
    v = np.sort(np.asarray(net, float))
    n = len(v)
    k = int(np.ceil(pct / 100.0 * n))
    return float(v[:n - k].mean()) if n - k > 0 else NAN


def ex5_boot(slots, net, n_boot=2000, seed=7, pct=5, chunk=250):
    """The 95% interval of the net an entry without the best pct%, resampling 15-minute slots and trimming inside each draw (the accounting audit's method;
    used only when `tf15_bt.summarize` does not carry `per_ex_top5_lo/hi`). -> (lo, hi)."""
    net = np.asarray(net, float)
    if len(net) < 2:
        return (NAN, NAN)
    u, inv = np.unique(np.asarray(slots), return_inverse=True)
    o = np.argsort(-net, kind="stable")
    v, g, U = net[o], inv[o], len(u)
    rng = np.random.default_rng(seed)
    est = []
    for a in range(0, n_boot, chunk):
        m = min(chunk, n_boot - a)
        ix = rng.integers(0, U, size=(m, U))
        cnt = np.bincount((ix + (np.arange(m) * U)[:, None]).ravel(), minlength=m * U).reshape(m, U).astype(float)
        w = cnt[:, g]
        tot = w.sum(1)
        k = np.ceil(pct / 100.0 * tot)
        take = np.clip(k[:, None] - (np.cumsum(w, 1) - w), 0.0, w)
        est.append(((w - take) * v).sum(1) / np.maximum(tot - k, 1.0))
    est = np.concatenate(est)
    return float(np.quantile(est, 0.025)), float(np.quantile(est, 0.975))


def stats5(e):
    """`stats` with the interval of the net without the best 5% always present (`per_ex_top5_lo`, `per_ex_top5_hi`; NaN on no entry)."""
    s = stats(e)
    if not s.get("n"):
        s.update(per_ex_top5_lo=NAN, per_ex_top5_hi=NAN)
        return s
    if not np.isfinite(s.get("per_ex_top5_lo", NAN)):
        s["per_ex_top5_lo"], s["per_ex_top5_hi"] = ex5_boot(e["slot"], e["net"])
    return s


def cell_scores(ents, cells, idx):
    """name -> (entries, net an entry without the best 5%) on the days `idx`."""
    out = {}
    for c in cells:
        e = ents[c["name"]]
        m = np.isin(np.asarray(e["day"]), np.asarray(idx))
        out[c["name"]] = (int(m.sum()), ex5_point(np.asarray(e["net"])[m]))
    return out


def smooth(scores, cells, levels=None):
    """name -> the mean of the cell's own score and its neighbours' along n (the adjacent windows of the grid, same definition, discount and limit; a
    neighbour with no finite score is left out); NaN where the cell's own score is not finite."""
    ns = list((levels or TUNE_LEVELS)["n"])
    by = {(c["kind"], c["n"], c["theta"], c["limit"]): c["name"] for c in cells}
    out = {}
    for c in cells:
        own = scores[c["name"]][1]
        if not np.isfinite(own):
            out[c["name"]] = NAN
            continue
        i, vals = ns.index(c["n"]), [own]
        for j in (i - 1, i + 1):
            nm = by.get((c["kind"], ns[j], c["theta"], c["limit"])) if 0 <= j < len(ns) else None
            if nm is not None and np.isfinite(scores[nm][1]):
                vals.append(scores[nm][1])
        out[c["name"]] = float(np.mean(vals))
    return out


def rank_cells(scores, sm, cells, n_min=TUNE_N_MIN):
    """The plateau rule's order: cells with at least n_min entries and a finite smoothed score first, by smoothed score (highest first; equal to 1e-9 is a
    tie), ties to the smaller n, then grid order; the cells that do not qualify after them. -> list of dict(cfg, n, score, smoothed, eligible)."""
    rows = [dict(cfg=c, n=scores[c["name"]][0], score=scores[c["name"]][1], smoothed=sm[c["name"]], order=i,
                 eligible=bool(scores[c["name"]][0] >= n_min and np.isfinite(sm[c["name"]]))) for i, c in enumerate(cells)]
    key = lambda r: (-round(r["smoothed"], 9) if np.isfinite(r["smoothed"]) else np.inf, r["cfg"]["n"], r["order"])      # noqa: E731
    return sorted([r for r in rows if r["eligible"]], key=key) + sorted([r for r in rows if not r["eligible"]], key=key)


def choose_plateau(ents, cells, idx, n_min=TUNE_N_MIN, levels=None):
    """The plateau rule on the days `idx`: score every cell by its net an entry without the best 5%, smooth along n, rank (`rank_cells`)."""
    sc = cell_scores(ents, cells, idx)
    return rank_cells(sc, smooth(sc, cells, levels), cells, n_min)


def week_name(days, idx):
    """A week by its dates, `09-09 to 09-15` (never a fold number)."""
    return f"{days[int(idx[0])][5:]} to {days[int(idx[-1])][5:]}"


def agrees(s_in, s_out, min_n=1):
    """The owner's second question: the week a pick is traded on AGREES with the weeks it was chosen from when its net an entry without the best 5% is above
    zero and inside the choosing weeks' 95% slot interval of the same number; otherwise it COLLAPSES."""
    v = s_out.get("per_ex_top5", NAN)
    lo, hi = s_in.get("per_ex_top5_lo", NAN), s_in.get("per_ex_top5_hi", NAN)
    return bool(s_out.get("n", 0) >= min_n and np.isfinite(v) and v > 0 and np.isfinite(lo) and lo <= v <= hi)


def weeks_of(nd, week=7):
    """Weeks by day index [0:7] [7:14] ... (the last may be short)."""
    return [np.arange(a, min(a + week, nd)) for a in range(0, nd, week)]


def walk_forward(ents, cells, nd, week=7, n_min=TUNE_N_MIN, levels=None, e_name=None):
    """The expanding walk-forward: for week i = 2, 3, ... the plateau rule chooses on ALL weeks before it and the chosen cell is applied to week i alone. The
    record is the concatenation of every fold's chosen cell on its own week: every day of it scored by a cell chosen without it. Each fold also keeps, along n
    for the chosen definition, discount and limit, the raw and smoothed choosing scores and the week's realised numbers (`curve`). -> dict(folds, record,
    oos_idx, weeks)."""
    lv = levels or TUNE_LEVELS
    wk = weeks_of(nd, week)
    folds = []
    for i in range(1, len(wk)):
        ch_idx, out_idx = np.concatenate(wk[:i]), wk[i]
        rank = choose_plateau(ents, cells, ch_idx, n_min, lv)
        top = rank[0]
        cfg = top["cfg"]
        rk = {r["cfg"]["name"]: r for r in rank}
        line = sorted([c for c in cells if (c["kind"], c["theta"], c["limit"]) == (cfg["kind"], cfg["theta"], cfg["limit"])], key=lambda c: c["n"])
        curve = [dict(n=c["n"], name=c["name"], score=rk[c["name"]]["score"], smoothed=rk[c["name"]]["smoothed"], n_choose=rk[c["name"]]["n"],
                      week=stats5(by_days(ents[c["name"]], out_idx))) for c in line]
        applied = by_days(ents[cfg["name"]], out_idx)
        s_in, s_out = stats5(by_days(ents[cfg["name"]], ch_idx)), stats5(applied)
        folds.append(dict(fold=i + 1, choose_idx=ch_idx, out_idx=out_idx, rank=rank[:4], chosen=top, qualified=top["eligible"], applied=applied,
                          s=s_out, s_in=s_in, agree=agrees(s_in, s_out), curve=curve, e_week=stats5(by_days(ents[e_name], out_idx)) if e_name else None))
    record = B.concat(*[f["applied"] for f in folds])
    return dict(folds=folds, record=record, oos_idx=np.concatenate([f["out_idx"] for f in folds]), weeks=wk)


def wf_variant(cand, tab, wf, **kw):
    """The walk-forward record re-run with a `run_cell` variation (fee_mult, delay_k, slip): each fold's chosen cell on its own week."""
    return B.concat(*[by_days(run_cell(cand, tab, f["chosen"]["cfg"], **kw), f["out_idx"]) for f in wf["folds"]])


def deflated_record(ents, rec):
    """The record's Sharpe an entry, deflated over every tuned cell (the trial Sharpes are the cells' per-entry Sharpes on every seated day)."""
    srs = []
    for e in ents.values():
        v = np.asarray(e["net"], float)
        if len(v) > 2 and v.std(ddof=1) > 0:
            srs.append(float(v.mean() / v.std(ddof=1)))
    if len(rec["net"]) < 3:
        return None, None
    st = S.sharpe_stats(rec["net"])
    return st, S.deflated_sharpe(st["sr"], st["n"], st["skew"], st["kurt"], srs, len(ents))


def block_names(cells, cfg, levels=None):
    """The cells around `cfg` one step in n and one step in theta (the 3 x 3 block of its definition and limit, itself excluded)."""
    lv = levels or TUNE_LEVELS
    ns, ths = list(lv["n"]), list(lv["theta"])
    i, j = ns.index(cfg["n"]), ths.index(cfg["theta"])
    by = {(c["kind"], c["n"], c["theta"], c["limit"]): c["name"] for c in cells}
    out = []
    for a in (i - 1, i, i + 1):
        for b in (j - 1, j, j + 1):
            if (a, b) != (i, j) and 0 <= a < len(ns) and 0 <= b < len(ths):
                nm = by.get((cfg["kind"], ns[a], ths[b], cfg["limit"]))
                if nm:
                    out.append(nm)
    return out


def old_book(tab, e, ms=2000):
    """Entries decided on a book row at least `ms` old (the timing audit's frozen-feed test, `age` at the decision second). -> (count, of, their net USD)."""
    if not len(e["net"]):
        return 0, 0, 0.0
    a = tab.age[np.asarray(e["w"], int), np.asarray(e["k"], int)]
    m = a >= ms
    return int(m.sum()), len(a), float(np.asarray(e["net"])[m].sum())


def _canvas_tab(h_chart, n_tab, notes, question, window, nrows=1, ncols=1, ratios=None, widths=None, hspace=0.45, wspace=0.2, below=1.0, sharey=False, top_in=1.35):
    """A figure of `h_chart` inches of panels over one table of `n_tab` rows, the question over it and the findings under it. -> fig, axes, table axes."""
    nb = fs.nlines(notes)
    tab_in = 0.27 * (n_tab + 1)
    H = top_in + h_chart + below + tab_in + 0.35 + nb * fs.LINE_IN + 0.15
    fig = plt.figure(figsize=(13, H))
    bot = (0.12 + nb * fs.LINE_IN + 0.35) / H
    gs = fig.add_gridspec(nrows, ncols, left=0.07, right=0.97, top=1 - top_in / H, bottom=bot + (tab_in + below) / H, hspace=hspace, wspace=wspace,
                          **({"height_ratios": ratios} if ratios else {}), **({"width_ratios": widths} if widths else {}))
    axes = []
    for r in range(nrows):
        for c in range(ncols):
            axes.append(fig.add_subplot(gs[r, c], sharey=axes[0] if (sharey and axes) else None))
    axt = fig.add_axes([0.07, bot, 0.90, tab_in / H])
    axt.axis("off")
    fig.suptitle(question, x=0.07, y=1 - 0.18 / H, ha="left", va="top", fontsize=11.5, fontweight="bold", color=INK)
    fig.text(0.07, 1 - 0.58 / H, window, ha="left", va="top", fontsize=8.5, color=MUTED)
    fs.bullets(fig, notes, bottom_in=0.12)
    return fig, axes, axt, H


def _colw(tb, ws):
    """Each column's width as a share of the table's (`tf15_oos_figs._colw`); `ws` is normalised to sum to one."""
    t = float(sum(ws))
    for (r, c), cell in tb.get_celld().items():
        cell.set_width(ws[c] / t)


def _f(v, d=2):
    return "n/a" if v is None or not np.isfinite(v) else f"{v:+.{d}f}"


def surface_all_fig(surf, cells, e_name, final_name, window, notes, levels=None,
                    question="Which settings of the rule earn money even without the few best trades?"):
    """The descriptive surface of the second-pass grid on every seated day: one heat map a (definition, limit), the window n on x and the discount to fair value (theta, in cents) as rows;
    each cell shows the net an entry without the best 5% (bold when its 95% slot interval clears zero), that interval and the entry count, on a diverging
    scale around zero (green above, red below). The final cell is outlined thick in ink and its 3 x 3 neighbours thin in ink2; E as built in its identity
    colour. One table: each panel's best cell, its interval, the shares above zero. PASS or FAIL top right: the final cell and its neighbours clear zero."""
    lv = levels or TUNE_LEVELS
    V = fs.VERDICT
    ns, ths = list(lv["n"]), list(lv["theta"])
    by = {(c["kind"], c["n"], c["theta"], c["limit"]): c["name"] for c in cells}
    rows_t = []
    fig, axes, axt, H = _canvas_tab(7.2, len(lv["kind"]) * len(lv["limit"]), notes, question, window, nrows=len(lv["kind"]), ncols=len(lv["limit"]),
                                    hspace=0.55, wspace=0.12, below=0.55)
    vals = np.array([surf[c["name"]]["per_ex_top5"] for c in cells], float)
    span = float(np.nanmax(np.abs(vals))) if np.isfinite(vals).any() else 1.0
    cmap = LinearSegmentedColormap.from_list("g", [V["bad"], N["surface"], V["good"]])
    fin = next(c for c in cells if c["name"] == final_name)
    nb_fin = block_names(cells, fin, lv)
    gold = None
    for r, kind in enumerate(lv["kind"]):
        for c_, lim in enumerate(lv["limit"]):
            ax = axes[r * len(lv["limit"]) + c_]
            a = np.full((len(ths), len(ns)), np.nan)
            for i, th in enumerate(ths):
                for j, n in enumerate(ns):
                    s = surf[by[(kind, n, th, lim)]]
                    a[i, j] = s["per_ex_top5"]
                    clear = np.isfinite(s.get("per_ex_top5_lo", NAN)) and s["per_ex_top5_lo"] > 0
                    ax.text(j, i - 0.2, _f(a[i, j]), ha="center", va="center", fontsize=7.5, color=INK, weight="bold" if clear else "normal")
                    ax.text(j, i + 0.08, f"{_f(s.get('per_ex_top5_lo'), 1)}..{_f(s.get('per_ex_top5_hi'), 1)}", ha="center", va="center", fontsize=6.2, color=INK2)
                    ax.text(j, i + 0.33, f"n {s.get('n', 0):,}", ha="center", va="center", fontsize=6.2, color=INK2)
            ax.imshow(a, cmap=cmap, vmin=-span, vmax=span, aspect="auto")
            ax.grid(False)
            ax.set_xticks(range(len(ns)))
            ax.set_xticklabels([str(n) for n in ns], fontsize=7.5)
            ax.set_yticks(range(len(ths)))
            ax.set_yticklabels([f"{t * 100:.0f} c" for t in ths], fontsize=7.5)
            if c_ == 0:
                ax.set_ylabel("discount to fair value, cents", fontsize=8)
            if r == len(lv["kind"]) - 1:
                ax.set_xlabel("stale window n, seconds", fontsize=8)
            ax.set_title(f"{DEF_NAME[kind]} · limit at {LIMIT_NAME[lim]}", fontsize=8.8, loc="left")
            for nm, col, lw in [(e_name, fs.IDENTITY["MODEL"], 2.4)] + [(final_name, INK, 2.8)] + [(x, INK2, 0.9) for x in nb_fin]:
                cc = next(c for c in cells if c["name"] == nm)
                if (cc["kind"], cc["limit"]) == (kind, lim):
                    j, i = ns.index(cc["n"]), ths.index(cc["theta"])
                    pad = 0.06 if nm == e_name and nm != final_name else 0.0
                    ax.add_patch(Rectangle((j - 0.5 + pad, i - 0.5 + pad), 1 - 2 * pad, 1 - 2 * pad, fill=False, edgecolor=col, linewidth=lw, zorder=5))
            fin_a = np.where(np.isfinite(a), a, -np.inf)
            bi, bj = np.unravel_index(int(np.argmax(fin_a)), a.shape)
            bs = surf[by[(kind, ns[bj], ths[bi], lim)]]
            ref = surf[by[(kind, 3, 0.05, lim)]] if (kind, 3, 0.05, lim) in by else dict(per_ex_top5=NAN)
            lo_all = np.array([surf[by[(kind, n, th, lim)]].get("per_ex_top5_lo", NAN) for th in ths for n in ns], float)
            rows_t.append([f"({kind})", LIMIT_NAME[lim], by[(kind, ns[bj], ths[bi], lim)], f"{_f(bs['per_ex_top5'])} ({_f(bs.get('per_ex_top5_lo'))} to {_f(bs.get('per_ex_top5_hi'))})",
                           f"{bs.get('n', 0):,}", f"{int(np.sum(a > 0))} of {a.size}", f"{int(np.sum(lo_all > 0))} of {a.size}", _f(ref["per_ex_top5"])])
            if (kind, lim) == (fin["kind"], fin["limit"]):
                gold = len(rows_t)
    fv = [surf[final_name]["per_ex_top5"]] + [surf[x]["per_ex_top5"] for x in nb_fin]
    ok = bool(nb_fin) and all(np.isfinite(v) and v > 0 for v in fv)
    fig.text(0.97, 1 - 0.58 / H, ("PASS: the final cell and its neighbours clear zero" if ok else "FAIL: the final cell or a neighbour sits at or below zero"),
             ha="right", va="top", fontsize=9, color=V["good" if ok else "bad"], weight="bold")
    axes[0].legend(handles=[Patch(facecolor=V["good"], label="above zero"), Patch(facecolor=V["bad"], label="below zero"),
                            Patch(facecolor="none", edgecolor=INK, linewidth=2.4, label=f"final cell {final_name}"),
                            Patch(facecolor="none", edgecolor=INK2, linewidth=0.9, label="its neighbours"),
                            Patch(facecolor="none", edgecolor=fs.IDENTITY["MODEL"], linewidth=2.2, label=f"E as built {e_name}")],
                   loc="lower left", bbox_to_anchor=(0, 1.12), ncol=5, fontsize=8, frameon=False)
    tb = fs.put_table(axt, rows_t, ["Definition", "Limit", "Best cell", "Its ex-5% (95%)", "Entries", "Cells above 0", "Interval clears 0", "At 3 s, 5 c"], size=8.5)
    _colw(tb, [0.08, 0.11, 0.15, 0.20, 0.08, 0.12, 0.13, 0.13])
    if gold:
        fs.gold(tb, gold, 2)
    return fig


def _tt(e):
    """Each entry's time (the end of its 15-minute slot) as numpy datetime64."""
    return (np.asarray(e["slot"], np.int64) * 900 + 900).astype("datetime64[s]")


def walk_fig(recs, wf, days, notes, window, gate_ok, question="Does picking the setting from past weeks beat the plain 3-second rule?"):
    """Top: the cumulative PnL over the out-of-sample days, E tuned before the taker fee solid (ink2) and after it ink dotted, E as built and rule A after the
    fee solid in their colours; each week's start an ink vertical with the fold's chosen cell above it. Middle: each week's net an entry with its 95% slot
    interval, a marker a rule, zero the decision line. One table: a row a fold and the pooled record. PASS or FAIL top right (gate G-walk).
    `recs` maps "tuned", "E", "A" to (label, entries on the out-of-sample days)."""
    folds = wf["folds"]
    fig, axes, axt, H = _canvas_tab(5.6, len(folds) + 1, notes, question, window, nrows=2, ratios=(1.9, 1.0), hspace=0.5, below=0.9)
    a1, a2 = axes
    t0 = np.datetime64(days[folds[0]["out_idx"][0]], "s")
    for key, (lab, e) in recs.items():
        e = B.concat(e) if len(e["net"]) else e                                          # time order: (slot, asset)
        net = np.asarray(e["net"], float)
        x = np.concatenate([[t0], _tt(e)])
        c_net = np.concatenate([[0.0], np.cumsum(net)])
        if key == "tuned":
            g = np.asarray(e["gross"], float)
            c_gr = np.concatenate([[0.0], np.cumsum(g)])
            a1.step(x, c_gr, where="post", color=WEEK_COL[key], lw=2.0, zorder=4, label=f"{lab}, before the taker fee")
            a1.step(x, c_net, where="post", color=INK, lw=1.5, ls=DOT, zorder=6, label=f"{lab}, after the fee")
            a1.annotate(f"before {c_gr[-1]:+,.0f}", (x[-1], c_gr[-1]), xytext=(4, 3), textcoords="offset points", fontsize=8, color=WEEK_COL[key], weight="bold", annotation_clip=False)
            a1.annotate(f"after {c_net[-1]:+,.0f}", (x[-1], c_net[-1]), xytext=(4, -3), textcoords="offset points", va="top", fontsize=8, color=INK, weight="bold", annotation_clip=False)
        else:
            a1.step(x, c_net, where="post", color=WEEK_COL[key], lw=1.6, zorder=3, label=f"{lab}, after the fee")
            a1.annotate(f"{c_net[-1]:+,.0f}", (x[-1], c_net[-1]), xytext=(4, 0), textcoords="offset points", va="center", fontsize=8, color=WEEK_COL[key], annotation_clip=False)
    for f in folds:
        d0 = np.datetime64(days[f["out_idx"][0]], "s")
        d1 = np.datetime64(days[f["out_idx"][-1]], "s") + np.timedelta64(86400, "s")
        a1.axvline(d0, color=INK, lw=0.8, zorder=2)
        a1.text(d0 + (d1 - d0) / 2, 1.01, f"{week_name(days, f['out_idx'])}:\n{f['chosen']['cfg']['name']}", transform=a1.get_xaxis_transform(), ha="center", va="bottom", fontsize=7.2, color=INK)
    end = np.datetime64(days[folds[-1]["out_idx"][-1]], "s") + np.timedelta64(86400, "s")
    a1.set_xlim(t0, end + (end - t0) * 0.08)
    a1.axhline(0, color=N["axis"], lw=1.0, zorder=1)
    a1.set_ylabel("USD, cumulative")
    a1.legend(loc="upper left", fontsize=7.8, frameon=False)
    import matplotlib.dates as mdates
    a1.xaxis.set_major_locator(mdates.DayLocator(interval=max(1, len(wf["oos_idx"]) // 12)))
    a1.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d"))
    xs = np.arange(len(folds))
    for o, key in zip((-0.18, 0.0, 0.18), ("tuned", "E", "A")):
        lab, e = recs[key]
        for i, f in enumerate(folds):
            s = stats(by_days(e, f["out_idx"]))
            if not s.get("n"):
                continue
            a2.errorbar([i + o], [s["per"]], yerr=[[s["per"] - s["per_lo"]], [s["per_hi"] - s["per"]]], fmt=WEEK_MK[key], color=WEEK_COL[key], ecolor=WEEK_COL[key],
                        ms=5, elinewidth=1.1, capsize=3, zorder=4, label=lab if i == 0 else None)
    a2.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
    a2.set_xticks(xs)
    a2.set_xticklabels([week_name(days, f["out_idx"]) for f in folds], fontsize=8)
    a2.set_ylabel("net USD an entry (95% by slot)")
    a2.set_title("each traded week: net an entry (the pick chosen on the weeks before it)", fontsize=9.5, loc="left")
    a2.legend(loc="upper center", bbox_to_anchor=(0.5, -0.18), ncol=3, fontsize=8, frameon=False)
    rows = []
    for f in folds:
        s, se = f["s"], f["e_week"] or dict(n=0)
        rows.append([week_name(days, f["out_idx"]), week_name(days, f["choose_idx"]), f["chosen"]["cfg"]["name"] + ("" if f["qualified"] else " (thin)"),
                     f"{s.get('n', 0):,}", _f(s.get("per")), f"{_f(s.get('per_ex_top5'))} ({_f(s.get('per_ex_top5_lo'))} to {_f(s.get('per_ex_top5_hi'))})",
                     f"{se.get('n', 0):,}", _f(se.get("per")), _f(se.get("per_ex_top5"))])
    st, se = stats5(recs["tuned"][1]), stats5(recs["E"][1])
    rows.append(["all 5 weeks", f"{len(wf['oos_idx'])} days traded", "each week's pick", f"{st.get('n', 0):,}", _f(st.get("per")),
                 f"{_f(st.get('per_ex_top5'))} ({_f(st.get('per_ex_top5_lo'))} to {_f(st.get('per_ex_top5_hi'))})", f"{se.get('n', 0):,}", _f(se.get("per")),
                 f"{_f(se.get('per_ex_top5'))} ({_f(se.get('per_ex_top5_lo'))} to {_f(se.get('per_ex_top5_hi'))})"])
    tb = fs.put_table(axt, rows, ["Traded week", "Chosen on", "Pick", "Entries", "Net an entry", "Ex-5% (95%)", "E entries", "E net", "E ex-5%"], size=7.8)
    _colw(tb, [0.10, 0.12, 0.13, 0.07, 0.09, 0.17, 0.08, 0.07, 0.17])
    n_r = len(rows)
    fs.gold(tb, n_r, 5)
    fs.tint(tb, n_r, 8, "green" if gate_ok else "rose")
    fig.text(0.97, 1 - 0.18 / H, "PASS: E tuned beats E as built" if gate_ok else "FAIL: E tuned does not beat E as built",
             ha="right", va="top", fontsize=9, color=fs.VERDICT["good" if gate_ok else "bad"], weight="bold")
    return fig


def stable_fig(wf, days, notes, window, question="Is the setting we picked the same from one week to the next?"):
    """A panel a fold: along the window n for the fold's chosen definition, discount and limit, the smoothed choosing score (model identity, the rule's belief),
    the raw choosing score (muted) and the applied week's realised net without the best 5% (Polymarket identity, the market's answer) with its 95% slot
    interval; the chosen n an ink dotted vertical, zero the axis line. One table: the traded week by its dates, the pick, its three runners-up, the pick's net without
    the best 5% on its choosing weeks (with the interval) and on the traded week, and whether the two agree (`agrees`)."""
    folds = wf["folds"]
    fig, axes, axt, H = _canvas_tab(3.3, len(folds), notes, question, window, ncols=len(folds), wspace=0.22, below=0.75, top_in=1.75)
    MODEL, PM = fs.IDENTITY["MODEL"], fs.IDENTITY["POLYMARKET"]
    rows = []
    for ax, f in zip(axes, folds):
        cv = f["curve"]
        x = np.array([c["n"] for c in cv], float)
        wk = np.array([c["week"]["per_ex_top5"] for c in cv], float)
        lo = np.array([c["week"].get("per_ex_top5_lo", NAN) for c in cv], float)
        hi = np.array([c["week"].get("per_ex_top5_hi", NAN) for c in cv], float)
        ax.fill_between(x, lo, hi, color=PM, alpha=0.15, lw=0, zorder=2)
        ax.plot(x, wk, color=PM, marker="o", ms=4, lw=1.7, zorder=4, label="the week it is applied to: realised")
        ax.plot(x, [c["score"] for c in cv], color=MUTED, marker=".", ms=4, lw=1.0, zorder=3, label="choosing weeks: raw score")
        ax.plot(x, [c["smoothed"] for c in cv], color=MODEL, marker="s", ms=4, lw=1.9, zorder=5, label="choosing weeks: smoothed score (the rule)")
        cn = f["chosen"]["cfg"]["n"]
        ax.axvline(cn, color=INK, ls=":", lw=1.2, zorder=6)
        ax.text(cn, 0.98, f" chosen {cn} s", transform=ax.get_xaxis_transform(), fontsize=7.5, color=INK, va="top", ha="right" if cn >= 8 else "left")
        ax.axhline(0, color=N["axis"], lw=1.0, zorder=1)
        ax.set_xticks(x)
        ax.set_xticklabels([str(int(v)) for v in x], fontsize=7)
        c = f["chosen"]["cfg"]
        ax.set_title(f"{week_name(days, f['out_idx'])}: ({c['kind']}) {c['theta'] * 100:.0f} c, {c['limit']}", fontsize=8.5, loc="left")
        ax.set_xlabel("stale window n, s", fontsize=8)
        ru = [r["cfg"]["name"] + f" {_f(r['smoothed'])}" for r in f["rank"][1:4]]
        si = f["s_in"]
        rows.append([week_name(days, f["out_idx"]), c["name"], _f(f["chosen"]["smoothed"]), *(ru + ["-"] * (3 - len(ru))),
                     f"{_f(si.get('per_ex_top5'))} ({_f(si.get('per_ex_top5_lo'))} to {_f(si.get('per_ex_top5_hi'))})", _f(f["s"].get("per_ex_top5")), "agrees" if f["agree"] else "collapses"])
    axes[0].set_ylabel("net an entry without the best 5%, USD")
    axes[0].legend(loc="lower left", bbox_to_anchor=(0, 1.1), ncol=3, fontsize=8, frameon=False)
    tb = fs.put_table(axt, rows, ["Traded week", "Pick", "Smoothed", "Runner-up 1", "Runner-up 2", "Runner-up 3", "Chosen-on ex-5% (95%)", "Traded ex-5%", "Agree?"], size=7.5)
    _colw(tb, [0.09, 0.11, 0.06, 0.14, 0.14, 0.14, 0.15, 0.09, 0.08])
    ns = [f["chosen"]["cfg"]["n"] for f in folds]
    for i, (n, f) in enumerate(zip(ns, folds), 1):
        fs.tint(tb, i, 1, "green" if ns.count(n) >= max(2, len(ns) - 1) else "rose")
        fs.tint(tb, i, 8, "green" if f["agree"] else "rose")
    return fig


def final_fig(lat, costs, rows, cols, notes, window, base_ms=250, question="Does the final setting survive a late order and a higher fee?"):
    """Left: the net an entry with its 95% slot interval against the delay (log scale). Middle: the total net USD against the delay. Right: the net an entry
    with its interval against the fee multiple (1 = each market's own rate), each rule's break-even multiple labelled. Lines in the rules' identity colours,
    zero the decision line, the study's 250 ms and the venue's own rate ink dotted verticals. One table (`rows`, `cols`): the final cell's reads."""
    fig, axes, axt, H = _canvas_tab(3.4, len(rows), notes, question, window, ncols=3, wspace=0.24, below=0.75)
    a1, a2, a3 = axes
    for lab, (t, rr) in lat.items():
        x = np.array([r["ms"] for r in rr], float)
        col, mk = RULE_COL.get(lab, MUTED), RULE_MK.get(lab, "o")
        a1.fill_between(x, [r["s"]["per_lo"] for r in rr], [r["s"]["per_hi"] for r in rr], color=col, alpha=0.14, lw=0, zorder=2)
        a1.plot(x, [r["s"]["per"] for r in rr], color=col, marker=mk, ms=4, lw=1.8, zorder=4, label=t)
        a2.plot(x, [r["total"] for r in rr], color=col, marker=mk, ms=4, lw=1.8, zorder=4, label=t)
    for lab, (t, c) in costs.items():
        col, mk = RULE_COL.get(lab, MUTED), RULE_MK.get(lab, "o")
        m = np.array([v for v, _ in c["fee"]], float)
        a3.fill_between(m, [s["per_lo"] for _, s in c["fee"]], [s["per_hi"] for _, s in c["fee"]], color=col, alpha=0.14, lw=0, zorder=2)
        a3.plot(m, [s["per"] for _, s in c["fee"]], color=col, marker=mk, ms=4, lw=1.8, zorder=4, label=t)
        if np.isfinite(c.get("be_mult", NAN)) and c["be_mult"] <= m.max():
            right = c["be_mult"] > 0.6 * m.max()
            a3.annotate(f"{t.split(':')[0]} breaks even at {c['be_mult']:.2f}x", (c["be_mult"], 0), xytext=(-4 if right else 4, 12), textcoords="offset points", fontsize=7.5, color=INK,
                        ha="right" if right else "left", arrowprops=dict(arrowstyle="-", color=INK, lw=0.8))
    ticks = next(iter(lat.values()))[1]
    for ax in (a1, a2):
        ax.set_xscale("log")
        ax.axvline(base_ms, color=INK, ls=":", lw=1.1, zorder=3)
        ax.set_xticks([r["ms"] for r in ticks])
        ax.set_xticklabels([f"{r['ms']:,}" for r in ticks], fontsize=7, rotation=45)
        ax.minorticks_off()
        ax.set_xlabel("delay, ms (log scale)", fontsize=8)
    for ax in (a1, a2, a3):
        ax.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
    a3.axvline(1.0, color=INK, ls=":", lw=1.1, zorder=3)
    a1.set_title("net an entry against the delay", fontsize=9.5, loc="left")
    a1.set_ylabel("net USD an entry (95% by slot)")
    a2.set_title("total net USD against the delay", fontsize=9.5, loc="left")
    a2.set_ylabel("net USD, all entries")
    a3.set_title("net an entry against the fee", fontsize=9.5, loc="left")
    a3.set_xlabel("fee as a multiple of each market's own rate", fontsize=8)
    a1.legend(loc="lower left", bbox_to_anchor=(0, 1.1), ncol=2, fontsize=8, frameon=False)
    tb = fs.put_table(axt, rows, cols, size=8.5)
    _colw(tb, [0.30, 0.06, 0.08, 0.08, 0.19, 0.19, 0.10][:len(cols)])
    for i, r in enumerate(rows, 1):
        v = r[4]
        if isinstance(v, str) and v[:1] in "+-":
            fs.tint(tb, i, 4, "green" if v.startswith("+") else "rose")
    fs.gold(tb, 2, 4)
    return fig


def delay_entries(cand, tabs, cfg, base_ms=250, extra=(1, 2, 3, 5)):
    """The cell's entries (time order) at every delay `latency_rows` reads: each seated table, and whole seconds added to the base table. -> dict ms -> entries."""
    out = {int(ms): B.concat(run_cell(cand, t, cfg)) for ms, t in tabs.items()}
    for j in extra:
        out[int(base_ms + 1000 * j)] = B.concat(run_cell(cand, tabs[base_ms], cfg, delay_k=j))
    return dict(sorted(out.items()))


def fee_entries(cand, tab, cfg, mults=(0.0, 0.5, 1.0, 1.5, 2.0, 3.0)):
    """The cell's entries (time order) with the fee at each multiple of each market's own rate. -> dict multiple -> entries."""
    return {float(m): B.concat(run_cell(cand, tab, cfg, fee_mult=m)) for m in mults}


def halving(points):
    """The first read point whose total is at most half the base total, from (x, total, is_base) in order; None when the total never halves."""
    base = next(t for x, t, b in points if b)
    after = False
    for x, t, b in points:
        after = after or b
        if after and not b and base > 0 and t <= base / 2:
            return x
    return None


def paths_fig(panels, days, window, notes, question):
    """The cumulative PnL after the fee over time, one solid line per variant (a delay or a fee multiple), a panel a rule (same y scale). The variants of a rule
    share its identity colour and differ by a ramp of alpha (lighter for the shorter delay or the smaller fee, darker for the longer or larger); the study's
    own variant is drawn thicker and named. Each line's end carries its label and total; zero is the ink dotted line. `panels` maps a rule ("E", "cell") to
    (title, [(label, entries, is_base), ...]) in the ramp's order."""
    fig, axes = LF.frame(4.4, notes, question, window, ncols=len(panels), wspace=0.12, sharey=True)
    t0 = np.datetime64(days[0], "s")
    t1 = np.datetime64(days[-1], "s") + np.timedelta64(86400, "s")
    all_ends = []
    for ax, (lab, (title, lines)) in zip(axes, panels.items()):
        col = RULE_COL.get(lab, MUTED)
        k = len(lines)
        ends = []
        all_ends.append((ax, col, ends))
        for i, (name, e, base) in enumerate(lines):
            al = 0.25 + 0.75 * i / max(k - 1, 1)
            net = np.asarray(e["net"], float)
            x = np.concatenate([[t0], _tt(e)])
            y = np.concatenate([[0.0], np.cumsum(net)])
            ax.step(x, y, where="post", color=col, alpha=al, lw=2.6 if base else 1.4, zorder=5 if base else 4,
                    label=f"{name} (the study's assumption)" if base else name)
            ends.append((y[-1], f"{name} {y[-1]:+,.0f}" + (" (assumed)" if base else ""), al, base))
        ax.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
        ax.set_xlim(t0, t1 + (t1 - t0) * 0.36)
        _day_ticks(ax, days, 8)
        ax.set_title(title, fontsize=9.5, loc="left")
        ax.set_xlabel("UTC day")
        ax.legend(loc="upper left", fontsize=7.5, frameon=False)
    axes[0].set_ylabel("USD after the fee, cumulative")
    lo_, hi_ = axes[0].get_ylim()
    for ax, col, ends in all_ends:                                             # labels at the right edge, pushed apart on the final shared scale
        last = None
        for v, txt, al, base in sorted(ends, key=lambda t: t[0]):
            yv = v if last is None else max(v, last + (hi_ - lo_) * 0.045)
            ax.annotate(txt, (t1, v), xytext=(t1 + (t1 - t0) * 0.015, yv), textcoords="data", fontsize=7.5, color=col, alpha=max(al, 0.6), va="center",
                        weight="bold" if base else "normal", annotation_clip=False)
            last = yv
    return fig


def _day_ticks(ax, days, n=12):
    """Date ticks on the seated days only (never on the label room the x range adds after them)."""
    import matplotlib.dates as mdates
    step = max(1, len(days) // n)
    ax.set_xticks([np.datetime64(d, "s") for d in days[::step]])
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d"))


def ex5_path(net, pct=5):
    """The running sum of a set of entries (time order) with its best ceil(pct% x n) entries set to zero."""
    net = np.asarray(net, float)
    n = len(net)
    k = int(np.ceil(pct / 100.0 * n))
    v = net.copy()
    if k and n:
        v[np.argsort(-net, kind="stable")[:k]] = 0.0
    return np.cumsum(v)


def weekly_ex5_fig(rules, days, week, window, notes, question="Do we still make money each week if we drop the few best trades?", cols=None):
    """A panel a rule (stacked on one time axis): each week's PnL after the fee cumulated from zero, all entries solid in the rule's identity colour and the
    same week with its best 5% of entries set to zero solid in muted grey; each week's start an ink vertical, its dates under the panels, PASS (green) or FAIL
    (red) above it when the without-best-5% line ends above zero or not; zero ink dotted. One table: a row a rule and week, and the pooled days.
    `rules` maps "cell", "E" to (title, entries on every day)."""
    import matplotlib.dates as mdates
    wk = weeks_of(len(days), week)
    n_rows = len(rules) * (len(wk) + 1)
    fig, axes, axt, H = _canvas_tab(5.2, n_rows, notes, question, window, nrows=len(rules), hspace=0.42, below=0.85)
    rows, tints = [], []
    for ax, (lab, (title, e)) in zip(axes, rules.items()):
        col = (cols or RULE_COL).get(lab, MUTED)
        e = B.concat(e) if len(e["net"]) else e
        n_pass = 0
        for j, idx in enumerate(wk):
            sub = by_days(e, idx)
            d0 = np.datetime64(days[int(idx[0])], "s")
            d1 = np.datetime64(days[int(idx[-1])], "s") + np.timedelta64(86400, "s")
            ax.axvline(d0, color=INK, lw=0.8, zorder=2)
            s = stats5(sub)
            if s.get("n"):
                x = np.concatenate([[d0], _tt(sub)])
                ax.step(x, np.concatenate([[0.0], np.cumsum(sub["net"])]), where="post", color=col, lw=2.4, zorder=4, label="all entries, after the fee" if j == 0 else None)
                ax.step(x, np.concatenate([[0.0], ex5_path(sub["net"])]), where="post", color=MUTED, lw=1.3, zorder=5, label="without the week's best 5%" if j == 0 else None)
            ok = bool(s.get("n")) and s["per_ex_top5"] > 0
            n_pass += ok
            ax.text(d0 + (d1 - d0) / 2, 1.01, "PASS" if ok else "FAIL", transform=ax.get_xaxis_transform(), ha="center", va="bottom", fontsize=8.5, weight="bold",
                    color=fs.VERDICT["good" if ok else "bad"])
            rows.append([title.split(":")[0], week_name(days, idx), f"{s.get('n', 0):,}", _f(s.get("per")), _f(s.get("per_ex_top5")),
                         f"{_f(s.get('per_ex_top5_lo'))} to {_f(s.get('per_ex_top5_hi'))}", "PASS" if ok else "FAIL"])
            tints.append("green" if ok else "rose")
        sa = stats5(e)
        rows.append([title.split(":")[0], f"all {len(days)} days", f"{sa.get('n', 0):,}", _f(sa.get("per")), _f(sa.get("per_ex_top5")),
                     f"{_f(sa.get('per_ex_top5_lo'))} to {_f(sa.get('per_ex_top5_hi'))}", f"{n_pass} of {len(wk)} weeks pass"])
        tints.append(None)
        ax.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
        ax.set_xlim(np.datetime64(days[0], "s"), np.datetime64(days[-1], "s") + np.timedelta64(86400, "s"))
        ax.xaxis.set_major_locator(mdates.DayLocator(interval=max(1, len(days) // 12)))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d"))
        ax.set_ylabel("USD, each week from zero")
        ax.set_title(title, fontsize=9.5, loc="left", pad=16)
        ax.legend(loc="upper left", fontsize=7.5, frameon=False)
    axes[-1].set_xlabel("UTC day (each week's PnL starts again at zero at its ink line)")
    tb = fs.put_table(axt, rows, ["Rule", "Week", "Entries", "Net an entry", "Without best 5%", "95% interval", "Verdict"], size=7.6)
    _colw(tb, [0.22, 0.14, 0.08, 0.1, 0.12, 0.16, 0.18])
    for i, t in enumerate(tints, 1):
        if t:
            fs.tint(tb, i, 6, t)
        else:
            fs.gold(tb, i, 4)
    return fig


def rules_paths_fig(lines, days, weeks, window, notes, question="Did the tuned rule grow the account faster than the plain rule?"):
    """The cumulative PnL after the fee over time, a solid line a rule, each line from zero on its own first day, its end labelled with its total; the week
    boundaries faint verticals, zero ink dotted. `lines` is a list of (label, end name, entries, colour, linewidth, first day index)."""
    fig, (ax,) = LF.frame(4.6, notes, question, window)
    t_end = np.datetime64(days[-1], "s") + np.timedelta64(86400, "s")
    t_beg = np.datetime64(days[0], "s")
    for idx in weeks[1:]:
        ax.axvline(np.datetime64(days[int(idx[0])], "s"), color=N["grid"], lw=1.4, zorder=1)
    ends = []
    for lab, short, e, col, lw, d0 in lines:
        e = B.concat(e) if len(e["net"]) else e
        x = np.concatenate([[np.datetime64(days[d0], "s")], _tt(e)])
        y = np.concatenate([[0.0], np.cumsum(np.asarray(e["net"], float))])
        ax.step(x, y, where="post", color=col, lw=lw, zorder=4, label=lab)
        ends.append((y[-1], f"{short} {y[-1]:+,.0f}", col))
    lo_, hi_ = ax.get_ylim()
    span = (hi_ - lo_) or 1.0
    last = None
    for v, txt, col in sorted(ends, key=lambda t: t[0]):
        yv = v if last is None else max(v, last + span * 0.045)
        ax.annotate(txt, (t_end, v), xytext=(t_end + (t_end - t_beg) * 0.01, yv), textcoords="data", fontsize=8, color=col, va="center", weight="bold", annotation_clip=False)
        last = yv
    ax.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
    ax.set_xlim(t_beg, t_end + (t_end - t_beg) * 0.14)
    _day_ticks(ax, days, 12)
    ax.set_ylabel("USD after the fee, cumulative")
    ax.set_xlabel("UTC day (faint lines: the week boundaries)")
    ax.legend(loc="upper left", fontsize=8, frameon=False)
    return fig


def e_gates(tab, cfg, pu=None, cap=None, feed=True):
    """The stale cell's conditions with two optional changes: `pu` another fair value (W, NK) for the discount test, `cap` the most the ask seen may be
    (USD a share, on the gate's cent grid). -> dict(up, dn (the burst), nup_up, nup_dn (every other condition, the feed mask in it))."""
    c = C.stale_cache(tab)
    up, dn = C._stale_mask(tab, ("burst", cfg["L"], cfg["z_min"]))
    p = c["pu"] if pu is None else np.asarray(pu, float)
    with np.errstate(invalid="ignore"):
        nu, nd = c["qa"] < p - cfg["theta"], c["qd"] < (1.0 - p) - cfg["theta"]
        if cap is not None:
            nu, nd = nu & (c["qa"] <= cap + 1e-9), nd & (c["qd"] <= cap + 1e-9)
    bu, bd = C._stale_mask(tab, ("band", cfg["band"]))
    su, sd = C.stale_masks(tab, cfg["kind"], cfg["n"])
    fl = C._stale_feed(tab) if feed else True
    return dict(up=up, dn=dn, nup_up=nu & bu & su & fl, nup_dn=nd & bd & sd & fl)


def e_variant(tab, cfg, pu=None, cap=None, feed=True, usd=B.CLIP_USD):
    """The cell with `e_gates`' changes, filled as `BuyNearStale` fills (limit the ask seen, one entry a window, retry each second). -> (entries, gates
    (gate_up, gate_dn) before the time mask, masks for `tf15_oos.random_burst` under the label "A")."""
    g = e_gates(tab, cfg, pu, cap, feed)
    g_up, g_dn = g["up"] & g["nup_up"], g["dn"] & g["nup_dn"]
    side = g_up.astype(np.int8) - g_dn.astype(np.int8)
    tm = C.tmask(tab, cfg["t_min"])
    e = B.concat(B.entries(tab, side, (g_up | g_dn) & tm, C._stale_mask(tab, ("lim", cfg["L"])), usd))
    return e, (g_up, g_dn), dict(nup_up=g["nup_up"], nup_dn=g["nup_dn"], tm=tm)


def gate_paths_fig(lines, days, window, notes, question="Does the capped version of E build the account better?"):
    """Two panels on one time axis: the cumulative PnL after the fee of each rule (a solid line in its colour), and the same with each rule's best 5% of
    entries set to zero; each line's end labelled with its total, zero ink dotted. `lines` is a list of (label, short name, entries, colour)."""
    fig, axes = LF.frame(6.4, notes, question, window, nrows=2, hspace=0.38)
    t0 = np.datetime64(days[0], "s")
    t1 = np.datetime64(days[-1], "s") + np.timedelta64(86400, "s")
    ends = {0: [], 1: []}
    for lab, short, e, col in lines:
        e = B.concat(e) if len(e["net"]) else e
        x = np.concatenate([[t0], _tt(e)])
        for i, y in enumerate((np.concatenate([[0.0], np.cumsum(np.asarray(e["net"], float))]), np.concatenate([[0.0], ex5_path(e["net"])]))):
            axes[i].step(x, y, where="post", color=col, lw=1.8, zorder=4, label=lab)
            ends[i].append((y[-1], f"{short} {y[-1]:+,.0f}", col))
    for i, ax in enumerate(axes):
        ax.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
        ax.set_xlim(t0, t1 + (t1 - t0) * 0.16)
        _day_ticks(ax, days, 12)
        ax.set_ylabel("USD after the fee, cumulative")
        ax.set_title("every entry" if i == 0 else "without each rule's best 5% of entries (set to zero)", fontsize=9.5, loc="left")
    axes[0].legend(loc="upper left", fontsize=8, frameon=False)
    axes[1].set_xlabel("UTC day")
    for i, ax in enumerate(axes):
        lo_, hi_ = ax.get_ylim()
        last = None
        for v, txt, col in sorted(ends[i], key=lambda t: t[0]):
            yv = v if last is None else max(v, last + (hi_ - lo_) * 0.05)
            ax.annotate(txt, (t1, v), xytext=(t1 + (t1 - t0) * 0.01, yv), textcoords="data", fontsize=8, color=col, va="center", weight="bold", annotation_clip=False)
            last = yv
    return fig


LADDER_NOTIONAL = (2000.0, 3000.0, 4000.0, 5000.0, 10000.0)        # starting notional, USD; the clip is 1% of it (the owner, 2026-10-11)


def entries_fok(tab, side, trig, lim, usd=B.CLIP_USD):
    """The venue's FOK ("fills entirely or cancels immediately"): an order counts only when the whole clip fills at or under its limit on the ladder it meets;
    otherwise nothing trades and the rule decides again at its next second, as with a miss under FAK. -> entries in time order."""
    import tf15_capacity as CAP
    e = B.entries(tab, side, trig, lim, usd, one_per_window=False)
    if not len(e["net"]):
        return e
    e = B.subset(e, np.asarray(e["cost"]) >= float(usd) - CAP.FULL_TOL)
    if len(e["net"]):
        w = np.asarray(e["w"])
        e = B.subset(e, np.concatenate([[True], w[1:] != w[:-1]]))
    return B.concat(e) if len(e["net"]) else e


def ladder_rows(cand, tab, cfg, ndays, notionals=LADDER_NOTIONAL, pct=0.01):
    """The sizing ladder of a cell at `pct` of each starting notional a trade. Fill statistics on each window's FIRST order (the rule's first trigger second,
    its limit, the ladder 250 ms later; `tf15_capacity.walk_to`): the share filled in full, the mean USD got over USD wanted, the share with no fill (under 5
    shares), the mean cents paid over the best ask. Money on the engine re-run at that clip (a miss retries at the next second): under the venue's FAK
    (`tf15_bt.entries`, what fills kept from 5 shares) and FOK (`entries_fok`). -> list of dict."""
    import tf15_capacity as CAP
    side, trig, lim, _ = cand.triggers(tab, cfg, {})
    lim = limit_of(tab, cfg, side, lim, cfg.get("limit", "ask"))
    trig = trig & (side != 0) & np.isfinite(lim)
    has = trig.any(axis=1)
    w = np.flatnonzero(has)
    k = np.argmax(trig[w], axis=1)
    e0 = dict(w=w, k=k, side=side[w, k])
    clips = [n * pct for n in notionals]
    wt = CAP.walk_to(tab, e0, clips, limit=lim[w, k]) if len(w) else None
    rows = []
    for j, (nt, x) in enumerate(zip(notionals, clips)):
        sh = wt["shares"][:, j] if wt is not None else np.zeros(0)
        got = sh >= B.MIN_SHARES
        r = dict(notional=nt, clip=x, orders=len(w), full=float(np.mean(wt["full"][:, j] & got)) if len(w) else NAN,
                 fill_share=float(np.mean(np.where(got, wt["cost"][:, j], 0.0) / x)) if len(w) else NAN, none=float(np.mean(~got)) if len(w) else NAN,
                 cents=float(np.nanmean(np.where(got, wt["cents"][:, j], np.nan))) if got.any() else NAN)
        for nm, e in (("fak", B.concat(B.entries(tab, side, trig, lim, x))), ("fok", entries_fok(tab, side, trig, lim, x))):
            s = stats(e)
            r[nm] = dict(n=s.get("n", 0), per=s["per"], lo=s["per_lo"], hi=s["per_hi"], ex5=s["per_ex_top5"], day=(s.get("n", 0) / ndays * s["per"]) if s.get("n") else NAN)
        rows.append(r)
    return rows


def ladder_fig(lad, window, notes, question="How big an order still fills in full at our price, and what does it earn a day?"):
    """Four panels against the starting notional (the clip 1% of it, log scale), a line a rule in its identity colour: the share of first orders filled in
    full with the 90% decision line; the mean cents paid over the best ask; the net a day under the venue's FAK and under its FOK, zero the decision line.
    One table: a row a rule and clip. `lad` maps a label ("E", "cell") to (title, ladder_rows)."""
    fig, axes, axt, H = _canvas_tab(5.6, sum(len(r) for _, r in lad.values()), notes, question, window, nrows=2, ncols=2, hspace=0.5, wspace=0.2, below=0.8)
    a1, a2, a3, a4 = axes
    rows = []
    for lab, (title, rr) in lad.items():
        col, mk = RULE_COL.get(lab, MUTED), RULE_MK.get(lab, "o")
        x = np.array([r["notional"] for r in rr], float)
        a1.plot(x, [r["full"] for r in rr], color=col, marker=mk, ms=5, lw=1.9, zorder=4, label=title)
        a2.plot(x, [r["cents"] for r in rr], color=col, marker=mk, ms=5, lw=1.9, zorder=4)
        a3.plot(x, [r["fak"]["day"] for r in rr], color=col, marker=mk, ms=5, lw=1.9, zorder=4)
        a4.plot(x, [r["fok"]["day"] for r in rr], color=col, marker=mk, ms=5, lw=1.9, zorder=4)
        for r in rr:
            rows.append([title.split(":")[0], f"{r['notional']:,.0f} ({r['clip']:g})", f"{r['full']:.0%}", f"{r['fill_share']:.0%}", f"{r['none']:.0%}", _f(r["cents"]),
                         _f(r["fak"]["per"]), _f(r["fak"]["day"]), _f(r["fok"]["day"])])
    ticks = [r["notional"] for r in next(iter(lad.values()))[1]]
    for ax in axes:
        ax.set_xscale("log")
        ax.set_xticks(ticks)
        ax.set_xticklabels([f"{t:,.0f}" for t in ticks], fontsize=7.5)
        ax.minorticks_off()
    a1.axhline(0.9, color=INK, ls=":", lw=1.2, zorder=3)
    a1.text(ticks[0], 0.9, " 90% filled in full", va="bottom", fontsize=7.5, color=INK)
    for ax in (a3, a4):
        ax.axhline(0, color=INK, ls=":", lw=1.2, zorder=3)
        ax.set_xlabel("starting notional, USD (the clip is 1% of it)", fontsize=8)
    a1.set_title("first orders filled in full", fontsize=9.5, loc="left")
    a1.set_ylabel("share of first orders")
    a2.set_title("cents paid over the best ask (filled orders)", fontsize=9.5, loc="left")
    a2.set_ylabel("cents a share")
    a3.set_title("net a day, the venue's FAK (fill what rests, cancel the rest)", fontsize=9.5, loc="left")
    a3.set_ylabel("USD a day")
    a4.set_title("net a day, the venue's FOK (the whole clip or nothing)", fontsize=9.5, loc="left")
    a1.legend(loc="lower left", fontsize=8, frameon=False)
    tb = fs.put_table(axt, rows, ["Rule", "Notional (clip)", "Full", "Fill share", "No fill", "Cents over best", "FAK net an entry", "FAK net a day", "FOK net a day"], size=7.8)
    _colw(tb, [0.17, 0.13, 0.07, 0.09, 0.08, 0.11, 0.12, 0.11, 0.12])
    for i, r in enumerate(rows, 1):
        fs.tint(tb, i, 2, "green" if float(r[2].rstrip("%")) >= 90 else "rose")
    return fig


def burst_masks(tab, cfg, feed=False):
    """The masks `tf15_oos.random_burst` reads for a stale cell, under the label "A" (whose pool is `nup_up`, `nup_dn` as given): every condition of the cell
    except the burst (the discount to fair value, the ask band, the stale definition over n seconds), and the time mask. The null buys at the ask seen, so for a
    cell whose limit is our edge price it fills a little less than the cell would."""
    nu, nd = C._stale_mask(tab, ("nup", cfg["theta"]))
    bu, bd = C._stale_mask(tab, ("band", cfg["band"]))
    su, sd = C.stale_masks(tab, cfg["kind"], cfg["n"])
    fl = C._stale_feed(tab) if feed else True                              # `feed`: the cell's feed mask, so the null draws live books only
    return dict(nup_up=nu & bu & su & fl, nup_dn=nd & bd & sd & fl, tm=C.tmask(tab, cfg["t_min"]))


def record_burst(tab, wf, draws=1000, seed=41, usd=B.CLIP_USD, feed=False):
    """The random-burst null of the walk-forward record: for each fold, the same count of entries per (day, coin) as its chosen cell made on its week, drawn
    from that week's seconds that pass every condition of the cell but the burst (`tf15_oos.random_burst` on the week's windows); each draw pools the folds
    (the total net over the total entries). -> dict(per (draws,), n (draws,), folds: list of random_burst dicts)."""
    import tf15_oos as O
    tot, n, parts = np.zeros(draws), np.zeros(draws), []
    for i, f in enumerate(wf["folds"]):
        e = f["applied"]
        if not len(e["net"]):
            continue
        ts = tab.subset(np.isin(tab.day, f["out_idx"]))
        cfg = f["chosen"]["cfg"]
        rb = O.random_burst(ts, e, burst_masks(ts, cfg, feed), "A", t_min=cfg["t_min"], usd=usd, draws=draws, seed=seed + i)
        ok = np.isfinite(rb["per"])
        tot += np.where(ok, rb["per"], 0.0) * rb["n"]
        n += rb["n"]
        parts.append(rb)
    return dict(per=np.where(n > 0, tot / np.maximum(n, 1), np.nan), n=n, folds=parts)


# ============================================================ the self-test: each piece once right, each planted fault caught
def _fake(W=2, NK=12):
    """A small table: an Up ask path per window, sizes, a burst, a fair value, one-level ladders at the quote."""
    t = object.__new__(B.Tab)
    t.W, t.NK = W, NK
    t.T = (B.WIN_S - (B.K0 + np.arange(NK))).astype(float)
    t.qa = np.array([[0.50, 0.50, 0.50, 0.52, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50, 0.50], [0.40] * NK], np.float32)[:W, :NK]
    t.qas = np.array([[10, 10, 10, 10, 10, 12, 12, 12, 12, 12, 12, 12], [30] * NK], np.float32)[:W, :NK]
    t.qb = t.qa - np.float32(0.02)
    t.qbs = t.qas.copy()
    t.pu = np.full((W, NK), 0.60, np.float32)
    t.zl = np.zeros((W, NK, 3), np.float32)
    t.zl[:, :, 0] = 3.5
    lad = np.full((W, 4, NK, 4), np.nan, np.float32)
    lad[:, 0, :, 0], lad[:, 1, :, 0], lad[:, 2, :, 0], lad[:, 3, :, 0] = t.qb, 100.0, t.qa, 100.0
    t.lad = lad
    t.w_fee = np.full(W, 0.07, np.float32)
    t.up = np.array([True, False])[:W]
    t.day = np.array([0, 1])[:W]
    t.slot = np.array([10, 20])[:W]
    t.w_asset = np.zeros(W, np.int8)
    t.w_start = np.array([0, 900_000])[:W]
    return t


def selftest(out=None, quiet=False) -> bool:
    """Each piece once on a fake table, each planted fault caught. `out` (a list) collects (label, passed)."""
    ok = True

    def rec(label, cond):
        nonlocal ok
        if not quiet:
            print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        if out is not None:
            out.append((label, bool(cond)))
        ok &= bool(cond)

    t = _fake()
    ra, _ = C.still_runs(t)
    rec("the run of an unchanged ask resets where the ask moves and counts again after (0,1,2,0,0,1,...)", list(ra[0, :7]) == [0, 1, 2, 0, 0, 1, 2])
    a3, _ = C.stale_masks(t, "a", 3)
    b3, _ = C.stale_masks(t, "b", 3)
    c3, _ = C.stale_masks(t, "c", 3)
    rec("(a) reads the endpoints only: second 6 (0.50 against 0.52 three seconds earlier) fails, second 7 passes", (not a3[0, 6]) and a3[0, 7])
    rec("(b) needs every second unchanged: second 7 has run 3 (4..7), second 6 does not", b3[0, 7] and not b3[0, 6])
    rec("(c) also needs the size unchanged: the size moved at second 5, so second 7 fails and second 8 passes", (not c3[0, 7]) and c3[0, 8])
    rec("planted: (b) is never looser than (a), (c) never looser than (b)", bool(np.all(~b3 | a3)) and bool(np.all(~c3 | b3)))
    zero_u, _ = C.stale_masks(t, "b", 0)
    rec("n = 0 is no condition beyond a quote", bool(zero_u.all()))
    cand = C.BuyNearStale()
    cfg = cand.cell("a", 3, 0.05, 3.0, 10, 0, "any")
    side, trig, lim, _ = cand.triggers(t, cfg, {})
    e0 = B.entries(t, side, trig, lim)
    e1 = entries_delayed(t, side, trig, lim, 0)
    rec("a zero extra delay is the engine itself", len(e0["net"]) == len(e1["net"]) and np.allclose(e0["net"], e1["net"]))
    e2 = entries_delayed(t, side, trig, lim, 2)
    rec("a 2 s delay keeps the decision second in k and fills 2 columns later", len(e2["net"]) > 0 and int(e2["k"][0]) == int(e0["k"][0]))
    rows = [dict(cfg=dict(name="x"), train=dict(n=50, per_ex_top5=-1.0), validate=dict(n=50, per_ex_top5=9.0)),
            dict(cfg=dict(name="y"), train=dict(n=50, per_ex_top5=0.5), validate=dict(n=50, per_ex_top5=1.0)),
            dict(cfg=dict(name="z"), train=dict(n=10, per_ex_top5=5.0), validate=dict(n=50, per_ex_top5=8.0))]
    ch, q = choose(rows)
    rec("planted: the choice skips a cell negative on train (x) and a cell under 30 entries (z)", ch["cfg"]["name"] == "y" and q)
    e = dict(day=np.array([0, 1, 1]), net=np.array([1.0, 2.0, 3.0]))
    rec("by_days keeps only the named days", list(by_days(e, [1])["net"]) == [2.0, 3.0])
    eh = cand.run(t, cfg, {})
    split = sum(len(by_days(eh, [d])["net"]) for d in (0, 1))
    rec("a cell run on the pooled table and split by day keeps every entry once", split == len(eh["net"]))
    # ---- the second-pass tuning
    g = tune_grid()
    rec("the second-pass grid is 9 windows x 3 definitions x 3 discounts x 2 limits = 162 named cells, E's among them",
        len(g) == 162 and len({c["name"] for c in g}) == 162 and "a3|th0.05|ask" in {c["name"] for c in g})
    rec("the net without the best 5% drops ceil(5% of n): 1..20 -> the mean of 1..19", abs(ex5_point(np.arange(1.0, 21.0)) - 10.0) < 1e-12)
    lo_, hi_ = ex5_boot(np.arange(40), np.full(40, 0.7))
    rec("the trimmed slot bootstrap of a constant is that constant", abs(lo_ - 0.7) < 1e-12 and abs(hi_ - 0.7) < 1e-12)
    lv2 = dict(kind=("a", "b"), n=(1, 2, 3, 4, 5), theta=(0.05,), limit=("ask",))
    g2 = tune_grid(lv2)
    sc = {c["name"]: (100, {"a": (0.0, -3.0, 5.0, -3.0, 0.0), "b": (1.0, 1.0, 1.0, 1.0, 1.0)}[c["kind"]][c["n"] - 1]) for c in g2}
    r2 = rank_cells(sc, smooth(sc, g2, lv2), g2)
    rec("planted: a spike (a3 at +5 between -3 and -3) loses to a plateau (b at +1 everywhere); among equal smoothed scores the smaller n wins",
        r2[0]["cfg"]["name"] == "b1|th0.05|ask" and abs(smooth(sc, g2, lv2)["a3|th0.05|ask"] + 1.0 / 3.0) < 1e-12)
    sc2 = dict(sc)
    sc2["b1|th0.05|ask"] = (59, 1.0)
    rec("a cell under 60 entries on the choosing weeks is not chosen", rank_cells(sc2, smooth(sc2, g2, lv2), g2)[0]["cfg"]["name"] == "b2|th0.05|ask")
    gx = [tune_cell("a", 3, 0.05, "ask"), tune_cell("b", 3, 0.05, "ask")]
    nets = {gx[0]["name"]: (1.0, 1.0, -1.0), gx[1]["name"]: (-1.0, -1.0, 5.0)}
    ents = {nm: _fake_entries(np.repeat(np.arange(3), 70), np.repeat(np.array(v), 70)) for nm, v in nets.items()}
    wf = walk_forward(ents, gx, 3, week=1, n_min=60, levels=dict(TUNE_LEVELS, n=(3,)), e_name=gx[0]["name"])
    rec("the walk-forward chooses each week on the weeks before it only: (a) both times, so the record is (a) on days 1 and 2",
        [f["chosen"]["cfg"]["name"] for f in wf["folds"]] == [gx[0]["name"]] * 2 and np.isclose(wf["record"]["net"].sum(), 70 * (1.0 - 1.0)) and len(wf["record"]["net"]) == 140)
    ev, _, _ = e_variant(t, cfg, feed=False)
    rec("E's conditions rebuilt by e_variant (no change) equal BuyNearStale's entries", len(ev["net"]) == len(eh["net"]) and np.allclose(np.sort(ev["net"]), np.sort(eh["net"])))
    ec, _, _ = e_variant(t, cfg, cap=0.45, feed=False)
    rec("planted: a price cap of 0.45 keeps only the window whose ask is 0.40, and every fill is at or under the cap",
        len(ec["net"]) == 1 and int(ec["w"][0]) == 1 and bool(np.all(ec["vwap"] <= 0.45 + 1e-9)))
    pv = np.full((t.W, t.NK), 0.40)
    ep, _, _ = e_variant(t, cfg, pu=pv, feed=False)
    rec("planted: a fair value of 0.40 everywhere leaves no ask more than 5 c under it, so no entry", len(ep["net"]) == 0)
    rec("planted: a choice that also read the applied week would pick (b) on the last fold", choose_plateau(ents, gx, np.arange(3), 60, dict(TUNE_LEVELS, n=(3,)))[0]["cfg"]["name"] == gx[1]["name"])
    return bool(ok)


def _fake_entries(day, net):
    """An entries dict with every key `tf15_bt.summarize` reads, one entry a slot."""
    n = len(net)
    net = np.asarray(net, float)
    won = net > 0
    cost = np.full(n, 10.0)
    return dict(w=np.arange(n), k=np.zeros(n, int), side=np.ones(n, int), shares=np.full(n, 20.0), cost=cost, fee=np.zeros(n), vwap=np.full(n, 0.5),
                best=np.full(n, 0.5), won=won, payoff=cost + net, net=net, gross=net, day=np.asarray(day), slot=np.arange(n), asset=np.zeros(n, int),
                T=np.full(n, 600.0), sold=np.zeros(n))


def checks() -> list[tuple[str, bool]]:
    """The self-test as (label, passed) rows, for the notebook's check tables."""
    out = []
    selftest(out, quiet=True)
    return out


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
