/**
 * Contract tests for the sixteen tool definitions.
 *
 * The host is stricter than a tool body suggests:
 *
 * - `ToolsService.register()` (dsh-tools 0.2.2-rc.5 `src/index.ts:128`) requires
 *   `output: { schema, render, presentationMeta? }` and runs
 *   `assertSupportedJsonSchema(output.schema)` before accepting a definition;
 * - the pipeline then validates every returned canonical value against that same
 *   schema (`src/pipeline.ts:547`) and turns a mismatch into `ToolOutputError`;
 * - the enforced subset (`src/json-schema.ts`) is only `type`, `oneOf`,
 *   `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`,
 *   plus the annotations `description`/`title`/`default`/`examples`. There is no
 *   `minimum`/`maximum`/`pattern`/`format`: those belong in the description and
 *   in a body-side clamp (see `clampBudget` in `tools.js`).
 *
 * These tests encode those rules locally so a definition that would fail
 * registration or output validation fails here first, without needing the
 * Electron host.
 *
 * Run with: node --test plugin/test/tooldefs.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTools, browserEvalTool, browserScreenshotTool, browserSnapshotTool } from '../tools.js'
import { AgentBrowserError } from '../errors.js'

/** Constraint keywords the host's enforced subset accepts. */
const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])
/** Annotation keywords the host ignores for validation but requires to be JSON. */
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])
const OUTPUT_NAMES = [
  'browser_open', 'browser_snapshot', 'browser_pick', 'browser_tabs', 'browser_wait', 'browser_click', 'browser_drag', 'browser_scroll', 'browser_hover', 'browser_zoom',
  'browser_screenshot', 'browser_type', 'browser_press', 'browser_upload', 'browser_eval', 'browser_download',
]

/** A JSON-lossless check: the host rejects values/schemas that do not round-trip. */
function isLosslessJson(value) {
  try {
    return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value)
  } catch {
    return false
  }
}

/** Walk one schema node and collect every rule the host would reject. */
function collectSchemaIssues(node, path, issues) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    issues.push(`${path}: must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      issues.push(`${path}: unsupported keyword "${key}"`)
    }
  }
  const type = node.type
  if (type !== undefined && !SCHEMA_TYPES.has(type)) {
    issues.push(`${path}.type: unknown type ${JSON.stringify(type)}`)
  }
  if (node.oneOf !== undefined) {
    if (type !== undefined) issues.push(`${path}: oneOf cannot be combined with type`)
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      issues.push(`${path}.oneOf: needs at least two branches`)
    } else {
      node.oneOf.forEach((branch, index) => collectSchemaIssues(branch, `${path}.oneOf[${index}]`, issues))
    }
  }
  const properties = node.properties
  if (properties !== undefined) {
    if (type !== 'object') issues.push(`${path}.properties: requires type "object"`)
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      issues.push(`${path}.properties: must be an object of schemas`)
    } else {
      for (const [name, child] of Object.entries(properties)) {
        collectSchemaIssues(child, `${path}.properties.${name}`, issues)
      }
    }
  }
  if (node.required !== undefined) {
    if (type !== 'object') issues.push(`${path}.required: requires type "object"`)
    if (!Array.isArray(node.required)) {
      issues.push(`${path}.required: must be an array of names`)
    } else {
      const seen = new Set()
      for (const name of node.required) {
        if (typeof name !== 'string' || name === '') issues.push(`${path}.required: names must be non-empty strings`)
        else if (seen.has(name)) issues.push(`${path}.required: duplicate name "${name}"`)
        else if (properties === undefined || !Object.hasOwn(properties, name)) {
          issues.push(`${path}.required: "${name}" is not declared in properties`)
        }
        seen.add(name)
      }
    }
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
    issues.push(`${path}.additionalProperties: must be a boolean`)
  }
  if (node.items !== undefined) {
    if (type !== 'array') issues.push(`${path}.items: requires type "array"`)
    collectSchemaIssues(node.items, `${path}.items`, issues)
  }
  for (const keyword of ['enum', 'const']) {
    if (node[keyword] === undefined) continue
    const values = keyword === 'enum' ? node.enum : [node.const]
    if (!Array.isArray(values) || values.length === 0) {
      issues.push(`${path}.${keyword}: must list at least one value`)
      continue
    }
    if (type !== undefined && !SCALAR_TYPES.has(type)) issues.push(`${path}.${keyword}: requires a scalar type`)
    for (const value of values) {
      if (value !== null && typeof value === 'object') issues.push(`${path}.${keyword}: values must be scalar`)
    }
  }
  for (const keyword of ['description', 'title']) {
    if (node[keyword] !== undefined && typeof node[keyword] !== 'string') {
      issues.push(`${path}.${keyword}: must be a string`)
    }
  }
  for (const keyword of ['default', 'examples']) {
    if (node[keyword] !== undefined && !isLosslessJson(node[keyword])) {
      issues.push(`${path}.${keyword}: must be lossless JSON`)
    }
  }
}

/** Fail with the full list instead of the first issue. */
function assertSupportedSchema(schema, label) {
  const issues = []
  collectSchemaIssues(schema, label, issues)
  assert.deepEqual(issues, [], `${label} would be rejected by the host:\n${issues.join('\n')}`)
}

/** A value that satisfies `required` for a schema (used only to drive `render`). */
function sampleValue(schema) {
  if (schema.oneOf !== undefined) return sampleValue(schema.oneOf[0])
  if (schema.const !== undefined) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (schema.type === 'object') {
    const value = {}
    for (const name of schema.required ?? []) value[name] = sampleValue(schema.properties?.[name] ?? {})
    return value
  }
  if (schema.type === 'array') return []
  if (schema.type === 'string') return 'x'
  if (schema.type === 'integer' || schema.type === 'number') return 1
  if (schema.type === 'boolean') return false
  return null
}

/** Build the sixteen tools against stubs: no Electron, no HTTP, no filesystem. */
function buildTools() {
  const bridge = {
    async request() {
      return { ok: true }
    },
    takeDigest() {
      return ''
    },
  }
  const sites = {
    async ensure() {
      return { url: 'http://127.0.0.1:1', root: '.', port: 1, token: 't' }
    },
  }
  const ctx = {}
  const policy = { activation: 'auto', fitWidth: true, evalEnabled: true, limits: {}, downloads: {} }
  return createTools(ctx, bridge, sites, policy)
}

test('exposes the sixteen browser tools under their documented names', () => {
  const names = buildTools().map((tool) => tool.name)
  assert.deepEqual(names, OUTPUT_NAMES)
  assert.equal(new Set(names).size, names.length)
  for (const name of names) assert.match(name, /^browser_[a-z]+$/)
})

test('every definition declares what ToolsService.register() requires', () => {
  for (const tool of buildTools()) {
    assert.ok(typeof tool.description === 'string' && tool.description.length > 40, `${tool.name}: description`)
    assert.equal(tool.parameters.type, 'object', `${tool.name}: parameters must be an object schema`)
    assert.equal(tool.parameters.additionalProperties, false, `${tool.name}: parameters must be closed`)
    assert.ok(tool.output !== null && typeof tool.output === 'object', `${tool.name}: output`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name}: output.render`)
    if (tool.output.presentationMeta !== undefined) {
      assert.equal(typeof tool.output.presentationMeta, 'function', `${tool.name}: output.presentationMeta`)
    }
    assert.equal(typeof tool.execute, 'function', `${tool.name}: execute`)
    // rc.5 validates a declaration's timeoutMs but never enforces it
    // (dsh-tools/src/index.ts:137 is the only consumer), so tools that do not set
    // it are not missing a deadline; the bridge timeout is the real budget.
    if (tool.timeoutMs !== undefined) {
      assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0, `${tool.name}: timeoutMs`)
    }
  }
})

