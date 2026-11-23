// Minimal read-only Electron asar inspector.
// The DSH desktop app ships its code inside app.asar, where grep/glob cannot
// reach. This script walks the asar header index and can list or extract files.
//
//   node tools/asar.mjs ls  <asar> <substring>        list paths containing substring
//   node tools/asar.mjs cat <asar> <path-in-asar>     print one file
//   node tools/asar.mjs grep <asar> <regex> [pathSub] print matching lines
//
// Paths inside the asar use forward slashes and no leading slash,
// e.g. dsh/node_modules/@deepseek-ai/pkg/src/index.ts
import { readFileSync } from 'node:fs'

const ASAR =
  'D:\\deepseek harness\\resources\\app.asar'

/** Parse the asar header and return { index, contentOffset }. */
function open(file) {
  const buf = readFileSync(file)
  // Layout: uint32(4) | uint32(headerPickleSize) | uint32(jsonSize) | uint32(jsonSize) | json
  const jsonSize = buf.readUInt32LE(12)
  const index = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'))
  return { buf, index, contentOffset: 8 + buf.readUInt32LE(4) }
}

/** Walk the header index, yielding { path, node } for every entry. */
function* walk(node, prefix = '') {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    yield { path, node: child }
    if (child.files) yield* walk(child, path)
  }
}

function readFile(buf, contentOffset, node) {
  const start = contentOffset + Number(node.offset)
  return buf.subarray(start, start + Number(node.size))
}

const [cmd, asarPath = ASAR, arg, filter] = process.argv.slice(2)
const { buf, index, contentOffset } = open(asarPath)

if (cmd === 'ls') {
  const needle = (arg ?? '').toLowerCase()
  let shown = 0
  for (const { path, node } of walk(index)) {
    if (node.files) continue
    if (needle && !path.toLowerCase().includes(needle)) continue
    console.log(`${String(node.size).padStart(8)}  ${path}`)
    if (++shown >= 400) {
      console.log('... (stopped at 400)')
      break
    }
  }
} else if (cmd === 'cat') {
  const target = arg.replace(/^\/+/, '')
  for (const { path, node } of walk(index)) {
    if (path !== target || node.files) continue
    process.stdout.write(readFile(buf, contentOffset, node))
    process.exit(0)
  }
  console.error(`not found in asar: ${target}`)
  process.exit(1)
} else if (cmd === 'grep') {
  const needle = new RegExp(arg)
  const pathNeedle = (filter ?? '').toLowerCase()
  let hits = 0
  let files = 0
  for (const { path, node } of walk(index)) {
    if (node.files) continue
    if (pathNeedle && !path.toLowerCase().includes(pathNeedle)) continue
    if (Number(node.size) > 2_000_000) continue
    const text = readFile(buf, contentOffset, node).toString('utf8')
    const lines = text.split('\n')
    let reported = false
    for (let i = 0; i < lines.length; i++) {
      if (!needle.test(lines[i])) continue
      if (!reported) {
        console.log(`\n=== ${path}`)
        reported = true
        files++
      }
      console.log(`${String(i + 1).padStart(5)}| ${lines[i].slice(0, 240)}`)
      if (++hits >= 300) {
        console.log('... (stopped at 300 matches)')
        process.exit(0)
      }
    }
  }
  console.error(`\n${hits} matches in ${files} files`)
} else {
  console.error('usage: node tools/asar.mjs ls <asar> <substring> | cat <asar> <path> | grep <asar> <regex> [pathSub]')
  process.exit(2)
}
