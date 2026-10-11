---
topics: [evidence, rules]
type: guide
---

# How we know

How a result becomes a belief, and how a check earns the right to say a number is right: tiers, windows, the lottery and the craft, small-n rules, what a green light may claim, and what makes a rule bind. Kept by the `fund` agent. A new learning is a new `##` chapter here, opening with its Read-when line.

## The tiers

Read when: about to move a belief up or down a tier, write a belief's evidence rows, or call anything MEDIUM or STRONG.

- WEAK: one of our runs, a bare theory, or a single external source.
- MEDIUM: 2-3 consistent runs on genuinely different windows or regimes, or one run of ours plus a strong external corpus whose n far exceeds ours.
- STRONG: repeated in-house AND survived an explicit kill attempt. Rare at our n, and that rarity is correct.

One of our runs is WEAK alone, however large the P&L: a number cannot promote itself by being big. Every belief names its would-change-it AND a kill test (the run that could falsify it, and its cost); a belief nothing could change is a slogan, so delete it or make it testable. Beliefs live in the desk's `beliefs.md`, each evidence row naming its window, and move only at the retro (`app/library/law/the-lab-loop.md#the-retro`).

## A shared window is one result

Read when: about to conclude anything from our own numbers, call a re-run a replication, or compare a headline across two runs or reads; or the second run reproduced the first to the dollar.

Two runs agreeing is evidence only if they COULD have disagreed. The same engine on the same cached window (or a pin) cannot: it is a determinism check, not evidence about the market. Two windows inside one regime share the regime, the thing you are generalising over. Replications sharing a defect, a data window or a regime are ONE result.

Before counting a replication, name what the runs did NOT vary: window, regime, cache, the venue's data revisions, interpreter, fixture, seed, parameter defaults, alignment convention. If nothing varied, nothing was tested twice. Hold the mechanic and vary the carrier: another window, venue, instrument in the class, regime, or out-of-sample data the desk never touched.

A rolled window is a new window. Histories are keyed by end hour and drift one hour per hour, so a +7d read is a different window (`app/library/law/the-lab-loop.md#fixed-age-reads-and-pins`) and not a replication either. A headline that moved between two reads has two candidate causes, the window and the code; the row says which was tested.

Measured: a re-run matched to the dollar under a changed wick-alignment convention, and a grid of 140 verified books turned out to be one window re-sliced: one observation. One carry package printed three different annualized returns on three reads, one of them on a silently truncated window; the truncated read was wrong and its number did not show it.

## Lottery and craft

Read when: about to report a headline P&L, rank strategies by total return, size a position from a backtest, treat a component as noise, or assume a fee, borrow rate or hedge cost.

Total P&L = the craft term + the beta term - costs. CRAFT is what the desk controls and what generalises: funding captured per unit of exposure, financing, fees, slippage, the hedge leg, the liquidations the sizing survived. It updates beliefs at small n. BETA is the lottery (a premium that widened, a spread that converged, a price that moved your way): real money, not skill, and it updates nothing, because a different window hands you its mirror image.

