"""fund_db.live: record -> hot log -> roll into the lake, crash-safe and idempotent."""
import json
import threading

import pytest

from fund_db import live, market

H = 3_600_000
T0 = 1_788_220_800_000          # 2026-09-01T00:00:00Z


def q(i, **kw):
    return {"symbol": "BTCUSDT", "ts": T0 + i, "bid": 100.0 + i, "ask": 101.0 + i, **kw}


def test_record_appends_to_the_receive_hour(lake):
    r = live.record("quotes", "venue_a", [q(1), q(2)], now=T0 + 10)
    assert r["rows"] == 2 and r["path"].endswith("2026-09-01T00.jsonl")
    lines = open(r["path"], encoding="utf-8").read().splitlines()
    assert json.loads(lines[0])["src"] == "venue:ws" and json.loads(lines[0])["seen"] == T0 + 10
    assert "venue=venue_a" in r["path"]


def test_record_validates_before_it_writes(lake):
    with pytest.raises(ValueError, match="missing"):
        live.record("trades", "venue_a", [{"symbol": "X", "ts": T0}], now=T0)      # no px
    assert live.hot_files() == []


def test_hot_table_and_include_live_reads(lake):
    live.record("quotes", "venue_a", [q(1)], now=T0)
    t = live.hot_table("quotes", "venue_a")
    assert t.num_rows == 1 and t.column("venue").to_pylist() == ["venue_a"]
    assert market.quotes("venue_a", as_="rows") == []
    got = market.quotes("venue_a", include_live=True, as_="rows")
    assert len(got) == 1 and got[0]["bid"] == 101.0


def test_roll_moves_only_closed_hours(lake):
    live.record("quotes", "venue_a", [q(1)], now=T0)
    live.record("quotes", "venue_a", [q(H + 1)], now=T0 + H + 5)
    out = live.roll(now=T0 + H + 30_000, grace_s=10)
    assert len(out) == 1 and out[0]["added"] == 1
    assert len(market.quotes("venue_a", as_="rows")) == 1
    assert len(live.hot_files()) == 1                               # the open hour stays hot
    live.roll(now=T0 + 2 * H + 60_001)
    assert len(market.quotes("venue_a", as_="rows")) == 2 and live.hot_files() == []


def test_include_open_rolls_everything(lake):
    live.record("quotes", "venue_a", [q(1)], now=T0)
    live.roll(now=T0 + 10, include_open=True)
    assert live.hot_files() == [] and len(market.quotes(as_="rows")) == 1


def test_a_replayed_roll_lands_nothing_twice(lake):
    """A crash between the lake write and the hot file's removal replays the file: a no-op."""
    p = live.record("quotes", "venue_a", [q(1), q(2)], now=T0)["path"]
    saved = open(p, "rb").read()
    live.roll(now=T0 + 2 * H)
    import os
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").write(saved)                                      # the file came back
    out = live.roll(now=T0 + 2 * H)
    assert out[0]["added"] == 0 and out[0]["unchanged"] == 2
    assert len(market.quotes(as_="rows")) == 2


def test_a_torn_last_line_is_skipped_counted_and_kept(lake, capsys):
    p = live.record("quotes", "venue_a", [q(1)], now=T0)["path"]
    with open(p, "ab") as f:
        f.write(b'{"symbol":"BTCUSDT","ts":')                       # a writer died mid-line
    live.record("quotes", "venue_a", [q(2)], now=T0 + 1)             # starts on a fresh line
    out = live.roll(now=T0 + 2 * H)
    assert out[0]["bad_lines"] == 1 and out[0]["added"] == 2
    assert "torn_kept" in out[0] and "unreadable" in capsys.readouterr().err
    assert len(market.quotes(as_="rows")) == 2


def test_candles_from_the_stream_close_at_roll_time(lake):
    bar = {"symbol": "BTC", "t": T0, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 3.0, "n": 4}
    live.record("candles", "venue_g", [bar], interval="1h", now=T0 + 10)
    live.roll(now=T0 + 2 * H)
    got = market.candles("venue_g", "BTC", "1h", as_="rows")
    assert got[0]["closed"] is True and got[0]["src"] == "venue:ws"


