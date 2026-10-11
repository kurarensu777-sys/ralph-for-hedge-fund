"""The cross-process partition lock (fund_db.market.lock)."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from fund_db.market import lock

PY = Path(__file__).resolve().parents[2] / "py"


def _hold_empty(path: Path, ready: Path) -> subprocess.Popen:
    """A child that creates `path` EMPTY and locks its byte 0 - the moment in which a second
    process would find a size-0 lock file whose first byte is already held."""
    code = (
        "import os, sys, time\n"
        f"fd = os.open(r'{path}', os.O_RDWR | os.O_CREAT, 0o644)\n"
        f"sys.path.insert(0, r'{PY}')\n"
        "from fund_db.market import lock\n"
        "assert lock._try(fd)\n"
        f"open(r'{ready}', 'w').close()\n"
        "time.sleep(30)\n")
    return subprocess.Popen([sys.executable, "-c", code])


def _wait(p: Path, s: float = 20.0) -> None:
    end = time.monotonic() + s
    while not p.exists():
        assert time.monotonic() < end, "the holder never started"
        time.sleep(0.02)


def test_an_empty_lock_file_held_by_another_process_is_waited_on_not_an_error(tmp_path):
    name = "funding/venue_l/2026-09"
    import hashlib
    path = tmp_path / f"{hashlib.sha1(name.encode()).hexdigest()[:20]}.lock"
    ready = tmp_path / "ready"
    child = _hold_empty(path, ready)
    try:
        _wait(ready)
        assert path.stat().st_size == 0
        with pytest.raises(lock.LockTimeout):
            with lock.locked(tmp_path, name, timeout=0.3):
                pass
    finally:
        child.kill()
        child.wait()
    with lock.locked(tmp_path, name, timeout=5):     # the holder gone: the lock is free again
        pass


def test_the_lock_serializes_processes(tmp_path):
    out = tmp_path / "log"
    code = (
        "import sys, time\n"
        f"sys.path.insert(0, r'{PY}')\n"
        "from pathlib import Path\n"
        "from fund_db.market import lock\n"
        "for _ in range(5):\n"
        f"    with lock.locked(Path(r'{tmp_path}'), 'p', timeout=60):\n"
        f"        with open(r'{out}', 'a') as f: f.write('in\\n')\n"
        "        time.sleep(0.01)\n"
        f"        with open(r'{out}', 'a') as f: f.write('out\\n')\n")
    procs = [subprocess.Popen([sys.executable, "-c", code]) for _ in range(4)]
    assert [p.wait(timeout=120) for p in procs] == [0, 0, 0, 0]
    lines = out.read_text().split()
    assert lines == ["in", "out"] * 20, "two holders overlapped"
    assert os.path.getsize(next(tmp_path.glob("*.lock"))) == 1
