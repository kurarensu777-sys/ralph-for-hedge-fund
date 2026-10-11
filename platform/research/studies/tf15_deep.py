"""The deep-dive cells the two um-011 follow-ups share (2026-10-10): the grid read by dimension on the score the choice rule uses (the net an entry WITHOUT the
best 5% of entries), the train-against-validation trade-off, the best cells, then the chosen cell on the test days trade by trade (winners and losers by price
with the concentration panels, each coin, the entry prices, the biggest win and loss on the L2 book with the fill ladder), the reward-to-risk and concentration
gates, and for the far-token sale the split that says what is wrong with it. `cells(kind)` -> the list `tf15_nb.build` takes as spec["DEEP"]; kind is "near"
(buy the near token) or "far" (sell the far token). Every text goes through `tf15_nb.sub`, so @@DIMS@@ is the spec's."""
from __future__ import annotations

HEAD = r'''
### The deep dive: the grid by dimension, and the chosen cell trade by trade

The grid is read by the number the choice rule reads: the net an entry WITHOUT the best 5% of entries (the owner's rule, 2026-10-10: a few wins must not carry
everything). A dimension whose every level sits below zero on the train days and the validation days is one no setting rescues; the chosen cell is the qualified
cell (above zero on the train days by that number) with the best validation number.
'''

DIMS = r'''
import tf15_trade_figs as TF
SCORE_KEY = "per_ex_top5"
DIMS = @@DIMS@@
_cf = pd.DataFrame([{**c_["cfg"], "train": c_["train"].get(SCORE_KEY, np.nan), "validate": c_["validate"].get(SCORE_KEY, np.nan),
                     "train_per": c_["train"].get("per", np.nan), "validate_per": c_["validate"].get("per", np.nan),
                     "train_n": c_["train"].get("n", 0), "validate_n": c_["validate"].get("n", 0)} for c_ in CELLS]).set_index("name")
_both = int(((_cf["train"] > 0) & (_cf["validate"] > 0)).sum())
_ch = _cf.loc[CHOSEN["name"]]
_notes = [f"{len(_cf)} cells; {int((_cf['train'] > 0).sum())} earn without their best 5% on the train days, {int((_cf['validate'] > 0).sum())} on the validation days, {_both} on both.",
          f"The chosen cell {CHOSEN['name']}: {_ch['train']:+.3f} an entry without the best 5% on the train days ({int(_ch['train_n'])} entries) and {_ch['validate']:+.3f} on the validation days ({int(_ch['validate_n'])}); "
          f"with every entry {_ch['train_per']:+.3f} and {_ch['validate_per']:+.3f}.",
          "Each panel averages the score over every cell sharing the level, so a level's mean mixes the other dimensions; the gold band marks the chosen level."]
_days_txt = f"train {TRAIN_DAYS[0][5:]} to {TRAIN_DAYS[-1][5:]} ({24 * len(TRAIN_DAYS)}h), validate {VALIDATE_DAYS[0][5:]} to {VALIDATE_DAYS[-1][5:]} ({24 * len(VALIDATE_DAYS)}h)"
figstyle.show(TF.dimension_fig(CELLS, DIMS, CHOSEN, _days_txt, _notes, score_key=SCORE_KEY), "fig:s4-dims", FIGURES)
'''

TRADEOFF = r'''
_q = dict(both=int(((_cf["train"] > 0) & (_cf["validate"] > 0)).sum()), train_only=int(((_cf["train"] > 0) & (_cf["validate"] <= 0)).sum()),
          valid_only=int(((_cf["train"] <= 0) & (_cf["validate"] > 0)).sum()), neither=int(((_cf["train"] <= 0) & (_cf["validate"] <= 0)).sum()))
_notes = [f"Of {len(_cf)} cells, {_q['both']} earn without their best 5% on both the train and the validation days, {_q['train_only']} on the train days only, {_q['valid_only']} on the validation days only, {_q['neither']} on neither.",
          f"A grid whose top-right quadrant is empty has no setting that earns steadily on both windows; this one has {_q['both']}.",
          "The validation number of the chosen cell is the best of the qualified cells, so it is flattered by the choice; the test days are the read that is not."]
figstyle.show(TF.tradeoff_fig(CELLS, CHOSEN, _days_txt, _notes, score_key=SCORE_KEY), "fig:s4-tradeoff", FIGURES)
'''

TOP = r'''
_top = _cf[_cf["train"] > 0].sort_values("validate", ascending=False).head(15).reset_index()
display(Markdown("**The fifteen best qualified cells** (above zero without their best 5% on the train days, ranked by the same number on the validation days)"))
display(HTML(_top[["name", "train_n", "train", "train_per", "validate_n", "validate", "validate_per"]].round(3).to_html(index=False, border=0)))
'''

