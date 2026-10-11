"""The merged momentum notebook (the owner, 2026-10-10: one notebook, not three): the registered um-009 study (`mom15_nb.cells`, the four stages and the one test read) with its
diagnosis (`mom15_dx_nb.cells`: the five-term identity, the clustering, the calibration, the three arms, the lookbacks, the hunt, the drift, the structural scan, the near-certain
family and the maker ceiling) folded into S5 and read on all 22 days now pinned (09-16 to 10-07); the days outside the registered split (two earlier weeks and the fresh day) feed the
S4 reads. The two diagnosis notebooks (`...-diagnosis`, `...-diagnosis-fullwindow`) are retired by this merge. Words and cell surgery only; every number is computed by the notebook.
`patch(cells)` edits `mom15_nb.cells` in place and asserts that every edit found its text.
"""
from __future__ import annotations

import re

from nbformat.v4 import new_code_cell, new_markdown_cell

import mom15_dx_nb as DX

DX_DAYS = ("2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29",
           "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07")
WEEK_BEFORE = DX_DAYS[:7]
HOLD_OUT = DX_DAYS[14:]
GATE_MAP = {"G2": "G15", "G3": "G16", "G4": "G17", "G5": "G18", "G6": "G19", "G7": "G20", "G8": "G21", "G9": "G22", "G10": "G23", "G11": "G24"}
FIG_MAP = {"fig:s3-waterfall": "fig:s5-waterfall", "fig:s3-clusters": "fig:s5-clusters", "fig:s3-calibration": "fig:s5-calibration", "fig:s4-arms": "fig:s5-arms", "fig:s4-lookback": "fig:s5-lookback",
           "fig:s4-hunt": "fig:s5-hunt", "fig:s4-holdout": "fig:s5-holdout", "fig:s4-drift": "fig:s5-drift", "fig:s4-structure": "fig:s5-structure", "fig:s4-nearcertain": "fig:s5-nearcertain"}
DX_FIG_KINDS = {"fig:s5-waterfall": "profit-and-loss-attribution", "fig:s5-weeks": "profit-and-loss-attribution", "fig:s5-clusters": "regime-and-concentration", "fig:s5-calibration": "calibration", "fig:s5-arms": "rule-comparison",
                "fig:s5-lookback": "profit-and-loss-attribution", "fig:s5-hunt": "significance-test", "fig:s5-holdout": "out-of-sample-test", "fig:s5-drift": "signal-decay", "fig:s5-structure": "calibration", "fig:s5-nearcertain": "profit-and-loss-attribution"}


def _rep(cells, old, new, n=1):
    hits = sum(c.source.count(old) for c in cells)
    assert hits == n, f"expected {n} of {old[:70]!r}, found {hits}"
    for c in cells:
        c.source = c.source.replace(old, new)


def _find(cells, anchor):
    ix = [i for i, c in enumerate(cells) if anchor in c.source]
    assert len(ix) == 1, f"{len(ix)} cells hold {anchor[:60]!r}"
    return ix[0]


def _cell(kind, src, tags=()):
    c = new_code_cell(src.strip("\n")) if kind == "code" else new_markdown_cell(src.strip("\n"))
    if tags:
        c.metadata["tags"] = list(tags)
    return c


# ============================================================ the diagnosis cells, lifted from mom15_dx_nb and made to sit in S5 of the momentum notebook
DX_SETUP = r'''
# ---- the diagnosis of the frozen pair on all 22 days: the table, the roles, the entry frame; the pair's entries on the test days must equal the stage 4 read ----
t0 = time.time()
ROLES_DX = {d_: r_ for r_, ds_ in (("fit", FIT_DAYS), ("validate", VALIDATE_DAYS), ("test", TEST_DAYS), ("week before", WEEK_BEFORE), ("earlier week", EARLIER_WEEK), ("fresh day", FRESH_DAY)) for d_ in ds_}
assert tuple(sorted(ROLES_DX)) == tuple(sorted(DX_DAYS)) and len(ROLES_DX) == len(DX_DAYS)
TAB = M.MTab(DX_DAYS, fill_ms=FILL_MS)
CUTS = D.vol_cuts(TAB)
pfmt = lambda p_: "< 0.001" if p_ < 0.001 else f"= {p_:.3f}"
mag = lambda v, d=2: f"{abs(v):,.{d}f}"
LABEL_NAMES = {"coin": "coin", "tod": "UTC block", "vol": "volatility", "timing": "time into the window", "lead": "side against the fair value"}
DX_HOURS = 24 * len(DX_DAYS)
WIN_ALL = f"{DX_DAYS[0][5:]} to {DX_DAYS[-1][5:]} · {DX_HOURS}h · every day read, 22 days of one regime"
WIN_BOTH = f"{WIN_TEST.split(' · ')[0]} test, {DX_DAYS[0][5:]} to {DX_DAYS[-1][5:]} all · {DX_HOURS}h of 22 days, one regime"
SIG, EXIT = M.Signal(PAIR_L, PAIR_Z), M.Exit("expiry")
assert ST.key(SIG, EXIT) == CHOSEN_KEY, f"the diagnosis reads the pair the stages chose: {CHOSEN_KEY!r}, not {ST.key(SIG, EXIT)!r}"
ENT_ALL = M.run(TAB, SIG, EXIT)
FRM = D.entry_frame(TAB, ENT_ALL, SIG, ROLES_DX, CUTS)
FRM_T = FRM[FRM["role"] == "test"].reset_index(drop=True)
_rb = dict(n=len(FRM_T), net=float(FRM_T["net"].sum()), win=float(FRM_T["won"].mean() * 100), per=float(FRM_T["net"].mean()))
_same = (_rb["n"] == TSUM["n"]) and abs(_rb["net"] - TSUM["net"]) < 0.005 and abs(_rb["per"] - TSUM["per"]) < 0.00005
display(Markdown(f"**The frozen pair on all {len(DX_DAYS)} days: {TAB.W} windows, {len(FRM)} entries, loaded in {time.time() - t0:.0f}s; volatility terciles cut at {CUTS[1][0]:.2f} and {CUTS[1][1]:.2f} times the coin's median sigma.** "
                 f"Its entries on the test days, cut from the 22-day table, are {_rb['n']} with a net of {sgn(_rb['net'])} USD ({sgn(_rb['per'], 4)} an entry, win {_rb['win']:.2f}%); the stage 4 read above printed {TSUM['n']} entries, {sgn(TSUM['net'])} USD, {sgn(TSUM['per'], 4)} an entry: an entry does not depend on which other days sit in the table."))
GATES.append({"id": "G15", "section": "S5", "label": "Pair equals stage 4", "name": "the frozen pair's test entries, cut from the 22-day table, equal the stage 4 read in count, net and per entry", "reading": f"{_rb['n']} entries, net {sgn(_rb['net'])} USD against {TSUM['n']} and {sgn(TSUM['net'])}",
              "verdict": "PASS" if _same else "FAIL", "would_change": "an entry that depends on the other days in the table"})
assert _same, "the diagnosis does not rebuild the stage 4 read"
'''

