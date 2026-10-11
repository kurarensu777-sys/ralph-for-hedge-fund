"""fund_db.backup: pg_dump of the ops database into one checked archive per local day, the newest N
kept - against the test session's throwaway cluster, never the real data root."""
from __future__ import annotations

import os
import subprocess
from datetime import datetime
from pathlib import Path

import pytest

from fund_db import backup, config, ops
from fund_db.cli import main as cli

BIN = Path(os.environ.get("FUND_PG_BIN") or Path.home() / "fund-data" / "db" / "pgsql" / "bin")
EXE = ".exe" if os.name == "nt" else ""


def _ms(y, m, d, h=3):
    return int(datetime(y, m, d, h).timestamp() * 1000)


def test_dump_checks_and_restores_the_same_rows(db, tmp_path):
    for i in range(3):
        ops.log_event("system", f"backup fixture {i}")
    r = backup.backup(tmp_path / "bk", now_ms=_ms(2026, 9, 24), bin_dir=BIN)
    assert r["file"] == "ops-2026-09-24.dump" and r["check"] == "ok" and r["method"] == "pg_dump"
    assert r["tables"] >= 35
    assert not (tmp_path / "bk" / "ops-2026-09-24.dump.part").exists()
    target = "restore_" + os.urandom(4).hex()
    from fund_db.db import connect
    with connect(config.dsn("postgres"), autocommit=True) as c:
        c.execute(f"CREATE DATABASE {target}")
    ci = backup._conninfo()
    out = subprocess.run([str(BIN / f"pg_restore{EXE}"), "-h", ci["host"], "-p", str(ci["port"]), "-U", ci["user"],
                          "-d", target, "-w", r["path"]], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    with connect(config.dsn(target), autocommit=True) as c:
        n = c.execute("SELECT count(*) AS n FROM ops.events WHERE summary LIKE 'backup fixture %%'").fetchone()["n"]
        led = c.execute("SELECT count(*) AS n FROM public.fund_migrations").fetchone()["n"]
    assert n == 3 and led >= 3
    with connect(config.dsn("postgres"), autocommit=True) as c:
        c.execute(f"DROP DATABASE {target} WITH (FORCE)")


def test_same_day_replaces_and_keep_prunes_only_archives(db, tmp_path):
    d = tmp_path / "bk2"
    d.mkdir()
    for day in range(1, 17):
        (d / f"ops-2026-09-{day:02d}.dump").write_text("old")
    (d / "cockpit-2026-09-01.db").write_text("a retired sqlite backup")
    (d / "notes.txt").write_text("not a backup")
    r = backup.backup(d, keep=14, now_ms=_ms(2026, 9, 24), bin_dir=BIN)
    left = [f["day"] for f in backup.list_backups(d)]
    assert len(left) == 14 and left[0] == "2026-09-24" and left[-1] == "2026-09-04"
    assert "ops-2026-09-01.dump" in r["pruned"]
    assert (d / "notes.txt").exists() and (d / "cockpit-2026-09-01.db").exists()


def test_failures_are_loud_and_leave_nothing(db, tmp_path):
    with pytest.raises(FileNotFoundError, match=r"no pg_dump at .*pg\.py ensure"):
        backup.backup(tmp_path / "bk5", bin_dir=tmp_path / "no-bin")
    assert not (tmp_path / "bk5").exists()
    ci = dict(backup._conninfo(), port=1)
    with pytest.raises(RuntimeError, match="pg_dump exited"):
        backup.backup(tmp_path / "bk3", bin_dir=BIN, conninfo=ci, timeout_s=60)
    assert list((tmp_path / "bk3").iterdir()) == []


def test_pure_parts():
    toc = "\n".join([";", "215; 1259 16391 TABLE ops events fund", "216; 1259 16392 TABLE ops usage fund",
                     "3345; 0 16391 TABLE DATA ops events fund", "3000; 1259 16400 INDEX ops events_ts fund"])
    assert backup.listed_tables(toc) == {"data": 1, "tables": 2}
    files = [{"file": f"ops-{d}.dump", "day": d} for d in ("2026-09-03", "2026-09-01", "2026-09-02")]
    assert backup.to_prune(files, 2) == ["ops-2026-09-01.dump"]
    assert len(backup.to_prune(files, 0)) == 3
    now = _ms(2026, 9, 25, 12)
    assert backup.status([], now)["status"] == "unknown"
    f = {"file": "ops-2026-09-24.dump", "day": "2026-09-24", "bytes": 1048576, "mtime_ms": now - 3_600_000}
    assert backup.status([f], now) == {"status": "ok", "reading": "1 kept · 2026-09-24 · 1.0 MB"}
    assert backup.status([dict(f, mtime_ms=now - 37 * 3_600_000)], now)["status"] == "warn"


def test_the_dir_default_and_the_cli_list(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("FUND_DB_BACKUP_DIR", raising=False)
    assert backup.backup_dir() == Path.home() / "fund-data" / "backups" / "db"
    monkeypatch.setenv("FUND_DB_BACKUP_DIR", str(tmp_path))
    (tmp_path / "ops-2026-09-20.dump").write_bytes(b"x")
    os.utime(tmp_path / "ops-2026-09-20.dump", (0, 0))
    assert backup.list_backups()[0]["day"] == "2026-09-20"          # the day is the name's, not the mtime's
    assert cli(["backup", "--list"]) == 0
    assert "1 kept" in capsys.readouterr().out
