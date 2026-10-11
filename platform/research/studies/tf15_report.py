"""The reads of the strategy search that a notebook shows (B-0654): tables over one candidate's entries. numpy and pandas only; every function takes entries / tables, none reads an outcome of its own.

    by_day, by_asset, by_band, by_left   the test entries cut four ways
    equity                               cumulative net by 15-minute slot, and the deepest drawdown
    delay_table                          a taker cell re-run on tables built for other order delays; a maker cell with its latencies moved
    cost_table                           fee x2, a cent of slack, clip sizes
    sizing                               the sizing gate: fills a day, clip, capacity, drawdown on the book
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import tf15_bt as B

BOOK_USD = 1000.0
ASSET = ["btc", "eth", "sol", "xrp"]


def frame(e, tab):
    d = {k: e[k] for k in ("w", "k", "side", "shares", "cost", "fee", "vwap", "won", "net", "gross", "day", "slot", "asset", "T")}
    df = pd.DataFrame(d)
    df["win"] = df["won"].astype(float)
    df["date"] = [tab.days[i] for i in df["day"]]
    df["coin"] = [ASSET[i] for i in df["asset"]]
    return df


def _agg(g):
    return pd.Series(dict(entries=len(g), win=g["win"].mean(), vwap=float(g["cost"].sum() / max(g["shares"].sum(), 1e-9)), net=g["net"].sum(), per=g["net"].mean(),
                          gross_per=g["gross"].mean(), fee_per=g["fee"].mean()))


def by_day(e, tab):
    df = frame(e, tab)
    out = df.groupby("date").apply(_agg, include_groups=False)
    return out.reindex(tab.days).fillna({"entries": 0, "net": 0.0})


def by_asset(e, tab):
    df = frame(e, tab)
    return df.groupby("coin").apply(_agg, include_groups=False).reindex(ASSET)


def by_band(e, tab, edges=(0, 0.05, 0.10, 0.25, 0.5, 0.75, 0.9, 0.95, 1.0001)):
    df = frame(e, tab)
    df["band"] = pd.cut(df["vwap"], list(edges), right=False)
    return df.groupby("band", observed=True).apply(_agg, include_groups=False)


def by_left(e, tab, edges=(0, 30, 60, 120, 300, 600, 901)):
    df = frame(e, tab)
    df["left"] = pd.cut(df["T"], list(edges), right=False)
    return df.groupby("left", observed=True).apply(_agg, include_groups=False)


def equity(e, tab):
    """-> (slots, cumulative net, deepest drawdown in USD, the drawdown path). Time order is the slot, then the window."""
    if len(e["net"]) == 0:
        return np.zeros(0), np.zeros(0), 0.0, np.zeros(0)
    order = np.argsort(e["slot"] * 10 + e["asset"], kind="stable")
    s, n = e["slot"][order], e["net"][order]
    eq = np.cumsum(n)
    peak = np.maximum.accumulate(np.concatenate([[0.0], eq]))[1:]
    dd = eq - peak
    return s, eq, float(-dd.min()), dd


def delay_table(cand, cfg, ctx, days, delays=(0, 50, 150, 250, 500), load=B.Tab):
    """Taker cells: the same rule on tables built for each order delay. Maker cells: the resting order's post and cancel latencies (their only delays) moved together."""
    rows = []
    for d in delays:
        if cand.family == "taker":
            tab = load(days, fill_ms=d)
            e = cand.run(tab, cfg, ctx)
        else:
            tab = load(days)
            e = cand.run(tab, cfg, ctx, post_lat_ms=d, cancel_lat_ms=d)
        s = B.summarize(e, tab, f"{d} ms")
        rows.append(dict(delay_ms=d, n=s.get("n", 0), win=s.get("win", np.nan), per=s.get("per", np.nan), lo=s.get("per_lo", np.nan), hi=s.get("per_hi", np.nan), net=s.get("net", 0.0)))
    return pd.DataFrame(rows)


def cost_table(cand, cfg, ctx, tab):
    rows = []
    for label, kw in (("as registered", {}), ("fee x2", dict(fee_mult=2.0)), ("a cent worse on every fill", dict(slack=-0.01)), ("clip USD 5", dict(usd=5.0)), ("clip USD 100", dict(usd=100.0))):
        if cand.family == "taker":
            if label.startswith("a cent"):
                e = _cent_worse(cand, tab, cfg, ctx)
            else:
                e = cand.run(tab, cfg, ctx, **kw)
        else:
            mk = {"fee x2": dict(rebate=0.0), "a cent worse on every fill": None, "clip USD 5": dict(usd=5.0), "clip USD 100": dict(usd=100.0), "as registered": {}}[label]
            if mk is None:
                continue
            e = cand.run(tab, cfg, ctx, **mk)
        s = B.summarize(e, tab, label)
        rows.append(dict(case=label if cand.family == "taker" or label != "fee x2" else "no maker rebate", n=s.get("n", 0), win=s.get("win", np.nan), per=s.get("per", np.nan), lo=s.get("per_lo", np.nan),
                         hi=s.get("per_hi", np.nan), net=s.get("net", 0.0)))
    return pd.DataFrame(rows)


def _cent_worse(cand, tab, cfg, ctx):
    """Every fill pays one more cent a share: the entry's cost rises by 0.01 x shares (a worse fill than the ladder shows)."""
    e = cand.run(tab, cfg, ctx)
    out = dict(e)
    pen = 0.01 * e["shares"]
    out["cost"] = e["cost"] + pen
    out["net"] = e["net"] - pen
    out["gross"] = e["gross"] - pen
    out["vwap"] = out["cost"] / np.maximum(e["shares"], 1e-9)
    return out


def sizing(e, tab, clip=B.CLIP_USD):
    n = len(e["net"])
    days = max(len(tab.days), 1)
    s, eq, dd, _ = equity(e, tab)
    cost = float(e["cost"].sum())
    return dict(entries=n, per_day=n / days, clip_usd=clip, cost_per_day=cost / days, net_per_day=float(e["net"].sum()) / days, max_dd_usd=dd, book_usd=BOOK_USD,
                dd_pct_of_book=dd / BOOK_USD * 100, ret_pct_of_book_per_day=float(e["net"].sum()) / days / BOOK_USD * 100,
                min_fill_usd=float(np.min(e["cost"])) if n else float("nan"), median_fill_usd=float(np.median(e["cost"])) if n else float("nan"))


def pool(entries_list):
    """Entries from several tables as one: arrays joined in the order given (the window number is per table and is not kept meaningful; slots are unique in time)."""
    keys = ("w", "k", "side", "shares", "cost", "fee", "vwap", "best", "won", "payoff", "net", "gross", "day", "slot", "asset", "T", "sold")
    es = [e for e in entries_list if len(e["net"])]
    if not es:
        return B._empty()
    return {k: np.concatenate([e[k] for e in es]) for k in keys}
