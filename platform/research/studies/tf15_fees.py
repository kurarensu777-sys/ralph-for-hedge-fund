"""The taker fee of a buy-near test, taken apart (um-021, 2026-10-11): the gross edge, the fee and the net an entry with their slot intervals, the fee a share by
price paid against the published curve, the net under a swept fee, and the fee rate the edge could bear. numpy, matplotlib and `figstyle`; every number is
read off the entries `tf15_bt.entries` settled and the market rows' own rate (`Tab.w_fee`).

THE FEE. Polymarket `fee.formula` [1] (the fees page, read 2026-10-10): fee = C x feeRate x p x (1 - p) for C shares at price p, takers only, feeRate the
market's own `feeSchedule.rate` (`fee.schedule.by_market` [API]); the crypto category's published taker rate is 0.07 (`fee.category_rates` [1], read
2026-10-10). The engine charges it level by level as the order walks the ladder, so an entry's fee is the sum over the levels it took.

THE SWEEP. A fee does not change a fill (the walk spends the clip on the price, the fee is paid on top), so the net at fee multiplier m is gross - m x fee on the
same entries; m = 0 is the gross and m = 1 the net as run. The break-even multiplier is the root of the mean net in m (bisection), the break-even rate that
multiplier times the rate the entries paid.

    rates_seen   the rates on the table's windows (min, max, the share at each)
    limits       each entry's limit, the ask the rule saw (`tf15_cands.quotes`)
    refee        each entry's shares and fee recomputed level by level from the ladder; fee_check compares them with the engine's
    decompose    gross, fee and net an entry with 95% slot intervals, cents a share, the fee's share of the gross, the break-even
    sweep        the net an entry at each fee multiplier, with its interval
    by_price     gross, fee and net a share in cents on the price buckets of `tf15_trade_figs`
    fee_fig, fee_notes   the figure and its findings
"""
from __future__ import annotations

import numpy as np
from matplotlib.lines import Line2D
from matplotlib.patches import Patch

import tf15_bt as B
import tf15_cands as C
import tf15_oos_figs as OF
import tf15_trade_figs as TF
from fundplat.quant.core import figstyle as fs

MULTS = (0.0, 0.5, 1.0, 1.5, 2.0, 3.0)
CARD_CRYPTO_TAKER = 0.07                       # polymarket fee.category_rates, the Crypto row's taker rate [1], read 2026-10-10 (the fees page table)
SRC_FORMULA = "Polymarket fee.formula [1], read 2026-10-10"
SRC_CATEGORY = "fee.category_rates [1], read 2026-10-10"
SRC_LIVE = "each market's own feeSchedule.rate, fee.schedule.by_market [API]"

N = OF.N
INK, MUTED = N["ink"], N["muted"]
GOOD, BAD = OF.GOOD, OF.BAD
FEE = fs.QUANTITY["fees"]


# ============================================================ the numbers
def fee_curve(p, rate):
    """The published fee a share at price p: rate x p x (1 - p)."""
    p = np.asarray(p, float)
    return rate * p * (1.0 - p)


def rates_seen(tab):
    """The fee rates on the table's windows. -> dict(rates, counts, share, n, lo, hi, mode)."""
    r = np.round(np.asarray(tab.w_fee, float), 6)
    u, c = np.unique(r, return_counts=True)
    return dict(rates=u, counts=c, share=c / c.sum(), n=int(c.sum()), lo=float(u.min()), hi=float(u.max()), mode=float(u[np.argmax(c)]))


def rates_text(rs):
    """'0.07 on 100.0% of 12,345 windows (min 0.07, max 0.07)'."""
    each = ", ".join(f"{r:g} on {s:.1%}" for r, s in zip(rs["rates"], rs["share"]))
    return f"{each} of {rs['n']:,} windows (min {rs['lo']:g}, max {rs['hi']:g})"


