"""Reads of the derived days for the 15-minute Up/Down study (B-0642): probability scores, calibration, entry statistics against the break-even win rate,
benchmarks, selection, and the frames the figures draw. Pure numpy/pandas, no I/O. A day is `(arrays, meta)` from `updown15_day.unpack`; nothing here
sees raw ladders or raw trades, only what the derived days kept.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import updown15_day as D
import updown15_model as M
import updown15_run as R

ASSETS = D.ASSETS
LB = R.LB


# =============================================================== the instants: the momentum probability against the outcome and the market
def sample_frame(days: list) -> pd.DataFrame:
    """One row per (window, 5 s instant) over the ok windows of the days. `side` is the momentum direction (sign of z); `y_side` is 1 when that side won;
    every p_* is the probability the momentum side wins (brownian = the baseline fair value, logit, table10/30/60); `mid_side` is the Polymarket mid of
    that same side."""
    parts = []
    for arrs, meta in days:
        ok = np.flatnonzero(arrs["w_status"] == 0)
        if not len(ok):
            continue
        n_w, n_s = len(ok), arrs["s_z"].shape[1]
        z = arrs["s_z"][ok].ravel()
        side = np.where(z >= 0, 1, -1)
        up = np.repeat(arrs["w_up"][ok].astype(bool), n_s)
        pu = arrs["s_pu"][ok].ravel()
        mid = arrs["s_mid"][ok].ravel()
        cols = {"day": np.repeat(meta["day"], n_w * n_s), "widx": np.repeat(ok, n_s), "asset": np.repeat(np.array(ASSETS)[arrs["w_asset"][ok]], n_s),
                "win_start_ms": np.repeat(arrs["w_start"][ok], n_s), "t_el": np.tile(R.OPEN_S + 5 * np.arange(n_s), n_w),
                "z": z, "side": side, "y_side": ((side > 0) == up).astype(float), "S": arrs["s_S"][ok].ravel(),
                "p_brownian": np.where(side > 0, pu, 1 - pu), "mid_side": np.where(side > 0, mid, 1 - mid), "y_up": up.astype(float)}
        for li, L in enumerate(LB):
            cols[f"zl{L}"] = arrs["s_zl"][ok][:, :, li].ravel()
        for mi, nm in enumerate(meta["map_cols"]):
            cols[f"p_{nm}"] = arrs["s_pm"][ok][:, :, mi].ravel()
        parts.append(pd.DataFrame(cols))
    sf = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
    if len(sf):
        sf["t_left"] = R.WIN_S - sf["t_el"]
    return sf


def triggered(sf: pd.DataFrame, zmin: float, L: int) -> pd.DataFrame:
    """The instants where the momentum signal is on: |z| >= z_min and the L-second lookback agrees (same sign as z)."""
    agree = (np.sign(sf[f"zl{L}"]) == np.sign(sf["z"])) & (sf["z"] != 0)
    return sf[(sf["z"].abs() >= zmin) & agree]


def prob_scores(tr: pd.DataFrame, L: int, base_rate: float) -> pd.DataFrame:
    """Brier and log loss at the triggered instants of: the constant (the fit-window win rate of the momentum side), the baseline Brownian fair value, the
    logistic map, the table map, and the Polymarket mid of the same side. Rows without a mid are dropped for ALL, so the rows compared are the same."""
    d = tr[np.isfinite(tr["mid_side"])]
    y = d["y_side"].to_numpy()
    rows = [("constant: fit-window win rate", np.full(len(d), base_rate)), ("Polymarket mid of the side", d["mid_side"].to_numpy()),
            ("Brownian fair value (baseline)", d["p_brownian"].to_numpy()), ("logistic map", d["p_logit"].to_numpy()),
            (f"table map ({L} s lookback)", d[f"p_table{L}"].to_numpy())]
    out = pd.DataFrame([dict(name=nm, n=len(d), brier=M.brier(p, y), logloss=M.log_loss(p, y)) for nm, p in rows])
    mid_b = float(out.loc[out["name"] == "Polymarket mid of the side", "brier"].iloc[0])
    out["brier_minus_mid"] = out["brier"] - mid_b
    return out


def calibration_table(p, y, edges=None) -> pd.DataFrame:
    """Predicted-probability bucket against the realised win rate, with a Wilson interval per bucket."""
    p, y = np.asarray(p, float), np.asarray(y, float)
    edges = np.array([0.0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 1.0001]) if edges is None else np.asarray(edges)
    idx = np.clip(np.digitize(p, edges) - 1, 0, len(edges) - 2)
    rows = []
    for k in range(len(edges) - 1):
        m = idx == k
        n = int(m.sum())
        if not n:
            continue
        lo, hi = M.wilson(int(y[m].sum()), n)
        rows.append(dict(bucket=f"{edges[k]:.2f}-{min(edges[k + 1], 1.0):.2f}", p_mean=float(p[m].mean()), win_rate=float(y[m].mean()), lo=lo, hi=hi, n=n))
    return pd.DataFrame(rows)


def cluster_diff_ci(tr: pd.DataFrame, name: str, reps: int = 2000, seed: int = 5):
    """Interval of (model Brier - mid Brier) at the triggered instants, resampling whole windows (a window's instants are one cluster)."""
    d = tr[np.isfinite(tr["mid_side"])]
    diff = (d[name] - d["y_side"]) ** 2 - (d["mid_side"] - d["y_side"]) ** 2
    key = (d["day"].astype(str) + "|" + d["asset"].astype(str) + "|" + d["win_start_ms"].astype(str)).to_numpy()
    u, inv = np.unique(key, return_inverse=True)
    tot = np.bincount(inv, weights=diff.to_numpy(), minlength=len(u))
    cnt = np.bincount(inv, minlength=len(u)).astype(float)
    rng = np.random.default_rng(seed)
    draws = rng.integers(0, len(u), size=(reps, len(u)))
    vals = tot[draws].sum(1) / cnt[draws].sum(1)
    return float(diff.mean()), float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5)), int(len(u))


