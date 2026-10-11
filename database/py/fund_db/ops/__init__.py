"""fund_db.ops - typed functions over the ops store (schema `ops` in PostgreSQL): what the cockpit
kept in cockpit.db, and later orders/fills/positions/signals. Mirrored name for name in
@fund/db (node/src/ops.ts; snake_case here, camelCase there), and tests/test_contract.py fails
when the two lists differ.

Conventions, both languages:
* times are int epoch MILLISECONDS; a `ts=None` argument means now
* every function takes `conn=` (a psycopg connection, e.g. from fund_db.db.transaction()); without
  one it runs on the thread's shared autocommit connection
* rows are dicts shaped like the TypedDicts in fund_db.ops.rows (jsonb as Python objects, flags as bool)
* the generic layer (insert/upsert/get/select/update/delete/count) is exported too, for a table
  that has no named function yet; it validates every name against the generated registry
"""
from __future__ import annotations

from typing import Any, Iterable

from psycopg import sql

from ..db import shared as _shared, transaction
from .rows import TABLES
from .table import adapt as _adapt, check_cols as _check_cols, ident as _ident, readable as _readable
from .table import count, delete, get, insert, now_ms, select, update, upsert

__all__ = [
    # generic + the registry
    "TABLES", "MESSAGE_MAX_CHARS",
    "insert", "upsert", "get", "select", "update", "delete", "count", "now_ms", "transaction",
    # events
    "log_event", "list_events",
    # conversations + usage + messages + presence
    "create_conversation", "get_conversation", "conversation_by_transcript", "list_conversations",
    "update_conversation", "forget_conversation", "close_open_conversations", "known_transcripts",
    "add_usage", "list_usage",
    "index_message", "replace_messages", "search_messages", "last_messages",
    "set_presence", "clear_presence", "clear_presence_prefix", "list_presence",
    # health
    "record_health", "latest_health", "health_history", "prune_health",
    # scheduler
    "start_job_run", "add_job_run", "finish_job_run", "update_job_run", "get_job_run", "list_job_runs",
    "running_job_runs", "latest_job_run_per_job", "last_started_job_run", "last_due_per_job", "job_run_tally",
    # processes
    "add_process", "close_process", "list_processes", "open_processes",
    # library reads + commits
    "record_read", "list_reads", "upsert_commit", "get_commit", "list_commits",
    # loop
    "set_metric", "list_metrics", "add_lesson", "list_lessons", "set_lesson_state", "add_loop_pass", "list_loop_passes",
    "upsert_turn_grade", "list_turn_grades", "upsert_review", "list_review", "set_review_state",
    # law loads
    "add_law_load", "list_law_loads",
    # board
    "attest_board", "get_board_attest", "drop_board_attest", "sync_board_suggestions", "list_board_suggestions",
    "mark_suggestion_done", "list_suggestions_done", "set_board_scan", "get_board_scan",
    # alerts
    "add_spend_alert", "list_spend_alerts", "save_alert_rule", "get_alert_rule", "list_alert_rules",
    "delete_alert_rule", "mark_alert_fired", "log_alert", "list_alert_log", "add_alert_pass", "list_alert_passes",
    # library drafts + marks
    "add_library_draft", "list_library_drafts", "update_library_draft", "set_draft_scan", "get_draft_scan",
    "set_book_mark", "get_book_mark", "list_book_marks", "drop_book_mark",
    # lab comparators
    "add_comparator_snapshot", "latest_comparator_snapshots", "comparator_history",
    # chat prompts + verify
    "create_prompt", "update_prompt", "delete_prompt", "list_prompts", "set_chat_verify", "get_chat_verify", "list_chat_verify",
    # read models the cockpit asks for
    "events_in_window", "turn_events", "turn_window_events", "last_event_ts", "reverted_conversations",
    "error_counts_by_conversation", "touch_conversation", "next_unindexed_conversation", "conversation_counts",
    "list_conversation_ids", "conversations_due_for_draft_scan", "prefix_words", "search_messages_prefix", "assistant_text",
    "heartbeat_presence", "record_read_once", "count_reads_by_book", "books_read_in_conversation", "pull_ledger_span",
    "pulled_books", "read_stats_by_book", "pullers_by_book", "pulls_by_agent", "list_pulls", "conversations_with_pulls",
    "commit_subjects", "commit_files", "known_commits", "commit_shrinks", "lessons_since", "clear_metrics",
    "metrics_between", "usage_in_window", "grades_in_window", "graded_turns", "list_review_all", "set_review_state_all",
    "clear_owner_grade", "list_board_attest", "list_open_board_suggestions", "alert_log_keys", "alert_delivered_counts",
    "prune_alert_passes", "first_alert_pass", "bump_draft_scan", "library_draft_exists", "library_draft_tally",
    "conversation_has_undrafted_lesson", "close_process_once", "health_readings_since", "health_probes_seen",
    "last_health_ts", "health_between", "health_before", "job_runs_in_window", "job_run_span", "usage_by_day",
    "billable_on_day", "billable_rows", "billable_by_agent", "last_spend_alerts",
    # platform logs (migration ops/002)
    "add_data_audit", "list_data_audit", "add_wire_changes", "list_wire_changes", "count_wire_changes",
    "set_wire_snapshot", "latest_wire_snapshot", "wire_snapshot_heads", "get_wire_state", "set_wire_state",
    "add_no_lesson", "list_no_lesson",
]


def _c(conn):
    return conn or _shared()


def _q(conn, query, args=()):
    return _c(conn).execute(query, args)


def _cols(table: str) -> sql.Composable:
    return _readable(table)


# ------------------------------------------------------------------------------------------ events


def log_event(kind: str, summary: str, agent: str | None = None, conversation: str | None = None,
              payload: Any = None, ts: int | None = None, *, conn=None) -> int:
    """Append one row to the activity feed; returns its id."""
    return insert("events", {"ts": (now_ms() if ts is None else ts), "kind": kind, "summary": summary, "agent_id": agent,
                             "conversation_id": conversation, "payload_json": payload}, conn=conn)["id"]


def list_events(limit: int = 200, agent: str | None = None, kinds: Iterable[str] | None = None,
                since: int | None = None, conversation: str | None = None, *, conn=None) -> list[dict]:
    """Newest first."""
    w, a = [], []
    if agent is not None:
        w.append(sql.SQL("agent_id = %s")); a.append(agent)
    if kinds:
        w.append(sql.SQL("kind = ANY(%s)")); a.append(list(kinds))
    if since is not None:
        w.append(sql.SQL("ts >= %s")); a.append(since)
    if conversation is not None:
        w.append(sql.SQL("conversation_id = %s")); a.append(conversation)
    q = sql.SQL("SELECT {} FROM {}").format(_cols("events"), _ident("events"))
    if w:
        q += sql.SQL(" WHERE ") + sql.SQL(" AND ").join(w)
    q += sql.SQL(" ORDER BY ts DESC, id DESC LIMIT %s")
    return _q(conn, q, a + [int(limit)]).fetchall()


# ----------------------------------------------------------------------------------- conversations


def create_conversation(id: str, agent_id: str, *, title: str = "", transcript_uuid: str | None = None,
                        state: str = "idle", cwd: str | None = None, started_at: int | None = None,
                        model: str | None = None, effort: str | None = None, conn=None) -> dict:
    t = (now_ms() if started_at is None else started_at)
    return insert("conversations", {"id": id, "agent_id": agent_id, "title": title, "transcript_uuid": transcript_uuid,
                                    "state": state, "cwd": cwd, "started_at": t, "last_at": t,
                                    "model": model, "effort": effort}, conn=conn)


def get_conversation(id: str, include_forgotten: bool = False, *, conn=None) -> dict | None:
    r = get("conversations", id, conn=conn)
    return r if r and (include_forgotten or not r["forgotten"]) else None


def conversation_by_transcript(transcript_uuid: str, *, conn=None) -> dict | None:
    rows = select("conversations", {"transcript_uuid": transcript_uuid}, limit=1, conn=conn)
    return rows[0] if rows else None


def list_conversations(agent: str | None = None, limit: int = 200, include_forgotten: bool = False,
                       since: int | None = None, *, conn=None) -> list[dict]:
    """Newest activity first."""
    w, a = [], []
    if agent is not None:
        w.append(sql.SQL("agent_id = %s")); a.append(agent)
    if not include_forgotten:
        w.append(sql.SQL("NOT forgotten"))
    if since is not None:
        w.append(sql.SQL("last_at >= %s")); a.append(since)
    q = sql.SQL("SELECT {} FROM {}").format(_cols("conversations"), _ident("conversations"))
    if w:
        q += sql.SQL(" WHERE ") + sql.SQL(" AND ").join(w)
    q += sql.SQL(" ORDER BY last_at DESC LIMIT %s")
    return _q(conn, q, a + [int(limit)]).fetchall()


def update_conversation(id: str, *, conn=None, **fields) -> dict | None:
    """Set any conversation columns (title, state, transcript_uuid, last_at, model, effort, indexed, ...)."""
    return update("conversations", id, fields, conn=conn)


def forget_conversation(id: str, *, conn=None) -> dict | None:
    return update("conversations", id, {"forgotten": True, "state": "closed"}, conn=conn)


