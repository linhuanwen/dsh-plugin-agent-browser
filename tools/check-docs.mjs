#!/usr/bin/env node
/**
 * 文档 ↔ 代码 一致性检查（TICKET-025 §2.3）。
 *
 * 仓库没有根 package.json、没有 CI，所以这里是一个可单独运行、退出码可用的脚本：
 *   node tools/check-docs.mjs          检查并打印每项结果（有问题退出 1）
 *   node tools/check-docs.mjs --quiet  只打印问题
 *
 * 检查项：
 *   1. 用户 README 的「完整字段表」↔ plugin/index.js 的 Config 键（双向差集为空）
 *   2. 用户 README 的「十八个工具」表 ↔ plugin/tools.js 实际注册的工具名（双向差集为空）
 *   3. 用户 README 的配置示例 YAML ↔ plugin/config.js 的 DEFAULTS（结构与默认值一致）
 *   4. docs/decisions/README.md 索引 ↔ docs/decisions/NNN-*.md 文件（双向）
 *   5. 仓库 README 与用户 README 都引用 docs/design/web-tools-and-agent-browser.md（SPEC-002 B11 验收项）
 *   6. docs/design/browser-use-contract.md 里引用的仓库内 file:line 仍存在（行号超界即失败）
 *   7. plugin/inject/*.js ↔ tools/pack.mjs 的 COPY 清单（漏列 = 装机缺文件）
 *
 * 不做什么：不校验 asar 内部路径（那是宿主的代码，仓库里没有对应文件），只跳过并计数。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS } from '../plugin/config.js'
import { createTools } from '../plugin/tools.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const quiet = process.argv.includes('--quiet')
const failures = []
const notes = []

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

function fail(message) {
  failures.push(message)
}

function ok(message) {
  if (!quiet) console.log(`  ok  ${message}`)
}

// --- 1. Config: README 字段表 ↔ plugin/index.js 的 Config 键 -----------------

/** 从 plugin/index.js 的 `export const Config = z.object({…})` 里抽出点分字段名。 */
function readConfigKeys() {
  const source = read('plugin/index.js')
  const start = source.indexOf('export const Config = z.object({')
  if (start < 0) throw new Error('plugin/index.js: cannot find `export const Config = z.object({`')
  const body = source.slice(start)
  const keys = new Set()
  const topLevel = /^ {2}([a-z][A-Za-z0-9_]*): z\./gm
  let match
  while ((match = topLevel.exec(body))) keys.add(match[1])
  // 嵌套组：`  name: z.object({` … `  })`。组名不写死，新增一组（如 searchFallback）不用改这个脚本。
  const group = /^ {2}([a-z][A-Za-z0-9_]*): z\.object\(\{\n([\s\S]*?)^ {2}\}\)/gm
  const groups = new Set()
  while ((match = group.exec(body))) {
    const [, name, inner] = match
    groups.add(name)
    keys.delete(name)
    const field = /^ {4}([a-z][A-Za-z0-9_]*):/gm
    let nested
    while ((nested = field.exec(inner))) keys.add(`${name}.${nested[1]}`)
  }
  // 没有组内字段的组（理论上不存在）也保留，避免静默丢字段
  for (const name of groups) {
    if (![...keys].some((key) => key.startsWith(`${name}.`))) keys.add(name)
  }
  return keys
}

