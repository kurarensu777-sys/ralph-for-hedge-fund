"""Backtest of the Binance momentum pack against Polymarket's 15-minute BTC Up/Down books (B-0649). Paper only, numpy and pandas, no I/O.

THE RULE UNDER TEST is `lift_pack.Pack`: at a Binance trade, H1 (the last second moved by at least z0 volatilities) opens an episode; its first row is the signal at time t and its
side is the sign of the move. One order of USD 20 (clip) is sent AT t and meets the book as it stood at t + lat (lat = the venue's 150 ms taker delay): the last book row with a
venue time <= t + lat, never the next. The token bought is Up for a rise, Down for a fall; the fill walks the exact ask ladder level by level and pays the venue's taker fee
rate * p * (1 - p) on every level taken (updown15_sim.fee_usd, the venue card formula). The position is then
    hold      held to the market's recorded outcome (pays 1 or 0 a share)
    scalp h   sold h seconds after the fill into the bid ladder: the exit order is sent at t + lat + h and meets the book at t + 2 lat + h, fee on the sale too; shares the bids
              cannot take are held to the outcome
Entries are one at a time in a window (a position open blocks the next signal until it is flat); a hold ends the window's trading. Nothing here sees the outcome until `settle`.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.special import ndtr

import updown15_sim as S

CLIP_USD = 20.0
OPEN_MS = 10_000             # no entry in the first 10 s of a window (the book's first snapshot, as in the earlier study)
CLOSE_MS = 10_000            # none in the last 10 s


@dataclass(frozen=True)
class Cfg:
    z0: float = 1.0                  # signal size, volatilities
    exit: str = "hold"               # "hold" or "scalp"
    hold_s: float = 10.0             # scalp: seconds from the fill to the exit order
    lo: float = 0.0                  # the token's best ask must be at or above lo and at or below hi
    hi: float = 1.0
    left_max_s: float = 900.0        # only signals with at most this many seconds left in the window
    lat_ms: int = 150

    @property
    def name(self) -> str:
        e = "hold" if self.exit == "hold" else f"scalp{self.hold_s:g}"
        band = "all" if (self.lo <= 0.0 and self.hi >= 1.0) else f"{self.lo:g}-{self.hi:g}"
        left = "any" if self.left_max_s >= 900 else f"le{self.left_max_s:g}"
        return f"z{self.z0:g}|{e}|{band}|{left}|L{self.lat_ms}"


def grid() -> list:
    """The 24 pre-registered configurations (um-004): z0 {1, 2} x exit {hold, sell back after 10 s, after 60 s} x best-ask band {all, 0.15 to 0.85} x time left {any, at most 180 s}."""
    out = []
    for z0 in (1.0, 2.0):
        for ex, h in (("hold", 0.0), ("scalp", 10.0), ("scalp", 60.0)):
            for lo, hi in ((0.0, 1.0), (0.15, 0.85)):
                for left in (900.0, 180.0):
                    out.append(Cfg(z0=z0, exit=ex, hold_s=h, lo=lo, hi=hi, left_max_s=left))
    return out


def walk_bids(px: np.ndarray, sz: np.ndarray, shares: float, rate: float, expo: float = 1.0):
    """Sell up to `shares` into the bid ladder, best first. -> dict(sold, proceeds, fee, vwap)."""
    sold = proceeds = fee = 0.0
    left = shares
    for p, q in zip(px, sz):
        if not (p == p) or q <= 0 or left <= 1e-9:
            break
        take = min(q, left)
        sold += take
        proceeds += take * p
        fee += S.fee_usd(take, p, rate, expo)
        left -= take
    return dict(sold=sold, proceeds=proceeds, fee=fee, vwap=proceeds / sold if sold > 0 else np.nan)


def ladders(book, i: int, side: int):
    """(ask prices, ask sizes) of the token bought and (bid prices, bid sizes) of the same token, best first. side +1 Up, -1 Down (the Up ladders mirrored)."""
    if side > 0:
        return book.ask_px[i], book.ask_sz[i], book.bid_px[i], book.bid_sz[i]
    return np.round(1.0 - book.bid_px[i], 4), book.bid_sz[i], np.round(1.0 - book.ask_px[i], 4), book.ask_sz[i]


def run_window(mk: dict, book, trig: dict, cfgs: list, up_won: bool) -> list:
    """Every configuration over one window. `trig` maps z0 -> dict(ts, side, z) of that signal size's episode starts (ms). Returns one row per entry."""
    st, en = int(mk["start_ms"]), int(mk["end_ms"])
    rate, expo = float(mk.get("fee_rate", 0.07)), float(mk.get("fee_exponent", 1.0))
    rows = []
    for cfg in cfgs:
        tr = trig[cfg.z0]
        free_at = -1
        for t, s, z in zip(tr["ts"], tr["side"], tr["z"]):
            t = int(t)
            if t < st + OPEN_MS or t > en - CLOSE_MS or t < free_at:
                continue
            left_s = (en - t) / 1000.0
            if left_s > cfg.left_max_s:
                continue
            tf = t + cfg.lat_ms
            i = int(book.at(np.array([tf]))[0])
            if i < 0:
                continue
            side = int(s)
            apx, asz, bpx, bsz = ladders(book, i, side)
            ask0 = float(apx[0]) if np.isfinite(apx[0]) else np.nan
            if not np.isfinite(ask0) or ask0 < cfg.lo or ask0 > cfg.hi:
                continue
            f = S.walk_asks(apx, asz, CLIP_USD, rate, expo)
            if f["shares"] <= 0:
                continue
            bid0 = float(bpx[0]) if np.isfinite(bpx[0]) else np.nan
            won = (side == 1) == bool(up_won)
            if cfg.exit == "hold" or tf + int(cfg.hold_s * 1000) + cfg.lat_ms >= en - 1:
                exit_kind, proceeds, fee_out, left_sh = "expiry", 0.0, 0.0, f["shares"]
                free_at = en + 1
            else:
                tx = tf + int(cfg.hold_s * 1000) + cfg.lat_ms
                j = int(book.at(np.array([tx]))[0])
                if j < 0:
                    exit_kind, proceeds, fee_out, left_sh = "expiry", 0.0, 0.0, f["shares"]
                    free_at = en + 1
                else:
                    _, _, qpx, qsz = ladders(book, j, side)
                    sell = walk_bids(qpx, qsz, f["shares"], rate, expo)
                    exit_kind = "sold" if sell["sold"] >= f["shares"] - 1e-9 else ("part" if sell["sold"] > 0 else "expiry")
                    proceeds, fee_out, left_sh = sell["proceeds"], sell["fee"], f["shares"] - sell["sold"]
                    free_at = tx + 1
            payoff = left_sh * (1.0 if won else 0.0)
            gross = proceeds + payoff - f["cost"]
            rows.append(dict(slug=mk["slug"], day=pd.Timestamp(st, unit="ms").strftime("%Y-%m-%d"), cfg=cfg.name, t_ms=t, into_s=(t - st) / 1000.0, left_s=left_s, side=side, z=float(z),
                             ask=ask0, bid=bid0, spread=(ask0 - bid0) if np.isfinite(bid0) else np.nan, vwap=f["vwap"], shares=f["shares"], cost=f["cost"], fee_in=f["fee"], fee_out=fee_out,
                             exit=exit_kind, proceeds=proceeds, won=bool(won), gross=gross, net=gross - f["fee"] - fee_out, partial=bool(f["partial"])))
            if cfg.exit == "hold":
                break                                    # a hold ends the window's trading
    return rows


