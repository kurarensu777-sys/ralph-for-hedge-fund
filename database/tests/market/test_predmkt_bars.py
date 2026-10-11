"""predmkt_bars (B-0385): price history of one prediction-market outcome, pulled on demand and
pinnable. What each test pins down: a re-listed market never merges into the old listing's bars; a
sample is never dressed as a candle; a price outside 0..1 is refused (cents read as dollars); a
forming bar is replaced and a closed bar is immutable; the rows pin, and the pin hash follows the
rows."""
import pytest

from fund_db import market
from fund_db.market import WriteError, predmkt_symbol, split_predmkt_symbol

H = 3_600_000
T0 = 1_788_220_800_000          # 2026-09-01T00:00:00Z
LISTED = T0 - 30 * 24 * H
SYM = predmkt_symbol("KXFED-26OCT-T4.25", LISTED)
TOKEN = predmkt_symbol("71321045679252212594626385532706912750332728571942532289631379312455583992563", LISTED)


def venue_i_bars(n=4, start=T0):
    return [{"t": start + i * H, "o": 0.40 + i / 100, "h": 0.45 + i / 100, "l": 0.38, "c": 0.42 + i / 100,
             "mean": 0.41, "prev": 0.40, "bid_o": 0.39, "bid_h": 0.44, "bid_l": 0.37, "bid_c": 0.41,
             "ask_o": 0.41, "ask_h": 0.46, "ask_l": 0.39, "ask_c": 0.43, "v": 120.0 + i, "oi": 5000.0}
            for i in range(n)]


def put(bars, sym=SYM, **kw):
    kw.setdefault("outcome", "yes")
    kw.setdefault("px_kind", "ohlc")
    kw.setdefault("closed_asof_ms", T0 + 10 * H)
    kw.setdefault("now", T0 + 10 * H)
    return market.write_predmkt_bars("venue_i", sym, "1h", bars, **kw)


def test_the_symbol_names_its_listing():
    assert split_predmkt_symbol(SYM) == ("KXFED-26OCT-T4.25", LISTED)
    assert split_predmkt_symbol("a@b@5") == ("a@b", 5)
    for bad in ("KXFED-26OCT-T4.25", "@5", "x@", "x@0", "x@-3", "x@1.5", "x@abc"):
        with pytest.raises(ValueError):
            split_predmkt_symbol(bad)


def test_a_bar_round_trips_with_every_served_column(classes):
    rep = put(venue_i_bars())
    assert rep["added"] == 4 and rep["storage"] == {"cache": 4}
    got = market.predmkt_bars("venue_i", SYM, "1h", as_="rows")
    assert [g["t"] for g in got] == [T0 + i * H for i in range(4)]
    g0 = got[0]
    assert (g0["outcome"], g0["px_kind"], g0["closed"]) == ("yes", "ohlc", True)
    assert (g0["bid_h"], g0["ask_l"], g0["mean"], g0["prev"], g0["oi"]) == (0.44, 0.39, 0.41, 0.40, 5000.0)


def test_a_symbol_without_a_listing_stamp_is_refused_and_nothing_lands(classes):
    with pytest.raises(WriteError, match="listed_ms"):
        put(venue_i_bars(), sym="KXFED-26OCT-T4.25")
    assert market.predmkt_bars("venue_i", as_="rows") == []


def test_a_relisted_market_is_a_new_series_not_a_merge(classes):
    """The same ticker listed again: its bars sit under its own stamp. Without the stamp the second
    listing's different bars would be a closed_bar_changed conflict against the first's."""
    again = predmkt_symbol("KXFED-26OCT-T4.25", T0 - 5 * H)
    put(venue_i_bars())
    other = [dict(b, c=0.9, h=0.95, o=0.88) for b in venue_i_bars()]
    rep = put(other, sym=again)
    assert rep["added"] == 4 and rep["conflicts"] == []
    assert len(market.predmkt_bars("venue_i", SYM, "1h", as_="rows")) == 4
    assert {r["c"] for r in market.predmkt_bars("venue_i", again, "1h", as_="rows")} == {0.9}
    assert market.predmkt_bars("venue_i", [SYM, again], "1h", as_="rows").__len__() == 8


def test_a_bar_before_its_listing_is_refused(classes):
    """Old listing's bars written under the new listing's stamp: the stamp is after the bar."""
    late = predmkt_symbol("KXFED-26OCT-T4.25", T0 + H)
    with pytest.raises(WriteError, match="before its listing"):
        put(venue_i_bars(), sym=late)
    assert market.predmkt_bars("venue_i", as_="rows") == []


def test_the_outcome_and_the_price_kind_are_required(classes):
    with pytest.raises(WriteError, match="outcome"):
        put(venue_i_bars(), outcome=None)
    with pytest.raises(WriteError, match="px_kind"):
        put(venue_i_bars(), px_kind=None)
    with pytest.raises(WriteError, match="px_kind"):
        put(venue_i_bars(), px_kind="vwap")


@pytest.mark.parametrize("col,val", [("c", 42.0), ("o", -0.01), ("bid_c", 1.2), ("mean", 55.0)])
def test_a_price_outside_a_probability_is_refused(classes, col, val):
    """venue_i's historical shape is not the live one; cents read as dollars must not land."""
    bars = venue_i_bars(1)
    bars[0][col] = val
    with pytest.raises(WriteError, match="probability"):
        put(bars)
    assert market.predmkt_bars("venue_i", as_="rows") == []


