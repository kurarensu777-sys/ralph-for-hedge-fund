-- market 004: the storage classes of the on-demand data plan (B-0322, the owner 2026-09-28; built by
-- B-0324). Four classes: NONE (stored nowhere), CACHE (anything a venue serves again: the cache root
-- beside the lake, a byte budget, least-recently-read months evicted), PIN (the exact rows a recorded
-- result used, content-addressed, immutable) and ARCHIVE (forever: only what a backtest needs AND the
-- venue will not serve again). Long form: fund_db.market.storage / cache / pins, fund_db.pacer.

-- Per-series ARCHIVE declarations. Each venue's list comes from its venue config
-- (`storage.archive`) through fund_db.market.declare_archive, which replaces the venue's whole list.
-- `symbol` and `interval` are fnmatch globs (case-sensitive; '*' = every one). The lake writer routes
-- a declared series to the archive and refuses an archive write for an undeclared one.
CREATE TABLE market.archive_decl (
    venue        text   NOT NULL,
    dataset      text   NOT NULL,
    symbol       text   NOT NULL DEFAULT '*',
    "interval"   text   NOT NULL DEFAULT '*',
    why          text   NOT NULL,
    source       text   NOT NULL,
    declared_ms  bigint NOT NULL,
    PRIMARY KEY (venue, dataset, symbol, "interval")
);

-- One row per month partition in the CACHE root: its size, when it was written and when it was last
-- READ, so eviction takes the least-recently-read month first. The disk is the truth; this table
-- orders it (a partition on disk with no row is ordered by its files' mtime).
CREATE TABLE market.cache_parts (
    dataset       text   NOT NULL,
    venue         text   NOT NULL,
    "interval"    text   NOT NULL DEFAULT '',
    month         text   NOT NULL,
    bytes         bigint NOT NULL DEFAULT 0,
    files         integer NOT NULL DEFAULT 0,
    written_ms    bigint NOT NULL,
    last_read_ms  bigint,
    PRIMARY KEY (dataset, venue, "interval", month),
    CHECK (month ~ '^\d{4}-\d{2}$')
);
CREATE INDEX cache_parts_read_idx ON market.cache_parts (coalesce(last_read_ms, written_ms));

-- PINS: one row per pinned CONTENT (the sha256 of the series' rows, fingerprint.py's per-input
-- digest), the file at <data root>/pins/<hash[0:2]>/<hash>.parquet; and one row per (content, ref)
-- - many runs and studies may pin the same rows. Never evicted, never deleted by an agent.
CREATE TABLE market.pins (
    hash         text    PRIMARY KEY,
    created_ms   bigint  NOT NULL,
    dataset      text    NOT NULL,
    venue        text    NOT NULL,
    symbol       text    NOT NULL,
    "interval"   text    NOT NULL DEFAULT '',
    what         text    NOT NULL DEFAULT '',
    window_from  bigint,
    window_to    bigint,
    first_ts     bigint,
    last_ts      bigint,
    rows         bigint  NOT NULL,
    bytes        bigint  NOT NULL,
    CHECK (hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX pins_series_idx ON market.pins (dataset, venue, symbol, "interval");

CREATE TABLE market.pin_refs (
    hash        text   NOT NULL REFERENCES market.pins (hash),
    ref         text   NOT NULL,
    reason      text   NOT NULL,
    created_ms  bigint NOT NULL,
    PRIMARY KEY (hash, ref)
);
CREATE INDEX pin_refs_ref_idx ON market.pin_refs (ref);

-- THE PACER: one token bucket per venue, shared by every process that calls a venue (notebooks,
-- dashboards, the market MCP, jobs). capacity = the burst, refill_per_s = the sustained rate, both
-- from the venue's fact card (`source`). backoff sets blocked_until_ms (an adaptive rule: a
-- pacing violation, a refusal). Request coalescing is a Postgres advisory lock on the
-- request key (fund_db.pacer.coalesce), so it needs no table.
CREATE TABLE market.pacer (
    venue             text    PRIMARY KEY,
    capacity          double precision NOT NULL,
    refill_per_s      double precision NOT NULL,
    tokens            double precision NOT NULL,
    refilled_ms       bigint  NOT NULL,
    blocked_until_ms  bigint,
    reason            text,
    source            text    NOT NULL,
    updated_ms        bigint  NOT NULL,
    CHECK (capacity > 0 AND refill_per_s > 0)
);
