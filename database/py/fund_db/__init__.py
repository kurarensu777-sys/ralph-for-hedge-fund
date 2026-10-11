"""fund_db - the one data layer every repo calls. The contract is database/CLAUDE.md.

    import fund_db
    fund_db.sql("select venue, count(*) from funding group by 1")   # DuckDB: lake views + Postgres as `pg`
    fund_db.ops.log_event("job", "nightly ok")                       # typed ops-store functions
    fund_db.market.funding(...)                                       # the market lake (fund_db.market)
    fund_db.live.record(...)                                          # the hot log, dormant: no writer since 2026-09-26 (B-0191)
    fund_db.files.write_json("my-area", "x/y.json", obj)               # the files area (fund_db.files)
    fund_db.errors.unavailable()                                      # the error types a caller catches
    fund_db.pacer.take("exchange_a", cost=5)                          # the one per-venue request budget

Importing the package is cheap and dependency-free: every submodule loads on first touch, so the
cluster controller (fund_db.cluster) works before psycopg or duckdb is installed.
"""
from __future__ import annotations

import importlib

__version__ = "0.1.0"

_SUBMODULES = {"config", "cluster", "db", "migrate", "ops", "lake", "retention", "importer", "schema", "market", "live",
               "cli", "files", "errors", "backup", "pacer"}


def __getattr__(name: str):
    if name in _SUBMODULES:
        return importlib.import_module(f"{__name__}.{name}")
    if name == "sql":
        return importlib.import_module(f"{__name__}.lake").sql
    if name == "connect":
        return importlib.import_module(f"{__name__}.db").connect
    raise AttributeError(f"module 'fund_db' has no attribute {name!r}")


def __dir__():
    return sorted(set(globals()) | _SUBMODULES | {"sql", "connect"})
