"""import-cockpit: a SQLite cockpit.db built from the frozen schema carries over exactly, and the
verification is shown to go RED when what lands differs from what was read."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from fund_db import ops
from fund_db.db import connect
from fund_db.importer import ImportError_, import_cockpit

SCHEMA = Path(__file__).parent / "fixtures" / "cockpit_schema.sql"


def _quiet(*_):
    pass


def make_cockpit(path: Path, extra_sql: str = "") -> Path:
    c = sqlite3.connect(path)
    c.executescript(SCHEMA.read_text(encoding="utf-8"))
    c.executescript("""
    INSERT INTO conversations (id, agent_id, title, transcript_uuid, state, cwd, started_at, last_at, tokens_in, tokens_out,
      cost_usd, forgotten, model, effort, indexed) VALUES
      ('c1', 'app', 'first', 'u1', 'closed', 'C:/dev/fund/app', 1790000000000, 1790000001000, 10, 20, 0.125, 0, 'opus', 'high', 1),
      ('c2', 'fund', '', NULL, 'idle', NULL, 1790000002000, 1790000003000, 0, 0, 0, 1, NULL, NULL, 0);
    INSERT INTO messages_fts (conversation_id, role, ts, text) VALUES
      ('c1', 'user', 1790000000500, 'the funding rate on venue_a'),
      ('c1', 'assistant', 1790000000600.0, 'it flipped, see ''premium''');
    INSERT INTO events (ts, kind, summary, agent_id, conversation_id, payload_json) VALUES
      (1, 'job', 'nightly ok', 'app', NULL, '{"detail": "fine", "n": 3, "f": 0.1}'),
      (2, 'turn', 'turn done', 'app', 'c1', NULL);
    INSERT INTO usage (ts, agent_id, conversation_id, model, tokens_in, tokens_out, cache_read, cache_write, cost_usd)
      VALUES (3, 'app', 'c1', 'opus', 10, 20, 1, 2, 0.125);
    INSERT INTO health_readings VALUES (4, 'venue:venue_a', 'venue', 'ok', '200 ms', '{"ms": 200}');
    INSERT INTO job_runs (job_id, due_at, started_at, ended_at, status, exit_code, trigger, pid) VALUES
      ('nightly', 10, 11, 12, 'ok', 0, 'schedule', 99), ('nightly', 20, NULL, NULL, 'missed', NULL, 'schedule', NULL);
    INSERT INTO reads VALUES (5, 'app', 'c1', 'library/a.md', 1);
    INSERT INTO commits (repo, sha, ts, author, agent_id, subject, files_json, shrink_json) VALUES
      ('fund', 'abc', 6, 'app', 'app', 'one', '["a.md", "b.md"]', NULL);
    INSERT INTO loop_metrics VALUES ('2026-09-24', 'app', 'turns', 4.5);
    INSERT INTO loop_passes (ts, trigger, ok, summary, detail_json) VALUES (7, 'owner', 1, 'ok', '{}');
    INSERT INTO alert_rules (id, condition, params_json, subject, mode, bar, file_board, enabled, armed, created)
      VALUES ('r1', 'funding_gt', '{"x": 1}', 'venue_a:BTCUSDT', 'bar', '1h', 1, 0, 1, 8);
    INSERT INTO alert_log (at, rule, subject, value, bar, delivered, channel) VALUES (9, 'r1', 'venue_a:BTCUSDT', 0.5, 3600, 'ok', 'board');
    INSERT INTO alert_passes (at, bar, bars, rules, rows, forced) VALUES (10, 3600, '1h', 1, 1, 0);
    INSERT INTO board_scan VALUES (1, 11, 2, 3, 0, '[]', 4, 0);
    INSERT INTO comparator_snapshots (id, ts, status, series, src) VALUES ('btc', 12, 'ok', '{"points": [[1, 2.5]], "unit": "usd"}', 'api');
    INSERT INTO chat_prompts (title, body, tags, created, updated) VALUES ('t', 'b', '["x"]', 13, 13);
    INSERT INTO chat_verify VALUES ('app', 0, 'ok', 100, 14, 0, 'fp');
    INSERT INTO turn_grades VALUES ('c1', 0, 15, 'app', 'check', 'nodash', 1, NULL, 16);
    INSERT INTO review_queue VALUES ('c1', 0, 'failed', 'open', 15, 'app', 'text', '[{"check": "nodash", "start": 0, "end": 2}]', NULL);
    INSERT INTO book_marks VALUES ('library/old.md', 'cold', 1, 17, NULL, '["app"]');
    """ + extra_sql)
    c.commit()
    c.close()
    return path


def test_every_table_carries_over_verified(db, tmp_path):
    src = make_cockpit(tmp_path / "cockpit.db")
    before = src.read_bytes()
    r = import_cockpit(src, dsn=db, log=_quiet)
    assert r["ok"] and not r["missing_in_source"]
    assert src.read_bytes() == before                         # the source is never touched
    assert r["tables"]["conversations"]["rows"] == 2 and r["tables"]["messages"]["rows"] == 2
    assert json.loads(Path(r["report_path"]).read_text())["ok"] is True
    c1 = ops.get_conversation("c1")
    assert (c1["indexed"], c1["forgotten"], c1["cost_usd"], c1["model"]) == (True, False, 0.125, "opus")
    assert ops.get_conversation("c2", include_forgotten=True)["forgotten"] is True
    assert ops.list_events(kinds=["job"])[0]["payload_json"] == {"detail": "fine", "n": 3, "f": 0.1}
    assert ops.search_messages("venue_a")[0]["conversation_id"] == "c1"
    assert [m["ts"] for m in ops.select("messages", order_by="id")] == [1790000000500, 1790000000600]
    rule = ops.get_alert_rule("r1")
    assert (rule["file_board"], rule["enabled"], rule["armed"], rule["params_json"]) == (True, False, True, {"x": 1})
    assert ops.get_board_scan()["capped"] is False
    assert ops.get_commit("fund", "abc")["files_json"] == ["a.md", "b.md"]
    assert ops.list_prompts()[0]["tags"] == ["x"]


def test_identity_sequences_continue_past_the_carried_ids(db, tmp_path):
    import_cockpit(make_cockpit(tmp_path / "cockpit.db"), dsn=db, log=_quiet)
    top = max(r["id"] for r in ops.select("events"))
    assert ops.log_event("x", "after import") == top + 1
    assert ops.start_job_run("j", None) == 3
    assert ops.index_message("c1", "user", "new") == 3
    assert ops.create_prompt("b2")["id"] == 2


def test_a_second_import_is_refused_unless_replace(db, tmp_path):
    src = make_cockpit(tmp_path / "cockpit.db")
    import_cockpit(src, dsn=db, log=_quiet)
    with pytest.raises(ImportError_, match="already hold rows"):
        import_cockpit(src, dsn=db, log=_quiet)
    ops.log_event("x", "stray row that --replace must clear")
    r = import_cockpit(src, dsn=db, replace=True, log=_quiet)
    assert r["ok"] and ops.count("events") == 2


def test_verify_goes_red_and_rolls_back_when_what_lands_differs(db, tmp_path):
    """Break it on purpose: a trigger rewrites a summary on insert, so what Postgres holds is not
    what SQLite held. The import must refuse and leave NOTHING behind."""
    with connect(db, autocommit=True) as c:
        c.execute("CREATE FUNCTION ops.tamper() RETURNS trigger LANGUAGE plpgsql AS "
                  "$$ BEGIN NEW.summary := NEW.summary || '!'; RETURN NEW; END $$")
        c.execute("CREATE TRIGGER tamper BEFORE INSERT ON ops.events FOR EACH ROW EXECUTE FUNCTION ops.tamper()")
    with pytest.raises(ImportError_, match="VERIFY FAILED on ops.events"):
        import_cockpit(make_cockpit(tmp_path / "cockpit.db"), dsn=db, log=_quiet)
    assert ops.count("conversations") == 0 and ops.count("events") == 0


def test_bad_source_values_are_refused_not_coerced(db, tmp_path):
    with pytest.raises(ImportError_, match="flag value 2"):
        import_cockpit(make_cockpit(tmp_path / "a.db", "UPDATE conversations SET forgotten = 2 WHERE id = 'c1';"), dsn=db, log=_quiet)
    with pytest.raises(ImportError_, match="not JSON"):
        import_cockpit(make_cockpit(tmp_path / "b.db", "UPDATE events SET payload_json = '{broken' WHERE id = 1;"), dsn=db, log=_quiet)
    with pytest.raises(ImportError_, match="whole number"):
        import_cockpit(make_cockpit(tmp_path / "c.db", "INSERT INTO messages_fts VALUES ('c1', 'user', 1.5, 'x');"), dsn=db, log=_quiet)
    with pytest.raises(ImportError_, match="no ops home"):
        import_cockpit(make_cockpit(tmp_path / "d.db", "CREATE TABLE brand_new (a INTEGER);"), dsn=db, log=_quiet)
    assert ops.count("conversations") == 0


def test_a_database_that_never_grew_the_runtime_columns_still_imports(db, tmp_path):
    """An old cockpit.db without conversations.model/effort/indexed takes the column defaults."""
    schema = SCHEMA.read_text(encoding="utf-8")
    runtime = ", model TEXT, effort TEXT, indexed INTEGER NOT NULL DEFAULT 0);"
    assert runtime in schema
    p = tmp_path / "old.db"
    c = sqlite3.connect(p)
    c.executescript(schema.replace(runtime, ");"))
    assert "model" not in [r[1] for r in c.execute("PRAGMA table_info(conversations)")]
    c.execute("INSERT INTO conversations (id, agent_id, started_at, last_at) VALUES ('c1', 'app', 1, 2)")
    c.commit()
    c.close()
    assert import_cockpit(p, dsn=db, log=_quiet)["ok"]
    got = ops.get_conversation("c1")
    assert (got["indexed"], got["model"]) == (False, None)
