"""Exits for the buy-near rule (15-minute Polymarket Up/Down): leave a trade that looks lost, take a profit, and measure what each exit is worth. numpy only
(plus pandas in `exit_report` and the `tf15_*` modules); no I/O except the selftest's table load.

THE MECHANICS. `tf15_bt.entries` holds to expiry or sells after a fixed number of seconds. Here a CONDITION (a boolean matrix over the decision seconds of each
entry) names the exit second: the first second strictly after the entry, at least `min_hold` seconds held, before the last decision second, where it is true.
The sale is the engine's own: the near token's bid ladder as of exit second + fill_ms (`tf15_bt.ladder_of(..., buy=False)`), walked best level first by
`tf15_bt.walk_sell`, the taker fee `rate x p x (1 - p)` on what is sold, and what the ladder does not take is held to expiry and settles on the venue's
resolution. No price is used that the engine does not have.
CAUSAL. A condition at decision second s may read the table columns up to s only (never the venue's resolution). `assert_causal` proves it for a given condition by
replacing every column after s with +-1e6, flipping the resolution and scrambling the entry's own outcome keys, and requiring the matrix up to s to be unchanged.
THE FRAME. Every series is in the NEAR token's frame: the Down bid is 1 - the Up ask, the Down fair value is 1 - pu, the Down burst z is -zl. Prices are on the cent
grid (rounded to 4 decimals, as `ladder_of` does) so a float32 table never decides a strict comparison.
"""
from __future__ import annotations

import copy
import sys

import numpy as np

import tf15_bt as B

BURST = {10: 0, 30: 1, 60: 2}                                  # the zl column of an L-second burst
LAST_NEVER = -1                                                # exit second -1: hold to expiry


class RowMat(np.ndarray):
    """A boolean (N, NK) matrix for the ENTRIES' rows (a condition builder's output), told apart from a (W, NK) matrix over the table's windows."""


def _rowmat(a) -> RowMat:
    return np.asarray(a, bool).view(RowMat)


# ============================================================ the near token's book and the mark path
def _near_book(tab, e):
    """The near token's best bid and ask as the trader sees them at each decision second, (N, NK) float64 on the cent grid, in the near frame."""
    w, s = np.asarray(e["w"]), np.asarray(e["side"])[:, None]
    qb, qa = tab.qb[w].astype(float), tab.qa[w].astype(float)
    return np.round(np.where(s > 0, qb, 1.0 - qa), 4), np.round(np.where(s > 0, qa, 1.0 - qb), 4)


def mark_path(tab, e):
    """-> (bid_path, ask_path), each (N, NK) float32: the near token's best bid and best ask from the entry second k to the last decision second, NaN before k and
    wherever the book shows nothing. The book is the one seen at t (`qb`/`qa`), the mark a holder would see, not the ladder a sale reaches at t + fill_ms.
    Proves the shape, the frame (Down bid = 1 - Up ask) and the NaN mask; does not prove a sale at the bid is possible (that is `apply_exit`'s ladder)."""
    bid, ask = _near_book(tab, e)
    before = np.arange(tab.NK)[None, :] < np.asarray(e["k"])[:, None]
    bid[before] = np.nan
    ask[before] = np.nan
    return bid.astype(np.float32), ask.astype(np.float32)


def excursions(tab, e, to_exit=True):
    """Per entry the worst and best mark on the position, in USD, and when. mark = shares x (bid - price paid) at each second from k; MAE = the lowest, capped at 0,
    MFE = the highest, floored at 0 (a trade that never marked below its cost has MAE 0 and no second). Fees are not in a mark. With `to_exit` and an exited
    entries dict (`ke` present), a mark after the exit second is not the position's: the path stops at ke. -> dict of N arrays: mae, mfe (USD), mae_k, mfe_k (decision
    index, -1 when 0), mae_s, mfe_s (seconds after entry, -1 when 0), end_k (last second marked), final_bid, final_mark (USD at end_k; NaN if the book was empty).
    This is the chart bank's `mae-mfe` input. It proves the path extremes, not that the position could be sold at them."""
    bid, _ = mark_path(tab, e)
    bid = bid.astype(float)
    N, NK = bid.shape
    k = np.asarray(e["k"], int)
    end = np.full(N, NK - 1)
    if to_exit and "ke" in e:
        ke = np.asarray(e["ke"], int)
        end = np.where(ke >= 0, ke, end)
    col = np.arange(NK)[None, :]
    valid = np.isfinite(bid) & (col >= k[:, None]) & (col <= end[:, None])
    lo = np.where(valid, bid, np.inf)
    hi = np.where(valid, bid, -np.inf)
    sh, vw = np.asarray(e["shares"], float), np.asarray(e["vwap"], float)
    amin, amax = lo.argmin(1), hi.argmax(1)
    any_ = valid.any(1)
    mae = np.where(any_, np.minimum(sh * (lo.min(1) - vw), 0.0), 0.0)
    mfe = np.where(any_, np.maximum(sh * (hi.max(1) - vw), 0.0), 0.0)
    mae_k = np.where(mae < 0, amin, -1)
    mfe_k = np.where(mfe > 0, amax, -1)
    fb = bid[np.arange(N), end]
    return dict(mae=mae, mfe=mfe, mae_k=mae_k, mfe_k=mfe_k, mae_s=np.where(mae_k >= 0, mae_k - k, -1), mfe_s=np.where(mfe_k >= 0, mfe_k - k, -1),
                end_k=end, final_bid=fb, final_mark=sh * (fb - vw))


