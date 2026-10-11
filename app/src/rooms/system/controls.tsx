import { useEffect, useState, type ReactNode } from 'react'
import type { PermittedRead } from '../../../shared/models.ts'
import { api, stamp, useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Btn, Dot, Load } from '../../ui/kit.tsx'
import type { ControlsState } from '../../../server/system/controls.ts'

// System > Controls: the few decisions that govern what runs unattended and what it spends, each row ONE
// control with the chip beside it saying what is true now (held by Pause, capped, mixed), never a green
// dot it did not measure. Reads GET /api/system/controls; every write goes to the route its setting
// already had (server/system/controls.ts CONTROLS names them). Every row carries data-control=<id>:
// test/controls.test.ts holds that table to this file.

export const TOPICS = ['system', 'board', 'loop', 'config', 'services']
export const useControls = () => useApi<ControlsState>('/api/system/controls', TOPICS)

/** "5m" -> 5000000, "250k" -> 250000, "1200000" as written; null for empty or nothing usable */
export function parseTokens(s: string): number | null | undefined {
  const t = s.trim().toLowerCase().replace(/[, _]/g, '')
  if (!t || t === 'none' || t === 'off') return null
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(t)
  if (!m) return undefined
  const n = Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1))
  return n > 0 ? n : undefined
}

const fmtTokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}m` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n))

function Chip({ tone, children, title }: { tone: 'ok' | 'warn' | 'fail' | 'faint'; children: ReactNode; title?: string }) {
  return <span className={`pill lbl ${tone}`} title={title}>{children}</span>
}

function Row({ id, on, onFlip, name, sub, chip, children, title }: {
  id: string; on?: boolean; onFlip?: () => void; name: string; sub: string; chip: ReactNode; children?: ReactNode; title?: string
}) {
  return <div className="system-ctl-row" data-control={id} title={title}>
    <span className="system-ctl-sw">{on === undefined ? null
      : <button className={`tog ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={name} onClick={onFlip}><i /></button>}</span>
    <span className="system-ctl-nm">{name}<span className="faint">{sub}</span></span>
    <span className="system-ctl-chip">{chip}</span>
    <span className="system-ctl-ctl">{children}</span>
  </div>
}

export function ControlsView() {
  const q = useControls()
  const mq = useApi<PermittedRead>('/api/chats/models', ['config'])
  const { toast } = useNav()
  const models = mq.data?.models ?? []
  const [busy, setBusy] = useState(false)
  const act = async (what: string, path: string, body: unknown) => {
    if (busy) return
    setBusy(true)
    try { await api(path, { body }); toast(what); q.reload() } catch (e: any) { toast(`${what}: ${e.message}`, true) } finally { setBusy(false) }
  }

  return <Load q={q}>{c => <>
    <Master c={c} act={act} busy={busy} />
    <div className="system-ctl-list">
      <BoardRow c={c} models={models.map(m => ({ id: m.id, name: m.name }))} act={act} />
      <Row id="loop" on={c.loop.auto} onFlip={() => act(`loop: ${c.loop.auto ? 'manual' : 'auto'}`, '/api/loop/config', { autoApply: !c.loop.auto })}
        name="Loop" sub={c.loop.auto ? 'applies its own improvements' : 'manual: it proposes, you decide'}
        chip={c.loop.auto ? (c.paused ? <Chip tone="warn" title="the loop pass is a scheduled job: Pause holds it">held: pause</Chip> : <Chip tone="ok">auto</Chip>) : <Chip tone="faint">manual</Chip>} />
      <Row id="wakes" on={c.wakes} onFlip={() => act(`dashboard wakes ${c.wakes ? 'off' : 'on'}`, '/api/system/controls', { wakes: !c.wakes })}
        name="Dashboard wakes" sub="a failing dashboard calls its agent"
        title="on_fail: wake_agent in a dashboard.json starts a chat with its agent, once per 6 hours; this switch holds every one"
        chip={c.wakes ? (c.paused ? <Chip tone="warn">held: pause</Chip> : <Chip tone="ok">on</Chip>) : <Chip tone="faint">off</Chip>} />
      <CapRow c={c} act={act} />
      <ModelRow c={c} models={models.map(m => ({ id: m.id, name: m.name }))} listError={mq.error ?? mq.data?.error ?? null} act={act} />
    </div>
    <div className="system-ctl-foot faint">Execution stays dormant and permissions stay bypass: neither is a switch here. Pause holds the scheduler, board pickup and dashboard wakes; chats you started keep going.</div>
  </>}</Load>
}

