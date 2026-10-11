"""The contract reference: what each contract id in `contract_bars` IS, one row per (venue, symbol)
across all time, in the Postgres table market.contracts (migrations/market/002_contracts.sql).

    market.write_contracts("broker_a", [{"con_id": 123, "sec_type": "FOP", "underlying": "SR3", ...}])
    market.contracts("broker_a", underlying="SR3", sec_type="FOP")              -> rows
    market.contract_coverage("broker_a", underlying="SR3", interval="1d")       -> rows
    market.write_contract_links([{"venue": "charts_a", "symbol": "CME:SR3M2025",
                                  "link_venue": "broker_a", "link_symbol": "123", "method": "identity"}])
    market.contract_links("charts_a", link_venue="broker_a")                -> rows

WHY A TABLE AND NOT A LAKE DATASET. A lake partition is a month; "one row per contract, forever"
has no month, and the settled check of a lake write only sees its own partition. Postgres holds
the one row and its primary key, and fund_db.sql() joins it to the lake (`pg.market.contracts`).

THE KEY IS THE VENUE'S OWN ID. `symbol` is the id as text (a broker's numeric contract id in
decimal; when `con_id` is given, `symbol` defaults to it and must equal it). A display label (a
`local_symbol` such as SR3Z6) is a column, never the key: a one-digit year is reused every decade.
A venue with no numeric id keys on its own full symbol (e.g. 'CME:SR3261211C96.5', con_id
null). SYMBOL_RULES maps a venue id to the pattern its symbols must match, so a venue can refuse
what is not one contract there (e.g. a continuous roll series); it ships empty.

SETTLED, LIKE A FUNDING ROW. The IDENTITY columns below are filled when null and never
overwritten: a re-served contract that differs on one is refused, the stored row kept, and the
pair logged to the lake's `conflicts` (dataset 'contracts', kind 'contract_changed'). `raw` keeps
the venue's contract details as FIRST served; `last_seen` is the only column a re-serve moves.

Normalised on the way in, losslessly: last_trade_date 'YYYYMMDD' -> 'YYYY-MM-DD' (a bare month is
refused there: it belongs in contract_month), contract_month 'YYYYMM' -> 'YYYY-MM', right
'CALL'/'PUT' -> 'C'/'P', multiplier to its plain decimal text ('2500', never '2500.0').
"""
from __future__ import annotations

import json
import re
import sys
import time
from decimal import Decimal, InvalidOperation

IDENTITY = ("con_id", "sec_type", "underlying", "local_symbol", "trading_class", "exchange",
            "primary_exchange", "currency", "multiplier", "last_trade_date", "contract_month",
            "strike", "right", "under_con_id", "time_zone", "description")
COLUMNS = ("venue", "symbol") + IDENTITY + ("raw", "src", "first_seen", "last_seen")
_TABLE = "market.contracts"
_DATE = re.compile(r"^(\d{4})-?(\d{2})-?(\d{2})$")
# per venue: (the symbol a contract may be keyed on, why a miss is refused)
SYMBOL_RULES: dict = {}
_MONTH = re.compile(r"^(\d{4})-?(\d{2})$")


def _now() -> int:
    return int(time.time() * 1000)


def _err(msg: str):
    from .writer import WriteError
    return WriteError(msg)


def _decimal_text(v) -> str | None:
    if v is None or v == "":
        return None
    try:
        d = Decimal(str(v).strip())
    except InvalidOperation:
        return str(v).strip()                     # not a number: kept verbatim
    return format(d.normalize(), "f")