# ============================================================ the exit second
def _rows(tab, e, cond):
    """A condition as a bool (N, NK) matrix on the entries' rows: a function `(tab, e) -> (N, NK)`, a `RowMat`, or a (W, NK) matrix over the table's windows."""
    N = len(e["w"])
    if callable(cond):
        m = np.asarray(cond(tab, e), bool)
    elif isinstance(cond, RowMat):
        m = np.asarray(cond, bool)
    else:
        m = np.asarray(cond, bool)
        if m.shape != (tab.W, tab.NK):
            raise ValueError(f"a plain matrix must be (W, NK) = {(tab.W, tab.NK)}, got {m.shape}; wrap an entries' (N, NK) matrix as RowMat")
        m = m[np.asarray(e["w"])]
    if m.shape != (N, tab.NK):
        raise ValueError(f"a condition must give (N, NK) = {(N, tab.NK)}, got {m.shape}")
    return _rowmat(m)


def exit_second(tab, e, cond, min_hold=1, through_last=False):
    """-> ke (N,) int: the first decision index s where `cond` is true with s >= k + min_hold and s <= NK - 2 (before the last decision second; `through_last` allows
    NK - 1, which is what `tf15_bt.entries(hold=h)` allows), or -1 (hold to expiry). min_hold >= 1, so an exit is never at the entry second. It is causal only if the
    condition is (see `assert_causal`); this function only picks the first true second."""
    if min_hold < 1:
        raise ValueError("min_hold must be at least 1 second")
    m = _rows(tab, e, cond)
    col = np.arange(tab.NK)[None, :]
    k = np.asarray(e["k"], int)[:, None]
    m = m & (col >= k + int(min_hold)) & (col <= (tab.NK - 1 if through_last else tab.NK - 2))
    return np.where(m.any(1), m.argmax(1), LAST_NEVER).astype(int)


def combine(*conds):
    """The first of any: the OR of conditions. Given `RowMat`s it returns a `RowMat`; given functions it returns a function `(tab, e) -> RowMat`. Proves nothing about
    which fired (that is `first_reason`)."""
    if any(callable(c) for c in conds):
        return lambda tab, e: combine(*[_rowmat(_rows(tab, e, c)) for c in conds])
    out = np.asarray(conds[0], bool).copy()
    for c in conds[1:]:
        out |= np.asarray(c, bool)
    return _rowmat(out)


def first_reason(tab, e, conds, min_hold=1, through_last=False):
    """`conds` is a dict name -> condition. -> (ke, reason): the earliest exit second over all conditions and the name of the one that fired (the first listed on a tie);
    ke -1 and reason 'expiry' when none fires. The names go to `apply_exit(reason=...)` and the report's share-of-exits columns."""
    names = list(conds)
    kes = np.stack([exit_second(tab, e, conds[n], min_hold, through_last) for n in names])         # (C, N)
    key = np.where(kes >= 0, kes, np.iinfo(np.int64).max)
    j = key.argmin(0)
    ke = kes[j, np.arange(kes.shape[1])]
    reason = np.where(ke >= 0, np.array(names, dtype=object)[j], "expiry")
    return ke.astype(int), reason.astype(str)


# ============================================================ the condition builders
def _z_near(tab, e, L):
    return np.round(np.asarray(e["side"])[:, None] * tab.zl[np.asarray(e["w"]), :, BURST[L]].astype(float), 5)


def reversal(tab, e, L=10, z_back=2.0):
    """True where the L-second Binance burst z points against the position by at least z_back (the near-frame z is at or under -z_back). Reads zl at the second only.
    Proves the sign convention for both sides on a synthetic table; says nothing about whether such a reversal is followed by a loss."""
    return _rowmat(_z_near(tab, e, L) <= -float(z_back))


def bid_stop(tab, e, drop=0.10):
    """True where the near token's bid is under the price paid (the entry's vwap) minus `drop`. Strict, on the cent grid."""
    bid, _ = _near_book(tab, e)
    return _rowmat(bid < np.round(np.asarray(e["vwap"], float) - drop, 6)[:, None])


def level_stop(tab, e, floor=0.30):
    """True where the near token's bid is under `floor`."""
    bid, _ = _near_book(tab, e)
    return _rowmat(bid < floor)


def fair_stop(tab, e, margin=0.0):
    """True where the driftless fair value of the near token (pu for Up, 1 - pu for Down) is under the price paid plus `margin`: the model no longer likes the trade."""
    pu = tab.pu[np.asarray(e["w"])].astype(float)
    fair = np.where(np.asarray(e["side"])[:, None] > 0, pu, 1.0 - pu)
    return _rowmat(np.round(fair, 6) < np.round(np.asarray(e["vwap"], float) + margin, 6)[:, None])


def take_profit(tab, e, level=0.95):
    """True where the near token's bid has reached `level` (lock the win before a last-minute reversal)."""
    bid, _ = _near_book(tab, e)
    return _rowmat(bid >= level - 1e-9)


def time_stop(tab, e, hold_s):
    """True from k + hold_s on. With exit_second(through_last=True) its exit second is k + hold_s, the sale `tf15_bt.entries(hold=hold_s)` makes."""
    col = np.arange(tab.NK)[None, :]
    return _rowmat(col >= (np.asarray(e["k"], int) + int(hold_s))[:, None])


