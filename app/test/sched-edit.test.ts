import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setJobBrain } from '../server/sched/edit.ts'
import { loadJobs } from '../server/sched/plan.ts'
import { SCHEDULE_FILE } from '../server/paths.ts'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'sched-edit-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const AGENT = { id: 'nightly-retro', kind: 'agent', agent: 'research', prompt: 'run the retro', cadence: 'daily 03:00' }
const SCRIPT = { id: 'sweep', cmd: ['python', '-m', 'x'], cadence: 'daily 06:30', cwd: 'platform' }

describe('schedule.json: an agent job names its own model', () => {
  it('the real schedule.json survives a round trip byte for byte', () => {
    const f = join(tmp(), 'schedule.json')
    copyFileSync(SCHEDULE_FILE, f)
    const before = readFileSync(f, 'utf8')
    expect(JSON.stringify(JSON.parse(before), null, 2) + '\n').toBe(before)
  })

  it('sets and clears model/effort on an agent job, and refuses a script job', () => {
    const f = join(tmp(), 'schedule.json')
    writeFileSync(f, JSON.stringify({ jobs: [AGENT, SCRIPT] }, null, 2) + '\n')
    expect(setJobBrain(f, 'nightly-retro', { model: 'claude-fable-5-1', effort: 'max' })).toEqual({ model: 'claude-fable-5-1', effort: 'max' })
    const j = loadJobs(JSON.parse(readFileSync(f, 'utf8'))).jobs.find(x => x.id === 'nightly-retro')!
    expect([j.model, j.effort]).toEqual(['claude-fable-5-1', 'max'])
    expect(setJobBrain(f, 'nightly-retro', { model: null })).toEqual({ model: '', effort: 'max' })
    expect(() => setJobBrain(f, 'sweep', { model: 'claude-sonnet-5' })).toThrow(/script job: it runs no model/)
    expect(() => setJobBrain(f, 'nope', { model: 'claude-sonnet-5' })).toThrow(/no job nope/)
  })

  it('refuses an alias, and a model on a script job, when it parses the schedule', () => {
    const r = loadJobs({ jobs: [{ ...AGENT, model: 'opus' }, { ...SCRIPT, model: 'claude-sonnet-5' }, { ...AGENT, id: 'ok', model: 'claude-opus-5-5[1m]' }] })
    expect(r.errors.join('\n')).toMatch(/nightly-retro: model "opus" is not an exact id/)
    expect(r.errors.join('\n')).toMatch(/sweep: a script job runs no model/)
    expect(r.jobs.map(j => j.id)).toEqual(['ok'])
  })

  it('a write that would leave the job unparseable is refused and the file is untouched', () => {
    const f = join(tmp(), 'schedule.json')
    writeFileSync(f, JSON.stringify({ jobs: [AGENT] }, null, 2) + '\n')
    const before = readFileSync(f, 'utf8')
    expect(() => setJobBrain(f, 'nightly-retro', { model: 'sonnet' })).toThrow(/not an exact id/)
    expect(readFileSync(f, 'utf8')).toBe(before)
  })
})
