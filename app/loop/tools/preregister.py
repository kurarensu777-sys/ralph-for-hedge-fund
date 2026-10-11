#!/usr/bin/env python3
"""PRE-REGISTRATION - the contract, with the mechanism that makes it binding.

"A prediction written after the numbers came back teaches nothing, and nothing
downstream can tell the difference." That is the whole problem: an
after-the-fact pre-flight is INDISTINGUISHABLE from an honest one once it is
prose in a file. So this tool, and not a rule in a skill, is what writes a
pre-flight - and it refuses every shape that would make the ledger a lie:

  * a result already exists for this run          -> REFUSED (after the fact)
  * a pre-flight already exists for this run      -> REFUSED (write-once)
  * the mechanic is not a row in mechanics.md     -> REFUSED (no named mechanic, no run)
  * more than 2 named variables vs the ancestor   -> REFUSED (attributes to nothing)
  * the ancestor run is not in this desk's record -> REFUSED (unless the desk has none)
  * a prediction that is not a BAND               -> REFUSED (a point cannot be calibrated)
  * a belief under test that does not exist       -> REFUSED (a dangling B<n>)
  * no window, or no command                      -> REFUSED (not admissible as evidence)
  * the two ledger files have changes not in HEAD -> REFUSED (land them first)

and it COMMITS the pre-flight on its own - exactly `results-log.md` and
`data/runs.jsonl`, message `preregister <desk> <run>`, trailer `Agent:
<FUND_AGENT or you>` - before anything runs, so GIT ORDER, not a ts field,
proves the prediction came first. A failed commit restores both files and
registers nothing. `record.py` refuses a result whose pre-flight commit is
missing, shared with other files, or later than the run (`--ran`).

It also RECORDS, so the retro can grade without trusting anybody's memory: the
platform repo's commit SHA at registration time (and the research repo's, when
the command runs a notebook there) and the data window the run will cover.

OPTIONALLY, THE DATA AS IT STANDS: `--input venue:symbol:dataset:interval`
(repeatable, never required) fingerprints the window's stored rows at
registration and PINS them (reason `preflight`, ref `<desk>:<run>:preflight`, so it never shares a (hash, ref) with the result) through
pins.py, into the pre-flight row as `fingerprint`. A bad spec or a pin that does
not match its digest refuses the registration; no pin API yet (B-0324) records
`pin: null` + `pin_error`. `--no-pin` fingerprints without pinning
(`fingerprint.pin_skipped: true`); `--dry` never pins.

    python app/loop/tools/preregister.py --desk carry --run carry-015 \
      --mechanic M3 --kind exploit --variant "leverage 3x" \
      --experiment NONE --ancestor carry-014 \
      --variables "leverage 2x -> 3x" --variables "window rolled to 2026-09-28" \
      --predict ann_pct=18..30 --predict max_dd_pct=-8..-2 --predict liquidations=0 \
      --judge "robustness 1-5" --judge "attribution 1-5" \
      --belief B1 --belief B4 \
      --cmd "python -m mypkg.backtest --study simple --aum 1000000" \
      --window 2026-02-20T02:00:00Z..2026-09-28T09:00:00Z --hours 5288 --regimes 1 \
      --comparator "T-bill hurdle=4.11 pct_ann [V]"

Exit: 0 written and committed · 1 refused (a contract violation) · 2 usage.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402
import fingerprint as FP  # noqa: E402

WINDOW_RE = re.compile(r"^\s*(\S+)\s*(?:\.\.|->|to)\s*(\S+)\s*$")


def build(args) -> tuple[C.Desk, dict, str]:
    desk = C.resolve_desk(args.desk)
    missing = [f for f in C.REQUIRED_FILES if not desk.f(f).is_file()]
    if missing:
        raise C.Refuse(f"{desk.rel} is missing {', '.join(missing)} - it is not a desk yet")

    run_id = args.run.strip()
    if not run_id or " " in run_id:
        raise C.Refuse("--run must be a single token, e.g. carry-015")

    # 1. after-the-fact registration
    if C.has_result(desk, run_id):
        raise C.Refuse(
            f"a RESULT already exists for {run_id}. A pre-flight written after the numbers "
            f"came back teaches nothing and cannot be told apart from an honest one. "
            f"Register the NEXT run instead.")
    if C.run_rows(desk, run_id, "preflight"):
        raise C.Refuse(f"{run_id} is already pre-registered (write-once). "
                       f"Use a new run id, or `record.py` to close this one.")

    # 2. the mechanic must be a row in mechanics.md
    mechs = C.mechanics(desk)
    if not args.mechanic:
        raise C.Refuse("--mechanic is required: a run with no named mechanic does not ship")
    if args.mechanic not in mechs:
        raise C.Refuse(f"mechanic {args.mechanic!r} is not a row in {desk.rel}/mechanics.md "
                       f"(rows: {', '.join(mechs) or 'none yet'}). Add the row first - that is "
                       f"where sample size accumulates across runs.")

    # 3. kind + experiment
    kind = args.kind.lower()
    if kind not in ("exploit", "explore", "wild"):
        raise C.Refuse("--kind must be exploit | explore | wild")
    experiment = (args.experiment or "").strip() or "NONE"
    if kind in ("explore", "wild") and experiment.upper() == "NONE":
        raise C.Refuse(f"a {kind} run must name its ONE experiment "
                       f"(--experiment 'WILD - <what>' for a wild slot)")

    # 4. variables + ancestor
    variables = [v.strip() for v in (args.variables or []) if v.strip()]
    if len(variables) > 2:
        raise C.Refuse(f"{len(variables)} named variables vs the ancestor. At most 2 - "
                       f"more and the result attributes to nothing: {variables}")
    known = C.run_ids(desk)
    ancestor = (args.ancestor or "").strip()
    if not ancestor or ancestor.upper() == "NONE":
        if known:
            raise C.Refuse(f"--ancestor is required once this desk has runs "
                           f"({', '.join(known[-4:])}). The <=2 variables are counted "
                           f"against a NAMED ancestor.")
        ancestor = "NONE"
    elif ancestor not in known:
        raise C.Refuse(f"ancestor {ancestor!r} is not in {desk.rel}/data/runs.jsonl "
                       f"(known: {', '.join(known[-6:]) or 'none'})")
    elif not variables:
        raise C.Refuse("name at least one variable vs the ancestor - the identical command on "
                       "the identical window is not a run, and a re-run on a ROLLED window "
                       "varies the window (say so).")

    # 5. banded predictions
    predicted = C.parse_predictions(args.predict or [])
    if not predicted:
        raise C.Refuse("at least one --predict metric=band is required. Calibrating the judge "
                       "is the point of pre-registration.")

    # 6. the beliefs under test must exist
    bel = C.beliefs(desk)
    tested = [b.strip().upper() for b in (args.belief or []) if b.strip()]
    for b in tested:
        if b not in bel:
            raise C.Refuse(f"belief {b} is not in {desk.rel}/beliefs.md "
                           f"(has: {', '.join(sorted(bel)) or 'none yet'})")
        if bel[b]["placeholder"]:
            raise C.Refuse(f"belief {b} is still the template placeholder - fill it before "
                           f"putting a run against it")

    # 7. the window and the command
    if not args.cmd:
        raise C.Refuse("--cmd is required: the fixed-age reads RE-RUN it on the rolled window")
    m = WINDOW_RE.match(args.window or "")
    if not m:
        raise C.Refuse("--window FROM..TO (UTC ISO) is required. A row with no window is not "
                       "admissible as evidence.")
    window = {"from": m.group(1), "to": m.group(2)}
    if args.hours:
        window["hours"] = int(args.hours)
    if args.regimes:
        window["regimes"] = int(args.regimes)
    for sp in getattr(args, "input", None) or []:   # a bad spec refuses here; main() digests
        FP.parse_spec(sp)

    comparator = None
    if args.comparator:
        cm = re.match(r"^\s*(.+?)\s*=\s*([-+]?\d+(?:\.\d+)?)\s*(\S+)?\s*(\[[V1UA]\w*\])?\s*$",
                      args.comparator)
        if not cm:
            raise C.Refuse("--comparator must be 'name=value unit [tag]', "
                           "e.g. 'T-bill hurdle=4.11 pct_ann [V]'")
        comparator = {"name": cm.group(1), "value": float(cm.group(2)),
                      "unit": cm.group(3) or "", "provenance": cm.group(4) or "[U]"}

    commits = C.code_commits(args.cwd, desk.root)
    sha = commits["platform_commit"]
    if not sha and not args.allow_no_sha:
        raise C.Refuse(f"could not read the platform commit SHA ({C.PLATFORM}). A result with no "
                       "code version is not reproducible; pass --allow-no-sha only if the code "
                       "repo is absent.")

    row = {
        "run": run_id,
        "stage": "preflight",
        "desk": desk.rel,
        "ts": C.now_iso(),
        "kind": kind,
        "mechanic": args.mechanic,
        "variant": (args.variant or "").strip(),
        "experiment": experiment,
        "variables": variables,
        "ancestor": ancestor,
        "beliefs": tested,
        "cmd": args.cmd.strip(),
        "cwd": args.cwd,
        "window": window,
        "predicted": predicted,
        "judge": [j.strip() for j in (args.judge or []) if j.strip()],
        **commits,
        "provenance": args.provenance,
    }
    if comparator:
        row["comparator"] = comparator
    if args.metric_pattern:
        row["metric_patterns"] = dict(
            p.split("=", 1) for p in args.metric_pattern if "=" in p)
    if args.note:
        row["note"] = args.note

    pf = preflight_line(row)
    block = entry_block(row, pf, args.title or args.mechanic)
    return desk, row, block


def preflight_line(row: dict) -> str:
    variant = f" - variant: {row['variant']}" if row["variant"] else ""
    anc = row["ancestor"]
    var = ", ".join(row["variables"]) or "none (first run at this desk)"
    pred = " · ".join(f"{k} {v}" for k, v in row["predicted"].items())
    judge = ", ".join(row["judge"]) or "not set"
    bel = (" · beliefs under test: " + ", ".join(row["beliefs"])) if row["beliefs"] else ""
    return (f"**Pre-flight:** mechanic {row['mechanic']} ({row['kind']}{variant}) · "
            f"experiment: {row['experiment']} · variables vs {anc}: {var} · "
            f"predict: {pred} · judge: {judge}{bel}")


def entry_block(row: dict, pf: str, title: str) -> str:
    w = row["window"]
    win = (f"{w['from']} -> {w['to']} UTC"
           + (f" · {w['hours']} hours" if w.get("hours") else "")
           + (f" · {w['regimes']} regime(s)" if w.get("regimes") else ""))
    comp = row.get("comparator")
    comp_s = (f"{comp['name']} = {comp['value']} {comp['unit']} {comp['provenance']}"
              if comp else "not set")
    return "\n".join([
        f"### {row['run']} - {title} - registered {C.today()} · `{row['cmd']}`",
        "",
        f"- {pf}",
        f"- **Window:** {win}",
        f"- **Code:** platform `{C.commit_of(row)[:12] or 'unknown'}`"
        + (f" · research `{row['research_commit'][:12] or 'unknown'}`"
           if "research_commit" in row else ""),
        f"- **Comparator:** {comp_s}",
        "- **Verify:** pending",
        "- **Result:** pending - the engine has not run yet",
        "- **Read:** pending - +7d and +30d scheduled from the result",
    ])


def ledger_clean(desk: C.Desk) -> None:
    """Both ledger files tracked and identical to HEAD, or Refuse. The pre-flight
    commit takes these two files whole, so anything already pending in them - an
    unlanded result, a hand edit - would ride into the "preregister" commit and
    blur exactly the order the commit exists to prove."""
    C.git_repo_root(desk.repo)
    paths = C.ledger_paths(desk)
    st = C.git(desk.repo, "status", "--porcelain", "--untracked-files=all", "--", *paths)
    if st.returncode != 0:
        raise C.Refuse(f"git status failed: {st.stderr.strip()}")
    dirty = [ln[3:].strip() for ln in st.stdout.splitlines() if ln.strip()]
    if dirty:
        raise C.Refuse(
            f"{', '.join(dirty)} {'has' if len(dirty) == 1 else 'have'} changes not in HEAD. "
            f"Land them first (git commit --only <paths>): the pre-flight "
            f"is committed on its own, and it may carry nothing else.")
    for p in paths:
        if C.git(desk.repo, "ls-files", "--error-unmatch", "--", p).returncode != 0:
            raise C.Refuse(f"{p} is not tracked by git. Land the desk first.")


def write_and_commit(desk: C.Desk, row: dict, block: str) -> str:
    """Append the pre-flight to both files and commit exactly those two paths, on
    their own, BEFORE anything runs. A failed commit restores both files byte for
    byte: a pre-flight exists only as a commit, never as an uncommitted edit.
    Returns the commit SHA."""
    ledger_clean(desk)
    files = [desk.repo / p for p in C.ledger_paths(desk)]
    before = {f: f.read_bytes() for f in files}
    C.append_entry(desk, block)
    C.append_jsonl(desk.runs, row)
    msg = f"preregister {desk.rel} {row['run']}"
    p = C.git(desk.repo, "commit", "-q", "-m", msg, "-m", f"Agent: {C.agent_id()}",
              "--", *C.ledger_paths(desk))
    if p.returncode != 0:
        for f, b in before.items():
            with open(f, "wb") as fh:
                fh.write(b)
        why = (p.stderr or p.stdout).strip().splitlines()
        raise C.Refuse(f"the pre-flight commit failed, nothing was registered (both files "
                       f"restored): {' | '.join(why[-4:]) or 'git commit exit ' + str(p.returncode)}")
    return C.git(desk.repo, "rev-parse", "HEAD").stdout.strip()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--desk", required=True,
                    help="lab path (lab/platform/carry), fragment (platform/carry) or leaf (carry)")
    ap.add_argument("--run", required=True)
    ap.add_argument("--mechanic", required=True, help="a row id in mechanics.md, e.g. M3")
    ap.add_argument("--kind", default="exploit", help="exploit | explore | wild")
    ap.add_argument("--variant", default="")
    ap.add_argument("--experiment", default="NONE", help="the ONE test, or NONE")
    ap.add_argument("--ancestor", default="", help="the nearest ancestor run id, or NONE")
    ap.add_argument("--variables", action="append", default=[],
                    help="one named change vs the ancestor (max 2, repeatable)")
    ap.add_argument("--predict", action="append", default=[],
                    help="metric=band, e.g. ann_pct=20..30 (repeatable)")
    ap.add_argument("--judge", action="append", default=[], help="a judge axis (repeatable)")
    ap.add_argument("--belief", action="append", default=[],
                    help="a B<n> this run tests (repeatable)")
    ap.add_argument("--cmd", default="", help="the exact command the reads will re-run")
    ap.add_argument("--cwd", default=C.PLATFORM,
                    help=f"where --cmd runs, fund-relative (default {C.PLATFORM}; "
                         f"{C.RESEARCH} for a notebook)")
    ap.add_argument("--window", default="", help="FROM..TO in UTC ISO")
    ap.add_argument("--hours", type=int, default=0)
    ap.add_argument("--regimes", type=int, default=0)
    ap.add_argument("--comparator", default="", help="'name=value unit [tag]'")
    ap.add_argument("--metric-pattern", action="append", default=[],
                    help="metric=<regex with one capture group>, used by remeasure.py "
                         "to read the metric back off the re-run's stdout (repeatable)")
    ap.add_argument("--provenance", default="[API]")
    ap.add_argument("--title", default="", help="a short name for the entry heading")
    ap.add_argument("--note", default="")
    ap.add_argument("--input", action="append", default=[],
                    help="venue:symbol:dataset:interval the run will read (repeatable, "
                         "optional): fingerprints and pins the window as it stands now into "
                         "the pre-flight row")
    ap.add_argument("--no-pin", action="store_true",
                    help="fingerprint --input without pinning it")
    ap.add_argument("--allow-no-sha", action="store_true")
    ap.add_argument("--dry", action="store_true", help="validate and print; write nothing")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    try:
        desk, row, block = build(a)
        ledger_clean(desk)
        if a.input:     # after every other refusal: a pin is written only for a run that registers
            pin = (None if a.no_pin or a.dry
                   else {"reason": "preflight", "ref": f"{desk.rel}:{row['run']}:preflight"})
            row["fingerprint"] = FP.for_window(a.input, row["window"], pin=pin)
            if a.no_pin:
                row["fingerprint"]["pin_skipped"] = True
    except C.Refuse as e:
        return C.die(str(e))

    if a.dry:
        print("DRY - valid. Would append to "
              f"{desk.rel}/results-log.md and {desk.rel}/data/runs.jsonl and commit both, "
              f"alone, as 'preregister {desk.rel} {row['run']}':\n")
        print(block)
        print("\n" + json.dumps(row, indent=2, ensure_ascii=False))
        return 0

    try:
        sha = write_and_commit(desk, row, block)
    except C.Refuse as e:
        return C.die(str(e))
    if a.json:
        print(json.dumps({**row, "preflight_commit": sha}, indent=2, ensure_ascii=False))
        return 0
    print(f"pre-registered {row['run']} at {desk.rel} · committed {sha[:12]} "
          f"(Agent: {C.agent_id()})")
    print(f"  {preflight_line(row)}")
    print(f"  platform @ {C.commit_of(row)[:12] or 'unknown'}")
    if row.get("fingerprint"):
        print(f"  data as registered: window {row['fingerprint']['digest']} over "
              f"{len(row['fingerprint']['inputs'])} input(s) · "
              f"{FP.pin_summary(row['fingerprint'])}")
    print("  the engine may run NOW. `record.py` writes the result; it is write-once and "
          "refuses a run started before this commit (--ran).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
