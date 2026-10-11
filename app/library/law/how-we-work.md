---
topics: [workflow, layout, rules]
type: guide
---

# How we work

How agents work this tree together: who writes where, the board, sync and conflicts, two hands in one checkout, build branches, the doors and their keys, how the library is filed, the closing sweep, the standing order, workflow agents and long jobs. Kept by the `fund` agent. A new learning is a new `##` chapter here, opening with its Read-when line.

## Who writes where

Read when: about to write outside your own folder, add an agent, move a file between folders, or asked who owns a path.

The roster `app/agents/<id>.md` is the arbiter: a YAML header (`id`, `cwd`, `writes`, `boot`) over a brief. `writes` is the whole scope, fund-relative path prefixes, no visiting-hand exception. The commit guard (`app/scripts/hooks`) enforces it from `FUND_AGENT`. Its gap: with `FUND_AGENT` unset (the owner by hand) only the secret check runs, and a clone where fundd never started has no hooks.

- `fund` keeps the law (root, roster, skills, board, library, loop tools); the others propose it. Arming, an order and a live-trading flag are the owner's alone: the deny rows hold them.
- Operate at your altitude: write your own state, never redesign the harness (skills, roster, cockpit) unprompted. The owner directing a change IS the altitude.
- A lab desk (`platform/lab/<desk>/`, id `lab/<desk>`) holds the LEDGER; the agent whose `writes` cover it makes the EDIT. A LEAD desk arbitrates files two sub-desks share; a sub-desk files a board item at its lead.

Six types of context: system (Claude Code's prompt, deny list, MCP servers, hooks), base prompt (root `CLAUDE.md`), agent prompt (body of `app/agents/<id>.md`: two lines and a boot list of chapters), workspace (a `CLAUDE.md` per top folder and dashboard, loaded by cwd), books (files of chapters), records (ledgers, board, memos, annals: read on demand, never context). Caps are tokens (chars / 4) in `app/tools/context-caps.json` alone; `app/tools/context.py` measures them (`--table`: each agent's boot by type).

## The board: NOW or BACKLOG

Read when: about to open, update or close a board item, file work for another agent, or choose between `--now` and backlog.

Work that outlives the session is an `app/board/B-NNNN.md`, set done in the commit that lands the work. An ask outside your `writes` is an item owned by the agent whose `writes` cover it.

NOW (`node app/scripts/board.mjs add "..." --owner <agent> --now`) is ready with label `auto`: the board starts that agent, no owner click. Right when it should start now and nothing waits on the owner. BACKLOG (no `--now`) waits until someone moves it on: the "we should".

Any agent may ask another agent to start work. For an item not yet filed that is `add --now`. For one that already exists it is `node app/scripts/board.mjs pickup B-NNNN [--note "why now"]` (or `POST /api/board/:id/pickup`): it makes the item ready and auto, records the asker as `asked_by` and ticks. Refused with no `FUND_AGENT`, for the asker's own item, with no agent owner, or when the item is doing, done or needs-you; a blocked item waits and says why. Enforced by `app/test/board-pickup.test.ts`; the chapter is `app/library/app/cockpit-server.md#filing-work-for-another-agent`.

The agent chooses, and does not ask first. Not urgent: file backlog. In a conversation with the owner where something must be BUILT by another agent: file it `--now` (or `pickup` an item that exists) and trigger it at once, then say so in the reply. The owner's cost switches (`board.perDay`, `board.max` in `app/board/config.json`) are not a reason to wait; if a cap holds the item, say which, and the owner raises it. Mechanism: `add --now` and `pickup` start the item, and an `asked_by` item skips `perDay` and `max` and sorts first (`app/test/board-pickup.test.ts`). UNENFORCED: nothing checks that an agent chose now over backlog, and the exemption has no ceiling, so a looping agent is bounded only by floor/`STOP`.

Held either way: an item for yourself, a `from` not on the roster, a `blocked_by` an open item, a question (`--now` beside `--options`; the owner answers). An unasked chain is bounded by `board.max` and `board.perDay` (`app/board/config.json`), the spend cap and floor/`STOP`; an asked one by the spend cap and floor/`STOP` only; `holdReason` (`app/server/board/auto.ts`) says why.

