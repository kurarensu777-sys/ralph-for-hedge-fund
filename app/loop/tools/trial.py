#!/usr/bin/env python3
"""TRIAL - one configuration evaluated, appended to the desk's trial ledger.

A sweep that prints only its best cell has hidden how many cells it tried, and
the number of tries is exactly what the Deflated Sharpe (Bailey & Lopez de
Prado) needs: the more configurations were looked at, the higher the best one
has to stand before it is evidence. So every cell a sweep evaluates is written
here, once, INCLUDING the ones it threw away (`--status abandoned`).

    python app/loop/tools/trial.py --desk carry --run carry-016 \
      --cell lev=2 --cell reserve=4 --returns-file scratch/cell_2_4.json

    python app/loop/tools/trial.py --desk carry --run carry-016 --status abandoned \
      --cell lev=10 --cell reserve=0 --sharpe 0.031 --n-obs 213 --skew -1.2 --kurt 9.4

THE LEDGER: `lab/<desk>/data/trials.jsonl`, one JSON object per line:
  {ts, run, mechanic, cell, sharpe, n_obs, skew, kurt, returns, status}

  sharpe   PER-OBSERVATION Sharpe (mean / st.dev of the observations, NOT
           annualized) - the unit the DSR formula takes with n_obs. Pass
           --sharpe-ann with --ppy to convert an annualized figure.
  kurt     the NON-excess kurtosis (a normal is 3).
  returns  the daily return PATH (a list of floats) when one is given, else null.
           PBO by CSCV needs it; a trial without a path still counts in N.
  status   kept | abandoned | rerun.

APPEND, NEVER REWRITE. This tool opens the file in append mode and nothing
else. A cell evaluated again is a NEW row (`--status rerun`); the old row stays.

A WHOLE SWEEP IN ONE CALL: `--cells-file sweep.jsonl`, one JSON object per line
(or one JSON array), each {cell, status?, returns? | sharpe, n_obs, skew, kurt}.
Every line is validated before ANY is written; one bad line refuses the whole
file and names its line. This is the form a sweep emits: the engine loop writes
one line per cell it evaluated, abandoned cells included, and the desk's
cadence runs this once.

    python app/loop/tools/trial.py --desk carry --run carry-016 --cells-file scratch/grid.jsonl

A grid file ACCUMULATES: write_trial_cells appends one block per sweep, each cell
stamped `cell.sweep_run`. Reading the whole file would count every earlier sweep's
cells again in N. So a cells file carrying more than one distinct sweep_run (or a
mix of stamped and unstamped lines) is REFUSED, the runs found named, unless
`--sweep-run <id>` keeps only the lines stamped <id>. A file with one run, or with
no stamps at all (written before B-0247), needs no flag.

    python app/loop/tools/trial.py --desk carry --run carry-016       --cells-file lab/carry/data/grids/lev.jsonl --sweep-run 20260927T101500Z

WHAT IT REFUSES: an unknown status; a run with no pre-flight unless --mechanic
names one; a mechanic that is not a row in mechanics.md; a trial with neither a
return path nor all four of sharpe / n-obs / skew / kurt; a return path shorter
than 3 observations or with zero variance.

Exit: 0 appended · 1 refused · 2 usage.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402

STATUSES = ("kept", "abandoned", "rerun")


def trials_path(desk: C.Desk) -> Path:
    return desk.path / "data" / "trials.jsonl"


def moments(rets: list[float]) -> dict:
    """per-observation Sharpe, sample skew and NON-excess kurtosis of a path."""
    n = len(rets)
    if n < 3:
        raise C.Refuse(f"a return path needs at least 3 observations, got {n}")
    mu = sum(rets) / n
    var = sum((x - mu) ** 2 for x in rets) / (n - 1)
    if var <= 0:
        raise C.Refuse("the return path has zero variance: its Sharpe is undefined")
    sd = math.sqrt(var)
    m2 = sum((x - mu) ** 2 for x in rets) / n
    m3 = sum((x - mu) ** 3 for x in rets) / n
    m4 = sum((x - mu) ** 4 for x in rets) / n
    return {"sharpe": mu / sd, "n_obs": n,
            "skew": m3 / m2 ** 1.5 if m2 > 0 else 0.0,
            "kurt": m4 / m2 ** 2 if m2 > 0 else 3.0}


def read_returns(spec: str) -> list[float]:
    """a JSON array file, or one number per line."""
    p = Path(spec)
    if not p.is_file():
        raise C.Refuse(f"--returns-file {spec!r} does not exist")
    text = C.read_text(p).strip()
    try:
        vals = json.loads(text) if text.startswith("[") else [
            float(x) for x in text.replace(",", "\n").split() if x.strip()]
    except ValueError as e:
        raise C.Refuse(f"--returns-file {spec!r} is not a list of numbers: {e}")
    out = []
    for v in vals:
        try:
            f = float(v)
        except (TypeError, ValueError):
            raise C.Refuse(f"--returns-file {spec!r} holds a non-number {v!r}")
        if not math.isfinite(f):
            raise C.Refuse(f"--returns-file {spec!r} holds a non-finite value")
        out.append(f)
    return out


def parse_cell(pairs: list[str], cell_json: str) -> dict:
    cell: dict = {}
    if cell_json:
        try:
            cell = json.loads(cell_json)
        except ValueError as e:
            raise C.Refuse(f"--cell-json is not JSON: {e}")
        if not isinstance(cell, dict):
            raise C.Refuse("--cell-json must be a JSON object")
    for p in pairs:
        if "=" not in p:
            raise C.Refuse(f"--cell {p!r} must be name=value")
        k, v = p.split("=", 1)
        v = v.strip()
        try:
            val: object = int(v) if v.lstrip("+-").isdigit() else float(v)
        except ValueError:
            val = v
        cell[k.strip()] = val
    if not cell:
        raise C.Refuse("a trial names its configuration: at least one --cell name=value")
    return cell


def build_row(desk: C.Desk, a) -> dict:
    if a.status not in STATUSES:
        raise C.Refuse(f"--status must be one of {', '.join(STATUSES)}")
    pre = C.run_rows(desk, a.run, "preflight")
    mech = a.mechanic or (pre[-1].get("mechanic") if pre else None)
    if not mech:
        raise C.Refuse(f"{a.run} has no pre-flight at {desk.rel} and no --mechanic was "
                       f"given: a trial belongs to a mechanic, or N cannot be counted")
    known = C.mechanics(desk)
    if mech not in known:
        raise C.Refuse(f"mechanic {mech!r} is not a row in {desk.rel}/mechanics.md "
                       f"(rows: {', '.join(known) or 'none'})")
    cell = parse_cell(a.cell, a.cell_json)

    rets = (list(a.returns) if getattr(a, "returns", None) is not None
            else read_returns(a.returns_file) if a.returns_file else None)
    if rets is not None and any(not isinstance(v, (int, float)) or isinstance(v, bool)
                                or not math.isfinite(v) for v in rets):
        raise C.Refuse("returns must be a list of finite numbers")
    if rets is not None:
        m = moments(rets)
    else:
        sharpe = a.sharpe
        if sharpe is None and a.sharpe_ann is not None:
            if not a.ppy or a.ppy <= 0:
                raise C.Refuse("--sharpe-ann needs --ppy (observations per year) to convert")
            sharpe = a.sharpe_ann / math.sqrt(a.ppy)
        missing = [n for n, v in (("sharpe", sharpe), ("n-obs", a.n_obs), ("skew", a.skew),
                                  ("kurt", a.kurt)) if v is None]
        if missing:
            raise C.Refuse(f"no --returns-file, and {', '.join('--' + x for x in missing)} "
                           f"not given. The DSR needs all four; a guessed skew or kurtosis "
                           f"is a number nobody measured.")
        if a.n_obs < 2:
            raise C.Refuse("--n-obs must be at least 2")
        m = {"sharpe": sharpe, "n_obs": a.n_obs, "skew": a.skew, "kurt": a.kurt}
    return {
        "ts": C.now_iso(), "run": a.run, "mechanic": mech, "cell": cell,
        "sharpe": round(float(m["sharpe"]), 10), "n_obs": int(m["n_obs"]),
        "skew": round(float(m["skew"]), 10), "kurt": round(float(m["kurt"]), 10),
        "returns": rets, "status": a.status,
    }


CELL_KEYS = {"cell", "status", "returns", "sharpe", "sharpe_ann", "ppy", "n_obs", "skew", "kurt"}


def read_cells(spec: str) -> list[dict]:
    """a JSON array of cell objects, or one JSON object per line."""
    p = Path(spec)
    if not p.is_file():
        raise C.Refuse(f"--cells-file {spec!r} does not exist")
    text = C.read_text(p).strip()
    if not text:
        raise C.Refuse(f"--cells-file {spec!r} is empty: a sweep that evaluated nothing has no trials")
    if text.startswith("["):
        try:
            items = json.loads(text)
        except ValueError as e:
            raise C.Refuse(f"--cells-file {spec!r} is not JSON: {e}")
    else:
        items = []
        for i, line in enumerate(text.splitlines(), 1):
            if not line.strip():
                continue
            try:
                items.append(json.loads(line))
            except ValueError as e:
                raise C.Refuse(f"--cells-file line {i}: not JSON ({e})")
    return items


def select_sweep(items: list, want: str) -> list:
    """keep one sweep_run of an accumulated grid file; refuse an ambiguous one."""
    def stamp(it):
        c = it.get("cell") if isinstance(it, dict) else None
        v = c.get("sweep_run") if isinstance(c, dict) else None
        return None if v is None else str(v)

    found = sorted({stamp(it) for it in items}, key=lambda v: (v is None, v or ""))
    named = ", ".join("unstamped" if v is None else repr(v) for v in found)
    if want:
        kept = [it for it in items if stamp(it) == want]
        if not kept:
            raise C.Refuse(f"--sweep-run {want!r} matches no line of the cells file "
                           f"(runs found: {named})")
        return kept
    if len(found) > 1:
        raise C.Refuse(f"the cells file holds {len(found)} sweep runs ({named}): feeding it whole "
                       f"would count the earlier runs' cells again in N. Pass --sweep-run <id> "
                       f"to take one")
    return items


def build_rows_from_file(desk: C.Desk, a) -> list[dict]:
    rows = []
    items = select_sweep(read_cells(a.cells_file), a.sweep_run)
    for i, it in enumerate(items, 1):
        if not isinstance(it, dict):
            raise C.Refuse(f"--cells-file item {i}: not a JSON object")
        extra = set(it) - CELL_KEYS
        if extra:
            raise C.Refuse(f"--cells-file item {i}: unknown key(s) {', '.join(sorted(extra))}")
        if not isinstance(it.get("cell"), dict):
            raise C.Refuse(f"--cells-file item {i}: `cell` must be an object")
        ns = argparse.Namespace(**{**vars(a), "cell": [], "cell_json": json.dumps(it["cell"]),
                                   "status": it.get("status", a.status), "returns_file": "",
                                   "returns": it.get("returns"),
                                   "sharpe": it.get("sharpe"), "sharpe_ann": it.get("sharpe_ann"),
                                   "ppy": it.get("ppy"), "n_obs": it.get("n_obs"),
                                   "skew": it.get("skew"), "kurt": it.get("kurt")})
        try:
            rows.append(build_row(desk, ns))
        except C.Refuse as e:
            raise C.Refuse(f"--cells-file item {i}: {e}")
    return rows


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--desk", required=True)
    ap.add_argument("--run", required=True)
    ap.add_argument("--mechanic", default="", help="defaults to the run's pre-flight")
    ap.add_argument("--cell", action="append", default=[], help="name=value (repeatable)")
    ap.add_argument("--cell-json", default="", help="the whole cell as a JSON object")
    ap.add_argument("--status", default="kept", help="kept | abandoned | rerun")
    ap.add_argument("--returns-file", default="", help="daily returns: JSON array or one per line")
    ap.add_argument("--sharpe", type=float, default=None, help="per-observation Sharpe")
    ap.add_argument("--sharpe-ann", type=float, default=None, help="annualized Sharpe (needs --ppy)")
    ap.add_argument("--ppy", type=float, default=None, help="observations per year")
    ap.add_argument("--n-obs", type=int, default=None)
    ap.add_argument("--skew", type=float, default=None)
    ap.add_argument("--kurt", type=float, default=None, help="NON-excess kurtosis (normal = 3)")
    ap.add_argument("--cells-file", default="",
                    help="a whole sweep: JSONL (or a JSON array) of {cell, status?, returns? | "
                         "sharpe, n_obs, skew, kurt}; all-or-nothing")
    ap.add_argument("--sweep-run", default="",
                    help="with --cells-file: keep only lines whose cell.sweep_run is this id "
                         "(required when the file holds more than one run)")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    try:
        desk = C.resolve_desk(a.desk)
        if a.sweep_run and not a.cells_file:
            raise C.Refuse("--sweep-run selects lines of a --cells-file; none was given")
        if a.cells_file:
            if a.cell or a.cell_json or a.returns_file:
                raise C.Refuse("--cells-file carries its own cells: drop --cell / --cell-json / "
                               "--returns-file")
            batch = build_rows_from_file(desk, a)
        else:
            batch = None
            row = build_row(desk, a)
    except C.Refuse as e:
        return C.die(str(e))
    p = trials_path(desk)
    if batch is not None:
        if a.dry:
            print(f"DRY - {len(batch)} cell(s) valid. Would append to {desk.rel}/data/trials.jsonl")
            return 0
        for r in batch:
            C.append_jsonl(p, r)
        by = {}
        for r in batch:
            by[r["status"]] = by.get(r["status"], 0) + 1
        if a.json:
            print(json.dumps({"appended": len(batch), "by_status": by}))
        else:
            print(f"trials {a.run}: {len(batch)} appended ("
                  + ", ".join(f"{k} {v}" for k, v in sorted(by.items())) + ")")
        return 0
    if a.dry:
        print(f"DRY - valid. Would append to {desk.rel}/data/trials.jsonl:")
        print(json.dumps({**row, "returns": f"<{len(row['returns'])} obs>" if row["returns"] else None}))
        return 0
    C.append_jsonl(p, row)
    if a.json:
        print(json.dumps(row, ensure_ascii=False))
    else:
        n = sum(1 for r in C.read_jsonl(p) if r.get("run") == a.run)
        print(f"trial {a.run} {row['status']} {json.dumps(row['cell'], sort_keys=True)} "
              f"sharpe {row['sharpe']:.4f}/obs n {row['n_obs']} · {n} trial row(s) for {a.run}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
