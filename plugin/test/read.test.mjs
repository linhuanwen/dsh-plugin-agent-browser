/**
 * Tests for `browser_read` (TICKET-057, SPEC-004 stage B2).
 *
 * Run with: node --test plugin/test/read.test.mjs
 *
 * Two halves, matching the design: the page reader is one synchronous look
 * (`inject/read.js`, tested here with a stub document), and the tool only
 * validates arguments and forwards one `read` command — no polling, no approval
 * (it is a read), one round trip.
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserReadTool, createTools, readSource } from '../tools.js'
import { Bridge } from '../bridge.js'

const SOURCE = readFileSync(new URL('../inject/read.js', import.meta.url), 'utf8')
const dshRead = new Function(SOURCE + '\nreturn dshRead')()

/** A rendered element with the fields `read.js` touches. */
function el(tag, options = {}) {
  const attributes = options.attrs ?? {}
  const element = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    innerText: options.text ?? '',
    textContent: options.textContent ?? options.text ?? '',
    value: options.value ?? '',
    parentElement: null,
    previousElementSibling: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null
    },
    querySelectorAll() {
      return []
    },
    getClientRects() {
      return [{}]
    },
  }
  return element
}

function cell(tag, text) {
  return { tagName: String(tag).toUpperCase(), innerText: text, textContent: text }
}

function row(cells, tag = 'tr') {
  return { tagName: String(tag).toUpperCase(), cells, parentElement: null }
}

function table(options = {}) {
  return {
    tagName: 'TABLE',
    caption: options.caption === undefined ? null : { tagName: 'CAPTION', innerText: options.caption, textContent: options.caption },
    getAttribute(name) {
      return options.attrs !== undefined && Object.prototype.hasOwnProperty.call(options.attrs, name) ? options.attrs[name] : null
    },
    rows: options.rows ?? [],
  }
}

/**
 * Run the reader against a stub document, restoring the real one afterwards.
 * `selectorMap` answers `querySelectorAll`; `body` is the default root.
 */
function withPage(page, run) {
  const previousDocument = globalThis.document
  const previousWindow = globalThis.window
  const all = page.all ?? {}
  const one = page.one ?? {}
  globalThis.document = {
    querySelector(selector) {
      if (page.throwsOn !== undefined && selector === page.throwsOn) throw new Error('SyntaxError')
      return one[selector] ?? null
    },
    querySelectorAll(selector) {
      if (page.throwsOn !== undefined && selector === page.throwsOn) throw new Error('SyntaxError')
      return all[selector] ?? []
    },
    get body() {
      return page.body ?? { tagName: 'BODY', innerText: '', textContent: '', getAttribute: () => null }
    },
    location: { href: page.url ?? 'http://127.0.0.1:7789/demo/read.html' },
    title: page.title ?? '阅读夹具',
  }
  globalThis.window = {}
  try {
    return run()
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
}

function bodyWith(text) {
  const element = el('body', { text: text === undefined ? '' : text })
  return element
}

// --- page reader ------------------------------------------------------------

test('text mode reads the rendered body, normalizes blank lines and reports counts', () => {
  const body = bodyWith('  标题\n\n\n\n第一段  有  空格\n第二段\n\n')
  const answer = withPage({ body }, () => dshRead({}))
  assert.equal(answer.ok, true)
  assert.equal(answer.mode, 'text')
  assert.equal(answer.text, '标题\n\n第一段 有 空格\n第二段')
  assert.equal(answer.chars, answer.text.length)
  assert.equal(answer.totalChars, answer.text.length)
  assert.equal(answer.truncated, false)
  assert.equal(answer.root.tag, 'body')
  assert.equal(answer.url, 'http://127.0.0.1:7789/demo/read.html')
  assert.equal(answer.title, '阅读夹具')
})

test('text mode cuts at maxChars and says how much was left', () => {
  const body = bodyWith('x'.repeat(120) + '\n' + 'y'.repeat(180))
  const answer = withPage({ body }, () => dshRead({ maxChars: 200 }))
  assert.equal(answer.chars, 200)
  assert.equal(answer.truncated, true)
  assert.ok(answer.totalChars > 200, `totalChars ${answer.totalChars} should exceed the budget`)
})

test('a loc root reads only that element and reports its tag', () => {
  const article = el('article', { text: '文章正文' })
  const answer = withPage({ one: { '#article': article } }, () => dshRead({ loc: 'css:#article' }))
  assert.equal(answer.text, '文章正文')
  assert.equal(answer.root.tag, 'article')
  assert.equal(answer.root.role, 'article')
})

test('a selector root uses the first match unless strict is set', () => {
  const first = el('section', { text: 'one' })
  const second = el('section', { text: 'two' })
  const all = { '.card': [first, second] }
  const loose = withPage({ all }, () => dshRead({ selector: '.card' }))
  assert.equal(loose.text, 'one')
  const strict = withPage({ all }, () => dshRead({ selector: '.card', strict: true }))
  assert.equal(strict.ok, false)
  assert.equal(strict.error, 'multiple')
})

test('a stale loc, a malformed loc and an unmatched selector are stable errors', () => {
  const stale = withPage({ one: {} }, () => dshRead({ loc: 'css:#gone' }))
  assert.equal(stale.ok, false)
  assert.equal(stale.error, 'stale_loc')
  const bad = withPage({}, () => dshRead({ loc: '#no-prefix' }))
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'bad_loc')
  const missing = withPage({ all: {} }, () => dshRead({ selector: '.nope' }))
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'not_found')
})

