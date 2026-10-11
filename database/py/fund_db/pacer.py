"""fund_db.pacer - ONE request budget per venue, shared by every process that calls a venue
(notebooks, dashboards, the market MCP, jobs), plus request coalescing (B-0322 section 3).

    fund_db.pacer.set_budget("exchange_a", capacity=1200, refill_per_s=20, source="the venue's published limit")
    waited = fund_db.pacer.take("exchange_a", cost=5)       # blocks until 5 tokens are free; seconds waited
    fund_db.pacer.backoff("broker_a", 600, "pacing violation")   # no token until then
    with fund_db.pacer.coalesce("exchange_a|funding|BTCUSDT|2026-09"):
        ...   # the first holder fetches; the others wait here, then re-read the cache first
    fund_db.pacer.status()

THE BUCKET (Postgres market.pacer, migration market/004): `capacity` tokens at most (the burst),
refilled at `refill_per_s` (the sustained rate); both come from the venue's own fact card, which
`source` names - this module holds no venue number. take() refills from the clock and debits under
a row lock (SELECT ... FOR UPDATE), so two processes can never spend the same token. A venue with
no budget row is unpaced: take() returns 0 at once, and status() does not list it - the caller's
own card-driven pacing is then the only pacing, which is platform-core's to close.

backoff() is the adaptive rule (a pacing violation, a refusal): blocked_until_ms
is set and take() waits it out (or raises PacerTimeout when that is past max_wait_s).

COALESCING is a Postgres session advisory lock on the request key (hashtextextended), held on its
own connection for the block: concurrent callers of the same key queue behind the first (polling
pg_try_advisory_lock, so the wait is bounded), which fetches and writes the cache; each later
caller re-reads the cache before fetching.
"""
from __future__ import annotations

import time
from contextlib import contextmanager

POLL_MAX_S = 1.0


class PacerTimeout(TimeoutError):
    pass


def _now() -> int:
    return int(time.time() * 1000)


def _conn():
    from .db import connect
    return connect(autocommit=True, connect_timeout=3, application_name="fund_db.pacer")


def set_budget(venue: str, capacity: float, refill_per_s: float, *, source: str) -> dict:
    """Create or change a venue's bucket. `source` names the fact card the numbers came from."""
    venue = str(venue).strip().lower()
    if not venue or not str(source or "").strip():
        raise ValueError("set_budget needs a venue and the source (fact card) of its numbers")
    if not (capacity > 0 and refill_per_s > 0):
        raise ValueError("capacity and refill_per_s must be > 0")
    now = _now()
    with _conn() as c:
        return dict(c.execute(
            "INSERT INTO market.pacer (venue, capacity, refill_per_s, tokens, refilled_ms, source, updated_ms) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (venue) DO UPDATE SET capacity = EXCLUDED.capacity, "
            "refill_per_s = EXCLUDED.refill_per_s, tokens = least(market.pacer.tokens, EXCLUDED.capacity), "
            "source = EXCLUDED.source, updated_ms = EXCLUDED.updated_ms RETURNING *",
            (venue, float(capacity), float(refill_per_s), float(capacity), now, str(source).strip(), now)).fetchone())


def budget(venue: str) -> dict | None:
    with _conn() as c:
        r = c.execute("SELECT * FROM market.pacer WHERE venue = %s", (str(venue).lower(),)).fetchone()
    return dict(r) if r else None


def _try_take(c, venue: str, cost: float) -> tuple[bool, float]:
    """One attempt in one transaction: (taken, seconds until it could be)."""
    with c.transaction():
        r = c.execute("SELECT * FROM market.pacer WHERE venue = %s FOR UPDATE", (venue,)).fetchone()
        if r is None:
            return True, 0.0
        now = _now()
        if r["blocked_until_ms"] and r["blocked_until_ms"] > now:
            return False, (r["blocked_until_ms"] - now) / 1000
        tokens = min(r["capacity"], r["tokens"] + max(0, now - r["refilled_ms"]) / 1000 * r["refill_per_s"])
        if tokens >= cost:
            c.execute("UPDATE market.pacer SET tokens = %s, refilled_ms = %s WHERE venue = %s",
                      (tokens - cost, now, venue))
            return True, 0.0
        c.execute("UPDATE market.pacer SET tokens = %s, refilled_ms = %s WHERE venue = %s",
                  (tokens, now, venue))
        return False, (cost - tokens) / r["refill_per_s"]


