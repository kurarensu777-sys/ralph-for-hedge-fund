-- market 002: the contract reference (fund_db.market.contracts), one row per (venue, symbol) across
-- all time. The lake's `contract_bars` key every bar on `symbol`, the venue's own contract id
-- (e.g. a broker's numeric id in decimal), never on a display label: a local symbol with a one-digit year
-- (SR3Z6) is reused every decade, a conId is not. This table says what each id IS - a bar is
-- written only for a contract registered here (fund_db.market refuses the rest).
--
-- The identity columns are SETTLED: fund_db.market.write_contracts fills a null and never
-- overwrites a value; a re-served contract that differs is refused and logged to the lake's
-- `conflicts` dataset (dataset 'contracts', kind 'contract_changed'). `raw` is the venue's
-- contract details as FIRST served, verbatim; `last_seen` is the only column a re-serve moves.

CREATE TABLE market.contracts (
    venue            text    NOT NULL,
    symbol           text    NOT NULL,
    con_id           bigint,
    sec_type         text    NOT NULL,
    underlying       text,
    local_symbol     text,
    trading_class    text,
    exchange         text,
    primary_exchange text,
    currency         text,
    multiplier       text,
    last_trade_date  text,
    contract_month   text,
    strike           double precision,
    "right"          text,
    under_con_id     bigint,
    time_zone        text,
    description      text,
    raw              jsonb   NOT NULL DEFAULT '{}'::jsonb,
    src              text    NOT NULL,
    first_seen       bigint  NOT NULL,
    last_seen        bigint  NOT NULL,
    PRIMARY KEY (venue, symbol),
    CHECK ("right" IS NULL OR "right" IN ('C', 'P')),
    CHECK (last_trade_date IS NULL OR last_trade_date ~ '^\d{4}-\d{2}-\d{2}$'),
    CHECK (contract_month IS NULL OR contract_month ~ '^\d{4}-\d{2}$')
);
CREATE INDEX contracts_underlying_idx ON market.contracts (venue, underlying, sec_type, last_trade_date);
CREATE INDEX contracts_under_con_idx ON market.contracts (venue, under_con_id);
