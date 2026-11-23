/**
 * Config defaults and the rules that turn a loader row into plain settings.
 *
 * Why this file exists instead of doing it all in `index.js`: the schema is
 * built with `@deepseek-ai/schemastery`, which is a peer dependency the DSH host
 * provides — plain `node` cannot resolve it, so anything importable from a unit
 * test has to live outside `index.js`. The schema itself only declares types,
 * defaults and descriptions; the resolution rules (`normalizeConfig`, which
 * guards against a missing or half-filled group) live here and are tested.
 *
 * Naming rule for the ticket: `bridge` / `limits` / `downloads` / `static` are
 * the groups the loader row edits; `DEFAULTS` below is the single source of
 * truth for both the schema and the runtime fallback.
 */
import { DEFAULT_ACTIVATION } from './activation.js'

/** Defaults for every configurable value; the schema reads from here too. */
export const DEFAULTS = Object.freeze({
  // Volatile: read through `.get()` on every command, so changes apply live.
  activation: DEFAULT_ACTIVATION,
  fitWidth: true,
  evalEnabled: true,
  claimBrowserUse: true,
  // 'auto' = add the routing paragraph only when another browser tool set is
  // loaded; 'on' = always; 'off' = never. See `registerRoutingPrompt` in apply.js.
  routing: 'auto',

  bridge: Object.freeze({
    // 0 = let the OS pick; a fixed port collides with a second DSH instance and
    // is discoverable by any local scanner.
    port: 0,
    requestTimeoutMs: 20_000,
  }),
  limits: Object.freeze({
    navigationTimeoutMs: 45_000,
    snapshotMaxChars: 8000,
    evalMaxChars: 8000,
  }),
  downloads: Object.freeze({
    dir: 'downloads',
    maxBytes: 50 * 1024 * 1024,
    // Extra extensions to refuse on top of `policy.js`'s built-in deny list.
    extraBlockedExtensions: Object.freeze([]),
  }),
  sessions: Object.freeze({
    // Empty = every session may drive the browser (the shipped default).
    allowlist: Object.freeze([]),
  }),
  searchFallback: Object.freeze({
    // Off by default: on this host a search is billed per call, so a failed open
    // must never silently spend the operator's money (TICKET-027).
    enabled: false,
    maxResults: 5,
  }),
  static: Object.freeze({
    maxBytes: 32 * 1024 * 1024,
  }),
})

/**
 * The default for the `routing` field, exported on its own so the prompt code
 * reads one name instead of reaching into the frozen DEFAULTS object.
 */
export const DEFAULT_ROUTING = DEFAULTS.routing

/**
 * Read a value that may be either plain data (non-volatile field) or a volatile
 * reference (`schema.volatile()` parses into an object exposing `.get()`).
 *
 * A missing value always falls back: an old loader row has no `evalEnabled` key,
 * and a plugin that refuses to start over an absent optional field is a worse
 * failure than one that behaves like 1.0.x.
 * @param {unknown} value - the field as it came from the loader row.
 * @param {unknown} fallback - used when the field is absent or its reader is empty.
 * @returns {unknown} the current value.
 */
export function readField(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value.get === 'function') {
    const current = value.get()
    return current === undefined || current === null ? fallback : current
  }
  return value
}

/** Reject anything that is not a non-negative integer. */
function natural(value, fallback, name) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`agent-browser config: ${name} must be a non-negative integer, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Reject anything that is not a non-empty string. */
function text(value, fallback, name) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`agent-browser config: ${name} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Reject anything that is not a boolean. */
function flag(value, fallback, name) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') {
    throw new TypeError(`agent-browser config: ${name} must be a boolean, got ${JSON.stringify(value)}`)
  }
  return value
}

/** Reject anything that is not an array of non-empty strings. */
function texts(value, fallback, name) {
  if (value === undefined || value === null) return fallback
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new TypeError(`agent-browser config: ${name} must be an array of non-empty strings, got ${JSON.stringify(value)}`)
  }
  return value.map((entry) => entry.trim())
}

/**
 * Flatten a validated loader row into the plain settings the host half uses.
 *
 * Groups are optional (the 1.0.x row has none), so every field falls back to
 * `DEFAULTS`; values that are present but of the wrong shape are refused rather
 * than coerced. The schema normally catches those first — this is the second
 * line of defence for a config assembled by hand in a test or a probe.
 * @param {object} [config] - the loader row's `config`.
 * @returns {{ bridge: object, limits: object, downloads: object, static: object, sessions: object, searchFallback: object }}
 */
export function normalizeConfig(config = {}) {
  const row = config ?? {}
  const bridge = row.bridge ?? {}
  const limits = row.limits ?? {}
  const downloads = row.downloads ?? {}
  const site = row.static ?? {}
  const sessions = row.sessions ?? {}
  const fallback = row.searchFallback ?? {}
  return {
    bridge: {
      port: natural(bridge.port, DEFAULTS.bridge.port, 'bridge.port'),
      requestTimeoutMs: natural(bridge.requestTimeoutMs, DEFAULTS.bridge.requestTimeoutMs, 'bridge.requestTimeoutMs'),
    },
    limits: {
      navigationTimeoutMs: natural(limits.navigationTimeoutMs, DEFAULTS.limits.navigationTimeoutMs, 'limits.navigationTimeoutMs'),
      snapshotMaxChars: natural(limits.snapshotMaxChars, DEFAULTS.limits.snapshotMaxChars, 'limits.snapshotMaxChars'),
      evalMaxChars: natural(limits.evalMaxChars, DEFAULTS.limits.evalMaxChars, 'limits.evalMaxChars'),
    },
    downloads: {
      dir: text(downloads.dir, DEFAULTS.downloads.dir, 'downloads.dir'),
      maxBytes: natural(downloads.maxBytes, DEFAULTS.downloads.maxBytes, 'downloads.maxBytes'),
      extraBlockedExtensions: texts(downloads.extraBlockedExtensions, [...DEFAULTS.downloads.extraBlockedExtensions], 'downloads.extraBlockedExtensions'),
    },
    static: {
      maxBytes: natural(site.maxBytes, DEFAULTS.static.maxBytes, 'static.maxBytes'),
    },
    sessions: {
      allowlist: texts(sessions.allowlist, [...DEFAULTS.sessions.allowlist], 'sessions.allowlist'),
    },
    searchFallback: {
      // `enabled` may arrive as a volatile reader (the schema wraps it), so it is
      // unwrapped before the shape check — the reader itself is a valid value.
      enabled: flag(readField(fallback.enabled, DEFAULTS.searchFallback.enabled), DEFAULTS.searchFallback.enabled, 'searchFallback.enabled'),
      maxResults: natural(fallback.maxResults, DEFAULTS.searchFallback.maxResults, 'searchFallback.maxResults'),
    },
  }
}
