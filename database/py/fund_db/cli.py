"""python -m fund_db <command> - the data layer's one command line.

    pg <install|init|start|stop|status|ensure>   the portable PostgreSQL (fund_db.cluster)
    migrate [--status]                           apply pending migrations (or list them)
    doctor [--json]                              every check the layer depends on; exit 1 on any FAIL
    usage [--json] [--no-rows]                   space per dataset and tier, plus the ops store
    tier  [--dataset D] [--apply] [--json]       hot -> cold past tier_after_days (dry run by default)
    prune [--dataset D] [--apply] [--json]       -> _retired past keep_days (dry run by default)
    schema --write | --check                     regenerate / check schema/, ops/rows.py, node/src/rows.ts
    import-cockpit --sqlite PATH [--replace]     carry cockpit.db into the ops schema, verified
    backup [--dir D] [--keep N] | --list [--json]   pg_dump of the ops database, verified; newest N kept
    cache --usage | --evict [--to BYTES] [--dry-run] | --clean [--idle-days N] [--dry] | --reclassify [--apply]  [--json]
                                                 the 500 MB cache: usage, eviction (least-recently-read
                                                 month first), the weekly clean + three-size report,
                                                 the lake's move into its storage classes
    pins [--ref R] [--json]                      the pin index (content-addressed, immutable rows)
    pins --retire-scratch [--apply] [--json]     probe:/test: pins -> _retired/pins (plan without --apply)
    pacer [--json]                               the per-venue request budgets and their state
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import config


def _mb(b: int | None) -> str:
    return "-" if b is None else f"{b / 1e6:,.1f} MB"


def cmd_migrate(a) -> int:
    from . import migrate
    from .db import connect
    if a.status:
        with connect(a.dsn) as c:
            p = migrate.plan(c)
        for m in p["applied"]:
            print(f"  applied  {m.track}/{m.file}")
        for m in p["pending"]:
            print(f"  PENDING  {m.track}/{m.file}")
        for d in p["drift"]:
            print(f"  DRIFT    {d['track']}/{d['file']} (ledger {d['ledger_sha256'][:12]}, file {d['file_sha256'][:12]})")
        for u in p["unknown"]:
            print(f"  UNKNOWN  {u['track']}/{u['file']} is in the ledger but not on disk")
        return 1 if p["drift"] else 0
    done = migrate.migrate(a.dsn)
    print(f"[migrate] {len(done)} applied" if done else "[migrate] up to date")
    return 0


def doctor_checks() -> list[dict]:
    """[{check, status: ok|warn|fail, detail}] - each one says what it actually tested."""
    from . import cluster
    out: list[dict] = []

    def add(check, status, detail):
        out.append({"check": check, "status": status, "detail": detail})

    root = config.data_dir()
    add("data root outside git", "fail" if any((p / ".git").exists() for p in [root, *root.parents]) else "ok",
        f"{root} (no .git in it or any parent)")
    add("binaries", "ok" if cluster.installed() else "fail", str(config.pg_bin_dir()))
    add("cluster initialised", "ok" if cluster.initialised() else "fail", str(config.pgdata_dir()))
    hba = config.pgdata_dir() / "pg_hba.conf"
    if hba.exists():
        rules = [" ".join(ln.split()) for ln in hba.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
        add("pg_hba 127.0.0.1 trust only", "ok" if rules == ["host all all 127.0.0.1/32 trust"] else "fail",
            f"{len(rules)} rule(s): {rules}")
    s = config.settings()
    up = cluster.running()
    add("server running", "ok" if up else "fail", f"127.0.0.1:{s['port']}")
    conn = None
    if up:
        try:
            from .db import connect
            conn = connect(autocommit=True)
            v = conn.execute("SHOW server_version").fetchone()["server_version"]
            la = conn.execute("SHOW listen_addresses").fetchone()["listen_addresses"]
            add("connect", "ok", f"PostgreSQL {v} as {s['user']}@{s['database']}")
            add("listens on 127.0.0.1 only", "ok" if la == "127.0.0.1" else "fail", f"listen_addresses = {la!r}")
        except Exception as e:
            add("connect", "fail", str(e).strip())
    if conn is not None:
        from . import migrate
        try:
            p = migrate.plan(conn)
            st = "fail" if p["drift"] else ("warn" if p["pending"] or p["unknown"] else "ok")
            add("migrations", st, f"{len(p['applied'])} applied, {len(p['pending'])} pending, {len(p['drift'])} drifted, "
                                  f"{len(p['unknown'])} in the ledger but not on disk")
        except Exception as e:
            add("migrations", "fail", str(e))
        try:
            from . import schema
            stale = schema.stale(conn)
            add("generated schema files current", "ok" if not stale else "warn",
                "match the database" if not stale else f"stale: {[str(x.relative_to(config.repo_root())) for x in stale]}")
        except Exception as e:
            add("generated schema files current", "warn", str(e))
        conn.close()
    try:
        from . import lake
        lake.reset()
        vs = lake.views()
        err = lake.pg_error()
        add("duckdb + lake views", "ok", f"{len(vs)} view(s): {', '.join(vs) or 'none (empty lake)'}")
        add("duckdb attaches postgres", "ok" if err is None else ("fail" if up else "warn"),
            "pg attached read-only" if err is None else err)
    except Exception as e:
        add("duckdb + lake views", "fail", str(e))
    try:
        from .market import retention as mret
        rules = mret.load()
        add("retention.toml", "ok", f"{len(rules)} dataset rule(s) from {config.retention_path()}, "
                                    f"[cache] max_bytes {mret.cache_max_bytes():,}")
    except ImportError as e:
        add("retention.toml", "warn", f"fund_db.market not importable: {e}")
    except Exception as e:
        add("retention.toml", "fail", str(e))
    out += storage_checks(up)
    return out


def storage_checks(pg_up: bool = True) -> list[dict]:
    """The storage-class properties (B-0322), each tested on the disk as it is now."""
    out: list[dict] = []

    def add(check, status, detail):
        out.append({"check": check, "status": status, "detail": detail})
    try:
        from .market import blobstore as blobs_mod, cache, pinning, storage
    except ImportError as e:
        add("storage classes", "warn", f"fund_db.market not importable: {e}")
        return out
    try:
        u = cache.cache_usage()
        add("cache within budget", "fail" if u["over_budget"] else "ok",
            f"{u['bytes']:,} of {u['max_bytes']:,} bytes in {u['partitions']} month(s) under {u['root']}")
    except Exception as e:
        add("cache within budget", "fail", str(e))
        u = {"partitions": "?"}
    try:
        decl = storage.declarations(refresh=True)
        arch = cache.archive_in_cache()
        add("no archive series in the cache", "fail" if arch else "ok",
            f"{len(arch)} cache month(s) hold an archive series: {arch[:3]}" if arch else
            f"0 of {u['partitions']} cache month(s), against {len(decl)} archive declaration(s)")
    except Exception as e:
        add("no archive series in the cache", "fail" if pg_up else "warn", f"declarations unreadable: {e}")
    try:
        pc = pinning.check()
        bad = pc["missing"] + pc["size_mismatch"]
        add("pins intact", "fail" if bad else "ok",
            f"{pc['pins']} pin(s), {len(pc['missing'])} file(s) missing, "
            f"{len(pc['size_mismatch'])} size mismatch(es)" + (f": {bad[:3]}" if bad else ""))
    except Exception as e:
        add("pins intact", "fail" if pg_up else "warn", f"pin index unreadable: {e}")
    try:
        bc = blobs_mod.check()
        bad = bc["missing"] + bc["size_mismatch"]
        add("blobs intact", "fail" if bad else "ok",
            f"{bc['blobs']} blob(s), {bc['bytes']:,} bytes, {len(bc['missing'])} file(s) missing, "
            f"{len(bc['size_mismatch'])} size mismatch(es)" + (f": {bad[:3]}" if bad else ""))
    except Exception as e:
        add("blobs intact", "fail" if pg_up else "warn", f"blob index unreadable: {e}")
    return out


def cmd_doctor(a) -> int:
    checks = doctor_checks()
    if a.json:
        print(json.dumps(checks, indent=2))
    else:
        for c in checks:
            print(f"  {c['status'].upper():4}  {c['check']}: {c['detail']}")
    return 1 if any(c["status"] == "fail" for c in checks) else 0


def ops_usage() -> dict:
    try:
        from .db import connect
        with connect(autocommit=True) as c:
            db_bytes = c.execute("SELECT pg_database_size(current_database()) AS b").fetchone()["b"]
            tables = c.execute(
                "SELECT n.nspname || '.' || c.relname AS name, pg_total_relation_size(c.oid) AS bytes, "
                "GREATEST(c.reltuples, 0)::bigint AS est_rows FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 2 DESC, 1").fetchall()
        return {"database_bytes": db_bytes, "tables": tables}
    except Exception as e:
        return {"error": str(e).strip()}


def cmd_usage(a) -> int:
    from .market import retention as mret
    lake = mret.usage(rows=not a.no_rows)
    ops = ops_usage()
    if a.json:
        print(json.dumps({"lake": lake, "ops": ops}, indent=2, default=str))
        return 0
    print(f"data root {config.data_dir()}")
    for d in lake["datasets"]:
        rows = "" if d["rows"] is None else f", {d['rows']:,} rows"
        print(f"  {d['dataset']:<11} {d['tier']:<4} {_mb(d['bytes']):>12}  {d['partitions']} partitions, {d['files']} files{rows}, "
              f"{d['first_month']}..{d['last_month']}")
    for o in lake["other"]:
        print(f"  {o['name']:<16} {_mb(o['bytes']):>12}  {o['files']} files")
    print(f"  lake total {_mb(lake['total_bytes'])}")
    if "error" in ops:
        print(f"  ops store: unavailable ({ops['error']})")
    else:
        print(f"  ops store {_mb(ops['database_bytes'])} in {len(ops['tables'])} tables")
    return 0


def _refuse_move(kind: str, dataset: str | None) -> None:
    """An unknown dataset, or a prune named on an ARCHIVE dataset, is refused before anything is
    planned (the library would return an empty plan for the second, which reads as all-clear)."""
    from .market import retention as mret
    from .market.registry import DATASETS
    if dataset is None:
        return
    if dataset not in DATASETS:
        raise mret.RetentionError(f"unknown dataset {dataset!r}; known: {', '.join(sorted(DATASETS))}")
    if kind == "prune" and DATASETS[dataset].archive:
        raise mret.RetentionError(f"{dataset} is an ARCHIVE dataset: settled history is never pruned")


def cmd_move(a) -> int:
    """tier / prune. With --json the LAST stdout line is one object: {ok, kind, dataset, apply,
    items, total_bytes}, items as fund_db.market.tier/prune return them; a refusal or a failure is
    {ok: false, status, error, ...} with exit 1 (status 400: the rule refuses the input, a
    RetentionError; 500: anything else, the store broke), and an apply that stopped part-way still
    lists the partitions that already moved (status 500)."""
    from .market import retention as mret
    items: list[dict] = []
    err = None
    status = 500                         # a RetentionError mid-run (a destination that differs) is a failure too
    try:
        try:
            _refuse_move(a.cmd, a.dataset)
        except mret.RetentionError:
            status = 400                 # the rule forbids what was asked
            raise
        status = 500
        for it in mret.moves(a.cmd, a.dataset, a.apply):
            items.append(it)
            if not a.json:
                print(f"  {'MOVED' if a.apply else 'would move'} {it['from']} -> {it['to']} ({_mb(it['bytes'])})")
    except Exception as e:
        if not a.json:
            raise
        err = f"{type(e).__name__}: {e}"
    if a.json:
        out = {"ok": err is None, "kind": a.cmd, "dataset": a.dataset, "apply": a.apply, "items": items,
               "total_bytes": sum(int(it["bytes"]) for it in items)}
        if err is not None:
            out["status"] = status
            out["error"] = err
        print(json.dumps(out, default=str))
        return 0 if err is None else 1
    print(f"[{a.cmd}] {len(items)} partition(s){'' if a.apply else ' (dry run; --apply to move)'}")
    return 0


def cmd_schema(a) -> int:
    from . import schema
    from .db import connect
    with connect(a.dsn, autocommit=True) as c:
        if a.write:
            changed = schema.write(c)
            print(f"[schema] wrote {len(changed)} file(s): {[str(p) for p in changed]}" if changed else "[schema] current")
            return 0
        stale = schema.stale(c)
    if stale:
        print(f"[schema] STALE: {[str(p) for p in stale]} - run `python -m fund_db schema --write`")
        return 1
    print("[schema] current")
    return 0


def cmd_import(a) -> int:
    from .importer import import_cockpit
    r = import_cockpit(Path(a.sqlite), dsn=a.dsn, replace=a.replace)
    print(f"[import] {'OK' if r['ok'] else 'FAILED'}: {r['rows']:,} rows in {len(r['tables'])} tables, verified, "
          f"{r['seconds']} s; report {r['report_path']}")
    return 0 if r["ok"] else 1


def cmd_backup(a) -> int:
    from . import backup
    d = Path(a.dir) if a.dir else None
    if a.list:
        files = backup.list_backups(d)
        if a.json:
            print(json.dumps({"dir": str(d or backup.backup_dir()), "files": files}))
        else:
            for f in files:
                print(f"  {f['file']}  {_mb(f['bytes'])}")
            print(f"[backup] {len(files)} kept in {d or backup.backup_dir()}")
        return 0
    r = backup.backup(d, keep=a.keep)
    print(f"[backup] {r['file']}: {r['bytes'] / 1048576:.1f} MB via {r['method']}, {r['tables']} tables, check {r['check']}, "
          f"{r['took_ms']} ms" + (f", pruned {' '.join(r['pruned'])}" if r["pruned"] else ""))
    return 0


def _cache_clean(a) -> int:
    """cache --clean: the weekly run. Exit 0 ok, 1 fail; --json prints ONE object on the last stdout
    line whose keys are fixed (ok, error, evicted_months, evicted_bytes, kept_months, after_bytes,
    budget_bytes, refused_months, idle_days, dry, before_bytes, cache_bytes, pins, pins_bytes, blobs,
    blobs_bytes, archive_bytes,
    files_bytes, ops_bytes, evicted, refused); a failure to run at all prints {ok: false, error}."""
    from .market import cache
    a.dry = a.dry or a.dry_run                 # --dry-run (the --evict spelling) is accepted too
    try:
        r = cache.clean(idle_days=a.idle_days, apply=not a.dry)
    except Exception as e:
        r = {"ok": False, "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(r) if a.json else f"[cache --clean] FAILED: {r['error']}")
        return 1
    if a.json:
        print(json.dumps(r, default=str))
    else:
        verb = "would evict" if a.dry else "EVICTED"
        for e in r["evicted"]:
            print(f"  {verb} {e['dataset']} {e['venue']} {e['interval']} {e['month']} "
                  f"({_mb(e['bytes'])}, last read {e['last_read_ms']})")
        for e in r["refused"]:
            print(f"  REFUSED {e['dataset']} {e['venue']} {e['interval']} {e['month']}: {e['why']}")
        ops = "unavailable" if r["ops_bytes"] is None else _mb(r["ops_bytes"])
        print(f"[cache --clean{' --dry' if a.dry else ''}] idle > {r['idle_days']}d: {verb} {r['evicted_months']} "
              f"month(s), {_mb(r['evicted_bytes'])}; kept {r['kept_months']}; cache {_mb(r['before_bytes'])} -> "
              f"{_mb(r['after_bytes'])} of {_mb(r['budget_bytes'])}")
        print(f"  sizes: cache {_mb(r['cache_bytes'])} | pins {_mb(r['pins_bytes'])} ({r['pins']}) | "
              f"blobs {_mb(r['blobs_bytes'])} ({r['blobs']}) | archive {_mb(r['archive_bytes'])} | _files {_mb(r['files_bytes'])} | ops store {ops}")
        if not r["ok"]:
            print(f"  FAIL: {r['error']}")
    return 0 if r["ok"] else 1


def cmd_cache(a) -> int:
    """cache --usage | --evict | --clean | --reclassify; --json prints ONE object on the last stdout line."""
    from .market import cache
    if a.clean:
        return _cache_clean(a)
    if a.evict:
        r = cache.evict(a.to, apply=not a.dry_run)
        if not a.json:
            verb = "EVICTED" if r["apply"] else "would evict"
            for e in r["evicted"]:
                print(f"  {verb} {e['dataset']} {e['venue']} {e['interval']} {e['month']} "
                      f"({_mb(e['bytes'])}, last read {e['last_read_ms']})")
            for e in r["refused"]:
                print(f"  REFUSED {e['dataset']} {e['venue']} {e['interval']} {e['month']}: {e['why']}")
            tail = "" if r["apply"] else " - dry run"
            print(f"[cache] {_mb(r['before_bytes'])} -> {_mb(r['after_bytes'])} (to {_mb(r['to_bytes'])}){tail}")
    elif a.reclassify:
        r = cache.reclassify(apply=a.apply, dataset=a.dataset)
        if not a.json:
            for k in ("to_cache", "to_lake", "kept"):
                for e in r[k]:
                    why = f" - {e['why']}" if e.get("why") else ""
                    print(f"  {k:<8} {e['dataset']} {e['venue']} {e['interval']} {e['month']} {_mb(e['bytes'])}{why}")
            tail = "" if a.apply else " (dry run; --apply to move)"
            print(f"[reclassify] {len(r['to_cache'])} month(s) to the cache, {len(r['to_lake'])} to the lake, "
                  f"{len(r['kept'])} kept{tail}")
    else:
        r = cache.cache_usage()
        if not a.json:
            over = " - OVER BUDGET" if r["over_budget"] else ""
            print(f"cache {r['root']}: {_mb(r['bytes'])} of {_mb(r['max_bytes'])} in {r['partitions']} month(s){over}")
            for d in r["datasets"]:
                print(f"  {d['dataset']:<14} {_mb(d['bytes']):>12}  {d['partitions']} month(s), {d['files']} files")
    if a.json:
        print(json.dumps(r, default=str))
    return 0


def cmd_pins(a) -> int:
    from .market import pinning as pins
    if a.retire_scratch:
        r = pins.retire_scratch(apply=a.apply)
        if a.json:
            print(json.dumps(r, default=str))
        else:
            for k in ("retire", "unref", "skipped"):
                for x in r[k]:
                    print(f"  {k:<7} {x['hash'][:16]}  {x['dataset']} {x['venue']} {x['symbol']}  refs {x['refs']}")
            print(f"[pins] {'applied' if a.apply else 'plan'}: {len(r['retire'])} retire, {len(r['unref'])} unref, "
                  f"{len(r['skipped'])} skipped; pins {r['pins_before']} -> {r['pins_after']}")
        return 0
    if a.blobs:
        from .market import blobstore as blobs_mod
        rows = blobs_mod.blobs(dataset=a.dataset, ref=a.ref)
        chk = blobs_mod.check(verify=a.verify)
        if a.json:
            print(json.dumps({"blobs": rows, "check": chk}, default=str))
        else:
            for r in rows:
                refs = [x["ref"] for x in r["refs"]]
                print(f"  {r['hash'][:16]}  {r['dataset']} {r['key']}  {r['bytes']:,} bytes  refs {refs}")
            print(f"[blobs] {len(rows)}; {chk['bytes']:,} bytes; {len(chk['missing'])} missing, "
                  f"{len(chk['size_mismatch'])} size mismatch, {len(chk['hash_mismatch'])} hash mismatch"
                  + (" (re-hashed)" if a.verify else ""))
        bad = chk["missing"] or chk["size_mismatch"] or chk["hash_mismatch"]
        return 1 if bad else 0
    rows = pins.pins(ref=a.ref)
    if a.json:
        print(json.dumps(rows, default=str))
        return 0
    for r in rows:
        refs = [x["ref"] for x in r["refs"]]
        print(f"  {r['hash'][:16]}  {r['dataset']} {r['venue']} {r['symbol']} {r['interval']}  "
              f"{r['rows']:,} rows  refs {refs}")
    print(f"[pins] {len(rows)}")
    return 0


def cmd_pacer(a) -> int:
    from . import pacer
    rows = pacer.status()
    if a.json:
        print(json.dumps(rows, default=str))
        return 0
    for r in rows:
        blocked = f", blocked until {r['blocked_until_ms']} ({r['reason']})" if r["blocked_until_ms"] else ""
        print(f"  {r['venue']:<14} {r['tokens']:.1f}/{r['capacity']:.0f} tokens, +{r['refill_per_s']}/s"
              f"{blocked}  [{r['source']}]")
    print(f"[pacer] {len(rows)} paced venue(s)")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["pg"]:
        from .cluster import main as pg_main
        return pg_main(argv[1:])
    ap = argparse.ArgumentParser(prog="python -m fund_db", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("pg", help="the portable PostgreSQL: install|init|start|stop|status|ensure")
    m = sub.add_parser("migrate")
    m.add_argument("--status", action="store_true")
    m.add_argument("--dsn")
    d = sub.add_parser("doctor")
    d.add_argument("--json", action="store_true")
    u = sub.add_parser("usage")
    u.add_argument("--json", action="store_true")
    u.add_argument("--no-rows", action="store_true", help="skip reading Parquet footers for row counts")
    for name in ("tier", "prune"):
        t = sub.add_parser(name)
        t.add_argument("--dataset")
        t.add_argument("--apply", action="store_true")
        t.add_argument("--json", action="store_true", help="one JSON object on the last stdout line")
    s = sub.add_parser("schema")
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--write", action="store_true")
    g.add_argument("--check", action="store_true")
    s.add_argument("--dsn")
    i = sub.add_parser("import-cockpit")
    i.add_argument("--sqlite", required=True)
    i.add_argument("--replace", action="store_true")
    i.add_argument("--dsn")
    b = sub.add_parser("backup")
    b.add_argument("--dir")
    b.add_argument("--keep", type=int, default=14)
    b.add_argument("--list", action="store_true")
    b.add_argument("--json", action="store_true")
    c = sub.add_parser("cache", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=(
        "--clean --json prints ONE object on the last stdout line, keys: ok, error, evicted_months, "
        "evicted_bytes, kept_months, before_bytes, after_bytes, budget_bytes, refused_months, idle_days, "
        "dry, cache_bytes, pins (count), pins_bytes, blobs (count), blobs_bytes, archive_bytes, files_bytes, ops_bytes (null when "
        "Postgres is down), evicted[], refused[]. Exit 0 ok (a dry run included); 1 failed to run or "
        "still over budget ({ok: false, error})."))
    cg = c.add_mutually_exclusive_group()
    cg.add_argument("--usage", action="store_true", help="what the cache holds against its budget (the default)")
    cg.add_argument("--evict", action="store_true", help="evict least-recently-read months down to --to (default max_bytes)")
    cg.add_argument("--clean", action="store_true", help="the weekly clean: evict months idle for --idle-days, then to the budget; reports cache/pins/archive sizes")
    cg.add_argument("--reclassify", action="store_true", help="plan (or --apply) the lake's move into its storage classes")
    c.add_argument("--to", type=int, help="with --evict: down to this many bytes")
    c.add_argument("--dry-run", action="store_true", help="with --evict: the plan only")
    c.add_argument("--idle-days", type=int, default=14, help="with --clean: evict months nobody read or wrote in this many days (default 14)")
    c.add_argument("--dry", action="store_true", help="with --clean: the plan only, nothing is deleted")
    c.add_argument("--apply", action="store_true", help="with --reclassify: move (refused while no pin exists)")
    c.add_argument("--dataset", help="with --reclassify: one dataset")
    c.add_argument("--json", action="store_true", help="one JSON object on the last stdout line")
    pn = sub.add_parser("pins")
    pn.add_argument("--ref")
    pn.add_argument("--blobs", action="store_true", help="the blob seat's index (pinned bytes under a registered seat) instead of the row pins")
    pn.add_argument("--dataset", help="with --blobs: one seat")
    pn.add_argument("--verify", action="store_true", help="with --blobs: re-hash every blob file (reads every byte)")
    pn.add_argument("--retire-scratch", action="store_true", help="plan (or --apply) moving probe:/test: pins into _retired/pins")
    pn.add_argument("--apply", action="store_true", help="with --retire-scratch: do it")
    pn.add_argument("--json", action="store_true")
    pc = sub.add_parser("pacer")
    pc.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    fn = {"migrate": cmd_migrate, "doctor": cmd_doctor, "usage": cmd_usage, "tier": cmd_move, "prune": cmd_move,
          "schema": cmd_schema, "import-cockpit": cmd_import, "backup": cmd_backup, "cache": cmd_cache,
          "pins": cmd_pins, "pacer": cmd_pacer}[a.cmd]
    try:
        return fn(a)
    except Exception as e:
        print(f"[fund_db {a.cmd}] FAILED: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
