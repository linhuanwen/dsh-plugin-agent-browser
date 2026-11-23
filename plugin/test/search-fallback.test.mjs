/**
 * Tests for the failed-open search fallback (TICKET-027).
 *
 * Run with: node --test plugin/test/search-fallback.test.mjs
 *
 * The rules this file pins, in the order the design depends on them:
 * 1. off by default — a default row must never search, and never even look for
 *    the `web` service;
 * 2. on, it is exactly one search per failure, `sources` only (`content` must
 *    not leak into the message: it is provider prose, not the page);
 * 3. candidates are same-site, capped, and say `opened: false`;
 * 4. only `navigation_failed` and `needs_human` are enriched — a refusal is not
 *    a navigation problem and must stay byte-for-byte the TICKET-013 error;
 * 5. any search-side failure leaves the original error untouched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSearchFallback,
  enrichOpenFailure,
  expectedProvider,
  hostOf,
  pathWords,
  pickAlternatives,
  routeOf,
  siteQuery,
} from '../search-fallback.js'
import { AgentBrowserError } from '../errors.js'

/** A web service that records calls and returns fixed sources. */
function fakeWeb(sources, options = {}) {
  const calls = []
  return {
    calls,
    searchReady: async () => options.ready ?? true,
    async search(request, signal) {
      calls.push({ request, aborted: signal?.aborted === true })
      if (options.error !== undefined) throw options.error
      return {
        // Provider prose must never reach the model through this path.
        content: 'SUMMARY THAT MUST NOT LEAK',
        sources,
        truncated: false,
      }
    },
  }
}

/** A classified failure, shaped like TICKET-013's output. */
function navigationError(url) {
  return new AgentBrowserError('navigation_failed', `navigation_failed: nav_dns: could not resolve ${url}`, {
    retryable: true,
    details: { url, stage: 'nav_dns', code: 'ERR_NAME_NOT_RESOLVED' },
  })
}

test('siteQuery names the host and the most specific path words', () => {
  assert.equal(
    siteQuery('https://www.example.com/docs/getting-started.html'),
    'example.com docs getting started',
  )
  assert.equal(siteQuery('https://example.com/'), 'example.com')
  // Path segments that say nothing are dropped, numbers with them.
  assert.equal(siteQuery('https://example.com/index.html'), 'example.com')
  assert.equal(siteQuery('https://example.com/blog/2024/12/remote-work-policy'), 'example.com blog remote work policy')
  // A non-http(s) address has no site to scope a search to.
  assert.equal(siteQuery('chrome-error://chromewebdata/'), null)
  assert.equal(siteQuery('not a url'), null)
  // Percent-encoded segments are decoded before they become words.
  assert.equal(siteQuery('https://example.com/caf%C3%A9/menu'), 'example.com café menu')
})

test('hostOf and pathWords are the pieces of the query', () => {
  assert.equal(hostOf('https://www.Example.COM/a'), 'example.com')
  assert.equal(hostOf('chrome-error://chromewebdata/'), null)
  assert.deepEqual(pathWords('https://example.com/alpha/beta/gamma/delta', 2), ['alpha', 'beta'])
  assert.deepEqual(pathWords('https://example.com/'), [])
})

test('expectedProvider mirrors dsh-web: only DeepSeek routes get the free provider', () => {
  assert.equal(expectedProvider('deepseek-official'), 'deepseek-official')
  assert.equal(expectedProvider('deepseek-account'), 'deepseek-official')
  assert.equal(expectedProvider('opencode-go'), 'deepseek-search-api')
  assert.equal(expectedProvider(undefined), 'deepseek-search-api')
})

test('routeOf reads the session request context and never throws', () => {
  assert.equal(routeOf({ agent: { session: { requestContext: () => ({ provider: 'opencode-go' }) } } }), 'opencode-go')
  assert.equal(routeOf({ agent: { session: { requestContext: () => ({}) } } }), undefined)
  assert.equal(routeOf({ agent: { session: { requestContext: () => { throw new Error('boom') } } } }), undefined)
  assert.equal(routeOf(undefined), undefined)
})

