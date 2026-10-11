"""fund_db.market.edit - ROW-LEVEL REMOVAL from the lake, and the TRASH it moves rows to.

The writer only ever adds or merges rows; retention moves whole partition folders. A caller
that must take chosen rows OUT of the lake (the DATA control panel's delete, and its restore)
does it through the functions below, which honour exactly the locks and the crash-safe rewrite
journal every lake writer and reader honours - a caller never opens a part file, never names a
private writer function, never unlinks or moves anything itself.

    with edit.locked("candles", "exchange_a", "1h", {"2026-09"}):
        part = edit.read_partition("candles", "exchange_a", "1h", "2026-09")
        ...                                           # part.table, part.fingerprint
        edit.replace_partition(part, keep_table)      # journaled rewrite, row count verified

    trash_id = edit.trash_create(plan_id, manifest)
    edit.trash_put(trash_id, "candles", "exchange_a", "1h", "BTC", rows)   # written + re-read
    edit.trash_entries(trash_id) / trash_read(trash_id, file) / trash_retire(trash_id)

THE CORRECTION PATH for a settled row stored wrong (B-0319): `correct_rows` takes out the rows at
exact keys, the whole safety order in one call, and `restore_trash` puts them back.

    edit.correct_rows("contract_bars", "broker_a", "1d", keys, reason="...")           # dry run
    edit.correct_rows("contract_bars", "broker_a", "1d", keys, reason="...", apply=True)
    edit.restore_trash(trash_id)

`keys` are dicts of the dataset's key columns (contract_bars: symbol, what, t). Every key must be
stored (else EditError, nothing moved). The removed rows go VERBATIM into a trash entry first
(re-read verified), then each touched partition is rewritten under its writer lock; a conflict
that already logged the venue's other value is left alone (it is history). The next write of the
key is then a plain add, which is how a re-walk stores the right row. `restore_trash` writes the
rows back verbatim through the merge rules: a key a re-walk has filled since comes back as a
conflict, never an overwrite.

THE SAFETY ORDER a caller keeps (and `replace_partition` cannot check for it): rows leave a
partition only after they are safe AND VERIFIED in the trash (`trash_put` re-reads the row count
before it returns). The trash lives at `<data root>/trash/<trash_id>/` - one Parquet file per
series holding the rows VERBATIM (every column: src, seen, closed) plus `manifest.json`. A trash
entry is never deleted: `trash_retire` MOVES it to `<data root>/_retired/trash/` (rule 5 - only
the owner frees `_retired`).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, unquote

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from fund_db import config

from . import layout
from .lock import locked as _locked
from .registry import Dataset, get
from .writer import (COMPRESSION, _dir_of, _dirs_by_identity, _files_for, _rewrite_dirs,
                     _write_json_atomic, partition_lock_name,
                     recover)

TRASH_EXT = ".parquet"
MANIFEST = "manifest.json"
_TRASH_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


class EditError(ValueError):
    """A partition changed under the caller, or a trash entry is not what it claims."""


def _part(venue: str) -> str:
    return str(venue).lower()


# --------------------------------------------------------------------------------------------- #
# what is there
# --------------------------------------------------------------------------------------------- #

def groups(dataset: str) -> list[tuple[str, str | None]]:
    """Every (venue, interval | None) the lake holds for `dataset`, across every tier."""
    from .retention import read_roots
    ds = get(dataset)
    out: set[tuple[str, str | None]] = set()
    for root in read_roots(ds).values():
        for p in layout.partitions(root, ds):
            v = layout.parse_partition(ds, p)
            out.add((v[ds.part_key], v.get(ds.sub_key)))
    return sorted(out, key=lambda g: (g[0], g[1] or ""))


def _group_files(dataset: str, venue: str, interval: str | None,
                 months: set[str] | None = None) -> list[tuple[Path, str]]:
    from . import reader
    ds = get(dataset)
    fl = reader.files(ds, _part(venue), interval, None, None)
    return [(f, vals["month"]) for f, vals in fl if months is None or vals["month"] in months]


def months(dataset: str, venue: str, interval: str | None = None) -> list[str]:
    """The months a (dataset, venue[, interval]) group holds, sorted."""
    return sorted({m for _, m in _group_files(dataset, venue, interval)})


def group_bytes(dataset: str, venue: str, interval: str | None = None) -> int:
    """Parquet bytes a group holds (visible parts, every tier)."""
    return sum(f.stat().st_size for f, _ in _group_files(dataset, venue, interval))


def fingerprint(dataset: str, venue: str, interval: str | None = None,
                months: set[str] | list[str] | None = None) -> list[list]:
    """[[part file, size, mtime_ns]] of the visible parts of the named months (all when None),
    sorted: what a plan pins its partitions to. Any write to one of those partitions changes it."""
    want = set(months) if months is not None else None
    out = []
    for f, _ in _group_files(dataset, venue, interval, want):
        st = f.stat()
        out.append([str(f), st.st_size, st.st_mtime_ns])
    return sorted(out)


# --------------------------------------------------------------------------------------------- #
# the partition edit
# --------------------------------------------------------------------------------------------- #

@contextmanager
def locked(dataset: str, venue: str, interval: str | None, months):
    """Hold every named partition's writer lock (sorted, so two editors never deadlock) and
    finish or undo any half-done rewrite in them before the block runs."""
    ds, part = get(dataset), _part(venue)
    ms = sorted(set(months))
    with ExitStack() as stack:
        for mo in ms:
            stack.enter_context(_locked(layout.hot_root() / "_locks",
                                        partition_lock_name(ds, part, interval, mo)))
        for mo in ms:
            for d in _files_for(ds, part, interval, mo)[1]:
                if d.is_dir():
                    recover(d)
        yield


@dataclass(frozen=True)
class Partition:
    """One partition as read under `locked`: its rows (every column of the dataset's schema;
    a part written before a column existed reads it as null) and the pin of its part files."""
    dataset: str
    venue: str
    interval: str | None
    month: str
    table: pa.Table
    files: tuple            # opaque to callers: handed back to replace_partition
    fingerprint: tuple      # ((path, size, mtime_ns), ...) sorted


def _conform(ds: Dataset, tbl: pa.Table) -> pa.Table:
    cols = [tbl.column(c).cast(t) if c in tbl.column_names else pa.nulls(tbl.num_rows, t)
            for c, t in ds.fields]
    return pa.Table.from_arrays(cols, schema=ds.schema)


def _pin(files) -> tuple:
    out = []
    for f in files:
        st = Path(f).stat()
        out.append((str(f), st.st_size, st.st_mtime_ns))
    return tuple(sorted(out))


def read_partition(dataset: str, venue: str, interval: str | None, month: str) -> Partition:
    """Every stored row of one partition (both tiers). Call it inside `locked`."""
    ds = get(dataset)
    files = _files_for(ds, _part(venue), interval, month)[2]
    tables = [_conform(ds, pq.read_table(f)) for f in files]
    tbl = pa.concat_tables(tables) if tables else ds.schema.empty_table()
    return Partition(dataset, _part(venue), interval, month, tbl, tuple(str(f) for f in files),
                     _pin(files))


def replace_partition(p: Partition, keep: pa.Table) -> str:
    """Replace the partition `p` was read from with ONE part holding `keep` (the journaled
    rewrite: the new part's row count is verified before anything is replaced), or - when
    nothing is kept - remove its parts. Refuses (EditError) when the partition changed since
    `p` was read. Returns "rewritten" | "emptied" | "unchanged". Call it inside `locked`, and
    only after the removed rows are safe and verified in the trash."""
    ds = get(p.dataset)
    home, _, files = _files_for(ds, p.venue, p.interval, p.month)
    if _pin(files) != p.fingerprint:
        raise EditError(f"{p.dataset} {p.venue} {p.interval or ''} {p.month} changed since it was "
                        f"read; nothing replaced")
    keep = _conform(ds, keep)
    if keep.num_rows == p.table.num_rows:
        return "unchanged"
    if keep.num_rows:
        # each kept row is rewritten in the root it is stored in (the lake or the cache)
        _rewrite_dirs(ds, [Path(f) for f in files], _dirs_by_identity(ds, files, keep, home), home,
                      {_dir_of(f) for f in files}, tag="d")
        return "rewritten"
    for f in files:
        Path(f).unlink()
    return "emptied"


def refresh_series(dataset: str, venue: str, interval: str | None, symbols) -> None:
    """Recompute the catalog rows of `symbols` after their rows changed outside a write."""
    from . import catalog
    catalog.refresh_series(get(dataset), _part(venue), interval, sorted(set(symbols)))


# --------------------------------------------------------------------------------------------- #
# the trash
# --------------------------------------------------------------------------------------------- #

def trash_root() -> Path:
    return config.data_dir() / "trash"


def retired_trash_root() -> Path:
    return config.retired_dir() / "trash"


def _check_id(trash_id: str) -> str:
    if not isinstance(trash_id, str) or not _TRASH_ID_RE.match(trash_id) or ".." in trash_id:
        raise EditError(f"bad trash id {trash_id!r}")
    return trash_id


def trash_dir(trash_id: str) -> Path:
    """The folder of an existing entry (FileNotFoundError when there is none)."""
    d = trash_root() / _check_id(trash_id)
    if not d.is_dir() or not (d / MANIFEST).is_file():
        raise FileNotFoundError(f"no such trash entry: {trash_id}")
    return d


def trash_create(stem: str, manifest: dict) -> str:
    """Open a NEW entry `<utc stamp>__<stem>` (a `-N` suffix when that name is taken) holding
    `manifest`; returns its id."""
    if not re.match(r"^[A-Za-z0-9_.-]{1,64}$", stem or ""):
        raise EditError(f"bad trash stem {stem!r}")
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    root = trash_root()
    root.mkdir(parents=True, exist_ok=True)
    n = 1
    while True:
        tid = f"{stamp}__{stem}" if n == 1 else f"{stamp}-{n}__{stem}"
        try:
            (root / tid).mkdir()
            break
        except FileExistsError:
            n += 1
    _write_json_atomic(root / tid / MANIFEST, {**manifest, "trash_id": tid})
    return tid


def trash_manifest(trash_id: str) -> dict:
    try:
        return json.loads((trash_dir(trash_id) / MANIFEST).read_text(encoding="utf-8"))
    except ValueError:
        return {}


def trash_set_manifest(trash_id: str, manifest: dict) -> None:
    _write_json_atomic(trash_dir(trash_id) / MANIFEST, manifest)


def _series_rel(dataset: str, venue: str, interval: str | None, symbol: str) -> str:
    rel = f"{dataset}/venue={_part(venue)}"
    if interval:
        rel += f"/interval={interval}"
    return f"{rel}/{quote(symbol, safe='')}{TRASH_EXT}"


def trash_put(trash_id: str, dataset: str, venue: str, interval: str | None, symbol: str,
              rows: pa.Table) -> dict:
    """Write one series' removed rows VERBATIM into the entry and re-read the row count before
    returning (OSError when it differs). -> {"file" (relative), "rows", "bytes"}."""
    get(dataset)
    d = trash_dir(trash_id)
    rel = _series_rel(dataset, venue, interval, symbol)
    f = d / rel
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_name(f.name + ".tmp")
    pq.write_table(rows, tmp, compression=COMPRESSION)
    with open(tmp, "rb+") as fh:
        os.fsync(fh.fileno())
    os.replace(tmp, f)
    got = pq.ParquetFile(f).metadata.num_rows
    if got != rows.num_rows:
        raise OSError(f"trash verification failed for {f}: wrote {rows.num_rows}, read {got}")
    return {"file": rel, "rows": got, "bytes": f.stat().st_size}


def trash_entries(trash_id: str) -> list[dict]:
    """Every series file of an entry: {"file","dataset","venue","interval","symbol","bytes"}."""
    d = trash_dir(trash_id)
    out = []
    for f in sorted(p for p in d.rglob("*" + TRASH_EXT) if p.is_file()):
        parts = f.relative_to(d).parts
        dataset = parts[0]
        get(dataset)
        venue = parts[1].partition("=")[2]
        interval = parts[2].partition("=")[2] if len(parts) == 4 else None
        out.append({"file": f.relative_to(d).as_posix(), "dataset": dataset, "venue": venue,
                    "interval": interval, "symbol": unquote(f.name[:-len(TRASH_EXT)]),
                    "bytes": f.stat().st_size})
    return out


def trash_read(trash_id: str, file: str) -> pa.Table:
    """One series file of an entry, as stored."""
    d = trash_dir(trash_id)
    f = (d / file).resolve()
    if os.path.commonpath([str(f), str(d.resolve())]) != str(d.resolve()) or not f.is_file():
        raise EditError(f"{file!r} is not a file of trash entry {trash_id}")
    return pq.read_table(f)


def trash_list() -> list[tuple[str, dict]]:
    """[(trash_id, manifest)] newest first; an entry with an unreadable manifest is skipped."""
    root = trash_root()
    if not root.is_dir():
        return []
    out = []
    for d in sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name, reverse=True):
        try:
            out.append((d.name, json.loads((d / MANIFEST).read_text(encoding="utf-8"))))
        except (OSError, ValueError):
            continue
    return out


def trash_path(trash_id: str) -> str:
    return str(trash_root() / _check_id(trash_id))


def trash_bytes(trash_id: str) -> int:
    return sum(e["bytes"] for e in trash_entries(trash_id))


def trash_retire(trash_id: str) -> str:
    """Take an entry out of service: MOVE it to `<data root>/_retired/trash/<trash_id>` (never a
    delete). Refuses when the destination exists. -> the destination path."""
    src = trash_dir(trash_id)
    dst = retired_trash_root() / trash_id
    if dst.exists():
        raise EditError(f"{dst} already exists - nothing moved")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return str(dst)


# --------------------------------------------------------------------------------------------- #
# the correction path
# --------------------------------------------------------------------------------------------- #

def _key_tuple(ds: Dataset, row: dict) -> tuple:
    missing = [c for c in ds.key if row.get(c) is None]
    if missing:
        raise EditError(f"{ds.name}: key {row!r} lacks {missing}")
    return tuple(row[c] for c in ds.key)


def _key_month(ds: Dataset, row: dict) -> str:
    v = row[ds.time_col]
    return layout.month_of_date(v) if ds.time_kind == "date" else layout.month_of_ms(v)


def correct_rows(dataset: str, venue: str, interval: str | None, keys, *, reason: str,
                 stem: str = "correct", apply: bool = False) -> dict:
    """Take the rows stored at exactly `keys` out of `dataset` - the sanctioned way to correct a
    settled row stored wrong (module docstring). A dry run (the default) reports and moves
    nothing. With apply=True: the rows are written VERBATIM to a new trash entry and verified
    BEFORE any partition is rewritten, under every touched partition's lock. A key that is not
    stored, or a partition that changed meanwhile, raises EditError with nothing moved (a
    key already removed is therefore refused too, so a repeated apply is safe).
    -> {"dataset","venue","interval","keys","found","rows_by_symbol","months","trash_id"|None,
        "applied"}."""
    ds = get(dataset)
    if not reason or not str(reason).strip():
        raise EditError("a correction names its reason")
    want: dict[tuple, dict] = {}
    for k in keys:
        want[_key_tuple(ds, k)] = k
    by_month: dict[str, set] = {}
    for kt, k in want.items():
        by_month.setdefault(_key_month(ds, k), set()).add(kt)
    rep = {"dataset": ds.name, "venue": _part(venue), "interval": interval, "keys": len(want),
           "found": 0, "rows_by_symbol": {}, "months": sorted(by_month), "trash_id": None,
           "applied": False}
    if not want:
        return rep
    with locked(ds.name, venue, interval, set(by_month)):
        parts, hits, keeps, found = [], {}, {}, set()
        for mo in sorted(by_month):
            p = read_partition(ds.name, venue, interval, mo)
            cols = [p.table.column(c).to_pylist() for c in ds.key]
            mask = []
            for kt in zip(*cols):
                m = kt in by_month[mo]
                mask.append(m)
                if m:
                    found.add(kt)
            msk = pa.array(mask, type=pa.bool_())
            parts.append(p)
            hits[mo], keeps[mo] = p.table.filter(msk), p.table.filter(pc.invert(msk))
        absent = sorted(set(want) - found, key=str)
        if absent:
            raise EditError(f"{ds.name} {_part(venue)} {interval or ''}: {len(absent)} of "
                            f"{len(want)} keys are not stored (first {absent[0]!r}); nothing moved")
        rows = pa.concat_tables([hits[m] for m in sorted(hits)])
        rep["found"] = rows.num_rows
        by_sym: dict[str, pa.Table] = {}
        if "symbol" in ds.series:
            for sym in sorted(set(rows.column("symbol").to_pylist())):
                by_sym[sym] = rows.filter(pc.equal(rows.column("symbol"), sym))
        else:
            by_sym[_part(venue)] = rows
        rep["rows_by_symbol"] = {s: t.num_rows for s, t in by_sym.items()}
        if not apply:
            return rep
        tid = trash_create(stem, {
            "kind": "correction", "reason": str(reason).strip(), "dataset": ds.name,
            "venue": _part(venue), "interval": interval, "rows": rows.num_rows,
            "keys": [list(kt) for kt in sorted(want, key=str)], "status": "applying"})
        for sym, t in by_sym.items():
            trash_put(tid, ds.name, venue, interval, sym, t)
        for p in parts:
            replace_partition(p, keeps[p.month])
        trash_set_manifest(tid, {**trash_manifest(tid), "status": "applied"})
    if "symbol" in ds.series:
        refresh_series(ds.name, venue, interval, by_sym)
    rep["trash_id"], rep["applied"] = tid, True
    return rep


def restore_trash(trash_id: str) -> dict:
    """Write a correction's removed rows back verbatim (merge rules: a key stored again since
    comes back as a conflict, the stored row kept) and mark the entry `restored`. The entry
    stays in the trash; retire it with `trash_retire`. -> the writer's report per series."""
    from .writer import write
    man = trash_manifest(trash_id)
    if man.get("status") != "applied":
        raise EditError(f"trash entry {trash_id} is {man.get('status')!r}, not an applied correction")
    reps = {}
    for e in trash_entries(trash_id):
        rows = trash_read(trash_id, e["file"]).to_pylist()
        reps[e["symbol"]] = write(e["dataset"], rows, e["venue"], interval=e["interval"],
                                  verbatim=True)
    trash_set_manifest(trash_id, {**man, "status": "restored"})
    return reps
