# The shelf - the owner's vet list

Humans VET, they do not study. Every doc below is this fund's RECORDING of the owner's judgement,
and a wrong recording steers everything silently; each row names the ONE thing to check on a read.
Everything below this shelf is agent-managed.

The loop that makes a vet count: read the doc, check what its line names, say what is wrong in
any conversation - and the receiving hand writes the correction into THAT file in the same
sitting. A vet with no write-back is just browsing.

**The cap is ten, and the cap is law.** The `fund` agent curates WHAT stands here; the owner vets
what the docs SAY. An eleventh entry does not get added; something comes off first.

| Doc | The vet |
|---|---|
| **The Base Prompt** - `CLAUDE.md` | **LAW** · what binds every agent at every boot: the Never list, the ten Always rules, the Writing rules and, at the top, the Global Ethic rule. Always 1 is the sharpest: an agent writes only inside its `writes` in the roster (`app/agents/`), and an ask outside them becomes a board item rather than work. Still what you want? Does the Writing section sound like how you want every agent to write? |
| **The Numbers Rule** - `CLAUDE.md` Always 2 | **LAW** · real published values only, dated, `[V]`/`[1]`/`[U]`/`[API]`, never rounded in our favour. This is the single line that most changes what every agent writes. Would you sign it as-is, including "when the honest number is ugly, the ugly number ships"? |
| **The Evidence Bar** - `app/library/law/how-we-know.md` (chapter: A shared window is one result) | **LAW** · the bar between one backtest window and a new rule - above all "two runs on the same window are ONE result". Is this how much evidence you want before a number becomes doctrine? Too strict and nothing ever gets decided; too loose and one good quarter steers the fund |
| **What a Result Is Allowed to Teach** - `app/library/law/how-we-know.md` (chapter: Lottery and craft) | **STRATEGY** · total P&L is the lottery, the decomposed components are the craft, and the mirror run says which you are looking at. Is that the verdict you want on a trade whose total is mostly a premium that moved your way? |
| **The Data Rule** - `app/library/law/how-we-guard.md` (chapter: Data: the four classes) | **LAW** · pull on demand, keep almost nothing: archive a series only if a backtest needs it and the venue will not serve it again. Is that still the line between what we keep and what we re-pull? |
| **The Loop** - `app/library/law/the-lab-loop.md` (chapter: The loop in commands) | **MACHINE** · the spine a desk runs, including pre-registration before any engine runs and the one-in-four WILD floor. Is this how a run should decide? |
| **The Roster** - `app/agents/` | **IDENTITY** · five standing agents: `fund`, `app`, `database`, `platform`, `research`. Each file's `writes` is its whole write scope, its body is a two-line prompt, and its `boot` list names a few book chapters. What an agent loads at boot is the base prompt, its folder's `CLAUDE.md`, those two lines and those chapters, measured by `app/tools/context.py`. Is each agent allowed to write exactly what you want, and does each boot on the right chapters? |
| **The Permissions** - `.claude/settings.json` | **LAW** · `defaultMode: bypassPermissions` (armed by you), so the DENY list is the whole gate: force-push and history rewrites, `reset --hard`, `clean -f`, `git add -A`, `git stash`, reading `.env` or key material, arming execution, skipping hooks, staging `database/`, `app/`, `platform/` or `execution/` from the root, deleting under `fund-data`, dropping a database, a broker gateway's install folder and a data session file. Branches and worktrees are allowed for the cockpit's build branches only. Anything missing from the deny list you would want refused? |
| **The Writing** - `app/library/law/how-we-write.md` | **LAW** · how every agent writes what you read: the answer first, plain words, no staging, no captions under names. Does a board item or a reply read the way you want? |
| **The Board** - `app/board/` | **PRIORITY** · the open work, one file each, p0 first. Is that your order? |

Ten of ten used. An eleventh does not get added; something comes off first.

**What is deliberately NOT on this shelf:** the doors table (`app/library/law/how-we-work.md#the-doors-and-their-keys`),
the other config files (`repos.json`, `schedule.json`: derived from decisions made above), and every PRE-LIVE desk's lab ledger
(empty on purpose - there is nothing there to vet yet, and putting it here would spend one of
your ten on a blank page).
