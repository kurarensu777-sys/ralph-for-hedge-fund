// A unified patch (git show / git diff / the server's added-file patch) -> rows the diff drawer
// draws. Headers are dropped, a hunk header becomes a gap carrying its line numbers.

export type PatchRow = { t: 'add' | 'del' | 'ctx' | 'gap' | 'meta'; s: string }

export function patchRows(patch: string): PatchRow[] {
  const out: PatchRow[] = []
  let inHunk = false
  for (const l of patch.replace(/\r\n/g, '\n').split('\n')) {
    if (l.startsWith('diff --git ')) { inHunk = false; continue }
    if (!inHunk) {
      if (l.startsWith('@@')) { inHunk = true; out.push({ t: 'gap', s: l }); continue }
      if (/^(index |--- |\+\+\+ |similarity |rename |old mode|new mode|deleted file|new file mode)/.test(l) || !l) continue
      out.push({ t: 'meta', s: l })       // "Binary files differ", "new file <path>", "binary file <path>"
      continue
    }
    if (l.startsWith('@@')) { out.push({ t: 'gap', s: l }); continue }
    if (l.startsWith('\\ No newline')) continue
    if (l.startsWith('+')) out.push({ t: 'add', s: l.slice(1) })
    else if (l.startsWith('-')) out.push({ t: 'del', s: l.slice(1) })
    else if (l.startsWith(' ')) out.push({ t: 'ctx', s: l.slice(1) })
    else if (!l) continue
    else { inHunk = false; out.push({ t: 'meta', s: l }) }
  }
  return out
}

export const counts = (rows: PatchRow[]) => ({ add: rows.filter(r => r.t === 'add').length, del: rows.filter(r => r.t === 'del').length })
