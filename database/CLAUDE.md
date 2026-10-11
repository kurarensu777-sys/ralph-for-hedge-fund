# CLAUDE.md - database: the one data layer

Every folder of the fund reads and writes data through the API below. Data lives under `~/fund-data/db`
(`FUND_DB_DIR` overrides): `pgsql/`, `pgdata/`, `pg.json`, `market/` (the lake), `live/_locks/`
(partition locks every lake writer takes), `cold/`, `cache/`, `pins/`, `_retired/`. Never in the repo.

## Stores

- **Ops**: PostgreSQL 17 on `127.0.0.1`, trust auth. Schema `ops` (cockpit tables, platform logs),
  schema `market` (catalog, `contracts`, `contract_links`, `pins`, `blobs`, `pacer`, `archive_decl`).
- **Lake**: Parquet `market/<dataset>/<part>=<v>/month=<YYYY-MM>/`, zstd, read by DuckDB. Settled
  rows are immutable; a re-published different value goes to `conflicts`. Layout, merge rules and
  catalog: the `fund_db.market` module docstrings are the contract.

## Storage classes (boot book: `how-we-guard.md#data-the-four-classes`)

`none` (writes refused), `cache` (the default; `cache/`, `retention.toml [cache] max_bytes` 500,000,000;
least-recently-read month evicted first, idle 14 days cleaned weekly), `pin` (exact rows a result used,
`pins/<hh>/<sha256>.parquet`, immutable), `archive` (the lake; per series via `declare_archive`). Pinned
bytes that are not lake rows (a study's raw input files, derived tables) are blobs under a registered
seat (`raw`, `derived`), PIN class, never evicted and outside the cache budget (`market/blobstore.py`;
seats: `registry.BLOB_SEATS`). `storage.resolve` runs before every write. A probe or test runs
on `FUND_DB_DIR=<tmp>`: `probe:` and `test:` pin refs are refused on the real root. Details: the
docstrings of `market/cache.py`, `storage.py`, `pinning.py`.

## API

Python (`fund_db`; node twin `@fund/db` in `node/`, `ops.<camelCase>` name for name, `python delete` is `del`):

| call | what |
|---|---|
| `sql(q, params, as_=)` | DuckDB over every lake view (hot, cold, cache) and `pg` (ops, read-only) |
| `ops.<fn>(..., conn=)`, `connect()`, `db.transaction()`, `db.ping()/shared()` | typed ops-store functions, generic `insert/upsert/get/select/update/delete/count` |
| `market.read/write_rows/conflicts`, `funding/candles/quotes/trades/orderbook/options/predmkts/eod/rates/snapshots` and `write_*`, `coverage()` | the lake by dataset |
| `market.write_contracts/contracts`, `write_contract_bars/contract_bars`, `write_contract_links/contract_links`, `write_option_chain/option_chains` | listed-contract reference, bars, cross-venue links, IV chain snapshots (rules: `market/contracts.py`) |
| `market.write_predmkt_bars/predmkt_bars`, `predmkt_symbol` | prediction-market outcome price history, symbol `<venue id>@<listed_ms>` (rules: `registry.py` predmkt_bars) |
| `market.write_cb`, `cb_docs/cb_meetings/cb_votes/cb_projections/cb_llm` | central bank archive, venue fed/boj/ecb, archive by dataset default; a cb_docs url re-dated into another month moves (rules: `registry.py` cb_* docs) |
| `market.declare_archive/archive_declarations`, `cache_usage/evict/clean/reclassify` | class lists and the cache |
| `market.pin/pin_series/pinned/pins/pins_digest/window_digest` | pins; `window_digest` is a run's 8-hex data fingerprint |
| `market.blob_put/blob_get/blob_meta/blob_path/blobs/blob_input_pin` | the blob seat: immutable pinned bytes under `(seat, key)`; same bytes again is a no-op, other bytes `BlobConflict`; node reads the index as `market.blobs` |
| `pacer.set_budget/take/backoff/coalesce/status` | the one per-venue request budget (`market.pacer`) |
| `market.edit`, `files`, `backup`, `live` (dormant), `errors.unavailable()/is_unavailable(e)` | row removal and trash, `edit.correct_rows/restore_trash` (a settled row stored wrong: dry run, trash, restore), `_files` area, nightly pg_dump, "the layer cannot answer now" |

Node only: `migrate()`, `ping()`, `transaction(fn)`, `market.cacheUsage/pins/pacerStatus`, `Rows` types.
Times are epoch ms; `ts=None` (python) or omitted (node) is now, `0` is a real time; jsonb comes back parsed.

## Commands (from the fund root, `.venv\Scripts\python.exe`)

    python database\scripts\pg.py ensure|stop      install, init, start, migrate / stop
    python -m fund_db migrate [--status]           apply / list applied, PENDING, DRIFT
    python -m fund_db doctor [--json]              every property claimed here, tested
    python -m fund_db schema --write|--check       regenerate / check generated schema, rows.py, rows.ts
    python -m fund_db usage|tier|prune [--apply]   space; retention moves (dry run by default); prune moves to _retired/
    python -m fund_db backup [--list]              pg_dump, checked, newest 14 kept
    python -m fund_db cache [--usage|--evict|--clean|--reclassify] [--json]   --help has the flags and the JSON keys
    python -m fund_db pins [--ref R] [--retire-scratch [--apply]]   the pin index
    python -m fund_db pins --blobs [--dataset S] [--verify]          the blob seat's index and its file check (--verify re-hashes)
    python -m fund_db pacer [--json]               per-venue budgets
    .venv\Scripts\python.exe -m pytest -q database\tests    the suite (throwaway clusters)
    cd database\node && npm test                            the node suite

## Rules

1. Every schema change is a numbered migration `migrations/<track>/<NNN>_<name>.sql` (ledger `public.fund_migrations`).
2. An applied migration is never edited (sha256 in the ledger; DRIFT stops `migrate`). Fix forward.
3. After a migration run `schema --write`; `tests/test_schema.py` fails while generated files are stale.
4. A new `fund_db.ops` function ships with its node twin (`tests/test_contract.py`).
5. Cache eviction is the one delete here; `tier` verifies a copy first, `prune` moves. No credentials.

The `database` agent owns this folder. Commits carry an `Agent: <id>` trailer.

The lake ships no venue adapter and no venue's data: venue ids in examples (`exchange_a`) are
placeholders. The canonical row shapes a pin digests are `market/canonical.py`.
