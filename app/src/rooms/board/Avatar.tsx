import { categoryOf } from '../../ui/categories.ts'
import { Icon, Sq, markOf } from '../../ui/kit.tsx'

/** the owner as a round kit square: the agent's category colour, its two letters (kit markOf, the one rule);
 *  the owner is a person icon, unassigned a dashed ring */
export function Avatar({ id, size = 20 }: { id: string | null | undefined; size?: 16 | 18 | 20 }) {
  if (!id) return <Sq size={size} round tone="none" title="unassigned">-</Sq>
  if (id === 'you' || id === 'owner') return <Sq size={size} round tone="you" title="owner"><Icon name="person" /></Sq>
  const c = categoryOf(id)
  return <Sq size={size} round c={c.color} title={`${id} (${c.label})`}>{markOf(id)}</Sq>
}
