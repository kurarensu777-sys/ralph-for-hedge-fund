---
topics: [loop]
type: guide
---

# The lab loop

How a desk in `platform/lab/<desk>/` runs and learns: the loop in commands, pre-registration, fixed-age reads and pins, the retro, mechanics and the menu, the anti-narrowing floor, the files a desk must carry (the run record included) and the venue desk. Kept by the `fund` agent. A new learning is a new `##` chapter here, opening with its Read-when line.

## The loop in commands

Read when: about to run a desk's loop end to end, a loop tool refused a step, or asked how the loop fits together.

```
cadence.md -> read the record + the now + the external comparator -> EXPLOIT | EXPLORE | WILD
  -> PRE-REGISTER (its own commit) -> run through the gates -> RECORD, schedule the +7d and +30d reads
  -> retro: grade the judge -> move beliefs -> ONE next bet + stamp
```

The fast clock (every run) runs inside the slow one (the retro, the only place numbers move doctrine); the owner's taste crosses both. Each arrow is a script in `app/loop/tools/`, run from the fund root as `.venv\Scripts\python.exe app\loop\tools\<tool>.py`; `--help` and `app/loop/tools/README.md` carry flags and refusals. `--desk` takes the full id (`lab/example`), the path under `platform/lab/` (`example`), or a leaf when one desk carries it. History that predates a desk's ledger is IMPORTED, never invented (`backfill.py`: `preregistered: false` and a `provenance`; grading, `retro_due.py` and the digest skip such rows).

## Pre-registration is a commit

Read when: about to run an engine whose result will be recorded; `record.py` refused a pre-flight as not in HEAD, not its own commit or later than `--ran`; or about to trust a pre-flight's `ts` as proof it came first.

A pre-flight written after the numbers reads like an honest one, and a row's `ts` is typed by hand. Git order is the one witness nobody writes by hand: `preregister.py` writes the pre-flight, then commits exactly the desk's `results-log.md` and `data/runs.jsonl`, alone, BEFORE the engine runs. Register, see the SHA printed, THEN run.

Predict a BAND (`20..30`, `-6 to -2`, `>= 0`; an integer is a COUNT; a point estimate is refused, it cannot be calibrated) and register `--metric-pattern ann_pct=<regex with one group>` so `remeasure.py` can read the metric back. The identical command on the identical window is not a run; a re-run on a rolled window varies the window, say so.

`record.py` proves the pre-flight row is in HEAD, its commit touched only those two files, and its author time is not later than `--ran`. It cannot prove `--ran` is the real start (the runner types it); the commit's ancestry cannot be faked without rewriting history, which the rails forbid. `REFUSED: ... not in HEAD` means the order was broken: register a NEW run id, never commit the old pre-flight after the fact.

Measured: one run's pre-flight and its result landed in the SAME commit, so only a typed field said which came first.

## Fixed-age reads and pins

Read when: a +7d or +30d read has come due, you are about to re-run a recorded command or quote a number from an earlier read, or you are recording what a result read.

A result read at a different age is a different result (`app/library/law/how-we-know.md#a-shared-window-is-one-result`): each run is read at the run, at +7d and at +30d on the ROLLED window, and the entry says whether a move came from the window or the code.

- `remeasure.py` EXECUTES the recorded `--cmd` on the window as it then stands; a number copied forward is not a read. Reads are write-once per age. A read more than `--tolerance-days` (4) late is logged `missed` with whatever it found, never backfilled; an early read is refused. `--emit-jobs` prints the schedule entries and does not edit `app/schedule.json`.
- Metrics are read back mechanically or not at all: with no registered `--metric-pattern` the metric is `parse: pending` and the full stdout is kept under `<desk>/data/reads/`.

A result keeps what it read, because the cache evicts: `--input venue:symbol:dataset:interval` on `record.py`, `remeasure.py` and optionally `preregister.py` pins each input's in-window rows (content-hashed, immutable, never evicted) through `app/loop/tools/pins.py`; a digest mismatch REFUSES the record. `--no-pin` opts out (`fingerprint.pin_skipped: true`); a store failure or an empty window records `pin: null` with a `pin_error`, never a fake hash. `record.py` does not refuse an unpinned result: UNENFORCED.

## The retro

Read when: running a retro (reads, grading the judge, tiers, mechanics, the next bet and stamp, the digest), a run has a pre-flight and a landed read, or asked when a retro is DUE.

The retro is the slow clock, the same method for every desk, and the ONLY number-driven writer of `beliefs.md`, `mechanics.md` statuses and `menu.md` marks. It reads ONE desk's own files and writes only that desk's doctrine. Due when the `beliefs.md` stamp is older than 7 days OR more than 5 runs landed since (`retro_due.py`; the `cadence.md` step-2 nag never blocks a run). Seven steps:

