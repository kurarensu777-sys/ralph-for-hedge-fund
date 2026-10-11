"""The read models the cockpit asks for and the platform logs (migration ops/002), against a real
migrated database. Every expected value is written by hand from the rows the test inserts."""
from __future__ import annotations

from fund_db import ops


def test_events_windows_turns_and_payload_lookups(db):
    ops.log_event("turn", "t1", agent="app", conversation="c1", ts=100)
    ops.log_event("tool", "Edit a.py", agent="app", conversation="c1", ts=150)
    ops.log_event("turn", "t2", agent="app", conversation="c1", ts=200)
    ops.log_event("turn", "u1", agent="fund", conversation="c0", ts=120)
    ops.log_event("error", "boom", conversation="c1", ts=210)
    ops.log_event("error", "boom2", conversation="c1", ts=220)
    ops.log_event("board", "B-0001 status=done", ts=90)
    ops.log_event("wake", "woke", payload={"dashboard": "terminal"}, ts=300)
    ops.log_event("wake", "woke", payload={"dashboard": "vol"}, ts=400)
    ops.log_event("job", "reverted abc", conversation="c9", ts=50)
    assert [e["summary"] for e in ops.events_in_window(100, 210)] == ["t1", "u1", "Edit a.py", "t2"]
    assert [e["summary"] for e in ops.events_in_window(0, 1000, kinds=["turn", "error"], agent_only=True)] == ["t1", "u1", "t2"]
    assert [(e["conversation_id"], e["summary"]) for e in ops.turn_events()] == [("c0", "u1"), ("c1", "t1"), ("c1", "t2")]
    assert [e["summary"] for e in ops.turn_events("c1")] == ["t1", "t2"]
    assert [e["summary"] for e in ops.turn_window_events("c1", "tool", 100, 200)] == ["Edit a.py"]
    assert ops.turn_window_events("c1", "tool", 150, 200) == []          # the lower bound is exclusive
    assert ops.last_event_ts("wake", "dashboard", "terminal") == 300
    assert ops.last_event_ts("wake", "dashboard", "preds") is None
    assert ops.reverted_conversations() == ["c9"]
    assert ops.error_counts_by_conversation() == {"c1": 2}


def test_conversation_reads(db):
    ops.create_conversation("a", "app", started_at=10, transcript_uuid="u", cwd="C:/x")
    ops.create_conversation("b", "app", started_at=20)
    ops.create_conversation("c", "fund", started_at=30, transcript_uuid="v", cwd="C:/y")
    ops.forget_conversation("c")
    assert ops.touch_conversation("b", ts=99, title="first") == 1
    assert ops.touch_conversation("b", ts=100, title="second") == 1
    b = ops.get_conversation("b")
    assert (b["last_at"], b["title"]) == (100, "first")
    assert ops.next_unindexed_conversation() == {"id": "a", "cwd": "C:/x", "transcript_uuid": "u"}
    assert ops.conversation_counts() == {"app": 2}
    assert ops.list_conversation_ids() == ["a", "b", "c"]
    ops.update_conversation("a", state="idle", last_at=500)
    ops.update_conversation("b", state="closed", last_at=600)
    assert [r["id"] for r in ops.conversations_due_for_draft_scan(1000, 0)] == ["b", "a"]
    ops.bump_draft_scan("b", 600, found=1, cost_usd=0.5, note="x", ts=700)
    assert [r["id"] for r in ops.conversations_due_for_draft_scan(1000, 0)] == ["a"]
    assert [r["id"] for r in ops.conversations_due_for_draft_scan(550, 0)] == ["a"]
    assert ops.conversations_due_for_draft_scan(1000, 500) == []


def test_messages_prefix_search_and_assistant_text(db):
    ops.index_message("c1", "user", "the funding cadence question", ts=1)
    ops.index_message("c1", "assistant", "venue_g funding settles hourly", ts=2)
    ops.index_message("c2", "assistant", "nothing here", ts=3)
    assert ops.prefix_words("Fund; DROP & | !cad") == ["fund", "drop", "cad"]
    hits = ops.search_messages_prefix("fund cad")
    assert [h["conversation_id"] for h in hits] == ["c1"]
    assert "cadence" in hits[0]["snippet"]
    assert ops.search_messages_prefix("&|!:*") == []
    assert ops.assistant_text("c1", 0, 2) == ["venue_g funding settles hourly"]
    assert ops.assistant_text("c1", 2, 5) == []


