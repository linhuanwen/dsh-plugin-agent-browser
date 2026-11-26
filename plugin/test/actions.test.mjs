/**
 * Tests for the page-side action surface: selector clicks, hit testing, and
 * scrolling.
 *
 * Run with: node --test plugin/test/actions.test.mjs
 *
 * `inject/actions.js` is a function declaration that the host ships to the page
 * as source text, so it uses only `document` and `window` from the global
 * scope. That makes it loadable here with a stub of exactly those two objects —
 * no browser, no jsdom, no network.
 *
 * The failure codes matter more than the happy path: `occluded` and `multiple`
 * exist so the model is told "the click would have hit a banner" instead of
 * being told the click worked.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../inject/actions.js', import.meta.url), 'utf8')
const dshAction = new Function(`return (${SOURCE}\n)`)()

/** A stub element with the small surface `actions.js` actually touches. */
function element(init = {}) {
  const attrs = { ...(init.attrs ?? {}) }
  const rect = init.rect ?? { left: 0, top: 0, width: 100, height: 40 }
  return {
    tagName: init.tagName ?? 'DIV',
    type: init.type,
    id: attrs.id ?? '',
    className: init.cls ?? '',
    value: '',
    innerText: init.text ?? '',
    disabled: init.disabled === true,
    parentElement: init.parent ?? null,
    style: init.style ?? {},
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => {
      attrs[name] = String(value)
    },
    attributes: attrs,
    getBoundingClientRect: () => rect,
    scrollIntoView: () => {},
    closest: init.closest ?? (() => null),
  }
}

/**
 * A stub document/window pair.
 *
 * @param {object} init - `{ all, allThrows, point, box, find, location }`.
 */
function dom(init = {}) {
  const box = init.box ?? null
  /** Capture-phase listeners `installGuards` registered (click, submit, …). */
  const listeners = new Map()
  const doc = {
    addEventListener: (type, handler) => {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    querySelector: init.find ?? (() => null),
    querySelectorAll: () => {
      if (init.allThrows === true) throw new Error('not a valid selector')
      return init.all ?? []
    },
    elementFromPoint: (x, y) => (typeof init.pointAt === 'function' ? init.pointAt(x, y) : init.point ?? null),
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
    location: init.location ?? { assign: () => {} },
    requestAnimationFrame: (fn) => { fn(); return 1 },
  }
  return { doc, win, listeners }
}

/** Run one action with the stubs installed, then put the globals back. */
async function run(op, params, stub) {
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  const previousLocation = globalThis.location
  globalThis.document = stub.doc
  globalThis.window = stub.win
  globalThis.location = { href: 'https://example.com/actions' }
  try {
    let raw = dshAction(op, params)
    // A click resolves one frame later, so the page can settle after the
    // scroll it triggered; everything else answers synchronously.
    if (raw !== null && typeof raw.then === 'function') raw = await raw
    return JSON.parse(raw)
  } finally {
    globalThis.document = previousDocument
    globalThis.window = previousWindow
    globalThis.location = previousLocation
  }
}

test('selector click: nothing matches is not_found, not a silent success', async () => {
  const stub = dom({ all: [] })
  const result = await run('click', { selector: '.absent' }, stub)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'not_found')
  assert.equal(result.matched, 0)
  assert.equal(result.selector, '.absent')
})

test('selector click: a broken selector reports bad_selector with the reason', async () => {
  const stub = dom({ allThrows: true })
  const result = await run('click', { selector: '!!' }, stub)
  assert.equal(result.error, 'bad_selector')
  assert.match(result.message, /valid selector/)
})

test('selector click: two visible matches is multiple and lists both', async () => {
  const first = element({ tagName: 'BUTTON', text: '上一页' })
  const second = element({ tagName: 'BUTTON', text: '下一页' })
  const stub = dom({ all: [first, second] })
  const result = await run('click', { selector: 'button' }, stub)
  assert.equal(result.error, 'multiple')
  assert.equal(result.matched, 2)
  assert.deepEqual(result.candidates.map((candidate) => candidate.name), ['上一页', '下一页'])
})

