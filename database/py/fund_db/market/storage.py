"""Storage classes: which class a write lands in, the per-series ARCHIVE declarations, and the one
metadata backend the cache and the pins keep their index in (B-0322; the classes are in registry.py).

    fund_db.market.declare_archive("exchange_a", [{"dataset": "candles", "symbol": "*", "interval": "*"}],
                                   why="the venue serves only recent bars", source="exchange_a venue config")
    fund_db.market.archive_declarations("exchange_a")

THE SEAM. A venue's archive list lives in its venue config (`storage.archive`);
platform's store seam hands it here with declare_archive, which REPLACES that venue's whole list.
`symbol` and `interval` are fnmatch globs, case-sensitive ("*" = every one; a dataset without an
interval matches on ""); so is the stored `venue` (a venue.json declares its own venue; "*" is
for a fund-wide rule). A declaration may name a class-none dataset: that is the explicit exception
by which one quote or trade series is kept. The writer resolves every series of a write
(resolve()):

    requested None       declared -> "archive"; else the dataset's default class
    requested "archive"  refused unless declared or the dataset's default is archive
    requested "cache"    refused when the series is declared or the dataset is archive-class
    class "none"         refused (stored nowhere);  "pin" refused (pins.pin() is the only door)

The declarations are read from Postgres (market.archive_decl) and held in-process for DECL_TTL_S;
every successful read is mirrored to <hot>/_storage/archive.json, which the writer falls back on
when Postgres is unreachable. Neither available -> the write raises (errors.unavailable()): an
archive series is never guessed into the cache.

THE BACKEND. PgStorage (market.archive_decl, market.cache_parts, market.pins, market.pin_refs,
market.blobs, market.blob_refs) is
the default; MemoryStorage keeps the same contract in dicts for the lake tests and is never chosen
implicitly (the same pattern as catalog.py).
"""
from __future__ import annotations

import json
import os
import time
from fnmatch import fnmatchcase
from pathlib import Path

from . import layout
from .registry import CLASSES, DATASETS, get

DECL_TTL_S = 30.0


class StorageError(ValueError):
    """A write or a declaration that breaks the storage-class contract."""


def _now() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------------------------- #
# backends
# --------------------------------------------------------------------------------------------- #