test('pickAlternatives keeps the same site, drops the failed address and caps', () => {
  const picked = pickAlternatives(
    [
      { url: 'https://example.com/a', title: 'A' },
      { url: 'https://example.com/b', title: '  ' },
      { url: 'https://bar.example.com/c' },
      { url: 'https://other.test/d' },
      { url: 'https://example.com/failed' },
      { url: 'https://example.com/a', title: 'A again' },
    ],
    'example.com',
    'https://example.com/failed',
    2,
  )
  assert.equal(picked.length, 2)
  assert.equal(picked[0].title, 'A')
  // An untitled source falls back to its own host, never to an empty string.
  assert.equal(picked[1].title, 'example.com')
  assert.match(picked[0].why, /same site, found by search/)
})

test('a default (off) row never searches and leaves the failure alone', async () => {
  const web = fakeWeb([{ url: 'https://example.com/x' }])
  let looked = 0
  const fallback = createSearchFallback({
    config: { enabled: false, maxResults: 5 },
    getWeb: () => { looked += 1; return web },
  })
  const original = navigationError('https://example.com/')
  const enriched = await enrichOpenFailure(original, 'https://example.com/', fallback, { exec: {} })
  assert.equal(enriched, original)
  assert.equal(web.calls.length, 0)
  // Off means "do not even look for the web service": no cap lookup, no log, no cost.
  assert.equal(looked, 0)
  assert.equal(fallback.enabled(), false)
})

