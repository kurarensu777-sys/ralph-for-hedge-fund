#!/usr/bin/env python3
"""SILENCE -> A RED ROW. The renderer that makes a missing reading visible.

The agency's measurement script died and nobody noticed for weeks, because it
stopped producing output and no output looks like no problem. Two rules here,
and they are the whole point of the file:

  1. THE EXPECTED SET IS THE REGISTRY, NOT THE STORE. This walks
     `_probe.REGISTRY` (plus the sweep's own row) and reports a probe with NO
     recorded reading (ops.health_readings, probe_id system:<id>) as
     `unknown - never reported`. Walking the readings instead would make a
     probe that never ran render as nothing at all, which is what "died
     silently" means.

  2. AN OLD READING IS NOT A READING. Any row whose `probed_ts + window_s` has
     passed renders `stale`, whatever it says. A green row from four days ago
     is not evidence that anything is green today; it is evidence that
     something stopped writing.

  3. A READING NOTHING WRITES IS AN ORPHAN, NOT A SILENCE. The store keeps every reading ever
     recorded, so an id that was renamed or moved (a job whose writer went elsewhere) would sit
     there aging and go red for good. The rows judged are EXPLICIT: the registry and the sweep (rule 1),
     plus the readings their writers are known to record - every ENABLED schedule.json job with
     `health` true (the scheduler records it), the budget meter (app/tools/budget/usage.py
     records system:budget itself) and fundd's own `scheduler` row. Those are judged when present;
     one not recorded yet is the scheduler's to show (unrun), not a silence here. Any other stored
     reading is reported by name as an ORPHAN and never judged: no agent deletes it (the data law),
     and nothing here pretends it still means something.

It never rewrites a probe's reading. Overwriting the reading would destroy
the one fact that dates the silence.

    python app/tools/probes/staleness.py [--json] [--quiet] [--dry]

`--dry` names the expected set and reads nothing (exit 0).

Exit: 0 everything fresh and ok · 1 anything stale, never-reported or failing ·
2 nothing silent or failing, but a row reports unknown / warn (a nag, a missed run, a
closed port): the probe contract's unknown, never a red.

TWO ROWS ARE NOT JUDGED ON THEIR STATUS (2026-09-25). This probe's OWN row: the judge
cannot grade its own last verdict, and doing so kept it red for good once it had been
red once. And `scheduler`: its status tallies every job's newest run, INCLUDING this
probe's own last exit, so a red here reddened the scheduler, which reddened this on the
next run, long after the cause was gone. Every job in that tally already has its own
row, so the scheduler row is judged on silence only (its window is 3 passes).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _probe as P  # noqa: E402

ORDER = {"fail": 0, "stale": 1, "unknown": 2, "ok": 3, "orphan": 5}
SELF = "probe-staleness"
LIVENESS_ONLY = {"scheduler"}
# readings recorded by a writer that is neither a registry probe nor a schedule.json health job
RECORDED_BY_ITSELF = {
    "budget": "app/tools/budget/usage.py (records system:budget; its job's health is false on purpose)",
    "scheduler": "fundd's scheduler, after every pass (server/sched)",
}


def verdict(r: dict) -> str:
    """silent | red | amber | ok | self - what one row means for THIS probe's exit"""
    if r["id"] == SELF:
        return "self"
    if r["effective"] == "orphan":
        return "orphan"
    if r["effective"] == "stale" or r["reading"] in ("never reported", "the ops store is unreadable"):
        return "silent"
    if r["id"] in LIVENESS_ONLY and r["age_s"] is not None:
        return "ok"
    return {"fail": "red", "ok": "ok"}.get(r["effective"], "amber")


def age_str(s: float) -> str:
    if s < 90:
        return f"{s:.0f}s"
    if s < 5400:
        return f"{s / 60:.0f}m"
    if s < 48 * 3600:
        return f"{s / 3600:.1f}h"
    return f"{s / 86400:.1f}d"


