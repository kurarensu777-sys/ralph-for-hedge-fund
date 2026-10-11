// A message the COCKPIT sends an agent on its own (B-0254: the continue after a cut, the lost-work
// notice) - never the owner's words. The mark lives in the TEXT, so the transcript keeps it: the chats
// room renders such a message as the cockpit's, and the boot scan knows a cut turn was an auto-continue.

export const COCKPIT_MARK = '[cockpit]'
export const isCockpitMessage = (t: string | null | undefined): boolean => typeof t === 'string' && t.trimStart().startsWith(COCKPIT_MARK)
/** the text without its mark (what the chats room shows under the cockpit's label) */
export const cockpitBody = (t: string): string => t.trimStart().slice(COCKPIT_MARK.length).trimStart()
