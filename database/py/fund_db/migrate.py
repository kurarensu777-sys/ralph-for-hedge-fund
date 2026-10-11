"""The migration runner. The node runner (node/src/migrate.ts) implements the SAME rules on the SAME
files, and tests/test_contract.py holds the two to it.

    migrations/<track>/<NNN>_<name>.sql

* A TRACK is a folder: `ops` (the cockpit's tables, owned by the database core), `market` (the lake
  catalog, owned by fund_db.market), and any later one. `ops` runs first, then the rest by name.
* Within a track, files run in number order; a number is applied exactly when (track, number) is
  not in the ledger, so a lower number landing after a higher one still runs. A number used twice
  in one track is refused.
* Each file runs in ONE transaction with its ledger row, unless its first line is
  `-- fund_db: no-transaction` (for CREATE INDEX CONCURRENTLY and friends).
* The ledger (public.fund_migrations) keeps each file's sha256 over its LF-normalised text. An
  APPLIED file whose text changed is DRIFT: migrate refuses to run until it is resolved, because
  the database no longer matches what the file says. Fix forward with a new number instead.
* One runner at a time: a session advisory lock serialises concurrent migrators.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

from . import config

LEDGER = "public.fund_migrations"
LOCK_KEY = 7146_0000_0001  # pg_advisory_lock key shared with node/src/migrate.ts
NO_TX = "-- fund_db: no-transaction"
FILE_RE = re.compile(r"^(\d+)_[A-Za-z0-9_.-]+\.sql$")
FIRST_TRACK = "ops"


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Migration:
    track: str
    n: int
    file: str
    path: Path

    @property
    def text(self) -> str:
        return self.path.read_text(encoding="utf-8").replace("\r\n", "\n")

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()

    @property
    def transactional(self) -> bool:
        return not self.text.lstrip().startswith(NO_TX)


def track_order(names) -> list[str]:
    return sorted(names, key=lambda t: (t != FIRST_TRACK, t))


def discover(root: Path | None = None) -> list[Migration]:
    """Every migration file, in the order the runner applies them."""
    root = root or config.migrations_dir()
    if not root.is_dir():
        raise MigrationError(f"no migrations folder at {root}")
    out: list[Migration] = []
    tracks = [p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith((".", "_"))]
    for track in track_order(tracks):
        seen: dict[int, str] = {}
        for p in sorted((root / track).iterdir()):
            if not p.is_file() or not p.name.endswith(".sql"):
                continue
            m = FILE_RE.match(p.name)
            if not m:
                raise MigrationError(f"{track}/{p.name}: a migration is named <NNN>_<name>.sql")
            n = int(m.group(1))
            if n in seen:
                raise MigrationError(f"{track}: number {n} is used twice: {seen[n]} and {p.name}")
            seen[n] = p.name
            out.append(Migration(track, n, p.name, p))
    order = track_order({x.track for x in out})
    out.sort(key=lambda x: (order.index(x.track), x.n))
    return out


LEDGER_DDL = f"""
CREATE TABLE IF NOT EXISTS {LEDGER} (
  track       text NOT NULL,
  n           integer NOT NULL,
  file        text NOT NULL,
  sha256      text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (track, n)
)"""


def _ledger(conn) -> dict[tuple[str, int], dict]:
    conn.execute(LEDGER_DDL)
    rows = conn.execute(f"SELECT track, n, file, sha256, applied_at FROM {LEDGER}").fetchall()
    return {(r["track"], r["n"]): {"file": r["file"], "sha256": r["sha256"], "applied_at": r["applied_at"]} for r in rows}


def plan(conn, root: Path | None = None) -> dict:
    """{'applied': [...], 'pending': [Migration], 'drift': [...], 'unknown': [...]} - reads only."""
    files = discover(root)
    led = _ledger(conn)
    conn.commit()
    have = {(m.track, m.n): m for m in files}
    applied, pending, drift = [], [], []
    for m in files:
        row = led.get((m.track, m.n))
        if row is None:
            pending.append(m)
        elif row["sha256"] != m.sha256:
            drift.append({"track": m.track, "n": m.n, "file": m.file, "ledger_sha256": row["sha256"], "file_sha256": m.sha256})
        else:
            applied.append(m)
    unknown = [{"track": t, "n": n, "file": r["file"]} for (t, n), r in sorted(led.items()) if (t, n) not in have]
    return {"applied": applied, "pending": pending, "drift": drift, "unknown": unknown}


def migrate(dsn: str | None = None, root: Path | None = None, log=print) -> list[str]:
    """Apply every pending migration. Returns the '<track>/<file>' names applied (empty = up to date)."""
    from .db import connect

    done: list[str] = []
    with connect(dsn, autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (LOCK_KEY,))
        try:
            conn.autocommit = False
            p = plan(conn, root)
            if p["drift"]:
                d = p["drift"][0]
                raise MigrationError(
                    f"DRIFT: {d['track']}/{d['file']} was applied with sha256 {d['ledger_sha256'][:12]} but the file now "
                    f"hashes {d['file_sha256'][:12]}. An applied migration is never edited; restore it and fix forward "
                    f"with a new number ({len(p['drift'])} drifted).")
            for m in p["pending"]:
                sql = m.text
                try:
                    if m.transactional:
                        with conn.transaction():
                            conn.execute(sql)
                            conn.execute(f"INSERT INTO {LEDGER} (track, n, file, sha256) VALUES (%s, %s, %s, %s)",
                                         (m.track, m.n, m.file, m.sha256))
                    else:
                        conn.commit()
                        conn.autocommit = True
                        conn.execute(sql)
                        conn.execute(f"INSERT INTO {LEDGER} (track, n, file, sha256) VALUES (%s, %s, %s, %s)",
                                     (m.track, m.n, m.file, m.sha256))
                        conn.autocommit = False
                except Exception as e:
                    if not conn.autocommit:
                        conn.rollback()
                    raise MigrationError(f"{m.track}/{m.file} failed: {e}") from e
                conn.commit()
                done.append(f"{m.track}/{m.file}")
                log(f"[migrate] applied {m.track}/{m.file}")
        finally:
            conn.autocommit = True
            conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_KEY,))
    return done
