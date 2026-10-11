#!/usr/bin/env python3
"""A FIXTURE FUND TREE in the 2026-09-24 layout.

One LIVE desk at `lab/alpha` with a pre-registered, recorded run, and one
empty desk nested under folders named `data` (`lab/platform/data/zeta`) -
the shape the pre-cut-over desk walker skipped, because it pruned every
directory called `data`. Materialised from this one file rather than checked
in as tiny files. (The BROKEN twin that fed `audit.py` retired with it on
2026-09-24.)

The tree is load-bearing for the clean path: a tool that has never printed its
all-clear is a success path that will debut on the day everything works.

    python app/loop/tools/tests/fixtures.py --write C:/tmp/look   # go and look
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def _w(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def _jsonl(p: Path, rows: list[dict]) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        for r in rows:
            f.write(json.dumps(r, sort_keys=True) + "\n")


CADENCE = """# cadence.md - how ALPHA runs

**State: {state}.** One honest sentence about what has actually run here.

## The run spine

1. READ THE RECORD.
2. PULL THE NOW.
3. JUDGE THE MOMENT.
4. PRE-REGISTER.
5. PRODUCE through the gates.
6. CLOSE.
7. RECORD.
"""

BELIEFS_GOOD = """# Beliefs - what ALPHA holds

```
Last retro: {stamp} · through run alpha-001 · next bet: exploit M1 with a wider window
```

## Beliefs

### B1 · The carry survives a rolled window - WEAK ({stamp})

+12.0% ann over 900h, {stamp}, [API].

- Evidence: run alpha-001
- Would change it: two consecutive rolled windows below the hurdle
- Kill test: re-run on a 2025 window, ~10 minutes

## Calibration

| Run | Predicted | Actual | Verdict |
|---|---|---|---|
| alpha-001 | 10 to 20 | 12.0 | in band |
"""

RESULTS_GOOD = """# Results Log - ALPHA

## Ledger

| Run | Mechanic | Ran | Window (UTC, hours, regimes) | Verify | Headline | +7d | +30d | Read |
|---|---|---|---|---|---|---|---|---|
| alpha-001 | M1 | {day} | 2026-01-01T00:00:00Z -> 2026-02-07T00:00:00Z · 900h | v 5/5 | +12.0% ann | - | - | pending |

## Entries

### alpha-001 - the first pass - ran {day} · `python -m thing`

- **Pre-flight:** mechanic M1 (exploit) · experiment: NONE · variables vs NONE: none · predict: ann_pct 10 to 20 · judge: robustness 1-5 · beliefs under test: B1
- **Window:** 2026-01-01T00:00:00Z -> 2026-02-07T00:00:00Z UTC · 900 hours · 1 regime(s)
- **Verify:** v 5/5 ALL PASS
- **Result:** ({day}) +12.0% ann [API]
- **Read:** pending
"""

MECHANICS = """# Mechanics

| ID | Mechanic | What it does | Our shots | External corpus | Status |
|---|---|---|---|---|---|
| M1 | rolled window | re-run on the window as it stands | 1 | - | ^ reading |
| M2 | wider band | widen the prediction band | - | - | o untested |
"""

MENU = """# Menu

| Option | Status | Weight | The job | The fuel | Rest rule |
|---|---|---|---|---|---|
| rolled window | ^ | 2 | keep the carry honest | the venue [R] | never twice running |

## The WILD slot

| Run | The WILD thing | Outcome |
|---|---|---|
| - | - | - |
"""

SERIES = """---
title: Alpha lessons
tags: [desk]
---

# Alpha lessons

