#!/usr/bin/env node
// board - work the fund board from a shell. Reads and writes app/board/*.md DIRECTLY
// (no fundd needed); fundd watches the folder, so every open cockpit tab sees the change.
// The file format and every rule (numbering, claim refusal, next ordering) are the SAME
// code fundd runs: server/board/store.ts, imported here (node >= 23.6 strips its types).
//
//   node app/scripts/board.mjs list [--owner x] [--status y] [--from x|agents] [--q words] [--all]
//   node app/scripts/board.mjs show B-0007
//   node app/scripts/board.mjs add "title" [--kind build] [--owner platform] [--priority p1] [--body "..."] [--labels a,b] [--status ready] [--blocked-by B-0003,B-0004]
//        TWO KINDS: plain `add` is BACKLOG (it waits); `add ... --owner <another agent> --now` is NOW work: ready + auto,
//        and the board starts that agent on it without the owner's click (never for yourself; blocked_by still holds it).
//        `add --now` also asks fundd for a tick at once (best effort), so the agent starts now, not at the next 10 s timer.
//        Any agent may file and commit an item file (the guard lets app/board/B-NNNN.md through whatever its writes).
//        [--options "id=label;id2=label2*"]   (a question for the owner; status defaults to needs-you)
//   node app/scripts/board.mjs pickup B-0007 [--note "why now"]   (an AGENT asks the item's owner, another agent, to start an EXISTING item now:
//        ready + auto + asked_by + a note, then a tick. Refused: no FUND_AGENT, the item is yours, no agent owner, already doing/done/needs-you.
//        A blocked item is not refused: it waits, and the tick says why)
//   node app/scripts/board.mjs options B-0007 "id=label;id2=label2*"   (or `none` to clear)
//   node app/scripts/board.mjs choose B-0007 <option id> [--note "..."]   (the OWNER only)
//   node app/scripts/board.mjs hand-done B-0007 [--note "..."]   (the owner ran his by-hand choice: tick it, done)
//   node app/scripts/board.mjs next --agent platform
//   node app/scripts/board.mjs claim B-0007 --agent platform
//   node app/scripts/board.mjs note B-0007 "text" [--who platform]
//   node app/scripts/board.mjs move B-0007 review   (review is NOT a parking lane: the loop's next pass sends the item to its owner in a fresh
//        conversation, which closes it (done: a pushed commit that names the item, a green check.py area) or returns it to ready with what is
//        missing. Put the pushed commit's sha in your note. Execution, settings and ownerRail paths go to needs-you instead)
//   node app/scripts/board.mjs assign B-0007 platform
//   node app/scripts/board.mjs block B-0007 B-0003 [B-0004]   (or `none` to clear)
//   node app/scripts/board.mjs archive [--days 14] [--dry-run] [--commit]
//   node app/scripts/board.mjs ceo list | ceo add "title" --told "<the owner's words>" [--agent x] [--priority p1] [--due 2026-10-07] [--body "..."]
//        the OWNER's own board (app/board/ceo/C-NNNN.md, a store the agents' board never reads). An agent files there ONLY when the
//        owner told it to: --told is required and kept on the issue, shown on its card. Plain `add` above never reaches it.
//
// archive: done items whose `updated` is older than --days (default 14) move to <board>/done/,
// where the Board room, `list` and auto-pickup no longer see them (they read <board>/*.md only).
// Three kinds of item stay put, each for a reason the store would otherwise get wrong:
//   - the item holding the HIGHEST number: createItem numbers max(<board>)+1, so while it stays an
//     archived number can never be handed out again;
//   - an item named in blocked_by by an item that stays: openBlockers reads a missing blocker as
//     OPEN, so archiving it would block that item for good;
//   - an item with uncommitted changes (someone is mid-edit), or one already in done/.
// --commit stages exactly the moved paths and `git commit --only`s them (never pulls or pushes;
// the next hand's push carries it); a refused commit puts every file back. Weekly from
// schedule.json (job board-archive). Exit 0 = archived or nothing due, 1 = refused.
//
// OPTIONS (the needs-you contract, library: app/library/the-owner-answers-with-a-click.md): a
// question for the owner carries choosable answers. Spec: options split by `;`, each `id=label`;
// after the label, ` @agent` names who runs it, and the marks `*` (the recommendation), `!` (by
// hand: the owner runs it himself, so the label is the exact command) and `~` (choosing it closes
// the item). `choose` refuses any FUND_AGENT: only the owner answers. The Board room is the same
// choice with a click (and a 10 s undo); a shell choice is attested for auto-pickup once the owner
// commits it with no Agent trailer.
//
// A ready item owned by an agent and labelled `auto` is started by fundd on its own (at most two
// at once, never while <floor>/STOP exists, never while blocked_by names an item not done) when
// ANOTHER agent filed it (now work), or the owner filed or chose it.
//
// Identity: --who / --agent, else env FUND_AGENT, else "you". Board folder: env FUND_BOARD_DIR,
// else <FUND_ROOT or the fund root above app>/app/board (the board moved into the app repo 2026-09-25).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as S from '../server/board/store.ts'
import * as C from '../server/board/ceo.ts'
import { isAgentFileName, parseAgentFile } from '../shared/agentfile.ts'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// <fund>/app -> <fund> (the grandparent only while a checkout still sits at <fund>/repos/app)
const isFund = d => existsSync(join(d, 'repos.json')) || existsSync(join(d, 'agents.json'))   // the fund root carries repos.json
const fundAbove = app => (!isFund(resolve(app, '..')) && isFund(resolve(app, '..', '..'))) ? resolve(app, '..', '..') : resolve(app, '..')
const FUND = process.env.FUND_ROOT ? resolve(process.env.FUND_ROOT) : fundAbove(APP)
const DIR = process.env.FUND_BOARD_DIR ? resolve(process.env.FUND_BOARD_DIR) : join(FUND, 'app', 'board')
const ME = process.env.FUND_AGENT || 'you'