TEST_SUMMARY = r'''
# ---- the chosen cell on the test days: win rate, reward to risk, and whether a few wins carry it ----
_srt = np.sort(ENT["net"])[::-1]
_k5 = max(1, int(np.ceil(0.05 * TS["n"]))) if TS["n"] else 0
_top5 = float(_srt[:_k5].sum()) if _k5 else 0.0
display(Markdown(f"**Chosen cell {CHOSEN['name']} on the test days, the shape of the payoff.** Win rate {pct(TS['win'])} (Wilson 95% {pct(TS['win_lo'])} to {pct(TS['win_hi'])}) against "
                 f"{pct(TS['win_needed'])} this payoff needs (mean win {sgn(TS['avg_win'])} USD, mean loss {sgn(TS['avg_loss'])}); reward to risk {TS['rr']:.2f}, profit factor {TS['pf']:.2f}; "
                 f"each trade's own reward to risk {TS['rr_trade_mean']:.2f} on average (median {TS['rr_trade_median']:.2f}). "
                 f"Without the best 5% of entries ({_k5}, which made {sgn(_top5, 0)} USD of {sgn(TS['net'], 0)}) the net is {sgn(TS['per_ex_top5'], 3)} an entry; without the best 1% {sgn(TS['per_ex_top1'], 3)}, without the best 10% {sgn(TS['per_ex_top10'], 3)}. "
                 + ("**A few wins carry it.**" if TS["per_ex_top5"] <= 0 < TS["per"] else "**It survives without its best wins.**" if TS["per_ex_top5"] > 0 else "There is no edge to carry.")))
GATES.append({"id": "G13", "section": "S4", "label": "Survives without best 5%", "name": "the chosen cell's test net an entry stays above zero with its best 5% of entries taken out (a few wins must not carry everything)",
              "reading": f"{sgn(TS['per_ex_top5'], 3)} USD an entry without the best 5% ({_k5} entries made {sgn(_top5, 0)} of {sgn(TS['net'], 0)})", "verdict": "PASS" if TS["per_ex_top5"] > 0 else "FAIL",
              "would_change": "a net an entry above zero once the best 5% are out"})
GATES.append({"id": "G14", "section": "S4", "label": "Wins the needed rate", "name": "the test win rate is above the rate the cell's own mean win and mean loss need to break even",
              "reading": f"{pct(TS['win'])} against {pct(TS['win_needed'])} needed; reward to risk {TS['rr']:.2f}, each trade {TS['rr_trade_mean']:.2f}", "verdict": "PASS" if TS["win"] > TS["win_needed"] else "FAIL",
              "would_change": "a win rate under the rate the payoff needs"})
'''

WINLOSS = r'''
figstyle.show(TF.winloss_fig(ENT, list(TEST_DAYS), question="What do the chosen cell's winners and losers look like on the test days, and do a few wins carry it?"), "fig:s4-winloss", FIGURES)
'''

COINS = r'''
figstyle.show(TF.coin_panels_fig(ENT, list(TEST_DAYS), question="Does every coin carry the chosen cell on the test days, or one of them?"), "fig:s4-coins", FIGURES)
'''

ENTRYPX = r'''
figstyle.show(TF.entry_price_fig(ENT, list(TEST_DAYS), be=float(TS["breakeven"]), question="Do the chosen cell's entries that won buy cheaper than break-even?", s=30, edge=False), "fig:s4-entrypx", FIGURES)
'''

BIGWIN = r'''
_i = int(np.argmax(ENT["net"]))
figstyle.show(TF.anatomy_fig(TABS["test"], ENT, _i, list(TEST_DAYS), question=f"Why did the chosen cell's biggest test win make {ENT['net'][_i]:+.2f} USD?", usd=CLIP_USD), "fig:s4-bigwin", FIGURES)
_df, _cap = TF.ladder_table(TABS["test"], ENT, _i, usd=CLIP_USD)
display(Markdown("**" + _cap + "**"))
display(HTML(_df.round(4).to_html(index=False, border=0)))
'''

BIGLOSS = r'''
_i = int(np.argmin(ENT["net"]))
figstyle.show(TF.anatomy_fig(TABS["test"], ENT, _i, list(TEST_DAYS), question=f"Why did the chosen cell's biggest test loss cost {-ENT['net'][_i]:.2f} USD?", usd=CLIP_USD), "fig:s4-bigloss", FIGURES)
_df, _cap = TF.ladder_table(TABS["test"], ENT, _i, usd=CLIP_USD)
display(Markdown("**" + _cap + "**"))
display(HTML(_df.round(4).to_html(index=False, border=0)))
'''

TRADES = r'''
_ord = np.argsort(ENT["net"])
_tf = lambda idx: pd.DataFrame(dict(day=[TABS["test"].days[i] for i in ENT["day"][idx]], coin=[TF.COINS[i] for i in ENT["asset"][idx]], near=np.where(ENT["side"][idx] > 0, "Up", "Down"),
                                    second=(B.K0 + ENT["k"][idx]).astype(int), seconds_left=ENT["T"][idx].astype(int), price_paid=ENT["vwap"][idx], shares=ENT["shares"][idx],
                                    usd_at_risk=ENT["cost"][idx], fee=ENT["fee"][idx], sold_early=ENT["sold"][idx], won=ENT["won"][idx], net=ENT["net"][idx]))
display(Markdown("**The ten best test entries** (usd_at_risk: the cost of a buy, or the collateral of a sale; sold_early: shares sold at the exit second)"))
display(HTML(_tf(_ord[::-1][:10]).round(3).to_html(index=False, border=0)))
display(Markdown("**The ten worst test entries**"))
display(HTML(_tf(_ord[:10]).round(3).to_html(index=False, border=0)))
'''