def close_open_conversations(*, conn=None) -> int:
    """At daemon start: nothing is live any more. Returns how many rows changed."""
    return _q(conn, "UPDATE ops.conversations SET state = 'closed' WHERE state <> 'closed'").rowcount


def known_transcripts(*, conn=None) -> set[str]:
    return {r["u"] for r in _q(conn, "SELECT transcript_uuid AS u FROM ops.conversations WHERE transcript_uuid IS NOT NULL").fetchall()}


def add_usage(conversation_id: str | None, agent_id: str, *, tokens_in: int = 0, tokens_out: int = 0, cache_read: int = 0,
              cache_write: int = 0, cost_usd: float = 0.0, model: str | None = None, ts: int | None = None, conn=None) -> int:
    """One usage row, and the conversation's running totals bumped in the same transaction."""
    with transaction(conn) as c:
        rid = insert("usage", {"ts": (now_ms() if ts is None else ts), "agent_id": agent_id, "conversation_id": conversation_id, "model": model,
                               "tokens_in": tokens_in, "tokens_out": tokens_out, "cache_read": cache_read,
                               "cache_write": cache_write, "cost_usd": cost_usd}, conn=c)["id"]
        if conversation_id is not None:
            c.execute("UPDATE ops.conversations SET tokens_in = tokens_in + %s, tokens_out = tokens_out + %s, "
                      "cost_usd = cost_usd + %s WHERE id = %s", (tokens_in, tokens_out, cost_usd, conversation_id))
    return rid


def list_usage(since: int | None = None, agent: str | None = None, *, conn=None) -> list[dict]:
    """Oldest first."""
    w, a = [sql.SQL("ts >= %s")], [since or 0]
    if agent is not None:
        w.append(sql.SQL("agent_id = %s")); a.append(agent)
    q = sql.SQL("SELECT {} FROM ops.usage WHERE ").format(_cols("usage")) + sql.SQL(" AND ").join(w)
    return _q(conn, q + sql.SQL(" ORDER BY ts, id"), a).fetchall()


# ---------------------------------------------------------------------------------------- messages

MESSAGE_MAX_CHARS = 20_000


def index_message(conversation_id: str, role: str, text: str, ts: int | None = None, *, conn=None) -> int:
    """Index one message for search (text clipped to 20,000 chars, as the cockpit always did)."""
    return insert("messages", {"conversation_id": conversation_id, "role": role, "ts": (now_ms() if ts is None else ts),
                               "text": text[:MESSAGE_MAX_CHARS]}, conn=conn)["id"]


def replace_messages(conversation_id: str, messages: Iterable[dict], *, conn=None) -> int:
    """Re-index a whole conversation atomically: [{role, text, ts}] replaces what was there."""
    n = 0
    with transaction(conn) as c:
        c.execute("DELETE FROM ops.messages WHERE conversation_id = %s", (conversation_id,))
        for m in messages:
            index_message(conversation_id, m["role"], m["text"], m.get("ts"), conn=c)
            n += 1
    return n


def search_messages(query: str, limit: int = 400, *, conn=None) -> list[dict]:
    """Full-text search over every indexed message: [{conversation_id, snippet, rank}], best first.
    `query` is web-search syntax ("quoted phrase", -not, or); an empty query returns []."""
    if not query.strip():
        return []
    return _q(conn,
              "SELECT conversation_id, ts_headline('simple', text, q, 'MaxWords=10, MinWords=4, StartSel=\"\", StopSel=\"\", "
              "FragmentDelimiter=\"...\"') AS snippet, ts_rank(tsv, q) AS rank "
              "FROM ops.messages, websearch_to_tsquery('simple', %s) q WHERE tsv @@ q ORDER BY rank DESC, ts DESC LIMIT %s",
              (query, int(limit))).fetchall()


def last_messages(conversation_ids: Iterable[str], *, conn=None) -> dict[str, str]:
    """Each conversation's newest indexed message text; a conversation with none is absent."""
    ids = list(conversation_ids)
    if not ids:
        return {}
    rows = _q(conn, "SELECT DISTINCT ON (conversation_id) conversation_id, text FROM ops.messages "
                    "WHERE conversation_id = ANY(%s) ORDER BY conversation_id, ts DESC, id DESC", (ids,)).fetchall()
    return {r["conversation_id"]: r["text"] for r in rows}


# ---------------------------------------------------------------------------------------- presence


def set_presence(hand_id: str, agent_id: str, conversation_id: str | None = None, doing: str | None = None,
                 pid: int | None = None, ts: int | None = None, *, conn=None) -> dict:
    """Heartbeat a hand: a new hand gets since = now; an existing one keeps its since."""
    t = (now_ms() if ts is None else ts)
    return upsert("presence", {"hand_id": hand_id, "agent_id": agent_id, "conversation_id": conversation_id, "doing": doing,
                               "since": t, "heartbeat_at": t, "pid": pid}, update=["doing", "heartbeat_at"], conn=conn)


def clear_presence(hand_id: str, *, conn=None) -> int:
    return delete("presence", hand_id, conn=conn)


def clear_presence_prefix(prefix: str, *, conn=None) -> int:
    """Drop every hand whose id starts with `prefix` (e.g. 'chat:' at daemon start)."""
    return _q(conn, "DELETE FROM ops.presence WHERE left(hand_id, %s) = %s", (len(prefix), prefix)).rowcount


def list_presence(fresh_since: int | None = None, *, conn=None) -> list[dict]:
    rows = select("presence", order_by="-heartbeat_at", conn=conn)
    return [r for r in rows if fresh_since is None or r["heartbeat_at"] >= fresh_since]


# ------------------------------------------------------------------------------------------ health


def record_health(probe_id: str, target: str, status: str, reading: str | None = None, detail: Any = None,
                  ts: int | None = None, *, conn=None) -> int:
    return insert("health_readings", {"ts": (now_ms() if ts is None else ts), "probe_id": probe_id, "target": target, "status": status,
                                       "reading": reading, "detail_json": detail}, conn=conn)["id"]


def latest_health(target: str | None = None, *, conn=None) -> list[dict]:
    """The newest reading of every probe (optionally one target kind), ordered by probe_id."""
    q = sql.SQL("SELECT DISTINCT ON (probe_id) {} FROM ops.health_readings").format(_cols("health_readings"))
    args: list = []
    if target is not None:
        q += sql.SQL(" WHERE target = %s")
        args.append(target)
    return _q(conn, q + sql.SQL(" ORDER BY probe_id, ts DESC, id DESC"), args).fetchall()


def health_history(probe_id: str, since: int | None = None, limit: int = 500, *, conn=None) -> list[dict]:
    """Newest first."""
    return _q(conn, sql.SQL("SELECT {} FROM ops.health_readings WHERE probe_id = %s AND ts >= %s ORDER BY ts DESC, id DESC LIMIT %s")
              .format(_cols("health_readings")), (probe_id, since or 0, int(limit))).fetchall()


def prune_health(before: int, keep_latest: bool = True, *, conn=None) -> int:
    """Delete readings older than `before` (ms), always keeping each probe's newest one."""
    if keep_latest:
        return _q(conn, "DELETE FROM ops.health_readings h WHERE ts < %s AND id <> (SELECT x.id FROM ops.health_readings x "
                        "WHERE x.probe_id = h.probe_id ORDER BY x.ts DESC, x.id DESC LIMIT 1)", (before,)).rowcount
    return _q(conn, "DELETE FROM ops.health_readings WHERE ts < %s", (before,)).rowcount


# --------------------------------------------------------------------------------------- scheduler


def start_job_run(job_id: str, due_at: int | None, trigger: str = "schedule", started_at: int | None = None, *, conn=None) -> int:
    """A job starting now: a 'running' row. Returns its id."""
    return insert("job_runs", {"job_id": job_id, "due_at": due_at, "started_at": (now_ms() if started_at is None else started_at),
                               "status": "running", "trigger": trigger}, conn=conn)["id"]


def add_job_run(job_id: str, status: str, *, due_at: int | None = None, started_at: int | None = None,
                ended_at: int | None = None, detail: str | None = None, trigger: str = "schedule", conn=None) -> int:
    """A row that is not a start: missed / skipped decisions. Returns its id."""
    return insert("job_runs", {"job_id": job_id, "status": status, "due_at": due_at, "started_at": started_at,
                               "ended_at": ended_at, "detail": detail, "trigger": trigger}, conn=conn)["id"]


def finish_job_run(id: int, status: str, exit_code: int | None = None, detail: str | None = None,
                   conversation_id: str | None = None, ended_at: int | None = None, *, conn=None) -> dict | None:
    """Close a run; conversation_id only overwrites when given."""
    return _q(conn, sql.SQL("UPDATE ops.job_runs SET status = %s, exit_code = %s, ended_at = %s, detail = %s, "
                            "conversation_id = COALESCE(%s, conversation_id) WHERE id = %s RETURNING {}").format(_cols("job_runs")),
              (status, exit_code, (now_ms() if ended_at is None else ended_at), detail, conversation_id, id)).fetchone()


def update_job_run(id: int, *, conn=None, **fields) -> dict | None:
    return update("job_runs", id, fields, conn=conn)


