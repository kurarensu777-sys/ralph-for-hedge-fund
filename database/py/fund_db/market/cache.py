"""The CACHE: re-fetchable market data under <data root>/cache (the lake's layout, locks, journal and
merge rules), held to a byte budget - retention.toml [cache] max_bytes, 500 MB (the owner's number,
B-0335; 2 GiB under B-0322). Anything a venue serves again is cache class by default (registry.py, storage.py).

    fund_db.market.cache_usage()                    what the cache holds, against its budget
    fund_db.market.evict()                          down to max_bytes, least-recently-READ month first
    fund_db.market.evict(to_bytes=0, apply=False)   the plan only
    fund_db.market.clean(idle_days=14)              the weekly clean: idle months, then the budget, + sizes
    python -m fund_db cache --usage | --evict [--to BYTES] [--dry-run] | --clean [--idle-days N] [--dry]
                            | --reclassify [--apply]

EVICTION IS A REAL DELETE, and the one delete in this repo that needs no verified copy: the cache
is REBUILDABLE, not data (a law exception) - every row in it is one a
venue serves again, and the rows a recorded result used are PINNED (pinning.py) outside it. It takes
whole month partitions, under each partition's writer lock, only below the cache root (a path
outside it is refused), never a partition whose series is ARCHIVE (the guard: archive data never
enters the cache, and the doctor goes red if it did). After a month goes, the catalog is refreshed
and the fetch coverage (covered_from/covered_to) of every series in it is CLEARED, so a fetcher
re-asks the venue rather than trusting a hole.

LAST-READ. market.cache_parts holds one row per cache month (bytes, written_ms, last_read_ms).
A write records its months (after_write), and a typed read through reader.read() marks the months
it opened (touch_read, at most once a minute per month per process). A read through a
fund_db.sql() view is not tracked. The disk is the truth: a month on disk with no row is ordered
by its newest file's mtime; a row with no month on disk is forgotten.

RECLASSIFY (B-0322 gate 2). reclassify() plans, and with apply=True performs, the move of every
lake month whose series are all cache class into the cache (the retention module's verified move:
copy, fsync, sha256 and row count re-read, then the source goes), and pulls any archive series the
cache holds into the lake. A lake month of class none (legacy quotes, orderbook) or of mixed
classes is kept and reported. apply=True is refused while no pin exists: the recorded results'
inputs are pinned first (platform-core's backfill), then the lake moves.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from . import layout
from .lock import locked
from .registry import DATASETS, Dataset, get

TOUCH_EVERY_MS = 60_000
_TOUCHED: dict[tuple, int] = {}


class CacheError(ValueError):
    pass


def _now() -> int:
    return int(time.time() * 1000)


def _backend():
    from .storage import backend
    return backend()


def _soft(what: str, e: Exception) -> None:
    from fund_db.errors import is_unavailable
    if not is_unavailable(e):
        raise e
    print(f"  ! cache: {what} not recorded ({type(e).__name__}: {str(e).splitlines()[0][:120]})",
          file=sys.stderr)


def _key(ds: Dataset, part: str, sub: str | None, month: str) -> tuple:
    return (ds.name, part, sub or "", month)


def _dir_stats(pdir: Path) -> tuple[int, int, int]:
    """(bytes, files, newest mtime ms) of a partition dir's part files."""
    b = n = m = 0
    for f in layout.part_files(pdir):
        try:
            st = f.stat()
        except OSError:
            continue
        b += st.st_size; n += 1; m = max(m, int(st.st_mtime * 1000))
    return b, n, m


