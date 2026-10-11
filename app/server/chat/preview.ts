// The landing's one-line preview of a conversation's last message: whitespace collapsed, the
// markdown marks that would print as noise (headings, emphasis, code ticks, list bullets, link
// brackets) dropped, cut at a word near `max`. Empty text gives '' and the row prints no line.

export function previewLine(text: string, max = 160): string {
  let s = (text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code: not a sentence
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // [label](url) -> label
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length <= max) return s
  s = s.slice(0, max)
  const sp = s.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? s.slice(0, sp) : s).replace(/[\s,.;:-]+$/, '')}...`
}
