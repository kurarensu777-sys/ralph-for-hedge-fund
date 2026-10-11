#!/usr/bin/env python3
"""ONE CHECK COMMAND - every suite in the fund, in its own cwd and interpreter, one table.

    .venv\\Scripts\\python.exe app\\tools\\check.py
    .venv\\Scripts\\python.exe app\\tools\\check.py --fast            # skip the LIVE (network) suites
    .venv\\Scripts\\python.exe app\\tools\\check.py --only database   # one area (repeat or comma-list)
    .venv\\Scripts\\python.exe app\\tools\\check.py --only platform.charts,tools
    .venv\\Scripts\\python.exe app\\tools\\check.py --list            # what would run, run nothing
    .venv\\Scripts\\python.exe app\\tools\\check.py --json            # the table as JSON

Areas: app (tsc + vitest) · tools (every app/tools/*/tests/test_*.py and
app/loop/tools/tests/test_*.py, the budget smoke, the data-law scan, the context caps, pyflakes) ·
database (pytest + pyflakes on fund_db, tsc + node --test on @fund/db) · platform (the chart bank
checker and the study-label checker under platform/research, each with its selftest, the figure
style's selftest, pyflakes on platform/research and platform/fundplat).

WHAT A GREEN ROW CLAIMS, AND ONLY THAT. A row is `ok` when the suite exited 0 AND printed the
summary line its own format promises (`N ok, 0 failed`, `Ran N tests ... OK`, `Tests N passed`,
...) AND that summary counts at least one check and no failure. Exit 0 with no summary is a
FAIL (`no summary`): a suite that crashed before reporting, or printed nothing, has not shown
anything passed. A linter row (tsc, pyflakes) is `ok` on exit 0 and zero diagnostics. A suite
that cannot start (no node_modules, no venv) is a FAIL, never a skip. Only `--fast` skips, and
only the suites marked live, and the table says so. The verdict rules themselves are checked
first, on synthetic outputs, in-process (`verdict rules` row) - break one and that row goes red.

Runs SEQUENTIALLY (the machine is short of memory), each suite under a timeout that kills the
whole process tree. Every suite runs with `$FUND_FLOOR` pointed at a scratch dir, so a check run
never overwrites a real probe reading. Full output of every suite lands in
`%TEMP%\\fund-check\\<area>.<suite>.log`; the tail of a failed one is printed under the table.
Nothing printed carries the machine's home or temp path: `scrub()` writes `~` and `%TEMP%`.

Exit: 0 all ran green (skips and unknown rows allowed) · 1 any FAIL · 2 bad arguments. Stdlib only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(os.environ.get("FUND_ROOT") or Path(__file__).resolve().parents[2]).resolve()   # <fund>/app/tools/check.py
VENV_PY = ROOT / ".venv" / "Scripts" / "python.exe"
if not VENV_PY.exists():                      # a POSIX venv layout
    VENV_PY = ROOT / ".venv" / "bin" / "python"
AREAS = ("app", "tools", "database", "platform")
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _dir_forms(*dirs: str) -> list[str]:
    """Every spelling of each directory (as given, resolved, forward-slashed), longest first."""
    forms = set()
    for d in dirs:
        if not d:
            continue
        for x in (d, str(Path(d).resolve())):
            x = x.rstrip("\\/")
            forms.update({x, x.replace("\\", "/")})
    return sorted((f for f in forms if f), key=len, reverse=True)


def scrub(text: str) -> str:
    """The machine's own paths out of anything printed: the temp dir becomes `%TEMP%`, the home
    directory `~`. The loop pastes a red check's output into tracked board items, and the owner's
    profile path must not ride along."""
    flags = re.I if os.name == "nt" else 0
    for forms, to in ((_dir_forms(tempfile.gettempdir()), "%TEMP%"),
                      (_dir_forms(str(Path.home()), os.environ.get("USERPROFILE", "")), "~")):
        for f in forms:
            text = re.sub(re.escape(f) + r"(?![^\\/\s'\"):,;])", lambda _m, to=to: to, text, flags=flags)
    return text


# --------------------------------------------------------------------------- #
# Summary parsers: output -> (passed, failed) or None when the line is absent. #
# --------------------------------------------------------------------------- #
def p_ok_failed(out: str):
    """`N ok, M failed` - test_parsers/test_events/test_wire/test_ops/dashboards/selftest."""
    m = re.findall(r"^\s*(\d+) ok, (\d+) failed\s*$", out, re.M)
    return (int(m[-1][0]), int(m[-1][1])) if m else None


def p_right_wrong(out: str):
    """`  <what was planted>   GREEN|RED (right)` / `... (WRONG)` rows - figstyle --selftest.
    Rows ending `(right)` are the passes, rows containing `(WRONG` the failures; no row is no summary."""
    right = len(re.findall(r"\(right\)\s*$", out, re.M))
    wrong = len(re.findall(r"\(WRONG\)", out))
    return (right, wrong) if right or wrong else None


def p_ok_failed_tail(out: str):
    """`N ok, M failed` with an optional `, K unknown` / `, K warn` tail and a trailing
    `(12.3 s)` - context.py. The tail is SHOWN beside the count and never counted as passed; an
    unknown is a check that did not decide."""
    m = re.findall(r"^\s*(\d+) ok, (\d+) failed((?:, \d+ (?:unknown|warn))*)\s*(?:\([^)]*\))?\s*$",
                   out, re.M)
    if not m:
        return None
    ok, bad, tail = m[-1]
    return int(ok), int(bad), tail.lstrip(", ")


def p_planted_caught(out: str):
    """`k/N planted faults caught` or `k of N planted faults caught` - a checker's selftest
    (check_charts, check_labels). A miss is N - k; no such line is no summary."""
    m = re.findall(r"\b(\d+)(?:/| of )(\d+) planted faults caught\b", out)
    return (int(m[-1][0]), int(m[-1][1]) - int(m[-1][0])) if m else None


def p_unittest(out: str):
    """`Ran N tests` then `OK` / `OK (skipped=k)` / `FAILED (failures=a, errors=b)`."""
    ran = re.findall(r"^Ran (\d+) tests? in ", out, re.M)
    if not ran:
        return None
    n = int(ran[-1])
    tail = out[out.rfind("Ran "):]
    if re.search(r"^OK\b", tail, re.M):
        sk = re.search(r"skipped=(\d+)", tail)
        return n - int(sk.group(1) if sk else 0), 0
    f = re.search(r"^FAILED \(([^)]*)\)", tail, re.M)
    if not f:
        return None
    bad = sum(int(x) for x in re.findall(r"(?:failures|errors|unexpected successes)=(\d+)",
                                         f.group(1)))
    return n - bad, max(bad, 1)


def p_vitest(out: str):
    """vitest's `Tests  a failed | b passed (N)` line (the per-test one, not `Test Files`)."""
    m = re.findall(r"^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$", out, re.M)
    if not m:
        return None
    parts, _ = m[-1]
    got = {k: int(v) for v, k in re.findall(r"(\d+) (failed|passed|skipped|todo)", parts)}
    if not got:
        return None
    return got.get("passed", 0), got.get("failed", 0)


