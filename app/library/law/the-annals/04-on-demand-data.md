---
title: On-demand data
from: 2026-10-04
to: open
topics: [history]
---

# On-demand data (04, 2026-10-04 .. open)

Market data is pulled when a question needs it, stored by class, and kept only when it earns it.
The store-first write-through that fed every earlier era is retired.

| Date | Turning point | Why |
|---|---|---|
| 2026-09-28 | the owner approved the on-demand data plan ("pull on demand, keep almost nothing") with one change: archive a series only if a backtest needs it and the venue will not serve it again | the owner's rule: "if next time we backtest and can't get the historical funding, then we should store; otherwise no" |
| 2026-10-03 | the on-demand contract closed: storage classes, handles, one pacer, a market-data MCP and ordered gates are the contract; every doc that described the old store-first behaviour was updated | the item's acceptance: `check.py` green across every repo, `fund_db doctor` green, the cockpit rooms reading the new shapes |

Close this era (set `to`, open `05-...`) only when a turning point changes how the fund works, not
when a round ends. Read the shelf for the contract itself: `app/library/law/how-we-guard.md#data-the-four-classes`.
