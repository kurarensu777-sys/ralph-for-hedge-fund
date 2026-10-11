"""fund_db.sql() - one in-process DuckDB that sees the whole data layer at once:

* every lake dataset as a VIEW named after it (funding, candles, quotes, ...), reading
  <root>/market/<dataset>/**/*.parquet and, when present, the tiered-out <root>/cold/<dataset>/**
  and the cache <root>/cache/<dataset>/** with hive partitions (venue, interval, month) as columns
  (a read through a view does not mark a cache month read; the typed readers do);
* the ops store attached READ-ONLY as the catalog `pg` (pg.ops.events, pg.market.catalog, ...).

    fund_db.sql("select venue, count(*) n from funding group by 1")                -> pyarrow.Table
    fund_db.sql("select * from pg.ops.job_runs where status = ?", ["fail"], as_="pandas")
    fund_db.sql("...", as_="rows")                                                   -> list[dict]

fund_db.market may refine the views: when it defines register_views(con), that runs after the
generic ones (and may CREATE OR REPLACE any of them). A dataset folder starting with `_` (such
as _files) is not a table. Writes go through fund_db.market's write_* functions, never here.
"""
from __future__ import annotations

import importlib
import importlib.util
import threading
from pathlib import Path

import duckdb

from . import config

_lock = threading.Lock()
_state: dict = {"con": None, "root": None, "views": {}, "pg": None, "pg_error": None}
_local = threading.local()


def _datasets(root: Path) -> dict[str, list[str]]:
    """{dataset: [parquet globs that currently hold at least one file]} over market/, cold/, cache/."""
    out: dict[str, list[str]] = {}
    for base in (root / "market", root / "cold", root / "cache"):
        if not base.is_dir():
            continue
        for d in sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith(("_", "."))):
            if next(d.rglob("*.parquet"), None) is not None:
                out.setdefault(d.name, []).append((d / "**" / "*.parquet").as_posix())
    return out


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _register(con: duckdb.DuckDBPyConnection, root: Path) -> None:
    want = _datasets(root)
    if want == _state["views"]:
        return
    for name in set(_state["views"]) - set(want):
        con.execute(f"DROP VIEW IF EXISTS {_quote_ident(name)}")
    for name, globs in want.items():
        files = "[" + ", ".join("'" + g.replace("'", "''") + "'" for g in globs) + "]"
        con.execute(f"CREATE OR REPLACE VIEW {_quote_ident(name)} AS SELECT * FROM read_parquet({files}, "
                    "hive_partitioning = true, union_by_name = true)")
    _state["views"] = want
    if importlib.util.find_spec(f"{__package__}.market") is not None:
        market = importlib.import_module(f"{__package__}.market")
        hook = getattr(market, "register_views", None)
        if callable(hook):
            hook(con)


def _attach_pg(con: duckdb.DuckDBPyConnection) -> None:
    dsn = config.dsn()
    if _state["pg"] == dsn:
        return
    try:
        if _state["pg"] is not None:
            con.execute("DETACH pg")
        con.execute("INSTALL postgres")
        con.execute("LOAD postgres")
        con.execute(f"ATTACH '{dsn.replace(chr(39), chr(39) * 2)}' AS pg (TYPE postgres, READ_ONLY)")
        _state["pg"], _state["pg_error"] = dsn, None
    except duckdb.Error as e:  # the lake still answers with the ops store down
        _state["pg"], _state["pg_error"] = None, str(e)


def connection() -> duckdb.DuckDBPyConnection:
    """This thread's cursor on the shared in-process database, views and `pg` refreshed."""
    with _lock:
        root = config.data_dir()
        if _state["con"] is None or _state["root"] != root:
            if _state["con"] is not None:
                _state["con"].close()
            _state.update(con=duckdb.connect(":memory:"), root=root, views={}, pg=None, pg_error=None)
            _local.__dict__.clear()
        con = _state["con"]
        _register(con, root)
        if _state["pg"] is None or _state["pg"] != config.dsn():
            _attach_pg(con)
    cur = getattr(_local, "cur", None)
    if cur is None or getattr(_local, "gen", None) is not con:
        cur = _local.cur = con.cursor()
        _local.gen = con
    return cur


def pg_error() -> str | None:
    """Why `pg` is not attached (None when it is, or before the first sql() call)."""
    return _state["pg_error"]


def views() -> dict[str, list[str]]:
    """The lake views registered right now and the globs behind each."""
    connection()
    return dict(_state["views"])


def sql(query: str, params=None, *, as_: str = "arrow"):
    """Run one query. as_ = 'arrow' (pyarrow.Table) | 'pandas' (DataFrame) | 'rows' (list of dicts)."""
    if as_ not in ("arrow", "pandas", "rows"):
        raise ValueError(f"as_ must be arrow | pandas | rows, not {as_!r}")
    rel = connection().execute(query, params or [])
    if as_ == "arrow":
        for name in ("to_arrow_table", "fetch_arrow_table", "arrow"):  # newest duckdb API first
            if hasattr(rel, name):
                return getattr(rel, name)()
    if as_ == "pandas":
        return rel.df()
    cols = [d[0] for d in rel.description]
    return [dict(zip(cols, r)) for r in rel.fetchall()]


def reset() -> None:
    """Drop the in-process database (tests; or after the data root moved)."""
    with _lock:
        if _state["con"] is not None:
            _state["con"].close()
        _state.update(con=None, root=None, views={}, pg=None, pg_error=None)
        _local.__dict__.clear()
