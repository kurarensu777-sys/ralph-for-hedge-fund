"""fund_db.files - the FILES AREA: data that stays a file, reached only through this module.

Some stored data is not a table: the runtime JSON a vendored app reads as-is, the reference
trees it ships with, a client's small side state (fetch-state sidecars). It lives at

    <data root>/market/_files/<area>/<relative path>

and every read and write of it goes through the functions below, so a caller never spells a data
path, never opens the file itself, and every write is ATOMIC (temp file + fsync + os.replace):
a crash leaves the old bytes or the new ones, never half of each.

    from fund_db import files
    files.write_json("my-area", "state/fetch.json", obj)
    files.read_json("my-area", "state/fetch.json", default={})
    files.write_bytes("my-app", "data/options.json", raw)
    files.area_dir("my-app")          # the folder, for a READER that must be handed one (a
                                       # vendored app serving static JSON); never write into it

A relative path is validated: no absolute path, no drive, no `..`, no empty segment - a path
can never climb out of its area. An area name is one plain segment. `retire()` is the only way
a file leaves the area, and it MOVES the file to `<data root>/_retired/files/<area>/...`
(database/CLAUDE.md rule 5: no agent deletes data).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
from pathlib import Path, PurePosixPath
from typing import Any, Iterator

from . import config

FILES_DIR = "_files"
_AREA_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


class FilesError(ValueError):
    """A bad area name or relative path (it would leave its area)."""


def root() -> Path:
    """<data root>/market/_files - every area's parent."""
    return config.market_dir() / FILES_DIR


def _area(area: str) -> Path:
    if not isinstance(area, str) or not _AREA_RE.match(area) or area in (".", ".."):
        raise FilesError(f"bad files area {area!r}: one plain name (letters, digits, _ . -)")
    return root() / area


def _rel(rel: str | os.PathLike) -> PurePosixPath:
    s = str(rel).replace("\\", "/")
    p = PurePosixPath(s)
    if not s or p.is_absolute() or re.match(r"^[A-Za-z]:", s):
        raise FilesError(f"bad relative path {rel!r}: must be relative to its area")
    if any(part in ("", ".", "..") for part in s.split("/")):
        raise FilesError(f"bad relative path {rel!r}: no empty, '.' or '..' segment")
    return p


def area_dir(area: str) -> Path:
    """The folder of one area (created). For a READER that must be handed a directory; write
    through write_bytes / write_json / append_jsonl, never into this path directly."""
    d = _area(area)
    d.mkdir(parents=True, exist_ok=True)
    return d


def path(area: str, rel: str | os.PathLike) -> Path:
    """The absolute path of one file in an area (validated; the file need not exist). For a
    reader that hands a path to a library; a write goes through this module."""
    base = _area(area)
    p = (base / Path(*_rel(rel).parts))
    # belt and braces: the resolved path must still sit under the area
    if os.path.commonpath([os.path.abspath(p), os.path.abspath(base)]) != os.path.abspath(base):
        raise FilesError(f"{rel!r} resolves outside area {area!r}")
    return p


def exists(area: str, rel: str | os.PathLike) -> bool:
    return path(area, rel).is_file()


def stat(area: str, rel: str | os.PathLike) -> dict | None:
    """{"bytes", "mtime_ms"} of one file, or None when it does not exist."""
    try:
        st = path(area, rel).stat()
    except FileNotFoundError:
        return None
    return {"bytes": st.st_size, "mtime_ms": int(st.st_mtime * 1000)}


def listdir(area: str, prefix: str | os.PathLike | None = None, pattern: str = "*") -> list[str]:
    """Relative paths (posix) of the files under `prefix` (default: the whole area) matching the
    glob `pattern`, recursively, sorted. Temp files are never listed."""
    base = _area(area)
    start = path(area, prefix) if prefix else base
    if not start.is_dir():
        return []
    out = []
    for p in start.rglob(pattern):
        if p.is_file() and not p.name.endswith(".tmp") and not p.name.startswith("."):
            out.append(p.relative_to(base).as_posix())
    return sorted(out)


