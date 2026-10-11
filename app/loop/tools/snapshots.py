#!/usr/bin/env python3
"""The snapshot store - live readings, kept in the fund_db market lake (the `snapshots` dataset).

A snapshot row is one live reading of one field, keyed by (ts, subject, field). `unit` is required and never
inferred (UNITS below): an annualized and a per-settlement number look identical without it and differ by 8760x on
an hourly market. `note` carries what a field name cannot: PREDICTED (the interval in progress) or SETTLED, whether
a window is a venue cap, whether a cadence was read from the venue (a missing one means the row is OMITTED, never
defaulted). The probe sweep takes dozens of them per tick. They are machine
state, not decisions, so they never enter a repo: since 2026-09-25 they are rows of the lake's
`snapshots` dataset, one LOG per desk, written and read only through `fund_db.market`
(database/CLAUDE.md, the data law) - no file of this tool's own.

    log   = the lab-relative desk fragment: `venues/exchange_c`, `platform/data`, `vol`
    row   = {ts, desk, subject, source, field, value, unit, provenance[, note]}; `desk` keeps its
            long form (`lab/venues/exchange_c`); `value` comes back an int where it was written as one

THE OLD ROWS ARE NOT LOST. Every entry point here merges a desk's older homes into the lake before
it touches the desk, once per process, from three sources:

  1. the retired file store `~/fund-data/snapshots/<desk>.jsonl` (`$FUND_SNAPSHOTS_DIR`, the store
     2026-09-25 morning to evening; the lake import copied it once, a probe may have appended
     since): merged, verified, then MOVED to `<data root>/_retired/snapshots/` (never deleted);
  2. the working-tree file `lab/<desk>/data/snapshots.jsonl` (an inbox: merged, verified, then
     removed - it is git-ignored and its rows are in the lake);
  3. the file as git last held it (the commit that untracked it, or its parent), for a clone whose
     pull deleted the working copy before it ever ran this.

Merging is idempotent: the lake's `observe` rule drops an exact re-delivery (every column but
`seen`), so twice is once. A source is retired only when every one of its rows reads back from the
lake, row for row.

CLI (from the fund root, on the fund .venv - fund_db must be importable):

    python app/loop/tools/snapshots.py where                     where the rows live
    python app/loop/tools/snapshots.py migrate [--desk D] [--dry] every desk under lab/ by default
    python app/loop/tools/snapshots.py show --desk D [--field F] [--subject S] [--last N]
    python app/loop/tools/snapshots.py append --desk D --subject S --source SRC --field F
                                          --value V --unit U --provenance P [--note N] [--ts T]
    python app/loop/tools/snapshots.py append --desk D --rows rows.jsonl   (one row per line)

Exit: 0 ok · 1 refused (an incomplete row, an unknown desk, no fund_db) · 2 usage.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _load_root():
    """app/tools/_root.py, loaded by path (no sys.path edit): fund_root() and the legacy desk map."""
    import importlib.util
    path = Path(__file__).resolve().parents[2] / "tools" / "_root.py"   # app/loop/tools -> app/tools
    spec = importlib.util.spec_from_file_location("fund_tools_root", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_ROOT = _load_root()
LAB = _ROOT.LAB

# A row without every one of these is not written: an omitted row is a gap, a
# guessed one is a lie with a timestamp on it.
REQUIRED = ("ts", "desk", "subject", "source", "field", "value", "unit", "provenance")
UNITS = ("pct_ann", "pct_per_interval", "bps", "usd", "hours", "count", "ratio")
KEYS = REQUIRED + ("note",)

LEGACY_NAME = "snapshots.jsonl"
DATASET = "snapshots"
SRC = "desk"


class StoreUnavailable(RuntimeError):
    """fund_db (the data layer) is not importable in this interpreter."""


def _market():
    try:
        from fund_db import market
        return market
    except ImportError as e:
        raise StoreUnavailable(f"fund_db is not importable in {sys.executable} ({e}); run the loop tools "
                               f"on the fund .venv (pip install -e database)") from e


# --------------------------------------------------------------------------
# where
# --------------------------------------------------------------------------

def where() -> str:
    """Where the rows live, said: the lake's snapshots dataset (fund_db.config decides the root)."""
    from fund_db import config
    return f"the fund_db lake, dataset {DATASET!r}, one log per desk: {config.market_dir() / DATASET}"


def legacy_store_dir() -> Path:
    """The retired file store (2026-09-25): app/tools/_root.py snapshots_dir()."""
    return _ROOT.snapshots_dir()


