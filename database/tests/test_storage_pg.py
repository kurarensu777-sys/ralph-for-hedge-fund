"""Migration market/004 on a real throwaway cluster: the archive declarations, the
cache months, the pin index, and the pacer shared across connections."""
import threading
import time

import pytest

from fund_db import pacer
from fund_db.market import storage


@pytest.fixture
def pgstore(db, tmp_path, monkeypatch):
    monkeypatch.setenv("FUND_DB_DIR", str(tmp_path / "db"))
    storage.use(storage.PgStorage())
    yield storage.backend()
    storage.use(None)


def test_a_fresh_store_declares_nothing_until_a_venue_does(pgstore):
    assert storage.archive_declarations() == []
    assert storage.resolve("candles", "venue_g", "BTC", "1h") == "cache"
    storage.declare_archive("venue_g", [{"dataset": "candles"}], why="w", source="s")
    assert storage.resolve("candles", "venue_g", "BTC", "1h") == "archive"
    assert storage.resolve("candles", "venue_l", "BTC-USDT", "1h") == "cache"


def test_declare_replaces_and_mirrors(pgstore):
    storage.declare_archive("venue_g", [{"dataset": "candles", "interval": "1h"}], why="cap",
                            source="venue_g venue config")
    storage.declare_archive("venue_n", [{"dataset": "option_chains", "symbol": "CME:SR3*"}], why="sr3",
                            source="venue_n venue config")
    got = [(d["venue"], d["interval"], d["source"]) for d in storage.archive_declarations()]
    assert got == [("venue_g", "1h", "venue_g venue config"),
                   ("venue_n", "*", "venue_n venue config")]
    import json
    mirror = json.loads(storage._mirror_path().read_text(encoding="utf-8"))
    assert [d["venue"] for d in mirror] == ["venue_g", "venue_n"]


def test_cache_months_and_the_pin_index(pgstore):
    b = pgstore
    b.cache_written([{"dataset": "funding", "venue": "venue_a", "interval": "", "month": "2026-09",
                      "bytes": 10, "files": 1, "written_ms": 5}])
    b.cache_read([("funding", "venue_a", "", "2026-09")], 9)
    assert b.cache_list()[0]["last_read_ms"] == 9
    b.cache_written([{"dataset": "funding", "venue": "venue_a", "interval": "", "month": "2026-09",
                      "bytes": 20, "files": 2, "written_ms": 7}])
    row = b.cache_list()[0]
    assert (row["bytes"], row["written_ms"], row["last_read_ms"]) == (20, 7, 9)
    b.cache_forget([("funding", "venue_a", "", "2026-09")])
    assert b.cache_list() == []
    h = "c" * 64
    idx = {"hash": h, "created_ms": 1, "dataset": "candles", "venue": "venue_l", "symbol": "BTC", "interval": "1h",
           "what": "", "window_from": 0, "window_to": 9, "first_ts": 0, "last_ts": 9, "rows": 2, "bytes": 3}
    b.pin_put(idx, {"hash": h, "ref": "lab/a#1", "reason": "r", "created_ms": 2})
    b.pin_put(idx, {"hash": h, "ref": "lab/a#1", "reason": "r", "created_ms": 3})        # idempotent
    b.pin_put(idx, {"hash": h, "ref": "study-1", "reason": "s", "created_ms": 4})
    got = b.pin_list()
    assert len(got) == 1 and [r["ref"] for r in got[0]["refs"]] == ["lab/a#1", "study-1"]
    assert [p["hash"] for p in b.pin_list(ref="study-1")] == [h] and b.pin_list(ref="x") == []
    assert b.pin_count() == 1
    import psycopg
    with pytest.raises(psycopg.errors.CheckViolation):
        b.pin_put(dict(idx, hash="not-a-hash"), {"hash": "not-a-hash", "ref": "x", "reason": "r", "created_ms": 1})


class _Clock:
    """The pacer's clock under the test's hand: sleep() moves time and nothing else, so a wait is
    exactly what the bucket arithmetic says, whatever the machine is doing."""

    def __init__(self):
        self.ms = int(time.time() * 1000)
        self.slept = []

    def time(self):
        return self.ms / 1000

    def monotonic(self):
        return self.ms / 1000

    def sleep(self, s):
        self.slept.append(s)
        self.ms += int(round(s * 1000))


@pytest.fixture
def clock(monkeypatch):
    ck = _Clock()
    monkeypatch.setattr(pacer, "time", ck)
    monkeypatch.setattr(pacer, "_now", lambda: ck.ms)
    return ck


def test_the_pacer_debits_waits_and_times_out(db, clock):
    assert pacer.take("nobody") == 0.0                       # unpaced
    pacer.set_budget("venuex", capacity=2, refill_per_s=20, source="tests: card x")
    assert pacer.take("venuex") == 0.0 and pacer.take("venuex") == 0.0      # two tokens in the bucket
    assert pacer.status("venuex")[0]["tokens"] == 0
    waited = pacer.take("venuex")            # empty: exactly the time one token takes, 1/20 s
    assert waited == pytest.approx(1 / 20) and sum(clock.slept) == pytest.approx(waited)
    assert pacer.status("venuex")[0]["tokens"] >= 0          # a take never leaves the bucket in debt
    with pytest.raises(ValueError, match="exceeds"):
        pacer.take("venuex", cost=3)
    pacer.backoff("venuex", 5, "pacing violation")
    with pytest.raises(pacer.PacerTimeout):
        pacer.take("venuex", max_wait_s=0.2)
    st = pacer.status()
    assert st[0]["venue"] == "venuex" and st[0]["reason"] == "pacing violation" and 0 <= st[0]["tokens"] <= 2
    with pytest.raises(KeyError):
        pacer.backoff("nobody", 1, "x")


