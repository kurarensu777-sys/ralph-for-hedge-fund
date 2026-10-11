import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// THE NEEDS-YOU CONTRACT: an owner question carries choosable options; the owner picks one with a
// click (POST /api/board/:id/choose, cockpit only) or `board.mjs choose` (never an agent).
const TMP = mkdtempSync(join(tmpdir(), 'cockpit-choices-'))
const ROOT = join(TMP, 'fund')
const BOARD = join(ROOT, 'app', 'board')   // the board sits in the machine since 2026-09-25
mkdirSync(BOARD, { recursive: true })
mkdirSync(join(ROOT, 'app', 'agents'), { recursive: true })
const writeRoster = () => writeFileSync(join(ROOT, 'app', 'agents', 'fund.md'), serializeAgentFile({ id: 'fund', name: 'fund', kind: 'standing', mode: 'active', dept: 'fund', role: 'r', cwd: '.', model: 'opus', effort: 'high', writes: ['app/board/'], boot: [] }, '# fund\n'))
process.env.FUND_ROOT = ROOT
process.env.FUND_DATA_DIR = join(TMP, 'data')
process.env.FUND_BOARD_AUTO = '0'
process.env.FUND_SCHEDULER = '0'

const { serializeAgentFile } = await import('../shared/agentfile.ts')
writeRoster()
const S = await import('../server/board/store.ts')
const { attestedFn } = await import('../server/board/attest.ts')
const { holdReason, briefFor } = await import('../server/board/auto.ts')

const ask = (over: Record<string, unknown> = {}) => S.createItem(BOARD, {
  title: 'Delete the settings file?', status: 'needs-you', kind: 'question', owner: 'fund', from: 'fund',
  options: 'rm=git -C platform rm .claude/settings.json !*;law=Write the exception into the law;leave=Leave it', ...over,
} as any)