def entry_rate(tab, e):
    """The rate each entry paid, and the one number to quote: the rate if every entry paid the same, else the fee-weighted mean."""
    r = np.asarray(tab.w_fee, float)[np.asarray(e["w"])]
    if len(r) == 0:
        return r, float("nan")
    one = float(r[0]) if np.allclose(r, r[0]) else float(np.sum(r * e["fee"]) / max(np.sum(e["fee"]), 1e-12))
    return r, one


def limits(tab, e):
    """Each entry's limit: the near token's ask the rule saw at the decision second (the limit `near_tests` gave the engine)."""
    qa, qd = C.quotes(tab)
    w, k = np.asarray(e["w"]), np.asarray(e["k"])
    return np.where(np.asarray(e["side"]) > 0, qa[w, k], qd[w, k])


def refee(tab, e, limit, usd=B.CLIP_USD):
    """Each entry's shares and fee recomputed from its ladder, one level at a time: the shares `B.buy_levels` takes at each level, the fee
    rate x take x p x (1 - p) summed over the levels. -> (shares, fee)."""
    n = len(e["w"])
    px, sz = B.ladder_of(tab, np.asarray(e["w"]), np.asarray(e["k"]), np.asarray(e["side"]), buy=True)
    rate = np.asarray(tab.w_fee, float)[np.asarray(e["w"])]
    shares, fee = np.zeros(n), np.zeros(n)
    for i in range(n):
        take = B.buy_levels(px[i], sz[i], usd, limit[i])
        p = np.where(take > 0, np.asarray(px[i], float), 0.0)
        shares[i] = take.sum()
        fee[i] = rate[i] * float(np.sum(take * p * (1.0 - p)))
    return shares, fee


def fee_check(tab, e, limit, usd=B.CLIP_USD):
    """The engine's shares and fee against `refee`. -> (agree, largest fee difference USD, entries)."""
    if len(e["w"]) == 0:
        return True, 0.0, 0
    sh, fe = refee(tab, e, limit, usd)
    err = float(np.max(np.abs(fe - np.asarray(e["fee"], float))))
    ok = bool(np.allclose(sh, e["shares"], atol=1e-9) and np.allclose(fe, e["fee"], rtol=1e-6, atol=1e-7))
    return ok, err, len(sh)


def break_even(gross, fee):
    """The fee multiplier m where the mean of gross - m x fee crosses zero, by bisection. 0 when the gross is at or below zero (no fee is bearable),
    inf when there is no fee."""
    g, f = np.asarray(gross, float), np.asarray(fee, float)
    net_at = lambda m: float(np.mean(g - m * f))      # noqa: E731
    if len(g) == 0 or net_at(0.0) <= 0:
        return 0.0
    if float(np.mean(f)) <= 0:
        return float("inf")
    lo, hi = 0.0, 1.0
    while net_at(hi) > 0:
        lo, hi = hi, hi * 2.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if net_at(mid) > 0 else (lo, mid)
    return 0.5 * (lo + hi)


def _sweep(base, fee, slot, mults):
    out = []
    for m in mults:
        v = np.asarray(base, float) - m * np.asarray(fee, float)
        lo, hi = B.slot_boot(slot, v)
        out.append(dict(m=float(m), per=float(v.mean()) if len(v) else float("nan"), lo=lo, hi=hi))
    return out


def sweep(e, mults=MULTS):
    """The net an entry at each fee multiplier (gross - m x fee, the same entries), with its 95% slot interval. -> list of dict(m, per, lo, hi)."""
    return _sweep(e["gross"], e["fee"], e["slot"], mults)


def sweep_faults(sw, e):
    """What a sweep gets wrong: m = 0 must be the gross an entry and m = 1 the net as run. -> list of faults (empty when right)."""
    by = {r["m"]: r["per"] for r in sw}
    bad = []
    if 0.0 in by and not np.isclose(by[0.0], float(np.mean(e["gross"]))):
        bad.append(f"multiplier 0 gives {by[0.0]:+.4f}, not the gross {float(np.mean(e['gross'])):+.4f}")
    if 1.0 in by and not np.isclose(by[1.0], float(np.mean(e["net"]))):
        bad.append(f"multiplier 1 gives {by[1.0]:+.4f}, not the net {float(np.mean(e['net'])):+.4f}")
    return bad


