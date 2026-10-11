#!/usr/bin/env python3
"""THE DATA LAW'S MECHANISM - no folder but database/ opens a data file or a store directly.

    .venv\\Scripts\\python.exe app\\tools\\datalaw.py            # scan app/ and platform/
    .venv\\Scripts\\python.exe app\\tools\\datalaw.py --root D   # scan D/app and D/platform instead

The law (root CLAUDE.md, "The data law"): every repo reads and writes data through fund_db
(python) or @fund/db (node), and nowhere else. database/ IS the data layer and is never scanned.
This holds the other half: every tracked (or untracked, not ignored) .py / .ts / .tsx / .mts /
.cts / .js / .mjs / .cjs file of app/ and platform/, node_modules, .venv, dist and test fixture
folders skipped, and it refuses three shapes:

  store import   python: an import (or `python -c` source in a string) of sqlite3, duckdb,
                 psycopg / psycopg2 / psycopg_pool, asyncpg, pg8000, pyarrow, fastparquet;
                 a call of .read_parquet / .to_parquet / .scan_parquet.
                 node: an import / require / dynamic import of node:sqlite, sqlite, sqlite3,
                 better-sqlite3, duckdb, @duckdb/*, pg, pg-promise, postgres, parquetjs*,
                 apache-arrow.
  DSN            a string that IS a connection string: postgres:// or postgresql://, sqlite:,
                 duckdb:, or a libpq keyword string (dbname= beside host= / port= / user=).
                 A python f-string is read whole, its holes as `{}`.
  data append    an append-mode write (python open(..., "a"), any call with mode="a"/"ab"/"a+",
                 Path.open("a"); node appendFile / appendFileSync / a stream or open with flag
                 'a') in a file whose CODE names a .jsonl / .csv / .parquet file (a string that
                 is not a docstring; node source with comments stripped). The target is usually
                 a variable, so the file is the unit: a writer that appends and names a data
                 suffix is refused unless the ALLOW table below names it.
  pin write      (the storage classes) a call that writes a PIN - python
                 `<x>.pin_series(...)`, or `.pin(...)` on a receiver named `market` - or a string
                 naming `pin_series(`. A pin is the immutable record of the rows a result used; the
                 loop writes it through ONE adapter (loop/tools/pins.py) that refuses a pin whose
                 hash does not match the run's fingerprint, and a second writer would skip that.
  cache evict    a call of `.evict(...)` on a receiver named `market`, or a string that is the
                 fund_db CLI flag `--evict` (or holds `cache --evict`). Eviction is a real delete,
                 the cache's one carve-out from "no agent deletes data"; in app only the Data
                 room's owner-confirmed plan (server/data/storage.ts) may run it.

ALLOW is the list of KNOWLEDGE ledgers (committed, reviewed, merge=union) and test clusters, each
with its reason. Every row must still match: a row whose file no longer carries the hit is a
failure (remove the row), so the table cannot rot into a blanket pass. Under --root, a row whose
file is absent from the scanned tree is not checked (a scratch tree holds what it plants).

Prints one `FAIL <path>:<line>: <detail>` per breach, then `N ok, M failed` (one check per file
scanned plus one per ALLOW row). Exit 0 all green · 1 any breach or stale row · 2 bad arguments.
The planted-fault test is app/tools/tests/test_datalaw.py. Stdlib only.
"""

from __future__ import annotations

import argparse
import ast
import os
import re
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

