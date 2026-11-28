import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { browserFilesTool } from '../tools.js'

const EXEC = { agent: { id: 'agent:files' } }

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-files-'))
  await mkdir(join(root, 'screenshots'), { recursive: true })
  await mkdir(join(root, 'downloads'), { recursive: true })
  return root
}

function ctxFor(root) {
  return {
    get(name) {
      return name === 'workingDirectory' ? { ensure: async () => root } : null
    },
  }
}

async function put(root, relative, body, at) {
  const target = join(root, relative)
  await writeFile(target, body)
  if (at !== undefined) await utimes(target, at, at)
}

test('lists screenshots and downloads, newest first, with sizes and times', async () => {
  const root = await workspace()
  try {
    await put(root, 'screenshots/old.png', 'a', new Date('2026-11-28T08:00:00Z'))
    await put(root, 'downloads/report.pdf', 'b', new Date('2026-11-28T08:05:00Z'))
    await put(root, 'screenshots/new.png', 'ccc', new Date('2026-11-28T08:10:00Z'))
    const tool = browserFilesTool(ctxFor(root), { downloadDir: 'downloads' })
    const value = await tool.execute({}, EXEC)
    assert.equal(value.total, 3)
    assert.equal(value.screenshots, 2)
    assert.equal(value.downloads, 1)
    assert.deepEqual(value.files.map((file) => file.path), [
      'screenshots/new.png',
      'downloads/report.pdf',
      'screenshots/old.png',
    ])
    assert.deepEqual(value.files[0], {
      kind: 'screenshot',
      name: 'new.png',
      path: 'screenshots/new.png',
      bytes: 3,
      at: '2026-11-28T08:10:00.000Z',
    })
    assert.equal(value.files[1].kind, 'download')
    assert.ok(value.files.every((file) => file.path.includes('\\') === false), 'paths are posix-relative')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('kind narrows the list to one bucket', async () => {
  const root = await workspace()
  try {
    await put(root, 'screenshots/a.png', 'a')
    await put(root, 'downloads/a.pdf', 'b')
    const tool = browserFilesTool(ctxFor(root), { downloadDir: 'downloads' })
    const shots = await tool.execute({ kind: 'screenshot' }, EXEC)
    assert.deepEqual(shots.files.map((file) => file.kind), ['screenshot'])
    const downs = await tool.execute({ kind: 'download' }, EXEC)
    assert.deepEqual(downs.files.map((file) => file.kind), ['download'])
    assert.deepEqual(shots.dirs, ['screenshots'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('match filters on the workspace-relative path, case-insensitively', async () => {
  const root = await workspace()
  try {
    await put(root, 'screenshots/Checkout.png', 'a')
    await put(root, 'downloads/report.pdf', 'b')
    const tool = browserFilesTool(ctxFor(root), { downloadDir: 'downloads' })
    const value = await tool.execute({ match: 'check' }, EXEC)
    assert.deepEqual(value.files.map((file) => file.name), ['Checkout.png'])
    assert.equal(value.total, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('since accepts an ISO date or milliseconds', async () => {
  const root = await workspace()
  try {
    await put(root, 'screenshots/old.png', 'a', new Date('2026-11-28T08:00:00Z'))
    await put(root, 'screenshots/new.png', 'b', new Date('2026-11-28T09:00:00Z'))
    const tool = browserFilesTool(ctxFor(root), { downloadDir: 'downloads' })
    const iso = await tool.execute({ since: '2026-11-28T08:30:00Z' }, EXEC)
    assert.deepEqual(iso.files.map((file) => file.name), ['new.png'])
    const ms = await tool.execute({ since: Date.parse('2026-11-28T08:30:00Z') }, EXEC)
    assert.deepEqual(ms.files.map((file) => file.name), ['new.png'])
    await assert.rejects(tool.execute({ since: 'last tuesday' }, EXEC), /since must be an ISO date or milliseconds/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('limit clips the page but total still reports every match', async () => {
  const root = await workspace()
  try {
    for (let index = 0; index < 5; index += 1) {
      await put(root, `screenshots/s${index}.png`, 'x', new Date(Date.UTC(2026, 10, 28, 8, index)))
    }
    const tool = browserFilesTool(ctxFor(root), { downloadDir: 'downloads' })
    const value = await tool.execute({ limit: 2 }, EXEC)
    assert.equal(value.total, 5)
    assert.equal(value.files.length, 2)
    const text = tool.output.render({}, value)[0].text
    assert.match(text, /5 file\(s\) in the workspace/)
    assert.match(text, /3 older file\(s\) not shown; raise limit/)
    await assert.rejects(tool.execute({ limit: 0 }, EXEC), /limit must be an integer between 1 and 100/)
    await assert.rejects(tool.execute({ limit: 101 }, EXEC), /limit must be an integer/)
    await assert.rejects(tool.execute({ limit: 2.5 }, EXEC), /limit must be an integer/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an empty or missing directory is a normal answer, not an error', async () => {
  const root = await workspace()
  try {
    const tool = browserFilesTool(ctxFor(root), { downloadDir: 'downloads' })
    const value = await tool.execute({}, EXEC)
    assert.equal(value.total, 0)
    assert.deepEqual(value.files, [])
    const text = tool.output.render({}, value)[0].text
    assert.match(text, /No files under screenshots \/ downloads yet/)
    assert.match(text, /browser_screenshot writes screenshots\/, browser_download writes downloads\//)

    await rm(join(root, 'downloads'), { recursive: true, force: true })
    const missing = await tool.execute({ kind: 'download' }, EXEC)
    assert.equal(missing.total, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the render names kind, size and local time for every file', async () => {
  const root = await workspace()
  try {
    await put(root, 'screenshots/a.png', 'x'.repeat(2048), new Date('2026-11-28T08:40:00Z'))
    await put(root, 'downloads/b.pdf', 'y'.repeat(1024), new Date('2026-11-28T08:31:00Z'))
    const tool = browserFilesTool(ctxFor(root), { downloadDir: 'downloads' })
    const value = await tool.execute({}, EXEC)
    const text = tool.output.render({}, value)[0].text
    assert.match(text, /2 file\(s\) in the workspace, newest first \(1 screenshot\(s\), 1 download\(s\)\)\./)
    assert.match(text, /\* \[screenshot\] screenshots\/a\.png — 2\.0 KB · 2026-11-28 \d\d:40/)
    assert.match(text, /\* \[download\] downloads\/b\.pdf — 1\.0 KB · 2026-11-28 \d\d:31/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the tool is a pure read with stable metadata', () => {
  const tool = browserFilesTool(ctxFor('C:/tmp/x'), { downloadDir: 'downloads' })
  assert.equal(tool.name, 'browser_files')
  assert.equal(tool.isConcurrencySafe(), true)
  assert.deepEqual(tool.parameters.properties.kind.enum, ['all', 'screenshot', 'download'])
  assert.equal(tool.parameters.properties.limit.type, 'integer')
  assert.equal(tool.output.schema.required.includes('files'), true)
  assert.match(tool.presentCall({ kind: 'download' }).title, /downloads/)
  assert.equal(tool.presentResult({}, { total: 3 }).title, '3 file(s) in the workspace')
})