class PgStorage:
    """The storage metadata in the ops store (migration market/004), through fund_db.db."""

    def _conn(self):
        from fund_db import db
        return db.connect(autocommit=True, connect_timeout=3)

    # declarations
    def decl_replace(self, venue: str, rows: list[dict]) -> None:
        with self._conn() as c, c.transaction():
            c.execute("DELETE FROM market.archive_decl WHERE venue = %s", (venue,))
            with c.cursor() as cur:
                cur.executemany(
                    'INSERT INTO market.archive_decl (venue, dataset, symbol, "interval", why, source, '
                    "declared_ms) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    [(r["venue"], r["dataset"], r["symbol"], r["interval"], r["why"], r["source"],
                      r["declared_ms"]) for r in rows])

    def decl_list(self) -> list[dict]:
        with self._conn() as c:
            return [dict(r) for r in c.execute(
                'SELECT venue, dataset, symbol, "interval", why, source, declared_ms '
                'FROM market.archive_decl ORDER BY venue, dataset, symbol, "interval"').fetchall()]

    # cache partitions
    def cache_written(self, rows: list[dict]) -> None:
        with self._conn() as c, c.cursor() as cur:
            cur.executemany(
                'INSERT INTO market.cache_parts (dataset, venue, "interval", month, bytes, files, written_ms) '
                "VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (dataset, venue, \"interval\", month) DO UPDATE "
                "SET bytes = EXCLUDED.bytes, files = EXCLUDED.files, written_ms = EXCLUDED.written_ms",
                [(r["dataset"], r["venue"], r["interval"], r["month"], r["bytes"], r["files"],
                  r["written_ms"]) for r in rows])

    def cache_read(self, keys: list[tuple], now: int) -> None:
        with self._conn() as c, c.cursor() as cur:
            cur.executemany(
                'UPDATE market.cache_parts SET last_read_ms = %s WHERE dataset = %s AND venue = %s '
                'AND "interval" = %s AND month = %s', [(now, *k) for k in keys])

    def cache_list(self) -> list[dict]:
        with self._conn() as c:
            return [dict(r) for r in c.execute(
                'SELECT dataset, venue, "interval", month, bytes, files, written_ms, last_read_ms '
                "FROM market.cache_parts").fetchall()]

    def cache_forget(self, keys: list[tuple]) -> None:
        with self._conn() as c, c.cursor() as cur:
            cur.executemany('DELETE FROM market.cache_parts WHERE dataset = %s AND venue = %s AND '
                            '"interval" = %s AND month = %s', keys)

    # pins
    def pin_put(self, idx: dict, ref: dict) -> None:
        with self._conn() as c, c.transaction():
            cols = list(idx)
            c.execute(f"INSERT INTO market.pins ({', '.join(_q(k) for k in cols)}) VALUES "
                      f"({', '.join('%s' for _ in cols)}) ON CONFLICT (hash) DO NOTHING",
                      [idx[k] for k in cols])
            c.execute("INSERT INTO market.pin_refs (hash, ref, reason, created_ms) VALUES (%s,%s,%s,%s) "
                      "ON CONFLICT (hash, ref) DO NOTHING",
                      (ref["hash"], ref["ref"], ref["reason"], ref["created_ms"]))

    def pin_list(self, **f) -> list[dict]:
        where, args = [], []
        for k, v in f.items():
            if v is not None:
                where.append(f"p.{_q(k)} = %s" if k != "ref" else
                             "p.hash IN (SELECT hash FROM market.pin_refs WHERE ref = %s)")
                args.append(v)
        q = ("SELECT p.*, coalesce((SELECT jsonb_agg(jsonb_build_object('ref', r.ref, 'reason', r.reason, "
             "'created_ms', r.created_ms) ORDER BY r.created_ms, r.ref) FROM market.pin_refs r "
             "WHERE r.hash = p.hash), '[]'::jsonb) AS refs FROM market.pins p"
             + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY p.created_ms, p.hash")
        with self._conn() as c:
            return [dict(r) for r in c.execute(q, args).fetchall()]

    def pin_unref(self, h: str, prefixes) -> dict:
        """Drop the refs of pin `h` that start with one of `prefixes`; when none is left, forget the
        pin's index row too. One transaction, so a real ref added meanwhile keeps the pin."""
        with self._conn() as c, c.transaction():
            cond = " OR ".join("starts_with(ref, %s)" for _ in prefixes)
            dropped = [r["ref"] for r in c.execute(
                f"DELETE FROM market.pin_refs WHERE hash = %s AND ({cond}) RETURNING ref", [h, *prefixes]).fetchall()]
            left = c.execute("SELECT count(*) AS n FROM market.pin_refs WHERE hash = %s", (h,)).fetchone()["n"]
            forgot = bool(dropped) and left == 0
            if forgot:
                c.execute("DELETE FROM market.pins WHERE hash = %s", (h,))
        return {"dropped": sorted(dropped), "left": left, "forgot": forgot}

    def pin_count(self) -> int:
        with self._conn() as c:
            return c.execute("SELECT count(*) AS n FROM market.pins").fetchone()["n"]

    # blobs (migration market/005)
    def blob_put(self, idx: dict, ref: dict) -> dict:
        """Insert the blob's index row unless (dataset, key) exists, add the ref when the stored
        hash is this one, and return the STORED row (the caller compares its hash)."""
        from psycopg.types.json import Jsonb
        with self._conn() as c, c.transaction():
            c.execute('INSERT INTO market.blobs (dataset, "key", hash, bytes, meta, built_from, created_ms) '
                      'VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (dataset, "key") DO NOTHING',
                      (idx["dataset"], idx["key"], idx["hash"], idx["bytes"], Jsonb(idx["meta"]),
                       Jsonb(idx["built_from"]), idx["created_ms"]))
            row = dict(c.execute('SELECT * FROM market.blobs WHERE dataset = %s AND "key" = %s',
                                 (idx["dataset"], idx["key"])).fetchone())
            if row["hash"] == idx["hash"]:
                c.execute('INSERT INTO market.blob_refs (dataset, "key", ref, reason, created_ms) '
                          "VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                          (ref["dataset"], ref["key"], ref["ref"], ref["reason"], ref["created_ms"]))
        return row

    def blob_list(self, dataset=None, prefix=None, ref=None, key=None, hash=None) -> list[dict]:
        where, args = [], []
        if dataset is not None:
            where.append("b.dataset = %s")
            args.append(dataset)
        if key is not None:
            where.append('b."key" = %s')
            args.append(key)
        if prefix is not None:
            where.append('starts_with(b."key", %s)')
            args.append(prefix)
        if hash is not None:
            where.append("b.hash = %s")
            args.append(hash)
        if ref is not None:
            where.append('EXISTS (SELECT 1 FROM market.blob_refs r WHERE r.dataset = b.dataset '
                         'AND r."key" = b."key" AND r.ref = %s)')
            args.append(ref)
        q = ("SELECT b.*, coalesce((SELECT jsonb_agg(jsonb_build_object('ref', r.ref, 'reason', r.reason, "
             "'created_ms', r.created_ms) ORDER BY r.created_ms, r.ref) FROM market.blob_refs r "
             'WHERE r.dataset = b.dataset AND r."key" = b."key"), \'[]\'::jsonb) AS refs FROM market.blobs b'
             + (" WHERE " + " AND ".join(where) if where else "") + ' ORDER BY b.dataset, b."key"')
        with self._conn() as c:
            return [dict(r) for r in c.execute(q, args).fetchall()]


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


class MemoryStorage:
    """The same contract in dicts - for the tests, never chosen implicitly."""

    def __init__(self):
        self.decl: list[dict] = []
        self.parts: dict[tuple, dict] = {}
        self.pins: dict[str, dict] = {}
        self.refs: dict[tuple, dict] = {}
        self.blobs_: dict[tuple, dict] = {}
        self.blob_refs_: dict[tuple, dict] = {}

    def decl_replace(self, venue, rows):
        self.decl = [d for d in self.decl if d["venue"] != venue] + [dict(r) for r in rows]

    def decl_list(self):
        return sorted((dict(d) for d in self.decl),
                      key=lambda d: (d["venue"], d["dataset"], d["symbol"], d["interval"]))

    def cache_written(self, rows):
        for r in rows:
            k = (r["dataset"], r["venue"], r["interval"], r["month"])
            old = self.parts.get(k, {})
            self.parts[k] = {**r, "last_read_ms": old.get("last_read_ms")}

    def cache_read(self, keys, now):
        for k in keys:
            if k in self.parts:
                self.parts[k]["last_read_ms"] = now

    def cache_list(self):
        return [dict(v) for v in self.parts.values()]

    def cache_forget(self, keys):
        for k in keys:
            self.parts.pop(tuple(k), None)

    def pin_put(self, idx, ref):
        self.pins.setdefault(idx["hash"], dict(idx))
        self.refs.setdefault((ref["hash"], ref["ref"]), dict(ref))

    def pin_list(self, **f):
        out = []
        for h, p in sorted(self.pins.items(), key=lambda x: (x[1]["created_ms"], x[0])):
            refs = sorted(({"ref": r["ref"], "reason": r["reason"], "created_ms": r["created_ms"]}
                           for (hh, _), r in self.refs.items() if hh == h),
                          key=lambda r: (r["created_ms"], r["ref"]))
            if f.get("ref") is not None and not any(r["ref"] == f["ref"] for r in refs):
                continue
            if any(v is not None and k != "ref" and p.get(k) != v for k, v in f.items()):
                continue
            out.append({**p, "refs": refs})
        return out

    def pin_unref(self, h, prefixes):
        gone = sorted(k[1] for k in self.refs if k[0] == h and k[1].startswith(tuple(prefixes)))
        for r in gone:
            del self.refs[(h, r)]
        left = sum(1 for k in self.refs if k[0] == h)
        forgot = bool(gone) and left == 0
        if forgot:
            self.pins.pop(h, None)
        return {"dropped": gone, "left": left, "forgot": forgot}

    def pin_count(self):
        return len(self.pins)

    def blob_put(self, idx, ref):
        row = self.blobs_.setdefault((idx["dataset"], idx["key"]), dict(idx))
        if row["hash"] == idx["hash"]:
            self.blob_refs_.setdefault((ref["dataset"], ref["key"], ref["ref"]), dict(ref))
        return dict(row)

    def blob_list(self, dataset=None, prefix=None, ref=None, key=None, hash=None):
        out = []
        for (d, k), b in sorted(self.blobs_.items()):
            if (dataset is not None and d != dataset) or (key is not None and k != key) \
                    or (prefix is not None and not k.startswith(prefix)) \
                    or (hash is not None and b["hash"] != hash):
                continue
            refs = sorted(({"ref": r["ref"], "reason": r["reason"], "created_ms": r["created_ms"]}
                           for (rd, rk, _), r in self.blob_refs_.items() if (rd, rk) == (d, k)),
                          key=lambda r: (r["created_ms"], r["ref"]))
            if ref is not None and not any(r["ref"] == ref for r in refs):
                continue
            out.append({**b, "refs": refs})
        return out


_BACKEND: dict = {"b": None}
_DECL: dict = {"rows": None, "at": 0.0}


def backend():
    if _BACKEND["b"] is None:
        _BACKEND["b"] = PgStorage()
    return _BACKEND["b"]


def use(b) -> None:
    """Swap the backend (tests: MemoryStorage()); None goes back to PgStorage."""
    _BACKEND["b"] = b
    _DECL.update(rows=None, at=0.0)


# --------------------------------------------------------------------------------------------- #
# declarations
# --------------------------------------------------------------------------------------------- #

def _mirror_path() -> Path:
    return layout.hot_root() / "_storage" / "archive.json"


def _write_mirror(rows: list[dict]) -> None:
    p = _mirror_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(rows, sort_keys=True), encoding="utf-8")
    try:
        os.replace(tmp, p)
    except PermissionError:          # a reader holds it for a moment (Windows); the next load retries
        tmp.unlink(missing_ok=True)


def declare_archive(venue: str, entries, *, why: str, source: str) -> dict:
    """Replace `venue`'s whole archive list with `entries` ([{dataset, symbol='*', interval='*'
    [, why]}]). An unknown dataset, a none-class dataset or a missing `why`/`source` is refused;
    an empty list is legal (the venue archives nothing). Returns {venue, entries}."""
    venue = str(venue).strip().lower()
    if not venue:
        raise StorageError("declare_archive: no venue")
    if not str(why or "").strip() or not str(source or "").strip():
        raise StorageError("declare_archive: a declaration carries its why and its source "
                           "(the venue.json it came from)")
    rows, seen, now = [], set(), _now()
    for e in entries or []:
        if not isinstance(e, dict) or not e.get("dataset"):
            raise StorageError(f"declare_archive {venue}: entry {e!r} names no dataset")
        ds = get(e["dataset"])
        sym, iv = str(e.get("symbol") or "*"), str(e.get("interval") or "*")
        if not ds.sub_key and iv not in ("*", ""):
            raise StorageError(f"declare_archive {venue}: {ds.name} has no interval; drop {iv!r}")
        k = (ds.name, sym, iv)
        if k in seen:
            continue
        seen.add(k)
        rows.append({"venue": venue, "dataset": ds.name, "symbol": sym, "interval": iv,
                     "why": str(e.get("why") or why).strip(), "source": str(source).strip(),
                     "declared_ms": now})
    backend().decl_replace(venue, rows)
    _DECL.update(rows=None, at=0.0)
    declarations(refresh=True)
    return {"venue": venue, "entries": rows}


def declarations(refresh: bool = False) -> list[dict]:
    """Every archive declaration: from the backend (held DECL_TTL_S), else the mirror file."""
    if not refresh and _DECL["rows"] is not None and time.monotonic() - _DECL["at"] < DECL_TTL_S:
        return _DECL["rows"]
    try:
        rows = backend().decl_list()
    except Exception as e:
        from fund_db.errors import is_unavailable
        if not is_unavailable(e):
            raise
        p = _mirror_path()
        if _DECL["rows"] is not None:
            return _DECL["rows"]
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
        raise
    _DECL.update(rows=rows, at=time.monotonic())
    if isinstance(backend(), PgStorage):
        _write_mirror(rows)
    return rows


def archive_declarations(venue: str | None = None) -> list[dict]:
    """The archive declarations, of one venue or all."""
    rows = declarations(refresh=True)
    return [dict(r) for r in rows if venue is None or r["venue"] == str(venue).lower()]


def declared(dataset: str, venue: str, symbol: str, interval: str | None) -> dict | None:
    """The declaration that makes this series archive, or None."""
    for d in declarations():
        if d["dataset"] == dataset and fnmatchcase(venue, d["venue"]) \
                and fnmatchcase(str(symbol), d["symbol"]) and fnmatchcase(interval or "", d["interval"]):
            return d
    return None


def resolve(dataset: str, venue: str, symbol: str, interval: str | None,
            requested: str | None = None) -> str:
    """The class one series of a write lands in: "archive" or "cache"; else StorageError."""
    ds = get(dataset)
    if requested is not None and requested not in CLASSES:
        raise StorageError(f"storage={requested!r}; it is one of {CLASSES}")
    if requested == "pin":
        raise StorageError(f"{dataset}: a pin is written by fund_db.market.pin(), never by a write")
    if ds.storage == "archive":
        if requested == "cache":
            raise StorageError(f"{dataset} is ARCHIVE class: it never enters the cache")
        return "archive"
    decl = declared(dataset, venue, symbol, interval)
    if decl is not None:
        if requested == "cache":
            raise StorageError(
                f"{dataset} {venue} {symbol} {interval or ''} is declared ARCHIVE "
                f"({decl['source']}): archive data never enters the cache")
        return "archive"
    if requested == "archive":
        raise StorageError(
            f"{dataset} {venue} {symbol} {interval or ''}: a permanent (archive) write is refused - "
            f"the series is not declared archive (venue.json storage.archive, through "
            f"fund_db.market.declare_archive)")
    if ds.storage == "none" or requested == "none":
        raise StorageError(f"{dataset} is class NONE: live data is stored nowhere (B-0322)")
    return "cache"


def series_class(ds_name: str, venue: str, symbol: str, interval: str | None) -> str:
    """What a stored series SHOULD be (no request): archive | cache | none (used by the doctor
    and the reclassify plan; never raises on a none-class dataset)."""
    ds = DATASETS[ds_name]
    if ds.storage == "archive" or declared(ds_name, venue, symbol, interval):
        return "archive"
    return ds.storage
