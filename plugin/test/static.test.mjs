/**
 * Unit and integration tests for the workspace static server.
 *
 * Run with: node --test plugin/test/static.test.mjs
 *
 * The escape cases matter more than the happy path: this server is the only
 * thing standing between an `browser_open({ path })` argument and every file
 * the user can read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { resolveWithin, resolveWorkspacePath, urlForPath, StaticSites } from '../static.js'

const root = resolve(tmpdir(), 'dsh-static-test-root')

test('resolveWithin keeps a plain path inside the root', () => {
  const got = resolveWithin(root, '/demo/index.html')
  assert.ok('path' in got)
  assert.equal(got.path, join(root, 'demo', 'index.html'))
})

test('resolveWithin refuses a parent traversal', () => {
  assert.deepEqual(resolveWithin(root, '/../secret.txt'), { error: 'path_escape' })
  assert.deepEqual(resolveWithin(root, '/demo/../../secret.txt'), { error: 'path_escape' })
})

test('resolveWithin refuses percent-encoded traversal', () => {
  assert.deepEqual(resolveWithin(root, '/..%2f..%2fetc%2fpasswd'), { error: 'path_escape' })
})

test('resolveWithin refuses encoded dots', () => {
  assert.deepEqual(resolveWithin(root, '/%2e%2e/secret.txt'), { error: 'path_escape' })
})

test('resolveWithin refuses Windows separators', () => {
  assert.deepEqual(resolveWithin(root, '/..\\..\\secret.txt'), { error: 'path_escape' })
  assert.deepEqual(resolveWithin(root, '/%5c..%5csecret.txt'), { error: 'path_escape' })
})

test('resolveWithin refuses a drive-letter path', () => {
  assert.deepEqual(resolveWithin(root, '/C:/Windows/win.ini'), { error: 'path_escape' })
})

test('resolveWithin refuses a UNC prefix', () => {
  assert.deepEqual(resolveWithin(root, '//host/share/secret.txt'), { error: 'path_escape' })
})

test('resolveWithin refuses a NUL byte', () => {
  assert.deepEqual(resolveWithin(root, '/demo%00.html'), { error: 'bad_path' })
})

test('resolveWithin refuses malformed percent escapes', () => {
  assert.deepEqual(resolveWithin(root, '/%zz'), { error: 'bad_path' })
})

test('resolveWorkspacePath accepts a relative path', () => {
  assert.equal(resolveWorkspacePath(root, 'demo/index.html'), join(root, 'demo', 'index.html'))
  assert.equal(resolveWorkspacePath(root, './demo/index.html'), join(root, 'demo', 'index.html'))
  assert.equal(resolveWorkspacePath(root, '/demo/index.html'), join(root, 'demo', 'index.html'))
})

test('resolveWorkspacePath accepts an absolute path inside the root', () => {
  const inside = join(root, 'demo', 'index.html')
  assert.equal(resolveWorkspacePath(root, inside), inside)
})

test('resolveWorkspacePath refuses escapes and empty input', () => {
  assert.throws(() => resolveWorkspacePath(root, '../secret.txt'), /path_escape/)
  assert.throws(() => resolveWorkspacePath(root, 'demo/../../../secret.txt'), /path_escape/)
  assert.throws(() => resolveWorkspacePath(root, 'C:\\Windows\\win.ini'), /path_escape/)
  assert.throws(() => resolveWorkspacePath(root, ''), /path_escape/)
})

test('urlForPath encodes each segment and carries the token', () => {
  assert.equal(urlForPath('http://127.0.0.1:5000', root, 'a b/c d.html', 'tok'), 'http://127.0.0.1:5000/t/tok/a%20b/c%20d.html')
  assert.equal(urlForPath('http://127.0.0.1:5000', root, 'demo/index.html', 'tok'), 'http://127.0.0.1:5000/t/tok/demo/index.html')
  // Without a token the legacy shape is still produced, but the server refuses it.
  assert.equal(urlForPath('http://127.0.0.1:5000', root, 'demo/index.html'), 'http://127.0.0.1:5000/demo/index.html')
})

test('the server serves, reuses one port, and refuses the rest', async () => {
  const site = await mkdtemp(join(tmpdir(), 'dsh-static-serve-'))
  await mkdir(join(site, 'sub'), { recursive: true })
  await writeFile(join(site, 'index.html'), '<h1>hello</h1>')
  await writeFile(join(site, 'data.json'), '{"ok":true}')
  await writeFile(join(site, 'sub', 'index.html'), '<h1>sub</h1>')
  await writeFile(join(site, 'a.css'), 'h1 { color: red }')

  const sites = new StaticSites()
  const first = await sites.ensure(site)
  const token = first.token
  const authed = (path, init) => fetch(`${first.url}/t/${token}${path}`, init)
  try {
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(first.root, await realpathOf(site))
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)

    // Same workspace again: same origin, no second server.
    const again = await sites.ensure(site)
    assert.equal(again.url, first.url)

    // No token, no cookie: nothing is served, not even a directory listing.
    const bare = await fetch(`${first.url}/`)
    assert.equal(bare.status, 403)
    assert.equal(await bare.text(), 'forbidden\n')
    const wrong = await fetch(`${first.url}/t/not-the-token/index.html`)
    assert.equal(wrong.status, 403)

    // A document reached through the token URL is redirected to its plain path
    // and handed the HttpOnly cookie, so the token leaves the address bar.
    const page = await authed('/index.html', { redirect: 'manual' })
    assert.equal(page.status, 302)
    assert.equal(page.headers.get('location'), '/t/index.html')
    const cookie = (page.headers.get('set-cookie') ?? '').split(';')[0]
    assert.equal(cookie, `ab=${token}`)
    assert.match(page.headers.get('set-cookie') ?? '', /HttpOnly/)
    const viaCookie = await fetch(`${first.url}/t/index.html`, { headers: { cookie } })
    assert.equal(viaCookie.status, 200)
    assert.equal(await viaCookie.text(), '<h1>hello</h1>')
    assert.match(viaCookie.headers.get('content-type') ?? '', /text\/html/)
    assert.equal(viaCookie.headers.get('cache-control'), 'no-store')

    // Non-document assets are served directly and do not redirect.
    const json = await authed('/data.json')
    assert.equal(json.status, 200)
    assert.match(json.headers.get('content-type') ?? '', /application\/json/)

    // A directory resolves to its index.html.
    const sub = await authed('/sub/', { redirect: 'manual' })
    assert.equal(sub.status, 302)
    assert.equal(sub.headers.get('location'), '/t/sub/index.html')

    const head = await authed('/a.css', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-type'), 'text/css; charset=utf-8')
    assert.equal(await head.text(), '')

    const missing = await authed('/nope.html')
    assert.equal(missing.status, 404)
    assert.equal(await missing.text(), 'not found\n')

    // The refusal must not leak the host directory in the body.
    const escape = await authed('/..%2f..%2fetc%2fpasswd')
    assert.equal(escape.status, 403)
    const body = await escape.text()
    assert.equal(body, 'forbidden\n')
    assert.ok(!body.includes(site), 'the refusal body mentioned the host path')

    const posted = await authed('/index.html', { method: 'POST' })
    assert.equal(posted.status, 405)
    assert.equal(posted.headers.get('allow'), 'GET, HEAD')
  } finally {
    await sites.dispose()
    await rm(site, { recursive: true, force: true })
  }
})

async function realpathOf(path) {
  const { realpath } = await import('node:fs/promises')
  return realpath(path)
}