def get_job_run(id: int, *, conn=None) -> dict | None:
    return get("job_runs", id, conn=conn)


def list_job_runs(job_id: str | None = None, limit: int = 50, *, conn=None) -> list[dict]:
    """Newest first by COALESCE(started_at, ended_at, due_at)."""
    q = sql.SQL("SELECT {} FROM ops.job_runs {} ORDER BY COALESCE(started_at, ended_at, due_at) DESC NULLS LAST, id DESC LIMIT %s")
    if job_id is None:
        return _q(conn, q.format(_cols("job_runs"), sql.SQL("")), (int(limit),)).fetchall()
    return _q(conn, q.format(_cols("job_runs"), sql.SQL("WHERE job_id = %s")), (job_id, int(limit))).fetchall()


def running_job_runs(*, conn=None) -> list[dict]:
    return select("job_runs", {"status": "running"}, order_by="id", conn=conn)


def latest_job_run_per_job(*, conn=None) -> dict[str, dict]:
    """The newest row per job that says something (not a skip), else the newest row at all."""
    rows = _q(conn, sql.SQL("SELECT DISTINCT ON (job_id) {} FROM ops.job_runs ORDER BY job_id, (status = 'skipped') ASC, "
                            "COALESCE(started_at, ended_at, due_at) DESC NULLS LAST, id DESC").format(_cols("job_runs"))).fetchall()
    return {r["job_id"]: r for r in rows}


def last_started_job_run(job_id: str, *, conn=None) -> dict | None:
    """The newest run of a job that actually STARTED (missed / skipped rows never started)."""
    return _q(conn, sql.SQL("SELECT {} FROM ops.job_runs WHERE job_id = %s AND started_at IS NOT NULL "
                            "ORDER BY started_at DESC, id DESC LIMIT 1").format(_cols("job_runs")), (job_id,)).fetchone()


def last_due_per_job(*, conn=None) -> dict[str, int]:
    return {r["job_id"]: r["d"] for r in _q(conn, "SELECT job_id, MAX(due_at) AS d FROM ops.job_runs "
                                                  "WHERE due_at IS NOT NULL GROUP BY job_id").fetchall()}


def job_run_tally(since: int, *, conn=None) -> dict[str, int]:
    """Counts by status of rows that ended (or started) at or after `since`, with ran = ok + fail + unknown."""
    c = {r["status"]: r["n"] for r in _q(conn, "SELECT status, count(*) AS n FROM ops.job_runs "
                                               "WHERE COALESCE(ended_at, started_at) >= %s GROUP BY status", (since,)).fetchall()}
    g = lambda k: c.get(k, 0)  # noqa: E731
    return {"ran": g("ok") + g("fail") + g("unknown"), "ok": g("ok"), "failed": g("fail"), "unknown": g("unknown"),
            "missed": g("missed"), "skipped": g("skipped"), "running": g("running")}


# --------------------------------------------------------------------------------------- processes


def add_process(dashboard_id: str, mode: str, cmd: str, pid: int | None = None, port: int | None = None,
                log_path: str | None = None, started_at: int | None = None, *, conn=None) -> int:
    return insert("processes", {"dashboard_id": dashboard_id, "mode": mode, "cmd": cmd, "pid": pid, "port": port,
                                "log_path": log_path, "started_at": (now_ms() if started_at is None else started_at)}, conn=conn)["id"]


def close_process(id: int, exit_code: int | None = None, stopped_at: int | None = None, *, conn=None) -> dict | None:
    return update("processes", id, {"exit_code": exit_code, "stopped_at": (now_ms() if stopped_at is None else stopped_at)}, conn=conn)


def list_processes(dashboard_id: str | None = None, limit: int = 50, *, conn=None) -> list[dict]:
    return select("processes", {"dashboard_id": dashboard_id} if dashboard_id else None, order_by=["-started_at", "-id"],
                  limit=limit, conn=conn)


def open_processes(*, conn=None) -> list[dict]:
    return select("processes", {"stopped_at": None}, order_by=["-started_at", "-id"], conn=conn)


# ---------------------------------------------------------------------------------- reads, commits


def record_read(agent_id: str, book_path: str, conversation_id: str | None = None, at_boot: bool = False,
                ts: int | None = None, *, conn=None) -> int:
    return insert("reads", {"ts": (now_ms() if ts is None else ts), "agent_id": agent_id, "conversation_id": conversation_id,
                            "book_path": book_path, "at_boot": at_boot}, conn=conn)["id"]


def list_reads(agent: str | None = None, book_path: str | None = None, since: int | None = None,
               pulls_only: bool = False, limit: int = 500, *, conn=None) -> list[dict]:
    """Newest first. pulls_only = books pulled beyond boot."""
    w, a = [], []
    if agent is not None:
        w.append(sql.SQL("agent_id = %s")); a.append(agent)
    if book_path is not None:
        w.append(sql.SQL("book_path = %s")); a.append(book_path)
    if since is not None:
        w.append(sql.SQL("ts >= %s")); a.append(since)
    if pulls_only:
        w.append(sql.SQL("NOT at_boot"))
    q = sql.SQL("SELECT {} FROM ops.reads").format(_cols("reads"))
    if w:
        q += sql.SQL(" WHERE ") + sql.SQL(" AND ").join(w)
    return _q(conn, q + sql.SQL(" ORDER BY ts DESC, id DESC LIMIT %s"), a + [int(limit)]).fetchall()


def upsert_commit(row: dict, *, conn=None) -> dict:
    """Index one commit keyed (repo, sha); a re-index updates the other columns."""
    return upsert("commits", row, conn=conn)


def get_commit(repo: str, sha: str, *, conn=None) -> dict | None:
    return get("commits", repo, sha, conn=conn)


def list_commits(repo: str | None = None, since: int | None = None, conversation_id: str | None = None,
                 limit: int = 200, *, conn=None) -> list[dict]:
    """Newest first."""
    w, a = [], []
    for col, v in (("repo", repo), ("conversation_id", conversation_id)):
        if v is not None:
            w.append(sql.SQL("{} = %s").format(sql.Identifier(col))); a.append(v)
    if since is not None:
        w.append(sql.SQL("ts >= %s")); a.append(since)
    q = sql.SQL("SELECT {} FROM ops.commits").format(_cols("commits"))
    if w:
        q += sql.SQL(" WHERE ") + sql.SQL(" AND ").join(w)
    return _q(conn, q + sql.SQL(" ORDER BY ts DESC, sha LIMIT %s"), a + [int(limit)]).fetchall()


# -------------------------------------------------------------------------------------------- loop


def set_metric(day: str, agent_id: str, metric: str, value: float, *, conn=None) -> dict:
    return upsert("loop_metrics", {"day": day, "agent_id": agent_id, "metric": metric, "value": value}, conn=conn)


def list_metrics(since_day: str | None = None, agent: str | None = None, metric: str | None = None, *, conn=None) -> list[dict]:
    """Oldest day first."""
    w, a = [sql.SQL("day >= %s")], [since_day or ""]
    for col, v in (("agent_id", agent), ("metric", metric)):
        if v is not None:
            w.append(sql.SQL("{} = %s").format(sql.Identifier(col))); a.append(v)
    q = sql.SQL("SELECT {} FROM ops.loop_metrics WHERE ").format(_cols("loop_metrics")) + sql.SQL(" AND ").join(w)
    return _q(conn, q + sql.SQL(" ORDER BY day, agent_id, metric"), a).fetchall()


def add_lesson(agent_id: str, text: str, *, conversation_id: str | None = None, scope: str = "agent",
               read_when: str | None = None, ts: int | None = None, conn=None) -> int:
    return insert("loop_lessons", {"ts": (now_ms() if ts is None else ts), "agent_id": agent_id, "conversation_id": conversation_id,
                                   "text": text, "scope": scope, "read_when": read_when}, conn=conn)["id"]


def list_lessons(state: str | None = None, agent: str | None = None, limit: int = 500, *, conn=None) -> list[dict]:
    w = {k: v for k, v in (("state", state), ("agent_id", agent)) if v is not None}
    return select("loop_lessons", w or None, order_by=["-ts", "-id"], limit=limit, conn=conn)


def set_lesson_state(id: int, state: str, proposal: str | None = None, *, conn=None) -> dict | None:
    f = {"state": state}
    if proposal is not None:
        f["proposal"] = proposal
    return update("loop_lessons", id, f, conn=conn)


def add_loop_pass(trigger: str, ok: bool, summary: str, detail: Any = None, ts: int | None = None, *, conn=None) -> int:
    return insert("loop_passes", {"ts": (now_ms() if ts is None else ts), "trigger": trigger, "ok": ok, "summary": summary,
                                  "detail_json": detail}, conn=conn)["id"]


def list_loop_passes(limit: int = 50, *, conn=None) -> list[dict]:
    return select("loop_passes", order_by=["-ts", "-id"], limit=limit, conn=conn)


def upsert_turn_grade(row: dict, *, conn=None) -> dict:
    """Keyed (conversation_id, turn_ix, source, key); graded_at defaults to now."""
    return upsert("turn_grades", {"graded_at": now_ms(), **row}, conn=conn)