def partitions() -> list[dict]:
    """Every month partition on disk under the cache root: {dataset, venue, interval, month, dir,
    bytes, files, written_ms, last_read_ms, order_ms} (order_ms = what eviction sorts on)."""
    root = layout.cache_root()
    rows = []
    for ds in DATASETS.values():
        for p in layout.partitions(root, ds):
            v = layout.parse_partition(ds, p)
            b, n, m = _dir_stats(p)
            if not n:
                continue
            rows.append({"dataset": ds.name, "venue": v[ds.part_key], "interval": v.get(ds.sub_key) or "",
                         "month": v["month"], "dir": p, "bytes": b, "files": n, "mtime_ms": m})
    try:
        meta = {(r["dataset"], r["venue"], r["interval"], r["month"]): r for r in _backend().cache_list()}
    except Exception as e:
        _soft("last-read times", e)
        meta = {}
    for r in rows:
        mt = meta.get((r["dataset"], r["venue"], r["interval"], r["month"]), {})
        r["written_ms"] = mt.get("written_ms") or r["mtime_ms"]
        r["last_read_ms"] = mt.get("last_read_ms")
        r["order_ms"] = max(r["last_read_ms"] or 0, r["written_ms"] or 0)
    return rows


def max_bytes() -> int:
    from .retention import cache_max_bytes
    return cache_max_bytes()


def cache_usage() -> dict:
    """{root, max_bytes, bytes, files, partitions, over_budget, oldest_read_ms, datasets: [{dataset,
    bytes, files, partitions}]} - measured on disk now."""
    parts = partitions()
    per: dict[str, dict] = {}
    for p in parts:
        d = per.setdefault(p["dataset"], {"dataset": p["dataset"], "bytes": 0, "files": 0, "partitions": 0})
        d["bytes"] += p["bytes"]; d["files"] += p["files"]; d["partitions"] += 1
    total = sum(p["bytes"] for p in parts)
    mb = max_bytes()
    return {"root": str(layout.cache_root()), "max_bytes": mb, "bytes": total,
            "files": sum(p["files"] for p in parts), "partitions": len(parts),
            "over_budget": total > mb,
            "oldest_read_ms": min((p["order_ms"] for p in parts), default=None),
            "datasets": sorted(per.values(), key=lambda d: -d["bytes"])}


# --------------------------------------------------------------------------------------------- #
# bookkeeping: writes and reads
# --------------------------------------------------------------------------------------------- #

def after_write(ds: Dataset, homes: dict[tuple, Path], now: int) -> None:
    """A write landed in these cache months ({(part, sub, month): dir}): record them, then hold
    the budget (never evicting one of them)."""
    rows = []
    for (part, sub, month), d in homes.items():
        b, n, _ = _dir_stats(d)
        rows.append({"dataset": ds.name, "venue": part, "interval": sub or "", "month": month,
                     "bytes": b, "files": n, "written_ms": now})
    try:
        _backend().cache_written(rows)
    except Exception as e:
        _soft("the written months", e)
    protect = {_key(ds, p, s, m) for (p, s, m) in homes}
    total = sum(_dir_stats(p)[0] for p in _cache_dirs())
    if total > max_bytes():
        evict(max_bytes(), apply=True, protect=protect)


def _cache_dirs() -> list[Path]:
    root = layout.cache_root()
    return [p for ds in DATASETS.values() for p in layout.partitions(root, ds)]


def touch_read(files: list[tuple[Path, dict]], ds: Dataset) -> None:
    """Mark the cache months a read opened (reader.read calls it; at most once a minute each)."""
    now = _now()
    root = os.path.normcase(str(layout.cache_root()))
    keys = set()
    for f, vals in files:
        if os.path.normcase(str(f)).startswith(root + os.sep):
            k = _key(ds, vals[ds.part_key], vals.get(ds.sub_key), vals["month"])
            if now - _TOUCHED.get(k, 0) >= TOUCH_EVERY_MS:
                keys.add(k)
    if not keys:
        return
    try:
        _backend().cache_read(sorted(keys), now)
        for k in keys:
            _TOUCHED[k] = now
    except Exception as e:
        _soft("the read time", e)


# --------------------------------------------------------------------------------------------- #
# eviction
# --------------------------------------------------------------------------------------------- #

def _symbols(ds: Dataset, pdir: Path) -> list[str]:
    if "symbol" not in ds.series:
        return [""]
    import pyarrow.parquet as pq
    out: set[str] = set()
    for f in layout.part_files(pdir):
        out.update(x for x in pq.read_table(f, columns=["symbol"]).column("symbol").to_pylist() if x)
    return sorted(out)


