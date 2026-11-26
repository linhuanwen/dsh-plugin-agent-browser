/**
 * Tests for cancellation (TICKET-021).
 *
 * Run with: node --test plugin/test/cancel.test.mjs
 *
 * Two different guarantees, tested separately:
 * - a command still in the host queue is removed before it can reach the page;
 * - a command the panel already pulled cannot be undone, so a `cancel` frame asks
 *   the panel to stop what it can and to drop the result. The host then answers a
 *   late `/settle` with `ignored: true` instead of "unknown command".
 *
 * The bridge is a real HTTP server here, because the queue and the token fence
 * are the parts under test; the panel is simulated with plain `node:http` calls.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { request as httpRequest } from 'node:http'
import { Bridge, BRIDGE_PREFIX } from '../bridge.js'
import { createTools } from '../tools.js'

function silent() {
  return new Bridge({ port: 0, logger: () => {}, timeoutMs: 30_000 })
}

/** One request to the bridge, with the token and Host a real panel would present. */
async function call(bridge, pathname, { method = 'GET', body } = {}) {
  // `port` is only known after the first listen; `start()` is memoized.
  await bridge.start()
  const headers = { authorization: `Bearer ${bridge.token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: bridge.port,
      path: `${BRIDGE_PREFIX}${pathname}`,
      method,
      headers,
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        resolve({ status: res.statusCode, body: text === '' ? null : JSON.parse(text) })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

/** One poll as a panel would make it; returns the commands for `session`. */
async function pull(bridge, session = 's1') {
  const response = await call(bridge, '/pending?wait=0')
  assert.equal(response.status, 200)
  return response.body.sessions?.[session] ?? []
}

test('an already-aborted call never enters the queue', async () => {
  const bridge = silent()
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      bridge.request('s1', 'click', { ref: 'e1' }, 30_000, { signal: controller.signal }),
      (error) => error.code === 'cancelled' && /cancelled:/.test(error.message),
    )
    assert.deepEqual(await pull(bridge), [])
  } finally {
    await bridge.close()
  }
})

test('aborting a queued command removes it and queues a cancel frame', async () => {
  const bridge = silent()
  try {
    const controller = new AbortController()
    const pending = bridge.request('s1', 'click', { ref: 'e1' }, 30_000, { signal: controller.signal })
    // Let the request reach the queue before the abort lands.
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()
    await assert.rejects(pending, /cancelled:/)

    const commands = await pull(bridge)
    assert.equal(commands.length, 1, 'the click must be gone; only the cancel frame remains')
    const frame = commands[0]
    assert.equal(frame.type, 'cancel')
    assert.equal(frame.show, 'never', 'a control frame must never wake a hidden panel')
    assert.match(frame.params.target, /^c\d+$/)
  } finally {
    await bridge.close()
  }
})

test('cancelling a command the panel already pulled reports an unknown effect', async () => {
  const bridge = silent()
  try {
    const controller = new AbortController()
    const pending = bridge.request('s1', 'click', { ref: 'e1' }, 30_000, { signal: controller.signal })
    // The panel pulls (and starts executing) the click...
    const [command] = await pull(bridge)
    assert.equal(command.type, 'click')
    // ...then the caller gives up. A pulled click may have landed, so the call
    // ends in the honest middle state, not in `cancelled` (TICKET-042).
    controller.abort()
    await assert.rejects(pending, (error) => error.code === 'action_unknown'
      && error.retryable === false
      && error.details?.effect === 'unknown'
      && error.details?.delivered === true)
    const settled = await call(bridge, '/settle', {
      method: 'POST',
      body: { id: command.id, ok: true, result: { clicked: true } },
    })
    assert.equal(settled.body.ok, true)
    assert.equal(settled.body.ignored, true)
  } finally {
    await bridge.close()
  }
})

test('cancelled, timed-out and shut-down calls report different codes', async () => {
  const bridge = silent()
  try {
    const controller = new AbortController()
    const cancelled = bridge.request('s1', 'click', {}, 30_000, { signal: controller.signal })
    controller.abort()
    await assert.rejects(cancelled, (error) => error.code === 'cancelled')
    await assert.rejects(
      bridge.request('s2', 'click', {}, 50),
      (error) => error.code === 'bridge_timeout',
    )
    await bridge.close()
    await assert.rejects(
      bridge.request('s3', 'click', {}),
      (error) => error.code === 'bridge_closed',
    )
  } finally {
    await bridge.close()
  }
})

test('a hundred cancelled calls leave no listeners or waiting entries behind', async () => {
  const bridge = silent()
  try {
    for (let index = 0; index < 100; index += 1) {
      const controller = new AbortController()
      const pending = bridge.request('s1', 'click', {}, 30_000, { signal: controller.signal })
      controller.abort()
      await assert.rejects(pending, /cancelled:/)
      assert.equal(
        getEventListeners(controller.signal, 'abort').length,
        0,
        'the abort listener must be removed when the call finishes',
      )
    }
    // If a waiting entry had leaked, this would resolve instead of timing out.
    await assert.rejects(
      bridge.request('s1', 'click', {}, 40),
      (error) => error.code === 'bridge_timeout',
    )
  } finally {
    await bridge.close()
  }
})

test('cancelling one session leaves another session alone', async () => {
  const bridge = silent()
  try {
    const controller = new AbortController()
    const first = bridge.request('s1', 'click', { ref: 'e1' }, 30_000, { signal: controller.signal })
    const second = bridge.request('s2', 'click', { ref: 'e2' }, 30_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort()
    await assert.rejects(first, /cancelled:/)

    const pulled = await pull(bridge, 's2')
    assert.equal(pulled.length, 1)
    assert.equal(pulled[0].type, 'click')
    const settled = await call(bridge, '/settle', {
      method: 'POST',
      body: { id: pulled[0].id, ok: true, result: { clicked: true } },
    })
    assert.equal(settled.body.ignored, undefined, 'the other session must settle normally')
    assert.deepEqual(await second, { clicked: true })
  } finally {
    await bridge.close()
  }
})

test('an aborted tool call never reaches the bridge', async () => {
  const calls = []
  const fakeBridge = {
    request(...args) {
      calls.push(args)
      return Promise.resolve({ ok: true })
    },
    takeDigest() {
      return ''
    },
  }
  const tools = createTools({}, fakeBridge, { ensure: async () => ({ url: '', root: '', token: '' }) }, {})
  const click = tools.find((tool) => tool.name === 'browser_click')
  assert.ok(click, 'browser_click must exist')

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    click.execute({ ref: 'e1' }, { agent: { id: 'session-1' }, signal: controller.signal }),
    (error) => error.code === 'cancelled',
  )
  assert.equal(calls.length, 0, 'a cancelled call must not touch the page')
})