WHY_FAR = r'''
# ---- what is wrong with selling the over-priced tail: the entries test A would also take against the ones only the far gate takes, and the leverage by far price ----
_m = CANDS._gates(TABS["test"], CHOSEN["L"], CHOSEN["z_min"], CHOSEN["theta"])
_w, _k = ENT["w"], ENT["k"]
_a_gate = np.where(ENT["side"] > 0, _m["nup_up"][_w, _k], _m["nup_dn"][_w, _k])          # does the near token's ASK also sit under fair (test A's gate)?
def _r(label_, mask_):
    s_ = B.summarize(B.subset(ENT, mask_), TABS["test"], label_)
    if not s_.get("n"):
        return dict(split=label_, n=0)
    return dict(split=label_, n=s_["n"], win_pct=s_["win"] * 100, win_needed_pct=s_["win_needed"] * 100, per_entry=s_["per"], lo=s_["per_lo"], hi=s_["per_hi"], per_ex_best5=s_["per_ex_top5"],
                reward_to_risk=s_["rr"], rr_per_trade=s_["rr_trade_mean"], mean_usd_at_risk=float(ENT["cost"][mask_].mean()), max_x_clip=float(ENT["cost"][mask_].max() / CLIP_USD), net=s_["net"])
SPLIT = pd.DataFrame([_r("near ask also under fair (test A would enter)", _a_gate), _r("only the far ask over fair (the near bid under fair, the ask not)", ~_a_gate)])
display(Markdown("**Where the sale's money comes from: the overlap with test A's gate**"))
display(HTML(SPLIT.round(3).to_html(index=False, border=0)))
_farpx = 1.0 - ENT["vwap"]
_edges = [(0.0, 0.10), (0.10, 0.20), (0.20, 0.30), (0.30, 0.50), (0.50, 1.01)]
FARPX = pd.DataFrame([_r(f"far sold at {lo_:.2f} to {hi_:.2f}", (_farpx >= lo_) & (_farpx < hi_)) for lo_, hi_ in _edges])
display(Markdown("**By the far token's sale price** (the cheaper the far token, the more shares a far-dollar clip sells and the more collateral sits at risk)"))
display(HTML(FARPX.round(3).to_html(index=False, border=0)))
_only = SPLIT.iloc[1]; _also = SPLIT.iloc[0]
WHY_MD = (f"**What is wrong with selling the over-priced tail.** On the test days the chosen cell's entries split into {int(_also['n'])} the near-ask gate (test A) would also take, at {sgn(_also['per_entry'])} an entry "
          f"({sgn(_also['per_ex_best5'], 3)} without the best 5%), and {int(_only['n'])} only the far gate takes, at {sgn(_only['per_entry'])} an entry ({sgn(_only['per_ex_best5'], 3)} without the best 5%). "
          + ("The looser gate adds entries that lose: the far ask over fair is the near bid under fair, a cent or two short of the price a buyer pays. " if _only.get("per_entry", 0) < _also.get("per_entry", 0) else "The looser gate's own entries earn as much as the overlap: the gate is not the fault. ")
          + f"Sizing: the far-dollar clip puts up to {FARPX['max_x_clip'].max():.1f}x the clip at risk on the cheapest tails; the collateral sizing in this grid ({'chosen' if CHOSEN['size'] == 'collateral' else 'not chosen'}) caps that at the clip.")
display(Markdown(WHY_MD))
'''


def cells(kind: str) -> list:
    out = [("md", HEAD), ("code", DIMS, "fig:s4-dims"), ("code", TRADEOFF, "fig:s4-tradeoff"), ("code", TOP), ("code", TEST_SUMMARY),
           ("code", WINLOSS, "fig:s4-winloss"), ("code", COINS, "fig:s4-coins"), ("code", ENTRYPX, "fig:s4-entrypx"),
           ("code", BIGWIN, "fig:s4-bigwin"), ("code", BIGLOSS, "fig:s4-bigloss"), ("code", TRADES)]
    if kind == "far":
        out.append(("code", WHY_FAR))
    return out



def cells_btc() -> list:
    """The um-017 cells: one cell on one coin, so no grid panels and no coin panels; the payoff shape with G13 and G14, the winners and losers, the entry
    prices, the biggest win and loss on the book, and the trades."""
    return [("code", "import tf15_trade_figs as TF"), ("code", TEST_SUMMARY), ("code", WINLOSS, "fig:s4-winloss"), ("code", ENTRYPX, "fig:s4-entrypx"),
            ("code", BIGWIN, "fig:s4-bigwin"), ("code", BIGLOSS, "fig:s4-bigloss"), ("code", TRADES)]

FIG_KINDS = {"fig:s4-dims": "parameter-surface", "fig:s4-tradeoff": "out-of-sample-test", "fig:s4-winloss": "win-loss-distribution", "fig:s4-coins": "equity-curve",
             "fig:s4-entrypx": "calibration", "fig:s4-bigwin": "trade-anatomy", "fig:s4-bigloss": "trade-anatomy"}