def test_concurrent_recorders_lose_no_line(lake):
    def work(k):
        for i in range(50):
            live.record("trades", "venue_a", [{"symbol": "X", "ts": T0 + k * 1000 + i, "px": 1.0}], now=T0)
    ts = [threading.Thread(target=work, args=(k,)) for k in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert live.hot_table("trades").num_rows == 200
    live.roll(now=T0 + 2 * H)
    assert len(market.trades(as_="rows")) == 200


# --- the three row kinds the dashboards need: prints, liquidations, predicted_funding --------- #

def pr(i=0, **kw):
    return {"symbol": "BTCUSDT", "ts": T0 + i, "px": 60000.5, "sz": 0.012, "side": "buy", **kw}


def lq(i=0, **kw):
    return {"symbol": "BTCUSDT", "ts": T0 + i, "side": "sell", "px": 59000.0, "sz": 1.5, **kw}


def pf(i=0, **kw):
    return {"symbol": "BTC", "ts": T0 + i, "rate": 0.0000125, "interval_h": 1.0,
            "next_ts": T0 + H, **kw}


@pytest.mark.parametrize("dataset,row", [("prints", pr), ("liquidations", lq)])
@pytest.mark.parametrize("drop", ["sz", "ts"])
def test_a_tape_row_missing_its_size_or_event_ts_is_refused(lake, dataset, row, drop):
    r = row(1)
    del r[drop]
    with pytest.raises(ValueError, match="missing"):
        live.record(dataset, "venue_a", [row(0), r], now=T0)
    assert live.hot_files() == []                                    # the whole batch refused


@pytest.mark.parametrize("dataset,row", [("prints", pr), ("liquidations", lq)])
@pytest.mark.parametrize("bad", [{"sz": 0.0}, {"sz": -1.0}, {"sz": float("nan")}, {"sz": "1"},
                                 {"sz": True}, {"px": 0.0}, {"side": "BUY"}, {"side": "long"},
                                 {"ts": 0}, {"ts": T0 + 0.5}])
def test_a_tape_row_breaking_its_contract_is_refused(lake, dataset, row, bad):
    with pytest.raises(ValueError, match="refused"):
        live.record(dataset, "venue_a", [row(**bad)], now=T0)
    assert live.hot_files() == []


@pytest.mark.parametrize("dataset,row,reader", [("prints", pr, "prints"),
                                                ("liquidations", lq, "liquidations")])
def test_tape_rows_record_roll_and_read_back(lake, dataset, row, reader):
    live.record(dataset, "venue_a", [row(1, trade_id="7") if dataset == "prints" else row(1),
                                     row(2, side="sell" if dataset == "prints" else "buy")], now=T0)
    assert live.hot_table(dataset, "venue_a").num_rows == 2
    live.roll(now=T0 + 2 * H)
    got = market.read(dataset, "venue_a", as_="rows")
    assert [g["ts"] for g in got] == [T0 + 1, T0 + 2]
    assert all(g["sz"] > 0 and g["side"] in live.SIDES and g["src"] == "venue:ws" for g in got)
    assert got[0]["venue"] == "venue_a"


@pytest.mark.parametrize("drop", ["rate", "interval_h", "next_ts", "ts"])
def test_a_predicted_row_missing_part_of_the_atomic_unit_is_refused(lake, drop):
    r = pf()
    del r[drop]
    with pytest.raises(ValueError, match="missing"):
        live.record("predicted_funding", "venue_g", [r], now=T0)
    assert live.hot_files() == []


@pytest.mark.parametrize("bad", [{"interval_h": 0.0}, {"interval_h": -8.0},
                                 {"rate": float("inf")}, {"next_ts": "soon"}])
def test_a_predicted_row_breaking_its_contract_is_refused(lake, bad):
    with pytest.raises(ValueError, match="refused"):
        live.record("predicted_funding", "venue_g", [pf(**bad)], now=T0)
    assert live.hot_files() == []


def test_a_funding_row_carrying_a_prediction_is_refused(lake):
    settled = {"symbol": "BTC", "ts": T0, "rate": 0.0000125}
    with pytest.raises(ValueError, match="predicted_funding"):
        live.record("funding", "venue_g", [settled, dict(settled, next_ts=T0 + H)], now=T0)
    assert live.hot_files() == []
    live.record("funding", "venue_g", [settled], now=T0)          # a settled row still records
    assert live.hot_table("funding").num_rows == 1


def test_predicted_funding_records_and_rolls_into_its_own_dataset(lake):
    live.record("predicted_funding", "venue_g", [pf(1), pf(2, rate=-0.00002)], now=T0)
    live.roll(now=T0 + 2 * H)
    got = market.read("predicted_funding", "venue_g", as_="rows")
    assert [(g["rate"], g["interval_h"], g["next_ts"]) for g in got] == [
        (0.0000125, 1.0, T0 + H), (-0.00002, 1.0, T0 + H)]
    assert market.funding(as_="rows") == []
