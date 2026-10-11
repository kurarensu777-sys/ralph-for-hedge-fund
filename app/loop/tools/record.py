#!/usr/bin/env python3
"""RECORD - the write-once result, its gate outcomes, and its immediate grade.

A result may only be recorded against a pre-flight that already exists, and
only once. That pairing is the whole contract: the prediction is on disk,
timestamped, before these numbers were known, so the retro can grade a judge
rather than a memory.

WHAT IT REFUSES:
  * no pre-flight for this run          -> REFUSED (an unregistered result)
  * the pre-flight is not its OWN commit in HEAD (uncommitted, or landed
    together with other files), or that commit is later than the run
    (`--ran`, default now)              -> REFUSED (git order is the proof
                                           the prediction came first)
  * a result already recorded           -> REFUSED (write-once; a correction is
                                           a NEW row with `corrects`, per the run
                                           record chapter - use --corrects)
  * a verify count that is not n/n      -> REFUSED unless --verify-failed, which
                                           records the failure honestly instead
  * a gate left unstated                -> REFUSED (provenance, window, verify,
                                           scope: the cadence's four, by name)

WHAT IT WRITES: the `**Result:**` / `**Verify:**` lines into the run's entry,
the ledger row with its WINDOW, and the `stage: "result"` row in runs.jsonl
carrying the metrics, the gates and the per-metric hit/miss against the
pre-registered bands.

THE DATA IT READ: `--input venue:symbol:dataset:interval` (repeatable)
fingerprints the rows inside the window AND PINS them (reason `result`, ref
`<desk>:<run>`) through pins.py, the one adapter to fund_db's pin API: the
cache is evictable, the pin is not, so the fingerprint can be re-checked later.
Each input carries `pin` (= its sha256) or `pin: null` + `pin_error` (no pin
API yet, B-0324: the result still records, honestly unpinned). A pin whose hash
is not the fingerprint's is REFUSED and nothing is written. `--no-pin` opts out
explicitly and says so in the row (`fingerprint.pin_skipped: true`); `--dry`
never pins.

    python app/loop/tools/record.py --desk carry --run carry-015 \
      --verify "verify_carry_pro 16/16" \
      --metric ann_pct=26.40 --metric max_dd_pct=-3.40 --metric liquidations=0 \
      --headline "+$154,273 = +26.40% ann on $1M AUM, MaxDD -3.4%, 0 liquidations" \
      --gate provenance=ok --gate window=ok --gate verify=ok --gate scope=ok

Exit: 0 recorded · 1 refused · 2 usage.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402
import fingerprint as FP  # noqa: E402

GATES = ("provenance", "window", "verify", "scope")
VERIFY_RE = re.compile(r"^\s*(?P<suite>[\w.\-]+)?\s*(?P<p>\d+)\s*/\s*(?P<t>\d+)\s*$")


def parse_verify(text: str) -> dict:
    m = VERIFY_RE.match(text or "")
    if not m:
        raise C.Refuse("--verify must be '<suite> n/n', e.g. 'verify_carry_pro 16/16'. "
                       "A result with no verify count is not admissible.")
    return {"suite": (m.group("suite") or "").strip(),
            "passed": int(m.group("p")), "total": int(m.group("t"))}


def grade(predicted: dict, metrics: dict) -> dict:
    """hit / miss / unmeasured, per predicted metric."""
    out = {}
    for k, raw in predicted.items():
        if k not in metrics:
            out[k] = {"band": raw, "actual": None, "verdict": "unmeasured"}
            continue
        band = C.parse_band(raw)
        v = float(metrics[k])
        if band.contains(v):
            verdict = "hit"
        elif band.hi is not None and v > band.hi:
            verdict = "over"
        else:
            verdict = "under"
        out[k] = {"band": raw, "actual": v, "verdict": verdict,
                  "width": band.width}
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--desk", required=True)
    ap.add_argument("--run", required=True)
    ap.add_argument("--verify", required=True, help="'<suite> n/n'")
    ap.add_argument("--verify-failed", action="store_true",
                    help="record an n/m verify honestly instead of refusing")
    ap.add_argument("--metric", action="append", default=[], help="name=number (repeatable)")
    ap.add_argument("--headline", default="", help="one line, with its units")
    ap.add_argument("--gate", action="append", default=[],
                    help=f"name=ok|fail for each of {', '.join(GATES)} (repeatable)")
    ap.add_argument("--window", default="", help="override the pre-flight's window (FROM..TO)")
    ap.add_argument("--ran", default="",
                    help="UTC ISO instant the engine STARTED (default: now). Refused when the "
                         "pre-flight commit is later")
    ap.add_argument("--corrects", default="",
                    help="this row corrects an earlier run id (append-only correction)")
    ap.add_argument("--note", default="")
    ap.add_argument("--input", action="append", default=[],
                    help="venue:symbol:dataset:interval the run read (repeatable); "
                         "writes fingerprint {digest, inputs[]} into the row and pins each "
                         "input's in-window rows")
    ap.add_argument("--no-pin", action="store_true",
                    help="fingerprint --input without pinning it (recorded as "
                         "fingerprint.pin_skipped: true)")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    try:
        desk = C.resolve_desk(a.desk)
        pre = C.run_rows(desk, a.run, "preflight")
        if not pre:
            raise C.Refuse(
                f"no pre-flight for {a.run} at {desk.rel}. A result with no registered "
                f"prediction is a number, not evidence - run preregister.py first. "
                f"(Registered: {', '.join(C.run_ids(desk)[-6:]) or 'none'})")
        pre = pre[-1]
        if C.has_result(desk, a.run) and not a.corrects:
            raise C.Refuse(f"{a.run} already has a result (write-once). A correction is a NEW "
                           f"row: --run {a.run}-c1 --corrects {a.run}, with a note saying what "
                           f"was wrong. The old row stays.")

        # the pre-flight must be its own commit, landed before the run started
        pf_commit = C.preflight_commit(desk, a.run)
        now = time.time()
        ran = C.epoch_of_iso(a.ran) if a.ran else now
        if ran > now + 60:
            raise C.Refuse(f"--ran {a.ran} is in the future")
        if pf_commit["at"] > ran:
            raise C.Refuse(
                f"{a.run}'s pre-flight was committed {pf_commit['at_iso']} "
                f"({pf_commit['sha'][:12]}), AFTER the run started ({C.iso_of_epoch(ran)}). "
                f"A prediction landed after the engine ran is not a pre-registration. "
                f"Register a new run id and run it again.")

        verify = parse_verify(a.verify)
        if verify["passed"] != verify["total"] and not a.verify_failed:
            raise C.Refuse(f"verify is {verify['passed']}/{verify['total']}, not ALL PASS. "
                           f"Every engine result passes its verify(); pass --verify-failed to "
                           f"record the failure as the finding it is.")

        metrics = C.parse_kv_numbers(a.metric, "--metric")
        if not metrics:
            raise C.Refuse("at least one --metric name=number is required")

        gates = {}
        for g in a.gate:
            if "=" not in g:
                raise C.Refuse(f"--gate {g!r} must be name=ok|fail")
            k, v = g.split("=", 1)
            gates[k.strip().lower()] = v.strip().lower()
        missing = [g for g in GATES if g not in gates]
        if missing:
            raise C.Refuse(f"unstated gate(s): {', '.join(missing)}. The cadence's gates are "
                           f"named one by one so that skipping one is visible: "
                           f"--gate provenance=ok --gate window=ok --gate verify=ok "
                           f"--gate scope=ok")
        failed_gates = [g for g, v in gates.items() if v not in ("ok", "pass", "true")]

        window = dict(pre.get("window") or {})
        if a.window:
            m = re.match(r"^\s*(\S+)\s*(?:\.\.|->|to)\s*(\S+)\s*$", a.window)
            if not m:
                raise C.Refuse("--window FROM..TO")
            window["from"], window["to"] = m.group(1), m.group(2)
        if not window.get("from"):
            raise C.Refuse("the pre-flight carries no window and none was given")

        fingerprint = None
        if a.input:
            pin = (None if a.no_pin or a.dry
                   else {"reason": "result", "ref": f"{desk.rel}:{a.run}"})
            fingerprint = FP.for_window(a.input, window, pin=pin)
            if a.no_pin:
                fingerprint["pin_skipped"] = True

        graded = grade(pre.get("predicted") or {}, metrics)
        hits = sum(1 for g in graded.values() if g["verdict"] == "hit")
        gradeable = sum(1 for g in graded.values() if g["verdict"] != "unmeasured")

        row = {
            "run": a.run, "stage": "result", "desk": desk.rel, "ts": C.now_iso(),
            "kind": pre.get("kind"), "mechanic": pre.get("mechanic"),
            "experiment": pre.get("experiment"), "variables": pre.get("variables", []),
            "ancestor": pre.get("ancestor"), "beliefs": pre.get("beliefs", []),
            "cmd": pre.get("cmd"), "window": window, "verify": verify,
            "predicted": pre.get("predicted") or {}, "metrics": metrics,
            "graded": graded, "gates": gates,
            "provenance": pre.get("provenance", "[API]"),
            "platform_commit": C.platform_sha(desk.root) or C.commit_of(pre),
            "headline": a.headline.strip(),
            "ran": C.iso_of_epoch(ran),
            "preflight_commit": pf_commit["sha"],
        }
        if pre.get("comparator"):
            row["comparator"] = pre["comparator"]
        if a.corrects:
            row["corrects"] = a.corrects
        if a.note:
            row["note"] = a.note
        if fingerprint:
            row["fingerprint"] = fingerprint

        win_s = (f"{window['from']} -> {window['to']}"
                 + (f" · {window['hours']}h" if window.get("hours") else "")
                 + (f" · {window['regimes']} regime(s)" if window.get("regimes") else ""))
        vs = f"{verify['suite']} {verify['passed']}/{verify['total']}".strip()
        grade_s = " · ".join(
            f"{k} {g['verdict']} (predicted {g['band']}"
            + (f", actual {g['actual']:g}" if g["actual"] is not None else "") + ")"
            for k, g in graded.items()) or "nothing predicted"
        lines = [
            f"- **Verify:** {vs} "
            + ("ALL PASS" if verify['passed'] == verify['total'] else "** NOT ALL PASS **"),
            f"- **Result:** ({C.today()}) {a.headline.strip() or 'see metrics'} · "
            + " · ".join(f"{k} {v:g}" for k, v in metrics.items()),
            "- **Gates:** " + " · ".join(f"{g}={gates[g]}" for g in GATES)
            + (f"  ** {len(failed_gates)} GATE(S) NOT PASSED **" if failed_gates else ""),
            f"- **Judged:** {hits}/{gradeable} predicted metric(s) in band - {grade_s}",
            f"- **Read:** pending - +7d and +30d due from {C.today()}",
        ]
        block = "\n".join(lines)
    except C.Refuse as e:
        return C.die(str(e))

    if a.dry:
        print(f"DRY - valid. Would append to {desk.rel}/results-log.md:\n")
        print(block)
        print("\nledger row + runs.jsonl:\n" + json.dumps(row, indent=2, ensure_ascii=False))
        return 0

    # The entry gains the result lines; the pending placeholders are replaced in
    # place because they were never facts - they were slots.
    p = desk.f("results-log.md")
    text = C.read_text(p)
    ent = C.entry_block(text, a.run)
    if ent:
        new = ent
        for pat in (r"^- \*\*Verify:\*\* pending\s*$", r"^- \*\*Result:\*\* pending.*$",
                    r"^- \*\*Read:\*\* pending.*$"):
            new = re.sub(pat, "", new, flags=re.M)
        new = C.entry_with_line(re.sub(r"\n{3,}", "\n\n", new), block)
        C.write_text(p, text.replace(ent, new))
    else:
        C.append_entry(desk, f"### {a.run} - recorded {C.today()}\n\n{block}")

    C.append_ledger_row(desk, {
        "Run": a.run, "Mechanic": pre.get("mechanic", "-"), "Ran": C.today(),
        "Window (UTC, hours, regimes)": win_s, "Verify": vs,
        "Headline": (a.headline.strip() or "-")[:80],
        "+7d": "-", "+30d": "-", "Read": "pending",
    })
    C.append_jsonl(desk.runs, row)
    trials = [r for r in C.read_jsonl(desk.path / "data" / "trials.jsonl") if r.get("run") == a.run]
    if not trials:
        print(f"WARNING: {a.run} carries no trial rows in {desk.rel}/data/trials.jsonl - its "
              f"Deflated Sharpe has no N. A sweep calls app/loop/tools/trial.py once per cell, "
              f"abandoned cells included.", file=sys.stderr)

    if a.json:
        print(json.dumps(row, indent=2, ensure_ascii=False))
    else:
        print(f"recorded {a.run} at {desk.rel} · verify {vs} · "
              f"{hits}/{gradeable} predicted metric(s) in band"
              + (f" · window {fingerprint['digest']} · {FP.pin_summary(fingerprint)}"
                 if fingerprint else ""))
        for k, g in graded.items():
            act = f"{g['actual']:g}" if g["actual"] is not None else "not measured"
            print(f"  {k:18} predicted {g['band']:>14}  actual {act:>12}  {g['verdict']}")
        if failed_gates:
            print(f"  GATES NOT PASSED: {', '.join(failed_gates)}")
        print("  next: schedule the fixed-age reads -")
        print(f"    python app/loop/tools/remeasure.py --desk {a.desk} --run {a.run} "
              f"--age 7d --emit-jobs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
