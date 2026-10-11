#!/usr/bin/env python3
"""PINS - the loop's ONE adapter to the data layer's pin API (B-0322 section 1, B-0324).

Data is pulled on demand into a size-capped, EVICTABLE cache. A recorded result
therefore PINS the exact rows it read: content-hashed, immutable, never evicted,
so its fingerprint can be re-checked after the cache has moved on. The pin's
content hash IS fingerprint.py's per-input sha256 (the rows of one series inside
the window, stamp order, legacy-shape rebuild, `seen` dropped, sorted-key compact
JSON plus a newline), so a legacy fingerprint and a pin compare byte for byte.

Every call to the pin API goes through this file and nowhere else, so a later
change of its shape is a one-file swap. Today's shape (database's note on B-0324,
2026-09-28):

    fund_db.market.pin_series("venue:symbol:dataset:interval", window, *, reason, ref,
                              expect=None) -> {hash, rows, first_ts, last_ts, match}

It reads the rows from the store (lake + cache) itself; `window` is {from, to}
in ms; `match` is hash == expect.

THE CONTRACT, per input:
  * pinned                -> {"pin": <hash>, "pin_error": None}; the hash EQUALS the
                             input's sha256 (checked here, not trusted from `match`)
  * a hash that differs   -> REFUSED (C.Refuse). A pin that does not match its
                             fingerprint is a broken contract, never silently kept
  * no pin API yet        -> {"pin": None, "pin_error": "fund_db has no pin API yet
                             (B-0324)"}: an honest unpinned state, never a fake hash
  * the store failed, or the window holds no rows
                          -> {"pin": None, "pin_error": <why>}

Import it; there is no CLI.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as C  # noqa: E402

NO_API = "fund_db has no pin API yet (B-0324)"


def _market():
    """fund_db.market, or (None, why not)."""
    try:
        from fund_db import market
    except ImportError as e:
        return None, f"fund_db is not importable ({e})"
    return market, ""


def available() -> tuple[bool, str]:
    """(True, "") when fund_db carries the pin API, else (False, the reason)."""
    market, why = _market()
    if market is None:
        return False, why
    if not callable(getattr(market, "pin_series", None)):
        return False, NO_API
    return True, ""


def spec(inp: dict) -> str:
    """the `venue:symbol:dataset:interval` spec of a fingerprint input."""
    return f"{inp['venue']}:{inp['symbol']}:{inp['dataset']}:{inp.get('interval') or '-'}"


def pin_input(inp: dict, window: tuple[int, int], reason: str, ref: str) -> dict:
    """Pin one fingerprinted input's in-window rows. `window` is (from_ms, to_ms), the
    window the input was digested over. Returns {"pin", "pin_error"}; Refuses a hash that
    is not the input's sha256."""
    if not reason or not ref:
        raise C.Refuse("a pin needs a reason and a ref (who cites these rows)")
    ok, why = available()
    if not ok:
        return {"pin": None, "pin_error": why}
    if not inp.get("rows"):
        return {"pin": None, "pin_error": "no rows inside the window: nothing to pin"}
    market, _ = _market()
    sp = spec(inp)
    try:
        got = market.pin_series(sp, {"from": int(window[0]), "to": int(window[1])},
                                reason=reason, ref=ref, expect=inp["sha256"])
    except Exception as e:  # the store's own failure: said, not fatal
        return {"pin": None, "pin_error": f"pin_series failed: {type(e).__name__}: {e}"}
    h = (got or {}).get("hash") if isinstance(got, dict) else None
    if h != inp["sha256"] or (got.get("match") is False):
        raise C.Refuse(
            f"the pin of {sp} does not match its fingerprint: pin {h!r} "
            f"({(got or {}).get('rows') if isinstance(got, dict) else '?'} rows), "
            f"fingerprint {inp['sha256']} ({inp.get('rows')} rows). The store now holds "
            f"different rows for this window than the digest read, so the pin is refused")
    return {"pin": h, "pin_error": None}
