"""BLOBS (B-0648): pinned bytes under a registered seat. What each test pins down: the same bytes
under a key are a no-op that adds a ref; other bytes under a pinned key are refused and change
nothing; a typo in a seat or a key that could be a path is refused; a file that changed or went
missing is an error and never a silent re-fetch; nothing the cache does reaches a blob; the byte
accounting sees them apart from the row pins; the manifest digest is the one derived.input_pin made."""
import hashlib

import pytest

from fund_db import market
from fund_db.market import BlobConflict, BlobMissing, PinError, cache
from fund_db.market import blobstore as blobs_mod

SEAT = "raw"
KEY = "l2/2026-10-06/btc/btc-a.bin"
RAW = b"UD15\x01" + bytes(range(256)) * 40


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def put(key=KEY, data=RAW, **kw):
    kw.setdefault("reason", "study input")
    kw.setdefault("ref", "lab/example#7")
    return market.blob_put(SEAT, key, data, **kw)


def test_put_get_meta_and_a_second_ref(classes):
    r = put(meta={"format": "UD15", "rows": 1234}, built_from={"git": "abc123"})
    assert r == {"dataset": SEAT, "key": KEY, "hash": sha(RAW), "bytes": len(RAW), "written": True}
    assert market.blob_get(SEAT, KEY) == RAW
    path = market.blob_path(sha(RAW))
    assert path == classes["root"] / "pins" / "blobs" / sha(RAW)[:2] / f"{sha(RAW)}.blob"
    assert path.read_bytes() == RAW
    again = put(reason="a re-score", ref="lab/example#8")
    assert again["written"] is False and again["hash"] == sha(RAW)
    m = market.blob_meta(SEAT, KEY)
    assert (m["hash"], m["bytes"], m["meta"], m["built_from"]) == (sha(RAW), len(RAW), {"format": "UD15", "rows": 1234}, {"git": "abc123"})
    assert [x["ref"] for x in m["refs"]] == ["lab/example#7", "lab/example#8"]
    assert m["created_ms"] > 0


def test_other_bytes_under_a_pinned_key_are_refused_and_change_nothing(classes):
    put()
    with pytest.raises(BlobConflict, match="pins are immutable"):
        put(data=RAW + b"x", ref="lab/example#9")
    assert market.blob_get(SEAT, KEY) == RAW
    m = market.blob_meta(SEAT, KEY)
    assert m["hash"] == sha(RAW) and [x["ref"] for x in m["refs"]] == ["lab/example#7"]
    assert not market.blob_path(sha(RAW + b"x")).exists()          # the refused bytes were never written


def test_two_keys_with_the_same_bytes_share_one_file(classes):
    put(key="days/2026-10-03@v1")
    put(key="days/2026-10-03@v2")
    files = list((classes["root"] / "pins" / "blobs").rglob("*.blob"))
    assert len(files) == 1
    assert [b["key"] for b in market.blobs(SEAT)] == ["days/2026-10-03@v1", "days/2026-10-03@v2"]


def test_a_bad_seat_key_or_argument_is_refused(classes):
    with pytest.raises(KeyError, match="unknown blob seat"):
        market.blob_put("rawx", KEY, RAW, reason="r", ref="x")
    for bad in ("", "/abs", "a//b", "a/", "../x", "a/../b", ".hidden/x", "a/.b", "has space", "x" * 201, "c:\\x"):
        with pytest.raises(PinError, match="bad blob key"):
            put(key=bad)
    for kw, why in (({"data": b""}, "non-empty bytes"), ({"data": "text"}, "non-empty bytes"),
                    ({"reason": " "}, "reason and its ref"), ({"ref": ""}, "reason and its ref"),
                    ({"meta": ["a"]}, "is a dict"), ({"meta": {"x": object()}}, "not JSON"),
                    ({"built_from": {"x": float("nan")}}, "not JSON"),
                    ({"meta": {"x": "y" * 1_000_001}}, "over 1,000,000")):
        with pytest.raises(PinError, match=why):
            put(**kw)
    assert market.blobs() == []
    assert not list((classes["root"] / "pins").rglob("*.blob"))


def test_probe_and_test_refs_are_refused_on_the_real_root(classes, monkeypatch):
    from fund_db import config
    assert put(ref="probe:scratch")["written"]                      # a scratch root takes it
    monkeypatch.setattr(config, "default_data_dir", lambda: classes["root"].resolve())
    with pytest.raises(PinError, match="never touch the real data root"):
        put(key="l2/2026-10-06/eth/x.bin", ref="test:x")
    assert put(key="l2/2026-10-06/eth/x.bin", ref="lab/example#7")["written"]


