/**
 * Tests for the `loc` locators `browser_snapshot` prints next to each ref
 * (TICKET-045).
 *
 * Run with: node --test plugin/test/snapshot-loc.test.mjs
 *
 * `inject/snapshot.js` is shipped to the page as source text, so it only uses
 * `document`, `location` and `performance` from the global scope. A tiny DOM
 * stub is enough to exercise the path builder: the interesting part is the
 * anchor choice (unique `#id`, `[data-testid]`, `tag[name]`, then
 * `tag:nth-of-type(n)` hops) and the verification that the path resolves back to
 * the very same node.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../inject/snapshot.js', import.meta.url), 'utf8')
const dshSnapshot = new Function(`return (${SOURCE}\n)`)()
const ACTION_SOURCE = readFileSync(new URL('../inject/actions.js', import.meta.url), 'utf8')
const dshAction = new Function(`return (${ACTION_SOURCE}\n)`)()

function textNode(value) {
  return { nodeType: 3, nodeValue: value, parentElement: null }
}

function element(tag, attrs = {}, init = {}) {
  const attributes = { ...attrs }
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    type: init.type,
    id: attributes.id ?? '',
    className: '',
    value: '',
    innerText: init.text ?? '',
    textContent: init.text ?? '',
    disabled: false,
    required: false,
    readOnly: false,
    multiple: false,
    selected: false,
    checked: false,
    ownerDocument: null,
    parentElement: null,
    style: {},
    attributes,
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
    hasAttribute: (name) => name in attributes,
    setAttribute: (name, value) => {
      attributes[name] = String(value)
      if (name === 'data-dsh-ref') node.ref = String(value)
    },
    removeAttribute: (name) => {
      delete attributes[name]
      if (name === 'data-dsh-ref') delete node.ref
    },
    getBoundingClientRect: () => ({ left: 1, top: 2, width: 30, height: 40 }),
    scrollIntoView: () => {},
    getElementsByTagName: () => [],
    children: [],
    childNodes: [],
  }
  Object.defineProperty(node, 'children', {
    get: () => node.childNodes.filter((kid) => kid.nodeType === 1),
  })
  return node
}

function append(parent, kid) {
  kid.parentElement = parent
  parent.childNodes.push(kid)
  return kid
}

/** A tiny selector matcher: only the shapes `snapshot.js` itself emits. */
function matchesSegment(node, segment) {
  if (segment.startsWith('#')) return node.id === segment.slice(1)
  const testId = /^\[data-testid="(.+)"\]$/.exec(segment)
  if (testId) return node.getAttribute('data-testid') === testId[1]
  const named = /^([a-z0-9]+)\[name="(.+)"\]$/.exec(segment)
  if (named) return node.tagName.toLowerCase() === named[1] && node.getAttribute('name') === named[2]
  const nth = /^([a-z0-9]+):nth-of-type\((\d+)\)$/.exec(segment)
  if (nth) {
    if (node.tagName.toLowerCase() !== nth[1]) return false
    const siblings = node.parentElement ? node.parentElement.children : [node]
    let seen = 0
    for (const sibling of siblings) {
      if (sibling.tagName !== node.tagName) continue
      seen += 1
      if (sibling === node) return seen === Number(nth[2])
    }
    return false
  }
  return node.tagName.toLowerCase() === segment
}

function chainCandidates(root, segments) {
  let level = [root]
  for (const segment of segments) {
    const next = []
    for (const node of level) {
      for (const kid of node.children) if (matchesSegment(kid, segment)) next.push(kid)
    }
    level = next
  }
  return level
}

function dom() {
  const html = element('html')
  const body = append(html, element('body'))
  const head = append(html, element('head'))

  const plainButton = append(body, element('button', {}, { text: 'Plain' }))
  const app = append(body, element('div', { id: 'app' }))
  const saveButton = append(app, element('button', { id: 'save' }, { text: 'Save' }))
  const email = append(app, element('input', { id: 'email', placeholder: 'Email' }))
  email.type = 'text'

  const all = [html, head, body, plainButton, app, saveButton, email]
  const byRef = (ref) => all.find((node) => node.ref === ref) ?? null
  const doc = {
    documentElement: html,
    body,
    title: 'locator fixture',
    querySelectorAll: (selector) => (selector === '[data-dsh-ref]' ? all.filter((node) => node.ref) : []),
    querySelector: (selector) => {
      const segments = String(selector).split(' > ')
      const first = segments[0]
      let start = null
      if (matchesSegment(html, first)) start = html
      else if (matchesSegment(body, first)) start = body
      if (start === null) {
        // A bare `#id` / `[data-testid]` / `tag[name]` anchor is absolute.
        const absolute = /^(#[^ >]+|\[data-testid="[^"]+"\]|[a-z0-9]+\[name="[^"]+"\])/.exec(selector)
        if (absolute) {
          const hit = all.find((node) => matchesSegment(node, absolute[1]))
          return hit ?? null
        }
        return null
      }
      const rest = segments.slice(1)
      if (rest.length === 0) return start
      const hits = chainCandidates(start, rest)
      return hits[0] ?? null
    },
    getElementsByTagName: () => [],
    getElementById: (id) => all.find((node) => node.id === id) ?? null,
    activeElement: null,
    elementFromPoint: () => null,
    addEventListener: () => {},
  }
  for (const node of all) node.ownerDocument = doc
  doc.defaultView = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static' }) }
  return { doc, saveButton, plainButton, email, byRef }
}

async function snapshot(stub) {
  const previousDocument = globalThis.document
  const previousLocation = globalThis.location
  globalThis.document = stub.doc
  globalThis.location = { href: 'https://example.com/loc' }
  try {
    return JSON.parse(dshSnapshot({ includeImage: false }))
  } finally {
    globalThis.document = previousDocument
    globalThis.location = previousLocation
  }
}

test('a unique id becomes a short anchor locator', async () => {
  const result = await snapshot(dom())
  assert.match(result.text, /button "Save" \[ref=e\d+\] \[loc="css:#save"\]/)
  assert.match(result.text, /textbox "Email" \[ref=e\d+\] \[loc="css:#email"\],?/) // value/placeholder rendering is not asserted here
})

test('with no anchor the locator is a positional nth-of-type path', async () => {
  const result = await snapshot(dom())
  assert.match(result.text, /button "Plain" \[ref=e\d+\] \[loc="css:html > body:nth-of-type\(1\) > button:nth-of-type\(1\)"\]/)
})

test('the locator the snapshot prints is resolvable by the action surface', async () => {
  const stub = dom()
  const result = await snapshot(stub)
  const line = result.text.split('\n').find((row) => row.includes('"Save"'))
  assert.ok(line, 'the save button is in the tree')
  const loc = /loc="([^"]+)"/.exec(line)?.[1]
  assert.ok(loc, 'the save button carries a locator')
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  const previousLocation = globalThis.location
  globalThis.document = stub.doc
  globalThis.location = { href: 'https://example.com/loc' }
  globalThis.window = { innerWidth: 1000, innerHeight: 700, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), open: () => null, location: { assign: () => {} } }
  try {
    const raw = dshAction('inspect', { loc })
    if (raw !== null && typeof raw.then === 'function') await raw
    const parsed = JSON.parse(await raw)
    assert.equal(parsed.ok, true, JSON.stringify(parsed))
    assert.equal(parsed.info.tag, 'button')
  } finally {
    globalThis.document = previousDocument
    globalThis.window = previousWindow
    globalThis.location = previousLocation
  }
})
