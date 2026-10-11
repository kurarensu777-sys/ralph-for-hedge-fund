"""Every market-lake and live test runs against a throwaway data root (FUND_DB_DIR) and the
in-memory catalog, so no test ever reads or writes ~/fund-data/db or the real market.catalog.
A test that wants the real PgCatalog asks for db-core's `db` fixture as well."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "py"))

H = 3_600_000
T0 = 1_788_220_800_000          # 2026-09-01T00:00:00Z


# THE PRE-B-0322 LAKE. The merge, layout, retention and catalog tests below were written for the
# lake before storage classes, and assert files under market/: the `lake` fixture declares EVERY
# series archive (the same door a venue.json uses), so they keep testing those mechanics - the
# none-class datasets (quotes, trades, ...) included, which are otherwise stored nowhere. A
# storage-class test starts from a clean backend: the `classes` fixture.
from fund_db.market.registry import DATASETS as _DATASETS  # noqa: E402

LEGACY_DECL = [{"venue": "*", "dataset": n, "symbol": "*", "interval": "*", "declared_ms": 0,
                "why": "tests: the pre-B-0322 lake", "source": "tests/market/conftest.py"}
               for n in _DATASETS]


@pytest.fixture
def lake(tmp_path, monkeypatch):
    monkeypatch.setenv("FUND_DB_DIR", str(tmp_path / "db"))
    monkeypatch.setenv("FUND_DB_RETENTION", str(REPO / "retention.toml"))
    from fund_db.market import cache, catalog, retention, storage
    retention._CACHE.clear()
    cache._TOUCHED.clear()
    mem = catalog.MemoryCatalog()
    catalog.use(mem)
    meta = storage.MemoryStorage()
    meta.decl = [dict(d) for d in LEGACY_DECL]
    storage.use(meta)
    yield {"root": tmp_path / "db", "catalog": mem, "tmp": tmp_path, "storage": meta}
    catalog.use(None)
    storage.use(None)
    retention._CACHE.clear()


@pytest.fixture
def rules(lake, monkeypatch):
    """Write a retention.toml for this test only: rules("[datasets.quotes]\\nkeep_days = 30")."""
    from fund_db.market import retention

    def _set(text: str) -> Path:
        p = lake["tmp"] / "retention.toml"
        p.write_text(text, encoding="utf-8")
        monkeypatch.setenv("FUND_DB_RETENTION", str(p))
        retention._CACHE.clear()
        return p
    return _set


@pytest.fixture
def classes(lake):
    """The lake with the storage classes as production has them: no declaration at all."""
    from fund_db.market import storage
    meta = storage.MemoryStorage()
    storage.use(meta)
    lake["storage"] = meta
    return lake
