import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// OWNER ATTESTATION (server/board/attest.ts): `from: you` in a raw file is never enough on its own.
const TMP = mkdtempSync(join(tmpdir(), 'cockpit-attest-'))
process.env.FUND_DATA_DIR = join(TMP, 'data')
const { settled, ops } = await import('../server/db.ts')
const { attest, attestedFn, fingerprint, gitOwnerCommitted, loadAttest, restoreAttest, snapshotAttest } = await import('../server/board/attest.ts')
const { createItem, readItem, updateItem } = await import('../server/board/store.ts')
const { holdReason } = await import('../server/board/auto.ts')

const root = join(TMP, 'fund')
const board = join(root, 'board')
mkdirSync(board, { recursive: true })
const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' })
git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
git('config', 'core.hooksPath', join(TMP, 'no-hooks'))
const AGENTS = [{ id: 'fund', mode: 'active' }]
const attested = attestedFn(root, board)
const auto = (title: string) => createItem(board, { title, status: 'ready', owner: 'fund', from: 'you', labels: ['auto'] } as any)

describe('board owner attestation', () => {
  it('a raw file with from: you is HELD, and says why', () => {
    const i = auto('raw')
    expect(attested(i)).toBe(false)
    expect(holdReason(i, [i], AGENTS, attested)).toMatch(/not attested/)
  })
  it('the cockpit UI attests; an agent rewriting owner or labels breaks it', () => {
    const i = auto('ui')
    attest(i, 'cockpit POST')
    expect(attested(readItem(board, i.id))).toBe(true)
    expect(holdReason(readItem(board, i.id), [i], AGENTS, attested)).toBeNull()
    updateItem(board, i.id, { labels: ['auto', 'x'] })
    expect(attested(readItem(board, i.id))).toBe(false)
  })
  it('committed with no Agent trailer attests; with one, or dirty, it does not', () => {
    const a = auto('owner commit')
    git('add', '--', `board/${a.id}.md`); git('commit', '-q', '-m', 'owner files it')
    expect(gitOwnerCommitted(root, `board/${a.id}.md`)).toBe(true)
    const b = auto('agent commit')
    git('add', '--', `board/${b.id}.md`); git('commit', '-q', '-m', 'agent files it\n\nAgent: dash:preds')
    expect(gitOwnerCommitted(root, `board/${b.id}.md`)).toBe(false)
    writeFileSync(join(board, `${a.id}.md`), readItem(board, a.id).body + '\nedited\n', { flag: 'a' })
    expect(gitOwnerCommitted(root, `board/${a.id}.md`)).toBe(false)
  })
  it('an attestation lands in ops.board_attest (the mirror is written through), and an undo restores it exactly', async () => {
    await loadAttest()
    const i = auto('stored')
    attest(i, 'cockpit POST')
    await settled()
    expect(await ops.getBoardAttest(i.id)).toMatchObject({ id: i.id, fp: fingerprint(i), via: 'cockpit POST' })
    const rows = snapshotAttest(i.id)
    restoreAttest(i.id, [])
    expect(attested(readItem(board, i.id))).toBe(false)
    await settled()
    expect(await ops.getBoardAttest(i.id)).toBeNull()
    restoreAttest(i.id, rows)
    expect(attested(readItem(board, i.id))).toBe(true)
    await settled()
    expect(await ops.getBoardAttest(i.id)).toMatchObject({ fp: rows[0].fp, ts: rows[0].ts })
  })
  it('a row already in the store attests after loadAttest (a restart reads its own record)', async () => {
    const i = auto('from before')
    await ops.attestBoard(i.id, fingerprint(i), 'an earlier fundd')
    const fresh = await import('../server/board/attest.ts?fresh=1' as string) as typeof import('../server/board/attest.ts')
    expect(fresh.attestedFn(root, board)(readItem(board, i.id))).toBe(false)     // nothing loaded yet: held, never run
    await fresh.loadAttest()
    expect(fresh.attestedFn(root, board)(readItem(board, i.id))).toBe(true)
  })
  it('never attests an item filed by anyone else', () => {
    const i = createItem(board, { title: 'x', status: 'ready', owner: 'fund', from: 'fund', labels: ['auto'] } as any)
    attest(i, 'cockpit POST')
    expect(attested(i)).toBe(false)
  })
})