def p_pytest(out: str):
    """pytest's last summary line: `12 passed, 1 skipped in 0.5s` (or `== ... ==` framed). A
    failure or an error anywhere in it is a failure; `no tests ran` counts nothing."""
    m = re.findall(r"^=*\s*((?:\d+ \w+(?:, )?)+) in [\d.]+s", out, re.M)
    if not m:
        return None
    got = {k: int(v) for v, k in re.findall(r"(\d+) (\w+)", m[-1])}
    bad = got.get("failed", 0) + got.get("error", 0) + got.get("errors", 0)
    return got.get("passed", 0), bad


def p_pytest_strict(out: str):
    """p_pytest where a SKIP is a failure: the data layer's suites skip when Postgres binaries or
    node_modules are missing, and a skipped store test is a store nobody exercised - reading that as
    green is the overclaim this table exists to refuse (2026-09-27 audit). Other areas keep p_pytest."""
    r = p_pytest(out)
    if r is None:
        return None
    m = re.findall(r"^=*\s*((?:\d+ \w+(?:, )?)+) in [\d.]+s", out, re.M)
    skipped = int(dict((k, v) for v, k in re.findall(r"(\d+) (\w+)", m[-1])).get("skipped", 0)) if m else 0
    return r[0], r[1] + skipped


def p_node_test_strict(out: str):
    """p_node_test where a skipped test (`# skip N` / `\u2139 skipped N`) is a failure, for the same reason."""
    r = p_node_test(out)
    if r is None:
        return None
    sk = re.findall(r"^(?:#|\u2139) skip(?:ped)? (\d+)\s*$", out, re.M)
    return r[0], r[1] + (int(sk[-1]) if sk else 0)


def p_node_test(out: str):
    """node --test's tail: `# pass N` / `# fail M` (the tap reporter the suite asks for), or the
    spec reporter's `(i) pass N` / `(i) fail M` (U+2139), whichever the node on PATH printed."""
    ok = re.findall(r"^(?:#|ℹ) pass (\d+)\s*$", out, re.M)
    bad = re.findall(r"^(?:#|ℹ) fail (\d+)\s*$", out, re.M)
    return (int(ok[-1]), int(bad[-1])) if ok and bad else None


def p_charts(out: str):
    """`check_charts: N chart types, F fault(s); ...` - each chart type is a check, each fault a failure."""
    m = re.findall(r"^check_charts: (\d+) chart types, (\d+) fault\(s\)", out, re.M)
    return (int(m[-1][0]) - min(int(m[-1][1]), int(m[-1][0])), int(m[-1][1])) if m else None


