"""The owner's follow-up of 2026-10-10 on the full-window re-score (um-012): cells that `mom15_full.patch` adds to the full-window notebook only. An entry-rule family in S5 (five base
signals x 21 gates on the book, the fair value and the clock, read on the discovery days, the hold-out days and one fresh day, every cell counted, nothing chosen) and a raw-data rebuild
gate in S2 (twelve entries rebuilt from the pinned ladders, the market rows and the Binance trades with an independent walk). Words and cell sources only; every number is computed by
the notebook from `mom15_*`, `mom15_diag` and the decision tables. `patch_tweaks(cells)` edits the cells in place and asserts that every edit found its text.
"""
from __future__ import annotations

from nbformat.v4 import new_code_cell, new_markdown_cell


def _rep(cells, old, new, n=1):
    hits = sum(c.source.count(old) for c in cells)
    assert hits == n, f"expected {n} of {old[:70]!r}, found {hits}"
    for c in cells:
        c.source = c.source.replace(old, new)


def _after(cells, anchor, new_cells):
    ix = [i for i, c in enumerate(cells) if anchor in c.source]
    assert len(ix) == 1, f"{len(ix)} cells hold {anchor[:60]!r}"
    cells[ix[0] + 1:ix[0] + 1] = new_cells


def _cell(kind, src, tags=()):
    c = new_code_cell(src.strip("\n")) if kind == "code" else new_markdown_cell(src.strip("\n"))
    if tags:
        c.metadata["tags"] = list(tags)
    return c


TW_MD1 = r'''
### What entry rule would make it pay?
'''

TW_ANS = r'''
ANS8 = display(Markdown("_The answer is written here when the run reaches the entry-rule family._"), display_id=True)
'''

TW_MD2 = r'''
The pair is cost-bound: a real edge before friction, a taker's friction that is larger. The question that followed the re-score (the owner's note of 2026-10-10) is whether any change to the ENTRY rule leaves money after costs. One family of entry rules is scored here on the 22 days: five base signals (the frozen one-second burst at z 2.5 and at z 4, the ten-second burst at z 3, the one-minute move at z 2.5 and the three-minute move at z 3 this study chose), each under 21 gates, every cell held to expiry at the exact ladder 250 ms later with the fee. A gate reads only what the trader sees at the decision second: the spread, the depth at the touch, the price of the token, the Brownian fair value against the ask, the time left, which side the fair value favours, whether the book has already moved over the lookback, whether the burst persisted a second, and a limit at the ask seen (no chasing). Three readings per cell: the first fourteen days (discovery, the days the stages fitted and validated on), the last eight (hold-out, the test week opened above for the chosen pair), and 2026-10-08, one fresh day pinned and seated after this study's test read and not read until this build. Every cell is counted, the best-of-N line is drawn, and nothing is chosen as a result: a cell that looks good here is a candidate for a forward, pre-registered run.
'''

