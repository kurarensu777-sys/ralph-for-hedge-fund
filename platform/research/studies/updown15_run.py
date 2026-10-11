"""The event-driven engine of the 15-minute Up/Down study (B-0642): Binance trades in, a momentum signal and a calibrated probability, a walk of the exact
Polymarket ladder, a settled entry out. numpy and scipy only; no I/O (the notebook passes frames the `fundplat.data` loaders returned). Paper only.

THE CLOCK. Every time here is UTC epoch milliseconds. A Binance row is stamped by its `transact_time` (the only time the bulk file carries, floored from
microseconds); a Polymarket book row by the venue's own `timestamp`. A decision at ms t reads Binance rows with ts <= t - shift and the book row with
ts <= t, and fills against the book row with ts <= t + latency, never the next one. `shift_ms` and `latency` are the only knobs that move a clock; the
planted tests turn them.
THE REFERENCE. The market resolves on a Chainlink 60 s TWAP: Up when the TWAP at the end >= the TWAP at the start. Both are trailing 60 s means,
modelled here as the mean of the 1 Hz as-of grid of the Binance price over seconds (t - 59 .. t). The start reference A0 is known at the start.
THE SIGNAL. z = ln(S_t / A0) / (sigma sqrt(t_elapsed)); it TRIGGERS when |z| >= z_min and the L-second lookback return points the same way, with at least
T_min seconds left. The probability that the momentum side wins is a map of (|z|, time left, the agreement flags) fitted on the fit days only.
"""
from __future__ import annotations

import sys

import numpy as np
from scipy.signal import lfilter

import updown15_model as M
import updown15_sim as SIM

WIN_S = 900
TWAP_S = 60
OPEN_S = 10                      # no decision in the first 10 s of a window
TMIN_S = 60                      # no entry with under 60 s left (T_min, [U], pre-registered)
GUARD_S = 5                      # events are read to 5 s before the end so a late trigger can be named `late`
LATENCY_MS = 250                 # the owner's signal-to-book delay
LATENCIES = (0, 150, 250, 400, 1000)
CLIP_USD = 20.0
MIN_SHARES = 5.0
MAX_TRIES = 200                  # fill attempts per (window, config) before the window is given up
RATE_LAG_S = 10                  # variance rate from 10 s log returns: tick-level bounce would inflate a 1 s estimate
HL_SLOW = 300.0
SIG_FLOOR = 1e-6
LEVELS = 10

LB = (10, 30, 60)                # lookback seconds of the agreement test
Z_MINS = (0.5, 1.0, 1.5, 2.0, 3.0)
MAPS = ("brownian", "logit", "table")
THETAS = (0.0, 0.03, 0.06)
Z_FIT_MIN = 0.25                 # the maps are fitted on the 5 s instants with |z| at least this (every z_min of the grid is above it)
Z_EDGES = (0.25, 0.5, 1.0, 1.5, 2.0, 3.0, np.inf)
T_EDGES = (60.0, 240.0, 480.0, 900.01)
SHRINK = 50.0                    # pseudo-observations of the Brownian value in each table cell


# =============================================================== one asset's Binance series
def mid_proxy(ts, px, buyer_maker, max_age_ms: int = 2000):
    """THE TRADE-IMPLIED L1 MID (a proxy, never a quote). The ask proxy is the price of the last taker-BUY trade (buyer_maker False), the bid
    proxy the price of the last taker-SELL trade; their mean when both are younger than `max_age_ms`, the last trade price otherwise.
    Row i uses trades 0..i only. Returns one value per trade row."""
    n = len(px)
    idx = np.arange(n)
    buy = np.where(~buyer_maker, idx, -1)
    sell = np.where(buyer_maker, idx, -1)
    lb, ls = np.maximum.accumulate(buy), np.maximum.accumulate(sell)
    ok = (lb >= 0) & (ls >= 0)
    ab = np.where(ok, ts - ts[np.maximum(lb, 0)], 1 << 60)
    as_ = np.where(ok, ts - ts[np.maximum(ls, 0)], 1 << 60)
    fresh = ok & (ab <= max_age_ms) & (as_ <= max_age_ms)
    return np.where(fresh, (px[np.maximum(lb, 0)] + px[np.maximum(ls, 0)]) / 2.0, px)


