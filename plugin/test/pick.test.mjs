/**
 * Tests for `browser_pick` (TICKET-053).
 *
 * Run with: node --test plugin/test/pick.test.mjs
 *
 * The page half is a tiny state machine (`inject/pick.js`: start → poll → stop)
 * exercised here against a stub document; the tool half validates the timeout,
 * forwards one `pick` request and renders the answer. There is no live
 * acceptance in the unit tests because picking needs a human click — that is
 * `docs/cases/027`.
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserPickTool, createTools, pickSource } from '../tools.js'

const SOURCE = readFileSync(new URL('../inject/pick.js', import.meta.url), 'utf8')
const dshPick = new Function(SOURCE + '\nreturn dshPick')()

const EXEC = { agent: { id: 's1' } }

// --- page-side harness -------------------------------------------------------

function element(tag, init = {}) {
  const attrs = new Map(Object.entries(init.attrs ?? {}))
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    children: init.children ?? [],
    parentElement: init.parentElement ?? null,
    innerText: init.text ?? '',
    textContent: init.text ?? '',
    labels: init.labels ?? [],
    style: {},
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null
    },
    setAttribute(name, value) {
      attrs.set(name, String(value))
    },
    getClientRects() {
      return [{ width: 10, height: 10 }]
    },
    getBoundingClientRect() {
      return init.rect ?? { left: 12, top: 34, width: 24, height: 16 }
    },
  }
}

/** A minimal page: one document, one body, a hit test and a selector lookup. */
function withPage(run) {
  const docListeners = []
  const winListeners = []
  const page = { hit: null, lookup: () => null, overlay: null, url: 'https://example.com/form' }
  const body = {
    style: {},
    children: [],
    appendChild(node) {
      node.parentNode = this
      this.children.push(node)
      page.overlay = node
    },
    removeChild(node) {
      this.children = this.children.filter((child) => child !== node)
      node.parentNode = null
      if (page.overlay === node) page.overlay = null
    },
  }
  const doc = {
    body,
    createElement(tag) {
      return {
        nodeType: 1,
        tagName: String(tag).toUpperCase(),
        style: { cssText: '' },
        attrs: {},
        parentNode: null,
        setAttribute(name, value) {
          this.attrs[name] = String(value)
        },
      }
    },
    addEventListener(type, fn, capture) {
      docListeners.push({ type, fn, capture })
    },
    removeEventListener(type, fn, capture) {
      const index = docListeners.findIndex((entry) => entry.type === type && entry.fn === fn && entry.capture === capture)
      if (index !== -1) docListeners.splice(index, 1)
    },
    elementFromPoint() {
      return page.hit
    },
    querySelector(selector) {
      return page.lookup(selector)
    },
  }
  const win = {
    location: { href: page.url },
    getComputedStyle() {
      return { display: 'block', visibility: 'visible' }
    },
    addEventListener(type, fn, capture) {
      winListeners.push({ type, fn, capture })
    },
    removeEventListener(type, fn, capture) {
      const index = winListeners.findIndex((entry) => entry.type === type && entry.fn === fn && entry.capture === capture)
      if (index !== -1) winListeners.splice(index, 1)
    },
  }
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = win
  globalThis.document = doc
  // Capture order is window → document, and `stopImmediatePropagation` in the
  // window phase means the document phase never runs.
  const fire = (type, event) => {
    for (const entry of [...winListeners]) {
      if (entry.type === type) entry.fn(event)
      if (event.stopped === true) return
    }
    for (const entry of [...docListeners]) {
      if (entry.type === type) entry.fn(event)
      if (event.stopped === true) return
    }
  }
  const event = (init = {}) => ({
    type: init.type ?? '',
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    button: init.button ?? 0,
    target: init.target ?? null,
    key: init.key ?? '',
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopImmediatePropagation() {
      this.stopped = true
    },
  })
  try {
    return run({ page, doc, win, body, fire, event })
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
}

// --- page side ---------------------------------------------------------------

test('start installs a highlight overlay and a crosshair cursor; poll is empty', () => {
  withPage(({ page, body }) => {
    const started = dshPick({ action: 'start' })
    assert.equal(started.ok, true)
    assert.equal(started.installed, true)
    assert.equal(body.children.length, 1, 'one overlay was appended')
    assert.ok(page.overlay?.style.cssText.includes('pointer-events:none'))
    assert.equal(body.style.cursor, 'crosshair')
    const poll = dshPick({ action: 'poll' })
    assert.equal(poll.ok, true)
    assert.equal(poll.picked, null)
    assert.equal(poll.cancelled, false)
    assert.equal(poll.hover, null)
    dshPick({ action: 'stop' })
  })
})

test('a move highlights the element under the pointer and records the hover point', () => {
  withPage(({ page, fire, event }) => {
    const button = element('button', { attrs: { id: 'icon-btn' }, text: '设置' })
    dshPick({ action: 'start' })
    page.hit = button
    fire('pointermove', event({ clientX: 50, clientY: 60 }))
    assert.equal(page.overlay.style.display, 'block')
    assert.equal(page.overlay.style.left, '12px')
    assert.equal(page.overlay.style.top, '34px')
    assert.equal(page.overlay.style.width, '24px')
    const poll = dshPick({ action: 'poll' })
    assert.deepEqual(poll.hover, { x: 50, y: 60 })
    dshPick({ action: 'stop' })
  })
})

test('a click is consumed and poll returns the loc, info, rect and point', () => {
  withPage(({ page, body, fire, event, doc }) => {
    const button = element('button', { attrs: { id: 'icon-btn', 'aria-label': '设置' } })
    dshPick({ action: 'start' })
    page.hit = button
    doc.querySelector = (selector) => (selector === '#icon-btn' ? button : null)
    fire('pointermove', event({ clientX: 50, clientY: 60 }))
    const down = event({ clientX: 50, clientY: 60, target: button })
    fire('pointerdown', down)
    assert.equal(down.defaultPrevented, true, 'the page must not see the pick click')
    assert.equal(down.stopped, true)
    const poll = dshPick({ action: 'poll' })
    assert.equal(poll.picked.loc, 'css:#icon-btn')
    assert.deepEqual(poll.picked.info, { tag: 'button', role: 'button', name: '设置' })
    assert.deepEqual(poll.picked.rect, { x: 12, y: 34, width: 24, height: 16 })
    assert.deepEqual(poll.picked.point, { x: 50, y: 60 })
    assert.equal(poll.picked.url, 'https://example.com/form')
    assert.equal(body.children.length, 0, 'the overlay is removed as soon as something is picked')
    assert.equal(body.style.cursor, '', 'the cursor is restored')
    const second = dshPick({ action: 'poll' })
    assert.equal(second.picked.loc, 'css:#icon-btn', 'the answer survives one more poll')
    dshPick({ action: 'stop' })
  })
})

test('the click that follows the pointerdown never reaches the page', () => {
  withPage(({ page, fire, event, doc }) => {
    const seen = []
    doc.addEventListener('click', () => seen.push('page'), true)
    const button = element('button', { attrs: { id: 'icon-btn' } })
    page.lookup = (selector) => (selector === '#icon-btn' ? button : null)
    dshPick({ action: 'start' })
    page.hit = button
    fire('pointerdown', event({ clientX: 5, clientY: 6, target: button }))
    // The browser dispatches the click right after the pointerup, already after
    // our listeners were cleaned up: the pick must still swallow it.
    fire('pointerup', event({ clientX: 5, clientY: 6, target: button }))
    fire('click', event({ clientX: 5, clientY: 6, target: button }))
    assert.deepEqual(seen, [], 'the page must not treat the pick as a click')
    assert.equal(dshPick({ action: 'poll' }).picked.loc, 'css:#icon-btn')
    dshPick({ action: 'stop' })
  })
})

test('a synthetic click without pointerdown is picked and still swallowed', () => {
  withPage(({ page, fire, event, doc }) => {
    const seen = []
    doc.addEventListener('click', () => seen.push('page'), true)
    const button = element('button', { attrs: { id: 'icon-btn' } })
    page.lookup = (selector) => (selector === '#icon-btn' ? button : null)
    dshPick({ action: 'start' })
    page.hit = button
    const click = event({ clientX: 5, clientY: 6, target: button })
    fire('click', click)
    assert.equal(click.stopped, true)
    assert.deepEqual(seen, [])
    assert.equal(dshPick({ action: 'poll' }).picked.loc, 'css:#icon-btn')
    dshPick({ action: 'stop' })
  })
})

test('Escape cancels the pick and cleans up', () => {
  withPage(({ page, body, fire, event }) => {
    dshPick({ action: 'start' })
    fire('keydown', event({ key: 'Escape' }))
    const poll = dshPick({ action: 'poll' })
    assert.equal(poll.picked, null)
    assert.equal(poll.cancelled, true)
    assert.equal(body.children.length, 0)
    assert.equal(page.overlay, null)
    dshPick({ action: 'stop' })
  })
})

test('stop is idempotent and removes the page state', () => {
  withPage(({ win }) => {
    dshPick({ action: 'start' })
    assert.equal(typeof win.__dshPick, 'object')
    dshPick({ action: 'stop' })
    assert.equal(win.__dshPick, undefined)
    const gone = dshPick({ action: 'poll' })
    assert.equal(gone.picked, null)
    assert.equal(gone.gone, true)
    assert.equal(dshPick({ action: 'stop' }).ok, true)
  })
})

test('a second start is a no-op while a pick is already running', () => {
  withPage(() => {
    dshPick({ action: 'start' })
    const again = dshPick({ action: 'start' })
    assert.equal(again.installed, true)
    assert.equal(again.already, true)
    dshPick({ action: 'stop' })
  })
})

// --- tool --------------------------------------------------------------------

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

function pickedAnswer(extra = {}) {
  return {
    ok: true,
    picked: true,
    loc: 'css:#icon-btn',
    info: { tag: 'button', role: 'button', name: '设置' },
    rect: { x: 12, y: 34, width: 24, height: 16 },
    point: { x: 50, y: 60 },
    waitedMs: 1234,
    url: 'https://example.com/form',
    ...extra,
  }
}

test('a picked element maps to a value and a usable loc sentence', async () => {
  const bridge = fakeBridge(pickedAnswer())
  const tool = browserPickTool(bridge)
  const value = await tool.execute({ timeoutMs: 5000 }, EXEC)
  assert.equal(bridge.calls.length, 1)
  const call = bridge.calls[0]
  assert.equal(call.type, 'pick')
  assert.equal(call.params.timeoutMs, 5000)
  assert.equal(call.timeoutMs, 13_000, 'the request budget leaves room for the person')
  assert.ok(call.params.source.includes('dshPick'), 'the page script travels with the command')
  assert.equal(value.picked, true)
  assert.equal(value.loc, 'css:#icon-btn')
  assert.deepEqual(value.info, { tag: 'button', role: 'button', name: '设置' })
  assert.deepEqual(value.rect, { x: 12, y: 34, width: 24, height: 16 })
  assert.deepEqual(value.point, { x: 50, y: 60 })
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /The person picked button "设置"/)
  assert.match(text, /browser_click \{ loc: "css:#icon-btn" \}/)
  assert.match(text, /Picking itself did not click the page/)
})

