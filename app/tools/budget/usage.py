#!/usr/bin/env python3
"""WHAT THIS FUND SPENT, per agent, per day - read off the transcripts.

Claude Code writes one JSONL per session under `%USERPROFILE%\\.claude\\projects
\\<slugged cwd>\\<session>.jsonl`. Every assistant row carries `cwd`, `timestamp`,
`message.model` and `message.usage`. That is the only first-hand record of what
was spent; everything else is an estimate.

ATTRIBUTION IS BY CWD, and that is a CHOICE with a consequence worth stating:
every agent in the roster (`app/agents/<id>.md`) boots in its own `cwd` (that is what gives it
its CLAUDE.md chain), so cwd -> agent is a real mapping, longest cwd winning. A
hand working from the fund root is attributed to the agent whose cwd is `.`,
and a sidechain (a subagent) is attributed to the cwd it inherited, with its
tokens ALSO counted separately so an agent cannot hide spend behind a subagent.
Agents that SHARE a cwd (the dashboards) cannot be told apart from a
transcript, so they are reported as ONE seat named `a+b+c`, never guessed.

THE METRIC IS NAMED, NEVER IMPLIED. Four counters exist and they are not
interchangeable: fresh input, cache CREATION (full price), cache READ (a tenth
of it), and output. The default budget metric is
`input + cache_creation + output` - the tokens genuinely processed at full
rate. `--metric all` adds cache reads; `--metric output` bills output alone.
A budget quoted without its metric is the same class of error as an annualized
rate quoted without its cadence.

    python app/tools/budget/usage.py                  # today, per agent
    python app/tools/budget/usage.py --days 7         # a week, per agent per day
    python app/tools/budget/usage.py --json
    python app/tools/budget/usage.py --no-health      # record no health reading

Records a health reading `system:budget` in the ops store (ops.health_readings,
through fund_db; unless --no-health) so the cockpit's Health wall shows spend
beside every other reading; the cockpit's spend view reads its `detail_json`.
Exit 0 always - `check.py` is the gate; this is the meter. A meter that
refuses is a meter people route around (a reading the store refuses is said
on stderr).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

METRICS = {
    "billable": ("input_tokens", "cache_creation_input_tokens", "output_tokens"),
    "all": ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
            "output_tokens"),
    "output": ("output_tokens",),
}

# The tiering policy this meter enforces. Documented in README.md; declared here
# so `usage.py --json` carries it and the cockpit needs no second source.
TIERS = {
    "haiku": "mechanical probes, digests, staleness sweeps, schedule jobs with no judgment",
    "sonnet": "the dashboard agents - routes, UI, fixture work",
    "opus": "quant, research, retros and law - anything that moves a belief or writes a rule",
}




def _load_root():
    """app/tools/_root.py, loaded by path (no sys.path edit): the one fund_root() and layout."""
    import importlib.util
    path = Path(__file__).resolve().parent.parent / "_root.py"
    spec = importlib.util.spec_from_file_location("fund_tools_root", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_ROOT = _load_root()


def fund_root() -> Path:
    return _ROOT.fund_root()


def projects_dir() -> Path:
    env = os.environ.get("CLAUDE_PROJECTS_DIR")
    if env:
        return Path(env)
    home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    return Path(home) / ".claude" / "projects"


def load_org(root: Path) -> dict:
    """The agent roster as one document, {"agents": [header, ...]}: every app/agents/<id>.md
    header (app/tools/_root.py agents(); the root agents.json until 2026-09-25,
    spine/agents.json before, org.json until 2026-09-24; the name stays for its callers).
    An empty roster (no app/agents/, or no file that parses) is {}."""
    rows = _ROOT.agents(root)
    return {"agents": rows} if rows else {}


def agents(org: dict) -> list[dict]:
    return [a for a in org.get("agents", []) if isinstance(a, dict) and a.get("id")]


def _norm(cwd) -> str:
    return str(cwd or ".").replace("\\", "/").strip("/") or "."


def seat_index(org: dict, root: Path) -> tuple[list[tuple[str, str]], dict]:
    """[(cwd, seat_id)] longest-first, plus {seat_id: row}.

    One seat per distinct cwd. Agents sharing a cwd become one seat whose id
    joins theirs with `+` and whose row carries `members`: a transcript cannot
    say which of them spoke, and splitting the spend by guess would be an
    invented number."""
    by_cwd: dict[str, list[dict]] = {}
    for row in agents(org):
        by_cwd.setdefault(_norm(row.get("cwd")), []).append(row)
    seats, pairs = {}, []
    for cwd, rows in by_cwd.items():
        if len(rows) == 1:
            sid, row = rows[0]["id"], dict(rows[0])
        else:
            sid = "+".join(r["id"] for r in rows)
            models = {r.get("model") for r in rows if r.get("model")}
            budgets = [r.get("budgetTokensPerDay") for r in rows]
            row = {"id": sid, "cwd": cwd, "members": [r["id"] for r in rows],
                   "model": models.pop() if len(models) == 1 else ""}
            if all(budgets):
                row["budgetTokensPerDay"] = sum(int(b) for b in budgets)
        row["cwd"] = cwd
        seats[sid] = row
        pairs.append((cwd, sid))
    pairs.sort(key=lambda p: -len(p[0]))
    return pairs, seats


def attribute(cwd: str, root: Path, pairs) -> str:
    """cwd -> seat id. Longest agent cwd wins; the root (`.`) seat takes the rest."""
    try:
        rel = Path(cwd).resolve().relative_to(root.resolve()).as_posix()
    except (ValueError, OSError):
        return ""
    for cwd, sid in pairs:
        if cwd == ".":
            continue
        if rel == cwd or rel.startswith(cwd + "/"):
            return sid
    for cwd, sid in pairs:
        if cwd == ".":
            return sid
    return "unassigned"


def under_fund(cwd: str, root: Path) -> bool:
    if not cwd:
        return False
    try:
        c = str(Path(cwd).resolve()).lower()
    except OSError:
        return False
    r = str(root.resolve()).lower()
    return c == r or c.startswith(r.rstrip("\\/") + os.sep)


def scan(root: Path, days: int) -> dict:
    """{seat: {day: {counters, models, sessions}}} plus totals."""
    pairs, seats = seat_index(load_org(root), root)
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=max(1, days))
    out: dict = {}
    files = sessions = rows = 0
    pdir = projects_dir()
    if not pdir.is_dir():
        return {"error": f"no transcripts at {pdir}", "by_seat": {}, "files": 0}

    for f in pdir.rglob("*.jsonl"):
        files += 1
        try:
            mtime = dt.datetime.fromtimestamp(f.stat().st_mtime, dt.timezone.utc)
        except OSError:
            continue
        if mtime < cutoff - dt.timedelta(days=2):
            continue        # a session file untouched since before the window
        hit = False
        with open(f, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line or '"usage"' not in line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("type") != "assistant":
                    continue
                cwd = r.get("cwd") or ""
                if not under_fund(cwd, root):
                    continue
                usage = (r.get("message") or {}).get("usage") or {}
                ts = r.get("timestamp") or ""
                try:
                    when = dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except ValueError:
                    continue
                if when < cutoff:
                    continue
                hit = True
                rows += 1
                seat = attribute(cwd, root, pairs) or "unassigned"
                day = when.astimezone().strftime("%Y-%m-%d")     # the owner's day
                slot = out.setdefault(seat, {}).setdefault(day, {
                    "input_tokens": 0, "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0, "output_tokens": 0,
                    "messages": 0, "sidechain_messages": 0, "models": {}, "sessions": set()})
                for k in ("input_tokens", "cache_creation_input_tokens",
                          "cache_read_input_tokens", "output_tokens"):
                    slot[k] += int(usage.get(k) or 0)
                slot["messages"] += 1
                if r.get("isSidechain"):
                    slot["sidechain_messages"] += 1
                model = str((r.get("message") or {}).get("model") or "?")
                slot["models"][model] = slot["models"].get(model, 0) + 1
                slot["sessions"].add(r.get("sessionId") or f.stem)
        if hit:
            sessions += 1

    for seat, byday in out.items():
        for day, slot in byday.items():
            slot["sessions"] = len(slot["sessions"])
    return {"by_seat": out, "files": files, "sessions": sessions, "rows": rows,
            "seats": seats}


def metric_total(slot: dict, metric: str) -> int:
    return sum(int(slot.get(k, 0)) for k in METRICS[metric])


def budget_for(seat_row: dict, org: dict) -> int:
    d = org.get("defaults") or {}
    return int(seat_row.get("budgetTokensPerDay") or d.get("budgetTokensPerDay") or 0)


def tier_of(seat_row: dict, org: dict) -> str:
    return str(seat_row.get("model") or (org.get("defaults") or {}).get("model") or "sonnet")


def short_model(m: str) -> str:
    m = m.lower()
    for t in ("opus", "sonnet", "haiku"):
        if t in m:
            return t
    return m[:14]


def health_obj(status: str, reading: str, detail: str, extra: dict) -> dict:
    obj = {"id": "budget", "label": "token budget per agent per day", "owner": ".",
           "status": status, "reading": reading[:200], "probed_ts": int(time.time()),
           "window_s": 26 * 3600, "detail": detail[:600]}
    obj.update(extra)
    return obj


def write_health(root: Path, status: str, reading: str, detail: str, extra: dict) -> None:
    """Record the reading in the ops store (probe_id system:budget, target system), through
    fund_db. A store that refuses it is said on stderr, never silently dropped."""
    obj = health_obj(status, reading, detail, extra)
    try:
        from fund_db import ops
        ops.record_health("system:budget", "system", obj["status"], obj["reading"], obj, obj["probed_ts"] * 1000)
    except Exception as e:  # noqa: BLE001 - the meter still prints its table
        print(f"usage: the budget reading could not be recorded in the ops store: {type(e).__name__}: {e}",
              file=sys.stderr)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--days", type=int, default=1)
    ap.add_argument("--metric", default="billable", choices=sorted(METRICS))
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--no-health", action="store_true")
    a = ap.parse_args(argv)

    root = fund_root()
    org = load_org(root)
    data = scan(root, a.days)
    if data.get("error"):
        print(f"usage: {data['error']}", file=sys.stderr)
        if not a.no_health:
            write_health(root, "unknown", "no transcripts found", data["error"], {})
        return 0

    today = dt.datetime.now().strftime("%Y-%m-%d")
    seats = data["seats"]
    table = []
    over = []
    tier_drift = []
    for seat, byday in sorted(data["by_seat"].items()):
        row = seats.get(seat, {})
        budget = budget_for(row, org)
        declared = short_model(tier_of(row, org))
        for day, slot in sorted(byday.items()):
            used = metric_total(slot, a.metric)
            models = sorted(slot["models"], key=lambda m: -slot["models"][m])
            seen = short_model(models[0]) if models else "?"
            pct = (used / budget * 100) if budget else None
            table.append({
                "seat": seat, "day": day, "used": used, "budget": budget,
                "pct": None if pct is None else round(pct, 1),
                "metric": a.metric, "messages": slot["messages"],
                "sidechain_messages": slot["sidechain_messages"],
                "sessions": slot["sessions"], "declared_tier": declared,
                "models_seen": {short_model(m): n for m, n in slot["models"].items()},
                "input": slot["input_tokens"],
                "cache_creation": slot["cache_creation_input_tokens"],
                "cache_read": slot["cache_read_input_tokens"],
                "output": slot["output_tokens"],
            })
            if budget and used > budget and day == today:
                over.append(f"{seat} {used:,}/{budget:,}")
            if seen != "?" and declared and seen != declared:
                tier_drift.append(f"{seat} declares {declared}, ran {seen} ({day})")

    today_rows = [t for t in table if t["day"] == today]
    total_today = sum(t["used"] for t in today_rows)
    reading = (f"{total_today:,} {a.metric} tokens today across {len(today_rows)} seat(s)"
               + (f" · OVER BUDGET: {'; '.join(over)}" if over else ""))
    if not a.no_health:
        write_health(root, "fail" if over else "ok", reading,
                     ("tier drift: " + "; ".join(sorted(set(tier_drift))[:4])) if tier_drift
                     else f"metric={a.metric} ({' + '.join(METRICS[a.metric])})",
                     {"metric": a.metric, "total_today": total_today,
                      "by_seat_today": {t["seat"]: t["used"] for t in today_rows},
                      "over_budget": over, "tier_drift": sorted(set(tier_drift))[:10],
                      "tiers": TIERS})

    if a.json:
        print(json.dumps({"metric": a.metric, "metric_parts": METRICS[a.metric],
                          "days": a.days, "today": today, "rows": table,
                          "over_budget": over, "tier_drift": sorted(set(tier_drift)),
                          "tiers": TIERS, "scanned": {"files": data["files"],
                                                      "sessions": data["sessions"],
                                                      "rows": data["rows"]}}, indent=2))
        return 0

    print(f"token usage · metric `{a.metric}` = {' + '.join(METRICS[a.metric])}")
    print(f"scanned {data['files']} transcript file(s); {data['sessions']} touched this tree; "
          f"{data['rows']} assistant row(s) in window")
    if not table:
        print("\nnothing attributable to this tree in the window. That is a real reading, "
              "not an error - no agent has worked here yet.")
        return 0
    print(f"\n{'day':11} {'seat':22} {'tier':7} {'models seen':18} {'used':>12} "
          f"{'budget':>12} {'%':>6}  msgs")
    for t in table:
        pct = f"{t['pct']:.0f}%" if t["pct"] is not None else "-"
        seen = ",".join(f"{k}x{v}" for k, v in t["models_seen"].items())[:18]
        print(f"{t['day']:11} {t['seat']:22} {t['declared_tier']:7} {seen:18} "
              f"{t['used']:>12,} {t['budget']:>12,} {pct:>6}  {t['messages']}"
              + (f" (+{t['sidechain_messages']} sub)" if t["sidechain_messages"] else ""))
    print(f"\ntoday: {total_today:,} {a.metric} tokens")
    if over:
        print("OVER BUDGET: " + "; ".join(over))
    for d in sorted(set(tier_drift))[:6]:
        print(f"tier drift: {d}")
    print("\ncache reads are excluded from `billable` (they bill at ~a tenth); "
          "`--metric all` includes them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
