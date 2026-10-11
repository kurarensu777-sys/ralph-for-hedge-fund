// ROOM: chats - a conversation's DISPLAY title in one to three words. The stored title is the raw
// first message (server/chat/transcripts.ts titleOf) or the owner's rename; lists and tabs show this
// short form and keep the stored one as the tooltip. A first sentence of four words or fewer is kept.
// Otherwise the title is a NOUN PHRASE, never the first words: leading verbs and pronouns are
// skipped, and a capitalised term, a path or an id wins over plain words ("Help me fix these Claude
// Code settings" -> "Claude Code settings"). No noun at all -> '' (the caller shows agent + time).

const FILLER = /^(?:(?:ok|okay|so|hey|hi|please|now|then|pls|also)[,.]?\s+|(?:can|could|would|will) you\s+|i (?:want|need) you to\s+|i want to\s+|you are\s+|your (?:job|task) is (?:to|tto)\s+|let'?s\s+|go\s+(?:and\s+)?)/i
const SMALL = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'is', 'are', 'be', 'it', 'this', 'that', 'these', 'those', 'with', 'from', 'by', 'as', 'all', 'any', 'every', 'fully', 'exactly', 'just', 'really', 'very', 'whole', 'each', 'once', 'do', 'me', 'my', 'our', 'we', 'i', 'you', 'your', 'he', 'she', 'they', 'them', 'us', 'one', 'two', 'three', 'four', 'five', 'some', 'what', 'how', 'why', 'when', 'where', 'here', 'there', 'not', 'no', 'but', 'if', 'so', 'then', 'up', 'out', 'into', 'through', 'about', 'over', 'now', 'please', 'ok', 'okay', 'after', 'before'])
/** verbs an ask opens with or strings between its nouns ("send", "did", "need") */
const VERB = new Set(['run', 'help', 'fix', 'send', 'make', 'do', 'did', 'does', 'done', 'read', 'trace', 'attempt', 'enable', 'disable', 'add', 'build', 'check', 'look', 'go', 'get', 'got', 'tell', 'show', 'find', 'write', 'create', 'update', 'change', 'move', 'set', 'kill', 'use', 'try', 'need', 'needs', 'want', 'wants', 'understand', 'explain', 'review', 'test', 'start', 'stop', 'open', 'close', 'put', 'give', 'take', 'keep', 'let', 'see', 'say', 'said', 'think', 'know', 'can', 'could', 'should', 'would', 'will', 'must', 'has', 'have', 'had', 'was', 'were', 'been', 'being', 'am', 'implement', 'remove', 'delete', 'rename', 'keeps', 'wire', 'ship', 'land', 'commit', 'push', 'pull', 'clean', 'verify', 'probe', 'audit', 'list', 'draft', 'plan', 'report', 'describe', 'summarise', 'summarize', 'compare', 'investigate', 'debug', 'rebuild', 'redo', 'refactor', 'improve', 'finish', 'continue', 'resume', 'ensure', 'confirm', 'figure', 'work', 'call', 'ask', 'reply', 'respond', 'answer', 'print', 'echo'])
/** lower-case acronyms people type ("cto did this") */
const ACRO = new Set(['cto', 'ceo', 'api', 'ui', 'pr', 'hl', 'eod', 'csv', 'json', 'sql', 'ws', 'cli', 'pnl', 'oi'])

const clean = (w: string) => w.replace(/^[^\w/.:#-]+|[^\w/.:#-]+$/g, '').replace(/[.:]+$/, '')
const isSmall = (w: string) => SMALL.has(w.toLowerCase())
const isVerb = (w: string) => VERB.has(w.toLowerCase())
/** a capitalised term, an acronym, a path or an id */
const isKey = (w: string, i: number) => ACRO.has(w.toLowerCase()) || /[/_#]|\.\w|[a-z]\d|\d[a-z]/i.test(w) || (/[A-Z]/.test(w.slice(1))) || (i > 0 && /^[A-Z]/.test(w))
const show = (w: string) => (ACRO.has(w.toLowerCase()) ? w.toUpperCase() : w)

export function chatTitle(raw: string | null | undefined): string {
  let t = (raw ?? '').replace(/\s+/g, ' ').replace(/\.\.\.$/, '').trim()
  // a held key doubles the first letter ("Ssend sonnet agents"): drop the twin
  // (a doubled leading consonant, l aside: no English word starts that way; vowels and "ll" do)
  t = t.replace(/^([b-df-hj-km-np-tv-z])(?=\1)/i, '')
  if (!t) return ''
  // a first sentence of four words or fewer is already a title ("Permission probe. Do exactly...")
  const first = t.split(/(?<=[.!?:])\s+|\n/)[0].replace(/[.!?:]+$/, '').trim()
  if (first && first.split(' ').length <= 4) {
    // ONE bare word before a colon ("verify: ready ping", "handoff: Run these...") says nothing on
    // its own: it leads, and the rest's own title follows it (at most four words in all)
    const rest = t.slice(first.length).replace(/^[.!?:]+\s*/, '')
    if (!first.includes(' ') && rest) {
      const more = chatTitle(rest)
      // keep the rest's capital only where the owner typed one ("Bash tool"), not where cap() added it
      const lead = more.split(' ')[0]
      const m = rest.includes(lead) ? more : more.charAt(0).toLowerCase() + more.slice(1)
      if (more) return cap(`${first} ${m}`.split(' ').slice(0, 4).join(' '))
    }
    return cap(first)
  }
  for (let i = 0; i < 4; i++) { const n = t.replace(FILLER, ''); if (n === t) break; t = n }
  // only the first dozen words: a noun found deep in a long ask is not what the ask is about
  const words = t.split(' ').slice(0, 12).map(clean).filter(Boolean)
  /** the phrase starting at i: noun-ish words up to three, stopping at a little word or a verb */
  const phrase = (i: number) => {
    const out: string[] = []
    for (let j = i; j < words.length && out.length < 3; j++) {
      const w = words[j]
      if (isSmall(w) || (isVerb(w) && !isKey(w, j))) break
      out.push(show(w))
    }
    return out
  }
  const keys = words.map((w, i) => (isKey(w, i) && !isSmall(w) ? i : -1)).filter(i => i >= 0)
  let out: string[] = []
  if (keys.length) {
    out = phrase(keys[0])
    // one key word alone ("CTO") takes the next key phrase beside it ("CTO Auto-approve")
    if (out.length === 1 && keys.length > 1) out = [...out, ...phrase(keys.find(k => k > keys[0] + 1) ?? keys[1])].slice(0, 3)
  }
  if (!out.length) {
    const i = words.findIndex(w => !isSmall(w) && !isVerb(w))
    if (i >= 0) out = phrase(i)
  }
  // a lone capitalised VERB ("B-0008 Reply with the single word") names no subject: its object follows
  if (out.length === 1 && isVerb(out[0])) {
    const at = words.findIndex(w => show(w) === out[0])
    const j = words.findIndex((w, k) => k > at && !isSmall(w) && !isVerb(w))
    if (j >= 0) out = [out[0], ...phrase(j)].slice(0, 3)
  }
  return out.length ? cap(out.join(' ')) : ''
}

/** the label a conversation shows: its noun phrase; no noun -> agent + start time ("fund 14:02");
 *  a conversation with no first message yet -> '' (the list renders a faint "new") */
export function convLabel(c: { title: string | null | undefined; agent: string; startedAt?: number }): string {
  if (!c.title) return ''
  const t = chatTitle(c.title)
  if (t) return t
  const d = c.startedAt ? new Date(c.startedAt) : null
  return `${c.agent}${d ? ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''}`
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