def p_labels(out: str):
    """`check_labels: N studies, F fault(s); ...`. Each study is a check, and so is the closed-set
    cross-check against the cockpit's research.ts when it ran; a line saying it did not run (the
    file absent) with no study is a check that tested nothing, which is no summary."""
    m = re.findall(r"^check_labels: (\d+) studies, (\d+) fault\(s\)(.*)$", out, re.M)
    if not m:
        return None
    n, bad, tail = int(m[-1][0]), int(m[-1][1]), m[-1][2]
    crossed = "not cross-checked" not in tail
    checks = n + (1 if crossed else 0)
    return max(checks - bad, 0), bad, ("" if n else "0 studies") + ("" if crossed else ", sets not cross-checked")


def p_lint_tsc(out: str):
    return len(re.findall(r"error TS\d+", out))


def p_lint_lines(out: str):
    """pyflakes: one diagnostic per non-empty stdout line."""
    return len([ln for ln in out.splitlines() if ln.strip()])


# --------------------------------------------------------------------------- #
# The verdict.                                                                 #
# --------------------------------------------------------------------------- #
@dataclass
class Suite:
    area: str
    name: str
    cmd: list
    cwd: Path
    parse: object = None          # summary parser; None for a lint suite
    lint: object = None           # diagnostic counter for a lint suite
    live: bool = False            # needs the network: skipped by --fast
    timeout: int = 600
    needs: list = field(default_factory=list)   # paths that must exist to start
    rows: object = None           # (suite, rc, out) -> [(name, status, count)]: one row per item
    env: dict = field(default_factory=dict)     # extra environment for this suite only

    @property
    def key(self) -> str:
        return f"{self.area}.{self.name}"


def verdict(s: Suite, rc, out: str) -> tuple[str, str]:
    """(status, count text). status: ok | FAIL. rc None = timed out."""
    if rc is None:
        return "FAIL", f"timeout {s.timeout}s"
    if s.lint is not None:
        n = s.lint(out)
        if rc != 0 and n == 0:
            return "FAIL", f"exit {rc}, no diagnostics parsed"
        return ("ok" if rc == 0 and n == 0 else "FAIL"), f"{n} diagnostic{'s' * (n != 1)}"
    got = s.parse(out)
    if got is None:
        return "FAIL", f"exit {rc}, no summary"
    passed, failed, *tail = got
    text = f"{passed}/{passed + failed}" + (f", {tail[0]}" if tail and tail[0] else "")
    if rc != 0:
        return "FAIL", f"{text} exit {rc}"
    if failed:
        return "FAIL", f"{text} ({failed} failed)"
    if passed == 0:
        return "FAIL", "0 checks ran"
    return "ok", text


