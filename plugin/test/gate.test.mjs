/**
 * Tests for `createGate` (TICKET-037): the seam every tool call passes through.
 *
 * Run with: node --test plugin/test/gate.test.mjs
 *
 * The regression this file exists for: `apply.js` hands the tools a thin gate
 * object (claim sync + display policy), and `createGate` decides whether the
 * host can ask the user by looking for `approve`/`hasClient` on that object.
 * When the wrapper forgot to forward them, `canAsk()` was false and every write
 * silently executed without a prompt — the panel never showed the confirm bar,
 * while every unit test still passed because the fake bridges had no approve.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGate } from '../tools.js'

const PAGE = 'http://127.0.0.1:7789/t/demo/approval-form.html'

function fakeBridge(overrides = {}) {
  const calls = []
  const approvals = []
  const bridge = {
    calls,
    approvals,
    hasClient: () => true,
    pageOf: () => ({ url: PAGE, title: '写动作确认夹具' }),
    approve: async (sessionId, request) => {
      approvals.push({ sessionId, ...request })
      return { decision: 'once' }
    },
    takeDigest: () => '',
    request: async (sessionId, type, params) => {
      calls.push({ sessionId, type, params })
      if (type === 'inspect') {
        const password = params?.ref === 'e3'
        return {
          ok: true,
          info: password
            ? { tag: 'input', role: 'password', name: '密码' }
            : { tag: 'input', role: 'textbox', name: '普通文本框' },
          isSubmit: false,
          url: PAGE,
        }
      }
      return { ok: true, info: { tag: 'input' }, length: 3 }
    },
    ...overrides,
  }
  return bridge
}

function gated(bridge) {
  return createGate(bridge, { approvals: { mode: 'first-touch', timeoutMs: 30_000, sensitiveSites: [] } })
}

test('a type asks once with the page origin and the type class', async () => {
  const bridge = fakeBridge()
  const gate = gated(bridge)
  await gate.request('s1', 'type', { ref: 'e2', text: 'hello', clear: true }, 20_000)
  assert.equal(bridge.approvals.length, 1)
  assert.equal(bridge.approvals[0].actionClass, 'type')
  assert.equal(bridge.approvals[0].origin, 'http://127.0.0.1:7789')
  assert.match(bridge.approvals[0].summary, /输入文字/)
  assert.equal(bridge.calls.at(-1).type, 'type', 'the action still runs after the answer')
})

test('a submit click inspects first, then asks with the submit class', async () => {
  const bridge = fakeBridge({
    request: async (sessionId, type, params) => {
      bridge.calls.push({ sessionId, type, params })
      if (type === 'inspect') {
        return {
          ok: true,
          info: { tag: 'button', role: 'button', name: '提交' },
          isSubmit: true,
          url: PAGE,
        }
      }
      return { ok: true, info: { tag: 'button' } }
    },
  })
  const gate = gated(bridge)
  await gate.request('s1', 'click', { ref: 'e4' }, 20_000)
  assert.deepEqual(bridge.calls.map((call) => call.type), ['inspect', 'click'])
  assert.equal(bridge.approvals.length, 1)
  assert.equal(bridge.approvals[0].actionClass, 'submit')
  assert.match(bridge.approvals[0].summary, /提交/)
})

test('a password box asks nothing: the page itself hard-refuses it', async () => {
  const bridge = fakeBridge()
  const gate = gated(bridge)
  await gate.request('s1', 'type', { ref: 'e3', text: 'secret', clear: true }, 20_000)
  assert.equal(bridge.approvals.length, 0, 'a password write must never reach the prompt')
  assert.deepEqual(bridge.calls.map((call) => call.type), ['inspect', 'type'])
})

test('a plain link click is a read and never asks', async () => {
  const bridge = fakeBridge()
  const gate = gated(bridge)
  await gate.request('s1', 'click', { ref: 'e6' }, 20_000)
  assert.equal(bridge.approvals.length, 0)
  assert.deepEqual(bridge.calls.map((call) => call.type), ['inspect', 'click'])
})

test('a coordinate click is a read and never asks', async () => {
  const bridge = fakeBridge()
  const gate = gated(bridge)
  await gate.request('s1', 'click', { x: 10, y: 20 }, 20_000)
  assert.equal(bridge.approvals.length, 0)
  assert.deepEqual(bridge.calls.map((call) => call.type), ['click'])
})

test('a site grant covers the origin for the session without a second prompt', async () => {
  const bridge = fakeBridge({
    approve: async (sessionId, request) => {
      bridge.approvals.push({ sessionId, ...request })
      return { decision: 'site' }
    },
  })
  const gate = gated(bridge)
  await gate.request('s1', 'type', { ref: 'e2', text: 'a' }, 20_000)
  await gate.request('s1', 'type', { ref: 'e2', text: 'b' }, 20_000)
  assert.equal(bridge.approvals.length, 1, 'the second write is covered by the grant')
})

test('mode off never asks and never inspects', async () => {
  const bridge = fakeBridge()
  const gate = createGate(bridge, { approvals: { mode: 'off', timeoutMs: 30_000, sensitiveSites: [] } })
  await gate.request('s1', 'click', { ref: 'e4' }, 20_000)
  await gate.request('s1', 'type', { ref: 'e2', text: 'x' }, 20_000)
  assert.equal(bridge.approvals.length, 0)
  assert.deepEqual(bridge.calls.map((call) => call.type), ['click', 'type'])
})

test('a host that cannot ask keeps the pre-1.5 behaviour', async () => {
  const bridge = fakeBridge()
  delete bridge.approve
  const gate = gated(bridge)
  await gate.request('s1', 'type', { ref: 'e2', text: 'x' }, 20_000)
  assert.deepEqual(bridge.calls.map((call) => call.type), ['type'])
})

test('an eval inspects the page first so the prompt names the real site', async () => {
  const bridge = fakeBridge()
  const gate = gated(bridge)
  await gate.request('s1', 'eval', { script: 'document.title' }, 20_000)
  assert.deepEqual(bridge.calls.map((call) => call.type), ['inspect', 'eval'], 'the page is the witness of its own address')
  assert.equal(bridge.approvals.length, 1)
  assert.equal(bridge.approvals[0].actionClass, 'eval')
  assert.equal(bridge.approvals[0].origin, 'http://127.0.0.1:7789')
  assert.match(bridge.approvals[0].summary, /执行页面脚本/)
})

test('a download asks through requestApproval with the url origin', async () => {
  const bridge = fakeBridge()
  const gate = gated(bridge)
  await gate.requestApproval('s1', { actionClass: 'download', url: 'https://example.com/a.pdf' })
  assert.equal(bridge.approvals.length, 1)
  assert.equal(bridge.approvals[0].actionClass, 'download')
  assert.equal(bridge.approvals[0].origin, 'https://example.com')
})

test('an approval error reaches the caller unchanged and the action never runs', async () => {
  const bridge = fakeBridge({
    approve: async () => {
      const error = new Error('approval_denied: the user said no; nothing was sent to the page.')
      error.code = 'approval_denied'
      throw error
    },
  })
  const gate = gated(bridge)
  await assert.rejects(
    gate.request('s1', 'type', { ref: 'e2', text: 'x' }, 20_000),
    (error) => error.code === 'approval_denied',
  )
  assert.deepEqual(bridge.calls.map((call) => call.type), ['inspect'], 'nothing was sent to the page')
})

void assert