# ============================================================ settling an exit
def _check_net(net, payoff, cost, fee):
    bad = np.abs(net - (payoff - cost - fee)) > 1e-9
    if bad.any():
        raise AssertionError(f"net != payoff - cost - fee on {int(bad.sum())} rows (first row {int(np.flatnonzero(bad)[0])})")


def apply_exit(tab, e, ke, fill_ms_extra=0, reason=None):
    """Settle every entry of `e` (hold-to-expiry entries from `tf15_bt.entries`) with an exit at decision index `ke` (-1 = hold to expiry): sell the whole position
    into the near token's bid ladder as of ke + fill_ms (best level first, no floor), the fee on the sale; what the ladder does not take is held and pays 1 if the
    token wins by the venue's resolution (read here, to settle, nowhere else). `fill_ms_extra` is more exit latency than the table's fill_ms, rounded UP to whole
    seconds (the table has a ladder a second, not a millisecond); the ladder is read that many decision seconds later, capped at the last. `reason` is one name or an
    array of names for the exited rows; a row whose ladder took nothing keeps its name with the suffix '|nobid' and is held. -> the dict `tf15_bt.entries` returns
    (net = payoff - cost - fee, fee = entry + exit fee) plus ke, exit_reason (str), exit_px (vwap of the sale, NaN if none), exit_fee. Proves the accounting row by row
    (net recomputed from proceeds and the held payoff, then asserted equal); does not prove the sale is possible at the second the condition fired."""
    ke = np.asarray(ke, int)
    N = len(e["w"])
    if len(ke) != N:
        raise ValueError("ke needs one second per entry")
    if N and np.asarray(e["sold"]).sum() != 0:
        raise ValueError("apply_exit takes hold-to-expiry entries (sold = 0)")
    w, side = np.asarray(e["w"]), np.asarray(e["side"])
    shares, cost = np.asarray(e["shares"], float), np.asarray(e["cost"], float)
    ex = ke >= 0
    shift = int(np.ceil(fill_ms_extra / 1000.0))
    kf = np.minimum(np.where(ex, ke, 0) + shift, tab.NK - 1)
    bpx, bsz = B.ladder_of(tab, w, kf, side, buy=False)
    sold, proceeds, efee = B.walk_sell(bpx, bsz, shares, tab.w_fee[w].astype(float))
    sold, proceeds, efee = np.where(ex, sold, 0.0), np.where(ex, proceeds, 0.0), np.where(ex, efee, 0.0)
    won = np.asarray(e["won"], bool)
    rest = shares - sold
    held = np.where(won, rest, 0.0)
    fee = np.asarray(e["fee"], float) + efee
    net = (proceeds - cost - np.asarray(e["fee"], float) - efee) + held          # proceeds + the held payoff - cost - both fees, written without the payoff
    payoff = proceeds + held
    _check_net(net, payoff, cost, fee)
    if reason is None:
        why = np.where(ex, "exit", "expiry").astype(object)
    else:
        r = np.asarray(reason, dtype=object)
        why = np.where(ex, r if r.ndim else str(r), "expiry").astype(object)
    nobid = ex & (sold <= 1e-9)
    why = np.where(nobid, np.char.add(why.astype(str), "|nobid"), why).astype(str)
    out = dict(e)
    out.update(fee=fee, won=won, payoff=payoff, net=net, gross=payoff - cost, sold=sold, ke=ke, exit_reason=why,
               exit_px=np.where(sold > 1e-9, proceeds / np.maximum(sold, 1e-9), np.nan), exit_fee=efee)
    return out


# ============================================================ the causal proof
_TIME_AXIS1 = ("S", "z", "sig", "pu", "qb", "qa", "qbs", "qas", "age", "known", "zl")          # time on axis 1
_OUTCOME_KEYS = ("won", "payoff", "net", "gross")


def _future_cut(a, axis, start, sign):
    a = np.array(a, copy=True)
    sl = [slice(None)] * a.ndim
    sl[axis] = slice(start, None)
    sl = tuple(sl)
    if a.dtype.kind == "f":
        a[sl] = sign * 1e6
    elif a.dtype.kind == "b":
        a[sl] = ~a[sl]
    else:
        a[sl] = a[sl] + 1000 * sign
    return a


def _perturbed(tab, s, sign):
    """A shallow copy of the table with every time-indexed column after decision index s replaced (floats by sign x 1e6, bools inverted), the Binance path after index 60 + s
    cut alike, and the venue's resolution flipped."""
    t = copy.copy(tab)
    for name in _TIME_AXIS1:
        if hasattr(tab, name):
            setattr(t, name, _future_cut(getattr(tab, name), 1, s + 1, sign))
    if hasattr(tab, "lad"):
        t.lad = _future_cut(tab.lad, 2, s + 1, sign)
    if hasattr(tab, "path"):
        t.path = _future_cut(tab.path, 1, 60 + s + 1, sign)
    t.up = ~np.asarray(tab.up, bool)
    if hasattr(tab, "w_up"):
        t.w_up = ~np.asarray(tab.w_up, bool)
    return t


