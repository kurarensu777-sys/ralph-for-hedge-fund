---
topics: [method, provenance, backtest]
type: guide
---

# The research guide

How a study is done here: the evidence bar first, then the notebook rules. The research agent keeps it. The craft of writing a notebook (cells, question headers, next bets, rewrite boards, vendor series, the audit lesson) is in `notebook-craft.md`; how to draw each type of chart is in the chart bank (`charts.md`); what a market taught goes in a strategy book beside them, one per trading topic (`type: strategy`, `parent: research`). A new learning is a new `##` chapter, opening with its Read-when line.

## Nine sections, four kinds

Read when: about to start, restructure or re-run a notebook, add a section, or decide where a chart or a test belongs.

A study notebook has nine slots, each a header that is filled or says `n/a - <reason>`: `## S0 · Summary`, `S1 · Setup`, `S2 · Data checks`, `S3 · Core result`, `S4 · Robustness`, `S5 · Risk and diagnostics`, `S6 · Decision`, `S7 · Verdict`, then an optional `## A · Appendix`. The fund keeps them in a study template and a structure check (`nbstructure`); neither ships in this repo, so a new study writes them and nothing holds them. A notebook moves into the layout at its next re-run, never by a hand edit of kept outputs.

- **Kind sets S3 and S6:** strategy (the unlevered book; sizing), market (the measured effect; `n/a - no position`), event (before and after), venue (connectivity readings; `n/a - a connectivity proof`).
- **The six gates map onto the slots:** 0 to S2, 1 to S3, 2 and 3 to S4, 4 and 5 to S6, the verdict to S7. S4 holds the luck test against the HURDLE (a block bootstrap beside any shuffle), the cost sweep and the trial count.

## Six gates, size last

Read when: about to plan a strategy study, open one with a leverage grid or a notional ladder, or add a chart to a study that has not said what would falsify it.

A study proves the thesis before it sizes it, and refuses to size at all until steps 0 to 3 have passed. Sizing is the easiest section to write, so it colonises a study; last is the only place the earlier gates can still fail. One gate per step (the content of S2 to S6):

| Step | Gate | A fail looks like |
|---|---|---|
| 0 data and sanity | every engine hour equals the venue's published rate, asserted in the cell; vendor series pass their guard | a recomputed rate; no regime count |
| 1 the unlevered base (1x, costs on) | the gate metric ends ABOVE the hurdle AND the mirror (opposite direction, one parameter flip) is not also positive | both directions make money: the P&L is not the thesis |
| 2 is it real: one out-of-sample split, a luck test, a cost sweep | out-of-sample above the hurdle; permutation p below 0.10 on the FUNDING series, not the total; no cost cell flips the sign | a p only the total passes. A fail ENDS the notebook: verdict, no sizing |
| 3 a rule against always-hold | adopted ONLY if it improves BOTH the gate metric and max drawdown; no parameter search | a rule that buys return with drawdown |
| 4 sizing, last | the highest rung whose room at entry exceeds the pre-registered stop plus the worst joint wick, whose room at the wick still clears the stop, with drawdown inside the desk limit, no liquidation, and which the venue accepts | a rung sized on close-basis room |
| 5 execution and verdict | the live book fills the chosen clip near the assumed cost | a clip that does not fill: FLAG |

- **The gate metric** is funding-only for a carry book, the volatility term for a short-option book.
- **The refusal has to be WIRED:** the decision rule reads the gates (a `SIZED` flag; a size only when every S3 and S4 gate passed, else the rung prints as information only). Unenforced: a new study writes its own decision rule.
- **The stop and the drawdown limit are written BEFORE the grid runs,** tagged [U]. A hold past the AR(1) half-life bets on the regime, not the print. The notebook PRINTS the line; `app/loop/tools/preregister.py` WRITES it.
- **Two standing laws:** a config cell asserts that the run IS the defaults it claims, and a grid is not a sample (a figure per cell over one window is one observation re-sliced).
- **A Sharpe picked from many tries** is quoted only after the deflation in `app/library/academic/backtest-statistics.md#the-deflated-sharpe-ratio` (formulas [1]; three items stay [U]).