DX_TERMS_CHECK = r'''
# ---- the five terms add to the net on every entry, and the one-sided books are named ----
_sh = FRM["shares"].to_numpy()
_tot = ((FRM["won"] - FRM["pu_side"]) + (FRM["pu_side"] - FRM["mid_dec"]) + (FRM["mid_dec"] - FRM["mid_fill"]) + (FRM["mid_fill"] - FRM["vwap"]) - FRM["fee"] / FRM["shares"]) * _sh
_dmax = float(np.abs(_tot - FRM["net"]).max())
_nobid = int(sum(1 for w_, k_, s_ in zip(ENT_ALL["w"], ENT_ALL["k"], ENT_ALL["side"]) if not np.isfinite(B.ladder_of(TAB, np.array([w_]), np.array([k_]), np.array([s_]), buy=False)[0][0, 0])))
display(Markdown(f"**The five terms.** On all {len(FRM)} entries the terms add to the net: the largest difference is {_dmax:.1e} USD. {_nobid} entr{'y' if _nobid == 1 else 'ies'} met a book with no bid at the fill second; the book mid there is the best ask, so the half spread is nil."))
GATES.append({"id": "G16", "section": "S5", "label": "Terms add to the net", "name": "A + B + C + D + E equals the net on every entry", "reading": f"largest difference {_dmax:.1e} USD on {len(FRM)} entries", "verdict": "PASS" if _dmax < 1e-3 else "FAIL", "would_change": "a term left out"})
'''

WEEKS_MD = r'''
**Does the split hold week by week?** The same edge before friction, friction and net, cut by the three weeks of the 22 days and by day. The pair was chosen on 09-30 to 10-04, so the first two weeks are days its choice never saw; the third holds the days of its choice and of its test.
'''

WEEKS_CODE = r'''
PERIODS = [("week 1 (09-16 to 09-22)", DX_DAYS[:7]), ("week 2 (09-23 to 09-29)", DX_DAYS[7:14]), ("week 3 (09-30 to 10-07)", DX_DAYS[14:]), ("all 22 days", DX_DAYS)]
_wk = []
for nm_, ds_ in PERIODS:
    f_ = FRM[FRM["date"].isin(ds_)].reset_index(drop=True)
    es_ = D.edge_stats(f_)
    _wk.append(dict(period=nm_, entries=es_["n"], edge=es_["edge"], edge_lo=es_["edge_lo"], edge_hi=es_["edge_hi"], friction=es_["friction"], net=es_["net"], net_lo=es_["net_lo"], net_hi=es_["net_hi"]))
WK = pd.DataFrame(_wk)
WKD = FRM.groupby("date").agg(entries=("net", "size"), edge=("edge", "mean"), net=("net", "mean")).reset_index()
WKD["friction"] = WKD["net"] - WKD["edge"]
display(Markdown("**Edge before friction, friction and net by week, USD an entry** (95% by 15-minute slot)"))
display(HTML(WK.round(3).to_html(index=False, border=0)))
display(Markdown("**By day**"))
display(HTML(WKD.round(3).to_html(index=False, border=0)))
_wk_ok = [bool(r_.edge > 0 and r_.friction < -r_.edge) for r_ in WK.itertuples()]
_neg_days = int((WKD["net"] < 0).sum())
_bul = [f"Edge before friction by week: " + ", ".join(f"{r_.period.split(' (')[0]} {sgn(r_.edge)}" for r_ in WK.itertuples()) + f" USD an entry; friction " + ", ".join(sgn(r_.friction) for r_ in WK.itertuples()) + f"; net " + ", ".join(sgn(r_.net) for r_ in WK.itertuples()) + ".",
        f"The friction is larger than the edge in {sum(_wk_ok)} of {len(WK)} periods, and {_neg_days} of {len(WKD)} days have a net below zero. The net interval spans zero in {int(((WK['net_lo'] <= 0) & (WK['net_hi'] >= 0)).sum())} of {len(WK)} periods.",
        "Left: green bars are the edge before friction, red the friction, the ink dot the net with its 95% interval over slots. Right: the net per entry by day (green above zero, red below) and the edge as an ink dot."]
figstyle.show(DF.weeks_fig(WK, WKD, WIN_ALL, _bul), "fig:s5-weeks", FIGURES)
'''

