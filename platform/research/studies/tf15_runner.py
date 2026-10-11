"""Derive and seat the decision tables of the strategy search (B-0654), one UTC day at a time.

    python tf15_runner.py run 2026-10-03 [2026-10-04 ...] [--force] [--fill-ms 250] [--decide-ms 100]
    python tf15_runner.py status
    python tf15_runner.py smoke 2026-09-05 --fill-ms 250 --decide-ms 100     (the gate clock against the old table of the same day; both seated)

The inputs are the pinned ladders and the Binance day files, read through `fundplat.data` (see `updown15_runner.Sources`). A seated day with the same key is skipped.
Keys: decide_ms 0 (the gate reads the book at the Binance print) is the old table, `<day>@tf15-2026-10-08b[-d<fill>]`; decide_ms > 0 (the gate reads the book
at t + decide_ms, the fill at t + fill_ms) is `<day>@tf15-2026-10-11a-d<fill>-g<decide>` (see `tf15_table`, THE CLOCK).
"""
from __future__ import annotations

import argparse
import json
import sys
import time

import tf15_table as T
import updown15_runner as RN


def key_of(day: str, fill_ms: int = T.FILL_MS, decide_ms: int = 0) -> str:
    if int(decide_ms) == 0:
        return f"{day}@{T.CODE_V0}" + ("" if fill_ms == T.FILL_MS else f"-d{fill_ms}")
    return f"{day}@{T.CODE}-d{int(fill_ms)}-g{int(decide_ms)}"


def seated(day: str, fill_ms: int = T.FILL_MS, decide_ms: int = 0):
    from fundplat.data import derived
    try:
        return derived.get(T.DATASET, key_of(day, fill_ms, decide_ms))
    except KeyError:
        return None


def load(day: str, fill_ms: int = T.FILL_MS, decide_ms: int = 0):
    """-> (arrays, meta) of a seated day; LookupError when it is not seated (run it first)."""
    b = seated(day, fill_ms, decide_ms)
    if b is None:
        raise LookupError(f"table day {day} is not seated: python tf15_runner.py run {day} --fill-ms {fill_ms} --decide-ms {decide_ms}")
    return T.unpack(b)


def run_day(day: str, force: bool = False, log=print, fill_ms: int = T.FILL_MS, decide_ms: int = 0) -> dict:
    from fundplat.data import derived
    old = seated(day, fill_ms, decide_ms)
    if old is not None and not force:
        log(f"{day}: seated ({len(old) / 1e6:.1f} MB), skipped")
        return dict(day=day, skipped=True)
    t0 = time.time()
    rows = [RN._as_row(r) for r in RN.market_rows(day)]
    src = RN.Sources()
    arrs, meta = T.derive_day(day, rows, src.trades, src.hours, fill_ms=fill_ms, decide_ms=decide_ms)
    meta["pin_missing"] = [m[0] for m in src.missing][:50]
    blob = T.pack(arrs, meta)
    res = derived.put(T.DATASET, key_of(day, fill_ms, decide_ms), blob, {"code": T.code_of(decide_ms), "fill_ms": int(fill_ms), "decide_ms": int(decide_ms),
                                                                         "markets": len(rows), "markets_without_a_pinned_book": len(src.missing)})
    row = dict(day=day, fill_ms=int(fill_ms), decide_ms=int(decide_ms), windows=meta["windows"], ok=meta["ok"], bytes=len(blob), seconds=round(time.time() - t0, 1), no_pin=len(src.missing), seat=res)
    log(json.dumps(row, default=str))
    return row


def smoke(day: str, fill_ms: int = 250, decide_ms: int = 100, base_fill_ms: int = 250, log=print) -> list[tuple[str, bool]]:
    """The gate clock on one seated day, against the old table (gate at t, fill at t + base_fill_ms): the Binance features are the same; where the gate's row
    arrived inside (t, t + decide_ms] the quotes may differ and the row is younger than decide_ms; elsewhere the quotes are the old ones and the age is the
    old age plus decide_ms; with the same fill the ladder is the same. -> [(label, passed)]."""
    import numpy as np
    old, _ = load(day, base_fill_ms, 0)
    new, mn = load(day, fill_ms, decide_ms)
    ok = old["w_status"] == 0
    qa0, qa1, a0, a1 = old["qa"][ok], new["qa"][ok], old["age"][ok], new["age"][ok]
    have = (a0 >= 0) & (a1 >= 0)
    diff = have & np.isfinite(qa0) & np.isfinite(qa1) & (qa0 != qa1)
    same = have & (a1 >= decide_ms)
    log(f"{day} gate +{decide_ms} ms, fill +{fill_ms} ms: {int(have.sum()):,} window-seconds, the gate's row newer than t on {float((have & (a1 < decide_ms)).mean()):.1%}, "
        f"qa differs from the old table on {int(diff.sum()):,}")
    out = [("the same windows are usable", bool(np.array_equal(ok, new["w_status"] == 0))),
           ("the new qa differs from the old somewhere (the gate moved)", int(diff.sum()) > 0),
           ("every changed qa sits on a row younger than decide_ms", bool(np.all(a1[diff] < decide_ms))),
           ("an unchanged row keeps the old quote", bool(np.allclose(qa0[same], qa1[same], equal_nan=True))),
           ("age is measured from t + decide_ms", bool(np.all(a1[same] == a0[same] + decide_ms))),
           ("the Binance features are the old ones", all(np.allclose(old[k][ok], new[k][ok], equal_nan=True) for k in ("S", "z", "pu", "zl"))),
           ("the meta names the clock", mn.get("decide_ms") == decide_ms and mn["fill_ms"] == fill_ms and mn["code"] == T.code_of(decide_ms))]
    if fill_ms == base_fill_ms:
        out.append(("the same fill reads the same ladder", bool(np.allclose(old["lad"][ok], new["lad"][ok], equal_nan=True))))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="tf15_runner")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run")
    p.add_argument("days", nargs="+")
    p.add_argument("--force", action="store_true")
    p.add_argument("--fill-ms", type=int, default=T.FILL_MS)
    p.add_argument("--decide-ms", type=int, default=0, help="the gate reads the book at t + decide_ms (own latency); the fill stays t + fill_ms")
    sub.add_parser("status")
    p = sub.add_parser("smoke")
    p.add_argument("day")
    p.add_argument("--fill-ms", type=int, default=250)
    p.add_argument("--decide-ms", type=int, default=100)
    a = ap.parse_args(argv)
    if a.cmd == "smoke":
        res = smoke(a.day, a.fill_ms, a.decide_ms)
        for name, ok in res:
            print(("PASS " if ok else "FAIL ") + name)
        return 0 if all(ok for _, ok in res) else 1
    if a.cmd == "status":
        from fundplat.data import derived
        print(json.dumps(derived.keys(T.DATASET)))
        return 0
    for d in a.days:
        run_day(d, force=a.force, fill_ms=a.fill_ms, decide_ms=a.decide_ms)
    return 0


if __name__ == "__main__":
    sys.exit(main())
