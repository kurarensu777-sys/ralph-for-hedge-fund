"""The candidates of the B-0654 strategy search: each is a registered grid of cells over the decision table. No cell is added or removed after its run is registered.

    C1 TailBuy        buy the cheap tail (a token asking at most a_max), alone or only when the Brownian fair value says it is underpriced by a ratio
    C2 NearCertain    buy the near-certain side (a token asking at least a_lo) only when the fair value clears the ask by theta, with at most t_max seconds left
    C3 EdgeTaker      buy the side the calibrated fair value likes by more than theta after the fee (the no-gate Brownian-edge rule of um-003 is its ancestor)
    C4 PassiveBinance rest a bid where the fair value is above it by a discount, cancel when Binance moves against it (tf15_mk)
All use the Binance trade-implied mid, the market's own fee, the exact ladder at t + 150 ms and the venue's resolution.
"""
from __future__ import annotations

import numpy as np

import tf15_bt as B
import tf15_fv as FV
import tf15_mk as MK
import tf15_study as S


def quotes(tab):
    """The Up and Down asks as the trader saw them at t, in the table's own float32 arithmetic (then float64), so a limit built from them equals the fill
    ladder's price at the same level (`tf15_bt.ladder_of` mirrors the Down side as 1.0 - the Up bid in float32 too). Measured 2026-10-09: building the Down
    ask as 1.0 - float64(qb) put it 1e-9 under the ladder's own value and the walk refused every Down level sitting exactly at the quoted ask (test A of
    um-011 lost 51 of 1,707 fills to it)."""
    return tab.qa.astype(float), (1.0 - tab.qb).astype(float)


def edge_of(p, ask, rate):
    with np.errstate(invalid="ignore"):
        return np.where(np.isfinite(ask) & (ask > 0), p - ask - rate * ask * (1.0 - ask), -np.inf)


def sides_p(pu):
    return pu, 1.0 - pu


class Taker(S.Candidate):
    family = "taker"

    def triggers(self, tab, cfg, ctx):
        """-> side (W, NK), trig (W, NK), limit (W, NK), hold (None or seconds)."""
        raise NotImplementedError

    def run(self, tab, cfg, ctx, fee_mult=1.0, slack=0.0, usd=B.CLIP_USD):
        side, trig, lim, hold = self.triggers(tab, cfg, ctx)
        if fee_mult != 1.0:
            tab = _scaled_fee(tab, fee_mult)
        return B.entries(tab, side, trig, lim + slack, usd=usd, hold=hold)

    def placebo(self, tab, cfg, ctx, seed):
        side, trig, lim, hold = self.triggers(tab, cfg, ctx)
        qa, qd = quotes(tab)
        rng = np.random.default_rng(seed)
        rs = np.where(rng.random(side.shape) < 0.5, 1, -1)
        return B.entries(tab, rs, trig, np.where(rs > 0, qa, qd), hold=hold)

    def peek(self, tab, cfg, ctx):
        side, trig, lim, hold = self.triggers(tab, cfg, ctx)
        qa, qd = quotes(tab)
        ps = np.where(tab.up[:, None], 1, -1) * np.ones(side.shape, int)
        return B.entries(tab, ps, trig, np.where(ps > 0, qa, qd), hold=hold)


def _scaled_fee(tab, m):
    import copy
    t = copy.copy(tab)
    t.w_fee = tab.w_fee * m
    return t


def tmask(tab, t_min=0, t_max=900):
    return (tab.T[None, :] >= t_min) & (tab.T[None, :] <= t_max)


# ------------------------------------------------------------------ C1
class TailBuy(Taker):
    id = "c1-tail-buy"
    title = "Buy the cheap tail"

    def grid(self):
        g = []
        for a_max in (0.03, 0.06, 0.10):
            for ratio in (0.0, 1.5, 2.5):
                for t_min in (60, 300):
                    g.append(dict(name=f"tail<={a_max:g}|m{ratio:g}|T>={t_min}", a_max=a_max, ratio=ratio, t_min=t_min))
        return g

    def fit(self, tab):
        return {}

    def triggers(self, tab, cfg, ctx):
        pu, _ = MK.fv_grid(tab)
        qa, qd = quotes(tab)
        cheap_u = (qa <= cfg["a_max"]) & (qa >= 0.01)
        cheap_d = (qd <= cfg["a_max"]) & (qd >= 0.01)
        if cfg["ratio"] > 0:
            cheap_u &= pu >= cfg["ratio"] * qa
            cheap_d &= (1 - pu) >= cfg["ratio"] * qd
        use_u = cheap_u & ~(cheap_d & (qd < qa))
        side = np.where(use_u, 1, np.where(cheap_d, -1, 0))
        trig = (cheap_u | cheap_d) & tmask(tab, cfg["t_min"])
        return side, trig, np.where(side > 0, qa, qd), None


# ------------------------------------------------------------------ C2
class NearCertain(Taker):
    id = "c2-near-certain"
    title = "Buy the near-certain side"

    def grid(self):
        g = []
        for a_lo in (0.85, 0.92, 0.96):
            for theta in (0.0, 0.02, 0.04):
                for t_max in (120, 600, 900):
                    g.append(dict(name=f"fav>={a_lo:g}|th{theta:g}|T<={t_max}", a_lo=a_lo, theta=theta, t_max=t_max))
        return g

    def triggers(self, tab, cfg, ctx):
        pu, _ = MK.fv_grid(tab)
        qa, qd = quotes(tab)
        rate = tab.w_fee[:, None].astype(float)
        eu, ed = edge_of(pu, qa, rate), edge_of(1 - pu, qd, rate)
        fav_u = (qa >= cfg["a_lo"]) & (qa <= 0.995) & (eu > cfg["theta"])
        fav_d = (qd >= cfg["a_lo"]) & (qd <= 0.995) & (ed > cfg["theta"])
        side = np.where(fav_u & ~(fav_d & (ed > eu)), 1, np.where(fav_d, -1, 0))
        trig = (fav_u | fav_d) & tmask(tab, 10, cfg["t_max"])
        return side, trig, np.where(side > 0, qa, qd), None


# ------------------------------------------------------------------ C3
class EdgeTaker(Taker):
    id = "c3-edge-taker"
    title = "Trade the calibrated fair-value edge"

    def grid(self):
        g = []
        for cal in ("raw", "iso"):
            for theta in (0.04, 0.06, 0.08, 0.10, 0.12):
                for t_min in (10, 120):
                    for coins in ("all", "btc+eth"):
                        g.append(dict(name=f"{cal}|th{theta:g}|T>={t_min}|{coins}", cal=cal, theta=theta, t_min=t_min, coins=coins))
        return g

    def fit(self, tab):
        """An isotonic map of the Brownian P(Up) fitted on the TRAIN windows' instants every 10 s (the later days never enter it)."""
        pu, _ = MK.fv_grid(tab)
        ks = np.arange(0, tab.NK, 10)
        x = pu[:, ks].ravel()
        y = np.repeat(tab.up.astype(float)[:, None], len(ks), 1).ravel()
        return dict(iso=FV.fit_iso(x, y, nbin=100))

    def triggers(self, tab, cfg, ctx):
        pu, _ = MK.fv_grid(tab)
        if cfg["cal"] == "iso":
            pu = FV.apply_iso(ctx["iso"], pu.ravel()).reshape(pu.shape)
        qa, qd = quotes(tab)
        rate = tab.w_fee[:, None].astype(float)
        eu, ed = edge_of(pu, qa, rate), edge_of(1 - pu, qd, rate)
        side = np.where(eu >= ed, 1, -1)
        e = np.maximum(eu, ed)
        trig = (e > cfg["theta"]) & tmask(tab, cfg["t_min"])
        if cfg["coins"] == "btc+eth":
            trig &= (tab.w_asset <= 1)[:, None]
        return side, trig, np.where(side > 0, qa, qd), None


