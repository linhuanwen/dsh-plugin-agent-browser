/**
 * Tests for `browser_wait` (TICKET-044, SPEC-004 stage B1).
 *
 * Run with: node --test plugin/test/wait.test.mjs
 *
 * Two halves, matching the design: the page probe is one synchronous look
 * (`inject/wait.js`, tested here with a stub document like `detect.test.mjs`),
 * and the tool only validates arguments and forwards one `wait` command — the
 * polling loop lives in the panel, so cancellation and the timeout budget are
 * outside the page.
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserWaitTool, createTools, waitSource } from '../tools.js'

const SOURCE = readFileSync(new URL('../inject/wait.js', import.meta.url), 'utf8')
const dshWait = new Function(SOURCE + '\nreturn dshWait')()

/** A rendered element: one client rect and a visible computed style. */
function box(style = {}) {
  return {
    getClientRects() {
      return [{ width: 10, height: 10 }]
    },
    __style: style,
  }
}

/** An element kept in the DOM but not rendered (display:none skeleton). */
function hidden(style = { display: 'none' }) {
  return {
    getClientRects() {
      return []
    },
    __style: style,
  }
}

/** Run the probe against a stub document, restoring the real one afterwards. */
function withPage(page, run) {
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  const selectors = new Map(Object.entries(page.selectors ?? {}))
  globalThis.document = {
    querySelector(selector) {
      if (page.throwsOn !== undefined && selector === page.throwsOn) throw new Error('SyntaxError: invalid selector')
      return selectors.has(selector) ? selectors.get(selector) : null
    },
    get body() {
      return { innerText: page.text ?? '', textContent: page.text ?? '' }
    },
    get defaultView() {
      return globalThis.window
    },
  }
  globalThis.window = {
    getComputedStyle(element) {
      return element.__style ?? { display: 'block', visibility: 'visible' }
    },
  }
  try {
    return run()
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
}

// --- page probe -------------------------------------------------------------

test('a rendered selector is found, visible and matched', () => {
  const answer = withPage({ selectors: { '#done': box() } }, () => dshWait({ selector: '#done' }))
  assert.equal(answer.found, true)
  assert.equal(answer.visible, true)
  assert.equal(answer.matched, true)
  assert.equal(answer.gone, false)
  assert.equal(answer.invalid, undefined)
})

test('a hidden skeleton is found but not a match until it is rendered', () => {
  const answer = withPage({ selectors: { '#late': hidden() } }, () => dshWait({ selector: '#late' }))
  assert.equal(answer.found, true, 'presence is reported so the caller can tell "not there" from "not visible"')
  assert.equal(answer.visible, false)
  assert.equal(answer.matched, false, 'display:none must not count as appeared')
})

test('visibility:hidden and zero-box elements are not a match either', () => {
  const byStyle = withPage({ selectors: { '.ghost': { getClientRects: () => [{}], __style: { display: 'block', visibility: 'hidden' } } } },
    () => dshWait({ selector: '.ghost' }))
  assert.equal(byStyle.matched, false)
  const zeroBox = withPage({ selectors: { '.zero': { getClientRects: () => [{}], __style: { display: 'block', visibility: 'visible' } } } },
    () => dshWait({ selector: '.zero' }))
  assert.equal(zeroBox.matched, true)
})

test('gone inverts the answer: an absent selector is a match', () => {
  const answer = withPage({ selectors: {} }, () => dshWait({ selector: '#spinner', gone: true }))
  assert.equal(answer.found, false)
  assert.equal(answer.matched, true)
  assert.equal(answer.gone, true)
})

test('a rendered selector is not a match when waiting for it to be gone', () => {
  const answer = withPage({ selectors: { '.modal': box() } }, () => dshWait({ selector: '.modal', gone: true }))
  assert.equal(answer.matched, false)
})

test('a hidden selector already counts as gone', () => {
  const answer = withPage({ selectors: { '.modal': hidden() } }, () => dshWait({ selector: '.modal', gone: true }))
  assert.equal(answer.found, true)
  assert.equal(answer.matched, true)
})

test('text is looked up in the page body and honours gone', () => {
  const found = withPage({ text: 'Saved successfully' }, () => dshWait({ text: 'Saved' }))
  assert.equal(found.matched, true)
  assert.equal(found.found, true)
  const gone = withPage({ text: 'Loading…' }, () => dshWait({ text: 'Loading…', gone: true }))
  assert.equal(gone.matched, false, 'the text is still there')
})

test('an invalid selector is reported as not found, not thrown', () => {
  const answer = withPage({ selectors: {}, throwsOn: ':::' }, () => dshWait({ selector: ':::' }))
  assert.equal(answer.found, false)
  assert.equal(answer.matched, false)
})

test('neither selector nor text is an invalid probe', () => {
  const answer = withPage({}, () => dshWait({}))
  assert.equal(answer.invalid, true)
  assert.equal(answer.matched, false)
})

test('the source is a single function expression the panel can call in place', () => {
  // client.js injects it as `(<source>)(input)`; two top-level declarations
  // would be a syntax error in the page (this is exactly what the first 1.5.5
  // build shipped).
  const callable = new Function('return (' + SOURCE + ')')()
  assert.equal(typeof callable, 'function')
  const answer = withPage({ selectors: { '#done': box() } }, () => callable({ selector: '#done' }))
  assert.equal(answer.matched, true)
})

// --- tool -------------------------------------------------------------------

const EXEC = { agent: { id: 's1' } }

function fakeBridge(answer = { ok: true, matched: true, found: true, visible: true, gone: false, waitedMs: 120, ticks: 2, url: 'http://127.0.0.1:7789/' }) {
  const calls = []
  const approvals = []
  const bridge = {
    calls,
    approvals,
    hasClient: () => true,
    pageOf: () => ({ url: 'http://127.0.0.1:7789/', title: 't' }),
    approve: async (_sessionId, request) => {
      approvals.push(request)
      return { decision: 'once' }
    },
    takeDigest: () => '',
    request: async (sessionId, type, params) => {
      calls.push({ sessionId, type, params })
      return answer
    },
  }
  return bridge
}

test('a selector wait forwards one read command with no approval', async () => {
  const bridge = fakeBridge()
  const value = await browserWaitTool(bridge).execute({ selector: '#done', timeoutMs: 5000 }, EXEC)
  assert.equal(bridge.approvals.length, 0, 'a wait is a read: it must never ask for permission')
  assert.equal(bridge.calls.length, 1)
  const call = bridge.calls[0]
  assert.equal(call.type, 'wait')
  assert.equal(call.params.selector, '#done')
  assert.equal(call.params.timeoutMs, 5000)
  assert.equal(call.params.gone, false)
  assert.match(call.params.source, /function dshWait/)
  assert.equal(value.matched, true)
  assert.equal(value.visible, true)
  assert.equal(value.timedOut, false)
})

test('a timeout is a normal answer (matched:false), not an error', async () => {
  const bridge = fakeBridge({ ok: true, matched: false, timedOut: true, found: true, visible: false, gone: false, waitedMs: 10_000, ticks: 67 })
  const value = await browserWaitTool(bridge).execute({ text: 'Saved' }, EXEC)
  assert.equal(value.matched, false)
  assert.equal(value.timedOut, true)
  assert.equal(value.visible, false)
  assert.equal(value.waitedMs, 10_000)
})

test('timeoutMs is clamped into the documented range', async () => {
  const bridge = fakeBridge()
  await browserWaitTool(bridge).execute({ selector: '#a', timeoutMs: 999_999 }, EXEC)
  assert.equal(bridge.calls[0].params.timeoutMs, 15_000)
  await browserWaitTool(bridge).execute({ selector: '#a', timeoutMs: 1 }, EXEC)
  assert.equal(bridge.calls[1].params.timeoutMs, 100)
})

test('the arguments must name exactly one thing to wait for', async () => {
  const tool = browserWaitTool(fakeBridge())
  await assert.rejects(tool.execute({}, EXEC), /needs a selector or text/)
  await assert.rejects(tool.execute({ selector: '#a', text: 'b' }, EXEC), /exactly one of selector or text/)
  await assert.rejects(tool.execute({ selector: '#a', timeoutMs: 1.5 }, EXEC), /timeoutMs must be an integer/)
  await assert.rejects(tool.execute({ selector: '#a', gone: 'yes' }, EXEC), /gone must be a boolean/)
})

test('a page-side invalid probe becomes an actionable error', async () => {
  const bridge = fakeBridge({ ok: true, invalid: true, matched: false, waitedMs: 0 })
  await assert.rejects(browserWaitTool(bridge).execute({ selector: ':::' }, EXEC), /valid selector or text/)
})

test('the wait tool is registered with the other sixteen tools (seventeen now)', () => {
  const bridge = {
    async request() {
      return { ok: true }
    },
    takeDigest: () => '',
  }
  const sites = {
    async ensure() {
      return { url: 'http://127.0.0.1:1', root: '.', port: 1, token: 't' }
    },
  }
  const names = createTools({}, bridge, sites, {}).map((tool) => tool.name)
  assert.ok(names.includes('browser_wait'), 'browser_wait must be registered')
  assert.equal(names.length, 17)
})

void waitSource
