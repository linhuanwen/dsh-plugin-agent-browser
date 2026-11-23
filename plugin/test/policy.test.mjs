/**
 * Tests for the per-command display policy (TICKET-016).
 *
 * Run with: node --test plugin/test/policy.test.mjs
 *
 * `activation` and `fitWidth` are volatile: the config editor changes them live,
 * so the gate must read them on *every* command rather than capturing the value
 * when the tools are built. This is also the regression test for the 1.0.x bug
 * where `fitWidth: false` never reached `createTools` (a 4-argument call against
 * a 5-parameter signature), so the page was always fitted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGate } from '../tools.js'

/** A bridge stand-in that records the arguments of each request. */
function fakeBridge() {
  return {
    calls: [],
    request(...args) {
      this.calls.push(args)
      return Promise.resolve({ ok: true })
    },
    takeDigest() {
      return ''
    },
  }
}

/** A volatile-like reader whose value the test can flip. */
function reader(initial) {
  let value = initial
  return { get: () => value, set: (next) => { value = next } }
}

test('the gate stamps show and fit from plain config values', async () => {
  const bridge = fakeBridge()
  const gate = createGate(bridge, { activation: 'manual', fitWidth: false })
  await gate.request('s1', 'click', { ref: 'e1' }, 1000)
  const [, type, params, timeoutMs, options] = bridge.calls[0]
  assert.equal(type, 'click')
  assert.deepEqual(params, { ref: 'e1' })
  assert.equal(timeoutMs, 1000)
  assert.deepEqual(options, { show: 'never', fit: 'none' })
})

test('the gate reads volatile readers again on every command', async () => {
  const activation = reader('auto')
  const fitWidth = reader(true)
  const bridge = fakeBridge()
  const gate = createGate(bridge, { activation, fitWidth })

  await gate.request('s1', 'click', {}, 1000)
  activation.set('always')
  fitWidth.set(false)
  await gate.request('s1', 'click', {}, 1000)

  assert.deepEqual(bridge.calls[0][4], { show: 'once', fit: 'width' })
  assert.deepEqual(bridge.calls[1][4], { show: 'always', fit: 'none' })
})

test('an absent or unusable activation falls back to auto, never to manual', async () => {
  const bridge = fakeBridge()
  for (const activation of [undefined, null, 'sometimes', { get: () => '' }]) {
    const gate = createGate(bridge, { activation })
    await gate.request('s1', 'screenshot', {}, 1000)
  }
  for (const call of bridge.calls) {
    assert.deepEqual(call[4], { show: 'once', fit: 'width' }, `activation ${JSON.stringify(undefined)}`)
  }
})
