"""The writer and the readers end to end on a throwaway lake: layout, merge rules on disk,
conflicts, rewrites, compaction, crash recovery, windows, and the refusals."""
import json
import os

import pyarrow.parquet as pq
import pytest

from fund_db import market
from fund_db.market import writer
from fund_db.market.registry import get

from .conftest import H, T0


def funding_rows(n=5, start=T0, step=8 * H, **kw):
    return [{"ts": start + i * step, "rate": 1e-5 * (i + 1), **kw} for i in range(n)]


def parts(lake_root, *rel):
    return sorted((lake_root / "market").joinpath(*rel).glob("part-*.parquet"))


def test_write_then_read_back_every_column(lake):
    rep = market.write_funding("venue_a", funding_rows(3, interval_h=8.0), symbol="BTCUSDT", now=7)
    assert rep["added"] == 3 and rep["parts_written"] == 1
    rows = market.funding("venue_a", "BTCUSDT", as_="rows")
    assert [r["ts"] for r in rows] == [T0, T0 + 8 * H, T0 + 16 * H]
    assert rows[0] == {"venue": "venue_a", "symbol": "BTCUSDT", "ts": T0, "rate": 1e-5,
                       "interval_h": 8.0, "interval_src": "venue", "rate_type": None,
                       "premium": None, "src": "venue", "seen": 7}


def test_layout_is_venue_month_and_symbol_is_a_column(lake):
    market.write_funding("venue_l", funding_rows(1), symbol="BTC-USDT-SWAP")
    p = parts(lake["root"], "funding", "venue=venue_l", "month=2026-09")
    assert len(p) == 1
    t = pq.read_table(p[0])
    assert "symbol" in t.column_names and "venue" not in t.column_names
    assert t.schema.field("rate").type == "double"


def test_rows_split_across_months(lake):
    rows = [{"ts": T0 - H, "rate": 1.0}, {"ts": T0, "rate": 2.0}]
    market.write_funding("venue_c", rows, symbol="X")
    months = sorted(p.name for p in (lake["root"] / "market" / "funding" / "venue=venue_c").iterdir())
    assert months == ["month=2026-08", "month=2026-09"]
    assert market.funding("venue_c", start=T0, as_="rows")[0]["rate"] == 2.0
    assert market.funding("venue_c", end=T0 - 1, as_="rows")[0]["rate"] == 1.0


def test_inferred_cadence_is_refused(lake):
    with pytest.raises(market.WriteError, match="inferred cadence"):
        market.write_funding("gate", [{"ts": T0, "rate": 1.0, "interval_h": 8.0, "interval_src": "map"}],
                             symbol="X")


def test_required_columns_are_enforced(lake):
    with pytest.raises(market.WriteError, match="rate"):
        market.write_funding("gate", [{"ts": T0}], symbol="X")


def test_settled_conflict_is_kept_out_and_logged(lake, capsys):
    market.write_funding("venue_a", funding_rows(2), symbol="S")
    rep = market.write_funding("venue_a", [{"ts": T0, "rate": 9.0}], symbol="S")
    assert rep["conflict"] == 1 and rep["parts_written"] == 0
    assert market.funding("venue_a", "S", as_="rows")[0]["rate"] == 1e-5
    c = market.conflicts("funding", as_="rows")
    assert len(c) == 1 and c[0]["kind"] == "settled_row_changed"
    assert json.loads(c[0]["incoming"])["rate"] == 9.0
    assert "settled_row_changed" in capsys.readouterr().err


def test_fill_rewrites_the_partition_without_duplicating(lake):
    market.write_funding("venue_g", funding_rows(3), symbol="BTC")
    market.write_funding("venue_g", funding_rows(1, start=T0 + 100 * H), symbol="BTC")
    assert len(parts(lake["root"], "funding", "venue=venue_g", "month=2026-09")) == 2
    rep = market.write_funding("venue_g", [{"ts": T0, "rate": 1e-5, "premium": -0.0003}], symbol="BTC")
    assert rep["upgraded"] == 1 and rep["rewrites"] == 1
    p = parts(lake["root"], "funding", "venue=venue_g", "month=2026-09")
    assert len(p) == 1
    rows = market.funding("venue_g", as_="rows")
    assert len(rows) == 4 and rows[0]["premium"] == -0.0003
    assert not (p[0].parent / writer.JOURNAL).exists()


def test_same_batch_twice_is_idempotent(lake):
    rows = funding_rows(4)
    market.write_funding("venue_k", rows, symbol="A")
    rep = market.write_funding("venue_k", rows, symbol="A")
    assert rep["added"] == 0 and rep["unchanged"] == 4 and rep["parts_written"] == 0


def test_duplicate_key_inside_one_batch_goes_through_the_rules(lake):
    rep = market.write_funding("venue_j", [{"ts": T0, "rate": 1.0}, {"ts": T0, "rate": 2.0}], symbol="A")
    assert rep["added"] == 1 and rep["conflict"] == 1
    assert [r["rate"] for r in market.funding("venue_j", as_="rows")] == [1.0]