TW_CODE_FAMILY = r'''
# ---- the entry-rule family: five base signals x 21 gates on the 22-day table XTAB (discovery and hold-out are date cuts of it) and on the fresh day ----
t0 = time.time()
ROLES_TW = {d_: ("discovery" if d_ in FIT_DAYS + VALIDATE_DAYS else "hold-out") for d_ in DAYS_ALL}
CUTS_TW = D.vol_cuts(XTAB)
try:
    FTAB = M.MTab(FRESH_DAYS, fill_ms=FILL_MS)
    FRESH_OK = True
except LookupError as e_:
    FTAB, FRESH_OK = None, False
    print("the fresh day is not seated:", e_)

def tw_arrays(tab_):
    qb_, qa_ = tab_.qb.astype(float), tab_.qa.astype(float)
    return dict(qb=qb_, qa=qa_, qbs=tab_.qbs.astype(float), qas=tab_.qas.astype(float), pu=tab_.pu.astype(float), T=tab_.T[None, :], spread=qa_ - qb_, mid=(qb_ + qa_) / 2.0, coin=np.asarray(tab_.w_asset))

def tw_side(A_, side_):
    """The ask, the size at the ask and the fair value of the token of `side_`, as the trader sees them at the decision second (the Down token is the mirror of the Up book)."""
    return np.where(side_ > 0, A_["qa"], 1.0 - A_["qb"]), np.where(side_ > 0, A_["qas"], A_["qbs"]), np.where(side_ > 0, A_["pu"], 1.0 - A_["pu"])

def tw_gate(tab_, A_, side_, trig_, name_, sig_):
    ask_, asz_, pus_ = tw_side(A_, side_)
    if name_ in ("none", "limit ask+0.01"):
        g_ = np.ones_like(trig_)
    elif name_ == "btc+eth":
        g_ = np.broadcast_to((A_["coin"] <= 1)[:, None], trig_.shape)
    elif name_.startswith("spread<="):
        g_ = A_["spread"] <= float(name_[8:]) + 1e-9
    elif name_ == "depth>=clip":
        g_ = asz_ * ask_ >= CLIP_USD
    elif name_.startswith("ask in "):
        lo_, hi_ = map(float, name_[7:].split("-"))
        g_ = (ask_ >= lo_ - 1e-6) & (ask_ <= hi_ + 1e-6)
    elif name_.startswith("fv>="):
        g_ = (pus_ - ask_) >= float(name_[4:])
    elif name_.startswith("T>="):
        g_ = A_["T"] >= float(name_[3:])
    elif name_ == "with leader":
        g_ = (side_ > 0) == (A_["pu"] > 0.5)
    elif name_ == "against leader":
        g_ = (side_ > 0) != (A_["pu"] > 0.5)
    elif name_.startswith("booklag<="):
        kp_ = np.maximum(np.arange(tab_.NK) - sig_.L, 0)
        g_ = side_ * (A_["mid"] - A_["mid"][:, kp_]) <= float(name_[9:]) * side_ * (A_["pu"] - A_["pu"][:, kp_])
    elif name_ == "persist":
        zp_ = np.roll(tab_.zlook(sig_.L), 1, axis=1); zp_[:, 0] = 0.0
        g_ = (np.sign(zp_) == side_) & (np.abs(zp_) >= sig_.z / 2)
    else:
        raise ValueError(name_)
    return trig_ & g_ & np.isfinite(ask_)

def tw_run(tab_, A_, sig_, gates_):
    """The entries of `sig_` under `gates_` on `tab_`, held to expiry; the limit gate buys at no more than a cent over the ask seen (the rest of the family walks the ladder up to LIMIT)."""
    side_, trig_ = sig_.fire(tab_)
    for g_ in gates_:
        trig_ = tw_gate(tab_, A_, side_, trig_, g_, sig_)
    side_ = np.where(trig_, side_, 0).astype(np.int8)
    if "limit ask+0.01" not in gates_:
        return M.settle(tab_, side_, trig_, M.Exit("expiry"), sig_.lu)
    ask_, _, _ = tw_side(A_, side_)
    lim_ = np.where(np.isfinite(ask_), np.minimum(np.round(ask_ + 0.01, 4) + 5e-7, LIMIT), LIMIT)       # half a tick of float32 room, never the next cent (um-011's lesson)
    e_ = B.entries(tab_, side_, trig_, lim_, usd=CLIP_USD)
    n_ = len(e_["w"])
    e_.update(ke=np.full(n_, -1, int), exit_px=np.full(n_, np.nan), pos=e_["net"] > 0, exit_fee=np.zeros(n_))
    return e_

TW_BASES = [M.Signal(1, 2.5), M.Signal(1, 4.0), M.Signal(10, 3.0), M.Signal(60, 2.5), M.Signal(180, 3.0)]
TW_GATES = [("none",), ("btc+eth",), ("spread<=0.02",), ("depth>=clip",), ("ask in 0.30-0.70",), ("fv>=0.02",), ("fv>=0.05",), ("fv>=0.10",), ("T>=300",), ("T>=600",), ("with leader",), ("against leader",),
            ("booklag<=0.5",), ("persist",), ("limit ask+0.01",), ("fv>=0.05", "btc+eth"), ("fv>=0.05", "T>=300"), ("fv>=0.05", "spread<=0.02"), ("fv>=0.05", "ask in 0.30-0.70"), ("fv>=0.05", "limit ask+0.01"), ("fv>=0.05", "btc+eth", "T>=300")]
A_X = tw_arrays(XTAB)
A_F = tw_arrays(FTAB) if FRESH_OK else None
TW_FR, _rows = {}, []
for sg_ in TW_BASES:
    for gs_ in TW_GATES:
        nm_ = f"{sg_.name} | " + " & ".join(gs_)
        e_ = tw_run(XTAB, A_X, sg_, gs_)
        row_ = dict(rule=nm_, signal=sg_.name, gates=" & ".join(gs_), **{"all n": len(e_["w"])})
        if len(e_["w"]) >= N_MIN:
            fr_ = D.entry_frame(XTAB, e_, sg_, ROLES_TW, CUTS_TW)
            TW_FR[nm_] = fr_
            for lab_, f_ in (("all", fr_), ("disc", fr_[fr_["role"] == "discovery"]), ("hold", fr_[fr_["role"] == "hold-out"])):
                row_[f"{lab_} n"] = len(f_)
                if len(f_) >= 10:
                    es_ = D.edge_stats(f_)
                    se_ = (es_["net_hi"] - es_["net"]) / 1.96
                    row_.update({f"{lab_} win": float(f_["won"].mean()), f"{lab_} be": float(f_["q"].mean()), f"{lab_} edge": es_["edge"], f"{lab_} friction": es_["friction"], f"{lab_} net": es_["net"], f"{lab_} lo": es_["net_lo"], f"{lab_} hi": es_["net_hi"],
                                 f"{lab_} t": (es_["net"] / se_) if se_ > 0 else np.nan})
        if FRESH_OK:
            ef_ = tw_run(FTAB, A_F, sg_, gs_)
            row_["fresh n"] = len(ef_["w"])
            if len(ef_["w"]) >= 10:
                m_, se_ = D.cl_mean(ef_["net"], ef_["slot"])
                row_.update({"fresh net": m_, "fresh lo": m_ - 1.96 * se_, "fresh hi": m_ + 1.96 * se_})
        _rows.append(row_)
TW = pd.DataFrame(_rows)
N_TW = len(TW)
print(f"{N_TW} entry rules scored on {len(DAYS_ALL)} days" + (f" and on the fresh day {FRESH_DAYS[0]}" if FRESH_OK else "") + f" in {time.time() - t0:.0f}s; {len(TW_FR)} with at least {N_MIN} entries")
'''