# ============================================================ the tradeable-rule cells (um-016): the loss anatomy of the base rule, the families, the exits, the live form
HEAD2 = r'''
### Why the base rule loses: the loss anatomy on the train days

The base cell (um-014's choice, nothing layered) on the 13 train days, every entry marked on the near token's bid until expiry: where the losses sit
(time of day, time left, price paid, spread, burst size, fair gap, level), how far each trade ran for and against before it closed, and what a price
stop would have done. The train days are in-sample by construction: this section explains, it does not score.
'''

ANATOMY = r'''
import tf15_exits as X, tf15_signals as SG
_tt = TABS["train"]
BASE_CFG = CAND.grid()[0]
assert CANDS.family_of(BASE_CFG["name"]) == "base", BASE_CFG["name"]
E_BASE = CAND.run(_tt, BASE_CFG, RES["ctx"])
S_BASE = B.summarize(E_BASE, _tt, "base")
EXC = X.excursions(_tt, E_BASE)
_w, _k, _side = E_BASE["w"], E_BASE["k"], E_BASE["side"]
_sg = CANDS.layer_signals(_tt)
AN = pd.DataFrame(dict(coin=[TF.COINS[i] for i in E_BASE["asset"]], hour=_sg["hour"][_w], T=E_BASE["T"], paid=E_BASE["vwap"],
                       spread_c=_sg["spread"][_w, _k], gap=np.where(_side > 0, _tt.pu[_w, _k], 1 - _tt.pu[_w, _k]).astype(float) - np.where(_side > 0, _tt.qa[_w, _k], 1 - _tt.qb[_w, _k]).astype(float),
                       z10=_tt.zl[_w, _k, 0] * _side, level=_sg["level"][_w, _k] * _side, rsi=np.where(_side > 0, _sg["rsi"][_w, _k], 100 - _sg["rsi"][_w, _k]),
                       iz=_sg["iz"][_w, _k], won=E_BASE["won"], net=E_BASE["net"], mae=EXC["mae"], mfe=EXC["mfe"], mae_s=EXC["mae_s"]))
def _split(col, bins):
    g_ = pd.cut(AN[col], bins)
    t_ = AN.groupby(g_, observed=True).agg(n=("net", "size"), win=("won", "mean"), per=("net", "mean"), net=("net", "sum")).reset_index().rename(columns={col: "bucket"})
    return t_
SPLITS = {"UTC hour": _split("hour", [-1, 5, 11, 17, 23]), "seconds left": _split("T", [120, 200, 300, 450, 600, 800, 900]), "price paid": _split("paid", [0.4, 0.5, 0.6, 0.7, 0.8, 0.85]),
          "Up spread, cents": _split("spread_c", [-100, 0.5, 1.5, 2.5, 5, 100]), "burst z (10 s)": _split("z10", [4, 4.5, 5, 6, 8, 30]), "fair minus ask": _split("gap", [0.08, 0.10, 0.12, 0.15, 0.2, 1.0]),
          "level z with the burst": _split("level", [-30, 0, 1, 2, 3, 30]), "RSI(14) in the burst's direction": _split("rsi", [-1, 50, 70, 80, 90, 101])}
_worst = sorted(((n_, t_.loc[t_["per"].idxmin()]) for n_, t_ in SPLITS.items() if len(t_)), key=lambda x: x[1]["per"])[:3]
_notes = [f"Base cell on the train days: {S_BASE['n']} entries, {sgn(S_BASE['per'])} USD an entry, win {pct(S_BASE['win'])}, {sgn(S_BASE['per_ex_top5'], 3)} without the best 5%.",
          "The worst buckets: " + "; ".join(f"{n_} {r_['bucket']} at {r_['per']:+.2f} an entry on {int(r_['n'])}" for n_, r_ in _worst) + ".",
          "A bucket with few entries is colour, not a number; the families below test each split as a filter, chosen on the validation days, not here."]
figstyle.show(TF.split_fig(SPLITS, list(TRAIN_DAYS), _notes), "fig:s4-splits", FIGURES)
'''

MAEMFE = r'''
_L = AN[~AN.won]; _W = AN[AN.won]
_notes = [f"{len(AN)} entries: losers' worst mark a median {_L.mae.median():+.2f} USD and best mark {_L.mfe.median():+.2f} (they were up before they lost); winners' worst mark a median {_W.mae.median():+.2f}.",
          f"Losers whose near bid fell 10 cents under the price paid: {pct((_L.mae <= -0.10 * E_BASE['shares'][~AN.won.to_numpy()]).mean(), 0)}; winners: {pct((_W.mae <= -0.10 * E_BASE['shares'][AN.won.to_numpy()]).mean(), 0)}: a binary token's bid swings that much on noise, so a tight price stop sells winners.",
          f"The worst mark comes a median {int(_L.mae_s.median())} s after entry for losers and {int(_W.mae_s.median())} s for winners."]
figstyle.show(TF.mae_mfe_fig(AN.mae, AN.mfe, AN.net, list(TRAIN_DAYS), _notes), "fig:s4-maemfe", FIGURES)
'''