FUND = Path(os.environ.get("FUND_ROOT") or Path(__file__).resolve().parents[2]).resolve()
REPOS = ("app", "platform")           # database/ is the data layer itself
SUFFIXES = (".py", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs")
SKIP_DIRS = {"node_modules", ".venv", "venv", "dist", "fixtures", "__fixtures__", "__pycache__", ".git"}
# this check and its test spell every forbidden shape on purpose
SELF = {"app/tools/datalaw.py", "app/tools/tests/test_datalaw.py"}

PY_STORES = {"sqlite3", "duckdb", "psycopg", "psycopg2", "psycopg_pool", "asyncpg", "pg8000",
             "pyarrow", "fastparquet"}
PY_PARQUET_CALLS = {"read_parquet", "to_parquet", "scan_parquet"}
NODE_STORES = {"node:sqlite", "sqlite", "sqlite3", "better-sqlite3", "duckdb", "duckdb-async", "pg",
               "pg-promise", "postgres", "parquetjs", "parquetjs-lite", "apache-arrow"}
NODE_STORE_SCOPES = ("@duckdb/", "@dsnp/parquetjs")
APPEND_MODES = {"a", "ab", "a+", "ab+", "a+b", "at"}

PY_IN_STRING = re.compile(r"(^|[\n;])\s*(?:from|import)\s+(" + "|".join(sorted(PY_STORES)) + r")\b")
TS_IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]""", re.M)
TS_STRING = re.compile(r"""'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`""")
TS_APPEND = re.compile(r"""\bappendFile(?:Sync)?\s*\(|\bflags?\s*:\s*['"]a\+?['"]|\bopen(?:Sync)?\s*\([^()]*,\s*['"]a\+?['"]""")
TS_COMMENT = re.compile(r"""/\*.*?\*/|(?<![:\\'"`])//[^\n]*""", re.S)   # rough: a URL's // survives
DATA_SUFFIX = re.compile(r"\.(jsonl|csv|parquet)\b", re.I)
APPEND = "append-mode write in a file that names a .jsonl/.csv/.parquet file"
PIN = "pin write outside the loop's pin adapter"
EVICT = "cache eviction outside the Data room"
PIN_TEXT = re.compile(r"\bpin_series\s*\(")
EVICT_TEXT = re.compile(r"^--evict$|\bcache\s+--evict\b")
URL_DSN = re.compile(r"\b(postgres(?:ql)?|sqlite|duckdb)://|\bsqlite::memory:", re.I)
KV_DSN = (re.compile(r"\bdbname\s*="), re.compile(r"\b(host|hostaddr|port|user)\s*="))


def is_dsn(s: str) -> bool:
    return bool(URL_DSN.search(s)) or all(p.search(s) for p in KV_DSN)


# (fund-relative path, detail) -> why it is allowed. Every entry is a decision, stated.
ALLOW: dict[tuple[str, str], str] = {
    ("app/loop/tools/pins.py", PIN):
        "THE loop's one pin adapter (B-0327): record/remeasure/preregister pin a run's inputs "
        "through fund_db.market.pin_series here, with expect=<the fingerprint's sha256>, and it "
        "REFUSES a pin whose hash does not match",
    ("app/server/data/storage.ts", EVICT):
        "the Data room's evict to budget (B-0327): the owner's typed phrase against a dry run held "
        "by fundd, a second dry run that must match, then `fund_db cache --evict` as a process",
    ("app/test/data-storage.test.ts", EVICT):
        "a TEST of the Data room's evict: it asserts the exact argv fundd sends to a FAKE store "
        "door (test/fixtures/archive-fake.mjs); nothing is evicted",
    ("app/loop/tools/_common.py", APPEND):
        "the loop's desk ledgers: append_text/append_jsonl write platform/lab/<desk>/data/runs.jsonl "
        "and trials.jsonl (plus results-log.md). They are KNOWLEDGE, not data - committed, reviewed, "
        "append-only under merge=union (.gitattributes), the evidence record every retro reads",
    ("app/server/loop/engine.ts", APPEND):
        "the loop's own records, app/loop/records/watch.jsonl and metrics.jsonl: committed "
        "KNOWLEDGE (what the loop watched and measured), appended and committed by the engine",
    ("app/loop/tools/tests/test_snapshots.py", APPEND):
        "a TEST of the retired-store migration: it appends a row to a planted legacy "
        "lab/<desk>/data/snapshots.jsonl inside a temp tree, to prove snapshots.migrate() folds it "
        "into the fund_db lake once; it writes no real file",
    ("app/test/pg/cluster.ts", "connection string"):
        "the cockpit's test harness: conninfo() names a THROWAWAY cluster it started itself in a "
        "temp folder, never the ops store (test/pg/setup.ts)",
    ("app/tools/_pgtest.py", "connection string"):
        "the machine's python test harness: a THROWAWAY cluster in a temp folder, handed to the "
        "test as FUND_DB_DSN; nothing here touches ~/fund-data/db",
    ("app/tools/probes/tests/test_probes.py", "connection string"):
        "a deliberately DEAD DSN (port 1, database nope) so the probes' store-down path can be "
        "tested; it connects to nothing",
}