def test_presence_heartbeat(db):
    ops.set_presence("chat:a", "app", ts=1)
    ops.set_presence("chat:b", "app", ts=1)
    assert ops.heartbeat_presence(["chat:a"], ts=50) == 1
    assert ops.heartbeat_presence([]) == 0
    got = {r["hand_id"]: r["heartbeat_at"] for r in ops.list_presence()}
    assert got == {"chat:a": 50, "chat:b": 1}


def test_pull_ledger(db):
    ops.record_read("fund", "boot.md", at_boot=True, ts=5)
    assert ops.record_read_once("app", "a.md", conversation_id="c1", ts=100) is True
    assert ops.record_read_once("app", "a.md", conversation_id="c1", ts=150) is False       # inside 60 s
    assert ops.record_read_once("app", "a.md", conversation_id="c1", ts=100 + 60_001) is True
    assert ops.record_read_once("app", "b.md", conversation_id="c1", ts=200) is True
    assert ops.record_read_once("fund", "a.md", conversation_id=None, ts=300) is True
    assert ops.count_reads_by_book("c1") == {"a.md": 2, "b.md": 1}
    assert ops.books_read_in_conversation("c1") == ["a.md", "b.md"]
    assert ops.pull_ledger_span() == {"first": 100, "n": 4}
    assert ops.pulled_books() == ["a.md", "b.md"]
    stats = {(r["book_path"], r["at_boot"]): (r["n_since"], r["last"]) for r in ops.read_stats_by_book(150)}
    assert stats == {("a.md", False): (2, 60_101), ("b.md", False): (1, 200), ("boot.md", True): (0, 5)}
    assert [(r["book_path"], r["agent_id"], r["n"]) for r in ops.pullers_by_book(0)] == [
        ("a.md", "app", 2), ("b.md", "app", 1), ("a.md", "fund", 1)]
    assert [(r["agent_id"], r["book_path"], r["n"], r["last"]) for r in ops.pulls_by_agent(0)] == [
        ("app", "a.md", 2, 60_101), ("fund", "a.md", 1, 300), ("app", "b.md", 1, 200)]
    assert [(r["book_path"], r["ts"]) for r in ops.list_pulls()] == [("a.md", 100), ("a.md", 60_101), ("b.md", 200)]
    assert ops.conversations_with_pulls() == ["c1"]


def test_commit_reads(db):
    ops.upsert_commit({"repo": "app", "sha": "a1", "ts": 10, "subject": "one", "conversation_id": "c1", "files_json": ["x.ts"]})
    ops.upsert_commit({"repo": "app", "sha": "a2", "ts": 20, "subject": "Revert \"one\"", "loop_change": "L-001",
                       "shrink_json": {"n": 2}})
    assert [c["sha"] for c in ops.commit_subjects()] == ["a1", "a2"]
    assert ops.commit_subjects()[1]["loop_change"] == "L-001"
    assert ops.commit_files("c1", 0, 10) == [["x.ts"]]
    assert ops.commit_files("c1", 10, 20) == []
    assert ops.known_commits("app", ["a1", "zz"]) == {"a1"}
    assert ops.known_commits("app", []) == set()
    assert ops.commit_shrinks("app", ["a1", "a2"]) == {"a2": {"n": 2}}


