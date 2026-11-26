/**
 * Tests for the panel-injected click guards.
 *
 * Run with: node --test plugin/test/guards.test.mjs
 *
 * `inject/guards.js` ships to the guest as source text and touches only
 * `document` and `window`, so a stub of those two objects is enough — no
 * browser, no jsdom. The behaviour under test is exactly the TICKET-032 bug:
 * a document nobody has driven yet must already rewrite `target="_blank"` and
 * turn a human's `window.open` into a same-view navigation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../inject/guards.js', import.meta.url), 'utf8')
const dshGuards = new Function(`return (${SOURCE}\n)`)()

/** A stub element with the surface `guards.js` touches. */
function element(init = {}) {
  const attrs = { ...(init.attrs ?? {}) }
  return {
    tagName: init.tagName ?? 'A',
    parentElement: init.parent ?? null,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    setAttribute: (name, value) => { attrs[name] = String(value) },
    closest: init.closest ?? function closest(selector) {
      if (this.tagName === 'A' && selector.includes('a[')) return this
      return null
    },
    attrs,
  }
}

/** Build the stub document/window pair guards.js expects, plus its listeners. */
function dom(init = {}) {
  const listeners = new Map()
  const assigned = []
  const doc = {
    addEventListener: (type, handler) => {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
  }
  const win = {
    location: init.location ?? { assign: (url) => assigned.push(url) },
    open: init.open ?? (() => 'popup'),
  }
  return { doc, win, listeners, assigned }
}

/** Install the guards with the stubs in place; returns the result object. */
function install(stub, driver, options) {
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  globalThis.document = stub.doc
  globalThis.window = stub.win
  try {
    return dshGuards(driver, options)
  } finally {
    globalThis.document = previousDocument
    globalThis.window = previousWindow
  }
}

/** Fire every listener of one type with a stub event. */
function fire(stub, type, event) {
  for (const handler of stub.listeners.get(type) ?? []) handler(event)
}

/**
 * Run `fn` with the stub globals in place.
 *
 * The guard closures read `window` at call time (that is the point), so a
 * `window.open` call has to happen while the stub is installed.
 */
function withGlobals(stub, fn) {
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  globalThis.document = stub.doc
  globalThis.window = stub.win
  try {
    return fn()
  } finally {
    globalThis.document = previousDocument
    globalThis.window = previousWindow
  }
}

test('install: one set of listeners, revision stamped, driver recorded', () => {
  const stub = dom()
  const result = install(stub, 'human')
  assert.deepEqual(result, { rev: 3, driver: 'human' })
  assert.equal(stub.win.__dshGuardRev, 3)
  assert.equal(stub.win.__dshGuardInstalled, true)
  assert.equal(stub.listeners.get('click').length, 1)
  assert.equal(stub.listeners.get('submit').length, 1)
})

test('install: a second call does not wire another set (no double window.open)', () => {
  const stub = dom()
  install(stub, 'agent')
  const firstOpen = stub.win.open
  install(stub, 'human')
  assert.equal(stub.listeners.get('click').length, 1)
  assert.equal(stub.win.open, firstOpen)
  assert.equal(stub.win.__dshDriver, 'human')
})

test('click: target="_blank" becomes _self before the default action', () => {
  const stub = dom()
  install(stub, 'human')
  const anchor = element({ tagName: 'A', attrs: { href: 'https://detail.1688.com/offer/1.html', target: '_blank' } })
  fire(stub, 'click', { target: anchor })
  assert.equal(anchor.attrs.target, '_self')
})

test('click: a nested node reaches its anchor through closest()', () => {
  const stub = dom()
  install(stub, 'human')
  const anchor = element({ tagName: 'A', attrs: { href: 'https://s.1688.com/x', target: '_blank' } })
  const span = { tagName: 'SPAN', parentElement: anchor, closest: () => anchor }
  fire(stub, 'click', { target: span })
  assert.equal(anchor.attrs.target, '_self')
})

test('click: named targets and forms are rewritten too', () => {
  const stub = dom()
  install(stub, 'human')
  const named = element({ tagName: 'A', attrs: { href: 'https://example.com/', target: 'newtab' } })
  fire(stub, 'click', { target: named })
  assert.equal(named.attrs.target, '_self')
  const form = element({ tagName: 'FORM', attrs: { target: '_blank' } })
  fire(stub, 'submit', { target: form })
  assert.equal(form.attrs.target, '_self')
})

test('agent window.open: refused and recorded, nothing navigates', () => {
  const stub = dom()
  install(stub, 'agent')
  const returned = withGlobals(stub, () => stub.win.open('https://detail.1688.com/offer/2.html'))
  assert.equal(returned, null)
  assert.deepEqual(stub.win.__dshBlocked, ['https://detail.1688.com/offer/2.html'])
  assert.deepEqual(stub.assigned, [])
})

test('human window.open: same-view navigation instead of a popup', () => {
  const stub = dom()
  install(stub, 'human')
  const returned = withGlobals(stub, () => stub.win.open('https://detail.1688.com/offer/3.html'))
  assert.equal(returned, null)
  assert.deepEqual(stub.assigned, ['https://detail.1688.com/offer/3.html'])
  assert.deepEqual(stub.win.__dshBlocked ?? [], [])
})

test('dialogs: alert is recorded and answers undefined (the page keeps running)', () => {
  const stub = dom()
  install(stub, 'agent')
  const returned = withGlobals(stub, () => stub.win.alert('saved'))
  assert.equal(returned, undefined)
  assert.equal(stub.win.__dshDialogs.length, 1)
  assert.equal(stub.win.__dshDialogs[0].kind, 'alert')
  assert.equal(stub.win.__dshDialogs[0].message, 'saved')
})

test('dialogs: confirm answers false and is recorded', () => {
  const stub = dom()
  install(stub, 'agent')
  const returned = withGlobals(stub, () => stub.win.confirm('delete this?'))
  assert.equal(returned, false)
  assert.equal(stub.win.__dshDialogs[0].kind, 'confirm')
  assert.equal(stub.win.__dshDialogs[0].message, 'delete this?')
})

test('dialogs: prompt answers null and is recorded', () => {
  const stub = dom()
  install(stub, 'agent')
  const returned = withGlobals(stub, () => stub.win.prompt('name?', 'default'))
  assert.equal(returned, null)
  assert.equal(stub.win.__dshDialogs[0].kind, 'prompt')
  assert.equal(stub.win.__dshDialogs[0].message, 'name?')
})

test('dialogs: off calls the native functions instead of recording', () => {
  const stub = dom()
  stub.win.alert = (message) => `native:${message}`
  stub.win.confirm = () => true
  stub.win.prompt = (message, defaultValue) => `${message}/${defaultValue}`
  install(stub, 'agent', { dialogs: 'off' })
  const results = withGlobals(stub, () => [
    stub.win.alert('a'),
    stub.win.confirm('b'),
    stub.win.prompt('c', 'd'),
  ])
  assert.deepEqual(results, ['native:a', true, 'c/d'])
  assert.deepEqual(stub.win.__dshDialogs, [])
})

test('dialogs: the record keeps only the last 20 entries and caps the message', () => {
  const stub = dom()
  install(stub, 'agent')
  withGlobals(stub, () => {
    for (let i = 0; i < 25; i += 1) stub.win.alert(`m${i}`)
  })
  assert.equal(stub.win.__dshDialogs.length, 20)
  assert.equal(stub.win.__dshDialogs[0].message, 'm5')
  const long = withGlobals(stub, () => {
    stub.win.alert('x'.repeat(400))
    return stub.win.__dshDialogs[stub.win.__dshDialogs.length - 1].message
  })
  assert.equal(long.length, 300)
})

