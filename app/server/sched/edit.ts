import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { loadJobs } from './plan.ts'

/**
 * Set (or clear, with null / '') an AGENT job's model and effort in schedule.json, in place: the file is
 * re-serialized with the same 2-space JSON it is written in (a round trip leaves it byte-identical,
 * test/sched-edit.test.ts), written to a temp file and renamed over, and the result is parsed back
 * before it lands so a write can never leave a schedule the scheduler refuses.
 */
export function setJobBrain(file: string, id: string, brain: { model?: string | null; effort?: string | null }): { model: string; effort: string } {
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  const rows: any[] = Array.isArray(doc) ? doc : doc?.jobs
  const row = Array.isArray(rows) ? rows.find(r => r?.id === id) : null
  if (!row) throw Object.assign(new Error(`no job ${id} in schedule.json`), { status: 404 })
  const parsed = loadJobs(doc).jobs.find(j => j.id === id)
  if (parsed?.kind !== 'agent') throw Object.assign(new Error(`${id} is a script job: it runs no model`), { status: 400 })
  for (const k of ['model', 'effort'] as const) {
    if (brain[k] === undefined) continue
    if (brain[k]) row[k] = brain[k]; else delete row[k]
  }
  const back = loadJobs(doc)
  const bad = back.errors.find(e => e.startsWith(`${id}:`))
  if (bad) throw Object.assign(new Error(bad), { status: 400 })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  return { model: String(row.model ?? ''), effort: String(row.effort ?? '') }
}