def test_venue_a_special_row_one_second_later_is_its_own_row(lake):
    rows = [{"ts": T0, "rate": 1e-4, "rate_type": "regular"},
            {"ts": T0 + 1000, "rate": 5e-4, "rate_type": "special"}]
    market.write_funding("venue_a", rows, symbol="TSLAUSDT")
    got = market.funding("venue_a", "TSLAUSDT", as_="rows")
    assert [r["rate_type"] for r in got] == ["regular", "special"]


def test_candles_closed_is_computed_and_the_forming_bar_updates(lake):
    now = T0 + 2 * H + 10
    bars = [{"t": T0 + i * H, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.0 + i, "v": 1.0, "n": 1} for i in range(3)]
    market.write_candles("venue_g", "BTC", "1h", bars, now=now)
    got = market.candles("venue_g", "BTC", "1h", as_="rows")
    assert [b["closed"] for b in got] == [True, True, False]
    assert got[0]["interval"] == "1h"
    later = T0 + 3 * H + 5
    rep = market.write_candles("venue_g", "BTC", "1h", [dict(bars[2], c=9.0)], now=later)
    assert rep["updated"] == 1
    last = market.candles("venue_g", "BTC", "1h", as_="rows")[-1]
    assert last["c"] == 9.0 and last["closed"] is True
    assert len(market.candles("venue_g", "BTC", "1h", closed_only=True, as_="rows")) == 3


def test_closed_candle_change_is_a_conflict(lake):
    b = [{"t": T0, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.0, "v": 1.0, "n": 1}]
    market.write_candles("venue_g", "ETH", "1h", b, now=T0 + 2 * H)
    rep = market.write_candles("venue_g", "ETH", "1h", [dict(b[0], c=1.1)], now=T0 + 3 * H)
    assert rep["conflict"] == 1
    assert market.candles("venue_g", "ETH", "1h", as_="rows")[0]["c"] == 1.0
    assert market.conflicts(as_="rows")[0]["interval"] == "1h"


def test_partial_seed_bars_are_hidden_unless_asked(lake):
    seed = [{"t": T0, "c": 1.0}]
    market.write_candles("venue_g", "SOL", "1h", seed, source="seed:x", closed_asof_ms=T0 + 2 * H)
    assert market.candles("venue_g", "SOL", "1h", as_="rows") == []
    assert len(market.candles("venue_g", "SOL", "1h", complete_only=False, as_="rows")) == 1


def test_observe_drops_exact_duplicates_only(lake):
    q = [{"symbol": "BTC", "ts": T0, "bid": 1.0, "ask": 2.0},
         {"symbol": "BTC", "ts": T0, "bid": 1.0, "ask": 2.0},
         {"symbol": "BTC", "ts": T0, "bid": 1.5, "ask": 2.0}]
    rep = market.write_rows("quotes", "venue_a", q)
    assert rep["added"] == 2 and rep["unchanged"] == 1
    rep = market.write_rows("quotes", "venue_a", q[:1], now=12345)       # a later re-delivery
    assert rep["added"] == 0 and rep["unchanged"] == 1


def test_eod_revision_replaces_and_logs(lake):
    row = {"symbol": "SKHY.US", "date": "2026-07-10", "open": 149.0, "high": 150.0, "low": 148.0,
           "close": 149.0, "adj_close": 149.0, "volume": 0.0}
    market.write_eod([row])
    assert market.eod("SKHY.US", as_="rows")[0]["time"] == 1_783_641_600_000
    rep = market.write_eod([dict(row, volume=1200.0)])
    assert rep["revised"] == 1
    assert market.eod("SKHY.US", as_="rows")[0]["volume"] == 1200.0
    assert market.conflicts("eod", as_="rows")[0]["kind"] == "revised"
    assert market.eod(start="2026-07-11", as_="rows") == []


def test_snapshots_keep_ints_ints(lake):
    rows = [{"ts": "2026-09-21T16:29:08Z", "desk": "lab/x", "subject": "s", "field": "up", "value": 1,
             "unit": "count", "provenance": "[API]", "source": "GET /x"},
            {"ts": "2026-09-21T16:30:08Z", "desk": "lab/x", "subject": "s", "field": "iv",
             "value": 36.8086, "unit": "pct", "provenance": "[API]", "source": "q"}]
    market.write_rows("snapshots", "vol", rows)
    got = market.snapshots("vol", as_="rows")
    assert got[0]["value"] == 1 and isinstance(got[0]["value"], int)
    assert got[1]["value"] == 36.8086 and got[0]["log"] == "vol"
    assert got[0]["t"] == 1_790_008_148_000


def test_snapshot_without_zone_is_refused(lake):
    with pytest.raises(ValueError, match="zone"):
        market.write_rows("snapshots", "vol", [{"ts": "2026-09-21T16:29:08", "desk": "d",
                                                "subject": "s", "field": "f", "value": 1}])


def test_auto_compaction_after_too_many_parts(lake, rules):
    rules("[datasets.funding]\ncompact_parts = 3\n")
    for i in range(4):
        market.write_funding("venue_e", [{"ts": T0 + i * H, "rate": float(i)}], symbol="A")
    p = parts(lake["root"], "funding", "venue=venue_e", "month=2026-09")
    assert len(p) == 1 and pq.ParquetFile(p[0]).metadata.num_rows == 4


