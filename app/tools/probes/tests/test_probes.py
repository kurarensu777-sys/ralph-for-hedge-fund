#!/usr/bin/env python3
"""Tests for the probe harness, staleness, the sweep and the git probe.

Run:  .venv/Scripts/python.exe app/tools/probes/tests/test_probes.py
      (no network; everything happens in a temp FUND_ROOT, and the readings and
      snapshots in a THROWAWAY PostgreSQL + data root - app/tools/_pgtest.py -
      never the real ops store or lake)

The load-bearing tests here are the ones about ABSENCE, because absence is what
killed the agency's measurement loop:

  * a probe that never recorded a reading renders `unknown - never reported`;
  * a probe whose reading is older than its window renders `stale`, whatever the
    reading says;
  * a probe body that raises writes `unknown` and never `ok`;
  * a probe body that hangs is killed by its own watchdog and leaves a RED row,
    not yesterday's green one.

and one about the opposite: the ALL-FRESH render, forced, so the clean surface
is not making its debut on the first day everything works.
"""

from __future__ import annotations

import importlib
import io
import json
import os
import contextlib
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROBES = HERE.parent
ROOT = PROBES.parent.parent
sys.path.insert(0, str(PROBES))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(PROBES.parent))          # app/tools: _pgtest

import _pgtest  # noqa: E402


def fixture_specs(P) -> dict:
    """Two probes that exist only in these tests: `offline` (no network) and `selftest` (networked),
    both filing snapshots under lab/platform/data. The harness and staleness are tested on them, so
    the tests do not depend on which real probes ship."""
    return {
        "offline": P.Spec("offline", "a fixture probe, offline", "lab/platform/data", "lab/platform/data",
                          26 * 3600, 300, False, "tests only"),
        "selftest": P.Spec("selftest", "a fixture probe, networked", "lab/platform/data", "lab/platform/data",
                           26 * 3600, 900, True, "tests only"),
    }


FIXTURE_INJECT = (
    "import _probe as P\n"
    "P.REGISTRY.update({'offline': P.Spec('offline', 'a fixture probe, offline', 'lab/platform/data', "
    "'lab/platform/data', 26 * 3600, 300, False, 'tests only')})\n")


class Base(unittest.TestCase):
    STORE = False            # a class whose tests read or write readings / snapshots sets True
    FIXTURES = True          # add the two fixture probes to the registry (TestRunAll does not: it runs files)

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="probetest-"))
        (self.root / "floor").mkdir(parents=True)
        (self.root / "lab").mkdir()
        os.environ["FUND_ROOT"] = str(self.root)
        os.environ["FUND_FLOOR"] = str(self.root / "floor")
        # the old file store must never be read by a test either
        os.environ["FUND_SNAPSHOTS_DIR"] = str(self.root / "old-snapstore")
        self.env = None
        if self.STORE:
            if not _pgtest.available():
                self.skipTest(_pgtest.SKIP)
            self.env = _pgtest.fresh()          # a throwaway ops store + an empty data root
            os.environ.update(self.env)
            from fund_db import db as dbmod
            dbmod.close_shared()
        import _probe
        importlib.reload(_probe)
        self.P = _probe
        if self.FIXTURES:
            _probe.REGISTRY.update(fixture_specs(_probe))

    def tearDown(self):
        if self.env:
            _pgtest.forget(self.env)
            for k in self.env:
                os.environ.pop(k, None)
        os.environ.pop("FUND_ROOT", None)
        os.environ.pop("FUND_FLOOR", None)
        os.environ.pop("FUND_SNAPSHOTS_DIR", None)
        shutil.rmtree(self.root, ignore_errors=True)

    def health(self, pid):
        """The probe's newest reading in the ops store (the health object), or None."""
        return self.P.latest_readings().get(pid)

    def snaps(self, desk="lab/platform/data"):
        return self.P.STORE.read(desk, self.root)

    def run_probe(self, pid, body, argv=None):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.P.main(pid, body, argv or [])
        return rc, buf.getvalue()


