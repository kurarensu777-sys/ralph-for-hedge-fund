"""The engine of the directional momentum study (B-0660): a Binance move over a lookback L, an entry on the exact Polymarket ladder, an exit rule, a settled entry out.
numpy only, no I/O except `MTab`. It sits on the decision tables of the strategy search (`tf15_bt.Tab`, a 1 s table per window) and the 1 s Binance path of `mom15_path`.

THE SIGNAL. At whole second k of a window, with S the Binance trade-implied mid (the same series the tables hold), sigma the per-second volatility the tables hold (a 300 s
half-life EWMA of 10 s squared returns, causal), the z-score of a lookback L is  z_L = ln(S_k / S_{k-L}) / (sigma_k sqrt(L)).  It fires when |z_L| >= z (a "multi" signal when
two lookbacks both reach z and point the same way); the side is the sign: up buys the Up token, down buys the Down token. Eligible seconds: 10 s after the start to 60 s before
the end; the first second whose ladder fills (at least 5 shares for USD 20, never above LIMIT) is the entry; one entry per window.
THE FILL. The order meets the ladder as of decision + FILL_MS (the table's own fill delay), best level first, four levels deep (`tf15_bt.walk_buy`), the market's own taker fee.
THE EXIT (one of): expiry (the token pays 1 or 0 by the venue's resolution); take-profit at +X sigma_L (the first second after the entry at which the Binance mid has moved X
sigma_L our way from the entry second's mid, sigma_L = sigma_k sqrt(L), L the signal's own lookback); time exit after A seconds; trailing stop (the first second at which the mid has
retraced Y sigma_L from its best level since entry, the entry level included). An exit sells into the bid ladder as of exit second + FILL_MS (`tf15_bt.walk_sell`), the fee on the way
out too; what the four bid levels do not take is held to expiry. A rule that never fires holds to expiry.
No outcome is read to build a signal, an eligibility or an exit; `w_up` is read only to settle (and by the planted peek).
"""
from __future__ import annotations

import numpy as np

import tf15_bt as B

PRE = 300                              # column of second 5 in the Binance path of a window (seconds -295 .. 895)
NPATH = PRE + 891
LS = (1, 5, 10, 30, 60, 180, 300)
ZS = (1.5, 2.0, 2.5, 3.0)
KMIN = 10                              # no decision in the first 10 s of a window
TMIN = 60                              # no entry with under 60 s left
LIMIT = 0.97                           # the highest price a token is bought at
K0 = B.K0


