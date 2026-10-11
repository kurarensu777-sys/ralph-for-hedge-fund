"""The catalog: stats per series, coverage, the pending queue when Postgres is down, rebuild, and
the real PgCatalog on a throwaway cluster (db-core's `db` fixture; skipped without binaries)."""
import psycopg
import pytest

from fund_db import market
from fund_db.market import catalog
from fund_db.market.registry import get

from .conftest import H, T0


def test_candle_gaps_on_the_interval_grid(lake):
    bars = [{"t": T0 + i * H, "o": 1.0, "h": 1.0, "l": 1.0, "c": 1.0, "v": 1.0, "n": 1} for i in (0, 1, 4, 5)]
    market.write_candles("venue_g", "BTC", "1h", bars, now=T0 + 10 * H)
    r = market.coverage("candles", "venue_g", "BTC")[0]
    assert (r["rows"], r["gaps"], r["step_ms"], r["interval"]) == (4, 2, H, "1h")


def test_funding_gaps_use_the_published_interval(lake):
    rows = [{"ts": T0 + i * H, "rate": 1e-5, "interval_h": 1.0} for i in (0, 1, 2, 5)]
    market.write_funding("venue_g", rows, symbol="BTC")
    assert market.coverage("funding", "venue_g", "BTC")[0]["gaps"] == 2


def test_no_grid_means_no_gap_count(lake):
    market.write_rows("quotes", "venue_a", [{"symbol": "X", "ts": T0, "bid": 1.0}])
    assert market.coverage("quotes")[0]["gaps"] is None


def test_coverage_survives_refreshes(lake):
    market.set_coverage("funding", "venue_a", "A", 1, 2)
    market.write_funding("venue_a", [{"ts": T0, "rate": 1.0}], symbol="A")
    r = market.coverage("funding", "venue_a", "A")[0]
    assert (r["covered_from"], r["covered_to"], r["rows"]) == (1, 2, 1)


class Down:
    def upsert(self, rows):
        raise psycopg.OperationalError("connection refused")

    def set_coverage(self, *a):
        raise psycopg.OperationalError("connection refused")

    def query(self, *a):
        raise psycopg.OperationalError("connection refused")


def test_a_down_catalog_never_blocks_a_write_and_is_replayed(lake, capsys):
    catalog.use(Down())
    rep = market.write_funding("venue_a", [{"ts": T0, "rate": 1.0}], symbol="A")
    market.set_coverage("funding", "venue_a", "A", 5, 6)
    assert rep["added"] == 1 and "queued" in capsys.readouterr().err
    assert market.funding("venue_a", as_="rows")[0]["rate"] == 1.0
    mem = catalog.MemoryCatalog()
    catalog.use(mem)
    assert catalog.drain() == 2
    r = mem.query("funding", "venue_a", "A")[0]
    assert (r["rows"], r["covered_from"]) == (1, 5)
    assert not catalog._pending_path().exists()


def test_a_real_error_is_not_swallowed(lake):
    class Broken(Down):
        def upsert(self, rows):
            raise RuntimeError("bug")
    catalog.use(Broken())
    with pytest.raises(RuntimeError):
        market.write_funding("venue_a", [{"ts": T0, "rate": 1.0}], symbol="A")


def test_rebuild_from_the_lake(lake):
    market.write_funding("venue_a", [{"ts": T0, "rate": 1.0}], symbol="A")
    market.write_funding("venue_l", [{"ts": T0, "rate": 1.0}], symbol="B")
    mem = catalog.MemoryCatalog()
    catalog.use(mem)
    catalog.rebuild("funding", log=lambda *_: None)
    assert {(r["venue"], r["symbol"]) for r in mem.query("funding")} == {("venue_a", "A"), ("venue_l", "B")}


def test_series_stats_reports_an_emptied_series(lake):
    market.write_funding("venue_a", [{"ts": T0, "rate": 1.0}], symbol="A")
    rows = catalog.series_stats(get("funding"), "venue_a", None, ["A", "GONE"])
    assert {r["symbol"]: r["rows"] for r in rows} == {"A": 1, "GONE": 0}


def test_pg_catalog_on_a_real_cluster(db, lake):   # db first: it reads the cluster root
    pg = catalog.PgCatalog()
    catalog.use(pg)
    market.write_funding("venue_a", [{"ts": T0, "rate": 1.0}, {"ts": T0 + 8 * H, "rate": 2.0}], symbol="A")
    market.set_coverage("funding", "venue_a", "A", T0, T0 + 8 * H)
    r = market.coverage("funding", "venue_a", "A")[0]
    assert (r["rows"], r["first_ts"], r["last_ts"], r["covered_to"]) == (2, T0, T0 + 8 * H, T0 + 8 * H)
    assert r["by_src"] == {"venue": 2}
    market.write_funding("venue_a", [{"ts": T0 + 16 * H, "rate": 3.0}], symbol="A")
    r = market.coverage("funding", "venue_a", "A")[0]
    assert r["rows"] == 3 and r["covered_from"] == T0
