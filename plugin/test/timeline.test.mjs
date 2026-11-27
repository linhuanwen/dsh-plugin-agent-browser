/**
 * Tests for the action timeline (TICKET-056).
 *
 * Run with: node --test plugin/test/timeline.test.mjs
 *
 * The recorder is plain host memory, so these tests pin the two halves that can
 * rot silently: the ring/filter behaviour of `createTimeline`, and the fact that
 * `createTools` actually feeds it (an observer wired to nothing looks green
 * everywhere else). The live half — the panel strip and "closed panel" reads —
 * is covered by docs/cases/030.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTimeline, summarizeArgs } from '../timeline.js'
import { createTools, browserTimelineTool } from '../tools.js'
import { AgentBrowserError } from '../errors.js'

function buildTools() {
  const bridge = {
    async request(_sessionId, type) {
      if (type === 'click') throw new AgentBrowserError('bridge_timeout', 'the panel did not answer')
      return { ok: true, zoom: 1 }
    },
    takeDigest() {
      return ''
    },
  }
  const sites = {
    async ensure() {
      return { url: 'http://127.0.0.1:1', root: '.', port: 1, token: 't' }
    },
  }
  return createTools({}, bridge, sites, { activation: 'auto', limits: {}, downloads: {} })
}

const EXEC = { agent: { id: 's1' } }

test('the ring keeps the newest entries, counts sequence, and drops the oldest', () => {
  const timeline = createTimeline({ capacity: 2 })
  timeline.record({ tool: 'browser_open', ok: true, summary: 'url=one' })
  timeline.record({ tool: 'browser_click', ok: true, summary: 'loc=two' })
  timeline.record({ tool: 'browser_type', ok: false, code: 'approval_timeout', summary: 'loc=three' })
  assert.equal(timeline.size, 2)
  const entries = timeline.list()
  assert.deepEqual(entries.map((entry) => entry.tool), ['browser_type', 'browser_click'])
  assert.deepEqual(entries.map((entry) => entry.seq), [3, 2])
  assert.equal(entries[0].code, 'approval_timeout')
})

test('list filters by tool and by failure, newest first, with a clamped limit', () => {
  const timeline = createTimeline({})
  timeline.record({ tool: 'browser_click', ok: true })
  timeline.record({ tool: 'browser_click', ok: false, code: 'stale_loc' })
  timeline.record({ tool: 'browser_snapshot', ok: true })
  assert.equal(timeline.list({ tool: 'browser_click' }).length, 2)
  assert.deepEqual(timeline.list({ failedOnly: true }).map((entry) => entry.code), ['stale_loc'])
  assert.equal(timeline.list({ limit: 1 }).length, 1)
  assert.equal(timeline.list({ limit: 500 }).length, 3)
  timeline.clear()
  assert.equal(timeline.size, 0)
})

test('summarizeArgs keeps names and values, drops the page-side source blob', () => {
  const text = summarizeArgs({
    loc: 'css:#save',
    text: 'hello world',
    source: 'function dshAction() { /* a very long page script */ }',
  })
  assert.match(text, /loc=css:#save/)
  assert.match(text, /text=hello world/)
  assert.doesNotMatch(text, /dshAction/)
  const long = summarizeArgs({ script: 'x'.repeat(400) })
  assert.ok(long.length <= 120, `summary should be clipped, got ${long.length}`)
})

test('the tool maps entries to ISO times and clips the request to the documented range', async () => {
  const timeline = createTimeline({})
  timeline.record({
    tool: 'browser_screenshot',
    ok: true,
    summary: 'includeImage=false',
    file: 'screenshots/shot.png',
    bytes: 4096,
    ms: 12,
  })
  const tool = browserTimelineTool(timeline)
  const value = await tool.execute({ limit: 5 }, EXEC)
  assert.equal(value.total, 1)
  assert.equal(value.entries[0].tool, 'browser_screenshot')
  assert.match(value.entries[0].at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(value.entries[0].file, 'screenshots/shot.png')
  assert.equal(value.entries[0].bytes, 4096)
  assert.equal(value.entries[0].ms, 12)
  for (const bad of [0, 51, 2.5, '3']) {
    await assert.rejects(() => tool.execute({ limit: bad }, EXEC), /limit must be an integer between 1 and 50/)
  }
})

test('render shows failures, codes and evidence paths, and says when the list is empty', async () => {
  const timeline = createTimeline({})
  const empty = browserTimelineTool(timeline)
  assert.match(empty.output.render({}, { total: 0, entries: [] })[0].text, /No browser actions have been recorded yet/)
  timeline.record({ tool: 'browser_click', ok: false, code: 'stale_loc', summary: 'loc=css:#nope', ms: 3 })
  timeline.record({ tool: 'browser_screenshot', ok: true, summary: 'includeImage=false', file: 'a.png', bytes: 10 })
  const value = await browserTimelineTool(timeline).execute({}, EXEC)
  const text = browserTimelineTool(timeline).output.render({}, value)[0].text
  assert.match(text, /2 recent action\(s\)/)
  assert.match(text, /FAILED browser_click \[stale_loc\] 3ms — loc=css:#nope/)
  assert.match(text, /file: a\.png \(10 B\)/)
  assert.doesNotMatch(text, /undefined/)
})

test('page-level refusals keep their stable code in the timeline', async () => {
  const bridge = {
    async request() {
      return { ok: false, error: 'stale_loc' }
    },
    takeDigest() {
      return ''
    },
  }
  const sites = {
    async ensure() {
      return { url: 'http://127.0.0.1:1', root: '.', port: 1, token: 't' }
    },
  }
  const tools = createTools({}, bridge, sites, { activation: 'auto', limits: {}, downloads: {} })
  const click = tools.find((tool) => tool.name === 'browser_click')
  await assert.rejects(() => click.execute({ loc: 'css:#gone' }, EXEC), /no longer matches/)
  const [entry] = tools.timeline.list({ limit: 1 })
  assert.equal(entry.code, 'stale_loc')
  assert.match(entry.summary, /loc=css:#gone/)
})

test('createTools records real calls, including the failure code the model received', async () => {
  const tools = buildTools()
  const zoom = tools.find((tool) => tool.name === 'browser_zoom')
  const click = tools.find((tool) => tool.name === 'browser_click')
  await zoom.execute({ factor: 1 }, EXEC)
  await assert.rejects(() => click.execute({ loc: 'css:#nope' }, EXEC), /bridge_timeout/)
  assert.ok(tools.timeline !== undefined, 'createTools must expose its recorder to apply.js')
  assert.equal(tools.timeline.list({ limit: 10 }).length, 2)
  const rendered = browserTimelineTool(tools.timeline).output.render(
    {},
    await browserTimelineTool(tools.timeline).execute({}, EXEC),
  )[0].text
  assert.match(rendered, /browser_click \[bridge_timeout\]/)
  assert.match(rendered, /browser_zoom/)

  // Looking at the log must not grow it.
  const before = tools.timeline.size
  const lazily = tools.find((tool) => tool.name === 'browser_timeline')
  await lazily.execute({ limit: 5 }, EXEC)
  assert.equal(tools.timeline.size, before)
})