## Sync and the conflict ladder

Read when: about to push, settle a rebase conflict or move files between repos, or a push or pull was refused.

Commit before you pull: the rebase then only replays a commit, and `git rebase --abort` is a clean escape. Move files between repos with history: `git format-patch --root -- <paths> | git am --directory=<dest>` in the receiving repo; if it cannot apply, copy and name the source commit.

Do not count on GitHub branch protection (a free private repo has none). Two local rails hold main: the deny list (SUBSTRING denies: `git -C <dir> push --force` and `push origin +main` are caught) and `app/scripts/hooks/pre-push`, which refuses any push that is not a fast-forward of `refs/heads/main`, or that deletes it.

The file's TYPE decides a conflict, never a side. Settle it yourself unless it is a true contradiction.

| File type | Resolution |
|---|---|
| append-only ledgers (`data/*.jsonl`, `results-log.md`, `research-log.md`) | keep BOTH hunks in timestamp order (`merge=union` does jsonl) |
| truth files (`CLAUDE.md`, books, `cadence.md`) | one version carrying both facts; a true contradiction STOPS, to the owner |
| config (`repos.json`, `app/schedule.json`, `dashboard.json`, `retention.toml`), roster headers | additive: both entries, the file stays valid |
| migrations (`database/migrations/<track>/NNN_*.sql`) | never edit an applied one; two hands on one number: renumber the LATER first |
| `beliefs.md` | never merge two stamps: the LATER wins, the earlier retro's moves re-applied under it, or to the owner |
| rendered or captured artifacts, archived bars | NEVER auto-resolve; keep both, ask |

## Two hands in one checkout

Read when: about to commit a file another hand also has dirty, to pull in a checkout others share, or you found your hunks inside someone else's commit.

Conversations on main in one repo share one working tree and index: a path carries whoever's edits are in it.

1. Before committing a file, check it holds no other hand's hunks (`git diff`, `git diff --cached`); commit only yours, or let the other land first. Private index: `export GIT_INDEX_FILE="$(mktemp -u)"; git read-tree HEAD`, `git add -- <paths>` (a file with foreign hunks: `git update-index --cacheinfo 100644,<blob>,<path>`, a `git hash-object -w` blob of HEAD plus your hunks), `git commit`, `unset GIT_INDEX_FILE`, `git reset -q -- <paths>`. `git commit -- <path>` takes the WORKING copy, theirs included.
2. A stash takes EVERY hand's tracked edits. When `git merge --ff-only` is refused, use a build branch.
3. Found your hunks inside another's commit: commit the rest, name the sweeping commit in your message, never take them back.

Measured: a pull that auto-stashed reset four hands' files to HEAD for three minutes. UNENFORCED: nothing refuses a commit carrying another's hunks; build branches are opt-in.

## Build branches and the land queue

Read when: about to work in a build worktree, ask for or land a branch, or main's checkout is dirty with another hand's edits.

An agent never cuts, switches, rebases, lands or pushes a branch. The Git room cuts `b/<agent>/<slug>` as a worktree and the land queue lands it; the agent commits there only. Steps, red vs blocked: `app/library/app/cockpit-server.md#the-land-queue`.

While another hand's edits sit uncommitted on main, `git pull --rebase` is refused. Never stash, commit or discard them to get past it: have a build branch cut from main's HEAD, or leave your commit local and say so.

## The doors and their keys

Read when: about to use or add a tool that reaches outside the tree (a venue, a key, a service), or asked what an agent may hold.

An unregistered door is a defect: add the row (UNENFORCED: no check finds a missing one). HUMAN means only the owner holds the key. The System room's Doors tile reads this table.