function args(argv) {
  const pos = [], opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) opt[k] = true
      else { opt[k] = v; i++ }
    } else pos.push(a)
  }
  if (opt.agent !== undefined && opt.who === undefined) opt.who = opt.agent
  // an agent signs as itself: "from: you" is what lets board auto-pickup start a conversation
  // (server/board/auto.ts), so an agent may never file or note as the owner, or as another agent
  if (process.env.FUND_AGENT && opt.who !== undefined && opt.who !== process.env.FUND_AGENT) {
    throw new S.BoardError(403, `you are ${process.env.FUND_AGENT}: --who ${opt.who} is refused (an agent signs as itself)`)
  }
  return { pos, opt }
}

const age = iso => {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '-'
  const s = Math.max(0, (Date.now() - t) / 1000)
  return s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}
const line = i => `${i.id}  ${i.status.padEnd(9)} ${i.priority} ${i.kind.padEnd(11)} ${(i.owner || '-').padEnd(13)} ${age(i.created).padStart(4)}  ${i.title}`
/** one option as a line: `* rec`, `! by hand`, `~ closes`, `> chosen` */
const optLine = (o, chosen) => `  ${o.id === chosen ? '>' : ' '} ${o.id.padEnd(10)} ${o.label}${o.owner ? `  @${o.owner}` : ''}${[o.rec && ' *rec', o.hand && ' !hand', S.closes(o) && ' ~closes'].filter(Boolean).join('')}`
/** the roster: every <fund>/app/agents/<id>.md header (a file that does not parse is skipped) */
const agents = () => {
  const dir = join(FUND, 'app', 'agents')
  let names = []
  try { names = readdirSync(dir).filter(isAgentFileName) } catch { return [] }
  return names.flatMap(n => { try { return [parseAgentFile(readFileSync(join(dir, n), 'utf8')).header] } catch { return [] } })
}
const needId = id => { if (!id || !S.ID_RE.test(id)) throw new S.BoardError(400, `give a board id like B-0007 (got ${id ?? 'nothing'})`); return id }

// ---------- archive ----------

const DAY_MS = 86_400_000
const num = id => Number(id.slice(2))
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const repoTop = dir => { try { return resolve(git(dir, ['rev-parse', '--show-toplevel']).trim()) } catch { return null } }
const posix = p => p.split('\\').join('/')

