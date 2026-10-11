import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Router, safeDecode } from '../server/http.ts'

describe('router: malformed percent-encoding', () => {
  let server: Server
  let base = ''
  beforeAll(async () => {
    const r = new Router()
    r.get('/api/board/:id', ({ params }) => ({ id: params.id }))
    server = createServer((req, res) => { r.handle(req, res).then(hit => { if (!hit) { res.statusCode = 404; res.end() } }) })
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
    base = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterAll(() => server.close())

  it('safeDecode never throws', () => {
    expect(safeDecode('%E0%A4%A')).toBeNull()
    expect(safeDecode('%E0')).toBeNull()
    expect(safeDecode('a%20b')).toBe('a b')
  })

  it('answers 400 and stays up', async () => {
    const bad = await fetch(`${base}/api/board/%E0%A4%A`)
    expect(bad.status).toBe(400)
    const good = await fetch(`${base}/api/board/B-0001`)
    expect(await good.json()).toEqual({ id: 'B-0001' })
  })
})
