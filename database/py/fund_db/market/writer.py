"""The lake writer: rows in, merge rules applied, Parquet parts out, conflicts logged, catalog
updated. Every write to one partition happens under that partition's cross-process lock.

HOW A WRITE LANDS IN ONE PARTITION
  1. recover(): finish or roll back a rewrite a crashed writer left half done (the journal).
  2. The incoming rows are checked against the partition's stored rows (both tiers) in DuckDB:
     rows whose key is new and unique in the batch are ADDED in bulk; only rows whose key is
     already stored (or repeated in the batch) go through merge.merge_row one by one.
  3. Nothing stored changes (the common case: a tail, a new hour): the added rows become ONE new
     part file, written to a temp name, fsynced and renamed into place. Existing parts are never
     touched, so a crash leaves at worst an unreferenced temp file.
  4. A stored row changes (a forming bar closes, a null premium is filled, an eod print is
     revised): the whole partition is rewritten into one part. A journal
     (`_rewrite.json`: the new part, the old parts) is written BEFORE the new part is renamed into
     place, and removed after the old parts are gone. Readers honour the journal, so they never
     see a row twice; recover() completes the swap after a crash.
  5. More than `compact_parts` parts: the partition is compacted the same way as step 4.
Conflicts go to the `conflicts` dataset (and stderr) - evidence, never silently resolved.

WHERE A WRITE LANDS (the storage classes, registry.py / storage.py). Every series of a write is
resolved to a class first: "archive" lands in THE LAKE (hot, tiering to cold), "cache" in the
CACHE root (same layout); "none", an undeclared "archive" request and a "cache" request for an
archive series are refused before anything is written. Merges see every root, so a settled row in
the cache is as immutable as one in the lake. A rewrite is PER ROOT: a stored row is rewritten in
the root it is stored in, so a legacy lake month (before the reclassify) keeps its rows and
nothing leaves the lake by a write; only an ARCHIVE series' rows found in the cache move, into the
lake. A write that takes the cache past its budget evicts least-recently-read months (cache.py),
never one it just wrote.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from . import layout
from .lock import locked
from .merge import is_seed, merge_row
from .registry import CB_DATASETS, CB_VENUES, DATA_TYPES, SESSION_INTERVALS, Dataset, get, interval_ms

JOURNAL = "_rewrite.json"
COMPRESSION = "zstd"
_RID = "__rid"


def now_ms() -> int:
    return int(time.time() * 1000)


def partition_lock_name(ds: Dataset, part: str, sub: str | None, month: str) -> str:
    return f"{ds.name}|{part}|{sub or ''}|{month}"


def _lock_dir() -> Path:
    return layout.hot_root() / "_locks"


# --------------------------------------------------------------------------------------------- #
# the journal: crash-safe partition rewrites
# --------------------------------------------------------------------------------------------- #

def _fsync_dir(p: Path) -> None:
    if os.name == "nt":          # Windows cannot open a directory for fsync; os.replace is atomic
        return
    fd = os.open(str(p), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_json_atomic(path: Path, obj) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f)
        f.flush(); os.fsync(f.fileno())
    deadline = time.monotonic() + REMOVE_WAIT_S
    while True:
        try:
            os.replace(tmp, path)       # Windows refuses while a reader holds `path` open
            return
        except PermissionError:
            if time.monotonic() >= deadline:
                _remove(tmp)
                raise
            time.sleep(0.02)


REMOVE_WAIT_S = 3.0


def _remove(path: Path) -> bool:
    """Delete `path` (gone already is done). Windows refuses to delete a file another process has
    open - a lock-free reader holding a part or the journal for a moment - so a refusal is retried
    for up to REMOVE_WAIT_S; still refused is False, said to the caller, never raised past it."""
    deadline = time.monotonic() + REMOVE_WAIT_S
    delay = 0.01
    while True:
        try:
            path.unlink(missing_ok=True)
            return True
        except PermissionError:
            if time.monotonic() >= deadline:
                return False
            time.sleep(delay)
            delay = min(delay * 2, 0.2)


def recover(pdir: Path) -> str | None:
    """Finish or undo an interrupted rewrite in `pdir`. Returns what it did, or None."""
    j = pdir / JOURNAL
    if not j.exists():
        return None
    try:
        info = json.loads(j.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        info = None
    if not info:                                  # a torn journal: the rename never happened
        _remove(j)
        return "dropped a torn journal"
    new, tmp = Path(info["new"]), Path(info["tmp"])
    if new.exists():                              # the new part landed: finish removing the old
        if not all([_remove(Path(o)) for o in info["old"]]):
            # an old part still held open: the journal stays, so readers keep skipping it
            return "left an interrupted rewrite to finish later (an old part is held open)"
        did = "completed"
    else:                                         # it never landed: the old parts stand
        _remove(tmp)
        did = "rolled back"
    _remove(j)
    return f"{did} an interrupted rewrite ({len(info['old'])} old part(s))"


def hidden_by_journals(pdirs: list[Path]) -> set[str]:
    """Files a reader must skip because a rewrite is in flight (lock-free, for readers)."""
    hide: set[str] = set()
    for d in pdirs:
        j = d / JOURNAL
        if not j.exists():
            continue
        try:
            info = json.loads(j.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if Path(info["new"]).exists():
            hide.update(os.path.normcase(o) for o in info["old"])
        else:
            hide.add(os.path.normcase(info["new"]))
    return hide


def _write_part(tbl: pa.Table, pdir: Path, tag: str = "a") -> Path:
    pdir.mkdir(parents=True, exist_ok=True)
    name = f"part-{now_ms()}-{tag}{uuid.uuid4().hex[:8]}.parquet"
    tmp = pdir / f".{name}.tmp"
    pq.write_table(tbl, tmp, compression=COMPRESSION)
    with open(tmp, "rb+") as f:
        os.fsync(f.fileno())
    dst = pdir / name
    os.replace(tmp, dst)
    _fsync_dir(pdir)
    return dst


def _unfinished_old(home: Path) -> list[Path]:
    """The old parts a completed-but-unfinished rewrite in `home` still has on disk."""
    j = home / JOURNAL
    try:
        info = json.loads(j.read_text(encoding="utf-8")) if j.exists() else None
    except (OSError, ValueError):
        return []
    if not info or not Path(info["new"]).exists():
        return []
    return [Path(o) for o in info["old"] if Path(o).exists()]


def _rewrite(tbl: pa.Table, home: Path, old: list[Path], tag: str = "r") -> Path:
    """Replace every part in `old` with one part holding `tbl`, crash-safely."""
    home.mkdir(parents=True, exist_ok=True)
    name = f"part-{now_ms()}-{tag}{uuid.uuid4().hex[:8]}.parquet"
    tmp, new = home / f".{name}.tmp", home / name
    pq.write_table(tbl, tmp, compression=COMPRESSION)
    with open(tmp, "rb+") as f:
        os.fsync(f.fileno())
    if pq.ParquetFile(tmp).metadata.num_rows != tbl.num_rows:
        tmp.unlink(missing_ok=True)
        raise OSError(f"rewrite verify failed in {home}: row count differs; nothing replaced")
    # An earlier rewrite recover() could not finish (an old part held open) keeps its unfinished
    # old parts hidden only through its journal: this journal carries them on.
    pending = _unfinished_old(home)
    old = list(old) + [p for p in pending if os.path.normcase(str(p)) not in
                       {os.path.normcase(str(o)) for o in old}]
    _write_json_atomic(home / JOURNAL, {"new": str(new), "tmp": str(tmp),
                                        "old": [str(p) for p in old]})
    os.replace(tmp, new)
    # The journal goes only when every old part is gone: while it names a landed new part, readers
    # skip the old ones, and the next writer's recover() removes what a reader held open here.
    if all([_remove(p) for p in old]):
        _remove(home / JOURNAL)
    return new


# --------------------------------------------------------------------------------------------- #
# normalizing incoming rows
# --------------------------------------------------------------------------------------------- #

def _to_ms(v) -> int:
    if isinstance(v, bool):
        raise TypeError("a bool is not a time")
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if v != int(v):
            raise ValueError(f"a ms stamp must be whole, got {v!r}")
        return int(v)
    if isinstance(v, datetime):
        return int((v if v.tzinfo else v.replace(tzinfo=timezone.utc)).timestamp() * 1000)
    if hasattr(v, "to_pydatetime"):
        return _to_ms(v.to_pydatetime())
    if isinstance(v, str):
        return int(datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp() * 1000)
    raise TypeError(f"cannot read {v!r} as a ms stamp")


def _date_ms(d: str) -> int:
    return int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def _iso_ms(s: str) -> int:
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError(f"snapshot stamp {s!r} carries no zone; refusing to guess one")
    return int(dt.timestamp() * 1000)


def _rows_of(rows) -> list[dict]:
    if isinstance(rows, pa.Table):
        return rows.to_pylist()
    if hasattr(rows, "to_dict") and hasattr(rows, "columns"):          # pandas
        import pandas as pd
        return [{k: (None if (not isinstance(v, (list, dict, str)) and pd.isna(v)) else v)
                 for k, v in r.items()} for r in rows.to_dict("records")]
    return list(rows)


class WriteError(ValueError):
    pass


def normalize(ds: Dataset, rows, *, part: str | None, sub: str | None, source: str | None,
              now: int, closed_asof_ms: int | None, verbatim: bool) -> tuple[list[dict], int]:
    """-> (rows ready for the schema, each with `__part`/`__sub`, skipped count). Raises
    WriteError on a row that breaks the dataset's contract."""
    out, skipped = [], 0
    iv_ms = None
    for r in _rows_of(rows):
        r = dict(r)
        p = part if part is not None else r.get(ds.part_key)
        if p is None:
            raise WriteError(f"{ds.name}: no {ds.part_key} given for a row")
        p = str(p).lower() if ds.part_key == "venue" else str(p)
        s = None
        if ds.sub_key:
            s = sub if sub is not None else r.get(ds.sub_key)
            if s is None:
                raise WriteError(f"{ds.name}: no {ds.sub_key} given")
            s = str(s)
        if not verbatim:
            if source is not None:
                r["src"] = source
            r.setdefault("src", "venue")
            if r.get("seen") is None:
                r["seen"] = now
        elif r.get("src") is None and "src" in ds.columns:
            raise WriteError(f"{ds.name}: a verbatim row must carry its src")
        name = ds.name
        if name == "funding":
            if "ts" not in r and "time" in r:
                r["ts"] = r.pop("time")
            if r.get("interval_h") is not None:
                if r.get("interval_src") not in (None, "venue"):
                    raise WriteError(
                        f"funding {p} {r.get('symbol')} ts={r.get('ts')}: interval_src="
                        f"{r.get('interval_src')!r} - an inferred cadence is never stored; only a "
                        "venue-published interval_h enters the lake")
                r["interval_src"] = "venue"
            elif r.get("interval_src") is not None:
                raise WriteError("funding: interval_src without interval_h")
            if r.get("rate") is not None:
                r["rate"] = float(r["rate"])
        elif name == "candles":
            if iv_ms is None:
                iv_ms = interval_ms(s)
            if not verbatim or r.get("closed") is None:
                asof = now if closed_asof_ms is None else closed_asof_ms
                r["closed"] = int(r["t"]) + iv_ms <= asof
            if is_seed(r) and not r["closed"]:
                skipped += 1
                continue
        elif name == "contract_bars":
            if iv_ms is None:
                iv_ms = interval_ms(s)
            _contract_bar(r, p, s, iv_ms, now, closed_asof_ms, verbatim)
        elif name == "predmkt_bars":
            if iv_ms is None:
                iv_ms = interval_ms(s)
            _predmkt_bar(r, p, s, iv_ms, now, closed_asof_ms, verbatim)
        elif name == "option_chains":
            _chain_row(r, p)
        elif name in CB_DATASETS:
            _cb_row(name, r, p)
        elif name == "eod":
            if r.get("time") is None and r.get("date"):
                r["time"] = _date_ms(str(r["date"]))
        elif name == "snapshots":
            if r.get("t") is None and r.get("ts"):
                r["t"] = _iso_ms(str(r["ts"]))
            v = r.get("value")
            if r.get("is_int") is None and v is not None:
                r["is_int"] = isinstance(v, int) and not isinstance(v, bool)
            if isinstance(v, bool):
                raise WriteError("snapshots: a bool value is not a reading")
        for c, t in ds.fields:
            v = r.get(c)
            if v is None:
                if c in ds.required:
                    raise WriteError(f"{ds.name}: required column {c!r} is missing in {r!r}")
                continue
            if pa.types.is_integer(t) and c != "level":
                r[c] = _to_ms(v) if c in ("ts", "t", "time", "seen", "logged", "expiry", "created") else int(v)
            elif pa.types.is_floating(t) and not isinstance(v, float):
                r[c] = float(v)
        row = {c: r.get(c) for c in ds.columns}
        row["__part"], row["__sub"] = p, s
        out.append(row)
    return out, skipped


