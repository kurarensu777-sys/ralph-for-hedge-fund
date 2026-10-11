---
topics: [dashboards]
type: guide
---

# Dashboards - the seal, the homes, the field reads

What every screen shares: the seal, labels and verification, where a screen lives and how it runs, the gate on reading other people's code, and what building screens taught. No dashboard ships in this repo. Kept by the `platform` agent; a dashboard's own agent (`dash:<id>`) keeps its screen. A new learning is a new `##` chapter here, opening with its Read-when line.

## The seal and the folder kit

Read when: about to add an import to a dashboard, copy a file between two, build or rebuild a dashboard `.venv`, or a seal or registry test goes red.

A dashboard is a SEALED folder `platform/dashboards/<id>/`: its own package, `.venv`, tests and a `CLAUDE.md` that is its screen runbook, plus a roster file `app/agents/dash-<id>.md`.

- **The shared cwd is why the seal exists:** every dashboard runs with cwd `platform/dashboards`, so `import <other screen>` would work from the terminal at runtime. A seal test refuses it, a `.parent / "<other>"` path and a `../<other>/` string; a stylesheet or the charting library two screens need is a copy in each.
- **The interpreter:** `<id>/.venv` is git-ignored and built from the screen's own `requirements.txt`, which installs the platform package editable and the data layer (`fund_db`). Without `fund_db` in its venv the store is off in that process. A new top-level import in the platform breaks every older venv.
- **Venue data arrives through the platform's data facades only.** A screen never imports a venue adapter, and a DEEP import past the facades is refused unless the file is on an explicit list that is an UPPER BOUND (a listed file that stops deep-importing still passes, an unlisted one that starts is red). A dashboard that needs a venue reading asks `platform` for a facade (a board item), never for a row.
- **A stored-data location is never spelled** in a dashboard (`fund-data` or an env var naming a store): the seal refuses them outside a docstring.
- **The registry** reads the folders; its tests keep a LITERAL hard minimum that must always be there, plus a list of folders that, once present, must load as a registry row and be walked by the seal, so a half-made folder is red, never silently skipped. Neither set is derived from the folders.

## Labels, signs and stamps

Read when: about to add a column, a figure, a colour or a header to a screen; or a number on a screen looks wrong and may only be unlabelled.

- **PREDICTED and SETTLED are different numbers and the page says which.** A venue's live funding figure is the rate for the interval IN PROGRESS and can be eight times a realized mean and be correct (a 30% annualized live print was true; the fix was a label).
- **A cadence stamp is never hidden.** A single-clock column carries its interval in the header; a mixed column stamps every cell, 8h included (hiding the 8h stamp once made 61 of 174 cells read as missing data).
- **One sign rule:** positive green, negative red, everywhere. Direction has its own tokens (blue long, amber short) and never borrows the sign colours.
- **Short headers** with the qualifier in parentheses, the long form in the tooltip; no captions under tables. A column still loading shows a placeholder, never a dash.
- **Scale what you draw to what is on screen:** a heatmap's intensity is normalised to the max of the VISIBLE window with a gamma curve, so a far wall does not wash out the view; a large print is the top decile of what is on screen, not a fixed size.

## Verifying a screen

Read when: about to call a screen change verified, or to write its probe.

- **A 200 is not a verification.** Probe every route the change touches and assert the PAYLOAD SHAPE and at least one value against its source.
- **A browser probe at 1920x1080 and 1366x768** (Playwright): zero console errors, zero page errors, no body horizontal scroll. A probe tests the branches today's data holds: name the branch it did not exercise.
- **Bump the cache-buster** `?v=N` in `index.html` in the same commit as any `app.js` or `app.css` change; `/` is served no-cache.
- Two views of one server share its code and static files with one hand; a shared change names every view that reads it in the commit.

## Homes and ports

Read when: about to add a screen, move a view, or remove a route or poller; or looking for where a screen's port, views or runbook live.

A screen's port and views are in its `dashboard.json`, never in prose. A new screen is a `dashboards/<id>` folder of its own, or an entry in an existing server's `views`.

- Views that share one poller set and one socket hub stay in one server, because splitting runs a copy of both per screen. A view leaves a server only after its replacement is green; its routes and pollers leave last.
- A screen's runbook is its own `platform/dashboards/<id>/CLAUDE.md`, not a library shelf.

## Running a sealed screen

Read when: woken because a dashboard health check failed.

Triage (`port` and `http` checks): every `port` red means the process is down - start it once (`start.cmd` in its `dashboard.json`), not per view; `port` green with every `http` red means something else holds the port or the server hung at boot - read its log; one view's `http` red alone is that view's route.

## The field-read gate

Read when: about to adapt code, a formula or a design from an outside repo, paper or terminal, or to copy an outside app into a dashboard.

Code is adapted only from a source with a DEEP READ on file (url, commit, date, quoted formulas, a verdict of **adapt with attribution** or **ideas only**) in which its LICENSE file was opened.

- **Ideas only:** a README that says MIT with no LICENSE file; GPL, AGPL, BUSL and custom licences; a defective source even under MIT (a check that cannot go red). A permissive licence is necessary, not sufficient.
- **A textbook formula is re-derived from its paper and cited as such,** whatever repo showed it to us. Attribution (`LICENSE`, `NOTICE`, the copyright notice) travels with any copied file.
- **No credentials, no orders, no execution** are taken from a repo. A band from an outside rule is an ESTIMATE tagged `[1]` until the rule's own document is read.
- **A copied app is proved by hash and never edited:** `git hash-object` every file against the upstream blob at the pinned SHA (67 of 67 identical once). No LICENSE file upstream: copy only on the owner's word, for internal use.

## Lesson: live overlays belong to one source

Read when: about to lay a streamed value over a REST row, key a live cache by symbol, or change what a source switch resets on a screen.

A screen that lays streamed values (a row's funding, its ticker fields) over REST rows, keyed by a normalized symbol (`BTC`) that exists on every venue, will keep them across a venue switch and put one venue's funding on another venue's row. It looked plausible.

The rule: a source switch clears every streamed overlay, and a frame whose source is not the one on screen is dropped: a closed subscription can still deliver one in flight.

The check: count live-dotted cells against the subscriptions actually open. Measured: 159 of 200 cells carried the live dot against 31 open row topics. Unenforced: no offline test drives two sources through a page; a browser probe per source, by hand, is the check.

## Lesson: change only what the owner asked

Read when: about to brief a screen change from an owner's ask, an approved mockup or a cleanup pass.

The owner's ask is the change, not a licence to redesign around it. The owner once asked only to cap a table at its latest three rows; the build copied the mockup's simplified table, dropped a column and the clickable cards of the original, and the owner had it reverted. A later cleanup pass recoloured values against the owner's stated colours and had to be undone.

A brief for a screen change therefore names what STAYS (the layout, the interactions, any colour the owner set) as plainly as what changes, and cites the commit that holds the design to keep. Partly bound: a screen's test can pin the owner's colour constants and the original design; any other owner-set choice is held only by the brief.
