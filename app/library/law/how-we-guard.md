---
topics: [rules]
type: guide
---

# How we guard

How the fund keeps its data, its credentials and its permissions safe: the four data classes and the cache's carve-out, the two kinds of credentialed data door (a broker's gateway and a logged-in session), and how the deny list is changed and probed. The fund agent keeps this book. The doors table itself is `app/library/law/how-we-work.md#the-doors-and-their-keys`. A new learning is a new `##` chapter here, opening with its Read-when line.

## Data: the four classes

Read when: about to pull market data, decide whether a series is worth keeping, pin what a result used, evict, prune or delete anything under `~/fund-data`, open a data file or import a storage driver directly, or lean on a data rule as if a mechanism held it.

Data is pulled ON DEMAND and almost nothing is kept (the owner's rule). A historical read returns a handle; loading the handle re-pulls if the rows were evicted, and a notebook gets the load line, never a loose file. Every caller draws on one per-venue pacer in the ops store; a private sleep loop is a second pacer and a defect.

| Class | What | Fate |
|---|---|---|
| NONE | live frames, books, quotes, trades, one-off snapshots; a screen gets them only through the live-stream library, in its own process | stored nowhere |
| CACHE (the default) | anything a venue serves again | evicted least-recently-read month first to `[cache] max_bytes` in `database/retention.toml` |
| PIN | the exact rows a recorded result used | content-hashed, immutable, never evicted; the hash is the run's data fingerprint |
| ARCHIVE | what a backtest needs AND the venue will not serve again | the lake; settled rows immutable (a re-published different value goes to `conflicts`); never deleted by an agent |

The archive test (the owner's): "if next time we backtest and can't get the historical funding, then we should store; otherwise no." Both halves, or it is CACHE. A venue that serves only its latest few thousand bars passes it; a venue found to roll a series off earns an archive row, with its why. Each dataset's class is declared in `fund_db.market.registry`, each venue's archive list in that venue's config. Nothing re-fetchable leaves the lake until every input a recorded result cites is pinned.

The cache is the one place an agent's process deletes market bytes, a named exception like a venue package's own scratch folder (locks, pacing stamps, doc clones): rebuildable, never data. It is safe only while the cache never holds the only copy of anything; if that guard fails, the carve-out is void. `prune` still moves into `_retired/`.

What is mechanized and what is only a rule: `app/library/law/how-we-guard.md#data-what-holds-today`.

## Data: what holds today

Read when: about to lean on a data rule as if a mechanism held it, or cite a data mechanism in a result or a board note.

Held by code (ask the code): `python -m fund_db doctor` (cache within budget, no archive series in the cache, pins intact), the store's refusal of a permanent write outside ARCHIVE or PIN, one shared pacer, and the loop's refusal of a pin whose digest differs (`app/loop/tools/pins.py`).

Not held:
- An unpinned result is not refused: `--no-pin` or a failed pin (`pin: null`, `pin_error`) is recorded and lands.
- A venue's archive list is never checked against what the venue serves; an omitted archive row is simply CACHE.
- A study manifest's `inputs` is filled by hand.
- Prediction-market history can be neither pulled into a handle nor pinned (no OHLC shape in the lake), and the read ledger does not see every source.

## A broker gateway: read-only data door

Read when: about to connect to a broker's local gateway for data, write a call against it, or touch anything in the gateway's settings.

A broker's gateway, logged in by the owner on this machine (login and 2FA typed into the gateway only) with its Read-Only API setting on, a loopback socket and `127.0.0.1` as the only trusted IP, is a data door: an agent reaches the local socket and holds no secret. The lock between local code and a real order is that Read-Only setting, a file and not a permission the broker enforces, and no agent can see it (the settings are encrypted, and the broker's docs name no Read-Only refusal code). "Data only" rests on what can be checked:

1. An order scan: a source check refuses every order-shaped call (place, cancel, exercise, what-if, bracket, OCA, the names as strings) anywhere in the code that reaches the gateway, no file excepted; broken once on purpose.
2. The Read-Only flag is UNENFORCED and stays so: no order-shaped probe is written without the owner's word.
3. The network lock is the firewall, not the gateway: a gateway accepted a full session from this machine's own network address, so its trusted-IP check does not hold alone. Disable its inbound allow rules; a truly remote source stays untested.
4. A status job reads socket, login, market data type, the trusted-IP list and every inbound firewall rule for the gateway. It FAILS on a non-loopback trusted IP or an enabled Allow rule wider than loopback, and names `read_only: unenforced`.
5. Deny rows refuse any command line naming the gateway's install folder and any Edit or Write under it. No deny row on order-call names: code runs from files, so it would guard nothing and refuse every grep naming what the scan hunts.

A second gateway, or any session that is not read-only, is the owner's decision and nobody else's.

## A session-cookie data door

Read when: about to fetch through a logged-in data session, touch the owner's session file, or reach any route of that site beyond the data routes its adapter uses.

A logged-in data source reached with the owner's session cookie:

1. The cookie lives in ONE file in the home folder, outside every repo. It is never copied into a tree, env, book, board note, commit message, log or the database, and only the door's adapter reads it. Deny rows refuse the Read tool on it and any command line naming it, so paraphrase ("the owner's session file"); beyond those rows the rail is UNENFORCED (a glob or a script still reaches it).
2. Data reads only: search, scanner, chart data, never the account, alerts, settings or any trading or broker route. The adapter's guards send the cookie to one page and any auth token only into the data socket, and its tests break them on purpose; nothing refuses another route, which is UNENFORCED.
3. It is a data credential only while no broker is connected to the account; if one is, it becomes a TRADING credential and leaves agent reach.
4. With no official API, every route goes through the adapter, and every number read through it is dated and tagged.

## Probing the deny list

Read when: about to edit any `.claude/settings.json`, to say a permission change "takes effect next session", to automate a probe, or reading a refusal of a command that only quotes a denied phrase.

The owner set `defaultMode: "bypassPermissions"` and reaffirmed it: do not re-argue it or quietly reinstate an allow-list rule. With no permission cards, plan approval or `AskUserQuestion`, the deny list is the whole gate, and nothing would notice if it stopped binding. After ANY edit to `.claude/settings.json`, a CLI upgrade, or on a new machine, run four commands from the root and read the red rows first:

| Command | Rail | Expected |
|---|---|---|
| `tar --version` | none (not read-only, so never auto-approved) | RAN: bypass is armed and the probe can go red |
| `git add execution/x` | a root deny row | REFUSED |
| `echo ARMED=True` | `Bash(*ARMED=True*)` | REFUSED |
| Read a `.env` placed OUTSIDE the tree via `--add-dir` | `Read(**/.env)` | RAN: the known gap (inside the tree it is REFUSED) |

- NAME THE RUNNER. A headless `claude -p` never arms `defaultMode`, so under `-p` only the deny half can be probed and a refusal of a no-list command is evidence of nothing; probe the mode interactively, or pass `--permission-mode` and say so. Nothing checks which runner a probe used.
- A `Read(...)` deny resolves against the workspace root; a file reached through `--add-dir` or outside the tree is not covered. An absolute `Edit(//c/...)` or `Write(//c/...)` row does hold outside it. A `Bash(*...*)` deny is a substring match on the whole command line and holds everywhere, so it also refuses a command that only mentions the words (a commit message, a board body): paraphrase. Get a new deny row right in ONE edit: the session treats a just-edited deny file as self-modification. Removing or weakening a row needs the owner's word; adding one needs nobody's.
- A subfolder's `.claude/settings.json` is additive only (allow rows) and applies only once the workspace is TRUSTED (`hasTrustDialogAccepted` in `~/.claude.json`); under bypass every allow row is inert. With bypass off, probe with a command the desk file alone allows, one the root alone allows, a neither control and a root-deny. "Takes effect next session" is a prediction; only the probe closes a change. A refusal at a desk is a boot fact first: `app/library/law/how-we-know.md#the-law-must-be-loaded`.

## The fund agent applies an approved settings edit

Read when: about to file a board question about a change to `.claude/settings.json`, or the owner has approved one.

When the owner approves a change to the root `.claude/settings.json`, the `fund` agent applies it itself, in the same sitting, and then runs the probe above (a deny-listed command REFUSED, a no-list command RAN, the runner named). A board question about a settings edit offers the agent path as the recommendation, never "the owner applies it by hand": an owner's tick on a by-hand option once never reached the file, which still held its old rows until the agent applied the change.

Two limits stand. Removing or weakening a DENY row still needs the owner's explicit word, and anything that arms execution stays the owner's alone. Unenforced: nothing checks that an approved edit landed; the probe is the check.
