"""PINS: the exact rows a recorded result used, content-addressed and immutable, never evicted and
never deleted by an agent (B-0322). Written by the loop (preregister / record / remeasure), by a
study at execution, and by platform-core's backfill of every input a recorded result already cites.

    h = fund_db.market.pin(dataset="candles", venue="exchange_a", symbol="BTC", interval="1h",
                           window={"from": "2026-07-15", "to": "2026-09-22"}, reason="run 12 input", ref="lab/carry#12")
    fund_db.market.pin(handle, reason=..., ref=...)          # a Handle (or any mapping) naming one series + window
    fund_db.market.pin(rows, dataset=..., venue=..., symbol=..., reason=..., ref=...)   # rows already in hand
    fund_db.market.pin_series("exchange_a:BTC:candles:1h", "2026-07-15..2026-09-22", reason=..., ref=..., expect=sha)
    fund_db.market.pinned(h)                                  # the rows back, digest re-verified
    fund_db.market.pins(ref="lab/carry#12")                   # the index, with every ref

ONE SERIES PER PIN. A run with three inputs holds three pins; its data fingerprint is
window_digest([h1, h2, h3]) - the same 8-hex digest app/loop/tools/fingerprint.py records.

THE HASH is fingerprint.py's per-input sha256, so a fingerprint recorded before pins existed stays
comparable to a pin of the same rows (digest() is the one implementation; fingerprint.py may call
it). Each row is put in its canonical shape - funding / candles / eod in the fixed shapes of
canonical.py,
any other dataset as its stored columns minus the partition keys and the nulls, a date dataset
given `ts` = UTC midnight of its date - with the fetch-bookkeeping field `seen` dropped; rows with
no ms stamp (`ts` / `t` / `time`) are skipped; the rest are serialized as sorted-key compact JSON
(ensure_ascii off), one "\\n" after each, in stamp order (ties in the dataset's sort order).

THE FILE is <data root>/pins/<hash[0:2]>/<hash>.parquet: the rows as stored (partition columns
included), written once, verified by re-reading and re-digesting before the index row lands; a
second pin of the same content adds only a ref. The index is Postgres market.pins + market.pin_refs
(storage.py's backend).

A probe or a test never pins into the real root: `probe:` and `test:` refs are refused there
(refuse_scratch_ref), and retire_scratch() moves the ones that got in to _retired/pins/ (B-0384).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from fund_db import config

from .registry import Dataset, get

VOLATILE = ("seen",)
TS_KEYS = ("ts", "t", "time")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")


class PinError(ValueError):
    pass


def _now() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------------------------- #
# the digest (fingerprint.py's, byte for byte)
# --------------------------------------------------------------------------------------------- #

def _date_ms(d: str) -> int:
    return int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def row_ts(r: dict):
    for k in TS_KEYS:
        v = r.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return int(v)
    return None


def canonical(ds: Dataset, r: dict) -> dict:
    """One stored row in the shape the digest hashes (before `seen` is dropped)."""
    from .canonical import SHAPES
    shape = SHAPES.get(ds.name)
    if shape:
        r = shape(r)
    else:
        drop = set(ds.partition_keys)
        r = {k: v for k, v in r.items() if k not in drop and v is not None}
    if row_ts(r) is None and ds.time_kind == "date" and r.get(ds.time_col):
        r = dict(r, ts=_date_ms(str(r[ds.time_col])))
    return r


def _ordered(ds: Dataset, rows: list[dict]) -> list[dict]:
    keys = [c for c in ds.sort if c != ds.time_col]
    return sorted(rows, key=lambda r: tuple((r.get(c) is None, r.get(c) if r.get(c) is not None else 0)
                                            for c in keys))


def digest_rows(ds: Dataset, rows: list[dict]) -> tuple[str, list[int]]:
    """(sha256 hex, the stamps digested) of stored rows, fingerprint.py's rule."""
    out = []
    for r in _ordered(ds, rows):
        c = canonical(ds, r)
        t = row_ts(c)
        if t is None:
            continue
        out.append((t, {k: v for k, v in c.items() if k not in VOLATILE}))
    out.sort(key=lambda x: x[0])
    h = hashlib.sha256()
    for _, c in out:
        h.update(json.dumps(c, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest(), [t for t, _ in out]


def digest(dataset: str, rows) -> str:
    """The pin hash of `rows` (a pyarrow Table, a pandas frame or dicts) of one series."""
    ds = get(dataset)
    return digest_rows(ds, _as_rows(ds, rows))[0]


def window_digest(hashes) -> str:
    """A run's data fingerprint from its inputs' hashes (= fingerprint.window_digest)."""
    return hashlib.sha256("\n".join(sorted(hashes)).encode()).hexdigest()[:8]


# --------------------------------------------------------------------------------------------- #
# rows in
# --------------------------------------------------------------------------------------------- #

def _as_table(ds: Dataset, rows) -> pa.Table:
    """Rows as a Table typed by the dataset's schema (partition columns as strings), so a pin of a
    pandas frame digests exactly like a pin of the reader's own rows."""
    if isinstance(rows, pa.Table):
        tbl = rows
    elif hasattr(rows, "to_dict") and hasattr(rows, "columns"):
        tbl = pa.Table.from_pandas(rows, preserve_index=False)
    else:
        rows = list(rows)
        tbl = pa.Table.from_pylist(rows) if rows else pa.table({})
    types = {**{k: pa.string() for k in ds.partition_keys}, **dict(ds.fields)}
    unknown = [c for c in tbl.column_names if c not in types]
    if unknown:
        raise PinError(f"{ds.name}: column(s) {unknown} are not in the dataset")
    cols, fields = [], []
    for c in [k for k in list(ds.partition_keys) + list(ds.columns) if k in tbl.column_names]:
        cols.append(tbl.column(c).cast(types[c]))
        fields.append(pa.field(c, types[c]))
    return pa.Table.from_arrays(cols, schema=pa.schema(fields)) if cols else pa.table({})


def _as_rows(ds: Dataset, rows) -> list[dict]:
    return _as_table(ds, rows).to_pylist()


def _window_ms(window) -> tuple[int | None, int | None]:
    if window is None:
        return None, None
    if isinstance(window, str):
        m = re.match(r"^\s*(\S+)\s*(?:\.\.|->|to)\s*(\S+)\s*$", window)
        if not m:
            raise PinError(f"window {window!r} is not FROM..TO")
        window = {"from": m.group(1), "to": m.group(2)}
    return _stamp(window.get("from")), _stamp(window.get("to"), end=True)


def _stamp(v, end: bool = False) -> int | None:
    """fingerprint.py's to_ms: a bare date's end is its last ms."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return int(v)
    t = str(v).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", t):
        ms = _date_ms(t)
        return ms + 86_400_000 - 1 if end else ms
    if re.fullmatch(r"\d{10,13}", t):
        n = int(t)
        return n if n > 1e12 else n * 1000
    d = datetime.fromisoformat(t.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return int(d.timestamp() * 1000)


def _read_series(ds: Dataset, venue: str, symbol: str, interval: str | None) -> pa.Table:
    """Every stored row of one series (lake + cache), as fingerprint.py reads it."""
    from . import reader
    if ds.name == "candles":        # seed bars too: the old store held them
        return reader.candles(venue, symbol, interval, complete_only=False)
    return reader.read(ds.name, venue, symbols=[symbol], interval=interval)


def _in_window(ds: Dataset, rows: list[dict], frm: int | None, to: int | None) -> list[dict]:
    if frm is None and to is None:
        return rows
    out = []
    for r in rows:
        t = row_ts(canonical(ds, r))
        if t is not None and (frm is None or t >= frm) and (to is None or t <= to):
            out.append(r)
    return out


def _handle_get(handle, k, default=None):
    if handle is None:
        return default
    if isinstance(handle, dict):
        return handle.get(k, default)
    return getattr(handle, k, default)


# --------------------------------------------------------------------------------------------- #
# pin / pinned / pins
# --------------------------------------------------------------------------------------------- #

SCRATCH_PREFIXES = ("probe:", "test:")


def is_scratch_ref(ref) -> bool:
    return str(ref or "").strip().lower().startswith(SCRATCH_PREFIXES)


def refuse_scratch_ref(ref, what: str = "a pin") -> None:
    """A probe or a test never writes the real store (B-0384): `probe:` and `test:` refs are
    refused while the data root is the real one. A probe runs on a scratch root
    (FUND_DB_DIR=<tmp>, or fundplat's store.scratch_lake). Any registry that keeps a ref calls this."""
    from fund_db import config
    if is_scratch_ref(ref) and config.is_real_root():
        raise PinError(f"{what} with ref {str(ref).strip()!r} is refused: probe: and test: refs never "
                       f"touch the real data root ({config.data_dir()}); use a scratch root "
                       f"(FUND_DB_DIR=<tmp> or store.scratch_lake)")


def pin_path(h: str) -> Path:
    if not HASH_RE.match(h or ""):
        raise PinError(f"not a pin hash: {h!r}")
    return config.pins_dir() / h[:2] / f"{h}.parquet"


def pin(rows=None, *, handle=None, dataset: str | None = None, venue: str | None = None,
        symbol: str | None = None, interval: str | None = None, what: str | None = None,
        window=None, reason: str, ref: str) -> str:
    """Pin ONE series and return its hash. `rows` None -> the rows are read from the store (lake +
    cache) inside `window` ({from, to} in ms or ISO, or "FROM..TO"); a `handle` (mapping or object)
    supplies dataset / venue / symbol / interval / what / window where they are not given."""
    dataset = dataset or _handle_get(handle, "dataset")
    venue = venue or _handle_get(handle, "venue")
    symbol = symbol if symbol is not None else _handle_get(handle, "symbol")
    interval = interval if interval is not None else _handle_get(handle, "interval")
    what = what if what is not None else _handle_get(handle, "what")
    window = window if window is not None else _handle_get(handle, "window")
    if not dataset or not venue or symbol in (None, ""):
        raise PinError("a pin names its series: dataset, venue and symbol")
    if not str(reason or "").strip() or not str(ref or "").strip():
        raise PinError("a pin carries its reason and its ref (the run id or study id it serves)")
    refuse_scratch_ref(ref)
    ds = get(dataset)
    venue = str(venue).lower() if ds.part_key == "venue" else str(venue)
    symbol, interval = str(symbol), (str(interval) if interval not in (None, "", "-") else None)
    if ds.sub_key and not interval:
        raise PinError(f"{ds.name} is stored per {ds.sub_key}; name one")
    frm, to = _window_ms(window)
    if rows is None:
        tbl = _read_series(ds, venue, symbol, interval)
        if what is not None and "what" in tbl.column_names:
            import pyarrow.compute as pc
            tbl = tbl.filter(pc.equal(tbl["what"], what))
    else:
        tbl = _as_table(ds, rows)
    got = _in_window(ds, _as_table(ds, tbl).to_pylist(), frm, to)
    if not got:
        raise PinError(f"{ds.name} {venue} {symbol} {interval or ''}: no rows in the window - a pin of "
                       f"nothing is not a pin")
    h, stamps = digest_rows(ds, got)
    if not stamps:
        raise PinError(f"{ds.name} {venue} {symbol}: no row carries a time stamp")
    path = pin_path(h)
    table = _as_table(ds, got)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        pq.write_table(table, tmp, compression="zstd")
        with open(tmp, "rb+") as f:
            os.fsync(f.fileno())
        back, _ = digest_rows(ds, pq.read_table(tmp).to_pylist())
        if back != h:
            tmp.unlink(missing_ok=True)
            raise PinError(f"pin verify failed: {back} re-read, {h} written; nothing pinned")
        try:
            os.replace(tmp, path)
        except PermissionError:          # another process pinned the same content a moment ago
            tmp.unlink(missing_ok=True)
    now = _now()
    from .storage import backend
    backend().pin_put(
        {"hash": h, "created_ms": now, "dataset": ds.name, "venue": venue, "symbol": symbol,
         "interval": interval or "", "what": what or "", "window_from": frm, "window_to": to,
         "first_ts": min(stamps), "last_ts": max(stamps), "rows": len(stamps),
         "bytes": path.stat().st_size},
        {"hash": h, "ref": str(ref).strip(), "reason": str(reason).strip(), "created_ms": now})
    return h


def pin_series(spec: str, window, *, reason: str, ref: str, expect: str | None = None) -> dict:
    """The backfill call: `spec` = venue:symbol:dataset:interval (fingerprint.py's input spec; the
    symbol may hold a colon, interval '-' when none), `window` as a run recorded it. Returns
    {hash, rows, first_ts, last_ts, match} - match: the hash equals `expect` (None when no expect)."""
    parts = (spec or "").strip().split(":")
    if len(parts) < 4 or not parts[0] or not parts[-2]:
        raise PinError(f"spec {spec!r} must be venue:symbol:dataset:interval")
    venue, dataset, iv = parts[0].strip().lower(), parts[-2].strip(), parts[-1].strip()
    sym = ":".join(parts[1:-2])
    h = pin(dataset=dataset, venue=venue, symbol=sym, interval=None if iv in ("", "-") else iv,
            window=window, reason=reason, ref=ref)
    row = pins(hash=h)[0]
    return {"hash": h, "rows": row["rows"], "first_ts": row["first_ts"], "last_ts": row["last_ts"],
            "match": None if expect is None else h == expect}


def pinned(h: str, as_: str = "arrow", verify: bool = True):
    """The rows of pin `h`, the digest re-verified (verify=False skips it). KeyError when unknown."""
    path = pin_path(h)
    if not path.exists():
        raise KeyError(f"no pin {h}")
    tbl = pq.read_table(path)
    if verify:
        idx = pins(hash=h)
        ds = get(idx[0]["dataset"]) if idx else None
        if ds is not None and digest_rows(ds, tbl.to_pylist())[0] != h:
            raise PinError(f"pin {h}: the file no longer digests to its hash ({path})")
    if as_ == "arrow":
        return tbl
    if as_ == "pandas":
        return tbl.to_pandas()
    if as_ == "rows":
        return tbl.to_pylist()
    raise ValueError(f"as_ must be arrow | pandas | rows, not {as_!r}")


def pins(ref: str | None = None, hash: str | None = None, dataset: str | None = None,
         venue: str | None = None, symbol: str | None = None) -> list[dict]:
    """The pin index: [{hash, created_ms, dataset, venue, symbol, interval, what, window_from,
    window_to, first_ts, last_ts, rows, bytes, refs: [{ref, reason, created_ms}]}]."""
    from .storage import backend
    return backend().pin_list(ref=ref, hash=hash, dataset=dataset,
                              venue=venue.lower() if venue else venue, symbol=symbol)


def retire_scratch(apply: bool = False, prefixes=SCRATCH_PREFIXES) -> dict:
    """Clear the probe: and test: refs out of the pin index (B-0384). A pin whose EVERY ref is a
    scratch ref is retired: its file MOVES to <data root>/_retired/pins/<hh>/ and its index row
    leaves; a pin that also carries a real ref keeps its file and its row and loses only the scratch
    ref. Never a delete (only the owner frees _retired); a pin with any real ref is never retired.
    What left is appended, rows and refs, to _retired/pins/manifest.jsonl first. Dry run unless apply.
    Returns {apply, retire: [...], unref: [...], pins_before, pins_after}."""
    from fund_db import config
    from .storage import backend
    prefixes = tuple(prefixes)
    plan = {"apply": apply, "retire": [], "unref": [], "skipped": [], "pins_before": len(pins())}
    for p in pins():
        gone = [r["ref"] for r in p["refs"] if r["ref"].lower().startswith(prefixes)]
        if not gone:
            continue
        item = {"hash": p["hash"], "dataset": p["dataset"], "venue": p["venue"], "symbol": p["symbol"],
                "rows": p["rows"], "bytes": p["bytes"], "refs": [r["ref"] for r in p["refs"]],
                "drop_refs": gone}
        if len(gone) == len(p["refs"]):
            if not pin_path(p["hash"]).exists():
                plan["skipped"].append(dict(item, why="the pin file is missing; nothing to move"))
                continue
            plan["retire"].append(item)
        else:
            plan["unref"].append(item)
    if apply:
        out = config.retired_dir() / "pins"
        out.mkdir(parents=True, exist_ok=True)
        for item in plan["retire"] + plan["unref"]:
            h = item["hash"]
            with open(out / "manifest.jsonl", "a", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps({"retired_ms": _now(), "pin": pins(hash=h)[0]}, sort_keys=True,
                                   default=str) + "\n")
            res = backend().pin_unref(h, prefixes)
            item["forgot"] = res["forgot"]
            if res["forgot"]:
                src = pin_path(h)
                dst = out / h[:2] / src.name
                dst.parent.mkdir(parents=True, exist_ok=True)
                if dst.exists():
                    dst = dst.with_name(f"{h}.{_now()}.parquet")
                os.replace(src, dst)
                item["moved_to"] = str(dst)
    plan["pins_after"] = len(pins())
    return plan


def check() -> dict:
    """Every indexed pin has its file (size as indexed). {pins, missing: [hash], size_mismatch}."""
    rows = pins()
    missing, bad = [], []
    for r in rows:
        p = pin_path(r["hash"])
        if not p.exists():
            missing.append(r["hash"])
        elif p.stat().st_size != r["bytes"]:
            bad.append(r["hash"])
    return {"pins": len(rows), "missing": missing, "size_mismatch": bad}