- Rank runs by craft, never total: the run that earned less and explained more is better. Predict a component, not a total. An exposure you did not intend is a finding, not a bonus.
- Report the mirror: run the opposite direction of any directional or paired construction. If the mirror is the negative of the result, the result is beta; a sign that flips with the direction you picked is a directional bet in a carry costume.
- Two totals within about 3x of each other teach nothing about which construction is better.
- Costs are craft, the one term knowable in advance. Read each from its publisher (a venue fee from the venue's own published schedule) into a dated row of the desk's `references.md`. No publisher means `[U]` and the result names the unpriced leg: an unpriced hedge leg is the wrong answer, not a conservative one.
- When the lottery IS the point (an unexplored venue, a WILD run), buy many different tickets and study the winner; variance reduction there suppresses what pays.

Measured: a perp pair's large annualized return was mostly the implied premium drifting, with funding a minority of gross, and the mirror lost money. Raising leverage tenfold left funding's share of gross and the Sharpe unchanged: leverage enlarges the premium bet and buys no craft.

## Survivorship shapes

Read when: about to treat a series' start date as a listing date, a renamed or converted instrument as continuous history, or a venue's live symbol list as live.

Three shapes of history have cost us:

- A young market is not a truncated one. A 1h series starting 208 days back is the venue's retention cap; one starting at a listing date is a listing date. Prove which with a coarser interval.
- A converted pre-IPO line, a renamed ticker and a delisted contract look like clean history until you ask what happened at the break. A funding-multiplier break in one instrument was found IN THE DATA, not in a changelog.
- A venue's "live" list can hold settling or delisted contracts that still emit a rate: 134 symbols on one venue's premium index were. Reconcile against the venue's trading-status list.

## Small-n rules

Read when: about to kill or crown a strategy, parameter or mechanic, plan the next run from one result, or quote an outside source about how a venue works.

- 2-3 shots before a kill or a crown. Nothing dies or gets promoted on one window.
- At most 2 named variables per run against its nearest ancestor; a new mechanic counts as one. More and the result attributes to nothing.
- Replicate before you reorder. When one result would change the plan, the next run REPLICATES it on a different carrier; explaining an unconfirmed finding is the most expensive mistake at this sample size.
- Check the base rate before you crown a cause: a number is abnormal only against the distribution it came from, so pull the desk's own history and the comparator first.
- An outside source is not evidence about a venue. What a paper, blog or another fund says an exchange does is evidence about that write-up; read the venue's endpoint or document first. A "this venue publishes no bulk cadence call" law sat in the code until one symbol-less call returned the whole universe.

## What would it print if false

Read when: about to write or trust a check, gate, audit or `verify()` that prints a verdict, or about to believe a green light that has never gone red.

The more precisely a green light describes the thing you care about, the longer it can be wrong for: a check that undersells itself gets queried, one that names the right property and tests a weaker one never does. Ask of every gate: what would this print if the property were false? If the answer is "the same thing", it is not evidence.

- Write the sentence the check can defend, no bigger: a test that every row has a cadence field says `every row carries a cadence`, not `every cadence is correct`. A green light is the record register, never the confident one.
- A green you have never seen go RED is an untested check. Break it on purpose once and record in the run row that you did; sixteen of sixteen means nothing until you know fifteen of sixteen is reachable. `.venv\Scripts\python.exe app\tools\probes\overclaim.py` does it mechanically: each case builds a world where the property is false, runs the real check, and prints CAN FAIL or CANNOT FAIL (a finding, not a pass; N/A is unknown, never a pass).
- Per-item checks cannot see structural failures: "does each symbol have an `interval_h`" passed happily while 453 carried a defaulted 8h. The fix is a SECOND check of a different shape, never a tightening of the first.
- Where the number is a DECISION, the check that prints it and the gate that acts on it are one object; where it is EVIDENCE they are different objects. Decide which you are writing.

## Checks that cannot fail

Read when: about to write a check whose body only calls something or whose expected value comes from the code it tests; to believe a null result (no gaps, no conflicts, 0 failures) or call something verified because you looked at the output; or to write a warning that stays on once raised.

- "It did not raise" is not a check. A body of the shape `fn()` passes on an empty map, a map of defaults, a map of the wrong venue: give a call worth running one assertion about its return, or name it `loads` and count it apart. Measured: a selftest's per-venue interval greens were this; one broke and stayed green, so each map is now compared symbol for symbol with the venue's universe.
- An expected value computed by the code under test is circular: a matrix check deriving its expected cost from the fee function proves the matrix USES the fee, never that the fee is right. Pin a literal, read the source of truth, or call it a formula check.
- An instrument that CANNOT produce the failure cannot measure it, and its null looks like the all-clear: a coverage report over a window the venue still serves cannot see truncation, so a candle-coverage check confirms a cap with a 4h or 1d probe that shows the market traded before the 1h edge.
- A check that read zero inputs prints the same as a pass: count what it saw and fail on none. Measured: the link audit, given the wrong roster folder, saw 0 agents and printed no dead refs; given the right one it saw 13 agents and 20 refs and printed none either, so only the count told them apart. `app/tools/context.py` now fails on an empty scan, and its test empties the scan once.
- A success path that has never run is a failure scheduled for the moment of success (a desk with zero open issues, a sweep with nothing to archive): force the input. A drill licenses only the branch it exercised, and looking at output tests the data, not the rule: pin the branch today's data skips.
- n=1 is not a pattern, and the tell is that what you were just doing explains it. Report CADENCE, not the newest event. Measured: a ~30% annualized BTC funding print looked like a bug and was real (a two-hour premium spike against a much lower 7d settled mean).
- An alarm is a function of the world, not a memory of one: ask what makes it go out. "Someone runs it again" makes it a sticker; a one-per-process stderr warning is right because the process ending clears it.

## Landed is not live

Read when: about to write "verified" or "shipped" while a server, daemon, cached build or already-spawned agent session may hold older code or prompt.

A change can be committed, verified and merged while the process serving a human runs last hour's code: a dev server, a cached build, a daemon, an agent session spawned with the old prompt (it keeps the boot books it started with; the cockpit restarts itself only when idle). Before writing "verified", name WHICH ARTIFACT you tested, the source or the process holding it, and compare the server's start time to the commit's. The cockpit case: `app/library/app/cockpit-ui.md#landed-is-not-live`.

A check served by a process has the same flaw. Measured: `node app/tools/library/links.mjs`, which asks the running fundd, reported 20 dead chapter boot refs; `audit()` imported from the current source found 0. A verdict from a server names the server.

## The mechanism ladder

Read when: about to write a rule for future sessions, add a "remember to" or "always check" line to any doc, pick a parameter by hand where a script could pick it, or fix a recurring miss with a paragraph.

"Remember to check X" is the failure mode itself: the miss happens at write time, when nobody is reading. A rule whose violation is invisible when it happens needs a mechanism that runs without being invoked, produces a VERDICT rather than a note, and has something downstream depending on it (an exit code, a refused commit, a red row).

The ladder, cheapest first:

1. A schema or type, where the wrong thing cannot be expressed (every snapshot row needs a `unit`, because an annualized and a per-settlement rate differ by 8760x on an hourly market).
2. An allow-list or deny-list (`.claude/settings.json` denies force-push, `reset --hard`, `checkout --ours`): no session has to remember a ban that is not available.
3. A gate in a numbered spine (the pre-flight is a commit before the engine runs: `app/library/law/the-lab-loop.md#pre-registration-is-a-commit`).
4. A script with a ledger (a picker, sweeper or reconciler that logs at draw time): where a desk has an interchangeable choice and a cadence, the picker is this.
5. An audit that exits non-zero (`app/tools/probes/`, `app/tools/check.py`).
6. A book with a Read-when line: the weakest, and honest ONLY if the chapter says it is unenforced. A rule asserted as prose and believed enforced is worse than nothing, because it holds the slot a mechanism would have taken; so is a mechanism whose assertion outruns its check.

Corollary: never quietly park something the owner handed you. Flag the worry and let the owner decide; a mechanism you chose not to build is a board item with a reason, not a silence.

Measured (undated in its source): "never default a funding cadence" was true for months while a snapshot annualized 831 symbols on two venues at 8h, because nothing checked. The fix was a mechanism: a row whose cadence is not KNOWN from the venue is OMITTED, and the bulk cadence fetch RAISES instead of returning an empty override map.

## The law must be loaded

Read when: about to boot an agent, hook or scheduled job anywhere but the directory its rule file sits in; to stand up or change a desk's own `.claude/settings.json`; or reading an agent's report that "the permissions refused me".

A rule in a FILE binds a process only if that process READ it. Where the file sits and where the process starts are two facts, and the gap is silent: the file and the code naming it are correct, and the rule is not in the room. So boot is part of the law: ship the LAUNCH that loads the file, one definition every caller passes through, tested. That is `app/server/chat/launch.ts`, scheduled agent jobs included (`app/library/app/cockpit-server.md#the-launch-contract`).

When a process starts away from its rule file, ask: did it load the file? did it KEEP what it loaded (trust, precedence, a merge that replaced instead of adding)? what case would have failed? A stack that answers a misconfiguration by carrying on with less prints one stderr line, and everything after it looks like a rule never written. Probes: `app/library/law/how-we-guard.md#probing-the-deny-list`.

- Measured 2026-09-21 and 2026-09-22: Claude Code loads `.claude/settings.json` from the launch directory only and every seat booted at its desk, so for months the list bound only the root seat; and a desk's file with 17 correct allow rows was discarded as untrusted: trust is per directory, a nested repo is its own workspace, and the flag lives in `~/.claude.json`, outside both repos and absent on a new machine.
- Gotchas: a launcher's own environment rides the spawn (a POSIX `PYTHONPATH` broke the agent's `python.exe`), and a prompt on a Windows command line crosses `cmd.exe`, which eats `<`, `>` and `|`: a permission failure that was a quoting failure.

## Fence your examples

Read when: about to put a worked example (an entry, a row, a JSON object, a command's output) into a file a script also parses, or scaffold many desks from one template.

Three kinds of text share a machine-read file: the RECORD, the EXAMPLE and the PLACEHOLDER. A parser that cannot tell an example from a record reads a new desk's template example as a real row, exactly when its ledger is honestly empty. Fence examples; mark placeholders `<angle brackets>`; the parser blanks fenced blocks first. Mechanism: `strip_fences()` in `app/loop/tools/_common.py` (length kept; entries and beliefs are found in the blanked text and sliced from the original), asserted by `app/loop/tools/tests/test_loop.py`. Measured 2026-09-21: an audit printed 21 warnings, 20 of them one template example repeated at twenty desks. Nothing checks that a NEW machine-read file's parser blanks fences.
