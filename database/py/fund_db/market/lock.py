"""Cross-process partition locks. One writer per partition at a time, across every process on the
machine (a fetcher, the importer, a compaction; the retired feed's roll job once). The lock is an OS byte-range
lock on a small file under <hot root>/_locks/, so a crashed holder releases it automatically - there
is no stale-lock cleanup to get wrong. Inside one process a threading lock serializes as well
(Windows byte-range locks are per handle, so two threads would otherwise both "win").
"""
from __future__ import annotations

import hashlib
import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path

if os.name == "nt":
    import msvcrt

    def _try(fd: int) -> bool:
        try:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False

    def _release(fd: int) -> None:
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
else:  # pragma: no cover - the fund runs on Windows; kept so the tests run anywhere
    import fcntl

    def _try(fd: int) -> bool:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def _release(fd: int) -> None:
        fcntl.flock(fd, fcntl.LOCK_UN)


class LockTimeout(TimeoutError):
    pass


_THREAD_LOCKS: dict[str, threading.Lock] = {}
_GUARD = threading.Lock()


def _thread_lock(name: str) -> threading.Lock:
    with _GUARD:
        return _THREAD_LOCKS.setdefault(name, threading.Lock())


@contextmanager
def locked(lock_dir: Path, name: str, timeout: float = 120.0):
    """Hold the named lock for the block. Raises LockTimeout after `timeout` seconds."""
    lock_dir.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:20]
    path = lock_dir / f"{digest}.lock"
    tl = _thread_lock(str(path))
    if not tl.acquire(timeout=timeout):
        raise LockTimeout(f"lock {name!r} busy in this process for {timeout}s")
    fd = -1
    try:
        fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o644)
        if os.fstat(fd).st_size == 0:
            try:
                os.write(fd, b"\0")
            except PermissionError:
                # Another process created the file a moment ago and already holds byte 0 (Windows
                # refuses a write into a locked range, and a lock may cover a byte past EOF): the
                # file is in use, which is what the wait below is for.
                pass
        deadline = time.monotonic() + timeout
        wait = 0.005
        while not _try(fd):
            if time.monotonic() > deadline:
                raise LockTimeout(f"lock {name!r} held by another process for {timeout}s ({path})")
            time.sleep(wait)
            wait = min(wait * 2, 0.25)
        try:
            yield
        finally:
            _release(fd)
    finally:
        if fd >= 0:
            os.close(fd)
        tl.release()