# ------------------------------------------------------------------ C4
class PassiveBinance(S.Candidate):
    id = "c4-passive-binance"
    title = "Rest a bid and cancel it on Binance"
    family = "maker"

    def grid(self):
        g = []
        for mode in ("join", "improve"):
            for pm in (0.0, 0.02, 0.04):
                for cm in (0.0, 0.03):
                    for life in (30, 120):
                        g.append(dict(name=f"{mode}|pm{pm:g}|cm{cm:g}|life{life}", mode=mode, post_margin=pm, cancel_margin=cm, life_s=life, step_s=5, k_start=10, t_end_left=20,
                                      p_lo=0.20, p_hi=0.80))
        return g

    placebo_n = 1

    def run(self, tab, cfg, ctx, **kw):
        return MK.run(tab, cfg, **kw)

    def placebo(self, tab, cfg, ctx, seed):
        """The same quoting rule with no Binance information: the fair value is 0.5 everywhere, so only the price rule and the cancel latency remain."""
        pu_g, pu_e = MK.fv_grid(tab)
        return MK.run(tab, cfg, pu=(np.full_like(pu_g, 0.5), np.full_like(pu_e, 0.5)))

    def peek(self, tab, cfg, ctx):
        """The fair value is the outcome (0.97 / 0.03): the rule posts on the winner's token only and never cancels it. It must pay far more than the real rule."""
        pu_g, pu_e = MK.fv_grid(tab)
        w_e = np.where(tab.up, 0.97, 0.03)
        return MK.run(tab, cfg, pu=(np.repeat(w_e[:, None], pu_g.shape[1], 1), w_e[tab.e_w]))


# ------------------------------------------------------------------ C5
class MomentumTail(Taker):
    id = "c5-momentum-tail"
    title = "Buy the tail a momentum burst left behind"

    def grid(self):
        g = []
        for L in (10, 30):
            for z_min in (1.5, 2.0, 2.5, 3.0):
                for gate in ("none", "literal", "buffer"):
                    for a_max in (None, 0.10, 0.05):
                        for t_min in (60, 300):
                            gv = {"none": "fv-off", "literal": "fv-lit", "buffer": "fv-buf"}[gate]
                            am = "any" if a_max is None else f"{int(round(a_max * 100))}c"
                            g.append(dict(name=f"z{z_min:g}|L{L}|{gv}|{am}|T{t_min}", L=L, z_min=z_min, gate=gate, a_max=a_max, t_min=t_min))
        return g

    def fit(self, tab):
        return {}

    def triggers(self, tab, cfg, ctx):
        zl = tab.zl[:, :, {10: 0, 30: 1}[cfg["L"]]]          # (W, NK) the burst z over L seconds
        z_min = cfg["z_min"]
        qa, qd = quotes(tab)
        pu = tab.pu                                            # the Brownian P(Up) fair value, driftless (no momentum term)
        burst_up = zl >= z_min                                 # price spiked up -> buy the Down tail
        burst_dn = zl <= -z_min                                # price dropped -> buy the Up tail
        if cfg["gate"] == "none":
            ok_up, ok_dn = burst_dn, burst_up
        else:
            buf = 0.0 if cfg["gate"] == "literal" else 0.02    # never pay more than the fair value (literal) or a 2-cent buffer over it
            ok_up = burst_dn & (qa <= pu + buf)                # the Up tail is not above the Up fair value
            ok_dn = burst_up & (qd <= (1.0 - pu) + buf)        # the Down tail is not above the Down fair value
        if cfg["a_max"] is not None:
            ok_up &= qa <= cfg["a_max"]
            ok_dn &= qd <= cfg["a_max"]
        side = np.where(ok_up, 1, np.where(ok_dn, -1, 0))
        trig = (ok_up | ok_dn) & tmask(tab, cfg["t_min"])
        return side, trig, np.where(side > 0, qa, qd), None


# ------------------------------------------------------------------ C6
class SellTail(Taker):
    id = "c6-sell-tail"
    title = "Sell the tail a momentum burst left over-priced"

    def grid(self):
        g = []
        for L in (10, 30):
            for z_min in (1.5, 2.0, 2.5, 3.0):
                for theta in (0.0, 0.02, 0.05):
                    for t_min in (60, 300):
                        g.append(dict(name=f"z{z_min:g}|th{theta:g}|L{L}|T{t_min}", L=L, z_min=z_min, theta=theta, t_min=t_min))
        return g

    def fit(self, tab):
        return {}

    def triggers(self, tab, cfg, ctx):
        zl = tab.zl[:, :, {10: 0, 30: 1}[cfg["L"]]]
        qa, qd = quotes(tab)
        pu = tab.pu                                            # the driftless (symmetric) P(Up), no momentum term
        z_min, theta = cfg["z_min"], cfg["theta"]
        burst_up = zl >= z_min
        burst_dn = zl <= -z_min
        # the burst persists (skew), so the far tail is over-priced: sell it (buy the near side) while the far tail's ask is above the driftless fair value
        sell_up = burst_up & (qd > (1.0 - pu) + theta)         # sell the Down tail, buy Up
        sell_dn = burst_dn & (qa > pu + theta)                 # sell the Up tail, buy Down
        side = np.where(sell_up, 1, np.where(sell_dn, -1, 0))
        trig = (sell_up | sell_dn) & tmask(tab, cfg["t_min"])
        return side, trig, np.where(side > 0, qa, qd), None


# ============================================================ the buy-near tests of the burst-mispricing thesis (um-011 three tests; um-021 adds four non-momentum signals, 2026-10-11)
TESTS = {
    "A": ("buy the near token after a burst when its ask is under fair value",
          "after a burst of |z| at least z_min, when the near token's ask sits more than the discount under its driftless fair value, buy it at no worse than that ask"),
    "C": ("buy the near token after a burst at any price",
          "after the burst, buy the near token at its ask whatever the book says against fair value (is the price gate necessary?)"),
    "D": ("buy the near token when its ask is under fair value, with no burst",
          "test A's gate with no burst required: when the near token's ask sits more than the discount under its fair value, buy it (is the burst necessary?)"),
    "E": ("buy after a burst when the near ask has not moved for 3 seconds",
          "test A's burst and price gate, and the near token's ask at the decision second equal to its ask 3 seconds earlier: nobody has re-priced the book since the burst began, "
          "the staleness the thesis names, read directly"),
    "F": ("buy after a burst when another coin bursts the same way at the same moment",
          "test A's burst and price gate, and at least one of the other three coins in the same 15-minute slot showing a 10 s |z| of at least 3 in the same direction "
          "at the same second: the move is market-wide, not one coin's print"),
    "G": ("buy ETH, SOL or XRP's near token when Bitcoin bursts and its own ask is under its own fair value",
          "ETH, SOL and XRP windows only: Bitcoin's 10 s |z| at least z_min at that second, and the coin's own near token (the side Bitcoin points to) asking more than "
          "the discount under its own fair value; the coin needs no burst of its own"),
    "H": ("buy after a burst when at least 20 USD rests at the best ask",
          "test A's burst and price gate, and the size at the near token's best ask worth at least the clip (USD 20) at the decision second, so the order fills "
          "at one price; when the best ask holds less, the fill walks up the book to dearer prices"),
}
LEG = {0: "buy near"}


def _tag(e, leg, usd):
    e = dict(e)
    e["leg"] = np.full(len(e["net"]), leg, np.int8)
    e["levered"] = e["cost"] / usd
    return e


def slot_count(tab, cond):
    """For each (window, second) the number of windows of the same 15-minute slot (the four coins) where `cond` is True, itself included."""
    u, inv = np.unique(np.asarray(tab.slot), return_inverse=True)
    c = np.zeros((len(u), tab.NK), np.int16)
    np.add.at(c, inv, cond.astype(np.int16))
    return c[inv]


def slot_btc(tab, cond):
    """For each (window, second) whether `cond` is True on the Bitcoin window of the same slot (False where the slot has no Bitcoin window)."""
    u, inv = np.unique(np.asarray(tab.slot), return_inverse=True)
    is_btc = np.asarray(tab.w_asset) == 0
    b = np.zeros((len(u), tab.NK), bool)
    np.logical_or.at(b, inv[is_btc], cond[is_btc])
    return b[inv]


