"""The protocol and the reads of the maker-side burst study (B-0680, run um-013). numpy only; a notebook calls these and draws what they return.

THE QUESTION. The um-009 pair (a one-second Binance burst of 2.5 sigma, bought by a taker, held to expiry) has an edge before friction of +0.83 USD an entry over 22 days, and +1.23 on BTC and
ETH alone, against a taker's friction of 1.17 there (fee 0.59, spread and depth 0.47, the 250 ms 0.21). A resting bid pays no fee and no half spread. Does the same burst, bought by a RESTING
BID, keep any of that edge once the fills are chosen by the other side (the adverse selection of the fills)?
THE ORDER (frozen in `mkb15_mk.DEFAULT` before the engine first ran on any day; the notebook prints it): at each firing second of the frozen signal (L = 1 s, z = 2.5, BTC and ETH only) rest a
post-only bid of USD 20 on the burst's side at the best bid the trader saw, for at most 30 s, cancelled when Binance retraces the burst by 1 sigma_1s (the cancel lands 150 ms later), one fill a
window, held to expiry; the fill model is `mkb15_mk`'s (back of the queue, fills only from printed trades, rebate 20% of the taker fee [1]).
TWO WINDOWS, NEVER MIXED.
  DESIGN   2026-09-16 .. 2026-10-07 (22 days): the BTC and ETH cut was FOUND here, so nothing in it is a test. It is read for the fill model (planted checks, queue sweep), the adverse
           selection of the fills against the misses, the sensitivity of the rule, and the size of the forward read. The primary cell is fixed; no cell of the grid is chosen.
  FORWARD  2026-10-08 .. 2026-11-01 (25 complete UTC days), pre-registered as um-013 before any of them was scored, read ONCE by `ForwardGate` when all 25 are seated. The day list is fixed here, so a
           later re-run of the notebook reads the same days: that is a determinism check, never a replication.
THE FORWARD GATES (the frozen rule is MONEY only if every one passes):
  F1  net per fill: the 95% interval over 15-minute slots lies above zero
  F2  the placebo (the same firing seconds, a fair-coin side, 200 draws) is beaten at its 95th percentile
  F3  the planted peek (the winning side at the same seconds) pays more than the rule by at least USD 5 a fill: the fill model can tell a side from a coin
  F4  the fill rate is in the design band: windows with a fill over windows with a burst between 12% and 49% (half and twice the design's 24.5% as first read; 23.3% once the queue of a Down bid was read in float64, 2026-10-10), else FLAG: the fill model is not behaving as in design
  F5  net per fill above zero in both halves of the forward days, and at twice the queue ahead (a pessimistic fill), and with no rebate
  F6  the adverse-selection read replicates: fill minus miss in the token's 5 s mid move is negative with its interval below zero (design: -0.7 cent); an INFO line, it does not decide MONEY
  The word is MONEY (class A) if F1 to F5 pass; NO MONEY class B if the point estimate is above zero and F1 fails; class C otherwise; NOT OPENED while fewer than 25 forward days are seated.
"""
from __future__ import annotations

import datetime as dt

import numpy as np

import mkb15_mk as X
import tf15_bt as B

SIGNAL = (1, 2.5)
ASSETS = (0, 1)                                                       # BTC, ETH
FILL_MS = 150                                                         # the table's ladder delay; the maker's post latency is the same 150 ms
DESIGN_FROM, DESIGN_N = "2026-09-16", 22
FORWARD_FROM, FORWARD_N = "2026-10-08", 25
N_PLACEBO = 200
PEEK_MARGIN = 5.0
FILL_BAND = (0.12, 0.49)
ECON_BAR = 1.0                                                        # USD a fill the owner's desk would call worth running at this clip [U]


def days_from(first: str, n: int) -> tuple:
    d0 = dt.date.fromisoformat(first)
    return tuple((d0 + dt.timedelta(days=i)).isoformat() for i in range(n))


DESIGN_DAYS = days_from(DESIGN_FROM, DESIGN_N)
FORWARD_DAYS = days_from(FORWARD_FROM, FORWARD_N)