def normalize(venue: str, r: dict, source: str, now: int) -> dict:
    """One incoming contract -> a row of market.contracts (raises WriteError on a breach)."""
    r = dict(r)
    out: dict = {"venue": venue.lower()}
    cid = r.get("con_id")
    if cid is not None:
        if isinstance(cid, bool) or (isinstance(cid, float) and cid != int(cid)):
            raise _err(f"contracts {venue}: con_id {cid!r} is not an integer")
        cid = int(cid)
    sym = r.get("symbol")
    if sym is None and cid is not None:
        sym = str(cid)
    if sym is None or str(sym).strip() == "":
        raise _err(f"contracts {venue}: a contract needs its id (`symbol`, or `con_id`)")
    sym = str(sym)
    if cid is not None and sym != str(cid):
        raise _err(f"contracts {venue}: symbol {sym!r} is not con_id {cid} - the key is the venue's id")
    rule = SYMBOL_RULES.get(out["venue"])
    if rule and not rule[0].match(sym):
        raise _err(f"contracts {venue}: symbol {sym!r} refused - {rule[1]}")
    out["symbol"], out["con_id"] = sym, cid
    if not r.get("sec_type"):
        raise _err(f"contracts {venue} {sym}: sec_type is required")
    for c in ("sec_type", "underlying", "local_symbol", "trading_class", "exchange",
              "primary_exchange", "currency", "time_zone", "description"):
        v = r.get(c)
        out[c] = None if v is None or str(v).strip() == "" else str(v).strip()
    ltd = r.get("last_trade_date")
    if ltd not in (None, ""):
        m = _DATE.match(str(ltd).strip())
        if not m:
            raise _err(f"contracts {venue} {sym}: last_trade_date {ltd!r} is not a date "
                       "(a bare contract month goes in contract_month)")
        ltd = f"{m[1]}-{m[2]}-{m[3]}"
    out["last_trade_date"] = ltd or None
    cm = r.get("contract_month")
    if cm not in (None, ""):
        m = _MONTH.match(str(cm).strip())
        if not m:
            raise _err(f"contracts {venue} {sym}: contract_month {cm!r} is not 'YYYY-MM'")
        cm = f"{m[1]}-{m[2]}"
    out["contract_month"] = cm or None
    k = r.get("strike")
    out["strike"] = None if k is None or k == "" else float(k)
    rt = r.get("right")
    if rt in (None, "", "?", "0"):
        rt = None
    elif str(rt).upper() in ("C", "CALL"):
        rt = "C"
    elif str(rt).upper() in ("P", "PUT"):
        rt = "P"
    else:
        raise _err(f"contracts {venue} {sym}: right {rt!r} is neither a call nor a put")
    out["right"] = rt
    out["multiplier"] = _decimal_text(r.get("multiplier"))
    u = r.get("under_con_id")
    out["under_con_id"] = None if u in (None, "", 0) else int(u)
    raw = r.get("raw")
    out["raw"] = raw if isinstance(raw, dict) else ({} if raw is None else {"value": raw})
    out["src"] = str(r.get("src") or source)
    out["first_seen"] = out["last_seen"] = now
    return out


def write_contracts(venue: str, rows, source: str = "venue", now: int | None = None,
                    conn=None) -> dict:
    """Register contracts. -> {added, upgraded, unchanged, conflict, conflicts: [...]}.
    One transaction; conflicts are logged to the lake after it commits."""
    from fund_db import db
    now = _now() if now is None else now
    inc = [normalize(venue, r, source, now) for r in rows]
    rep = {"added": 0, "upgraded": 0, "unchanged": 0, "conflict": 0, "conflicts": []}
    if not inc:
        return rep
    v = inc[0]["venue"]
    own = conn is None
    c = conn or db.connect()
    try:
        with c.transaction():
            stored = {r["symbol"]: dict(r) for r in c.execute(
                f"SELECT * FROM {_TABLE} WHERE venue = %s AND symbol = ANY(%s) FOR UPDATE",
                (v, sorted({r["symbol"] for r in inc}))).fetchall()}
            for r in inc:
                old = stored.get(r["symbol"])
                if old is None:
                    c.execute(f"INSERT INTO {_TABLE} ({', '.join(_q(x) for x in COLUMNS)}) VALUES "
                              f"({', '.join('%s' for _ in COLUMNS)})",
                              [json.dumps(r[x]) if x == "raw" else r[x] for x in COLUMNS])
                    stored[r["symbol"]] = r
                    rep["added"] += 1
                    continue
                differs = [x for x in IDENTITY if old.get(x) is not None and r.get(x) is not None
                           and old[x] != r[x]]
                if differs:
                    rep["conflict"] += 1
                    rep["conflicts"].append({"symbol": r["symbol"], "columns": differs,
                                             "stored": {x: old.get(x) for x in IDENTITY},
                                             "incoming": {x: r.get(x) for x in IDENTITY}})
                    continue
                fill = {x: r[x] for x in IDENTITY if old.get(x) is None and r.get(x) is not None}
                sets = [f"{_q(x)} = %s" for x in fill] + ["last_seen = greatest(last_seen, %s)"]
                c.execute(f"UPDATE {_TABLE} SET {', '.join(sets)} WHERE venue = %s AND symbol = %s",
                          [*fill.values(), now, v, r["symbol"]])
                stored[r["symbol"]] = {**old, **fill}
                rep["upgraded" if fill else "unchanged"] += 1
    finally:
        if own:
            c.close()
    if rep["conflicts"]:
        _log(v, rep["conflicts"], now)
    return rep


