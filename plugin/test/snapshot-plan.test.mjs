/**
 * Tests for the snapshot budget planner (TICKET-062).
 *
 * Run with: node --test plugin/test/snapshot-plan.test.mjs
 *
 * The planner is a pure host-side function: the page ships the whole tree, and
 * this module decides what the model actually reads — interactive lines first,
 * prose elided, repetition folded, cursor continuation when even that is not
 * enough. The tool-level tests pin the wire shape between the page answer
 * (`lines` + `stamp`) and `browser_snapshot`'s output.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSnapshot, elideNameLine, elideTextLine, TEXT_CAPS } from '../snapshot-plan.js'
import { browserSnapshotTool } from '../tools.js'

const EXEC = { agent: { id: 's1' } }

const SAVE = '  - button "保存" [ref=e12] [loc="css:#save"]'
const CANCEL = '  - button "取消" [ref=e13] [loc="css:#cancel"]'
const LINK = '  - link "帮助" [ref=e14] [loc="css:html > body:nth-of-type(1) > a:nth-of-type(2)"]'

function textLine(word, length = 150) {
  return `  - text "${`${word} `.repeat(Math.ceil(length / (word.length + 1))).slice(0, length)}"`
}

function page(extra = []) {
  return ['- page "fixture" url=http://127.0.0.1:1/', ...extra]
}

function repeatedText(count, length = 150) {
  return Array.from({ length: count }, (_, index) => textLine(`w${index}`, length))
}

test('a tree that fits the budget is delivered verbatim', () => {
  const lines = page([SAVE, CANCEL, LINK])
  const plan = planSnapshot(lines, { maxChars: 8000 })
  assert.equal(plan.text, lines.join('\n'))
  assert.equal(plan.mode, 'full')
  assert.equal(plan.truncated, false)
  assert.equal(plan.nextOffset, lines.length)
  assert.equal(plan.delivered, lines.length)
})

test('when prose does not fit, text is elided and ref lines survive intact', () => {
  const lines = page([...repeatedText(6, 160), SAVE, CANCEL, LINK])
  const plan = planSnapshot(lines, { maxChars: 900 })
  assert.equal(plan.truncated, false, 'elision should keep the whole tree in one slice')
  assert.ok(plan.text.includes(SAVE), 'the save button must survive')
  assert.ok(plan.text.includes(CANCEL), 'the cancel button must survive')
  assert.ok(plan.text.includes(LINK), 'the help link must survive')
  assert.match(plan.text, /chars elided\)/)
  assert.ok(plan.mode === 'elided' || plan.mode === 'folded')
  assert.ok(plan.textCap <= 120)
})

test('the planner picks the largest text budget that still fits the whole tree', () => {
  // One 150-char paragraph plus two buttons: verbatim (160) does not fit the
  // 300-char budget, with text elided to 120 it does.
  const lines = page([textLine('word', 150), SAVE, CANCEL])
  const plan = planSnapshot(lines, { maxChars: 280 })
  assert.equal(plan.truncated, false)
  assert.equal(plan.textCap, 120)
  assert.ok(plan.text.includes(SAVE))
  assert.ok(plan.text.length <= 340, 'elided text should fit the requested budget')
})

test('even the tightest elision can be cut, and nextOffset resumes exactly there', () => {
  const tail = '  - paragraph "最后一小段"'
  const lines = page([SAVE, CANCEL, LINK, tail, ...Array.from({ length: 6 }, () => SAVE)])
  const plan = planSnapshot(lines, { maxChars: 200 })
  assert.equal(plan.truncated, true)
  assert.ok(plan.nextOffset > 0 && plan.nextOffset < lines.length)
  assert.ok(!plan.text.includes(tail), 'the cut line must not be delivered')
  const rest = planSnapshot(lines, { maxChars: 800, from: plan.nextOffset })
  assert.equal(rest.truncated, false)
  assert.ok(!rest.text.includes(lines[0]), 'continuation must not repeat the first slice')
  assert.ok(rest.text.includes(tail), 'the continuation reaches the tail that was cut')
})

test('a huge ref line is never rewritten, even when it alone ends the slice', () => {
  const huge = `  - link "超长的名字${'x'.repeat(300)}" [ref=e15] [loc="css:${'y'.repeat(120)}"]`
  const lines = page([huge, SAVE])
  const plan = planSnapshot(lines, { maxChars: 220 })
  assert.equal(plan.truncated, true)
  assert.equal(plan.mode, 'cut')
  assert.ok(!plan.text.includes('chars elided'), 'ref lines must not be elided')
  assert.ok(!plan.text.includes('… (+'), 'no truncation marker inside ref lines')
})

test('dense pages fold long runs of plain text and point at browser_read', () => {
  const lines = page([...repeatedText(10, 120), SAVE])
  const plan = planSnapshot(lines, { maxChars: 700 })
  assert.equal(plan.truncated, false)
  assert.ok(plan.folded > 0, 'the text run should have been folded')
  assert.match(plan.text, /more text line\(s\) elided \(use browser_read for page content\)/)
  assert.ok(plan.text.includes(SAVE))
  assert.equal(plan.mode, 'folded')
})

test('starts from a raw offset for cursor continuation', () => {
  const lines = page([SAVE, CANCEL])
  const plan = planSnapshot(lines, { maxChars: 8000, from: 2 })
  assert.equal(plan.text, lines.slice(2).join('\n'))
  assert.equal(plan.nextOffset, lines.length)
  assert.equal(plan.truncated, false)
})

test('defensive: bad input does not throw', () => {
  assert.equal(planSnapshot(null).text, '')
  assert.equal(planSnapshot(undefined, { maxChars: 'nope' }).delivered, 0)
  const plan = planSnapshot(['- page "x" url=http://a/'], { maxChars: -5 })
  assert.equal(plan.text, '- page "x" url=http://a/')
})

test('planning is deterministic', () => {
  const lines = page([SAVE, CANCEL])
  assert.deepEqual(planSnapshot(lines, { maxChars: 500 }), planSnapshot(lines, { maxChars: 500 }))
})

test('elideTextLine keeps short content and marks long content', () => {
  const short = '  - text "short"'
  assert.equal(elideTextLine(short, 80), short)
  const long = `  - text "${'z'.repeat(200)}"`
  const elided = elideTextLine(long, 60)
  assert.ok(elided.length < long.length)
  assert.match(elided, /… \(\+\d+ chars elided\)"$/)
})

test('the tool plans the page lines and returns a usable cursor', async () => {
  const stamp = 'abc123'
  const buttons = Array.from({ length: 12 }, (_, index) => `  - button "按钮${index}" [ref=e${index + 1}] [loc="css:#b${index}"]`)
  const lines = page([...repeatedText(20, 160), ...buttons, SAVE, CANCEL, LINK, '  - paragraph "最后一行"'])
  const bridge = {
    calls: [],
    async request(sessionId, type, params) {
      this.calls.push({ sessionId, type, params })
      return {
        gen: 4,
        url: 'http://127.0.0.1:1/',
        title: 'fixture',
        lines,
        stamp,
        refCount: 2,
        nodeCount: lines.length,
        visited: 9,
        totalLines: lines.length,
        truncated: false,
        more: false,
        from: 0,
        nextOffset: lines.length,
        cursor: '',
        ms: 2,
      }
    },
    takeDigest: () => '',
  }
  const tool = browserSnapshotTool({}, bridge)
  const value = await tool.execute({ includeImage: false, maxChars: 6000 }, EXEC)
  assert.equal(bridge.calls[0].params.raw, true)
  assert.ok(value.text.includes(SAVE))
  assert.equal(value.cursor, '', 'a whole-tree slice carries no cursor')

  // A tighter budget cuts the tree and gives back a cursor that resumes there.
  bridge.request = async (sessionId, type, params) => {
    bridge.calls.push({ sessionId, type, params })
    return {
      gen: 4,
      url: 'http://127.0.0.1:1/',
      title: 'fixture',
      lines,
      stamp,
      refCount: 2,
      nodeCount: lines.length,
      visited: 9,
      totalLines: lines.length,
      truncated: false,
      more: false,
      from: 0,
      nextOffset: lines.length,
      cursor: '',
      ms: 2,
    }
  }
  const cut = await tool.execute({ includeImage: false, maxChars: 420 }, EXEC)
  assert.equal(cut.truncated, true)
  assert.match(cut.cursor, new RegExp(`^${stamp}@\\d+$`))
  const offset = Number.parseInt(cut.cursor.slice(cut.cursor.lastIndexOf('@') + 1), 10)
  assert.equal(cut.nextOffset, offset)

  const resumed = await tool.execute({ includeImage: false, maxChars: 9000, cursor: cut.cursor }, EXEC)
  assert.equal(bridge.calls.at(-1).params.cursor, cut.cursor)
  assert.equal(resumed.from, offset)
  assert.equal(resumed.truncated, false)
})

test('the legacy text answer still works unchanged', async () => {
  const bridge = {
    async request() {
      return {
        gen: 1,
        url: 'http://127.0.0.1:1/',
        title: 'legacy',
        text: '- page "legacy"',
        refCount: 0,
        nodeCount: 1,
        visited: 1,
        truncated: false,
        more: false,
        totalLines: 1,
        from: 0,
        nextOffset: 1,
        cursor: '',
        ms: 1,
      }
    },
    takeDigest: () => '',
  }
  const tool = browserSnapshotTool({}, bridge)
  const value = await tool.execute({ includeImage: false }, EXEC)
  assert.equal(value.text, '- page "legacy"')
  assert.equal(value.cursor, '')
  assert.equal(value.truncated, false)
})

test('text caps are ordered from most to least generous', () => {
  assert.deepEqual(TEXT_CAPS, [...TEXT_CAPS].sort((a, b) => b - a))
})

test('long prose inside a non-interactive element line is elided, refs survive', () => {
  const paragraphs = Array.from({ length: 6 }, (_, index) => {
    const body = `第${index + 1}段：${'快照预算应该先保交互节点。'.repeat(12)}`
    return `  - paragraph "${body.slice(0, 150)}"`
  })
  const lines = page([...paragraphs, SAVE, CANCEL, LINK])
  const plan = planSnapshot(lines, { maxChars: 900 })
  assert.equal(plan.truncated, false, 'eliding names should keep the whole tree in one slice')
  for (const ref of [SAVE, CANCEL, LINK]) assert.ok(plan.text.includes(ref), `${ref} must survive`)
  assert.match(plan.text, /- paragraph "[^"]*… \(\+\d+ chars elided\)/)
  assert.ok(plan.mode === 'elided' || plan.mode === 'folded')
  assert.ok(plan.textCap <= 160)
})

test('a repeated same-role prose run is folded and points at browser_read', () => {
  const rows = Array.from({ length: 10 }, (_, index) => `  - listitem "列表行 ${index} — ${'同构内容'.repeat(20)}"`)
  const lines = page([...rows, SAVE])
  const plan = planSnapshot(lines, { maxChars: 560 })
  assert.ok(plan.text.includes(SAVE), 'the actionable line must survive the fold')
  assert.match(plan.text, /- … \d+ more listitem item\(s\) elided \(use browser_read for page content\)/)
  assert.ok(plan.folded >= 4)
})

test('elided names keep the trailing states of the line', () => {
  const line = `  - listitem "${'很长的列表项文字'.repeat(20)}" selected`
  const out = elideNameLine(line, 40)
  assert.match(out, /^  - listitem "[^"]*… \(\+\d+ chars elided\)" selected$/)
  assert.equal(elideNameLine('  - button "保存" [ref=e1]', 4), '  - button "保存" [ref=e1]')
})

test('elideNameLine leaves short names and non-element lines untouched', () => {
  const short = '  - paragraph "短句"'
  assert.equal(elideNameLine(short, 40), short)
  assert.equal(elideNameLine('- note: plain text, no quotes', 4), '- note: plain text, no quotes')
  assert.equal(elideNameLine('  - button "保存" [ref=e1]', 4), '  - button "保存" [ref=e1]')
})