def _archive_symbols(ds: Dataset, part: str, sub: str | None, syms: list[str]) -> list[str]:
    from .storage import series_class
    return [s for s in syms if series_class(ds.name, part, s, sub) == "archive"]


def _drop_partition(ds: Dataset, pdir: Path) -> int:
    """Delete one cache month (every file, then the empty folders). Returns bytes freed."""
    from .writer import partition_lock_name, recover
    from .writer import _remove
    try:
        pdir.resolve().relative_to(layout.cache_root().resolve())
    except ValueError:
        raise CacheError(f"refusing to evict {pdir}: it is not under the cache root") from None
    v = layout.parse_partition(ds, pdir)
    freed = 0
    with locked(layout.hot_root() / "_locks",
                partition_lock_name(ds, v[ds.part_key], v.get(ds.sub_key), v["month"])):
        recover(pdir)
        for f in sorted(pdir.iterdir()):
            if f.is_file():
                n = f.stat().st_size
                if not _remove(f):
                    raise CacheError(f"could not delete {f} (held open); the month stays")
                freed += n
        parent = pdir
        root = layout.cache_root().resolve()
        while parent.resolve() != root and parent.exists() and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent
    return freed


def evict(to_bytes: int | None = None, apply: bool = True, protect=(), idle_before_ms: int | None = None) -> dict:
    """Delete whole cache months, least-recently-read first, until the cache holds at most
    `to_bytes` (default: [cache] max_bytes). With `idle_before_ms`, every month whose newest
    read-or-write is older than it goes too, whatever the total. apply=False is the plan. A month
    holding an ARCHIVE series is never evicted (it is reported under `refused`). Returns
    {before_bytes, after_bytes, max_bytes, to_bytes, evicted: [{dataset, venue, interval, month,
    bytes, last_read_ms}], refused}."""
    from . import catalog
    mb = max_bytes()
    target = mb if to_bytes is None else int(to_bytes)
    if target < 0:
        raise CacheError("to_bytes must be >= 0")
    parts = sorted(partitions(), key=lambda p: (p["order_ms"], p["dataset"], p["venue"], p["interval"], p["month"]))
    before = sum(p["bytes"] for p in parts)
    total, evicted, refused = before, [], []
    protect = set(protect)
    for p in parts:
        # oldest first, so the idle months come before any month the budget alone would take
        if total <= target and not (idle_before_ms is not None and p["order_ms"] < idle_before_ms):
            break
        ds = get(p["dataset"])
        k = _key(ds, p["venue"], p["interval"] or None, p["month"])
        if k in protect:
            continue
        syms = _symbols(ds, p["dir"])
        arch = _archive_symbols(ds, p["venue"], p["interval"] or None, [s for s in syms if s])
        item = {"dataset": ds.name, "venue": p["venue"], "interval": p["interval"], "month": p["month"],
                "bytes": p["bytes"], "last_read_ms": p["last_read_ms"]}
        if arch:
            refused.append({**item, "why": f"holds ARCHIVE series {arch[:5]}; the cache never evicts one "
                                           f"(reclassify moves it into the lake)"})
            continue
        if apply:
            item["bytes"] = _drop_partition(ds, p["dir"])
            try:
                _backend().cache_forget([k])
            except Exception as e:
                _soft("the evicted month", e)
            sub = p["interval"] or None
            for s in syms:
                if s:
                    catalog.set_coverage(ds.name, p["venue"], s, None, None, interval=sub)
            catalog.refresh_partition(ds, p["venue"], sub)
        total -= item["bytes"]
        evicted.append(item)
    return {"before_bytes": before, "after_bytes": total, "max_bytes": mb, "to_bytes": target,
            "apply": apply, "evicted": evicted, "refused": refused}


DAY_MS = 86_400_000


def _tree_bytes(root: Path, parts_only: bool = False) -> tuple[int, int]:
    """(files, bytes) under `root`; parts_only counts Parquet part files only."""
    n = b = 0
    for dirpath, _, names in os.walk(root):
        for f in names:
            if parts_only and not (f.startswith("part-") and f.endswith(".parquet")):
                continue
            try:
                b += os.path.getsize(os.path.join(dirpath, f)); n += 1
            except OSError:
                pass
    return n, b


