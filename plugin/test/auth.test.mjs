/**
 * Tests for the loopback auth fences (TICKET-019).
 *
 * Run with: node --test plugin/test/auth.test.mjs
 *
 * Loopback is not a boundary: any local process — and any page that can reach
 * the port — is on it. So the bridge listens on a system-picked port, requires
 * a per-process token on every request, and refuses a Host that does not name
 * the listener (DNS rebinding). The static server does the same with a path
 * token plus an HttpOnly cookie.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BRIDGE_PREFIX, Bridge } from '../bridge.js'
import { StaticSites } from '../static.js'

function silent() {
  return new Bridge({ port: 0, logger: () => {}, timeoutMs: 30_000 })
}

/**
 * One raw HTTP request, so the Host header can be set (fetch forbids it).
 * @param {{ host: string, port: number, path: string, method?: string, headers?: Record<string,string>, body?: string }} options
 */
function raw({ host, port, path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

test('a request with no token is refused with a stable code', async () => {
  const bridge = silent()
  try {
    const port = await bridge.start()
    const response = await raw({ host: '127.0.0.1', port, path: `${BRIDGE_PREFIX}/health`, method: 'POST', body: '{}' })
    assert.equal(response.status, 403)
    const payload = JSON.parse(response.body)
    assert.equal(payload.error.code, 'unauthorized')
    assert.equal(payload.ok, false)
  } finally {
    await bridge.close()
  }
})

test('a wrong token is refused and the real one is accepted', async () => {
  const bridge = silent()
  try {
    const port = await bridge.start()
    const wrong = await raw({
      host: '127.0.0.1',
      port,
      path: `${BRIDGE_PREFIX}/health`,
      headers: { authorization: 'Bearer not-the-token' },
    })
    assert.equal(wrong.status, 403)

    // A short value exercises the length-mismatch branch: it must answer, not throw.
    const short = await raw({
      host: '127.0.0.1',
      port,
      path: `${BRIDGE_PREFIX}/health`,
      headers: { 'x-agent-browser-token': 'short' },
    })
    assert.equal(short.status, 403)

    // Safe methods may carry the token in the query, which is what the poll uses.
    const query = await raw({ host: '127.0.0.1', port, path: `${BRIDGE_PREFIX}/health?token=${encodeURIComponent(bridge.token)}` })
    assert.equal(query.status, 200)
    assert.equal(JSON.parse(query.body).mark, 'dsh-plugin-agent-browser/1')

    const header = await raw({
      host: '127.0.0.1',
      port,
      path: `${BRIDGE_PREFIX}/health`,
      headers: { authorization: `Bearer ${bridge.token}` },
    })
    assert.equal(header.status, 200)
  } finally {
    await bridge.close()
  }
})

test('the query token is not accepted on a state-changing method', async () => {
  const bridge = silent()
  try {
    const port = await bridge.start()
    const response = await raw({
      host: '127.0.0.1',
      port,
      path: `${BRIDGE_PREFIX}/log?token=${encodeURIComponent(bridge.token)}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'smuggled' }),
    })
    assert.equal(response.status, 403)
  } finally {
    await bridge.close()
  }
})

test('a forged Host is refused even with the right token', async () => {
  const bridge = silent()
  try {
    const port = await bridge.start()
    const response = await raw({
      host: '127.0.0.1',
      port,
      path: `${BRIDGE_PREFIX}/health`,
      headers: { host: 'evil.example', authorization: `Bearer ${bridge.token}` },
    })
    assert.equal(response.status, 403)
    assert.equal(JSON.parse(response.body).error.code, 'unauthorized')
  } finally {
    await bridge.close()
  }
})

test('two bridges get different ports and refuse each other\'s token', async () => {
  const first = silent()
  const second = silent()
  try {
    const firstPort = await first.start()
    const secondPort = await second.start()
    assert.notEqual(firstPort, secondPort)
    assert.notEqual(first.token, second.token)

    const crossed = await raw({
      host: '127.0.0.1',
      port: secondPort,
      path: `${BRIDGE_PREFIX}/health`,
      headers: { authorization: `Bearer ${first.token}` },
    })
    assert.equal(crossed.status, 403)

    const own = await raw({
      host: '127.0.0.1',
      port: secondPort,
      path: `${BRIDGE_PREFIX}/health`,
      headers: { authorization: `Bearer ${second.token}` },
    })
    assert.equal(own.status, 200)
  } finally {
    await first.close()
    await second.close()
  }
})

test('the static server serves only with the token or its cookie', async () => {
  const site = await mkdtemp(join(tmpdir(), 'dsh-static-auth-'))
  await writeFile(join(site, 'index.html'), '<h1>secret</h1>')
  const sites = new StaticSites()
  try {
    const info = await sites.ensure(site)
    const bare = await fetch(`${info.url}/index.html`)
    assert.equal(bare.status, 403)
    const wrong = await fetch(`${info.url}/t/wrong/index.html`)
    assert.equal(wrong.status, 403)
    const right = await fetch(`${info.url}/t/${info.token}/index.html`, { redirect: 'manual' })
    assert.equal(right.status, 302)
    assert.equal(right.headers.get('location'), '/t/index.html')
    assert.match(right.headers.get('set-cookie') ?? '', /HttpOnly/)
  } finally {
    await sites.dispose()
    await rm(site, { recursive: true, force: true })
  }
})
