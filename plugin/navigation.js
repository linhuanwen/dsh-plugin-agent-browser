/**
 * Classify a failed navigation (TICKET-013).
 *
 * Electron reports a navigation failure as one opaque string that wraps the
 * original Chromium net error, e.g.
 *
 *   Error invoking remote method 'GUEST_VIEW_MANAGER_CALL':
 *     Error: ERR_CONNECTION_RESET (-101) loading 'https://www.samr.gov.cn/'
 *
 * The agent cannot do anything sensible with that: "connection reset", "DNS is
 * down" and "the certificate is wrong" call for three different follow-ups, and
 * the raw remote-method wrapper hides which one happened. The client half
 * reports the raw string plus whether it managed to go back; this module turns
 * the string into a small stable vocabulary that the tool layer puts into the
 * error text (and into `details.stage`).
 *
 * Pure and dependency-free so it can be unit-tested without a browser
 * (`plugin/test/navigation.test.mjs`).
 */

/** Stage → how the agent should react. Keep in sync with the user README table. */
const STAGES = {
  nav_dns: 'the host name could not be resolved',
  nav_refused: 'the server refused the connection',
  nav_reset: 'the connection was reset while loading',
  nav_cert: 'the certificate was rejected',
  nav_timeout: 'the server did not answer in time',
  nav_offline: 'the machine appears to be offline',
  nav_blocked: 'the request was blocked before it left the browser',
  nav_aborted: 'the navigation was aborted',
  nav_unknown: 'the navigation failed for an unclassified reason',
}

/** Ordered rules: the first matching pattern wins. */
const RULES = [
  ['nav_dns', /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_DNS_|getaddrinfo ENOTFOUND|EAI_AGAIN/i],
  ['nav_refused', /ERR_CONNECTION_REFUSED|ECONNREFUSED/i],
  ['nav_reset', /ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|ECONNRESET|EPIPE/i],
  ['nav_cert', /ERR_CERT_|ERR_SSL_|ERR_BAD_SSL_CLIENT_AUTH_CERT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT/i],
  ['nav_timeout', /ERR_TIMED_OUT|ERR_TIMEOUT|ETIMEDOUT/i],
  ['nav_offline', /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NETWORK_ACCESS_DENIED|ENETUNREACH|ENETDOWN/i],
  ['nav_blocked', /ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_ADMINISTRATOR|ERR_UNSAFE_PORT/i],
  ['nav_aborted', /ERR_ABORTED|ERR_FAILED \((-2|-3)\)/i],
]

/**
 * Chromium's own error token, when the message carries one.
 * @param {string} raw
 * @returns {string | null}
 */
export function chromeErrorCode(raw) {
  const match = /(ERR_[A-Z][A-Z0-9_]+)/.exec(String(raw ?? ''))
  return match === null ? null : match[1]
}

/**
 * @param {unknown} raw - the message the panel reported.
 * @returns {{stage: string, explain: string, code: string | null, retryable: boolean}}
 *   `retryable` is a hint, not a promise: a certificate failure will not fix
 *   itself, while a reset or a timeout often does.
 */
export function classifyNavigationFailure(raw) {
  const text = String(raw ?? '')
  for (const [stage, pattern] of RULES) {
    if (pattern.test(text)) {
      return {
        stage,
        explain: STAGES[stage],
        code: chromeErrorCode(text),
        retryable: stage !== 'nav_cert' && stage !== 'nav_dns' && stage !== 'nav_blocked',
      }
    }
  }
  return { stage: 'nav_unknown', explain: STAGES.nav_unknown, code: chromeErrorCode(text), retryable: true }
}

/**
 * One sentence the model can act on, given what the panel did afterwards.
 *
 * @param {{stage: string, explain: string, code: string | null, retryable: boolean}} classified
 * @param {{url?: string, previousUrl?: string, restored?: boolean}} navigation
 * @returns {string}
 */
export function navigationFailureText(classified, navigation = {}) {
  const target = typeof navigation.url === 'string' && navigation.url !== '' ? navigation.url : '(unknown address)'
  const code = classified.code === null ? '' : ` (${classified.code})`
  const head = `${classified.stage}: ${classified.explain}${code}: ${target}`
  if (navigation.restored === true && typeof navigation.previousUrl === 'string' && navigation.previousUrl !== '') {
    return `${head}. The panel went back to ${navigation.previousUrl}, so that page is still there.`
  }
  return `${head}. The panel could not go back, so it is showing the browser's error page; `
    + 'open a reachable address (or the previous page) before reading it.'
}

/** The stage vocabulary, exported for docs/tests. */
export const NAVIGATION_STAGES = Object.freeze(Object.keys(STAGES))
