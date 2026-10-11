"""The reads of the directional momentum study (B-0660) that a notebook shows: tables over the sweeps and the chosen pair's entries, the L2 gallery. numpy, pandas and the engine only.

    cells_frame, surface_frame   the stage tables (one row per cell) and the lookback x z surface of a role
    entries_frame                every entry of a cell as one row (what the L2 views and the appendix print)
    delay_table, cost_table      the chosen pair re-run at other fill delays, at twice the fee, a cent worse, other clips
    block                        the frozen pair on days outside the registered split
    subset, by_period            entries of one table cut to the days of a period (the slot intervals still come from the whole table)
    ladder_frame                 win share against break-even by lookback at one z, hold to expiry, per period and over every day (B-0679)
    by_group                     entries cut by coin or by time left
    gallery_html                 every entry of a cell on its L2 ladder as one self-contained HTML page (inline SVG, no script needed)
"""
from __future__ import annotations

import html
from pathlib import Path

import numpy as np
import pandas as pd

import mom15_bt as M
import tf15_report as RP

ASSET = RP.ASSET


def cells_frame(sweep):
    out = []
    for r in sweep["rows"]:
        f, v = r["fit"], r["validate"]
        out.append({"cell": r["key"], "fit n": f.get("n", 0), "fit per": f.get("per", np.nan), "valid n": v.get("n", 0), "valid per": v.get("per", np.nan), "valid lo": v.get("per_lo", np.nan),
                    "valid hi": v.get("per_hi", np.nan), "valid win %": v.get("win", np.nan) * 100, "valid be %": v.get("breakeven", np.nan) * 100, "valid early %": v.get("early_share", np.nan) * 100})
    return pd.DataFrame(out)


def surface_frame(rows, role):
    """DataFrame (lookback x z) of the `role` net per entry of the single-lookback hold cells in `rows`."""
    g = pd.DataFrame(np.nan, index=pd.Index(M.LS, name="lookback L, s"), columns=pd.Index(M.ZS, name="z threshold"))
    for r in rows:
        s = r["sig"]
        if s.Ll is None and s.lead == 0:
            g.loc[s.L, s.z] = r[role].get("per", np.nan) if r[role].get("n", 0) else np.nan
    return g


def entries_frame(e, tab):
    d = RP.frame(e, tab)
    d["exit_s"] = np.where(e["ke"] >= 0, e["ke"] + M.K0, -1)
    d["exit_px"] = e["exit_px"]
    d["sold"] = e["sold"]
    d["entry_s"] = e["k"] + M.K0
    return d


def delay_table(sig, ex, days, delays=(0, 50, 150, 250, 500)):
    rows = []
    for d in delays:
        tab = M.MTab(days, fill_ms=d)
        e = M.run(tab, sig, ex)
        s = M.summarize(e, tab, f"{d} ms")
        rows.append(dict(delay_ms=d, n=s.get("n", 0), win=s.get("win", np.nan), per=s.get("per", np.nan), lo=s.get("per_lo", np.nan), hi=s.get("per_hi", np.nan), net=s.get("net", 0.0)))
    return pd.DataFrame(rows)


def cost_table(tab, sig, ex):
    rows = []
    for label, kw in (("as registered", {}), ("fee x2", dict(fee_mult=2.0)), ("a cent worse on every fill", dict(slack=0.01)), ("clip USD 5", dict(usd=5.0)), ("clip USD 100", dict(usd=100.0))):
        e = M.run(tab, sig, ex, **kw)
        s = M.summarize(e, tab, label)
        rows.append(dict(case=label, n=s.get("n", 0), win=s.get("win", np.nan), per=s.get("per", np.nan), lo=s.get("per_lo", np.nan), hi=s.get("per_hi", np.nan), net=s.get("net", 0.0)))
    return pd.DataFrame(rows)


def block(days, sig, ex, label, fill_ms=250):
    """-> (tab, entries, summary) of the pair on `days`."""
    tab = M.MTab(days, fill_ms=fill_ms)
    e = M.run(tab, sig, ex)
    return tab, e, M.summarize(e, tab, label)


