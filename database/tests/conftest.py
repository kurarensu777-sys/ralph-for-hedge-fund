"""One throwaway PostgreSQL cluster per test session (its own data root in a temp folder, its own
free port, the real portable binaries), a migrated TEMPLATE database, and a fresh database cloned
from it for every test that asks for `db`. Nothing here touches ~/fund-data/db.

The binaries come from FUND_PG_BIN, else ~/fund-data/db/pgsql/bin; without them every database
test is skipped (and says so) rather than passed.
"""
from __future__ import annotations

import os
import shutil
import socket
import tempfile
import uuid
from pathlib import Path

import pytest

REAL_BIN = Path(os.environ.get("FUND_PG_BIN") or Path.home() / "fund-data" / "db" / "pgsql" / "bin")
TEMPLATE = "fund_tmpl"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def cluster():
    if not (REAL_BIN / ("initdb.exe" if os.name == "nt" else "initdb")).exists():
        pytest.skip(f"no PostgreSQL binaries at {REAL_BIN}: database tests cannot run")
    root = Path(tempfile.mkdtemp(prefix="fund_db_test_"))
    old = {k: os.environ.get(k) for k in ("FUND_DB_DIR", "FUND_PG_BIN", "FUND_DB_DSN", "FUND_DB_PORT")}
    os.environ.update(FUND_DB_DIR=str(root), FUND_PG_BIN=str(REAL_BIN))
    os.environ.pop("FUND_DB_DSN", None)
    os.environ.pop("FUND_DB_PORT", None)
    from fund_db import cluster as cl, config, migrate
    port = _free_port()
    cl.init(port=port, log=lambda *_: None)
    from fund_db.db import connect
    with connect(config.dsn("postgres"), autocommit=True) as c:
        c.execute(f"CREATE DATABASE {TEMPLATE}")
    migrate.migrate(config.dsn(TEMPLATE), log=lambda *_: None)
    try:
        yield {"root": root, "port": port}
    finally:
        from fund_db import db as dbmod, lake
        dbmod.close_shared()
        lake.reset()
        try:
            cl.stop(log=lambda *_: None)
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def db(cluster, monkeypatch):
    """A fresh, fully migrated database; FUND_DB_DSN points at it for the test's duration."""
    from fund_db import config, db as dbmod, lake
    from fund_db.db import connect
    name = f"t_{uuid.uuid4().hex[:12]}"
    with connect(config.dsn("postgres"), autocommit=True) as c:
        c.execute(f"CREATE DATABASE {name} TEMPLATE {TEMPLATE}")
    dsn = f"host=127.0.0.1 port={cluster['port']} user=fund dbname={name}"
    monkeypatch.setenv("FUND_DB_DSN", dsn)
    dbmod.close_shared()
    lake.reset()
    yield dsn
    dbmod.close_shared()
    lake.reset()
    with connect(f"host=127.0.0.1 port={cluster['port']} user=fund dbname=postgres", autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


@pytest.fixture
def empty_db(cluster, monkeypatch):
    """A fresh database with NO migrations applied."""
    from fund_db import db as dbmod
    from fund_db.db import connect
    name = f"e_{uuid.uuid4().hex[:12]}"
    base = f"host=127.0.0.1 port={cluster['port']} user=fund dbname="
    with connect(base + "postgres", autocommit=True) as c:
        c.execute(f"CREATE DATABASE {name}")
    monkeypatch.setenv("FUND_DB_DSN", base + name)
    dbmod.close_shared()
    yield base + name
    dbmod.close_shared()
    with connect(base + "postgres", autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