STOPS = r'''
# ---- what a price stop, a level stop, a take-profit and a retrace exit do to the base rule on the train days (the exits module: real bid ladder, fee on the sale) ----
_variants = {}
for lab_, cond_ in (("bid_stop 0.05", X.bid_stop(_tt, E_BASE, 0.05)), ("bid_stop 0.10", X.bid_stop(_tt, E_BASE, 0.10)), ("bid_stop 0.20", X.bid_stop(_tt, E_BASE, 0.20)),
                    ("level_stop 0.30", X.level_stop(_tt, E_BASE, 0.30)), ("take_profit 0.95", X.take_profit(_tt, E_BASE, 0.95)), ("take_profit 0.90", X.take_profit(_tt, E_BASE, 0.90)),
                    ("retrace 50%", X._rowmat(np.nan_to_num(_sg["retrace"][_w], nan=0.0) >= 0.5)), ("fair_stop 0", X.fair_stop(_tt, E_BASE, 0.0))):
    ke_ = X.exit_second(_tt, E_BASE, cond_, min_hold=1)
    _variants[lab_] = X.apply_exit(_tt, E_BASE, ke_, reason=np.array([lab_ if k_ >= 0 else "hold" for k_ in ke_], dtype=object))
EXITS_BASE = X.exit_report(_tt, E_BASE, _variants)
display(Markdown("**Exits on the base rule, train days** (exit_worth: the net of the exited trades with the exit minus the same trades held; the rest of the columns on every entry)"))
display(HTML(EXITS_BASE.round(3).to_html(border=0)))
_best_exit = EXITS_BASE["worth_per"].idxmax() if "worth_per" in EXITS_BASE else None
display(Markdown(f"**Reading.** " + (f"The exit worth the most on the train days is {_best_exit} ({EXITS_BASE.loc[_best_exit, 'worth_per']:+.2f} USD an exited entry); " if _best_exit is not None else "")
                 + "a price stop that fires on noise sells winners and pays the spread twice, so the exits that can help are the ones that read a fact about the trade, not its mark: a level the near token should not reach, or the burst giving its move back. The grid tests three of them as cells, on the validation days."))
'''

FAMILY_HEAD = r'''
### The families: each filter and each exit on its own, on the train days

Every family's cells are in the registered grid (chosen on the validation days by the net without the best 5%); here each family's best cell is shown on
the TRAIN days with the full chart set, so the reader sees what the filter does to the trades. In-sample by construction.
'''

FAMILY = r'''
FAM = "@@FAM@@"
_fam_cells = [c_ for c_ in CELLS if CANDS.family_of(c_["cfg"]["name"]) in @@FAM_SET@@]
_rows = [dict(cell=c_["cfg"]["name"], train_n=c_["train"].get("n", 0), train_ex5=c_["train"].get("per_ex_top5", np.nan), train_per=c_["train"].get("per", np.nan),
              valid_n=c_["validate"].get("n", 0), valid_ex5=c_["validate"].get("per_ex_top5", np.nan), valid_per=c_["validate"].get("per", np.nan)) for c_ in _fam_cells]
_ft = pd.DataFrame(_rows).sort_values("valid_ex5", ascending=False)
display(Markdown(f"**Family {FAM}: its cells** (base cell for reference: train {_cf.loc[CAND.grid()[0]['name'], 'train']:+.3f}, validation {_cf.loc[CAND.grid()[0]['name'], 'validate']:+.3f} without the best 5%)"))
display(HTML(_ft.round(3).to_html(index=False, border=0)))
_q = _ft[(_ft.train_ex5 > 0) & (_ft.train_n >= 30) & (_ft.valid_n >= 30)]
_pick = (_q if len(_q) else _ft).iloc[0]["cell"]
FAM_CFG = next(c_["cfg"] for c_ in _fam_cells if c_["cfg"]["name"] == _pick)
E_FAM = CAND.run(_tt, FAM_CFG, RES["ctx"])
S_FAM = B.summarize(E_FAM, _tt, _pick)
display(Markdown(f"**Shown: {_pick}** on the train days: {S_FAM['n']} entries, {sgn(S_FAM['per'])} an entry (95% by slot {sgn(S_FAM['per_lo'])} to {sgn(S_FAM['per_hi'])}), win {pct(S_FAM['win'])} against {pct(S_FAM['win_needed'])} needed, "
                 f"{sgn(S_FAM['per_ex_top5'], 3)} without the best 5%; the base cell {sgn(S_BASE['per'])} on {S_BASE['n']} ({sgn(S_BASE['per_ex_top5'], 3)} without the best 5%)."))
'''
FAMILY_FIGS = [("equity", r'''figstyle.show(TF.equity_fig(E_FAM, list(TRAIN_DAYS), question=f"How does the {FAM} family's best cell build the account on the train days?"), "fig:s4-f@@TAG@@-equity", FIGURES)'''),
               ("winloss", r'''figstyle.show(TF.winloss_fig(E_FAM, list(TRAIN_DAYS), question=f"What do the {FAM} family's winners and losers look like, and do a few wins carry it?"), "fig:s4-f@@TAG@@-winloss", FIGURES)'''),
               ("coins", r'''figstyle.show(TF.coin_panels_fig(E_FAM, list(TRAIN_DAYS), question=f"Does every coin carry the {FAM} family's best cell, or one of them?"), "fig:s4-f@@TAG@@-coins", FIGURES)'''),
               ("entrypx", r'''figstyle.show(TF.entry_price_fig(E_FAM, list(TRAIN_DAYS), be=float(S_FAM["breakeven"]), question=f"Do the {FAM} family's entries that won buy cheaper than break-even?", s=22, edge=False), "fig:s4-f@@TAG@@-entrypx", FIGURES)''')]

