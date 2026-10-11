"""python -m fund_db: doctor, migrate --status, schema --check, usage, import-cockpit, pg."""
from __future__ import annotations

import json

from fund_db import cli, config


def _by_check(checks):
    return {c["check"]: c for c in checks}


def test_doctor_is_green_on_a_healthy_layer(db, capsys):
    checks = _by_check(cli.doctor_checks())
    fails = [c for c in checks.values() if c["status"] == "fail"]
    assert fails == []
    for name in ("binaries", "server running", "connect", "listens on 127.0.0.1 only", "pg_hba 127.0.0.1 trust only",
                 "migrations", "duckdb attaches postgres", "data root outside git"):
        assert checks[name]["status"] == "ok", checks[name]
    assert cli.main(["doctor", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)


def test_doctor_goes_red_on_an_open_pg_hba(db):
    hba = config.pgdata_dir() / "pg_hba.conf"
    before = hba.read_text(encoding="utf-8")
    try:
        hba.write_text(before + "host all all 0.0.0.0/0 trust\n", encoding="utf-8")
        c = _by_check(cli.doctor_checks())["pg_hba 127.0.0.1 trust only"]
        assert c["status"] == "fail" and "2 rule(s)" in c["detail"]
    finally:
        hba.write_text(before, encoding="utf-8")


def test_doctor_goes_red_on_a_pending_or_drifted_ledger(db):
    from fund_db.db import connect
    with connect(db, autocommit=True) as c:
        c.execute("UPDATE public.fund_migrations SET sha256 = 'tampered' WHERE track = 'ops' AND n = 1")
    assert _by_check(cli.doctor_checks())["migrations"]["status"] == "fail"
    assert cli.main(["migrate", "--status"]) == 1
    assert cli.main(["migrate"]) == 1                    # refuses to run over drift


def test_migrate_status_and_schema_check(db, capsys):
    assert cli.main(["migrate", "--status"]) == 0
    out = capsys.readouterr().out
    assert "applied  ops/001_cockpit.sql" in out and "PENDING" not in out
    assert cli.main(["migrate"]) == 0 and "up to date" in capsys.readouterr().out
    assert cli.main(["schema", "--check"]) == 0


def test_usage_reports_the_ops_store(db, capsys):
    assert cli.main(["usage", "--json"]) == 0
    got = json.loads(capsys.readouterr().out)
    assert got["ops"]["database_bytes"] > 0
    assert any(t["name"] == "ops.events" for t in got["ops"]["tables"])
    assert "datasets" in got["lake"]


def test_tier_and_prune_are_dry_runs_by_default(db, capsys):
    assert cli.main(["tier"]) == 0 and "dry run" in capsys.readouterr().out
    assert cli.main(["prune"]) == 0 and "dry run" in capsys.readouterr().out


def test_pg_status_passes_through(db, capsys):
    assert cli.main(["pg", "status"]) == 0
    assert "running" in capsys.readouterr().out


def test_import_cockpit_through_the_cli(db, tmp_path, capsys):
    from test_importer import make_cockpit
    src = make_cockpit(tmp_path / "cockpit.db")
    assert cli.main(["import-cockpit", "--sqlite", str(src)]) == 0
    assert "[import] OK" in capsys.readouterr().out
    assert cli.main(["import-cockpit", "--sqlite", str(src)]) == 1        # second time: refused, not doubled
    assert "already hold rows" in capsys.readouterr().err


def test_doctor_goes_red_on_a_blob_whose_file_is_gone(db, tmp_path, monkeypatch):
    from fund_db import market
    monkeypatch.setenv("FUND_DB_DIR", str(tmp_path / "db"))
    from fund_db.market import storage
    storage.use(storage.PgStorage())
    try:
        assert _by_check(cli.doctor_checks())["blobs intact"]["status"] == "ok"
        r = market.blob_put("derived", "t/2026-10-01@v1", b"day" * 40, reason="r", ref="s#1")
        c = _by_check(cli.doctor_checks())["blobs intact"]
        assert c["status"] == "ok" and "1 blob(s)" in c["detail"]
        market.blob_path(r["hash"]).unlink()
        c = _by_check(cli.doctor_checks())["blobs intact"]
        assert c["status"] == "fail" and "1 file(s) missing" in c["detail"]
        assert cli.main(["pins", "--blobs"]) == 1
    finally:
        storage.use(None)
