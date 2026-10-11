#!/usr/bin/env python3
"""FINGERPRINT - a digest of the data a run actually read.

Two runs on the same stored rows are ONE observation, however they were
labelled ("replications that share a DATA WINDOW are one result, not N"). A
window written as `2026-07-15..2026-09-22` does not say which rows were there:
the archive is appended to hourly, a venue's head can roll off before it was
archived, and a store can be rewritten. So a run names its INPUTS and this
tool digests the rows inside the window, read-only.

    python app/loop/tools/fingerprint.py --window 2026-07-15..2026-09-22 \
      --input exchange_a:xyz:ABCD:candles:1h --input exchange_a:xyz:ABCD:funding:-

INPUT SPEC: `venue:symbol:dataset:interval`. The symbol may itself carry a
colon (`xyz:ABCD`): the venue is the first field, dataset and interval the last
two, the symbol everything between. The interval `-` (or empty) names a series
stored without one (settled funding, daily end-of-day bars).

THE STORE: the fund's market lake, read through `fund_db.market` and nothing
else (the data law, root CLAUDE.md; the lake is `<data root>/market`, data root
`$FUND_DB_DIR` else `~/fund-data/db`). Read-only. The dataset is the lake's own
name (`funding`, `candles`, `eod`, `rates`, ...); `venue` is its partition value
and `interval` the candle interval. Funding, candle and eod rows are rebuilt into
the fixed canonical shapes of `fund_db.market.canonical` (the same shapes a pin
digests), so a fingerprint and a pin of the same rows agree byte for byte. Any
other dataset digests its stored columns minus the partition keys and nulls. Rows
with no ms stamp (`ts` / `t` / `time`, or a `date` on a daily dataset) are skipped.

PER INPUT: {venue, symbol, dataset, interval, first_ts, last_ts, rows, sha256,
stored_first, trunc}. first_ts / last_ts are ms stamps of the rows INSIDE the
window, sha256 digests those rows (each as sorted-key compact JSON with the
fetch-bookkeeping field `seen` dropped, in stamp order). `trunc` is true when
the first STORED stamp is later than the window's `from` by more than one
interval: the head the window asks for is not in the store.

THE WINDOW DIGEST: sha256 of the sorted per-input digests, cut to 8 hex chars.

THE PIN. Reads land in an EVICTABLE
cache, so a recorded result PINS the rows it read: `fingerprint(..., pin={reason,
ref})` hands each input to `pins.py` (the ONE adapter to fund_db's pin API), and
the input gains `pin` (the content hash, which must EQUAL its sha256 - a mismatch
is refused) or `pin: null` + `pin_error` (no pin API yet, the store failed, or no
rows in the window: an honest unpinned state, never a fake hash). The digest
itself never moves: pinning adds fields, it changes no byte of the sha256. The
CLI here never pins (`--pin-ref` would be a second writer); record.py,
remeasure.py and preregister.py do.

Refuses an input with no stored series: a digest of nothing is not a fingerprint.
Exit: 0 · 1 refused · 2 usage.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402

VOLATILE = ("seen",)
TS_KEYS = ("ts", "t", "time")
_IV = re.compile(r"^(\d+(?:\.\d+)?)([mhdw])$")
_IV_MS = {"m": 60_000, "h": 3_600_000, "d": 86_400_000, "w": 604_800_000}
FUNDING_TOL_MS = 8 * 3_600_000


def parse_spec(spec: str) -> dict:
    parts = (spec or "").strip().split(":")
    if len(parts) < 4 or not parts[0] or not parts[-2]:
        raise C.Refuse(f"--input {spec!r} must be venue:symbol:dataset:interval "
                       f"(interval '-' when the series has none)")
    sym = ":".join(parts[1:-2])
    if not sym:
        raise C.Refuse(f"--input {spec!r} names no symbol")
    iv = parts[-1].strip()
    return {"venue": parts[0].strip().lower(), "symbol": sym, "dataset": parts[-2].strip(),
            "interval": "" if iv in ("", "-") else iv}


def spec_of(inp: dict) -> str:
    """the input spec a fingerprint input came from (the inverse of parse_spec)."""
    return f"{inp['venue']}:{inp['symbol']}:{inp['dataset']}:{inp.get('interval') or '-'}"


def recorded_specs(row: dict) -> list[str]:
    """the input specs a recorded result row was fingerprinted over, in order; [] when none."""
    fp = (row or {}).get("fingerprint") or {}
    out = []
    for inp in fp.get("inputs") or []:
        try:
            sp = spec_of(inp)
        except (KeyError, TypeError):
            continue
        if sp not in out:
            out.append(sp)
    return out


def _market():
    """fund_db.market and the canonical row shapes, or a refusal naming why not."""
    try:
        from fund_db import market
        from fund_db.market import canonical
    except ImportError as e:
        raise C.Refuse(f"fund_db is not importable ({e}): install the database package into this "
                       f"interpreter (pip install -e database)") from None
    return market, canonical


def _legacy_shape(canonical, dataset: str):
    """the canonical shape a lake row of `dataset` is digested in, or None."""
    return canonical.SHAPES.get(dataset)


def stored_rows(s: dict) -> list[dict]:
    """every stored row of one series, in the old store's shape, read from the lake."""
    market, legacy = _market()
    try:
        ds = market.get(s["dataset"])
    except KeyError as e:
        raise C.Refuse(f"--input {spec_of(s)!r}: {e.args[0]}") from None
    if ds.sub_key and not s["interval"]:
        raise C.Refuse(f"--input {spec_of(s)!r}: {ds.name} is stored per {ds.sub_key}; name one")
    try:
        if ds.name == "candles":        # seed bars too: the old store held them
            rows = market.candles(s["venue"], s["symbol"], s["interval"], complete_only=False,
                                  as_="rows")
        else:
            rows = market.read(ds.name, s["venue"], symbols=[s["symbol"]],
                               interval=s["interval"] or None, as_="rows")
    except ValueError as e:
        raise C.Refuse(f"--input {spec_of(s)!r}: {e}") from None
    shape = _legacy_shape(legacy, ds.name)
    drop = set(ds.partition_keys)
    out = []
    for r in rows:
        if shape:
            r = shape(r)
        else:
            r = {k: v for k, v in r.items() if k not in drop and v is not None}
        if row_ts(r) is None and ds.time_kind == "date" and r.get(ds.time_col):
            r = dict(r, ts=to_ms(str(r[ds.time_col])))
        out.append(r)
    return out


