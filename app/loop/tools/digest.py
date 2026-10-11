#!/usr/bin/env python3
"""THE RETRO DIGEST SKELETON - <=12 lines, assembled from the graded numbers.

The retro method's step 7 is a <=12-line digest to the owner. This builds the
skeleton MECHANICALLY - reads completed and owed, the in-band rate, standing
miss-patterns, the exploit/explore/wild mix, the WILD ratio, the probe wall -
so the retro skill spends its judgment on the two lines a script cannot write:
the belief moves and the next bet.

Every line this emits is a NUMBER PULLED FROM A FILE. Lines the retro must fill
are emitted as explicit `<FILL: ...>` slots, never as plausible prose - a
digest that writes its own conclusions is a digest nobody checks.

    python app/loop/tools/digest.py --desk carry
    python app/loop/tools/digest.py --desk carry --json
    python app/loop/tools/digest.py --desk carry --since 7d
    python app/loop/tools/digest.py --desk carry --write   # also saves lab/<desk>/retros/<date>.md

THE FILE (--write). A retro's digest used to live only in its commit message, where
the Loop room could not open it. `--write` saves it as lab/<desk>/retros/<YYYY-MM-DD>.md
(UTC date): frontmatter `desk`, `date`, `through` (the last run this desk chose, or
`none`), `source`, then `# Retro - <desk> - <date>` and the digest, one `- ` line each.
The retro then replaces every `<FILL: ...>` in that file with its judgment and commits
it in the same commit as the beliefs stamp. An existing file is NEVER overwritten
(a filled retro is judgment a skeleton would erase): exit 1, nothing written.

Exit: 0, or 1 when --write refuses.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402
import grade as G  # noqa: E402
import retro_due as R  # noqa: E402

MAX_LINES = 12


def parse_since(s: str) -> float:
    s = (s or "").strip().lower()
    if s.endswith("d"):
        return float(s[:-1])
    if s.endswith("w"):
        return float(s[:-1]) * 7
    return float(s or 0)


def build(desk: C.Desk, since_days: float, window: int) -> dict:
    rep = G.desk_report(desk, window)
    due = R.status(desk, 7, 5)
    rows = C.runs(desk)
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=since_days or 3650)

    def recent(stage):
        out = []
        for r in rows:
            if r.get("stage") != stage:
                continue
            try:
                t = dt.datetime.strptime(r["ts"], "%Y-%m-%dT%H:%M:%SZ").replace(
                    tzinfo=dt.timezone.utc)
            except (KeyError, ValueError):
                continue
            if t >= cutoff:
                out.append(r)
        return out

    results = recent("result")
    imported = [r for r in results if C.is_import(r)]
    results = [r for r in results if not C.is_import(r)]
    reads = recent("read")
    kinds = {"exploit": 0, "explore": 0, "wild": 0}
    for r in results:
        k = str(r.get("kind", "")).lower()
        if k in kinds:
            kinds[k] += 1
    # The EXPLOIT/EXPLORE/WILD mix is a property of runs this desk CHOSE, so
    # imported history is excluded from it: it would dilute the WILD ratio with
    # runs nobody here decided to take.
    last8 = [r for r in rows
             if r.get("stage") == "result" and not C.is_import(r)][-8:]
    wild8 = sum(1 for r in last8 if str(r.get("kind", "")).lower() == "wild"
                or str(r.get("experiment", "")).upper().startswith("WILD"))

    # reads owed: a result older than 7d / 30d with no read at that age
    now = dt.datetime.now(dt.timezone.utc)
    owed = []
    for r in [x for x in rows if x.get("stage") == "result"]:
        try:
            t = dt.datetime.strptime(r["ts"], "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=dt.timezone.utc)
        except (KeyError, ValueError):
            continue
        have = {x.get("age") for x in rows
                if x.get("stage") == "read" and x.get("run") == r.get("run")}
        for age, days in (("7d", 7), ("30d", 30)):
            if age in have:
                continue
            od = (now - t).total_seconds() / 86400 - days
            if od > 0:
                owed.append(f"{r.get('run')} {age} ({od:.0f}d over)")

    chosen = [r for r in rows if r.get("stage") == "result" and not C.is_import(r)]
    last_run = str(chosen[-1].get("run")) if chosen and chosen[-1].get("run") else None

    misses = [f["flag"] for f in rep["flags"]]
    mechs = C.mechanics(desk)
    bel = C.beliefs(desk)

    return {
        "desk": desk.rel, "state": C.desk_state(desk), "since_days": since_days,
        "results": len(results), "imported": len(imported), "last_run": last_run,
        "reads_done": len(reads), "reads_owed": owed,
        "kinds": kinds, "wild_last8": wild8,
        "in_band": rep["in_band"], "metrics_graded": rep["metrics_graded"],
        "median_band_width_rel": rep["median_band_width_rel"],
        "flags": rep["flags"], "miss_flags": misses,
        "retro": due, "mechanics": mechs, "beliefs": sorted(bel),
        "calibration": rep["calibration"][-window:],
    }


def lines(d: dict) -> list[str]:
    out = []
    out.append(f"RETRO DIGEST · {d['desk']} [{d['state']}] · last {d['since_days']:.0f}d · "
               f"stamp {d['retro']['stamp_date'] or 'never'}"
               + (" (DUE)" if d["retro"]["due"] else ""))
    out.append(f"runs: {d['results']} recorded · mix exploit {d['kinds']['exploit']} / "
               f"explore {d['kinds']['explore']} / wild {d['kinds']['wild']} · "
               f"WILD {d['wild_last8']}/8 over the last 8 (the floor is 2/8)")
    if d["metrics_graded"]:
        rel = d["median_band_width_rel"]
        out.append(f"judge: {d['in_band']}/{d['metrics_graded']} predicted metrics in band"
                   + (f" · median band = {rel * 100:.0f}% of its midpoint" if rel else ""))
    else:
        out.append("judge: nothing gradeable yet - no run has both a pre-flight and a number")
    out.append("reads: " + (f"{d['reads_done']} taken · OWED: " + ", ".join(d["reads_owed"][:4])
                            + (f" (+{len(d['reads_owed']) - 4})" if len(d["reads_owed"]) > 4 else "")
                            if d["reads_owed"]
                            else f"{d['reads_done']} taken · none owed"))
    for f in d["flags"][:2]:
        out.append(f"FLAG: {f['flag']} - {f['why']}")
    out.append(f"<FILL: belief moves - B<n> WEAK->MEDIUM etc, each citing the run rows and "
               f"keeping its would-change-it. Beliefs on file: "
               f"{', '.join(d['beliefs']) or 'none yet'}>")
    out.append(f"<FILL: mechanic table moves - shots, statuses, promotions. Rows: "
               f"{', '.join(d['mechanics']) or 'none yet'}>")
    out.append("<FILL: menu marks and weights the numbers moved, with the one-line why>")
    out.append("<FILL: THE NEXT BET - one line, EXPLOIT or EXPLORE, naming the single test "
               "that would move the most load-bearing uncertain belief>")
    out.append("<FILL: any proposed BINDING change (a CLAUDE.md constraint) - proposed here, "
               "never written by the retro>")
    out.append(f"stamp to write into beliefs.md: `Last retro: {C.today()} · through run "
               f"<NN> · next bet: <the line above>`")
    return out[:MAX_LINES]


def retro_path(desk: C.Desk, date: str) -> Path:
    """Where a retro's digest lives: lab/<desk>/retros/<YYYY-MM-DD>.md."""
    return desk.path / "retros" / f"{date}.md"


