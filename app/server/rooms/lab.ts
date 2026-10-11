import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Router } from '../http.ts'
import { HttpError } from '../http.ts'
import type { ServiceGroup } from '../../shared/types.ts'
import { FUND_ROOT, LOG_DIR, PYTHON, deskDir, deskRel } from '../paths.ts'
import { publish } from '../events.ts'
import { logEvent } from '../db.ts'
import { agentEnv } from '../chat/env.ts'
import { config } from '../config.ts'
import { allDesks, entryBlock, loadAll, preflightLine, type Run } from '../lab/runs.ts'
import { pinnedHashes, pinsWhy, refreshPins } from '../lab/pins.ts'
import { deskChart } from '../lab/chart.ts'
import { deskTrials, slim } from '../lab/trials.ts'
import { deskFacts, nextRunId } from '../lab/desk.ts'
import { readStages, setStage, StageRefused, STAGES, type Stage } from '../lab/stages.ts'
import { deskRetro } from '../lab/retro.ts'
import { BadInput, checkDesk, preregArgs, readLog, ReadJobs, recentLogs, refusalOf, runTool, type ToolDeps } from '../lab/tools.ts'

// ROOM: lab - every experiment: lab/**/data/runs.jsonl + each desk's results-log.md, and the loop's
// own tools run from here: preregister.py (the pre-flight), remeasure.py (the fixed-age read).

const LAB_LOGS = join(LOG_DIR, 'lab')

function readText(p: string): string | null {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

/** the seat per desk folder: org.json is retired (2026-09-24), so the seat is the roster agent
 *  whose `writes` cover the desk's folder - the one hand that may land its records */
function seats(agents = config.agents()): Map<string, string> {
  const m = new Map<string, string>()
  for (const d of allDesks(FUND_ROOT)) { const a = agentFor(d, agents); if (a) m.set(d, a) }
  return m
}

/** the roster agent that may write this desk's folder (deskRel: platform/lab/<name>), if any */
function agentFor(desk: string, agents = config.agents()): string | null {
  const dir = deskRel(desk) + '/'
  const a = agents.find(x => x.writes.some(w => dir.startsWith(w.replace(/\\/g, '/'))))
  return a?.id ?? null
}

/** the MOST SPECIFIC roster writer of this desk (the longest matching writes prefix): the desk's
 *  owner colour in the runs table. `agentFor` keeps the first match (the fund writes the whole lab) */
function ownerOf(desk: string, agents = config.agents()): string | null {
  const dir = deskRel(desk) + '/'
  let best: { id: string; n: number } | null = null
  for (const x of agents) for (const w0 of x.writes) {
    const w = w0.replace(/\\/g, '/')
    if (dir.startsWith(w) && (!best || w.length > best.n)) best = { id: x.id, n: w.length }
  }
  return best?.id ?? null
}

type StageMap = Map<string, Record<string, { stage: Stage; since?: string; note?: string }>>

// the roster is read ONCE per snapshot and handed down: agentFor/ownerOf run per run row, and a
// fresh roster read each (every agents/*.md read and parsed) held the event loop ~200 ms a snapshot
function view(r: Run, seat: Map<string, string>, stages: StageMap, agents = config.agents()) {
  const { rows: _rows, ...rest } = r
  const st = r.mechanic ? stages.get(r.desk)?.[r.mechanic]?.stage ?? null : null
  // the trial ledger's scalars: dsr, pbo, n_trials (all null when the run has no trial rows)
  const tr = slim(deskTrials(FUND_ROOT, r.desk).stats(r.run))
  return { ...rest, ...tr, seat: seat.get(r.desk) ?? null, agent: agentFor(r.desk, agents), owner: ownerOf(r.desk, agents), mstage: st }
}

let cache: { at: number; body: unknown } | null = null
const bust = () => { cache = null }

function toolDeps(): ToolDeps {
  return { python: PYTHON, fundRoot: FUND_ROOT, env: agentEnv({ ...process.env, FUND_ROOT }) as NodeJS.ProcessEnv }
}

const jobs = new ReadJobs({
  ...toolDeps(),
  logDir: LAB_LOGS,
  onChange: j => {
    bust()
    if (j.ended !== null) logEvent('job', `lab read ${j.desk} #${j.run} +${j.age}${j.dry ? ' (dry)' : ''} exited ${j.code}`, { payload: { log: j.log, tail: j.tail.slice(-600) } })
    publish('lab', { read: j.key, ended: j.ended !== null, code: j.code })
    publish('services')
  },
})

function snapshot() {
  void refreshPins()
  if (cache && Date.now() - cache.at < 3_000) return cache.body
  const now = Date.now()
  const all = loadAll(FUND_ROOT, now, pinnedHashes())
  const agents = config.agents()
  const seat = seats(agents)
  const stages: StageMap = new Map(all.map(d => [d.desk, readStages(FUND_ROOT, d.desk).mechanics]))
  const runs = all.flatMap(d => d.runs.map(r => view(r, seat, stages, agents)))
  runs.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0) || b.run.localeCompare(a.run))
  const readsDue = runs.flatMap(r => (['7d', '30d'] as const)
    .filter(age => r.reads[age].state === 'due' || r.reads[age].state === 'late')
    .map(age => {
      const j = jobs.get(`${r.desk}#${r.run}@${age}`)
      return { key: r.key, desk: r.desk, run: r.run, age, due: r.reads[age].due, state: r.reads[age].state, job: j ? { running: j.ended === null, code: j.code, dry: j.dry } : null }
    }))
    .sort((a, b) => (a.due ?? 0) - (b.due ?? 0))
  const desks = all.map(d => ({
    desk: d.desk, seat: seat.get(d.desk) ?? null, hasFile: d.hasFile, bad: d.bad,
    runs: d.runs.length,
    imported: d.runs.filter(r => !r.preregistered).length,
    preregistered: d.runs.filter(r => r.preregistered).length,
    retro: deskRetro(d.desk, readText(join(deskDir(d.desk), 'beliefs.md')), readText(join(deskDir(d.desk), 'data', 'runs.jsonl')), now),
  }))
  const body = { now, runs, desks, readsDue, running: jobs.running().length, pins: { known: pinnedHashes() !== null, why: pinsWhy() } }
  cache = { at: Date.now(), body }
  return body
}