def _contract_bar(r: dict, venue: str, interval: str, iv_ms: int, now: int,
                  closed_asof_ms: int | None, verbatim: bool) -> None:
    """contract_bars' row contract, in place: the kind and data type named, a session bar dated
    and closed by the caller, an intraday bar closed on the clock it was served on."""
    where = f"contract_bars {venue} {interval} {r.get('symbol')} t={r.get('t')}"
    if not isinstance(r.get("what"), str) or not r["what"].strip():
        raise WriteError(f"{where}: `what` (the venue's bar kind, e.g. TRADES / MIDPOINT) is required")
    if r.get("data_type") not in DATA_TYPES:
        raise WriteError(f"{where}: data_type={r.get('data_type')!r}; it must be one of {DATA_TYPES} - "
                         "a bar whose market data type is unknown could be a delayed bar read as live")
    if interval in SESSION_INTERVALS:
        d = r.get("date")
        if not isinstance(d, str) or len(d) != 10:
            raise WriteError(f"{where}: a {interval} bar carries its trade `date` 'YYYY-MM-DD'")
        dm = _date_ms(d)
        if r.get("t") is None:
            r["t"] = dm
        elif _to_ms(r["t"]) != dm:
            raise WriteError(f"{where}: t must be UTC midnight of date {d} ({dm})")
        if r.get("closed") is None:
            raise WriteError(f"{where}: a {interval} bar's `closed` is a session fact the caller "
                             "states (from the contract's trading hours), never t + interval")
    elif r.get("date") is not None:
        raise WriteError(f"{where}: an intraday bar carries no trade date")
    if r.get("closed") is None:
        if verbatim:
            raise WriteError(f"{where}: a verbatim row carries its `closed`")
        if closed_asof_ms is None and r["data_type"].startswith("delayed"):
            raise WriteError(f"{where}: a {r['data_type']} bar's close is judged on the delayed "
                             "clock: pass closed_asof_ms (now minus the venue's published delay), "
                             "or state `closed` per row")
        asof = now if closed_asof_ms is None else closed_asof_ms
        r["closed"] = _to_ms(r["t"]) + iv_ms <= asof
    elif type(r["closed"]).__name__ == "bool_":        # numpy, from a pandas frame
        r["closed"] = bool(r["closed"])
    elif not isinstance(r["closed"], bool):
        raise WriteError(f"{where}: closed={r['closed']!r} is not a bool")


