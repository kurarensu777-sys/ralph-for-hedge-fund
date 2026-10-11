#!/usr/bin/env python3
"""THE FIXED-AGE READ - re-run the recorded command on the ROLLED window.

"A read is a RE-RUN of the same entrypoint at a fixed age, on the window as it
then stands - not a refresh of a cached number." At this fund the roll is the
whole point: every cached history is keyed by its END HOUR and drifts forward
one hour per hour, so the +7d read covers a genuinely different window. A
number copied forward from the original run is not a read, and nothing
downstream could tell the difference - so this tool executes, it does not
prompt.

WRITE-ONCE, AND LATE IS SAID. Each age is written exactly once. A read taken
more than `--tolerance-days` (default 4) past its due date is recorded
`missed` with whatever it found, never dressed up as an on-time read.

METRICS ARE READ BACK MECHANICALLY OR NOT AT ALL. The pre-flight may carry
`metric_patterns` (metric -> a regex with one capture group); those are applied
to the re-run's stdout. Anything without a pattern is recorded as
`parse: pending` with the stdout preserved under `data/reads/`, because a
metric guessed out of prose is worse than a gap.

THE DATA IT READ, BY DEFAULT. A result recorded with `--input` carries
`fingerprint.inputs`; the read re-digests THOSE series over the rolled window
unless `--input` names others or `--no-input` turns it off. So a scheduled or
cockpit-started read (which passes no --input) still fingerprints what it read.
An inherited series that has since vanished does not block the read - a missed
fixed-age read cannot be taken again - it lands as `fingerprint_error`.

AND IT PINS THEM. The read's fingerprint pins each input's rows (reason
`read-7d` / `read-30d`, ref `<desk>:<run>:<age>`) through pins.py, the one
adapter to fund_db's pin API, because the cache it read from is evictable. Each
input carries `pin` (= its sha256) or `pin: null` + `pin_error` (no pin API yet,
B-0324). A pin whose hash is not the fingerprint's is a refusal, and like any
fingerprint refusal it lands as `fingerprint_error` rather than losing the read.
`--no-pin` fingerprints without pinning (`fingerprint.pin_skipped: true`).

    python app/loop/tools/remeasure.py --desk carry --run carry-015 --age 7d
    python app/loop/tools/remeasure.py --desk carry --run carry-015 --age 7d --emit-jobs
    python app/loop/tools/remeasure.py --desk carry --run carry-015 --age 7d --dry

`--emit-jobs` prints the one-shot `at <iso>` entries for schedule.json as
a JSON snippet on stdout. It does NOT edit schedule.json - the cockpit's
scheduler reads that file, and a tool that edits it behind a hand's back is how
two hands collide.

A RENAMED NOTEBOOK IS STILL READ. A desk may carry `renames.json` beside its
ledger ({renames: [{old, new, runs, on}], removed: [{notebook, also_named, runs,
on, why}]}). A result whose recorded command names an OLD notebook is re-run on
the NEW one (`cmd_ran` and `renamed` in the read row); the ledger row keeps the
command it was recorded with, because a ledger is never rewritten (the research
naming book, the rename checklist, step 4). A notebook the owner REMOVED is not
run: the read is written `missed` with the reason, so the ledger cell says what
happened instead of a failed re-run of a file that is gone.

Exit: 0 read written (or emitted) · 1 refused · 2 the re-run failed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402
import fingerprint as FP  # noqa: E402

AGES = {"7d": 7, "30d": 30}
COLUMN = {"7d": "+7d", "30d": "+30d"}


def parse_iso(s: str) -> dt.datetime:
    t = str(s).strip().replace("Z", "")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return dt.datetime.strptime(t, fmt).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
    raise C.Refuse(f"{s!r} is not an ISO timestamp")


def due_at(result_row: dict, age: str) -> dt.datetime:
    return parse_iso(result_row["ts"]) + dt.timedelta(days=AGES[age])


def emit_jobs(desk: C.Desk, run: str, result_row: dict, ages: list[str]) -> dict:
    """One-shot `at <iso>` jobs in schedule.json's shape (see its $comment)."""
    jobs = []
    for age in ages:
        when = due_at(result_row, age).astimezone()     # schedule.json is LOCAL time
        jobs.append({
            "id": f"read-{run}-{age}",
            "kind": "script",
            "note": f"fixed-age read {age} for {run} ({desk.rel})",
            "cadence": f"at {when.strftime('%Y-%m-%dT%H:%M')}",
            "cwd": ".",
            "cmd": [".venv/Scripts/python.exe", "app/loop/tools/remeasure.py", "--desk", desk.rel,
                    "--run", run, "--age", age],
            "window_s": 4 * 86400,
            "timeout_s": 3600,
            "health": True,
        })
    return {"jobs": jobs}