Measured: a pair passed gate 1; a multi-leg variant of it failed both directions, printed INFORMATION ONLY and sized nothing.

## Published numbers only

Read when: about to put a funding number, a stock close or an FX rate into a study, or to recompute a venue's rate from a formula.

A number is evidence only if the venue or the exchange published it.

- **Funding is the venue's own settled rate, never recomputed:** between the wire and the engine there is a `float()` cast and an hour-floor, nothing else. A rate is never derived from a formula, a floor, a clamp or a premium.
- **The one reconstruction is the NOTIONAL, by the venue's own rule:** where the venue's docs say the spot oracle, not the mark, converts size to notional and a real oracle is published only live, the rate applies to `oracle = perp / (1 + published premium)`. The Assumptions table says so.
- **A formula that does not reproduce is a FINDING on the chart:** markets on one venue can run different funding parameters, so one reproduces and its neighbour does not.
- **One S2 cell asserts it:** the engine's hourly rates equal the venue's funding history, pulled through the data layer, to the digit. It does NOT test the funding notional and says so (`app/library/law/how-we-know.md#what-would-it-print-if-false`).

## Figures: one meaning per colour

Read when: about to draw, restyle or review a figure, or to pick a colour, a line style or a shading for one.

The owner's taste. Hex values and the check live in `figstyle`, the style module the chart bank's code calls.

- **A colour has one meaning and keeps it in every figure.** Green and red mean good and bad only (a gain, above the hurdle, PASS; a loss, below, FAIL). Totals and every threshold are ink. Series compare by identity colour.
- **A series line is always solid;** colour tells series apart, a dash never does. A threshold is ink, dotted, with a text label.
- **The title is a question,** the subtitle is the window and the hours. The legend never covers data. Shading is keyed in the legend.
- **Findings go below the chart,** one bullet each, inside the same picture. One table per figure, at most nine columns.
- **A re-rendered figure is cut to the study's window,** and its script asserts the totals equal the original run before it draws.

Enforced: `figstyle.check` stops a render on an off-palette colour, a title that is not a question, a missing window, a second table, a dual axis or a dashed series. Not enforced: whether an allowed colour is used for its meaning. `--selftest` plants each fault.

### What makes a figure advanced

Read when: about to draw a figure, or to judge one that shows a single number, bar or line.

The owner's rule: a bar chart on its own is too simple and gets rejected. A figure adds at least three of these to the bare number, and a study that ships fewer says why in its findings.

1. **An interval.** A mean, Sharpe, hit rate, slope or share carries a bootstrap or Newey-West band. A point estimate alone is not a result.
2. **A stability split.** The same quantity by half, by regime or rolling, so one good week cannot pass for the edge.
3. **A decision line.** The threshold, break-even, hurdle, stop or clip the reader decides against: ink, dotted, labelled, on the axis where it lives (a drawdown limit is a vertical on a depth axis).
4. **A second panel.** The distribution behind a statistic, the count behind a rate, the tail behind a mean, the paths behind a drawdown.
5. **A tail or concentration number** where the mean hides the risk: CVaR, the worst 5%, the share of the P&L in the best few entries.

Refused: a bare bar chart, a bare histogram, a bare line, a table with no panel, a heat grid with no threshold and no marked point. The findings state the statistic, its interval and what would flip it ("mean +1.04 USD an entry, 95% interval +0.41 to +1.65 over 4,000 resamples; the interval clears zero").

Measured: a scenario-payoff figure was five bars, four of them identical, with no chance on any leg, no interval, no limit and nothing to decide. The redraw weighted the outcomes by the market prices, printed the chance on each leg, added the probability-weighted net with a 95% interval over 4,000 resamples, drew the pre-registered loss limit and stated the break-even against it.

Target forms: each chapter of the chart bank (`charts.md`) holds the advanced drawing. Unenforced: `figstyle.check` reads colour, title, window, tables and axes, not whether a figure carries three of the five. The canvas scaffolding (question title, window line, panel captions, findings below) is hand-copied into each chapter until `figstyle` gains a frame helper.

