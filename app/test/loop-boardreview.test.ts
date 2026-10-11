import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '../shared/types.ts'
import { createItem, readItem, splitBody, updateItem } from '../server/board/store.ts'
import type { Scope } from '../server/loop/commitcheck.ts'
import { type BoardCtx, boardDirOf, boardPass, closedBy, cycleOf, ownerOnlyPath, reportBoard, reviewRows, sendBoard, settledChecks, stateOf } from '../server/loop/boardreview.ts'
import { DEFAULTS } from '../server/loop/config.ts'
import { MAX_SENDS, STALE_MS } from '../server/loop/dispatch.ts'
import { type Ctx, pass } from '../server/loop/engine.ts'
import * as M from '../server/loop/metrics.ts'
import { db, ops } from '../server/db.ts'
import { resetStore } from './pg/reset.ts'

// The loop reviews board items (B-0639): an item in review is sent, in a fresh conversation, to the
// agent that owns it; done needs a pushed commit that names the item and clean files in it (B-0646: the commit's own, not the whole area); a dormant or
// missing owner, or owner-only ground, leaves it for the owner. On a TEMP repo with a bare remote and
// this file's own database; the agent runner and check.py are stubs.

const T0 = Date.parse('2026-10-07T12:00:00Z')

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: id, kind: 'standing', mode: 'active', dept: 'Build', role: 'r', cwd: '.', writes: [], model: 'sonnet', effort: 'low', boot: [], ...extra,
})
const AGENTS: Agent[] = [
  agent('app', { writes: ['app/'] }),
  agent('platform', { writes: ['platform/'] }),
  agent('old', { writes: ['app/old/'], mode: 'dormant' }),
  agent('execution', { writes: ['execution/'] }),
]

let dir: string
let remote: string
let clockAt = T0
let started: { agent: string; prompt: string; title: string }[] = []
let checks: string[] = []           // the areas the SECOND signal (the whole-area run) was asked for
let scopes: Scope[] = []            // the commits the verdict was asked for
let checkOk = true                  // the verdict on the commit's own files
let areaRed: string | null = null   // the whole-area run's red output, or null = green

const sh = (args: string[], cwd = dir) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

function bctx(extra: Partial<BoardCtx> = {}): BoardCtx {
  return {
    db, fundRoot: dir, agents: AGENTS, repos: [{ id: 'app', path: '.', holds: '' }], now: () => clockAt, port: 4999,
    startAgent: async (a, prompt, title) => { started.push({ agent: a, prompt, title }); return `conv-${started.length}` },
    checkCommit: async scope => {
      scopes.push(scope)
      return checkOk ? { ok: true, ran: ['pyflakes 1 file'], failing: [], elsewhere: [], tail: '' } : { ok: false, ran: ['tsc'], failing: ['server/x.ts'], elsewhere: [], tail: "server/x.ts(1,1): error TS2322: nope" }
    },
    runCheck: async area => { checks.push(area); return areaRed === null ? { ok: true, tail: 'ok' } : { ok: false, tail: 'FAIL app', text: areaRed } },
    ...extra,
  }
}

/** an item in review, as an agent leaves it */
function inReview(title: string, extra: Record<string, unknown> = {}) {
  return createItem(boardDirOf(dir), { title, status: 'review', owner: 'app', from: 'fund', kind: 'build', ...extra })
}

/** a commit on `path`, pushed (or not) */
function commit(path: string, msg: string, push = true): string {
  mkdirSync(join(dir, ...path.split('/').slice(0, -1)), { recursive: true })
  writeFileSync(join(dir, ...path.split('/')), `${msg} ${Math.random()}\n`)
  sh(['add', '--', path]); sh(['commit', '-q', '-m', msg])
  if (push) sh(['push', '-q', 'origin', 'main'])
  return sh(['rev-parse', 'HEAD']).trim()
}