def test_a_candle_group_is_whole_and_ordered(classes):
    partial = venue_i_bars(1)
    partial[0]["l"] = None
    with pytest.raises(WriteError, match="all or none"):
        put(partial)
    inverted = venue_i_bars(1)
    inverted[0]["h"] = 0.30                      # below o and c
    with pytest.raises(WriteError, match="highest"):
        put(inverted)
    low = venue_i_bars(1)
    low[0]["bid_l"] = 0.60                       # above bid_o and bid_c
    with pytest.raises(WriteError, match="lowest"):
        put(low)


def test_a_bar_with_no_trade_is_stored_with_null_prices(classes):
    quiet = [{"t": T0, "bid_o": 0.39, "bid_h": 0.40, "bid_l": 0.39, "bid_c": 0.40,
              "ask_o": 0.41, "ask_h": 0.42, "ask_l": 0.41, "ask_c": 0.42, "v": 0.0, "oi": 5000.0}]
    assert put(quiet)["added"] == 1
    g = market.predmkt_bars("venue_i", SYM, "1h", as_="rows")[0]
    assert g["o"] is None and g["c"] is None and g["v"] == 0.0 and g["bid_c"] == 0.40


def test_a_sample_is_one_price_never_a_candle(classes):
    """venue_m serves {t, p}: stored as c only; an o/h/l beside it would be invented."""
    pm = [{"t": T0 + i * 60_000, "c": 0.61 + i / 1000} for i in range(3)]
    rep = market.write_predmkt_bars("venue_m", TOKEN, "1m", pm, outcome="Yes", px_kind="sample",
                                    closed_asof_ms=T0 + H, now=T0 + H)
    assert rep["added"] == 3
    g = market.predmkt_bars("venue_m", TOKEN, "1m", px_kind="sample", as_="rows")
    assert [x["c"] for x in g] == [0.61, 0.611, 0.612] and g[0]["o"] is None and g[0]["v"] is None
    dressed = [{"t": T0 + 5 * 60_000, "c": 0.6, "o": 0.6, "h": 0.6, "l": 0.6}]
    with pytest.raises(WriteError, match="invented"):
        market.write_predmkt_bars("venue_m", TOKEN, "1m", dressed, outcome="Yes", px_kind="sample")
    with pytest.raises(WriteError, match="`c`"):
        market.write_predmkt_bars("venue_m", TOKEN, "1m", [{"t": T0}], outcome="Yes", px_kind="sample")
    assert market.predmkt_bars("venue_m", TOKEN, "1m", px_kind="ohlc", as_="rows") == []


def test_a_forming_bar_is_replaced_and_a_closed_bar_is_immutable(classes):
    forming_at = T0 + H + 1_000                  # the bar opened at T0 + H is still open
    first = venue_i_bars(2)
    put(first, closed_asof_ms=forming_at, now=forming_at)
    rows = {r["t"]: r for r in market.predmkt_bars("venue_i", SYM, "1h", as_="rows")}
    assert rows[T0]["closed"] is True and rows[T0 + H]["closed"] is False
    assert market.predmkt_bars("venue_i", SYM, "1h", closed_only=True, as_="rows").__len__() == 1
    grown = [dict(b) for b in first]
    grown[1]["c"], grown[1]["h"] = 0.5, 0.55
    rep = put(grown)                             # now past the close: the venue's final bar replaces it
    assert rep["updated"] == 1 and rep["conflicts"] == []
    rows = {r["t"]: r for r in market.predmkt_bars("venue_i", SYM, "1h", as_="rows")}
    assert rows[T0 + H]["c"] == 0.5 and rows[T0 + H]["closed"] is True
    changed = [dict(grown[0], c=0.44, h=0.46)]
    rep = put(changed)
    assert [c["kind"] for c in rep["conflicts"]] == ["closed_bar_changed"]
    assert market.predmkt_bars("venue_i", SYM, "1h", as_="rows")[0]["c"] == first[0]["c"]
    assert [c["kind"] for c in market.conflicts("predmkt_bars", as_="rows")] == ["closed_bar_changed"]


def test_a_re_served_equal_bar_is_unchanged(classes):
    put(venue_i_bars())
    assert put(venue_i_bars())["unchanged"] == 4


def test_the_rows_pin_and_the_hash_follows_the_rows(classes):
    put(venue_i_bars())
    h = market.pin(dataset="predmkt_bars", venue="venue_i", symbol=SYM, interval="1h",
                   reason="the SOFR scenario's inputs", ref="research/sofr#1")
    assert market.pinned(h) is not None
    back = market.pin(dataset="predmkt_bars", venue="venue_i", symbol=SYM, interval="1h",
                      reason="again", ref="research/sofr#2")
    assert back == h                                          # same rows, same hash
    put([dict(venue_i_bars(1)[0], t=T0 + 4 * H)])
    more = market.pin(dataset="predmkt_bars", venue="venue_i", symbol=SYM, interval="1h",
                      reason="a longer window", ref="research/sofr#3")
    assert more != h


def test_the_dataset_is_cache_class_and_an_evicted_series_is_still_pinned(classes):
    from fund_db.market import cache
    from fund_db.market.registry import get
    ds = get("predmkt_bars")
    assert ds.storage == "cache" and ds.rule == "bar" and ds.sub_key == "interval" and ds.archive
    put(venue_i_bars())
    h = market.pin(dataset="predmkt_bars", venue="venue_i", symbol=SYM, interval="1h",
                   reason="r", ref="research/sofr#1")
    assert cache.evict(to_bytes=0)["evicted"]                 # the cache month goes, a venue serves it again
    assert market.predmkt_bars("venue_i", SYM, "1h", as_="rows") == []
    assert market.pinned(h) is not None and market.pinned(h).num_rows == 4
