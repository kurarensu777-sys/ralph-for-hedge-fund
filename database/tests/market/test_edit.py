"""fund_db.market.edit: row-level removal under the writer's own locks and journal, the trash it
moves rows to. A throwaway lake (the `lake` fixture), never the real one."""
from __future__ import annotations

import pyarrow.compute as pc
import pytest

from fund_db import config, market
from fund_db.market import edit

T0 = 1_788_220_800_000          # 2026-09-01T00:00:00Z
H = 3_600_000


def _seed():
    market.write_candles("venue_g", "BTC", "1h",
                         [{"t": T0 + i * H, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10} for i in range(6)],
                         closed_asof_ms=T0 + 100 * H)
    market.write_candles("venue_g", "ETH", "1h",
                         [{"t": T0 + i * H, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10} for i in range(3)],
                         closed_asof_ms=T0 + 100 * H)
    # a second month, so a delete can touch one partition and not another
    market.write_candles("venue_g", "BTC", "1h", [{"t": T0 - H, "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10}],
                         closed_asof_ms=T0 + 100 * H)


def test_groups_months_bytes_fingerprint(lake):
    _seed()
    market.write_funding("venue_a", [{"ts": T0, "rate": 1e-5}], symbol="BTCUSDT")
    assert edit.groups("candles") == [("venue_g", "1h")]
    assert edit.groups("funding") == [("venue_a", None)]
    assert edit.months("candles", "venue_g", "1h") == ["2026-08", "2026-09"]
    assert edit.group_bytes("candles", "venue_g", "1h") > 0
    fp = edit.fingerprint("candles", "venue_g", "1h", {"2026-09"})
    assert len(fp) >= 1 and all(len(x) == 3 for x in fp)
    assert edit.fingerprint("candles", "venue_g", "1h", {"2026-07"}) == []


def test_remove_rows_through_the_trash_and_restore_them_verbatim(lake):
    _seed()
    before = market.candles("venue_g", ["BTC", "ETH"], "1h", as_="rows", complete_only=False)
    with edit.locked("candles", "venue_g", "1h", {"2026-09"}):
        p = edit.read_partition("candles", "venue_g", "1h", "2026-09")
        assert p.table.num_rows == 9
        mask = pc.and_(pc.equal(p.table["symbol"], "BTC"), pc.greater_equal(p.table["t"], T0 + 3 * H))
        hit, keep = p.table.filter(mask), p.table.filter(pc.invert(mask))
        tid = edit.trash_create("plan1", {"status": "applying"})
        put = edit.trash_put(tid, "candles", "venue_g", "1h", "BTC", hit)
        assert put == {"file": "candles/venue=venue_g/interval=1h/BTC.parquet", "rows": 3, "bytes": put["bytes"]}
        assert edit.replace_partition(p, keep) == "rewritten"
    edit.refresh_series("candles", "venue_g", "1h", ["BTC"])
    btc = market.candles("venue_g", "BTC", "1h", as_="rows", complete_only=False)
    assert [r["t"] for r in btc] == [T0 - H, T0, T0 + H, T0 + 2 * H]
    assert len(market.candles("venue_g", "ETH", "1h", as_="rows")) == 3
    # the trash entry
    assert [t for t, _ in edit.trash_list()] == [tid]
    assert edit.trash_manifest(tid)["trash_id"] == tid
    ent = edit.trash_entries(tid)
    assert [(e["dataset"], e["venue"], e["interval"], e["symbol"]) for e in ent] == [("candles", "venue_g", "1h", "BTC")]
    rows = edit.trash_read(tid, ent[0]["file"]).to_pylist()
    assert [r["t"] for r in rows] == [T0 + 3 * H, T0 + 4 * H, T0 + 5 * H]
    # restore = a verbatim write through the merge rules: every column comes back equal
    market.write("candles", rows, "venue_g", interval="1h", verbatim=True)
    after = market.candles("venue_g", ["BTC", "ETH"], "1h", as_="rows", complete_only=False)
    assert sorted(after, key=lambda r: (r["symbol"], r["t"])) == sorted(before, key=lambda r: (r["symbol"], r["t"]))


def test_a_partition_that_moved_since_it_was_read_is_refused(lake):
    _seed()
    with edit.locked("candles", "venue_g", "1h", {"2026-09"}):
        p = edit.read_partition("candles", "venue_g", "1h", "2026-09")
    market.write_candles("venue_g", "SOL", "1h", [{"t": T0, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}],
                         closed_asof_ms=T0 + 100 * H)
    with edit.locked("candles", "venue_g", "1h", {"2026-09"}):
        with pytest.raises(edit.EditError, match="changed since it was read"):
            edit.replace_partition(p, p.table.slice(0, 1))
    assert len(market.candles("venue_g", None, "1h", as_="rows", complete_only=False)) == 11


def test_emptying_and_unchanged(lake):
    market.write_funding("venue_l", [{"ts": T0, "rate": 1e-5}], symbol="BTC-USDT-SWAP")
    with edit.locked("funding", "venue_l", None, {"2026-09"}):
        p = edit.read_partition("funding", "venue_l", None, "2026-09")
        assert edit.replace_partition(p, p.table) == "unchanged"
        assert edit.replace_partition(p, p.table.slice(0, 0)) == "emptied"
    assert market.funding("venue_l", as_="rows") == []


def test_trash_ids_are_checked_and_retire_moves(lake):
    tid = edit.trash_create("p2", {"x": 1})
    tid2 = edit.trash_create("p2", {"x": 2})
    assert tid != tid2 and tid2.endswith("__p2")
    for bad in ("..", "a/b", "a\\b", "", "../../etc"):
        with pytest.raises(edit.EditError):
            edit.trash_dir(bad)
    with pytest.raises(FileNotFoundError):
        edit.trash_dir("20260101T000000Z__none")
    with pytest.raises(edit.EditError):
        edit.trash_read(tid, "../../pg.json")
    with pytest.raises(edit.EditError):
        edit.trash_create("bad stem/x", {})
    dst = edit.trash_retire(tid)
    assert dst == str(config.retired_dir() / "trash" / tid)
    assert [t for t, _ in edit.trash_list()] == [tid2]
    with pytest.raises(FileNotFoundError):
        edit.trash_retire(tid)


# --- the correction path (B-0319) ---------------------------------------------------------- #

GF = "CME:SR3H2021"
MON, MON_T = "2021-04-05", 1_617_580_800_000      # the Monday after Good Friday 2021


def _tv_seed(*syms):
    market.write_contracts("venue_n", [
        {"symbol": s, "sec_type": "FUT", "underlying": "SR3", "exchange": "CME",
         "currency": "USD", "last_trade_date": "20210315", "contract_month": "2021-03"}
        for s in syms], source="venue_n")


def _bar(date, o, v=5.0):
    return {"date": date, "o": o, "h": o, "l": o, "c": o, "v": v, "closed": True}


def _wr(sym, bars):
    return market.write_contract_bars("venue_n", sym, "1d", bars, what="SETTLEMENT",
                                      data_type="delayed")


def _mis_dated(db):
    """The B-0315 state: the Thursday-session bar stored under Monday, the real Monday bar
    refused as closed_bar_changed."""
    _tv_seed(GF, "CME:SR3M2021")
    _wr(GF, [_bar("2021-04-01", 99.0), _bar(MON, 99.5, v=220.0)])           # 2nd = Thursday session
    rep = _wr(GF, [_bar(MON, 99.6, v=591.0)])                               # the real Monday
    assert rep["conflict"] == 1
    _wr("CME:SR3M2021", [_bar(MON, 98.0)])                                  # a neighbour, untouched
    return [{"symbol": GF, "what": "SETTLEMENT", "t": MON_T}]


def test_correct_rows_dry_run_moves_nothing(db, lake):
    keys = _mis_dated(db)
    rep = edit.correct_rows("contract_bars", "venue_n", "1d", keys, reason="Good Friday")
    assert (rep["applied"], rep["found"], rep["trash_id"]) == (False, 1, None)
    assert rep["rows_by_symbol"] == {GF: 1} and edit.trash_list() == []
    assert [r["o"] for r in market.contract_bars("venue_n", GF, "1d", as_="rows")][-1] == 99.5


def test_correct_then_rewalk_stores_the_right_row_and_restore_is_a_conflict(db, lake):
    keys = _mis_dated(db)
    before = market.contract_bars("venue_n", GF, "1d", as_="rows")
    rep = edit.correct_rows("contract_bars", "venue_n", "1d", keys, reason="Good Friday",
                            stem="b0319", apply=True)
    tid = rep["trash_id"]
    assert rep["applied"] and rep["found"] == 1 and tid.endswith("__b0319")
    got = market.contract_bars("venue_n", GF, "1d", as_="rows")
    assert [r["date"] for r in got] == ["2021-04-01"]                      # catalog + read agree
    assert [r["date"] for r in market.contract_bars("venue_n", "CME:SR3M2021", "1d", as_="rows")] == [MON]
    man = edit.trash_manifest(tid)
    assert (man["status"], man["reason"], man["rows"]) == ("applied", "Good Friday", 1)
    # the removed row is in the trash verbatim, every column
    (ent,) = edit.trash_entries(tid)
    stored = [{k: v for k, v in r.items() if k not in ("venue", "interval")}
              for r in before if r["date"] == MON]
    assert edit.trash_read(tid, ent["file"]).to_pylist() == stored
    # the re-walk now adds the rows under their own dates, no conflict
    rep2 = _wr(GF, [_bar("2021-04-02", 99.2), _bar(MON, 99.6, v=591.0)])
    assert rep2["conflict"] == 0 and rep2["added"] == 2
    # restore after a re-walk filled the key: a conflict, the re-walked row kept
    back = edit.restore_trash(tid)
    assert back[GF]["conflict"] == 1
    assert [r["o"] for r in market.contract_bars("venue_n", GF, "1d", as_="rows")
            if r["date"] == MON] == [99.6]
    assert edit.trash_manifest(tid)["status"] == "restored"
    with pytest.raises(edit.EditError, match="not an applied correction"):
        edit.restore_trash(tid)


def test_restore_puts_the_row_back_verbatim(db, lake):
    keys = _mis_dated(db)
    before = market.contract_bars("venue_n", GF, "1d", as_="rows")
    tid = edit.correct_rows("contract_bars", "venue_n", "1d", keys, reason="r", apply=True)["trash_id"]
    assert len(market.contract_bars("venue_n", GF, "1d", as_="rows")) == 1
    edit.restore_trash(tid)
    assert market.contract_bars("venue_n", GF, "1d", as_="rows") == before


def test_correct_rows_refuses_what_it_cannot_do_whole(db, lake):
    keys = _mis_dated(db)
    gone = {"symbol": GF, "what": "SETTLEMENT", "t": MON_T + 86_400_000}
    with pytest.raises(edit.EditError, match="1 of 2 keys are not stored"):
        edit.correct_rows("contract_bars", "venue_n", "1d", keys + [gone], reason="r", apply=True)
    assert edit.trash_list() == []                                          # nothing moved, no entry
    assert len(market.contract_bars("venue_n", GF, "1d", as_="rows")) == 2
    with pytest.raises(edit.EditError, match="names its reason"):
        edit.correct_rows("contract_bars", "venue_n", "1d", keys, reason=" ", apply=True)
    with pytest.raises(edit.EditError, match="lacks"):
        edit.correct_rows("contract_bars", "venue_n", "1d", [{"symbol": GF, "t": MON_T}], reason="r")
    # a second apply of the same keys is refused, not silently empty
    edit.correct_rows("contract_bars", "venue_n", "1d", keys, reason="r", apply=True)
    with pytest.raises(edit.EditError, match="not stored"):
        edit.correct_rows("contract_bars", "venue_n", "1d", keys, reason="r", apply=True)
