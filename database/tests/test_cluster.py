"""The portable cluster controller, on clusters of its own (never ~/fund-data/db)."""
from __future__ import annotations

import os
import shutil
import socket
import tempfile
import zipfile
from pathlib import Path

import pytest

from conftest import REAL_BIN, _free_port


def _quiet(*_):
    pass


@pytest.fixture
def own_root(monkeypatch):
    root = Path(tempfile.mkdtemp(prefix="fund_db_cl_"))
    monkeypatch.setenv("FUND_DB_DIR", str(root))
    monkeypatch.delenv("FUND_DB_DSN", raising=False)
    monkeypatch.delenv("FUND_DB_PORT", raising=False)
    yield root
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def own_cluster(own_root, monkeypatch):
    if not any((REAL_BIN / n).exists() for n in ("initdb.exe", "initdb")):
        pytest.skip("no PostgreSQL binaries")
    monkeypatch.setenv("FUND_PG_BIN", str(REAL_BIN))
    from fund_db import cluster
    port = _free_port()
    cluster.init(port=port, log=_quiet)
    yield {"root": own_root, "port": port}
    cluster.stop(log=_quiet)


def test_init_is_locked_to_loopback_trust_and_idempotent(own_cluster):
    from fund_db import cluster, config
    from fund_db.db import connect
    root, port = own_cluster["root"], own_cluster["port"]
    rules = [ln.split() for ln in (root / "pgdata" / "pg_hba.conf").read_text().splitlines()
             if ln.strip() and not ln.startswith("#")]
    assert rules == [["host", "all", "all", "127.0.0.1/32", "trust"]]
    assert config.settings()["port"] == port
    with connect(autocommit=True) as c:
        assert c.execute("SHOW listen_addresses").fetchone()["listen_addresses"] == "127.0.0.1"
        assert c.execute("SELECT current_database() AS d").fetchone()["d"] == "fund"
        assert c.execute("SHOW server_encoding").fetchone()["server_encoding"] == "UTF8"
        assert c.execute("SHOW TimeZone").fetchone()["TimeZone"] == "UTC"
    # every verb a second time is a no-op that says so
    assert cluster.init(log=_quiet) == "initialised"
    assert cluster.start(log=_quiet).startswith("running")
    st = cluster.status()
    assert st["running"] and st["accepting"] and st["port"] == port and st["pid"]


def test_stop_then_start_and_status_exit_codes(own_cluster):
    from fund_db import cluster
    assert cluster.stop(log=_quiet) == "stopped"
    assert cluster.stop(log=_quiet) == "not running"
    assert cluster.main(["status"]) == 3          # stopped is not ok for a status probe
    assert cluster.start(log=_quiet).startswith("started")
    assert cluster.main(["status"]) == 0


def test_start_refuses_a_port_someone_else_holds(own_cluster):
    from fund_db import cluster
    cluster.stop(log=_quiet)
    s = socket.socket()
    s.bind(("127.0.0.1", own_cluster["port"]))
    s.listen(1)
    try:
        with pytest.raises(cluster.ClusterError, match="held by another process"):
            cluster.start(log=_quiet)
    finally:
        s.close()
    assert cluster.start(log=_quiet).startswith("started")


def test_the_server_is_not_reachable_on_any_other_address(own_cluster):
    """What a green here claims: the server is bound to 127.0.0.1 only (a connect to the machine's
    other addresses is refused) - checked by trying, not by reading the config."""
    port = own_cluster["port"]
    others = {ai[4][0] for ai in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)} - {"127.0.0.1"}
    if not others:
        pytest.skip("this machine has no non-loopback IPv4 address to try")
    for addr in others:
        with pytest.raises(OSError):
            socket.create_connection((addr, port), timeout=1).close()


def test_init_refuses_a_non_empty_folder_without_pg_version(own_root, monkeypatch):
    monkeypatch.setenv("FUND_PG_BIN", str(REAL_BIN))
    from fund_db import cluster
    (own_root / "pgdata").mkdir(parents=True)
    (own_root / "pgdata" / "stray.txt").write_text("x")
    with pytest.raises(cluster.ClusterError, match="refusing to initdb"):
        cluster.init(port=_free_port(), log=_quiet)
    assert (own_root / "pgdata" / "stray.txt").exists()


@pytest.mark.skipif(os.name != "nt", reason="the pinned zip is Windows x64")
def test_install_refuses_a_zip_that_is_not_the_pinned_one(own_root, monkeypatch):
    monkeypatch.delenv("FUND_PG_BIN", raising=False)
    from fund_db import cluster
    dl = own_root / "_dl"
    dl.mkdir()
    with zipfile.ZipFile(dl / cluster.PG_ZIP, "w") as z:
        z.writestr("pgsql/bin/initdb.exe", b"not postgres")
    with pytest.raises(cluster.ClusterError, match="refusing to extract"):
        cluster.install(log=_quiet)
    assert not (own_root / "pgsql").exists()


def test_status_of_an_empty_root(own_root, monkeypatch):
    monkeypatch.setenv("FUND_PG_BIN", str(own_root / "nope"))
    from fund_db import cluster
    st = cluster.status()
    assert (st["installed"], st["initialised"], st["running"], st["accepting"]) == (False, False, False, False)
    assert cluster.main(["start"]) == 1
