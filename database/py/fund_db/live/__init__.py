"""fund_db.live - the hot log: frames appended the moment they arrive, closed hours rolled into the
market lake. DORMANT since 2026-09-26: its one writer, the feed recorder, was deleted with platform/feed (B-0184), and the law says live data is on demand and stored nowhere, so nothing may write it again (B-0191). The API below is kept whole and tested; <data root>/live/_locks/ is in use
(market/lock.py) whether or not anything records.

    from fund_db import live
    live.record("quotes", "exchange_a", [{"symbol": "BTCUSDT", "ts": ..., "bid": ..., "ask": ...}])
    live.record("candles", "exchange_b", [bar], interval="1h")
    live.record("prints", "exchange_a", [{"symbol": "BTCUSDT", "ts": ..., "px": ..., "sz": ...,
                                       "side": "buy"}])          # the tape, aggressor side
    live.record("liquidations", "exchange_a", [{"symbol": ..., "ts": ..., "side": "sell", "px": ...,
                                             "sz": ...}])
    live.record("predicted_funding", "exchange_b", [{"symbol": "BTC", "ts": ..., "rate": ...,
                                                      "interval_h": 1.0, "next_ts": ...}])
    live.roll()                       # every closed hour -> the lake (the retired feed ran it hourly)
    live.hot_table("quotes", "exchange_a")   # rows recorded but not yet rolled

LAYOUT  <data root>/live/<dataset>/<part>=<v>/[<sub>=<s>/]<YYYY-MM-DDTHH>.jsonl
        One file per RECEIVE hour (UTC wall clock of the recorder), one JSON row per line. The
        file a row lands in says when we got it; the lake partition it rolls into is chosen by
        the row's own time column, as for any write.

VALIDATION AT RECORD TIME
  Every row must carry the dataset's required columns. prints and liquidations also need an
  event ms `ts`, a positive `sz` in base units, a positive `px` and `side` 'buy' | 'sell';
  predicted_funding needs the whole atomic unit (rate, interval_h > 0 as published, next_ts).
  A `funding` row carrying `next_ts` is a prediction and is refused: predicted funding has its
  own dataset and never enters the settled one. A refused batch writes nothing.

CRASH SAFETY
  * record() appends whole lines and flushes (fsync=True also fsyncs) under the file's
    cross-process lock; a crash can at worst leave one torn LAST line, which every reader skips
    (and roll() reports).
  * roll() writes a file's rows through fund_db.market.write (merge rules, conflicts, catalog)
    and only THEN removes the file. A crash between the two replays the file on the next roll,
    and the replay is a no-op: the writer drops an exact duplicate observation and a settled or
    closed row that did not change. Nothing is lost and nothing lands twice.
  * An hour is rolled only once it ended more than `grace_s` ago, so a recorder still finishing
    its last append of the hour is never raced; the file lock covers the rest.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa

from fund_db import config
from fund_db.market import layout
from fund_db.market.lock import locked
from fund_db.market.registry import get

HOUR_MS = 3_600_000
# columns the writer derives, so a recorded frame need not carry them
_COMPUTED = {"candles": ("closed",), "snapshots": ("t",), "eod": ("time",)}
SIDES = ("buy", "sell")


def _num(v) -> float | None:
    """A real finite number, or None (a bool, a string or a NaN is not a size or a price)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def _ms(v) -> bool:
    """An epoch ms: a whole positive number (an int, or a float with no fraction)."""
    f = _num(v)
    return f is not None and f > 0 and f.is_integer()


def _check_tape(r: dict) -> list[str]:
    """prints and liquidations: an event ms, a positive size in base units, a positive price and
    a side of 'buy' | 'sell'."""
    bad = []
    if not _ms(r.get("ts")):
        bad.append(f"ts={r.get('ts')!r} is not an event ms")
    sz, px = _num(r.get("sz")), _num(r.get("px"))
    if sz is None or sz <= 0:
        bad.append(f"sz={r.get('sz')!r} is not a positive size in base units")
    if px is None or px <= 0:
        bad.append(f"px={r.get('px')!r} is not a positive price")
    if r.get("side") not in SIDES:
        bad.append(f"side={r.get('side')!r} is not one of {SIDES}")
    return bad


