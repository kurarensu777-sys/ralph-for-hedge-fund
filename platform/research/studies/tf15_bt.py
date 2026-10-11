"""The backtest of the strategy search (B-0654): a rule over the decision table in, settled entries and their statistics out. numpy only, no I/O except `load`.

THE FILL. A rule fires at second k of a window (it has read the book as of t and Binance as of t). The order reaches the venue FILL_MS later and takes what the
ladder as of t + FILL_MS offers, best level first, never above the rule's limit price, for CLIP_USD (4 levels deep); under the venue minimum of 5 shares it
does not fill and a later trigger of the same window is tried. One entry per window. The taker fee is the market's own, `rate x p x (1 - p)` per share, paid
on the way in and, for an exit before expiry, on the way out. A held token pays 1 or 0 by the venue's own resolution (`w_up`), read only in `settle`.
THE COUNT. A window is the unit of the entry, a 15-minute SLOT (the four coins that start together move together) is the unit of the error: every interval
resamples slots, never entries.
"""
from __future__ import annotations

import numpy as np

import tf15_runner as RN

CLIP_USD = 20.0
MIN_SHARES = 5.0
WIN_S = 900
K0 = 5
SLOTS_PER_DAY = 96
RAGGED = {"p": ("w", "t", "px", "sz", "side"), "e": ("w", "t", "S", "known", "sig")}      # prints and Binance events