def decompose(tab, e):
    """Gross, fee and net an entry (mean, 95% slot interval), each in cents a share, the fee and the net as shares of the gross, the rate and the break-even."""
    g, f, n_, sl, sh = (np.asarray(e[k], float) for k in ("gross", "fee", "net", "slot", "shares"))
    _, rate = entry_rate(tab, e)
    out = dict(n=len(g), rate=rate)
    for key, v in (("gross", g), ("fee", f), ("net", n_)):
        lo, hi = B.slot_boot(sl, v)
        out[key] = float(v.mean()) if len(v) else float("nan")
        out[key + "_lo"], out[key + "_hi"] = lo, hi
        out[key + "_c"] = float(v.sum() / max(sh.sum(), 1e-12) * 100.0)
    gp = out["gross"]
    out["fee_share"] = out["fee"] / gp if gp > 0 else float("nan")
    out["net_share"] = out["net"] / gp if gp > 0 else float("nan")
    out["be_mult"] = break_even(g, f)
    out["be_rate"] = out["be_mult"] * rate
    return out


def by_price(e):
    """On the price buckets of `tf15_trade_figs`: n, the mean price paid, gross, fee and net a share in cents (mean and 95% slot interval of each entry's own
    a-share value). -> list of dict."""
    vw, sh, sl = (np.asarray(e[k], float) for k in ("vwap", "shares", "slot"))
    idx = np.clip(np.searchsorted(TF.PRICE_EDGES, vw, side="right") - 1, 0, len(TF.PRICE_LABELS) - 1)
    out = []
    for b, lab in enumerate(TF.PRICE_LABELS):
        m = idx == b
        row = dict(bucket=lab, n=int(m.sum()), p=float(vw[m].mean()) if m.any() else float("nan"))
        for key in ("gross", "fee", "net"):
            v = np.asarray(e[key], float)[m] / sh[m] * 100.0
            lo, hi = B.slot_boot(sl[m], v) if m.any() else (np.nan, np.nan)
            row[key], row[key + "_lo"], row[key + "_hi"] = (float(v.mean()) if m.any() else float("nan")), lo, hi
        out.append(row)
    return out


# ============================================================ the figure
def _sign(v):
    return GOOD if v > 0 else BAD


def _m_txt(m):
    return "none" if m <= 0 else ("no fee charged" if not np.isfinite(m) else f"{m:.2f}x")


