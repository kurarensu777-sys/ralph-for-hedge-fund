"""The diagnosis of the directional momentum study (B-0662): why does the chosen pair of um-009 lose, and is there an edge anywhere inside it. numpy, pandas and scipy only; a notebook
calls these and draws what they return. Nothing here chooses a cell: the pair is the one um-009 froze, every table is a read of ITS entries (or of the same cell family on the same days).

    entry_frame      one row per entry: who, when, at what price, the fair value and the book around the decision, what Binance and the book did next, the outcome and the net
    add_buckets      the labels every slice uses (coin, UTC block, volatility tercile, time into the window, with or against the leader), fixed here and not tuned
    waterfall        the net split by share into: the fair value's surprise, the model against the book, the book's move in the 250 ms, spread and depth, the fee
    slice_table      entries cut by a label: n, win, price, net per entry with a cluster interval, share of the loss
    calibration      the actual win share against the price paid plus the fee, by a label
    clustering       are the losses bunched: a cluster-robust Wald test per label, the slot-sum variance and the worst-slots share against a day-preserving shuffle
    arms             the same firing seconds with the momentum side, the leader's side and a fair coin
    forward          what Binance and the book do after the entry, in the entry's direction
    structural_scan  both tokens bought at the first filled second of each time-left band, no signal: how the book prices a token against how often it pays
    near_certain     the um-006 family (buy the near-certain token when the fair value clears its ask) on any table
    hunt             every slice and every signal cell scored once, raw / Holm / max-t (slot bootstrap) p-values, and the discovery-to-hold-out check

THE UNIT OF ERROR is a 15-minute slot (the four coins that start together move together): every standard error and every interval clusters on it.
THE IDENTITY. For an entry, net = shares x (won - (cost + fee) / shares), so the actual win share against the price-plus-fee share IS the net per share; `waterfall` splits that gap and asserts the sum.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import chi2, norm

import mom15_bt as M
import tf15_bt as B

COINS = ("btc", "eth", "sol", "xrp")
TOD_EDGES = (0, 6, 12, 18, 24)
TOD_LABELS = ("00-06 UTC", "06-12 UTC", "12-18 UTC", "18-24 UTC")
TIMING_EDGES = (10, 20, 40, 90, 841)
TIMING_LABELS = ("10-20 s in", "20-40 s in", "40-90 s in", "90 s+ in")
PRICE_EDGES = (0.0, 0.30, 0.45, 0.55, 0.70, 0.85, 0.97)
VOL_LABELS = ("low vol", "mid vol", "high vol")
DIMS = ("coin", "tod", "vol", "timing", "lead")
HORIZONS = (1, 5, 30)


# ============================================================ the per-entry frame
def vol_cuts(tab, col: int = 300):
    """-> (coin medians, the 1/3 and 2/3 cut of sigma over the coin's median) read from ALL windows of the table at one fixed second, never from the entries."""
    sg = tab.sig[:, col].astype(float)
    med = np.array([np.nanmedian(sg[tab.w_asset == a]) for a in range(4)])
    rel = sg / med[tab.w_asset]
    return med, tuple(float(x) for x in np.nanquantile(rel, [1 / 3, 2 / 3]))


def _side_mid(lad_bid0, lad_ask0):
    return (lad_bid0 + lad_ask0) / 2.0


def entry_frame(tab, e, sig, roles: dict, cuts):
    """-> DataFrame, one row per entry of `e` (a `mom15_bt.settle` result on `tab` for the signal `sig`). `roles` maps a day to its role; `cuts` is `vol_cuts(tab)`.
    The decision-time quantities (pu, qb, qa, sigma, z) are as of second k; the ladder fields are the table's fill ladder (k + 250 ms)."""
    w, k, s = e["w"], e["k"], e["side"]
    n = len(w)
    if n == 0:
        return pd.DataFrame()
    pu = tab.pu[w, k].astype(float)
    pus = np.where(s > 0, pu, 1.0 - pu)
    bid, _ = B.ladder_of(tab, w, k, s, buy=False)
    ask, _ = B.ladder_of(tab, w, k, s, buy=True)
    mid_fill = (bid[:, 0] + ask[:, 0]) / 2.0
    mid_fill = np.where(np.isfinite(mid_fill), mid_fill, ask[:, 0])                 # a one-sided book (no bid): the mid is the ask, the half spread is nil
    up_mid = (tab.qb[w, k].astype(float) + tab.qa[w, k].astype(float)) / 2.0
    mid_dec = np.where(s > 0, up_mid, 1.0 - up_mid)
    mid_dec = np.where(np.isfinite(mid_dec), mid_dec, mid_fill)
    kp = np.maximum(k - sig.L, 0)
    up_mid_p = (tab.qb[w, kp].astype(float) + tab.qa[w, kp].astype(float)) / 2.0
    d_book = s * (up_mid - up_mid_p)                                         # the token's mid move over the signal's lookback, our way
    d_fair = s * (pu - tab.pu[w, kp].astype(float))                          # the model's fair value move over the same lookback, our way
    q = (e["cost"] + e["fee"]) / e["shares"]
    df = pd.DataFrame(dict(w=w, k=k, date=[tab.days[i] for i in e["day"]], coin=[COINS[a] for a in e["asset"]], slot=e["slot"], side=s, shares=e["shares"], cost=e["cost"], fee=e["fee"],
                           vwap=e["vwap"], q=q, won=e["won"].astype(float), net=e["net"], gross=e["gross"], pu_side=pus, mid_dec=mid_dec, mid_fill=mid_fill, best_ask=ask[:, 0],
                           sigma=tab.sig[w, k].astype(float), z_entry=np.abs(tab.zlook(sig.L)[w, k]), d_book=d_book, d_fair=d_fair, entry_s=k + M.K0))
    df["role"] = df["date"].map(roles)
    df["day"] = e["day"]
    ts = tab.w_start[w].astype(np.int64) + (df["entry_s"].to_numpy() * 1000)
    df["hour"] = (ts // 3_600_000) % 24
    df["lead"] = np.where((s > 0) == (pu > 0.5), "with the leader", "against the leader")
    med, (c1, c2) = cuts
    rel = df["sigma"].to_numpy() / med[e["asset"]]
    df["vol_rel"] = rel
    df["vol"] = np.where(rel < c1, VOL_LABELS[0], np.where(rel < c2, VOL_LABELS[1], VOL_LABELS[2]))
    df["tod"] = pd.cut(df["hour"], list(TOD_EDGES), right=False, labels=list(TOD_LABELS)).astype(str)
    df["timing"] = pd.cut(df["entry_s"], list(TIMING_EDGES), right=False, labels=list(TIMING_LABELS)).astype(str)
    df["band"] = pd.cut(df["vwap"], list(PRICE_EDGES)).astype(str)
    S = tab.Sg[:, M.PRE:M.PRE + tab.NK]
    ls = np.log(S[w, k])
    for h in HORIZONS:
        kh = np.minimum(k + h, tab.NK - 1)
        df[f"bn{h}"] = s * (np.log(S[w, kh]) - ls) * 1e4                      # Binance, our way, in bp
        bh, _ = B.ladder_of(tab, w, kh, s, buy=False)
        ah, _ = B.ladder_of(tab, w, kh, s, buy=True)
        df[f"bk{h}"] = ((bh[:, 0] + ah[:, 0]) / 2.0 - mid_fill) * 100          # the token's mid, our way, in cents
    df["edge"] = (df["won"] - df["mid_dec"]) * df["shares"]                  # the edge before friction: the outcome against the book's mid at the decision
    return df


def waterfall(df):
    """The net per entry as five terms in USD (each term x shares, mean over entries): A the fair value's surprise (won - fair), B the model against the book (fair - mid at the decision),
    C the book's move in the 250 ms (mid at decision - mid at the fill), D spread and depth (mid at the fill - volume-weighted price), E the fee. -> DataFrame term, usd, lo, hi (cluster 95%)."""
    sh = df["shares"].to_numpy()
    terms = {"A": df["won"] - df["pu_side"], "B": df["pu_side"] - df["mid_dec"], "C": df["mid_dec"] - df["mid_fill"], "D": df["mid_fill"] - df["vwap"], "E": -df["fee"] / df["shares"]}
    tot = sum(terms.values()) * sh
    assert np.allclose(tot, df["net"].to_numpy(), atol=1e-4), "the waterfall terms do not add to the net"
    names = {"A": "fair value's surprise (won - model)", "B": "model against the book at the decision", "C": "book moves in the 250 ms", "D": "half spread and depth walked", "E": "taker fee (entry only: the pair holds to expiry)"}
    rows = []
    for key, v in terms.items():
        x = pd.Series(v.to_numpy() * sh, index=df.index)
        m, se = cl_mean(x.to_numpy(), df["slot"].to_numpy())
        rows.append(dict(term=key, what=names[key], usd=m, lo=m - 1.96 * se, hi=m + 1.96 * se))
    m, se = cl_mean(df["net"].to_numpy(), df["slot"].to_numpy())
    rows.append(dict(term="net", what="net per entry", usd=m, lo=m - 1.96 * se, hi=m + 1.96 * se))
    out = pd.DataFrame(rows)
    assert abs(out.loc[out.term != "net", "usd"].sum() - out.loc[out.term == "net", "usd"].iloc[0]) < 1e-4
    return out


# ============================================================ statistics
def cl_mean(x, slot):
    """-> (mean, cluster-robust standard error of the mean) with 15-minute slots as clusters."""
    x = np.asarray(x, float)
    n = len(x)
    if n == 0:
        return float("nan"), float("nan")
    m = x.mean()
    u, inv = np.unique(slot, return_inverse=True)
    r = np.bincount(inv, weights=x - m, minlength=len(u))
    g = len(u)
    se = np.sqrt((r ** 2).sum() * g / max(g - 1, 1)) / n
    return float(m), float(se)


def _t(x, slot):
    m, se = cl_mean(x, slot)
    return (m / se if se > 0 else float("nan")), m, se


def slice_table(df, by, min_n=1, order=None):
    """Entries cut by the label column `by`. net per entry with a 95% interval by cluster, the cluster t against zero, the share of entries and of the loss (the sum of negative nets)."""
    tot_loss = float(df.loc[df["net"] < 0, "net"].sum()) or float("nan")
    levels = order or sorted(df[by].unique())
    rows = []
    for lv in levels:
        g = df[df[by] == lv]
        if len(g) < 1:
            continue
        t, m, se = _t(g["net"].to_numpy(), g["slot"].to_numpy())
        rows.append({by: lv, "entries": len(g), "share of entries": len(g) / len(df), "win": g["won"].mean(), "price": g["vwap"].mean(), "price + fee": g["q"].mean(), "fee": g["fee"].mean(),
                     "gross per entry": g["gross"].mean(), "net per entry": m, "lo": m - 1.96 * se, "hi": m + 1.96 * se, "t": t, "net total": g["net"].sum(),
                     "share of the loss": float(g.loc[g["net"] < 0, "net"].sum() / tot_loss)})
    out = pd.DataFrame(rows)
    return out[out["entries"] >= min_n].reset_index(drop=True)


def calibration(df, by, order=None, min_n=1):
    """Actual win share against the share the price asks, by label: win, price, price + fee, and the gap in percentage points with its cluster 95% interval."""
    levels = order or sorted(df[by].unique())
    rows = []
    for lv in levels:
        g = df[df[by] == lv]
        if len(g) < min_n or len(g) == 0:
            continue
        gap_p, se_p = cl_mean((g["won"] - g["vwap"]).to_numpy(), g["slot"].to_numpy())
        gap_q, se_q = cl_mean((g["won"] - g["q"]).to_numpy(), g["slot"].to_numpy())
        lo, hi = B.wilson(int(g["won"].sum()), len(g))
        rows.append({by: lv, "entries": len(g), "win": g["won"].mean(), "win lo": lo, "win hi": hi, "price": g["vwap"].mean(), "price + fee": g["q"].mean(),
                     "win - price (pp)": gap_p * 100, "pp lo": (gap_p - 1.96 * se_p) * 100, "pp hi": (gap_p + 1.96 * se_p) * 100,
                     "win - price - fee (pp)": gap_q * 100, "fee pp lo": (gap_q - 1.96 * se_q) * 100, "fee pp hi": (gap_q + 1.96 * se_q) * 100, "net per entry": g["net"].mean()})
    return pd.DataFrame(rows)


def wald_equal_means(df, by, col: str = "net"):
    """Cluster-robust Wald test that `col` (net per entry, or the edge before friction) is the same at every level of `by`. -> (chi2, dof, p). Levels with fewer than 5 entries are dropped."""
    g = df[df[by].map(df[by].value_counts()) >= 5]
    lv = sorted(g[by].unique())
    if len(lv) < 2:
        return float("nan"), 0, float("nan")
    X = np.column_stack([(g[by] == v).to_numpy(float) for v in lv])
    y = g[col].to_numpy(float)
    XtX_inv = np.linalg.inv(X.T @ X)
    beta = XtX_inv @ X.T @ y
    u = y - X @ beta
    u_, inv = np.unique(g["slot"].to_numpy(), return_inverse=True)
    meat = np.zeros((X.shape[1], X.shape[1]))
    for c in range(len(u_)):
        sc = (X[inv == c] * u[inv == c][:, None]).sum(0)
        meat += np.outer(sc, sc)
    G = len(u_)
    V = XtX_inv @ meat @ XtX_inv * (G / (G - 1))
    R = np.zeros((len(lv) - 1, len(lv)))
    for i in range(len(lv) - 1):
        R[i, i], R[i, i + 1] = 1.0, -1.0
    d = R @ beta
    W = float(d @ np.linalg.solve(R @ V @ R.T, d))
    return W, len(lv) - 1, float(chi2.sf(W, len(lv) - 1))


def clustering(df, n_perm: int = 4000, seed: int = 7):
    """-> dict. wald: {label: (chi2, dof, p)}; slot_var: the variance of the slot net sums against a shuffle of the nets WITHIN each day (p = share of shuffles at least as spread);
    worst: the share of the total loss in the worst tenth of slots against the same shuffle; day: the spread of the day means against a shuffle of nets across days."""
    out = {"wald": {d: wald_equal_means(df, d) for d in DIMS}, "wald_edge": {d: wald_equal_means(df, d, "edge") for d in DIMS}}
    rng = np.random.default_rng(seed)
    net = df["net"].to_numpy(float)
    u, inv = np.unique(df["slot"].to_numpy(), return_inverse=True)
    day_u, day_inv = np.unique(df["day"].to_numpy(), return_inverse=True)
    nslot = len(u)
    kw = max(1, nslot // 10)

    def stats(v):
        ss = np.bincount(inv, weights=v, minlength=nslot)
        worst = np.sort(ss)[:kw].sum() / v[v < 0].sum() if (v < 0).any() else np.nan
        return float(np.var(ss)), float(worst)

    obs_var, obs_worst = stats(net)
    by_day = [np.flatnonzero(day_inv == d) for d in range(len(day_u))]
    sv, sw = np.zeros(n_perm), np.zeros(n_perm)
    for b in range(n_perm):
        v = net.copy()
        for ix in by_day:
            v[ix] = net[rng.permutation(ix)]
        sv[b], sw[b] = stats(v)
    out["slot_var"] = dict(obs=obs_var, null_mean=float(sv.mean()), p=float((sv >= obs_var).mean()), ratio=obs_var / float(sv.mean()))
    out["worst"] = dict(obs=obs_worst, null_mean=float(np.nanmean(sw)), p=float((sw >= obs_worst).mean()), slots=kw, of=nslot)
    dm = np.array([net[ix].mean() for ix in by_day])
    cnt = np.array([len(ix) for ix in by_day])
    obs_d = float((cnt * (dm - net.mean()) ** 2).sum())
    sd = np.zeros(n_perm)
    for b in range(n_perm):
        v = rng.permutation(net)
        sd[b] = sum(len(ix) * (v[ix].mean() - net.mean()) ** 2 for ix in by_day)
    out["day"] = dict(obs=obs_d, p=float((sd >= obs_d).mean()), days=len(day_u))
    return out


# ============================================================ the three arms at the same firing seconds
def arms(tab, sig, ex, roles, cuts, seeds: int = 20):
    """-> (dict arm -> entry frame, DataFrame of the arm summaries). 'momentum' is the signal's side; 'leader' buys the token the fair value favours (pu > 0.5) at the same seconds;
    'coin' is a fair coin at the same seconds (the mean over `seeds` draws is in the table, the first draw's frame is kept)."""
    side, trig = sig.fire(tab)
    pu = tab.pu.astype(float)
    leader = np.where(pu > 0.5, 1, -1).astype(np.int8) * trig
    frames, rows = {}, []
    runs = {"momentum": [M.settle(tab, side, trig, ex, sig.lu)], "leader": [M.settle(tab, leader, trig, ex, sig.lu)]}
    runs["coin"] = []
    for sd in range(seeds):
        rng = np.random.default_rng(100 + sd)
        cs = np.where(rng.random(trig.shape) < 0.5, 1, -1).astype(np.int8) * trig
        runs["coin"].append(M.settle(tab, cs, trig, ex, sig.lu))
    for name, es in runs.items():
        fr = entry_frame(tab, es[0], sig, roles, cuts)
        if len(es) > 1:                                                          # the mean net of a window over the draws that filled it
            tot, cnt = {}, {}
            for x in es:
                for wi, nv in zip(x["w"], x["net"]):
                    tot[wi] = tot.get(wi, 0.0) + float(nv)
                    cnt[wi] = cnt.get(wi, 0) + 1
            fr["net_avg"] = [tot[wi] / cnt[wi] for wi in fr["w"]]
        else:
            fr["net_avg"] = fr["net"]
        frames[name] = fr
        per = [float(x["net"].mean()) for x in es]
        gross = [float(x["gross"].mean()) for x in es]
        win_m = [float(x["won"].mean()) for x in es]
        wf = waterfall(fr)
        rows.append(dict(arm=name, draws=len(es), entries=int(np.mean([len(x["net"]) for x in es])), win=float(np.mean(win_m)), price=float(np.mean([x["vwap"].mean() for x in es])), gross_per=float(np.mean(gross)),
                         fee_per=float(np.mean([x["fee"].mean() for x in es])), net_per=float(np.mean(per)), net_sd_over_draws=float(np.std(per)) if len(per) > 1 else float("nan"),
                         A=float(wf.loc[wf.term == "A", "usd"].iloc[0])))
    return frames, pd.DataFrame(rows)


def arm_diff(fa, fb, col: str = "net"):
    """The mean of (arm a - arm b) over the windows both entered, with its cluster 95% interval. `col` is `net` or `net_avg` (the coin arm's mean over draws). -> dict n, mean, lo, hi, t."""
    j = fa[["w", "slot", col]].merge(fb[["w", col]], on="w", suffixes=("_a", "_b"))
    x = (j[col + "_a"] - j[col + "_b"]).to_numpy()
    m, se = cl_mean(x, j["slot"].to_numpy())
    return dict(n=len(j), mean=m, lo=m - 1.96 * se, hi=m + 1.96 * se, t=m / se if se > 0 else float("nan"))


def waterfall_by(df, by, order=None, min_n: int = 30):
    """The waterfall of each level of `by` in USD an entry: A and B, the edge before friction (A + B), the 250 ms (C), spread and depth (D), the fee (E), the friction (C + D + E) and the net, with cluster 95% intervals on the edge and the net."""
    rows = []
    for lv in order or sorted(df[by].unique()):
        g = df[df[by] == lv]
        if len(g) < min_n:
            continue
        w = waterfall(g.reset_index(drop=True)).set_index("term")
        sh, sl = g["shares"].to_numpy(), g["slot"].to_numpy()
        ab = ((g["won"] - g["mid_dec"]).to_numpy()) * sh
        m, se = cl_mean(ab, sl)
        rows.append({by: lv, "entries": len(g), "A": w.loc["A", "usd"], "B": w.loc["B", "usd"], "edge": w.loc["A", "usd"] + w.loc["B", "usd"], "edge lo": m - 1.96 * se, "edge hi": m + 1.96 * se,
                     "C": w.loc["C", "usd"], "D": w.loc["D", "usd"], "E": w.loc["E", "usd"], "friction": w.loc[["C", "D", "E"], "usd"].sum(), "net": w.loc["net", "usd"], "net lo": w.loc["net", "lo"], "net hi": w.loc["net", "hi"]})
    return pd.DataFrame(rows)


def slice_pair(test_df, all_df, by, order=None, min_n: int = 1):
    """One row per level: the chosen pair's TEST entries beside the same level over every day read (the test days are inside the second block)."""
    a = slice_table(test_df, by, order=order)[[by, "entries", "win", "price + fee", "net per entry", "lo", "hi", "share of the loss"]]
    a.columns = [by, "test n", "test win", "test price + fee", "test net", "test lo", "test hi", "test loss share"]
    b = slice_table(all_df, by, order=order)[[by, "entries", "win", "price + fee", "net per entry", "lo", "hi", "t"]]
    b.columns = [by, "all n", "all win", "all price + fee", "all net", "all lo", "all hi", "all t"]
    return a.merge(b, on=by, how="outer").query("`all n` >= @min_n").reset_index(drop=True)


def cell_table(frames: dict):
    """One row per signal cell (hold to expiry): entries, win, price + fee, the waterfall in USD an entry, net with its cluster t."""
    rows = []
    for name, fr in frames.items():
        if len(fr) < 30:
            continue
        w = waterfall(fr.reset_index(drop=True)).set_index("term")
        t, m, se = _t(fr["net"].to_numpy(), fr["slot"].to_numpy())
        rows.append(dict(cell=name, entries=len(fr), win=fr["won"].mean(), price_fee=fr["q"].mean(), edge=w.loc["A", "usd"] + w.loc["B", "usd"], friction=w.loc[["C", "D", "E"], "usd"].sum(),
                         net=m, lo=m - 1.96 * se, hi=m + 1.96 * se, t=t))
    return pd.DataFrame(rows)


def arm_terms(frames: dict):
    """The waterfall of each arm of `arms`, one row per arm: A, B, C, D, E, the net and the edge before friction (A + B)."""
    rows = []
    for name, fr in frames.items():
        w = waterfall(fr.reset_index(drop=True)).set_index("term")["usd"]
        rows.append(dict(arm=name, A=w["A"], B=w["B"], edge=w["A"] + w["B"], C=w["C"], D=w["D"], E=w["E"], friction=w["C"] + w["D"] + w["E"], net=w["net"]))
    return pd.DataFrame(rows)


def edge_stats(df):
    """The edge before friction (won - the book's mid at the decision, x shares) and the friction after it, per entry, with cluster 95% intervals and the t of the edge.
    -> dict edge, edge_lo, edge_hi, edge_t, edge_p (one-sided, above zero), friction, net, net_lo, net_hi."""
    sh, sl = df["shares"].to_numpy(), df["slot"].to_numpy()
    e = ((df["won"] - df["mid_dec"]).to_numpy()) * sh
    m, se = cl_mean(e, sl)
    n, sen = cl_mean(df["net"].to_numpy(), sl)
    t = m / se if se > 0 else float("nan")
    return dict(edge=m, edge_lo=m - 1.96 * se, edge_hi=m + 1.96 * se, edge_t=t, edge_p=float(norm.sf(t)), friction=n - m, net=n, net_lo=n - 1.96 * sen, net_hi=n + 1.96 * sen, n=len(df))


def selection_check(res, k: int = 10, min_n: int = 20):
    """Take the k hypotheses that looked best on the discovery days (by t) and read them on the hold-out days. -> (table, dict). The baseline is the mean hold-out result of EVERY hypothesis."""
    ok = res[(res["disc_n"] >= min_n) & (res["hold_n"] >= min_n)].copy()
    top = ok.sort_values("disc_t", ascending=False).head(k)
    info = dict(k=len(top), disc_per=float(top["disc_per"].mean()), hold_per=float(top["hold_per"].mean()), hold_share_pos=float((top["hold_per"] > 0).mean()),
                all_hold_per=float(ok["hold_per"].mean()), all_disc_per=float(ok["disc_per"].mean()), n_all=len(ok))
    return top[["family", "hypothesis", "disc_n", "disc_per", "disc_t", "hold_n", "hold_per", "hold_t"]].reset_index(drop=True), info


# ============================================================ what happens after the entry
def forward(df):
    """Binance (bp) and the token's mid (cents) after the entry, in the entry's direction, at +1, +5 and +30 s, with cluster 95% intervals; and the move over the signal's own lookback
    that the book made against the move the model implies (the 'already priced' ratio)."""
    rows = []
    for h in HORIZONS:
        for src, col, unit in (("Binance mid", f"bn{h}", "bp"), ("token mid", f"bk{h}", "cents")):
            ok = df[col].notna().to_numpy()
            m, se = cl_mean(df.loc[ok, col].to_numpy(), df.loc[ok, "slot"].to_numpy())
            rows.append(dict(source=src, after=f"+{h} s", mean=m, lo=m - 1.96 * se, hi=m + 1.96 * se, unit=unit))
    out = pd.DataFrame(rows)
    mb, mf = float(df["d_book"].mean(skipna=True)) * 100, float(df["d_fair"].mean(skipna=True)) * 100
    return out, dict(book_cents=mb, fair_cents=mf, ratio=mb / mf if mf else float("nan"))


# ============================================================ the edge hunt
def _combos(dims):
    one = [(d,) for d in dims]
    two = [(a, b) for i, a in enumerate(dims) for b in dims[i + 1:]]
    return one + two


def hypotheses(frames: dict, dims=DIMS, min_n: int = 30, min_slots: int = 10):
    """-> list of dicts {family, cell, label, idx_key, mask}. `frames` maps a cell name to its entry frame (all days). The chosen pair's frame gets every 1- and 2-label slice; every other cell
    gets the whole cell and its per-coin cut. A frame whose name starts with `chosen` is cut by `dims`."""
    hyps = []
    for cell, fr in frames.items():
        if len(fr) == 0:
            continue
        if cell.startswith("chosen"):
            hyps.append(dict(family="slice of the chosen pair", cell=cell, label="all entries", by="all", mask=fr.index.to_numpy()))
            for combo in _combos(dims):
                for key, g in fr.groupby(list(combo), observed=True):
                    key = key if isinstance(key, tuple) else (key,)
                    hyps.append(dict(family="slice of the chosen pair", cell=cell, label=" x ".join(str(v) for v in key), by=" x ".join(combo), mask=g.index.to_numpy()))
        else:
            hyps.append(dict(family="signal cell", cell=cell, label=cell, by="cell", mask=fr.index.to_numpy()))
            for c in COINS:
                g = fr[fr["coin"] == c]
                hyps.append(dict(family="signal cell x coin", cell=cell, label=f"{cell} x {c}", by="cell x coin", mask=g.index.to_numpy()))
    out = []
    for h in hyps:
        fr = frames[h["cell"]]
        g = fr.loc[h["mask"]]
        if len(g) >= min_n and g["slot"].nunique() >= min_slots:
            out.append(h)
    return out


def hunt(frames: dict, hold_days, n_boot: int = 4000, seed: int = 7, min_n: int = 30, one_sided: bool = True, dims=DIMS):
    """Score every hypothesis (the pair whole, its slices, and the other signal cells whole and cut by coin) once; the pair's own cell must not be passed twice. -> (DataFrame, info). Columns: entries, net per entry, cluster t, raw p (normal, one-sided for 'above zero'),
    Holm p over all hypotheses, max-t p (a slot bootstrap of the null-centred nets: the share of draws whose BEST hypothesis reaches this one's t), and the same slice on the discovery days
    (every day before `hold_days`) and on the hold-out days (`hold_days`). Nothing here selects."""
    hyps = hypotheses(frames, dims=dims, min_n=min_n)
    H = len(hyps)
    all_slots = np.unique(np.concatenate([fr["slot"].to_numpy() for fr in frames.values() if len(fr)]))
    sidx = {s: i for i, s in enumerate(all_slots)}
    A = np.zeros((H, len(all_slots)))
    C = np.zeros((H, len(all_slots)))
    rows = []
    for i, h in enumerate(hyps):
        fr = frames[h["cell"]]
        g = fr.loc[h["mask"]]
        x = g["net"].to_numpy(float)
        sl = np.array([sidx[s] for s in g["slot"]])
        t, m, se = _t(x, g["slot"].to_numpy())
        np.add.at(A[i], sl, x - m)
        np.add.at(C[i], sl, 1.0)
        hold = g["date"].isin(hold_days).to_numpy()
        td, md, _ = _t(x[~hold], g["slot"].to_numpy()[~hold]) if (~hold).sum() > 2 else (float("nan"), float("nan"), None)
        th, mh, _ = _t(x[hold], g["slot"].to_numpy()[hold]) if hold.sum() > 2 else (float("nan"), float("nan"), None)
        rows.append(dict(family=h["family"], by=h["by"], hypothesis=h["label"], entries=len(g), win=float(g["won"].mean()), price=float(g["vwap"].mean()), per=m, se=se, t=t,
                         disc_n=int((~hold).sum()), disc_per=md, disc_t=td, hold_n=int(hold.sum()), hold_per=mh, hold_t=th))
    df = pd.DataFrame(rows)
    p_raw = norm.sf(df["t"].to_numpy()) if one_sided else 2 * norm.sf(np.abs(df["t"].to_numpy()))
    order = np.argsort(p_raw)
    holm = np.empty(H)
    run = 0.0
    for r, i in enumerate(order):
        run = max(run, min(1.0, p_raw[i] * (H - r)))
        holm[i] = run
    rng = np.random.default_rng(seed)
    ns = len(all_slots)
    Wt = np.zeros((n_boot, ns))
    for b in range(n_boot):
        Wt[b] = np.bincount(rng.integers(0, ns, ns), minlength=ns)
    num = Wt @ A.T
    den = np.maximum(Wt @ C.T, 1.0)
    T = (num / den) / df["se"].to_numpy()[None, :]
    mx = T.max(1)
    p_max = np.array([(mx >= t).mean() for t in df["t"].to_numpy()])
    p_boot = np.array([(T[:, j] >= df["t"].iloc[j]).mean() for j in range(H)])
    df["p_raw"], df["p_holm"], df["p_boot"], df["p_maxt"] = p_raw, holm, p_boot, p_max
    exp_max = float(np.mean(mx))
    info = dict(n_hyp=H, expected_best_t=exp_max, q95_best_t=float(np.quantile(mx, 0.95)), n_raw_05=int((p_raw < 0.05).sum()), n_holm_05=int((holm < 0.05).sum()), n_maxt_05=int((p_max < 0.05).sum()))
    ok = df["disc_n"].ge(20) & df["hold_n"].ge(20)
    if ok.sum() > 3:
        sub = df[ok]
        info["rank_corr"] = float(sub["disc_per"].rank().corr(sub["hold_per"].rank()))
        info["rank_corr_n"] = int(ok.sum())
    return df.sort_values("t", ascending=False).reset_index(drop=True), info


# ============================================================ a structural scan: no Binance signal at all
SCAN_T = ((600, 886, "600+ s left"), (300, 600, "300-600 s left"), (120, 300, "120-300 s left"), (60, 120, "60-120 s left"), (10, 60, "10-60 s left"))
SCAN_T_LABELS = tuple(x[2] for x in SCAN_T)
SCAN_P_EDGES = (0.0, 0.10, 0.25, 0.45, 0.55, 0.75, 0.90, 0.97)
SCAN_P_LABELS = ("(0.0, 0.1]", "(0.1, 0.25]", "(0.25, 0.45]", "(0.45, 0.55]", "(0.55, 0.75]", "(0.75, 0.9]", "(0.9, 0.97]")


def structural_scan(tab, sig, ex, roles, cuts):
    """Buy USD 20 of EACH token (Up, then Down) at the first second of each time-left band whose ladder fills, hold to expiry, on the exact ladder 250 ms later with the fee: no signal, no
    side chosen, so the net per entry by the price paid is a read of how the book prices a token against how often it pays. -> one entry frame with `tband`, `pband`, `tok`."""
    out = []
    for lo, hi, lab in SCAN_T:
        ok = (tab.T >= lo) & (tab.T < hi)
        trig = np.broadcast_to(ok[None, :], (tab.W, tab.NK)).copy()
        for s_, nm in ((1, "Up"), (-1, "Down")):
            side = np.full((tab.W, tab.NK), s_, np.int8)
            f = entry_frame(tab, M.settle(tab, side, trig, ex, 1), sig, roles, cuts)
            if len(f):
                f["tband"], f["tok"] = lab, nm
                out.append(f)
    df = pd.concat(out, ignore_index=True)
    df["pband"] = pd.cut(df["vwap"], list(SCAN_P_EDGES), labels=list(SCAN_P_LABELS)).astype(str)
    return df[df["pband"] != "nan"].reset_index(drop=True)


def near_certain(tab, sig, ex, roles, cuts, a_lo: float, theta: float, t_min: int = 10):
    """The um-006 family on this table: buy the token that asks at least `a_lo` (and at most 0.995) when the fair value clears its ask by more than `theta`, the first filled second, hold to
    expiry. -> entry frame. (um-006 BUYS the near-certain side; it does not short it.)"""
    lad = tab.lad
    ask_u = lad[:, 2, :, 0].astype(float)
    ask_d = 1.0 - lad[:, 0, :, 0].astype(float)
    pu = tab.pu.astype(float)
    eu, ed = pu - ask_u, (1.0 - pu) - ask_d
    fu = (ask_u >= a_lo) & (ask_u <= 0.995) & (eu > theta)
    fd = (ask_d >= a_lo) & (ask_d <= 0.995) & (ed > theta)
    side = np.where(fu & ~(fd & (ed > eu)), 1, np.where(fd, -1, 0)).astype(np.int8)
    trig = (fu | fd) & (tab.T[None, :] >= t_min)
    return entry_frame(tab, M.settle(tab, side, trig, ex, sig.lu), sig, roles, cuts)


# ============================================================ the engine's own checks
def selftest() -> bool:
    ok = True

    def line(label, cond):
        nonlocal ok
        print(f"  {'ok  ' if cond else 'FAIL'} {label}")
        ok &= bool(cond)

    rng = np.random.default_rng(1)
    slot = np.repeat(np.arange(200), 4)
    x = rng.normal(0, 1, 800)
    m, se = cl_mean(x, slot)
    line("cluster se of independent draws is close to the plain se", abs(se - x.std(ddof=1) / np.sqrt(800)) < 0.2 * se)
    shared = np.repeat(rng.normal(0, 1, 200), 4) + rng.normal(0, 0.1, 800)
    _, se_c = cl_mean(shared, slot)
    line("cluster se of draws shared inside a slot is far above the plain se (the four coins are one draw)", se_c > 1.6 * shared.std(ddof=1) / np.sqrt(800))
    df = pd.DataFrame(dict(net=np.where(np.repeat(np.arange(200) % 2, 4) == 0, -2.0, 0.0) + rng.normal(0, 0.1, 800), slot=slot, day=np.repeat(np.arange(200) // 100, 4), lab=np.repeat(np.arange(200) % 2, 4).astype(str)))
    df["coin"] = np.tile(["a", "b", "c", "d"], 200)
    df["tod"] = df["lab"]
    W1, d1, p1 = wald_equal_means(df, "lab")
    W2, d2, p2 = wald_equal_means(df, "coin")
    line("the Wald test sees a label that splits the nets by two units (p tiny) and a label that does not (p large)", p1 < 1e-6 and p2 > 0.1)
    g = pd.DataFrame(dict(won=[1.0, 0.0, 1.0, 0.0], pu_side=0.55, mid_dec=0.5, mid_fill=0.51, vwap=0.52, shares=[30.0, 30.0, 30.0, 30.0], fee=0.5, slot=[1, 1, 2, 2]))
    g["net"] = g["shares"] * (g["won"] - g["vwap"]) - g["fee"]
    wf = waterfall(g)
    line("the waterfall terms add to the net of every entry", abs(wf.loc[wf.term != "net", "usd"].sum() - g["net"].mean()) < 1e-9)
    h = g.copy()
    h.loc[0, "net"] += 1.0
    try:
        waterfall(h)
        refused = False
    except AssertionError:
        refused = True
    line("a frame whose net is not the sum of its terms is refused", refused)
    # the hunt on pure noise has no winner at the corrected level; on a planted slice it finds it
    fr = []
    for sd in range(3):
        r = np.random.default_rng(10 + sd)
        n = 1200
        f = pd.DataFrame(dict(net=r.normal(0, 5, n), won=r.random(n) < 0.5, vwap=0.5, q=0.52, fee=0.5, gross=r.normal(0, 5, n), shares=30.0, slot=np.repeat(np.arange(n // 4) + 1000 * sd, 4),
                              date=np.where(np.arange(n) < 800, "d0", "d1"), coin=np.tile(list(COINS), n // 4), tod=r.choice(TOD_LABELS, n), vol=r.choice(VOL_LABELS, n),
                              timing=r.choice(TIMING_LABELS, n), lead=r.choice(["with the leader", "against the leader"], n)))
        f.index = pd.RangeIndex(n)
        fr.append(f)
    fn = {"chosen noise": fr[0]}
    res, info = hunt(fn, hold_days=("d1",), n_boot=800, min_n=30)
    line("on pure noise the corrected tests find nothing", (res["p_maxt"] > 0.05).all() and info["n_holm_05"] == 0)
    pl = fr[1].copy()
    pl.loc[(pl["coin"] == "sol") & (pl["vol"] == "high vol"), "net"] += 4.0
    res2, info2 = hunt({"chosen planted": pl}, hold_days=("d1",), n_boot=800, min_n=30)
    top = res2.iloc[0]
    line("a planted slice (sol in high volatility, +4 USD an entry) is found at the corrected level", ("sol" in top["hypothesis"]) and top["p_maxt"] < 0.05 and info2["n_maxt_05"] >= 1)
    return bool(ok)


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
