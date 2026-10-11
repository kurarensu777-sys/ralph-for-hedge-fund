"""Derive and seat the decision tables of the strategy search (B-0654), one UTC day at a time.

    python tf15_runner.py run 2026-10-03 [2026-10-04 ...] [--force] [--fill-ms 250] [--decide-ms 100]
    python tf15_runner.py status
    python tf15_runner.py smoke 2026-09-05 --fill-ms 250 --decide-ms 100     (the gate clock against the old table of the same day; both seated)

The inputs are the pinned ladders and the Binance day files, read through `fundplat.data` (see `updown15_runner.Sources`). A seated day with the same key is skipped.
Keys: decide_ms 0 (the gate reads the book at the Binance print) is the old table, `<day>@tf15-2026-10-08b[-d<fill>]`; decide_ms > 0 (the gate reads the book
at t + decide_ms, the fill at t + fill_ms) is `<day>@tf15-2026-10-11b-d<fill>-g<decide>` with the fair value against the venue's price to beat and the Binance stream converted by the previous day's basis (ref "ptbb", the
default), or `<day>@tf15-2026-10-11a-d<fill>-g<decide>` against the Binance start TWAP (ref "a0", kept); see `tf15_table`, THE CLOCK and THE REFERENCE.
"""
from __future__ import annotations

import argparse
import json
import sys
import time

import tf15_table as T
import updown15_runner as RN


def key_of(day: str, fill_ms: int = T.FILL_MS, decide_ms: int = 0, ref: str = "ptbb") -> str:
    if int(decide_ms) == 0:
        return f"{day}@{T.CODE_V0}" + ("" if fill_ms == T.FILL_MS else f"-d{fill_ms}")
    return f"{day}@{T.code_of(decide_ms, ref)}-d{int(fill_ms)}-g{int(decide_ms)}"


def seated(day: str, fill_ms: int = T.FILL_MS, decide_ms: int = 0, ref: str = "ptbb"):
    from fundplat.data import derived
    try:
        return derived.get(T.DATASET, key_of(day, fill_ms, decide_ms, ref))
    except KeyError:
        return None


def load(day: str, fill_ms: int = T.FILL_MS, decide_ms: int = 0, ref: str = "ptbb"):
    """-> (arrays, meta) of a seated day; LookupError when it is not seated (run it first)."""
    b = seated(day, fill_ms, decide_ms, ref)
    if b is None:
        raise LookupError(f"table day {day} is not seated: python tf15_runner.py run {day} --fill-ms {fill_ms} --decide-ms {decide_ms} --ref {ref}")
    return T.unpack(b)


def run_day(day: str, force: bool = False, log=print, fill_ms: int = T.FILL_MS, decide_ms: int = 0, ref: str = "ptbb") -> dict:
    from fundplat.data import derived
    ref = T.ref_of(decide_ms, ref)
    old = seated(day, fill_ms, decide_ms, ref)
    if old is not None and not force:
        log(f"{day}: seated ({len(old) / 1e6:.1f} MB), skipped")
        return dict(day=day, skipped=True)
    t0 = time.time()
    rows = [RN._as_row(r) for r in RN.market_rows(day)]
    src = RN.Sources()
    prev_rows = None
    if ref == "ptbb":                              # the causal basis reads the previous day's prices to beat (`tf15_table`, THE BASIS)
        import updown15_day as D
        try:
            prev_rows = [RN._as_row(r) for r in RN.market_rows(D.prev_day(day))]
        except Exception as ex:                    # no market rows for the previous day: the table falls back to its own first hours, flagged [U]
            log(f"{day}: previous day's market rows unavailable ({ex!r:.120}); the basis falls back to the day's own first hours")
    arrs, meta = T.derive_day(day, rows, src.trades, src.hours, fill_ms=fill_ms, decide_ms=decide_ms, ref=ref, prev_rows=prev_rows)
    meta["pin_missing"] = [m[0] for m in src.missing][:50]
    blob = T.pack(arrs, meta)
    res = derived.put(T.DATASET, key_of(day, fill_ms, decide_ms, ref), blob, {"code": T.code_of(decide_ms, ref), "fill_ms": int(fill_ms), "decide_ms": int(decide_ms), "ref": ref,
                                                                         "markets": len(rows), "markets_without_a_pinned_book": len(src.missing)})
    row = dict(day=day, fill_ms=int(fill_ms), decide_ms=int(decide_ms), ref=ref, no_reference=meta.get("no_reference", 0), basis=meta.get("basis"),
               basis_source=meta.get("basis_source"), windows=meta["windows"], ok=meta["ok"], bytes=len(blob), seconds=round(time.time() - t0, 1), no_pin=len(src.missing), seat=res)
    log(json.dumps(row, default=str))
    return row