def list_turn_grades(conversation_id: str | None = None, since: int | None = None, source: str | None = None,
                     *, conn=None) -> list[dict]:
    """Oldest turn first."""
    w, a = [sql.SQL("ts >= %s")], [since or 0]
    for col, v in (("conversation_id", conversation_id), ("source", source)):
        if v is not None:
            w.append(sql.SQL("{} = %s").format(sql.Identifier(col))); a.append(v)
    q = sql.SQL("SELECT {} FROM ops.turn_grades WHERE ").format(_cols("turn_grades")) + sql.SQL(" AND ").join(w)
    return _q(conn, q + sql.SQL(" ORDER BY ts, conversation_id, turn_ix, source, key"), a).fetchall()


def upsert_review(row: dict, *, conn=None) -> dict:
    """Keyed (conversation_id, turn_ix, reason). A re-queue never reopens a done item: state is
    written only on insert."""
    return upsert("review_queue", row, update=[c for c in row if c not in ("conversation_id", "turn_ix", "reason", "state")],
                  conn=conn)


def list_review(state: str | None = "open", limit: int = 200, *, conn=None) -> list[dict]:
    return select("review_queue", {"state": state} if state else None, order_by=["-ts", "conversation_id", "turn_ix"],
                  limit=limit, conn=conn)


def set_review_state(conversation_id: str, turn_ix: int, reason: str, state: str, *, conn=None) -> dict | None:
    return update("review_queue", (conversation_id, turn_ix, reason), {"state": state}, conn=conn)


# --------------------------------------------------------------------------------------- law loads


def add_law_load(row: dict, *, conn=None) -> int:
    """{conversation_id, agent_id, file_path, load_reason, ...}; ts defaults to now."""
    return insert("law_loads", {"ts": now_ms(), **row}, conn=conn)["id"]


def list_law_loads(conversation_id: str, *, conn=None) -> list[dict]:
    return select("law_loads", {"conversation_id": conversation_id}, order_by=["ts", "id"], conn=conn)


# ------------------------------------------------------------------------------------------- board


def attest_board(id: str, fp: str, via: str, ts: int | None = None, *, conn=None) -> dict:
    return upsert("board_attest", {"id": id, "fp": fp, "via": via, "ts": (now_ms() if ts is None else ts)}, conn=conn)


def get_board_attest(id: str, *, conn=None) -> dict | None:
    return get("board_attest", id, conn=conn)


def drop_board_attest(id: str, *, conn=None) -> int:
    return delete("board_attest", id, conn=conn)


def sync_board_suggestions(rows: Iterable[dict], ts: int | None = None, *, conn=None) -> int:
    """Make board_suggested exactly `rows` (one scan's findings), keeping first_seen for a fingerprint
    seen before and setting last_seen = ts. Atomic. Returns the row count."""
    t = (now_ms() if ts is None else ts)
    rows = list(rows)
    with transaction(conn) as c:
        keep = [r["fp"] for r in rows]
        c.execute("DELETE FROM ops.board_suggested WHERE NOT (fp = ANY(%s))", (keep,))
        for r in rows:
            upsert("board_suggested", {**r, "first_seen": r.get("first_seen", t), "last_seen": t},
                   update=[k for k in {**r, "last_seen": t} if k not in ("fp", "first_seen")], conn=c)
    return len(rows)


def list_board_suggestions(*, conn=None) -> list[dict]:
    return select("board_suggested", order_by=["-last_seen", "fp"], conn=conn)


def mark_suggestion_done(fp: str, state: str, item: str | None = None, title: str | None = None,
                         ts: int | None = None, *, conn=None) -> dict:
    return upsert("board_suggested_done", {"fp": fp, "state": state, "item": item, "title": title, "ts": (now_ms() if ts is None else ts)}, conn=conn)


def list_suggestions_done(*, conn=None) -> list[dict]:
    return select("board_suggested_done", order_by=["-ts", "fp"], conn=conn)


def set_board_scan(row: dict, *, conn=None) -> dict:
    """The one last-scan row (id is always 1)."""
    return upsert("board_scan", {**row, "id": 1}, conn=conn)


def get_board_scan(*, conn=None) -> dict | None:
    return get("board_scan", 1, conn=conn)


# ------------------------------------------------------------------------------------------ alerts


def add_spend_alert(agent: str, billable: int, median: float, multiple: float | None = None, ts: int | None = None,
                    keep: int = 20, *, conn=None) -> int:
    """One burn alert; only the newest `keep` rows are kept."""
    with transaction(conn) as c:
        rid = insert("spend_alerts", {"ts": (now_ms() if ts is None else ts), "agent": agent, "billable": billable, "median": median,
                                      "multiple": multiple}, conn=c)["id"]
        c.execute("DELETE FROM ops.spend_alerts WHERE id NOT IN (SELECT id FROM ops.spend_alerts ORDER BY ts DESC, id DESC LIMIT %s)",
                  (int(keep),))
    return rid


def list_spend_alerts(limit: int = 20, *, conn=None) -> list[dict]:
    return select("spend_alerts", order_by=["-ts", "-id"], limit=limit, conn=conn)


def save_alert_rule(row: dict, *, conn=None) -> dict:
    """Create or replace a rule by id; created defaults to now on first save."""
    return upsert("alert_rules", {"created": now_ms(), **row},
                  update=[k for k in row if k not in ("id", "created")], conn=conn)


def get_alert_rule(id: str, *, conn=None) -> dict | None:
    return get("alert_rules", id, conn=conn)


def list_alert_rules(*, conn=None) -> list[dict]:
    return select("alert_rules", order_by=["created", "id"], conn=conn)


def delete_alert_rule(id: str, *, conn=None) -> int:
    return delete("alert_rules", id, conn=conn)


def mark_alert_fired(id: str, ts: int | None = None, *, conn=None) -> dict | None:
    return update("alert_rules", id, {"last_fired": (now_ms() if ts is None else ts)}, conn=conn)


def log_alert(rule: str, subject: str, bar: int, delivered: str, channel: str, value: float | None = None,
              detail: str | None = None, at: int | None = None, *, conn=None) -> bool:
    """One line per (rule, subject, bar), ever: returns False when that bar was already logged."""
    r = _q(conn, "INSERT INTO ops.alert_log (at, rule, subject, value, bar, delivered, channel, detail) "
                 "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (rule, subject, bar) DO NOTHING",
           ((now_ms() if at is None else at), rule, subject, value, bar, delivered, channel, detail))
    return r.rowcount == 1


def list_alert_log(since: int | None = None, rule: str | None = None, limit: int = 500, *, conn=None) -> list[dict]:
    w, a = [sql.SQL("at >= %s")], [since or 0]
    if rule is not None:
        w.append(sql.SQL("rule = %s")); a.append(rule)
    q = sql.SQL("SELECT {} FROM ops.alert_log WHERE ").format(_cols("alert_log")) + sql.SQL(" AND ").join(w)
    return _q(conn, q + sql.SQL(" ORDER BY at DESC, id DESC LIMIT %s"), a + [int(limit)]).fetchall()


def add_alert_pass(bar: int, bars: str, rules: int, rows: int, error: str | None = None, forced: bool = False,
                   at: int | None = None, *, conn=None) -> int:
    return insert("alert_passes", {"at": (now_ms() if at is None else at), "bar": bar, "bars": bars, "rules": rules, "rows": rows,
                                   "error": error, "forced": forced}, conn=conn)["id"]


def list_alert_passes(since: int | None = None, limit: int = 500, *, conn=None) -> list[dict]:
    return _q(conn, sql.SQL("SELECT {} FROM ops.alert_passes WHERE at >= %s ORDER BY at DESC, id DESC LIMIT %s")
              .format(_cols("alert_passes")), (since or 0, int(limit))).fetchall()


# ---------------------------------------------------------------------------------- library drafts


def add_library_draft(row: dict, *, conn=None) -> int | None:
    """One draft per correction (unique key): returns the new id, or None when the key exists."""
    r = {"ts": now_ms(), **row}
    cols = list(r)
    _check_cols("library_drafts", cols, writable=True)
    v = _adapt("library_drafts", r)
    q = sql.SQL("INSERT INTO ops.library_drafts ({}) VALUES ({}) ON CONFLICT (key) DO NOTHING RETURNING id").format(
        sql.SQL(", ").join(map(sql.Identifier, cols)), sql.SQL(", ").join(sql.Placeholder() * len(cols)))
    got = _q(conn, q, [v[c] for c in cols]).fetchone()
    return got["id"] if got else None


def list_library_drafts(state: str | None = None, limit: int = 200, *, conn=None) -> list[dict]:
    return select("library_drafts", {"state": state} if state else None, order_by=["-ts", "-id"], limit=limit, conn=conn)


def update_library_draft(id: int, *, conn=None, **fields) -> dict | None:
    return update("library_drafts", id, {"updated": now_ms(), **fields}, conn=conn)


def set_draft_scan(conv: str, last_at: int, found: int = 0, cost_usd: float = 0.0, note: str | None = None,
                   ts: int | None = None, *, conn=None) -> dict:
    return upsert("library_draft_scans", {"conv": conv, "last_at": last_at, "ts": (now_ms() if ts is None else ts), "found": found,
                                          "cost_usd": cost_usd, "note": note}, conn=conn)


