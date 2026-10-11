---
topics: [ui, checks]
type: guide
---

# Cockpit UI

What the cockpit's screens have already cost to learn: the browser rules every room obeys, how a UI change goes live and how to look at one before it does, the Research and Data rooms, and how an agent drives the running cockpit. The `app` agent keeps it. A new learning is a new `##` chapter here, opening with its Read-when line.

## One event stream per tab

Read when: about to open an `EventSource`, a WebSocket or any long-lived fetch in the UI; or a page "does nothing" while curl against fundd works.

Chrome allows six HTTP/1.1 connections per host and vite serves HTTP/1.1. Every long-lived connection (an SSE stream, a WebSocket, a watch poll held open) holds one of the six for its whole life. The seventh request does not fail: it QUEUES, silently, for ever.

The law: exactly ONE `EventSource` per browser tab, `/api/events`, opened once by `src/lib/api.ts`. Every live update rides it as `{topic, data}`. The server publishes with `publish('<room>', ...)` or `publish('<room>:<id>', ...)` (`server/events.ts`); a room subscribes with `useTopic` / `useApi(path, topics)` (exact topic, or `'<room>:*'` for sub-topics) and never opens a stream of its own.

- When a page "does nothing" while curl works, count long-lived connections per origin FIRST. Anything past five is the bug.
- A terminal WebSocket is a connection too: open it only while its pane is visible.
- Unenforced: "never open a second EventSource" is prose only; no check holds it.

Measured 2026-09-22 (the old cockpit): "I send a message to an agent, nothing registers" - six open chat panes each held an SSE stream, so the next stream and every fetch behind it, the send included, waited in the browser's pool; nothing in any log said so.

## Three honest states

Read when: about to render a count, a status dot, a list or a reading whose source might be missing, failing or not yet measured - above all about to default something to `0`, `[]` or green.

A screen that cannot tell "there is nothing" from "I could not look" from "I cannot know" will show a green dot over a dead service, and a false zero is worse than a blank. The honest answers are empty, failed and unknown; loading is the look while a request is in flight, and there is no fifth.

- loading: `<Empty state="loading">`. Empty (we looked, nothing there): `<Empty>`. Failed (we tried and it broke): `<Empty state="failed">` plus the error text. Unknown (no probe, no reading yet): `<Empty state="unknown">`, an unfilled dot.
- A status dot is green only when a probe MEASURED ok. A count is `0` only when the source answered and counted zero; if it did not answer, the count is absent. Default to `null`, never `0`, `[]` or `'ok'`. `Load` (`src/ui/kit.tsx`) does loading and failed for you; the empty test is yours to pass.
- A port MEASURED closed is `stopped` (known: grey dot, last numbers dimmed), not `unknown`; `unknown` is for what no probe has read. The Dash summary card says `stopped - last seen <ago>`.
- A fill needs the denominator the agent declared: `done of total` from its newest `TodoWrite` since the message that opened the turn (`server/chat/progress.ts`). No list, no fill: the tab sweeps and says `7 steps`. A percentage made up from elapsed time is a zero you did not measure.

Measured (the old cockpit): the services rail defaulted an unprobed row to `ok`, and a missing read-ledger to "0 reads"; both looked healthy.

## Colours, heat strips and labels

Read when: about to add a colour, a status chip, a 24h strip, a header or a caption to any room.

- **Colours mean one thing.** ok green, warn amber, fail red, working the accent pulse, waiting-on-you blue. Markets wear their OWN hues, never an agent category's or a state's. Whose work it is = the agent's category colour, from `src/ui/categories.ts` only (`test/categories.test.ts` fails on a copy anywhere else). A category colour is never a state.
- **A word the owner chose is not good or bad.** A verdict (3x, NO SIZE) is an answer, so it wears no green or amber; green and red are for pass and fail (`verdictTone` in `src/rooms/research/format.ts`).
- **Heat strips.** Every 24h strip is the one `.heat` look in `styles.css`, with FOUR drawn states: ok green, fail red, missed amber (a warn, or a window that ran out), no reading grey (nothing recorded, unknown or off; never green by default). Readings: `app/library/app/cockpit-server.md#state-homes`.
- **Short labels.** A header is one or two words, no caption explaining the obvious; the long form goes in a `title` tooltip.
- **A room owns its CSS.** Classes are prefixed `<room>-`; the shell, the kit and other rooms are touched only through their seams.

