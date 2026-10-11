#!/usr/bin/env python3
"""Tests for the snapshot store (app/loop/tools/snapshots.py): the fund_db lake's `snapshots`
dataset, one log per desk.

Run:  .venv/Scripts/python.exe app/loop/tools/tests/test_snapshots.py
      (git; no network; a temp FUND_ROOT, and a THROWAWAY PostgreSQL + data root -
      app/tools/_pgtest.py - never the real ops store or lake)

What matters here is that no ROW IS LOST on the way into the lake: the retired file store, the
working-tree inbox and the file as git last held it are all merged, twice is the same as once,
and a source is retired (the file store MOVED to _retired, the inbox removed) only when every one
of its rows reads back from the lake.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOOP = HERE.parent
TOOLS = LOOP.parent.parent / "tools"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(TOOLS))

import _pgtest  # noqa: E402
import fixtures  # noqa: E402


def load():
    spec = importlib.util.spec_from_file_location("snapshots_under_test", LOOP / "snapshots.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def row(value, ts="2026-09-21T16:29:04Z", subject="exchange_c", field="funding_rows", **kw):
    o = {"ts": ts, "desk": "lab/venues/exchange_c", "subject": subject, "source": "s",
         "field": field, "value": value, "unit": "count", "provenance": "[API]"}
    o.update(kw)
    return o


class Base(unittest.TestCase):
    def setUp(self):
        if not _pgtest.available():
            self.skipTest(_pgtest.SKIP)
        self.root = Path(tempfile.mkdtemp(prefix="snaptest-"))
        self.old = Path(tempfile.mkdtemp(prefix="snapstore-"))      # the retired file store
        (self.root / "lab" / "venues" / "exchange_c" / "data").mkdir(parents=True)
        (self.root / "lab" / "venues" / "exchange_c" / "cadence.md").write_text("x\n", encoding="utf-8")
        (self.root / "lab" / "vol" / "data").mkdir(parents=True)
        (self.root / "lab" / "vol" / "cadence.md").write_text("x\n", encoding="utf-8")
        self._env = {k: os.environ.get(k) for k in
                     ("FUND_ROOT", "FUND_SNAPSHOTS_DIR", "FUND_DATA_DIR", "FUND_DB_DSN", "FUND_DB_DIR")}
        self.db = _pgtest.fresh()
        os.environ.update(self.db)
        os.environ["FUND_ROOT"] = str(self.root)
        os.environ["FUND_SNAPSHOTS_DIR"] = str(self.old)
        os.environ.pop("FUND_DATA_DIR", None)
        from fund_db import db as dbmod
        dbmod.close_shared()
        self.S = load()

    def tearDown(self):
        _pgtest.forget(self.db)
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        fixtures.rmtree(self.root)
        fixtures.rmtree(self.old)

    def legacy(self, desk="venues/exchange_c"):
        return self.root / "lab" / Path(*desk.split("/")) / "data" / "snapshots.jsonl"

    def old_file(self, desk="venues/exchange_c"):
        return self.old.joinpath(*desk.split("/")).with_suffix(".jsonl")

    def stored(self, desk="venues/exchange_c"):
        """What the lake holds for the desk, read straight from fund_db (no migration first)."""
        return self.S._stored(desk)

    def git_init(self):
        """The temp root as its own repo (never the real fund's)."""
        fixtures.git(self.root, "init", "-q")
        for k, v in (("user.name", "fixture"), ("user.email", "fixture@localhost"),
                     ("core.autocrlf", "false"), ("core.hooksPath", ".git/no-hooks"),
                     ("commit.gpgsign", "false")):
            fixtures.git(self.root, "config", k, v)


class TestWhere(Base):
    def test_the_rows_live_in_the_lake_and_the_old_store_rule_still_names_its_folder(self):
        self.assertIn("snapshots", self.S.where())
        self.assertIn(str(Path(self.db["FUND_DB_DIR"]).resolve()), str(Path(self.S.where().rsplit(": ", 1)[-1]).resolve()))
        self.assertEqual(self.S.legacy_store_dir(), self.old.resolve())

    def test_every_desk_spelling_is_one_log(self):
        for spelling in ("lab/venues/exchange_c", "venues/exchange_c", "lab\\venues\\exchange_c",
                         "lab/api/data/venues/exchange_c", "desks/api/data/venues/exchange_c"):
            self.assertEqual(self.S.desk_key(spelling), "venues/exchange_c", spelling)
        for bad in ("", "lab/", "../etc", "venues/../../x"):
            with self.assertRaises(ValueError, msg=bad):
                self.S.desk_key(bad)


class TestAppend(Base):
    def test_incomplete_rows_are_dropped_and_ts_desk_filled(self):
        r = row(1)
        del r["ts"], r["desk"]
        bad = dict(r)
        del bad["provenance"]
        n = self.S.append("venues/exchange_c", [r, bad])
        self.assertEqual(n, 1)
        got = self.stored()
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["desk"], "lab/venues/exchange_c")
        self.assertTrue(got[0]["ts"].endswith("Z"))
        self.assertIsInstance(got[0]["value"], int, "an integer reading comes back an integer")
        self.assertFalse(self.legacy().exists(), "nothing is written into the tree")
        self.assertEqual(list(self.old.rglob("*")), [], "nothing is written to the old file store")

    def test_concurrent_writers_lose_nothing(self):
        script = (
            "import importlib.util, sys\n"
            f"s = importlib.util.spec_from_file_location('m', r'{LOOP / 'snapshots.py'}')\n"
            "m = importlib.util.module_from_spec(s); s.loader.exec_module(m)\n"
            "for i in range(10):\n"
            "    m.append('venues/exchange_c', [{'subject': sys.argv[1], 'source': 's', "
            "'field': 'f', 'value': i, 'unit': 'count', 'provenance': '[API]'}])\n")
        procs = [subprocess.Popen([sys.executable, "-c", script, f"W{k}"]) for k in range(4)]
        for p in procs:
            self.assertEqual(p.wait(timeout=240), 0)
        got = self.stored()
        self.assertEqual(sorted({(o["subject"], o["value"]) for o in got}),
                         sorted((f"W{k}", i) for k in range(4) for i in range(10)))
        self.assertEqual(len(got), 40)