def get_draft_scan(conv: str, *, conn=None) -> dict | None:
    return get("library_draft_scans", conv, conn=conn)


def set_book_mark(path: str, state: str = "cold", *, n: int = 0, note: str | None = None, boot: Any = None,
                  ts: int | None = None, conn=None) -> dict:
    return upsert("book_marks", {"path": path, "state": state, "n": n, "ts": (now_ms() if ts is None else ts), "note": note,
                                 "boot_json": boot}, conn=conn)


def get_book_mark(path: str, *, conn=None) -> dict | None:
    return get("book_marks", path, conn=conn)


def list_book_marks(state: str | None = None, *, conn=None) -> list[dict]:
    return select("book_marks", {"state": state} if state else None, order_by="path", conn=conn)


def drop_book_mark(path: str, *, conn=None) -> int:
    return delete("book_marks", path, conn=conn)


# --------------------------------------------------------------------------------- lab comparators


def add_comparator_snapshot(id: str, status: str, series: Any, src: str, read_at: str | None = None,
                            ts: int | None = None, *, conn=None) -> int:
    """Append-only: a pull never rewrites an earlier row. Returns seq."""
    return insert("comparator_snapshots", {"id": id, "ts": (now_ms() if ts is None else ts), "status": status, "series": series,
                                           "src": src, "read_at": read_at}, conn=conn)["seq"]


def latest_comparator_snapshots(*, conn=None) -> dict[str, dict]:
    rows = _q(conn, sql.SQL("SELECT DISTINCT ON (id) {} FROM ops.comparator_snapshots ORDER BY id, ts DESC, seq DESC")
              .format(_cols("comparator_snapshots"))).fetchall()
    return {r["id"]: r for r in rows}


def comparator_history(id: str, limit: int = 100, *, conn=None) -> list[dict]:
    return select("comparator_snapshots", {"id": id}, order_by=["-ts", "-seq"], limit=limit, conn=conn)


# -------------------------------------------------------------------------------------------- chat


def create_prompt(body: str, title: str = "", tags: Iterable[str] = (), ts: int | None = None, *, conn=None) -> dict:
    t = (now_ms() if ts is None else ts)
    return insert("chat_prompts", {"title": title, "body": body, "tags": sorted({x.lower() for x in tags}),
                                   "created": t, "updated": t}, conn=conn)


def update_prompt(id: int, *, conn=None, **fields) -> dict | None:
    if "tags" in fields:
        fields["tags"] = sorted({x.lower() for x in fields["tags"]})
    return update("chat_prompts", id, {"updated": now_ms(), **fields}, conn=conn)


def delete_prompt(id: int, *, conn=None) -> int:
    return delete("chat_prompts", id, conn=conn)


def list_prompts(*, conn=None) -> list[dict]:
    return select("chat_prompts", order_by=["-updated", "-id"], conn=conn)


def set_chat_verify(repo: str, code: int | None, last: str, ms: int, fingerprint: str, timed_out: bool = False,
                    ts: int | None = None, *, conn=None) -> dict:
    return upsert("chat_verify", {"repo": repo, "code": code, "last": last, "ms": ms, "ts": (now_ms() if ts is None else ts),
                                  "timed_out": timed_out, "fingerprint": fingerprint}, conn=conn)


def get_chat_verify(repo: str, *, conn=None) -> dict | None:
    return get("chat_verify", repo, conn=conn)


def list_chat_verify(*, conn=None) -> list[dict]:
    return select("chat_verify", order_by="repo", conn=conn)



# =================================================================================================
# READ MODELS the cockpit asks for (each one query the cockpit used to spell itself), and the
# platform's logs (migration ops/002). Names mirror @fund/db's ops.ts one for one.
# =================================================================================================

def _one(conn, query, args=()) -> dict | None:
    return _q(conn, query, args).fetchone()


def _all(conn, query, args=()) -> list[dict]:
    return _q(conn, query, args).fetchall()


# ------------------------------------------------------------------------------------ events (reads)


def events_in_window(since: int, until: int, kinds: Iterable[str] | None = None, agent_only: bool = False,
                     *, conn=None) -> list[dict]:
    """Events with since <= ts < until, oldest first (ts, id)."""
    w, a = [sql.SQL("ts >= %s"), sql.SQL("ts < %s")], [since, until]
    if kinds:
        w.append(sql.SQL("kind = ANY(%s)")); a.append(list(kinds))
    if agent_only:
        w.append(sql.SQL("agent_id IS NOT NULL"))
    q = sql.SQL("SELECT {} FROM ops.events WHERE ").format(_cols("events")) + sql.SQL(" AND ").join(w)
    return _all(conn, q + sql.SQL(" ORDER BY ts, id"), a)


def turn_events(conversation: str | None = None, *, conn=None) -> list[dict]:
    """The 'turn' events of one conversation (ts, id order), or of every conversation (ordered by
    conversation, then ts, id). Rows: ts, summary, agent_id, conversation_id."""
    if conversation is not None:
        return _all(conn, "SELECT ts, summary, agent_id, conversation_id FROM ops.events WHERE kind = 'turn' "
                          "AND conversation_id = %s ORDER BY ts, id", (conversation,))
    return _all(conn, "SELECT ts, summary, agent_id, conversation_id FROM ops.events WHERE kind = 'turn' "
                      "AND conversation_id IS NOT NULL ORDER BY conversation_id, ts, id")


def turn_window_events(conversation: str, kind: str, after: int, through: int, *, conn=None) -> list[dict]:
    """One conversation's events of `kind` with after < ts <= through (a turn's own span)."""
    return _all(conn, sql.SQL("SELECT {} FROM ops.events WHERE kind = %s AND conversation_id = %s AND ts > %s AND ts <= %s "
                              "ORDER BY ts, id").format(_cols("events")), (kind, conversation, after, through))


def last_event_ts(kind: str, payload_key: str, payload_value: str, *, conn=None) -> int | None:
    """The newest ts of an event of `kind` whose payload carries payload_key = payload_value."""
    r = _one(conn, "SELECT MAX(ts) AS ts FROM ops.events WHERE kind = %s AND payload_json->>%s = %s",
             (kind, payload_key, payload_value))
    return r["ts"] if r else None


def reverted_conversations(*, conn=None) -> list[str]:
    """Conversations with an event whose summary starts 'reverted '."""
    return [r["id"] for r in _all(conn, "SELECT DISTINCT conversation_id AS id FROM ops.events WHERE conversation_id IS NOT NULL "
                                        "AND summary LIKE 'reverted %%' ORDER BY 1")]


def error_counts_by_conversation(*, conn=None) -> dict[str, int]:
    return {r["id"]: r["n"] for r in _all(conn, "SELECT conversation_id AS id, count(*)::int AS n FROM ops.events "
                                                "WHERE kind = 'error' AND conversation_id IS NOT NULL GROUP BY 1")}


# ----------------------------------------------------------------------------- conversations (reads)


def touch_conversation(id: str, ts: int | None = None, title: str = "", *, conn=None) -> int:
    """Bump last_at; set the title only while it is still blank."""
    return _q(conn, "UPDATE ops.conversations SET last_at = %s, title = CASE WHEN title = '' THEN %s ELSE title END WHERE id = %s",
              ((now_ms() if ts is None else ts), title, id)).rowcount


def next_unindexed_conversation(*, conn=None) -> dict | None:
    """One conversation not yet indexed (not forgotten, with a transcript and a cwd): id, cwd, transcript_uuid."""
    return _one(conn, "SELECT id, cwd, transcript_uuid FROM ops.conversations WHERE NOT indexed AND NOT forgotten "
                      "AND transcript_uuid IS NOT NULL AND cwd IS NOT NULL ORDER BY last_at DESC, id LIMIT 1")


def conversation_counts(*, conn=None) -> dict[str, int]:
    """{agent_id: conversations not forgotten}."""
    return {r["a"]: r["n"] for r in _all(conn, "SELECT agent_id AS a, count(*)::int AS n FROM ops.conversations "
                                              "WHERE NOT forgotten GROUP BY agent_id")}


def list_conversation_ids(*, conn=None) -> list[str]:
    """Every conversation id, forgotten ones included."""
    return [r["id"] for r in _all(conn, "SELECT id FROM ops.conversations ORDER BY id")]


def conversations_due_for_draft_scan(quiet_before: int, since: int, limit: int = 20, *, conn=None) -> list[dict]:
    """Idle or closed, not forgotten, last moved in (since, quiet_before), and not scanned since it
    last moved; newest first. Rows: id, agent_id, last_at, state."""
    return _all(conn, "SELECT c.id, c.agent_id, c.last_at, c.state FROM ops.conversations c "
                      "LEFT JOIN ops.library_draft_scans s ON s.conv = c.id "
                      "WHERE NOT c.forgotten AND c.state IN ('idle', 'closed') AND c.last_at < %s AND c.last_at > %s "
                      "AND (s.conv IS NULL OR s.last_at < c.last_at) ORDER BY c.last_at DESC LIMIT %s",
                (quiet_before, since, int(limit)))


# ---------------------------------------------------------------------------------- messages (reads)

