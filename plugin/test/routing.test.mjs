/**
 * Tests for the routing paragraph (TICKET-035).
 *
 * Run with: node --test plugin/test/routing.test.mjs
 *
 * Why this exists: on a profile that also ships `dsh-pilot`, the tool
 * descriptions added in 1.4.15 changed nothing — the model kept choosing
 * `pilot_navigate` because the `browser-pilot` skill and the user's AGENTS.md
 * both say to (measured 0/2 → 0/2, `docs/design/web-tools-and-agent-browser.md`
 * §10). A system-prompt section is assembled for every step and outranks both,
 * so the routing rule lives here. These tests pin its three modes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAgentBrowser, ROUTING_ORDER, ROUTING_SECTION, ROUTING_TEXT } from '../apply.js'

const TOOL_NAMES = ['browser_open', 'browser_snapshot']

/**
 * A host stand-in with a prompt registry and a tool inventory.
 * @param {string[]} toolNames - names `ctx.tools.definitions()` reports.
 * @param {{ withPrompt?: boolean }} [options] - drop the prompt service to test the fallback.
 * @returns {{ ctx: object, sections: object[], registered: string[] }} captured state.
 */
function fakeContext(toolNames, options = {}) {
  const sections = []
  const registered = []
  const ctx = {
    logger: { debug() {} },
    get: () => undefined,
    effect(callback) {
      callback()
    },
    tools: {
      definitions: () => toolNames.map((name) => ({ name })),
      register(tool) {
        registered.push(tool.name)
        return () => {}
      },
    },
  }
  if (options.withPrompt !== false) {
    ctx.systemPrompt = {
      section(section) {
        sections.push(section)
        return () => {}
      },
    }
  }
  return { ctx, sections, registered }
}

const fakeTools = () => TOOL_NAMES.map((name) => ({ name }))

/** Captured `/health` merges and bridge notes, so the decision can be asserted. */
const reports = []

function fakeBridge() {
  return class {
    async start() {
      return 8792
    }
    note(message, data) {
      reports.push({ kind: 'note', message, data })
    }
    setDiagnostics(fields) {
      reports.push({ kind: 'diagnostics', fields })
    }
    async close() {}
    async request() {
      throw new Error('a test must not send commands')
    }
    takeDigest() {
      return ''
    }
  }
}

function fakeSites() {
  return class {
    async dispose() {}
  }
}

function apply(ctx, config) {
  applyAgentBrowser(ctx, config, { Bridge: fakeBridge(), StaticSites: fakeSites(), createTools: fakeTools, logger: () => {} })
}

test('auto adds the paragraph only when another browser backend is loaded', () => {
  const alone = fakeContext([...TOOL_NAMES])
  apply(alone.ctx, {})
  assert.equal(alone.sections.length, 1)
  assert.equal(alone.sections[0].text(), '', 'a single-backend profile needs no rule')

  const competing = fakeContext([...TOOL_NAMES, 'pilot_navigate', 'pilot_snapshot'])
  apply(competing.ctx, {})
  assert.equal(competing.sections[0].text(), ROUTING_TEXT)

  // The panel-browser backend names a different set; detecting only `pilot_`
  // would miss it.
  const panel = fakeContext([...TOOL_NAMES, 'browser_navigate', 'browser_act'])
  apply(panel.ctx, {})
  assert.equal(panel.sections[0].text(), ROUTING_TEXT)
})

test('the section is declared where the other tool guidance lives', () => {
  const { ctx, sections } = fakeContext([...TOOL_NAMES, 'pilot_navigate'])
  apply(ctx, {})
  assert.equal(sections[0].name, ROUTING_SECTION)
  assert.equal(sections[0].order, ROUTING_ORDER)
  assert.ok(ROUTING_ORDER > 3000 && ROUTING_ORDER < 3100, 'between TOOL_COMPUTER_USE and MCP_SERVERS')
})

test('on forces the paragraph with no competitor, off silences it even with one', () => {
  const forced = fakeContext([...TOOL_NAMES])
  apply(forced.ctx, { routing: 'on' })
  assert.equal(forced.sections[0].text(), ROUTING_TEXT)

  const silenced = fakeContext([...TOOL_NAMES, 'pilot_navigate'])
  apply(silenced.ctx, { routing: 'off' })
  assert.equal(silenced.sections[0].text(), '')
})

test('an unknown mode falls back to auto', () => {
  const competing = fakeContext([...TOOL_NAMES, 'pilot_navigate'])
  apply(competing.ctx, { routing: 'definitely-not-a-mode' })
  assert.equal(competing.sections[0].text(), ROUTING_TEXT)
})

test('a host without the prompt service still applies and registers its tools', () => {
  const { ctx, registered } = fakeContext([...TOOL_NAMES], { withPrompt: false })
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.deepEqual(registered, TOOL_NAMES)
})

test('the decision is published on /health, with the names that caused it', () => {
  reports.length = 0
  const competing = fakeContext([...TOOL_NAMES, 'pilot_navigate', 'pilot_snapshot'])
  apply(competing.ctx, {})
  // Reading the paragraph is what republishes after a live change; the first
  // publish happens at registration, before any step is assembled.
  competing.sections[0].text()
  const routing = reports.filter((entry) => entry.kind === 'diagnostics')
    .map((entry) => entry.fields.routing)
    .filter(Boolean)
  assert.ok(routing.length > 0, 'the plugin must say whether the paragraph is in the prompt')
  assert.deepEqual(routing.at(-1), {
    mode: 'auto',
    injected: true,
    order: ROUTING_ORDER,
    competitors: ['pilot_navigate', 'pilot_snapshot'],
  })
  // A note per step would drown the log; the decision is published on change only.
  assert.equal(routing.length, 1)

  reports.length = 0
  const alone = fakeContext([...TOOL_NAMES])
  apply(alone.ctx, {})
  alone.sections[0].text()
  const quiet = reports.filter((entry) => entry.kind === 'diagnostics')
    .map((entry) => entry.fields.routing)
    .filter(Boolean)
  assert.equal(quiet.at(-1)?.injected, false, 'a single backend gets no paragraph')
  assert.equal(quiet.at(-1)?.competitors.length, 0)
})