describe('options frontmatter', () => {
  it('parses flow maps and the block form, and round-trips byte-identical', () => {
    const raw = [
      '---', 'title: "q"', 'status: needs-you', 'kind: question', 'owner: fund', 'from: fund', 'priority: p2', 'labels: []',
      'created: 2026-09-25T00:00:00Z', 'updated: 2026-09-25T00:00:00Z',
      'options:',
      '  - {id: a, label: "Keep it, as it is: a, b", rec: true}',
      '  - id: b',
      '    label: git -C execution revert f6d7e12',
      '    hand: true',
      '  - {id: c, label: \'Route it\', owner: app}',
      'chosen: a',
      '---', '', 'body', '',
    ].join('\n')
    const i = S.parseItem(raw, 'B-0001')
    expect(i.options).toEqual([
      { id: 'a', label: 'Keep it, as it is: a, b', rec: true },
      { id: 'b', label: 'git -C execution revert f6d7e12', hand: true },
      { id: 'c', label: 'Route it', owner: 'app' },
    ])
    expect(i.chosen).toBe('a')
    expect(i.owner).toBe('fund')                              // the indented lines never leak into the scalars
    const out = S.serializeItem(i)
    expect(S.parseItem(out, 'B-0001')).toEqual(i)
    expect(S.serializeItem(S.parseItem(out, 'B-0001'))).toBe(out)
  })

  it('an item without options is written exactly as before (no options, no chosen lines)', () => {
    const i = S.createItem(BOARD, { title: 'plain', status: 'backlog' } as any)
    const text = readFileSync(join(BOARD, `${i.id}.md`), 'utf8')
    expect(text).not.toMatch(/options:|chosen:/)
  })

  it('drops a bad option out loud and keeps the good ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const i = S.parseItem('---\ntitle: x\noptions:\n  - {id: ok, label: "Fine"}\n  - {label: "no id"}\n  - {id: ok, label: "twice"}\n---\n', 'B-0777')
    expect(i.options).toEqual([{ id: 'ok', label: 'Fine' }])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('reads the shell spec: * rec, ! hand, ~ closes, @agent runs it', () => {
    expect(S.parseOptionSpec('a=Do A*;b=git rm x !;c=Leave it~;d=Hand it over @app')).toEqual([
      { id: 'a', label: 'Do A', rec: true },
      { id: 'b', label: 'git rm x', hand: true },
      { id: 'c', label: 'Leave it', done: true },
      { id: 'd', label: 'Hand it over', owner: 'app' },
    ])
    expect(() => S.parseOptionSpec('a=A*;b=B*')).toThrow(/at most one/)
    expect(() => S.parseOptionSpec('nolabel')).toThrow(/id=label/)
    expect(() => S.parseOptionSpec('a b=x')).toThrow(/letters/)
    expect(() => S.parseOptionSpec('a=x;a=y')).toThrow(/twice/)
  })
})

describe('chooseItem', () => {
  it('an ordinary option: ready for the agent, labelled auto, noted as the owner chose it', () => {
    const i = ask()
    const c = S.chooseItem(BOARD, i.id, 'law', 'go ahead')
    expect(c.outcome).toBe('ready')
    expect(c.item).toMatchObject({ status: 'ready', owner: 'fund', chosen: 'law' })
    expect(c.item.labels).toContain('auto')
    const last = S.splitBody(c.item.body).notes.at(-1)!
    expect(last.who).toBe('owner chose: Write the exception into the law')
    expect(last.text).toBe('go ahead')
    expect(c.before).not.toBe(c.after)
    expect(readFileSync(join(BOARD, `${i.id}.md`), 'utf8')).toBe(c.after)
  })

  it('a closing option (leave) is done; a hand option stays needs-you with a checklist line until ticked', () => {
    const a = S.chooseItem(BOARD, ask().id, 'leave')
    expect(a.outcome).toBe('done')
    expect(a.item.status).toBe('done')
    const h = S.chooseItem(BOARD, ask().id, 'rm')
    expect(h.outcome).toBe('hand')
    expect(h.item.status).toBe('needs-you')
    expect(h.item.body).toContain('- [ ] git -C platform rm .claude/settings.json')
    const d = S.handDone(BOARD, h.item.id)
    expect(d.status).toBe('done')
    expect(d.body).toContain('- [x] git -C platform rm .claude/settings.json')
    expect(() => S.handDone(BOARD, h.item.id)).toThrow(/no by-hand choice/)
  })

  it('no options of its own: Approve runs it, Decline closes it', () => {
    const i = ask({ options: undefined })
    expect(S.offered(i).map(o => o.id)).toEqual(['approve', 'decline'])
    expect(S.chooseItem(BOARD, i.id, 'decline').item.status).toBe('done')
    expect(S.chooseItem(BOARD, ask({ options: undefined }).id, 'approve').item.status).toBe('ready')
  })

  it('refuses an unknown option and an item that is not needs-you', () => {
    const i = ask()
    expect(() => S.chooseItem(BOARD, i.id, 'nope')).toThrow(/not one of rm \| law \| leave/)
    S.chooseItem(BOARD, i.id, 'law')
    expect(() => S.chooseItem(BOARD, i.id, 'law')).toThrow(/not needs-you/)
  })

  it("an owner question (owner: you) goes to ready for the agent that filed it; an option's @agent wins", () => {
    const i = ask({ owner: 'you', options: 'a=Do it;b=Do it elsewhere @app' })
    expect(S.chooseItem(BOARD, i.id, 'a').item.owner).toBe('fund')
    const j = ask({ owner: 'you', options: 'a=Do it;b=Do it elsewhere @app' })
    expect(S.chooseItem(BOARD, j.id, 'b').item.owner).toBe('app')
  })
})

describe('auto-pickup of a chosen item', () => {
  const AGENTS = [{ id: 'fund', mode: 'active' }]
  it('an agent-filed item is held until the owner chooses, then held for the undo window, then runs', () => {
    const i = ask()
    const ready = S.updateItem(BOARD, i.id, { status: 'ready', labels: ['auto'] }).item
    expect(holdReason(ready, [ready], AGENTS, () => true)).toMatch(/filed by fund for itself/)
    S.updateItem(BOARD, i.id, { status: 'needs-you' })
    const c = S.chooseItem(BOARD, i.id, 'law')
    const t = Date.parse(S.splitBody(c.item.body).notes.at(-1)!.ts)
    expect(holdReason(c.item, [c.item], AGENTS, () => false, undefined, t + 60_000)).toMatch(/choice law is not attested/)
    expect(holdReason(c.item, [c.item], AGENTS, () => true, undefined, t + 1_000)).toMatch(/undo window/)
    expect(holdReason(c.item, [c.item], AGENTS, () => true, undefined, t + 60_000)).toBeNull()
    expect(briefFor(c.item)).toMatch(/^THE OWNER CHOSE: Write the exception into the law \(option law\)/)
  })

  it('attestedFn: an agent item with no choice is never attested, and a raw `chosen:` is not either', () => {
    const attested = attestedFn(ROOT, BOARD)
    const i = ask()
    expect(attested(i)).toBe(false)
    const forged = S.updateItem(BOARD, i.id, { status: 'ready', labels: ['auto'], chosen: 'law' }).item
    expect(attested(forged)).toBe(false)                    // no cockpit row, and not committed by the owner
  })
})

// ---------- the route ----------

let server: Server
let base = ''
const UI = 'http://127.0.0.1:4688'
const call = async (path: string, body: unknown, origin: string | null = UI) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json() as any }
}