/** a merge / rebase / cherry-pick / revert in progress: never commit into the middle of one */
function midOp(top) {
  const gd = resolve(top, git(top, ['rev-parse', '--git-dir']).trim())
  for (const [f, what] of [['MERGE_HEAD', 'a merge'], ['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']]) {
    if (existsSync(join(gd, f))) return `the repo is in the middle of ${what}`
  }
  return null
}

/** a rename that survives a watcher or an indexer holding the file for a moment (Windows) */
function move(src, dst) {
  for (let i = 0; ; i++) {
    try { renameSync(src, dst); return } catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e
      const until = Date.now() + 25 * (i + 1)
      while (Date.now() < until) { /* short spin */ }
    }
  }
}

/**
 * Which done items may leave <board>/ now: the pure half of `archive`, so the rules are the rules
 * whatever the caller does with the answer. `dirty` names ids with uncommitted changes.
 */
function archivePlan(items, { now = Date.now(), days = 14, dirty = new Set(), inDone = new Set() } = {}) {
  const cutoff = now - days * DAY_MS
  const top = items.reduce((m, i) => Math.max(m, num(i.id)), 0)
  const skip = new Map()
  const cand = new Set()
  for (const i of items) {
    if (i.status !== 'done') continue
    const t = Date.parse(i.updated)
    if (!Number.isFinite(t)) { skip.set(i.id, `updated "${i.updated}" is not a date`); continue }
    if (t >= cutoff) continue
    if (num(i.id) === top) skip.set(i.id, 'holds the highest number (the next id is max+1 of the board folder)')
    else if (inDone.has(i.id)) skip.set(i.id, 'a file of that id is already in done/')
    else if (dirty.has(i.id)) skip.set(i.id, 'has uncommitted changes')
    else cand.add(i.id)
  }
  // an item that stays and names a candidate in blocked_by keeps it here; repeat until stable,
  // because a candidate kept back now stays and may itself name another candidate
  for (let changed = true; changed;) {
    changed = false
    for (const i of items) {
      if (cand.has(i.id)) continue
      for (const b of i.blocked_by ?? []) {
        if (!cand.has(b)) continue
        cand.delete(b)
        skip.set(b, `named in blocked_by of ${i.id}, which stays`)
        changed = true
      }
    }
  }
  return { move: items.filter(i => cand.has(i.id)), skip }
}

/**
 * NOW work starts at once: ask fundd for a tick instead of waiting out its 10 s timer. Best effort: fundd
 * down, Manual, STOP or a cap only means the item waits for the next tick (the file is already the claim).
 * FUNDD_PORT is in an agent's env (the launch contract); by hand it is the dev port.
 */
async function kick(id) {
  const port = Number(process.env.FUNDD_PORT || 4689)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/board/auto/tick`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return console.log(`${id} waits for the board's next tick (${j?.error ?? j?.message ?? `fundd answered ${r.status}`})`)
    const res = j?.result
    const held = res?.askedHeld?.[id] ?? res?.held     // what holds THIS item, else what held the tick
    console.log(res?.picked?.includes(id) ? `${id} picked up: the agent is starting now`
      : `${id} waits for the board's next tick${held ? ` (held: ${held})` : ''}`)
  } catch { console.log(`${id} waits for the board's next tick (fundd on :${port} did not answer)`) }
}