def test_loop_reads_and_grade_clearing(db):
    ops.add_lesson("app", "old", ts=10)
    ops.add_lesson("app", "new", ts=20)
    assert [x["text"] for x in ops.lessons_since(15)] == ["new"]
    for day in ("2026-09-01", "2026-09-02", "2026-09-03"):
        ops.set_metric(day, "app", "turns", 1)
    assert [m["day"] for m in ops.metrics_between("2026-09-02", "2026-09-03")] == ["2026-09-02", "2026-09-03"]
    assert ops.clear_metrics("2026-09-02") == 2
    assert [m["day"] for m in ops.list_metrics()] == ["2026-09-01"]
    ops.add_usage(None, "app", tokens_in=1, ts=5)
    ops.add_usage(None, "app", tokens_in=2, ts=15)
    assert [u["tokens_in"] for u in ops.usage_in_window(5, 15)] == [1]
    ops.upsert_turn_grade({"conversation_id": "c1", "turn_ix": 0, "source": "owner", "key": "good", "value": 1.0, "ts": 30})
    ops.upsert_turn_grade({"conversation_id": "c1", "turn_ix": 0, "source": "check", "key": "nodash", "value": 0.0, "ts": 30})
    ops.upsert_turn_grade({"conversation_id": "c1", "turn_ix": 1, "source": "check", "key": "nodash", "value": 1.0, "ts": 40})
    assert [g["turn_ix"] for g in ops.grades_in_window("check", 0, 40)] == [0]
    assert ops.graded_turns("check") == [{"conversation_id": "c1", "turn_ix": 0}, {"conversation_id": "c1", "turn_ix": 1}]
    ops.upsert_review({"conversation_id": "c1", "turn_ix": 0, "reason": "a", "state": "open", "ts": 1})
    ops.upsert_review({"conversation_id": "c1", "turn_ix": 0, "reason": "b", "state": "open", "ts": 2})
    assert ops.set_review_state_all("c1", 0, "done") == 2
    assert {r["state"] for r in ops.list_review_all()} == {"done"}
    assert [r["reason"] for r in ops.list_review_all()] == ["b", "a"]
    assert ops.clear_owner_grade("c1", 0) == 1
    assert {r["state"] for r in ops.list_review_all()} == {"open"}
    assert [g["source"] for g in ops.list_turn_grades("c1") if g["turn_ix"] == 0] == ["check"]


def test_board_alert_and_draft_reads(db):
    ops.attest_board("B-0002", "fp2", "ui", ts=2)
    ops.attest_board("B-0001", "fp1", "ui", ts=1)
    assert [r["id"] for r in ops.list_board_attest()] == ["B-0001", "B-0002"]
    ops.sync_board_suggestions([{"fp": "f1", "source": "code", "kind": "todo", "path": "a", "line": 3, "ref": "r", "quote": "q", "title": "x"},
                                {"fp": "f2", "source": "code", "kind": "todo", "path": "a", "line": None, "ref": "r", "quote": "q", "title": "y"}], ts=5)
    ops.mark_suggestion_done("f1", "filed")
    assert [s["fp"] for s in ops.list_open_board_suggestions()] == ["f2"]
    ops.log_alert("r1", "s", 100, "ok", "log", at=100)
    ops.log_alert("r1", "t", 200, "fail", "log", at=200)
    ops.log_alert("r2", "s", 100, "held", "log", at=150)
    assert ops.alert_log_keys(["r1"], [100]) == [{"rule": "r1", "subject": "s", "bar": 100}]
    assert ops.alert_delivered_counts(["r1", "r2"], 150) == {"r1": 1}
    ops.add_alert_pass(1, "1h", 1, 1, at=10)
    ops.add_alert_pass(2, "1h", 1, 1, at=20)
    assert ops.first_alert_pass() == 10
    assert ops.prune_alert_passes(15) == 1
    assert ops.first_alert_pass() == 20
    r = ops.bump_draft_scan("c1", 10, found=1, cost_usd=0.25, note="a", ts=11)
    r = ops.bump_draft_scan("c1", 20, found=2, cost_usd=0.5, note="b", ts=21)
    assert (r["last_at"], r["found"], r["cost_usd"], r["note"], r["ts"]) == (20, 3, 0.75, "b", 21)
    lid = ops.add_lesson("app", "a lesson", conversation_id="c1", ts=1)
    assert ops.conversation_has_undrafted_lesson("c1") is True
    ops.add_library_draft({"conv": "c1", "agent": "app", "shelf": "s", "path": "p.md", "book": "b", "series_row": "r",
                           "quote": "q", "key": "k1", "lesson_id": lid, "state": "saved"})
    assert ops.conversation_has_undrafted_lesson("c1") is False
    assert ops.library_draft_exists("k1") is True and ops.library_draft_exists("k2") is False
    assert ops.library_draft_tally() == {"saved": 1, "dismissed": 0, "last_scan_ts": 21}