type Act = (what: string, path: string, body: unknown) => Promise<void>

function Master({ c, act, busy }: { c: ControlsState; act: Act; busy: boolean }) {
  const [sure, setSure] = useState(false)
  // how long Pause holds: open-ended unless the owner picks an end (floor/STOP carries it, server/system/stop.ts)
  const [hours, setHours] = useState(0)
  const until = c.pausedUntil ?? null
  useEffect(() => { if (!sure) return; const t = setTimeout(() => setSure(false), 4000); return () => clearTimeout(t) }, [sure])
  return <div className={`system-ctl-master ${c.paused ? 'paused' : ''}`} data-control="pause">
    <Dot s={c.paused ? 'warn' : 'ok'} />
    <span className="system-ctl-mt">{c.paused ? 'Paused' : 'Running'}
      <span className="faint">{c.paused ? (until ? `nothing unattended will start until ${stamp(until)}` : 'nothing unattended will start') : 'unattended work is live'}</span></span>
    <span className="sp" />
    {!c.paused && <select className="input system-ctl-sel" aria-label="Pause for" value={hours} disabled={busy} onChange={e => setHours(Number(e.target.value))}
      title="how long Pause holds: until you resume, or a set time after which the scheduler and the board lift it themselves">
      <option value={0}>until resumed</option>
      {[1, 4, 12, 24].map(h => <option key={h} value={h}>for {h} h</option>)}
    </select>}
    <Btn kind={c.paused ? 'primary' : undefined} disabled={busy} title={c.paused ? 'remove floor/STOP: the scheduler, the board and dashboard wakes start again' : 'write floor/STOP: the scheduler starts no job, the board picks nothing up, dashboards wake no agent. Chats you started keep going'}
      onClick={() => void act(c.paused ? 'resumed' : 'paused', '/api/system/halt', c.paused ? { on: false } : { on: true, ...(hours ? { until: new Date(Date.now() + hours * 3_600_000).toISOString() } : {}) })}>{c.paused ? 'Resume' : 'Pause'}</Btn>
    <Btn kind="danger" disabled={busy} title="the red STOP: ends every running agent and writes floor/STOP. Resume does not bring the agents back"
      onClick={() => { if (!sure) setSure(true); else { setSure(false); void act('stopped every agent and job', '/api/system/stop', {}) } }}>{sure ? 'Confirm stop' : 'Stop agents'}</Btn>
  </div>
}

type Pick = { id: string; name: string }

function BoardRow({ c, models, act }: { c: ControlsState; models: Pick[]; act: Act }) {
  const b = c.board
  const [max, setMax] = useState(String(b.max))
  useEffect(() => setMax(String(b.max)), [b.max])
  // an old fundd sends no perDay: the box stays empty (unknown), never a made-up number
  const [perDay, setPerDay] = useState(b.perDay === undefined ? '' : String(b.perDay))
  useEffect(() => setPerDay(b.perDay === undefined ? '' : String(b.perDay)), [b.perDay])
  const send = (body: Record<string, unknown>, what: string) => act(what, '/api/board/config', body)
  const commitMax = () => {
    const n = Number(max)
    if (!Number.isInteger(n) || n < 1 || n > 8) { setMax(String(b.max)); return }
    if (n !== b.max) void send({ max: n }, `board: ${n} at once`)
  }
  const commitPerDay = () => {
    const n = Number(perDay)
    if (!Number.isInteger(n) || n < 1 || n > 40) { setPerDay(b.perDay === undefined ? '' : String(b.perDay)); return }
    if (n !== b.perDay) void send({ perDay: n }, `board: ${n} a day`)
  }
  const ids = [...(b.model && !models.some(m => m.id === b.model) ? [{ id: b.model, name: b.model }] : []), ...models]
  return <Row id="board" on={b.auto} onFlip={() => send({ auto: !b.auto }, `board: ${b.auto ? 'manual' : 'auto'}`)}
    name="Board pickup" sub={b.auto ? 'starts Ready items by itself' : 'manual: nothing is picked up'}
    chip={!b.auto ? <Chip tone="faint">manual</Chip> : c.paused ? <Chip tone="warn" title="Pause holds board pickup">held: pause</Chip>
      : <Chip tone="ok">{b.running ? `${b.running} running` : 'auto'}</Chip>}>
    <select className="input system-ctl-sel" aria-label="Board model" value={b.model ?? ''} onChange={e => void send({ model: e.target.value || null }, `board: model ${e.target.value || 'agent default'}`)}
      title={`the model every conversation the board starts runs on${b.model ? `: ${b.model}` : ": each owner agent's own"}`}>
      <option value="">agent default</option>
      {ids.map(m => <option key={m.id} value={m.id} title={m.name}>{m.id.replace(/^claude-/, '')}</option>)}
    </select>
    <input className="input system-ctl-num" aria-label="Board pickups at once" inputMode="numeric" value={max} onChange={e => setMax(e.target.value)} onBlur={commitMax}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      title="how many board items may run at once, 1 to 8" />
    <span className="faint">at once</span>
    <input className="input system-ctl-num" aria-label="Board pickups per day" inputMode="numeric" value={perDay} onChange={e => setPerDay(e.target.value)} onBlur={commitPerDay}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      title="how many pickups may start in one UTC day, 1 to 40 (default 10); the spend cap and Pause still hold" />
    <span className="faint">a day</span>
  </Row>
}

