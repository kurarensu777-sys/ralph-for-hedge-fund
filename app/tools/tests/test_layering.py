#!/usr/bin/env python3
"""The cockpit never imports platform code - checked over every tracked file of app/.

Run:  .venv/Scripts/python.exe app/tools/tests/test_layering.py

The law (root CLAUDE.md, app/CLAUDE.md): the app reaches the platform only through fund_db /
@fund/db, a dashboard's or the feed's HTTP, or a platform CLI run as a child process
(`python -m fundplat.<module>`, cwd platform). An import hidden in a string
(`python -c "from fundplat ..."`) is invisible to an import scan. This walks every tracked .py (ast: import statements
AND string constants that carry python import code) and every tracked .ts/.tsx/.mjs/.js (an
import or require of a path into platform/), and names each breach as `path:line: detail`.
It also holds the ops store's SQL in database/: the cockpit's own code (server/, src/, shared/,
scripts/) may not import a raw door (query/one/exec/pool) from @fund/db nor hand SQL text to a
.query() - a read no typed ops.* function answers is a new @fund/db function, never inline SQL.

A `-m fundplat.<module>` argv is the allowed door (a process, not an import) and is never named.
The planted-fault test proves every shape is caught and every allowed shape is not.
"""

from __future__ import annotations

import ast
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

APP = Path(__file__).resolve().parents[2]

