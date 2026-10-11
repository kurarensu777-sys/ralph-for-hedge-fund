"""The lake readers. Every reader lists exactly the part files it needs (partition folders pruned
by venue, interval and month, across the lake's hot and cold tiers AND the cache root, in-flight
rewrites hidden; a cache month read is marked read, which is what eviction orders on), hands that list to DuckDB
in-process, filters there, and returns a pyarrow Table (default), a pandas DataFrame
(as_="pandas") or a list of dicts (as_="rows").

Times: `start` / `end` are INCLUSIVE and accept epoch ms, a datetime, a pandas Timestamp or an
ISO string ("2026-09-01", "2026-09-01T08:00:00Z"; a naive one is UTC). Date datasets (eod,
rates) compare on the date.

The partition columns come back as ordinary columns (`venue` / `interval` / `log`), `month`
does not (it is only a folder).
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import pyarrow as pa

from . import layout
from .registry import DATASETS, Dataset, get


def to_ms(v) -> int | None:
    if v is None:
        return None
    if isinstance(v, bool):
        raise TypeError("a bool is not a time")
    if isinstance(v, (int, float)):
        return int(v)
    if hasattr(v, "to_pydatetime"):
        v = v.to_pydatetime()
    if isinstance(v, datetime):
        return int((v if v.tzinfo else v.replace(tzinfo=timezone.utc)).timestamp() * 1000)
    if isinstance(v, str):
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        return int((dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp() * 1000)
    raise TypeError(f"cannot read {v!r} as a time")


def to_date(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, str) and len(v) == 10:
        return v
    return datetime.fromtimestamp(to_ms(v) / 1000, timezone.utc).strftime("%Y-%m-%d")


def files(ds: Dataset, part: str | None = None, sub: str | None = None,
          start_ms: int | None = None, end_ms: int | None = None,
          tiers: tuple = ("hot", "cold", "cache")) -> list[tuple[Path, dict]]:
    """[(part file, {partition values})] a read must open."""
    from .retention import read_roots
    from .writer import hidden_by_journals
    months = None
    if start_ms is not None or end_ms is not None:
        lo = start_ms if start_ms is not None else 0
        hi = end_ms if end_ms is not None else 4102444800000      # 2100-01-01
        months = layout.months_between(lo, hi)
    roots = read_roots(ds)
    pdirs = [p for t in tiers if t in roots for p in layout.partitions(roots[t], ds, part, sub, months)]
    hide = hidden_by_journals(pdirs)
    out = []
    for p in pdirs:
        vals = layout.parse_partition(ds, p)
        for f in layout.part_files(p):
            if os.path.normcase(str(f)) not in hide:
                out.append((f, vals))
    return out


def _empty(ds: Dataset, cols: list[str]) -> pa.Table:
    fields = [pa.field(k, pa.string()) for k in ds.partition_keys] + list(ds.schema)
    by = {f.name: f for f in fields}
    return pa.schema([by[c] for c in cols]).empty_table()


def _out(tbl: pa.Table, as_: str):
    if as_ == "arrow":
        return tbl
    if as_ == "pandas":
        return tbl.to_pandas()
    if as_ == "rows":
        return tbl.to_pylist()
    raise ValueError(f"as_ must be arrow | pandas | rows, not {as_!r}")


def _lit(v) -> str:
    return "'" + str(v).replace("'", "''") + "'"


def _union(ds: Dataset, fl: list[tuple[Path, dict]]) -> str:
    """One SELECT per partition with its values as exact constants (never parsed back from a
    path), glued with UNION ALL BY NAME so parts written before a column existed still read."""
    groups: dict[tuple, list[str]] = {}
    for f, vals in fl:
        groups.setdefault(tuple(vals[k] for k in ds.partition_keys), []).append(
            _lit(str(f).replace("\\", "/")))
    sel = []
    for g, fs in groups.items():
        consts = ", ".join(f'{_lit(v)} AS "{k}"' for k, v in zip(ds.partition_keys, g))
        sel.append(f"SELECT {consts}, * FROM read_parquet([{', '.join(fs)}], union_by_name=true, hive_partitioning=false)")
    return " UNION ALL BY NAME ".join(sel)


def read(dataset: str, venue: str | None = None, *, symbols=None, interval: str | None = None,
         start=None, end=None, cols=None, where: str | None = None, params=None,
         as_: str = "arrow", tiers: tuple = ("hot", "cold", "cache"), include_live: bool = False):
    """The one generic reader behind every typed one.

    venue     the partition value (snapshot log name for snapshots); None = every one
    symbols   a symbol or a list of them (None = all)
    cols      the columns to return (default: partition keys + every stored column)
    where     an extra DuckDB predicate over the stored columns, with `params` for its ?s
    include_live  also read the live hot log (rows not yet rolled into the lake)."""
    ds = get(dataset)
    if venue is not None and ds.part_key == "venue":
        venue = venue.lower()
    if isinstance(symbols, str):
        symbols = [symbols]
    if ds.time_kind == "date":
        d0, d1 = to_date(start), to_date(end)
        s_ms = layout.month_start_ms(d0[:7]) if d0 else None
        e_ms = layout.month_end_ms(d1[:7]) - 1 if d1 else None
    else:
        d0 = d1 = None
        s_ms, e_ms = to_ms(start), to_ms(end)
    all_cols = list(ds.partition_keys) + list(ds.columns)
    cols = list(cols) if cols else all_cols
    bad = [c for c in cols if c not in all_cols]
    if bad:
        raise ValueError(f"{dataset} has no column(s) {bad}; it has {all_cols}")
    live_tbl = None
    if include_live:
        from fund_db import live
        live_tbl = live.hot_table(dataset, venue=venue, interval=interval)
    # A writer may finish a rewrite (a merge, a compaction, a row removal) between the listing and
    # the read, so a listed part is gone by the time DuckDB opens it; its rows are in the new part.
    # That read is retried on a fresh listing - only while a listed file really vanished, a
    # bounded number of times - never answered from a half-listed partition.
    for attempt in range(READ_RETRIES + 1):
        fl = files(ds, venue, interval, s_ms, e_ms, tiers)
        if not fl and (live_tbl is None or live_tbl.num_rows == 0):
            return _out(_empty(ds, cols), as_)
        try:
            tbl = _query(ds, fl, live_tbl, all_cols, cols, venue, interval, symbols, d0, d1,
                         s_ms, e_ms, start, end, where, params)
            from .cache import touch_read
            touch_read(fl, ds)             # the cache months this read opened (eviction order)
            break
        except duckdb.IOException:
            if attempt == READ_RETRIES or all(p.exists() for p, _ in fl):
                raise
            time.sleep(0.02 * (attempt + 1))
    target = _empty(ds, cols).schema
    return _out(tbl.cast(target) if tbl.schema != target else tbl, as_)


READ_RETRIES = 8


def _query(ds, fl, live_tbl, all_cols, cols, venue, interval, symbols, d0, d1, s_ms, e_ms,
           start, end, where, params) -> pa.Table:
    con = duckdb.connect()
    try:
        parts = []
        if fl:
            parts.append(_union(ds, fl))
        if live_tbl is not None and live_tbl.num_rows:
            con.register("__live", live_tbl)
            parts.append(f"SELECT {', '.join(chr(34) + c + chr(34) for c in all_cols)} FROM __live")
        base = " UNION ALL BY NAME ".join(f"({p})" for p in parts)
        conds, args = [], []
        if venue is not None:
            conds.append(f'"{ds.part_key}" = ?'); args.append(venue)
        if interval is not None and ds.sub_key:
            conds.append(f'"{ds.sub_key}" = ?'); args.append(interval)
        if symbols is not None:
            if "symbol" not in ds.columns:
                raise ValueError(f"{ds.name} has no symbol column")
            con.register("__syms", pa.table({"s": [str(s) for s in symbols]}))
            conds.append("symbol IN (SELECT s FROM __syms)")
        if ds.time_kind == "date":
            if start is not None:
                conds.append(f'"{ds.time_col}" >= ?'); args.append(d0)
            if end is not None:
                conds.append(f'"{ds.time_col}" <= ?'); args.append(d1)
        else:
            if s_ms is not None:
                conds.append(f'"{ds.time_col}" >= ?'); args.append(s_ms)
            if e_ms is not None:
                conds.append(f'"{ds.time_col}" <= ?'); args.append(e_ms)
        if where:
            conds.append(f"({where})"); args.extend(params or [])
        q = f"SELECT * FROM ({base}) x" + (" WHERE " + " AND ".join(conds) if conds else "")
        if live_tbl is not None and live_tbl.num_rows:
            # a row both rolled and still in the hot log (the moment between the roll and the
            # hot file's removal) is one row
            ident = ds.identity if ds.rule in ("observe", "append") else ds.key
            keys = list(ds.partition_keys) + list(ident)
            q = (f"SELECT * EXCLUDE (__rn) FROM (SELECT *, row_number() OVER (PARTITION BY "
                 f"{', '.join(chr(34) + k + chr(34) for k in keys)}) AS __rn FROM ({q})) WHERE __rn = 1")
        order = [c for c in (list(ds.partition_keys) + list(ds.sort)) if c in all_cols]
        q = f"SELECT {', '.join(chr(34) + c + chr(34) for c in cols)} FROM ({q}) ORDER BY " + \
            ", ".join(f'"{c}"' for c in order)
        return con.execute(q, args).to_arrow_table()
    finally:
        con.close()


# --------------------------------------------------------------------------------------------- #
# typed readers
# --------------------------------------------------------------------------------------------- #

def funding(venue: str | None = None, symbols=None, start=None, end=None, cols=None,
            as_: str = "arrow", **kw):
    """Settled funding rows (the fundplat row contract). `interval_h` is set ONLY where the venue
    published it (`interval_src` = 'venue'); a consumer that needs a cadence on every row applies
    fundplat.data.core.cadence to these rows - the lake never stores an inferred one."""
    return read("funding", venue, symbols=symbols, start=start, end=end, cols=cols, as_=as_, **kw)


def candles(venue: str | None = None, symbol=None, interval: str | None = None, start=None, end=None,
            cols=None, as_: str = "arrow", complete_only: bool = True, closed_only: bool = False, **kw):
    """Bars keyed on the open ms `t`. complete_only (default) drops seed bars lacking h/l;
    closed_only drops the still-forming bar."""
    conds = []
    if complete_only:
        conds.append("c IS NOT NULL AND h IS NOT NULL AND l IS NOT NULL")
    if closed_only:
        conds.append("closed")
    where = " AND ".join(conds) or None
    if kw.get("where"):
        where = f"({where}) AND ({kw.pop('where')})" if where else kw.pop("where")
    return read("candles", venue, symbols=symbol, interval=interval, start=start, end=end,
                cols=cols, where=where, as_=as_, **kw)


def contract_bars(venue: str | None = None, symbol=None, interval: str | None = None,
                  what: str | None = None, start=None, end=None, cols=None, as_: str = "arrow",
                  closed_only: bool = False, **kw):
    """Bars of listed contracts (`symbol` = the venue's contract id, e.g. a broker's numeric id; one or a
    list). `what` narrows to one bar kind (TRADES, MIDPOINT, ...) - without it a contract read
    for two kinds returns both, told apart by the `what` column. `data_type` on every row says
    whether it was served live or delayed. What an id IS: contracts(venue, symbols=...)."""
    conds, params = [], []
    if what is not None:
        conds.append("what = ?"); params.append(what)
    if closed_only:
        conds.append("closed")
    if kw.get("where"):
        conds.append(f"({kw.pop('where')})"); params.extend(kw.pop("params", None) or [])
    if conds:
        kw["where"], kw["params"] = " AND ".join(conds), params
    if symbol is not None and not isinstance(symbol, str):
        symbol = [str(x) for x in symbol] if isinstance(symbol, (list, tuple, set)) else str(symbol)
    return read("contract_bars", venue, symbols=symbol, interval=interval, start=start, end=end,
                cols=cols, as_=as_, **kw)


def predmkt_bars(venue: str | None = None, symbol=None, interval: str | None = None, start=None,
                 end=None, cols=None, as_: str = "arrow", outcome: str | None = None,
                 px_kind: str | None = None, closed_only: bool = False, **kw):
    """Price history of prediction-market outcomes (`symbol` = '<venue id>@<listed_ms>', one or a
    list; writer.predmkt_symbol builds it). `outcome` and `px_kind` ('ohlc' | 'sample') narrow
    the read; closed_only drops the still-forming bar. Bars are keyed on the open ms `t`."""
    conds, params = [], []
    if outcome is not None:
        conds.append("outcome = ?"); params.append(outcome)
    if px_kind is not None:
        conds.append("px_kind = ?"); params.append(px_kind)
    if closed_only:
        conds.append("closed")
    if kw.get("where"):
        conds.append(f"({kw.pop('where')})"); params.extend(kw.pop("params", None) or [])
    if conds:
        kw["where"], kw["params"] = " AND ".join(conds), params
    return read("predmkt_bars", venue, symbols=symbol, interval=interval, start=start, end=end,
                cols=cols, as_=as_, **kw)


def _eq(kw: dict, **eq) -> None:
    """AND the given column = value filters (None skipped) and any caller `where` into kw."""
    conds, params = [], []
    for c, v in eq.items():
        if v is not None:
            conds.append(f'"{c}" = ?'); params.append(v)
    if kw.get("where"):
        conds.append(f"({kw.pop('where')})"); params.extend(kw.pop("params", None) or [])
    if conds:
        kw["where"], kw["params"] = " AND ".join(conds), params


def cb_docs(venue: str | None = None, doc_type: str | None = None, url: str | None = None,
            start=None, end=None, cols=None, as_: str = "arrow", **kw):
    """Central bank documents (`venue` fed | boj | ecb); start/end bound `meeting_date`. `text` is
    the cost of a read: narrow with cols= when you only need the rest."""
    _eq(kw, doc_type=doc_type, url=url)
    return read("cb_docs", venue, start=start, end=end, cols=cols, as_=as_, **kw)


def cb_meetings(venue: str | None = None, status: str | None = None, start=None, end=None,
                cols=None, as_: str = "arrow", **kw):
    """Policy meetings and their readings; start/end bound `meeting_date`."""
    _eq(kw, status=status)
    return read("cb_meetings", venue, start=start, end=end, cols=cols, as_=as_, **kw)


def cb_votes(venue: str | None = None, member: str | None = None, item: str | None = None,
             vote: str | None = None, start=None, end=None, cols=None, as_: str = "arrow", **kw):
    """One member's vote at one meeting (and the attendance rows, item 'attendance')."""
    _eq(kw, member=member, item=item, vote=vote)
    return read("cb_votes", venue, start=start, end=end, cols=cols, as_=as_, **kw)


