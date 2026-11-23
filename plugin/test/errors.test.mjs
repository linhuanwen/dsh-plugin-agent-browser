import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgentBrowserError,
  ERROR_CODES,
  HARNESS_ERROR_BASE,
  fromPanelMessage,
  isAgentBrowserError,
} from '../errors.js'

test('an error carries its code, retryable flag and hint', () => {
  const error = new AgentBrowserError('bridge_timeout', 'the panel did not answer')
  assert.ok(error instanceof Error)
  assert.equal(error.code, 'bridge_timeout')
  assert.equal(error.retryable, true)
  assert.match(error.hint, /retry/i)
  // The model only receives `Error: <message>`, so the code has to be in there.
  assert.equal(error.message, 'bridge_timeout: the panel did not answer')
  assert.equal(error.name, 'AgentBrowserError')
  assert.ok(isAgentBrowserError(error))
})

test('every documented code is constructible and keeps the table honest', () => {
  const codes = Object.keys(ERROR_CODES)
  assert.ok(codes.length >= 11)
  for (const code of codes) {
    const spec = ERROR_CODES[code]
    assert.equal(typeof spec.retryable, 'boolean', `${code} needs a retryable flag`)
    assert.ok(spec.hint.trim() !== '', `${code} needs a hint`)
    const error = new AgentBrowserError(code, 'text')
    assert.equal(error.code, code)
    assert.equal(error.retryable, spec.retryable)
    assert.equal(error.hint, spec.hint)
    assert.ok(error.message.startsWith(`${code}: `), `${code} must lead the message`)
  }
})

test('toJSON survives a JSON round-trip, so logs and the panel keep the code', () => {
  const error = new AgentBrowserError('download_rejected', 'too large', {
    details: { stage: 'too_large', bytes: 60 * 1024 * 1024 },
  })
  const revived = JSON.parse(JSON.stringify(error))
  assert.equal(revived.name, 'AgentBrowserError')
  assert.equal(revived.code, 'download_rejected')
  assert.equal(revived.retryable, false)
  assert.equal(revived.details.stage, 'too_large')
  assert.match(revived.message, /download_rejected: too large/)
})

test('the migration keeps the old prefixes readable', () => {
  assert.match(new AgentBrowserError('panel_taken_over', 'the user is driving').message, /taken_over/)
  assert.match(new AgentBrowserError('needs_human', 'a captcha is on screen').message, /needs_human:/)
  assert.match(new AgentBrowserError('bridge_timeout', 'did not answer in 20000ms').message, /did not answer/)
  assert.match(new AgentBrowserError('eval_disabled', 'switched off').message, /eval_disabled:/)
})

test('a code outside the table is a programming error, not a runtime one', () => {
  assert.throws(() => new AgentBrowserError('made_up', 'text'), /unknown agent-browser error code/)
})

test('a caller may override retryable, and a pre-prefixed message is not doubled', () => {
  const error = new AgentBrowserError('bridge_timeout', 'bridge_timeout: already prefixed', { retryable: false })
  assert.equal(error.message, 'bridge_timeout: already prefixed')
  assert.equal(error.retryable, false)
})

test('panel free text is mapped only where the shape is unambiguous', () => {
  assert.equal(fromPanelMessage('taken_over: the user took over').code, 'panel_taken_over')
  assert.equal(fromPanelMessage('needs_human: a human verification step is on screen').code, 'needs_human')
  assert.equal(fromPanelMessage('the browser panel is not mounted').code, 'panel_not_open')
  assert.equal(fromPanelMessage('the browser panel of session abc is not on screen, so the page cannot be driven.').code, 'panel_not_open')
  assert.equal(fromPanelMessage('net::ERR_NAME_NOT_RESOLVED').code, 'navigation_failed')
  const other = fromPanelMessage('the selector matched nothing')
  assert.equal(Object.hasOwn(other, 'code'), false, 'unrecognized text must not be relabelled')
  assert.equal(other.message, 'the selector matched nothing')
})

test('the base class is local on purpose, and the shape matches the host error', () => {
  // A profile plugin cannot reach the host's `HarnessError` instance: the host
  // runs from `app.asar`, while a bare import resolves to whatever DSH sits in
  // Node's global folders. Subclassing that copy would not satisfy the host's
  // `instanceof`, so the base is local and the code survives in the message.
  assert.equal(HARNESS_ERROR_BASE, 'local')
  const error = new AgentBrowserError('bridge_closed', 'the bridge stopped')
  assert.equal(error.name, 'AgentBrowserError')
  assert.equal(typeof error.code, 'string')
  assert.ok(error instanceof Error)
  assert.equal(Object.hasOwn(error, 'cause'), false)
})
