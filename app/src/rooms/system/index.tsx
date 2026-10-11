import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { Agent } from '../../../shared/types.ts'
import type { RoomDef } from '../types.ts'
import { Btn, Dot, Empty, Glyph, Group, HeatBlank, HeatStrip, Icon, Load, Seg, Tag } from '../../ui/kit.tsx'
import { api, relTime, stamp, useApi, useStored } from '../../lib/api.ts'
import { useNav, useSel } from '../../shell/nav.tsx'
import { BackupsRow, HandsLine, useBackups, RemoteHead, RemoteView, useMode, useRemote } from './ops.tsx'
import { shortReading } from './reading.ts'
import { useSystemNotify } from './notify.ts'
import { Tiles } from './tiles.tsx'
import { orphanLine } from './orphans.ts'
import { JobStrip, useJobDay } from './jobday.tsx'
import { SpendView } from './spend.tsx'
import { ControlsView, useControls } from './controls.tsx'
import { AgentCards } from './agents.tsx'
import { ConnectorsView } from './connectors.tsx'
import { WallView } from './wall.tsx'
import { Heat, useHeat } from './heat.tsx'
import { cardDot, groupCards } from './split.ts'
import { ownerCellTitle, ownerLabelTitle, ownerRows } from './owners.ts'
import { CATEGORIES, categoryOf, isKnownAgent, UNKNOWN_COLOR } from '../../ui/categories.ts'
import { modelTitle, type PermittedModel, type PermittedRead } from '../../../shared/models.ts'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
import './system.css'

// ROOM: system - controls (the default), health, schedule, spend, agents, connectors.

const VIEWS = [{ id: 'controls', label: 'Controls' }, { id: 'health', label: 'Health' }, { id: 'schedule', label: 'Schedule' }, { id: 'spend', label: 'Spend' }, { id: 'agents', label: 'Agents' }, { id: 'connectors', label: 'Connectors' }, { id: 'remote', label: 'Remote' }] as const
type View = typeof VIEWS[number]['id']

function useView(): [View, (v: View) => void] {
  const [sel, set] = useSel('system')
  return [(VIEWS.some(v => v.id === sel) ? sel : 'controls') as View, set]
}

type Probe = { id: string; label: string; owner: string; claimed: string; status: string; stale: boolean; reading: string; detail: string; probedAt: number | null; windowS: number | null; ageS: number | null; file: string; error?: string }
type Proc = { what: string; started: number; ended: number | null; code: number | null; status?: string; tail: string } | null
type Health = { now: number; fundd: { pid: number; started: number; rssMb: number }; probes: Probe[]; orphans?: Probe[]; orphansWhy?: string | null; run: Proc }
type RunV = { row: number; job: string; status: string; trigger: string; due: number | null; start: number | null; end: number | null; code: number | null; detail: string; log: boolean; conversation: string | null }
type Job = { id: string; kind: string; desk: string; cadence: string; enabled: boolean; command: string; note: string; windowS: number; timeoutS: number; model: string; effort: string; next: number | null; unrun: boolean; running: boolean; last: RunV | null }
type Sched = { now: number; found: boolean; errors: string[]; stopped: boolean; stopText: string | null; stopAt: number | null; stopUntil?: number | null; jobs: Job[]; runs: number; lastPass: { at: number; errors: string[]; decisions: number } | null }

/** the floor is written by tools outside fundd (the probes), so these also poll */
function usePoll<T>(path: string, topics: string[]) {
  const q = useApi<T>(path, topics)
  useEffect(() => { const t = setInterval(q.reload, 30_000); return () => clearInterval(t) }, [q.reload])
  return q
}
const useHealth = () => usePoll<Health>('/api/system/health', ['system', 'services', 'health'])
const useSched = () => usePoll<Sched>('/api/system/schedule', ['system'])

