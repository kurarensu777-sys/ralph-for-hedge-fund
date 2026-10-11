"""The buy-near rule in its live form (B-0684): a rule that sees one second of state at a time, decides an order or an exit, and never sees the future, plus the
replay that runs it over a decision table with the engine's own fill mechanics and the check that it agrees with the vectorized engine to the cent.

WHAT IT IS FOR. `tf15_bt.entries` is the fast form for a grid search: a boolean matrix over (window, second). An execution engine cannot run a matrix; it runs
`Rule.decide(state)` once a second. This module holds the second form and proves the two give the same trades, so a rule found in the grid is the rule that
would run. It proves the rule's LOGIC and the engine's fill/settle arithmetic are the same code path; it does not prove the fills a venue would give (the
table's ladder as of t + fill_ms is the fill; the delay convention is the owner's: 250 ms = the venue's 150 ms taker hold + 100 ms of our own tick-to-trade).

THE SECOND OF STATE. Decision second k of a window is second K0 + k after its start (K0 = 5; k = 0..890; seconds left T = 895 - k). `State` holds what a live
engine knows at that instant: the Binance trade-implied mid, the 10/30/60 s burst z's, the level z, the vol, the driftless fair P(Up), both tokens' best bid and
ask and sizes as the trader saw them at t, the seconds left, the coin, the window's start ms, the fee rate, and `history`, the 1 s Binance mid up to and including
now (path index 60 + K0 + k; the table's S at k IS that element). It holds neither the ladder as of t + fill_ms (that is the fill, the replay's business) nor the
venue's resolution. The Down token is the venue's mirror of the Up book: its ask is 1 - the Up bid (same size), its bid 1 - the Up ask, computed in the table's
float32 so a limit equals the fill ladder's price at the same level.
THE FILL. An order decided at second k meets the ask ladder as of t + fill_ms (the table's column k), best level first, never above its limit, for its USD; under
5 shares no fill and the rule keeps deciding; one position a window. An exit decided at second j > k sells into the near token's bid ladder at column j; what
the ladder does not take is held to expiry (or, with `retry_exit`, offered again next second). Fees are the market's own, rate x p x (1 - p), both ways.
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field

import numpy as np

import tf15_bt as B

COINS = ("BTC", "ETH", "SOL", "XRP")
PATH_PRE = 60                      # the path starts this many seconds before the window's start
EV_FIRST_S = 5                     # the first Binance event of a window is stamped at 5000 ms or later (`tf15_signals.EV_FIRST_S`)
LAST_T = float(B.K0)              # the last decision second is this many seconds before the end (K1 = 895): a timed exit needs its sale second to exist


# ============================================================ the signals, from a State's own arrays
def rsi_last(history, n: int = 14) -> float:
    """Wilder's RSI at the LAST point of `history` (the 1 s Binance mid from 60 s before the start to now), the arithmetic of `tf15_signals.rsi_path` step by step: the
    first n changes seed the averages (simple mean), then avg = (avg x (n - 1) + change) / n, RSI = 100 x gain / (gain + loss), NaN when both are zero; the value is
    cast to float32 as the table's signal is. Same float64 operations in the same order, so it should equal the vectorized value bit for bit (the selftest compares
    them on real data); a flat path or fewer than n changes gives NaN, not 50."""
    x = np.asarray(history).astype(np.float64)
    if len(x) <= n:
        return float("nan")
    d = np.diff(x)
    g, l_ = np.maximum(d, 0.0), np.maximum(-d, 0.0)
    ag, al = float(g[:n].mean()), float(l_[:n].mean())
    gl, ll = g.tolist(), l_.tolist()
    for i in range(n, len(x) - 1):
        ag = (ag * (n - 1) + gl[i]) / n
        al = (al * (n - 1) + ll[i]) / n
    tot = ag + al
    return float(np.float32(100.0 * ag / tot)) if tot > 0 else float("nan")


def intensity_z_last(ev_cum, win_s: int = 10, min_prior: int = 30) -> float:
    """The Binance event count of the last `win_s` seconds at the LAST second of `ev_cum` (the cumulative count of events visible by each whole second 0..now), as a z
    against the mean and sample sd of the same count at the decision seconds strictly before it (NaN skipped), the arithmetic of `tf15_signals.intensity_z`: cumulative
    sums minus the current term, n - 1 in the variance, NaN until `min_prior` earlier counts exist or when the sd is zero. A count window that starts before second 4
    is NaN, as there. The selftest compares it with the vectorized signal on real data."""
    cum = np.asarray(ev_cum, np.float64)
    j = np.arange(len(cum) - B.K0)                    # decision columns 0..k
    s = B.K0 + j
    lo = s - win_s
    ok_lo = lo >= EV_FIRST_S - 1
    x = np.full(len(j), np.nan, np.float32)
    x[ok_lo] = (cum[s[ok_lo]] - cum[lo[ok_lo]]).astype(np.float32)
    ok = np.isfinite(x)
    c0 = np.where(ok, x, 0.0).astype(np.float64)
    n = np.cumsum(ok) - ok
    s1 = np.cumsum(c0) - c0
    s2 = np.cumsum(c0 * c0) - c0 * c0
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = s1 / n
        var = (s2 - n * mean * mean) / (n - 1)
    if not (n[-1] >= max(min_prior, 2)) or not ok[-1]:
        return float("nan")
    sd = float(np.sqrt(np.maximum(var[-1], 0.0)))
    if not (sd > 0):
        return float("nan")
    return float(np.float32((np.float64(x[-1]) - mean[-1]) / sd))


def retrace_last(history, zl10_hist, L: int = 10, z_min: float = 4.0) -> float:
    """How much of the last burst's move the mid has given back, at the LAST point of `history`, the arithmetic of `tf15_signals.retrace`: the last burst is the latest
    second b with |zl10| >= z_min (from `zl10_hist`, decision seconds 0..now); M = d x ln(P_b / P_(b - L)), G = d x ln(P_b / P_now), d the sign of zl10 at b; the share
    is G / M where M > 0, else NaN (also NaN before the first burst). d is the sign of the last BURST, not of any position. It sees the Binance mid only."""
    z = np.asarray(zl10_hist)
    with np.errstate(invalid="ignore"):
        idx = np.flatnonzero(np.abs(z) >= z_min)
    if len(idx) == 0:
        return float("nan")
    b = int(idx[-1])
    pb_i = PATH_PRE + B.K0 + b
    Pb, P0, Pn = np.float64(history[pb_i]), np.float64(history[pb_i - L]), np.float64(history[-1])
    d = np.sign(np.float64(z[b]))
    lg = np.log(np.array([Pb / P0, Pb / Pn]))
    M, G = d * lg[0], d * lg[1]
    return float(np.float32(G / M)) if M > 0 else float("nan")


# ============================================================ the state a live engine holds
@dataclass(slots=True)
class State:
    """One second of one window, as a live engine would hold it. Prices of the Up token are `up_*`, of the Down token `dn_*` (the mirror, float32 arithmetic).
    `zl10/30/60` are the burst z over 10/30/60 s; `z` is the move since the window's start in vol units; `pu` the driftless Brownian P(Up); `history` the 1 s Binance
    mid from 60 s before the start to now (read-only view); `zl10_hist` the 10 s burst z of decision seconds 0..now; `ev_cum` the count of Binance trade events visible by
    each whole second 0..now (an event stamped e ms is visible from second ceil(e / 1000)); `up_ask_hist` / `up_bid_hist` the Up token's best ask and bid of decision
    seconds 0..now (float32). The signal methods (`rsi`, `intensity_z`, `retrace`, `spread_c`, `imbalance`)
    read only these. Proves nothing about the future: it cannot hold any, see `check_causal`."""
    k: int
    sec: int
    t_left: float
    asset: int
    coin: str
    start_ms: int
    fee_rate: float
    S: float
    z: float
    sig: float
    pu: float
    zl10: float
    zl30: float
    zl60: float
    up_bid: float
    up_ask: float
    up_bid_sz: float
    up_ask_sz: float
    dn_bid: float
    dn_ask: float
    dn_bid_sz: float
    dn_ask_sz: float
    age_ms: int
    history: np.ndarray = field(repr=False)
    zl10_hist: np.ndarray = field(repr=False)
    ev_cum: np.ndarray = field(repr=False)
    up_ask_hist: np.ndarray = field(repr=False)
    up_bid_hist: np.ndarray = field(repr=False)

    def burst(self, L: int) -> float:
        """The L-second burst z (L in 10, 30, 60)."""
        return self.zl10 if L == 10 else self.zl30 if L == 30 else self.zl60 if L == 60 else _bad_L(L)

    def ask(self, side: int) -> float:
        """The best ask of the token `side` (+1 Up, -1 Down)."""
        return self.up_ask if side > 0 else self.dn_ask

    def bid(self, side: int) -> float:
        """The best bid of the token `side`: the mark of a position on that token."""
        return self.up_bid if side > 0 else self.dn_bid

    def fair(self, side: int) -> float:
        """The driftless fair value of the token `side`."""
        return self.pu if side > 0 else 1.0 - self.pu

    def ask_still(self, side: int, n: int) -> bool:
        """True when the best ask of the token `side` now equals its best ask `n` seconds ago (False in the first n seconds and when it is empty), from `up_ask_hist` /
        `up_bid_hist`. The Down ask is 1 - the Up bid, so for Down it is the Up bid that must be unchanged. Compared at the table's float32."""
        h = self.up_ask_hist if side > 0 else self.up_bid_hist
        if len(h) <= n:
            return False
        a = h[-1]
        return bool(np.isfinite(a) and a == h[-1 - n])

    def spread_c(self) -> float:
        """The Up token's best ask minus best bid in cents, at the table's float32 (NaN when a side is empty; negative when the book is crossed)."""
        return float(np.float32(100.0 * (self.up_ask - self.up_bid)))

    def imbalance(self) -> float:
        """Top-of-book size imbalance of the Up token, (bid size - ask size) / (bid size + ask size), float32; NaN when a side is missing or both are zero."""
        a, b = self.up_bid_sz, self.up_ask_sz
        tot = a + b
        return float(np.float32((a - b) / tot)) if tot > 0 else float("nan")

    def rsi(self, n: int = 14) -> float:
        """Wilder's RSI(n, 1 s) of the Binance mid, from `history` (see `rsi_last`)."""
        return rsi_last(self.history, n)

    def intensity_z(self, win_s: int = 10, min_prior: int = 30) -> float:
        """The Binance trade-event count of the last `win_s` seconds as a z against the window's own earlier counts, from `ev_cum` (see `intensity_z_last`)."""
        return intensity_z_last(self.ev_cum, win_s, min_prior)

    def retrace(self, L: int = 10, z_min: float = 4.0) -> float:
        """The share of the last burst's move the mid has given back, from `history` and `zl10_hist` (see `retrace_last`)."""
        return retrace_last(self.history, self.zl10_hist, L, z_min)


