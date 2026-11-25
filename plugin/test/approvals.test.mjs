/**
 * Tests for the first-touch permission logic (SPEC-003, TICKET-037).
 *
 * Run with: node --test plugin/test/approvals.test.mjs
 *
 * Everything here is synchronous and browser-free on purpose: the rules (which
 * action needs a human, which site already has a grant, what a decision may be)
 * are the part that is worth pinning down. The transport half — the bridge's
 * pending prompt and the panel's confirm bar — is exercised where it lives.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_CLASSES,
  APPROVAL_MODES,
  DEFAULT_APPROVAL_MODE,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  SUBMIT_KEYS,
  actionClassFor,
  clickClass,
  createGrantBook,
  fingerprint,
  isSensitive,
  normalizeApprovals,
  originOf,
  parseDecision,
  pressClass,
  shouldConfirm,
  siteLabel,
  summarize,
} from '../approvals.js'

test('the shipped stance is first-touch with a 30 second window', () => {
  assert.equal(DEFAULT_APPROVAL_MODE, 'first-touch')
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 30_000)
  assert.deepEqual(APPROVAL_MODES, ['first-touch', 'off'])
  assert.deepEqual(ACTION_CLASSES, ['type', 'submit', 'download', 'eval'])
  assert.deepEqual(SUBMIT_KEYS, ['Enter', 'Return', 'NumpadEnter'])
  assert.deepEqual(normalizeApprovals(undefined), {
    mode: 'first-touch',
    timeoutMs: 30_000,
    sensitiveSites: [],
  })
})

test('an unknown mode falls back to asking, never to silence', () => {
  assert.equal(normalizeApprovals({ mode: 'yes-please' }).mode, 'first-touch')
  assert.equal(normalizeApprovals({ mode: 'off' }).mode, 'off')
})

test('the timeout is clamped to a readable range', () => {
  assert.equal(normalizeApprovals({ timeoutMs: 100 }).timeoutMs, 2_000)
  assert.equal(normalizeApprovals({ timeoutMs: 10_000_000 }).timeoutMs, 120_000)
  assert.equal(normalizeApprovals({ timeoutMs: 12_345.6 }).timeoutMs, 12_346)
  assert.equal(normalizeApprovals({ timeoutMs: 'soon' }).timeoutMs, 30_000)
})

test('sensitive sites are reduced to host names', () => {
  assert.deepEqual(normalizeApprovals({ sensitiveSites: ['https://Mail.Example.com/inbox', 'example.com', '', 42] }).sensitiveSites, ['mail.example.com', 'example.com'])
})

test('only http(s) pages get an origin to scope a grant to', () => {
  assert.equal(originOf('https://example.com/a/b?q=1'), 'https://example.com')
  assert.equal(originOf('http://127.0.0.1:8080/x'), 'http://127.0.0.1:8080')
  assert.equal(originOf('about:blank'), '')
  assert.equal(originOf('file:///C:/x.html'), '')
  assert.equal(originOf(''), '')
  assert.equal(originOf(undefined), '')
})

test('siteLabel shows the host, and a fallback for no site', () => {
  assert.equal(siteLabel('https://www.example.com'), 'www.example.com')
  assert.equal(siteLabel(''), '当前页面')
})

test('a sensitive entry covers its subdomains but not lookalikes', () => {
  assert.equal(isSensitive('https://example.com', ['example.com']), true)
  assert.equal(isSensitive('https://www.example.com', ['example.com']), true)
  assert.equal(isSensitive('https://badexample.com', ['example.com']), false)
  assert.equal(isSensitive('https://example.com.evil.test', ['example.com']), false)
  assert.equal(isSensitive('https://example.com', []), false)
})

test('click classification: only a known submit control is a write', () => {
  assert.equal(clickClass({ isSubmit: true }), 'submit')
  assert.equal(clickClass({ isSubmit: false }), null)
  // The page script failing is the only way to not know; asking once is the
  // recoverable mistake, skipping the confirm is not.
  assert.equal(clickClass(null), 'submit')
  assert.equal(clickClass(undefined), 'submit')
})

test('Enter is a submit only when the focused control is in a form', () => {
  assert.equal(pressClass('Enter', { isSubmit: true }), 'submit')
  assert.equal(pressClass('Enter', null), 'submit')
  assert.equal(pressClass('Enter', { isSubmit: false }), null)
  assert.equal(pressClass('a', { isSubmit: true }), null)
  assert.equal(pressClass(undefined, { isSubmit: true }), null)
})

test('every tool with a write maps to its class; the rest are reads', () => {
  assert.equal(actionClassFor('type'), 'type')
  assert.equal(actionClassFor('eval'), 'eval')
  assert.equal(actionClassFor('download'), 'download')
  assert.equal(actionClassFor('click', {}, { isSubmit: true }), 'submit')
  assert.equal(actionClassFor('click', {}, null), 'submit')
  assert.equal(actionClassFor('click', {}, { isSubmit: false }), null)
  assert.equal(actionClassFor('press', { key: 'Enter' }, { isSubmit: true }), 'submit')
  assert.equal(actionClassFor('press', { key: 'Tab' }, { isSubmit: true }), null)
  for (const read of ['open', 'snapshot', 'scroll', 'hover', 'zoom', 'screenshot']) {
    assert.equal(actionClassFor(read), null, read)
  }
})

test('the fingerprint never carries what the user typed', () => {
  const action = { origin: 'https://example.com', actionClass: 'type', target: { tag: 'INPUT', role: 'textbox' } }
  assert.equal(fingerprint(action), 'https://example.com|type|input|textbox')
  // Same target, different text: same fingerprint — a log line is not a place
  // for a password or an address.
  assert.equal(fingerprint({ ...action, text: 'hunter2' }), fingerprint({ ...action, text: 'other' }))
  assert.equal(fingerprint({}), '|||')
})

test('the prompt text is one readable sentence per class', () => {
  assert.equal(summarize('type', 'https://example.com'), '在 example.com 的输入框里输入文字')
  assert.equal(summarize('submit', 'https://example.com', { name: '提交订单' }), '在 example.com 点击「提交订单」提交表单')
  assert.equal(summarize('submit', 'https://example.com'), '在 example.com 点击提交表单')
  assert.equal(summarize('download', 'https://example.com'), '从 example.com 下载文件')
  assert.equal(summarize('eval', 'https://example.com'), '在 example.com 执行页面脚本')
})

test('a grant is per session and per origin, and can be dropped', () => {
  const grants = createGrantBook()
  assert.equal(grants.covers('s1', 'https://example.com'), false)
  grants.grant('s1', 'https://example.com')
  assert.equal(grants.covers('s1', 'https://example.com'), true)
  // A different origin in the same session asks again.
  assert.equal(grants.covers('s1', 'https://other.test'), false)
  // A new session starts blank.
  assert.equal(grants.covers('s2', 'https://example.com'), false)
  grants.forget('s1')
  assert.equal(grants.covers('s1', 'https://example.com'), false)
  assert.equal(grants.size(), 0)
})

test('a grant without an origin is not a grant', () => {
  const grants = createGrantBook()
  grants.grant('s1', '')
  assert.equal(grants.covers('s1', ''), false)
  assert.equal(grants.size(), 0)
})

test('grants are bounded, oldest dropped first', () => {
  const grants = createGrantBook()
  for (let index = 0; index < 70; index += 1) grants.grant('s1', `https://site-${index}.test`)
  assert.equal(grants.size(), 64)
  assert.equal(grants.covers('s1', 'https://site-0.test'), false)
  assert.equal(grants.covers('s1', 'https://site-69.test'), true)
})

test('shouldConfirm: off is silent, reads are silent, writes on a granted site are silent', () => {
  const grants = createGrantBook()
  const base = { mode: 'first-touch', actionClass: 'type', origin: 'https://example.com', sensitiveSites: [], grants, sessionId: 's1' }
  assert.equal(shouldConfirm({ ...base, mode: 'off' }), false)
  assert.equal(shouldConfirm({ ...base, actionClass: null }), false)
  assert.equal(shouldConfirm({ ...base, actionClass: 'read' }), false)
  assert.equal(shouldConfirm(base), true)
  grants.grant('s1', 'https://example.com')
  assert.equal(shouldConfirm(base), false)
  // A sensitive site asks every time, even after the site grant.
  assert.equal(shouldConfirm({ ...base, sensitiveSites: ['example.com'] }), true)
})

test('shouldConfirm: an origin we do not know is always asked about', () => {
  const grants = createGrantBook()
  assert.equal(shouldConfirm({ actionClass: 'eval', origin: '', grants, sessionId: 's1' }), true)
  grants.grant('s1', '')
  assert.equal(shouldConfirm({ actionClass: 'eval', origin: '', grants, sessionId: 's1' }), true)
})

test('parseDecision: an invisible client can only answer unavailable', () => {
  assert.equal(parseDecision('once'), 'once')
  assert.equal(parseDecision('site'), 'site')
  assert.equal(parseDecision('deny'), 'deny')
  assert.equal(parseDecision('unavailable'), 'unavailable')
  // Anything else is dropped rather than guessed; the host keeps waiting and the
  // timeout is the fallback.
  assert.equal(parseDecision('yes'), '')
  assert.equal(parseDecision(undefined), '')
  assert.equal(parseDecision(null), '')
  assert.equal(parseDecision('once', { clientVisible: false }), 'unavailable')
  assert.equal(parseDecision('deny', { clientVisible: false }), 'unavailable')
})
