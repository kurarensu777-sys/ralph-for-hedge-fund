"""Python fund_db and node @fund/db are ONE contract: the same ops function names (snake_case vs
camelCase), the same DSN resolution, the same migration ledger, and the same rows read back.
The node checks run the real node package (node_modules installed); without node they skip and
say so."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from fund_db import config, migrate, ops

NODE = Path(__file__).resolve().parents[1] / "node"
SPECIAL = {"delete": "del"}          # python name -> node name where JS forbids the plain camelCase
PY_ONLY = {"TABLES"}                 # exported by @fund/db's index (from rows.ts), not by ops.ts


def camel(name: str) -> str:
    if name in SPECIAL:
        return SPECIAL[name]
    if name.isupper():                # constants keep their name in both languages
        return name
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def node_ops_exports() -> set[str]:
    text = (NODE / "src" / "ops.ts").read_text(encoding="utf-8")
    names = set(re.findall(r"^export (?:async )?function (\w+)", text, re.M))
    names |= set(re.findall(r"^export const (\w+)", text, re.M))
    for block in re.findall(r"^export \{([^}]*)\}", text, re.M):
        names |= {n.strip().split(" as ")[-1] for n in block.split(",") if n.strip()}
    return names


def test_every_python_ops_function_has_its_node_twin_and_back():
    want = {camel(n) for n in ops.__all__ if n not in PY_ONLY}
    have = node_ops_exports()
    assert sorted(want - have) == [], "in fund_db.ops but missing from node/src/ops.ts"
    assert sorted(have - want) == [], "in node/src/ops.ts but missing from fund_db.ops"


def test_python_ops_all_is_exactly_the_public_functions():
    public = {n for n in dir(ops) if not n.startswith("_") and callable(getattr(ops, n))
              and getattr(getattr(ops, n), "__module__", "").startswith("fund_db.")}
    assert sorted(public - set(ops.__all__)) == []


def _node() -> str:
    exe = shutil.which("node")
    if not exe or not (NODE / "node_modules" / "pg").exists():
        pytest.skip("node or node/node_modules missing: run `npm install` in database/node")
    return exe


def _run_node(script: str, env: dict) -> str:
    r = subprocess.run([_node(), "--input-type=module", "-e", script], cwd=NODE, env={**os.environ, **env},
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@pytest.mark.parametrize("env", [
    {},
    {"FUND_DB_PORT": "6543"},
    {"FUND_DB_DSN": "host=127.0.0.1 port=7777 user=fund dbname=x"},
])
def test_both_languages_resolve_the_same_dsn(tmp_path, monkeypatch, env):
    (tmp_path / "pg.json").write_text(json.dumps({"port": 5999, "user": "fund", "database": "fund"}))
    full = {"FUND_DB_DIR": str(tmp_path), "FUND_DB_DSN": "", "FUND_DB_PORT": "", **env}
    for k, v in full.items():
        if v:
            monkeypatch.setenv(k, v)
        else:
            monkeypatch.delenv(k, raising=False)
    node_env = {k: v for k, v in full.items()}
    script = ("const c = await import('./src/config.ts');"
              "for (const k of ['FUND_DB_DSN','FUND_DB_PORT']) if (process.env[k] === '') delete process.env[k];"
              "console.log(c.dsn())")
    assert _run_node(script, node_env) == config.dsn()


def test_node_reads_what_python_wrote_and_agrees_on_the_ledger(db):
    ops.log_event("job", "from python", agent="app", payload={"n": [1, 2], "f": 0.5}, ts=1234)
    ops.create_conversation("c1", "app", started_at=5)
    ops.set_book_mark("library/x.md", boot=["app"])
    script = """
      const db = await import('./src/index.ts');
      const ev = await db.ops.listEvents({ limit: 1 });
      const conv = await db.ops.getConversation('c1');
      const mark = await db.ops.getBookMark('library/x.md');
      const plan = await db.migrationStatus();
      console.log(JSON.stringify({ ev: ev[0], forgotten: conv.forgotten, started: conv.started_at, boot: mark.boot_json,
        pending: plan.pending.length, drift: plan.drift.length, applied: plan.applied.length }));
      await db.closeAll();
    """
    got = json.loads(_run_node(script, {"FUND_DB_DSN": db}))
    assert got["ev"]["summary"] == "from python" and got["ev"]["ts"] == 1234
    assert got["ev"]["payload_json"] == {"n": [1, 2], "f": 0.5}
    assert (got["forgotten"], got["started"], got["boot"]) == (False, 5, ["app"])
    assert (got["pending"], got["drift"], got["applied"]) == (0, 0, len(migrate.discover()))


def test_python_reads_what_node_wrote(db):
    script = """
      const db = await import('./src/index.ts');
      await db.ops.logEvent('turn', 'from node', { agent: 'fund', payload: [1, { a: true }], ts: 99 });
      await db.ops.saveAlertRule({ id: 'r1', condition: 'c', subject: 'venue_a:BTCUSDT', mode: 'bar', bar: '1h', params_json: { x: [1] }, enabled: 0 });
      await db.closeAll();
    """
    _run_node(script, {"FUND_DB_DSN": db})
    ev = ops.list_events(limit=1)[0]
    assert (ev["summary"], ev["ts"], ev["payload_json"]) == ("from node", 99, [1, {"a": True}])
    r = ops.get_alert_rule("r1")
    assert (r["params_json"], r["enabled"], r["armed"]) == ({"x": [1]}, False, True)


def test_a_dsn_with_a_password_is_refused_in_both_languages(monkeypatch):
    monkeypatch.setenv("FUND_DB_DSN", "host=127.0.0.1 port=5432 user=fund dbname=fund password=hunter2")
    with pytest.raises(ValueError, match="password"):
        config.dsn()
    r = subprocess.run([_node(), "--input-type=module", "-e", "const c = await import('./src/config.ts'); c.dsn()"],
                       cwd=NODE, env={**os.environ}, capture_output=True, text=True, timeout=60)
    assert r.returncode != 0 and "password" in r.stderr