def ask_still(tab, n=3):
    """(Up ask unchanged over the last n s, Down ask unchanged over the last n s), causal, False in the first n seconds."""
    qa, qb = tab.qa.astype(float), tab.qb.astype(float)
    su = np.zeros(qa.shape, bool)
    sd = np.zeros(qa.shape, bool)
    su[:, n:] = np.isfinite(qa[:, n:]) & (qa[:, n:] == qa[:, :-n])
    sd[:, n:] = np.isfinite(qb[:, n:]) & (qb[:, n:] == qb[:, :-n])          # the Down ask is 1 - the Up bid
    return su, sd


AGE_MAX_S = 2.0          # a book row this old or older is silent; the timing audit's q6 (2026-10-11): ages at E's entries p50 10 ms, p90 80 ms, 0.25% of window-seconds >= 3 s


def feed_live(tab, age_max_s=AGE_MAX_S):
    """The FEED mask (the timing audit, 2026-10-11, finding 3): True at (window, second) when the window's own book row is younger than `age_max_s`, or at
    least one other coin's book in the same 15-minute slot is. A quiet single book with a live neighbour is a real book and trades; every book of the slot
    silent at once is a hole in the archive, and "ask unchanged for n s" passes on it by construction, so it never trades. Reads `tab.age` (ms from the
    gate's book row, -1 where none). -> bool (W, NK)."""
    a = np.asarray(tab.age)
    fresh = (a >= 0) & (a < int(round(age_max_s * 1000)))
    return slot_count(tab, fresh) >= 1


def feed_checks() -> list[tuple[str, bool]]:
    """Planted slots for `feed_live` (no I/O)."""
    class _T:
        pass
    t = _T()
    t.slot = np.array([7, 7, 7, 7, 8, 8])
    t.NK = 3
    # slot 7, second 0: every book 2 s or older (a hole) -> masked; second 1: btc quiet 30 s but eth live -> kept; second 2: no row on btc, others silent -> masked
    # slot 8 (two coins), second 0: both live; second 1: one live; second 2: both silent
    t.age = np.array([[2_000, 30_000, -1], [2_500, 150, 5_000], [9_000, 4_000, 3_000], [2_001, 2_200, 2_100],
                      [10, 20, 2_000], [30, 9_000, 7_000]], np.int32)
    m = feed_live(t)
    out = [("a slot-wide silent second is masked (every book of the slot 2 s or older)", not m[:4, 0].any()),
           ("a single quiet book with a live neighbour in its slot is not masked", bool(m[0, 1]) and bool(m[3, 1])),
           ("a window with no book row yet takes its slot's state", not m[0, 2]),
           ("one live book keeps its whole slot; the age limit is strict (2,000 ms is silent)", bool(m[4:, 1].all()) and not m[4:, 2].any() and bool(m[4:, 0].all()))]
    return out


def near_tests(tab, L=10, z_min=3.0, theta=0.05, t_min=300, usd=B.CLIP_USD, feed=True):
    """The tests of TESTS on one pooled table, each an entries dict in (slot, asset) order (every entry a buy of the near token at its ask: `leg` 0,
    `levered` the cost over the clip, at most 1). Every price is the venue's own book as of the decision second (the gate) and the ladder at t + FILL_MS
    (the fill). `feed` True (the default from 2026-10-11) refuses every gate where the slot's feed is silent (`feed_live`). -> (entries by test, masks), where
    masks["gates"][test] = (gate_up, gate_dn) before the time mask (after the feed mask), masks["nup_*"] the price gate with the feed mask in it, masks["feed"]
    the feed mask (all True when `feed` is False)."""
    zl = tab.zl[:, :, {10: 0, 30: 1, 60: 2}[L]]
    # Two representations of one quote. The LIMIT a fill honours keeps the table's float32 arithmetic, the same the fill ladder carries (`ladder_of`), so a
    # level at exactly the quoted price is taken. The GATE compares on the cent grid in float64 (a quote rounded to 4 places against the float64 fair value),
    # strict, so a quote exactly theta from fair is neither under- nor over-priced whatever the float32 noise says.
    qa_lim, qd_lim = quotes(tab)                               # the Up ask and the Down ask as seen at t: the limits
    qa, qd = np.round(qa_lim, 4), np.round(qd_lim, 4)          # the same quotes on the cent grid: the gates
    pu = tab.pu.astype(float)
    pdn = 1.0 - pu
    up, dn = zl >= z_min, zl <= -z_min
    tm = tmask(tab, t_min)
    nup_up, nup_dn = qa < pu - theta, qd < pdn - theta         # the near token's ask under its fair value
    a_up, a_dn = up & nup_up, dn & nup_dn                      # test A's gate
    su, sd = ask_still(tab, 3)
    b_up, b_dn = slot_count(tab, zl >= 3.0) >= 2, slot_count(tab, zl <= -3.0) >= 2
    alt = (np.asarray(tab.w_asset) != 0)[:, None]
    g_up, g_dn = slot_btc(tab, up) & nup_up & alt, slot_btc(tab, dn) & nup_dn & alt
    with np.errstate(invalid="ignore"):
        deep_up = tab.qas.astype(float) * qa_lim >= usd
        deep_dn = tab.qbs.astype(float) * qd_lim >= usd         # the Down ask's size is the Up bid's size
    gates = {"A": (a_up, a_dn), "C": (up, dn), "D": (nup_up, nup_dn), "E": (a_up & su, a_dn & sd), "F": (a_up & b_up, a_dn & b_dn), "G": (g_up, g_dn), "H": (a_up & deep_up, a_dn & deep_dn)}
    fl = feed_live(tab) if feed else np.ones(tab.qa.shape, bool)
    gates = {k: (g[0] & fl, g[1] & fl) for k, g in gates.items()}

    def near(t_up, t_dn):
        side = np.where(t_up, 1, np.where(t_dn, -1, 0))
        return _tag(B.entries(tab, side, (t_up | t_dn) & tm, np.where(side > 0, qa_lim, qd_lim), usd), 0, usd)

    out = {k: B.concat(near(*g)) for k, g in gates.items()}
    # the price gate is handed on with the feed mask in it, so a null that draws "every condition but the burst" (`tf15_oos.burst_pools`) draws live books only
    masks = dict(up=up, dn=dn, nup_up=nup_up & fl, nup_dn=nup_dn & fl, tm=tm, gates=gates, feed=fl)
    return out, masks


def near_gate_sweep(tab, thetas=(0.0, 0.01, 0.02, 0.03, 0.05, 0.07, 0.10, 0.15), L=10, z_min=3.0, t_min=300, usd=B.CLIP_USD):
    """Test A's gate at several discounts to fair value (theta, USD a share), one row each (n, win, breakeven, per, lo, hi, net): the SHAPE of the edge against the discount, not a search (the study's discount is fixed)."""
    rows = []
    for th in thetas:
        e = near_tests(tab, L=L, z_min=z_min, theta=th, t_min=t_min, usd=usd)[0]["A"]
        s = B.summarize(e, tab, f"theta {th:g}")
        rows.append(dict(theta=th, n=s.get("n", 0), win=s.get("win", np.nan), breakeven=s.get("breakeven", np.nan), per=s.get("per", np.nan),
                         lo=s.get("per_lo", np.nan), hi=s.get("per_hi", np.nan), net=s.get("net", 0.0)))
    return rows


# ============================================================ the deep dives of um-011's two strongest expressions (2026-10-10)
PX_BAND = {"any": (0.0, 1.0), "30-80": (0.30, 0.80), "50-70": (0.50, 0.70), "40-85": (0.40, 0.85), "50-90": (0.50, 0.90)}
EXITS = {"expiry": None, "120s": 120, "300s": 300}
FAR_CAP = {"any": 1.0, "50": 0.50, "30": 0.30, "20": 0.20}