def fee_notes(lab, d, sw, rs, px):
    """The findings: the formula with its rate and source, the fee an entry and a share, its share of the gross, the break-even and gate 2's cost cell,
    where the fee bites by price, and whether the fee or the price is what the test loses to."""
    r = d["rate"]
    peak, at85 = fee_curve(0.5, r) * 100, fee_curve(0.85, r) * 100
    by = {x["m"]: x for x in sw}
    two = by.get(2.0)
    out = [f"The fee is shares x rate x p x (1 - p) on every taker fill, the rate the market's own ({SRC_FORMULA}; the crypto category's published taker rate "
           f"{CARD_CRYPTO_TAKER:g}, {SRC_CATEGORY}). The engine charged {rates_text(rs)}; test {lab}'s entries paid {r:g}. At {r:g} the fee peaks at "
           f"{peak:.2f} cents a share at p = 0.50 and is {at85:.2f} c at p = 0.85.",
           f"The fee costs {d['fee']:.3f} USD an entry (95% by slot {d['fee_lo']:.3f} to {d['fee_hi']:.3f}), {d['fee_c']:.2f} cents a share over {d['n']:,} entries."]
    if d["gross"] > 0:
        out.append(f"Before the fee test {lab} makes {d['gross']:+.3f} an entry (95% {d['gross_lo']:+.2f} to {d['gross_hi']:+.2f}); the fee takes {d['fee_share']:.0%} of it "
                   f"and leaves {d['net']:+.3f} (95% {d['net_lo']:+.2f} to {d['net_hi']:+.2f}).")
        out.append(f"The mean net crosses zero at {d['be_mult']:.2f}x today's rate, a rate of {d['be_rate']:.3f}"
                   + (f"; at twice the rate ({2 * r:.2f}) the net is {two['per']:+.3f} an entry (95% {two['lo']:+.2f} to {two['hi']:+.2f}), "
                      + ("so no cost cell up to 2x flips the sign (gate 2's cost sweep)." if two["per"] > 0 else "so the sign flips inside the sweep (gate 2's cost sweep fails).") if two else "."))
    else:
        out.append(f"Before the fee test {lab} already makes {d['gross']:+.3f} an entry (95% {d['gross_lo']:+.2f} to {d['gross_hi']:+.2f}), so no fee is bearable; the fee "
                   f"adds {d['fee']:.3f} to the loss and the net is {d['net']:+.3f}.")
    full = [x for x in px if x["n"] >= 20]
    if full:
        top = max(full, key=lambda x: x["fee"])
        out.append(f"The fee bites hardest in the {top['bucket']} bucket ({top['n']:,} entries, {top['fee']:.2f} c a share): gross {top['gross']:+.2f} c, net {top['net']:+.2f} c a share"
                   + (", so the edge there survives the fee." if top["net"] > 0 else ", so the fee eats the edge there." if top["gross"] > 0 else ", already below zero before the fee."))
    if d["gross"] <= 0:
        out.append(f"Test {lab} loses to the price, not the fee: it is below zero before any fee is charged.")
    elif d["net"] <= 0:
        out.append(f"Test {lab} loses to the fee: it is above zero before the fee ({d['gross']:+.3f}) and below after it ({d['net']:+.3f}); a rate under {d['be_rate']:.3f} would keep it.")
    else:
        out.append(f"Test {lab} keeps {d['net_share']:.0%} of its gross after the fee; the fee is a cost it bears, not what decides it.")
    return out


