"""The generic, validated table layer under fund_db.ops. Every table and column name is checked
against the GENERATED registry (rows.TABLES) before it is quoted into SQL, and every value is
bound as a parameter, so no caller string ever reaches the SQL text.

    insert(table, row) -> row          upsert(table, row, update=None) -> row
    get(table, *pk) -> row | None      select(table, where=None, order_by=None, limit=None) -> [row]
    update(table, pk, fields) -> row   delete(table, *pk) -> count      count(table, where=None) -> int

Rows are plain dicts: jsonb comes back as Python objects, booleans as bool, times as int epoch ms.
The generated tsvector column (messages.tsv) is never returned.
"""
from __future__ import annotations

import time
from typing import Any, Iterable

from psycopg import sql
from psycopg.types.json import Jsonb

from ..db import shared
from .rows import TABLES

SCHEMA = "ops"


def now_ms() -> int:
    return int(time.time() * 1000)


def spec(table: str) -> dict:
    s = TABLES.get(table)
    if s is None:
        raise ValueError(f"no ops table {table!r} (known: {', '.join(sorted(TABLES))})")
    return s


def check_cols(table: str, cols: Iterable[str], writable: bool = False) -> list[str]:
    s = spec(table)
    cols = list(cols)
    bad = [c for c in cols if c not in s["columns"]]
    if bad:
        raise ValueError(f"ops.{table} has no column(s) {bad}")
    if writable:
        gen = [c for c in cols if c in s["generated"]]
        if gen:
            raise ValueError(f"ops.{table}: {gen} is generated and cannot be written")
    return cols


def adapt(table: str, row: dict) -> dict:
    """Wrap jsonb values and coerce 0/1 flags so a caller may pass the SQLite-era shapes."""
    s = spec(table)
    out = {}
    for k, v in row.items():
        if v is not None and k in s["json"]:
            v = Jsonb(v)
        elif v is not None and k in s["bool"]:
            v = bool(v)
        out[k] = v
    return out


def ident(table: str) -> sql.Composed:
    spec(table)
    return sql.SQL("{}.{}").format(sql.Identifier(SCHEMA), sql.Identifier(table))


def readable(table: str) -> sql.Composed:
    s = spec(table)
    return sql.SQL(", ").join(sql.Identifier(c) for c in s["columns"] if c not in s["generated"])


def _where(table: str, where: dict | None) -> tuple[sql.Composable, list]:
    if not where:
        return sql.SQL(""), []
    parts, args = [], []
    for k, v in where.items():
        check_cols(table, [k])
        if v is None:
            parts.append(sql.SQL("{} IS NULL").format(sql.Identifier(k)))
        elif isinstance(v, (list, tuple, set)):
            parts.append(sql.SQL("{} = ANY(%s)").format(sql.Identifier(k)))
            args.append(list(v))
        else:
            parts.append(sql.SQL("{} = %s").format(sql.Identifier(k)))
            args.append(bool(v) if k in spec(table)["bool"] else v)
    return sql.SQL(" WHERE ") + sql.SQL(" AND ").join(parts), args


def _order(table: str, order_by) -> sql.Composable:
    if not order_by:
        return sql.SQL("")
    items = [order_by] if isinstance(order_by, str) else list(order_by)
    parts = []
    for o in items:
        desc = o.startswith("-")
        col = o[1:] if desc else o
        check_cols(table, [col])
        parts.append(sql.SQL("{} {}").format(sql.Identifier(col), sql.SQL("DESC" if desc else "ASC")))
    return sql.SQL(" ORDER BY ") + sql.SQL(", ").join(parts)


def _pk_where(table: str, pk: tuple) -> tuple[sql.Composable, list]:
    keys = spec(table)["pk"]
    if len(pk) != len(keys):
        raise ValueError(f"ops.{table} primary key is ({', '.join(keys)}); got {len(pk)} value(s)")
    return (sql.SQL(" WHERE ") + sql.SQL(" AND ").join(sql.SQL("{} = %s").format(sql.Identifier(k)) for k in keys)), list(pk)