def cb_projections(venue: str | None = None, variable: str | None = None, stat: str | None = None,
                   start=None, end=None, cols=None, as_: str = "arrow", **kw):
    """Projection cells; start/end bound `meeting_date`."""
    _eq(kw, variable=variable, stat=stat)
    return read("cb_projections", venue, start=start, end=end, cols=cols, as_=as_, **kw)


def cb_llm(venue: str | None = None, task: str | None = None, subject: str | None = None,
           key: str | None = None, start=None, end=None, cols=None, as_: str = "arrow", **kw):
    """Cached LLM answers; start/end bound `created` (ms). A caller checks `key` before asking."""
    _eq(kw, task=task, subject=subject, key=key)
    return read("cb_llm", venue, start=start, end=end, cols=cols, as_=as_, **kw)


def quotes(venue=None, symbols=None, start=None, end=None, cols=None, as_="arrow", **kw):
    return read("quotes", venue, symbols=symbols, start=start, end=end, cols=cols, as_=as_, **kw)


def trades(venue=None, symbols=None, start=None, end=None, cols=None, as_="arrow", **kw):
    return read("trades", venue, symbols=symbols, start=start, end=end, cols=cols, as_=as_, **kw)


def orderbook(venue=None, symbols=None, start=None, end=None, cols=None, as_="arrow", **kw):
    return read("orderbook", venue, symbols=symbols, start=start, end=end, cols=cols, as_=as_, **kw)


