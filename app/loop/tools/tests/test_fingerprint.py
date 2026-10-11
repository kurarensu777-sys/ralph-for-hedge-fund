#!/usr/bin/env python3
"""fingerprint.py on a SCRATCH market lake, and record.py --input writing it into the row.

Run:  .venv/Scripts/python.exe app/loop/tools/tests/test_fingerprint.py

Every test points $FUND_DB_DIR at a temp folder and swaps in fund_db's in-memory catalog, so
nothing reads or writes ~/fund-data/db or the real market.catalog. Rows go in through
fund_db.market.write (verbatim, as the legacy import stored them) and come back out through
fingerprint.py's lake reader. Expected digests are computed HERE from the fixture rows, with the
formula written out by hand, never read back from fingerprint.py.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOOP = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(LOOP))

import fixtures  # noqa: E402

H = 3_600_000
T0 = 1767225600000  # 2026-01-01T00:00:00Z


def candles(n: int, start: int = T0, px: float = 100.0) -> list[dict]:
    return [{"t": start + i * H, "o": px + i, "h": px + i + 1, "l": px + i - 1, "c": px + i,
             "v": 1.0, "n": 3, "closed": True, "src": "venue", "seen": 1790000000000 + i}
            for i in range(n)]


def legacy_sha(rows: list[dict], key: str) -> str:
    """the digest the OLD store gave these rows: each row as sorted-key compact JSON with `seen`
    dropped, in stamp order, one per line."""
    h = hashlib.sha256()
    for r in sorted(rows, key=lambda r: r[key]):
        r = {k: v for k, v in r.items() if k != "seen"}
        h.update(json.dumps(r, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


class FpBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="fundfp-"))
        self.data = self.tmp / "db"
        self._env = {k: os.environ.get(k) for k in ("FUND_DB_DIR",)}
        os.environ["FUND_DB_DIR"] = str(self.data)
        from fund_db.market import catalog
        self.catalog = catalog
        catalog.use(catalog.MemoryCatalog())
        # the storage classes' index (archive declarations, cache months) in memory too: a
        # fingerprint test never reaches an ops store, real or not
        from fund_db.market import storage
        self.storage = storage
        storage.use(storage.MemoryStorage())
        # the series under test are ARCHIVE class, so they land in the lake (<data root>/market)
        for v, dsets in (("exchange_a", ("candles", "funding")), ("exchange_b", ("funding",)), ("eod_feed", ("eod",))):
            storage.declare_archive(v, [{"dataset": d} for d in dsets], why="tests", source="tests")
        for m in ("_common", "fingerprint"):
            if m in sys.modules:
                importlib.reload(sys.modules[m])
        import fingerprint
        self.F = importlib.reload(fingerprint)
        # these tests never reach a REAL pin API (its index is the real ops store): pinning is
        # test_pins.py's, against a faked fund_db.market. Here every input lands unpinned.
        import pins
        from unittest import mock
        p = mock.patch.object(pins, "available", lambda: (False, "tests: no real pin API"))
        p.start()
        self.addCleanup(p.stop)

    def tearDown(self):
        self.catalog.use(None)
        self.storage.use(None)
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        os.environ.pop("FUND_ROOT", None)
        fixtures.rmtree(self.tmp)

    def put(self, venue, dataset, symbol, interval, rows):
        """REPLACE the stored series with `rows` (the lake keeps a closed bar immutable, so a
        rewrite is a fresh dataset folder), stored verbatim as the legacy import stored them."""
        from fund_db.market import write
        shutil.rmtree(self.data / "market" / dataset, ignore_errors=True)
        rows = [dict(r, symbol=symbol, src=r.get("src", "venue")) for r in rows]
        write(dataset, rows, venue, interval=interval, verbatim=True, update_catalog=False)

    def fp(self, specs, frm="2026-01-01T00:00:00Z", to="2026-01-02T23:00:00Z"):
        return self.F.fingerprint(specs, self.F.to_ms(frm), self.F.to_ms(to, end=True))


class TestDigest(FpBase):
    def test_equal_rows_give_an_equal_digest(self):
        self.put("exchange_a", "candles", "BTC", "1h", candles(72))
        a = self.fp(["exchange_a:BTC:candles:1h"])
        # the same rows, rewritten in another order and with a fresh fetch stamp: same data
        rows = candles(72)[::-1]
        for r in rows:
            r["seen"] += 999
        self.put("exchange_a", "candles", "BTC", "1h", rows)
        b = self.fp(["exchange_a:BTC:candles:1h"])
        self.assertEqual(a["digest"], b["digest"])
        self.assertEqual(len(a["digest"]), 8)
        i = a["inputs"][0]
        self.assertEqual(i["rows"], 48)  # the window holds 48 of the 72 stored hours
        self.assertEqual(i["first_ts"], T0)
        self.assertEqual(i["last_ts"], T0 + 47 * H)
        self.assertFalse(i["trunc"])

    def test_changing_one_row_changes_the_digest(self):
        self.put("exchange_a", "candles", "BTC", "1h", candles(48))
        a = self.fp(["exchange_a:BTC:candles:1h"])
        rows = candles(48)
        rows[17]["c"] += 0.5
        self.put("exchange_a", "candles", "BTC", "1h", rows)
        b = self.fp(["exchange_a:BTC:candles:1h"])
        self.assertNotEqual(a["digest"], b["digest"])
        # a row OUTSIDE the window does not move it
        rows = candles(48) + candles(5, start=T0 + 100 * H, px=5.0)
        self.put("exchange_a", "candles", "BTC", "1h", rows)
        self.assertEqual(self.fp(["exchange_a:BTC:candles:1h"])["digest"], a["digest"])

    def test_a_missing_head_sets_trunc(self):
        self.put("exchange_a", "candles", "BTC", "1h", candles(40, start=T0 + 8 * H))
        i = self.fp(["exchange_a:BTC:candles:1h"])["inputs"][0]
        self.assertTrue(i["trunc"])
        self.assertEqual(i["first_ts"], T0 + 8 * H)
        # one interval late is the grid, not a missing head (funding lands ms after the hour)
        self.put("exchange_a", "candles", "BTC", "1h", candles(40, start=T0 + H))
        self.assertFalse(self.fp(["exchange_a:BTC:candles:1h"])["inputs"][0]["trunc"])

    def test_the_window_digest_is_order_free_and_covers_every_input(self):
        self.put("exchange_a", "candles", "BTC", "1h", candles(48))
        self.put("exchange_a", "funding", "xyz:ABCD", None,
                 [{"ts": T0 + i * H + 22, "rate": 1e-5 * i, "interval_h": 1.0, "seen": 1} for i in range(48)])
        a = self.fp(["exchange_a:BTC:candles:1h", "exchange_a:xyz:ABCD:funding:-"])
        b = self.fp(["exchange_a:xyz:ABCD:funding:-", "exchange_a:BTC:candles:1h"])
        self.assertEqual(a["digest"], b["digest"])
        self.assertEqual(a["inputs"][1]["symbol"], "xyz:ABCD")
        self.assertEqual(a["inputs"][1]["interval"], "")
        solo = self.fp(["exchange_a:BTC:candles:1h"])
        self.assertNotEqual(a["digest"], solo["digest"])

    def test_a_daily_dataset_is_read(self):
        # eod_feed daily bars: keyed on date, stamped by `time` (ms), stored under venue=eod_feed
        D = 86_400_000
        bars = [{"date": f"2025-12-{29 + i:02d}" if i < 3 else f"2026-01-{i - 2:02d}",
                 "time": T0 + (i - 3) * D, "close": 100.0 + i} for i in range(7)]
        self.put("eod_feed", "eod", "AAPL.US", None, bars)
        i = self.fp(["eod_feed:AAPL.US:eod:-"])["inputs"][0]
        self.assertEqual(i["rows"], 2)            # 2026-01-01 and 01-02 inside the window
        self.assertEqual(i["first_ts"], T0)
        self.assertEqual(i["stored_first"], T0 - 3 * D)
        self.assertFalse(i["trunc"])
        bars[4]["close"] += 1.0                   # a changed bar inside the window moves the digest
        self.put("eod_feed", "eod", "AAPL.US", None, bars)
        self.assertNotEqual(self.fp(["eod_feed:AAPL.US:eod:-"])["inputs"][0]["sha256"], i["sha256"])

    def test_the_digest_is_the_old_stores_digest(self):
        """the lake rebuilds each row into the old JSONL shape, so a series digests to what it
        digested before the lake existed: a fingerprint recorded then stays comparable."""
        bars = candles(48)
        self.put("exchange_a", "candles", "BTC", "1h", bars)
        self.assertEqual(self.fp(["exchange_a:BTC:candles:1h"])["inputs"][0]["sha256"],
                         legacy_sha(bars, "t"))
        fund = [{"ts": T0 + i * H + 22, "rate": 1e-5 * i, "interval_h": 1.0, "src": "venue",
                 "seen": 7} for i in range(48)]
        fund[5]["premium"] = 0.0003                # an optional field only where the venue gave it
        self.put("exchange_b", "funding", "BTCUSDT", None, fund)
        got = self.fp(["exchange_b:BTCUSDT:funding:-"])["inputs"][0]
        self.assertEqual(got["rows"], 47)          # the 48th settles 22 ms after the window's end
        self.assertEqual(got["sha256"], legacy_sha(fund[:47], "ts"))

    def test_an_unknown_dataset_or_a_missing_interval_is_refused(self):
        with self.assertRaises(self.F.C.Refuse) as e:
            self.fp(["exchange_a:BTC:nosuch:1h"])
        self.assertIn("unknown dataset", str(e.exception))
        with self.assertRaises(self.F.C.Refuse) as e:
            self.fp(["exchange_a:BTC:candles:-"])
        self.assertIn("interval", str(e.exception))

    def test_no_stored_series_is_refused(self):
        with self.assertRaises(self.F.C.Refuse):
            self.fp(["exchange_a:NOPE:candles:1h"])
        with self.assertRaises(self.F.C.Refuse):
            self.F.parse_spec("exchange_a:BTC")


class TestRecordInput(FpBase):
    def setUp(self):
        super().setUp()
        self.root = self.tmp / "fund"
        fixtures.good(self.root)
        os.environ["FUND_ROOT"] = str(self.root)
        for m in ("_common", "fingerprint", "preregister", "record"):
            if m in sys.modules:
                importlib.reload(sys.modules[m])

    def run_record(self, *extra):
        import preregister as PR
        import record as R
        importlib.reload(PR)
        importlib.reload(R)
        self.assertEqual(PR.main(["--desk", "lab/alpha", "--run", "alpha-002", "--mechanic", "M1",
                                  "--kind", "exploit", "--ancestor", "alpha-001",
                                  "--variables", "window rolled", "--predict", "ann_pct=10..20",
                                  "--cmd", "python -m thing",
                                  "--window", "2026-01-01T00:00:00Z..2026-01-02T23:00:00Z",
                                  "--allow-no-sha"]), 0)
        return R.main(["--desk", "lab/alpha", "--run", "alpha-002", "--verify", "v 5/5",
                       "--metric", "ann_pct=15", "--gate", "provenance=ok", "--gate", "window=ok",
                       "--gate", "verify=ok", "--gate", "scope=ok", *extra])

    def result_row(self):
        p = self.root / "lab" / "alpha" / "data" / "runs.jsonl"
        rows = [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]
        return [r for r in rows if r.get("run") == "alpha-002" and r.get("stage") == "result"][-1]

    def test_input_writes_the_fingerprint(self):
        self.put("exchange_a", "candles", "BTC", "1h", candles(48))
        self.assertEqual(self.run_record("--input", "exchange_a:BTC:candles:1h"), 0)
        fp = self.result_row()["fingerprint"]
        self.assertEqual(fp["digest"], self.fp(["exchange_a:BTC:candles:1h"])["digest"])
        self.assertEqual(fp["inputs"][0]["rows"], 48)

    def test_no_input_writes_no_fingerprint(self):
        self.assertEqual(self.run_record(), 0)
        self.assertNotIn("fingerprint", self.result_row())

    def test_a_bad_input_refuses_the_whole_record(self):
        self.assertEqual(self.run_record("--input", "exchange_a:NOPE:candles:1h"), 1)


class TestRemeasureInherits(TestRecordInput):
    """a read started with no --input (the scheduler, the cockpit's Lab room) re-digests the
    series the RESULT was fingerprinted over, on the rolled window."""

    def record_and_backdate(self):
        import preregister as PR
        import record as R
        importlib.reload(PR)
        importlib.reload(R)
        self.put("exchange_a", "candles", "BTC", "1h", candles(48))
        cmd = f"{sys.executable} -c print(1)"
        self.assertEqual(PR.main(["--desk", "lab/alpha", "--run", "alpha-002", "--mechanic", "M1",
                                  "--kind", "exploit", "--ancestor", "alpha-001",
                                  "--variables", "window rolled", "--predict", "ann_pct=10..20",
                                  "--cmd", cmd, "--cwd", str(self.tmp),
                                  "--window", "2026-01-01T00:00:00Z..2026-01-02T23:00:00Z",
                                  "--allow-no-sha"]), 0)
        self.assertEqual(R.main(["--desk", "lab/alpha", "--run", "alpha-002", "--verify", "v 5/5",
                                 "--metric", "ann_pct=15", "--gate", "provenance=ok",
                                 "--gate", "window=ok", "--gate", "verify=ok", "--gate", "scope=ok",
                                 "--input", "exchange_a:BTC:candles:1h"]), 0)
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        rows = C.read_jsonl(desk.runs)
        import time
        old = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 8 * 86400))
        for r in rows:
            if r.get("run") == "alpha-002" and r.get("stage") == "result":
                r["ts"] = old
        C.write_text(desk.runs, "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))

    def read_row(self, *extra):
        import remeasure as RM
        importlib.reload(RM)
        RM.main(["--desk", "lab/alpha", "--run", "alpha-002", "--age", "7d", *extra])
        p = self.root / "lab" / "alpha" / "data" / "runs.jsonl"
        rows = [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]
        reads = [r for r in rows if r.get("run") == "alpha-002" and r.get("stage") == "read"]
        self.assertEqual(len(reads), 1, "the read was not written")
        return reads[0]

    def test_recorded_specs_round_trip(self):
        self.record_and_backdate()
        self.assertEqual(self.F.recorded_specs(self.result_row()), ["exchange_a:BTC:candles:1h"])
        self.assertEqual(self.F.recorded_specs({}), [])
        self.assertEqual(self.F.spec_of({"venue": "exchange_a", "symbol": "xyz:ABCD",
                                         "dataset": "funding", "interval": ""}),
                         "exchange_a:xyz:ABCD:funding:-")

    def test_a_read_with_no_input_inherits_the_result_inputs(self):
        self.record_and_backdate()
        row = self.read_row()
        self.assertEqual(row.get("fingerprint_inputs_from"), "result")
        self.assertEqual([i["symbol"] for i in row["fingerprint"]["inputs"]], ["BTC"])

    def test_no_input_turns_inheritance_off(self):
        self.record_and_backdate()
        row = self.read_row("--no-input")
        self.assertNotIn("fingerprint", row)
        self.assertNotIn("fingerprint_inputs_from", row)

    def test_a_vanished_inherited_series_does_not_block_the_read(self):
        self.record_and_backdate()
        shutil.rmtree(self.data / "market" / "candles")
        row = self.read_row()
        self.assertNotIn("fingerprint", row)
        self.assertIn("no stored series", row.get("fingerprint_error", ""))


if __name__ == "__main__":
    unittest.main(verbosity=1)
