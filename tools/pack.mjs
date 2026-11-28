#!/usr/bin/env node
/**
 * Repack the plugin from the development sources into a distributable tgz.
 *
 * Why this exists: the profile installs a *packed* package (not a link), so
 * editing `plugin/` is no longer enough. The loop is:
 *
 *   edit plugin/...  ->  node tools/pack.mjs  ->  plugin_manager install_bundle <tgz>
 *
 * Do not switch the profile back to a link install: the loader caches a
 * package's resolved path in the main process, keyed by package name, so
 * link -> package needs a DSH restart (see docs/cases/008-packaging.md §6).
 *
 * Copy list is deliberately explicit. `package.json`, `locale/`, `docs/`,
 * `icon.svg` and `README.md` are the packaged metadata and are not overwritten
 * from the dev tree (they only exist under dist/), but their presence is
 * asserted so a broken dist fails loudly here instead of at install time.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(here, '..')
const source = join(workspace, 'plugin')
const dist = join(workspace, 'dist', 'dsh-plugin-agent-browser')

/** Files that come from the dev tree, relative to both roots. */
const COPY = [
  'index.js',
  'apply.js',
  'approvals.js',
  'config.js',
  'activation.js',
  'bridge.js',
  'tools.js',
  'downloads.js',
  'static.js',
  'errors.js',
  'policy.js',
  'navigation.js',
  'search-fallback.js',
  'snapshot-plan.js',
  'client.js',
  'timeline.js',
  'cordis.patch.yml',
  'inject/snapshot.js',
  'inject/actions.js',
  'inject/detect.js',
  'inject/guards.js',
  'inject/wait.js',
  'inject/pick.js',
  'inject/feedback.js',
  'inject/read.js',
]

/** Files that live only under dist/ and must already be there. */
const REQUIRED = [
  'package.json',
  'icon.svg',
  'README.md',
  'docs/DETAIL.md',
  'docs/preview.svg',
  'locale/zh.json',
  'locale/en.json',
]

async function size(path) {
  try {
    return (await stat(path)).size
  } catch {
    return -1
  }
}

let copied = 0
for (const relative of COPY) {
  const from = join(source, relative)
  const to = join(dist, relative)
  const bytes = await size(from)
  if (bytes < 0) {
    console.error(`missing source file: ${from}`)
    process.exit(1)
  }
  await mkdir(dirname(to), { recursive: true })
  await copyFile(from, to)
  copied += 1
}

// A syntax error in a client module does not fail `npm pack`; it surfaces as an
// empty panel twenty minutes later. Check every copied .js before packing.
for (const relative of COPY.filter((name) => name.endsWith('.js'))) {
  const check = spawnSync(process.execPath, ['--check', join(dist, relative)], { encoding: 'utf8' })
  if (check.status !== 0) {
    console.error(`syntax error in ${relative}:\n${check.stderr || check.stdout}`)
    process.exit(1)
  }
}

const missing = []
for (const relative of REQUIRED) {
  if ((await size(join(dist, relative))) < 0) {
    missing.push(relative)
  }
}
if (missing.length > 0) {
  console.error(`dist is incomplete, missing: ${missing.join(', ')}`)
  process.exit(1)
}

// npm is a .cmd shim on Windows, and Node refuses to spawn .cmd without a
// shell (EINVAL since the CVE-2024-27980 fix), so go through the shell.
const pack = spawnSync('npm pack --silent', { cwd: dist, shell: true, encoding: 'utf8' })
if (pack.status !== 0) {
  console.error(pack.stderr || 'npm pack failed')
  process.exit(1)
}

const tgz = pack.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
const bytes = await size(join(dist, tgz))
if (bytes < 0) {
  console.error(`npm pack reported ${tgz} but the file is not there`)
  process.exit(1)
}

console.log(`copied ${copied} files from plugin/ into dist/`)
console.log(`${tgz}  ${bytes.toLocaleString('en-US')} bytes`)
console.log(`install with: plugin_manager install_bundle target="${join(dist, tgz)}"`)