# ============================================================ the pooled table
class Tab:
    """The usable windows of several days, concatenated. `day` is the position of the window's day in `days`."""

    KEYS = ("S", "z", "sig", "pu", "zl", "qb", "qa", "qbs", "qas", "lad", "age", "known", "path")

    def __init__(self, days, assets=None, fill_ms: int = 150):
        self.days = list(days)
        parts = []
        for d in self.days:
            arrs, meta = RN.load(d, fill_ms)
            ok = arrs["w_status"] == 0
            if assets is not None:
                ok &= np.isin(arrs["w_asset"], list(assets))
            parts.append((arrs, ok, meta))
        cat = lambda k: np.concatenate([a[k][ok] for a, ok, _ in parts])      # noqa: E731
        for k in self.KEYS + ("w_asset", "w_start", "w_up", "w_a0", "w_aend", "w_fee", "w_exp", "w_min", "w_ptb", "w_final", "w_first_ms"):
            setattr(self, k, cat(k))
        self.day = np.concatenate([np.full(int(ok.sum()), i, np.int16) for i, (_, ok, _) in enumerate(parts)])
        self.W, self.NK = self.pu.shape
        self.T = (WIN_S - (K0 + np.arange(self.NK))).astype(float)           # seconds left at second k
        self.up = self.w_up.astype(bool)
        self.slot = (self.w_start // 900_000).astype(np.int64)               # one id per 15-minute slot, shared by the four coins
        self.meta = [m for _, _, m in parts]
        # ragged columns (Polymarket prints p_*, Binance events e_*), re-indexed to the pooled window numbers; windows ascend, so p_off / e_off slice one window
        for fam, cols in RAGGED.items():
            got = {c: [] for c in cols}
            base = 0
            for arrs, ok, _ in parts:
                remap = np.full(len(ok), -1, np.int64)
                remap[ok] = base + np.arange(int(ok.sum()))
                w = remap[arrs[f"{fam}_w"]]
                keep = w >= 0
                got["w"].append(w[keep])
                for c in cols[1:]:
                    got[c].append(arrs[f"{fam}_{c}"][keep])
                base += int(ok.sum())
            # the stored rows come in HOUR order, not window order (found 2026-10-10: about 6% of windows' slices held another window's rows), so a
            # stable sort by window makes the offsets below slice one window each; within a window the stored (time) order is kept
            w_all = np.concatenate(got["w"])
            order = np.argsort(w_all, kind="stable")
            for c in cols:
                setattr(self, f"{fam}_{c}", np.concatenate(got[c])[order])
            self._offsets(fam)

    def _offsets(self, fam):
        w = getattr(self, f"{fam}_w")
        assert np.all(np.diff(w) >= 0), f"{fam} rows are not in window order: the offsets would slice the wrong rows"
        setattr(self, f"{fam}_off", np.searchsorted(w, np.arange(self.W + 1)))

    def subset(self, mask_w):
        """A view of the windows where `mask_w` (length W) is true."""
        out = object.__new__(Tab)
        out.days = self.days
        idx = np.flatnonzero(mask_w)
        for k in self.KEYS + ("w_asset", "w_start", "w_up", "w_a0", "w_aend", "w_fee", "w_exp", "w_min", "w_ptb", "w_final", "w_first_ms", "day", "up", "slot"):
            setattr(out, k, getattr(self, k)[idx])
        out.W, out.NK, out.T, out.meta = len(idx), self.NK, self.T, self.meta
        remap = np.full(self.W, -1, np.int64)
        remap[idx] = np.arange(len(idx))
        for fam, cols in RAGGED.items():
            w = remap[getattr(self, f"{fam}_w")]
            keep = w >= 0
            setattr(out, f"{fam}_w", w[keep])
            for c in cols[1:]:
                setattr(out, f"{fam}_{c}", getattr(self, f"{fam}_{c}")[keep])
            out._offsets(fam)
        return out


def ladder_of(tab: Tab, w, k, side, buy: bool = True):
    """(px, sz) of shape (N, 4) at windows w, seconds k, for the token `side` (+1 Up, -1 Down). buy -> its asks, else its bids; best level first.
    The Down token is the mirror of the Up book: a Down ask at 1 - an Up bid (same size), a Down bid at 1 - an Up ask."""
    lad = tab.lad[w, :, k, :]                      # (N, 4, L)
    s = np.asarray(side)[:, None]
    if buy:
        px = np.where(s > 0, lad[:, 2], 1.0 - lad[:, 0])
        sz = np.where(s > 0, lad[:, 3], lad[:, 1])
    else:
        px = np.where(s > 0, lad[:, 0], 1.0 - lad[:, 2])
        sz = np.where(s > 0, lad[:, 1], lad[:, 3])
    return np.round(px, 4), sz


def walk_buy(px, sz, usd, limit, rate):
    """Take `usd` from an ask ladder (N, L), best first, never above `limit` (N,). -> shares, cost, fee, best px (all N)."""
    N, Lv = px.shape
    left = np.full(N, float(usd))
    shares = np.zeros(N)
    cost = np.zeros(N)
    fee = np.zeros(N)
    for j in range(Lv):
        p, s = px[:, j], sz[:, j]
        good = np.isfinite(p) & np.isfinite(s) & (s > 0) & (p <= limit + 1e-9) & (left >= 0.01) & (p > 0)
        take = np.where(good, np.minimum(s, np.floor(np.where(good, left / np.where(p > 0, p, 1), 0) * 100.0) / 100.0), 0.0)
        shares += take
        cost += take * np.where(good, p, 0.0)
        fee += take * rate * np.where(good, p * (1.0 - p), 0.0)
        left -= take * np.where(good, p, 0.0)
    return shares, cost, fee, px[:, 0]


def walk_sell(px, sz, shares, rate, floor=None):
    """Sell `shares` into a bid ladder (N, L), best first, never below `floor` (N,) when one is given. -> sold, proceeds, fee."""
    N, Lv = px.shape
    left = shares.astype(float).copy()
    proceeds = np.zeros(N)
    fee = np.zeros(N)
    sold = np.zeros(N)
    lo = np.full(N, -np.inf) if floor is None else np.asarray(floor, float)
    for j in range(Lv):
        p, s = px[:, j], sz[:, j]
        good = np.isfinite(p) & np.isfinite(s) & (s > 0) & (left > 1e-9) & (p >= lo - 1e-9)
        take = np.where(good, np.minimum(s, left), 0.0)
        pp = np.where(good, p, 0.0)
        proceeds += take * pp
        fee += take * rate * pp * (1.0 - pp)
        left -= take
        sold += take
    return sold, proceeds, fee


# ============================================================ the entries
def entries(tab: Tab, side, trig, limit, usd=CLIP_USD, hold=None, one_per_window=True, delay_extra_k=0):
    """Settled entries of a rule. side (W, NK) in {-1, 0, +1}, trig (W, NK) bool, limit (W, NK) the highest price the rule pays for its token.
    hold None: keep to expiry. hold h (seconds): sell into the bid ladder at second k + h (what is left unsold at the bid is held to expiry).
    -> dict of arrays (one row per entry) in window order."""
    trig = trig & (side != 0) & np.isfinite(limit)
    if hold is not None:
        trig = trig & (tab.T[None, :] > hold + 1) & (np.arange(tab.NK)[None, :] + int(hold) <= tab.NK - 1)       # the sale second must exist
    w, k = np.nonzero(trig)
    if len(w) == 0:
        return _empty()
    s = side[w, k].astype(int)
    px, sz = ladder_of(tab, w, k, s, buy=True)
    rate = tab.w_fee[w].astype(float)
    shares, cost, fee, best = walk_buy(px, sz, usd, limit[w, k], rate)
    fill = shares >= MIN_SHARES
    # a rule that fires at a second whose book shows nothing to buy simply does not fill
    w, k, s, shares, cost, fee, best, rate = w[fill], k[fill], s[fill], shares[fill], cost[fill], fee[fill], best[fill], rate[fill]
    if len(w) == 0:
        return _empty()
    if one_per_window:
        first = np.concatenate([[True], w[1:] != w[:-1]])
        w, k, s, shares, cost, fee, best, rate = w[first], k[first], s[first], shares[first], cost[first], fee[first], best[first], rate[first]
    won = (s > 0) == tab.up[w]
    payoff = np.where(won, shares, 0.0)
    exit_fee = np.zeros(len(w))
    sold_n = np.zeros(len(w))
    if hold is not None:
        ke = k + int(hold)
        bpx, bsz = ladder_of(tab, w, ke, s, buy=False)
        sold, proceeds, efee = walk_sell(bpx, bsz, shares, rate)
        rest = shares - sold
        payoff = proceeds + np.where(won, rest, 0.0)
        exit_fee, sold_n = efee, sold
    net = payoff - cost - fee - exit_fee
    return dict(w=w, k=k, side=s, shares=shares, cost=cost, fee=fee + exit_fee, vwap=cost / shares, best=best, won=won, payoff=payoff, net=net,
                gross=payoff - cost, day=tab.day[w], slot=tab.slot[w], asset=tab.w_asset[w], T=tab.T[k], sold=sold_n)


def _empty():
    z = np.zeros(0)
    return dict(w=z.astype(int), k=z.astype(int), side=z.astype(int), shares=z, cost=z, fee=z, vwap=z, best=z, won=z.astype(bool), payoff=z, net=z, gross=z,
                day=z.astype(int), slot=z.astype(int), asset=z.astype(int), T=z, sold=z)


def entries_short(tab: Tab, side_far, trig, floor, usd=CLIP_USD, one_per_window=True, hold=None, size_by="far"):
    """Settled entries of a rule that SELLS the far token: `usd` of it (at its best bid), into its bid ladder at t + FILL_MS, never below `floor` (W, NK),
    the bid the rule saw at t. On the venue a token one does not hold is sold by minting the pair for 1 USD a share and selling one side, so the
    position IS a long of the NEAR token bought at 1 - q, and the rows come back in that frame: side = the near token, vwap = 1 - the sale price,
    cost = the collateral left at risk (shares x (1 - q)), payoff = shares when the near token wins, net = payoff - cost - fee. The clip is `usd`
    of the FAR token, so a cheap far token means many shares and `cost` can be several times `usd`: that is the leverage a dollar-sized short carries.
    Under the venue minimum of 5 shares a sale does not fill and a later trigger of the same window is tried. `size_by` "far" sells `usd` of the far token at
    its best bid (the levered clip); "collateral" sells as many shares as `usd` of collateral covers at the best bid, usd / (1 - q), so the dollars at risk are the
    clip. `hold` h (seconds): the position is closed at second k + h by selling the near token into its bid ladder (the mirror of buying the far token back at
    its ask); what is left unsold is held to expiry. -> the same dict `entries` returns."""
    side_far = np.asarray(side_far)
    trig = trig & (side_far != 0) & np.isfinite(floor)
    if hold is not None:
        trig = trig & (tab.T[None, :] > hold + 1) & (np.arange(tab.NK)[None, :] + int(hold) <= tab.NK - 1)
    w, k = np.nonzero(trig)
    if len(w) == 0:
        return _empty()
    sf = side_far[w, k].astype(int)
    px, sz = ladder_of(tab, w, k, sf, buy=False)
    rate = tab.w_fee[w].astype(float)
    best = px[:, 0]
    good = np.isfinite(best) & (best > 0) & (best < 1)
    per_share = np.where(size_by == "collateral", 1.0 - np.where(good, best, 0.5), np.where(good, best, 1.0))     # dollars a share the clip buys: collateral 1 - q, or the price q
    want = np.where(good, np.floor(usd / per_share * 100.0) / 100.0, 0.0)
    sold, proceeds, fee = walk_sell(px, sz, want, rate, floor=floor[w, k])
    fill = sold >= MIN_SHARES
    w, k, sf, sold, proceeds, fee, best, rate = w[fill], k[fill], sf[fill], sold[fill], proceeds[fill], fee[fill], best[fill], rate[fill]
    if len(w) == 0:
        return _empty()
    if one_per_window:
        first = np.concatenate([[True], w[1:] != w[:-1]])
        w, k, sf, sold, proceeds, fee, best, rate = w[first], k[first], sf[first], sold[first], proceeds[first], fee[first], best[first], rate[first]
    s = -sf                                                     # the near token, the side the position is long
    won = (s > 0) == tab.up[w]
    q = proceeds / sold                                         # the far token's sale price a share
    cost = sold - proceeds                                      # the collateral at risk: 1 USD a share minted, q a share received
    payoff = np.where(won, sold, 0.0)
    exit_fee = np.zeros(len(w))
    sold_n = np.zeros(len(w))
    if hold is not None:
        ke = k + int(hold)
        bpx, bsz = ladder_of(tab, w, ke, s, buy=False)          # the near token's bids at the exit second
        sold2, proceeds2, efee = walk_sell(bpx, bsz, sold, rate)
        rest = sold - sold2
        payoff = proceeds2 + np.where(won, rest, 0.0)
        exit_fee, sold_n = efee, sold2
    net = payoff - cost - fee - exit_fee
    return dict(w=w, k=k, side=s, shares=sold, cost=cost, fee=fee + exit_fee, vwap=1.0 - q, best=1.0 - best, won=won, payoff=payoff, net=net, gross=payoff - cost,
                day=tab.day[w], slot=tab.slot[w], asset=tab.w_asset[w], T=tab.T[k], sold=sold_n)


def buy_levels(px, sz, usd, limit):
    """The shares `walk_buy` takes at each level of ONE ask ladder (L,), for `usd`, never above `limit`. -> take (L,)."""
    px, sz = np.asarray(px, float), np.asarray(sz, float)
    left, take = float(usd), np.zeros(len(px))
    for j in range(len(px)):
        p, s = px[j], sz[j]
        if np.isfinite(p) and np.isfinite(s) and s > 0 and p <= limit + 1e-9 and left >= 0.01 and p > 0:
            take[j] = min(s, np.floor(left / p * 100.0) / 100.0)
            left -= take[j] * p
    return take


def sell_levels(px, sz, shares, floor=-np.inf):
    """The shares `walk_sell` sells at each level of ONE bid ladder (L,), never below `floor`. -> take (L,)."""
    px, sz = np.asarray(px, float), np.asarray(sz, float)
    left, take = float(shares), np.zeros(len(px))
    for j in range(len(px)):
        p, s = px[j], sz[j]
        if np.isfinite(p) and np.isfinite(s) and s > 0 and left > 1e-9 and p >= floor - 1e-9:
            take[j] = min(s, left)
            left -= take[j]
    return take


def subset(e, mask):
    """The entries where `mask` (one bool per entry) is true, every key cut alike."""
    mask = np.asarray(mask, bool)
    return {k: np.asarray(v)[mask] for k, v in e.items()}


def concat(*es):
    """Several entries dicts as one, in (slot, asset) order, every key concatenated; a key missing from one is dropped from all."""
    keys = [k for k in es[0] if all(k in e for e in es)]
    out = {k: np.concatenate([np.asarray(e[k]) for e in es]) for k in keys}
    if len(out.get("slot", ())) == 0:
        return out
    order = np.argsort(out["slot"].astype(np.int64) * 10 + out["asset"].astype(np.int64), kind="stable")
    return {k: v[order] for k, v in out.items()}


# ============================================================ the numbers
def wilson(k, n, z=1.96):
    if n <= 0:
        return (np.nan, np.nan)
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (c - h, c + h)


def slot_boot(slots, vals, n_boot=2000, seed=7, stat="mean"):
    """Interval of the per-entry mean (stat 'mean') or the total (stat 'sum') resampling 15-minute slots. -> (lo, hi)."""
    if len(vals) == 0:
        return (np.nan, np.nan)
    u, inv = np.unique(slots, return_inverse=True)
    sp = np.bincount(inv, weights=vals, minlength=len(u))
    sn = np.bincount(inv, minlength=len(u)).astype(float)
    rng = np.random.default_rng(seed)
    ix = rng.integers(0, len(u), size=(n_boot, len(u)))
    a, b = sp[ix].sum(1), sn[ix].sum(1)
    est = a / np.maximum(b, 1) if stat == "mean" else a
    return (float(np.quantile(est, 0.025)), float(np.quantile(est, 0.975)))


def slot_boot_trim(slots, vals, pct=5, n_boot=2000, seed=7, block=500):
    """The net an entry with the best `pct`% of entries taken out, recomputed inside each slot resample (the resampling of `slot_boot`, the same seed and
    so the same draws). Each draw is a multiplicity per slot; its total and count come from the slot sums, and the k = ceil(pct% x n) units it drops are
    read off the draw's highest values (only the top of the sorted entries is ever touched), n the draw's own entry count. Vectorised in blocks of `block`
    draws. -> (lo 2.5%, hi 97.5%, share of draws at or below zero, the draws)."""
    vals = np.asarray(vals, float)
    n = len(vals)
    if n == 0:
        return (np.nan, np.nan, np.nan, np.zeros(0))
    u, inv = np.unique(slots, return_inverse=True)
    sp = np.bincount(inv, weights=vals, minlength=len(u))
    sn = np.bincount(inv, minlength=len(u)).astype(float)
    rng = np.random.default_rng(seed)
    ix = rng.integers(0, len(u), size=(n_boot, len(u)))
    o = np.argsort(-vals, kind="stable")                         # the highest value first
    v_top, s_top = vals[o], inv[o]
    est = np.full(n_boot, np.nan)
    for b0 in range(0, n_boot, block):
        b = ix[b0:b0 + block]
        nb = len(b)
        mult = np.bincount((b + np.arange(nb)[:, None] * len(u)).ravel(), minlength=nb * len(u)).reshape(nb, len(u)).astype(float)
        tot, n_d = mult @ sp, mult @ sn
        k = np.ceil(pct / 100.0 * n_d)
        top = np.full(nb, np.nan)
        todo = np.arange(nb)
        M = min(n, max(64, int(3 * k.max())))
        while len(todo):
            m = mult[np.ix_(todo, s_top[:M])]
            cm = np.cumsum(m, axis=1)
            got = np.clip(np.minimum(cm, k[todo, None]) - (cm - m), 0, None) @ v_top[:M]
            done = (cm[:, -1] >= k[todo]) | (M == n)
            top[todo[done]] = got[done]
            todo = todo[~done]
            M = min(n, 2 * M)
        keep = n_d - k
        with np.errstate(invalid="ignore", divide="ignore"):
            est[b0:b0 + nb] = np.where(keep > 0, (tot - top) / np.maximum(keep, 1), np.nan)
    ok = est[np.isfinite(est)]
    if len(ok) == 0:
        return (np.nan, np.nan, np.nan, est)
    return (float(np.quantile(ok, 0.025)), float(np.quantile(ok, 0.975)), float(np.mean(ok <= 0)), est)


def daily_sharpe(e, ndays):
    """Annualised Sharpe of the day's net PnL (sqrt 365), zero on a day with no entry. Meaningful only with many days: with a handful it is a rough label."""
    if ndays < 2:
        return float("nan")
    d = np.bincount(e["day"], weights=e["net"], minlength=ndays)
    sd = d.std(ddof=1)
    return float(d.mean() / sd * np.sqrt(365)) if sd > 0 else float("nan")


def slot_sharpe(e, tab):
    """Annualised Sharpe of the 15-minute-slot PnL (zero in a slot with no entry), sqrt(96 x 365)."""
    u = np.unique(tab.slot)
    pos = np.searchsorted(u, e["slot"])
    s = np.bincount(pos, weights=e["net"], minlength=len(u))
    sd = s.std(ddof=1)
    return float(s.mean() / sd * np.sqrt(SLOTS_PER_DAY * 365)) if sd > 0 else float("nan")


def summarize(e, tab=None, label=""):
    n = len(e["net"])
    if n == 0:
        return dict(label=label, n=0)
    k = int(e["won"].sum())
    lo, hi = wilson(k, n)
    cost = float(e["cost"].sum())
    m_lo, m_hi = slot_boot(e["slot"], e["net"])
    out = dict(label=label, n=n, wins=k, win=k / n, win_lo=lo, win_hi=hi, breakeven=float((e["cost"] + e["fee"]).sum() / max(e["shares"].sum(), 1e-9)),
               breakeven_entry=float(np.mean((e["cost"] + e["fee"]) / np.maximum(e["shares"], 1e-9))),
               net=float(e["net"].sum()), per=float(e["net"].mean()), per_lo=m_lo, per_hi=m_hi, gross_per=float(e["gross"].mean()),
               fee_per=float(e["fee"].mean()), cost_per=cost / n, roi=float(e["net"].sum() / max(cost, 1e-9)), vwap=float((e["cost"]).sum() / max(e["shares"].sum(), 1e-9)),
               sd=float(e["net"].std(ddof=1)) if n > 1 else float("nan"))
    out["t"] = out["per"] / (out["sd"] / np.sqrt(n)) if n > 1 and out["sd"] > 0 else float("nan")
    # the shape of the payoff: the mean win, the mean loss (negative), reward to risk (mean win over mean loss), the profit factor, and the win rate this payoff
    # needs to break even, |loss| / (win + |loss|): the win rate must sit above it for a positive expectancy (per = win x avg_win + (1 - win) x avg_loss)
    w_, l_ = e["net"][e["net"] > 0], e["net"][e["net"] <= 0]
    out["avg_win"] = float(w_.mean()) if len(w_) else float("nan")
    out["avg_loss"] = float(l_.mean()) if len(l_) else float("nan")
    out["rr"] = float(out["avg_win"] / abs(out["avg_loss"])) if len(w_) and len(l_) and out["avg_loss"] != 0 else float("nan")
    out["pf"] = float(w_.sum() / abs(l_.sum())) if len(l_) and l_.sum() != 0 else float("nan")
    out["win_needed"] = float(abs(out["avg_loss"]) / (out["avg_win"] + abs(out["avg_loss"]))) if len(w_) and len(l_) else float("nan")
    # each trade's own reward to risk: what it pays if it wins (shares x 1 - cost - fee) over the most it can lose (cost + fee); a binary held to expiry
    risk = e["cost"] + e["fee"]
    rr_t = (e["shares"] - risk) / np.maximum(risk, 1e-9)
    out["rr_trade_mean"], out["rr_trade_median"] = float(rr_t.mean()), float(np.median(rr_t))
    # do a few wins carry everything: the share of the net in the best 5% of entries, and the net an entry with the best 1%, 5% and 10% of entries taken out
    srt = np.sort(e["net"])
    for pct in (1, 5, 10):
        k_ = int(np.ceil(pct / 100.0 * n))
        out[f"per_ex_top{pct}"] = float(srt[:n - k_].mean()) if n - k_ > 0 else float("nan")
    # its own interval (the accounting audit, 2026-10-11: the point alone read as "survives" with an interval on both sides of zero): the trim inside each
    # of slot_boot's 2,000 slot resamples, and the share of those draws at or below zero
    out["per_ex_top5_lo"], out["per_ex_top5_hi"], out["p_ex_top5_le0"], _ = slot_boot_trim(e["slot"], e["net"], 5)
    k5 = int(np.ceil(0.05 * n))
    out["top5_net"] = float(srt[n - k5:].sum())
    out["top5_share"] = float(out["top5_net"] / out["net"]) if out["net"] > 0 else float("nan")
    # the shape of the climb (the owner, 2026-10-10: a steady climb, not jumps): the fit of the equity line to a straight line (r2), the t of its slope,
    # the deepest drawdown and its share of the net, the share of trading days above zero
    eq = np.cumsum(e["net"])
    x = np.arange(1, n + 1, dtype=float)
    if n >= 3:
        slope, icpt = np.polyfit(x, eq, 1)
        resid = eq - (slope * x + icpt)
        ss_res, ss_tot = float((resid ** 2).sum()), float(((eq - eq.mean()) ** 2).sum())
        se = np.sqrt(ss_res / (n - 2) / float(((x - x.mean()) ** 2).sum())) if n > 2 else float("nan")
        out["eq_r2"] = float(1.0 - ss_res / ss_tot) if ss_tot > 0 else float("nan")
        out["eq_slope_t"] = float(slope / se) if se > 0 else float("nan")
    else:
        out["eq_r2"], out["eq_slope_t"] = float("nan"), float("nan")
    peak = np.maximum.accumulate(np.concatenate([[0.0], eq]))[1:]
    out["max_dd"] = float((peak - eq).max())
    out["dd_over_net"] = float(out["max_dd"] / out["net"]) if out["net"] > 0 else float("nan")
    if tab is not None:
        nd = len(tab.days)
        out["sharpe_daily"] = daily_sharpe(e, nd)
        out["sharpe_slot"] = slot_sharpe(e, tab)
        out["by_day"] = [float(np.sum(e["net"][e["day"] == i])) for i in range(nd)]
        out["n_by_day"] = [int(np.sum(e["day"] == i)) for i in range(nd)]
        d_ = np.array(out["by_day"])
        traded = np.array(out["n_by_day"]) > 0
        out["days_pos"] = float((d_[traded] > 0).mean()) if traded.any() else float("nan")
    return out


def fmt(s):
    if s.get("n", 0) == 0:
        return f"{s.get('label', ''):34s} n=0"
    return (f"{s['label']:34s} n={s['n']:5d} win {s['win']*100:5.1f}% [{s['win_lo']*100:4.1f},{s['win_hi']*100:4.1f}] be {s['breakeven']*100:5.1f}% | "
            f"net {s['net']:+9.1f} per {s['per']:+7.3f} [{s['per_lo']:+6.2f},{s['per_hi']:+6.2f}] roi {s['roi']*100:+6.1f}% t {s['t']:+5.2f}"
            + (f" shD {s['sharpe_daily']:+5.1f} shS {s['sharpe_slot']:+5.1f}" if "sharpe_daily" in s else ""))


# ============================================================ the engine's own checks
def _fake_tab(up_won: int):
    """One window, one decision second, a 4-level Up book at the fill: bids 0.78 / 0.77 (10, 100 shares), asks 0.80 / 0.81 (10, 100 shares)."""
    t = object.__new__(Tab)
    lad = np.full((1, 4, 1, 4), np.nan)
    lad[0, 0, 0, :2], lad[0, 1, 0, :2] = [0.78, 0.77], [10.0, 100.0]
    lad[0, 2, 0, :2], lad[0, 3, 0, :2] = [0.80, 0.81], [10.0, 100.0]
    t.lad, t.w_fee, t.up = lad, np.array([0.07]), np.array([bool(up_won)])
    t.day, t.slot, t.w_asset, t.T = np.array([0]), np.array([100]), np.array([0]), np.array([600.0])
    return t


def checks() -> list[tuple[str, bool]]:
    """Every engine check as (label, passed): the fill walk, the fee, the sell walk and its floor, the short's accounting, the per-level detail, the slot bootstrap."""
    out = []
    px = np.array([[0.50, 0.52, 0.55, np.nan], [0.50, 0.52, 0.55, np.nan]])
    sz = np.array([[10.0, 20.0, 50.0, np.nan], [10.0, 20.0, 50.0, np.nan]])
    sh, co, fe, b = walk_buy(px, sz, 20.0, np.array([0.60, 0.51]), 0.07)
    out.append(("walk takes 10 at 0.50, 20 at 0.52 and 8.36 at 0.55 for 20 USD", abs(sh[0] - 38.36) < 1e-9 and abs(co[0] - 19.998) < 1e-6))
    out.append(("walk never pays above the limit (second row stops at 0.50)", abs(sh[1] - 10.0) < 1e-9 and abs(co[1] - 5.0) < 1e-9))
    out.append(("fee is rate x p x (1 - p) per share (10 sh at 0.50 -> 0.175)", abs(fe[1] - 0.175) < 1e-9))
    out.append(("buy_levels agrees with walk_buy level by level (10, 20, 8.36)", np.allclose(buy_levels(px[0], sz[0], 20.0, 0.60), [10.0, 20.0, 8.36, 0.0])))
    sold, pr, ef = walk_sell(np.array([[0.4, 0.3, np.nan, np.nan]]), np.array([[5.0, 10.0, np.nan, np.nan]]), np.array([8.0]), 0.07)
    out.append(("sell 8 into bids 5 at 0.40 and 3 at 0.30 -> proceeds 2.9", abs(sold[0] - 8) < 1e-9 and abs(pr[0] - 2.9) < 1e-9))
    sold_f, pr_f, _ = walk_sell(np.array([[0.4, 0.3, np.nan, np.nan]]), np.array([[5.0, 10.0, np.nan, np.nan]]), np.array([8.0]), 0.07, floor=np.array([0.35]))
    out.append(("a sell floor of 0.35 stops the walk after the 5 shares at 0.40", abs(sold_f[0] - 5.0) < 1e-9 and abs(pr_f[0] - 2.0) < 1e-9))
    out.append(("sell_levels agrees with walk_sell level by level (5, 3)", np.allclose(sell_levels([0.4, 0.3, np.nan, np.nan], [5.0, 10.0, np.nan, np.nan], 8.0), [5.0, 3.0, 0.0, 0.0])))
    # the short: sell 20 USD of Down (bids 0.20 x 10, 0.19 x 100 = the mirror of the Up asks) -> 100 shares, proceeds 19.1, fee 0.07 x (1.6 + 13.851)
    for up_won, want_net in ((1, 19.1 - 1.08157), (0, 19.1 - 100.0 - 1.08157)):
        e = entries_short(_fake_tab(up_won), np.array([[-1]]), np.array([[True]]), np.array([[0.19]]), usd=20.0)
        ok = (len(e["net"]) == 1 and abs(e["shares"][0] - 100.0) < 1e-9 and abs(e["cost"][0] - 80.9) < 1e-9 and abs(e["fee"][0] - 1.08157) < 1e-9
              and abs(e["net"][0] - want_net) < 1e-9 and abs(e["vwap"][0] - 0.809) < 1e-9 and e["side"][0] == 1 and bool(e["won"][0]) == bool(up_won))
        out.append((f"a 20 USD Down sale at 0.20/0.19 is a long of 100 Up at 0.809 risking 80.9 USD; Up {'won' if up_won else 'lost'} -> net {want_net:+.5f}", ok))
    e = entries_short(_fake_tab(1), np.array([[-1]]), np.array([[True]]), np.array([[0.195]]), usd=20.0)
    out.append(("the short never sells below the bid it saw (floor 0.195 -> 10 shares at 0.20 only)", len(e["net"]) == 1 and abs(e["shares"][0] - 10.0) < 1e-9 and abs(e["cost"][0] - 8.0) < 1e-9))
    e = entries_short(_fake_tab(1), np.array([[-1]]), np.array([[True]]), np.array([[0.21]]), usd=20.0)
    out.append(("a short under the venue minimum does not fill (floor 0.21 -> nothing)", len(e["net"]) == 0))
    lo, hi = slot_boot(np.repeat(np.arange(50), 4), np.tile([1.0, 1.0, 1.0, 1.0], 50))
    out.append(("slot bootstrap of a constant has a zero-width interval", abs(lo - 1) < 1e-9 and abs(hi - 1) < 1e-9))
    lo, hi, p0, _ = slot_boot_trim(np.repeat(np.arange(50), 4), np.full(200, 1.0))
    out.append(("the trimmed bootstrap of a constant is that constant, no draw at or below zero", abs(lo - 1) < 1e-9 and abs(hi - 1) < 1e-9 and p0 == 0.0))
    # planted: 190 entries of -0.1 and 10 of +50 (the top 5% exactly), one a slot; the mean is +2.4, the trimmed point -0.1, and the trimmed interval's lower end
    # must sit at or below zero (a gate on that end fails it), its draws 2,000
    v_ = np.concatenate([np.full(190, -0.1), np.full(10, 50.0)])
    lo, hi, p0, d_ = slot_boot_trim(np.arange(200), v_)
    out.append(("planted: a net carried by its best 5% has a trimmed interval whose lower end is at or below zero", v_.mean() > 0 and lo <= 0 and p0 > 0.25 and len(d_) == 2000))
    # the trim inside a draw equals the direct trim of the resampled entries (one draw, recomputed by hand)
    sl_ = np.repeat(np.arange(40), 3)
    v2_ = np.random.default_rng(1).normal(0, 1, 120)
    _, _, _, d2_ = slot_boot_trim(sl_, v2_, n_boot=3, seed=5)
    ix_ = np.random.default_rng(5).integers(0, 40, size=(3, 40))
    r_ = np.sort(np.concatenate([v2_[sl_ == j] for j in ix_[0]]))
    out.append(("the trimmed bootstrap's first draw equals the direct trim of the same resample", abs(d2_[0] - r_[:len(r_) - int(np.ceil(0.05 * len(r_)))].mean()) < 1e-9))
    c = concat(dict(slot=np.array([3, 1]), asset=np.array([0, 0]), net=np.array([1.0, 2.0])), dict(slot=np.array([2]), asset=np.array([1]), net=np.array([3.0])))
    out.append(("concat orders by slot then asset", list(c["slot"]) == [1, 2, 3] and list(c["net"]) == [2.0, 3.0, 1.0]))
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
