"""ARCHIVED 2026-10-11 to research/archive/ on the owner's word; the notebook was last built and committed at 3bdbe023; never rebuild it.
It re-runs only from `studies/` (the modules it imports live there): copy it back first; no sys.path line.

Build and execute `2026-10-10-predmkts-binance-burst-15m-updown-buy-near-steady.ipynb` (um-020): the steady-climb variants of the buy-near rule. um-014,
um-016 and um-018 found that the rule (buy the near token a Binance burst left under the driftless fair value, held to expiry) is positive out of sample
but lumpy, that every exit is worth less than holding, and that layered signals do not survive the choice. The owner's criterion (2026-10-10): a PnL that
climbs steadily, not in jumps. This run keeps only the logical variants (the coin, the near ask band, one order a slot across the coins, the burst
threshold, the margin, the time left), 96 cells, one order per onset, held to expiry, read at 250 ms, and chooses by the shape of the climb: the daily
Sharpe on the validation days among cells above zero without their best 5% on both windows. Train 09-02 to 09-22, validate 09-23 to 10-02, test 10-03
to 10-09 read once; the forward days from 10-10 for the record as they seat. The words are in SPEC; every number is computed by the cells from the
decision tables (`tf15_*.py`); the deep-dive cells are `tf15_deep.py`.

Run from `platform/research/studies` with the fund venv:
    ../../../.venv/Scripts/python 2026-10-10-predmkts-binance-burst-15m-updown-buy-near-steady.build.py
"""
import sys

import tf15_deep as DEEP
import tf15_nb as NB

