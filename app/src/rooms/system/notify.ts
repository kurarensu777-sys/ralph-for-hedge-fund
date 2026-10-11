import { useTopic } from '../../lib/api.ts'
import { useNav } from '../../shell/nav.tsx'
import { makeDedupe } from '../chats/notify.ts'
import { bellOn } from '../chats/state.ts'

// DESKTOP NOTIFICATIONS for the System room's alerts, on the chats room's path: the same bell
// (the owner's one switch), the same hidden-tab rule and the same dedupe. `system:alert` carries a
// spend burn alert (server/system/burn.ts).

export type AlertNote = { tag: string; title: string; body: string }

const tokFmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n))

/** what (if anything) to raise for one event */
export function alertNote(d: any, topic: string, o: { hidden: boolean; on: boolean; permission: string }): AlertNote | null {
  if (!d || !o.hidden || !o.on || o.permission !== 'granted') return null
  if (topic === 'system:alert' && d.kind === 'burn' && typeof d.agent === 'string') {
    const x = typeof d.multiple === 'number' ? `${d.multiple.toFixed(1)}x its hourly median` : 'over the floor'
    return { tag: `burn:${d.agent}:${Math.floor((d.ts ?? 0) / 3_600_000)}`, title: `${d.agent} spend`, body: `${tokFmt(d.billable ?? 0)} in the last hour, ${x}` }
  }
  return null
}

const seen = makeDedupe()
const canNotify = () => typeof window !== 'undefined' && 'Notification' in window

function raise(d: any, topic: string, go: (room: 'system', sel?: string) => void) {
  if (!canNotify()) return
  const n = alertNote(d, topic, { hidden: document.hidden, on: bellOn(), permission: Notification.permission })
  if (!n || seen(n.tag)) return
  try {
    const x = new Notification(n.title, { body: n.body, tag: n.tag })
    x.onclick = () => { window.focus(); go('system', 'spend'); x.close() }
  } catch { /* the browser refused */ }
}

/** mounted by the room's badge hook, which the activity bar runs in every room */
export function useSystemNotify() {
  const { go } = useNav()
  useTopic('system', (d, topic) => { if (topic === 'system:alert') raise(d, topic, go) })
}
