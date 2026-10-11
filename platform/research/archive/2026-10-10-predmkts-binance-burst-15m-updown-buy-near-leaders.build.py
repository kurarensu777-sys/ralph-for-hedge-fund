"""ARCHIVED 2026-10-11 to research/archive/ on the owner's word (a forward read set aside); never built into a notebook, the generator last committed at 2d36fb18.
It re-runs only from `studies/` (the modules it imports live there): copy it back first; no sys.path line.

Build and execute `2026-10-10-predmkts-binance-burst-15m-updown-buy-near-leaders.ipynb` (um-019): um-018's chosen cell and its four two-signal leaders as
five fixed cells (`tf15_cands.BuyNearForward`), one order per signal onset, held to expiry, read once on the 21 forward days 2026-10-11 to 10-31 registered
before any of them was seated. Every day to 10-09 was read by um-018, so the train and validation days are design. The words are in SPEC; every number is
computed by the cells from the decision tables (`tf15_*.py`).

The test days must be seated first (`tf15_extend_days.py run --last N`); the build refuses an unseated day. Run from `platform/research/studies`:
    ../../../.venv/Scripts/python 2026-10-10-predmkts-binance-burst-15m-updown-buy-near-leaders.build.py
"""
import datetime as dt
import sys

import tf15_deep as DEEP
import tf15_nb as NB


def days(a: str, n: int) -> tuple:
    d0 = dt.date.fromisoformat(a)
    return tuple((d0 + dt.timedelta(days=i)).isoformat() for i in range(n))


SPEC = dict(
    STEM="2026-10-10-predmkts-binance-burst-15m-updown-buy-near-leaders",
    RUN_ID="um-019",
    TRAIN=days("2026-09-02", 19),                                    # 09-02 .. 09-20, um-018's train days
    VALIDATE=days("2026-09-21", 19),                                 # 09-21 .. 10-09: um-018's validation and test days, all read before
    TEST=days("2026-10-11", 21),                                     # 10-11 .. 10-31, registered before any was seated, read once
    EXTRA={"the day between": ("2026-10-10",)},
    MODULE="tf15_cands", CLASS="BuyNearForward", CAND_ID="c12-buy-near-forward", N_TRIALS=5, OWN_MS=100, DPI=72,
    SCORE='(lambda s_: s_.get("per_ex_top5", -1e9))', GRID_LOG="quiet",
    DEEP=DEEP.cells_btc(), EXTRA_FIG_KINDS=repr(DEEP.FIG_KINDS_BTC), CORE_EXTRA='("G13",)', DIMS='("coin", "gate")',
    TITLE="Do um-018's confirmed-burst rules pay on days nobody had seen: five fixed cells, one read on 21 forward days",
    QUESTION="Of um-018's chosen cell (Bitcoin, the first second of a 4-sigma burst with the 60 s z at least 2 the same way, the near ask 8 cents under fair) and its four two-signal leaders (Bitcoin 3-sigma with no gate, the level with the burst and a quiet tape; Bitcoin 4-sigma 8c under fair, 600 s or more left and not 05-11 UTC; all coins 3-sigma 8c under fair, a quiet tape and not 05-11 UTC; Bitcoin 3-sigma 4c under fair, RSI at most 80 and not 05-11 UTC), one order per signal onset, held to expiry: does the cell with the best validation score earn a positive net PnL an entry on the 21 forward days 2026-10-11 to 10-31 at 250 ms, with its 95% slot interval above zero and its net above zero without its best 5% of entries?",
    QUESTION_ONE="Does one of um-018's five leaders earn on 21 forward days, without its best 5% of entries?",
    IDEA="um-018 (2026-10-10) crossed the Binance burst with 17 confirming signals in 3,288 cells and found no family that earns on both train and validation when pooled, every exit worth less than holding, and a chosen cell at +2.64 an entry on 40 test entries that did not beat its placebo. Twenty two-signal rules were above zero on both windows with 30 or more entries each. Five cells are fixed here: the chosen one and the four best of those twenty by the lower of their two scores. Every day to 10-09 has been read for them, so the train and validation days are design; the forward days are the only test and the choice among five is priced by the deflated Sharpe.",
    TRADE="every second from the first decision to 5 s before the end, if the cell's burst threshold is crossed in either direction, the near token's ask is between 0.40 and 0.85 (and under the driftless fair value by the cell's margin, when it has one), at least 120 s are left and the cell's two confirming signals hold, send one order for USD 20 of the near token, meeting the ladder 250 ms later at no worse than the ask seen at the decision; a miss is not sent again until the condition has fallen and risen again; hold to expiry; one entry per window",
    TRADE_SHORT="Buy the near token on a confirmed burst, um-018's five leaders, held to expiry",
    S3_Q="Which of the five fixed cells has the best validation score, and does it earn on the forward days?",
    S3_NOTE="Five cells, fixed from um-018's record; the train and validation days are design (every one was read by um-018). The choice rule (qualified on train, best on validation, by the net an entry without the best 5%) picks one of five; the deflated Sharpe charges for the five.",
    WHY_TEXT="Every one of the five was found on the days before 10-10, so only the forward days say anything; the choice among five is small enough that a real edge would survive its deflation.",
    NEXT_BET="if it holds: a paper run of the live form against the venue on Bitcoin, measuring our tick-to-trade; if it fails: the confirmed-burst family joins the closed buy-near evidence (um-011, um-014, um-016, um-017, um-018)",
    STRATEGY_NAME="Buy the near token on a Binance burst confirmed by a second signal, 15m Up/Down", THESIS_SHORT="a Binance burst persists when a second signal agrees, and the Polymarket book is slow to re-price it", STYLE="momentum",
    falsifier=["the chosen cell's net per entry on the 21 forward days is zero or below, or its 95% interval over 15-minute slots includes zero",
               "the chosen cell's net per entry on the forward days is zero or below once its best 5% of entries are taken out (a few wins carry it)",
               "the cell does not beat the same instants with random sides (placebo, 95th percentile), or the planted peek is not caught",
               "net per entry is not above zero at 150 ms and at 250 ms, or not above zero at twice the fee",
               "the cell is not above zero on the train days as well as the validation days"],
    prior=[("um-018, the burst crossed with other signals (2026-10-10)", "3,288 cells: chosen btc|z4|fair08|z60+fresh +2.64 an entry on 40 test entries, +1.91 without its best 5%, placebo not beaten; no signal family earned on both windows pooled; every exit worth less than holding; twenty two-signal rules above zero on both windows", "The five cells, fixed; hold to expiry, no exit"),
           ("um-017, Bitcoin only (registered 2026-10-10)", "um-014's cell on Bitcoin reads once on 10-10 to 10-30; its design read was +1.37 an entry out of sample, +0.40 without its best 5%", "The sibling forward read; the two share no cell"),
           ("um-016, the layered filters and exits (2026-10-10)", "No filter held on both train and validation on 4 validation days; every exit through the real bid ladder was worth less than holding", "Why the cells here hold to expiry"),
           ("um-011, the three buy-near tests (2026-10-09)", "The burst alone and the fair gate alone both lost; together +0.40 an entry, carried by a few wins", "Two of the five cells have no gate: a second signal does the gate's work there")],
)

if __name__ == "__main__":
    sys.exit(NB.build(SPEC))
