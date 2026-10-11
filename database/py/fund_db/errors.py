"""fund_db.errors - the exception types a caller catches, so no caller imports duckdb or psycopg
just to name an error.

    from fund_db import errors
    try:
        rows = market.funding(...)
    except errors.unavailable() as e:      # the data layer could not answer RIGHT NOW
        ...                                # serve something else, loudly
    # fund_db.market.WriteError (a contract breach) is NOT in that tuple: it is a bug; let it raise.

`unavailable()` = OSError (disk, a lock timeout), DuckDB's own error, and Postgres being
unreachable (psycopg.OperationalError). A dependency that is not installed contributes nothing.
"""
from __future__ import annotations


def unavailable() -> tuple[type[BaseException], ...]:
    errs: list[type[BaseException]] = [OSError]
    try:
        from .market.lock import LockTimeout
        errs.append(LockTimeout)
    except ImportError:
        pass
    try:
        import duckdb
        errs.append(duckdb.Error)
    except ImportError:
        pass
    try:
        import psycopg
        errs.append(psycopg.OperationalError)
    except ImportError:
        pass
    return tuple(dict.fromkeys(errs))


def is_unavailable(e: BaseException) -> bool:
    return isinstance(e, unavailable())
