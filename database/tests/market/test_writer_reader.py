"""Writer + reader against a throwaway lake: layout, merge in place, conflicts, journal recovery,
compaction, typed readers, the DuckDB views."""
import json

import duckdb
import pyarrow.parquet as pq
import pytest

from fund_db import market
from fund_db.market import layout, writer
from fund_db.market.registry import get

T0 = 1790000000000          # 2026-09-21T14:13:20Z
H = 3_600_000


def parts(root, *sub):
    return sorted((root / "market").joinpath(*sub).rglob("part-*.parquet"))


def test_funding_layout_and_roundtrip(lake):
    rows = [{"ts": T0 + i * 8 * H, "rate": 1e-5 * i, "interval_h": 8.0} for i in range(3)]
    rep = market.write_funding("venue_a", rows, symbol="BTCUSDT")
    assert rep["added"] == 3 and rep["parts_written"] == 1
    f = parts(lake["root"], "funding")
    assert len(f) == 1 and f[0].parent.name == "month=2026-09" and f[0].parent.parent.name == "venue=venue_a"
    got = market.funding("venue_a", "BTCUSDT", as_="rows")
    assert [r["rate"] for r in got] == [0.0, 1e-5, 2e-5]
    assert all(r["interval_src"] == "venue" and r["venue"] == "venue_a" for r in got)
    # stored file carries no partition columns
    assert "venue" not in pq.read_schema(f[0]).names


def test_funding_refuses_an_inferred_cadence(lake):
    with pytest.raises(market.WriteError, match="inferred cadence"):
        market.write_funding("venue_l", [{"ts": T0, "rate": 1e-5, "interval_h": 8.0, "interval_src": "map"}],
                             symbol="BTC-USDT-SWAP")


def test_settled_conflict_kept_out_and_logged(lake, capsys):
    market.write_funding("venue_c", [{"ts": T0, "rate": 1e-4}], symbol="ETHUSDT")
    rep = market.write_funding("venue_c", [{"ts": T0, "rate": 2e-4}, {"ts": T0 + 8 * H, "rate": 3e-4}],
                               symbol="ETHUSDT")
    assert rep["conflict"] == 1 and rep["added"] == 1
    assert [r["rate"] for r in market.funding("venue_c", as_="rows")] == [1e-4, 3e-4]
    c = market.conflicts("funding", as_="rows")
    assert len(c) == 1 and c[0]["kind"] == "settled_row_changed"
    assert json.loads(c[0]["stored"])["rate"] == 1e-4 and json.loads(c[0]["incoming"])["rate"] == 2e-4
    assert "settled_row_changed" in capsys.readouterr().err


def test_fill_rewrites_partition_once_and_keeps_every_row(lake):
    market.write_funding("venue_g", [{"ts": T0 + i * H, "rate": 1e-5} for i in range(5)], symbol="BTC")
    rep = market.write_funding("venue_g", [{"ts": T0, "rate": 1e-5, "premium": -3e-4}], symbol="BTC")
    assert rep["upgraded"] == 1 and rep["rewrites"] == 1
    rows = market.funding("venue_g", "BTC", as_="rows")
    assert len(rows) == 5 and rows[0]["premium"] == -3e-4 and rows[1]["premium"] is None
    assert len(parts(lake["root"], "funding")) == 1
    assert not list((lake["root"] / "market").rglob(writer.JOURNAL))


def test_candles_forming_bar_then_closed(lake):
    t = T0 - T0 % H
    market.write_candles("venue_g", "xyz:ABCD", "1h",
                         [{"t": t, "o": 1, "h": 2, "l": 1, "c": 1.5, "v": 1, "n": 1}], closed_asof_ms=t + 10)
    market.write_candles("venue_g", "xyz:ABCD", "1h",
                         [{"t": t, "o": 1, "h": 3, "l": 1, "c": 2.5, "v": 2, "n": 2}], closed_asof_ms=t + H)
    rows = market.candles("venue_g", "xyz:ABCD", "1h", as_="rows")
    assert len(rows) == 1 and rows[0]["c"] == 2.5 and rows[0]["closed"] is True
    assert rows[0]["interval"] == "1h" and rows[0]["symbol"] == "xyz:ABCD"
    rep = market.write_candles("venue_g", "xyz:ABCD", "1h",
                               [{"t": t, "o": 1, "h": 3, "l": 1, "c": 9.9, "v": 2, "n": 2}], closed_asof_ms=t + H)
    assert rep["conflict"] == 1
    assert market.candles("venue_g", "xyz:ABCD", "1h", as_="rows")[0]["c"] == 2.5


