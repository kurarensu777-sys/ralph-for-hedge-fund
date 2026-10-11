"""A predicted funding rate is not the settled contract: `predicted_funding` is its own dataset,
and fund_db.market.reader.funding() never returns a predicted row - whichever of the two rows
lands first, and whether it arrives by a direct write or through the live hot log.

The platform-side check (fundplat.data.crypto.settled_reader never returns a recorded predicted
row) belongs to P2, not here."""
import pytest

from fund_db import live, market
from fund_db.market import reader
from fund_db.market.registry import DATASETS, get

H = 3_600_000
T0 = 1_788_220_800_000          # 2026-09-01T00:00:00Z

SETTLED = {"symbol": "BTC", "ts": T0, "rate": 0.0000125, "interval_h": 1.0}
PREDICTED = {"symbol": "BTC", "ts": T0, "rate": 0.0000431, "interval_h": 1.0, "next_ts": T0 + H}


def _write_direct(order):
    for kind in order:
        if kind == "settled":
            market.write("funding", [SETTLED], "venue_g", now=T0 + 5)
        else:
            market.write("predicted_funding", [PREDICTED], "venue_g", now=T0 + 5)


def _write_live(order):
    for kind in order:
        if kind == "settled":
            live.record("funding", "venue_g", [SETTLED], now=T0 + 5)
        else:
            live.record("predicted_funding", "venue_g", [PREDICTED], now=T0 + 5)
    live.roll(now=T0 + 3 * H)


def _assert_apart():
    got = reader.funding("venue_g", as_="rows")
    assert [(g["symbol"], g["ts"], g["rate"]) for g in got] == [("BTC", T0, SETTLED["rate"])]
    # the funding dataset, read raw across every tier and the hot log, holds no predicted row
    raw = market.read("funding", include_live=True, as_="rows")
    assert [r["rate"] for r in raw] == [SETTLED["rate"]]
    # and no predicted row was merged in and filed as a settled re-publish
    assert market.conflicts("funding", as_="rows") == []
    pred = market.read("predicted_funding", "venue_g", as_="rows")
    assert [(p["rate"], p["interval_h"], p["next_ts"]) for p in pred] == [
        (PREDICTED["rate"], 1.0, T0 + H)]


def test_the_two_datasets_are_distinct():
    f, p = get("funding"), get("predicted_funding")
    assert f is not p and f.name == "funding" and p.name == "predicted_funding"
    assert set(DATASETS) >= {"funding", "predicted_funding"}
    assert "next_ts" not in f.columns and p.rule == "observe" and f.rule == "settled"


@pytest.mark.parametrize("order", [("predicted", "settled"), ("settled", "predicted")])
@pytest.mark.parametrize("path", ["direct", "live"])
def test_funding_reader_returns_only_the_settled_row(lake, order, path):
    (_write_direct if path == "direct" else _write_live)(order)
    _assert_apart()
