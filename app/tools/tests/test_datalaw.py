#!/usr/bin/env python3
"""The data law's check (app/tools/datalaw.py) goes RED on every planted breach and stays GREEN on
an allowed ledger - broken once on purpose, in a scratch tree, before it is trusted on the real one.

Run:  .venv/Scripts/python.exe app/tools/tests/test_datalaw.py

A check may only claim what it tested (root CLAUDE.md): what would datalaw.py print if a repo DID
open a store? This plants each shape and asks. The real-tree scan is check.py's tools.data-law row.
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
import datalaw  # noqa: E402

A = datalaw.APPEND
PIN = datalaw.PIN
EV = datalaw.EVICT

RED = {
    "app/loop/tools/leak.py": "import sqlite3\ncon = sqlite3.connect('cockpit.db')\n",
    "app/loop/tools/archive.py": 'def keep(row):\n    with open("rows.jsonl", "a") as f:\n        f.write(row)\n',
    "app/loop/tools/frame.py": 'import pandas as pd\ndf = pd.read_parquet(p)\ndf.to_csv("out.csv", mode="a")\n',
    "app/loop/tools/child.py": 'ARGV = ["-c", "import json; import duckdb"]\n',
    "app/server/store.ts": "import { DatabaseSync } from 'node:sqlite'\nimport pg from 'pg'\n",
    "app/server/tape.mjs": "import { appendFileSync } from 'node:fs'\nappendFileSync('tape.jsonl', line)\n",
    "platform/lab/conn.py": 'DSN = "postgresql://fund@127.0.0.1:5432/fund"\n',
    "platform/lab/kv.py": 'def dsn(port):\n    return f"host=127.0.0.1 port={port} dbname=fund"\n',
    # the storage classes : a second pin writer, and an eviction outside the Data room
    "app/loop/tools/sneak.py": 'from fund_db import market\nmarket.pin_series(spec, w, reason="x", ref="y")\n'
                               'market.pin(rows, dataset="funding")\n',
    "app/tools/janitor.py": 'from fund_db import market\nmarket.evict(to_bytes=0)\nARGV = ["cache", "--evict", "--json"]\n',
    "app/server/sweep.ts": "run(storeDoor(), ['cache', '--evict'])\nawait market.pin(rows)\nconst s = 'python -m fund_db cache --evict'\n",
}
WANT_RED = sorted([
    "app/loop/tools/leak.py:1: imports sqlite3",
    f"app/loop/tools/archive.py:2: {A}",
    "app/loop/tools/frame.py:2: parquet read_parquet() around the API",
    f"app/loop/tools/frame.py:3: {A}",
    "app/loop/tools/child.py:1: python code in a string imports duckdb",
    "app/server/store.ts:1: imports node:sqlite",
    "app/server/store.ts:2: imports pg",
    f"app/server/tape.mjs:2: {A}",
    "platform/lab/conn.py:1: connection string",
    "platform/lab/kv.py:2: connection string",
    f"app/loop/tools/sneak.py:2: {PIN}",
    f"app/loop/tools/sneak.py:3: {PIN}",
    f"app/tools/janitor.py:2: {EV}",
    f"app/tools/janitor.py:3: {EV}",
    f"app/server/sweep.ts:1: {EV}",
    f"app/server/sweep.ts:2: {PIN}",
    f"app/server/sweep.ts:3: {EV}",
])

GREEN = {
    # the allowed ledgers, by name: the desk ledger writer and the loop's records writer
    "app/loop/tools/_common.py": 'def append_text(p, text):\n    with open(p, "a", encoding="utf-8") as f:\n'
                                 '        f.write(text)\nRUNS = "data/runs.jsonl"\n',
    "app/server/loop/engine.ts": "const WATCH_LOG = `${LOOP_REL}/watch.jsonl`\nappendFileSync(f, lines)\n",
    # an append that names no data file (a log), a data suffix only in prose, a read-only jsonl
    "app/server/sched.ts": "// the retired schedule-log.jsonl horizon\nconst fd = openSync(logPath, 'a')\n",
    "app/loop/tools/log.py": '"""Appends to results-log.md; runs.jsonl is written elsewhere."""\n'
                             'with open("results-log.md", "a") as f:\n    f.write("x")\n',
    "app/loop/tools/reader.py": 'rows = open("data/runs.jsonl").read()\n',
    # the loop's one pin adapter and the Data room's evict, by name; a READ of the pin index is no write
    "app/loop/tools/pins.py": 'from fund_db import market\ndef pin_input(spec, w):\n'
                              '    return market.pin_series(spec, w, reason="result", ref="x")\n',
    "app/server/data/storage.ts": "const args = ['cache', '--evict', '--json']\n",
    "app/server/lab/pins.ts": "const f = marketFn('pins')\nconst rows = await market.pins({})\nconst ok = market.pinned(h)\n",
    # the one door, and skipped folders that may hold anything
    "app/server/ok.ts": "import { ops } from '@fund/db'\n",
    "app/loop/tools/ok.py": "from fund_db import market\n",
    "app/node_modules/pg/index.js": "require('pg')\n",
    "app/test/fixtures/seed.py": "import sqlite3\n",
    "platform/.venv/lib/x.py": "import psycopg\n",
}


def plant(root: Path, files: dict[str, str]) -> None:
    for rel, src in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(src, encoding="utf-8")


def run_cli(root: Path) -> tuple[int, str]:
    p = subprocess.run([sys.executable, str(TOOLS / "datalaw.py"), "--root", str(root)],
                       capture_output=True, text=True, encoding="utf-8")
    return p.returncode, p.stdout


def summary(out: str) -> tuple[int, int]:
    m = re.findall(r"^(\d+) ok, (\d+) failed$", out, re.M)
    assert m, f"no summary line in:\n{out}"
    return int(m[-1][0]), int(m[-1][1])


class DataLaw(unittest.TestCase):
    def test_every_planted_breach_is_named(self):
        with tempfile.TemporaryDirectory() as d:
            plant(Path(d), RED)
            _, got = datalaw.hits(Path(d))
        self.assertEqual(sorted(got), WANT_RED)

    def test_red_tree_fails_the_cli(self):
        with tempfile.TemporaryDirectory() as d:
            plant(Path(d), {**RED, **GREEN})
            rc, out = run_cli(Path(d))
        self.assertEqual(rc, 1, out)
        ok, bad = summary(out)
        self.assertEqual(bad, len(WANT_RED), out)
        for b in WANT_RED:
            self.assertIn(f"FAIL {b}", out)

    def test_allowed_ledgers_and_skipped_folders_stay_green(self):
        with tempfile.TemporaryDirectory() as d:
            plant(Path(d), GREEN)
            rc, out = run_cli(Path(d))
            _, got = datalaw.hits(Path(d))
        self.assertEqual(rc, 0, out)
        self.assertEqual(summary(out)[1], 0, out)
        # the allowed ledgers WERE seen (a green that saw nothing proves nothing), and only they
        self.assertEqual(sorted(got), sorted([f"app/loop/tools/_common.py:2: {A}",
                                              f"app/server/loop/engine.ts:2: {A}",
                                              f"app/loop/tools/pins.py:3: {PIN}",
                                              f"app/server/data/storage.ts:1: {EV}"]))

    def test_a_stale_allow_row_is_a_failure(self):
        with tempfile.TemporaryDirectory() as d:
            plant(Path(d), {"app/loop/tools/_common.py": "def read(p):\n    return open(p).read()\n"})
            rc, out = run_cli(Path(d))
        self.assertEqual(rc, 1, out)
        self.assertIn("FAIL allow row no longer matches, remove it: app/loop/tools/_common.py", out)

    def test_every_allow_row_states_a_reason(self):
        for k, why in datalaw.ALLOW.items():
            self.assertGreater(len(why), 40, k)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
