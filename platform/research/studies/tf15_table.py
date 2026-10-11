"""The decision table of the 15-minute Up/Down strategy search (B-0654): one UTC day in, one 1-second table per window out.

Every candidate strategy of the search is a rule over THIS table, so a candidate costs seconds, not an archive read. The table holds, for each window and each
whole second k (5 s after the start to 5 s before the end):
    S, z, sig, pu, zl10/30/60   the Binance state as of t (the trade-implied mid, the same causal features as the 15-minute study) and the Brownian TWAP fair value
    qb, qa, qbs, qas            the Up book's best bid / ask and sizes as of t + decide_ms (what the trader sees when it learns of the Binance print at t)
    age                         ms from the gate's book row to t + decide_ms (-1 where no row yet)
    lad[., ., 4, L]             the Up ladder as of t + fill_ms: bid px, bid size, ask px, ask size, L levels, best first (the fill)
    path                        the Binance 1 s mid path from 60 s before the start to 60 s after (the window's own history, for features built offline)
    prints                      the window's Polymarket trades (ts relative to start, px, size, side) for a resting-order fill model
The Down token is the venue's mirror of the Up book (a Down ask at 1 - an Up bid, the same size), the rule `updown15_run.Book` uses.
No outcome is used to build any column but `up_won`, which a strategy reads only to settle.

THE CLOCK (the timing audit, 2026-10-11, `lab/research/data/backtest-audit-timing-2026-10-11.md` finding 2). A live system learns of a Binance print at t only
after its own latency, decides on the book as it stands THEN, and its order meets the ladder the venue's hold later. So the gate reads the book at
t + decide_ms (own latency) and the fill reads the ladder at t + fill_ms = t + decide_ms + VENUE_HOLD_MS. decide_ms 0 is the old table (gate at the print
itself), seated under CODE_V0 and never rebuilt; decide_ms > 0 is seated under CODE (`tf15_runner.key_of` names both delays).

SOURCES are injected exactly as in `updown15_day` (`Sources` of `updown15_runner`): no file or network call lives here.
"""
from __future__ import annotations

import time

import numpy as np

import updown15_day as D
import updown15_run as R

CODE = "tf15-2026-10-11a"            # the gate read at t + decide_ms (decide_ms > 0)
CODE_V0 = "tf15-2026-10-08b"          # the gate read at t (decide_ms 0): the tables seated before 2026-10-11, same derivation
DATASET = "tf15-table"
K0, K1 = 5, 895                      # first and last decision second of a window
NK = K1 - K0 + 1
L = 4                                 # ladder levels kept
FILL_MS = 150                         # the venue's taker delay: an order decided at t meets the book as of t + FILL_MS
VENUE_HOLD_MS = FILL_MS               # the same hold, named for the clock above: fill_ms = decide_ms + VENUE_HOLD_MS
EV_BUCKET_MS = 20                     # Binance trades are thinned to the last one in each 20 ms (a cancel cannot land faster than that)


def _ladder_at(book: R.Book, t: np.ndarray):
    """(4, n, L) arrays bid_px, bid_sz, ask_px, ask_sz of the book row with ts <= t; NaN where no row yet."""
    i = book.at(t)
    ok = i >= 0
    j = np.maximum(i, 0)
    out = []
    for a in (book.bid_px, book.bid_sz, book.ask_px, book.ask_sz):
        x = np.asarray(a)[j, :L].astype(np.float32)
        x[~ok] = np.nan
        out.append(x)
    return np.stack(out), i


def code_of(decide_ms: int) -> str:
    return CODE_V0 if int(decide_ms) == 0 else CODE


def _gate_at(book: R.Book, t: np.ndarray, decide_ms: int = 0):
    """The gate's view of the Up book for Binance prints at t: the row with ts <= t + decide_ms -> (qb, qa, qbs, qas, age ms; -1 where no row)."""
    td = t + int(decide_ms)
    i0 = book.at(td)
    ok0 = i0 >= 0
    j0 = np.maximum(i0, 0)
    qb = np.where(ok0, book.best_bid[j0], np.nan).astype(np.float32)
    qa = np.where(ok0, book.best_ask[j0], np.nan).astype(np.float32)
    qbs = np.where(ok0, book.bid_sz[j0, 0], np.nan).astype(np.float32)
    qas = np.where(ok0, book.ask_sz[j0, 0], np.nan).astype(np.float32)
    age = np.where(ok0, td - book.ts[j0], -1).astype(np.int32)
    return qb, qa, qbs, qas, age