def verdict_rules() -> tuple[int, list[str]]:
    """Break every rule on purpose: each synthetic case must come back with its expected status.
    Returns (cases, the ones that did not) - an empty list means the rules hold."""
    s = lambda p=None, lint=None: Suite("x", "x", [], ROOT, parse=p, lint=lint, timeout=1)
    cases = [
        (s(p_ok_failed), 0, "12 ok, 0 failed\n", "ok"),
        (s(p_ok_failed), 0, "12 ok, 1 failed\n", "FAIL"),         # exit 0 but a failure
        (s(p_ok_failed), 1, "12 ok, 0 failed\n", "FAIL"),         # summary green, exit red
        (s(p_ok_failed), 0, "", "FAIL"),                          # printed nothing
        (s(p_ok_failed), 0, "0 ok, 0 failed\n", "FAIL"),          # ran nothing
        (s(p_ok_failed), None, "12 ok, 0 failed\n", "FAIL"),      # timed out
        (s(p_unittest), 0, "Ran 25 tests in 1.0s\n\nOK\n", "ok"),
        (s(p_unittest), 0, "Ran 0 tests in 0.0s\n\nOK\n", "FAIL"),
        (s(p_unittest), 1, "Ran 5 tests in 1s\n\nFAILED (failures=1, errors=2)\n", "FAIL"),
        (s(p_unittest), 0, "Ran 4 tests in 1s\n\nOK (skipped=4)\n", "FAIL"),   # all skipped
        (s(p_vitest), 0, " Test Files  3 passed (3)\n      Tests  40 passed (40)\n", "ok"),
        (s(p_vitest), 1, "      Tests  2 failed | 38 passed (40)\n", "FAIL"),
        (s(p_vitest), 0, " Test Files  3 passed (3)\n", "FAIL"),   # file line only
        (s(p_planted_caught), 0, "check_charts selftest: 26/26 planted faults caught, clean fixture clean\n", "ok"),
        (s(p_planted_caught), 0, "x selfcheck: 10 of 10 planted faults caught\n", "ok"),
        (s(p_planted_caught), 0, "check_labels selftest: 21/22 planted faults caught\n", "FAIL"),      # a miss the exit hid
        (s(p_planted_caught), 1, "check_labels selftest: 22/22 planted faults caught\n", "FAIL"),      # green rows, red exit
        (s(p_planted_caught), 1, "Traceback (most recent call last):\n", "FAIL"),
        (s(lint=p_lint_lines), 0, "", "ok"),
        (s(lint=p_lint_lines), 1, "a.py:1:1 'os' imported but unused\n", "FAIL"),
        (s(lint=p_lint_lines), 1, "", "FAIL"),                    # red exit, nothing parsed
        (s(lint=p_lint_tsc), 2, "src/a.ts(1,1): error TS2304: Cannot find name 'x'.\n", "FAIL"),
        (s(p_pytest), 0, "....\n4 passed in 0.31s\n", "ok"),
        (s(p_pytest), 0, "==== 3 passed, 2 skipped in 1.02s ====\n", "ok"),
        (s(p_pytest), 1, "==== 1 failed, 3 passed in 1.02s ====\n", "FAIL"),
        (s(p_pytest), 1, "==== 3 passed, 1 error in 1.02s ====\n", "FAIL"),
        (s(p_pytest), 0, "==== 4 skipped in 0.02s ====\n", "FAIL"),        # all skipped
        (s(p_pytest), 5, "no tests ran in 0.01s\n", "FAIL"),
        (s(p_pytest_strict), 0, "==== 261 passed in 110.87s ====\n", "ok"),
        (s(p_pytest_strict), 0, "==== 3 passed, 2 skipped in 1.02s ====\n", "FAIL"),   # the data layer: a skip is red
        (s(p_pytest_strict), 1, "==== 1 failed, 3 passed in 1.02s ====\n", "FAIL"),
        (s(p_node_test_strict), 0, "# tests 5\n# pass 5\n# fail 0\n# skip 0\n", "ok"),
        (s(p_node_test_strict), 0, "# tests 5\n# pass 3\n# fail 0\n# skip 2\n", "FAIL"),
        (s(p_node_test), 0, "# tests 5\n# pass 5\n# fail 0\n", "ok"),
        (s(p_node_test), 1, "# tests 5\n# pass 4\n# fail 1\n", "FAIL"),
        (s(p_node_test), 0, "# tests 0\n", "FAIL"),
        (s(p_node_test), 0, "ℹ tests 3\nℹ pass 3\nℹ fail 0\n", "ok"),
        (s(p_node_test), 1, "ℹ tests 3\nℹ pass 2\nℹ fail 1\n", "FAIL"),
        (s(p_ok_failed_tail), 0, "131 ok, 0 failed, 1 unknown  (249.4 s)\n", "ok"),
        (s(p_charts), 0, "check_charts: 51 chart types, 0 fault(s); 51 not drawn yet; 0 studies read\n", "ok"),
        (s(p_charts), 1, "run: 'Calibration' raised ValueError\ncheck_charts: 51 chart types, 1 fault(s); 0 studies\n", "FAIL"),
        (s(p_charts), 0, "check_charts: 51 chart types, 2 fault(s)\n", "FAIL"),       # faults the exit hid
        (s(p_charts), 0, "check_charts: 0 chart types, 0 fault(s)\n", "FAIL"),        # an empty book checked nothing
        (s(p_charts), 1, "Traceback (most recent call last):\n", "FAIL"),
        (s(p_labels), 0, "check_labels: 0 studies, 0 fault(s); markets from a manifest in 0, from labels.json in 0\n", "ok"),
        (s(p_labels), 0, "check_labels: 0 studies, 0 fault(s); x; app/shared/research.ts absent, closed sets not cross-checked\n", "FAIL"),
        (s(p_labels), 1, "check_labels: 3 studies, 1 fault(s); x\n", "FAIL"),
        (s(p_labels), 0, "", "FAIL"),
        (s(p_ok_failed_tail), 0, "4 ok, 0 failed, 1 warn\n", "ok"),
        (s(p_ok_failed_tail), 0, "12 ok, 0 failed\n", "ok"),
        (s(p_ok_failed_tail), 1, "130 ok, 1 failed, 1 unknown  (2.0 s)\n", "FAIL"),
        (s(p_ok_failed_tail), 0, "0 ok, 0 failed, 5 unknown\n", "FAIL"),    # decided nothing
        (s(p_ok_failed_tail), 0, "", "FAIL"),
        (s(p_right_wrong), 0, "  a clean figure   GREEN (right)\n  a dual axis   RED (right)\n", "ok"),
        (s(p_right_wrong), 1, "  a clean figure   GREEN (right)\n  a dual axis   STAYED GREEN (WRONG)\n", "FAIL"),
        (s(p_right_wrong), 0, "  a clean figure   GREEN (right)\n  a dual axis   STAYED GREEN (WRONG)\n", "FAIL"),   # a miss the exit hid
        (s(p_right_wrong), 1, "  a clean figure   GREEN (right)\n", "FAIL"),   # red exit, rows green
        (s(p_right_wrong), 1, "Traceback (most recent call last):\n", "FAIL"),   # crashed before the rows
    ]
    bad = []
    for i, (suite, rc, out, want) in enumerate(cases):
        got, _ = verdict(suite, rc, out)
        if got != want:
            bad.append(f"case {i}: want {want}, got {got} for {out.strip()[:40]!r}")
    return len(cases), bad