def summarize(df: pd.DataFrame) -> dict:
    """Entries, win rate (net above zero), net and gross USD, fees, mean price, per entry values."""
    n = len(df)
    if n == 0:
        return dict(n=0, win=np.nan, net=0.0, gross=0.0, fees=0.0, per_entry=np.nan, gross_per_entry=np.nan, px=np.nan, spread=np.nan, partial=0)
    return dict(n=n, win=float((df.net > 0).mean()), net=float(df.net.sum()), gross=float(df.gross.sum()), fees=float((df.fee_in + df.fee_out).sum()), per_entry=float(df.net.mean()),
                gross_per_entry=float(df.gross.mean()), px=float(df.vwap.mean()), spread=float(df.spread.mean()), partial=int(df.partial.sum()))


def cluster_ci(df: pd.DataFrame, col="net", by="slug", reps=2000, seed=9, q=(2.5, 97.5)):
    """Mean of `col` per entry with a bootstrap interval that resamples whole windows (`by`), because entries of one window are not independent."""
    if len(df) == 0:
        return (np.nan, np.nan, np.nan)
    g = df.groupby(by)[col].agg(["sum", "count"])
    rng = np.random.default_rng(seed)
    s, c = g["sum"].to_numpy(), g["count"].to_numpy()
    idx = rng.integers(0, len(g), size=(reps, len(g)))
    means = s[idx].sum(1) / np.maximum(c[idx].sum(1), 1)
    lo, hi = np.percentile(means, q)
    return (float(df[col].mean()), float(lo), float(hi))


