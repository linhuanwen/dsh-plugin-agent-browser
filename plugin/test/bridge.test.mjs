/**
 * Tests for `Bridge.close()` (TICKET-017) and the settle-body cap (TICKET-034).
 *
 * Run with: node --test plugin/test/bridge.test.mjs
 *
 * Unloading the plugin used to call a synchronous `dispose()`: it rejected the
 * waiting commands but returned before the socket stopped listening, and the
 * panel keeps a long-poll parked on that socket. `close()` is the replacement:
 * reject everything waiting, wake the parked poll, and bound the wait so an
 * unload can never hang.
 *
 * The settle-body tests cover a 4 MiB cap that sat just under a real map
 * screenshot (4,239,798 characters): the reply was refused, the panel's settle
 * never landed, and the tool waited out its whole budget before reporting
 * `bridge_timeout`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Bridge, BRIDGE_PREFIX, MAX_BODY_BYTES } from '../bridge.js'

function silent() {
  return new Bridge({ port: 0, logger: () => {}, timeoutMs: 30_000 })
}

test('close() rejects a command that is still waiting', async () => {
  const bridge = silent()
  const pending = bridge.request('s1', 'open', { url: 'https://example.com' }, 30_000)
  // Let the first listen settle so the command really is queued, not racing it.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const started = Date.now()
  await bridge.close()
  await assert.rejects(pending, /bridge_closed:/)
  assert.ok(Date.now() - started < 2_000, 'a waiting command must not sit out its timeout')
})

test('a request after close() fails immediately', async () => {
  const bridge = silent()
  await bridge.close()
  await assert.rejects(bridge.request('s1', 'click', {}), /bridge_closed:/)
})

test('close() is idempotent and safe before the socket ever listened', async () => {
  const bridge = silent()
  await bridge.close()
  await bridge.close()
  assert.equal(bridge.port, 0)
})

/** Start a bridge and return the base URL plus the auth header its panel would send. */
async function listening() {
  const bridge = silent()
  await bridge.start()
  return {
    bridge,
    base: `http://127.0.0.1:${bridge.port}${BRIDGE_PREFIX}`,
    auth: { authorization: `Bearer ${bridge.token}` },
  }
}

/** Queue one command and pull it, so a test has a real id to settle. */
async function pulledCommand(bridge, base, auth, type, params) {
  const pending = bridge.request('s1', type, params, 30_000)
  await new Promise((resolve) => setTimeout(resolve, 50))
  const answer = await (await fetch(`${base}/pending?wait=1000`, { headers: auth })).json()
  const id = answer.sessions?.s1?.[0]?.id
  assert.ok(typeof id === 'string', 'the command should have been handed to the panel')
  return { pending, id }
}

test('a settle body over the old 4 MiB cap is accepted (TICKET-034)', async () => {
  const { bridge, base, auth } = await listening()
  try {
    const { pending, id } = await pulledCommand(bridge, base, auth, 'screenshot', { mode: 'viewport' })
    // 4,239,798 characters is what a tile-heavy map page really produced.
    const dataUrl = `data:image/png;base64,${'A'.repeat(4_239_798)}`
    const body = JSON.stringify({ id, ok: true, result: { dataUrl } })
    assert.ok(body.length > 4 * 1024 * 1024, 'this body has to be over the old cap to prove anything')
    const res = await fetch(`${base}/settle`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body,
    })
    assert.equal(res.status, 200, 'a 4.24 M-character reply must be delivered, not refused')
    const value = await pending
    assert.equal(value.dataUrl.length, dataUrl.length)
  } finally {
    await bridge.close()
  }
})

test('a body over MAX_BODY_BYTES is refused with 413 and a readable code (TICKET-034)', async () => {
  const { bridge, base, auth } = await listening()
  try {
    const body = JSON.stringify({ id: 'nobody', ok: true, result: { pad: 'A'.repeat(MAX_BODY_BYTES) } })
    const res = await fetch(`${base}/settle`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body,
    })
    assert.equal(res.status, 413)
    const payload = await res.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'budget_exceeded')
    assert.equal(payload.limit, MAX_BODY_BYTES)
  } finally {
    await bridge.close()
  }
})

