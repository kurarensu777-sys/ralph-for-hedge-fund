import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serializeAgentFile } from '../shared/agentfile.ts'
import * as S from '../server/board/store.ts'

// `board.mjs add --now` files ready + auto work for ANOTHER agent and asks fundd for a tick at once,
// so the agent starts now and not at the next 10 s timer. The ask is best effort: the file is the claim.
const TMP = mkdtempSync(join(tmpdir(), 'cockpit-now-kick-'))
const ROOT = join(TMP, 'fund')
const BOARD = join(ROOT, 'app', 'board')
mkdirSync(BOARD, { recursive: true })
mkdirSync(join(ROOT, 'app', 'agents'), { recursive: true })
for (const id of ['platform', 'research']) {
  writeFileSync(join(ROOT, 'app', 'agents', `${id}.md`), serializeAgentFile({ id, name: id, kind: 'standing', mode: 'active', dept: 'x', role: 'r', cwd: '.', model: 'opus', effort: 'high', writes: [`${id}/`], boot: [] }, `# ${id}\n`))
}

const CLI = resolve(__dirname, '..', 'scripts', 'board.mjs')
const cli = (args: string[], port: number, agent = 'platform') => new Promise<{ status: number | null; out: string; err: string }>(done => {
  const env: Record<string, string | undefined> = { ...process.env, FUND_ROOT: ROOT, FUND_BOARD_DIR: BOARD, FUND_AGENT: agent, FUNDD_PORT: String(port) }
  const p = spawn(process.execPath, [CLI, ...args], { env })
  let out = '', err = ''
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { err += d })
  p.on('close', status => done({ status, out, err }))
})

let fundd: Server
let port = 0
let answer: { code: number; body: unknown } = { code: 200, body: {} }
const hits: string[] = []
beforeAll(async () => {
  fundd = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    res.writeHead(answer.code, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer.body))
  })
  await new Promise<void>(r => fundd.listen(0, '127.0.0.1', r))
  port = (fundd.address() as AddressInfo).port
})
afterAll(() => { fundd.close() })

describe('board.mjs add --now', () => {
  it('files ready + auto work and reports the pickup when fundd started it', async () => {
    hits.length = 0
    answer = { code: 200, body: { result: { picked: ['B-0001'], held: null } } }
    const r = await cli(['add', 'Check the funding cadence', '--owner', 'research', '--now'], port)
    expect(r.status).toBe(0)
    expect(hits).toEqual(['POST /api/board/auto/tick'])
    expect(r.out).toMatch(/B-0001 picked up: the agent is starting now/)
    expect(S.readItem(BOARD, 'B-0001')).toMatchObject({ status: 'ready', owner: 'research', from: 'platform' })
    expect(S.readItem(BOARD, 'B-0001').labels).toContain(S.AUTO_LABEL)
  })
  it('says why when the tick held it (Manual, a cap): the item still waits on disk', async () => {
    answer = { code: 200, body: { result: { picked: [], held: 'manual' } } }
    const r = await cli(['add', 'Second ask', '--owner', 'research', '--now'], port)
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/waits for the board's next tick \(held: manual\)/)
    expect(S.readItem(BOARD, 'B-0002').status).toBe('ready')
  })
  it('fundd down is not a failure: the item is filed and waits for the next tick', async () => {
    const dead = createServer(); await new Promise<void>(r => dead.listen(0, '127.0.0.1', r))
    const gone = (dead.address() as AddressInfo).port
    await new Promise<void>(r => dead.close(() => r()))
    const r = await cli(['add', 'Third ask', '--owner', 'research', '--now'], gone)
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/did not answer/)
    expect(S.readItem(BOARD, 'B-0003').status).toBe('ready')
  })
  it('plain add (backlog) never asks fundd for anything, and --now for yourself is refused', async () => {
    hits.length = 0
    const plain = await cli(['add', 'Backlog idea', '--owner', 'research'], port)
    expect(plain.status).toBe(0)
    expect(hits).toEqual([])
    expect(S.readItem(BOARD, 'B-0004').status).not.toBe('ready')
    const self = await cli(['add', 'Mine', '--owner', 'platform', '--now'], port)
    expect(self.status).toBe(1)
    expect(self.err).toMatch(/ANOTHER agent/)
    expect(hits).toEqual([])
  })
})
