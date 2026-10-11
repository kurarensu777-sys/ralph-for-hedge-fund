"""contract_bars + market.contracts (B-0303, venue_h as a tradfi data venue): the key is the venue's
contract id, a bar needs its registered contract, the kind and the market data type are named,
a closed bar is immutable, a re-served contract that differs is refused and logged, and coverage
per contract is a query. Every test runs on a throwaway lake AND a throwaway Postgres database."""
import json

import pytest

from fund_db import market

H = 3_600_000
D = 86_400_000
T0 = 1_788_220_800_000          # 2026-09-01T00:00:00Z


def _fut(con_id, ltd, local="SR3Z6", **kw):
    return {"con_id": con_id, "sec_type": "FUT", "underlying": "SR3", "local_symbol": local,
            "trading_class": "SR3", "exchange": "CME", "currency": "USD", "multiplier": "2500",
            "last_trade_date": ltd, "raw": {"conId": con_id}, **kw}


def _fop(con_id, strike, right, under):
    return {"con_id": con_id, "sec_type": "FOP", "underlying": "SR3", "trading_class": "SR3",
            "exchange": "CME", "currency": "USD", "multiplier": 2500, "last_trade_date": "20261211",
            "strike": strike, "right": right, "under_con_id": under}


def _bars(n, t0=T0, step=H, px=96.0):
    return [{"t": t0 + i * step, "o": px, "h": px + 0.01, "l": px - 0.01, "c": px, "v": 10.0,
             "wap": px, "n": 3} for i in range(n)]


@pytest.fixture
def both(db, lake):
    return lake


def test_a_reused_decade_label_never_aliases_two_contracts(both):
    rep = market.write_contracts("venue_h", [_fut(1001, "20161221"), _fut(2002, "2026-12-16")])
    assert rep["added"] == 2
    got = market.contracts("venue_h", underlying="SR3")
    assert [(c["symbol"], c["local_symbol"], c["last_trade_date"]) for c in got] == \
        [("1001", "SR3Z6", "2016-12-21"), ("2002", "SR3Z6", "2026-12-16")]
    market.write_contract_bars("venue_h", 1001, "1h", _bars(2, t0=1_480_000_000_000, px=99.0),
                               what="TRADES", data_type="delayed", closed_asof_ms=T0)
    market.write_contract_bars("venue_h", 2002, "1h", _bars(3, px=96.0),
                               what="TRADES", data_type="delayed", closed_asof_ms=T0 + 10 * H)
    a = market.contract_bars("venue_h", 1001, "1h", as_="rows")
    b = market.contract_bars("venue_h", "2002", "1h", as_="rows")
    assert [r["c"] for r in a] == [99.0, 99.0] and [r["c"] for r in b] == [96.0] * 3
    assert {r["symbol"] for r in a} == {"1001"} and {r["symbol"] for r in b} == {"2002"}


def test_a_bar_for_an_unregistered_contract_is_refused_and_nothing_lands(both):
    with pytest.raises(market.WriteError, match="not in market.contracts"):
        market.write_contract_bars("venue_h", 424242, "1h", _bars(2), what="TRADES", data_type="live")
    assert market.contract_bars("venue_h", as_="rows") == []
    # registered under ANOTHER venue is not registered here
    market.write_contracts("othervenue", [_fut(424242, "20261216")])
    with pytest.raises(market.WriteError, match="not in market.contracts"):
        market.write_contract_bars("venue_h", 424242, "1h", _bars(2), what="TRADES", data_type="live")


def test_the_kind_and_the_market_data_type_are_required(both):
    market.write_contracts("venue_h", [_fut(7, "20261216")])
    with pytest.raises(market.WriteError, match="data_type"):
        market.write_contract_bars("venue_h", 7, "1h", _bars(1), what="TRADES")
    with pytest.raises(market.WriteError, match="data_type"):
        market.write_contract_bars("venue_h", 7, "1h", _bars(1), what="TRADES", data_type="realtime")
    with pytest.raises(market.WriteError, match="`what`"):
        market.write_contract_bars("venue_h", 7, "1h", _bars(1), data_type="live")


