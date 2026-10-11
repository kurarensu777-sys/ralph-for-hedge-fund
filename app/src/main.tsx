import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css' // first: tokens + kit defaults, so each room's own classes win
import { NavProvider } from './shell/nav.tsx'
import { Shell } from './shell/Shell.tsx'
import { isRoom, parseHash } from './shell/route.ts'
import { loadRoom } from './shell/rooms.ts'

// the first paint waits for the room on screen only (the URL's, else the remembered one; the
// built index.html already preloads its chunk); the Shell loads the other rooms once it has drawn
function firstRoom() {
  const r = parseHash(location.hash)?.room
  if (r) return r
  try { const s = JSON.parse(localStorage.getItem('fundos.room') ?? 'null'); if (typeof s === 'string' && isRoom(s)) return s } catch { /* private window */ }
  return 'chats' as const
}

void loadRoom(firstRoom()).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <NavProvider><Shell /></NavProvider>
    </StrictMode>,
  )
})
