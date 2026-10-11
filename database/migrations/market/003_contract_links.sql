-- market 003: the contract links (fund_db.market.contracts.write_contract_links), one row per
-- (venue, symbol, link_venue): "this contract on venue A IS that contract on venue B". The same
-- SR3 option is 'CME:SR3261211C96.5' on one venue and a numeric id on another; a link makes a
-- cross-check of their bars one query instead of a matching step every reader redoes.
--
-- Both ends must be registered contracts (the foreign keys): a link between two ids whose
-- identity nobody recorded proves nothing. The writer stores BOTH directions in one transaction,
-- so a lookup from either venue is one indexed read. SETTLED: a re-link of the same
-- (venue, symbol, link_venue) to a different link_symbol is refused and logged to the lake's
-- `conflicts` (dataset 'contract_links', kind 'link_changed'); the stored link is kept.
-- `method` says how the match was made ('identity': root, expiry, strike and right agreed;
-- 'manual'; ...), `src` who made it.

CREATE TABLE market.contract_links (
    venue        text   NOT NULL,
    symbol       text   NOT NULL,
    link_venue   text   NOT NULL,
    link_symbol  text   NOT NULL,
    method       text   NOT NULL,
    src          text   NOT NULL,
    first_seen   bigint NOT NULL,
    PRIMARY KEY (venue, symbol, link_venue),
    CHECK (venue <> link_venue),
    FOREIGN KEY (venue, symbol) REFERENCES market.contracts (venue, symbol),
    FOREIGN KEY (link_venue, link_symbol) REFERENCES market.contracts (venue, symbol)
);
CREATE INDEX contract_links_link_idx ON market.contract_links (link_venue, link_symbol);
