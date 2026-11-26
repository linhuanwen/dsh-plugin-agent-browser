/**
 * Tests for `browser_drag` (TICKET-052).
 *
 * Run with: node --test plugin/test/drag.test.mjs
 *
 * The page half lives in `inject/actions.js` (8 tests in `actions.test.mjs`)
 * and the event sequence is exercised live (`docs/cases/026`); here we pin the
 * tool boundary: address and drop-target validation, the request shape, the
 * rendered sentence, and the drag-specific refusals.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserDragTool } from '../tools.js'

const EXEC = { agent: { id: 's1' } }

function fakeBridge(answer) {
  const calls = []
  return {
    calls,
    async request(sessionId, type, params, timeoutMs) {
      calls.push({ sessionId, type, params, timeoutMs })
      return answer
    },
    takeDigest: () => '',
  }
}

function pageAnswer(extra = {}) {
  return {
    ok: true,
    info: { tag: 'div', role: 'slider', name: '音量' },
    from: { x: 110, y: 110, width: 20, height: 20 },
    to: { x: 350, y: 130, width: 100, height: 60 },
    target: { info: { tag: 'div', role: 'region', name: '音量轨道' }, point: { x: 350, y: 130 } },
    steps: 8,
    dispatched: 8,
    matched: 1,
    ...extra,
  }
}

test('from/to addresses become one drag request and a committed result', async () => {
  const bridge = fakeBridge(pageAnswer())
  const tool = browserDragTool(bridge)
  const value = await tool.execute({ from: { loc: 'css:#handle' }, to: { loc: 'css:#lane' }, steps: 4 }, EXEC)
  assert.equal(bridge.calls.length, 1)
  const call = bridge.calls[0]
  assert.equal(call.type, 'drag')
  assert.equal(call.timeoutMs, 20_000)
  assert.equal(call.params.loc, 'css:#handle')
  assert.equal(call.params.toLoc, 'css:#lane')
  assert.equal(call.params.steps, 4)
  assert.equal(typeof call.params.source, 'string')
  assert.ok(call.params.source.includes('dshAction'), 'the page script travels with the command')
  assert.equal(value.effect, 'committed')
  assert.deepEqual(value.from, { x: 110, y: 110, width: 20, height: 20 })
  assert.deepEqual(value.to, { x: 350, y: 130, width: 100, height: 60 })
  assert.deepEqual(value.target, { tag: 'div', role: 'region', name: '音量轨道' })
  assert.equal(value.steps, 8)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /Dragged slider "音量" from \(110, 110\) to \(350, 130\)\./)
  assert.match(text, /Released over region "音量轨道"\./)
  assert.match(text, /A drag is a write/)
})

test('a ref source and a selector target keep their own parameter names', async () => {
  const bridge = fakeBridge(pageAnswer())
  const tool = browserDragTool(bridge)
  await tool.execute({ from: { ref: 'e3' }, to: { selector: '#lane', strict: false } }, EXEC)
  const params = bridge.calls[0].params
  assert.equal(params.ref, 'e3')
  assert.equal(params.toSelector, '#lane')
  assert.equal(params.toLoc, undefined)
  assert.equal(params.toX, undefined)
})

test('a viewport point target sends toX/toY and renders no drop element', async () => {
  const bridge = fakeBridge(pageAnswer({
    target: null,
    to: { x: 400, y: 300, width: 0, height: 0 },
  }))
  const tool = browserDragTool(bridge)
  const value = await tool.execute({ from: { loc: 'css:#handle' }, to: { toX: 400, toY: 300 } }, EXEC)
  assert.equal(bridge.calls[0].params.toX, 400)
  assert.equal(bridge.calls[0].params.toY, 300)
  assert.equal(value.target, undefined)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /to \(400, 300\)/)
  assert.doesNotMatch(text, /Released over/)
})

test('dx/dy relative offsets are forwarded as a delta, not a point', async () => {
  const bridge = fakeBridge(pageAnswer())
  const tool = browserDragTool(bridge)
  await tool.execute({ from: { loc: 'css:#handle' }, to: { dx: 80, dy: -40 } }, EXEC)
  const params = bridge.calls[0].params
  assert.equal(params.dx, 80)
  assert.equal(params.dy, -40)
  assert.equal(params.toX, undefined)
})

test('ambiguous or incomplete addresses are refused before the page is touched', async () => {
  const bridge = fakeBridge(pageAnswer())
  const tool = browserDragTool(bridge)
  await assert.rejects(() => tool.execute({ to: { loc: 'css:#lane' } }, EXEC), /from needs a ref, loc or selector/)
  await assert.rejects(
    () => tool.execute({ from: { loc: 'css:#a', ref: 'e1' }, to: { loc: 'css:#lane' } }, EXEC),
    /from takes exactly one of ref, loc or selector/,
  )
  await assert.rejects(() => tool.execute({ from: { loc: 'css:#a' }, to: {} }, EXEC), /to needs a drop target/)
  await assert.rejects(
    () => tool.execute({ from: { loc: 'css:#a' }, to: { toX: 10 } }, EXEC),
    /both toX and toY/,
  )
  await assert.rejects(
    () => tool.execute({ from: { loc: 'css:#a' }, to: { loc: 'css:#lane', dx: 10 } }, EXEC),
    /exactly one drop target/,
  )
  assert.equal(bridge.calls.length, 0, 'nothing reached the page')
})

test('a page refusal becomes an actionable drag error, not a cheerful success', async () => {
  const bridge = fakeBridge({ ok: false, error: 'occluded', behind: { role: 'dialog', name: 'Cookie 提示' } })
  const tool = browserDragTool(bridge)
  await assert.rejects(
    () => tool.execute({ from: { loc: 'css:#handle' }, to: { loc: 'css:#lane' } }, EXEC),
    /covered by dialog "Cookie 提示".*Nothing was dragged\./s,
  )
})

test('an out-of-viewport drop target names the drop target, not the source', async () => {
  const bridge = fakeBridge({ ok: false, error: 'out_of_view', target: true })
  const tool = browserDragTool(bridge)
  await assert.rejects(
    () => tool.execute({ from: { loc: 'css:#handle' }, to: { loc: 'css:#lane' } }, EXEC),
    /drop target is outside the viewport.*Nothing was dragged\./s,
  )
})