_PM_GROUPS = (("o", "h", "l", "c"), ("bid_o", "bid_h", "bid_l", "bid_c"), ("ask_o", "ask_h", "ask_l", "ask_c"))
_PM_PRICES = tuple(c for g in _PM_GROUPS for c in g) + ("mean", "prev")


def predmkt_symbol(venue_id, listed_ms: int) -> str:
    """The predmkt_bars symbol of one listing: '<venue id>@<listed_ms>'."""
    return f"{venue_id}@{int(listed_ms)}"


def split_predmkt_symbol(symbol: str) -> tuple[str, int]:
    """(venue id, listed_ms) of a predmkt_bars symbol; ValueError if it is not one."""
    vid, sep, ms = str(symbol).rpartition("@")
    if not sep or not vid or not ms.isdigit() or int(ms) <= 0:
        raise ValueError(f"{symbol!r} is not '<venue id>@<listed_ms>'")
    return vid, int(ms)


def _predmkt_bar(r: dict, venue: str, interval: str, iv_ms: int, now: int,
                 closed_asof_ms: int | None, verbatim: bool) -> None:
    """predmkt_bars' row contract, in place: the symbol names its listing, the outcome and the
    kind of price are stated, every price is a probability, a candle's groups are whole and
    ordered, a sample carries only `c`, and nothing predates the listing it belongs to."""
    where = f"predmkt_bars {venue} {interval} {r.get('symbol')} t={r.get('t')}"
    try:
        _, listed = split_predmkt_symbol(r.get("symbol"))
    except ValueError as e:
        raise WriteError(f"{where}: {e}; the listing stamp keeps a re-listed market from merging "
                         "into the old one's bars") from None
    t = _to_ms(r["t"]) if r.get("t") is not None else None
    if t is not None and t < listed:
        raise WriteError(f"{where}: the bar opens before its listing ({listed}); a bar of an earlier "
                         "listing of the same id belongs under that listing's symbol")
    if not isinstance(r.get("outcome"), str) or not r["outcome"].strip():
        raise WriteError(f"{where}: `outcome` (the venue's label for the side, e.g. Yes) is required")
    kind = r.get("px_kind")
    if kind not in ("ohlc", "sample"):
        raise WriteError(f"{where}: px_kind={kind!r}; 'ohlc' (a candle) or 'sample' (one sampled price)")
    for c in _PM_PRICES:
        v = r.get(c)
        if v is not None and not 0.0 <= float(v) <= 1.0:
            raise WriteError(f"{where}: {c}={v!r} is not a probability in 0..1 (cents read as dollars?)")
    for c in ("v", "oi"):
        if r.get(c) is not None and float(r[c]) < 0:
            raise WriteError(f"{where}: {c}={r[c]!r} is negative")
    if kind == "sample":
        if r.get("c") is None:
            raise WriteError(f"{where}: a sample carries its price in `c`")
        extra = [c for c in _PM_PRICES if c != "c" and r.get(c) is not None]
        if extra:
            raise WriteError(f"{where}: a sample is one price, not a candle; {extra} would be invented")
    else:
        for g in _PM_GROUPS:
            got = [r.get(c) for c in g]
            if all(v is None for v in got):
                continue
            if any(v is None for v in got):
                raise WriteError(f"{where}: {g} are all or none (a partial candle)")
            o, h, l, c = (float(v) for v in got)
            if h < max(o, c) or l > min(o, c):
                raise WriteError(f"{where}: {g} = {got}: h must be the highest and l the lowest")
    if r.get("closed") is None:
        if verbatim:
            raise WriteError(f"{where}: a verbatim row carries its `closed`")
        asof = now if closed_asof_ms is None else closed_asof_ms
        r["closed"] = t + iv_ms <= asof
    elif type(r["closed"]).__name__ == "bool_":
        r["closed"] = bool(r["closed"])
    elif not isinstance(r["closed"], bool):
        raise WriteError(f"{where}: closed={r['closed']!r} is not a bool")


_HEX64 = re.compile(r"^[0-9a-f]{64}$")
CB_TEXT_MAX = 2_000_000
CB_STATUS = ("pending", "done", "needs_review")
CB_VOTES = ("for", "against", "present")
CB_STATS = ("median", "dot", "baseline", "range_lo", "range_hi", "actual")
CB_NO_BUCKET = ("median", "range_lo", "range_hi", "actual")
CB_TASKS = ("classify", "doc_analysis")
ATTENDANCE = "attendance"


def _cb_date(where: str, col: str, v) -> None:
    if not isinstance(v, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        raise WriteError(f"{where}: {col}={v!r} is not a date 'YYYY-MM-DD'")
    try:
        _date_ms(v)
    except ValueError:
        raise WriteError(f"{where}: {col}={v!r} is not a calendar date") from None


def _cb_text(where: str, r: dict, *cols) -> None:
    for c in cols:
        if not isinstance(r.get(c), str) or not r[c].strip():
            raise WriteError(f"{where}: `{c}` is required and may not be blank")


def _cb_count(where: str, r: dict, *cols) -> None:
    for c in cols:
        v = r.get(c)
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0 or v != int(v)):
            raise WriteError(f"{where}: {c}={v!r} is not a whole number >= 0")


