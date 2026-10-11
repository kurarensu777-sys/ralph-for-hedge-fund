---
name: retro
description: Grade a lab desk's own record and move its beliefs - the ONLY clock where number-driven doctrine changes. Fire on "what did we learn / grade the runs / run the retro / is this working" about a desk; due when its beliefs stamp is over 7 days or over 5 runs old.
---

# retro - the reading list

The method lives in the books; this skill only routes. Resolve the desk `lab/<path>` (its folder
is `platform/lab/<path>`), then:

Pull a chapter with `python app\tools\context.py --show <ref>`, not the whole book.

| Read | Why |
|---|---|
| `app/library/law/the-lab-loop.md#the-retro` · `#comparator-cold-at-n-the-wild-floor` | how a learning pass runs, in order, and why no verdict is terminal |
| `platform/lab/<desk>/results-log.md` · `data/runs.jsonl` | the record being graded: pre-flights against what landed |
| `platform/lab/<desk>/beliefs.md` · `mechanics.md` · `menu.md` | what may move, at what tier; shots and statuses; where a lesson weights the next run |
| `app/library/law/how-we-know.md#a-shared-window-is-one-result` | the bar between one window and a new rule |
| `app/library/law/how-we-know.md#lottery-and-craft` | read the decomposition, never the total |

Commands (fund root, `.venv/Scripts/python.exe app/loop/tools/...`): `retro_due.py --desk <d>` ·
`remeasure.py --desk <d> --run <id> --age 7d` for every read that came due, FIRST ·
`grade.py --desk <d>` · `digest.py --desk <d>`. Grade the judge BEFORE any belief moves; an
imported row is never graded. Stamp: `Last retro: <date> · through run NN · next bet: <one line>`.
What travels up becomes a Lesson chapter in the desk's strategy book (`app/library/research/`).
