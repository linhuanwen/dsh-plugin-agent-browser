/**
 * TICKET-062: decide what part of a page tree the model actually reads.
 *
 * The page side (`inject/snapshot.js`) walks the DOM and hands over the whole
 * tree as an array of lines, together with a stamp that identifies that exact
 * page state. This module turns those lines into the text of one snapshot:
 *
 *   - if everything fits, ship everything;
 *   - otherwise elide the *content* of text lines and of non-interactive
 *     element lines (their quoted name is page prose — `browser_read` reads it
 *     properly). Lines that carry a `ref` or `loc`, and page/iframe headers,
 *     are never rewritten: those are what an agent clicks and types into;
 *   - pick the largest content budget that still lets the whole tree through,
 *     so a page with a long article but ten buttons keeps all ten buttons;
 *   - if even the tightest budget does not fit, cut at a line boundary and
 *     hand back `nextOffset` so the caller can continue with a cursor;
 *   - fold long runs of repeated prose/items on dense pages, pointing at
 *     `browser_read` instead of spending the whole budget on content.
 *
 * Pure function: no DOM, no I/O, no clock. The page's lines are treated as
 * opaque strings except for the handful of shapes this module understands.
 */

/** Content budgets to try, largest first. */
export const TEXT_CAPS = Object.freeze([160, 120, 80, 60, 40, 20])

/** Runs of foldable lines at least this long get folded (dense pages only). */
export const FOLD_MIN_RUN = 6

/** Minimum budget accepted by the planner, in characters. */
export const MIN_CHARS = 200

/** Lines that carry a reference the agent can act on. */
function isRefLine(line) {
  return line.includes('[ref=')
}

/** The page header: always delivered. */
function isHeaderLine(line) {
  return line.startsWith('- page ') || line.startsWith('- iframe ')
}

/** Plain text lines, the only ones the planner is allowed to rewrite. */
function isTextLine(line) {
  return /^\s*- text "/.test(line)
}

/**
 * Split an element line into `{ prefix, name, suffix }` when it has a quoted
 * name, or `null`. Handles names that themselves contain quotes by taking the
 * first and the last quote in the line.
 * @param {string} line
 * @returns {{ prefix: string, name: string, suffix: string } | null}
 */
function quotedNameOf(line) {
  const open = line.indexOf(' "')
  if (open < 0) return null
  const close = line.lastIndexOf('"')
  if (close <= open + 1) return null
  return {
    prefix: line.slice(0, open + 2),
    name: line.slice(open + 2, close),
    suffix: line.slice(close),
  }
}

/**
 * Render one text line within a content cap.
 *
 * The line looks like `- text "…"`. We keep the prefix, the leading part of
 * the quoted content, and an explicit note so the caller knows something was
 * dropped instead of silently getting a shorter quote.
 * @param {string} line
 * @param {number} cap - target content characters (the line may exceed it a little).
 * @returns {string}
 */
