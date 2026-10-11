"""retention.toml loading, and the three space jobs: usage, tier (hot -> cold, reads unchanged),
prune (-> _retired, never deleted, never an archive dataset), and the CLI's --json contract."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from fund_db import market
from fund_db.market import retention

from .conftest import H, T0

OLD = 1_767_225_600_000          # 2026-01-01T00:00:00Z
NOW = T0 + 30 * 24 * H           # 2026-10-01


def test_the_repo_file_loads_every_dataset(lake):
    rules = retention.load()
    assert set(rules) == set(market.DATASETS)
    assert rules["funding"].keep_days == 0 and rules["orderbook"].keep_days == 90
    assert rules["orderbook"].klass == "ephemeral"


@pytest.mark.parametrize("text,msg", [
    ("[datasets.funding]\nkeep_days = 30\n", "ARCHIVE"),
    ("[datasets.nope]\n", "unknown dataset"),
    ("[datasets.quotes]\nkeep = 3\n", "unknown key"),
    ("[datasets.quotes]\nkeep_days = -1\n", "non-negative"),
    ("[datasets.quotes]\nkeep_days = 10\ntier_after_days = 20\n", "below keep_days"),
    ("[datasets.quotes]\nclass = \"weekly\"\n", "class"),
    ("[dataset.quotes]\n", "unknown table"),
])
def test_bad_rules_are_refused(rules, text, msg):
    rules(text)
    with pytest.raises(retention.RetentionError, match=msg):
        retention.load()


def test_class_defaults_from_the_lines(rules):
    rules("[datasets.quotes]\nkeep_days = 10\n")
    r = retention.load()
    assert r["quotes"].klass == "rolling" and r["trades"].klass == "forever"


def _two_months_of_quotes():
    market.write_rows("quotes", "venue_a", [{"symbol": "BTC", "ts": OLD, "bid": 1.0, "ask": 2.0},
                                            {"symbol": "BTC", "ts": T0, "bid": 3.0, "ask": 4.0}])


def test_tier_moves_verified_and_reads_the_same(lake, rules):
    rules("[datasets.quotes]\ntier_after_days = 30\nkeep_days = 400\n")
    _two_months_of_quotes()
    before = market.quotes("venue_a", as_="rows")
    plan = market.tier("quotes", now_ms=NOW)
    assert [p["to"].split("month=")[1] for p in plan] == ["2026-01"]
    assert (lake["root"] / "market" / "quotes" / "venue=venue_a" / "month=2026-01").exists()   # dry run
    moved = market.tier("quotes", apply=True, now_ms=NOW)
    assert moved[0]["rows"] == 1 and moved[0]["files"] == 1
    assert not (lake["root"] / "market" / "quotes" / "venue=venue_a" / "month=2026-01").exists()
    assert (lake["root"] / "cold" / "quotes" / "venue=venue_a" / "month=2026-01").exists()
    assert market.quotes("venue_a", as_="rows") == before
    assert market.quotes("venue_a", tiers=("hot",), as_="rows") == before[1:]
    cat = market.coverage("quotes", "venue_a", "BTC")[0]
    assert cat["rows"] == 2 and cat["retention"] == "rolling"


def test_a_write_into_a_tiered_month_merges_with_it(lake, rules):
    rules("[datasets.quotes]\ntier_after_days = 30\n")
    _two_months_of_quotes()
    market.tier("quotes", apply=True, now_ms=NOW)
    rep = market.write_rows("quotes", "venue_a", [{"symbol": "BTC", "ts": OLD, "bid": 1.0, "ask": 2.0}])
    assert rep["unchanged"] == 1 and rep["added"] == 0


def test_prune_moves_to_retired_and_never_touches_an_archive(lake, rules):
    rules("[datasets.quotes]\nkeep_days = 30\n")
    _two_months_of_quotes()
    market.write_funding("venue_a", [{"ts": OLD, "rate": 1.0}], symbol="A")
    out = market.prune(apply=True, now_ms=NOW)
    assert [o["dataset"] for o in out] == ["quotes"]
    kept = lake["root"] / "_retired" / "market" / "quotes" / "venue=venue_a" / "month=2026-01"
    assert len(list(kept.glob("part-*.parquet"))) == 1
    assert [r["ts"] for r in market.quotes("venue_a", as_="rows")] == [T0]
    assert len(market.funding("venue_a", as_="rows")) == 1


def test_move_refuses_a_differing_destination(lake, rules):
    rules("[datasets.quotes]\ntier_after_days = 30\n")
    _two_months_of_quotes()
    src = lake["root"] / "market" / "quotes" / "venue=venue_a" / "month=2026-01"
    part = next(src.glob("part-*.parquet"))
    dst = lake["root"] / "cold" / "quotes" / "venue=venue_a" / "month=2026-01"
    dst.mkdir(parents=True)
    (dst / part.name).write_bytes(b"not the same")
    with pytest.raises(retention.RetentionError, match="differs"):
        market.tier("quotes", apply=True, now_ms=NOW)
    assert part.exists()


def test_usage_reports_every_tier_and_the_other_folders(lake, rules):
    rules("[datasets.quotes]\ntier_after_days = 30\n")
    _two_months_of_quotes()
    market.tier("quotes", apply=True, now_ms=NOW)
    u = market.usage()
    by = {(d["dataset"], d["tier"]): d for d in u["datasets"]}
    assert by[("quotes", "hot")]["rows"] == 1 and by[("quotes", "cold")]["rows"] == 1
    assert by[("quotes", "cold")]["first_month"] == "2026-01"
    assert {o["name"] for o in u["other"]} == {"_files", "live", "pins", "blobs", "_retired"}
    assert u["total_bytes"] == sum(d["bytes"] for d in u["datasets"]) + sum(o["bytes"] for o in u["other"])


# --------------------------------------------------------------------------------------------- #
# python -m fund_db tier|prune --json: the contract the cockpit's Data room reads (B-0292)
# --------------------------------------------------------------------------------------------- #

LONG_AGO = 1_577_836_800_000     # 2020-01-01T00:00:00Z: due under any rule below, whatever today is


def _quotes_due(*venues):
    """One partition per venue that is long past any tier line, and one row this hour (never due)."""
    now = int(time.time() * 1000)
    for v in venues:
        market.write_rows("quotes", v, [{"symbol": "BTC", "ts": LONG_AGO, "bid": 1.0, "ask": 2.0},
                                        {"symbol": "BTC", "ts": now, "bid": 3.0, "ask": 4.0}])


def _cli_json(capsys, *argv):
    from fund_db import cli
    code = cli.main(list(argv))
    last = capsys.readouterr().out.strip().splitlines()[-1]
    return code, json.loads(last)


def test_json_dry_run_then_apply(lake, rules, capsys):
    rules("[datasets.quotes]\ntier_after_days = 30\n")
    _quotes_due("venue_a")
    code, plan = _cli_json(capsys, "tier", "--dataset", "quotes", "--json")
    assert code == 0 and plan["ok"] is True and plan["kind"] == "tier" and plan["apply"] is False
    assert plan["dataset"] == "quotes" and len(plan["items"]) == 1
    assert plan["items"][0]["from"].endswith("month=2020-01") and plan["total_bytes"] == plan["items"][0]["bytes"] > 0
    assert _cli_json(capsys, "tier", "--dataset", "quotes", "--json")[1] == plan      # re-plan: identical
    code, done = _cli_json(capsys, "tier", "--dataset", "quotes", "--apply", "--json")
    assert code == 0 and done["ok"] is True and done["apply"] is True
    assert done["items"][0]["rows"] == 1 and done["items"][0]["files"] == 1
    assert done["total_bytes"] == plan["total_bytes"]
    assert _cli_json(capsys, "tier", "--dataset", "quotes", "--json")[1]["items"] == []    # nothing left due
    assert len(market.quotes("venue_a", as_="rows")) == 2


@pytest.mark.parametrize("argv,msg", [
    (("tier", "--dataset", "nope"), "unknown dataset"),
    (("prune", "--dataset", "funding"), "ARCHIVE"),
])
def test_json_refusals_exit_1(lake, rules, capsys, argv, msg):
    code, out = _cli_json(capsys, *argv, "--json")
    assert code == 1 and out["ok"] is False and msg in out["error"]
    assert out["status"] == 400                       # a refusal of the input, as fundplat.jobs.archive
    from fund_db import cli
    assert cli.main(list(argv)) == 1                  # refused without --json too
    assert msg in capsys.readouterr().err


def test_json_apply_stopped_part_way_names_what_moved(lake, rules, capsys):
    rules("[datasets.quotes]\ntier_after_days = 30\n")
    _quotes_due("venue_a", "venue_c")
    src = lake["root"] / "market" / "quotes" / "venue=venue_c" / "month=2020-01"
    part = next(src.glob("part-*.parquet"))
    dst = lake["root"] / "cold" / "quotes" / "venue=venue_c" / "month=2020-01"
    dst.mkdir(parents=True)
    (dst / part.name).write_bytes(b"not the same")
    code, out = _cli_json(capsys, "tier", "--apply", "--json")
    assert code == 1 and out["ok"] is False and "differs" in out["error"]
    assert out["status"] == 500                       # a RetentionError too, but the store broke, not the input
    assert [i["from"].split("venue=")[1].split(os.sep)[0] for i in out["items"]] == ["venue_a"]
    assert part.exists()


def test_json_from_the_fund_root_as_a_child_process(lake, rules):
    """The way the cockpit calls it: a child process, cwd the fund root, one object on the last line."""
    rules("[datasets.quotes]\ntier_after_days = 30\n")
    _quotes_due("venue_a")
    root = Path(__file__).resolve().parents[3]
    run = lambda *a: subprocess.run([sys.executable, "-m", "fund_db", *a, "--json"], cwd=root,
                                    capture_output=True, text=True, timeout=120, env=os.environ.copy())
    p = run("tier", "--dataset", "quotes")
    assert p.returncode == 0, p.stderr
    got = json.loads(p.stdout.strip().splitlines()[-1])
    assert got["ok"] is True and len(got["items"]) == 1 and got["items"][0]["dataset"] == "quotes"
    p = run("prune", "--dataset", "funding")
    assert p.returncode == 1
    assert json.loads(p.stdout.strip().splitlines()[-1]) == {
        "ok": False, "kind": "prune", "dataset": "funding", "apply": False, "items": [], "total_bytes": 0,
        "status": 400, "error": "RetentionError: funding is an ARCHIVE dataset: settled history is never pruned"}
