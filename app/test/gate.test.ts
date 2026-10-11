import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { allowedPorts, refuseRequest, refuseUpgrade } from '../server/gate.ts'

const PORTS = [4689, 4688]
const req = (method: string, headers: Record<string, string>) => ({ method, headers } as unknown as IncomingMessage)
const H = { host: '127.0.0.1:4689' }

describe('the request gate', () => {
  it('ports are fundd + the UI, from the env', () => {
    expect(allowedPorts({})).toEqual([4689, 4688])
    expect(allowedPorts({ FUNDD_PORT: '4688' })).toEqual([4688])
  })

  it('refuses a foreign or missing Host (DNS rebinding)', () => {
    expect(refuseRequest(req('GET', { host: 'evil.example:4689' }), PORTS)).toMatch(/host/)
    expect(refuseRequest(req('GET', { host: '127.0.0.1:9999' }), PORTS)).toMatch(/host/)
    expect(refuseRequest(req('GET', {}), PORTS)).toMatch(/host/)
    expect(refuseRequest(req('GET', { host: 'localhost:4688' }), PORTS)).toBeNull()
  })

  it('reads are open to any origin (a browser cannot read the answer cross-origin)', () => {
    expect(refuseRequest(req('GET', { ...H, origin: 'http://evil.example' }), PORTS)).toBeNull()
  })

  it('a changing request from a foreign origin is refused, null included', () => {
    const body = { 'content-type': 'application/json', 'content-length': '2' }
    expect(refuseRequest(req('POST', { ...H, ...body, origin: 'http://evil.example' }), PORTS)).toMatch(/origin/)
    expect(refuseRequest(req('POST', { ...H, ...body, origin: 'null' }), PORTS)).toMatch(/origin/)
    expect(refuseRequest(req('DELETE', { ...H, origin: 'http://127.0.0.1:8787' }), PORTS)).toMatch(/origin/)
    expect(refuseRequest(req('POST', { ...H, ...body, origin: 'http://127.0.0.1:4688' }), PORTS)).toBeNull()
    expect(refuseRequest(req('POST', { ...H, ...body }), PORTS)).toBeNull()
  })

  it('a body must be JSON (no CORS simple request reaches a handler)', () => {
    expect(refuseRequest(req('POST', { ...H, 'content-type': 'text/plain', 'content-length': '5' }), PORTS)).toMatch(/content-type/)
    expect(refuseRequest(req('POST', { ...H, 'transfer-encoding': 'chunked' }), PORTS)).toMatch(/content-type/)
    expect(refuseRequest(req('POST', { ...H, 'content-type': 'application/json; charset=utf-8', 'content-length': '2' }), PORTS)).toBeNull()
    expect(refuseRequest(req('POST', { ...H, 'content-length': '0' }), PORTS)).toBeNull()
  })

  it('a WebSocket upgrade needs the cockpit host and origin', () => {
    expect(refuseUpgrade(req('GET', { ...H, origin: 'http://evil.example' }), PORTS)).toMatch(/origin/)
    expect(refuseUpgrade(req('GET', { host: 'evil.example' }), PORTS)).toMatch(/host/)
    expect(refuseUpgrade(req('GET', { host: '127.0.0.1:4688', origin: 'http://127.0.0.1:4688' }), PORTS)).toBeNull()
  })
})
