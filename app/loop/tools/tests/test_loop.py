#!/usr/bin/env python3
"""Tests for the fixed-age loop tools, on the current layout (lab/, and the
code repos app/, platform/, research/ at the fund root).

Run:  .venv/Scripts/python.exe app/loop/tools/tests/test_loop.py
      (stdlib only; no network; nothing outside a temp directory is touched)

`audit.py` and its BROKEN fixture tree retired on 2026-09-24 (git history). The
refusals that bind - an after-the-fact pre-flight, a result with no pre-flight,
more than two variables, a point estimate, invented history - are the tools'
own, and they are tested here, together with the clean path.
"""

from __future__ import annotations

import importlib
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOOP = HERE.parent
ROOT = LOOP.parent.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(LOOP))
sys.path.insert(0, str(ROOT))

import fixtures  # noqa: E402


def fresh(fn) -> Path:
    d = Path(tempfile.mkdtemp(prefix="fundtest-"))
    fn(d)
    return d


class Base(unittest.TestCase):
    maker = staticmethod(fixtures.good)

    def setUp(self):
        self.root = fresh(self.maker)
        os.environ["FUND_ROOT"] = str(self.root)
        self._reload()

    def tearDown(self):
        os.environ.pop("FUND_ROOT", None)
        fixtures.rmtree(self.root)

    def _reload(self):
        for m in ("_common", "preregister", "record", "remeasure", "grade",
                  "retro_due", "digest", "backfill"):
            if m in sys.modules:
                importlib.reload(sys.modules[m])



# ------------------------------------------------------------- bands -------
class TestBands(Base):
    def test_forms(self):
        import _common as C
        for raw, lo, hi in [("10 to 20", 10, 20), ("20..30", 20, 30), ("-6 to -2", -6, -2),
                            (">= 0", 0, None), ("<= 5", None, 5), ("0", 0, 0)]:
            b = C.parse_band(raw)
            self.assertEqual((b.lo, b.hi), (lo, hi), raw)

    def test_a_float_point_estimate_is_refused(self):
        import _common as C
        with self.assertRaises(C.Refuse):
            C.parse_band("26.40")

    def test_containment(self):
        import _common as C
        b = C.parse_band("10 to 20")
        self.assertTrue(b.contains(10) and b.contains(20) and b.contains(15))
        self.assertFalse(b.contains(9.9) or b.contains(20.1))


# --------------------------------------------------------- preregister -----
class TestPreregister(Base):
    def args(self, **kw):
        base = dict(run="alpha-002", mechanic="M1", kind="exploit", ancestor="alpha-001",
                    variables=["window rolled"], predict=["ann_pct=10..20"],
                    cmd="python -m thing", window="2026-01-01T00:00:00Z..2026-03-01T00:00:00Z",
                    belief=["B1"])
        base.update(kw)
        argv = ["--desk", "lab/alpha", "--allow-no-sha"]
        for k, v in base.items():
            flag = "--" + k.replace("_", "-")
            for item in (v if isinstance(v, list) else [v]):
                argv += [flag, str(item)]
        return argv

    def call(self, argv):
        import preregister as PR
        importlib.reload(PR)
        return PR.main(argv)

    def test_a_good_preflight_is_written_to_both_files(self):
        self.assertEqual(self.call(self.args()), 0)
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        self.assertTrue(C.run_rows(desk, "alpha-002", "preflight"))
        self.assertIn("alpha-002", C.results_log(desk))
        self.assertIn("**Pre-flight:**", C.entry_block(C.results_log(desk), "alpha-002"))

    def test_after_the_fact_registration_is_refused(self):
        # alpha-001 already has a recorded result in the fixture
        self.assertEqual(self.call(self.args(run="alpha-001")), 1)

    def test_double_registration_is_refused(self):
        self.assertEqual(self.call(self.args()), 0)
        self.assertEqual(self.call(self.args()), 1)

    def test_three_variables_are_refused(self):
        self.assertEqual(self.call(self.args(variables=["a", "b", "c"])), 1)

    def test_an_unknown_mechanic_is_refused(self):
        self.assertEqual(self.call(self.args(mechanic="M99")), 1)

    def test_a_dangling_belief_is_refused(self):
        self.assertEqual(self.call(self.args(belief=["B7"])), 1)

    def test_a_fenced_example_belief_is_not_a_belief(self):
        import _common as C
        p = self.root / "lab" / "alpha" / "beliefs.md"
        p.write_text(p.read_text(encoding="utf-8") + "\n```\n### B7 · <the claim, in one sentence> - WEAK (<date>)\n```\n",
                     encoding="utf-8")
        found = C.beliefs(C.resolve_desk("lab/alpha"))
        self.assertIn("B1", found)
        self.assertNotIn("B7", found)
        self.assertEqual(self.call(self.args(belief=["B7"])), 1)

    def test_a_point_estimate_is_refused(self):
        self.assertEqual(self.call(self.args(predict=["ann_pct=26.4"])), 1)

    def test_a_missing_window_is_refused(self):
        self.assertEqual(self.call(self.args(window="")), 1)

    def test_an_unknown_ancestor_is_refused(self):
        self.assertEqual(self.call(self.args(ancestor="alpha-999")), 1)

    def test_an_explore_with_no_experiment_is_refused(self):
        self.assertEqual(self.call(self.args(kind="explore", experiment="NONE")), 1)

    def test_dry_writes_nothing(self):
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        before = C.read_text(desk.f("results-log.md"))
        self.assertEqual(self.call(self.args() + ["--dry"]), 0)
        self.assertEqual(C.read_text(desk.f("results-log.md")), before)