def _gates(tab, L, z_min, theta):
    """The burst masks and the four price gates on the cent grid, plus the float32-true limits and floors (see `quotes`)."""
    zl = tab.zl[:, :, {10: 0, 30: 1, 60: 2}[L]]
    qa_lim, qd_lim = quotes(tab)
    qb_lim_up, qb_lim_dn = tab.qb.astype(float), (1.0 - tab.qa).astype(float)
    qa, qd = np.round(qa_lim, 4), np.round(qd_lim, 4)
    pu = tab.pu.astype(float)
    pdn = 1.0 - pu
    return dict(up=zl >= z_min, dn=zl <= -z_min, qa=qa, qd=qd, pu=pu, pdn=pdn, qa_lim=qa_lim, qd_lim=qd_lim, qb_lim_up=qb_lim_up, qb_lim_dn=qb_lim_dn,
                nup_up=qa < pu - theta, nup_dn=qd < pdn - theta, fop_up=qd > pdn + theta, fop_dn=qa > pu + theta)


class BuyNearDeep(Taker):
    """Test A of um-011 as a registered grid: buy the near token after a burst when its ask sits under the driftless fair value, with a price band on the ask,
    a minimum time left and an exit (hold to expiry, or sell at the bid after h seconds)."""
    id = "c7-buy-near-deep"
    title = "Buy the near token a burst left under-priced: the deep grid"

    def grid(self):
        g = []
        for L in (10, 30):
            for z in (2.5, 3.0, 4.0):
                for th in (0.03, 0.05, 0.08):
                    for band in ("any", "30-80", "50-70", "40-85", "50-90"):        # the five bands um-014 registered; PX_BAND has gained others since (the steady grid), so the grid names its own
                        for t_min in (120, 300, 600):
                            for ex in EXITS:
                                g.append(dict(name=f"L{L}|z{z:g}|th{th:g}|px{band}|T{t_min}|{ex}", L=L, z_min=z, theta=th, band=band, t_min=t_min, exit=ex))
        return g

    def fit(self, tab):
        return {}

    def triggers(self, tab, cfg, ctx):
        m = _gates(tab, cfg["L"], cfg["z_min"], cfg["theta"])
        lo, hi = PX_BAND[cfg["band"]]
        g_up = m["up"] & m["nup_up"] & (m["qa"] >= lo) & (m["qa"] <= hi)
        g_dn = m["dn"] & m["nup_dn"] & (m["qd"] >= lo) & (m["qd"] <= hi)
        side = np.where(g_up, 1, np.where(g_dn, -1, 0))
        trig = (g_up | g_dn) & tmask(tab, cfg["t_min"])
        return side, trig, np.where(side > 0, m["qa_lim"], m["qd_lim"]), EXITS[cfg["exit"]]


class SellFarDeep(S.Candidate):
    """Test B of um-011 as a registered grid: sell the far token after a burst when its ask sits over the driftless fair value (a mint-and-sell, booked as the
    near long it is), with a cap on the far token's price (the leverage), the sizing (far-token dollars, or collateral dollars), a minimum time left and an exit."""
    id = "c8-sell-far-deep"
    title = "Sell the far token a burst left over-priced: the deep grid"
    family = "taker"

    def grid(self):
        g = []
        for L in (10, 30):
            for z in (3.0, 4.0):
                for th in (0.03, 0.05, 0.08):
                    for cap in FAR_CAP:
                        for size in ("far", "collateral"):
                            for t_min in (120, 300, 600):
                                for ex in ("expiry", "300s"):
                                    g.append(dict(name=f"L{L}|z{z:g}|th{th:g}|far<={cap}|{size}|T{t_min}|{ex}", L=L, z_min=z, theta=th, cap=cap, size=size, t_min=t_min, exit=ex))
        return g

    def fit(self, tab):
        return {}

    def triggers(self, tab, cfg, ctx):
        """-> side_far (W, NK) in {-1 sell Down, +1 sell Up, 0}, trig, floor (the far bid seen at t), hold."""
        m = _gates(tab, cfg["L"], cfg["z_min"], cfg["theta"])
        cap = FAR_CAP[cfg["cap"]]
        g_up = m["up"] & m["fop_up"] & (m["qd"] <= cap)          # after an up burst the far token is Down: sell it when its ask is over fair and at most the cap
        g_dn = m["dn"] & m["fop_dn"] & (m["qa"] <= cap)
        side_far = np.where(g_up, -1, np.where(g_dn, 1, 0))
        trig = (g_up | g_dn) & tmask(tab, cfg["t_min"])
        floor = np.where(side_far < 0, m["qb_lim_dn"], m["qb_lim_up"])
        return side_far, trig, floor, EXITS[cfg["exit"]]

    def run(self, tab, cfg, ctx, fee_mult=1.0, slack=0.0, usd=B.CLIP_USD):
        side_far, trig, floor, hold = self.triggers(tab, cfg, ctx)
        if fee_mult != 1.0:
            tab = _scaled_fee(tab, fee_mult)
        return B.entries_short(tab, side_far, trig, floor - slack, usd=usd, hold=hold, size_by=cfg["size"])

    def placebo(self, tab, cfg, ctx, seed):
        side_far, trig, floor, hold = self.triggers(tab, cfg, ctx)
        m = _gates(tab, cfg["L"], cfg["z_min"], cfg["theta"])
        rng = np.random.default_rng(seed)
        rs = np.where(rng.random(side_far.shape) < 0.5, -1, 1)
        return B.entries_short(tab, rs, trig, np.where(rs < 0, m["qb_lim_dn"], m["qb_lim_up"]), hold=hold, size_by=cfg["size"])

    def peek(self, tab, cfg, ctx):
        side_far, trig, floor, hold = self.triggers(tab, cfg, ctx)
        m = _gates(tab, cfg["L"], cfg["z_min"], cfg["theta"])
        ps = np.where(tab.up[:, None], -1, 1) * np.ones(side_far.shape, int)      # sell the token that loses
        return B.entries_short(tab, ps, trig, np.where(ps < 0, m["qb_lim_dn"], m["qb_lim_up"]), hold=hold, size_by=cfg["size"])


# ============================================================ the layered grid on um-014's chosen cell (um-016, 2026-10-10): filters and exits a live engine could run
import weakref                                                       # noqa: E402

_SIG = weakref.WeakKeyDictionary()                                   # one signal set a pooled table (a table object lives as long as the notebook does)
BASE = dict(L=10, z_min=4.0, theta=0.08, band="40-85", t_min=120)   # um-014's chosen cell, the base every layered cell starts from
TIME = {"any": None, "le300": (0, 300), "ge600": (600, 901), "not300-600": "not"}
HOUR = {"any": None, "no05-11": (5, 11)}
SPREAD = {"any": None, "le2c": 2.0, "le5c": 5.0}
GAP = {"any": None, "le20c": 0.20}
RSI = {"any": None, "le80": ("le", 80.0), "ge70": ("ge", 70.0)}
LEVEL = {"any": None, "abs_le2": ("abs", 2.0), "with_gt0": ("with", 0.0)}
FLOW = {"any": None, "iz_ge1": ("iz", 1.0), "imb_ge0": ("imb", 0.0)}
LAYER_EXITS = ("expiry", "tp95", "retrace50", "lvl30", "tp95+lvl30")
FAMILIES = {"time": ("tl", TIME), "hour": ("hr", HOUR), "spread": ("sp", SPREAD), "gap": ("gp", GAP), "rsi": ("rs", RSI), "level": ("lv", LEVEL), "flow": ("fl", FLOW), "exit": ("exit", None)}


def layer_signals(tab):
    """The per-second signals the layered cells read, computed once a table: RSI(14, 1 s) on the Binance path, the Up spread in cents, the Up top-of-book
    imbalance, the Binance trade intensity z (10 s), the level z, the UTC hour (W,), and the burst retrace share. Every one is causal (`tf15_signals`)."""
    if tab not in _SIG:
        import tf15_signals as SG
        _SIG[tab] = dict(rsi=SG.rsi(tab, 14, 1), spread=SG.spread(tab), imb=SG.imbalance(tab), iz=SG.intensity_z(tab, 10), level=SG.level(tab),
                         hour=np.asarray(SG.hour(tab)), retrace=SG.retrace(tab, 10, 4.0))
    return _SIG[tab]