# =============================================================== entries: win rate against the break-even win rate
def wilson(k, n):
    return M.wilson(int(k), int(n))


def entry_summary(e: pd.DataFrame) -> dict:
    """Headline numbers of the ENTERED rows of an entries frame. `be` is the mean break-even win rate of the actual fills: (cost + fee) per share, since a
    winning share pays 1 and a losing one 0; `win_minus_be_pp` is the win rate minus it, in percentage points."""
    x = e[e["status"] == "entered"]
    n = len(x)
    if not n:
        return dict(n=0, wins=0, win_rate=np.nan, lo=np.nan, hi=np.nan, avg_px=np.nan, be=np.nan, win_minus_be_pp=np.nan, gross=0.0, fee=0.0, net=0.0, per_entry=np.nan, partial=0)
    k = int(x["won"].sum())
    lo, hi = wilson(k, n)
    be = float(((x["cost"] + x["fee_usd"]) / x["shares"]).mean())
    return dict(n=n, wins=k, win_rate=k / n, lo=lo, hi=hi, avg_px=float(x["vwap"].mean()), be=be, win_minus_be_pp=(k / n - be) * 100.0,
                gross=float(x["pnl_gross"].sum()), fee=float(x["fee_usd"].sum()), net=float(x["pnl_net"].sum()), per_entry=float(x["pnl_net"].mean()), partial=int(x["partial"].sum()))


def by_price_bucket(e: pd.DataFrame, edges=(0.0, 0.3, 0.5, 0.7, 0.9, 1.0001)) -> pd.DataFrame:
    """Win rate against break-even by the price paid (the fill's average price)."""
    x = e[e["status"] == "entered"].copy()
    if not len(x):
        return pd.DataFrame()
    x["b"] = pd.cut(x["vwap"], list(edges), right=False)
    rows = []
    for b, g in x.groupby("b", observed=True):
        s = entry_summary(g)
        rows.append(dict(bucket=f"{b.left:.2f}-{min(b.right, 1.0):.2f}", **s))
    return pd.DataFrame(rows)