test('selector click: strict false accepts the first of several', async () => {
  const first = element({ tagName: 'BUTTON', text: '上一页', rect: { left: 10, top: 20, width: 100, height: 40 } })
  const second = element({ tagName: 'BUTTON', text: '下一页' })
  const stub = dom({ all: [first, second], point: first })
  const result = await run('click', { selector: 'button', strict: false }, stub)
  assert.equal(result.ok, true)
  assert.deepEqual(result.point, { x: 60, y: 40, width: 100, height: 40 })
})

test('selector click: hidden matches are skipped before the count is taken', async () => {
  const hidden = element({ style: { display: 'none' }, text: 'ghost' })
  const zeroSize = element({ rect: { left: 0, top: 0, width: 0, height: 0 }, text: 'collapsed' })
  const real = element({ tagName: 'BUTTON', rect: { left: 0, top: 0, width: 20, height: 20 }, text: 'real' })
  const stub = dom({ all: [hidden, zeroSize, real], point: real })
  const result = await run('click', { selector: '.card' }, stub)
  assert.equal(result.ok, true)
  assert.equal(result.info.name, 'real')
})

test('selector click: an overlay on top is occluded, and names the overlay', async () => {
  const target = element({ tagName: 'BUTTON', rect: { left: 300, top: 300, width: 120, height: 40 }, text: '下载' })
  const banner = element({ attrs: { role: 'dialog', 'aria-label': '位置授权' }, rect: { left: 0, top: 0, width: 900, height: 400 } })
  const stub = dom({ all: [target], point: banner })
  const result = await run('click', { selector: '.download' }, stub)
  assert.equal(result.error, 'occluded')
  assert.deepEqual(result.behind, { tag: 'div', role: 'dialog', name: '位置授权' })
  assert.equal(result.info.name, '下载')
})

test('selector click: a half-covered control is clicked on its visible side', async () => {
  // The left half is behind a drawer; the centre misses, a sample on the right
  // half must still land on the button (百度地图的 3D 卡片就是这样叠的).
  const target = element({ tagName: 'BUTTON', rect: { left: 100, top: 100, width: 120, height: 40 }, text: '地球' })
  const drawer = element({ attrs: { role: 'dialog', 'aria-label': '全景' } })
  const stub = dom({
    all: [target],
    pointAt: (x) => (x < 160 ? drawer : target),
  })
  const result = await run('click', { selector: '.earth' }, stub)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.point.x >= 160, `expected a point on the visible half, got ${result.point.x}`)
})

test('selector click: fully covered still reports occluded and names the cover', async () => {
  const target = element({ tagName: 'BUTTON', rect: { left: 100, top: 100, width: 120, height: 40 }, text: '地球' })
  const drawer = element({ attrs: { role: 'dialog', 'aria-label': '全景' } })
  const stub = dom({ all: [target], pointAt: () => drawer })
  const result = await run('click', { selector: '.earth' }, stub)
  assert.equal(result.error, 'occluded')
  assert.equal(result.behind.name, '全景')
})

test('selector click: a child at the point still counts as the target', async () => {
  const target = element({ tagName: 'BUTTON', rect: { left: 10, top: 10, width: 100, height: 40 }, text: '好的' })
  const label = element({ tagName: 'SPAN', parent: target, rect: { left: 20, top: 20, width: 40, height: 20 } })
  const stub = dom({ all: [target], point: label })
  const result = await run('click', { selector: 'button' }, stub)
  assert.equal(result.ok, true)
})

test('selector click: disabled controls are refused before anything is clicked', async () => {
  const button = element({ tagName: 'BUTTON', disabled: true, text: '提交' })
  const stub = dom({ all: [button], point: button })
  const result = await run('click', { selector: 'button' }, stub)
  assert.equal(result.error, 'disabled')
  assert.equal(result.info.name, '提交')
})

test('selector click: aria-disabled counts as disabled', async () => {
  const button = element({ tagName: 'BUTTON', attrs: { 'aria-disabled': 'true' }, text: '提交' })
  const stub = dom({ all: [button], point: button })
  assert.equal((await run('click', { selector: 'button' }, stub)).error, 'disabled')
})

test('selector click: a class-styled disabled pager is clicked but flagged', async () => {
  // samr.gov.cn 的分页到底时，layui 只是给 <a> 加了一个 class，没有 disabled 属性：
  // 点击照发，页面不理。工具不能把这种"点了没动静"报成干净的成功。
  const link = element({ tagName: 'A', cls: 'layui-laypage-next layui-disabled', text: '下一页' })
  const stub = dom({ all: [link], point: link })
  const result = await run('click', { selector: 'a' }, stub)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.looksDisabled, /disabled$/)
})

