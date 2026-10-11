---
name: run
description: Work a lab desk's cadence end to end - the receipt, the now, the call, the pre-registration, the run, the record. Fire on any ask shaped like "run X / do a pass at X / what should we run next / get a result out of X" that names a desk, a venue, an engine or a dashboard.
---

# run - the reading list

This skill routes. Resolve the desk `lab/<path>` covering the subject (`platform/lab/<path>`):

Pull a chapter with `python app\tools\context.py --show <ref>`, not the whole book.

| Read | Why |
|---|---|
| `platform/lab/<desk>/cadence.md` | what a run here IS - its receipt, the literal command at each step, its gates |
| `platform/lab/<desk>/menu.md` | the weighted menu, the WILD slot, and which rows can run TODAY |
| `platform/lab/<desk>/results-log.md` | what ran, on what window, what read is owed |
| `platform/lab/<desk>/beliefs.md` · `mechanics.md` | the standing conclusions, the next bet, the mechanic the pre-flight must name |
| `app/library/law/the-lab-loop.md#the-loop-in-commands` · `#pre-registration-is-a-commit` · `#fixed-age-reads-and-pins` | the loop in commands, pre-registration, fixed-age reads |
| the strategy book (`app/library/research/<topic>.md`, table of contents first) | what the fund already knows about this trade |
| `app/library/law/how-we-know.md#lottery-and-craft` | at the gate where a result gets read |

Commands (fund root, `.venv/Scripts/python.exe app/loop/tools/...`): `preregister.py --desk
lab/<desk>` BEFORE any engine · `record.py` after (write-once, four gates) · `backfill.py` for
history predating the ledger. Commit your own paths in the repo that holds them, then fetch, merge
`--ff-only`, push. A run that taught something adds a chapter to its strategy book.
