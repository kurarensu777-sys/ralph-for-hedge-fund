"""The generated files (schema/, ops/rows.py, node/src/rows.ts) match what the migrations build."""
from __future__ import annotations

from fund_db import schema
from fund_db.db import connect


def test_generated_files_are_current(db):
    with connect(db) as c:
        stale = schema.stale(c)
    assert stale == [], f"run `python -m fund_db schema --write`: stale {stale}"


def test_the_check_goes_red_when_the_database_moves(db):
    with connect(db, autocommit=True) as c:
        c.execute("ALTER TABLE ops.events ADD COLUMN extra text")
        stale = {p.name for p in schema.stale(c)}
    assert {"ops.sql", "rows.py", "rows.ts"} <= stale


def test_every_ops_table_has_a_primary_key(db):
    with connect(db) as c:
        tbls = schema.tables(c, "ops")
    assert len(tbls) == 36
    assert all(t["pk"] for t in tbls), [t["name"] for t in tbls if not t["pk"]]
