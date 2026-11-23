/**
 * Tests for `Bridge.close()` (TICKET-017) and the settle-body cap (TICKET-034).
 *
 * Run with: node --test plugin/test/bridge.test.mjs
 *
 * Unloading the plugin used to call a synchronous `dispose()`: it rejected the
 * waiting commands but returned before the socket stopped listening, and the
 * panel keeps a long-poll parked on that socket. `close()` is the replacement:
 * reject everything waiting, wake the parked poll, and bound the wait so an
 * unload can never hang.
 *
 * The settle-body tests cover a 4 MiB cap that sat just under a real map
 * screenshot (4,239,798 characters): the reply was refused, the panel's settle
 * never landed, and the tool waited out its whole budget before reporting
 * `bridge_timeout`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge, BRIDGE_PREFIX, MAX_BODY_BYTES } from '../bridge.js'

function silent() {
  return new Bridge({ port: 0, logger: () => {}, timeoutMs: 30_000 })
}

test('close() rejects a command that is still waiting', async () => {
  const bridge = silent()
  const pending = bridge.request('s1', 'open', { url: 'https://example.com' }, 30_000)
  // Let the first listen settle so the command really is queued, not racing it.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const started = Date.now()
  await bridge.close()
  await assert.rejects(pending, /bridge_closed:/)
  assert.ok(Date.now() - started < 2_000, 'a waiting command must not sit out its timeout')
})

test('a request after close() fails immediately', async () => {
  const bridge = silent()
  await bridge.close()
  await assert.rejects(bridge.request('s1', 'click', {}), /bridge_closed:/)
})

test('close() is idempotent and safe before the socket ever listened', async () => {
  const bridge = silent()
  await bridge.close()
  await bridge.close()
  assert.equal(bridge.port, 0)
})

/** Start a bridge and return the base URL plus the auth header its panel would send. */
async function listening() {
  const bridge = silent()
  await bridge.start()
  return {
    bridge,
    base: `http://127.0.0.1:${bridge.port}${BRIDGE_PREFIX}`,
    auth: { authorization: `Bearer ${bridge.token}` },
  }
}

/** Queue one command and pull it, so a test has a real id to settle. */
async function pulledCommand(bridge, base, auth, type, params) {
  const pending = bridge.request('s1', type, params, 30_000)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const answer = await (await fetch(`${base}/pending?wait=1000`, { headers: auth })).json()
  const id = answer.sessions?.s1?.[0]?.id
  assert.ok(typeof id === 'string', 'the command should have been handed to the panel')
  return { pending, id }
}

test('a settle body over the old 4 MiB cap is accepted (TICKET-034)', async () => {
  const { bridge, base, auth } = await listening()
  try {
    const { pending, id } = await pulledCommand(bridge, base, auth, 'screenshot', { mode: 'viewport' })
    // 4,239,798 characters is what a tile-heavy map page really produced.
    const dataUrl = `data:image/png;base64,${'A'.repeat(4_239_798)}`
    const body = JSON.stringify({ id, ok: true, result: { dataUrl } })
    assert.ok(body.length > 4 * 1024 * 1024, 'this body has to be over the old cap to prove anything')
    const res = await fetch(`${base}/settle`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body,
    })
    assert.equal(res.status, 200, 'a 4.24 M-character reply must be delivered, not refused')
    const value = await pending
    assert.equal(value.dataUrl.length, dataUrl.length)
  } finally {
    await bridge.close()
  }
})

test('a body over MAX_BODY_BYTES is refused with 413 and a readable code (TICKET-034)', async () => {
  const { bridge, base, auth } = await listening()
  try {
    const body = JSON.stringify({ id: 'nobody', ok: true, result: { pad: 'A'.repeat(MAX_BODY_BYTES) } })
    const res = await fetch(`${base}/settle`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body,
    })
    assert.equal(res.status, 413)
    const payload = await res.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'budget_exceeded')
    assert.equal(payload.limit, MAX_BODY_BYTES)
  } finally {
    await bridge.close()
  }
})
