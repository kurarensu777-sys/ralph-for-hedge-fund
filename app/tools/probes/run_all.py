#!/usr/bin/env python3
"""RUN EVERY PROBE, one subprocess each, and summarise.

PER-PROBE ISOLATION IS THE POINT. Each probe runs in its own process with its
own hard timeout, so a hung network call, a crashed import or a segfaulting
child costs exactly one row. A single in-process sweep would lose every
reading after the first bad one - and would lose them SILENTLY, which is the
failure mode this whole folder exists to close.

The sweep writes its OWN health row (`probe-sweep`), so "the thing that runs
the probes stopped running" is itself a red row rather than an absence.
`staleness.py` expects that row by name.

    python app/tools/probes/run_all.py                 # everything
    python app/tools/probes/run_all.py --offline       # skip the networked probes
    python app/tools/probes/run_all.py --only git
    python app/tools/probes/run_all.py --dry           # what would run, no side effects

Exit: 0 all ok · 1 any probe reported fail · 2 any probe could not run
(`unknown`) and none failed. The worst wins, fail beats unknown.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _probe as P  # noqa: E402

HERE = Path(__file__).resolve().parent


def run_one(pid: str, extra: list[str], dry: bool) -> tuple[int, str]:
    spec = P.REGISTRY[pid]
    argv = [sys.executable, str(HERE / f"{pid}.py"), *extra]
    if dry:
        argv.append("--dry")
    # +30s over the probe's own watchdog: the probe is meant to time itself out
    # and write its red row; this outer bound only catches a process that cannot
    # even reach its own watchdog.
    try:
        p = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                           errors="replace", timeout=spec.timeout_s + 30)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        return 2, f"{pid}: the probe process did not return, even past its own watchdog"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--only", action="append", default=[], metavar="ID",
                    help="run just these (repeatable)")
    ap.add_argument("--skip", action="append", default=[], metavar="ID")
    ap.add_argument("--offline", action="store_true", help="skip every networked probe")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--quiet", action="store_true",
                    help="the summary only - each probe's detail is in its health row")
    a = ap.parse_args(argv)

    ids = [i for i in P.REGISTRY if (not a.only or i in a.only) and i not in a.skip]
    if a.offline:
        ids = [i for i in ids if not P.REGISTRY[i].network]
    unknown = [i for i in a.only if i not in P.REGISTRY]
    if unknown:
        print(f"run_all: no such probe(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"         known: {', '.join(P.REGISTRY)}", file=sys.stderr)
        return 2

    t0 = time.time()
    results = {}
    for pid in ids:
        extra = []
        if a.quiet:
            extra.append("--quiet")
        rc, out = run_one(pid, extra, a.dry)
        results[pid] = {"rc": rc, "out": out.strip()}
        if not a.json:
            print(out.rstrip())

    fails = [i for i, r in results.items() if r["rc"] == 1]
    unks = [i for i, r in results.items() if r["rc"] not in (0, 1)]
    took = time.time() - t0
    reading = (f"{len(results) - len(fails) - len(unks)}/{len(results)} ok"
               + (f" · {len(fails)} FAIL ({', '.join(fails)})" if fails else "")
               + (f" · {len(unks)} unknown ({', '.join(unks)})" if unks else ""))

    if not a.dry:
        P.write_health(P.SWEEP, "fail" if fails else ("unknown" if unks else "ok"),
                       reading, f"swept {len(results)} probe(s) in {took:.0f}s: "
                                + ", ".join(f"{i}={r['rc']}" for i, r in results.items()))
    if a.json:
        print(json.dumps({"reading": reading, "took_s": round(took, 1),
                          "results": {i: r["rc"] for i, r in results.items()},
                          "fails": fails, "unknown": unks}, indent=2))
    else:
        print(f"\nprobe sweep: {reading}  ({took:.0f}s)")
        if a.dry:
            print("(dry - nothing was written, including the sweep's own health row)")
        else:
            print("silence is checked separately: python app/tools/probes/staleness.py")
    return 1 if fails else (2 if unks else 0)


if __name__ == "__main__":
    sys.exit(main())