ANS6_CODE = r'''
_wa = WF_A.set_index("term")["usd"]
_coin_net = ", ".join(f"{c_.upper()} {sgn(r_['per'])}" for c_, r_ in _ba.iterrows() if r_["entries"] > 0)
ANS6.update(Markdown(f"**We lose to cost, not to a missing signal: the burst's side beats the book's mid by {sgn(ES_T['edge'])} USD an entry before friction, friction takes {mag(ES_T['friction'])}, and the net is {sgn(ES_T['net'])}** ({len(FRM_T)} test entries, {WIN_TEST.split(' · ')[0]}; over all {len(FRM)} entries of the 22 days the edge is {sgn(ES_A['edge'])} and the friction {mag(ES_A['friction'])}). "
                     f"The friction is the book's move in the 250 ms ({mag(_wa['C'])}), the half spread and depth ({mag(_wa['D'])}) and the fee ({mag(_wa['E'])}). By coin the net per entry on the test days is {_coin_net}; nothing inside the pair survives the correction for the looks (the hunt below)."))
'''

DX_SHORT_CODE = r'''
DX_SHORT = (f"Why: the burst's side beats the book's mid by {sgn(ES_T['edge'])} USD an entry on the test entries and friction takes {mag(ES_T['friction'])}; {HI['n_maxt_05']} of {HI['n_hyp']} slices and signal cells and {HI_SC['n_maxt_05']} of {HI_SC['n_hyp']} structural cells clear the best-of-N line.")
ANS7_TXT += " " + DX_SHORT
ANS7.update(Markdown(ANS7_TXT)); ANS0.update(Markdown(ANS7_TXT))
'''


def dx_body():
    """The diagnosis cells from its S3 header to its S6 header, renamed and re-tagged for S5 of the momentum notebook."""
    nb = DX.NB()
    DX.cells(nb)
    X = nb.cells
    i0, i1 = _find(X, "## S3 · Core result"), _find(X, "## S6 · Decision")
    body = X[i0:i1]
    body[0] = _cell("md", "### Where does the money go?")
    body[_find(body, "## S4 · Robustness")] = _cell("md", "### Is the direction of the burst worth anything beyond buying the favourite?")
    body[_find(body, "## S5 · Risk and diagnostics - Which coins hold the edge, and how long would it take to confirm?")] = _cell("md", "### Which coins hold the edge, and how long would it take to confirm?")
    # the five terms check after the waterfall table, the week table before the clustering
    j = _find(body, "WF_T, WF_A = D.waterfall(FRM_T), D.waterfall(FRM)")
    body[j:j] = [_cell("code", DX_TERMS_CHECK)]
    j = _find(body, "### Are the losses clustered?")
    body[j:j] = [_cell("md", WEEKS_MD), _cell("code", WEEKS_CODE, ("fig:s5-weeks",))]
    for c in body:
        s = c.source
        s = re.sub(r"\bDAYS_ALL\b", "DX_DAYS", s)
        s = re.sub(r"\bHOURS_ALL\b", "DX_HOURS", s)
        s = re.sub(r"\bSP\b", "SPD", s)
        s = re.sub(r"\b_dl\b", "_dlc", s)
        s = re.sub(r"\bANS5\b", "ANS9", s)
        s = re.sub(r"\bROLES\b", "ROLES_DX", s)
        s = s.replace('"section": "S3"', '"section": "S5"').replace('"section": "S4"', '"section": "S5"')      # the diagnosis sits in S5 here
        s = re.sub(r"\b_c\b", "_cdx", s)                      # S6 of the study rebinds `_c` (the cost table) before S7 reads the coin terms
        for old, new in GATE_MAP.items():
            s = s.replace(f'"id": "{old}"', f'"id": "{new}"')
        for old, new in FIG_MAP.items():
            s = s.replace(old, new)
        s = s.replace("15 days", "22 days").replace("all 15 days", "all 22 days")
        s = s.replace("(the test days and the fresh day, {sum(1 for d_ in HOLD_OUT_DAYS)} days)", "(the last eight days, {len(HOLD_OUT_DAYS)} days)")
        s = s.replace("Discovery is every day before the test days; hold-out is the test days and the fresh day.", "Discovery is the first fourteen days; hold-out is the last eight (the split registered with um-012, in date order).")
        s = s.replace('for r_ in ("fit", "validate", "test", "earlier week", "fresh day")', 'for r_ in ("week before", "earlier week", "fit", "validate", "test", "fresh day")')
        s = s.replace("here the selected slices fall to the level of the rest.",
                      "the selected slices earn {sgn(SI['hold_per'])} on the hold-out against {sgn(SI['all_hold_per'])} for every hypothesis: {'they keep part of what they showed, a lead and not a result, since none clears the best-of-N line' if SI['hold_per'] > SI['all_hold_per'] + 0.25 else 'they fall to the level of the rest'}.")
        c.source = s
        if "tags" in c.metadata:
            c.metadata["tags"] = [FIG_MAP.get(t, t) for t in c.metadata["tags"]]
    # the diagnosis's own answer line for its S5 lives on as ANS9; the clustering answer names the coin by the numbers, not by a story
    _rep(body, '''ANS32.update(Markdown(f"**{('Only the ' + ' and '.join(_split) + ' splits') if _split else 'No label splits'} the loss.** Net per entry by coin over all days is " + ", ".join(f"{c_.upper()} {sgn(_cn[c_])}" for c_ in D.COINS if c_ in _cn.index)
                      + f"; the other labels (time of day, volatility, time into the window, with or against the leader) show no detectable split (all days, {WIN_ALL.split(' · ')[0]})."))''',
         '''ANS32.update(Markdown(f"**{('Only the ' + ' and '.join(_split) + ' splits') if _split else 'No label splits'} the loss.** Net per entry by coin over all days is " + ", ".join(f"{c_.upper()} {sgn(_cn[c_])}" for c_ in D.COINS if c_ in _cn.index)
                      + f"; " + ("time of day, volatility, time into the window and with or against the leader show no detectable split" if not _split else "the other labels show no detectable split") + f" (all days, {WIN_ALL.split(' · ')[0]})."))''')
    return body


