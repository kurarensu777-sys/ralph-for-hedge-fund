"""The loop over days for the 15-minute Up/Down study (B-0642): `run_day` derives a day once and seats it; the planted-test pass reruns one configuration.

    python updown15_runner.py run 2026-10-03 [2026-10-04 ...] [--fit 2026-09-30,2026-10-01,2026-10-02] [--force] [--workers 4]
    python updown15_runner.py verify 2026-10-03 [...] --cfg "logit|z1|L30|th0.03"

THE INPUTS ARE PINNED AND NOTHING RAW IS READ HERE. Binance trades come from `fundplat.data.crypto.ticks.day_frame` (the day files, stored and checksummed by the
data layer) and the Polymarket ladders from `fundplat.data.predmkts.updown15_pin.read` (the reduced ladder state of every market, pinned once from the archive by
the platform's ladder job, which removes the archive hour itself). This module opens no archive file and no zip, so a pass reads the same bytes every time.
Idempotent and resumable: a day whose derived bundle is already seated with the same code and role is skipped. A validation or test day needs the maps fitted on the
FIT days, rebuilt from the seated fit-day bundles. Every day appends one progress row (windows, bytes, seconds, hash, read-back check).
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import pickle
import sys
import time

import updown15_day as D

DATASET = "updown15-day"
VERIFY_DATASET = "updown15-verify"
CODE = "run-2026-10-07f"                 # bump when the derivation changes: a seated day with another code is rebuilt (never silently reused)
FIT_DAYS = ("2026-09-30", "2026-10-01", "2026-10-02")


def day_bounds(day: str):
    lo = D.day_start_ms(day)
    return lo, lo + D.DAY_MS


class Sources:
    """The three injected sources of `updown15_day`, each one `fundplat.data` function."""

    def __init__(self):
        from fundplat.data.crypto import ticks
        from fundplat.data.predmkts import updown15_pin
        self.ticks, self.pin = ticks, updown15_pin
        self.missing = []

    def trades(self, symbol, day):
        df = self.ticks.day_frame("spot", "aggTrades", symbol, day)
        meta = self.ticks.read_meta("spot", "aggTrades", symbol, day) or {}
        return df[["ts_ms", "price", "qty", "buyer_maker"]], {k: meta.get(k) for k in ("day", "sha256", "bytes", "rows", "ts_unit", "published_sha256")}

    def index_1m(self, symbol, day):
        import pandas as pd
        lo, hi = day_bounds(day)
        rows = self.ticks.index_klines_1m(symbol, lo, hi)
        return pd.DataFrame([{"open_ms": r["open_ms"], "close": r["close"]} for r in rows])

    def hours(self, hour, rows):
        """The pinned ladder states of every market whose window starts in the archive hour. A market with no pinned book (a gap, or not pinned) is not yielded, so
        its window stays `no_book` in the derived day and is counted there, never skipped silently."""
        for r in rows:
            try:
                p = self.pin.read(r["slug"])
            except (KeyError, LookupError) as e:
                self.missing.append((r["slug"], str(e)[:80]))
                continue
            aud = dict(p["meta"].get("audit") or {})
            aud.update(bytes=p["meta"].get("bytes"), mirror_ok=p["meta"].get("down") == "mirror")
            yield r, p["states"], aud


def market_rows(day: str, assets=D.ASSETS):
    from fundplat.data.predmkts import updown15
    lo, hi = day_bounds(day)
    return [r for r in updown15.markets(lo, hi, assets) if r["outcome"] in ("Up", "Down")]


def _as_row(r: dict) -> dict:
    r = dict(r)
    r["up_won"] = r["outcome"] == "Up"
    return r


def key_of(day: str) -> str:
    """A derived day is pinned under its day AND the code that built it, so a changed derivation is a new pin, never an overwrite."""
    return f"{day}@{CODE}"


def seated(day: str):
    from fundplat.data import derived
    try:
        return derived.get(DATASET, key_of(day))
    except KeyError:
        return None


def seated_verify(day: str, cfg: str):
    from fundplat.data import derived
    try:
        return derived.get(VERIFY_DATASET, f"{day}.{cfg.replace(chr(124), chr(95))}@{CODE}")
    except KeyError:
        return None


def _part(args):
    """One worker: the windows of a subset of hours of one day, from the pinned ladders."""
    day, rows, maps_blob, hours_subset = args
    maps = pickle.loads(maps_blob)
    src = Sources()
    blob, aud = D.derive_book_day(day, rows, src.trades, src.hours, maps, src.index_1m, only_hours=set(hours_subset))
    return blob, src.missing


def run_day(day: str, role: str, maps=None, force: bool = False, workers: int = 1, log=print) -> dict:
    """Derive one day and seat it. role 'fit' (Binance only) or 'book' (with the pinned ladders). -> the progress row."""
    from fundplat.data import derived
    old = seated(day)
    if old is not None and not force:
        arrs, meta = D.unpack(old)
        if meta.get("code") == CODE and meta.get("role") == ("fit" if role == "fit" else "book"):
            log(f"{day}: derived day already seated ({len(old) / 1e6:.1f} MB), skipped")
            return dict(day=day, role=role, skipped=True, bytes=len(old))
    t0 = time.time()
    rows = [_as_row(r) for r in market_rows(day)]
    src = Sources()
    missing = []
    if role == "fit":
        blob, aud = D.derive_fit_day(day, rows, src.trades, src.index_1m)
    elif workers <= 1:
        blob, aud = D.derive_book_day(day, rows, src.trades, src.hours, maps, src.index_1m)
        missing = src.missing
    else:
        hours = sorted({D.hour_label(r["start_ms"]) for r in rows})
        subsets = [hours[i::workers] for i in range(workers)]
        mb = pickle.dumps(maps)
        with cf.ProcessPoolExecutor(workers) as ex:
            res = list(ex.map(_part, [(day, rows, mb, s) for s in subsets]))
        blob = D.merge_book_days([b for b, _ in res])
        aud = D.unpack(blob)[1]["audit"]
        missing = [m for _, ms in res for m in ms]
    arrs, meta = D.unpack(blob)
    meta["code"] = CODE
    meta["pin_missing"] = missing[:50]
    blob = D.pack(arrs, meta)
    built_from = {"code": CODE, "binance_files": aud.get("binance_files"), "markets": len(rows), "markets_without_a_pinned_book": len(missing)}
    res = derived.put(DATASET, key_of(day), blob, built_from)
    ok = D.sha(blob) == D.sha(derived.get(DATASET, key_of(day)))
    row = dict(day=day, role=role, windows=len(rows), bytes=len(blob), seconds=round(time.time() - t0, 1), hash=D.sha(blob)[:16], readback_ok=bool(ok),
               no_pin=len(missing), seat=res)
    log(json.dumps(row, default=str))
    return row


def run_verify(day: str, maps, cfg: str, force: bool = False, log=print, no_cadence: bool = False) -> dict:
    """The planted-test and latency pass of one day for one configuration: the same pinned ladders, one simulation per variant."""
    from fundplat.data import derived
    old = seated_verify(day, cfg)
    if old is not None and not force and D.unpack(old)[1].get("code") == CODE:
        log(f"{day}: verify pass already seated, skipped")
        return dict(day=day, skipped=True)
    t0 = time.time()
    rows = [_as_row(r) for r in market_rows(day)]
    src = Sources()
    variants = tuple(v for v in D.VARIANTS if not (no_cadence and v.get("cadence_ms")))
    blob, aud = D.derive_verify_day(day, rows, src.trades, src.hours, maps, cfg, variants=variants)
    arrs, meta = D.unpack(blob)
    meta["code"] = CODE
    blob = D.pack(arrs, meta)
    res = derived.put(VERIFY_DATASET, f"{day}.{cfg.replace(chr(124), chr(95))}@{CODE}", blob, {"code": CODE, "cfg": cfg})
    row = dict(day=day, role="verify", cfg=cfg, bytes=len(blob), seconds=round(time.time() - t0, 1), hash=D.sha(blob)[:16], seat=res)
    log(json.dumps(row, default=str))
    return row


def fit_from_seated(fit_days=FIT_DAYS):
    blobs = []
    for d in fit_days:
        b = seated(d)
        if b is None:
            raise LookupError(f"fit day {d} is not seated: run it first")
        blobs.append(b)
    return D.fit_maps(blobs)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="updown15_runner")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run")
    p.add_argument("days", nargs="+")
    p.add_argument("--fit", default=",".join(FIT_DAYS))
    p.add_argument("--force", action="store_true")
    p.add_argument("--workers", type=int, default=1)
    q = sub.add_parser("verify")
    q.add_argument("days", nargs="+")
    q.add_argument("--cfg", required=True)
    q.add_argument("--fit", default=",".join(FIT_DAYS))
    q.add_argument("--force", action="store_true")
    q.add_argument("--no-cadence", action="store_true", help="leave the cadence variants out (the TEST days are never run at a new cadence)")
    a = ap.parse_args(argv)
    fit = [d for d in a.fit.split(",") if d]
    maps = None
    for day in a.days:
        if a.cmd == "run" and day in fit:
            run_day(day, "fit", force=a.force)
            continue
        if maps is None:
            maps, _ = fit_from_seated(fit)
        if a.cmd == "run":
            run_day(day, "book", maps, force=a.force, workers=a.workers)
        else:
            run_verify(day, maps, a.cfg, force=a.force, no_cadence=a.no_cadence)
    return 0


if __name__ == "__main__":
    sys.exit(main())


def inputs_block(days, blobs: dict, symbols=None) -> dict:
    """The study manifest's `inputs` (report.inputs_digest, shape of report._inputs_problems) for what a run read: each derived day's bundle (its sha256), each pinned
    ladder day (the platform's day manifest digest, hashed with its day into 64 hex) and each Binance symbol's day files (ticks.input_pin's digest, likewise).
    A read the data layer cannot fingerprint is named in `unpinned` with its reason, never dropped."""
    import hashlib
    from fundplat.data.crypto import ticks
    from fundplat.data.predmkts import updown15_pin
    from fundplat.quant.core import report as REPORT
    series, unpinned = [], []
    lo, hi = day_bounds(days[0])[0], day_bounds(days[-1])[1]
    for d in days:
        a, b = day_bounds(d)
        blob = blobs[d]
        arrs, meta = D.unpack(blob)
        series.append(dict(spec=f"updown15:{d}:derived-day:-", pin=D.sha(blob), rows=int(len(arrs["w_start"])), first_ts=a, last_ts=b - 1, handle=None, cls="pin", trunc=False))
        if meta["role"] == "book":
            try:
                ip = updown15_pin.input_pin(d)
                series.append(dict(spec=f"polymarket:updown15 {d}:l2-ladders:-", pin=hashlib.sha256(f"updown15-l2:{d}:{ip['digest']}".encode()).hexdigest(), rows=int(ip["rows"]),
                                   first_ts=a, last_ts=b - 1, handle=None, cls="pin", trunc=False))
            except KeyError as e:
                unpinned.append({"what": f"polymarket updown15 ladders {d}", "why": f"the day is not finalized by the ladder job ({str(e)[:60]})"})
    for s in (symbols or D.SYMBOL.values()):
        ip = ticks.input_pin(s, lo, hi)
        series.append(dict(spec=f"binance:{s}:aggTrades:-", pin=hashlib.sha256(f"binance:{s}:{ip['digest']}".encode()).hexdigest(), rows=int(sum(f["rows"] for f in ip["files"])),
                           first_ts=lo, last_ts=hi - 1, handle=None, cls="pin", trunc=False))
    unpinned.append({"what": "gamma market list (updown15.markets)", "why": "a day cache of the venue's own listing, re-readable; its outcomes are inside the derived days' pins"})
    return {"digest": REPORT.inputs_digest([x["pin"] for x in series]), "series": series, "unpinned": unpinned}
