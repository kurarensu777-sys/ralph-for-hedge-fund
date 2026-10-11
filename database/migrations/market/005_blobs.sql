-- market 005: the BLOB seat of the PIN class (B-0648). Pinned bytes that are not rows of a lake
-- dataset: a study's reduced L2 ladders, the exchange day files it read, its derived tables. Each is
-- content-hashed and immutable, written once under (dataset, key); the file is
-- <data root>/pins/blobs/<hash[0:2]>/<hash>.blob, so two keys with the same bytes share one file.
-- `dataset` is a REGISTERED seat (fund_db.market.registry.BLOB_SEATS), never free text.
-- Never evicted, never deleted by an agent. Long form: fund_db.market.blobstore.

CREATE TABLE market.blobs (
    dataset      text    NOT NULL,
    "key"        text    NOT NULL,
    hash         text    NOT NULL,
    bytes        bigint  NOT NULL,
    meta         jsonb   NOT NULL DEFAULT '{}'::jsonb,   -- what the caller says the bytes are (format, window, counts)
    built_from   jsonb   NOT NULL DEFAULT '{}'::jsonb,   -- the inputs and code version a derived blob came from
    created_ms   bigint  NOT NULL,                       -- OUR clock when it was written, never a venue time
    PRIMARY KEY (dataset, "key"),
    CHECK (hash ~ '^[0-9a-f]{64}$'),
    CHECK (bytes > 0)
);
CREATE INDEX blobs_hash_idx ON market.blobs (hash);

-- one row per (blob, ref): many runs and studies may cite the same blob, as with market.pin_refs.
CREATE TABLE market.blob_refs (
    dataset      text    NOT NULL,
    "key"        text    NOT NULL,
    ref          text    NOT NULL,
    reason       text    NOT NULL,
    created_ms   bigint  NOT NULL,
    PRIMARY KEY (dataset, "key", ref),
    FOREIGN KEY (dataset, "key") REFERENCES market.blobs (dataset, "key")
);
CREATE INDEX blob_refs_ref_idx ON market.blob_refs (ref);
