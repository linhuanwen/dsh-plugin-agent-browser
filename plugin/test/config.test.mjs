/**
 * Tests for the config resolution rules (TICKET-016).
 *
 * Run with: node --test plugin/test/config.test.mjs
 *
 * The schema itself cannot be tested here: `@deepseek-ai/schemastery` only
 * resolves inside the DSH host (it is a peer dependency of the bundle, and the
 * copy under app.asar pulls `@deepseek-ai/cosmokit` with it). What a plain
 * `node` test *can* pin is the second half — what the host half does with the
 * validated row: fill every default, keep a partial group partial, and refuse a
 * value of the wrong shape instead of coercing it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, normalizeConfig, readField } from '../config.js'

test('an empty row resolves to the 1.1.x behaviour', () => {
  const settings = normalizeConfig()
  assert.deepEqual(settings, {
    bridge: { port: 0, requestTimeoutMs: 20_000 },
    limits: { navigationTimeoutMs: 45_000, snapshotMaxChars: 8000, evalMaxChars: 8000 },
    downloads: { dir: 'downloads', maxBytes: 50 * 1024 * 1024, extraBlockedExtensions: [] },
    static: { maxBytes: 32 * 1024 * 1024 },
    sessions: { allowlist: [] },
    // TICKET-027: the search fallback ships off; a row without the group must
    // not turn it on.
    searchFallback: { enabled: false, maxResults: 5 },
    // SPEC-003: a row without the group asks on the first write per site.
    approvals: { mode: 'first-touch', timeoutMs: 30_000, sensitiveSites: [] },
    // TICKET-041: JS dialogs are intercepted and recorded by the guards.
    dialogs: { mode: 'record' },
    // TICKET-055: in-page marks are drawn for agent actions unless turned off.
    feedback: { enabled: true, durationMs: 900 },
  })
  assert.deepEqual(settings.bridge, DEFAULTS.bridge)
})

test('a missing or null group falls back to its defaults', () => {
  for (const row of [{ bridge: undefined }, { limits: null }, null, undefined]) {
    assert.deepEqual(normalizeConfig(row).bridge, DEFAULTS.bridge, `row ${JSON.stringify(row)}`)
  }
})

test('a partial group keeps the defaults for untouched keys', () => {
  const settings = normalizeConfig({
    bridge: { port: 9001 },
    limits: { snapshotMaxChars: 3000 },
    downloads: { dir: 'files' },
    static: { maxBytes: 1024 },
  })
  assert.deepEqual(settings.bridge, { port: 9001, requestTimeoutMs: 20_000 })
  assert.deepEqual(settings.limits, { navigationTimeoutMs: 45_000, snapshotMaxChars: 3000, evalMaxChars: 8000 })
  assert.deepEqual(settings.downloads, { dir: 'files', maxBytes: 50 * 1024 * 1024, extraBlockedExtensions: [] })
  assert.equal(settings.static.maxBytes, 1024)
  assert.deepEqual(settings.sessions, { allowlist: [] })
  assert.deepEqual(settings.searchFallback, { enabled: false, maxResults: 5 })
  assert.deepEqual(settings.approvals, { mode: 'first-touch', timeoutMs: 30_000, sensitiveSites: [] })
  assert.deepEqual(settings.dialogs, { mode: 'record' })
})

test('TICKET-041 group: the dialog policy can be switched to native', () => {
  const settings = normalizeConfig({ dialogs: { mode: 'off' } })
  assert.deepEqual(settings.dialogs, { mode: 'off' })
  assert.throws(() => normalizeConfig({ dialogs: { mode: 'auto' } }), /dialogs\.mode/)
})

test('SPEC-003 group: the approval stance can be switched off and pinned per site', () => {
  const settings = normalizeConfig({
    approvals: { mode: 'off', timeoutMs: 5000, sensitiveSites: ['example.com', ' https://mail.example.com/inbox '] },
  })
  assert.deepEqual(settings.approvals, {
    mode: 'off',
    timeoutMs: 5000,
    sensitiveSites: ['example.com', 'https://mail.example.com/inbox'],
  })
})

test('SPEC-003 group: an unknown mode is refused instead of silently asking', () => {
  assert.throws(() => normalizeConfig({ approvals: { mode: 'auto' } }), /approvals\.mode/)
  assert.throws(() => normalizeConfig({ approvals: { timeoutMs: 1.5 } }), /approvals\.timeoutMs/)
  assert.throws(() => normalizeConfig({ approvals: { sensitiveSites: [42] } }), /approvals\.sensitiveSites/)
})

test('TICKET-027 group: the fallback can be enabled and capped', () => {
  const settings = normalizeConfig({ searchFallback: { enabled: true, maxResults: 3 } })
  assert.deepEqual(settings.searchFallback, { enabled: true, maxResults: 3 })
})

test('a volatile reader for searchFallback.enabled is resolved, not refused', () => {
  // The schema wraps `.volatile()` fields into readers; the loader hands those to
  // `apply()`. A reader is a valid value here — only its *content* must be boolean.
  const settings = normalizeConfig({ searchFallback: { enabled: { get: () => true } } })
  assert.deepEqual(settings.searchFallback, { enabled: true, maxResults: 5 })
  const empty = normalizeConfig({ searchFallback: { enabled: { get: () => undefined } } })
  assert.equal(empty.searchFallback.enabled, false)
})

test('TICKET-024 groups: extension denials and the session allow list', () => {
  const settings = normalizeConfig({
    downloads: { extraBlockedExtensions: ['iso', '.img'] },
    sessions: { allowlist: ['session-a', 'session-b'] },
  })
  assert.deepEqual(settings.downloads.extraBlockedExtensions, ['iso', '.img'])
  assert.deepEqual(settings.sessions.allowlist, ['session-a', 'session-b'])
})

test('a value of the wrong shape is refused, not coerced', () => {
  const cases = [
    [{ bridge: { port: -1 } }, /bridge\.port/],
    [{ bridge: { port: 1.5 } }, /bridge\.port/],
    [{ bridge: { port: '8792' } }, /bridge\.port/],
    [{ limits: { snapshotMaxChars: 0.5 } }, /limits\.snapshotMaxChars/],
    [{ downloads: { dir: '' } }, /downloads\.dir/],
    [{ downloads: { dir: 42 } }, /downloads\.dir/],
    [{ downloads: { extraBlockedExtensions: 'exe' } }, /extraBlockedExtensions/],
    [{ downloads: { extraBlockedExtensions: [42] } }, /extraBlockedExtensions/],
    [{ sessions: { allowlist: 'session-a' } }, /allowlist/],
    [{ sessions: { allowlist: [''] } }, /allowlist/],
    [{ searchFallback: { enabled: 'yes' } }, /searchFallback\.enabled/],
    [{ searchFallback: { maxResults: -1 } }, /searchFallback\.maxResults/],
    [{ searchFallback: { maxResults: 2.5 } }, /searchFallback\.maxResults/],
    [{ static: { maxBytes: null } }, undefined],
    [{ feedback: { enabled: 'yes' } }, /feedback\.enabled/],
    [{ feedback: { durationMs: -1 } }, /feedback\.durationMs/],
    [{ feedback: { durationMs: 2.5 } }, /feedback\.durationMs/],
  ]
  for (const [row, pattern] of cases) {
    if (pattern === undefined) {
      assert.doesNotThrow(() => normalizeConfig(row), `row ${JSON.stringify(row)}`)
      continue
    }
    assert.throws(() => normalizeConfig(row), pattern, `row ${JSON.stringify(row)}`)
  }
})

test('TICKET-055 group: in-page feedback defaults on and clamps its duration', () => {
  const defaults = normalizeConfig({})
  assert.deepEqual(defaults.feedback, { enabled: true, durationMs: 900 })
  assert.equal(normalizeConfig({ feedback: { enabled: false } }).feedback.enabled, false)
  assert.equal(normalizeConfig({ feedback: { durationMs: 5000 } }).feedback.durationMs, 5000)
  assert.equal(normalizeConfig({ feedback: { durationMs: 6000 } }).feedback.durationMs, 5000)
  assert.equal(normalizeConfig({ feedback: { durationMs: 10 } }).feedback.durationMs, 100)
})

test('readField unwraps a volatile reader and falls back when empty', () => {
  assert.equal(readField('manual', 'auto'), 'manual')
  assert.equal(readField({ get: () => 'always' }, 'auto'), 'always')
  assert.equal(readField({ get: () => undefined }, 'auto'), 'auto')
  assert.equal(readField(undefined, true), true)
  assert.equal(readField(null, 8000), 8000)
  assert.equal(readField(false, true), false)
})
