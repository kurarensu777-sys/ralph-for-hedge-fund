import { useState } from 'react'
import { Empty, Load } from '../../ui/kit.tsx'
import { api, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'

// ROOM: lab - one desk's mechanics with their promotion stage (lab/<desk>/stages.json).

export type StageEntry = { stage: string; since?: string; note?: string }
export type Mech = { id: string; name: string; status: string; runs: number; stage: StageEntry | null }
export type DeskInfo = {
  desk: string; mechanics: Mech[]; orphans: string[]
  beliefs: { id: string; claim: string; placeholder: boolean }[]
  runs: string[]; nextRun: string
  last: { run: string; cmd: string | null; window: any; cwd: string | null } | null
  stages: { file: string; exists: boolean; bad: string | null }
  stageIds: string[]
}

export const STAGE_TIP: Record<string, string> = {
  idea: 'named in mechanics.md, not yet run as a pre-registered experiment',
  tested: 'pre-registered runs with results behind it',
  paper: 'running on paper: a forward read, no money',
  live: 'trading money. Set by the owner by hand in stages.json; the cockpit never writes it',
}

export function useDesk(desk: string | null) {
  return useApi<DeskInfo>(desk ? `/api/lab/desk?desk=${encodeURIComponent(desk)}` : null, ['lab'])
}

/** the stage tag's tone: idea faint, tested bright, paper accent, live ok (owner-set) */
const STAGE_TONE: Record<string, string> = { idea: 'faint', tested: 'text', paper: 'accent', live: 'ok' }

export function StagePill({ s }: { s: string | null | undefined }) {
  if (!s) return <span className="nil" title="no stage in stages.json" />
  return <span className={`tag sm ${STAGE_TONE[s] ?? ''}`} title={STAGE_TIP[s] ?? s}>{s}</span>
}

export function Mechanics({ desk }: { desk: string }) {
  const q = useDesk(desk)
  const { toast } = useNav()
  const [busy, setBusy] = useState<string | null>(null)
  const set = async (mechanic: string, stage: string) => {
    setBusy(mechanic)
    try { await api('/api/lab/stage', { body: { desk, mechanic, stage: stage || null } }) }
    catch (e: any) { toast(e.message, true) }
    finally { setBusy(null) }
  }
  return <div className="lab-mech">
    <Load q={q}>{d => <>
      <div className="lab-chart-head">
        <span className="cap" title={`${d.stages.file}${d.stages.exists ? '' : ' (not written yet)'}`}>Stages</span>
        {d.stages.bad && <span className="t-fail lab-small" title={d.stages.file}>{d.stages.bad}</span>}
        {d.orphans.length > 0 && <span className="t-warn lab-small" title="keys in stages.json that are not rows in mechanics.md">orphan {d.orphans.join(' ')}</span>}
      </div>
      {d.mechanics.length === 0 ? <Empty inline title="NONE">no M rows in mechanics.md</Empty> :
        <table className="tbl lab-mtbl"><tbody>{d.mechanics.map(m => {
          const live = m.stage?.stage === 'live'
          return <tr key={m.id}>
            <td className="mono faint">{m.id}</td>
            <td className="lab-mname" title={`${m.name}\n${m.status}`}>{m.name}</td>
            <td className="num faint" title="runs in the ledger naming this mechanic">{m.runs}</td>
            <td className="lab-mstage" title={m.stage ? `${STAGE_TIP[m.stage.stage] ?? ''}${m.stage.since ? `\nsince ${m.stage.since}` : ''}${m.stage.note ? `\n${m.stage.note}` : ''}` : 'unset'}>
              {live ? <StagePill s="live" /> :
                <select className={`input lab-ssel s-${m.stage?.stage ?? 'unset'}`} value={m.stage?.stage ?? ''} disabled={busy === m.id} onChange={e => set(m.id, e.target.value)}>
                  <option value="">-</option>
                  {['idea', 'tested', 'paper'].map(s => <option key={s} value={s}>{s}</option>)}
                </select>}
            </td>
          </tr>
        })}</tbody></table>}
    </>}</Load>
  </div>
}