test('target=_blank is rewritten to _self for the click, and reported', async () => {
  const link = element({ tagName: 'A', attrs: { target: '_blank' }, text: '商品详情' })
  const stub = dom({ all: [link], point: link })
  const result = await run('click', { selector: 'a' }, stub)
  assert.equal(result.ok, true)
  assert.equal(result.targetFixed, '_blank')
  assert.equal(link.attributes.target, '_self')
})

test('a form target is rewritten too, so a search button actually submits', async () => {
  // 1688: `<form target="_blank">` submits into a window Chromium drops, and the
  // button looks dead. The click has to rewrite the form, not just the link.
  const form = element({ tagName: 'FORM', attrs: { target: '_blank' } })
  const button = element({ tagName: 'BUTTON', text: '搜索', closest: (name) => (name === 'form' ? form : null) })
  const stub = dom({ all: [button], point: button })
  const result = await run('click', { selector: 'button' }, stub)
  assert.equal(result.ok, true)
  assert.equal(form.attributes.target, '_self')
  assert.match(result.targetFixed, /form/)
  assert.match(result.targetFixed, /_blank/)
})

test('a programmatic form.submit() is rewritten too, and fires no submit event', async () => {
  // 1688 search: the button sits outside the form and calls `form.submit()`,
  // which bypasses the `submit` event entirely. Guarding the method is the only
  // way to catch it, otherwise the search silently goes nowhere.
  const form = element({ tagName: 'FORM', attrs: { target: '_blank' } })
  let submitted = 0
  form.submit = () => { submitted += 1 }
  const button = element({ tagName: 'BUTTON', text: '搜索' })
  const stub = dom({ all: [button], point: button })
  stub.win.HTMLFormElement = { prototype: form }
  await run('click', { selector: 'button' }, stub)
  form.submit()
  assert.equal(submitted, 1)
  assert.equal(form.attributes.target, '_self')
})

test('card: the element own area wins over an inner overlay covering the centre', async () => {
  // 1688 offer cards are one big <a> with a "找相似" overlay in the middle: the
  // centre hits the overlay (whose script calls window.open), the edges hit the
  // card itself. The card's own area must be preferred, or the click goes nowhere.
  const card = element({ tagName: 'A', rect: { left: 0, top: 0, width: 100, height: 40 }, text: '马丁靴', attrs: { target: '_blank' } })
  const overlay = element({ tagName: 'A', parent: card, rect: { left: 20, top: 8, width: 60, height: 24 }, text: '找相似' })
  const stub = dom({
    all: [card],
    pointAt: (x, y) => (x > 20 && x < 80 && y > 8 && y < 32 ? overlay : card),
  })
  const result = await run('click', { selector: 'a' }, stub)
  assert.equal(result.ok, true, JSON.stringify(result))
  const inside = result.point.x <= 20 || result.point.x >= 80 || result.point.y <= 8 || result.point.y >= 32
  assert.ok(inside, `expected a point on the card itself, got ${JSON.stringify(result.point)}`)
})

test('a plain link keeps its target and reports nothing fixed', async () => {  const link = element({ tagName: 'A', attrs: { target: '_self' }, text: '详情' })
  const stub = dom({ all: [link], point: link })
  const result = await run('click', { selector: 'a' }, stub)
  assert.equal(result.targetFixed, null)
})

test('window.open is neutered once per document and reported with the next action', async () => {
  const button = element({ tagName: 'BUTTON', text: '打开' })
  const stub = dom({ all: [button], point: button })
  await run('click', { selector: 'button' }, stub)
  assert.equal(stub.win.__dshGuardRev, 1)
  // `window.open` was replaced with a closure that reads the *global* window,
  // exactly as the page would call it.
  const previousWindow = globalThis.window
  globalThis.window = stub.win
  try {
    assert.equal(stub.win.open('https://example.com/x'), null)
  } finally {
    globalThis.window = previousWindow
  }
  const result = await run('click', { selector: 'button' }, stub)
  assert.deepEqual(result.blockedNewWindow, ['https://example.com/x'])
  // Taken once, so it is not reported twice.
  assert.deepEqual((await run('click', { selector: 'button' }, stub)).blockedNewWindow, [])
})

