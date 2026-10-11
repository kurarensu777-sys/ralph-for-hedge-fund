#!/usr/bin/env python3
"""pins.py, and the pinning path through fingerprint.py, record.py, remeasure.py and
preregister.py (B-0322 section 1: a recorded result PINS the exact rows it read).

Run:  .venv/Scripts/python.exe app/loop/tools/tests/test_pins.py

The pin API is FAKED on fund_db.market (`pin_series` set on the real module for the length of
one test, `create=True`), so no test writes a pin into the real store or the real ops index. The
stored rows are FIXED literals handed to fingerprint.py through a stubbed `stored_rows`, so the
digests below do not depend on the lake's state or on the data layer's work in progress.

THE LITERAL DIGESTS were computed with fingerprint.py AS IT STOOD BEFORE the pinning path was
added (app HEAD 3265414, 2026-09-28), over exactly these rows and this window. They are typed
here, never recomputed from the code under test: if the digest ever moves, a legacy fingerprint
no longer compares with its pin, and this file goes red.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
LOOP = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(LOOP))

import fixtures  # noqa: E402

H = 3_600_000
T0 = 1767225600000  # 2026-01-01T00:00:00Z
WIN = "2026-01-01T00:00:00Z..2026-01-02T23:00:00Z"
FRM, TO = T0, T0 + 47 * H

CANDLE_SPEC = "exchange_a:BTC:candles:1h"
FUNDING_SPEC = "exchange_b:BTCUSDT:funding:-"
# computed BEFORE the change (see the module docstring); 48 and 47 rows inside the window
CANDLE_SHA = "99aab545be0de06cfffc89b994282737c70bae9eebb8d8b84e106e51327eb614"
FUNDING_SHA = "31f2bc04497c8d77619f53470234d6919fad9cf8adb381bd473fc35345eab2b3"
WINDOW_DIGEST = "ddbb9aa3"


def candle_rows() -> list[dict]:
    """72 hourly bars in the old store's shape, stored newest first, each with a fetch stamp."""
    return [{"t": T0 + i * H, "o": 100.0 + i, "h": 101.0 + i, "l": 99.0 + i, "c": 100.0 + i,
             "v": 1.0, "n": 3, "closed": True, "src": "venue", "seen": 1790000000000 + i}
            for i in range(72)][::-1]


def funding_rows() -> list[dict]:
    rows = [{"ts": T0 + i * H + 22, "rate": 1e-5 * i, "interval_h": 1.0, "src": "venue", "seen": 7}
            for i in range(48)]
    rows[5]["premium"] = 0.0003
    return rows


STORED = {"candles": candle_rows, "funding": funding_rows}
SHA_OF = {CANDLE_SPEC: CANDLE_SHA, FUNDING_SPEC: FUNDING_SHA}


class FakePins:
    """a stand-in for fund_db.market.pin_series: records every call, answers a hash."""

    def __init__(self, mode: str = "honest"):
        self.mode, self.calls = mode, []

    def __call__(self, spec, window, *, reason, ref, expect=None):
        self.calls.append({"spec": spec, "window": window, "reason": reason, "ref": ref,
                           "expect": expect})
        if self.mode == "boom":
            raise RuntimeError("the store is down")
        h = SHA_OF[spec]
        if self.mode == "mismatch":       # the store holds other rows than the digest read
            h = "0" * 64
        out = {"hash": h, "rows": 48, "first_ts": FRM, "last_ts": TO, "match": h == expect}
        if self.mode == "liar":           # a different hash that still claims to match
            out = dict(out, hash="f" * 64, match=True)
        return out


class PinBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="fundpins-"))
        self._env = {k: os.environ.get(k) for k in ("FUND_DB_DIR", "FUND_ROOT")}
        os.environ["FUND_DB_DIR"] = str(self.tmp / "db")     # never the real data root
        self.reload()

    def reload(self):
        for m in ("_common", "pins", "fingerprint", "preregister", "record", "remeasure"):
            if m in sys.modules:
                importlib.reload(sys.modules[m])
        import fingerprint
        import pins
        self.F, self.P = fingerprint, pins
        p = mock.patch.object(fingerprint, "stored_rows",
                              lambda s: [dict(r) for r in STORED[s["dataset"]]()])
        p.start()
        self.addCleanup(p.stop)

    def tearDown(self):
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        fixtures.rmtree(self.tmp)

    def fake(self, mode: str = "honest") -> FakePins:
        """fund_db.market.pin_series is `mode` for this test."""
        from fund_db import market
        f = FakePins(mode)
        p = mock.patch.object(market, "pin_series", f, create=True)
        p.start()
        self.addCleanup(p.stop)
        return f

    def no_api(self):
        """fund_db.market with NO pin_series, whatever the data layer has landed by now."""
        p = mock.patch.object(self.P, "_market", lambda: (types.SimpleNamespace(), ""))
        p.start()
        self.addCleanup(p.stop)