class TestMigration(Base):
    def test_the_old_file_store_is_merged_then_moved_to_retired(self):
        f = self.old_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(row(471)) + "\n" + json.dumps(row(470, ts="2026-09-22T00:00:00Z")) + "\n",
                     encoding="utf-8")
        rep = self.S.migrate("venues/exchange_c")
        self.assertEqual(rep["store_rows"], 2)
        self.assertFalse(f.exists(), "a verified file store leaves")
        moved = Path(rep["store_retired"])
        self.assertTrue(moved.is_file() and "_retired" in moved.parts, moved)
        self.assertEqual([o["value"] for o in self.stored()], [471, 470])

    def test_a_row_the_lake_cannot_hold_keeps_its_file_where_it_is(self):
        f = self.old_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(row(471)) + "\nnot json at all\n", encoding="utf-8")
        rep = self.S.migrate("venues/exchange_c")
        self.assertEqual((rep["store_rows"], rep["bad_lines"]), (1, 1))
        self.assertTrue(f.exists(), "a line it cannot carry keeps the whole file where it is")
        self.assertIsNone(rep["store_retired"])

    def test_disk_inbox_is_merged_then_removed(self):
        rows = [row(471), row(470, ts="2026-09-22T00:00:00Z")]
        self.legacy().write_text(
            "\n".join(json.dumps(r, indent=None, separators=(", ", ": ")) for r in rows) + "\n",
            encoding="utf-8")
        rep = self.S.migrate("venues/exchange_c")
        self.assertEqual(rep["disk_rows"], 2)
        self.assertTrue(rep["legacy_removed"])
        self.assertEqual([o["value"] for o in self.stored()], [471, 470])
        # a hand that still appends to the old path by an old doc: the inbox
        self.legacy().write_text(json.dumps(row(470, ts="2026-09-22T00:00:00Z")) + "\n"
                                 + json.dumps(row(469, ts="2026-09-23T00:00:00Z")) + "\n",
                                 encoding="utf-8")
        rep = self.S.migrate("venues/exchange_c")
        self.assertEqual(rep["disk_rows"], 1, "a row already stored is not stored twice")
        self.assertEqual([o["value"] for o in self.stored()], [471, 470, 469])
        rep = self.S.migrate("venues/exchange_c")
        self.assertEqual((rep["disk_rows"], rep["git_rows"], rep["store_rows"]), (0, 0, 0), "idempotent")

    def test_git_history_is_merged_for_a_clone_whose_pull_deleted_the_file(self):
        self.git_init()
        self.legacy().write_text(json.dumps(row(471)) + "\n", encoding="utf-8")
        fixtures.git(self.root, "add", "--", "lab/venues/exchange_c/data/snapshots.jsonl")
        fixtures.git(self.root, "commit", "-q", "-m", "history")
        fixtures.git(self.root, "rm", "-q", "--", "lab/venues/exchange_c/data/snapshots.jsonl")
        fixtures.git(self.root, "commit", "-q", "-m", "untrack")
        self.assertFalse(self.legacy().exists())
        rep = self.S.migrate("venues/exchange_c")
        self.assertEqual(rep["git_rows"], 1)
        self.assertEqual([o["value"] for o in self.stored()], [471])
        rep = self.S.migrate("venues/exchange_c")
        self.assertEqual(rep["git_rows"], 0, "the git pass runs once per desk per process")

    def test_git_and_disk_overlap_adds_each_row_once(self):
        self.git_init()
        self.legacy().write_text(json.dumps(row(471)) + "\n", encoding="utf-8")
        fixtures.git(self.root, "add", "--", "lab/venues/exchange_c/data/snapshots.jsonl")
        fixtures.git(self.root, "commit", "-q", "-m", "history")
        with open(self.legacy(), "a", encoding="utf-8") as f:      # uncommitted probe rows
            f.write(json.dumps(row(470, ts="2026-09-22T00:00:00Z")) + "\n")
        self.S.migrate("venues/exchange_c")
        self.assertEqual([o["value"] for o in self.stored()], [471, 470])

    def test_dry_touches_nothing(self):
        self.legacy().write_text(json.dumps(row(471)) + "\n", encoding="utf-8")
        rep = self.S.migrate("venues/exchange_c", dry=True)
        self.assertEqual(rep["disk_rows"], 1)
        self.assertTrue(self.legacy().exists())
        self.assertEqual(self.stored(), [])

    def test_desks_are_found_where_the_lab_is_on_disk(self):
        # the 2026-09-25 relayout moved lab/ to platform/lab: a desk there is a desk (the id stays
        # the logical lab/<key>); until 2026-09-26 this looked under <fund>/lab only and refused all
        desk = self.root / "platform" / "lab" / "venues" / "exchange_b"
        desk.mkdir(parents=True)
        (desk / "cadence.md").write_text("x\n", encoding="utf-8")
        self.assertEqual(self.S.lab_desks(self.root), ["venues/exchange_b"])
        self.assertTrue(self.S.desk_exists("lab/venues/exchange_b", self.root))
        self.assertFalse(self.S.desk_exists("lab/venues/exchange_c", self.root))   # only the old home has it
        self.assertEqual(self.S.legacy_path("venues/exchange_b", self.root),
                         desk / "data" / "snapshots.jsonl")

    def test_migrate_all_walks_lab_and_the_old_store(self):
        self.legacy().write_text(json.dumps(row(471)) + "\n", encoding="utf-8")
        f = self.old_file("platform/data")
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(row(5, desk="lab/platform/data")) + "\n", encoding="utf-8")
        reps = {r["desk"]: r for r in self.S.migrate_all()}
        self.assertEqual(set(reps), {"venues/exchange_c", "vol", "platform/data"})
        self.assertEqual([o["value"] for o in self.stored("platform/data")], [5])