test('a volatile reader is re-read on every failed open', async () => {
  const web = fakeWeb([{ url: 'https://example.com/x', title: 'X' }])
  let enabled = false
  const fallback = createSearchFallback({ config: { enabled: { get: () => enabled }, maxResults: 5 }, getWeb: () => web })
  const first = await enrichOpenFailure(navigationError('https://example.com/'), 'https://example.com/', fallback, {})
  assert.equal(first instanceof AgentBrowserError, true)
  assert.equal(web.calls.length, 0)
  enabled = true
  const second = await enrichOpenFailure(navigationError('https://example.com/'), 'https://example.com/', fallback, {})
  assert.equal(web.calls.length, 1)
  assert.match(second.message, /Search fallback \(1 call/)
})

test('one failure makes exactly one search and attaches same-site candidates', async () => {
  const web = fakeWeb([
    { url: 'https://example.com/docs', title: 'Docs' },
    { url: 'https://other.test/nope', title: 'Nope' },
  ])
  const fallback = createSearchFallback({
    config: { enabled: true, maxResults: 5 },
    getWeb: () => web,
    log: () => {},
  })
  const error = await enrichOpenFailure(
    navigationError('https://example.com/getting-started'),
    'https://example.com/getting-started',
    fallback,
    { exec: { agent: { session: { requestContext: () => ({ provider: 'opencode-go' }) } } } },
  )
  assert.equal(web.calls.length, 1)
  assert.deepEqual(web.calls[0].request, {
    query: 'example.com getting started',
    maxResults: 5,
    llmProvider: 'opencode-go',
  })
  // The classified failure survives: same code, same retryability.
  assert.equal(error.code, 'navigation_failed')
  assert.equal(error.retryable, true)
  assert.equal(error.details.alternatives.length, 1)
  assert.equal(error.details.alternatives[0].url, 'https://example.com/docs')
  assert.deepEqual(error.details.searchFallback, {
    query: 'example.com getting started',
    provider: 'deepseek-search-api',
    route: 'opencode-go',
    calls: 1,
    opened: false,
  })
  assert.match(error.message, /Search fallback \(1 call, provider≈deepseek-search-api/)
  assert.match(error.message, /Nothing was opened \(opened: false\)/)
  assert.match(error.message, /example\.com\/docs/)
  // Provider prose is dropped, not passed through.
  assert.doesNotMatch(error.message, /MUST NOT LEAK/)
})

test('the trigger matrix: only navigation_failed and needs_human are enriched', async () => {
  const web = fakeWeb([{ url: 'https://example.com/x', title: 'X' }])
  const fallback = createSearchFallback({ config: { enabled: true }, getWeb: () => web })
  const enriched = ['navigation_failed', 'needs_human']
  const refused = ['scheme_rejected', 'eval_disabled', 'download_rejected', 'bridge_timeout', 'panel_not_open', 'cancelled']
  for (const code of enriched) {
    web.calls.length = 0
    const original = new AgentBrowserError(code, `${code}: explanation`, {
      retryable: code === 'navigation_failed',
      details: { url: 'https://example.com/a' },
    })
    const result = await enrichOpenFailure(original, 'https://example.com/a', fallback, {})
    assert.notEqual(result, original, `${code} should be enriched`)
    assert.equal(web.calls.length, 1, `${code} should search once`)
  }
  for (const code of refused) {
    web.calls.length = 0
    const original = new AgentBrowserError(code, `${code}: explanation`)
    const result = await enrichOpenFailure(original, 'https://example.com/a', fallback, {})
    assert.equal(result, original, `${code} must not be enriched`)
    assert.equal(web.calls.length, 0, `${code} must not search`)
  }
})

test('a host without ctx.web leaves the failure untouched', async () => {
  const fallback = createSearchFallback({
    config: { enabled: true },
    getWeb: () => null,
    log: () => {},
  })
  const original = navigationError('https://example.com/')
  assert.equal(await enrichOpenFailure(original, 'https://example.com/', fallback, {}), original)
})

test('a search that fails, or returns nothing on the site, changes nothing', async () => {
  for (const options of [
    { error: new Error('WEB_PROVIDER_UNAVAILABLE') },
    { sources: [] },
    { sources: [{ url: 'https://elsewhere.test/x' }] },
    { sources: null },
  ]) {
    const web = fakeWeb(options.sources ?? [], options.error === undefined ? {} : { error: options.error })
    const fallback = createSearchFallback({ config: { enabled: true }, getWeb: () => web, log: () => {} })
    const original = navigationError('https://example.com/')
    const result = await enrichOpenFailure(original, 'https://example.com/', fallback, {})
    assert.equal(result, original, JSON.stringify(Object.keys(options)))
    assert.equal(web.calls.length, 1)
  }
})

test('searchReady false skips the billed call entirely', async () => {
  const web = fakeWeb([{ url: 'https://example.com/x' }], { ready: false })
  const fallback = createSearchFallback({ config: { enabled: true }, getWeb: () => web, log: () => {} })
  const original = navigationError('https://example.com/')
  assert.equal(await enrichOpenFailure(original, 'https://example.com/', fallback, {}), original)
  assert.equal(web.calls.length, 0)
})

test('a needs_human failure also gets candidates', async () => {
  const web = fakeWeb([{ url: 'https://example.com/other', title: 'Other' }])
  const fallback = createSearchFallback({ config: { enabled: true, maxResults: 3 }, getWeb: () => web, log: () => {} })
  const original = new AgentBrowserError('needs_human', 'needs_human: a human verification step is on screen')
  const result = await enrichOpenFailure(original, 'https://example.com/', fallback, { signal: AbortSignal.timeout(5_000) })
  assert.equal(result.code, 'needs_human')
  assert.equal(web.calls.length, 1)
  assert.equal(result.details.alternatives.length, 1)
})

test('maxResults is clamped to 1–10', async () => {
  const sources = Array.from({ length: 12 }, (_, index) => ({ url: `https://example.com/${index}`, title: `S${index}` }))
  for (const [configured, expected] of [[0, 5], [-3, 5], ['x', 5], [1, 1], [99, 10], [3, 3]]) {
    const web = fakeWeb(sources)
    const fallback = createSearchFallback({ config: { enabled: true, maxResults: configured }, getWeb: () => web, log: () => {} })
    const result = await enrichOpenFailure(navigationError('https://example.com/'), 'https://example.com/', fallback, {})
    assert.equal(web.calls[0].request.maxResults, expected, `configured ${configured}`)
    assert.equal(result.details.alternatives.length, expected, `configured ${configured}`)
  }
})
