/**
 * Tests for the download path: naming, refusals, and the bytes that land on disk.
 *
 * Run with: node --test dist/dsh-plugin-agent-browser/test/downloads.test.mjs
 *
 * The refusals carry most of the value. A download tool that writes one path
 * segment outside `downloads/`, or silently replaces the previous copy of a
 * regulation, is worse than no download tool at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_BYTES,
  DownloadError,
  assertDownloadable,
  downloadTo,
  filenameFromDisposition,
  pickFilename,
  reserveTarget,
  resolveTarget,
  sanitizeFilename,
  sha256,
} from '../downloads.js'

/** A fetch stand-in: one canned response, no sockets. */
function fakeFetch({ status = 200, body = 'hello', headers = {}, url = 'https://example.com/file.pdf' } = {}) {
  return async () => new Response(body, { status, headers: { 'content-type': 'application/pdf', ...headers } })
}

/** A throwaway workspace root with a `downloads/` directory. */
async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-downloads-'))
  return root
}

test('sanitizeFilename keeps an ordinary name', () => {
  assert.equal(sanitizeFilename('2024-nian-guizhang.pdf'), '2024-nian-guizhang.pdf')
  assert.equal(sanitizeFilename('  报告 v2.docx  '), '报告 v2.docx')
})

test('sanitizeFilename replaces separators instead of honouring them', () => {
  assert.equal(sanitizeFilename('a/b\\c.pdf'), 'a_b_c.pdf')
  assert.equal(sanitizeFilename('C:/Windows/win.ini'), 'C__Windows_win.ini')
})

test('sanitizeFilename refuses traversal and empty names, and trims a trailing dot', () => {
  assert.throws(() => sanitizeFilename('../../etc/passwd'), DownloadError)
  assert.throws(() => sanitizeFilename('..'), DownloadError)
  assert.throws(() => sanitizeFilename('   '), DownloadError)
  // Windows drops a trailing dot, so `a.` must not survive as a distinct name.
  assert.equal(sanitizeFilename('a.'), 'a')
})

test('filenameFromDisposition prefers the UTF-8 form', () => {
  const header = "attachment; filename=\"fallback.pdf\"; filename*=UTF-8''%E6%B3%95%E8%A7%84.pdf"
  assert.equal(filenameFromDisposition(header), '法规.pdf')
})

test('filenameFromDisposition falls back to the quoted form', () => {
  assert.equal(filenameFromDisposition('attachment; filename="report.pdf"'), 'report.pdf')
  assert.equal(filenameFromDisposition(''), undefined)
  assert.equal(filenameFromDisposition(null), undefined)
})

test('filenameFromDisposition decodes a percent-encoded plain form', () => {
  // samr.gov.cn sends `filename=%E5%85%AC...pdf` instead of the RFC 5987 form.
  const header = 'attachment;filename=%E5%85%AC%E5%B9%B3%E7%AB%9E%E4%BA%89%E5%AE%A1%E6%9F%A5%E6%9D%A1%E4%BE%8B%E5%AE%9E%E6%96%BD%E5%8A%9E%E6%B3%95.pdf'
  assert.equal(filenameFromDisposition(header), '公平竞争审查条例实施办法.pdf')
  // A percent sign that is not a valid escape is part of the name, not an error.
  assert.equal(filenameFromDisposition('attachment; filename="100%.pdf"'), '100%.pdf')
})

test('pickFilename prefers the requested name, then the header, then the url', () => {
  const base = { url: 'https://example.com/dir/from-url.pdf', contentType: 'application/pdf' }
  assert.equal(pickFilename({ ...base, wanted: 'mine.pdf' }), 'mine.pdf')
  assert.equal(pickFilename({ ...base, disposition: 'attachment; filename="from-header.pdf"' }), 'from-header.pdf')
  assert.equal(pickFilename(base), 'from-url.pdf')
})

test('pickFilename falls back to a timestamp and adds an extension from the mime', () => {
  // A query string hides the real name, but the last path segment is still real.
  assert.equal(pickFilename({ url: 'https://example.com/download?id=7', contentType: 'application/pdf', timestamp: 1700 }), 'download.pdf')
  // Nothing usable in the url at all: only then does the timestamp name win.
  assert.equal(pickFilename({ url: 'https://example.com/', contentType: 'application/pdf', timestamp: 1700 }), 'download-1700.pdf')
  assert.equal(pickFilename({ url: 'https://example.com/att', contentType: 'application/msword', timestamp: 1 }), 'att.doc')
})

test('assertDownloadable refuses non-http schemes', () => {
  assert.throws(() => assertDownloadable('file:///C:/Windows/win.ini'), (error) => error.stage === 'validate' && /only http\(s\)/.test(error.message))
  assert.throws(() => assertDownloadable('ftp://example.com/a.pdf'), (error) => error.stage === 'validate')
})

