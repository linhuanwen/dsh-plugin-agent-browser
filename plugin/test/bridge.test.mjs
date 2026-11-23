/**
 * Tests for `Bridge.close()` (TICKET-017).
 *
 * Run with: node --test plugin/test/bridge.test.mjs
 *
 * Unloading the plugin used to call a synchronous `dispose()`: it rejected the
 * waiting commands but returned before the socket stopped listening, and the
 * panel keeps a long-poll parked on that socket. `close()` is the replacement:
 * reject everything waiting, wake the parked poll, and bound the wait so an
 * unload can never hang.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge } from '../bridge.js'

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