| Book | Read when |
|---|---|
| `the-rolled-window.md` | about to compare two runs of the same engine and call it a replication |
"""
BOOK = "# The rolled window\n\nA cached history keyed by its end hour is a different window every hour.\n"


ZETA = "lab/platform/data/zeta"


_BUILT: dict = {}


def good(root: Path, *, state: str = "LIVE", git: bool = True) -> Path:
    """A tree every loop tool must read cleanly. Built (and git-initialised) once per
    process and COPIED after that, .git included - a git init per test is slow on
    Windows, and a copy is a separate repo all the same."""
    key = (state, git)
    if key not in _BUILT:
        base = Path(tempfile.mkdtemp(prefix="fundfixture-")) / "tree"
        _build(base, state=state, git=git)
        atexit.register(rmtree, base.parent)
        _BUILT[key] = base
    shutil.copytree(_BUILT[key], root, dirs_exist_ok=True)
    return root


def _build(root: Path, *, state: str, git: bool) -> Path:
    stamp = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 2 * 86400))
    day = stamp
    _w(root / "CLAUDE.md", "# the fund\n")
    # the 2026-09-25 layout: repos.json at the root, the roster and the library in app/
    _w(root / "repos.json", json.dumps({"repos": [{"id": "fund", "path": "."}]}, indent=2) + "\n")
    _w(root / "app" / "agents" / "README.md", "the roster: one <id>.md per agent\n")
    _w(root / "app" / "library" / "law" / "the-lessons" / "_series.md", SERIES)
    _w(root / "app" / "library" / "law" / "the-lessons" / "the-rolled-window.md", BOOK)

    # A desk under lab/platform/data: its parent folder is named `data`
    # (the name of every ledger folder), and must still be found.
    z = root / ZETA
    _w(z / "cadence.md", CADENCE.format(state="PRE-LIVE | OPENING | LIVE"))
    _w(z / "beliefs.md", "# Beliefs\n\n```\nLast retro: none yet\n```\n\n## Beliefs\n")
    _w(z / "results-log.md", "# Results Log - ZETA\n\n## Entries\n")
    _w(z / "mechanics.md", MECHANICS)
    _w(z / "menu.md", MENU)
    _w(z / "data" / "runs.jsonl", "")
    # a desk's own data/ folder holding a stray cadence.md must NOT be a desk
    _w(z / "data" / "cadence.md", "# not a desk - a ledger folder\n")

    d = root / "lab" / "alpha"
    _w(d / "cadence.md", CADENCE.format(state=state))
    _w(d / "beliefs.md", BELIEFS_GOOD.format(stamp=stamp))
    _w(d / "results-log.md", RESULTS_GOOD.format(day=day))
    _w(d / "mechanics.md", MECHANICS)
    _w(d / "menu.md", MENU)
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 2 * 86400))
    ts2 = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 2 * 86400 + 3600))
    win = {"from": "2026-01-01T00:00:00Z", "to": "2026-02-07T00:00:00Z",
           "hours": 900, "regimes": 1}
    _jsonl(d / "data" / "runs.jsonl", [
        {"run": "alpha-001", "stage": "preflight", "desk": "lab/alpha", "ts": ts,
         "kind": "exploit", "mechanic": "M1", "experiment": "NONE", "variables": [],
         "ancestor": "NONE", "beliefs": ["B1"], "cmd": "python -m thing",
         "cwd": "platform", "window": win, "predicted": {"ann_pct": "10 to 20"},
         "judge": ["robustness 1-5"], "platform_commit": "deadbeef", "provenance": "[API]"},
        {"run": "alpha-001", "stage": "result", "desk": "lab/alpha", "ts": ts2,
         "kind": "exploit", "mechanic": "M1", "variables": [], "ancestor": "NONE",
         "cmd": "python -m thing", "window": win,
         "verify": {"suite": "v", "passed": 5, "total": 5},
         "predicted": {"ann_pct": "10 to 20"}, "metrics": {"ann_pct": 12.0},
         "gates": {"provenance": "ok", "window": "ok", "verify": "ok", "scope": "ok"},
         "provenance": "[API]", "headline": "+12.0% ann"},
    ])
    if git:
        git_init(root)
    return root


def rmtree(path) -> None:
    """shutil.rmtree that also removes git's read-only object files on Windows (a plain
    ignore_errors rmtree leaves every fixture repo behind in the temp folder)."""
    import stat

    def onerror(func, p, _exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    shutil.rmtree(path, onerror=onerror)


def git(root: Path, *args: str) -> str:
    p = subprocess.run(["git", *args], cwd=str(root), capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=git_env())
    if p.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {p.stderr.strip()}")
    return p.stdout


def git_env() -> dict:
    """A fixture identity, and no hooks from the machine: the tree is a throwaway repo."""
    env = dict(os.environ)
    env.update(GIT_AUTHOR_NAME="fixture", GIT_AUTHOR_EMAIL="fixture@localhost",
               GIT_COMMITTER_NAME="fixture", GIT_COMMITTER_EMAIL="fixture@localhost")
    return env


def git_init_at(repo: Path, paths: list[str]) -> None:
    """`repo` as its OWN fixture git repo holding `paths`, one commit (the platform repo of a
    2026-09-25-layout tree: the lab under platform/lab)."""
    git(repo, "init", "-q")
    for k, v in (("user.name", "fixture"), ("user.email", "fixture@localhost"),
                 ("core.autocrlf", "false"), ("core.hooksPath", ".git/no-hooks"),
                 ("commit.gpgsign", "false")):
        git(repo, "config", k, v)
    git(repo, "add", "--", *paths)
    git(repo, "commit", "-q", "-m", "fixture repo")


def git_init(root: Path) -> None:
    """The fixture tree as its OWN git repo with one commit, so preregister.py's
    pre-flight commit and record.py's proof of it run against a real history - and
    never against the real fund repo (preregister refuses any root that is not the
    top of its own repo)."""
    git(root, "init", "-q")
    git(root, "config", "user.name", "fixture")
    git(root, "config", "user.email", "fixture@localhost")
    git(root, "config", "core.autocrlf", "false")
    git(root, "config", "core.hooksPath", ".git/no-hooks")
    git(root, "config", "commit.gpgsign", "false")
    git(root, "add", "--", "CLAUDE.md", "repos.json", "app", "lab")
    git(root, "commit", "-q", "-m", "fixture tree")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--write", required=True, help="a directory to materialise the tree in")
    a = ap.parse_args(argv)
    d = Path(a.write) / "good"
    if d.exists():
        rmtree(d)
    good(d)
    print(f"good: {d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
