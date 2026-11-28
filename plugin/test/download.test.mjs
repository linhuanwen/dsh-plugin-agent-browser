/**
 * Tests for `browser_download` (TICKET-023 / TICKET-061).
 *
 * The host fetches; no panel and no page are involved, so the whole tool is
 * tested here: the single-url shape, the batch shape added by TICKET-061 (one
 * prompt, whole list validated before it, per-item results), and the honesty
 * rule that a failure never hides the files that did arrive.
 *
 * Run with: `node --test plugin/test/download.test.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserDownloadTool } from '../tools.js'
import { DownloadError } from '../downloads.js'
import { AgentBrowserError } from '../errors.js'

/** Minimal ctx: only `workingDirectory.ensure` is used by the tool. */
function ctxFor(root) {
  return { get: (name) => (name === 'workingDirectory' ? { ensure: async () => root } : null) }
}

const EXEC = { agent: { id: 's-test' } }

function workspace() {
  return mkdtempSync(join(tmpdir(), 'dsh-download-'))
}

/** A gate that records the permission request the tool made. */
function fakeGate() {
  const calls = { approvals: [] }
  return {
    calls,
    gate: {
      requestApproval: async (sessionId, request) => {
        calls.approvals.push({ sessionId, request })
      },
    },
  }
}

/**
 * A `downloadTo` seam that answers from a table and records the calls.
 * Each entry is either a result object or an Error to throw.
 */
function fakeDownloader(answers) {
  const calls = []
  const download = async (root, options) => {
    calls.push({ root, options })
    const answer = answers[calls.length - 1]
    if (answer instanceof Error) throw answer
    return answer ?? { path: 'downloads/file.bin', bytes: 3, sha256: 'abc', mime: 'application/octet-stream', finalUrl: options.url }
  }
  return { calls, download }
}

const OK_ONE = { path: 'downloads/a.pdf', bytes: 10, sha256: 'aaa', mime: 'application/pdf', finalUrl: 'https://example.com/a.pdf' }
const OK_TWO = { path: 'downloads/b.pdf', bytes: 20, sha256: 'bbb', mime: 'application/pdf', finalUrl: 'https://example.com/b.pdf' }

test('download: one url, one prompt, committed result keeps the old shape', async () => {
  const root = workspace()
  const { gate, calls: approvals } = fakeGate()
  const { calls, download } = fakeDownloader([OK_ONE])
  const tool = browserDownloadTool(ctxFor(root), gate, { downloadTo: download })
  const result = await tool.execute({ url: 'https://example.com/a.pdf' }, EXEC)
  assert.equal(result.effect, 'committed')
  assert.equal(result.path, 'downloads/a.pdf')
  assert.equal(result.bytes, 10)
  assert.equal(result.sha256, 'aaa')
  assert.equal(result.url, undefined, 'the single shape does not repeat the url')
  assert.equal(approvals.approvals.length, 1)
  assert.equal(approvals.approvals[0].request.actionClass, 'download')
  assert.equal(approvals.approvals[0].request.target, undefined, 'a single file needs no count')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.dir, 'downloads')
})

test('download batch: two urls, one prompt with the count, both files listed', async () => {
  const root = workspace()
  const { gate, calls: approvals } = fakeGate()
  const { calls, download } = fakeDownloader([OK_ONE, OK_TWO])
  const tool = browserDownloadTool(ctxFor(root), gate, { downloadTo: download })
  const result = await tool.execute({
    urls: [{ url: 'https://example.com/a.pdf', filename: 'a.pdf' }, 'https://example.com/b.pdf'],
  }, EXEC)
  assert.equal(result.effect, 'committed')
  assert.equal(result.files.length, 2)
  assert.equal(result.files[1].path, 'downloads/b.pdf')
  assert.equal(result.failures.length, 0)
  assert.equal(approvals.approvals.length, 1, 'one prompt for the batch')
  assert.equal(approvals.approvals[0].request.target.count, 2)
  assert.deepEqual(approvals.approvals[0].request.target.urls, ['https://example.com/a.pdf', 'https://example.com/b.pdf'])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].options.filename, 'a.pdf')
  assert.equal(calls[1].options.filename, undefined)
  const text = tool.output.render({}, result)[0].text
  assert.match(text, /Saved 2 of 2 file\(s\)/)
})