class BuyNearLayered(Taker):
    """um-014's chosen cell with one or more filters layered on its entry and an exit a live engine could run: time left, UTC hour, the Up spread, the fair
    gap, RSI in the burst's direction, the window's level against vol, Binance flow, and an exit (take-profit at 0.95, the burst retraced by half, the near
    bid under 0.30, or the first of take-profit and level stop). The base cell is in the grid as `base`."""
    id = "c9-buy-near-layered"
    title = "Buy the near token a burst left under fair value, with filters and exits a live engine could run"

    def grid(self):
        g = []
        seen = set()

        def add(tl="any", hr="any", sp="any", gp="any", rs="any", lv="any", fl="any", exit="expiry"):
            name = f"T{tl}|H{hr}|S{sp}|G{gp}|R{rs}|L{lv}|F{fl}|{exit}"
            if name not in seen:
                seen.add(name)
                g.append(dict(name=name, tl=tl, hr=hr, sp=sp, gp=gp, rs=rs, lv=lv, fl=fl, exit=exit, **BASE))
        add()                                                        # the base cell: um-014's choice, nothing layered
        for tl in TIME:
            add(tl=tl)
        for hr in HOUR:
            add(hr=hr)
        for sp in SPREAD:
            for gp in GAP:
                add(sp=sp, gp=gp)
        for rs in RSI:
            add(rs=rs)
        for lv in LEVEL:
            add(lv=lv)
        for fl in FLOW:
            add(fl=fl)
        for ex in LAYER_EXITS:
            add(exit=ex)
        for tl in ("any", "le300", "not300-600"):                    # the joint grid: the two strongest levels of each family, and three exits
            for hr in HOUR:
                for sp in ("any", "le5c"):
                    for gp in GAP:
                        for rs in ("any", "le80"):
                            for lv in ("any", "abs_le2"):
                                for fl in ("any", "iz_ge1"):
                                    for ex in ("expiry", "tp95", "retrace50"):
                                        add(tl, hr, sp, gp, rs, lv, fl, ex)
        return g

    def fit(self, tab):
        return {}

    def triggers(self, tab, cfg, ctx):
        m = _gates(tab, cfg["L"], cfg["z_min"], cfg["theta"])
        sg = layer_signals(tab)
        lo, hi = PX_BAND[cfg["band"]]
        g_up = m["up"] & m["nup_up"] & (m["qa"] >= lo) & (m["qa"] <= hi)
        g_dn = m["dn"] & m["nup_dn"] & (m["qd"] >= lo) & (m["qd"] <= hi)
        side = np.where(g_up, 1, np.where(g_dn, -1, 0))
        ok = tmask(tab, cfg["t_min"])
        T = tab.T[None, :]
        with np.errstate(invalid="ignore"):
            t = TIME[cfg["tl"]]
            if t == "not":
                ok = ok & ((T < 300) | (T >= 600))
            elif t is not None:
                ok = ok & (T >= t[0]) & (T < t[1])
            h = HOUR[cfg["hr"]]
            if h is not None:
                ok = ok & ~((sg["hour"] >= h[0]) & (sg["hour"] < h[1]))[:, None]
            s = SPREAD[cfg["sp"]]
            if s is not None:
                ok = ok & (sg["spread"] >= 0) & (sg["spread"] <= s)
            gcap = GAP[cfg["gp"]]
            if gcap is not None:
                gap = np.where(side > 0, m["pu"] - m["qa"], m["pdn"] - m["qd"])
                ok = ok & (gap <= gcap)
            r = RSI[cfg["rs"]]
            if r is not None:
                rdir = np.where(side > 0, sg["rsi"], 100.0 - sg["rsi"])          # RSI in the burst's direction
                ok = ok & ((rdir <= r[1]) if r[0] == "le" else (rdir >= r[1]))
            lv = LEVEL[cfg["lv"]]
            if lv is not None:
                ok = ok & ((np.abs(sg["level"]) <= lv[1]) if lv[0] == "abs" else (sg["level"] * side > lv[1]))
            f = FLOW[cfg["fl"]]
            if f is not None:
                ok = ok & ((sg["iz"] >= f[1]) if f[0] == "iz" else (sg["imb"] * side >= f[1]))
        trig = (side != 0) & ok
        return side, trig, np.where(side > 0, m["qa_lim"], m["qd_lim"]), None

    def _exit(self, tab, e, cfg):
        """The cell's exit on an entries dict: the first of its conditions after the entry, sold into the near bid ladder (`tf15_exits`)."""
        if cfg["exit"] == "expiry" or len(e["net"]) == 0:
            e = dict(e)
            e["ke"] = np.full(len(e["net"]), -1); e["exit_reason"] = np.array(["hold"] * len(e["net"]), dtype=object)
            return e
        import tf15_exits as X
        sg = layer_signals(tab)
        conds = {}
        for part in cfg["exit"].split("+"):
            if part == "tp95":
                conds["tp95"] = X.take_profit(tab, e, 0.95)
            elif part == "lvl30":
                conds["lvl30"] = X.level_stop(tab, e, 0.30)
            elif part == "retrace50":
                conds["retrace50"] = X._rowmat(np.nan_to_num(sg["retrace"][np.asarray(e["w"])], nan=0.0) >= 0.5)
            else:
                raise ValueError(part)
        ke, reason = X.first_reason(tab, e, conds, min_hold=1)
        return X.apply_exit(tab, e, ke, reason=reason)

    def run(self, tab, cfg, ctx, fee_mult=1.0, slack=0.0, usd=B.CLIP_USD):
        side, trig, lim, _ = self.triggers(tab, cfg, ctx)
        t = _scaled_fee(tab, fee_mult) if fee_mult != 1.0 else tab
        return self._exit(t, B.entries(t, side, trig, lim + slack, usd=usd), cfg)

    def placebo(self, tab, cfg, ctx, seed):
        side, trig, lim, _ = self.triggers(tab, cfg, ctx)
        qa, qd = quotes(tab)
        rng = np.random.default_rng(seed)
        rs = np.where(rng.random(side.shape) < 0.5, 1, -1)
        return self._exit(tab, B.entries(tab, rs, trig, np.where(rs > 0, qa, qd)), cfg)

    def peek(self, tab, cfg, ctx):
        side, trig, lim, _ = self.triggers(tab, cfg, ctx)
        qa, qd = quotes(tab)
        ps = np.where(tab.up[:, None], 1, -1) * np.ones(side.shape, int)
        return self._exit(tab, B.entries(tab, ps, trig, np.where(ps > 0, qa, qd)), cfg)



class BuyNearBtc(BuyNearLayered):
    """um-017: um-014's base cell (`BASE`, held to expiry) on BITCOIN windows only, one cell, nothing chosen. The coin cut was read after the fact on 38 days
    (lab/research/data/buy-near-by-coin-read-2026-10-10.md: btc +1.37 an entry on 333 out-of-sample entries, +0.40 without its best 5%), so the only test is
    the forward days registered before any of them was seated. The placebo and the peek inherit the btc cut through `triggers`."""
    id = "c10-buy-near-btc"
    title = "Buy the near token a burst left under fair value, Bitcoin only, um-014's cell held to expiry"
    ASSET = 0                                                        # updown15_day.ASSETS: btc, eth, sol, xrp

    def grid(self):
        return [dict(name="btc|L10|z4|th0.08|px40-85|T120|expiry", tl="any", hr="any", sp="any", gp="any", rs="any", lv="any", fl="any", exit="expiry", **BASE)]

    def triggers(self, tab, cfg, ctx):
        side, trig, lim, x = super().triggers(tab, cfg, ctx)
        return side, trig & (np.asarray(tab.w_asset) == self.ASSET)[:, None], lim, x