1. SNAPSHOT AND REPORT. Re-run the desk's entrypoints and append snapshots (`snapshots.py append --desk <d> ...`); fold closed fixed-age numbers into the ledger (write-once) and refresh `latest`, which only the retro moves; record verify counts as printed.
2. COMPLETE THE READS, and never let this step block the pass: a learning loop gated on a human's attention does not run. A read more than ~4 days overdue is `missed`.
3. GRADE THE JUDGE before anything moves. For each entry with a pre-flight AND a landed read, append its `**Calibration:**` line (actual vs the band; in-band, over or under) and the `beliefs.md` Calibration row, then scan all graded rows for a standing miss (same direction, same mechanic, twice or more), which later pre-flights weight against. `grade.py` reports, never gates. Moving beliefs first fits the grades to the conclusion.
4. MOVE BELIEFS by `app/library/law/how-we-know.md#the-tiers` and nothing else. Every change cites evidence rows with their windows and keeps a would-change-it and a kill test; new beliefs enter WEAK. A change that would BIND future sessions (a law line, a gate, a settings entry) is PROPOSED in the digest, never written here.
5. UPDATE THE MECHANICS AND THE MENU, then do the two counts (`#mechanics-the-menu-and-the-two-counts`).
6. SET ONE NEXT BET AND THE STAMP: the single run that would move the most load-bearing uncertain belief, explicitly EXPLOIT, EXPLORE (name the feeder if no reference exists) or WILD.
7. DIGEST, at most 12 lines: `digest.py --desk <d> --write` saves a skeleton to `lab/<desk>/retros/<YYYY-MM-DD>.md` (never overwrites). Fill every `<FILL>` and commit it WITH the stamp. The owner's replies apply at once; silence means the digest stands.

The retro never writes another desk's memory: a belief that earns a tier or a mechanic that goes cold becomes a candidate to file one tier up (a venue quirk to that venue's own book, a reasoning rule here), stripped of the desk's numbers, with a `from:` line. An empty retro is a real retro: say so in three lines, renew the stamp with `through run NN` unchanged, and stand down; a belief manufactured to justify the sitting outlives it.

## Mechanics, the menu and the two counts

Read when: naming a mechanic for a pre-flight, adding a menu row, marking a mechanic cold, or doing a retro's step 5.

A MECHANIC is the reusable half of a run with the desk's parameters stripped off. Run-level n is tiny, so mechanics are where a desk manufactures sample size. A run either exploits a proven mechanic (named in the pre-flight, one thing varied) or declares ONE untested mechanic as its single experiment. No named mechanic, no run: `preregister.py` refuses one that is not a row in `mechanics.md`. Statuses: `*` proven, `^` reading, `o` untested, `~ cold at n=X`. Shots on the same window are ONE shot, and the status column must say so.

`menu.md` suggests and weighs; it never schedules (`cadence.md` owns the judgment). Weights are earned per desk at a retro and never inherited.

The two counts, in every retro digest, as numbers: (1) openings vs closures over the last ten runs; a lopsided ratio is machinery with no reopening path, not bad luck. (2) `available today: N of M` menu rows that can actually RUN, with a reason for every dark row (a source stopped serving, a window too short, an entrypoint that errors, a kernel that no longer resolves). A register of OPEN options and a register of AVAILABLE options drift apart, and only the first is maintained.

## Comparator, cold at n, the WILD floor

Read when: about to RETIRE, kill or close a strategy, range, venue or mechanic; a desk's menu has opened nothing in ten runs; choosing the next run's kind; or about to drop a leg, window or claim for want of a source.

A loop that only closes options is self-narrowing, and looks healthy the whole way down because each closure is justified. Its own discipline (one variable at a time, pre-registered predictions, replicate-before-reorder) is variance reduction: right for a rate, wrong for a fat-tailed payoff. Killing a range on one regime costs nothing; reopening it needs an argument nobody is paid to make.

- An EXTERNAL comparator, pulled at step 0 before the plan is read, never remembered: the T-bill hurdle, always-hold, buy-and-hold, the venue's resting rate, the unhedged leg, the mirror direction. `cadence.md` step 2 names the desk's. A stale hurdle silently flatters every result: its read date lives in `references.md`.
- NO VERDICT IS TERMINAL. The label is `cold at n=X`; "dead", "retired" and "closed" are banned from every ledger. A parameter killed on one window is untested; the row stays and the count is the verdict.
- A NOVELTY FLOOR with a WILD slot: name the two or three axes a run varies on, repeat no more than one against the last three runs, and make ONE RUN IN FOUR something the desk has never done, chosen BECAUSE there is no evidence for it (`--kind wild`, `--experiment "WILD - <what>"`). `menu.md` carries a WILD table (Run, The WILD thing, Outcome) so a quarter without a row is visible. After about five consecutive exploits the next run EXPLORES.
- RECORD THE DELETION. Rigour can delete material, not only options, and leaves no trace. When you drop a leg, window or claim for want of a source, or widen a band you cannot defend, write one line in the desk's `research-log.md`: what was dropped and what would restore it. A deletion with a restoration condition is craft; a silent one is how a desk talks itself into a smaller book.

