"""python -m fund_db.market <command> - the lake's maintenance commands.

    usage                          what is where and how big (datasets per tier, _files, live, _retired)
    tier   [--dataset D] [--apply] hot partitions past tier_after_days -> tier_to (dry run by default)
    prune  [--dataset D] [--apply] partitions past keep_days -> _retired/market (never deleted)
    compact [--dataset D] [--min-parts N]   merge a partition's parts into one
    catalog --rebuild [--dataset D] recompute every catalog row from the lake
    catalog --drain                replay refreshes queued while Postgres was down
    coverage [--dataset D] [--venue V] [--symbol S]   print catalog rows
    doctor                         finish interrupted rewrites, report temp files and pending refreshes
"""
from __future__ import annotations

import argparse
import json
import sys

from . import catalog, layout
from .registry import DATASETS


def _mb(b: int) -> str:
    return f"{b / 1e6:,.1f} MB"


def doctor() -> dict:
    """Walk every partition of every root (hot, cold, cache): complete or roll back an interrupted rewrite, list
    leftover temp files (a crash between write and rename), and count queued catalog refreshes."""
    from .retention import read_roots
    from .writer import recover
    out = {"recovered": [], "temp_files": [], "pending_catalog": 0}
    for ds in DATASETS.values():
        for root in read_roots(ds).values():
            for p in layout.partitions(root, ds):
                did = recover(p)
                if did:
                    out["recovered"].append(f"{p}: {did}")
                out["temp_files"] += [str(f) for f in p.glob(".*.tmp")]
    pend = catalog._pending_path()
    if pend.exists():
        out["pending_catalog"] = sum(1 for x in pend.read_text(encoding="utf-8").splitlines() if x.strip())
    return out


def main(argv=None) -> int:
    for st in (sys.stdout, sys.stderr):
        try:
            st.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    ap = argparse.ArgumentParser(prog="python -m fund_db.market", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("usage").add_argument("--json", action="store_true")
    for name in ("tier", "prune"):
        p = sub.add_parser(name)
        p.add_argument("--dataset", choices=sorted(DATASETS))
        p.add_argument("--apply", action="store_true")
    p = sub.add_parser("compact")
    p.add_argument("--dataset", choices=sorted(DATASETS))
    p.add_argument("--min-parts", type=int, default=2)
    p = sub.add_parser("catalog")
    p.add_argument("--rebuild", action="store_true")
    p.add_argument("--drain", action="store_true")
    p.add_argument("--dataset", choices=sorted(DATASETS))
    p = sub.add_parser("coverage")
    p.add_argument("--dataset"); p.add_argument("--venue"); p.add_argument("--symbol")
    sub.add_parser("doctor")
    a = ap.parse_args(argv)

    if a.cmd == "usage":
        from .retention import usage
        u = usage()
        if a.json:
            print(json.dumps(u, indent=1)); return 0
        for d in u["datasets"]:
            print(f"{d['dataset']:10s} {d['tier']:4s} {d['partitions']:5d} partitions {d['files']:6d} parts "
                  f"{d['rows'] or 0:12,d} rows {_mb(d['bytes']):>12s}  {d['first_month']}..{d['last_month']}")
        for o in u["other"]:
            print(f"{o['name']:15s} {o['files']:6d} files {_mb(o['bytes']):>12s}  {o['path']}")
        print(f"total {_mb(u['total_bytes'])}")
        return 0
    if a.cmd in ("tier", "prune"):
        from . import retention
        items = getattr(retention, a.cmd)(a.dataset, apply=a.apply)
        for it in items:
            print(f"{'moved' if a.apply else 'would move'} {it['from']} -> {it['to']} ({_mb(it['bytes'])})")
        print(f"{len(items)} partition(s){'' if a.apply else ' (dry run; --apply to move)'}")
        return 0
    if a.cmd == "compact":
        from . import compact
        for r in compact(a.dataset, a.min_parts):
            print(f"{r['partition']}: {r['parts']} parts -> 1 ({r['rows']} rows)")
        return 0
    if a.cmd == "catalog":
        if a.drain:
            print(f"replayed {catalog.drain()} queued refresh(es)")
        if a.rebuild:
            catalog.rebuild(a.dataset)
        if not (a.drain or a.rebuild):
            ap.error("catalog wants --rebuild and/or --drain")
        return 0
    if a.cmd == "coverage":
        for r in catalog.query(a.dataset, a.venue, a.symbol):
            print(json.dumps(r, default=str))
        return 0
    if a.cmd == "doctor":
        d = doctor()
        print(json.dumps(d, indent=1))
        return 1 if d["temp_files"] else 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
