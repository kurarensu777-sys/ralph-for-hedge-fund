import type { CSSProperties, ReactNode } from 'react'
import type { Agent } from '../../../shared/types.ts'
import { Dot, Glyph, Icon, Pill } from '../../ui/kit.tsx'
import { categoryOf } from '../../ui/categories.ts'

// ROOM: system - THE ROSTER as a card grid (System > Agents): one card per agent, its category's
// colour on the left edge, its glyph and name, a live dot (active) or a hollow one (dormant), the
// model and effort pickers, and three small figures (cwd, writes, boot). The pickers are handed in
// (index.tsx ModelPick / EffortPick) and rendered as they are; the words ride in the tooltips.

export function AgentCards({ agents, model, effort }: { agents: Agent[]; model: (a: Agent) => ReactNode; effort: (a: Agent) => ReactNode }) {
  return <div className="system-agrid">
    {agents.map(a => {
      const cat = categoryOf(a)
      const where = a.cwd === '.' ? 'fund' : a.cwd.split('/').filter(Boolean).slice(-2).join('/')
      return <div key={a.id} className={`card system-ac ${a.mode === 'active' ? '' : 'dormant'}`} style={{ '--c': cat.color } as CSSProperties}>
        <div className="system-ac-h" title={`${a.id} - ${a.role}\n${a.kind} · ${a.dept} · ${a.mode}`}>
          <Glyph id={a.id} />
          <span className="system-ac-t"><span className="system-ac-nm">{a.name}</span></span>
          <Dot s={a.mode === 'active' ? 'ok' : 'unknown'} title={a.mode} />
        </div>
        <div className="system-ac-pick" title="model · effort">
          <span className="system-ac-m">{model(a)}</span><i className="system-ac-sep" /><span className="system-ac-e">{effort(a)}</span>
        </div>
        <div className="system-ac-f">
          <span className="mono faint system-ac-cwd" title={`cwd ${a.cwd}`}>{where}</span>
          <span title={a.writes.length ? `writes:\n${a.writes.join('\n')}` : 'writes nothing'}><Pill lbl><Icon name="note" />{a.writes.length}</Pill></span>
          <span title={a.boot.length ? `boot books:\n${a.boot.join('\n')}` : 'no boot books'}><Pill lbl><Icon name="book" />{a.boot.length}</Pill></span>
        </div>
      </div>
    })}
  </div>
}
