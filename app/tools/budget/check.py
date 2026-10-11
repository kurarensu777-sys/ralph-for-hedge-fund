#!/usr/bin/env python3
"""THE BUDGET GATE - refuse an unattended run that has already spent its day.

`usage.py` is the meter; this is the gate. The cockpit's scheduler calls it
BEFORE starting an agent job, because the moment an unattended loop can spend
without a ceiling, a bug in a cadence becomes a bill.

    python app/tools/budget/check.py platform              # by roster id
    python app/tools/budget/check.py platform        # or by the agent's cwd
    python app/tools/budget/check.py platform --json
    python app/tools/budget/check.py platform --reserve 200000   # need this much headroom

Exit: 0 under budget (or no budget set) · 1 OVER - do not start · 2 the check
could not run (no transcripts, no such seat). A `2` is not a licence to run:
the caller decides, but it must decide knowingly, which is why it is not 0.

THE CEILING IS the roster's (app/agents/<id>.md). `budgetTokensPerDay` on the agent, else
a top-level `defaults.budgetTokensPerDay`. An agent with neither has NO
ceiling, and this says so out loud rather than inventing one - an invented
budget is the same class of error as an invented fee. Agents sharing a cwd are
one seat (see usage.py); asking for any one of them answers for the seat.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage as U  # noqa: E402


def resolve_seat(name: str, org: dict) -> tuple[str, dict] | tuple[None, None]:
    """An agent id, a shared-cwd seat id, or an agent's cwd -> (seat id, row)."""
    _, seats = U.seat_index(org, U.fund_root())
    n = U._norm(name)
    if n in seats:
        return n, seats[n]
    for sid, row in seats.items():
        if n in row.get("members", []) or n == row.get("name"):
            return sid, row
    for sid, row in seats.items():
        cwd = row.get("cwd", "")
        if cwd and cwd != "." and (n == cwd or cwd.endswith("/" + n)):
            return sid, row
    return None, None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("agent", help="a roster id, or the agent's cwd")
    ap.add_argument("--metric", default="billable", choices=sorted(U.METRICS))
    ap.add_argument("--reserve", type=int, default=0,
                    help="required headroom: fail if used + reserve > budget")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    root = U.fund_root()
    org = U.load_org(root)
    if not org:
        print("budget check: the roster (app/agents/) is unreadable - no ceiling can be resolved",
              file=sys.stderr)
        return 2
    seat, row = resolve_seat(a.agent, org)
    if not seat:
        ids = ", ".join(r.get("id", "?") for r in U.agents(org))
        print(f"budget check: no agent {a.agent!r} (ids: {ids})", file=sys.stderr)
        return 2

    budget = U.budget_for(row, org)
    tier = U.short_model(U.tier_of(row, org))
    data = U.scan(root, 1)
    if data.get("error"):
        print(f"budget check: {data['error']}", file=sys.stderr)
        return 2
    today = dt.datetime.now().strftime("%Y-%m-%d")
    slot = (data["by_seat"].get(seat) or {}).get(today)
    used = U.metric_total(slot, a.metric) if slot else 0
    need = used + a.reserve
    over = bool(budget) and need > budget

    out = {"seat": seat, "tier": tier, "day": today, "metric": a.metric,
           "used": used, "reserve": a.reserve, "budget": budget or None,
           "headroom": (budget - used) if budget else None,
           "over": over, "tier_policy": U.TIERS.get(tier, "")}
    if a.json:
        print(json.dumps(out, indent=2, ensure_ascii=False))
    elif not budget:
        print(f"{seat}: {used:,} {a.metric} tokens today · NO ceiling set in its roster file "
              f"(neither the seat nor defaults) - this gate cannot refuse")
    elif over:
        print(f"{seat}: OVER - {used:,} used"
              + (f" + {a.reserve:,} reserved" if a.reserve else "")
              + f" vs a {budget:,}/day ceiling ({need / budget * 100:.0f}%). "
                f"Do not start an unattended run.")
    else:
        print(f"{seat}: ok - {used:,}/{budget:,} {a.metric} tokens today "
              f"({used / budget * 100:.0f}%), {budget - need:,} headroom · tier {tier}")
    return 1 if over else 0


if __name__ == "__main__":
    sys.exit(main())
