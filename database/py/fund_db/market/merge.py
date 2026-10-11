"""The merge rules, pure. One stored row (or none) meets one incoming row; the rule of the dataset
decides what is kept. No I/O here, so every rule is tested offline row by row.

These carry over the fundplat archive's rules (fundplat.data.core.store `merge_bars` and
`merge_funding_rows`, the end-of-day and rates fetchers) unchanged in meaning:

settled (funding, option_chains)
    no stored row                        -> added
    incoming SEED row                    -> only ever fills a hole; a differing stored row is a
                                            `seed_vs_stored` conflict, the stored row is kept
    stored SEED row, incoming venue      -> the venue row replaces it (`upgraded`); a differing
                                            value is logged `seed_vs_venue`, the venue wins
    the primary value (`rate`, `dpnl`)  -> CONFLICT `settled_row_changed`: the stored row is
    both carry differs                      kept, the incoming one logged, never silently resolved
    an optional value was null and is    -> filled (`upgraded`); nothing else changes
    now published
    otherwise                            -> unchanged

bar (candles)                            (a bar is CLOSED when it had fully closed when stored)
    no stored bar                        -> added (an unclosed SEED bar is `skipped`: only the
                                            venue may supply the forming bar)
    incoming SEED bar                    -> fills holes only (`seed_vs_stored` if it differs)
    stored bar still forming             -> the incoming venue bar wins (`updated`)
    stored closed SEED bar               -> a closed venue bar replaces it (`upgraded`, differing
                                            c/h/l logged `seed_vs_venue`); an unclosed one skips
    stored CLOSED venue bar              -> IMMUTABLE: a differing closed bar is a
                                            `closed_bar_changed` conflict and is kept out
    "differs" compares only the fields BOTH bars carry (a seed may lack h/l).

revise (eod, rates)
    no stored row                        -> added
    incoming SEED row                    -> fills holes only
    any value differs (null vs value     -> the incoming row REPLACES the stored one (the
    included)                               publisher corrects late prints) and the stored row
                                            is logged `revised`, so the old print is never lost
    otherwise                            -> unchanged

observe / append: resolved in bulk by the writer (an exact duplicate of every column but `seen`
is dropped; everything else is added), so they never reach merge_row with a stored row.
"""
from __future__ import annotations

import math

from .registry import Dataset

ACTIONS = ("added", "updated", "upgraded", "unchanged", "skipped", "conflict", "revised")


def is_seed(row: dict) -> bool:
    return str(row.get("src") or "").startswith("seed:")


def same_value(a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b):
        return True
    return a == b


def _both_same(old: dict, new: dict, cols) -> bool:
    """Equal on every column BOTH rows carry (non-null)."""
    return all(same_value(old.get(c), new.get(c)) for c in cols
               if old.get(c) is not None and new.get(c) is not None)


def _all_same(old: dict, new: dict, cols) -> bool:
    return all(same_value(old.get(c), new.get(c)) for c in cols)


def merge_row(ds: Dataset, old: dict | None, new: dict) -> tuple[str, dict | None, dict | None]:
    """-> (action, row to store or None, conflict or None).

    `row to store` is set for added/updated/upgraded/revised (the full row that must now be the
    stored one); a conflict is {"kind", "stored", "incoming"}."""
    rule = ds.rule
    if rule == "settled":
        return _settled(ds, old, new)
    if rule == "bar":
        return _bar(ds, old, new)
    if rule == "revise":
        return _revise(ds, old, new)
    if rule in ("observe", "append"):
        if old is None:
            return "added", new, None
        return ("unchanged", None, None) if _all_same(old, new, ds.identity) else ("added", new, None)
    raise ValueError(f"unknown rule {rule!r}")


def _conf(kind: str, old: dict, new: dict) -> dict:
    return {"kind": kind, "stored": old, "incoming": new}


def _settled(ds: Dataset, old, new):
    if old is None:
        return "added", new, None
    if is_seed(new):
        if not _both_same(old, new, ds.values):
            return "skipped", None, _conf("seed_vs_stored", old, new)
        return "skipped", None, None
    if is_seed(old):
        conflict = None if _both_same(old, new, ds.values) else _conf("seed_vs_venue", old, new)
        return "upgraded", new, conflict
    # a settled row's primary value (funding `rate`) may never go from set to null or back;
    # every other compared value differs only where BOTH rows carry it
    primary = ds.values[0] if ds.values else None
    differs = ((primary is not None and not same_value(old.get(primary), new.get(primary)))
               or not _both_same(old, new, ds.values))
    if differs:
        return "conflict", None, _conf("settled_row_changed", old, new)
    fill = {c: new[c] for c in ds.fill if new.get(c) is not None and old.get(c) is None}
    if fill:
        return "upgraded", {**old, **fill}, None
    return "unchanged", None, None


_BAR_CHECK = ("c", "h", "l")


def _bar(ds: Dataset, old, new):
    closed = bool(new.get("closed"))
    seed = is_seed(new)
    if seed and not closed:
        return "skipped", None, None
    if old is None:
        return "added", new, None
    if seed:
        if old.get("closed") and not _both_same(old, new, _BAR_CHECK):
            return "skipped", None, _conf("seed_vs_stored", old, new)
        return "skipped", None, None
    if not old.get("closed"):                               # forming bar: the venue wins
        if _both_same(old, new, ds.values) and bool(old.get("closed")) == closed:
            return "unchanged", None, None
        return "updated", new, None
    if is_seed(old):                                        # a venue bar replaces a seed
        if not closed:
            return "skipped", None, None                    # never un-close a closed seed
        conflict = None if _both_same(old, new, _BAR_CHECK) else _conf("seed_vs_venue", old, new)
        return "upgraded", new, conflict
    if not closed or _both_same(old, new, ds.values):       # closed venue bar: immutable
        return "unchanged", None, None
    return "conflict", None, _conf("closed_bar_changed", old, new)


def _revise(ds: Dataset, old, new):
    if old is None:
        return "added", new, None
    if is_seed(new):
        if not _both_same(old, new, ds.values):
            return "skipped", None, _conf("seed_vs_stored", old, new)
        return "skipped", None, None
    if _all_same(old, new, ds.values):
        return "unchanged", None, None
    return "revised", new, _conf("revised", old, new)
