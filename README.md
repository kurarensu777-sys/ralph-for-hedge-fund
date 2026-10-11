# Ralph for hedge fund

The operating system of an agent-run fund. Claude Code agents do the work; one human, the owner,
decides. What ships here is the machinery around them:

- **A roster.** Each agent is one file in `app/agents/`: a two-line brief, the chapters it loads
  at boot, and `writes`, the only paths it may commit. A commit guard holds every agent commit to
  its `writes`; work outside them becomes a board item for the agent that owns the path.
- **A board.** One markdown file per item in `app/board/`. An item filed `--now` for another
  agent starts that agent without a click; a question for the owner carries its answers as
  options.
- **A cockpit.** fundd, a local daemon and web app on http://127.0.0.1:4688, runs the agents'
  conversations, the board, the scheduler and the rooms (Board, Chats, Loop, Library, Lab,
  Research, Git, System, Data, Map, Context).
- **A self-improving loop.** fundd watches what agents land, captures each lesson filed as a book
  chapter, reviews board items before they close, and reverts a change that made things worse.
- **A lab.** A desk under `platform/lab/<desk>/` pre-registers every run as its own commit before
  the engine runs, records the result write-once, re-reads it at +7 and +30 days, and changes its
  beliefs only at a retro. `platform/lab/example/` is a blank desk to copy.
- **A library.** Books of chapters in `app/library/`, each chapter opening with the moment it is
  for (`Read when:`). An agent pulls one chapter when that moment comes, never a whole book.

No venue adapters, strategies, research results or market data ship. Nothing here places an
order, and no agent holds a trading credential.

## Layout

```
CLAUDE.md       the base prompt every agent loads: the Never and Always rules
README.md       this file
LICENSE         MIT
repos.json      the folders the cockpit manages, each with its verify and setup steps
.claude/        the deny list (settings.json) and the skills (board, debrief, run, retro, study)
start.bat       set up when anything is missing, start Postgres and apply migrations, start the cockpit
stop.bat        stop the cockpit, then Postgres
app/            the cockpit (server/, src/), the roster (agents/), the board (board/), the loop
                (loop/), the tools (tools/check.py, tools/context.py), the library (library/)
database/       the data layer: Postgres ops store, Parquet market lake, fund_db (python),
                @fund/db (node), scripts/pg.py (a portable Postgres)
platform/       research/: the chart bank's checkers; lab/example/: a blank lab desk
```

Machine state lives in `~/fund-data/`, never in the repo: the database cluster, the lake and
cache, logs, build worktrees, and the floor (`~/fund-data/floor/STOP` halts everything the
scheduler and the board would start).

## Setup on a new Windows machine

1. **Install**, all on PATH: Git, Python 3.12 or newer, Node.js 23.6 or newer (the board CLI
   runs TypeScript through node's type stripping), and Claude Code signed in to your own
   account. The agents are Claude Code sessions; the cockpit launches them under your login.
2. **Long paths.** Clone to a short path such as `C:\dev\ralph-for-hedge-fund`, or turn on Windows long paths
   (admin PowerShell, then reboot):
   `New-ItemProperty -Path HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force`.
3. **Clone and start:**
   ```
   git clone <this repo> C:\dev\ralph-for-hedge-fund
   cd C:\dev\ralph-for-hedge-fund
   start.bat
   ```
   The first run sets the machine up, then starts everything. Expect several minutes. By hand,
   the same setup is:
   ```
   python -m venv .venv
   .venv\Scripts\python.exe -m pip install -e "database[test]"
   .venv\Scripts\python.exe -m pip install -e platform
   npm install --prefix database\node
   cd app && npm install && cd ..
   .venv\Scripts\python.exe database\scripts\pg.py ensure
   .venv\Scripts\python.exe -m fund_db migrate
   ```
   `pg.py ensure` downloads and initialises a portable Postgres (no admin, 127.0.0.1 only, no
   password). `start.bat --setup` forces the setup step again.
4. **Check:** `.venv\Scripts\python.exe app\tools\check.py --fast` should be green. Start the
   cockpit once before your first commit: fundd installs the commit guard.

You start with no data and no keys. A provider key, if you add one, goes in `.env` at the root
(ignored by git, one `NAME=value` per line): read-only data and model provider keys only, never a
trading credential.

## Running it

- **Start:** `start.bat` starts Postgres, applies pending migrations, then opens one console
  window titled "fund" running fundd, and opens the browser (`--no-open` skips it). Closing that
  window stops the cockpit.
- **Stop:** `stop.bat` stops the cockpit, then Postgres last; `stop.bat --cockpit` stops only the
  cockpit.
- **Develop:** `npm run dev` in `app\` (fundd on :4689 behind vite).
- **Check:** `.venv\Scripts\python.exe app\tools\check.py` (`--fast` skips the live suites).
- **Board from a shell:** `node app\scripts\board.mjs list`, `add "..." --owner <agent>`.

## Where to read next

- `CLAUDE.md`: the rules every agent boots with.
- `app/library/shelf.md`: the documents the owner vets, one line each on what to check.
- `app/library/law/how-we-work.md#who-writes-where`: the roster, write scopes and the six types
  of context. Pull one chapter with `.venv\Scripts\python.exe app\tools\context.py --show <book>#<chapter>`.
- `app/README.md` and `app/CLAUDE.md`: how the cockpit is built.

## License

MIT, see `LICENSE`.