def _q(col: str) -> str:
    return f'"{col}"' if col == "right" else col


def _log(venue: str, conflicts: list, now: int) -> None:
    from .writer import write
    write("conflicts", [{
        "logged": now, "dataset": "contracts", "symbol": x["symbol"], "interval": None,
        "key": json.dumps({"venue": venue, "symbol": x["symbol"]}, sort_keys=True),
        "kind": "contract_changed",
        "stored": json.dumps(x["stored"], default=str, sort_keys=True),
        "incoming": json.dumps(x["incoming"], default=str, sort_keys=True)} for x in conflicts],
        venue, update_catalog=True)
    print(f"  ! lake: {len(conflicts)} contract_changed on contracts {venue} - the stored contract "
          f"was kept (fund_db.market.conflicts('contracts'))", file=sys.stderr)


def contracts(venue: str | None = None, symbols=None, sec_type: str | None = None,
              underlying: str | None = None, as_: str = "rows", conn=None):
    """Registered contracts, oldest expiry first (a contract without one last)."""
    from fund_db import db
    where, args = [], []
    if venue is not None:
        where.append("venue = %s"); args.append(venue.lower())
    if symbols is not None:
        where.append("symbol = ANY(%s)"); args.append([str(s) for s in ([symbols] if isinstance(symbols, (str, int)) else symbols)])
    if sec_type is not None:
        where.append("sec_type = %s"); args.append(sec_type)
    if underlying is not None:
        where.append("underlying = %s"); args.append(underlying)
    q = (f"SELECT * FROM {_TABLE}" + (" WHERE " + " AND ".join(where) if where else "") +
         " ORDER BY venue, underlying NULLS LAST, last_trade_date NULLS LAST, sec_type, strike NULLS FIRST, \"right\" NULLS FIRST, symbol")
    own = conn is None
    c = conn or db.connect(autocommit=True)
    try:
        rows = [dict(r) for r in c.execute(q, args).fetchall()]
    finally:
        if own:
            c.close()
    return _out(rows, as_)


def require_registered(venue: str, symbols) -> None:
    """Raise WriteError unless every symbol is a registered contract of `venue`. A bar without its
    contract is a number without a unit."""
    from fund_db import db
    want = sorted({str(s) for s in symbols})
    with db.connect(autocommit=True) as c:
        have = {r["symbol"] for r in c.execute(
            f"SELECT symbol FROM {_TABLE} WHERE venue = %s AND symbol = ANY(%s)",
            (venue.lower(), want)).fetchall()}
    missing = [s for s in want if s not in have]
    if missing:
        raise _err(f"contract_bars {venue}: {len(missing)} contract id(s) not in market.contracts "
                   f"(e.g. {missing[:5]}); write_contracts first - a bar is stored only for a "
                   "contract whose identity is registered")


_LINKS = "market.contract_links"
LINK_COLUMNS = ("venue", "symbol", "link_venue", "link_symbol", "method", "src", "first_seen")