def smoke(day: str, fill_ms: int = 250, decide_ms: int = 100, base_fill_ms: int = 250, log=print, ref: str = "a0") -> list[tuple[str, bool]]:
    """The gate clock on one seated day, against the old table (gate at t, fill at t + base_fill_ms): the Binance features are the same; where the gate's row
    arrived inside (t, t + decide_ms] the quotes may differ and the row is younger than decide_ms; elsewhere the quotes are the old ones and the age is the
    old age plus decide_ms; with the same fill the ladder is the same. -> [(label, passed)]."""
    import numpy as np
    old, _ = load(day, base_fill_ms, 0)
    new, mn = load(day, fill_ms, decide_ms, ref)
    if ref in ("ptb", "ptbb"):
        return smoke_ref(day, old, new, mn, log, ref)
    ok = old["w_status"] == 0
    qa0, qa1, a0, a1 = old["qa"][ok], new["qa"][ok], old["age"][ok], new["age"][ok]
    have = (a0 >= 0) & (a1 >= 0)
    diff = have & np.isfinite(qa0) & np.isfinite(qa1) & (qa0 != qa1)
    same = have & (a1 >= decide_ms)
    log(f"{day} gate +{decide_ms} ms, fill +{fill_ms} ms: {int(have.sum()):,} window-seconds, the gate's row newer than t on {float((have & (a1 < decide_ms)).mean()):.1%}, "
        f"qa differs from the old table on {int(diff.sum()):,}")
    out = [("the same windows are usable", bool(np.array_equal(ok, new["w_status"] == 0))),
           ("the new qa differs from the old somewhere (the gate moved)", int(diff.sum()) > 0),
           ("every changed qa sits on a row younger than decide_ms", bool(np.all(a1[diff] < decide_ms))),
           ("an unchanged row keeps the old quote", bool(np.allclose(qa0[same], qa1[same], equal_nan=True))),
           ("age is measured from t + decide_ms", bool(np.all(a1[same] == a0[same] + decide_ms))),
           ("the Binance features are the old ones", all(np.allclose(old[k][ok], new[k][ok], equal_nan=True) for k in ("S", "z", "pu", "zl"))),
           ("the meta names the clock", mn.get("decide_ms") == decide_ms and mn["fill_ms"] == fill_ms and mn["code"] == T.code_of(decide_ms, ref))]
    if fill_ms == base_fill_ms:
        out.append(("the same fill reads the same ladder", bool(np.allclose(old["lad"][ok], new["lad"][ok], equal_nan=True))))
    return out