def _bad_L(L):
    raise ValueError(f"burst length {L} s is not in the table (10, 30, 60)")


@dataclass(frozen=True, slots=True)
class Order:
    """Buy `usd` of the token `side` (+1 Up, -1 Down), taking asks no higher than `limit`."""
    side: int
    usd: float
    limit: float
    tag: str = ""


@dataclass(frozen=True, slots=True)
class Exit:
    """Sell the whole position now into the bids; `limit` is a floor on the price (None: sell what the book gives); `reason` names the condition."""
    reason: str
    limit: float | None = None


@dataclass(slots=True)
class Position:
    """What the engine holds after the buy fills: `shares` still held, `price` paid a share (cost / shares), the entry second, the cost and the entry fee."""
    side: int
    shares: float
    price: float
    k: int
    cost: float
    fee: float
    shares0: float = 0.0
    sold: float = 0.0
    proceeds: float = 0.0
    exit_fee: float = 0.0
    ke: int = -1
    reason: str = "expiry"


class Feed:
    """The state of ONE window second by second: the table's columns for that window as Python lists, `state(k)` builds the State of second k from index k and
    below only. This is the single code path for the replay and for `state_at`, so what the selftest proves about the one holds for the other."""

    def __init__(self, tab: B.Tab, w: int):
        self.w = int(w)
        f32 = np.float32
        g = lambda a: a[w].tolist()                      # noqa: E731  (float32 -> exact Python float)
        self.S, self.z, self.sig, self.pu = g(tab.S), g(tab.z), g(tab.sig), g(tab.pu)
        zl = tab.zl[w]
        self.zl10, self.zl30, self.zl60 = zl[:, 0].tolist(), zl[:, 1].tolist(), zl[:, 2].tolist()
        qb, qa = tab.qb[w], tab.qa[w]
        self.qb, self.qa, self.qbs, self.qas = qb.tolist(), qa.tolist(), tab.qbs[w].tolist(), tab.qas[w].tolist()
        self.dn_ask = (f32(1.0) - qb).tolist()           # the Down ask = 1 - the Up bid, in the table's float32
        self.dn_bid = (f32(1.0) - qa).tolist()
        self.age = tab.age[w].tolist()
        self.path = tab.path[w].copy()
        self.path.flags.writeable = False
        self.z10 = zl[:, 0].copy()
        self.z10.flags.writeable = False
        e0, e1 = int(tab.e_off[w]), int(tab.e_off[w + 1])
        sec = np.clip(-((-tab.e_t[e0:e1].astype(np.int64)) // 1000), 0, 900)
        self.cum = np.cumsum(np.bincount(sec, minlength=901).astype(np.float64))
        self.cum.flags.writeable = False
        self.qa_arr, self.qb_arr = tab.qa[w].copy(), tab.qb[w].copy()
        self.qa_arr.flags.writeable = False
        self.qb_arr.flags.writeable = False
        self.asset, self.start_ms, self.rate = int(tab.w_asset[w]), int(tab.w_start[w]), float(tab.w_fee[w])
        self.coin = COINS[self.asset]
        self.NK = tab.NK

    def state(self, k: int) -> State:
        n = PATH_PRE + B.K0 + k + 1
        return State(k=k, sec=B.K0 + k, t_left=float(B.WIN_S - (B.K0 + k)), asset=self.asset, coin=self.coin, start_ms=self.start_ms, fee_rate=self.rate,
                     S=self.S[k], z=self.z[k], sig=self.sig[k], pu=self.pu[k], zl10=self.zl10[k], zl30=self.zl30[k], zl60=self.zl60[k],
                     up_bid=self.qb[k], up_ask=self.qa[k], up_bid_sz=self.qbs[k], up_ask_sz=self.qas[k],
                     dn_bid=self.dn_bid[k], dn_ask=self.dn_ask[k], dn_bid_sz=self.qas[k], dn_ask_sz=self.qbs[k], age_ms=self.age[k],
                     history=self.path[:n], zl10_hist=self.z10[:k + 1], ev_cum=self.cum[:B.K0 + k + 1],
                     up_ask_hist=self.qa_arr[:k + 1], up_bid_hist=self.qb_arr[:k + 1])


def state_at(tab: B.Tab, w: int, k: int) -> State:
    """The State of window `w` at decision second `k`. Proves the view is built from index k and below (`check_causal` scrambles the rest); says nothing about
    whether the table's own columns were built causally (that is the table's law, `tf15_table`)."""
    return Feed(tab, w).state(k)


# ============================================================ exits, as plug-ins
class ExitCond:
    """One exit condition: `check(state, position) -> reason or None`. The names and parameters follow the vectorized builders of `tf15_exits` (reversal, bid_stop,
    take_profit) and the engine's `hold`; each reads only the State and the Position."""
    kind = ""
    label = None                      # the reason a firing exit reports; None: the kind's own name (the layered grid names its exits tp95, lvl30, retrace50)

    def check(self, s: State, pos: Position):
        raise NotImplementedError

    def spec(self) -> dict:
        raise NotImplementedError

    def room(self) -> float:
        """Seconds the entry needs before the last decision second so that this exit can happen (the engine's `hold` convention); 0 when none."""
        return 0.0

    def words(self) -> str:
        raise NotImplementedError


class TimeExit(ExitCond):
    """Sell `hold_s` seconds after the entry second (the engine's `hold=h`). An entry whose sale second would fall after the last decision second is not made, as the engine does not make it."""
    kind = "time"

    def __init__(self, hold_s: int):
        self.hold_s = int(hold_s)

    def check(self, s, pos):
        return "time" if s.k - pos.k >= self.hold_s else None

    def spec(self):
        return dict(kind=self.kind, hold_s=self.hold_s)

    def room(self):
        return float(self.hold_s) + LAST_T

    def words(self):
        return f"sells everything {self.hold_s} seconds after the buy"


class Reversal(ExitCond):
    """The `L`-second burst z turns against the position by at least `z_back` (long Up: z <= -z_back; long Down: z >= +z_back). The z is rounded to 5 places before the
    comparison, as `tf15_exits.reversal` does, so a z a float32 hair short of the threshold counts as on it."""
    kind = "reversal"

    def __init__(self, z_back: float = 2.0, L: int = 10):
        self.z_back, self.L = float(z_back), int(L)

    def check(self, s, pos):
        return "reversal" if round(s.burst(self.L) * pos.side, 5) <= -self.z_back else None

    def spec(self):
        return dict(kind=self.kind, z_back=self.z_back, L=self.L)

    def words(self):
        return f"leaves when the {self.L}-second Binance burst turns against the position by {self.z_back:g} vol units"


class BidStop(ExitCond):
    """The near token's bid, on the cent grid (4 places), falls below the price paid minus `drop` (strict; the threshold rounded to 6 places), as `tf15_exits.bid_stop`
    does: a float32 bid of 0.64 is not under a 0.64 threshold. Found by the cross-check against `tf15_exits`: compared raw, it fired on float noise 56 times in 387."""
    kind = "bid_stop"

    def __init__(self, drop: float = 0.10):
        self.drop = float(drop)

    def check(self, s, pos):
        return "bid_stop" if round(s.bid(pos.side), 4) < round(pos.price - self.drop, 6) else None

    def spec(self):
        return dict(kind=self.kind, drop=self.drop)

    def words(self):
        return f"leaves when the token's bid falls more than {self.drop * 100:g} cents under the price paid"


class TakeProfit(ExitCond):
    """The near token's bid, on the cent grid (4 places), reaches `level`."""
    kind = "take_profit"

    def __init__(self, level: float = 0.95):
        self.level = float(level)

    def check(self, s, pos):
        return (self.label or "take_profit") if round(s.bid(pos.side), 4) >= self.level - 1e-9 else None

    def spec(self):
        return dict(kind=self.kind, level=self.level)

    def words(self):
        return f"takes the profit when the token's bid reaches {self.level * 100:g} cents"


class LevelStop(ExitCond):
    """The near token's bid, on the cent grid (4 places), is under `floor` (`tf15_exits.level_stop`)."""
    kind = "level_stop"

    def __init__(self, floor: float = 0.30):
        self.floor = float(floor)

    def check(self, s, pos):
        return (self.label or "level_stop") if round(s.bid(pos.side), 4) < self.floor else None

    def spec(self):
        return dict(kind=self.kind, floor=self.floor)

    def words(self):
        return f"leaves when the token's bid falls under {self.floor * 100:g} cents"


class Retrace(ExitCond):
    """The Binance mid has given back at least `share` of the last 10 s burst's move (`State.retrace`, the definition of `tf15_signals.retrace(tab, L, z_min)`; a NaN
    share, before any burst, never fires). The burst that counts is the latest one, which may be in the other direction from the position."""
    kind = "retrace"

    def __init__(self, share: float = 0.5, L: int = 10, z_min: float = 4.0):
        self.share, self.L, self.z_min = float(share), int(L), float(z_min)

    def check(self, s, pos):
        r = s.retrace(self.L, self.z_min)
        return (self.label or "retrace") if r >= self.share else None             # NaN >= share is False, as nan_to_num(nan, 0) >= share is for any share above 0

    def spec(self):
        return dict(kind=self.kind, share=self.share, L=self.L, z_min=self.z_min)

    def words(self):
        return f"leaves when the Binance mid has given back {self.share * 100:g}% of the last {self.L}-second burst's move"


EXIT_KINDS = {c.kind: c for c in (TimeExit, Reversal, BidStop, TakeProfit, LevelStop, Retrace)}


def exit_from_spec(d: dict) -> ExitCond:
    d = dict(d)
    label = d.pop("label", None)
    x = EXIT_KINDS[d.pop("kind")](**d)
    x.label = label
    return x


def _exit_spec(x: ExitCond) -> dict:
    return dict(x.spec(), **({"label": x.label} if x.label else {}))


# ============================================================ the rule
class Rule:
    """A live rule: `decide(state) -> Order | None` while flat, `manage(state, position) -> Exit | None` while holding. Both see only the State (and the Position).
    A rule must not keep state between windows; `replay` calls it for one window at a time but does not reset it."""

    def decide(self, s: State):
        raise NotImplementedError

    def manage(self, s: State, pos: Position):
        raise NotImplementedError


class BuyNearRule(Rule):
    """The um-014 cell as a live rule. Watches the `L`-second Binance burst z of the coin. After a burst of at least `z_min` in absolute value, the NEAR token (Up after
    a rise, Down after a fall) is bought when its ask sits more than `theta` under its driftless fair value, the ask is inside `band`, and at least `t_min` seconds
    are left. The order pays at most the ask it saw. `exits` is a tuple of ExitCond; empty holds to expiry.
    Proves nothing about profit; `tf15_live.agree` proves it makes the same trades as `tf15_cands.BuyNearDeep` at the same cell."""

    def __init__(self, L: int = 10, z_min: float = 4.0, theta: float = 0.08, band=(0.40, 0.85), t_min: float = 120, exits=(), usd: float = B.CLIP_USD):
        self.L, self.z_min, self.theta = int(L), float(z_min), float(theta)
        self.band = (float(band[0]), float(band[1]))
        self.t_min, self.usd = float(t_min), float(usd)
        self.exits = tuple(exits)
        self._z = float(np.float32(self.z_min))           # the table is float32: the threshold is compared at the table's precision
        self._room = max([x.room() for x in self.exits] + [0.0])
        if self.L not in (10, 30, 60):
            _bad_L(self.L)

    def _gate(self, s: State):
        """The base gate: -> (side, ask, q) with q the ask on the cent grid, or None."""
        t = s.t_left
        if t < self.t_min or t > B.WIN_S or t < self._room:
            return None
        z = s.burst(self.L)
        if z >= self._z:
            side = 1
        elif z <= -self._z:
            side = -1
        else:
            return None
        ask = s.ask(side)
        q = float(np.round(ask, 4))                         # the gate reads the quote on the cent grid, the limit keeps the table's own float
        lo, hi = self.band
        if q < s.fair(side) - self.theta and lo <= q <= hi:
            return side, ask, q
        return None

    def _filter_words(self) -> str:
        return ""

    def decide(self, s: State):
        g = self._gate(s)
        return None if g is None else Order(g[0], self.usd, g[1], "buy_near")

    def manage(self, s: State, pos: Position):
        for x in self.exits:
            r = x.check(s, pos)
            if r:
                return Exit(r)
        return None


def _labelled(x, label):
    x.label = label
    return x


LAYER_EXIT_PARTS = {"tp95": lambda: _labelled(TakeProfit(0.95), "tp95"), "lvl30": lambda: _labelled(LevelStop(0.30), "lvl30"),
                    "retrace50": lambda: _labelled(Retrace(0.5, 10, 4.0), "retrace50")}


class LayeredRule(BuyNearRule):
    """The base cell with the filters and exits of `tf15_cands.BuyNearLayered`, decided from the State exactly as its `triggers` and `_exit` do. After the base gate:
    `time` None, (lo, hi) (seconds left in [lo, hi)) or "not" (not in [300, 600)); `hour` None or (lo, hi) (no entry when the UTC hour of the window start is in [lo, hi));
    `spread` None or a cap in cents (the Up spread, a crossed or empty book excluded); `gap` None or a cap on fair value minus the ask; `rsi` None or ("le"/"ge", v) on the
    RSI(14, 1 s) in the burst's direction (100 - RSI for a Down entry); `level` None, ("abs", v) |z| <= v, or ("with", v) z x side > v; `flow` None, ("iz", v) the Binance
    event-count z (10 s) >= v, or ("imb", v) the Up top-of-book imbalance x side >= v. `exits` as in BuyNearRule, tried in order; unlike a timed exit they may act
    from the second after the entry to the second before the last decision second (`BuyNearLayered._exit` uses `tf15_exits.exit_second(through_last=False)`).
    `stale_s` n > 0 adds test E's condition (`tf15_cands.ask_still`): the near token's ask equals its ask n seconds ago (Up: the Up ask; Down: the Up bid), never in the
    first n seconds. `coin`, `onset` and `slot_one` mirror `BuyNearSteady`; with `onset` False it retries at every second, as `tf15_bt.entries` does.
    Proves nothing about profit; `agree` against `BuyNearLayered().run` proves the decisions."""
    SPEC_KIND = "buy_near_layered"

    def __init__(self, L=10, z_min=4.0, theta=0.08, band=(0.40, 0.85), t_min=120, time=None, hour=None, spread=None, gap=None, rsi=None, level=None, flow=None,
                 exits=(), usd=B.CLIP_USD, name="", coin=None, onset=False, slot_one=False, stale_s=0):
        super().__init__(L, z_min, theta, band, t_min, exits, usd)
        self.coin = None if coin is None else int(coin)
        self.onset, self.slot_one = bool(onset), bool(slot_one)
        self.stale_s = int(stale_s)
        self._memo = {}
        self.time = time if time in (None, "not") else (float(time[0]), float(time[1]))
        self.hour = None if hour is None else (int(hour[0]), int(hour[1]))
        self.spread = None if spread is None else float(spread)
        self.gap = None if gap is None else float(gap)
        self.rsi = None if rsi is None else (str(rsi[0]), float(rsi[1]))
        self.level = None if level is None else (str(level[0]), float(level[1]))
        self.flow = None if flow is None else (str(flow[0]), float(flow[1]))
        self.name = str(name)
        for nm, v, ok in (("rsi", self.rsi, ("le", "ge")), ("level", self.level, ("abs", "with")), ("flow", self.flow, ("iz", "imb"))):
            if v is not None and v[0] not in ok:
                raise ValueError(f"{nm} filter {v[0]!r} is not one of {ok}")

    @classmethod
    def from_cfg(cls, cfg: dict) -> "LayeredRule":
        """A rule from a grid cell of `tf15_cands.BuyNearLayered().grid()` (keys tl, hr, sp, gp, rs, lv, fl, exit and the base L, z_min, theta, band, t_min): the
        level dicts of that module give each filter's value, so the rule is the cell and nothing typed here. A cell of `BuyNearSteady` (it has a `slot` key) also sets
        the coin cut (`STEADY_COIN`), `onset` (one order per onset of the condition; `BuyNearSteady` always does) and `slot_one` (`STEADY_SLOT`)."""
        import tf15_cands as C
        steady = dict(coin=C.STEADY_COIN[cfg["coin"]], onset=True, slot_one=C.STEADY_SLOT[cfg["slot"]]) if "slot" in cfg else {}
        return cls(**steady,L=cfg["L"], z_min=cfg["z_min"], theta=cfg["theta"], band=C.PX_BAND[cfg["band"]], t_min=cfg["t_min"], time=C.TIME[cfg["tl"]], hour=C.HOUR[cfg["hr"]],
                   spread=C.SPREAD[cfg["sp"]], gap=C.GAP[cfg["gp"]], rsi=C.RSI[cfg["rs"]], level=C.LEVEL[cfg["lv"]], flow=C.FLOW[cfg["fl"]],
                   exits=[LAYER_EXIT_PARTS[p]() for p in cfg["exit"].split("+") if p != "expiry"], name=cfg.get("name", ""))

    def decide(self, s: State):
        """The order, if the conditions hold now (and, with `onset`, did not hold at the previous second of the same window: the rule remembers one boolean a window)."""
        o = self._cond(s)
        if not self.onset:
            return o
        key = (s.start_ms, s.asset)
        last = self._memo.get(key)
        self._memo[key] = (s.k, o is not None)
        if o is not None and last is not None and last[0] == s.k - 1 and last[1]:
            return None
        return o

    def _cond(self, s: State):
        if self.coin is not None and s.asset != self.coin:
            return None
        g = self._gate(s)
        if g is None:
            return None
        side, ask, q = g
        if self.stale_s > 0 and not s.ask_still(side, self.stale_s):
            return None
        T = s.t_left
        t = self.time
        if t == "not":
            if not (T < 300 or T >= 600):
                return None
        elif t is not None and not (t[0] <= T < t[1]):
            return None
        if self.hour is not None and self.hour[0] <= (s.start_ms // 3_600_000) % 24 < self.hour[1]:
            return None
        if self.spread is not None:
            sp = s.spread_c()
            if not (0.0 <= sp <= self.spread):               # a crossed (negative) or empty (NaN) book is out
                return None
        if self.gap is not None and not (s.fair(side) - q <= self.gap):
            return None
        if self.level is not None:
            z = s.z
            if not ((abs(z) <= self.level[1]) if self.level[0] == "abs" else (z * side > self.level[1])):
                return None
        if self.flow is not None and self.flow[0] == "imb" and not (float(np.float32(s.imbalance())) * side >= self.flow[1]):
            return None
        if self.rsi is not None:                                # the dearest signals last
            r = s.rsi()
            rdir = r if side > 0 else float(np.float32(100.0) - np.float32(r))
            if not ((rdir <= self.rsi[1]) if self.rsi[0] == "le" else (rdir >= self.rsi[1])):
                return None
        if self.flow is not None and self.flow[0] == "iz" and not (s.intensity_z() >= self.flow[1]):
            return None
        return Order(side, self.usd, ask, "buy_near_layered")

    def manage(self, s: State, pos: Position):
        if s.t_left <= LAST_T:
            return None
        return super().manage(s, pos)

    def _filter_words(self) -> str:
        w = []
        t = self.time
        if t == "not":
            w.append("not when 300 to 600 seconds are left")
        elif t is not None:
            w.append(f"only with {t[0]:g} to {t[1]:g} seconds left")
        if self.hour is not None:
            w.append(f"not when the window starts between {self.hour[0]:02d}:00 and {self.hour[1]:02d}:00 UTC")
        if self.spread is not None:
            w.append(f"only when the Up token's spread is at most {self.spread:g} cents (a crossed or empty book is out)")
        if self.gap is not None:
            w.append(f"only when fair value is at most {self.gap * 100:g} cents above the ask")
        if self.rsi is not None:
            w.append(f"only when the 14-second RSI of the Binance mid, read in the burst's direction, is {'at most' if self.rsi[0] == 'le' else 'at least'} {self.rsi[1]:g}")
        if self.level is not None:
            w.append(f"only when the window's move from its start is {'at most ' + format(self.level[1], 'g') + ' vol units either way' if self.level[0] == 'abs' else 'with the burst, by more than ' + format(self.level[1], 'g') + ' vol units'}")
        if self.flow is not None:
            w.append("only when the Binance trade count of the last 10 seconds is " + (f"{self.flow[1]:g} or more sd above the window's own average" if self.flow[0] == "iz"
                                                                                         else f"backed by a book imbalance of {self.flow[1]:g} or more toward the burst's token"))
        out = ("It adds filters: it buys " + "; ".join(w) + ".") if w else ""
        extra = []
        if self.stale_s > 0:
            extra.append(f"It buys only when the near token's best ask has not moved for the last {self.stale_s} seconds (never in the first {self.stale_s} seconds).")
        if self.coin is not None:
            extra.append(f"It trades only {COINS[self.coin]}.")
        if self.onset:
            extra.append("It sends an order only at the first second of each run of seconds in which all its conditions hold; a missed fill is not chased.")
        if self.slot_one:
            extra.append("It sends at most one order per 15-minute slot across the four coins: the first coin whose conditions begin to hold takes the slot "
                         "(ties to the lowest coin number, BTC first), and every other window of the slot sends nothing.")
        return " ".join([out] + extra).strip()


# ============================================================ spec and words
SPEC_VERSION = 1


def to_spec(rule: BuyNearRule) -> dict:
    """The rule's parameters as plain JSON-able data: what an execution engine would load. Round-trips through `from_spec` and `json`."""
    d = dict(rule="buy_near", version=SPEC_VERSION, L=rule.L, z_min=rule.z_min, theta=rule.theta, band=list(rule.band), t_min=rule.t_min, usd=rule.usd,
             exits=[_exit_spec(x) for x in rule.exits])
    if isinstance(rule, LayeredRule):
        d.update(rule=rule.SPEC_KIND, name=rule.name, time=rule.time if rule.time in (None, "not") else list(rule.time), hour=None if rule.hour is None else list(rule.hour),
                 spread=rule.spread, gap=rule.gap, rsi=None if rule.rsi is None else list(rule.rsi), level=None if rule.level is None else list(rule.level),
                 flow=None if rule.flow is None else list(rule.flow), coin=rule.coin, onset=rule.onset, slot_one=rule.slot_one, stale_s=rule.stale_s)
    return d


def from_spec(d: dict) -> BuyNearRule:
    kind = d.get("rule")
    if kind not in ("buy_near", LayeredRule.SPEC_KIND) or d.get("version") != SPEC_VERSION:
        raise ValueError(f"not a buy_near spec of version {SPEC_VERSION}: {d.get('rule')!r} v{d.get('version')!r}")
    base = dict(L=d["L"], z_min=d["z_min"], theta=d["theta"], band=tuple(d["band"]), t_min=d["t_min"], usd=d["usd"], exits=[exit_from_spec(x) for x in d["exits"]])
    if kind == "buy_near":
        return BuyNearRule(**base)
    return LayeredRule(**base, name=d.get("name", ""), time=d["time"], hour=d["hour"], spread=d["spread"], gap=d["gap"], rsi=d["rsi"], level=d["level"], flow=d["flow"],
                        coin=d.get("coin"), onset=d.get("onset", False), slot_one=d.get("slot_one", False), stale_s=d.get("stale_s", 0))


def explain(rule: BuyNearRule) -> str:
    """The rule in one paragraph of plain words, built from its parameters (so it cannot drift from them)."""
    lo, hi = rule.band
    ex = "; ".join(x.words() for x in rule.exits)
    fw = (rule._filter_words() + " ") if rule._filter_words() else ""
    pays = "The venue pays 1 USD a share if the token's side wins and 0 otherwise."
    tail = (f"Once in, it {ex}. Anything it still holds at the end is settled by the venue: it pays 1 USD a share if the token's side wins and 0 otherwise."
            if ex else f"Once in, it holds to expiry. {pays}")
    return (f"Every second of each 15-minute Up/Down window it watches the Binance trade-implied mid of the coin and its {rule.L}-second move in vol units. When that move "
            f"is {rule.z_min:g} or more upward it considers the Up token, when it is {rule.z_min:g} or more downward the Down token (the near token, the side the move points to). "
            f"It buys only if the token's best ask is more than {rule.theta * 100:g} cents under its driftless fair value (the Brownian P of ending on that side), the ask is "
            f"between {lo * 100:g} and {hi * 100:g} cents, and at least {rule.t_min:g} seconds are left. It spends {rule.usd:g} USD, taking asks best first and never above the "
            f"ask it saw, and does not trade if fewer than {B.MIN_SHARES:g} shares fill (it then keeps looking); one position a window. {fw}{tail} "
            f"The market's taker fee, rate x p x (1 - p) a share, is paid on each trade.")


# ============================================================ the replay
def _check_fill(tab: B.Tab, fill_ms: int):
    got = {int(m.get("fill_ms", -1)) for m in tab.meta}
    if got != {int(fill_ms)}:
        raise ValueError(f"the table was seated at fill_ms {sorted(got)}, the replay was asked for {fill_ms}: load B.Tab(days, fill_ms={fill_ms})")


def _sell(tab, w, j, pos: Position, rate: float, floor):
    """Sell `pos.shares` into the near token's bids at column j; update the position's books. -> shares sold."""
    px, sz = B.ladder_of(tab, np.array([w]), np.array([j]), np.array([pos.side]), buy=False)
    sold, proceeds, efee = B.walk_sell(px, sz, np.array([pos.shares]), rate, None if floor is None else np.array([floor]))
    pos.sold += float(sold[0])
    pos.proceeds += float(proceeds[0])
    pos.exit_fee += float(efee[0])
    pos.shares -= float(sold[0])
    return float(sold[0])


class _Run:
    """One window's walk, one second at a time: the state machine `replay` drives. `step` returns whether the window's slot is now spent."""

    def __init__(self, tab, w, usd, retry_exit, rows):
        self.tab, self.w, self.usd, self.retry, self.rows = tab, int(w), usd, retry_exit, rows
        self.feed = Feed(tab, w)
        self.rate = np.array([self.feed.rate])
        self.pos = None
        self.done = False

    def step(self, rule, k, spent):
        tab, w, pos = self.tab, self.w, self.pos
        s = self.feed.state(k)
        if pos is None:
            if spent:                                   # the slot has its order: this window sends nothing, now or later
                self.done = True
                return spent
            o = rule.decide(s)
            if o is None:
                return spent
            spent = True                                # an order is SENT here, filled or not; a slot rule counts it
            px, sz = B.ladder_of(tab, np.array([w]), np.array([k]), np.array([o.side]), buy=True)
            shares, cost, fee, best = B.walk_buy(px, sz, o.usd if self.usd is None else self.usd, np.array([o.limit]), self.rate)
            if shares[0] < B.MIN_SHARES:
                return spent
            self.pos = Position(o.side, float(shares[0]), float(cost[0] / shares[0]), k, float(cost[0]), float(fee[0]), shares0=float(shares[0]))
            self.rows.append([w, k, o.side, self.pos, float(best[0])])
            return spent
        if pos.shares <= 1e-9 or (pos.ke >= 0 and not self.retry):
            self.done = True
            return spent
        x = rule.manage(s, pos)
        if x is not None:
            pos.ke, pos.reason = k, x.reason
            _sell(tab, w, k, pos, self.rate, x.limit)
        return spent


def replay(tab: B.Tab, rule: Rule, fill_ms: int, usd: float | None = None, retry_exit: bool = False, order: str = "window", _tie_high_first: bool = False) -> dict:
    """Walk every window second by second from the first decision second: `rule.decide` while flat; an order meets the ask ladder of column k
    (`ladder_of` + `walk_buy`, never above the limit), under 5 shares no fill and the rule keeps deciding; once filled, `rule.manage` each later second, an exit sells
    into the bid ladder of its second (`walk_sell`), what is unsold is held to expiry (`retry_exit` offers it again next second). One position a window. `usd` None
    spends the order's own. The venue's resolution is read only in the last step, to settle.
    A rule with `slot_one` is replayed slot by slot in step with the clock: at each second the slot's windows are visited in asset order (BTC first), the first order SENT
    marks the slot spent, and no window of the slot sends another (a missed fill does not free the slot). That is the engine's rule (earliest trigger second, ties to the
    lowest asset) as a live engine would run it; `_tie_high_first` visits the highest asset first, a planted fault for the selftest.
    -> the dict `tf15_bt.entries` returns (same keys, window order; `order="slot"` re-sorts to (slot, asset)) plus `ke` (the exit second, -1 held to expiry) and
    `exit_reason`. Proves the live logic reproduces an engine; the table must have been seated at `fill_ms`."""
    _check_fill(tab, fill_ms)
    rows = []
    if getattr(rule, "slot_one", False):
        slots, assets = np.asarray(tab.slot), np.asarray(tab.w_asset)
        for sl in np.unique(slots):
            ws = np.flatnonzero(slots == sl)
            ws = ws[np.argsort(assets[ws], kind="stable")]
            if _tie_high_first:
                ws = ws[::-1]
            runs = [_Run(tab, w, usd, retry_exit, rows) for w in ws]
            spent = False
            for k in range(tab.NK):
                for r in runs:
                    if not r.done:
                        spent = r.step(rule, k, spent)
                if all(r.done for r in runs):
                    break
        rows.sort(key=lambda r: r[0])
    else:
        for w in range(tab.W):
            r = _Run(tab, w, usd, retry_exit, rows)
            for k in range(tab.NK):
                r.step(rule, k, False)
                if r.done:
                    break
    return _settle(tab, rows, order)


def _settle(tab, rows, order):
    if not rows:
        e = B._empty()
        e.update(ke=np.zeros(0, int), exit_reason=np.zeros(0, "<U12"))
        return e
    w = np.array([r[0] for r in rows])
    k = np.array([r[1] for r in rows])
    s = np.array([r[2] for r in rows])
    pos = [r[3] for r in rows]
    best = np.array([r[4] for r in rows])
    shares0 = np.array([p.shares0 for p in pos])
    cost = np.array([p.cost for p in pos])
    fee = np.array([p.fee for p in pos])
    rest = np.array([p.shares for p in pos])
    proceeds = np.array([p.proceeds for p in pos])
    efee = np.array([p.exit_fee for p in pos])
    sold = np.array([p.sold for p in pos])
    won = (s > 0) == tab.up[w]                         # the venue's resolution, read here and nowhere earlier
    payoff = proceeds + np.where(won, rest, 0.0)
    net = payoff - cost - fee - efee
    e = dict(w=w, k=k, side=s, shares=shares0, cost=cost, fee=fee + efee, vwap=cost / shares0, best=best, won=won, payoff=payoff, net=net, gross=payoff - cost,
             day=tab.day[w], slot=tab.slot[w], asset=tab.w_asset[w], T=tab.T[k], sold=sold, ke=np.array([p.ke for p in pos]), exit_reason=np.array([p.reason for p in pos]))
    return B.concat(e) if order == "slot" else e


# ============================================================ the agreement
NUM_KEYS = ("shares", "cost", "fee", "net", "payoff", "vwap", "best", "gross", "sold")


def agree(e_vec: dict, e_live: dict, tol: float = 1e-9, verbose: bool = True) -> dict:
    """Compare a vectorized entries dict with a replay's for the same cell: the same (w, k, side) set, and shares, cost, fee, net (and payoff, vwap, best, gross, sold)
    equal to `tol`. -> {ok, n_vec, n_live, only_vec, only_live, max_diff (per key), first_diff (text or None)}. It proves the two agree on the rows given; it proves
    nothing if both are empty, so `n_vec` is in the report and the selftest requires a minimum."""
    key = lambda e: list(zip(np.asarray(e["w"]).tolist(), np.asarray(e["k"]).tolist(), np.asarray(e["side"]).tolist()))      # noqa: E731
    kv, kl = key(e_vec), key(e_live)
    sv, sl = set(kv), set(kl)
    only_v, only_l = sorted(sv - sl), sorted(sl - sv)
    both = sorted(sv & sl)
    iv = {t: i for i, t in enumerate(kv)}
    il = {t: i for i, t in enumerate(kl)}
    a = np.array([iv[t] for t in both], int)
    b = np.array([il[t] for t in both], int)
    max_diff, first = {}, None
    for c in NUM_KEYS:
        if c not in e_vec or c not in e_live:
            continue
        d = np.abs(np.asarray(e_vec[c], float)[a] - np.asarray(e_live[c], float)[b]) if len(both) else np.zeros(0)
        max_diff[c] = float(d.max()) if len(d) else 0.0
        if first is None and len(d) and d.max() > tol:
            j = int(np.argmax(d > tol))
            first = f"{c} differs at (w, k, side) = {both[j]}: vectorized {float(np.asarray(e_vec[c], float)[a[j]])!r}, live {float(np.asarray(e_live[c], float)[b[j]])!r}"
    if first is None and only_v:
        first = f"in the vectorized set only: (w, k, side) = {only_v[0]} ({len(only_v)} such)"
    if first is None and only_l:
        first = f"in the live set only: (w, k, side) = {only_l[0]} ({len(only_l)} such)"
    ok = first is None
    rep = dict(ok=ok, n_vec=len(kv), n_live=len(kl), only_vec=len(only_v), only_live=len(only_l), max_diff=max_diff, first_diff=first)
    if verbose and not ok:
        print(f"  first difference: {first}")
    return rep


# ============================================================ the checks
def _scramble_future(tab: B.Tab, k: int, seed: int = 0) -> B.Tab:
    """A copy of the table whose columns after decision second k are noise, whose path after index 60 + K0 + k is noise, whose Binance events stamped after second 5 + k
    are moved to other later times, and whose outcome is flipped. Only the arrays a State reads are copied."""
    import copy
    t = copy.copy(tab)
    rng = np.random.default_rng(seed)
    for name in ("S", "z", "sig", "pu", "qb", "qa", "qbs", "qas", "age"):
        a = getattr(tab, name).copy()
        a[:, k + 1:] = (rng.random(a[:, k + 1:].shape) * (3 if name != "age" else 1000)).astype(a.dtype)
        setattr(t, name, a)
    zl = tab.zl.copy()
    zl[:, k + 1:] = rng.normal(size=zl[:, k + 1:].shape).astype(zl.dtype) * 5
    t.zl = zl
    p = tab.path.copy()
    p[:, PATH_PRE + B.K0 + k + 1:] = rng.random(p[:, PATH_PRE + B.K0 + k + 1:].shape).astype(p.dtype)
    t.path = p
    thr = 1000 * (B.K0 + k)                                  # Binance events stamped after now move to other later times
    et = tab.e_t.copy()
    late = et > thr
    et[late] = (thr + 1 + rng.integers(0, max(1, 900_000 - thr), size=int(late.sum()))).astype(et.dtype)
    t.e_t = et
    t.up = ~tab.up
    t.w_up = (1 - tab.w_up).astype(tab.w_up.dtype)
    return t


def _same_state(a: State, b: State) -> bool:
    for f in State.__slots__:
        x, y = getattr(a, f), getattr(b, f)
        if isinstance(x, np.ndarray):
            if not np.array_equal(x, y, equal_nan=True):
                return False
        elif not (x == y or (x != x and y != y)):
            return False
    return True


def check_causal(tab: B.Tab, builder=state_at, ks=(0, 7, 120, 450, 890), n_w: int = 40) -> tuple[bool, str]:
    """For each k: build the State of `n_w` windows from the table and from a table whose future (columns after k, path after now) is noise; they must be identical.
    -> (passed, text). A builder that peeks one second ahead fails it (the selftest plants one)."""
    ws = np.linspace(0, tab.W - 1, n_w).astype(int)
    bad = []
    for k in ks:
        sc = _scramble_future(tab, k, seed=k)
        for w in ws:
            if not _same_state(builder(tab, int(w), k), builder(sc, int(w), k)):
                bad.append((int(w), k))
    return (not bad), (f"{len(ws) * len(ks)} states identical under a scrambled future" if not bad else f"{len(bad)} states changed when only the future changed, first (w, k) = {bad[0]}")


def _leaky_hist_state_at(tab, w, k):
    """PLANTED FAULT: the State whose burst history and event count run one second past now (the signals built on them would peek)."""
    f = Feed(tab, w)
    s = f.state(k)
    s.zl10_hist = f.z10[:k + 2]
    s.ev_cum = f.cum[:B.K0 + k + 2]
    s.up_ask_hist, s.up_bid_hist = f.qa_arr[:k + 2], f.qb_arr[:k + 2]
    return s


def _leaky_state_at(tab, w, k):
    """PLANTED FAULT: the State of second k with the Binance mid and the Up ask of second k + 1."""
    f = Feed(tab, w)
    s = f.state(k)
    j = min(k + 1, tab.NK - 1)
    s.S, s.up_ask = f.S[j], f.qa[j]
    return s


class _Lagged(Rule):
    """PLANTED FAULT: decides on the State of the second before (a one-second shift of the signal), fills at the current second."""

    def __init__(self, rule):
        self.rule, self.prev, self.exits = rule, None, rule.exits

    def decide(self, s):
        p = self.prev
        self.prev = s
        if p is None or p.start_ms != s.start_ms or p.asset != s.asset or p.k + 1 != s.k:
            return None
        return self.rule.decide(p)

    def manage(self, s, pos):
        return self.rule.manage(s, pos)


def _vector_exit(tab: B.Tab, e: dict, kind: str, par: float, L: int = 10) -> dict:
    """An independent vectorized form of a plug-in exit, one row of the table at a time: the first second j > k where the condition holds, sold into the bid ladder
    at j, the rest held to expiry. Used only to check `Rule.manage`; it shares `walk_sell` with the replay and nothing else."""
    n = len(e["w"])
    ke = np.full(n, -1)
    for i in range(n):
        w, k, s = int(e["w"][i]), int(e["k"][i]), int(e["side"][i])
        j = np.arange(k + 1, tab.NK)
        if kind == "reversal":
            hit = np.round(s * tab.zl[w, j, {10: 0, 30: 1, 60: 2}[L]].astype(float), 5) <= -par
        else:
            bid = np.round((tab.qb[w, j] if s > 0 else np.float32(1.0) - tab.qa[w, j]).astype(float), 4)
            price = e["cost"][i] / e["shares"][i]
            hit = (bid < round(price - par, 6)) if kind == "bid_stop" else (bid >= par - 1e-9)
        if hit.any():
            ke[i] = int(j[np.argmax(hit)])
    out = {c: np.array(v, float) for c, v in (("sold", np.zeros(n)), ("proceeds", np.zeros(n)), ("efee", np.zeros(n)))}
    for i in np.flatnonzero(ke >= 0):
        w, s = int(e["w"][i]), int(e["side"][i])
        px, sz = B.ladder_of(tab, np.array([w]), np.array([ke[i]]), np.array([s]), buy=False)
        sold, proc, ef = B.walk_sell(px, sz, np.array([e["shares"][i]]), np.array([float(tab.w_fee[w])]))
        out["sold"][i], out["proceeds"][i], out["efee"][i] = sold[0], proc[0], ef[0]
    rest = e["shares"] - out["sold"]
    payoff = out["proceeds"] + np.where(e["won"], rest, 0.0)
    net = payoff - e["cost"] - (e["fee_entry"] + out["efee"])
    return dict(w=e["w"], k=e["k"], side=e["side"], shares=e["shares"], cost=e["cost"], fee=e["fee_entry"] + out["efee"], net=net, payoff=payoff, sold=out["sold"], ke=ke)


def checks(tab: B.Tab | None = None, log=print) -> list[tuple[str, bool]]:
    """Every check as (label, passed). Two real days at 250 ms: `B.Tab(["2026-10-06", "2026-10-07"], fill_ms=250)`."""
    import tf15_cands as C
    out = []

    def rec(label, cond):
        out.append((label, bool(cond)))
        log(f"  {'ok  ' if cond else 'FAIL'} {label}")

    if tab is None:
        tab = B.Tab(["2026-10-06", "2026-10-07"], fill_ms=250)
    log(f"table: {tab.W} windows, {tab.NK} decision seconds, {len(tab.days)} days")

    # ---- state causality
    ok, txt = check_causal(tab)
    rec(f"state causality: {txt}", ok)
    ok_leak, txt_leak = check_causal(tab, builder=_leaky_state_at)
    rec(f"state causality catches a planted one-second peek ({txt_leak})", not ok_leak)
    ok_leak2, txt_leak2 = check_causal(tab, builder=_leaky_hist_state_at)
    rec(f"state causality catches a planted peek in the burst history and the event count ({txt_leak2})", not ok_leak2)
    names = {f for f in State.__slots__}
    rec("the State has no field for the venue's resolution (up, won, payoff, final, ptb) or the fill ladder", not any(t in f for f in names for t in ("up_won", "won", "payoff", "final", "ptb", "lad")))
    s0 = state_at(tab, 3, 100)
    rec("history ends at now: its last element is the State's own S", s0.history[-1] == np.float32(s0.S) and len(s0.history) == PATH_PRE + B.K0 + 100 + 1 and not s0.history.flags.writeable)

    # ---- spec and words
    cells = {
        "um-014 expiry": (dict(name="L10|z4|th0.08|px40-85|T120|expiry", L=10, z_min=4.0, theta=0.08, band="40-85", t_min=120, exit="expiry"), BuyNearRule(10, 4.0, 0.08, (0.40, 0.85), 120)),
        "um-014 300s": (dict(name="L10|z4|th0.08|px40-85|T120|300s", L=10, z_min=4.0, theta=0.08, band="40-85", t_min=120, exit="300s"), BuyNearRule(10, 4.0, 0.08, (0.40, 0.85), 120, exits=(TimeExit(300),))),
        "loose expiry": (dict(name="L10|z2.5|th0.03|pxany|T120|expiry", L=10, z_min=2.5, theta=0.03, band="any", t_min=120, exit="expiry"), BuyNearRule(10, 2.5, 0.03, (0.0, 1.0), 120)),
        "loose 300s": (dict(name="L10|z2.5|th0.03|pxany|T120|300s", L=10, z_min=2.5, theta=0.03, band="any", t_min=120, exit="300s"), BuyNearRule(10, 2.5, 0.03, (0.0, 1.0), 120, exits=(TimeExit(300),))),
    }
    rich = BuyNearRule(10, 4.0, 0.08, (0.40, 0.85), 120, exits=(Reversal(2.0, 10), BidStop(0.10), TakeProfit(0.95), TimeExit(300)))
    for name, rule in [(n, r) for n, (_, r) in cells.items()] + [("rich", rich)]:
        sp = to_spec(rule)
        back = from_spec(json.loads(json.dumps(sp)))
        rec(f"to_spec / from_spec round trip through JSON ({name})", to_spec(back) == sp and explain(back) == explain(rule))
    rec("from_spec refuses a spec of another rule", _raises(lambda: from_spec(dict(to_spec(rich), rule="other"))))
    log("  explain(um-014 chosen cell, 300 s hold): " + explain(cells["um-014 300s"][1]))
    log("  explain(rich): " + explain(rich))

    # ---- agreement with the vectorized engine, and the speed
    ent, speed = {}, {}
    for name, (cfg, rule) in cells.items():
        t0 = time.time()
        e_live = replay(tab, rule, 250)
        speed[name] = time.time() - t0
        e_vec = C.BuyNearDeep().run(tab, cfg, {})
        rep = agree(e_vec, e_live)
        ent[name] = (e_vec, e_live)
        md = max(rep["max_diff"].values()) if rep["max_diff"] else 0.0
        log(f"    {name}: vectorized {rep['n_vec']} entries, live {rep['n_live']}, only-vec {rep['only_vec']}, only-live {rep['only_live']}, max |diff| {md:.2e}, "
            f"net {float(np.sum(e_vec['net'])):+.4f} vs {float(np.sum(e_live['net'])):+.4f}, replay {speed[name]:.1f} s")
        floor_n = 5 if name.startswith("loose") else 1
        rec(f"live replay agrees with the vectorized engine to 1e-9 on {name} ({rep['n_vec']} entries)", rep["ok"] and rep["n_vec"] >= floor_n)
        rec(f"net == payoff - cost - fee on every live row ({name})", np.allclose(e_live["net"], e_live["payoff"] - e_live["cost"] - e_live["fee"], rtol=0, atol=1e-9))
        if name.endswith("300s"):
            rec(f"the 300 s hold really exits ({name}: {int((e_live['ke'] >= 0).sum())} of {len(e_live['ke'])} sold at k + 300)", np.all(e_live["ke"][e_live["ke"] >= 0] - e_live["k"][e_live["ke"] >= 0] == 300) and (e_live["ke"] >= 0).any())

    # ---- a planted one-second shift is caught
    for name in ("um-014 expiry", "loose expiry"):
        _, rule = cells[name]
        e_vec = ent[name][0]
        e_shift = replay(tab, _Lagged(rule), 250)
        rep = agree(e_vec, e_shift, verbose=False)
        log(f"    planted shift on {name}: only-vec {rep['only_vec']}, only-live {rep['only_live']}; first: {rep['first_diff']}")
        rec(f"a planted one-second shift of the signal is caught by agree ({name})", (not rep["ok"]) and rep["n_live"] > 0)
    # the same planted fault must not be caught when the rule is not shifted (agree does not cry wolf): covered by the agreement checks above

    # ---- the outcome is not read before settling
    flipped = _scramble_future(tab, tab.NK - 1)                         # nothing scrambled before the last second, the outcome flipped
    e_a, e_b = ent["loose 300s"][1], replay(flipped, cells["loose 300s"][1], 250)
    rec("flipping every venue resolution changes no decision, fill or exit second, only the settlement",
        np.array_equal(e_a["w"], e_b["w"]) and np.array_equal(e_a["k"], e_b["k"]) and np.array_equal(e_a["ke"], e_b["ke"]) and np.array_equal(e_a["shares"], e_b["shares"])
        and np.array_equal(e_a["won"], ~e_b["won"]) and (e_a["net"] != e_b["net"]).any())

    # ---- the plug-in exits against an independent vectorized form
    e0 = ent["loose expiry"][1]
    base = dict(e0, fee_entry=e0["fee"])
    for rule_exit, kind, par in ((Reversal(1.0, 10), "reversal", 1.0), (Reversal(2.0, 10), "reversal", 2.0), (BidStop(0.05), "bid_stop", 0.05), (BidStop(0.15), "bid_stop", 0.15),
                                 (TakeProfit(0.90), "take_profit", 0.90)):
        r = BuyNearRule(10, 2.5, 0.03, (0.0, 1.0), 120, exits=(rule_exit,))
        e_live = replay(tab, r, 250)
        e_vec = _vector_exit(tab, base, kind, par)
        # the entries are the same rows as the held-to-expiry run (an exit never changes the entry), so compare row by row
        same_rows = np.array_equal(e_live["w"], e0["w"]) and np.array_equal(e_live["k"], e0["k"])
        rep = agree(e_vec, e_live, verbose=False)
        fired = int((e_live["ke"] >= 0).sum())
        log(f"    {kind} {par:g}: {len(e_live['w'])} entries, {fired} exits, net {float(e_live['net'].sum()):+.3f} (held {float(e0['net'].sum()):+.3f}), only-vec {rep['only_vec']}, max |diff| "
            f"{max(rep['max_diff'].values()) if rep['max_diff'] else 0:.1e}")
        rec(f"{kind} {par:g}: the manage loop agrees with an independent vectorized exit ({fired} exits of {len(e_live['w'])})", same_rows and rep["ok"] and fired > 0)
        rec(f"{kind} {par:g}: net == payoff - cost - fee", np.allclose(e_live["net"], e_live["payoff"] - e_live["cost"] - e_live["fee"], rtol=0, atol=1e-9))
    # the same exits through the vectorized `tf15_exits` (first_reason + apply_exit), when that module is there
    try:
        import tf15_exits as X
    except ImportError:
        X = None
        log("    tf15_exits is not importable: the cross-check against it is skipped")
    if X is not None:
        for tag, exits, conds in (("reversal 2 + bid_stop 0.10 + take_profit 0.95", (Reversal(2.0, 10), BidStop(0.10), TakeProfit(0.95)),
                                   dict(reversal=X.reversal(tab, e0, 10, 2.0), bid_stop=X.bid_stop(tab, e0, 0.10), take_profit=X.take_profit(tab, e0, 0.95))),
                                  ("bid_stop 0.05", (BidStop(0.05),), dict(bid_stop=X.bid_stop(tab, e0, 0.05)))):
            e_live = replay(tab, BuyNearRule(10, 2.5, 0.03, (0.0, 1.0), 120, exits=exits), 250)
            ke, why = X.first_reason(tab, e0, conds, through_last=True)
            e_x = X.apply_exit(tab, e0, ke, reason=why)
            rep = agree(e_x, e_live, verbose=False)
            same = np.array_equal(e_x["ke"], e_live["ke"]) and all(str(a).split("|")[0] == str(b) for a, b in zip(e_x["exit_reason"], e_live["exit_reason"]))
            log(f"    {tag}: tf15_exits {int((ke >= 0).sum())} exits, live {int((e_live['ke'] >= 0).sum())}, max |diff| {max(rep['max_diff'].values()):.1e}")
            rec(f"the live exits agree with tf15_exits.first_reason + apply_exit on exit second, reason and net ({tag})", rep["ok"] and same and (ke >= 0).any())
    # and an exit that cannot fire changes nothing (a stop at a drop of 2 USD)
    e_nofire = replay(tab, BuyNearRule(10, 2.5, 0.03, (0.0, 1.0), 120, exits=(BidStop(2.0),)), 250)
    rec("an exit that cannot fire reproduces the held-to-expiry trades exactly", agree(e0, e_nofire, verbose=False)["ok"] and (e_nofire["ke"] == -1).all())

    # ---- the table and the fill delay
    rec("replay refuses a table seated at another delay", _raises(lambda: replay(tab, cells["um-014 expiry"][1], 150)))

    # ---- speed
    t_all = sum(speed.values()) / len(speed)
    rec(f"the replay of {len(tab.days)} days x 4 coins takes under 120 s (mean {t_all:.1f} s, max {max(speed.values()):.1f} s)", max(speed.values()) < 120.0)
    log(f"    22 days at this speed: about {max(speed.values()) * 22 / len(tab.days) / 60:.1f} min")
    return out


def _raises(fn) -> bool:
    try:
        fn()
    except Exception:
        return True
    return False


def _nan_equal(a, b) -> bool:
    return bool(a == b or (a != a and b != b))


def signal_parity(tab: B.Tab, n_random: int = 3000, seed: int = 11, rsi_n: int = 14) -> dict:
    """The live form of every signal against the vectorized one (`tf15_cands.layer_signals`) at every second where the base gate passes plus `n_random` random
    (window, second) cells and `n_random` cells after a burst: float32 bit equality, NaN equal to NaN. -> {signal: (cells compared, cells that differ, first (w, k, live,
    vectorized))}. `rsi_n` other than 14 plants a fault."""
    import tf15_cands as C
    sg = C.layer_signals(tab)
    m = C._gates(tab, 10, 4.0, 0.08)
    lo, hi = C.PX_BAND["40-85"]
    gate = (m["up"] & m["nup_up"] & (m["qa"] >= lo) & (m["qa"] <= hi)) | (m["dn"] & m["nup_dn"] & (m["qd"] >= lo) & (m["qd"] <= hi))
    rng = np.random.default_rng(seed)
    cells = set(map(tuple, np.argwhere(gate).tolist()))
    cells |= {(int(rng.integers(tab.W)), int(rng.integers(tab.NK))) for _ in range(n_random)}
    post = np.argwhere(np.isfinite(sg["retrace"]))
    if len(post):
        cells |= {tuple(post[i].tolist()) for i in rng.integers(len(post), size=min(n_random, len(post)))}
    by_w = {}
    for w, k in sorted(cells):
        by_w.setdefault(int(w), []).append(int(k))
    out = {n: [0, 0, None] for n in ("rsi", "spread", "imbalance", "intensity_z", "level", "retrace", "hour")}

    def cmp(name, w, k, live, vec):
        r = out[name]
        r[0] += 1
        if not _nan_equal(float(live), float(vec)):
            r[1] += 1
            if r[2] is None:
                r[2] = (w, k, float(live), float(vec))
    for w, ks in by_w.items():
        f = Feed(tab, w)
        for k in ks:
            st = f.state(k)
            cmp("rsi", w, k, st.rsi(rsi_n), sg["rsi"][w, k])
            cmp("spread", w, k, st.spread_c(), sg["spread"][w, k])
            cmp("imbalance", w, k, st.imbalance(), sg["imb"][w, k])
            cmp("intensity_z", w, k, st.intensity_z(), sg["iz"][w, k])
            cmp("level", w, k, st.z, sg["level"][w, k])
            cmp("retrace", w, k, st.retrace(), sg["retrace"][w, k])
            cmp("hour", w, k, (st.start_ms // 3_600_000) % 24, sg["hour"][w])
    return {n: tuple(v) for n, v in out.items()}


def pick_layered_cells(grid, e_count):
    """The grid cells the selftest replays: index 0 (the base), every single-family cell of time, hour, spread, gap, rsi, level and flow (`family_of`), the first
    spread-and-gap cell (book), every single-exit cell, and six joint cells (tp95, retrace50 and expiry; each plain, and with at least two of the RSI, level and flow filters among at least four): among the joint
    cells of that kind and exit, the one with the most vectorized entries (`e_count(cell)`), first on a tie. -> list of (tag, index)."""
    import tf15_cands as C
    picks = [("base", 0)]
    for fam in ("time", "hour", "spread", "gap", "book", "rsi", "level", "flow"):
        hits = [i for i, c in enumerate(grid) if C.family_of(c["name"]) == fam]
        picks += [(fam, i) for i in (hits[:1] if fam == "book" else hits)]
    picks += [(f"exit {c['exit']}", i) for i, c in enumerate(grid) if C.family_of(c["name"]) == "exit"]
    for ex, rich in (("tp95", False), ("retrace50", False), ("expiry", False), ("tp95", True), ("retrace50", True), ("expiry", True)):
        cand = [i for i, c in enumerate(grid) if C.family_of(c["name"]) == "joint" and c["exit"] == ex
                and sum(c[k] != "any" for k in ("tl", "hr", "sp", "gp", "rs", "lv", "fl")) >= (4 if rich else 3)
                and sum(c[k] != "any" for k in ("rs", "lv", "fl")) >= (2 if rich else 0)]
        if cand:
            picks.append((f"joint {ex}" + (" with signals" if rich else ""), max(cand, key=lambda i: (e_count(grid[i]), -i))))
    return picks


def layered_checks(tab: B.Tab | None = None, log=print) -> list[tuple[str, bool]]:
    """The layered rule against `tf15_cands.BuyNearLayered`: signal parity, then `agree` per picked cell (entries, net, exit seconds and reasons), the spec round trip and
    a planted fault in a signal. Two real days at 250 ms. A cell with under 5 entries on these days is marked THIN: it agrees, but it proves little by itself."""
    import tf15_cands as C
    out = []

    def rec(label, cond):
        out.append((label, bool(cond)))
        log(f"  {'ok  ' if cond else 'FAIL'} {label}")

    if tab is None:
        tab = B.Tab(["2026-10-06", "2026-10-07"], fill_ms=250)
    G = C.BuyNearLayered()
    grid = G.grid()
    log(f"layered grid: {len(grid)} cells; table {tab.W} windows")

    t0 = time.time()
    par = signal_parity(tab)
    for n, (cnt, bad, first) in par.items():
        log(f"    signal {n}: {cnt} cells compared, {bad} differ" + ("" if first is None else f", first (w, k, live, vectorized) = {first}"))
        rec(f"live {n} equals the vectorized signal bit for bit on {cnt} cells", bad == 0 and cnt > 100)
    bad_par = signal_parity(tab, n_random=300, rsi_n=13)
    rec(f"signal parity catches a planted fault (RSI over 13 changes instead of 14: {bad_par['rsi'][1]} of {bad_par['rsi'][0]} differ)", bad_par["rsi"][1] > 0)
    log(f"    parity time {time.time() - t0:.1f} s")

    def e_count(cfg):
        return len(G.run(tab, cfg, {})["w"])
    picks = pick_layered_cells(grid, e_count)
    log(f"    cells replayed: {len(picks)}")
    speed = []
    for tag, i in picks:
        cfg = grid[i]
        rule = LayeredRule.from_cfg(cfg)
        e_vec = G.run(tab, cfg, {})
        t1 = time.time()
        e_live = replay(tab, rule, 250)
        speed.append(time.time() - t1)
        rep = agree(e_vec, e_live, verbose=False)
        ke_ok = np.array_equal(np.asarray(e_vec["ke"]), np.asarray(e_live["ke"])) if rep["ok"] else False
        why_ok = all(str(a).split("|")[0] == str(b) or (str(a) == "hold" and str(b) == "expiry") for a, b in zip(e_vec["exit_reason"], e_live["exit_reason"])) if rep["ok"] else False
        good = rep["ok"] and ke_ok and why_ok
        diff = rep["first_diff"] or ("exit second differs" if not ke_ok else "exit reason differs" if not why_ok else None)
        thin = " THIN" if rep["n_vec"] < 5 else ""
        nx = int((np.asarray(e_live["ke"]) >= 0).sum())
        log(f"    [{tag}] #{i} {cfg['name']}: entries {rep['n_vec']}/{rep['n_live']}{thin}, exits {nx}, net {float(np.sum(e_vec['net'])):+.4f}/{float(np.sum(e_live['net'])):+.4f}, "
            f"agree {'yes' if good else 'NO'}" + (f", first difference: {diff}" if diff else "") + f", {speed[-1]:.1f} s")
        rec(f"layered cell [{tag}] #{i} {cfg['name']} agrees with BuyNearLayered ({rep['n_vec']} entries, {nx} exits)", good)
        back = from_spec(json.loads(json.dumps(to_spec(rule))))
        rec(f"layered cell [{tag}] spec round trip", to_spec(back) == to_spec(rule) and explain(back) == explain(rule))
    # a rule rebuilt from its JSON spec makes the same trades as the one built from the cell
    j = next((i for t, i in picks if t == "joint tp95"), 0)
    r1 = LayeredRule.from_cfg(grid[j])
    e1, e2 = replay(tab, r1, 250), replay(tab, from_spec(json.loads(json.dumps(to_spec(r1)))), 250)
    rec("a LayeredRule rebuilt from its JSON spec replays to the same trades", agree(e1, e2, verbose=False)["ok"] and np.array_equal(e1["ke"], e2["ke"]))
    log("  explain(joint tp95): " + explain(r1))
    log(f"    layered replay time per cell: mean {np.mean(speed):.1f} s, max {np.max(speed):.1f} s")
    rec("every layered replay of 2 days takes under 120 s", max(speed) < 120.0)
    return out


def steady_checks(tab: B.Tab | None = None, log=print) -> list[tuple[str, bool]]:
    """`LayeredRule.from_cfg` of a `tf15_cands.BuyNearSteady` cell (coin cut, band, onset-only orders, one order per 15-minute slot) against `BuyNearSteady().run`: cells 0, 8,
    16, 48 and the last of the grid plus two more slot-one cells, each with `agree` and the exit fields; a planted tie-break the other way in the slot rule and a rule
    without the onset rule must both be caught; the spec round trip. The planted tie-break bites only if a slot has two windows whose first trigger second is the same,
    so the count of such slots is printed and required to be positive."""
    import tf15_cands as C
    out = []

    def rec(label, cond):
        out.append((label, bool(cond)))
        log(f"  {'ok  ' if cond else 'FAIL'} {label}")

    if tab is None:
        tab = B.Tab(["2026-10-06", "2026-10-07"], fill_ms=250)
    G = C.BuyNearSteady()
    grid = G.grid()
    by_name = {c["name"]: i for i, c in enumerate(grid)}
    log(f"steady grid: {len(grid)} cells; table {tab.W} windows")
    picks = [(i, "") for i in (0, 8, 16, 48, len(grid) - 1)] + [(by_name[n], "slot-one") for n in ("all|px60-85|slotone|z3|th0.04|T120|expiry", "all|px70-90|slotone|z3|th0.04|T120|expiry")]
    seen, speed, tied_cells = set(), [], []
    for i, tag in picks:
        if i in seen:
            continue
        seen.add(i)
        cfg = grid[i]
        rule = LayeredRule.from_cfg(cfg)
        e_vec = G.run(tab, cfg, {})
        t1 = time.time()
        e_live = replay(tab, rule, 250)
        speed.append(time.time() - t1)
        rep = agree(e_vec, e_live, verbose=False)
        good = rep["ok"] and np.array_equal(np.asarray(e_vec["ke"]), np.asarray(e_live["ke"]))
        diff = rep["first_diff"] or (None if good else "exit second differs")
        thin = " THIN" if rep["n_vec"] < 5 else ""
        log(f"    #{i} {cfg['name']}{' [' + tag + ']' if tag else ''}: entries {rep['n_vec']}/{rep['n_live']}{thin}, net {float(np.sum(e_vec['net'])):+.4f}/{float(np.sum(e_live['net'])):+.4f}, "
            f"agree {'yes' if good else 'NO'}" + (f", first difference: {diff}" if diff else "") + f", {speed[-1]:.1f} s")
        rec(f"steady cell #{i} {cfg['name']} agrees with BuyNearSteady ({rep['n_vec']} entries)", good)
        back = from_spec(json.loads(json.dumps(to_spec(rule))))
        rec(f"steady cell #{i} spec round trip", to_spec(back) == to_spec(rule) and explain(back) == explain(rule))
        if cfg["slot"] == "one" and cfg["coin"] == "all":
            tied_cells.append((i, cfg, e_vec))
    # slots where the earliest trigger second is shared: only there can a tie-break matter
    cfg0 = tied_cells[0][1]
    side, trig, _, _ = G.triggers(tab, dict(cfg0, slot="any"), {})
    first = np.where(trig.any(1), trig.argmax(1), tab.NK)
    n_tie = 0
    for sl in np.unique(tab.slot):
        f = np.sort(first[tab.slot == sl])
        n_tie += int(len(f) > 1 and f[0] < tab.NK and f[1] == f[0])
    log(f"    slots whose earliest trigger second is shared by two windows (cell #{tied_cells[0][0]} before the slot rule): {n_tie}")
    rec("the two days contain slots with a tied earliest trigger second (the planted tie-break can bite)", n_tie > 0)
    caught = 0
    for i, cfg, e_vec in tied_cells:
        e_bad = replay(tab, LayeredRule.from_cfg(cfg), 250, _tie_high_first=True)
        rep = agree(e_vec, e_bad, verbose=False)
        log(f"    planted tie-break (highest asset first) on #{i} {cfg['name']}: agree {'yes' if rep['ok'] else 'NO'}; only-vec {rep['only_vec']}, only-live {rep['only_live']}; first: {rep['first_diff']}")
        caught += int(not rep["ok"])
    rec(f"a planted slot tie-break the other way is caught on {caught} of {len(tied_cells)} slot-one cells", caught > 0)
    cfg = grid[0]                                                      # a slot-one cell would hide it: the first onset is also the first True second
    r_no_onset = LayeredRule.from_cfg(cfg)
    r_no_onset.onset = False
    rep = agree(G.run(tab, cfg, {}), replay(tab, r_no_onset, 250), verbose=False)
    log(f"    planted: no onset rule on #0: agree {'yes' if rep['ok'] else 'NO'}; only-vec {rep['only_vec']}, only-live {rep['only_live']}")
    rec("a rule that orders at every second of a run (no onset rule) is caught", not rep["ok"])
    rec("every steady replay of 2 days takes under 120 s", max(speed) < 120.0)
    log("  explain(last cell): " + explain(LayeredRule.from_cfg(grid[-1])))
    return out


def near_tests_checks(tab: B.Tab | None = None, log=print) -> list[tuple[str, bool]]:
    """`LayeredRule` against tests A and E of `tf15_cands.near_tests` (10 s burst |z| >= 3, the near ask more than 5 cents under fair, any price, 300 s or more left,
    retry each second, hold to expiry; E adds `ask_still(tab, 3)`): `agree` on both, and a planted `stale_s` of 2 instead of 3 must differ from E. A State's book
    history is part of the causality check (`check_causal`)."""
    import tf15_cands as C
    out = []

    def rec(label, cond):
        out.append((label, bool(cond)))
        log(f"  {'ok  ' if cond else 'FAIL'} {label}")

    if tab is None:
        tab = B.Tab(["2026-10-06", "2026-10-07"], fill_ms=250)
    tests, _ = C.near_tests(tab)
    mk = lambda n: LayeredRule(L=10, z_min=3.0, theta=0.05, band=C.PX_BAND["any"], t_min=300, stale_s=n)      # noqa: E731
    res = {}
    for name, n in (("A", 0), ("E", 3), ("E-planted-2", 2)):
        rule = mk(n)
        e_vec = tests["E" if name.startswith("E") else "A"]
        t1 = time.time()
        e_live = replay(tab, rule, 250)
        rep = agree(e_vec, e_live, verbose=False)
        res[name] = rep
        log(f"    test {name[0]} vs LayeredRule(stale_s={n}): entries {rep['n_vec']}/{rep['n_live']}, only-vec {rep['only_vec']}, only-live {rep['only_live']}, net "
            f"{float(np.sum(e_vec['net'])):+.4f}/{float(np.sum(e_live['net'])):+.4f}, agree {'yes' if rep['ok'] else 'NO'}"
            + ("" if rep["ok"] else f", first difference: {rep['first_diff']}") + f", {time.time() - t1:.1f} s")
        if name != "E-planted-2":
            rec(f"LayeredRule(stale_s={n}) agrees with near_tests test {name[0]} ({rep['n_vec']} entries)", rep["ok"] and rep["n_vec"] >= 20)
            back = from_spec(json.loads(json.dumps(to_spec(rule))))
            rec(f"test {name[0]} rule: spec round trip", to_spec(back) == to_spec(rule) and explain(back) == explain(rule))
    rec("a planted stale_s of 2 instead of 3 differs from test E", not res["E-planted-2"]["ok"])
    rec("test E has fewer entries than test A (the added condition removes some)", res["E"]["n_vec"] < res["A"]["n_vec"])
    log("  explain(E): " + explain(mk(3)))
    return out


def selftest(parts=("core", "layered", "steady", "near")) -> bool:
    ok = True
    tab = B.Tab(["2026-10-06", "2026-10-07"], fill_ms=250)
    if "core" in parts:
        for label, cond in checks(tab):
            ok &= bool(cond)
    if "layered" in parts:
        for label, cond in layered_checks(tab):
            ok &= bool(cond)
    if "steady" in parts:
        for label, cond in steady_checks(tab):
            ok &= bool(cond)
    if "near" in parts:
        for label, cond in near_tests_checks(tab):
            ok &= bool(cond)
    print("selftest:", "ALL GREEN" if ok else "FAILED")
    return bool(ok)


if __name__ == "__main__":
    for part in ("layered", "steady", "near", "core"):
        if f"--selftest={part}" in sys.argv:
            sys.exit(0 if selftest((part,)) else 1)
    if "--selftest" in sys.argv:
        sys.exit(0 if selftest() else 1)
    print(__doc__)