def options(venue=None, symbols=None, start=None, end=None, cols=None, as_="arrow",
            underlying: str | None = None, **kw):
    if underlying is not None:
        kw["where"] = "underlying = ?"
        kw["params"] = [underlying]
    return read("options", venue, symbols=symbols, start=start, end=end, cols=cols, as_=as_, **kw)


def option_chains(venue: str | None = None, symbols=None, start=None, end=None, cols=None,
                  as_: str = "arrow", underlying: str | None = None, expiry: str | None = None, **kw):
    """Chain snapshots (one row per option per read; `ts` = our read time). `underlying` narrows
    to one chain, `expiry` ('YYYY-MM-DD') to one expiry of it; `raw` is the served row as JSON."""
    conds, params = [], []
    if underlying is not None:
        conds.append("underlying = ?"); params.append(underlying)
    if expiry is not None:
        conds.append("expiry = ?"); params.append(expiry)
    if kw.get("where"):
        conds.append(f"({kw.pop('where')})"); params.extend(kw.pop("params", None) or [])
    if conds:
        kw["where"], kw["params"] = " AND ".join(conds), params
    return read("option_chains", venue, symbols=symbols, start=start, end=end, cols=cols, as_=as_, **kw)


def predmkts(venue=None, symbols=None, start=None, end=None, cols=None, as_="arrow", **kw):
    return read("predmkts", venue, symbols=symbols, start=start, end=end, cols=cols, as_=as_, **kw)