const age = (s: number | null) => s === null ? '-' : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`

/** the agent whose writes hold a path, as the room's badges draw it: "." -> fund, "scheduler" /
 *  "app" -> app (the scheduler is fundd's), anything platform-side -> platform */
export function ownerAgent(d: string): string {
  const p = (d || '').replace(/\\/g, '/').replace(/^\.\/?/, '')
  if (!p || p === 'fund') return 'fund'
  if (p === 'scheduler' || p === 'app' || p.startsWith('app')) return 'app'
  if (/^((repos|lab|library)\/)?research\b/.test(p)) return 'research'
  if (/^((repos\/)?platform|lab\/(api|platform|dashboards)|api|dashboards)\b/.test(p)) return 'platform'
  return p.split('/')[0]
}
/** an owner as its agent badge; the path rides in the tooltip */
function OwnerBadge({ d }: { d: string }) {
  const a = ownerAgent(d)
  return <span className="system-ob" title={`${a}: ${d === '.' ? 'fund root' : d}`}><Glyph id={a} /></span>
}

function Pre({ children }: { children: ReactNode }) { return <pre className="pre system-pre">{children}</pre> }

// ---------- health ----------
const LIVE_TITLE: Record<string, string> = { fail: 'a probe in this card is failing', warn: 'a probe in this card is stale or warning', unknown: 'a probe in this card is unknown' }
const ownerTitle = (d: string) => { const a = ownerAgent(d); return `owner ${a}${d === '.' ? ' (fund root)' : d && d !== a ? ` (${d})` : ''}` }

/** Health (UI loop round 3, the owner's option B): ONE CARD PER OWNER CATEGORY - a coloured icon
 *  square, the name, the category's merged 24h heat strip (the worst of its probes
 *  each hour) on the probe rows' own heat column, and at the right edge the live dot (red fail,
 *  amber stale or warn, hollow unknown, none when all ok), the shared .cg-n pill "n/m ok" (green
 *  when all ok) and the .cg-chev chevron. The header wears the .cg-h category wash.
 *  Failing, stale and unknown probes list as rows inside their card; every plainly ok probe folds
 *  into the count (fundd and an ok backups count toward app). A click on the count lists them.
 *  Unknown is never ok: it leads as a row, and its strip cells draw grey (no reading), never green */
function HealthView() {
  const q = useHealth()
  const hq = useHeat()
  const mode = useMode()
  const bq = useBackups()
  const { openDrawer } = useNav()
  const [openMap, setOpenMap] = useStored<Record<string, boolean>>('system.health.cardOpen', {})
  const heat = new Map((hq.data?.items ?? []).map(x => [x.id, x]))
  const strip = (id: string) => {
    const r = heat.get(id)
    if (r && hq.data) return <Heat row={r} from={hq.data.from} />
    // no recorded readings for this row (fundd, backups: not floor probes) or the heat failed: 24
    // unknown cells that say why, never an empty gap
    return <HeatBlank state={hq.error ? 'unknown' : 'none'} why={hq.error ? `heat failed: ${hq.error}` : hq.data ? `${id}: no readings recorded per hour` : 'loading'} />
  }
  const probeRow = (p: Probe) => <tr key={p.file} className="click" title={ownerTitle(p.owner)} onClick={() => openDrawer({ title: <span title={`${p.label}\n${p.file}`}>{p.id}</span>, body: <ProbeBody p={p} /> })}>
    <td className="system-edge">{p.status === 'unknown' && !p.stale && /^not running on :\d+/.test(p.reading.trim())
      ? <Dot s="off" title={`measured: not running (${p.reading.trim()}); stopped, not failing`} />
      : <Dot s={p.status} title={p.stale ? `stale: claims ${p.claimed}, no reading inside its window` : p.claimed} />}</td>
    <td className="mono system-id" title={`${p.label}\n${ownerTitle(p.owner)}`}>{p.id}</td>
    {/* a stale verdict is not a live one: its old reading lives in the tooltip and the drawer, never beside current rows */}
    <td className="system-rd" title={p.stale ? `last reading, ${age(p.ageS)} old (window ${age(p.windowS)}):\n${p.reading}` : p.reading}>{p.stale ? <span className="system-missed" title={`stale: no reading for ${age(p.ageS)}`}><span className="dot missed" />{age(p.ageS)}</span> : <ShortReading r={p.reading} windowS={p.windowS} />}</td>
    <td className="system-heat-td">{strip(p.id)}</td>
    <td className={`num ${p.stale ? 't-warn' : 'faint'}`} title={`${p.probedAt ? stamp(p.probedAt) : 'never probed'}${p.stale ? '\nstale: older than its window' : ''}`}>{age(p.ageS)}</td>
    <td className="num faint">{age(p.windowS)}</td>
  </tr>
  return <Load q={q}>{h => {
    const backupsOk = !!bq.data && bq.data.status === 'ok'
    const funddTitle = 'fundd: no hourly reading is recorded (this page talking to it is the reading)'
    const fundd = <tr key="fundd" title={ownerTitle('app')}><td className="system-edge"><Dot s="ok" title="this page is talking to it" /></td><td className="mono system-id">fundd</td><td className="system-rd" title={[`pid ${h.fundd.pid}`, mode.data ? `${mode.data.mode === 'prod' ? 'production: one detached fundd serves the built UI and the API (start.cmd)' : 'development: npm run dev (vite + a watched fundd)'}\ndb ${mode.data.db}` : ''].filter(Boolean).join('\n')}>{h.fundd.rssMb} MB{mode.data && <> · {mode.data.mode}</>}</td><td className="system-heat-td"><HeatBlank why={funddTitle} /></td><td className="num faint">{relTime(h.fundd.started).replace(/^in /, '')}</td><td className="num faint">-</td></tr>
    const order = Object.keys(CATEGORIES)
    const cards = groupCards(h.probes, p => ownerAgent(p.owner), order)
    // the cockpit's own rows (fundd always, backups) belong to app: its card always exists, and a
    // backups that is not ok ranks it like a probe would
    if (!cards.some(c => c.owner === 'app')) cards.push({ owner: 'app', lead: [], ok: [], rank: 3 })
    const app = cards.find(c => c.owner === 'app')!
    app.rank = Math.min(app.rank, backupsOk ? 3 : bq.data?.status === 'fail' ? 0 : bq.data ? 1 : 2)
    const pos = (o: string) => { const i = order.indexOf(o); return i < 0 ? order.length : i }
    cards.sort((a, b) => a.rank - b.rank || pos(a.owner) - pos(b.owner) || a.owner.localeCompare(b.owner))
    // the merged strip per owner: every row counts (fundd, backups add grey, never a colour)
    const own = new Map<string, string>([['fundd', 'app'], ['backups', 'app'], ...h.probes.map(p => [p.id, ownerAgent(p.owner)] as [string, string])])
    const merged = hq.data ? new Map(ownerRows(hq.data.items, id => own.get(id) ?? 'unknown', [...own.keys()]).map(o => [o.owner, o])) : null
    const cols = <colgroup><col className="system-c-dot" /><col className="system-c-id" /><col /><col className="system-c-heat" /><col className="system-c-n" /><col className="system-c-n" /></colgroup>
    const pOk = h.probes.filter(p => p.status === 'ok' && !p.stale), pFail = h.probes.filter(p => p.status === 'fail')
    const pMiss = h.probes.filter(p => p.status !== 'fail' && (p.stale || p.status === 'warn')), pUnk = h.probes.filter(p => p.status === 'unknown' && !p.stale)
    const ids = (ps: Probe[]) => ps.map(p => p.id).join(', ')
    return <div className="system-health">
      {h.probes.length > 0 && <Tiles items={[
        { k: 'ok', v: pOk.length, tone: pOk.length ? 'ok' : 'faint', title: `${pOk.length} of ${h.probes.length} probes read ok inside their window\n${ids(pOk)}` },
        { k: 'fail', v: pFail.length, tone: pFail.length ? 'fail' : 'faint', title: pFail.length ? `failing: ${ids(pFail)}` : 'no probe is failing' },
        { k: 'missed', v: pMiss.length, tone: pMiss.length ? 'warn' : 'faint', title: pMiss.length ? `stale or warning: ${ids(pMiss)}` : 'every probe reported inside its window' },
        { k: 'unknown', v: pUnk.length, tone: 'faint', title: pUnk.length ? `a reading that cannot tell (or a dashboard not running): ${ids(pUnk)}` : 'no unknown reading' },
      ]} />}
      {h.probes.length === 0 && <Empty state="unknown">no probe has recorded a reading (ops.health_readings, system:*)</Empty>}
      <table className="tbl dense system-tbl system-hcols">{cols}
        <thead><tr><th /><th>Probe</th><th>Reading</th><th className="system-heat-th" title={hq.error ? `heat failed: ${hq.error}` : 'one cell per clock hour from the recorded readings, the hour in progress on the right. Four states: ok (green), fail (red), missed (amber: a warn, or the window ran out), no reading (grey: nothing recorded, unknown or off). A cell tooltip names what it was. A card header shows the worst of its probes each hour'}><span className="system-hk-row">24h<span className="heat-key" aria-hidden="true"><span><i className="k-ok" />ok</span><span><i className="k-fail" />fail</span><span><i className="k-missed" />missed</span><span><i className="k-none" />none</span></span></span></th><th className="num" title="since the probe last wrote its reading">Age</th><th className="num" title="the probe's own window: how often it must report before its verdict goes stale. Not the limit inside a reading (a bar like 43h / 30h is what the probe measured against its own threshold)">Window</th></tr></thead>
      </table>
      {cards.map(c => {
        const isApp = c.owner === 'app'
        const cat = isKnownAgent(c.owner) ? categoryOf(c.owner) : null
        const okN = c.ok.length + (isApp ? 1 + (backupsOk ? 1 : 0) : 0)
        const total = c.ok.length + c.lead.length + (isApp ? 2 : 0)
        const open = !!openMap[c.owner]
        const toggle = () => setOpenMap({ ...openMap, [c.owner]: !open })
        const okIds = [...(isApp ? ['fundd', ...(backupsOk ? ['backups'] : [])] : []), ...c.ok.map(p => p.id)]
        const o = merged?.get(c.owner)
        const hasRows = c.lead.length > 0 || (isApp && !backupsOk) || open
        const live = cardDot(c.rank)
        return <div key={c.owner} className={`cg system-hc ${hasRows ? '' : 'closed'}`} style={{ '--c': cat?.color ?? UNKNOWN_COLOR } as CSSProperties} title={`owner ${c.owner}`}>
          <table className="tbl dense system-tbl">{cols}
            <thead><tr className={`system-hc-h ${okN > 0 ? 'click' : ''}`} onClick={okN > 0 ? toggle : undefined}>
              <td><span className="sq s24">{cat?.abbr ?? c.owner.slice(0, 2).toUpperCase()}</span></td>
              <td><span className="cg-t"><span className="cg-nm" title={cat ? undefined : 'owner not on the chart'}>{cat?.name ?? c.owner}</span></span></td>
              <td />
              <td className="system-heat-td">{hq.error ? <HeatBlank state="unknown" why={`heat failed: ${hq.error}`} />
                : !o ? <HeatBlank why={hq.data ? `${c.owner}: no readings recorded per hour` : 'loading'} />
                : o.cells.length ? <HeatStrip label={`${c.owner}: 24h, the worst probe each hour`} cells={o.cells.map((x, i) => ({ cls: `hc-${x.s}${x.held ? ' held' : ''}`, title: ownerCellTitle(o, i, hq.data!.from + i * 3_600_000) + (i === o.cells.length - 1 && o.unrec.length ? `
