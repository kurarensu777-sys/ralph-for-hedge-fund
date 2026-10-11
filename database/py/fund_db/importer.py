"""Carry the cockpit's SQLite store (cockpit.db) into the ops schema, and PROVE the copy.

    python -m fund_db import-cockpit --sqlite ~/fund-data/cockpit.db [--replace] [--dsn ...]

1. The source is opened READ-ONLY and snapshotted with SQLite's backup API (a consistent copy even
   while the cockpit is writing in WAL mode); the source file is never modified, moved or deleted.
   Retiring it to ~/fund-data/db/_retired/ is the cutover step's job, after this report is green.
2. Every ops table is filled from its SQLite namesake (messages from messages_fts), converting:
   0/1 flags -> boolean, JSON text -> jsonb, the FTS row's real ts -> bigint. Tables SQLite kept
   without a key (usage, health_readings, reads, messages) take the SQLite rowid as `id`.
3. Identity sequences are moved past the highest carried id.
4. VERIFY, inside the same transaction: per table, the row count and a sha256 over every row
   (canonical JSON, ordered by primary key) must match between the converted source and what
   Postgres returns. Any mismatch rolls the whole import back.
A target that already holds rows is refused unless --replace (which empties the ops tables first,
in the same transaction).
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import time
from pathlib import Path

from psycopg import sql
from psycopg.types.json import Jsonb

from . import config
from .db import connect
from .ops.rows import TABLES

# tables that never lived in cockpit.db (ops migration 002: logs that were files under the data
# root or the floor) - the cockpit import neither expects nor fills them
NOT_FROM_COCKPIT = {"data_audit", "wire_changes", "wire_snapshots", "wire_state", "no_lesson", "fund_book_daily"}
# ops table -> SQLite source table
SOURCES = {t: t for t in TABLES if t not in NOT_FROM_COCKPIT}
SOURCES["messages"] = "messages_fts"
# tables SQLite held with no primary key of their own: their `id` is the SQLite rowid
ROWID_IDS = {"usage", "health_readings", "reads", "messages"}
SKIPPED_SOURCE = {"_migrations", "sqlite_sequence"}  # the old ledger + SQLite internals: not data


class ImportError_(RuntimeError):
    pass


def snapshot(src: Path, dst: Path) -> None:
    """A consistent copy of a live SQLite database, the source opened read-only."""
    s = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True)
    try:
        d = sqlite3.connect(dst)
        with d:
            s.backup(d)
        d.close()
    finally:
        s.close()


def _source_tables(lite: sqlite3.Connection) -> set[str]:
    return {r[0] for r in lite.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def _cols(lite: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in lite.execute(f'PRAGMA table_info("{table}")')]


def _convert(table: str, row: dict) -> dict:
    spec = TABLES[table]
    out = {}
    for k, v in row.items():
        if v is not None and k in spec["bool"]:
            if v not in (0, 1):
                raise ImportError_(f"{table}.{k}: flag value {v!r} is not 0/1")
            v = bool(v)
        elif v is not None and k in spec["json"]:
            try:
                v = json.loads(v)
            except (TypeError, ValueError) as e:
                raise ImportError_(f"{table}.{k}: not JSON ({e}): {str(v)[:120]!r}")
        elif isinstance(v, str) and "\x00" in v:
            raise ImportError_(f"{table}.{k}: text holds a NUL byte, which PostgreSQL text cannot store")
        out[k] = v
    if table == "messages":
        ts = out["ts"]
        if isinstance(ts, str):
            ts = float(ts)
        if ts is None or float(ts) != int(float(ts)):
            raise ImportError_(f"messages: ts {out['ts']!r} is not a whole number of ms")
        out["ts"] = int(float(ts))
    return out


def _read_source(lite: sqlite3.Connection, table: str) -> list[dict]:
    src = SOURCES[table]
    have = set(_cols(lite, src))
    want = [c for c in TABLES[table]["columns"] if c not in TABLES[table]["generated"]]
    pick = [c for c in want if c in have]
    exprs = [f'"{c}"' for c in pick]
    if table in ROWID_IDS and "id" not in have:
        exprs.append("rowid AS id")
        pick.append("id")
    rows = lite.execute(f'SELECT {", ".join(exprs)} FROM "{src}"').fetchall()
    return [_convert(table, dict(zip(pick, r))) for r in rows]


def digest(rows: list[dict], pk: list[str], cols: list[str]) -> str:
    """sha256 over canonical JSON lines of `cols`, rows ordered by the primary key."""
    h = hashlib.sha256()
    key = (lambda r: tuple((r[k] is None, r[k]) for k in pk)) if pk else (lambda r: json.dumps(r, sort_keys=True, default=str))
    for r in sorted(rows, key=key):
        h.update(json.dumps([r.get(c) for c in cols], sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                            default=str).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def import_cockpit(sqlite_path: Path, dsn: str | None = None, replace: bool = False, log=print) -> dict:
    sqlite_path = Path(sqlite_path).expanduser()
    if not sqlite_path.exists():
        raise ImportError_(f"no SQLite database at {sqlite_path}")
    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix="fund_db_import_") as tmp:
        snap = Path(tmp) / "cockpit.snapshot.db"
        snapshot(sqlite_path, snap)
        lite = sqlite3.connect(f"file:{snap.as_posix()}?mode=ro", uri=True)
        try:
            present = _source_tables(lite)
            data = {t: _read_source(lite, t) for t in SOURCES if SOURCES[t] in present}
            missing = sorted(t for t in SOURCES if SOURCES[t] not in present)
            fts_shadow = {p for p in present if p.startswith("messages_fts_")}
            unmapped = sorted(present - set(SOURCES.values()) - SKIPPED_SOURCE - fts_shadow)
        finally:
            lite.close()
    if unmapped:
        raise ImportError_(f"SQLite tables with no ops home (add a migration first): {unmapped}")
    report = {"source": str(sqlite_path), "missing_in_source": missing, "tables": {}}
    with connect(dsn) as conn:
        with conn.transaction():
            held = {t: conn.execute(sql.SQL("SELECT count(*) AS n FROM ops.{}").format(sql.Identifier(t))).fetchone()["n"]
                    for t in SOURCES}
            if any(held.values()) and not replace:
                busy = {t: n for t, n in held.items() if n}
                raise ImportError_(f"the ops tables already hold rows {busy}; pass --replace to empty them first")
            if replace:
                conn.execute(sql.SQL("TRUNCATE {} RESTART IDENTITY").format(
                    sql.SQL(", ").join(sql.SQL("ops.{}").format(sql.Identifier(t)) for t in SOURCES)))
            for t, rows in data.items():
                spec = TABLES[t]
                cols = [c for c in spec["columns"] if c not in spec["generated"] and (not rows or c in rows[0])]
                if rows:
                    q = sql.SQL("INSERT INTO ops.{} ({}) OVERRIDING SYSTEM VALUE VALUES ({})" if spec["identity"] else
                                "INSERT INTO ops.{} ({}) VALUES ({})").format(
                        sql.Identifier(t), sql.SQL(", ").join(map(sql.Identifier, cols)),
                        sql.SQL(", ").join(sql.Placeholder() * len(cols)))
                    with conn.cursor() as cur:
                        cur.executemany(q, [[Jsonb(r[c]) if c in spec["json"] and r[c] is not None else r[c] for c in cols]
                                            for r in rows])
                for ic in spec["identity"]:
                    conn.execute(sql.SQL("SELECT setval(pg_get_serial_sequence(%s, %s), GREATEST(COALESCE(MAX({}), 0), 1), "
                                         "MAX({}) IS NOT NULL) FROM ops.{}").format(sql.Identifier(ic), sql.Identifier(ic),
                                                                                 sql.Identifier(t)), (f"ops.{t}", ic))
                back = conn.execute(sql.SQL("SELECT {} FROM ops.{}").format(
                    sql.SQL(", ").join(map(sql.Identifier, cols)) if cols else sql.SQL("*"), sql.Identifier(t))).fetchall()
                d_src, d_dst = digest(rows, spec["pk"], cols), digest(back, spec["pk"], cols)
                ok = len(rows) == len(back) and d_src == d_dst
                report["tables"][t] = {"rows": len(rows), "rows_back": len(back), "sha256": d_dst, "ok": ok}
                if not ok:
                    raise ImportError_(f"VERIFY FAILED on ops.{t}: {len(rows)} rows / {d_src[:12]} in, "
                                       f"{len(back)} rows / {d_dst[:12]} back; rolled back")
                log(f"[import] ops.{t}: {len(rows)} rows, sha256 {d_dst[:12]} verified")
    report["ok"] = all(v["ok"] for v in report["tables"].values())
    report["rows"] = sum(v["rows"] for v in report["tables"].values())
    report["seconds"] = round(time.time() - t0, 2)
    out = config.log_dir() / f"import-cockpit-{time.strftime('%Y%m%dT%H%M%S')}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    report["report_path"] = str(out)
    return report
