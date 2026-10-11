"""fund_db.ops against a real migrated database: every named function does what its docstring says."""
from __future__ import annotations

import pytest

from fund_db import ops
from fund_db.db import connect, transaction


def test_the_generic_layer_refuses_names_not_in_the_registry(db):
    with pytest.raises(ValueError, match="no ops table"):
        ops.select("nope")
    with pytest.raises(ValueError, match="has no column"):
        ops.select("events", {"summary; drop table ops.events": 1})
    with pytest.raises(ValueError, match="has no column"):
        ops.select("events", order_by="-ts; --")
    with pytest.raises(ValueError, match="required column"):
        ops.insert("events", {"kind": "x"})
    with pytest.raises(ValueError, match="generated"):
        ops.insert("messages", {"conversation_id": "c", "role": "user", "ts": 1, "text": "t", "tsv": "x"})
    assert ops.count("events") == 0


def test_events_newest_first_with_filters(db):
    a = ops.log_event("job", "one", agent="app", payload={"n": 1}, ts=1000)
    b = ops.log_event("turn", "two", agent="fund", conversation="c1", ts=2000)
    ops.log_event("job", "three", agent="app", ts=3000)
    assert b > a
    rows = ops.list_events()
    assert [r["summary"] for r in rows] == ["three", "two", "one"]
    assert rows[2]["payload_json"] == {"n": 1}
    assert [r["summary"] for r in ops.list_events(kinds=["job"], since=1500)] == ["three"]
    assert [r["summary"] for r in ops.list_events(conversation="c1")] == ["two"]
    assert [r["summary"] for r in ops.list_events(limit=1, agent="app")] == ["three"]


def test_conversation_lifecycle_usage_and_forget(db):
    c = ops.create_conversation("c1", "app", title="t", transcript_uuid="u1", cwd="C:/dev", started_at=5)
    assert (c["started_at"], c["last_at"], c["forgotten"], c["indexed"], c["cost_usd"]) == (5, 5, False, False, 0.0)
    ops.create_conversation("c2", "fund", started_at=6)
    ops.add_usage("c1", "app", tokens_in=10, tokens_out=3, cache_read=2, cache_write=1, cost_usd=0.25, model="m", ts=7)
    ops.add_usage("c1", "app", tokens_in=5, cost_usd=0.5, ts=8)
    got = ops.get_conversation("c1")
    assert (got["tokens_in"], got["tokens_out"], got["cost_usd"]) == (15, 3, 0.75)
    assert [u["ts"] for u in ops.list_usage(since=8)] == [8]
    ops.update_conversation("c1", state="live", last_at=100, model="opus", indexed=1)
    assert ops.get_conversation("c1")["indexed"] is True
    assert [r["id"] for r in ops.list_conversations()] == ["c1", "c2"]
    assert ops.conversation_by_transcript("u1")["id"] == "c1"
    assert ops.known_transcripts() == {"u1"}
    assert ops.close_open_conversations() == 2          # c1 live, c2 idle
    ops.forget_conversation("c2")
    assert ops.get_conversation("c2") is None
    assert ops.get_conversation("c2", include_forgotten=True)["forgotten"] is True
    assert [r["id"] for r in ops.list_conversations(include_forgotten=True)] == ["c1", "c2"]
    assert [r["id"] for r in ops.list_conversations()] == ["c1"]


def test_usage_rolls_back_with_the_conversation_bump(db):
    ops.create_conversation("c1", "app", started_at=1)
    with pytest.raises(Exception):
        with transaction() as c:
            ops.add_usage("c1", "app", tokens_in=10, conn=c)
            raise RuntimeError("abort")
    assert ops.get_conversation("c1")["tokens_in"] == 0 and ops.count("usage") == 0


def test_message_search_replace_and_previews(db):
    ops.index_message("c1", "user", "the funding rate on venue_a flipped negative", ts=1)
    ops.index_message("c1", "assistant", "yes, the premium index fell", ts=2)
    ops.index_message("c2", "user", "venue_g index returns", ts=3)
    hits = ops.search_messages("funding venue_a")
    assert [h["conversation_id"] for h in hits] == ["c1"] and "funding" in hits[0]["snippet"]
    assert ops.search_messages('"premium index"')[0]["conversation_id"] == "c1"
    assert ops.search_messages("   ") == []
    assert ops.last_messages(["c1", "c2", "c3"]) == {"c1": "yes, the premium index fell", "c2": "venue_g index returns"}
    assert ops.replace_messages("c1", [{"role": "user", "text": "only this now", "ts": 9}]) == 1
    assert ops.search_messages("venue_a") == []
    long = "x" * 25_000
    ops.index_message("c3", "user", long, ts=1)
    assert len(ops.last_messages(["c3"])["c3"]) == ops.MESSAGE_MAX_CHARS