# ------------------------------------------------------------------ C11: the burst crossed with confirming signals and exits (um-018)
# Each confirming signal is a causal (W, NK) condition read in the BURST's direction (side = the sign of the 10 s z). Its family keeps two members of one
# idea out of the same cell (with and against, high and low, a looser and a stricter cut of one number).
COMBO_SIGNALS = {
    "z30":        ("trend",  "the 30 s Binance z is at least 2 in the burst's direction (a longer move confirms)"),
    "z60":        ("trend",  "the 60 s Binance z is at least 2 in the burst's direction"),
    "lvlwith":    ("level",  "the window's level z is on the burst's side of the start (the burst extends a lead)"),
    "lvlagainst": ("level",  "the window's level z is on the other side (the burst pushes back toward the start)"),
    "iz1":        ("flow",   "Binance trade intensity (10 s) at least 1 sd over the window's own running mean"),
    "iz2":        ("flow",   "Binance trade intensity at least 2 sd over its running mean"),
    "imbwith":    ("book",   "the Up book's top-of-book size leans the burst's way (imbalance times side at or over 0)"),
    "sp2":        ("spread", "the Up spread is at most 2 cents"),
    "tapewith":   ("tape",   "Polymarket takers bought the near token on net over the last 10 s"),
    "tapequiet":  ("tape",   "no Polymarket print in the last 10 s (the book has not traded since before the burst)"),
    "volhi":      ("vol",    "the window's vol is in the top half of the coin's earlier windows at this second"),
    "vollo":      ("vol",    "the window's vol is in the bottom half"),
    "rsile80":    ("rsi",    "RSI(14, 1 s) in the burst's direction at most 80 (not stretched)"),
    "fresh":      ("fresh",  "the first second of a 3-sigma burst (burst_run 1): the book has had no second to re-price"),
    "late":       ("time",   "under 300 s left"),
    "early":      ("time",   "600 s or more left"),
    "hourok":     ("hour",   "the window does not start 05:00 to 11:00 UTC (where um-016's train losses sat)"),
}
COMBO_GATES = {"nogate": None, "fair04": 0.04, "fair08": 0.08}
COMBO_EXITS = ("expiry", "tp90", "tp95", "lvl30", "bid20", "rev2", "fair0", "tp95+lvl30")
NO_RETRY = True                        # one order per signal onset; a miss at the ladder is not chased (the owner, 2026-10-10)
_CSIG = {}


def combo_signals(tab):
    """The confirming conditions of `COMBO_SIGNALS` on `tab`, in the burst's direction, computed once a table (`tf15_signals`, every one causal)."""
    if tab in _CSIG:
        return _CSIG[tab]
    import tf15_signals as SG
    side = SG.default_side(tab).astype(np.float32)
    zl = tab.zl
    shape = side.shape
    with np.errstate(invalid="ignore"):
        tp = SG.tape(tab, 10)
        rs = SG.rsi(tab, 14, 1)
        vr = SG.vol_regime(tab)
        hr = np.asarray(SG.hour(tab))
        lv = SG.level(tab) * side
        iz = SG.intensity_z(tab, 10)
        spr = SG.spread(tab)
        out = {
            "z30": zl[:, :, 1] * side >= 2.0, "z60": zl[:, :, 2] * side >= 2.0,
            "lvlwith": lv > 0, "lvlagainst": lv < 0,
            "iz1": iz >= 1.0, "iz2": iz >= 2.0,
            "imbwith": SG.imbalance(tab) * side >= 0, "sp2": (spr >= 0) & (spr <= 2.0),
            "tapewith": tp["vol"] * side > 0, "tapequiet": tp["n"] == 0,
            "volhi": vr >= 0.5, "vollo": vr < 0.5,
            "rsile80": np.where(side > 0, rs, 100.0 - rs) <= 80.0,
            "fresh": SG.burst_run(tab, 10, 3.0) == 1,
            "late": np.broadcast_to(tab.T[None, :] < 300, shape), "early": np.broadcast_to(tab.T[None, :] >= 600, shape),
            "hourok": np.broadcast_to(~((hr >= 5) & (hr < 11))[:, None], shape),
        }
    _CSIG[tab] = out
    return out


class BuyNearCombo(BuyNearLayered):
    """um-018: buy the near token on a 10 s Binance burst (|z| 3 or 4) only when one or two confirming signals of different families agree, with the fair-value
    gate off, at 4 cents or at 8 cents, on every coin or on Bitcoin alone; the near ask between 0.40 and 0.85, at least 120 s left. Every entry rule is held
    to expiry; the entry rules with at most one confirming signal are also crossed with seven exits (take-profit 0.90 or 0.95, level stop 0.30, the bid 20
    cents under the price paid, a 2-sigma reversal of the burst, the bid under fair value, take-profit 0.95 with the level stop). One order per onset of the
    cell's condition (`NO_RETRY`): a miss at the ladder is not retried until the condition falls and rises again."""
    id = "c11-buy-near-combo"
    title = "Buy the near token on a Binance burst confirmed by one or two other signals, with exits"

    def grid(self):
        names = list(COMBO_SIGNALS)
        fam = {k: v[0] for k, v in COMBO_SIGNALS.items()}
        sets = [()] + [(a,) for a in names] + [(a, b) for i, a in enumerate(names) for b in names[i + 1:] if fam[a] != fam[b]]
        g = []
        for coin in ("all", "btc"):
            for z in (3.0, 4.0):
                for gate in COMBO_GATES:
                    for sg in sets:
                        for ex in (COMBO_EXITS if len(sg) <= 1 else ("expiry",)):
                            g.append(dict(name=f"{coin}|z{z:g}|{gate}|{'+'.join(sg) or 'burst'}|{ex}", coin=coin, sigs=sg, gate=gate, exit=ex, L=10, z_min=z,
                                          theta=COMBO_GATES[gate] or 0.0, band="40-85", t_min=120, tl="any", hr="any", sp="any", gp="any", rs="any", lv="any", fl="any"))
        return g

    def triggers(self, tab, cfg, ctx):
        m = _gates(tab, cfg["L"], cfg["z_min"], cfg["theta"])
        lo, hi = PX_BAND[cfg["band"]]
        g_up = m["up"] & (m["qa"] >= lo) & (m["qa"] <= hi)
        g_dn = m["dn"] & (m["qd"] >= lo) & (m["qd"] <= hi)
        if cfg["gate"] != "nogate":
            g_up, g_dn = g_up & m["nup_up"], g_dn & m["nup_dn"]
        side = np.where(g_up, 1, np.where(g_dn, -1, 0))
        ok = tmask(tab, cfg["t_min"]) & (side != 0)
        cs = combo_signals(tab)
        for k in cfg["sigs"]:
            ok = ok & cs[k]
        if cfg["coin"] == "btc":
            ok = ok & (np.asarray(tab.w_asset) == 0)[:, None]
        if NO_RETRY:
            # the owner (2026-10-10): an order that does not fill at the ladder 250 ms later is not sent again while the same signal stays on; the next order
            # goes out only when the cell's condition has fallen and risen again (a new signal). So the trigger is the onset of the condition, not every second of it.
            prev = np.zeros_like(ok)
            prev[:, 1:] = ok[:, :-1]
            ok = ok & ~prev
        return side, ok, np.where(side > 0, m["qa_lim"], m["qd_lim"]), None

    def _exit(self, tab, e, cfg):
        if cfg["exit"] == "expiry" or len(e["net"]) == 0:
            return super()._exit(tab, e, dict(cfg, exit="expiry"))
        import tf15_exits as X
        conds = {}
        for part in cfg["exit"].split("+"):
            if part.startswith("tp"):
                conds[part] = X.take_profit(tab, e, int(part[2:]) / 100.0)
            elif part == "lvl30":
                conds[part] = X.level_stop(tab, e, 0.30)
            elif part == "bid20":
                conds[part] = X.bid_stop(tab, e, 0.20)
            elif part == "rev2":
                conds[part] = X.reversal(tab, e, 10, 2.0)
            elif part == "fair0":
                conds[part] = X.fair_stop(tab, e, 0.0)
            else:
                raise ValueError(part)
        ke, reason = X.first_reason(tab, e, conds, min_hold=1)
        return X.apply_exit(tab, e, ke, reason=reason)