// --- first-touch permissions (SPEC-003, TICKET-037) -------------------------

/** Let the bridge see a panel for a session, so `approve()` does not fail as "never connected". */
async function panelSeen(base, auth, session = 's1') {
  await (await fetch(`${base}/pending?wait=0&session=${session}`, { headers: auth })).json()
}

/** Pull the approval frame the panel would render, if the bridge handed one out. */
async function pullApproval(base, auth, session = 's1') {
  const answer = await (await fetch(`${base}/pending?wait=1000&session=${session}`, { headers: auth })).json()
  return (answer.approvals ?? []).find((frame) => frame.session === session) ?? null
}

test('approve(): the prompt reaches the panel and "site" resolves the gate', async () => {
  const { bridge, base, auth } = await listening()
  try {
    await panelSeen(base, auth)
    const pending = bridge.approve('s1', {
      origin: 'https://example.com',
      actionClass: 'submit',
      summary: '在 example.com 点击「提交」提交表单',
      timeoutMs: 5_000,
    })
    const frame = await pullApproval(base, auth)
    assert.ok(frame !== null, 'the panel must be handed the prompt')
    assert.equal(frame.origin, 'https://example.com')
    assert.equal(frame.actionClass, 'submit')
    assert.equal(frame.summary, '在 example.com 点击「提交」提交表单')
    assert.ok(frame.issuedAt > 0 && frame.timeoutMs === 5_000)
    const res = await fetch(`${base}/decision`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: frame.id, session: 's1', decision: 'site', clientVisible: true }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await pending, { decision: 'site' })
  } finally {
    await bridge.close()
  }
})

test('approve(): a refusal becomes approval_denied, not a timeout', async () => {
  const { bridge, base, auth } = await listening()
  try {
    await panelSeen(base, auth)
    const pending = bridge.approve('s1', { origin: 'https://example.com', actionClass: 'type', timeoutMs: 5_000 })
    // Attach the assertion before answering, or the rejection lands as unhandled.
    const refused = assert.rejects(pending, /approval_denied:/)
    const frame = await pullApproval(base, auth)
    await fetch(`${base}/decision`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: frame.id, session: 's1', decision: 'deny', clientVisible: true }),
    })
    await refused
  } finally {
    await bridge.close()
  }
})

test('approve(): an invisible panel can only answer unavailable', async () => {
  const { bridge, base, auth } = await listening()
  try {
    await panelSeen(base, auth)
    const pending = bridge.approve('s1', { origin: 'https://example.com', actionClass: 'eval', timeoutMs: 5_000 })
    const refused = assert.rejects(pending, /approval_required:/)
    const frame = await pullApproval(base, auth)
    // A hidden panel cannot claim a human read the prompt, so the host turns any
    // answer from it into "unavailable" rather than consent.
    await fetch(`${base}/decision`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: frame.id, session: 's1', decision: 'once', clientVisible: false }),
    })
    await refused
  } finally {
    await bridge.close()
  }
})

test('approve(): no answer inside the budget fails as approval_timeout', async () => {
  const { bridge, base, auth } = await listening()
  try {
    await panelSeen(base, auth)
    const pending = bridge.approve('s1', { origin: 'https://example.com', actionClass: 'download', timeoutMs: 120 })
    const timedOut = assert.rejects(pending, /approval_timeout:/)
    assert.ok(await pullApproval(base, auth), 'prompt delivered, then ignored')
    await timedOut
  } finally {
    await bridge.close()
  }
})

