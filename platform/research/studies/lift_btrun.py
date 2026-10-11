"""The loop over days for the Polymarket backtest of the Binance momentum pack (B-0649): one UTC day in, the entries of every configuration and the lag read out.

THE INPUTS ARE PINNED AND READ ONLY THROUGH THE DATA LAYER: the Binance trades through `fundplat.data.crypto.ticks` (via `lift_feat.load_day`), the market list through
`fundplat.data.predmkts.updown15` (via `updown15_runner.market_rows`) and the exact ladders through `fundplat.data.predmkts.updown15_pin.read`. This module opens no file.
A window whose ladders are not pinned is counted as `no_book` and never skipped silently.
"""
from __future__ import annotations

import zlib

import numpy as np
import pandas as pd

import lift_bt as BT
import lift_feat as LF
import lift_pack as PK
import updown15_run as R


def _book(slug: str):
    from fundplat.data.predmkts import updown15_pin
    p = updown15_pin.read(slug)
    return R.Book(p["states"])


def day_triggers(E: dict, z0s, day0: int, day1: int, gap_ms: int = 5000) -> dict:
    """z0 -> dict(ts, side, z) of the episode starts of the pack inside the day, from the events table of lift_feat.load_day (three days of tape for the look-back)."""
    ts, px = E["ts"], E["px"]
    z = PK.z_one_second(ts, px)
    out = {}
    for z0 in z0s:
        idx, side = PK.triggers(ts, z, z0, gap_ms)
        keep = (ts[idx] >= day0) & (ts[idx] < day1)
        out[z0] = dict(ts=ts[idx][keep], side=side[keep], z=z[idx][keep])
    return out


def run_day(day: str, cfgs: list, variants: dict | None = None, lag: bool = True, symbol: str = "BTCUSDT", log=print):
    """Every window of the day, every configuration. `variants` maps a label to a function(trig, tools, mk) -> trig' (the benchmarks: random side, fade, a planted peek) and is
    run for the FIRST config only. -> (entries DataFrame with a `variant` column, windows DataFrame, lag dict of arrays or None)."""
    import updown15_runner as RUN
    E = LF.load_day(day, symbol)
    z0s = sorted({c.z0 for c in cfgs})
    trig = day_triggers(E, z0s, E["day0"], E["day1"])
    tools = BT.Tools(E)
    rows = RUN.market_rows(day, assets=("btc",))
    entries, wins = [], []
    lag_chg, lag_fair, lag_mid0, lag_spr, lag_slug = [], [], [], [], []
    for mk in rows:
        try:
            book = _book(mk["slug"])
        except (KeyError, LookupError) as e:
            wins.append(dict(slug=mk["slug"], day=day, status="no_book", why=str(e)[:60], triggers=0))
            continue
        up_won = mk["outcome"] == "Up"
        e = BT.run_window(mk, book, trig, cfgs, up_won)
        for r in e:
            r["variant"] = "pack"
        entries.extend(e)
        for label, fn in (variants or {}).items():
            tv = {c.z0: fn(trig[c.z0], tools, mk) for c in cfgs[:1]}
            ev = BT.run_window(mk, book, tv, cfgs[:1], up_won)
            for r in ev:
                r["variant"] = label
            entries.extend(ev)
        t1 = trig[min(z0s)]
        in_win = (t1["ts"] >= mk["start_ms"]) & (t1["ts"] < mk["end_ms"])
        wins.append(dict(slug=mk["slug"], day=day, status="ok", why="", triggers=int(in_win.sum())))
        if lag and in_win.any():
            lw = BT.lag_window(mk, book, tools, t1["ts"][in_win], t1["side"][in_win])
            if lw is not None:
                lag_chg.append(lw[0]); lag_fair.append(lw[1]); lag_mid0.append(lw[2]); lag_spr.append(lw[3]); lag_slug += [mk["slug"]] * len(lw[2])
    lagd = None
    if lag_chg:
        lagd = dict(mid=np.concatenate(lag_chg), fair=np.concatenate(lag_fair), mid0=np.concatenate(lag_mid0), spread150=np.concatenate(lag_spr), slug=np.array(lag_slug))
    return pd.DataFrame(entries), pd.DataFrame(wins), lagd


# ---------------------------------------------------------------------------- the benchmark and planted variants (functions of one window's triggers)
def v_fade(trig, tools, mk):
    return dict(ts=trig["ts"], side=-trig["side"], z=trig["z"])


def make_random_side(seed: int):
    def fn(trig, tools, mk):
        rng = np.random.default_rng(seed + zlib.crc32(mk["slug"].encode()) % 100_000)
        return dict(ts=trig["ts"], side=rng.choice([-1.0, 1.0], size=len(trig["ts"])), z=trig["z"])
    return fn


def make_peek(seconds: float):
    """A PLANTED look-ahead: the side is the direction of the Binance price over the NEXT `seconds` instead of the last second. It must pay far more than the real signal."""
    def fn(trig, tools, mk):
        E, LF_ = tools.E, tools.LF
        t = trig["ts"]
        a = E["px"][LF_.asof(E["ts"], t)]
        b = E["px"][LF_.asof(E["ts"], t + int(seconds * 1000))]
        s = np.sign(b - a)
        keep = s != 0
        return dict(ts=t[keep], side=s[keep], z=trig["z"][keep])
    return fn


def make_stale(seconds: float):
    """The same signal read `seconds` late (the trigger time moved back, the side kept): a stale signal must pay less."""
    def fn(trig, tools, mk):
        return dict(ts=trig["ts"] + int(seconds * 1000), side=trig["side"], z=trig["z"])
    return fn