Mechanism: `test/categories.test.ts` holds the colour map. Unenforced: the strip look, the short labels and the prefix are by review.

## Landed is not live

Read when: about to tell the owner a cockpit change is live, ask the owner to press Reload, or verify a UI change against the production cockpit on :4688; about to add a field to a room's wire type that the UI branches on.

The general law: `app/library/law/how-we-know.md#landed-is-not-live`. Here it bites twice.

**The UI is a built `dist/`.** In production (`start.cmd`) ONE fundd on :4688 serves the prebuilt `dist/` and runs the server it loaded at start (`/assets/index-<hash>.js` on :4688 and nothing on :4689 means production). Within a minute of a UI commit landing, fundd rebuilds `dist/` (`server/uibuild.ts` `AutoBuild`; a failed build waits for a newer commit), and each open tab reloads onto it once hidden or idle for 2 min (`src/shell/uifresh.ts`). The build takes the working tree as it sits, other conversations' uncommitted UI edits included. The tell: the status bar's code chip turns amber when `dist/` or fundd is older than the newest commit touching it. A server change is another clock (`app/library/app/cockpit-server.md#stopping-and-restarting`). A report says which artifact was tested.

**A new UI reads an OLD fundd's payload for up to 30 min.** A field a commit adds to a room's wire type is ABSENT in that window, and a boolean tested as `!v.flag` reads absent as false. When `archived` was added to a room's view, `!v.archived` would have drawn every row on the old fundd as not archived. Test a new boolean against the value that CHANGES behaviour (`v.archived === false`), so absent reads as the old page. Unenforced: nothing checks it.

Measured: the tab light was committed and pushed while `dist/` dated from hours earlier; the owner could not see it.

## Seeing an unlanded change

Read when: about to screenshot a UI change that is not landed, judge a before/after, start a second fundd or scratch server to look at a new route, or write a throwaway script that imports the app tree.

An unlanded change is seen on a second server, and vite dev, reached for first, draws a different page than the production `dist/`.

