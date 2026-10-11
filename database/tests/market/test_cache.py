"""The cache (B-0322): its budget, least-recently-read eviction of whole months, the coverage an
eviction clears, the archive guard, the reclassify gate, and the doctor's two properties."""
import time

import pytest

from fund_db import market
from fund_db.market import cache, catalog, layout

H = 3_600_000
M = {"2026-07": 1782864000000, "2026-08": 1785542400000, "2026-09": 1788220800000}


def put_month(month, symbol="BTCUSDT", venue="venue_a", n=24):
    return market.write_funding(venue, [{"ts": M[month] + i * H, "rate": 1e-5 * i} for i in range(n)],
                                symbol=symbol)


def months_on_disk(root):
    return sorted(p.name[6:] for p in (root / "cache").rglob("month=*"))


def test_usage_measures_the_cache_on_disk(classes):
    assert cache.cache_usage()["bytes"] == 0
    put_month("2026-08"); put_month("2026-09")
    u = cache.cache_usage()
    disk = sum(f.stat().st_size for f in (classes["root"] / "cache").rglob("part-*.parquet"))
    assert u["bytes"] == disk > 0 and u["partitions"] == 2 and u["max_bytes"] == 500_000_000
    assert u["datasets"][0]["dataset"] == "funding" and not u["over_budget"]
    assert any(d["tier"] == "cache" for d in market.usage()["datasets"])