def fee_fig(d, sw, px, notes, question, window):
    """Left: the bridge an entry, gross minus the fee equals the net, each with its 95% slot interval (gross and net green or red by sign, the fee grey).
    Middle: gross and net a share in cents by price paid (points with intervals) against the published fee curve rate x p(1 - p), solid grey.
    Right: the net an entry at each fee multiplier with its interval, today's rate an ink dashed vertical, the break-even an ink dotted vertical.
    Zero is the ink dotted decision line on every panel. Under them one table: gross, fee and net an entry."""
    r = d["rate"]
    verdict = "PASS" if d["net"] > 0 else "FAIL"
    pct = lambda v: "n/a" if not np.isfinite(v) else f"{v * 100:.0f}"      # noqa: E731
    be = f"{d['be_rate']:.3f} ({_m_txt(d['be_mult'])})" if d["be_mult"] > 0 and np.isfinite(d["be_mult"]) else _m_txt(d["be_mult"])
    rows = [["Gross an entry (payoff - cost)", f"{d['gross']:+.3f}", f"{d['gross_lo']:+.3f}", f"{d['gross_hi']:+.3f}", f"{d['gross_c']:+.2f}", "100" if d["gross"] > 0 else "n/a", "-", "-"],
            [f"Taker fee an entry (rate {r:g})", f"{-d['fee']:+.3f}", f"{-d['fee_hi']:+.3f}", f"{-d['fee_lo']:+.3f}", f"{-d['fee_c']:+.2f}", pct(d["fee_share"]), "-", "-"],
            ["Net an entry (after the fee)", f"{d['net']:+.3f}", f"{d['net_lo']:+.3f}", f"{d['net_hi']:+.3f}", f"{d['net_c']:+.2f}", pct(d["net_share"]), be, verdict]]
    cols = ["Statistic", "Mean USD", "95% lo", "95% hi", "Cents a share", "Share of gross %", "Break-even fee rate", "Net above zero"]
    fig, (a1, a2, a3), axt = OF._canvas(notes, question, window, 3.4, len(rows), ncols=3, widths=(0.85, 1.25, 1.1), legend_below=1.45, wspace=0.30)
    zero_h = Line2D([], [], color=INK, ls=":", lw=1.3, label="zero net")
    # ---- left: the bridge
    g, f, n_ = d["gross"], d["fee"], d["net"]
    a1.bar(0, g, width=0.6, color=_sign(g), zorder=3)
    a1.bar(1, -f, bottom=g, width=0.6, color=FEE, zorder=3)
    a1.bar(2, n_, width=0.6, color=_sign(n_), zorder=3)
    ek = dict(fmt="none", color=N["ink2"], ecolor=N["ink2"], elinewidth=1.3, capsize=5, zorder=4)
    a1.errorbar([0], [g], yerr=[[g - d["gross_lo"]], [d["gross_hi"] - g]], **ek)
    a1.errorbar([1], [g - f], yerr=[[d["fee_hi"] - f], [f - d["fee_lo"]]], **ek)
    a1.errorbar([2], [n_], yerr=[[n_ - d["net_lo"]], [d["net_hi"] - n_]], **ek)
    a1.plot([0.3, 0.7], [g, g], color=N["axis"], lw=1.0, zorder=2)
    a1.plot([1.3, 1.7], [g - f, g - f], color=N["axis"], lw=1.0, zorder=2)
    a1.axhline(0, color=INK, ls=":", lw=1.3, zorder=5)
    lo_y = min(0.0, d["gross_lo"], d["net_lo"], g - d["fee_hi"])
    hi_y = max(0.0, d["gross_hi"], d["net_hi"], g)
    pad = (hi_y - lo_y) * 0.14 or 0.1
    a1.set_ylim(lo_y - pad, hi_y + pad)
    for x, v, top, bot in ((0, g, max(g, d["gross_hi"]), min(g, d["gross_lo"])), (1, -f, g, None), (2, n_, max(n_, d["net_hi"]), min(n_, d["net_lo"]))):
        if v < 0 and bot is not None:          # a bar below zero carries its number under its interval
            a1.text(x, bot - pad * 0.15, f"{v:+.3f}", ha="center", va="top", fontsize=8.5, color=INK, weight="bold")
        else:
            a1.text(x, top + pad * 0.15, f"{v:+.3f}", ha="center", va="bottom", fontsize=8.5, color=INK, weight="bold")
    a1.set_xticks([0, 1, 2])
    a1.set_xticklabels(["gross", "taker fee", "net"], fontsize=8.5)
    a1.set_xlim(-0.55, 2.55)
    a1.set_ylabel("USD an entry")
    a1.set_title("an entry: gross - fee = net (95% by slot)", fontsize=9.5, loc="left")
    a1.legend(handles=[Patch(facecolor=GOOD, label="above zero"), Patch(facecolor=BAD, label="below zero"), Patch(facecolor=FEE, label="the taker fee"), zero_h],
              loc="upper center", bbox_to_anchor=(0.5, -0.12), ncol=2, fontsize=8, frameon=False)
    # ---- middle: a share, by price paid
    p = np.linspace(0.01, 0.99, 197)
    a2.plot(p, fee_curve(p, r) * 100, color=FEE, lw=2.4, zorder=3)
    for edge in TF.PRICE_EDGES[1:-1]:
        a2.axvline(edge, color=N["grid"], lw=1.0, zorder=1)
    ys = [0.0, float(fee_curve(0.5, r) * 100)]
    for b in px:
        if not b["n"]:
            continue
        a2.errorbar([b["p"] - 0.008], [b["gross"]], yerr=[[b["gross"] - b["gross_lo"]], [b["gross_hi"] - b["gross"]]], fmt="o", ms=6.5, mfc=N["surface"], mec=INK,
                    color=INK, ecolor=INK, elinewidth=1.2, capsize=3, zorder=4)
        col = _sign(b["net"])
        a2.errorbar([b["p"] + 0.008], [b["net"]], yerr=[[b["net"] - b["net_lo"]], [b["net_hi"] - b["net"]]], fmt="o", ms=6.5, color=col, mec=INK, mew=0.6, ecolor=col,
                    elinewidth=1.2, capsize=3, zorder=5)
        ys += [b["gross_lo"], b["gross_hi"], b["net_lo"], b["net_hi"]]
        a2.text(b["p"], 0.02, f"n={b['n']:,}", transform=a2.get_xaxis_transform(), ha="center", va="bottom", fontsize=7.5, color=N["ink2"])
    ys = np.asarray(ys, float)
    ys = ys[np.isfinite(ys)]
    lo2, hi2 = float(ys.min()), float(ys.max())
    pad2 = (hi2 - lo2) * 0.10 or 0.5
    a2.set_ylim(lo2 - pad2 * 1.8, hi2 + pad2)
    a2.axhline(0, color=INK, ls=":", lw=1.3, zorder=2)
    a2.set_xlim(0.0, 1.0)
    a2.set_xlabel("price paid a share (bucket edges in grey)")
    a2.set_ylabel("cents a share")
    a2.set_title("a share, by price paid (95% by slot)", fontsize=9.5, loc="left")
    a2.legend(handles=[Line2D([], [], color=INK, marker="o", mfc=N["surface"], ls="", label="gross a share"),
                       Line2D([], [], color=GOOD, marker="o", mec=INK, ls="", label="net a share, above zero"),
                       Line2D([], [], color=BAD, marker="o", mec=INK, ls="", label="net a share, below zero"),
                       Line2D([], [], color=FEE, lw=2.4, label=f"the fee a share, {r:g} x p x (1 - p)"), zero_h],
              loc="upper center", bbox_to_anchor=(0.5, -0.17), ncol=2, fontsize=8, frameon=False)
    # ---- right: the cost sweep
    m = np.array([x["m"] for x in sw])
    y = np.array([x["per"] for x in sw])
    lo3, hi3 = np.array([x["lo"] for x in sw]), np.array([x["hi"] for x in sw])
    a3.errorbar(m, y, yerr=[y - lo3, hi3 - y], fmt="none", color=N["ink2"], ecolor=N["ink2"], elinewidth=1.2, capsize=4, zorder=3)
    a3.plot(m, y, color=INK, lw=2.0, zorder=4)
    a3.scatter(m, y, s=46, c=[_sign(v) for v in y], edgecolors=INK, linewidths=0.6, zorder=5)
    a3.axhline(0, color=INK, ls=":", lw=1.3, zorder=2)
    x_hi = max(float(m.max()) + 0.25, 0.0)
    M = d["be_mult"]
    if 0 < M < np.inf and M <= 6:
        x_hi = max(x_hi, M + 0.35)
    a3.set_xlim(-0.2, x_hi)
    y0, y1 = a3.get_ylim()
    a3.set_ylim(min(y0, -0.22 * (y1 - y0)), y1)          # room under zero for the labels at the foot when every point is above it
    a3.axvline(1.0, color=INK, ls="--", lw=1.2, zorder=3)
    a3.text(1.0, 0.98, f" today's rate {r:g}", transform=a3.get_xaxis_transform(), ha="left", va="top", fontsize=8, color=INK)
    # the net falls as the fee grows, so the corner below zero and left of the break-even is empty: the labels sit at the foot of the axes
    if 0 < M <= 6:
        a3.axvline(M, color=INK, ls=":", lw=1.4, zorder=3)
        left_room = M - (-0.2) > 1.4
        a3.text(M, 0.04, f"bears {M:.2f}x, \na rate of {d['be_rate']:.3f} " if left_room else f" bears {M:.2f}x,\n a rate of {d['be_rate']:.3f}",
                transform=a3.get_xaxis_transform(), ha="right" if left_room else "left", va="bottom", fontsize=8, color=INK)
    elif M > 6:
        a3.text(0.98, 0.04, f"bears {M:.1f}x (a rate of {d['be_rate']:.3f}), off the axis", transform=a3.transAxes, ha="right", va="bottom", fontsize=8, color=INK)
    else:
        a3.text(0.02, 0.04, "below zero before any fee: bears none", transform=a3.transAxes, ha="left", va="bottom", fontsize=8, color=INK)
    a3.set_xticks(list(m))
    a3.set_xticklabels([f"{v:g}x" + (f"\n{v * r:.3f}" if float(v).is_integer() else "\n") for v in m], fontsize=8)
    a3.set_xlabel("fee multiplier, and the rate it means")
    a3.set_ylabel("net USD an entry")
    a3.set_title("net an entry as the fee grows (95% by slot)", fontsize=9.5, loc="left")
    a3.legend(handles=[Line2D([], [], color=INK, lw=2.0, marker="o", label="net an entry"), Line2D([], [], color=INK, ls="--", lw=1.2, label="today's rate"),
                       Line2D([], [], color=INK, ls=":", lw=1.4, label="break-even"), zero_h],
              loc="upper center", bbox_to_anchor=(0.5, -0.25), ncol=2, fontsize=8, frameon=False)
    tb = fs.put_table(axt, rows, cols, size=9)
    OF._colw(tb, [0.21, 0.09, 0.09, 0.09, 0.10, 0.12, 0.17, 0.13])
    fs.gold(tb, 2, 1)
    fs.tint(tb, 3, len(cols) - 1, "green" if verdict == "PASS" else "rose")
    return fig


