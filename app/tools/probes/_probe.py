#!/usr/bin/env python3
"""THE PROBE HARNESS - measurement that cannot die silently.

The agency's measurement script died for weeks and nobody noticed, because a
script that is not running produces no output and no output looks like no
problem. Three mechanisms here make silence LOUD:

  1. EVERY PROBE RECORDS ITS OWN HEALTH READING, always, on every path - ok,
     fail, or unknown - as a row of the ops store (`ops.health_readings`,
     probe_id `system:<id>`, target `system`, through fund_db; the cockpit reads
     the same rows through @fund/db). A probe that ran and could not decide
     records `unknown`, which is a different row from `ok` and reads as one.
  2. A WATCHDOG THREAD owns the timeout. If the body hangs, the watchdog
     writes `fail - timed out after Ns` and hard-exits. A hung probe therefore
     still leaves a red row; it does not leave yesterday's green one.
  3. THE REGISTRY BELOW IS THE EXPECTED SET. `staleness.py` walks it, not the
     readings, so a probe that never recorded at all is
     `unknown/never reported` rather than absent-and-invisible. This is the
     exact defect the agency hit: their gap was a MISSING row, and a missing
     row renders as nothing.

Exit codes, uniform across every probe (the scheduler reads these):

    0   ok      - the checked property holds
    1   fail    - the checked property is FALSE (a real finding)
    2   unknown - the probe could not run or could not decide (tool missing,
                  network down, timeout). NOT the same as fail, and the health
                  row says which.

Every probe takes `--dry` (say what would be checked and written, touch
nothing, exit 0) and `--json` (the health object on stdout).

Run on the fund's ONE venv (`.venv/Scripts/python.exe` at the fund root): the
readings go through `fund_db` (the data layer), and a reading that cannot be
recorded is said on stderr and exits 2 (unknown), never silently dropped.
A probe that needs another program runs it in a child process (`ctx.py` for the
fund venv, `run` for anything else), so a crash in it costs one reading.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):  # Windows consoles default to cp1252
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# --------------------------------------------------------------------------
# where things are
# --------------------------------------------------------------------------




def _load_root():
    """app/tools/_root.py, loaded by path (no sys.path edit): the one fund_root() and layout."""
    import importlib.util
    path = Path(__file__).resolve().parent.parent / "_root.py"
    spec = importlib.util.spec_from_file_location("fund_tools_root", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_ROOT = _load_root()


def fund_root() -> Path:
    """$FUND_ROOT wins; else the fund this tools/ folder sits in (app/tools/_root.py)."""
    return _ROOT.fund_root()


PLATFORM = _ROOT.PLATFORM


def platform_root(root: Path | None = None) -> Path:
    """The platform folder (research and the lab desks)."""
    return (root or fund_root()) / PLATFORM


def fund_python(root: Path | None = None) -> str:
    """The fund's ONE venv interpreter (the packages are installed into it,
    editable). Never this process's - the fund tools are stdlib-only and may be
    launched by any Python."""
    v = (root or fund_root()) / ".venv"
    for rel in ("Scripts/python.exe", "bin/python", "bin/python3"):
        p = v / rel
        if p.is_file():
            return str(p)
    return ""


def floor_dir() -> Path:
    """Machine-local runtime state, outside the repo (app/tools/_root.py floor_dir): the STOP
    switch. Probe readings are NOT here: they are rows of the ops store (record_health)."""
    return _ROOT.floor_dir()


HEALTH_TARGET = "system"


def probe_key(probe_id: str) -> str:
    """The ops-store probe_id of a probe reading (the cockpit's heat strip reads the same key)."""
    return f"system:{probe_id}"


def last_json(out: str):
    """The last line of a child's stdout that parses as JSON (a warning may precede it), or None."""
    for ln in reversed((out or "").strip().splitlines()):
        ln = ln.strip()
        if ln.startswith(("{", "[")):
            try:
                return json.loads(ln)
            except ValueError:
                continue
    return None


# --------------------------------------------------------------------------
# the registry - the EXPECTED set of probes
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Spec:
    id: str
    label: str
    owner: str          # the desk that owns the reading (a lab/ path, or "." for the fund)
    desk: str | None    # where snapshot rows go; None = this reading belongs to no one desk
    window_s: int       # how long a reading stays fresh; past it staleness.py calls it stale
    timeout_s: int
    network: bool
    note: str


REGISTRY: dict[str, Spec] = {
    "git": Spec(
        "git", "every repo: ahead/behind/dirty",
        ".", None, 6 * 3600, 120, False,
        "uncommitted work and unpushed commits in the fund and every repo in repos.json"),
}

# The sweep's OWN row. Not in REGISTRY (run_all would then try to run itself),
# but staleness.py expects it, so "the thing that runs the probes stopped
# running" is itself a red row rather than a quiet absence. This is the exact
# gap the agency's dead measurement script fell through.
SWEEP = Spec("probe-sweep", "app/tools/probes/run_all.py", ".", None, 26 * 3600, 3600, False,
             "did the probe sweep itself run")


# --------------------------------------------------------------------------
# the result
# --------------------------------------------------------------------------

@dataclass
class Result:
    status: str                       # "ok" | "fail" | "unknown"
    reading: str                      # ONE line: the number, not the story
    detail: str = ""
    snapshots: list[dict] = field(default_factory=list)
    extra: dict = field(default_factory=dict)   # goes into the health json verbatim

    def snap(self, subject: str, source: str, field_: str, value, unit: str,
             provenance: str, note: str = "", desk: str | None = None) -> None:
        """Queue a snapshot row (the store: app/loop/tools/snapshots.py). `unit` is never optional and never
        inferred: an annualized number and a per-settlement one look identical
        without it and differ by 8760x on an hourly market."""
        row = {"subject": subject, "source": source, "field": field_,
               "value": value, "unit": unit, "provenance": provenance}
        if note:
            row["note"] = note
        if desk:
            row["desk"] = desk
        self.snapshots.append(row)


class Ctx:
    def __init__(self, spec: Spec, args, root: Path):
        self.spec = spec
        self.args = args
        self.root = root
        self.dry = bool(getattr(args, "dry", False))
        self.started = time.time()

    @property
    def left(self) -> float:
        """Seconds left before the watchdog fires. A body that shells out uses
        this as its own timeout so the child dies before the watchdog does."""
        return max(1.0, self.spec.timeout_s - (time.time() - self.started) - 5)

    def py(self, args: list[str], timeout: float | None = None,
           cwd: Path | None = None) -> tuple[int, str, str]:
        """Run the CODE REPO's interpreter. Returns (rc, stdout, stderr);
        rc 124 means it timed out, rc 127 means there is no interpreter."""
        exe = fund_python(self.root)
        if not exe:
            return 127, "", f"no interpreter at {self.root / '.venv'}"
        return run(([exe] + args), timeout or self.left, cwd or self.root)


def run(argv: list[str], timeout: float, cwd: Path | None = None) -> tuple[int, str, str]:
    try:
        p = subprocess.run(argv, cwd=str(cwd) if cwd else None, capture_output=True,
                           text=True, encoding="utf-8", errors="replace",
                           timeout=timeout)
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout:.0f}s"
    except FileNotFoundError as e:
        return 127, "", str(e)
    except OSError as e:          # pragma: no cover - platform noise
        return 126, "", str(e)