def test_candles_complete_only_hides_partial_seed(lake):
    market.write_candles("venue_g", "BTC", "1h", [{"t": T0 - T0 % H - 5 * H, "c": 5.0}],
                         source="seed:old", closed_asof_ms=T0)
    assert market.candles("venue_g", "BTC", "1h", as_="rows") == []
    assert len(market.candles("venue_g", "BTC", "1h", complete_only=False, as_="rows")) == 1


def test_many_months_and_window_pruning(lake):
    rows = [{"ts": T0 + d * 86_400_000, "rate": 1e-5} for d in range(0, 70)]
    market.write_funding("venue_l", rows, symbol="BTC-USDT-SWAP")
    months = sorted(p.parent.name for p in parts(lake["root"], "funding"))
    assert months == ["month=2026-09", "month=2026-10", "month=2026-11"]
    got = market.funding("venue_l", start=T0 + 10 * 86_400_000, end="2026-10-05T00:00:00Z", as_="rows")
    assert got[0]["ts"] == T0 + 10 * 86_400_000 and got[-1]["ts"] < 1791158400001
    # 2026-10-21 .. 2026-10-22 touches October only; 2026-10-31 .. 2026-11-01 touches two months
    fl = market.reader.files(get("funding"), "venue_l", None, T0 + 30 * 86_400_000, T0 + 31 * 86_400_000)
    assert len(fl) == 1 and fl[0][1]["month"] == "2026-10"
    fl = market.reader.files(get("funding"), "venue_l", None, T0 + 40 * 86_400_000, T0 + 41 * 86_400_000)
    assert sorted(v["month"] for _, v in fl) == ["2026-10", "2026-11"]


def test_non_ascii_and_colon_symbols_and_quoted_folders(lake):
    market.write_funding("venue_a", [{"ts": T0, "rate": 1e-5}], symbol="哈基米USDT")
    market.write_candles("venue_g", "@142", "1h", [{"t": T0 - T0 % H - H, "o": 1, "h": 1, "l": 1, "c": 1}])
    assert market.funding(symbols="哈基米USDT", as_="rows")[0]["venue"] == "venue_a"
    assert len(market.candles(symbol="@142", as_="rows")) == 1
    market.write_rows("snapshots", "venues/venue_a",
                      [{"ts": "2026-09-21T16:29:08Z", "desk": "d", "subject": "s", "field": "f",
                        "value": 1, "unit": "count", "provenance": "[API]", "source": "x"}])
    assert (lake["root"] / "market" / "snapshots" / "log=venues%2Fvenue_a").is_dir()
    r = market.snapshots("venues/venue_a", as_="rows")[0]
    assert r["value"] == 1 and isinstance(r["value"], int) and r["t"] == 1790008148000


def test_observe_dedupes_exact_repeats_only(lake):
    q = {"symbol": "BTCUSDT", "ts": T0, "bid": 1.0, "ask": 1.1, "ts_src": "venue"}
    market.write_rows("quotes", "venue_a", [q, q, {**q, "bid": 1.05}])
    rep = market.write_rows("quotes", "venue_a", [q])
    assert rep["added"] == 0 and rep["unchanged"] == 1
    assert len(market.quotes("venue_a", as_="rows")) == 2


def test_eod_revision_replaces_and_logs(lake):
    base = {"symbol": "000660.KO", "date": "2026-07-01", "open": 1.0, "high": 2.0, "low": 0.5,
            "close": 1.5, "adj_close": 1.4, "volume": 10.0}
    market.write_eod([base])
    rep = market.write_eod([{**base, "close": 1.6}])
    assert rep["revised"] == 1
    got = market.eod("000660.KO", as_="rows")
    assert got[0]["close"] == 1.6 and got[0]["time"] == 1782864000000
    assert market.conflicts("eod", as_="rows")[0]["kind"] == "revised"


def test_compaction_after_many_appends_keeps_every_row(lake):
    for i in range(12):
        market.write_funding("gate", [{"ts": T0 + i * H, "rate": 1e-6 * i}], symbol="BTC_USDT")
    assert len(parts(lake["root"], "funding")) <= 8
    assert len(market.funding("gate", as_="rows")) == 12


