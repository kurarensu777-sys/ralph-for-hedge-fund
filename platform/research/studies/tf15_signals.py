"""The per-second signals that can be layered on the Binance burst (buy-near tradeable, task signals): a `tf15_bt.Tab` in, (W, NK) matrices out. numpy only
(pandas in `describe`), no I/O.

THE CLOCK. Column j of a decision table is second s = K0 + j = 5 + j of its window; a decision at second s has seen Binance up to t = 1000 s ms after the start
(`tab.path[:, 60 + s]` is the mid of that second, `tab.path[:, 65 + j]` equals `tab.S[:, j]`), the Up book as of t (`qb/qa/qbs/qas`), the Binance events and the
Polymarket prints stamped at or before t. An event stamped e_t ms is visible from second ceil(e_t / 1000).
THE RULE OF THE FILE. Every signal at column j reads columns <= j (path index <= 65 + j, events and prints stamped <= 1000 s, other windows only if they started
earlier). `assert_causal` proves it: it recomputes a signal on a table whose future is scrambled and asserts the past is unchanged; the selftest plants four
look-aheads and the detector must catch each. No signal reads `tab.up` or any outcome column.
EVERY SIGNAL is float32 (hour and dow int8), NaN where undefined (a book side empty, a lookback that starts before the data does, too few earlier windows).
`k` in `describe` and in `tf15_bt.entries` is a column, not a second.
"""
from __future__ import annotations

import copy
import sys

import numpy as np

import tf15_bt as B

K0 = B.K0
PATH0 = 60                                   # path index of window second 0 (the path starts 60 s before the start)
NSEC = 901                                   # visible seconds 0..900 of a window
EV_FIRST_S = 5                               # the first Binance event of a window is stamped >= 5000 ms (the table starts at second 5)
LIDX = {10: 0, 30: 1, 60: 2}                 # column of `tab.zl` by lookback length


def _cols(tab):
    """Decision second of each column, (NK,) int."""
    return K0 + np.arange(tab.NK)


def _pcols(tab):
    """Path index of each decision column, (NK,) int."""
    return PATH0 + _cols(tab)


# ============================================================ 1. level
def level(tab):
    """The window's move from its start in vol units, signed: `tab.z` as the table holds it. WHAT IT IS. z = ln(S_t / A0) / (sig sqrt(max(t_el, 1))) from
    `updown15_run.features`: S_t the Binance trade-implied mid at t, A0 the start reference (the market's trailing 60 s mean at the start), sig the slow
    per-second vol (1 / sqrt(s)), t_el the seconds since the start. Positive = the price is above the start (the Up side leads), negative = Down leads. Unit: a z
    (dimensionless). WHAT IT DOES NOT SEE. Chainlink itself (A0 is a Binance proxy of the venue's reference), the book, anything after t."""
    return tab.z.astype(np.float32, copy=False)


def level_abs(tab):
    """|z|: how far the window already is from its start, whichever way. Unit: a z. Sees what `level` sees."""
    return np.abs(tab.z).astype(np.float32)


# ============================================================ 2. rsi
def _rsi_of(avg_gain, avg_loss):
    """100 x gain / (gain + loss); NaN where both are zero (a flat path has no strength to read)."""
    tot = avg_gain + avg_loss
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(tot > 0, 100.0 * avg_gain / np.where(tot > 0, tot, 1.0), np.nan)


def rsi_path(path, n=14, step_s=1):
    """Wilder's RSI at every index of `path` (W, P), each read on its own lattice of `step_s`-spaced points ending at that index. The first n changes of the lattice
    seed the averages (simple mean), then avg = (avg x (n - 1) + change) / n, so the memory is the whole lattice with weight 1 / n a step. NaN until n changes
    exist on the lattice. A monotone rise gives 100, a monotone fall 0, a flat path NaN. It sees only the path up to the index; it does not see volume or the book."""
    path = np.asarray(path)
    W, P = path.shape
    out = np.full((W, P), np.nan, np.float32)
    for r in range(step_s):
        x = path[:, r::step_s].astype(np.float64)
        M = x.shape[1]
        if M <= n:
            continue
        d = np.diff(x, axis=1)
        g, l_ = np.maximum(d, 0.0), np.maximum(-d, 0.0)
        ag, al = g[:, :n].mean(1), l_[:, :n].mean(1)
        res = np.empty((W, M - n))
        res[:, 0] = _rsi_of(ag, al)
        for i in range(n, M - 1):
            ag = (ag * (n - 1) + g[:, i]) / n
            al = (al * (n - 1) + l_[:, i]) / n
            res[:, i - n + 1] = _rsi_of(ag, al)
        out[:, r + (n + np.arange(M - n)) * step_s] = res
    return out


def rsi(tab, n=14, step_s=1):
    """Wilder's RSI of the Binance 1 s mid, read every `step_s` seconds (n changes), at each decision second: 0 to 100, high = a run of rises. Computed on the path
    (60 s of history before the start plus the window so far), so step_s = 5 with n = 14 needs 70 s and is NaN for the first columns. WHAT IT DOES NOT SEE. Trade
    sizes (the mid moves on a one-lot trade), the Polymarket book, anything after t. See `rsi_path` for the smoothing."""
    return rsi_path(tab.path, n, step_s)[:, _pcols(tab)]


# ============================================================ 3. spread
def spread(tab):
    """The Up token's best ask minus best bid in CENTS at t. The Down token's spread is the same number (its book is the mirror). NaN when either side is empty.
    Unit: cents. WHAT IT DOES NOT SEE. Depth beyond the touch, the book at t + fill_ms (the fill ladder), the books of the other coins."""
    return (100.0 * (tab.qa.astype(np.float64) - tab.qb)).astype(np.float32)


