"""The migration runner: order, refusals, idempotence, drift, rollback, one runner at a time."""
from __future__ import annotations

import threading
from pathlib import Path

import pytest

from fund_db import migrate
from fund_db.db import connect


def _quiet(*_):
    pass


def _tree(tmp_path: Path, files: dict[str, str]) -> Path:
    root = tmp_path / "migrations"
    for rel, text in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return root


def _exists(dsn: str, rel: str) -> bool:
    with connect(dsn) as c:
        return c.execute("SELECT to_regclass(%s) AS r", (rel,)).fetchone()["r"] is not None


def test_discover_runs_ops_first_then_tracks_by_name_then_numbers(tmp_path):
    root = _tree(tmp_path, {"zeta/001_a.sql": "", "ops/010_b.sql": "", "ops/002_a.sql": "", "alpha/005_x.sql": "",
                            "_ignored/001_x.sql": ""})
    assert [f"{m.track}/{m.file}" for m in migrate.discover(root)] == [
        "ops/002_a.sql", "ops/010_b.sql", "alpha/005_x.sql", "zeta/001_a.sql"]


def test_discover_refuses_a_reused_number_and_a_bad_name(tmp_path):
    with pytest.raises(migrate.MigrationError, match="used twice"):
        migrate.discover(_tree(tmp_path / "a", {"ops/001_a.sql": "", "ops/001_b.sql": ""}))
    with pytest.raises(migrate.MigrationError, match="NNN"):
        migrate.discover(_tree(tmp_path / "b", {"ops/first.sql": ""}))


def test_the_repo_migrations_apply_once_and_then_are_up_to_date(empty_db):
    done = migrate.migrate(empty_db, log=_quiet)
    assert done[0] == "ops/001_cockpit.sql"
    assert migrate.migrate(empty_db, log=_quiet) == []
    with connect(empty_db) as c:
        p = migrate.plan(c)
    assert not p["pending"] and not p["drift"] and not p["unknown"]
    assert len(p["applied"]) == len(migrate.discover())


def test_an_edited_applied_migration_is_drift_and_blocks(empty_db, tmp_path):
    root = _tree(tmp_path, {"ops/001_t.sql": "CREATE TABLE public.t1 (a int);"})
    migrate.migrate(empty_db, root, log=_quiet)
    (root / "ops" / "001_t.sql").write_text("CREATE TABLE public.t1 (a int, b int);", encoding="utf-8")
    (root / "ops" / "002_u.sql").write_text("CREATE TABLE public.t2 (a int);", encoding="utf-8")
    with pytest.raises(migrate.MigrationError, match="DRIFT: ops/001_t.sql"):
        migrate.migrate(empty_db, root, log=_quiet)
    assert not _exists(empty_db, "public.t2")   # nothing after the drift ran


def test_crlf_checkout_is_not_drift(empty_db, tmp_path):
    root = _tree(tmp_path, {"ops/001_t.sql": "CREATE TABLE public.t1 (a int);\n-- two\n"})
    migrate.migrate(empty_db, root, log=_quiet)
    (root / "ops" / "001_t.sql").write_bytes(b"CREATE TABLE public.t1 (a int);\r\n-- two\r\n")
    assert migrate.migrate(empty_db, root, log=_quiet) == []


def test_a_failing_migration_rolls_back_whole_and_leaves_no_ledger_row(empty_db, tmp_path):
    root = _tree(tmp_path, {"ops/001_ok.sql": "CREATE TABLE public.ok1 (a int);",
                            "ops/002_bad.sql": "CREATE TABLE public.half (a int); SELECT 1/0;"})
    with pytest.raises(migrate.MigrationError, match="002_bad.sql failed"):
        migrate.migrate(empty_db, root, log=_quiet)
    assert _exists(empty_db, "public.ok1") and not _exists(empty_db, "public.half")
    with connect(empty_db) as c:
        rows = c.execute("SELECT track, n FROM public.fund_migrations ORDER BY n").fetchall()
    assert [(r["track"], r["n"]) for r in rows] == [("ops", 1)]


def test_a_lower_number_landing_later_still_runs(empty_db, tmp_path):
    root = _tree(tmp_path, {"ops/005_b.sql": "CREATE TABLE public.b (a int);"})
    migrate.migrate(empty_db, root, log=_quiet)
    (root / "ops" / "003_a.sql").write_text("CREATE TABLE public.a (a int);", encoding="utf-8")
    assert migrate.migrate(empty_db, root, log=_quiet) == ["ops/003_a.sql"]


def test_no_transaction_header_allows_concurrent_index(empty_db, tmp_path):
    root = _tree(tmp_path, {"ops/001_t.sql": "CREATE TABLE public.t (a int);",
                            "ops/002_i.sql": "-- fund_db: no-transaction\nCREATE INDEX CONCURRENTLY t_a ON public.t (a);"})
    assert len(migrate.migrate(empty_db, root, log=_quiet)) == 2
    assert _exists(empty_db, "public.t_a")


def test_without_the_header_concurrent_index_fails_so_the_header_is_what_made_it_pass(empty_db, tmp_path):
    root = _tree(tmp_path, {"ops/001_t.sql": "CREATE TABLE public.t (a int);",
                            "ops/002_i.sql": "CREATE INDEX CONCURRENTLY t_a ON public.t (a);"})
    with pytest.raises(migrate.MigrationError, match="002_i.sql failed"):
        migrate.migrate(empty_db, root, log=_quiet)


def test_two_runners_at_once_apply_each_file_exactly_once(empty_db, tmp_path):
    root = _tree(tmp_path, {f"ops/{i:03d}_t.sql": f"CREATE TABLE public.c{i} (a int); SELECT pg_sleep(0.05);"
                            for i in range(1, 6)})
    results, errors = [], []

    def run():
        try:
            results.append(migrate.migrate(empty_db, root, log=_quiet))
        except Exception as e:
            errors.append(e)

    ts = [threading.Thread(target=run) for _ in range(3)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert not errors, errors
    assert sorted(len(r) for r in results) == [0, 0, 5]
