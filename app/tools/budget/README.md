# `app/tools/budget` - model tiers and per-agent token budgets

The moment an unattended loop can spend without a ceiling, a bug in a cadence becomes a bill.
`usage.py` is the **meter**; `check.py` is the **gate**. They are two objects on purpose: a meter
that refuses is a meter people route around, and a gate nobody's exit code depends on is
decoration.

Run with the code repo's interpreter:
`.venv\Scripts\python.exe tools\budget\usage.py` (from the fund root)

## Where the numbers come from

Claude Code writes one JSONL per session under `%USERPROFILE%\.claude\projects\<slugged
cwd>\<session>.jsonl`. Every assistant row carries `cwd`, `timestamp`, `message.model` and
`message.usage`. That is the only first-hand record of what was spent; everything else is an
estimate, and this tool reads the first-hand one. `$CLAUDE_PROJECTS_DIR` overrides the location
(the tests use it).

**Attribution is by `cwd`, and that is a choice with a consequence worth stating.** Every agent
in the roster (`app/agents/<id>.md`, one file each) boots in its own `cwd` - that is what gives it
its CLAUDE.md chain - so cwd -> agent is a real mapping, longest cwd winning. A hand working from
the fund root is attributed to the agent whose cwd is `.`. Agents that SHARE a cwd cannot be told
apart from a transcript, so they become ONE seat whose id joins theirs with `+` (two agents
`dash:a` and `dash:b` in one folder are the seat `dash:a+dash:b`), never split by guess. A
**sidechain** (a subagent) is
attributed to the cwd it inherited AND counted separately, so an agent cannot hide spend behind a
subagent.

Sessions whose cwd is outside `C:\dev\fund` are ignored entirely.

## The metric is named, never implied

Four counters exist and they are **not** interchangeable:

| Counter | What it is |
|---|---|
| `input_tokens` | fresh input |
| `cache_creation_input_tokens` | written to the prompt cache - full price |
| `cache_read_input_tokens` | served from the cache - roughly a tenth |
| `output_tokens` | generated |

| `--metric` | Sums |
|---|---|
| `billable` (default) | input + cache creation + output - the tokens processed at full rate |
| `all` | the above plus cache reads |
| `output` | output alone |

A budget quoted without its metric is the same class of error as an annualized rate quoted
without its cadence, so both tools print the metric with every number and carry it in the JSON.

## The ceiling

The roster's, and only its: `budgetTokensPerDay` in the agent's roster file header
(`app/agents/<id>.md`). The code still honours a top-level `defaults.budgetTokensPerDay`, but the
per-file roster has no top level to put one in. **An agent with no ceiling has none, and `check.py`
says so out loud rather than inventing one** - an invented budget is the same class of error as an
invented fee. Read 2026-09-25: no roster file carries a budget field (the `org.json` default of
1,500,000 retired with that file on 2026-09-24), so every agent reads NO ceiling until one is added
to its header.

The day boundary is the owner's local day, matching `schedule.json`'s local-time cadences.

## The tiering policy this meter enforces

Each roster file header declares a `model` per agent. The policy behind those declarations:

| Tier | Seats | Why |
|---|---|---|
| **Haiku** | mechanical probes, digests, staleness sweeps, any scheduled job with no judgment in it | the work is parsing a number out of a known shape and writing a row. Judgment is not involved, so paying for it is waste |
| **Sonnet** | the venue desks and the app desks - adapters, fixtures, routes, UI | bounded, well-specified work against a documented API, with a verify suite to catch it |
| **Opus** | quant, research, retros, and law (the CEO/CTO seats) | anything that moves a belief, sets a next bet, writes a rule, or decides what a number means. These are the calls a cheaper model gets confidently wrong, and the cost of being wrong is a belief nobody re-examines |

`usage.py` reports **tier drift**: a seat declaring one tier and observed running another. That
is information, not an alarm - a hand can deliberately open an Opus session at a Sonnet desk -
but a *scheduled* job drifting is a defect in the job's `model` field.

## Exit codes

| Tool | 0 | 1 | 2 |
|---|---|---|---|
| `usage.py` | always | - | - |
| `check.py <agent>` | under budget, or no ceiling set | **OVER** - do not start an unattended run | the check could not run (no transcripts, no such seat) |

A `2` from `check.py` is **not** a licence to run: the caller decides, but it must decide
knowingly, which is why it is not `0`.

## Health row

`usage.py` records its reading `system:budget` in the ops store (ops.health_readings, through fund_db; formerly `<floor>/health/budget.json`, the floor `$FUND_FLOOR`, default
`~/fund-data/floor`; suppress with `--no-health`) in the same shape as
every probe row, so spend appears on the cockpit's Health wall beside everything else, with
`status: "fail"` when a seat is over its ceiling today.

## Use

```
python app/tools/budget/usage.py                 # today, per agent
python app/tools/budget/usage.py --days 7        # a week, per agent per day
python app/tools/budget/usage.py --metric all    # include cache reads
python app/tools/budget/check.py carry           # before an unattended run
python app/tools/budget/check.py carry --reserve 200000   # require headroom for the run ahead
```

The cockpit's scheduler should call `check.py <agent id>` before starting any `kind: "agent"` job,
and skip the occurrence (logging `skipped`, with the reason) on exit 1.

## The schedule

Both jobs are in `schedule.json`: `budget` (every 6h, `"health": false` because
`usage.py` records its `system:budget` reading itself, so the scheduler must not overwrite it) and
`budget-week` (weekly, `--no-health`, so it takes the scheduler's row instead).