TW_CODE_TABLES = r'''
_cols = ["rule", "all n", "all win", "all be", "all edge", "all friction", "all net", "all lo", "all hi", "disc n", "disc net", "disc t", "hold n", "hold net", "hold lo", "hold hi", "hold t"] + (["fresh n", "fresh net", "fresh lo", "fresh hi"] if FRESH_OK else [])
display(Markdown(f"**Every entry rule of the family** ({N_TW} cells, five base signals x 21 gates). be = price paid plus fee a share, the share the rule must win; edge = the outcome against the book's mid at the decision, friction = the 250 ms, the spread and depth, and the fee, both in USD an entry; net with its cluster-robust 95% interval by 15-minute slot and its t. "
                 f"all = {DAYS_ALL[0][5:]} to {DAYS_ALL[-1][5:]}; disc = {FIT_DAYS[0][5:]} to {VALIDATE_DAYS[-1][5:]}; hold = {TEST_DAYS[0][5:]} to {TEST_DAYS[-1][5:]}" + (f"; fresh = {FRESH_DAYS[0]}, one day" if FRESH_OK else "") + "."))
display(HTML(TW[[c_ for c_ in _cols if c_ in TW.columns]].round(3).to_html(index=False, border=0)))
# ---- what each gate does to the arithmetic, averaged over the five base signals: the change in edge, friction and net against the ungated signal, all days ----
_base = TW[TW["gates"] == "none"].set_index("signal")
_gain = []
for g_ in [" & ".join(gs_) for gs_ in TW_GATES[1:]]:
    q_ = TW[TW["gates"] == g_].set_index("signal")
    ok_ = [s_ for s_ in q_.index if q_.loc[s_, "all n"] >= N_MIN and s_ in _base.index]
    if ok_:
        _gain.append(dict(gate=g_, signals=len(ok_), entries_kept=float((q_.loc[ok_, "all n"] / _base.loc[ok_, "all n"]).mean()), d_edge=float((q_.loc[ok_, "all edge"] - _base.loc[ok_, "all edge"]).mean()),
                          d_friction=float((q_.loc[ok_, "all friction"] - _base.loc[ok_, "all friction"]).mean()), d_net=float((q_.loc[ok_, "all net"] - _base.loc[ok_, "all net"]).mean()), net=float(q_.loc[ok_, "all net"].mean())))
TW_GAIN = pd.DataFrame(_gain).sort_values("d_net", ascending=False).reset_index(drop=True)
display(Markdown("**What each gate does, averaged over the base signals it leaves at least 30 entries on, all days** (entries kept = the share of the ungated signal's entries; d_ = the change in USD an entry against the ungated signal)"))
display(HTML(TW_GAIN.round(3).to_html(index=False, border=0)))
# ---- the selection check: the twelve best on the discovery days, read on the hold-out days and the fresh day ----
_ok = TW[(TW["disc n"] >= N_MIN) & (TW["hold n"] >= N_MIN)].copy()
TOP = _ok.sort_values("disc t", ascending=False).head(12).reset_index(drop=True)
_tcols = ["rule", "disc n", "disc net", "disc t", "hold n", "hold net", "hold lo", "hold hi", "hold t"] + (["fresh n", "fresh net"] if FRESH_OK else [])
display(Markdown("**The twelve best on the discovery days, read on the hold-out days" + (" and on the fresh day" if FRESH_OK else "") + "**"))
display(HTML(TOP[_tcols].round(3).to_html(index=False, border=0)))
TW_SEL = dict(k=len(TOP), disc=float(TOP["disc net"].mean()), hold=float(TOP["hold net"].mean()), hold_pos=float((TOP["hold net"] > 0).mean()), base_hold=float(_ok["hold net"].mean()),
              fresh=float(TOP["fresh net"].mean()) if FRESH_OK and "fresh net" in TOP else float("nan"), base_fresh=float(_ok["fresh net"].mean()) if FRESH_OK and "fresh net" in _ok else float("nan"))
N_ALL_UP, N_HOLD_UP = int((_ok["all lo"] > 0).sum()), int((_ok["hold lo"] > 0).sum())
N_FRESH_UP = int((_ok["fresh lo"] > 0).sum()) if FRESH_OK and "fresh lo" in _ok else 0
'''