# the sensitivity grid of the design window: shown whole, none chosen. Each is the primary with ONE thing changed.
GRID = [
    ("the primary", {}),
    ("a cent inside the touch", dict(mode="improve")),
    ("life 10 s", dict(life_s=10)),
    ("life 120 s", dict(life_s=120)),
    ("rests to expiry", dict(life_s=None)),
    ("no cancel", dict(cancel="none")),
    ("retrace 0.5 sigma", dict(retrace=0.5)),
    ("retrace 2 sigma", dict(retrace=2.0)),
    ("um-008 cancel (fair value)", dict(cancel="fv")),
    ("cancel latency 50 ms", dict(cancel_lat_ms=50)),
    ("cancel latency 500 ms", dict(cancel_lat_ms=500)),
    ("post latency 50 ms", dict(post_lat_ms=50)),
    ("no rebate", dict(rebate=0.0)),
    ("front of the queue", dict(q_mult=0.0)),
    ("half the queue", dict(q_mult=0.5)),
    ("twice the queue", dict(q_mult=2.0)),
    ("four times the queue", dict(q_mult=4.0)),
]


def load(days, fill_ms: int = FILL_MS):
    """The BTC and ETH windows of the days, with the Binance 1 s path (`mom15_bt.MTab`)."""
    import mom15_bt as M
    return M.MTab(days, fill_ms=fill_ms, assets=ASSETS)


def burst(tab, lead: int = 0):
    """-> (side, trig) of the frozen signal on `tab`; `lead` > 0 is the PLANTED leak (the return read `lead` s from the future)."""
    import mom15_bt as M
    return M.Signal(SIGNAL[0], SIGNAL[1], lead=lead).fire(tab)


def run(tab, side, trig, cfg=None, pu_e=None):
    o = X.run(tab, side, trig, cfg, pu_e=pu_e)
    return o, X.fills(o)


def summary(e, tab, label=""):
    return B.summarize(e, tab, label)


def burst_windows(trig) -> int:
    return int(trig.any(1).sum())


def placebo(tab, trig, cfg=None, n: int = N_PLACEBO, seed0: int = 1000):
    """Per-fill net of the same rule with a fair-coin side at the same firing seconds, n draws. -> (per [n], fills [n])."""
    per, nf = [], []
    for i in range(n):
        o = X.run(tab, X.with_side(tab, trig, "placebo", seed0 + i), trig, cfg)
        e = X.fills(o)
        per.append(float(e["net"].mean()) if len(e["net"]) else np.nan)
        nf.append(len(e["net"]))
    return np.array(per), np.array(nf)


def peek(tab, trig, cfg=None):
    o = X.run(tab, X.with_side(tab, trig, "peek"), trig, cfg)
    return o, X.fills(o)


def clip_value(o):
    """USD a clip-sized order of every posted order would have earned if filled: target x (won - b) (filled or not). Fills and misses are compared on this, so size does not weight them."""
    return o["target"] * (o["won"].astype(float) - o["b"])


def adverse(tab, o, horizons=(5, 30), n_boot: int = 4000):
    """The adverse selection of the fills: what a fill earned against what a miss would have, and where the token's mid and Binance went afterwards. -> dict of (fill mean, miss mean, diff, lo, hi) rows."""
    f = o["is_fill"]
    rf, rm = np.flatnonzero(f), np.flatnonzero(~f)
    out = {}
    cv, ps = clip_value(o), o["per_share"]
    for nm, v in (("clip value, USD", cv), ("a share, USD", ps), ("win share", o["won"].astype(float))):
        d = X.diff_boot(o["slot"][rf], v[rf], o["slot"][rm], v[rm], n_boot)
        out[nm] = (float(np.mean(v[rf])), float(np.mean(v[rm])), *d)
    delay = float(np.median(o["t_fill"][rf] - o["t_eff"][rf])) if len(rf) else 0.0
    out["fill delay, s"] = delay / 1000.0
    for h in horizons:
        mf = X.move_after(tab, o, rf, o["t_fill"][rf], h)
        mm = X.move_after(tab, o, rm, o["t_eff"][rm] + delay, h)
        out[f"token mid, +{h} s"] = (float(np.nanmean(mf)), float(np.nanmean(mm)), *X.diff_boot(o["slot"][rf], mf, o["slot"][rm], mm, n_boot))
        bf = X.move_after(tab, o, rf, o["t_fill"][rf], h, binance=True)
        bm = X.move_after(tab, o, rm, o["t_eff"][rm] + delay, h, binance=True)
        out[f"Binance mid, +{h} s (bp)"] = (float(np.nanmean(bf)), float(np.nanmean(bm)), *X.diff_boot(o["slot"][rf], bf, o["slot"][rm], bm, n_boot))
    return out