export function elideTextLine(line, cap) {
  const match = /^(\s*- text ")([\s\S]*)"$/.exec(line)
  if (match === null) return line
  const prefix = match[1]
  const content = match[2]
  if (content.length <= cap) return line
  const dropped = content.length - Math.max(8, cap - 24)
  const keep = Math.max(8, cap - 24)
  return `${prefix}${content.slice(0, keep)}… (+${dropped} chars elided)"`
}

/**
 * Render one non-interactive element line within a content cap. The role,
 * indentation and trailing states stay; only the quoted prose is shortened.
 * @param {string} line
 * @param {number} cap
 * @returns {string}
 */
export function elideNameLine(line, cap) {
  const parts = quotedNameOf(line)
  if (parts === null) return line
  const content = parts.name
  if (content.length <= cap) return line
  const dropped = content.length - Math.max(8, cap - 24)
  const keep = Math.max(8, cap - 24)
  return `${parts.prefix}${content.slice(0, keep)}… (+${dropped} chars elided)${parts.suffix}`
}

/** Element lines that are prose, not targets: `- paragraph "..."`. */
function isNameLine(line) {
  if (isRefLine(line) || isHeaderLine(line) || isTextLine(line)) return false
  if (/^\s*- [a-z][\w-]*:\s/.test(line)) return false
  return quotedNameOf(line) !== null
}

/** The leading `- role ` of a name line, used to fold repeated runs. */
function roleTokenOf(line) {
  const trimmed = line.replace(/^[ \t]+/, '')
  if (!trimmed.startsWith('- ')) return ''
  const rest = trimmed.slice(2)
  const quote = rest.indexOf(' "')
  if (quote <= 0) return ''
  return rest.slice(0, quote)
}

/**
 * One line as the planner sees it: raw text, kind, and a cost under a cap.
 * @param {string} line
 * @param {number} cap
 * @returns {{ raw: string, kind: 'header'|'ref'|'text'|'name'|'struct', role: string, cost: number }}
 */
function entryOf(line, cap) {
  const kind = isHeaderLine(line)
    ? 'header'
    : isRefLine(line)
      ? 'ref'
      : isTextLine(line)
        ? 'text'
        : isNameLine(line)
          ? 'name'
          : 'struct'
  const raw = kind === 'text'
    ? elideTextLine(line, cap)
    : kind === 'name'
      ? elideNameLine(line, cap)
      : line
  return { raw, kind, role: kind === 'name' ? roleTokenOf(line) : '', cost: raw.length + 1 }
}

/** Total cost of delivering every line from `from` under a given cap. */
function totalCost(lines, from, cap) {
  let sum = 0
  for (let index = from; index < lines.length; index++) {
    sum += entryOf(lines[index], cap).cost
  }
  return sum
}

/**
 * Fold long runs of foldable entries inside an already-selected window.
 *
 * A run is a maximal sequence of consecutive entries that are all prose
 * (`text`) or all the same kind of repeated item (same `role` name lines).
 * Runs shorter than `FOLD_MIN_RUN` are left alone. The replacement keeps the
 * first two and the last one, and names how many it hid.
 * @param {Array<{ raw: string, kind: string, role: string }>} entries
 * @returns {{ text: string, folded: number }}
 */
function foldRuns(entries) {
  const out = []
  let folded = 0
  let index = 0
  const runKey = (entry) => {
    if (entry.kind === 'text') return 'text'
    if (entry.kind === 'name' && entry.role !== '') return `name:${entry.role}`
    return ''
  }
  while (index < entries.length) {
    const key = runKey(entries[index])
    if (key === '') {
      out.push(entries[index].raw)
      index++
      continue
    }
    let end = index
    while (end < entries.length && runKey(entries[end]) === key) end++
    const run = entries.slice(index, end)
    if (run.length < FOLD_MIN_RUN) {
      for (const entry of run) out.push(entry.raw)
    } else {
      out.push(run[0].raw, run[1].raw)
      const hidden = run.length - 3
      const what = key === 'text' ? 'text line' : `${entries[index].role} item`
      out.push(`- … ${hidden} more ${what}(s) elided (use browser_read for page content)`)
      out.push(run[run.length - 1].raw)
      folded += hidden
    }
    index = end
  }
  return { text: out.join('\n'), folded }
}

/**
 * Plan one snapshot slice.
 *
 * @param {string[]} lines - the whole tree, in document order.
 * @param {{ maxChars?: number, from?: number }} [options]
 *   `maxChars` is the character budget for the delivered text; `from` is a raw
 *   line offset to start at (used by cursor continuation).
 * @returns {{ text: string, delivered: number, nextOffset: number, truncated: boolean,
 *   mode: 'full'|'elided'|'folded'|'cut', textCap: number, folded: number }}
 */
export function planSnapshot(lines, options = {}) {
  const rows = Array.isArray(lines) ? lines.map((line) => String(line)) : []
  const budget = Number.isFinite(options?.maxChars)
    ? Math.max(MIN_CHARS, Math.floor(options.maxChars))
    : 8000
  const start = Number.isFinite(options?.from)
    ? Math.max(0, Math.min(rows.length, Math.floor(options.from)))
    : 0

  if (rows.length === 0) {
    return { text: '', delivered: 0, nextOffset: start, truncated: false, mode: 'full', textCap: TEXT_CAPS[0], folded: 0 }
  }

  // Fast path: the whole tree fits as-is.
  if (start === 0 && totalCost(rows, 0, TEXT_CAPS[0]) <= budget) {
    return {
      text: rows.join('\n'),
      delivered: rows.length,
      nextOffset: rows.length,
      truncated: false,
      mode: 'full',
      textCap: TEXT_CAPS[0],
      folded: 0,
    }
  }

  // Try to keep the whole tree by eliding prose; largest cap that fits wins.
  // Folding repeated runs also shrinks the delivered text, so a page that is
  // mostly a long list can still fit one slice once the list is folded.
  for (const cap of TEXT_CAPS) {
    const entries = []
    for (let index = start; index < rows.length; index++) entries.push(entryOf(rows[index], cap))
    const foldedDraft = cap <= 80 ? foldRuns(entries) : null
    let used = 0
    for (const entry of entries) used += entry.cost
    if (foldedDraft !== null) used = foldedDraft.text.length
    if (start === 0 && used > budget) continue
    const elided = entries.reduce((count, entry, index) => count + (entry.raw !== rows[start + index] ? 1 : 0), 0)
    // Continuation slices still need to respect the budget; cut when needed.
    if (used > budget) {
      const kept = []
      let spent = 0
      let nextOffset = start
      let truncated = false
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index]
        if (spent + entry.cost > budget) {
          nextOffset = start + index
          truncated = true
          break
        }
        kept.push(entry)
        spent += entry.cost
        nextOffset = start + index + 1
      }
      const folded = cap <= 80 ? foldRuns(kept) : { text: kept.map((entry) => entry.raw).join('\n'), folded: 0 }
      return {
        text: folded.text,
        delivered: kept.length,
        nextOffset,
        truncated,
        mode: cap <= 80 && folded.folded > 0 ? 'folded' : 'cut',
        textCap: cap,
        folded: folded.folded,
      }
    }
    const folded = foldedDraft ?? { text: entries.map((entry) => entry.raw).join('\n'), folded: 0 }
    return {
      text: folded.text,
      delivered: entries.length,
      nextOffset: rows.length,
      truncated: false,
      mode: folded.folded > 0 ? 'folded' : elided > 0 ? 'elided' : 'full',
      textCap: cap,
      folded: folded.folded,
    }
  }

  // Even the tightest elision does not fit: deliver in order, cutting at a
  // line boundary. Ref lines are never rewritten; a single huge ref line may
  // still end the slice, which is what a cursor is for.
  const cap = TEXT_CAPS[TEXT_CAPS.length - 1]
  const kept = []
  let spent = 0
  let nextOffset = start
  for (let index = start; index < rows.length; index++) {
    const entry = entryOf(rows[index], cap)
    if (spent + entry.cost > budget) break
    kept.push(entry)
    spent += entry.cost
    nextOffset = index + 1
  }
  const folded = foldRuns(kept)
  return {
    text: folded.text,
    delivered: kept.length,
    nextOffset,
    truncated: nextOffset < rows.length,
    mode: folded.folded > 0 ? 'folded' : 'cut',
    textCap: cap,
    folded: folded.folded,
  }
}
