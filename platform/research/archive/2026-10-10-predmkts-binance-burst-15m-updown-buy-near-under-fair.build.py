"""ARCHIVED 2026-10-11 to research/archive/ on the owner's word; the notebook was last built and committed at 36fde812; never rebuild it.
It re-runs only from `studies/` (the modules it imports live there): copy it back first; no sys.path line.

Build and execute `2026-10-10-predmkts-binance-burst-15m-updown-buy-near-under-fair.ipynb` (um-022; um-014 and um-016 were the earlier runs on this stem, on
22 days): the search for the buy-near rule's own settings on EVERY seated day, the owner's word of 2026-10-11 (all analysis on the maximum, 38 days). The
rule: buy the near token a Binance burst left under-priced against the driftless fair value. The grid is um-014's: the burst lookback (10 or 30 s), the z
threshold (2.5, 3, 4), the margin under fair (3, 5, 8 cents), a price band on the ask (any; 0.30 to 0.80; 0.50 to 0.70; 0.40 to 0.85; 0.50 to 0.90),
the time left (120, 300, 600 s) and the exit (hold to expiry, or sell at the bid after 120 or 300 s), 810 cells, read at 250 ms, chosen by the net an
entry WITHOUT the best 5% of entries, on train 09-02 to 09-22, validate 09-23 to 10-02 and test 10-03 to 10-09 in date order; the forward days from
10-10 for the record as they seat. The layered filters and exits of um-016 are not re-run: um-018 reproduced their lessons on these 38 days (every
exit worth less than holding, no signal family earning on both windows). The words are in SPEC; every number is computed by the cells from the decision
tables (`tf15_*.py`); the deep-dive cells are `tf15_deep.py`.

Run from `platform/research/studies` with the fund venv:
    ../../../.venv/Scripts/python 2026-10-10-predmkts-binance-burst-15m-updown-buy-near-under-fair.build.py
"""
import sys

import tf15_deep as DEEP
import tf15_nb as NB