class TestDigestUnmoved(PinBase):
    def test_the_legacy_digest_of_fixed_rows_is_the_literal(self):
        fp = self.F.fingerprint([CANDLE_SPEC, FUNDING_SPEC], FRM, TO)
        self.assertEqual([i["sha256"] for i in fp["inputs"]], [CANDLE_SHA, FUNDING_SHA])
        self.assertEqual([i["rows"] for i in fp["inputs"]], [48, 47])
        self.assertEqual(fp["digest"], WINDOW_DIGEST)
        self.assertFalse(any("pin" in i for i in fp["inputs"]))   # no pin asked, none written

    def test_the_literal_is_the_stated_formula(self):
        """the literal is not a number the code happened to print: it is the legacy formula
        (sorted-key compact JSON, `seen` dropped, stamp order, one newline per row)."""
        h = hashlib.sha256()
        for r in sorted(candle_rows(), key=lambda r: r["t"])[:48]:
            r = {k: v for k, v in r.items() if k != "seen"}
            h.update(json.dumps(r, sort_keys=True, separators=(",", ":"),
                                ensure_ascii=False).encode("utf-8") + b"\n")
        self.assertEqual(h.hexdigest(), CANDLE_SHA)

    def test_pinning_does_not_move_a_byte_of_the_digest(self):
        self.fake()
        fp = self.F.fingerprint([CANDLE_SPEC, FUNDING_SPEC], FRM, TO,
                                pin={"reason": "result", "ref": "lab/alpha:x"})
        self.assertEqual([i["sha256"] for i in fp["inputs"]], [CANDLE_SHA, FUNDING_SHA])
        self.assertEqual(fp["digest"], WINDOW_DIGEST)

    def pins_digest(self):
        from fund_db import market
        if not callable(getattr(market, "pins_digest", None)):
            self.skipTest("fund_db.market.pins_digest has not landed yet (B-0324): nothing to "
                          "compare against")
        return market.pins_digest

    def test_the_data_layers_digest_agrees_on_candles(self):
        rows = [dict(r, symbol="BTC") for r in candle_rows() if FRM <= r["t"] <= TO]
        self.assertEqual(self.pins_digest()("candles", rows), CANDLE_SHA)

    @unittest.expectedFailure
    def test_the_data_layers_digest_agrees_on_funding_with_an_optional_field(self):
        """KNOWN DISAGREEMENT (found 2026-09-28, reported on B-0324): pins_digest builds its
        table with pa.Table.from_pylist, which takes the schema from the FIRST row, so `premium`
        (present on row 5 only) is dropped and the digest is not fingerprint.py's. When the data
        layer fixes it this test passes, the run reports an UNEXPECTED SUCCESS (not OK), and the
        marker above comes off."""
        rows = [dict(r, symbol="BTCUSDT") for r in funding_rows() if r["ts"] <= TO]
        self.assertEqual(self.pins_digest()("funding", rows), FUNDING_SHA)


