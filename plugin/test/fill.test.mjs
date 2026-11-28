/**
 * Tests for `browser_fill` (TICKET-059).
 *
 * Run with: node --test plugin/test/fill.test.mjs
 *
 * The page half lives in `inject/actions.js` (five tests in `actions.test.mjs`)
 * and the batch is exercised live (`docs/cases/033`); here we pin the tool
 * boundary: the normalized request, the rendered batch, the partial-fill
 * wording, and every validation that must fail before the bridge is touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserFillTool } from '../tools.js'

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
    fields: [
      { index: 0, info: { tag: 'input', role: 'textbox', name: '邮箱' }, value: 'a@b.c', length: 5, inserted: true, rect: { x: 10, y: 10, width: 200, height: 30 } },
      { index: 1, info: { tag: 'input', role: 'textbox', name: '昵称' }, value: '林', length: 1, inserted: true, rect: { x: 10, y: 60, width: 200, height: 30 } },
    ],
    submit: { info: { tag: 'button', role: 'button', name: '保存' }, method: 'click' },
    navigated: false,
    ...extra,
  }
}

test('fields become one fill request and a committed batch result', async () => {
  const bridge = fakeBridge(pageAnswer())
  const tool = browserFillTool(bridge)
  const value = await tool.execute({
    fields: [
      { loc: 'css:#email', value: 'a@b.c' },
      { loc: 'css:#nick', value: '林', clear: true },
    ],
    submit: true,
  }, EXEC)
  assert.equal(bridge.calls.length, 1)
  const call = bridge.calls[0]
  assert.equal(call.type, 'fill')
  assert.equal(call.timeoutMs, 60_000)
  assert.equal(call.params.fields.length, 2)
  assert.equal(call.params.fields[0].loc, 'css:#email')
  assert.equal(call.params.fields[0].value, 'a@b.c')
  assert.equal(call.params.fields[0].clear, true)
  assert.equal(call.params.submit, true)
  assert.equal(typeof call.params.source, 'string')
  assert.ok(call.params.source.includes('dshAction'), 'the page script travels with the command')
  assert.equal(value.effect, 'committed')
  assert.equal(value.filled.length, 2)
  assert.equal(value.filled[0].value, 'a@b.c')
  assert.equal(value.filled[0].name, '邮箱')
  assert.equal(value.submitted, true)
  assert.equal(value.navigated, false)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /Filled 2 field\(s\):/)
  assert.match(text, /\* textbox "邮箱" = "a@b\.c"/)
  assert.match(text, /Submitted \(the address did not change\)\./)
})

test('a submit address is forwarded and navigated is passed through', async () => {
  const bridge = fakeBridge(pageAnswer({ navigated: true }))
  const tool = browserFillTool(bridge)
  const value = await tool.execute({
    fields: [{ ref: 'e3', value: 'x' }],
    submit: { loc: 'css:#save' },
  }, EXEC)
  const params = bridge.calls[0].params
  assert.equal(params.fields[0].ref, 'e3')
  assert.deepEqual(params.submit, { loc: 'css:#save' })
  assert.equal(value.navigated, true)
  assert.match(tool.output.render({}, value)[0].text, /the page navigated/)
})

test('the page-side refusal keeps its code and says how much was written', async () => {
  const bridge = fakeBridge({ ok: false, error: 'not_editable', index: 1, filled: [{ index: 0 }] })
  const tool = browserFillTool(bridge)
  await assert.rejects(
    () => tool.execute({ fields: [{ loc: 'css:#email', value: 'a' }, { loc: 'css:#plain', value: 'b' }] }, EXEC),
    (error) => {
      assert.match(error.message, /The first 1 field\(s\) were already filled; field 2 is not a text field/)
      assert.equal(error.code, 'not_editable')
      return true
    },
  )
})

test('a stale loc reports that nothing was filled', async () => {
  const bridge = fakeBridge({ ok: false, error: 'stale_loc', index: 0, loc: 'css:#gone', filled: [] })
  const tool = browserFillTool(bridge)
  await assert.rejects(
    () => tool.execute({ fields: [{ loc: 'css:#gone', value: 'a' }] }, EXEC),
    (error) => {
      assert.match(error.message, /Nothing was filled/)
      assert.match(error.message, /css:#gone/)
      assert.equal(error.code, 'stale_loc')
      return true
    },
  )
})

test('malformed batches fail before the bridge is asked', async () => {
  const bridge = fakeBridge(pageAnswer())
  const tool = browserFillTool(bridge)
  await assert.rejects(() => tool.execute({ fields: [] }, EXEC), /at least one field/)
  await assert.rejects(
    () => tool.execute({ fields: Array.from({ length: 51 }, (_, index) => ({ loc: `css:#f${index}`, value: 'x' })) }, EXEC),
    /at most 50 fields/,
  )
  await assert.rejects(() => tool.execute({ fields: [{ value: 'x' }] }, EXEC), /exactly one of loc, ref or selector/)
  await assert.rejects(
    () => tool.execute({ fields: [{ loc: 'css:#a', ref: 'e1', value: 'x' }] }, EXEC),
    /exactly one of loc, ref or selector/,
  )
  await assert.rejects(() => tool.execute({ fields: [{ loc: '#a', value: 'x' }] }, EXEC), /must be a css: locator/)
  await assert.rejects(() => tool.execute({ fields: [{ loc: 'css:#a', value: 7 }] }, EXEC), /value must be a string/)
  await assert.rejects(() => tool.execute({ fields: [{ loc: 'css:#a', value: 'x' }], submit: 'yes' }, EXEC), /submit must be a boolean/)
  await assert.rejects(
    () => tool.execute({ fields: [{ loc: 'css:#a', value: 'x' }], submit: { loc: 'css:#s', ref: 'e1' } }, EXEC),
    /exactly one of loc, ref or selector/,
  )
  assert.equal(bridge.calls.length, 0)
})

test('the tool is a serial write that reports its batch size', () => {
  const tool = browserFillTool(fakeBridge(pageAnswer()))
  assert.equal(tool.name, 'browser_fill')
  assert.equal(tool.isConcurrencySafe(), false)
  assert.equal(tool.parameters.properties.fields.type, 'array')
  assert.equal(tool.parameters.properties.fields.items.type, 'object')
  assert.deepEqual(tool.parameters.properties.submit.oneOf.map((branch) => branch.type), ['boolean', 'object'])
  assert.deepEqual(tool.parameters.required, ['fields'])
  const call = tool.presentCall({ fields: [{ loc: 'css:#a', value: 'x' }, { loc: 'css:#b', value: 'y' }] })
  assert.equal(call.title, 'Fill 2 field(s)')
  assert.equal(call.kind, 'edit')
  assert.equal(tool.presentResult().title, 'Filled')
})
