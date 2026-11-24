/**
 * Tests for the Settings page's channel (TICKET-036).
 *
 * Run with: node --test plugin/test/settings.test.mjs
 *
 * The page lives in the client half, but everything that can be wrong lives on
 * this side: what the page may read, what a save hands to the config editor, and
 * what happens in a profile that has no editor at all (the page must be told,
 * not shown a button that cannot work).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge, BRIDGE_PREFIX } from '../bridge.js'
import { CONFIG_FIELDS, createConfigChannel, snapshotConfig } from '../apply.js'
import { normalizeConfig } from '../config.js'

/** A bridge whose config channel is the one under test. */
function bridgeWith(config) {
  return new Bridge({ port: 0, logger: () => {}, timeoutMs: 5_000, config })
}

/** Start it and return the base URL plus the header a panel would send. */
async function start(bridge) {
  await bridge.start()
  return {
    base: `http://127.0.0.1:${bridge.port}${BRIDGE_PREFIX}`,
    auth: { authorization: `Bearer ${bridge.token}` },
  }
}

/** A config editor stand-in that records what it was asked to write. */
function fakeEditor() {
  const calls = []
  return {
    calls,
    async edit(entry, change) {
      const next = change({ activation: 'auto', limits: { snapshotMaxChars: 8_000 }, routing: 'off' })
      calls.push({ entry, next })
      return next
    },
  }
}

/** The ctx subset `createConfigChannel` reads. */
function fakeCtx(editor) {
  return {
    get: (name) => (name === 'configEditor' ? editor : undefined),
    fiber: { entry: { rowId: 'agent-browser-panel' } },
  }
}

test('a bridge without an adapter answers 501 instead of pretending', async () => {
  const bridge = bridgeWith(null)
  const { base, auth } = await start(bridge)
  try {
    const read = await fetch(`${base}/config`, { headers: auth })
    assert.equal(read.status, 501)
    assert.match((await read.json()).error, /cannot save plugin configuration/)
    const write = await fetch(`${base}/config`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { routing: 'on' } }),
    })
    assert.equal(write.status, 501)
  } finally {
    await bridge.close()
  }
})

test('GET /config answers the resolved values and the restart semantics', async () => {
  const config = { routing: 'auto' }
  const channel = createConfigChannel(fakeCtx(fakeEditor()), config, normalizeConfig(config))
  const bridge = bridgeWith(channel)
  const { base, auth } = await start(bridge)
  try {
    const response = await fetch(`${base}/config`, { headers: auth })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.mark, 'dsh-plugin-agent-browser/1')
    assert.equal(body.values.routing, 'auto')
    assert.deepEqual(body.values.downloads.extraBlockedExtensions, [])
    assert.deepEqual(body.values.sessions.allowlist, [])
    assert.equal(body.fields.routing, 'volatile')
    assert.equal(body.fields.limits, 'restart')
    assert.deepEqual(Object.keys(body.fields).sort(), Object.keys(CONFIG_FIELDS).sort())
  } finally {
    await bridge.close()
  }
})

test('POST /config hands a shallow patch to the editor and says whether it restarts', async () => {
  const editor = fakeEditor()
  const config = {}
  const channel = createConfigChannel(fakeCtx(editor), config, normalizeConfig(config))
  const bridge = bridgeWith(channel)
  const { base, auth } = await start(bridge)
  try {
    const live = await fetch(`${base}/config`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { routing: 'on' } }),
    })
    assert.equal(live.status, 200)
    const liveBody = await live.json()
    assert.equal(liveBody.restart, false, 'routing is volatile, so nothing reloads')
    assert.equal(editor.calls.length, 1)
    assert.deepEqual(editor.calls[0].entry, { rowId: 'agent-browser-panel' })
    assert.equal(editor.calls[0].next.routing, 'on')
    assert.equal(editor.calls[0].next.activation, 'auto', 'the rest of the row survives the patch')

    const restart = await fetch(`${base}/config`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { limits: { snapshotMaxChars: 3_000, navigationTimeoutMs: 45_000, evalMaxChars: 8_000 } } }),
    })
    assert.equal(restart.status, 200)
    assert.equal((await restart.json()).restart, true, 'limits is not volatile, so the plugin reloads')
  } finally {
    await bridge.close()
  }
})

test('POST /config refuses an empty patch and an unknown field', async () => {
  const editor = fakeEditor()
  const config = {}
  const channel = createConfigChannel(fakeCtx(editor), config, normalizeConfig(config))
  const bridge = bridgeWith(channel)
  const { base, auth } = await start(bridge)
  try {
    const empty = await fetch(`${base}/config`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: {} }),
    })
    assert.equal(empty.status, 400)
    assert.match((await empty.json()).error, /non-empty object/)

    const unknown = await fetch(`${base}/config`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { telemetry: true } }),
    })
    assert.equal(unknown.status, 400)
    assert.match((await unknown.json()).error, /unknown config fields: telemetry/)
    assert.equal(editor.calls.length, 0, 'nothing may reach the editor when the patch is refused')
  } finally {
    await bridge.close()
  }
})

test('no config editor means no channel at all', () => {
  const config = {}
  const settings = normalizeConfig(config)
  assert.equal(createConfigChannel({ get: () => undefined, fiber: { entry: {} } }, config, settings), null)
  assert.equal(createConfigChannel({ get: () => ({ edit: () => {} }) }, config, settings), null, 'a row without an entry cannot be edited')
  assert.equal(createConfigChannel({}, config, settings), null)
})

test('snapshotConfig unwraps volatile readers and copies the nested groups', () => {
  const config = {
    routing: { get: () => 'auto' },
    fitWidth: { get: () => false },
    limits: { snapshotMaxChars: 2_000 },
  }
  const values = snapshotConfig(config, normalizeConfig(config))
  assert.equal(values.routing, 'auto')
  assert.equal(values.fitWidth, false)
  assert.equal(values.limits.snapshotMaxChars, 2_000)
  assert.equal(values.limits.navigationTimeoutMs, 45_000, 'an unset field keeps its default')
  const copy = snapshotConfig(config, normalizeConfig(config))
  copy.limits.snapshotMaxChars = 1
  assert.equal(values.limits.snapshotMaxChars, 2_000, 'each snapshot is its own object')
})