test('hidden text stays out: the reader uses innerText, not textContent', () => {
  const body = el('body', { text: '可见文字', textContent: '可见文字 display:none 的文字' })
  const answer = withPage({ body }, () => dshRead({}))
  assert.equal(answer.text, '可见文字')
  assert.doesNotMatch(answer.text, /display:none/)
})

test('table mode reads caption, headers and rows', () => {
  const grid = table({
    caption: '十一月报表',
    rows: [
      row([cell('th', '日期'), cell('th', '金额')], 'tr'),
      row([cell('td', '2025-11-01'), cell('td', '12.00')]),
      row([cell('td', '2025-11-02'), cell('td', '18.50')]),
    ],
  })
  const body = bodyWith('')
  body.querySelectorAll = (selector) => (selector === 'table' ? [grid] : [])
  const answer = withPage({ body }, () => dshRead({ mode: 'table' }))
  assert.equal(answer.ok, true)
  assert.equal(answer.mode, 'table')
  assert.equal(answer.tableCount, 1)
  assert.equal(answer.tables.length, 1)
  const first = answer.tables[0]
  assert.equal(first.caption, '十一月报表')
  assert.deepEqual(first.headers, ['日期', '金额'])
  assert.deepEqual(first.rows, [['2025-11-01', '12.00'], ['2025-11-02', '18.50']])
  assert.equal(first.rowCount, 2)
  assert.equal(first.truncated, false)
})

test('table mode honours maxRows and maxTables', () => {
  const rows = [row([cell('th', 'a')], 'tr')]
  for (let index = 0; index < 5; index += 1) rows.push(row([cell('td', `r${index}`)]))
  const grid = table({ rows })
  const other = table({ rows: [row([cell('td', 'x')])] })
  const body = bodyWith('')
  body.querySelectorAll = (selector) => (selector === 'table' ? [grid, other] : [])
  const answer = withPage({ body }, () => dshRead({ mode: 'table', maxTables: 1, maxRows: 2 }))
  assert.equal(answer.tableCount, 2)
  assert.equal(answer.tables.length, 1)
  assert.equal(answer.truncated, true)
  assert.equal(answer.tables[0].rows.length, 2)
  assert.equal(answer.tables[0].rowCount, 5)
  assert.equal(answer.tables[0].truncated, true)
})

test('the source is a single function expression the panel can call in place', () => {
  const callable = new Function('return (' + SOURCE + ')')()
  assert.equal(typeof callable, 'function')
  const answer = withPage({ body: bodyWith('hello') }, () => callable({}))
  assert.equal(answer.text, 'hello')
})

// --- tool -------------------------------------------------------------------

const EXEC = { agent: { id: 's1' } }