# -------------------------------------------------------------- record -----
class TestRecord(Base):
    def prereg(self):
        import preregister as PR
        importlib.reload(PR)
        return PR.main(["--desk", "lab/alpha", "--run", "alpha-002", "--mechanic", "M1",
                        "--kind", "exploit", "--ancestor", "alpha-001",
                        "--variables", "window rolled", "--predict", "ann_pct=10..20",
                        "--predict", "liquidations=0", "--cmd", "python -m thing",
                        "--window", "2026-01-01T00:00:00Z..2026-03-01T00:00:00Z",
                        "--allow-no-sha"])

    def rec(self, *extra):
        import record as R
        importlib.reload(R)
        return R.main(["--desk", "lab/alpha", "--run", "alpha-002",
                       "--verify", "v 5/5", "--metric", "ann_pct=15",
                       "--metric", "liquidations=0",
                       "--gate", "provenance=ok", "--gate", "window=ok",
                       "--gate", "verify=ok", "--gate", "scope=ok", *extra])

    def test_a_result_needs_a_preflight(self):
        self.assertEqual(self.rec(), 1)

    def test_record_then_refuse_a_second(self):
        self.assertEqual(self.prereg(), 0)
        self.assertEqual(self.rec(), 0)
        self.assertEqual(self.rec(), 1)

    def test_grading_is_written_into_the_row(self):
        self.prereg()
        self.rec()
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        row = C.run_rows(desk, "alpha-002", "result")[-1]
        self.assertEqual(row["graded"]["ann_pct"]["verdict"], "hit")
        self.assertEqual(row["graded"]["liquidations"]["verdict"], "hit")

    def test_an_out_of_band_metric_is_scored_over(self):
        self.prereg()
        import record as R
        importlib.reload(R)
        R.main(["--desk", "lab/alpha", "--run", "alpha-002", "--verify", "v 5/5",
                "--metric", "ann_pct=99", "--gate", "provenance=ok", "--gate", "window=ok",
                "--gate", "verify=ok", "--gate", "scope=ok"])
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        row = C.run_rows(desk, "alpha-002", "result")[-1]
        self.assertEqual(row["graded"]["ann_pct"]["verdict"], "over")

    def test_a_failing_verify_is_refused_unless_declared(self):
        self.prereg()
        import record as R
        importlib.reload(R)
        argv = ["--desk", "lab/alpha", "--run", "alpha-002", "--verify", "v 4/5",
                "--metric", "ann_pct=15", "--gate", "provenance=ok", "--gate", "window=ok",
                "--gate", "verify=ok", "--gate", "scope=ok"]
        self.assertEqual(R.main(argv), 1)
        self.assertEqual(R.main(argv + ["--verify-failed"]), 0)

    def test_an_unstated_gate_is_refused(self):
        self.prereg()
        import record as R
        importlib.reload(R)
        self.assertEqual(R.main(["--desk", "lab/alpha", "--run", "alpha-002",
                                 "--verify", "v 5/5", "--metric", "ann_pct=15",
                                 "--gate", "provenance=ok"]), 1)

    def test_the_ledger_gains_a_row_with_its_window(self):
        self.prereg()
        self.rec()
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        log = C.read_text(desk.f("results-log.md"))
        ledger = [ln for ln in log.splitlines() if ln.startswith("| alpha-002 ")]
        self.assertTrue(ledger, "no ledger row was appended")
        self.assertIn("2026-01-01T00:00:00Z", ledger[0])


# ------------------------------------------------------ pre-flight commit -----
def _real_head() -> str:
    import subprocess
    p = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(ROOT), capture_output=True,
                       text=True)
    return p.stdout.strip()