def test_the_pacer_wait_on_the_real_clock_is_bounded_never_exact(db):
    """What a slow machine cannot change: the wait is not negative, is never more than one refill
    interval plus a stated slack, never more than the call itself took, and the bucket is not in debt."""
    refill_interval, slack = 1 / 20, 1.0
    pacer.set_budget("venuew", capacity=2, refill_per_s=20, source="tests: card w")
    pacer.take("venuew"), pacer.take("venuew")
    t0 = time.monotonic()
    waited = pacer.take("venuew")
    took = time.monotonic() - t0
    assert 0.0 <= waited <= refill_interval + slack
    assert waited <= took + 0.005                           # it cannot have waited longer than it ran
    assert 0 <= pacer.status("venuew")[0]["tokens"] <= 2


def test_the_pacer_is_one_bucket_across_connections(db):
    pacer.set_budget("venuey", capacity=5, refill_per_s=5, source="tests")
    t0 = time.monotonic()
    errs = []

    def spend():
        try:
            for _ in range(3):
                pacer.take("venuey", max_wait_s=10)
        except Exception as e:  # pragma: no cover - reported below
            errs.append(e)
    ts = [threading.Thread(target=spend) for _ in range(3)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert not errs
    # 9 tokens from a bucket of 5 refilling 5/s: at least ~0.8 s, whoever spent them
    assert time.monotonic() - t0 > 0.6


def test_coalesce_serializes_one_key_and_times_out(db):
    order = []
    started = threading.Event()

    def first():
        with pacer.coalesce("venue_a|funding|BTCUSDT"):
            started.set()
            order.append("first-in")
            time.sleep(0.4)
            order.append("first-out")
    t = threading.Thread(target=first)
    t.start()
    started.wait(5)
    with pytest.raises(pacer.PacerTimeout):
        with pacer.coalesce("venue_a|funding|BTCUSDT", timeout_s=0.1):
            pass
    with pacer.coalesce("venue_a|funding|ETHUSDT", timeout_s=0.1):     # another key never waits
        order.append("other")
    with pacer.coalesce("venue_a|funding|BTCUSDT", timeout_s=5):
        order.append("second")
    t.join()
    assert order == ["first-in", "other", "first-out", "second"]


def test_reserve_is_one_statement_that_queues_callers_at_the_rate(db):
    assert pacer.reserve("venuez", 1, capacity=2, per_s=1, source="tests: card z") == 0
    assert pacer.reserve("venuez", 1, capacity=2, per_s=1) == 0
    w1 = pacer.reserve("venuez", 1, capacity=2, per_s=1)        # the bucket is empty: ~1 s
    w2 = pacer.reserve("venuez", 1, capacity=2, per_s=1)        # queued behind it: ~2 s
    assert 500 < w1 <= 1001 and w1 + 500 < w2 <= 2001
    pacer.backoff("venuez", None, "429", until_ms=pacer._now() + 5_000)
    assert pacer.reserve("venuez", 1, capacity=2, per_s=1) > 4_000
    assert pacer.status("venuez")[0]["tokens"] < 0 and pacer.status("nobody") == []
    with pytest.raises(ValueError, match="exceeds"):
        pacer.reserve("venuez", 3, capacity=2, per_s=1)


def test_blobs_index_on_postgres_keeps_jsonb_refs_and_refuses_other_bytes(pgstore):
    """Migration market/005: the blob index and its refs, through the real backend."""
    import hashlib

    from fund_db import market
    from fund_db.market import BlobConflict
    raw = b"UD15" * 100
    r = market.blob_put("raw", "l2/2026-10-06/btc/a.bin", raw, reason="input", ref="lab/u#1",
                        meta={"rows": 7, "levels": [1, 2]}, built_from={"git": "abc"})
    assert r["written"] and r["hash"] == hashlib.sha256(raw).hexdigest()
    assert market.blob_put("raw", "l2/2026-10-06/btc/a.bin", raw, reason="again", ref="lab/u#2")["written"] is False
    m = market.blob_meta("raw", "l2/2026-10-06/btc/a.bin")
    assert m["meta"] == {"rows": 7, "levels": [1, 2]} and m["built_from"] == {"git": "abc"}      # jsonb comes back parsed
    assert [x["ref"] for x in m["refs"]] == ["lab/u#1", "lab/u#2"]
    with pytest.raises(BlobConflict):
        market.blob_put("raw", "l2/2026-10-06/btc/a.bin", raw + b"!", reason="x", ref="lab/u#3")
    assert [b["key"] for b in market.blobs("raw", prefix="l2/2026-10-06/")] == ["l2/2026-10-06/btc/a.bin"]
    assert [b["key"] for b in market.blobs(ref="lab/u#2")] == ["l2/2026-10-06/btc/a.bin"]
    assert market.blobs(ref="lab/u#3") == []
