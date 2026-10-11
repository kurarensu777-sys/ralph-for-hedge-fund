#!/usr/bin/env python3
"""BACKFILL - the honest historical import, and the only one there is.

A desk can open with a record it did not make here: the two pilot desks were
seeded from the code repo's own `HQ.md`, run by run, with their windows. Those
rows are EVIDENCE. They are not predictions, they were never pre-registered,
and the difference has to survive in the data - because once a row is in
`data/runs.jsonl` nothing downstream can tell an imported number from a
pre-registered one unless the row says so.

So every row this tool writes carries two fields, and every consumer reads them:

    "preregistered": false          never scored by grade.py, never counted as
                                    a run the desk chose (retro_due.py), never
                                    demanded a pre-flight by anyone
    "provenance": "backfilled <date> from <source>"

WHAT IT REFUSES, and each refusal is the same refusal: **this tool may not
create history, only import it.**

  * no `### <run>` entry in results-log.md   -> REFUSED. The prose ledger is
                                                the record; a row with no entry
                                                behind it is invention.
  * a result row already exists              -> REFUSED (write-once)
  * a PRE-FLIGHT exists for this run         -> REFUSED. That run was
                                                pre-registered here; `record.py`
                                                owns it and will grade it.
  * no window                                -> REFUSED (not admissible)
  * neither --verify nor --verify-none       -> REFUSED. A missing verify count
                                                is a fact about the run and is
                                                stated, never omitted.

    python app/loop/tools/backfill.py --desk carry --run 005 \
      --ran 2026-09-21 --source "HQ.md 2026-09-21" \
      --mechanic M1 --cmd "python -m mypkg.backtest --study simple" \
      --window 2026-02-20T02:00Z..2026-09-21T09:00Z --hours 5120 --regimes 1 \
      --verify "verify_carry_pro 16/16" \
      --metric ann_pct=26.40 --metric max_dd_pct=-3.40 --metric liquidations=0 \
      --headline "+$154,273 = +26.40% ann on $1M AUM"

Exit: 0 written · 1 refused · 2 usage.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402

WINDOW_RE = re.compile(r"^\s*(\S+)\s*(?:\.\.|->|to)\s*(\S+)\s*$")
VERIFY_RE = re.compile(r"^\s*(?P<suite>[\w.\-]+)?\s*(?P<p>\d+)\s*/\s*(?P<t>\d+)\s*$")


def build(args) -> tuple[C.Desk, dict]:
    desk = C.resolve_desk(args.desk)
    run_id = args.run.strip()
    if not run_id or " " in run_id:
        raise C.Refuse("--run must be a single token")

    log = C.results_log(desk)
    if run_id not in C.entry_ids(log):
        raise C.Refuse(
            f"{desk.rel}/results-log.md has no `### {run_id}` entry (it holds: "
            f"{', '.join(C.entry_ids(log)) or 'none'}). A backfill IMPORTS a row that the "
            f"prose ledger already carries; it may not create one. Write the entry first, "
            f"from a named source, or do not write the row at all.")
    if C.run_rows(desk, run_id, "preflight"):
        raise C.Refuse(f"{run_id} has a pre-flight at {desk.rel} - it was pre-registered here, "
                       f"so `record.py` owns its result and will grade it. Backfill is only "
                       f"for runs that happened before this ledger existed.")
    if C.run_rows(desk, run_id, "result"):
        raise C.Refuse(f"{run_id} already has a result row at {desk.rel} (write-once).")

    if args.probe:
        # A VENUE PROBE HAS NO PRICE WINDOW, and pretending it has one is the
        # lie this flag exists to avoid: the window of "we asked the venue what
        # it serves" is the DAY WE ASKED. It is marked `kind: probe` so nothing
        # downstream reads it as hours of market data.
        if args.window:
            raise C.Refuse("--probe and --window are two different claims; pass one.")
        day = _stamp(args.ran)[:10]
        window = {"from": day, "to": day, "kind": "probe"}
    else:
        m = WINDOW_RE.match(args.window or "")
        if not m:
            raise C.Refuse("--window FROM..TO is required - a row with no window is not "
                           "admissible as evidence anywhere in this tree. For a venue probe "
                           "(no price window at all) pass --probe instead.")
        window = {"from": m.group(1), "to": m.group(2)}
    if args.hours:
        window["hours"] = int(args.hours)
    if args.regimes:
        window["regimes"] = int(args.regimes)

    if args.verify:
        vm = VERIFY_RE.match(args.verify)
        if not vm:
            raise C.Refuse("--verify must be '<suite> n/n', e.g. 'verify_carry_pro 16/16'")
        verify = {"suite": (vm.group("suite") or "").strip(),
                  "passed": int(vm.group("p")), "total": int(vm.group("t"))}
    elif args.verify_none:
        verify = {"suite": "", "passed": None, "total": None,
                  "none_because": args.verify_none.strip()}
    else:
        raise C.Refuse("state the verify: --verify '<suite> n/n', or --verify-none "
                       "'<why this run has no verify count>'. A run whose verify count is "
                       "simply absent from the row is indistinguishable from one nobody ran.")

    if not args.source.strip():
        raise C.Refuse("--source is required: WHERE this history was transcribed from.")

    metrics = C.parse_kv_numbers(args.metric, "--metric")
    row = {
        "run": run_id,
        "stage": "result",
        "desk": desk.rel,
        "ts": _stamp(args.ran),
        "preregistered": False,
        "provenance": f"backfilled {C.today()} from {args.source.strip()}",
        "kind": "import",
        "mechanic": args.mechanic or None,
        "variables": [],
        "ancestor": None,
        "cmd": args.cmd.strip(),
        "window": window,
        "verify": verify,
        "predicted": {},
        "metrics": metrics,
        "headline": args.headline.strip(),
        "gradeable": False,
    }
    if args.void:
        row["void"] = args.void.strip()
    if args.note:
        row["note"] = args.note.strip()
    return desk, row


def _stamp(ran: str) -> str:
    """The date the run HAPPENED, not the date it was imported. The import date
    lives in `provenance`, so the two can never be confused."""
    s = (ran or "").strip()
    if not s:
        raise C.Refuse("--ran <date the run happened> is required")
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d"):
        try:
            import datetime as dt
            return dt.datetime.strptime(s.replace("Z", "") if fmt.endswith("Z") else s,
                                        fmt.replace("Z", "") if fmt.endswith("Z") else fmt
                                        ).strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            continue
    raise C.Refuse(f"--ran {ran!r} is not a date (YYYY-MM-DD or an ISO stamp)")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--desk", required=True)
    ap.add_argument("--run", required=True)
    ap.add_argument("--ran", required=True, help="the date the run HAPPENED")
    ap.add_argument("--source", required=True, help="where this was transcribed from")
    ap.add_argument("--window", default="", help="FROM..TO")
    ap.add_argument("--probe", action="store_true",
                    help="a venue probe: the window is the DAY the venue was asked")
    ap.add_argument("--hours", type=int, default=0)
    ap.add_argument("--regimes", type=int, default=0)
    ap.add_argument("--verify", default="", help="'<suite> n/n'")
    ap.add_argument("--verify-none", default="", help="why this run carries no verify count")
    ap.add_argument("--metric", action="append", default=[], help="name=number (repeatable)")
    ap.add_argument("--mechanic", default="")
    ap.add_argument("--cmd", default="")
    ap.add_argument("--headline", default="")
    ap.add_argument("--void", default="", help="this run is VOID; say why in one line")
    ap.add_argument("--note", default="")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    try:
        desk, row = build(a)
    except C.Refuse as e:
        return C.die(str(e))

    if a.dry:
        print(f"DRY - valid. Would append to {desk.rel}/data/runs.jsonl:\n")
        print(json.dumps(row, indent=2, ensure_ascii=False))
        return 0

    C.append_jsonl(desk.runs, row)
    if a.json:
        print(json.dumps(row, indent=2, ensure_ascii=False))
    else:
        print(f"imported {row['run']} at {desk.rel} · {row['provenance']} · "
              f"NOT gradeable (no pre-flight, and none will be invented)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