# --------------------------------------------------------------------------- #
# The suites.                                                                  #
# --------------------------------------------------------------------------- #
def suites() -> list[Suite]:
    py = str(VENV_PY)
    app, plat, db = ROOT / "app", ROOT / "platform", ROOT / "database"
    res = plat / "research"
    node = shutil.which("node") or "node"
    me = str(Path(__file__).resolve())
    out = [
        # app: the cockpit. tsc and vitest by their JS entrypoints, so no npx/.cmd shim sits
        # between the timeout and the process tree it has to kill.
        Suite("app", "tsc", [node, "node_modules/typescript/bin/tsc", "--noEmit"], app,
              lint=p_lint_tsc, timeout=600, needs=[app / "node_modules/typescript/bin/tsc"]),
        Suite("app", "vitest", [node, "node_modules/vitest/vitest.mjs", "run", "--maxWorkers=2"],
              app, parse=p_vitest, timeout=1200, needs=[app / "node_modules/vitest/vitest.mjs"]),
        # tools: the machine's own tools (app/tools, app/loop/tools). Every tests/test_*.py is a
        # unittest file and is FOUND, not listed, so a new test file joins the table the day it lands.
        *tool_suites(py),
        Suite("tools", "budget", [py, me, "_smoke-budget"], ROOT, p_ok_failed, timeout=120),
        Suite("tools", "scrub", [py, me, "_smoke-scrub"], ROOT, p_ok_failed, timeout=60),
        # the data law's mechanism: app/ and platform/ open no store, write no data archive, spell
        # no DSN - only through fund_db / @fund/db. Its planted-fault test is the tools.datalaw row
        # (found above); this row scans the real tree.
        Suite("tools", "data-law", [py, "app/tools/datalaw.py"], ROOT, p_ok_failed, timeout=120),
        # the context plan's mechanism: every agent's boot by type against the caps - the base
        # prompt, the agent prompt, the boot chapters, the books and their chapters, and every
        # #chapter a CLAUDE.md cites. Its planted-fault test is the tools.context row (found above);
        # this row scans the real tree.
        Suite("tools", "context-caps", [py, "app/tools/context.py"], ROOT, p_ok_failed_tail, timeout=120),
        Suite("tools", "pyflakes", [py, "-m", "pyflakes", "app/tools", "app/loop/tools"], ROOT,
              lint=p_lint_lines, timeout=300),
        # database: the one data layer. fund_db on the fund venv (pip install -e database), and
        # @fund/db (the cockpit's half) by its own node_modules.
        Suite("database", "pytest", [py, "-m", "pytest", "-q", "-p", "no:cacheprovider"], db,
              p_pytest_strict, timeout=900),                    # a skip is a FAIL here
        Suite("database", "pyflakes", [py, "-m", "pyflakes", "py", "tests", "scripts"], db,
              lint=p_lint_lines, timeout=300),
        Suite("database", "node-tsc", [node, "node_modules/typescript/bin/tsc", "--noEmit"],
              db / "node", lint=p_lint_tsc, timeout=300,
              needs=[db / "node" / "node_modules/typescript/bin/tsc"]),
        Suite("database", "node-test", [node, "--test", "--test-reporter=tap", "--test-concurrency=1",
                                        *sorted(f"test/{f.name}" for f in (db / "node" / "test").glob("*.test.ts"))],
              db / "node", p_node_test_strict, timeout=600, needs=[db / "node" / "node_modules"]),
        # platform: the chart bank (app/library/research/charts*.md) held by its checker, which
        # also RUNS every chapter's draw_ function on synthetic input; the study labels; and the
        # figure style every chart passes. Each checker's selftest plants every fault once.
        Suite("platform", "charts", [py, "research/check_charts.py"], plat, p_charts, timeout=600,
              needs=[res / "check_charts.py"]),
        Suite("platform", "charts-selftest", [py, "research/check_charts.py", "--selftest"], plat,
              p_planted_caught, timeout=600, needs=[res / "check_charts.py"]),
        Suite("platform", "labels", [py, "research/check_labels.py"], plat, p_labels, timeout=120,
              needs=[res / "check_labels.py"]),
        Suite("platform", "labels-selftest", [py, "research/check_labels.py", "--selftest"], plat,
              p_planted_caught, timeout=120, needs=[res / "check_labels.py"]),
        Suite("platform", "figstyle-selftest", [py, "-m", "fundplat.quant.core.figstyle", "--selftest"], plat,
              p_right_wrong, timeout=300),
        Suite("platform", "pyflakes", [py, "-m", "pyflakes", "research", "fundplat"], plat,
              lint=p_lint_lines, timeout=300),
    ]
    for s in out:
        if s.cmd and s.cmd[0] == py:
            s.needs = [VENV_PY, *s.needs]
    return out