function deskOf(q: URLSearchParams | Record<string, unknown>, key = 'desk'): string {
  const raw = q instanceof URLSearchParams ? q.get(key) : q[key]
  let d: string
  try { d = checkDesk(raw) } catch (e: any) { throw new HttpError(400, e.message) }
  if (!existsSync(join(deskDir(d), 'cadence.md'))) throw new HttpError(404, `no desk ${d} (a desk is a lab/ folder holding a cadence.md)`)
  return d
}

const bad = (e: any): never => { if (e instanceof BadInput) throw new HttpError(400, e.message); throw e }

export function register(r: Router) {
  r.get('/api/lab/runs', () => snapshot())

  r.get('/api/lab/run', ({ query }) => {
    const desk = (query.get('desk') ?? '').replace(/\\/g, '/')
    const id = query.get('run') ?? ''
    if (!/^lab(\/[A-Za-z0-9_.-]+)+$/.test(desk) || desk.includes('..')) throw new HttpError(400, 'desk must be a lab/... folder')
    const run = loadAll(FUND_ROOT).find(d => d.desk === desk)?.runs.find(x => x.run === id)
    if (!run) throw new HttpError(404, `no run ${id} at ${desk}`)
    const log = readText(join(deskDir(desk), 'results-log.md'))
    const entry = log === null ? null : entryBlock(log, id)
    const stages: StageMap = new Map([[desk, readStages(FUND_ROOT, desk).mechanics]])
    const agents = config.agents()
    return {
      ...view(run, seats(agents), stages, agents),
      rows: run.rows,
      entry,
      preflight: preflightLine(entry),
      logFile: log === null ? null : `${desk}/results-log.md`,
    }
  })

  // ---- TRIALS: the ledger behind one run's DSR and PBO (lab/<desk>/data/trials.jsonl) ----
  r.get('/api/lab/trials', ({ query }) => {
    const key = query.get('key') ?? ''
    const i = key.lastIndexOf('#')
    const desk = key.slice(0, i).replace(/\\/g, '/'), run = key.slice(i + 1)
    if (i < 0 || !run || !/^lab(\/[A-Za-z0-9_.-]+)+$/.test(desk) || desk.includes('..')) throw new HttpError(400, 'key must be <lab desk>#<run>')
    const t = deskTrials(FUND_ROOT, desk)
    const st = t.stats(run)
    const { logits: _l, ...pbo } = st.pbo ?? ({} as any)
    return {
      key, desk, run, ledger: `${desk}/data/trials.jsonl`, exists: t.exists,
      rows: t.ledger.filter(x => x.run === run).length,
      n_trials: st.n_trials, run_trials: st.run_trials, by_status: st.by_status,
      dsr: st.dsr, pbo: st.pbo ? pbo : null,
    }
  })

  // ---- one desk: the pickers the pre-register form needs, and the mechanics with their stages ----
  r.get('/api/lab/desk', ({ query }) => {
    const desk = deskOf(query)
    const facts = deskFacts(FUND_ROOT, desk)
    const st = readStages(FUND_ROOT, desk)
    const runs = loadAll(FUND_ROOT).find(d => d.desk === desk)?.runs ?? []
    const ids = runs.map(x => x.run)
    const last = [...runs].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.run.localeCompare(b.run)).at(-1) ?? null
    const byMech = new Map<string, number>()
    for (const x of runs) if (x.mechanic) byMech.set(x.mechanic, (byMech.get(x.mechanic) ?? 0) + 1)
    return {
      desk,
      mechanics: facts.mechanics.map(m => ({ ...m, runs: byMech.get(m.id) ?? 0, stage: st.mechanics[m.id] ?? null })),
      orphans: Object.keys(st.mechanics).filter(k => !facts.mechanics.some(m => m.id === k)),
      beliefs: facts.beliefs,
      runs: ids,
      nextRun: nextRunId(ids),
      last: last ? { run: last.run, cmd: last.rows.find(x => x.cmd)?.cmd ?? null, window: last.window, cwd: last.rows.find(x => x.cwd)?.cwd ?? null } : null,
      stages: { file: st.file, exists: st.exists, bad: st.bad },
      stageIds: STAGES,
    }
  })

  // ---- PRE-REGISTER: preregister.py decides; its refusal is shown verbatim ----
  r.post('/api/lab/preregister', async ({ body }) => {
    const f = await body()
    let args: string[]
    try { args = preregArgs({ ...f, desk: deskOf(f ?? {}) }) } catch (e) { return bad(e) }
    const out = await runTool(toolDeps(), args, 90_000)
    const refused = refusalOf(out)
    let row: unknown = null
    if (out.code === 0 && !f.dry) { try { row = JSON.parse(out.stdout) } catch { row = null } }
    if (out.code === 0 && !f.dry) {
      bust()
      logEvent('lab', `pre-registered ${f.desk} #${f.run}`, { payload: { args: args.slice(1) } })
      publish('lab', { preregistered: `${f.desk}#${f.run}` })
    }
    return { ok: out.code === 0, dry: !!f.dry, code: out.code, refused, stdout: out.stdout, stderr: out.stderr, row, argv: ['python', ...args] }
  })

  // ---- RE-READ: remeasure.py in the background ----
  r.post('/api/lab/read', async ({ body }) => {
    const f = await body()
    const desk = deskOf(f ?? {})
    try {
      const j = jobs.start(desk, String(f.run ?? ''), String(f.age ?? ''), !!f.dry)
      return { ...j, log: j.log.replace(/\\/g, '/').split('/').at(-1) }
    } catch (e) { return bad(e) }
  })

  r.get('/api/lab/jobs', () => ({
    jobs: jobs.list().map(j => ({ ...j, log: j.log.replace(/\\/g, '/').split('/').at(-1) })),
    logs: recentLogs(LAB_LOGS),
    dir: LAB_LOGS,
  }))

  r.get('/api/lab/log', ({ query }) => {
    const text = readLog(LAB_LOGS, query.get('name') ?? '')
    if (text === null) throw new HttpError(404, 'no such log')
    return { name: query.get('name'), text }
  })

  // ---- STAGES: lab/<desk>/stages.json ----
  r.post('/api/lab/stage', async ({ body }) => {
    const f = await body()
    const desk = deskOf(f ?? {})
    const mech = String(f.mechanic ?? '')
    const stage = f.stage === null || f.stage === '' || f.stage === undefined ? null : String(f.stage) as Stage
    const known = deskFacts(FUND_ROOT, desk).mechanics.map(m => m.id)
    try {
      const out = setStage(FUND_ROOT, desk, mech, stage, { known, note: typeof f.note === 'string' ? f.note : undefined })
      bust()
      logEvent('lab', `stage ${desk} ${mech} -> ${stage ?? 'unset'}`)
      publish('lab', { stage: `${desk}#${mech}` })
      return out
    } catch (e: any) {
      if (e instanceof StageRefused) throw new HttpError(409, e.message)
      throw e
    }
  })

  // ---- CHART: predicted band vs measured, by run ----
  r.get('/api/lab/chart', ({ query }) => {
    const desk = deskOf(query)
    const runs = loadAll(FUND_ROOT).find(d => d.desk === desk)?.runs ?? []
    return deskChart(desk, runs, query.get('metric'))
  })
}

export async function services(): Promise<ServiceGroup | null> {
  const s = snapshot() as { readsDue: { state: string }[]; runs: unknown[]; running: number }
  const late = s.readsDue.filter(x => x.state === 'late').length
  return {
    id: 'lab', label: 'Lab',
    rows: [{
      id: 'lab:reads', label: 'reads due', room: 'lab',
      status: s.running ? 'run' : s.readsDue.length === 0 ? 'ok' : 'warn',
      reading: s.running ? `${s.running} read running` : s.readsDue.length === 0 ? `none - ${s.runs.length} runs` : `${s.readsDue.length} due${late ? `, ${late} late` : ''}`,
    }],
  }
}
