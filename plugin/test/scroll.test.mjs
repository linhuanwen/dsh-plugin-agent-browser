/**
 * Tests for addressed scrolling (TICKET-048): `browser_scroll` can bring one
 * element into view by ref / loc / selector instead of moving the page by a
 * fixed amount.
 *
 * Run with: node --test plugin/test/scroll.test.mjs
 *
 * Two layers are covered:
 * - the page-side probe (`inject/actions.js` `op === 'scroll'` with an address):
 *   scrollIntoView is called once, the rect and visibility are reported as seen;
 * - the tool surface: address passes through, the dy/to/container options are
 *   rejected when combined with an address, and the result is mapped for the
 *   model.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTools } from '../tools.js'

const EXEC = { agent: { id: 's1' } }

function fakeBridge(answers = {}) {
  const calls = []
  return {
    calls,
    async request(sessionId, type, params) {
      calls.push({ sessionId, type, params })
      if (Object.hasOwn(answers, type)) return answers[type]
      return { ok: true, x: 0, y: 0, scrollHeight: 1, viewportHeight: 1, atBottom: false }
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

test('scroll by dy keeps the old behaviour and maps the position', async () => {
  const bridge = fakeBridge({
    scroll: { ok: true, x: 0, y: 1800, before: 1200, scrollHeight: 4000, viewportHeight: 700, atBottom: false },
  })
  const value = await toolNamed(built(bridge), 'browser_scroll').execute({ dy: 600 }, EXEC)
  assert.equal(value.mode, 'by-dy')
  assert.equal(value.y, 1800)
  assert.equal(value.atBottom, false)
  assert.equal(bridge.calls[0].type, 'scroll')
  assert.equal(bridge.calls[0].params.dy, 600)
  assert.equal(typeof bridge.calls[0].params.source, 'string')
  assert.notEqual(bridge.calls[0].params.source, '')
})

test('scroll to an element by loc sends the address and maps rect/visibility', async () => {
  const bridge = fakeBridge({
    scroll: {
      ok: true,
      matched: true,
      mode: 'into-view',
      x: 0,
      y: 2400,
      scrollHeight: 6000,
      viewportHeight: 700,
      atBottom: false,
      rect: { x: 20, y: 310, width: 180, height: 44 },
      visible: true,
      fullyVisible: true,
      info: { tag: 'button', role: 'button', name: '保存' },
      frame: '',
    },
  })
  const tool = toolNamed(built(bridge), 'browser_scroll')
  const value = await tool.execute({ loc: 'css:#save' }, EXEC)
  assert.equal(value.mode, 'into-view')
  assert.equal(value.matched, true)
  assert.deepEqual(value.rect, { x: 20, y: 310, width: 180, height: 44 })
  assert.equal(value.visible, true)
  assert.equal(value.fullyVisible, true)
  assert.equal(value.info.name, '保存')
  assert.equal(bridge.calls[0].params.loc, 'css:#save')
  assert.equal(bridge.calls[0].params.dy, undefined)
  const rendered = tool.output.render({ loc: 'css:#save' }, value)
  assert.match(rendered[0].text, /into view/)
  assert.match(rendered[0].text, /fully in view/)
})

test('addressing an element and moving the page are mutually exclusive', async () => {
  const bridge = fakeBridge()
  const tool = toolNamed(built(bridge), 'browser_scroll')
  await assert.rejects(
    tool.execute({ loc: 'css:#a', dy: 100 }, EXEC),
    /do not combine/,
  )
  await assert.rejects(
    tool.execute({ selector: '#a', to: 'bottom' }, EXEC),
    /do not combine/,
  )
  await assert.rejects(
    tool.execute({ ref: 'e1', selector: '#a' }, EXEC),
    /exactly one of ref, loc or selector/,
  )
  assert.equal(bridge.calls.length, 0)
})

test('an addressed scroll failure keeps the panel error', async () => {
  const bridge = fakeBridge({ scroll: { ok: false, error: 'stale_loc', loc: 'css:#gone' } })
  await assert.rejects(
    toolNamed(built(bridge), 'browser_scroll').execute({ loc: 'css:#gone' }, EXEC),
    (error) => {
      assert.match(error.message, /no longer matches/)
      return true
    },
  )
})

/* ------------------------- page-side probe ------------------------- */