SPEC = dict(
    STEM="2026-10-10-predmkts-binance-burst-15m-updown-buy-near-under-fair",
    RUN_ID="um-022",
    TRAIN=tuple(f"2026-09-{d:02d}" for d in range(2, 23)),
    VALIDATE=("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"),
    TEST=("2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"),
    EXTRA={"forward days": tuple(f"2026-10-{d:02d}" for d in range(10, 32))},
    MODULE="tf15_cands", CLASS="BuyNearDeep", CAND_ID="c7-buy-near-deep", N_TRIALS=810, OWN_MS=100, DPI=80,
    SCORE='(lambda s_: s_.get("per_ex_top5", -1e9))', GRID_LOG="quiet",
    DEEP=DEEP.cells("near"), EXTRA_FIG_KINDS=repr(DEEP.FIG_KINDS), CORE_EXTRA='("G13",)',
    DIMS='("L", "z_min", "theta", "band", "t_min", "exit")',
    TITLE="On every seated day, which setting of buying the near token a Binance burst left under-priced earns without a few wins carrying it?",
    QUESTION="Does buying the near token of a Polymarket 15-minute Up/Down market after a Binance burst, only when its ask sits under the driftless fair value by a margin, with a price band on the ask, a minimum time left and an exit chosen on the train (09-02 to 09-22) and validation (09-23 to 10-02) days by the net an entry without the best 5%, earn a positive net PnL an entry on the test days 10-03 to 10-09 at a 250 ms delay, with its 95% slot interval above zero and its net above zero once its best 5% of entries are taken out?",
    QUESTION_ONE="On 38 days, does a setting of the buy-near rule chosen on the train and validation days earn on the test days without its best 5% of entries?",
    IDEA="um-014 (2026-10-10) searched these 810 settings on 22 days (train 09-16 to 09-28, validate 09-29 to 10-02, test 10-03 to 10-07) and chose L10|z4|th0.08|px40-85|T120|expiry: +1.49 USD an entry on 157 test entries, +0.54 without its best 5%, every robustness gate passed but the interval spanned zero and the deflated Sharpe was zero. Since then 16 more days seated (09-02 to 09-15, 10-08 and 10-09), and the owner's word (2026-10-11) is that every analysis runs on all 38. This run is the same grid on the 38-day split: 21 train days, 10 validation days, 7 test days, read at 250 ms (the venue's 150 ms hold plus 100 ms of our own, assumed), chosen by the net an entry WITHOUT the best 5% of entries so a cell that lives on tail wins cannot be chosen. um-016's filters and exits are not re-run here: um-018 read them on these 38 days (every exit worth less than holding, no signal family earning on both windows), and the seven-test notebook reads the non-momentum signals as fixed rules. The test days were inside um-011's whole-window read and um-021's seven fixed rules, so the cell choice, not the idea, is what is out of sample; the forward days from 10-10 are the clean read.",
    TRADE="every second from the cell's first decision to 5 s before the end, if the L-second Binance z crosses the threshold in either direction and the near token's ask sits more than theta under the driftless fair value and inside the cell's price band, buy USD 20 of the near token 250 ms later at no worse than the ask seen at the decision; hold to expiry, or sell into the bid ladder after the cell's hold; one entry per window",
    TRADE_SHORT="Buy the near token a burst left under fair value, in a price band, with an exit",
    S3_Q="On 38 days, does any registered cell earn without its best 5% of entries on both the train and the validation days, and does the one chosen earn on the test days?",
    S3_NOTE="810 cells: burst lookback 10 or 30 s x |z| 2.5, 3 or 4 x margin under fair 3, 5 or 8 cents x ask band any, 0.30-0.80, 0.50-0.70, 0.40-0.85 or 0.50-0.90 x at least 120, 300 or 600 s left x exit at expiry, 120 s or 300 s. Read at 250 ms on 38 days. The choice reads the net an entry without the best 5% of entries.",
    WHY_TEXT="A rule whose money sits in a few cheap-token wins is a lottery ticket until a setting earns without them: read the gate that takes the best 5% out, then the interval; with 38 days the validation window is ten days, not four.",
    NEXT_BET="the chosen cell read once on the forward days as they seat (10-10 onward), beside um-017, um-019 and um-020; then a paper run of its live form against the venue, measuring our tick-to-trade in place of the assumed 100 ms",
    STRATEGY_NAME="Buy the under-priced near token after a Binance burst, 15m Up/Down, 38 days", THESIS_SHORT="a Binance burst persists and the Polymarket book has not re-priced it: the near token's ask sits under the driftless fair value", STYLE="momentum",
    falsifier=["the chosen cell's net per entry on the test days is zero or below, or its 95% interval over 15-minute slots includes zero",
               "the chosen cell's net per entry on the test days is zero or below once its best 5% of entries are taken out (a few wins carry it)",
               "the cell does not beat the same instants with random sides (placebo, 95th percentile), or the planted peek is not caught",
               "net per entry is not above zero at 150 ms and at 250 ms, or not above zero at twice the fee",
               "the cell is not above zero on every test day, or not positive on the train days as well as the validation days"],
    prior=[("um-014, the same grid on 22 days (2026-10-10)", "Of 810 settings, L10|z4|th0.08|px40-85|T120|expiry earned +1.49 an entry on 157 test entries and +0.54 without its best 5%, 5 of 5 days, placebo beaten; the interval spanned zero and the deflated Sharpe was 0.00", "The 22-day choice; this run asks whether 38 days pick the same cell and whether it holds"),
           ("the base cell by coin and by week on 38 days (lab/research/data/buy-near-by-coin-read-2026-10-10.md, buy-near-by-week-read-2026-10-11.md)", "All coins +1.25 an entry on 814 (30 of 38 days above zero); the edge is time-varying week to week, flat only in 09-16 to 09-22", "The week um-014 trained on was the flat one; a 21-day train window spans two regimes of the rule"),
           ("um-016 and um-018, the layered and the combo grids (2026-10-10)", "Every exit is worth less than holding through the real ladder; no filter or signal family earns on both design windows", "The grid keeps its three exits as cells but nothing else is layered; the seven-test notebook reads the non-momentum signals as fixed rules")],
)

if __name__ == "__main__":
    sys.exit(NB.build(SPEC))