${ownerLabelTitle(o)}` : '') }))} />
                : <HeatBlank why={`${c.owner}: no readings recorded per hour`} />}</td>
              <td colSpan={2}><span className="cg-r system-hc-r">
                {live && <Dot s={live} title={LIVE_TITLE[live]} />}
                <button type="button" className={`cg-n system-hc-n ${okN === total ? 'on' : ''}`} aria-expanded={open} disabled={okN === 0}
                  title={okN === 0 ? 'no ok probes' : `${open ? 'click: fold the ok probes back into the count' : 'click: list the ok probes'}
${okIds.join(', ')}`}>{okN}/{total} ok</button>
                <span className={`cg-chev system-hc-chev ${open ? 'open' : ''} ${okN === 0 ? 'none' : ''}`}><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg></span>
              </span></td>
            </tr></thead>
            {hasRows && <tbody>
              {isApp && !backupsOk && <BackupsRow q={bq} />}
              {c.lead.map(probeRow)}
              {open && <>{isApp && fundd}{isApp && backupsOk && <BackupsRow q={bq} />}{c.ok.map(probeRow)}</>}
            </tbody>}
          </table>
        </div>
      })}
      {(() => { const o = orphanLine(h.orphans, h.orphansWhy); return o && <div className="system-orphans faint" title={o.title}>{o.text}</div> })()}
      <HandsLine />
    </div>
  }}</Load>
}

/** a reading as its figure: tone from the probe's own words, the sentence in the tooltip. Two
 *  shapes are drawn rather than spelled: "missed · 4d" is a hollow amber dot and the age, and
 *  "34h / 26h" (oldest report against its window) is a mini bar */
function ShortReading({ r, windowS }: { r: string; windowS?: number | null }) {
  const s = shortReading(r)
  let m: RegExpExecArray | null
  if ((m = /^missed · (\S+)$/.exec(s.text))) return <span className="system-missed" title={`missed ${m[1]} ago`}><span className="dot missed" />{m[1]}</span>
  if ((m = /^(\d+)h \/ (\d+)h$/.exec(s.text))) {
    const frac = Number(m[1]) / Math.max(1, Number(m[2]))
    // ONE tone for the bar and the figure: the probe's own verdict wins (a failing probe is past its
    // limit even when the hours round level), else the fraction decides
    const tone = s.tone === 'fail' || frac > 1 ? 'fail' : frac > 0.8 ? 'warn' : ''
    return <span className="system-age" title={`measured: ${m[1]}h against the reading's own ${m[2]}h limit${windowS ? `