Measured at a carry desk: a capital-scaled regime rule lost to always-hold purely through premium it sat out, and a hard stop turned a surviving book into a liquidated one; both look like prudence from inside.

## The desk template

Read when: standing up a desk, editing a desk's cadence, beliefs, mechanics, menu or ledger, writing or correcting a row of `data/runs.jsonl`, or a loop tool refused a desk for a missing or malformed file.

A desk is a folder under `platform/lab/` holding a `cadence.md`; its logical id `lab/<path>` is stable in every row. `.git`, `__pycache__`, `issues`, `levers`, `memory`, `reads` are never desks, nor a `data` folder beside a `cadence.md`. `preregister.py` refuses a desk missing any of the five required files. A desk's files carry only their own delta. What the tools read:

| File | What the tools require |
|---|---|
| `cadence.md` | a `State:` line in the first 12 lines holding one of PRE-LIVE, OPENING, LIVE (`**State: OPENING.**`); a line still listing several, separated by `\|`, reads PRE-LIVE. |
| `beliefs.md` | the stamp in a fenced block near the top: `Last retro: <YYYY-MM-DD or none yet> · through run <id> · next bet: <one line>` (the `·` separators are parsed). Each belief a heading `### B<n> · <claim> - <TIER>` with WEAK, MEDIUM or STRONG in the heading or its first 200 characters, a "Would change it" line and a "Kill test" line. A heading starting `<` is the template placeholder; a run cannot be registered against it. |
| `mechanics.md` | a table whose rows start `\| M<n> \|`: ID, Mechanic, What it does, Our shots (window + read), External corpus, Status. |
| `menu.md` | must exist; the retro keeps its option table, WILD table and `available today N of M` row. |
| `results-log.md` | a ledger table whose header starts `\| Run \|` (any column order; tools fill cells by column name, replace the `-` placeholder row the first time, and never overwrite a filled cell), then `## Entries` with one `### <run id> - <title>` per run holding `**Pre-flight:**`, `**Window:**`, `**Code:**`, `**Comparator:**`, `**Verify:**`, `**Result:**` (a `pending` line is not a result) and `**Read:**`. |
| `data/runs.jsonl` | append-only with `merge=union`: one JSON row per (`run`, `stage`), stage `preflight`, `result` or `read`; a run id is unique per stage. Required: `run` `desk` `ts` `kind` (`exploit`, `explore`, `wild`) `mechanic` `cmd` `window` `verify` `provenance`; a row with no `window` is not admissible as evidence. `window` is `{from, to, hours, regimes}` in UTC with a `Z`; `verify` is `{suite, passed, total}`; `variables` name at most 2 changes against the `ancestor`. Never rewrite, sort or delete a line: a correction is a NEW row with `corrects` (`record.py --corrects`). A percentage is 26.40, not 0.264; a field you cannot fill honestly means no row. |

Examples go inside fences only: a fenced belief or entry is never parsed (`app/library/law/how-we-know.md#fence-your-examples`). Every `B<n>` cited on a desk must resolve in `beliefs.md`; a dangling one means a retro was skipped. A belief coined in a run entry and never landed in `beliefs.md` does not exist.

## A venue desk

Read when: about to run, judge or set up a desk whose subject is one venue (a desk under `platform/lab/venues/<v>/`).

A venue desk holds the ledger and the reasoning for one venue; the edit itself goes through the agent that owns the venue's adapter. It optimises one thing: every field the fund reads from the venue equals what the venue itself publishes, symbol for symbol, above all the per-symbol funding cadence (at a venue with no funding: what a price means and where a listing stops, or which published series a value belongs to).

- Two gates beside the four standing ones: VENUE-TRUTH (every changed field is compared against the venue's own live response for at least one symbol per code path, and the comparison goes in the row; passing tests are evidence about the fixtures) and CADENCE (no symbol enters a snapshot with a cadence the adapter did not read from the venue).
- The comparator is the venue's own published value for the same field, pulled in the same run. Reconcile symbols against the venue's trading-status list first (`app/library/law/how-we-know.md#survivorship-shapes`).
- A lesson true of one venue is a chapter of that venue's own book; true of every venue, of the platform shelf (`app/library/platform/`).
