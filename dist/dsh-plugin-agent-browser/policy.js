/**
 * The "what is allowed" seam (TICKET-024).
 *
 * Every strategy the tools used to hard-code lives here once, as a small pure
 * object built from the live config. Two entry points use it:
 *
 * - tool bodies call `checkX()` right before they act;
 * - `apply.js` registers `rules.guard` with `ctx.tools.guard()`, which the host
 *   runs after `tools/pre-execute` and before the body. A denial there is
 *   shaped like every other failure (`Error: <reason>` plus `error.info`), so
 *   the model and the UI see the same `AgentBrowserError` identity either way.
 *
 * Nothing in here reads the filesystem, the bridge or the panel: `config`
 * values may be plain values or volatile readers (`{ get() }`), and are read on
 * every call so a live toggle takes effect without restarting the plugin.
 */

import { AgentBrowserError } from './errors.js'
import { readField } from './config.js'

/** Tool names this plugin owns; the guard must not touch anyone else's tools. */
export const BROWSER_TOOL_NAMES = Object.freeze([
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_scroll',
  'browser_hover',
  'browser_zoom',
  'browser_screenshot',
  'browser_type',
  'browser_press',
  'browser_eval',
  'browser_download',
])

/**
 * Extensions never worth downloading into a workspace: anything a user could
 * double-click into executing. Documents and archives (pdf/docx/xlsx/zip/png…)
 * are all fine — this is a deny list, not an allow list, so an unfamiliar but
 * harmless extension still downloads.
 */
export const DEFAULT_BLOCKED_EXTENSIONS = Object.freeze([
  '.exe', '.msi', '.msix', '.appx', '.msc', '.com', '.scr', '.pif', '.cpl', '.hta', '.wsf', '.wsh',
  '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.vbs', '.vbe', '.jse', '.lnk', '.reg', '.jar', '.sh',
])

const DEFAULT_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024

/**
 * Lowercase extension of a file name, including the dot (`''` when there is
 * none). Only the last segment is considered, so `report.final.PDF` → `.pdf`.
 * @param {unknown} name - file name or path.
 * @returns {string} the extension.
 */
export function extensionOf(name) {
  if (typeof name !== 'string' || name === '') return ''
  const base = name.replace(/^.*[\\/]/, '')
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

/**
 * The only schemes the panel is allowed to load. `file:`, `javascript:`,
 * `data:` and `blob:` would each let a page (or the model) escape the browser
 * sandbox, so they are refused here rather than in the renderer.
 * @param {unknown} url - an absolute url.
 * @returns {string} the parsed url as a string.
 */
export function assertHttpUrl(url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    throw new AgentBrowserError('scheme_rejected', `not an absolute URL: ${String(url).slice(0, 120)}`, {
      details: { url: String(url).slice(0, 120) },
    })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AgentBrowserError('scheme_rejected', `only http(s) URLs are allowed, got ${parsed.protocol}`, {
      details: { protocol: parsed.protocol },
    })
  }
  return parsed.toString()
}

/**
 * Build the policy object for one plugin instance.
 * @param {{
 *   evalEnabled?: unknown,
 *   sessions?: { allowlist?: unknown },
 *   downloads?: { maxBytes?: unknown, extraBlockedExtensions?: unknown },
 * }} [config] - config values; volatile fields may be readers.
 * @returns {{
 *   checkOpen: (url: unknown) => string,
 *   checkEval: () => void,
 *   checkDownload: (name: unknown, bytes?: number) => void,
 *   clampChars: (value: unknown, ceiling: number, floor?: number) => number,
 *   checkSession: (sessionId: unknown) => void,
 *   guard: (exec: { name?: unknown, agent?: { id?: unknown } }) => string | { reason: string, info: { name: string, code: string } } | undefined,
 * }} the policy.
 */
