---
name: board
description: Turn a request into a board item owned by the agent whose writes cover it. Fire when an ask lands outside your own write scope, when you are asked "who owns this / where does this go", or when something needs doing that will outlive this session.
---

# board - the reading list

The routing lives in the roster; this skill only points. Resolve the OWNING agent, file the item,
say so in your report, then carry on with what is yours:

Pull a chapter with `python app\tools\context.py --show <ref>`, not the whole book.

| Read | Why |
|---|---|
| `app/agents/<id>.md` | each agent's `writes` - the only authority on who may write a given path |
| `repos.json` | which folder the work lands in, and what verifies it |
| `app/library/law/how-we-work.md#who-writes-where` | why this is a hand-off rather than a favour |
| `app/library/law/how-we-work.md#the-board-now-or-backlog` | which kind to file, and what holds an item |
| `app/board/` | what is already filed, so you add to an item rather than duplicate it |

File it with `node app/scripts/board.mjs add "..." --owner <id>` (or the Board room). Add `--now`
when that agent should act NOW and nothing waits on the owner (it starts with no click); plain
`add` is backlog; `--blocked-by B-NNNN` holds it until another item is done. The body carries the
THINKING that produced it, not just the ask. If the ask is inside your `writes`, this skill does
not fire: do the work.

The choice is yours, not the owner's to be asked: non-urgent is backlog; in a conversation with the
owner where something must be built, file `--now` and say so. Any agent may ask another to start. For a new item that is `--now`; for an item already filed it is
`node app/scripts/board.mjs pickup B-NNNN [--note "why now"]` (refused for your own item).
