# app

The cockpit: the one app the owner uses to run the fund. It serves the roster (`agents/`), the board
(`board/`), the loop (`loop/`), the library (`library/`), the tools and the scheduled jobs. How this
folder works is in [CLAUDE.md](CLAUDE.md).

`app/` is a folder of the fund repo, beside `database/` (the data layer) and `platform/` (research
checks and the lab desks). Setup steps for a new machine are in the root [README](../README.md).

```
npm install
npm run dev        # fundd (daemon :4689) + vite (UI :4688)
npm run verify     # typecheck + the whole suite
```
