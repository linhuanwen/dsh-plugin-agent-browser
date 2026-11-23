/**
 * Tests for the in-page human-verification detector.
 *
 * Run with: node --test plugin/test/detect.test.mjs
 *
 * `inject/detect.js` ships to the page as source text and only reads `document`
 * and `location`, so it loads here with two stubs. The cases come from real
 * walls: the Cloudflare interstitial, and the Alibaba slider that the agent
 * drove straight into on 1688 because neither its title nor its body text was
 * in the phrase list.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../inject/detect.js', import.meta.url), 'utf8')
const detect = new Function(`return (${SOURCE}\n)`)()

/** A node good enough for `createElement` + `appendChild`. */
function node() {
  return { id: '', style: {}, textContent: '', setAttribute: () => {}, remove: () => {} }
}

/**
 * Run the detector with a stub page.
 *
 * @param {object} page - `{ url, title, text, widgets, interactive }` where
 *   `widgets` lists selectors that resolve, and `interactive` is how many
 *   controls `document.querySelectorAll('input,button,…')` reports.
 */
function run(page) {
  const previousDocument = globalThis.document
  const previousLocation = globalThis.location
  const body = node()
  body.appendChild = () => {}
  globalThis.location = { href: page.url ?? 'https://example.test/' }
  globalThis.document = {
    title: page.title ?? '',
    contentType: page.contentType ?? 'text/html',
    body: { innerText: page.text ?? '', appendChild: () => {} },
    documentElement: body,
    querySelector: (selector) => ((page.widgets ?? []).includes(selector) ? { getBoundingClientRect: () => ({ left: 1, top: 2, width: 30, height: 40 }) } : null),
    querySelectorAll: (selector) => {
      if (selector === 'input,button,select,textarea,a[href]') {
        return { length: page.interactive ?? 0 }
      }
      return { length: 0 }
    },
    getElementById: () => null,
    createElement: () => node(),
  }
  try {
    return JSON.parse(detect({}))
  } finally {
    globalThis.document = previousDocument
    globalThis.location = previousLocation
  }
}

test('cloudflare: url + title + widget agree, so it is a wall', () => {
  const verdict = run({
    url: 'https://site.test/cdn-cgi/challenge-platform/h/b/orchestrate',
    title: 'Just a moment...',
    widgets: ['#challenge-stage'],
    interactive: 1,
  })
  assert.equal(verdict.hit, true)
  assert.deepEqual(verdict.categories.sort(), ['dom', 'location'])
  assert.equal(verdict.rect.width, 30)
})

test('alibaba slider: a title plus its body text is enough (the 1688 miss)', () => {
  const verdict = run({
    url: 'https://www.1688.com/',
    title: '验证码拦截',
    text: '请按住滑块，拖动到最右边',
    widgets: [],
    interactive: 2,
  })
  assert.equal(verdict.hit, true, 'titles and phrases from the real wall must hit')
  assert.deepEqual(verdict.categories.sort(), ['location', 'text'])
})

test('one text hit on an empty page is a wall (nothing else to interact with)', () => {
  const verdict = run({
    url: 'https://site.test/',
    title: 'Product list',
    text: '请完成安全验证',
    widgets: [],
    interactive: 1,
  })
  assert.equal(verdict.hit, true)
  assert.deepEqual(verdict.categories, ['text'])
})

test('the same phrase on a page with plenty of controls is not a wall', () => {
  const verdict = run({
    url: 'https://site.test/help',
    title: '如何完成滑块验证',
    text: '遇到滑块验证时，请按住滑块拖动到最右边',
    widgets: [],
    interactive: 40,
  })
  // One text hit, and it is an ordinary page with a form: no wall. This is the
  // line the downgrade rule has to respect, otherwise every help article about
  // captchas would hand the panel to the user.
  assert.equal(verdict.hit, false)
  assert.deepEqual(verdict.categories, ['text'])
  assert.equal(verdict.interactive, 40)
})

test('an ordinary page reports nothing', () => {
  const verdict = run({
    url: 'https://site.test/list',
    title: '商品列表',
    text: '共 46 件商品',
    widgets: [],
    interactive: 46,
  })
  assert.equal(verdict.hit, false)
  assert.deepEqual(verdict.categories, [])
  assert.equal(verdict.interactive, 46)
})

test('a plain-text document that merely mentions a phrase is not a wall', () => {
  const verdict = run({
    url: 'http://127.0.0.1:7763/t/README.md',
    title: 'README.md',
    contentType: 'text/plain',
    text: '本插件不处理人机验证：检测到人机验证时交给用户完成',
    widgets: [],
    interactive: 0,
  })
  // See 2026-11-21: the project README served by our own static server tripped
  // the text-only rule and put the panel into `needs_human`. A wall is always an
  // HTML document, so plain text can never be one.
  assert.equal(verdict.hit, false)
  assert.deepEqual(verdict.categories, ['text'])
})

test('the same phrase on a plain html page is still a wall', () => {
  const verdict = run({
    url: 'https://site.test/',
    title: 'Product list',
    contentType: 'text/html',
    text: '请完成安全验证',
    widgets: [],
    interactive: 1,
  })
  assert.equal(verdict.hit, true)
})

test('a lone captcha class without context is not enough', () => {
  const verdict = run({
    url: 'https://site.test/form',
    title: '联系我们',
    text: '请填写下面的表单',
    widgets: ['[class*="captcha" i]'],
    interactive: 12,
  })
  assert.equal(verdict.hit, false, 'a site form with a captcha field is not a wall')
})
