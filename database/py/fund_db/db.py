"""Connections to the ops store (PostgreSQL, psycopg 3).

    with fund_db.connect() as conn: ...           # a fresh connection (dict rows), closed on exit
    fund_db.db.shared()                            # this thread's long-lived autocommit connection
    with fund_db.db.transaction() as conn: ...     # several ops calls as one transaction

Every fund_db.ops function takes an optional `conn=`; without one it uses shared(). A shared
connection that the server dropped (restart, idle kill) is replaced on next use.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row

from . import config

_local = threading.local()


def connect(dsn: str | None = None, autocommit: bool = False, **kw) -> psycopg.Connection:
    """A new connection to the ops store; rows come back as dicts."""
    return psycopg.connect(dsn or config.dsn(), autocommit=autocommit, row_factory=dict_row,
                           connect_timeout=kw.pop("connect_timeout", 5), application_name=kw.pop("application_name", "fund_db"), **kw)


def shared(dsn: str | None = None) -> psycopg.Connection:
    """This thread's autocommit connection for `dsn` (default: config.dsn()), reconnecting if it broke."""
    key = dsn or config.dsn()
    pool = getattr(_local, "conns", None)
    if pool is None:
        pool = _local.conns = {}
    c = pool.get(key)
    if c is None or c.closed or c.broken:
        c = pool[key] = connect(key, autocommit=True)
    return c


def close_shared() -> None:
    for c in getattr(_local, "conns", {}).values():
        try:
            c.close()
        except Exception:
            pass
    _local.conns = {}


@contextmanager
def transaction(conn: psycopg.Connection | None = None):
    """Yield a connection inside one transaction: committed on exit, rolled back on an exception."""
    c = conn or shared()
    with c.transaction():
        yield c


def ping(dsn: str | None = None) -> str:
    """The server version string, or raise."""
    with connect(dsn, autocommit=True) as c:
        return c.execute("SELECT version() AS v").fetchone()["v"]
