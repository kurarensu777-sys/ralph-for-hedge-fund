import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// A TERMINAL PANE (after machine/src/components/TerminalPane.tsx). The shell lives in fundd, so a
// UI reload reattaches to it and replays its ring. One effect run owns one socket: a retry flag
// shared across runs is what once attached two sockets to one pty and typed every key twice.

const css = (n: string, fb: string) => (getComputedStyle(document.documentElement).getPropertyValue(n) || '').trim() || fb

export function TerminalPane({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const ws = useRef<WebSocket | null>(null)
  const sent = useRef<{ cols: number; rows: number } | null>(null)
  const [state, setState] = useState<'connecting' | 'live' | 'exited' | 'gone'>('connecting')

  useEffect(() => {
    const el = host.current
    if (!el) return
    const t = new Terminal({
      fontFamily: css('--mono', 'Consolas, monospace'), fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, scrollback: 10_000,
      theme: {
        background: css('--bg', '#0b0c0e'), foreground: css('--text', '#e6e8eb'), cursor: css('--accent', '#d9b35b'),
        selectionBackground: '#d9b35b33', black: '#1c2025', brightBlack: '#6c737d', red: '#ef6b6b', brightRed: '#ef6b6b',
        green: '#8bd5a1', brightGreen: '#8bd5a1', yellow: '#e8b45a', brightYellow: '#e8b45a', blue: '#7aa2f7', brightBlue: '#7aa2f7',
        magenta: '#c49bf0', brightMagenta: '#c49bf0', cyan: '#7dcfdc', brightCyan: '#7dcfdc', white: '#e6e8eb', brightWhite: '#ffffff',
      },
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(el)
    term.current = t
    fit.current = f
    const refit = () => {
      try { f.fit() } catch { return }
      const { cols, rows } = t
      const s = ws.current
      if (!cols || !rows || s?.readyState !== WebSocket.OPEN) return
      if (sent.current?.cols === cols && sent.current?.rows === rows) return
      sent.current = { cols, rows }
      s.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
    const ro = new ResizeObserver(() => refit())
    ro.observe(el)
    const sub = t.onData(d => { const s = ws.current; if (s?.readyState === WebSocket.OPEN) s.send(JSON.stringify({ type: 'input', data: d })) })

    let done = false
    let got = false
    let delay = 400
    let timer: ReturnType<typeof setTimeout> | null = null
    const connect = () => {
      if (done) return
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const s = new WebSocket(`${proto}//${location.host}/ws/term/${encodeURIComponent(id)}?replay=${got ? 0 : 1}`)
      s.binaryType = 'arraybuffer'
      ws.current = s
      s.onopen = () => { delay = 400 }
      s.onmessage = ev => {
        if (done || ws.current !== s) return
        if (ev.data instanceof ArrayBuffer) { got = true; t.write(new Uint8Array(ev.data)); return }
        let m: any
        try { m = JSON.parse(String(ev.data)) } catch { return }
        if (m.type === 'attached') { setState('live'); sent.current = { cols: m.cols, rows: m.rows }; queueMicrotask(refit); t.focus() }
        else if (m.type === 'exit') { setState('exited'); done = true }
        else if (m.type === 'error') { setState('gone'); done = true }
      }
      s.onclose = () => {
        if (done || ws.current !== s) return
        setState('connecting')
        timer = setTimeout(connect, delay)
        delay = Math.min(8000, delay * 2)
      }
    }
    connect()
    return () => {
      done = true
      if (timer) clearTimeout(timer)
      try { ws.current?.close() } catch { /* gone */ }
      ws.current = null
      ro.disconnect()
      sub.dispose()
      t.dispose()
      term.current = null
    }
  }, [id])

  return (
    <div className="chats-term">
      <div className="chats-term-b" ref={host} onClick={() => term.current?.focus()} />
      {state !== 'live' && <div className={`chats-term-n ${state === 'gone' ? 'bad' : ''}`}>{{ connecting: 'connecting', exited: 'shell exited', gone: 'this terminal is gone (fundd restarted or it was closed)' }[state]}</div>}
    </div>
  )
}