# ------------------------------------------------------------ the harness --
class TestHarness(Base):
    STORE = True

    def test_ok_writes_the_agreed_shape(self):
        def body(ctx):
            return self.P.Result("ok", "47/47 ok", "all good")
        rc, out = self.run_probe("offline", body)
        self.assertEqual(rc, 0)
        h = self.health("offline")
        for k in ("id", "label", "owner", "status", "reading", "probed_ts",
                  "window_s", "detail"):
            self.assertIn(k, h, f"the cockpit's Health wall reads {k}")
        self.assertEqual(h["status"], "ok")
        self.assertEqual(h["owner"], self.P.REGISTRY["offline"].owner)

    def test_fail_exits_one(self):
        rc, _ = self.run_probe("offline", lambda c: self.P.Result("fail", "2 FAILED"))
        self.assertEqual(rc, 1)
        self.assertEqual(self.health("offline")["status"], "fail")

    def test_a_raising_body_is_unknown_not_ok_and_still_writes(self):
        def body(ctx):
            raise RuntimeError("the venue went away")
        rc, _ = self.run_probe("offline", body)
        self.assertEqual(rc, 2, "a probe that could not run is unknown, never fail, never ok")
        h = self.health("offline")
        self.assertEqual(h["status"], "unknown")
        self.assertIn("RuntimeError", h["reading"] + h["detail"])

    def test_the_watchdog_makes_a_hang_red(self):
        # Shorten this probe's own timeout, then hang past it. The watchdog runs
        # in a subprocess because it terminates the process on purpose.
        import subprocess
        script = (
            "import sys, time, os\n"
            f"sys.path.insert(0, r'{PROBES}')\n"
            + FIXTURE_INJECT +
            "s = P.REGISTRY['offline']\n"
            "P.REGISTRY['offline'] = P.Spec(s.id, s.label, s.owner, s.desk, s.window_s, "
            "1, s.network, s.note)\n"
            "sys.exit(P.main('offline', lambda c: time.sleep(30), []))\n")
        env = dict(os.environ, FUND_ROOT=str(self.root))
        p = subprocess.run([sys.executable, "-c", script], capture_output=True,
                           text=True, timeout=60, env=env)
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        h = self.health("offline")
        self.assertEqual(h["status"], "fail")
        self.assertIn("timed out", h["reading"])

    def test_dry_touches_nothing(self):
        rc, out = self.run_probe("offline", lambda c: self.P.Result("ok", "x"), ["--dry"])
        self.assertEqual(rc, 0)
        self.assertIsNone(self.health("offline"))
        self.assertIn("DRY", out)

    def test_snapshots_need_a_desk_and_every_required_field(self):
        desk = self.root / "lab" / "platform" / "data" / "data"
        desk.mkdir(parents=True)

        def body(ctx):
            r = self.P.Result("ok", "x")
            r.snap("BTC", "src", "funding_rows", 719, "count", "[API]")
            r.snapshots.append({"subject": "BTC", "source": "src", "field": "f",
                                "value": 1, "unit": "count"})         # no provenance
            return r
        self.run_probe("offline", body)
        rows = self.snaps()
        self.assertEqual(len(rows), 1, "an incomplete row is a gap; a guessed one is a lie")
        self.assertEqual(rows[0]["unit"], "count")
        self.assertEqual(rows[0]["desk"], "lab/platform/data")
        self.assertTrue(rows[0]["ts"].endswith("Z"))

    def test_a_sweep_never_writes_into_the_tree(self):
        """The defect this store exists for: every sweep used to append to the
        TRACKED lab/<desk>/data/snapshots.jsonl and leave the repo dirty."""
        (self.root / "lab" / "platform" / "data" / "data").mkdir(parents=True)

        def body(ctx):
            r = self.P.Result("ok", "x")
            r.snap("BTC", "src", "funding_rows", 719, "count", "[API]")
            return r
        self.run_probe("offline", body)
        in_tree = [p for p in (self.root / "lab").rglob("*") if p.is_file()]
        self.assertEqual(in_tree, [], "a probe tick wrote into lab/")
        self.assertEqual([r["value"] for r in self.snaps()], [719], "the row is in the lake")
        self.assertEqual([p for p in (self.root / "floor").rglob("*") if p.is_file()], [],
                         "the reading is a row of the ops store, never a floor file")

    def test_the_tracked_history_is_merged_in_before_the_first_new_row(self):
        d = self.root / "lab" / "platform" / "data" / "data"
        d.mkdir(parents=True)
        old = {"ts": "2026-09-21T16:29:04Z", "desk": "lab/platform/data", "subject": "exchange_c",
               "source": "s", "field": "funding_rows", "value": 471, "unit": "count",
               "provenance": "[API]"}
        (d / "snapshots.jsonl").write_text(json.dumps(old) + "\n", encoding="utf-8")

        def body(ctx):
            r = self.P.Result("ok", "x")
            r.snap("exchange_c", "s", "funding_rows", 470, "count", "[API]")
            return r
        self.run_probe("offline", body)
        vals = [o["value"] for o in self.snaps()]
        self.assertEqual(vals, [471, 470], "the old row first, then the new one")
        self.assertFalse((d / "snapshots.jsonl").exists(),
                         "the legacy file is removed once every row is in the store")

    def test_a_snapshot_for_a_desk_that_does_not_exist_is_dropped_not_crashed(self):
        def body(ctx):
            r = self.P.Result("ok", "x")
            r.snap("BTC", "src", "f", 1, "count", "[API]")
            return r
        rc, _ = self.run_probe("offline", body)
        self.assertEqual(rc, 0, "a desk track A has not written yet is not an error")
        self.assertEqual(self.snaps(), [])

    def test_json_mode(self):
        rc, out = self.run_probe("offline", lambda c: self.P.Result("ok", "47/47"), ["--json"])
        self.assertEqual(json.loads(out)["reading"], "47/47")