Window ${age(windowS)} is separate: how often this probe must report` : ''}`}>
      <span className={`meter sm ${tone}`}><i style={{ width: `${Math.min(100, frac * 100)}%` }} /></span>
      <span className={tone ? `t-${tone}` : ''}>{m[1]}h</span><span className="faint">/ {m[2]}h</span></span>
  }
  // LABELLED counts ("fail 1 · missed 8 · 13 jobs"): a bare "1 1 3 / 24" is badges nobody can read
  // the total ("of 24 jobs") rides in the tooltip so the row stays one line high
  if (s.chips) return <span className="nchips system-chips" title={s.of ? `${s.chips.map(c => `${c.n} ${c.word}`).join(' · ')} of ${s.of}${s.unit ? ` ${s.unit}` : ''}` : undefined}>{s.chips.map((c, i) => <span key={i} className={`nchip lbl ${c.tone}`}>{c.word} {c.n}</span>)}{s.value && <span className="system-rv">{s.value}</span>}</span>
  // a failing or warning figure is a chip; any other figure is plain text, its tone as colour
  if (s.tone === 'fail' || s.tone === 'warn') return <span className={`nchip lbl ${s.tone}`}>{s.text}</span>
  return <span className={s.tone ? `t-${s.tone}` : ''}>{s.text}</span>
}

