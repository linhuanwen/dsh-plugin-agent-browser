/**
 * TICKET-027: when an open fails, offer a way *forward* — as candidates only.
 *
 * The panel cannot reach a page (host does not resolve, connection refused, the
 * site moved). The failure itself is TICKET-013's business: that ticket puts the
 * user's page back and says so. This module adds one question the agent cannot
 * answer by itself when the page is gone: *what else could serve this intent?*
 *
 * Rules, all deliberately conservative:
 * - Off by default. A search costs money per call on this host (`dsh-web`'s
 *   default route for a non-DeepSeek model is the billed Search API), so the
 *   plugin never searches unless the operator turned `searchFallback.enabled`
 *   on, and never searches more than once per failed open.
 * - Candidates are returned, never opened. They are appended to the error's
 *   message and `details.alternatives`, each with `opened: false` spelled out,
 *   because the cheapest way for this design to hurt is for the agent to report
 *   back a page it never visited.
 * - Only `sources[]` is read. `WebSearchResult.content` is provider-generated
 *   prose; treating it as page content would let the model quote a summary as
 *   if it had read the page. It is dropped here, not merely ignored downstream.
 * - Any inability to search (no web service, no provider, a provider error)
 *   yields no alternatives and no new error code: the failure must stay
 *   byte-for-byte the TICKET-013 failure in that case.
 *
 * The module is pure enough to unit-test: query construction is exported, and
 * `createSearchFallback` takes its web service through a function so the tests
 * never touch the network.
 */
import { AgentBrowserError, isAgentBrowserError } from './errors.js'
import { readField } from './config.js'

/** Upper bound on how long a fallback search may delay the error it belongs to. */
export const SEARCH_TIMEOUT_MS = 8_000

/** `dsh-web` selects this provider for a DeepSeek chat route (free, but billed in tokens). */
const DEEPSEEK_ROUTE_SEARCH_PROVIDER = 'deepseek-official'

/** `dsh-web` selects this provider for every other chat route (billed per search). */
const OTHER_ROUTE_SEARCH_PROVIDER = 'deepseek-search-api'

/** Chat routes `dsh-web` treats as DeepSeek's own. @see dsh-web/src/index.ts */
const DEEPSEEK_MODEL_ROUTES = new Set(['deepseek-official', 'deepseek-account'])

/** Path words that say nothing about what the page was. */
const NOISE_WORDS = new Set([
  'index', 'default', 'home', 'main', 'page', 'pages', 'search', 'list', 'view', 'read',
  'html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'do', 'action', 'en', 'zh', 'cn', 'www',
])

/** Errors that mean "the page the agent wanted is not there", not "the plugin said no". */
export const FALLBACK_CODES = Object.freeze(['navigation_failed', 'needs_human'])

/**
 * The registrable-ish host of a URL, without `www.`.
 * @param {string} url - the address that failed to open.
 * @returns {string|null} the host, or null when the address is not http(s).
 */
export function hostOf(url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const host = parsed.hostname.toLowerCase()
  return host.startsWith('www.') ? host.slice(4) : host
}

/**
 * The most specific words in a URL's path, best first.
 *
 * The ticket prefers the page title; the host half never has it when navigation
 * fails (the panel is on its error page, and the last digest is a hand-back
 * note, not a title). Path segments are the honest fallback: they are what the
 * operator typed into the address bar.
 * @param {string} url - the address that failed to open.
 * @param {number} [limit] - how many words to keep.
 * @returns {string[]} up to `limit` words, without extensions or slugs' noise.
 */
export function pathWords(url, limit = 4) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    return []
  }
  const words = []
  const segments = parsed.pathname.split('/').filter((segment) => segment !== '')
  for (const segment of segments) {
    let decoded = segment
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      // A malformed escape is still a usable literal.
    }
    // Drop the extension of the final segment ("getting-started.html").
    const dot = decoded.lastIndexOf('.')
    const bare = dot > 0 ? decoded.slice(0, dot) : decoded
    for (const token of bare.split(/[^\p{L}\p{N}]+/u)) {
      const word = token.trim()
      if (word.length < 2) continue
      if (/^\d+$/.test(word)) continue
      if (NOISE_WORDS.has(word.toLowerCase())) continue
      if (words.includes(word)) continue
      words.push(word)
      if (words.length >= limit) return words
    }
  }
  return words
}

/**
 * The one search query a failed open is allowed to issue.
 *
 * Deliberately a plain query (`<host> <words…>`) rather than
 * `site:<host> <words…>`: measured on this host (2026-11-22) the selected
 * provider answers `site:example.com example domain` with zero sources while the
 * same provider happily returns five sources for a plain query — the operator is
 * not honoured, so trusting it would mean a billed call that can never yield
 * candidates. The same-site promise is kept by `pickAlternatives` instead, which
 * filters the results; the host stays first in the query so same-site hits rank
 * high.
 * @param {string} url - the address that failed to open.
 * @returns {string|null} the query, or null when there is nothing to search for.
 */