def to_ms(s: str, end: bool = False) -> int:
    t = (s or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", t):
        d = dt.datetime.strptime(t, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
        if end:
            d = d + dt.timedelta(days=1) - dt.timedelta(milliseconds=1)
        return int(d.timestamp() * 1000)
    if re.fullmatch(r"\d{10,13}", t):
        n = int(t)
        return n if n > 1e12 else n * 1000
    t = t.replace("Z", "+00:00")
    try:
        d = dt.datetime.fromisoformat(t)
    except ValueError:
        raise C.Refuse(f"window stamp {s!r} is not ISO (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ)")
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return int(d.timestamp() * 1000)


def parse_window(text: str) -> tuple[int, int]:
    m = re.match(r"^\s*(\S+)\s*(?:\.\.|->|to)\s*(\S+)\s*$", text or "")
    if not m:
        raise C.Refuse("--window FROM..TO")
    a, b = to_ms(m.group(1)), to_ms(m.group(2), end=True)
    if b < a:
        raise C.Refuse(f"window ends before it starts: {text}")
    return a, b


def row_ts(row: dict):
    for k in TS_KEYS:
        v = row.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return int(v)
    return None


def tolerance_ms(interval: str) -> int:
    m = _IV.match(interval or "")
    return int(float(m.group(1)) * _IV_MS[m.group(2)]) if m else FUNDING_TOL_MS


def fingerprint_input(spec: str, frm: int, to: int) -> dict:
    s = parse_spec(spec)
    stored = stored_rows(s)
    if not stored:
        raise C.Refuse(f"--input {spec!r}: no stored series in the market lake")
    rows = []
    stored_first = None
    for r in stored:
        t = row_ts(r)
        if t is None:
            continue
        stored_first = t if stored_first is None else min(stored_first, t)
        if frm <= t <= to:
            rows.append((t, {k: v for k, v in r.items() if k not in VOLATILE}))
    rows.sort(key=lambda x: x[0])
    h = hashlib.sha256()
    for _, r in rows:
        h.update(json.dumps(r, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
        h.update(b"\n")
    return {
        **s,
        "first_ts": rows[0][0] if rows else None,
        "last_ts": rows[-1][0] if rows else None,
        "rows": len(rows),
        "sha256": h.hexdigest(),
        "stored_first": stored_first,
        "trunc": stored_first is None or stored_first > frm + tolerance_ms(s["interval"]),
    }


def window_digest(inputs: list[dict]) -> str:
    return hashlib.sha256("\n".join(sorted(i["sha256"] for i in inputs)).encode()).hexdigest()[:8]


def fingerprint(specs: list[str], frm: int, to: int, pin: dict | None = None) -> dict:
    """{digest, window {from, to} (ms), inputs[]} for the given specs over [frm, to].

    pin = {"reason": ..., "ref": ...} also PINS each input's in-window rows through
    pins.py (the one adapter to the pin API): each input gains `pin` (the hash, which
    equals its sha256) or `pin: None` + `pin_error`. A pin whose hash differs from the
    digest is refused (C.Refuse); every input is digested BEFORE any is pinned, so a bad
    spec refuses before a pin is written."""
    if not specs:
        raise C.Refuse("at least one --input")
    if pin is not None and (not pin.get("reason") or not pin.get("ref")):
        raise C.Refuse("a pinned fingerprint needs pin={'reason': ..., 'ref': ...}")
    seen, inputs = set(), []
    for sp in specs:
        if sp in seen:
            continue
        seen.add(sp)
        inputs.append(fingerprint_input(sp, frm, to))
    if pin is not None:
        import pins as P
        for inp in inputs:
            got = P.pin_input(inp, (frm, to), pin["reason"], pin["ref"])
            inp["pin"] = got["pin"]
            if got.get("pin_error"):
                inp["pin_error"] = got["pin_error"]
    return {"digest": window_digest(inputs), "window": {"from": frm, "to": to}, "inputs": inputs}


def pin_summary(fp: dict) -> str:
    """one short phrase for a fingerprint's pins: `pinned 2/2`, `pin skipped`, `not pinned`,
    or `pinned 0/2 (<the first reason>)`."""
    inputs = (fp or {}).get("inputs") or []
    if (fp or {}).get("pin_skipped"):
        return "pin skipped"
    if not any("pin" in i for i in inputs):
        return "not pinned"
    n = sum(1 for i in inputs if i.get("pin"))
    errs = [i["pin_error"] for i in inputs if i.get("pin_error")]
    return f"pinned {n}/{len(inputs)}" + (f" ({errs[0]})" if errs else "")


def for_window(specs: list[str], window: dict, pin: dict | None = None) -> dict:
    """fingerprint a run's window dict ({from, to} as written by preregister.py); `pin` as
    for fingerprint()."""
    if not window or not window.get("from") or not window.get("to"):
        raise C.Refuse("a fingerprint needs a window with both from and to")
    return fingerprint(specs, to_ms(str(window["from"])), to_ms(str(window["to"]), end=True),
                       pin=pin)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--input", action="append", default=[], help="venue:symbol:dataset:interval")
    ap.add_argument("--window", required=True, help="FROM..TO")
    a = ap.parse_args(argv)
    try:
        frm, to = parse_window(a.window)
        fp = fingerprint(a.input, frm, to)
    except C.Refuse as e:
        return C.die(str(e))
    print(json.dumps(fp, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
