"""Seat more UTC days of the 15m Up/Down decision table, in parallel (B-0684), at the default fill and at 250 ms (`--fill-ms 250`, key suffix -d250).

    python tf15_extend_days.py run --start 2026-09-02 --end 2026-09-15 [--ticks 4] [--ladders 3] [--seats 4] [--ladder-workers 1]
    python tf15_extend_days.py run --start 2026-10-08                      (no --end: every UTC day up to yesterday)
    python tf15_extend_days.py run --last 2                                (the scheduled form: the newest 2 UTC days that have closed)
    python tf15_extend_days.py status --start 2026-09-02 --end 2026-10-09  (what is in place for each day, nothing is run)

Per day, three stages in their own subprocesses (a crash in one day never touches another):
  1. Binance spot aggTrades of BTCUSDT ETHUSDT SOLUSDT XRPUSDT, stored and verified by `fundplat.data.crypto.ticks` (ensure_day, verify_day).
  2. The Polymarket ladder pin: `python -m fundplat.jobs.updown15_ladder run --start D --end D` (resumable, idempotent), retried on a failed hour.
  3. The table: `tf15_runner.py run D`, started as soon as 1 and 2 are in.
Stages 1 and 2 of every day run at once, bounded by three pools (--ticks, --ladders, --seats). A day whose table is seated is skipped, and a stage
whose output is stored is skipped (the probe reads the stored state, not the log). One JSON line a day is appended to
lab/research/data/extend-days-B-0684.jsonl. Run it from the studies folder with the fund venv. It stores nothing itself and deletes nothing.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLATFORM = HERE.parent.parent
PY = str(PLATFORM.parent / ".venv" / "Scripts" / "python.exe")
LOG = PLATFORM / "lab" / "research" / "data" / "extend-days-B-0684.jsonl"
SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT")
ASSETS = ("btc", "eth", "sol", "xrp")
FILL_D250 = 250                        # the owner (2026-10-10): every new day is also seated at a 250 ms fill (150 ms venue hold + 100 ms of ours)
ENV = {**os.environ, "PYTHONIOENCODING": "utf-8"}
_lock = threading.Lock()


def now_s() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def days_between(a: str, b: str) -> list[str]:
    d0, d1 = datetime.strptime(a, "%Y-%m-%d"), datetime.strptime(b, "%Y-%m-%d")
    return [(d0 + timedelta(days=i)).strftime("%Y-%m-%d") for i in range((d1 - d0).days + 1)]


def day_ms(day: str) -> int:
    return int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def sh(cmd: list[str], cwd: Path, timeout: int) -> dict:
    """Run a command, capture its output -> {code, out, err, seconds}; a timeout is code -9."""
    t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=str(cwd), env=ENV, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        return {"code": p.returncode, "out": p.stdout, "err": p.stderr, "seconds": round(time.time() - t0, 1)}
    except subprocess.TimeoutExpired as e:
        return {"code": -9, "out": "", "err": f"timeout after {timeout}s {str(e.stderr or '')[-300:]}", "seconds": round(time.time() - t0, 1)}


def last_json(text: str) -> dict | None:
    for ln in reversed([x for x in text.splitlines() if x.strip().startswith("{")]):
        try:
            return json.loads(ln)
        except ValueError:
            continue
    return None


# ---- the sub-modes that run inside a child process (they import fundplat.data) ----

def child_probe(days: list[str]) -> None:
    """Print {day: {seated, ticks: n of 4 stored, ladder_pending, ladder_markets}} as one JSON line."""
    import tf15_runner as R
    from fundplat.data.crypto import ticks
    from fundplat.data.predmkts import updown15, updown15_pin as pin
    import tf15_table as T
    from fundplat.data import derived
    keys = set(derived.keys(T.DATASET))
    out = {}
    for d in days:
        if R.key_of(d) in keys:
            out[d] = {"seated": True, "seated_d250": R.key_of(d, FILL_D250) in keys}
            continue
        rows = [r for r in updown15.markets(day_ms(d), day_ms(d) + 86_400_000, ASSETS) if r["start_ms"] is not None]
        pend = [r for r in rows if pin.meta_of(r["slug"], pin.day_of(r["start_ms"]), r["asset"]) is None]
        out[d] = {"seated": False, "seated_d250": R.key_of(d, FILL_D250) in keys, "ticks": sum(ticks.read_meta("spot", "aggTrades", s, d) is not None for s in SYMBOLS),
                  "ladder_markets": len(rows), "ladder_pending": len(pend)}
    print(json.dumps(out))


def child_ticks(day: str) -> int:
    """Store and verify the day's spot aggTrades for the four symbols. Exit 0 ok, 3 not published yet, 1 anything else."""
    from fundplat.data.crypto import ticks
    from venues.binance import bulk
    res = {}
    for s in SYMBOLS:
        try:
            ticks.ensure_day("spot", "aggTrades", s, day)
            v = ticks.verify_day("spot", "aggTrades", s, day)
            res[s] = {"rows": v["rows"], "id_missing": v["id_missing"], "checks": v["checks"]}
        except bulk.NotPublished as e:
            print(json.dumps({"ok": False, "not_published": True, "why": str(e)[:200], "symbol": s}))
            return 3
    print(json.dumps({"ok": True, "day": day, "symbols": res}))
    return 0