def smoke_ref(day, old, new, mn, log=print, ref="ptb") -> list[tuple[str, bool]]:
    """The venue reference on one seated day, against the old table: the windows lost are exactly those without a published price to beat (status 3); on the
    windows both keep, the Binance features are the old ones and the fair value is the Brownian TWAP P(Up) recomputed against the price to beat."""
    import numpy as np
    import updown15_run as UR
    import updown15_model as UM
    st0, st1 = old["w_status"], new["w_status"]
    ok = (st0 == 0) & (st1 == 0)
    ptb = new["w_ptb"]
    lost = (st0 == 0) & (st1 != 0)
    log(f"{day} venue reference: {int((st1 == 3).sum())} windows without a published price to beat, {int(ok.sum())} kept by both tables, "
        f"median ln(Binance start TWAP / price to beat) {float(np.nanmedian(np.log(new['w_a0'][ok] / ptb[ok]))) * 1e4:+.2f} bp")
    # recompute pu from the stored columns at a sample of windows: S, sig, known and the clock come from the table, the reference from w_ptb
    rec = []
    for w in np.flatnonzero(ok)[:25]:
        T_ = (900 - (T.K0 + np.arange(T.NK))).astype(float)
        if ref == "ptbb":                          # the stream converted by the basis applied to the window (w_basis, bp)
            f_ = np.exp(-float(new["w_basis"][w]) * 1e-4)
            p = UM.twap_p(new["S"][w].astype(float) * f_, np.full(T.NK, ptb[w]), new["sig"][w].astype(float), T_, new["known"][w].astype(float) * f_, UR.TWAP_S)
        else:
            p = UM.twap_p(new["S"][w].astype(float), np.full(T.NK, ptb[w]), new["sig"][w].astype(float), T_, new["known"][w].astype(float), UR.TWAP_S)
        g = np.abs(p - new["pu"][w])
        rec.append((np.nanmax(g[T_ >= 30]), np.nanmedian(g)))          # the last 30 s divide by a tiny variance: the float32 columns move pu there
    out = [("every window the new table drops is one without a published price to beat", bool(np.all(st1[lost] == 3)) and bool(np.all(~np.isfinite(ptb[st1 == 3]) | (ptb[st1 == 3] <= 0)))),
           ("no kept window lacks a price to beat", bool(np.all(np.isfinite(ptb[st1 == 0]) & (ptb[st1 == 0] > 0)))),
           ("the Binance features are the old ones", all(np.allclose(old[k][ok], new[k][ok], equal_nan=True) for k in ("S", "z", "zl", "sig", "known"))),
           ("pu is the TWAP P(Up) against the price to beat (25 windows recomputed from the float32 columns, whose rounding moves z by about 3e-4: median gap under 3e-4, largest with 30 s or more left under 1e-3)",
            len(rec) > 0 and max(m for _, m in rec) < 3e-4 and max(x for x, _ in rec) < 1e-3),
           ("pu moved from the old table's somewhere", bool(np.nanmax(np.abs(old["pu"][ok] - new["pu"][ok])) > 1e-3)),
           ("the meta names the reference and counts the windows without one", mn.get("ref") == ref and mn.get("no_reference") == int((st1 == 3).sum())
            and mn["code"] == T.code_of(100, ref))]
    if ref == "ptbb":
        out.append(("every kept window carries the basis its coin's meta names, and the meta names its source",
                    bool(mn.get("basis_source")) and all(abs(float(new["w_basis"][w]) - mn["basis"][("btc", "eth", "sol", "xrp")[int(new["w_asset"][w])]]["bp"]) < 1e-2
                                                          for w in np.flatnonzero(st1 == 0))))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="tf15_runner")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("run")
    p.add_argument("days", nargs="+")
    p.add_argument("--force", action="store_true")
    p.add_argument("--fill-ms", type=int, default=T.FILL_MS)
    p.add_argument("--decide-ms", type=int, default=0, help="the gate reads the book at t + decide_ms (own latency); the fill stays t + fill_ms")
    p.add_argument("--ref", default="ptbb", choices=T.REFS, help="the fair value's start reference (decide_ms > 0): the venue's price to beat, or the Binance a0")
    sub.add_parser("status")
    p = sub.add_parser("smoke")
    p.add_argument("day")
    p.add_argument("--fill-ms", type=int, default=250)
    p.add_argument("--decide-ms", type=int, default=100)
    p.add_argument("--ref", default="a0", choices=T.REFS)
    a = ap.parse_args(argv)
    if a.cmd == "smoke":
        res = smoke(a.day, a.fill_ms, a.decide_ms, ref=a.ref)
        for name, ok in res:
            print(("PASS " if ok else "FAIL ") + name)
        return 0 if all(ok for _, ok in res) else 1
    if a.cmd == "status":
        from fundplat.data import derived
        print(json.dumps(derived.keys(T.DATASET)))
        return 0
    for d in a.days:
        run_day(d, force=a.force, fill_ms=a.fill_ms, decide_ms=a.decide_ms, ref=a.ref)
    return 0


if __name__ == "__main__":
    sys.exit(main())