def derive_window(A: R.Asset, book: R.Book, r: dict, a0: float, st: dict, fill_ms: int = FILL_MS, decide_ms: int = 0):
    """One window -> dict of arrays (NK,...). The Binance features at t, the gate's book at t + decide_ms, the fill's ladder at t + fill_ms."""
    assert int(fill_ms) >= int(decide_ms) >= 0, "the order cannot meet the ladder before the decision"
    start = r["start_ms"]
    t = start + 1000 * np.arange(K0, K1 + 1, dtype=np.int64)
    f = R.features(A, t, start, r["end_ms"], a0)
    pu = R.p_up_brownian(f)
    qb, qa, qbs, qas, age = _gate_at(book, t, decide_ms)
    lad, i_f = _ladder_at(book, t + int(fill_ms))
    return dict(S=f["S"].astype(np.float32), z=f["z"].astype(np.float32), sig=f["sig"].astype(np.float32), pu=pu.astype(np.float32),
                zl=np.column_stack([f[f"zl{L_}"] for L_ in R.LB]).astype(np.float32), qb=qb, qa=qa, qbs=qbs, qas=qas, lad=lad, age=age,
                known=f["known_sum"].astype(np.float32))


def derive_day(day: str, rows: list[dict], trades, hours, only_hours=None, progress=None, fill_ms: int = FILL_MS, decide_ms: int = 0):
    """The day's table: (arrays, meta). `rows` are market rows with `up_won`; `hours(hour, rows)` yields (row, states, audit) of the pinned ladders."""
    t0 = time.time()
    assets, metas = D.build_assets(day, trades, kinds=("mid",))
    rows = sorted(rows, key=lambda r: (D.ASSETS.index(r["asset"]), r["start_ms"]))
    W = len(rows)
    widx = {r["slug"]: i for i, r in enumerate(rows)}
    nan = lambda *s: np.full(s, np.nan, np.float32)               # noqa: E731
    X = dict(S=nan(W, NK), z=nan(W, NK), sig=nan(W, NK), pu=nan(W, NK), zl=nan(W, NK, 3), qb=nan(W, NK), qa=nan(W, NK), qbs=nan(W, NK), qas=nan(W, NK),
             lad=nan(W, 4, NK, L), age=np.full((W, NK), -1, np.int32), known=nan(W, NK), path=nan(W, 961))
    Wm = dict(w_asset=np.array([D.ASSETS.index(r["asset"]) for r in rows], np.int8), w_start=np.array([r["start_ms"] for r in rows], np.int64),
              w_up=np.array([int(bool(r["up_won"])) for r in rows], np.int8), w_a0=np.zeros(W), w_aend=np.zeros(W), w_gap=np.zeros(W, np.float32),
              w_status=np.full(W, 1, np.int8), w_fee=np.array([r["fee_rate"] for r in rows], np.float32),
              w_exp=np.array([r["fee_exponent"] for r in rows], np.float32), w_min=np.array([r.get("min_size", 5) for r in rows], np.float32),
              w_ptb=np.array([r.get("price_to_beat") or np.nan for r in rows]), w_final=np.array([r.get("final_price") or np.nan for r in rows]),
              w_rows=np.zeros(W, np.int32), w_first_ms=np.full(W, -1, np.int32))
    pr = {k: [] for k in ("p_w", "p_t", "p_px", "p_sz", "p_side")}
    ev = {k: [] for k in ("e_w", "e_t", "e_S", "e_known", "e_sig")}
    for hour, hrows in sorted(D._by_hour(rows).items()):
        if only_hours is not None and hour not in only_hours:
            continue
        for r, st, _aud in hours(hour, hrows):
            wi = widx[r["slug"]]
            A = assets[r["asset"]]["mid"]
            a0, ae, k0 = A.window_refs(r["start_ms"])
            Wm["w_a0"][wi], Wm["w_aend"][wi] = a0, ae
            Wm["w_gap"][wi] = A.gap_s(r["start_ms"], r["end_ms"])
            book = R.Book(st)
            Wm["w_rows"][wi] = len(book.ts)
            if len(book.ts) == 0 or book.ts[0] > r["start_ms"] + R.OPEN_S * 1000:
                Wm["w_status"][wi] = 1
                continue
            if Wm["w_gap"][wi] > D.GAP_MAX_S:
                Wm["w_status"][wi] = 2
                continue
            Wm["w_status"][wi] = 0
            Wm["w_first_ms"][wi] = int(book.ts[0] - r["start_ms"])
            d = derive_window(A, book, r, a0, st, fill_ms, decide_ms)
            for k, v in d.items():
                X[k][wi] = v
            X["path"][wi] = A.gp[k0 - 60: k0 + 901].astype(np.float32)
            lo_i = np.searchsorted(A.ts, r["start_ms"] + 5000)
            hi_i = np.searchsorted(A.ts, r["end_ms"] - 1000, side="right")
            te = np.unique(A.ts[lo_i:hi_i])
            if len(te):
                te = te[np.concatenate([te[1:] // EV_BUCKET_MS != te[:-1] // EV_BUCKET_MS, [True]])]
                fe = R.features(A, te, r["start_ms"], r["end_ms"], a0)
                ev["e_w"].append(np.full(len(te), wi, np.int32))
                ev["e_t"].append((te - r["start_ms"]).astype(np.int32))
                ev["e_S"].append(fe["S"].astype(np.float32))
                ev["e_known"].append(fe["known_sum"].astype(np.float32))
                ev["e_sig"].append(fe["sig"].astype(np.float32))
            p = st.get("prints") or {}
            if "ts" in p and len(p["ts"]):
                n = len(p["ts"])
                pr["p_w"].append(np.full(n, wi, np.int32))
                pr["p_t"].append((np.asarray(p["ts"], np.int64) - r["start_ms"]).astype(np.int32))
                pr["p_px"].append(np.asarray(p["px"], np.float32))
                pr["p_sz"].append(np.asarray(p["size"], np.float32))
                pr["p_side"].append(np.asarray(p["side"], np.int8))
            if progress:
                progress(wi, W)
    for k, v in list(pr.items()) + list(ev.items()):
        X[k] = np.concatenate(v) if v else np.zeros(0)
    X.update(Wm)
    meta = dict(code=code_of(decide_ms), day=day, windows=W, ok=int((Wm["w_status"] == 0).sum()), fill_ms=int(fill_ms), k0=K0, k1=K1, levels=L, seconds=round(time.time() - t0, 1),
                binance=metas)
    if int(decide_ms):
        meta["decide_ms"] = int(decide_ms)
    return X, meta


def pack(arrs, meta):
    return D.pack(arrs, meta)


def unpack(blob):
    return D.unpack(blob)


def checks() -> list[tuple[str, bool]]:
    """Planted books for the gate clock (no I/O)."""
    out = []
    t = np.array([10_000, 11_000, 12_000], np.int64)
    # rows at 9,000 (ask 0.40), 10,050 (ask 0.45: the book moved 50 ms after the first print), 12,500 (ask 0.50)
    st = dict(ts=np.array([9_000, 10_050, 12_500]), bid_px=np.array([[0.38], [0.43], [0.48]]), bid_sz=np.array([[10.0], [11.0], [12.0]]),
              ask_px=np.array([[0.40], [0.45], [0.50]]), ask_sz=np.array([[20.0], [21.0], [22.0]]), best_bid=np.array([0.38, 0.43, 0.48]),
              best_ask=np.array([0.40, 0.45, 0.50]))
    b = R.Book(st)
    _, qa0, _, _, age0 = _gate_at(b, t, 0)
    _, qa1, _, _, age1 = _gate_at(b, t, 100)
    out.append(("gate at t reads the row before a change 50 ms after the print", np.allclose(qa0, [0.40, 0.45, 0.45]) and list(age0) == [1000, 950, 1950]))
    out.append(("gate at t + 100 ms reads the changed row (the new qa differs from the old)", np.allclose(qa1, [0.45, 0.45, 0.45]) and qa1[0] != qa0[0]))
    out.append(("age is measured from t + decide_ms", list(age1) == [50, 1050, 2050]))
    _, qa_e, _, _, age_e = _gate_at(b, np.array([8_000], np.int64), 100)
    out.append(("no row yet: qa NaN, age -1", np.isnan(qa_e[0]) and age_e[0] == -1))
    lad, _ = _ladder_at(b, t + 600)
    out.append(("the fill reads the ladder at t + fill_ms", np.allclose(lad[2, :, 0], [0.45, 0.45, 0.50])))
    out.append(("the code names the clock", code_of(0) == CODE_V0 and code_of(100) == CODE and CODE != CODE_V0))
    return out


def selftest() -> bool:
    res = checks()
    for name, ok in res:
        print(("PASS " if ok else "FAIL ") + name)
    return all(ok for _, ok in res)


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
