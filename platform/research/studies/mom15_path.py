"""The Binance 1-second path behind the lookback sweep of the directional momentum study (B-0660): one UTC day in, one small derived blob out.

The decision tables of the strategy search (`tf15_table`) keep the Binance path only from 60 s before a window's start, which serves a lookback of one minute. The sweep goes to
five minutes, so this module seats, per UTC day and per coin, the trade-implied mid (`updown15_run.mid_proxy`, as of each whole second) from 10 minutes before the day to the last
second of it (the engine builds one day plus one second of grid). A window's lookback series is then a slice of it; at a whole second the value equals the table's `S` exactly
(`mom15_bt.MTab` asserts it).

    python mom15_path.py run 2026-10-03 [2026-10-04 ...] [--force]
    python mom15_path.py status
"""
from __future__ import annotations

import argparse
import json
import sys
import time

import numpy as np

import updown15_day as D
import updown15_runner as RN

CODE = "mom15-path-2026-10-08a"
DATASET = "mom15-path"
PRE_S = 600
POST_S = 1
DAY_S = 86_400


def key_of(day: str) -> str:
    return f"{day}@{CODE}"


def seated(day: str):
    from fundplat.data import derived
    try:
        return derived.get(DATASET, key_of(day))
    except KeyError:
        return None


def derive_day(day: str, trades):
    """-> (arrays {btc, eth, sol, xrp: float64 (PRE_S + DAY_S + POST_S,)}, meta). Second i is day_start - PRE_S + i."""
    t0 = time.time()
    assets, metas = D.build_assets(day, trades, kinds=("mid",))
    ds = D.day_start_ms(day)
    arrs = {}
    for a in D.ASSETS:
        A = assets[a]["mid"]
        i0 = (ds - PRE_S * 1000 - A.g0) // 1000
        arrs[a] = np.asarray(A.gp[i0: i0 + PRE_S + DAY_S + POST_S], np.float64)
        assert len(arrs[a]) == PRE_S + DAY_S + POST_S and np.isfinite(arrs[a]).all(), f"{a}: the grid does not cover the day"
    meta = dict(code=CODE, day=day, pre_s=PRE_S, post_s=POST_S, seconds=round(time.time() - t0, 1), binance=metas)
    return arrs, meta


def load(day: str):
    """-> (arrays, meta) of a seated day; LookupError when it is not seated."""
    b = seated(day)
    if b is None:
        raise LookupError(f"path day {day} is not seated: python mom15_path.py run {day}")
    return D.unpack(b)


def run_day(day: str, force: bool = False, log=print) -> dict:
    from fundplat.data import derived
    old = seated(day)
    if old is not None and not force:
        log(f"{day}: seated ({len(old) / 1e6:.1f} MB), skipped")
        return dict(day=day, skipped=True)
    t0 = time.time()
    src = RN.Sources()
    arrs, meta = derive_day(day, src.trades)
    blob = D.pack(arrs, meta)
    res = derived.put(DATASET, key_of(day), blob, {"code": CODE})
    row = dict(day=day, bytes=len(blob), seconds=round(time.time() - t0, 1), seat=res)
    log(json.dumps(row, default=str))
    return row


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="mom15_path")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run")
    p.add_argument("days", nargs="+")
    p.add_argument("--force", action="store_true")
    sub.add_parser("status")
    a = ap.parse_args(argv)
    if a.cmd == "status":
        from fundplat.data import derived
        print(json.dumps(derived.keys(DATASET)))
        return 0
    for d in a.days:
        run_day(d, force=a.force)
    return 0


if __name__ == "__main__":
    sys.exit(main())