function CapRow({ c, act }: { c: ControlsState; act: Act }) {
  const cap = c.tokenCap
  const [v, setV] = useState(cap.value ? fmtTokens(cap.value) : '')
  useEffect(() => setV(cap.value ? fmtTokens(cap.value) : ''), [cap.value])
  const commit = () => {
    const n = parseTokens(v)
    if (n === undefined) { setV(cap.value ? fmtTokens(cap.value) : ''); return }
    if (n !== cap.value) void act(n ? `daily token cap ${fmtTokens(n)}` : 'daily token cap removed', '/api/system/controls', { tokenCap: n })
  }
  return <Row id="tokenCap" name="Daily token cap" sub="the only brake on spend"
    title="billable tokens (input + cache writes + output) per agent per local day; an agent at its cap cannot start or continue a chat until you lift it in Spend. Empty = no cap"
    chip={cap.value === null ? <Chip tone="warn" title="no agent has a ceiling: nothing limits spend">no cap</Chip>
      : cap.capped.length ? <Chip tone="fail" title={`at today's ceiling: ${cap.capped.join(', ')}`}>{cap.capped.length} capped</Chip>
      : <Chip tone="ok">{fmtTokens(cap.value)}</Chip>}>
    <input className="input system-ctl-num wide" aria-label="Daily token cap per agent" placeholder="no cap" value={v} onChange={e => setV(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
    <span className="faint">per agent</span>
  </Row>
}

function ModelRow({ c, models, listError, act }: { c: ControlsState; models: Pick[]; listError: string | null; act: Act }) {
  const d = c.defaultModel
  const [pick, setPick] = useState(d.model ?? '')
  useEffect(() => setPick(d.model ?? ''), [d.model])
  const ids = [...(d.model && !models.some(m => m.id === d.model) ? [{ id: d.model, name: d.model }] : []), ...models]
  return <Row id="defaultModel" name="Default model" sub="every roster agent"
    chip={d.mixed.length ? <Chip tone="warn" title={`not on the commonest model: ${d.mixed.join(', ')}`}>{d.mixed.length} differ</Chip> : d.model ? <Chip tone="ok">all agents</Chip> : <Chip tone="faint">unknown</Chip>}>
    <select className="input system-ctl-sel" aria-label="Default model" value={pick} onChange={e => setPick(e.target.value)}
      title={listError ? `Claude Code's model list is unreadable: ${listError}` : 'the model every roster agent boots on; a chat can still pick another'}>
      {!pick && <option value="">choose</option>}
      {ids.map(m => <option key={m.id} value={m.id} title={m.name}>{m.id.replace(/^claude-/, '')}</option>)}
    </select>
    <Btn kind="primary" disabled={!pick || pick === d.model} title="write this model into every roster file (app/agents/), one commit"
      onClick={() => void act(`every agent on ${pick}`, '/api/system/controls', { defaultModel: pick })}>Apply</Btn>
  </Row>
}