# -------------------------------------------------------------- staleness --
class TestStaleness(Base):
    STORE = True

    def rows(self):
        import staleness
        importlib.reload(staleness)
        return {r["id"]: r for r in staleness.rows(self.root)}, staleness

    def write(self, pid, status, age_s, window_s=3600):
        self.P.record_health({"id": pid, "label": pid, "owner": ".", "status": status, "reading": "r",
                              "probed_ts": int(time.time() - age_s), "window_s": window_s, "detail": ""})

    def test_a_probe_that_never_reported_is_named(self):
        rows, _ = self.rows()
        self.assertEqual(rows["selftest"]["effective"], "unknown")
        self.assertEqual(rows["selftest"]["reading"], "never reported")

    def test_the_sweep_itself_is_expected(self):
        rows, _ = self.rows()
        self.assertIn("probe-sweep", rows,
                      "'the thing that runs the probes stopped' must be its own row")

    def test_an_old_green_reading_renders_stale(self):
        self.write("offline", "ok", age_s=7200, window_s=3600)
        rows, _ = self.rows()
        self.assertEqual(rows["offline"]["effective"], "stale")
        self.assertEqual(rows["offline"]["status"], "ok",
                         "the reading is untouched - only the RENDER changes")

    def test_a_fresh_green_reading_is_ok(self):
        self.write("offline", "ok", age_s=10, window_s=3600)
        rows, _ = self.rows()
        self.assertEqual(rows["offline"]["effective"], "ok")

    def test_it_never_rewrites_a_probes_reading(self):
        from fund_db import ops
        self.write("offline", "ok", age_s=7200, window_s=3600)
        before = ops.health_history("system:offline")
        self.rows()
        self.assertEqual(ops.health_history("system:offline"), before,
                         "overwriting the reading would destroy the date of the silence")

    def schedule(self, *jobs):
        """app/schedule.json in the temp fund: (id, health, enabled) per job"""
        f = self.root / "app" / "schedule.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"version": 2, "jobs": [{"id": i, "kind": "script", "cadence": "every 1h", "cwd": ".",
                                                         "cmd": ["x"], "health": h, "enabled": e} for i, h, e in jobs]}),
                     encoding="utf-8")

    def test_a_recorded_job_row_is_judged_on_its_own_window(self):
        self.schedule(("sweep-xyz", True, True))
        self.write("sweep-xyz", "ok", age_s=10, window_s=5)
        rows, _ = self.rows()
        self.assertEqual(rows["sweep-xyz"]["effective"], "stale")
        self.assertFalse(rows["sweep-xyz"]["expected"])

    def test_the_budget_meter_is_judged_without_a_health_job(self):
        self.write("budget", "ok", age_s=10, window_s=5)
        rows, _ = self.rows()
        self.assertEqual(rows["budget"]["effective"], "stale")

    def test_an_orphan_is_named_and_never_reddens(self):
        # the 2026-09-27 red: data-refresh / data-probe, left in the store when their writer moved
        self.fresh_all()
        self.schedule(("nightly-job", True, True), ("data-refresh", False, True), ("old-job", True, False))
        self.write("data-refresh", "ok", age_s=34 * 3600, window_s=93600)
        self.write("data-probe", "fail", age_s=34 * 3600, window_s=93600)
        self.write("old-job", "fail", age_s=5, window_s=3600)       # disabled: nothing records it now
        rows, _ = self.rows()
        for pid in ("data-refresh", "data-probe", "old-job"):
            self.assertEqual(rows[pid]["effective"], "orphan", pid)
        self.assertEqual(self.main_rc(), 0, "an orphan is named, never judged stale or red")
        from fund_db import ops
        self.assertTrue(ops.health_history("system:data-probe"), "the orphan's row stays in the store")

    def test_a_registry_probe_gone_silent_is_still_red(self):
        import _probe
        for pid in [p for p in _probe.REGISTRY if p != "selftest"] + [_probe.SWEEP.id]:
            self.write(pid, "ok", age_s=5, window_s=86400)
        self.write("selftest", "ok", age_s=200000, window_s=86400)
        self.assertEqual(self.main_rc(), 1, "an expected probe that stopped writing is silence")

    def test_a_status_outside_the_grammar_renders_unknown_not_a_crash(self):
        self.write("scheduler", "warn", age_s=10, window_s=3600)
        rows, staleness = self.rows()
        self.assertEqual(rows["scheduler"]["effective"], "unknown")
        self.assertEqual(rows["scheduler"]["status"], "warn")
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(staleness.main([]), 1)

    def test_the_all_fresh_render_exists_and_exits_zero(self):
        # FORCE the success path: every expected probe fresh and green.
        import _probe
        for pid in list(_probe.REGISTRY) + [_probe.SWEEP.id]:
            self.write(pid, "ok", age_s=5, window_s=86400)
        import staleness
        importlib.reload(staleness)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = staleness.main([])
        self.assertEqual(rc, 0)
        self.assertIn("fresh and ok", buf.getvalue())
        self.assertNotIn("STALE", buf.getvalue())

    def fresh_all(self):
        import _probe
        for pid in list(_probe.REGISTRY) + [_probe.SWEEP.id]:
            self.write(pid, "ok", age_s=5, window_s=86400)

    def main_rc(self):
        import staleness
        importlib.reload(staleness)
        with contextlib.redirect_stdout(io.StringIO()):
            return staleness.main([])

    def test_its_own_red_row_does_not_keep_it_red(self):
        # the cascade of 2026-09-24/25: staleness fail -> scheduler tally fail -> staleness fail
        self.fresh_all()
        self.write("probe-staleness", "fail", age_s=5, window_s=36000)
        self.write("scheduler", "fail", age_s=5, window_s=180)
        self.assertEqual(self.main_rc(), 0)

    def test_the_scheduler_row_is_judged_on_silence(self):
        self.fresh_all()
        self.write("scheduler", "ok", age_s=900, window_s=180)
        self.assertEqual(self.main_rc(), 1, "a scheduler that stopped passing is silence")

    def test_a_real_red_row_is_still_red(self):
        self.fresh_all()
        self.write("selftest", "fail", age_s=5, window_s=86400)
        self.assertEqual(self.main_rc(), 1)

    def test_a_nag_is_amber_not_red(self):
        self.fresh_all()
        self.schedule(("retro-due", True, True), ("loop-pass", True, True))
        self.write("retro-due", "unknown", age_s=5, window_s=86400)
        self.write("loop-pass", "warn", age_s=5, window_s=86400)
        self.assertEqual(self.main_rc(), 2)

    def test_an_unreadable_store_is_said_on_every_row(self):
        import staleness
        importlib.reload(staleness)
        os.environ["FUND_DB_DSN"] = "host=127.0.0.1 port=1 user=fund dbname=nope"
        from fund_db import db as dbmod
        dbmod.close_shared()
        try:
            rows = {r["id"]: r for r in staleness.rows(self.root)}
        finally:
            os.environ["FUND_DB_DSN"] = self.env["FUND_DB_DSN"]
            dbmod.close_shared()
        self.assertEqual(rows["selftest"]["reading"], "the ops store is unreadable")
        self.assertEqual(rows["selftest"]["effective"], "unknown")

    def test_any_silence_exits_non_zero(self):
        import staleness
        importlib.reload(staleness)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(staleness.main([]), 1)


