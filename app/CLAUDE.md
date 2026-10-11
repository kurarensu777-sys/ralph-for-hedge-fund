# app - the cockpit and the machine behind it

The owner's one app for running the fund. It serves the roster (`agents/`), the board (`board/`), the loop
(`loop/`), the tools (`tools/`), the jobs (`schedule.json`) and the one library (`library/`). It
renders nothing it does not own; dashboards open in the browser, never in the cockpit. `app/` is a
folder of the fund repo, not a repo of its own.

## Run

```
npm run dev        # fundd (daemon :4689) + vite (UI :4688)
npm run verify     # typecheck + the whole suite: the land queue's gate
npm test           # vitest; npm run typecheck must stay clean
start.cmd          # production: one detached fundd serving dist + API on :4688 (--status / --stop)
```

`FUND_SCHEDULER=0` and `FUND_BOARD_AUTO=0` give a test fundd with no jobs / no board pickup.
fundd refuses a Host that is not 127.0.0.1/localhost, a foreign Origin on a change, and a body that
is not JSON (`server/gate.ts`). Every commit goes through the guard (`scripts/hooks`): staged paths
inside the agent's `writes`, no secret material.

## Rooms

chats, board, dash, data, library, context, lab, research, loop, git, system, map.

## Rules

- A room owns its folders: `server/rooms/<id>.ts` + `server/<id>/` (chats: `chat/`, dash: `proc/`),
  routes `/api/<id>/`; UI `src/rooms/<id>/`, CSS classes prefixed `<id>-`. Touch the shell, the kit
  or another room only through the seams.
- One event stream: `publish('<room>', ...)`; the UI refetches with `useApi(path, ['<room>'])`.
  Never a second EventSource.
- State is the ops store (PostgreSQL, schema `ops`) through `@fund/db` only. A schema change is a
  numbered file in `database/migrations/ops/`; the app keeps no schema.
- Configuration is files beside what they describe; `server/config.ts` is the one reader. Shelves
  are derived from the library folders, never configured.
- Short labels (one or two words; the long form in a `title`). Three honest states: empty, failed,
  unknown. Never render a zero or a green dot you did not measure. A room whose folder is absent
  (no `platform/lab`, no dashboards) shows empty, never a crash.
- Colours mean one thing: ok green, warn amber, fail red, working accent pulse, waiting-on-you
  blue. Markets wear their own hues; whose work it is = the category colour from
  `src/ui/categories.ts` only. Every 24h strip is the one `.heat` look, four drawn states (detail:
  Recall).
- No market I/O and no platform code here. Reach data through `@fund/db`, a dashboard's HTTP on
  127.0.0.1, or a python CLI child (`PYTHON -m fund_db ...`): never an import
  (`tools/tests/test_layering.py`).
- Money is never touched; the agent env is scrubbed of anything credential-shaped.
- Git: one repo at the fund root (`repos.json`); stage explicit paths. A build branch
  (`b/<agent>/<slug>`) is a worktree of that repo and reaches main only through the land queue,
  `verify` green: no merge commit, force or reset.

## The launch contract

Every agent the cockpit boots goes through one function (`launchCwd`, `mcpServers()` in
`server/chat/launch.ts`): cwd from `agents/<id>.md`; settings = `<fund>/.claude/settings.json`;
system prompt append = the role, the brief, then each book in `boot`; env = the parent env minus
credentials, plus `FUND_AGENT`, `FUND_CONVERSATION`, `FUND_ROOT`; MCP servers from `.mcp.json` at
the fund root and in `app/`, when present, passed explicitly.

## Recall

| The moment | Read |
|---|---|
| open an EventSource, WebSocket or long-lived fetch; a page "does nothing" while curl works | `app/library/app/cockpit-ui.md#one-event-stream-per-tab` |
| add a colour, a status chip, a 24h strip, a header or a caption | `app/library/app/cockpit-ui.md#colours-heat-strips-and-labels` |
| render a count, dot, list or reading that may be missing; default to `0`, `[]` or green | `app/library/app/cockpit-ui.md#three-honest-states` |
| say a change is done; the screen shows old code | `app/library/app/cockpit-ui.md#landed-is-not-live` |
| view an unlanded UI change: a screenshot, a second fundd, vite dev | `app/library/app/cockpit-ui.md#seeing-an-unlanded-change` |
| change the Data room or add a route that deletes, moves, fetches or evicts | `app/library/app/cockpit-ui.md#the-data-room` |
| change the CEO lane, the rail dock or Usage card, or who may file on the owner's own board | `app/library/app/cockpit-ui.md#the-ceo-board-and-the-rail-dock` |
| change what an agent loads at boot or the Context room, or show its token count or cap | `app/library/app/cockpit-ui.md#the-context-room-reads-the-boot-not-a-copy-of-it` |
| change the Research room or a format a room reads | `app/library/app/cockpit-ui.md#what-the-research-room-reads` |
| read, move or add a file the cockpit reads; ask where a reading comes from | `app/library/app/cockpit-server.md#config-homes-and-the-one-reader` |
| change how long an agent process stays open, add a way to close one, or RAM runs short | `app/library/app/cockpit-server.md#idle-hands-and-the-reaper` |
| change what Stop does to a running turn, or a background task reads "stopped by the user" | `app/library/app/cockpit-server.md#stop-spares-background-work` |
| boot an agent, add a spawn path, or change what it sees at boot | `app/library/app/cockpit-server.md#the-launch-contract` |
| add a provider or model source to the chat box, boot on Codex, DeepSeek or Grok, or give a provider a key | `app/library/app/cockpit-server.md#engines-one-hand-per-provider` |
| show, compare or enforce a token cap or budget (Agents meter, boot-compress rule, size mark), or touch `server/chat/reread.ts` | `app/library/app/cockpit-server.md#caps-and-budgets-one-file-and-a-re-read-that-is-not-a-boot` |
| stop or restart the cockpit, or tell the owner a server change is live | `app/library/app/cockpit-server.md#stopping-and-restarting` |
| hand work to an agent whose `writes` you lack | `app/library/app/cockpit-server.md#filing-work-for-another-agent` |
| file a question for the owner, or touch an item's `options:` / `chosen:` | `app/library/app/cockpit-server.md#owner-options` |
| cut, land or read a red or blocked land | `app/library/app/cockpit-server.md#the-land-queue` |
| change what the loop captures from git, how promote or a draft writes a lesson, or the guard's book warnings | `app/library/app/cockpit-server.md#the-loop-hears-a-chapter` |
| change what happens to a board item in review, or the board report endpoint | `app/library/app/cockpit-server.md#the-loop-reviews-the-board` |
| tag a book or add a shelf topic | `shared/bookmeta.ts`, `server/library/need.ts` |
| read or write the roster or a YAML header by hand | `shared/agentfile.ts`, `test/layout-parity.test.ts` |