def test_recover_completes_or_rolls_back_an_interrupted_rewrite(lake, tmp_path):
    ds = get("funding")
    market.write_funding("venue_k", [{"ts": T0, "rate": 1e-5}], symbol="BTC_USDT")
    market.write_funding("venue_k", [{"ts": T0 + H, "rate": 2e-5}], symbol="BTC_USDT")
    pdir = layout.partition_dir(layout.hot_root(), ds, "venue_k", "2026-09")
    old = layout.part_files(pdir)
    assert len(old) == 2
    # a rewrite that crashed AFTER the new part landed: readers must not double count
    tbl = pq.read_table(old[0]).cast(ds.schema)
    import pyarrow as pa
    full = pa.concat_tables([tbl, pq.read_table(old[1]).cast(ds.schema)])
    new = pdir / "part-9-rX.parquet"
    pq.write_table(full, new)
    (pdir / writer.JOURNAL).write_text(json.dumps(
        {"new": str(new), "tmp": str(pdir / ".x.tmp"), "old": [str(p) for p in old]}))
    assert len(market.funding("venue_k", as_="rows")) == 2          # reader honours the journal
    assert "completed" in writer.recover(pdir)
    assert layout.part_files(pdir) == [new] and len(market.funding("venue_k", as_="rows")) == 2
    # a rewrite that crashed BEFORE the rename: the old parts stand, the temp goes
    tmp = pdir / ".y.tmp"
    tmp.write_bytes(b"junk")
    (pdir / writer.JOURNAL).write_text(json.dumps(
        {"new": str(pdir / "part-never.parquet"), "tmp": str(tmp), "old": [str(new)]}))
    assert len(market.funding("venue_k", as_="rows")) == 2
    assert "rolled back" in writer.recover(pdir)
    assert not tmp.exists() and layout.part_files(pdir) == [new]


def test_views_answer_sql_with_partition_columns(lake):
    market.write_funding("venue_a", [{"ts": T0, "rate": 1e-5}], symbol="A")
    market.write_funding("venue_l", [{"ts": T0, "rate": 2e-5}, {"ts": T0 + H, "rate": 3e-5}], symbol="B")
    con = duckdb.connect()
    market.register_views(con)
    assert con.execute("select venue, count(*) from funding group by 1 order by 1").fetchall() == \
        [("venue_a", 1), ("venue_l", 2)]


def test_reader_rejects_unknown_columns_and_empty_is_typed(lake):
    t = market.funding("nowhere")
    assert t.num_rows == 0 and "rate" in t.column_names
    with pytest.raises(ValueError):
        market.funding(cols=["nope"])


def test_verbatim_import_keeps_src_seen_closed(lake):
    market.write("candles", [{"symbol": "BTC", "t": 0, "o": 1.0, "h": 1.0, "l": 1.0, "c": 1.0, "v": None,
                              "n": None, "closed": False, "src": "venue", "seen": 42}],
                 "venue_g", interval="1h", verbatim=True)
    r = market.candles("venue_g", "BTC", "1h", as_="rows")[0]
    assert r["closed"] is False and r["seen"] == 42 and r["n"] is None


def test_pandas_output(lake):
    market.write_funding("venue_a", [{"ts": T0, "rate": 1e-5}], symbol="A")
    df = market.funding(as_="pandas")
    assert list(df["rate"]) == [1e-5]


# --------------------------------------------------------------------------------------------- #
# a rewrite that finishes between the listing and the read
# --------------------------------------------------------------------------------------------- #

def _stale_listing(monkeypatch, times=1):
    """reader.files answers from the listing taken BEFORE a rewrite `times` times, then truly."""
    from fund_db.market import reader
    real, calls = reader.files, {"n": 0, "stale": None}

    def files(*a, **kw):
        calls["n"] += 1
        if calls["stale"] is not None and (times is None or calls["n"] <= times):
            return calls["stale"]
        return real(*a, **kw)
    monkeypatch.setattr(reader, "files", files)
    return calls, real


def test_a_part_rewritten_away_after_the_listing_is_read_from_its_new_part(lake, monkeypatch):
    market.write_funding("venue_l", [{"ts": T0 + i * 8 * H, "rate": 1e-5 * i} for i in range(3)], symbol="BTC")
    calls, real = _stale_listing(monkeypatch)
    calls["stale"] = real(get("funding"), "venue_l", None, None, None, ("hot", "cold"))
    (old,) = parts(lake["root"], "funding")
    old.rename(old.with_name("part-9999999999999-rmoved000.parquet"))   # a rewrite landed
    got = market.funding("venue_l", as_="rows")
    assert [r["rate"] for r in got] == [0.0, 1e-5, 2e-5]
    assert calls["n"] == 2, "exactly one fresh listing"