def assert_causal(tab, e, fn, cuts=None):
    """Raise AssertionError if the condition function `fn(tab, e) -> (N, NK)` reads past the decision second or the venue's resolution. For each cut s (default five spread
    seconds) and each sign, the table after s is replaced by +-1e6 (resolution flipped, the entries' outcome keys scrambled) and `fn`'s matrix up to s must be bit-identical.
    Proves a condition does not depend on those inputs at the cuts tried; a condition that reads the future only where the planted values happen not to change its
    answer would pass (two signs make that unlikely, not impossible). -> True."""
    base = np.asarray(_rows(tab, e, fn), bool)
    NK = tab.NK
    cuts = sorted({int(c) for c in (cuts if cuts is not None else np.linspace(3, NK - 3, 5))})
    e2 = dict(e)
    e2["won"] = ~np.asarray(e["won"], bool)
    for key in _OUTCOME_KEYS[1:]:
        e2[key] = np.full(len(e["w"]), 1e6)
    for s in cuts:
        for sign in (1, -1):
            got = np.asarray(_rows(_perturbed(tab, s, sign), e2, fn), bool)
            diff = got[:, :s + 1] != base[:, :s + 1]
            if diff.any():
                r, c = np.argwhere(diff)[0]
                raise AssertionError(f"condition reads the future or the resolution: at cut {s} (sign {sign:+d}) row {r} second {c} changed")
    return True


# ============================================================ the report
def exit_report(tab, e_base, variants):
    """One row a variant (a dict name -> entries from `apply_exit`, or `e_base` itself for the hold): n, net an entry with its 95% interval over 15-minute slots, win (share
    of trades with net above 0) and win_token (the token resolved the trade's way), net an entry without the best 5% of entries, mean MAE and MFE (USD, to the exit
    second when exited), n_exit and the share of entries by exit reason (columns share_<reason>, expiry included), and what the exits are worth on the SAME entries:
    exited_net (the exited trades' net with the exit), exited_held (their net had they been held, from `e_base`), exit_worth (the variant's total net minus the base's)
    and worth_per (that per entry, with an interval over slots). Every variant must be `e_base`'s rows in order. Two days are an illustration: the intervals say so."""
    import pandas as pd
    w0, k0 = np.asarray(e_base["w"]), np.asarray(e_base["k"])
    reasons = sorted({r for v in variants.values() for r in np.asarray(v.get("exit_reason", []), str)} | {"expiry"})
    rows = {}
    for name, v in variants.items():
        if not (np.array_equal(np.asarray(v["w"]), w0) and np.array_equal(np.asarray(v["k"]), k0)):
            raise ValueError(f"variant {name!r} is not the base entries' rows")
        n = len(v["net"])
        if n == 0:
            rows[name] = dict(n=0)
            continue
        s = B.summarize(v, tab)
        ex = np.asarray(v.get("ke", -np.ones(n, int)), int) >= 0
        why = np.asarray(v.get("exit_reason", np.full(n, "expiry")), str)
        xs = excursions(tab, v)
        diff = np.asarray(v["net"], float) - np.asarray(e_base["net"], float)
        lo, hi = B.slot_boot(np.asarray(v["slot"]), diff)
        row = dict(n=n, net_per=s["per"], lo=s["per_lo"], hi=s["per_hi"], win=float(np.mean(np.asarray(v["net"]) > 0)), win_token=s["win"], per_ex_top5=s["per_ex_top5"],
                   mae=float(xs["mae"].mean()), mfe=float(xs["mfe"].mean()), n_exit=int(ex.sum()),
                   exited_net=float(np.asarray(v["net"])[ex].sum()), exited_held=float(np.asarray(e_base["net"])[ex].sum()),
                   exit_worth=float(diff.sum()), worth_per=float(diff.mean()), worth_lo=lo, worth_hi=hi)
        for r in reasons:
            row[f"share_{r}"] = float(np.mean(why == r))
        rows[name] = row
    return pd.DataFrame.from_dict(rows, orient="index")


# ============================================================ the selftest: a synthetic table of 20 decision seconds
_NK = 20
_P0 = [0.70, 0.70, 0.68, 0.66, 0.63, 0.60, 0.55, 0.50, 0.48, 0.52, 0.58, 0.65, 0.72, 0.80, 0.88, 0.95, 0.97, 0.98, 0.99, 0.99]        # falls then rises
_P3 = [0.70, 0.70, 0.72, 0.74, 0.76, 0.78, 0.80, 0.82, 0.84, 0.86, 0.88, 0.90, 0.92, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99, 0.99]        # never falls
_Z0 = [0.0, 4.5, 3.0, 2.0, 1.0, 0.5, -1.2, -2.5, -3.2] + [0.0] * 11                                                                   # near-frame 10 s burst
_BSZ = {0: [30, 30, 30, 30], 1: [30, 30, 30, 30], 2: [10, 5, 0, 0], 3: [30, 30, 30, 30]}                                              # near bid sizes by window