test('assertDownloadable refuses this machine unless a test opts in', () => {
  assert.throws(() => assertDownloadable('http://127.0.0.1:8792/logs'), (error) => error.stage === 'validate')
  assert.throws(() => assertDownloadable('http://localhost/x.pdf'), (error) => error.stage === 'validate')
  assert.ok(assertDownloadable('http://127.0.0.1/x.pdf', { allowLocal: true }) instanceof URL)
})

test('resolveTarget refuses a name with a directory part', () => {
  const dir = join(tmpdir(), 'dsh-downloads-target')
  assert.throws(() => resolveTarget(dir, '../escape.pdf'), DownloadError)
  assert.throws(() => resolveTarget(dir, 'sub/file.pdf'), DownloadError)
  assert.equal(resolveTarget(dir, 'ok.pdf'), join(dir, 'ok.pdf'))
})

test('reserveTarget never hands out the same name twice', async () => {
  const root = await makeRoot()
  const dir = await import('../downloads.js').then((module) => module.ensureDownloadsDir(root))
  try {
    assert.equal(await reserveTarget(dir, 'a.pdf'), join(dir, 'a.pdf'))
    assert.equal(await reserveTarget(dir, 'a.pdf'), join(dir, 'a-1.pdf'))
    assert.equal(await reserveTarget(dir, 'a.pdf'), join(dir, 'a-2.pdf'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('downloadTo writes the body and reports a matching sha256', async () => {
  const root = await makeRoot()
  try {
    const body = '%PDF-1.4 fake regulation'
    const value = await downloadTo(root, { url: 'https://example.com/x.pdf', allowLocal: true, fetchImpl: fakeFetch({ body, headers: { 'content-disposition': 'attachment; filename="guizhang.pdf"' } }) })
    assert.equal(value.path, 'downloads/guizhang.pdf')
    assert.equal(value.bytes, Buffer.byteLength(body))
    assert.equal(value.mime, 'application/pdf')
    const onDisk = await readFile(join(root, 'downloads', 'guizhang.pdf'))
    assert.equal(onDisk.toString(), body)
    assert.equal(value.sha256, createHash('sha256').update(onDisk).digest('hex'))
    assert.equal(sha256(onDisk), value.sha256)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a second download of the same url does not replace the first file', async () => {
  const root = await makeRoot()
  try {
    const fetchImpl = fakeFetch({ body: 'v1' })
    const first = await downloadTo(root, { url: 'https://example.com/r.pdf', allowLocal: true, fetchImpl })
    const second = await downloadTo(root, { url: 'https://example.com/r.pdf', allowLocal: true, fetchImpl })
    assert.equal(first.path, 'downloads/r.pdf')
    assert.equal(second.path, 'downloads/r-1.pdf')
    const files = await readdir(join(root, 'downloads'))
    assert.deepEqual(files.sort(), ['r-1.pdf', 'r.pdf'])
    assert.equal(await readFile(join(root, 'downloads', 'r.pdf'), 'utf8'), 'v1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a declared size over the limit fails before any bytes are kept', async () => {
  const root = await makeRoot()
  try {
    await assert.rejects(
      downloadTo(root, { url: 'https://example.com/big.zip', allowLocal: true, fetchImpl: fakeFetch({ headers: { 'content-length': String(MAX_BYTES + 1) } }) }),
      (error) => error.stage === 'too_large',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a 404 is reported as the http stage, with the status', async () => {
  const root = await makeRoot()
  try {
    await assert.rejects(
      downloadTo(root, { url: 'https://example.com/missing.pdf', allowLocal: true, fetchImpl: fakeFetch({ status: 404, body: 'nope' }) }),
      (error) => error.stage === 'http' && error.status === 404,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an html page where a pdf was expected fails instead of being saved', async () => {
  const root = await makeRoot()
  try {
    await assert.rejects(
      downloadTo(root, {
        url: 'https://example.com/guizhang.pdf',
        allowLocal: true,
        fetchImpl: fakeFetch({ body: '<html>login</html>', headers: { 'content-type': 'text/html; charset=utf-8' } }),
      }),
      (error) => error.stage === 'http' && /HTML page instead of/.test(error.message),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a connection failure is the connect stage, not http', async () => {
  const root = await makeRoot()
  try {
    await assert.rejects(
      downloadTo(root, { url: 'https://example.com/a.pdf', allowLocal: true, fetchImpl: async () => { throw new Error('ECONNREFUSED') } }),
      (error) => error.stage === 'connect' && /ECONNREFUSED/.test(error.message),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
