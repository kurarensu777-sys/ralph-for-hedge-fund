"""ARCHIVED 2026-10-11 to research/archive/ on the owner's word; the notebook was last built and committed at 8e2eef9f; never rebuild it.
It re-runs only from `studies/` (the modules it imports live there): copy it back first; no sys.path line.

Build and execute `2026-10-07-predmkts-binance-15m-updown-edge-taker.ipynb` (B-0654, candidate 3 of the strategy search, registered as um-007): take the side a calibrated Binance fair value
likes by more than theta after the fee. The words are in SPEC; every number is computed by the cells from the decision tables (`tf15_*.py` beside it).

Run from `platform/research/studies` with the fund venv:
    ../../../.venv/Scripts/python 2026-10-07-predmkts-binance-15m-updown-edge-taker.build.py
"""
import sys

import tf15_nb as NB

SPEC = dict(
    STEM="2026-10-07-predmkts-binance-15m-updown-edge-taker",
    RUN_ID="um-007",
    EXTRA={"earlier week": ("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"), "fresh day": ("2026-10-07",)},
    MODULE="tf15_cands", CLASS="EdgeTaker", CAND_ID="c3-edge-taker", N_TRIALS=40,
    TITLE="Can a calibrated Binance fair value, traded as a taker, make money on 15-minute Up/Down?",
    QUESTION="Does buying the side that a Binance-driven fair value rates above its ask by more than a threshold, after the taker fee, the spread and the 150 ms delay, earn a positive net PnL per entry out of sample on Polymarket's 15-minute crypto Up/Down markets?",
    QUESTION_ONE="Does a calibrated Binance fair value, bought at the ask after the fee and a 150 ms delay, earn a positive net PnL per entry on 15-minute Up/Down?",
    IDEA="The market settles on a Chainlink 60-second average at both ends. From the Binance trade-implied mid, the start reference and the volatility, the probability that the end average is at or above the start is a closed form. When that probability beats the token's ask plus the fee by theta, buy it and hold to the resolution. This is the no-gate Brownian-edge rule that earned +1.51 USD an entry on 483 entries in the 15-minute study (one day carried most of it), made a registered grid with an isotonic calibration fitted on the train days only.",
    TRADE="every second after the first 5 and before the last 5, if a side's fair value minus ask minus fee exceeds theta, buy that side with a USD 20 clip 150 ms later (limit: the ask seen at the decision), hold to expiry; one entry per window",
    TRADE_SHORT="Buy the side whose fair value beats its ask by theta",
    S3_Q="Does a cell of the registered grid earn on both the train and the validation days, and does the one chosen earn on the test days?",
    S3_NOTE="40 cells: raw or isotonic-calibrated probability x theta (0.04 to 0.12) x first decision (10 s or 120 s into the window) x all four coins or BTC and ETH only.",
    WHY_TEXT="The fair value is a calibrated Brownian model; where it disagrees with the book by more than the fee the book is, on these days, mostly right.",
    NEXT_BET="a different information source for the same trade: cross-coin lead, or the resting-order version of the same fair value (candidate 4)",
    STRATEGY_NAME="Calibrated Binance fair-value taker on 15m Up/Down", THESIS_SHORT="a Binance-driven TWAP fair value beats the Polymarket ask by more than the fee at times", STYLE="fair value",
    falsifier=["the chosen cell's net per entry on the test days is zero or below, or its 95% interval over 15-minute slots includes zero",
               "the cell does not beat the same instants with random sides (placebo, 95th percentile), or the planted peek is not caught",
               "net per entry is not above zero at 150 ms and at 250 ms, or not above zero at twice the fee",
               "the cell is not above zero on both test days, or not positive on the train days as well as the validation days"],
    prior=[("`um-003` (this fund, 2026-10-07)", "The no-gate Brownian-edge baseline earned +0.96 an entry on 624 validation entries and +1.51 on 483 test entries, interval -0.36 to +3.38, mostly one day", "The lead this candidate tests properly: registered grid, calibration on train only, placebo, delay and cost sweeps"),
           ("Young 2026, arXiv 2607.26245", "A 43-feature Binance logistic model did not beat Polymarket's own book on BTC 15-minute markets; quotes followed large Binance moves by a median 347 ms", "The strongest prior against: expect the book to be right except inside the delay"),
           ("`binance-price-signal-15m-updown` (B-0649, um-004)", "The Up mid follows a Binance burst in 300 to 500 ms; the best registered rule earned +0.91 an entry, interval -2.24 to +4.05", "An order at 150 ms meets the book before most of the move: any fair-value edge must be bigger than that lag")],
)

if __name__ == "__main__":
    sys.exit(NB.build(SPEC))
