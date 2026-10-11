"""The storage classes (B-0322): where a write lands, what is refused, and that a rewrite never
moves a row out of its root. Every test runs on the `classes` fixture: no declaration at all, as
production is before a venue.json declares anything."""
import pytest

from fund_db import market
from fund_db.market import storage

T0 = 1788220800000          # 2026-09-01T00:00:00Z
H = 3_600_000


def files(root, top, *sub):
    return sorted((root / top).joinpath(*sub).rglob("part-*.parquet"))


def test_a_class_none_dataset_is_stored_nowhere(classes):
    with pytest.raises(market.WriteError, match="class NONE"):
        market.write_rows("quotes", "venue_a", [{"symbol": "BTCUSDT", "ts": T0, "bid": 1.0}])
    assert not files(classes["root"], "market") and not files(classes["root"], "cache")


def test_a_venue_series_lands_in_the_cache_by_default_and_reads_back(classes):
    rep = market.write_funding("venue_a", [{"ts": T0 + i * 8 * H, "rate": 1e-5} for i in range(3)],
                               symbol="BTCUSDT")
    assert rep["storage"] == {"cache": 3}
    assert not files(classes["root"], "market", "funding")
    got = files(classes["root"], "cache", "funding")
    assert len(got) == 1 and got[0].parent.parent.name == "venue=venue_a"
    assert [r["ts"] for r in market.funding("venue_a", "BTCUSDT", as_="rows")] == [T0, T0 + 8 * H, T0 + 16 * H]
    import fund_db
    fund_db.lake.reset()
    assert fund_db.sql("select count(*) n from funding", as_="rows")[0]["n"] == 3


def test_a_declared_series_lands_in_the_lake(classes):
    market.declare_archive("venue_g", [{"dataset": "candles"}], why="the ~5,000-bar cap",
                           source="tests/venue.json")
    rep = market.write_candles("venue_g", "BTC", "1h", [{"t": T0, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 9}])
    assert rep["storage"] == {"archive": 1}
    assert len(files(classes["root"], "market", "candles")) == 1
    assert not files(classes["root"], "cache")


def test_a_permanent_write_for_an_undeclared_series_is_refused(classes):
    with pytest.raises(market.WriteError, match="not declared archive"):
        market.write_funding("venue_l", [{"ts": T0, "rate": 1e-5}], symbol="BTC-USDT-SWAP", storage="archive")
    assert not files(classes["root"], "market") and not files(classes["root"], "cache")


def test_archive_data_never_enters_the_cache(classes):
    market.declare_archive("venue_g", [{"dataset": "candles", "symbol": "*", "interval": "1h"}],
                           why="cap", source="tests/venue.json")
    with pytest.raises(market.WriteError, match="never enters the cache"):
        market.write_candles("venue_g", "BTC", "1h", [{"t": T0, "o": 1, "h": 1, "l": 1, "c": 1}],
                             storage="cache")
    with pytest.raises(market.WriteError, match="never enters the cache"):
        market.write("conflicts", [{"logged": T0, "dataset": "funding", "kind": "x"}], "venue_a", storage="cache")
    # the declaration is interval-exact: 4h is not declared, so it is cache
    rep = market.write_candles("venue_g", "BTC", "4h", [{"t": T0, "o": 1, "h": 1, "l": 1, "c": 1}])
    assert rep["storage"] == {"cache": 1}


def test_one_write_may_hold_both_classes_of_one_venue_month(classes):
    market.declare_archive("venue_n", [{"dataset": "option_chains", "symbol": "CME:SR3*"}],
                           why="one SR3 chain a day", source="tests/venue.json")
    rows = [{"symbol": s, "underlying": u, "expiry": "2026-12-11", "strike": 96.0, "right": "C",
             "raw": {"s": s}} for s, u in (("CME:SR3Z2026C9600", "CME:SR3Z2026"), ("CME:ESZ2026C6000", "CME:ESZ2026"))]
    rep = market.write_option_chain("venue_n", rows, ts=T0, data_type="delayed")
    assert rep["storage"] == {"archive": 1, "cache": 1}
    lake_rows = [r["symbol"] for f in files(classes["root"], "market") for r in __import__("pyarrow.parquet").parquet.read_table(f).to_pylist()]
    cache_rows = [r["symbol"] for f in files(classes["root"], "cache") for r in __import__("pyarrow.parquet").parquet.read_table(f).to_pylist()]
    assert lake_rows == ["CME:SR3Z2026C9600"] and cache_rows == ["CME:ESZ2026C6000"]
    assert len(market.option_chains("venue_n", as_="rows")) == 2


def _lake_then_undeclare(venue="venue_a", symbol="BTCUSDT", n=3):
    """A legacy lake month: written while declared, then the declaration withdrawn (as B-0322 did)."""
    market.declare_archive(venue, [{"dataset": "funding"}], why="legacy", source="tests")
    market.write_funding(venue, [{"ts": T0 + i * 8 * H, "rate": 1e-5} for i in range(n)], symbol=symbol)
    market.declare_archive(venue, [], why="withdrawn", source="tests")