/** 抽 README 里「完整字段表」的第一列（反引号里的点分名字）。 */
function readReadmeConfigKeys() {
  const source = read('dist/dsh-plugin-agent-browser/README.md')
  const section = source.split('### 完整字段表')[1]
  if (!section) throw new Error('用户 README: cannot find `### 完整字段表`')
  // 字段表之后紧跟的下一个标题（## 或 ###）就截止，避免把别的表格（如 activation 档位表）算进来
  const body = section.split(/\n#{2,3} /)[0]
  const keys = new Set()
  for (const line of body.split('\n')) {
    const cell = /^\|\s*`([a-z][A-Za-z0-9_.]*)`\s*\|/.exec(line)
    if (cell) keys.add(cell[1])
  }
  return keys
}

function checkConfig() {
  const code = readConfigKeys()
  const docs = readReadmeConfigKeys()
  const undocumented = [...code].filter((key) => !docs.has(key))
  const invented = [...docs].filter((key) => !code.has(key))
  if (undocumented.length) fail(`配置字段：代码有、README 没写 → ${undocumented.join(', ')}`)
  if (invented.length) fail(`配置字段：README 写了、代码没有 → ${invented.join(', ')}`)
  if (!undocumented.length && !invented.length) ok(`配置字段 ${code.size} 个，README 与 plugin/index.js 双向一致`)
  return code
}

// --- 2. Tools: README 工具表 ↔ createTools() 的工具名 -----------------------

function readToolNames() {
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
  return createTools({}, bridge, sites, { activation: 'auto', fitWidth: true, evalEnabled: true }).map((tool) => tool.name)
}

function readReadmeToolNames() {
  const source = read('dist/dsh-plugin-agent-browser/README.md')
  const section = source.split('## 十八个工具')[1]
  if (!section) throw new Error('用户 README: cannot find `## 十八个工具`')
  const body = section.split('\n## ')[0]
  const names = []
  for (const line of body.split('\n')) {
    const cell = /^\|\s*`(browser_[a-z]+)`\s*\|/.exec(line)
    if (cell) names.push(cell[1])
  }
  return names
}

function checkTools() {
  const code = readToolNames()
  const docs = readReadmeToolNames()
  const missing = code.filter((name) => !docs.includes(name))
  const extra = docs.filter((name) => !code.includes(name))
  const duplicated = docs.filter((name, index) => docs.indexOf(name) !== index)
  if (missing.length) fail(`工具：代码注册了、README 没写 → ${missing.join(', ')}`)
  if (extra.length) fail(`工具：README 写了、代码没有 → ${extra.join(', ')}`)
  if (duplicated.length) fail(`工具：README 重复列出 → ${duplicated.join(', ')}`)
  if (code.length !== 18) fail(`工具：应为 18 个，实际 ${code.length} 个`)
  if (!missing.length && !extra.length && !duplicated.length && code.length === 18) {
    ok(`工具 ${code.length} 个，README 与 plugin/tools.js 双向一致`)
  }
}

// --- 3. YAML 示例 ↔ DEFAULTS ------------------------------------------------

/** 极简 YAML 子集解析：缩进映射 + 标量 + 行内数组 + 映射数组（示例模板只用这些）。 */
function parseYamlSubset(text) {
  const root = {}
  const entries = []
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    if (raw.includes('\t')) throw new Error('YAML 示例含 tab（YAML 不允许）')
    entries.push({ indent: raw.length - raw.trimStart().length, line: raw.trim() })
  }
  const stack = [{ indent: -1, value: root }]
  for (let index = 0; index < entries.length; index += 1) {
    const { indent, line } = entries[index]
    // `- key: value`：往当前数组里放一个新的映射
    const item = /^-\s+([A-Za-z][\w.-]*):\s*(.*)$/.exec(line)
    if (item) {
      while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop()
      const parent = stack[stack.length - 1].value
      if (!Array.isArray(parent)) throw new Error(`YAML 示例：列表项没有数组父级 → ${line}`)
      const entry = {}
      parent.push(entry)
      entry[item[1]] = item[2] === '' ? {} : scalar(item[2])
      stack.push({ indent, value: entry })
      continue
    }
    const match = /^([A-Za-z][\w.-]*):\s*(.*)$/.exec(line)
    if (!match) {
      if (line.startsWith('- ')) {
        const parent = stack[stack.length - 1].value
        if (!Array.isArray(parent)) throw new Error(`YAML 示例：列表项没有数组父级 → ${line}`)
        parent.push(scalar(line.slice(2)))
        continue
      }
      throw new Error(`YAML 示例：无法解析 → ${line}`)
    }
    const [, key, rest] = match
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].value
    if (rest === '') {
      // 下一行是更深的列表项 → 这里是数组；否则是映射
      const next = entries[index + 1]
      const child = next && next.indent > indent && next.line.startsWith('- ') ? [] : {}
      parent[key] = child
      stack.push({ indent, value: child })
      continue
    }
    if (rest === '[]') {
      parent[key] = []
      stack.push({ indent, value: parent[key] })
      continue
    }
    parent[key] = scalar(rest)
  }
  return root
}