def test_processes_health_jobs(db):
    pid = ops.add_process("terminal", "managed", "python server.py", pid=1, port=8787, started_at=1)
    assert ops.close_process_once(pid, 3, stopped_at=5) == 1
    assert ops.close_process_once(pid, 9, stopped_at=6) == 0
    p = ops.list_processes("terminal")[0]
    assert (p["stopped_at"], p["exit_code"]) == (5, 3)
    ops.record_health("dash:terminal/port", "dashboard", "ok", "up", ts=10)
    ops.record_health("dash:terminal/port", "dashboard", "fail", "down", detail={"window_s": 60}, ts=20)
    ops.record_health("venue:venue_a", "venue", "ok", ts=30)
    assert [(r["ts"], r["status"]) for r in ops.health_readings_since("dash:", "dashboard", 15)] == [(20, "fail")]
    assert ops.health_probes_seen(["dash:terminal/port", "venue:x"], 15) == {"dash:terminal/port"}
    assert ops.last_health_ts(["dash:terminal/port", "venue:venue_a"]) == {"dash:terminal/port": 20, "venue:venue_a": 30}
    assert [r["ts"] for r in ops.health_between(["dash:terminal/port"], 10, 20)] == [10, 20]
    b = ops.health_before(["dash:terminal/port"], 20)
    assert [(r["ts"], r["reading"]) for r in b] == [(10, "up")]
    ops.add_job_run("sweep", "missed", due_at=100, ended_at=101)
    ops.add_job_run("sweep", "ok", due_at=200, started_at=201, ended_at=210)
    ops.add_job_run("probe", "ok", started_at=150, ended_at=160, trigger="manual")
    assert [r["job_id"] for r in ops.job_runs_in_window(100, 160)] == ["sweep", "probe"]
    assert ops.job_run_span() == {"first": 101, "first_due": {"sweep": 100}}


def test_usage_reads(db):
    ops.add_usage(None, "app", tokens_in=10, tokens_out=5, cache_write=1, cost_usd=0.5, ts=1_790_000_000_000)
    ops.add_usage(None, "app", tokens_in=1, ts=1_790_000_000_001)
    ops.add_usage(None, "fund", tokens_in=100, ts=1_790_000_000_002)
    days = ops.usage_by_day(0, "UTC")
    assert [(d["agent"], d["day"], d["billable"], d["n"]) for d in days] == [("app", "2026-09-21", 17.0, 2), ("fund", "2026-09-21", 100.0, 1)]
    assert ops.billable_on_day("2026-09-21", "UTC", 0) == {"billable": 117.0, "n": 3}
    assert ops.billable_on_day("2026-09-20", "UTC", 0) == {"billable": None, "n": 0}
    assert [r["billable"] for r in ops.billable_rows(1_790_000_000_000, 1_790_000_000_002)] == [16.0, 1.0]
    assert ops.billable_by_agent(0) == {"app": 17.0, "fund": 100.0}
    ops.add_spend_alert("app", 10, 2.0, ts=5)
    ops.add_spend_alert("app", 12, 2.0, ts=9)
    assert ops.last_spend_alerts() == {"app": 9}


def test_data_audit_is_append_only_and_reads_oldest_first(db):
    for i in range(3):
        ops.add_data_audit("delete.apply", "tester", request={"i": i}, result={"ok": True}, plan_id=f"p{i}", pid=7, host="h", ts=10 + i)
    rows = ops.list_data_audit(2)
    assert [r["plan_id"] for r in rows] == ["p1", "p2"]
    assert rows[0]["request"] == {"i": 1} and rows[0]["result"] == {"ok": True}


