"""tailsell_grid - the rule sweep for the sell-the-first-token book (pure; the only I/O is the frozen inputs file, read once per worker).
Lives beside its notebook until platform lands it beside `fundplat.quant.predmkts.tail_sell` (board item B-0490). The notebook sets every knob; nothing is fixed here.

One book = a rule (entry band, take-profit, stop, time stop) x a horizon cap x a category cap, at one clip. A sweep runs every combination in parallel and returns,
per book, the metrics of the whole window, the TRAIN half and the TEST half (the split is the median entry time of a base rule, set by the caller), so a rule can be
chosen on one half and scored on the other.
"""
import heapq
import itertools
import multiprocessing as mp

import numpy as np

from fundplat.quant.predmkts import tail_sell as EN
import tailsell_data as TD
import tailsell_risk as RK

DAY = 86400
G = {}


def tiered(schedule):
    """A half-spread by the market's final volume: schedule = ((volume floor, half-spread), ...) from the highest floor down."""
    return lambda m: next(s for v, s in schedule if m["vol"] >= v)


def make_tasks(los, his, tps, sls, tmaxs, min_width=0.10):
    """Every valid (lo, hi, tp, sl, tmax): the band at least min_width wide, a take-profit below the band, a stop above it."""
    out = []
    for lo, hi in itertools.product(los, his):
        if hi < lo + min_width - 1e-9:
            continue
        for tp, sl, tmax in itertools.product(tps, sls, tmaxs):
            if tp is not None and tp >= lo - 1e-9:
                continue
            if sl is not None and sl <= hi + 1e-9:
                continue
            out.append((lo, hi, tp, sl, tmax))
    return out


def accept(trs, clip, cat_cap=None, per_event=1, cap=1.0):
    """Positions taken in entry order: a stake of `clip` each, at most `cap` of capital open, `per_event` per event and `cat_cap` of capital open in one category."""
    acc, open_h, open_c, per_ev, cat_open = [], [], 0.0, {}, {}
    for tr in sorted(trs, key=lambda r: r["t_in"]):
        while open_h and open_h[0][0] <= tr["t_in"]:
            _, c, ev, g = heapq.heappop(open_h)
            open_c -= c
            per_ev[ev] -= 1
            cat_open[g] -= c
        if per_ev.get(tr["event"], 0) >= per_event or open_c + clip > cap + 1e-12:
            continue
        if cat_cap is not None and cat_open.get(tr["grp"], 0.0) + clip > cat_cap + 1e-12:
            continue
        open_c += clip
        per_ev[tr["event"]] = per_ev.get(tr["event"], 0) + 1
        cat_open[tr["grp"]] = cat_open.get(tr["grp"], 0.0) + clip
        heapq.heappush(open_h, (tr["t_out"], clip, tr["event"], tr["grp"]))
        acc.append(tr)
    return acc


def build(mk, hist, rule, slip, clip, tokens=(0,), skip_last=2, min_obs=4):
    """One book from a rule dict (lo, hi, tp, sl, tmax, hz, cc). Returns (daily P&L in capital units, first day number, accepted positions); passes verify_book."""
    tr = EN.simulate(mk, hist, rule["lo"], rule["hi"], tp=rule.get("tp"), sl=rule.get("sl"), tmax=rule.get("tmax"), slip=slip, tokens=tokens, skip_last=skip_last, min_obs=min_obs)
    hz = rule.get("hz")
    if hz is not None:
        tr = [x for x in tr if x["sched_left"] == x["sched_left"] and x["sched_left"] <= hz]
    acc = accept(tr, clip, rule.get("cc"))
    d, d0, a2 = EN.book(acc, hist, clip=clip, cap=10.0, per_event=0)
    EN.verify_book(d, a2, clip)
    return d, d0, a2


def worst_day(accepted, clip):
    """Largest one-day loss from positions that resolve that day, as a share of capital."""
    loss = RK.resolution_loss_days(accepted, clip)
    return -min((v["loss"] for v in loss.values()), default=0.0)


def seg(daily, d0, acc, lo_day, hi_day, clip, rf):
    a, b = max(0, lo_day - d0), min(len(daily), hi_day - d0)
    s = daily[a:b]
    if len(s) < 30 or np.std(s) == 0:
        return None
    st = EN.stats(s, rf=rf)
    sub = [x for x in acc if lo_day <= int(x["t_out"] // DAY) < hi_day]
    return dict(sharpe=st["sharpe_ex"], ann=st["ann_ret"], dd=st["max_dd"], worst=worst_day(sub, clip), n=len(sub), vol=st["ann_vol"])


def _init(p):
    mk, hist, census, dg = TD.load_inputs(p["input"])
    G.update(p=p, mk={k: v for k, v in mk.items() if not v["head"]}, hist=hist, slip=tiered(p["slip"]))


def _task(args):
    p, mk, hist = G["p"], G["mk"], G["hist"]
    lo, hi, tp, sl, tmax = args
    tr = EN.simulate(mk, hist, lo, hi, tp=tp, sl=sl, tmax=tmax, slip=G["slip"], tokens=(0,), skip_last=p["skip_last"], min_obs=p["min_obs"])
    split_day, clip, rf, out, nver = int(p["split"] // DAY), p["clip"], p["rf"], [], 0
    for hz in p["horizons"]:
        t1 = tr if hz is None else [x for x in tr if x["sched_left"] == x["sched_left"] and x["sched_left"] <= hz]
        if len(t1) < p["min_pos"]:
            continue
        for cc in p["catcaps"]:
            acc = accept(t1, clip, cc)
            if len(acc) < p["min_pos"]:
                continue
            d, d0, a2 = EN.book(acc, G["hist"], clip=clip, cap=10.0, per_event=0)
            EN.verify_book(d, a2, clip)
            nver += 1
            end = d0 + len(d) + 1
            al, tr_, te_ = seg(d, d0, a2, d0, end, clip, rf), seg(d, d0, a2, d0, split_day, clip, rf), seg(d, d0, a2, split_day, end, clip, rf)
            if al is None or tr_ is None or te_ is None:
                continue
            kinds = [x["kind"] for x in a2]
            out.append(dict(lo=lo, hi=hi, tp=tp, sl=sl, tmax=tmax, hz=hz, cc=cc, n=len(a2), days=float(np.mean([x["days"] for x in a2])), ret=float(np.mean([x["ret"] for x in a2])),
                            tp_share=kinds.count("tp") / len(kinds), time_share=kinds.count("time") / len(kinds), dep=sum(clip * x["days"] for x in a2) / max(1, len(d)),
                            **{f"all_{k}": v for k, v in al.items()}, **{f"tr_{k}": v for k, v in tr_.items()}, **{f"te_{k}": v for k, v in te_.items()}))
    return out, nver


def sweep(tasks, params, workers=12):
    """Run every task in a process pool. params: input (frozen file name), slip (the tiered schedule), skip_last, min_obs, split (epoch seconds), clip, rf, horizons, catcaps, min_pos.
    Returns (rows, number of books that passed verify_book)."""
    rows, nver = [], 0
    with mp.Pool(workers, initializer=_init, initargs=(params,)) as pool:
        for r, n in pool.imap_unordered(_task, tasks, chunksize=4):
            rows += r
            nver += n
    return rows, nver
