---
title: The crypto repo
from: 2026-08-10
to: 2026-09-20
topics: [history]
---

# The crypto repo (00, 2026-08-10 .. 2026-09-20)

Before the fund there was one code base, `crypto/`, built for funding-rate research. Everything
the platform is today started here.

| Day | Turning point | Why |
|---|---|---|
| 2026-08-10 | baseline snapshot, then `api/data` · `api/lib` · `app` · `research` | one-way dependency law: only `api/data` touches a venue, engines stay pure and verifiable |
| 2026-08-10 | split into per-package repos, each with an owner agent | one owner per folder; HQ.md generated from each SUMMARY.md |
| 2026-08-12 | a broker stock-leg scaffold, `ARMED=False` | a perp hedge needed a stock leg; paper first, a human arms |
| 2026-09-14 | back to ONE repo, five packages | pointer bumps and gitlinks cost more than they protected |
| 2026-09-14..16 | the first carry engine and a screener; basis arb retired | the trade had to be priced two-legged, net of the hedge's own costs |

Next: `01-the-harness.md`.
