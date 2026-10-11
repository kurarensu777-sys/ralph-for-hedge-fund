"""Where the data lives and how to reach the ops store. Standard library only, so the cluster
controller (scripts/pg.py) can import it before any dependency is installed.

The data root is ~/fund-data/db, overridable by FUND_DB_DIR. Nothing under it is ever in git.

    <root>/pgsql/           portable PostgreSQL binaries (bin/initdb.exe, bin/pg_ctl.exe, ...)
    <root>/pgdata/          the cluster (127.0.0.1 only, trust auth for 127.0.0.1 only)
    <root>/pg.json          what the controller chose at init: {"port", "user", "database"}
    <root>/log/             postgres.log and job logs
    <root>/market/          the Parquet lake: <dataset>/venue=<v>/[interval=<i>/]month=<YYYY-MM>/
    <root>/live/            the hot log (dormant, B-0191) and _locks/, every lake writer's partition locks
    <root>/cold/            tiered-out partitions, same layout as market/
    <root>/cache/           the CACHE: re-fetchable data, same layout as market/, evicted to a budget
    <root>/pins/            pinned series, content-addressed immutable Parquet (<hh>/<sha256>.parquet)
    <root>/_retired/        anything taken out of service; an agent never deletes here

The ops store's DSN resolves in this order: FUND_DB_DSN (a full libpq conninfo), else
host=127.0.0.1 with the port/user/database from pg.json (FUND_DB_PORT overrides the port).
There is never a password: the cluster trusts 127.0.0.1 and listens nowhere else.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

DEFAULT_PORT = 5432
DEFAULT_USER = "fund"
DEFAULT_DATABASE = "fund"
HOST = "127.0.0.1"


def data_dir() -> Path:
    """The data root: FUND_DB_DIR when set, else ~/fund-data/db."""
    env = os.environ.get("FUND_DB_DIR")
    return Path(env).expanduser().resolve() if env else (Path.home() / "fund-data" / "db")


def default_data_dir() -> Path:
    return (Path.home() / "fund-data" / "db").resolve()


def is_real_root() -> bool:
    """True when the data root is the real one (FUND_DB_DIR unset, or pointing at it)."""
    return data_dir() == default_data_dir()


def pg_bin_dir() -> Path:
    """The PostgreSQL binaries. FUND_PG_BIN overrides (tests reuse one install for many clusters)."""
    env = os.environ.get("FUND_PG_BIN")
    return Path(env) if env else data_dir() / "pgsql" / "bin"


def pgdata_dir() -> Path:
    return data_dir() / "pgdata"


def log_dir() -> Path:
    return data_dir() / "log"


def market_dir() -> Path:
    return data_dir() / "market"


def live_dir() -> Path:
    return data_dir() / "live"


def cold_dir() -> Path:
    return data_dir() / "cold"


def cache_dir() -> Path:
    return data_dir() / "cache"


def pins_dir() -> Path:
    return data_dir() / "pins"


def blobs_dir() -> Path:
    """The PIN class's blob files, inside pins/ (so the data root's layout is unchanged)."""
    return pins_dir() / "blobs"


def retired_dir() -> Path:
    return data_dir() / "_retired"


def settings_path() -> Path:
    return data_dir() / "pg.json"


def repo_root() -> Path:
    """The database repo (this file is database/py/fund_db/config.py)."""
    return Path(__file__).resolve().parents[2]


def migrations_dir() -> Path:
    env = os.environ.get("FUND_DB_MIGRATIONS")
    return Path(env) if env else repo_root() / "migrations"


def retention_path() -> Path:
    env = os.environ.get("FUND_DB_RETENTION")
    return Path(env) if env else repo_root() / "retention.toml"


def settings() -> dict:
    """pg.json merged over the defaults; FUND_DB_PORT wins over both."""
    s = {"port": DEFAULT_PORT, "user": DEFAULT_USER, "database": DEFAULT_DATABASE}
    p = settings_path()
    if p.exists():
        try:
            s.update({k: v for k, v in json.loads(p.read_text(encoding="utf-8")).items() if k in s})
        except (OSError, ValueError):
            pass
    if os.environ.get("FUND_DB_PORT"):
        s["port"] = int(os.environ["FUND_DB_PORT"])
    return s


def dsn(database: str | None = None) -> str:
    """The libpq conninfo for the ops store (never a password)."""
    env = os.environ.get("FUND_DB_DSN")
    if env and re.search(r"(?:^|\s)password\s*=", env):
        raise ValueError("FUND_DB_DSN carries a password; the ops store is trust-auth on 127.0.0.1 only")
    if env and database is None:
        return env
    s = settings()
    if env:  # a different database on the FUND_DB_DSN server
        return f"{env} dbname={database}"
    return f"host={HOST} port={s['port']} user={s['user']} dbname={database or s['database']}"
