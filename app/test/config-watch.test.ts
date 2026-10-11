import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { foreignName, watchHome } from '../server/config.ts'

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('the configuration watch never floods', () => {
  it('reads the long-path name Windows reports for a deleted home as foreign, a file inside it as not', () => {
    expect(foreignName('//?/C:/dev/fund/library')).toBe(true)
    expect(foreignName('C:/dev/fund/library')).toBe(true)
    expect(foreignName('markets')).toBe(false)
    expect(foreignName('gate/venue.json')).toBe(false)
  })

  it('a watched home that is deleted is announced at most once and its watcher closes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'config-watch-'))
    const dir = join(root, 'library')
    mkdirSync(dir)
    const seen: string[] = []
    const w = watchHome({ dir, recursive: false, hit: n => `lib/${n}` }, f => seen.push(f), 50)
    expect(w).not.toBeNull()
    let closed = false
    w!.on('close', () => { closed = true })
    rmSync(dir, { recursive: true, force: true })
    await wait(1_000)
    // the old watcher (Node on Windows) fired an endless stream here - ~200k events a second
    expect(seen.length).toBeLessThanOrEqual(1)
    if (process.platform === 'win32') expect(closed).toBe(true)
    try { w!.close() } catch { /* already */ }
    rmSync(root, { recursive: true, force: true })
  })

  it('a missing home is not watched and emits nothing', async () => {
    const seen: string[] = []
    const w = watchHome({ dir: join(tmpdir(), 'config-watch-never-there-' + process.pid), recursive: false, hit: n => n }, f => seen.push(f), 10)
    expect(w).toBeNull()
    await wait(100)
    expect(seen).toEqual([])
  })

  it('a burst of changes to one file is one announcement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-watch-'))
    const seen: string[] = []
    const w = watchHome({ dir, recursive: false, hit: n => (n.endsWith('.json') ? n : null) }, f => seen.push(f), 100)
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, 'repos.json'), String(i))
    await wait(400)
    expect(seen).toEqual(['repos.json'])
    w!.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
