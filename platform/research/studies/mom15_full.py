"""The full-window variant of the directional momentum notebook (B-0679, run um-012): the generator of `mom15_nb` with the days of `mom15_study.PROTOCOLS["um-012"]` (a chronological split of
09-16..10-07) and the two sections that read days outside the split replaced by the frozen um-009 pair and the lookback ladder on every day; since 2026-10-10 (the owner's follow-up) also
the cells of `mom15_full_tweaks` (an entry-rule family in S5 and a raw-data rebuild gate in S2). Words and cells only; every number is computed
by the notebook from `mom15_*`. `patch(cells)` edits the cells of `mom15_nb.cells` in place and asserts that every edit found its text.
"""
from __future__ import annotations

import re

from nbformat.v4 import new_code_cell, new_markdown_cell

STEM = "2026-10-08-predmkts-binance-momentum-15m-updown-fullwindow"
RUN_ID = "um-012"


def _rep(cells, old, new, n=1):
    hits = sum(c.source.count(old) for c in cells)
    assert hits == n, f"expected {n} of {old[:70]!r}, found {hits}"
    for c in cells:
        c.source = c.source.replace(old, new)


def _swap(cells, anchor, source, kind="code", tags=()):
    ix = [i for i, c in enumerate(cells) if anchor in c.source]
    assert len(ix) == 1, f"{len(ix)} cells hold {anchor[:60]!r}"
    c = new_code_cell(source.strip("\n")) if kind == "code" else new_markdown_cell(source.strip("\n"))
    if tags:
        c.metadata["tags"] = list(tags)
    cells[ix[0]] = c


XR_MD = r'''
**Does the earlier finding hold? The pair um-009 froze, on every day.** Read after the test days, for the record, outside the decision rule. The pair um-009 chose (L 1 s, z 2.5, held to expiry) was chosen on days of the earlier study; here it is scored on all of the days, by week, so the first two weeks are a stretch it never saw. The registered test is the pair THIS study chose, read once on the last eight days.
'''

XR_CODE = r'''
# ---- AFTER the test read: the frozen um-009 pair on every day, by week (informational, outside the decision rule) ----
t0 = time.time()
XTAB = M.MTab(DAYS_ALL, fill_ms=FILL_MS)
PERIODS = [("week 1 (fit)", FIT_DAYS), ("week 2 (validate)", VALIDATE_DAYS), ("week 3 (test)", TEST_DAYS)]
FZ_SIG, FZ_EX = M.Signal(ST.FROZEN_PAIR[0], ST.FROZEN_PAIR[1]), M.Exit(ST.FROZEN_PAIR[2])
FZ_KEY = ST.key(FZ_SIG, FZ_EX)
FZ_ENT = M.run(XTAB, FZ_SIG, FZ_EX)
FZ = MR.by_period(FZ_ENT, XTAB, PERIODS + [("all days", DAYS_ALL)], "frozen")
# planted check: the frozen pair's entries on a day do not depend on which other days sit in the table
_solo_tab = M.MTab(TEST_DAYS, fill_ms=FILL_MS)
_solo = M.summarize(M.run(_solo_tab, FZ_SIG, FZ_EX), _solo_tab)
_same = _solo["n"] == FZ["week 3 (test)"]["n"] and abs(_solo["net"] - FZ["week 3 (test)"]["net"]) < 0.01
VERIFY["total"] += 1
VERIFY["passed"] += int(_same)
print(f"22-day table in {time.time() - t0:.0f}s; the frozen pair's last eight days equal a table of those days alone: {_same}")
assert _same, "an entry depends on the other days in the table"
_rows = [dict(block="registered test pair", pair=CHOSEN_KEY, days=f"{TEST_DAYS[0][5:]} to {TEST_DAYS[-1][5:]}", n=TSUM["n"], win=TSUM["win"], per=TSUM["per"], lo=TSUM["per_lo"], hi=TSUM["per_hi"], net=TSUM["net"])]
for nm_, ds_ in PERIODS + [("all days", DAYS_ALL)]:
    s_ = FZ[nm_]
    _rows.append(dict(block=f"frozen pair, {nm_}", pair=FZ_KEY, days=f"{ds_[0][5:]} to {ds_[-1][5:]}", n=s_["n"], win=s_["win"], per=s_["per"], lo=s_["per_lo"], hi=s_["per_hi"], net=s_["net"]))
XT = pd.DataFrame(_rows)
WIN_ALL = f"{DAYS_ALL[0][5:]} to {DAYS_ALL[-1][5:]} · {HOURS_ALL}h · every day, read after the test days"
display(Markdown("**The pair um-009 froze, week by week** (the registered pair of this study on its test days is the first row)"))
display(HTML(XT.round(3).to_html(index=False, border=0)))
SP = FZ["all days"]
W1, W2, W3 = FZ["week 1 (fit)"], FZ["week 2 (validate)"], FZ["week 3 (test)"]
GATES.append({"id": "G12", "section": "S4", "label": "Frozen pair by week", "name": "the pair um-009 froze (L 1 s, z 2.5, hold) on each of the three weeks; informational, outside the decision rule",
              "reading": f"week 1 {sgn(W1['per'])} on {W1['n']}; week 2 {sgn(W2['per'])} on {W2['n']}; week 3 {sgn(W3['per'])} on {W3['n']}", "verdict": "INFO", "would_change": "a result on more days"})
GATES.append({"id": "G13", "section": "S4", "label": "Frozen pair, every day", "name": "net per entry of the frozen pair over every day, with a 95% interval over 15-minute slots; informational: the decision rule reads the registered test days",
              "reading": f"{sgn(SP['per'])} USD an entry on {SP['n']} entries, 95% {sgn(SP['per_lo'])} to {sgn(SP['per_hi'])}", "verdict": "INFO", "would_change": "more days"})
'''

