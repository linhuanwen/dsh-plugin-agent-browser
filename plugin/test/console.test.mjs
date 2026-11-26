/**
 * Tests for the page-console tail on `browser_snapshot` (TICKET-049).
 *
 * Run with: node --test plugin/test/console.test.mjs
 *
 * The page half lives in `inject/guards.js` (16 tests) and the panel half is
 * exercised live (`docs/cases/023`); here we pin the tool boundary: entries are
 * mapped, the render tail is bounded, and a snapshot without console output
 * stays byte-for-byte as before.
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
    gen: 3,
    url: 'http://127.0.0.1:7789/console',
    title: 'console fixture',
    text: '- page "console fixture"',
    refCount: 2,
    nodeCount: 1,
    visited: 3,
    truncated: false,
    more: false,
    totalLines: 1,
    from: 0,
    nextOffset: 1,
    cursor: '',
    ms: 1,
    budget: 1200,
    ...extra,
  }
}

test('console entries are mapped onto the snapshot value and rendered as a tail', async () => {
  const bridge = fakeBridge(pageAnswer({
    console: [
      { level: 'log', text: 'hello' },
      { level: 'error', text: 'TypeError: boom' },
    ],
  }))
  const tool = browserSnapshotTool({}, bridge)
  const value = await tool.execute({ includeImage: false }, EXEC)
  assert.deepEqual(value.console, [
    { level: 'log', text: 'hello' },
    { level: 'error', text: 'TypeError: boom' },
  ])
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /page console \(2 entries\):/)
  assert.match(text, /- \[log\] hello/)
  assert.match(text, /- \[error\] TypeError: boom/)
})

test('a snapshot with no console output renders exactly as before', async () => {
  const bridge = fakeBridge(pageAnswer())
  const tool = browserSnapshotTool({}, bridge)
  const value = await tool.execute({ includeImage: false }, EXEC)
  assert.equal('console' in value, false)
  const text = tool.output.render({}, value)[0].text
  assert.doesNotMatch(text, /page console/)
})

test('the render tail is bounded to the last ten entries and says how many it hid', async () => {
  const entries = []
  for (let index = 0; index < 14; index += 1) entries.push({ level: 'log', text: 'line ' + index })
  const bridge = fakeBridge(pageAnswer({ console: entries }))
  const tool = browserSnapshotTool({}, bridge)
  const value = await tool.execute({ includeImage: false }, EXEC)
  assert.equal(value.console.length, 14)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /page console \(14 entries\):/)
  assert.match(text, /- \[log\] line 4/)
  assert.doesNotMatch(text, /- \[log\] line 3\n/)
  assert.match(text, /4 earlier entries not shown/)
})

test('malformed console entries are dropped instead of reaching the model', async () => {
  const bridge = fakeBridge(pageAnswer({
    console: [null, 'nope', { level: 'warn' }, { text: 'loose' }, { level: 'info', text: 'kept' }],
  }))
  const tool = browserSnapshotTool({}, bridge)
  const value = await tool.execute({ includeImage: false }, EXEC)
  assert.deepEqual(value.console, [
    { level: 'warn', text: '' },
    { level: 'log', text: 'loose' },
    { level: 'info', text: 'kept' },
  ])
})