def subset(e, tab, days):
    """The entries of `e` (a run on `tab`) whose window is on one of `days`."""
    di = [tab.days.index(d) for d in days]
    m = np.isin(tab.day[e["w"]], di)
    return {k: (v[m] if isinstance(v, np.ndarray) and v.shape[:1] == m.shape else v) for k, v in e.items()}


def by_period(e, tab, periods, label=""):
    """periods: [(name, days)] -> {name: summary} of the entries `e` cut to each period's days (`M.summarize` with the whole table's slots)."""
    return {nm: M.summarize(subset(e, tab, ds), tab, f"{label} {nm}".strip()) for nm, ds in periods}


def ladder_frame(tab, periods, z=2.0, ex=None):
    """One row per (lookback, period) of the single-lookback signal at threshold `z`, held to expiry: entries, win share with its Wilson interval, the share needed to break even
    (the entry-weighted mean of price plus fee a share, the like-for-like of the win share; `be_share` is the share-weighted one), the gap in points, the net per entry with its 95% slot interval. The last period is every day of `tab`."""
    ex = ex or M.Exit("expiry")
    allp = periods + [("all days", tuple(tab.days))]
    rows = []
    for L in M.LS:
        e = M.run(tab, M.Signal(L, z), ex)
        for nm, ds in allp:
            s = M.summarize(subset(e, tab, ds), tab)
            n = s.get("n", 0)
            rows.append(dict(L=L, period=nm, n=n, win=s.get("win", np.nan), lo=s.get("win_lo", np.nan), hi=s.get("win_hi", np.nan), be=s.get("breakeven_entry", np.nan), be_share=s.get("breakeven", np.nan),
                             gap=(s["win"] - s["breakeven_entry"]) * 100 if n else np.nan, per=s.get("per", np.nan), per_lo=s.get("per_lo", np.nan), per_hi=s.get("per_hi", np.nan)))
    return pd.DataFrame(rows)


def band_frame(e, tab, edges=(0, 0.05, 0.10, 0.25, 0.5, 0.75, 0.9, 0.95, 1.0001)):
    """`tf15_report.by_band` plus `breakeven`: the share of entries that must win for the band to break even, (cost + fee) over shares."""
    out = RP.by_band(e, tab, edges)
    df = RP.frame(e, tab)
    df["band"] = pd.cut(df["vwap"], list(edges), right=False)
    g = df.groupby("band", observed=True)
    out["breakeven"] = (g["cost"].sum() + g["fee"].sum()) / g["shares"].sum()
    return out


def by_group(e, tab, how):
    if how == "coin":
        return RP.by_asset(e, tab)
    return RP.by_left(e, tab)


