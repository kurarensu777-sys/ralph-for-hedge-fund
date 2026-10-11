"""fund_db.market - the Parquet market lake (read by DuckDB in-process).

    from fund_db import market
    market.funding("exchange_a", ["BTCUSDT"], start="2026-09-01", end="2026-09-25")   -> pyarrow.Table
    market.candles("exchange_a", "BTC", "1h", start=..., as_="pandas")
    market.eod("AAPL.US"); market.rates("daily_treasury_yield_curve", tenor="10Y")
    market.write_funding("exchange_a", rows, symbol="BTCUSDT")  # merge rules, conflicts logged
    market.coverage("funding", venue="exchange_a")               # the catalog, a query not a scan

Listed contracts of a tradfi venue (stocks, FX, futures incl. expired, futures options), keyed on
the venue's own contract id - contracts.py is the long form:
    market.write_contracts("broker_a", [{"con_id": 1, "sec_type": "FUT", "underlying": "SR3", ...}])
    market.write_contract_bars("broker_a", 1, "1d", bars, what="TRADES", data_type="delayed")
    market.contract_bars("broker_a", 1, "1d", what="TRADES"); market.contracts("broker_a", underlying="SR3")
    market.contract_coverage("broker_a", underlying="SR3", sec_type="FOP")
A venue without numeric ids keys on its own full symbol ("CME:SR3M2025"), and one contract on two
venues is a link, so a cross-check is a query:
    market.write_contract_links([{"venue": "charts_a", "symbol": "CME:SR3M2025",
                                  "link_venue": "broker_a", "link_symbol": "1", "method": "identity"}])
Option chain snapshots (the IV surface archive), settled per (symbol, read time):
    market.write_option_chain("charts_a", rows, data_type="delayed")
    market.option_chains("charts_a", underlying="CME:SR3Z2026")

Prediction-market price history, one outcome per series, the symbol '<venue id>@<listed_ms>' so a
re-listed market is a new series (the registry docstring of predmkt_bars is the long form):
    sym = market.predmkt_symbol("FED-26OCT-T4.25", 1_788_000_000_000)
    market.write_predmkt_bars("predmkt_a", sym, "1h", bars, outcome="yes", px_kind="ohlc")
    market.predmkt_bars("predmkt_a", sym, "1h", closed_only=True)

Central bank archive: cb_docs, cb_meetings, cb_votes, cb_projections (revise) and cb_llm
(settled), venue fed | boj | ecb, ARCHIVE by the dataset default (registry docstrings are the contract):
    market.write_cb("cb_meetings", "fed", [{"meeting_date": "2025-12-10", "status": "pending"}], source="derived:classify")
    market.cb_meetings("fed", status="pending", as_="rows")

STORAGE CLASSES: none | cache | pin | archive - registry.py names each dataset's default,
storage.py resolves every write (a declared archive series -> the lake, the rest -> the cache):
    market.declare_archive("exchange_a", [{"dataset": "candles", "symbol": "*", "interval": "*"}],
                           why="...", source="exchange_a venue config")
    market.cache_usage(); market.evict(); market.clean()       # the 500 MB cache (cache.py)
    h = market.pin(dataset="candles", venue="exchange_a", symbol="BTC", interval="1h",
                   window="2026-07-15..2026-09-22", reason="...", ref="lab/example#12")   # pinning.py
    market.pinned(h); market.pins(ref="lab/example#12"); market.pins_digest("candles", rows)

Pinned BYTES that are not lake rows (a study's raw input files, derived tables), under a
registered seat (registry.BLOB_SEATS), immutable, never evicted (blobstore.py is the long form):
    market.blob_put("derived", "days/2026-10-03@v2", raw, reason="...", ref="lab/example#7")
    market.blob_get("derived", "days/2026-10-03@v2"); market.blobs("derived", prefix="days/")

Row-level removal and the trash (the DATA panel's delete / restore): edit.py.
Layout, rules and the dataset registry: registry.py, writer.py, merge.py. Retention and space:
retention.py (database/retention.toml). CLI: python -m fund_db.market --help.
"""
from __future__ import annotations