def _cb_row(name: str, r: dict, venue: str) -> None:
    """The row contract of the five central bank datasets, in place: the bank is one we read, a
    date is a real date, a hash is a hash, the closed vocabularies are closed, and no raw file
    can enter as text. Blank-but-present strings are legal where the key allows (a median's
    bucket is '')."""
    where = f"{name} {venue}"
    if venue not in CB_VENUES:
        raise WriteError(f"{where}: venue {venue!r} is not a central bank we hold; they are "
                         f"{', '.join(CB_VENUES)} (registry.CB_VENUES)")
    if name != "cb_llm":
        _cb_date(where, "meeting_date", r.get("meeting_date"))
    if name == "cb_docs":
        where += f" {r.get('url')}"
        _cb_text(where, r, "doc_type", "url", "text")
        if r.get("publish_date") is not None:
            _cb_date(where, "publish_date", r["publish_date"])
        if not isinstance(r.get("sha256"), str) or not _HEX64.match(r["sha256"]):
            raise WriteError(f"{where}: sha256 must be 64 lowercase hex characters")
        _cb_count(where, r, "bytes", "words")
        t = r["text"]
        if len(t) > CB_TEXT_MAX or "\x00" in t or t.startswith("%PDF"):
            raise WriteError(f"{where}: text is {len(t)} chars, NUL={chr(0) in t}, PDF={t.startswith('%PDF')}; "
                             f"it is the EXTRACTED text up to {CB_TEXT_MAX:,} characters - a raw file is stored nowhere")
    elif name == "cb_meetings":
        where += f" {r.get('meeting_date')}"
        if r.get("status") not in CB_STATUS:
            raise WriteError(f"{where}: status={r.get('status')!r}; it is one of {CB_STATUS}")
    elif name == "cb_votes":
        where += f" {r.get('meeting_date')} {r.get('item')} {r.get('member')}"
        _cb_text(where, r, "item", "member")
        if r.get("vote") not in CB_VOTES:
            raise WriteError(f"{where}: vote={r.get('vote')!r}; it is one of {CB_VOTES}")
        if r["item"] == ATTENDANCE and r["vote"] != "present":
            raise WriteError(f"{where}: an attendance row's vote is 'present', not {r['vote']!r}")
    elif name == "cb_projections":
        where += f" {r.get('meeting_date')} {r.get('variable')} {r.get('horizon')} {r.get('stat')}"
        _cb_text(where, r, "variable", "horizon")
        if r.get("stat") not in CB_STATS:
            raise WriteError(f"{where}: stat={r.get('stat')!r}; it is one of {CB_STATS}")
        b = r.get("bucket")
        if not isinstance(b, str):
            raise WriteError(f"{where}: bucket is '' (a median, a range bound or an actual) or the dot's rate bucket, never null")
        if r["stat"] == "dot" and not b.strip():
            raise WriteError(f"{where}: a dot names its rate bucket")
        if r["stat"] in CB_NO_BUCKET and b:
            raise WriteError(f"{where}: a {r['stat']} has no bucket, got {b!r}")
        v = r.get("value")
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float))
                              or v != v or v in (float("inf"), float("-inf"))):
            raise WriteError(f"{where}: value={v!r} is not a finite number")
    else:                                                          # cb_llm
        where += f" {r.get('key')}"
        if not isinstance(r.get("key"), str) or not _HEX64.match(r["key"]):
            raise WriteError(f"{where}: key must be a sha256, 64 lowercase hex characters")
        _cb_text(where, r, "subject", "prompt_version", "model", "response")
        if r.get("task") not in CB_TASKS:
            raise WriteError(f"{where}: task={r.get('task')!r}; it is one of {CB_TASKS}")
        try:
            json.loads(r["response"])
        except ValueError:
            raise WriteError(f"{where}: response is not JSON text") from None
        c = r.get("created")
        if c is not None and (isinstance(c, bool) or (isinstance(c, (int, float)) and c <= 0)):
            raise WriteError(f"{where}: created={c!r} is not a real ms stamp")


def _chain_row(r: dict, venue: str) -> None:
    """option_chains' row contract, in place: the data type named, the expiry a date, the right
    a call or a put, and `raw` - the served row verbatim - stored as canonical JSON so that an
    equal re-serve compares equal and any other one is a conflict."""
    where = f"option_chains {venue} {r.get('symbol')} ts={r.get('ts')}"
    if r.get("data_type") not in DATA_TYPES:
        raise WriteError(f"{where}: data_type={r.get('data_type')!r}; it must be one of {DATA_TYPES}")
    e = r.get("expiry")
    if e is not None:
        m = re.match(r"^(\d{4})-?(\d{2})-?(\d{2})$", str(e).strip())
        if not m:
            raise WriteError(f"{where}: expiry {e!r} is not a date 'YYYY-MM-DD' (expand a YYMMDD first)")
        r["expiry"] = f"{m[1]}-{m[2]}-{m[3]}"
    rt = r.get("right")
    if rt is not None:
        rt = str(rt).strip().upper()
        r["right"] = {"C": "C", "CALL": "C", "P": "P", "PUT": "P"}.get(rt)
        if r["right"] is None:
            raise WriteError(f"{where}: right {rt!r} is neither a call nor a put")
    raw = r.get("raw")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raise WriteError(f"{where}: raw is not JSON") from None
    if not isinstance(raw, (dict, list)) or not raw:
        raise WriteError(f"{where}: `raw` (the served row verbatim) is required - a field without "
                         "a column is otherwise lost")
    r["raw"] = json.dumps(raw, sort_keys=True, separators=(",", ":"), default=str)


def _month_col(ds: Dataset, tbl: pa.Table) -> pa.Array:
    col = tbl.column(ds.time_col)
    if ds.time_kind == "date":
        return pc.utf8_slice_codeunits(col, 0, 7)
    ts = pc.cast(col, pa.timestamp("ms", tz="UTC"))
    return pc.strftime(ts, format="%Y-%m")


# --------------------------------------------------------------------------------------------- #
# the write
# --------------------------------------------------------------------------------------------- #

def _files_for(ds: Dataset, part: str, sub: str | None, month: str,
               cls: str | None = None) -> tuple[Path, list[Path], list[Path]]:
    """(home dir, every pdir across roots, visible part files across roots). The home is where
    NEW rows go: cls "archive" -> the lake (hot, or cold when only cold holds the month), never
    the cache; cls "cache" -> the cache, always (a legacy lake month keeps its own rows: rewrites
    are per root); cls None (an edit) -> wherever the month already lives, hot first."""
    from .retention import read_roots
    seen, uniq, lake, cache = set(), [], [], []
    for t, root in read_roots(ds).items():
        d = layout.partition_dir(root, ds, part, month, sub)
        k = os.path.normcase(str(d.resolve())) if d.exists() else os.path.normcase(str(d))
        if k not in seen:
            seen.add(k); uniq.append(d)
            (cache if t == "cache" else lake).append(d)
    hide = hidden_by_journals(uniq)        # a rewrite a held-open file kept from finishing
    files = [f for d in uniq if d.is_dir() for f in layout.part_files(d)
             if os.path.normcase(str(f)) not in hide]
    held = {d for d in uniq if any(f.parent == d for f in files)}
    if cls == "archive":
        order = lake
    elif cls == "cache":
        return cache[0], uniq, files
    else:
        order = lake + cache
    home = next((d for d in order if d in held), order[0])
    return home, uniq, files


def is_cache_dir(p: Path) -> bool:
    """Is `p` under the cache root?"""
    try:
        Path(p).resolve().relative_to(layout.cache_root().resolve())
        return True
    except ValueError:
        return False


def _match(a: str, b: str, cols) -> str:
    return " AND ".join(f'{a}."{c}" IS NOT DISTINCT FROM {b}."{c}"' for c in cols) or "TRUE"


def _qcols(cols) -> str:
    return ", ".join(f'"{c}"' for c in cols)


def _existing_sql(files: list[Path], filename: bool = False) -> str:
    lst = ", ".join("'" + str(f).replace("'", "''") + "'" for f in files)
    fn = ", filename=true" if filename else ""
    return f"read_parquet([{lst}], union_by_name=true, hive_partitioning=false{fn})"


