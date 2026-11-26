/**
 * Tests for the failed-request tail on `browser_snapshot` (TICKET-051).
 *
 * Run with: node --test plugin/test/network.test.mjs
 *
 * The page half lives in `inject/guards.js` (guards.test.mjs, 22 tests) and the
 * panel half is exercised live (`docs/cases/025`); here we pin the tool
 * boundary: failures are mapped, the render tail is bounded and says how many
 * requests were seen in total, and a snapshot without failures stays
 * byte-for-byte as before.
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
    url: 'http://127.0.0.1:7789/network',
    title: 'network fixture',
    text: '- page "network fixture"',
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

test('failed requests are mapped onto the snapshot and rendered as a tail', async () => {
  const bridge = fakeBridge(pageAnswer({
    network: [
      { kind: 'fetch', method: 'GET', url: '/api/items?page=2', status: 500, ms: 12 },
      { kind: 'xhr', method: 'POST', url: '/api/save', status: 0, ms: 4, error: 'request failed or aborted' },
    ],
    networkTotal: 5,
  }))
  const tool = browserSnapshotTool({}, bridge)
  const value = await tool.execute({ includeImage: false }, EXEC)
  assert.deepEqual(value.network, [
    { kind: 'fetch', method: 'GET', url: '/api/items?page=2', status: 500, ms: 12 },
    { kind: 'xhr', method: 'POST', url: '/api/save', status: 0, ms: 4, error: 'request failed or aborted' },
  ])
  assert.equal(value.networkTotal, 5)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /page network \(2 failed of 5 request\(s\)\):/)
  assert.match(text, /- \[fetch\] GET \/api\/items\?page=2 → 500, 12ms/)
  assert.match(text, /- \[xhr\] POST \/api\/save → failed, 4ms — request failed or aborted/)
})

test('a snapshot with no failed requests renders exactly as before', async () => {
  const bridge = fakeBridge(pageAnswer())
  const tool = browserSnapshotTool({}, bridge)
  const value = await tool.execute({ includeImage: false }, EXEC)
  assert.equal('network' in value, false)
  assert.equal('networkTotal' in value, false)
  const text = tool.output.render({}, value)[0].text
  assert.doesNotMatch(text, /page network/)
})

test('the render tail is bounded to the last ten failures and says how many it hid', async () => {
  const entries = []
  for (let index = 0; index < 14; index += 1) {
    entries.push({ kind: 'fetch', method: 'GET', url: '/api/' + index, status: 404, ms: 1 })
  }
  const bridge = fakeBridge(pageAnswer({ network: entries, networkTotal: 20 }))
  const tool = browserSnapshotTool({}, bridge)
  const value = await tool.execute({ includeImage: false }, EXEC)
  assert.equal(value.network.length, 14)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /page network \(14 failed of 20 request\(s\)\):/)
  assert.match(text, /- \[fetch\] GET \/api\/4 → 404, 1ms/)
  assert.doesNotMatch(text, /- \[fetch\] GET \/api\/3 → 404, 1ms\n/)
  assert.match(text, /4 earlier failures not shown/)
})

test('malformed network entries are dropped instead of reaching the model', async () => {
  const bridge = fakeBridge(pageAnswer({
    network: [
      null,
      'nope',
      { kind: 'xhr', method: 'POST' },
      { status: 0 },
      { kind: 'fetch', method: 'GET', url: '/ok', status: 404, ms: 3, error: 'boom' },
    ],
  }))
  const tool = browserSnapshotTool({}, bridge)
  const value = await tool.execute({ includeImage: false }, EXEC)
  assert.deepEqual(value.network, [
    { kind: 'xhr', method: 'POST', url: '', status: 0, ms: 0 },
    { kind: 'fetch', method: 'GET', url: '', status: 0, ms: 0 },
    { kind: 'fetch', method: 'GET', url: '/ok', status: 404, ms: 3, error: 'boom' },
  ])
  // No networkTotal on the page answer: the render falls back to the list size.
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /page network \(3 failed of 3 request\(s\)\):/)
})