class TestPinInput(PinBase):
    def inp(self):
        return self.F.fingerprint([CANDLE_SPEC], FRM, TO)["inputs"][0]

    def test_an_honest_pin_is_the_sha256(self):
        f = self.fake()
        got = self.P.pin_input(self.inp(), (FRM, TO), "result", "lab/alpha:alpha-002")
        self.assertEqual(got, {"pin": CANDLE_SHA, "pin_error": None})
        self.assertEqual(f.calls, [{"spec": CANDLE_SPEC, "window": {"from": FRM, "to": TO},
                                    "reason": "result", "ref": "lab/alpha:alpha-002",
                                    "expect": CANDLE_SHA}])

    def test_a_mismatched_pin_is_refused(self):
        self.fake("mismatch")
        with self.assertRaises(self.P.C.Refuse) as e:
            self.P.pin_input(self.inp(), (FRM, TO), "result", "r")
        self.assertIn("does not match its fingerprint", str(e.exception))

    def test_a_pin_that_claims_a_match_is_still_checked(self):
        self.fake("liar")
        with self.assertRaises(self.P.C.Refuse):
            self.P.pin_input(self.inp(), (FRM, TO), "result", "r")

    def test_no_api_is_an_honest_unpinned_state(self):
        self.no_api()
        self.assertEqual(self.P.available(), (False, self.P.NO_API))
        self.assertEqual(self.P.pin_input(self.inp(), (FRM, TO), "result", "r"),
                         {"pin": None, "pin_error": "fund_db has no pin API yet (B-0324)"})

    def test_a_store_failure_is_said_not_fatal(self):
        self.fake("boom")
        got = self.P.pin_input(self.inp(), (FRM, TO), "result", "r")
        self.assertIsNone(got["pin"])
        self.assertIn("the store is down", got["pin_error"])

    def test_an_empty_window_pins_nothing(self):
        f = self.fake()
        inp = self.F.fingerprint([CANDLE_SPEC], T0 + 500 * H, T0 + 600 * H)["inputs"][0]
        got = self.P.pin_input(inp, (T0 + 500 * H, T0 + 600 * H), "result", "r")
        self.assertEqual((got["pin"], f.calls), (None, []))
        self.assertIn("nothing to pin", got["pin_error"])

    def test_a_pin_needs_its_reason_and_ref(self):
        self.fake()
        with self.assertRaises(self.F.C.Refuse):
            self.F.fingerprint([CANDLE_SPEC], FRM, TO, pin={"reason": "result"})