FORWARD_LEADERS = ("btc|z4|fair08|z60+fresh|expiry", "btc|z3|nogate|lvlwith+tapequiet|expiry", "btc|z4|fair08|early+hourok|expiry",
                   "all|z3|fair08|tapequiet+hourok|expiry", "btc|z3|fair04|rsile80+hourok|expiry")


class BuyNearForward(BuyNearCombo):
    """um-019: um-018's chosen cell and its four two-signal leaders (positive without their best 5% on both the train and the validation days of um-018, 30 or
    more entries on each), as five fixed cells; the one with the best validation score is read once on the forward days registered before any was seated.
    Everything else is `BuyNearCombo` (one order per signal onset, held to expiry)."""
    id = "c12-buy-near-forward"
    title = "Buy the near token on a confirmed Binance burst: um-018's leaders on days nobody had seen"

    def grid(self):
        by = {c["name"]: c for c in BuyNearCombo.grid(self)}
        return [by[n] for n in FORWARD_LEADERS]

def family_of(name: str) -> str:
    """Which single family a grid cell varies from the base ('base', 'joint', or the family name)."""
    bits = name.split("|")
    parts = {p[0]: p[1:] for p in bits[:-1]}                     # "Tle300" -> {"T": "le300"}
    ex = bits[-1]
    varied = [k for k, v in parts.items() if v != "any"]
    if ex != "expiry":
        varied.append("exit")
    if not varied:
        return "base"
    if len(varied) == 1:
        return {"T": "time", "H": "hour", "S": "spread", "G": "gap", "R": "rsi", "L": "level", "F": "flow", "exit": "exit"}[varied[0]]
    if set(varied) <= {"S", "G"}:
        return "book"
    return "joint"


# ============================================================ the steady-climb grid (um-020, 2026-10-10): the logical variants of the buy-near rule, chosen by the shape of the climb
PX_BAND.update({"60-85": (0.60, 0.85), "70-90": (0.70, 0.90)})
STEADY_COIN = {"all": None, "btc": 0}
STEADY_SLOT = {"any": False, "one": True}                            # one order per 15-minute slot across the four coins (the first onset wins)


def onset(ok):
    """The first second of each run of True in a (W, NK) condition: one order per onset, a miss at the ladder is not chased (the owner, 2026-10-10)."""
    prev = np.zeros_like(ok)
    prev[:, 1:] = ok[:, :-1]
    return ok & ~prev


def one_per_slot(tab, trig):
    """Keep one order per 15-minute slot across the coins: the window with the earliest trigger second in the slot keeps only that second (ties to the lowest
    asset index, btc first); every other window of the slot is dropped. A live engine does the same by marking the slot spent at its first order."""
    first = np.where(trig.any(1), trig.argmax(1), tab.NK)
    order = np.lexsort((np.asarray(tab.w_asset), first, np.asarray(tab.slot)))
    slots = np.asarray(tab.slot)[order]
    new = np.concatenate([[True], slots[1:] != slots[:-1]])
    keep_w = order[new & (first[order] < tab.NK)]
    out = np.zeros_like(trig)
    out[keep_w, first[keep_w]] = True
    return out


class BuyNearSteady(BuyNearLayered):
    """um-020: the logical variants of the buy-near rule, held to expiry, one order per onset, chosen by the shape of the climb (the daily Sharpe on the
    validation days among cells above zero without their best 5% on both windows): the coin (all, or Bitcoin), the near ask band (0.40-0.85 as before,
    0.60-0.85 and 0.70-0.90 for smaller, steadier wins), one order per 15-minute slot across the coins (or not), the burst (|z| 3 or 4), the discount to fair value
    under fair (4 or 8 cents) and the time left (120 or 300 s). No exits: um-016 and um-018 showed every exit worth less than holding."""
    id = "c13-buy-near-steady"
    title = "Buy the near token a burst left under fair value: the steady-climb variants"

    def grid(self):
        g = []
        for coin in STEADY_COIN:
            for band in ("40-85", "60-85", "70-90"):
                for slot in STEADY_SLOT:
                    for z in (3.0, 4.0):
                        for th in (0.04, 0.08):
                            for t_min in (120, 300):
                                g.append(dict(name=f"{coin}|px{band}|slot{slot}|z{z:g}|th{th:g}|T{t_min}|expiry", coin=coin, band=band, slot=slot, L=10, z_min=z, theta=th, t_min=t_min,
                                              exit="expiry", tl="any", hr="any", sp="any", gp="any", rs="any", lv="any", fl="any"))
        return g

    def triggers(self, tab, cfg, ctx):
        m = _gates(tab, cfg["L"], cfg["z_min"], cfg["theta"])
        lo, hi = PX_BAND[cfg["band"]]
        g_up = m["up"] & m["nup_up"] & (m["qa"] >= lo) & (m["qa"] <= hi)
        g_dn = m["dn"] & m["nup_dn"] & (m["qd"] >= lo) & (m["qd"] <= hi)
        side = np.where(g_up, 1, np.where(g_dn, -1, 0))
        ok = tmask(tab, cfg["t_min"]) & (side != 0)
        if STEADY_COIN[cfg["coin"]] is not None:
            ok = ok & (np.asarray(tab.w_asset) == STEADY_COIN[cfg["coin"]])[:, None]
        ok = onset(ok)
        if STEADY_SLOT[cfg["slot"]]:
            ok = one_per_slot(tab, ok)
        return side, ok, np.where(side > 0, m["qa_lim"], m["qd_lim"]), None


STEADY_FAMILY = {"coin": 0, "band": 1, "slot": 2, "z": 3, "theta": 4, "time": 5}


def steady_family_of(name: str) -> str:
    """Which single dimension a steady cell varies from the base `all|px40-85|slotany|z4|th0.08|T120|expiry` ('base', the dimension, or 'joint')."""
    base = "all|px40-85|slotany|z4|th0.08|T120|expiry".split("|")
    bits = name.split("|")
    varied = [k for k, i in STEADY_FAMILY.items() if bits[i] != base[i]]
    return "base" if not varied else (varied[0] if len(varied) == 1 else "joint")


def steady_score(s):
    """The choice: the annualised daily Sharpe (a steady climb), only for a cell above zero without its best 5% with 30 or more entries; else nothing."""
    if s.get("n", 0) < 30 or not (s.get("per_ex_top5", -1) > 0):
        return -1e9
    v = s.get("sharpe_daily", float("nan"))
    return float(v) if np.isfinite(v) else -1e9


# ============================================================ the stale-book study (um-023, 2026-10-11): test E as a strategy
# Test E of um-021 is rule A plus "the near token's ask equals its ask 3 seconds earlier" (`ask_still`, endpoints only: an ask that moved and came back
# counts). The study reads that window n and two stricter definitions of a book that has not moved, then registers a grid on them (`BuyNearStale`).
STALE_DEFS = {"a": "the near ask now equals the near ask n seconds ago (endpoints only: an ask that moved and came back counts; test E as built)",
              "b": "the near ask is unchanged at every second of the last n seconds",
              "c": "the near ask AND its size at the touch are unchanged at every second of the last n seconds (nobody traded or re-quoted the touch)"}
STALE_BANDS = {"any": (0.0, 1.0), "40-85": (0.40, 0.85)}          # the grid's own two ask bands, named here (never iterate PX_BAND, which other grids widen)
_STALE = weakref.WeakKeyDictionary()                               # one cache a pooled table: quotes, runs, bursts, gates


def _run_len(eq):
    """For a (W, NK) bool matrix eq[:, k] = 'the quote at k equals the quote at k - 1' (False at k = 0), the number of consecutive True values ending at k
    (0 where eq is False). Causal: column k reads columns <= k only. -> int16 (W, NK)."""
    W, NK = eq.shape
    idx = np.broadcast_to(np.arange(NK, dtype=np.int32), (W, NK))
    brk = np.where(eq, 0, idx).astype(np.int32)
    np.maximum.accumulate(brk, axis=1, out=brk)
    return (idx - brk).astype(np.int16)