# ============================================================ the self-test: each rule once right, each planted fault caught
def checks():
    """(label, passed) for the module's rules and its planted faults; a planted fault passes when it is CAUGHT."""
    out = []
    t = B._fake_tab(1)                           # one window: Up asks 0.80 x 10 and 0.81 x 100, rate 0.07, Up won
    e = B.entries(t, np.array([[1]]), np.array([[True]]), np.array([[0.81]], np.float32), usd=20.0)
    want = 0.07 * (10 * 0.80 * 0.20 + 14.81 * 0.81 * 0.19)
    lim = np.array([0.81], np.float32)
    ok, err, n = fee_check(t, e, lim, 20.0)
    out.append(("a 20 USD buy of 10 at 0.80 and 14.81 at 0.81 pays 0.07 x (10 x 0.80 x 0.20 + 14.81 x 0.81 x 0.19), and refee agrees",
                ok and n == 1 and abs(e["fee"][0] - want) < 1e-9))
    bad1 = dict(e, fee=0.07 * e["vwap"] * e["shares"])
    out.append(("planted: a fee of rate x p x shares (no 1 - p) is caught", not fee_check(t, bad1, lim, 20.0)[0]))
    bad2 = dict(e, fee=2 * e["fee"])
    out.append(("planted: a fee at twice the market's rate is caught", not fee_check(t, bad2, lim, 20.0)[0]))
    bad3 = dict(e, fee=0.07 * e["vwap"] * (1 - e["vwap"]) * e["shares"])
    out.append(("planted: the fee at the average price instead of level by level is caught", not fee_check(t, bad3, lim, 20.0)[0]))
    s = dict(gross=np.array([1.0, -0.5, 0.8, 0.3]), fee=np.array([0.2, 0.1, 0.3, 0.2]), slot=np.array([1, 2, 3, 4]))
    s["net"] = s["gross"] - s["fee"]
    sw = sweep(s)
    out.append(("the sweep at 0x is the gross and at 1x the net", not sweep_faults(sw, s)))
    out.append(("planted: a sweep built on the net (0x is not the gross) is caught", bool(sweep_faults(_sweep(s["net"], s["fee"], s["slot"], MULTS), s))))
    M = break_even(s["gross"], s["fee"])
    out.append(("the break-even multiplier is the root of the mean net (mean gross / mean fee)", abs(M - s["gross"].mean() / s["fee"].mean()) < 1e-9))
    out.append(("planted: a gross at or below zero bears no fee (break-even 0)", break_even(np.array([-0.1, 0.05]), np.array([0.1, 0.1])) == 0.0))
    out.append(("the fee curve peaks at rate / 4 at p = 0.50", abs(float(fee_curve(0.5, 0.07)) - 0.0175) < 1e-12 and float(fee_curve(0.85, 0.07)) < 0.0175))
    return out


def selftest() -> bool:
    ok = True
    for label, cond in checks():
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        ok &= bool(cond)
    return bool(ok)


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