test('download batch: one failure does not hide the file that arrived', async () => {
  const root = workspace()
  const { gate } = fakeGate()
  const { download } = fakeDownloader([OK_ONE, new DownloadError('http', 'the server answered 404 Not Found')])
  const tool = browserDownloadTool(ctxFor(root), gate, { downloadTo: download })
  const result = await tool.execute({
    urls: ['https://example.com/a.pdf', 'https://example.com/missing.pdf'],
  }, EXEC)
  assert.equal(result.effect, 'committed')
  assert.equal(result.files.length, 1)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].stage, 'http')
  assert.equal(result.failures[0].url, 'https://example.com/missing.pdf')
  const text = tool.output.render({}, result)[0].text
  assert.match(text, /Saved 1 of 2 file\(s\)/)
  assert.match(text, /Failed:/)
  assert.match(text, /http: the server answered 404/)
})

test('download batch: nothing arrived means download_failed and effect none', async () => {
  const root = workspace()
  const { gate } = fakeGate()
  const { download } = fakeDownloader([
    new DownloadError('connect', 'could not reach example.com'),
    new DownloadError('http', 'the server answered 500'),
  ])
  const tool = browserDownloadTool(ctxFor(root), gate, { downloadTo: download })
  const result = await tool.execute({
    urls: ['https://example.com/a.pdf', 'https://example.com/b.pdf'],
  }, EXEC)
  assert.equal(result.effect, 'none')
  assert.equal(result.download_failed.stage, 'connect')
  assert.equal(result.failures.length, 2)
  assert.equal(result.path, undefined)
})

test('download batch: a bad url refuses the whole list before the prompt', async () => {
  const root = workspace()
  const { gate, calls: approvals } = fakeGate()
  const { calls, download } = fakeDownloader([OK_ONE])
  const tool = browserDownloadTool(ctxFor(root), gate, { downloadTo: download })
  const result = await tool.execute({
    urls: ['ftp://example.com/a.pdf', 'https://example.com/b.pdf'],
  }, EXEC)
  assert.equal(result.effect, 'none')
  assert.equal(result.download_failed.stage, 'validate')
  assert.equal(result.download_failed.url, 'ftp://example.com/a.pdf', 'the failing url is the one named')
  assert.equal(result.failures.length, 2, 'the whole list is reported as not attempted')
  assert.match(result.failures[0].reason, /ftp/i)
  assert.match(result.failures[1].reason, /not attempted/)
  const text = tool.output.render({}, result)[0].text
  assert.match(text, /Nothing was downloaded: the batch was refused before any transfer/)
  assert.equal(approvals.approvals.length, 0, 'a doomed batch must not cost a prompt')
  assert.equal(calls.length, 0)
})

test('download batch: loopback urls are refused by the same pre-check', async () => {
  const root = workspace()
  const { gate, calls: approvals } = fakeGate()
  const { download } = fakeDownloader([OK_ONE])
  const tool = browserDownloadTool(ctxFor(root), gate, { downloadTo: download })
  const result = await tool.execute({ urls: ['http://127.0.0.1:8080/secret.pdf'] }, EXEC)
  assert.equal(result.effect, 'none')
  assert.equal(result.download_failed.stage, 'validate')
  assert.equal(approvals.approvals.length, 0)
})

test('download batch: a policy refusal is reported per item', async () => {
  const root = workspace()
  const { gate } = fakeGate()
  const { download } = fakeDownloader([new AgentBrowserError('download_rejected', 'blocked extension'), OK_ONE])
  const tool = browserDownloadTool(ctxFor(root), gate, { downloadTo: download })
  const result = await tool.execute({
    urls: ['https://example.com/a.exe', 'https://example.com/a.pdf'],
  }, EXEC)
  assert.equal(result.files.length, 1)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].stage, 'policy')
})

test('download batch: counts and shapes are validated before anything runs', async () => {
  const root = workspace()
  const { gate, calls: approvals } = fakeGate()
  const { download } = fakeDownloader([OK_ONE])
  const tool = browserDownloadTool(ctxFor(root), gate, { downloadTo: download })
  const eleven = Array.from({ length: 11 }, (_, index) => `https://example.com/${index}.pdf`)
  await assert.rejects(tool.execute({ urls: eleven }, EXEC), /at most 10 urls/)
  await assert.rejects(tool.execute({ urls: [] }, EXEC), /non-empty array of downloads/)
  await assert.rejects(tool.execute({ urls: [{ filename: 'x.pdf' }] }, EXEC), /must carry a non-empty URL string/)
  await assert.rejects(tool.execute({}, EXEC), /url is required/)
  assert.equal(approvals.approvals.length, 0)
})