def test_a_delayed_bar_is_closed_on_the_delayed_clock_or_refused(both):
    market.write_contracts("venue_h", [_fut(7, "20261216")])
    with pytest.raises(market.WriteError, match="closed_asof_ms"):
        market.write_contract_bars("venue_h", 7, "1h", _bars(2), what="TRADES", data_type="delayed")
    # the clock says the second bar was still forming when it was served
    market.write_contract_bars("venue_h", 7, "1h", _bars(2), what="TRADES", data_type="delayed",
                               closed_asof_ms=T0 + H + H // 2)
    assert [r["closed"] for r in market.contract_bars("venue_h", 7, as_="rows")] == [True, False]
    # a live bar on the live clock needs nothing more
    rep = market.write_contract_bars("venue_h", 7, "1h", _bars(1, t0=T0 + 5 * H), what="TRADES",
                                     data_type="live", closed_asof_ms=T0 + 7 * H)
    assert rep["added"] == 1


def test_a_session_bar_carries_its_date_and_its_stated_close(both):
    market.write_contracts("venue_h", [_fut(7, "20261216")])
    day = [{"date": "2026-09-01", "o": 96.0, "h": 96.1, "l": 95.9, "c": 96.0, "v": 1.0}]
    with pytest.raises(market.WriteError, match="session fact"):
        market.write_contract_bars("venue_h", 7, "1d", day, what="TRADES", data_type="live")
    with pytest.raises(market.WriteError, match="trade `date`"):
        market.write_contract_bars("venue_h", 7, "1d", [{"t": T0, "c": 1.0, "closed": True}],
                                   what="TRADES", data_type="live")
    with pytest.raises(market.WriteError, match="UTC midnight"):
        market.write_contract_bars("venue_h", 7, "1d", [dict(day[0], t=T0 + H, closed=True)],
                                   what="TRADES", data_type="live")
    with pytest.raises(market.WriteError, match="no trade date"):
        market.write_contract_bars("venue_h", 7, "1h", [dict(_bars(1)[0], date="2026-09-01")],
                                   what="TRADES", data_type="live")
    market.write_contract_bars("venue_h", 7, "1d", [dict(day[0], closed=True)], what="TRADES",
                               data_type="delayed")
    r = market.contract_bars("venue_h", 7, "1d", as_="rows")
    assert len(r) == 1 and r[0]["t"] == T0 and r[0]["date"] == "2026-09-01" and r[0]["closed"]


def test_a_closed_bar_is_immutable_and_a_different_one_is_a_conflict(both, capsys):
    market.write_contracts("venue_h", [_fut(7, "20261216")])
    market.write_contract_bars("venue_h", 7, "1h", _bars(2), what="TRADES", data_type="delayed",
                               closed_asof_ms=T0 + H + 1)       # bar 0 closed, bar 1 forming
    moved = _bars(2, px=97.0)
    rep = market.write_contract_bars("venue_h", 7, "1h", moved, what="TRADES", data_type="live",
                                     closed_asof_ms=T0 + 10 * H)
    assert rep["conflict"] == 1 and rep["updated"] == 1
    got = market.contract_bars("venue_h", 7, "1h", as_="rows")
    assert [(r["c"], r["data_type"]) for r in got] == [(96.0, "delayed"), (97.0, "live")]
    c = market.conflicts("contract_bars", as_="rows")
    assert len(c) == 1 and c[0]["kind"] == "closed_bar_changed" and c[0]["symbol"] == "7"
    assert json.loads(c[0]["key"]) == {"symbol": "7", "t": T0, "what": "TRADES"}
    # an equal re-serve under another data type changes nothing: provenance is the first serve
    rep = market.write_contract_bars("venue_h", 7, "1h", _bars(1), what="TRADES", data_type="live",
                                     closed_asof_ms=T0 + 10 * H)
    assert rep["unchanged"] == 1
    assert market.contract_bars("venue_h", 7, "1h", as_="rows")[0]["data_type"] == "delayed"


def test_two_kinds_of_bar_of_one_contract_are_two_rows(both):
    market.write_contracts("venue_h", [_fut(7, "20261216")])
    market.write_contract_bars("venue_h", 7, "1h", _bars(2), what="TRADES", data_type="live")
    market.write_contract_bars("venue_h", 7, "1h", _bars(2, px=96.005), what="MIDPOINT", data_type="live")
    assert len(market.contract_bars("venue_h", 7, "1h", as_="rows")) == 4
    mids = market.contract_bars("venue_h", 7, "1h", what="MIDPOINT", as_="rows")
    assert [r["c"] for r in mids] == [96.005, 96.005]
    assert market.conflicts("contract_bars", as_="rows") == []


def test_a_contract_is_settled_filled_when_null_and_logged_when_it_differs(both, capsys):
    rep = market.write_contracts("venue_h", [_fop(9, 96.25, "PUT", 2002)])
    assert rep["added"] == 1
    k = market.contracts("venue_h", symbols=9)[0]
    assert (k["right"], k["multiplier"], k["last_trade_date"], k["strike"]) == ("P", "2500", "2026-12-11", 96.25)
    # the same contract re-served: an equal multiplier spelled differently is not a change
    rep = market.write_contracts("venue_h", [dict(_fop(9, 96.25, "P", 2002), multiplier="2500.0",
                                               local_symbol="SR3Z6 P9625")])
    assert rep["upgraded"] == 1 and market.contracts("venue_h", symbols="9")[0]["local_symbol"] == "SR3Z6 P9625"
    # a different strike under the same id is refused, logged, and the stored row kept
    rep = market.write_contracts("venue_h", [_fop(9, 96.5, "P", 2002)])
    assert rep["conflict"] == 1 and rep["conflicts"][0]["columns"] == ["strike"]
    assert market.contracts("venue_h", symbols=[9])[0]["strike"] == 96.25
    c = market.conflicts("contracts", as_="rows")
    assert len(c) == 1 and c[0]["kind"] == "contract_changed" and c[0]["venue"] == "venue_h"
    assert json.loads(c[0]["incoming"])["strike"] == 96.5
    assert "contract_changed" in capsys.readouterr().err


def test_a_contract_breach_is_refused(both):
    with pytest.raises(market.WriteError, match="the key is the venue's id"):
        market.write_contracts("venue_h", [dict(_fut(5, "20261216"), symbol="SR3Z6")])
    with pytest.raises(market.WriteError, match="contract_month"):
        market.write_contracts("venue_h", [_fut(5, "202612")])
    with pytest.raises(market.WriteError, match="sec_type"):
        market.write_contracts("venue_h", [{"con_id": 5}])
    with pytest.raises(market.WriteError, match="neither a call nor a put"):
        market.write_contracts("venue_h", [dict(_fop(5, 96.0, "X", 2002))])
    assert market.contracts("venue_h") == []


def test_coverage_per_contract_is_a_query(both):
    market.write_contracts("venue_h", [_fut(2002, "20261216"), _fop(9, 96.25, "P", 2002),
                                    _fop(10, 96.5, "C", 2002)])
    market.write_contract_bars("venue_h", 9, "1d",
                               [{"date": "2026-09-01", "c": 0.05, "closed": True},
                                {"date": "2026-09-02", "c": 0.06, "closed": True}],
                               what="MIDPOINT", data_type="delayed")
    market.set_coverage("contract_bars", "venue_h", "9", T0, T0 + D, interval="1d")
    cov = market.contract_coverage("venue_h", underlying="SR3", sec_type="FOP")
    by = {r["symbol"]: r for r in cov}
    assert set(by) == {"9", "10"}
    assert (by["9"]["interval"], by["9"]["rows"], by["9"]["first_ts"], by["9"]["last_ts"]) == ("1d", 2, T0, T0 + D)
    assert (by["9"]["right"], by["9"]["strike"], by["9"]["under_con_id"]) == ("P", 96.25, 2002)
    assert by["9"]["covered_from"] == T0
    # registered, never barred: said, not hidden
    assert by["10"]["rows"] == 0 and by["10"]["interval"] is None