const cmds = {
  ceo({ pos, opt }) {
    const dir = join(DIR, 'ceo')
    if (pos[0] === 'list') {
      const items = C.listCeo(dir).filter(i => opt.all || i.status !== 'done')
      return console.log(items.length ? items.map(i => `${i.id}  ${i.status.padEnd(4)} ${i.priority} ${(i.agent || '-').padEnd(13)} ${(i.due || '-').padEnd(10)}  ${i.title}`).join('\n') : 'nothing')
    }
    if (pos[0] !== 'add' || !pos[1]) throw new S.BoardError(2, 'ceo list | ceo add "title" --told "<the owner words>" [--agent x] [--priority p1] [--due YYYY-MM-DD]')
    // the owner's own shell has no FUND_AGENT; an agent needs the owner's words
    const who = C.ceoFiler({ fromCockpit: !process.env.FUND_AGENT, asAgent: process.env.FUND_AGENT, told: opt.told })
    const agent = opt.agent === undefined || opt.agent === true ? '' : String(opt.agent)
    if (agent && !agents().some(a => a.id === agent)) throw new S.BoardError(400, `no agent ${agent} in the roster`)
    const i = C.createCeo(dir, { title: pos[1], priority: opt.priority, due: opt.due, agent, body: typeof opt.body === 'string' ? opt.body : '', from: who.from, told: who.told })
    console.log(`${i.id} filed on the owner's board${who.told ? ` (told: ${who.told})` : ''}: ${i.title}`)
  },
  list({ opt }) {
    let items = S.filterItems(S.listItems(DIR), { status: opt.status ?? null, owner: opt.owner === 'none' ? '-' : opt.owner ?? null, from: opt.from ?? null, q: opt.q ?? null })
    if (!opt.all && !opt.status) items = items.filter(i => i.status !== 'done')
    items.sort(S.byPriorityThenAge)
    if (!items.length) return console.log('nothing')
    for (const i of items) console.log(line(i))
  },
  show({ pos }) {
    const i = S.readAnyItem(DIR, needId(pos[0]))   // an archived item still opens by id (read-only)
    console.log(line(i))
    if (i.labels.length) console.log(`labels: ${i.labels.join(', ')}  from: ${i.from}`)
    if (i.blocked_by?.length) { const open = S.openBlockers(i, S.listAllItems(DIR)); console.log(`blocked_by: ${i.blocked_by.join(', ')}${open.length ? `  (open: ${open.join(', ')})` : '  (all done)'}`) }
    if (i.conversation) console.log(`conversation: ${i.conversation}`)
    if (i.options?.length) { console.log('options:'); for (const o of i.options) console.log(optLine(o, i.chosen)) }
    else if (i.status === 'needs-you') console.log(`options: none of its own (the owner sees ${S.DEFAULT_OPTIONS.map(o => o.label).join(' / ')})`)
    console.log('')
    console.log(i.body || '(no body)')
  },
  add({ pos, opt }) {
    // NOW work (the owner, 2026-09-27): --now files it ready + auto for ANOTHER agent, which the board
    // then starts without the owner's click (server/board/auto.ts). Without --now an item is backlog.
    if (opt.now) {
      const who = opt.who ?? ME
      const owner = opt.owner === true ? '' : opt.owner
      if (!owner || !agents().some(a => a.id === owner)) throw new S.BoardError(400, `--now needs --owner <an agent on the roster> (got ${owner || 'nothing'})`)
      if (owner === who) throw new S.BoardError(400, `--now is for ANOTHER agent: ${who} does its own work in its own conversation, never by starting itself`)
      if (opt.options !== undefined) throw new S.BoardError(400, '--now and --options do not mix: now work starts at once, a question waits for the owner')
      opt.status = 'ready'
      opt.labels = [...new Set([...(opt.labels ? String(opt.labels).split(',') : []), S.AUTO_LABEL])].join(',')
    }
    S.requireOptions({ status: opt.options !== undefined ? opt.status ?? 'needs-you' : opt.status, from: opt.who ?? ME, options: opt.options === true ? '' : opt.options })
    const i = S.createItem(DIR, {
      title: pos.join(' '), kind: opt.kind, owner: opt.owner === true ? '' : opt.owner, priority: opt.priority,
      body: opt.body === true ? '' : opt.body, labels: opt.labels ? String(opt.labels).split(',') : [], status: opt.status, from: opt.who ?? ME,
      blocked_by: opt['blocked-by'] && opt['blocked-by'] !== true ? String(opt['blocked-by']).split(',') : [],
      ...(opt.options !== undefined ? { options: S.cleanOptions(opt.options === true ? '' : String(opt.options)), status: opt.status ?? 'needs-you' } : {}),
    })
    console.log(line(i))
    for (const o of i.options ?? []) console.log(optLine(o))
    if (opt.now) return kick(i.id)
  },
  // An agent asks another agent to start an EXISTING item now (the owner, 2026-10-04): ready + auto + asked_by,
  // then a tick. `add --now` is the same for a NEW item. Refusals are in S.pickupItem.
  async pickup({ pos, opt }) {
    const roster = agents().map(a => a.id)
    const i = S.pickupItem(DIR, needId(pos[0]), opt.who ?? ME, opt.note === true ? '' : opt.note ?? '', roster.length ? roster : null)
    console.log(line(i))
    return kick(i.id)
  },
  'hand-done'({ pos, opt }) {
    if (process.env.FUND_AGENT) throw new S.BoardError(403, `you are ${process.env.FUND_AGENT}: only the owner ticks his own by-hand step`)
    console.log(line(S.handDone(DIR, needId(pos[0]), opt.note === true ? '' : opt.note ?? '')))
  },
  options({ pos }) {
    const spec = pos.slice(1).join(' ')
    if (!spec) throw new S.BoardError(400, 'give the options: "id=label;id2=label2*" (or none)')
    const { item } = S.updateItem(DIR, needId(pos[0]), { options: spec === 'none' ? [] : spec })
    console.log(line(item))
    for (const o of item.options ?? []) console.log(optLine(o))
  },
  choose({ pos, opt }) {
    if (process.env.FUND_AGENT) throw new S.BoardError(403, `you are ${process.env.FUND_AGENT}: only the owner chooses (an agent files the options, the owner picks)`)
    const id = needId(pos[0])
    if (!pos[1]) { const i = S.readItem(DIR, id); throw new S.BoardError(400, `give an option: ${S.offered(i).map(o => o.id).join(' | ')}`) }
    const c = S.chooseItem(DIR, id, pos[1], opt.note === true ? '' : opt.note ?? '')
    console.log(line(c.item))
    console.log(c.outcome === 'hand' ? `chose ${c.option.id}: run it yourself, then: board.mjs hand-done ${id}\n  ${c.option.label}`
      : c.outcome === 'done' ? `chose ${c.option.id}: closed`
      : `chose ${c.option.id}: ready for ${c.item.owner || 'unassigned'}${c.item.labels.includes(S.AUTO_LABEL) ? ' (auto: fundd picks it up once the choice is attested - commit it with no Agent trailer)' : ''}`)
  },
  next({ opt }) {
    const agent = opt.agent ?? ME
    const ranked = S.rankNext(S.listAllItems(DIR), agent, agents())
    if (!ranked.length) return console.log(`nothing ready for ${agent}`)
    console.log(line(ranked[0]))
  },
  claim({ pos, opt }) { console.log(line(S.claimItem(DIR, needId(pos[0]), opt.agent ?? ME))) },
  note({ pos, opt }) {
    const text = pos.slice(1).join(' ')
    S.appendNote(DIR, needId(pos[0]), opt.who ?? ME, text)
    console.log(`${pos[0]}  note by ${opt.who ?? ME}`)
  },
  move({ pos }) {
    const { item } = S.updateItem(DIR, needId(pos[0]), { status: pos[1] })
    console.log(line(item))
  },
  assign({ pos }) {
    const { item } = S.updateItem(DIR, needId(pos[0]), { owner: pos[1] === 'none' ? '' : pos[1] ?? '' })
    console.log(line(item))
  },
  block({ pos }) {
    const ids = pos.slice(1)
    const { item } = S.updateItem(DIR, needId(pos[0]), { blocked_by: ids.length === 1 && ids[0] === 'none' ? [] : ids })
    console.log(`${line(item)}
  blocked_by: ${(item.blocked_by ?? []).join(', ') || 'none'}`)
  },
  archive({ opt }) {
    const days = opt.days === undefined ? 14 : Number(opt.days)
    if (opt.days === true || !Number.isFinite(days) || days < 0) throw new S.BoardError(400, `--days takes a number of days >= 0 (got ${opt.days})`)
    const dry = opt['dry-run'] === true, commit = opt.commit === true
    const DONE = join(DIR, 'done')
    const items = S.listItems(DIR)
    const top = repoTop(DIR)
    if (commit && !top) throw new S.BoardError(400, `--commit: ${DIR} is not inside a git repo`)
    if (commit && !dry) { const bad = midOp(top); if (bad) throw new S.BoardError(409, `--commit refused: ${bad}`) }
    const rel = f => posix(relative(top, f))
    // uncommitted = anything git reports for the file (modified, staged, untracked)
    const dirty = new Set()
    if (top) {
      const fold = s => (process.platform === 'win32' ? s.toLowerCase() : s)
      const base = rel(DIR)
      const recs = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', base || '.']).split('\0')
      const paths = []
      for (let k = 0; k < recs.length; k++) {
        const r = recs[k]
        if (r.length < 4) continue
        paths.push(r.slice(3))
        if (/[RC]/.test(r.slice(0, 2))) paths.push(recs[++k] ?? '')   // a rename's source follows it
      }
      for (const p of paths) {
        const m = /^(?:(.*)\/)?(B-\d{4,})\.md$/.exec(p)
        if (m && fold(m[1] ?? '') === fold(base)) dirty.add(m[2])
      }
    }
    const inDone = new Set(items.filter(i => existsSync(join(DONE, `${i.id}.md`))).map(i => i.id))
    const { move: due, skip } = archivePlan(items, { days, dirty, inDone })
    for (const [id, why] of skip) console.log(`kept ${id}: ${why}`)
    const summary = `${due.length} done item${due.length === 1 ? '' : 's'} older than ${days}d${dry ? ' due' : ' archived'} to done/${skip.size ? `, ${skip.size} kept` : ''}`
    if (!due.length) return console.log(`nothing to archive: ${summary}`)
    for (const i of due) console.log(`${dry ? 'would move' : 'move'} ${i.id}  done ${i.updated.slice(0, 10)}  ${i.title}`)
    if (dry) return console.log(summary)
    mkdirSync(DONE, { recursive: true })
    const moved = []
    const putBack = () => { for (const [src, dst] of moved.reverse()) { try { move(dst, src) } catch (e) { console.error(`could not put ${dst} back: ${e.message}`) } } }
    try {
      for (const i of due) { const src = S.itemPath(DIR, i.id), dst = join(DONE, `${i.id}.md`); move(src, dst); moved.push([src, dst]) }
    } catch (e) { putBack(); throw e }
    if (commit) {
      const paths = moved.flatMap(([src, dst]) => [rel(src), rel(dst)])
      const agent = process.env.FUND_AGENT || (process.env.FUND_JOB_TRIGGER ? 'fund' : '')
      const body = [
        ...due.map(i => `- ${i.id} (done ${i.updated.slice(0, 10)}): ${i.title.slice(0, 100)}`),
        '',
        ...(agent ? [`Agent: ${agent}`] : []),
        `Board-Archive: ${days}d`,
      ].join('\n')
      try {
        git(top, ['add', '--', ...paths])
        git(top, ['commit', '--only', '-m', `board: archive ${due.length} done item${due.length === 1 ? '' : 's'} older than ${days}d to board/done/`, '-m', body, '--', ...paths])
      } catch (e) {
        try { git(top, ['restore', '--staged', '--', ...paths]) } catch { /* nothing staged */ }
        putBack()
        throw new S.BoardError(409, `commit refused, every file put back: ${String(e.stderr || e.message).trim().split('\n').slice(-3).join(' | ')}`)
      }
      console.log(`committed ${git(top, ['rev-parse', '--short', 'HEAD']).trim()}`)
    }
    console.log(summary)
  },
}

const [cmd, ...rest] = process.argv.slice(2)
if (!cmd || !cmds[cmd]) {
  console.log('board list|show|add|pickup|options|choose|hand-done|next|claim|note|move|assign|block|archive|ceo  (see the header of scripts/board.mjs)')
  process.exit(cmd ? 2 : 0)
}
try { await cmds[cmd](args(rest)) } catch (e) {
  console.error(`board ${cmd}: ${e.message}`)
  process.exit(e instanceof S.BoardError ? 1 : 3)
}
