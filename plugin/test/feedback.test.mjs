/**
 * Tests for the in-page feedback painter (TICKET-055).
 *
 * Run with: node --test plugin/test/feedback.test.mjs
 *
 * The painter is a single function expression injected by the panel; here it is
 * called against a stub document with a capture of `setTimeout`, so marks and
 * their automatic removal are asserted without a browser. The panel wiring
 * (which mark follows which command) is exercised in the live acceptance,
 * `docs/cases/029`.
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { feedbackSource } from '../tools.js'

const SOURCE = readFileSync(new URL('../inject/feedback.js', import.meta.url), 'utf8')
const dshFeedback = new Function(SOURCE + '\nreturn dshFeedback')()

/** A throwaway document: one body, generic nodes, and a timer capture. */
function withPage(run) {
  const timers = []
  const makeNode = (tag) => {
    const node = {
      nodeType: 1,
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      style: { cssText: '' },
      childNodes: [],
      parentNode: null,
      appendChild(child) {
        child.parentNode = node
        node.childNodes.push(child)
        return child
      },
      removeChild(child) {
        node.childNodes = node.childNodes.filter((entry) => entry !== child)
        child.parentNode = null
        return child
      },
    }
    return node
  }
  const body = makeNode('body')
  const doc = {
    body,
    documentElement: makeNode('html'),
    createElement: makeNode,
    getElementById(id) {
      return body.childNodes.find((node) => node.id === id) ?? null
    },
  }
  const win = { innerWidth: 1024, innerHeight: 768 }
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  const previousSetTimeout = globalThis.setTimeout
  globalThis.document = doc
  globalThis.window = win
  globalThis.setTimeout = (fn) => {
    timers.push(fn)
    return timers.length
  }
  const layerOf = () => body.childNodes.find((node) => node.id === '__dsh-feedback') ?? null
  /** Marks inside the layer, skipping the injected <style> node. */
  const marksOf = () => {
    const layer = layerOf()
    if (layer === null) return []
    return layer.childNodes.filter((node) => String(node.tagName).toUpperCase() !== 'STYLE')
  }
  try {
    return run({ call: dshFeedback, body, timers, layerOf, marksOf, win })
  } finally {
    globalThis.document = previousDocument
    globalThis.window = previousWindow
    globalThis.setTimeout = previousSetTimeout
  }
}

/** Parse the painter's JSON string answer. */
function answer(raw) {
  assert.equal(typeof raw, 'string', 'the painter answers with a JSON string')
  return JSON.parse(raw)
}

test('a click draws a ripple and a dot at the viewport point', () => {
  withPage(({ call, marksOf }) => {
    const result = answer(call({ kind: 'click', x: 120, y: 80, durationMs: 600 }))
    assert.equal(result.ok, true)
    const marks = marksOf()
    assert.equal(marks.length, 2)
    // The dot is centred on (120, 80) and the ring is centred too.
    for (const mark of marks) {
      assert.match(mark.style.cssText, /position:fixed/)
      assert.match(mark.style.cssText, /left:(111|114)px/)
      assert.match(mark.style.cssText, /top:(71|74)px/)
    }
  })
})

test('a cursor mark is one hollow dot at the point', () => {
  withPage(({ call, marksOf }) => {
    const result = answer(call({ kind: 'cursor', x: 10, y: 20 }))
    assert.equal(result.ok, true)
    const marks = marksOf()
    assert.equal(marks.length, 1)
    assert.match(marks[0].style.cssText, /left:3px/)
    assert.match(marks[0].style.cssText, /top:13px/)
    assert.match(marks[0].style.cssText, /border-radius:50%/)
  })
})

test('a highlight frame uses the page rect it was given', () => {
  withPage(({ call, marksOf }) => {
    const result = answer(call({ kind: 'highlight', rect: { left: 30, top: 40, width: 200, height: 50 } }))
    assert.equal(result.ok, true)
    const marks = marksOf()
    assert.equal(marks.length, 1)
    assert.match(marks[0].style.cssText, /left:30px/)
    assert.match(marks[0].style.cssText, /top:40px/)
    assert.match(marks[0].style.cssText, /width:200px/)
    assert.match(marks[0].style.cssText, /height:50px/)
  })
})

test('a drag draws a line between two dots', () => {
  withPage(({ call, marksOf }) => {
    const result = answer(call({ kind: 'drag', from: { x: 10, y: 10 }, to: { x: 110, y: 10 } }))
    assert.equal(result.ok, true)
    const marks = marksOf()
    assert.equal(marks.length, 3)
    const line = marks.find((mark) => String(mark.className).includes('line'))
    assert.ok(line, 'one mark is the connecting line')
    assert.match(line.style.cssText, /width:100px/)
    assert.match(line.style.cssText, /transform:rotate\(0deg\)/)
  })
})

test('marks disappear on their timer and the layer is removed with the last one', () => {
  withPage(({ call, timers, layerOf, marksOf }) => {
    answer(call({ kind: 'cursor', x: 5, y: 5 }))
    assert.equal(marksOf().length, 1)
    assert.ok(layerOf() !== null)
    // Two timers: one per mark (the click ripple had one too in other tests).
    for (const fn of timers) fn()
    assert.equal(marksOf().length, 0)
    assert.equal(layerOf(), null)
  })
})

test('the message is bounded and malformed input is refused without throwing', () => {
  withPage(({ call, marksOf }) => {
    for (let index = 0; index < 40; index += 1) answer(call({ kind: 'cursor', x: index, y: index }))
    assert.ok(marksOf().length <= 24, `bounded by the mark cap, got ${marksOf().length}`)
    assert.equal(answer(call({ kind: 'click', x: 'nope', y: 1 })).ok, false)
    assert.equal(answer(call({ kind: 'highlight', rect: {} })).ok, false)
    assert.equal(answer(call({ kind: 'drag', from: { x: 0, y: 0 } })).ok, false)
    assert.equal(answer(call({ kind: 'nope' })).ok, false)
    assert.equal(answer(call(null)).ok, false)
  })
})

test('clear removes the layer and the source is served to the panel', () => {
  withPage(({ call, layerOf }) => {
    answer(call({ kind: 'click', x: 1, y: 2 }))
    assert.ok(layerOf() !== null)
    assert.equal(answer(call({ kind: 'clear' })).cleared, true)
    assert.equal(layerOf(), null)
  })
  assert.match(feedbackSource(), /function dshFeedback/)
})
