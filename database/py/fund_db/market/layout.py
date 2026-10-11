"""Where a partition lives on disk, and the tiers a reader walks. Pure path arithmetic.

    <tier root>/<dataset>/<part_key>=<v>/[<sub_key>=<s>/]month=<YYYY-MM>/part-*.parquet

Tier roots: `hot` = fund_db.config.market_dir() (~/fund-data/db/market), `cold` =
config.cold_dir() or the `tier_to` a retention rule names - together THE LAKE, which holds the
archive class. `cache` = config.cache_dir() (~/fund-data/db/cache), the cache class, same layout;
a reader walks all three (retention.read_roots), retention's tier/prune walk only the lake. Values in a folder name are
percent-quoted (urllib.parse.quote, safe="") so any venue, interval or log name is a legal,
reversible Windows path component; a plain name like `exchange_a` or `1h` is unchanged.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote

from fund_db import config

from .registry import Dataset

PART_GLOB = "part-*.parquet"
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")


def hot_root() -> Path:
    return config.market_dir()


def cold_root() -> Path:
    return config.cold_dir()


def cache_root() -> Path:
    return config.cache_dir()


def tier_roots() -> dict[str, Path]:
    return {"hot": hot_root(), "cold": cold_root()}


def enc(v: str) -> str:
    return quote(str(v), safe="")


def dec(v: str) -> str:
    return unquote(v)


def month_of_ms(ms: int) -> str:
    return datetime.fromtimestamp(int(ms) / 1000, timezone.utc).strftime("%Y-%m")


def month_of_date(d: str) -> str:
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(d)):
        raise ValueError(f"not a YYYY-MM-DD date: {d!r}")
    return str(d)[:7]


def month_start_ms(month: str) -> int:
    y, m = int(month[:4]), int(month[5:7])
    return int(datetime(y, m, 1, tzinfo=timezone.utc).timestamp() * 1000)


def month_end_ms(month: str) -> int:
    """The first ms of the NEXT month (exclusive end)."""
    y, m = int(month[:4]), int(month[5:7])
    y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return int(datetime(y, m, 1, tzinfo=timezone.utc).timestamp() * 1000)


def months_between(start_ms: int | None, end_ms: int | None) -> set[str] | None:
    """Every YYYY-MM touched by [start_ms, end_ms]; None when either end is open."""
    if start_ms is None or end_ms is None:
        return None
    a = datetime.fromtimestamp(start_ms / 1000, timezone.utc)
    b = datetime.fromtimestamp(end_ms / 1000, timezone.utc)
    out, y, m = set(), a.year, a.month
    while (y, m) <= (b.year, b.month):
        out.add(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def partition_dir(root: Path, ds: Dataset, part: str, month: str, sub: str | None = None) -> Path:
    if ds.sub_key and sub is None:
        raise ValueError(f"{ds.name} partitions need a {ds.sub_key}")
    if not MONTH_RE.match(month):
        raise ValueError(f"bad month {month!r}")
    p = root / ds.name / f"{ds.part_key}={enc(part)}"
    if ds.sub_key:
        p = p / f"{ds.sub_key}={enc(sub)}"
    return p / f"month={month}"


def parse_partition(ds: Dataset, pdir: Path) -> dict:
    """{part_key: v, [sub_key: s,] "month": m} from a partition directory."""
    out = {}
    for comp in pdir.parts[-(3 if ds.sub_key else 2):]:
        k, _, v = comp.partition("=")
        out[k] = v if k == "month" else dec(v)
    return out


def partitions(root: Path, ds: Dataset, part: str | None = None, sub: str | None = None,
               months: set[str] | None = None) -> list[Path]:
    """Every existing partition dir of `ds` under `root`, optionally narrowed."""
    base = root / ds.name
    if not base.is_dir():
        return []
    pdirs = [base / f"{ds.part_key}={enc(part)}"] if part is not None else \
        sorted(p for p in base.glob(f"{ds.part_key}=*") if p.is_dir())
    if ds.sub_key:
        pdirs = [q for p in pdirs for q in
                 ([p / f"{ds.sub_key}={enc(sub)}"] if sub is not None else
                  sorted(x for x in p.glob(f"{ds.sub_key}=*") if x.is_dir()))]
    out = []
    for p in pdirs:
        if not p.is_dir():
            continue
        for m in sorted(p.glob("month=*")):
            if m.is_dir() and (months is None or m.name[6:] in months):
                out.append(m)
    return out


def part_files(pdir: Path) -> list[Path]:
    return sorted(pdir.glob(PART_GLOB))


def today_iso() -> str:
    return date.today().isoformat()