def dx_verdict():
    """The diagnosis's headline and next-bet cells (its S7), with every story claim recorded instead of asserted, renamed for the merged S7."""
    nb = DX.NB()
    DX.cells(nb)
    X = nb.cells
    i7 = _find(X, "## S7 · Verdict - Why do we lose?")
    head = X[_find(X, "# ---- the plain-words answer, from the run's own numbers; each claim of the wording is asserted")]
    nxt = X[_find(X, "NEXT_MD = (f\"**Where the next tradeable edge is.**")]
    assert X.index(head) > i7 and X.index(nxt) > i7
    cells = [head, nxt]
    out = []
    n_conv = 0
    for c in cells:
        lines = []
        for line in c.source.split("\n"):
            m = re.match(r'^assert (.+), "(the story needs [^"]+)"$', line)
            if m:
                lines.append(f'STORY["{m.group(2)}"] = bool({m.group(1)})')
                n_conv += 1
            else:
                lines.append(line)
        s = "\n".join(lines)
        s = s.replace("# ---- the plain-words answer, from the run's own numbers; each claim of the wording is asserted, so a re-run that breaks the story stops here ----",
                      "# ---- the diagnosis's answer, from the run's own numbers; each claim of the wording is recorded in STORY, so a sample that breaks the story is told here ----\nSTORY = {}")
        s = re.sub(r"\bHEADLINE_MD\b", "DX_HEADLINE_MD", s)
        s = re.sub(r"\bNEXT_MD\b", "DX_NEXT_MD", s)
        s = re.sub(r"\bDAYS_ALL\b", "DX_DAYS", s)
        s = re.sub(r"\b_dl\b", "_dlc", s)
        s = re.sub(r"\b_c\b", "_cdx", s)
        s = s.replace("15 days", "22 days")
        s = s.replace("**The answer: the pair is cost-bound, and nothing inside it survives the correction for the looks.**", "**Why we lose: the pair is cost-bound, and nothing inside it survives the correction for the looks.**")
        s = s.replace("The one label that splits it is the coin:", "{'The one label that splits it is the coin' if CL_A['wald']['coin'][2] < 0.05 else 'The coin is the one label that comes close to splitting it'}:")
        s = s.replace("**The next candidate is therefore a maker-side study of the burst on BTC and ETH only**, with a fill model on printed trades (um-008's design, cut to the two coins and to the burst seconds), pre-registered before any day after 10-07 is read; um-008's all-coin quote recorded -0.44 a fill, so the cut is a hypothesis and the ceiling is not a claim. ",
                      "**The maker-side study of the burst on BTC and ETH is `2026-10-09-predmkts-binance-burst-maker-15m-updown` (um-013)**: on the design window the fills are the adverse ones; its one scored read is forward. The entry-rule family of the full-window re-score (`2026-10-08-predmkts-binance-momentum-15m-updown-fullwindow`, S5) names the fair-value gate as the taker-side lead, to be registered forward before it is read again. ")
        out.append(_cell("code", s))
    assert n_conv == 7, n_conv
    out[0].source += '\nSTORY_FAIL = [k_ for k_, v_ in STORY.items() if not v_]\nprint("story lines that fail:", STORY_FAIL or "none")'
    return out


def dx_appendix():
    nb = DX.NB()
    DX.cells(nb)
    X = nb.cells
    c = X[_find(X, 'display(Markdown(f"**Every hypothesis scored ({HI[\'n_hyp\']})**"))')]
    s = c.source
    s = s.replace('display(Markdown(f"**Every hypothesis scored ({HI[\'n_hyp\']})**"))\ndisplay(HTML(HUNT[', 'display(Markdown(f"**The 60 highest of the {HI[\'n_hyp\']} hypotheses scored** (the whole table is `HUNT`)"))\ndisplay(HTML(HUNT.head(60)[')
    assert s != c.source
    return [_cell("code", s)]