export function createPolicy(config = {}) {
  const evalEnabled = () => readField(config.evalEnabled, true) !== false
  const allowlist = () => {
    const value = readField(config.sessions?.allowlist, [])
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry !== '') : []
  }
  const blockedExtensions = () => {
    const extra = readField(config.downloads?.extraBlockedExtensions, [])
    const list = Array.isArray(extra) ? extra : []
    return new Set([...DEFAULT_BLOCKED_EXTENSIONS, ...list.map((entry) => String(entry).toLowerCase()).map((entry) => (entry.startsWith('.') ? entry : `.${entry}`))])
  }
  const downloadMaxBytes = () => {
    const value = readField(config.downloads?.maxBytes, DEFAULT_DOWNLOAD_MAX_BYTES)
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_DOWNLOAD_MAX_BYTES
  }

  return {
    /**
     * Scheme gate for a model-supplied url.
     * @param {unknown} url - what the model passed.
     * @returns {string} the normalized absolute url.
     */
    checkOpen(url) {
      return assertHttpUrl(url)
    },

    /** Refuse `browser_eval` when the installation switched it off. */
    checkEval() {
      if (evalEnabled() !== true) {
        throw new AgentBrowserError('eval_disabled', 'browser_eval is switched off by this installation (evalEnabled: false)', {
          details: { setting: 'evalEnabled' },
        })
      }
    },

    /**
     * Refuse a download by extension or size. Called once the final name and
     * byte count are known, before anything is written to disk.
     * @param {unknown} name - the resolved file name.
     * @param {number} [bytes] - the body size, when known.
     */
    checkDownload(name, bytes) {
      const extension = extensionOf(name)
      if (extension !== '' && blockedExtensions().has(extension)) {
        throw new AgentBrowserError('download_rejected', `refusing to download ${extension} files into the workspace`, {
          details: { extension },
        })
      }
      const limit = downloadMaxBytes()
      if (Number.isFinite(bytes) && Number(bytes) > limit) {
        throw new AgentBrowserError('download_rejected', `the file is ${Number(bytes)} bytes, over the ${limit} byte download limit`, {
          details: { bytes: Number(bytes), limit },
        })
      }
    },

    /**
     * Clamp a character budget to what this installation is willing to spend.
     * @param {unknown} value - the model's request.
     * @param {number} ceiling - never exceed this.
     * @param {number} [floor] - never go below this.
     * @returns {number} the clamped budget.
     */
    clampChars(value, ceiling, floor = 0) {
      const requested = Number.isFinite(value) ? Math.trunc(Number(value)) : ceiling
      return Math.min(ceiling, Math.max(floor, requested))
    },

    /**
     * Refuse a session that is not on the allow list. An empty list allows
     * every session, which is the shipped default.
     * @param {unknown} sessionId - the agent/session id.
     */
    checkSession(sessionId) {
      const allowed = allowlist()
      if (allowed.length === 0) return
      if (typeof sessionId === 'string' && allowed.includes(sessionId)) return
      throw new AgentBrowserError('session_not_allowed', `this session is not allowed to drive the browser (session_not_allowed)`, {
        details: { session: typeof sessionId === 'string' ? sessionId : '' },
      })
    },

    /**
     * Host guard: deny our tools for sessions outside the allow list. Other
     * tools are untouched — a guard is global to the process, so the name
     * filter is what keeps this plugin from vetoing anybody else's work.
     * @param {{ name?: unknown, agent?: { id?: unknown } }} exec - the host's execution record.
     * @returns {string | { reason: string, info: { name: string, code: string } } | undefined} a denial, or undefined to allow.
     */
    guard(exec) {
      if (!BROWSER_TOOL_NAMES.includes(String(exec?.name))) return undefined
      const allowed = allowlist()
      if (allowed.length === 0) return undefined
      const session = exec?.agent?.id
      if (typeof session === 'string' && allowed.includes(session)) return undefined
      const error = new AgentBrowserError('session_not_allowed', `this session is not allowed to drive the browser (session_not_allowed)`, {
        details: { session: typeof session === 'string' ? session : '' },
      })
      return { reason: error.message, info: { name: error.name, code: error.code } }
    },
  }
}