/** a probe's detail: its JSON spec (cmd, cadence, cwd) as one cmd line and a cadence tag, anything else as written */
function ProbeDetail({ text }: { text: string }) {
  let j: any = null
  try { j = JSON.parse(text) } catch { /* plain text */ }
  if (!j || typeof j !== 'object' || Array.isArray(j) || !(j.cmd || j.command)) return <Pre>{text}</Pre>
  const c = j.cmd ?? j.command
  const cmd = Array.isArray(c) ? c.map(x => /\s/.test(String(x)) ? `"${x}"` : String(x)).join(' ') : String(c)
  return <div className="system-pd" title={Object.entries(j).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')}>
    {j.cadence && <Tag>{String(j.cadence).replace(/^every\s+/, '')}</Tag>}<code className="pre line system-cmd">{cmd}</code>
  </div>
}

const STATUS_TONE: Record<string, string> = { ok: 'ok', warn: 'warn', fail: 'fail' }

function ProbeBody({ p }: { p: Probe }) {
  // what the probe claims and what the table shows are one tag, two only when they differ (stale)
  const differ = p.claimed !== p.status
  const frac = p.ageS !== null && p.windowS ? p.ageS / p.windowS : null
  return <>
    <table className="kv"><tbody>
      <tr><td>status</td><td title={p.label}>
        {differ && <><span title="what the probe wrote"><Tag tone={STATUS_TONE[p.claimed]}>{p.claimed}</Tag></span> <span className="faint">→</span> </>}
        <span title={differ ? 'what the table shows' : p.label}><Tag tone={STATUS_TONE[p.status]}>{p.status}</Tag></span>
        {p.stale && <> <span title="no reading inside its window"><Tag tone="warn">stale</Tag></span></>}
      </td></tr>
      <tr><td>reading</td><td title={p.reading}><ShortReading r={p.reading} windowS={p.windowS} /></td></tr>
      <tr><td>age</td><td title={`age against its window${p.probedAt ? `\nprobed ${stamp(p.probedAt)}` : ''}`}>
        <span className="system-age"><span className={`meter ${frac === null ? 'hollow' : frac > 1 ? 'fail' : frac > 0.8 ? 'warn' : 'ok'}`}><i style={{ width: `${Math.min(100, (frac ?? 0) * 100)}%` }} /></span><span className="mono">{age(p.ageS)} / {age(p.windowS)}</span></span>
      </td></tr>
    </tbody></table>
    {p.detail && <ProbeDetail text={p.detail} />}
  </>
}

// ---------- schedule ----------
async function halt(on: boolean, toast: (t: string, fail?: boolean) => void) {
  try { await api('/api/system/halt', { body: { on } }); toast(on ? 'jobs paused: the scheduler starts nothing' : 'resumed') } catch (e: any) { toast(`${on ? 'pause' : 'resume'}: ${e.message}`, true) }
}

function Stopped({ s }: { s: Sched }) {
  const { toast } = useNav()
  return <div className="system-stop">
    <Dot s="warn" />
    <span className="system-stop-t">{s.stopUntil ? `Stopped until ${stamp(s.stopUntil)}` : 'Stopped'}</span>
    <span className="faint mono" title={`floor/STOP${s.stopAt ? ` - written ${stamp(s.stopAt)}` : ''}${s.stopText ? `\n${s.stopText}` : ''}`}>{s.stopAt ? relTime(s.stopAt) : 'floor/STOP'}</span>
    <span className="sp" />
    <Btn sm kind="primary" title="remove floor/STOP (fund resume)" onClick={() => halt(false, toast)}>Resume</Btn>
  </div>
}

const TONE: Record<string, string> = { ok: 'ok', skipped: 'faint', missed: 'warn', running: 'run', fail: 'fail', unknown: 'unknown' }
const ts = (t: number | null) => t ? stamp(t) : '-'
const dur = (r: RunV) => r.start && r.end ? `${Math.max(0, Math.round((r.end - r.start) / 1000))}s` : r.start && !r.end ? 'running' : '-'

function LogBody({ row }: { row: number }) {
  const q = useApi<{ row: number; path?: string; lines: string[]; note?: string }>(`/api/system/schedule/log?row=${row}`, ['system'])
  return <Load q={q}>{l => l.lines.length ? <><div className="faint mono">{l.path}</div><Pre>{l.lines.join('\n')}</Pre></> : <Empty>{l.note || 'no output'}</Empty>}</Load>
}

function RunsBody({ job }: { job: Job }) {
  const q = useApi<{ runs: RunV[] }>(`/api/system/schedule/runs?job=${encodeURIComponent(job.id)}&limit=60`, ['system'])
  const { openDrawer } = useNav()
  return <>
    <table className="kv"><tbody>
      <tr><td>{job.kind === 'agent' ? 'prompt' : 'cmd'}</td><td className="mono">{job.command}</td></tr>
      <tr><td>{job.kind === 'agent' ? 'agent' : 'cwd'}</td><td className="mono">{job.desk}</td></tr>
      <tr><td>cadence</td><td className="mono">{job.cadence} · window {age(job.windowS)} · timeout {age(job.timeoutS)}</td></tr>
      {job.note && <tr><td>note</td><td>{job.note}</td></tr>}
    </tbody></table>
    <Load q={q}>{d => d.runs.length === 0 ? <Empty>no runs recorded</Empty> : <table className="tbl dense system-tbl">
      <thead><tr><th>Status</th><th>Due</th><th>Took</th><th className="num">Exit</th><th>Detail</th></tr></thead>
      <tbody>{d.runs.map(r => <tr key={r.row} className={r.log ? 'click' : ''} onClick={() => r.log && openDrawer({ title: `${job.id} - run ${r.row}`, body: <LogBody row={r.row} /> })}>
        <td className={`mono t-${TONE[r.status] ?? 'fail'}`}>{r.status}{r.trigger === 'manual' && <> <Tag>manual</Tag></>}</td>
        <td className="mono faint" title={`started ${ts(r.start)}\nended ${ts(r.end)}`}>{relTime(r.due ?? r.start ?? r.end ?? 0)}</td>
        <td className="mono faint">{dur(r)}</td>
        <td className="num mono faint">{r.code ?? '-'}</td>
        <td className="system-rd" title={r.detail}>{r.detail || <span className="nil" />}</td>
      </tr>)}</tbody>
    </table>}</Load>
  </>
}

type SchedMode = 'table' | 'wall'
/** one mode for the header's Seg and the view below it: two useStored calls would each keep their
 *  own copy, so the Seg would flip and the view would not (until a remount) */
const schedModeSubs = new Set<() => void>()
function useSchedMode(): [SchedMode, (m: SchedMode) => void] {
  const [mode, setStored] = useStored<SchedMode>('system.schedMode', 'table')
  const [, bump] = useState(0)
  useEffect(() => { const f = () => bump(n => n + 1); schedModeSubs.add(f); return () => { schedModeSubs.delete(f) } }, [])
  let cur: SchedMode = mode
  try { const raw = localStorage.getItem('fundos.system.schedMode'); if (raw) cur = JSON.parse(raw) } catch { /* private window */ }
  const set = (m: SchedMode) => { setStored(m); for (const f of schedModeSubs) f() }
  return [cur === 'wall' ? 'wall' : 'table', set]
}

function ScheduleView() {
  const q = useSched()
  const dq = useJobDay()
  const [mode] = useSchedMode()
  const { toast, openDrawer } = useNav()
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(null), 3000); return () => clearTimeout(t) }, [armed])
  const run = async (id: string) => {
    if (armed !== id) { setArmed(id); return }
    setArmed(null)
    try { await api('/api/system/schedule/run', { body: { id } }); toast(`${id} started`) } catch (e: any) { toast(`run: ${e.message}`, true) }
  }
  // an agent job may name its model/effort (written into schedule.json); asked only when one exists
  const mq = useApi<PermittedRead>(q.data?.jobs.some(j => j.kind === 'agent') ? '/api/chats/models' : null, ['config'])
  const brain = async (id: string, patch: { model?: string | null; effort?: string | null }) => {
    try { const r = await api<{ model: string; effort: string }>(`/api/system/schedule/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }); toast(`${id}: ${r.model || 'roster model'} ${r.effort || ''}`.trim()) } catch (e: any) { toast(`${id}: ${e.message}`, true) }
  }
  return <Load q={q}>{s => {
    if (!s.found) return <Empty state="failed">{s.errors[0] ?? 'schedule.json is missing or not JSON'}</Empty>
    return <>
      {s.stopped && <Stopped s={s} />}
      <SchedTiles s={s} />
      {s.errors.length > 0 && <div className="system-run" title={s.errors.join('\n')}><Empty inline state="failed" title={`${s.errors.length} BAD JOB${s.errors.length > 1 ? 'S' : ''}`}>{s.errors[0]}</Empty></div>}
      {mode === 'wall' ? <WallView ownerOf={ownerAgent} openJob={id => { const j = s.jobs.find(x => x.id === id); if (j) openDrawer({ title: j.id, body: <RunsBody job={j} /> }) }} /> : <table className="tbl dense system-tbl">
        <thead><tr><th>Job</th><th>Cadence</th><th title="cwd (script) or agent">Where</th><th className="system-heat-th" title="runs per clock hour, the hour in progress on the right: ok green (a run ended ok), fail red, missed amber (the scheduler never ran an occurrence), grey (nothing ran, only owed or skipped, or still running)">24h</th><th title={`newest run per job, from the cockpit database (${s.runs} rows)${s.lastPass ? `\nlast pass ${new Date(s.lastPass.at).toLocaleTimeString()}` : ''}`}>Last</th><th className="num">Ago</th><th className="num">Next</th><th /></tr></thead>
        <tbody>{s.jobs.map(j => {
          const last = j.last
          const tone = !last ? '' : TONE[last.status] ?? 'fail'
          const when = last ? last.due ?? last.start ?? last.end : null
          return <tr key={j.id} className={`click ${j.enabled ? '' : 'off'}`} onClick={() => openDrawer({ title: j.id, body: <RunsBody job={j} /> })}>
            <td className="mono" title={`${j.kind}: ${j.command}${j.note ? `\n${j.note}` : ''}`}>{j.id}{j.kind === 'agent' && <> <Tag>agent</Tag></>}{!j.enabled && <> <Tag>off</Tag></>}</td>
            <td className="mono faint" title={j.cadence}>{j.cadence ? j.cadence.replace(/^at \d{4}-(\d\d-\d\d)T(\d\d:\d\d).*$/, 'at $1 $2') : '-'}</td>
            <td onClick={j.kind === 'agent' ? e => e.stopPropagation() : undefined}>{j.kind === 'agent' ? <span className="system-jobbrain" title={`agent ${j.desk}`}><Glyph id={j.desk} />
              <ModelPick models={mq.data?.models ?? []} error={mq.error ?? mq.data?.error} value={j.model} blank="roster model" onPick={m => brain(j.id, { model: m || null })} />
              <EffortPick models={mq.data?.models ?? []} efforts={EFFORTS} model={j.model} value={j.effort} blank="roster effort" onPick={x => brain(j.id, { effort: x || null })} />
            </span> : <OwnerBadge d={j.desk} />}</td>
            <td className="system-heat-td"><JobStrip q={dq} id={j.id} enabled={j.enabled} /></td>
            <td className={last ? 'system-last' : ''} title={last ? `${last.status}${last.code !== null ? ` (exit ${last.code})` : ''}\n${last.detail}` : ''}>
              {last ? <Dot s={tone === 'faint' ? 'off' : tone} title={last.status} /> : <span className="nil" title="never run" />}
              {j.unrun && !j.running && <> <Tag tone="warn">due</Tag></>}
            </td>
            <td className="num faint" title={when ? stamp(when) : ''}>{when ? relTime(when) : '-'}</td>
            <td className="num" title={j.next ? stamp(j.next) : 'no next occurrence (past `at`, or disabled)'}>{s.stopped && j.next ? <span className="faint">held</span> : j.next ? relTime(j.next).replace(/^in /, '') : <span className="nil" />}</td>
            <td className="system-act" onClick={e => e.stopPropagation()}>
              {j.running ? <span className="system-busy"><Dot s="run" /> running</span>
                : <Btn sm kind={armed === j.id ? 'danger' : 'ghost'} disabled={!j.enabled || s.stopped} title={!j.enabled ? 'disabled in schedule.json' : s.stopped ? 'stopped: resume first' : `run ${j.id} now (click twice)`} onClick={() => run(j.id)}>{armed === j.id ? 'sure?' : <Icon name="play" title="run" />}</Btn>}
            </td>
          </tr>
        })}</tbody>
      </table>}
    </>
  }}</Load>
}

/** the schedule at a glance: jobs on, their newest runs by verdict, and the next one due */
function SchedTiles({ s }: { s: Sched }) {
  const on = s.jobs.filter(j => j.enabled)
  const by = (st: string) => on.filter(j => j.last?.status === st)
  const ok = by('ok'), fail = by('fail'), miss = by('missed'), never = on.filter(j => !j.last)
  const next = on.filter(j => j.next).sort((a, b) => a.next! - b.next!)[0]
  const ids = (js: Job[]) => js.map(j => j.id).join(', ')
  return <Tiles items={[
    { k: 'jobs on', v: on.length, title: `${on.length} of ${s.jobs.length} jobs enabled in schedule.json${s.jobs.length > on.length ? `\noff: ${ids(s.jobs.filter(j => !j.enabled))}` : ''}` },
    { k: 'ok', v: ok.length, tone: ok.length ? 'ok' : 'faint', title: `newest run ok: ${ids(ok) || 'none'}` },
    { k: 'fail', v: fail.length, tone: fail.length ? 'fail' : 'faint', title: fail.length ? `newest run failed: ${ids(fail)}` : 'no newest run failed' },
    { k: 'missed', v: miss.length, tone: miss.length ? 'warn' : 'faint', title: miss.length ? `newest occurrence missed: ${ids(miss)}` : 'no newest occurrence missed' },
    { k: 'never run', v: never.length, tone: 'faint', title: never.length ? `no run recorded yet: ${ids(never)}` : 'every enabled job has run' },
    { k: s.stopped ? 'next (held)' : 'next', v: next ? <>{relTime(next.next!).replace(/^in /, '')}<small>{next.id}</small></> : null, tone: s.stopped ? 'warn' : '', title: next ? `${next.id} at ${stamp(next.next!)}${s.stopped ? '\nheld: floor/STOP is on' : ''}` : 'no next occurrence' },
  ]} />
}

// ---------- spend: spend.tsx ----------

// ---------- model + effort pickers (Claude Code's permitted list, GET /api/chats/models' twin) ----------
function ModelPick({ models, error, value, onPick, blank }: { models: PermittedModel[]; error?: string | null; value: string; onPick: (m: string) => void; blank?: string }) {
  const ids = models.map(m => m.id)
  const list = [...(value && !ids.includes(value) ? [value] : []), ...ids]
  return <select className="bare" title={modelTitle(models, value) + (error ? `
permitted list: ${error}` : '')} value={value} onChange={e => onPick(e.target.value)}>
    {blank !== undefined && <option value="">{blank}</option>}
    {list.map(m => <option key={m} value={m} title={modelTitle(models, m)}>{m}</option>)}
  </select>
}
function EffortPick({ models, efforts, model, value, onPick, blank }: { models: PermittedModel[]; efforts: string[]; model: string; value: string; onPick: (x: string) => void; blank?: string }) {
  const takes = models.find(m => m.id === model)?.efforts
  if (takes && !takes.length) return <span className="faint" title={`${model} takes no effort level`}>none</span>
  const list = takes ?? efforts
  return <select className="bare" title={takes ? `${model} takes ${takes.join(', ')}` : ''} value={value} onChange={e => onPick(e.target.value)}>
    {blank !== undefined && <option value="">{blank}</option>}
    {(value && !list.includes(value) ? [value, ...list] : list).map(x => <option key={x} value={x}>{x}</option>)}
  </select>
}

// ---------- agents ----------
function AgentsView() {
  const q = useApi<{ agents: Agent[]; models: PermittedModel[]; modelsError: string | null; efforts: string[] }>('/api/system/agents', ['config'])
  const { toast } = useNav()
  const save = async (id: string, patch: Partial<Agent>) => {
    try { await api(`/api/system/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }); toast(`${id}: ${Object.values(patch).join(' ')}`) } catch (e: any) { toast(`${id}: ${e.message}`, true) }
  }
  return <Load q={q} empty={d => d.agents.length === 0}>{d => <AgentCards agents={d.agents}
    model={a => <ModelPick models={d.models} error={d.modelsError} value={a.model} onPick={m => save(a.id, { model: m })} />}
    effort={a => <EffortPick models={d.models} efforts={d.efforts} model={a.model} value={a.effort} onPick={x => save(a.id, { effort: x })} />} />}</Load>
}

