// Negative self-test for tools/check-docs.mjs — proves the checks can actually fail.
// Injects one drift at a time, expects a non-zero exit, then restores the file.
import { readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const readme = join(root, 'dist', 'dsh-plugin-agent-browser', 'README.md')
const index = join(root, 'decisions', 'README.md')

const cases = [
  ['tool row renamed', readme, (s) => s.replace('| `browser_press` |', '| `browser_presz` |')],
  ['config field removed', readme, (s) => s.replace('| `limits.snapshotMaxChars` |', '| `limits.snapshotMaxCharsX` |')],
  ['yaml default changed', readme, (s) => s.replace('requestTimeoutMs: 20000', 'requestTimeoutMs: 21000')],
  ['decisions ref dropped', index, (s) => s.replace('](008-auth-dynamic-port.md)', ')(008-auth-dynamic-port.md')],
  ['b11 doc ref dropped', readme, (s) => s.replaceAll('docs/web-tools-and-agent-browser.md', 'docs/elsewhere.md')],
]

let failures = 0
for (const [name, target, mutate] of cases) {
  const original = await readFile(target, 'utf8')
  const mutated = mutate(original)
  if (mutated === original) {
    console.log(`SKIP  ${name}: mutation did not change the file`)
    failures += 1
    continue
  }
  await writeFile(target, mutated, 'utf8')
  const run = spawnSync(process.execPath, [join(here, 'check-docs.mjs'), '--quiet'], { encoding: 'utf8' })
  await writeFile(target, original, 'utf8')
  const caught = run.status !== 0
  if (!caught) failures += 1
  console.log(`${caught ? 'ok  ' : 'FAIL'}  ${name} → exit ${run.status}`)
}

const clean = spawnSync(process.execPath, [join(here, 'check-docs.mjs'), '--quiet'], { encoding: 'utf8' })
console.log(`restored clean run → exit ${clean.status}`)
process.exit(failures === 0 && clean.status === 0 ? 0 : 1)
