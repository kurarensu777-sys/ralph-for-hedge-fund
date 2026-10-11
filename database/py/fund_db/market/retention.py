"""Retention and space for the market lake: the rules (retention.toml), and the three jobs that act
on them - usage (what is where, how big), tier (hot -> cold) and prune (-> _retired, never deleted).
tier and prune walk THE LAKE only (hot + cold, the archive class); the cache root has its own
budget ([cache] max_bytes) and its own eviction (cache.py), and is never tiered or pruned.

Nothing here deletes market data. `tier` moves a partition with a VERIFIED copy (every file's
sha256 and Parquet row count re-read at the destination) before the source file is removed; `prune`
moves a partition into <data root>/_retired/market/... the same way, and only the owner frees
_retired. Both are dry runs unless `apply=True`.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path

import pyarrow.parquet as pq

from fund_db import config

from . import layout
from .lock import locked
from .registry import DATASETS, FILES_DIR, Dataset, get


@dataclass(frozen=True)
class Rule:
    dataset: str
    keep_days: int
    tier_after_days: int
    tier_to: Path
    klass: str
    compact_parts: int


class RetentionError(ValueError):
    pass


CLASSES = ("forever", "rolling", "ephemeral")
KEYS = {"keep_days", "tier_after_days", "tier_to", "class", "compact_parts"}
CACHE_KEYS = {"max_bytes"}
DEFAULT_CACHE_MAX_BYTES = 500_000_000         # 500 MB (decimal), the owner's number (B-0335); retention.toml states it too
_CACHE: dict = {}


def _resolve(p: str) -> Path:
    q = Path(p).expanduser()
    return q if q.is_absolute() else config.data_dir() / q


def load(path: Path | None = None) -> dict[str, Rule]:
    """{dataset: Rule} for every registered dataset ([defaults] and built-in defaults fill the
    gaps: keep forever, never tier, tier_to "cold", compact_parts 8; `class`, when not set, is
    "rolling" for a dataset with a prune line and "forever" otherwise). Refuses an
    unknown dataset or key, a negative number, an unknown class, a keep_days on an ARCHIVE
    dataset (settled history is never pruned) and a tier line at or past the prune line."""
    path = Path(path) if path else config.retention_path()
    key = (str(path), str(config.data_dir()), path.stat().st_mtime_ns if path.exists() else 0)
    if _CACHE.get("key") == key:
        return _CACHE["rules"]
    raw = tomllib.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    top = set(raw) - {"defaults", "datasets", "cache"}
    if top:
        raise RetentionError(f"{path}: unknown table(s) {sorted(top)}")
    d = {"keep_days": 0, "tier_after_days": 0, "tier_to": "cold", "class": None, "compact_parts": 8}
    extra = set(raw.get("defaults", {})) - KEYS
    if extra:
        raise RetentionError(f"{path}: unknown [defaults] key(s) {sorted(extra)}")
    d.update(raw.get("defaults", {}))
    per = raw.get("datasets", {})
    unknown = set(per) - set(DATASETS)
    if unknown:
        raise RetentionError(f"{path}: unknown dataset(s) {sorted(unknown)}")
    rules = {}
    for name, ds in DATASETS.items():
        r = dict(d)
        bad = set(per.get(name, {})) - KEYS
        if bad:
            raise RetentionError(f"{path}: [datasets.{name}] unknown key(s) {sorted(bad)}")
        r.update(per.get(name, {}))
        for k in ("keep_days", "tier_after_days", "compact_parts"):
            if not isinstance(r[k], int) or isinstance(r[k], bool) or r[k] < 0:
                raise RetentionError(f"{path}: {name}.{k} must be a non-negative integer")
        if r["class"] is None:      # the class the catalog reports, from the lines themselves
            r["class"] = "rolling" if r["keep_days"] else "forever"
        if r["class"] not in CLASSES:
            raise RetentionError(f"{path}: {name}.class must be one of {CLASSES}")
        if ds.archive and r["keep_days"]:
            raise RetentionError(f"{path}: {name} is an ARCHIVE dataset and can never be pruned "
                                 f"(keep_days must be 0 or absent)")
        if r["keep_days"] and r["tier_after_days"] and r["tier_after_days"] >= r["keep_days"]:
            raise RetentionError(f"{path}: {name}.tier_after_days must be below keep_days")
        rules[name] = Rule(name, r["keep_days"], r["tier_after_days"], _resolve(r["tier_to"]),
                           r["class"], max(1, r["compact_parts"]))
    c = raw.get("cache", {})
    bad = set(c) - CACHE_KEYS
    if bad:
        raise RetentionError(f"{path}: [cache] unknown key(s) {sorted(bad)}")
    mb = c.get("max_bytes", DEFAULT_CACHE_MAX_BYTES)
    if not isinstance(mb, int) or isinstance(mb, bool) or mb < 0:
        raise RetentionError(f"{path}: [cache] max_bytes must be a non-negative integer (bytes)")
    _CACHE.update(key=key, rules=rules, cache_max_bytes=mb)
    return rules


def cache_max_bytes() -> int:
    """retention.toml [cache] max_bytes: the cache root's byte budget."""
    load()
    return _CACHE["cache_max_bytes"]