def eod(symbol=None, start=None, end=None, cols=None, as_="arrow", venue: str = "eod", **kw):
    """Daily bars; `close` is the UNADJUSTED close, `adj_close` the adjusted one."""
    return read("eod", venue, symbols=symbol, start=start, end=end, cols=cols, as_=as_, **kw)


def rates(symbol=None, field: str | None = None, tenor: str | None = None, start=None, end=None,
          cols=None, as_="arrow", venue: str = "treasury", **kw):
    conds, params = [], []
    if field is not None:
        conds.append("field = ?"); params.append(field)
    if tenor is not None:
        conds.append("tenor = ?"); params.append(tenor)
    if conds:
        kw["where"], kw["params"] = " AND ".join(conds), params
    return read("rates", venue, symbols=symbol, start=start, end=end, cols=cols, as_=as_, **kw)


def snapshots(log: str | None = None, desk: str | None = None, subject: str | None = None,
              field: str | None = None, start=None, end=None, cols=None, as_="arrow", **kw):
    """Desk and probe snapshot readings. as_="rows" gives each reading back as the original
    record: `value` an int where it was written as one."""
    conds, params = [], []
    for c, v in (("desk", desk), ("subject", subject), ("field", field)):
        if v is not None:
            conds.append(f"{c} = ?"); params.append(v)
    if conds:
        kw["where"], kw["params"] = " AND ".join(conds), params
    out = read("snapshots", log, start=start, end=end, cols=cols, as_=as_, **kw)
    if as_ == "rows":
        for r in out:
            if r.get("is_int") and r.get("value") is not None:
                r["value"] = int(r["value"])
    return out