class TestPreflightCommit(Base):
    """B-0071: the pre-flight is its OWN commit, landed before the run, and record.py
    refuses anything else. Every repo here is a temp fixture repo; the real fund repo's
    HEAD is checked unchanged at the end of the class."""

    PATHS = ["lab/alpha/results-log.md", "lab/alpha/data/runs.jsonl"]
    prereg = TestRecord.prereg
    rec = TestRecord.rec

    @classmethod
    def setUpClass(cls):
        cls.real_head = _real_head()

    @classmethod
    def tearDownClass(cls):
        assert _real_head() == cls.real_head, "a test committed to the REAL fund repo"

    def setUp(self):
        self._agent = os.environ.pop("FUND_AGENT", None)
        super().setUp()

    def tearDown(self):
        super().tearDown()
        if self._agent is not None:
            os.environ["FUND_AGENT"] = self._agent
        else:
            os.environ.pop("FUND_AGENT", None)

    def git(self, *args):
        return fixtures.git(self.root, *args)

    def head(self):
        return self.git("rev-parse", "HEAD").strip()

    def files(self):
        return {p: (self.root / p).read_bytes() for p in self.PATHS}

    def write_uncommitted_preflight(self):
        """The shape vol-w01 had: a pre-flight on disk that no commit of its own proves."""
        import argparse
        import preregister as PR
        importlib.reload(PR)
        import _common as C
        importlib.reload(C)
        ns = argparse.Namespace(desk="lab/alpha", run="alpha-002", mechanic="M1",
                                kind="exploit", variant="", experiment="NONE",
                                ancestor="alpha-001", variables=["window rolled"],
                                predict=["ann_pct=10..20", "liquidations=0"], judge=[],
                                belief=[], cmd="python -m thing", cwd="platform",
                                window="2026-01-01T00:00:00Z..2026-03-01T00:00:00Z",
                                hours=0, regimes=0, comparator="", metric_pattern=[],
                                provenance="[API]", title="", note="", allow_no_sha=True)
        desk, row, block = PR.build(ns)
        C.append_entry(desk, block)
        C.append_jsonl(desk.runs, row)

    # --- preregister.py -------------------------------------------------
    def test_the_preflight_is_its_own_commit_with_the_agent_trailer(self):
        os.environ["FUND_AGENT"] = "tester"
        before = self.head()
        self.assertEqual(self.prereg(), 0)
        self.assertNotEqual(self.head(), before)
        self.assertEqual(self.git("rev-parse", "HEAD~1").strip(), before)
        self.assertEqual(self.git("log", "-1", "--format=%s").strip(),
                         "preregister lab/alpha alpha-002")
        self.assertIn("Agent: tester", self.git("log", "-1", "--format=%B"))
        changed = sorted(self.git("show", "--name-only", "--format=", "HEAD").split())
        self.assertEqual(changed, sorted(self.PATHS))
        self.assertEqual(self.git("status", "--porcelain", "--", *self.PATHS).strip(), "")
        self.assertIn('"run": "alpha-002"', self.git("show", "HEAD:lab/alpha/data/runs.jsonl"))

    def test_the_agent_defaults_to_you(self):
        self.assertEqual(self.prereg(), 0)
        self.assertIn("Agent: you", self.git("log", "-1", "--format=%B"))

    def test_a_dirty_ledger_is_refused_and_nothing_is_committed(self):
        p = self.root / "lab/alpha/results-log.md"
        p.write_text(p.read_text(encoding="utf-8") + "\nhand edit\n", encoding="utf-8")
        before, files = self.head(), self.files()
        self.assertEqual(self.prereg(), 1)
        self.assertEqual(self.head(), before)
        self.assertEqual(self.files(), files)

    def test_a_failed_commit_restores_both_files_and_registers_nothing(self):
        before, files = self.head(), self.files()
        lock = self.root / ".git" / "index.lock"
        lock.write_text("", encoding="utf-8")
        try:
            self.assertEqual(self.prereg(), 1)
        finally:
            lock.unlink()
        self.assertEqual(self.head(), before)
        self.assertEqual(self.files(), files)
        import _common as C
        importlib.reload(C)
        self.assertFalse(C.run_rows(C.resolve_desk("lab/alpha"), "alpha-002", "preflight"))
        self.assertEqual(self.prereg(), 0)       # and the retry is clean

    def test_a_root_inside_another_repo_is_refused(self):
        inner = self.root / "inner"
        fixtures.good(inner, git=False)
        os.environ["FUND_ROOT"] = str(inner)
        self._reload()
        before = self.head()
        self.assertEqual(self.prereg(), 1)
        self.assertEqual(self.head(), before)
        self.assertNotIn("alpha-002", (inner / "lab/alpha/data/runs.jsonl").read_text("utf-8"))

    # --- record.py ------------------------------------------------------
    def test_record_refuses_an_uncommitted_preflight(self):
        self.write_uncommitted_preflight()
        self.assertEqual(self.rec(), 1)
        # the same pre-flight, committed on its own, is accepted: the check is the commit
        self.git("commit", "-q", "-m", "preregister lab/alpha alpha-002", "--", *self.PATHS)
        self.assertEqual(self.rec(), 0)

    def test_record_refuses_a_preflight_landed_with_other_files(self):
        self.write_uncommitted_preflight()
        (self.root / "lab/alpha/menu.md").write_text("# Menu\n\nchanged\n", encoding="utf-8")
        self.git("commit", "-q", "-m", "pre-flight and more", "--", *self.PATHS,
                 "lab/alpha/menu.md")
        self.assertEqual(self.rec(), 1)

    def test_record_refuses_a_run_started_before_the_preflight_commit(self):
        import _common as C
        self.assertEqual(self.prereg(), 0)
        at = int(self.git("log", "-1", "--format=%at").strip())
        sha = self.head()
        self.assertEqual(self.rec("--ran", C.iso_of_epoch(at - 3600)), 1)
        self.assertEqual(self.rec("--ran", C.iso_of_epoch(at)), 0)
        importlib.reload(C)
        row = C.run_rows(C.resolve_desk("lab/alpha"), "alpha-002", "result")[-1]
        self.assertEqual(row["preflight_commit"], sha)
        self.assertEqual(row["ran"], C.iso_of_epoch(at))

    def test_a_future_ran_is_refused(self):
        import _common as C
        self.assertEqual(self.prereg(), 0)
        self.assertEqual(self.rec("--ran", C.iso_of_epoch(time.time() + 86400)), 1)

    def test_a_non_ascii_preflight_row_is_still_found(self):
        import preregister as PR
        importlib.reload(PR)
        self.assertEqual(PR.main(["--desk", "lab/alpha", "--run", "alpha-002", "--mechanic",
                                  "M1", "--ancestor", "alpha-001",
                                  "--variables", "window rolled · 2x -> 3x",
                                  "--variant", "levier élevé",
                                  "--predict", "ann_pct=10..20",
                                  "--predict", "liquidations=0", "--cmd", "python -m thing",
                                  "--window", "2026-01-01T00:00:00Z..2026-03-01T00:00:00Z",
                                  "--allow-no-sha"]), 0)
        self.assertEqual(self.rec(), 0)