def _synth():
    """Four windows of 20 decision seconds. Near token's bid path _P0 in windows 0 (Up), 1 (Down: the exact mirror of window 0 through the Up book), 2 (Up, a thin bid
    ladder 10 + 5 shares and the token LOSES) and _P3 in window 3 (Up, never falls). Ask = bid + 0.02; ladder levels step 0.01; ask sizes 30. Fair value (near) = bid + 0.03,
    10 s burst z = _Z0 in the near frame (the Up z is negated for the Down window)."""
    W, NK = 4, _NK
    bid = np.array([_P0, _P0, _P0, _P3], float)
    nask = bid + 0.02
    sides = np.array([1, -1, 1, 1])
    lad = np.full((W, 4, NK, 4), np.nan, np.float32)
    for w in range(W):
        for j in range(4):
            nb, na = bid[w] - 0.01 * j, nask[w] + 0.01 * j                 # the near token's bid / ask at level j
            sb, sa = np.full(NK, float(_BSZ[w][j])), np.full(NK, 30.0)
            if sides[w] > 0:
                lad[w, 0, :, j], lad[w, 1, :, j], lad[w, 2, :, j], lad[w, 3, :, j] = nb, sb, na, sa
            else:                                                          # Down bid = 1 - Up ask, Down ask = 1 - Up bid
                lad[w, 2, :, j], lad[w, 3, :, j], lad[w, 0, :, j], lad[w, 1, :, j] = 1.0 - nb, sb, 1.0 - na, sa
    t = object.__new__(B.Tab)
    rng = np.random.default_rng(3)
    t.W, t.NK, t.lad = W, NK, lad
    t.qb, t.qa = lad[:, 0, :, 0].copy(), lad[:, 2, :, 0].copy()
    near_fair = bid + 0.03
    t.pu = np.where(sides[:, None] > 0, near_fair, 1.0 - near_fair).astype(np.float32)
    t.zl = np.zeros((W, NK, 3), np.float32)
    t.zl[:, :, 0] = np.array(_Z0)[None, :] * sides[:, None]
    for name in ("S", "z", "sig", "qbs", "qas", "age"):
        setattr(t, name, rng.random((W, NK)).astype(np.float32))
    t.known = rng.random((W, NK)) > 0.5
    t.path = rng.random((W, 120)).astype(np.float32)
    t.w_fee, t.up = np.full(W, 0.07), np.array([True, False, False, True])           # window 1 is a Down trade and Down wins; window 2's Up token loses
    t.day, t.slot, t.w_asset = np.zeros(W, np.int16), np.array([100, 100, 101, 101]), np.array([0, 1, 0, 1])
    t.T = (B.WIN_S - (B.K0 + np.arange(NK))).astype(float)
    t.days = ["synthetic"]
    return t, sides


def _synth_entries(tab, sides, hold=None):
    trig = np.zeros((tab.W, tab.NK), bool)
    trig[:, 1] = True
    side = np.repeat(sides[:, None], tab.NK, 1)
    return B.entries(tab, side, trig, np.full(trig.shape, 0.9), usd=20.0, hold=hold)


def _same(a, b, keys=("w", "k", "side", "shares", "cost", "fee", "vwap", "won", "payoff", "net", "gross", "sold"), tol=1e-9):
    return all(np.allclose(np.asarray(a[k], float), np.asarray(b[k], float), atol=tol, rtol=0) for k in keys)


