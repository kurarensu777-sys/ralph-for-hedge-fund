"""fund_db.sql(): lake views over hot + cold Parquet with hive partitions, and the ops store attached
read-only as `pg`, in one DuckDB query."""
from __future__ import annotations

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

import fund_db
from fund_db import lake, ops


def _part(root, place, dataset, venue, month, rows, name="part-0.parquet"):
    d = root / place / dataset / f"venue={venue}" / f"month={month}"
    d.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.table(rows), d / name, compression="zstd")


@pytest.fixture
def lakeroot(db, tmp_path, monkeypatch):
    monkeypatch.setenv("FUND_DB_DIR", str(tmp_path))
    lake.reset()
    yield tmp_path
    lake.reset()


def test_views_span_hot_and_cold_with_partition_columns(lakeroot):
    _part(lakeroot, "market", "zz_test", "venue_a", "2026-09", {"symbol": ["BTC", "ETH"], "v": [1.0, 2.0]})
    _part(lakeroot, "market", "zz_test", "venue_c", "2026-09", {"symbol": ["BTC"], "v": [3.0]})
    _part(lakeroot, "cold", "zz_test", "venue_a", "2025-01", {"symbol": ["BTC"], "v": [0.5]})
    (lakeroot / "market" / "_files" / "x").mkdir(parents=True)
    rows = fund_db.sql("SELECT venue, month, count(*) AS n, sum(v) AS s FROM zz_test GROUP BY 1, 2 ORDER BY 1, 2", as_="rows")
    assert rows == [{"venue": "venue_a", "month": "2025-01", "n": 1, "s": 0.5},
                    {"venue": "venue_a", "month": "2026-09", "n": 2, "s": 3.0},
                    {"venue": "venue_c", "month": "2026-09", "n": 1, "s": 3.0}]
    assert "_files" not in lake.views()


def test_a_new_dataset_appears_without_a_restart_and_a_removed_one_goes(lakeroot):
    with pytest.raises(duckdb.Error):
        fund_db.sql("SELECT * FROM zz_new")
    _part(lakeroot, "market", "zz_new", "venue_l", "2026-08", {"x": [1]})
    assert fund_db.sql("SELECT count(*) AS n FROM zz_new", as_="rows") == [{"n": 1}]
    for f in (lakeroot / "market" / "zz_new").rglob("*.parquet"):
        f.unlink()
    lake.connection()
    assert "zz_new" not in lake.views()


def test_the_ops_store_joins_the_lake_in_one_query(lakeroot):
    ops.log_event("job", "lake join", agent="app")
    _part(lakeroot, "market", "zz_test", "venue_a", "2026-09", {"agent": ["app"], "v": [7.0]})
    rows = fund_db.sql("SELECT e.summary, t.v FROM pg.ops.events e JOIN zz_test t ON t.agent = e.agent_id", as_="rows")
    assert lake.pg_error() is None
    assert rows == [{"summary": "lake join", "v": 7.0}]


def test_pg_is_attached_read_only(lakeroot):
    with pytest.raises(duckdb.Error, match="(?i)read.only"):
        fund_db.sql("INSERT INTO pg.ops.board_attest VALUES ('x', 'y', 1, 'z')")
    assert ops.count("board_attest") == 0


def test_result_shapes_and_parameters(lakeroot):
    _part(lakeroot, "market", "zz_test", "venue_a", "2026-09", {"symbol": ["BTC", "ETH"], "v": [1.0, 2.0]})
    t = fund_db.sql("SELECT symbol, v FROM zz_test WHERE v > ? ORDER BY symbol", [1.5])
    assert isinstance(t, pa.Table) and t.to_pylist() == [{"symbol": "ETH", "v": 2.0}]
    df = fund_db.sql("SELECT count(*) AS n FROM zz_test", as_="pandas")
    assert int(df["n"].iloc[0]) == 2
    with pytest.raises(ValueError):
        fund_db.sql("SELECT 1", as_="xml")


def test_the_lake_still_answers_with_the_ops_store_down(lakeroot, monkeypatch):
    monkeypatch.setenv("FUND_DB_DSN", "host=127.0.0.1 port=1 user=fund dbname=nope connect_timeout=1")
    lake.reset()
    _part(lakeroot, "market", "zz_test", "venue_a", "2026-09", {"v": [1.0]})
    assert fund_db.sql("SELECT count(*) AS n FROM zz_test", as_="rows") == [{"n": 1}]
    assert lake.pg_error()
