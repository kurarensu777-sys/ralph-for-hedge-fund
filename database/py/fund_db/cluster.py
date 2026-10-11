"""The portable PostgreSQL controller: install, init, start, stop, status, ensure. Standard library
only (it runs before anything is pip-installed), idempotent (every verb checks before it acts),
no admin rights, no service, no Docker.

    python database/scripts/pg.py ensure     install + init + start + migrate; what start.bat calls
    python database/scripts/pg.py status     one line (or --json)
    python database/scripts/pg.py stop       what stop.bat calls

The cluster listens on 127.0.0.1 only and trusts 127.0.0.1 only (pg_hba has exactly one rule), so
there is no password anywhere. Port 5432 unless something else holds it at init, then the next
free port up to 5499; the choice is written to <root>/pg.json and every client reads it there.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

from . import config

# The pinned binaries: EDB's portable zip for PostgreSQL 17.9 on Windows x64. The sha256 was read
# from the zip downloaded 2026-09-25 [V]; a download that does not match it is refused.
PG_VERSION = "17.9-1"
PG_ZIP = f"postgresql-{PG_VERSION}-windows-x64-binaries.zip"
PG_URL = f"https://get.enterprisedb.com/postgresql/{PG_ZIP}"
PG_SHA256 = "e4b31879202d87894375eee6cfc88adf5afbb030687a3674361d78e427357f24"

PORT_RANGE = range(5432, 5500)
CONF_MARK = "# --- fund_db (written by fund_db.cluster; edit here, not above) ---"
HBA = (
    "# fund_db: the ONLY rule. TCP from 127.0.0.1, trust, nothing else (no ::1, no other host).\n"
    "# TYPE  DATABASE  USER  ADDRESS        METHOD\n"
    "host    all       all   127.0.0.1/32   trust\n"
)

_WIN = os.name == "nt"
_EXE = ".exe" if _WIN else ""


class ClusterError(RuntimeError):
    pass


def _bin(name: str) -> Path:
    return config.pg_bin_dir() / f"{name}{_EXE}"


def _flags() -> int:
    # no console window for pg_ctl or the postgres it spawns, and out of the caller's Ctrl-C group,
    # so closing the window that ran start.bat does not take the database down with it
    if not _WIN:
        return 0
    return subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP


def _run(argv: list, timeout: float = 120, check: bool = True) -> tuple[int, str]:
    """Run a binary with its output going to a FILE, never a pipe: on Windows postgres inherits
    pg_ctl's handles, and a pipe it holds open would hang the caller until the server exits."""
    config.log_dir().mkdir(parents=True, exist_ok=True)
    out = config.log_dir() / "pg_ctl.out"
    with open(out, "w", encoding="utf-8", errors="replace") as fh:
        rc = subprocess.run([str(a) for a in argv], stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT,
                            timeout=timeout, creationflags=_flags()).returncode
    text = out.read_text(encoding="utf-8", errors="replace").strip()
    if check and rc != 0:
        raise ClusterError(f"{Path(argv[0]).name} exited {rc}: {text[-800:]}")
    return rc, text


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_EXCLUSIVEADDRUSE", socket.SO_REUSEADDR), 1)
        try:
            s.bind((config.HOST, port))
            return True
        except OSError:
            return False


