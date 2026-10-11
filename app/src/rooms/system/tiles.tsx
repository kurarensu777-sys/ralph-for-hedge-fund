import type { CSSProperties, ReactNode } from 'react'

// ROOM: system - the summary TILES a view opens with: one figure each, a one or two word key under
// it, the long form in the tooltip. A figure that was not measured is drawn as unknown (a hollow
// dash), never a zero. `tone` colours the figure (ok / warn / fail / faint); `c` paints a thin
// category edge (whose it is, never a state).

export type TileT = { k: string; v: ReactNode | null; tone?: 'ok' | 'warn' | 'fail' | 'faint' | ''; title?: string; c?: string; aside?: ReactNode; on?: boolean; onClick?: () => void }

export function Tiles({ items, min = 120 }: { items: TileT[]; min?: number }) {
  return <div className="system-tiles" style={{ '--tmin': `${min}px` } as CSSProperties}>
    {items.map(t => {
      const cls = ['card', 'system-tile', t.c && 'edge', t.on && 'on', t.onClick && 'click'].filter(Boolean).join(' ')
      const body = <>
        <span className={`system-tile-v ${t.v === null ? 'unk' : t.tone ? `t-${t.tone}` : ''}`}>{t.v === null ? <span className="nil" /> : t.v}</span>
        <span className="system-tile-k">{t.k}{t.aside}</span>
      </>
      const style = t.c ? { '--c': t.c } as CSSProperties : undefined
      return t.onClick
        ? <button key={t.k} type="button" className={cls} style={style} title={t.title} onClick={t.onClick} aria-pressed={t.on}>{body}</button>
        : <div key={t.k} className={cls} style={style} title={t.title}>{body}</div>
    })}
  </div>
}