test('parameters stay inside the host enforced schema subset', () => {
  for (const tool of buildTools()) assertSupportedSchema(tool.parameters, `${tool.name}.parameters`)
})

test('output schemas stay inside the host enforced schema subset', () => {
  for (const tool of buildTools()) assertSupportedSchema(tool.output.schema, `${tool.name}.output.schema`)
})

test('render() returns lossless content blocks for a canonical value', () => {
  for (const tool of buildTools()) {
    const value = sampleValue(tool.output.schema)
    const blocks = tool.output.render({}, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${tool.name}: render must return blocks`)
    for (const block of blocks) {
      assert.equal(typeof block, 'object', `${tool.name}: block must be an object`)
      assert.ok(block !== null && typeof block.type === 'string', `${tool.name}: block.type`)
    }
    assert.equal(blocks[0].type, 'text', `${tool.name}: first block is the human/model-facing text`)
    assert.ok(isLosslessJson(blocks), `${tool.name}: blocks must be lossless JSON`)
    // presentationMeta is optional; when declared it must be pure JSON too.
    if (tool.output.presentationMeta !== undefined) {
      assert.ok(isLosslessJson(tool.output.presentationMeta({}, value)), `${tool.name}: presentationMeta is JSON`)
    }
  }
})

test('browser_screenshot keeps the code of a structured failure', async () => {
  const gate = {
    async request() {
      throw new AgentBrowserError('cancelled', 'the caller stopped c1 before the panel finished it.')
    },
  }
  const tool = browserScreenshotTool({}, gate)
  await assert.rejects(
    () => tool.execute({}, { agent: { id: 'session-1' } }),
    (error) => {
      assert.ok(error instanceof AgentBrowserError, 'the structured error survives the step wrapper')
      assert.equal(error.code, 'cancelled')
      assert.match(error.message, /^cancelled: /)
      assert.match(error.message, /screenshot step: command/)
      assert.equal(error.details.step, 'command')
      return true
    },
  )
})

test('character budgets are clamped to their documented range', async () => {
  const seen = []
  const bridge = {
    async request(_sessionId, _type, params) {
      seen.push(params.maxChars)
      return { ok: true, url: 'https://example.com/', gen: 1, text: 'x', refCount: 0, truncated: false, serialized: 'x' }
    },
    takeDigest() {
      return ''
    },
  }
  const snapshot = browserSnapshotTool({}, bridge, { maxChars: 8000 })
  await snapshot.execute({ maxChars: 5, includeImage: false }, { agent: { id: 's1' } })
  await snapshot.execute({ maxChars: 10_000_000, includeImage: false }, { agent: { id: 's1' } })
  assert.deepEqual(seen, [500, 30_000])

  seen.length = 0
  const evalTool = browserEvalTool(bridge, { maxChars: 8000, enabled: () => true })
  await evalTool.execute({ script: '1', maxChars: 1 }, { agent: { id: 's1' } })
  await evalTool.execute({ script: '1', maxChars: 99_999 }, { agent: { id: 's1' } })
  assert.deepEqual(seen, [200, 30_000])
})
