/**
 * The first-touch permission gate: pure logic, no I/O.
 *
 * Why this exists: the panel is a real browser carrying the user's logins, and
 * the agent writes into it while the user is not looking. Reads are free — the
 * user can see the page change and reads cannot destroy anything. Writes are
 * what need a human moment: the first time in a session the agent types,
 * submits, runs page script, or downloads on a site, the panel asks once.
 *
 * Two constraints shaped the rules (SPEC-003, decision 010):
 * - "a page behind a login" cannot be detected from the panel: an HttpOnly
 *   cookie is invisible to the renderer, so the gate keys on an observable
 *   event instead — a write action on a new origin.
 * - A permission prompt that never appears must never turn into a hang: every
 *   way the human can be unavailable ends in a stable `approval_*` error, and
 *   nothing is sent to the page.
 *
 * Everything here is synchronous so it can be unit tested without a browser,
 * a bridge, or a clock.
 */

/** The two approval stances a profile can be in. */
export const APPROVAL_MODES = Object.freeze(['first-touch', 'off'])

/** `first-touch` is the product's default: visible, but not annoying. */
export const DEFAULT_APPROVAL_MODE = 'first-touch'

/** How long the panel waits for the human before failing closed. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000

/** A prompt shorter than this is not readable; longer than this and the tool call is dead. */
const MIN_APPROVAL_TIMEOUT_MS = 2_000
const MAX_APPROVAL_TIMEOUT_MS = 120_000

/** The write classes a `first-touch` gate asks about. */
export const ACTION_CLASSES = Object.freeze(['type', 'submit', 'download', 'eval'])

/** Keys that submit a form when the focused control is inside one. */
export const SUBMIT_KEYS = Object.freeze(['Enter', 'Return', 'NumpadEnter'])

/** 64 entries of "session|origin" is far more sites than one session opens. */
const GRANT_LIMIT = 64

/**
 * Normalize the `approvals` config group.
 *
 * Unknown modes fall back rather than throwing: a typo in a settings file must
 * not make every write tool fail, and falling back here means "first-touch",
 * the safe side (it asks, it never silently allows).
 * @param {unknown} raw - the configured group (may be missing or malformed).
 * @returns {{ mode: string, timeoutMs: number, sensitiveSites: string[] }}
 */
export function normalizeApprovals(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = APPROVAL_MODES.includes(source.mode) ? source.mode : DEFAULT_APPROVAL_MODE
  const wanted = Number(source.timeoutMs)
  const timeoutMs = Number.isFinite(wanted)
    ? Math.min(MAX_APPROVAL_TIMEOUT_MS, Math.max(MIN_APPROVAL_TIMEOUT_MS, Math.round(wanted)))
    : DEFAULT_APPROVAL_TIMEOUT_MS
  const sensitiveSites = Array.isArray(source.sensitiveSites)
    ? source.sensitiveSites
      .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => hostEntry(entry.trim()))
      .filter((entry) => entry !== '')
    : []
  return { mode, timeoutMs, sensitiveSites }
}

/** `https://a.b.example.com/x` and `a.b.example.com` both become `a.b.example.com`. */
function hostEntry(entry) {
  const text = String(entry).toLowerCase()
  if (text.includes('://')) {
    try {
      return new URL(text).hostname.toLowerCase()
    } catch {
      return ''
    }
  }
  // Allow "example.com/path" to mean the site, not a URL prefix to match.
  return text.split('/')[0].split(':')[0]
}

/**
 * The origin a page is on, or `''` when there is none.
 *
 * Only `http:`/`https:` pages have an origin worth scoping a permission to: a
 * `file:` or `about:blank` document is either the user's own file or nothing at
 * all, and the tool layer already refuses to open those.
 * @param {unknown} address - the panel's current URL.
 * @returns {string} e.g. `https://example.com`, or `''`.
 */