def tool_suites(py: str) -> list[Suite]:
    """One suite per app/tools/<pkg>/tests/test_<name>.py, per app/tools/tests/test_<name>.py (the
    top-level tools: clone.py) and per app/loop/tools/tests/test_<name>.py (the loop), named
    <name> (test_loop -> loop)."""
    tools, loop = ROOT / "app" / "tools", ROOT / "app" / "loop" / "tools"
    found = sorted([*tools.glob("*/tests/test_*.py"), *tools.glob("tests/test_*.py"),
                    *loop.glob("tests/test_*.py")])
    return [Suite("tools", f.stem[len("test_"):], [py, f.relative_to(ROOT).as_posix()], ROOT,
                  p_unittest) for f in found]


# --------------------------------------------------------------------------- #
# Running.                                                                     #
# --------------------------------------------------------------------------- #
def run_one(s: Suite, env: dict, logdir: Path) -> tuple[int | None, str]:
    missing = [str(p) for p in s.needs if not Path(p).exists()]
    if missing or not s.cwd.is_dir():
        return 127, "cannot start - missing: " + ", ".join(missing or [str(s.cwd)])
    kw = {}
    if os.name == "nt":
        kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    p = subprocess.Popen(s.cmd, cwd=s.cwd, env={**env, **s.env}, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, **kw)
    try:
        raw, _ = p.communicate(timeout=s.timeout)
        rc = p.returncode
    except subprocess.TimeoutExpired:
        kill_tree(p)
        raw, _ = p.communicate()
        rc = None
    out = ANSI.sub("", raw.decode("utf-8", errors="replace")).replace("\r\n", "\n")
    (logdir / f"{s.key}.log").write_text(
        f"$ {' '.join(map(str, s.cmd))}\n# cwd {s.cwd}\n# exit {rc}\n\n{out}",
        encoding="utf-8", newline="\n")
    return rc, out


def kill_tree(p: subprocess.Popen) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        p.kill()


def child_env(floor: Path) -> dict:
    env = dict(os.environ)
    env.update({
        "FUND_ROOT": str(ROOT),
        "FUND_FLOOR": str(floor),             # never overwrite a real probe reading
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "MPLBACKEND": "Agg",
        "NO_COLOR": "1",
        "FORCE_COLOR": "0",
        "CI": "1",                            # vitest: no watch mode, no TTY reporter
    })
    return env


