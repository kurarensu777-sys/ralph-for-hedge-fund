#!/usr/bin/env python3
"""Shared machinery for the fixed-age loop tools.

Everything here reads and writes the desk files track A owns. Two rules govern
every writer in this folder:

  APPEND, NEVER REWRITE. `data/runs.jsonl` is append-only with `merge=union`
  (snapshot rows, append-only too, live OUTSIDE the repo since 2026-09-25 -
  `snapshots.py`, `Desk.snapshots`), and prose entries in `results-log.md` are
  appended at the end of their section. The one exception is a LEDGER CELL
  that currently holds a placeholder (`-`), which is filled exactly once; a
  cell that already holds a value is refused, because a fixed-age read is
  write-once by contract and an overwritten read is a number nobody can date.

  BE TOLERANT OF SHAPE, STRICT ABOUT FACTS. Track A writes these files by
  hand and will keep editing them. Parsers here accept whitespace, missing
  sections and reordered columns; they never accept a missing window, an
  unnamed mechanic, or a prediction that is not a band.

Stdlib only.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# --------------------------------------------------------------------------
# paths
# --------------------------------------------------------------------------




def _load_root():
    """app/tools/_root.py, loaded by path (no sys.path edit): the one fund_root() and layout.
    This file is app/loop/tools/_common.py, so the helper is two folders up, then tools/."""
    import importlib.util
    path = Path(__file__).resolve().parents[2] / "tools" / "_root.py"
    spec = importlib.util.spec_from_file_location("fund_tools_root", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_ROOT = _load_root()


def fund_root() -> Path:
    return _ROOT.fund_root()


# The layout and the legacy maps: ONE copy, in app/tools/_root.py. LAB is the LOGICAL
# desk prefix (every desk id reads lab/<name>); the folder is wherever the lab is on
# disk (platform/lab since 2026-09-25, _ROOT.lab_rel).
LAB = _ROOT.LAB
PLATFORM = _ROOT.PLATFORM
RESEARCH = _ROOT.RESEARCH          # platform/research (the root's research/ before 2026-09-25)
_LEGACY_CWD = _ROOT.LEGACY_CWD


def platform_root(root: Path | None = None) -> Path:
    return (root or fund_root()) / PLATFORM


def research_root(root: Path | None = None) -> Path:
    """The notebooks: platform/research (the research repo at the root before 2026-09-25)."""
    r = root or fund_root()
    return r / _ROOT.research_rel(r)


def fund_python(root: Path | None = None) -> str:
    """The fund's ONE venv (the platform is installed into it, editable)."""
    v = (root or fund_root()) / ".venv"
    for rel in ("Scripts/python.exe", "bin/python", "bin/python3"):
        p = v / rel
        if p.is_file():
            return str(p)
    return ""


def resolve_cwd(cwd: str | None, root: Path | None = None) -> Path:
    """A run's recorded cwd (fund-relative) -> an absolute path. Empty means the
    platform repo, which is where every engine entrypoint runs."""
    root = root or fund_root()
    c = (cwd or "").replace("\\", "/").strip("/")
    if not c:
        return root / PLATFORM
    for old, new in _LEGACY_CWD:
        if c == old or c.startswith(old + "/"):
            c = new + c[len(old):]
            break
    return root / c


class Refuse(Exception):
    """A contract violation. Printed, never traced."""


# --------------------------------------------------------------------------
# io
# --------------------------------------------------------------------------

def read_text(p: Path, default: str = "") -> str:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return default


