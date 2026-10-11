#!/usr/bin/env python3
"""IS A RETRO OWED? - the debt line a session reads at arrival, and the mechanism behind it.

The agency's retro was "only a printed nag", and one account ran 31 posts with
ZERO retros. A nag with no mechanism is a rule that will rot. This is the
mechanism: it reads the stamp out of `beliefs.md`, counts the runs recorded
since it, and answers in an exit code that a scheduler (the cockpit's, schedule.json) can act on.

DUE when either is true, per the cadence:
  * the stamp is older than `--days` (default 7), or
  * more than `--runs` (default 5) runs have been recorded since it.

A desk with NO stamp and NO runs is not in debt - an honest empty ledger is the
correct starting state, and a red row for it would train the eye to ignore red.
A desk with pre-registered runs and no stamp has never retro'd, which IS the debt.
A desk with no stamp whose rows are ALL imported (backfill.py, `preregistered:
false`) is NOT due: a retro grades predictions and an import carries none. Its
owed +7d / +30d reads (digest.py) are a different debt, discharged by remeasure.py.

**Only a LIVE desk's overdue retro is a failure** (`status()` carries the
desk's state so a caller can grade it that way). A PRE-LIVE or OPENING desk
gets the same line at warn level, because it is information, not a breach.

    python app/loop/tools/retro_due.py              # every desk, human lines
    python app/loop/tools/retro_due.py --desk carry
    python app/loop/tools/retro_due.py --json
    python app/loop/tools/retro_due.py --line       # the one-line debt string (the scheduler's job)

Exit: 0 nothing due · 1 at least one desk is due.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402


def status(desk: C.Desk, max_days: int, max_runs: int) -> dict:
    stamp = C.retro_stamp(desk)
    ids = C.run_ids(desk)
    # A retro grades PREDICTIONS. Imported history (`preregistered: false`,
    # written by backfill.py) carries none by construction, so it cannot put a
    # desk into retro debt - it would be debt nobody could ever discharge. It
    # is counted separately and printed, never silently dropped.
    results = C.graded_results(desk)
    imported = [r for r in C.runs(desk)
                if r.get("stage") == "result" and C.is_import(r)]
    n_runs = len(results)

    since = n_runs
    through = stamp.get("run")
    if through:
        # "through run NN" - count results recorded after that run id
        seen = False
        count = 0
        for r in results:
            if seen:
                count += 1
            if str(r.get("run", "")).endswith(str(through)) or r.get("run") == through:
                seen = True
        since = count if seen else n_runs

    age_days = None
    if stamp.get("date"):
        d = dt.datetime.strptime(stamp["date"], "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
        age_days = (dt.datetime.now(dt.timezone.utc) - d).total_seconds() / 86400

    reasons = []
    if n_runs == 0 and not stamp.get("date"):
        # No stamp is only a debt once there is a PREDICTION to grade. A desk holding imported
        # rows alone (backfill.py) owes no retro; what it may owe is their fixed-age reads, a
        # separate debt that remeasure.py discharges and digest.py prints ("7d reads owed").
        due = False
        if imported:
            reasons.append(f"no stamp, but no graded run either - its {len(imported)} imported "
                           f"row(s) carry no prediction, so no retro is owed (their fixed-age "
                           f"reads are a separate debt: digest.py)")
        else:
            reasons.append("no runs and no retro - an honest empty ledger, not a debt")
    elif not stamp.get("date"):
        due = True
        reasons.append(f"never retro'd, and {n_runs} run(s) are recorded")
    else:
        due = False
        if age_days is not None and age_days > max_days:
            due = True
            reasons.append(f"stamp is {age_days:.1f} days old (> {max_days})")
        if since > max_runs:
            due = True
            reasons.append(f"{since} run(s) since the stamp (> {max_runs})")
        if not due:
            reasons.append(f"stamp {age_days:.1f}d old, {since} run(s) since")

    return {"desk": desk.rel, "state": C.desk_state(desk), "due": due,
            "stamp_date": stamp.get("date"), "stamp_raw": stamp.get("raw_date"),
            "through_run": through, "next_bet": stamp.get("bet"),
            "runs_recorded": n_runs, "runs_since": since,
            "imported": len(imported),
            "stamp_age_days": None if age_days is None else round(age_days, 1),
            "reasons": reasons, "ids": ids[-3:]}


def debt_line(rows: list[dict]) -> str:
    due = [r for r in rows if r["due"]]
    if not due:
        # "every desk's stamp is current" was a claim the data does not carry:
        # a tree where NO desk has ever stamped a retro printed exactly that
        # line. Say what is true - how many stamps exist, and that none of them
        # is overdue.
        stamped = [r for r in rows if r.get("stamp_date")]
        imports_only = [r for r in rows if not r.get("stamp_date") and r.get("imported")
                        and not r.get("runs_recorded")]
        tail = (f" ({len(imports_only)} unstamped desk(s) hold only imported rows, which owe no "
                f"retro)" if imports_only else "")
        return (f"retro debt: none - {len(stamped)}/{len(rows)} desk(s) carry a retro stamp, "
                f"and no desk is overdue.{tail}")
    parts = []
    for r in due:
        age = f"{r['stamp_age_days']:.0f}d" if r["stamp_age_days"] is not None else "never"
        parts.append(f"{r['desk']} ({age}, {r['runs_since']} run(s) since)")
    return ("RETRO DUE at " + str(len(due)) + " desk(s): " + " · ".join(parts)
            + "  ->  /retro <desk>")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--desk", default="")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--line", action="store_true", help="the one-line debt string only")
    ap.add_argument("--live-only", action="store_true",
                    help="consider only desks whose cadence.md says LIVE")
    a = ap.parse_args(argv)

    try:
        desks = [C.resolve_desk(a.desk)] if a.desk else C.all_desks()
    except C.Refuse as e:
        return C.die(str(e))

    rows = [status(d, a.days, a.runs) for d in desks]
    if a.live_only:
        rows = [r for r in rows if r["state"] == "LIVE"]

    if a.json:
        print(json.dumps(rows, indent=2, ensure_ascii=False))
    elif a.line:
        print(debt_line(rows))
    else:
        if not rows:
            print("no desks yet.")
            return 0
        for r in rows:
            mark = "DUE " if r["due"] else "ok  "
            imp = f", {r['imported']} imported" if r.get("imported") else ""
            print(f"{mark} {r['desk']:34} [{r['state']:8}] "
                  f"stamp {str(r['stamp_date'] or r['stamp_raw'] or 'none'):10} "
                  f"· {r['runs_recorded']} run(s), {r['runs_since']} since{imp}")
            for why in r["reasons"]:
                print(f"       {why}")
            if r["next_bet"]:
                print(f"       next bet: {r['next_bet'][:90]}")
        print()
        print(debt_line(rows))
    return 1 if any(r["due"] for r in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