def load_renames(desk: C.Desk) -> dict:
    """the desk's renames.json, {} when it has none or it does not parse (no file is no rename)"""
    try:
        doc = json.loads((desk.path / "renames.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _stem(tok: str) -> str:
    return tok.replace("\\", "/").rsplit("/", 1)[-1]


def apply_renames(doc: dict, run: str, cmd: str) -> tuple[str, list[dict]]:
    """cmd with every OLD notebook file replaced by the one it became (a rename of a rename is followed,
    a cycle stops), plus what was applied. Only an argument whose file name IS the old name is touched, and
    its folder is kept; `runs` limits a rename to the runs it names."""
    pairs = []
    for r in doc.get("renames") or []:
        old, new = r.get("old"), r.get("new")
        runs = r.get("runs") or []
        if isinstance(old, str) and isinstance(new, str) and old != new and (not runs or run in runs):
            pairs.append((old, new, r.get("on")))
    toks, applied = cmd.split(), []
    for i, tok in enumerate(toks):
        seen = set()
        while True:
            hit = next((p for p in pairs if _stem(toks[i]) == p[0] and p[0] not in seen), None)
            if not hit:
                break
            seen.add(hit[0])
            toks[i] = toks[i][: len(toks[i]) - len(hit[0])] + hit[1]
            applied.append({"old": hit[0], "new": hit[1], "on": hit[2]})
    return " ".join(toks) if applied else cmd, applied


def removed_for(doc: dict, run: str, *cmds: str) -> dict | None:
    """the removed-notebook entry that covers this run when any of the commands names one of its files"""
    for r in doc.get("removed") or []:
        runs = r.get("runs") or []
        if runs and run not in runs:
            continue
        names = {n for n in [r.get("notebook"), *(r.get("also_named") or [])] if isinstance(n, str)}
        if any(_stem(t) in names for c in cmds for t in c.split()):
            return r
    return None


def is_interpreter(tok: str, cwd) -> bool:
    """the command's first word is a python the read swaps for the fund's one venv: a bare name, or a path
    that does not exist from the run's cwd. A ledger command is recorded relative to the folder it ran in
    (`../../.venv/Scripts/python` from platform/research); the same string from studies/ points at
    platform/.venv, which is not there (B-0526, rc 127). A path that does exist is left alone."""
    name = _stem(tok).lower()
    if name.endswith(".exe"):
        name = name[:-4]
    if name not in ("python", "python3", "py"):
        return False
    path = tok.replace("\\", "/")
    if "/" not in path:
        return True
    p = os.path.normpath(os.path.join(str(cwd), path))
    return not (os.path.isfile(p) or os.path.isfile(p + ".exe"))


def extract(patterns: dict, out: str) -> tuple[dict, list[str]]:
    metrics, unparsed = {}, []
    for name, pat in (patterns or {}).items():
        try:
            m = re.search(pat, out, re.M)
        except re.error as e:
            unparsed.append(f"{name}: bad pattern ({e})")
            continue
        if not m or not m.groups():
            unparsed.append(f"{name}: pattern matched nothing")
            continue
        try:
            metrics[name] = float(m.group(1).replace(",", "").replace("%", "").replace("$", ""))
        except ValueError:
            unparsed.append(f"{name}: {m.group(1)!r} is not a number")
    return metrics, unparsed


def read_window(run_window: dict, override: str, now: dt.datetime) -> tuple[int, int]:
    """the read's fingerprint window: --window when given, else the run's own window
    ROLLED forward to now at the same length (the loop's fixed-age read re-runs on the
    window as it stands today)."""
    if override:
        return FP.parse_window(override)
    if not run_window.get("from") or not run_window.get("to"):
        raise C.Refuse("the run's window has no from/to to roll; pass --window FROM..TO")
    frm = FP.to_ms(str(run_window["from"]))
    to = FP.to_ms(str(run_window["to"]), end=True)
    end = int(now.timestamp() * 1000)
    return end - (to - frm), end


def write_removed(desk: C.Desk, a, res: dict, cmd: str, removed: dict, state: str,
                  due: dt.datetime, late_days: float) -> int:
    """the notebook was removed on purpose: nothing runs, the read is written MISSED with the owner's reason"""
    why = str(removed.get("why") or "the notebook was removed")
    if a.dry:
        print(f"DRY - the {a.age} read for {a.run} would NOT run: {_stem(cmd.split()[-1])} was removed "
              f"({removed.get('on')}): {why}")
        print(f"  writes:    {desk.rel}/results-log.md (entry + ledger {COLUMN[a.age]} cell 'missed removed'), "
              f"{desk.rel}/data/runs.jsonl")
        return 0
    row = {
        "run": a.run, "stage": "read", "age": a.age, "desk": desk.rel, "ts": C.now_iso(),
        "state": "missed", "due": due.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "late_days": round(late_days, 2), "cmd": cmd, "rc": None,
        "removed": {"on": removed.get("on"), "why": why, "notebook": removed.get("notebook")},
        "metrics": {}, "unparsed": [], "provenance": res.get("provenance", "[API]"),
    }
    C.append_jsonl(desk.runs, row)
    line = f"- **Read {a.age}** ({C.today()}, missed): not run - the notebook was removed ({removed.get('on')}): {why}"
    p2 = desk.f("results-log.md")
    text = C.read_text(p2)
    ent = C.entry_block(text, a.run)
    if ent:
        C.write_text(p2, text.replace(ent, C.entry_with_line(ent, line)))
    else:
        C.append_text(p2, "\n" + line + "\n")
    ledger = C.fill_ledger_cell(desk, a.run, COLUMN[a.age], "missed removed")
    if a.json:
        print(json.dumps({**row, "ledger": ledger}, indent=2, ensure_ascii=False))
    else:
        print(f"{a.age} read for {a.run}: missed (removed) · {why}")
        print(f"  ledger {COLUMN[a.age]}: {ledger}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--desk", required=True)
    ap.add_argument("--run", required=True)
    ap.add_argument("--age", default="7d", help="7d | 30d")
    ap.add_argument("--emit-jobs", action="store_true",
                    help="print the schedule.json snippet for BOTH ages and exit")
    ap.add_argument("--tolerance-days", type=float, default=4.0)
    ap.add_argument("--timeout", type=int, default=3600)
    ap.add_argument("--dry", action="store_true", help="say what would run; execute nothing")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--input", action="append", default=[],
                    help="venue:symbol:dataset:interval the read re-reads (repeatable); "
                         "writes fingerprint {digest, inputs[]} into the read row")
    ap.add_argument("--no-pin", action="store_true",
                    help="fingerprint without pinning (recorded as fingerprint.pin_skipped: true)")
    ap.add_argument("--no-input", action="store_true",
                    help="do not inherit the result row's fingerprint inputs")
    ap.add_argument("--window", default="",
                    help="the read's window FROM..TO for the fingerprint (default: the run's "
                         "window rolled forward to now, same length)")
    a = ap.parse_args(argv)

    try:
        desk = C.resolve_desk(a.desk)
        rows = C.run_rows(desk, a.run, "result")
        if not rows:
            raise C.Refuse(f"{a.run} has no recorded RESULT at {desk.rel} - "
                           f"there is nothing to re-read yet")
        res = rows[-1]
        if a.emit_jobs:
            print(json.dumps(emit_jobs(desk, a.run, res, list(AGES)), indent=2))
            print("\n# paste the jobs above into schedule.json.",
                  file=sys.stderr)
            return 0
        if a.age not in AGES:
            raise C.Refuse(f"--age must be one of {', '.join(AGES)}")
        if C.run_rows(desk, a.run, "read"):
            already = [r for r in C.run_rows(desk, a.run, "read") if r.get("age") == a.age]
            if already:
                raise C.Refuse(f"the {a.age} read for {a.run} is already written "
                               f"({already[-1].get('ts')}). Fixed-age reads are write-once - "
                               f"a second read at the same age is a different measurement and "
                               f"needs its own age.")
        cmd = res.get("cmd") or ""
        if not cmd:
            raise C.Refuse(f"{a.run} recorded no command; a read is a RE-RUN and needs one")

        due = due_at(res, a.age)
        now = dt.datetime.now(dt.timezone.utc)
        late_days = (now - due).total_seconds() / 86400
        if late_days < -0.5:
            raise C.Refuse(f"the {a.age} read for {a.run} is not due until "
                           f"{due.strftime('%Y-%m-%d %H:%M')}Z "
                           f"({-late_days:.1f} days away). Reading early is a different age.")
        state = "missed" if late_days > a.tolerance_days else "on-time"
        inputs = list(a.input) or ([] if a.no_input else FP.recorded_specs(res))
        inherited = bool(inputs) and not a.input
        fp_window = read_window(res.get("window") or {}, a.window, now) if inputs else None
        for sp in a.input:  # refuse a bad spec BEFORE an hour-long re-run, not after it
            if not FP.stored_rows(FP.parse_spec(sp)):
                raise C.Refuse(f"--input {sp!r}: no stored series in the market lake")
    except C.Refuse as e:
        return C.die(str(e))

    pre = (C.run_rows(desk, a.run, "preflight") or [{}])[-1]
    run_cwd = res.get("cwd") or pre.get("cwd") or ""
    cwd = C.resolve_cwd(run_cwd, desk.root)
    renames_doc = load_renames(desk)
    cmd_run, renamed = apply_renames(renames_doc, a.run, cmd)
    removed = removed_for(renames_doc, a.run, cmd, cmd_run)
    if removed:   # nothing runs, so no interpreter is needed either
        return write_removed(desk, a, res, cmd, removed, state, due, late_days)
    argv_run = cmd_run.split()
    exe = ""
    if argv_run and is_interpreter(argv_run[0], cwd):
        exe = C.fund_python(desk.root)
        if exe:
            argv_run = [exe, *argv_run[1:]]
        elif not a.dry:
            # --dry must never need the interpreter: a dry run that fails because a
            # venv is missing teaches nothing about the read it was rehearsing.
            return C.die("no .venv interpreter at the fund root - the read cannot re-run "
                         "the command")

    if a.dry:
        print(f"DRY - the {a.age} read for {a.run} ({state}, due "
              f"{due.strftime('%Y-%m-%d %H:%M')}Z)")
        for r in renamed:
            print(f"  renamed:   {r['old']} -> {r['new']} (renames.json, {r.get('on')}); the ledger keeps its recorded command")
        print(f"  would run: {' '.join(argv_run)}"
              + ("" if exe or not is_interpreter(argv_run[0], cwd)
                 else "   (NO .venv at the fund root - the real read would refuse)"))
        print(f"  cwd:       {cwd}")
        print(f"  patterns:  {res.get('metric_patterns') or 'none - metrics stay pending'}")
        if fp_window:
            print(f"  window:    {FP.dt.datetime.fromtimestamp(fp_window[0] / 1000, FP.dt.timezone.utc):%Y-%m-%dT%H:%MZ}"
                  f" .. {FP.dt.datetime.fromtimestamp(fp_window[1] / 1000, FP.dt.timezone.utc):%Y-%m-%dT%H:%MZ}"
                  f" fingerprinted over {len(inputs)} input(s) after the re-run"
                  + (" (inherited from the result row)" if inherited else "")
                  + ("" if a.no_pin else f", pinned as read-{a.age}"))
        print(f"  writes:    {desk.rel}/results-log.md (entry + ledger {COLUMN[a.age]} cell), "
              f"{desk.rel}/data/runs.jsonl, {desk.rel}/data/reads/")
        return 0

    t0 = dt.datetime.now(dt.timezone.utc)
    try:
        p = subprocess.run(argv_run, cwd=str(cwd), capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=a.timeout)
        rc, out, err = p.returncode, p.stdout or "", p.stderr or ""
    except subprocess.TimeoutExpired:
        rc, out, err = 124, "", f"timed out after {a.timeout}s"
    except OSError as e:
        rc, out, err = 127, "", str(e)

    reads_dir = desk.path / "data" / "reads"
    reads_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = reads_dir / f"{a.run}__{a.age}.txt"
    C.write_text(stdout_path, f"# {' '.join(argv_run)}\n# cwd {cwd}\n# ran {C.now_iso()}"
                              f"\n# rc {rc}\n\n{out}\n--- stderr ---\n{err}\n")

    metrics, unparsed = extract(res.get("metric_patterns") or {}, out)
    row = {
        "run": a.run, "stage": "read", "age": a.age, "desk": desk.rel, "ts": C.now_iso(),
        "state": state, "due": due.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "late_days": round(late_days, 2), "cmd": cmd, "rc": rc,
        **({"cmd_ran": cmd_run, "renamed": renamed} if renamed else {}),
        "rolled_window_note": ("re-run on the window as it stands today; every cached history "
                               "here is keyed by its end hour, so this is a DIFFERENT window "
                               "from the original run, not a refresh"),
        "metrics": metrics, "unparsed": unparsed,
        "stdout": str(stdout_path.relative_to(desk.root)).replace("\\", "/"),
        **C.code_commits(run_cwd, desk.root),
        "provenance": res.get("provenance", "[API]"),
        "ran_s": round((dt.datetime.now(dt.timezone.utc) - t0).total_seconds(), 1),
    }
    if rc != 0:
        row["error"] = (err or out)[-400:]
    if fp_window:
        # digested AFTER the re-run: the read's own fetch may have extended the store
        pin = None if a.no_pin else {"reason": f"read-{a.age}",
                                     "ref": f"{desk.rel}:{a.run}:{a.age}"}
        try:
            row["fingerprint"] = FP.fingerprint(inputs, *fp_window, pin=pin)
            if a.no_pin:
                row["fingerprint"]["pin_skipped"] = True
        except C.Refuse as e:
            row["fingerprint_error"] = str(e)
        if inherited:
            row["fingerprint_inputs_from"] = "result"
    C.append_jsonl(desk.runs, row)

    # the entry gains one line; the ledger cell is filled write-once
    mstr = (" · ".join(f"{k} {v:g}" for k, v in metrics.items())
            or ("parse: pending - " + "; ".join(unparsed) if unparsed
                else "parse: pending - no metric patterns registered"))
    line = (f"- **Read {a.age}** ({C.today()}, {state}"
            + (f", {late_days:.1f}d late" if late_days > 0.5 else "")
            + (f", ran {_stem(renamed[-1]['new'])}, renamed from {renamed[0]['old']}" if renamed else "")
            + f"): rc {rc} · {mstr} · stdout `{row['stdout']}`")
    p2 = desk.f("results-log.md")
    text = C.read_text(p2)
    ent = C.entry_block(text, a.run)
    if ent:
        C.write_text(p2, text.replace(ent, C.entry_with_line(ent, line)))
    else:
        C.append_text(p2, "\n" + line + "\n")
    cell = (" ".join(f"{k} {v:g}" for k, v in metrics.items()) or "ran")[:40]
    if state == "missed":
        cell = "missed " + cell
    ledger = C.fill_ledger_cell(desk, a.run, COLUMN[a.age], cell)

    if a.json:
        print(json.dumps({**row, "ledger": ledger}, indent=2, ensure_ascii=False))
    else:
        print(f"{a.age} read for {a.run}: {state} (rc {rc}) · {mstr}"
              + (f" · window {row['fingerprint']['digest']} · "
                 f"{FP.pin_summary(row['fingerprint'])}" if row.get("fingerprint") else ""))
        print("  window ROLLED - this is a different window, not a refresh")
        print(f"  ledger {COLUMN[a.age]}: {ledger}")
        if unparsed:
            print("  unparsed: " + "; ".join(unparsed))
            print(f"  stdout preserved at {row['stdout']} - fill the metric by hand or add a "
                  f"--metric-pattern at pre-registration next time")
    return 0 if rc == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