def halves(e, days):
    """Net per fill in the first and the second half of `days`. -> [(label, n, per, lo, hi)]."""
    mid = len(days) // 2
    out = []
    for lab, m in ((f"{days[0][5:]} to {days[mid - 1][5:]}", e["day"] < mid), (f"{days[mid][5:]} to {days[-1][5:]}", e["day"] >= mid)):
        v, sl = e["net"][m], e["slot"][m]
        lo, hi = B.slot_boot(sl, v) if len(v) else (np.nan, np.nan)
        out.append((lab, int(m.sum()), float(v.mean()) if len(v) else np.nan, lo, hi))
    return out


def by_day(e, ndays):
    return np.bincount(e["day"], weights=e["net"], minlength=ndays), np.bincount(e["day"], minlength=ndays)


def tail_share(e, q: float = 0.05):
    """The share of the total net that sits in the best q of the fills (a tail number: a mean that one fat winner carries)."""
    v = np.sort(e["net"])[::-1]
    k = max(1, int(np.ceil(q * len(v))))
    tot = v.sum()
    return float(v[:k].sum() / tot) if tot != 0 else float("nan"), k


def cvar(e, q: float = 0.05):
    """The mean of the worst q of the fills (USD)."""
    v = np.sort(e["net"])
    k = max(1, int(np.ceil(q * len(v))))
    return float(v[:k].mean())


def bands(e, edges=(0.0, 0.30, 0.45, 0.55, 0.70, 0.97)):
    """Net per fill by the price b paid. -> [(label, n, per, lo, hi, win, breakeven)]."""
    out = []
    for a, z in zip(edges[:-1], edges[1:]):
        m = (e["b"] >= a) & (e["b"] < z)
        if m.sum() == 0:
            out.append((f"{a:.2f} to {z:.2f}", 0, np.nan, np.nan, np.nan, np.nan, np.nan))
            continue
        v = e["net"][m]
        lo, hi = B.slot_boot(e["slot"][m], v)
        out.append((f"{a:.2f} to {z:.2f}", int(m.sum()), float(v.mean()), lo, hi, float(e["won"][m].mean()), float(e["b"][m].mean())))
    return out


def half_width(sd: float, n):
    """The 95% half-width of a mean of n fills of standard deviation sd (the normal approximation; the slot bootstrap is wider by the clustering, checked in the notebook)."""
    return 1.96 * sd / np.sqrt(np.asarray(n, float))


def fills_needed(sd: float, delta: float) -> float:
    """The fills at which an effect of `delta` USD a fill just clears zero at the 95% line."""
    return float((1.96 * sd / delta) ** 2)


class ForwardGate:
    """The forward days' table, behind one door: `open` reads them once, only when every one of FORWARD_DAYS is seated; `state` says how many are."""

    def __init__(self, loader, seated):
        self._loader, self._seated = loader, seated
        self._tab = None

    def state(self):
        got = [d for d in FORWARD_DAYS if self._seated(d)]
        return len(got), len(FORWARD_DAYS), got

    def is_open(self) -> bool:
        return self.state()[0] == len(FORWARD_DAYS)

    def open(self):
        n, tot, _ = self.state()
        if n < tot:
            raise RuntimeError(f"the forward days are not all seated ({n} of {tot}): the read is not opened")
        if self._tab is None:
            self._tab = self._loader()
        return self._tab