export function originOf(address) {
  if (typeof address !== 'string' || address === '') return ''
  try {
    const url = new URL(address)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch {
    return ''
  }
}

/** Readable site label for a prompt: the hostname, never the full URL. */
export function siteLabel(origin) {
  if (typeof origin !== 'string' || origin === '') return '当前页面'
  try {
    return new URL(origin).hostname || origin
  } catch {
    return origin
  }
}

/**
 * Whether an origin is on the always-ask list.
 *
 * Matching is suffix-on-label: `example.com` covers `www.example.com` but not
 * `badexample.com`. A bare suffix comparison would allow that, so the dot is
 * part of the test.
 * @param {string} origin - the page origin.
 * @param {string[]} sensitiveSites - normalized host entries.
 * @returns {boolean} true when the user always wants to be asked here.
 */
export function isSensitive(origin, sensitiveSites) {
  if (!Array.isArray(sensitiveSites) || sensitiveSites.length === 0) return false
  let host = ''
  try {
    host = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === '') return false
  return sensitiveSites.some((entry) => host === entry || host.endsWith(`.${entry}`))
}

/**
 * The write class of a click, from what the page said the target is.
 *
 * `null` means "read": a link, a tab, a card that only navigates in place.
 * An unknown target is treated as a submit (`'submit'`) because the only way to
 * not know is for the page script to have failed, and asking once is the
 * recoverable mistake while skipping a confirm is not.
 * @param {null | { isSubmit?: boolean }} target - the inspected target.
 * @returns {'submit' | null}
 */
export function clickClass(target) {
  if (target === null || typeof target !== 'object') return 'submit'
  return target.isSubmit === true ? 'submit' : null
}

/**
 * The write class of a key press, from the focused target the page reported.
 *
 * Enter submits only when the focused control is inside a form; in a textarea
 * it inserts a newline, and anywhere else it activates nothing.
 * @param {unknown} key - the key the tool asked to press.
 * @param {null | { isSubmit?: boolean }} target - the inspected active element.
 * @returns {'submit' | null}
 */
export function pressClass(key, target) {
  const text = String(key ?? '')
  if (SUBMIT_KEYS.includes(text) === false) return null
  if (target !== null && typeof target === 'object' && target.isSubmit === false) return null
  return 'submit'
}

/**
 * The write class of one tool call, or `null` for a read.
 * @param {string} tool - tool name without the `browser_` prefix.
 * @param {Record<string, unknown>} [params] - the call's parameters.
 * @param {null | { isSubmit?: boolean }} [target] - inspected page target.
 * @returns {string | null} one of `ACTION_CLASSES`, or null.
 */
export function actionClassFor(tool, params = {}, target = null) {
  if (tool === 'type') return 'type'
  if (tool === 'eval') return 'eval'
  if (tool === 'download') return 'download'
  if (tool === 'click') return clickClass(target)
  if (tool === 'press') return pressClass(params?.key, target)
  return null
}

/**
 * A stable, non-sensitive identity for one action.
 *
 * Deliberately excludes what the user typed: the fingerprint is logged, and a
 * log line is not a place for a password or an address.
 * @param {{ origin?: string, actionClass?: string, target?: null | { tag?: string, role?: string } }} action
 * @returns {string}
 */
export function fingerprint(action = {}) {
  const origin = typeof action.origin === 'string' ? action.origin : ''
  const actionClass = typeof action.actionClass === 'string' ? action.actionClass : ''
  const tag = action.target !== null && typeof action.target === 'object' ? String(action.target.tag ?? '') : ''
  const role = action.target !== null && typeof action.target === 'object' ? String(action.target.role ?? '') : ''
  return `${origin}|${actionClass}|${tag.toLowerCase()}|${role.toLowerCase()}`
}

/**
 * The promise a human reads on the confirm bar.
 *
 * One sentence fragment, no URL path, no input value: the panel already shows
 * the page behind it, and the prompt is not a log.
 * @param {string} actionClass - one of `ACTION_CLASSES`.
 * @param {string} origin - the page origin.
 * @param {null | { name?: string }} [target] - inspected target.
 * @returns {string}
 */
export function summarize(actionClass, origin, target = null) {
  const site = siteLabel(origin)
  const name = target !== null && typeof target === 'object' && typeof target.name === 'string' ? target.name : ''
  const button = name === '' ? '' : `「${name.slice(0, 32)}」`
  if (actionClass === 'type') return `在 ${site} 的输入框里输入文字`
  if (actionClass === 'submit') return `在 ${site} 点击${button}提交表单`
  if (actionClass === 'download') return `从 ${site} 下载文件`
  if (actionClass === 'eval') return `在 ${site} 执行页面脚本`
  return `在 ${site} 做一次写操作`
}

/**
 * Remember which `(session, origin)` pairs the user already allowed.
 *
 * Site-level, not action-level (decision 010): one `本会话允许本站` answer is
 * enough that the agent does not come back asking for every click. A new session
 * starts blank, and `forget` drops a session once it ends.
 * @returns {{ grant: (sessionId: string, origin: string) => void, covers: (sessionId: string, origin: string) => boolean, forget: (sessionId: string) => void, size: () => number }}
 */
export function createGrantBook() {
  /** @type {Map<string, number>} */
  const grants = new Map()
  const keyOf = (sessionId, origin) => `${String(sessionId ?? '')}|${String(origin ?? '')}`
  return {
    grant(sessionId, origin) {
      const origin_ = String(origin ?? '')
      // There is nothing to scope a grant to without an origin; asking every
      // time is the honest fallback for a `file:` page.
      if (origin_ === '') return
      grants.set(keyOf(sessionId, origin_), Date.now())
      while (grants.size > GRANT_LIMIT) grants.delete(grants.keys().next().value)
    },
    covers(sessionId, origin) {
      const origin_ = String(origin ?? '')
      if (origin_ === '') return false
      return grants.has(keyOf(sessionId, origin_))
    },
    forget(sessionId) {
      for (const key of [...grants.keys()]) {
        if (key.startsWith(`${String(sessionId ?? '')}|`)) grants.delete(key)
      }
    },
    size() {
      return grants.size
    },
  }
}

/**
 * Whether this action must ask the human before it reaches the page.
 *
 * The order matters: `mode: 'off'` is the 1.4.x behaviour and must stay
 * byte-identical for anyone who wants it; then reads skip; then an
 * always-ask site; then a site the user already allowed.
 * @param {{ mode?: string, actionClass?: string | null, origin?: string, sensitiveSites?: string[], grants?: ReturnType<typeof createGrantBook> | null, sessionId?: string }} input
 * @returns {boolean}
 */
export function shouldConfirm(input = {}) {
  const mode = input.mode ?? DEFAULT_APPROVAL_MODE
  if (mode === 'off') return false
  const actionClass = input.actionClass ?? null
  if (actionClass === null || actionClass === undefined) return false
  if (ACTION_CLASSES.includes(actionClass) === false) return false
  const origin = typeof input.origin === 'string' ? input.origin : ''
  if (isSensitive(origin, input.sensitiveSites ?? [])) return true
  if (origin === '') return true
  const grants = input.grants ?? null
  if (grants !== null && grants.covers(input.sessionId ?? '', origin)) return false
  return true
}

/**
 * Validate the panel's answer.
 *
 * A client that is not visible cannot honestly claim a human saw the prompt, so
 * an invisible client answers `unavailable` no matter what it sent. Anything
 * unrecognized is dropped (`''`) rather than guessed: the host then keeps
 * waiting and the timeout is the fallback.
 * @param {unknown} value - the `decision` field.
 * @param {{ clientVisible?: boolean }} [options] - whether the asking panel was visible.
 * @returns {'' | 'once' | 'site' | 'deny' | 'unavailable'}
 */
export function parseDecision(value, options = {}) {
  if (options.clientVisible === false) return 'unavailable'
  return value === 'once' || value === 'site' || value === 'deny' || value === 'unavailable' ? value : ''
}
