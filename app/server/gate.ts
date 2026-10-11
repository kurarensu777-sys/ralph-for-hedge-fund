import type { IncomingMessage } from 'node:http'

/**
 * THE ONE REQUEST GATE, run by fundd before any route or WebSocket upgrade.
 *
 * fundd listens on loopback, but loopback is not a trust boundary: any page the owner's browser
 * visits can send a CORS "simple" request (POST, text/plain body) to 127.0.0.1, and a WebSocket
 * upgrade carries no CORS at all. Without this gate a web page could fire the side-effecting
 * routes blind (scaffold a dashboard, apply a loop proposal, start a pass) or type into a live
 * terminal, and a DNS-rebinding page could read the answers. Three rules:
 *
 *  1. HOST: only 127.0.0.1:<port> / localhost:<port> for a port fundd serves (its own, and the dev
 *     UI port vite proxies from with changeOrigin:false). This is what stops DNS rebinding.
 *  2. ORIGIN: a request that changes something (any method but GET/HEAD/OPTIONS) and every
 *     WebSocket upgrade must carry no Origin (curl, node fetch, the hooks) or a cockpit origin.
 *     `Origin: null` (sandboxed frames, file:) is foreign.
 *  3. BODY: a changing request that carries a body must say `content-type: application/json`,
 *     so no request a browser can send without a CORS preflight ever reaches a handler.
 *
 * test/gate.test.ts pins every clause.
 */
export function allowedPorts(env: Record<string, string | undefined> = process.env): number[] {
  const own = Number(env.FUNDD_PORT ?? 4689)
  const ui = Number(env.FUND_UI_PORT ?? 4688)
  return [...new Set([own, ui].filter(n => Number.isInteger(n) && n > 0))]
}

const HOSTS = ['127.0.0.1', 'localhost']

export function allowedHost(host: string | undefined, ports: number[]): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  return HOSTS.some(name => ports.some(p => h === `${name}:${p}`))
}

export function allowedOrigin(origin: string | undefined, ports: number[]): boolean {
  if (origin === undefined) return true
  const o = origin.trim().toLowerCase()
  return HOSTS.some(name => ports.some(p => o === `http://${name}:${p}`))
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

function hasBody(req: IncomingMessage): boolean {
  const len = req.headers['content-length']
  if (len !== undefined) return Number(len) > 0
  return req.headers['transfer-encoding'] !== undefined
}

/** why this HTTP request is refused, or null when it may be routed */
export function refuseRequest(req: IncomingMessage, ports = allowedPorts()): string | null {
  if (!allowedHost(req.headers.host, ports)) return `host ${req.headers.host ?? '(none)'} is not this cockpit`
  const method = (req.method ?? 'GET').toUpperCase()
  if (SAFE.has(method)) return null
  const origin = req.headers.origin
  if (!allowedOrigin(origin, ports)) return `origin ${origin} may not change anything here`
  if (hasBody(req)) {
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (ct !== 'application/json') return `content-type ${ct || '(none)'} refused: send application/json`
  }
  return null
}

/** why this WebSocket upgrade is refused, or null when it may be handed to its route */
export function refuseUpgrade(req: IncomingMessage, ports = allowedPorts()): string | null {
  if (!allowedHost(req.headers.host, ports)) return `host ${req.headers.host ?? '(none)'} is not this cockpit`
  const origin = req.headers.origin
  if (!allowedOrigin(origin, ports)) return `origin ${origin} may not open a socket here`
  return null
}
