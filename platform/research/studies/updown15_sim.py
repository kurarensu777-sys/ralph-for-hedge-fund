"""Entry simulation for the 15-minute Up/Down study (B-0642). numpy only, no I/O, paper only.

One window is a dict of arrays; `simulate_window` decides second by second, fills against the book
as it stood at t + latency (the last row with ts <= t + latency, never the next) and holds to the
recorded outcome. The decision loop never sees `outcome` or the end-of-window price: they are
arguments of `settle`, which runs after the position is fixed.
"""
from __future__ import annotations

import numpy as np

CLIP_USD = 20.0
MIN_SHARES = 5.0          # orderMinSize on the market row [API] 2026-10-07
FEE_RATE = 0.07           # fallback only: every market carries its own feeSchedule, passed per window


def fee_usd(shares: float, px: float, rate: float, exponent: float = 1.0) -> float:
    """fee = C x rate x (p (1 - p)) ^ exponent, venue card fee.formula (exponent 1 on every 15m market read)
    rounded to 5 decimals (card fee.precision); a fill is taken one level at a time by `walk_asks`."""
    return round(shares * rate * (px * (1.0 - px)) ** exponent, 5)


def walk_asks(ask_px: np.ndarray, ask_sz: np.ndarray, usd: float, rate: float, exponent: float = 1.0):
    """Take `usd` of shares from the best ask up, level by level. ask_px ascending, NaN padded.
    -> dict(shares, cost, fee, vwap, filled_usd, levels, partial); shares = 0 when the book is empty
    or the fill is under the venue's minimum order."""
    shares = cost = fee = 0.0
    lv = 0
    left = usd
    for px, sz in zip(ask_px, ask_sz):
        if not (px == px) or sz <= 0 or left <= 1e-9:
            break
        take = min(sz, left / px)
        shares += take
        cost += take * px
        fee += fee_usd(take, px, rate, exponent)
        left -= take * px
        lv += 1
    if shares < MIN_SHARES:
        return dict(shares=0.0, cost=0.0, fee=0.0, vwap=np.nan, filled_usd=0.0, levels=0, partial=True)
    return dict(shares=shares, cost=cost, fee=fee, vwap=cost / shares, filled_usd=cost, levels=lv,
                partial=bool(left > 0.01))


def edge_after_fee(p, ask, rate, exponent=1.0):
    """Expected profit per share at the best ask: p - ask - fee per share (a hold to expiry pays 1 or 0)."""
    return p - ask - rate * (ask * (1.0 - ask)) ** exponent


def decide(p_up, ask_up, ask_dn, rate, theta, exponent=1.0):
    """Per decision second: the side with the larger edge after fee if it exceeds theta.
    -> (side, edge): side +1 Up, -1 Down, 0 none; NaN asks never trigger."""
    eu = np.where(np.isfinite(ask_up), edge_after_fee(p_up, ask_up, rate, exponent), -np.inf)
    ed = np.where(np.isfinite(ask_dn), edge_after_fee(1.0 - p_up, ask_dn, rate, exponent), -np.inf)
    side = np.where((eu >= ed) & (eu > theta), 1, np.where((ed > eu) & (ed > theta), -1, 0))
    return side, np.maximum(eu, ed)


def settle(side: int, fill: dict, up_won: bool):
    """PnL of a held position: shares pay 1 if the side won. -> (pnl_before_fee, pnl_after_fee, won)."""
    won = (side == 1) == bool(up_won)
    gross = fill["shares"] * (1.0 if won else 0.0) - fill["cost"]
    return gross, gross - fill["fee"], won


def exclusion_reason(n_trades_gap_s: float, book_ok: bool, max_gap_s: float = 30.0) -> str | None:
    """A rule written before outcomes: a window is out when the book is missing or Binance has a gap over
    `max_gap_s` seconds inside it. Never looks at the outcome."""
    if not book_ok:
        return "no_book"
    if n_trades_gap_s > max_gap_s:
        return "binance_gap"
    return None
