import { nearestEffort } from '../../../shared/engines.ts'

/**
 * THE EFFORT LANDING for a conversation's change of model or effort. The effort must be on the ladder of the model the
 * conversation will hold. A model that takes none clears the override; an effort the NEW model lacks (Codex's `ultra` on a
 * Claude model) lands on its nearest rung at or below; an effort the owner asks for that the model lacks is refused with
 * the ladder. The caller answers with where it landed: the pill takes the server's word, never its own guess.
 * `ladder` undefined = the model is on no provider's list (nothing to check against).
 */
export function landEffort(ladder: readonly string[] | undefined, o: { modelChanged: boolean; asked: string | null | undefined; stored: string | null }):
  { effort: string | null | undefined } | { error: string } {
  if (!ladder) return { effort: o.asked }
  if (!ladder.length) return { effort: o.modelChanged || o.asked ? null : o.asked }
  if (o.asked && !ladder.includes(o.asked)) return { error: `takes effort ${ladder.join(', ')}` }
  if (o.modelChanged && o.asked === undefined && o.stored && !ladder.includes(o.stored)) return { effort: nearestEffort(ladder, o.stored) }
  return { effort: o.asked }
}
