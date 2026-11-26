/**
 * Tests for the write-action tri-state `effect` (SPEC-004 B4, TICKET-042).
 *
 * Run with: node --test plugin/test/effect.test.mjs
 *
 * The question these tests answer for the model: after a write failed, can it
 * retry? Two states matter:
 * - `none` — the command never left the host; retrying is safe;
 * - `unknown` — the panel pulled it, so the page may have executed it; the call
 *   ends as `action_unknown` (not retryable) and the model has to look first.
 *
 * The bridge cases use a real HTTP bridge because "pulled vs still queued" is
 * the exact distinction under test; the tool cases use a fake bridge and walk
 * the public `createTools` surface, so the wrapper cannot be forgotten.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { Bridge, BRIDGE_PREFIX } from '../bridge.js'
import { createTools } from '../tools.js'

const PAGE = 'http://127.0.0.1:7789/t/demo/approval-form.html'
const EXEC = { agent: { id: 's1' } }

function silent() {
  return new Bridge({ port: 0, logger: () => {}, timeoutMs: 30_000 })
}

/** One panel-style request to the bridge, with token and Host. */
async function call(bridge, pathname, { method = 'GET', body } = {}) {
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
      res.on('end', () => resolve({ status: res.statusCode, body: text === '' ? null : JSON.parse(text) }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

/** One poll as a real panel makes it. */
async function pull(bridge, session = 's1') {
  const response = await call(bridge, '/pending?wait=0')
  assert.equal(response.status, 200)
  return response.body.sessions?.[session] ?? []
}

test('a pulled write that times out is action_unknown, not retryable', async () => {
  const bridge = silent()
  try {
    const pending = bridge.request('s1', 'click', { ref: 'e1' }, 120)
    const [command] = await pull(bridge)
    assert.equal(command.type, 'click')
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, 'action_unknown')
      assert.equal(error.retryable, false)
      assert.match(error.hint, /snapshot/i)
      assert.deepEqual(error.details, { effect: 'unknown', delivered: true, type: 'click', reason: error.details.reason })
      return true
    })
  } finally {
    await bridge.close()
  }
})

test('a write that was never pulled keeps the retryable bridge_timeout', async () => {
  const bridge = silent()
  try {
    await assert.rejects(
      bridge.request('s1', 'click', { ref: 'e1' }, 60),
      (error) => error.code === 'bridge_timeout' && error.retryable === true,
    )
  } finally {
    await bridge.close()
  }
})

test('a read that was pulled keeps bridge_timeout: reads have no effect', async () => {
  const bridge = silent()
  try {
    const pending = bridge.request('s1', 'snapshot', {}, 80)
    const [command] = await pull(bridge)
    assert.equal(command.type, 'snapshot')
    await assert.rejects(pending, (error) => error.code === 'bridge_timeout')
  } finally {
    await bridge.close()
  }
})

test('a takeover after the panel pulled a write reports an unknown effect', async () => {
  const bridge = silent()
  try {
    const pending = bridge.request('s1', 'eval', { script: 'document.title' }, 30_000)
    const [command] = await pull(bridge)
    assert.equal(command.type, 'eval')
    bridge.setPhase('s1', 'taken_over', { reason: 'test' })
    await assert.rejects(pending, (error) => error.code === 'action_unknown'
      && error.details?.delivered === true
      && error.details?.type === 'eval')
  } finally {
    await bridge.close()
  }
})

/** A fake bridge that answers every command successfully. */
function fakeBridge(answers = {}) {
  const calls = []
  return {
    calls,
    async request(sessionId, type, params) {
      calls.push({ sessionId, type, params })
      if (Object.hasOwn(answers, type)) return answers[type]
      if (type === 'inspect') {
        return { ok: true, info: { tag: 'input', role: 'textbox', name: '普通文本框' }, isSubmit: false, url: PAGE }
      }
      return { ok: true, info: { tag: 'button', role: 'button', name: '提交' }, length: 5, key: 'Enter', keyCode: 'Enter', serialized: '"ok"', x: 1, y: 2 }
    },
  }
}

function built(bridge) {
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { ensure: async () => process.cwd() }
      return null
    },
    logger: { debug() {} },
  }
  return createTools(ctx, bridge, undefined, { approvals: { mode: 'off' } })
}

function toolNamed(tools, name) {
  const tool = tools.find((entry) => entry.name === name)
  assert.ok(tool, `${name} is registered`)
  return tool
}

test('click, type, press and eval stamp effect committed on success', async () => {
  const tools = built(fakeBridge())
  const click = await toolNamed(tools, 'browser_click').execute({ ref: 'e1' }, EXEC)
  const type = await toolNamed(tools, 'browser_type').execute({ ref: 'e2', text: 'hello' }, EXEC)
  const press = await toolNamed(tools, 'browser_press').execute({ key: 'Enter' }, EXEC)
  const evalResult = await toolNamed(tools, 'browser_eval').execute({ script: 'document.title' }, EXEC)
  for (const value of [click, type, press, evalResult]) assert.equal(value.effect, 'committed')
})

test('a failure before the command leaves the host is stamped effect none', async () => {
  const bridge = fakeBridge()
  const tools = built(bridge)
  await assert.rejects(
    toolNamed(tools, 'browser_click').execute({ ref: 'not-a-ref' }, EXEC),
    (error) => {
      assert.equal(error.details?.effect, 'none')
      assert.match(bridge.calls.map((entry) => entry.type).join(','), /^$/)
      return true
    },
  )
})

test('an eval that throws in the page is unknown, because the script may have run', async () => {
  const tools = built(fakeBridge({ eval: { ok: false, error: 'TypeError: nope' } }))
  await assert.rejects(
    toolNamed(tools, 'browser_eval').execute({ script: 'boom()' }, EXEC),
    (error) => {
      assert.equal(error.code, 'action_unknown')
      assert.equal(error.retryable, false)
      assert.equal(error.details?.effect, 'unknown')
      assert.equal(error.details?.delivered, true)
      return true
    },
  )
})

test('a refused download is stamped effect none', async () => {
  const tools = built(fakeBridge())
  const result = await toolNamed(tools, 'browser_download').execute({ url: 'http://127.0.0.1:1/secret.txt' }, EXEC)
  assert.equal(result.effect, 'none')
  assert.equal(result.download_failed.code, 'download_rejected')
})
