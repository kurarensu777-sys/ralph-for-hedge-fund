import { Empty, Icon, Load, Pill, Tag } from '../../ui/kit.tsx'
import { useApi } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { Tiles } from './tiles.tsx'

// ROOM: system - THE DOORS (System > Connectors): the doors table of the law book
// (app/library/law/how-we-work.md, server/system/credentials.ts) as a grid of cards. Each card: the door's short name, its scope, who
// it acts as, and WHO HOLDS ITS KEY as one chip - no key (anonymous or local), agent (an agent may
// hold a read key), HUMAN (the owner only, red). No health dot: the table names a check command,
// it records no reading, so nothing here was measured. The whole row is the card's drawer.

type Conn = { id: string; name: string; scope: string; credential: string; agentMayHold: boolean; reachedThrough: string; health: string; parked: boolean }
type Holder = 'none' | 'agent' | 'human'

/** who the connector acts as, in a word or two (the sentence is the tooltip) */
export function identityTag(t: string) {
  const x = t.toLowerCase()
  if (/loopback|local/.test(x)) return 'local'
  if (/git credential/.test(x)) return 'git helper'
  if (/^human\b/.test(x)) return /\bkey/.test(x) ? 'owner keys' : 'owner acct'
  if (/owner/.test(x)) return /exchange/.test(x) ? 'owner keys' : 'owner acct'
  if (/^none\b/.test(x)) return 'anon'
  if (/read-only|market-data key/.test(x)) return 'read key'
  return x.split(/[\s-]+/)[0] || '-'
}

export const holderOf = (c: Pick<Conn, 'agentMayHold' | 'credential'>): Holder => !c.agentMayHold ? 'human' : /^none\b/i.test(c.credential) ? 'none' : 'agent'

/** the door's name without its parenthesis ("Public REST + WS (10 sources...)" -> "Public REST + WS") */
const shortName = (n: string) => n.replace(/\s*\([^)]*\)/g, '').replace(/(:|,|\s-)\s.*$/, '').trim() || n

function HolderChip({ c }: { c: Conn }) {
  const h = holderOf(c)
  if (h === 'human') return <Pill out tone="fail" title={`the owner holds it, never an agent: ${c.credential}`}><Icon name="lock" />HUMAN</Pill>
  if (h === 'agent') return <Pill out tone="ok" title={`an agent may hold it: ${c.credential}`}><Icon name="bot" />agent</Pill>
  return <Pill out tone="clear" title={`no credential: ${c.credential}`}>no key</Pill>
}

export function ConnectorsView() {
  const q = useApi<{ found: boolean; rows: Conn[] }>('/api/system/connectors', ['system'])
  const { openDrawer } = useNav()
  return <Load q={q}>{d => {
    if (!d.found) return <Empty state="unknown">no doors table in the law book (how-we-work.md)</Empty>
    if (d.rows.length === 0) return <Empty />
    const n = (h: Holder) => d.rows.filter(c => holderOf(c) === h)
    const names = (cs: Conn[]) => cs.map(c => shortName(c.name)).join('\n')
    return <>
      <Tiles items={[
        { k: 'doors', v: d.rows.length, title: `every door in the doors table of how-we-work.md\n${d.rows.filter(c => c.parked).length} parked` },
        { k: 'no key', v: n('none').length, tone: 'faint', title: names(n('none')) },
        { k: 'agent key', v: n('agent').length, tone: n('agent').length ? 'ok' : 'faint', title: names(n('agent')) },
        { k: 'human only', v: n('human').length, tone: n('human').length ? 'fail' : 'faint', title: names(n('human')) },
      ]} />
      <div className="system-dgrid">
        {d.rows.map(c => <button key={c.id} type="button" className={`card system-door ${c.parked ? 'parked' : ''} ${holderOf(c)}`}
          title={`${c.name}\n\ncredential: ${c.credential}\nreached through: ${c.reachedThrough}${c.health ? `\nhealth: ${c.health}` : ''}`}
          onClick={() => openDrawer({ title: c.name, body: <table className="kv"><tbody>{Object.entries(c).map(([k, v]) => <tr key={k}><td>{k}</td><td>{String(v)}</td></tr>)}</tbody></table> })}>
          <span className="system-door-nm">{shortName(c.name)}</span>
          <span className="system-door-f">
            <HolderChip c={c} />
            <Tag>{identityTag(c.credential)}</Tag>
            <span className="sp" />
            {c.parked && <Tag tone="warn">parked</Tag>}
            <span className="faint mono system-door-sc" title={c.scope === 'fund' ? 'fund: every agent, from the shared tree' : c.scope === 'operator' ? "operator: this machine's own config, never a repo" : c.scope}>{c.scope}</span>
          </span>
        </button>)}
      </div>
    </>
  }}</Load>
}
