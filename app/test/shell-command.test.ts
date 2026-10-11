import { describe, expect, it } from 'vitest'
import { arrange, convDot, flat, matches, sectionOf, type Cmd } from '../src/shell/command.ts'
import { islandOf } from '../src/shell/island.ts'
import { categoryOf, initials } from '../src/ui/categories.ts'

const c = (section: Cmd['section'], label: string, hint?: string): Cmd => ({ section, label, hint, run: () => {} })

describe('command bar', () => {
  it('sorts room kinds into sections', () => {
    expect(sectionOf('dash')).toBe('Dashboards')
    expect(sectionOf('book')).toBe('Books')
    expect(sectionOf('text')).toBe('Books')
    expect(sectionOf('board')).toBe('Board')
    expect(sectionOf('run')).toBe('Runs')
    expect(sectionOf('library')).toBe('Actions')
    expect(sectionOf('room')).toBe('Actions')
  })

  it('keeps the fixed section order and drops empty sections', () => {
    const gs = arrange([c('Actions', 'Go to Board'), c('Recent', 'pm-002'), c('Books', 'How a belief moves')], '')
    expect(gs.map(g => g.section)).toEqual(['Recent', 'Books', 'Actions'])
  })

  it('matches every word, anywhere in label or hint (not the section name); label prefix ranks first', () => {
    expect(matches(c('Dashboards', 'Trade'), 'board')).toBe(false)
    expect(matches(c('Books', 'How a belief moves', 'fund'), 'belief fund')).toBe(true)
    expect(matches(c('Books', 'How a belief moves'), 'belief venue')).toBe(false)
    const gs = arrange([c('Actions', 'Sync every repo'), c('Actions', 'Go to System')], 'sy')
    expect(flat(gs).map(x => x.label)).toEqual(['Sync every repo', 'Go to System'])
  })

  it('caps sections when idle, and appends server hits unfiltered and deduplicated', () => {
    const many = Array.from({ length: 20 }, (_, i) => c('Recent', `chat ${i}`))
    expect(arrange(many, '')[0].items.length).toBe(6)
    const gs = arrange([c('Books', 'Carry law')], 'carry', [c('Books', 'Carry law'), c('Books', 'A body hit without the word')])
    expect(flat(gs).map(x => x.label)).toEqual(['Carry law', 'A body hit without the word'])
  })

  it('a typed exact or prefix label leads the list across sections, ahead of full-text book hits', () => {
    const books = Array.from({ length: 8 }, (_, i) => c('Books', `Book ${i}`))
    const gs = arrange([c('Actions', 'Go to Board'), c('Actions', 'Go to Chats')], 'go to board', books)
    expect(flat(gs)[0].label).toBe('Go to Board')
    expect(gs[0].section).toBe('Actions')
    // a prefix hit also leads, and with no label hit the fixed order stands
    expect(flat(arrange([c('Actions', 'Go to Board')], 'go to b', books))[0].label).toBe('Go to Board')
    expect(arrange([c('Recent', 'x board'), c('Books', 'y board')], 'board').map(g => g.section)).toEqual(['Recent', 'Books'])
  })

  it('a conversation state is one dot', () => {
    expect(convDot('live')).toBe('run')
    expect(convDot('waiting')).toBe('ask')
    expect(convDot('closed')).toBe('off')
  })
})

describe('command bar: a room name reaches its room', () => {
  const rooms = ['Board', 'System', 'Git', 'Lab', 'Chats'].map(r => c('Actions', `Go to ${r}`))
  const noise = [
    c('Dashboards', 'Trade', 'live dashboard'),
    c('Books', 'System health book', 'library'),
    c('Board', 'B-0056 git land queue', 'app'),
    c('Agents', 'Research', 'lab desks and studies'),
    c('Agents', 'Platform', 'the board of engines'),
  ]
  it.each([['board', 'Go to Board'], ['system', 'Go to System'], ['git', 'Go to Git'], ['lab', 'Go to Lab'], ['Lab', 'Go to Lab'], ['sys', 'Go to System']])('%s -> %s', (q, want) => {
    expect(flat(arrange([...noise, ...rooms], q))[0].label).toBe(want)
  })
  it('an Agents row never leads a tie (Enter there starts a conversation)', () => {
    const gs = arrange([c('Agents', 'Lab keeper'), c('Actions', 'Go to Lab')], 'lab')
    expect(flat(gs)[0].label).toBe('Go to Lab')
  })
})

describe('activity island', () => {
  it('draws nothing when unknown or when nothing works and nobody waits', () => {
    expect(islandOf(null).shown).toBe(false)
    expect(islandOf([{ id: 'app', working: 0, waiting: 0 }]).shown).toBe(false)
  })

  it('counts working and waiting, needs-you avatars first', () => {
    const s = islandOf([
      { id: 'app', working: 2, waiting: 0 },
      { id: 'fund', working: 0, waiting: 0 },
      { id: 'research', working: 0, waiting: 1 },
    ])
    expect(s).toMatchObject({ shown: true, working: 2, waiting: 1 })
    expect(s.agents.map(a => a.id)).toEqual(['research', 'app'])
  })
})

describe('categories', () => {
  it('dashboards share one colour; standing agents their own; initials are two letters', () => {
    expect(categoryOf('dash:vol').id).toBe('dashboards')
    expect(categoryOf('platform').color).toBe('#4fb3c9')
    expect(categoryOf('nobody').id).toBe('fund')
    expect(initials('dash:vol')).toBe('VO')
    expect(initials('research')).toBe('RE')
    expect(initials('dash:sell-vol')).toBe('SV')
  })
})

describe('command bar: pinned actions', () => {
  it('lead the idle list, and fall back into Actions once a query is typed', () => {
    const pin = { ...c('Actions', 'File a board item'), pin: true }
    const rows = [c('Recent', 'pm-002'), c('Actions', 'Go to Board'), pin]
    const idle = arrange(rows, '')
    expect(idle[0].section).toBe('Actions')
    expect(idle[0].items.map(x => x.label)).toEqual(['File a board item'])
    expect(idle[idle.length - 1].items.map(x => x.label)).toEqual(['Go to Board'])
    const q = arrange(rows, 'file')
    expect(q.map(g => g.section)).toEqual(['Actions'])
    expect(q[0].items.map(x => x.label)).toEqual(['File a board item'])
  })
})

describe('categories: a chart family', () => {
  it('dashboards shades are tints of one pink: the hue never moves toward the fail red', async () => {
    const { agentColor } = await import('../src/ui/categories.ts')
    const peers = Array.from({ length: 9 }, (_, i) => `dash:d${i}`)
    const hue = (hex: string) => {
      const n = parseInt(hex.slice(1), 16), r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
      return mx === r ? ((g - b) / d + 6) % 6 * 60 : mx === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60
    }
    const shades = peers.map(p => agentColor(p, peers))
    expect(new Set(shades).size).toBeGreaterThanOrEqual(8)
    for (const s of shades) expect(Math.abs(hue(s) - hue('#e0739c'))).toBeLessThan(3)
  })
})
