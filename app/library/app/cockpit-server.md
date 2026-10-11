---
topics: [server, agents]
type: guide
---

# Cockpit server

How fundd, the cockpit's daemon, finds its state and its configuration, restarts, boots an agent, lands a build branch, and takes a question for the owner or work for another agent; and what to check when something does not start. The `app` agent keeps it. The rooms' own screens are in `app/library/app/cockpit-ui.md`. A new learning is a new `##` chapter here, opening with its Read-when line.

## State homes

Read when: about to store something the cockpit must remember, add a heat-strip reading, or asked where a reading lives.

State that survives lives in the ops store (PostgreSQL, schema `ops`) through `@fund/db` only: `ops.health_readings` (each probe's own reading, probe_id `system:<id>`; the heat strips read it) and `ops.job_runs` (the scheduler). Files: `~/fund-data/floor/` holds the `STOP` switch and the platform jobs' probe rows in `floor/health/<id>.json`; `~/fund-data/` holds `fundd-live-<port>.json` (conversations to reopen) and `fundd-boot-<port>.json` (the crash-loop guard); `worktrees/` holds build worktrees and `land.json`. A pin's hash IS the input's digest: the Lab (`server/lab/pins.ts`) calls an input pinned when its row carries `pin` or the index holds its sha256.

## Config homes and the one reader

Read when: about to read, move or add a file the cockpit reads (a setting, a registry, a shelf home), or asked where a reading or a book comes from.

Configuration and knowledge are files beside what they describe, and `server/config.ts` is the ONE reader. Paths come from `server/paths.ts` under `FUND_ROOT`. The homes: the roster `app/agents/<id>.md`, `app/board/`, `schedule.json`, `loop/config.json`, `board/config.json`, `controls.json`, `reaper.json`; at the fund root `repos.json` and, once a dashboard exists, its `platform/dashboards/<id>/dashboard.json`.

- **The doors table is a chapter of the law, read by file name:** `## The doors and their keys` in `app/library/law/how-we-work.md`, parsed by `server/system/credentials.ts`. Renaming that heading or the file blanks the System room's doors.
- **Shelves are derived from folders, never configured:** each top folder of `app/library/` is a shelf. A chapter's address is `<book path>#<slug>`: the title lower-cased, every run of non-alphanumerics a `-`.

## Stopping and restarting

Read when: about to stop or restart the cockpit by hand (`prod.mjs --stop`, `start.cmd --stop`, a taskkill), to tell the owner a server change is live, or to change `server/restart.ts`.

**To take your server commit live, do nothing.** fundd restarts itself (`server/restart.ts`) at the first idle moment after the commit lands: no turn, parked decision, background command, subagent or terminal command running. Three limits: only under `scripts/prod.mjs`'s supervisor (`FUND_SUPERVISED=1`); at most once per 30 min after fundd's start (`RESTART_BATCH_MS`); open conversations reopen in the next fundd. Sooner: the owner clicks the amber code chip (skips the batch, never the idle check). A fundd started outside the supervisor shows "no supervisor here" in the chip's tooltip; one manual restart through `start.bat` fixes it.

**Stopping by hand asks, never kills.** `prod.mjs --stop` and `start.cmd --stop` ASK fundd to leave (`POST /api/system/leave`): refused, exit 1, while any turn, decision, background command or terminal command runs. `--stop --force` cuts them, saved first. The fund root's `stop.bat` asks, then kills whatever still listens: the owner's stop. Pinned by `test/restart.test.ts`.

**A cut turn is continued once.** Whatever ends fundd, its open conversations are in `fundd-live-<port>.json`; a start within 10 minutes (`LIVE_MAX_AGE_MS`) reopens the cut, waiting and background-losing ones (a plain idle chat stays closed until its next message) and sends each cut turn ONE `[cockpit]` message, not the owner's words. Never on a crash loop, for a chat parked on the owner, twice, or under floor/STOP.

Measured: a session outside the cockpit ran `prod.mjs --stop` with three platform turns running; the old `--stop` was a taskkill, the turns ended mid-tool and the next fundd logged "0 conversation(s) saved to reopen". Every exit that did not go through the idle restart was the hole.

## Idle hands and the reaper

Read when: about to change how long an agent process stays open, add a second way to close one, or the machine runs short of RAM with the cockpit up.

Every open conversation is one claude.exe (about 390 MB with its MCP children). `server/chat/reaper.ts` closes a hand only when nothing of it runs: no turn, no decision parked on the owner, no spawn in flight, no background command, watcher or wake-up (those die with the process). Three reasons: idle past `idleMinutes` (2 h), free RAM under `pressureFreeGb` (oldest first, idle 10 min or more, a batch a sweep), more than `maxIdleHands` idle hands (least recently active first). Every reason waits out a settle grace: a hand active within `settleMinutes` (5) is never taken, `cap` and `pressure` included (pressure also needs 10 min idle, cap ignores age past the grace). `lastActive` moves on every message from the process except `keep_alive` and `rate_limit_event`, and `reapIdle` re-checks the grace at the close. All limits live in `app/reaper.json`, read each 60 s sweep. A closed conversation keeps its transcript; the next message resumes it. An unreadable RAM figure closes nothing. `runner.reapIdle` re-checks every guard at the moment of the close.

fundd's start also closes an ORPHAN: the SDK's claude.exe of this app (`--input-format stream-json`) whose parent process is gone. The owner's terminal sessions run the globally installed claude and are only counted. The System room's hands line reads the same process list (open, GB held, reaped today). Pinned by `test/chats-reaper.test.ts`.

What a hand holds, and what the reaper does:

| Case | Safe? |
|---|---|
| Foreground subagent, turn open | yes: `busy` |
| Background subagent or command between turns | yes: `tasks` is non-empty |
| Background work ends, the process is about to start the notification turn | yes: the end bumps `lastActive`, and the grace covers the model-latency gap before `busy` flips. Before that fix, `lastActive` was the last turn's end and the next sweep closed it ("Closed after 3.4 h idle") before the agent heard the result |
| Owner presses Stop while a subagent runs | yes: Stop spares tasks; after they end, as above |
| Watcher or `skip_transcript` task (`ambient`) | yes: counted in `later`, blocks the reap |
| Recurring cron | never closed, only counted by the cap |
| Wake-up or cron fires in the process | yes: the grace covers the gap before `busy`; a one-shot in `later` holds the hand only until it fires |
| Parked AskUserQuestion or plan | yes: `waiting` |
| Agent asked in plain text and ended its turn | no, by design: closed after 2 h or under pressure; the conversation is intact and the next message reopens it |
| fundd restart | `bg` is per process and restarts empty |
| Subagent `paused` status | not read; assume live until the level message drops it |

The chat's composer bar reads "waiting on N background tasks" from `meta.bg` (labels in the title), so a hand with tasks never reads as idle.

Measured: 48 hands held about 19 GB of 31 GB, 46 of them idle; nothing ever closed one. Open: a user-level MCP server (an agent-driven browser's, about 75 MB each) loads into every hand through settingSources user; an opt-in per agent would drop it.

## Stop spares background work

Read when: about to change what Stop does to a running turn, change the options `server/chat/launch.ts` boots with, or a background command or subagent is "stopped by the user" and nobody pressed anything for it.

The CLI kills every background command and subagent of a process on an interrupt, unless the consumer declares `perTaskStopAffordance`. `launch.ts` declares it, so Stop (`runner.stop`, `h.q.interrupt()`) aborts the turn only; `POST /api/chats/<id>/tasks/<task>/stop` stops one task (`runner.stopTask`); a hard stop still ends the process and all of it. A task the owner never stopped that reads "stopped by the user" has met an interrupt: check the transcript for `[Request interrupted by user]` before blaming a restart or the reaper.

The UI has no per-task button yet: the Stop button spares tasks, and only the hard stop or the route ends one.

Measured: a research chat started a background subagent at 12:24Z, the owner pressed Stop at 12:27:19Z on a message they were rewriting, and at 15:30Z the agent was "stopped by the user" with no report. It was filed as a restart that ignored the hold; the events table has no restart between 11:19Z and 15:30Z. Reproduced against the real CLI 0.3.288: an interrupt empties `background_tasks_changed` and stops the task; with the option the task runs on. A `local_agent` does appear in that level message, so the restart hold and the reaper guard were sound. Pinned by `test/restart-chats.test.ts` (the option is declared; a held subagent survives Stop); the CLI's side is checked by hand only.

## The launch contract

Read when: about to boot an agent from anywhere in the cockpit, add a second spawn path, or change what an agent sees at boot (cwd, settings, boot books, env, MCP servers).

If two code paths can boot an agent they drift, and the one nobody tested boots without its rules. Every agent the cockpit boots (a chat, a scheduled job, a dashboard wake-up, a board assignment) goes through ONE function, `server/chat/launch.ts`; its header and `app/CLAUDE.md` "The launch contract" list the clauses. A new way to start an agent calls it and never copies its options; a boot-list change takes effect at the NEXT boot.

**Why settings and MCP are passed explicitly:** Claude Code reads a project `.mcp.json` and settings from the cwd only, every agent's cwd is a sub-repo, and a relative `../.venv/Scripts/python.exe` means a different file from every cwd. So `mcpServers()` merges the fund root's `.mcp.json` with `app/.mcp.json` and makes each relative `command` absolute.

Measured: seats booted at their desk folders for months while the allow/deny list sat at the root, so the list bound exactly one seat (`app/library/law/how-we-know.md#the-law-must-be-loaded`). The old spawner said `settingSources: ['project']`, which reads like the fix and is not.

## The land queue

Read when: about to cut a build branch, land one, or read why a land went red or blocked.

The rules are the law's: `app/library/law/how-we-work.md#build-branches-and-the-land-queue` and `app/library/law/how-we-work.md#two-hands-in-one-checkout`. The cockpit's side: Git > Branches > New branch cuts `b/<agent>/<slug>` in a worktree under `~/fund-data/worktrees/`. Only app and platform build (`BUILD_REPOS`); `execution` never lands from the cockpit. The queue (`server/git/land.ts`, one branch at a time; an item running when fundd stopped is re-queued, never guessed landed) runs the repo's `verify` (`repos.json`; 10 minutes by default) between the rebase and the fast-forward. A failed push after the local land still reports `landed`.

- **Red** is the branch's fault: a conflict, a red verify, uncommitted files, nothing to land. It goes back to the conversation with the failure.
- **Blocked** is main's own state: main on another branch, a stopped rebase, a diverged main, a failed fetch, local edits in the branch's files, main that kept moving. It waits for the owner.
- Never a merge commit, a force, a reset or a skip. Tests: `test/git-land.test.ts`.

## Owner options

Read when: about to file a question for the owner, move an item to needs-you, or read, write or render an item's `options:` / `chosen:`.

A question filed for the owner is only half filed until its answers are on it: a prose question makes the owner read, compose and type; an item that carries its answers takes one click. A needs-you item carries an `options:` list in its frontmatter (fields and `--options` syntax: the header of `app/scripts/board.mjs`).

- A `hand: true` option is one the owner must do by hand (an agent is refused it): its label IS the exact command, runnable from the fund root as written.
- **What a click does.** The pick is the owner's word: `POST /api/board/:id/choose` admits the cockpit alone and `board.mjs choose` refuses any `FUND_AGENT`. A closing option moves the item to done; a hand option keeps it needs-you with a `- [ ] <command>` line until the owner ticks Done; any other goes ready for its runner, labelled `auto`, so board auto-pickup starts it after a 10 s undo window (`UNDO_MS`). An item with no options shows Approve / Decline / Comment.
- A question never goes `--now` (`app/library/law/how-we-work.md#the-board-now-or-backlog`).

Mechanism: `board.mjs add` and `POST /api/board` refuse a NEW needs-you item from an agent without options (`test/board-choices.test.ts`). Moving an existing item to needs-you is not refused (a blocker note is fine there); the owner then sees Approve / Decline, the prose question's cost paid by the owner.

## No signal is not a verdict

Read when: about to add a "too few samples to judge" guard to any check, watch or gate - or a thin watch closed as kept without anyone deciding.

The miss: the loop's watch refused to judge a window thinner than `minEvents` scored events. Right call, wrong exit: a due watch that read no-signal fell through the same branch as "same" and "better" and closed as `kept`. Build takes about three turns a week, so every change there would be kept without anyone deciding.

"Could not tell" gets its own path and ends where a person can see it (`evaluate` in `server/loop/engine.ts`; settings in `loop/config.json`): extend the watch, then close `kept` with verdict `no-signal`, say `unjudged` in the log and `watch.jsonl`, and show it amber in the Loop room.

The general form: any gate with a "too thin to judge" guard needs a third exit - extend, escalate, or mark. A guard that only suppresses the verdict turns every thin case into the default one, and the default is usually "pass".

Measured on a scratch clone: a change that took Build reliability from 1.0 to 0.5 was extended at +8 days, judged worse at +15 days and auto-reverted (`test/loop-engine.test.ts`).

## A ready item that does not start

Read when: a board item sits `ready` with the `auto` label for more than a few minutes, or sits `doing` and you cannot name the conversation working on it.

`POST /api/board/auto/tick` answers with the reason in `held`: `"10 pickups today"` is the day cap (`board.perDay` in `app/board/config.json`, default `MAX_AUTO_PER_DAY` = 10, ceiling 40; the owner changes it in the System room or the file, no code change), `"floor/STOP"` is the switch, `"2 running"` is `MAX_AUTO`. Both caps bind unasked items only: an item with `asked_by` (an agent's pickup request) starts past both, sorts ahead of unasked items, and is held only by floor/STOP, Manual, `blocked_by`, the owner's mode or the spend cap (before that rule, an asked item sat `ready` until the owner raised both caps by hand). The tick also answers `askedHeld: {id: reason}` for an asked item that did not start, and `pickup` prints it. Measured: two items filed `--now` sat `ready` for 11 minutes at the 10-a-day cap. A hand start is not counted against it: `POST /api/chats` with the item's text.

A `doing` item with no live conversation is a dead hand: a session end closes the conversations it started and nothing resets their items (six items once read `doing` for five days). The auto path checks its own running items; a hand start is not checked. The Board room now draws it: a `doing` item an agent owns, untouched for 10 minutes, whose conversation (or, for a hand start with none named, any conversation of its owner, until it has sat untouched for 3 hours) is not live or waiting, shows amber "no conversation" on the card and a line in the drawer, never the working pulse; a chat list that has not answered draws nothing. The head shows `N/cap today` with the tick's held reason (`pickupReading`, `noLiveConversation` in `src/rooms/board/state.ts`). Enforced: `test/board-day.test.ts`.

## Filing work for another agent

Read when: about to hand work to an agent whose `writes` you do not hold, or a board item you filed sits uncommitted in the working tree.

Any agent files with `node app/scripts/board.mjs add "<title>" --owner <agent> --now --body "..."`. `--now` makes it ready and `auto`, and the command asks fundd for a tick at once, so the other agent starts in that moment and not at the next 10 s timer (it prints `picked up` or why it waits: Manual, STOP, a cap). The ask is best effort: fundd down only means the item waits for the next tick, because the file on disk is the claim. Without `--now` the item is backlog and starts nothing.

Filing needs no scope: the commit guard lets `app/board/B-NNNN.md` through for every agent (`isBoardItem` in `scripts/hooks/guard-lib.mjs`). Before that exemption only `fund` and `app` held `app/board/` in `writes`, so every other agent's item was written but its commit refused, and 112 item files sat uncommitted. Nothing else under `app/board/` is opened: `config.json` (the owner's switches), `done/` and the roster keep their scope. `test/git-guard.test.ts` goes red with the exemption removed; `test/board-now-kick.test.ts` holds the start.

An item that already exists (the owner's backlog item, one a third agent filed) is started with `node app/scripts/board.mjs pickup B-NNNN [--note "why now"]`, or `POST /api/board/<id>/pickup` with `{"by": "<agent>", "note": "..."}`: ready, `auto`, `asked_by: <you>`, a note by you, then the same tick, so never file a duplicate. `holdReason` reads `asked_by` where it reads `from`; it is refused with no `FUND_AGENT` (the owner uses the Board room), for an item you own, for an item with no agent owner, and for one already doing, done or in needs-you. An open `blocked_by` is not refused: the item waits and the answer says why. The owner's chosen-option items keep their attested path. The day cap and `MAX_AUTO` do not hold an asked item (see the held reasons above). Unbounded by design: nothing caps how many pickups one agent may ask in a day. Enforced: `test/board-pickup.test.ts` (an asked item starts with the day cap full; red with the exemption removed).

Still held: an agent never starts itself (`--now` for your own id is refused), `blocked_by` holds an item, and `MAX_AUTO`, `MAX_AUTO_PER_DAY` and the spend cap bound a chain. A chapter above says what to read when an item still does not start.

## The floor switch is a file, not a day

Read when: about to set the floor `STOP` switch (`POST /api/system/halt`, or the STOP chip in the System room), or a scheduled job did not run and nobody knows why.

`<floor>/STOP` is a file with no date: it stays in force until someone clears it (one stayed set for four days). While it exists nothing starts (`server/sched/index.ts` lists what). The chip's route also kills every running job; `/api/system/halt` only writes the file. Neither stops a conversation already running: `POST /api/chats/<id>/stop`.

Before you set it, tell the owner when you will clear it, and clear it then (`POST /api/system/halt` with `{"on": false}`). To see it: `ls ~/fund-data/floor`. An open-ended stop still holds for ever and the chip stays manual. Say when you will clear it, or give it an end: `POST /api/system/halt` with `{"on": true, "until": "<ISO instant with its zone>"}` (the Pause switch has a "for N h" choice). The file then holds a second line `until <instant>`; every reader asks `stopHolds` (`server/system/stop.ts`, `floorStopped` in `server/system/floor.ts`, the scheduler's `stopped()`), which deletes an expired file itself and logs it, within 10 s on the board's tick and 60 s on the scheduler's. A file whose end time cannot be read holds. Enforced: `test/system-stop.test.ts` (an expired STOP no longer holds; no end time still holds).

## Caps and budgets: one file, and a re-read that is not a boot

Read when: about to show, compare or enforce a token cap or budget (the Agents meter, the loop's boot-compress rule, an over-size mark), or to touch `server/chat/reread.ts`.

`app/tools/context-caps.json` is the one source of every cap. `server/library/caps.ts` reads it for the cockpit (pure, with no database import, so the loop's rules can use it); `app/tools/context.py` reads the same file for the check. Never copy a number out of it. A file that cannot be read goes on the wire as `null` (`LibBooks.caps`, `LibAgent.budget` and `layers`), and the UI draws no meter and no mark: there is no default cap.

Three numbers look alike and are not:

- **The boot cap** (375,000): what one agent's boot list may load. The owner sized it on 2026-10-07 at 40% of the 1M context circle: base + agent + boot + the longest workspace chain sum to 400,000 (`window` and `share` in the caps file; `test/library-caps.test.ts`). The Agents meter and the loop's boot-compress rule read it. Beside it the meter shows the other layers (base, workspace, the agent's own prompt) and "all in", counted as `python app/tools/context.py --table` counts them (`server/library/layers.ts`).
- **The re-read budget** (12,000 standing, 8,000 dashboard): how much of the books an agent pulled comes back after a compaction (`REREAD_*` in `server/chat/reread.ts`). It once shared constants with the boot budget, so lowering the boot cap would have silently halved what compaction restores. `test/chats-reread.test.ts` pins 12k and 8k.
- **The book and chapter caps** (40,000 and 4,500, target 3,750): the Library marks a chapter over target and a book over 90% of its cap.

The System room's Doors tile finds `## The doors and their keys` by heading across the `law` shelf (`doorsFromLaw`), not by one file name: a book split at its cap moves chapters, and the tile went blank once when the chapter left `how-we-work.md`. Enforced: `test/library-caps.test.ts`, `test/system-credentials.test.ts`.

## The loop reviews the board

Read when: about to change what happens to a board item in `review`, the report endpoint `POST /api/loop/board/:id/review`, `server/loop/boardreview.ts`, or an item sits in the Review lane that nobody closes.

Review is not a parking lane. An item gets there when an agent runs `board move <id> review` or fundd moves an item whose conversation ended while it was still doing. Each loop pass (auto mode, the daily `loop-pass` job) then sends the oldest ones, after the proposals, under the same `MAX_SENDS` cap (`dispatch.ts`; a leave-for-the-owner counts against it too, and at most `MAX_OPEN` unanswered reviews are out at once). The record is the item's own notes, written by `loop` and starting `review:` (sent, says done, done by, returned by, owner needed); the Board drawer shows them and the Loop room's Board review lane lists who has each item. A re-send after `STALE_MS` and a stop after `MAX_TRIES` follow the proposals' rules.

- **Who reviews.** The item's owner, in a FRESH conversation (the launch contract boots it; the work's own conversation is refused, and so is a report from any conversation but the one sent). A missing, unknown or dormant owner, an owner that holds `execution/`, an item whose own text names an owner-only path (`config.ts ownerRail`, a settings file, `execution/`), an item returned twice and back in review, and a send unanswered after two tries each go to needs-you with the reason as a note and two options (close it, send it back). 19 of the 108 items in review on 2026-10-07 were of these kinds.
- **Verdicts.** `ready` + a line on what is missing: the item returns to ready. `done` + a commit: refused unless the sha is in one of the fund's repos, a remote branch holds it (pushed, as of the last fetch), its message names the item id or the item's notes name the sha, and it touches no owner-only path (that one goes to needs-you, recommending close). Then the endpoint answers `checking` and judges the commit by itself (`server/loop/commitcheck.ts`): `git archive <sha>` into a scratch fund root (other repos, `.venv`, `node_modules` are junctions), so another session's dirty or untracked files are never read. It lints the commit's own files (pyflakes; tsc, keeping diagnostics in those files) and runs the tests that cover them (`vitest related`; python tests the commit changed or named `test_<stem>.py`; `node --test`). Clean closes the item; red in those files or a red covering test returns it naming the file and the tail. Nothing to lint (a chapter) closes with `no lint or test covers these files`. It runs in the background (7 min for an eight-file app commit); fundd runs one at a time.
- **Second signal.** Then `check.py --only <area> --fast` runs for the whole area in the shared checkout and its result is a note on the item (green, `Area red elsewhere: <files>`, or red in the commit's files in the shared copy only). It never decides, and it runs outside the check queue, one run at a time per area: an item that finishes while a run is in flight takes that run's note, so the next commit check starts at once. Measured: with the run inside the queue (about 20 min for app under load) 2 hours of passes closed 5 of 130 items. Held by `test/loop-boardreview.test.ts` (red with the run back inside the queue). The first live pass returned two items for pyflakes in another session's uncommitted file.
- **Metrics.** A done the loop closed that is later reopened counts in `board_reopened` for the owner and for the reviewer named in the close note (once when they are one agent, `metrics.ts`).

What I chose, and why.
- **Owner as reviewer.** The agent that knows the area can tell whether the work matches the ask; a different agent starts without that and either rubber-stamps or reads the whole tree. The cost: a reviewer of the same agent type as the author is a weaker check than a different agent, and shares its blind spots. What is enforced is independence of conversation, not of mind.
- **`--fast`.** The live network suites skip, so a venue's bad hour does not return a finished item.
- **Parks count against the cap.** The owner's lane then fills as slowly as the reviewers' do. The `loop-pass` job is daily, so three a day drains about ninety sendable items in a month; a more frequent pass is the owner's setting in `app/schedule.json`, the cap is not raised.

Unenforced: that the work matches what the item asked (the reviewer's judgement; the endpoint only checks a pushed commit naming the item with clean files, not that it is the whole of the work); that a file has a covering test (a python source with no `test_<stem>.py`, and `platform/dashboards/`, get pyflakes only); that a break in an unchanged file shows (tsc there is listed as red elsewhere; only a covering test returns the item); that the archive holds what an offline test reads (an ignored data file is absent); "pushed" reads the remote-tracking refs, so a commit pushed from another checkout and not fetched is refused; a fundd restart during a check leaves the item in review until the send goes stale and is re-sent. Tests: `test/loop-boardreview.test.ts`, `test/loop-commitcheck.test.ts`, each guard broken once on purpose (linting the whole tree instead of the commit's files turns the outside-the-commit test red).

## The loop hears a chapter

Read when: about to change what the loop captures from git, how a promote or a library draft writes a lesson, or the commit guard's book warnings.

A learning is a `## ` chapter appended to the book it belongs to, so the whole loop reads chapters, not only new files.

- **Capture.** `lessons()` (`server/loop/sources.ts`) runs a second `git log -p -U0 --diff-filter=M` per repo root and attaches the `##` headings a commit added to that commit's M books. `fromGit` turns each into a lesson with ref `book.md#slug` and key `git:<sha12>:book.md#slug`, read from the tree as it is now (a heading gone since is dropped). A heading that only rewords one the commit removed is a rename, and a commit adding more than five books plus chapters is a reorganization.
- **Promote.** Lessons filed as chapters promote to one `## Shared: <title>` chapter appended to the book the earliest of them sits in. The target is the single ref `book.md#slug`; the gates are that the book exists and the slug does not. Apply appends to the file as it is on disk then, and commits that file alone. No new file, no `_series.md` row. Inbox lessons and whole-book lessons still make a new shared book plus a row.
- **Drafts.** A draft whose path is `book.md#slug` appends one chapter (it must open with its `Read when:` line) with the book's hash as base, and refuses a slug already there. Unenforced: the draft scan still proposes new files; nothing yet makes it propose a chapter.
- **Guard.** The write-back warning reads the chapter, not a series row: a chapter added to a chaptered book (some chapter carries a Read when line) without its own warns. The shrink warning flags any `##` heading lost outright, not only a 30% loss; a reworded heading is not lost.
- **Retire** takes a book's chapter refs out of boot with the book and puts each back as it was (`<agent>|<slug>` in the mark).

Not measured: pulls are per file (the Read hook cannot see a chapter), so helpful/harmful and unread count per book. Boot-compress and the Agents meter already count per boot ref.

## Engines: one hand per provider

Read when: about to add a provider or model source to the chat box, change how a conversation boots on Codex, DeepSeek or Grok, hand a provider anything from the environment, or a CLI engine's turn fails with a message about a rule, a prefix or a key.

A model id names its engine as a prefix (`grok:grok-4.7`, `codex:gpt-5.5`, `deepseek:deepseek-v4-pro`); a bare id is Claude, so every stored id stays valid (`shared/engines.ts`). Each provider is a read of the same `PermittedRead` shape (`server/chat/engines/catalog.ts`; Claude is still only `server/chat/models.ts`), listed even when it cannot run, with the line that says what is missing. DeepSeek is the same SDK hand pointed at its Anthropic-compatible endpoint; Codex and Grok are one CLI process per turn behind an adapter that turns the stream into SDK messages, so `normalize.ts` stays the one mapper. A conversation that runs on a CLI engine, or has crossed engines, is read from `~/fund-data/foreign/<id>.json` (rows plus each CLI's session id), never from a Claude transcript. A switch reboots the hand and says so on screen; the new engine does not see the old one's turns.

- **A key reaches one provider.** `agentEnv` scrubs every credential-shaped variable, then `launch.ts` adds back only what that engine needs: the DeepSeek key as `ANTHROPIC_AUTH_TOKEN` on a DeepSeek spawn. `agentEnv` keeps `ANTHROPIC_*` on purpose, so a Codex, Grok or DeepSeek spawn would otherwise carry the owner's Claude key to a third party: `withoutAnthropic` removes them. Grok and Codex sign in through their own CLIs and hold no key here. Enforced: `test/chats-engines.test.ts` (broke it once on purpose by handing the key to every non-Claude engine: both credential tests fail).
- **One place for keys: the dotenv file at the fund root.** `providerKey()` (`server/chat/engines/keys.ts`) reads the machine env first, then `<fund root>/.env` (gitignored; `Read(.env)` is on the deny list), and takes ONLY the variable the provider names (`DEEPSEEK_API_KEY`): `KEY=VALUE` lines, `#` comments and blanks skipped, one pair of quotes and the whitespace stripped, an empty value is no key. The file is never loaded into `process.env` and none of its other lines is kept or passed to a spawn. The old `~/fund-data/providers/deepseek.key` fallback is gone: a key left there is no longer read. The "no key" line names the variable and the file, never a value; `/api/chats/providers` returns that line and nothing else, and the UI gets `have()` only. fundd reads the file on each spawn and each provider read, but the provider list is cached for a short while and a fundd started before the key was written needs a restart to be sure. Enforced: `test/chats-engines.test.ts` (the parse cases, and the key reaching a DeepSeek spawn and no other).
- **The deny list does not follow a seat to another engine by itself.** `.claude/settings.json` binds Claude only. Grok gets the same rules as `--deny` flags (`denyArgs`); it refuses the whole turn on a tool prefix it does not know (`unknown tool prefix: PowerShell`, measured 2026-10-06), so a `PowerShell(...)` row is sent as the `Bash(...)` row it twins. Grok's own fence was proved live: a denied `echo` came back blocked. Codex has no rule engine here: it runs `--sandbox workspace-write`, never the bypass flag, and was NOT run against a live Codex (not installed on this machine). A seat whose folder is `execution/` or the fund root, or whose writes include `execution/`, is refused a CLI engine (`foreignRefusal`).
- **Probing the deny list with the shell trips it.** A probe that spells a denied rule on its command line (a `--force` push, the gateway's install folder, the live-trading flag) is refused whole. Probe through a script that reads the list.
- **Grok facts** (grok 1.0.46): the model list and each model's ladder are `~/.grok/models_cache.json` (`info.reasoning_efforts`); `grok models` prints "not authenticated" while a signed-in turn works, so signed in is `~/.grok/auth.json`. `--output-format streaming-messages-json` restarts message ids at `msg_0` every process (the adapter prefixes a per-turn tag) and its `result` is per process (the adapter keeps usage cumulative, as the runner diffs it).
- **Unenforced:** DeepSeek's two rows are declared (checked against `/models` when a key is on hand, dated 2026-10-06); Codex's stream shapes are the studio's record, fed from fixtures only.

## "Did not answer" is not a dead board

Read when: `board.mjs add --now` or `pickup` printed "waits for the board's next tick (fundd on :4689 did not answer)", or you are about to re-file an item or restart the cockpit because of that line.

After filing, the CLI asks fundd for a tick on `FUNDD_PORT`. An agent the cockpit booted has that in its environment; a shell without it asks the dev port, :4689. From such a shell the line prints while the production cockpit on :4688 is up, and the owning agent still starts the item from the board's own timer (measured twice: within about 15 minutes each time). The file on disk is the claim; the tick is only a nudge.

Do not re-file the item and do not restart anything on that line alone. Read the item's `status` and notes, check `GET http://127.0.0.1:4688/api/health`, and only then decide whether anything is wrong. Unenforced: the message does not say which port the production cockpit uses.

## Restarting the cockpit from inside a seat

Read when: the owner wants the cockpit restarted now and you are a session the cockpit started, or a hand-off watcher will be running across a restart.

Usually do nothing: fundd restarts itself at its first idle moment after a server commit (`#stopping-and-restarting`). A restart sooner needs the owner's word, and it cannot be run directly from a seat: a session the cockpit booted is a child of fundd, and `stop.bat --cockpit` kills fundd WITH ITS TREE, so the command dies before `start.bat` runs.

What works is a one-shot job outside fundd's tree:

1. Write a PowerShell script under `~/fund-data/` that waits until no other conversation is live (`GET http://127.0.0.1:4688/api/chats`, skipping your own `FUND_CONVERSATION`, with a cap on the wait), runs `stop.bat --cockpit`, then `Start-Process cmd -ArgumentList '/c start.bat --no-open'`, checks `/api/health`, logs every step to a file, and deletes its own task.
2. Register it as a scheduled task that runs once: `schtasks /create /tn fund-restart-cockpit /sc once /st <HH:mm> /it /f /tr "powershell -File <script>"`.
3. Before: tell the owner which agents are mid-turn. After: read the log, check the events of kind `system` for "restarting", and send a message to any conversation the restart cut.

**Watchers fire on a restart.** A script that waits for a chat to go idle and then sends it the next item reads the restart's `closed` state as idle and dispatches at once. Measured: one item went twice into one conversation, and its agent concluded a second session was writing its files. Stop hand-off watchers before a restart and re-arm them after it. A restart also ends the background tasks of every chat that sits between turns.

Unenforced: nothing checks for running watchers before a restart.
