import { query as sql } from '@fund/db'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// ROUND 2 records that must outlive a fundd restart: the law manifest's SOURCE column (B-0021: which
// rows the SDK hook wrote and which the cockpit derived). The verify dot (B-0024) was removed with the
// pre-landing checks (B-0175); ops.chat_verify is left unread.

const TMP = mkdtempSync(join(tmpdir(), 'chats-persist-'))
const ROOT = join(TMP, 'fund')
process.env.FUND_DATA_DIR = join(TMP, 'data')
process.env.FUND_ROOT = ROOT
mkdirSync(join(ROOT, 'lab', 'desk'), { recursive: true })
writeFileSync(join(ROOT, 'CLAUDE.md'), '# law\n')
writeFileSync(join(ROOT, 'lab', 'desk', 'CLAUDE.md'), '# desk\n')
writeFileSync(join(ROOT, 'lab', 'desk', 'book.md'), '# book\n')
vi.mock('../server/config.ts', () => ({ agent: () => undefined, agents: () => [], config: { agents: () => [], repos: () => [] } }))

let db: typeof import('../server/db.ts')
let L: typeof import('../server/chat/law.ts')
beforeAll(async () => {
  db = await import('../server/db.ts')
  L = await import('../server/chat/law.ts')
})

describe('law manifest source (B-0021)', () => {
  it('hook rows say hook, the derived start chain says derived, boot books say launch, old rows say null', async () => {
    void L.recordStart('p1', 'tester', join(ROOT, 'lab', 'desk'), ROOT)
    void L.recordLoad('p1', 'tester', { file_path: join(ROOT, 'lab', 'desk', 'book.md'), memory_type: 'Project', load_reason: 'path_glob_match' }, ROOT)
    void L.recordBoot('p1', 'tester', ['lab/desk/book2.md'], ROOT)
    // a row imported from before the column existed carries no source
    await db.ops.insert('law_loads', { conversation_id: 'p1', agent_id: 'tester', ts: 1, file_path: 'old.md', load_reason: 'session_start' })
    const by = Object.fromEntries((await L.law('p1', ROOT)).rows.map(r => [r.path, r.source]))
    expect(by['CLAUDE.md']).toBe('derived')
    expect(by['lab/desk/CLAUDE.md']).toBe('derived')
    expect(by['lab/desk/book.md']).toBe('hook')
    expect(by['lab/desk/book2.md']).toBe('launch')
    expect(by['old.md']).toBe(null)
  })
  it('the column is the store schema\'s own (database/ migrations), not added at runtime', async () => {
    const cols = await sql<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'ops' AND table_name = 'law_loads' AND column_name = 'source'")
    expect(cols).toHaveLength(1)
    expect('ensureSource' in L).toBe(false)
  })
})