SPEC = dict(
    STEM="2026-10-10-predmkts-binance-burst-15m-updown-buy-near-steady",
    RUN_ID="um-020",
    TRAIN=tuple(f"2026-09-{d:02d}" for d in range(2, 23)),
    VALIDATE=("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"),
    TEST=("2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"),
    EXTRA={"forward days": tuple(f"2026-10-{d:02d}" for d in range(10, 32))},
    MODULE="tf15_cands", CLASS="BuyNearSteady", CAND_ID="c13-buy-near-steady", N_TRIALS=96, OWN_MS=100, DPI=80,
    SCORE="(lambda s_: CANDS.steady_score(s_))", GRID_LOG="quiet",
    DEEP=DEEP.cells_steady(), EXTRA_FIG_KINDS=repr(DEEP.FIG_KINDS_STEADY), CORE_EXTRA='("G13", "G15", "G16")',
    DIMS='("coin", "band", "slot", "z_min", "theta", "t_min")',
    TITLE="Which variant of buying the near token a Binance burst left under fair value climbs steadily: the coin, the price band, one order a slot, the burst, the margin, the time left?",
    QUESTION="Among the logical variants of the buy-near rule (all coins or Bitcoin; the near ask between 0.40 and 0.85, 0.60 and 0.85 or 0.70 and 0.90; one order a 15-minute slot across the coins or not; a 10 s burst of |z| at least 3 or 4; the ask 4 or 8 cents under the driftless fair value; at least 120 or 300 s left), held to expiry with one order per onset at a 250 ms delay, does the one with the steadiest climb on the validation days (the daily Sharpe, among cells above zero without their best 5% on both windows) earn a positive net PnL an entry on the test days with its 95% slot interval above zero, its net above zero without its best 5%, an equity line that fits a straight line, and a live replay that reproduces it?",
    QUESTION_ONE="Does the steadiest variant of the buy-near rule on the validation days climb steadily and earn on the test days, and does its live form reproduce it?",
    IDEA="Three grids on this rule (um-014, um-016, um-018) agree on three things: the rule is positive out of sample on 38 days (+1.25 USD an entry on 814, 30 of 38 days above zero, +0.33 without its best 5%), every exit is worth less than holding through the real ladder, and no layered signal survives a choice among hundreds of cells. What they also show is a lumpy climb: the money comes in days of many clustered bursts, the four coins burst together, and cheap entries pay large wins. The owner's criterion is a steady climb. The levers that change the shape without changing the idea are few: Bitcoin alone (the deepest book; +1.37 an entry out of sample against +0.14 for ETH and zero for SOL), a higher and narrower price band (smaller, more frequent wins), one order a slot across the coins (the four coins' bursts are one event), and the burst threshold, the margin and the time left that set how selective the rule is. 96 cells, chosen by the daily Sharpe on the validation days among cells above zero without their best 5% on both windows; a steadiness gate on the test days (the equity line's fit, the share of days above zero, the best 5%'s share of the net); the chosen cell replayed through its live form.",
    TRADE="every second from the first decision to 5 s before the end, if the 10 s Binance z crosses the cell's threshold in either direction, the near token's ask sits more than the cell's margin under the driftless fair value and inside the cell's band, at least the cell's seconds are left, and the cell's coin and slot rules allow it, send one order of USD 20 for the near token at the onset of the condition, filled 250 ms later at no worse than the ask seen, a miss not chased; hold to expiry; one position a window",
    TRADE_SHORT="Buy the near token a burst left under fair value, the steady variants, held to expiry",
    S3_Q="Does any of the 96 variants climb steadily on both the train and the validation days, and does the one chosen earn on the test days?",
    S3_NOTE="96 cells: coin all or btc x near ask band 0.40-0.85, 0.60-0.85 or 0.70-0.90 x one order a slot across the coins or not x |z| 3 or 4 x margin 4 or 8 cents x at least 120 or 300 s left; held to expiry, one order per onset, 250 ms. The choice reads the daily Sharpe on the validation days among cells above zero without their best 5% on both windows.",
    WHY_TEXT="A steady climb is the owner's bar: the equity line should hug a straight line, most days should end above zero, and the net should not sit in a handful of entries; a variant that passes that on days it never saw is the one to paper-trade.",
    NEXT_BET="the chosen cell read once on the forward days as they seat (10-10 onward), beside um-017's Bitcoin cell and um-019's leaders; then a paper run of its live form against the venue",
    STRATEGY_NAME="Buy the under-priced near token after a Binance burst, 15m Up/Down, the steady variant", THESIS_SHORT="a Binance burst persists and the Polymarket book has not re-priced it: the near token's ask sits under the driftless fair value; the steady form trades the deepest book, a narrow band and one order a slot", STYLE="momentum",
    falsifier=["the chosen cell's net per entry on the test days is zero or below, or its 95% interval over 15-minute slots includes zero",
               "the chosen cell's net per entry on the test days is zero or below once its best 5% of entries are taken out (a few wins carry it)",
               "the chosen cell's climb on the test days is not steady: the equity line's r2 under 0.5, fewer than 60% of trading days above zero, or the best 5% of entries holding over 40% of the net",
               "the live second-by-second replay of the chosen cell does not reproduce the vectorized engine's entries and net on the test days",
               "the cell does not beat the same instants with random sides (placebo, 95th percentile), or the planted peek is not caught",
               "net per entry is not above zero at 150 ms and at 250 ms, or not above zero at twice the fee"],
    prior=[("the base cell by coin on 38 days (lab/research/data/buy-near-by-coin-read-2026-10-10.md)", "All coins +1.25 an entry on 814 (30 of 38 days above zero, +0.33 without the best 5%); Bitcoin +1.37 on 505, ETH +0.84, SOL +0.96, XRP +1.91 on 57; out of sample Bitcoin +1.37 on 333 and +0.40 without its best 5%, ETH +0.14, SOL zero", "The coin cut was read after the fact, so it is a dimension of this grid, not a result; Bitcoin is the deepest book"),
           ("um-016 and um-018, the layered and the combo grids (2026-10-10)", "Every exit is worth less than holding through the real ladder; no filter or signal family earns on both design windows; thin validation windows pick noise", "Hold to expiry, no exits; a small grid of logical variants; a choice by the shape of the climb instead of the level"),
           ("um-011, the three buy-near tests (2026-10-09, cut 2026-10-10)", "The burst alone and the gate alone both lose; the rule is their conjunction", "The entry condition is kept whole in every cell")],
)

if __name__ == "__main__":
    sys.exit(NB.build(SPEC))