def recorded(root: Path | None = None) -> tuple[dict[str, str], str | None]:
    """{id: who records it} for every reading a known writer takes besides the registry probes:
    each ENABLED schedule.json job with `health` true, plus RECORDED_BY_ITSELF. An unreadable
    schedule.json is said (second value) and leaves only RECORDED_BY_ITSELF."""
    out = dict(RECORDED_BY_ITSELF)
    f = (root or P.fund_root()) / P._ROOT.SCHEDULE_FILE
    try:
        doc = json.loads(f.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return out, f"{P._ROOT.SCHEDULE_FILE} is missing"
    except Exception as e:  # noqa: BLE001 - said, not raised
        return out, f"{P._ROOT.SCHEDULE_FILE} is unreadable: {type(e).__name__}: {e}"[:200]
    for j in doc.get("jobs", []) if isinstance(doc, dict) else []:
        if isinstance(j, dict) and j.get("health") is True and j.get("enabled", True) is not False and j.get("id"):
            out.setdefault(str(j["id"]), "the scheduler (schedule.json, health true)")
    return out, None


def rows(root: Path | None = None, now: float | None = None, readings: dict | None = None) -> list[dict]:
    """Every expected probe, every recorded reading and every orphan, each judged by its kind (rules
    1-3 above). `readings` ({id: health object}) is the ops store's newest reading per probe
    (P.latest_readings); a test passes its own. An unreadable store makes every expected row
    unknown, said."""
    now = now or time.time()
    expected = dict(P.REGISTRY)
    expected[P.SWEEP.id] = P.SWEEP
    known, _why = recorded(root)
    out = []
    seen = set()
    error = None
    if readings is None:
        try:
            readings = P.latest_readings()
        except Exception as e:  # noqa: BLE001 - the store is down: every row says so
            readings, error = {}, f"{type(e).__name__}: {e}"[:200]

    for pid, spec in expected.items():
        seen.add(pid)
        doc = readings.get(pid)
        if doc is None:
            out.append({"id": pid, "label": spec.label, "owner": spec.owner,
                        "status": "unknown", "effective": "unknown",
                        "reading": "the ops store is unreadable" if error else "never reported", "age_s": None,
                        "window_s": spec.window_s, "expected": True,
                        "detail": error or "no reading has ever been recorded for this probe"})
            continue
        out.append(_row(doc, pid, spec.window_s, now, True, spec.label, spec.owner))

    # Readings a known writer records (rule 3) are judged on their own window when present; any
    # other stored reading is an orphan, named with its age and never judged.
    for pid in sorted(readings):
        if pid in seen:
            continue
        doc = readings[pid]
        r = _row(doc, pid, int(doc.get("window_s") or 7200), now, False, doc.get("label", pid), doc.get("owner", "?"))
        if pid not in known:
            r["effective"] = "orphan"
            r["detail"] = "no registry probe, enabled health job or known meter records this id; the row stays in the store"
        out.append(r)

    out.sort(key=lambda r: (ORDER.get(r["effective"], 4), r["id"]))
    return out


def _row(doc: dict, pid: str, window_s: int, now: float, expected: bool,
         label: str, owner: str) -> dict:
    ts = doc.get("probed_ts")
    age = (now - float(ts)) if isinstance(ts, (int, float)) else None
    status = str(doc.get("status") or "unknown")
    w = int(doc.get("window_s") or window_s)
    eff = status if status in ORDER and status != "stale" else "unknown"
    if age is None:
        eff = "unknown"
    elif age > w:
        eff = "stale"          # an old reading is not a reading, whatever it said
    return {"id": pid, "label": doc.get("label", label), "owner": doc.get("owner", owner),
            "status": status, "effective": eff, "reading": doc.get("reading", ""),
            "age_s": None if age is None else round(age, 1), "window_s": w,
            "expected": expected, "detail": doc.get("detail", "")}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--quiet", action="store_true", help="only the rows that are not ok")
    ap.add_argument("--dry", action="store_true",
                    help="name the expected set (the registry + the sweep); read nothing, exit 0")
    ap.add_argument("--expected", action="store_true",
                    help="print the expected set as JSON (the registry + the sweep, and the recorded "
                         "readings); read no reading, exit 0. The cockpit's SYSTEM room folds every "
                         "other reading into one orphan line from this, so there is one definition")
    a = ap.parse_args(argv)
    if a.expected:
        print(json.dumps(expected_set()))
        return 0
    if a.dry:
        return dry()
    rs = rows()
    if a.json:
        print(json.dumps(rs, indent=2, ensure_ascii=False))
    else:
        mark = {"ok": "ok   ", "fail": "FAIL ", "stale": "STALE", "unknown": "??   ", "orphan": "orph "}
        for r in rs:
            if a.quiet and r["effective"] in ("ok", "orphan"):
                continue
            age = age_str(r["age_s"]) if r["age_s"] is not None else "never"
            print(f"{mark[r['effective']]} {r['id']:14} {age:>7} ago  "
                  f"{str(r['owner']):26} {r['reading'][:70]}")
        orphans = [r for r in rs if r["effective"] == "orphan"]
        judged = [r for r in rs if r["effective"] != "orphan"]
        bad = [r for r in judged if r["effective"] != "ok"]
        v = [verdict(r) for r in rs]
        if orphans:
            print("\norphans (nothing writes them; not judged, never deleted): "
                  + ", ".join(f"{r['id']} ({age_str(r['age_s']) if r['age_s'] is not None else 'no date'} old)" for r in orphans))
        print(f"\n{len(judged) - len(bad)}/{len(judged)} fresh and ok"
              + (f" · {len(bad)} need attention" if bad else "")
              + (f" · verdict: {v.count('silent')} silent, {v.count('red')} red, "
                 f"{v.count('amber')} amber" if bad else ""))
        for r in bad:
            if r["effective"] == "stale":
                print(f"  {r['id']}: last reported {age_str(r['age_s'])} ago, "
                      f"window is {age_str(r['window_s'])} - something stopped writing")
            elif r["reading"] == "never reported":
                print(f"  {r['id']}: NEVER reported - this probe has not run on this machine")
    return exit_code(rs)


def expected_set(root: Path | None = None) -> dict:
    """The ONE expected set, as data: `registry` (rule 1: never reported is unknown), `recorded`
    (rule 3: judged when present) and `why` (schedule.json unreadable, else null). Any stored
    reading in neither is an orphan."""
    known, why = recorded(root)
    return {"registry": [*P.REGISTRY, P.SWEEP.id], "recorded": sorted(known), "why": why}


def dry() -> int:
    """The EXPECTED SET this renderer would judge, from the registry alone: no store read, no
    write. Readings recorded by anything else (scheduler jobs with `health` true) are judged too
    on a real run, but only a real run can know them."""
    expected = dict(P.REGISTRY)
    expected[P.SWEEP.id] = P.SWEEP
    print(f"staleness: DRY - would judge {len(expected)} expected probe(s) against the ops store "
          f"(ops.health_readings, probe_id system:<id>):")
    for pid, spec in expected.items():
        print(f"  {pid:14} window {age_str(spec.window_s):>6}  {spec.owner:22} {spec.label}")
    known, why = recorded()
    print(f"plus, when recorded, {len(known)} reading(s) a known writer takes" + (f" ({why})" if why else "") + ":")
    for pid, who in known.items():
        print(f"  {pid:14} {who}")
    print("every other stored reading is an orphan: named, never judged")
    return 0


def exit_code(rs: list[dict]) -> int:
    v = {verdict(r) for r in rs}
    return 1 if v & {"silent", "red"} else (2 if "amber" in v else 0)


if __name__ == "__main__":
    sys.exit(main())
