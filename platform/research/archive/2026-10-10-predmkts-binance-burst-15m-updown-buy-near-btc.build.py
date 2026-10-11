"""ARCHIVED 2026-10-11 to research/archive/ on the owner's word (a forward read set aside); never built into a notebook, the generator last committed at 9799b8e9.
It re-runs only from `studies/` (the modules it imports live there): copy it back first; no sys.path line.

Build and execute `2026-10-10-predmkts-binance-burst-15m-updown-buy-near-btc.ipynb` (um-017): um-014's buy-near cell, held to expiry, on BITCOIN windows
only, read once on the 21 forward days 2026-10-10 to 10-30 registered before any of them was seated. The coin cut was read after the fact on 38 days
(lab/research/data/buy-near-by-coin-read-2026-10-10.md), so the train and validation days here are design: one cell, nothing is chosen on them. The words
are in SPEC; every number is computed by the cells from the decision tables (`tf15_*.py`).

The test days must be seated first (`tf15_extend_days.py run --last N`); the build refuses an unseated day. Run from `platform/research/studies`:
    ../../../.venv/Scripts/python 2026-10-10-predmkts-binance-burst-15m-updown-buy-near-btc.build.py
"""
import datetime as dt
import sys

import tf15_deep as DEEP
import tf15_nb as NB


def days(a: str, n: int) -> tuple:
    d0 = dt.date.fromisoformat(a)
    return tuple((d0 + dt.timedelta(days=i)).isoformat() for i in range(n))


SPEC = dict(
    STEM="2026-10-10-predmkts-binance-burst-15m-updown-buy-near-btc",
    RUN_ID="um-017",
    TRAIN=days("2026-09-16", 13),                                    # 09-16 .. 09-28, um-014's train days
    VALIDATE=days("2026-09-29", 11),                                 # 09-29 .. 10-09: um-014's validation and test days and the two forward days B-0684 seated, all read before
    TEST=days("2026-10-10", 21),                                     # 10-10 .. 10-30, registered before any was seated, read once
    EXTRA={"earlier weeks": days("2026-09-02", 14)},
    MODULE="tf15_cands", CLASS="BuyNearBtc", CAND_ID="c10-buy-near-btc", N_TRIALS=1, OWN_MS=100, DPI=72,
    SCORE='(lambda s_: s_.get("per_ex_top5", -1e9))', GRID_LOG="quiet",
    DEEP=DEEP.cells_btc(), EXTRA_FIG_KINDS=repr(DEEP.FIG_KINDS_BTC), CORE_EXTRA='("G13",)', DIMS='()',
    TITLE="Does buying the under-priced near token after a Binance burst pay on Bitcoin alone, on days nobody had seen?",
    QUESTION="Does um-014's buy-near cell (a 10 s Binance burst of |z| at least 4, the near token's ask more than 8 cents under the driftless fair value and between 0.40 and 0.85, at least 120 s left, USD 20 at the ask 250 ms later, held to expiry), on Bitcoin windows only, earn a positive net PnL an entry on the 21 forward days 2026-10-10 to 10-30, with its 95% slot interval above zero and its net above zero without its best 5% of entries?",
    QUESTION_ONE="Does the buy-near cell on Bitcoin alone earn on 21 forward days, without its best 5% of entries?",
    IDEA="Three studies (um-011, um-014, um-016) found the buy-near trade positive on its point estimate and carried by a few wins on all coins pooled. Read by coin after the fact on all 38 seated days (2026-10-10), Bitcoin was 61% of entries and the only coin that earned without its best 5%: +1.37 an entry on 333 out-of-sample entries, +0.40 without the best 5%, and the same +1.37 on the in-sample days; eth and sol sat at or under zero out of sample. A split read after the fact is a selection among four coins, so this run tests it once, on days that did not exist when it was found. One cell, nothing chosen: the train and validation days are shown as design.",
    TRADE="every second from the first decision to 5 s before the end of a Bitcoin window, if the 10 s Binance z crosses 4 in either direction, the near token's ask sits more than 8 cents under the driftless fair value and between 0.40 and 0.85, and at least 120 s are left, buy USD 20 of the near token 250 ms later at no worse than the ask seen at the decision; hold to expiry; one entry per window",
    TRADE_SHORT="Buy the near token a burst left under fair value, Bitcoin only, held to expiry",
    S3_Q="Does the one registered cell earn on the forward days, and did it earn on the design days it was found on?",
    S3_NOTE="One cell, um-014's choice, on Bitcoin windows only, held to expiry, read at 250 ms. The train and validation days are design (the coin cut was found on them and on the days after); nothing is chosen on them. The choice rule's score (the net an entry without the best 5%) is printed but chooses nothing.",
    WHY_TEXT="A coin read after the fact out of four is a selection: the forward days are the only read that is not, so the decision reads them alone, once.",
    NEXT_BET="if it holds: a paper run of the live form on Bitcoin against the venue, measuring our tick-to-trade in place of the assumed 100 ms; if it fails: the buy-near trade is closed on the evidence of four runs",
    STRATEGY_NAME="Buy the under-priced near token after a Binance burst, 15m Up/Down, Bitcoin only", THESIS_SHORT="a Binance burst persists and the Polymarket Bitcoin book has not re-priced it: the near token's ask sits under the driftless fair value", STYLE="momentum",
    falsifier=["the cell's net per entry on the 21 forward days is zero or below, or its 95% interval over 15-minute slots includes zero",
               "the cell's net per entry on the forward days is zero or below once its best 5% of entries are taken out (a few wins carry it)",
               "the cell does not beat the same instants with random sides (placebo, 95th percentile), or the planted peek is not caught",
               "net per entry is not above zero at 150 ms and at 250 ms, or not above zero at twice the fee",
               "the cell is not above zero on the train days as well as the validation days"],
    prior=[("the by-coin read on 38 days (2026-10-10, after the fact)", "btc +1.37 an entry on 333 out-of-sample entries (95% by slot +0.06 to +2.56), +0.40 without its best 5%, 14 of 21 days; in sample +1.37 on 172; eth +0.14 and sol 0.00 out of sample", "The hypothesis; read after the fact, so it is design and the forward days are the test"),
           ("um-016, the layered filters and exits (2026-10-10)", "No filter held on both train and validation; every exit through the real bid ladder was worth less than holding; out of sample the level-stop choice made -0.46 and the late-entry lead -0.36", "Hold to expiry, no filter: the base cell"),
           ("um-014, the first grid on this stem (2026-10-10)", "L10|z4|th0.08|px40-85|T120|expiry chosen of 810 cells: +1.49 an entry on 157 test entries, +0.54 without its best 5%; on the 16 days B-0684 seated later +0.95 on 401, -0.02 without its best 5%", "The cell, unchanged"),
           ("um-015, the far-token sale (removed 2026-10-10)", "Selling the far token is the same near long with more collateral at risk, and needs a mint on chain that cannot run inside the 150 ms race", "The sale is not a second strategy; only the near buy is tested")],
)

if __name__ == "__main__":
    sys.exit(NB.build(SPEC))
