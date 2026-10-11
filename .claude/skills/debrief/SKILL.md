---
name: debrief
description: Close a working conversation by filing what it learned - the closing sweep, for ANY agent. Fire on "wrap it up / that's a wrap / debrief / what did we learn / before we close", when the owner signals a conversation is done, or when the cockpit's Wrap button fires.
---

# debrief - the reading list

The method lives in the books; this skill only routes. Sweep, show the owner the PLAN (lesson ->
book -> chapter -> its Read-when line -> does it bind; nothing files before the owner's go), then land it:

Pull a chapter with `python app\tools\context.py --show <ref>`, not the whole book.

| Read | Why |
|---|---|
| `app/library/law/how-we-work.md#the-closing-sweep` | the ritual - the questions, the landing form, what never moves |
| `app/library/law/how-we-know.md#the-mechanism-ladder` | anything meant to BIND ships with its gate, or says it is unenforced |
| the book the lesson belongs to | the deepest place it is true: a strategy (`app/library/research/<topic>.md`), research method (`research.md`), the code (`app/library/platform/`), the cockpit (`app/library/app/`), the data layer (`database/`), or the fund (`app/library/law/`) |
| `app/agents/<id>.md` (`boot`) | for a moment hot enough to load at every boot: a chapter ref `<book>#<slug>` |

A lesson is a NEW `##` chapter in that book, opening with `Read when:`, in one commit in the repo
that holds it, staged by explicit path; the loop captures an appended chapter itself (no post). Set any board item the work landed to done in the same sitting. An empty
sweep is a fine outcome: say so.
