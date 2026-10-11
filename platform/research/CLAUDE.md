# research - workspace rules

`platform/research`: Jupyter notebooks only, written by the `research` agent. A notebook orchestrates
and draws; every fetcher, metric and engine lives in `fundplat/` (a board item for `platform`) and
is imported as `fundplat.*` or `fund_db`. Kernel `ccvenv` (the fund `.venv`); never a `sys.path`
cell. Reads go through a `fundplat.data` loader and are pinned in the manifest
(`app/library/research/research.md#input-pins`). The platform's law binds every number shown.

## Layout

- `studies/<stem>.ipynb` is a study; `<stem>.build.py` is its committed generator;
  `studies/_template-study.ipynb` is where every new study starts. `SUMMARY.md` lists each study
  with its window. A figure imports
  `fundplat.quant.core.figstyle` and draws its card with `summary_card` (same package).
- `archive/<stem>.ipynb` is a superseded or draft study: kept with its generator, never rebuilt, not
  shown in the room by default; moved there only on the owner's word. Its labels.json entry moves to
  `archive/labels-archived.json`; its ledger rows stand and a `removed` entry in the desk's
  `renames.json` makes a due re-read record a miss.
- **A study is done when the Research room shows it** (`research.md#a-study-is-done-when-the-research-room-shows-it`):
  the notebook is in `studies/`, passes `tools/nbstructure.py` and `check_labels.py`, and carries
  its labels. Temp boards are drafts.
- **Nine sections**, `## S0 · Summary` to `## S7 · Verdict`, plus an optional `## A · Appendix`.
  One `parameters` cell, figure cells tagged `fig:s<n>-<name>`, gates as one `GATES` list, no typed
  numbers in prose, a last cell emitting one `fund.study/1` manifest. An older notebook moves into
  the layout at its next re-run, never by a hand edit of kept outputs. Book: `research.md#nine-sections-four-kinds`.
- **Four kinds** set S3 and S6: strategy, market, event, venue.
- **Two labels and two tags** (the owner, 2026-09-28; tags 2026-10-05): Market (one or more of crypto, equities, rates,
  predmkts, main first) and Format (one of carry, directional, short_vol, rel_value, evidence; what the study is paid
  for), plus style (systematic or discretionary, typed) and pace (intraday, swing, hold; read by `report.pace_of`,
  never typed). The manifest wins and must agree with `labels.json`, which may hold `style` until a re-run.
  Book: `research.md#manifest-and-labels`.
- **Held by** `tools/nbstructure.py`, `check_labels.py` and `check_charts.py` (the chart bank,
  `charts.md` and its `charts-*.md` books; a figure's `kind` is its chapter slug), each with `--selftest`, run by
  `tools/lint.py`. A figure carries its window, regime and `verify()` count. Trim large outputs.

## Naming

`<YYYY-MM-DD>-<market>-<subject>[-<variant>]`: the date of the first run, fixed for life; market
one of crypto, rates, predmkts, equities, vol, xasset; no status, no run id. Studies that build one
strategy share one stem, e.g. `2026-09-27-xasset-sofr-hike-tail-{put-bill,hedge-polymarket}`. A
name changes only on the owner's word (`research.md#naming`).

## Commits

Stage from inside the folder with explicit paths: `cd research`, then `git add studies/<file>.ipynb`. When
other hands' files sit in the shared index, commit with `git commit --only -- <paths>`. Main only.
Update `SUMMARY.md` when a notebook is added, removed or renamed, then tell `platform` to run
`tools\hq_sync.py`. Ledgers: `platform/lab/{research,predmkts,vol}/`. JupyterLab: the `jupyter` tool (:8890).
