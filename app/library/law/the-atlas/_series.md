---
title: The Atlas
---

# The Atlas - the Map room's config

Two files the cockpit's Map room reads and paints red when a path they name is gone. The drawn
graphs that used to live here were retired with the context plan: the Map room draws what
exists, generated on every read.

| File | Read when |
|---|---|
| `pipeline.json` | about to add, rename or restate a trading-pipeline stage, or to claim a stage is built |
| `data-flow.json` | about to add, rename or restate a box in the data flow (a source, a store, a consumer), or to change what is kept and where; keep it in step with `app/library/law/how-we-guard.md#data-the-four-classes` |
