/**
 * Tests for `browser_upload` (TICKET-047).
 *
 * Two halves, for the same reason as every other capability:
 *  - the host half decides what may leave the workspace (path containment,
 *    size limits) and asks the user before any byte is read for the page;
 *  - the page half turns base64 into `File` objects and assigns them to a
 *    real `<input type="file">` through `DataTransfer`.
 *
 * Run with: `node --test plugin/test/upload.test.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserUploadTool } from '../tools.js'

const ACTIONS_SOURCE = readFileSync(new URL('../inject/actions.js', import.meta.url), 'utf8')

/** Minimal ctx: only `workingDirectory.ensure` is used by the tool. */
function ctxFor(root) {
  return { get: (name) => (name === 'workingDirectory' ? { ensure: async () => root } : null) }
}

const EXEC = { agent: { id: 's-test' } }

const INPUT_INFO = { tag: 'input', role: 'button', name: '头像' }

/** A gate that records what the tool asked for, like `createGate` would. */
function fakeGate(overrides = {}) {
  const calls = { inspections: [], approvals: [], requests: [] }
  const gate = {
    inspect: async (sessionId, params) => {
      calls.inspections.push({ sessionId, params })
      if (overrides.inspect !== undefined) return overrides.inspect
      return { known: true, isSubmit: false, target: INPUT_INFO, url: 'https://example.com/account', addressError: '', acceptsFiles: true }
    },
    requestApproval: async (sessionId, request) => {
      calls.approvals.push({ sessionId, request })
      if (overrides.approvalError !== undefined) throw overrides.approvalError
    },
    request: async (sessionId, type, params) => {
      calls.requests.push({ sessionId, type, params })
      if (overrides.request !== undefined) return overrides.request
      return { ok: true, files: [{ name: 'hello.txt', size: 2, type: 'text/plain' }], multiple: false, url: 'https://example.com/account' }
    },
  }
  return { gate, calls }
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upload-'))
  writeFileSync(join(root, 'hello.txt'), 'hi', 'utf8')
  writeFileSync(join(root, 'notes.md'), '# notes', 'utf8')
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(2 * 1024 * 1024 + 1, 7))
  mkdirSync(join(root, 'folder'))
  writeFileSync(join(root, '..', 'outside.txt'), 'nope', 'utf8')
  return root
}

test('upload: reads a workspace file, asks once, sends base64 and metadata', async () => {
  const root = workspace()
  const { gate, calls } = fakeGate()
  const tool = browserUploadTool(ctxFor(root), gate)
  const result = await tool.execute({ loc: 'css:#avatar', files: ['hello.txt'] }, EXEC)
  assert.equal(result.effect, 'committed')
  assert.equal(result.files.length, 1)
  // The bytes really came from the file, not from a re-encoded string.
  assert.equal(Buffer.from(calls.requests[0].params.files[0].b64, 'base64').toString('utf8'), 'hi')
  assert.equal(calls.requests[0].type, 'upload')
  assert.ok(typeof calls.requests[0].params.source === 'string' && calls.requests[0].params.source.length > 0,
    'the page-side uploader source must travel with the command')
  assert.equal(calls.requests[0].params.files[0].type, 'text/plain')
  // Approval is its own class and names the file, never the path.
  assert.equal(calls.approvals.length, 1)
  assert.equal(calls.approvals[0].request.actionClass, 'upload')
  assert.equal(calls.approvals[0].request.target.files[0].name, 'hello.txt')
  assert.equal(calls.approvals[0].request.origin, 'https://example.com')
  // The prompt is asked before the command leaves the host, and only once.
  assert.equal(calls.requests[0].params.files[0].size, 2)
})

test('upload: a path outside the workspace is refused before approval', async () => {
  const root = workspace()
  const { gate, calls } = fakeGate()
  const tool = browserUploadTool(ctxFor(root), gate)
  await assert.rejects(
    tool.execute({ loc: 'css:#avatar', files: ['../outside.txt'] }, EXEC),
    (error) => error.code === 'upload_rejected' && /outside the session workspace/.test(error.message),
  )
  assert.equal(calls.approvals.length, 0)
  assert.equal(calls.requests.length, 0)
})

test('upload: missing file and directories are upload_rejected, not silent', async () => {
  const root = workspace()
  const tool = browserUploadTool(ctxFor(root), fakeGate().gate)
  await assert.rejects(
    tool.execute({ loc: 'css:#avatar', files: ['nope.txt'] }, EXEC),
    (error) => error.code === 'upload_rejected' && error.details.reason === 'not_found',
  )
  await assert.rejects(
    tool.execute({ loc: 'css:#avatar', files: ['folder'] }, EXEC),
    (error) => error.code === 'upload_rejected' && error.details.reason === 'not_a_file',
  )
})