## Chart conventions

Read when: about to set up a figure's canvas, add a chart to a study, or save a notebook with plots.

Matplotlib only (no seaborn), wide `figsize` at dpi 110, the dataviz reference palette on a `#fcfcfb` surface. No dual-axis chart: a second scale is a second panel. Refuse a chart that presents one window as a sample or has no decision behind it (a normality plot). Keep the plots, trim megabyte dumps; a notebook stays under about 3 MB. Pick the chart's type in `charts.md` first: one chapter per type holds its question, its inputs and the code that draws it, and a manifest figure names its type in `kind`.

## Naming

Read when: about to name, split, rename or re-run a notebook, add a study to a strategy that already has notebooks, or point a ledger command or a manifest id at one.

The file name is the study's IDENTITY (the manifest `id` is the file stem; ledger commands and the Research room point at it): `<YYYY-MM-DD>-<market>-<subject>[-<variant>]`, date of the FIRST run, fixed for life, no status and no run id. Subject is kebab-case, at most five words; the variant is what siblings differ by (`hedged`, `1h`).

- **A family shares one stem** (the owner's rule): studies that build ONE strategy carry the family's first-run date, market word and subject, and differ only in the variant.
- **The name's market word is not the label** (`#manifest-and-labels`): `xasset` and `vol` map to no label. Never rename a notebook to match its labels.
- **A rename, on the owner's word, in one sitting:** `git mv` the notebook and its `.build.py`; change `STEM` / `NB` / `STUDY_ID`; re-execute (new id, same `RUN_ID`, name each moved number); update `labels.json` and every pointer except ledger rows; add `old -> new` to `platform/lab/<desk>/renames.json`.

Unenforced: the pattern (only id = stem is checked). `app/loop/tools/remeasure.py` does not read `renames.json` yet: a renamed notebook's fixed-age read records `missed`.

## Manifest and labels

Read when: about to write a notebook's last cell, add a field the Research room should show, set a Market or Format label, or build anything that reads a manifest.

The manifest (`fund.study/1`) is BUILT from the run's own objects by a report builder, never typed; the builder holds the fields, closed sets and label lengths, and the Research room checks the shape it draws (`app/shared/research.ts`: `manifestProblems`, `FORMATS`). Readers read, never compute: a number the room needs and the manifest lacks becomes a field in the builder and in `app/shared/research.ts`.

- **`status` is `registered` only when `results-log.md` holds a pre-registration for this run.** `headline` is the ONE gate metric, never a total P&L.
- **Format** is the investigation's shape; same-format studies compare column for column, two formats are never ranked together. `carry` (lead `funding_ann_pct`): a differential held. `directional` (`sharpe`): a view on price. `short_vol` (`premium_ann_pct`): selling a tail. `rel_value` (`net_edge_bps`): one thing priced twice. It is judged per opportunity and has no risk-adjusted set: a study that trades a rule on the gap and reports a P&L series (entries, exits, an equity curve) takes `directional` however often it trades; how it is run is a tag, not a format. A directional study that trades a rule many times a day states its edge per trade against its cost (the edge-per-trade keys on the directional card: gross edge, round-trip cost, break-even cost per fill, trades a day, capacity, turnover, beta to the underlying); a slow one states a null with its reason in `na` for those keys. `evidence` (`t_stat`): a question with no book.
- **A reading is not a label:** the gate's number stays in `reading`; if a label needs a number, the gate is two gates.
- **Two labels and two tags per study** (the owner's). Market: one or more of `crypto`, `equities`, `rates`, `predmkts`, main first. Format: one of the five, what the study is paid for. The manifest wins, else `platform/research/labels.json`; they must be equal (`platform/research/check_labels.py`).
- **Tags** are the manifest's optional `tags`, how the study is run. **Style** is `systematic` (a fixed rule trades it) or `discretionary` (a held position the owner chose); the study types it, no check can tell them apart, so it is a claim, and `labels.json` may carry it (`style`) until the study is re-run, after which the two must agree. **Pace** is read, never typed: the builder takes it off `avg_hold_h` (up to 24 h intraday, up to 72 h swing, longer hold) or, for a carry book with no hold metric, hold when it sat in the market 90 percent of the time or more; a study that measures no hold has no pace. `directional` and `short_vol` state `avg_hold_h` (for a short-vol book, the mean hours from entry to expiry or resolution); `rel_value` and `evidence` keep no pace. The builder refuses a pace the metrics do not earn. The 24 h and 90 percent lines are platform's, the 72 h line the owner's.
- **The list** is the owner's chosen look: grouped by Format, one row per study, Market a mark per market (the main one filled), then Style and Pace. A study is listed once; the tags tell two books of one strategy apart.

## The summary card

Read when: about to build a notebook's `summary` card, add or fill a row on it, or draw it in the last cell.

The card is the owner's fixed layout: the research question, a one-line answer, six implementation facts, four big numbers, the metrics in fixed blocks (name, value, bar, verdict), a size table and a footer. It is the manifest's optional `summary` field. The builder's card check holds every rule and a renderer draws it (`render(CARD)` raises on a card that breaks one); neither the room nor the notebook computes a number.

- **Build it BEFORE the manifest cell and pass `summary=CARD`.** The manifest is emitted inside S7, so the card is built from the run's objects in a cell just ahead of it. The last cell of the notebook, the Research summary after the appendix, only draws it: `display(HTML(summary_card.render(CARD)))`.
- **A metric is four cells:** name, value, bar (the number it is judged against, empty when none), verdict (PASS, FAIL, FLAG, INFO or empty). A value is a number of at most 26 characters, never a sentence; a code name (`funding_ann_pct`) never shows.
- **Tie a value to the run when you can.** A row may carry `key` (a manifest metric the value must equal at the decimals it shows) or `gate` (a gate id whose verdict the row must carry); the validator then holds it. A row with neither is held to shape and words only.
- **The counts bind a carry card:** six facts and four big numbers. Another format takes one or more of each.
- **The size table has one header per column** and its last column is a verdict. `chosen` marks the row the verdict names (`3x`); a study with `NO SIZE` marks the highest rung the geometry takes and says "information only" in the block title.
- **Leverage is a sub-test, never the base:** a carry study's blocks read at 1x; the size table shows the ladder. A study that sizes names the chosen rung in one place.
- **A tag on each assumed number** (`[V]`, `[1]`, `[U]`, `[API]`), never on a sentence, read from the source's own tag.
- **One convention across cards:** the answer opens with the verdict word in capitals (`NO SIZE.`); drawdowns are signed (`-4.5%`) and the manifest metric is negative; size-table headers are short (`Return`, `Max DD`, `Liq buffer`, `Verdict`) so the Verdict column fits 480 px; `headline.gate` names the gate that judges the headline so the list tones it; a lead number is never tied to a passing gate while a data check fails (give it INFO). Unenforced: the manifest check does not read `headline.gate` or these conventions.
- **The voice (the owner's):** one short fact per line; plain words on the face; every number with its sign and unit (percent to 1 decimal, ratios to 2, USD whole); one name per thing (premium, never basis in one place and premium in another); the verdict is a size, and a model limit is a caveat, not a reason; no plumbing on the face (kind, run id, kernel).

## Input pins

Read when: about to read data in a notebook, re-run a study whose cache may have been evicted, compare a study's inputs with a ledger fingerprint, or add fields to a registered study.

A study's reads sit in an evicted CACHE, so "which rows did this result use" is a PIN, filled by the template's S7 cell (the data library's `pin_reads`), never typed; the builder holds the shape. A lab ledger path is found from the kernel cwd by its marker folder (`lab/research`), never by a fixed `../` count.

- **The same digest is ONE observation:** two studies whose `inputs.digest` is equal read the same rows (`app/library/law/how-we-know.md#a-shared-window-is-one-result`); a re-run whose pins differ is a new observation, not a replication.
- **An unpinned read is said, never guessed:** a live book walk or quote goes in `unpinned` with its reason and into `caveats`. Prediction-market history cannot be pinned.
- **Adding manifest fields to a registered study is a re-execution, not a run:** diff the old and new manifest (only `inputs`, `run.executed` and a named live read may differ), keep the run id, commit nothing it writes under `lab/`. A window that ROLLS is a new observation: say so in the commit. Unenforced: the trial writer cannot tell a relabelling from a run, so check `git status lab` first.

## Prior art

Read when: about to say this desk is ahead of or behind the public field, or to adopt an outside practice into the study flow.

A one-day survey ([1]) found the public funding-arb field is a dashboard field: most backtest notebooks never run a backtest or hardcode an 8h cadence. Adopted here: a comparator on the same axes as the equity curve, a luck test with the real result marked, one walk-forward split. A README claiming a win rate with no window, cost model or method vouches for nothing.

## A study is done when the Research room shows it

Read when: about to start, rewrite or wrap a study, or about to say a study is "built", "redone" or "ready to show".

The Research room lists the notebooks in `platform/research/studies/*.ipynb` and reads each one's `fund.study/1` manifest (`app/server/research/scan.ts`). A study that is not a notebook there does not exist for the owner: boards, mockups, proposal pages and render scripts outside `studies/` are drafts.

- **Put the notebook in `studies/` first, even as a first cut,** then change that notebook every round. A rewrite that lives only on a board shows nothing under the Research tab. Measured: a pair-study rewrite ran a whole session on draft boards after the old notebooks left `studies/`; the owner saw nothing in the room.
- **Done means:** the notebook is in `studies/`, `platform/research/check_labels.py` passes (and the structure check, where it exists), and the room lists it with its Market and Format labels. Say which of these you ran.
- **Wrapping early is allowed; leaving the deliverable out is not.** If a session ends before the build, the report says "not in the Research room" in its first line.

Held in part by `check.py` research.studies-named: a study named on an open research board item or in a results-log must have its notebook in `studies/`. It does not see a study nobody named.

## Intraday systematic studies: bars, fills and the day as the unit

Read when: about to plan or review a study that trades more than once a day, pick a bar finer than 1h, model a fill from candles, or call an intraday result significant.

- **The venue caps the history.** A venue may serve only its latest few thousand candles per interval: at 5,000 bars, 15m reaches back about 52 days, 5m about 17 days, 1m about 3.5 days. The archive keeps only what a job has read, so a finer or longer window exists only if something read it while the venue still served it. A 5m window inside a 15m window is the same days: one result, not a replication.
- **Candle-only fills.** Decide on bar i's close, fill at bar i+1's open (a whole-bar delay as a stress), never at a high or a low; a flat slippage per fill stands in for the book. A passive fill cannot be simulated without a recorded book, so the passive case is only a cost FLOOR (maker fee, no spread paid), labelled a ceiling. The study's engine holds the rule: `verify()` on every run, and the signal on a prefix of the bars must equal the full run's signal bar for bar (a planted look-ahead turns that red).
- **The day is the unit.** Resample days (stationary bootstrap, a mean block of a few days) for the net against the hurdle. Test the thesis term, the spread P&L before costs, by shifting the whole position path by random whole days against the returns: turnover and the time-of-day shape stay, only the signal's link to what came next is cut. That p floors at one in n + 1 and never reads zero. A window of a few dozen days can reject and cannot confirm: days needed for a t of 2 are (2 / daily Sharpe) squared.
- **Count every trial** in the deflated Sharpe: grid cells, rules, bar sizes. The grid is one window re-sliced: one observation.
- **The cost wall.** A frequency study prints the gross edge per trade, the cost per trade and the break-even cost per fill side by side. Gross per trade is roughly flat as the entry level falls, so more trades do not make each one worth more; the ceiling on frequency is where gross per trade meets four fills of fee plus slippage.

Unenforced: nothing makes a study print the break-even cost per fill, and nothing gives an intraday study a slot of its own.