def by_key(e: pd.DataFrame, key) -> pd.DataFrame:
    x = e[e["status"] == "entered"]
    rows = []
    for k, g in x.groupby(key):
        rows.append({"key": k, **entry_summary(g)})
    return pd.DataFrame(rows)


def daily(e: pd.DataFrame, days: list[str]) -> pd.DataFrame:
    x = e[e["status"] == "entered"]
    g = x.groupby("day").agg(n=("pnl_net", "size"), net=("pnl_net", "sum"), gross=("pnl_gross", "sum"), fee=("fee_usd", "sum"))
    return g.reindex(days).fillna(0.0)


def equity_curve(e: pd.DataFrame, book_usd: float = 1000.0):
    """Entries in window-start order; the book is USD 1,000, no compounding. -> (times ms, equity, drawdown)."""
    x = e[e["status"] == "entered"].sort_values(["win_start_ms", "asset"])
    eq = book_usd + x["pnl_net"].cumsum().to_numpy()
    peak = np.maximum.accumulate(np.concatenate([[book_usd], eq]))[1:]
    return x["win_start_ms"].to_numpy(), eq, eq - peak


def max_concurrent_usd(e: pd.DataFrame) -> float:
    """Most capital open at once: entries of the same quarter hour overlap, so up to four of them (entries last at most 15 minutes)."""
    x = e[e["status"] == "entered"]
    return float(x.groupby("win_start_ms")["cost"].sum().max()) if len(x) else 0.0


def reasons(e: pd.DataFrame) -> pd.Series:
    """Why each window did or did not enter: entered / no_edge / late / ask_gone / no_depth / no_book / binance_gap."""
    r = e["status"].copy()
    return r.where(e["wstatus"] == "ok", e["wstatus"])


def adverse(e: pd.DataFrame) -> dict:
    """Adverse selection of the 250 ms. `up_*` and the means are over the ENTRIES (what filled: a fill needs the ask at or under the signal ask, so these are
    flattered); `first_gone_share` is the share of windows with a trigger where at least one order found the ask gone before the entry (or never filled): the
    trades the delay took away."""
    x = e[e["status"] == "entered"]
    d250 = (x["ask_250ms"] - x["ask_signal"]).to_numpy()
    d1000 = (x["ask_1000ms"] - x["ask_signal"]).to_numpy()
    allr = e[(e["wstatus"] == "ok") & (e["n_trig"] > 0)]
    first_gone = ((allr["n_gone"] > 0) | (allr["status"] == "ask_gone")).mean() if len(allr) else np.nan
    never = (allr["status"].isin(["ask_gone", "no_depth"])).mean() if len(allr) else np.nan
    return dict(n=len(x), mean_move_250_c=float(np.nanmean(d250) * 100) if len(x) else np.nan, mean_move_1000_c=float(np.nanmean(d1000) * 100) if len(x) else np.nan,
                up_250=float(np.nanmean(d250 > 1e-9)) if len(x) else np.nan, up_1000=float(np.nanmean(d1000 > 1e-9)) if len(x) else np.nan,
                windows_with_trigger=int(len(allr)), windows_ask_gone_only=int((allr["status"] == "ask_gone").sum()), first_gone_share=float(first_gone), never_filled_share=float(never),
                gone_share_of_attempts=float(first_gone))


# =============================================================== selection on validation
def grid_table(days_val: list, lat: int = R.LATENCY_MS) -> pd.DataFrame:
    """Every configuration of the grid over the days: entries, win rate, break-even, net PnL. The whole grid, not the best cell."""
    rows = []
    cfgs = days_val[0][1]["cfgs"]
    for c in cfgs:
        e = D.entries_frame(days_val, c["id"], lat)
        rows.append(dict(cfg=c["name"], family=c["family"], map=c["map"], zmin=c["zmin"], L=c["L"], theta=c["theta"], **entry_summary(e)))
    return pd.DataFrame(rows)