def _accepting(port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((config.HOST, port), timeout=timeout):
            return True
    except OSError:
        return False


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------------------------------ verbs


def installed() -> bool:
    return all(_bin(n).exists() for n in ("initdb", "pg_ctl", "postgres", "psql"))


def install(log=print) -> str:
    """Put the pinned binaries at <root>/pgsql. Uses <root>/_dl/<zip> when present, else downloads
    it; either way the sha256 must match PG_SHA256 before anything is extracted."""
    if installed():
        return "installed"
    if os.environ.get("FUND_PG_BIN"):
        raise ClusterError(f"FUND_PG_BIN={os.environ['FUND_PG_BIN']} has no PostgreSQL binaries")
    if not _WIN:
        raise ClusterError("the pinned binaries are Windows x64; on another OS point FUND_PG_BIN at an install")
    root = config.data_dir()
    zpath = root / "_dl" / PG_ZIP
    if not zpath.exists():
        zpath.parent.mkdir(parents=True, exist_ok=True)
        tmp = zpath.with_suffix(".part")
        log(f"[pg] downloading {PG_URL}")
        with urllib.request.urlopen(PG_URL, timeout=60) as r, open(tmp, "wb") as fh:
            shutil.copyfileobj(r, fh, 1 << 20)
        tmp.replace(zpath)
    got = sha256(zpath)
    if got != PG_SHA256:
        raise ClusterError(f"{zpath} sha256 {got} is not the pinned {PG_SHA256}; refusing to extract")
    log(f"[pg] extracting {zpath.name} into {root}")
    with zipfile.ZipFile(zpath) as z:
        members = [m for m in z.namelist() if m.startswith("pgsql/") and not m.startswith("pgsql/pgAdmin")]
        z.extractall(root, members)
    if not installed():
        raise ClusterError(f"extracted, but {config.pg_bin_dir()} still lacks initdb/pg_ctl/postgres/psql")
    return "installed now"


def initialised() -> bool:
    return (config.pgdata_dir() / "PG_VERSION").exists()


def _write_settings(port: int) -> None:
    s = {"port": port, "user": config.DEFAULT_USER, "database": config.DEFAULT_DATABASE,
         "host": config.HOST, "pg_version": PG_VERSION}
    config.settings_path().write_text(json.dumps(s, indent=2) + "\n", encoding="utf-8")


def _conf_block(port: int) -> str:
    return (
        f"\n{CONF_MARK}\n"
        "listen_addresses = '127.0.0.1'\n"
        f"port = {port}\n"
        "unix_socket_directories = ''\n"
        "max_connections = 60\n"
        "shared_buffers = 128MB\n"
        "timezone = 'UTC'\n"
        "log_timezone = 'UTC'\n"
        "password_encryption = 'scram-sha-256'\n"
    )


def init(port: int | None = None, log=print) -> str:
    """initdb into <root>/pgdata, lock it to 127.0.0.1 trust, create the `fund` database."""
    if initialised():
        _ensure_conf()
        return "initialised"
    if not installed():
        raise ClusterError("no binaries: run install first")
    pgdata = config.pgdata_dir()
    if pgdata.exists() and any(pgdata.iterdir()):
        raise ClusterError(f"{pgdata} is not empty and has no PG_VERSION; refusing to initdb over it")
    if port is None:
        port = next((p for p in PORT_RANGE if _port_free(p)), None)
        if port is None:
            raise ClusterError(f"no free port in {PORT_RANGE.start}-{PORT_RANGE.stop - 1} on {config.HOST}")
    pgdata.parent.mkdir(parents=True, exist_ok=True)
    base = [_bin("initdb"), "-D", pgdata, "-U", config.DEFAULT_USER, "--auth=trust", "-E", "UTF8"]
    rc, text = _run(base + ["--locale=C", "--locale-provider=builtin", "--builtin-locale=C.UTF-8"], check=False)
    if rc != 0:
        shutil.rmtree(pgdata, ignore_errors=True)
        _run(base + ["--no-locale"])
    (pgdata / "pg_hba.conf").write_text(HBA, encoding="utf-8")
    (pgdata / "pg_ident.conf").write_text("# fund_db: no ident maps\n", encoding="utf-8")
    with open(pgdata / "postgresql.conf", "a", encoding="utf-8") as fh:
        fh.write(_conf_block(port))
    _write_settings(port)
    log(f"[pg] initialised {pgdata} on 127.0.0.1:{port}")
    start(log=log)
    _run([_bin("psql"), "-h", config.HOST, "-p", port, "-U", config.DEFAULT_USER, "-d", "postgres", "-v", "ON_ERROR_STOP=1",
          "-qc", f"CREATE DATABASE {config.DEFAULT_DATABASE}"])
    return "initialised now"


def _ensure_conf() -> None:
    """A cluster made before pg.json existed still gets one, read from its postgresql.conf."""
    if config.settings_path().exists():
        return
    port = config.DEFAULT_PORT
    for line in (config.pgdata_dir() / "postgresql.conf").read_text(encoding="utf-8").splitlines():
        t = line.split("#", 1)[0].strip()
        if t.startswith("port") and "=" in t:
            port = int(t.split("=", 1)[1].strip())
    _write_settings(port)


def _pid() -> int | None:
    f = config.pgdata_dir() / "postmaster.pid"
    try:
        return int(f.read_text(encoding="utf-8").splitlines()[0])
    except (OSError, ValueError, IndexError):
        return None


def running() -> bool:
    if not initialised() or not installed():
        return False
    rc, _ = _run([_bin("pg_ctl"), "status", "-D", config.pgdata_dir()], check=False, timeout=30)
    return rc == 0


def start(log=print) -> str:
    if not initialised():
        raise ClusterError("no cluster: run init first")
    port = config.settings()["port"]
    if running():
        return f"running on 127.0.0.1:{port}"
    if not _port_free(port):
        raise ClusterError(f"127.0.0.1:{port} is held by another process; the cluster cannot start there "
                           f"(free it, or change port in {config.pgdata_dir() / 'postgresql.conf'} and {config.settings_path()})")
    config.log_dir().mkdir(parents=True, exist_ok=True)
    _run([_bin("pg_ctl"), "start", "-D", config.pgdata_dir(), "-l", config.log_dir() / "postgres.log", "-w", "-t", "60"], timeout=90)
    for _ in range(50):
        if _accepting(port):
            break
        time.sleep(0.1)
    log(f"[pg] started on 127.0.0.1:{port} (pid {_pid()})")
    return f"started on 127.0.0.1:{port}"


def stop(log=print) -> str:
    if not running():
        return "not running"
    _run([_bin("pg_ctl"), "stop", "-D", config.pgdata_dir(), "-m", "fast", "-w", "-t", "60"], timeout=90)
    log("[pg] stopped")
    return "stopped"


def status() -> dict:
    s = config.settings()
    up = running()
    return {
        "data_dir": str(config.data_dir()),
        "installed": installed(),
        "initialised": initialised(),
        "running": up,
        "pid": _pid() if up else None,
        "port": s["port"],
        "accepting": _accepting(s["port"]) if up else False,
        "dsn": config.dsn(),
    }


def ensure(migrate: bool = True, log=print) -> dict:
    """Everything start.bat needs, each step a no-op when already done."""
    steps = {"install": install(log=log), "init": init(log=log), "start": start(log=log)}
    if migrate:
        try:
            from . import migrate as m
        except ImportError as e:  # psycopg not installed yet: the cluster is up, the schema waits
            steps["migrate"] = f"skipped ({e.name} not installed)"
        else:
            applied = m.migrate(log=log)
            steps["migrate"] = f"{len(applied)} applied" if applied else "up to date"
    return steps


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pg", description="The fund's portable PostgreSQL (127.0.0.1 only, no password).")
    ap.add_argument("verb", choices=["install", "init", "start", "stop", "status", "ensure"])
    ap.add_argument("--port", type=int, help="init only: the port to use instead of the first free one from 5432")
    ap.add_argument("--no-migrate", action="store_true", help="ensure only: do not apply migrations")
    ap.add_argument("--json", action="store_true", help="print the result as JSON")
    a = ap.parse_args(argv)
    try:
        if a.verb == "status":
            r = status()
            print(json.dumps(r, indent=2) if a.json else
                  f"[pg] {'running' if r['running'] else 'stopped'} · port {r['port']} · installed {r['installed']} · "
                  f"initialised {r['initialised']} · {r['data_dir']}")
            return 0 if r["running"] else 3
        if a.verb == "init":
            r = init(port=a.port)
        elif a.verb == "ensure":
            r = ensure(migrate=not a.no_migrate)
        else:
            r = {"install": install, "start": start, "stop": stop}[a.verb]()
        print(json.dumps(r) if a.json else f"[pg] {a.verb}: {r}")
        return 0
    except (ClusterError, subprocess.TimeoutExpired, OSError) as e:
        print(f"[pg] {a.verb} FAILED: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