test('approve(): a panel that never connected fails immediately as approval_required', async () => {
  const bridge = silent()
  bridge.start()
  try {
    const started = Date.now()
    await assert.rejects(bridge.approve('s1', { origin: 'https://example.com', actionClass: 'type' }), /approval_required:/)
    assert.ok(Date.now() - started < 1_000, 'a closed panel must not burn the write budget')
  } finally {
    await bridge.close()
  }
})

test('approve(): a second prompt in the same session is refused', async () => {
  const { bridge, base, auth } = await listening()
  try {
    await panelSeen(base, auth)
    const first = bridge.approve('s1', { origin: 'https://example.com', actionClass: 'type', timeoutMs: 5_000 })
    await pullApproval(base, auth)
    await assert.rejects(bridge.approve('s1', { origin: 'https://example.com', actionClass: 'submit' }), /approval_required:/)
    const frame = await pullApproval(base, auth)
    await fetch(`${base}/decision`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: frame.id, session: 's1', decision: 'once', clientVisible: true }),
    })
    assert.deepEqual(await first, { decision: 'once' })
  } finally {
    await bridge.close()
  }
})

test('a decision for an unknown or expired prompt is answered, not crashed', async () => {
  const { bridge, base, auth } = await listening()
  try {
    const res = await fetch(`${base}/decision`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a999', session: 's1', decision: 'once', clientVisible: true }),
    })
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.ok, false)
    assert.match(payload.error, /unknown or expired/)
  } finally {
    await bridge.close()
  }
})

test('taking over denies a pending prompt instead of leaving it to time out', async () => {
  const { bridge, base, auth } = await listening()
  try {
    await panelSeen(base, auth)
    const pending = bridge.approve('s1', { origin: 'https://example.com', actionClass: 'submit', timeoutMs: 30_000 })
    const refused = assert.rejects(pending, /approval_denied:/)
    await pullApproval(base, auth)
    bridge.setPhase('s1', 'taken_over', { reason: 'test' })
    await refused
  } finally {
    await bridge.close()
  }
})

test('the page address a panel reports is scoped back into /state', async () => {
  const { bridge, base, auth } = await listening()
  try {
    const res = await fetch(`${base}/page`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ session: 's1', url: 'https://example.com/inbox?q=1', title: 'Inbox' }),
    })
    assert.equal(res.status, 200)
    const payload = await res.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.page.url, 'https://example.com/inbox?q=1')
    const state = await (await fetch(`${base}/state?session=s1`, { headers: auth })).json()
    assert.equal(state.page.url, 'https://example.com/inbox?q=1')
  } finally {
    await bridge.close()
  }
})

test('approve(): a verification wall outranks the prompt', async () => {
  const { bridge, base, auth } = await listening()
  try {
    await panelSeen(base, auth)
    bridge.setPhase('s1', 'needs_human', { reason: 'human verification on screen' })
    await assert.rejects(
      bridge.approve('s1', { origin: 'https://example.com', actionClass: 'type', timeoutMs: 1_000 }),
      /needs_human:/,
    )
  } finally {
    await bridge.close()
  }
})

test('approve(): a takeover refuses the prompt', async () => {
  const { bridge, base, auth } = await listening()
  try {
    await panelSeen(base, auth)
    bridge.setPhase('s1', 'taken_over', { reason: 'user took over' })
    await assert.rejects(
      bridge.approve('s1', { origin: 'https://example.com', actionClass: 'type', timeoutMs: 1_000 }),
      /panel_taken_over:/,
    )
  } finally {
    await bridge.close()
  }
})

test('a read never takes the wheel back from the human', async () => {
  const { bridge } = await listening()
  try {
    bridge.setPhase('s1', 'needs_human', { reason: 'human verification on screen' })
    await assert.rejects(bridge.request('s1', 'inspect', { ref: 'e1' }, 150), /bridge_timeout:/)
    assert.equal(bridge.stateOf('s1').phase, 'needs_human', 'inspect is a read: it must not flip the phase')
  } finally {
    await bridge.close()
  }
})