FAMILIES2 = [("time", {"time"}, "time"), ("hour", {"hour"}, "hour"), ("book", {"spread", "gap", "book"}, "book"), ("rsi", {"rsi"}, "rsi"), ("level", {"level"}, "level"), ("flow", {"flow"}, "flow"), ("exit", {"exit"}, "exit")]

CHOSEN_EXITS = r'''
# ---- the chosen cell with each exit, on the train days: is its exit the right one ----
_cfgs = {ex_: {**CHOSEN, "exit": ex_, "name": CHOSEN["name"].rsplit("|", 1)[0] + "|" + ex_} for ex_ in CANDS.LAYER_EXITS}
_ents = {ex_: CAND.run(_tt, c_, RES["ctx"]) for ex_, c_ in _cfgs.items()}
_base_e = _ents["expiry"]
CHOSEN_EXITS = X.exit_report(_tt, _base_e, {ex_: e_ for ex_, e_ in _ents.items() if ex_ != "expiry"})
display(Markdown(f"**The chosen cell's entry with each exit, train days** (the registered exit is {CHOSEN['exit']})"))
display(HTML(CHOSEN_EXITS.round(3).to_html(border=0)))
'''

LIVE = r'''
# ---- the implementation-ready form: the chosen cell replayed second by second through the live rule, on the test days, against the vectorized engine ----
LIVE_OK, LIVE_MSG, LIVE_SPEC, LIVE_WORDS = False, "", None, ""
try:
    import tf15_live as LV
    _rule = LV.LayeredRule.from_cfg(CHOSEN)
    _t0 = time.time()
    _live = LV.replay(TABS["test"], _rule, LAT_MS, order="slot")
    _rep = LV.agree(ENT, _live)
    LIVE_OK = bool(_rep.get("agree", _rep) if isinstance(_rep, dict) else _rep)
    LIVE_MSG = str(_rep)[:600] + f" ({time.time() - _t0:.0f} s for {len(TEST_DAYS)} days)"
    LIVE_SPEC = LV.to_spec(_rule)
    LIVE_WORDS = LV.explain(_rule)
except Exception as _e:                                           # noqa: BLE001 - the gate reports the failure, the notebook goes on
    LIVE_MSG = f"the live replay did not run: {type(_e).__name__}: {str(_e)[:300]}"
display(Markdown("**The rule as an execution engine would load it.** " + (LIVE_WORDS if LIVE_WORDS else "(no live form available)")))
if LIVE_SPEC is not None:
    display(Markdown("```json\n" + json.dumps(LIVE_SPEC, indent=2)[:3000] + "\n```"))
display(Markdown(f"**Agreement with the vectorized engine on the test days:** {LIVE_MSG}"))
GATES.append({"id": "G15", "section": "S4", "label": "Live replay agrees", "name": "the chosen cell replayed second by second through the live rule (no look-ahead, the same fills) gives the same entries, exits and net as the vectorized engine on the test days",
              "reading": LIVE_MSG[:200], "verdict": "PASS" if LIVE_OK else "FAIL", "would_change": "a live form that cannot reproduce the backtest"})
'''


def cells_near2() -> list:
    """The um-016 cells: the standard deep-dive block, then the loss anatomy, the families with their charts, the chosen cell's exits, and the live form."""
    out = cells("near")
    out += [("md", HEAD2), ("code", ANATOMY, "fig:s4-splits"), ("code", MAEMFE, "fig:s4-maemfe"), ("code", STOPS), ("md", FAMILY_HEAD)]
    for fam, fam_set, tag in FAMILIES2:
        out.append(("code", FAMILY.replace("@@FAM@@", fam).replace("@@FAM_SET@@", repr(fam_set))))
        for suffix, code in FAMILY_FIGS:
            out.append(("code", code.replace("@@TAG@@", tag), f"fig:s4-f{tag}-{suffix}"))
    out += [("code", CHOSEN_EXITS), ("code", LIVE)]
    return out


FIG_KINDS2 = dict(FIG_KINDS)
FIG_KINDS2.update({"fig:s4-splits": "regime-and-concentration", "fig:s4-maemfe": "mae-mfe"})
for _fam, _set, _tag in FAMILIES2:
    FIG_KINDS2.update({f"fig:s4-f{_tag}-equity": "equity-curve", f"fig:s4-f{_tag}-winloss": "win-loss-distribution", f"fig:s4-f{_tag}-coins": "equity-curve", f"fig:s4-f{_tag}-entrypx": "calibration"})


FIG_KINDS_BTC = {k: v for k, v in FIG_KINDS.items() if k in ("fig:s4-winloss", "fig:s4-entrypx", "fig:s4-bigwin", "fig:s4-bigloss")}