def synthetic_checks():
    """(label, passed) for every property the brief lists, on the synthetic table."""
    out = []
    tab, sides = _synth()
    e = _synth_entries(tab, sides)
    sh0 = e["shares"][0]
    out.append(("four entries at k=1, 27.77 shares at 0.72 in window 0", len(e["w"]) == 4 and abs(sh0 - 27.77) < 1e-9 and abs(e["vwap"][0] - 0.72) < 1e-6))
    # --- mark path and excursions
    bp, ap = mark_path(tab, e)
    out.append(("mark_path is (N, NK) float32, NaN before k, the bid then the ask", bp.shape == (4, _NK) and bp.dtype == np.float32 and np.isnan(bp[:, 0]).all()
                and np.isfinite(bp[:, 1:]).all() and np.allclose(ap[:, 1:] - bp[:, 1:], 0.02, atol=1e-6)))
    out.append(("the Down window's mark path (bid = 1 - Up ask) is window 0's near path", np.allclose(bp[1, 1:], bp[0, 1:], atol=1e-6)))
    xs = excursions(tab, e)
    mae0, mfe0 = sh0 * (0.48 - 0.72), sh0 * (0.99 - 0.72)
    out.append((f"MAE/MFE of window 0 are the known {mae0:.4f} / {mfe0:.4f} at seconds 8 / 18", abs(xs["mae"][0] - mae0) < 1e-4 and abs(xs["mfe"][0] - mfe0) < 1e-4
                and xs["mae_k"][0] == 8 and xs["mfe_k"][0] == 18 and xs["mae_s"][0] == 7 and xs["mfe_s"][0] == 17))
    out.append(("window 1 (Down, mirror) has the same MAE/MFE as window 0", abs(xs["mae"][1] - xs["mae"][0]) < 1e-4 and abs(xs["mfe"][1] - xs["mfe"][0]) < 1e-4))
    out.append(("final mark is the bid at the last decision second: 0.99", abs(xs["final_bid"][0] - 0.99) < 1e-6 and abs(xs["final_mark"][0] - sh0 * 0.27) < 1e-4))
    out.append(("window 3 never marks under its 0.72 cost after the entry second but at it: MAE is the entry-second spread, MFE the 0.27 run", xs["mae"][3] < 0
                and abs(xs["mae"][3] - sh0 * (0.70 - 0.72)) < 1e-4 and abs(xs["mfe"][3] - sh0 * 0.27) < 1e-4))
    # --- the exit seconds
    bs = exit_second(tab, e, bid_stop(tab, e, 0.10))
    out.append(("bid_stop(0.10) fires at the first second the bid is under 0.62 (index 5) in windows 0, 1, 2 and never in window 3", list(bs) == [5, 5, 5, -1]))
    out.append(("bid_stop is a strict cross: at drop 0.09 (threshold 0.63) a bid of 0.63 (index 4) does not fire, index 5 does; at drop 0.07 (0.65) index 4 does",
                exit_second(tab, e, bid_stop(tab, e, 0.09))[0] == 5 and exit_second(tab, e, bid_stop(tab, e, 0.07))[0] == 4))
    out.append(("exit_second with min_hold 4 still picks index 5; min_hold 10 (from index 11, bid back over 0.62) is -1",
                exit_second(tab, e, bid_stop(tab, e, 0.10), min_hold=4)[0] == 5 and exit_second(tab, e, bid_stop(tab, e, 0.10), min_hold=10)[0] == -1))
    out.append(("level_stop(0.52) first fires at index 7 (bid 0.50); level_stop(0.30) never", exit_second(tab, e, level_stop(tab, e, 0.52))[0] == 7
                and (exit_second(tab, e, level_stop(tab, e, 0.30)) == -1).all()))
    out.append(("fair_stop(0) fires at index 2 (fair 0.71 under the 0.72 paid), the Down window too", list(exit_second(tab, e, fair_stop(tab, e)))[:2] == [2, 2]))
    out.append(("take_profit(0.95) fires at index 15 in windows 0 and 1 (the bid reaches 0.95), index 14 in window 3",
                list(exit_second(tab, e, take_profit(tab, e, 0.95))) == [15, 15, 15, 14]))
    out.append(("reversal(10 s) at z_back 1 / 2 / 3 fires at 6 / 7 / 8 in the Up window and the Down window alike",
                [int(exit_second(tab, e, reversal(tab, e, 10, z))[i]) for z in (1.0, 2.0, 3.0) for i in (0, 1)] == [6, 6, 7, 7, 8, 8]))
    out.append(("reversal on the 30 s burst (all zero) never fires", (exit_second(tab, e, reversal(tab, e, 30, 1.0)) == -1).all()))
    mat = np.zeros((tab.W, tab.NK), bool)
    mat[:, 9] = True
    out.append(("a plain (W, NK) matrix, a RowMat and a function give the same exit second", (exit_second(tab, e, mat) == exit_second(tab, e, _rowmat(mat[e["w"]]))).all()
                and (exit_second(tab, e, mat) == exit_second(tab, e, lambda t, ee: _rowmat(mat[ee["w"]]))).all() and (exit_second(tab, e, mat) == 9).all()))
    last = np.zeros((tab.W, tab.NK), bool)
    last[:, -1] = True
    out.append(("an exit on the last decision second is refused by default (-1) and allowed with through_last", (exit_second(tab, e, last) == -1).all()
                and (exit_second(tab, e, last, through_last=True) == _NK - 1).all()))
    # --- combine and first_reason
    cmb = combine(bid_stop(tab, e, 0.10), take_profit(tab, e, 0.95), reversal(tab, e, 10, 2.0))
    out.append(("combine is the first of any: index 5 (bid stop) in windows 0 to 2, index 7 (reversal z 2.5 under -2) in window 3 before its take profit at 14", list(exit_second(tab, e, cmb)) == [5, 5, 5, 7]))
    fcmb = combine(lambda t, ee: bid_stop(t, ee, 0.10), lambda t, ee: take_profit(t, ee, 0.95))
    out.append(("combine of functions is a function with the same answer (bid stop or take profit: 5, 5, 5, 14)", list(exit_second(tab, e, fcmb)) == [5, 5, 5, 14]))
    ke, why = first_reason(tab, e, dict(fair_stop=fair_stop(tab, e), bid_stop=bid_stop(tab, e), take_profit=take_profit(tab, e, 0.95)))
    out.append(("first_reason names the earliest: fair_stop (index 2) wins windows 0 to 2; window 3 has no fair stop and its take_profit fires",
                list(ke) == [2, 2, 2, 14] and list(why) == ["fair_stop", "fair_stop", "fair_stop", "take_profit"]))
    ke2, why2 = first_reason(tab, e, dict(bid_stop=bid_stop(tab, e), level_stop=level_stop(tab, e, 0.30)))
    out.append(("first_reason says 'expiry' with exit second -1 when nothing fires (window 3)", ke2[3] == -1 and why2[3] == "expiry" and why2[0] == "bid_stop"))
    # --- apply_exit
    base_hold = apply_exit(tab, e, np.full(4, -1))
    out.append(("an exit at -1 equals hold to expiry exactly, every key, reason 'expiry'", _same(base_hold, e, tol=0.0) and (base_hold["ke"] == -1).all()
                and (base_hold["exit_reason"] == "expiry").all()))
    xb = apply_exit(tab, e, bs, reason="bid_stop")
    p_sold = sh0 * 0.60
    f_sold = sh0 * 0.07 * 0.60 * 0.40
    exp0 = p_sold - e["cost"][0] - e["fee"][0] - f_sold
    out.append((f"window 0 sold whole at the 0.60 bid at index 5: net {exp0:+.5f}", abs(xb["net"][0] - exp0) < 1e-6 and abs(xb["sold"][0] - sh0) < 1e-9
                and abs(xb["exit_fee"][0] - f_sold) < 1e-6 and abs(xb["exit_px"][0] - 0.60) < 1e-6))
    out.append(("window 1 (Down) exits at the same near bid, so the same net as window 0", abs(xb["net"][1] - xb["net"][0]) < 1e-6 and xb["side"][1] == -1))
    pr2 = 10 * 0.60 + 5 * 0.59
    f2 = 0.07 * (10 * 0.60 * 0.40 + 5 * 0.59 * 0.41)
    exp2 = pr2 - e["cost"][2] - e["fee"][2] - f2
    out.append((f"window 2 (thin ladder, token loses): 15 of {sh0:.2f} sold at 0.60 / 0.59, the rest held and lost: net {exp2:+.5f}", abs(xb["sold"][2] - 15) < 1e-9
                and abs(xb["payoff"][2] - pr2) < 1e-6 and abs(xb["net"][2] - exp2) < 1e-6 and not xb["won"][2]))
    out.append(("window 3 is unexited: ke -1, reason 'expiry', the same net as the hold", xb["ke"][3] == -1 and xb["exit_reason"][3] == "expiry" and abs(xb["net"][3] - e["net"][3]) < 1e-12))
    out.append(("net == payoff - cost - fee on every row, exited or held", np.allclose(xb["net"], xb["payoff"] - xb["cost"] - xb["fee"], atol=1e-9, rtol=0)))
    bad = False
    try:
        _check_net(xb["net"] + 0.01, xb["payoff"], xb["cost"], xb["fee"])
    except AssertionError:
        bad = True
    out.append(("the net check raises when a net is off by a cent (broken on purpose)", bad))
    nb = apply_exit(tab, e, np.array([5, 5, 5, 5]), reason="x")
    tab_nb = copy.copy(tab)
    tab_nb.lad = tab.lad.copy()
    tab_nb.lad[0, 0, 5, :] = np.nan
    nb0 = apply_exit(tab_nb, e, np.array([5, -1, -1, -1]), reason="x")
    out.append(("a bid ladder with nothing in it takes nothing: sold 0, held, reason 'x|nobid', net as the hold", nb0["sold"][0] == 0 and nb0["exit_reason"][0] == "x|nobid"
                and abs(nb0["net"][0] - e["net"][0]) < 1e-12 and nb["exit_reason"][0] == "x"))
    xe = apply_exit(tab, e, bs, fill_ms_extra=1000, reason="bid_stop")
    exp_e = sh0 * 0.55 - e["cost"][0] - e["fee"][0] - sh0 * 0.07 * 0.55 * 0.45
    out.append(("fill_ms_extra=1000 reads the ladder one second later (0.55): net as computed", abs(xe["net"][0] - exp_e) < 1e-6))
    # --- time_stop equals entries(hold)
    for h in (3, 5, 9):
        eh = _synth_entries(tab, sides, hold=h)
        xt = apply_exit(tab, e, exit_second(tab, e, time_stop(tab, e, h), through_last=True), reason="time_stop")
        out.append((f"time_stop({h}) equals entries(hold={h}) to the cent on every key", len(eh["w"]) == 4 and _same(xt, eh, tol=1e-9)))
    eh6 = _synth_entries(tab, sides, hold=6)
    xt5 = apply_exit(tab, e, exit_second(tab, e, time_stop(tab, e, 5), through_last=True))
    out.append(("negative control: time_stop(5) does NOT equal entries(hold=6)", not _same(xt5, eh6, keys=("net",), tol=1e-3)))
    # --- causality
    ok_all = True
    for nm, fn in (("reversal", lambda t, ee: reversal(t, ee, 10, 2.0)), ("bid_stop", lambda t, ee: bid_stop(t, ee, 0.1)), ("level_stop", lambda t, ee: level_stop(t, ee, 0.5)),
                   ("fair_stop", lambda t, ee: fair_stop(t, ee, 0.0)), ("take_profit", lambda t, ee: take_profit(t, ee, 0.9)), ("time_stop", lambda t, ee: time_stop(t, ee, 4)),
                   ("combined", combine(lambda t, ee: bid_stop(t, ee, 0.1), lambda t, ee: reversal(t, ee, 30, 1.0)))):
        try:
            assert_causal(tab, e, fn)
        except AssertionError as exc:
            ok_all = False
            print("   not causal:", nm, exc)
    out.append(("assert_causal passes every named condition and a combination", ok_all))

    def peek_bid(t, ee):                                  # PLANTED: the bid one second LATER is under the stop
        b, _ = _near_book(t, ee)
        m = np.zeros(b.shape, bool)
        m[:, :-1] = b[:, 1:] < 0.62
        return _rowmat(m)

    def peek_win(t, ee):                                  # PLANTED: leave when the token will lose (reads the resolution)
        return _rowmat(np.repeat((np.asarray(ee["side"]) > 0) != np.asarray(t.up)[ee["w"]], t.NK).reshape(len(ee["w"]), t.NK))

    def peek_ladder(t, ee):                               # PLANTED: reads the ladder at the next second
        return _rowmat(np.concatenate([t.lad[np.asarray(ee["w"]), 0, 1:, 0] < 0.6, np.zeros((len(ee["w"]), 1), bool)], 1))

    def raises(fn):
        try:
            assert_causal(tab, e, fn)
        except AssertionError:
            return True
        return False

    out.append(("assert_causal CATCHES a condition that reads the bid one second ahead (planted)", raises(peek_bid)))
    out.append(("assert_causal CATCHES a condition that reads the venue's resolution (planted)", raises(peek_win)))
    out.append(("assert_causal CATCHES a condition that reads the ladder one second ahead (planted)", raises(peek_ladder)))
    # --- the report
    rep = exit_report(tab, e, {"hold": e, "bid_stop": xb, "take_profit": apply_exit(tab, e, exit_second(tab, e, take_profit(tab, e, 0.95)), reason="take_profit")})
    wsum = float((xb["net"] - e["net"]).sum())
    out.append(("exit_report: hold has exit_worth 0, bid_stop's worth is the net difference on the same entries, shares of reasons sum to 1",
                abs(rep.loc["hold", "exit_worth"]) < 1e-12 and abs(rep.loc["bid_stop", "exit_worth"] - wsum) < 1e-9
                and abs(rep.loc["bid_stop", "share_bid_stop"] + rep.loc["bid_stop", "share_expiry"] - 1) < 1e-12 and rep.loc["bid_stop", "n_exit"] == 3
                and abs(rep.loc["bid_stop", "exited_net"] - xb["net"][:3].sum()) < 1e-9 and abs(rep.loc["bid_stop", "exited_held"] - e["net"][:3].sum()) < 1e-9))
    return out


