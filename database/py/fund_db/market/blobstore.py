"""BLOBS: the PIN class's seat for bytes that are not rows of a lake dataset . A study's
reduced L2 ladders, the exchange day files it read and the tables it derived are pinned inputs and
outputs of a recorded result, but they are containers, not a dataset the lake can merge, so each
is one immutable blob under (seat, key). The seat is registered (registry.BLOB_SEATS), the bytes
are content-hashed, and nothing is evicted or deleted by an agent.

    from fund_db import market
    r = market.blob_put("derived", "days/2026-10-03@v2", raw, reason="day 2026-10-03, rules v2",
                        ref="lab/example#7", meta={"format": "npz"}, built_from={"l2": "<input pin digest>", "git": "<sha>"})
    # -> {dataset, key, hash, bytes, written}; the SAME bytes under the key again: written False,
    #    the ref is added; OTHER bytes under a key already pinned: BlobConflict (a changed
    #    derivation is a new key, put the code version in it)
    market.blob_get("derived", "days/2026-10-03@v2")      # the bytes, sha256 re-checked
    market.blob_meta(...)  market.blobs("derived", prefix="days/")  market.blob_path(...)
    pin = market.blob_input_pin("derived", ["days/2026-10-03@v2"])   # the study-manifest line
    market.window_digest([b["hash"] for b in market.blobs("raw", ref="lab/example#7")])

A NOTEBOOK loads a blob through its study's own read function (the caller keeps the decoder),
or directly with blob_get and its own decode. A blob is never a Handle: nothing re-pulls it, so a missing file is an error (BlobMissing),
never a silent re-fetch.

THE FILE is <data root>/pins/blobs/<hash[0:2]>/<hash>.blob, written once (temp file, fsync,
re-hashed, os.replace); two keys with the same bytes share it. THE INDEX is Postgres market.blobs
(one row per (seat, key): hash, bytes, `meta`, `built_from`, our clock) and market.blob_refs (the
runs and studies that cite it, as pin_refs does). The row lands AFTER the file, so a crash leaves
an unreferenced file, never a row without its bytes; the same put again finishes it.

ACCOUNTING: the files are under pins/, so `usage`, `cache --clean` and `doctor` count them (pins_bytes
is the row pins' bytes; blobs and blobs_bytes are these). They are NOT under the cache budget: a
pin is never evicted, so the 500 MB budget is not what bounds them; the owner's pin decision is.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path

from fund_db import config

from .pinning import HASH_RE, PinError, refuse_scratch_ref
from .registry import BLOB_KEY_MAX, BLOB_KEY_RE, blob_seat

META_MAX = 1_000_000          # bytes of JSON in `meta` or `built_from`; a bigger document is a blob of its own
_KEY = re.compile(BLOB_KEY_RE)


class BlobConflict(PinError):
    """A key already pinned holds other bytes than the ones offered: pins are immutable."""


class BlobMissing(LookupError):
    """The key is not pinned, or its bytes are not on disk."""


def _now() -> int:
    return int(time.time() * 1000)


def _backend():
    from .storage import backend
    return backend()


def check_key(key: str) -> str:
    if not isinstance(key, str) or not key or len(key) > BLOB_KEY_MAX or not _KEY.match(key) \
            or any(p.startswith(".") for p in key.split("/")):
        raise PinError(f"bad blob key {key!r}: 1..{BLOB_KEY_MAX} characters of letters, digits and "
                       "._@=+- in '/'-separated segments, none starting with a dot")
    return key


def blob_path(h: str) -> Path:
    """Where the bytes of content hash `h` live (the file need not exist). Read-only for a caller."""
    if not HASH_RE.match(h or ""):
        raise PinError(f"not a blob hash: {h!r}")
    return config.blobs_dir() / h[:2] / f"{h}.blob"


def _doc(name: str, v) -> dict:
    if v is None:
        return {}
    if not isinstance(v, dict):
        raise PinError(f"blob {name} is a dict")
    try:
        text = json.dumps(v, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as e:
        raise PinError(f"blob {name} is not JSON: {e}") from None
    if len(text.encode("utf-8")) > META_MAX:
        raise PinError(f"blob {name} is over {META_MAX:,} bytes of JSON; pin it as a blob of its own")
    return json.loads(text)


def _write_once(h: str, data: bytes) -> Path:
    path = blob_path(h)
    if path.exists() and path.stat().st_size == len(data):
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if hashlib.sha256(tmp.read_bytes()).hexdigest() != h:
            raise PinError(f"blob verify failed: the file re-read does not hash to {h}; nothing pinned")
        try:
            os.replace(tmp, path)
        except PermissionError:          # another process pinned the same content a moment ago
            if not path.exists():
                raise
    finally:
        tmp.unlink(missing_ok=True)
    return path


def blob_put(dataset: str, key: str, data: bytes, *, reason: str, ref: str, meta: dict | None = None,
             built_from: dict | None = None) -> dict:
    """Pin `data` under (dataset, key) -> {dataset, key, hash, bytes, written}. `ref` is the run or
    study it serves and `reason` why; `meta` says what the bytes are (format, window, counts) and
    `built_from` which inputs and code version made it, both stored as given, hashed into nothing:
    the sha256 of `data` is the pin. Same bytes again: written False and the ref is added.
    Other bytes under a pinned key: BlobConflict."""
    blob_seat(dataset)
    check_key(key)
    if not isinstance(data, (bytes, bytearray, memoryview)) or not len(data):
        raise PinError("a blob is non-empty bytes")
    data = bytes(data)
    if not str(reason or "").strip() or not str(ref or "").strip():
        raise PinError("a pin carries its reason and its ref (the run id or study id it serves)")
    refuse_scratch_ref(ref, "a blob pin")
    meta, built_from = _doc("meta", meta), _doc("built_from", built_from)
    h = hashlib.sha256(data).hexdigest()
    be = _backend()
    have = be.blob_list(dataset=dataset, key=key)
    if have and have[0]["hash"] != h:
        raise BlobConflict(f"{dataset}/{key} is pinned with other bytes ({have[0]['hash'][:12]} != "
                           f"{h[:12]}): pins are immutable; a changed derivation is a new key")
    _write_once(h, data)
    now = _now()
    row = be.blob_put({"dataset": dataset, "key": key, "hash": h, "bytes": len(data), "meta": meta,
                       "built_from": built_from, "created_ms": now},
                      {"dataset": dataset, "key": key, "ref": str(ref).strip(),
                       "reason": str(reason).strip(), "created_ms": now})
    if row["hash"] != h:                 # another process pinned this key with other bytes first
        raise BlobConflict(f"{dataset}/{key} is pinned with other bytes ({row['hash'][:12]} != "
                           f"{h[:12]}): pins are immutable; a changed derivation is a new key")
    return {"dataset": dataset, "key": key, "hash": h, "bytes": len(data), "written": not have}


def blob_meta(dataset: str, key: str) -> dict:
    """{dataset, key, hash, bytes, meta, built_from, created_ms, refs: [{ref, reason, created_ms}]}.
    BlobMissing when the key is not pinned."""
    blob_seat(dataset)
    rows = _backend().blob_list(dataset=dataset, key=check_key(key))
    if not rows:
        raise BlobMissing(f"{dataset}/{key}: not pinned")
    return rows[0]


def blob_get(dataset: str, key: str, verify: bool = True) -> bytes:
    """The pinned bytes, their sha256 re-checked against the index (verify=False skips it).
    BlobMissing when the key is not pinned or its file is gone; PinError when the bytes changed."""
    m = blob_meta(dataset, key)
    path = blob_path(m["hash"])
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        raise BlobMissing(f"{dataset}/{key}: the pinned bytes are missing ({path})") from None
    if verify and hashlib.sha256(data).hexdigest() != m["hash"]:
        raise PinError(f"{dataset}/{key}: the file no longer hashes to its pin {m['hash'][:12]} ({path})")
    return data


def blobs(dataset: str | None = None, prefix: str | None = None, ref: str | None = None) -> list[dict]:
    """The blob index, one row per (seat, key) sorted by seat and key, each with its refs."""
    if dataset is not None:
        blob_seat(dataset)
    return _backend().blob_list(dataset=dataset, prefix=prefix, ref=ref)


def blob_input_pin(dataset: str, keys) -> dict:
    """The manifest line for the keys a study read -> {dataset, keys (sorted), digest, bytes}: digest
    is 16 hex over 'key:sha256' lines, the rule fundplat.data.derived.input_pin used before the
    seat, so a recorded digest stays comparable. BlobMissing for a key not pinned."""
    ks = sorted(set(keys))
    ms = [blob_meta(dataset, k) for k in ks]
    text = "\n".join(f"{m['key']}:{m['hash']}" for m in ms).encode()
    return {"dataset": dataset, "keys": ks, "bytes": sum(m["bytes"] for m in ms),
            "digest": hashlib.sha256(text).hexdigest()[:16]}


def check(verify: bool = False) -> dict:
    """Every indexed blob has its file at the indexed size (verify=True also re-hashes each: reads
    every byte). {blobs, bytes, missing: [[dataset, key]], size_mismatch, hash_mismatch}."""
    rows = _backend().blob_list()
    missing, bad, rotten = [], [], []
    for r in rows:
        p = blob_path(r["hash"])
        ident = [r["dataset"], r["key"]]
        if not p.exists():
            missing.append(ident)
        elif p.stat().st_size != r["bytes"]:
            bad.append(ident)
        elif verify and hashlib.sha256(p.read_bytes()).hexdigest() != r["hash"]:
            rotten.append(ident)
    return {"blobs": len(rows), "bytes": sum(r["bytes"] for r in rows), "missing": missing,
            "size_mismatch": bad, "hash_mismatch": rotten}