# ----------------------------------------------------------- remeasure -----
class TestRemeasure(Base):
    def test_a_read_that_is_not_due_yet_is_refused(self):
        import remeasure as RM
        importlib.reload(RM)
        # alpha-001's result is 2 days old; the +7d read is not due
        self.assertEqual(RM.main(["--desk", "lab/alpha", "--run", "alpha-001",
                                  "--age", "7d"]), 1)

    def test_emit_jobs_is_valid_schedule_json(self):
        import remeasure as RM
        importlib.reload(RM)
        import io
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = RM.main(["--desk", "lab/alpha", "--run", "alpha-001", "--emit-jobs"])
        self.assertEqual(rc, 0)
        doc = json.loads(buf.getvalue())
        ids = {j["id"] for j in doc["jobs"]}
        self.assertEqual(ids, {"read-alpha-001-7d", "read-alpha-001-30d"})
        for j in doc["jobs"]:
            self.assertTrue(j["cadence"].startswith("at "))
            self.assertIsInstance(j["cmd"], list)
            self.assertEqual(j["cmd"][0], ".venv/Scripts/python.exe")
            self.assertEqual(j["cwd"], ".")
            for k in ("window_s", "timeout_s", "health"):
                self.assertIn(k, j)

    def test_a_run_with_no_result_cannot_be_read(self):
        import remeasure as RM
        importlib.reload(RM)
        self.assertEqual(RM.main(["--desk", "lab/alpha", "--run", "nope",
                                  "--age", "7d"]), 1)

    def test_dry_run_executes_nothing(self):
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        # backdate the result so the read IS due
        rows = C.read_jsonl(desk.runs)
        old = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 9 * 86400))
        for r in rows:
            if r.get("stage") == "result":
                r["ts"] = old
        C.write_text(desk.runs, "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))
        before = C.read_text(desk.f("results-log.md"))
        import remeasure as RM
        importlib.reload(RM)
        self.assertEqual(RM.main(["--desk", "lab/alpha", "--run", "alpha-001",
                                  "--age", "7d", "--dry"]), 0)
        self.assertEqual(C.read_text(desk.f("results-log.md")), before)
        self.assertFalse((desk.path / "data" / "reads").exists())


class TestRemeasureRenames(Base):
    CMD = "python -m jupyter nbconvert --execute studies/a.ipynb"
    DOC = {"renames": [{"old": "a.ipynb", "new": "b.ipynb", "runs": ["alpha-001"], "on": "2026-09-28"},
                       {"old": "b.ipynb", "new": "c.ipynb", "on": "2026-09-29"},
                       {"old": "x.ipynb", "new": "y.ipynb"}, {"old": "y.ipynb", "new": "x.ipynb"}],
           "removed": [{"notebook": "gone.ipynb", "also_named": ["older.ipynb"], "runs": ["alpha-001"],
                        "on": "2026-09-28", "why": "owner: no longer traded"}]}

    def _backdate(self):
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        rows = C.read_jsonl(desk.runs)
        old = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 9 * 86400))
        for r in rows:
            if r.get("stage") == "result":
                r["ts"] = old
                r["cmd"] = self._cmd
        C.write_text(desk.runs, "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))
        (desk.path / "renames.json").write_text(json.dumps(self.DOC), encoding="utf-8")
        return C, desk

    def test_an_old_name_runs_as_the_new_one_and_a_chain_is_followed(self):
        import remeasure as RM
        importlib.reload(RM)
        cmd, applied = RM.apply_renames(self.DOC, "alpha-001", self.CMD)
        self.assertEqual(cmd, "python -m jupyter nbconvert --execute studies/c.ipynb")
        self.assertEqual([r["old"] for r in applied], ["a.ipynb", "b.ipynb"])
        # the rename names alpha-001 only: another run keeps the recorded command
        self.assertEqual(RM.apply_renames(self.DOC, "beta-002", self.CMD)[0], self.CMD)
        # only an argument whose FILE NAME is the old name is touched (not a longer name that ends the same)
        self.assertEqual(RM.apply_renames(self.DOC, "alpha-001", "python x.py data/xa.ipynb")[0],
                         "python x.py data/xa.ipynb")
        # nothing to apply: the same string back, and a cycle stops
        self.assertEqual(RM.apply_renames({}, "alpha-001", self.CMD), (self.CMD, []))
        self.assertEqual(len(RM.apply_renames(self.DOC, "alpha-001", "python s/x.ipynb")[1]), 2)

    def test_a_venv_path_that_does_not_exist_from_the_cwd_is_the_fund_venv(self):
        import remeasure as RM
        importlib.reload(RM)
        d = tempfile.mkdtemp()
        try:
            studies = os.path.join(d, "research", "studies")
            os.makedirs(studies)
            # B-0526: recorded from research/, run from research/studies/: two up is not the venv
            self.assertTrue(RM.is_interpreter("..\\..\\.venv\\Scripts\\python", studies))
            self.assertTrue(RM.is_interpreter("python", studies))
            self.assertTrue(RM.is_interpreter("python3.exe", studies))
            self.assertFalse(RM.is_interpreter("jupyter", studies))
            self.assertFalse(RM.is_interpreter("../tools/runpython.sh", studies))
            # a path that exists is the author's choice and stays
            own = os.path.join(d, "research", ".venv", "Scripts")
            os.makedirs(own)
            open(os.path.join(own, "python.exe"), "w").close()
            self.assertFalse(RM.is_interpreter("..\\.venv\\Scripts\\python", studies))
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_a_removed_notebook_is_found_by_any_of_its_names(self):
        import remeasure as RM
        importlib.reload(RM)
        self.assertIsNotNone(RM.removed_for(self.DOC, "alpha-001", "python -m x gone.ipynb"))
        self.assertIsNotNone(RM.removed_for(self.DOC, "alpha-001", "python -m x studies/older.ipynb"))
        self.assertIsNone(RM.removed_for(self.DOC, "beta-002", "python -m x gone.ipynb"))
        self.assertIsNone(RM.removed_for(self.DOC, "alpha-001", "python -m x kept.ipynb"))

    def test_the_read_runs_the_new_notebook_and_the_ledger_keeps_its_command(self):
        self._cmd = self.CMD
        C, desk = self._backdate()
        import io, contextlib, remeasure as RM
        importlib.reload(RM)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = RM.main(["--desk", "lab/alpha", "--run", "alpha-001", "--age", "7d", "--dry"])
        self.assertEqual(rc, 0)
        self.assertIn("studies/c.ipynb", buf.getvalue())
        self.assertIn("a.ipynb -> b.ipynb", buf.getvalue())
        res = [r for r in C.read_jsonl(desk.runs) if r.get("stage") == "result"][-1]
        self.assertEqual(res["cmd"], self.CMD)

    def test_a_removed_notebook_writes_missed_and_runs_nothing(self):
        self._cmd = "python -m jupyter nbconvert --execute studies/gone.ipynb"
        C, desk = self._backdate()
        import remeasure as RM
        importlib.reload(RM)
        real = RM.subprocess.run
        RM.subprocess.run = lambda *a, **k: (_ for _ in ()).throw(AssertionError("a removed notebook must not run"))
        try:
            self.assertEqual(RM.main(["--desk", "lab/alpha", "--run", "alpha-001", "--age", "7d"]), 0)
        finally:
            RM.subprocess.run = real
        row = [r for r in C.read_jsonl(desk.runs) if r.get("stage") == "read"][-1]
        self.assertEqual((row["state"], row["rc"]), ("missed", None))
        self.assertEqual(row["removed"]["why"], "owner: no longer traded")
        self.assertIn("not run - the notebook was removed", C.read_text(desk.f("results-log.md")))
        # write-once: a second read at the same age is refused
        self.assertEqual(RM.main(["--desk", "lab/alpha", "--run", "alpha-001", "--age", "7d"]), 1)

    def _pipe_log(self, desk):
        """pm-001's shape: a pipe in the headline cell, and a second entry under the first."""
        import _common as C
        p = desk.f("results-log.md")
        text = C.read_text(p).replace("+12.0% ann |", "median |mid gap| 2.12 pts |", 1)
        self.assertIn("median |mid gap| 2.12 pts", text)
        C.write_text(p, text.rstrip("\n") + "\n\n### alpha-002 - the next pass\n\n- **Read:** pending\n")
        return p

    def test_a_headline_with_a_pipe_still_takes_its_ledger_cell(self):
        self._cmd = "python -m jupyter nbconvert --execute studies/gone.ipynb"
        C, desk = self._backdate()
        p = self._pipe_log(desk)
        import remeasure as RM
        importlib.reload(RM)
        self.assertEqual(RM.main(["--desk", "lab/alpha", "--run", "alpha-001", "--age", "7d"]), 0)
        row = [ln for ln in C.read_text(p).splitlines() if ln.startswith("| alpha-001 ")][0]
        self.assertTrue(row.endswith("| median |mid gap| 2.12 pts | missed removed | - | pending |"), row)
        # a second fill is refused as occupied, not as no-row
        self.assertEqual(C.fill_ledger_cell(desk, "alpha-001", "+7d", "x"), "occupied:missed removed")
        self.assertEqual(C.fill_ledger_cell(desk, "alpha-001", "+30d", "ran"), "written")
        self.assertEqual(C.fill_ledger_cell(desk, "alpha-009", "+30d", "ran"), "no-row")

    def test_a_pipe_in_a_column_that_is_not_the_headline_is_not_a_row(self):
        # the check can fail: surplus cells with no Headline column to hold them fit nothing
        import _common as C
        importlib.reload(C)
        self.assertIsNone(C.ledger_cells("| a | b | c |", ["Run", "X"]))
        self.assertEqual(C.ledger_cells("| a | m |x| n | z |", ["Run", "Headline", "Z"]), ["a", "m |x| n", "z"])

    def test_a_read_keeps_the_blank_line_before_the_next_heading(self):
        self._cmd = "python -m jupyter nbconvert --execute studies/gone.ipynb"
        C, desk = self._backdate()
        p = self._pipe_log(desk)
        import remeasure as RM
        importlib.reload(RM)
        self.assertEqual(RM.main(["--desk", "lab/alpha", "--run", "alpha-001", "--age", "7d"]), 0)
        text = C.read_text(p)
        self.assertIn("the notebook was removed (2026-09-28): owner: no longer traded\n\n### alpha-002", text)

    def test_the_removal_check_can_fail(self):
        # with no renames.json the same command is NOT treated as removed (the notebook would run)
        import remeasure as RM
        importlib.reload(RM)
        self.assertIsNone(RM.removed_for({}, "alpha-001", "python -m x gone.ipynb"))


# --------------------------------------------------------------- grade -----
class TestGrade(Base):
    def test_reports_the_fixture_run(self):
        import grade as G
        importlib.reload(G)
        import _common as C
        importlib.reload(C)
        rep = G.desk_report(C.resolve_desk("lab/alpha"), 8)
        self.assertEqual(rep["runs_graded"], 1)
        self.assertEqual(rep["in_band"], 1)

    def test_a_band_that_always_hits_is_flagged_as_too_wide(self):
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        win = {"from": "2026-01-01T00:00:00Z", "to": "2026-02-07T00:00:00Z", "hours": 900}
        for i in range(2, 8):
            rid = f"alpha-{i:03d}"
            ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - i * 3600))
            C.append_jsonl(desk.runs, {
                "run": rid, "stage": "preflight", "ts": ts, "desk": desk.rel,
                "kind": "exploit", "mechanic": "M1", "variables": ["w"],
                "ancestor": "alpha-001", "cmd": "x", "window": win,
                "predicted": {"ann_pct": "-100 to 100"}, "provenance": "[API]"})
            C.append_jsonl(desk.runs, {
                "run": rid, "stage": "result", "ts": ts, "desk": desk.rel,
                "kind": "exploit", "mechanic": "M1", "variables": ["w"], "cmd": "x",
                "window": win, "verify": {"suite": "v", "passed": 5, "total": 5},
                "predicted": {"ann_pct": "-100 to 100"}, "metrics": {"ann_pct": 12.0},
                "provenance": "[API]"})
        import grade as G
        importlib.reload(G)
        rep = G.desk_report(desk, 8)
        flags = [f["flag"] for f in rep["flags"]]
        self.assertIn("predicting too wide", flags, rep["flags"])

    def test_empty_tree_reports_honestly(self):
        import grade as G
        importlib.reload(G)
        import io
        import contextlib
        shutil.rmtree(self.root / "lab")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = G.main([])
        self.assertEqual(rc, 0)
        self.assertIn("honestly empty", buf.getvalue())


