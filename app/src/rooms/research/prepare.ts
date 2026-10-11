import { marked } from 'marked'
import type { Ipynb } from 'react-ipynb-renderer'
import { STUDY_MIME } from '../../../shared/research.ts'

// react-ipynb-renderer knows no text/markdown OUTPUT (our Conclusions, S0 cards and gate tables are
// exactly that), so those become text/html here and go through the renderer's own DOMPurify pass.
// The manifest's JSON is dropped because the middle column shows it (its text/plain twin stays).

const join = (v: unknown) => Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : ''

/** the notebook with every text/markdown output as HTML, and the manifest JSON dropped */
export function prepare(nb: any): Ipynb {
  const cells = (nb?.cells ?? []).map((c: any) => ({
    ...c,
    outputs: (c.outputs ?? []).map((o: any) => {
      if (!o?.data) return o
      const data = { ...o.data }
      delete data[STUDY_MIME]
      if ('text/markdown' in data && !('text/html' in data)) data['text/html'] = [marked.parse(join(data['text/markdown']), { async: false }) as string]
      delete data['text/markdown']
      return { ...o, data }
    }),
  }))
  return { ...nb, cells }
}