class Asset:
    """Binance spot trades of one symbol plus the causal series built from them. `df` has ts_ms, price, qty, buyer_maker (ascending in time); `kind`
    'last' prices every row at its trade, 'mid' at the trade-implied mid proxy."""

    def __init__(self, df, g0_ms: int, g1_ms: int, kind: str = "last"):
        ts = np.asarray(df["ts_ms"], dtype=np.int64)
        assert np.all(np.diff(ts) >= 0), "trades are not in time order"
        self.ts = ts
        self.kind = kind
        px = np.asarray(df["price"], float)
        self.px_last = px
        self.px = mid_proxy(ts, px, np.asarray(df["buyer_maker"], bool)) if kind == "mid" else px
        qty = np.asarray(df["qty"], float)
        self.bm = np.asarray(df["buyer_maker"], bool)
        sq = np.where(self.bm, -qty, qty)
        self.cs = np.concatenate([[0.0], np.cumsum(sq)])          # cs[i + 1] = signed volume of trades 0..i
        self.cv = np.concatenate([[0.0], np.cumsum(qty)])
        self.g0 = int(g0_ms)
        self.n = int((g1_ms - g0_ms) // 1000)
        gi = M.asof_idx(ts, self.g0 + 1000 * np.arange(self.n, dtype=np.int64))
        price = np.where(gi >= 0, self.px[np.maximum(gi, 0)], np.nan)
        first = np.flatnonzero(np.isfinite(price))
        assert len(first), "no trade in the grid"
        price[: first[0]] = price[first[0]]
        self.gp = price                                            # price as of each whole second (last row at or before it)
        self.cumgp = np.concatenate([[0.0], np.cumsum(price)])
        lp = np.log(price)
        rate = np.zeros(self.n)
        rate[RATE_LAG_S:] = (lp[RATE_LAG_S:] - lp[:-RATE_LAG_S]) ** 2 / RATE_LAG_S
        self.rate = rate                                           # per-second variance rate as of second k
        init = float(np.mean(rate[RATE_LAG_S: RATE_LAG_S + 3600]))
        lam = 0.5 ** (1.0 / HL_SLOW)
        y, _ = lfilter([1 - lam], [1, -lam], rate, zi=[lam * init])
        self.ew_slow = y

    def kof(self, ms):
        return np.clip((np.asarray(ms, dtype=np.int64) - self.g0) // 1000, 0, self.n - 1)

    def twap(self, k_end):
        """The trailing 60 s TWAP as of grid second k_end: the mean of the 1 Hz prices of seconds k_end-59 .. k_end."""
        k_end = np.asarray(k_end)
        return (self.cumgp[k_end + 1] - self.cumgp[k_end - TWAP_S + 1]) / TWAP_S

    def window_refs(self, start_ms: int):
        """-> (A0 known at the start, A_end the settlement proxy used ONLY to score, k0)."""
        k0 = int((start_ms - self.g0) // 1000)
        assert k0 - TWAP_S >= 0 and k0 + WIN_S < self.n, "window outside the Binance grid"
        return float(self.twap(k0)), float(self.twap(k0 + WIN_S)), k0

    def gap_s(self, start_ms: int, end_ms: int) -> float:
        """Longest stretch inside the window with no Binance trade, seconds."""
        a, b = np.searchsorted(self.ts, [start_ms, end_ms])
        t = np.concatenate([[start_ms], self.ts[a:b], [end_ms]])
        return float(np.max(np.diff(t)) / 1000.0)

    def events(self, start_ms: int, end_ms: int):
        """Distinct trade times (ms) from start + OPEN_S to end - GUARD_S: the decision instants."""
        a = np.searchsorted(self.ts, start_ms + OPEN_S * 1000, side="left")
        b = np.searchsorted(self.ts, end_ms - GUARD_S * 1000, side="right")
        return np.unique(self.ts[a:b])


# =============================================================== the momentum signal and the probability maps
def features(A: Asset, t, start_ms: int, end_ms: int, a_start: float, shift_ms: int = 0, leak_a_end: float | None = None):
    """The momentum signal and what the baseline needs, at decision instants `t` (ms, ascending). Binance rows are read with ts <= t - shift_ms;
    the clock quantities (time elapsed, time left) are exact. `leak_a_end` set is the PLANTED leak: the settlement proxy is passed through."""
    t = np.asarray(t, dtype=np.int64)
    tt = t - int(shift_ms)
    i = np.maximum(M.asof_idx(A.ts, tt), 0)
    S = A.px[i]
    k = A.kof(tt)
    T = (end_ms - t) / 1000.0
    t_el = (t - start_ms) / 1000.0
    sig = np.sqrt(np.maximum(A.ew_slow[k], SIG_FLOOR ** 2))
    d = np.log(S / a_start)
    f = dict(t=t, S=S, A0=np.full(len(t), a_start), T=T, t_el=t_el, k=k, sig=sig, z=d / (sig * np.sqrt(np.maximum(t_el, 1.0))))
    for L in LB:
        j = np.maximum(M.asof_idx(A.ts, tt - L * 1000), 0)
        f[f"r{L}"] = np.log(S / A.px[j])
        f[f"zl{L}"] = f[f"r{L}"] / (sig * np.sqrt(L))
    k_end0 = int((start_ms - A.g0) // 1000) + WIN_S
    lo = k_end0 - TWAP_S + 1
    hi = np.minimum(k, k_end0)
    f["known_sum"] = np.where(hi >= lo, A.cumgp[hi + 1] - A.cumgp[lo], 0.0)
    if leak_a_end is not None:
        f["leak_a_end"] = np.full(len(t), leak_a_end)
    return f


def agree(f: dict, L: int) -> np.ndarray:
    """The lookback return of L seconds points the same way as the move since the start (both non-zero)."""
    return (np.sign(f[f"r{L}"]) == np.sign(f["z"])) & (f["z"] != 0)


def p_up_brownian(f: dict) -> np.ndarray:
    """The baseline fair value, P(Up): driftless Brownian motion with the market's TWAP end (variance sigma^2 (T - 40) when 60 s or more is left)."""
    return M.twap_p(f["S"], f["A0"], f["sig"], f["T"], f["known_sum"], TWAP_S)


def side_of(f: dict) -> np.ndarray:
    return np.where(f["z"] >= 0, 1, -1)


def p_side(pu: np.ndarray, side: np.ndarray) -> np.ndarray:
    return np.where(side > 0, pu, 1.0 - pu)


def logit_X(f: dict) -> np.ndarray:
    return np.column_stack([np.abs(f["z"]), f["T"] / WIN_S] + [agree(f, L).astype(float) for L in LB])


LOGIT_COLS = ("|z|", "time left / 900", "10 s agrees", "30 s agrees", "60 s agrees")


class Maps:
    """The probability maps of the momentum side, fitted on the FIT days only: `logit` (five features) and `table[L]` (|z| bucket x time-left bucket, given that
    the L-second lookback agrees, shrunk to the Brownian value). `predict(f)` -> {map: {L: P(side wins) per instant}} for L in LB."""

    def __init__(self):
        self.logit = None
        self.table = {}
        self.n = 0

    def fit(self, rows: dict, y_side: np.ndarray):
        """rows: features at the fit instants with |z| >= Z_FIT_MIN; y_side: 1 if the momentum side won."""
        y = np.asarray(y_side, float)
        self.n = len(y)
        self.logit = M.fit_logit(logit_X(rows), y, l2=1.0)
        side = side_of(rows)
        pb = p_side(p_up_brownian(rows), side)
        zi = np.digitize(np.abs(rows["z"]), Z_EDGES) - 1
        ti = np.digitize(rows["T"], T_EDGES) - 1
        for L in LB:
            ok = agree(rows, L)
            tab = np.full((len(Z_EDGES) - 1, len(T_EDGES) - 1, 2), np.nan)       # [.., 0] shrunk hit rate, [.., 1] n
            for a in range(len(Z_EDGES) - 1):
                for b in range(len(T_EDGES) - 1):
                    m = ok & (zi == a) & (ti == b)
                    n = int(m.sum())
                    prior = float(pb[m].mean()) if n else 0.5
                    tab[a, b] = ((y[m].sum() + SHRINK * prior) / (n + SHRINK), n)
            self.table[L] = tab
        return self

    def predict(self, f: dict) -> dict:
        side = side_of(f)
        pb = p_side(p_up_brownian(f), side)
        out = {"brownian": {L: pb for L in LB}, "logit": {}, "table": {}}
        pl = M.predict_logit(self.logit, logit_X(f))
        zi = np.clip(np.digitize(np.abs(f["z"]), Z_EDGES) - 1, 0, len(Z_EDGES) - 2)
        ti = np.clip(np.digitize(f["T"], T_EDGES) - 1, 0, len(T_EDGES) - 2)
        for L in LB:
            out["logit"][L] = pl
            tab = self.table[L][:, :, 0]
            out["table"][L] = np.where(np.isfinite(tab[zi, ti]), tab[zi, ti], pb)
        return out

    def report(self) -> dict:
        return dict(n=self.n, logit_cols=list(LOGIT_COLS), logit_beta=[float(x) for x in self.logit[2]],
                    table={str(L): self.table[L].tolist() for L in LB}, z_edges=[float(x) for x in Z_EDGES[:-1]] + ["inf"], t_edges=list(T_EDGES[:-1]) + [900])


def sample_instants(start_ms: int, end_ms: int, step_s: int = 5):
    """The scoring instants of one window: every 5 s from start + 10 s to end - T_min (the zone in which an entry is allowed)."""
    return start_ms + 1000 * np.arange(OPEN_S, WIN_S - TMIN_S + 1, step_s, dtype=np.int64)


def concat(rows: list[dict]) -> dict:
    return {k: np.concatenate([r[k] for r in rows]) for k in rows[0]}


def leak_arrays(f: dict):
    """THE PLANTED LEAK: the model is told the settlement proxy. Direction is its sign and the probability is certainty."""
    side = np.where(f["leak_a_end"] >= f["A0"], 1, -1)
    return side, np.full(len(side), 0.9999)


def configs():
    """Every configuration of the pre-registered grid: the Brownian-edge BASELINE (no momentum gate) and the momentum family. -> list of dicts."""
    out = []
    for th in THETAS:
        out.append(dict(name=f"baseline|th{th:g}", family="baseline", map="brownian", zmin=None, L=None, theta=th))
    for mp in MAPS:
        for zm in Z_MINS:
            for L in LB:
                for th in THETAS:
                    out.append(dict(name=f"{mp}|z{zm:g}|L{L}|th{th:g}", family="momentum", map=mp, zmin=zm, L=L, theta=th))
    for i, c in enumerate(out):
        c["id"] = i
    return out


def config_arrays(f: dict, maps: dict, cfgs: list[dict], leak: bool = False):
    """Per configuration: (side [n] or None for the baseline, P [n], trigger mask [n]); the T_min clock is applied by `simulate_window`.
    -> (list, P(Up) of the baseline)."""
    pu = p_up_brownian(f)
    out = []
    for c in cfgs:
        if leak:
            side, ps = leak_arrays(f)
            out.append((side, ps, np.ones(len(side), bool)))
        elif c["family"] == "baseline":
            out.append((None, pu, None))
        else:
            out.append((side_of(f), maps[c["map"]][c["L"]], (np.abs(f["z"]) >= c["zmin"]) & agree(f, c["L"])))
    return out, pu


# =============================================================== the Polymarket book of one window
class Book:
    """The Up token's ladder states of one window as arrays (from `book_states`), with the Down side derived by the venue's mirror: a Down
    ask at 1 - p for each Up bid at p, same size. Row i is the book after event i; `at(t)` is the last row with ts <= t."""

    def __init__(self, st: dict):
        self.ts = np.asarray(st["ts"], dtype=np.int64)
        self.bid_px, self.bid_sz = np.asarray(st["bid_px"]), np.asarray(st["bid_sz"])
        self.ask_px, self.ask_sz = np.asarray(st["ask_px"]), np.asarray(st["ask_sz"])
        self.best_bid = np.asarray(st["best_bid"])
        self.best_ask = np.asarray(st["best_ask"])
        self.tick = np.asarray(st.get("tick", np.full(len(self.ts), np.nan)))
        self.meta = st.get("meta", {})

    def at(self, t):
        return M.asof_idx(self.ts, t)

    def up_ask(self, i):
        return np.where(i >= 0, self.best_ask[np.maximum(i, 0)], np.nan)

    def dn_ask(self, i):
        return np.where(i >= 0, np.round(1.0 - self.best_bid[np.maximum(i, 0)], 4), np.nan)

    def mid(self, i):
        j = np.maximum(i, 0)
        return np.where(i >= 0, (self.best_bid[j] + self.best_ask[j]) / 2.0, np.nan)

    def ladder(self, i: int, side: int):
        """Ask ladder of the token we BUY at row i: side +1 Up (the asks), -1 Down (the Up bids mirrored). Best first, NaN padded."""
        if side > 0:
            return self.ask_px[i], self.ask_sz[i]
        return np.round(1.0 - self.bid_px[i], 4), self.bid_sz[i]


def walk(px, sz, usd: float, rate: float, exponent: float, limit: float | None):
    """Take up to `usd` from the ask ladder, best level first, never above `limit` (an IOC order at the signal ask). Shares are whole cents of a
    share. -> dict(shares, cost, fee, vwap, levels, partial); shares 0 when under the venue minimum of 5."""
    shares = cost = fee = 0.0
    left = usd
    lv = 0
    for p, s in zip(px, sz):
        if not (p == p) or not (s == s) or s <= 0 or left < 0.01:
            break
        if limit is not None and p > limit + 1e-9:
            break
        take = min(s, np.floor(left / p * 100.0) / 100.0)
        if take <= 0:
            break
        shares += take
        cost += take * p
        fee += SIM.fee_usd(take, p, rate, exponent)
        left -= take * p
        lv += 1
    if shares < MIN_SHARES:
        return dict(shares=0.0, cost=0.0, fee=0.0, vwap=np.nan, levels=lv, partial=True)
    return dict(shares=shares, cost=cost, fee=fee, vwap=cost / shares, levels=lv, partial=bool(left > 0.05))


# =============================================================== one window, many configurations
def edge_vec(p, ask, rate, exponent):
    with np.errstate(invalid="ignore"):
        return np.where(np.isfinite(ask), p - ask - rate * (ask * (1.0 - ask)) ** exponent, -np.inf)


def simulate_window(t, cfgs: list[dict], arrays: list, book: Book, mk: dict, up_won: bool, lats=(LATENCY_MS,), lat_extra_ms=0, ask_lags=(250, 1000)):
    """Run every configuration over one window's events `t`. The decision at t reads the book row with ts <= t (+ lat_extra_ms, the planted clock shift);
    the order reaches the book at t + latency and fills what the row with ts <= t + latency offers at or below the signal ask, for CLIP_USD; one entry per
    window (the first trigger that fills), later triggers are tried when an earlier one found the ask gone or too thin. A configuration is an `arrays` entry
    (side, P(side wins), mask): side None means the baseline, which takes the side of the larger edge after fee. The outcome is read only in `settle`,
    after the position is fixed. -> one dict per (configuration, latency): status, counts and the entry fields."""
    rate, expo = mk["fee_rate"], mk["fee_exponent"]
    t_dec = t + int(lat_extra_ms)
    allowed = (mk["end_ms"] - t) >= TMIN_S * 1000
    i_t = book.at(t_dec)
    au, ad = book.up_ask(i_t), book.dn_ask(i_t)
    mid0 = book.mid(i_t)
    out = []
    fi_by_lat = {lat: book.at(t_dec + lat) for lat in lats}
    for c, (side, ps, mask) in zip(cfgs, arrays):
        if side is None:                                            # the baseline: both sides priced from P(Up), the larger edge wins
            eu, ed = edge_vec(ps, au, rate, expo), edge_vec(1.0 - ps, ad, rate, expo)
            side_c = np.where(eu >= ed, 1, -1)
            edge = np.maximum(eu, ed)
            pside = np.where(side_c > 0, ps, 1.0 - ps)
            msk = np.ones(len(t), bool)
        else:
            side_c, pside, msk = side, ps, mask
            edge = edge_vec(pside, np.where(side_c > 0, au, ad), rate, expo)
        fire = msk & (edge > c["theta"])
        trig = np.flatnonzero(fire & allowed)
        late = bool(np.any(fire & ~allowed))
        for lat in lats:
            i_f = fi_by_lat[lat]
            row = dict(cfg=c["id"], lat=lat, status="no_edge", n_trig=int(len(trig)), n_gone=0, n_empty=0, entry=None, first=None)
            if not len(trig):
                if late:
                    row["status"] = "late"
                out.append(row)
                continue
            gone = empty = 0
            for j in trig[:MAX_TRIES]:
                s = int(side_c[j])
                sig_ask = au[j] if s > 0 else ad[j]
                fi = int(i_f[j])
                if fi < 0:
                    empty += 1
                    continue
                px, sz = book.ladder(fi, s)
                if row["first"] is None:
                    row["first"] = dict(t_ms=int(t_dec[j]), side=s, ask_signal=float(sig_ask), ask_at_fill=float(px[0]) if np.isfinite(px[0]) else float("nan"),
                                        book_age_ms=int(t_dec[j] - book.ts[max(int(i_t[j]), 0)]))
                if not np.isfinite(px[0]) or sz[0] <= 0:
                    empty += 1
                    continue
                fill = walk(px, sz, CLIP_USD, rate, expo, float(sig_ask))
                if fill["shares"] <= 0:
                    if px[0] > sig_ask + 1e-9:
                        gone += 1
                    else:
                        empty += 1
                    continue
                ask_lag = {}
                for L in ask_lags:
                    il = int(book.at(t_dec[j] + L))
                    if il < 0:
                        ask_lag[L] = np.nan
                    else:
                        ask_lag[L] = float(book.up_ask(np.array([il]))[0]) if s > 0 else float(book.dn_ask(np.array([il]))[0])
                gross, net, won = SIM.settle(s, fill, up_won)
                row["entry"] = dict(side=s, t_signal_ms=int(t_dec[j]), t_fill_ms=int(t_dec[j] + lat), ask_signal=float(sig_ask), ask_best_fill=float(px[0]),
                                    vwap=float(fill["vwap"]), shares=float(fill["shares"]), cost=float(fill["cost"]), fee_usd=float(fill["fee"]),
                                    partial=bool(fill["partial"]), levels=int(fill["levels"]), p_model=float(pside[j]), mid_up=float(mid0[j]),
                                    pnl_gross=float(gross), pnl_net=float(net), won=bool(won), j=int(j), book_ts_signal=int(book.ts[max(int(i_t[j]), 0)]), book_ts_fill=int(book.ts[fi]),
                                    book_age_ms=int(t_dec[j] - book.ts[max(int(i_t[j]), 0)]), **{f"ask_{L}ms": ask_lag[L] for L in ask_lags})
                row["status"] = "entered"
                break
            row["n_gone"], row["n_empty"] = gone, empty
            if row["entry"] is None:
                row["status"] = "ask_gone" if gone >= empty and gone > 0 else "no_depth"
            out.append(row)
    return out


# =============================================================== the engine's own checks, each broken once on purpose
def selftest() -> bool:
    ok = True

    def line(label, cond):
        nonlocal ok
        ok &= bool(cond)
        print(f"  {label:<70}{'ok' if cond else 'FAILED'}")

    # the ladder walk: two levels, a limit, the minimum order and the fee on each level
    w = walk(np.array([0.50, 0.52, np.nan]), np.array([10.0, 100.0, 0.0]), 20.0, 0.07, 1.0, 0.52)
    line("walk takes the best level first, then the next, for USD 20", abs(w["cost"] - 20.0) < 0.02 and w["levels"] == 2 and w["shares"] > 38)
    line("walk's fee is the sum of the fee of each level", abs(w["fee"] - (SIM.fee_usd(10.0, 0.50, 0.07) + SIM.fee_usd(w["shares"] - 10.0, 0.52, 0.07))) < 1e-4)
    w1 = walk(np.array([0.50, 0.52]), np.array([10.0, 100.0]), 20.0, 0.07, 1.0, 0.50)
    line("a limit at the signal ask stops the walk at that level (a partial fill)", w1["shares"] == 10.0 and w1["partial"])
    line("under the 5-share minimum nothing fills", walk(np.array([0.5]), np.array([4.0]), 20.0, 0.07, 1.0, 0.5)["shares"] == 0.0)
    line("a limit under the best ask fills nothing", walk(np.array([0.60]), np.array([100.0]), 20.0, 0.07, 1.0, 0.55)["shares"] == 0.0)
    # the book: the last row at or before t, never the next
    st = dict(ts=np.array([100, 200, 300]), bid_px=np.full((3, 2), [[0.4, 0.3]] * 3), bid_sz=np.full((3, 2), 50.0), ask_px=np.array([[0.5, 0.6], [0.5, 0.6], [0.7, 0.8]]), ask_sz=np.full((3, 2), 50.0),
              best_bid=np.array([0.4, 0.4, 0.4]), best_ask=np.array([0.5, 0.5, 0.7]))
    bk = Book(st)
    line("book.at returns the last row at or before t and -1 before the first", list(bk.at(np.array([99, 100, 299, 300, 10_000]))) == [-1, 0, 1, 2, 2])
    # a later row planted AFTER the fill instant must not be used: signal ask 0.5 at t = 150, the order arrives at 250 (row ts 200, ask 0.5), a planted row at 260 has ask 0.7
    st2 = dict(st, ts=np.array([100, 200, 260]))
    t = np.array([150], dtype=np.int64)
    arrs = [(np.array([1]), np.array([0.9]), np.array([True]))]
    r = simulate_window(t, [dict(id=0, theta=0.0, name="x")], arrs, Book(st2), dict(fee_rate=0.07, fee_exponent=1.0, end_ms=1_000_000), True, lats=(100,))
    line("an order fills against the row at or before t + latency, not the later one", r[0]["status"] == "entered" and abs(r[0]["entry"]["vwap"] - 0.5) < 1e-9)
    r2 = simulate_window(t, [dict(id=0, theta=0.0, name="x")], arrs, Book(st2), dict(fee_rate=0.07, fee_exponent=1.0, end_ms=1_000_000), True, lats=(120,))
    line("the same order one step later meets the 0.7 ask above its limit: ask gone", r2[0]["status"] == "ask_gone")
    # the fit: Maps on a synthetic signal where larger |z| wins more
    rng = np.random.default_rng(1)
    n = 4000
    z = rng.normal(0, 1.5, n)
    rows = dict(S=np.exp(z * 1e-3) * 100, A0=np.full(n, 100.0), T=rng.uniform(60, 840, n), t_el=rng.uniform(10, 840, n), sig=np.full(n, 1e-4), z=z,
                r10=np.sign(z) * 1e-4, r30=np.sign(z) * 1e-4, r60=np.sign(z) * 1e-4, known_sum=np.zeros(n))
    y = (rng.random(n) < 1 / (1 + np.exp(-1.2 * np.abs(z)))).astype(float)
    mp = Maps().fit(rows, y)
    pl = mp.predict(rows)["logit"][30]
    line("the logistic map rises with |z| on a synthetic edge", np.corrcoef(np.abs(z), pl)[0, 1] > 0.9)
    # the leak must score absurdly: a model told the end proxy wins every time when scored by the side it names
    f = dict(leak_a_end=np.array([101.0, 99.0]), A0=np.array([100.0, 100.0]))
    side, ps = leak_arrays(f)
    line("the planted leak names the winning side with near certainty", list(side) == [1, -1] and float(ps.min()) > 0.999)
    return ok


if __name__ == "__main__":
    sys.exit(0 if selftest() else 1)