class TestLoopPins(PinBase):
    """the tools, end to end on the fixture fund tree (its own git repo)."""

    def setUp(self):
        super().setUp()
        self.root = self.tmp / "fund"
        fixtures.good(self.root)
        os.environ["FUND_ROOT"] = str(self.root)
        self.reload()

    def rows(self, stage):
        p = self.root / "lab" / "alpha" / "data" / "runs.jsonl"
        rows = [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]
        return [r for r in rows if r.get("run") == "alpha-002" and r.get("stage") == stage]

    def prereg(self, *extra, cmd="python -m thing", cwd=None):
        import preregister as PR
        return PR.main(["--desk", "lab/alpha", "--run", "alpha-002", "--mechanic", "M1",
                        "--kind", "exploit", "--ancestor", "alpha-001",
                        "--variables", "window rolled", "--predict", "ann_pct=10..20",
                        "--cmd", cmd, "--window", WIN, "--allow-no-sha",
                        *(["--cwd", cwd] if cwd else []), *extra])

    def record(self, *extra):
        import record as R
        return R.main(["--desk", "lab/alpha", "--run", "alpha-002", "--verify", "v 5/5",
                       "--metric", "ann_pct=15", "--gate", "provenance=ok", "--gate", "window=ok",
                       "--gate", "verify=ok", "--gate", "scope=ok", *extra])

    # -- record.py
    def test_a_pinned_record_writes_pin_equal_to_sha256(self):
        f = self.fake()
        self.assertEqual(self.prereg(), 0)
        self.assertEqual(self.record("--input", CANDLE_SPEC, "--input", FUNDING_SPEC), 0)
        fp = self.rows("result")[0]["fingerprint"]
        self.assertEqual([(i["pin"], i["sha256"]) for i in fp["inputs"]],
                         [(CANDLE_SHA, CANDLE_SHA), (FUNDING_SHA, FUNDING_SHA)])
        self.assertFalse(any("pin_error" in i for i in fp["inputs"]))
        self.assertEqual(fp["digest"], WINDOW_DIGEST)
        self.assertEqual({(c["reason"], c["ref"]) for c in f.calls},
                         {("result", "lab/alpha:alpha-002")})

    def test_a_mismatched_pin_refuses_the_record_and_writes_nothing(self):
        self.fake("mismatch")
        self.assertEqual(self.prereg(), 0)
        before = (self.root / "lab" / "alpha" / "results-log.md").read_text(encoding="utf-8")
        self.assertEqual(self.record("--input", CANDLE_SPEC), 1)
        self.assertEqual(self.rows("result"), [])
        self.assertEqual((self.root / "lab" / "alpha" / "results-log.md").read_text(
            encoding="utf-8"), before)

    def test_no_pin_api_records_honestly_unpinned(self):
        self.no_api()
        self.assertEqual(self.prereg(), 0)
        self.assertEqual(self.record("--input", CANDLE_SPEC), 0)
        i = self.rows("result")[0]["fingerprint"]["inputs"][0]
        self.assertIsNone(i["pin"])
        self.assertEqual(i["pin_error"], "fund_db has no pin API yet (B-0324)")
        self.assertEqual(i["sha256"], CANDLE_SHA)

    def test_no_pin_opts_out_and_says_so(self):
        f = self.fake()
        self.assertEqual(self.prereg(), 0)
        self.assertEqual(self.record("--input", CANDLE_SPEC, "--no-pin"), 0)
        fp = self.rows("result")[0]["fingerprint"]
        self.assertIs(fp["pin_skipped"], True)
        self.assertNotIn("pin", fp["inputs"][0])
        self.assertEqual(f.calls, [])

    def test_a_dry_record_never_pins(self):
        f = self.fake()
        self.assertEqual(self.prereg(), 0)
        self.assertEqual(self.record("--input", CANDLE_SPEC, "--dry"), 0)
        self.assertEqual(f.calls, [])

    # -- preregister.py
    def test_preregister_input_pins_the_window_as_it_stands(self):
        f = self.fake()
        self.assertEqual(self.prereg("--input", CANDLE_SPEC), 0)
        fp = self.rows("preflight")[0]["fingerprint"]
        self.assertEqual(fp["inputs"][0]["pin"], CANDLE_SHA)
        self.assertEqual(fp["window"], {"from": FRM, "to": TO})
        self.assertEqual([(c["reason"], c["ref"]) for c in f.calls],
                         [("preflight", "lab/alpha:alpha-002:preflight")])

    def test_preregister_without_input_is_unchanged(self):
        f = self.fake()
        self.assertEqual(self.prereg(), 0)
        self.assertNotIn("fingerprint", self.rows("preflight")[0])
        self.assertEqual(f.calls, [])

    def test_preregister_refuses_a_bad_spec_and_a_mismatch_before_it_commits(self):
        self.fake("mismatch")
        self.assertEqual(self.prereg("--input", "exchange_a:BTC"), 1)
        self.assertEqual(self.prereg("--input", CANDLE_SPEC), 1)
        self.assertEqual(self.rows("preflight"), [])

    # -- remeasure.py
    def read(self, *extra, mode="honest"):
        import remeasure as RM
        import _common as C
        f = self.fake(mode)
        desk = C.resolve_desk("lab/alpha")
        rows = C.read_jsonl(desk.runs)
        old = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 8 * 86400))
        for r in rows:
            if r.get("run") == "alpha-002" and r.get("stage") == "result":
                r["ts"] = old
        C.write_text(desk.runs, "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))
        RM.main(["--desk", "lab/alpha", "--run", "alpha-002", "--age", "7d", "--window", WIN,
                 *extra])
        reads = self.rows("read")
        self.assertEqual(len(reads), 1, "the read was not written")
        return reads[0], f

    def recorded(self):
        self.no_api()     # the result unpinned; the read below fakes its own API
        self.assertEqual(self.prereg(cmd=f"{sys.executable} -c print(1)", cwd=str(self.tmp)), 0)
        self.assertEqual(self.record("--input", CANDLE_SPEC), 0)
        mock.patch.stopall()
        self.reload()

    def test_a_read_pins_what_it_read(self):
        self.recorded()
        row, f = self.read()
        self.assertEqual(row["fingerprint"]["inputs"][0]["pin"], CANDLE_SHA)
        self.assertEqual([(c["reason"], c["ref"]) for c in f.calls],
                         [("read-7d", "lab/alpha:alpha-002:7d")])

    def test_a_mismatched_read_pin_is_a_fingerprint_error_not_a_lost_read(self):
        self.recorded()
        row, _ = self.read(mode="mismatch")
        self.assertNotIn("fingerprint", row)
        self.assertIn("does not match its fingerprint", row["fingerprint_error"])

    def test_a_read_with_no_pin(self):
        self.recorded()
        row, f = self.read("--no-pin")
        self.assertIs(row["fingerprint"]["pin_skipped"], True)
        self.assertEqual(f.calls, [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
