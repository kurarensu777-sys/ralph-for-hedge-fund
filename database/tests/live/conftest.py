"""Live hot-log tests run on a throwaway data root with the in-memory catalog (never ~/fund-data/db)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "py"))


@pytest.fixture
def lake(tmp_path, monkeypatch):
    monkeypatch.setenv("FUND_DB_DIR", str(tmp_path / "db"))
    monkeypatch.setenv("FUND_DB_RETENTION", str(REPO / "retention.toml"))
    from fund_db.market import catalog, retention, storage
    from fund_db.market.registry import DATASETS
    retention._CACHE.clear()
    catalog.use(catalog.MemoryCatalog())
    meta = storage.MemoryStorage()
    meta.decl = [{"venue": "*", "dataset": n, "symbol": "*", "interval": "*", "declared_ms": 0,
                  "why": "tests: the pre-B-0322 lake", "source": "tests/live/conftest.py"}
                 for n in DATASETS]
    storage.use(meta)
    yield {"root": tmp_path / "db"}
    catalog.use(None)
    storage.use(None)
    retention._CACHE.clear()