beforeAll(async () => {
  const { Router } = await import('../server/http.ts')
  const room = await import('../server/rooms/board.ts')
  const r = new Router()
  room.register(r)
  server = createServer((req, res) => { void r.handle(req, res).then(ok => { if (!ok) { res.statusCode = 404; res.end('{}') } }) })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(() => { server?.close() })

describe('POST /api/board/:id/choose', () => {
  it('is owner-only: a request without the cockpit Origin is refused and changes nothing', async () => {
    const i = ask()
    const before = readFileSync(join(BOARD, `${i.id}.md`), 'utf8')
    const r = await call(`/api/board/${i.id}/choose`, { option: 'law' }, null)
    expect(r.status).toBe(403)
    expect(readFileSync(join(BOARD, `${i.id}.md`), 'utf8')).toBe(before)
  })

  it('from the cockpit: chooses, attests the choice for auto-pickup, and undo puts the file back exactly', async () => {
    const i = ask()
    const before = readFileSync(join(BOARD, `${i.id}.md`), 'utf8')
    const r = await call(`/api/board/${i.id}/choose`, { option: 'law', note: 'yes' })
    expect(r.status).toBe(200)
    expect(r.json.outcome).toBe('ready')
    expect(r.json.item).toMatchObject({ status: 'ready', owner: 'fund', chosen: 'law' })
    expect(attestedFn(ROOT, BOARD)(S.readItem(BOARD, i.id))).toBe(true)
    const u = await call(`/api/board/${i.id}/undo`, {})
    expect(u.status).toBe(200)
    expect(readFileSync(join(BOARD, `${i.id}.md`), 'utf8')).toBe(before)
    expect(attestedFn(ROOT, BOARD)(S.readItem(BOARD, i.id))).toBe(false)
    expect((await call(`/api/board/${i.id}/undo`, {})).status).toBe(409)   // once only
  })

  it('undo is refused once the file has moved on', async () => {
    const i = ask()
    await call(`/api/board/${i.id}/choose`, { option: 'law' })
    S.appendNote(BOARD, i.id, 'fund', 'started')
    const u = await call(`/api/board/${i.id}/undo`, {})
    expect(u.status).toBe(409)
    expect(u.json.error).toMatch(/changed since/)
  })

  it('a POST from an agent (no cockpit Origin) filing a question needs options; the cockpit form does not', async () => {
    expect((await call('/api/board', { title: 'q', status: 'needs-you', from: 'fund' }, null)).status).toBe(400)
    expect((await call('/api/board', { title: 'q', status: 'needs-you', from: 'fund', options: 'a=Yes;b=No~' }, null)).status).toBe(200)
    expect((await call('/api/board', { title: 'q', status: 'needs-you', from: 'you' })).status).toBe(200)
  })

  it('a hand option waits for hand-done; a bad option is a 400; a patch cannot set chosen', async () => {
    const i = ask()
    expect((await call(`/api/board/${i.id}/choose`, { option: 'zzz' })).status).toBe(400)
    const h = await call(`/api/board/${i.id}/choose`, { option: 'rm' })
    expect(h.json.outcome).toBe('hand')
    expect(h.json.item.status).toBe('needs-you')
    expect((await call(`/api/board/${i.id}/hand-done`, {}, null)).status).toBe(403)
    const d = await call(`/api/board/${i.id}/hand-done`, {})
    expect(d.json.status).toBe('done')
    const j = ask()
    const p = await fetch(`${base}/api/board/${j.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: UI }, body: JSON.stringify({ chosen: 'law' }) })
    expect(p.status).toBe(400)
  })
})

// ---------- the CLI ----------

const CLI = resolve(__dirname, '..', 'scripts', 'board.mjs')
const cli = (args: string[], agent?: string) => {
  const env: Record<string, string | undefined> = { ...process.env, FUND_BOARD_DIR: BOARD }
  delete env.FUND_AGENT
  if (agent) env.FUND_AGENT = agent
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' })
}

describe('board.mjs add --options / choose', () => {
  it('files a needs-you question with its options, and only the owner chooses', () => {
    const a = cli(['add', 'Ratify or revert?', '--owner', 'you', '--options', 'a=Ratify it~;b=git -C execution revert f6d7e12 !*'], 'fund')
    expect(a.status).toBe(0)
    const id = /^(B-\d{4})/.exec(a.stdout)![1]
    const i = S.readItem(BOARD, id)
    expect(i.status).toBe('needs-you')
    expect(i.from).toBe('fund')
    expect(i.options).toEqual([{ id: 'a', label: 'Ratify it', done: true }, { id: 'b', label: 'git -C execution revert f6d7e12', rec: true, hand: true }])
    const refused = cli(['choose', id, 'a'], 'fund')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toMatch(/only the owner chooses/)
    const ok = cli(['choose', id, 'a', '--note', 'fine'])
    expect(ok.status).toBe(0)
    expect(S.readItem(BOARD, id)).toMatchObject({ status: 'done', chosen: 'a' })
  })
  it('an agent filing a question without options is refused (the owner filing one is not)', () => {
    const r = cli(['add', 'What now?', '--status', 'needs-you'], 'fund')
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/carries its answers/)
    expect(cli(['add', 'What now?', '--status', 'needs-you']).status).toBe(0)
    expect(cli(['add', 'Later', '--status', 'backlog'], 'fund').status).toBe(0)
  })
  it('options sets or clears them on an existing item', () => {
    const i = S.createItem(BOARD, { title: 'later', status: 'needs-you', from: 'fund' } as any)
    expect(cli(['options', i.id, 'x=Yes*;y=No~'], 'fund').status).toBe(0)
    expect(S.readItem(BOARD, i.id).options?.map(o => o.id)).toEqual(['x', 'y'])
    expect(cli(['options', i.id, 'none'], 'fund').status).toBe(0)
    expect(S.readItem(BOARD, i.id).options).toBeUndefined()
  })
})