# ---- the parent ----

def stage_ticks(day: str, tries: int = 6) -> dict:
    r = {}
    for k in range(tries):
        r = sh([PY, str(HERE / "tf15_extend_days.py"), "_ticks", day], HERE, 1800)
        j = last_json(r["out"]) or {}
        if r["code"] == 0:
            return {"status": "ok", "seconds": r["seconds"], "tries": k + 1, "rows": {s: v["rows"] for s, v in j.get("symbols", {}).items()},
                    "id_missing": {s: v["id_missing"] for s, v in j.get("symbols", {}).items()}}
        if r["code"] == 3:
            return {"status": "not_published", "seconds": r["seconds"], "why": j.get("why")}
        time.sleep(60 * (k + 1))
    return {"status": "failed", "code": r["code"], "seconds": r["seconds"], "err": (r["err"] or r["out"])[-400:]}


def stage_ladder(day: str, workers: int, tries: int = 6) -> dict:
    t0, r, j = time.time(), {}, None
    for k in range(tries):
        r = sh([PY, "-m", "fundplat.jobs.updown15_ladder", "run", "--start", day, "--end", day, "--workers", str(workers)], PLATFORM, 4 * 3600)
        j = last_json(r["out"]) or {}
        if r["code"] == 0:
            d = (j.get("days") or {}).get(day) or {}
            return {"status": "ok", "seconds": round(time.time() - t0, 1), "tries": k + 1, "markets": d.get("markets"), "verify_checks": d.get("verify_checks"),
                    "hours_done": j.get("hours_done"), "hours_total": j.get("hours_total")}
        if any(v.get("status") in ("missing", "conflict") for v in (j.get("failed") or {}).values()):
            break                                  # an hour not published yet, or a pin conflict: a retry does not help
        time.sleep(60 * (k + 1))
    return {"status": "failed", "code": r.get("code"), "seconds": round(time.time() - t0, 1), "hours_failed": j.get("hours_failed") if j else None,
            "failed": {h: (v.get("status"), (v.get("error") or "")[:120]) for h, v in ((j or {}).get("failed") or {}).items()},
            "err": (r.get("err") or r.get("out") or "")[-400:]}


def _seat_one(day: str, fill_ms: int | None) -> dict:
    cmd = [PY, "tf15_runner.py", "run", day] + ([] if fill_ms is None else ["--fill-ms", str(fill_ms)])
    r = sh(cmd, HERE, 3600)
    j = last_json(r["out"]) or {}
    if r["code"] == 0 and "windows" in j:
        return {"status": "ok", "windows": j["windows"], "ok": j["ok"], "no_pin": j["no_pin"], "seconds": j["seconds"], "bytes": j["bytes"]}
    if r["code"] == 0 and "skipped" in r["out"]:
        return {"status": "already"}
    return {"status": "failed", "code": r["code"], "seconds": r["seconds"], "err": (r["err"] or r["out"])[-500:]}


def stage_seat(day: str, want=(None, FILL_D250)) -> dict:
    """Seat the day at the default fill and at 250 ms (two runner processes at once) -> the default's row with `d250` inside."""
    with ThreadPoolExecutor(len(want)) as ex:
        res = list(ex.map(lambda f: _seat_one(day, f), want))
    d250 = [r for f, r in zip(want, res) if f == FILL_D250]
    out = dict(res[0]) if want[0] is None else {"status": d250[0]["status"]}
    if d250:
        out["d250"] = d250[0]
        if d250[0]["status"] == "failed":
            out["status"] = "failed"
    return out


def append(row: dict) -> None:
    with _lock:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(row, sort_keys=True) + "\n")


def probe(days: list[str], tries: int = 40) -> dict:
    for k in range(tries):                      # another session may be mid-edit in a shared package: a SyntaxError is transient
        r = sh([PY, str(HERE / "tf15_extend_days.py"), "_probe", *days], HERE, 1800)
        j = last_json(r["out"])
        if r["code"] == 0 and j is not None:
            return j
        print(f"{now_s()} probe failed (code {r['code']}), try {k + 1}: {(r['err'] or r['out'])[-200:]}", flush=True)
        time.sleep(60)
    raise SystemExit("probe failed")