def test_presence_keeps_since_on_heartbeat_and_clears_by_prefix(db):
    ops.set_presence("chat:c1", "app", "c1", "reading", pid=1, ts=100)
    ops.set_presence("chat:c1", "app", "c1", "writing", pid=1, ts=200)
    ops.set_presence("job:x", "fund", ts=150)
    p = ops.get("presence", "chat:c1")
    assert (p["since"], p["heartbeat_at"], p["doing"]) == (100, 200, "writing")
    assert [r["hand_id"] for r in ops.list_presence(fresh_since=160)] == ["chat:c1"]
    assert ops.clear_presence_prefix("chat:") == 1
    assert ops.clear_presence("job:x") == 1 and ops.list_presence() == []


def test_health_latest_history_and_prune_keeps_the_newest(db):
    for ts, st in ((1, "ok"), (2, "fail"), (3, "warn")):
        ops.record_health("venue:venue_a", "venue", st, reading=st, detail={"ts": ts}, ts=ts)
    ops.record_health("dash:x/port", "dashboard", "ok", ts=1)
    latest = {r["probe_id"]: r for r in ops.latest_health()}
    assert latest["venue:venue_a"]["status"] == "warn" and latest["venue:venue_a"]["detail_json"] == {"ts": 3}
    assert [r["probe_id"] for r in ops.latest_health(target="dashboard")] == ["dash:x/port"]
    assert [r["ts"] for r in ops.health_history("venue:venue_a", since=2)] == [3, 2]
    assert ops.prune_health(before=10) == 2              # both old venue_a rows; each probe's newest stays
    assert sorted(r["ts"] for r in ops.select("health_readings")) == [1, 3]


def test_job_runs_mirror_the_scheduler_queries(db):
    r1 = ops.start_job_run("nightly", due_at=100, started_at=110)
    ops.finish_job_run(r1, "ok", 0, "fine", ended_at=120)
    ops.add_job_run("nightly", "skipped", due_at=200, ended_at=200)
    ops.add_job_run("probe", "missed", due_at=150)
    r2 = ops.start_job_run("probe", due_at=300, trigger="manual", started_at=310)
    ops.update_job_run(r2, pid=4242)
    assert [r["id"] for r in ops.running_job_runs()] == [r2]
    latest = ops.latest_job_run_per_job()
    assert latest["nightly"]["status"] == "ok"            # a skip never hides the last real run
    assert latest["probe"]["id"] == r2
    assert ops.last_started_job_run("probe")["pid"] == 4242
    assert ops.last_due_per_job() == {"nightly": 200, "probe": 300}
    ops.finish_job_run(r2, "unknown", 2, "exit 2", conversation_id="c9", ended_at=320)
    assert ops.get_job_run(r2)["conversation_id"] == "c9"
    ops.finish_job_run(r2, "unknown", 2, "again", ended_at=321)
    assert ops.get_job_run(r2)["conversation_id"] == "c9"  # COALESCE: not wiped by a None
    t = ops.job_run_tally(since=0)
    assert (t["ran"], t["ok"], t["unknown"], t["skipped"], t["running"]) == (2, 1, 1, 1, 0)
    assert [r["status"] for r in ops.list_job_runs("nightly", limit=5)] == ["skipped", "ok"]   # by COALESCE(started, ended, due)
    assert len(ops.list_job_runs(limit=10)) == 4


def test_processes_reads_commits(db):
    p = ops.add_process("dash:terminal", "prod", "python -m x", pid=9, port=8710, started_at=1)
    assert [r["id"] for r in ops.open_processes()] == [p]
    ops.close_process(p, 0, stopped_at=2)
    assert ops.open_processes() == [] and ops.list_processes("dash:terminal")[0]["exit_code"] == 0
    ops.record_read("app", "library/a.md", at_boot=True, ts=1)
    ops.record_read("app", "library/b.md", ts=2)
    assert [r["book_path"] for r in ops.list_reads(agent="app", pulls_only=True)] == ["library/b.md"]
    ops.upsert_commit({"repo": "fund", "sha": "abc", "ts": 5, "subject": "one", "files_json": ["a.md"], "author": "app"})
    ops.upsert_commit({"repo": "fund", "sha": "abc", "ts": 5, "subject": "one (re-indexed)", "shrink_json": {"ok": True}})
    c = ops.get_commit("fund", "abc")
    assert (c["subject"], c["files_json"], c["shrink_json"]) == ("one (re-indexed)", ["a.md"], {"ok": True})
    assert [r["sha"] for r in ops.list_commits(repo="fund", since=5)] == ["abc"]