def pick(grid: pd.DataFrame, min_entries: int = 100):
    """Pre-registered: among the momentum configurations with at least `min_entries` entries on the validation days, the best net PnL per entry. None when none qualifies."""
    g = grid[(grid["n"] >= min_entries) & (grid["family"] == "momentum")]
    if not len(g):
        return None
    return g.sort_values("per_entry", ascending=False).iloc[0]


# =============================================================== benchmarks (read from the derived books on the 250 ms grid)
def _grid_idx(t_off_ms, lead=D.LEAD_S * 1000, step=D.BOOK_STEP_MS):
    return np.clip((np.asarray(t_off_ms) + lead) // step, 0, D.NB - 1).astype(int)


def _fee(sh, px, rate, expo):
    return np.round(sh * rate * (px * (1 - px)) ** expo, 5)


def bench_entries(days: list, e: pd.DataFrame, rng, mode: str, lat: int = R.LATENCY_MS):
    """The benchmarks, filled at the best ask of the 250 ms book grid as of t + lat for the whole USD 20 (generous to them: no depth walk).
    mode 'favourite': at each of the model's entry instants buy the side the Polymarket mid favours (mid >= 0.5: Up).
    mode 'random':    the model's entry count per day, uniform random window and instant in [10 s, end - T_min], random side."""
    out = []
    for arrs, meta in days:
        ok = np.flatnonzero(arrs["w_status"] == 0)
        ed = e[(e["day"] == meta["day"]) & (e["status"] == "entered")]
        if mode == "favourite":
            picks = [(int(w), int(t)) for w, t in zip(ed["widx"], ed["t_signal_off_ms"])]
        else:
            if not len(ok) or not len(ed):
                continue
            w = rng.choice(ok, size=len(ed))
            t = rng.integers(R.OPEN_S * 1000, (R.WIN_S - R.TMIN_S) * 1000, size=len(ed))
            picks = list(zip(w.tolist(), t.tolist()))
        for w, t in picks:
            gi = _grid_idx(t + lat)
            bb, ba = arrs["b_bid"][w, gi], arrs["b_ask"][w, gi]
            if bb == D.NA or ba == D.NA:
                continue
            up_ask, dn_ask = ba / 1000.0, 1.0 - bb / 1000.0
            gj = _grid_idx(t)
            mid = (arrs["b_bid"][w, gj] + arrs["b_ask"][w, gj]) / 2000.0 if arrs["b_bid"][w, gj] != D.NA and arrs["b_ask"][w, gj] != D.NA else np.nan
            if mode == "favourite":
                if not np.isfinite(mid):
                    continue
                side = 1 if mid >= 0.5 else -1
            else:
                side = int(rng.choice([-1, 1]))
            px = up_ask if side > 0 else dn_ask
            if not (0.0 < px < 1.0):
                continue
            sh = np.floor(R.CLIP_USD / px * 100) / 100
            fee = _fee(sh, px, float(arrs["w_fee"][w]), float(arrs["w_exp"][w]))
            won = (side > 0) == bool(arrs["w_up"][w])
            gross = sh * (1.0 if won else 0.0) - sh * px
            out.append(dict(day=meta["day"], widx=w, side=side, px=px, shares=sh, cost=sh * px, fee_usd=fee, pnl_gross=gross, pnl_net=gross - fee, won=bool(won)))
    return pd.DataFrame(out)


def bench_summary(b: pd.DataFrame) -> dict:
    if not len(b):
        return dict(n=0, per_entry=np.nan, win_rate=np.nan, net=0.0, be=np.nan)
    return dict(n=len(b), per_entry=float(b["pnl_net"].mean()), win_rate=float(b["won"].mean()), net=float(b["pnl_net"].sum()),
                be=float(((b["cost"] + b["fee_usd"]) / b["shares"]).mean()))


def random_dist(days, e, reps: int = 300, seed: int = 3):
    rng = np.random.default_rng(seed)
    per, tot = [], []
    for _ in range(reps):
        b = bench_entries(days, e, rng, "random")
        per.append(float(b["pnl_net"].mean()) if len(b) else np.nan)
        tot.append(float(b["pnl_net"].sum()) if len(b) else 0.0)
    return np.array(per), np.array(tot)


def window_cluster_ci(e: pd.DataFrame, reps: int = 4000, seed: int = 9, q=(2.5, 97.5)):
    """Interval of the TOTAL net, resampling quarter-hour slots (the four assets of one slot overlap, so they are one cluster)."""
    x = e[e["status"] == "entered"]
    if not len(x):
        return np.nan, np.nan
    u, inv = np.unique(e["win_start_ms"].to_numpy(), return_inverse=True)        # every slot, entered or not
    tot = np.bincount(inv[(e["status"] == "entered").to_numpy()], weights=x["pnl_net"].to_numpy(), minlength=len(u))
    rng = np.random.default_rng(seed)
    draws = rng.integers(0, len(u), size=(reps, len(u)))
    s = tot[draws].sum(1)
    return float(np.percentile(s, q[0])), float(np.percentile(s, q[1]))


def slot_cluster_mean_ci(e: pd.DataFrame, reps: int = 4000, seed: int = 9, q=(2.5, 97.5)):
    """Interval of the net PER ENTRY, resampling quarter-hour slots with their entries (a slot's assets are one cluster)."""
    x = e[e["status"] == "entered"]
    if not len(x):
        return np.nan, np.nan
    u, inv = np.unique(x["win_start_ms"].to_numpy(), return_inverse=True)
    tot = np.bincount(inv, weights=x["pnl_net"].to_numpy(), minlength=len(u))
    cnt = np.bincount(inv, minlength=len(u)).astype(float)
    rng = np.random.default_rng(seed)
    draws = rng.integers(0, len(u), size=(reps, len(u)))
    v = tot[draws].sum(1) / cnt[draws].sum(1)
    return float(np.percentile(v, q[0])), float(np.percentile(v, q[1]))


# =============================================================== the figures' frames and panels, from derived days only
FIG_STATUS = {"entered": "entered", "no_edge": "no_edge", "late": "late", "no_depth": "no_depth", "ask_gone": "no_depth", "no_book": "no_data", "binance_gap": "no_data"}


def figure_frames(days: list, cfg: str, lat: int = R.LATENCY_MS):
    """-> (windows, entries) in the frames `updown15_figs` draws: one row per window with the status (entered / no_edge / no_depth / late / no_data),
    one per entry with t_entry_ms. Every window of the derived days is in `windows`, so a missing book shows as no_data."""
    e = D.entries_frame(days, cfg, lat)
    rows = []
    for arrs, meta in days:
        for wi in range(len(arrs["w_start"])):
            rows.append((meta["day"], wi, ASSETS[int(arrs["w_asset"][wi])], int(arrs["w_start"][wi]), bool(arrs["w_up"][wi]), int(arrs["w_status"][wi])))
    wins = pd.DataFrame(rows, columns=["day", "widx", "asset", "win_start_ms", "outcome_up", "wstatus"])
    keep = e[["day", "widx", "status"]].rename(columns={"status": "cstatus"})
    wins = wins.merge(keep, on=["day", "widx"], how="left")
    st = np.where(wins["wstatus"] != 0, np.where(wins["wstatus"] == 1, "no_book", "binance_gap"), wins["cstatus"].fillna("no_edge"))
    wins["status"] = [FIG_STATUS[s] for s in st]
    x = e[e["status"] == "entered"].copy()
    ent = pd.DataFrame(dict(asset=x["asset"], win_start_ms=x["win_start_ms"], side=x["side"], t_entry_ms=x["win_start_ms"] + x["t_signal_off_ms"], ask_best=x["ask_best"],
                            vwap=x["vwap"], shares=x["shares"], fee_usd=x["fee_usd"], pnl_gross=x["pnl_gross"], pnl_net=x["pnl_net"], won=x["won"], p_model=x["p_model"],
                            mid_up_at_entry=x["mid_up"], partial=x["partial"], day=x["day"], widx=x["widx"], ask_signal=x["ask_signal"]))
    return wins, ent


class Panels:
    """panel(asset, win_start_ms) for the figures, read from the derived day that holds the window: the Binance path, the baseline fair value P(Up), the
    momentum side's calibrated probability, the Up bid and ask, the signal z with its trigger, the entry and the ladder snapshots."""

    def __init__(self, days: list, map_col: str, entries: pd.DataFrame, zmin: float | None = None):
        self.by_start = {}
        for arrs, meta in days:
            for wi in range(len(arrs["w_start"])):
                self.by_start[(ASSETS[int(arrs["w_asset"][wi])], int(arrs["w_start"][wi]))] = (arrs, meta, wi)
        self.map_col, self.entries, self.zmin = map_col, entries, zmin

    def __call__(self, asset: str, win_start_ms: int) -> dict:
        arrs, meta, wi = self.by_start[(asset, int(win_start_ms))]
        sec = np.arange(0, R.WIN_S + 1)
        mi = meta["map_cols"].index(self.map_col)
        a0 = float(arrs["w_a0"][wi])
        mid = arrs["n_mid"][wi][-len(sec):]
        bn_rel = np.log(mid / a0) if np.isfinite(a0) and a0 > 0 else np.full(len(sec), np.nan)
        lo, hi = int(arrs["e_off"][wi]), int(arrs["e_off"][wi + 1])
        p_up = np.full(len(sec), np.nan)
        p_side = np.full(len(sec), np.nan)
        z = np.full(len(sec), np.nan)
        zl = np.full((len(sec), 3), np.nan)
        side = np.full(len(sec), np.nan)
        if hi > lo:
            t = arrs["e_t"][lo:hi].astype(np.int64)
            i = np.searchsorted(t, sec * 1000, side="right") - 1
            ok = i >= 0
            j = np.maximum(i, 0)
            p_up = np.where(ok, arrs["e_pu"][lo:hi][j] / 65534.0, np.nan)
            z = np.where(ok, arrs["e_z"][lo:hi][j], np.nan)
            zl = np.where(ok[:, None], arrs["e_zl"][lo:hi][j], np.nan)
            side = np.where(z >= 0, 1.0, -1.0)
            p_side = np.where(ok, arrs["e_pm"][lo:hi][j, mi] / 65534.0, np.nan)
        gi = ((sec * 1000 + D.LEAD_S * 1000) // D.BOOK_STEP_MS).astype(int)
        bid, ask = arrs["b_bid"][wi][gi].astype(float), arrs["b_ask"][wi][gi].astype(float)
        bid = np.where(bid == D.NA, np.nan, bid / 1000.0)
        ask = np.where(ask == D.NA, np.nan, ask / 1000.0)
        ent = None
        e = self.entries[(self.entries["asset"] == asset) & (self.entries["win_start_ms"] == int(win_start_ms))]
        if len(e):
            r = e.iloc[0]
            ent = (float(r["t_entry_ms"] - win_start_ms) / 1000.0, float(r["vwap"]), int(r["side"]))
        lts = int(win_start_ms) + 1000 * np.arange(D.LAD_T0_S, D.LAD_T1_S + 1, D.LAD_STEP_S)
        depth = None
        if np.isfinite(arrs["l_bid_px"][wi]).any() or np.isfinite(arrs["l_ask_px"][wi]).any():
            depth = dict(ts=lts, bid_px=arrs["l_bid_px"][wi], bid_sz=arrs["l_bid_sz"][wi], ask_px=arrs["l_ask_px"][wi], ask_sz=arrs["l_ask_sz"][wi])
        # the fair value of the side the model favours, on the Up scale, and the edge against the ask of that side
        fair_up = np.where(side > 0, p_side, 1 - p_side) if np.isfinite(p_side).any() else p_up
        ask_side = np.where(side > 0, ask, 1 - bid)
        return dict(sec=sec, bn_rel=bn_rel, p_up=p_up, p_side=p_side, fair_up=fair_up, side=side, z=z, zl=zl, zmin=self.zmin, up_bid=bid, up_ask=ask,
                    edge=p_side - ask_side, entry=ent, depth=depth)


def signal_on_frame(days: list, zmin: float, L: int) -> pd.DataFrame:
    """One row per usable window: did the momentum signal turn ON at any decision instant with at least T_min left (|z| >= z_min and the L-second lookback agreeing)?
    Independent of theta and of the book: how often the SIGNAL fires, by asset and UTC hour."""
    li = list(LB).index(L)
    rows = []
    for arrs, meta in days:
        for wi in np.flatnonzero(arrs["w_status"] == 0):
            lo, hi = int(arrs["e_off"][wi]), int(arrs["e_off"][wi + 1])
            on = False
            first = np.nan
            if hi > lo:
                t = arrs["e_t"][lo:hi]
                z = arrs["e_z"][lo:hi]
                zl = arrs["e_zl"][lo:hi, li]
                m = (np.abs(z) >= zmin) & (np.sign(zl) == np.sign(z)) & (z != 0) & (t <= (R.WIN_S - R.TMIN_S) * 1000)
                on = bool(m.any())
                first = float(t[np.argmax(m)] / 1000.0) if on else np.nan
            ms = int(arrs["w_start"][wi])
            rows.append(dict(day=meta["day"], widx=int(wi), asset=ASSETS[int(arrs["w_asset"][wi])], win_start_ms=ms, hour=int((ms // 3_600_000) % 24), triggered=on, first_s=first))
    return pd.DataFrame(rows)


# =============================================================== the first cut: the same reads on the FIT days (Binance only, in-sample)
def fit_frame(days: list, maps: "R.Maps") -> pd.DataFrame:
    """One row per (window, 5 s instant) of FIT-day bundles, with the probabilities the maps give IN-SAMPLE (the maps were fitted on these rows) and no Polymarket
    columns. The frame `triggered` and `calibration_table` read, so the first cut shows the same charts before any ladder exists."""
    parts = []
    for arrs, meta in days:
        f = {k: arrs[k] for k in ("S", "A0", "T", "t_el", "sig", "z", "r10", "r30", "r60", "known_sum")}
        P = maps.predict(f)
        side = R.side_of(f)
        pu_b = R.p_up_brownian(f)
        w = arrs["s_w"]
        cols = {"day": np.repeat(meta["day"], len(w)), "widx": w, "asset": np.array(ASSETS)[arrs["s_asset"]], "win_start_ms": arrs["w_start"][w], "t_el": arrs["t_el"],
                "z": arrs["z"], "side": side, "y_side": ((side > 0) == (arrs["s_y"] > 0)).astype(float), "S": arrs["S"], "p_brownian": R.p_side(pu_b, side),
                "mid_side": np.full(len(w), np.nan), "y_up": arrs["s_y"].astype(float), "p_logit": P["logit"][30], "p_table10": P["table"][10], "p_table30": P["table"][30],
                "p_table60": P["table"][60], "t_left": arrs["T"]}
        for L in LB:
            cols[f"zl{L}"] = arrs[f"r{L}"] / (arrs["sig"] * np.sqrt(L))
        parts.append(pd.DataFrame(cols))
    return pd.concat(parts, ignore_index=True)


def signal_on_fit(sf: pd.DataFrame, zmin: float, L: int) -> pd.DataFrame:
    """Per window of a fit frame: did the signal turn ON (|z| >= z_min, the L-second lookback agreeing, at least T_min left)? -> asset, hour, triggered."""
    on = ((sf["z"].abs() >= zmin) & (np.sign(sf[f"zl{L}"]) == np.sign(sf["z"])) & (sf["z"] != 0) & (sf["t_left"] >= R.TMIN_S))
    g = sf.assign(on=on).groupby(["day", "widx", "asset", "win_start_ms"], as_index=False)["on"].max()
    g["hour"] = ((g["win_start_ms"] // 3_600_000) % 24).astype(int)
    return g.rename(columns={"on": "triggered"})
