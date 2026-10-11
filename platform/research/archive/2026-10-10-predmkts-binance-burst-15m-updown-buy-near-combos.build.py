"""ARCHIVED 2026-10-11 to research/archive/ on the owner's word; the notebook was last built and committed at 580ea580; never rebuild it.
It re-runs only from `studies/` (the modules it imports live there): copy it back first; no sys.path line.

Build and execute `2026-10-10-predmkts-binance-burst-15m-updown-buy-near-combos.ipynb` (um-018): the search for alpha in the buy-near trade by crossing the
Binance burst (momentum) with one or two confirming signals of other families (a longer trend, the level, Binance flow, the book, the spread, the Polymarket
tape, the vol regime, RSI, the burst's first second, the time left, the hour), the fair-value gate off or on, every coin or Bitcoin alone, and seven exits
(take-profit, level stop, a stop on the bid, a reversal of the burst, the fair value turning, take-profit with the stop). 3,288 cells, read at 250 ms,
chosen by the net an entry WITHOUT the best 5% of entries, on 38 seated days in date order. The words are in SPEC; every number is computed by the cells
from the decision tables (`tf15_*.py`); the candidate is `tf15_cands.BuyNearCombo`.

Run from `platform/research/studies` with the fund venv:
    ../../../.venv/Scripts/python 2026-10-10-predmkts-binance-burst-15m-updown-buy-near-combos.build.py
"""
import datetime as dt
import sys

import tf15_deep as DEEP
import tf15_nb as NB


def days(a: str, n: int) -> tuple:
    d0 = dt.date.fromisoformat(a)
    return tuple((d0 + dt.timedelta(days=i)).isoformat() for i in range(n))