# --------------------------------------------------------------------------------------------- #
# per-root rewrites: a row stays in the root (lake or cache) it is stored in
# --------------------------------------------------------------------------------------------- #

_DIR = "__dir"


def _dir_of(filename: str) -> str:
    return os.path.normcase(str(Path(filename).parent))


def _with_dir(tbl: pa.Table, d) -> pa.Table:
    if isinstance(d, str) or d is None:
        d = pa.array([d] * tbl.num_rows, pa.string())
    return tbl.append_column(_DIR, d)


def _route_archive_home(ds: Dataset, part: str, sub: str | None, tbl: pa.Table, home: Path) -> pa.Table:
    """Rows of an ARCHIVE series sitting in a cache dir are routed to the lake home: archive data
    never stays in the cache."""
    from .storage import series_class
    if is_cache_dir(home) or not tbl.num_rows:
        return tbl
    syms = tbl.column("symbol").to_pylist() if "symbol" in ds.series else [""] * tbl.num_rows
    memo: dict = {}
    out = []
    for d, sym in zip(tbl.column(_DIR).to_pylist(), syms):
        if d is not None and is_cache_dir(Path(d)):
            if sym not in memo:
                memo[sym] = series_class(ds.name, part, sym, sub) == "archive"
            if memo[sym]:
                d = os.path.normcase(str(home))
        out.append(d)
    return tbl.drop([_DIR]).append_column(_DIR, pa.array(out, pa.string()))


def _dirs_by_identity(ds: Dataset, files, tbl: pa.Table, home: Path) -> pa.Table:
    """`tbl` (rows read from `files`, some dropped) with __dir = the dir each row is stored in,
    matched on the row identity; a row matching no file goes home."""
    files = [Path(f) for f in files]
    ident = list(ds.identity) or list(ds.columns)
    con = duckdb.connect()
    try:
        t = tbl.append_column(_RID, pa.array(range(tbl.num_rows), pa.int64()))
        con.register("t", t)
        got: dict[int, str] = {}
        by: dict[str, list[Path]] = {}
        for f in files:
            by.setdefault(_dir_of(str(f)), []).append(f)
        for d, fs in by.items():
            for (rid,) in con.execute(
                    f"SELECT t.{_RID} FROM t WHERE EXISTS (SELECT 1 FROM (SELECT {_qcols(ident)} FROM "
                    f"{_existing_sql(fs)}) e WHERE {_match('e', 't', ident)})").fetchall():
                got.setdefault(rid, d)
    finally:
        con.close()
    return _with_dir(tbl, pa.array([got.get(i, os.path.normcase(str(home))) for i in range(tbl.num_rows)],
                                   pa.string()))


def _rewrite_dirs(ds: Dataset, files: list[Path], tbl: pa.Table, home: Path, write_dirs: set,
                  tag: str = "r") -> int:
    """Rewrite each dir in `write_dirs` to hold exactly the rows of `tbl` whose __dir is it (None
    = home); every other dir is left untouched. Dirs gaining rows are written before dirs losing
    them, so a crash can duplicate a moved row for a moment, never lose it. Returns parts written."""
    home_k = os.path.normcase(str(home))
    held: dict[str, list[Path]] = {}
    for f in files:
        held.setdefault(os.path.normcase(str(f.parent)), []).append(f)
    want: dict[str, list[int]] = {}
    for i, d in enumerate(tbl.column(_DIR).to_pylist()):
        want.setdefault(d if d is not None else home_k, []).append(i)
    body = tbl.drop([_DIR])
    old_rows = {d: sum(pq.ParquetFile(f).metadata.num_rows for f in fs) for d, fs in held.items()}
    order = sorted({os.path.normcase(str(d)) for d in write_dirs},
                   key=lambda d: (len(want.get(d, [])) < old_rows.get(d, 0), d))
    written = 0
    for d in order:
        idx = want.get(d, [])
        old = held.get(d, [])
        target = old[0].parent if old else (home if d == home_k else Path(d))
        if idx:
            sub = _sorted(ds, body.take(pa.array(idx, pa.int64())))
            if old:
                _rewrite(sub, target, old, tag)
            else:
                _write_part(sub, target, tag)
            written += 1
        else:
            for f in old:
                _remove(f)
    return written


def _as_schema(ds: Dataset, tbl: pa.Table) -> pa.Table:
    cols = []
    for c, t in ds.fields:
        if c in tbl.column_names:
            cols.append(tbl.column(c).cast(t))
        else:
            cols.append(pa.nulls(tbl.num_rows, t))
    return pa.Table.from_arrays(cols, schema=ds.schema)


def _sorted(ds: Dataset, tbl: pa.Table) -> pa.Table:
    if not ds.sort or tbl.num_rows < 2:
        return tbl
    return tbl.sort_by([(c, "ascending") for c in ds.sort])


def _key_of(ds: Dataset, row: dict) -> tuple:
    return tuple(row.get(c) for c in ds.key)