def forward_read(tab, days, n_placebo: int = N_PLACEBO):
    """The registered gates F1 to F6 on a table of `days` (the forward days when the gate opens; the notebook also runs it once on the DESIGN days as a rehearsal of the code path, which proves
    the code runs and reproduces the design numbers, and is never read as a forward result). -> dict with the numbers, the gate booleans (f1..f6) and the verdict (word, class)."""
    side, trig = burst(tab)
    o, e = run(tab, side, trig)
    sm = summary(e, tab, "forward")
    out = dict(orders=o, fills=e, summary=sm, days=tuple(days), n=len(e["net"]))
    if out["n"] == 0:
        out.update(f1=False, f2=False, f3=False, f4=False, f5=False, f6=False, verdict=("NO MONEY", "C"))
        return out
    per_pl, _n = placebo(tab, trig, n=n_placebo)
    pk_o, pk_e = peek(tab, trig)
    n_burst = burst_windows(trig)
    rate = len(np.unique(e["w"])) / max(n_burst, 1)
    hv = halves(e, days)
    q2 = run(tab, side, trig, dict(q_mult=2.0))[1]
    nr = run(tab, side, trig, dict(rebate=0.0))[1]
    adv = adverse(tab, o)
    mid5 = adv["token mid, +5 s"]
    out.update(placebo=per_pl, p95=float(np.nanquantile(per_pl, 0.95)), peek=pk_e, peek_per=float(pk_e["net"].mean()) if len(pk_e["net"]) else float("nan"), rate=rate, n_burst=n_burst, halves=hv,
               q2_per=float(q2["net"].mean()) if len(q2["net"]) else float("nan"), norebate_per=float(nr["net"].mean()) if len(nr["net"]) else float("nan"), adverse=adv)
    out["f1"] = bool(sm["per_lo"] > 0)
    out["f2"] = bool(sm["per"] > out["p95"])
    out["f3"] = bool(out["peek_per"] >= sm["per"] + PEEK_MARGIN)
    out["f4"] = bool(FILL_BAND[0] <= rate <= FILL_BAND[1])
    out["f5"] = bool(all(h[2] > 0 for h in hv) and out["q2_per"] > 0 and out["norebate_per"] > 0)
    out["f6"] = bool(mid5[4] < 0)
    out["verdict"] = verdict(sm["per"], sm["per_lo"], out["n"], out["f1"], out["f2"], out["f3"], out["f4"], out["f5"])
    return out


def verdict(per, lo, n, f1, f2, f3, f4, f5):
    """-> (word, class). See the module docstring."""
    if n == 0:
        return "NO MONEY", "C"
    if f1 and f2 and f3 and f4 and f5:
        return "MONEY", "A"
    return "NO MONEY", ("B" if per > 0 else "C")


# ============================================================ the module's own checks
def selftest() -> bool:
    ok = True

    def line(label, cond):
        nonlocal ok
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        ok &= bool(cond)

    line("the design window is 22 days from 09-16 to 10-07 and the forward window 25 days from 10-08 to 11-01, with no day in both",
         DESIGN_DAYS[0] == "2026-09-16" and DESIGN_DAYS[-1] == "2026-10-07" and FORWARD_DAYS[0] == "2026-10-08" and FORWARD_DAYS[-1] == "2026-11-01" and not set(DESIGN_DAYS) & set(FORWARD_DAYS))
    line("every grid cell changes at most one thing of the primary", all(len(c) <= 1 for _n, c in GRID) and GRID[0][1] == {})
    line("every grid key is a key of the engine's defaults", all(set(c) <= set(X.DEFAULT) for _n, c in GRID))
    gate = ForwardGate(lambda: "tab", lambda d: d < "2026-10-20")
    try:
        gate.open()
        refused = False
    except RuntimeError:
        refused = True
    line("the forward gate refuses to open while any forward day is unseated", refused and not gate.is_open() and gate.state()[0] == 12)
    gate2 = ForwardGate(lambda: "tab", lambda d: True)
    line("the forward gate opens once every day is seated", gate2.is_open() and gate2.open() == "tab")
    line("fills_needed and half_width agree: the fills that clear zero have a half-width equal to the effect", abs(float(half_width(30.0, fills_needed(30.0, 1.5))) - 1.5) < 1e-9)
    line("the verdict is MONEY only with every gate, class B with a positive point and a failed interval, class C otherwise",
         verdict(1, 1, 5, True, True, True, True, True) == ("MONEY", "A") and verdict(1, -1, 5, False, True, True, True, True) == ("NO MONEY", "B")
         and verdict(-1, -2, 5, False, False, True, True, True) == ("NO MONEY", "C") and verdict(1, 1, 5, True, True, False, True, True) == ("NO MONEY", "B"))
    e = dict(net=np.array([10.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0]))
    sh, k = tail_share(e, 0.1)
    line("the best 10% of ten fills (10, -1, ...) hold 10 / 1 of the net, and the worst 10% average -1", k == 1 and abs(sh - 10.0) < 1e-9 and abs(cvar(e, 0.1) + 1.0) < 1e-9)
    return bool(ok)


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
