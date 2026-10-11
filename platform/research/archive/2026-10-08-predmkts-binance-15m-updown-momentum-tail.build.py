"""ARCHIVED 2026-10-11 to research/archive/ on the owner's word; the notebook was last built and committed at fd1221a8; never rebuild it.
It re-runs only from `studies/` (the modules it imports live there): copy it back first; no sys.path line.

Build and execute `2026-10-08-predmkts-binance-15m-updown-momentum-tail.ipynb` (the owner's momentum hypothesis, registered as um-009): buy the far tail a Binance
momentum burst left behind, only while its ask is not worse than the driftless Brownian fair value. The words are in SPEC; every number is computed by the cells
from the decision tables (`tf15_*.py`).

Run from `platform/research/studies` with the fund venv:
    ../../../.venv/Scripts/python 2026-10-08-predmkts-binance-15m-updown-momentum-tail.build.py
"""
import sys

import tf15_nb as NB

SPEC = dict(
    STEM="2026-10-08-predmkts-binance-15m-updown-momentum-tail",
    RUN_ID="um-010",
    EXTRA={"earlier week": ("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"), "fresh day": ("2026-10-07",)},
    MODULE="tf15_cands", CLASS="MomentumTail", CAND_ID="c5-momentum-tail", N_TRIALS=144,
    TITLE="Does a Binance momentum burst leave the far tail underpriced, and can it be farmed?",
    QUESTION="Does buying the tail opposite a Binance momentum burst (a short-lookback z above a threshold), only while its ask is not worse than the driftless Brownian fair value, earn a positive net PnL per entry after the fee and the 150 ms delay on Polymarket's 15-minute crypto Up/Down markets?",
    QUESTION_ONE="Does fading a Binance momentum burst into the far tail earn a positive net PnL per entry after the fee and a 150 ms delay?",
    IDEA="The owner's idea: a fast move (a 2-sigma burst) over-shoots the book, and the tail it leaves on the other end is where the cheap convexity is. The Brownian fair value is driftless and holds no momentum term, so it is the honest 'no-momentum' price a burst is measured against. The rule waits for a short-lookback z of at least a threshold, then buys the far tail, and refuses to pay more than the fair value for it. A token asking 4 cents pays 25 times if right; the fee there is under a third of a cent, so the cost of the bet is mostly the price. A burst can cut either way, so the trade is one rule on both sides.",
    TRADE="every second from the cell's first decision to 5 s before the end, if the L-second Binance z crosses the threshold in either direction, buy USD 20 of the far tail (the token the burst left behind) 150 ms later at no worse than the ask seen at the decision, only while its ask is at most the Brownian fair value (plus the cell's buffer) and under the cell's tail ceiling; hold to expiry; one entry per window",
    TRADE_SHORT="Buy the far tail a Binance burst left behind, at no worse than fair value",
    S3_Q="Does any registered momentum cell earn on both the train and the validation days, and does the one chosen earn on the test days?",
    S3_NOTE="144 cells: burst lookback 10 or 30 s x |z| 1.5, 2, 2.5 or 3 x fair-value gate off, literal or a 2-cent buffer x tail ceiling any, 10 or 5 cents x at least 60 or 300 s left.",
    WHY_TEXT="A tail pays rarely, so a few hundred entries cannot tell a mispriced tail from luck: read the interval, not the point.",
    NEXT_BET="the same fade in the last minutes where the Binance average is nearly fixed, or a resting-bid version that earns the rebate instead of the taker fee",
    STRATEGY_NAME="Momentum-faded tail buying on 15m Up/Down", THESIS_SHORT="a short-lookback Binance burst over-shoots the far tail, which the driftless fair value still marks cheap", STYLE="mean reversion",
    falsifier=["the chosen cell's net per entry on the test days is zero or below, or its 95% interval over 15-minute slots includes zero",
               "the cell does not beat the same instants with random sides (placebo, 95th percentile), or the planted peek is not caught",
               "net per entry is not above zero at 150 ms and at 250 ms, or not above zero at twice the fee",
               "the cell is not above zero on both test days, or not positive on the train days as well as the validation days"],
    prior=[("um-005, the tail-buy cell of this search (2026-10-07)", "The far tail bought unconditionally earns nothing after the fee; the ratio gate on the driftless fair value could not beat a coin flip on the registered test days", "The null this candidate must beat: an unconditional tail buy is fair, and the momentum trigger is the new information"),
           ("um-004, the price-signal study (B-0649)", "The Up mid follows a Binance burst in 300 to 500 ms, so the book reprices a burst fast", "A fade has to be quicker than the book, or the far tail must mean-revert past the burst"),
           ("the 15-minute study (B-0642)", "The driftless Brownian TWAP fair value reproduces the recorded outcome in 99.2% of 1,140 windows", "The fair value is driftless by construction: it is the honest no-momentum price the burst is measured against")],
)

if __name__ == "__main__":
    sys.exit(NB.build(SPEC))