COMBO_HEAD = r'''
### Which confirming signals and which exits earn, read on the train and validation days only

Every number below is a train or validation read; the test days enter only through the chosen cell. A signal's row pools every entry rule held to expiry that
contains it; a pair's row is the one cell. The score is the net an entry without the best 5% of entries.
'''

COMBO_SIGS = r'''
import tf15_cands as _TC
_ex = _cf[_cf["exit"] == "expiry"].copy()
_ex["sig_txt"] = [("+".join(s_) if len(s_) else "burst") for s_ in _ex["sigs"]]
_rows = []
for k_, (fam_, txt_) in _TC.COMBO_SIGNALS.items():
    m_ = _ex["sigs"].apply(lambda s_: k_ in s_)
    _rows.append(dict(signal=k_, family=fam_, meaning=txt_, cells=int(m_.sum()), train_mean=float(_ex.loc[m_, "train"].mean()), validate_mean=float(_ex.loc[m_, "validate"].mean()),
                      both_above_zero=int(((_ex.loc[m_, "train"] > 0) & (_ex.loc[m_, "validate"] > 0)).sum())))
_m0 = _ex["sigs"].apply(len) == 0
_rows.append(dict(signal="(burst and gate alone)", family="", meaning="no confirming signal", cells=int(_m0.sum()), train_mean=float(_ex.loc[_m0, "train"].mean()),
                  validate_mean=float(_ex.loc[_m0, "validate"].mean()), both_above_zero=int(((_ex.loc[_m0, "train"] > 0) & (_ex.loc[_m0, "validate"] > 0)).sum())))
SIGT = pd.DataFrame(_rows).sort_values("validate_mean", ascending=False)
display(Markdown("**Each confirming signal, pooled over every entry rule held to expiry that contains it** (mean score of those cells; both_above_zero counts cells above zero on train and on validation)"))
display(HTML(SIGT.round(3).to_html(index=False, border=0)))
_pairs = _ex[(_ex["sigs"].apply(len) == 2) & (_ex["train_n"] >= 30) & (_ex["validate_n"] >= 30)]
_pairs = _pairs.assign(worst=np.minimum(_pairs["train"], _pairs["validate"])).sort_values("worst", ascending=False).head(20).reset_index()
display(Markdown("**The twenty two-signal entry rules with the best WORSE of train and validation** (at least 30 entries on each; ranked by the lower of the two scores, so a rule must earn on both)"))
display(HTML(_pairs[["name", "train_n", "train", "validate_n", "validate", "worst"]].round(3).to_html(index=False, border=0)))
'''

COMBO_EXITS = r'''
_one = _cf[_cf["sigs"].apply(len) <= 1].copy()
_one["rule"] = [n_.rsplit("|", 1)[0] for n_ in _one.index]
_base = _one[_one["exit"] == "expiry"].set_index("rule")
_xr = []
for ex_ in _TC.COMBO_EXITS[1:]:
    e_ = _one[_one["exit"] == ex_].set_index("rule")
    j_ = e_.join(_base[["train", "validate"]], rsuffix="_hold")
    _xr.append(dict(exit=ex_, rules=len(j_), train_mean=float(j_["train"].mean()), train_hold=float(j_["train_hold"].mean()), validate_mean=float(j_["validate"].mean()),
                    validate_hold=float(j_["validate_hold"].mean()), beats_hold_on_both=int(((j_["train"] > j_["train_hold"]) & (j_["validate"] > j_["validate_hold"])).sum())))
EXT = pd.DataFrame(_xr)
display(Markdown("**Each exit against holding to expiry, over the entry rules with at most one confirming signal** (mean score with the exit and held; beats_hold_on_both counts rules where the exit beats holding on train and on validation)"))
display(HTML(EXT.round(3).to_html(index=False, border=0)))
'''


def cells_combo() -> list:
    """The um-018 cells: the standard deep-dive block, then each confirming signal's pooled read with the best two-signal rules, then each exit against holding."""
    return cells("near") + [("md", COMBO_HEAD), ("code", COMBO_SIGS), ("code", COMBO_EXITS)]


# ============================================================ the steady-climb cells (um-020)
STEADY_HEAD = r'''
### Steady or jumpy: the shape of each variant's climb on the train days

The owner's criterion (2026-10-10): a rule whose PnL climbs steadily, not in jumps. Each dimension's best cell by the daily Sharpe on the validation days
(among cells above zero without their best 5% on both windows) is drawn here on the TRAIN days with its straight-line fit: the closer the step curve hugs
the line, the steadier the climb. The captions carry the fit (r2), the share of trading days above zero and the deepest dip. In-sample by construction.
'''

