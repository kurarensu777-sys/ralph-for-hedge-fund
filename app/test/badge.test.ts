import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAgentFileName, parseAgentFile } from '../shared/agentfile.ts'
import { badgeCollisions, badgeMap } from '../shared/badge.ts'

describe('agent badges', () => {
  it('Trade and TradFi never share a badge', () => {
    const m = badgeMap(['dash:trade', 'dash:tradfi', 'fund'])
    expect(m.get('dash:trade')).toBe('TR')
    expect(m.get('dash:tradfi')).toBe('TD')
    expect(m.get('fund')).toBe('FU')
  })
  it('is order independent', () => {
    expect(badgeMap(['dash:tradfi', 'dash:trade']).get('dash:tradfi')).toBe('TD')
  })
  it('every agent in the roster has its own badge', () => {
    // the roster is app/agents/<id>.md since 2026-09-25 (the root agents.json is retired): read every header
    const dir = join(__dirname, '..', 'agents')
    const ids = readdirSync(dir).filter(isAgentFileName).map(f => String(parseAgentFile(readFileSync(join(dir, f), 'utf8')).header.id))
    expect(ids.length).toBeGreaterThan(3)
    expect(badgeCollisions(ids)).toEqual([])
    expect(badgeCollisions(['a:trade', 'b:trade2', 'c:tr'])).toEqual([])
  })
})