# ============================================================ the gallery
def _svg(rec, e, i, tab, w=300, h=150):
    """One entry as a small SVG: asks above the line (the shares taken in the dark, the depth in the pale), bids below, a triangle (upright a buy of Up, inverted a buy of Down) the average price paid, a square the average price received."""
    shares, net = float(e["shares"][i]), float(e["net"][i])
    cap = 2.2 * shares
    px = [p for p in list(rec["ask_px"]) + (list(rec["bid_px"]) if rec["bid_px"] is not None else []) if np.isfinite(p)]
    ent = float(e["cost"][i]) / shares
    lo, hi = min(px + [ent]) - 0.015, max(px + [ent]) + 0.015
    x = lambda p: 6 + (p - lo) / (hi - lo) * (w - 12)                                    # noqa: E731
    mid = h * 0.56
    sc = (mid - 26) / cap
    parts = [f'<line x1="0" y1="{mid}" x2="{w}" y2="{mid}" stroke="#c3c2b7"/>']
    bw = max(3.0, (w - 12) / (hi - lo) * 0.006)

    def bars(pxs, szs, take, sign):
        for p, s, t in zip(pxs, szs, take):
            if not (np.isfinite(p) and np.isfinite(s) and s > 0):
                continue
            hh = min(float(s), cap) * sc
            y = mid - hh if sign > 0 else mid
            parts.append(f'<rect x="{x(p) - bw / 2:.1f}" y="{y:.1f}" width="{bw:.1f}" height="{hh:.1f}" fill="#35c4d0" fill-opacity="0.28"/>')
            if t > 0:
                ht = min(float(t), cap) * sc
                y = mid - ht if sign > 0 else mid
                parts.append(f'<rect x="{x(p) - bw / 2:.1f}" y="{y:.1f}" width="{bw:.1f}" height="{ht:.1f}" fill="#35c4d0"/>')

    bars(rec["ask_px"], rec["ask_sz"], rec["ask_take"], +1)
    if int(e["side"][i]) > 0:                                                            # the triangle points the way the entry bets: upright a buy of Up, inverted a buy of Down
        parts.append(f'<path d="M{x(ent):.1f},{mid - 1} l-4,8 l8,0 z" fill="#0b0b0b"/>')
    else:
        parts.append(f'<path d="M{x(ent):.1f},{mid + 7} l-4,-8 l8,0 z" fill="#0b0b0b"/>')
    if rec["bid_px"] is not None:
        bars(rec["bid_px"], rec["bid_sz"], rec["bid_take"], -1)
        if np.isfinite(e["exit_px"][i]):
            parts.append(f'<rect x="{x(float(e["exit_px"][i])) - 3.5:.1f}" y="{mid - 3.5}" width="7" height="7" fill="#0b0b0b"/>')
        how = f"sold {e['sold'][i]:.0f} at {e['exit_px'][i]:.3f}" if np.isfinite(e["exit_px"][i]) else "no bid, held"
    else:
        how = "held, pays " + ("1" if e["won"][i] else "0")
    col = "#0ca30c" if net >= 0 else "#d03b3b"
    head = f"{ASSET[int(e['asset'][i])]} {tab.days[int(e['day'][i])][5:]} t+{int(e['k'][i]) + M.K0}s"
    parts.append(f'<text x="4" y="12" font-size="11" font-weight="bold" fill="{col}">{html.escape(head)}  {net:+.2f} USD</text>')
    parts.append(f'<text x="4" y="25" font-size="9.5" fill="#52514e">buy {shares:.0f} at {ent:.3f}; {html.escape(how)}</text>')
    parts.append(f'<text x="4" y="{h - 4}" font-size="9" fill="#898781">{lo:.3f}</text><text x="{w - 4}" y="{h - 4}" font-size="9" fill="#898781" text-anchor="end">{hi:.3f}</text>')
    return f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" style="background:#fcfcfb">{"".join(parts)}</svg>'


def gallery_html(tab, e, path: Path, title: str, subtitle: str, order="time"):
    """Every entry of `e`, one SVG each, in time order (or by net). Returns the number of entries drawn."""
    n = len(e["net"])
    idx = np.argsort(e["net"], kind="stable") if order == "net" else np.lexsort((e["asset"], e["slot"]))
    cells = []
    for i in idx:
        rec = M.l2_record(tab, e, int(i))
        cells.append(f'<div class="c">{_svg(rec, e, int(i), tab)}</div>')
    doc = (f'<!doctype html><meta charset="utf-8"><title>{html.escape(title)}</title><style>body{{font:14px system-ui;background:#fcfcfb;color:#0b0b0b;margin:16px}}'
           f'.g{{display:flex;flex-wrap:wrap;gap:6px}}.c{{border:1px solid #e1e0d9}}h1{{font-size:18px;margin:0 0 4px}}p{{color:#52514e;margin:2px 0 10px}}</style>'
           f'<h1>{html.escape(title)}</h1><p>{html.escape(subtitle)}</p>'
           f'<p>Asks above the line are the levels the buy lifted, bids below are the levels the exit sold into; the dark part of a bar is the shares taken, the pale part the depth left '
           f'(cut at about twice the shares bought). The black triangle is the average price paid and points the way the entry bets (upright a buy of Up, inverted a buy of Down); the black square is the average price received. {n} entries, in {"net order" if order == "net" else "time order"}.</p>'
           f'<div class="g">{"".join(cells)}</div>')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(doc, encoding="utf-8", newline="\n")
    return n
