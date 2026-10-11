"""PINS (B-0322): content-addressed, immutable, never evicted; the hash is app/loop/tools/
fingerprint.py's per-input digest, so a fingerprint recorded before pins existed compares."""
import hashlib
import json
import sys
from pathlib import Path

import pytest

from fund_db import market
from fund_db.market import cache
from fund_db.market import pinning as pins

T0 = 1788220800000          # 2026-09-01T00:00:00Z
H = 3_600_000
APP_TOOLS = Path(__file__).resolve().parents[3] / "app" / "loop" / "tools"


def bars(n=5, start=T0):
    return [{"t": start + i * H, "o": 1.0 + i, "h": 2.0 + i, "l": 0.5, "c": 1.5 + i, "v": 10.0 * i, "n": i}
            for i in range(n)]


def independent_digest(rows):
    """fingerprint.py's rule, written out again here (not imported from the code under test)."""
    out = []
    for r in rows:
        t = r.get("ts", r.get("t", r.get("time")))
        out.append((t, {k: v for k, v in r.items() if k != "seen"}))
    out.sort(key=lambda x: x[0])
    h = hashlib.sha256()
    for _, r in out:
        h.update(json.dumps(r, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def test_the_hash_is_the_fingerprint_digest(classes):
    market.write_candles("venue_l", "BTC-USDT", "1h", bars(), closed_asof_ms=T0 + 10 * H, now=T0 + 10 * H)
    h = market.pin(dataset="candles", venue="venue_l", symbol="BTC-USDT", interval="1h", reason="r", ref="lab/a#1")
    legacy = [{"t": b["t"], "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"], "v": b["v"], "n": b["n"],
               "closed": True, "src": "venue"} for b in bars()]
    assert h == independent_digest(legacy)
    assert market.window_digest([h]) == hashlib.sha256(h.encode()).hexdigest()[:8]


@pytest.mark.skipif(not (APP_TOOLS / "fingerprint.py").exists(), reason="app/loop/tools/fingerprint.py not beside this repo")
def test_the_hash_equals_app_fingerprint_py_on_the_same_lake(classes):
    market.write_funding("venue_a", [{"ts": T0 + i * 8 * H, "rate": 1e-5 * i, "interval_h": 8.0} for i in range(4)],
                         symbol="BTCUSDT")
    sys.path.insert(0, str(APP_TOOLS))
    try:
        import fingerprint
        fp = fingerprint.fingerprint_input("venue_a:BTCUSDT:funding:-", T0, T0 + 30 * 8 * H)
    finally:
        sys.path.remove(str(APP_TOOLS))
    r = market.pin_series("venue_a:BTCUSDT:funding:-", {"from": T0, "to": T0 + 30 * 8 * H},
                          reason="backfill", ref="lab/b#1", expect=fp["sha256"])
    assert r["match"] is True and r["rows"] == fp["rows"] == 4


def test_pin_pinned_pins_and_a_second_ref(classes):
    market.write_candles("venue_l", "BTC-USDT", "1h", bars(10))
    h = market.pin(dataset="candles", venue="venue_l", symbol="BTC-USDT", interval="1h",
                   window={"from": T0 + 2 * H, "to": T0 + 4 * H}, reason="run input", ref="lab/a#1")
    got = market.pinned(h, as_="rows")
    assert [r["t"] for r in got] == [T0 + 2 * H, T0 + 3 * H, T0 + 4 * H]
    again = market.pin(dataset="candles", venue="venue_l", symbol="BTC-USDT", interval="1h",
                       window=f"{T0 + 2 * H}..{T0 + 4 * H}", reason="study input", ref="study-7")
    assert again == h
    idx = market.pins(hash=h)
    assert len(idx) == 1 and idx[0]["rows"] == 3 and [x["ref"] for x in idx[0]["refs"]] == ["lab/a#1", "study-7"]
    assert [p["hash"] for p in market.pins(ref="study-7")] == [h]
    assert market.pins(ref="nobody") == []


def test_a_pin_of_frame_rows_or_a_handle_is_the_same_pin(classes):
    market.write_candles("venue_l", "ETH-USDT", "1h", [dict(b, n=None) if i == 2 else b for i, b in enumerate(bars())])
    frame = market.candles("venue_l", "ETH-USDT", "1h", as_="pandas")
    assert frame["n"].dtype.kind == "f"            # pandas turned the int column with a null into floats
    a = market.pin(frame, dataset="candles", venue="venue_l", symbol="ETH-USDT", interval="1h", reason="r", ref="x")
    handle = {"dataset": "candles", "venue": "venue_l", "symbol": "ETH-USDT", "interval": "1h", "what": None,
              "window": {"from": T0, "to": T0 + 99 * H}}
    b = market.pin(handle=handle, reason="r", ref="y")
    assert a == b


def test_a_pin_survives_eviction(classes):
    market.write_candles("venue_l", "BTC-USDT", "1h", bars())
    h = market.pin(dataset="candles", venue="venue_l", symbol="BTC-USDT", interval="1h", reason="r", ref="lab/a#1")
    cache.evict(to_bytes=0)
    assert market.candles("venue_l", "BTC-USDT", "1h", as_="rows") == []
    assert len(market.pinned(h, as_="rows")) == 5


def test_a_tampered_pin_is_refused(classes):
    market.write_candles("venue_l", "BTC-USDT", "1h", bars())
    h = market.pin(dataset="candles", venue="venue_l", symbol="BTC-USDT", interval="1h", reason="r", ref="a")
    import pyarrow.parquet as pq
    p = pins.pin_path(h)
    t = pq.read_table(p).to_pylist()
    t[0]["c"] = 999.0
    import pyarrow as pa
    pq.write_table(pa.Table.from_pylist(t, schema=pq.read_schema(p)), p)
    with pytest.raises(pins.PinError, match="no longer digests"):
        market.pinned(h)
    assert pins.check()["size_mismatch"] in ([], [h])


def test_a_pin_of_nothing_or_without_a_reason_is_refused(classes):
    with pytest.raises(pins.PinError, match="no rows"):
        market.pin(dataset="candles", venue="venue_l", symbol="NONE", interval="1h", reason="r", ref="a")
    market.write_candles("venue_l", "BTC-USDT", "1h", bars())
    with pytest.raises(pins.PinError, match="reason and its ref"):
        market.pin(dataset="candles", venue="venue_l", symbol="BTC-USDT", interval="1h", reason="", ref="a")
    with pytest.raises(pins.PinError, match="per interval"):
        market.pin(dataset="candles", venue="venue_l", symbol="BTC-USDT", reason="r", ref="a")


def test_pin_series_reports_a_mismatch(classes):
    market.write_candles("venue_l", "BTC-USDT", "1h", bars())
    r = market.pin_series("venue_l:BTC-USDT:candles:1h", "2026-09-01..2026-09-02", reason="b", ref="lab/a#1",
                          expect="0" * 64)
    assert r["match"] is False and r["rows"] == 5
    assert pins.check() == {"pins": 1, "missing": [], "size_mismatch": []}


# B-0384: a probe or a test never pins into the real root, and the ones that got in are retired.

def _as_real_root(monkeypatch, lake):
    """Make the test's own scratch root count as the real one (so a broken gate writes only there)."""
    from fund_db import config
    monkeypatch.setattr(config, "default_data_dir", lambda: lake["root"].resolve())
    assert config.is_real_root()


def test_probe_and_test_refs_are_refused_on_the_real_root(classes, monkeypatch):
    market.write_candles("venue_l", "BTC-USDT", "1h", bars())
    spec = dict(dataset="candles", venue="venue_l", symbol="BTC-USDT", interval="1h", reason="r")
    assert market.pin(**spec, ref="probe:scratch")                   # a scratch root takes it
    assert market.pin(**spec, ref="test:x")
    _as_real_root(monkeypatch, classes)
    for ref in ("probe:scratch", "test:x", " Probe:y"):
        with pytest.raises(pins.PinError, match="never touch the real data root"):
            market.pin(**spec, ref=ref)
    assert market.pin(**spec, ref="research:research-009")           # a real ref still pins
    assert sorted(r["ref"] for r in market.pins()[0]["refs"]) == ["probe:scratch", "research:research-009", "test:x"]


def test_the_default_root_is_the_real_one(monkeypatch):
    from fund_db import config
    monkeypatch.delenv("FUND_DB_DIR", raising=False)
    assert config.is_real_root()
    monkeypatch.setenv("FUND_DB_DIR", str(config.default_data_dir() / "elsewhere"))
    assert not config.is_real_root()


def test_retire_scratch_moves_probe_only_pins_and_keeps_every_real_ref(classes):
    for sym, n in (("AAA", 3), ("BBB", 4), ("CCC", 5)):
        market.write_candles("venue_l", sym + "-USDT", "1h", bars(n))
    spec = lambda s: dict(dataset="candles", venue="venue_l", symbol=s + "-USDT", interval="1h", reason="r")
    a = market.pin(**spec("AAA"), ref="probe:scratch")
    b = market.pin(**spec("BBB"), ref="probe:scratch")
    market.pin(**spec("BBB"), ref="research:research-001")
    c = market.pin(**spec("CCC"), ref="research:research-002")
    d = market.pin(**spec("AAA"), ref="test:other")
    assert d == a

    plan = pins.retire_scratch()
    assert [x["hash"] for x in plan["retire"]] == [a] and [x["hash"] for x in plan["unref"]] == [b]
    assert plan["unref"][0]["drop_refs"] == ["probe:scratch"] and plan["pins_before"] == plan["pins_after"] == 3
    assert pins.pin_path(a).exists() and len(market.pins(hash=b)[0]["refs"]) == 2   # a dry run moved nothing

    done = pins.retire_scratch(apply=True)
    assert done["pins_before"] == 3 and done["pins_after"] == 2
    root = classes["root"]
    assert not pins.pin_path(a).exists()
    assert (root / "_retired" / "pins" / a[:2] / f"{a}.parquet").exists()      # moved, not deleted
    assert [p["hash"] for p in market.pins()] == [b, c]
    assert [r["ref"] for r in market.pins(hash=b)[0]["refs"]] == ["research:research-001"]
    assert [r["ref"] for r in market.pins(hash=c)[0]["refs"]] == ["research:research-002"]
    assert market.pinned(b, as_="rows") and market.pinned(c, as_="rows")
    assert pins.check() == {"pins": 2, "missing": [], "size_mismatch": []}
    lines = [json.loads(x) for x in (root / "_retired" / "pins" / "manifest.jsonl").read_text().splitlines()]
    assert sorted(x["pin"]["hash"] for x in lines) == sorted([a, b])
    assert sorted(r["ref"] for r in next(x for x in lines if x["pin"]["hash"] == a)["pin"]["refs"]) == \
        ["probe:scratch", "test:other"]
    assert pins.retire_scratch(apply=True)["retire"] == []                       # nothing left: a no-op
