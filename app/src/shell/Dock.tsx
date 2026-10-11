import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { ceoOrder, dueLabel, dueTone, type CeoListed } from '../../shared/ceo.ts'
import { useApi, useStored } from '../lib/api.ts'
import { chatStateOf, fileCeo, openCeoChat, useCeoItems, useChatList } from '../lib/ceo.ts'
import { categoryOf } from '../ui/categories.ts'
import { AgentSelect, Btn, Dot, Sq, markOf } from '../ui/kit.tsx'
import { useNav } from './nav.tsx'
import { barTone, fmtDollars, fmtResets, fmtTok, topAgents } from './dock.ts'

// THE DOCK: pinned under the Services cards, never scrolled away. Two cards: the owner's CEO board
// (a glance, a quick add and the doorways; the lane on the Board page is the whole list) and Usage (what Claude has
// spent, and how full the plan's windows are). Both read, neither computes; absent is "unknown".

const MAX_ROWS = 3
const MAX_DONE = 5

/** the agent holding an issue's chat, as a category-coloured square (the kit's, as the Board lane draws it) */
const Who = ({ id }: { id: string }) => <Sq size={16} round c={categoryOf(id).color} title={id}>{markOf(id)}</Sq>

export function Dock() {
  return <div className="dock"><CeoCard /><UsageCard /></div>
}

