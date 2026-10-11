import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cockpitBody, isCockpitMessage } from '../../../shared/cockpitmsg.ts'
import { Markdown } from '../../ui/kit.tsx'
import type { Decision, Entry } from '../../../server/chat/types.ts'
import { TurnDot, useTurnDots } from './TurnDot.tsx'
import { compactTip } from './compact.ts'
import { rowsOf } from './steps.ts'
import { Timeline } from './Timeline.tsx'

// THE FEED (after machine/src/components/ChatFeed.tsx + ChatKit.tsx, re-spoken in this app's
// tokens). Owner messages are right-aligned bubbles; an agent turn is markdown over one-line tool
// rows; every run of tool calls and thoughts is ONE step timeline (Timeline.tsx), prose stays prose
// below it.

export function Feed({ entries, busy, onRewind, onDecide, conv, truncated = false }: {
  conv?: string
  /** the feed holds only the newest messages: say so at its TOP, where the older ones would be */
  truncated?: boolean
  entries: Entry[]
  busy: boolean
  onRewind?: (e: Entry) => void
  onDecide: (d: Decision, v: { verdict: string; answers?: Record<string, string>; note?: string }) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const rows = useMemo(() => rowsOf(entries), [entries])
  const dots = useTurnDots(conv, entries)
  useLayoutEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })
  return (
    <div className="chats-feed" ref={box} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}>
      <div className="chats-feed-in">
        {truncated && <div className="chats-trunc faint" title="the feed shows the newest messages; the full history is in the transcript file">older messages are in the transcript</div>}
        {rows.map(r => r.kind === 'steps'
          ? <Timeline key={r.key} steps={r.steps} />
          : <EntryView key={r.key} e={r.e} onRewind={onRewind} onDecide={onDecide} dot={dots.get(r.e.id)} />)}
        {busy && !entries.some(e => e.streaming) && <div className="chats-busy"><span className="dot run" /></div>}
      </div>
    </div>
  )
}

function EntryView({ e, onRewind, onDecide, dot }: { e: Entry; onRewind?: (e: Entry) => void; onDecide: (d: Decision, v: { verdict: string; answers?: Record<string, string>; note?: string }) => void; dot?: Parameters<typeof TurnDot>[0]['g'] }) {
  switch (e.kind) {
    case 'user': return <UserBubble e={e} onRewind={onRewind} />
    case 'assistant': return <div className={`chats-say ${e.streaming ? 'streaming' : ''}`}><TurnDot g={dot} /><Markdown text={e.content} /></div>
    case 'error': return <div className="chats-err">{e.content}</div>
    case 'decision': return e.decision ? <DecisionCard d={e.decision} onDecide={onDecide} /> : null
    default: return <div className={`chats-sys ${e.meta?.compact ? 'chats-cmp' : ''}`} title={compactTip(e)}>{e.content}</div>
  }
}

function UserBubble({ e, onRewind }: { e: Entry; onRewind?: (e: Entry) => void }) {
  const [arm, setArm] = useState(false)
  // B-0254: a message the cockpit sent on its own (the continue after a cut) is never shown as the owner's
  if (isCockpitMessage(e.content)) return (
    <div className="chats-me chats-cockpit" title="Sent by the cockpit after a restart cut this conversation, not by the owner">
      <div className="chats-bubble"><div className="chats-cockpit-h">cockpit</div><div className="chats-bubble-t">{cockpitBody(e.content)}</div></div>
    </div>
  )
  return (
    <div className="chats-me" onMouseLeave={() => setArm(false)}>
      {onRewind && e.forkAt && (
        <button className={`chats-rew ${arm ? 'arm' : ''}`} title="Rewind the conversation to just before this message"
          onClick={() => { if (arm) { setArm(false); onRewind(e) } else setArm(true) }}>{arm ? 'rewind?' : 'rewind'}</button>
      )}
      <div className="chats-bubble">
        {e.images?.map(src => <img key={src} src={src} alt="" />)}
        {e.content && <div className="chats-bubble-t">{e.content}</div>}
      </div>
    </div>
  )
}

function DecisionCard({ d, onDecide }: { d: Decision; onDecide: (d: Decision, v: { verdict: string; answers?: Record<string, string>; note?: string }) => void }) {
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const settled = d.settled
  if (d.kind === 'plan') {
    return (
      <div className="chats-decide">
        <div className="chats-decide-h"><span className="dot ask" /> Plan</div>
        <Markdown text={d.plan ?? ''} />
        {settled ? <div className="faint mono">{settled.verdict}{settled.note ? `: ${settled.note}` : ''}</div> : (
          <div className="chats-decide-a">
            <input className="input" placeholder="note" value={note} onChange={e => setNote(e.target.value)} />
            <button className="btn primary" onClick={() => onDecide(d, { verdict: 'approve' })}>Approve</button>
            <button className="btn" onClick={() => onDecide(d, { verdict: 'reject', note })}>Revise</button>
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="chats-decide">
      {d.questions?.map(q => (
        <div key={q.question} className="chats-q">
          <div className="chats-decide-h"><span className="dot ask" /> {q.header || 'Question'}</div>
          <div className="chats-q-t">{q.question}</div>
          <div className="chats-q-o">
            {q.options.map(o => {
              const on = (settled?.answers ?? picks)[q.question] === o.label
              return <button key={o.label} disabled={!!settled} className={`btn ${on ? 'primary' : ''}`} title={o.description} onClick={() => setPicks({ ...picks, [q.question]: o.label })}>{o.label}</button>
            })}
          </div>
        </div>
      ))}
      {settled ? <div className="faint mono">{settled.verdict}</div>
        : <div className="chats-decide-a"><button className="btn primary" disabled={!d.questions?.every(q => picks[q.question])} onClick={() => onDecide(d, { verdict: 'answer', answers: picks })}>Answer</button></div>}
    </div>
  )
}
