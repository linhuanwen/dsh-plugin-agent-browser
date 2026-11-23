/**
 * Tests for the single-effect lifecycle (TICKET-017).
 *
 * Run with: node --test plugin/test/lifecycle.test.mjs
 *
 * Cordis runs disposal handlers concurrently, so 1.0.x's thirteen separate
 * `ctx.effect` calls could tear the bridge down before the tools were removed
 * from the registry. This test pins the replacement contract: exactly one
 * effect, tool disposers first (reverse order), then the bridge, then the
 * static servers, each step attempted even if an earlier one throws.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAgentBrowser } from '../apply.js'

const TOOL_NAMES = [
  'browser_open', 'browser_snapshot', 'browser_click', 'browser_scroll', 'browser_hover',
  'browser_zoom', 'browser_screenshot', 'browser_type', 'browser_press', 'browser_eval',
  'browser_download',
]

/**
 * A host-context stand-in that runs effects immediately (as Cordis does) and
 * captures the disposer each one returns.
 * @param {string[]} order - records calls in the order they happen.
 * @param {{ throwOnDisposeOf?: string }} [options] - make one tool's disposer fail.
 */
function capturingContext(order, options = {}) {
  const capture = []
  const effects = []
  const ctx = {
    logger: { debug() {} },
    get: () => undefined,
    effect(callback, label) {
      effects.push(label)
      capture.push(callback())
    },
    tools: {
      register(tool) {
        order.push(`register:${tool.name}`)
        return async () => {
          order.push(`dispose:${tool.name}`)
          if (tool.name === options.throwOnDisposeOf) throw new Error(`refused to dispose ${tool.name}`)
        }
      },
    },
  }
  return { ctx, capture, effects }
}

function fakeBridge(order, { failClose = false } = {}) {
  return class {
    constructor(options) {
      this.options = options
      order.push('bridge:new')
    }
    async start() {
      order.push('bridge:start')
      return 8792
    }
    note() {}
    async close() {
      order.push('bridge:close')
      if (failClose) throw new Error('close boom')
    }
    async request() {
      throw new Error('a test must not send commands')
    }
    takeDigest() {
      return ''
    }
  }
}

function fakeSites(order) {
  return class {
    constructor(options) {
      this.options = options
      order.push('sites:new')
    }
    async dispose() {
      order.push('sites:dispose')
    }
  }
}

const fakeTools = () => TOOL_NAMES.map((name) => ({ name }))

const logger = () => {}

test('one effect owns the whole half, and every tool is registered inside it', () => {
  const order = []
  const { ctx, effects } = capturingContext(order)
  applyAgentBrowser(ctx, {}, { Bridge: fakeBridge(order), StaticSites: fakeSites(order), createTools: fakeTools, logger })
  assert.equal(effects.length, 1, 'exactly one ctx.effect')
  assert.equal(order.filter((entry) => entry.startsWith('register:')).length, TOOL_NAMES.length)
})

test('teardown removes tools in reverse order, then the bridge, then the servers', async () => {
  const order = []
  const { ctx, capture } = capturingContext(order)
  applyAgentBrowser(ctx, {}, { Bridge: fakeBridge(order), StaticSites: fakeSites(order), createTools: fakeTools, logger })
  await capture[0]()

  const cleanup = order.slice(order.indexOf('register:browser_download') + 1)
  assert.deepEqual(cleanup.slice(0, TOOL_NAMES.length), [...TOOL_NAMES].reverse().map((name) => `dispose:${name}`))
  assert.deepEqual(cleanup.slice(TOOL_NAMES.length), ['bridge:close', 'sites:dispose'])
})

test('a failing bridge close does not skip the static servers', async () => {
  const order = []
  const { ctx, capture } = capturingContext(order)
  applyAgentBrowser(ctx, {}, {
    Bridge: fakeBridge(order, { failClose: true }),
    StaticSites: fakeSites(order),
    createTools: fakeTools,
    logger,
  })
  await assert.rejects(capture[0](), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.match(error.message, /cleanup step/)
    return true
  })
  assert.ok(order.includes('sites:dispose'), 'the server must still be closed')
})

test('a failing tool disposer does not skip the remaining ones', async () => {
  const order = []
  const { ctx, capture } = capturingContext(order, { throwOnDisposeOf: 'browser_screenshot' })
  applyAgentBrowser(ctx, {}, { Bridge: fakeBridge(order), StaticSites: fakeSites(order), createTools: fakeTools, logger })
  await assert.rejects(capture[0](), AggregateError)
  const disposed = order.filter((entry) => entry.startsWith('dispose:'))
  assert.equal(disposed.length, TOOL_NAMES.length, 'every disposer must run')
  assert.ok(disposed.includes('dispose:browser_open'), 'a disposer after the failing one must still run')
  assert.ok(order.includes('sites:dispose'), 'the servers are still closed')
})