test('upload: per-file and total size limits are enforced', async () => {
  const root = workspace()
  const tool = browserUploadTool(ctxFor(root), fakeGate().gate)
  await assert.rejects(
    tool.execute({ loc: 'css:#avatar', files: ['big.bin'] }, EXEC),
    (error) => error.code === 'upload_rejected' && error.details.reason === 'too_large',
  )
  const tooMany = Array.from({ length: 6 }, (_, index) => `hello.txt#${index}`)
  await assert.rejects(
    tool.execute({ loc: 'css:#avatar', files: tooMany }, EXEC),
    (error) => error.code === 'upload_rejected' && error.details.reason === 'too_many_files',
  )
})

test('upload: a non-file target is refused before approval', async () => {
  const root = workspace()
  const { gate, calls } = fakeGate({
    inspect: { known: true, isSubmit: false, target: { tag: 'div', role: 'div', name: '' }, url: 'https://example.com/', addressError: '', acceptsFiles: false },
  })
  const tool = browserUploadTool(ctxFor(root), gate)
  await assert.rejects(
    tool.execute({ loc: 'css:#not-a-file', files: ['hello.txt'] }, EXEC),
    (error) => error.code === 'upload_rejected' && error.details.reason === 'not_file_input',
  )
  assert.equal(calls.approvals.length, 0)
  assert.equal(calls.requests.length, 0)
})

test('upload: a single-file input refuses a list before approval', async () => {
  const root = workspace()
  const { gate, calls } = fakeGate({
    inspect: { known: true, isSubmit: false, target: INPUT_INFO, url: 'https://example.com/account', addressError: '', acceptsFiles: true, acceptsMultiple: false },
  })
  const tool = browserUploadTool(ctxFor(root), gate)
  await assert.rejects(
    tool.execute({ loc: 'css:#avatar', files: ['hello.txt', 'notes.md'] }, EXEC),
    (error) => error.code === 'upload_rejected' && error.details.reason === 'multiple_not_allowed',
  )
  assert.equal(calls.approvals.length, 0, 'a doomed list must not cost the user a prompt')
  assert.equal(calls.requests.length, 0)
})

test('upload: an unresolvable locator fails like click does, without a prompt', async () => {
  const root = workspace()
  const { gate, calls } = fakeGate({
    inspect: { known: false, isSubmit: false, target: null, url: '', addressError: 'stale_loc' },
  })
  const tool = browserUploadTool(ctxFor(root), gate)
  await assert.rejects(
    tool.execute({ loc: 'css:#gone', files: ['hello.txt'] }, EXEC),
    /no longer matches anything/,
  )
  assert.equal(calls.approvals.length, 0)
  assert.equal(calls.requests.length, 0)
})

test('upload: exactly one address and at least one file are required', async () => {
  const root = workspace()
  const tool = browserUploadTool(ctxFor(root), fakeGate().gate)
  await assert.rejects(tool.execute({ files: ['hello.txt'] }, EXEC), /exactly one of ref, loc or selector/)
  await assert.rejects(tool.execute({ loc: 'css:#avatar', ref: 'e3', files: ['hello.txt'] }, EXEC), /exactly one of ref, loc or selector/)
  await assert.rejects(tool.execute({ loc: 'css:#avatar', files: [] }, EXEC), /non-empty array/)
  await assert.rejects(tool.execute({ loc: 'css:#avatar', files: ['  '] }, EXEC), /non-empty path string/)
})

/** Page-side half: stub the DOM globals `inject/actions.js` reads. */
async function runPageUpload(params, stub) {
  const dshAction = new Function(`return (${ACTIONS_SOURCE}\n)`)()
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    DataTransfer: globalThis.DataTransfer,
    File: globalThis.File,
  }
  globalThis.document = stub.doc
  globalThis.window = stub.win
  globalThis.location = { href: 'https://example.com/upload' }
  globalThis.DataTransfer = stub.DataTransfer
  globalThis.File = stub.File
  try {
    const raw = dshAction('upload', params)
    const value = raw !== null && typeof raw.then === 'function' ? await raw : raw
    return JSON.parse(value)
  } finally {
    globalThis.document = previous.document
    globalThis.window = previous.window
    globalThis.location = previous.location
    globalThis.DataTransfer = previous.DataTransfer
    globalThis.File = previous.File
  }
}

