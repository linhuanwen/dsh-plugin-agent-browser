/**
 * Tests for the policy seam (TICKET-024).
 *
 * Run with: node --test plugin/test/policy-extra.test.mjs
 *
 * Every strategy the tools used to own now lives in `plugin/policy.js`. These
 * cases pin the contract the tickets promised: schemes, the eval switch, the
 * download deny list and size ceiling, character-budget clamping, the session
 * allow list, and — most importantly — that the host guard denies *before* a
 * tool body runs and never touches a tool it does not own.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyAgentBrowser } from '../apply.js'
import { AgentBrowserError } from '../errors.js'
import { createPolicy, DEFAULT_BLOCKED_EXTENSIONS, extensionOf } from '../policy.js'

/** Assert a call throws an AgentBrowserError with a given code. */
function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof AgentBrowserError, `expected AgentBrowserError, got ${error?.name ?? typeof error}`)
    assert.equal(error.code, code)
    assert.ok(error.message.startsWith(`${code}: `), `message must carry the code: ${error.message}`)
    return true
  })
}

test('checkOpen allows http(s) and refuses every other scheme', () => {
  const policy = createPolicy()
  assert.equal(policy.checkOpen('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(policy.checkOpen('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080/')
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'not a url']) {
    assertCode(() => policy.checkOpen(url), 'scheme_rejected')
  }
})

test('checkEval re-reads the live switch on every call', () => {
  let value = true
  const policy = createPolicy({ evalEnabled: { get: () => value } })
  assert.doesNotThrow(() => policy.checkEval())
  value = false
  assertCode(() => policy.checkEval(), 'eval_disabled')
  value = true
  assert.doesNotThrow(() => policy.checkEval())
  assertCode(() => createPolicy({ evalEnabled: { get: () => false } }).checkEval(), 'eval_disabled')
})

test('checkDownload refuses executables and oversized files, allows documents', () => {
  const policy = createPolicy({ downloads: { maxBytes: 1000 } })
  for (const name of ['setup.exe', 'installer.MSI', 'run.bat', 'run.cmd', 'run.ps1', 'shortcut.lnk', 'x.vbs', 'x.scr']) {
    assertCode(() => policy.checkDownload(name), 'download_rejected')
  }
  for (const name of ['paper.pdf', 'bundle.zip', 'chart.png', 'report.final.docx']) {
    assert.doesNotThrow(() => policy.checkDownload(name, 10))
  }
  assertCode(() => policy.checkDownload('big.pdf', 1001), 'download_rejected')
  // The deny list is extendable through config, and the built-in set is visible.
  assert.ok(DEFAULT_BLOCKED_EXTENSIONS.includes('.exe'))
  assert.equal(extensionOf('a/b/c.EXE'), '.exe')
  assert.equal(extensionOf('no-extension'), '')
  const extended = createPolicy({ downloads: { extraBlockedExtensions: ['iso', '.img'] } })
  assertCode(() => extended.checkDownload('disk.iso'), 'download_rejected')
  assertCode(() => extended.checkDownload('disk.img'), 'download_rejected')
  assert.doesNotThrow(() => extended.checkDownload('disk.zip'))
})

test('clampChars honours both ends of the range', () => {
  const policy = createPolicy()
  assert.equal(policy.clampChars(99_999, 4000), 4000)
  assert.equal(policy.clampChars(100, 4000), 100)
  assert.equal(policy.clampChars(5, 4000, 500), 500)
  assert.equal(policy.clampChars(1, 4000), 1)
})

test('checkSession allows everyone until an allow list exists', () => {
  assert.doesNotThrow(() => createPolicy().checkSession('s1'))
  const restricted = createPolicy({ sessions: { allowlist: ['s2'] } })
  assert.doesNotThrow(() => restricted.checkSession('s2'))
  assertCode(() => restricted.checkSession('s1'), 'session_not_allowed')
  assertCode(() => restricted.checkSession(undefined), 'session_not_allowed')
})

test('the host guard denies before the body and leaves other tools alone', async () => {
  const order = []
  let guard = null
  let bodies = 0
  const ctx = {
    logger: { debug() {} },
    get: () => undefined,
    effect(callback) {
      callback()
    },
    tools: {
      register(tool) {
        order.push(`register:${tool.name}`)
        return () => order.push(`dispose:${tool.name}`)
      },
      guard(fn) {
        order.push('guard')
        guard = fn
        return () => order.push('unguard')
      },
    },
  }
  const Bridge = class {
    constructor() {
      this.port = 1234
      this.origin = 'http://127.0.0.1:1234'
      this.token = 't'
    }
    async start() {}
    note() {}
    async close() {}
    async request() {
      throw new Error('a denied call must not reach the bridge')
    }
    takeDigest() {
      return ''
    }
  }
  const Sites = class {
    async dispose() {}
  }
  const createTools = () => [
    { name: 'browser_open', async execute() { bodies += 1 } },
    { name: 'web_search', async execute() { bodies += 1 } },
  ]
  applyAgentBrowser(ctx, { sessions: { allowlist: ['s2'] }, bridge: { port: 0 } }, { Bridge, StaticSites: Sites, createTools, logger: () => {} })

  assert.equal(typeof guard, 'function')
  const tools = createTools()
  // Mimic the host pipeline: a denial means the body is never dispatched.
  const run = async (toolName, agentId, tool = tools.find((entry) => entry.name === toolName)) => {
    const exec = { name: toolName, agent: { id: agentId } }
    const denial = guard(exec)
    if (denial !== undefined) return denial
    await tool.execute()
    return undefined
  }

  const denial = await run('browser_open', 's1')
  assert.notEqual(denial, undefined)
  assert.equal(denial.info.code, 'session_not_allowed')
  assert.ok(denial.reason.startsWith('session_not_allowed: '))
  assert.equal(bodies, 0, 'a denied browser tool must not execute')

  assert.equal(await run('browser_open', 's2'), undefined)
  assert.equal(bodies, 1, 'the allowed session runs')
  // A global guard applies to every tool in the process; the name filter keeps
  // this plugin from vetoing somebody else's tools.
  assert.equal(await run('web_search', 's1'), undefined)
  assert.equal(bodies, 2)
})