def rule(name: str) -> Rule:
    return load()[name]


def tier_roots(ds: Dataset) -> dict[str, Path]:
    """THE LAKE's roots for `ds`: the hot lake, then its cold tier (what tier and prune walk)."""
    return {"hot": layout.hot_root(), "cold": rule(ds.name).tier_to}


def read_roots(ds: Dataset) -> dict[str, Path]:
    """Every root a reader (and the writer's merge) walks for `ds`: the lake, then the cache."""
    return {**tier_roots(ds), "cache": layout.cache_root()}


# --------------------------------------------------------------------------------------------- #
# usage
# --------------------------------------------------------------------------------------------- #

def _dir_bytes(p: Path) -> tuple[int, int]:
    n = b = 0
    if p.is_dir():
        for root, _, files in os.walk(p):
            for f in files:
                try:
                    b += os.path.getsize(os.path.join(root, f)); n += 1
                except OSError:
                    pass
    return n, b


def usage(rows: bool = True) -> dict:
    """{"datasets": [{dataset, tier, root, partitions, files, bytes, rows, first_month,
    last_month}], "other": [{name, path, files, bytes}], "total_bytes"}. `tier` is hot | cold |
    cache. `rows` reads each
    part's Parquet footer (cheap: no data pages)."""
    out, total = [], 0
    for name, ds in DATASETS.items():
        for tier, root in read_roots(ds).items():
            parts = layout.partitions(root, ds)
            if not parts:
                continue
            files = [f for p in parts for f in layout.part_files(p)]
            b = sum(f.stat().st_size for f in files)
            n = sum(pq.ParquetFile(f).metadata.num_rows for f in files) if rows else None
            months = sorted(p.name[6:] for p in parts)
            out.append({"dataset": name, "tier": tier, "root": str(root), "partitions": len(parts),
                        "files": len(files), "bytes": b, "rows": n,
                        "first_month": months[0], "last_month": months[-1]})
            total += b
    other = []
    for label, p in (("_files", layout.hot_root() / FILES_DIR), ("live", config.live_dir()),
                     ("pins", config.pins_dir()), ("blobs", config.blobs_dir()),
                     ("_retired", config.retired_dir())):
        n, b = _dir_bytes(p)
        if label == "pins":                      # the blob seat lives inside pins/ and has its own row
            bn, bb = _dir_bytes(config.blobs_dir())
            n, b = n - bn, b - bb
        other.append({"name": label, "path": str(p), "files": n, "bytes": b})
        total += b
    return {"datasets": out, "other": other, "total_bytes": total}