def test_the_wire_tables(db):
    rows = [{"ts_ms": 100, "prev_ms": 50, "venue": "venue_a", "kind": "cadence", "subject": "BTC", "before": 8.0, "after": 4.0,
             "source": "fundingInfo", "tag": "[API]"},
            {"ts_ms": 200, "prev_ms": None, "venue": "venue_a", "kind": "list", "subject": "ETH", "before": None, "after": "listed"},
            {"ts_ms": 150, "venue": "venue_l", "kind": "delist", "subject": "X", "before": "listed", "after": "delisted"}]
    assert ops.add_wire_changes(rows, logged=999) == 3
    assert ops.add_wire_changes([]) == 0
    newest = ops.list_wire_changes()
    assert [r["subject"] for r in newest] == ["ETH", "X", "BTC"]
    assert newest[2]["before"] == 8.0 and newest[2]["after"] == 4.0 and newest[0]["after"] == "listed"
    assert newest[0]["tag"] == "[API]" and newest[0]["logged"] == 999
    assert [r["subject"] for r in ops.list_wire_changes(venue="venue_a", oldest_first=True, limit=None)] == ["BTC", "ETH"]
    assert [r["subject"] for r in ops.list_wire_changes(since=150)] == ["ETH", "X"]
    assert ops.count_wire_changes() == 3 and ops.count_wire_changes(venue="venue_l") == 1
    ops.set_wire_snapshot("venue_a", "2026-09-24", 10, {"BTC": {"cadence_h": 8}}, source="a")
    ops.set_wire_snapshot("venue_a", "2026-09-25", 20, {"BTC": {"cadence_h": 4}, "ETH": {}}, source="b")
    ops.set_wire_snapshot("venue_a", "2026-09-25", 30, {"BTC": {"cadence_h": 4}, "ETH": {}, "SOL": {}}, source="c")
    s = ops.latest_wire_snapshot("venue_a")
    assert (s["day"], s["ts_ms"], s["source"], sorted(s["markets"])) == ("2026-09-25", 30, "c", ["BTC", "ETH", "SOL"])
    assert ops.latest_wire_snapshot("venue_l") is None
    assert ops.wire_snapshot_heads() == {"venue_a": {"ts_ms": 30, "markets": 3, "source": "c"}}
    assert ops.get_wire_state("special_scan_ms") is None
    ops.set_wire_state("special_scan_ms", 12345, ts=1)
    assert ops.get_wire_state("special_scan_ms") == 12345


def test_no_lesson(db):
    ops.add_no_lesson(".", "s1", "nothing new", ts=1)
    ops.add_no_lesson("lab/x", "s2", "empty", hand="h", operator="o", touched=["a.md"], ts=2)
    ops.add_no_lesson("", "s3", "blank desk is the root", ts=3)
    assert [r["subject"] for r in ops.list_no_lesson()] == ["s3", "s2", "s1"]
    assert [r["subject"] for r in ops.list_no_lesson(".")] == ["s3", "s1"]
    assert ops.list_no_lesson("lab/x")[0]["touched"] == ["a.md"]


def test_fund_book_daily_is_one_row_per_utc_day_through_the_generic_calls(db):
    import pytest
    from psycopg.errors import CheckViolation

    ops.upsert("fund_book_daily", {"day": "2026-10-02", "pnl_usd": -12.5, "updated": 1})
    ops.upsert("fund_book_daily", {"day": "2026-10-01", "pnl_usd": 100.0, "updated": 2})
    ops.upsert("fund_book_daily", {"day": "2026-10-02", "pnl_usd": -20.25, "updated": 3})   # a restated day
    rows = ops.select("fund_book_daily", order_by=["day"])
    assert [(r["day"], r["pnl_usd"], r["updated"]) for r in rows] == [("2026-10-01", 100.0, 2), ("2026-10-02", -20.25, 3)]
    assert ops.count("fund_book_daily") == 2
    for bad in ("2026-1-2", "20261002", "2026-13-01", "2026-10-32", "2026-10-02T00:00"):
        with pytest.raises(CheckViolation):
            ops.insert("fund_book_daily", {"day": bad, "pnl_usd": 0.0, "updated": 0})
