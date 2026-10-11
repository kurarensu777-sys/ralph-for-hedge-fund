// A LINE DIFF for the brief editor: the longest common subsequence of the two texts' lines. A brief is a few
// dozen lines, so the quadratic table is fine; a text past the guard says so instead of freezing the tab.

export type DiffRow = { t: 'add' | 'del' | 'ctx'; s: string }

const GUARD = 4000

export function lineDiff(before: string, after: string): DiffRow[] | null {
  const a = before.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const b = after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  if (a.length * b.length > GUARD * GUARD) return null
  const w = b.length + 1
  const t = new Uint32Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
  const out: DiffRow[] = []
  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ t: 'ctx', s: a[i] }); i++; j++ }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) out.push({ t: 'del', s: a[i++] })
    else out.push({ t: 'add', s: b[j++] })
  }
  while (i < a.length) out.push({ t: 'del', s: a[i++] })
  while (j < b.length) out.push({ t: 'add', s: b[j++] })
  return out
}

/** the rows worth showing: the changes with `n` lines of context either side, gaps folded to one marker */
export function trimDiff(rows: DiffRow[], n = 2): (DiffRow | { t: 'gap' })[] {
  const keep = rows.map(() => false)
  rows.forEach((r, i) => { if (r.t !== 'ctx') for (let k = Math.max(0, i - n); k <= Math.min(rows.length - 1, i + n); k++) keep[k] = true })
  const out: (DiffRow | { t: 'gap' })[] = []
  rows.forEach((r, i) => { if (keep[i]) out.push(r); else if (out[out.length - 1]?.t !== 'gap') out.push({ t: 'gap' }) })
  return out
}