def test_a_rewrite_never_moves_a_legacy_lake_row_into_the_cache(classes):
    _lake_then_undeclare()
    lake_before = files(classes["root"], "market", "funding")
    assert len(lake_before) == 1
    # fill a premium on a stored row (a rewrite) and add a new row (cache) in the SAME month
    rep = market.write_funding("venue_a", [{"ts": T0, "rate": 1e-5, "premium": -3e-4},
                                           {"ts": T0 + 24 * H, "rate": 2e-5}], symbol="BTCUSDT")
    assert rep["upgraded"] == 1 and rep["added"] == 1
    import pyarrow.parquet as pq
    lake_rows = [r for f in files(classes["root"], "market", "funding") for r in pq.read_table(f).to_pylist()]
    cache_rows = [r for f in files(classes["root"], "cache", "funding") for r in pq.read_table(f).to_pylist()]
    assert sorted(r["ts"] for r in lake_rows) == [T0, T0 + 8 * H, T0 + 16 * H]
    assert [r["premium"] for r in lake_rows if r["ts"] == T0] == [-3e-4]
    assert [r["ts"] for r in cache_rows] == [T0 + 24 * H]
    got = market.funding("venue_a", "BTCUSDT", as_="rows")
    assert [r["ts"] for r in got] == [T0, T0 + 8 * H, T0 + 16 * H, T0 + 24 * H]      # no duplicate


def test_a_republished_legacy_row_is_still_a_conflict_from_the_cache_side(classes):
    _lake_then_undeclare()
    rep = market.write_funding("venue_a", [{"ts": T0, "rate": 9e-5}], symbol="BTCUSDT")
    assert rep["conflict"] == 1 and rep["added"] == 0
    assert not files(classes["root"], "cache", "funding")


def test_a_newly_declared_series_moves_out_of_the_cache_on_its_next_write(classes):
    market.write_candles("venue_g", "ETH", "1h", [{"t": T0, "o": 1, "h": 1, "l": 1, "c": 1}])
    assert files(classes["root"], "cache", "candles")
    market.declare_archive("venue_g", [{"dataset": "candles"}], why="cap", source="tests")
    market.write_candles("venue_g", "ETH", "1h", [{"t": T0 + H, "o": 1, "h": 1, "l": 1, "c": 1}])
    assert not files(classes["root"], "cache", "candles")
    assert [r["t"] for r in market.candles("venue_g", "ETH", "1h", as_="rows")] == [T0, T0 + H]


def test_declarations_replace_the_venue_list_and_need_a_source(classes):
    with pytest.raises(market.StorageError, match="why and its source"):
        market.declare_archive("venue_g", [{"dataset": "candles"}], why="", source="x")
    with pytest.raises(KeyError):
        market.declare_archive("venue_g", [{"dataset": "nope"}], why="w", source="s")
    with pytest.raises(market.StorageError, match="has no interval"):
        market.declare_archive("venue_g", [{"dataset": "funding", "interval": "1h"}], why="w", source="s")
    market.declare_archive("venue_g", [{"dataset": "candles"}, {"dataset": "eod"}], why="w", source="s")
    market.declare_archive("venue_l", [{"dataset": "funding"}], why="w", source="s")
    market.declare_archive("venue_g", [{"dataset": "candles"}], why="w", source="s")
    got = [(d["venue"], d["dataset"]) for d in market.archive_declarations()]
    assert got == [("venue_g", "candles"), ("venue_l", "funding")]


def test_resolution_falls_back_on_the_mirror_and_fails_closed(classes, monkeypatch):
    class Down(storage.MemoryStorage):
        def decl_list(self):
            raise OSError("postgres unreachable")
    storage.use(Down())
    with pytest.raises(OSError):                     # nothing known: never guessed into the cache
        market.write_candles("venue_g", "BTC", "1h", [{"t": T0, "o": 1, "h": 1, "l": 1, "c": 1}])
    p = storage._mirror_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('[{"venue": "venue_g", "dataset": "candles", "symbol": "*", "interval": "*", '
                 '"why": "w", "source": "s", "declared_ms": 0}]', encoding="utf-8")
    rep = market.write_candles("venue_g", "BTC", "1h", [{"t": T0, "o": 1, "h": 1, "l": 1, "c": 1}])
    assert rep["storage"] == {"archive": 1}


def test_cls_is_the_same_argument_under_platforms_name(classes):
    with pytest.raises(market.WriteError, match="not declared archive"):
        market.write_funding("venue_l", [{"ts": T0, "rate": 1e-5}], symbol="BTC-USDT-SWAP", cls="archive")
    with pytest.raises(market.WriteError, match="disagree"):
        market.write_funding("venue_l", [{"ts": T0, "rate": 1e-5}], symbol="X", cls="cache", storage="archive")
    assert market.write_funding("venue_l", [{"ts": T0, "rate": 1e-5}], symbol="X", cls="cache")["storage"] == {"cache": 1}