def desk_key(desk: str) -> str:
    """Any desk spelling -> the lab-relative fragment the log is keyed by.
    `lab/venues/exchange_c`, `platform/lab/venues/exchange_c` (its folder), `venues/exchange_c`, `lab/api/data/venues/exchange_c` (pre-rename) and
    `desks/api/data/venues/exchange_c` (pre-cut-over) all give `venues/exchange_c`."""
    s = (desk or "").replace("\\", "/").strip().strip("/")
    for pre in ("desks/", *(f"{h}/" for h in _ROOT.LAB_HOMES)):   # platform/lab/, lab/
        if s.startswith(pre):
            s = s[len(pre):]
            break
    for old, new in _ROOT.LEGACY_DESK:
        if old.endswith("/"):
            if s.startswith(old):
                s = new + s[len(old):]
                break
        elif s == old or s.startswith(old + "/"):
            s = new + s[len(old):]
            break
    if not s or s in (LAB, "desks") or ".." in s.split("/"):
        raise ValueError(f"not a desk: {desk!r}")
    return s


def old_store_path(desk: str) -> Path:
    """The desk's file in the retired file store."""
    return legacy_store_dir().joinpath(*desk_key(desk).split("/")).with_suffix(".jsonl")


def legacy_path(desk: str, root: Path | None = None) -> Path:
    """Where the rows lived while tracked (until 2026-09-25): the working-tree inbox."""
    r = root or _ROOT.fund_root()
    return r / _ROOT.lab_rel(r) / Path(*desk_key(desk).split("/")) / "data" / LEGACY_NAME


def desk_exists(desk: str, root: Path | None = None) -> bool:
    r = root or _ROOT.fund_root()
    return (r / _ROOT.lab_rel(r) / Path(*desk_key(desk).split("/"))).is_dir()


def lab_desks(root: Path | None = None) -> list[str]:
    """Every desk folder that carries a data/ folder or a cadence.md, under the lab where it is on
    disk (platform/lab since the 2026-09-25 relayout; lab/ in an older checkout), as `<key>`."""
    base = root or _ROOT.fund_root()
    r = base / _ROOT.lab_rel(base)
    out = []
    if not r.is_dir():
        return out
    for p in sorted(r.rglob("*")):
        if p.is_dir() and ((p / "cadence.md").is_file() or (p / "data" / LEGACY_NAME).is_file()):
            out.append(p.relative_to(r).as_posix())
    return out


# --------------------------------------------------------------------------
# rows
# --------------------------------------------------------------------------

def _canon(o: dict) -> str:
    """A reading's identity: its REQUIRED fields + note, canonical JSON (key order does not matter)."""
    return json.dumps({k: o.get(k) for k in KEYS if o.get(k) is not None}, ensure_ascii=False, sort_keys=True)


def _rows_of(text: str) -> tuple[list[dict], int]:
    """(JSON object lines, lines that are not one)."""
    rows, bad = [], 0
    for ln in text.splitlines():
        if not ln.strip():
            continue
        try:
            o = json.loads(ln)
        except ValueError:
            bad += 1
            continue
        if isinstance(o, dict):
            rows.append(o)
        else:
            bad += 1
    return rows, bad


