import type { ServerResponse } from 'node:http'
import type { Router } from './http.ts'

/**
 * ONE event stream per browser tab. Every live update in the cockpit rides it as
 * {topic, data}; the UI refetches or patches on the topics it cares about. One stream,
 * never one per pane: Chrome caps HTTP/1.1 at 6 connections per host and a seventh
 * stream hangs silently (the lesson that cost the old cockpit a day).
 */
const clients = new Set<ServerResponse>()
let seq = 0

/** a tab that has not read this much of its stream is not keeping up (asleep, or a publisher is
 *  flooding): it is dropped rather than buffered without bound, and its EventSource reconnects */
export const MAX_BACKLOG = 1 << 20

export function publish(topic: string, data: unknown = null) {
  const line = `id: ${++seq}\ndata: ${JSON.stringify({ topic, data })}\n\n`
  for (const res of clients) {
    if (res.writableLength > MAX_BACKLOG) { clients.delete(res); res.destroy(); continue }
    res.write(line)
  }
}

export function register(r: Router) {
  r.get('/api/events', ({ req, res }) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write(`data: ${JSON.stringify({ topic: 'hello', data: { seq } })}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return undefined
  })
}

setInterval(() => { for (const res of clients) res.write(': ping\n\n') }, 15_000).unref()