def render(d: dict, date: str, body: list[str] | None = None, source: str = "") -> str:
    """The retro file: frontmatter, a title, the digest lines as a list."""
    through = d.get("last_run") or "none"
    out = ["---", f"desk: {d['desk']}", f"date: {date}", f"through: {through}",
           f"source: {source or 'app/loop/tools/digest.py --write'}", "---", "",
           f"# Retro - {d['desk']} - {date}", ""]
    out += [f"- {ln}" for ln in (body if body is not None else lines(d))]
    return "\n".join(out) + "\n"


def write(desk: C.Desk, d: dict, date: str | None = None) -> Path:
    date = date or C.today()
    p = retro_path(desk, date)
    if p.exists():
        raise C.Refuse(f"{p.relative_to(desk.root).as_posix()} exists - a retro file is never "
                       f"overwritten; edit it, or remove it yourself if it is a stale skeleton")
    C.write_text(p, render(d, date))
    return p


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--desk", required=True)
    ap.add_argument("--since", default="7d")
    ap.add_argument("--window", type=int, default=8)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--write", action="store_true",
                    help="also save the digest to lab/<desk>/retros/<YYYY-MM-DD>.md (never overwrites)")
    a = ap.parse_args(argv)
    try:
        desk = C.resolve_desk(a.desk)
        d = build(desk, parse_since(a.since), a.window)
    except C.Refuse as e:
        return C.die(str(e))
    if a.json:
        print(json.dumps({**d, "lines": lines(d)}, indent=2, ensure_ascii=False))
    else:
        for ln in lines(d):
            print(ln)
        print(f"\n({MAX_LINES} lines max. Every number above was pulled from a file; every "
              f"<FILL> is judgment the retro owes.)")
    if a.write:
        try:
            p = write(desk, d)
        except C.Refuse as e:
            return C.die(str(e))
        print(f"wrote {p.relative_to(desk.root).as_posix()} - fill every <FILL> in it "
              f"before the commit", file=sys.stderr if a.json else sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
