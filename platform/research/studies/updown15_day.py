"""run_day for the 15-minute Up/Down study (B-0642): one UTC day in, one small derived bundle out.

    derive_fit_day(day, rows, trades, ...)       Binance only: the momentum features at 5 s instants and the outcome (the FIT days)
    fit_maps(fit_blobs)                          the probability maps, from the FIT days' bundles alone
    derive_book_day(day, rows, trades, hours, maps, ...)   with the Polymarket ladders (VALIDATION and TEST days): the whole configuration grid at 250 ms
    derive_verify_day(...)                       the planted tests and the latency table for ONE configuration, from the same ladders
    pack / unpack                                the day's one gzip npz blob (+ a JSON header)

SOURCES are injected (the runner passes the `fundplat.data` loaders; no file or network call lives here):
    trades(symbol, day)  -> (DataFrame ts_ms, price, qty, buyer_maker; meta dict)      one UTC day of Binance aggTrades
    index_1m(symbol, day) -> DataFrame open_ms, close                                  USD-M index price 1 m klines
    hours(hour, rows)     -> iterator of (market row, states dict, audit dict)         the Up token's ladder states of every window in that archive hour
All arrays are numpy; times are UTC epoch ms; a window's time axis is ms since its own start.
"""
from __future__ import annotations

import hashlib
import io
import json
import time
from datetime import datetime, timedelta, timezone

import numpy as np

import updown15_model as M
import updown15_run as R

ASSETS = ("btc", "eth", "sol", "xrp")
SYMBOL = {"btc": "BTCUSDT", "eth": "ETHUSDT", "sol": "SOLUSDT", "xrp": "XRPUSDT"}
DAY_MS = 86_400_000
WIN_S = 900
LEAD_S, TAIL_S = 120, 5
BOOK_STEP_MS = 250                                  # the stored best bid/ask grid
NB = WIN_S * 1000 // BOOK_STEP_MS + (LEAD_S + TAIL_S) * 1000 // BOOK_STEP_MS       # columns of the 250 ms grid, -120 s .. +5 s past the end
LAD_STEP_S = 5
LAD_T0_S, LAD_T1_S = -60, 895
NL = (LAD_T1_S - LAD_T0_S) // LAD_STEP_S + 1
LAD_LEVELS = 5
BN_T0_S = -60                                       # the Binance 1 s path from 60 s before the start
NBN = WIN_S - BN_T0_S + 1
NS = len(R.sample_instants(0, WIN_S * 1000))        # scoring instants per window (every 5 s from 10 s to 840 s)
NA = 65535
GAP_MAX_S = 30.0                                    # exclusion rule written before outcomes: a Binance gap over 30 s inside the window
STATUS = {0: "ok", 1: "no_book", 2: "binance_gap", 3: "binance_only"}
CSTATUS = {0: "no_edge", 1: "entered", 2: "ask_gone", 3: "no_depth", 4: "late"}
CODE_OF = {v: k for k, v in CSTATUS.items()}
MAP_COLS = ("logit", "table10", "table30", "table60")      # the momentum-side probability columns kept per event