def test_a_listing_that_never_settles_raises_instead_of_answering_short(lake, monkeypatch):
    market.write_funding("venue_l", [{"ts": T0, "rate": 1e-5}], symbol="BTC")
    calls, real = _stale_listing(monkeypatch, times=None)
    calls["stale"] = real(get("funding"), "venue_l", None, None, None, ("hot", "cold"))
    (old,) = parts(lake["root"], "funding")
    old.rename(old.with_name("part-9999999999999-rmoved000.parquet"))
    with pytest.raises(duckdb.IOException):
        market.funding("venue_l", as_="rows")
    from fund_db.market import reader
    assert calls["n"] == reader.READ_RETRIES + 1, "bounded"


def test_an_unreadable_part_that_is_still_there_is_not_retried(lake, monkeypatch):
    market.write_funding("venue_l", [{"ts": T0, "rate": 1e-5}], symbol="BTC")
    calls, _ = _stale_listing(monkeypatch, times=0)
    (p,) = parts(lake["root"], "funding")
    p.write_bytes(b"not parquet")
    with pytest.raises(duckdb.Error):
        market.funding("venue_l", as_="rows")
    assert calls["n"] == 1, "a broken file is a failure to say, not a race to wait out"


# --------------------------------------------------------------------------------------------- #
# a file a reader holds open while the writer removes it (Windows refuses the delete)
# --------------------------------------------------------------------------------------------- #

def _held(monkeypatch, held: set):
    """writer._remove refuses every path in `held`, as Windows does for a file a reader has open."""
    import os as _os
    real = writer._remove

    def remove(p):
        if _os.path.normcase(str(p)) in {_os.path.normcase(str(h)) for h in held}:
            return False
        return real(p)
    monkeypatch.setattr(writer, "_remove", remove)


def test_an_old_part_held_open_stays_hidden_until_a_later_writer_removes_it(lake, monkeypatch):
    ds = get("funding")
    market.write_funding("venue_k", [{"ts": T0, "rate": 1e-5}], symbol="BTC_USDT")
    market.write_funding("venue_k", [{"ts": T0 + H, "rate": 2e-5}], symbol="BTC_USDT")
    pdir = layout.partition_dir(layout.hot_root(), ds, "venue_k", "2026-09")
    old = layout.part_files(pdir)
    held = {old[0]}
    _held(monkeypatch, held)
    writer.compact_partition(ds, "venue_k", None, "2026-09")
    assert old[0].exists() and (pdir / writer.JOURNAL).exists(), "the journal stays while a part is held"
    assert len(market.funding("venue_k", as_="rows")) == 2, "the held part is hidden, never read twice"
    assert old[0] not in writer._files_for(ds, "venue_k", None, "2026-09")[2], "nor merged against twice"
    # another rewrite while it is still held: the new journal carries the unfinished part on
    market.write_funding("venue_k", [{"ts": T0 + 2 * H, "rate": 3e-5}], symbol="BTC_USDT")
    writer.compact_partition(ds, "venue_k", None, "2026-09")
    info = json.loads((pdir / writer.JOURNAL).read_text(encoding="utf-8"))
    assert str(old[0]) in info["old"]
    assert [r["rate"] for r in market.funding("venue_k", as_="rows")] == [1e-5, 2e-5, 3e-5]
    held.clear()                                   # the reader let go: the next writer finishes it
    market.write_funding("venue_k", [{"ts": T0 + 3 * H, "rate": 4e-5}], symbol="BTC_USDT")
    assert not old[0].exists() and not (pdir / writer.JOURNAL).exists()
    assert [r["rate"] for r in market.funding("venue_k", as_="rows")] == [1e-5, 2e-5, 3e-5, 4e-5]


def test_remove_waits_out_a_brief_hold_and_says_a_long_one(lake, monkeypatch, tmp_path):
    p = tmp_path / "f"
    p.write_text("x")
    tries = {"n": 0}
    real_unlink = type(p).unlink

    def flaky(self, missing_ok=False):
        tries["n"] += 1
        if tries["n"] < 3:
            raise PermissionError(32, "in use")
        return real_unlink(self, missing_ok=missing_ok)
    monkeypatch.setattr(type(p), "unlink", flaky)
    assert writer._remove(p) is True and not p.exists() and tries["n"] == 3
    p.write_text("x")
    monkeypatch.setattr(type(p), "unlink", lambda self, missing_ok=False: (_ for _ in ()).throw(PermissionError(32, "in use")))
    monkeypatch.setattr(writer, "REMOVE_WAIT_S", 0.05)
    assert writer._remove(p) is False
