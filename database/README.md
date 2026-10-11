# database

The fund's one data layer, a folder of the monorepo: a portable PostgreSQL ops store (127.0.0.1
only, no password), a Parquet market lake read by DuckDB, a dormant hot log, and the two client
libraries every other folder calls - `fund_db` (python) and `@fund/db` (node). The cockpit keeps
its board, conversations, health readings and loop counts in the ops store; the lab and the loop
keep their pins and snapshots in the lake. The data itself lives in `~/fund-data/db`
(`FUND_DB_DIR` overrides), never in the repo. The contract, the rules and their mechanisms are in
[CLAUDE.md](CLAUDE.md).

## Set up (from the fund root)

    .venv\Scripts\python.exe -m pip install -e "database[test]"
    .venv\Scripts\python.exe database\scripts\pg.py ensure
    .venv\Scripts\python.exe -m fund_db doctor
    cd database\node && npm install

`pg.py ensure` downloads the pinned PostgreSQL 17 zip only when `~/fund-data/db/_dl/` lacks it,
refuses a zip whose sha256 is not the pinned one, initialises the cluster on the first free port
from 5432, and applies every migration. Every step is a no-op when already done.

## Use it

    import fund_db
    fund_db.ops.log_event("job", "nightly ok", agent="app")
    fund_db.sql("select venue, count(*) n from funding group by 1", as_="pandas")
    fund_db.sql("select status, count(*) from pg.ops.job_runs group by 1", as_="rows")

    import { ops, transaction } from '@fund/db'
    await ops.logEvent('job', 'nightly ok', { agent: 'app' })

## Storage classes

What is kept, and for how long, is a class per series: **none** (live data, stored nowhere),
**cache** (anything a venue serves again: `~/fund-data/db/cache`, 500 MB, least-recently-read
month evicted first, idle months cleaned weekly by `python -m fund_db cache --clean`), **pin**
(the exact rows a recorded result used: `~/fund-data/db/pins`, content-addressed, never evicted)
and **archive** (forever, the lake: only what a venue will not serve again, declared per series).
Every write is resolved to its class before it lands; the rules and their mechanisms are in
[CLAUDE.md](CLAUDE.md).

    fund_db.market.declare_archive("exchange_a", [{"dataset": "candles"}], why="...", source="exchange_a venue config")
    h = fund_db.market.pin(dataset="candles", venue="exchange_a", symbol="BTC", interval="1h",
                           window="2026-07-15..2026-09-22", reason="run input", ref="lab/example#12")
    fund_db.pacer.take("exchange_a", cost=5)
    .venv\Scripts\python.exe -m fund_db cache --usage

The lake ships no venue adapter: a fetcher of your own writes rows through `fund_db.market` and
reads them back the same way.

## Layout

    migrations/<track>/NNN_*.sql   the schema, one numbered file per change (ops first, then market)
    schema/<schema>/<schema>.sql   GENERATED: the schema as the migrations leave it (read this)
    py/fund_db/                    the python package (cluster, migrate, ops, sql, importer, cli, pacer; market/, live/)
    node/                          @fund/db (TypeScript, pg)
    scripts/pg.py                  the cluster controller, runnable before anything is installed
    retention.toml                 how long each lake dataset stays hot, when it leaves, and the cache budget
    tests/                         python suites on throwaway clusters