def _read_text(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def _to_lake(o: dict) -> dict:
    return {k: o[k] for k in KEYS if o.get(k) is not None}


def _from_lake(r: dict) -> dict:
    out = {k: r[k] for k in ("ts", "desk", "subject", "source", "field", "unit", "provenance") if r.get(k) is not None}
    v = r.get("value")
    out["value"] = int(v) if r.get("is_int") and v is not None else v
    if r.get("note") is not None:
        out["note"] = r["note"]
    return out


def _write(key: str, rows: list[dict]) -> dict:
    if not rows:
        return {"added": 0, "unchanged": 0}
    return _market().write(DATASET, [_to_lake(o) for o in rows], key, source=SRC)


def _stored(key: str) -> list[dict]:
    return [_from_lake(r) for r in _market().snapshots(log=key, as_="rows")]


# --------------------------------------------------------------------------
# migration
# --------------------------------------------------------------------------

def _git(root: Path, *args: str) -> tuple[int, str]:
    try:
        p = subprocess.run(["git", "-C", str(root), *args], capture_output=True,
                           text=True, encoding="utf-8", errors="replace", timeout=30)
        return p.returncode, p.stdout or ""
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def _git_history(root: Path, rel: str) -> tuple[str | None, str]:
    """The legacy file as git last held it: (commit, text). The last commit that
    touched the path either still has it (not yet untracked) or is the one that
    untracked it, in which case its parent has it."""
    rc, sha = _git(root, "log", "-1", "--format=%H", "--", rel)
    sha = sha.strip()
    if rc != 0 or not sha:
        return None, ""
    for rev in (sha, sha + "^"):
        rc, text = _git(root, "show", f"{rev}:{rel}")
        if rc == 0:
            return rev, text
    return sha, ""


def _retired_dir() -> Path:
    from fund_db import config
    return config.retired_dir() / "snapshots"


_DONE: set[tuple[str, str]] = set()      # (fund root, desk) merged in this process


def migrate(desk: str, root: Path | None = None, dry: bool = False) -> dict:
    """Merge the desk's older homes into the lake (the module docstring), then retire each source
    whose every row reads back. `dry` reads and counts, writes nothing, moves nothing."""
    r = root or _ROOT.fund_root()
    key = desk_key(desk)
    have = {_canon(o) for o in _stored(key)}
    rep = {"desk": key, "log": key, "store_rows": 0, "disk_rows": 0, "git_rows": 0, "git_rev": None,
           "bad_lines": 0, "store_retired": None, "legacy_removed": False}
    sources: list[tuple[str, Path | None, list[dict], int]] = []     # (label, file, rows, bad lines)
    old = old_store_path(key)
    if old.is_file():
        rows, bad = _rows_of(_read_text(old))
        rep["bad_lines"] += bad
        sources.append(("store_rows", old, rows, bad))
    legacy = legacy_path(key, r)
    if legacy.is_file():
        rows, bad = _rows_of(_read_text(legacy))
        rep["bad_lines"] += bad
        sources.append(("disk_rows", legacy, rows, bad))
    if (str(r), key) not in _DONE:
        rev, text = _git_history(r, f"{LAB}/{key}/data/{LEGACY_NAME}")
        rep["git_rev"] = rev
        rows, _ = _rows_of(text)
        sources.append(("git_rows", None, rows, 0))
    for label, _, rows, _ in sources:
        fresh = [o for o in rows if all(o.get(k) is not None for k in REQUIRED) and _canon(o) not in have]
        uniq = list({_canon(o): o for o in fresh}.values())
        rep[label] = len(uniq)
        if not dry and uniq:
            _write(key, uniq)
        have |= {_canon(o) for o in uniq}
    if dry:
        return rep
    _DONE.add((str(r), key))
    stored = {_canon(o) for o in _stored(key)}
    for label, path, rows, bad in sources:
        if path is None:
            continue
        complete = [o for o in rows if all(o.get(k) is not None for k in REQUIRED)]
        if bad or len(complete) != len(rows) or not all(_canon(o) in stored for o in complete):
            continue      # a row the lake cannot hold (incomplete, not JSON) keeps its file where it is
        if label == "store_rows":
            dst = _retired_dir().joinpath(*key.split("/")).with_suffix(".jsonl")
            if dst.exists():
                dst = dst.with_name(f"{dst.stem}.{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.jsonl")
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(path), str(dst))
            rep["store_retired"] = str(dst)
        else:
            try:
                path.unlink()
                rep["legacy_removed"] = True
            except OSError:
                pass      # left on disk: it is git-ignored and re-merging it adds nothing
    return rep


def migrate_all(root: Path | None = None, dry: bool = False) -> list[dict]:
    r = root or _ROOT.fund_root()
    keys = set(lab_desks(r))
    base = legacy_store_dir()
    if base.is_dir():
        keys |= {p.relative_to(base).with_suffix("").as_posix() for p in base.rglob("*.jsonl")}
    return [migrate(k, r, dry) for k in sorted(keys)]


# --------------------------------------------------------------------------
# the calls every reader and writer uses
# --------------------------------------------------------------------------

def append(desk: str, rows: list[dict], root: Path | None = None,
           ts: str | None = None) -> int:
    """Append complete rows for one desk; returns how many were written.

    Each row gets `ts` (now, UTC, unless it carries its own) and `desk`
    (`lab/<key>`) when absent. A row missing any REQUIRED field is dropped,
    never completed by guess."""
    if not rows:
        return 0
    r = root or _ROOT.fund_root()
    key = desk_key(desk)
    stamp = ts or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    out = []
    for row in rows:
        full = {"ts": stamp, "desk": f"{LAB}/{key}"}
        full.update({k: v for k, v in row.items() if v is not None})
        if not all(full.get(k) is not None for k in REQUIRED):
            continue
        out.append(full)
    if not out:
        return 0
    migrate(key, r)
    _write(key, out)
    return len(out)


def read(desk: str, root: Path | None = None) -> list[dict]:
    """Every reading for one desk, oldest first (merging its older homes in first). Readers must
    not depend on the order: rows carry their own `ts`."""
    r = root or _ROOT.fund_root()
    key = desk_key(desk)
    migrate(key, r)
    return _stored(key)