# ============================================================ the pooled table with the 1 s Binance path
class MTab(B.Tab):
    """`tf15_bt.Tab` plus `Sg` (W, NPATH) float64: the trade-implied mid at whole seconds -295 .. 895 of each window."""

    def __init__(self, days, fill_ms: int = 250, assets=None):
        import updown15_day as D
        import mom15_path as P
        super().__init__(days, assets=assets, fill_ms=fill_ms)
        self.fill_ms = fill_ms
        Sg = np.full((self.W, NPATH), np.nan)
        for i, d in enumerate(self.days):
            idx = np.flatnonzero(self.day == i)
            if not len(idx):
                continue
            arrs, _meta = P.load(d)
            ds = D.day_start_ms(d)
            for a_i, a in enumerate(D.ASSETS):
                sel = idx[self.w_asset[idx] == a_i]
                for w in sel:
                    s0 = int((self.w_start[w] - ds) // 1000) + P.PRE_S
                    Sg[w] = arrs[a][s0 + K0 - PRE: s0 + K0 - PRE + NPATH]
        self.Sg = Sg
        assert np.array_equal(Sg[:, PRE:PRE + self.NK].astype(np.float32), self.S), "the Binance path does not equal the table's S at a whole second"
        self._z = {}

    def zlook(self, L: int, lead: int = 0):
        """(W, NK) z-score of the L-second lookback return. `lead` > 0 is the PLANTED leak (the return is read `lead` seconds from the future); a real signal has lead 0."""
        if (L, lead) not in self._z:
            hi = np.minimum(PRE + np.arange(self.NK) + lead, NPATH - 1)
            r = np.log(self.Sg[:, hi] / self.Sg[:, hi - L])
            self._z[(L, lead)] = r / (self.sig.astype(float) * np.sqrt(L))
        return self._z[(L, lead)]


# ============================================================ signals and exits
class Signal:
    """kind 'single': |z_L| >= z.  kind 'multi': |z_Ls| >= z and |z_Ll| >= z, the same sign.  `lu` is the lookback whose sigma is the exit's unit."""

    def __init__(self, L, z, Ll=None, lead=0):
        self.L, self.z, self.Ll, self.lead = int(L), float(z), (None if Ll is None else int(Ll)), int(lead)
        self.lu = self.Ll if self.Ll else self.L
        self.name = (f"L{self.L}s|z{self.z:g}" if not self.Ll else f"L{self.L}s+{self.Ll}s|z{self.z:g}") + (f"|LEAK+{self.lead}s" if self.lead else "")

    def fire(self, tab):
        """-> (side (W, NK) int in {-1, 0, 1}, trig (W, NK) bool), eligibility applied."""
        z = tab.zlook(self.L, self.lead)
        if self.Ll:
            zl = tab.zlook(self.Ll, self.lead)
            ok = (np.abs(z) >= self.z) & (np.abs(zl) >= self.z) & (np.sign(z) == np.sign(zl))
        else:
            ok = np.abs(z) >= self.z
        k = K0 + np.arange(tab.NK)
        ok &= ((k >= KMIN) & (900 - k >= TMIN))[None, :] & np.isfinite(z)
        return np.where(ok, np.sign(z), 0).astype(np.int8), ok


class Exit:
    kinds = ("expiry", "tp", "time", "trail")

    def __init__(self, kind, p=None):
        assert kind in self.kinds
        self.kind, self.p = kind, p
        g = "" if p is None else f"{p:g}"
        self.name = {"expiry": "hold to expiry", "tp": f"take-profit +{g} sigma", "time": f"time exit {g} s", "trail": f"trailing stop {g} sigma"}[kind]


EXITS = [Exit("expiry")] + [Exit("tp", x) for x in (1, 2, 3)] + [Exit("time", a) for a in (10, 30, 60, 300)] + [Exit("trail", y) for y in (1, 2)]


def exit_second(tab, e, ex: Exit, lu: int):
    """The column at which each entry exits, -1 for expiry. `e["k"]` is the entry's column. Reads the Binance path after the entry only up to the exit column itself."""
    n = len(e["w"])
    k = e["k"]
    if ex.kind == "expiry" or n == 0:
        return np.full(n, -1, int)
    if ex.kind == "time":
        ke = np.minimum(k + int(ex.p), tab.NK - 1)
        return np.where(ke > k, ke, -1)
    S = tab.Sg[e["w"], PRE:PRE + tab.NK]
    ls = np.log(S)
    ext = e["side"][:, None] * (ls - ls[np.arange(n), k][:, None])
    u = tab.sig[e["w"], k].astype(float) * np.sqrt(lu)
    cols = np.arange(tab.NK)[None, :]
    after = cols > k[:, None]
    if ex.kind == "tp":
        hit = after & (ext >= ex.p * u[:, None])
    else:
        mx = np.maximum.accumulate(np.where(cols >= k[:, None], ext, -np.inf), axis=1)
        hit = after & (mx - ext >= ex.p * u[:, None])
    return np.where(hit.any(1), hit.argmax(1), -1)


# ============================================================ the entries
def settle(tab, side, trig, ex: Exit, lu: int, usd=B.CLIP_USD, limit=LIMIT, fee_mult=1.0, slack=0.0):
    """Entries of a rule given its firing seconds, settled. -> `tf15_bt.entries`' fields plus ke (exit column, -1 = expiry), exit_px, pos (net > 0), exit_fee."""
    lim = np.full(side.shape, float(limit))
    e = B.entries(tab, side, trig, lim, usd=usd)
    n = len(e["w"])
    if n == 0:
        e.update(ke=np.zeros(0, int), exit_px=np.zeros(0), pos=np.zeros(0, bool), exit_fee=np.zeros(0))
        return e
    ke = exit_second(tab, e, ex, lu)
    w, s, shares = e["w"], e["side"], e["shares"]
    rate = tab.w_fee[w].astype(float)
    payoff = np.where(e["won"], shares, 0.0)
    exit_fee = np.zeros(n)
    exit_px = np.full(n, np.nan)
    has = ke >= 0
    if has.any():
        i = np.flatnonzero(has)
        bpx, bsz = B.ladder_of(tab, w[i], ke[i], s[i], buy=False)
        sold, proceeds, efee = B.walk_sell(bpx, bsz, shares[i], rate[i])
        payoff[i] = proceeds + np.where(e["won"][i], shares[i] - sold, 0.0)
        exit_fee[i] = efee
        exit_px[i] = np.where(sold > 0, proceeds / np.maximum(sold, 1e-12), np.nan)
        e["sold"][i] = sold
    in_fee = e["fee"]                                                # entries' fee is the entry fee here (hold=None)
    cost = e["cost"] + slack * shares
    fee = (in_fee + exit_fee) * fee_mult
    net = payoff - cost - fee
    e.update(cost=cost, fee=fee, payoff=payoff, net=net, gross=payoff - cost, vwap=cost / shares, ke=ke, exit_px=exit_px, pos=net > 0, exit_fee=exit_fee * fee_mult)
    return e


def run(tab, sg: Signal, ex: Exit, **kw):
    side, trig = sg.fire(tab)
    return settle(tab, side, trig, ex, sg.lu, **kw)


def run_random_side(tab, sg: Signal, ex: Exit, seed: int, **kw):
    """The placebo: the same firing seconds, a fair-coin side at each."""
    _side, trig = sg.fire(tab)
    rng = np.random.default_rng(seed)
    side = np.where(rng.random(trig.shape) < 0.5, 1, -1).astype(np.int8) * trig
    return settle(tab, side, trig, ex, sg.lu, **kw)


def run_peek(tab, sg: Signal, ex: Exit, **kw):
    """The planted peek: the same firing seconds, the side that wins."""
    _side, trig = sg.fire(tab)
    side = np.where(tab.up, 1, -1).astype(np.int8)[:, None] * trig
    return settle(tab, side, trig, ex, sg.lu, **kw)


def levels_buy(px, sz, usd, limit):
    """Per-level shares taken by a buy of `usd` from an ask ladder (L,), best first, never above `limit` (the same walk as `tf15_bt.walk_buy`, one row)."""
    left = float(usd)
    take = np.zeros(len(px))
    for j in range(len(px)):
        p, q = float(px[j]), float(sz[j])
        if np.isfinite(p) and np.isfinite(q) and q > 0 and p <= limit + 1e-9 and left >= 0.01 and p > 0:
            take[j] = min(q, np.floor(left / p * 100.0) / 100.0)
            left -= take[j] * p
    return take


def levels_sell(px, sz, shares):
    """Per-level shares sold into a bid ladder (L,), best first (the same walk as `tf15_bt.walk_sell`, one row)."""
    left = float(shares)
    take = np.zeros(len(px))
    for j in range(len(px)):
        if np.isfinite(px[j]) and np.isfinite(sz[j]) and sz[j] > 0 and left > 1e-9:
            take[j] = min(float(sz[j]), left)
            left -= take[j]
    return take


def l2_record(tab, e, i, usd=B.CLIP_USD, limit=LIMIT):
    """Everything the L2 view of entry i draws: the ladder the buy walked, the shares taken at each level, the ladder an early exit sold into and what it took (None for expiry)."""
    w, k, s = np.array([e["w"][i]]), np.array([e["k"][i]]), np.array([e["side"][i]])
    apx, asz = (a[0] for a in B.ladder_of(tab, w, k, s, buy=True))
    atake = levels_buy(apx, asz, usd, limit)
    assert abs(atake.sum() - e["shares"][i]) < 1e-6, "the L2 record does not rebuild the entry's shares"
    rec = dict(ask_px=apx, ask_sz=asz, ask_take=atake, bid_px=None, bid_sz=None, bid_take=None, ke=int(e["ke"][i]))
    if e["ke"][i] >= 0:
        bpx, bsz = (a[0] for a in B.ladder_of(tab, w, np.array([e["ke"][i]]), s, buy=False))
        rec.update(bid_px=bpx, bid_sz=bsz, bid_take=levels_sell(bpx, bsz, e["shares"][i]))
        assert abs(rec["bid_take"].sum() - e["sold"][i]) < 1e-6, "the L2 record does not rebuild the exit's shares"
    return rec


def pool(es):
    """Entries from several tables as one (arrays joined in the order given; windows are per table)."""
    es = [e for e in es if len(e["net"])]
    if not es:
        return settle_empty()
    return {k: np.concatenate([e[k] for e in es]) for k in es[0]}


def settle_empty():
    e = B._empty()
    e.update(ke=np.zeros(0, int), exit_px=np.zeros(0), pos=np.zeros(0, bool), exit_fee=np.zeros(0))
    return e


def summarize(e, tab, label=""):
    """`tf15_bt.summarize`, with the win rate of an early exit read as the share of positive trades (the token's settlement is no longer the payoff)."""
    early = len(e["net"]) > 0 and bool((e["ke"] >= 0).any())
    f = dict(e)
    if early:
        f["won"] = e["pos"]
    s = B.summarize(f, tab, label)
    if s.get("n", 0):
        s["early_share"] = float((e["ke"] >= 0).mean())
        s["outcome_right"] = float(e["won"].mean())
        s["pos"] = float(e["pos"].mean())
        if early:
            s["breakeven"] = float("nan")
            s["breakeven_entry"] = float("nan")
    return s


# ============================================================ the engine's own checks
class _Fake:
    """A table of two windows and eleven decision seconds, built by hand."""

    def __init__(self):
        W, NK = 2, 891
        self.W, self.NK = W, NK
        self.T = (900 - (K0 + np.arange(NK))).astype(float)
        self.up = np.array([True, False])
        self.day = np.zeros(W, int)
        self.slot = np.arange(W)
        self.w_asset = np.zeros(W, int)
        self.w_fee = np.full(W, 0.07, np.float32)
        self.sig = np.full((W, NK), 1e-4, np.float32)
        lad = np.full((W, 4, NK, 4), np.nan, np.float32)
        lad[:, 0, :, 0] = 0.49                                       # Up bid 0.49 x 100
        lad[:, 1, :, 0] = 100
        lad[:, 2, :, 0] = 0.51                                       # Up ask 0.51 x 100
        lad[:, 3, :, 0] = 100
        self.lad = lad
        S = np.full((W, NPATH), 100.0)
        S[:, PRE + 100:] *= np.exp(np.linspace(0, 6e-4, NPATH - PRE - 100))     # a ramp from column 100: +6 bp in all
        self.Sg = S
        self._z = {}

    zlook = MTab.zlook


def selftest() -> bool:
    ok = True

    def line(label, cond):
        nonlocal ok
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        ok &= bool(cond)

    t = _Fake()
    z1 = t.zlook(1)
    step = 6e-4 / (t.NK - 100 - 1 + 0)
    line("z of a constant-drift ramp is the step over sigma (1 s)", abs(z1[0, 200] - step / 1e-4) < 5e-3 * step / 1e-4 and z1[0, 50] == 0.0)
    line("z over 60 s is the 60-step return over sigma sqrt(60)", abs(t.zlook(60)[0, 300] - 60 * step / (1e-4 * np.sqrt(60))) < 0.02)
    sg = Signal(1, 0.005)
    side, trig = sg.fire(t)
    line("a rising ramp fires up, never in the first 10 s, never in the last 60 s", (side[0, 200] == 1) and not trig[0, :5].any() and not trig[0, 836:].any())
    # entry at the first firing second 100 (column), exits
    e = settle(t, side, trig, Exit("expiry"), 1)
    line("hold to expiry, window 0 up wins: USD 20 at 0.51 buys 39.21 shares, pays 1 each", len(e["w"]) == 2 and abs(e["shares"][0] - 39.21) < 1e-9 and abs(e["payoff"][0] - 39.21) < 1e-9)
    line("window 1 resolves Down while the ramp bought Up: the entry loses its cost plus the fee", e["net"][1] < 0 and abs(e["payoff"][1]) < 1e-12)
    fee_in = 0.07 * 0.51 * 0.49 * 39.21
    line("fee is rate x p x (1 - p) on the shares", abs(e["fee"][0] - fee_in) < 1e-6)
    et = settle(t, side, trig, Exit("time", 30), 1)
    fee_out = 0.07 * 0.49 * 0.51 * 39.21
    line("time exit sells the shares into the 0.49 bid and pays the fee both ways", abs(et["payoff"][0] - 39.21 * 0.49) < 1e-6 and abs(et["fee"][0] - fee_in - fee_out) < 1e-6)
    line("the exit column is the entry column + 30", int(et["ke"][0]) == int(e["k"][0]) + 30)
    # take-profit: ramp gives sigma_L = 1e-4 per second; the move from the entry is step*dt; X sigma at dt = X*1e-4/step
    tp = exit_second(t, e, Exit("tp", 2), 1)
    need = int(np.ceil(2 * 1e-4 / step - 1e-9))
    line("take-profit +2 sigma fires at the first second the move has reached 2 sigma", int(tp[0] - e["k"][0]) == need)
    line("a take-profit never reached holds to expiry", int(exit_second(t, e, Exit("tp", 1e6), 1)[0]) == -1)
    # trailing stop on a peak then a fall
    t2 = _Fake()
    t2.Sg = np.full((2, NPATH), 100.0)
    t2.Sg[:, PRE + 100:PRE + 200] *= np.exp(np.linspace(0, 5e-4, 100))
    t2.Sg[:, PRE + 200:] = t2.Sg[:, PRE + 199:PRE + 200] * np.exp(-np.linspace(0, 6e-4, NPATH - PRE - 200))
    ee = dict(w=np.array([0]), k=np.array([105]), side=np.array([1]))
    tr = exit_second(t2, ee, Exit("trail", 2), 1)
    peak_ls = np.log(t2.Sg[0, PRE:PRE + 891])
    cond = (np.maximum.accumulate(peak_ls[105:]) - peak_ls[105:] >= 2e-4)
    line("trailing stop fires at the first second the mid is 2 sigma under its best level since entry", int(tr[0]) == 105 + int(np.argmax(cond & (np.arange(len(cond)) > 0))))
    # the L2 record rebuilds the walk
    r0 = l2_record(t, et, 0)
    line("the L2 record rebuilds the shares bought and the shares sold, level by level", abs(r0["ask_take"].sum() - 39.21) < 1e-9 and abs(r0["bid_take"].sum() - 39.21) < 1e-9 and r0["ask_take"][0] == 39.21)
    # placebo and peek
    pe = run_peek(t, sg, Exit("expiry"))
    line("the planted peek wins every entry", bool(pe["won"].all()) and len(pe["w"]) == 2)
    pl = [run_random_side(t, sg, Exit("expiry"), s)["won"].mean() for s in range(40)]
    line("random sides win about half of the time", 0.3 < float(np.mean(pl)) < 0.7)
    return bool(ok)


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
