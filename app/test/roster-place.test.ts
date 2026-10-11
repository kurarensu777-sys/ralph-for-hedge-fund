import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AGENTS_DIR, REPOS_FILE } from '../server/paths.ts'
import { readRoster } from '../server/roster.ts'
import { placeAll, placeOf, repoOfCwd, UNPLACED } from '../src/rooms/chats/place.ts'

// The chats side list is the tree (src/rooms/chats/place.ts), so the roster has to say where each
// agent lives. These run over the REAL roster: a dashboard agent that calls itself standing, or boots
// outside its own folder, or a cwd no repo owns, is red here before it is misplaced on screen.

const roster = readRoster(AGENTS_DIR)
const repos: { id: string; path: string }[] = JSON.parse(readFileSync(REPOS_FILE, 'utf8')).repos

describe('roster: every agent says where it lives', () => {
  it('reads clean', () => { expect(roster.problems).toEqual([]) })

  it('a dashboard agent is kind dashboard, id dash:<dashboard>, cwd platform/dashboards/<dashboard>', () => {
    const bad: string[] = []
    for (const h of roster.headers) {
      const dash = typeof h.dashboard === 'string' ? h.dashboard : null
      const id = String(h.id)
      if (!dash && !id.startsWith('dash:')) continue
      if (h.kind !== 'dashboard') bad.push(`${id}: kind ${h.kind}, not dashboard`)
      if (id !== `dash:${dash}`) bad.push(`${id}: id is not dash:${dash}`)
      if (h.cwd !== `platform/dashboards/${dash}`) bad.push(`${id}: cwd ${h.cwd}, not platform/dashboards/${dash}`)
    }
    expect(bad).toEqual([])
  })

  it('every cwd sits in a repo of repos.json (the fund root holds every folder in the one-repo layout)', () => {
    const paths = new Set(repos.map(r => r.path))
    const bad = roster.agents.filter(a => !paths.has('.') && !paths.has(repoOfCwd(a.cwd))).map(a => `${a.id}: ${a.cwd}`)
    expect(bad).toEqual([])
  })

  it('every agent has a place in the side list, the dashboards all inside platform', () => {
    const t = placeAll(roster.agents)
    expect(t.unplaced.map(a => a.id)).toEqual([])
    for (const a of roster.agents.filter(x => x.id.startsWith('dash:')))
      expect(placeOf(a, roster.agents), a.id).toEqual({ repo: 'platform', band: 'dashboards' })
  })
})

describe('placeOf: every branch, on made-up rosters', () => {
  const A = (id: string, cwd: string, kind = 'standing') => ({ id, cwd, kind })
  const fund = A('fund', '.'), app = A('app', 'app'), plat = A('platform', 'platform'), res = A('research', 'platform/research')
  const vol = A('dash:vol', 'platform/dashboards/vol', 'dashboard')
  const all = [fund, app, plat, res, vol]

  it('a home agent is its repo, the root is `.`', () => {
    expect(placeOf(fund, all)).toEqual({ repo: '.', band: null })
    expect(placeOf(app, all)).toEqual({ repo: 'app', band: null })
  })
  it('a tenant is a band of its own inside its repo', () => {
    expect(placeOf(res, all)).toEqual({ repo: 'platform', band: 'research' })
  })
  it('a dashboard with a WRONG kind still joins the dashboards band (the old carry fault)', () => {
    const carry = A('dash:carry', 'platform/dashboards')
    expect(placeOf(carry, [...all, carry])).toEqual({ repo: 'platform', band: 'dashboards' })
  })
  it('a cwd whose repo has no home agent is unplaced, never guessed', () => {
    const lost = A('stray', 'nowhere/deep')
    expect(placeOf(lost, [...all, lost])).toEqual({ repo: UNPLACED, band: null })
    expect(placeAll([...all, lost]).unplaced.map(a => a.id)).toEqual(['stray'])
  })
  it('bands keep roster order, the dashboards band last', () => {
    const t = placeAll([fund, plat, vol, res])
    expect(t.repos.find(r => r.home === plat)!.bands.map(b => b.id)).toEqual(['research', 'dashboards'])
  })
  it('a dormant home keeps its card', () => {
    const ex = { ...A('execution', 'execution'), mode: 'dormant' }
    expect(placeAll([...all, ex]).repos.map(r => r.home.id)).toEqual(['fund', 'app', 'platform', 'execution'])
  })
})