# --------------------------------------------------------------------------- #
# The scan.                                                                    #
# --------------------------------------------------------------------------- #
def _walk(repo: Path) -> list[str]:
    """Repo-relative files: git's view (tracked + untracked, not ignored) when the folder is a
    git repo, else every file on disk; SKIP_DIRS pruned either way."""
    if (repo / ".git").exists():
        out = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                             cwd=repo, capture_output=True, check=True).stdout.decode("utf-8")
        files = [f for f in out.split("\0") if f]
    else:
        files = [p.relative_to(repo).as_posix() for p in repo.rglob("*") if p.is_file()]
    return sorted(f for f in files if f.endswith(SUFFIXES) and not SKIP_DIRS & set(f.split("/")[:-1])
                  and (repo / f).is_file())


def _py_hits(rel: str, text: str) -> list[tuple[int, str]]:
    try:
        tree = ast.parse(text)
    except SyntaxError as e:
        return [(e.lineno or 0, f"unparsable ({e.msg})")]
    out: list[tuple[int, str]] = []
    in_fstring: set[int] = set()
    appends: list[int] = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Import):
            out += [(n.lineno, f"imports {a.name}") for a in n.names if a.name.split(".")[0] in PY_STORES]
        elif isinstance(n, ast.ImportFrom) and n.module and n.level == 0 and n.module.split(".")[0] in PY_STORES:
            out.append((n.lineno, f"imports from {n.module}"))
        elif isinstance(n, ast.JoinedStr):
            parts = [v.value if isinstance(v, ast.Constant) and isinstance(v.value, str) else "{}"
                     for v in n.values]
            in_fstring |= {id(v) for v in n.values}
            if is_dsn("".join(parts)):
                out.append((n.lineno, "connection string"))
        elif isinstance(n, ast.Call):
            fn = getattr(n.func, "attr", getattr(n.func, "id", ""))
            if fn in ("import_module", "__import__") and n.args and isinstance(n.args[0], ast.Constant) \
                    and str(n.args[0].value).split(".")[0] in PY_STORES:
                out.append((n.lineno, f"imports {n.args[0].value}"))
            if fn in PY_PARQUET_CALLS:
                out.append((n.lineno, f"parquet {fn}() around the API"))
            recv = n.func.value if isinstance(n.func, ast.Attribute) else None
            recv_name = getattr(recv, "attr", getattr(recv, "id", ""))
            if fn == "pin_series" or (fn == "pin" and recv_name == "market"):
                out.append((n.lineno, PIN))
            if fn == "evict" and recv_name == "market":
                out.append((n.lineno, EVICT))
            modes = [k.value for k in n.keywords if k.arg == "mode"]
            if fn == "open":                # open(path, mode) / Path.open(mode) / io.open(path, mode)
                modes += n.args[1:2] if isinstance(n.func, ast.Name) else n.args[:2]
            if any(isinstance(m, ast.Constant) and m.value in APPEND_MODES for m in modes):
                appends.append(n.lineno)
    prose = {id(n.value) for n in ast.walk(tree) if isinstance(n, ast.Expr)}     # docstrings
    named = None
    for n in ast.walk(tree):
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in prose and not named:
            named = DATA_SUFFIX.search(n.value)
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in in_fstring:
            if is_dsn(n.value):
                out.append((n.lineno, "connection string"))
            for m in PY_IN_STRING.finditer(n.value):
                out.append((n.lineno, f"python code in a string imports {m.group(2)}"))
            if id(n) not in prose and PIN_TEXT.search(n.value):
                out.append((n.lineno, PIN))
            if id(n) not in prose and EVICT_TEXT.search(n.value.strip()):
                out.append((n.lineno, EVICT))
    if named:
        out += [(ln, APPEND) for ln in appends]
    return out