def conflicts(dataset: str | None = None, venue: str | None = None, start=None, end=None,
              as_="arrow", **kw):
    if dataset is not None:
        kw["where"], kw["params"] = "dataset = ?", [dataset]
    return read("conflicts", venue, start=start, end=end, as_=as_, **kw)


def coverage(dataset: str | None = None, venue: str | None = None, symbol: str | None = None,
             interval: str | None = None, as_: str = "rows"):
    """The catalog: one row per series (first/last/rows/gaps/src/retention/covered_*)."""
    from . import catalog
    rows = catalog.query(dataset, venue, symbol, interval)
    if as_ == "rows":
        return rows
    tbl = pa.Table.from_pylist(rows) if rows else pa.table({})
    return _out(tbl, as_)


# --------------------------------------------------------------------------------------------- #
# DuckDB views (fund_db.sql's hook)
# --------------------------------------------------------------------------------------------- #

def register_views(con) -> None:
    """(Re)define one view per dataset that has data, with the partition keys as columns and the
    in-flight-rewrite files hidden. fund_db.lake calls this after its generic views."""
    for name, ds in DATASETS.items():
        fl = files(ds)
        if not fl:
            continue
        body = _union(ds, fl)
        con.execute(f'CREATE OR REPLACE VIEW "{name}" AS {body}')
