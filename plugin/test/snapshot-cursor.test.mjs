/**
 * Tests for `browser_snapshot` continuation (`cursor`, TICKET-046).
 *
 * Run with: node --test plugin/test/snapshot-cursor.test.mjs
 *
 * The page-side pagination lives in `inject/snapshot.js` and is exercised live
 * (`docs/cases/020`); here we pin the tool half: the cursor is forwarded, the
 * sliced result is mapped, a stale cursor becomes `stale_cursor`, and the
 * rendered footer tells the model exactly how to continue.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserSnapshotTool } from '../tools.js'

const EXEC = { agent: { id: 's1' } }

function fakeBridge(answer) {
  const calls = []
  return {
    calls,
    request: async (sessionId, type, params) => {
      calls.push({ sessionId, type, params })
      return answer
    },
    takeDigest: () => '',
  }
}

function pageAnswer(extra = {}) {
  return {
    gen: 2,
    url: 'http://127.0.0.1:7789/long',
    title: 'long',
    text: '- page "long"\n  - list\n    - listitem "row 1"',
    refCount: 3,
    nodeCount: 3,
    visited: 40,
    truncated: true,
    more: true,
    totalLines: 90,
    from: 0,
    nextOffset: 3,
    cursor: 'abc.90.3.2048@3',
    ms: 2,
    budget: 1200,
    ...extra,
  }
}

test('a plain snapshot forwards no cursor and maps the pagination fields', async () => {
  const bridge = fakeBridge(pageAnswer())
  const value = await browserSnapshotTool({}, bridge).execute({ maxChars: 1200, includeImage: false }, EXEC)
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.calls[0].type, 'snapshot')
  assert.equal(bridge.calls[0].params.cursor, '')
  assert.equal(bridge.calls[0].params.includeImage, false)
  assert.equal(value.cursor, 'abc.90.3.2048@3')
  assert.equal(value.more, true)
  assert.equal(value.totalLines, 90)
  assert.equal(value.from, 0)
  assert.equal(value.truncated, true)
})

test('a continuation forwards the cursor and skips the screenshot by default', async () => {
  const bridge = fakeBridge(pageAnswer({ from: 3, nextOffset: 6, cursor: 'abc.90.3.2048@6' }))
  const value = await browserSnapshotTool({}, bridge).execute({ cursor: 'abc.90.3.2048@3' }, EXEC)
  assert.equal(bridge.calls[0].params.cursor, 'abc.90.3.2048@3')
  assert.equal(bridge.calls[0].params.includeImage, false, 'a continuation does not spend a screenshot unless asked')
  assert.equal(value.from, 3)
  assert.equal(value.nextOffset, 6)
  assert.equal(value.cursor, 'abc.90.3.2048@6')
})

test('explicit includeImage:true still attaches a screenshot on a continuation', async () => {
  const bridge = fakeBridge(pageAnswer({ from: 3 }))
  await browserSnapshotTool({}, bridge).execute({ cursor: 'abc.90.3.2048@3', includeImage: true }, EXEC)
  assert.equal(bridge.calls[0].params.includeImage, true)
})

test('a stale page turns into the stale_cursor error code', async () => {
  const bridge = fakeBridge({ stale: true, totalLines: 91, url: 'http://127.0.0.1:7789/long', title: 'long' })
  await assert.rejects(
    browserSnapshotTool({}, bridge).execute({ cursor: 'abc.90.3.2048@3' }, EXEC),
    (error) => {
      assert.equal(error.code, 'stale_cursor')
      assert.equal(error.retryable, true)
      assert.match(error.message, /fresh browser_snapshot/)
      return true
    },
  )
})

test('a cursor that this plugin could not have issued is refused before the panel is bothered', async () => {
  const bridge = fakeBridge(pageAnswer())
  await assert.rejects(
    browserSnapshotTool({}, bridge).execute({ cursor: 'x'.repeat(301) }, EXEC),
    /cursor is not a value this plugin issued/,
  )
  assert.equal(bridge.calls.length, 0)
})

test('the rendered footer says how to continue, and only when more remains', async () => {
  const tool = browserSnapshotTool({}, fakeBridge(pageAnswer()))
  const value = await tool.execute({ maxChars: 1200 }, EXEC)
  const blocks = tool.output.render({ maxChars: 1200 }, value)
  const text = blocks.map((block) => block.text ?? '').join('')
  assert.match(text, /tree cut at the character budget \(3\/90 lines delivered\)/)
  assert.match(text, /browser_snapshot\(\{cursor:"abc\.90\.3\.2048@3"\}\)/)

  const done = await tool.execute({ maxChars: 1200 }, EXEC)
  const finished = { ...done, more: false, truncated: false, cursor: '', nextOffset: done.totalLines }
  const textDone = tool.output.render({}, finished).map((block) => block.text ?? '').join('')
  assert.equal(/browser_snapshot\(\{cursor/.test(textDone), false, 'no cursor hint once the tree is complete')
})

test('a continuation header names the line it resumed at', async () => {
  const tool = browserSnapshotTool({}, fakeBridge(pageAnswer({ from: 41, totalLines: 90 })))
  const value = await tool.execute({ cursor: 'abc.90.3.2048@41' }, EXEC)
  const text = tool.output.render({}, value).map((block) => block.text ?? '').join('')
  assert.match(text, /continued at line 42\/90/)
})