function fileInputStub(init = {}) {
  const events = []
  const node = {
    tagName: 'INPUT',
    type: 'file',
    multiple: init.multiple === true,
    files: null,
    id: init.id ?? '',
    getAttribute: (name) => (init.attrs?.[name] ?? null),
    setAttribute: () => {},
    dispatchEvent: (event) => { events.push(event.type) },
  }
  return { node, events }
}

function uploadDom(inputNode) {
  const doc = {
    addEventListener: () => {},
    querySelector: (expression) => (expression === '#pick' ? inputNode : null),
    querySelectorAll: () => [],
    activeElement: null,
    scrollingElement: null,
    documentElement: null,
  }
  const win = { innerWidth: 1000, innerHeight: 700, getComputedStyle: () => ({}) }
  class File {
    constructor(parts, name, options = {}) {
      this.name = name
      this.type = options.type ?? ''
      this.size = parts.reduce((sum, part) => sum + part.length, 0)
      this.parts = parts
    }
  }
  class DataTransfer {
    constructor() {
      this._files = []
      this.items = { add: (file) => { this._files.push(file) } }
      this.files = { get length() { return this._files.length }, item: (i) => this._files[i], 0: undefined }
    }
  }
  return {
    doc,
    win,
    File,
    DataTransfer: class extends DataTransfer {
      constructor() {
        super()
        const files = []
        super.files = files
      }
    },
  }
}

test('upload page side: base64 becomes File objects and fires input+change', async () => {
  const { node, events } = fileInputStub()
  const stub = uploadDom(node)
  // Give the stub DataTransfer real FileList semantics: the element receives
  // `transfer.files`, so expose the collected array through a plain object.
  const original = stub.DataTransfer
  stub.DataTransfer = class {
    constructor() {
      this._files = []
      const self = this
      this.items = { add: (file) => { self._files.push(file) } }
      this.files = {
        get length() { return self._files.length },
        item: (index) => self._files[index],
      }
    }
  }
  const b64 = Buffer.from('hello', 'utf8').toString('base64')
  const result = await runPageUpload({ loc: 'css:#pick', files: [{ name: 'a.txt', type: 'text/plain', b64 }] }, stub)
  assert.equal(result.ok, true)
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].name, 'a.txt')
  assert.equal(result.files[0].size, 5)
  assert.equal(result.files[0].type, 'text/plain')
  assert.deepEqual(events, ['input', 'change'])
  assert.equal(node.files.length, 1)
  void original
})

test('upload page side: a non-file element and multiple-on-single are refusals', async () => {
  const div = { tagName: 'DIV', getAttribute: () => null, dispatchEvent: () => {} }
  const stub = uploadDom(div)
  stub.DataTransfer = class { constructor() { this.items = { add: () => {} }; this.files = [] } }
  stub.File = class { constructor() { this.name = ''; this.type = ''; this.size = 0 } }
  const b64 = Buffer.from('x').toString('base64')
  const notFile = await runPageUpload({ loc: 'css:#pick', files: [{ name: 'a.txt', b64 }] }, stub)
  assert.equal(notFile.error, 'not_file_input')

  const { node } = fileInputStub({ multiple: false })
  const single = uploadDom(node)
  single.DataTransfer = class { constructor() { this.items = { add: () => {} }; this.files = [] } }
  single.File = class { constructor() { this.name = ''; this.type = ''; this.size = 0 } }
  const two = await runPageUpload({
    loc: 'css:#pick',
    files: [{ name: 'a.txt', b64 }, { name: 'b.txt', b64 }],
  }, single)
  assert.equal(two.error, 'multiple_not_allowed')
  assert.equal(two.count, 2)
})

/* ------------------------------------------------------------------------- *
 * TICKET-060: batch shape — several file inputs, one prompt, nothing sent
 * before every address has been inspected.
 * ------------------------------------------------------------------------- */

function batchGate(options = {}) {
  const calls = { inspections: [], approvals: [], requests: [] }
  const fallback = { known: true, isSubmit: false, target: INPUT_INFO, url: 'https://example.com/apply', addressError: '', acceptsFiles: true, acceptsMultiple: true }
  const queue = Array.isArray(options.inspect) ? [...options.inspect] : []
  return {
    calls,
    gate: {
      inspect: async (sessionId, params) => {
        calls.inspections.push({ sessionId, params })
        if (queue.length > 0) return queue.shift()
        return options.inspectOne ?? fallback
      },
      requestApproval: async (sessionId, request) => {
        calls.approvals.push({ sessionId, request })
        if (options.approvalError !== undefined) throw options.approvalError
      },
      request: async (sessionId, type, params) => {
        calls.requests.push({ sessionId, type, params })
        if (options.requestError !== undefined) throw options.requestError
        return {
          ok: true,
          info: { tag: 'input', role: 'button', name: 'input' },
          files: (Array.isArray(params.files) ? params.files : []).map((file) => ({ name: file.name, size: file.size, type: file.type })),
          multiple: true,
          url: 'https://example.com/apply',
        }
      },
    },
  }
}

