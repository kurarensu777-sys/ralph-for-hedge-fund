"""The canonical row shapes the pin digest hashes for funding, candles and eod.

A lake row carries partition and bookkeeping columns the digest must not depend on. These three
datasets are hashed in a fixed shape (the field set below, optional fields only when present), so
a fingerprint recorded by app/loop/tools/fingerprint.py and a pin of the same rows agree byte for
byte. Every other dataset is hashed as its stored columns minus the partition keys and the nulls
(pinning.canonical). Changing a shape here changes every digest: fix forward with a new shape,
never edit one in place.
"""
from __future__ import annotations

_FUND_OPT = ("premium", "interval_h", "rate_type")


def rebuild_funding(r: dict) -> dict:
    out = {"ts": r["ts"], "rate": r["rate"]}
    for k in _FUND_OPT:
        if r.get(k) is not None:
            out[k] = r[k]
    out["src"] = r["src"]
    if r.get("seen") is not None:
        out["seen"] = r["seen"]
    return out


def rebuild_candle(r: dict) -> dict:
    return {"t": r["t"], "o": r["o"], "h": r["h"], "l": r["l"], "c": r["c"], "v": r["v"],
            "n": r["n"], "closed": r["closed"], "src": r["src"], "seen": r["seen"]}


_EOD = ("adj_close", "close", "date", "high", "low", "open", "symbol", "time", "volume")


def rebuild_eod(r: dict) -> dict:
    return {k: r[k] for k in _EOD}


SHAPES = {"funding": rebuild_funding, "candles": rebuild_candle, "eod": rebuild_eod}
