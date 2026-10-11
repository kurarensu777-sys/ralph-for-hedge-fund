"""Features for the 15-minute Up/Down study (B-0642): a 1 Hz as-of grid built from Binance trades, then
per-decision-second features for every window. numpy only, no I/O.

THE ONE RULE: a value stamped t uses rows with time <= t. The grid is built by `asof_idx(ts, g)`, the last
trade at or before each whole second g; every cumulative sum and lookback is read from that grid, so a
feature at second k cannot see second k + 1. `shift_s` moves the whole grid for the planted tests
(+1 means every feature is one second STALE; -1 means one second from the FUTURE and must improve results).
"""
from __future__ import annotations

import numpy as np

from updown15_model import asof_idx

LOOKBACKS = (1, 5, 15, 60, 300)     # seconds, log-return features
IMB_WINDOWS = (5, 30, 120)          # seconds, signed-volume imbalance
WIN_S = 900
TWAP_S = 60


def second_grid(ts, px, qty, buyer_maker, g0_ms: int, n: int):
    """1 Hz as-of grid over n whole seconds from g0_ms: last price at or before each second, and the
    cumulative signed (taker buy minus taker sell) and total quantity as of each second."""
    g = g0_ms + 1000 * np.arange(n, dtype=np.int64)
    i = asof_idx(ts, g)
    price = np.where(i >= 0, px[np.maximum(i, 0)], np.nan)
    sq = np.where(buyer_maker, -qty, qty).astype(float)    # buyer is the maker => the taker sold
    cs = np.concatenate([[0.0], np.cumsum(sq)])
    cv = np.concatenate([[0.0], np.cumsum(qty.astype(float))])
    last_ts = np.where(i >= 0, ts[np.maximum(i, 0)], -1)
    return dict(g=g, price=price, cs=cs[i + 1], cv=cv[i + 1], age_ms=g - last_ts)


def log_ret_1s(price):
    r = np.zeros(len(price))
    r[1:] = np.log(price[1:] / price[:-1])
    r[~np.isfinite(r)] = 0.0
    return r


def lookback_ret(price, k, w):
    """ln(P[k] / P[k - w]) for index arrays k; 0 where the lookback runs before the grid."""
    kk = np.asarray(k)
    j = kk - w
    out = np.zeros(kk.shape)
    ok = j >= 0
    out[ok] = np.log(price[kk[ok]] / price[j[ok]])
    out[~np.isfinite(out)] = 0.0
    return out


def imbalance(cs, cv, k, w):
    """Signed-volume imbalance over (k - w, k]: (buy - sell) / (buy + sell); 0 with no volume."""
    kk = np.asarray(k)
    j = np.maximum(kk - w, 0)
    num = cs[kk] - cs[j]
    den = cv[kk] - cv[j]
    return np.where(den > 0, num / np.where(den > 0, den, 1.0), 0.0)


def window_index(starts_ms, g0_ms: int):
    """Grid index of each window's first second; every start must be a whole second inside the grid."""
    d = (np.asarray(starts_ms, dtype=np.int64) - g0_ms)
    assert np.all(d % 1000 == 0), "a window start is not a whole second"
    return (d // 1000).astype(int)


def twap_start(price, k0):
    """The reference the market defines at its start: mean of the 60 one-second prices ending at the start
    (seconds start - 59 .. start). Known AT the start; never touches a later row."""
    out = np.empty(len(k0))
    for n, k in enumerate(k0):
        out[n] = np.nanmean(price[k - TWAP_S + 1: k + 1])
    return out


def twap_end(price, k0):
    """The settlement proxy: mean of the 60 one-second prices ending at the window end. USED ONLY TO SCORE."""
    return np.array([np.nanmean(price[k + WIN_S - TWAP_S + 1: k + WIN_S + 1]) for k in k0])


def decision_frame(grid, sigma_1s, k0, a_start, step_s: int = 1, t_min_s: int = 0, shift_s: int = 0):
    """Features at every `step_s` second of every window. Returns a dict of flat arrays, row order (window, second).

    sigma_1s : per-second volatility AS OF each grid second (causal); the caller builds it from past rows.
    shift_s  : planted-test shift; positive reads the grid that many seconds EARLIER (stale), negative later (leak).
    """
    price, cs, cv = grid["price"], grid["cs"], grid["cv"]
    n_w = len(k0)
    sec = np.arange(0, WIN_S - t_min_s + 1, step_s)           # seconds since the window start (0 .. 900 - t_min)
    K = (k0[:, None] + sec[None, :])                           # decision grid index, (windows, seconds)
    Ks = np.clip(K - shift_s, 0, len(price) - 1)               # the index the features read
    s_now = price[Ks]
    t_left = (WIN_S - sec)[None, :].repeat(n_w, 0).astype(float)
    sig = sigma_1s[Ks]
    out = dict(win=np.repeat(np.arange(n_w), len(sec)), sec=np.tile(sec, n_w), t_left=t_left.ravel())
    out["s_now"] = s_now.ravel()
    out["a_start"] = np.repeat(a_start, len(sec))
    out["sigma"] = sig.ravel()
    flat = Ks.ravel()
    for w in LOOKBACKS:
        out[f"ret{w}"] = lookback_ret(price, flat, w)
    for w in IMB_WINDOWS:
        out[f"imb{w}"] = imbalance(cs, cv, flat, w)
    # known part of the settlement TWAP: seconds (end - 59 .. t); sum of prices of seconds inside the window
    cum = np.concatenate([[0.0], np.cumsum(np.nan_to_num(price))])
    t_abs = (k0[:, None] + sec[None, :])
    first = (k0 + WIN_S - TWAP_S + 1)[:, None]
    lo = np.clip(first, 0, len(price))
    hi = np.clip(np.minimum(t_abs - shift_s, k0[:, None] + WIN_S) + 1, 0, len(price))
    known = np.where(hi > lo, cum[hi] - cum[np.broadcast_to(lo, hi.shape)], 0.0)
    out["known_sum"] = known.ravel()
    out["age_ms"] = grid["age_ms"][Ks].ravel()
    return out