def still_runs(tab, sizes=False):
    """(Up-ask run, Down-ask run): at each decision second, how many seconds in a row the near quote has stayed the same, int16 (W, NK). The Down ask is
    1 - the Up bid, so the Down run reads the Up bid. `sizes` True also requires the size at that touch to be unchanged (the Up ask size; for Down the Up bid
    size). Equality is the table's own float32, as `ask_still` compares; an empty quote breaks a run."""
    out = []
    for px, sz in ((tab.qa, tab.qas), (tab.qb, tab.qbs)):
        eq = np.zeros(px.shape, bool)
        with np.errstate(invalid="ignore"):
            eq[:, 1:] = np.isfinite(px[:, 1:]) & (px[:, 1:] == px[:, :-1])
            if sizes:
                eq[:, 1:] &= np.isfinite(sz[:, 1:]) & (sz[:, 1:] == sz[:, :-1])
        out.append(_run_len(eq))
    return out[0], out[1]


def ask_still_all(tab, n=3):
    """Definition (b): (Up ask unchanged at every second of the last n s, Down ask the same), causal, False in the first n seconds. n = 0 is no condition
    beyond a quote being there."""
    if n <= 0:
        return np.isfinite(tab.qa), np.isfinite(tab.qb)
    ru, rd = still_runs(tab, sizes=False)
    return ru >= n, rd >= n


def touch_still(tab, n=3):
    """Definition (c): (Up ask and its size unchanged at every second of the last n s, Down the same through the Up bid and its size), causal, False in the
    first n seconds. n = 0 is no condition beyond a quote being there."""
    if n <= 0:
        return np.isfinite(tab.qa), np.isfinite(tab.qb)
    ru, rd = still_runs(tab, sizes=True)
    return ru >= n, rd >= n


def stale_cache(tab):
    """The per-table pieces every stale cell reads, computed once: the limits in float32-true arithmetic, the gates' quotes on the cent grid, the runs of
    definitions (b) and (c). Bursts and discounts are added on demand (`_stale_mask`)."""
    if tab not in _STALE:
        qa_lim, qd_lim = quotes(tab)
        rb_u, rb_d = still_runs(tab, sizes=False)
        rc_u, rc_d = still_runs(tab, sizes=True)
        _STALE[tab] = dict(qa_lim=qa_lim, qd_lim=qd_lim, qa=np.round(qa_lim, 4), qd=np.round(qd_lim, 4), pu=tab.pu.astype(float),
                           runs={"b": (rb_u, rb_d), "c": (rc_u, rc_d)}, memo={})
    return _STALE[tab]


def _stale_mask(tab, key):
    """One cached mask pair of the stale grid: ("burst", L, z), ("nup", theta), ("band", band), ("lim", L)."""
    c = stale_cache(tab)
    m = c["memo"]
    if key not in m:
        kind = key[0]
        if kind == "burst":
            zl = tab.zl[:, :, {10: 0, 30: 1, 60: 2}[key[1]]]
            m[key] = (zl >= key[2], zl <= -key[2])
        elif kind == "nup":
            m[key] = (c["qa"] < c["pu"] - key[1], c["qd"] < (1.0 - c["pu"]) - key[1])
        elif kind == "band":
            lo, hi = STALE_BANDS[key[1]]
            m[key] = ((c["qa"] >= lo) & (c["qa"] <= hi), (c["qd"] >= lo) & (c["qd"] <= hi))
        elif kind == "lim":                                       # where a cell triggers, its side is the burst's sign, so the limit is fixed by L alone
            zl = tab.zl[:, :, {10: 0, 30: 1, 60: 2}[key[1]]]
            m[key] = np.where(zl > 0, c["qa_lim"], c["qd_lim"])
        else:
            raise KeyError(key)
    return m[key]


def _stale_feed(tab):
    m = stale_cache(tab)["memo"]
    if ("feed",) not in m:
        m[("feed",)] = feed_live(tab)
    return m[("feed",)]


def stale_masks(tab, kind, n):
    """(Up, Down) of the stale condition `kind` (a, b, c of STALE_DEFS) over the last n seconds; n = 0 is no condition beyond a quote being there."""
    if n <= 0:
        return np.isfinite(tab.qa), np.isfinite(tab.qb)
    if kind == "a":
        return ask_still(tab, n)
    if kind in ("b", "c"):
        ru, rd = stale_cache(tab)["runs"][kind]
        return ru >= n, rd >= n
    raise ValueError(f"stale definition {kind!r} is not one of {tuple(STALE_DEFS)}")


class BuyNearStale(Taker):
    """um-023: test E of um-021 as a registered grid. Buy the near token after an L-second Binance burst of |z| at least z_min when its ask sits more than
    theta under the driftless fair value, inside the ask band, with at least t_min seconds left, and the book has not moved by the stale definition over the
    last n seconds; hold to expiry, one entry a window, retry each second (as `near_tests` does). Every level is named here. `reduced` is the registered
    fallback the brief allows when the full grid would run too long (L 10 only, t_min 120 or 300)."""
    id = "c14-buy-near-stale"
    title = "Buy the near token a burst left under fair value while the book has not moved: the stale-book grid"
    LEVELS = dict(kind=("a", "b", "c"), n=(1, 2, 3, 5, 8, 12), theta=(0.03, 0.05, 0.08), z_min=(2.5, 3.0, 4.0), L=(10, 30), t_min=(120, 300, 600),
                  band=("any", "40-85"))
    REDUCED = dict(L=(10,), t_min=(120, 300))

    def __init__(self, reduced=False, feed=False):
        self.reduced = bool(reduced)
        self.feed = bool(feed)               # True refuses a decision on a slot-wide silent feed (`feed_live`); off replays the grid as run before 2026-10-11

    def levels(self):
        lv = dict(self.LEVELS)
        if self.reduced:
            lv.update(self.REDUCED)
        return lv

    @staticmethod
    def cell(kind="a", n=3, theta=0.05, z_min=3.0, L=10, t_min=300, band="any"):
        return dict(name=f"{kind}{n}|th{theta:g}|z{z_min:g}|L{L}|T{t_min}|px{band}", kind=kind, n=int(n), theta=float(theta), z_min=float(z_min), L=int(L),
                    t_min=int(t_min), band=band)

    def grid(self):
        lv = self.levels()
        return [self.cell(k, n, th, z, L, t, b) for k in lv["kind"] for n in lv["n"] for th in lv["theta"] for z in lv["z_min"] for L in lv["L"]
                for t in lv["t_min"] for b in lv["band"]]

    def fit(self, tab):
        return {}

    def triggers(self, tab, cfg, ctx=None):
        up, dn = _stale_mask(tab, ("burst", cfg["L"], cfg["z_min"]))
        nu, nd = _stale_mask(tab, ("nup", cfg["theta"]))
        bu, bd = _stale_mask(tab, ("band", cfg["band"]))
        su, sd = stale_masks(tab, cfg["kind"], cfg["n"])
        g_up = up & nu & bu & su
        g_dn = dn & nd & bd & sd
        if self.feed:
            fl = _stale_feed(tab)
            g_up, g_dn = g_up & fl, g_dn & fl
        side = g_up.astype(np.int8) - g_dn.astype(np.int8)
        trig = (g_up | g_dn) & tmask(tab, cfg["t_min"])
        return side, trig, _stale_mask(tab, ("lim", cfg["L"])), None

    def gates(self, tab, cfg):
        """(gate_up, gate_dn) before the time mask, the shape `near_tests` returns in its masks (for `tf15_oos` and `tf15_capacity`)."""
        up, dn = _stale_mask(tab, ("burst", cfg["L"], cfg["z_min"]))
        nu, nd = _stale_mask(tab, ("nup", cfg["theta"]))
        bu, bd = _stale_mask(tab, ("band", cfg["band"]))
        su, sd = stale_masks(tab, cfg["kind"], cfg["n"])
        fl = _stale_feed(tab) if self.feed else True
        return up & nu & bu & su & fl, dn & nd & bd & sd & fl