SPEC = dict(
    STEM="2026-10-10-predmkts-binance-burst-15m-updown-buy-near-combos",
    RUN_ID="um-018",
    TRAIN=days("2026-09-02", 19),                                    # 09-02 .. 09-20
    VALIDATE=days("2026-09-21", 12),                                 # 09-21 .. 10-02
    TEST=days("2026-10-03", 7),                                      # 10-03 .. 10-09, read once for this grid (the base cell was read on them before)
    EXTRA={"forward days": days("2026-10-10", 21)},                  # read for the record as they seat; an unseated day is left out
    MODULE="tf15_cands", CLASS="BuyNearCombo", CAND_ID="c11-buy-near-combo", N_TRIALS=3288, OWN_MS=100, DPI=72,
    SCORE='(lambda s_: s_.get("per_ex_top5", -1e9))', GRID_LOG="quiet",
    DEEP=DEEP.cells_combo(), EXTRA_FIG_KINDS=repr(DEEP.FIG_KINDS), CORE_EXTRA='("G13",)',
    DIMS='("coin", "z_min", "gate", "exit")',
    TITLE="Which signals, added to the Binance burst, make buying the near token pay, and does any exit beat holding?",
    QUESTION="Crossing a 10 s Binance burst (|z| 3 or 4) with one or two confirming signals of different families (a 30 s or 60 s trend, the window's level, Binance trade intensity, the book's imbalance, the spread, the Polymarket tape, the vol regime, RSI, the burst's first second, the time left, the UTC hour), with the fair-value gate off, at 4 cents or at 8 cents, on every coin or on Bitcoin alone, and with seven exits on the rules of at most one signal: does the cell chosen on 31 train and validation days by its net an entry without the best 5% earn on the 7 test days at a 250 ms delay, with its 95% slot interval above zero and its net above zero without its best 5%?",
    QUESTION_ONE="Does any burst-plus-signal rule, with or without an exit, chosen without its best 5% of entries, earn on the test days?",
    IDEA="Four runs (um-011, um-014, um-016, um-017's design read) found the buy-near trade's point estimate above zero and its edge in a few wins on every coin pooled; um-016 tried filters one family at a time on um-014's cell and found none that held on both train and validation, with 4 validation days. Since then B-0684 seated 16 more days, so this grid has 19 train days and 12 validation days. The owner's ask (2026-10-10): explore many other signals, enter only when momentum and another signal agree, try logical combinations, and try exits, stop losses and take-profits. So the burst is the core of every cell, and each cell adds one or two confirming conditions from different families, the fair-value gate at three settings (off is the momentum-only form), two coin sets and, for the simpler rules, seven exits.",
    TRADE="every second from the first decision to 5 s before the end, if the 10 s Binance z crosses the cell's threshold (3 or 4) in either direction, the near token's ask is between 0.40 and 0.85 (and under the driftless fair value by the cell's margin, when it has one), at least 120 s are left, and the cell's confirming signals hold, send one order for USD 20 of the near token, meeting the ladder 250 ms later at no worse than the ask seen at the decision; an order that does not fill is not sent again until the cell's condition has fallen and risen again (one order per signal onset, the owner's word 2026-10-10); hold to expiry, or leave on the cell's exit, sold into the bid ladder; one entry per window",
    TRADE_SHORT="Buy the near token on a burst confirmed by other signals, with exits",
    S3_Q="Does any of 3,288 burst-plus-signal cells earn without its best 5% on both the train and the validation days, and does the one chosen earn on the test days?",
    S3_NOTE="3,288 cells: coin set (all, btc) x burst |z| (3, 4) x fair gate (off, 4c, 8c) x confirming set (none, one of 17 signals, or two from different families: 130 pairs), held to expiry (1,776 entry rules); the 216 rules with at most one signal also with seven exits (tp90, tp95, lvl30, bid20, rev2, fair0, tp95+lvl30). Read at 250 ms, one order per onset of the cell's condition (a miss is not chased). The choice reads the net an entry without the best 5%: qualified on the train days, best on the validation days.",
    WHY_TEXT="With 3,288 cells the best validation number is mostly the luck of the draw: the deflated Sharpe charges for the count, the signal and exit tables say whether a family earns across many cells or only in one, and the test days are read once.",
    NEXT_BET="the chosen cell read once on the forward days 2026-10-10 to 10-30 (registered as its own run before any of them is seated); a signal family that earns on both train and validation across many cells is the lead even if the chosen cell fails",
    STRATEGY_NAME="Buy the near token on a Binance burst confirmed by other signals, 15m Up/Down", THESIS_SHORT="a Binance burst persists and the Polymarket book is slow to re-price; a second signal picks the bursts that keep going", STYLE="momentum",
    falsifier=["the chosen cell's net per entry on the test days is zero or below, or its 95% interval over 15-minute slots includes zero",
               "the chosen cell's net per entry on the test days is zero or below once its best 5% of entries are taken out (a few wins carry it)",
               "the cell does not beat the same instants with random sides (placebo, 95th percentile), or the planted peek is not caught",
               "net per entry is not above zero at 150 ms and at 250 ms, or not above zero at twice the fee",
               "the cell is not above zero on the train days as well as the validation days"],
    prior=[("um-016, the layered filters and exits (2026-10-10)", "584 cells on um-014's cell, one family at a time: no filter held on both train and validation (4 validation days); every exit through the real bid ladder was worth less than holding; the only levels positive on both were under 300 s left and a top-of-book imbalance with the burst", "Signals now combine in pairs on 12 validation days; the exits are tried again on the simpler rules"),
           ("the by-coin read on 38 days (2026-10-10, after the fact)", "um-014's cell: btc +1.37 an entry on 333 out-of-sample entries, +0.40 without its best 5%; eth and sol at or under zero", "Bitcoin alone is a dimension; its own forward read is um-017"),
           ("um-011, the three buy-near tests (2026-10-09)", "The burst alone and the fair gate alone both lost; together +0.40 an entry, carried by a few wins", "The gate is a dimension, off included, so the grid can find a second signal that does the gate's work"),
           ("um-012, the momentum re-score (2026-10-08)", "A momentum entry with no price gate is cost-bound: +0.83 before friction, -1.27 of friction", "Cells without the gate must earn back the fee and the spread")],
)

if __name__ == "__main__":
    sys.exit(NB.build(SPEC))