# ============================================================================ the lag read: what the book does after a Binance signal, and what Binance implies
class Tools:
    """The Binance-side readings a fair value needs, built once per tape: as-of price, the TWAP stand-in, the known part of the final minute, the slow volatility."""

    def __init__(self, E: dict):
        import lift_feat as LF
        self.E, self.LF = E, LF
        self.twap, self.known = LF.twap_grid(E, with_known=True)
        self.sig = LF.second_grid_vol(E)

    def fair_up(self, t_ms, ws_ms, we_ms):
        """P(Up) a Brownian TWAP model puts on the window at times t_ms (array): ln(E[A_end] / A_start) over the volatility to the end, through the normal cdf."""
        LF, E = self.LF, self.E
        t = np.asarray(t_ms, np.int64)
        pn = E["px"][LF.asof(E["ts"], t)]
        a0 = self.twap(np.asarray(ws_ms, np.int64))
        ks, kn = self.known(t, np.asarray(we_ms, np.int64))
        exp_end = np.where(kn > 0, (ks + (60.0 - kn) * pn) / 60.0, pn)
        left = (np.asarray(we_ms) - t) / 1000.0
        var_units = np.where(left >= 60.0, left - 40.0, np.maximum(60.0 - kn, 0.0) ** 3 / 10800.0)
        sig = np.maximum(self.sig(t), 1e-6)
        d = np.log(exp_end / a0) / (sig * np.sqrt(np.maximum(var_units, 1e-9)))
        return ndtr(d)


LAG_OFFSETS_MS = np.arange(-2000, 5001, 50)


def lag_window(mk: dict, book, tools: Tools, trig_ts: np.ndarray, trig_side: np.ndarray):
    """For each signal of a window: the Up-token mid and the Binance-implied P(Up) at offsets from the signal, as changes from the value at the signal, in the direction of the
    signal. -> (mid_change [n, offsets] in price units, fair_change [n, offsets], mid_at_signal [n], spread_at_150 [n]); NaN where the book has no two-sided quote."""
    st, en = int(mk["start_ms"]), int(mk["end_ms"])
    ok = (trig_ts >= st + OPEN_MS) & (trig_ts <= en - CLOSE_MS)
    ts, sd = trig_ts[ok], trig_side[ok]
    if len(ts) == 0:
        return None
    T = ts[:, None] + LAG_OFFSETS_MS[None, :]
    i = book.at(T.ravel()).reshape(T.shape)
    j = np.maximum(i, 0)
    mid = np.where(i >= 0, (book.best_bid[j] + book.best_ask[j]) / 2.0, np.nan)
    i0 = book.at(ts)
    j0 = np.maximum(i0, 0)
    mid0 = np.where(i0 >= 0, (book.best_bid[j0] + book.best_ask[j0]) / 2.0, np.nan)
    fair = tools.fair_up(T.ravel(), np.full(T.size, st), np.full(T.size, en)).reshape(T.shape)
    fair0 = tools.fair_up(ts, np.full(len(ts), st), np.full(len(ts), en))
    i150 = book.at(ts + 150)
    j150 = np.maximum(i150, 0)
    spr = np.where(i150 >= 0, book.best_ask[j150] - book.best_bid[j150], np.nan)
    return (mid - mid0[:, None]) * sd[:, None], (fair - fair0[:, None]) * sd[:, None], mid0, spr


# ============================================================================ the engine's own check
class _FakeBook:
    """A hand-made ladder: rows at the given venue times; `at(t)` is the last row with ts <= t."""

    def __init__(self, ts, bid, ask, bsz=500.0, asz=500.0):
        self.ts = np.asarray(ts, np.int64)
        n = len(self.ts)
        self.bid_px = np.full((n, 3), np.nan)
        self.ask_px = np.full((n, 3), np.nan)
        self.bid_sz = np.zeros((n, 3))
        self.ask_sz = np.zeros((n, 3))
        for k in range(n):
            self.bid_px[k, 0], self.ask_px[k, 0] = bid[k], ask[k]
            self.bid_px[k, 1], self.ask_px[k, 1] = bid[k] - 0.01, ask[k] + 0.01
            self.bid_sz[k, :], self.ask_sz[k, :] = bsz, asz
        self.best_bid, self.best_ask = self.bid_px[:, 0].copy(), self.ask_px[:, 0].copy()

    def at(self, t):
        return np.searchsorted(self.ts, np.asarray(t), side="right") - 1