# ----------------------------------------------------------- retro_due -----
class TestRetroDue(Base):
    def test_a_fresh_stamp_is_not_due(self):
        import retro_due as R
        importlib.reload(R)
        import _common as C
        importlib.reload(C)
        st = R.status(C.resolve_desk("lab/alpha"), 7, 5)
        self.assertFalse(st["due"], st["reasons"])

    def test_an_old_stamp_is_due(self):
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        p = desk.f("beliefs.md")
        C.write_text(p, C.read_text(p).replace(
            "Last retro: " + time.strftime("%Y-%m-%d", time.gmtime(time.time() - 2 * 86400)),
            "Last retro: 2020-01-01"))
        import retro_due as R
        importlib.reload(R)
        st = R.status(desk, 7, 5)
        self.assertTrue(st["due"])
        self.assertIn("days old", " ".join(st["reasons"]))

    def test_an_empty_desk_is_not_in_debt(self):
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        C.write_text(desk.runs, "")
        C.write_text(desk.f("beliefs.md"), "# Beliefs\n\n## Beliefs\n")
        import retro_due as R
        importlib.reload(R)
        st = R.status(desk, 7, 5)
        self.assertFalse(st["due"], "an honest empty ledger is the correct starting state")

    def test_imports_only_owes_no_retro_and_says_why(self):
        # a desk whose rows are ALL imported (backfill.py) has no stamp and still owes no retro -
        # an import carries no prediction - and the line says so instead of "empty ledger"
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        rows = [{"stage": "result", "run": f"00{i}", "preregistered": False,
                 "provenance": "fixture"} for i in (1, 2)]
        C.write_text(desk.runs, "".join(json.dumps(r) + "\n" for r in rows))
        C.write_text(desk.f("beliefs.md"), "# Beliefs\n\n## Beliefs\n")
        import retro_due as R
        importlib.reload(R)
        st = R.status(desk, 7, 5)
        self.assertFalse(st["due"])
        self.assertEqual((st["runs_recorded"], st["imported"]), (0, 2))
        why = " ".join(st["reasons"])
        self.assertIn("2 imported row(s)", why)
        self.assertNotIn("empty ledger", why)
        line = R.debt_line([st])
        self.assertIn("1 unstamped desk(s) hold only imported rows", line)
        # one pre-registered result on top of the imports makes the unstamped desk DUE
        rows.append({"stage": "result", "run": "003"})
        C.write_text(desk.runs, "".join(json.dumps(r) + "\n" for r in rows))
        self.assertTrue(R.status(desk, 7, 5)["due"])

    def test_debt_line_shape(self):
        import retro_due as R
        importlib.reload(R)
        self.assertIn("none", R.debt_line([{"due": False, "desk": "d"}]))
        self.assertIn("RETRO DUE", R.debt_line(
            [{"due": True, "desk": "d", "stamp_age_days": 12.0, "runs_since": 3}]))