def prefix_words(text: str) -> list[str]:
    """The search words of a typed query: each run of letters, digits and _, lower-cased, unique, at
    most 16. Nothing the owner types can become tsquery syntax."""
    import re
    out: list[str] = []
    for w in re.findall(r"[^\W]+", str(text).lower()):
        if w not in out:
            out.append(w)
    return out[:16]


def search_messages_prefix(text: str, limit: int = 400, *, conn=None) -> list[dict]:
    """Messages matching EVERY word of `text` as a prefix (prefix_words), newest first:
    [{conversation_id, snippet}]. No word at all -> []."""
    words = prefix_words(text)
    if not words:
        return []
    tsq = " & ".join(f"{w}:*" for w in words)
    return _all(conn, "SELECT conversation_id, ts_headline('simple', text, x, 'MaxWords=10, MinWords=4, StartSel=\"\", "
                      "StopSel=\"\", FragmentDelimiter=\"...\"') AS snippet FROM ops.messages, to_tsquery('simple', %s) x "
                      "WHERE tsv @@ x ORDER BY ts DESC LIMIT %s", (tsq, int(limit)))


def assistant_text(conversation_id: str, after: int, through: int, *, conn=None) -> list[str]:
    """The assistant messages of one conversation with after < ts <= through, in order."""
    return [r["text"] for r in _all(conn, "SELECT text FROM ops.messages WHERE conversation_id = %s AND role = 'assistant' "
                                          "AND ts > %s AND ts <= %s ORDER BY ts, id", (conversation_id, after, through))]


# ---------------------------------------------------------------------------------- presence (write)


def heartbeat_presence(hand_ids: Iterable[str], ts: int | None = None, *, conn=None) -> int:
    ids = list(hand_ids)
    if not ids:
        return 0
    return _q(conn, "UPDATE ops.presence SET heartbeat_at = %s WHERE hand_id = ANY(%s)",
              ((now_ms() if ts is None else ts), ids)).rowcount


# ------------------------------------------------------------------------------------- reads (pulls)
# A PULL is a read that was not made at boot (at_boot false).


def record_read_once(agent_id: str, book_path: str, conversation_id: str | None = None, ts: int | None = None,
                     dedupe_ms: int = 60_000, *, conn=None) -> bool:
    """Record a pull unless the same agent pulled the same book in the same conversation within
    dedupe_ms. Returns whether a row was written."""
    t = now_ms() if ts is None else ts
    dup = _one(conn, "SELECT 1 AS x FROM ops.reads WHERE book_path = %s AND agent_id = %s AND NOT at_boot AND ts > %s "
                     "AND conversation_id IS NOT DISTINCT FROM %s LIMIT 1", (book_path, agent_id, t - dedupe_ms, conversation_id))
    if dup:
        return False
    record_read(agent_id, book_path, conversation_id=conversation_id, at_boot=False, ts=t, conn=conn)
    return True


def count_reads_by_book(conversation_id: str, *, conn=None) -> dict[str, int]:
    """{book_path: pulls} in one conversation."""
    return {r["p"]: r["n"] for r in _all(conn, "SELECT book_path AS p, count(*)::int AS n FROM ops.reads WHERE conversation_id = %s "
                                              "AND NOT at_boot GROUP BY book_path", (conversation_id,))}


def books_read_in_conversation(conversation_id: str, *, conn=None) -> list[str]:
    """The books pulled in one conversation, most recently pulled first."""
    return [r["p"] for r in _all(conn, "SELECT book_path AS p, MAX(ts) AS t FROM ops.reads WHERE conversation_id = %s AND NOT at_boot "
                                       "GROUP BY book_path ORDER BY t DESC, book_path", (conversation_id,))]


def pull_ledger_span(*, conn=None) -> dict:
    """{"first": the oldest pull's ts or None, "n": pulls}."""
    r = _one(conn, "SELECT MIN(ts) AS first, count(*)::int AS n FROM ops.reads WHERE NOT at_boot")
    return {"first": r["first"] if r else None, "n": r["n"] if r else 0}


def pulled_books(*, conn=None) -> list[str]:
    """Every book ever pulled, sorted."""
    return [r["p"] for r in _all(conn, "SELECT DISTINCT book_path AS p FROM ops.reads WHERE NOT at_boot ORDER BY 1")]


def read_stats_by_book(since: int, *, conn=None) -> list[dict]:
    """Per (book_path, at_boot): n_since (reads with ts > since) and last (newest ts)."""
    return _all(conn, "SELECT book_path, at_boot, count(*) FILTER (WHERE ts > %s)::int AS n_since, MAX(ts) AS last "
                      "FROM ops.reads GROUP BY book_path, at_boot ORDER BY book_path, at_boot", (since,))


def pullers_by_book(since: int, *, conn=None) -> list[dict]:
    """Per (book_path, agent_id): pulls with ts > since, most first."""
    return _all(conn, "SELECT book_path, agent_id, count(*)::int AS n FROM ops.reads WHERE NOT at_boot AND ts > %s "
                      "GROUP BY book_path, agent_id ORDER BY n DESC, agent_id, book_path", (since,))


def pulls_by_agent(since: int, *, conn=None) -> list[dict]:
    """Per (agent_id, book_path): pulls with ts > since and the newest ts, most recent first."""
    return _all(conn, "SELECT agent_id, book_path, count(*)::int AS n, MAX(ts) AS last FROM ops.reads WHERE NOT at_boot "
                      "AND ts > %s GROUP BY agent_id, book_path ORDER BY last DESC, agent_id, book_path", (since,))


def list_pulls(*, conn=None) -> list[dict]:
    """Every pull made in a conversation: book_path, conversation_id, ts - ordered by book, conversation, ts."""
    return _all(conn, "SELECT book_path, conversation_id, ts FROM ops.reads WHERE NOT at_boot AND conversation_id IS NOT NULL "
                      "ORDER BY book_path, conversation_id, ts, id")


def conversations_with_pulls(*, conn=None) -> list[str]:
    return [r["id"] for r in _all(conn, "SELECT DISTINCT conversation_id AS id FROM ops.reads WHERE NOT at_boot "
                                        "AND conversation_id IS NOT NULL ORDER BY 1")]


# ----------------------------------------------------------------------------------- commits (reads)


def commit_subjects(*, conn=None) -> list[dict]:
    """Every indexed commit: repo, sha, ts, subject, conversation_id, loop_change (oldest first)."""
    return _all(conn, "SELECT repo, sha, ts, subject, conversation_id, loop_change FROM ops.commits ORDER BY ts, repo, sha")


def commit_files(conversation_id: str, after: int, through: int, *, conn=None) -> list[Any]:
    """files_json of one conversation's commits with after < ts <= through."""
    return [r["files_json"] for r in _all(conn, "SELECT files_json FROM ops.commits WHERE conversation_id = %s AND ts > %s "
                                                "AND ts <= %s ORDER BY ts, sha", (conversation_id, after, through))]


def known_commits(repo: str, shas: Iterable[str], *, conn=None) -> set[str]:
    s = list(shas)
    if not s:
        return set()
    return {r["sha"] for r in _all(conn, "SELECT sha FROM ops.commits WHERE repo = %s AND sha = ANY(%s)", (repo, s))}


def commit_shrinks(repo: str, shas: Iterable[str], *, conn=None) -> dict[str, Any]:
    """{sha: shrink_json} for the named commits that carry one."""
    s = list(shas)
    if not s:
        return {}
    return {r["sha"]: r["shrink_json"] for r in _all(conn, "SELECT sha, shrink_json FROM ops.commits WHERE repo = %s "
                                                          "AND shrink_json IS NOT NULL AND sha = ANY(%s)", (repo, s))}


# --------------------------------------------------------------------------------------- loop (more)


def lessons_since(since: int = 0, limit: int = 500, *, conn=None) -> list[dict]:
    """Lessons with ts >= since, newest first."""
    return _all(conn, sql.SQL("SELECT {} FROM ops.loop_lessons WHERE ts >= %s ORDER BY ts DESC, id DESC LIMIT %s")
                .format(_cols("loop_lessons")), (since, int(limit)))


def clear_metrics(from_day: str, *, conn=None) -> int:
    """Delete every loop_metrics row with day >= from_day (a recompute rewrites them)."""
    return _q(conn, "DELETE FROM ops.loop_metrics WHERE day >= %s", (from_day,)).rowcount


def metrics_between(from_day: str, to_day: str, *, conn=None) -> list[dict]:
    """loop_metrics rows with from_day <= day <= to_day, oldest day first."""
    return _all(conn, sql.SQL("SELECT {} FROM ops.loop_metrics WHERE day >= %s AND day <= %s ORDER BY day, agent_id, metric")
                .format(_cols("loop_metrics")), (from_day, to_day))


def usage_in_window(since: int, until: int, *, conn=None) -> list[dict]:
    """usage rows with since <= ts < until, oldest first."""
    return _all(conn, sql.SQL("SELECT {} FROM ops.usage WHERE ts >= %s AND ts < %s ORDER BY ts, id").format(_cols("usage")),
                (since, until))