def test_loop_metrics_lessons_passes_grades_review(db):
    ops.set_metric("2026-09-24", "app", "turns", 3)
    ops.set_metric("2026-09-24", "app", "turns", 4)
    ops.set_metric("2026-09-25", "app", "turns", 1)
    assert [(r["day"], r["value"]) for r in ops.list_metrics(since_day="2026-09-24")] == [("2026-09-24", 4.0), ("2026-09-25", 1.0)]
    lid = ops.add_lesson("app", "pull before push", read_when="about to push", ts=1)
    ops.set_lesson_state(lid, "promoted", "L-001")
    assert ops.list_lessons(state="promoted")[0]["proposal"] == "L-001"
    ops.add_loop_pass("owner", True, "ok", detail={"n": 2}, ts=1)
    assert ops.list_loop_passes()[0]["ok"] is True
    ops.upsert_turn_grade({"conversation_id": "c1", "turn_ix": 0, "ts": 10, "source": "check", "key": "nodash", "value": 1})
    ops.upsert_turn_grade({"conversation_id": "c1", "turn_ix": 0, "ts": 10, "source": "check", "key": "nodash", "value": 0,
                           "label": "[1,2]"})
    g = ops.list_turn_grades("c1")
    assert len(g) == 1 and g[0]["value"] == 0 and g[0]["graded_at"] > 0
    ops.upsert_review({"conversation_id": "c1", "turn_ix": 0, "reason": "failed", "ts": 10, "spans_json": [{"check": "nodash"}]})
    ops.set_review_state("c1", 0, "failed", "done")
    ops.upsert_review({"conversation_id": "c1", "turn_ix": 0, "reason": "failed", "state": "open", "excerpt": "again"})
    r = ops.list_review(state=None)[0]
    assert (r["state"], r["excerpt"], r["spans_json"]) == ("done", "again", [{"check": "nodash"}])   # a re-queue never reopens


def test_board_attest_suggestions_and_scan(db):
    ops.attest_board("B-0001", "fp1", "ui", ts=1)
    ops.attest_board("B-0001", "fp2", "ui", ts=2)
    assert ops.get_board_attest("B-0001")["fp"] == "fp2"
    assert ops.drop_board_attest("B-0001") == 1
    base = {"source": "scan", "kind": "todo", "path": "a.md", "ref": "a.md:1", "quote": "q", "title": "t"}
    assert ops.sync_board_suggestions([{**base, "fp": "x"}, {**base, "fp": "y"}], ts=100) == 2
    ops.sync_board_suggestions([{**base, "fp": "y", "title": "t2"}, {**base, "fp": "z"}], ts=200)
    rows = {r["fp"]: r for r in ops.list_board_suggestions()}
    assert set(rows) == {"y", "z"}
    assert (rows["y"]["first_seen"], rows["y"]["last_seen"], rows["y"]["title"]) == (100, 200, "t2")
    ops.mark_suggestion_done("x", "dismissed", ts=5)
    assert ops.list_suggestions_done()[0]["fp"] == "x"
    ops.set_board_scan({"ts": 1, "files": 2, "visited": 3, "capped": 0, "errors_json": [], "ms": 4, "found": 2})
    ops.set_board_scan({"ts": 2, "files": 2, "visited": 3, "capped": True, "errors_json": ["e"], "ms": 4, "found": 2})
    s = ops.get_board_scan()
    assert (s["id"], s["ts"], s["capped"], s["errors_json"]) == (1, 2, True, ["e"]) and ops.count("board_scan") == 1