def take(venue: str, cost: float = 1.0, max_wait_s: float = 60.0) -> float:
    """Spend `cost` tokens of `venue`'s bucket, waiting for them. Returns the seconds spent WAITING
    (0.0 when the tokens were there); PacerTimeout when they cannot be had within max_wait_s. A
    cost above the bucket's capacity is refused (it could never be paid). Runs on the thread's
    shared connection (fund_db.db.shared), one short transaction per attempt."""
    from .db import shared
    venue = str(venue).strip().lower()
    c = shared()
    b = c.execute("SELECT capacity FROM market.pacer WHERE venue = %s", (venue,)).fetchone()
    if b is not None and cost > b["capacity"]:
        raise ValueError(f"cost {cost} exceeds {venue}'s capacity {b['capacity']}")
    slept = 0.0
    while True:
        ok, wait = _try_take(c, venue, cost)
        if ok:
            return slept
        if slept + wait > max_wait_s:
            raise PacerTimeout(f"{venue}: {cost} token(s) not available within {max_wait_s}s "
                               f"(next in {wait:.2f}s)")
        nap = min(max(wait, 0.005), POLL_MAX_S)
        time.sleep(nap)
        slept += nap


def reserve(venue: str, cost: float, capacity: float, per_s: float, *, source: str = "caller") -> int:
    """ONE statement, never blocks: refill `venue`'s bucket (created or re-sized to capacity/per_s
    as the caller's fact card says), debit `cost`, and return the ms the caller must wait before
    it may send (0 = now). Tokens may go NEGATIVE: a later caller queues behind every earlier
    reservation, so N processes asking at once are spaced at the venue's rate. A backoff in force
    adds its remaining time. (platform-core's pacer calls this; take() is the blocking form.)"""
    venue = str(venue).strip().lower()
    if not (capacity > 0 and per_s > 0):
        raise ValueError("capacity and per_s must be > 0")
    if cost > capacity:
        raise ValueError(f"cost {cost} exceeds {venue}'s capacity {capacity}")
    from .db import shared
    now = _now()
    r = shared().execute(
        "INSERT INTO market.pacer AS p (venue, capacity, refill_per_s, tokens, refilled_ms, source, updated_ms) "
        "VALUES (%(v)s, %(cap)s, %(r)s, %(cap)s - %(cost)s, %(now)s, %(src)s, %(now)s) "
        "ON CONFLICT (venue) DO UPDATE SET capacity = EXCLUDED.capacity, refill_per_s = EXCLUDED.refill_per_s, "
        "source = EXCLUDED.source, refilled_ms = %(now)s, "
        "tokens = least(EXCLUDED.capacity, p.tokens + greatest(0, %(now)s - p.refilled_ms) / 1000.0 "
        "* EXCLUDED.refill_per_s) - %(cost)s "
        "RETURNING tokens, refill_per_s, blocked_until_ms",
        {"v": venue, "cap": float(capacity), "r": float(per_s), "cost": float(cost), "now": now,
         "src": str(source)}).fetchone()
    wait = 0 if r["tokens"] >= 0 else int(-r["tokens"] / r["refill_per_s"] * 1000) + 1
    if r["blocked_until_ms"] and r["blocked_until_ms"] > now:
        wait = max(wait, r["blocked_until_ms"] - now)
    return wait


def backoff(venue: str, seconds: float | None, reason: str, *, until_ms: int | None = None) -> dict:
    """Block `venue` for `seconds` (or until the epoch ms `until_ms`) - the adaptive rule; the
    later of two blocks stands."""
    venue = str(venue).strip().lower()
    until = int(until_ms) if until_ms is not None else _now() + int(seconds * 1000)
    with _conn() as c:
        r = c.execute("UPDATE market.pacer SET blocked_until_ms = greatest(coalesce(blocked_until_ms, 0), %s), "
                      "reason = %s, updated_ms = %s WHERE venue = %s RETURNING *",
                      (until, str(reason), _now(), venue)).fetchone()
    if r is None:
        raise KeyError(f"{venue} has no pacer budget (set_budget first)")
    return dict(r)


@contextmanager
def coalesce(key: str, timeout_s: float = 120.0):
    """Hold the advisory lock of request `key` for the block (one fetch per key at a time), on a
    connection of its own. PacerTimeout when another holder keeps it past timeout_s (a waiter polls
    pg_try_advisory_lock: lock_timeout does not bound an advisory lock wait)."""
    c = _conn()
    try:
        deadline = time.monotonic() + timeout_s
        nap = 0.01
        while not c.execute("SELECT pg_try_advisory_lock(hashtextextended(%s, 0)) AS ok",
                            (str(key),)).fetchone()["ok"]:
            if time.monotonic() >= deadline:
                raise PacerTimeout(f"request {key!r} held by another fetch for {timeout_s}s")
            time.sleep(nap)
            nap = min(nap * 2, 0.25)
        try:
            yield
        finally:
            c.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (str(key),))
    finally:
        c.close()


def status(venue: str | None = None) -> list[dict]:
    """Every paced venue (or one): {venue, capacity, refill_per_s, tokens (refilled to now; negative
    = reservations queued), blocked_until_ms, reason, source, updated_ms}."""
    now = _now()
    with _conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM market.pacer WHERE %(v)s::text IS NULL OR venue = %(v)s ORDER BY venue",
            {"v": str(venue).lower() if venue else None}).fetchall()]
    for r in rows:
        r["tokens"] = min(r["capacity"], r["tokens"] + max(0, now - r.pop("refilled_ms")) / 1000 * r["refill_per_s"])
    return rows