def rel_spread(tab):
    """The Up token's spread as a share of its ask, (qa - qb) / qa. Unit: a share (0.05 = 5%). NaN where the ask is missing or zero. For the near token of a Down
    entry the ask is 1 - qb: `near_rel_spread`."""
    qa = tab.qa.astype(np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(qa > 0, (qa - tab.qb) / np.where(qa > 0, qa, 1.0), np.nan).astype(np.float32)


def near_rel_spread(tab, side):
    """The spread over the ask of the token being bought: the Up ask for side +1, the Down ask (1 - Up bid) for side -1; NaN for side 0. `side` (W, NK)."""
    qa, qb = tab.qa.astype(np.float64), tab.qb.astype(np.float64)
    ask = np.where(side > 0, qa, 1.0 - qb)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where((ask > 0) & (side != 0), (qa - qb) / np.where(ask > 0, ask, 1.0), np.nan)
    return out.astype(np.float32)


# ============================================================ 4. imbalance
def imbalance(tab):
    """Top-of-book size imbalance of the Up token, (qbs - qas) / (qbs + qas), in the UP frame: +1 all bid size, -1 all ask size. Unit: a share in [-1, 1].
    NaN where a side is missing or both are zero. WHAT IT DOES NOT SEE. Levels behind the best, the time the size has rested, hidden size."""
    a, b = tab.qbs.astype(np.float64), tab.qas.astype(np.float64)
    tot = a + b
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(tot > 0, (a - b) / np.where(tot > 0, tot, 1.0), np.nan).astype(np.float32)


def near_imbalance(tab, side):
    """The imbalance seen from the buyer of the near token. A Down buyer wants Down-side bids heavy, which is Up-side asks heavy, so the sign flips: side +1
    keeps `imbalance`, side -1 negates it, side 0 is NaN. `side` is (W, NK) in {-1, 0, +1}."""
    side = np.asarray(side)
    return np.where(side != 0, imbalance(tab) * np.sign(side), np.nan).astype(np.float32)


# ============================================================ 5. intensity
def _cum_of(W, w, t, weights=None):
    """(W, NSEC) cumulative sums of ragged rows (window `w`, stamp `t` ms) by the second they become visible, ceil(t / 1000): column s holds the count (or the
    weights' sum) of the rows visible at second s or earlier."""
    sec = np.clip(-((-np.asarray(t, np.int64)) // 1000), 0, NSEC - 1)
    cnt = np.bincount(np.asarray(w, np.int64) * NSEC + sec, weights=weights, minlength=W * NSEC).reshape(W, NSEC)
    return np.cumsum(cnt, axis=1)


def _visible_cum(tab, fam):
    """`_cum_of` for the Binance events ('e') or the Polymarket prints ('p') of the table."""
    return _cum_of(tab.W, getattr(tab, f"{fam}_w"), getattr(tab, f"{fam}_t"))


def _window_sum(cum, secs, win_s, first_s):
    """Sum over the visible seconds (s - win_s, s] for each decision second s in `secs`; NaN where s - win_s < first_s (the lookback starts before the data)."""
    lo = secs - win_s
    ok = lo >= first_s
    out = np.full((cum.shape[0], len(secs)), np.nan, np.float32)
    out[:, ok] = cum[:, secs[ok]] - cum[:, lo[ok]]
    return out


def intensity(tab, win_s=10):
    """Binance trade events in the last `win_s` seconds, (t - win_s s, t], per decision second. Unit: events (a count; the table thins trades to the last one in
    each 20 ms, so a burst of one fill counts once). NaN while the lookback starts before second 5 (the first stored event), i.e. for s < win_s + 4.
    WHAT IT DOES NOT SEE. Trade size or side (a count, not a volume), events inside the same 20 ms, the Polymarket tape."""
    return _window_sum(_visible_cum(tab, "e"), _cols(tab), win_s, EV_FIRST_S - 1)


def _past_stats(x, min_prior):
    """Mean and sample sd of each row's values strictly BEFORE each column (NaN skipped); NaN until `min_prior` values exist. float64."""
    def one(c):
        ok = np.isfinite(c)
        c0 = np.where(ok, c, 0.0).astype(np.float64)
        n = np.cumsum(ok, axis=1) - ok
        s1 = np.cumsum(c0, axis=1) - c0
        s2 = np.cumsum(c0 * c0, axis=1) - c0 * c0
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = s1 / n
            var = (s2 - n * mean * mean) / (n - 1)
        good = n >= max(min_prior, 2)
        return np.stack([np.where(good, mean, np.nan), np.where(good, np.sqrt(np.maximum(var, 0.0)), np.nan)])
    return np.concatenate([one(x[a:a + 1024]) for a in range(0, len(x), 1024)], axis=1)


def intensity_z(tab, win_s=10, min_prior=30):
    """`intensity` as a z against the window's OWN running mean and sample sd of the same count over the decision seconds strictly before this one:
    (x_j - mean(x_<j)) / sd(x_<j). Unit: a z. NaN until `min_prior` earlier counts exist or when the sd is zero. The counts of neighbouring seconds overlap, so
    the sd is a scale, not a test statistic. WHAT IT DOES NOT SEE. Other windows or coins (a quiet coin looks busy against its own quiet), the time of day."""
    x = intensity(tab, win_s)
    mean, sd = _past_stats(x, min_prior)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(sd > 0, (x - mean) / np.where(sd > 0, sd, 1.0), np.nan).astype(np.float32)


def intensity_rel(tab, win_s=10, min_prior=30):
    """`intensity` over the window's own running mean of it up to the previous decision second: 1 = as busy as the window has been, 3 = three times. Unit: a
    ratio. NaN until `min_prior` earlier counts exist or when that mean is zero."""
    x = intensity(tab, win_s)
    mean, _ = _past_stats(x, min_prior)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(mean > 0, x / np.where(mean > 0, mean, 1.0), np.nan).astype(np.float32)


# ============================================================ 6. vol regime
def vol_regime(tab, min_prior=20):
    """Where the window's vol sits among earlier windows: the causal percentile rank of `tab.sig` at the SAME decision second among the windows of the SAME coin
    that started strictly before this one (the pool is the table, so a day sees only the days pooled with it). Rank = (earlier below + half the ties) / earlier
    count, in [0, 1]; 1 = the highest vol seen so far. NaN until `min_prior` earlier windows of the coin have a vol. A window that started earlier has stamped its
    sig at this second before our decision (start_e + s <= start + s), so no future is read. Unit: a share. WHAT IT DOES NOT SEE. Other coins, windows
    that start later (even if they exist in the table), any vol model other than the table's slow EWMA."""
    sig = tab.sig.astype(np.float32)
    out = np.full(sig.shape, np.nan, np.float32)
    for a in np.unique(tab.w_asset):
        idx = np.flatnonzero(tab.w_asset == a)
        idx = idx[np.argsort(tab.w_start[idx], kind="stable")]
        starts = tab.w_start[idx]
        first_ok = np.searchsorted(starts, starts, side="left")             # windows strictly earlier: positions < first_ok
        for pos, w in enumerate(idx):
            m = first_ok[pos]
            if m < min_prior:
                continue
            prev = sig[idx[:m]]
            n = np.isfinite(prev).sum(0)
            below = (prev < sig[w]).sum(0) + 0.5 * (prev == sig[w]).sum(0)
            out[w] = np.where((n >= min_prior) & np.isfinite(sig[w]), below / np.maximum(n, 1), np.nan)
    return out


# ============================================================ 7. tape
def _sorted_prints(tab):
    """The prints as (w, t, px, sz, side) arrays ordered by (window, stamp); the table already holds them so, and this orders only if it does not."""
    w, t = tab.p_w.astype(np.int64), tab.p_t.astype(np.int64)
    key = w * 4_000_000 + t
    if len(key) > 1 and not np.all(np.diff(key) >= 0):
        o = np.argsort(key, kind="stable")
        return w[o], t[o], tab.p_px[o], tab.p_sz[o], tab.p_side[o]
    return w, t, tab.p_px, tab.p_sz, tab.p_side


def tape(tab, win_s=10):
    """The Up token's Polymarket prints per decision second. -> dict of (W, NK) float32:
    `n` prints in (t - win_s s, t]; `vol` signed shares in that span (buy-taker minus sell-taker, `p_side` +1 / -1, in the UP frame: multiply by the entry side for
    the near token); `last_px` the price of the latest print stamped <= t (any age; NaN before the first); `last_age_s` seconds since it.
    `n` and `vol` count from the window's start, so they are NaN while s < win_s. WHAT IT DOES NOT SEE. Prints of other coins, resting orders, prints before the
    window's start (the table holds none), the fill ladder."""
    secs = _cols(tab)
    pw, pt, ppx, psz, pside = _sorted_prints(tab)
    cn = _cum_of(tab.W, pw, pt)
    cv = _cum_of(tab.W, pw, pt, weights=pside.astype(np.float64) * psz)
    n = _window_sum(cn, secs, win_s, 0)
    vol = _window_sum(cv, secs, win_s, 0)
    # the latest print visible at s of window w is row off[w] + (prints visible by s) - 1
    off = np.searchsorted(pw, np.arange(tab.W + 1))
    seen = cn[:, secs].astype(np.int64)
    has = seen > 0
    row = np.clip(off[:-1, None] + seen - 1, 0, max(len(pt) - 1, 0))
    if len(pt):
        last_px = np.where(has, ppx[row], np.nan).astype(np.float32)
        age = np.where(has, secs[None, :] - pt[row] / 1000.0, np.nan).astype(np.float32)
    else:
        last_px = np.full(n.shape, np.nan, np.float32)
        age = last_px.copy()
    return dict(n=n, vol=vol, last_px=last_px, last_age_s=age)


# ============================================================ 8. hour
def hour(tab):
    """UTC hour (0 to 23) of the window's start, (W,) int8. WHAT IT DOES NOT SEE. Anything but the clock (no calendar of macro events)."""
    return ((tab.w_start // 3_600_000) % 24).astype(np.int8)


def dow(tab):
    """UTC weekday of the window's start, (W,) int8, Monday 0 to Sunday 6 (1970-01-01 was a Thursday)."""
    return (((tab.w_start // 86_400_000) + 3) % 7).astype(np.int8)


# ============================================================ 9. since_burst
def _burst_on(tab, L, z_min):
    """(W, NK) bool: the L-second burst is at or over the threshold either way, |zl_L| >= z_min. NaN counts as no burst."""
    zl = tab.zl[:, :, LIDX[L]]
    with np.errstate(invalid="ignore"):
        return np.abs(zl) >= z_min


def since_burst(tab, L=10, z_min=4.0):
    """Seconds since the L-second burst was last over the threshold (|zl_L| >= z_min), counted in decision columns (1 s each): 0 = on now, 3 = last on three
    seconds ago. NaN until the first burst of the window. A rule that takes only the first second of a burst wants `burst_run` == 1; one that waits n seconds
    wants since_burst == n. WHAT IT DOES NOT SEE. A burst before second 5, the direction of the burst (use `tab.zl`)."""
    on = _burst_on(tab, L, z_min)
    j = np.arange(tab.NK)[None, :]
    last = np.maximum.accumulate(np.where(on, j, -1), axis=1)
    return np.where(last >= 0, j - last, np.nan).astype(np.float32)


def burst_run(tab, L=10, z_min=4.0):
    """How many decision seconds in a row the burst has been over the threshold up to now: 0 = not on, 1 = its first second, 2 = its second. Unit: seconds."""
    on = _burst_on(tab, L, z_min)
    j = np.arange(tab.NK)[None, :]
    last_off = np.maximum.accumulate(np.where(~on, j, -1), axis=1)
    return np.where(on, j - last_off, 0).astype(np.float32)


# ============================================================ 10. retrace
def retrace(tab, L=10, z_min=4.0):
    """How much of the last burst's move the mid has given back. The last burst is the latest second b <= now with |zl_L| >= z_min; its move is M = d x ln(P_b / P_(b-L))
    (d the sign of zl at b, P the 1 s Binance mid); given back is G = d x ln(P_b / P_now). retrace = G / M: 0 = the mid sits where the burst left it, 0.5 = half the move
    is gone, 1 = fully back, above 1 = through the start of the burst, below 0 = still extending. Unit: a share of the burst's move. NaN before the first burst.
    The reference moves to each new burst second. WHAT IT DOES NOT SEE. The book (a retrace in Binance, not in the token), a burst before second 5."""
    zl = tab.zl[:, :, LIDX[L]]
    on = _burst_on(tab, L, z_min)
    j = np.arange(tab.NK)[None, :]
    last = np.maximum.accumulate(np.where(on, j, -1), axis=1)
    pc = _pcols(tab)

    def one(a, b):
        lj = last[a:b]
        has = lj >= 0
        lj0 = np.where(has, lj, 0)
        P = tab.path[a:b].astype(np.float64)
        Pb = np.take_along_axis(P, PATH0 + K0 + lj0, axis=1)
        P0 = np.take_along_axis(P, PATH0 + K0 + lj0 - L, axis=1)
        d = np.sign(np.take_along_axis(zl[a:b], lj0, axis=1).astype(np.float64))
        with np.errstate(invalid="ignore", divide="ignore"):
            M = d * np.log(Pb / P0)
            G = d * np.log(Pb / P[:, pc])
            return np.where(has & (M > 0), G / np.where(M > 0, M, 1.0), np.nan).astype(np.float32)

    return np.concatenate([one(a, min(a + 512, tab.W)) for a in range(0, tab.W, 512)]) if tab.W else np.zeros((0, tab.NK), np.float32)


# ============================================================ the lot
def default_side(tab):
    """The side a burst rule would take: +1 where the 10 s burst is up, -1 where it is down (zl10 >= 0 counts as up), 0 where zl10 is NaN."""
    zl = tab.zl[:, :, 0]
    return np.where(np.isfinite(zl), np.where(zl >= 0, 1, -1), 0).astype(np.int8)


def all_signals(tab, side_mat=None, names=None):
    """Every signal as a dict name -> array: (W, NK) float32 each, `hour` and `dow` (W,) int8. `side_mat` (W, NK) in {-1, 0, +1} is the side the `near_*` signals
    are read for (default: the side of the 10 s burst, `default_side`). `names` computes only those (a 22-day pool is about 30 MB a signal). The Up-frame
    `tape10_vol` and `imbalance` stay in the Up frame here; `describe` flips them by each entry's own side."""
    side = default_side(tab) if side_mat is None else np.asarray(side_mat)
    cache = {}

    def tp():
        if "tp" not in cache:
            cache["tp"] = tape(tab, 10)
        return cache["tp"]

    reg = {
        "level": lambda: level(tab), "level_abs": lambda: level_abs(tab), "vol": lambda: tab.sig.astype(np.float32),
        "zl10": lambda: tab.zl[:, :, 0].astype(np.float32), "zl30": lambda: tab.zl[:, :, 1].astype(np.float32), "zl60": lambda: tab.zl[:, :, 2].astype(np.float32),
        "rsi14": lambda: rsi(tab, 14, 1), "rsi14_5s": lambda: rsi(tab, 14, 5),
        "spread_c": lambda: spread(tab), "rel_spread": lambda: rel_spread(tab), "near_rel_spread": lambda: near_rel_spread(tab, side),
        "imbalance": lambda: imbalance(tab), "near_imbalance": lambda: near_imbalance(tab, side),
        "intensity10": lambda: intensity(tab, 10), "intensity10_z": lambda: intensity_z(tab, 10), "intensity10_rel": lambda: intensity_rel(tab, 10),
        "vol_regime": lambda: vol_regime(tab),
        "tape10_n": lambda: tp()["n"], "tape10_vol": lambda: tp()["vol"], "tape_last_px": lambda: tp()["last_px"], "tape_last_age_s": lambda: tp()["last_age_s"],
        "hour": lambda: hour(tab), "dow": lambda: dow(tab),
        "since_burst": lambda: since_burst(tab, 10, 4.0), "burst_run": lambda: burst_run(tab, 10, 4.0), "retrace": lambda: retrace(tab, 10, 4.0),
    }
    keep = list(reg) if names is None else list(names)
    return {k: reg[k]() for k in keep}


def describe(tab, sig_dict, entries):
    """One row an entry: the entry's own columns (w, k, side, asset, day, T, shares, vwap, net, won) and each signal's value at the entry's (w, k) ((W,) signals at w).
    The `near_*` columns are rebuilt from the Up-frame signals with the ENTRY's side, whatever side_mat `all_signals` was given: near_imbalance = imbalance x side,
    near_tape10_vol = tape10_vol x side, near_rel_spread from the book. -> pandas DataFrame, so winners and losers split by signal with a groupby."""
    import pandas as pd
    w, k, s = np.asarray(entries["w"]).astype(int), np.asarray(entries["k"]).astype(int), np.asarray(entries["side"]).astype(int)
    cols = {c: np.asarray(entries[c]) for c in ("w", "k", "side", "asset", "day", "T", "shares", "vwap", "net", "won") if c in entries}
    for name, a in sig_dict.items():
        if name.startswith("near_"):
            continue
        cols[name] = a[w] if a.ndim == 1 else a[w, k]
    if "imbalance" in sig_dict:
        cols["near_imbalance"] = cols["imbalance"] * np.sign(s)
    if "tape10_vol" in sig_dict:
        cols["near_tape10_vol"] = cols["tape10_vol"] * np.sign(s)
    if len(w):
        side_e = np.zeros((tab.W, tab.NK), np.int8)
        side_e[w, k] = s
        cols["near_rel_spread"] = near_rel_spread(tab, side_e)[w, k]
    else:
        cols["near_rel_spread"] = np.zeros(0, np.float32)
    return pd.DataFrame(cols)


# ============================================================ the look-ahead detector
_FLOAT_KEYS = ("S", "z", "sig", "pu", "qb", "qa", "qbs", "qas", "known")


def _noise(a, perm_rows):
    """Other rows' values, stretched and shifted so even constant data changes."""
    return a[perm_rows] * 1.37 + 0.011 if a.dtype.kind == "f" else a[perm_rows] + 7


def future_scrambled(tab, c, seed=0):
    """A shallow copy of `tab` where everything stamped after decision column c is replaced: the columns > c of every table array come from other windows (stretched),
    the path after index 65 + c likewise, the Binance events after second K0 + c are dropped, the prints after it get a flipped price, side and size. Columns <= c,
    the path up to 65 + c and the ragged rows stamped <= 1000 (K0 + c) ms are untouched. The original is not changed."""
    rng = np.random.default_rng(seed)
    perm = rng.permutation(tab.W)
    t2 = copy.copy(tab)
    cut = c + 1
    for key in _FLOAT_KEYS + ("age",):
        a = getattr(tab, key).copy()
        a[:, cut:] = _noise(a[:, cut:], perm)
        setattr(t2, key, a)
    zl = tab.zl.copy()
    zl[:, cut:] = _noise(zl[:, cut:], perm)
    t2.zl = zl
    lad = tab.lad.copy()
    lad[:, :, cut:] = lad[perm][:, :, cut:] * 1.37 + 0.011
    t2.lad = lad
    path = tab.path.copy()
    pcut = PATH0 + K0 + c + 1
    path[:, pcut:] = _noise(path[:, pcut:], perm)
    t2.path = path
    t_ms = 1000 * (K0 + c)
    keep = tab.e_t <= t_ms
    for col in ("w", "t", "S", "known", "sig"):
        setattr(t2, f"e_{col}", getattr(tab, f"e_{col}")[keep])
    t2._offsets("e")
    late = tab.p_t > t_ms
    t2.p_px = np.where(late, 1.0 - tab.p_px, tab.p_px).astype(tab.p_px.dtype)
    t2.p_sz = np.where(late, tab.p_sz * 3 + 1, tab.p_sz).astype(tab.p_sz.dtype)
    t2.p_side = np.where(late, -tab.p_side, tab.p_side).astype(tab.p_side.dtype)
    return t2


def later_windows_scrambled(tab, seed=0):
    """-> (copy, earlier): windows that started after the median start get every table array replaced by another late window's (stretched). `earlier` (W,) is
    true for the untouched windows. A signal of an earlier window must not move."""
    rng = np.random.default_rng(seed)
    cut = np.median(tab.w_start)
    late = np.flatnonzero(tab.w_start > cut)
    perm = late[rng.permutation(len(late))]
    t2 = copy.copy(tab)
    for key in _FLOAT_KEYS + ("age", "zl", "lad", "path"):
        a = getattr(tab, key).copy()
        a[late] = a[perm] * 1.37 + 0.011 if a.dtype.kind == "f" else a[perm] + 7
        setattr(t2, key, a)
    earlier = np.ones(tab.W, bool)
    earlier[late] = False
    return t2, earlier


def _differs(a, b, rows=None, upto=None):
    """True when two arrays differ (NaN equals NaN) over `rows` and columns < upto."""
    a, b = np.asarray(a), np.asarray(b)
    if rows is not None:
        a, b = a[rows], b[rows]
    if upto is not None and a.ndim == 2:
        a, b = a[:, :upto], b[:, :upto]
    if a.dtype.kind in "fc":
        return not np.array_equal(a, b, equal_nan=True)
    return not np.array_equal(a, b)


def assert_causal(fn, tab, cuts=(60, 400, 800), windows=True):
    """Raise AssertionError if `fn(tab)` (an array or a dict of arrays) at a decision column <= c moves when everything after c is scrambled (`future_scrambled`, for
    each c in `cuts`), or, with `windows`, when the windows that start later are scrambled (`later_windows_scrambled`). (W,) signals are compared whole against
    the window scramble only. What it proves: this `fn`, on this table, does not read the scrambled data; it cannot see a leak through a column the scramble
    leaves alone (the outcome `tab.up`, which no signal here reads, is not scrambled)."""
    base = fn(tab)
    named = base if isinstance(base, dict) else {"_": base}
    bad = []
    for c in cuts:
        got = fn(future_scrambled(tab, c))
        got = got if isinstance(got, dict) else {"_": got}
        for k in named:
            if np.asarray(named[k]).ndim == 2 and _differs(named[k], got[k], upto=c + 1):
                bad.append(f"{k}: moves with the future after column {c}")
    if windows:
        t2, earlier = later_windows_scrambled(tab)
        got = fn(t2)
        got = got if isinstance(got, dict) else {"_": got}
        for k in named:
            if _differs(named[k], got[k], rows=earlier):
                bad.append(f"{k}: an earlier window moves when later windows change")
    if bad:
        raise AssertionError("; ".join(bad))
    return True


# ============================================================ the selftest
def _blank(W=1, NK=891):
    """A synthetic table: every array NaN or empty, to be filled by a test."""
    t = object.__new__(B.Tab)
    t.W, t.NK = W, NK
    t.T = (B.WIN_S - (K0 + np.arange(NK))).astype(float)
    nan = lambda *s: np.full(s, np.nan, np.float32)               # noqa: E731
    t.S, t.z, t.sig, t.pu = nan(W, NK), nan(W, NK), nan(W, NK), nan(W, NK)
    t.qb, t.qa, t.qbs, t.qas, t.known = nan(W, NK), nan(W, NK), nan(W, NK), nan(W, NK), nan(W, NK)
    t.zl, t.lad, t.age = nan(W, NK, 3), nan(W, 4, NK, 4), np.zeros((W, NK), np.int32)
    t.path = nan(W, 961)
    t.w_asset, t.w_start = np.zeros(W, np.int8), np.arange(W, dtype=np.int64) * 900_000
    z0 = np.zeros(0)
    t.e_w, t.e_t, t.e_S, t.e_known, t.e_sig = z0.astype(np.int32), z0.astype(np.int32), z0.astype(np.float32), z0.astype(np.float32), z0.astype(np.float32)
    t.p_w, t.p_t, t.p_px, t.p_sz, t.p_side = z0.astype(np.int32), z0.astype(np.int32), z0.astype(np.float32), z0.astype(np.float32), z0.astype(np.int8)
    t._offsets("e")
    t._offsets("p")
    return t


def _ref_rsi(prices, n):
    """A scalar Wilder RSI, written separately from `rsi_path`: the RSI at each point from index n on."""
    g = [max(prices[i + 1] - prices[i], 0.0) for i in range(len(prices) - 1)]
    l_ = [max(prices[i] - prices[i + 1], 0.0) for i in range(len(prices) - 1)]
    ag, al = sum(g[:n]) / n, sum(l_[:n]) / n
    out = [100.0 * ag / (ag + al) if ag + al > 0 else float("nan")]
    for i in range(n, len(g)):
        ag, al = (ag * (n - 1) + g[i]) / n, (al * (n - 1) + l_[i]) / n
        out.append(100.0 * ag / (ag + al) if ag + al > 0 else float("nan"))
    return np.array(out)


def checks_synthetic() -> list[tuple[str, bool]]:
    """Every check that needs no data: as (label, passed). Each one states what it would print if the property were false."""
    out = []
    # ---- rsi
    up = np.tile(np.linspace(100, 101, 961), (2, 1))
    r_up, r_dn = rsi_path(up, 14, 1), rsi_path(up[:, ::-1].copy(), 14, 1)
    out.append(("rsi: a monotone rise is 100 from the 15th point (NaN before), a monotone fall is 0", bool(np.all(r_up[:, 14:] == 100.0) and np.all(np.isnan(r_up[:, :14])) and np.all(r_dn[:, 14:] == 0.0))))
    out.append(("rsi: a flat path is NaN, not 50", bool(np.all(np.isnan(rsi_path(np.full((1, 100), 5.0), 14, 1))))))
    r5 = rsi_path(up, 14, 5)
    out.append(("rsi: 5 s steps, a monotone rise is 100 from index 70, NaN before", bool(np.all(r5[:, 70:] == 100.0) and np.all(np.isnan(r5[:, :70])))))
    rng = np.random.default_rng(3)
    walk = 100 * np.exp(np.cumsum(rng.normal(0, 1e-3, (3, 400)), axis=1))
    ok = True
    for step in (1, 5):
        got = rsi_path(walk, 14, step)
        for w in range(3):
            for r in range(step):
                ref = _ref_rsi(walk[w, r::step], 14)
                ok &= bool(np.allclose(got[w, r + (14 + np.arange(len(ref))) * step], ref, atol=1e-3))
    out.append(("rsi: matches a separate scalar Wilder loop on random walks (1 s and 5 s lattices)", ok))
    # ---- imbalance and spread
    t = _blank(1)
    t.qbs[:], t.qas[:], t.qb[:], t.qa[:] = 30.0, 10.0, 0.47, 0.52
    side = np.ones((1, t.NK), np.int8)
    side[0, 1] = -1
    side[0, 2] = 0
    t.qas[0, 3] = 0.0
    t.qbs[0, 3] = 0.0
    t.qa[0, 4] = np.nan
    im, nim = imbalance(t), near_imbalance(t, side)
    out.append(("imbalance: bids 30 / asks 10 is +0.5 in the Up frame", abs(im[0, 0] - 0.5) < 1e-6))
    out.append(("imbalance: a Down buyer sees -0.5 (Up bids heavy = Down asks heavy), side 0 is NaN, an empty book is NaN", abs(nim[0, 0] - 0.5) < 1e-6 and abs(nim[0, 1] + 0.5) < 1e-6 and np.isnan(nim[0, 2]) and np.isnan(im[0, 3])))
    out.append(("spread: 0.52 - 0.47 is 5 cents, 9.62% of the Up ask; the Down buyer's ask is 1 - 0.47 = 0.53 so 9.43%; a missing ask is NaN",
                bool(abs(spread(t)[0, 0] - 5.0) < 1e-4 and abs(rel_spread(t)[0, 0] - 0.05 / 0.52) < 1e-6 and abs(near_rel_spread(t, side)[0, 1] - 0.05 / 0.53) < 1e-6 and np.isnan(spread(t)[0, 4]))))
    # ---- intensity and tape
    t = _blank(2)
    ev = [(0, 5000), (0, 6000), (0, 14000), (0, 15000), (0, 15001), (0, 24999), (0, 25000), (0, 25001)]
    t.e_w, t.e_t = np.array([w for w, _ in ev], np.int32), np.array([x for _, x in ev], np.int32)
    t._offsets("e")
    cols = {s: j for j, s in enumerate(_cols(t))}
    it = intensity(t, 10)
    # 14: (4,14] holds 5000, 6000, 14000.  15: (5,15] holds 6000, 14000, 15000.  16: (6,16] holds 14000, 15000, 15001.  24: (14,24] holds 15000, 15001.
    # 25: (15,25] holds 15001, 24999, 25000.  26: (16,26] holds 24999, 25000, 25001.  13: the lookback starts before the first stored event second -> NaN
    want = {13: np.nan, 14: 3, 15: 3, 16: 3, 24: 2, 25: 3, 26: 3}
    got = {s: it[0, cols[s]] for s in want}
    ok = all((np.isnan(v) and np.isnan(got[s])) or got[s] == v for s, v in want.items())
    out.append((f"intensity: known counts of 10 s windows on a planted event list {got}", bool(ok and np.all(it[1, cols[14]:] == 0))))
    c2 = intensity(t, 10)[0]
    out.append(("intensity: the second window's events do not leak into the first (window 1 has none, reads 0 not 3)", bool(intensity(t, 10)[1, cols[15]] == 0 and c2[cols[15]] == 3)))
    t5 = _blank(1)
    t5.e_w = np.zeros(300, np.int32)
    t5.e_t = np.array(sorted(5000 + (np.arange(300) * 2900) % 880000), np.int32)
    t5.e_t = np.unique(t5.e_t)
    t5.e_w = np.zeros(len(t5.e_t), np.int32)
    t5._offsets("e")
    x = intensity(t5, 10)[0]
    z_ = intensity_z(t5, 10, min_prior=30)[0]
    j = 400
    past = x[:j][np.isfinite(x[:j])]
    ref = (x[j] - past.mean()) / past.std(ddof=1)
    out.append(("intensity_z: (x - mean of earlier counts) / their sample sd, checked at one column by hand", bool(abs(z_[j] - ref) < 1e-4 and abs(intensity_rel(t5, 10, 30)[0, j] - x[j] / past.mean()) < 1e-4)))
    out.append(("intensity_z: NaN before min_prior earlier counts exist", bool(np.all(np.isnan(z_[:39])))))
    tp = _blank(1)
    pr = [(6000, 0.50, 10, 1), (7000, 0.52, 4, -1), (12000, 0.55, 6, 1), (12000, 0.54, 1, -1)]
    tp.p_w = np.zeros(4, np.int32)
    tp.p_t = np.array([p[0] for p in pr], np.int32)
    tp.p_px = np.array([p[1] for p in pr], np.float32)
    tp.p_sz = np.array([p[2] for p in pr], np.float32)
    tp.p_side = np.array([p[3] for p in pr], np.int8)
    tp._offsets("p")
    tt = tape(tp, 10)
    c = {s: j for j, s in enumerate(_cols(tp))}
    ok = (tt["n"][0, c[12]] == 4 and tt["vol"][0, c[12]] == 11.0 and abs(tt["last_px"][0, c[12]] - 0.54) < 1e-6 and tt["n"][0, c[18]] == 2 and tt["vol"][0, c[18]] == 5.0
          and abs(tt["last_age_s"][0, c[18]] - 6.0) < 1e-6 and np.isnan(tt["n"][0, c[5]]) and np.isnan(tt["last_px"][0, c[5]]) and abs(tt["last_px"][0, c[6]] - 0.50) < 1e-6
          and tt["last_age_s"][0, c[6]] == 0.0 and tt["n"][0, c[40]] == 0 and tt["vol"][0, c[40]] == 0 and abs(tt["last_px"][0, c[40]] - 0.54) < 1e-6)
    out.append(("tape: signed volume 10 - 4 + 6 - 1 = 11 over 4 prints at s = 12, 5 over 2 at s = 18, last price kept after the window empties, NaN before the first print", bool(ok)))
    # ---- bursts
    tb_ = _blank(1)
    tb_.zl[0, :, 0] = 0.0
    tb_.zl[0, 3, 0], tb_.zl[0, 7, 0], tb_.zl[0, 8, 0], tb_.zl[0, 12, 0] = 4.5, -4.0, -6.0, np.nan
    sb, br = since_burst(tb_, 10, 4.0)[0], burst_run(tb_, 10, 4.0)[0]
    ok = (np.all(np.isnan(sb[:3])) and list(sb[3:11]) == [0, 1, 2, 3, 0, 0, 1, 2] and list(br[:12]) == [0, 0, 0, 1, 0, 0, 0, 1, 2, 0, 0, 0])
    out.append(("since_burst / burst_run: NaN before the first burst, 0 on it, counting up after; the run is 1 on a burst's first second, 2 on its second; a NaN z is no burst", bool(ok)))
    # a burst up that lifts the mid by 1% over 10 s, then half gives back; a burst down mirrored
    for d in (1, -1):
        tr = _blank(1)
        base = np.full(961, 100.0)
        pi = PATH0 + K0                                    # path index of column 0
        base[pi + 20: pi + 31] = 100.0 * np.exp(d * np.linspace(0, 0.01, 11))     # burst 10 s, columns 20 to 30
        base[pi + 31:] = base[pi + 30]
        base[pi + 36:] = 100.0 * np.exp(d * 0.005)                             # half given back from column 36
        base[pi + 45:] = 100.0 * np.exp(d * 0.012)                             # then through the burst's end the other way (extends)
        tr.path[0] = base
        tr.zl[0, :, 0] = 0.0
        tr.zl[0, 30, 0] = 5.0 * d
        r = retrace(tr, 10, 4.0)[0]
        out.append((f"retrace ({'up' if d > 0 else 'down'} burst): NaN before, 0 at the burst, 0 held, 0.5 after half is given back, -0.2 when it extends to 1.2%",
                    bool(np.isnan(r[29]) and abs(r[30]) < 1e-6 and abs(r[33]) < 1e-6 and abs(r[36] - 0.5) < 1e-4 and abs(r[45] + 0.2) < 1e-4)))
    # ---- vol regime
    tv = _blank(8)
    tv.sig[:] = np.array([1, 2, 3, 0.5, 3, 9, 4, 1], np.float32)[:, None]
    tv.w_start = np.array([0, 1, 2, 3, 4, 5, 6, 7], np.int64) * 900_000
    tv.w_asset = np.array([0, 0, 0, 0, 0, 1, 0, 0], np.int8)
    vr = vol_regime(tv, min_prior=2)[:, 0]
    out.append((f"vol_regime: rank among earlier windows of the same coin, NaN with fewer than 2 earlier, ties count half (got {np.round(vr, 3).tolist()})",
                bool(np.all(np.isnan(vr[[0, 1, 5]])) and list(vr[[2, 3, 4, 6, 7]]) == [1.0, 0.0, 0.875, 1.0, 0.25])))
    # ---- hour, dow
    import datetime as dt
    th = _blank(5)
    stamps = [dt.datetime(2026, 10, 7, 13, 15, tzinfo=dt.timezone.utc), dt.datetime(2026, 10, 11, 23, 45, tzinfo=dt.timezone.utc), dt.datetime(2026, 10, 12, 0, 0, tzinfo=dt.timezone.utc),
              dt.datetime(1970, 1, 1, 0, 0, tzinfo=dt.timezone.utc), dt.datetime(2026, 2, 28, 5, 0, tzinfo=dt.timezone.utc)]
    th.w_start = np.array([int(s.timestamp() * 1000) for s in stamps], np.int64)
    out.append(("hour / dow: UTC hour and Monday-0 weekday agree with datetime on five stamps (Wed 13h, Sun 23h, Mon 0h, Thu 1970, Sat)",
                bool(list(hour(th)) == [s.hour for s in stamps] and list(dow(th)) == [s.weekday() for s in stamps])))
    return out


def _real_checks(tab) -> list[tuple[str, bool]]:
    """The checks on a real pooled table: the clock alignment, the sign of z, the causality of every signal, and four planted look-aheads that the detector must catch."""
    out = []
    pc = _pcols(tab)
    out.append(("clock: path index 65 + j equals S at column j on every window (so index 60 + second is the second's mid)", bool(np.array_equal(tab.path[:, pc], tab.S))))
    with np.errstate(invalid="ignore"):
        agree = np.mean(np.sign(np.log(tab.S[:, 100].astype(np.float64) / tab.w_a0)) == np.sign(tab.z[:, 100]))
    out.append((f"level: sign of z is the sign of ln(S / A0) on {agree * 100:.1f}% of windows at column 100", agree > 0.999))
    # the ragged rows are appended in hour order, so a window's rows are not always one slice [off[w], off[w + 1]): the signals count by window id, never by offset.
    # Brute force by boolean mask on 40 windows (every window whose offset slice holds a foreign window, then random ones) at four columns
    bad_slice = [w for w in range(tab.W) if np.any(tab.e_w[tab.e_off[w]:tab.e_off[w + 1]] != w) or np.any(tab.p_w[tab.p_off[w]:tab.p_off[w + 1]] != w)]
    pick = list(bad_slice[:20]) + list(np.random.default_rng(1).choice(tab.W, 20, replace=False))
    it, tp = intensity(tab, 10), tape(tab, 10)
    ok = True
    for w in pick:
        for j in (30, 300, 600, 880):
            t_ms = 1000 * (K0 + j)
            em = (tab.e_w == w) & (tab.e_t <= t_ms) & (tab.e_t > t_ms - 10_000)
            pm = (tab.p_w == w) & (tab.p_t <= t_ms) & (tab.p_t > t_ms - 10_000)
            vol = float(np.sum(tab.p_side[pm].astype(np.float64) * tab.p_sz[pm]))
            ok &= bool(it[w, j] == em.sum() and tp["n"][w, j] == pm.sum() and abs(tp["vol"][w, j] - vol) <= 1e-6 * abs(vol) + 1e-3)
            lm = (tab.p_w == w) & (tab.p_t <= t_ms)
            if lm.any():
                tied = tab.p_px[lm & (tab.p_t == tab.p_t[lm].max())]              # prints sharing the latest stamp: any of their prices is the latest
                ok &= bool(np.isclose(tp["last_px"][w, j], tied, atol=1e-6).any())
            else:
                ok &= bool(np.isnan(tp["last_px"][w, j]))
    out.append((f"ragged: intensity and tape equal a boolean-mask count on {len(pick)} windows ({len(bad_slice)} of {tab.W} have a mixed offset slice, so p_off / e_off are NOT used)", bool(ok)))
    try:
        assert_causal(lambda t: all_signals(t), tab)
        caught = True
    except AssertionError as e:
        caught = str(e)
    out.append(("causal: every signal of all_signals is unchanged by a scrambled future and by scrambled later windows" + ("" if caught is True else f" -> {caught}"), caught is True))

    def planted(label, fn, windows=False):
        try:
            assert_causal(fn, tab, windows=windows)
            out.append((f"detector: planted look-ahead '{label}' is caught", False))
        except AssertionError:
            out.append((f"detector: planted look-ahead '{label}' is caught", True))

    planted("z of the next second", lambda t: np.roll(t.z, -1, axis=1))
    planted("RSI read one second ahead on the path", lambda t: np.pad(rsi_path(t.path, 14, 1)[:, PATH0 + K0 + 1: PATH0 + K0 + 1 + t.NK - 1], ((0, 0), (0, 1)), constant_values=np.nan))
    planted("events counted up to the next second", lambda t: (lambda cum, s: cum[:, s + 1] - cum[:, s + 1 - 10])(_visible_cum(t, "e"), _cols(t)))
    planted("vol rank against ALL windows, not the earlier ones", lambda t: np.stack([np.mean(t.sig[t.w_asset == t.w_asset[w]] < t.sig[w], axis=0) for w in range(t.W)]), windows=True)
    return out


def selftest(days=("2026-10-06", "2026-10-07")) -> bool:
    ok = True
    print("synthetic checks")
    for label, cond in checks_synthetic():
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        ok &= bool(cond)
    print(f"real days {', '.join(days)}, fill 250 ms")
    tab = B.Tab(list(days), fill_ms=250)
    for label, cond in _real_checks(tab):
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        ok &= bool(cond)
    sigs = all_signals(tab)
    print(f"two-day summary: {tab.W} windows x {tab.NK} decision seconds; nan share, min, median, max")
    for name, a in sigs.items():
        v = np.asarray(a, np.float64)
        fin = v[np.isfinite(v)]
        if len(fin):
            print(f"  {name:16s} nan {np.isnan(v).mean() * 100:6.2f}%  min {fin.min():12.5g}  median {np.median(fin):12.5g}  max {fin.max():12.5g}")
        else:
            print(f"  {name:16s} nan 100.00%")
            ok = False
    # describe on a plain burst rule (an anatomy sanity run, not a result)
    zl = tab.zl[:, :, 0]
    side = default_side(tab)
    qa_dn = (1.0 - tab.qb).astype(np.float64)
    lim = np.where(side > 0, tab.qa, qa_dn)
    trig = (np.abs(zl) >= 4.0) & (tab.T[None, :] >= 120)
    e = B.entries(tab, side, trig, lim)
    df = describe(tab, sigs, e)
    good = len(df) == len(e["net"]) and (len(df) == 0 or (np.array_equal(df["level"].to_numpy(), tab.z[e["w"], e["k"]]) and np.array_equal(df["hour"].to_numpy(), hour(tab)[e["w"]])
                                                          and np.allclose(df["near_imbalance"].to_numpy(), imbalance(tab)[e["w"], e["k"]] * np.sign(e["side"]), equal_nan=True)))
    print(f"  {'ok  ' if good else 'FAIL'} describe: {len(df)} entries of the plain 10 s burst rule (|zl10| >= 4, 120 s left, limit = the ask seen), {df.shape[1]} columns, values equal the matrices at (w, k)")
    ok &= bool(good)
    print("signals ok" if ok else "SIGNALS FAIL")
    return bool(ok)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(0 if selftest() else 1)
    print(__doc__)