// ---------- connectors: connectors.tsx ----------

function Main() {
  const [v] = useView()
  return <div className="system-main">{v === 'controls' ? <ControlsView /> : v === 'health' ? <HealthView /> : v === 'schedule' ? <ScheduleView /> : v === 'spend' ? <SpendView /> : v === 'agents' ? <AgentsView /> : v === 'remote' ? <RemoteView /> : <ConnectorsView />}</div>
}

/** counts as coloured chips: red 1, amber 8 (the word each counts rides in its tooltip); none = all clear */
function Chips({ c, none, title }: { c: [number, string, string][]; none: string; title?: string }) {
  const shown = c.filter(([n]) => n > 0)
  if (!shown.length) return <span title={title}>{none}</span>
  return <span className="nchips" title={title}>{shown.map(([n, tone, word]) => <span key={word} className={`nchip ${tone}`} title={`${n} ${word}`}>{n}</span>)}</span>
}

function Explorer() {
  const [v, setV] = useView()
  const h = useHealth()
  const s = useSched()
  const rm = useRemote()
  const ctl = useControls()
  const live = rm.data?.bridges.filter(b => b.running) ?? []
  const probes = h.data?.probes ?? []
  const fail = probes.filter(p => p.status === 'fail').length
  const stale = probes.filter(p => p.stale).length
  // the Schedule entry says what the jobs' LAST results say, not how many are switched on
  const on = s.data?.jobs.filter(j => j.enabled) ?? []
  const jFail = on.filter(j => j.last?.status === 'fail').length
  const jMissed = on.filter(j => j.last?.status === 'missed').length
  const jUnknown = on.filter(j => j.last?.status === 'unknown').length
  const reading: Record<View, ReactNode> = {
    health: h.data ? <Chips c={[[fail, 'fail', 'fail'], [stale, 'warn', 'stale']]} none={`${probes.length}`} /> : '',
    schedule: s.data ? (s.data.stopped ? <span className="t-warn">stopped</span> : <Chips title={`enabled jobs by their newest run (the scheduler probe reads the same)${jUnknown ? `\n${jUnknown} unknown` : ''}`} c={[[jFail, 'fail', 'fail'], [jMissed, 'warn', 'missed']]} none={`${on.length}`} />) : '',
    controls: ctl.data?.paused ? <span className="t-warn">paused</span> : '',
    spend: '', agents: '', connectors: '',
    remote: rm.data ? (!rm.data.cli.available ? <span className="faint">n/a</span> : live.length ? `${live.length} on` : 'off') : '',
  }
  const dot: Partial<Record<View, string>> = {
    controls: ctl.data ? (ctl.data.paused ? 'warn' : undefined) : undefined,
    health: h.data ? (fail ? 'fail' : stale ? 'warn' : probes.length ? 'ok' : 'unknown') : undefined,
    schedule: s.data ? (s.data.stopped ? 'warn' : jFail ? 'fail' : jMissed ? 'warn' : on.length ? 'ok' : 'unknown') : undefined,
    remote: live.length ? (live.some(b => b.status === 'error') ? 'fail' : live.every(b => b.status === 'connected') ? 'ok' : 'run') : undefined,
  }
  return <Group label="Views">
    {VIEWS.map(x => <button key={x.id} className={`row system-view ${v === x.id ? 'on' : ''}`} onClick={() => setV(x.id)}>
      {dot[x.id] ? <Dot s={dot[x.id]!} /> : <span className="system-nodot" />}<span className="nm">{x.label}</span><span className="r">{reading[x.id]}</span>
    </button>)}
  </Group>
}