def insert(table: str, row: dict, *, conn=None) -> dict:
    cols = check_cols(table, row, writable=True)
    missing = [c for c in spec(table)["required"] if c not in row]
    if missing:
        raise ValueError(f"ops.{table}: required column(s) {missing} missing")
    vals = adapt(table, row)
    q = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING {}").format(
        ident(table), sql.SQL(", ").join(map(sql.Identifier, cols)),
        sql.SQL(", ").join(sql.Placeholder() * len(cols)), readable(table))
    return (conn or shared()).execute(q, [vals[c] for c in cols]).fetchone()


def upsert(table: str, row: dict, *, update: Iterable[str] | None = None, conn=None) -> dict:
    """INSERT, or on a primary-key conflict UPDATE `update` (default: every non-key column given)."""
    cols = check_cols(table, row, writable=True)
    pk = spec(table)["pk"]
    absent = [k for k in pk if k not in row and k not in spec(table)["identity"]]
    if absent:
        raise ValueError(f"ops.{table}: upsert needs the primary key {pk}")
    upd = check_cols(table, update if update is not None else [c for c in cols if c not in pk], writable=True)
    vals = adapt(table, row)
    action = (sql.SQL("DO UPDATE SET ") + sql.SQL(", ").join(
        sql.SQL("{} = EXCLUDED.{}").format(sql.Identifier(c), sql.Identifier(c)) for c in upd)) if upd else sql.SQL("DO NOTHING")
    q = sql.SQL("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) {} RETURNING {}").format(
        ident(table), sql.SQL(", ").join(map(sql.Identifier, cols)), sql.SQL(", ").join(sql.Placeholder() * len(cols)),
        sql.SQL(", ").join(map(sql.Identifier, pk)), action, readable(table))
    r = (conn or shared()).execute(q, [vals[c] for c in cols]).fetchone()
    return r if r is not None else get(table, *[row[k] for k in pk], conn=conn)


def get(table: str, *pk: Any, conn=None) -> dict | None:
    w, args = _pk_where(table, pk)
    q = sql.SQL("SELECT {} FROM {}").format(readable(table), ident(table)) + w
    return (conn or shared()).execute(q, args).fetchone()


def select(table: str, where: dict | None = None, order_by=None, limit: int | None = None, *, conn=None) -> list[dict]:
    w, args = _where(table, where)
    q = sql.SQL("SELECT {} FROM {}").format(readable(table), ident(table)) + w + _order(table, order_by)
    if limit is not None:
        q += sql.SQL(" LIMIT %s")
        args.append(int(limit))
    return (conn or shared()).execute(q, args).fetchall()


def update(table: str, pk: Any, fields: dict, *, conn=None) -> dict | None:
    """Set `fields` on the row with primary key `pk` (a scalar, or a tuple for a composite key)."""
    if not fields:
        return get(table, *(pk if isinstance(pk, tuple) else (pk,)), conn=conn)
    cols = check_cols(table, fields, writable=True)
    keys = spec(table)["pk"]
    if any(c in keys for c in cols):
        raise ValueError(f"ops.{table}: the primary key is not updatable here")
    vals = adapt(table, fields)
    w, args = _pk_where(table, pk if isinstance(pk, tuple) else (pk,))
    q = sql.SQL("UPDATE {} SET {}").format(ident(table), sql.SQL(", ").join(
        sql.SQL("{} = %s").format(sql.Identifier(c)) for c in cols)) + w + sql.SQL(" RETURNING {}").format(readable(table))
    return (conn or shared()).execute(q, [vals[c] for c in cols] + args).fetchone()


def delete(table: str, *pk: Any, conn=None) -> int:
    w, args = _pk_where(table, pk)
    return (conn or shared()).execute(sql.SQL("DELETE FROM {}").format(ident(table)) + w, args).rowcount


def count(table: str, where: dict | None = None, *, conn=None) -> int:
    w, args = _where(table, where)
    return (conn or shared()).execute(sql.SQL("SELECT count(*) AS n FROM {}").format(ident(table)) + w, args).fetchone()["n"]