export function siteQuery(url) {
  const host = hostOf(url)
  if (host === null) return null
  return [host, ...pathWords(url)].join(' ')
}

/**
 * Which provider `dsh-web` would pick, for the log line.
 *
 * `ctx.web.search()` does not report the provider it used, so this mirrors
 * `selectSearchProvider`'s preference. An operator-configured provider id wins
 * over this guess, which is why the log says "expected".
 * @param {string|undefined} llmProvider - the chat route of the calling session.
 * @returns {string} the expected provider id.
 */
export function expectedProvider(llmProvider) {
  return llmProvider !== undefined && DEEPSEEK_MODEL_ROUTES.has(llmProvider)
    ? DEEPSEEK_ROUTE_SEARCH_PROVIDER
    : OTHER_ROUTE_SEARCH_PROVIDER
}

/**
 * The chat route of the session behind a tool call (TICKET-027 U6).
 * @param {unknown} exec - the `ToolRunContext`.
 * @returns {string|undefined} the provider id, when the host exposes it.
 */
export function routeOf(exec) {
  try {
    const provider = exec?.agent?.session?.requestContext?.()?.provider
    return typeof provider === 'string' && provider !== '' ? provider : undefined
  } catch {
    return undefined
  }
}

/**
 * Keep the results that plausibly serve the same site, in their provider order.
 * @param {readonly {url?: unknown, title?: unknown, snippet?: unknown}[]} sources - provider sources.
 * @param {string} host - the host of the page that failed to open.
 * @param {string} failedUrl - the address itself, which is never its own alternative.
 * @param {number} maxResults - cap, from config.
 * @returns {{title: string, url: string, why: string}[]} candidates.
 */
export function pickAlternatives(sources, host, failedUrl, maxResults) {
  const picked = []
  const seen = new Set()
  for (const source of Array.isArray(sources) ? sources : []) {
    if (typeof source?.url !== 'string' || source.url === '') continue
    const candidateHost = hostOf(source.url)
    if (candidateHost === null) continue
    // Same site, or a subdomain of it: `docs.example.com` serves `example.com`.
    if (candidateHost !== host && candidateHost.endsWith(`.${host}`) === false) continue
    if (source.url === failedUrl) continue
    if (seen.has(source.url)) continue
    seen.add(source.url)
    picked.push({
      title: typeof source.title === 'string' && source.title.trim() !== ''
        ? source.title.trim()
        : candidateHost,
      url: source.url,
      why: 'same site, found by search — not a link read off the page',
    })
    if (picked.length >= maxResults) break
  }
  return picked
}

/**
 * Render candidates as message lines.
 *
 * Kept separate from `createSearchFallback` so the wording is unit-testable and
 * the "nothing was opened" promise is visible in one place.
 * @param {{query: string, expected: string, route?: string, alternatives: {title: string, url: string}[]}} attempt - one successful search.
 * @returns {string} a block to append to the failure message.
 */
export function fallbackText(attempt) {
  const route = attempt.route === undefined ? 'unknown' : attempt.route
  return [
    '',
    '',
    `Search fallback (1 call, provider≈${attempt.expected}, model route=${route}, query="${attempt.query}"): `
      + 'search results for this site, not links found on a page. Nothing was opened (opened: false); '
      + 'pick one and call browser_open yourself, or ask the user which one is right.',
    ...attempt.alternatives.map((alternative) => `- ${alternative.title} — ${alternative.url}`),
  ].join('\n')
}

/**
 * Build the fallback used by `browser_open`'s failure path.
 * @param {{
 *   config?: { enabled?: unknown, maxResults?: unknown },
 *   getWeb?: () => ({ search?: Function, searchReady?: Function } | null | undefined),
 *   log?: (message: string) => void,
 * }} [options] - config readers and the (lazily found) web service.
 * @returns {{ enabled: () => boolean, alternatives: (request: {url: string, exec?: unknown, signal?: AbortSignal}) => Promise<object|null> }} the fallback.
 */
