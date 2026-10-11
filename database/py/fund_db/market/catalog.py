"""The lake catalog: one row per series in Postgres (`market.catalog`), refreshed by every write,
so "what do we hold" is a query and never a scan.

    series   = (dataset, venue, interval, symbol)   interval '' where the dataset has none;
               symbol '' for datasets without a symbol series (snapshots, conflicts), where
               `venue` holds the partition value (the snapshot log name).
    first_ts / last_ts   epoch ms (a date dataset reports UTC midnight of the date)
    rows                 rows stored, both tiers
    gaps / step_ms       candles: missing bars on the interval grid; funding: missing
                         settlements, expected spacing = the row's venue-published interval_h,
                         else the series' median spacing (step_ms). NULL where no grid exists
                         (observations, eod, rates): a gap there is not defined, not zero.
    by_src               {"venue": n, "seed:x": n}
    retention            the dataset's class from retention.toml
    covered_from / _to   the fetch coverage a fetcher recorded (set_coverage): the venue was
                         asked for, and answered with, everything in that window.

THE LAKE IS THE TRUTH, THE CATALOG IS DERIVED. When Postgres is down a write still lands; the
refresh is queued in <hot>/_catalog/pending.jsonl (with a warning) and replayed by the next
refresh that reaches Postgres, or by `python -m fund_db.market catalog --rebuild`. The backend is
PgCatalog; MemoryCatalog exists for the tests and is never chosen implicitly.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import duckdb

from . import layout
from .registry import DATASETS, Dataset, get, interval_ms

DDL = """
CREATE SCHEMA IF NOT EXISTS market;
CREATE TABLE IF NOT EXISTS market.catalog (
    dataset      text    NOT NULL,
    venue        text    NOT NULL,
    "interval"   text    NOT NULL DEFAULT '',
    symbol       text    NOT NULL DEFAULT '',
    first_ts     bigint,
    last_ts      bigint,
    rows         bigint  NOT NULL DEFAULT 0,
    gaps         bigint,
    step_ms      bigint,
    by_src       jsonb   NOT NULL DEFAULT '{}'::jsonb,
    retention    text,
    covered_from bigint,
    covered_to   bigint,
    updated_ms   bigint  NOT NULL,
    PRIMARY KEY (dataset, venue, "interval", symbol)
);
CREATE INDEX IF NOT EXISTS catalog_symbol_idx ON market.catalog (symbol);
"""

COLS = ("dataset", "venue", "interval", "symbol", "first_ts", "last_ts", "rows", "gaps", "step_ms",
        "by_src", "retention", "covered_from", "covered_to", "updated_ms")


def _now() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------------------------- #
# backends
# --------------------------------------------------------------------------------------------- #

class PgCatalog:
    """market.catalog in the ops store, through fund_db.db."""

    def __init__(self, schema: str = "market"):
        self.schema = schema
        self._ready = False

    def _conn(self):
        from fund_db import db
        return db.connect(autocommit=True, connect_timeout=3)

    def _ddl(self) -> str:
        return DDL.replace("market.", f"{self.schema}.").replace(
            "SCHEMA IF NOT EXISTS market", f"SCHEMA IF NOT EXISTS {self.schema}")

    def ensure(self, conn=None) -> None:
        if self._ready and conn is None:
            return
        c = conn or self._conn()
        try:
            c.execute(self._ddl())
        finally:
            if conn is None:
                c.close()
        self._ready = True

    def upsert(self, rows: list[dict]) -> None:
        if not rows:
            return
        with self._conn() as c:
            self.ensure(c)
            t = f"{self.schema}.catalog"
            with c.cursor() as cur:
                cur.executemany(
                    f"""INSERT INTO {t} (dataset, venue, "interval", symbol, first_ts, last_ts, rows,
                        gaps, step_ms, by_src, retention, updated_ms)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s)
                        ON CONFLICT (dataset, venue, "interval", symbol) DO UPDATE SET
                        first_ts=EXCLUDED.first_ts, last_ts=EXCLUDED.last_ts, rows=EXCLUDED.rows,
                        gaps=EXCLUDED.gaps, step_ms=EXCLUDED.step_ms, by_src=EXCLUDED.by_src,
                        retention=EXCLUDED.retention, updated_ms=EXCLUDED.updated_ms""",
                    [(r["dataset"], r["venue"], r["interval"], r["symbol"], r["first_ts"],
                      r["last_ts"], r["rows"], r["gaps"], r["step_ms"], json.dumps(r["by_src"]),
                      r["retention"], r["updated_ms"]) for r in rows])
                # a series the lake no longer holds and no fetcher claimed coverage for goes away
                cur.execute(f"DELETE FROM {t} WHERE rows = 0 AND covered_from IS NULL "
                            f"AND covered_to IS NULL")

    def set_coverage(self, dataset, venue, interval, symbol, covered_from, covered_to) -> None:
        with self._conn() as c:
            self.ensure(c)
            c.execute(
                f"""INSERT INTO {self.schema}.catalog (dataset, venue, "interval", symbol, rows,
                    covered_from, covered_to, updated_ms) VALUES (%s,%s,%s,%s,0,%s,%s,%s)
                    ON CONFLICT (dataset, venue, "interval", symbol) DO UPDATE SET
                    covered_from=EXCLUDED.covered_from, covered_to=EXCLUDED.covered_to,
                    updated_ms=EXCLUDED.updated_ms""",
                (dataset, venue, interval, symbol, covered_from, covered_to, _now()))

    def query(self, dataset=None, venue=None, symbol=None, interval=None) -> list[dict]:
        where, args = [], []
        for col, v in (("dataset", dataset), ("venue", venue), ("symbol", symbol), ('"interval"', interval)):
            if v is not None:
                where.append(f"{col} = %s"); args.append(v)
        q = f"SELECT * FROM {self.schema}.catalog" + (" WHERE " + " AND ".join(where) if where else "")
        with self._conn() as c:
            self.ensure(c)
            rows = c.execute(q + ' ORDER BY dataset, venue, "interval", symbol', args).fetchall()
        return [dict(r) for r in rows]

    def drop_schema(self) -> None:      # tests only
        with self._conn() as c:
            c.execute(f"DROP SCHEMA IF EXISTS {self.schema} CASCADE")


class MemoryCatalog:
    """The same contract in a dict - for the tests, never chosen implicitly."""

    def __init__(self):
        self.rows: dict[tuple, dict] = {}

    def ensure(self, conn=None):
        pass

    def upsert(self, rows):
        for r in rows:
            k = (r["dataset"], r["venue"], r["interval"], r["symbol"])
            old = self.rows.get(k, {})
            self.rows[k] = {**{c: None for c in COLS}, **old, **r,
                            "covered_from": old.get("covered_from"), "covered_to": old.get("covered_to")}
        for k in [k for k, v in self.rows.items() if not v["rows"] and v["covered_from"] is None
                  and v["covered_to"] is None]:
            del self.rows[k]

    def set_coverage(self, dataset, venue, interval, symbol, covered_from, covered_to):
        k = (dataset, venue, interval, symbol)
        r = self.rows.setdefault(k, {**{c: None for c in COLS}, "dataset": dataset, "venue": venue,
                                     "interval": interval, "symbol": symbol, "rows": 0, "by_src": {}})
        r.update(covered_from=covered_from, covered_to=covered_to, updated_ms=_now())

    def query(self, dataset=None, venue=None, symbol=None, interval=None):
        return [dict(v) for k, v in sorted(self.rows.items())
                if (dataset is None or k[0] == dataset) and (venue is None or k[1] == venue)
                and (interval is None or k[2] == interval) and (symbol is None or k[3] == symbol)]


_BACKEND: dict = {"b": None}


def backend():
    if _BACKEND["b"] is None:
        _BACKEND["b"] = PgCatalog()
    return _BACKEND["b"]


def use(b) -> None:
    """Swap the backend (tests: MemoryCatalog(), or PgCatalog(schema=...) on a scratch schema)."""
    _BACKEND["b"] = b


# --------------------------------------------------------------------------------------------- #
# computing series stats from the lake
# --------------------------------------------------------------------------------------------- #

def _visible_files(ds: Dataset, part: str, sub: str | None) -> list[Path]:
    from .retention import read_roots
    from .writer import hidden_by_journals
    pdirs = [p for root in read_roots(ds).values() for p in layout.partitions(root, ds, part, sub)]
    hide = hidden_by_journals(pdirs)
    return [f for p in pdirs for f in layout.part_files(p) if os.path.normcase(str(f)) not in hide]


def series_stats(ds: Dataset, part: str, sub: str | None, symbols: list[str] | None = None) -> list[dict]:
    """Catalog rows for the series of one (dataset, venue[, interval]) - all of them, or only
    `symbols` (a symbol with no rows left comes back with rows=0)."""
    from .retention import rule
    files = _visible_files(ds, part, sub)
    has_sym = "symbol" in ds.series
    base = {"dataset": ds.name, "venue": part, "interval": sub or "",
            "retention": rule(ds.name).klass, "updated_ms": _now()}
    empty = {"first_ts": None, "last_ts": None, "rows": 0, "gaps": None, "step_ms": None, "by_src": {}}
    if not files:
        return [{**base, **empty, "symbol": s} for s in (symbols or [])] if has_sym else \
            [{**base, **empty, "symbol": ""}]
    lst = ", ".join("'" + str(f).replace("'", "''") + "'" for f in files)
    src = f"read_parquet([{lst}], union_by_name=true, hive_partitioning=false)"
    tcol = (f'epoch_ms(CAST("{ds.time_col}" AS DATE))' if ds.time_kind == "date" else f'"{ds.time_col}"')
    sym = "symbol" if has_sym else "''"
    where = ""
    con = duckdb.connect()
    try:
        if has_sym and symbols is not None:
            con.register("want", __import__("pyarrow").table({"s": list(symbols)}))
            where = "WHERE symbol IN (SELECT s FROM want)"
        con.execute(f"CREATE TEMP TABLE s AS SELECT {sym} AS sym, {tcol} AS t, {'src' if 'src' in ds.columns else 'NULL'} AS src"
                    f"{', interval_h' if ds.grid == 'median' else ''} FROM {src} {where}")
        agg = {r[0]: {"first_ts": r[1], "last_ts": r[2], "rows": r[3]} for r in
               con.execute("SELECT sym, min(t), max(t), count(*) FROM s GROUP BY sym").fetchall()}
        by_src: dict = {}
        for s_, src_, n in con.execute("SELECT sym, src, count(*) FROM s GROUP BY ALL").fetchall():
            if src_ is not None:
                by_src.setdefault(s_, {})[src_] = n
        gaps: dict = {}
        if ds.grid == "interval" and sub:
            step = interval_ms(sub)
            for s_, g in con.execute(
                    f"SELECT sym, sum(CASE WHEN dt > {step} THEN dt // {step} - 1 ELSE 0 END) FROM "
                    "(SELECT sym, t - lag(t) OVER (PARTITION BY sym ORDER BY t) AS dt FROM "
                    "(SELECT DISTINCT sym, t FROM s)) GROUP BY sym").fetchall():
                gaps[s_] = (int(g or 0), step)
        elif ds.grid == "median":
            q = """
            WITH d AS (SELECT sym, t, interval_h,
                         t - lag(t) OVER (PARTITION BY sym ORDER BY t) AS dt FROM s),
                 m AS (SELECT sym, median(dt) AS med FROM d WHERE dt IS NOT NULL GROUP BY sym)
            SELECT d.sym, any_value(m.med),
                   sum(CASE WHEN d.dt IS NULL THEN 0
                            ELSE greatest(round(d.dt / coalesce(d.interval_h * 3600000, m.med)) - 1, 0)
                            END) FILTER (WHERE d.dt > 1.5 * coalesce(d.interval_h * 3600000, m.med))
            FROM d LEFT JOIN m USING (sym) GROUP BY d.sym"""
            for s_, med, g in con.execute(q).fetchall():
                gaps[s_] = (int(g or 0), int(med) if med is not None else None)
    finally:
        con.close()
    out = []
    names = (symbols if (has_sym and symbols is not None) else sorted(agg)) if has_sym else [""]
    for s_ in names:
        a = agg.get(s_ if has_sym else "")
        if a is None:
            out.append({**base, **empty, "symbol": s_})
            continue
        g = gaps.get(s_ if has_sym else "")
        out.append({**base, "symbol": s_, **a, "gaps": g[0] if g else None,
                    "step_ms": g[1] if g else None, "by_src": by_src.get(s_ if has_sym else "", {})})
    return out


# --------------------------------------------------------------------------------------------- #
# refresh, with the pending queue when Postgres is unreachable
# --------------------------------------------------------------------------------------------- #

def _pending_path() -> Path:
    return layout.hot_root() / "_catalog" / "pending.jsonl"


def _queue(item: dict, err: Exception) -> None:
    p = _pending_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(item) + "\n")
    print(f"  ! lake: catalog unreachable ({type(err).__name__}: {str(err).splitlines()[0][:160]}); "
          f"the write landed, the catalog refresh is queued in {p}", file=sys.stderr)


def _unreachable(e: Exception) -> bool:
    try:
        import psycopg
        if isinstance(e, psycopg.OperationalError):
            return True
    except ImportError:
        return True
    return isinstance(e, (OSError, ImportError))


def drain() -> int:
    """Replay queued refreshes. Returns how many were applied (0 when none or still down)."""
    p = _pending_path()
    if not p.exists():
        return 0
    lines = [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]
    tmp = p.with_name("pending.draining")
    os.replace(p, tmp)
    done = 0
    try:
        for i, it in enumerate(lines):
            if it["op"] == "refresh":
                backend().upsert(series_stats(get(it["dataset"]), it["venue"], it["interval"] or None,
                                              it["symbols"]))
            else:
                backend().set_coverage(it["dataset"], it["venue"], it["interval"], it["symbol"],
                                       it["covered_from"], it["covered_to"])
            done = i + 1
    except Exception:
        with open(p, "a", encoding="utf-8", newline="\n") as f:
            for it in lines[done:]:
                f.write(json.dumps(it) + "\n")
        raise
    finally:
        tmp.unlink(missing_ok=True)
    return done


def refresh_series(ds: Dataset, part: str, sub: str | None, symbols: list[str] | None) -> None:
    item = {"op": "refresh", "dataset": ds.name, "venue": part, "interval": sub or "",
            "symbols": symbols}
    try:
        if _pending_path().exists():
            drain()
        backend().upsert(series_stats(ds, part, sub, symbols))
    except Exception as e:
        if not _unreachable(e):
            raise
        _queue(item, e)


def refresh_partition(ds: Dataset, part: str, sub: str | None) -> None:
    """Every series of one (dataset, venue[, interval]), including ones now emptied."""
    known = [r["symbol"] for r in query(ds.name, part, interval=sub or "")] \
        if "symbol" in ds.series else None
    try:
        rows = series_stats(ds, part, sub, None)
        if known is not None:
            have = {r["symbol"] for r in rows}
            rows += series_stats(ds, part, sub, [s for s in known if s not in have])
        backend().upsert(rows)
    except Exception as e:
        if not _unreachable(e):
            raise
        _queue({"op": "refresh", "dataset": ds.name, "venue": part, "interval": sub or "",
                "symbols": None}, e)


def set_coverage(dataset: str, venue: str, symbol: str, covered_from: int | None,
                 covered_to: int | None, interval: str | None = None) -> None:
    """Record that `venue` was asked for, and answered with, everything it has for the series in
    [covered_from, covered_to] (ms). What lets a fetcher ask only for the missing head/tail."""
    get(dataset)
    venue = venue.lower() if get(dataset).part_key == "venue" else venue
    try:
        backend().set_coverage(dataset, venue, interval or "", symbol, covered_from, covered_to)
    except Exception as e:
        if not _unreachable(e):
            raise
        _queue({"op": "coverage", "dataset": dataset, "venue": venue, "interval": interval or "",
                "symbol": symbol, "covered_from": covered_from, "covered_to": covered_to}, e)


def query(dataset=None, venue=None, symbol=None, interval=None) -> list[dict]:
    return backend().query(dataset, venue.lower() if venue else venue, symbol, interval)


def rebuild(dataset: str | None = None, log=print) -> int:
    """Recompute every series of every partition from the lake (coverage is kept)."""
    from .retention import read_roots
    n = 0
    for name in ([dataset] if dataset else list(DATASETS)):
        ds = get(name)
        combos = set()
        for root in read_roots(ds).values():
            for p in layout.partitions(root, ds):
                v = layout.parse_partition(ds, p)
                combos.add((v[ds.part_key], v.get(ds.sub_key)))
        for part, sub in sorted(combos, key=lambda x: (x[0], x[1] or "")):
            refresh_partition(ds, part, sub)
            n += 1
        log(f"catalog: {name} {len(combos)} partition group(s) refreshed")
    return n