def test_eviction_takes_the_least_recently_read_month_first(classes):
    for m in ("2026-07", "2026-08", "2026-09"):
        put_month(m)
    time.sleep(0.01)
    market.funding("venue_a", "BTCUSDT", start="2026-07-02", end="2026-07-03")   # July is read: newest
    one = max(p["bytes"] for p in cache.partitions())
    plan = cache.evict(to_bytes=one, apply=False)
    assert [e["month"] for e in plan["evicted"]] == ["2026-08", "2026-09"]
    assert months_on_disk(classes["root"]) == ["2026-07", "2026-08", "2026-09"]      # a plan moves nothing
    r = cache.evict(to_bytes=one)
    assert [e["month"] for e in r["evicted"]] == ["2026-08", "2026-09"]
    assert months_on_disk(classes["root"]) == ["2026-07"]
    assert r["after_bytes"] <= one
    assert [x[3] for x in classes["storage"].parts] == ["2026-07"]
    assert {r["ts"] // 1000 for r in market.funding("venue_a", "BTCUSDT", as_="rows")} <= \
        {(M["2026-07"] + i * H) // 1000 for i in range(24)}


def test_eviction_clears_the_fetch_coverage_of_what_it_took(classes):
    put_month("2026-09")
    market.set_coverage("funding", "venue_a", "BTCUSDT", M["2026-09"], M["2026-09"] + 23 * H)
    cache.evict(to_bytes=0)
    row = catalog.query("funding", "venue_a", "BTCUSDT")
    assert row == [] or (row[0]["covered_from"] is None and row[0]["covered_to"] is None)


def test_a_write_holds_the_budget_and_never_evicts_what_it_wrote(classes, rules):
    put_month("2026-07")
    one = cache.cache_usage()["bytes"]
    rules(f"[cache]\nmax_bytes = {one + one // 2}\n")
    put_month("2026-09")
    assert months_on_disk(classes["root"]) == ["2026-09"]
    rules("[cache]\nmax_bytes = 1\n")
    put_month("2026-08")                       # over budget alone, but never evicts itself
    assert "2026-08" in months_on_disk(classes["root"])


def test_the_archive_guard_refuses_to_evict_and_the_doctor_sees_it(classes):
    from fund_db.cli import storage_checks
    market.write_candles("venue_g", "ETH", "1h", [{"t": M["2026-09"], "o": 1, "h": 1, "l": 1, "c": 1}])
    ok = {c["check"]: c["status"] for c in storage_checks()}
    assert ok["no archive series in the cache"] == "ok" and ok["cache within budget"] == "ok"
    # break it on purpose: declare the series that already sits in the cache
    market.declare_archive("venue_g", [{"dataset": "candles"}], why="cap", source="tests")
    bad = {c["check"]: c for c in storage_checks()}
    assert bad["no archive series in the cache"]["status"] == "fail"
    r = cache.evict(to_bytes=0)
    assert r["evicted"] == [] and len(r["refused"]) == 1
    assert months_on_disk(classes["root"]) == ["2026-09"]


def test_the_doctor_fails_over_budget(classes, rules):
    from fund_db.cli import storage_checks
    put_month("2026-09")
    rules("[cache]\nmax_bytes = 10\n")
    assert {c["check"]: c["status"] for c in storage_checks()}["cache within budget"] == "fail"


def test_eviction_refuses_a_folder_outside_the_cache(classes):
    market.declare_archive("venue_a", [{"dataset": "funding"}], why="w", source="s")
    put_month("2026-09")
    pdir = layout.partitions(layout.hot_root(), market.get("funding"))[0]
    with pytest.raises(cache.CacheError, match="not under the cache root"):
        cache._drop_partition(market.get("funding"), pdir)
    assert list(pdir.glob("part-*.parquet"))


def test_retention_refuses_a_bad_cache_table(lake, rules):
    from fund_db.market import retention
    rules("[cache]\nmax_bytes = -1\n")
    with pytest.raises(retention.RetentionError, match="max_bytes"):
        retention.load()
    rules("[cache]\nbudget = 1\n")
    with pytest.raises(retention.RetentionError, match="unknown key"):
        retention.load()


def test_reclassify_is_gated_on_a_pin_and_moves_the_legacy_lake_verified(classes):
    # the legacy lake: a funding month, a declared candle month, and a class-none quote month
    market.declare_archive("venue_a", [{"dataset": "funding"}, {"dataset": "quotes"}], why="legacy", source="t")
    market.declare_archive("venue_g", [{"dataset": "candles"}], why="cap", source="t")
    put_month("2026-09")
    market.write_rows("quotes", "venue_a", [{"symbol": "BTCUSDT", "ts": M["2026-09"], "bid": 1.0}])
    market.write_candles("venue_g", "BTC", "1h", [{"t": M["2026-09"], "o": 1, "h": 1, "l": 1, "c": 1}])
    market.declare_archive("venue_a", [], why="B-0322: not archived any more", source="t")
    before = market.funding("venue_a", "BTCUSDT", as_="rows")
    plan = cache.reclassify()
    assert [(i["dataset"], i["month"]) for i in plan["to_cache"]] == [("funding", "2026-09")]
    assert [i["dataset"] for i in plan["kept"]] == ["quotes"] and "class none" in plan["kept"][0]["why"]
    with pytest.raises(cache.CacheError, match="no pin exists"):
        cache.reclassify(apply=True)
    market.pin(dataset="funding", venue="venue_a", symbol="BTCUSDT", reason="backfill", ref="lab/x#1")
    done = cache.reclassify(apply=True)
    assert done["to_cache"][0]["rows"] == 24
    assert not (classes["root"] / "market" / "funding").exists() or \
        not list((classes["root"] / "market" / "funding").rglob("part-*.parquet"))
    assert market.funding("venue_a", "BTCUSDT", as_="rows") == before
    assert list((classes["root"] / "market" / "candles").rglob("part-*.parquet"))     # archive stays
    assert list((classes["root"] / "market" / "quotes").rglob("part-*.parquet"))      # none: kept
    assert cache.reclassify()["to_cache"] == []


# ---------------------------------------------------------------------------------------------- #
# the weekly clean (B-0335)
# ---------------------------------------------------------------------------------------------- #

DAY = 86_400_000


def age(classes, month, written_days, read_days=None, dataset="funding", venue="venue_a", interval=""):
    """Put a cache month's recorded write / last-read times that many days in the past."""
    now = int(time.time() * 1000)
    classes["storage"].parts[(dataset, venue, interval, month)].update(
        written_ms=now - written_days * DAY, last_read_ms=None if read_days is None else now - read_days * DAY)


def test_clean_evicts_an_idle_month_and_keeps_a_read_or_a_new_one(classes):
    for m in ("2026-07", "2026-08", "2026-09"):
        put_month(m)
    age(classes, "2026-07", 30)                    # written 30d ago, never read: idle
    age(classes, "2026-08", 30, read_days=2)       # written 30d ago, read 2d ago: kept
    age(classes, "2026-09", 0)                     # written just now: kept
    r = cache.clean(idle_days=14)
    assert [e["month"] for e in r["evicted"]] == ["2026-07"]
    assert (r["ok"], r["evicted_months"], r["kept_months"], r["dry"]) == (True, 1, 2, False)
    assert months_on_disk(classes["root"]) == ["2026-08", "2026-09"]
    assert r["evicted_bytes"] > 0 and r["after_bytes"] == r["before_bytes"] - r["evicted_bytes"] == r["cache_bytes"]
    # the idle line is the argument: at 1 day the read-2d-ago month goes as well
    r2 = cache.clean(idle_days=1)
    assert [e["month"] for e in r2["evicted"]] == ["2026-08"] and months_on_disk(classes["root"]) == ["2026-09"]


def test_clean_dry_deletes_nothing_and_reports_the_same_plan(classes):
    for m in ("2026-07", "2026-08"):
        put_month(m)
    age(classes, "2026-07", 40); age(classes, "2026-08", 40)
    before = cache.cache_usage()["bytes"]
    plan = cache.clean(idle_days=14, apply=False)
    assert plan["dry"] and plan["evicted_months"] == 2 and plan["kept_months"] == 0
    assert months_on_disk(classes["root"]) == ["2026-07", "2026-08"] and cache.cache_usage()["bytes"] == before
    assert plan["cache_bytes"] == plan["before_bytes"] == before and plan["after_bytes"] == 0   # disk now vs the plan
    real = cache.clean(idle_days=14)
    assert [(e["month"], e["bytes"]) for e in real["evicted"]] == [(e["month"], e["bytes"]) for e in plan["evicted"]]
    assert cache.cache_usage()["bytes"] == 0


def test_clean_never_touches_a_pin_even_when_the_cache_month_is_idle(classes):
    put_month("2026-09")
    h = market.pin(dataset="funding", venue="venue_a", symbol="BTCUSDT", reason="a recorded run", ref="lab/x#1")
    age(classes, "2026-09", 90)
    r = cache.clean(idle_days=14)
    assert r["evicted_months"] == 1 and months_on_disk(classes["root"]) == []     # the cache copy goes ...
    assert len(market.pinned(h, as_="rows")) == 24                                # ... the pin still reads, digest verified
    assert (classes["root"] / "pins" / h[:2] / f"{h}.parquet").exists()
    assert r["pins"] == 1 and r["pins_bytes"] > 0


def test_clean_never_evicts_an_archive_month_even_when_idle_and_fails_loudly_if_over_budget(classes, rules):
    market.write_candles("venue_g", "ETH", "1h", [{"t": M["2026-09"], "o": 1, "h": 1, "l": 1, "c": 1}])
    market.declare_archive("venue_g", [{"dataset": "candles"}], why="cap", source="tests")   # it now sits in the cache
    age(classes, "2026-09", 90, dataset="candles", venue="venue_g", interval="1h")
    r = cache.clean(idle_days=14)
    assert r["evicted_months"] == 0 and r["refused_months"] == 1 and r["ok"] is True
    assert months_on_disk(classes["root"]) == ["2026-09"]
    rules("[cache]\nmax_bytes = 1\n")                # over budget with only an archive month to take: not ok
    r = cache.clean(idle_days=14)
    assert r["ok"] is False and "still over its budget" in r["error"] and months_on_disk(classes["root"]) == ["2026-09"]


def test_clean_still_evicts_to_the_budget_when_nothing_is_idle(classes, rules):
    for m in ("2026-07", "2026-08", "2026-09"):
        put_month(m)
    one = max(p["bytes"] for p in cache.partitions())
    rules(f"[cache]\nmax_bytes = {one}\n")
    time.sleep(0.01)
    market.funding("venue_a", "BTCUSDT", start="2026-09-02", end="2026-09-03")   # September is read: newest
    r = cache.clean(idle_days=14)
    assert r["ok"] and r["evicted_months"] == 2 and months_on_disk(classes["root"]) == ["2026-09"]
    assert r["after_bytes"] <= r["budget_bytes"] == one


def test_clean_reports_the_three_sizes_measured_on_disk(classes):
    market.declare_archive("venue_g", [{"dataset": "candles"}], why="cap", source="tests")
    market.write_candles("venue_g", "BTC", "1h", [{"t": M["2026-09"], "o": 1, "h": 1, "l": 1, "c": 1}])
    put_month("2026-09")
    market.pin(dataset="funding", venue="venue_a", symbol="BTCUSDT", reason="r", ref="x#1")
    root = classes["root"]
    parts = lambda sub: sum(f.stat().st_size for f in (root / sub).rglob("part-*.parquet"))
    r = cache.clean(idle_days=14, apply=False)
    assert r["cache_bytes"] == parts("cache") > 0
    assert r["archive_bytes"] == parts("market") > 0          # the declared candle month, in the lake
    assert r["pins"] == 1 and r["pins_bytes"] == sum(f.stat().st_size for f in (root / "pins").rglob("*.parquet")) > 0
    assert set(r) >= {"ok", "error", "evicted_months", "evicted_bytes", "kept_months", "after_bytes", "budget_bytes",
                      "refused_months", "idle_days", "dry", "before_bytes", "cache_bytes", "pins", "pins_bytes", "archive_bytes",
                      "files_bytes", "ops_bytes"}


def test_cli_clean_prints_one_json_line_and_exits_0_or_1(classes, rules, capsys):
    import json

    from fund_db import cli
    put_month("2026-07")
    age(classes, "2026-07", 30)
    assert cli.main(["cache", "--clean", "--dry", "--json"]) == 0
    d = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert d["ok"] and d["dry"] and d["evicted_months"] == 1 and months_on_disk(classes["root"]) == ["2026-07"]
    assert cli.main(["cache", "--clean", "--idle-days", "14", "--json"]) == 0
    d = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert d["ok"] and not d["dry"] and d["idle_days"] == 14 and months_on_disk(classes["root"]) == []
    put_month("2026-08")
    rules("[cache]\nmax_bytes = 1\n")
    market.declare_archive("venue_a", [{"dataset": "funding"}], why="w", source="s")    # the only month is archive: stuck
    assert cli.main(["cache", "--clean", "--json"]) == 1
    d = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert d["ok"] is False and "over its budget" in d["error"]
    assert cli.main(["cache", "--clean", "--idle-days", "-1", "--json"]) == 1
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["ok"] is False