def _ts_hits(rel: str, text: str) -> list[tuple[int, str]]:
    line = lambda i: text.count("\n", 0, i) + 1
    out: list[tuple[int, str]] = []
    for m in TS_IMPORT.finditer(text):
        spec = m.group(1)
        if spec in NODE_STORES or spec.split("/")[0] in NODE_STORES or spec.startswith(NODE_STORE_SCOPES):
            out.append((line(m.start()), f"imports {spec}"))
    for m in TS_STRING.finditer(text):
        if is_dsn(m.group(0)):
            out.append((line(m.start()), "connection string"))
        for p in PY_IN_STRING.finditer(m.group(0)[1:-1]):
            out.append((line(m.start()), f"python code in a string imports {p.group(2)}"))
        if PIN_TEXT.search(m.group(0)):
            out.append((line(m.start()), PIN))
        if EVICT_TEXT.search(m.group(0)[1:-1].strip()):
            out.append((line(m.start()), EVICT))
    code = TS_COMMENT.sub(" ", text)
    for m in re.finditer(r"\bmarket\??\.(pin|evict)\s*\(", code):
        out.append((line(m.start()), PIN if m.group(1) == "pin" else EVICT))
    sfx = DATA_SUFFIX.search(TS_COMMENT.sub(" ", text))
    if sfx:
        out += [(line(m.start()), APPEND) for m in TS_APPEND.finditer(text)]
    return out


def hits(root: Path, repos: tuple[str, ...] = REPOS) -> tuple[list[str], list[str]]:
    """(files scanned, breaches) under root/<repo>; each breach `path:line: detail`, path
    fund-relative. ALLOW is NOT applied here - see judge()."""
    files, out = [], []
    for r in repos:
        base = root / r
        if not base.is_dir():
            continue
        for f in _walk(base):
            rel = f"{r}/{f}"
            if rel in SELF:
                continue
            files.append(rel)
            text = (base / f).read_text(encoding="utf-8", errors="replace")
            found = _py_hits(rel, text) if f.endswith(".py") else _ts_hits(rel, text)
            out += [f"{rel}:{ln}: {d}" for ln, d in sorted(set(found))]
    return files, out


def key(breach: str) -> tuple[str, str]:
    where, _, detail = breach.partition(": ")
    return where.rsplit(":", 1)[0], detail


def judge(root: Path, files: list[str], found: list[str], strict: bool) -> tuple[int, list[str]]:
    """(ok count, failure lines). A file is ok when every breach in it is ALLOWed; an ALLOW row is
    ok when it still matches. strict (the real fund root): a row whose file is gone is stale too."""
    bad_files = {key(b)[0] for b in found if key(b) not in ALLOW}
    fails = [f"FAIL {b}" for b in found if key(b) not in ALLOW]
    used = {key(b) for b in found}
    rows_ok = 0
    for k in ALLOW:
        if k in used:
            rows_ok += 1
        elif strict or (root / k[0]).is_file():
            fails.append(f"FAIL allow row no longer matches, remove it: {k[0]}: {k[1]}")
    return len([f for f in files if f not in bad_files]) + rows_ok, fails


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--root", help="a tree holding app/ and/or platform/ (default: the fund root)")
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    root = Path(a.root).resolve() if a.root else FUND
    if not any((root / r).is_dir() for r in REPOS):
        print(f"datalaw: no {' or '.join(REPOS)} under {root}")
        return 2
    files, found = hits(root)
    ok, fails = judge(root, files, found, strict=not a.root)
    for f in fails:
        print(f)
    print(f"{ok} ok, {len(fails)} failed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