class TestRead(Base):
    def test_latest_is_by_ts_not_arrival(self):
        self.S.append("venues/exchange_c", [row(469, ts="2026-09-23T00:00:00Z")])
        # an older row merged in later (a migration) must not win
        self.legacy().write_text(json.dumps(row(471)) + "\n", encoding="utf-8")
        self.assertEqual(self.S.latest("venues/exchange_c", "exchange_c", "funding_rows")["value"], 469)
        self.assertIsNone(self.S.latest("venues/exchange_c", "exchange_c", "nope"))

    def test_desk_snapshot_rows_in_common_read_the_lake(self):
        spec = importlib.util.spec_from_file_location("common_under_test", LOOP / "_common.py")
        C = importlib.util.module_from_spec(spec)
        sys.modules["common_under_test"] = C          # @dataclass looks its module up
        try:
            spec.loader.exec_module(C)
        finally:
            sys.modules.pop("common_under_test", None)
        d = C.Desk(self.root, "lab/venues/exchange_c")
        self.assertIn("venues/exchange_c", d.snapshots)
        self.S.append("venues/exchange_c", [row(1)])
        self.assertEqual([o["value"] for o in d.snapshot_rows()], [1])


class TestCli(Base):
    def run_cli(self, *args):
        p = subprocess.run([sys.executable, str(LOOP / "snapshots.py"), *args],
                           capture_output=True, text=True, encoding="utf-8", timeout=120)
        return p.returncode, p.stdout + p.stderr

    def test_append_show_and_refusals(self):
        rc, out = self.run_cli("append", "--desk", "vol", "--subject", "BTC", "--source",
                               "src", "--field", "atm_iv", "--value", "36.8", "--unit",
                               "pct_ann", "--provenance", "[API]")
        self.assertEqual(rc, 0, out)
        got = self.stored("vol")
        self.assertEqual(got[0]["value"], 36.8, "numbers are numbers, not strings")
        rc, out = self.run_cli("append", "--desk", "vol", "--subject", "BTC", "--source",
                               "src", "--field", "atm_iv", "--value", "1", "--unit",
                               "percent", "--provenance", "[API]")
        self.assertEqual(rc, 1, "an unknown unit is refused")
        rc, out = self.run_cli("append", "--desk", "vol", "--subject", "BTC", "--field", "x",
                               "--value", "1", "--unit", "count")
        self.assertEqual(rc, 1, "a row without source/provenance is refused")
        rc, out = self.run_cli("append", "--desk", "nosuch", "--subject", "BTC", "--source",
                               "s", "--field", "x", "--value", "1", "--unit", "count",
                               "--provenance", "[API]")
        self.assertEqual(rc, 1, "a desk with no lab/ folder is refused")
        rc, out = self.run_cli("show", "--desk", "vol", "--field", "atm_iv")
        self.assertEqual(rc, 0)
        self.assertIn("36.8", out)
        rc, out = self.run_cli("where")
        self.assertEqual(rc, 0)
        self.assertIn("snapshots", out)


if __name__ == "__main__":
    unittest.main(verbosity=1)