def write_contract_links(rows, source: str = "venue", now: int | None = None, conn=None) -> dict:
    """Say that two registered contracts on two venues are one contract: rows {venue, symbol,
    link_venue, link_symbol, method[, src]}. Both directions are stored, in one transaction.
    -> {added, unchanged, conflict, conflicts: [...]}. SETTLED: a (venue, symbol, link_venue)
    already linked to another link_symbol - from either end - is refused, the stored link kept,
    and the pair logged to the lake's conflicts (dataset 'contract_links', kind 'link_changed').
    A link to an unregistered contract raises WriteError and nothing lands."""
    from fund_db import db
    now = _now() if now is None else now
    inc = []
    for r in rows:
        v, s = str(r.get("venue") or "").lower(), str(r.get("symbol") or "")
        lv, ls = str(r.get("link_venue") or "").lower(), str(r.get("link_symbol") or "")
        m = str(r.get("method") or "").strip()
        if not (v and s and lv and ls):
            raise _err(f"contract_links: venue, symbol, link_venue and link_symbol are required ({r!r})")
        if v == lv:
            raise _err(f"contract_links: {v} {s} -> {lv} {ls} links a venue to itself")
        if not m:
            raise _err(f"contract_links {v} {s} -> {lv} {ls}: `method` (how the match was made) is required")
        src = str(r.get("src") or source)
        inc.append({"venue": v, "symbol": s, "link_venue": lv, "link_symbol": ls, "method": m,
                    "src": src, "first_seen": now})
        inc.append({"venue": lv, "symbol": ls, "link_venue": v, "link_symbol": s, "method": m,
                    "src": src, "first_seen": now})
    rep = {"added": 0, "unchanged": 0, "conflict": 0, "conflicts": []}
    if not inc:
        return rep
    own = conn is None
    c = conn or db.connect()
    try:
        with c.transaction():
            ends = sorted({(r["venue"], r["symbol"]) for r in inc})
            have = {(x["venue"], x["symbol"]) for x in c.execute(
                f"SELECT venue, symbol FROM {_TABLE} WHERE (venue, symbol) IN "
                f"(SELECT * FROM unnest(%s::text[], %s::text[]))",
                ([e[0] for e in ends], [e[1] for e in ends])).fetchall()}
            missing = [e for e in ends if e not in have]
            if missing:
                raise _err(f"contract_links: {len(missing)} end(s) not in market.contracts "
                           f"(e.g. {missing[:5]}); write_contracts first - a link between ids "
                           "whose identity nobody recorded proves nothing")
            stored = {(x["venue"], x["symbol"], x["link_venue"]): dict(x) for x in c.execute(
                f"SELECT * FROM {_LINKS} WHERE (venue, symbol) IN "
                f"(SELECT * FROM unnest(%s::text[], %s::text[])) FOR UPDATE",
                ([e[0] for e in ends], [e[1] for e in ends])).fetchall()}
            # a pair is judged whole: if either direction is taken by another contract, neither lands
            for fwd, back in zip(inc[0::2], inc[1::2]):
                clash = [x for x in (fwd, back)
                         if (o := stored.get((x["venue"], x["symbol"], x["link_venue"])))
                         and o["link_symbol"] != x["link_symbol"]]
                if clash:
                    rep["conflict"] += 1
                    x = clash[0]
                    rep["conflicts"].append({
                        "symbol": fwd["symbol"], "venue": fwd["venue"],
                        "stored": stored[(x["venue"], x["symbol"], x["link_venue"])],
                        "incoming": {k: fwd[k] for k in LINK_COLUMNS}})
                    continue
                if all((x["venue"], x["symbol"], x["link_venue"]) in stored for x in (fwd, back)):
                    rep["unchanged"] += 1
                    continue
                for x in (fwd, back):
                    k = (x["venue"], x["symbol"], x["link_venue"])
                    if k not in stored:
                        c.execute(f"INSERT INTO {_LINKS} ({', '.join(LINK_COLUMNS)}) VALUES "
                                  f"({', '.join('%s' for _ in LINK_COLUMNS)})",
                                  [x[col] for col in LINK_COLUMNS])
                        stored[k] = x
                rep["added"] += 1
    finally:
        if own:
            c.close()
    if rep["conflicts"]:
        from .writer import write
        write("conflicts", [{
            "logged": now, "dataset": "contract_links", "symbol": x["symbol"], "interval": None,
            "key": json.dumps({"venue": x["venue"], "symbol": x["symbol"],
                               "link_venue": x["incoming"]["link_venue"]}, sort_keys=True),
            "kind": "link_changed",
            "stored": json.dumps(x["stored"], default=str, sort_keys=True),
            "incoming": json.dumps(x["incoming"], default=str, sort_keys=True)}
            for x in rep["conflicts"]], rep["conflicts"][0]["venue"], update_catalog=True)
        print(f"  ! lake: {len(rep['conflicts'])} link_changed on contract_links - the stored link "
              "was kept (fund_db.market.conflicts('contract_links'))", file=sys.stderr)
    return rep