TW_CODE_FIG1 = r'''
def tw_rules_fig(top_, window_, notes_, question_="Do the entry rules that looked best on the discovery days still earn on the hold-out days and the fresh day?"):
    """Horizontal bars: the hold-out net USD an entry (sign colour, 95% by slot); the discovery net as an ink tick; the fresh day as a hollow diamond (kind rule-comparison)."""
    n_ = len(top_)
    fig_, (ax_,) = LF.frame(max(3.6, 0.36 * n_ + 1.4), notes_, question_, window_)
    ax_.get_subplotspec().get_gridspec().update(left=0.3)
    y_ = np.arange(n_)
    per_, lo_, hi_, dc_ = (top_[c_].to_numpy(float) for c_ in ("hold net", "hold lo", "hold hi", "disc net"))
    ax_.barh(y_, per_, color=[F.GOOD if v_ >= 0 else F.BAD for v_ in per_], height=0.7, zorder=3, label="hold-out days: net USD an entry (bars, 95% by slot)")
    ax_.errorbar(per_, y_, xerr=[np.maximum(per_ - lo_, 0), np.maximum(hi_ - per_, 0)], fmt="none", color=F.N["ink2"], ecolor=F.N["ink2"], elinewidth=0.9, capsize=2, zorder=4)
    ax_.scatter(dc_, y_, marker="|", s=90, color=F.N["ink"], zorder=5, label="discovery days")
    if "fresh net" in top_ and top_["fresh net"].notna().any():
        ax_.scatter(top_["fresh net"].to_numpy(float), y_, marker="D", s=30, facecolor=F.N["surface"], edgecolor=F.N["ink"], zorder=6, label=f"fresh day {FRESH_DAYS[0][5:]}")
    ax_.axvline(0, color=F.N["axis"], lw=1.0)
    ax_.set_yticks(y_); ax_.set_yticklabels(top_["rule"], fontsize=8.5); ax_.invert_yaxis()
    ax_.set_xlabel("net USD an entry after the fee, the spread and depth, and the 250 ms fill")
    ax_.legend(loc="lower right", fontsize=8)
    return fig_
_bul = [f"The {TW_SEL['k']} rules that looked best on the discovery days earn {sgn(TW_SEL['disc'])} USD an entry there, {sgn(TW_SEL['hold'])} on the hold-out days ({pct(TW_SEL['hold_pos'], 0)} of them above zero; every rule with 30 entries on both averages {sgn(TW_SEL['base_hold'])})" + (f", and {sgn(TW_SEL['fresh'])} on the fresh day (every rule {sgn(TW_SEL['base_fresh'])})." if FRESH_OK else "."),
        f"{N_HOLD_UP} of the {len(_ok)} rules with 30 entries on both cuts have a hold-out interval above zero and {N_ALL_UP} a 22-day interval above zero" + (f"; {N_FRESH_UP} have a fresh-day interval above zero (one day: a label, not a count)." if FRESH_OK else "."),
        "Bars are the hold-out days, ink ticks the discovery days, hollow diamonds the fresh day. A rule chosen by the discovery days and read once on the others is the selection check; the cells are counted below and nothing here is a registered result."]
figstyle.show(tw_rules_fig(TOP, WIN_ALL.replace("every day, read after the test days", "discovery, hold-out and the fresh day"), _bul), "fig:s5-tweaks", FIGURES)
'''

TW_CODE_FIG2 = r'''
def tw_terms_fig(top_, window_, notes_, question_="Where does each entry rule gain: a larger edge before friction, a smaller friction, or neither?"):
    """Grouped bars per rule: the edge before friction (sign colour), the friction (loss colour), the net as an ink mark with its 95% interval, all days (kind profit-and-loss-attribution)."""
    fig_, (ax_,) = LF.frame(4.6, notes_, question_, window_)
    k_ = np.arange(len(top_))
    ax_.bar(k_ - 0.19, top_["all edge"], width=0.36, color=[F.GOOD if v_ >= 0 else F.BAD for v_ in top_["all edge"]], zorder=3, label="edge before friction (the outcome against the book's mid at the decision)")
    ax_.bar(k_ + 0.19, top_["all friction"], width=0.36, color=F.BAD, zorder=3, label="friction (250 ms, spread and depth, fee)")
    ax_.errorbar(k_, top_["all net"], yerr=[np.maximum(top_["all net"] - top_["all lo"], 0), np.maximum(top_["all hi"] - top_["all net"], 0)], fmt="_", ms=14, color=F.N["ink"], ecolor=F.N["ink2"], elinewidth=1.0, capsize=3, zorder=5, label="net (ink, 95% by slot)")
    ax_.axhline(0, color=F.N["axis"], lw=1.0)
    ax_.set_xticks(k_); ax_.set_xticklabels(top_["rule"], fontsize=7.5, rotation=18, ha="right")
    ax_.set_ylabel("USD an entry, all 22 days")
    ax_.legend(loc="upper left", fontsize=8)
    return fig_
_fv = TW_GAIN.set_index("gate")
_bul = [f"The fair-value gate is the one that moves the arithmetic: buying only when the Brownian fair value clears the ask by 5 cents changes the edge before friction by {sgn(_fv.loc['fv>=0.05', 'd_edge'])} USD an entry and the friction by {sgn(_fv.loc['fv>=0.05', 'd_friction'])}, net {sgn(_fv.loc['fv>=0.05', 'd_net'])}, keeping {pct(_fv.loc['fv>=0.05', 'entries_kept'], 0)} of the entries; by 10 cents {sgn(_fv.loc['fv>=0.10', 'd_net'])} net on {pct(_fv.loc['fv>=0.10', 'entries_kept'], 0)}.",
        f"A limit at the ask seen (no chasing) changes the friction by {sgn(_fv.loc['limit ask+0.01', 'd_friction'])} and the edge by {sgn(_fv.loc['limit ask+0.01', 'd_edge'])}: the edge lives in the entries where the book is moving, which the limit refuses. Depth at the touch does the same ({sgn(_fv.loc['depth>=clip', 'd_edge'])} edge, {sgn(_fv.loc['depth>=clip', 'd_friction'])} friction).",
        "The rules drawn are the twelve best on the discovery days, read over all 22 days. Green is an edge above zero, red the friction; the ink mark is the net with its interval. Cheap tokens carry more shares a clip, so a fair-value gate that selects them raises both bars."]
figstyle.show(tw_terms_fig(TOP, WIN_ALL, _bul), "fig:s5-tweak-terms", FIGURES)
'''