const SOURCE = readFileSync(new URL('../inject/actions.js', import.meta.url), 'utf8')
const dshAction = new Function(`return (${SOURCE}\n)`)()

function element(init = {}) {
  const attrs = { ...(init.attrs ?? {}) }
  const rect = init.rect ?? { left: 0, top: 0, width: 100, height: 40 }
  return {
    tagName: init.tagName ?? 'BUTTON',
    type: init.type,
    id: attrs.id ?? '',
    className: '',
    value: '',
    innerText: init.text ?? '',
    disabled: false,
    parentElement: null,
    style: {},
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => { attrs[name] = String(value) },
    attributes: attrs,
    getBoundingClientRect: () => rect,
    scrollIntoView: init.scrollIntoView ?? (() => {}),
    closest: () => null,
  }
}

function dom(init = {}) {
  const box = init.box ?? { scrollTop: 0, scrollLeft: 0, scrollHeight: 1000, clientHeight: 700, clientWidth: 1000 }
  const listeners = new Map()
  const doc = {
    addEventListener: (type, handler) => {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    querySelector: init.find ?? (() => null),
    // `pickSelector` walks `querySelectorAll`; `resolveLoc` walks `querySelector`.
    querySelectorAll: () => {
      if (init.allThrows === true) throw new Error('not a valid selector')
      return init.all ?? []
    },
    elementFromPoint: () => null,
    scrollingElement: box,
    documentElement: box,
    activeElement: null,
    execCommand: () => false,
  }
  const win = {
    innerWidth: 1000,
    innerHeight: 700,
    getComputedStyle: (node) => node.style ?? {},
    open: () => null,
    location: { assign: () => {} },
    requestAnimationFrame: (fn) => { fn(); return 1 },
  }
  return { doc, win }
}

async function run(op, params, stub) {
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  const previousLocation = globalThis.location
  globalThis.document = stub.doc
  globalThis.window = stub.win
  globalThis.location = { href: 'https://example.com/scroll' }
  try {
    let raw = dshAction(op, params)
    if (raw !== null && typeof raw.then === 'function') raw = await raw
    return JSON.parse(raw)
  } finally {
    globalThis.document = previousDocument
    globalThis.window = previousWindow
    globalThis.location = previousLocation
  }
}

test('page scroll: an addressed element is scrolled into view exactly once', async () => {
  const box = { scrollTop: 1200, scrollLeft: 0, scrollHeight: 5000, clientHeight: 700, clientWidth: 1000 }
  const target = element({ text: '保存', rect: { left: 20, top: 120, width: 180, height: 44 } })
  let scrolls = 0
  target.scrollIntoView = () => { scrolls += 1 }
  const stub = dom({ box, find: (selector) => (selector === '#save' ? target : null), all: [target] })
  const result = await run('scroll', { selector: '#save' }, stub)
  assert.equal(result.ok, true)
  assert.equal(result.matched, true)
  assert.equal(result.mode, 'into-view')
  assert.equal(scrolls, 1)
  assert.deepEqual(result.rect, { x: 20, y: 120, width: 180, height: 44 })
  assert.equal(result.visible, true)
  assert.equal(result.fullyVisible, true)
  assert.equal(result.y, 1200)
})

test('page scroll: a target that only partly fits reports visible but not fullyVisible', async () => {
  const target = element({ text: '顶部被遮住', rect: { left: 10, top: -30, width: 200, height: 44 } })
  const stub = dom({ find: (selector) => (selector === '#half' ? target : null), all: [target] })
  const result = await run('scroll', { selector: '#half' }, stub)
  assert.equal(result.ok, true)
  assert.equal(result.visible, true)
  assert.equal(result.fullyVisible, false)
})

test('page scroll: a stale loc never moves the page', async () => {
  const box = { scrollTop: 900, scrollLeft: 0, scrollHeight: 5000, clientHeight: 700, clientWidth: 1000 }
  const stub = dom({ box, find: () => null })
  const result = await run('scroll', { loc: 'css:#gone' }, stub)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'stale_loc')
  assert.equal(result.loc, 'css:#gone')
  assert.equal(box.scrollTop, 900)
})

test('page scroll: a loc that is not css: is bad_loc', async () => {
  const stub = dom({ find: () => null })
  const result = await run('scroll', { loc: 'role:button' }, stub)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bad_loc')
})
