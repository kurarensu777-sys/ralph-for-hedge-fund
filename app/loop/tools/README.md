# `app/loop/tools` - the fixed-age machinery

The agency's confession: *"nothing mechanically verifies that a retro actually ran, that B<n>
citations resolve, or that a next-bet was honoured."* Their law: **a rule that binds ships with
its mechanism.** These are the mechanisms for the learning half of the loop. (`audit.py`, the
structural half, retired at the 2026-09-24 cut-over (git history); the refusals below are the
tools' own and still bind.)

Run everything from the fund root with the fund's ONE venv:
`.venv\Scripts\python.exe app\loop\tools\<tool>.py`

**Where things are (the 2026-09-24 layout; since 2026-09-25 the desks' folders sit under
`platform/lab/`, and a desk keeps its logical id `lab/...` in every row).** A desk is a folder
holding a `cadence.md` (`lab/platform/carry`, `lab/venues/exchange_c`, `lab/research`, ...); `--desk`
takes that path, the fragment after `lab/` (`platform/carry`), or a leaf name when exactly one
desk carries it (`carry`, `exchange_c`). The names before the 2026-09-24 rename (`lab/api/lib/carry`,
`desks/api/lib/carry`, `api/lib/carry`) still resolve, to the new folder - old rows and old docs
keep working (`_common.canonical_desk`). Commands run in the nested
repos: `--cwd` defaults to `platform`; a notebook run passes `research`. Rows written
before the cut-over say `cwd: "crypto"` and `crypto_commit`; they are READ through a map
(`crypto` -> `platform`, `crypto/research` -> `research`), never rewritten.

## The loop, and which tool owns each step

```
PRE-REGISTER   preregister.py   the prediction, on disk, timestamped, BEFORE the engine runs
    |
RUN            (the desk's cadence - not this folder's business)
    |
RECORD         record.py        write-once result + the four gates + the immediate grade
    |
READ           remeasure.py     re-run the recorded command at +7d / +30d on the ROLLED window
    |
GRADE          grade.py         predictions vs reads; the calibration table; "predicting too wide"
    |
RETRO          retro_due.py     is one owed?      digest.py   the <=12-line skeleton
```

## The tools

| Tool | What it does | Exit |
|---|---|---|
| `preregister.py` | validates and appends a pre-flight to `results-log.md` AND `data/runs.jsonl`, then commits those two files ALONE (`preregister <desk> <run>`, `Agent:` trailer) before anything runs. Optional repeatable `--input`: the window's rows AS THEY STAND at registration are fingerprinted and pinned (reason `preflight`, ref `<desk>:<run>:preflight`) into the row as `fingerprint` (`--no-pin` skips the pin) | 0 written and committed, 1 refused, 2 usage |
| `backfill.py` | IMPORTS history that predates this ledger: a `stage: result` row marked `preregistered: false` with a `provenance` naming its source | 0, 1 refused, 2 usage |
| `record.py` | write-once result, gate outcomes, per-metric hit/miss, ledger row; refuses a pre-flight that is not its own commit or is later than `--ran`. `--input` fingerprints AND pins the rows it read (reason `result`, ref `<desk>:<run>`); a pin that does not match its digest refuses the record; `--no-pin` opts out, recorded as `fingerprint.pin_skipped: true`; `--dry` never pins | 0, 1 refused, 2 usage |
| `remeasure.py` | executes the fixed-age read; `--emit-jobs` prints the schedule snippet. The read's fingerprint pins too (reason `read-7d` / `read-30d`, ref `<desk>:<run>:<age>`); a refused pin lands as `fingerprint_error`, never a lost read; `--no-pin` opts out | 0, 1 refused, 2 the re-run failed |
| `grade.py` | calibration per desk; flags a judge that is too wide, too narrow, or biased | 0 always (a report, not a gate) |
| `retro_due.py` | stamp older than 7d OR >5 runs since; `--line` is the one-line debt string | 0 nothing due, 1 something is |
| `trial.py` | appends ONE evaluated configuration to `data/trials.jsonl` (append-only; abandoned cells too), or a whole sweep with `--cells-file grid.jsonl` (one `{cell, status?, returns? \| sharpe, n_obs, skew, kurt}` per line, all-or-nothing). The Lab room reads it for DSR (N = distinct trials of the mechanic) and PBO (CSCV, 16 blocks) | 0, 1 refused, 2 usage |
| `fingerprint.py` | digests the stored rows a run read (`venue:symbol:dataset:interval`, read-only from the market lake through `fund_db.market`; funding, candle and eod rows in the fixed canonical shapes of `fund_db.market.canonical`, so a fingerprint and a pin of the same rows agree byte for byte; the dataset is the lake's own name, e.g. `exchange_a:BTC:candles:1h`, `exchange_b:BTCUSDT:funding:-`, `eod_feed:AAPL.US:eod:-`); `record.py` / `remeasure.py --input` write it into the row; a read with no `--input` re-digests the result's own `fingerprint.inputs` (`--no-input` turns that off). `fingerprint(..., pin={reason, ref})` pins each input through `pins.py`; the digest itself never moves (a literal in `tests/test_pins.py` holds it) | 0, 1 refused, 2 usage |
| `pins.py` | THE ONE adapter to the data layer's pin API (B-0322, B-0324): `available()` and `pin_input(inp, window, reason, ref)` over `fund_db.market.pin_series(spec, window, reason=, ref=, expect=)`. The pin hash must EQUAL the input's sha256, else REFUSED; no pin API yet, a store failure or an empty window -> `pin: null` + `pin_error` (honestly unpinned, never a fake hash). A later shape change of the API is a swap of this one file | - (imported) |
| `digest.py` | the retro digest skeleton, every number pulled from a file; `--write` saves it to `lab/<desk>/retros/<YYYY-MM-DD>.md` (never overwrites) | 0, 1 `--write` refused |
| `snapshots.py` | the SNAPSHOT STORE: rows of the lake's `snapshots` dataset, one log per desk, written and read only through `fund_db.market` (no file of its own). `append --desk <d> --subject --source --field --value --unit --provenance [--note]` (or `--rows file.jsonl`) writes a desk's live readings, refusing an incomplete row or a unit outside the schema; `show --desk <d>` reads them; `where` says where the rows live; `migrate` merges the older homes (the retired `~/fund-data/snapshots/<desk>.jsonl` store and a tracked `lab/<desk>/data/snapshots.jsonl`) into the lake, verified, once per process, so no row is lost. The probes write through it (`app/tools/probes/_probe.py`) | 0, 1 refused, 2 usage |
| `_common.py` | desk resolution, band grammar, results-log and beliefs parsing, jsonl io | - |

### What `preregister.py` REFUSES, and why each one matters

A prediction written after the numbers came back is *indistinguishable* from an honest one once
it is prose in a file. That is why a tool writes it, not a rule in a skill.

- a **result already exists** for this run - after-the-fact registration
- a **pre-flight already exists** - pre-registration is write-once
- the **mechanic is not a row** in `mechanics.md` - a run with no named mechanic does not ship
- **more than 2 named variables** vs the ancestor - more and the result attributes to nothing
- the **ancestor is not in this desk's record** (unless the desk has no runs at all)
- a prediction that is **not a band** - a float point estimate cannot be calibrated: it is either
  exactly right, which never happens, or wrong, which teaches nothing about how wrong. An integer
  is accepted as a COUNT (`liquidations=0`)
- a **belief under test that does not exist**, or one still holding the template placeholder
- **no window** (not admissible as evidence) or **no command** (the reads re-run it)
- **no platform commit SHA** (`platform` HEAD; a result with no code version is not
  reproducible). A run whose `--cwd` is inside `research` also records `research_commit`
- the desk's **`results-log.md` or `data/runs.jsonl` has changes not in HEAD** - land them first

**Then it COMMITS, on its own, before anything runs** (B-0071, 2026-09-25): exactly those two
files, message `preregister <desk> <run>`, trailer `Agent: <FUND_AGENT or you>`, through the
normal hooks. Git order, not the row's `ts`, is what proves the prediction came first - vol-w01's
pre-flight and result landed in one commit, and only a timestamp anyone could type said which
came first. A failed commit restores both files byte for byte and registers nothing, and a fund
root that is not the top of its own repo is refused (a commit never walks up into an enclosing
repo). Push with the next landing; the local commit is the proof.

Band grammar: `20..30`, `20 to 30`, `-6 to -2`, `>= 0`, `<= 5`, `0` (integer count only).

### `backfill.py`, and why importing history needs its own refusals

A desk can open with a record it did not make here - the two pilot desks were seeded from the
code repo's own `HQ.md`, run by run, with their windows. Those rows are EVIDENCE and they are
not predictions, and once a row is in `runs.jsonl` nothing downstream can tell the two apart
unless the row says so. Every row this tool writes carries `preregistered: false` and
`provenance: "backfilled <date> from <source>"`, and every consumer reads them: `grade.py` never
scores it, `retro_due.py` never counts it as a run the desk chose (it would be retro debt nobody
could ever discharge), `digest.py` leaves it out of the EXPLOIT/EXPLORE/WILD mix, and nothing
demands the pre-flight it deliberately does not have.

**This tool may import history; it may not create it.** It refuses a run with no `### <run>`
entry in `results-log.md` behind it (a row with nothing behind it is invention), a run that has
a pre-flight here (that one belongs to `record.py`), a second result, a missing window, and a
verify that is neither `n/n` nor an explicit `--verify-none "<why this run has no count>"`.
`--probe` is for a venue probe with no price window at all: the window becomes the DAY the venue
was asked, marked `kind: "probe"`, rather than a price range that was never measured.
(`audit.py`'s `imports` check, which re-checked those rows after the fact, retired with it on
2026-09-24; the refusals at write time are what remains, and they are tested.)

### `record.py`'s four gates

`--gate provenance=ok --gate window=ok --gate verify=ok --gate scope=ok`. All four are named one
by one so that skipping one is *visible*; an unstated gate is a refusal. A verify that is not
`n/n` is refused unless `--verify-failed`, which records the failure as the finding it is.

Before any of that, `record.py` **proves the pre-flight commit**: the row must be in HEAD's
`runs.jsonl`, the commit that introduced it (found by pickaxe on its exact line) may touch only
the desk's two ledger files, and its AUTHOR time (a `pull --rebase` rewrites the committer time)
may not be later than the run's start, `--ran <UTC ISO>` (default now; a future `--ran` is
refused). The result row carries `ran` and `preflight_commit`.

### The pin: why a result keeps the rows it read (B-0322, 2026-09-28)

Data is now pulled on demand into a size-capped cache that EVICTS. A fingerprint over rows the
cache has since dropped could never be re-checked, so every fingerprint the loop writes (the
result, each fixed-age read, and an optional pre-flight) also PINS each input's in-window rows:
content-hashed, immutable, never evicted. The pin's hash IS the fingerprint's per-input sha256
(the legacy rule, byte for byte), so a ledger fingerprint written before pins existed compares
with a pin directly. `pins.py` checks the returned hash itself rather than trusting the store's
`match`, and a mismatch is refused: the store held different rows than the digest read. Until
the data layer's API is in the interpreter, each input records `pin: null` with `pin_error:
"fund_db has no pin API yet (B-0324)"`, and the record still lands.

### `remeasure.py` and the roll

Every cached history at this fund is keyed by its **end hour** and drifts forward one hour per
hour, so the +7d read covers a genuinely different window. A number copied forward is not a read,
and nothing downstream could tell - so this tool *executes*, it does not prompt. Reads are
write-once per age; a read more than `--tolerance-days` (4) late is logged `missed` with whatever
it found, never dressed up as on-time; reading early is refused, because that is a different age.

Metrics are read back **mechanically or not at all**: register `--metric-pattern
ann_pct=<regex with one group>` at pre-registration and `remeasure` applies it to the re-run's
stdout. Without a pattern the metric is `parse: pending` and the full stdout is preserved under
`<desk>/data/reads/`. A metric guessed out of prose is worse than a gap.

`--emit-jobs` prints the one-shot `at <iso>` entries for `schedule.json` on stdout and
**does not edit that file** - the cockpit's scheduler reads it, and a tool that edits it behind a
hand's back is how two hands collide.

### The `stage` field (the one addition to the data README's shape)

`data/README.md` allows added fields. The loop adds `stage`: `preflight` | `result` | `read`.
A run id is unique **per stage** - exactly one pre-flight, at most one result (a correction is a
NEW row carrying `corrects`), one read per age. `preregister.py`, `record.py` and `remeasure.py`
refuse every second write at the moment it is attempted.

### `grade.py`'s flag that nobody writes by hand

**A band that always hits is not a good judge, it is a wide one.** A desk whose last graded runs
ALL hit is flagged `predicting too wide`, with its median band width as a share of the band's own
midpoint printed beside it so the number behind the flag is visible. The mirror (`too narrow`)
and the more useful one - a **standing miss in one direction**, which names a bias rather than
noise - are there too.

## Tests

```
.venv\Scripts\python.exe app\loop\tools\tests\test_loop.py      # 61 tests on 2026-09-25
.venv\Scripts\python.exe app\loop\tools\tests\test_pins.py      # 23 on 2026-09-28 (1 expected failure)
```

`test_pins.py` fakes `fund_db.market.pin_series` for one test at a time and hands
fingerprint.py FIXED rows, so no test writes a real pin or depends on the lake. Its literal
digests were computed with fingerprint.py as it stood before the pin path (app `3265414`); the
refusal of a mismatched pin was broken once on purpose (5 tests red). One test is an expected
failure on purpose: `fund_db.market.pins_digest` drops an optional field present only in a later
row (it types its table from the first row), reported on B-0324; when the data layer fixes it the
run reports an unexpected success and the marker comes off.

`tests/fixtures.py` materialises one fund tree in the 2026-09-24 layout: a LIVE desk at
`lab/alpha` with a pre-registered, recorded run, and an empty desk at `lab/platform/data/zeta`
- the shape the old desk walker could not see, because it pruned every folder named `data`. The
clean path is forced on purpose: a success path that has never run is a failure scheduled for the
moment of success. (The BROKEN twin tree existed to feed `audit.py` and retired with it.) The
tree is its OWN git repo (built once per process, copied per test, `.git` included), so the
pre-flight commit and its proof run against real history and never against the fund repo; the
B-0071 class also checks the real fund HEAD is unchanged when it finishes.

```
.venv\Scripts\python.exe app\loop\tools\tests\fixtures.py --write C:\tmp\look
```

## The schedule

The standing jobs (`retro-due`, `grade`) live in `schedule.json`, whose `$comment` is the
format. The fixed-age reads are **one-shot `at <iso>` jobs emitted per run** by
`remeasure.py --emit-jobs`, not a standing cadence - the age is a property of the run, not of the
clock. The shape it prints, one pair per recorded run:

```json
{
  "id": "read-carry-015-7d",
  "kind": "script",
  "note": "fixed-age read 7d for carry-015 (lab/platform/carry)",
  "cadence": "at 2026-09-28T09:00",
  "cwd": ".",
  "cmd": [".venv/Scripts/python.exe", "app/loop/tools/remeasure.py", "--desk", "lab/platform/carry",
          "--run", "carry-015", "--age", "7d"],
  "window_s": 345600,
  "timeout_s": 3600,
  "health": true
}
```

`window_s` is four days on purpose: past it the occurrence logs `missed`, which is the same
tolerance `remeasure.py` uses before it stamps a read `missed`. The two numbers agree so the
scheduler and the ledger cannot tell different stories about the same read.