test('upload batch: two inputs cost one prompt and two commands, each with its own address', async () => {
  const root = workspace()
  const { gate, calls } = batchGate()
  const tool = browserUploadTool(ctxFor(root), gate)
  const result = await tool.execute({
    fields: [
      { loc: 'css:#cv', files: ['hello.txt'] },
      { loc: 'css:#photo', files: ['notes.md'] },
    ],
  }, EXEC)
  assert.equal(result.effect, 'committed')
  assert.equal(calls.inspections.length, 2)
  assert.equal(calls.approvals.length, 1, 'one prompt for the whole batch')
  assert.equal(calls.approvals[0].request.target.fields, 2)
  assert.equal(calls.approvals[0].request.target.files.length, 2)
  assert.equal(calls.requests.length, 2)
  assert.equal(calls.requests[0].params.loc, 'css:#cv')
  assert.equal(calls.requests[1].params.loc, 'css:#photo')
  assert.equal(result.files.length, 2)
  assert.equal(result.fields.length, 2)
  const text = tool.output.render({}, result)[0].text
  assert.match(text, /across 2 input\(s\)/)
})

test('upload batch: a stale address anywhere refuses the whole batch before approval', async () => {
  const root = workspace()
  const { gate, calls } = batchGate({
    inspect: [
      { known: true, target: INPUT_INFO, url: 'https://example.com/apply', addressError: '', acceptsFiles: true, acceptsMultiple: true },
      { known: false, target: null, url: '', addressError: 'stale_loc' },
    ],
  })
  const tool = browserUploadTool(ctxFor(root), gate)
  await assert.rejects(
    tool.execute({ fields: [{ loc: 'css:#cv', files: ['hello.txt'] }, { loc: 'css:#gone', files: ['notes.md'] }] }, EXEC),
    /no longer matches anything/,
  )
  assert.equal(calls.approvals.length, 0)
  assert.equal(calls.requests.length, 0)
})

test('upload batch: a non-file input refuses the batch and names the field index', async () => {
  const root = workspace()
  const { gate, calls } = batchGate({
    inspect: [
      { known: true, target: INPUT_INFO, url: 'https://example.com/apply', addressError: '', acceptsFiles: true, acceptsMultiple: true },
      { known: true, target: { tag: 'div', role: 'div', name: '' }, url: 'https://example.com/apply', addressError: '', acceptsFiles: false },
    ],
  })
  const tool = browserUploadTool(ctxFor(root), gate)
  await assert.rejects(
    tool.execute({ fields: [{ loc: 'css:#cv', files: ['hello.txt'] }, { loc: 'css:#not-a-file', files: ['notes.md'] }] }, EXEC),
    (error) => error.code === 'upload_rejected' && error.details.reason === 'not_file_input' && error.details.index === 1,
  )
  assert.equal(calls.approvals.length, 0)
  assert.equal(calls.requests.length, 0)
})

test('upload batch: field and file counts are capped before anything is read', async () => {
  const root = workspace()
  const twelve = Array.from({ length: 11 }, (_, index) => ({ loc: `css:#f${index}`, files: ['hello.txt'] }))
  await assert.rejects(
    browserUploadTool(ctxFor(root), batchGate().gate).execute({ fields: twelve }, EXEC),
    (error) => error.code === 'upload_rejected' && error.details.reason === 'too_many_fields',
  )
  const lots = Array.from({ length: 5 }, (_, index) => ({
    loc: `css:#f${index}`,
    files: ['hello.txt', 'notes.md', 'hello.txt', 'notes.md', 'hello.txt'],
  }))
  await assert.rejects(
    browserUploadTool(ctxFor(root), batchGate().gate).execute({ fields: lots }, EXEC),
    (error) => error.code === 'upload_rejected' && error.details.reason === 'too_many_files',
  )
})

test('upload batch: each entry needs its own address and files list', async () => {
  const root = workspace()
  const tool = browserUploadTool(ctxFor(root), batchGate().gate)
  await assert.rejects(tool.execute({ fields: [{ files: ['hello.txt'] }] }, EXEC), /exactly one of ref, loc or selector/)
  await assert.rejects(tool.execute({ fields: [{ loc: 'css:#cv', files: [] }] }, EXEC), /non-empty array of workspace file paths/)
  await assert.rejects(tool.execute({ fields: [] }, EXEC), /non-empty array of file inputs/)
})
