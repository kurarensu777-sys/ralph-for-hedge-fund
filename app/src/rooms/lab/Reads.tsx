import { useState } from 'react'
import { Btn, Dot } from '../../ui/kit.tsx'
import { api, relTime, stamp, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'

// ROOM: lab - the fixed-age read, run from here: app/loop/tools/remeasure.py in the background,
// logged under ~/fund-data/logs/lab/. The tool decides whether the read is due; a refusal lands
// in the log and the exit code, verbatim.

export type Job = { key: string; desk: string; run: string; age: string; dry: boolean; started: number; ended: number | null; code: number | null; log: string; tail: string }
type Jobs = { jobs: Job[]; logs: { name: string; mtime: number; size: number }[]; dir: string }

export function useJobs() { return useApi<Jobs>('/api/lab/jobs', ['lab']) }

export function jobState(j: Job): { s: string; label: string } {
  if (j.ended === null) return { s: 'run', label: 'running' }
  if (j.code === 0) return { s: 'ok', label: j.dry ? 'dry ok' : 'done' }
  if (j.code === 1) return { s: 'fail', label: 'refused' }
  return { s: 'fail', label: `exit ${j.code ?? '-'}` }
}

/** "Run +7d" for one read of one run, with its last job's state and log tail */
export function ReadAction({ desk, run, age, state, note }: { desk: string; run: string; age: '7d' | '30d'; state: string; note?: string }) {
  const q = useJobs()
  const { toast, openDrawer } = useNav()
  const [busy, setBusy] = useState(false)
  const job = q.data?.jobs.find(j => j.key === `${desk}#${run}@${age}`) ?? null
  const running = job?.ended === null
  const owed = state === 'due' || state === 'late'
  const start = async (dry: boolean) => {
    setBusy(true)
    try { await api('/api/lab/read', { body: { desk, run, age, dry } }) }
    catch (e: any) { toast(e.message, true) }
    finally { setBusy(false) }
  }
  const st = job ? jobState(job) : null
  return <div className="lab-read">
    <div className="lab-read-row">
      <span className="mono faint">+{age}</span>
      <span className={state === 'late' ? 't-fail' : state === 'due' ? 't-warn' : state === 'done' ? 't-ok' : 'faint'}>{state}</span>
      {note && <span className="mono faint lab-read-note">{note}</span>}
      <span className="lab-read-sp" />
      {st && <span className="lab-read-st" title={job ? `${job.log}\nstarted ${stamp(job.started)}` : ''}><Dot s={st.s} /> {st.label}{job?.ended ? ` ${relTime(job.ended)}` : ''}</span>}
      {owed && <>
        <Btn sm kind="ghost" disabled={busy || running} title={`remeasure.py --dry: say what would run, execute nothing`} onClick={() => start(true)}>Dry</Btn>
        <Btn sm kind="primary" disabled={busy || running} title={`remeasure.py --desk ${desk} --run ${run} --age ${age}: re-runs the recorded command on the rolled window (minutes to an hour)`} onClick={() => start(false)}>{running ? 'Running' : `Run +${age}`}</Btn>
      </>}
      {job && <Btn sm kind="ghost" title="the whole log" onClick={() => openDrawer({ title: <span className="mono">{job.log}</span>, body: <LogView name={job.log} /> })}>Log</Btn>}
    </div>
    {job && job.tail && <pre className="pre short lab-tail">{job.tail.replace(/\r/g, '').trim().split('\n').slice(-8).join('\n')}</pre>}
  </div>
}

export function LogView({ name }: { name: string }) {
  const q = useApi<{ text: string }>(`/api/lab/log?name=${encodeURIComponent(name)}`, ['lab'])
  if (q.error) return <pre className="pre t-fail lab-refused">{q.error}</pre>
  return <pre className="pre tall">{q.data?.text ?? ''}</pre>
}