def select(all_suites: list[Suite], only: list[str]) -> list[Suite]:
    if not only:
        return all_suites
    want = [w.strip().lower() for chunk in only for w in chunk.split(",") if w.strip()]
    keys = {s.key for s in all_suites}
    bad = [w for w in want if w not in AREAS and w not in keys]
    if bad:
        raise SystemExit(f"check: unknown --only {', '.join(bad)} "
                         f"(areas: {', '.join(AREAS)}; or area.suite, see --list)")
    return [s for s in all_suites if s.area in want or s.key in want]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Run every suite in the fund; one table.")
    ap.add_argument("--fast", action="store_true", help="skip the live (network) suites")
    ap.add_argument("--only", action="append", default=[], metavar="AREA",
                    help=f"{'|'.join(AREAS)} or area.suite; repeat or comma-separate")
    ap.add_argument("--list", action="store_true", help="print the suites and exit")
    ap.add_argument("--json", action="store_true", help="print the result as JSON")
    ap.add_argument("--tail", type=int, default=15, help="lines of a failed suite's output")
    a = ap.parse_args(argv)

    try:
        chosen = select(suites(), a.only)
    except SystemExit as e:
        print(e, file=sys.stderr)
        return 2
    if a.list:
        for s in chosen:
            live = "  [live]" if s.live else ""
            print(f"{s.key:28} {s.cwd.relative_to(ROOT) if s.cwd != ROOT else '.'}{live}")
        return 0

    logdir = Path(tempfile.gettempdir()) / "fund-check"
    logdir.mkdir(parents=True, exist_ok=True)
    floor = Path(tempfile.mkdtemp(prefix="fund-check-floor-"))
    env = child_env(floor)
    rows = []
    t_all = time.monotonic()

    n_cases, bad = verdict_rules()            # the rules first: a broken judge judges nothing
    rows.append({"area": "check", "suite": "verdict rules", "status": "ok" if not bad else "FAIL",
                 "count": f"{n_cases - len(bad)}/{n_cases}",
                 "secs": 0.0, "tail": bad})
    if not a.json:
        print(f"{'area':11} {'suite':20} {'result':7} {'count':>14} {'time':>7}")
        _print_row(rows[-1])

    for s in chosen:
        if a.fast and s.live:
            new = [{"area": s.area, "suite": s.name, "status": "skip", "count": "live",
                    "secs": 0.0, "tail": []}]
        else:
            t0 = time.monotonic()
            rc, out = run_one(s, env, logdir)
            if rc == 127 and out.startswith("cannot start"):
                many = [(s.name, "FAIL", "cannot start")]
            elif s.rows is not None:
                many = s.rows(s, rc, out)          # one row per item
            else:
                many = [(s.name, *verdict(s, rc, out))]
            secs = round(time.monotonic() - t0, 1)
            first_fail = next((i for i, m in enumerate(many) if m[1] == "FAIL"), None)
            new = [{"area": s.area, "suite": name, "status": status, "count": count,
                    "secs": secs if i == 0 else 0.0,
                    "tail": [scrub(ln) for ln in out.strip().splitlines()[-a.tail:]]
                    if i == first_fail else [],
                    "log": scrub(str(logdir / f"{s.key}.log"))}
                   for i, (name, status, count) in enumerate(many)]
        rows.extend(new)
        if not a.json:
            for r in new:
                _print_row(r)
    shutil.rmtree(floor, ignore_errors=True)

    n_ok = sum(r["status"] == "ok" for r in rows)
    n_fail = sum(r["status"] == "FAIL" for r in rows)
    n_skip = sum(r["status"] == "skip" for r in rows)
    n_unk = sum(r["status"] == "unknown" for r in rows)
    secs = time.monotonic() - t_all
    if a.json:
        print(json.dumps({"ts": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                          "ok": n_ok, "failed": n_fail, "skipped": n_skip, "unknown": n_unk,
                          "secs": round(secs, 1), "logs": scrub(str(logdir)), "rows": rows}, indent=2))
        return 1 if n_fail else 0
    _print_failures(rows)
    print(f"\n{n_ok} ok · {n_fail} failed · {n_skip} skipped"
          + (f" · {n_unk} unknown" if n_unk else "") + f" · {secs:.0f}s"
          + ("" if not n_fail else "  -> RED"))
    return 1 if n_fail else 0


def _print_failures(rows: list[dict]) -> None:
    for r in rows:
        if r["status"] == "FAIL" and r["tail"]:
            print(f"\n--- {r['area']}.{r['suite']} (last {len(r['tail'])} lines"
                  + (f"; full log {scrub(r['log'])}" if r.get("log") else "") + ")")
            for ln in r["tail"]:
                print("  " + scrub(ln[:200]))


def _print_row(r: dict) -> None:
    t = f"{r['secs']:.0f}s" if r["status"] != "skip" else "-"
    print(f"{r['area']:11} {r['suite']:20} {r['status']:7} {r['count']:>14} {t:>7}", flush=True)


# --------------------------------------------------------------------------- #
# The smokes this file owns, each run in a fresh interpreter (see suites()).  #
# --------------------------------------------------------------------------- #
class _Tally:
    def __init__(self):
        self.ok = self.fail = 0

    def __call__(self, name: str, cond: bool, detail: str = "") -> None:
        if cond:
            self.ok += 1
        else:
            self.fail += 1
            print(f"  FAIL {name}" + (f": {detail}" if detail else ""))

    def done(self) -> int:
        print(f"\n{self.ok} ok, {self.fail} failed")
        return 1 if self.fail else 0