const notes = (id: string) => splitBody(readItem(boardDirOf(dir), id).body).notes
const status = (id: string) => readItem(boardDirOf(dir), id).status

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'board-review-'))
  remote = mkdtempSync(join(tmpdir(), 'board-review-remote-'))
  sh(['init', '-q', '--bare', '-b', 'main'], remote)
  sh(['init', '-q', '-b', 'main'])
  for (const kv of [['user.email', 'loop@test'], ['user.name', 'loop test'], ['core.hooksPath', join(dir, '.nohooks')], ['core.autocrlf', 'false']]) sh(['config', kv[0], kv[1]])
  sh(['remote', 'add', 'origin', remote])
  writeFileSync(join(dir, 'README.md'), 'temp fund\n')
  sh(['add', '--', '.']); sh(['commit', '-q', '-m', 'init']); sh(['push', '-q', '-u', 'origin', 'main'])
  mkdirSync(boardDirOf(dir), { recursive: true })
  await resetStore()
  clockAt = T0; started = []; checks = []; scopes = []; checkOk = true; areaRed = null
})

afterEach(() => {
  for (const d of [dir, remote]) try { rmSync(d, { recursive: true, force: true }) } catch { /* windows file lock */ }
})

describe('who has it, and what is never auto-closed', () => {
  it('the owner reviews; no agent owner, an unknown or a dormant owner leaves it for the owner, with the reason', async () => {
    const mine = inReview('a build'), you = inReview('his own', { owner: 'you' }), ghost = inReview('who', { owner: 'dash:gone' }), old = inReview('asleep', { owner: 'old' })
    const r = await boardPass(bctx(), 10)
    expect(r.sent).toEqual([mine.id])
    expect(r.parked.sort()).toEqual([you.id, ghost.id, old.id].sort())
    expect(started.map(s => s.agent)).toEqual(['app'])   // the dormant owner is never started
    expect(status(old.id)).toBe('needs-you')
    expect(notes(old.id).at(-1)!.text).toMatch(/^review: owner needed: old is dormant/)
    expect(readItem(boardDirOf(dir), old.id).options?.map(o => o.id)).toEqual(['close', 'redo'])
    expect(notes(ghost.id).at(-1)!.text).toMatch(/dash:gone is not on the roster/)
    expect(status(mine.id)).toBe('review')
    expect(notes(mine.id).at(-1)).toMatchObject({ who: 'loop', text: 'review: sent to app (try 1), conversation conv-1' })
  })

  it('owner-only work (execution, a settings file, the configuration, a rail) is not sent, whoever owns the item', async () => {
    for (const p of ['execution/core/arm.py', '.claude/settings.json', 'app/library/law/how-we-guard-rails.md', 'app/schedule.json', 'CLAUDE.md']) expect(ownerOnlyPath(p), p).not.toBeNull()
    for (const p of ['app/server/x.ts', 'platform/research/check_charts.py', 'app/library/app/cockpit-ui.md']) expect(ownerOnlyPath(p), p).toBeNull()
    const rail = inReview('widen the deny list', { body: 'Edit .claude/settings.json to add a row.' })
    const exec = inReview('exec fix', { owner: 'execution' })
    const plain = inReview('plain')
    const r = await boardPass(bctx(), 10)
    expect(r.sent).toEqual([plain.id])
    expect(r.parked.sort()).toEqual([rail.id, exec.id].sort())
    expect(notes(rail.id).at(-1)!.text).toMatch(/names owner-only work: .claude\/settings.json/)
  })
})