# --------------------------------------------------------------------------------------------- #
# moving partitions: tier and prune share one verified move
# --------------------------------------------------------------------------------------------- #

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _verified_move(src_dir: Path, dst_dir: Path) -> dict:
    """Move every file of one partition from src_dir to dst_dir. Each file is copied, fsynced,
    re-read at the destination (sha256, and the Parquet row count for a part), and only then
    removed at the source. A destination file of the same name must be byte-identical or the
    move stops with the source intact."""
    dst_dir.mkdir(parents=True, exist_ok=True)
    moved = rows = 0
    for f in sorted(src_dir.iterdir()):
        if f.is_dir():
            raise RetentionError(f"unexpected directory inside a partition: {f}")
        d = dst_dir / f.name
        digest = sha256(f)
        n_src = pq.ParquetFile(f).metadata.num_rows if f.suffix == ".parquet" else None
        if d.exists():
            if sha256(d) != digest:
                raise RetentionError(f"destination {d} exists and differs from {f}; source kept")
        else:
            tmp = d.with_name("." + d.name + ".moving")
            shutil.copy2(f, tmp)
            with open(tmp, "rb+") as fh:
                os.fsync(fh.fileno())
            os.replace(tmp, d)
        if sha256(d) != digest or (n_src is not None and pq.ParquetFile(d).metadata.num_rows != n_src):
            raise RetentionError(f"verify failed for {d}; source {f} kept")
        rows += n_src or 0
        f.unlink()
        moved += 1
    try:
        src_dir.rmdir()
        parent = src_dir.parent
        while parent.name and "=" in parent.name and not any(parent.iterdir()):
            parent.rmdir(); parent = parent.parent
    except OSError:
        pass
    return {"files": moved, "rows": rows}


def _due(parts: list[Path], days: int, now_ms: int) -> list[Path]:
    cutoff = now_ms - days * 86_400_000
    return [p for p in parts if layout.month_end_ms(p.name[6:]) <= cutoff]


def _plan(kind: str, dataset: str | None, now_ms: int | None) -> list[tuple[Dataset, Path, Path]]:
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    plan = []
    for name in ([dataset] if dataset else list(DATASETS)):
        ds, r = get(name), rule(name)
        if kind == "tier":
            if not r.tier_after_days or r.tier_to.resolve() == layout.hot_root().resolve():
                continue
            for p in _due(layout.partitions(layout.hot_root(), ds), r.tier_after_days, now_ms):
                plan.append((ds, p, r.tier_to / p.relative_to(layout.hot_root())))
        else:
            if not r.keep_days or ds.archive:
                continue
            dest_root = config.retired_dir() / "market"
            for root in tier_roots(ds).values():
                for p in _due(layout.partitions(root, ds), r.keep_days, now_ms):
                    plan.append((ds, p, dest_root / p.relative_to(root)))
    return plan


def moves(kind: str, dataset: str | None = None, apply: bool = False, now_ms: int | None = None):
    """tier / prune one partition at a time: yields each item as it is planned (dry run) or moved
    (apply), so a caller that must report a move stopped part-way can still say which partitions
    already went. tier() and prune() are this, collected."""
    from .writer import partition_lock_name, recover
    for ds, src, dst in _plan(kind, dataset, now_ms):
        item = {"dataset": ds.name, "from": str(src), "to": str(dst),
                "bytes": sum(f.stat().st_size for f in src.iterdir() if f.is_file())}
        if apply:
            vals = layout.parse_partition(ds, src)
            with locked(layout.hot_root() / "_locks",
                        partition_lock_name(ds, vals[ds.part_key], vals.get(ds.sub_key), vals["month"])):
                recover(src)
                item.update(_verified_move(src, dst))
            if ds.name != "conflicts":
                from . import catalog
                catalog.refresh_partition(ds, vals[ds.part_key], vals.get(ds.sub_key))
        yield item


def tier(dataset: str | None = None, apply: bool = False, now_ms: int | None = None) -> list[dict]:
    """Move hot partitions past their tier_after_days to the dataset's tier_to. Dry run unless
    apply=True. Returns one item per partition."""
    return list(moves("tier", dataset, apply, now_ms))


def prune(dataset: str | None = None, apply: bool = False, now_ms: int | None = None) -> list[dict]:
    """Move partitions past keep_days (either tier) to <data root>/_retired/market/. Never
    deletes; archive datasets are never touched. Dry run unless apply=True."""
    return list(moves("prune", dataset, apply, now_ms))
