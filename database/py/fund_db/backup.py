"""fund_db.backup - the nightly BACKUP of the ops store (moved here from the cockpit 2026-09-25: the
data layer backs up its own database; the cockpit only schedules the command and shows the list).

ONE pg_dump custom-format archive per local day of the WHOLE database the ops store lives in -
schema `ops`, the lake catalog `market` and the migration ledger `public.fund_migrations` (without
which a restored copy would re-run every migration):

    <backup dir>/ops-YYYY-MM-DD.dump            the newest `keep` (14) kept

pg_dump reads one consistent snapshot while writers keep writing. Every archive is written to a
`.part` file, checked with `pg_restore --list` (it must list TABLE DATA for every TABLE it holds),
and only then renamed into place, so a half-written file never counts as a backup. The binaries
are the cluster's own (config.pg_bin_dir()), so the versions always match. Older archives past
`keep` are removed: each is a copy of a database that still exists (rule 5 is about data without
a verified copy; a superseded backup is not that).

    python -m fund_db backup [--dir D] [--keep N]      write today's archive (exit 1 on failure)
    python -m fund_db backup --list [--json]           what is kept, newest first

The backup dir: FUND_DB_BACKUP_DIR, else ~/fund-data/backups/db (the cockpit's old default, so the
archives written before the move are the same list).
"""
from __future__ import annotations

import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

from . import config

KEEP = 14
NAME = re.compile(r"^ops-(\d{4}-\d{2}-\d{2})\.dump$")


def backup_dir() -> Path:
    env = os.environ.get("FUND_DB_BACKUP_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / "fund-data" / "backups" / "db"


def local_day(ms: int) -> str:
    """The machine's local calendar day of an epoch-ms instant (the scheduler's cadences are local)."""
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


def backup_name(ms: int) -> str:
    return f"ops-{local_day(ms)}.dump"


def _exe(name: str, bin_dir: Path | None = None) -> Path:
    return (bin_dir or config.pg_bin_dir()) / (name + (".exe" if os.name == "nt" else ""))


def list_backups(d: Path | None = None) -> list[dict]:
    """[{file, day, bytes, mtime_ms}] newest day first; anything not named ops-YYYY-MM-DD.dump is ignored."""
    d = d or backup_dir()
    out = []
    try:
        names = os.listdir(d)
    except OSError:
        return []
    for f in names:
        m = NAME.match(f)
        if not m:
            continue
        try:
            st = (d / f).stat()
        except OSError:
            continue
        out.append({"file": f, "day": m.group(1), "bytes": st.st_size, "mtime_ms": int(st.st_mtime * 1000)})
    return sorted(out, key=lambda x: x["day"], reverse=True)


def to_prune(files: list[dict], keep: int) -> list[str]:
    """The files a keep-N prune removes: everything past the newest `keep` days."""
    return [f["file"] for f in sorted(files, key=lambda x: x["day"], reverse=True)[max(0, keep):]]


def listed_tables(listing: str) -> dict:
    """From `pg_restore --list`: how many TABLE DATA entries, and how many TABLEs."""
    data = tables = 0
    for line in listing.splitlines():
        if line.startswith(";") or not line.strip():
            continue
        if re.search(r"\bTABLE DATA\b", line):
            data += 1
        elif re.search(r"\bTABLE\b", line):
            tables += 1
    return {"data": data, "tables": tables}


def _run(argv: list[str], timeout_s: float) -> tuple[int | None, str, str]:
    try:
        p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout_s, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        return None, "", f"timed out after {timeout_s:.0f} s"
    except OSError as e:
        return None, "", str(e)


def backup(d: Path | None = None, keep: int = KEEP, now_ms: int | None = None, bin_dir: Path | None = None,
           timeout_s: float = 600.0, conninfo: dict | None = None) -> dict:
    """Write today's archive, verified, then keep the newest `keep`. Raises on any failure (the
    .part file is removed). -> {file, path, bytes, method, check, tables, pruned, took_ms}."""
    t0 = time.time()
    now = int(t0 * 1000) if now_ms is None else now_ms
    d = d or backup_dir()
    dump, restore = _exe("pg_dump", bin_dir), _exe("pg_restore", bin_dir)
    if not dump.exists():
        raise FileNotFoundError(f"no pg_dump at {dump.parent} (set FUND_PG_BIN, or run database\\scripts\\pg.py ensure)")
    d.mkdir(parents=True, exist_ok=True)
    name = backup_name(now)
    path = d / name
    part = d / (name + ".part")
    part.unlink(missing_ok=True)
    ci = conninfo or _conninfo()
    code, _, err = _run([str(dump), "-h", str(ci["host"]), "-p", str(ci["port"]), "-U", str(ci["user"]),
                         "-d", str(ci["database"]), "-w", "-Fc", "-Z", "6", "-f", str(part)], timeout_s)
    if code != 0:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"pg_dump exited {code}: {err.strip()[-400:]}")
    code, out, err = _run([str(restore), "--list", str(part)], 120.0)
    got = listed_tables(out)
    check = (f"pg_restore --list exited {code}: {err.strip()[-200:]}" if code != 0
             else "no tables in the archive" if got["tables"] == 0
             else f"{got['tables']} tables but data for {got['data']}" if got["data"] < got["tables"]
             else "ok")
    if check != "ok":
        part.unlink(missing_ok=True)
        raise RuntimeError(f"check on the archive: {check}")
    os.replace(part, path)                     # today's earlier copy, if any: the newer one wins
    pruned = to_prune(list_backups(d), keep)
    for f in pruned:
        (d / f).unlink(missing_ok=True)
    return {"file": name, "path": str(path), "bytes": path.stat().st_size, "method": "pg_dump", "check": check,
            "tables": got["tables"], "pruned": pruned, "took_ms": int((time.time() - t0) * 1000)}


def _conninfo() -> dict:
    """host/port/user/database of the ops store, parsed from config.dsn() (never a password)."""
    parts = dict(kv.split("=", 1) for kv in config.dsn().split() if "=" in kv)
    s = config.settings()
    return {"host": parts.get("host", config.HOST), "port": int(parts.get("port", s["port"])),
            "user": parts.get("user", s["user"]), "database": parts.get("dbname", s["database"])}


def status(files: list[dict], now_ms: int) -> dict:
    """What the System room shows: ok when the newest copy is at most 36 h old, warn when older."""
    if not files:
        return {"status": "unknown", "reading": "no backup yet"}
    newest = files[0]
    age_h = (now_ms - newest["mtime_ms"]) / 3_600_000
    return {"status": "ok" if age_h <= 36 else "warn",
            "reading": f"{len(files)} kept · {newest['day']} · {newest['bytes'] / 1048576:.1f} MB"}