# ----------------------------------------------------------------- run_all -
class TestRunAll(Base):
    STORE = True
    FIXTURES = False

    def test_dry_lists_every_probe_and_writes_no_sweep_row(self):
        import run_all
        importlib.reload(run_all)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = run_all.main(["--dry", "--offline"])
        self.assertEqual(rc, 0)
        self.assertIsNone(self.health("probe-sweep"),
                          "--dry must not write the sweep's own health row either")
        out = buf.getvalue()
        for pid, spec in self.P.REGISTRY.items():
            if not spec.network:
                self.assertIn(pid, out)

    def test_an_unknown_probe_name_is_refused(self):
        import run_all
        importlib.reload(run_all)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(run_all.main(["--only", "nosuch"]), 2)

    def test_the_registry_and_the_files_agree(self):
        for pid in self.P.REGISTRY:
            self.assertTrue((PROBES / f"{pid}.py").is_file(),
                            f"REGISTRY names {pid} with no {pid}.py beside it")
        for f in PROBES.glob("*.py"):
            if f.stem.startswith("_") or f.stem in ("run_all", "staleness"):
                continue
            self.assertIn(f.stem, self.P.REGISTRY,
                          f"{f.name} exists but staleness.py would never expect it")


# -------------------------------------------------------------------- git --
class TestGitRepoSet(Base):
    def test_the_repo_set_is_repos_json(self):
        (self.root / "repos.json").write_text(json.dumps({"repos": [
            {"id": "fund", "path": "."}, {"id": "platform", "path": "platform"}]}),
            encoding="utf-8")
        import git as G
        importlib.reload(G)
        repos, note = G.repo_set(self.root)
        self.assertEqual(set(repos), {"fund", "platform"})
        self.assertEqual(repos["platform"], (self.root / "platform").resolve())
        self.assertEqual(note, "")

    def test_an_unreadable_repos_json_falls_back_and_says_so(self):
        import git as G
        importlib.reload(G)
        repos, note = G.repo_set(self.root)
        self.assertEqual(set(repos), {"fund"})
        self.assertIn("fallback", note)


if __name__ == "__main__":
    unittest.main(verbosity=2)