def test_compact_command(lake):
    for i in range(3):
        market.write_funding("venue_e", [{"ts": T0 + i * H, "rate": float(i)}], symbol="A")
    out = market.compact("funding")
    assert out[0]["parts"] == 3 and out[0]["rows"] == 3
    assert len(parts(lake["root"], "funding", "venue=venue_e", "month=2026-09")) == 1


def _crash_state(lake, new_landed: bool):
    market.write_funding("venue_l", funding_rows(2), symbol="A")
    market.write_funding("venue_l", funding_rows(1, start=T0 + 50 * H), symbol="A")
    pdir = lake["root"] / "market" / "funding" / "venue=venue_l" / "month=2026-09"
    old = sorted(pdir.glob("part-*.parquet"))
    full = pq.read_table(old[0]).to_pylist() + pq.read_table(old[1]).to_pylist()
    new = pdir / "part-9-rcrash.parquet"
    tmp = pdir / ".part-9-rcrash.parquet.tmp"
    import pyarrow as pa
    t = pa.Table.from_pylist(full, schema=get("funding").schema)
    pq.write_table(t, new if new_landed else tmp)
    (pdir / writer.JOURNAL).write_text(json.dumps({"new": str(new), "tmp": str(tmp),
                                                   "old": [str(p) for p in old]}), encoding="utf-8")
    return pdir, old, new, tmp


def test_crash_after_rename_readers_see_each_row_once_and_recovery_completes(lake):
    pdir, old, new, tmp = _crash_state(lake, new_landed=True)
    assert len(market.funding("venue_l", as_="rows")) == 3              # journal hides the old parts
    assert writer.recover(pdir).startswith("completed")
    assert sorted(pdir.glob("part-*.parquet")) == [new]
    assert len(market.funding("venue_l", as_="rows")) == 3


def test_crash_before_rename_rolls_back(lake):
    pdir, old, new, tmp = _crash_state(lake, new_landed=False)
    assert len(market.funding("venue_l", as_="rows")) == 3
    assert writer.recover(pdir).startswith("rolled back")
    assert sorted(pdir.glob("part-*.parquet")) == old and not tmp.exists()


def test_next_write_recovers_first(lake):
    pdir, old, new, tmp = _crash_state(lake, new_landed=True)
    market.write_funding("venue_l", funding_rows(1, start=T0 + 60 * H), symbol="A")
    assert not (pdir / writer.JOURNAL).exists()
    assert len(market.funding("venue_l", as_="rows")) == 4


def test_reader_columns_symbols_and_where(lake):
    market.write_funding("venue_b", funding_rows(3), symbol="A")
    market.write_funding("venue_b", funding_rows(2), symbol="B")
    t = market.funding("venue_b", ["B"], cols=["symbol", "ts", "rate"])
    assert t.column_names == ["symbol", "ts", "rate"] and t.num_rows == 2
    assert market.funding(where="rate > ?", params=[2.5e-5], as_="rows")[0]["symbol"] == "A"
    assert market.funding("nowhere").num_rows == 0
    with pytest.raises(ValueError):
        market.funding(cols=["nope"])
    df = market.funding("venue_b", as_="pandas")
    assert len(df) == 5 and list(df["venue"].unique()) == ["venue_b"]


def test_empty_read_has_the_schema(lake):
    t = market.candles("venue_g", "BTC", "1h")
    assert t.num_rows == 0 and "closed" in t.column_names and t.schema.field("t").type == "int64"


def test_register_views_for_duckdb(lake):
    import duckdb
    market.write_funding("venue_a", funding_rows(3), symbol="A")
    con = duckdb.connect()
    market.register_views(con)
    assert con.execute("select venue, count(*) from funding group by 1").fetchall() == [("venue_a", 3)]


def test_catalog_row_per_series(lake):
    market.write_funding("venue_a", funding_rows(4, step=8 * H) + funding_rows(1, start=T0 + 64 * H),
                         symbol="A")
    r = market.coverage("funding", "venue_a", "A")[0]
    assert r["rows"] == 5 and r["first_ts"] == T0 and r["last_ts"] == T0 + 64 * H
    assert r["step_ms"] == 8 * H and r["gaps"] == 4          # 32h..64h misses 40, 48, 56 ... (4)
    assert r["by_src"] == {"venue": 5} and r["retention"] == "forever"


def test_windows_skip_whole_months(lake):
    market.write_funding("venue_a", [{"ts": T0 - 40 * 24 * H, "rate": 1.0}, {"ts": T0, "rate": 2.0}],
                         symbol="A")
    from fund_db.market.reader import files
    assert len(files(get("funding"), "venue_a", start_ms=T0, end_ms=T0 + H)) == 1


def test_no_temp_files_left(lake):
    market.write_funding("venue_a", funding_rows(3), symbol="A")
    left = [p for p, _, fs in os.walk(lake["root"]) for f in fs if f.endswith(".tmp")]
    assert left == []