def _check_predicted(r: dict) -> list[str]:
    """predicted_funding: the whole atomic unit (rate, interval_h, next_ts), never an assumed
    interval."""
    bad = []
    if not _ms(r.get("ts")):
        bad.append(f"ts={r.get('ts')!r} is not an ms")
    if not _ms(r.get("next_ts")):
        bad.append(f"next_ts={r.get('next_ts')!r} is not a settlement ms")
    if _num(r.get("rate")) is None:
        bad.append(f"rate={r.get('rate')!r} is not a finite number")
    iv = _num(r.get("interval_h"))
    if iv is None or iv <= 0:
        bad.append(f"interval_h={r.get('interval_h')!r} is not a positive published interval")
    return bad


def _check_funding(r: dict) -> list[str]:
    """funding holds SETTLED rows only: a row carrying a prediction's next_ts is refused."""
    if r.get("next_ts") is not None:
        return ["next_ts marks a PREDICTED rate, which is not the settled contract; record it "
                "as predicted_funding"]
    return []


# record-time checks beyond the required columns, so a bad frame fails at the recorder
_CHECKS = {"prints": _check_tape, "liquidations": _check_tape,
           "predicted_funding": _check_predicted, "funding": _check_funding}


def hot_root() -> Path:
    return config.live_dir()


def _now() -> int:
    return int(time.time() * 1000)


def _hour_of(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H")


def _hour_end_ms(stem: str) -> int:
    dt = datetime.strptime(stem, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000) + HOUR_MS


def _dir(dataset: str, venue: str, interval: str | None) -> Path:
    ds = get(dataset)
    if ds.sub_key and not interval:
        raise ValueError(f"{dataset} needs an {ds.sub_key}")
    part = venue.lower() if ds.part_key == "venue" else venue
    d = hot_root() / ds.name / f"{ds.part_key}={layout.enc(part)}"
    if ds.sub_key:
        d = d / f"{ds.sub_key}={layout.enc(interval)}"
    return d


def _lock_name(path: Path) -> str:
    return "live|" + os.path.normcase(str(path))


def _lock_dir() -> Path:
    return hot_root() / "_locks"


def record(dataset: str, venue: str, rows, *, interval: str | None = None,
           source: str = "venue:ws", now: int | None = None, fsync: bool = False) -> dict:
    """Append rows to this hour's hot log. Each row gets `src` (default "venue:ws") and `seen`
    (now) unless it carries its own; the row is validated against the dataset's required columns
    now, so a bad frame fails at the recorder and never poisons a roll."""
    ds = get(dataset)
    now = _now() if now is None else now
    rows = list(rows)
    if not rows:
        return {"rows": 0, "path": None}
    lines = []
    for r in rows:
        r = dict(r)
        r.setdefault("src", source)
        if r.get("seen") is None:
            r["seen"] = now
        if ds.name == "funding" and r.get("ts") is None and "time" in r:
            r["ts"] = r.pop("time")
        missing = [c for c in ds.required
                   if c not in _COMPUTED.get(ds.name, ()) and r.get(c) is None]
        if missing:
            raise ValueError(f"live.record {dataset} {venue}: row missing {missing}: {r!r}")
        check = _CHECKS.get(ds.name)
        bad = check(r) if check else []
        if bad:
            raise ValueError(f"live.record {dataset} {venue}: row refused ({'; '.join(bad)}): {r!r}")
        lines.append(json.dumps(r, separators=(",", ":"), default=str))
    d = _dir(dataset, venue, interval)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{_hour_of(now)}.jsonl"
    data = ("\n".join(lines) + "\n").encode("utf-8")
    with locked(_lock_dir(), _lock_name(path)):
        with open(path, "ab") as f:
            # a previous writer that died mid-line left no newline: start on a fresh line so its
            # torn tail stays one bad line and this batch stays whole
            if f.tell() > 0:
                with open(path, "rb") as r:
                    r.seek(-1, os.SEEK_END)
                    if r.read(1) != b"\n":
                        f.write(b"\n")
            f.write(data)
            f.flush()
            if fsync:
                os.fsync(f.fileno())
    return {"rows": len(lines), "path": str(path)}


def _read_lines(path: Path) -> tuple[list[dict], int]:
    rows, bad = [], 0
    with open(path, "rb") as f:
        for raw in f:
            if not raw.strip():
                continue
            try:
                rows.append(json.loads(raw))
            except ValueError:
                bad += 1
    return rows, bad


def hot_files(dataset: str | None = None) -> list[tuple[str, dict, Path]]:
    """[(dataset, {part_key: v[, sub_key: s]}, file)] for every hot log file."""
    out = []
    root = hot_root()
    if not root.is_dir():
        return out
    for dsdir in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("_")):
        if dataset and dsdir.name != dataset:
            continue
        try:
            ds = get(dsdir.name)
        except KeyError:
            continue
        for f in sorted(dsdir.rglob("*.jsonl")):
            rel = f.parent.relative_to(dsdir).parts
            vals = {}
            for comp in rel:
                k, _, v = comp.partition("=")
                vals[k] = layout.dec(v)
            if set(vals) != set(ds.partition_keys):
                continue
            out.append((ds.name, vals, f))
    return out