def sizes() -> dict:
    """The three classes on disk, measured now: cache_bytes (the CACHE root), pins (count) and
    pins_bytes (PINS), archive_bytes (the lake's Parquet parts, hot + cold: ARCHIVE class only since
    the reclassify), blobs (count) and blobs_bytes (the PIN class's blob seat, B-0648; pins_bytes is
    the row pins' only), files_bytes (the lake's _files area, not market data), and ops_bytes (the
    ops database, None when Postgres does not answer)."""
    from fund_db import config
    from .retention import tier_roots
    arch = 0
    for ds in DATASETS.values():
        for root in tier_roots(ds).values():
            for p in layout.partitions(root, ds):
                arch += sum(f.stat().st_size for f in layout.part_files(p))
    blobs_bytes = _tree_bytes(config.blobs_dir())[1]
    out = {"cache_bytes": _tree_bytes(layout.cache_root(), True)[1],
           "pins": 0, "pins_bytes": _tree_bytes(config.pins_dir())[1] - blobs_bytes,
           "blobs": 0, "blobs_bytes": blobs_bytes, "archive_bytes": arch,
           "files_bytes": _tree_bytes(layout.hot_root() / "_files")[1], "ops_bytes": None}
    try:
        out["pins"] = _backend().pin_count()
        out["blobs"] = len(_backend().blob_list())
    except Exception as e:
        _soft("the pin and blob counts", e)
    try:
        from fund_db import connect
        with connect() as c:
            out["ops_bytes"] = int(c.execute("SELECT pg_database_size(current_database()) AS n").fetchone()["n"])
    except Exception as e:
        _soft("the ops store size", e)
    return out


def clean(idle_days: int = 14, apply: bool = True, now_ms: int | None = None) -> dict:
    """The weekly clean: evict every cache month nobody READ or WROTE in `idle_days` (last-read
    tracking, see the module doc), then evict to the budget if still over. A real delete of CACHE
    bytes only (evict()'s guards: under the cache root, never an ARCHIVE series; pins live outside
    the cache and are not reachable from here). apply=False plans. Returns {ok, error, evicted_months,
    evicted_bytes, kept_months, before_bytes, after_bytes (what remains, or would when dry),
    budget_bytes, refused_months, idle_days, dry} plus the sizes() of the three classes (the disk
    now, so cache_bytes == after_bytes once applied and == before_bytes when dry)."""
    if idle_days < 0:
        raise CacheError("idle_days must be >= 0")
    now = _now() if now_ms is None else int(now_ms)
    n_before = len(partitions())
    r = evict(apply=apply, idle_before_ms=now - idle_days * DAY_MS)
    sz = sizes()                            # the disk NOW: after the delete when applied, unchanged when dry
    out = {"ok": True, "error": None, "evicted_months": len(r["evicted"]), "before_bytes": r["before_bytes"],
           "evicted_bytes": sum(e["bytes"] for e in r["evicted"]),
           "kept_months": n_before - len(r["evicted"]), "after_bytes": r["after_bytes"],
           "budget_bytes": r["max_bytes"], "refused_months": len(r["refused"]),
           "idle_days": idle_days, "dry": not apply, **sz}
    if r["after_bytes"] > r["max_bytes"]:
        out["ok"] = False
        out["error"] = (f"the cache is still over its budget after the clean ({r['after_bytes']:,} of "
                        f"{r['max_bytes']:,} bytes): {len(r['refused'])} month(s) refused")
    out["evicted"] = r["evicted"]; out["refused"] = r["refused"]
    return out


# --------------------------------------------------------------------------------------------- #
# the doctor's two properties
# --------------------------------------------------------------------------------------------- #

def archive_in_cache() -> list[dict]:
    """Every cache month holding an ARCHIVE series: [{dataset, venue, interval, month, symbols}]."""
    out = []
    for p in partitions():
        ds = get(p["dataset"])
        if ds.storage == "archive":
            out.append({**{k: p[k] for k in ("dataset", "venue", "interval", "month")}, "symbols": ["*"]})
            continue
        arch = _archive_symbols(ds, p["venue"], p["interval"] or None, [s for s in _symbols(ds, p["dir"]) if s])
        if arch:
            out.append({**{k: p[k] for k in ("dataset", "venue", "interval", "month")}, "symbols": arch})
    return out


