---
topics: [method, backtest]
type: guide
parent: research
---

# Notebook craft

How a study notebook is written, reviewed and checked, once the evidence bar in `research.md` is met: cells and gates, question headers, the next bet, a rewrite board, the vendor-series guard and the audit lesson. The research agent keeps it. A new learning is a new `##` chapter here, opening with its Read-when line.

## The vendor-series guard

Read when: about to put a stock close, an FX rate or any other vendor series (not a venue endpoint) into a study.

`covered_from` at or before the requested start comes first: a cache can silently serve less than asked (a vendor's cache once ignored a widened `start`, and a refresh deleted bars outside the window, each leaving a plausible series and no signal). Then: no duplicate dates, OHLC consistent, no identical close on consecutive days, the calendar against the exchange's own sessions, units and quote direction, every ex-date named, a cross-check against a second public source or an explicit SKIP. A US close is DST-true: derive it from `zoneinfo`, never a fixed 20.0 UTC. The guard cannot see an error two sources share.

## Writing cells

Read when: about to write a notebook cell, a gate, a number in prose or a study-local helper, finish a study, or answer a review finding.

In the fund a structure check (`nbstructure`) holds the headers, the `parameters` cell, figure tags, the manifest and the hygiene list, and the study template holds `GATES` and a `PROSE` check; neither ships here. The rest is book-only everywhere:

- **Venue numbers are never parameters:** the one `parameters` cell holds what is OURS (equity, leverage, windows, seeds, [U] rates); venue numbers are read from cards in S1.2.
- **A refresh is a re-run top to bottom;** a kept output is never hand-edited. The generator `studies/<stem>.build.py` is committed beside the notebook, never a scratchpad. Measured: one family's generators were gone and a re-run printed new outputs under an old Conclusion (58 and 109 baked numbers in markdown). A re-run of a study that reads live books or quotes is a new read: type the registered values beside the run, tagged `[1]` and labelled not re-read, and diff every pinned scalar before and after (nine rebuilds once reproduced their pinned readings; only the live fill gates moved).
- **A risk number is read on synchronous marks:** a book whose legs mark on different clocks prices its marks, not its risk. A luck test is against the hurdle ("above zero" is reported, never the gate).
- **Three read-only reviewers, one hand.** Before a study is called finished, three reviewers read the executed notebook and its PNGs (prose, charts, data); one hand fixes and re-executes. A finding is applied or its reason is written down. A fix that moves numbers diffs every scalar field before and after. Nothing enforces the reviews.

## Question headers, answer first

Read when: about to write the section headers of a strategy notebook the owner will read top to bottom, or to put a finding line under a header.

The owner's spec: a header is a plain question with no jargon, the first thing under it is one sentence that states the measured finding, then the chart, then the explanation. For a strategy that trades a signal the seven are, in order: does a big move keep going, what does one trade look like, does the edge survive the time it takes to fill, how much money do we make, which windows did we enter, why do we lose, is it worth trading.

- **The finding line is computed, never typed.** Under the header put a code cell `ANSn = display(Markdown("_..._"), display_id=True)`, and in the cell where the numbers exist call `ANSn.update(Markdown(f"**...**"))`. The saved notebook shows the final sentence in place, as `S0_HANDLE` already does for the card. The line carries its window.
- **The header sits where its numbers can exist.** The five question headers of the story are `###` inside S3; "Why do we lose?" is the S5 header and "Is it worth trading?" the S7 header (`## S5 · Risk and diagnostics - Why do we lose?`, the dash form `nbstructure` allows). Every other sub-header in S3 to S5 becomes a bold lead-in line, so the headers a reader skims are the seven. A cell moves to the question it answers; a figure tag moves with it (`fig:s3-...`, because `nbstructure` holds a tag to its section).
- **The answer is conditional on the run.** "Yes" or "No" is chosen from the same gate or interval the verdict reads, so a re-run that flips the result flips the sentence. A header the data cannot answer as the spec words it (a study that does not lose money) keeps the spec's header and says so in its answer line.
- **A session timeline has no chart type of its own.** The which-windows strip is filed as `exposure-over-time` until `app/shared/research.ts` lists a type for it.

Measured: three studies were rebuilt this way; the generators were rewritten by splitting the cells into statements and reordering them, and every headline number matched the earlier run. Unenforced: nothing checks that a header is a question or that a finding line exists.

## The next bet at its horizon

Read when: about to write a study's next bet, pre-register a band over a window shorter than the one it was estimated on, or register a metric the notebook does not print.

S7 prints a next bet (a metric, a band, a window); it is a ledger result only when `app/loop/tools/preregister.py` writes it.

- **The band's width comes from the metric's spread AT THAT HORIZON:** cut the series into non-overlapping blocks of the bet's horizon and print their mean and st.dev beside the band. A band narrower than one st.dev claims the next block is predictable: show a lag correlation or widen it.
- **Compare against the naive forecasts on the same blocks** (the running mean, the last block, zero); a forecast that loses to the running mean is not a forecast. When the level is not predictable, register the SIGN.
- **The metric must be one the notebook prints over exactly the registered window,** under the name the pre-flight uses, or the bet can never be read back.

Unenforced: nothing checks a band against its horizon's dispersion. Measured (one pair, one regime): a band over the next 168 h came from monthly means, the weekly st.dev was about four times its width, and the running mean beat it.

## Rewriting a notebook cell by cell on a board

Read when: about to rewrite a notebook that needs the owner's approval on many cells, or to reopen a rewrite board a session ago left half marked.

The board is one HTML page in an agent-driven browser with one card per notebook cell: the output, the rewritten text and figure with the old version behind a fold, a comment box, a keep tick, a drop button. The owner marks it; the agent applies the marks; the notebook is built last. A one-line fix does not need a board.

1. Build the board from the notebook as it stands; the owner marks it.
2. Read the marks by evaluating `window.__board.state()` in the page and apply each comment in the generator or render script, with a migration that clears the notes applied.
3. Rebuild, reload the page, check the DOM, reply with what changed and what is uncertain, one line per card.
4. A card ticked keep is settled: build it as it stands.
5. On "build it", generate the notebook from the settled board (the `.build.py`, run with `nbclient`, PNGs quantised to 256 colours), then the structure check. The board never edits the notebook.

**What bit us.** The tab can vanish; the state lives in `localStorage` under `rewrite-board:<study>-v1`, readable from any `file://` page in the same browser profile. A rebuilt page carries the saved state through run-once migrations (`migs`); never reset the state. A patch script holding escapes goes in with Write or Edit. A hidden browser window cannot be screenshotted: verify the DOM and read the PNGs the render scripts wrote.

**Disciplines.** A render script re-runs the original setup, crops to a pinned window end and asserts the totals equal the original run before it draws. A grid moves to the appendix. A new summary card is proposed first on a page with accept and reject per change. A live reading is marked live and named unpinned.

**Gap, unenforced.** The board template, generators and render scripts are working copies in a temp folder, in no repo.

## Lesson: audit an intraday backtest with a second implementation on raw venue data

Read when: about to say a backtest is "correct", "checked" or "verified", or to trust an engine whose only test is its own `verify()`.

A `verify()` that the engine passes proves its books add up, not that its rule is the rule. The audit that found nothing wrong with an intraday engine and four things wrong with the study around it:

- **Re-implement the rule from its text, in plain loops, with no shared code:** its own EWMA, its own state machine, fills built from the four slipped prices instead of a price P&L minus a slippage line, funding attributed by timestamp instead of bar index. Demand the same entries, exits and net per trade to a millionth of a dollar, at several settings (a coincidence at one setting hides a bug). The notebook now runs it on every non-grid run, so the check cannot rot.
- **Compare with the venue's own endpoint, not the fund's data layer.** A direct read of the public candle and funding endpoints, bar for bar, against what the notebook read; plus the pinned rows. The only differences found were rows the venue no longer serves (archive-only, none differed).
- **A look-ahead probe must be able to fail.** Replacing every bar after a cut with a different random future and comparing TRADES missed a planted look-ahead (it only bites near the cut); comparing the SIGNAL before the cut at 40 random cuts caught it 40 times. Plant the fault, see the probe fire, then trust it.
- **Re-derive the statistics with your own code** (Sharpe, PSR, DSR, the bootstrap, the permutation, the break-even by bisection): all matched within Monte Carlo error.
- **The audit's real findings were not bugs.** The trade list shows what the totals hide: five trades carried the net, one side lost, and the rule did not hold on earlier days at another bar size. Count every setting run toward the deflated Sharpe from a registry that cannot undercount (the first count missed the 5m runs and three ladder levels: 99 became 106).

Unenforced: nothing makes a study carry a second implementation or a raw-venue comparison; `check.py` has no such probe.