TW_CODE_HUNT = r'''
# ---- the correction for the number of places looked: every rule whole and cut by coin, the best-of-N line from a slot bootstrap of the maximum t ----
t0 = time.time()
HUNT_TW, HI_TW = D.hunt(TW_FR, hold_days=TEST_DAYS, n_boot=N_BOOT_TW, seed=SEED, min_n=N_MIN)
print(f"{HI_TW['n_hyp']} hypotheses (rules whole and by coin) scored in {time.time() - t0:.0f}s")
_best_tw = HUNT_TW.iloc[0]
display(Markdown(f"**The twelve highest t among {HI_TW['n_hyp']} hypotheses** (p_raw one-sided; p_holm over all; p_maxt = the share of null bootstrap draws whose best hypothesis reaches this t; disc and hold are the two date cuts)"))
display(HTML(HUNT_TW.head(12)[["family", "hypothesis", "entries", "win", "price", "per", "t", "p_raw", "p_holm", "p_maxt", "disc_n", "disc_per", "hold_n", "hold_per"]].round(3).to_html(index=False, border=0)))
GATES.append({"id": "G15", "section": "S5", "label": "Rule clears best-of-N", "name": "some entry rule of the family, whole or by coin, has a max-t p under 0.05 across every hypothesis scored; informational: a rule found on these days is a candidate for a forward registration, not a result",
              "reading": f"best t {_best_tw['t']:.2f} ({_best_tw['hypothesis']}) against the {HI_TW['q95_best_t']:.2f} line; {HI_TW['n_maxt_05']} of {HI_TW['n_hyp']} survive", "verdict": "INFO", "would_change": "a forward read of the rule"})
'''

TW_CODE_ANS = r'''
_top1 = TOP.iloc[0]
_fresh_txt = (f" and {sgn(TW_SEL['fresh'])} on the fresh day" if FRESH_OK else "")
_top1_fresh = (f" / {sgn(_top1['fresh net'])} fresh" if FRESH_OK and _top1.get("fresh net") == _top1.get("fresh net") else "")
TW_SENT = (f" **Entry rules.** Of {N_TW} entry rules on five signals, {N_HOLD_UP} have a hold-out interval above zero and {N_ALL_UP} a 22-day interval above zero; the best of {HI_TW['n_hyp']} hypotheses by t reaches {_best_tw['t']:.2f} against {HI_TW['q95_best_t']:.2f} for the best of that many by luck ({HI_TW['n_maxt_05']} survive). "
           f"The fair-value gate is the one that changes the arithmetic (edge {sgn(_fv.loc['fv>=0.05', 'd_edge'])}, friction {sgn(_fv.loc['fv>=0.05', 'd_friction'])}, net {sgn(_fv.loc['fv>=0.05', 'd_net'])} an entry at 5 cents); the twelve rules best on the discovery days earn {sgn(TW_SEL['disc'])} there, {sgn(TW_SEL['hold'])} on the hold-out days{_fresh_txt}. "
           f"The best, {_top1['rule']}: {sgn(_top1['disc net'])} discovery / {sgn(_top1['hold net'])} hold-out{_top1_fresh}, a candidate for a forward registration and not a result; um-014, the buy-near deep dive registered 2026-10-10, is that registration.")
TW_SHORT = (f"The entry-rule family of S5 ({N_TW} rules) finds {N_HOLD_UP} with a hold-out interval above zero and {HI_TW['n_maxt_05']} above the best-of-N line; the fair-value gate is the lead, registered forward as um-014 (the buy-near deep dive) before it is read again.")
ANS8.update(Markdown(f"**{'One rule clears the best-of-N line' if HI_TW['n_maxt_05'] else 'None clears the best-of-N line'}, and the one gate that moves the arithmetic is the fair value.** Of {N_TW} rules, {N_HOLD_UP} have a hold-out interval above zero and {N_ALL_UP} a 22-day interval above zero; the best of {HI_TW['n_hyp']} by t is {_best_tw['t']:.2f} against {HI_TW['q95_best_t']:.2f} by luck. "
                     f"Buying only when the fair value clears the ask by 5 cents changes the edge by {sgn(_fv.loc['fv>=0.05', 'd_edge'])} USD an entry and the friction by {sgn(_fv.loc['fv>=0.05', 'd_friction'])}. The twelve rules best on the discovery days earn {sgn(TW_SEL['disc'])} there, {sgn(TW_SEL['hold'])} on the hold-out days{_fresh_txt}; "
                     f"the best, {_top1['rule']}, {sgn(_top1['disc net'])} / {sgn(_top1['hold net'])}{_top1_fresh} ({WIN_ALL.split(' · ')[0]}): a candidate for a forward, pre-registered run, not money; that run is um-014, the buy-near deep dive registered 2026-10-10 with forward days 10-08 to 10-14."))
'''