test('discovery waits for the web server and resolves the connection per request', () => {
  // Regression (2026-11-22 restart): apply can run before `webServer` is
  // registered — at boot and right after a profile reload. The old code logged
  // and returned a no-op, leaving the panel without a discovery route, which
  // surfaced only as `bridge_timeout` on every tool call. It must wait instead.
  const order = []
  const { ctx } = capturingContext(order)
  const waits = []
  ctx.inject = (deps, callback) => {
    waits.push({ deps, callback })
    return { dispose() { order.push('inject:dispose') } }
  }
  let connection = null
  ctx.get = (name) => (name === 'connection' ? connection : undefined)
  let route = null
  const server = {
    register(spec) {
      route = spec
      return () => order.push('route:dispose')
    },
  }
  applyAgentBrowser(ctx, {}, { Bridge: fakeBridge(order), StaticSites: fakeSites(order), createTools: fakeTools, logger })
  assert.equal(waits.length, 1, 'must wait for webServer instead of giving up')
  assert.deepEqual(waits[0].deps, ['webServer'])
  assert.equal(route, null, 'nothing to register before the server exists')

  const effects = []
  waits[0].callback({ get: () => server, effect(callback) { effects.push(callback()) } })
  assert.ok(route, 'the route is registered once the server appears')
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/agent-browser/discovery')

  const replies = []
  const request = { method: 'GET' }
  const response = () => ({
    status: 0,
    writeHead(status) { this.status = status },
    end(body) { replies.push({ status: this.status, body: String(body ?? '') }) },
  })
  route.handler(request, response())
  assert.equal(replies.at(-1).status, 503, 'no connection service yet: 503, not a crash')
  connection = { admit: () => ({ peer: 'p1' }) }
  route.handler(request, response())
  assert.equal(replies.at(-1).status, 200)
  assert.match(replies.at(-1).body, /"mark":"dsh-plugin-agent-browser\/1"/)
  assert.equal(effects.length, 1, 'the route disposer is owned by the injected scope')
})

test('a tool name owned by another plugin is reported instead of killing the half', () => {
  // Two browser plugins in one profile claim the same `browser_*` names and this
  // host throws on the duplicate registration. That used to abort the effect, so
  // the plugin looked `active` while none of its tools existed. The remaining
  // tools must register, and the clash must be visible on `/health`.
  const order = []
  const diagnostics = []
  const { ctx } = capturingContext(order)
  const taken = new Set(['browser_open'])
  ctx.tools.definitions = () => [...taken].map((name) => ({ name }))
  const register = ctx.tools.register
  ctx.tools.register = (tool) => {
    if (taken.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`)
    return register(tool)
  }
  class DiagnosticBridge extends fakeBridge(order) {
    setDiagnostics(fields) { diagnostics.push(fields) }
  }
  applyAgentBrowser(ctx, {}, {
    Bridge: DiagnosticBridge,
    StaticSites: fakeSites(order),
    createTools: fakeTools,
    logger,
  })
  const last = diagnostics.at(-1)
  assert.deepEqual(last.conflicts, ['browser_open'])
  assert.equal(last.tools, TOOL_NAMES.length)
  assert.equal(last.registered, TOOL_NAMES.length - 1)
  assert.equal(last.failed.length, 1)
  assert.equal(last.failed[0].name, 'browser_open')
  const registered = order.filter((entry) => entry.startsWith('register:')).map((entry) => entry.slice('register:'.length))
  assert.ok(!registered.includes('browser_open'))
  assert.ok(registered.includes('browser_eval'), 'the other tools still register')
})

test('a clean tool registry reports no conflicts', () => {
  const order = []
  const diagnostics = []
  const { ctx } = capturingContext(order)
  ctx.tools.definitions = () => []
  class DiagnosticBridge extends fakeBridge(order) {
    setDiagnostics(fields) { diagnostics.push(fields) }
  }
  applyAgentBrowser(ctx, {}, {
    Bridge: DiagnosticBridge,
    StaticSites: fakeSites(order),
    createTools: fakeTools,
    logger,
  })
  const last = diagnostics.at(-1)
  assert.deepEqual(last.conflicts, [])
  assert.equal(last.registered, TOOL_NAMES.length)
  assert.deepEqual(last.failed, [])
})

test('the claim gate forwards the display policy stamped on by createGate', async () => {
  // Regression: apply.js used to build the claim gate with a four-argument
  // `request`, so the fifth `{ show, fit }` argument handed to it by
  // `createGate` was dropped and every command silently fell back to the
  // default activation and to a width-fitted page (found in the 016 acceptance
  // run: `fitWidth: false` never reached the panel).
  const order = []
  const calls = []
  const { ctx } = capturingContext(order)
  let seenGate = null
  class RecordingBridge {
    async start() {
      return 8792
    }
    note() {}
    async close() {}
    takeDigest() {
      return ''
    }
    async request(sessionId, type, params, timeoutMs, options) {
      calls.push({ sessionId, type, timeoutMs, options })
      return { ok: true }
    }
  }
  applyAgentBrowser(ctx, {}, {
    Bridge: RecordingBridge,
    StaticSites: fakeSites(order),
    createTools: (_ctx, gate) => {
      seenGate = gate
      return fakeTools()
    },
    logger,
  })
  await seenGate.request('s1', 'open', { url: 'https://example.com/' }, 1000, { show: 'never', fit: 'none' })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].options, { show: 'never', fit: 'none' })
  assert.equal(calls[0].timeoutMs, 1000)
})
