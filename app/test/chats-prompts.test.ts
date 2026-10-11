import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// THE PROMPT RACK (server/chat/prompts.ts + the /api/chats/prompts routes): upsert, the empty-body
// refusal, tag cleaning, most-recently-updated order, delete, and the credential refusal.

const TMP = mkdtempSync(join(tmpdir(), 'chats-prompts-'))
process.env.FUND_DATA_DIR = join(TMP, 'data')
vi.mock('../server/config.ts', () => ({ agent: () => undefined, agents: () => [], config: { agents: () => [], repos: () => [] } }))

// credential-SHAPED strings built at run time, so this file never carries one past the guard
const AWS = 'AKIA' + 'Q'.repeat(4) + '7'.repeat(12)
const ENVKEY = 'EXCHANGE_API_' + 'SECRET=' + 'a1b2c3d4'.repeat(4)

let P: typeof import('../server/chat/prompts.ts')
const routes: Record<string, (ctx: any) => any> = {}
const published: [string, unknown][] = []
beforeAll(async () => {
  vi.doMock('../server/events.ts', () => ({ publish: (t: string, d: unknown) => { published.push([t, d]) } }))
  P = await import('../server/chat/prompts.ts')
  const rec = (m: string) => (p: string, h: any) => { routes[`${m} ${p}`] = h }
  const room = await import('../server/rooms/chats.ts')
  room.register({ get: rec('GET'), post: rec('POST'), patch: rec('PATCH'), delete: rec('DELETE'), ws: () => {} } as any)
})

describe('upsert', () => {
  it('inserts, then replaces by id keeping created', async () => {
    const a = await P.upsert({ title: '  Retro  ', body: 'run the retro\n\n', tags: ['Desk'] }, 1000)
    expect(a).toMatchObject({ title: 'Retro', body: 'run the retro', tags: ['desk'], created: 1000, updated: 1000 })
    const b = await P.upsert({ id: a.id, title: 'Retro', body: 'run the retro now', tags: [] }, 2000)
    expect(b).toMatchObject({ id: a.id, body: 'run the retro now', tags: [], created: 1000, updated: 2000 })
    await expect(P.upsert({ id: 99999, body: 'x' })).rejects.toThrow('no such prompt')
  })
  it('refuses an empty body and an over-long title', async () => {
    await expect(P.upsert({ title: 't', body: '   \n ' })).rejects.toThrow('body required')
    await expect(P.upsert({ title: 't' })).rejects.toThrow('body required')
    await expect(P.upsert({ title: 'x'.repeat(121), body: 'b' })).rejects.toThrow(/title over 120/)
    expect((await P.upsert({ title: 'x'.repeat(120), body: 'b' })).title).toHaveLength(120)
  })
})

describe('tags', () => {
  it('lowercases, trims, strips #, dedupes, drops empties and caps at 12', () => {
    expect(P.cleanTags([' Wrap ', 'wrap', '#Retro', '', 'two words', 7, null])).toEqual(['wrap', 'retro', 'two-words'])
    expect(P.cleanTags('a, B  c,,a')).toEqual(['a', 'b', 'c'])
    expect(P.cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(12)
    expect(P.cleanTags(undefined)).toEqual([])
  })
})

describe('order and delete', () => {
  it('lists most recently updated first; delete removes one and reports a miss', async () => {
    for (const p of await P.list()) await P.remove(p.id)
    const a = await P.upsert({ body: 'a' }, 10)
    const b = await P.upsert({ body: 'b' }, 20)
    const c = await P.upsert({ body: 'c' }, 30)
    expect((await P.list()).map(p => p.body)).toEqual(['c', 'b', 'a'])
    await P.upsert({ id: a.id, body: 'a2' }, 40)
    expect((await P.list()).map(p => p.id)).toEqual([a.id, c.id, b.id])
    expect(await P.remove(b.id)).toBe(true)
    expect(await P.remove(b.id)).toBe(false)
    expect((await P.list()).map(p => p.id)).toEqual([a.id, c.id])
  })
})

describe('credentials', () => {
  it('refuses a body or title that looks like a credential, keeps ordinary prose', async () => {
    await expect(P.upsert({ body: `use ${AWS} for this` })).rejects.toThrow(/credential \(aws access key id\)/)
    await expect(P.upsert({ body: ENVKEY })).rejects.toThrow(/credential/)
    await expect(P.upsert({ title: AWS, body: 'fine' })).rejects.toThrow(/credential/)
    expect((await P.upsert({ body: 'check the api key rotation board item; token counts under 20k' })).body).toContain('api key')
    expect((await P.upsert({ body: 'read the sk-semis-pair-thesis notebook' })).body).toContain('sk-semis')
  })
})

describe('routes', () => {
  it('GET lists, POST upserts and publishes chats:prompts, 400 on a bad body, DELETE 404s a miss', async () => {
    published.length = 0
    const out = await routes['POST /api/chats/prompts']({ body: async () => ({ title: 'Wrap', body: 'that is a wrap', tags: 'close' }) })
    expect(out.prompt).toMatchObject({ title: 'Wrap', tags: ['close'] })
    expect(published).toEqual([['chats:prompts', { id: out.prompt.id }]])
    const got = await routes['GET /api/chats/prompts']({})
    expect(got.prompts[0].id).toBe(out.prompt.id)
    await expect(async () => routes['POST /api/chats/prompts']({ body: async () => ({ body: '' }) })).rejects.toMatchObject({ status: 400 })
    await expect(async () => routes['POST /api/chats/prompts']({ body: async () => ({ body: AWS }) })).rejects.toMatchObject({ status: 400 })
    expect(await routes['DELETE /api/chats/prompts/:id']({ params: { id: String(out.prompt.id) } })).toEqual({ ok: true })
    await expect(async () => routes['DELETE /api/chats/prompts/:id']({ params: { id: String(out.prompt.id) } })).rejects.toMatchObject({ status: 404 })
  })
})
