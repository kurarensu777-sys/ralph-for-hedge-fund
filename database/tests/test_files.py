"""fund_db.files (the files area) and fund_db.errors: paths never leave their area, writes are
atomic, a file leaves only by moving to _retired."""
from __future__ import annotations

import pytest

from fund_db import errors, files


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("FUND_DB_DIR", str(tmp_path / "db"))
    return tmp_path / "db"


def test_the_area_lives_under_the_lake_files_dir(root):
    from fund_db.market import FILES_DIR
    assert files.FILES_DIR == FILES_DIR
    assert files.area_dir("my-area") == root / "market" / "_files" / "my-area"
    assert files.path("my-app", "data/a.json") == root / "market" / "_files" / "my-app" / "data" / "a.json"


@pytest.mark.parametrize("rel", ["../x", "a/../../x", "/etc/passwd", "C:/x", "C:\\x", "", "a//b", "./a"])
def test_a_path_can_never_climb_out(root, rel):
    with pytest.raises(files.FilesError):
        files.path("my-area", rel)


@pytest.mark.parametrize("area", ["", "..", "a/b", "a\\b", ".hidden", "x" * 65])
def test_an_area_is_one_plain_name(root, area):
    with pytest.raises(files.FilesError):
        files.area_dir(area)


def test_json_bytes_text_round_trip_and_atomic_replace(root):
    w = files.write_json("my-area", "stg/treasury/x/2026.meta.json", {"b": 1, "a": [1, 2]})
    assert w["bytes"] > 0
    assert files.read_json("my-area", "stg/treasury/x/2026.meta.json") == {"a": [1, 2], "b": 1}
    files.write_json("my-area", "stg/treasury/x/2026.meta.json", {"c": 3})
    assert files.read_json("my-area", "stg/treasury/x/2026.meta.json") == {"c": 3}
    assert files.read_json("my-area", "nope.json", default={}) == {}
    files.write_bytes("my-app", "data/raw.bin", b"\x00\x01")
    assert files.read_bytes("my-app", "data/raw.bin") == b"\x00\x01"
    files.write_text("my-app", "data/t.txt", "one\ntwo")
    assert files.read_text("my-app", "data/t.txt") == "one\ntwo"
    leftovers = [p for p in (root / "market" / "_files").rglob("*") if p.name.endswith(".tmp")]
    assert leftovers == []
    with pytest.raises(TypeError):
        files.write_bytes("my-app", "x", "not bytes")


def test_jsonl_append_tail_and_a_torn_line_is_skipped(root):
    assert files.append_jsonl("a", "log.jsonl", {"n": 1}) == 1
    assert files.append_jsonl("a", "log.jsonl", [{"n": 2}, {"n": 3}]) == 2
    with open(files.path("a", "log.jsonl"), "a", encoding="utf-8") as f:
        f.write('{"n": 4, "torn\n')
    assert [r["n"] for r in files.read_jsonl("a", "log.jsonl")] == [1, 2, 3]
    assert [r["n"] for r in files.read_jsonl("a", "log.jsonl", tail=2)] == [3]
    assert files.read_jsonl("a", "missing.jsonl") == []


def test_listdir_stat_exists_walk(root):
    files.write_json("a", "x/1.json", 1)
    files.write_json("a", "x/2.json", 2)
    files.write_json("a", "y.json", 3)
    assert files.listdir("a") == ["x/1.json", "x/2.json", "y.json"]
    assert files.listdir("a", "x") == ["x/1.json", "x/2.json"]
    assert files.listdir("a", pattern="*.json") == ["x/1.json", "x/2.json", "y.json"]
    assert files.listdir("empty") == []
    assert files.exists("a", "y.json") and not files.exists("a", "z.json")
    assert files.stat("a", "z.json") is None and files.stat("a", "y.json")["bytes"] == 1
    assert dict(files.walk("a")) == {"x/1.json": 1, "x/2.json": 1, "y.json": 1}


def test_retire_moves_never_deletes(root):
    files.write_json("a", "x/old.json", {"v": 1})
    dst = files.retire("a", "x/old.json")
    assert dst == root / "_retired" / "files" / "a" / "x" / "old.json"
    assert dst.read_text(encoding="utf-8") == '{"v":1}'
    assert not files.exists("a", "x/old.json")
    files.write_json("a", "x/old.json", {"v": 2})
    dst2 = files.retire("a", "x/old.json")
    assert dst2 != dst and dst.exists() and dst2.exists()
    with pytest.raises(FileNotFoundError):
        files.retire("a", "x/old.json")


def test_errors_name_the_unavailable_types_without_the_caller_importing_them():
    import duckdb
    import psycopg
    from fund_db.market.lock import LockTimeout
    errs = errors.unavailable()
    assert OSError in errs and duckdb.Error in errs and psycopg.OperationalError in errs and LockTimeout in errs
    from fund_db.market import WriteError
    assert not errors.is_unavailable(WriteError("contract breach"))
    assert errors.is_unavailable(psycopg.OperationalError("down"))