- **Judge the look on a build, not on vite dev.** `npx vite build --outDir <a temp folder>`, serve that folder, compare with shots of :4688 (also a build). Measured: the SYSTEM room's tiles rendered WHITE on vite dev and GREEN in the build from the same source: two single-class rules set `color`, and dev and build order the css differently. Unenforced: nothing refuses a dev-server shot as evidence.
- **Never start a second fundd to see your route:** it runs the Dash room's checks (and can wake a dashboard agent) and records readings into the live store.
- **Start no server at all.** Build to a temp folder and let a Playwright page (`playwright-core`, `channel: 'chrome'`) serve it, with `page.route` on every same-origin request to :4688: a static path comes from the build (an unknown path gets `index.html`), a GET under `/api/` continues to the live fundd, a non-GET is answered 204 and never reaches it, and the new route, or a branch today's data lacks (a waiting row, a failed row), is fulfilled with the reading you want.
- **Seed localStorage** (`fundos.room`, `fundos.chats.panes`) with `page.addInitScript` before the first `goto`: a second `goto` that changes only the hash does not reload (measured 2026-09-27: one tab drawn instead of four).
- **A success path no real data exercises needs a fixture:** an override like the Research room's `FUND_RESEARCH_DIR` pointing at a scratch folder of copied real data plus FIXTURE data (every title says FIXTURE; never commit it).
- Print each element's class before reading the picture; read at 1440 and 1920; say which half you saw.
- **A throwaway script on Windows:** import an app file as a `file:///` URL (`file:///C:/path/to/fund/app/...`; a bare path fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`); `npx tsx` runs a `.ts` outside the project as CommonJS, so top-level `await` needs `.mts`. Run it from `app/`.

## What the Research room reads

Read when: about to change what the Research room shows, add a study format or a metric, or define ANY format, schema or MIME type a room reads.

The room reads each `platform/research/<folder>/*.ipynb` as JSON (`server/research/scan.ts`), never runs one, and takes its ONE `application/vnd.fund.study+json` output, the `fund.study/1` manifest (format: `app/library/research/research.md`; read by `shared/research.ts` `manifestProblems`, `FORMATS`). `FUND_RESEARCH_DIR` points a test instance elsewhere.

- **Reads, never computes.** A number the manifest lacks is a new manifest field (the research book first), never derived in the room.
- **Formats are never ranked together.** Five formats (carry, directional, short_vol, rel_value, evidence); any study may take any (the owner, 2026-10-04), and one that simulates P&L takes one with the risk-adjusted set (`directional`).
- **An unknown never passes a filter.** A threshold drops a study that lacks the metric; a null metric shows `n/a` with its `na` reason; a notebook with no manifest reads `legacy`, never zeros.
- **Labels per study:** MARKET (one or more of crypto, equities, rates, predmkts; the first is the MAIN one), FORMAT (one) and STYLE (systematic or discretionary), from the manifest (`profile.markets`, `format`, `tags.style`), else `platform/research/labels.json` (`check_labels.py`). A value off a closed list is a FAULT.
- **The archive is a group behind a toggle.** `platform/research/archive/*.ipynb` is read like `studies/` (same manifest, same card, loop runs joined by file name) as group `archive`; the list hides it until the Archive chip (stored `research.archive`) is on, then shows it as one last group whatever the grouping. An archived study carries no market or format label, so Table, Compare and the groupings never see it. `check.py research.studies-named` accepts a name in either folder.
- **The list lists a study once.** Group by Market files it under its main market only; every other market is an outlined square beside the filled main one.
- **The Headline is the manifest's, not the format's.** The list cell, the card's Result and Compare read `manifest.headline` (`headlineOfManifest`); without one it falls back to the format's lead metric (which can sit before costs). The tone is the verdict of the gate named by `headline.gate`; no `gate`, no tone. Unenforced: research sets `headline.gate`.
- **Pace is read, never computed.** `tags.pace` (intraday, swing, hold) is derived and checked by platform (`report.pace_of`); the room shows it when the manifest has it, whatever `avg_hold_h` says. Style tags are blue (systematic) and amber (discretionary), the owner's choice and an exception to the state colours; pace is green and dashed.
- **Who checks what:** platform's `_summary_problems` holds a summary's row content; `manifestProblems` only the drawing's shape.
- **Charts reads the chart bank, not a copy.** One card per `## ` chapter of `app/library/research/charts*.md` (`server/research/charts.ts` `chartBooks`, parsed once per file mtime). The heading slug is the kind id a manifest figure may carry (`figures[].kind`); `CHART_KINDS` in `shared/research.ts` is held equal to the chapters by `test/research-charts.test.ts` (a new type is a chapter AND a row there). The exemplar's PNG is the notebook cell tagged with the figure id (`/api/research/chart-fig`); `none yet` says "not drawn yet". The cards sit under eight categories by the question a reader arrives with (`CHART_CATEGORIES` in `shared/research.ts`, not the three family books, which split by stage of a study): each chapter header carries `Category: <name>`, an exact name from that closed list. A missing or unknown one is counted and shown in a FailLine and the card goes in a last "No category" group, never into one of the eight.
- **Questions are the notebook's, read not made.** Under the summary card, `server/research/questions.ts` reads each `## S2`..`## S6` heading's `| question | gate |` table, its `fig:s<n>-<name>` PNG cells and its text/markdown outputs, and S7's gates table; gate chips, readings and figure titles are the manifest's. A notebook that does not head all of S0-S7 gives null and draws nothing. Markdown is drawn as nodes, never HTML.
- **Define a format once.** Search first (`grep -r "vnd.fund" app/library`, `board.mjs list --q manifest`). Measured: `fund.result/1` was built the hour research filed `fund.study/1`; converging cost a rewrite.

## The Data room

Read when: about to change the Data room, or add a route that moves, prunes or evicts data.

Files: `server/rooms/data.ts`, `server/data/`, `src/rooms/data/`; tests `test/data.test.ts`, `test/data-storage.test.ts`. The cockpit never imports the python data layer, so every reading and every move is a child process (`server/data/job.ts`) through one door, the store: `python -m fund_db usage|tier|prune|cache --json`, cwd the fund root, ONE JSON object on the last stdout line (`{ok:false, status, error}` for a refusal). The cache and pins are read through `@fund/db`, read-only (`server/data/storage.ts`).

A door that is not there (a missing module, an old CLI without `--json`) answers `{available: false, reason}` and the room reads NOT AVAILABLE with the reason, never a zero or an empty cache. `FUND_STORE_CMD` swaps the door for a fixture (`test/fixtures/store-fake.mjs`), so a test never touches the real lake.

## Every Data room move is a plan fundd holds

Read when: about to let a page post back a plan, or add a route that applies a retention change or an eviction.

**The browser never holds what decides a move.** A plan (retention, evict) is made by a dry run and HELD by fundd under a key (`PlanBook`, `server/data/plans.ts`); Apply names only the key and the phrase the owner typed. A digest posted back by the page would not prove who made the plan, so the page never sends one.

- The retention phrase is rebuilt from the HELD plan's totals. A wrong phrase or an expired plan is refused BEFORE any child runs.
- A plan is applied once: the key is dropped on the first apply. A fundd restart forgets every plan.
- Apply dry-runs again and refuses (409) when the lake moved since the plan, or the cache moved for an eviction.
- **Evict to budget is a REAL delete** (the cache's carve-out from "no agent deletes data"): `python -m fund_db cache --evict --dry-run --json` is the plan, then the same command without `--dry-run`, once. `app/tools/datalaw.py` refuses `cache --evict` or `market.evict(` anywhere else in app, so this room stays the one evicter.

A door's `{ok: false}` reply is kept whole (`Refused.reply`): `fund_db tier|prune --apply --json` that stops part-way still lists the partitions that already moved, and the room names them. `fund_db`'s refusals carry no `status`: they read as 500 with the reason verbatim.

## Lesson: parse a python reply digit for digit

Read when: about to parse a python child's JSON in node and send a value back to it (an integer past 2^53 rounds), or write a fake door for a test.

A plan's fingerprint carried every part file's `mtime_ns` (about 1.8e18) and its `plan_id` digested them. A plain `JSON.parse` rounds those integers, so the plan sent back no longer matched its own id and the real job refused every apply. `readReply` parses with `parseExact` (`server/data/job.ts`), keeping an unsafe integer as its exact digits (`JSON.rawJSON`); `test/data.test.ts` asserts the digits arrive (red with a plain parse). Any node reader of a python JSON contract that sends a value back has the same hole.

A fake door only proves what it was taught: 27 green tests against the fixture, and the first real apply failed. Teach the fixture the real shape.

## The Context room reads the boot, not a copy of it

Read when: about to change `buildLaunch`, `systemAppend`, `startChain` or what an agent loads at boot; add a layer to the Context room; or show a token count or cap for what an agent loads.

The room (`server/context/predict.ts`) predicts an agent's context from the helpers a boot uses: `startChain` for the CLAUDE.md chain, `bootBooks`, `agentBrief`, `systemAppend`, `mcpServers`. The Prompt tab shows `systemAppend` as it is. `test/context.test.ts` asserts the predicted append equals `buildLaunch(...).options.systemPrompt.append` for every agent on the roster (red for every agent when the brief was dropped from the prediction). A new layer that `buildLaunch` adds to the append must go through `systemAppend`, or that test goes red.

- **Caps come from `app/tools/context-caps.json`** through `server/library/caps.ts`, never a constant in the room (a test greps the room for the numbers). A workspace file takes its named cap, else the screen cap for a dashboard's CLAUDE.md, else the workspace cap, the same rule as `app/tools/context.py`. A file that cannot be read draws no cap.
- **Unknown stays unknown.** The Claude Code preset, each MCP server's tools, skills reach and auto-memory have no measured size: their rows are `?`, and the footer's "known total" says it leaves them out.
- **A save is one commit of the roster file** (`saveFiles`, sha base, 409), as the owner. The brief, the boot list, the model and the effort all live in that file, so they share one draft and one Save. Only a conversation with a live process can be on an old prompt (a closed one boots from the new files); the count compares its recorded boot rows with the agent's list now, so a chapter added or removed counts although every row it had is unchanged (`server/context/drift.ts`).
- A sticky footer of several rows needs opaque cells: a translucent tint on a cell shows what scrolls under it, so tones are a `background-image` over the cell's own colour.
- The writer must be the reader inverted: `serializeAgentFile` quoted a role holding an apostrophe, so the first Save of a header would have rewritten the line. `test/roster.test.ts` round-trips every live roster file byte for byte (red for a roster file whose role held an apostrophe, before the apostrophe was allowed in a plain scalar).

## The CEO board and the rail dock

Read when: about to change the CEO lane on the Board page, the dock under the Services rail, the Usage card, or who may file onto the owner's own board.

The owner's own list is a lane of its own (`src/rooms/board/ceo.tsx`, right of Suggested) and a pinned dock under the Services cards (`src/shell/Dock.tsx`). It is a store the agents' board never reads: `app/board/ceo/C-NNNN.md`, `server/board/ceo.ts`, routes `/api/board/ceo`. Auto-pickup, `board.mjs list` and the agents' filters read `B-NNNN.md` in `app/board/` only (test: `board-ceo.test.ts`).

- **One chat per issue.** `ensureChat` starts the issue's chat with the agent the owner picked when filing, records the id, and answers that id on every later press. One issue at a time, so a double click starts one. The agent is fixed once the chat exists. A recorded chat that is gone answers 410 and the UI starts a fresh one, the old id kept in the notes. Broken once on purpose: without the lock the double press starts two.
- **Who may file.** The cockpit (the request carries its Origin) files as you. An agent files only through `board.mjs ceo add --told "<the owner's words>"`; the words are stored on the issue and shown as a "told by" chip. Unenforced beyond that: an agent that invents the words, or posts to the local API naming itself, gets through, and the chip is the detector. No other `board.mjs` command reaches the folder, and the commit guard lets an agent stage `B-NNNN.md` only.
- **The Usage windows are Claude Code's own.** The 5-hour and 7-day bars are the latest `rate_limit_event` of any chat (`server/chat/planlimit.ts`, kept in `<fund-data>/plan-limit.json`); none seen yet, or a reset gone by, draws the hatched unfilled bar and says so, never a fill. Utilization is read as a fraction of 0..1; a value outside that is not drawn and its raw number is in the tooltip. A test that touches the module sets `FUND_DATA_DIR` first: one that did not wrote a fake reading into the real file.
- **The dock card acts, it does not only point.** An inline add (the lane's `fileCeo` and `@agent` parse, `parseQuickAdd` in `shared/ceo.ts`), and a bar: Open board (unfolds the lane by writing `board.ceoShut`), Answer N (each press opens the next waiting chat, so one left unanswered does not hide the rest; disabled at zero or while chat states are unread), Done N (shows the last five done, dimmed). The card keeps its own `dock.ceoAgent` and `dock.ceoDone` keys, not the lane's: two `useStored` instances of one key do not sync, so a shared key would show a stale picker on the Board page. The same limit means Open board does not unfold a lane that is already on screen. Unenforced: nothing ties the two pickers to one value.
- **A new route needs a restart of fundd.** An old fundd 404s `/api/board/ceo`, so the lane shows failed and the dock row shows the error, not an empty board.

## A page that does nothing: count the connections

Read when: the owner says "I send a message and nothing registers", a pane sits on "reconnecting", or you are about to give a pane, card or tab its own long-lived connection.

When the daemon is healthy and a node client or curl can send, but the page cannot, look at the browser's connection pool before any route. In the old cockpit every open chat pane held its own SSE stream for life; with six or more panes open, the next stream and every fetch behind it (the send included) queued in Chrome's six-per-host pool and never left the browser. Nothing in any log said so.

- The evidence pointed away from the server: conversations created and never sent to, a server that counted zero streams after a restart, panes stuck on "reconnecting". Read that pattern as the client's pool.
- Count the long-lived connections per origin first (SSE, WebSocket, a held watch request); anything past five is the bug.
- A per-pane connection opens only while its pane is visible. That is cheap when the server replays recent events on every connect.
- A stale tab keeps the old behaviour until it reloads, so re-test on a fresh tab.

The standing rule is one stream per tab (`#one-event-stream-per-tab`). Unenforced: no check counts a page's connections.

## Driving the running cockpit from an agent's browser

Read when: about to verify a UI change on the running cockpit from an agent session, type into a cockpit page through a browser tool, or force the cockpit to reload.

The owner sees pixels, never files, so a UI change is verified on the running screen. Use an agent-driven browser connected to the session as an MCP server (a browser extension may not be reachable from the session), open the page, then drive it by evaluating script in the page: find elements by stable class or text, read state from `localStorage`, check the DOM after each step. Screenshots alone do not say which element you hit.

- **Typing does not reach React state.** A tool that sets the DOM value leaves the component's draft empty, and the send runs on nothing. Set the value through the native `HTMLTextAreaElement` value setter, dispatch an `input` event, then a synthetic Enter keydown.
- **A forced reload kills live hands.** A daemon-side forced reload opened a fresh window and ended every running conversation (13 of the owner's chats once, each revived only by its next message). To see how a page behaves with the daemon dark, shim `window.fetch` in the tab to reject the route for N seconds instead.
- **A known harmless line:** `vitest run` can print "close timed out" from the vite config; it is not a failing test.

Unenforced: nothing refuses a forced reload while conversations run.
