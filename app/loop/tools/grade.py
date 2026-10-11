#!/usr/bin/env python3
"""GRADE THE JUDGE - predictions vs what actually landed.

Pre-registration is worthless unless somebody scores it, and "somebody" in a
system this size means a script. This one walks every run with both a
pre-flight and at least one measured number, scores each metric against its
band, and prints the per-desk calibration table the retro pastes into
`beliefs.md`.

THE CHECK NOBODY WRITES, AND THE REASON THIS FILE EXISTS: **a band that always
hits is not a good judge, it is a wide one.** A desk predicting
`ann_pct = -100 to 100` scores 100% in-band forever and has learned nothing.
So a desk whose last `--window` graded runs ALL hit is flagged
`predicting too wide`, with its median band width as a share of the band's own
midpoint, so the number behind the flag is visible rather than asserted.

The mirror flag is `predicting too narrow` - a desk that misses nearly
everything is not calibrating either, and a standing miss in ONE DIRECTION
(always over, always under) is the judge's curriculum: it names a bias, which
is worth more than either flag.

    python app/loop/tools/grade.py                    # every desk
    python app/loop/tools/grade.py --desk carry       # one
    python app/loop/tools/grade.py --json

Exit: 0 always (grading is a report, not a gate).
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402

WIDE_MIN_RUNS = 4      # below this, an all-hit record is a small sample, not a wide band
WIDE_REL = 0.5         # a band wider than 50% of |midpoint| is a wide band


def score_run(pre: dict, result: dict | None, reads: list[dict]) -> dict:
    """One run's grade. The AT-RUN read is the result's own metrics; the fixed-age
    reads are graded against the SAME bands, because the prediction was about the
    mechanic, not about one window."""
    predicted = pre.get("predicted") or {}
    out = {"run": pre.get("run"), "desk": pre.get("desk"), "kind": pre.get("kind"),
           "mechanic": pre.get("mechanic"), "ancestor": pre.get("ancestor"),
           "variables": pre.get("variables", []), "beliefs": pre.get("beliefs", []),
           "predicted": predicted, "by_age": {}}
    sources = {}
    if result and result.get("metrics"):
        sources["at run"] = result["metrics"]
    for r in reads:
        if r.get("metrics"):
            sources[r.get("age", "?")] = r["metrics"]
        else:
            sources.setdefault(r.get("age", "?"), {})
    for age, metrics in sources.items():
        graded = {}
        for k, raw in predicted.items():
            if k not in metrics:
                graded[k] = {"band": raw, "actual": None, "verdict": "unmeasured"}
                continue
            band = C.parse_band(raw)
            v = float(metrics[k])
            verdict = ("hit" if band.contains(v)
                       else ("over" if band.hi is not None and v > band.hi else "under"))
            mid = None
            rel = None
            if band.lo is not None and band.hi is not None:
                mid = (band.lo + band.hi) / 2.0
                rel = (band.width / abs(mid)) if mid else None
            graded[k] = {"band": raw, "actual": v, "verdict": verdict,
                         "width": band.width, "rel_width": rel}
        out["by_age"][age] = graded
    out["verify"] = (result or {}).get("verify")
    out["gates"] = (result or {}).get("gates")
    return out


def desk_report(desk: C.Desk, window: int) -> dict:
    rows = C.runs(desk)
    by = {}
    for r in rows:
        by.setdefault(r.get("run"), {}).setdefault(r.get("stage", "?"), []).append(r)
    # IMPORTED HISTORY IS NEVER GRADED. A `preregistered: false` row was
    # transcribed from the code repo's record (backfill.py); it has no
    # prediction, so scoring it would be scoring a memory. It is COUNTED here
    # and reported, because "not graded" and "not there" must not look alike.
    imported = [r for r in rows if r.get("stage") == "result" and C.is_import(r)]
    scored = []
    for run_id, stages in by.items():
        results = stages.get("result") or []
        if any(C.is_import(r) for r in results):
            continue
        pre = (stages.get("preflight") or [None])[-1]
        if not pre:
            continue
        result = (stages.get("result") or [None])[-1]
        reads = stages.get("read") or []
        if not result and not reads:
            continue
        scored.append(score_run(pre, result, reads))

    # the at-run grade is the calibration record; reads are shown but do not
    # re-grade a judge that was already scored for that run
    cal = []
    for s in scored:
        g = s["by_age"].get("at run") or {}
        verdicts = [v["verdict"] for v in g.values() if v["verdict"] != "unmeasured"]
        if not verdicts:
            continue
        cal.append({"run": s["run"], "mechanic": s["mechanic"], "kind": s["kind"],
                    "hits": verdicts.count("hit"), "n": len(verdicts),
                    "over": verdicts.count("over"), "under": verdicts.count("under"),
                    "metrics": g})

    recent = cal[-window:]
    n_metrics = sum(c["n"] for c in recent)
    n_hits = sum(c["hits"] for c in recent)
    rels = [m["rel_width"] for c in recent for m in c["metrics"].values()
            if m.get("rel_width") is not None]
    median_rel = statistics.median(rels) if rels else None

    flags = []
    if len(recent) >= WIDE_MIN_RUNS and n_metrics and n_hits == n_metrics:
        flags.append({
            "flag": "predicting too wide",
            "why": (f"{n_hits}/{n_metrics} predicted metrics in band across the last "
                    f"{len(recent)} graded runs - a band that never misses is not a "
                    f"prediction"),
            "median_band_width_rel": median_rel})
    elif median_rel is not None and median_rel > WIDE_REL and n_metrics and \
            n_hits / n_metrics >= 0.9:
        flags.append({
            "flag": "bands are wide",
            "why": (f"median band spans {median_rel * 100:.0f}% of its own midpoint at a "
                    f"{n_hits}/{n_metrics} hit rate"),
            "median_band_width_rel": median_rel})
    if len(recent) >= WIDE_MIN_RUNS and n_metrics and n_hits / n_metrics < 0.25:
        flags.append({"flag": "predicting too narrow",
                      "why": f"only {n_hits}/{n_metrics} in band over {len(recent)} runs"})
    # a standing one-directional miss is worth more than either flag
    dir_counts = {"over": sum(c["over"] for c in recent), "under": sum(c["under"] for c in recent)}
    for d, n in dir_counts.items():
        if n >= 3 and n >= 2 * dir_counts[("under" if d == "over" else "over")]:
            flags.append({"flag": f"standing miss: always {d}",
                          "why": f"{n} {d}-misses vs "
                                 f"{dir_counts['under' if d == 'over' else 'over']} the other way "
                                 f"- the judge has a bias, not noise"})

    return {"desk": desk.rel, "state": C.desk_state(desk), "runs_graded": len(cal),
            "window": len(recent), "in_band": n_hits, "metrics_graded": n_metrics,
            "median_band_width_rel": median_rel, "flags": flags,
            "imported": len(imported),
            "calibration": cal, "scored": scored}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--desk", default="", help="one desk; default every desk")
    ap.add_argument("--window", type=int, default=8, help="how many recent runs the flags use")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    try:
        desks = [C.resolve_desk(a.desk)] if a.desk else C.all_desks()
    except C.Refuse as e:
        return C.die(str(e))

    reports = [desk_report(d, a.window) for d in desks]
    reports = [r for r in reports if r["runs_graded"] or r["imported"] or a.desk]

    if a.json:
        print(json.dumps(reports, indent=2, ensure_ascii=False))
        return 0

    if not reports:
        print("no graded runs anywhere yet - every desk's ledger is honestly empty.")
        print("A desk earns a calibration row the first time a pre-registered run is recorded.")
        return 0

    for r in reports:
        imp = f" · {r['imported']} imported row(s), never graded" if r["imported"] else ""
        print(f"\n{r['desk']}  [{r['state']}]  {r['runs_graded']} graded run(s){imp}")
        if not r["calibration"]:
            print("  (no run has both a pre-flight and a measured number yet)")
            if r["imported"]:
                print("  imported history carries no prediction by construction - it is "
                      "evidence, and grading it would be grading a memory")
            continue
        print(f"  {'Run':16} {'Mech':6} {'Kind':8} {'In band':>8}  metrics")
        for c in r["calibration"][-r["window"]:]:
            detail = " · ".join(
                f"{k}: {m['band']} -> "
                + (f"{m['actual']:g} {m['verdict']}" if m["actual"] is not None else "unmeasured")
                for k, m in c["metrics"].items())
            print(f"  {c['run']:16} {str(c['mechanic']):6} {str(c['kind']):8} "
                  f"{c['hits']}/{c['n']:>6}  {detail[:100]}")
        rel = r["median_band_width_rel"]
        print(f"  in band {r['in_band']}/{r['metrics_graded']} over the last {r['window']} run(s)"
              + (f" · median band width {rel * 100:.0f}% of its midpoint" if rel else ""))
        for f in r["flags"]:
            print(f"  FLAG  {f['flag']}: {f['why']}")
    print("\nThe at-run grade is the calibration record; fixed-age reads are shown by "
          "`remeasure.py` and do not re-grade a judge already scored.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
