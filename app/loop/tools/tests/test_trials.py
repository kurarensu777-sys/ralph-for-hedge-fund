#!/usr/bin/env python3
"""trial.py: the trial ledger is APPEND-ONLY, and refuses what the DSR cannot use.

Run:  .venv/Scripts/python.exe app/loop/tools/tests/test_trials.py
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOOP = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(LOOP))

import fixtures  # noqa: E402


class TrialBase(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fundtrial-"))
        fixtures.good(self.root)
        os.environ["FUND_ROOT"] = str(self.root)
        for m in ("_common", "trial"):
            if m in sys.modules:
                importlib.reload(sys.modules[m])
        import trial
        self.T = importlib.reload(trial)
        self.ledger = self.root / "lab" / "alpha" / "data" / "trials.jsonl"

    def tearDown(self):
        os.environ.pop("FUND_ROOT", None)
        fixtures.rmtree(self.root)

    def add(self, *extra):
        return self.T.main(["--desk", "lab/alpha", "--run", "alpha-001", *extra])

    def rows(self):
        return [json.loads(x) for x in self.ledger.read_text(encoding="utf-8").splitlines() if x.strip()]


class TestAppendOnly(TrialBase):
    def test_each_call_appends_one_row_and_never_touches_the_old_ones(self):
        self.assertEqual(self.add("--cell", "lev=2", "--sharpe", "0.1", "--n-obs", "200",
                                  "--skew", "-0.5", "--kurt", "4.0"), 0)
        first = self.ledger.read_bytes()
        self.assertEqual(self.add("--cell", "lev=3", "--status", "abandoned", "--sharpe", "0.02",
                                  "--n-obs", "200", "--skew", "0", "--kurt", "3"), 0)
        self.assertEqual(self.add("--cell", "lev=2", "--status", "rerun", "--sharpe", "0.09",
                                  "--n-obs", "200", "--skew", "-0.4", "--kurt", "4.1"), 0)
        after = self.ledger.read_bytes()
        self.assertTrue(after.startswith(first), "an earlier row was rewritten")
        rows = self.rows()
        self.assertEqual([r["status"] for r in rows], ["kept", "abandoned", "rerun"])
        self.assertEqual(rows[0]["cell"], {"lev": 2})
        self.assertEqual(rows[0]["mechanic"], "M1")  # from the run's pre-flight
        for r in rows:
            self.assertEqual(set(r), {"ts", "run", "mechanic", "cell", "sharpe", "n_obs", "skew",
                                      "kurt", "returns", "status"})

    def test_a_refusal_writes_nothing(self):
        self.add("--cell", "lev=2", "--sharpe", "0.1", "--n-obs", "200", "--skew", "0", "--kurt", "3")
        before = self.ledger.read_bytes()
        self.assertEqual(self.add("--cell", "lev=2", "--status", "edited", "--sharpe", "0.1",
                                  "--n-obs", "200", "--skew", "0", "--kurt", "3"), 1)
        self.assertEqual(self.add("--cell", "lev=2", "--sharpe", "0.1"), 1)  # no skew/kurt guessed
        self.assertEqual(self.add("--sharpe", "0.1", "--n-obs", "9", "--skew", "0", "--kurt", "3"), 1)  # no cell
        self.assertEqual(self.add("--mechanic", "M9", "--cell", "a=1", "--sharpe", "0.1",
                                  "--n-obs", "9", "--skew", "0", "--kurt", "3"), 1)  # not a mechanic
        self.assertEqual(self.ledger.read_bytes(), before)

    def test_a_return_path_is_stored_and_its_moments_computed(self):
        f = self.root / "rets.json"
        rets = [0.01, -0.02, 0.015, 0.0, 0.03, -0.01, 0.005]
        f.write_text(json.dumps(rets), encoding="utf-8")
        self.assertEqual(self.add("--cell", "lev=1", "--returns-file", str(f)), 0)
        r = self.rows()[-1]
        self.assertEqual(r["returns"], rets)
        self.assertEqual(r["n_obs"], 7)
        mu = sum(rets) / 7
        sd = (sum((x - mu) ** 2 for x in rets) / 6) ** 0.5
        self.assertAlmostEqual(r["sharpe"], mu / sd, places=8)

    def test_a_sweep_file_appends_every_cell_including_the_abandoned(self):
        f = self.root / "grid.jsonl"
        lines = [
            {"cell": {"lev": 1, "reserve": 0}, "returns": [0.01, -0.02, 0.015, 0.0, 0.03]},
            {"cell": {"lev": 2, "reserve": 0}, "sharpe": 0.05, "n_obs": 70, "skew": -0.3, "kurt": 4.2},
            {"cell": {"lev": 10, "reserve": 0}, "status": "abandoned", "sharpe": -0.2, "n_obs": 70,
             "skew": -2.0, "kurt": 11.0},
        ]
        f.write_text("".join(json.dumps(x) + "\n" for x in lines), encoding="utf-8")
        self.assertEqual(self.add("--cells-file", str(f)), 0)
        rows = self.rows()
        self.assertEqual([r["cell"]["lev"] for r in rows], [1, 2, 10])
        self.assertEqual([r["status"] for r in rows], ["kept", "kept", "abandoned"])
        self.assertEqual(rows[0]["n_obs"], 5)
        self.assertIsNone(rows[1]["returns"])
        self.assertTrue(all(r["mechanic"] == "M1" for r in rows))

    def test_one_bad_line_refuses_the_whole_sweep(self):
        f = self.root / "grid.jsonl"
        lines = [
            {"cell": {"lev": 1}, "sharpe": 0.05, "n_obs": 70, "skew": 0, "kurt": 3},
            {"cell": {"lev": 2}, "sharpe": 0.05},                      # no skew/kurt: refused
        ]
        f.write_text("".join(json.dumps(x) + "\n" for x in lines), encoding="utf-8")
        self.assertEqual(self.add("--cells-file", str(f)), 1)
        self.assertFalse(self.ledger.exists() and self.ledger.read_text(encoding="utf-8").strip())
        f.write_text(json.dumps({"cell": {"lev": 1}, "sharpe": 0.1, "n_obs": 9, "skew": 0,
                                 "kurt": 3, "pnl": 5}) + "\n", encoding="utf-8")
        self.assertEqual(self.add("--cells-file", str(f)), 1)       # unknown key
        f.write_text("", encoding="utf-8")
        self.assertEqual(self.add("--cells-file", str(f)), 1)       # an empty sweep
        self.assertEqual(self.add("--cells-file", str(f), "--cell", "a=1"), 1)  # mixed forms

    def test_an_accumulated_grid_file_needs_one_named_sweep_run(self):
        f = self.root / "grid.jsonl"

        def line(lev, run=None):
            cell = {"lev": lev} if run is None else {"lev": lev, "sweep_run": run}
            return {"cell": cell, "sharpe": 0.05, "n_obs": 70, "skew": 0, "kurt": 3}

        def write(*lines):
            f.write_text("".join(json.dumps(x) + "\n" for x in lines), encoding="utf-8")

        write(line(1, "r1"), line(2, "r1"), line(1, "r2"))
        self.assertEqual(self.add("--cells-file", str(f)), 1)        # two runs: refused
        self.assertFalse(self.ledger.exists() and self.ledger.read_text(encoding="utf-8").strip())
        self.assertEqual(self.add("--cells-file", str(f), "--sweep-run", "r9"), 1)  # no such run
        self.assertEqual(self.add("--cells-file", str(f), "--sweep-run", "r1"), 0)
        self.assertEqual([r["cell"]["lev"] for r in self.rows()], [1, 2])   # r2's cell not counted
        write(line(1, "r1"), line(2))                                # stamped + unstamped: a mix
        self.assertEqual(self.add("--cells-file", str(f)), 1)
        write(line(3, "r1"), line(4, "r1"))                          # one run: no flag needed
        self.assertEqual(self.add("--cells-file", str(f)), 0)
        write(line(5), line(6))                                      # pre-B-0247: no stamps
        self.assertEqual(self.add("--cells-file", str(f)), 0)
        self.assertEqual(self.add("--sweep-run", "r1", "--cell", "a=1", "--sharpe", "0.1",
                                  "--n-obs", "9", "--skew", "0", "--kurt", "3"), 1)  # no file

    def test_the_tool_has_no_rewrite_path(self):
        src = (LOOP / "trial.py").read_text(encoding="utf-8")
        self.assertNotIn("write_text(", src)
        self.assertNotIn('"w"', src)


if __name__ == "__main__":
    unittest.main(verbosity=1)