function Chev() { return <span className="rail-chev"><svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" /></svg></span> }

function CeoCard() {
  const nav = useNav()
  const q = useCeoItems()
  const chats = useChatList()
  const ag = useApi<{ agents: { id: string; name: string; mode: string }[] }>('/api/board/agents', ['config'])
  const [fold, setFold] = useStored('dock.ceoFold', false)
  const [showDone, setShowDone] = useStored('dock.ceoDone', false)
  const [pick, setPick] = useStored('dock.ceoAgent', '')
  const [, setLaneShut] = useStored('board.ceoShut', false)
  const [quick, setQuick] = useState('')
  const turn = useRef(0)
  const agents = ag.data?.agents ?? []
  const list = chats.data?.conversations
  const stateOf = (i: CeoListed) => chatStateOf(i, list)
  const open = ceoOrder((q.data?.items ?? []).filter(i => i.status === 'open'), stateOf)
  const done = (q.data?.items ?? []).filter(i => i.status === 'done').sort((a, b) => b.updated.localeCompare(a.updated))
  const waitingList = open.filter(i => stateOf(i) === 'waiting')
  const waiting = waitingList.length
  const rows = open.slice(0, MAX_ROWS)
  const goBoard = () => { setLaneShut(false); nav.go('board') }   // the lane may have been folded away
  const pickRow = (i: CeoListed) => (i.conversation ? void openCeoChat(nav, i.id) : nav.go('board', `ceo:${i.id}`))
  // each press opens the next waiting chat, so an unanswered one does not hide the rest
  const answer = () => { if (waiting) void openCeoChat(nav, waitingList[turn.current++ % waiting].id) }
  const add = async () => { if (await fileCeo(nav, quick, agents.map(a => a.id), pick, setPick)) setQuick('') }
  const answerTip = !list ? 'chat states not read yet' : waiting ? `Open the chat of ${waitingList[turn.current % waiting].id}; press again for the next` : 'No chat is waiting on you'

  return <section className="rail-card dock-card dock-ceo">
    <button className="rail-h rail-fold dock-h" aria-expanded={!fold} title={fold ? 'show the CEO board' : 'fold to one line'} onClick={() => setFold(!fold)}>
      <span className="rail-nm"><span className="dock-mk" aria-hidden>YO</span>CEO board</span>
      <span className="rail-r">
        {waiting > 0 && <span className="nchip dock-wait" title={`${waiting} chat${waiting === 1 ? '' : 's'} waiting on you`}>{waiting} waiting</span>}
        {q.data && <span title="open issues">{open.length} open</span>}
        {q.error && !q.data && <Dot s="fail" title={q.error} />}
        <span className={fold ? 'dock-closed' : ''}><Chev /></span>
      </span>
    </button>
    {!fold && <div className="dock-k">
      <div className="dock-add">
        <input className="input" placeholder="+ Add" value={quick} aria-label="new issue" title="Enter files it. Start with @agent to choose who it is for."
          onChange={e => setQuick(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void add(); if (e.key === 'Escape') setQuick('') }} />
        <AgentSelect cls="bare dock-pick" value={pick} onChange={setPick} agents={agents} blank="agent" title="The agent a new issue is filed for (its chat is with this agent)" />
      </div>
      {!q.data && !q.error && <div className="rail-row"><Dot s="unknown" /><span className="lbl faint">loading</span></div>}
      {q.error && !q.data && <div className="rail-row"><Dot s="fail" /><span className="lbl">{q.error}</span></div>}
      {q.data && rows.length === 0 && <div className="rail-row"><span className="lbl faint">Nothing on your board</span></div>}
      {rows.map(i => {
        const st = stateOf(i)
        const tone = dueTone(i.due)
        return <button key={i.id} className="dock-row" onClick={() => pickRow(i)}
          title={[`${i.id} ${i.title}`, i.conversation ? `Open its chat with ${i.agent}` : i.agent ? `${i.agent}: no chat yet (opens the issue)` : 'no agent yet (opens the issue)'].join('\n')}>
          {st === 'waiting' ? <Dot s="ask" title="its chat is waiting on you" /> : st === 'live' ? <Dot s="run" title="its chat is working" /> : <Dot s="off" />}
          <span className="lbl">{i.title}</span>
          {i.due && tone && <span className={`dock-due ${tone}`}>{dueLabel(i.due)}</span>}
          {i.agent && <Who id={i.agent} />}
        </button>
      })}
      {open.length > rows.length && <button className="dock-more" onClick={goBoard} title="The CEO lane on the Board page">{`all ${open.length} on the board`}</button>}
      {showDone && done.slice(0, MAX_DONE).map(i => <button key={i.id} className="dock-row dock-dn" onClick={() => nav.go('board', `ceo:${i.id}`)} title={`${i.id} ${i.title}\ndone ${i.updated.slice(0, 10)}: opens the issue`}>
        <Dot s="off" /><span className="lbl">{i.title}</span></button>)}
      {showDone && done.length > MAX_DONE && <button className="dock-more" onClick={goBoard} title="The CEO lane on the Board page">{`${done.length - MAX_DONE} older done on the board`}</button>}
      <div className="dock-bar-b">
        <Btn sm kind="primary" onClick={goBoard} title="The CEO lane on the Board page">Open board</Btn>
        <Btn sm kind={waiting ? 'primary' : undefined} disabled={!waiting} onClick={answer} title={answerTip}>{waiting ? `Answer ${waiting}` : 'Answer'}</Btn>
        <Btn sm disabled={!done.length} onClick={() => setShowDone(!showDone)} title={showDone ? 'Hide the done issues' : 'Show the done issues'}>{q.data ? `Done ${done.length}` : 'Done'}</Btn>
      </div>
    </div>}
  </section>
}

type Plan = { windows: { id: 'five_hour' | 'seven_day'; utilization: number | null; raw: number | null; resetsAt: number | null; status: string; seenAt: number; stale: boolean }[]; error?: string | null }
type Daily = { today: string; costUsd: number; series: { days: string[]; agents: string[]; cells: number[][]; totals: number[]; max: number } }

function UsageCard() {
  const [fold, setFold] = useStored('dock.usageFold', false)
  const plan = useApi<Plan>('/api/chats/plan', ['plan'])
  const daily = useApi<Daily>('/api/system/spend/daily?days=14', ['system'])
  useEffect(() => { const t = setInterval(daily.reload, 60_000); return () => clearInterval(t) }, [daily.reload])
  const d = daily.data
  const today = d ? d.series.totals[d.series.totals.length - 1] : null
  const top = d ? topAgents(d.series, 2) : []
  return <section className="rail-card dock-card dock-usage">
    <button className="rail-h rail-fold dock-h" aria-expanded={!fold} title={fold ? 'show usage' : 'fold to one line'} onClick={() => setFold(!fold)}>
      <span className="rail-nm">Usage</span>
      <span className="rail-r">
        {today !== null && <span className="nchip" title="billable tokens today (input + cache writes + output)">today {fmtTok(today)}</span>}
        {daily.error && !d && <Dot s="fail" title={daily.error} />}
        <span className={fold ? 'dock-closed' : ''}><Chev /></span>
      </span>
    </button>
    {!fold && <div className="dock-k dock-u">
      <Window id="five_hour" label="5h window" plan={plan} />
      <Window id="seven_day" label="week" plan={plan} />
      {d && <>
        <div className="dock-urow"><span className="cap">14 days</span><span className="rd" title="estimated cost of the 14 days, from each turn's reported cost">{fmtDollars(d.costUsd)}</span></div>
        <div className="dock-spark" role="img" aria-label="billable tokens per day, 14 days">
          {d.series.totals.map((v, i) => <i key={d.series.days[i]} title={`${d.series.days[i]}: ${fmtTok(v)}`} style={{ height: `${Math.max(v > 0 ? 8 : 2, d.series.max ? (v / d.series.max) * 100 : 0)}%` } as CSSProperties} />)}
        </div>
        {top.length > 0 && <div className="dock-urow dock-top" title="the most billable tokens over the 14 days">{top.map(t => <span key={t.agent}>{t.agent} {fmtTok(t.tokens)}</span>)}</div>}
      </>}
      {daily.error && !d && <div className="dock-urow"><span className="faint">spend unreadable: {daily.error}</span></div>}
    </div>}
  </section>
}

/** one plan window: the bar is utilization (never a guess); a window the plan has not reported is an unfilled hatched bar */
function Window({ id, label, plan }: { id: 'five_hour' | 'seven_day'; label: string; plan: { data: Plan | null; error: string | null } }) {
  const w = plan.data?.windows.find(x => x.id === id)
  const known = !!w && w.utilization !== null && !w.stale
  const tip = !plan.data ? (plan.error ? `unreadable: ${plan.error}` : 'reading')
    : !w ? (plan.data.error ? `the usage read failed: ${plan.data.error}` : 'Claude Code has not reported this window yet')
    : w.stale ? `the window reset ${fmtResets(w.resetsAt, true)}; the next read (every 2 min) shows the new one`
    : `utilization ${w.raw} (read ${new Date(w.seenAt).toLocaleTimeString()}); ${w.status}`
  return <>
    <div className="dock-urow" title={tip}><span className="cap">{label}</span>
      <span className="rd">{known ? <><b>{Math.round(w!.utilization! * 100)}%</b> · resets {fmtResets(w!.resetsAt)}</> : w?.stale ? 'reset, not read' : plan.error && !plan.data ? 'unreadable' : 'unknown'}</span></div>
    <div className={`dock-bar ${known ? barTone(w!.utilization!) : 'unk'}`} title={tip}><i style={known ? { width: `${Math.round(w!.utilization! * 100)}%` } : undefined} /></div>
  </>
}