describe('the send, its cap and its retries', () => {
  it('a send nobody answered is re-sent once after STALE_MS and not a third time', async () => {
    const it1 = inReview('half done')
    await boardPass(bctx(), 3)
    expect(started).toHaveLength(1)
    await boardPass(bctx(), 3)                       // still with the reviewer
    expect(started).toHaveLength(1)
    clockAt += STALE_MS
    await boardPass(bctx(), 3)
    expect(started).toHaveLength(2)
    expect(notes(it1.id).at(-1)!.text).toBe('review: sent to app (try 2), conversation conv-2')
    clockAt += STALE_MS
    const r = await boardPass(bctx(), 3)
    expect(started).toHaveLength(2)                  // never a third send
    expect(r.parked).toEqual([it1.id])
    expect(status(it1.id)).toBe('needs-you')
    expect(notes(it1.id).at(-1)!.text).toMatch(/app did not answer after 2 sends/)
  })

  it('a pass sends at most what is left of MAX_SENDS, oldest first; the rest go next pass', async () => {
    const ids: string[] = []
    for (let i = 0; i < MAX_SENDS + 2; i++) {
      const it = inReview(`item ${i}`)
      updateItem(boardDirOf(dir), it.id, { title: `item ${i} aged` })   // distinct, ordered `updated`
      ids.push(it.id)
    }
    const r = await pass({ db, fundRoot: dir, agents: AGENTS, shelves: [], repos: [{ id: 'app', path: '.', holds: '' }], config: { ...DEFAULTS, autoApply: true }, now: () => clockAt, port: 4999,
      startAgent: async (a, prompt, title) => { started.push({ agent: a, prompt, title }); return `conv-${started.length}` } } as Ctx, 'schedule')
    expect(r.sent).toHaveLength(MAX_SENDS)
    expect(r.notes.join('\n')).toMatch(/pass cap is reached/)
    expect(started).toHaveLength(MAX_SENDS)
    const r2 = await pass({ db, fundRoot: dir, agents: AGENTS, shelves: [], repos: [{ id: 'app', path: '.', holds: '' }], config: { ...DEFAULTS, autoApply: true }, now: () => clockAt, port: 4999,
      startAgent: async (a, prompt, title) => { started.push({ agent: a, prompt, title }); return `conv-${started.length}` } } as Ctx, 'schedule')
    expect(r2.sent).toHaveLength(2)                  // the other two; the first three are still with their reviewers
    expect(new Set([...r.sent, ...r2.sent])).toEqual(new Set(ids))
  })

  it('a pass with autoApply off sends nothing', async () => {
    inReview('x')
    const r = await pass({ db, fundRoot: dir, agents: AGENTS, shelves: [], repos: [], config: { ...DEFAULTS, autoApply: false }, now: () => clockAt, startAgent: async () => 'c' } as Ctx, 'schedule')
    expect(r.sent).toEqual([])
  })

  it('the Loop room rows say who has each item', async () => {
    const a = inReview('a'), b = inReview('b', { owner: 'old' })
    await sendBoard(bctx(), a.id)
    await sendBoard(bctx(), b.id)
    const rows = reviewRows(dir, AGENTS, clockAt)
    // b was left for the owner (needs-you), so only a is still in review, with app
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: a.id, state: 'with', agent: 'app', conversation: 'conv-1', tries: 1 })
  })
})