def grades_in_window(source: str, since: int, until: int, *, conn=None) -> list[dict]:
    """turn_grades of one source with since <= ts < until, oldest first."""
    return _all(conn, sql.SQL("SELECT {} FROM ops.turn_grades WHERE source = %s AND ts >= %s AND ts < %s "
                              "ORDER BY ts, conversation_id, turn_ix, key").format(_cols("turn_grades")), (source, since, until))


def graded_turns(source: str, *, conn=None) -> list[dict]:
    """Distinct (conversation_id, turn_ix) that carry a grade from `source`."""
    return _all(conn, "SELECT DISTINCT conversation_id, turn_ix FROM ops.turn_grades WHERE source = %s "
                      "ORDER BY conversation_id, turn_ix", (source,))


def list_review_all(*, conn=None) -> list[dict]:
    """The whole review queue, every state: newest first, then conversation, turn, reason."""
    return _all(conn, sql.SQL("SELECT {} FROM ops.review_queue ORDER BY ts DESC, conversation_id, turn_ix, reason")
                .format(_cols("review_queue")))


def set_review_state_all(conversation_id: str, turn_ix: int, state: str, *, conn=None) -> int:
    """Set the state of every review item (every reason) of one turn."""
    return _q(conn, "UPDATE ops.review_queue SET state = %s WHERE conversation_id = %s AND turn_ix = %s",
              (state, conversation_id, turn_ix)).rowcount


def clear_owner_grade(conversation_id: str, turn_ix: int, *, conn=None) -> int:
    """Take the owner's grade off one turn and reopen its review items, in one transaction.
    Returns the grade rows removed."""
    with transaction(conn) as c:
        n = c.execute("DELETE FROM ops.turn_grades WHERE conversation_id = %s AND turn_ix = %s AND source = 'owner'",
                      (conversation_id, turn_ix)).rowcount
        c.execute("UPDATE ops.review_queue SET state = 'open' WHERE conversation_id = %s AND turn_ix = %s",
                  (conversation_id, turn_ix))
    return n


# ------------------------------------------------------------------------------------- board (reads)


def list_board_attest(*, conn=None) -> list[dict]:
    return select("board_attest", order_by="id", conn=conn)


def list_open_board_suggestions(*, conn=None) -> list[dict]:
    """Suggestions not marked done, ordered by source, path, line (nulls first), title."""
    return _all(conn, "SELECT s.fp, s.source, s.kind, s.path, s.line, s.ref, s.quote, s.title, s.owner, s.first_seen, s.last_seen "
                      "FROM ops.board_suggested s LEFT JOIN ops.board_suggested_done d ON d.fp = s.fp "
                      "WHERE d.fp IS NULL ORDER BY s.source, s.path, s.line NULLS FIRST, s.title")


# ------------------------------------------------------------------------------------ alerts (reads)


def alert_log_keys(rules: Iterable[str], bars: Iterable[int], *, conn=None) -> list[dict]:
    """(rule, subject, bar) already logged for the named rules and bars."""
    r, b = list(rules), [int(x) for x in bars]
    if not r or not b:
        return []
    return _all(conn, "SELECT rule, subject, bar FROM ops.alert_log WHERE rule = ANY(%s) AND bar = ANY(%s) ORDER BY rule, subject, bar",
                (r, b))


def alert_delivered_counts(rules: Iterable[str], since: int, *, conn=None) -> dict[str, int]:
    """{rule: deliveries attempted (ok or fail) with at >= since}."""
    r = list(rules)
    if not r:
        return {}
    return {x["rule"]: x["n"] for x in _all(conn, "SELECT rule, count(*)::int AS n FROM ops.alert_log WHERE rule = ANY(%s) "
                                                  "AND at >= %s AND delivered IN ('ok', 'fail') GROUP BY rule", (r, since))}


def prune_alert_passes(before: int, *, conn=None) -> int:
    return _q(conn, "DELETE FROM ops.alert_passes WHERE at < %s", (before,)).rowcount


def first_alert_pass(*, conn=None) -> int | None:
    r = _one(conn, "SELECT MIN(at) AS t FROM ops.alert_passes")
    return r["t"] if r else None


# ---------------------------------------------------------------------------- library drafts (more)


def bump_draft_scan(conv: str, last_at: int, found: int = 0, cost_usd: float = 0.0, note: str | None = None,
                    ts: int | None = None, *, conn=None) -> dict:
    """Record a scan of one conversation: last_at, ts and note are replaced, found and cost_usd ADD
    to what earlier scans recorded."""
    return _one(conn, sql.SQL("INSERT INTO ops.library_draft_scans (conv, last_at, ts, found, cost_usd, note) "
                              "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (conv) DO UPDATE SET last_at = EXCLUDED.last_at, "
                              "ts = EXCLUDED.ts, found = ops.library_draft_scans.found + EXCLUDED.found, "
                              "cost_usd = ops.library_draft_scans.cost_usd + EXCLUDED.cost_usd, note = EXCLUDED.note RETURNING {}")
                .format(_cols("library_draft_scans")), (conv, last_at, (now_ms() if ts is None else ts), found, cost_usd, note))


def library_draft_exists(key: str, *, conn=None) -> bool:
    return _one(conn, "SELECT 1 AS x FROM ops.library_drafts WHERE key = %s", (key,)) is not None


def library_draft_tally(*, conn=None) -> dict:
    """{"saved", "dismissed", "last_scan_ts"}."""
    t = _one(conn, "SELECT count(*) FILTER (WHERE state = 'saved')::int AS saved, "
                   "count(*) FILTER (WHERE state = 'dismissed')::int AS dismissed FROM ops.library_drafts")
    s = _one(conn, "SELECT MAX(ts) AS ts FROM ops.library_draft_scans")
    return {"saved": t["saved"], "dismissed": t["dismissed"], "last_scan_ts": s["ts"] if s else None}


def conversation_has_undrafted_lesson(conversation_id: str, *, conn=None) -> bool:
    """Did the conversation file a loop lesson that no library draft was made from?"""
    return _one(conn, "SELECT 1 AS x FROM ops.loop_lessons WHERE conversation_id = %s AND id NOT IN "
                      "(SELECT lesson_id FROM ops.library_drafts WHERE lesson_id IS NOT NULL) LIMIT 1",
                (conversation_id,)) is not None


# --------------------------------------------------------------------------------- processes (more)


def close_process_once(id: int, exit_code: int | None = None, stopped_at: int | None = None, *, conn=None) -> int:
    """Close a process row only if it is still open; a known exit code is never overwritten."""
    return _q(conn, "UPDATE ops.processes SET stopped_at = %s, exit_code = COALESCE(exit_code, %s) WHERE id = %s AND stopped_at IS NULL",
              ((now_ms() if stopped_at is None else stopped_at), exit_code, id)).rowcount


# ------------------------------------------------------------------------------------ health (reads)


def health_readings_since(probe_prefix: str, target: str, since: int, *, conn=None) -> list[dict]:
    """probe_id, ts, status, reading of every reading whose probe_id starts with the prefix, of one
    target kind, with ts >= since, oldest first."""
    return _all(conn, "SELECT probe_id, ts, status, reading FROM ops.health_readings WHERE starts_with(probe_id, %s) "
                      "AND target = %s AND ts >= %s ORDER BY ts, id", (probe_prefix, target, since))


def health_probes_seen(probe_ids: Iterable[str], since: int, *, conn=None) -> set[str]:
    """Which of the probes have a reading with ts >= since."""
    ids = list(probe_ids)
    if not ids:
        return set()
    return {r["p"] for r in _all(conn, "SELECT DISTINCT probe_id AS p FROM ops.health_readings WHERE probe_id = ANY(%s) AND ts >= %s",
                                 (ids, since))}


def last_health_ts(probe_ids: Iterable[str], *, conn=None) -> dict[str, int]:
    """{probe_id: newest reading ts} for the probes that have one."""
    ids = list(probe_ids)
    if not ids:
        return {}
    return {r["probe_id"]: r["ts"] for r in _all(conn, "SELECT probe_id, MAX(ts) AS ts FROM ops.health_readings "
                                                      "WHERE probe_id = ANY(%s) GROUP BY probe_id", (ids,))}


def health_between(probe_ids: Iterable[str], since: int, until: int, *, conn=None) -> list[dict]:
    """probe_id, ts, status, reading, detail_json with since <= ts <= until, oldest first."""
    ids = list(probe_ids)
    if not ids:
        return []
    return _all(conn, "SELECT probe_id, ts, status, reading, detail_json FROM ops.health_readings WHERE probe_id = ANY(%s) "
                      "AND ts >= %s AND ts <= %s ORDER BY ts, id", (ids, since, until))


def health_before(probe_ids: Iterable[str], before: int, *, conn=None) -> list[dict]:
    """Each probe's newest reading with ts < before (probe_id, ts, status, reading, detail_json)."""
    ids = list(probe_ids)
    if not ids:
        return []
    return _all(conn, "SELECT DISTINCT ON (probe_id) probe_id, ts, status, reading, detail_json FROM ops.health_readings "
                      "WHERE probe_id = ANY(%s) AND ts < %s ORDER BY probe_id, ts DESC, id DESC", (ids, before))


# -------------------------------------------------------------------------------------- jobs (reads)


