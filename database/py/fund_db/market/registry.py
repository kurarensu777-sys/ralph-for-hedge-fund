"""The dataset registry: every dataset the market lake holds, its typed schema, its row identity,
its merge rule and its partition layout. Pure data plus pyarrow types; nothing here touches disk.

A dataset lives at

    <lake>/<dataset>/<part_key>=<v>/[<sub_key>=<s>/]month=<YYYY-MM>/part-*.parquet

`part_key` is `venue` for every market dataset (snapshots partition by `log`, the desk snapshot
log a row came from). Partition columns are NOT stored inside the Parquet files: a reader gets
them back from the path (hive partitioning). `symbol` is always a column, never a folder.

MERGE RULES (the merge.py docstring is the long form):

    settled   funding, option_chains, cb_llm. A settled row is IMMUTABLE: a re-publish that
              differs is a conflict, kept out and logged; an optional field that was null and
              is now published is filled.
    bar       candles, contract_bars, predmkt_bars. The forming bar is replaced by the venue; a CLOSED venue bar is immutable
              (a differing one is a conflict); a venue bar replaces a seed bar (a differing
              c/h/l is logged, the venue wins); a seed bar only ever fills a hole.
    revise    eod, rates, cb_docs, cb_meetings, cb_votes, cb_projections. The publisher corrects late prints, so a differing re-publish REPLACES
              the stored row - and the replaced row is logged to the conflicts dataset as
              `revised`, so nothing is ever lost silently.
    observe   quotes, trades, prints, liquidations, predicted_funding, orderbook, options,
              predmkts, snapshots. Observations, not claims of a settled fact: an exact duplicate
              (every column but `seen`) is dropped, anything else is appended.

A PREDICTED funding rate is not the settled contract, so it has its own dataset,
`predicted_funding`, and is never written to, merged into or read through `funding`
(fund_db.live refuses a `funding` row that carries a prediction's `next_ts`).
    append    reserved: always appended (no dataset uses it today; conflicts is `observe`, so a
              re-run import never logs the same event twice).

STORAGE CLASSES (B-0322, the on-demand data plan; `Dataset.storage` is each dataset's default):

    none      stored nowhere: live frames, books, quotes, trades. A write is refused.
    cache     anything a venue serves again: written under the CACHE root (<data root>/cache, the
              same layout), evicted least-recently-read first past retention.toml [cache] max_bytes.
    pin       the exact rows a recorded result used, content-addressed and immutable (pinning.py);
              never a dataset default, and never reached through write(). Pinned bytes that are
              not lake rows are BLOBS under a seat of BLOB_SEATS (blobstore.py), PIN class too.
    archive   forever, in the lake (hot, then cold): a dataset whose default it is (conflicts, and
              snapshots - the loop's own readings, re-fetchable from nowhere), or a SERIES a venue
              declares archive (storage.py: declare_archive, from its venue.json). The writer
              refuses an archive write for anything else, and a cache write for anything archive.

Every row of every dataset carries `src` ("venue", "venue:ws", "seed:<label>", ...) and `seen`
(the ms it was written by us; null only where the source never recorded it - never invented).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pyarrow as pa

I64, F64, STR, BOOL, I32 = pa.int64(), pa.float64(), pa.string(), pa.bool_(), pa.int32()

RULES = ("settled", "bar", "revise", "observe", "append")
CLASSES = ("none", "cache", "pin", "archive")


@dataclass(frozen=True)
class Dataset:
    name: str
    fields: tuple                      # ((column, pyarrow type), ...) stored in the Parquet file
    time_col: str                      # the column that picks the month partition
    time_kind: str                     # "ms" (epoch ms int) | "date" ("YYYY-MM-DD")
    rule: str
    key: tuple                         # row identity inside one partition (see observe below)
    required: tuple                    # columns that may never be null
    values: tuple = ()                 # settled/bar/revise: the columns a conflict compares
    fill: tuple = ()                   # settled: optional columns a later publish may fill
    part_key: str = "venue"
    sub_key: str | None = None         # candles: "interval"
    series: tuple = ("symbol",)        # the catalog series identity inside a partition
    archive: bool = False              # never pruned (retention may still tier it)
    storage: str = "cache"             # the default storage class (see STORAGE CLASSES above)
    grid: str | None = None            # how the catalog counts gaps: "interval" | "median" | None
    sort: tuple = ()
    doc: str = ""
    extra: dict = field(default_factory=dict)

    @property
    def columns(self) -> tuple:
        return tuple(c for c, _ in self.fields)

    @property
    def schema(self) -> pa.Schema:
        return pa.schema([pa.field(c, t, nullable=c not in self.required) for c, t in self.fields])

    def type_of(self, col: str) -> pa.DataType:
        return dict(self.fields)[col]

    @property
    def partition_keys(self) -> tuple:
        return (self.part_key,) + ((self.sub_key,) if self.sub_key else ())

    @property
    def identity(self) -> tuple:
        """The columns that identify a row. For `observe` it is every column but `seen`, which is
        what makes an exact re-delivery a duplicate and anything else a new observation."""
        if self.rule == "observe":
            return tuple(c for c in self.columns if c != "seen")
        return self.key


def _ds(name, fields, **kw) -> Dataset:
    return Dataset(name=name, fields=tuple(fields), **kw)


_OBS_TAIL = (("ts_src", STR), ("src", STR), ("seen", I64))

_CB_DOC = ("Central bank dataset (B-0541), partition `venue` is the bank: fed, boj or ecb. ARCHIVE "
           "class by the dataset default: the LLM readings cost money and no venue serves them again. "
           "A raw PDF or HTML is stored NOWHERE (parsed in memory, its sha256 kept). ")
CB_DATASETS = ("cb_docs", "cb_meetings", "cb_votes", "cb_projections", "cb_llm")
CB_VENUES = ("fed", "boj", "ecb")

DATASETS: dict[str, Dataset] = {d.name: d for d in (
    _ds("funding",
        [("symbol", STR), ("ts", I64), ("rate", F64), ("interval_h", F64), ("interval_src", STR),
         ("rate_type", STR), ("premium", F64), ("src", STR), ("seen", I64)],
        time_col="ts", time_kind="ms", rule="settled", key=("symbol", "ts"),
        required=("symbol", "ts", "rate", "src"),
        values=("rate", "premium", "interval_h", "rate_type"),
        fill=("premium", "interval_h", "interval_src", "rate_type"),
        archive=True, grid="median", sort=("symbol", "ts"),
        doc="Settled funding, the fundplat settled-funding row contract column for column. `ts` "
            "is the settlement ms AS PUBLISHED (never rounded to the grid). `interval_h` is "
            "stored only when the VENUE published it, and then `interval_src` = 'venue'; an "
            "inferred cadence is never stored (fundplat applies map/gap/neighbour at read time). "
            "`rate_type` only where the venue publishes one (e.g. 'regular'/'special'). A "
            "predicted rate is never stored here: it goes to `predicted_funding`."),
    _ds("candles",
        [("symbol", STR), ("t", I64), ("o", F64), ("h", F64), ("l", F64), ("c", F64), ("v", F64),
         ("n", I64), ("closed", BOOL), ("src", STR), ("seen", I64)],
        time_col="t", time_kind="ms", rule="bar", key=("symbol", "t"),
        required=("symbol", "t", "closed", "src"), values=("o", "h", "l", "c", "v"),
        sub_key="interval", archive=True, grid="interval", sort=("symbol", "t"),
        doc="OHLCV bars keyed on the OPEN ms `t`; `closed` = the bar had fully closed when "
            "stored. A seed bar may lack h/l (partial)."),
    _ds("contract_bars",
        [("symbol", STR), ("t", I64), ("date", STR), ("what", STR), ("o", F64), ("h", F64),
         ("l", F64), ("c", F64), ("v", F64), ("wap", F64), ("n", I64), ("data_type", STR),
         ("closed", BOOL), ("src", STR), ("seen", I64)],
        time_col="t", time_kind="ms", rule="bar", key=("symbol", "what", "t"),
        required=("symbol", "t", "what", "data_type", "closed", "src"),
        values=("o", "h", "l", "c", "v", "wap", "n"),
        sub_key="interval", archive=True, sort=("symbol", "what", "t"),
        doc="Bars of a LISTED CONTRACT as a tradfi venue served them (stocks, FX, futures "
            "incl. expired, futures options). `symbol` is the venue's own contract id "
            "(a broker's numeric id in decimal), NEVER a display label - a one-digit-year local symbol "
            "(SR3Z6) is reused every decade; what the id is lives in the Postgres table "
            "market.contracts, and a bar for an id not registered there is refused. `what` is the "
            "venue's bar kind verbatim (e.g. 'TRADES', 'MIDPOINT', 'BID_ASK', ...), "
            "part of the identity: two kinds of bar of one contract are two rows. `t` is the bar's "
            "OPEN, epoch ms UTC; for 1d/1w bars `date` is the trade date as the venue labels it "
            "and `t` is UTC midnight of it (a label, not the session's open instant). "
            "`data_type` is the market data type the bar was served under ('live' | 'frozen' | "
            "'delayed' | 'delayed_frozen'), provenance and not identity. `closed`: the caller's "
            "session-aware judgement where given (required for 1d/1w: a daily close is a session "
            "fact, not arithmetic); else t + interval <= closed_asof_ms, which a delayed row must "
            "pass. Bar rule: a closed bar is immutable, a re-served different one is a conflict."),
    _ds("quotes",
        [("symbol", STR), ("ts", I64), ("bid", F64), ("ask", F64), ("bid_sz", F64),
         ("ask_sz", F64), ("mid", F64), ("last", F64), ("mark", F64), ("index_px", F64),
         ("seq", I64), *_OBS_TAIL],
        time_col="ts", time_kind="ms", rule="observe", key=("symbol", "ts"),
        required=("symbol", "ts", "src"), sort=("symbol", "ts"),
        storage="none", doc="Top-of-book / mark observations. `ts_src` = 'venue' when the venue stamped the "
            "time, 'recv' when it is our receive time."),
    _ds("trades",
        [("symbol", STR), ("ts", I64), ("px", F64), ("sz", F64), ("side", STR),
         ("trade_id", STR), *_OBS_TAIL],
        time_col="ts", time_kind="ms", rule="observe", key=("symbol", "ts"),
        required=("symbol", "ts", "px", "src"), sort=("symbol", "ts"),
        storage="none", doc="Public trades as the venue printed them."),
    _ds("prints",
        [("symbol", STR), ("ts", I64), ("px", F64), ("sz", F64), ("side", STR),
         ("trade_id", STR), *_OBS_TAIL],
        time_col="ts", time_kind="ms", rule="observe", key=("symbol", "ts"),
        required=("symbol", "ts", "px", "sz", "side", "src"), sort=("symbol", "ts"),
        storage="none", doc="The TAPE: every public print with its size, unlike `trades`, which may hold a "
            "sampled last print without one. `ts` is the venue's event ms, `sz` the size in BASE "
            "units (> 0), `side` the AGGRESSOR side, 'buy' | 'sell'. fund_db.live refuses a row "
            "missing any of them at record time."),
    _ds("liquidations",
        [("symbol", STR), ("ts", I64), ("side", STR), ("px", F64), ("sz", F64),
         ("liq_id", STR), *_OBS_TAIL],
        time_col="ts", time_kind="ms", rule="observe", key=("symbol", "ts"),
        required=("symbol", "ts", "side", "px", "sz", "src"), sort=("symbol", "ts"),
        storage="none", doc="Public liquidation prints, one row per liquidation order the venue published "
            "(the venue is the partition). `ts` is the venue's event ms, `px` the price it "
            "printed, `sz` the size in BASE units (> 0), `side` the side of the liquidation "
            "ORDER, 'buy' | 'sell' (a long is liquidated by a sell). fund_db.live refuses a row "
            "missing any of them at record time."),
    _ds("predicted_funding",
        [("symbol", STR), ("ts", I64), ("rate", F64), ("interval_h", F64), ("next_ts", I64),
         *_OBS_TAIL],
        time_col="ts", time_kind="ms", rule="observe", key=("symbol", "ts"),
        required=("symbol", "ts", "rate", "interval_h", "next_ts", "src"), sort=("symbol", "ts"),
        storage="none", doc="PREDICTED funding as the venue published it, the funding atomic unit (rate, "
            "interval_h, next_ts): `ts` the ms the prediction was observed, `rate` the predicted "
            "rate for the interval that settles at `next_ts`, `interval_h` that interval as the "
            "venue published it (never assumed). Its OWN dataset: a prediction is not the "
            "settled contract, so it is never written to, merged into or read through "
            "`funding`, and fund_db.market.funding() never returns one."),
    _ds("orderbook",
        [("symbol", STR), ("ts", I64), ("side", STR), ("level", I32), ("px", F64), ("sz", F64),
         ("seq", I64), *_OBS_TAIL],
        time_col="ts", time_kind="ms", rule="observe", key=("symbol", "ts"),
        required=("symbol", "ts", "side", "level", "px", "src"),
        sort=("symbol", "ts", "side", "level"),
        storage="none", doc="Order book snapshots, one row per level; side 'bid'|'ask', level 0 = best."),
    _ds("options",
        [("symbol", STR), ("ts", I64), ("underlying", STR), ("expiry", I64), ("strike", F64),
         ("kind", STR), ("bid", F64), ("ask", F64), ("mark", F64), ("bid_iv", F64),
         ("ask_iv", F64), ("mark_iv", F64), ("delta", F64), ("gamma", F64), ("vega", F64),
         ("theta", F64), ("open_interest", F64), ("volume", F64), ("underlying_px", F64),
         ("index_px", F64), *_OBS_TAIL],
        time_col="ts", time_kind="ms", rule="observe", key=("symbol", "ts"),
        required=("symbol", "ts", "src"), sort=("symbol", "ts"),
        doc="Option chain observations; `symbol` is the venue instrument id, `kind` 'C'|'P'."),
    _ds("option_chains",
        [("symbol", STR), ("ts", I64), ("underlying", STR), ("root", STR), ("expiry", STR),
         ("strike", F64), ("right", STR), ("bid", F64), ("ask", F64), ("last", F64), ("iv", F64),
         ("bid_iv", F64), ("ask_iv", F64), ("delta", F64), ("gamma", F64), ("vega", F64),
         ("theta", F64), ("rho", F64), ("theo", F64), ("volume", F64), ("open_interest", F64),
         ("underlying_px", F64), ("data_type", STR), ("raw", STR), ("src", STR), ("seen", I64)],
        time_col="ts", time_kind="ms", rule="settled", key=("symbol", "ts"),
        required=("symbol", "ts", "underlying", "expiry", "strike", "right", "data_type", "raw", "src"),
        values=("raw", "bid", "ask", "last", "iv", "bid_iv", "ask_iv", "delta", "gamma", "vega",
                "theta", "rho", "theo", "volume", "open_interest", "underlying_px"),
        archive=True, sort=("symbol", "ts"),
        doc="Option CHAIN SNAPSHOTS of a listed-contract venue (a charting "
            "venue's options scanner, say): one row per option per read, the IV surface archive. `ts` is OUR "
            "read time (epoch ms, one per read, shared by every row of it); `symbol` the venue's "
            "option symbol verbatim; `underlying` the venue symbol of what it is on; `expiry` "
            "'YYYY-MM-DD'; `right` 'C'|'P'. Every typed value is what the venue served, null "
            "where it served none - never derived. `raw` is the served row verbatim as canonical "
            "JSON, so a field without a column is never lost; `data_type` as contract_bars "
            "('delayed' for a delayed exchange feed). SETTLED on (symbol, ts), and `raw` is the "
            "primary value: ANY re-served difference at one read time is a conflict "
            "(settled_row_changed), never an overwrite. Distinct from `options` (observe; crypto "
            "venues' instrument snapshots, expiry an instant)."),
    _ds("predmkts",
        [("symbol", STR), ("ts", I64), ("outcome", STR), ("bid", F64), ("ask", F64),
         ("mid", F64), ("last", F64), ("volume", F64), ("open_interest", F64), *_OBS_TAIL],
        time_col="ts", time_kind="ms", rule="observe", key=("symbol", "ts"),
        required=("symbol", "ts", "src"), sort=("symbol", "ts"),
        doc="Prediction-market quotes; `symbol` is the venue market id, prices in the venue's "
            "own unit (probability 0..1 as normalized by the fetcher)."),
    _ds("predmkt_bars",
        [("symbol", STR), ("t", I64), ("outcome", STR), ("px_kind", STR),
         ("o", F64), ("h", F64), ("l", F64), ("c", F64), ("mean", F64), ("prev", F64),
         ("bid_o", F64), ("bid_h", F64), ("bid_l", F64), ("bid_c", F64),
         ("ask_o", F64), ("ask_h", F64), ("ask_l", F64), ("ask_c", F64),
         ("v", F64), ("oi", F64), ("closed", BOOL), ("src", STR), ("seen", I64)],
        time_col="t", time_kind="ms", rule="bar", key=("symbol", "t"),
        required=("symbol", "t", "outcome", "px_kind", "closed", "src"),
        values=("px_kind", "o", "h", "l", "c", "mean", "prev", "bid_o", "bid_h", "bid_l", "bid_c",
                "ask_o", "ask_h", "ask_l", "ask_c", "v", "oi"),
        sub_key="interval", archive=True, sort=("symbol", "t"),
        doc="Price history of ONE OUTCOME of a prediction market as the venue served it "
            "(a prices-history feed or a candlestick feed). Prices are probabilities 0..1 (the "
            "writer refuses anything outside, which catches cents read as dollars). `symbol` is "
            "'<venue id>@<listed_ms>': the venue's own id of the outcome (a CLOB "
            "token id, or a market ticker for its YES side) and the ms the listing opened, so "
            "a re-listed market is a new series and never merges into the old one; a bar dated "
            "before its listing opened is refused. `outcome` is the venue's label verbatim "
            "('Yes', 'No', 'Up', 'yes', ...). `t` is the bar's OPEN, epoch ms UTC (a venue "
            "that serves the END is converted: t = end - interval); `closed` as candles. `px_kind` says what the "
            "price columns are: 'ohlc' (traded-price o/h/l/c over the bar, plus `mean` and `prev`, "
            "the last trade before the bar, where served; a bar with no trade carries all four "
            "null) or 'sample' (a venue that serves one sampled price per step, not a candle: only "
            "`c` is set, never a fabricated o/h/l). `bid_*` and `ask_*` are the YES bid and ask "
            "o/h/l/c where served, each group all-or-none. `v` is the contracts traded "
            "in the bar and `oi` open interest at its close, null where the venue serves none "
            "(some venues serve neither). Bar rule: a closed bar is immutable, a re-served "
            "different one is a conflict."),
    _ds("cb_docs",
        [("doc_type", STR), ("url", STR), ("title", STR), ("meeting_date", STR), ("publish_date", STR),
         ("sha256", STR), ("bytes", I64), ("text", STR), ("words", I32), ("src", STR), ("seen", I64)],
        time_col="meeting_date", time_kind="date", rule="revise", key=("url",),
        required=("doc_type", "url", "meeting_date", "sha256", "text", "src"),
        values=("doc_type", "title", "meeting_date", "publish_date", "sha256", "bytes", "text", "words"),
        storage="archive", archive=True, series=(), sort=("meeting_date", "url"),
        extra={"moves_across_months": True},
        doc=_CB_DOC + "ONE DOCUMENT of a central bank (statement, minutes, projections, ...), "
            "identified by its `url`; `doc_type` is the bank's own kind of it. `text` is the extracted "
            "text (up to about 200 KB; the writer refuses over 2,000,000 characters, an empty text, a "
            "NUL or a '%PDF' start, which would be the raw file), `sha256` the hash of the raw file "
            "(lowercase hex) and `bytes` its size where known (a seeded document has none), `words` "
            "the word count of `text`. `meeting_date` is the policy meeting it belongs to and "
            "picks the month partition. Revise rule on (url): a re-fetched document that differs "
            "replaces the stored one and the old one goes to conflicts as 'revised'. A url already "
            "stored under ANOTHER meeting_date month of the same bank MOVES (B-0544): the new row "
            "is written in its month, the old one is logged 'revised' and then removed from its "
            "partition, so a url is one row. A seed never moves a row (seed_vs_stored)."),
    _ds("cb_meetings",
        [("meeting_date", STR), ("decision", STR), ("summary", STR), ("rate_target", STR),
         ("classify_version", STR), ("status", STR), ("src", STR), ("seen", I64)],
        time_col="meeting_date", time_kind="date", rule="revise", key=("meeting_date",),
        required=("meeting_date", "status", "src"),
        values=("decision", "summary", "rate_target", "classify_version", "status"),
        storage="archive", archive=True, series=(), sort=("meeting_date",),
        doc=_CB_DOC + "ONE POLICY MEETING: the reading of its decision. `status` is 'pending' (not "
            "classified yet), 'done' or 'needs_review'; `decision`, `summary` and `rate_target` are "
            "null until the meeting is classified, `classify_version` names the prompt version that "
            "did it. Revise rule on (meeting_date): a re-classification replaces the stored row and "
            "the old reading goes to conflicts as 'revised'."),
    _ds("cb_votes",
        [("meeting_date", STR), ("item", STR), ("member", STR), ("role", STR), ("vote", STR),
         ("source_url", STR), ("dissent_text", STR), ("proposed_alternative", STR), ("direction", STR),
         ("reason", STR), ("quote", STR), ("src", STR), ("seen", I64)],
        time_col="meeting_date", time_kind="date", rule="revise", key=("meeting_date", "item", "member"),
        required=("meeting_date", "item", "member", "vote", "src"),
        values=("role", "vote", "source_url", "dissent_text", "proposed_alternative", "direction",
                "reason", "quote"),
        storage="archive", archive=True, series=(), sort=("meeting_date", "item", "member"),
        doc=_CB_DOC + "ONE MEMBER AT ONE MEETING on one `item` (a voted block, or the attendance "
            "row). `vote` is 'for', 'against' or 'present'; an attendance row has item 'attendance' "
            "and vote 'present' (the writer refuses any other vote on that item). The dissent "
            "columns are null where the member did not dissent. Revise rule on "
            "(meeting_date, item, member)."),
    _ds("cb_projections",
        [("meeting_date", STR), ("source_url", STR), ("stat", STR), ("variable", STR),
         ("horizon", STR), ("bucket", STR), ("value", F64), ("src", STR), ("seen", I64)],
        time_col="meeting_date", time_kind="date", rule="revise",
        key=("meeting_date", "variable", "horizon", "stat", "bucket"),
        required=("meeting_date", "stat", "variable", "horizon", "bucket", "value", "src"),
        values=("source_url", "value"),
        storage="archive", archive=True, series=(),
        sort=("meeting_date", "variable", "horizon", "stat", "bucket"),
        doc=_CB_DOC + "ONE PROJECTION CELL of a meeting's projection table. `stat` is 'median', "
            "'dot', 'baseline', 'range_lo', 'range_hi' or 'actual' (the low and high bound of the range of the "
            "majority's forecasts, as in the BOJ Outlook Report, beside that table's median; an actual is the single figure printed for a fiscal year already observed); `bucket` "
            "is '' (the empty string, never null: it is part of the key) for a median, a range bound or an actual "
            "and the rate bucket for a dot, and the writer refuses a dot with no bucket and a median, range bound or "
            "actual with one. `horizon` is the bank's own label ('2026', 'longer run'), "
            "`value` a finite number in the variable's own unit (a dot's value is the count of "
            "participants). Revise rule on the cell."),
    _ds("cb_llm",
        [("key", STR), ("task", STR), ("subject", STR), ("prompt_version", STR), ("model", STR),
         ("response", STR), ("created", I64), ("src", STR), ("seen", I64)],
        time_col="created", time_kind="ms", rule="settled", key=("key",),
        required=("key", "task", "subject", "prompt_version", "model", "response", "created", "src"),
        values=("response", "task", "subject", "prompt_version", "model"),
        storage="archive", archive=True, series=(), sort=("created", "key"),
        doc=_CB_DOC + "ONE CACHED LLM ANSWER, keyed on the sha256 (lowercase hex) of what was asked. "
            "`task` is 'classify' or 'doc_analysis', `subject` the document url or the meeting "
            "date it was about, `response` the answer as JSON text (the writer refuses text that is "
            "not JSON), `created` the ms it was produced. These cost money and no venue serves "
            "them again. Settled rule on (key): an answer is never overwritten, a differing "
            "second answer is a conflict and the stored one stands. `created` picks the month "
            "partition, so a caller checks the key (read) before it asks again: the same key "
            "written in a later month would be a second row."),
    _ds("eod",
        [("symbol", STR), ("date", STR), ("time", I64), ("open", F64), ("high", F64),
         ("low", F64), ("close", F64), ("adj_close", F64), ("volume", F64), ("src", STR),
         ("seen", I64)],
        time_col="date", time_kind="date", rule="revise", key=("symbol", "date"),
        required=("symbol", "date", "time", "src"),
        values=("open", "high", "low", "close", "adj_close", "volume"),
        archive=True, sort=("symbol", "date"),
        doc="End-of-day bars. `close` is the UNADJUSTED close; `time` = UTC midnight of "
            "`date` in ms. A re-published bar replaces the stored one (an end-of-day feed "
            "corrects late prints); the replaced bar goes to conflicts as 'revised'."),
    _ds("rates",
        [("symbol", STR), ("date", STR), ("field", STR), ("tenor", STR), ("value", F64),
         ("src", STR), ("seen", I64)],
        time_col="date", time_kind="date", rule="revise", key=("symbol", "field", "tenor", "date"),
        required=("symbol", "date", "field", "tenor", "src"), values=("value",),
        archive=True, sort=("symbol", "field", "tenor", "date"),
        doc="Published rate curves, one row per (feed, field, tenor, date). venue='treasury': "
            "symbol = the feed (daily_treasury_bill_rates | daily_treasury_yield_curve), field = "
            "the source's own key ('ce' | 'discount' for bills, 'tenors' for the par curve)."),
    _ds("snapshots",
        [("ts", STR), ("t", I64), ("desk", STR), ("subject", STR), ("field", STR),
         ("value", F64), ("is_int", BOOL), ("unit", STR), ("provenance", STR), ("source", STR),
         ("note", STR), ("src", STR), ("seen", I64)],
        time_col="t", time_kind="ms", rule="observe", key=("desk", "subject", "field", "ts"),
        required=("ts", "t", "desk", "subject", "field", "src"), part_key="log", series=(),
        sort=("t", "desk", "subject", "field"),
        storage="archive", doc="Probe and desk snapshot readings. `ts` is the ISO stamp exactly as written, `t` its "
            "epoch ms; `is_int` keeps an integer reading an integer on the way back out."),
    _ds("conflicts",
        [("logged", I64), ("dataset", STR), ("symbol", STR), ("interval", STR), ("key", STR),
         ("kind", STR), ("stored", STR), ("incoming", STR)],
        time_col="logged", time_kind="ms", rule="observe", key=(),
        required=("logged", "dataset", "kind"), archive=True, series=(),
        sort=("logged",),
        storage="archive", doc="The evidence log: every settled row a venue re-published differently, every revised "
            "bar, every seed/venue disagreement. `stored` and `incoming` are the two rows as JSON. "
            "Observe rule: an exact re-delivery (a re-run import) is one event, never two."),
)}

for _d in DATASETS.values():
    assert _d.storage in CLASSES and _d.storage != "pin", f"{_d.name}: storage {_d.storage!r}"

@dataclass(frozen=True)
class BlobSeat:
    """A registered seat for PINNED BYTES that are not rows of a lake dataset (B-0648). PIN class
    only: written once under (seat, key), content-hashed, never evicted, never deleted by an agent.
    The seat names what the bytes are for; the bytes' own format is the caller's (platform keeps
    its read functions) and travels in the blob's `meta`. A seat is added here, in a commit of this
    repo: a typo in a seat name is refused, never a new seat."""
    name: str
    venue: str                         # the venue the bytes came from ("" when the seat is not one venue's)
    doc: str


BLOB_SEATS: dict[str, BlobSeat] = {s.name: s for s in (
    BlobSeat("raw", "",
             "Raw input files a study read as served (archive day files, reduced order-book "
             "ladders), one blob per file, the key the study's own relative path, e.g. "
             "'l2/2026-10-06/btc/a.bin'. PIN class: the study's exact inputs, kept even when the "
             "source serves them again."),
    BlobSeat("derived", "",
             "A study's DERIVED tables: a day of decisions, fills and plot data built from pinned "
             "inputs. The key is '<table>/<key>', the code version in it ('days/2026-10-03@v2'); "
             "`built_from` names the input pins."),
)}

BLOB_KEY_RE = r"^[A-Za-z0-9._@=+-]+(/[A-Za-z0-9._@=+-]+)*$"
BLOB_KEY_MAX = 200


def blob_seat(name: str) -> BlobSeat:
    try:
        return BLOB_SEATS[name]
    except KeyError:
        raise KeyError(f"unknown blob seat {name!r}; registered: {', '.join(sorted(BLOB_SEATS))}") from None


# Files that stay files: runtime data a vendored app reads as JSON, reference trees, vault
# snapshots, the store's wire state. They live at <lake>/_files/<name>/ verbatim.
FILES_DIR = "_files"


def get(name: str) -> Dataset:
    try:
        return DATASETS[name]
    except KeyError:
        raise KeyError(f"unknown dataset {name!r}; known: {', '.join(sorted(DATASETS))}") from None


INTERVAL_MS = {
    "1s": 1_000, "5s": 5_000, "10s": 10_000, "15s": 15_000, "30s": 30_000,
    "1m": 60_000, "2m": 120_000, "3m": 180_000, "5m": 300_000, "10m": 600_000, "15m": 900_000,
    "20m": 1_200_000, "30m": 1_800_000,
    "1h": 3_600_000, "2h": 7_200_000, "3h": 10_800_000, "4h": 14_400_000, "8h": 28_800_000,
    "12h": 43_200_000, "1d": 86_400_000, "3d": 259_200_000, "1w": 604_800_000,
}
# No month bar: a month has no fixed length, and on a case-insensitive disk "1M" is "1m".

# contract_bars: the market data types a venue may serve a bar under (four, by name) and
# the bar sizes whose close is a SESSION fact the caller must state (never t + interval).
DATA_TYPES = ("live", "frozen", "delayed", "delayed_frozen")
SESSION_INTERVALS = ("1d", "1w")


def interval_ms(interval: str) -> int:
    try:
        return INTERVAL_MS[interval]
    except KeyError:
        raise ValueError(f"unknown candle interval {interval!r}; known: {', '.join(INTERVAL_MS)}") from None
