"""Write one trial line per registered cell of a B-0654 candidate to the desk's grids folder, for `app/loop/tools/trial.py --cells-file` (the Lab's TRIALS column).

    python tf15_trials.py um-005 c1-tail-buy

A line is the cell, its per-entry Sharpe, entry count, skew and (non-excess) kurtosis on the VALIDATION days, where the cell was chosen. The file is the whole sweep; nothing is left out.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import tf15_bt as B
import tf15_cands as C
import tf15_study as S

HERE = Path(__file__).resolve().parent
GRIDS = HERE.parents[1] / "lab" / "predmkts" / "data" / "grids"
CANDS = {"c1-tail-buy": C.TailBuy, "c2-near-certain": C.NearCertain, "c3-edge-taker": C.EdgeTaker, "c4-passive-binance": C.PassiveBinance}
TRAIN = ("2026-09-30", "2026-10-01", "2026-10-02")
VALIDATE = ("2026-10-03", "2026-10-04")


def main(run: str, cid: str) -> int:
    cand = CANDS[cid]()
    tr, va = B.Tab(TRAIN), B.Tab(VALIDATE)
    ctx = cand.fit(tr)
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    lines = []
    for cfg in cand.grid():
        e = cand.run(va, cfg, ctx)
        st = S.sharpe_stats(e["net"])
        if st["n"] < 3 or st["sr"] != st["sr"]:
            # a cell with under three validation entries measured nothing: it still counts in N, as an abandoned cell with neutral moments (a placeholder, said in the cell)
            lines.append({"cell": {**cfg, "placeholder": "under 3 validation entries: nothing measured, n_obs set to the ledger minimum"}, "status": "abandoned", "sharpe": 0.0, "n_obs": max(st["n"], 2), "skew": 0.0, "kurt": 3.0})      # the ledger needs n_obs of at least 2
            continue
        lines.append({"cell": {k: v for k, v in cfg.items()}, "status": "kept", "sharpe": round(st["sr"], 6), "n_obs": st["n"], "skew": round(st["skew"], 4), "kurt": round(st["kurt"], 4)})
    GRIDS.mkdir(parents=True, exist_ok=True)
    out = GRIDS / f"{run}.jsonl"
    out.write_text("\n".join(json.dumps(x, sort_keys=True) for x in lines) + "\n", encoding="utf-8", newline="\n")
    print(f"{ts} wrote {len(lines)} cells to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