def test_a_changed_or_missing_file_is_an_error_not_a_refetch(classes):
    put()
    other = put(key="l2/2026-10-06/eth/x.bin", data=b"ETH" * 100)
    path = market.blob_path(sha(RAW))
    path.write_bytes(RAW[:-1] + b"?")                                 # same size class, other bytes
    with pytest.raises(PinError, match="no longer hashes"):
        market.blob_get(SEAT, KEY)
    assert market.blob_get(SEAT, KEY, verify=False) == RAW[:-1] + b"?"
    c = blobs_mod.check()
    assert c["size_mismatch"] == [] and c["hash_mismatch"] == [] and c["missing"] == []      # a size check cannot see it
    assert blobs_mod.check(verify=True)["hash_mismatch"] == [[SEAT, KEY]]
    path.write_bytes(RAW[:10])
    assert blobs_mod.check()["size_mismatch"] == [[SEAT, KEY]]
    path.unlink()
    assert blobs_mod.check()["missing"] == [[SEAT, KEY]]
    with pytest.raises(BlobMissing, match="bytes are missing"):
        market.blob_get(SEAT, KEY)
    with pytest.raises(BlobMissing, match="not pinned"):
        market.blob_get(SEAT, "l2/never/pinned.bin")
    assert market.blob_get(SEAT, "l2/2026-10-06/eth/x.bin") == b"ETH" * 100 and other["written"]


def test_listing_by_seat_prefix_and_ref(classes):
    put(key="l2/2026-10-06/btc/a.bin", ref="lab/example#7")
    put(key="l2/2026-10-06/eth/b.bin", data=b"b" * 50, ref="lab/example#8")
    market.blob_put("derived", "days/2026-10-03@v2", b"d" * 30, reason="day", ref="lab/example#7")
    assert [(b["dataset"], b["key"]) for b in market.blobs()] == [
        ("derived", "days/2026-10-03@v2"), (SEAT, "l2/2026-10-06/btc/a.bin"), (SEAT, "l2/2026-10-06/eth/b.bin")]
    assert [b["key"] for b in market.blobs(SEAT, prefix="l2/2026-10-06/e")] == ["l2/2026-10-06/eth/b.bin"]
    assert [(b["dataset"], b["key"]) for b in market.blobs(ref="lab/example#7")] == [
        ("derived", "days/2026-10-03@v2"), (SEAT, "l2/2026-10-06/btc/a.bin")]
    with pytest.raises(KeyError):
        market.blobs("nope")
    fp = market.window_digest([b["hash"] for b in market.blobs(ref="lab/example#7")])
    assert fp == hashlib.sha256("\n".join(sorted([sha(RAW), sha(b"d" * 30)])).encode()).hexdigest()[:8]


def test_the_input_pin_is_the_digest_derived_py_made(classes):
    a, b = b"day one" * 9, b"day two" * 9
    market.blob_put("derived", "t/2026-10-02@v1", a, reason="r", ref="s#1")
    market.blob_put("derived", "t/2026-10-01@v1", b, reason="r", ref="s#1")
    p = market.blob_input_pin("derived", ["t/2026-10-02@v1", "t/2026-10-01@v1", "t/2026-10-02@v1"])
    # fundplat.data.derived.input_pin, written out again: 16 hex of sha256 over 'key:sha256' joined by \n, keys sorted
    want = hashlib.sha256(f"t/2026-10-01@v1:{sha(b)}\nt/2026-10-02@v1:{sha(a)}".encode()).hexdigest()[:16]
    assert p == {"dataset": "derived", "keys": ["t/2026-10-01@v1", "t/2026-10-02@v1"], "bytes": len(a) + len(b), "digest": want}
    with pytest.raises(BlobMissing):
        market.blob_input_pin("derived", ["t/2026-10-01@v1", "t/missing"])


def test_the_cache_never_reaches_a_blob_and_the_accounting_sees_it(classes):
    put()
    market.write_candles("venue_l", "BTC-USDT", "1h", [{"t": 1_788_220_800_000, "o": 1, "h": 1, "l": 1, "c": 1}],
                         closed_asof_ms=1_788_300_000_000, now=1_788_300_000_000)
    h = market.pin(dataset="candles", venue="venue_l", symbol="BTC-USDT", interval="1h", reason="r", ref="lab/x#1")
    r = cache.clean(idle_days=0)
    assert r["evicted_months"] >= 1 and cache.evict(to_bytes=0) is not None
    assert market.blob_get(SEAT, KEY) == RAW
    s = cache.sizes()
    assert s["blobs"] == 1 and s["blobs_bytes"] == len(RAW)
    assert s["pins"] == 1 and s["pins_bytes"] == sum(f.stat().st_size for f in (classes["root"] / "pins").rglob("*.parquet")) > 0
    other = {o["name"]: o for o in market.usage(rows=False)["other"]}
    assert (other["blobs"]["files"], other["blobs"]["bytes"]) == (1, len(RAW))
    assert other["pins"]["bytes"] == s["pins_bytes"] and other["pins"]["files"] == 1 and h