def _write_partition(ds: Dataset, part: str, sub: str | None, month: str, inc: pa.Table,
                     rep: dict, conflicts: list, compact_parts: int, cls: str | None = None) -> Path:
    """Merge `inc` into one partition; returns the home dir it landed in."""
    home, pdirs, _ = _files_for(ds, part, sub, month, cls)
    with locked(_lock_dir(), partition_lock_name(ds, part, sub, month)):
        for d in pdirs:
            if d.is_dir():
                recover(d)
        home, pdirs, files = _files_for(ds, part, sub, month, cls)
        con = duckdb.connect()
        try:
            inc = inc.append_column(_RID, pa.array(range(inc.num_rows), pa.int64()))
            con.register("inc", inc)
            ident = ds.identity
            ex = _existing_sql(files) if files else None
            replaced: dict[tuple, dict] = {}
            stored_dir: dict[tuple, str] = {}
            added_py: list[dict] = []
            if ds.rule in ("observe", "append"):
                q = f"SELECT * EXCLUDE ({_RID}) FROM inc"
                if ds.rule == "observe":
                    q = (f"SELECT * EXCLUDE ({_RID}, __rn) FROM (SELECT *, row_number() OVER "
                         f"(PARTITION BY {_qcols(ident)} ORDER BY {_RID}) AS __rn FROM inc) i "
                         f"WHERE __rn = 1")
                    if ex:
                        q += (f" AND NOT EXISTS (SELECT 1 FROM (SELECT {_qcols(ident)} FROM {ex}) e "
                              f"WHERE {_match('e', 'i', ident)})")
                fast = con.execute(q).to_arrow_table()
                rep["unchanged"] += inc.num_rows - fast.num_rows
                rep["added"] += fast.num_rows
            else:
                keys = ds.key
                dup = (f"SELECT {_qcols(keys)} FROM inc GROUP BY ALL HAVING count(*) > 1")
                coll_q = f"SELECT i.{_RID} FROM inc i WHERE EXISTS (SELECT 1 FROM ({dup}) d WHERE {_match('d', 'i', keys)})"
                if ex:
                    coll_q += (f" OR EXISTS (SELECT 1 FROM (SELECT {_qcols(keys)} FROM {ex}) e "
                               f"WHERE {_match('e', 'i', keys)})")
                coll = con.execute(coll_q).to_arrow_table().column(_RID)
                con.register("coll", pa.table({_RID: coll}))
                fast = con.execute(f"SELECT * EXCLUDE ({_RID}) FROM inc WHERE {_RID} NOT IN "
                                   f"(SELECT {_RID} FROM coll)").to_arrow_table()
                rep["added"] += fast.num_rows
                if len(coll):
                    slow = con.execute(f"SELECT * EXCLUDE ({_RID}) FROM inc WHERE {_RID} IN "
                                       f"(SELECT {_RID} FROM coll) ORDER BY {_RID}").to_arrow_table()
                    state: dict[tuple, dict] = {}
                    stored_keys: set[tuple] = set()
                    if ex:
                        old = con.execute(
                            f"SELECT e.* FROM {_existing_sql(files, True)} e WHERE EXISTS (SELECT 1 FROM "
                            f"inc i WHERE i.{_RID} IN (SELECT {_RID} FROM coll) AND {_match('e', 'i', keys)})"
                        ).to_arrow_table()
                        for r in old.to_pylist():
                            k = _key_of(ds, r)
                            if k in state:
                                print(f"  ! lake: {ds.name} {part} {month} holds key {k} twice; "
                                      f"the first copy is used", file=sys.stderr)
                                continue
                            state[k] = {c: r.get(c) for c in ds.columns}
                            stored_keys.add(k)
                            stored_dir[k] = _dir_of(r["filename"])
                    new_keys: list[tuple] = []
                    for r in slow.to_pylist():
                        k = _key_of(ds, r)
                        action, row, conf = merge_row(ds, state.get(k), r)
                        rep[action] += 1
                        if conf:
                            conflicts.append((ds, part, sub, k, conf))
                        if row is not None:
                            state[k] = row
                            if k in stored_keys:
                                replaced[k] = row
                            elif action == "added":
                                new_keys.append(k)
                    added_py = [state[k] for k in new_keys]
            added_n = fast.num_rows + len(added_py)
            if added_py:
                fast = pa.concat_tables([_as_schema(ds, fast), _as_schema(ds, pa.Table.from_pylist(added_py))])
            fast = _as_schema(ds, fast)
            if not replaced:
                if added_n:
                    _write_part(_sorted(ds, fast), home)
                    rep["parts_written"] += 1
            else:
                # each replaced row is rewritten in the root it is stored in; added rows go home
                rep_list = list(replaced.items())
                rep_tbl = _as_schema(ds, pa.Table.from_pylist([r for _, r in rep_list]))
                con.register("rep_rows", rep_tbl)
                kept = con.execute(
                    f"SELECT {_qcols(ds.columns)}, filename FROM {_existing_sql(files, True)} e WHERE NOT "
                    f"EXISTS (SELECT 1 FROM rep_rows r WHERE {_match('e', 'r', ds.key)})").to_arrow_table()
                kept_dirs = pa.array([_dir_of(f) for f in kept.column("filename").to_pylist()], pa.string())
                home_k = os.path.normcase(str(home))
                full = pa.concat_tables([
                    _with_dir(_as_schema(ds, kept.drop(["filename"])), kept_dirs),
                    _with_dir(rep_tbl, pa.array([stored_dir[k] for k, _ in rep_list], pa.string())),
                    _with_dir(fast, home_k)])
                expect = sum(pq.ParquetFile(f).metadata.num_rows for f in files) + added_n
                if full.num_rows != expect:
                    raise OSError(f"{ds.name} {part} {month}: rewrite would hold {full.num_rows} rows, "
                                  f"expected {expect}; nothing written")
                dirs = {stored_dir[k] for k, _ in rep_list} | ({home_k} if added_n else set())
                rep["parts_written"] += _rewrite_dirs(ds, files, full, home, dirs)
                rep["rewrites"] += 1
            now_files = _files_for(ds, part, sub, month, cls)[2]
            per_dir: dict[str, int] = defaultdict(int)
            for f in now_files:
                per_dir[os.path.normcase(str(f.parent))] += 1
            strays = cls == "archive" and any(is_cache_dir(f.parent) for f in now_files)
            if any(n > compact_parts for n in per_dir.values()) or strays:
                # (and an archive series' rows the cache holds move into the lake here)
                r = compact_partition(ds, part, sub, month, _locked=True, cls=cls)
                rep["compactions"] += 1 if r["compacted"] else 0
        finally:
            con.close()
    return home


def compact_partition(ds: Dataset, part: str, sub: str | None, month: str,
                      _locked: bool = False, cls: str | None = None) -> dict:
    """Merge the parts of one partition into a single part PER ROOT (a row never changes root
    here: lake rows stay in the lake, cache rows in the cache), row count verified. cls "archive"
    also moves the rows of an archive series that the cache holds into the lake home."""
    def run():
        home, pdirs, files = _files_for(ds, part, sub, month, cls)
        for d in pdirs:
            if d.is_dir():
                recover(d)
        home, pdirs, files = _files_for(ds, part, sub, month, cls)
        per_dir: dict[str, int] = defaultdict(int)
        for f in files:
            per_dir[os.path.normcase(str(f.parent))] += 1
        maybe_strays = cls == "archive" and any(is_cache_dir(f.parent) for f in files)
        if not maybe_strays and all(n < 2 for n in per_dir.values()):
            return {"parts": len(files), "rows": None, "compacted": False}
        con = duckdb.connect()
        try:
            raw = con.execute(f"SELECT {_qcols(ds.columns)}, filename FROM {_existing_sql(files, True)}"
                              ).to_arrow_table()
        finally:
            con.close()
        expect = sum(pq.ParquetFile(f).metadata.num_rows for f in files)
        if raw.num_rows != expect:
            raise OSError(f"compact {ds.name} {part} {month}: read {raw.num_rows} of {expect} rows")
        was = [_dir_of(f) for f in raw.column("filename").to_pylist()]
        tbl = _with_dir(_as_schema(ds, raw.drop(["filename"])), pa.array(was, pa.string()))
        if cls == "archive":
            tbl = _route_archive_home(ds, part, sub, tbl, home)
        now = tbl.column(_DIR).to_pylist()
        moves = [(a, b) for a, b in zip(was, now) if a != b]
        dirs = {d for d, n in per_dir.items() if n >= 2} | {a for a, _ in moves} | {b for _, b in moves}
        if not dirs:
            return {"parts": len(files), "rows": None, "compacted": False}
        _rewrite_dirs(ds, files, tbl, home, dirs, tag="c")
        return {"parts": len(files), "rows": expect, "compacted": True, "moved_to_lake": len(moves)}
    if _locked:
        return run()
    with locked(_lock_dir(), partition_lock_name(ds, part, sub, month)):
        return run()


def _new_report() -> dict:
    return defaultdict(int, {"added": 0, "updated": 0, "upgraded": 0, "unchanged": 0, "skipped": 0,
                             "conflict": 0, "revised": 0, "moved": 0, "parts_written": 0,
                             "rewrites": 0, "compactions": 0})


