/**
 * An in-memory, session-scoped log of tool calls, kept by the host half.
 *
 * TICKET-056. The panel already shows the page; what it cannot show is "what
 * happened a minute ago" - which tool ran, whether it took effect, which error
 * code came back, and where a screenshot went. This recorder is filled by the
 * one wrapper in `createTools` and read by two consumers:
 *
 *  - `browser_timeline` (the 17th tool): lets the model re-read its recent
 *    actions, even after a compaction or when the panel is closed;
 *  - `GET /timeline` on the bridge: lets the panel draw a small "recent actions"
 *    strip for the human.
 *
 * Deliberately plain data, no I/O, no persistence: the record describes calls
 * that already happened, so a full buffer simply drops the oldest entry. Nothing
 * in here may influence an action.
 */

/** How many calls a long session keeps; older ones fall off the front. */
export const DEFAULT_TIMELINE_CAPACITY = 200

/**
 * Shorten a value for one-line display without losing the useful part.
 * @param {unknown} value - anything.
 * @param {number} max - character budget.
 * @returns {string} single-line text.
 */
function oneLine(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Summarise tool arguments as `key=value` pairs, dropping the big in-page
 * `source` strings (they dwarf every other field and are not informative).
 * @param {object} args - the tool call arguments.
 * @param {number} max - character budget for the whole summary.
 * @returns {string} e.g. `loc=css:#log-one steps=6`.
 */
export function summarizeArgs(args, max = 120) {
  if (args === null || typeof args !== 'object') return ''
  const parts = []
  for (const [key, value] of Object.entries(args)) {
    if (key === 'source' || value === undefined) continue
    if (value === null) {
      parts.push(`${key}=null`)
      continue
    }
    if (typeof value === 'object') {
      const flat = JSON.stringify(value)
      parts.push(`${key}=${oneLine(flat, 48)}`)
      continue
    }
    parts.push(`${key}=${oneLine(value, 48)}`)
  }
  return oneLine(parts.join(' '), max)
}

/**
 * Create the recorder.
 * @param {{ capacity?: number, now?: () => number }} [options] - overrides for tests.
 * @returns {{ record: (entry: object) => object, list: (options?: object) => object[], clear: () => void, get size(): number }}
 */
export function createTimeline(options = {}) {
  const capacity = Number.isInteger(options.capacity) && options.capacity > 0
    ? options.capacity
    : DEFAULT_TIMELINE_CAPACITY
  const now = typeof options.now === 'function' ? options.now : Date.now
  const entries = []
  let seq = 0

  return {
    /**
     * Append one observation. The caller (the tools wrapper) owns the facts;
     * this method only normalises the shape and enforces the ring.
     * @param {object} entry - `{ tool, session, ok, effect, code, summary, url, file, bytes, ms, at }`.
     * @returns {object} the stored entry, with its assigned `seq`.
     */
    record(entry) {
      seq += 1
      const stored = {
        seq,
        at: Number.isFinite(entry?.at) ? entry.at : now(),
        tool: oneLine(entry?.tool ?? 'unknown', 40),
        session: oneLine(entry?.session ?? '', 60),
        ok: entry?.ok === true,
        effect: entry?.effect === undefined ? null : oneLine(entry.effect, 16),
        code: entry?.code === undefined ? null : oneLine(entry.code, 40),
        summary: oneLine(entry?.summary ?? '', 160),
        url: entry?.url === undefined ? null : oneLine(entry.url, 200),
        file: entry?.file === undefined ? null : oneLine(entry.file, 260),
        bytes: Number.isInteger(entry?.bytes) ? entry.bytes : null,
        ms: Number.isFinite(entry?.ms) ? Math.max(0, Math.round(entry.ms)) : null,
      }
      entries.push(stored)
      if (entries.length > capacity) entries.splice(0, entries.length - capacity)
      return stored
    },

    /**
     * Newest first, optionally filtered.
     * @param {{ limit?: number, tool?: string, failedOnly?: boolean }} [listOptions] - filters.
     * @returns {object[]} copies of the stored entries.
     */
    list(listOptions = {}) {
      const limit = Number.isInteger(listOptions.limit) && listOptions.limit > 0
        ? Math.min(listOptions.limit, 200)
        : 10
      const wantedTool = typeof listOptions.tool === 'string' && listOptions.tool !== ''
        ? listOptions.tool
        : ''
      const failedOnly = listOptions.failedOnly === true
      const picked = []
      for (let index = entries.length - 1; index >= 0 && picked.length < limit; index -= 1) {
        const entry = entries[index]
        if (failedOnly && entry.ok) continue
        if (wantedTool !== '' && entry.tool !== wantedTool) continue
        picked.push({ ...entry })
      }
      return picked
    },

    clear() {
      entries.length = 0
    },

    get size() {
      return entries.length
    },
  }
}
