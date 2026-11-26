/**
 * Tests for `browser_tabs` and the `newTab` flag of `browser_open` (TICKET-050).
 *
 * Run with: node --test plugin/test/tabs.test.mjs
 *
 * The panel owns the tab bookkeeping: the tools only validate arguments and
 * forward one command per call, so everything here can run without Electron,
 * HTTP or a real webview. The last two tests check the seams that are easy to
 * break silently: the bridge must let a read-only `list` through on a human
 * phase while refusing `switch`/`close`, and the panel's error text must keep
 * its code so the agent sees `tab_not_found` rather than a plain Error.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserOpenTool, browserTabsTool } from '../tools.js'
import { Bridge } from '../bridge.js'
import { ERROR_CODES, fromPanelMessage } from '../errors.js'

const EXEC = { agent: { id: 's1' } }

function fakeBridge(answer) {
  const calls = []
  const bridge = {
    calls,
    hasClient: () => true,
    pageOf: () => ({ url: 'http://127.0.0.1:7789/', title: 't' }),
    approve: async () => ({ decision: 'once' }),
    takeDigest: () => '',
    request: async (sessionId, type, params, timeoutMs, options) => {
      calls.push({ sessionId, type, params, timeoutMs, options })
      return answer
    },
  }
  return bridge
}

const TABS = {
  action: 'list',
  tabs: [
    { id: 't1', title: 'Inbox', url: 'http://127.0.0.1:7789/a', active: false },
    { id: 't2', title: 'Issue 42', url: 'http://127.0.0.1:7789/b', active: true },
  ],
  active: 't2',
}

test('browser_open forwards newTab only when it is asked for', async () => {
  const bridge = fakeBridge({ url: 'https://example.com/', title: 'Example' })
  const tool = browserOpenTool({}, bridge, {}, {})
  await tool.execute({ url: 'https://example.com/' }, EXEC)
  await tool.execute({ url: 'https://example.com/again', newTab: true }, EXEC)
  assert.equal(bridge.calls.length, 2)
  assert.equal(Object.hasOwn(bridge.calls[0].params, 'newTab'), false, 'the default open must not create a tab')
  assert.equal(bridge.calls[1].params.newTab, true)
  assert.equal(bridge.calls[1].params.url, 'https://example.com/again')
})

test('browser_tabs list maps the panel view and renders the active row', async () => {
  const bridge = fakeBridge(TABS)
  const tool = browserTabsTool(bridge)
  const value = await tool.execute({ action: 'list' }, EXEC)
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.calls[0].type, 'tabs')
  assert.equal(bridge.calls[0].params.action, 'list')
  assert.equal(value.action, 'list')
  assert.equal(value.active, 't2')
  assert.equal(value.tabs.length, 2)
  assert.equal(value.tabs[1].active, true)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /2 tab\(s\), active t2\./)
  assert.match(text, /\* t2: Issue 42 — http:\/\/127\.0\.0\.1:7789\/b/)
  assert.match(text, /\n  t1: Inbox — http:\/\/127\.0\.0\.1:7789\/a/)
})

test('switch and close without a tab id fail before anything reaches the panel', async () => {
  const bridge = fakeBridge(TABS)
  const tool = browserTabsTool(bridge)
  for (const action of ['switch', 'close']) {
    await assert.rejects(tool.execute({ action }, EXEC), /needs `tab`/)
  }
  await assert.rejects(tool.execute({ action: 'rename' }, EXEC), /needs `action`/)
  assert.equal(bridge.calls.length, 0, 'a rejected argument must not be sent to the panel')
})

test('browser_tabs switch reports the tab the panel switched to', async () => {
  const switched = { ...TABS, action: 'switch', tab: 't1', url: 'http://127.0.0.1:7789/a', title: 'Inbox' }
  const bridge = fakeBridge(switched)
  const tool = browserTabsTool(bridge)
  const value = await tool.execute({ action: 'switch', tab: 't1' }, EXEC)
  assert.equal(bridge.calls[0].params.tab, 't1')
  assert.equal(value.tab, 't1')
  assert.equal(value.url, 'http://127.0.0.1:7789/a')
  assert.match(tool.output.render({}, value)[0].text, /Switched to t1\./)
})

test('browser_tabs close reports the closed id and the surviving tabs', async () => {
  const closed = { ...TABS, action: 'close', closed: 't2', active: 't1', tabs: [TABS.tabs[0]] }
  const bridge = fakeBridge(closed)
  const tool = browserTabsTool(bridge)
  const value = await tool.execute({ action: 'close', tab: 't2' }, EXEC)
  assert.equal(bridge.calls[0].params.tab, 't2')
  assert.equal(value.closed, 't2')
  assert.equal(value.active, 't1')
  assert.equal(value.tabs.length, 1)
  assert.match(tool.output.render({}, value)[0].text, /Closed t2\./)
})

/** A real bridge, started on an ephemeral port and never spoken to by a panel. */
async function silentBridge() {
  const bridge = new Bridge({ port: 0, logger: () => {}, timeoutMs: 30_000 })
  await bridge.start()
  return bridge
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a human phase lets tabs list through but refuses switch and close', async () => {
  const bridge = await silentBridge()
  try {
    bridge.setPhase('s1', 'needs_human', { signals: [] })
    await assert.rejects(
      bridge.request('s1', 'tabs', { action: 'switch', tab: 't2' }, 1_000),
      /needs_human:/,
      'switching while a verification wall is up would drive the wrong page',
    )
    await assert.rejects(
      bridge.request('s1', 'tabs', { action: 'close', tab: 't1' }, 1_000),
      /needs_human:/,
    )
    const list = bridge.request('s1', 'tabs', { action: 'list' }, 30_000)
    await wait(80)
    await bridge.close()
    await assert.rejects(list, /bridge_closed:/, 'list must be queued for the panel, not refused as an input')
  } finally {
    await bridge.close().catch(() => {})
  }
})

test('a taken-over panel refuses every tab command except list', async () => {
  const bridge = await silentBridge()
  try {
    bridge.setPhase('s1', 'taken_over', {})
    await assert.rejects(
      bridge.request('s1', 'tabs', { action: 'switch', tab: 't1' }, 1_000),
      /panel_taken_over:/,
    )
    await assert.rejects(
      bridge.request('s1', 'tabs', { action: 'close', tab: 't1' }, 1_000),
      /panel_taken_over:/,
    )
    const list = bridge.request('s1', 'tabs', { action: 'list' }, 30_000)
    await wait(80)
    await bridge.close()
    await assert.rejects(list, /bridge_closed:/)
  } finally {
    await bridge.close().catch(() => {})
  }
})

test('tab errors keep their code and retryability', () => {
  assert.equal(Object.keys(ERROR_CODES).length, 21, 'the documented error count moved from 19 to 21')
  const missing = fromPanelMessage('tab_not_found: there is no tab "t9". Nothing was closed.')
  assert.equal(missing.code, 'tab_not_found')
  assert.equal(missing.retryable, true)
  const full = fromPanelMessage('tab_limit: the panel already holds 6 tabs.')
  assert.equal(full.code, 'tab_limit')
  assert.equal(full.retryable, false)
})