test('timeoutMs defaults to 60000 and is clamped into 3000..120000', async () => {
  const bridge = fakeBridge(pickedAnswer())
  const tool = browserPickTool(bridge)
  await tool.execute({}, EXEC)
  assert.equal(bridge.calls[0].params.timeoutMs, 60_000)
  await tool.execute({ timeoutMs: 1 }, EXEC)
  assert.equal(bridge.calls[1].params.timeoutMs, 3_000)
  await tool.execute({ timeoutMs: 999_999 }, EXEC)
  assert.equal(bridge.calls[2].params.timeoutMs, 120_000)
})

test('a bad timeout is refused before the page is asked', async () => {
  const bridge = fakeBridge(pickedAnswer())
  const tool = browserPickTool(bridge)
  await assert.rejects(() => tool.execute({ timeoutMs: 1.5 }, EXEC), /timeoutMs must be an integer/)
  await assert.rejects(() => tool.execute({ timeoutMs: 'soon' }, EXEC), /timeoutMs must be an integer/)
  assert.equal(bridge.calls.length, 0)
})

test('a timeout is a normal answer, not an error', async () => {
  const bridge = fakeBridge({ ok: true, picked: false, timedOut: true, waitedMs: 60_000, url: 'https://example.com/form' })
  const tool = browserPickTool(bridge)
  const value = await tool.execute({}, EXEC)
  assert.equal(value.picked, false)
  assert.equal(value.timedOut, true)
  assert.equal(value.cancelled, undefined)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /did not click an element within the time budget/)
  assert.match(text, /page was not touched/)
})

test('a cancel is a normal answer too', async () => {
  const bridge = fakeBridge({ ok: true, picked: false, cancelled: true, waitedMs: 900 })
  const value = await browserPickTool(bridge).execute({}, EXEC)
  assert.equal(value.picked, false)
  assert.equal(value.cancelled, true)
  const text = browserPickTool(bridge).output.render({}, value)[0].text
  assert.match(text, /Picking was cancelled/)
})

test('a pick without a stable loc still returns the point to act on', async () => {
  const bridge = fakeBridge(pickedAnswer({ loc: '', point: { x: 320, y: 240 } }))
  const tool = browserPickTool(bridge)
  const value = await tool.execute({}, EXEC)
  assert.equal(value.loc, undefined, 'an empty loc is not reported as a usable address')
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /point: \(320, 240\)/)
  assert.match(text, /No stable path was found/)
})

test('the pick tool is registered with the other fifteen tools (sixteen now)', () => {
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
  assert.ok(names.includes('browser_pick'))
  assert.equal(names.length, 16)
})

void pickSource
