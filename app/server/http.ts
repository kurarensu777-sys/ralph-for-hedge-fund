import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

export type Ctx = {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  query: URLSearchParams
  body: () => Promise<any>
}
export type Handler = (ctx: Ctx) => unknown | Promise<unknown>
type Route = { method: string; parts: string[]; handler: Handler }
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, params: Record<string, string>) => void

/** An error a handler throws on purpose; it becomes {error} with this status. */
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** decodeURIComponent that never throws: malformed percent-encoding is null, never a URIError. */
export function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s) } catch { return null }
}

/** Matched params, null for no match, or 'bad' when a param carries malformed percent-encoding. */
function match(parts: string[], path: string[]): Record<string, string> | null | 'bad' {
  if (parts.length !== path.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) {
      const v = safeDecode(path[i])
      if (v === null) return 'bad'
      params[parts[i].slice(1)] = v
    } else if (parts[i] !== path[i]) return null
  }
  return params
}

const split = (p: string) => p.split('/').filter(Boolean)

/** A tiny router: every room registers its routes here; handlers return JSON or null. */
export class Router {
  private routes: Route[] = []
  private upgrades: { parts: string[]; handler: UpgradeHandler }[] = []

  get(path: string, h: Handler) { this.routes.push({ method: 'GET', parts: split(path), handler: h }) }
  post(path: string, h: Handler) { this.routes.push({ method: 'POST', parts: split(path), handler: h }) }
  patch(path: string, h: Handler) { this.routes.push({ method: 'PATCH', parts: split(path), handler: h }) }
  delete(path: string, h: Handler) { this.routes.push({ method: 'DELETE', parts: split(path), handler: h }) }
  /** a WebSocket (terminals) */
  ws(path: string, h: UpgradeHandler) { this.upgrades.push({ parts: split(path), handler: h }) }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = split(url.pathname)
    for (const r of this.routes) {
      if (r.method !== req.method) continue
      const params = match(r.parts, path)
      if (!params) continue
      if (params === 'bad') { json(res, 400, { error: 'malformed percent-encoding in path' }); return true }
      const ctx: Ctx = { req, res, params, query: url.searchParams, body: () => readBody(req) }
      try {
        const out = await r.handler(ctx)
        if (!res.headersSent && !res.writableEnded) json(res, 200, out ?? { ok: true })
      } catch (e: any) {
        const status = e instanceof HttpError ? e.status : 500
        if (status === 500) console.error(`[fundd] ${req.method} ${url.pathname}:`, e)
        if (!res.headersSent) json(res, status, { error: String(e?.message ?? e) })
      }
      return true
    }
    return false
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = split(url.pathname)
    for (const u of this.upgrades) {
      const params = match(u.parts, path)
      if (params === 'bad') { socket.destroy(); return true }
      if (params) { u.handler(req, socket, head, params); return true }
    }
    return false
  }
}

export function json(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(s)
}

/** request bodies are capped (image attachments are the largest legitimate payload) */
const MAX_BODY = 32 * 1024 * 1024

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > MAX_BODY) throw new HttpError(413, `body over ${MAX_BODY / 1024 / 1024} MB`)
    chunks.push(c as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { throw new HttpError(400, 'body is not JSON') }
}