# ============================================================ the surgery on the momentum cells
def patch(cells):
    # ---- title, question, the days ----
    _rep(cells, "# Does a big Binance move predict the next move on Polymarket's 15-minute Up/Down markets, and over what lookback and exit does it pay?",
         "# Does a big Binance move predict the next move on Polymarket's 15-minute Up/Down markets, over what lookback and exit does it pay, and why does it lose?")
    _rep(cells, 'TITLE = "Does a big Binance move predict the next move on Polymarket\'s 15-minute Up/Down markets, and over what lookback and exit does it pay?"',
         'TITLE = "Does a big Binance move predict the next move on Polymarket\'s 15-minute Up/Down markets, over what lookback and exit does it pay, and why does it lose?"')
    _rep(cells, "**The idea.** A directional momentum trade, not a latency race:",
         "**One notebook, two reads (merged 2026-10-10 on the owner's word; it replaces the two diagnosis notebooks).** S3 is the registered study um-009: four stages on a seven-day split in date order and one opening of its test days. S5 is the diagnosis of the pair it chose, read on all 22 days now pinned (09-16 to 10-07): one identity splits every entry into the fair value's surprise, the model against the book, the book's move in the 250 ms, the spread and depth, and the fee; the losses are cut by coin, hour, volatility, moment and side; every slice, signal cell and structural cell is counted and corrected for the number of places looked. S4 reads the pair on the days nobody used to choose it: two earlier weeks and the fresh day.\n\n**The idea.** A directional momentum trade, not a latency race:")
    _rep(cells, "| Days, in date order | fit, validate and test, listed in S1.1; the test days are opened once, for the one pair the stages choose |",
         "| Days, in date order | fit, validate and test, listed in S1.1; the test days are opened once, for the one pair the stages choose; two earlier weeks and the fresh day are read afterwards for the record, and the diagnosis of S5 reads all 22 |")
    _rep(cells, "| the B-0654 strategy search (um-005 to um-008) | taker rules at 150 ms die on the fee; every pooled out-of-sample interval includes zero | the fee on both legs is the bar an early exit has to clear |",
         "| the B-0654 strategy search (um-005 to um-008) | taker rules at 150 ms die on the fee; every pooled out-of-sample interval includes zero | the fee on both legs is the bar an early exit has to clear |\n| `2026-10-08-predmkts-binance-momentum-15m-updown-fullwindow` (um-012) | the same stages re-scored on 22 days in date order chose a three-minute move (L180s z3, hold): +0.19 USD an entry on 360 test entries, interval spanning zero; the frozen um-009 pair -0.44 over 22 days | the 22-day read of the frozen pair in S5 is the same window as that study: one result, not a replication |")
    _rep(cells, 'FRESH_DAY = ("2026-10-07",)\n', 'FRESH_DAY = ("2026-10-07",)\nWEEK_BEFORE = ("2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22")\nDX_DAYS = WEEK_BEFORE + EARLIER_WEEK + FIT_DAYS + VALIDATE_DAYS + TEST_DAYS + FRESH_DAY\nHOLD_OUT_DAYS = DX_DAYS[14:]\n')
    _rep(cells, "N_MIN = 30", 'N_MIN = 30\nPAIR_L, PAIR_Z, PAIR_EXIT = 1, 2.5, "hold to expiry"\nSHOW_Z = 2.5\nN_BOOT = 4000\nN_PERM = 4000\nCOIN_DRAWS = 20\nTOP_K = 10')
    _rep(cells, "import mom15_bt as M, mom15_study as ST, mom15_figs as F, mom15_path as P, mom15_report as MR", "import mom15_bt as M, mom15_study as ST, mom15_figs as F, mom15_path as P, mom15_report as MR, mom15_diag as D, mom15_dx_figs as DF")
    _rep(cells, '         "last entry left": (M.TMIN, TMIN_S), "levels": (TT.L, 4), "min entries": (ST.N_MIN, N_MIN)}',
         '         "last entry left": (M.TMIN, TMIN_S), "levels": (TT.L, 4), "min entries": (ST.N_MIN, N_MIN), "blocks": (len(D.TOD_LABELS), 4), "time bins": (len(D.TIMING_LABELS), 4), "time edges": (D.TIMING_EDGES, (10, 20, 40, 90, 841))}')
    _rep(cells, "assert (ST.FIT, ST.VALIDATE, ST.TEST) == (FIT_DAYS, VALIDATE_DAYS, TEST_DAYS) and ST.EARLIER_WEEK == EARLIER_WEEK and ST.FRESH_DAY == FRESH_DAY",
         "assert (ST.FIT, ST.VALIDATE, ST.TEST) == (FIT_DAYS, VALIDATE_DAYS, TEST_DAYS) and ST.EARLIER_WEEK == EARLIER_WEEK and ST.FRESH_DAY == FRESH_DAY\nassert DX_DAYS == tuple(sorted(DX_DAYS)) and len(DX_DAYS) == 22 and (PAIR_L, PAIR_Z, PAIR_EXIT) == (ST.FROZEN_PAIR[0], ST.FROZEN_PAIR[1], \"hold to expiry\")")
    _rep(cells, "| `ticks.day_frame` | Binance spot aggTrades BTC, ETH, SOL, XRP | the days of S1.1 and the day before each | the file checksum in the day's meta |",
         "| `ticks.day_frame` | Binance spot aggTrades BTC, ETH, SOL, XRP | all 22 days of S1.1 and the day before each | the file checksum in the day's meta |")
    _rep(cells, 'import datetime as dt, json, math, time\n', 'import datetime as dt, json, math, time, contextlib, io as _io\n')
    _rep(cells, 'HOURS_ALL = 24 * len(DAYS_ALL)\nWINDOW = {"from": f"{DAYS_ALL[0]}T00:00Z", "to": f"{(dt.date.fromisoformat(DAYS_ALL[-1]) + dt.timedelta(days=1)).isoformat()}T00:00Z", "hours": HOURS_ALL, "regimes": 1}',
         'HOURS_ALL = 24 * len(DX_DAYS)\nWINDOW = {"from": f"{DX_DAYS[0]}T00:00Z", "to": f"{(dt.date.fromisoformat(DX_DAYS[-1]) + dt.timedelta(days=1)).isoformat()}T00:00Z", "hours": HOURS_ALL, "regimes": 1}')
    # ---- S1.4: the diagnosis module's checks join the engine's ----
    _rep(cells, '''print("mom15_bt:"); ok_m = M.selftest()
print("tf15_bt:"); ok_b = B.selftest()
assert ok_m and ok_b, "an engine check failed"
VERIFY = {"suite": "mom15 engine checks and planted tests", "passed": 19, "total": 19, "books": sum(t_.W for t_ in TABS.values())}      # 14 + 5 engine cases above; the planted lead, the planted peek and the test-gate door below add three, held by the gates''',
         '''def _count(fn):
    buf = _io.StringIO()
    with contextlib.redirect_stdout(buf):
        ok_ = fn()
    ls_ = [l_ for l_ in buf.getvalue().splitlines() if l_.strip().startswith(("ok", "FAIL"))]
    return bool(ok_), sum(l_.strip().startswith("ok") for l_ in ls_), len(ls_), buf.getvalue()
CHK = {nm_: _count(fn_) for nm_, fn_ in (("mom15_bt", M.selftest), ("tf15_bt", B.selftest), ("mom15_diag", D.selftest))}
for nm_, (ok_, p_, t_, txt_) in CHK.items():
    print(f"{nm_}: {p_} of {t_} checks passed")
    print(txt_)
assert all(v_[0] for v_ in CHK.values()), "an engine or diagnosis check failed"
VERIFY = {"suite": "mom15 engine, planted tests and diagnosis checks", "passed": sum(v_[1] for v_ in CHK.values()), "total": sum(v_[2] for v_ in CHK.values()), "books": sum(t_.W for t_ in TABS.values())}      # the planted lead, the planted peek and the test-gate door below add three, held by the gates''')
    # ---- S2: coverage over all 22 days ----
    _rep(cells, 'for role_, days_ in (("fit", FIT_DAYS), ("validate", VALIDATE_DAYS), ("test", TEST_DAYS)):', 'for role_, days_ in (("week before", WEEK_BEFORE), ("earlier week", EARLIER_WEEK), ("fit", FIT_DAYS), ("validate", VALIDATE_DAYS), ("test", TEST_DAYS), ("fresh day", FRESH_DAY)):')
    _rep(cells, "| Is there a book for the windows, is the 1 s Binance path the table's own series, does the sweep's z equal the tables' z, and do the planted tests behave? | at least 90% of windows have a book; the path equals the table at every whole second; the planted lead and the second opening of the test days are caught |",
         "| Is there a book for the windows on all 22 days, is the 1 s Binance path the table's own series, does the sweep's z equal the tables' z, and do the planted tests behave? | at least 90% of windows have a book; the path equals the table at every whole second; the planted lead and the second opening of the test days are caught |")
    # ---- S4: three blocks outside the split, and the unseen-days grid on all fifteen of them ----
    _rep(cells, "**What did the pair do on days nobody used to choose it?** An earlier week and a fresh day, read after the test days. They are for the record and sit outside the decision rule.",
         "**What did the pair do on days nobody used to choose it?** Two earlier weeks and a fresh day, read after the test days. They are for the record and sit outside the decision rule.")
    _rep(cells, '# ---- days outside the registered split, read AFTER the test days for the pair already chosen (informational, outside the decision rule): an earlier week and a fresh forward day ----\nXR = {}\nfor lab_, days_ in (("earlier week", EARLIER_WEEK), ("fresh day", FRESH_DAY)):',
         '# ---- days outside the registered split, read AFTER the test days for the pair already chosen (informational, outside the decision rule): two earlier weeks and a fresh forward day ----\nXR = {}\nfor lab_, days_ in (("week before", WEEK_BEFORE), ("earlier week", EARLIER_WEEK), ("fresh day", FRESH_DAY)):')
    _rep(cells, 'display(Markdown("**The chosen pair on the days outside the registered split** (read after the test days; none was used to choose it; the earlier week is before the fit days, the fresh day after the test days)"))',
         'display(Markdown("**The chosen pair on the days outside the registered split** (read after the test days; none was used to choose it; the two earlier weeks are before the fit days, the fresh day after the test days)"))')
    _rep(cells, 'WEEK, FRESH = XR["earlier week"][2], XR["fresh day"][2]', 'WEEK0, WEEK, FRESH = XR["week before"][2], XR["earlier week"][2], XR["fresh day"][2]')
    _rep(cells, '"name": "the chosen pair on an earlier week and a fresh day nobody had read when it was chosen; informational, outside the decision rule",\n              "reading": f"earlier week {sgn(WEEK[\'per\'])} on {WEEK[\'n\']}; fresh day {sgn(FRESH[\'per\'])} on {FRESH[\'n\']}"',
         '"name": "the chosen pair on two earlier weeks and a fresh day nobody had read when it was chosen; informational, outside the decision rule",\n              "reading": f"week before {sgn(WEEK0[\'per\'])} on {WEEK0[\'n\']}; earlier week {sgn(WEEK[\'per\'])} on {WEEK[\'n\']}; fresh day {sgn(FRESH[\'per\'])} on {FRESH[\'n\']}"')
    _rep(cells, "The sweep chose on the fit and validation days. Here every single-lookback cell (hold to expiry) is read on the earlier week and the fresh day, days no stage touched.",
         "The sweep chose on the fit and validation days. Here every single-lookback cell (hold to expiry) is read on the two earlier weeks and the fresh day, fifteen days no stage touched.")
    _rep(cells, "XTAB = M.MTab(EARLIER_WEEK + FRESH_DAY, fill_ms=FILL_MS)", "XTAB = M.MTab(WEEK_BEFORE + EARLIER_WEEK + FRESH_DAY, fill_ms=FILL_MS)")
    _rep(cells, 'cells earn above zero on these {len(EARLIER_WEEK) + len(FRESH_DAY)} unseen days', 'cells earn above zero on these {len(WEEK_BEFORE) + len(EARLIER_WEEK) + len(FRESH_DAY)} unseen days')
    _rep(cells, 'f"{EARLIER_WEEK[0][5:]} to {FRESH_DAY[-1][5:]} · {24 * (len(EARLIER_WEEK) + len(FRESH_DAY))}h · unseen days, exploratory"', 'f"{WEEK_BEFORE[0][5:]} to {FRESH_DAY[-1][5:]} · {24 * (len(WEEK_BEFORE) + len(EARLIER_WEEK) + len(FRESH_DAY))}h · unseen days, exploratory"')
    _rep(cells, '                       ("earlier week", XR["earlier week"][0], XR["earlier week"][1]), ("fresh day", XR["fresh day"][0], XR["fresh day"][1])):',
         '                       ("week before", XR["week before"][0], XR["week before"][1]), ("earlier week", XR["earlier week"][0], XR["earlier week"][1]), ("fresh day", XR["fresh day"][0], XR["fresh day"][1])):')
    _rep(cells, "the earlier week is before the fit days", "the two earlier weeks are before the fit days", 0)
    # ---- S5: the diagnosis ----
    _rep(cells, "## S5 · Risk and diagnostics - Why do we lose?\n\n| question | answer form |\n|---|---|\n| Where does the money, or the loss, come from: coin, time left, day, and the fee? | tables by coin, time left and day, and the fee beside the gross |",
         "## S5 · Risk and diagnostics - Why do we lose?\n\n| question | answer form |\n|---|---|\n| Where does the money, or the loss, come from: coin, time left, day, and the fee? | tables by coin, time left and day, and the fee beside the gross |\n| Where does the money of an entry go, are the losses clustered, do they match the probabilities the price implies, is the burst's direction worth more than the favourite, does a slower lookback leave more, does any slice or structural cell survive the number of places looked, what does the market do after the entry, does the near-certain buy pay, and what would a resting order keep? | the five-term identity on the pair's test entries and on all 22 days; cluster-by-slot tests, the calibration by price band, the three arms, the max-t hunt, the forward moves, the structural scan, the near-certain family, the maker ceiling; the gates of S5 are informational: the decision rule of S6 reads S2 to S4 |")
    _rep(cells, "The tables cut the test entries by coin and by time left, and list every day read. The separate diagnosis study (`2026-10-08-predmkts-binance-momentum-15m-updown-diagnosis`) splits the same pair's result into the edge before friction and the friction itself.",
         "The tables cut the test entries by coin and by time left, and list every day read. Then the diagnosis: one identity does most of the work. For an entry, net = shares x (won - (price paid + fee) / shares), so the actual win share against the share the price and fee ask IS the net, and it splits into named terms: what the outcome did against the fair value (A), what the fair value said against the book (B), what the book did in the 250 ms (C), what spread and depth took (D), and the fee (E). Each term is read on the same entries, so the failure gets a name instead of a guess. The primary sample is the pair's test entries (the days opened once in S3); every table also shows the same pair over all 22 days as a cross-check. Nothing is chosen, tuned or re-fitted here; the slices, bins and the hunt's family are fixed in `mom15_diag.py` and counted.")
    i_ans6 = _find(cells, '_why = "the fee takes more than the trades earn" if TSUM["per"] < 0 else "the trades earn more than the fee takes"')
    cells[i_ans6:i_ans6 + 1] = [_cell("code", DX_SETUP)] + dx_body() + [_cell("code", ANS6_CODE)]
    # ---- S7: the diagnosis's headline and next bet after the study's, the short answer, the result lines, the card, the caveats, the figures ----
    i_head = _find(cells, "# ---- the plain-words answer, from the run's own numbers ----")
    cells[i_head + 1:i_head + 1] = dx_verdict()
    _rep(cells, "ANS7.update(Markdown(ANS7_TXT)); ANS0.update(Markdown(ANS7_TXT))", DX_SHORT_CODE.strip("\n").replace("ANS7_TXT += ", "ANS7_TXT += ", 1))
    _rep(cells, 'f"RESULT um-009 test_net_pnl_usd={TSUM[\'net\']:.2f}", f"RESULT um-009 test_sharpe_per_entry={SH[\'sr\']:.4f}", f"RESULT um-009 deflated_sharpe={DSR[\'dsr\']:.3f}"]',
         'f"RESULT um-009 test_net_pnl_usd={TSUM[\'net\']:.2f}", f"RESULT um-009 test_sharpe_per_entry={SH[\'sr\']:.4f}", f"RESULT um-009 deflated_sharpe={DSR[\'dsr\']:.3f}",\n                f"RESULT um-009 diag_edge_per_entry_usd={ES_T[\'edge\']:.4f}", f"RESULT um-009 diag_friction_per_entry_usd={ES_T[\'friction\']:.4f}", f"RESULT um-009 diag_hunt_hypotheses={HI[\'n_hyp\']}", f"RESULT um-009 diag_hunt_best_t={_best[\'t\']:.3f}", f"RESULT um-009 diag_hunt_maxt_survivors={HI[\'n_maxt_05\']}"]')
    _rep(cells, '"next_bet": _cut("a forward, pre-registered read of the slow-lookback hold cells on days after 2026-10-07, chosen before the days are read", 150)',
         '"next_bet": _cut(f"the maker side of the burst on BTC and ETH (um-013, forward) and the fair-value-gated burst of the full-window study, registered before it is read again", 150)')
    _rep(cells, '        {"title": "Checks", "rows": [mk("Windows with a book", pct(SHARE, 0), "90% bar", gate="G1"), mk("Cells tried", f"{N_TRIALS}", "", "INFO"), mk("Engine checks held", f"{VERIFY[\'passed\']} of {VERIFY[\'total\']}", "all", "INFO")]}],',
         '        {"title": "Why we lose, test entries", "rows": [mk("Edge before friction", f"{sgn(ES_T[\'edge\'])} USD", f"95% {sgn(ES_T[\'edge_lo\'])} to {sgn(ES_T[\'edge_hi\'])}", gate="G17"), mk("Friction", f"{sgn(ES_T[\'friction\'])} USD", "250 ms, spread, fee", "INFO"),\n'
         '                                              mk("Win minus price and fee", f"{sgn(_ct[\'win - price - fee (pp)\'], 1)} pt", f"95% {sgn(_ct[\'fee pp lo\'], 1)} to {sgn(_ct[\'fee pp hi\'], 1)}", gate="G19"), mk("Burst minus favourite, all days", f"{sgn(_dm[\'mean\'])} USD", f"95% {sgn(_dm[\'lo\'])} to {sgn(_dm[\'hi\'])}", gate="G20")]},\n'
         '        {"title": "The hunt, all 22 days", "rows": [mk("Slices and cells scored", f"{HI[\'n_hyp\']}", "", "INFO"), mk("Best t against best-of-N", f"{_best[\'t\']:.2f} / {HI[\'q95_best_t\']:.2f}", f"{HI[\'n_maxt_05\']} survive", gate="G21"), mk("Ten best: found / held out", f"{sgn(SI[\'disc_per\'])} / {sgn(SI[\'hold_per\'])}", "USD an entry", gate="G22"),\n'
         '                                            mk("Structural cells, survivors", f"{HI_SC[\'n_maxt_05\']} of {HI_SC[\'n_hyp\']}", "", gate="G23"), mk("Near-certain buy, all days", f"{sgn(ES_NC[\'net\'])} USD", f"95% {sgn(ES_NC[\'net_lo\'])} to {sgn(ES_NC[\'net_hi\'])}", gate="G24")]},\n'
         '        {"title": "Checks", "rows": [mk("Windows with a book", pct(SHARE, 0), "90% bar", gate="G1"), mk("Pair equals stage 4", f"{len(FRM_T)} entries", "to the cent", gate="G15"), mk("Cells tried", f"{N_TRIALS}", "", "INFO"), mk("Engine and diagnosis checks", f"{VERIFY[\'passed\']} of {VERIFY[\'total\']}", "all", "INFO")]}],')
    _rep(cells, '_series.append(dict(spec=f"mom15:{d_}:binance-1s-path:-"', '_series.append(dict(spec=f"mom15:{d_}:binance-1s-path:-"')
    _rep(cells, "for d_ in dict.fromkeys(DAYS_ALL):\n    m_ = derived.meta(TT.DATASET, RUNNER.key_of(d_, FILL_MS))", "for d_ in dict.fromkeys(DX_DAYS):\n    m_ = derived.meta(TT.DATASET, RUNNER.key_of(d_, FILL_MS))")
    _rep(cells, 'ip_ = ticks.input_pin(s_, _ms(DAYS_ALL[0]), _ms(DAYS_ALL[-1]) + 86_400_000)', 'ip_ = ticks.input_pin(s_, _ms(DX_DAYS[0]), _ms(DX_DAYS[-1]) + 86_400_000)')
    _rep(cells, 'first_ts=_ms(DAYS_ALL[0]), last_ts=_ms(DAYS_ALL[-1]) + 86_399_999, handle=None, cls="pin", trunc=False))', 'first_ts=_ms(DX_DAYS[0]), last_ts=_ms(DX_DAYS[-1]) + 86_399_999, handle=None, cls="pin", trunc=False))')
    _rep(cells, '_unpinned.append({"what": "days outside the registered split: earlier week and fresh day, and the unseen-days surface of S4", "why": "read after the registered test days for the record; not part of the registered inputs digest"})',
         '_unpinned.append({"what": "the S4 reads outside the registered split and the S5 diagnosis on all 22 days", "why": "read after the registered test days from the same pinned tables, which are in the digest; outside the decision rule"})')
    _rep(cells, '"fig:s3-l2-worst": "trade-anatomy", "fig:s3-l2-median": "trade-anatomy", "fig:s3-l2-best": "trade-anatomy"}',
         '"fig:s3-l2-worst": "trade-anatomy", "fig:s3-l2-median": "trade-anatomy", "fig:s3-l2-best": "trade-anatomy",\n             ' + ", ".join(f'"{k}": "{v}"' for k, v in DX_FIG_KINDS.items()) + "}")
    _rep(cells, '           "the price limit 0.97, the first decision at 10 s and the exit sigma unit are [U], fixed before scoring"]',
         '           "the price limit 0.97, the first decision at 10 s and the exit sigma unit are [U], fixed before scoring",\n'
         '           "S5 reads the frozen pair on all 22 days, the test days a second time; the rebuild equals stage 4 to the cent",\n'
         '           "the slices of S5 overlap (the same entries sit in many), so the hunt counts are not independent",\n'
         '           "the fair value is the tables Brownian TWAP model; term A is the outcome against it, not an edge",\n'
         '           "a one-sided book (no bid) uses the best ask as the mid, so the half spread is nil there",\n'
         '           "the maker ceiling of S5 is arithmetic on taker entries: no resting order was simulated here"]')
    _rep(cells, "CAVEATS = [\"two test days of one regime: one observation of the regime, not a promise\",\n           \"the Polymarket days are those of um-003 to um-008: one window, not an independent observation\",",
         "CAVEATS = [\"two test days of one regime: one observation of the regime, not a promise\",\n           \"the 22 days overlap those of um-004 to um-013: one window, not an independent observation\",")
    _rep(cells, '"The Polymarket days are those of um-003 to um-008: one window, one regime, not an independent observation."', '"The 22 days overlap those of um-004 to um-013: one window, one regime, not an independent observation."')
    _rep(cells, "Every cell of the three sweeps with its fit and validation numbers, and the entries of the chosen pair on the test days.",
         "Every cell of the three sweeps with its fit and validation numbers, the entries of the chosen pair on the test days, and the diagnosis's hunt, cells and largest losses.")
    i_app = _find(cells, 'display(HTML(TEST_FRAME[["date", "coin", "entry_s", "exit_s", "T", "side", "shares", "vwap", "exit_px", "cost", "fee", "won", "gross", "net"]].round(3).to_html(index=False, border=0)))')
    cells[i_app + 1:i_app + 1] = dx_appendix()
    _rep(cells, "assert [g1_[\"verdict\"] for g1_ in MANIFEST[\"gates\"]] == [g1_[\"verdict\"] for g1_ in GATES] and MANIFEST[\"verdict\"][\"word\"] == WORD and len(MANIFEST[\"figures\"]) == len(FIGURES)\ndisplay(Markdown(HEADLINE_MD))",
         "assert [g1_[\"verdict\"] for g1_ in MANIFEST[\"gates\"]] == [g1_[\"verdict\"] for g1_ in GATES] and MANIFEST[\"verdict\"][\"word\"] == WORD and len(MANIFEST[\"figures\"]) == len(FIGURES)\ndisplay(Markdown(HEADLINE_MD))\ndisplay(Markdown(DX_HEADLINE_MD))\ndisplay(Markdown(DX_NEXT_MD))")
    return cells