| Door | Credential, and who holds it | Reached through - health |
|---|---|---|
| A venue's public REST and websocket | none, anonymous | the venue's adapter in the data layer only, never a raw request from a notebook or a screen - the adapter's own selftest |
| A venue's or vendor's docs site | none; a keyed-looking URL is refused before a request | one fetcher that honours robots - its status command |
| A data vendor (daily bars, rates) | a READ-ONLY key in the fund-root env file, never logged | the vendor's adapter only |
| A logged-in data session | the owner's session cookie, one file outside every repo, read only by its adapter; DATA, no broker connected | its adapter, data routes only (`app/library/law/how-we-guard.md#a-session-cookie-data-door`) |
| A broker's local gateway (read-only DATA) | HUMAN: the owner's login and 2FA, typed into the gateway only; the Read-Only flag is UNENFORCED | its adapter over a loopback socket, no secret (`app/library/law/how-we-guard.md#a-broker-gateway-read-only-data-door`) |
| Ops store (PostgreSQL on `127.0.0.1`), the lake (Parquet, DuckDB) and the cache root | none; `trust` for `127.0.0.1/32`, no password anywhere (a DSN with one is refused); files outside the repo | `fund_db` / `@fund/db` only (`database/CLAUDE.md`), held by `app/tools/datalaw.py` - `.venv\Scripts\python.exe -m fund_db doctor` |
| Model providers | Claude Code's own login; any other provider's key in the fund-root env file, handed to that provider's spawn alone | `app/server/chat/launch.ts` (`app/library/app/cockpit-server.md#engines-one-hand-per-provider`) |
| GitHub | the machine's git credential helper, no token in a tree | git from inside the repo - `git ls-remote origin main` |
| Venue trading or withdrawal keys | HUMAN, and NONE is provisioned: no signing key, API secret, withdrawal whitelist or custody material | nothing. The absence is a decision, not an oversight |

The fund-root env file is the one home of every environment variable the fund needs: `<fund root>/.env`, one `NAME=value` per line, never in a subfolder. It holds read-only data and provider keys only; a trading, withdrawal or signing credential never goes in it. What binds: `.gitignore` ignores it, the commit guard refuses an env file by name, and the root settings deny an agent's Read of it. A server reads the one name it needs and never loads the file into a child's environment. What does not: nothing scans the file for a trading-shaped name, so that half is unenforced. Built reader: the cockpit's provider keys (`app/server/chat/engines/keys.ts`).

## The library: books and chapters

Read when: about to file a lesson, add or split a book, write a chapter, cite one in a boot list or a Recall row, or add a shelf.

A book is ONE file of chapters; a chapter is one topic under a `##` heading whose next line is `Read when: <the moment>`, held to the chapter caps in `app/tools/context-caps.json` (a target and a hard cap, in tokens). Read-when is the MOMENT it fires, never a description: a book read after the decision it should have shaped did not exist. The shelves are the top folders of `app/library/` (`law`, `research`, `platform`, `app`, `academic`, and a closing `dashboards/`).

- A book declares `type:` (`guide`, `strategy` with `parent:`) and `topics: [a, b]`, 1 to 3 from its shelf's `_series.md` list; the commit guard refuses a staged book with none, an off-list one or more than three.
- Address a chapter `path#slug` (the title lower-cased, each run of non-alphanumerics one `-`). Pull one: `.venv\Scripts\python.exe app\tools\context.py --show <path#slug>` (a bare path prints the table of contents). Check a ref before writing it anywhere: `context.py --ref <path#slug>` exits 1 on a dead one. Measured on 157 pulls: a whole book cost 6,499 tokens, one chapter 562.
- Records never live in the library; a dated story is cut to one line of evidence.
- A skill (`.claude/skills/`) is a fire condition plus a chapter list, at most 25 lines, zero doctrine; one growing past it is hiding a chapter. Misfiled beats unfiled.

## The closing sweep

Read when: the owner ends a conversation ("wrap it", "debrief", "what did we learn"), a session is closing with unfiled lessons, or an era of the fund turned.

The sweep is the net under base prompt Always 9: if the lessons are already filed, it is three lines and a stand-down. A lesson is landed only when it FIRES somewhere (a gate, a Read-when line a pull will match, a checklist step, a boot list). Answer all five, in order, before proposing anything.

1. What did we learn that is TRUE beyond this session? Not what we did (`git log` holds that): a finding, a failure mode, a sourced number.
2. At what desk is it true? The deepest; with two candidates, file at the deeper and leave a Read-when line at the shallower.
3. What MOMENT will someone be in when they need it? "About to fetch more history than the venue still serves" is a moment; "explains the retention cap" is a topic, read after the decision it should have shaped.
4. Does it BIND, by what mechanism (gate, script, schema field, deny row, numbered step)? If you cannot build it now, the chapter says it is unenforced (`app/library/law/how-we-know.md#the-mechanism-ladder`).
5. What is still OPEN? Anything outliving the session is a board item now.