# --------------------------------------------------------------------------------------------- #
# reclassify: the existing lake into its classes (gated on the pin backfill)
# --------------------------------------------------------------------------------------------- #

def reclassify(apply: bool = False, dataset: str | None = None) -> dict:
    """Plan (apply=False) or perform the move of the lake into its storage classes. Returns
    {apply, to_cache: [...], to_lake: [...], kept: [...], moved_bytes}; each item names the
    dataset, venue, interval, month, bytes (and rows once moved)."""
    from . import catalog
    from .retention import _verified_move, tier_roots
    from .storage import backend, series_class
    from .writer import compact_partition, partition_lock_name, recover
    if apply:
        n = backend().pin_count()
        if n == 0:
            raise CacheError("reclassify --apply is refused: no pin exists yet. The inputs of every "
                             "recorded result are pinned first (B-0322 gate 2, platform-core's pin "
                             "backfill); only then does the lake move")
    out = {"apply": apply, "to_cache": [], "to_lake": [], "kept": [], "moved_bytes": 0}
    names = [dataset] if dataset else list(DATASETS)
    for name in names:
        ds = get(name)
        for tier, root in tier_roots(ds).items():
            for p in layout.partitions(root, ds):
                v = layout.parse_partition(ds, p)
                part, sub, month = v[ds.part_key], v.get(ds.sub_key), v["month"]
                b, n, _ = _dir_stats(p)
                if not n:
                    continue
                item = {"dataset": name, "venue": part, "interval": sub or "", "month": month,
                        "tier": tier, "bytes": b}
                if ds.storage == "archive":
                    continue
                classes = {series_class(name, part, s, sub) for s in _symbols(ds, p)} or {ds.storage}
                if classes == {"cache"}:
                    dst = layout.cache_root() / p.relative_to(root)
                    item["to"] = str(dst)
                    if apply:
                        with locked(layout.hot_root() / "_locks", partition_lock_name(ds, part, sub, month)):
                            recover(p)
                            item.update(_verified_move(p, dst))
                        try:
                            bb, nn, _ = _dir_stats(dst)
                            backend().cache_written([{"dataset": name, "venue": part, "interval": sub or "",
                                                      "month": month, "bytes": bb, "files": nn,
                                                      "written_ms": _now()}])
                        except Exception as e:
                            _soft("the moved month", e)
                        catalog.refresh_partition(ds, part, sub)
                        out["moved_bytes"] += b
                    out["to_cache"].append(item)
                elif classes == {"archive"}:
                    continue
                else:
                    item["why"] = ("class none (stored nowhere today, re-fetchable from nowhere): kept in "
                                   "place, never moved into the cache" if classes == {"none"} else
                                   f"mixed classes {sorted(classes)} in one month: kept in place")
                    out["kept"].append(item)
        # archive series found in the cache move into the lake
        for p in layout.partitions(layout.cache_root(), ds):
            v = layout.parse_partition(ds, p)
            part, sub, month = v[ds.part_key], v.get(ds.sub_key), v["month"]
            arch = _archive_symbols(ds, part, sub, [s for s in _symbols(ds, p) if s]) \
                if ds.storage != "archive" else ["*"]
            if not arch:
                continue
            item = {"dataset": name, "venue": part, "interval": sub or "", "month": month,
                    "bytes": _dir_stats(p)[0], "symbols": arch}
            if apply:
                if ds.storage == "archive":
                    dst = layout.hot_root() / p.relative_to(layout.cache_root())
                    with locked(layout.hot_root() / "_locks", partition_lock_name(ds, part, sub, month)):
                        recover(p)
                        item.update(_verified_move(p, dst))
                else:
                    item.update(compact_partition(ds, part, sub, month, cls="archive"))
                catalog.refresh_partition(ds, part, sub)
            out["to_lake"].append(item)
    return out