def latest(desk: str, subject: str, field: str, root: Path | None = None) -> dict | None:
    """The newest row (by its own `ts`) for (subject, field)."""
    best = None
    for o in read(desk, root):
        if o.get("subject") == subject and o.get("field") == field:
            if best is None or str(o.get("ts", "")) >= str(best.get("ts", "")):
                best = o
    return best


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _num(v: str):
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        return v


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="app/loop/tools/snapshots.py",
                                 description="the snapshot store (the fund_db lake's snapshots dataset)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("where", help="say where the rows live")
    m = sub.add_parser("migrate", help="merge the older homes into the lake")
    m.add_argument("--desk", action="append", default=[])
    m.add_argument("--dry", action="store_true")
    s = sub.add_parser("show", help="print a desk's rows")
    s.add_argument("--desk", required=True)
    s.add_argument("--field")
    s.add_argument("--subject")
    s.add_argument("--last", type=int, default=0)
    a = sub.add_parser("append", help="append rows for a desk")
    a.add_argument("--desk", required=True)
    a.add_argument("--rows", help="a .jsonl file, one row per line")
    for f in ("subject", "source", "field", "value", "unit", "provenance", "note", "ts"):
        a.add_argument(f"--{f}")
    args = ap.parse_args(argv)
    root = _ROOT.fund_root()
    try:
        _market()
    except StoreUnavailable as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1

    if args.cmd == "where":
        print(where())
        return 0

    if args.cmd == "migrate":
        try:
            reps = ([migrate(dk, root, args.dry) for dk in args.desk] if args.desk
                    else migrate_all(root, args.dry))
        except ValueError as e:
            print(f"refused: {e}", file=sys.stderr)
            return 1
        verb = "would add" if args.dry else "added"
        for rp in reps:
            if rp["git_rows"] or rp["disk_rows"] or rp["store_rows"] or rp["legacy_removed"] or rp["store_retired"]:
                print(f"{rp['desk']:24} {verb} {rp['store_rows']} from the old store + {rp['disk_rows']} from disk + "
                      f"{rp['git_rows']} from git ({(rp['git_rev'] or '-')[:9]})"
                      + ("; legacy file removed" if rp["legacy_removed"] else "")
                      + (f"; old store file retired to {rp['store_retired']}" if rp["store_retired"] else ""))
        print(f"{where()} ({len(reps)} desk(s) checked)")
        return 0

    try:
        key = desk_key(args.desk)
    except ValueError as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    if not desk_exists(key, root):
        # a leaf name (`exchange_c`, `carry`) when exactly one desk carries it, as the other loop tools
        leaf = [d for d in lab_desks(root) if d.rsplit("/", 1)[-1] == key]
        if len(leaf) != 1:
            print(f"refused: no desk at {LAB}/{key}"
                  + (f" (ambiguous: {', '.join(leaf)})" if leaf else ""), file=sys.stderr)
            return 1
        key = leaf[0]

    if args.cmd == "show":
        rows = [o for o in read(key, root)
                if (not args.field or o.get("field") == args.field)
                and (not args.subject or o.get("subject") == args.subject)]
        rows.sort(key=lambda o: str(o.get("ts", "")))
        for o in rows[-args.last:] if args.last else rows:
            print(json.dumps(o, ensure_ascii=False, sort_keys=True))
        return 0

    # append
    if args.rows:
        rows = []
        for i, ln in enumerate(_read_text(Path(args.rows)).splitlines(), 1):
            if not ln.strip():
                continue
            try:
                rows.append(json.loads(ln))
            except ValueError:
                print(f"refused: {args.rows}:{i} is not JSON", file=sys.stderr)
                return 1
    else:
        row = {k: getattr(args, k) for k in
               ("subject", "source", "field", "unit", "provenance", "note", "ts")}
        row["value"] = _num(args.value) if args.value is not None else None
        rows = [row]
    bad = [o for o in rows if o.get("unit") and o["unit"] not in UNITS]
    if bad:
        print(f"refused: unit must be one of {', '.join(UNITS)} (got {bad[0]['unit']!r})",
              file=sys.stderr)
        return 1
    n = append(key, rows, root)
    if n < len(rows):
        print(f"refused {len(rows) - n} incomplete row(s): every row needs "
              + ", ".join(k for k in REQUIRED if k not in ("ts", "desk")), file=sys.stderr)
    print(f"{n} row(s) -> the lake's {DATASET} log {key!r}")
    return 0 if n == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