function fakeBridge(answer = { ok: true, mode: 'text', text: 'hello', chars: 5, totalChars: 5, truncated: false, root: { tag: 'body', role: 'body', name: '', loc: '' }, url: 'http://127.0.0.1:7789/demo/read.html', title: '阅读夹具' }) {
  const calls = []
  const approvals = []
  const bridge = {
    calls,
    approvals,
    hasClient: () => true,
    pageOf: () => ({ url: 'http://127.0.0.1:7789/demo/read.html', title: '阅读夹具' }),
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

test('a text read forwards one read command and never asks for approval', async () => {
  const bridge = fakeBridge()
  const value = await browserReadTool(bridge).execute({}, EXEC)
  assert.equal(bridge.approvals.length, 0, 'reading is not a write')
  assert.equal(bridge.calls.length, 1)
  const call = bridge.calls[0]
  assert.equal(call.type, 'read')
  assert.equal(call.params.mode, 'text')
  assert.equal(call.params.maxChars, 8000)
  assert.equal(call.params.strict, false)
  assert.match(call.params.source, /function dshRead/)
  assert.equal(value.mode, 'text')
  assert.equal(value.text, 'hello')
  assert.equal(value.chars, 5)
  assert.equal(value.truncated, false)
})

test('loc/selector/ref are mutually exclusive and loc must be a css: path', async () => {
  const tool = browserReadTool(fakeBridge())
  await assert.rejects(tool.execute({ loc: 'css:#a', selector: '#a' }, EXEC), /at most one of ref, loc or selector/)
  await assert.rejects(tool.execute({ loc: '#a' }, EXEC), /loc must start with "css:"/)
  await assert.rejects(tool.execute({ mode: 'html' }, EXEC), /mode must be "text" or "table"/)
})

test('numeric budgets are validated and clamped', async () => {
  const bridge = fakeBridge()
  const tool = browserReadTool(bridge)
  await tool.execute({ maxChars: 1, maxTables: 0, maxRows: 9_999 }, EXEC)
  assert.equal(bridge.calls[0].params.maxChars, 200)
  assert.equal(bridge.calls[0].params.maxTables, 1)
  assert.equal(bridge.calls[0].params.maxRows, 500)
  await tool.execute({ maxChars: 999_999, maxTables: 99, maxRows: 1 }, EXEC)
  assert.equal(bridge.calls[1].params.maxChars, 40000)
  assert.equal(bridge.calls[1].params.maxTables, 20)
  assert.equal(bridge.calls[1].params.maxRows, 1)
  await assert.rejects(tool.execute({ maxChars: 12.5 }, EXEC), /maxChars must be an integer/)
})

test('table mode maps the page answer and renders the rows', async () => {
  const bridge = fakeBridge({
    ok: true,
    mode: 'table',
    tables: [{ caption: '报表', headers: ['a', 'b'], rows: [['1', '2']], rowCount: 1, truncated: false }],
    tableCount: 1,
    truncated: false,
    url: 'http://127.0.0.1:7789/',
    title: 't',
  })
  const tool = browserReadTool(bridge)
  const value = await tool.execute({ mode: 'table' }, EXEC)
  assert.equal(bridge.calls[0].params.mode, 'table')
  assert.equal(value.tables.length, 1)
  assert.equal(value.tables[0].caption, '报表')
  const rendered = tool.output.render({}, value)[0].text
  assert.match(rendered, /Read 1 table\(s\)/)
  assert.match(rendered, /Table 1 — 报表 \(1 row\(s\)\)/)
  assert.match(rendered, /a \| b/)
  assert.match(rendered, /1 \| 2/)
})

test('an empty table answer renders a useful note', async () => {
  const bridge = fakeBridge({ ok: true, mode: 'table', tables: [], tableCount: 0, truncated: false })
  const tool = browserReadTool(bridge)
  const value = await tool.execute({ mode: 'table' }, EXEC)
  assert.equal(value.tables.length, 0)
  assert.match(tool.output.render({}, value)[0].text, /No <table> elements/)
})

test('a page-side refusal becomes a stable error that names the address', async () => {
  const bridge = fakeBridge({ ok: false, error: 'stale_loc', loc: 'css:#gone', matched: 0 })
  const error = await browserReadTool(bridge).execute({ loc: 'css:#gone' }, EXEC).then(() => null, (caught) => caught)
  assert.notEqual(error, null)
  assert.equal(error.code, 'stale_loc')
  assert.match(error.message, /loc "css:#gone" no longer matches/)
})

test('a strict selector with several matches points at strict:false', async () => {
  const bridge = fakeBridge({ ok: false, error: 'multiple', selector: '.card', matched: 3 })
  const error = await browserReadTool(bridge).execute({ selector: '.card', strict: true }, EXEC).then(() => null, (caught) => caught)
  assert.equal(error.code, 'multiple')
  assert.match(error.message, /matched 3 element\(s\)/)
  assert.match(error.message, /strict:false/)
})

test('truncated text is called out in the rendered answer', async () => {
  const bridge = fakeBridge({ ok: true, mode: 'text', text: 'abc', chars: 3, totalChars: 900, truncated: true })
  const tool = browserReadTool(bridge)
  const value = await tool.execute({}, EXEC)
  const rendered = tool.output.render({}, value)[0].text
  assert.match(rendered, /Read 3 of 900 rendered characters/)
  assert.match(rendered, /truncated/)
})

test('reading stays queued while the person is driving (taken_over), like a snapshot', async () => {
  const bridge = new Bridge({ port: 0, logger: () => {}, timeoutMs: 30_000 })
  await bridge.start()
  try {
    bridge.setPhase('s1', 'taken_over', {})
    const pending = bridge.request('s1', 'read', { mode: 'text', source: 'x' }, 30_000)
    await new Promise((resolve) => setTimeout(resolve, 80))
    await bridge.close()
    await assert.rejects(pending, /bridge_closed:/, 'read is a read: it must reach the panel instead of being refused as an input')
  } finally {
    await bridge.close().catch(() => {})
  }
})

test('reading is not refused during a verification wall either', async () => {
  const bridge = new Bridge({ port: 0, logger: () => {}, timeoutMs: 30_000 })
  await bridge.start()
  try {
    bridge.setPhase('s1', 'needs_human', { signals: [] })
    const pending = bridge.request('s1', 'read', { mode: 'table', source: 'x' }, 30_000)
    await new Promise((resolve) => setTimeout(resolve, 80))
    await bridge.close()
    await assert.rejects(pending, /bridge_closed:/)
  } finally {
    await bridge.close().catch(() => {})
  }
})

test('the read tool is registered with the other seventeen tools (eighteen now)', () => {
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
  assert.ok(names.includes('browser_read'), 'browser_read must be registered')
  assert.equal(names.length, 18)
})

void readSource
