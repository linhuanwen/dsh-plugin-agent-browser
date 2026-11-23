/**
 * One error type for every failure the browser tools can report.
 *
 * Why a class instead of message prefixes: the harness only distinguishes a
 * failure it understands. `dsh-tools` turns a thrown value into
 * `{ content: 'Error: <message>', error: { message, info? } }`, and `info` is
 * `{ name, code }` only when the thrown value is a `HarnessError`; the model
 * reads `content`, so the code has to survive in the message as well as in the
 * field. `AgentBrowserError` therefore writes `"<code>: <human text>"` into the
 * message and keeps `retryable` / `hint` / `details` for anyone that can read
 * the object (panel UI, logs, tests).
 *
 * The base class is deliberately local (same shape as `HarnessError`: `name`,
 * `code`, `cause`). Importing `HarnessError` from `@deepseek-ai/dsh-llm` looks
 * attractive — `dsh-tools` sets `error.info` for `instanceof HarnessError` —
 * but a plugin cannot obtain the host's copy: the host runs from `app.asar`,
 * while a bare import from the profile resolves through Node's global folders
 * to whatever DSH happens to be installed there (measured: a plain global npm
 * install, with different module identity). A subclass of that copy would fail
 * the host's `instanceof` anyway, so the import would only add top-level await
 * and a machine-dependent resolution. This is why TICKET-020 records the base
 * as `'local'` and keeps the code inside the message, where the model reads it.
 */

/** @typedef {'panel_not_open'|'panel_taken_over'|'needs_human'|'bridge_timeout'|'bridge_closed'|'cancelled'|'unauthorized'|'scheme_rejected'|'eval_disabled'|'session_not_allowed'|'navigation_failed'|'download_rejected'|'budget_exceeded'} AgentBrowserErrorCode */

/**
 * The contract a caller can branch on: every code, whether trying again can
 * help, and the one sentence the model should act on. Tests walk this table so
 * the implementation cannot drift from the documented list.
 * @type {Record<AgentBrowserErrorCode, { retryable: boolean, hint: string }>}
 */
export const ERROR_CODES = {
  panel_not_open: {
    retryable: false,
    hint: 'open the right sidebar browser tab for this session (browser_open does it for you), then retry.',
  },
  panel_taken_over: {
    retryable: true,
    hint: 'wait for the user to hand the panel back; reads still work.',
  },
  needs_human: {
    retryable: false,
    hint: 'ask the user to finish the verification step in the panel, then take a snapshot.',
  },
  bridge_timeout: {
    retryable: true,
    hint: 'bring the panel into view and retry; the page may simply be slow.',
  },
  bridge_closed: {
    retryable: false,
    hint: 'the plugin was disabled or reloaded; re-enable it and retry.',
  },
  cancelled: {
    retryable: false,
    hint: 'the caller stopped this call; nothing already delivered to the page can be undone, so re-read the page before acting again.',
  },
  unauthorized: {
    retryable: false,
    hint: 'the panel credential is missing or stale; reload the panel (or restart the app) and retry.',
  },
  scheme_rejected: {
    retryable: false,
    hint: 'only http(s) URLs can be opened; use browser_open({ path }), or download the page first.',
  },
  eval_disabled: {
    retryable: false,
    hint: 'this installation switched browser_eval off; use browser_snapshot instead, or ask the user to enable evalEnabled.',
  },
  session_not_allowed: {
    retryable: false,
    hint: 'this session is outside the browser allow list; ask the operator to add it (sessions.allowlist) or use another session.',
  },
  navigation_failed: {
    retryable: true,
    hint: 'the page did not load; check the URL or try another mirror.',
  },
  download_rejected: {
    retryable: false,
    hint: 'the file was refused (size limit, extension, or filename); see stage and reason.',
  },
  budget_exceeded: {
    retryable: true,
    hint: 'the output was cut at the character budget; read a smaller region or pass a larger maxChars.',
  },
}

