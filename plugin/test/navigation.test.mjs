/**
 * Tests for TICKET-013: a failed navigation must not take the page with it, and
 * the error must say which failure it was.
 *
 * Run with: node --test plugin/test/navigation.test.mjs
 *
 * The classifier is pure, so the interesting cases (DNS, refused, reset,
 * certificate, timeout, offline) are pinned without a browser or a network. The
 * rollback itself lives in the renderer half and is exercised by the装机 checks
 * in `docs/tickets/013-failed-navigation.md` §4 — a `<webview>` cannot be driven from
 * node.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NAVIGATION_STAGES,
  chromeErrorCode,
  classifyNavigationFailure,
  navigationFailureText,
} from '../navigation.js'
import { AgentBrowserError } from '../errors.js'
import { classifyOpenFailure } from '../tools.js'

/** The exact shape Electron wraps a net error in. */
function remote(raw) {
  return `Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ${raw} loading 'https://example.com/'`
}

test('each net error maps to its own stage', () => {
  const cases = [
    ['ERR_NAME_NOT_RESOLVED (-105)', 'nav_dns'],
    ['getaddrinfo ENOTFOUND example.com', 'nav_dns'],
    ['ERR_CONNECTION_REFUSED (-102)', 'nav_refused'],
    ['ECONNREFUSED 127.0.0.1:1', 'nav_refused'],
    ['ERR_CONNECTION_RESET (-101)', 'nav_reset'],
    ['ERR_EMPTY_RESPONSE (-324)', 'nav_reset'],
    ['ERR_CERT_DATE_INVALID (-201)', 'nav_cert'],
    ['ERR_SSL_PROTOCOL_ERROR (-107)', 'nav_cert'],
    ['ERR_TIMED_OUT (-7)', 'nav_timeout'],
    ['ETIMEDOUT', 'nav_timeout'],
    ['ERR_INTERNET_DISCONNECTED (-106)', 'nav_offline'],
    ['ERR_BLOCKED_BY_CLIENT (-20)', 'nav_blocked'],
    ['ERR_ABORTED (-3)', 'nav_aborted'],
    ['something nobody predicted', 'nav_unknown'],
  ]
  for (const [raw, stage] of cases) {
    assert.equal(classifyNavigationFailure(remote(raw)).stage, stage, raw)
  }
})

test('the chromium code survives classification, and stages stay in the published vocabulary', () => {
  const reset = classifyNavigationFailure(remote('ERR_CONNECTION_RESET (-101)'))
  assert.equal(reset.code, 'ERR_CONNECTION_RESET')
  assert.equal(chromeErrorCode('ERR_CERT_AUTHORITY_INVALID (-202)'), 'ERR_CERT_AUTHORITY_INVALID')
  assert.equal(chromeErrorCode('nothing here'), null)
  for (const stage of NAVIGATION_STAGES) {
    assert.match(stage, /^nav_[a-z]+$/, 'stage names are stable snake_case')
  }
})

test('a certificate failure is not advertised as retryable', () => {
  assert.equal(classifyNavigationFailure(remote('ERR_CERT_AUTHORITY_INVALID (-202)')).retryable, false)
  assert.equal(classifyNavigationFailure(remote('ERR_CONNECTION_RESET (-101)')).retryable, true)
})

test('the message says whether the previous page survived', () => {
  const classified = classifyNavigationFailure(remote('ERR_CONNECTION_RESET (-101)'))
  const restored = navigationFailureText(classified, {
    url: 'https://bad.example/',
    previousUrl: 'https://good.example/list',
    restored: true,
  })
  assert.match(restored, /^nav_reset: /)
  assert.match(restored, /ERR_CONNECTION_RESET/)
  assert.match(restored, /went back to https:\/\/good\.example\/list/)
  assert.doesNotMatch(restored, /error page/)

  const lost = navigationFailureText(classified, { url: 'https://bad.example/', restored: false })
  assert.match(lost, /could not go back/)
  assert.match(lost, /error page/)
})

test('classifyOpenFailure keeps the structured code and picks the stage', () => {
  const raw = remote('ERR_CONNECTION_RESET (-101)')
  const panelError = new AgentBrowserError('navigation_failed', `navigation_failed: ${raw}`, {
    details: { url: 'https://bad.example/', previousUrl: 'https://good.example/', restored: true, raw },
  })
  const classified = classifyOpenFailure(panelError, 'https://bad.example/')
  assert.equal(classified.code, 'navigation_failed')
  assert.equal(classified.details.stage, 'nav_reset')
  assert.equal(classified.details.code, 'ERR_CONNECTION_RESET')
  assert.equal(classified.details.restored, true)
  assert.equal(classified.retryable, true)
  // AgentBrowserError prefixes the code, and the classifier names the stage, so
  // the model reads both: `navigation_failed: nav_reset: …`.
  assert.match(classified.message, /^navigation_failed: nav_reset: /)
})

test('classifyOpenFailure leaves unrelated failures alone', () => {
  const other = new AgentBrowserError('panel_not_open', 'panel_not_open: the panel is not open')
  assert.equal(classifyOpenFailure(other, 'https://example.com/'), other)
  const plain = new Error('boom')
  assert.equal(classifyOpenFailure(plain, 'https://example.com/'), plain)
})