def smoke_budget() -> int:
    """The token meter and its gate against a SCRATCH fund root and transcript dir, with the
    expected numbers written here by hand (never read back from usage.py itself):
    two in-window rows under platform/ (input 100 + cache-creation 20 + output 7 = 127
    billable, 1,127 with cache reads), one row outside the tree and one 5 days old that must
    not count, and a platform ceiling of 100 that the gate must REFUSE."""
    t = _Tally()
    tmp = Path(tempfile.mkdtemp(prefix="fund-check-budget-"))
    try:
        root, proj = tmp / "fund", tmp / "projects" / "C--fund"
        (root / "platform").mkdir(parents=True)
        proj.mkdir(parents=True)
        # the roster: one app/agents/<id>.md per agent, a YAML header over the brief
        (root / "app" / "agents").mkdir(parents=True)
        (root / "app" / "agents" / "fund.md").write_text(
            "---\nid: fund\nname: fund\nkind: standing\nmode: active\ndept: HQ\nrole: r\n"
            "cwd: .\nmodel: opus\neffort: high\nwrites: []\nboot: []\n---\n\nbrief\n", encoding="utf-8")
        (root / "app" / "agents" / "platform.md").write_text(
            "---\nid: platform\nname: platform\nkind: standing\nmode: active\ndept: Build\nrole: r\n"
            "cwd: platform\nmodel: opus\neffort: high\nbudgetTokensPerDay: 100\nwrites: []\nboot: []\n"
            "---\n\nbrief\n", encoding="utf-8")
        now = dt.datetime.now(dt.timezone.utc)

        def row(cwd, when, i, o):
            return json.dumps({
                "type": "assistant", "cwd": str(cwd), "sessionId": "s1",
                "timestamp": when.isoformat().replace("+00:00", "Z"),
                "message": {"model": "claude-opus-x", "usage": {
                    "input_tokens": i, "cache_creation_input_tokens": 10,
                    "cache_read_input_tokens": 500, "output_tokens": o}}})
        (proj / "s1.jsonl").write_text("\n".join([
            row(root / "platform", now, 50, 3),
            row(root / "platform", now, 50, 4),
            row(tmp / "elsewhere", now, 9999, 9999),                  # outside the tree
            row(root / "platform", now - dt.timedelta(days=5), 7777, 7777),   # outside window
        ]) + "\n", encoding="utf-8")
        env = dict(os.environ, FUND_ROOT=str(root), CLAUDE_PROJECTS_DIR=str(tmp / "projects"),
                   FUND_FLOOR=str(tmp / "floor"), PYTHONIOENCODING="utf-8")
        budget = ROOT / "app" / "tools" / "budget"

        def call(script, *args):
            p = subprocess.run([sys.executable, str(budget / script), *args], env=env,
                               capture_output=True, text=True, encoding="utf-8", timeout=60)
            return p.returncode, p.stdout, p.stderr

        for metric, want in (("billable", 127), ("all", 1127)):
            rc, out, err = call("usage.py", "--json", "--no-health", "--metric", metric)
            try:
                rows = json.loads(out)["rows"]
            except ValueError:
                t(f"usage --metric {metric} emits JSON", False, (err or out)[:160])
                continue
            plat = [r for r in rows if r["seat"] == "platform"]
            t(f"usage --metric {metric}: exit 0", rc == 0, f"exit {rc}")
            t(f"usage --metric {metric}: only the platform seat", [r["seat"] for r in rows]
              == ["platform"], str([r["seat"] for r in rows]))
            t(f"usage --metric {metric}: used == {want}", bool(plat) and plat[0]["used"] == want,
              str(plat[0]["used"] if plat else None))
        t("usage wrote no health row under --no-health", not (tmp / "floor").exists())
        rc, out, err = call("check.py", "platform", "--json")
        t("gate REFUSES platform at 127 > 100 (exit 1)", rc == 1, f"exit {rc} {err[:120]}")
        try:
            t("gate reports used 127, over", json.loads(out).get("used") == 127
              and json.loads(out).get("over") is True, out[:160])
        except ValueError:
            t("gate emits JSON", False, out[:160])
        rc, out, err = call("check.py", "fund")
        t("gate passes a seat with no ceiling (exit 0)", rc == 0, f"exit {rc}")
        rc, out, err = call("check.py", "nosuchseat")
        t("gate answers 2 for an unknown seat", rc == 2, f"exit {rc}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return t.done()


def smoke_scrub() -> int:
    """No line check.py prints carries the home directory. A red row is built by hand with the real
    temp dir and home in its log path and tail, and the failure block is captured: drop scrub()
    from the printing and the home path appears, and this row goes red."""
    import contextlib
    import io

    t = _Tally()
    home = str(Path.home())
    fwd = home.replace("\\", "/")
    log = str(Path(tempfile.gettempdir()) / "fund-check" / "app.vitest.log")
    rows = [{"area": "app", "suite": "vitest", "status": "FAIL", "count": "1/2", "secs": 1.0,
             "tail": [f"  at {home}\\dev\\fund\\app\\x.ts:3", f"  at {fwd}/y.ts", f"'{home}'"],
             "log": log}]
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        _print_failures(rows)
    shown = buf.getvalue()
    t("the failure block printed", "full log" in shown, shown[:160])
    t("no printed line contains the home directory",
      home.lower() not in shown.lower() and fwd.lower() not in shown.lower(), shown[:300])
    t("the log path is shown under %TEMP% or ~", "full log %TEMP%" in shown or "full log ~" in shown,
      shown[:200])
    t("the tail keeps the rest of the path", "dev\\fund\\app\\x.ts:3" in shown and "/y.ts" in shown, shown[:300])
    t("a repo-relative path is left alone", scrub("app/tools/check.py:3") == "app/tools/check.py:3")
    t("a sibling of home is left alone", scrub(home + "x\\a") == home + "x\\a")
    return t.done()


if __name__ == "__main__":
    if sys.argv[1:2] == ["_smoke-scrub"]:
        sys.exit(smoke_scrub())
    if sys.argv[1:2] == ["_smoke-budget"]:
        sys.exit(smoke_budget())
    sys.exit(main())
