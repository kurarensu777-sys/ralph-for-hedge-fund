import { Empty } from '../../ui/kit.tsx'

// the room's one NOT AVAILABLE line

export type NA = { available: false; reason: string }

/** a door that is not there: one honest line */
export function NotAvailable({ reason, inline = true }: { reason: string; inline?: boolean }) {
  return <Empty state="unknown" title="NOT AVAILABLE" inline={inline}>{reason}</Empty>
}