/**
 * Base class for every `AgentBrowserError`.
 *
 * Kept local on purpose — see the module comment. Shape-compatible with the
 * host's `HarnessError` (`message`, `code`, `name`, `cause`) so call sites,
 * log lines and tests read the same either way.
 */
class LocalHarnessError extends Error {
  /**
   * @param {string} message - the rendered message.
   * @param {string} code - stable machine code.
   * @param {ErrorOptions} [options] - standard error options.
   */
  constructor(message, code, options) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

/**
 * Which base the errors use. Always `'local'`: the host's `HarnessError` lives
 * in a different module instance than anything a profile plugin can import, so
 * subclassing it would not make `dsh-tools` recognise the error anyway.
 * Reported in the install log so an acceptance run can spot a change.
 */
export const HARNESS_ERROR_BASE = 'local'

/**
 * A browser-tool failure with a stable, documented code.
 *
 * `message` is rendered as `"<code>: <text>"` unless the caller already wrote
 * that prefix (the migration keeps the old prefixes readable, e.g.
 * `panel_taken_over: …` still matches `/taken_over/`).
 */
export class AgentBrowserError extends LocalHarnessError {
  /**
   * @param {AgentBrowserErrorCode} code - one of `ERROR_CODES`.
   * @param {string} message - human text, already a full sentence.
   * @param {{ cause?: unknown, retryable?: boolean, details?: object }} [options] - extras.
   */
  constructor(code, message, options = {}) {
    const spec = ERROR_CODES[code]
    if (spec === undefined) throw new TypeError(`unknown agent-browser error code: ${String(code)}`)
    const text = typeof message === 'string' ? message : String(message)
    const rendered = text.startsWith(`${code}:`) ? text : `${code}: ${text}`
    super(rendered, code, options.cause === undefined ? undefined : { cause: options.cause })
    // HarnessError declares `code` from its second argument; assigning keeps the
    // fallback base honest without depending on either constructor's details.
    this.code = code
    this.retryable = typeof options.retryable === 'boolean' ? options.retryable : spec.retryable
    this.hint = spec.hint
    if (options.details !== undefined) this.details = options.details
  }

  /** Stable, serializable projection for logs and the panel. */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable === true,
      hint: this.hint,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

/**
 * Whether a value is one of ours (safe across the fallback base, too).
 * @param {unknown} error - anything thrown.
 * @returns {boolean} true for an `AgentBrowserError`.
 */
export function isAgentBrowserError(error) {
  return error instanceof AgentBrowserError
}

/**
 * Wrap the panel's free-text failure in the closest code we can defend.
 * The panel reports what the webview `loadURL` or the page script said; only a
 * few shapes are unambiguous, everything else stays a plain Error so the
 * message is not relabelled dishonestly.
 * @param {string} message - the panel's error text.
 * @returns {Error} an `AgentBrowserError`, or the original text in an `Error`.
 */
export function fromPanelMessage(message) {
  const text = typeof message === 'string' ? message : String(message)
  if (/^taken_over\b|taken_over:/.test(text)) return new AgentBrowserError('panel_taken_over', text)
  if (/^needs_human\b|needs_human:/.test(text)) return new AgentBrowserError('needs_human', text)
  if (/is not open|is not on screen|not mounted|activation="manual"/.test(text)) {
    return new AgentBrowserError('panel_not_open', text)
  }
  // The client half already formats some failures with a stable code (TICKET-013
  // wraps `navigation_failed:` and `page_unavailable:` itself). Keep the code it
  // chose instead of re-guessing from the prose.
  const prefixed = /^([a-z][a-z_]+):\s/.exec(text)
  if (prefixed !== null && Object.hasOwn(ERROR_CODES, prefixed[1]) === true) {
    return new AgentBrowserError(prefixed[1], text)
  }
  if (/\bERR_[A-Z_]+\b|net::ERR_|failed to load|did-fail-load|page_unavailable/.test(text)) {
    return new AgentBrowserError('navigation_failed', text)
  }
  return new Error(text)
}
