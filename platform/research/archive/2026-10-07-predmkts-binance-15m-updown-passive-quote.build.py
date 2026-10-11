"""ARCHIVED 2026-10-11 to research/archive/ on the owner's word; the notebook was last built and committed at 8e2eef9f; never rebuild it.
It re-runs only from `studies/` (the modules it imports live there): copy it back first; no sys.path line.

Build and execute `2026-10-07-predmkts-binance-15m-updown-passive-quote.ipynb` (B-0654, candidate 4 of the strategy search, registered as um-008): rest a bid where the Binance fair value
is above it and cancel when Binance moves against it. The words are in SPEC; every number is computed by the cells from the decision tables and the print tape (`tf15_*.py`).

Run from `platform/research/studies` with the fund venv:
    ../../../.venv/Scripts/python 2026-10-07-predmkts-binance-15m-updown-passive-quote.build.py
"""
import sys

import tf15_nb as NB

SPEC = dict(
    STEM="2026-10-07-predmkts-binance-15m-updown-passive-quote",
    RUN_ID="um-008",
    EXTRA={"earlier week": ("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"), "fresh day": ("2026-10-07",)},
    MODULE="tf15_cands", CLASS="PassiveBinance", CAND_ID="c4-passive-binance", N_TRIALS=24,
    TITLE="Can a resting bid, cancelled on Binance, make money on 15-minute Up/Down?",
    QUESTION="Does resting a limit bid on the Up or the Down token where the Binance fair value is above it by a margin, and cancelling it when Binance moves against the quote, earn a positive net PnL per fill (maker rebate, no fee, back of the queue, fills only from printed trades) on Polymarket's 15-minute crypto Up/Down markets?",
    QUESTION_ONE="Does a resting bid cancelled on Binance moves earn a positive net PnL per fill on 15-minute Up/Down, filled only by printed trades?",
    IDEA="Every taker strategy here pays the half spread, the fee and the delay and meets a book that has already moved. A resting order pays none of them and earns a rebate of 20% of the taker fee, but it fills when someone trades into it, which is when the price is moving against it. Binance tells the maker when to pull the quote. The simulation is conservative: the order joins the back of the queue, only printed trades fill it, and the cancel takes 150 ms to land, so trades inside that gap still hit it.",
    TRADE="every 5 seconds, per side, if no order is resting and the side's fair value is above the bid it would take by the post margin, rest a USD 20 bid at the touch (or a cent inside it); cancel at the first Binance event that takes the fair value below the bid plus the cancel margin, or after the lifetime; a fill is held to expiry; at most one fill per side per window",
    TRADE_SHORT="Rest a bid where Binance says it is cheap, cancel on Binance",
    S3_Q="Does any registered resting cell earn on both the train and the validation days, and does the one chosen earn on the test days?",
    S3_NOTE="24 cells: join the touch or jump a cent x post margin 0, 2 or 4 cents x cancel margin 0 or 3 cents x lifetime 30 or 120 s; prices 20 to 80 cents only. The placebo is the same rule with the fair value fixed at 0.5 (no Binance information); the planted peek knows the outcome.",
    WHY_TEXT="A resting order's edge is small per fill; two days of fills cannot separate it from zero unless the rule is clearly better than the blind quote.",
    NEXT_BET="the same rule on more days (the platform pins one day per job hour) and a measured fill model from the live book recorder",
    STRATEGY_NAME="Binance-cancelled passive bids on 15m Up/Down", THESIS_SHORT="a resting bid earns the rebate and the spread when Binance keeps it away from informed flow", STYLE="market making",
    falsifier=["the chosen cell's net per fill on the test days is zero or below, or its 95% interval over 15-minute slots includes zero",
               "the cell does not beat the same rule with no Binance information (the blind quote), or the planted peek is not caught",
               "net per fill is not above zero with the post and cancel latencies at 150 and 250 ms, or not above zero with no rebate",
               "the cell is not above zero on both test days, or not positive on the train days as well as the validation days"],
    prior=[("venue fact `fee.category_rates` [1]", "Crypto markets: taker 0.07, maker 0, maker rebate 20% of taker fees", "The only structural reason a resting order beats a taker here"),
           ("Budish, Cramton and Shim 2015, QJE 130(4)", "In continuous books speed decides who takes a public-information rent: slow resting orders are picked off", "The cancel latency is swept; the venue's 150 ms taker delay is what gives a maker time"),
           ("`binance-price-signal-15m-updown` (um-004)", "The Up mid follows a Binance burst in 300 to 500 ms", "A resting order that is cancelled inside that lag avoids the move; one that is not is the adverse selection the placebo isolates")],
)

if __name__ == "__main__":
    sys.exit(NB.build(SPEC))