def job_runs_in_window(since: int, until: int, *, conn=None) -> list[dict]:
    """Runs DUE inside [since, until], or with no due and a start (else end) inside it."""
    return _all(conn, "SELECT id, job_id, due_at, started_at, ended_at, status, trigger, detail FROM ops.job_runs "
                      "WHERE (due_at BETWEEN %s AND %s) OR (due_at IS NULL AND COALESCE(started_at, ended_at) BETWEEN %s AND %s) "
                      "ORDER BY COALESCE(due_at, started_at, ended_at), id", (since, until, since, until))


def job_run_span(*, conn=None) -> dict:
    """{"first": the oldest run's start (else end) or None, "first_due": {job_id: its oldest due}}."""
    f = _one(conn, "SELECT MIN(COALESCE(started_at, ended_at)) AS t FROM ops.job_runs")
    d = _all(conn, "SELECT job_id, MIN(due_at) AS t FROM ops.job_runs WHERE due_at IS NOT NULL GROUP BY job_id")
    return {"first": f["t"] if f else None, "first_due": {r["job_id"]: r["t"] for r in d}}


# ------------------------------------------------------------------------------------- usage (reads)
# billable = tokens_in + cache_write + tokens_out. A DAY is the local calendar day of `ts` in the
# IANA zone `tz` (the cockpit passes its own zone).


def usage_by_day(since: int, tz: str, *, conn=None) -> list[dict]:
    """Per (agent, local day) with ts >= since: tin, tout, cr, cw, cost, billable, n; newest day first."""
    return _all(conn, "SELECT agent_id AS agent, to_char(to_timestamp(ts / 1000.0) AT TIME ZONE %s, 'YYYY-MM-DD') AS day, "
                      "SUM(tokens_in)::float8 AS tin, SUM(tokens_out)::float8 AS tout, SUM(cache_read)::float8 AS cr, "
                      "SUM(cache_write)::float8 AS cw, SUM(cost_usd)::float8 AS cost, "
                      "SUM(tokens_in + cache_write + tokens_out)::float8 AS billable, count(*)::int AS n "
                      "FROM ops.usage WHERE ts >= %s GROUP BY 1, 2 ORDER BY day DESC, agent", (tz, since))


def billable_on_day(day: str, tz: str, since: int, *, conn=None) -> dict:
    """{"billable": sum or None, "n": rows} of usage rows with ts >= since on the local day `day`."""
    r = _one(conn, "SELECT SUM(tokens_in + cache_write + tokens_out)::float8 AS t, count(*)::int AS n FROM ops.usage "
                   "WHERE ts >= %s AND to_char(to_timestamp(ts / 1000.0) AT TIME ZONE %s, 'YYYY-MM-DD') = %s", (since, tz, day))
    return {"billable": r["t"] if r else None, "n": r["n"] if r else 0}


def billable_rows(since: int, until: int, *, conn=None) -> list[dict]:
    """agent, ts, billable per usage row with since <= ts < until, oldest first."""
    return _all(conn, "SELECT agent_id AS agent, ts, (tokens_in + cache_write + tokens_out)::float8 AS billable FROM ops.usage "
                      "WHERE ts >= %s AND ts < %s ORDER BY ts, id", (since, until))


def billable_by_agent(since: int, *, conn=None) -> dict[str, float]:
    return {r["a"]: r["t"] for r in _all(conn, "SELECT agent_id AS a, SUM(tokens_in + cache_write + tokens_out)::float8 AS t "
                                              "FROM ops.usage WHERE ts >= %s GROUP BY agent_id", (since,))}


def last_spend_alerts(*, conn=None) -> dict[str, int]:
    """{agent: newest spend alert ts}."""
    return {r["agent"]: r["ts"] for r in _all(conn, "SELECT agent, MAX(ts) AS ts FROM ops.spend_alerts GROUP BY agent")}


# ------------------------------------------------------------------------------ the DATA panel audit


def add_data_audit(op: str, actor: str, request: Any = None, result: Any = None, plan_id: str | None = None,
                   pid: int | None = None, host: str | None = None, ts: int | None = None, *, conn=None) -> dict:
    """Append one audit record (append-only; never rewritten). Returns the stored row."""
    return insert("data_audit", {"ts": (now_ms() if ts is None else ts), "op": op, "actor": actor, "pid": pid, "host": host,
                                 "plan_id": plan_id, "request": request, "result": result}, conn=conn)


def list_data_audit(limit: int = 100, *, conn=None) -> list[dict]:
    """The newest `limit` records, returned OLDEST first."""
    rows = select("data_audit", order_by=["-ts", "-id"], limit=limit, conn=conn)
    return list(reversed(rows))


# ------------------------------------------------------------------------------------------ the wire


def add_wire_changes(rows: Iterable[dict], logged: int | None = None, *, conn=None) -> int:
    """Append detected venue changes {ts_ms, prev_ms, venue, kind, subject, before, after, source, tag}
    in one transaction. Returns how many."""
    t = now_ms() if logged is None else logged
    todo = list(rows)
    if not todo:
        return 0
    with transaction(conn) as c:
        for r in todo:
            insert("wire_changes", {"ts_ms": int(r["ts_ms"]), "prev_ms": r.get("prev_ms"), "venue": r["venue"], "kind": r["kind"],
                                    "subject": r["subject"], "before": r.get("before"), "after": r.get("after"),
                                    "source": r.get("source") or "", "tag": r.get("tag") or "[API]", "logged": t}, conn=c)
    return len(todo)


def list_wire_changes(venue: str | None = None, since: int | None = None, limit: int | None = 500,
                      oldest_first: bool = False, *, conn=None) -> list[dict]:
    """Detected changes (ts_ms >= since), newest first (or oldest first); limit None = all."""
    w, a = [], []
    if venue is not None:
        w.append(sql.SQL("venue = %s")); a.append(venue)
    if since is not None:
        w.append(sql.SQL("ts_ms >= %s")); a.append(since)
    q = sql.SQL("SELECT {} FROM ops.wire_changes").format(_cols("wire_changes"))
    if w:
        q += sql.SQL(" WHERE ") + sql.SQL(" AND ").join(w)
    q += sql.SQL(" ORDER BY ts_ms, id") if oldest_first else sql.SQL(" ORDER BY ts_ms DESC, id DESC")
    if limit is not None:
        q += sql.SQL(" LIMIT %s"); a.append(int(limit))
    return _all(conn, q, a)


def count_wire_changes(venue: str | None = None, since: int | None = None, *, conn=None) -> int:
    w, a = [], []
    if venue is not None:
        w.append(sql.SQL("venue = %s")); a.append(venue)
    if since is not None:
        w.append(sql.SQL("ts_ms >= %s")); a.append(since)
    q = sql.SQL("SELECT count(*)::int AS n FROM ops.wire_changes")
    if w:
        q += sql.SQL(" WHERE ") + sql.SQL(" AND ").join(w)
    return _one(conn, q, a)["n"]


def set_wire_snapshot(venue: str, day: str, ts_ms: int, markets: Any, source: str = "", *, conn=None) -> dict:
    """The day's latest public-metadata read of one venue (a later read that day replaces it)."""
    return upsert("wire_snapshots", {"venue": venue, "day": day, "ts_ms": ts_ms, "source": source, "markets": markets}, conn=conn)


def latest_wire_snapshot(venue: str, *, conn=None) -> dict | None:
    return _one(conn, sql.SQL("SELECT {} FROM ops.wire_snapshots WHERE venue = %s ORDER BY day DESC LIMIT 1")
                .format(_cols("wire_snapshots")), (venue,))


def wire_snapshot_heads(*, conn=None) -> dict[str, dict]:
    """{venue: {"ts_ms", "markets" (how many), "source"}} of each venue's latest snapshot."""
    rows = _all(conn, "SELECT DISTINCT ON (venue) venue, ts_ms, source, (SELECT count(*) FROM jsonb_object_keys(markets))::int AS n "
                      "FROM ops.wire_snapshots ORDER BY venue, day DESC")
    return {r["venue"]: {"ts_ms": r["ts_ms"], "markets": r["n"], "source": r["source"]} for r in rows}


def get_wire_state(key: str, *, conn=None) -> Any:
    r = get("wire_state", key, conn=conn)
    return r["value"] if r else None


def set_wire_state(key: str, value: Any, ts: int | None = None, *, conn=None) -> dict:
    return upsert("wire_state", {"key": key, "value": value, "updated": (now_ms() if ts is None else ts)}, conn=conn)


# ------------------------------------------------------------------------------ no-lesson stand-downs


def add_no_lesson(desk: str, subject: str, reason: str, hand: str | None = None, operator: str | None = None,
                  touched: Iterable[str] = (), ts: int | None = None, *, conn=None) -> int:
    return insert("no_lesson", {"ts": (now_ms() if ts is None else ts), "desk": desk or ".", "hand": hand, "operator": operator,
                                "subject": subject, "reason": reason, "touched": [str(x) for x in touched]}, conn=conn)["id"]


def list_no_lesson(desk: str | None = None, limit: int = 500, *, conn=None) -> list[dict]:
    """Newest first."""
    return select("no_lesson", {"desk": desk} if desk is not None else None, order_by=["-ts", "-id"], limit=limit, conn=conn)
