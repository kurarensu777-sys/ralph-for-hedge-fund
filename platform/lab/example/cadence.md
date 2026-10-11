# cadence.md - how the example desk runs

**State: PRE-LIVE.**

The template (the spine, the gates, the shapes) is app/library/law/the-lab-loop.md; this file holds only this desk's own.

## This desk

A skeleton to copy when you stand up a desk of your own: every file the loop tools read, in the
shape they read it, holding no run, no result and no belief yet. Copy the folder to
`platform/lab/<your-desk>/`, rename it in each heading, replace the M1 row in `mechanics.md` with
your first mechanic, and set the state line to OPENING when the first run is pre-registered.

The desk is written by the agent whose `writes` cover `platform/lab/example/` (commit trailer
`Agent: <id>`). Its commands run from `platform/` unless a run says otherwise.

## The cadence

1. Read the record (`results-log.md`, `beliefs.md`), the now, and the external comparator.
2. Choose the run's kind from `menu.md`: EXPLOIT, EXPLORE or WILD.
3. Pre-register it, which commits the prediction before anything runs:
   `.venv\Scripts\python.exe app\loop\tools\preregister.py --desk example --run ex-001 --mechanic M1 ...`
4. Run the command you registered, through the gates.
5. Record it: `app\loop\tools\record.py --desk example --run ex-001 ...`, then schedule the +7d and
   +30d reads (`remeasure.py --emit-jobs`).
6. Retro when one is owed (`retro_due.py --desk example`): grade the judge, move beliefs, stamp one
   next bet.
