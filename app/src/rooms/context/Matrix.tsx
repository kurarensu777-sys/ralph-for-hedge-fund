import { Fragment } from 'react'
import { fmtTokens, type CtxAgent, type CtxAll, type CtxBudget, type CtxRow } from '../../../shared/context.ts'
import { Dot, Glyph, Meter } from '../../ui/kit.tsx'
import { budgetTone, buildMatrix, cellTone, type Filter } from './matrix.ts'

const BUDGETS: { type: CtxBudget['type']; label: string; title: string }[] = [
  { type: 'base', label: 'Base', title: "the fund root's CLAUDE.md against the base cap" },
  { type: 'workspace', label: 'Workspace', title: "the agent's CLAUDE.md chain against the sum of each file's own cap" },
  { type: 'agent', label: 'Agent', title: "the agent's brief against the agent cap" },
  { type: 'boot', label: 'Boot', title: "every booted chapter together against the boot cap" },
]

function Cell({ r, dormant }: { r: CtxRow | undefined; dormant: boolean }) {
  if (!r) return <td className="context-cell none" title="not loaded">·</td>
  const tone = cellTone(r)
  const cap = r.cap !== null ? ` of ${r.cap.toLocaleString()} cap` : ''
  if (tone === 'unknown') return <td className="context-cell unk" title={`${r.note ?? 'not measured'}: loaded, size unknown`}>?</td>
  if (r.state === 'missing') return <td className="context-cell fail" title={r.note}><Dot s="fail" /> missing</td>
  return <td className={`context-cell ${tone} ${dormant ? 'dormant' : ''}`} title={`${r.note ? r.note + '\n' : ''}~${r.tokens} tokens (chars / 4)${cap}${tone === 'fail' ? '\nover its cap' : tone === 'warn' ? '\nover the writing target' : ''}`}>{fmtTokens(r.tokens)}</td>
}

/** the matrix: layers down the side, agents across, a cell loaded or not with its tokens, the footer each agent's total against its caps */
export function Matrix({ data, filter, sel, onPick }: { data: CtxAll; filter: Filter; sel: string | null; onPick: (id: string) => void }) {
  const agents = data.agents
  const groups = buildMatrix(agents, filter)
  const col = (a: CtxAgent) => `context-col ${a.mode === 'dormant' ? 'dormant' : ''} ${sel === a.id ? 'on' : ''}`
  const n = agents.length + 1
  return <div className="context-scroll">
    <table className="context-table">
      <thead><tr>
        <th className="context-corner" />
        {agents.map(a => <th key={a.id} className={col(a)}>
          <button title={`${a.name} (${a.id}): ${a.dept}${a.mode === 'dormant' ? ', dormant' : ''}\nopen its prompt, brief, boot list and header`} onClick={() => onPick(a.id)}>
            <Glyph id={a.id} tone={a.mode === 'dormant' ? 'off' : undefined} /><span className="nm">{a.name}</span>
          </button>
        </th>)}
      </tr></thead>
      <tbody>
        {!groups.length && <tr><td className="context-none" colSpan={n}>{filter === 'shared' ? 'no row is loaded by every agent at one size' : filter === 'differs' ? 'every row is the same for every agent' : 'no rows'}</td></tr>}
        {groups.map(g => <Fragment key={g.type}>
          <tr className="context-grp"><th colSpan={n} title={g.title}>{g.label}</th></tr>
          {g.rows.map(r => <tr key={r.key} className="context-row">
            <th className="context-label" title={r.note ?? r.label}><span className="mono">{r.label}</span>{r.shared && filter === 'all' && <span className="context-shared" title="every agent loads it, at one size">all</span>}</th>
            {r.cells.map((c, i) => <Cell key={agents[i].id} r={c} dormant={agents[i].mode === 'dormant'} />)}
          </tr>)}
        </Fragment>)}
      </tbody>
      <tfoot>
        {BUDGETS.map(b => <tr key={b.type} className="context-foot">
          <th className="context-label" title={b.title}>{b.label}</th>
          {agents.map(a => {
            const x = a.budgets.find(y => y.type === b.type)
            if (a.error) return <td key={a.id} className="context-cell unk" title={a.error}>?</td>
            if (!x || (x.cap === null && !x.tokens)) return <td key={a.id} className="context-cell none">·</td>
            const tone = budgetTone(x.tokens, x.cap)
            return <td key={a.id} className={`context-cell ${tone === 'unknown' ? 'unk' : tone} ${a.mode === 'dormant' ? 'dormant' : ''}`} title={`${x.tokens.toLocaleString()}${x.cap === null ? ' (no cap read)' : ` of ${x.cap.toLocaleString()}`} tokens`}>
              <span>{fmtTokens(x.tokens)}{x.cap !== null && <span className="faint"> / {fmtTokens(x.cap)}</span>}</span>
              <Meter v={x.cap === null ? null : Math.min(1, x.tokens / x.cap)} tone={tone === 'unknown' ? undefined : tone} sm />
            </td>
          })}
        </tr>)}
        <tr className="context-foot total">
          <th className="context-label" title="what was measured: the CLAUDE.md chain and the appended prompt. The System, MCP, Skills and Memory rows are not in it.">Known total</th>
          {agents.map(a => <td key={a.id} className={`context-cell ${a.mode === 'dormant' ? 'dormant' : ''}`} title={a.error ?? `~${a.known.toLocaleString()} tokens measured; the unmeasured rows are not counted`}>{a.error ? '?' : `${fmtTokens(a.known)}+`}</td>)}
        </tr>
      </tfoot>
    </table>
  </div>
}
