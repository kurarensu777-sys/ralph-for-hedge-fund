-- market 001: the lake catalog (fund_db.market.catalog): one row per series, refreshed by every
-- lake write, so coverage is a query and never a scan. The lake is the truth; this is derived and
-- can be rebuilt from it (python -m fund_db.market catalog --rebuild).
-- Column for column the DDL fund_db.market.catalog carried inline on 2026-09-25; IF NOT EXISTS so
-- a database that already holds the table from that inline DDL migrates cleanly.

CREATE SCHEMA IF NOT EXISTS market;

CREATE TABLE IF NOT EXISTS market.catalog (
    dataset      text    NOT NULL,
    venue        text    NOT NULL,
    "interval"   text    NOT NULL DEFAULT '',
    symbol       text    NOT NULL DEFAULT '',
    first_ts     bigint,
    last_ts      bigint,
    rows         bigint  NOT NULL DEFAULT 0,
    gaps         bigint,
    step_ms      bigint,
    by_src       jsonb   NOT NULL DEFAULT '{}'::jsonb,
    retention    text,
    covered_from bigint,
    covered_to   bigint,
    updated_ms   bigint  NOT NULL,
    PRIMARY KEY (dataset, venue, "interval", symbol)
);
CREATE INDEX IF NOT EXISTS catalog_symbol_idx ON market.catalog (symbol);
