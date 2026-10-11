"""tailsell_risk - cluster, concentration, stress and look-ahead helpers for the tail-sell study (pure; no I/O).
A study-local stopgap beside the notebook. Generic versions (a minimum track-record length, a drawdown bootstrap, a Brier score, a shuffled-signal
test) are board items for `platform`; this file holds only what this study needs, and nothing in it reads a venue.
"""
import numpy as np

DAY = 86400


# ---- clusters: how many independent bets are there? ---------------------------------------------------------------
def effective_n(values, keys):
    """The number of independent observations that would give the same variance of the mean as these clustered ones:
    n_eff = s^2 n^2 / sum_c r_c^2, r_c the sum of (x - mean) inside cluster c. All clusters of size one gives about n; one cluster gives 1.
    Capped at n (a negative within-cluster correlation cannot make the sample more informative than n independent draws)."""
    x = np.asarray(values, float)
    n = len(x)
    if n < 2:
        return float(n)
    m, s2 = x.mean(), x.var(ddof=1)
    r = {}
    for v, k in zip(x, keys):
        r[k] = r.get(k, 0.0) + (v - m)
    ss = sum(v * v for v in r.values())
    return float(min(n, s2 * n * n / ss)) if ss > 0 else float(n)


def day_key(t_s):
    return int(t_s // DAY)


def week_key(t_s):
    return int(t_s // DAY // 7)


def resolution_loss_days(accepted, clip):
    """Realised losses by resolution day (capital units): {day: dict(loss, n, events, groups)}. Each position's capital P&L is clip x return on stake."""
    out = {}
    for x in accepted:
        if x["ret"] < 0:
            o = out.setdefault(day_key(x["t_out"]), dict(loss=0.0, n=0, events=set(), groups={}))
            o["loss"] += clip * x["ret"]
            o["n"] += 1
            o["events"].add(x["event"])
            o["groups"][x["grp"]] = o["groups"].get(x["grp"], 0) + 1
    return out


# ---- worst periods ----------------------------------------------------------------------------------------------
def rolling_sums(daily, w):
    d = np.asarray(daily, float)
    if len(d) < w:
        return np.zeros(0)
    c = np.concatenate(([0.0], np.cumsum(d)))
    return c[w:] - c[:-w]


def worst_windows(daily, w, k):
    """The k worst non-overlapping windows of w days: [(start_index, sum)], worst first."""
    s = rolling_sums(daily, w)
    taken, out = np.zeros(len(daily), bool), []
    for i in np.argsort(s):
        if len(out) == k:
            break
        if not taken[i:i + w].any():
            taken[i:i + w] = True
            out.append((int(i), float(s[i])))
    return out


# ---- concentration ----------------------------------------------------------------------------------------------
def event_pnl(accepted, clip):
    """Capital P&L per event: {event: sum of clip x ret}."""
    out = {}
    for x in accepted:
        out[x["event"]] = out.get(x["event"], 0.0) + clip * x["ret"]
    return out


def mean_without(accepted, drop_events):
    """Mean return on the stake per position with the given events removed."""
    r = [x["ret"] for x in accepted if x["event"] not in drop_events]
    return float(np.mean(r)) if r else float("nan")


# ---- lock-up and resolution stress (every number a named assumption of the caller) -----------------------------
def stressed_excess(trades, delay_days, haircut, rate):
    """Per position: return on the stake, less a haircut (the share of the stake not redeemed), less the T-bill rate on the stake for the
    days held plus `delay_days` extra days locked. Returns the array of excess returns over a T-bill on the days actually held."""
    return np.array([x["ret"] - haircut - rate * (x["days"] + delay_days) / 365.0 for x in trades], float)


# ---- look-ahead: does the entry decision use only what was known at the entry? ---------------------------------
def entry_set(trades):
    return {x["id"]: (x["i"], round(x["pe"], 9)) for x in trades}


def changed_share(a, b):
    """Entries in a or b that differ between them (present in one only, or a different print), over the entries of a."""
    keys = set(a) | set(b)
    return sum(1 for k in keys if a.get(k) != b.get(k)) / max(1, len(a))


def permuted_fields(mk, fields, seed):
    """A copy of the market table with the given fields (known only after the entry: y, vol) permuted across markets."""
    rng = np.random.default_rng(seed)
    ids = list(mk)
    out = {k: dict(v) for k, v in mk.items()}
    for f in fields:
        vals = [mk[k][f] for k in ids]
        for k, j in zip(ids, rng.permutation(len(ids))):
            out[k][f] = vals[j]
    return out


def truncated_after_entry(hist, entry, pad):
    """Histories cut `pad` prints after each market's entry print (markets without an entry are kept whole): nothing later may matter."""
    out = dict(hist)
    for k, (i, _) in entry.items():
        out[k] = hist[k][:i + pad + 1]
    return out


def leak_table(variants, mk, hist, pad, seed=7):
    """variants: {name: fn(mk, hist) -> trades}. For each, the share of its entries that change when (a) the outcomes are permuted across
    markets, (b) the final volumes are permuted, (c) every history is cut `pad` prints after its entry. A rule that decides only on what
    was known at the entry reads 0 in all three. Returns {name: (n_entries, share_a, share_b, share_c)}."""
    mk_y = permuted_fields(mk, ("y",), seed)
    mk_v = permuted_fields(mk, ("vol",), seed + 1)
    out = {}
    for name, fn in variants.items():
        base = entry_set(fn(mk, hist))
        out[name] = (len(base), changed_share(base, entry_set(fn(mk_y, hist))), changed_share(base, entry_set(fn(mk_v, hist))),
                     changed_share(base, entry_set(fn(mk, truncated_after_entry(hist, base, pad)))))
    return out