def _stored_urls(ds: Dataset, part: str, want: dict) -> list[tuple[str, dict]]:
    """[(month, stored row)] of every row of venue `part` whose url is in `want`, in any month."""
    from . import reader
    by_month: dict[str, list[Path]] = defaultdict(list)
    for f, vals in reader.files(ds, part):
        by_month[vals["month"]].append(f)
    out: list[tuple[str, dict]] = []
    con = duckdb.connect()
    try:
        for month, fs in sorted(by_month.items()):
            got = con.execute(f"SELECT {_qcols(ds.columns)} FROM {_existing_sql(fs)} "
                              f"WHERE url IN (SELECT unnest(?))", [sorted(want)]).to_arrow_table()
            out += [(month, r) for r in _as_schema(ds, got).to_pylist()]
    finally:
        con.close()
    return out


def _plan_moves(ds: Dataset, norm: list, rep: dict, conflicts: list) -> tuple[list, dict]:
    """B-0544: a url the bank's other month partitions already hold. `norm` back without the rows a
    merge says to drop (a seed never moves a row, an equal one is unchanged), and the stored rows to
    remove AFTER the new ones landed and their `revised` conflicts were logged: {(part, month): [row]}.
    A crash in between leaves the url twice, never lost, and the same write again finishes it."""
    last: dict[tuple, dict] = {}
    months: dict[tuple, str] = {}
    for r in norm:
        k, m = (r["__part"], r["url"]), layout.month_of_date(r["meeting_date"])
        if months.setdefault(k, m) != m:
            raise WriteError(f"{ds.name} {r['__part']} {r['url']}: the batch holds this url under two "
                             f"meeting_date months ({months[k]}, {m}); a url is one row")
        last[k] = r
    drop: set[tuple] = set()
    removals: dict[tuple, list] = defaultdict(list)
    for part in sorted({k[0] for k in last}):
        want = {u: m for (p, u), m in months.items() if p == part}
        found = _stored_urls(ds, part, want)
        here = {o["url"] for m, o in found if m == want[o["url"]]}
        counted: set[str] = set()
        for month, old in found:
            url = old["url"]
            if month == want[url]:
                continue
            new = {c: last[(part, url)].get(c) for c in ds.columns}
            action, _, conf = merge_row(ds, old, new)
            rep[action] += 1
            if conf:
                conflicts.append((ds, part, None, (url,), conf))
            if action == "revised":
                rep["moved"] += 1
                if url not in here and url not in counted:
                    rep["added"] -= 1          # the new month adds it below; one row, counted once
                    counted.add(url)
                removals[(part, month)].append(old)
            else:
                drop.add((part, url))
    return [r for r in norm if (r["__part"], r["url"]) not in drop], dict(removals)


def _remove_moved(ds: Dataset, removals: dict) -> None:
    """Take each moved url's old row out of its partition (journaled rewrite, under its lock). A
    stored row that is no longer the one that was logged stays, with a warning."""
    from . import edit
    for (part, month), olds in sorted(removals.items()):
        logged = {o["url"]: o for o in olds}
        with edit.locked(ds.name, part, None, {month}):
            p = edit.read_partition(ds.name, part, None, month)
            keep, gone = [], 0
            for r in p.table.to_pylist():
                o = logged.get(r["url"])
                if o is None:
                    keep.append(r)
                elif {c: r.get(c) for c in ds.columns} == o:
                    gone += 1
                else:
                    keep.append(r)
                    print(f"  ! lake: {ds.name} {part} {month} {r['url']} changed since the move was "
                          f"planned; the old row stays", file=sys.stderr)
            if gone:
                edit.replace_partition(p, pa.Table.from_pylist(keep, schema=ds.schema))


def _log_conflicts(conflicts: list, now: int) -> None:
    by_part: dict[str, list] = defaultdict(list)
    for ds, part, sub, key, c in conflicts:
        sym = c["incoming"].get("symbol") if isinstance(c["incoming"], dict) else None
        by_part[part].append({
            "logged": now, "dataset": ds.name, "symbol": sym, "interval": sub,
            "key": json.dumps(dict(zip(ds.key, key)), default=str, sort_keys=True),
            "kind": c["kind"],
            "stored": json.dumps(c["stored"], default=str, sort_keys=True),
            "incoming": json.dumps(c["incoming"], default=str, sort_keys=True)})
    for part, rows in by_part.items():
        write("conflicts", rows, part, verbatim=False, update_catalog=True, _log=False)
    kinds: dict[tuple, int] = defaultdict(int)
    for ds, part, sub, key, c in conflicts:
        kinds[(ds.name, part, c["kind"])] += 1
    for (dsn, part, kind), n in sorted(kinds.items()):
        print(f"  ! lake: {n} {kind} on {dsn} {part} - "
              f"{'the incoming row replaced the stored one, the old one is logged' if kind == 'revised' else 'the stored row was kept'}"
              f" (fund_db.market.conflicts())", file=sys.stderr)