/** the last probe run, as a dot and its age beside Run probes; click = its output */
function RunState({ run, open }: { run: NonNullable<Proc>; open: () => void }) {
  const s = run.code === 0 ? 'ok' : run.code === null ? 'unknown' : 'fail'
  return <button className="system-rs" onClick={open} title={`the last probe run (run_all.py) finished ${stamp(run.ended!)}${run.code === null ? '\nthe run outlived a fundd restart and was adopted: its exit code cannot be read; each probe row is the reading' : `, exit ${run.code}`}\nclick: its output`}>
    <Dot s={s} /><span className="faint">probes</span>{relTime(run.ended!).replace(/ ago$/, '')}{s === 'fail' && <span className="t-fail">· exit {run.code}</span>}
  </button>
}

function Head() {
  const [v] = useView()
  const { toast, openDrawer } = useNav()
  const h = useHealth()
  const s = useSched()
  const [mode, setMode] = useSchedMode()
  const running = h.data?.run?.ended === null
  const runProbes = async () => { try { await api('/api/system/probes/run', { body: {} }); toast('probes started') } catch (e: any) { toast(`probes: ${e.message}`, true) } }
  return <>
    {v === 'health' && h.data?.run && h.data.run.ended !== null && <RunState run={h.data.run} open={() => openDrawer({ title: 'run_all.py output', body: <Pre>{h.data!.run!.tail || 'no output'}</Pre> })} />}
    {v === 'health' && <Btn sm disabled={running} title="python app/tools/probes/run_all.py --quiet (records each reading in the ops store)" onClick={runProbes}>{running ? 'running' : 'Run probes'}</Btn>}
    {v === 'schedule' && <Seg value={mode} onChange={setMode} options={[{ id: 'table', label: 'Table' }, { id: 'wall', label: 'Wall' }]} />}
    {v === 'schedule' && s.data && !s.data.stopped && <Btn sm title="write floor/STOP: the scheduler starts no job until Resume. Running agents are untouched; the red STOP in the status bar stops those too" onClick={() => halt(true, toast)}>Pause jobs</Btn>}
    {v === 'remote' && <RemoteHead />}
  </>
}

function useBadge() {
  useSystemNotify()
  const h = useHealth()
  const n = h.data?.probes.filter(p => p.status === 'fail').length ?? 0
  return n ? { n, tone: 'fail' as const } : null
}

export const room: RoomDef = {
  id: 'system',
  label: 'System',
  title: 'System',
  icon: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/></>,
  Explorer,
  Main,
  Head,
  useBadge,
}
