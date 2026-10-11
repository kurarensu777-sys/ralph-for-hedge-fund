-- ops 003: the fund book's daily P&L series (B-0534).
--
--   fund_book_daily  one row per UTC day: the book's realised-plus-marked P&L in USD for that day.
--                    platform's fundplat.quant.core.fundbook reads it for every fund-book
--                    correlation; with no rows the correlation refuses with 0 days.
--
-- The table only. Nothing derives it today (no fills, orders or positions in the ops store); its
-- writer is execution's, once there is a book. day is the UTC date as 'YYYY-MM-DD', the same
-- text key as wire_snapshots.day. A restated day replaces its row (upsert on day), updated is
-- when it was written, epoch milliseconds.

CREATE TABLE ops.fund_book_daily (
  day              text PRIMARY KEY CHECK (day ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  pnl_usd          double precision NOT NULL,
  updated          bigint NOT NULL
);
