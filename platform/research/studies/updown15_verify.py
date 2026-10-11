"""Planted tests for the 15-minute Up/Down study (B-0642): proof that the simulation has no look-ahead, not a claim.

Each test is a function of ENTRIES frames (columns asset, win_start_ms, side, shares, vwap, fee_usd, won, pnl_gross, pnl_net) that the study's own
simulation returns when run with one thing deliberately wrong or moved. The detectors are pure; `selftest()` breaks each one on synthetic
frames (what would it print if false: `app/library/law/how-we-know.md#what-would-it-print-if-false`) and the notebook counts the passes in verify().

run(**kw) is the study's simulation: kw may carry feature_shift_s (+n reads the feature grid n seconds EARLIER, -n n seconds LATER),
latency_ms, leak (True: the model sees the window-end price) and shuffle_seed. It returns an entries frame.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

LEAK_WIN = 0.90             # a leaking model must win at least this share of its entries, with the Wilson low above it
MIN_N = 100                 # a detector reads nothing from fewer entries than this
BACK_TOL_SE = 2.0           # a 1 s STALE feature set may move the mean PnL per entry by at most this many standard errors of the base mean
FWD_GAIN_SE = 2.0           # a 1 s FUTURE feature set must raise it by at least this many
SHUFFLE_TOL = 0.03          # shuffled win rate within this of the analytic base-rate expectation


def per_entry(e: pd.DataFrame):
    x = np.asarray(e["pnl_net"], float)
    return float(x.mean()) if len(x) else np.nan, (float(x.std(ddof=1) / np.sqrt(len(x))) if len(x) > 1 else np.nan)


def wilson_low(k, n, z=1.96):
    if n == 0:
        return np.nan
    p = k / n
    d = 1 + z * z / n
    return float((p + z * z / (2 * n) - z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d)


# ---------------------------------------------------------------- (a) the leak must be caught
def leak_flag(e: pd.DataFrame) -> dict:
    """True when the entries win absurdly often: the lower Wilson bound of the win rate is above LEAK_WIN."""
    n = len(e)
    k = int(np.asarray(e["won"], bool).sum()) if n else 0
    lo = wilson_low(k, n) if n >= MIN_N else np.nan
    return dict(n=n, win_rate=(k / n if n else np.nan), wilson_low=lo, flagged=bool(n >= MIN_N and lo > LEAK_WIN))


# ---------------------------------------------------------------- (b) stale features must not matter, future features must help
def shift_verdicts(base: pd.DataFrame, back: pd.DataFrame, fwd: pd.DataFrame) -> dict:
    m0, se0 = per_entry(base)
    mb, _ = per_entry(back)
    mf, _ = per_entry(fwd)
    return dict(base=m0, back=mb, fwd=mf, se=se0,
                back_ok=bool(abs(mb - m0) <= BACK_TOL_SE * se0),
                fwd_ok=bool(mf - m0 >= FWD_GAIN_SE * se0),
                n=(len(base), len(back), len(fwd)))


# ---------------------------------------------------------------- (c) shuffled outcomes
def shuffle_test(e: pd.DataFrame, windows: pd.DataFrame, reps: int = 300, seed: int = 11) -> dict:
    """Re-score the SAME entries (same side, same fill) against outcomes drawn from other windows of the same asset. The win rate must sit at the
    base rate of the side and the mean PnL at its analytic value (shares x base rate - cost - fee), not above."""
    rng = np.random.default_rng(seed)
    wr, mp, exp_w, exp_p = [], [], [], []
    ent = e.reset_index(drop=True)
    pool = {a: np.asarray(g["outcome_up"], bool) for a, g in windows.groupby("asset")}
    side = np.asarray(ent["side"], int)
    sh, cost, fee = (np.asarray(ent[c], float) for c in ("shares", "cost" if "cost" in ent else "vwap", "fee_usd"))
    if "cost" not in ent:
        cost = sh * np.asarray(ent["vwap"], float)
    base_up = np.array([pool[a].mean() for a in ent["asset"]])
    p_side = np.where(side == 1, base_up, 1 - base_up)
    exp_w = float(p_side.mean())
    exp_p = float((sh * p_side - cost - fee).mean())
    for _ in range(reps):
        out = np.array([rng.choice(pool[a]) for a in ent["asset"]])
        won = (side == 1) == out
        wr.append(float(won.mean()))
        mp.append(float((sh * won - cost - fee).mean()))
    return dict(win_rate=float(np.mean(wr)), win_rate_expected=exp_w, pnl=float(np.mean(mp)), pnl_expected=exp_p, pnl_p05=float(np.percentile(mp, 5)),
                pnl_p95=float(np.percentile(mp, 95)),
                ok=bool(abs(np.mean(wr) - exp_w) <= SHUFFLE_TOL and abs(np.mean(mp) - exp_p) <= 3 * np.std(mp) + 1e-9))


# ---------------------------------------------------------------- (d) the clock moved later
def decay_table(runs: dict) -> pd.DataFrame:
    """runs: {label: entries}; one row each: entries, win rate, PnL after fee, per entry. The notebook prints it for +0, +250 ms, +1 s."""
    rows = []
    for k, e in runs.items():
        m, se = per_entry(e)
        rows.append(dict(run=k, entries=len(e), win_rate=(float(np.asarray(e["won"], bool).mean()) if len(e) else np.nan), pnl_after_fee=float(np.sum(e["pnl_net"])), per_entry=m, se=se))
    return pd.DataFrame(rows)


def run_all(run, windows: pd.DataFrame) -> tuple[list[dict], dict]:
    """The planted tests of the brief, in order. -> (rows for the Verification table, the raw results). Every row has name, expected, reading, passed."""
    base = run()
    leak = run(leak=True)
    back, fwd = run(feature_shift_s=1), run(feature_shift_s=-1)
    t250, t1000 = run(latency_ms_extra=250), run(latency_ms_extra=1000)
    lk, lb = leak_flag(leak), leak_flag(base)
    sv = shift_verdicts(base, back, fwd)
    sh = shuffle_test(base, windows)
    dt = decay_table({"as run": base, "+250 ms": t250, "+1 s": t1000})
    rows = [
        dict(name="a1 the leaking model is flagged", expected="win rate Wilson low > %.2f" % LEAK_WIN, reading=f"win {lk['win_rate']:.3f} on {lk['n']}, low {lk['wilson_low']:.3f}", passed=lk["flagged"]),
        dict(name="a2 the honest model is not flagged", expected="Wilson low <= %.2f" % LEAK_WIN, reading=f"win {lb['win_rate']:.3f} on {lb['n']}, low {lb['wilson_low']:.3f}", passed=not lb["flagged"]),
        dict(name="b1 features 1 s stale: no material change", expected=f"within {BACK_TOL_SE:.0f} SE", reading=f"{sv['back'] - sv['base']:+.3f} USD per entry vs SE {sv['se']:.3f}", passed=sv["back_ok"]),
        dict(name="b2 features 1 s from the future: better", expected=f"at least +{FWD_GAIN_SE:.0f} SE", reading=f"{sv['fwd'] - sv['base']:+.3f} USD per entry vs SE {sv['se']:.3f}", passed=sv["fwd_ok"]),
        dict(name="c1 shuffled outcomes: win rate at the base rate", expected=f"{sh['win_rate_expected']:.3f} +/- {SHUFFLE_TOL}", reading=f"{sh['win_rate']:.3f}", passed=abs(sh["win_rate"] - sh["win_rate_expected"]) <= SHUFFLE_TOL),
        dict(name="c2 shuffled outcomes: PnL at its analytic value", expected=f"{sh['pnl_expected']:+.3f} USD per entry", reading=f"{sh['pnl']:+.3f} (5th-95th {sh['pnl_p05']:+.2f}..{sh['pnl_p95']:+.2f})", passed=sh["ok"]),
        dict(name="d1 clock +250 ms: PnL does not rise", expected="per entry <= as run + 1 SE", reading=f"{dt.loc[1, 'per_entry'] - dt.loc[0, 'per_entry']:+.3f} USD", passed=bool(dt.loc[1, "per_entry"] <= dt.loc[0, "per_entry"] + dt.loc[0, "se"])),
        dict(name="d2 clock +1 s: PnL does not rise", expected="per entry <= as run + 1 SE", reading=f"{dt.loc[2, 'per_entry'] - dt.loc[0, 'per_entry']:+.3f} USD", passed=bool(dt.loc[2, "per_entry"] <= dt.loc[0, "per_entry"] + dt.loc[0, "se"])),
    ]
    return rows, dict(base=base, leak=leak, back=back, fwd=fwd, t250=t250, t1000=t1000, decay=dt, shift=sv, shuffle=sh)


# ---------------------------------------------------------------- the detectors, broken once on purpose
def _synth(n=400, win=0.5, seed=3):
    rng = np.random.default_rng(seed)
    won = rng.random(n) < win
    vwap = rng.uniform(0.4, 0.7, n)
    sh = 20 / vwap
    fee = sh * 0.07 * vwap * (1 - vwap)
    return pd.DataFrame(dict(asset=rng.choice(["btc", "eth"], n), win_start_ms=np.arange(n) * 900_000, side=rng.choice([1, -1], n), shares=sh, vwap=vwap, fee_usd=fee,
                             won=won, pnl_gross=sh * won - 20, pnl_net=sh * won - 20 - fee))


def selftest() -> bool:
    ok = True

    def line(label, cond):
        nonlocal ok
        ok &= bool(cond)
        print(f"  {label:<62}{'RED (right)' if cond else 'STAYED GREEN (WRONG)'}")

    fair, rigged = _synth(win=0.5), _synth(win=0.98)
    line("a leaking set (98% wins) is flagged", leak_flag(rigged)["flagged"])
    line("an honest set (50% wins) is not flagged", not leak_flag(fair)["flagged"])
    line("a leak on 30 entries reads nothing", not leak_flag(rigged.head(30))["flagged"])
    sv = shift_verdicts(fair, _synth(win=0.5, seed=4), _synth(win=0.5, seed=5))
    line("a future feature set with no gain fails b2", not sv["fwd_ok"])
    sv2 = shift_verdicts(fair, _synth(win=0.2, seed=4), _synth(win=0.9, seed=5))
    line("a stale feature set that collapses fails b1", not sv2["back_ok"])
    line("a future set that gains passes b2", sv2["fwd_ok"])
    win = pd.DataFrame(dict(asset=["btc"] * 400 + ["eth"] * 400, outcome_up=np.r_[np.ones(400, bool) * (np.arange(400) % 2 == 0), np.ones(400, bool) * (np.arange(400) % 2 == 0)]))
    sh = shuffle_test(fair, win)
    line("a shuffle of fair entries sits on its analytic value", sh["ok"])
    shr = shuffle_test(rigged, win)
    line("a shuffle removes the edge of a rigged set (PnL falls by >= 5 USD)", per_entry(rigged)[0] - shr["pnl"] >= 5.0)
    return ok


if __name__ == "__main__":
    import sys
    sys.exit(0 if selftest() else 1)