test('a blocked popup survives a failed click and is reported by the next real one', async () => {
  const button = element({ tagName: 'BUTTON', text: '打开' })
  const banner = element({ attrs: { role: 'dialog', 'aria-label': '浮层' } })
  const stub = dom({ all: [button], point: banner })
  await run('click', { selector: 'button' }, stub)
  const previousWindow = globalThis.window
  globalThis.window = stub.win
  try {
    assert.equal(stub.win.open('https://example.com/y'), null)
  } finally {
    globalThis.window = previousWindow
  }
  // This attempt fails on the overlay, so nothing is clicked and nothing reported.
  const failed = await run('click', { selector: 'button' }, stub)
  assert.equal(failed.error, 'occluded')
  assert.equal(failed.blockedNewWindow, undefined)
  // Now the overlay is gone: the pending warning belongs to this action.
  stub.doc.elementFromPoint = () => button
  const result = await run('click', { selector: 'button' }, stub)
  assert.deepEqual(result.blockedNewWindow, ['https://example.com/y'])
})

test('scroll: default step is 600px and not at the bottom', async () => {
  const box = { scrollTop: 0, scrollLeft: 0, scrollHeight: 4000, clientHeight: 700 }
  const stub = dom({ box })
  const result = await run('scroll', {}, stub)
  assert.equal(result.ok, true)
  assert.equal(result.y, 600)
  assert.equal(result.atBottom, false)
  assert.equal(result.scrollHeight, 4000)
})

test('scroll: to bottom lands on the last pixel and reports atBottom', async () => {
  const box = { scrollTop: 0, scrollLeft: 0, scrollHeight: 4000, clientHeight: 700 }
  const stub = dom({ box })
  const result = await run('scroll', { to: 'bottom' }, stub)
  assert.equal(result.y, 4000)
  assert.equal(result.atBottom, true)
})

test('scroll: to top goes back to zero', async () => {
  const box = { scrollTop: 1800, scrollLeft: 0, scrollHeight: 4000, clientHeight: 700 }
  const stub = dom({ box })
  const result = await run('scroll', { to: 'top' }, stub)
  assert.equal(result.y, 0)
  assert.equal(result.atBottom, false)
})

test('scroll: a container is scrolled instead of the page', async () => {
  const box = { scrollTop: 0, scrollLeft: 0, scrollHeight: 900, clientHeight: 300 }
  const stub = dom({ box, find: (selector) => (selector === '.list' ? box : null) })
  const result = await run('scroll', { container: '.list', dy: 250 }, stub)
  assert.equal(result.y, 250)
  assert.equal(result.viewportHeight, 300)
  assert.equal(result.atBottom, false)
})

test('scroll: a missing container is not_found rather than a page scroll', async () => {
  const box = { scrollTop: 0, scrollLeft: 0, scrollHeight: 900, clientHeight: 300 }
  const stub = dom({ box, find: () => null })
  const result = await run('scroll', { container: '.nope' }, stub)
  assert.equal(result.error, 'not_found')
  assert.equal(result.selector, '.nope')
})

test('hover: resolves the visible element and returns the point under the pointer', async () => {
  const card = element({ tagName: 'BUTTON', text: '地球', rect: { left: 300, top: 400, width: 86, height: 60 } })
  const stub = dom({ all: [card], point: card })
  const result = await run('hover', { selector: '.card.earth' }, stub)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.info.name, '地球')
  assert.equal(result.point.x, 343)
  assert.equal(result.point.y, 430)
  // The page height travels with the answer, so the host can tell "it expanded"
  // from "nothing happened" without a second round trip of its own.
  assert.equal(typeof result.pageHeight, 'number')
})

test('hover: a fully covered control still reports occluded', async () => {
  const card = element({ tagName: 'BUTTON', text: '地球', rect: { left: 100, top: 100, width: 86, height: 60 } })
  const panorama = element({ attrs: { role: 'dialog', 'aria-label': '全景' } })
  const stub = dom({ all: [card], pointAt: () => panorama })
  const result = await run('hover', { selector: '.card.earth' }, stub)
  assert.equal(result.error, 'occluded')
  assert.equal(result.behind.name, '全景')
  assert.equal(result.selector, '.card.earth')
})

