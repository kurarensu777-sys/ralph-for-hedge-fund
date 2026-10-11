---
title: The Annals
---

# The Annals - the fund's eras

One book per era, in order. Each carries `from` / `to` in its frontmatter (`to: open` for the
era we are in), and the Git room's Eras band reads exactly that: it maps the dates to commit
ranges in each repo and never infers an era from commits. An era is WRITTEN, by the `fund`
agent, when a turning point lands.

Rules: dates are commit dates as `git log` prints them; days never overlap; one era is open at a
time; a chapter carries the turning points and their WHY, not a changelog (that is `git log`).

| Book | Read when |
|---|---|
| `00-the-crypto-repo.md` | asking why the platform code was layered dashboards -> quant -> data, or reading a commit dated before 2026-09-21 |
| `01-the-harness.md` | reading anything retired at the cut-over (desks, issues, the fund CLI, audit.py, floor ticks), or asking why the deny list is the whole gate |
| `02-the-cut-over.md` | asking why the tree is spine / library / lab / board / repos, or following a path that moved on 2026-09-24 |
| `03-the-rounds.md` | planning an improvement round, or reading a commit dated 2026-09-25 to 2026-10-03 |
| `04-on-demand-data.md` | asking why market data is pulled on demand and almost nothing is kept, or about to close the open era because a new turning point landed |