# the ops store's SQL is written in database/ (@fund/db's typed ops.* functions), never in the
# cockpit's own code: server/, src/, shared/ and scripts/ may neither import a raw door from
# @fund/db nor hand SQL text to a .query() (tests may, for fixtures)
RAW_IMPORT = re.compile(r"""import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@fund/db['"]""")
RAW_NAMES = {"query", "one", "exec", "pool", "poolFor"}
RAW_CALL = re.compile(r"""\.query\(\s*['"`]""")
RAW_HOMES = ("server/", "src/", "shared/", "scripts/")
PY_CODE = re.compile(r"(^|[\n;])\s*(from\s+fundplat(\.[\w.]+)?\s+import\b|import\s+fundplat\b)")
TS_IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]""", re.M)


# (path, detail) -> why it is allowed. Every entry is a decision, stated; a stale one is a failure.
ALLOW: dict[tuple[str, str], str] = {
    ("server/db.ts", "raw SQL door pool from @fund/db"):
        "the cockpit's ONE lazy store handle (`db`, a Queryable) is built on the pool so a room can hand "
        "it to a typed ops.* function before the pool exists; no SQL text is written here",
}


def _tracked(root: Path) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                         cwd=root, capture_output=True, check=True).stdout.decode("utf-8")
    return sorted(f for f in out.split("\0") if f and (root / f).is_file())


def _py_faults(rel: str, text: str) -> list[str]:
    try:
        tree = ast.parse(text)
    except SyntaxError as e:
        return [f"{rel}:{e.lineno}: unparsable ({e.msg})"]
    out = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            out += [f"{rel}:{n.lineno}: imports {a.name}" for a in n.names
                    if a.name == "fundplat" or a.name.startswith("fundplat.")]
        elif isinstance(n, ast.ImportFrom) and n.module and n.level == 0 and \
                (n.module == "fundplat" or n.module.startswith("fundplat.")):
            out.append(f"{rel}:{n.lineno}: imports from {n.module}")
        elif isinstance(n, ast.Call) and getattr(n.func, "attr", getattr(n.func, "id", "")) in ("import_module", "__import__"):
            a = n.args[0] if n.args else None
            if isinstance(a, ast.Constant) and isinstance(a.value, str) and a.value.split(".")[0] == "fundplat":
                out.append(f"{rel}:{n.lineno}: import_module {a.value}")
        elif isinstance(n, ast.Constant) and isinstance(n.value, str) and PY_CODE.search(n.value):
            out.append(f"{rel}:{n.lineno}: python code in a string imports fundplat")
    return out


def _ts_faults(rel: str, text: str) -> list[str]:
    out = []
    for m in TS_IMPORT.finditer(text):
        spec = m.group(1).replace("\\", "/")
        if re.search(r"(^|/)platform/", spec) or spec.split("/")[0] == "fundplat":
            out.append(f"{rel}:{text.count(chr(10), 0, m.start()) + 1}: imports {spec}")
    for m in PY_CODE.finditer(text):         # python handed to a child as `-c` source
        out.append(f"{rel}:{text.count(chr(10), 0, m.start()) + 1}: python code in a string imports fundplat")
    if rel.startswith(RAW_HOMES):
        line = lambda i: text.count(chr(10), 0, i) + 1
        for m in RAW_IMPORT.finditer(text):
            names = {n.strip().replace("type ", "").split(" as ")[0].strip() for n in m.group(1).split(",")}
            out += [f"{rel}:{line(m.start())}: raw SQL door {n} from @fund/db" for n in sorted(names & RAW_NAMES)]
        out += [f"{rel}:{line(m.start())}: SQL text handed to .query()" for m in RAW_CALL.finditer(text)]
    return out


def faults(root: Path, files: list[str] | None = None) -> list[str]:
    out = []
    for rel in files if files is not None else _tracked(root):
        if "/node_modules/" in f"/{rel}" or rel.startswith("dist/") or "/tests/" in f"/{rel}" and rel.endswith("test_layering.py"):
            continue
        suf = Path(rel).suffix
        if suf not in (".py", ".ts", ".tsx", ".mjs", ".js"):
            continue
        text = (root / rel).read_text(encoding="utf-8", errors="replace")
        out += _py_faults(rel, text) if suf == ".py" else _ts_faults(rel, text)
    return out


def _key(f: str) -> tuple[str, str]:
    path, _, detail = f.partition(": ")
    return path.rsplit(":", 1)[0], detail


class Layering(unittest.TestCase):
    def test_app_never_imports_platform_code(self):
        got = faults(APP)
        self.assertEqual([f for f in got if _key(f) not in ALLOW], [])
        used = {_key(f) for f in got}
        self.assertEqual([k for k in ALLOW if k not in used], [], "an ALLOW entry no longer matches: remove it")

    def test_every_planted_shape_is_named_and_the_allowed_door_is_not(self):
        plant = {
            "a.py": "import fundplat.data\n",
            "b.py": "from fundplat.quant import arb\n",
            "c.py": 'import importlib\nm = importlib.import_module("fundplat.data.venues")\n',
            "d.py": 'INLINE = r"""\nimport json\nfrom fundplat.data.core import store\n"""\n',
            "e.ts": "import { x } from '../../platform/fundplat/x.ts'\n",
            "f.mjs": "const y = require('fundplat/z')\n",
            "g.ts": "spawn(py, ['-c', 'import json; import fundplat'])\n",
            "server/h.ts": "import { ops, query } from '@fund/db'\n",
            "src/i.tsx": "import {\n  one as first,\n  ops,\n} from '@fund/db'\n",
            "server/j.ts": "const r = await db.query(`SELECT 1`, [])\n",
            # allowed: a platform CLI as a child process, prose that names the package
            "ok1.py": 'JOB = ["-m", "fundplat.jobs.probe_verify"]\n"""the probe never imports fundplat"""\n',
            "ok2.ts": "export const JOB = ['-m', 'fundplat.jobs.alert_readings'] // never imports fundplat\n",
            # allowed: the typed functions and row types from @fund/db; a raw door in a TEST (fixtures)
            "server/ok3.ts": "import { ops, transaction, type Queryable } from '@fund/db'\nawait ops.listNoLesson(db, {})\n",
            "test/ok4.ts": "import { query } from '@fund/db'\nawait query('SELECT 1', [])\n",
        }
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for rel, src in plant.items():
                (root / rel).parent.mkdir(parents=True, exist_ok=True)
                (root / rel).write_text(src, encoding="utf-8")
            got = faults(root, sorted(plant))
        want = ["a.py:1: imports fundplat.data", "b.py:1: imports from fundplat.quant",
                "c.py:2: import_module fundplat.data.venues",
                "d.py:1: python code in a string imports fundplat",
                "e.ts:1: imports ../../platform/fundplat/x.ts", "f.mjs:1: imports fundplat/z",
                "g.ts:1: python code in a string imports fundplat",
                "server/h.ts:1: raw SQL door query from @fund/db", "src/i.tsx:1: raw SQL door one from @fund/db",
                "server/j.ts:1: SQL text handed to .query()"]
        self.assertEqual(sorted(got), sorted(want))


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False, verbosity=2).result.wasSuccessful() else 1)