# ============================================================ the real two days
CELL = dict(name="L10|z4|th0.08|px40-85|T120|expiry", L=10, z_min=4.0, theta=0.08, band="40-85", t_min=120, exit="expiry")
DAYS = ["2026-10-06", "2026-10-07"]


def real_report(days=DAYS, fill_ms=250):
    """The um-014 chosen cell on `days`, its hold entries and the variants of the brief, causality asserted for each condition on the real table. -> (tab, e, report)."""
    import tf15_cands as C
    tab = B.Tab(days, fill_ms=fill_ms)
    e = C.BuyNearDeep().run(tab, dict(CELL), {})
    print(f"  cell {CELL['name']}: {len(e['w'])} entries on {len(days)} days, fill {fill_ms} ms; hold net {e['net'].sum():+.2f} USD ({e['net'].mean():+.3f} an entry)")
    if len(e["w"]) == 0:
        return tab, e, None
    conds = {
        "reversal z1": lambda t, ee: reversal(t, ee, 10, 1.0), "reversal z2": lambda t, ee: reversal(t, ee, 10, 2.0), "reversal z3": lambda t, ee: reversal(t, ee, 10, 3.0),
        "bid_stop 0.05": lambda t, ee: bid_stop(t, ee, 0.05), "bid_stop 0.10": lambda t, ee: bid_stop(t, ee, 0.10), "bid_stop 0.20": lambda t, ee: bid_stop(t, ee, 0.20),
        "level_stop 0.30": lambda t, ee: level_stop(t, ee, 0.30), "fair_stop 0": lambda t, ee: fair_stop(t, ee, 0.0),
        "take_profit 0.90": lambda t, ee: take_profit(t, ee, 0.90), "take_profit 0.95": lambda t, ee: take_profit(t, ee, 0.95),
    }
    for nm, fn in conds.items():
        assert_causal(tab, e, fn)
    variants = {"hold": e}
    for nm, fn in conds.items():
        variants[nm] = apply_exit(tab, e, exit_second(tab, e, fn), reason=nm.split()[0])
    named = dict(reversal=lambda t, ee: reversal(t, ee, 10, 2.0), take_profit=lambda t, ee: take_profit(t, ee, 0.95))
    ke, why = first_reason(tab, e, named)
    variants["reversal z2 + take_profit 0.95"] = apply_exit(tab, e, ke, reason=why)
    assert_causal(tab, e, combine(*named.values()))
    return tab, e, exit_report(tab, e, variants)


