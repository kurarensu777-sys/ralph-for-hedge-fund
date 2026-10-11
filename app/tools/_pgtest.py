"""A throwaway PostgreSQL (and a scratch data root) for the machine's python tests.

The probes record their readings in the ops store and the snapshot store is the fund_db lake, so
a test of either needs a store - never the real one. This starts ONE cluster per test process
(the real portable binaries: FUND_PG_BIN, else ~/fund-data/db/pgsql/bin), migrated once into a
template, and hands each test a fresh database cloned from it plus its own empty data root:

    import _pgtest
    if not _pgtest.available(): raise unittest.SkipTest(_pgtest.SKIP)
    env = _pgtest.fresh()          # {"FUND_DB_DSN": ..., "FUND_DB_DIR": <empty scratch root>}
    os.environ.update(env)         # this process and every child it starts
    ...
    _pgtest.forget(env)            # drop the database and the scratch root

Nothing here touches ~/fund-data/db: the cluster lives in a temp folder, stopped and removed at
exit. The binaries missing is a SKIP that says so, never a pass.
"""

from __future__ import annotations

import atexit
import os
import shutil
import socket
import tempfile
import uuid
from pathlib import Path

REAL_BIN = Path(os.environ.get("FUND_PG_BIN") or Path.home() / "fund-data" / "db" / "pgsql" / "bin")
TEMPLATE = "fund_tools_tmpl"
SKIP = f"no PostgreSQL binaries at {REAL_BIN}: the ops-store tests cannot run"
_STATE: dict = {}
_KEYS = ("FUND_DB_DIR", "FUND_PG_BIN", "FUND_DB_DSN", "FUND_DB_PORT")


def available() -> bool:
    return (REAL_BIN / ("initdb.exe" if os.name == "nt" else "initdb")).exists()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _with_env(env: dict, fn):
    old = {k: os.environ.get(k) for k in _KEYS}
    for k in _KEYS:
        os.environ.pop(k, None)
    os.environ.update(env)
    try:
        return fn()
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _cluster() -> dict:
    if _STATE:
        return _STATE
    root = Path(tempfile.mkdtemp(prefix="fund_tools_pg_"))
    port = _free_port()
    env = {"FUND_DB_DIR": str(root), "FUND_PG_BIN": str(REAL_BIN)}

    def up():
        from fund_db import cluster as cl, config, migrate
        from fund_db.db import connect
        cl.init(port=port, log=lambda *_: None)
        with connect(config.dsn("postgres"), autocommit=True) as c:
            c.execute(f"CREATE DATABASE {TEMPLATE}")
        migrate.migrate(config.dsn(TEMPLATE), log=lambda *_: None)
    _with_env(env, up)
    _STATE.update(root=root, port=port, env=env)
    atexit.register(_down)
    return _STATE


def _down() -> None:
    if not _STATE:
        return

    def down():
        from fund_db import cluster as cl, db as dbmod
        dbmod.close_shared()
        cl.stop(log=lambda *_: None)
    try:
        _with_env(_STATE["env"], down)
    finally:
        shutil.rmtree(_STATE["root"], ignore_errors=True)


def dsn(database: str) -> str:
    return f"host=127.0.0.1 port={_cluster()['port']} user=fund dbname={database}"


def fresh() -> dict:
    """A new database cloned from the migrated template + an empty scratch data root."""
    _cluster()
    from fund_db.db import connect
    name = f"t_{uuid.uuid4().hex[:12]}"
    with connect(dsn("postgres"), autocommit=True) as c:
        c.execute(f"CREATE DATABASE {name} TEMPLATE {TEMPLATE}")
    data = Path(tempfile.mkdtemp(prefix="fund_tools_data_"))
    return {"FUND_DB_DSN": dsn(name), "FUND_DB_DIR": str(data)}


def forget(env: dict) -> None:
    """Drop the database `fresh` made and remove its scratch data root."""
    from fund_db import db as dbmod
    from fund_db.db import connect
    dbmod.close_shared()
    name = env["FUND_DB_DSN"].rsplit("dbname=", 1)[-1]
    try:
        with connect(dsn("postgres"), autocommit=True) as c:
            c.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
    finally:
        shutil.rmtree(env["FUND_DB_DIR"], ignore_errors=True)