Landing: show the owner the PLAN first (lesson, chapter, Read-when line, whether it binds) and file nothing before the owner's go. Then one commit: the new chapter, a Recall or boot-list entry only when no one should need a skill to find it, and the board items it closed. An era turned: set `to` on the open annals book (`app/library/law/the-annals/`) in that commit and open the next.

The loop captures every chapter a commit appends (`app/test/loop-chapters.test.ts`): a lesson filed as a chapter needs no post. Gaps: the loop's draft scan still proposes new files, not chapters, and a reworded heading counts as a rename.

A debrief never moves a belief (propose it, naming the run; the desk's retro moves it), the law (write the proposal; the `fund` agent edits with the owner's word) or a number in a record (a correction is a NEW row). Nothing learned: say so and stand down.

## A multi-step turn keeps a todo list

Read when: about to start a turn that will take more than about three steps, or a chat tab sweeps and says "N steps" instead of filling.

Keep the list with TodoWrite: write it before the first step, keep one item in progress, tick each as it lands, and rewrite it when the plan changes. The cockpit fills a tab only from the agent's own newest list (`app/server/chat/progress.ts`); with none it sweeps and counts steps, because a percentage made up from elapsed time is a zero nobody measured. A one-step answer needs no list.

Checked, not enforced: each loop pass counts, per agent, the finished turns of the last 7 days with four or more top-level tool steps and no list (`app/server/loop/todos.ts`), and its summary names the agents with three or more. Nothing blocks a turn and nothing nags per turn.

## One standing-order round

Read when: a round of the standing order is starting, or about to pick the next round's items unasked.

UNENFORCED: nothing schedules or loads this order; it binds only when read. The owner's order: keep improving the fund and its cockpit, unasked, until the owner says stop or `~/fund-data/floor/STOP` exists (`$FUND_FLOOR/STOP` if set).

Pick in order: broken things, ready board items, approved specs not built, gaps against the mission (crypto, tradfi, prediction markets; execution last, owner-armed only), then short visual UI polish. Done means `.venv\Scripts\python.exe app\tools\check.py` green, then land by the sync law and report in 5 lines (shipped, failed, needs the owner).

## Never message a running workflow agent by its id

Read when: a workflow agent asks you to relay a message to a sibling, or you are about to send a message to an agent's id while its workflow still runs.

A message sent to a running workflow agent's id does not reach that agent. The tool answers "Resuming agent <id>" and starts a SECOND background copy that runs the same brief beside the workflow's own copy. Both write the same files, and two writers on one tree overwrite each other and look like a mystery third hand. An agent that messages its own id does the same.

- Answer a relay request in the chat, put the split into the workflow script (edit it, then resume), or start a fresh agent with a different, disjoint scope.
- Tell workflow agents in their prompt never to message a sibling or themselves.
- A twin already started is ended by stopping its task id; that leaves the workflow's own copy running.

Measured once: a data-layer workflow's twin wrote the same two packages as the original, in the same minutes. Unenforced: nothing refuses the message.

## A job longer than ten minutes runs detached

Read when: about to run a build, a grid, a backtest or a notebook execution from an agent's shell that may take more than about ten minutes, or a long command died with no error of its own.

A foreground shell command is cut at the tool's cap (600 s), and a job killed there leaves only a half-written output. Detach anything that may run past ten minutes from the session:

- On Windows: `Start-Process <python.exe> -ArgumentList ... -RedirectStandardOutput <log> -RedirectStandardError <err> -WindowStyle Hidden -PassThru` from the folder the job expects, keep the pid, and watch the log with a monitor until a done line appears or the process ends; re-arm the monitor if it has a cap of its own.
- Time a small slice first (a smoke build) to know which side of the cap the full run falls.
- Before a long run starts, check that every input it will read is present (each day, each fill, each cache row it needs). A run that finds one missing at minute 53 has spent the hour.

Measured: a grid build of about 3,000 cells took 55 minutes in one notebook cell; run in the foreground it was killed at the cap, detached it finished. Unenforced: nothing detaches a job for you.
