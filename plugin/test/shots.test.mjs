/**
 * Screenshot file naming.
 *
 * The panel does the pixels; the host does the path. These cases cover the part
 * that touches the disk: a name that cannot leave `screenshots/`, and a name
 * that never replaces a file the user already has.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeBase64, sha256Hex, shotName, uniquePath } from '../tools.js'

test('sha256Hex matches the known digest of empty and non-empty input', async () => {
  assert.equal(await sha256Hex(new Uint8Array(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(
    await sha256Hex(new TextEncoder().encode('hello world')),
    'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  )
})

test('decodeBase64 matches Buffer for the payloads a PNG produces', () => {
  const samples = ['', 'QQ==', 'QUJD', 'aGVsbG8gd29ybGQ=', 'AAECAwQFBgcI']
  for (const sample of samples) {
    assert.deepEqual([...decodeBase64(sample)], [...Buffer.from(sample, 'base64')], sample)
  }
  const bytes = new Uint8Array(1024)
  for (let at = 0; at < bytes.length; at += 1) bytes[at] = (at * 37) % 256
  const encoded = Buffer.from(bytes).toString('base64')
  assert.deepEqual([...decodeBase64(encoded)], [...bytes])
})

test('decodeBase64 ignores line breaks, a data-url comma and stray spaces', () => {
  assert.deepEqual([...decodeBase64('aGVs\nbG8g d29y\tbGQ=')], [...Buffer.from('hello world')])
})

test('shotName keeps the basename and forces .png', () => {
  assert.equal(shotName('list.png'), 'list.png')
  assert.equal(shotName('list'), 'list.png')
  assert.equal(shotName('reports/list.PNG'), 'list.png')
})

test('shotName cannot climb out of the directory', () => {
  assert.equal(shotName('../../etc/passwd'), 'passwd.png')
  assert.equal(shotName('..\\..\\win.ini'), 'win.ini.png')
  assert.equal(shotName('/abs/path/图.png'), '图.png')
})

test('shotName cleans what a filesystem would refuse', () => {
  assert.equal(shotName('a b:c*d?e.png'), 'a-b_c_d_e.png')
  assert.equal(shotName('.hidden.png'), 'hidden.png')
  assert.equal(shotName('   '), shotName(''))
})

test('shotName falls back to a timestamp', () => {
  const name = shotName('')
  assert.match(name, /^shot-\d{8}-\d{6}\.png$/)
})

test('uniquePath never replaces an existing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shots-'))
  try {
    const first = await uniquePath(dir, 'a.png')
    const second = await uniquePath(dir, 'a.png')
    const third = await uniquePath(dir, 'a.png')
    assert.notEqual(first, second)
    assert.notEqual(second, third)
    assert.match(second, /a-1\.png$/)
    assert.match(third, /a-2\.png$/)
    // The reservation is the file itself, so a later write goes into place.
    await writeFile(second, 'x')
    assert.equal(second, join(dir, 'a-1.png'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