LAD_MD = r'''
**Does the win share still rise with the lookback only as fast as the break-even share?** The single-lookback signal at z = 2, held to expiry, at each lookback, read on each week and on every day. It is DESCRIPTIVE: seven cells read on days that include the test week, so nothing is chosen from it and no gate reads it.
'''

LAD_CODE = r'''
t0 = time.time()
LAD = MR.ladder_frame(XTAB, PERIODS)
print(f"lookback ladder in {time.time() - t0:.0f}s")
_wide = pd.DataFrame({"lookback": [f"{L_} s" for L_ in M.LS]}).set_index("lookback")
for nm_, _ in PERIODS + [("all days", DAYS_ALL)]:
    q_ = LAD[LAD["period"] == nm_].set_index("L")
    _wide[f"{nm_}: win %"] = (q_["win"] * 100).to_numpy()
    _wide[f"{nm_}: break-even %"] = (q_["be"] * 100).to_numpy()
    _wide[f"{nm_}: entries"] = q_["n"].to_numpy()
display(Markdown("**Win share against the share needed to break even, z = 2, hold to expiry** (break-even is the mean over entries of price plus fee a share, the like-for-like of the win share; the stage tables use the share-weighted price plus fee, which sits below it when cheap tokens carry more shares)"))
display(HTML(_wide.round(1).to_html(border=0)))
_p = LAD[LAD["period"] == "all days"].set_index("L")
_lx = np.log(np.asarray(_p.index, float))
_sw, _sb = np.polyfit(_lx, _p["win"].to_numpy(float) * 100, 1)[0], np.polyfit(_lx, _p["be"].to_numpy(float) * 100, 1)[0]
_npos = int((_p["gap"] > 0).sum())
_nsig = int(((_p["lo"] - _p["be"]) > 0).sum())
_nneg, _nup = int((_p["per"] < 0).sum()), int((_p["per_lo"] > 0).sum())
_wk_pos = {nm_: int((LAD[LAD["period"] == nm_]["gap"] > 0).sum()) for nm_, _ in PERIODS}
LAD_SENT = (f"at z = 2 the win share runs from {pct(_p['win'].iloc[0])} at {M.LS[0]} s to {pct(_p['win'].iloc[-1])} at {M.LS[-1]} s and the share the price and fee ask runs from {pct(_p['be'].iloc[0])} to {pct(_p['be'].iloc[-1])}; "
            f"the win share rises {_sw:.1f} points per unit of ln(lookback) and the break-even {_sb:.1f}; {_npos} of {len(_p)} lookbacks win more often than break-even asks ({_nsig} with a Wilson interval above it); net per entry is below zero at {_nneg} of {len(_p)} lookbacks and its 95% interval is above zero at {_nup}")
_bul = [f"Over {len(DAYS_ALL)} days: " + LAD_SENT + ".",
        "Weeks above zero (a gap above break-even at that lookback): " + "; ".join(f"{nm_} {k_} of {len(_p)}" for nm_, k_ in _wk_pos.items()) + ". A lookback whose gap changes sign between weeks is a result of the week.",
        "Left: the win share (ink, with the 95% Wilson band) against the break-even share (grey). Right: the gap in points, green above zero and red below; the marks are the three weeks."]
figstyle.show(F.ladder_fig(LAD, WIN_ALL, _bul), "fig:s4-ladder", FIGURES)
'''

