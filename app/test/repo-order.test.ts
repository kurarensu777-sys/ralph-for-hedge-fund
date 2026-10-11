import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ORDER } from '../src/shell/rail.ts'
import { CATEGORIES, CATEGORY_ORDER } from '../src/ui/categories.ts'

// Two hand-written orders name the repos and the agent categories the shell draws. Each was
// missing `database` after that repo was added (B-0095): the services rail sorted it last and the
// Board room had no column for its agent. A list that has to name every repo is pinned to the
// config that defines them, so the next repo cannot be forgotten the same way.
const repos = JSON.parse(readFileSync(resolve(__dirname, '../../repos.json'), 'utf8')).repos as { id: string }[]

describe('the shell orders name every repo and every category', () => {
  it('REPO_ORDER is exactly the repos.json ids - none missing, none retired', () => {
    expect([...REPO_ORDER].sort()).toEqual(repos.map(r => r.id).sort())
  })
  it('CATEGORY_ORDER lists every category exactly once', () => {
    expect([...CATEGORY_ORDER].sort()).toEqual(Object.keys(CATEGORIES).sort())
  })
  it('the database category sits between platform and execution', () => {
    const order = CATEGORY_ORDER as string[]
    expect(order.indexOf('database')).toBeGreaterThan(order.indexOf('platform'))
    expect(order.indexOf('database')).toBeLessThan(order.indexOf('execution'))
  })
})