export function createSearchFallback(options = {}) {
  const config = options.config ?? {}
  const getWeb = options.getWeb ?? (() => undefined)
  const log = options.log ?? (() => {})

  /** @returns {boolean} whether the operator turned this on. */
  function enabled() {
    return readField(config.enabled, false) === true
  }

  return {
    enabled,
    /**
     * One search for one failed open, or null when the rules forbid it.
     * @param {{url: string, exec?: unknown, signal?: AbortSignal}} request - the failed address and the call it came from.
     * @returns {Promise<object|null>} `{query, expected, route, alternatives}`, or null.
     */
    async alternatives(request) {
      if (enabled() === false) return null
      const web = getWeb()
      if (web === null || web === undefined || typeof web.search !== 'function') {
        log('search fallback: no web service in this host; the failure is unchanged')
        return null
      }
      const query = siteQuery(request.url)
      if (query === null) {
        log('search fallback: nothing to search for (not an http(s) address)')
        return null
      }
      const route = routeOf(request.exec)
      let ready = true
      if (typeof web.searchReady === 'function') {
        try {
          ready = (await web.searchReady(route)) !== false
        } catch {
          // A selection failure is reported by `search()` as a structured error;
          // probing readiness must never decide the failure.
          ready = true
        }
      }
      if (ready === false) {
        log(`search fallback: the selected search provider cannot authenticate (route=${route ?? 'unknown'})`)
        return null
      }
      const maxResults = clampMaxResults(readField(config.maxResults, 5))
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), SEARCH_TIMEOUT_MS)
      const signal = combineSignals(timeout.signal, request.signal)
      let result
      try {
        result = await web.search(
          { query, maxResults, ...(route === undefined ? {} : { llmProvider: route }) },
          signal,
        )
        log(`search fallback: 1 call, provider≈${expectedProvider(route)} (dsh-web may override), `
          + `route=${route ?? 'unknown'}, query="${query}", sources=${Array.isArray(result?.sources) ? result.sources.length : 0}`)
      } catch (error) {
        log(`search fallback: search failed (${error?.message ?? String(error)}); the failure is unchanged`)
        return null
      } finally {
        clearTimeout(timer)
      }
      const host = hostOf(request.url)
      // Only `sources`: `content` is provider prose and must not look like a page.
      const alternatives = pickAlternatives(result?.sources, host ?? '', request.url, maxResults)
      if (alternatives.length === 0) {
        log('search fallback: no result on the same site; nothing to suggest')
        return null
      }
      return { query, expected: expectedProvider(route), ...(route === undefined ? {} : { route }), alternatives }
    },
  }
}

/**
 * Attach candidates to a classified open failure (TICKET-027).
 *
 * Only `navigation_failed` and `needs_human` qualify: every other code means the
 * plugin refused the call before the page was reached (or the caller stopped
 * it), and a search would answer a question nobody asked. The original error is
 * preserved as `cause`, and its code/retryable survive unchanged.
 * @param {unknown} error - the error thrown by `browser_open`.
 * @param {string} url - the address that failed to open.
 * @param {{ enabled: () => boolean, alternatives: Function }} fallback - from `createSearchFallback`.
 * @param {{ exec?: unknown, signal?: AbortSignal }} [context] - the tool call context.
 * @returns {Promise<unknown>} the enriched error, or the original one.
 */
export async function enrichOpenFailure(error, url, fallback, context = {}) {
  if (isAgentBrowserError(error) === false) return error
  if (FALLBACK_CODES.includes(error.code) === false) return error
  if (fallback?.enabled?.() !== true) return error
  let attempt = null
  try {
    attempt = await fallback.alternatives({ url, exec: context.exec, signal: context.signal })
  } catch {
    // The fallback is a courtesy; it can never replace or mask the real failure.
    attempt = null
  }
  if (attempt === null) return error
  return new AgentBrowserError(error.code, `${error.message}${fallbackText(attempt)}`, {
    cause: error,
    retryable: error.retryable,
    details: {
      ...(error.details ?? {}),
      alternatives: attempt.alternatives,
      searchFallback: {
        query: attempt.query,
        provider: attempt.expected,
        ...(attempt.route === undefined ? {} : { route: attempt.route }),
        calls: 1,
        opened: false,
      },
    },
  })
}

/**
 * Config values are validated by `config.js`, but a fallback must also survive a
 * hand-edited profile; clamp rather than trust.
 * @param {unknown} value - `searchFallback.maxResults`.
 * @returns {number} 1–10 results.
 */
function clampMaxResults(value) {
  // A hand-edited row may carry anything; 0/negative/fractions are not a cap we
  // can honour, so they fall back to the documented default rather than to 1.
  if (Number.isInteger(value) === false || value < 1) return 5
  return Math.min(10, value)
}

/**
 * `AbortSignal.any` is available in this host, but the fallback must not depend
 * on it: a missing implementation would turn "cancel" into "ignore".
 * @param {AbortSignal} first - the search timeout.
 * @param {AbortSignal|undefined} second - the tool call's signal.
 * @returns {AbortSignal} a signal that aborts when either input does.
 */
function combineSignals(first, second) {
  if (second === undefined) return first
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([first, second])
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (first.aborted || second.aborted) {
    controller.abort()
    return controller.signal
  }
  first.addEventListener('abort', abort, { once: true })
  second.addEventListener('abort', abort, { once: true })
  return controller.signal
}