STEADY_CURVES = r'''
import tf15_trade_figs as TF
_tt = TABS["train"]
_fam = {}
for c_ in CELLS:
    f_ = CANDS.steady_family_of(c_["cfg"]["name"])
    sc_ = CANDS.steady_score(c_["validate"]) if CANDS.steady_score(c_["train"]) > -1e8 else -1e9
    if f_ not in _fam or sc_ > _fam[f_][1]:
        _fam[f_] = (c_["cfg"], sc_)
_order = ["base", "coin", "band", "slot", "z", "theta", "time", "joint"]
CURVES = {}
STEADY_ROWS = []
for f_ in _order:
    if f_ not in _fam:
        continue
    cfg_, sc_ = _fam[f_]
    e_ = CAND.run(_tt, cfg_, RES["ctx"])
    s_ = B.summarize(e_, _tt, cfg_["name"])
    if not s_.get("n"):
        continue
    CURVES[f"{f_}: {cfg_['name'].rsplit('|', 1)[0]}"] = (e_, s_)
    STEADY_ROWS.append(dict(family=f_, cell=cfg_["name"], n=s_["n"], per=s_["per"], lo=s_["per_lo"], hi=s_["per_hi"], per_ex_best5=s_["per_ex_top5"], win=s_["win"], sharpe_daily=s_["sharpe_daily"],
                            eq_r2=s_["eq_r2"], days_pos=s_["days_pos"], max_dd=s_["max_dd"], dd_over_net=s_["dd_over_net"], top5_share=s_["top5_share"]))
STEADY = pd.DataFrame(STEADY_ROWS)
display(Markdown("**The best cell of each dimension on the train days** (chosen within the dimension by the validation daily Sharpe; eq_r2: the fit of the equity line to a straight line; days_pos: the share of trading days above zero; dd_over_net: the deepest dip as a share of the net)"))
display(HTML(STEADY.round(3).to_html(index=False, border=0)))
_best = STEADY.sort_values("sharpe_daily", ascending=False).iloc[0] if len(STEADY) else None
_notes = ([f"The steadiest climb on the train days is {_best['cell']}: r2 {_best['eq_r2']:.2f}, {_best['days_pos']:.0%} of days above zero, deepest dip {_best['max_dd']:.0f} USD against {_best['per']:+.2f} an entry on {int(_best['n'])}."] if _best is not None else []) + [
    "A narrower, higher price band buys smaller wins more often; one order a slot removes the four coins bursting together; Bitcoin alone removes the thin books. Each costs entries.",
    "The straight line is the ideal the owner named; the red shading is every dip below the running peak, the thing a steady rule does not do."]
figstyle.show(TF.steady_fig(CURVES, list(TRAIN_DAYS), _notes), "fig:s4-steady", FIGURES)
'''

STEADY_TEST = r'''
# ---- the chosen cell's climb on the test days, and the steadiness gate ----
_eq_ok = bool(TS.get("eq_r2", float("nan")) >= 0.5 and TS.get("days_pos", 0) >= 0.6 and np.isfinite(TS.get("top5_share", float("nan"))) and TS["top5_share"] <= 0.40)
display(Markdown(f"**The chosen cell's climb on the test days.** Equity-line fit r2 {TS.get('eq_r2', float('nan')):.2f} (slope t {TS.get('eq_slope_t', float('nan')):.1f}), {TS.get('days_pos', float('nan')):.0%} of trading days above zero, "
                 f"deepest dip {TS.get('max_dd', float('nan')):.0f} USD ({TS.get('dd_over_net', float('nan')):.0%} of the net), the best 5% of entries hold {TS.get('top5_share', float('nan')):.0%} of the net, daily Sharpe {TS.get('sharpe_daily', float('nan')):+.1f}."))
GATES.append({"id": "G16", "section": "S4", "label": "Climbs steadily", "name": "on the test days the equity line fits a straight line with r2 at least 0.5, at least 60% of trading days are above zero, and the best 5% of entries hold at most 40% of the net (a steady climb, not jumps: the owner's rule)",
              "reading": f"r2 {TS.get('eq_r2', float('nan')):.2f}, days above zero {TS.get('days_pos', float('nan')):.0%}, best 5% hold {TS.get('top5_share', float('nan')):.0%}", "verdict": "PASS" if _eq_ok else "FAIL",
              "would_change": "a jumpier curve, or a net that sits in a few entries"})
figstyle.show(TF.steady_fig({f"chosen on the test days: {CHOSEN['name'].rsplit('|', 1)[0]}": (ENT, TS)}, list(TEST_DAYS), [f"{TS['n']} entries over {len(TEST_DAYS)} test days: {sgn(TS['per'])} an entry, r2 {TS.get('eq_r2', float('nan')):.2f}, {TS.get('days_pos', float('nan')):.0%} of days above zero, deepest dip {TS.get('max_dd', float('nan')):.0f} USD."],
                            question="Does the chosen cell climb steadily on the test days?"), "fig:s4-steady-test", FIGURES)
'''


def cells_steady() -> list:
    """The um-020 cells: the standard deep-dive block, the steady-or-jumpy small multiples by dimension, the chosen cell's climb and the steadiness gate, the live form."""
    out = cells("near")
    out += [("md", STEADY_HEAD), ("code", STEADY_CURVES, "fig:s4-steady"), ("code", STEADY_TEST, "fig:s4-steady-test"), ("code", LIVE)]
    return out


FIG_KINDS_STEADY = dict(FIG_KINDS)
FIG_KINDS_STEADY.update({"fig:s4-steady": "equity-curve", "fig:s4-steady-test": "equity-curve"})