test('hover: a disabled control can still be hovered (unlike click)', async () => {
  const button = element({ tagName: 'BUTTON', disabled: true, text: '提交' })
  const stub = dom({ all: [button], point: button })
  const result = await run('hover', { selector: 'button' }, stub)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.info.name, '提交')
})

test('popup guard: an agent-opened window is blocked and recorded', () => {
  const assigned = []
  const stub = dom({ location: { assign: (url) => { assigned.push(url) } }, box: null })
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  globalThis.document = stub.doc
  globalThis.window = stub.win
  try {
    dshAction('scroll', { dy: 10 })
    // installGuards replaced window.open during that call; the page never set a
    // driver flag, so the agent path wins.
    const returned = stub.win.open('https://example.com/offer/1')
    assert.equal(returned, null)
    assert.deepEqual(assigned, [], 'the agent must not follow a popup')
  } finally {
    globalThis.document = previousDocument
    globalThis.window = previousWindow
  }
})

test('popup guard: a human-opened window navigates this view instead of dying', () => {
  const assigned = []
  const stub = dom({ location: { assign: (url) => { assigned.push(url) } }, box: null })
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  globalThis.document = stub.doc
  globalThis.window = stub.win
  try {
    dshAction('scroll', { dy: 10 })
    stub.win.__dshDriver = 'human'
    const returned = stub.win.open('https://example.com/offer/1')
    assert.equal(returned, null)
    assert.deepEqual(assigned, ['https://example.com/offer/1'])
  } finally {
    globalThis.document = previousDocument
    globalThis.window = previousWindow
  }
})

test('popup guard: a human click on target=_blank rewrites it to the same view', async () => {
  const anchor = element({ tagName: 'A', attrs: { target: '_blank', href: 'https://example.com/offer/1' } })
  const inner = element({ tagName: 'IMG', parent: anchor })
  const stub = dom({ box: null })
  await run('scroll', { dy: 10 }, stub)
  const handlers = stub.listeners.get('click') ?? []
  assert.ok(handlers.length >= 1, 'a capture-phase click guard is installed')
  for (const handler of handlers) handler({ target: inner })
  assert.equal(anchor.getAttribute('target'), '_self')
})

// --- stable locators (`loc`) -------------------------------------------------
// A ref only lives for one snapshot; the locator the snapshot prints next to it
// is a CSS path that survives renumbering. These tests pin the resolution rules:
// exactly the path, never a fuzzy fallback, and a distinct code when the page
// re-rendered away from it.

test('loc click: the css path is resolved against the page and clicked', async () => {
  const button = element({ tagName: 'BUTTON', text: '保存', attrs: { id: 'save' } })
  const stub = dom({ find: (selector) => (selector === '#save' ? button : null), point: button })
  const result = await run('click', { loc: 'css:#save' }, stub)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.info.name, '保存')
})

test('loc inspect: describes the element the locator points at', async () => {
  const input = element({ tagName: 'INPUT', attrs: { id: 'email' } })
  input.type = 'email'
  const stub = dom({ find: (selector) => (selector === '#email' ? input : null) })
  const result = await run('inspect', { loc: 'css:#email' }, stub)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.info.tag, 'input')
})

test('loc: a path that no longer matches is stale_loc, never a guess', async () => {
  const stub = dom({ find: () => null })
  const result = await run('click', { loc: 'css:#gone' }, stub)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'stale_loc')
  assert.equal(result.loc, 'css:#gone')
})

test('loc: a frame-prefixed locator needs the frame; a missing one is stale_loc', async () => {
  const stub = dom({ find: () => null })
  const result = await run('click', { loc: 'f1:css:#save' }, stub)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'stale_loc')
  assert.equal(result.frame, '1')
})

test('loc: an unsupported scheme is bad_loc, not a silent miss', async () => {
  const stub = dom({ find: () => null })
  const result = await run('click', { loc: 'xpath://button[1]' }, stub)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bad_loc')
  assert.equal(result.loc, 'xpath://button[1]')
})

test('loc: an explicit bad ref is still refused before anything else', async () => {
  const stub = dom({ find: () => null })
  const result = await run('click', { ref: 'not-a-ref' }, stub)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bad_ref')
})
