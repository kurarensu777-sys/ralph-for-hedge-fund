"""Write one trial line per distinct cell of the directional momentum study (B-0660) to the desk's grids folder, for `app/loop/tools/trial.py --cells-file` (the Lab's TRIALS column).

    python mom15_trials.py um-009        (or um-012, the full-window re-score of B-0679; the days come from `mom15_study.PROTOCOLS`)

A line is the cell, its per-entry Sharpe, entry count, skew and (non-excess) kurtosis on the VALIDATION days, where the cells were chosen. The file is the whole sweep: stage 2, stage 3 and
the loop back, each distinct (signal, exit) cell once.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import mom15_bt as M
import mom15_study as ST
import tf15_study as TS

HERE = Path(__file__).resolve().parent
GRIDS = HERE.parents[1] / "lab" / "predmkts" / "data" / "grids"


def main(run: str) -> int:
    days = ST.PROTOCOLS[run]
    study = ST.Study(M.MTab(days["FIT"], fill_ms=ST.FILL_MS), M.MTab(days["VALIDATE"], fill_ms=ST.FILL_MS), log=lambda *_: None)
    study.run_stages()
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    lines = []
    for k, c in study.cells.items():
        sg, ex = c["sig"], c["ex"]
        cell = {"cfg": k, "L": sg.L, "z": sg.z, "L_long": sg.Ll, "exit": ex.kind, "exit_p": ex.p}
        st = TS.sharpe_stats(c["validate"]["entries"]["net"])
        if st["n"] < 3 or st["sr"] != st["sr"]:
            lines.append({"cell": {**cell, "placeholder": "under 3 validation entries: nothing measured, n_obs set to the ledger minimum"}, "status": "abandoned", "sharpe": 0.0, "n_obs": max(st["n"], 2), "skew": 0.0, "kurt": 3.0})
            continue
        lines.append({"cell": cell, "status": "kept", "sharpe": round(st["sr"], 6), "n_obs": st["n"], "skew": round(st["skew"], 4), "kurt": round(st["kurt"], 4)})
    GRIDS.mkdir(parents=True, exist_ok=True)
    out = GRIDS / f"{run}.jsonl"
    out.write_text("\n".join(json.dumps(x, sort_keys=True) for x in lines) + "\n", encoding="utf-8", newline="\n")
    print(f"{ts} wrote {len(lines)} cells to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