# --------------------------------------------------------------------------------------------- #
# reads
# --------------------------------------------------------------------------------------------- #

def read_bytes(area: str, rel: str | os.PathLike) -> bytes:
    """Raises FileNotFoundError when absent."""
    return path(area, rel).read_bytes()


def read_text(area: str, rel: str | os.PathLike, encoding: str = "utf-8") -> str:
    return path(area, rel).read_text(encoding=encoding)


def read_json(area: str, rel: str | os.PathLike, default: Any = None) -> Any:
    """The parsed JSON, or `default` when the file is absent or unreadable."""
    try:
        return json.loads(read_text(area, rel))
    except (OSError, ValueError):
        return default


def read_jsonl(area: str, rel: str | os.PathLike, tail: int | None = None) -> list:
    """Every parseable line (oldest first), or the last `tail` of them. A torn line is skipped."""
    try:
        text = read_text(area, rel)
    except OSError:
        return []
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if tail is not None:
        lines = lines[-tail:] if tail > 0 else []
    out = []
    for ln in lines:
        try:
            out.append(json.loads(ln))
        except ValueError:
            continue
    return out


# --------------------------------------------------------------------------------------------- #
# writes (atomic)
# --------------------------------------------------------------------------------------------- #

def _atomic(p: Path, data: bytes) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.name}.{os.getpid()}.{time.monotonic_ns()}.tmp")
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
    finally:
        if tmp.exists():
            tmp.unlink()


def write_bytes(area: str, rel: str | os.PathLike, data: bytes) -> dict:
    """Replace one file atomically. -> {"path", "bytes"}."""
    if not isinstance(data, (bytes, bytearray)):
        raise TypeError("write_bytes takes bytes")
    p = path(area, rel)
    _atomic(p, bytes(data))
    return {"path": str(p), "bytes": len(data)}


def write_text(area: str, rel: str | os.PathLike, text: str, encoding: str = "utf-8") -> dict:
    return write_bytes(area, rel, text.encode(encoding))


def write_json(area: str, rel: str | os.PathLike, obj: Any, *, indent: int | None = None,
               sort_keys: bool = True) -> dict:
    """Replace one JSON file atomically (LF endings)."""
    sep = None if indent else (",", ":")
    return write_text(area, rel, json.dumps(obj, indent=indent, sort_keys=sort_keys,
                                            separators=sep, default=str) + ("\n" if indent else ""))


def append_jsonl(area: str, rel: str | os.PathLike, records: dict | list[dict]) -> int:
    """Append one record (or several) as JSON lines, fsynced. -> lines written."""
    recs = [records] if isinstance(records, dict) else list(records)
    if not recs:
        return 0
    p = path(area, rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    body = "".join(json.dumps(r, separators=(",", ":"), default=str) + "\n" for r in recs)
    with open(p, "a", encoding="utf-8", newline="\n") as f:
        f.write(body)
        f.flush()
        os.fsync(f.fileno())
    return len(recs)


def retire(area: str, rel: str | os.PathLike) -> Path:
    """Take one file (or folder) out of service: MOVE it to <data root>/_retired/files/<area>/<rel>
    (a timestamp suffix when that name is taken). Never a delete. -> where it went."""
    src = path(area, rel)
    if not src.exists():
        raise FileNotFoundError(f"no such file in area {area!r}: {rel}")
    dst = config.retired_dir() / "files" / area / Path(*_rel(rel).parts)
    if dst.exists():
        dst = dst.with_name(f"{dst.name}.{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return dst


def walk(area: str) -> Iterator[tuple[str, int]]:
    """(relative path, bytes) of every file in an area - for usage reports."""
    for rel in listdir(area):
        st = stat(area, rel)
        if st:
            yield rel, st["bytes"]