RB_CODE = r'''
# ---- a second implementation on the raw venue data: twelve fit-day entries of the base signal rebuilt from the pinned ladders, the market rows and the Binance trades, with none of the engine's walk ----
from fundplat.data.predmkts import updown15_pin
from fundplat.data.crypto import ticks
import updown15_runner as RN
t0 = time.time()
_rb_tab = TABS["fit"]
_rb_e = M.run(_rb_tab, ST.BASE, _ex0)
_pick = np.random.default_rng(TW_SEED).choice(len(_rb_e["w"]), 12, replace=False)
_syms = {"btc": "BTCUSDT", "eth": "ETHUSDT", "sol": "SOLUSDT", "xrp": "XRPUSDT"}
_rows_by, _trd = {}, {}
def _last_px(sym_, day_, t_):
    if (sym_, day_) not in _trd:
        df_ = ticks.day_frame("spot", "aggTrades", sym_, day_)
        _trd[(sym_, day_)] = (df_["ts_ms"].to_numpy(np.int64), df_["price"].to_numpy(float))
    ts_, px_ = _trd[(sym_, day_)]
    return float(px_[np.searchsorted(ts_, t_, side="right") - 1])
def _walk_raw(px_, sz_, usd_, limit_, rate_):
    """An independent walk: cents of a share, best level first, never above the limit; the fee is the venue's rate x p x (1 - p) a share at each level."""
    left_, sh_, cost_, fee_ = usd_, 0.0, 0.0, 0.0
    for p_, q_ in zip(px_, sz_):
        if not (np.isfinite(p_) and np.isfinite(q_)) or q_ <= 0 or p_ > limit_ or left_ < 0.01:
            continue
        take_ = min(q_, np.floor(left_ / p_ * 100) / 100)
        sh_ += take_; cost_ += take_ * p_; fee_ += take_ * rate_ * p_ * (1 - p_); left_ -= take_ * p_
    return sh_, cost_, fee_
RB = []
for i_ in _pick:
    w_, k_, s_ = int(_rb_e["w"][i_]), int(_rb_e["k"][i_]), int(_rb_e["side"][i_])
    day_, coin_, start_ = _rb_tab.days[int(_rb_tab.day[w_])], RP.ASSET[int(_rb_tab.w_asset[w_])], int(_rb_tab.w_start[w_])
    if day_ not in _rows_by:
        _rows_by[day_] = {(r_["asset"], r_["start_ms"]): r_ for r_ in map(RN._as_row, RN.market_rows(day_))}
    row_ = _rows_by[day_][(coin_, start_)]
    st_ = updown15_pin.read(row_["slug"])["states"]
    ts_ = np.asarray(st_["ts"], np.int64)
    t_dec_ = start_ + (B.K0 + k_) * 1000
    j_f, j_d = np.searchsorted(ts_, t_dec_ + FILL_MS, side="right") - 1, np.searchsorted(ts_, t_dec_, side="right") - 1
    bpx_, bsz_, apx_, asz_ = (np.asarray(st_[c_], float) for c_ in ("bid_px", "bid_sz", "ask_px", "ask_sz"))
    px_, sz_ = (apx_[j_f][:TT.L], asz_[j_f][:TT.L]) if s_ > 0 else (np.round(1.0 - bpx_[j_f][:TT.L], 4), bsz_[j_f][:TT.L])
    sh_, cost_, fee_ = _walk_raw(px_, sz_, CLIP_USD, LIMIT, float(row_["fee_rate"]))
    r_raw_ = np.log(_last_px(_syms[coin_], day_, t_dec_) / _last_px(_syms[coin_], day_, t_dec_ - 1000))
    RB.append(dict(day=day_, coin=coin_, second=B.K0 + k_, side=s_, shares=float(_rb_e["shares"][i_]), raw_shares=sh_, cost=float(_rb_e["cost"][i_]), raw_cost=cost_, fee=float(_rb_e["fee"][i_]), raw_fee=fee_, won=bool(_rb_e["won"][i_]), raw_won=bool((s_ > 0) == (row_["outcome"] == "Up")),
                   bid=float(_rb_tab.qb[w_, k_]), raw_bid=float(st_["best_bid"][j_d]), ask=float(_rb_tab.qa[w_, k_]), raw_ask=float(st_["best_ask"][j_d]), z=float(_rb_tab.zlook(1)[w_, k_]), raw_1s_return_bp=r_raw_ * 1e4))
RB = pd.DataFrame(RB)
display(Markdown(f"**Twelve fit-day entries of the base signal rebuilt from the raw pinned ladders, the market rows and the Binance trades** (an independent walk of the book as of the decision + {FILL_MS} ms; the engine's shares, cost and fee beside the rebuild's; the quotes the trader saw at the decision; the venue's recorded outcome; the one-second return of the last Binance trade price beside the engine's z). {time.time() - t0:.0f}s."))
display(HTML(RB.round(4).to_html(index=False, border=0)))
_d_sh, _d_cost, _d_fee = (float(np.abs(RB[a_] - RB["raw_" + a_]).max()) for a_ in ("shares", "cost", "fee"))
_q_ok = bool((np.abs(RB["bid"] - RB["raw_bid"]) < 1e-6).all() and (np.abs(RB["ask"] - RB["raw_ask"]) < 1e-6).all())
_w_ok = bool((RB["won"] == RB["raw_won"]).all())
_z_ok = int((np.sign(RB["z"]) == np.sign(RB["raw_1s_return_bp"])).sum())
_rb_ok = bool(_d_sh <= 0.0101 and _d_cost <= 0.02 and _d_fee <= 0.01 and _q_ok and _w_ok and _z_ok == len(RB))
display(Markdown(f"The rebuild agrees to within one cent of a share ({_d_sh:.4f} shares, {_d_cost:.4f} USD of cost and {_d_fee:.4f} USD of fee at most): the table keeps prices in float32, so a walk whose residual lands on a whole cent of a share can floor one cent of a share lower than exact arithmetic, a fraction of a cent of PnL. "
                 f"The quotes seen {'agree' if _q_ok else 'DIFFER'} to the tick, the outcomes {'agree' if _w_ok else 'DIFFER'}, and the sign of the Binance move agrees on {_z_ok} of {len(RB)} (the engine's mid is trade-implied, the rebuild's is the last trade price, so the size differs by a fraction of a basis point)."))
GATES.append({"id": "G16", "section": "S2", "label": "Raw rebuild agrees", "name": "twelve fit-day entries of the base signal, rebuilt from the raw pinned ladders, market rows and Binance trades with an independent walk, agree with the engine to a cent of a share, the quotes to the tick, the outcomes and the sign of the move exactly",
              "reading": f"largest differences {_d_sh:.4f} shares, {_d_cost:.4f} USD cost, {_d_fee:.4f} USD fee; quotes {'equal' if _q_ok else 'differ'}; outcomes {'equal' if _w_ok else 'differ'}; Binance sign {_z_ok} of {len(RB)}", "verdict": "PASS" if _rb_ok else "FAIL", "would_change": "a rebuild that drifts from the engine"})
VERIFY["total"] += 1
VERIFY["passed"] += int(_rb_ok)
'''