describe('the verdict', () => {
  async function sent() {
    const it = inReview('B work')
    await sendBoard(bctx(), it.id)
    return it
  }
  const rep = (id: string, b: Record<string, unknown>) => reportBoard(bctx(), id, { agent: 'app', conversation: 'conv-1', ...b })

  it('an item with no commit in its note is refused as done', async () => {
    const it = await sent()
    await expect(rep(it.id, { verdict: 'done', note: 'looks right' })).rejects.toThrow(/needs "commit"/)
    await expect(rep(it.id, { verdict: 'done', commit: 'deadbeef', note: 'x' })).rejects.toThrow(/no commit deadbeef/)
    expect(status(it.id)).toBe('review')
    expect(checks).toEqual([]); expect(scopes).toEqual([])
  })

  it('done needs the commit pushed, and shown to be this item\'s work', async () => {
    const it = await sent()
    const local = commit('app/server/x.ts', `app (${it.id}): the work`, false)
    await expect(rep(it.id, { verdict: 'done', commit: local, note: 'x' })).rejects.toThrow(/not pushed/)
    sh(['push', '-q', 'origin', 'main'])
    const other = commit('app/server/y.ts', 'app (B-9999): somebody else')
    await expect(rep(it.id, { verdict: 'done', commit: other, note: 'x' })).rejects.toThrow(/does not name B-/)
    expect(status(it.id)).toBe('review')
    // the item's own notes naming the sha is enough when the message does not
    const noted = commit('app/server/z.ts', 'app: untagged')
    updateItem(boardDirOf(dir), it.id, { body: `${readItem(boardDirOf(dir), it.id).body}\n\nwork in ${noted.slice(0, 7)}` })
    expect((await rep(it.id, { verdict: 'done', commit: noted, note: 'x' })).state).toBe('checking')
  })

  it('a pushed commit with clean files closes it; the loop credits the reviewer; the whole area is only noted', async () => {
    const it = await sent()
    const sha = commit('app/server/x.ts', `app (${it.id}): the work`)
    const out = await rep(it.id, { verdict: 'done', commit: sha.slice(0, 12), note: 'matches the Done line' })
    expect(out).toMatchObject({ state: 'checking', area: 'app' })
    expect(status(it.id)).toBe('review')              // not closed until the commit has been checked
    await settledChecks()
    expect(scopes).toHaveLength(1)
    expect(scopes[0]).toMatchObject({ sha, files: ['app/server/x.ts'] })   // judged by its own sha and files
    expect(checks).toEqual(['app'])                   // the second signal ran after the verdict
    expect(status(it.id)).toBe('done')
    const ns = notes(it.id).map(n => n.text)
    expect(ns.find(t => t.startsWith('review: done by'))).toMatch(/^review: done by app: commit \w{10} is pushed and its own files are clean \(pyflakes 1 file; the committed tree/)
    expect(ns.at(-1)).toBe('review: area app full run (second signal, shared checkout, --fast): green')
    expect(closedBy(readItem(boardDirOf(dir), it.id), clockAt)).toBe('app')
    await expect(rep(it.id, { verdict: 'ready', note: 'again' })).rejects.toThrow(/is done, not review/)
  })

  it('red in the own files of the commit returns it to ready, names the file and shows the tail; a return counts', async () => {
    const it = await sent()
    const sha = commit('app/server/x.ts', `app (${it.id}): the work`)
    checkOk = false
    await rep(it.id, { verdict: 'done', commit: sha, note: 'x' })
    await settledChecks()
    expect(status(it.id)).toBe('ready')
    expect(notes(it.id).find(n => n.text.startsWith('review: returned by'))!.text).toMatch(/returned by app: the done claim .* failed: red in server\/x\.ts \(tsc\)\. server\/x\.ts\(1,1\): error TS2322/)
    expect(cycleOf(readItem(boardDirOf(dir), it.id)).returns).toBe(1)
  })

  it('a red area outside the commit does not return it: it is noted as red elsewhere (the B-0643 files)', async () => {
    const it = await sent()
    const sha = commit('app/server/x.ts', `app (${it.id}): the work`)
    areaRed = ['FAIL app.pyflakes', 'fundplat/quant/example15.py:3:1: imported but unused', 'fundplat/quant/tests/test_example15.py:9:1: undefined name'].join(String.fromCharCode(10))
    await rep(it.id, { verdict: 'done', commit: sha, note: 'x' })
    await settledChecks()
    expect(status(it.id)).toBe('done')
    expect(notes(it.id).at(-1)!.text).toMatch(/second signal.*: red\. Area red elsewhere: fundplat\/quant\/example15\.py, fundplat\/quant\/tests\/test_example15\.py\./)
    expect(notes(it.id).at(-1)!.text).not.toMatch(/Also red in this commit/)
  })

  it('a whole-area red that names a file of the commit is recorded, and does not decide when the committed tree is clean', async () => {
    const it = await sent()
    const sha = commit('app/server/x.ts', `app (${it.id}): the work`)
    areaRed = 'server/x.ts(1,1): error TS2322: a dirty edit in the shared copy'
    await rep(it.id, { verdict: 'done', commit: sha, note: 'x' })
    await settledChecks()
    expect(status(it.id)).toBe('done')
    expect(notes(it.id).at(-1)!.text).toMatch(/Also red in this commit's files in the shared copy: server\/x\.ts \(the committed tree is clean: a dirty edit by another session\)/)
  })

  it('the whole-area run does not hold the next commit check, and one run serves every item that finishes inside it', async () => {
    const a = await sent()
    const b = await sent()                              // conv-1 and conv-2
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const ctx = bctx({ runCheck: async area => { checks.push(area); await gate; return { ok: true, tail: 'ok' } } })
    const shaA = commit('app/server/a.ts', `app (${a.id}): a`)
    const shaB = commit('app/server/b.ts', `app (${b.id}): b`)
    await reportBoard(ctx, a.id, { agent: 'app', conversation: 'conv-1', verdict: 'done', commit: shaA, note: 'x' })
    await reportBoard(ctx, b.id, { agent: 'app', conversation: 'conv-2', verdict: 'done', commit: shaB, note: 'x' })
    // both verdicts land while the area run is still pending: it is outside the queue
    await vi.waitFor(() => { expect(status(a.id)).toBe('done'); expect(status(b.id)).toBe('done') })
    expect(checks).toEqual(['app'])                     // one run for both
    expect(notes(a.id).some(n => /second signal/.test(n.text))).toBe(false)
    release()
    await settledChecks()
    for (const it of [a, b]) expect(notes(it.id).at(-1)!.text).toBe('review: area app full run (second signal, shared checkout, --fast): green')
  })

  it('a check that could not run returns the item and says so', async () => {
    const it = await sent()
    const sha = commit('app/server/x.ts', `app (${it.id}): the work`)
    await reportBoard(bctx({ checkCommit: async () => { throw new Error('git archive failed') } }), it.id, { agent: 'app', conversation: 'conv-1', verdict: 'done', commit: sha, note: 'x' })
    await settledChecks()
    expect(status(it.id)).toBe('ready')
    expect(notes(it.id).find(n => n.text.startsWith('review: returned by'))!.text).toMatch(/the check could not run: git archive failed/)
  })

  it('ready needs one line on what is missing; it returns the item and ends the cycle', async () => {
    const it = await sent()
    await expect(rep(it.id, { verdict: 'ready' })).rejects.toThrow(/what is missing/)
    expect((await rep(it.id, { verdict: 'ready', note: 'the test is not written' })).state).toBe('ready')
    expect(status(it.id)).toBe('ready')
    expect(cycleOf(readItem(boardDirOf(dir), it.id))).toMatchObject({ sends: [], last: null, returns: 1 })
    // back in review later: a new cycle, sent afresh
    updateItem(boardDirOf(dir), it.id, { status: 'review' })
    const r = await boardPass(bctx(), 3)
    expect(r.sent).toEqual([it.id])
  })

  it('only the reviewer in the fresh conversation reports; never the one that did the work', async () => {
    const it = await sent()
    await expect(reportBoard(bctx(), it.id, { agent: 'platform', conversation: 'conv-1', verdict: 'ready', note: 'x' })).rejects.toThrow(/sent to app, not platform/)
    await expect(reportBoard(bctx(), it.id, { agent: 'app', conversation: 'conv-9', verdict: 'ready', note: 'x' })).rejects.toThrow(/fresh conversation/)
    await expect(reportBoard(bctx(), it.id, { agent: 'app', verdict: 'ready', note: 'x' })).rejects.toThrow(/fresh conversation/)
    const worked = inReview('worked in conv-1')
    updateItem(boardDirOf(dir), worked.id, { conversation: 'conv-2' })
    await sendBoard(bctx(), worked.id)               // conv-2 is the work's own conversation id in this stub
    await expect(reportBoard(bctx(), worked.id, { agent: 'app', conversation: 'conv-2', verdict: 'ready', note: 'x' })).rejects.toThrow(/did the work cannot review/)
    await expect(reportBoard(bctx(), 'B-0099', { agent: 'app', verdict: 'ready', note: 'x' })).rejects.toThrow(/no board item/)
  })

  it('a done whose commit touches owner-only ground waits for the owner, recommending close', async () => {
    const it = await sent()
    const sha = commit('app/schedule.json', `schedule (${it.id})`)
    const out = await rep(it.id, { verdict: 'done', commit: sha, note: 'schedule updated' })
    expect(out.state).toBe('needs-you')
    expect(checks).toEqual([]); expect(scopes).toEqual([])   // nothing ran: it is not the loop's to close
    expect(status(it.id)).toBe('needs-you')
    const item = readItem(boardDirOf(dir), it.id)
    expect(item.options?.find(o => o.rec)?.id).toBe('close')
    expect(notes(it.id).at(-1)!.text).toMatch(/owner needed: app says done .* the fund's configuration/)
  })

  it('no check runner, no done', async () => {
    const it = await sent()
    const sha = commit('app/server/x.ts', `app (${it.id}): the work`)
    await expect(reportBoard(bctx({ checkCommit: undefined }), it.id, { agent: 'app', conversation: 'conv-1', verdict: 'done', commit: sha, note: 'x' })).rejects.toThrow(/no check runner/)
  })

  it('an item returned twice and back in review is not sent again: the owner decides', async () => {
    const it = inReview('stubborn')
    for (let n = 1; n <= 2; n++) {
      await sendBoard(bctx(), it.id)
      await reportBoard(bctx(), it.id, { agent: 'app', conversation: `conv-${n}`, verdict: 'ready', note: 'still missing' })
      updateItem(boardDirOf(dir), it.id, { status: 'review' })
    }
    expect(stateOf(readItem(boardDirOf(dir), it.id), AGENTS, clockAt)).toMatchObject({ kind: 'park' })
    const r = await boardPass(bctx(), 3)
    expect(r.parked).toEqual([it.id])
    expect(started).toHaveLength(2)
  })
})

describe('metrics: a reviewer\'s done that is reopened', () => {
  it('counts against the owner and against the reviewer who closed it (once when they are one agent)', async () => {
    const it = inReview('closed by the loop')
    const dirItems = boardDirOf(dir)
    // closed by `platform` at T0 (the close note names it), then reopened an hour later
    const done = readItem(dirItems, it.id)
    const ts = new Date(T0).toISOString().replace(/\.\d{3}Z$/, 'Z')
    updateItem(dirItems, it.id, { status: 'done', body: `${done.body}\n\n### ${ts} - loop\n\nreview: done by platform: commit abc is pushed and app is green`.trim() })
    await ops.logEvent('board', `${it.id} status=done`, { ts: T0 }, db)
    await ops.logEvent('board', `${it.id} status=ready`, { ts: T0 + 3_600_000 }, db)
    const acc = await M.collect({ db, fundRoot: dir, agents: AGENTS }, T0 - 86_400_000, T0 + 86_400_000 * 2)
    const day = M.dayOf(T0 + 3_600_000)
    expect(acc.get(`${day}|app`)?.board_reopened).toBe(1)
    expect(acc.get(`${day}|platform`)?.board_reopened).toBe(1)
  })

  it('a done that was not the loop\'s review is not blamed on an old reviewer', async () => {
    const it = inReview('owner closed it')
    const dirItems = boardDirOf(dir)
    const old = new Date(T0 - 5 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const done = readItem(dirItems, it.id)
    updateItem(dirItems, it.id, { status: 'done', body: `${done.body}\n\n### ${old} - loop\n\nreview: done by platform: an earlier cycle`.trim() })
    await ops.logEvent('board', `${it.id} status=done`, { ts: T0 }, db)
    await ops.logEvent('board', `${it.id} status=ready`, { ts: T0 + 3_600_000 }, db)
    const acc = await M.collect({ db, fundRoot: dir, agents: AGENTS }, T0 - 86_400_000, T0 + 86_400_000 * 2)
    expect(acc.get(`${M.dayOf(T0 + 3_600_000)}|platform`)?.board_reopened ?? 0).toBe(0)
    expect(acc.get(`${M.dayOf(T0 + 3_600_000)}|app`)?.board_reopened).toBe(1)
  })
})