function scalar(text) {
  const value = text.replace(/\s+#.*$/, '').trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^\[.*\]$/.test(value)) return value.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean).map(scalar)
  return value.replace(/^['"]|['"]$/g, '')
}

function checkYaml() {
  const source = read('dist/dsh-plugin-agent-browser/README.md')
  const block = /```yaml\n(- id: agent-browser-panel\n[\s\S]*?)```/.exec(source)
  if (!block) throw new Error('用户 README: cannot find the config YAML template')
  // 顶层是"条目数组"；包一层映射再缩进两格，让极简解析器从映射根开始
  const indented = block[1]
    .trimEnd()
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n')
  const entry = parseYamlSubset(`entries:\n${indented}`)
  const config = (entry.entries?.[0] ?? {}).config
  if (!config) throw new Error('YAML 模板里没有 config 段')
  const expected = DEFAULTS
  const missing = Object.keys(expected).filter((key) => !(key in config))
  const extra = Object.keys(config).filter((key) => !(key in expected))
  for (const key of Object.keys(expected)) {
    if (!(key in config)) continue
    const a = expected[key]
    const b = config[key]
    if (a && typeof a === 'object') {
      const nestedMissing = Object.keys(a).filter((name) => !(name in b))
      const nestedExtra = Object.keys(b).filter((name) => !(name in a))
      if (nestedMissing.length) fail(`YAML 示例：${key} 少了 ${nestedMissing.join(', ')}`)
      if (nestedExtra.length) fail(`YAML 示例：${key} 多出 ${nestedExtra.join(', ')}`)
      for (const name of Object.keys(a)) {
        if (JSON.stringify(a[name]) !== JSON.stringify(b[name])) {
          fail(`YAML 示例：${key}.${name} 默认值 ${JSON.stringify(a[name])}，示例写的是 ${JSON.stringify(b[name])}`)
        }
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      fail(`YAML 示例：${key} 默认值 ${JSON.stringify(a)}，示例写的是 ${JSON.stringify(b)}`)
    }
  }
  if (missing.length) fail(`YAML 示例：缺少顶层字段 ${missing.join(', ')}`)
  if (extra.length) fail(`YAML 示例：多出代码里没有的字段 ${extra.join(', ')}`)
  if (!failures.length || !failures.some((item) => item.startsWith('YAML'))) {
    ok(`配置示例 YAML 覆盖全部 ${Object.keys(expected).length} 个顶层字段，默认值与 plugin/config.js 一致`)
  }
}

// --- 4. decisions 索引 ------------------------------------------------------

function checkDecisions() {
  const dir = path.join(ROOT, 'docs', 'decisions')
  const files = fs.readdirSync(dir).filter((name) => /^\d{3}-.+\.md$/.test(name)).sort()
  const index = read('docs/decisions/README.md')
  const listed = new Set()
  for (const match of index.matchAll(/\]\((\d{3}-[^)]+\.md)\)/g)) listed.add(match[1])
  const unindexed = files.filter((name) => !listed.has(name))
  const dangling = [...listed].filter((name) => !files.includes(name))
  if (unindexed.length) fail(`decisions 索引：文件存在但索引没列 → ${unindexed.join(', ')}`)
  if (dangling.length) fail(`decisions 索引：索引指向不存在的文件 → ${dangling.join(', ')}`)
  if (!unindexed.length && !dangling.length) ok(`decisions 索引 ${files.length} 条，与文件一一对应`)
}

// --- 5. B11 文档被两处引用 --------------------------------------------------

function checkDocReferences() {
  const target = 'docs/design/web-tools-and-agent-browser.md'
  const repo = read('README.md')
  const user = read('dist/dsh-plugin-agent-browser/README.md')
  if (!repo.includes(target)) fail(`仓库 README 没有引用 ${target}（SPEC-002 B11 验收项）`)
  if (!user.includes(target)) fail(`用户 README 没有引用 ${target}（SPEC-002 B11 验收项）`)
  if (repo.includes(target) && user.includes(target)) ok(`B11：${target} 在仓库 README 与用户 README 都被引用`)
}

// --- 6. docs 里的 file:line 漂移 --------------------------------------------

function checkLineReferences() {
  const sources = ['docs/design/browser-use-contract.md', 'docs/design/official-docs-review.md']
  let checked = 0
  let skipped = 0
  for (const source of sources) {
    const text = read(source)
    for (const match of text.matchAll(/([A-Za-z0-9_./-]+\.(?:js|ts|mjs|cjs|json|yml|yaml|md|py|html)):(\d+)(?:-(\d+))?/g)) {
      const [, file, first, last] = match
      const absolute = path.join(ROOT, file)
      if (!fs.existsSync(absolute)) {
        skipped += 1 // asar 内部路径（宿主代码），仓库里没有对应文件
        continue
      }
      const lines = fs.readFileSync(absolute, 'utf8').split('\n').length
      const top = Number(last ?? first)
      if (top > lines) fail(`${source}: ${file}:${top} 超出文件行数（现在 ${lines} 行）`)
      checked += 1
    }
  }
  ok(`file:line 引用：仓库内 ${checked} 条仍在范围内（跳过 ${skipped} 条 asar 内部路径）`)
}

// --- 7. 注入脚本 ↔ 打包清单 ------------------------------------------------
//
// TICKET-055 的验收期事故：`plugin/inject/feedback.js` 写好了、单测也过了，
// 但 `tools/pack.mjs` 的 COPY 是显式清单，漏掉它 → 装机包里没有这个文件 →
// 宿主 `/source?name=feedback` 500 → 面板静默不画痕迹。这类「开发时能跑、
// 装机后缺文件」的回归只能在装机前用一条静态检查挡住。

function checkPackCopy() {
  const pack = read('tools/pack.mjs')
  const start = pack.indexOf('const COPY = [')
  if (start < 0) throw new Error('tools/pack.mjs: cannot find `const COPY = [`')
  const end = pack.indexOf(']', start)
  if (end < 0) throw new Error('tools/pack.mjs: COPY list is not closed')
  const listed = new Set()
  for (const match of pack.slice(start, end).matchAll(/'([^']+)'/g)) listed.add(match[1])

  const injectDir = path.join(ROOT, 'plugin/inject')
  const shipped = fs.readdirSync(injectDir).filter((name) => name.endsWith('.js'))
  const missing = shipped.filter((name) => !listed.has(`inject/${name}`))
  const extra = [...listed].filter((name) => name.startsWith('inject/') && !shipped.includes(name.slice('inject/'.length)))
  if (missing.length) fail(`打包清单：plugin/inject 里有、tools/pack.mjs COPY 没列 → ${missing.join(', ')}`)
  if (extra.length) fail(`打包清单：COPY 列了、plugin/inject 里没有 → ${extra.join(', ')}`)

  // TICKET-056: the same miss hit `timeline.js` (a host module, not an inject
  // script), so the check now also covers every top-level plugin module. Tests
  // and docs live below this level and are not shipped.
  const hostModules = fs.readdirSync(path.join(ROOT, 'plugin')).filter((name) => name.endsWith('.js'))
  const missingHost = hostModules.filter((name) => !listed.has(name))
  const extraHost = [...listed].filter((name) => !name.startsWith('inject/') && name.endsWith('.js') && !hostModules.includes(name))
  if (missingHost.length) fail(`打包清单：plugin/ 顶层模块里有、tools/pack.mjs COPY 没列 → ${missingHost.join(', ')}`)
  if (extraHost.length) fail(`打包清单：COPY 列了顶层模块、plugin/ 里没有 → ${extraHost.join(', ')}`)

  // npm pack honours `files`, so a module can be copied into dist/ and still be
  // absent from the tgz (the timeline.js incident). Pin that list too.
  const distPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/dsh-plugin-agent-browser/package.json'), 'utf8'))
  const packaged = new Set(Array.isArray(distPkg.files) ? distPkg.files : [])
  const missingFromPackage = hostModules.filter((name) => !packaged.has(name))
  if (missingFromPackage.length) {
    fail(`打包清单：dist/package.json files 没列 → ${missingFromPackage.join(', ')}（npm pack 不会带上它们）`)
  }

  if (!missing.length && !extra.length && !missingHost.length && !extraHost.length && !missingFromPackage.length) {
    ok(`打包清单：${shipped.length} 个 inject 脚本 + ${hostModules.length} 个宿主模块都已列入 COPY 与 dist/package.json files`)
  }
}

// --- 入口 -------------------------------------------------------------------

const label = (name) => `${name}: `

try {
  console.log('check-docs: 文档 ↔ 代码一致性')
  checkConfig()
  checkTools()
  checkYaml()
  checkDecisions()
  checkDocReferences()
  checkLineReferences()
  checkPackCopy()
} catch (error) {
  fail(`${label('check')}${error.message}`)
}

if (failures.length) {
  console.error('')
  for (const item of failures) console.error(`FAIL ${item}`)
  console.error('')
  console.error(`check-docs: ${failures.length} 项不一致`)
  process.exit(1)
}

if (!quiet) console.log('')
console.log('check-docs: 全部一致')