DAYS_CODE = r'''
_ba = RP.by_asset(ENT, TTAB)
_bl = RP.by_left(ENT, TTAB)
display(Markdown("**By coin**")); display(HTML(_ba.round(3).to_html(border=0)))
display(Markdown("**By time left at the entry**")); display(HTML(_bl.round(3).to_html(border=0)))
_days_rows = []
for lab_, tab_, e_ in (("fit", TABS["fit"], STUDY.cells[CHOSEN_KEY]["fit"]["entries"]), ("validate", TABS["validate"], STUDY.cells[CHOSEN_KEY]["validate"]["entries"]), ("test", TTAB, ENT)):
    bd_ = RP.by_day(e_, tab_)
    for d_, r_ in bd_.iterrows():
        _days_rows.append(dict(role=lab_, day=d_, entries=int(r_["entries"]), win=r_["win"], per=r_["per"], net=r_["net"]))
display(Markdown("**The chosen pair on every day read** (the role says which stage used the day)"))
display(HTML(pd.DataFrame(_days_rows).round(3).to_html(index=False, border=0)))
_fzd = RP.by_day(FZ_ENT, XTAB)
_fz_rows = [dict(day=d_, role=next(nm_ for nm_, ds_ in PERIODS if d_ in ds_), entries=int(r_["entries"]), win=r_["win"], per=r_["per"], net=r_["net"]) for d_, r_ in _fzd.iterrows()]
display(Markdown(f"**The pair um-009 froze ({FZ_KEY}) on every day**"))
display(HTML(pd.DataFrame(_fz_rows).round(3).to_html(index=False, border=0)))
_fz_pos = int((_fzd["net"] > 0).sum())
'''