def contract_links(venue: str | None = None, symbols=None, link_venue: str | None = None,
                   as_: str = "rows", conn=None):
    """Links from `venue`'s contracts (both directions are stored, so ask from either end)."""
    from fund_db import db
    where, args = [], []
    if venue is not None:
        where.append("venue = %s"); args.append(venue.lower())
    if symbols is not None:
        where.append("symbol = ANY(%s)"); args.append([str(s) for s in ([symbols] if isinstance(symbols, (str, int)) else symbols)])
    if link_venue is not None:
        where.append("link_venue = %s"); args.append(link_venue.lower())
    q = (f"SELECT * FROM {_LINKS}" + (" WHERE " + " AND ".join(where) if where else "") +
         " ORDER BY venue, symbol, link_venue")
    own = conn is None
    c = conn or db.connect(autocommit=True)
    try:
        rows = [dict(r) for r in c.execute(q, args).fetchall()]
    finally:
        if own:
            c.close()
    return _out(rows, as_)


_COV_COLS = ("sec_type", "underlying", "local_symbol", "trading_class", "exchange", "currency",
             "multiplier", "last_trade_date", "contract_month", "strike", "right", "under_con_id")


def contract_coverage(venue: str | None = None, underlying: str | None = None,
                      sec_type: str | None = None, interval: str | None = None, symbols=None,
                      as_: str = "rows"):
    """What the lake holds per contract: every registered contract (filtered) joined to its
    `contract_bars` catalog series - one row per (contract, interval) with first_ts, last_ts,
    rows, by_src, covered_from/_to; a registered contract with no bars comes back once with
    interval None and rows 0 (the venue was asked and served nothing, or nobody asked yet)."""
    from . import catalog
    cons = contracts(venue, symbols=symbols, sec_type=sec_type, underlying=underlying)
    cat: dict[tuple, list] = {}
    for r in catalog.query("contract_bars", venue, None, interval):
        cat.setdefault((r["venue"], r["symbol"]), []).append(r)
    out = []
    for k in cons:
        base = {"venue": k["venue"], "symbol": k["symbol"], **{x: k.get(x) for x in _COV_COLS}}
        series = cat.get((k["venue"], k["symbol"]))
        if not series:
            out.append({**base, "interval": None, "first_ts": None, "last_ts": None, "rows": 0,
                        "by_src": {}, "covered_from": None, "covered_to": None})
            continue
        for s in sorted(series, key=lambda s: s["interval"]):
            out.append({**base, "interval": s["interval"], "first_ts": s["first_ts"],
                        "last_ts": s["last_ts"], "rows": s["rows"], "by_src": s["by_src"],
                        "covered_from": s["covered_from"], "covered_to": s["covered_to"]})
    return _out(out, as_)


def _out(rows: list[dict], as_: str):
    if as_ == "rows":
        return rows
    import pyarrow as pa
    tbl = pa.Table.from_pylist([{k: (json.dumps(v) if isinstance(v, dict) else v) for k, v in r.items()}
                                for r in rows]) if rows else pa.table({})
    if as_ == "arrow":
        return tbl
    if as_ == "pandas":
        return tbl.to_pandas()
    raise ValueError(f"as_ must be rows, arrow or pandas, not {as_!r}")