def patch_tweaks(cells):
    """The owner's follow-up of 2026-10-10 on the re-score: an entry-rule family scored on discovery, hold-out and one fresh day, counted and not chosen; a raw-data rebuild gate in S2."""
    _rep(cells, "N_MIN = 30", 'N_MIN = 30\nFRESH_DAYS = ("2026-10-08",)\nN_BOOT_TW = 4000\nTW_SEED = 11')
    _rep(cells, "import mom15_bt as M, mom15_study as ST, mom15_figs as F, mom15_path as P, mom15_report as MR", "import mom15_bt as M, mom15_study as ST, mom15_figs as F, mom15_path as P, mom15_report as MR, mom15_diag as D")
    # S2: the raw rebuild, after the planted tests
    _after(cells, "# ---- planted tests: a signal that reads the FUTURE must pay far more", [_cell("code", RB_CODE)])
    _rep(cells, "| Is there a book for the windows, is the 1 s Binance path the table's own series, does the sweep's z equal the tables' z, and do the planted tests behave? | at least 90% of windows have a book; the path equals the table at every whole second; the planted lead and the second opening of the test days are caught |",
         "| Is there a book for the windows, is the 1 s Binance path the table's own series, does the sweep's z equal the tables' z, do the planted tests behave, and does a rebuild from the raw venue data agree with the engine? | at least 90% of windows have a book; the path equals the table at every whole second; the planted lead and the second opening of the test days are caught; twelve entries rebuilt from the raw ladders agree to a cent of a share |")
    # S5: the entry-rule family, after the S5 answer line
    _rep(cells, "| Where does the money, or the loss, come from: coin, time left, day, and the fee? | tables by coin, time left and day, and the fee beside the gross |",
         "| Where does the money, or the loss, come from: coin, time left, day, and the fee? | tables by coin, time left and day, and the fee beside the gross |\n| What entry rule would make it pay? | a counted family of gates on five signals, read on the discovery days, the hold-out days and one fresh day; the best-of-N line; no gate decides, nothing is chosen |")
    _rep(cells, "The separate diagnosis study (`2026-10-08-predmkts-binance-momentum-15m-updown-diagnosis`) splits the same pair's result into the edge before friction and the friction itself.",
         "S5 of the momentum study (`2026-10-08-predmkts-binance-momentum-15m-updown`, which now holds its diagnosis) splits the frozen pair's result into the edge before friction and the friction itself on the same 22 days.")
    _after(cells, "ANS6.update(Markdown(f\"**{'We lose' if TSUM['per'] < 0 else 'We do not lose'}: {_why}.**",
           [_cell("md", TW_MD1), _cell("code", TW_ANS), _cell("md", TW_MD2), _cell("code", TW_CODE_FAMILY), _cell("code", TW_CODE_TABLES), _cell("code", TW_CODE_FIG1, ("fig:s5-tweaks",)), _cell("code", TW_CODE_FIG2, ("fig:s5-tweak-terms",)),
            _cell("code", TW_CODE_HUNT), _cell("code", TW_CODE_ANS)])
    # S7: the headline, the short answer, the card, the caveats, the next bet, the figure kinds
    _rep(cells, '{LAD_SENT}.")\ndisplay(Markdown(HEADLINE_MD))', '{LAD_SENT}.")\nHEADLINE_MD += TW_SENT\ndisplay(Markdown(HEADLINE_MD))')
    _rep(cells, "ANS7.update(Markdown(ANS7_TXT)); ANS0.update(Markdown(ANS7_TXT))", 'ANS7_TXT += " " + TW_SHORT\nANS7.update(Markdown(ANS7_TXT)); ANS0.update(Markdown(ANS7_TXT))')
    _rep(cells, '"next_bet": _cut("the maker-side burst on BTC and ETH: a resting bid pays no fee and no half spread, pre-registered before it is scored", 150)',
         '"next_bet": _cut(f"the fair-value-gated burst ({_top1[\'rule\']}) is registered as um-014, the buy-near deep dive, forward days 10-08 to 10-14; the maker side is um-013", 150)')
    _rep(cells, '        {"title": "Checks", "rows": [mk("Windows with a book", pct(SHARE, 0), "90% bar", gate="G1"), mk("Cells tried", f"{N_TRIALS}", "", "INFO"), mk("Engine checks held", f"{VERIFY[\'passed\']} of {VERIFY[\'total\']}", "all", "INFO")]}],',
         '        {"title": "Entry rules, S5", "rows": [mk("Rules tried", f"{N_TW}", "five signals x 21 gates", "INFO"), mk("Hold-out interval above 0", f"{N_HOLD_UP} of {len(_ok)}", "", "INFO"), mk("Best t of all tried", f"{_best_tw[\'t\']:.2f}", f"best of {HI_TW[\'n_hyp\']} by luck {HI_TW[\'q95_best_t\']:.2f}", gate="G15"),\n'
         '                                         mk("Twelve best: found / held" + (" / fresh" if FRESH_OK else ""), f"{sgn(TW_SEL[\'disc\'])} / {sgn(TW_SEL[\'hold\'])}" + (f" / {sgn(TW_SEL[\'fresh\'])}" if FRESH_OK else ""), "USD an entry", "INFO"), mk("Fair-value gate, 5c, net change", sgn(_fv.loc["fv>=0.05", "d_net"]), "an entry", "INFO")]},\n'
         '        {"title": "Checks", "rows": [mk("Windows with a book", pct(SHARE, 0), "90% bar", gate="G1"), mk("Raw rebuild", f"{len(RB)} entries", "a cent of a share", gate="G16"), mk("Cells tried", f"{N_TRIALS}", "", "INFO"), mk("Engine checks held", f"{VERIFY[\'passed\']} of {VERIFY[\'total\']}", "all", "INFO")]}],')
    _rep(cells, '"fig:s4-ladder": "calibration"', '"fig:s4-ladder": "calibration", "fig:s5-tweaks": "rule-comparison", "fig:s5-tweak-terms": "profit-and-loss-attribution"')
    _rep(cells, '           "the price limit 0.97, the first decision at 10 s and the exit sigma unit are [U], fixed before scoring"]',
         '           "the price limit 0.97, the first decision at 10 s and the exit sigma unit are [U], fixed before scoring",\n           "the entry-rule family of S5 is read on days already opened: counted, not chosen; a candidate for a forward run",\n           "the fresh day 10-08 is one day, seated after the test read and read once; a label, not a count"]')
    _rep(cells, '_unpinned.append({"what": "gamma market list (updown15.markets)", "why": "a day cache of the venue\'s own listing, re-readable; its outcomes are inside the derived days\' pins"})',
         '_unpinned.append({"what": "gamma market list (updown15.markets)", "why": "a day cache of the venue\'s own listing, re-readable; its outcomes are inside the derived days\' pins"})\n_unpinned.append({"what": f"the fresh day {FRESH_DAYS[0]} (its decision table and path), and the raw ladders, rows and trades of the S2 rebuild", "why": "read for the record in S2 and S5, outside the registered inputs digest"})')
    return cells
