"""ARCHIVED 2026-10-11 to research/archive/ on the owner's word; the notebook was last built and committed at 8e2eef9f; never rebuild it.
It re-runs only from `studies/` (the modules it imports live there): copy it back first; no sys.path line.

Build and execute `2026-10-07-predmkts-binance-15m-updown-near-certain.ipynb` (B-0654, candidate 2 of the strategy search, registered as um-006): buy the near-certain side of a 15-minute
Up/Down market when the Binance fair value clears its ask. The words are in SPEC; every number is computed by the cells from the decision tables (`tf15_*.py`).

Run from `platform/research/studies` with the fund venv:
    ../../../.venv/Scripts/python 2026-10-07-predmkts-binance-15m-updown-near-certain.build.py
"""
import sys

import tf15_nb as NB

SPEC = dict(
    STEM="2026-10-07-predmkts-binance-15m-updown-near-certain",
    RUN_ID="um-006",
    EXTRA={"earlier week": ("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"), "fresh day": ("2026-10-07",)},
    MODULE="tf15_cands", CLASS="NearCertain", CAND_ID="c2-near-certain", N_TRIALS=27,
    TITLE="Can the near-certain side of a 15-minute Up/Down market be harvested?",
    QUESTION="Does buying the token that asks 85 to 99.5 cents, only when the Binance fair value clears the ask plus the fee by a margin, earn a positive net PnL per entry after the fee and the 150 ms delay on Polymarket's 15-minute crypto Up/Down markets?",
    QUESTION_ONE="Does buying the near-certain 15-minute Up/Down token when Binance agrees earn a positive net PnL per entry after the fee and a 150 ms delay?",
    IDEA="The other end of tail farming: a token at 92 cents is nearly settled, and the contract resolves on a 60-second average that Binance mostly pins down in the last minutes. If the fair value is above the ask plus the fee by a margin, the few cents left are close to free. The fee at 92 cents is 0.5 cents a share, so the edge has to be a few cents. The risk is the one the book shows: a favourite that fails costs 92 cents for the 8 it could earn.",
    TRADE="every second from 10 s in to 5 s before the end, if a token asks at least a_lo (and at most 99.5 cents) and its fair value minus ask minus fee exceeds theta, with at most t_max seconds left, buy USD 20 of it 150 ms later at no worse than the ask seen at the decision; hold to expiry; one entry per window",
    TRADE_SHORT="Buy a token asking 85+ cents when Binance agrees",
    S3_Q="Does any registered favourite cell earn on both the train and the validation days, and does the one chosen earn on the test days?",
    S3_NOTE="27 cells: ask floor 85, 92 or 96 cents x margin 0, 2 or 4 cents x at most 120, 600 or 900 seconds left.",
    WHY_TEXT="A favourite wins most of the time by construction: the win rate means nothing without the price paid, which is why the break-even share is printed beside it.",
    NEXT_BET="a model that sees what the book sees in the last minutes (the Chainlink stream itself), or the resting-bid version (candidate 4)",
    STRATEGY_NAME="Near-certain side harvest on 15m Up/Down", THESIS_SHORT="a favourite asking 85 to 99 cents is underpriced when Binance pins the 60-second average", STYLE="carry",
    falsifier=["the chosen cell's net per entry on the test days is zero or below, or its 95% interval over 15-minute slots includes zero",
               "the cell does not beat the same instants with random sides (placebo, 95th percentile), or the planted peek is not caught",
               "net per entry is not above zero at 150 ms and at 250 ms, or not above zero at twice the fee",
               "the cell is not above zero on both test days, or not positive on the train days as well as the validation days"],
    prior=[("`buying-the-90c-side-the-record-before-the-study` (predmkts book, read 2026-10-06 [1])", "Closed positions of 26 leaderboard wallets bought at 90 to 94 cents earned +0.89% a position, 94 to 97 cents +2.47%, 97 to 99 cents +0.94%, 99 cents and up -0.21%; survivor-biased", "A prior that the harvest is thin and that the top of the book belongs to snipers"),
           ("the 15-minute study (read 2026-10-07)", "Trailing 60-second Binance means reproduce the recorded outcome in 99.2% of 1,140 windows", "The reference is knowable from Binance to within a basis point or two; the last minutes are nearly fixed"),
           ("this candidate's own pooled print (4 days, before the split was frozen)", "At 20 to 40 s left, favourites asking 90 to 99 cents with the fair value above 0.99 showed a small positive edge on about 130 windows; at 60 to 120 s the fair value was overconfident", "No rule or parameter comes from it; it is why the time-left ceiling is a grid dimension")],
)

if __name__ == "__main__":
    sys.exit(NB.build(SPEC))