# -------------------------------------------------------------- digest -----
class TestDigest(Base):
    def test_at_most_twelve_lines_and_every_number_is_real(self):
        import digest as D
        importlib.reload(D)
        import _common as C
        importlib.reload(C)
        d = D.build(C.resolve_desk("lab/alpha"), 30, 8)
        lines = D.lines(d)
        self.assertLessEqual(len(lines), 12)
        self.assertTrue(any("<FILL:" in ln for ln in lines),
                        "the judgment slots must be explicit, never plausible prose")
        self.assertIn("1/1", " ".join(lines))

    def test_write_saves_the_retro_file_once(self):
        import _common as C
        importlib.reload(C)
        import digest as D
        importlib.reload(D)
        import contextlib
        import io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = D.main(["--desk", "lab/alpha", "--since", "30d", "--write"])
        self.assertEqual(rc, 0)
        p = self.root / "lab" / "alpha" / "retros" / f"{C.today()}.md"
        self.assertTrue(p.is_file(), "the digest must land where the Loop room looks")
        text = p.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\ndesk: lab/alpha\n"))
        self.assertIn("through: alpha-001", text)
        self.assertIn(f"# Retro - lab/alpha - {C.today()}", text)
        self.assertIn("- <FILL:", text)
        self.assertNotIn("\r", text)
        p.write_text(text + "- filled by hand\n", encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc = D.main(["--desk", "lab/alpha", "--write"])
        self.assertEqual(rc, 1, "a second --write the same day is refused")
        self.assertIn("filled by hand", p.read_text(encoding="utf-8"), "never overwritten")


# ------------------------------------------------- the example contract ----
EXAMPLE = """
### 001 - <name> - ran <date> · `<the exact command>`

- **Result:** <the decomposition, every figure with its provenance tag>
"""


class TestFencedExample(Base):
    """A results-log carries a worked EXAMPLE of an entry. Unfenced, it parses
    as a run with a result and no ledger row - one piece of template text that
    reported as a finding at every desk scaffolded from it."""

    def _append(self, text):
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        p = desk.f("results-log.md")
        C.write_text(p, C.read_text(p) + text)
        return desk

    def test_a_fenced_example_is_not_an_entry(self):
        import _common as C
        importlib.reload(C)
        self._append("\n## The entry shape\n\n```text" + EXAMPLE + "```\n")
        desk = C.resolve_desk("lab/alpha")
        self.assertEqual(C.entry_ids(C.results_log(desk)), ["alpha-001"])
        self.assertIsNone(C.entry_block(C.results_log(desk), "001"))
        self.assertFalse(C.has_result(desk, "001"))

    def test_break_it_on_purpose_unfenced_the_example_IS_a_finding(self):
        """The check must be able to go red on the defect it names, or the
        green above is worth nothing."""
        import _common as C
        desk = self._append("\n" + EXAMPLE)
        self.assertIn("001", C.entry_ids(C.results_log(desk)),
                      "an UNFENCED example must still parse as an entry")
        self.assertTrue(C.has_result(desk, "001"))

    def test_strip_fences_preserves_offsets(self):
        import _common as C
        importlib.reload(C)
        raw = "a\n```\nhidden\n```\nb\n"
        self.assertEqual(len(C.strip_fences(raw)), len(raw))
        self.assertNotIn("hidden", C.strip_fences(raw))


# ------------------------------------------------------------ backfill -----
class TestBackfill(Base):
    """Imported history is evidence, never a prediction - and the tool may
    IMPORT history, never create it."""

    def _bf(self, *extra, run="alpha-002"):
        import backfill as B
        importlib.reload(B)
        argv = ["--desk", "lab/alpha", "--run", run, "--ran", "2026-09-14",
                "--source", "HQ.md 2026-09-21", "--window", "2026-01-01..2026-02-07",
                "--hours", "900", "--regimes", "1", "--verify", "v 5/5",
                "--metric", "ann_pct=12.0", *extra]
        return B.main(argv)

    def _entry(self, run="alpha-002"):
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        C.append_entry(desk, f"### {run} - transcribed - ran 2026-09-14\n\n"
                             f"- **Result:** +12.0% ann [1]\n")
        return desk

    def test_a_row_with_no_prose_entry_is_refused(self):
        self.assertEqual(self._bf(), 1, "a row with nothing behind it is invented history")

    def test_a_preregistered_run_is_refused(self):
        self.assertEqual(self._bf(run="alpha-001"), 1,
                         "alpha-001 has a pre-flight - record.py owns it")

    def test_it_writes_preregistered_false_with_a_provenance(self):
        import _common as C
        desk = self._entry()
        self.assertEqual(self._bf(), 0)
        row = C.run_rows(desk, "alpha-002", "result")[-1]
        self.assertIs(row["preregistered"], False)
        self.assertTrue(row["provenance"].startswith("backfilled "))
        self.assertIn("HQ.md", row["provenance"])
        self.assertEqual(row["predicted"], {})
        self.assertTrue(C.is_import(row))
        self.assertEqual(self._bf(), 1, "write-once")

    def test_an_import_is_never_graded_and_never_owes_a_retro(self):
        import grade as G
        import retro_due as R
        desk = self._entry()
        self.assertEqual(self._bf(), 0)
        importlib.reload(G)
        importlib.reload(R)
        rep = G.desk_report(desk, 8)
        self.assertEqual(rep["imported"], 1)
        self.assertNotIn("alpha-002", [c["run"] for c in rep["calibration"]])
        st = R.status(desk, 7, 5)
        self.assertEqual(st["imported"], 1)
        self.assertEqual(st["runs_recorded"], 1, "only the pre-registered run counts")



# ------------------------------------------------------------- the layout --
class TestLayout(Base):
    """Desks live under the lab (platform/lab since 2026-09-25, lab/ in an older tree; the id
    reads lab/<name> either way), code in platform/, notebooks in platform/research."""

    def test_a_desk_under_lab_api_data_is_found(self):
        import _common as C
        importlib.reload(C)
        rels = [d.rel for d in C.all_desks()]
        self.assertIn(fixtures.ZETA, rels,
                      "every folder named `data` used to be pruned, hiding lab/platform/data/**")
        self.assertIn("lab/alpha", rels)

    def test_pre_rename_desk_ids_resolve_to_the_new_names(self):
        import _common as C
        importlib.reload(C)
        for old in ("lab/api/data/zeta", "desks/api/data/zeta", "api/data/zeta",
                    "lab/platform/data/zeta", "platform/data/zeta", "zeta"):
            self.assertEqual(C.resolve_desk(old).rel, fixtures.ZETA, old)
        self.assertEqual(C.canonical_desk("lab/api/data/venues/exchange_c"), "venues/exchange_c")
        self.assertEqual(C.canonical_desk("desks/app/frontend"), "dashboards/frontend")
        self.assertEqual(C.canonical_desk("desks/app"), "dashboards/app")
        self.assertEqual(C.canonical_desk("lab/api/lib/carry"), "platform/carry")
        self.assertEqual(C.canonical_desk("lab/research"), "research")
        # a current name that merely starts like an old one is left alone
        self.assertEqual(C.canonical_desk("lab/apiary"), "apiary")

    def test_a_desks_own_data_folder_is_never_a_desk(self):
        import _common as C
        importlib.reload(C)
        rels = [d.rel for d in C.all_desks()]
        self.assertNotIn(fixtures.ZETA + "/data", rels)
        self.assertEqual(len(rels), 2, rels)

    def test_every_spelling_of_a_desk_resolves(self):
        import _common as C
        importlib.reload(C)
        for spec in ("lab/alpha", "alpha", "desks/alpha", fixtures.ZETA,
                     "platform/data/zeta", "api/data/zeta", "zeta"):
            self.assertIn(C.resolve_desk(spec).rel, ("lab/alpha", fixtures.ZETA), spec)
        with self.assertRaises(C.Refuse):
            C.resolve_desk("nope")

    def test_legacy_cwds_map_onto_the_nested_repos(self):
        import _common as C
        importlib.reload(C)
        research = self.root / "platform" / "research"      # folded into platform 2026-09-25
        self.assertEqual(C.resolve_cwd("crypto"), self.root / "platform")
        self.assertEqual(C.resolve_cwd(""), self.root / "platform")
        self.assertEqual(C.resolve_cwd("crypto/research/studies"), research / "studies")
        self.assertEqual(C.resolve_cwd("research"), research)
        self.assertEqual(C.resolve_cwd("platform/research/studies"), research / "studies")
        # rows written 2026-09-24..25, when the code repos sat under repos/
        self.assertEqual(C.resolve_cwd("repos/platform"), self.root / "platform")
        self.assertEqual(C.resolve_cwd("repos/research/studies"), research / "studies")
        # a dashboard's cwd before the 2026-09-25 relayout
        self.assertEqual(C.resolve_cwd("platform/fundplat/dashboards/vol"), self.root / "platform" / "dashboards" / "vol")
        self.assertTrue(C.runs_in_research("research"))
        self.assertTrue(C.runs_in_research("platform/research/studies"))
        self.assertFalse(C.runs_in_research("platform"))

    def test_the_commit_of_a_row_reads_both_names(self):
        import _common as C
        self.assertEqual(C.commit_of({"crypto_commit": "abc"}), "abc")
        self.assertEqual(C.commit_of({"platform_commit": "def", "crypto_commit": "abc"}), "def")

    def test_a_notebook_preflight_records_the_research_sha_too(self):
        import preregister as PR
        importlib.reload(PR)
        rc = PR.main(["--desk", "lab/alpha", "--run", "alpha-002", "--mechanic", "M1",
                      "--ancestor", "alpha-001", "--variables", "window rolled",
                      "--predict", "ann_pct=10..20", "--cmd", "python -m thing",
                      "--cwd", "research",
                      "--window", "2026-01-01T00:00:00Z..2026-03-01T00:00:00Z",
                      "--allow-no-sha"])
        self.assertEqual(rc, 0)
        import _common as C
        importlib.reload(C)
        row = C.run_rows(C.resolve_desk("alpha"), "alpha-002", "preflight")[-1]
        self.assertIn("platform_commit", row)
        self.assertIn("research_commit", row)
        self.assertNotIn("crypto_commit", row)


class TestPlatformLab(Base):
    """The 2026-09-25 relayout: the lab lives in the PLATFORM repo (platform/lab/<desk>). The desk
    id stays logical (lab/alpha, in every row and message key); the files are read from
    platform/lab, and the pre-flight commit lands in the platform repo, never the fund root's."""

    def setUp(self):
        super().setUp()
        plat = self.root / "platform"
        plat.mkdir(exist_ok=True)
        shutil.move(str(self.root / "lab"), str(plat / "lab"))
        fixtures.git_init_at(plat, ["lab"])
        self.fund_head = fixtures.git(self.root, "rev-parse", "HEAD").strip()
        self.plat_head = fixtures.git(plat, "rev-parse", "HEAD").strip()
        self._reload()

    def test_desks_keep_their_logical_ids_and_read_from_platform_lab(self):
        import _common as C
        importlib.reload(C)
        rels = sorted(d.rel for d in C.all_desks())
        self.assertEqual(rels, sorted(["lab/alpha", fixtures.ZETA]))
        desk = C.resolve_desk("alpha")
        self.assertEqual(desk.rel, "lab/alpha")
        self.assertEqual(desk.folder, "platform/lab/alpha")
        self.assertEqual(desk.path, self.root / "platform" / "lab" / "alpha")
        self.assertEqual(desk.repo, self.root / "platform")
        self.assertEqual(C.ledger_paths(desk), ["lab/alpha/results-log.md", "lab/alpha/data/runs.jsonl"])
        self.assertEqual(C.resolve_desk("platform/lab/alpha").rel, "lab/alpha")

    def test_the_preflight_commits_in_the_platform_repo(self):
        import preregister as PR
        importlib.reload(PR)
        rc = PR.main(["--desk", "lab/alpha", "--allow-no-sha", "--run", "alpha-002", "--mechanic", "M1",
                      "--ancestor", "alpha-001", "--variables", "window rolled",
                      "--predict", "ann_pct=10..20", "--belief", "B1", "--cmd", "python -m thing",
                      "--window", "2026-01-01T00:00:00Z..2026-03-01T00:00:00Z"])
        self.assertEqual(rc, 0)
        plat = self.root / "platform"
        self.assertNotEqual(fixtures.git(plat, "rev-parse", "HEAD").strip(), self.plat_head, "committed in platform")
        self.assertEqual(fixtures.git(self.root, "rev-parse", "HEAD").strip(), self.fund_head, "the fund root untouched")
        import _common as C
        importlib.reload(C)
        desk = C.resolve_desk("lab/alpha")
        row = C.run_rows(desk, "alpha-002", "preflight")[-1]
        self.assertEqual(row["desk"], "lab/alpha", "the row carries the logical id")
        pf = C.preflight_commit(desk, "alpha-002")
        self.assertEqual(pf["sha"], fixtures.git(plat, "rev-parse", "HEAD").strip())


if __name__ == "__main__":
    unittest.main(verbosity=2)