def run(days: list[str], n_ticks: int, n_ladders: int, n_seats: int, ladder_workers: int, seat_only: bool = False) -> list[dict]:
    state = probe(days)
    tp, lp, sp = ThreadPoolExecutor(n_ticks), ThreadPoolExecutor(n_ladders), ThreadPoolExecutor(n_seats)
    results: dict[str, dict] = {}

    def day_task(day: str) -> None:
        s = state[day]
        row = {"day": day, "started": now_s(), "probe": s}
        if s["seated"] and s["seated_d250"]:
            row.update(status="already_seated")
        elif s["seated"]:                              # the default table is in (this run or another): only the 250 ms one is missing
            row["seat"] = sp.submit(stage_seat, day, (FILL_D250,)).result()
            row["status"] = "seated" if row["seat"]["status"] in ("ok", "already") else "seat_failed"
        elif seat_only:
            row.update(status="not_ready")
        else:
            ft = tp.submit(stage_ticks, day) if s["ticks"] < len(SYMBOLS) else None
            fl = lp.submit(stage_ladder, day, ladder_workers) if s["ladder_pending"] or not s["ladder_markets"] else None
            row["ticks"] = ft.result() if ft else {"status": "in_place"}
            row["ladder"] = fl.result() if fl else {"status": "in_place", "markets": s["ladder_markets"]}
            print(f"{now_s()} {day} ticks {row['ticks']['status']} ladder {row['ladder']['status']}", flush=True)
            if row["ticks"]["status"] in ("ok", "in_place") and row["ladder"]["status"] in ("ok", "in_place"):
                row["seat"] = sp.submit(stage_seat, day).result()
                row["status"] = "seated" if row["seat"]["status"] in ("ok", "already") else "seat_failed"
            else:
                row["status"] = "waiting" if row["ticks"]["status"] == "not_published" else "not_seated"
        row["finished"] = now_s()
        results[day] = row
        if row["status"] != "not_ready":
            append(row)
        print(f"{now_s()} {day} {row['status']} {json.dumps(row.get('seat', ''))}", flush=True)

    with ThreadPoolExecutor(max(1, len(days))) as top:
        list(top.map(day_task, days))
    for p in (tp, lp, sp):
        p.shutdown()
    return [results[d] for d in days]


def summary(rows: list[dict]) -> str:
    out = [f"{'day':<11}{'status':<14}{'windows':>8}{'ok':>6}{'no_pin':>7}{'sec':>7}{'ok_d250':>9}  note"]
    for r in rows:
        s = r.get("seat") or {}
        note = ""
        if r["status"] not in ("seated", "already_seated", "not_ready"):
            note = "; ".join(f"{k}: {r[k].get('status')} {r[k].get('why') or r[k].get('err') or ''}"[:160] for k in ("ticks", "ladder", "seat")
                             if k in r and r[k].get("status") not in ("ok", "in_place", "already"))
        out.append(f"{r['day']:<11}{r['status']:<14}{s.get('windows', ''):>8}{s.get('ok', ''):>6}{s.get('no_pin', ''):>7}{s.get('seconds', ''):>7}{(s.get('d250') or {}).get('ok', ''):>9}  {note}")
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="tf15_extend_days")
    ap.add_argument("cmd", choices=["run", "status", "_probe", "_ticks"])
    ap.add_argument("rest", nargs="*")
    ap.add_argument("--start")
    ap.add_argument("--last", type=int, help="the newest N closed UTC days, ending yesterday (instead of --start)")
    ap.add_argument("--end", help="default: yesterday (UTC)")
    ap.add_argument("--ticks", type=int, default=4)
    ap.add_argument("--ladders", type=int, default=3)
    ap.add_argument("--seats", type=int, default=4)
    ap.add_argument("--ladder-workers", type=int, default=1)
    ap.add_argument("--seat-only", action="store_true", help="seat only the days whose inputs are in; run no ticks or ladder stage")
    a = ap.parse_args(argv)
    if a.cmd == "_probe":
        child_probe(a.rest)
        return 0
    if a.cmd == "_ticks":
        return child_ticks(a.rest[0])
    end = a.end or (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    start = a.start or (datetime.now(timezone.utc) - timedelta(days=a.last or 0)).strftime("%Y-%m-%d")
    if not a.start and not a.last:
        ap.error("give --start or --last")
    days = days_between(start, end)
    if a.cmd == "status":
        for d, s in probe(days).items():
            print(d, json.dumps(s))
        return 0
    rows = run(days, a.ticks, a.ladders, a.seats, a.ladder_workers, a.seat_only)
    print(summary(rows))
    return 0 if all(r["status"] in ("seated", "already_seated", "not_ready") for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