def write_text(p: Path, text: str) -> None:
    """LF always - .gitattributes pins these files and a CRLF writer turns a
    one-line edit into a whole-file diff nobody can review."""
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def append_text(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8", newline="\n") as f:
        f.write(text)


def read_jsonl(p: Path) -> list[dict]:
    rows = []
    for line in read_text(p).splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def append_jsonl(p: Path, obj: dict) -> None:
    append_text(p, json.dumps(obj, ensure_ascii=False, sort_keys=True) + "\n")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


# --------------------------------------------------------------------------
# desks
# --------------------------------------------------------------------------

REQUIRED_FILES = ("cadence.md", "beliefs.md", "results-log.md", "mechanics.md", "menu.md")


@dataclass
class Desk:
    """A lab desk. `rel` is its LOGICAL id (`lab/platform/carry`): the spelling every
    ledger row, snapshot key and message carries, stable across moves. `folder` is
    where its files are, fund-relative (`platform/lab/platform/carry` since
    2026-09-25), and `repo` the git repo that holds them (platform/, else the root)."""
    root: Path
    rel: str

    @property
    def folder(self) -> str:
        return _ROOT.desk_rel(self.rel, self.root)

    @property
    def path(self) -> Path:
        return self.root / self.folder

    @property
    def repo(self) -> Path:
        return _ROOT.repo_of(self.root, self.folder)

    def f(self, name: str) -> Path:
        return self.path / name

    @property
    def runs(self) -> Path:
        return self.path / "data" / "runs.jsonl"

    @property
    def snapshots(self) -> str:
        """Where this desk's snapshot rows live, said: its log of the fund_db lake's snapshots
        dataset (snapshots.py). Read rows with snapshot_rows(), which merges the older homes
        (the retired file store, the tracked history) in first."""
        return f"the fund_db lake, snapshots log {_snapshots().desk_key(self.rel)!r}"

    def snapshot_rows(self) -> list[dict]:
        return _snapshots().read(self.rel, self.root)

    @property
    def label(self) -> str:
        return self.rel


_SNAP = None


def _snapshots():
    """snapshots.py beside this file, loaded by path once (no sys.path edit)."""
    global _SNAP
    if _SNAP is None:
        import importlib.util
        path = Path(__file__).resolve().parent / "snapshots.py"
        spec = importlib.util.spec_from_file_location("fund_snapshots", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _SNAP = mod
    return _SNAP


# Desk ids before the 2026-09-24 rename: READ as their new name, never rewritten
# (the table and its reasons live in app/tools/_root.py).
_LEGACY_DESK = _ROOT.LEGACY_DESK


def canonical_desk(spec: str) -> str:
    """Any desk id (current `lab/...`, its folder `platform/lab/...`, pre-rename
    `lab/api/...`, pre-cut-over `desks/...`, or a bare fragment) -> its current
    lab-relative fragment, e.g. `platform/carry` (app/tools/_root.py desk_name)."""
    return _ROOT.desk_name(spec)


def resolve_desk(spec: str, root: Path | None = None) -> Desk:
    """Accepts a lab path (`lab/platform/carry`), a path fragment (`platform/carry`),
    an old id (`lab/api/lib/carry`, `desks/api/lib/carry`, `api/lib/carry` - read as
    `lab/platform/carry`), or a desk's leaf name when exactly one desk carries it
    (`carry`, `exchange_c`)."""
    root = root or fund_root()
    s = canonical_desk(spec)
    if s and (_ROOT.desk_dir(s, root) / "cadence.md").is_file():
        return Desk(root, f"{LAB}/{s}")
    if s and "/" not in s:
        hits = [d for d in all_desks(root) if d.rel.rsplit("/", 1)[-1] == s]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            raise Refuse(f"{spec!r} names {len(hits)} desks ({', '.join(d.rel for d in hits)}); "
                         f"give the lab path")
    raise Refuse(f"no desk {spec!r} (a desk is a folder under {_ROOT.lab_rel(root)}/ holding a cadence.md)")


# Folders INSIDE a desk that are never desks themselves. `data` is only skipped
# when it is a desk's own ledger folder (it sits beside a cadence.md): the desk
# `lab/platform/data` and everything under it is named `data` too, and a blanket skip
# hid every one of them.
_NEVER_DESKS = (".git", "__pycache__", "issues", "levers", "memory", "reads")


def all_desks(root: Path | None = None) -> list[Desk]:
    """Every folder under the lab holding a cadence.md, as a desk with its logical id."""
    root = root or fund_root()
    base = root / _ROOT.lab_rel(root)
    out = []
    if not base.is_dir():
        return out
    for dirpath, dirnames, filenames in os.walk(base):
        is_desk = "cadence.md" in filenames
        dirnames[:] = [d for d in dirnames
                       if d not in _NEVER_DESKS and not (is_desk and d == "data")]
        if is_desk:
            out.append(Desk(root, f"{LAB}/{Path(dirpath).relative_to(base).as_posix()}"))
    return sorted(out, key=lambda d: d.rel)


def desk_state(desk: Desk) -> str:
    """The `**State: PRE-LIVE | OPENING | LIVE.**` line near the top of
    cadence.md. Searched over the opening lines rather than pinned to line 1,
    because every real file opens with its `# title` first. A line that still
    carries every option is PRE-LIVE - unfilled, not live."""
    head = "\n".join(read_text(desk.f("cadence.md")).splitlines()[:12])
    m = re.search(r"State:\s*([A-Z \-|]+)", head)
    if not m:
        return "UNKNOWN"
    txt = m.group(1)
    opts = [o.strip() for o in txt.split("|") if o.strip()]
    if len(opts) > 1:
        return "PRE-LIVE"       # the template line, untouched
    return opts[0] if opts else "UNKNOWN"


# --------------------------------------------------------------------------
# banded predictions
# --------------------------------------------------------------------------

_NUM = r"[-+]?\d+(?:\.\d+)?"
_BAND = re.compile(rf"^\s*({_NUM})\s*(?:to|\.\.|-{{1,2}}>?|–)\s*({_NUM})\s*$", re.I)
_OPEN = re.compile(rf"^\s*(>=|<=|>|<)\s*({_NUM})\s*$")
_POINT = re.compile(rf"^\s*({_NUM})\s*$")


@dataclass
class Band:
    raw: str
    lo: float | None
    hi: float | None
    kind: str          # "band" | "open" | "count"

    def contains(self, v: float) -> bool:
        if self.lo is not None and v < self.lo - 1e-12:
            return False
        if self.hi is not None and v > self.hi + 1e-12:
            return False
        return True

    @property
    def width(self) -> float | None:
        if self.lo is None or self.hi is None:
            return None
        return abs(self.hi - self.lo)


def parse_band(raw: str) -> Band:
    """`20 to 30` · `20..30` · `-6 to -2` · `>= 0` · `0` (a COUNT only).

    A bare non-integer point estimate is refused: calibrating the judge is the
    point of pre-registration, and a point estimate cannot be calibrated - it
    is either exactly right, which never happens, or wrong, which teaches
    nothing about how wrong."""
    s = str(raw).strip()
    m = _BAND.match(s)
    if m:
        lo, hi = float(m.group(1)), float(m.group(2))
        return Band(s, min(lo, hi), max(lo, hi), "band")
    m = _OPEN.match(s)
    if m:
        op, v = m.group(1), float(m.group(2))
        return Band(s, v if op in (">=", ">") else None,
                    v if op in ("<=", "<") else None, "open")
    m = _POINT.match(s)
    if m:
        v = float(m.group(1))
        if abs(v - round(v)) > 1e-9:
            raise Refuse(f"prediction {s!r} is a point estimate, not a band. "
                         f"Write it as a range (`{v - abs(v) * .2:.2f} to {v + abs(v) * .2:.2f}`) "
                         f"or, for a COUNT, as an integer.")
        return Band(s, v, v, "count")
    raise Refuse(f"prediction {raw!r} is not a band. Use `lo to hi`, `lo..hi`, "
                 f">= n, <= n, or an integer count.")


def parse_predictions(pairs: list[str]) -> dict[str, str]:
    """`--predict ann_pct=20..30` -> {"ann_pct": "20..30"}, each validated."""
    out: dict[str, str] = {}
    for p in pairs:
        if "=" not in p:
            raise Refuse(f"--predict {p!r} must be metric=band (e.g. ann_pct=20..30)")
        k, v = p.split("=", 1)
        k = k.strip()
        if not k:
            raise Refuse(f"--predict {p!r} has no metric name")
        parse_band(v)                    # validate now, store raw
        out[k] = v.strip()
    return out


def parse_kv_numbers(pairs: list[str], flag: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for p in pairs:
        if "=" not in p:
            raise Refuse(f"{flag} {p!r} must be name=number")
        k, v = p.split("=", 1)
        try:
            out[k.strip()] = float(v.strip())
        except ValueError:
            raise Refuse(f"{flag} {p!r}: {v!r} is not a number") from None
    return out


# --------------------------------------------------------------------------
# runs.jsonl
# --------------------------------------------------------------------------
# `stage` is this toolchain's one addition to the run-record shape (app/library/law/
# the-lab-loop.md#the-desk-template, the runs.jsonl row), which allows added fields. A run id is unique PER STAGE:
#   preflight  written BEFORE execution, carries `predicted`, no metrics
#   result     written after, carries `metrics` and `verify`
#   read       one per fixed age (+7d, +30d), carries `age` and the ROLLED window
# Readers key on (run, stage); preregister.py and record.py refuse a second
# preflight or result per run, and a result with no preflight.

STAGES = ("preflight", "result", "read")

# `preregistered: false` marks an IMPORTED row - history transcribed from the
# code repo's record by `backfill.py`, carrying a `provenance` that says where
# it came from. Such a row is evidence and is NEVER a prediction: it has no
# pre-flight by construction, so grade.py must not score it, retro_due.py must
# not count it as a run the desk chose, and nothing may demand the pre-flight
# it deliberately does not have.


def runs(desk: Desk) -> list[dict]:
    return read_jsonl(desk.runs)


def is_import(row: dict) -> bool:
    """True for a backfilled row. The test is the EXPLICIT `preregistered:
    false`, never a missing pre-flight - a result that simply lost its
    pre-flight is a defect, and it must keep looking like one."""
    return row.get("preregistered") is False


def graded_results(desk: Desk) -> list[dict]:
    """Result rows that a judge can be scored on: pre-registered ones only."""
    return [r for r in runs(desk) if r.get("stage") == "result" and not is_import(r)]


def run_rows(desk: Desk, run_id: str, stage: str | None = None) -> list[dict]:
    return [r for r in runs(desk)
            if r.get("run") == run_id and (stage is None or r.get("stage") == stage)]


def run_ids(desk: Desk) -> list[str]:
    seen, out = set(), []
    for r in runs(desk):
        rid = r.get("run")
        if rid and rid not in seen:
            seen.add(rid)
            out.append(rid)
    return out


# --------------------------------------------------------------------------
# results-log.md
# --------------------------------------------------------------------------

LEDGER_HEAD = re.compile(r"^\|\s*Run\s*\|", re.I | re.M)
PREFLIGHT_RE = re.compile(r"\*\*Pre-flight:\*\*(.+?)(?:\n\n|\n\*\*|\Z)", re.S)
ENTRY_RE = re.compile(r"^###\s+(\S+)\s*[-–]\s*(.*)$", re.M)
CITE_RE = re.compile(r"\bB(\d+)\b")


def results_log(desk: Desk) -> str:
    return read_text(desk.f("results-log.md"))


def strip_fences(text: str) -> str:
    """Blank every fenced block, PRESERVING length and line count.

    THE EXAMPLE CONTRACT. A results-log carries a worked example of an entry so
    a hand can see the shape. Unfenced, that example parses as a RUN: every
    desk scaffolded from `_template` reported a `### 001` entry with a
    `**Result:**` line and no `data/runs.jsonl` row behind it - twenty findings
    that were one piece of template text. So the example is FENCED, and every
    parser here blanks fenced blocks before it looks for an entry.

    Length is preserved so an offset into the blanked text is the same offset
    into the original, and a caller can slice the ORIGINAL by it.
    """
    out, fence = [], None
    for line in text.split("\n"):
        s = line.lstrip()
        marker = s[:3] if s[:3] in ("```", "~~~") else ""
        if fence is None:
            if marker:
                fence = marker
                out.append(" " * len(line))
            else:
                out.append(line)
            continue
        out.append(" " * len(line))
        if marker == fence:
            fence = None
    return "\n".join(out)


def entry_ids(text: str) -> list[str]:
    """Every `### <id>` entry that is not fenced and not a placeholder."""
    scan = strip_fences(text)
    body = scan.split("## Entries", 1)[1] if "## Entries" in scan else scan
    return [m.group(1) for m in re.finditer(r"^###\s+(\S+)\s", body, re.M)
            if not m.group(1).startswith("<")]


def has_result(desk: Desk, run_id: str) -> bool:
    """True if a RESULT has already been recorded for this run - in runs.jsonl
    or as a `**Result:**` line inside that run's entry."""
    if run_rows(desk, run_id, "result"):
        return True
    ent = entry_block(results_log(desk), run_id)
    # `- **Result:** pending ...` is the slot preregister.py writes, not a result.
    # Reading it as one made the first record() at every desk refuse itself.
    return bool(ent and re.search(r"^\s*-?\s*\*\*Result:\*\*\s*(?!pending\b)\S", ent, re.M))


def entry_block(text: str, run_id: str) -> str | None:
    """The `### <run_id> - ...` block, up to the next `### ` or EOF.

    Located in the FENCE-BLANKED text and sliced out of the original, so a
    fenced example is invisible here while the returned string is still a
    verbatim slice a caller can `text.replace(...)` with."""
    scan = strip_fences(text)
    m = re.search(rf"^###\s+{re.escape(run_id)}\b.*$", scan, re.M)
    if not m:
        return None
    start = m.start()
    nxt = re.search(r"^###\s+", scan[m.end():], re.M)
    return text[start:m.end() + nxt.start()] if nxt else text[start:]


def entry_with_line(ent: str, line: str) -> str:
    """`ent` with `line` after its last non-blank line. The blank line that ends the entry
    (the one before the next `###`) stays where it was, so a read never glues an entry to
    the heading below it."""
    body = ent.rstrip("\n")
    tail = ent[len(body):] or "\n"
    return body + "\n" + line.rstrip("\n") + tail


def append_entry(desk: Desk, block: str) -> None:
    """Append under `## Entries`, or at EOF when the section is missing."""
    p = desk.f("results-log.md")
    text = read_text(p)
    if not text.endswith("\n"):
        text += "\n"
    if "## Entries" not in text:
        text += "\n---\n\n## Entries\n"
    write_text(p, text.rstrip("\n") + "\n\n" + block.strip("\n") + "\n")


def ledger_columns(text: str) -> list[str]:
    m = LEDGER_HEAD.search(text)
    if not m:
        return []
    line = text[m.start():].splitlines()[0]
    return [c.strip() for c in line.strip().strip("|").split("|")]


def append_ledger_row(desk: Desk, cells: dict[str, str]) -> bool:
    """Add one row to the ledger table, in ITS column order. Replaces the
    template's placeholder `| - | - | ... |` row the first time."""
    p = desk.f("results-log.md")
    text = read_text(p)
    cols = ledger_columns(text)
    if not cols:
        return False
    row = "| " + " | ".join(str(cells.get(c, "-")) or "-" for c in cols) + " |"
    lines = text.splitlines()
    head_i = next(i for i, ln in enumerate(lines) if LEDGER_HEAD.match(ln))
    i = head_i + 2                      # header, separator
    placeholder = None
    while i < len(lines) and lines[i].strip().startswith("|"):
        if set(lines[i].replace("|", "").replace("-", "").strip()) == set():
            placeholder = i
        i += 1
    if placeholder is not None:
        lines[placeholder] = row
    else:
        lines.insert(i, row)
    write_text(p, "\n".join(lines) + "\n")
    return True


def ledger_cells(line: str, cols: list[str]) -> list[str] | None:
    """A ledger row's cells, one per column, or None when it does not fit.

    A headline can hold a pipe (pm-001: `median |mid gap|`), so the row splits into more
    cells than the table has columns. The surplus belongs to the Headline column, the one
    free-text cell: the segments from it up to the surplus are joined back with their pipes.
    Any other width mismatch is not a row of this table."""
    raw = line.strip().strip("|").split("|")
    extra = len(raw) - len(cols)
    if extra > 0:
        hi = next((i for i, c in enumerate(cols) if c.lower() == "headline"), None)
        if hi is None:
            return None
        raw[hi:hi + extra + 1] = ["|".join(raw[hi:hi + extra + 1])]
    cells = [c.strip() for c in raw]
    return cells if len(cells) == len(cols) else None


def fill_ledger_cell(desk: Desk, run_id: str, column: str, value: str) -> str:
    """Write-once. Returns "written" | "occupied:<value>" | "no-row" | "no-column"."""
    p = desk.f("results-log.md")
    text = read_text(p)
    cols = ledger_columns(text)
    if column not in cols:
        return "no-column"
    ci = cols.index(column)
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        if not ln.strip().startswith("|"):
            continue
        cells = ledger_cells(ln, cols)
        if cells is None or cells[0] != run_id:
            continue
        cur = cells[ci]
        if cur not in ("", "-", "·", "pending", "—"):
            return f"occupied:{cur}"
        cells[ci] = value
        lines[i] = "| " + " | ".join(cells) + " |"
        write_text(p, "\n".join(lines) + "\n")
        return "written"
    return "no-row"


# --------------------------------------------------------------------------
# beliefs.md / mechanics.md
# --------------------------------------------------------------------------

BELIEF_RE = re.compile(r"^###\s+B(\d+)\s*(?:·|\|)?\s*(.*)$", re.M)
STAMP_RE = re.compile(
    r"Last retro:\s*(?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2}|none[^·\n]*)"
    r"(?:\s*·\s*through run\s*(?P<run>[^\s·]+))?"
    r"(?:\s*·\s*next bet:\s*(?P<bet>[^\n`]*))?", re.I)
TIER_RE = re.compile(r"\b(WEAK|MEDIUM|STRONG)\b")
MECH_ROW = re.compile(r"^\|\s*(M\d+)\s*\|", re.M)


def beliefs(desk: Desk) -> dict[str, dict]:
    """{"B1": {"claim","tier","body","would_change","kill_test"}} - tolerant."""
    text = read_text(desk.f("beliefs.md"))
    out: dict[str, dict] = {}
    # THE EXAMPLE CONTRACT, as results_log keeps it: a belief inside a fence is an example, never a
    # belief. Until 2026-10-03 every desk scaffolded from the template parsed its fenced
    # `### B1 · <the claim, in one sentence>` as a real B1 (the context plan's lab trim, B-0344).
    # strip_fences keeps offsets, so each body is still sliced from the original text.
    ms = list(BELIEF_RE.finditer(strip_fences(text)))
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
        body = text[m.end():end]
        head = m.group(2)
        tier = TIER_RE.search(head + " " + body[:200])
        out[f"B{m.group(1)}"] = {
            "claim": head.strip(),
            "tier": tier.group(1) if tier else "",
            "body": body,
            "would_change": bool(re.search(r"would change it", body, re.I)),
            "kill_test": bool(re.search(r"kill test", body, re.I)),
            "placeholder": head.strip().startswith("<"),
        }
    return out


def retro_stamp(desk: Desk) -> dict:
    text = read_text(desk.f("beliefs.md"))
    m = STAMP_RE.search(text)
    if not m:
        return {"found": False, "date": None, "run": None, "bet": None}
    raw = (m.group("date") or "").strip()
    return {"found": True,
            "date": raw if re.match(r"^\d{4}-\d{2}-\d{2}$", raw) else None,
            "raw_date": raw,
            "run": (m.group("run") or "").strip() or None,
            "bet": (m.group("bet") or "").strip() or None}


def mechanics(desk: Desk) -> list[str]:
    return MECH_ROW.findall(read_text(desk.f("mechanics.md")))


def cited_beliefs(text: str) -> set[str]:
    """Every `B<n>` token in a body of prose. Deliberately greedy: a citation
    that resolves to nothing is the finding, so over-collecting here and
    resolving against beliefs.md is the safe direction."""
    return {f"B{n}" for n in CITE_RE.findall(text)}


# --------------------------------------------------------------------------
# git
# --------------------------------------------------------------------------

def repo_sha(repo: Path) -> str:
    import subprocess
    try:
        p = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(repo),
                           capture_output=True, text=True, timeout=20)
        return p.stdout.strip() if p.returncode == 0 else ""
    except Exception:                    # noqa: BLE001
        return ""


def platform_sha(root: Path | None = None) -> str:
    """The code version a result was produced on: the PLATFORM repo's HEAD
    (the engines live there, whichever repo the command ran from)."""
    return repo_sha(platform_root(root))


def research_sha(root: Path | None = None) -> str:
    return repo_sha(research_root(root))


def runs_in_research(cwd: str | None, root: Path | None = None) -> bool:
    root = root or fund_root()
    try:
        resolve_cwd(cwd, root).resolve().relative_to(research_root(root).resolve())
        return True
    except ValueError:
        return False


def code_commits(cwd: str | None, root: Path | None = None) -> dict:
    """{"platform_commit": sha[, "research_commit": sha]} - the second only when
    the command runs inside the research repo (a notebook), where the notebook's
    own version is part of what was run."""
    out = {"platform_commit": platform_sha(root)}
    if runs_in_research(cwd, root):
        out["research_commit"] = research_sha(root)
    return out


# --------------------------------------------------------------------------
# the pre-flight commit - git order, not a ts field, proves the prediction came first
# --------------------------------------------------------------------------

def git(repo: Path, *args: str, timeout: int = 60):
    import subprocess
    return subprocess.run(["git", *args], cwd=str(repo), capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=timeout)


def git_repo_root(root: Path) -> Path:
    """The repo that holds a desk (Desk.repo: platform/ since 2026-09-25, the fund root
    before), proven to be the TOP of its own git repository. A folder that is not a
    repo, or that sits inside another repo, is refused: `git commit` would otherwise
    walk up and write into whatever repo encloses it."""
    p = git(root, "rev-parse", "--show-toplevel")
    if p.returncode != 0:
        raise Refuse(f"{root} is not a git repository. The pre-flight is proven by its own "
                     f"commit; with no repo there is nothing to prove it with.")
    top = Path(p.stdout.strip()).resolve()
    if os.path.normcase(str(top)) != os.path.normcase(str(Path(root).resolve())):
        raise Refuse(f"{root} is not the top of its git repository ({top} is). "
                     f"Refusing to commit into an enclosing repo.")
    return top


def ledger_paths(desk: Desk) -> list[str]:
    """The two files a pre-flight writes, relative to the desk's REPO (Desk.repo), with
    forward slashes: what `git add` / `git show HEAD:<path>` take there."""
    base = desk.path.relative_to(desk.repo).as_posix()
    return [f"{base}/results-log.md", f"{base}/data/runs.jsonl"]


def agent_id() -> str:
    """Who signs: the launch contract's FUND_AGENT, else `you` (the owner by hand) -
    the same rule as app/scripts/board.mjs."""
    return (os.environ.get("FUND_AGENT") or "").strip() or "you"


def iso_of_epoch(t: int | float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def epoch_of_iso(s: str) -> float:
    """UTC ISO (`2026-09-25T03:42:21Z`, `2026-09-25T03:42`, `2026-09-25`) -> epoch."""
    import calendar
    t = (s or "").strip().rstrip("Zz")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            return float(calendar.timegm(time.strptime(t, fmt)))
        except ValueError:
            continue
    raise Refuse(f"{s!r} is not a UTC ISO time (e.g. 2026-09-25T03:42:21Z)")


def preflight_commit(desk: Desk, run_id: str) -> dict:
    """The commit that landed this run's pre-flight row, or Refuse.

    Proven, not trusted: the row must be in HEAD's runs.jsonl (so it was committed
    at all), the commit that introduced it is found by pickaxe on its exact line,
    and that commit may touch nothing but the desk's two ledger files (its OWN
    commit - a pre-flight landed together with its result proves nothing).
    Returns {sha, at (author time, epoch), at_iso, subject}. Author time, because a
    `pull --rebase` rewrites the committer time to the moment of the rebase."""
    git_repo_root(desk.repo)
    rlog, runs_p = ledger_paths(desk)
    shown = git(desk.repo, "show", f"HEAD:{runs_p}")
    line = ""
    if shown.returncode == 0:
        for raw in shown.stdout.splitlines():
            s = raw.strip()
            if not s:
                continue
            try:
                row = json.loads(s)
            except ValueError:
                continue
            if (isinstance(row, dict) and row.get("run") == run_id
                    and row.get("stage") == "preflight"):
                line = s
                break
    if not line:
        raise Refuse(
            f"the pre-flight for {run_id} is not in HEAD's {runs_p}. preregister.py commits "
            f"it on its own before anything runs; an uncommitted pre-flight cannot be told "
            f"apart from one written after the numbers came back.")
    lg = git(desk.repo, "log", "--reverse", "--format=%H%x09%at%x09%s", "-S", line,
             "HEAD", "--", runs_p)
    first = next((x for x in lg.stdout.splitlines() if x.strip()), "")
    if lg.returncode != 0 or not first:
        raise Refuse(f"could not find the commit that landed {run_id}'s pre-flight "
                     f"({lg.stderr.strip() or 'no commit introduced that row'})")
    sha, at, subject = (first.split("\t", 2) + ["", ""])[:3]
    names = git(desk.repo, "show", "--name-only", "--no-renames", "--format=", sha)
    files = {n.strip() for n in names.stdout.splitlines() if n.strip()}
    extra = sorted(files - {rlog, runs_p})
    if extra:
        raise Refuse(
            f"{run_id}'s pre-flight landed in {sha[:12]} together with "
            f"{', '.join(extra[:4])}{' ...' if len(extra) > 4 else ''} - not its own commit. "
            f"The pre-flight commit may hold only {rlog} and {runs_p}.")
    return {"sha": sha, "at": int(at), "at_iso": iso_of_epoch(int(at)), "subject": subject}


def commit_of(row: dict) -> str:
    """A row's platform SHA; rows written before 2026-09-24 call it crypto_commit
    (the platform repo IS the old crypto repo, same history)."""
    return str(row.get("platform_commit") or row.get("crypto_commit") or "")


def die(msg: str) -> int:
    print(f"REFUSED: {msg}", file=sys.stderr)
    return 1