def selftest() -> bool:
    """Hand-computed cases; every one must come out to the cent. Returns True when all hold (an assertion error names the case that did not)."""
    mk = dict(slug="x", start_ms=0, end_ms=900_000, fee_rate=0.07, fee_exponent=1.0)
    # the book: 0.50/0.52 until 30_200 ms, then 0.60/0.62 (the signal is at 30_000, the fill at 30_150: the row at 30_200 comes AFTER the fill time and must not be read)
    bk = _FakeBook([0, 20_000, 30_200], bid=[0.50, 0.50, 0.60], ask=[0.52, 0.52, 0.62])
    trig = {1.0: dict(ts=np.array([30_000]), side=np.array([1.0]), z=np.array([2.0]))}
    # 1. a hold, Up won: 20 USD at 0.52 buys 38.4615 shares; fee 38.4615 * 0.07 * 0.52 * 0.48
    rows = run_window(mk, bk, trig, [Cfg(exit="hold")], up_won=True)
    assert len(rows) == 1, rows
    r = rows[0]
    sh = 20.0 / 0.52
    fee = round(sh * 0.07 * 0.52 * 0.48, 5)
    assert abs(r["shares"] - sh) < 1e-9 and abs(r["cost"] - 20.0) < 1e-9 and abs(r["fee_in"] - fee) < 1e-9, r
    assert abs(r["net"] - (sh - 20.0 - fee)) < 1e-9, r                          # the row at 30_200 (0.62) was not read: the fill is at 0.52
    # 2. the same hold, Up lost
    r = run_window(mk, bk, trig, [Cfg(exit="hold")], up_won=False)[0]
    assert abs(r["net"] - (0.0 - 20.0 - fee)) < 1e-9, r
    # 3. a Down signal buys at 1 - best bid = 0.50: the fill walks the mirrored ladder
    trig_d = {1.0: dict(ts=np.array([10_000]), side=np.array([-1.0]), z=np.array([-2.0]))}
    r = run_window(mk, bk, trig_d, [Cfg(exit="hold")], up_won=False)[0]
    assert abs(r["ask"] - 0.50) < 1e-9 and abs(r["shares"] - 40.0) < 1e-9, r
    fee_d = round(40.0 * 0.07 * 0.5 * 0.5, 5)
    assert abs(r["net"] - (40.0 - 20.0 - fee_d)) < 1e-9, r
    # 4. a scalp: bought at 0.52 at 30_150, the exit order is sent at 30_150 + 10_000 and meets the book at 40_150: bid 0.60 (the row at 30_200)
    r = run_window(mk, bk, trig, [Cfg(exit="scalp", hold_s=10.0)], up_won=False)[0]
    fee_out = round(sh * 0.07 * 0.60 * 0.40, 5)
    assert r["exit"] == "sold" and abs(r["proceeds"] - sh * 0.60) < 1e-9 and abs(r["fee_out"] - fee_out) < 1e-9, r
    assert abs(r["net"] - (sh * 0.60 - 20.0 - fee - fee_out)) < 1e-9, r
    # 5. the price band: an ask of 0.52 is outside 0.55 to 0.95; the time-left filter: 870 s left is outside 'at most 60 s'
    assert run_window(mk, bk, trig, [Cfg(lo=0.55, hi=0.95)], up_won=True) == []
    assert run_window(mk, bk, trig, [Cfg(left_max_s=60.0)], up_won=True) == []
    # 6. the first and last 10 s of a window are not traded
    early = {1.0: dict(ts=np.array([5_000, 895_000]), side=np.array([1.0, 1.0]), z=np.array([2.0, 2.0]))}
    assert run_window(mk, bk, early, [Cfg()], up_won=True) == []
    # 7. one position at a time: a second signal 5 s after a scalp's entry (exit still pending) is skipped
    two = {1.0: dict(ts=np.array([30_000, 35_000]), side=np.array([1.0, 1.0]), z=np.array([2.0, 2.0]))}
    assert len(run_window(mk, bk, two, [Cfg(exit="scalp", hold_s=10.0)], up_won=True)) == 1
    # 8. a hold ends the window's trading even with another signal later
    two2 = {1.0: dict(ts=np.array([30_000, 600_000]), side=np.array([1.0, 1.0]), z=np.array([2.0, 2.0]))}
    assert len(run_window(mk, bk, two2, [Cfg(exit="hold")], up_won=True)) == 1
    # 9. the latency: with lat 0 the fill reads the row at or before 30_000 (0.52), with 250 ms it reaches 30_250 and reads the 0.62 row
    assert abs(run_window(mk, bk, trig, [Cfg(lat_ms=250)], up_won=True)[0]["ask"] - 0.62) < 1e-9
    assert abs(run_window(mk, bk, trig, [Cfg(lat_ms=0)], up_won=True)[0]["ask"] - 0.52) < 1e-9
    return True
