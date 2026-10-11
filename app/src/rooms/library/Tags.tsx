import type { CSSProperties } from 'react'
import type { LibBook } from '../../../server/library/types.ts'
import { categoryOf } from '../../ui/categories.ts'
import { markOf } from '../../ui/kit.tsx'
import { readerTags, type Tag } from './facets.ts'

/** one reader tag: filled in the agent's category colour = boots with it; outlined = a Recall row
 *  sends it there; ALL / DSH / OD / ? in the neutral mark colour (library.css .library-tg) */
export function TagView({ t, lens }: { t: Tag; lens?: string | null }) {
  const style = t.cat ? ({ '--c': categoryOf(t.cat).color } as CSSProperties) : undefined
  const verb = t.kind === 'boot' ? 'boots with it' : t.kind === 'recall' ? 'a Recall row sends it here' : 'on demand'
  return (
    <span className={`library-tg ${t.kind} ${t.cat ? '' : 'n'} ${lens && t.ids.includes(lens) ? 'me' : ''}`} style={style}
      title={t.kind === 'demand' ? t.tip : `${verb}: ${t.tip}`}>{t.text}</span>
  )
}

/** who must read a book, as tags; `max` folds the rest into +n (its tooltip lists them) */
export function ReaderTags({ b, rc, agents, lens, max }: { b: LibBook; rc: string[] | null; agents: string[]; lens?: string | null; max?: number }) {
  const tags = readerTags(b, rc, agents, markOf)
  if (!max || tags.length <= max) return <>{tags.map((t, i) => <TagView key={i} t={t} lens={lens} />)}</>
  const more = tags.slice(max - 1)
  return (
    <>
      {tags.slice(0, max - 1).map((t, i) => <TagView key={i} t={t} lens={lens} />)}
      <span className="library-tg more" title={more.map(t => `${t.kind}: ${t.tip}`).join('\n')}>+{more.length}</span>
    </>
  )
}