def write(dataset: str, rows, venue: str | None = None, *, interval: str | None = None,
          source: str | None = None, closed_asof_ms: int | None = None, verbatim: bool = False,
          now: int | None = None, update_catalog: bool = True, storage: str | None = None,
          cls: str | None = None, _log: bool = True) -> dict:
    """Write rows into `dataset`. `venue` is the partition value (the snapshot log name for
    snapshots); when None each row must carry it. `interval` is the candle interval.

    storage=None: the store resolves each series (declared archive -> the lake, else the
    dataset's default class); "cache" | "archive" asks for one, and is refused where it breaks
    the class contract (storage.resolve). A class-none dataset is refused. `cls=` is the same
    argument under platform's name (fundplat's store resolver passes it).

    verbatim=False (a fetch): `src` defaults to `source` or "venue", `seen` to now, candle
    `closed` is computed from the interval against `closed_asof_ms` (default now).
    verbatim=True (an import): `src`, `seen` and `closed` are stored exactly as given.

    Returns the report: counts per merge action, parts written, rewrites, compactions, the
    conflicts (as dicts) and the partitions and series touched."""
    ds = get(dataset)
    now = now_ms() if now is None else now
    norm, skipped = normalize(ds, rows, part=venue, sub=interval, source=source, now=now,
                              closed_asof_ms=closed_asof_ms, verbatim=verbatim)
    if ds.name == "contract_bars" and norm:
        from .contracts import require_registered
        by_venue: dict[str, set] = defaultdict(set)
        for r in norm:
            by_venue[r["__part"]].add(r["symbol"])
        for v, syms in by_venue.items():
            require_registered(v, syms)
    from . import storage as _storage
    if cls is not None:
        if storage is not None and storage != cls:
            raise WriteError(f"storage={storage!r} and cls={cls!r} disagree")
        storage = cls
    memo: dict[tuple, str] = {}
    for r in norm:                        # every series is resolved BEFORE anything is written
        k = (r["__part"], r["__sub"], r.get("symbol") if "symbol" in ds.series else "")
        if k not in memo:
            try:
                memo[k] = _storage.resolve(ds.name, k[0], k[2], k[1], storage)
            except _storage.StorageError as e:
                raise WriteError(str(e)) from None
        r["__cls"] = memo[k]
    rep = _new_report()
    rep["skipped"] += skipped
    conflicts: list = []
    removals: dict = {}
    if ds.extra.get("moves_across_months") and norm:
        norm, removals = _plan_moves(ds, norm, rep, conflicts)
    touched: dict[tuple, set] = defaultdict(set)
    cache_homes: dict[tuple, Path] = {}
    by_cls: dict[str, int] = defaultdict(int)
    if norm:
        schema = ds.schema.append(pa.field("__part", pa.string())).append(pa.field("__sub", pa.string()))             .append(pa.field("__cls", pa.string()))
        tbl = pa.Table.from_pylist(norm, schema=schema)
        tbl = tbl.append_column("__month", _month_col(ds, tbl))
        from .retention import rule
        cparts = rule(ds.name).compact_parts
        # one venue month may hold archive series (in the lake) and cache series (in the cache):
        # each class is merged as its own group, against every root, landing in its own root
        groups = tbl.group_by(["__part", "__sub", "__month", "__cls"]).aggregate([]).to_pylist()
        for g in sorted(groups, key=lambda g: (g["__part"], g["__sub"] or "", g["__month"], g["__cls"])):
            mask = pc.and_(pc.equal(tbl["__part"], g["__part"]), pc.equal(tbl["__month"], g["__month"]))
            mask = pc.and_(mask, pc.equal(tbl["__cls"], g["__cls"]))
            if ds.sub_key:
                mask = pc.and_(mask, pc.equal(tbl["__sub"], g["__sub"]))
            sub_tbl = tbl.filter(mask).select(list(ds.columns))
            cls = g["__cls"]
            home = _write_partition(ds, g["__part"], g["__sub"], g["__month"], sub_tbl, rep, conflicts,
                                    cparts, cls)
            by_cls[cls] += sub_tbl.num_rows
            if is_cache_dir(home):
                cache_homes[(g["__part"], g["__sub"], g["__month"])] = home
            syms = set(sub_tbl.column("symbol").unique().to_pylist()) if "symbol" in ds.series else {""}
            touched[(g["__part"], g["__sub"])].update(syms)
    if conflicts:
        if _log:
            _log_conflicts(conflicts, now)
    if removals:
        _remove_moved(ds, removals)           # only after the new rows landed and the old were logged
    if update_catalog and touched:
        from . import catalog
        for (part, sub), syms in touched.items():
            catalog.refresh_series(ds, part, sub, sorted(syms))
    if cache_homes:
        from . import cache
        cache.after_write(ds, cache_homes, now)
    out = dict(rep)
    out["storage"] = dict(by_cls)
    out["conflicts"] = [{"key": dict(zip(ds.key, k)), "partition": p, **c}
                        for _, p, _, k, c in conflicts]
    out["partitions"] = len({(p, s) for p, s in touched})
    out["series"] = sorted({(p, s or "", x) for (p, s), xs in touched.items() for x in xs})
    return out


# --------------------------------------------------------------------------------------------- #
# typed writers (the calls a fetcher makes)
# --------------------------------------------------------------------------------------------- #

def write_funding(venue: str, rows, symbol: str | None = None, source: str = "venue", **kw) -> dict:
    """Settled funding rows {ts|time, rate[, premium][, interval_h][, rate_type]} for `venue`;
    `symbol` fills rows that do not carry one."""
    rows = [dict(r, symbol=r.get("symbol") or symbol) for r in _rows_of(rows)]
    return write("funding", rows, venue, source=source, **kw)


def write_candles(venue: str, symbol: str, interval: str, bars, source: str = "venue",
                  closed_asof_ms: int | None = None, **kw) -> dict:
    """Bars {t, o, h, l, c, v, n}; `closed` is computed from the interval against
    closed_asof_ms (default now). A seed source is spelled "seed:<label>"."""
    rows = [dict(b, symbol=symbol) for b in _rows_of(bars)]
    return write("candles", rows, venue, interval=interval, source=source,
                 closed_asof_ms=closed_asof_ms, **kw)


def write_contract_bars(venue: str, symbol, interval: str, bars, *, what: str | None = None,
                        data_type: str | None = None, source: str = "venue",
                        closed_asof_ms: int | None = None, **kw) -> dict:
    """Bars {t | date, o, h, l, c, v, wap, n[, closed]} of ONE contract (`symbol` = the venue's
    contract id, e.g. a broker's numeric id) at one bar size. `what` and `data_type` fill rows that do not
    carry them. The contract must already be in market.contracts (write_contracts first)."""
    rows = [dict(b, symbol=str(symbol), what=b.get("what") or what,
                 data_type=b.get("data_type") or data_type) for b in _rows_of(bars)]
    return write("contract_bars", rows, venue, interval=interval, source=source,
                 closed_asof_ms=closed_asof_ms, **kw)


def write_predmkt_bars(venue: str, symbol: str, interval: str, bars, *, outcome: str | None = None,
                       px_kind: str | None = None, source: str = "venue",
                       closed_asof_ms: int | None = None, **kw) -> dict:
    """Bars {t, o, h, l, c, mean, prev, bid_*, ask_*, v, oi} (or samples {t, c}) of ONE outcome of
    one listing: `symbol` = predmkt_symbol(venue id, listed_ms), `t` the bar's OPEN ms (a venue
    that serves the end converts first). `outcome` and `px_kind` fill rows that do not carry
    them; `closed` is t + interval <= closed_asof_ms (default now)."""
    rows = [dict(b, symbol=symbol, outcome=b.get("outcome") or outcome,
                 px_kind=b.get("px_kind") or px_kind) for b in _rows_of(bars)]
    return write("predmkt_bars", rows, venue, interval=interval, source=source,
                 closed_asof_ms=closed_asof_ms, **kw)


def write_option_chain(venue: str, rows, *, ts: int | None = None, data_type: str | None = None,
                       source: str = "venue", **kw) -> dict:
    """One chain READ: rows {symbol, underlying, expiry, strike, right, raw[, root, bid, ask, iv,
    delta, ...]}. `ts` (our read time) and `data_type` fill rows that do not carry them; `ts`
    defaults to ONE now for the whole call, so a read is one instant. Settled on (symbol, ts)."""
    ts = now_ms() if ts is None else ts
    rows = [dict(r, ts=r.get("ts") if r.get("ts") is not None else ts,
                 data_type=r.get("data_type") or data_type) for r in _rows_of(rows)]
    return write("option_chains", rows, venue, source=source, **kw)


def write_eod(rows, venue: str = "eod", source: str = "venue", **kw) -> dict:
    return write("eod", rows, venue, source=source, **kw)


def write_cb(dataset: str, venue: str, rows, source: str = "venue", **kw) -> dict:
    """Rows of one central bank dataset (registry.CB_DATASETS) for `venue` (fed, boj, ecb):
    ARCHIVE class by the dataset default, so no venue.json declaration is needed. `source` is
    the row's `src` ('venue', 'seed:<label>', 'derived:llm', 'derived:classify')."""
    if dataset not in CB_DATASETS:
        raise WriteError(f"{dataset!r} is not a central bank dataset; they are {', '.join(CB_DATASETS)}")
    return write(dataset, rows, venue, source=source, **kw)


def write_rows(dataset: str, venue: str, rows, source: str = "venue", **kw) -> dict:
    """Any observation dataset (quotes, trades, orderbook, options, predmkts, snapshots, rates)."""
    return write(dataset, rows, venue, source=source, **kw)
