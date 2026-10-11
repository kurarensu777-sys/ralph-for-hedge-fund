"""The merge rules, row by row (merge.py), including the cases the fundplat archive tests pinned."""
from fund_db.market.merge import merge_row
from fund_db.market.registry import get

F, C, E = get("funding"), get("candles"), get("eod")


def fr(**kw):
    return {"symbol": "BTCUSDT", "ts": 1000, "rate": 1e-4, "src": "venue", "seen": 1, **kw}


def bar(**kw):
    return {"symbol": "BTC", "t": 0, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 10.0, "n": 3,
            "closed": True, "src": "venue", "seen": 1, **kw}


# ---- settled (funding) -------------------------------------------------------------------------

def test_settled_new_row_is_added():
    assert merge_row(F, None, fr())[0] == "added"


def test_settled_same_row_is_unchanged_whatever_seen_says():
    assert merge_row(F, fr(), fr(seen=99))[:2] == ("unchanged", None)


def test_settled_rate_change_is_a_conflict_and_keeps_the_stored_row():
    action, row, conf = merge_row(F, fr(), fr(rate=2e-4))
    assert (action, row) == ("conflict", None)
    assert conf["kind"] == "settled_row_changed" and conf["stored"]["rate"] == 1e-4


def test_settled_optional_value_change_is_a_conflict():
    assert merge_row(F, fr(premium=0.1), fr(premium=0.2))[0] == "conflict"
    assert merge_row(F, fr(interval_h=8.0), fr(interval_h=4.0))[0] == "conflict"
    assert merge_row(F, fr(rate_type="regular"), fr(rate_type="special"))[0] == "conflict"


def test_settled_null_optional_is_filled_not_replaced():
    action, row, conf = merge_row(F, fr(), fr(premium=0.1, interval_h=1.0, interval_src="venue", seen=5))
    assert action == "upgraded" and conf is None
    assert row["premium"] == 0.1 and row["interval_h"] == 1.0 and row["interval_src"] == "venue"
    assert row["seen"] == 1                         # the stored row's own stamp stands


def test_settled_seed_only_fills_holes():
    assert merge_row(F, None, fr(src="seed:x"))[0] == "added"
    action, row, conf = merge_row(F, fr(), fr(src="seed:x", rate=9.0))
    assert (action, row) == ("skipped", None) and conf["kind"] == "seed_vs_stored"
    assert merge_row(F, fr(), fr(src="seed:x"))[2] is None


def test_settled_venue_replaces_a_seed_and_logs_a_difference():
    action, row, conf = merge_row(F, fr(src="seed:x", rate=9.0), fr())
    assert action == "upgraded" and row["src"] == "venue" and conf["kind"] == "seed_vs_venue"


# ---- bar (candles) -----------------------------------------------------------------------------

def test_bar_unclosed_seed_is_skipped():
    assert merge_row(C, None, bar(src="seed:s", closed=False))[0] == "skipped"


def test_bar_forming_bar_is_replaced_by_the_venue():
    action, row, _ = merge_row(C, bar(closed=False, c=1.0), bar(closed=True, c=1.7))
    assert action == "updated" and row["c"] == 1.7 and row["closed"] is True


def test_bar_forming_bar_unchanged_when_equal():
    assert merge_row(C, bar(closed=False), bar(closed=False))[0] == "unchanged"


def test_bar_closed_venue_bar_is_immutable():
    action, row, conf = merge_row(C, bar(), bar(c=9.9))
    assert (action, row) == ("conflict", None) and conf["kind"] == "closed_bar_changed"


def test_bar_closed_bar_vs_incoming_forming_is_unchanged():
    assert merge_row(C, bar(), bar(closed=False, c=9.9))[0] == "unchanged"


def test_bar_venue_upgrades_a_partial_seed():
    seed = bar(src="seed:s", o=None, h=None, l=None, v=None, n=None)
    action, row, conf = merge_row(C, seed, bar())
    assert action == "upgraded" and row["h"] == 2.0 and conf is None
    action, _, conf = merge_row(C, seed, bar(c=3.0))
    assert action == "upgraded" and conf["kind"] == "seed_vs_venue"
    assert merge_row(C, seed, bar(closed=False))[0] == "skipped"     # never un-close a seed


def test_bar_seed_never_touches_a_stored_bar():
    action, _, conf = merge_row(C, bar(), bar(src="seed:s", c=5.0))
    assert action == "skipped" and conf["kind"] == "seed_vs_stored"


# ---- revise (eod) ------------------------------------------------------------------------------

def eod(**kw):
    return {"symbol": "SKHY.US", "date": "2026-07-10", "time": 1, "open": 1.0, "high": 2.0,
            "low": 0.5, "close": 1.5, "adj_close": 1.4, "volume": 100.0, "src": "venue", "seen": None, **kw}


def test_revise_replaces_and_logs_the_old_print():
    action, row, conf = merge_row(E, eod(), eod(adj_close=1.3))
    assert action == "revised" and row["adj_close"] == 1.3
    assert conf["kind"] == "revised" and conf["stored"]["adj_close"] == 1.4


def test_revise_null_to_value_counts_as_a_revision():
    assert merge_row(E, eod(volume=None), eod())[0] == "revised"


def test_revise_equal_is_unchanged():
    assert merge_row(E, eod(), eod(seen=5))[0] == "unchanged"
