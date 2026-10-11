import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DOORS_SLUG, doorsFromLaw, parseCredentials } from '../server/system/credentials.ts'

// The doors (connectors) are the Credentials table of the fund's CLAUDE.md since 2026-09-25, and the
// `The doors and their keys` chapter of app/library/law/how-we-work.md since 2026-10-03. The System
// room reads that table as data.

const MD = [
  '# law', '',
  '## Credentials - every door, and who may hold its key', '',
  'prose that is not a table', '',
  '| Door | Scope | Credential, and where it lives | Agent may hold | Reached through · health |',
  '|---|---|---|---|---|',
  '| Venue public REST (10 venues) | fund | none - anonymous public endpoints | yes | `feeds` ONLY · `python -m feeds.selftest` |',
  '| Broker Gateway (the stock leg, PARKED) | operator | **HUMAN** - the owner\'s login | **no** | nothing today |',
  '| Venue public REST (other) | fund | none | yes | x |',
  '',
  '## The sync law', '',
  '| Door | Scope |', '|---|---|', '| not a door | fund |',
].join('\n')

describe('the Credentials table', () => {
  it('reads each door: plain cells, who may hold it, reached-through split from health at the first " · "', () => {
    const d = parseCredentials(MD)
    expect(d.found).toBe(true)
    expect(d.rows).toEqual([
      { id: 'venue-public-rest', name: 'Venue public REST (10 venues)', scope: 'fund', credential: 'none - anonymous public endpoints', agentMayHold: true, reachedThrough: 'feeds ONLY', health: 'python -m feeds.selftest', parked: false },
      { id: 'broker-gateway', name: 'Broker Gateway (the stock leg, PARKED)', scope: 'operator', credential: "HUMAN - the owner's login", agentMayHold: false, reachedThrough: 'nothing today', health: '', parked: true },
      { id: 'venue-public-rest-2', name: 'Venue public REST (other)', scope: 'fund', credential: 'none', agentMayHold: true, reachedThrough: 'x', health: '', parked: false },
    ])
  })
  it('the chapter table (Door | Credential, who holds it | Reached through - health) reads: HUMAN is no agent key, health follows the last " - "', () => {
    const d = parseCredentials([
      '## The doors and their keys', '',
      '| Door | Credential, and who holds it | Reached through - health |', '|---|---|---|',
      '| Venue public REST | none, anonymous | `feeds` only - `python -m feeds.selftest` |',
      '| Vendor daily bars | a READ-ONLY key: env `VENDOR_API_KEY` | `feeds.vendor` - `python -m x` |',
      '| Venue trading keys | HUMAN, and NONE is provisioned | nothing. The absence is a decision |', '',
      '## Next', '',
    ].join('\n'))
    expect(d.found).toBe(true)
    expect(d.rows.map(r => [r.agentMayHold, r.reachedThrough, r.health])).toEqual([
      [true, 'feeds only', 'python -m feeds.selftest'],
      [true, 'feeds.vendor', 'python -m x'],
      [false, 'nothing. The absence is a decision', ''],
    ])
  })
  it('no section is "not found", never an empty list passing for "no doors"', () => {
    expect(parseCredentials('# law\n\n## Other\n')).toEqual({ found: false, rows: [] })
    expect(parseCredentials('## Credentials\n\nno table yet\n')).toEqual({ found: true, rows: [] })
  })
  const LIVE = resolve(__dirname, '..', 'library', 'law', 'how-we-work.md')
  it.skipIf(!existsSync(LIVE))('the live law book carries the table, and the human-only door stays locked', () => {
    const d = parseCredentials(readFileSync(join(LIVE), 'utf8'))
    expect(d.found).toBe(true)
    expect(d.rows.length).toBeGreaterThan(3)
    const human = d.rows.filter(r => !r.agentMayHold)
    expect(human.length).toBeGreaterThanOrEqual(1)   // trading and withdrawal keys stay with the owner
    for (const r of human) expect(r.credential).toMatch(/^HUMAN\b/)
  })
})

describe('the doors are found by the chapter heading, across the law shelf', () => {
  const TMP = mkdtempSync(join(tmpdir(), 'doors-'))
  const law = [{ id: 'law', title: 'Law', dept: 'fund', roots: ['app/library/law'] }] as any
  const put = (rel: string, text: string) => { mkdirSync(join(TMP, rel, '..'), { recursive: true }); writeFileSync(join(TMP, rel), text) }
  const chapter = (door: string) => ['## The doors and their keys', '', 'Read when: touching a credentialed door', '',
    '| Door | Credential, and who holds it | Reached through - health |', '|---|---|---|', `| ${door} | none, anonymous | \`feeds\` only - \`python -m feeds.selftest\` |`, ''].join('\n')
  const book = (title: string, ...chapters: string[]) => ['---', 'type: guide', '---', '', `# ${title}`, '', ...chapters].join('\n')

  it('finds it in whichever law book holds it: the same chapter in how-we-work.md, then moved to another book, reads the same', () => {
    put('app/library/law/how-we-work.md', book('How we work', chapter('Venue public REST'), '## Who writes where\n\nRead when: x\n'))
    const here = doorsFromLaw(TMP, law)
    expect(here).toMatchObject({ found: true, book: 'app/library/law/how-we-work.md' })
    expect(here.rows.map(r => r.name)).toEqual(['Venue public REST'])
    // the fund agent splits the book at its cap: the chapter now lives in another law book
    put('app/library/law/how-we-work.md', book('How we work', '## Who writes where\n\nRead when: x\n'))
    put('app/library/law/how-we-doors.md', book('How we open doors', chapter('Venue public REST')))
    const moved = doorsFromLaw(TMP, law)
    expect(moved).toMatchObject({ found: true, book: 'app/library/law/how-we-doors.md' })
    expect(moved.rows).toEqual(here.rows)
  })
  it('reads only the chapter: a later chapter\'s table is not a door', () => {
    put('app/library/law/how-we-doors.md', book('How we open doors', chapter('Venue public REST'), '## Other\n\nRead when: y\n\n| Door | Credential |\n|---|---|\n| Not a door | x |\n'))
    expect(doorsFromLaw(TMP, law).rows.map(r => r.name)).toEqual(['Venue public REST'])
  })
  it('no law book holds the heading: not found, never an empty list passing for "no doors"; another shelf\'s book does not count', () => {
    rmSync(join(TMP, 'app/library/law/how-we-doors.md'))
    put('app/library/platform/venues.md', book('Venues', chapter('Not on the law shelf')))
    expect(doorsFromLaw(TMP, law)).toEqual({ found: false, rows: [], book: null })
    expect(DOORS_SLUG).toBe('the-doors-and-their-keys')
  })
})
