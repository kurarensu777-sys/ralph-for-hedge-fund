# `app/tools/probes` - measurement that cannot die silently

The agency this harness is cloned from lost its measurement script for weeks and nobody noticed,
because a script that is not running produces no output and **no output looks like no problem**.
Everything in this folder exists to make silence loud.

Run everything with the fund's one venv, from the fund root:
`.venv\Scripts\python.exe app\tools\probes\run_all.py`

## The three anti-silence mechanisms

1. **Every probe writes its health row on every path** - `ok`, `fail` or `unknown`. A probe that
   ran and could not decide writes `unknown`, which is a different row from `ok` and reads as
   one.
2. **A watchdog thread owns the timeout.** If the body hangs, the watchdog writes
   `fail - timed out after Ns` and hard-exits. A hung probe leaves a RED row, never yesterday's
   green one.
3. **`_probe.REGISTRY` is the expected set, and `staleness.py` walks IT, not the health
   directory.** A probe whose file was never written renders `unknown - never reported`. Walking
   the directory would make a probe that never ran render as nothing at all - which is exactly
   what "died silently" means. `probe-sweep` is in that expected set too, so *the thing that runs
   the probes stopped running* is itself a red row.

## Exit codes (uniform; the scheduler reads these)

| Code | Meaning |
|---|---|
| `0` | `ok` - the checked property holds |
| `1` | `fail` - the checked property is FALSE. A real finding. |
| `2` | `unknown` - the probe could not run or could not decide (no venv, network down, a timeout inside a child). **Not** the same as fail. |

`run_all.py` returns the worst: `1` if any probe failed, else `2` if any was unknown, else `0`.
`staleness.py` returns `1` if anything is stale, never-reported or red, `2` if the worst is an
unknown or warn row (a nag is never red); its own row and the `scheduler` tally are judged on
silence only, so its red cannot feed itself.

Every probe takes `--dry` (say what would be checked and written, touch nothing, exit 0),
`--json` and `--quiet`.

## The probes

| id | What it runs | What it CLAIMS (and no more) | Network | Owner desk | Window |
|---|---|---|---|---|---|
| `git` | `git status` / `rev-list` in every repo of repos.json | dirty / ahead / behind. Only `behind > 0` is unconditionally red; the dirty/ahead limits are policy knobs set wide (120/20), because a probe that reddens at a normal day's in-flight work gets ignored. `behind` is as of the last fetch SOMEBODY did - this probe never fetches | no | `.` | 6h |

Plus, not on a probe clock:

- **`run_all.py`** - one subprocess per probe, so a hung network call, a crashed import or a
  segfault costs exactly one row. Writes the `probe-sweep` health row.
- **`staleness.py`** - the renderer described above. Never rewrites a probe's file: overwriting
  the reading would destroy the one fact that dates the silence. `--dry` names the expected set
  (the registry plus `probe-sweep`) and reads nothing.

## Adding a probe

1. Add a `Spec` to `REGISTRY` in `_probe.py` (id, label, owner desk, snapshot desk, window,
   timeout, network, note). **`staleness.py` now expects it**, so the row goes red the day it
   stops running - which is the point.
2. Write `<id>.py` with a `body(ctx) -> P.Result` and `P.main("<id>", body)`.
3. Write the claim sentence the probe can actually defend, and no bigger
   (`app/library/law/how-we-know.md#what-would-it-print-if-false`).
4. Add its `schedule.json` entry (only if it needs its own clock - `probe-sweep` runs
   every registered probe daily) and a test in `tests/`.

`tests/test_probes.py` asserts the registry and the files agree in both directions, so a probe
file with no registry entry fails the suite.

## Tests

```
.venv\Scripts\python.exe app\tools\probes\tests\test_probes.py         # the harness, staleness, run_all
```

(from the fund root; `app\tools\check.py --only tools` runs it, found not listed.)

Covers the shape of a health row, `fail` vs `unknown`, a raising body, **the watchdog turning a
hang into a red row** (in a subprocess, because it kills the process on purpose), `--dry`
touching nothing, snapshot rows being dropped when incomplete, and every staleness render -
including the ALL-FRESH one, forced, so the clean surface is not making its debut on the first
day everything works.

## The schedule

The probe jobs live in `schedule.json` (its `$comment` is the format): `probe-sweep` (daily, every
registered probe), `probe-git` and `probe-staleness`.
`"health": false` marks every job whose TOOL records its own reading (`system:<id>` in the ops store), so the
cockpit's scheduler never overwrites a probe's reading with its own; `staleness` writes no row
of its own and takes the scheduler's (`"health": true`).

The floor is machine-local and lives OUTSIDE the repo: `$FUND_FLOOR`, default
`~/fund-data/floor` (`app/tools/_root.py floor_dir`; the cockpit's `FLOOR_DIR` is the same rule). A
health row is a reading of THIS machine. So are snapshot rows, since 2026-09-25: they land in the
owning desk's file in the SNAPSHOT STORE, `~/fund-data/snapshots/<desk>.jsonl` (`$FUND_SNAPSHOTS_DIR`,
else `$FUND_DATA_DIR/snapshots`; `app/loop/tools/snapshots.py`), never in the tree. Until then they were
appended to the tracked `lab/<desk>/data/snapshots.jsonl`, and every sweep left the fund repo dirty.
That history was merged into the store (the store merges any file still found at the old path, or
the old path as git last held it, before it reads or writes a desk), and the old path is
git-ignored. A row is written only for a desk whose `lab/` folder exists and only with every
required field; `python app/loop/tools/snapshots.py show --desk <d>` prints what a desk holds.