def hot_table(dataset: str, venue: str | None = None, interval: str | None = None) -> pa.Table:
    """Every row in the hot log for dataset (optionally one venue / interval), normalized like a
    write would store it, with the partition columns. Used by readers with include_live=True."""
    from fund_db.market.writer import normalize
    ds = get(dataset)
    if venue is not None and ds.part_key == "venue":
        venue = venue.lower()
    out = []
    now = _now()
    for _, vals, f in hot_files(dataset):
        if venue is not None and vals[ds.part_key] != venue:
            continue
        if interval is not None and ds.sub_key and vals[ds.sub_key] != interval:
            continue
        rows, _ = _read_lines(f)
        norm, _ = normalize(ds, rows, part=vals[ds.part_key], sub=vals.get(ds.sub_key), source=None,
                            now=now, closed_asof_ms=None, verbatim=False)
        for r in norm:
            r[ds.part_key] = r.pop("__part")
            s = r.pop("__sub")
            if ds.sub_key:
                r[ds.sub_key] = s
            out.append(r)
    schema = pa.schema([pa.field(k, pa.string()) for k in ds.partition_keys] + list(ds.schema))
    schema = pa.schema([f.with_nullable(True) for f in schema])
    return pa.Table.from_pylist(out, schema=schema) if out else schema.empty_table()


def _last_per_key(ds, rows: list[dict]) -> tuple[list[dict], int]:
    """A stream re-sends a forming bar as it moves, so one hot file can hold several states of
    the same bar. roll() closes every bar of a closed hour at once, and the lake keeps the FIRST
    closed state of a key and logs any later one as a conflict - so writing them all kept the
    oldest state and filed the newer ones as conflicts. Keep only the LAST state recorded for each
    key (file order is receive order), in the order the kept rows arrived. -> (rows, dropped)"""
    last: dict[tuple, int] = {}
    for i, r in enumerate(rows):
        last[tuple(r.get(c) for c in ds.key)] = i
    keep = sorted(last.values())
    return [rows[i] for i in keep], len(rows) - len(keep)


def roll(now: int | None = None, grace_s: int = 60, dataset: str | None = None,
         include_open: bool = False) -> list[dict]:
    """Move every CLOSED hour of the hot log into the lake. include_open=True also rolls the
    current hour (shutdown). Returns one report per file."""
    from fund_db.market.writer import write
    now = _now() if now is None else now
    out = []
    for name, vals, f in hot_files(dataset):
        ds = get(name)
        stem = f.stem
        try:
            ended = _hour_end_ms(stem)
        except ValueError:
            continue
        if not include_open and ended + grace_s * 1000 > now:
            continue
        with locked(_lock_dir(), _lock_name(f)):
            if not f.exists():
                continue
            rows, bad = _read_lines(f)
            rep = {"file": str(f), "dataset": name, **vals, "rows": len(rows), "bad_lines": bad}
            if ds.rule == "bar":
                rows, rep["superseded"] = _last_per_key(ds, rows)
            if rows:
                w = write(name, rows, vals[ds.part_key], interval=vals.get(ds.sub_key),
                          source=None, verbatim=False, now=now)
                rep.update(added=w["added"], unchanged=w["unchanged"],
                           conflicts=len(w["conflicts"]))
            if bad:
                # keep the evidence of a torn line: the file moves aside instead of vanishing
                dst = hot_root() / "_torn" / f.relative_to(hot_root())
                dst.parent.mkdir(parents=True, exist_ok=True)
                os.replace(f, dst)
                rep["torn_kept"] = str(dst)
                print(f"  ! live: {bad} unreadable line(s) in {f}; rolled the rest, file kept at "
                      f"{dst}", file=sys.stderr)
            else:
                f.unlink()
            rep["rolled"] = True
        out.append(rep)
        try:
            p = f.parent
            while p != hot_root() and not any(p.iterdir()):
                p.rmdir(); p = p.parent
        except OSError:
            pass
    return out