def patch(cells):
    # ---- titles and the pre-registration ----
    _rep(cells, "# Does a big Binance move predict the next move on Polymarket's 15-minute Up/Down markets, and over what lookback and exit does it pay?",
         "# Does the momentum result hold over the whole 22-day sample, with the split in date order?")
    _rep(cells, "**The idea.** A directional momentum trade", "**The re-score.** Run um-009 read again on every day the Polymarket ladders now cover (B-0679), with the split fixed in date order before any of the first two weeks was scored: the stages fit and validate on the first fourteen days and the last eight days are read once. Two headline findings of um-009 are re-checked: NO MONEY, and that the win share rises with the lookback while the break-even share rises to match.\n\n**The idea.** A directional momentum trade")
    _rep(cells, "| Days, in date order | fit, validate and test, listed in S1.1; the test days are opened once, for the one pair the stages choose |",
         "| Days, in date order | the first week fits, the second validates, the last eight days test (S1.1); the test days are opened once, for the one pair the stages choose |")
    _rep(cells, "both test days above zero, and the sizing gate cleared", "most test days above zero, and the sizing gate cleared")
    _rep(cells, "| Pre-registration | run um-009 on the predmkts desk, committed before any validation or test day was scored |",
         "| Pre-registration | run um-012 on the predmkts desk, committed before any day of the first two weeks was scored |")
    _rep(cells, "| F4 | the pair is not above zero on both test days, or was not positive on the fit days as well as on the validation days |",
         "| F4 | the pair is above zero on fewer than five of the eight test days, or was not positive on the fit days as well as on the validation days |")
    _rep(cells, "| the B-0654 strategy search (um-005 to um-008) |",
         "| `2026-10-08-predmkts-binance-momentum-15m-updown` (um-009) | on 09-30 to 10-07 the chosen L1s|z2.5 hold pair lost 0.38 USD an entry on 720 test entries (95% -1.87 to +1.15); every early exit lost; win share rose with the lookback and the break-even share rose with it | the findings this study re-checks on 22 days, with the split in date order |\n| the B-0654 strategy search (um-005 to um-008) |")
    _rep(cells, 'STUDY_ID = "2026-10-08-predmkts-binance-momentum-15m-updown"', f'STUDY_ID = "{STEM}"')
    _rep(cells, 'RUN_ID = "um-009"', f'RUN_ID = "{RUN_ID}"')
    _rep(cells, 'TITLE = "Does a big Binance move predict the next move on Polymarket\'s 15-minute Up/Down markets, and over what lookback and exit does it pay?"',
         'TITLE = "Does the momentum result hold over the whole 22-day sample, with the split in date order?"')
    _rep(cells, 'QUESTION = "Does buying the 15-minute Up/Down token in the direction of a Binance move of z sigma over lookback L earn a positive net PnL per entry after fees, spread and a 250 ms fill, and which exit pays?"',
         'QUESTION = "On 22 days split in date order, does buying the 15-minute Up/Down token in the direction of a Binance move of z sigma over lookback L earn after fees, spread and a 250 ms fill, and does the win share still rise with the lookback only as fast as the break-even share?"')
    _rep(cells, '''FIT_DAYS = ("2026-09-30", "2026-10-01", "2026-10-02")
VALIDATE_DAYS = ("2026-10-03", "2026-10-04")
TEST_DAYS = ("2026-10-05", "2026-10-06")
EARLIER_WEEK = ("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29")
FRESH_DAY = ("2026-10-07",)''', '''FIT_DAYS = ("2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22")
VALIDATE_DAYS = ("2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29")
TEST_DAYS = ("2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07")
EARLIER_WEEK = ()
FRESH_DAY = ()''')
    _rep(cells, 'assert (ST.FIT, ST.VALIDATE, ST.TEST) == (FIT_DAYS, VALIDATE_DAYS, TEST_DAYS) and ST.EARLIER_WEEK == EARLIER_WEEK and ST.FRESH_DAY == FRESH_DAY',
         '_P = ST.PROTOCOLS[RUN_ID]\nassert (_P["FIT"], _P["VALIDATE"], _P["TEST"], _P["EARLIER_WEEK"], _P["FRESH_DAY"]) == (FIT_DAYS, VALIDATE_DAYS, TEST_DAYS, EARLIER_WEEK, FRESH_DAY)')
    _rep(cells, "**The protocol, fixed before any validation or test day was scored** (run um-009).", "**The protocol, fixed before any day of the first two weeks was scored** (run um-012).")
    _rep(cells, "the test read and the days of S4 outside the split are the out-of-sample confirmation.", "the test read is the out-of-sample confirmation; the frozen-pair and lookback-ladder reads of S4 are for the record.")
    _rep(cells, "Is it real: does the placebo earn as much, does a planted peek pay far more, does it survive the delay, twice the fee, both test days, and the number of cells tried?",
         "Is it real: does the placebo earn as much, does a planted peek pay far more, does it survive the delay, twice the fee, most of the test days, and the number of cells tried?")
    # ---- the sections that read days outside the split ----
    _swap(cells, "What did the pair do on days nobody used to choose it?", XR_MD, "md")
    _swap(cells, "days outside the registered split, read AFTER the test days for the pair already chosen", XR_CODE)
    _swap(cells, "**Exploratory. Does slow momentum held to expiry pay on days the sweep never saw?**", LAD_MD, "md")
    _swap(cells, "unseen-days grid in", LAD_CODE, tags=("fig:s4-ladder",))
    _swap(cells, "_days_rows = []", DAYS_CODE)
    # ---- gate G9: most days, not every day ----
    _rep(cells, 'gate("G9", "Positive on both days", "the net is above zero on every test day", f"{_pos_days} of {len(_bd)} test days above zero", bool(_pos_days == len(_bd) and len(_bd) > 0), "a result carried by one day")',
         'gate("G9", "Positive on most days", "the net is above zero on at least five of the eight test days", f"{_pos_days} of {len(_bd)} test days above zero", bool(_pos_days >= 5 and len(_bd) == 8), "a result carried by a few days")')
    # ---- the words that counted days ----
    _rep(cells, "Two days of one regime are one observation of the regime, not a promise.", "Days of one regime are one observation of the regime, not a promise.", 2)
    _rep(cells, "(two days: a rough label only)", "(a few days: a rough label only)")
    _rep(cells, "two test days:", "eight test days:", 5)
    _rep(cells, "two test days of one regime: one observation of the regime, not a promise", "22 days of one regime: one observation of the regime, not a promise")
    _rep(cells, "the Polymarket days are those of um-003 to um-008: one window, not an independent observation", "the days overlap those read by um-004 to um-009: one window, not an independent observation")
    _rep(cells, "The Polymarket days are those of um-003 to um-008: one window, one regime, not an independent observation.", "The days overlap those of um-004 to um-009: one window, one regime, not an independent observation.")
    _rep(cells, '"what": "days outside the registered split: earlier week and fresh day, and the unseen-days surface of S4", "why": "read after the registered test days for the record; not part of the registered inputs digest"',
         '"what": "the frozen-pair and lookback-ladder reads of S4", "why": "read after the registered test days from the same pinned tables; outside the decision rule"')
    _rep(cells, '"fig:s4-slow": "parameter-surface"', '"fig:s4-ladder": "calibration"')
    # ---- RESULT lines and the headline ----
    _rep(cells, "RESULT um-009", "RESULT um-012", 7)
    _rep(cells, "f\"On days the sweep never saw, the pair earned {sgn(SP['per'])} an entry pooled with the test days ({SP['n']} entries, 95% {sgn(SP['per_lo'])} to {sgn(SP['per_hi'])}). \"",
         "f\"The pair um-009 froze (L1s|z2.5 held to expiry) earned {sgn(SP['per'])} an entry over all {len(DAYS_ALL)} days ({SP['n']} entries, 95% {sgn(SP['per_lo'])} to {sgn(SP['per_hi'])}); by week {sgn(W1['per'])}, {sgn(W2['per'])}, {sgn(W3['per'])}. \"")
    _rep(cells, 'f"Slow momentum held to expiry wins more often, and the book prices it in: at z = 2 the momentum side\'s win share rises from {pct(_win_tab.loc[\'win share\'].iloc[0])} at {_win_tab.columns[0]} to {pct(_win_tab.loc[\'win share\'].iloc[-1])} at {_win_tab.columns[-1]}, "\n               f"and the share the price and fee ask rises from {pct(_win_tab.loc[\'break-even\'].iloc[0])} to {pct(_win_tab.loc[\'break-even\'].iloc[-1])} (validation days).")', 'f"Slow momentum held to expiry wins more often, and the book prices it in: over all {len(DAYS_ALL)} days {LAD_SENT}.")')
    _rep(cells, '"next_bet": _cut("a forward, pre-registered read of the slow-lookback hold cells on days after 2026-10-07, chosen before the days are read", 150)',
         '"next_bet": _cut("the maker-side burst on BTC and ETH: a resting bid pays no fee and no half spread, pre-registered before it is scored", 150)')
    _rep(cells, '"the Binance trade-implied mid stands in for the Chainlink reference (about 1.9 bp apart, sd 0.8 bp)",', '"the Binance trade-implied mid stands in for the Chainlink reference (about 1.9 bp apart, sd 0.8 bp)",\n           "stage tables: break-even is share-weighted; the S4 ladder uses the entry-weighted one, like the win share",')
    # ---- win share and break-even on the same footing: both over entries (the stage tables used the share-weighted one) ----
    nsub = 0
    for c in cells:
        c.source, k = re.subn(r"""(_sp|s_|TSUM|_sv)(\[['"])breakeven(['"]\])""", r"\1\2breakeven_entry\3", c.source)
        nsub += k
    assert nsub == 14, nsub
    _rep(cells, '.get("breakeven", np.nan)]', '.get("breakeven_entry", np.nan)]')
    import mom15_full_tweaks as TW
    TW.patch_tweaks(cells)
    return cells