from . import cache, edit, pinning, storage
from .blobstore import (BlobConflict, BlobMissing, blob_get, blob_input_pin, blob_meta, blob_path,
                    blob_put, blobs)
from .cache import CacheError, cache_usage, clean, evict, reclassify
from .pinning import PinError, pin, pin_series, pinned, pins, window_digest
from .pinning import digest as pins_digest
from .registry import CLASSES
from .storage import StorageError, archive_declarations, declare_archive
from .catalog import set_coverage
from .contracts import (contract_coverage, contract_links, contracts, write_contract_links,
                        write_contracts)
from .reader import (candles, cb_docs, cb_llm, cb_meetings, cb_projections, cb_votes, conflicts, contract_bars, coverage, eod, funding, option_chains,
                     options, orderbook, predmkt_bars, predmkts, quotes, rates, read, register_views, snapshots, trades)
from .registry import CB_DATASETS, CB_VENUES, DATASETS, FILES_DIR, Dataset, get
from .writer import (WriteError, compact_partition, predmkt_symbol, split_predmkt_symbol, write,
                     write_candles, write_contract_bars, write_eod, write_funding, write_option_chain,
                     write_cb, write_predmkt_bars, write_rows)

__all__ = [
    "DATASETS", "FILES_DIR", "Dataset", "get", "read", "funding", "candles", "quotes", "trades",
    "orderbook", "options", "predmkts", "eod", "rates", "snapshots", "conflicts", "coverage",
    "register_views", "write", "write_funding", "write_candles", "write_eod", "write_rows",
    "contract_bars", "write_contract_bars", "contracts", "write_contracts", "contract_coverage",
    "contract_links", "write_contract_links", "option_chains", "write_option_chain",
    "predmkt_bars", "write_predmkt_bars", "predmkt_symbol", "split_predmkt_symbol",
    "CB_DATASETS", "CB_VENUES", "write_cb", "cb_docs", "cb_meetings", "cb_votes", "cb_projections", "cb_llm",
    "WriteError", "compact_partition", "set_coverage", "edit", "usage", "tier", "prune", "compact",
    "CLASSES", "StorageError", "declare_archive", "archive_declarations", "cache", "pinning", "storage",
    "CacheError", "cache_usage", "clean", "evict", "reclassify",
    "PinError", "pin", "pin_series", "pinned", "pins", "pins_digest", "window_digest",
    "BlobConflict", "BlobMissing", "blob_put", "blob_get", "blob_meta", "blob_path", "blobs",
    "blob_input_pin",
]


def usage(rows: bool = True) -> dict:
    """What is where and how big: see retention.usage."""
    from .retention import usage as _u
    return _u(rows)


def tier(dataset: str | None = None, apply: bool = False, now_ms: int | None = None) -> list[dict]:
    from .retention import tier as _t
    return _t(dataset, apply, now_ms)


def prune(dataset: str | None = None, apply: bool = False, now_ms: int | None = None) -> list[dict]:
    from .retention import prune as _p
    return _p(dataset, apply, now_ms)


def compact(dataset: str | None = None, min_parts: int = 2) -> list[dict]:
    """Compact every hot and cache partition holding at least `min_parts` parts (one part per root)."""
    from . import layout
    out = []
    for name in ([dataset] if dataset else list(DATASETS)):
        ds = DATASETS[name]
        for p in layout.partitions(layout.hot_root(), ds) + layout.partitions(layout.cache_root(), ds):
            if len(layout.part_files(p)) >= min_parts:
                v = layout.parse_partition(ds, p)
                r = compact_partition(ds, v[ds.part_key], v.get(ds.sub_key), v["month"])
                out.append({"dataset": name, "partition": str(p), **r})
    return out