def real_checks(tab, e):
    """(label, passed) on the real table: time_stop(h) against `tf15_bt.entries(hold=h)` for the same rule, on the entries both make (the hold version drops a trigger whose
    sale second does not exist and takes the next one, so the sets can differ at the end of a window), and the dict-wide net identity of every exit."""
    import tf15_cands as C
    out = []
    side, trig, lim, _ = C.BuyNearDeep().triggers(tab, dict(CELL), {})
    for h in (30, 120):
        eh = B.entries(tab, side, trig, lim, hold=h)
        key = lambda d: {(int(a), int(b)): i for i, (a, b) in enumerate(zip(d["w"], d["k"]))}      # noqa: E731
        kh, kb = key(eh), key(e)
        both = sorted(set(kh) & set(kb))
        xt = apply_exit(tab, e, exit_second(tab, e, time_stop(tab, e, h), through_last=True), reason="time_stop")
        ia, ib = [kb[x] for x in both], [kh[x] for x in both]
        same = bool(both) and all(np.allclose(np.asarray(xt[k_])[ia], np.asarray(eh[k_])[ib], atol=1e-9, rtol=0) for k_ in ("shares", "cost", "fee", "payoff", "net", "sold"))
        out.append((f"time_stop({h}) equals entries(hold={h}) to the cent on the {len(both)} of {len(e['w'])} entries both make", same))
    return out


def selftest(real=True) -> bool:
    ok = True
    print("synthetic table (4 windows, 20 decision seconds)")
    for label, cond in synthetic_checks():
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        ok &= bool(cond)
    if real:
        import pandas as pd
        print(f"real days {DAYS}, the um-014 chosen cell, fill 250 ms (two days are an illustration, not a result)")
        tab, e, rep = real_report()
        if rep is not None:
            print(f"  causal: every condition and the combination pass assert_causal on the real table ({len(e['w'])} entries)")
            for label, cond in real_checks(tab, e):
                print(f"  {'ok  ' if cond else 'FAIL'} {label}")
                ok &= bool(cond)
            with pd.option_context("display.width", 250, "display.max_columns", 40, "display.float_format", lambda x: f"{x:+.3f}"):
                print(rep.to_string())
    print("selftest", "green" if ok else "RED")
    return bool(ok)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(0 if selftest(real="--synthetic" not in sys.argv) else 1)
    print(__doc__)