# --------------------------------------------------------------------------
# writing
# --------------------------------------------------------------------------

def health_obj(spec: Spec, status: str, reading: str, detail: str = "",
               extra: dict | None = None) -> dict:
    o = {
        "id": spec.id,
        "label": spec.label,
        "owner": spec.owner,
        "status": status,
        "reading": reading[:200],
        "probed_ts": int(time.time()),
        "window_s": spec.window_s,
        "detail": detail[:600],
    }
    if extra:
        o.update(extra)
    return o


def record_health(obj: dict) -> int:
    """One reading -> ops.health_readings (probe_id system:<id>, target system, ts = probed_ts,
    detail_json = the whole reading). Raises when the ops store cannot take it."""
    from fund_db import ops
    return ops.record_health(probe_key(obj["id"]), HEALTH_TARGET, obj["status"], obj.get("reading"),
                             obj, int(obj["probed_ts"]) * 1000)


def write_health(spec: Spec, status: str, reading: str, detail: str = "",
                 root: Path | None = None, extra: dict | None = None) -> int:
    """Record this probe's reading in the ops store. `root` is accepted and ignored (the store is
    not in the tree). Returns the reading's row id."""
    return record_health(health_obj(spec, status, reading, detail, extra))


def latest_readings() -> dict[str, dict]:
    """{probe id: its newest recorded reading (the health object)} from the ops store."""
    from fund_db import ops
    out = {}
    for r in ops.latest_health(HEALTH_TARGET):
        pid = str(r["probe_id"])
        if not pid.startswith("system:"):
            continue
        obj = r.get("detail_json") if isinstance(r.get("detail_json"), dict) else {}
        obj = {**obj, "id": obj.get("id") or pid[len("system:"):], "status": obj.get("status") or r["status"],
               "reading": obj.get("reading") or r.get("reading") or "",
               "probed_ts": obj.get("probed_ts") or int(r["ts"]) // 1000}
        out[obj["id"]] = obj
    return out


def _load_store():
    """app/loop/tools/snapshots.py, loaded by path: the ONE snapshot store (the fund_db lake's
    snapshots dataset). The probes write through it; app/loop/tools reads through it."""
    import importlib.util
    path = Path(__file__).resolve().parents[2] / "loop" / "tools" / "snapshots.py"   # app/tools/probes -> app/loop/tools
    spec = importlib.util.spec_from_file_location("fund_snapshots", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


STORE = _load_store()


def snapshot_path(desk: str) -> str:
    """Where a desk's snapshot rows live: the lake's snapshots log of that desk (snapshots.py)."""
    return f"the fund_db lake, snapshots log {STORE.desk_key(desk)!r}"


def append_snapshots(spec: Spec, rows: list[dict], root: Path | None = None) -> int:
    """Append to the OWNING desk's log in the snapshot store, when the desk exists.

    The store is the fund_db lake (app/loop/tools/snapshots.py), so a sweep never
    dirties the tree. A desk that has no lab/ folder yet is not an error: the
    reading is still in the ops store's health readings, and the row lands the
    day the desk does. Writing rows for a desk nobody owns would be the worse
    failure."""
    if not rows:
        return 0
    r = root or fund_root()
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    by_desk: dict[str, list[dict]] = {}
    for row in rows:
        row = dict(row)
        desk = row.pop("desk", None) or spec.desk
        if not desk or not STORE.desk_exists(desk, r):
            continue
        key = STORE.desk_key(desk)
        row["desk"] = desk
        by_desk.setdefault(key, []).append(row)
    written = 0
    for key, rs in by_desk.items():
        # an incomplete row is dropped inside append(): a gap, never a guess
        written += STORE.append(key, rs, r, ts=ts)
    return written


# --------------------------------------------------------------------------
# the entry point every probe uses
# --------------------------------------------------------------------------

EXIT = {"ok": 0, "fail": 1, "unknown": 2}


def base_parser(spec: Spec) -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog=f"probes/{spec.id}.py", description=spec.note)
    ap.add_argument("--dry", action="store_true",
                    help="say what would be checked and written; touch nothing; exit 0")
    ap.add_argument("--json", action="store_true", help="print the health object on stdout")
    ap.add_argument("--quiet", action="store_true", help="one line only")
    return ap


def _watchdog(spec: Spec, root: Path, quiet: bool) -> threading.Timer:
    """The mechanism that makes a HANG red instead of silent."""
    def fire():
        try:
            try:
                write_health(spec, "fail", f"timed out after {spec.timeout_s}s",
                             "the probe body hung; the watchdog recorded this reading and killed it",
                             root)
            except Exception as e:  # noqa: BLE001 - the process dies either way; say why
                print(f"{spec.id}: the timeout reading could not be recorded: {type(e).__name__}: {e}",
                      file=sys.stderr, flush=True)
            if not quiet:
                print(f"{spec.id}: FAIL - timed out after {spec.timeout_s}s", flush=True)
        finally:
            os._exit(EXIT["fail"])
    t = threading.Timer(spec.timeout_s, fire)
    t.daemon = True
    t.start()
    return t


def main(probe_id: str, body, argv: list[str] | None = None,
         parser: argparse.ArgumentParser | None = None) -> int:
    spec = REGISTRY[probe_id]
    ap = parser or base_parser(spec)
    args = ap.parse_args(argv)
    root = fund_root()
    ctx = Ctx(spec, args, root)

    if ctx.dry:
        print(f"{spec.id}: DRY - would check: {spec.note}")
        print(f"  health  -> the ops store, ops.health_readings probe_id {probe_key(spec.id)}")
        if spec.desk:
            print(f"  snapshots -> {snapshot_path(spec.desk)}"
                  + ("" if STORE.desk_exists(spec.desk, root)
                     else "   (desk not built yet - row skipped)"))
        print(f"  network {'yes' if spec.network else 'no'} · timeout {spec.timeout_s}s "
              f"· window {spec.window_s}s")
        return 0

    wd = _watchdog(spec, root, args.quiet)
    try:
        res = body(ctx)
    except Exception as e:                      # noqa: BLE001 - a probe never raises out
        res = Result("unknown", f"the probe itself failed: {type(e).__name__}", repr(e)[:500])
    finally:
        wd.cancel()

    if res.status not in EXIT:
        res = Result("unknown", f"bad status {res.status!r}", "")
    try:
        write_health(spec, res.status, res.reading, res.detail, root, res.extra or None)
    except Exception as e:  # noqa: BLE001 - silence is not a reading: say it and exit unknown
        print(f"{spec.id}: the reading ({res.status}: {res.reading}) could not be recorded in the ops "
              f"store: {type(e).__name__}: {e}", file=sys.stderr)
        return EXIT["unknown"]
    n = append_snapshots(spec, res.snapshots, root)

    if args.json:
        print(json.dumps(health_obj(spec, res.status, res.reading, res.detail, res.extra),
                         indent=2, ensure_ascii=False))
    else:
        mark = {"ok": "ok  ", "fail": "FAIL", "unknown": "??  "}[res.status]
        print(f"{mark} {spec.id:9} {res.reading}")
        if res.detail and not args.quiet:
            for line in res.detail.splitlines()[:12]:
                print(f"       {line}")
        if n and not args.quiet:
            print(f"       ({n} snapshot row(s) appended)")
    return EXIT[res.status]