def day_start_ms(day: str) -> int:
    return int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def prev_day(day: str) -> str:
    return (datetime.strptime(day, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")


def hour_label(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H")


# =============================================================== the blob
def pack(arrs: dict, meta: dict) -> bytes:
    buf = io.BytesIO()
    payload = dict(arrs)
    payload["_meta"] = np.frombuffer(json.dumps(meta, sort_keys=True).encode("utf-8"), dtype=np.uint8)
    np.savez_compressed(buf, **payload)
    return buf.getvalue()


def unpack(blob: bytes):
    z = np.load(io.BytesIO(blob), allow_pickle=False)
    meta = json.loads(bytes(z["_meta"]).decode("utf-8"))
    return {k: z[k] for k in z.files if k != "_meta"}, meta


def sha(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def _q(x):
    """price (0..1) -> uint16 in 0.001 ticks; NaN -> NA"""
    x = np.asarray(x, float)
    return np.where(np.isfinite(x), np.clip(np.round(x * 1000.0), 0, 1000), NA).astype(np.uint16)


def _p16(p):
    return np.clip(np.round(np.asarray(p, float) * 65534.0), 0, 65534).astype(np.uint16)


# =============================================================== Binance for a day
def build_assets(day: str, trades, kinds=("last", "mid"), return_df: bool = False):
    """{asset: {kind: Asset}} over day-1 .. day (+1 s), plus the file metas. Two days are read per asset: the previous one warms the volatility."""
    import pandas as pd
    g0 = day_start_ms(prev_day(day))
    g1 = day_start_ms(day) + DAY_MS + 1000
    out, metas, dfs = {}, {}, {}
    for a in ASSETS:
        frames, ms = [], []
        for d in (prev_day(day), day):
            df, meta = trades(SYMBOL[a], d)
            frames.append(df)
            ms.append(meta)
        df = pd.concat(frames, ignore_index=True)
        df = df[(df["ts_ms"] >= g0) & (df["ts_ms"] < g1)]
        out[a] = {k: R.Asset(df, g0, g1, kind=k) for k in kinds}
        metas[a] = ms
        dfs[a] = df
    return (out, metas, dfs) if return_df else (out, metas)


def proxy_error(A_last, A_mid, idx_df) -> dict:
    """The last trade and the trade-implied mid against the USD-M index 1 m close: at the end of each minute, the proxy as of that second against
    the index kline's close, in basis points (signed). Both are proxies of the same price; the index is a composite of spot quotes."""
    out = {}
    if idx_df is None or not len(idx_df):
        return out
    ot = np.asarray(idx_df["open_ms"], dtype=np.int64)
    cl = np.asarray(idx_df["close"], float)
    t_end = ot + 60_000 - 1000
    for nm, A in (("last", A_last), ("mid", A_mid)):
        i = M.asof_idx(A.ts, t_end)
        ok = (i >= 0) & (t_end >= A.g0)
        e = (A.px[np.maximum(i, 0)][ok] / cl[ok] - 1.0) * 1e4
        out[nm] = dict(n=int(ok.sum()), mean_bp=float(np.mean(e)), mad_bp=float(np.mean(np.abs(e - np.mean(e)))),
                       p95_abs_bp=float(np.percentile(np.abs(e), 95)), max_abs_bp=float(np.max(np.abs(e))))
    return out


def causality_probe(dfs: dict, assets: dict, rows: list[dict], n: int = 8, seed: int = 11, kind: str = "mid") -> dict:
    """THE LOOK-AHEAD CHECK on real rows: for `n` random windows, rebuild the asset from the trades up to a random cut inside the window and require every feature
    at the instants up to the cut to equal the full-day run's. Then PLANT a fault (features read one second from the future) and require the same comparison to
    fail. -> {n, equal, planted_caught}; a clean run has equal == n and planted_caught == n."""
    rng = np.random.default_rng(seed)
    keys = ("S", "z", "sig", "r10", "r30", "r60", "known_sum")
    eq = caught = 0
    pick = rng.choice(len(rows), size=min(n, len(rows)), replace=False)
    for i in pick:
        r = rows[int(i)]
        a = r["asset"]
        A = assets[a][kind]
        cut = r["start_ms"] + int(rng.integers(120_000, 780_000))
        df = dfs[a]
        Ac = R.Asset(df[df["ts_ms"] <= cut], A.g0, A.g0 + A.n * 1000, kind=kind)
        a0, _, _ = A.window_refs(r["start_ms"])
        a0c, _, _ = Ac.window_refs(r["start_ms"])
        tt = R.sample_instants(r["start_ms"], r["end_ms"])
        tt = tt[tt <= cut]
        ff = R.features(A, tt, r["start_ms"], r["end_ms"], a0)
        fc = R.features(Ac, tt, r["start_ms"], r["end_ms"], a0c)
        eq += int(a0 == a0c and all(np.array_equal(ff[k], fc[k]) for k in keys))
        fb = R.features(A, tt, r["start_ms"], r["end_ms"], a0, shift_ms=-1000)
        caught += int(any(not np.array_equal(fb[k], fc[k]) for k in ("S", "z", "r10")))
    return dict(n=int(len(pick)), equal=int(eq), planted_caught=int(caught))


def convention_agreement(A: R.Asset, rows) -> dict:
    """How well each reading of the rule's reference reproduces the recorded outcome, on this Binance series: the price at the start and end seconds (snapshot),
    the trailing 60 s mean at both (the venue's TWAP stream), the FORWARD 60 s mean at both, and the two mixes. -> {variant: [agree, windows]}."""
    out = {k: [0, 0] for k in ("snapshot", "trailing", "forward", "snap_start_trail_end", "trail_start_snap_end")}
    for r in rows:
        k0 = int((r["start_ms"] - A.g0) // 1000)
        k1 = k0 + WIN_S
        if k0 - R.TWAP_S < 0 or k1 + R.TWAP_S >= A.n:
            continue
        s0, s1 = A.gp[k0], A.gp[k1]
        tr0, tr1 = A.twap(k0), A.twap(k1)
        fw0, fw1 = A.twap(k0 + R.TWAP_S), A.twap(k1 + R.TWAP_S)
        pred = {"snapshot": s1 >= s0, "trailing": tr1 >= tr0, "forward": fw1 >= fw0, "snap_start_trail_end": tr1 >= s0, "trail_start_snap_end": s1 >= tr0}
        for k, v in pred.items():
            out[k][0] += int(bool(v) == bool(r["up_won"]))
            out[k][1] += 1
    return out


# =============================================================== a FIT day (Binance only)
SAMPLE_KEYS = ("S", "A0", "T", "t_el", "sig", "z", "r10", "r30", "r60", "known_sum")


def derive_fit_day(day: str, rows: list[dict], trades, index_1m=None, kind: str = "mid") -> tuple[bytes, dict]:
    """The FIT day's bundle: for each window the momentum features at the 5 s scoring instants and the outcome. No Polymarket data."""
    t0 = time.time()
    assets, metas, dfs = build_assets(day, trades, return_df=True)
    rows = sorted(rows, key=lambda r: (ASSETS.index(r["asset"]), r["start_ms"]))
    W = len(rows)
    arrs = {k: [] for k in SAMPLE_KEYS}
    s_w, s_asset, s_y = [], [], []
    w_up = np.array([int(bool(r["up_won"])) for r in rows], np.int8)
    w_asset = np.array([ASSETS.index(r["asset"]) for r in rows], np.int8)
    w_start = np.array([r["start_ms"] for r in rows], np.int64)
    w_a0 = np.zeros(W)
    w_ae = np.zeros(W)
    w_gap = np.zeros(W, np.float32)
    for wi, r in enumerate(rows):
        A = assets[r["asset"]][kind]
        a0, ae, _ = A.window_refs(r["start_ms"])
        w_a0[wi], w_ae[wi] = a0, ae
        w_gap[wi] = A.gap_s(r["start_ms"], r["end_ms"])
        tt = R.sample_instants(r["start_ms"], r["end_ms"])
        f = R.features(A, tt, r["start_ms"], r["end_ms"], a0)
        for k in SAMPLE_KEYS:
            arrs[k].append(f[k])
        s_w.append(np.full(len(tt), wi, np.int32))
        s_asset.append(np.full(len(tt), w_asset[wi], np.int8))
        s_y.append(np.full(len(tt), int(w_up[wi]), np.int8))
    out = {k: np.concatenate(v) for k, v in arrs.items()}
    out.update(s_w=np.concatenate(s_w), s_asset=np.concatenate(s_asset), s_y=np.concatenate(s_y),
               w_up=w_up, w_asset=w_asset, w_start=w_start, w_a0=w_a0, w_aend=w_ae, w_gap_s=w_gap)
    audit = dict(windows=W, samples=int(len(out["s_y"])), seconds=round(time.time() - t0, 1), kind=kind)
    audit["causality"] = causality_probe(dfs, assets, rows)
    audit["conventions"] = {a: convention_agreement(assets[a]["last"], [r for r in rows if r["asset"] == a]) for a in ASSETS}
    audit["agree"] = {}
    for k_ in ("last", "mid"):
        audit["agree"][k_] = {}
        for a in ASSETS:
            k = n = 0
            for r in rows:
                if r["asset"] != a:
                    continue
                a0, ae, _ = assets[a][k_].window_refs(r["start_ms"])
                k += int((ae >= a0) == bool(r["up_won"]))
                n += 1
            audit["agree"][k_][a] = [k, n]
    if index_1m is not None:
        audit["proxy_error"] = {a: proxy_error(assets[a]["last"], assets[a]["mid"], index_1m(SYMBOL[a], day)) for a in ASSETS}
    audit["binance_files"] = {a: [m for m in metas[a]] for a in ASSETS}
    meta = dict(day=day, role="fit", kind=kind, audit=audit, schema=2)
    return pack(out, meta), audit


def fit_maps(fit_blobs: list[bytes]):
    """The probability maps from the FIT days' bundles alone: rows are the 5 s instants with |z| >= Z_FIT_MIN, the label is whether the momentum side won.
    -> (Maps, report)."""
    days = [unpack(b) for b in fit_blobs]
    cat = {k: np.concatenate([d[0][k] for d in days]) for k in SAMPLE_KEYS + ("s_y",)}
    side = R.side_of(cat)
    ok = (np.abs(cat["z"]) >= R.Z_FIT_MIN) & (cat["T"] >= R.TMIN_S)
    rows = {k: v[ok] for k, v in cat.items() if k != "s_y"}
    y_side = ((side[ok] > 0) == (cat["s_y"][ok] > 0)).astype(float)
    mp = R.Maps().fit(rows, y_side)
    rep = dict(rows=int(ok.sum()), side_win_rate=float(y_side.mean()), days=[d[1]["day"] for d in days], **mp.report())
    return mp, rep


# =============================================================== a BOOK day (validation or test)
def _book_grid(book: R.Book, start_ms: int):
    t = start_ms - LEAD_S * 1000 + BOOK_STEP_MS * np.arange(NB, dtype=np.int64)
    i = book.at(t)
    j = np.maximum(i, 0)
    bb = np.where(i >= 0, book.best_bid[j], np.nan)
    ba = np.where(i >= 0, book.best_ask[j], np.nan)
    bsz = np.where(i >= 0, book.bid_sz[j, 0], np.nan)
    asz = np.where(i >= 0, book.ask_sz[j, 0], np.nan)
    return bb, ba, bsz, asz


def _ladder5(book: R.Book, start_ms: int):
    t = start_ms + 1000 * np.arange(LAD_T0_S, LAD_T1_S + 1, LAD_STEP_S, dtype=np.int64)
    i = book.at(t)
    j = np.maximum(i, 0)
    miss = (i < 0)[:, None]
    L = LAD_LEVELS
    f = lambda a: np.where(miss, np.nan, a[j, :L]).astype(np.float32)
    return f(book.bid_px), f(book.bid_sz), f(book.ask_px), f(book.ask_sz)


def _bn_path(A_mid: R.Asset, A_last: R.Asset, start_ms: int):
    """1 Hz: the mid proxy, the last trade and the signed taker volume of each second (-60 s .. +900 s)."""
    k0 = int((start_ms - A_mid.g0) // 1000)
    k = k0 + np.arange(BN_T0_S, WIN_S + 1)
    t_hi = A_mid.g0 + 1000 * k
    i_hi = M.asof_idx(A_mid.ts, t_hi)
    i_lo = M.asof_idx(A_mid.ts, t_hi - 1000)
    sv = A_mid.cs[i_hi + 1] - A_mid.cs[i_lo + 1]
    return A_mid.gp[k].astype(np.float32), A_last.gp[k].astype(np.float32), sv.astype(np.float32)


LL_BIN = 100
LL_LAGS = np.arange(-20, 51)                        # bins: -2.0 s .. +5.0 s of Polymarket mid change after a Binance change
EV_STEPS = 51                                       # 100 ms steps of the event-study response, 0 .. 5 s
EV_SIGMA = 3.0                                      # a "large" Binance move: 1 s log return beyond 3 per-second sds


def lead_lag_sums(A: R.Asset, book: R.Book, start_ms: int):
    """One window's sums for (1) the cross-correlation of Binance 100 ms log returns with the Polymarket Up mid's 100 ms changes at each lag and
    (2) the mid's mean signed response after large Binance 1 s moves. Both series are as-of reads on one 100 ms grid (a row's own stamp <= the grid
    instant); sums, so days and windows add exactly. -> (sums [lags, 6]: n, sum a, sum b, sum ab, sum aa, sum bb), (ev [steps, 2]: sum, count)."""
    t = start_ms + 60_000 + LL_BIN * np.arange((WIN_S * 1000 - 120_000) // LL_BIN + 1, dtype=np.int64)
    i = np.maximum(M.asof_idx(A.ts, t), 0)
    S = np.log(A.px[i])
    mid = book.mid(book.at(t))
    ds, dm = np.diff(S), np.diff(mid)
    sums = np.zeros((len(LL_LAGS), 6))
    for j, lag in enumerate(LL_LAGS):
        a = ds[max(0, -lag): len(ds) - max(0, lag)]
        b = dm[max(0, lag): len(dm) - max(0, -lag)]
        m = np.isfinite(a) & np.isfinite(b)
        a, b = a[m], b[m]
        sums[j] = [len(a), a.sum(), b.sum(), (a * b).sum(), (a * a).sum(), (b * b).sum()]
    ev = np.zeros((EV_STEPS, 2))
    r = S[10:] - S[:-10]
    sd1 = np.sqrt(np.maximum(A.ew_slow[A.kof(t[10:])], R.SIG_FLOOR ** 2))
    last = -10 ** 9
    for q in np.flatnonzero(np.abs(r) > EV_SIGMA * sd1):
        q0 = q + 10
        if q0 - last < 50 or q0 + EV_STEPS >= len(mid) or not np.isfinite(mid[q0]):
            continue
        last = q0
        resp = (mid[q0: q0 + EV_STEPS] - mid[q0]) * np.sign(r[q])
        okr = np.isfinite(resp)
        ev[okr, 0] += resp[okr]
        ev[okr, 1] += 1
    return sums, ev


def _by_hour(rows):
    out = {}
    for r in rows:
        out.setdefault(hour_label(r["start_ms"]), []).append(r)
    return out


def _maps_stack(P: dict) -> np.ndarray:
    """The momentum-side probabilities kept per instant: [n, 4] in the order of MAP_COLS."""
    return np.column_stack([P["logit"][10], P["table"][10], P["table"][30], P["table"][60]])


def derive_book_day(day: str, rows: list[dict], trades, hours, maps: R.Maps, index_1m=None, kind: str = "mid", cfgs=None, lats=(R.LATENCY_MS,),
                    progress=None, only_hours=None) -> tuple[bytes, dict]:
    """The bundle of a validation or test day: everything the notebook draws and re-scores, from the day's Binance trades and the Polymarket
    ladders of its windows (read by the hour through `hours`). The whole configuration grid runs once at the 250 ms latency."""
    t0 = time.time()
    cfgs = cfgs or R.configs()
    assets, metas, dfs = build_assets(day, trades, return_df=True)
    rows = sorted(rows, key=lambda r: (ASSETS.index(r["asset"]), r["start_ms"]))
    W = len(rows)
    widx = {r["slug"]: i for i, r in enumerate(rows)}
    w = dict(w_asset=np.array([ASSETS.index(r["asset"]) for r in rows], np.int8), w_start=np.array([r["start_ms"] for r in rows], np.int64),
             w_up=np.array([int(bool(r["up_won"])) for r in rows], np.int8), w_a0=np.zeros(W), w_aend=np.zeros(W),
             w_gap_s=np.zeros(W, np.float32), w_nev=np.zeros(W, np.int32), w_nrows=np.zeros(W, np.int32), w_lead_gap=np.full(W, -1, np.int32),
             w_snaps=np.zeros(W, np.int32), w_status=np.full(W, 1, np.int8), w_fee=np.array([r["fee_rate"] for r in rows], np.float32),
             w_exp=np.array([r["fee_exponent"] for r in rows], np.float32), w_min=np.array([r.get("min_size", 5) for r in rows], np.float32))
    w["w_proc"] = np.zeros(W, np.int8)                 # 1 once the window was read from the ladders (a part-day run leaves the rest 0)
    ev = [None] * W
    smp = dict(s_z=np.full((W, NS), np.nan, np.float32), s_zl=np.full((W, NS, 3), np.nan, np.float32), s_pu=np.full((W, NS), np.nan, np.float32),
               s_pm=np.full((W, NS, len(MAP_COLS)), np.nan, np.float32), s_mid=np.full((W, NS), np.nan, np.float32), s_S=np.full((W, NS), np.nan, np.float32))
    bgrid = dict(b_bid=np.full((W, NB), NA, np.uint16), b_ask=np.full((W, NB), NA, np.uint16), b_bsz=np.full((W, NB), np.nan, np.float16),
                 b_asz=np.full((W, NB), np.nan, np.float16))
    lad = {k: np.full((W, NL, LAD_LEVELS), np.nan, np.float32) for k in ("l_bid_px", "l_bid_sz", "l_ask_px", "l_ask_sz")}
    bn = dict(n_mid=np.full((W, NBN), np.nan, np.float32), n_last=np.full((W, NBN), np.nan, np.float32), n_sv=np.full((W, NBN), np.nan, np.float32))
    c = {k: [] for k in ("c_w", "c_cfg", "c_lat", "c_status", "c_ntrig", "c_gone", "c_empty", "c_side", "c_tsig", "c_ask_sig", "c_ask_best", "c_vwap", "c_shares",
                         "c_cost", "c_fee", "c_partial", "c_levels", "c_p", "c_mid", "c_pg", "c_pn", "c_won", "c_ask250", "c_ask1000", "c_fill",
                         "c_bts", "c_fts", "c_age", "c_f_t", "c_f_sig", "c_f_fill", "c_f_age", "c_f_side")}
    fills, fill_key, audits = [], {}, []
    ll_sums = np.zeros((len(ASSETS), len(LL_LAGS), 6))
    ll_ev = np.zeros((len(ASSETS), EV_STEPS, 2))
    for hour, hrows in sorted(_by_hour(rows).items()):
        if only_hours is not None and hour not in only_hours:
            continue
        for r, st, aud in hours(hour, hrows):
            wi = widx[r["slug"]]
            w["w_proc"][wi] = 1
            A = assets[r["asset"]][kind]
            Al, Am = assets[r["asset"]]["last"], assets[r["asset"]]["mid"]
            a0, ae, _ = A.window_refs(r["start_ms"])
            w["w_a0"][wi], w["w_aend"][wi] = a0, ae
            w["w_gap_s"][wi] = A.gap_s(r["start_ms"], r["end_ms"])
            book = R.Book(st)
            w["w_nrows"][wi] = len(book.ts)
            w["w_lead_gap"][wi] = int(st.get("meta", {}).get("lead_gap_ms", -1))
            w["w_snaps"][wi] = int(st.get("meta", {}).get("snapshots", 0))
            audits.append(dict(slug=r["slug"], **{k: v for k, v in (aud or {}).items() if k in ("bytes", "seconds", "events_in", "mirror_ok", "status")}))
            if len(book.ts) == 0 or book.ts[0] > r["start_ms"] + R.OPEN_S * 1000:
                w["w_status"][wi] = 1
                continue
            if w["w_gap_s"][wi] > GAP_MAX_S:
                w["w_status"][wi] = 2
                continue
            w["w_status"][wi] = 0
            bn["n_mid"][wi], bn["n_last"][wi], bn["n_sv"][wi] = _bn_path(Am, Al, r["start_ms"])
            _s, _e = lead_lag_sums(A, book, r["start_ms"])
            ll_sums[w["w_asset"][wi]] += _s
            ll_ev[w["w_asset"][wi]] += _e
            bb, ba, bsz, asz = _book_grid(book, r["start_ms"])
            bgrid["b_bid"][wi], bgrid["b_ask"][wi] = _q(bb), _q(ba)
            bgrid["b_bsz"][wi], bgrid["b_asz"][wi] = np.minimum(bsz, 6e4).astype(np.float16), np.minimum(asz, 6e4).astype(np.float16)
            lp = _ladder5(book, r["start_ms"])
            for key, arr in zip(("l_bid_px", "l_bid_sz", "l_ask_px", "l_ask_sz"), lp):
                lad[key][wi] = arr
            # scoring instants
            ts_ = R.sample_instants(r["start_ms"], r["end_ms"])
            fs = R.features(A, ts_, r["start_ms"], r["end_ms"], a0)
            Ps = maps.predict(fs)
            smp["s_z"][wi] = fs["z"]
            smp["s_zl"][wi] = np.column_stack([fs[f"zl{L}"] for L in R.LB])
            smp["s_pu"][wi] = R.p_up_brownian(fs)
            smp["s_pm"][wi] = _maps_stack(Ps)
            smp["s_mid"][wi] = book.mid(book.at(ts_))
            smp["s_S"][wi] = fs["S"]
            # decision events
            t = A.events(r["start_ms"], r["end_ms"])
            w["w_nev"][wi] = len(t)
            if not len(t):
                continue
            f = R.features(A, t, r["start_ms"], r["end_ms"], a0)
            P = maps.predict(f)
            arrays, pu = R.config_arrays(f, P, cfgs)
            i_t = book.at(t)
            ev[wi] = dict(t=(t - r["start_ms"]).astype(np.int32), S=f["S"].astype(np.float32), z=f["z"].astype(np.float32),
                          zl=np.column_stack([f[f"zl{L}"] for L in R.LB]).astype(np.float32), pu=_p16(pu), pm=_p16(_maps_stack(P)),
                          au=_q(book.up_ask(i_t)), ad=_q(book.dn_ask(i_t)))
            sims = R.simulate_window(t, cfgs, arrays, book, r, bool(r["up_won"]), lats=lats)
            for s in sims:
                e = s["entry"]
                c["c_w"].append(wi); c["c_cfg"].append(s["cfg"]); c["c_lat"].append(s["lat"]); c["c_status"].append(CODE_OF[s["status"]])
                c["c_ntrig"].append(s["n_trig"]); c["c_gone"].append(s["n_gone"]); c["c_empty"].append(s["n_empty"])
                f_ = s.get("first")
                c["c_f_t"].append(f_["t_ms"] - r["start_ms"] if f_ else -1)
                c["c_f_sig"].append(f_["ask_signal"] if f_ else np.nan)
                c["c_f_fill"].append(f_["ask_at_fill"] if f_ else np.nan)
                c["c_f_age"].append(f_["book_age_ms"] if f_ else -1)
                c["c_f_side"].append(f_["side"] if f_ else 0)
                if e is None:
                    for k in ("c_side", "c_tsig", "c_levels", "c_partial", "c_won", "c_fill", "c_bts", "c_fts", "c_age"):
                        c[k].append(-1)
                    for k in ("c_ask_sig", "c_ask_best", "c_vwap", "c_shares", "c_cost", "c_fee", "c_p", "c_mid", "c_pg", "c_pn", "c_ask250", "c_ask1000"):
                        c[k].append(np.nan)
                    continue
                c["c_side"].append(e["side"]); c["c_tsig"].append(e["t_signal_ms"] - r["start_ms"]); c["c_levels"].append(e["levels"])
                c["c_partial"].append(int(e["partial"])); c["c_won"].append(int(e["won"]))
                c["c_bts"].append(e["book_ts_signal"] - r["start_ms"]); c["c_fts"].append(e["book_ts_fill"] - r["start_ms"]); c["c_age"].append(e["book_age_ms"])
                for k, key in (("c_ask_sig", "ask_signal"), ("c_ask_best", "ask_best_fill"), ("c_vwap", "vwap"), ("c_shares", "shares"),
                               ("c_cost", "cost"), ("c_fee", "fee_usd"), ("c_p", "p_model"), ("c_mid", "mid_up"), ("c_pg", "pnl_gross"),
                               ("c_pn", "pnl_net"), ("c_ask250", "ask_250ms"), ("c_ask1000", "ask_1000ms")):
                    c[k].append(e[key])
                key = (wi, e["t_signal_ms"], e["side"], s["lat"])
                if key not in fill_key:
                    fi = int(book.at(np.array([e["t_fill_ms"]]))[0])
                    si = int(book.at(np.array([e["t_signal_ms"]]))[0])
                    fill_key[key] = len(fills)
                    fills.append((book.ladder(fi, e["side"]), book.ladder(max(si, 0), e["side"])))
                c["c_fill"].append(fill_key[key])
        if progress:
            progress(hour)
    out = dict(w)
    out.update(smp); out.update(bgrid); out.update(lad); out.update(bn)
    out["ll_sums"], out["ll_ev"] = ll_sums, ll_ev
    off = np.zeros(W + 1, np.int64)
    for i in range(W):
        off[i + 1] = off[i] + (0 if ev[i] is None else len(ev[i]["t"]))
    out["e_off"] = off
    shapes = dict(t=(0,), S=(0,), z=(0,), zl=(0, 3), pu=(0,), pm=(0, len(MAP_COLS)), au=(0,), ad=(0,))
    dts = dict(t=np.int32, S=np.float32, z=np.float32, zl=np.float32, pu=np.uint16, pm=np.uint16, au=np.uint16, ad=np.uint16)
    for k in ("t", "S", "z", "zl", "pu", "pm", "au", "ad"):
        parts = [e[k] for e in ev if e is not None]
        out[f"e_{k}"] = np.concatenate(parts) if parts else np.zeros(shapes[k], dts[k])
    dt = {"c_w": np.int32, "c_cfg": np.int16, "c_lat": np.int16, "c_status": np.int8, "c_ntrig": np.int32, "c_gone": np.int16, "c_empty": np.int16, "c_side": np.int8,
          "c_tsig": np.int32, "c_levels": np.int8, "c_partial": np.int8, "c_won": np.int8, "c_fill": np.int32, "c_bts": np.int32, "c_fts": np.int32,
          "c_age": np.int32, "c_f_t": np.int32, "c_f_age": np.int32, "c_f_side": np.int8}
    for k, v in c.items():
        out[k] = np.array(v, dtype=dt.get(k, np.float32))
    if fills:
        out["f_px"] = np.array([f[0][0][:10] for f in fills], np.float32); out["f_sz"] = np.array([f[0][1][:10] for f in fills], np.float32)
        out["f_spx"] = np.array([f[1][0][:10] for f in fills], np.float32); out["f_ssz"] = np.array([f[1][1][:10] for f in fills], np.float32)
    else:
        for k in ("f_px", "f_sz", "f_spx", "f_ssz"):
            out[k] = np.zeros((0, 10), np.float32)
    audit = dict(windows=W, ok=int((w["w_status"] == 0).sum()), no_book=int((w["w_status"] == 1).sum()), binance_gap=int((w["w_status"] == 2).sum()),
                 seconds=round(time.time() - t0, 1), config_rows=int(len(c["c_w"])), fills=len(fills), per_window=audits)
    audit["causality"] = causality_probe(dfs, assets, rows)
    if index_1m is not None:
        audit["proxy_error"] = {a: proxy_error(assets[a]["last"], assets[a]["mid"], index_1m(SYMBOL[a], day)) for a in ASSETS}
    audit["binance_files"] = {a: [m for m in metas[a]] for a in ASSETS}
    meta = dict(day=day, role="book", kind=kind, cfgs=[{k: (None if v is None else v) for k, v in cf.items()} for cf in cfgs], lats=list(lats), map_cols=list(MAP_COLS),
                audit=audit, schema=2)
    return pack(out, meta), audit


def lead_lag_curve(days: list):
    """Pooled over the days: per asset the correlation at each lag (ms) and the mean signed mid response (price units) after large Binance moves."""
    S = sum(a["ll_sums"] for a, _ in days)
    E = sum(a["ll_ev"] for a, _ in days)
    out = {}
    for ai, a in enumerate(ASSETS):
        n, sa, sb, sab, saa, sbb = (S[ai, :, k] for k in range(6))
        with np.errstate(invalid="ignore", divide="ignore"):
            cov = sab / n - (sa / n) * (sb / n)
            corr = cov / np.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2))
            resp = E[ai, :, 0] / E[ai, :, 1]
        out[a] = dict(lag_ms=LL_LAGS * LL_BIN, corr=corr, n=n, step_ms=np.arange(EV_STEPS) * LL_BIN, resp=resp, n_events=E[ai, :, 1])
    return out


# =============================================================== reading derived days
def entries_frame(days: list, cfg: str | int, lat: int = R.LATENCY_MS):
    """One row per window for a configuration (its name or id), over unpacked days [(arrays, meta)]: the study's `entries` and `windows` frames."""
    import pandas as pd
    parts = []
    for arrs, meta in days:
        names = [c["name"] for c in meta["cfgs"]]
        ci = cfg if isinstance(cfg, int) else names.index(cfg)
        m = (arrs["c_cfg"] == ci) & (arrs["c_lat"] == lat)
        w = arrs["c_w"][m]
        df = pd.DataFrame(dict(day=meta["day"], widx=w, asset=[ASSETS[i] for i in arrs["w_asset"][w]], win_start_ms=arrs["w_start"][w],
                               outcome_up=arrs["w_up"][w].astype(bool), wstatus=[STATUS[i] for i in arrs["w_status"][w]],
                               status=[CSTATUS[i] for i in arrs["c_status"][m]], n_trig=arrs["c_ntrig"][m], n_gone=arrs["c_gone"][m],
                               n_empty=arrs["c_empty"][m], side=arrs["c_side"][m], t_signal_off_ms=arrs["c_tsig"][m],
                               ask_signal=arrs["c_ask_sig"][m], ask_best=arrs["c_ask_best"][m], vwap=arrs["c_vwap"][m], shares=arrs["c_shares"][m],
                               cost=arrs["c_cost"][m], fee_usd=arrs["c_fee"][m], partial=arrs["c_partial"][m].astype(bool), levels=arrs["c_levels"][m],
                               p_model=arrs["c_p"][m], mid_up=arrs["c_mid"][m], pnl_gross=arrs["c_pg"][m], pnl_net=arrs["c_pn"][m],
                               won=arrs["c_won"][m].astype(bool), ask_250ms=arrs["c_ask250"][m], ask_1000ms=arrs["c_ask1000"][m], fill=arrs["c_fill"][m],
                               book_ts_signal_off=arrs["c_bts"][m], book_ts_fill_off=arrs["c_fts"][m], book_age_ms=arrs["c_age"][m], first_t_off_ms=arrs["c_f_t"][m],
                               first_ask_signal=arrs["c_f_sig"][m], first_ask_at_fill=arrs["c_f_fill"][m], first_book_age_ms=arrs["c_f_age"][m], first_side=arrs["c_f_side"][m]))
        parts.append(df)
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()


# =============================================================== the planted-test pass (validation days only)
VARIANTS = (
    dict(name="base"),
    dict(name="leak", leak=True),
    dict(name="features_stale_1s", shift_ms=1000),
    dict(name="features_future_1s", shift_ms=-1000),
    dict(name="features_stale_5s", shift_ms=5000),
    dict(name="features_stale_15s", shift_ms=15000),
    dict(name="features_future_5s", shift_ms=-5000),
    dict(name="features_future_15s", shift_ms=-15000),
    dict(name="features_future_60s", shift_ms=-60000),
    dict(name="decision_later_250ms", lat_extra_ms=250),
    dict(name="decision_later_1s", lat_extra_ms=1000),
    dict(name="latency_0ms", lat=0),
    dict(name="latency_50ms", lat=50),
    dict(name="latency_150ms", lat=150),
    dict(name="latency_400ms", lat=400),
    dict(name="latency_1000ms", lat=1000),
    dict(name="cadence_5s", cadence_ms=5000),
    dict(name="cadence_1s", cadence_ms=1000),
    dict(name="cadence_250ms", cadence_ms=250),
)


def derive_verify_day(day: str, rows: list[dict], trades, hours, maps: R.Maps, cfg_name: str, variants=VARIANTS, kind: str = "mid",
                      progress=None) -> tuple[bytes, dict]:
    """Re-run ONE configuration over the day's windows once per variant, from the same ladders, and keep one row per (variant, window). A variant changes a
    clock or the information, never the book: `shift_ms` moves the Binance rows the features read (+ stale, - from the future), `lat_extra_ms` moves the
    decision clock later, `lat` is the signal-to-book latency, `leak` shows the model the window-end reference."""
    t0 = time.time()
    cfgs = [c for c in R.configs() if c["name"] == cfg_name]
    assert len(cfgs) == 1, f"unknown configuration {cfg_name}"
    assets, _ = build_assets(day, trades)
    rows = sorted(rows, key=lambda r: (ASSETS.index(r["asset"]), r["start_ms"]))
    widx = {r["slug"]: i for i, r in enumerate(rows)}
    c = {k: [] for k in ("v_var", "v_w", "v_status", "v_side", "v_vwap", "v_shares", "v_fee", "v_pg", "v_pn", "v_won", "v_tsig", "v_ntrig", "v_p", "v_cost")}
    n_win = 0
    for hour, hrows in sorted(_by_hour(rows).items()):
        for r, st, aud in hours(hour, hrows):
            wi = widx[r["slug"]]
            A = assets[r["asset"]][kind]
            a0, ae, _k = A.window_refs(r["start_ms"])
            book = R.Book(st)
            if len(book.ts) == 0 or book.ts[0] > r["start_ms"] + R.OPEN_S * 1000 or A.gap_s(r["start_ms"], r["end_ms"]) > GAP_MAX_S:
                continue
            n_win += 1
            t = A.events(r["start_ms"], r["end_ms"])
            if not len(t):
                continue
            for vi, v in enumerate(variants):
                cad = v.get("cadence_ms")
                tv = t if not cad else (r["start_ms"] + R.OPEN_S * 1000 + cad * np.arange((r["end_ms"] - R.GUARD_S * 1000 - r["start_ms"] - R.OPEN_S * 1000) // cad + 1, dtype=np.int64))
                f = R.features(A, tv, r["start_ms"], r["end_ms"], a0, shift_ms=v.get("shift_ms", 0), leak_a_end=ae if v.get("leak") else None)
                arrays, _pu = R.config_arrays(f, maps.predict(f), cfgs, leak=bool(v.get("leak")))
                s = R.simulate_window(tv, cfgs, arrays, book, r, bool(r["up_won"]), lats=(v.get("lat", R.LATENCY_MS),), lat_extra_ms=v.get("lat_extra_ms", 0))[0]
                e = s["entry"]
                c["v_var"].append(vi); c["v_w"].append(wi); c["v_status"].append(CODE_OF[s["status"]]); c["v_ntrig"].append(s["n_trig"])
                if e is None:
                    c["v_side"].append(0); c["v_tsig"].append(-1); c["v_won"].append(-1)
                    for k in ("v_vwap", "v_shares", "v_fee", "v_pg", "v_pn", "v_p", "v_cost"):
                        c[k].append(np.nan)
                else:
                    c["v_side"].append(e["side"]); c["v_tsig"].append(e["t_signal_ms"] - r["start_ms"]); c["v_won"].append(int(e["won"]))
                    for k, key in (("v_vwap", "vwap"), ("v_shares", "shares"), ("v_fee", "fee_usd"), ("v_pg", "pnl_gross"), ("v_pn", "pnl_net"), ("v_p", "p_model"), ("v_cost", "cost")):
                        c[k].append(e[key])
        if progress:
            progress(hour)
    dt = {"v_var": np.int8, "v_w": np.int32, "v_status": np.int8, "v_side": np.int8, "v_won": np.int8, "v_tsig": np.int32, "v_ntrig": np.int32}
    out = {k: np.array(v, dtype=dt.get(k, np.float32)) for k, v in c.items()}
    out["w_asset"] = np.array([ASSETS.index(r["asset"]) for r in rows], np.int8)
    out["w_start"] = np.array([r["start_ms"] for r in rows], np.int64)
    out["w_up"] = np.array([int(bool(r["up_won"])) for r in rows], np.int8)
    audit = dict(windows_used=n_win, seconds=round(time.time() - t0, 1), rows=int(len(c["v_var"])))
    meta = dict(day=day, role="verify", kind=kind, cfg=cfg_name, variants=[v["name"] for v in variants], audit=audit, schema=2)
    return pack(out, meta), audit


def verify_entries(days: list, variant: str):
    """Entries frame of one planted variant over unpacked verify days, in the shape `updown15_verify` reads (asset, win_start_ms, side, shares, vwap, fee_usd,
    pnl_gross, pnl_net, won, cost)."""
    import pandas as pd
    parts = []
    for arrs, meta in days:
        vi = meta["variants"].index(variant)
        m = (arrs["v_var"] == vi) & (arrs["v_status"] == CODE_OF["entered"])
        w = arrs["v_w"][m]
        parts.append(pd.DataFrame(dict(day=meta["day"], asset=[ASSETS[i] for i in arrs["w_asset"][w]], win_start_ms=arrs["w_start"][w],
                                       side=arrs["v_side"][m], shares=arrs["v_shares"][m], vwap=arrs["v_vwap"][m], fee_usd=arrs["v_fee"][m],
                                       pnl_gross=arrs["v_pg"][m], pnl_net=arrs["v_pn"][m], won=arrs["v_won"][m].astype(bool), cost=arrs["v_cost"][m])))
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()


def merge_book_days(blobs: list[bytes]) -> bytes:
    """Merge part-day bundles of ONE day (each built with `only_hours`, so each window was read by exactly one part) into the whole day."""
    parts = [unpack(b) for b in blobs]
    base_a, base_m = parts[0]
    W = len(base_a["w_start"])
    for a, m in parts:
        assert m["day"] == base_m["day"] and len(a["w_start"]) == W and np.array_equal(a["w_start"], base_a["w_start"]), "parts of different days"
    proc = np.stack([a["w_proc"] for a, _ in parts])
    assert proc.sum(0).max() <= 1, "a window was read by two parts"
    out = {}
    per_w = [k for k in base_a if k.startswith(("w_", "s_", "b_", "l_", "n_")) and k != "w_proc"]
    for k in per_w:
        arr = base_a[k].copy()
        for pi, (a, _) in enumerate(parts):
            sel = a["w_proc"] == 1
            arr[sel] = a[k][sel]
        out[k] = arr
    out["w_proc"] = proc.max(0).astype(np.int8)
    out["ll_sums"] = sum(a["ll_sums"] for a, _ in parts)
    out["ll_ev"] = sum(a["ll_ev"] for a, _ in parts)
    # events: windows in global order, each from the part that holds it
    owner = np.full(W, -1, int)
    for pi, (a, _) in enumerate(parts):
        owner[a["w_proc"] == 1] = pi
    ev_keys = ("t", "S", "z", "zl", "pu", "pm", "au", "ad")
    pieces = {k: [] for k in ev_keys}
    off = np.zeros(W + 1, np.int64)
    for wi in range(W):
        n = 0
        if owner[wi] >= 0:
            a = parts[owner[wi]][0]
            lo, hi = int(a["e_off"][wi]), int(a["e_off"][wi + 1])
            n = hi - lo
            for k in ev_keys:
                pieces[k].append(a[f"e_{k}"][lo:hi])
        off[wi + 1] = off[wi] + n
    out["e_off"] = off
    for k in ev_keys:
        out[f"e_{k}"] = np.concatenate(pieces[k]) if pieces[k] else base_a[f"e_{k}"][:0]
    # config rows and fills: concatenate, shifting the fill index by the fills before it
    fill_off = 0
    cs = {k: [] for k in base_a if k.startswith("c_")}
    fs_ = {k: [] for k in ("f_px", "f_sz", "f_spx", "f_ssz")}
    for a, _ in parts:
        fi = a["c_fill"].copy()
        fi[fi >= 0] += fill_off
        for k in cs:
            cs[k].append(fi if k == "c_fill" else a[k])
        for k in fs_:
            fs_[k].append(a[k])
        fill_off += len(a["f_px"])
    for k, v in cs.items():
        out[k] = np.concatenate(v)
    for k, v in fs_.items():
        out[k] = np.concatenate(v)
    audit = dict(base_m["audit"])
    audit.update(windows=W, ok=int((out["w_status"] == 0).sum()), no_book=int(((out["w_status"] == 1) & (out["w_proc"] == 1)).sum()),
                 binance_gap=int((out["w_status"] == 2).sum()), not_read=int((out["w_proc"] == 0).sum()), config_rows=int(len(out["c_w"])),
                 fills=int(len(out["f_px"])), seconds=round(sum(m["audit"]["seconds"] for _, m in parts), 1), per_window=sum((m["audit"]["per_window"] for _, m in parts), []),
                 parts=len(parts))
    meta = dict(base_m)
    meta["audit"] = audit
    return pack(out, meta)


def verify_counts(days: list, variant: str) -> dict:
    """Over unpacked verify days, one variant: windows with a trigger that cleared theta, entries, windows where every order found the ask gone, windows with too little depth."""
    tot = dict(windows=0, triggered=0, entered=0, ask_gone=0, no_depth=0)
    for arrs, meta in days:
        vi = meta["variants"].index(variant)
        m = arrs["v_var"] == vi
        st = arrs["v_status"][m]
        tot["windows"] += int(m.sum())
        tot["triggered"] += int((arrs["v_ntrig"][m] > 0).sum())
        tot["entered"] += int((st == CODE_OF["entered"]).sum())
        tot["ask_gone"] += int((st == CODE_OF["ask_gone"]).sum())
        tot["no_depth"] += int((st == CODE_OF["no_depth"]).sum())
    return tot
