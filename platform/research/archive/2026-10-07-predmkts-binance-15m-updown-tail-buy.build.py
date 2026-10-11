"""ARCHIVED 2026-10-11 to research/archive/ on the owner's word; the notebook was last built and committed at 8e2eef9f; never rebuild it.
It re-runs only from `studies/` (the modules it imports live there): copy it back first; no sys.path line.

Build and execute `2026-10-07-predmkts-binance-15m-updown-tail-buy.ipynb` (B-0654, candidate 1 of the strategy search, registered as um-005): buy the cheap tail of the 15-minute Up/Down
markets, alone or only when the Binance fair value says it is underpriced. The words are in SPEC; every number is computed by the cells from the decision tables (`tf15_*.py`).

Run from `platform/research/studies` with the fund venv:
    ../../../.venv/Scripts/python 2026-10-07-predmkts-binance-15m-updown-tail-buy.build.py
"""
import sys

import tf15_nb as NB

SPEC = dict(
    STEM="2026-10-07-predmkts-binance-15m-updown-tail-buy",
    RUN_ID="um-005",
    EXTRA={"earlier week": ("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"), "fresh day": ("2026-10-07",)},
    MODULE="tf15_cands", CLASS="TailBuy", CAND_ID="c1-tail-buy", N_TRIALS=18,
    TITLE="Is the cheap tail of 15-minute Up/Down markets underpriced, and can it be farmed?",
    QUESTION="Does buying the token that asks at most a few cents, on its own or only when a Binance-driven fair value rates it above its ask by a ratio, earn a positive net PnL per entry after the fee and the 150 ms delay on Polymarket's 15-minute crypto Up/Down markets?",
    QUESTION_ONE="Does buying a 15-minute Up/Down token that asks a few cents earn a positive net PnL per entry after the fee and a 150 ms delay?",
    IDEA="The owner's example: the deep out-of-the-money contracts (price near 0) are where long shots may be underpriced and where convexity is cheap. A token asking 4 cents pays 25 times if right. The fee is 0.07 x p x (1 - p), under a third of a cent there, so the cost of the bet is mostly the price. The candidate buys the tail on any side, alone or only when the Brownian fair value is at least a ratio above the ask; the other side of the same idea (selling the near-certainty) is buying the opposite tail, so both are one rule here.",
    TRADE="every second from the cell's first decision to 5 s before the end, if a token asks between 1 cent and a_max (and, for a ratio cell, its fair value is at least the ratio times the ask), buy USD 20 of it 150 ms later at no worse than the ask seen at the decision; hold to expiry; one entry per window",
    TRADE_SHORT="Buy a token asking a few cents, hold to expiry",
    S3_Q="Does any registered tail cell earn on both the train and the validation days, and does the one chosen earn on the test days?",
    S3_NOTE="18 cells: ask ceiling 3, 6 or 10 cents x no model, or fair value at least 1.5 or 2.5 times the ask x first decision 60 s or 300 s into the window.",
    WHY_TEXT="A tail pays rarely, so a few hundred entries cannot tell a mispriced tail from luck: read the interval, not the point.",
    NEXT_BET="the same tails only in the last minutes where the Binance average is nearly fixed, or the resting-bid version (candidate 4)",
    STRATEGY_NAME="Cheap-tail buying on 15m Up/Down", THESIS_SHORT="long shots on 15-minute Up/Down markets are underpriced relative to a Binance-driven fair value", STYLE="contrarian",
    falsifier=["the chosen cell's net per entry on the test days is zero or below, or its 95% interval over 15-minute slots includes zero",
               "the cell does not beat the same instants with random sides (placebo, 95th percentile), or the planted peek is not caught",
               "net per entry is not above zero at 150 ms and at 250 ms, or not above zero at twice the fee",
               "the cell is not above zero on both test days, or not positive on the train days as well as the validation days"],
    prior=[("`2026-10-04-predmkts-yes-systematically-overpriced`", "On resolved prediction markets the YES token is priced above how often it pays from about 15% up; selling tails looked positive on thin markets only", "A calibration prior for tails; these are 15-minute crypto markets with a book that follows Binance"),
           ("arXiv 2609.12878 (read 2026-10-06 [1])", "On 588 million trades longshots lose 6.3 cents per dollar per contract; grouped by event the sign flips", "A per-contract tail table can carry the wrong sign: here the unit is a window, and both tokens of one market are never traded together"),
           ("this candidate's own calibration print (4 days, 2026-10-03 to 10-06, before the split was frozen)", "Asks of 1 to 6 cents were paid about their price in a pooled unconditional table; no rule or parameter comes from it", "A prior that an unconditional tail buy earns nothing after the fee")],
)

if __name__ == "__main__":
    sys.exit(NB.build(SPEC))