def test_alerts_rules_log_once_spend_keep_and_passes(db):
    ops.save_alert_rule({"id": "r1", "condition": "funding_gt", "params_json": {"x": 1}, "subject": "venue_a:BTCUSDT",
                         "mode": "bar", "bar": "1h", "created": 10})
    ops.save_alert_rule({"id": "r1", "condition": "funding_gt", "params_json": {"x": 2}, "subject": "venue_a:BTCUSDT",
                         "mode": "bar", "bar": "1h", "enabled": 0})
    r = ops.get_alert_rule("r1")
    assert (r["params_json"], r["enabled"], r["armed"], r["created"]) == ({"x": 2}, False, True, 10)
    ops.mark_alert_fired("r1", ts=99)
    assert ops.list_alert_rules()[0]["last_fired"] == 99
    assert ops.log_alert("r1", "venue_a:BTCUSDT", 3600, "ok", "board", value=0.1, at=1) is True
    assert ops.log_alert("r1", "venue_a:BTCUSDT", 3600, "ok", "board", value=0.2, at=2) is False
    assert len(ops.list_alert_log(rule="r1")) == 1
    for i in range(25):
        ops.add_spend_alert("app", 100 + i, 10.0, 5.0, ts=i)
    kept = ops.list_spend_alerts(limit=100)
    assert len(kept) == 20 and kept[0]["ts"] == 24 and kept[-1]["ts"] == 5
    ops.add_alert_pass(3600, "1h", 1, 2, at=5, forced=1)
    assert ops.list_alert_passes(since=0)[0]["forced"] is True
    assert ops.delete_alert_rule("r1") == 1


def test_library_drafts_scans_marks(db):
    row = {"conv": "c1", "agent": "app", "shelf": "craft", "path": "library/x.md", "book": "b", "series_row": "| x | y |",
           "quote": "q", "key": "k1"}
    d = ops.add_library_draft(row)
    assert isinstance(d, int) and ops.add_library_draft(row) is None      # one draft per correction
    ops.update_library_draft(d, state="saved", sha="abc")
    got = ops.list_library_drafts(state="saved")[0]
    assert got["sha"] == "abc" and got["updated"] is not None
    ops.set_draft_scan("c1", 50, found=1, cost_usd=0.01)
    assert ops.get_draft_scan("c1")["found"] == 1
    ops.set_book_mark("library/old.md", boot=["app"], note="cold")
    assert ops.get_book_mark("library/old.md")["boot_json"] == ["app"]
    assert [m["path"] for m in ops.list_book_marks("cold")] == ["library/old.md"]
    assert ops.drop_book_mark("library/old.md") == 1


def test_comparators_are_append_only_and_latest_per_id(db):
    s1 = ops.add_comparator_snapshot("btc", "ok", {"points": [[1, 2.5]]}, "api.data.btc", ts=1)
    s2 = ops.add_comparator_snapshot("btc", "ok", {"points": [[2, 3.5]]}, "api.data.btc", read_at="2026-09-25", ts=2)
    ops.add_comparator_snapshot("tbill", "unknown", {"reason": "x"}, "api.data.tbill", ts=1)
    assert s2 > s1
    latest = ops.latest_comparator_snapshots()
    assert latest["btc"]["series"] == {"points": [[2, 3.5]]} and latest["tbill"]["status"] == "unknown"
    assert [r["seq"] for r in ops.comparator_history("btc")] == [s2, s1]


def test_chat_prompts_and_verify(db):
    p = ops.create_prompt("body", title="T", tags=["B", "a", "a"], ts=1)
    assert p["tags"] == ["a", "b"] and p["created"] == 1
    ops.update_prompt(p["id"], tags=["Z"], title="T2")
    got = ops.list_prompts()[0]
    assert (got["tags"], got["title"]) == (["z"], "T2") and got["updated"] > 1
    assert ops.delete_prompt(p["id"]) == 1
    ops.set_chat_verify("app", 0, "ok", 1200, "fp", ts=1)
    ops.set_chat_verify("app", 1, "red", 1300, "fp2", timed_out=True, ts=2)
    v = ops.get_chat_verify("app")
    assert (v["code"], v["timed_out"], v["fingerprint"]) == (1, True, "fp2") and len(ops.list_chat_verify()) == 1


def test_law_loads(db):
    ops.add_law_load({"conversation_id": "c1", "agent_id": "app", "file_path": "CLAUDE.md", "load_reason": "boot", "ts": 2})
    ops.add_law_load({"conversation_id": "c1", "agent_id": "app", "file_path": "", "load_reason": "compact_boundary", "ts": 1})
    assert [r["load_reason"] for r in ops.list_law_loads("c1")] == ["compact_boundary", "boot"]


def test_explicit_conn_is_honoured(db):
    with connect(db) as c:
        ops.log_event("x", "inside", conn=c)
        c.rollback()
    assert ops.count("events") == 0
