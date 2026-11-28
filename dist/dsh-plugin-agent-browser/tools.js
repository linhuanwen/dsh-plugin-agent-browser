/**
 * The tools the agent sees.
 *
 * Every tool here is a thin shell: validate, ask the panel to do it, return
 * what the panel says. All browser state lives in the panel (it owns the
 * `<webview>`), so nothing in this file caches a page.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, extname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import { activationPolicy, DEFAULT_ACTIVATION } from './activation.js'
import {
  clickClass,
  createGrantBook,
  normalizeApprovals,
  originOf,
  pressClass,
  shouldConfirm,
  SUBMIT_KEYS,
  summarize,
} from './approvals.js'
import { short } from './bridge.js'
import { readField } from './config.js'
import { DownloadError, downloadTo } from './downloads.js'
import { AgentBrowserError, isAgentBrowserError } from './errors.js'
import { classifyNavigationFailure, navigationFailureText } from './navigation.js'
import { createPolicy } from './policy.js'
import { createSearchFallback, enrichOpenFailure } from './search-fallback.js'
import { urlForPath } from './static.js'
import { createTimeline, summarizeArgs } from './timeline.js'

/**
 * TICKET-013: turn the panel's raw navigation crash into a classified error.
 *
 * The panel reports the Electron remote-method wrapper plus whether it managed
 * to put the previous page back; the classification itself lives here, where it
 * is unit-tested, so the message names the failure (`nav_dns`, `nav_reset`, …)
 * and says whether the page the user was on survived.
 *
 * @param {unknown} error - whatever `bridge.request` threw.
 * @param {string} url - the address that was being opened.
 * @returns {unknown} the classified `AgentBrowserError`, or the original error.
 */
export function classifyOpenFailure(error, url) {
  if (isAgentBrowserError(error) === false || error.code !== 'navigation_failed') return error
  const navigation = { url, ...(error.details ?? {}) }
  const classified = classifyNavigationFailure(navigation.raw ?? error.message)
  return new AgentBrowserError('navigation_failed', navigationFailureText(classified, navigation), {
    cause: error,
    retryable: classified.retryable,
    details: { ...navigation, stage: classified.stage, code: classified.code },
  })
}

/**
 * Per-call async context: the `exec.signal` of the tool call currently running.
 *
 * The tools are built once and shared, while `exec` is per call, so the signal
 * cannot live on the gate object. `createTools` runs every tool body inside this
 * store and the gate reads it, which keeps cancellation to one place instead of
 * eleven hand-threaded parameters.
 */
const execSignals = new AsyncLocalStorage()

/**
 * The in-page traversal used by `browser_snapshot`.
 *
 * It is shipped as text rather than imported because it has to run inside the
 * guest page (via `executeJavaScript`), which shares no scope with the host.
 * Read on every call, not at load: the host module can outlive a file edit, and
 * a stale traversal is much harder to notice than a 12 KB read.
 * @returns {string} the source of `dshSnapshot`.
 */
export function snapshotSource() {
  return readFileSync(new URL('./inject/snapshot.js', import.meta.url), 'utf8')
}

/**
 * The click guards the panel injects on every document it loads.
 *
 * TICKET-032: the same guards live in `inject/actions.js`, but those are only
 * installed when an action command runs. A person who takes over a fresh page
 * clicks before any command, so the panel injects this file on `dom-ready` and
 * after every navigation. Served through the bridge (`/source?name=guards`)
 * rather than bundled into the client, so there is exactly one copy.
 * @returns {string} the source of `dshGuards`.
 */
export function guardsSource() {
  return readFileSync(new URL('./inject/guards.js', import.meta.url), 'utf8')
}

/**
 * The in-page human-verification detector.
 *
 * Same shipping rule as the snapshot traversal: read on every call, run inside
 * the guest. It only reports; the panel decides what to show and the host
 * decides what to refuse (see `bridge.setPhase` / `bridge.request`).
 * @returns {string} the source of `dshDetect`.
 */
function detectSource() {
  return readFileSync(new URL('./inject/detect.js', import.meta.url), 'utf8')
}

/** One line telling the agent what a handed-back page looks like. */
function digestLine(digest) {
  return digest === '' ? '' : `\n\nWhile you were away: ${digest}`
}

/** A short human-readable size, for the snapshot header. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * Clamp a character budget to its documented range.
 *
 * The host's enforced JSON Schema subset has no `minimum`/`maximum`, so a
 * declared range in `parameters` would not be enforced anywhere; the range is
 * stated in the description and clamped by `policy.clampChars` in the body
 * (TICKET-024 moved that strategy into `plugin/policy.js`).
 */

/** Where a tool call is coming from: one session is one panel. */
function sessionOf(exec) {
  const sessionId = exec?.agent?.id
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('browser tools need an agent session; this call has none')
  }
  return sessionId
}

/**
 * `browser_open` — make the panel show a URL, or a file from the workspace.
 *
 * A `path` argument is served from a loopback static server rooted at the
 * session's working directory, because the panel cannot load `file://` (the
 * main process allows only http/https navigation). The server is reused per
 * root, so opening three pages from one workspace keeps one port.
 * The panel may not exist yet: the host queues the command, the client-side
 * watcher opens the tab as soon as it sees it, and the tool resolves when the
 * page is loaded.
 * @param {import('cordis').Context} ctx - host context, for `workingDirectory`.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 * @param {import('./static.js').StaticSites} sites - workspace file servers.
 * @param {{
 *   navigationTimeoutMs?: number,
 *   rules?: ReturnType<typeof createPolicy>,
 *   fallback?: ReturnType<typeof createSearchFallback>,
 * }} [options] - per-call budget, the policy object, and the optional search fallback (TICKET-027), all from config.
 */
export function browserOpenTool(ctx, bridge, sites, options = {}) {
  const navigationTimeoutMs = Number.isInteger(options.navigationTimeoutMs) && options.navigationTimeoutMs > 0
    ? options.navigationTimeoutMs
    : 45_000
  const rules = options.rules ?? createPolicy()
  // No fallback passed (a test, or a host without `ctx.web`) means this tool
  // always behaves like 1.4.x: the failure is classified and stopped there.
  const fallback = options.fallback ?? createSearchFallback()
  return {
    name: 'browser_open',
    description:
      'Open a URL in the visible browser panel beside the conversation and wait until it is loaded. '
      + 'Pass `path` instead of `url` to open an HTML file from the workspace (e.g. a prototype or a chart): '
      + 'it is served read-only over loopback from the session working directory. '
      + 'Use this before any other browser tool. The panel is a real browser the user can watch and take over. '
      + 'Pass `newTab: true` to open the page in an additional panel tab instead of replacing the current one; '
      + 'use `browser_tabs` to list, switch and close tabs. '
      + 'When to use it: the page needs the user\'s own logged-in session (dashboard, orders, mail, member-only '
      + 'content), needs JavaScript or clicking/typing/scrolling to reach the content, needs a file download, or '
      + 'needs a screenshot as evidence. When not to: a public static article — `web_fetch` returns clean Markdown '
      + 'in one call without opening the panel; find its URL with `web_search` first and come back here only if '
      + 'that fails (403, login wall, empty JavaScript shell).',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http(s) URL, e.g. "https://example.com".',
        },
        path: {
          type: 'string',
          description:
            'A file in the workspace, relative to the session working directory (e.g. "demo.html" or '
            + '"prototypes/map/index.html"). Served read-only over loopback; `..` is refused. '
            + 'Ignored when `url` is given.',
        },
        newTab: {
          type: 'boolean',
          description:
            'Open in a new panel tab (the current page stays alive behind it). Default false: '
            + 'the current tab navigates. Ignored when the panel has no page yet.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          port: { type: 'integer' },
          root: { type: 'string' },
          needs_human: { type: 'boolean' },
          hint: { type: 'string' },
          signals: { type: 'array', items: { type: 'string' } },
        },
        required: ['url'],
      },
      render(_args, value) {
        const title = typeof value?.title === 'string' && value.title !== '' ? ` — ${value.title}` : ''
        const served = typeof value?.port === 'number'
          ? `\n\nServed from the workspace by a read-only local server on port ${value.port} (root: ${value?.root ?? '?'}).`
          : ''
        const warned = value?.needs_human === true
          ? `\n\nneeds_human: ${value?.hint ?? 'this page is asking for a human.'}`
          : ''
        return [{ type: 'text', text: `Opened ${value?.url ?? '(unknown)'}${title}${served}${warned}` }]
      },
      /**
       * What the conversation card shows (TICKET-023): the tool name keys a
       * `tool.call.toolview` slot, so the row can be a link instead of prose.
       * Values must stay lossless JSON — it is persisted with the record.
       */
      presentationMeta(args, value) {
        const meta = {}
        if (typeof value?.url === 'string' && value.url !== '') meta.url = value.url
        if (typeof value?.title === 'string' && value.title !== '') meta.title = value.title
        if (typeof args?.path === 'string' && args.path.trim() !== '') meta.path = args.path.trim()
        if (value?.needs_human === true) meta.needsHuman = true
        return meta
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const wantsUrl = typeof args?.url === 'string' && args.url.trim() !== ''
      const wantsPath = typeof args?.path === 'string' && args.path.trim() !== ''
      if (!wantsUrl && !wantsPath) {
        throw new Error('pass `url` (an http(s) address) or `path` (a file in the workspace) to browser_open')
      }

      let url
      let site
      if (wantsUrl) {
        url = rules.checkOpen(normalizeUrl(args.url))
      } else {
        const root = await workspaceOf(ctx, exec)
        site = await sites.ensure(root)
        url = urlForPath(site.url, site.root, args.path, site.token)
      }

      let opened
      try {
        opened = await bridge.request(
          sessionId,
          'open',
          { url, detect: detectSource(), ...(args?.newTab === true ? { newTab: true } : {}) },
          navigationTimeoutMs,
        )
      } catch (error) {
        // TICKET-013 classifies the failure; TICKET-027 may append candidates to
        // it. The fallback never runs for a refusal (only `navigation_failed` /
        // `needs_human`), and never opens anything.
        throw await enrichOpenFailure(classifyOpenFailure(error, url), url, fallback, {
          exec,
          ...(execSignals.getStore()?.signal === undefined ? {} : { signal: execSignals.getStore().signal }),
        })
      }
      const result = opened
      const value = {
        url: typeof result?.url === 'string' && result.url !== '' ? result.url : url,
        ...(typeof result?.title === 'string' && result.title !== '' ? { title: result.title } : {}),
      }
      if (site !== undefined) {
        value.port = site.port
        value.root = site.root
      }
      if (result?.needsHuman === true) {
        value.needs_human = true
        value.hint = 'a human verification step is on screen. Ask the user to complete it in the panel, '
          + 'then take a browser_snapshot to see whether it is gone.'
        if (Array.isArray(result.signals)) value.signals = result.signals.map(String).slice(0, 6)
      }
      return value
    },
    /** The panel navigates one page at a time; parallel opens would race. */
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      return { card: 'generic', title: 'Open in browser', kind: 'fetch', rawInput: args }
    },
    presentResult(_args, result) {
      return { card: 'generic', title: `Browser${result?.isError === true ? ' failed' : ' opened'}` }
    },
  }
}

/**
 * `browser_tabs` — list, switch and close the panel's tabs (TICKET-050).
 *
 * Panel bookkeeping only: no page is touched, no request reaches the site, and
 * nothing needs an approval. The agent always drives the *active* tab, so this
 * is how it finds the ids and decides which page the next call works on.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 * @returns {object} the tool definition.
 */
export function browserTabsTool(bridge) {
  return {
    name: 'browser_tabs',
    description:
      'List, switch or close the tabs of the visible browser panel. The agent always drives the active tab: '
      + 'open another page with browser_open({ newTab: true }), then use this tool to see which tabs exist and '
      + 'choose one. Switching keeps every tab\'s page state (form input, scroll, history); closing destroys that '
      + 'page (the last tab is never removed). `list` still works while a human has the panel; `switch` and '
      + '`close` are refused then, so a verification page cannot be hidden or pulled away.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'switch', 'close'],
          description: 'What to do with the tabs.',
        },
        tab: {
          type: 'string',
          description: 'Tab id from a previous list (e.g. "t2"). Required for switch and close.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          tabs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                url: { type: 'string' },
                active: { type: 'boolean' },
              },
              required: ['id'],
            },
          },
          active: { type: 'string' },
          tab: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          closed: { type: 'string' },
        },
        required: ['action', 'tabs'],
      },
      render(_args, value) {
        const tabs = Array.isArray(value?.tabs) ? value.tabs : []
        if (tabs.length === 0) return [{ type: 'text', text: 'The browser panel has no tabs.' }]
        const lines = tabs.map((tab) => {
          const mark = tab?.active === true ? '* ' : '  '
          const title = typeof tab?.title === 'string' && tab.title !== '' ? tab.title : '(untitled)'
          const url = typeof tab?.url === 'string' && tab.url !== '' ? ` — ${tab.url}` : ''
          return `${mark}${tab?.id ?? '?'}: ${title}${url}`
        })
        const head = value?.action === 'switch' && typeof value?.tab === 'string'
          ? `Switched to ${value.tab}.`
          : value?.action === 'close' && typeof value?.closed === 'string'
            ? `Closed ${value.closed}.`
            : `${tabs.length} tab(s), active ${value?.active ?? '?'}.`
        return [{ type: 'text', text: `${head}\n\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const action = args?.action
      if (action !== 'list' && action !== 'switch' && action !== 'close') {
        throw new Error('browser_tabs needs `action`: "list", "switch" or "close"')
      }
      const tab = typeof args?.tab === 'string' ? args.tab.trim() : ''
      if (action !== 'list' && tab === '') {
        throw new Error(`browser_tabs {action:"${action}"} needs \`tab\`: an id from browser_tabs({action:"list"})`)
      }
      const result = await bridge.request(sessionId, 'tabs', { action, ...(tab === '' ? {} : { tab }) }, 20_000)
      const tabs = Array.isArray(result?.tabs)
        ? result.tabs.map((entry) => ({
          id: String(entry?.id ?? ''),
          ...(typeof entry?.title === 'string' ? { title: entry.title } : {}),
          ...(typeof entry?.url === 'string' ? { url: entry.url } : {}),
          active: entry?.active === true,
        }))
        : []
      const value = { action, tabs, ...(typeof result?.active === 'string' ? { active: result.active } : {}) }
      if (typeof result?.tab === 'string') value.tab = result.tab
      if (typeof result?.url === 'string') value.url = result.url
      if (typeof result?.title === 'string') value.title = result.title
      if (typeof result?.closed === 'string') value.closed = result.closed
      return value
    },
    /** The tab it switches to is where the next click lands: keep it serial. */
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      return { card: 'generic', title: 'Browser tabs', kind: 'fetch', rawInput: args }
    },
    presentResult(_args, result) {
      return { card: 'generic', title: `Browser tabs${result?.isError === true ? ' failed' : ''}` }
    },
  }
}

/**
 * `browser_snapshot` — read the page as an accessibility tree, with a picture.
 *
 * The tree is produced by the page itself (see `inject/snapshot.js`), so the
 * host only has to ship the source across and turn the returned PNG into an
 * attachment. Refs (`[ref=e3]`) live in the page as `data-dsh-ref` attributes;
 * the action tools resolve them by selector, so nothing has to be kept in sync
 * between calls.
 * @param {import('cordis').Context} ctx - host context, for `ctx.attachments`.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 * @param {{ maxChars?: number, rules?: ReturnType<typeof createPolicy> }} [options] - default character budget and the policy object, both from config.
 */
export function browserSnapshotTool(ctx, bridge, options = {}) {
  const defaultMaxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : 8000
  const rules = options.rules ?? createPolicy()
  const MIN_CHARS = 500
  const MAX_CHARS = 30_000
  return {
    name: 'browser_snapshot',
    description:
      'Read the current page of the browser panel as a compact accessibility tree plus a screenshot, '
      + 'and number the things you can act on as [ref=e1], [ref=e2], … Pass those refs (or an iframe '
      + 'prefix like f1e2) to browser_click / browser_type / browser_press. Refs are only valid for '
      + 'the snapshot that produced them; take a new snapshot after the page changes. '
      + 'Each ref may also carry a stable locator like [loc="css:#save"]: that locator survives ref '
      + 'renumbering, so when you work from an older snapshot pass loc instead of ref and the action '
      + 'still lands on the same element (a page that re-rendered away from it answers stale_loc). '
      + 'When the tree is cut at the character budget the result also carries a cursor: call '
      + 'browser_snapshot again with that cursor to read the next slice without repeating the earlier '
      + 'lines (a page that changed under the cursor answers stale_cursor; take a fresh snapshot). '
      + 'When the page logged or threw since the last snapshot, the tail of its console is appended '
      + '(last 10 entries; the guards drain it on each snapshot, so nothing repeats). '
      + 'Failed requests the page itself sent with fetch/XHR are appended the same way '
      + '(status or transport error, last 10, with the total request count); successes are only counted. '
      + 'Use it once the panel already holds the page (opened by browser_open, or by the user); for a public '
      + 'static page that `web_fetch` can read, that call is cheaper and needs no panel.',
    parameters: {
      type: 'object',
      properties: {
        includeImage: {
          type: 'boolean',
          description: 'Also return a screenshot of the panel. Defaults to true; false saves a turn of vision budget.',
        },
        maxChars: {
          type: 'integer',
          // The host's enforced JSON Schema subset has no `minimum`/`maximum`
          // keyword, so the range is stated in text and clamped in the tool body.
          description: `Character budget for the tree, clamped to 500–30000. Defaults to ${defaultMaxChars}; the tree is cut at a line boundary.`,
        },
        cursor: {
          type: 'string',
          description: 'Continue a snapshot that was cut at the budget: pass the cursor the previous snapshot returned. Do not combine with a new full read; the page must not have changed (otherwise stale_cursor).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          gen: { type: 'integer' },
          text: { type: 'string' },
          refCount: { type: 'integer' },
          truncated: { type: 'boolean' },
          cursor: { type: 'string' },
          more: { type: 'boolean' },
          totalLines: { type: 'integer' },
          from: { type: 'integer' },
          nextOffset: { type: 'integer' },
          nodes: { type: 'integer' },
          visited: { type: 'integer' },
          ms: { type: 'integer' },
          needs_human: { type: 'boolean' },
          hint: { type: 'string' },
          signals: { type: 'array', items: { type: 'string' } },
          dialogs: { type: 'array', items: { type: 'string' } },
          console: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                level: { type: 'string' },
                text: { type: 'string' },
              },
              required: ['level', 'text'],
            },
          },
          network: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                method: { type: 'string' },
                url: { type: 'string' },
                status: { type: 'integer' },
                ms: { type: 'integer' },
                error: { type: 'string' },
              },
              required: ['kind', 'method', 'url', 'status', 'ms'],
            },
          },
          networkTotal: { type: 'integer' },
          digest: { type: 'string' },
          image: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
            required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
          },
        },
        required: ['url', 'gen', 'text', 'refCount', 'truncated'],
      },
      render(_args, value) {
        const chars = typeof value?.text === 'string' ? value.text.length : 0
        const size = `${formatBytes(chars + (value?.image ? value.image.bytes : 0))}`
        const counts = `${value?.refCount ?? 0} refs · ${value?.nodes ?? 0} lines · ${value?.visited ?? 0} nodes walked · ${value?.ms ?? 0}ms · ${size}`
        const continued = Number.isInteger(value?.from) && value.from > 0 ? ` continued at line ${value.from + 1}/${value?.totalLines ?? 0}` : ''
        const header = `Snapshot gen ${value?.gen ?? 0} · ${counts}${continued}`
        const footer = value?.more === true
          ? `\n… tree cut at the character budget (${value?.nextOffset ?? 0}/${value?.totalLines ?? 0} lines delivered). `
            + `Call browser_snapshot({cursor:${JSON.stringify(String(value?.cursor ?? ''))}}) for the next slice.`
          : ''
        const warned = value?.needs_human === true
          ? `\n\nneeds_human: true — ${value?.hint ?? 'this page is asking for a human.'}`
          : ''
        const dialogs = dialogNote(value)
        const consoled = consoleNote(value)
        const networked = networkNote(value)
        const blocks = [{ type: 'text', text: `${header}\n${value?.text ?? ''}${footer}${warned}${dialogs}${networked}${consoled}${digestLine(String(value?.digest ?? ''))}` }]
        if (value?.image) blocks.push({ type: 'image', attachment: value.image })
        return blocks
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const maxChars = Number.isFinite(args?.maxChars) ? rules.clampChars(args.maxChars, MAX_CHARS, MIN_CHARS) : defaultMaxChars
      const cursor = typeof args?.cursor === 'string' ? args.cursor.trim() : ''
      if (cursor.length > 300) throw new Error('cursor is not a value this plugin issued; take a fresh browser_snapshot and use the cursor it returns.')
      const includeImage = args?.includeImage === true || (args?.includeImage !== false && cursor === '')
      const result = await bridge.request(
        sessionId,
        'snapshot',
        { source: snapshotSource(), detect: detectSource(), maxChars, includeImage, cursor },
        30_000,
      )
      if (result?.stale === true) {
        throw new AgentBrowserError('stale_cursor', 'the page changed since that cursor was issued; take a fresh browser_snapshot and continue from the cursor it returns.', {
          details: { totalLines: Number.isInteger(result?.totalLines) ? result.totalLines : 0 },
        })
      }
      const value = {
        url: typeof result?.url === 'string' ? result.url : '',
        title: typeof result?.title === 'string' ? result.title : '',
        gen: Number.isInteger(result?.gen) ? result.gen : 0,
        text: typeof result?.text === 'string' ? result.text : '',
        refCount: Number.isInteger(result?.refCount) ? result.refCount : 0,
        truncated: result?.truncated === true,
        cursor: typeof result?.cursor === 'string' ? result.cursor : '',
        more: result?.more === true,
        totalLines: Number.isInteger(result?.totalLines) ? result.totalLines : 0,
        from: Number.isInteger(result?.from) ? result.from : 0,
        nextOffset: Number.isInteger(result?.nextOffset) ? result.nextOffset : 0,
        nodes: Number.isInteger(result?.nodeCount) ? result.nodeCount : 0,
        visited: Number.isInteger(result?.visited) ? result.visited : 0,
        ms: Number.isInteger(result?.ms) ? result.ms : 0,
        digest: bridge.takeDigest(sessionId),
      }
      if (result?.detection?.hit === true) {
        value.needs_human = true
        value.hint = 'the page is showing a human verification step. Ask the user to finish it in the panel, '
          + 'then take a new snapshot — reads keep working, input tools are refused until it is gone.'
        value.signals = Array.isArray(result.detection.signals)
          ? result.detection.signals.map((signal) => `${signal.kind}:${signal.detail}`).slice(0, 8)
          : []
      }
      if (Array.isArray(result?.dialogs) && result.dialogs.length > 0) {
        value.dialogs = result.dialogs.map(String).slice(0, 5)
      }
      if (Array.isArray(result?.console) && result.console.length > 0) {
        value.console = result.console
          .filter((entry) => entry !== null && typeof entry === 'object')
          .map((entry) => ({ level: String(entry?.level ?? 'log'), text: String(entry?.text ?? '') }))
          .slice(0, 40)
      }
      if (Array.isArray(result?.network) && result.network.length > 0) {
        value.network = result.network
          .filter((entry) => entry !== null && typeof entry === 'object')
          .map((entry) => ({
            kind: String(entry?.kind ?? 'fetch'),
            method: String(entry?.method ?? 'GET'),
            url: String(entry?.url ?? ''),
            status: Number.isInteger(entry?.status) ? entry.status : 0,
            ms: Number.isInteger(entry?.ms) ? entry.ms : 0,
            ...(typeof entry?.error === 'string' && entry.error !== '' ? { error: entry.error } : {}),
          }))
          .slice(0, 40)
      }
      if (Number.isInteger(result?.networkTotal) && result.networkTotal > 0) value.networkTotal = result.networkTotal
      if (typeof result?.image === 'string' && result.image !== '') {
        const image = await saveScreenshot(ctx, result.image)
        if (image) return { ...value, image }
        value.text += '\n\n(The screenshot could not be attached; the tree above is still complete.)'
      }
      return value
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      return { card: 'generic', title: 'Browse page', kind: 'read', rawInput: args }
    },
    presentResult() {
      return { card: 'generic', title: 'Page snapshot' }
    },
  }
}

/**
 * Turn the panel's base64 PNG into an image attachment.
 *
 * The image block the model sees is `{ type: 'image', attachment }`, so the
 * bytes have to be registered with the attachment service first; the reference
 * is plain JSON and survives `output.schema` validation.
 * @param {import('cordis').Context} ctx - host context.
 * @param {string} base64 - `data:image/png;base64,…` or bare base64.
 * @returns {Promise<Record<string, unknown> | undefined>} the renderable ref.
 */
async function saveScreenshot(ctx, base64) {
  const attachments = ctx.attachments
  if (!attachments || typeof attachments.saveImage !== 'function') return undefined
  try {
    const payload = base64.startsWith('data:') ? base64.slice(base64.indexOf(',') + 1) : base64
    const data = Buffer.from(payload, 'base64')
    if (data.byteLength === 0) return undefined
    const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType: 'image/png', name: 'browser-snapshot.png' })
    return {
      attachmentId: String(ref.attachmentId),
      mediaType: String(ref.mediaType),
      bytes: Number(ref.bytes),
      width: Number(ref.width),
      height: Number(ref.height),
    }
  } catch {
    return undefined
  }
}

/**
 * Register PNG bytes as an image attachment and return a renderable ref.
 *
 * Same contract as {@link saveScreenshot} but for bytes that are already
 * decoded (the screenshot tool writes them to disk first). The attachment store
 * never deletes objects on its own, so a ref that only lives in a persisted
 * `presentationMeta` still resolves after a restart.
 * @param {import('cordis').Context} ctx - host context.
 * @param {Uint8Array} bytes - PNG bytes.
 * @param {string} name - display name in the attachment store.
 * @returns {Promise<Record<string, unknown> | undefined>} the renderable ref.
 */
async function attachImageBytes(ctx, bytes, name) {
  const attachments = ctx.attachments
  if (!attachments || typeof attachments.saveImage !== 'function') return undefined
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return undefined
  try {
    const ref = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name })
    return {
      attachmentId: String(ref.attachmentId),
      mediaType: String(ref.mediaType),
      bytes: Number(ref.bytes),
      ...(Number.isFinite(ref.width) ? { width: Number(ref.width) } : {}),
      ...(Number.isFinite(ref.height) ? { height: Number(ref.height) } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * The session's working directory, which is what a `path` argument is relative to.
 *
 * `workingDirectory` is read through the context rather than injected: the tool
 * still works for `url` on a harness that has no such service, and a hard
 * dependency would disable every browser tool over one optional argument.
 * @param {import('cordis').Context} ctx - host context.
 * @param {{ agent?: { id: string }, signal?: AbortSignal }} exec - the tool run context.
 * @returns {Promise<string>} the absolute working directory.
 */
async function workspaceOf(ctx, exec) {
  const service = ctx.get?.('workingDirectory') ?? ctx.workingDirectory
  if (service === undefined) {
    throw new Error('this harness has no workingDirectory service, so `path` cannot be resolved; pass `url` instead')
  }
  const agent = exec?.agent
  if (agent === undefined) throw new Error('browser tools need an agent session; this call has none')
  return await service.ensure(agent, exec.signal)
}

/**
 * Normalize what the model passes into an absolute URL.
 *
 * Parsing only: which schemes are allowed is a policy decision, so the scheme
 * gate lives in `plugin/policy.js` (`checkOpen`) and this helper stays unaware
 * of it (TICKET-024).
 * @param {unknown} value - the raw `url` argument.
 * @returns {string} the normalized absolute URL.
 */
export function normalizeUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('url is required')
  }
  const raw = value.trim()
  try {
    return new URL(raw).toString()
  } catch {
    throw new Error(`not an absolute URL: ${short(raw)}`)
  }
}

/**
 * The page-side action helpers, read per call for the same reason as the tree:
 * the host half may outlive the file it was loaded from.
 * @returns {string} the source of `dshAction`.
 */
function actionSource() {
  return readFileSync(new URL('./inject/actions.js', import.meta.url), 'utf8')
}

const REF_HELP = 'Take a new browser_snapshot and use the refs from that answer.'

/**
 * Turn a page-side refusal into an error the model can act on.
 *
 * Every message says what went wrong *and* what to do next; a bare "stale ref"
 * would leave the model guessing whether to retry or give up.
 * @param {Record<string, unknown>} result - the `{ ok: false, error }` payload.
 * @returns {Error} the error to throw.
 */
function actionFailure(result, mode = 'click') {
  const error = actionFailureError(result, mode)
  // TICKET-056: page-level refusals are plain messages on purpose (the model reads
  // the text), but the timeline needs the stable code. Tag the error without
  // touching its message; bridge/approval errors already carry their own code.
  if (error !== null && typeof error === 'object' && error.code === undefined
    && typeof result?.error === 'string' && result.error !== '') {
    error.code = result.error
  }
  return error
}

function actionFailureError(result, mode = 'click') {
  const ref = typeof result?.ref === 'string' ? result.ref : ''
  switch (result?.error) {
    case 'stale_ref':
      return new Error(`ref "${ref}" is no longer in the page; it was replaced or removed. ${REF_HELP}`)
    case 'bad_ref':
      return new Error(`"${ref}" is not a ref. Use a ref from the latest browser_snapshot, e.g. e12 or f1e3.`)
    case 'out_of_view':
      if (mode === 'drag') {
        return new Error(
          `the ${result?.target === true ? 'drop target' : 'source'} is outside the viewport even after scrolling to it, `
          + 'so the drag cannot be completed safely. The page may be moving the element (a sticky bar or lazy loading); '
          + 'take a new browser_snapshot and retry. Nothing was dragged.',
        )
      }
      if (typeof result?.selector === 'string' && result.selector !== '') {
        return new Error(
          `selector ${JSON.stringify(result.selector)} is outside the viewport even after scrolling to it, `
          + `so it cannot be ${mode === 'hover' ? 'hovered' : 'clicked'} safely. The page may be moving the element (a sticky bar or lazy loading); `
          + 'take a new browser_snapshot and retry.',
        )
      }
      return new Error(`ref "${ref}" is outside the viewport, so it cannot be clicked safely. ${REF_HELP}`)
    case 'needs_human':
      return new Error(
        'that field is a password field. Credentials stay with the human: ask the user to type it in the panel, '
        + 'then continue with the rest of the task. Nothing was typed.',
      )
    case 'not_editable':
      return new Error(`ref "${ref}" is not a text field, so there is nothing to type into. ${REF_HELP}`)
    case 'bad_key':
      return new Error(
        `"${result?.key ?? ''}" is not a key this build understands. Try Enter, Tab, Escape, Backspace, `
        + 'ArrowLeft/Right/Up/Down, Home, End, PageUp, PageDown, F1–F12 or a single character, '
        + 'optionally with Alt/Ctrl/Shift/Meta (e.g. "Alt+Left").',
      )
    case 'not_found':
      if (mode === 'scroll') {
        return new Error(
          `no element matched selector ${JSON.stringify(String(result?.selector ?? ''))} `
          + `(${String(result?.matched ?? 0)} node(s)). Pass a CSS selector of a scrollable element, `
          + 'or leave container out to scroll the page itself.',
        )
      }
      return new Error(
        `${mode === 'hover' ? 'nothing to hover' : mode === 'drag' ? 'nothing to drag from' : 'nothing to click'}: ${result?.selector ? `selector ${JSON.stringify(result.selector)}` : 'the target'} `
        + `matched ${String(result?.matched ?? 0)} node(s) and none of them was visible. Take a new browser_snapshot `
        + 'and use a ref, or a selector you can see in the page source.',
      )
    case 'multiple': {
      const names = Array.isArray(result?.candidates)
        ? result.candidates.slice(0, 5).map((candidate) => `${candidate?.role ?? 'node'} "${candidate?.name ?? ''}"`)
        : []
      return new Error(
        `selector ${JSON.stringify(String(result?.selector ?? ''))} matched ${String(result?.matched ?? 0)} visible elements`
        + `${names.length > 0 ? `: ${names.join(', ')}` : ''}. Make it more specific, or pass strict:false to click the first.`,
      )
    }
    case 'occluded': {
      const behind = result?.behind ?? {}
      const what = result?.selector ? `selector ${JSON.stringify(String(result.selector))}` : `ref "${ref}"`
      const cover = String(behind.role ?? 'another element')
        + `${typeof behind.name === 'string' && behind.name !== '' ? ` "${behind.name}"` : ''}`
      if (mode === 'hover') {
        return new Error(
          `${what} is covered by ${cover}, so the pointer would rest on that instead. `
          + 'Move the covering element away (or expose the target), then retry — nothing was hovered.',
        )
      }
      if (mode === 'drag') {
        return new Error(
          `${what} is covered by ${cover}, so the press would land on that instead. `
          + 'Dismiss the overlay (or drag the covering element), then retry. Nothing was dragged.',
        )
      }
      return new Error(
        `${what} is covered by ${cover}, `
        + 'so a click would land on that instead. Dismiss the overlay (or click the covering element), then retry. '
        + 'Nothing was clicked.',
      )
    }
    case 'disabled':
      return new Error(
        `that control is disabled${typeof result?.info?.name === 'string' && result.info.name !== '' ? ` ("${result.info.name}")` : ''}, `
        + `so ${mode === 'drag' ? 'dragging it would do nothing' : 'clicking it would do nothing'}. Look for another control, or wait until the page enables it.`,
      )
    case 'bad_selector':
      return new Error(
        `"${String(result?.selector ?? '')}" is not a usable CSS selector: ${String(result?.message ?? 'the page could not parse it')}`,
      )
    case 'stale_loc':
      return new Error(
        `loc "${String(result?.loc ?? '')}"${typeof result?.frame === 'string' ? ` (in iframe ${result.frame})` : ''} `
        + 'no longer matches anything in the page — it was replaced, removed, or you are on a different page now. '
        + 'Take a new browser_snapshot and use a loc (or ref) from that snapshot.',
      )
    case 'bad_loc':
      return new Error(
        `"${String(result?.loc ?? '')}" is not a loc. Copy the whole loc="css:…" value from the latest browser_snapshot, `
        + 'e.g. css:#save, and pass it as the loc parameter.',
      )
    case 'not_file_input':
      return new Error(
        'that element is not an <input type="file">, so there is no file picker to fill. '
        + 'Snapshot again and point at the file input itself (a styled button usually hides it).',
      )
    case 'no_files':
      return new Error('no files reached the page; pass at least one path in `files`.')
    case 'multiple_not_allowed':
      return new Error(
        'that file input does not accept multiple files, so pass exactly one path in `files` '
        + '(or upload them one at a time).',
      )
    case 'upload_failed':
      return new Error(
        `the page could not accept the files: ${String(result?.message ?? 'the browser refused the handover')}. `
        + 'Nothing was submitted; snapshot again and retry, or ask the user to choose the file in the panel.',
      )
    default:
      return new Error(`the page refused the action: ${String(result?.error ?? 'unknown error')}`)
  }
}

/** Validate a `ref` argument before it reaches the page. */
function requireRef(value) {
  if (typeof value !== 'string' || !/^(f\d+)?e\d+$/.test(value)) {
    throw new Error(`"${String(value ?? '')}" is not a ref. Refs look like e12 or f1e3 and come from browser_snapshot.`)
  }
  return value
}

/** Shared shape for the action results. */
const ACTION_OUTPUT = {
  type: 'object',
  properties: {
    tag: { type: 'string' },
    role: { type: 'string' },
    name: { type: 'string' },
    dialogs: { type: 'array', items: { type: 'string' } },
    // SPEC-004 B4 / TICKET-042: a write result must say whether the page took
    // the action. `none` / `unknown` mostly travel as errors, but the field is
    // declared here so a success card and an error card are read the same way.
    effect: {
      type: 'string',
      enum: ['none', 'committed', 'unknown'],
      description: 'committed = the page acknowledged the write. Errors carry effect in their details: none = nothing was sent, unknown = it may have run.',
    },
  },
}

/**
 * Attach the JS dialogs a page showed while the command ran (TICKET-041).
 *
 * The panel's guards answer `alert`/`confirm`/`prompt` conservatively instead of
 * freezing the renderer; the tool card lists what was blocked so the agent can
 * tell "the page asked and I answered no" apart from "nothing happened".
 * @param {Record<string, unknown>} value - tool value being assembled.
 * @param {{ dialogs?: string[] }} result - raw panel result.
 * @returns {Record<string, unknown>} `value`, plus `dialogs` when there were any.
 */
function withDialogs(value, result) {
  if (Array.isArray(result?.dialogs) === false || result.dialogs.length === 0) return value
  return { ...value, dialogs: result.dialogs.map((line) => String(line)).slice(0, 5) }
}

/** Render footer listing dialogs the guards blocked, or '' when there were none. */
function dialogNote(value) {
  const list = Array.isArray(value?.dialogs) ? value.dialogs : []
  if (list.length === 0) return ''
  return `\n\nblocked dialogs (answered conservatively; the page kept running):\n${list.map((line) => `- ${line}`).join('\n')}`
}

/**
 * Render the tail of the page's own console (TICKET-049).
 *
 * Ten lines is the useful edge: enough to see the error a page threw after a
 * click, small enough to keep a snapshot cheap. The count makes the truncation
 * visible instead of silent.
 */
function consoleNote(value) {
  const list = Array.isArray(value?.console) ? value.console : []
  if (list.length === 0) return ''
  const shown = list.slice(-10)
  const lines = shown.map((entry) => `- [${String(entry?.level ?? 'log')}] ${String(entry?.text ?? '')}`)
  const hidden = list.length - shown.length
  const more = hidden > 0 ? `\n… ${hidden} earlier entries not shown` : ''
  return `\n\npage console (${list.length} ${list.length === 1 ? 'entry' : 'entries'}):\n${lines.join('\n')}${more}`
}

/**
 * Render the tail of the page's failed network requests (TICKET-051).
 *
 * The page's own script may swallow a failed fetch, leaving only a console
 * trace that never appears. These lines say which request failed and how, so a
 * click that "did nothing" can be explained without opening DevTools. Only
 * failures are listed; the denominator is the total request count so a quiet
 * page is not mistaken for a broken one.
 */
function networkNote(value) {
  const list = Array.isArray(value?.network) ? value.network : []
  if (list.length === 0) return ''
  const shown = list.slice(-10)
  const total = Number.isInteger(value?.networkTotal) && value.networkTotal > 0 ? value.networkTotal : list.length
  const lines = shown.map((entry) => {
    const status = Number.isInteger(entry?.status) && entry.status > 0 ? String(entry.status) : 'failed'
    const ms = Number.isInteger(entry?.ms) && entry.ms > 0 ? `, ${entry.ms}ms` : ''
    const note = typeof entry?.error === 'string' && entry.error !== '' ? ` — ${entry.error}` : ''
    return `- [${String(entry?.kind ?? 'fetch')}] ${String(entry?.method ?? 'GET')} ${String(entry?.url ?? '')} → ${status}${ms}${note}`
  })
  const hidden = list.length - shown.length
  const more = hidden > 0 ? `\n… ${hidden} earlier failures not shown` : ''
  return `\n\npage network (${list.length} failed of ${total} request(s)):\n${lines.join('\n')}${more}`
}

/**
 * Stamp a write result with the only success state the tri-state has.
 *
 * The page acknowledged the action, so `committed` is exact. `none` and
 * `unknown` are produced on the error path instead: `none` for anything that
 * failed before the command reached the page, `unknown` when `bridge.js` reports
 * `action_unknown` (SPEC-004 B4, TICKET-042).
 * @template {object} T
 * @param {T} value - tool value being returned.
 * @returns {T & { effect: 'committed' }} the same value with the stamp.
 */
function committed(value) {
  return { ...value, effect: 'committed' }
}

/**
 * Record "nothing was sent" on a thrown write error.
 *
 * The effect cannot change the message the model reads (the code already says
 * it), but it keeps the structured error honest for the panel, logs and tests,
 * and it is the field `action_unknown` sets to `unknown` on the other side.
 * @param {unknown} error - whatever the tool threw.
 * @returns {unknown} the same error, with `details.effect = 'none'`.
 */
function notSent(error) {
  if (error === null || typeof error !== 'object') return error
  if (error.code === 'action_unknown') return error
  error.details = { ...(error.details ?? {}), effect: 'none' }
  return error
}

/**
 * The in-page wait probe, read on every call like the other page scripts.
 *
 * TICKET-044: the probe is one synchronous look (`inject/wait.js`); the polling
 * loop lives in the panel, so a cancel frame can stop the wait between probes
 * and the page cannot trap the command in a long-running promise.
 * @returns {string} the source of `dshWait`.
 */
export function waitSource() {
  return readFileSync(new URL('./inject/wait.js', import.meta.url), 'utf8')
}

/**
 * `browser_wait` — wait until a selector or some text is present (or gone).
 *
 * Read-only: it asks the page the same question `browser_snapshot` would answer,
 * just repeatedly until the condition holds or the budget runs out, so it never
 * needs approval and never moves the phase. It returns before the budget when
 * the condition is already true, which makes it safe to call defensively.
 * TICKET-044 / SPEC-004 stage B1.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 */
export function browserWaitTool(bridge) {
  const DEFAULT_TIMEOUT_MS = 10_000
  const MAX_TIMEOUT_MS = 15_000
  return {
    name: 'browser_wait',
    description:
      'Wait (read-only, no approval) until a CSS selector or some page text appears, or until it disappears '
      + 'with gone:true. A selector counts as appeared only when it is rendered (display:none, visibility:hidden '
      + 'and zero-box elements do not count), so hidden skeletons do not report success early; text is matched '
      + 'in the rendered body text. Pass exactly one of selector / text. Returns immediately when the condition '
      + 'already holds; otherwise polls until timeoutMs (default 10000, max 15000) and reports timedOut. Use it '
      + 'after browser_open or an action that starts async work, instead of polling with browser_eval. It never '
      + 'changes the page and works in both the needs_human and taken_over phases.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for (or to disappear with gone:true).' },
        text: { type: 'string', description: 'Text to wait for in the page body (or to disappear with gone:true). Pass this instead of selector.' },
        gone: { type: 'boolean', description: 'Wait for the selector/text to be absent rather than present. Defaults to false.' },
        timeoutMs: { type: 'integer', description: `Milliseconds to wait before reporting timedOut. Defaults to ${DEFAULT_TIMEOUT_MS}; max ${MAX_TIMEOUT_MS}.` },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          matched: { type: 'boolean' },
          timedOut: { type: 'boolean' },
          found: { type: 'boolean' },
          visible: { type: 'boolean' },
          gone: { type: 'boolean' },
          waitedMs: { type: 'integer' },
          url: { type: 'string' },
        },
        required: ['matched', 'waitedMs'],
      },
      render(_args, value) {
        const seconds = ((Number(value?.waitedMs) || 0) / 1000).toFixed(1)
        if (value?.matched === true) {
          const state = value?.gone === true ? 'is gone' : 'appeared'
          return [{
            type: 'text',
            text: `Condition met after ${seconds}s: ${state}. Snapshot again to see what is on the page now.`,
          }]
        }
        return [{
          type: 'text',
          text: `Waited ${seconds}s; the condition was not met (timed out). Snapshot again to see the current state; the page may still be loading or the selector/text may be wrong.`,
        }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const selector = typeof args?.selector === 'string' && args.selector.trim() !== '' ? args.selector.trim() : undefined
      const text = typeof args?.text === 'string' && args.text !== '' ? args.text : undefined
      if (selector !== undefined && text !== undefined) {
        throw new Error('pass exactly one of selector or text, not both')
      }
      if (selector === undefined && text === undefined) {
        throw new Error('browser_wait needs a selector or text to look for')
      }
      if (args?.gone !== undefined && typeof args.gone !== 'boolean') {
        throw new Error('gone must be a boolean')
      }
      let timeoutMs = DEFAULT_TIMEOUT_MS
      if (args?.timeoutMs !== undefined) {
        const raw = Number(args.timeoutMs)
        if (!Number.isFinite(raw) || !Number.isInteger(raw)) throw new Error('timeoutMs must be an integer number of milliseconds')
        timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(100, raw))
      }
      const result = await bridge.request(
        sessionId,
        'wait',
        { selector, text, gone: args?.gone === true, timeoutMs, source: waitSource() },
        timeoutMs + 5_000,
      )
      if (result?.ok !== true) throw actionFailure(result, 'wait')
      if (result?.invalid === true) throw new Error('browser_wait needs a valid selector or text to look for')
      const matched = result?.matched === true
      return {
        matched,
        timedOut: matched === false,
        found: result?.found === true,
        visible: result?.visible === true,
        gone: result?.gone === true,
        waitedMs: Math.round(Number(result?.waitedMs) || 0),
        ...(typeof result?.url === 'string' && result.url !== '' ? { url: result.url } : {}),
      }
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      const what = args?.text !== undefined ? `"${String(args.text).slice(0, 40)}"` : String(args?.selector ?? 'a selector')
      const mode = args?.gone === true ? 'disappear' : 'appear'
      return { card: 'generic', title: `Wait for ${what} to ${mode}`, kind: 'read', rawInput: args }
    },
    presentResult(_args, value) {
      return {
        card: 'generic',
        title: value?.matched === true ? 'Condition met' : 'Wait timed out',
      }
    },
  }
}

/**
 * The in-page text/table reader, read on every call like the other page scripts.
 *
 * TICKET-057: reading an article or a table is not an accessibility-tree walk;
 * shipping the source with the command keeps the page half and the host half
 * from drifting apart (same convention as `wait`/`pick`).
 * @returns {string} the source of `dshRead`.
 */
export function readSource() {
  return readFileSync(new URL('./inject/read.js', import.meta.url), 'utf8')
}

/**
 * `browser_read` — read the rendered text or table rows under a root.
 *
 * The snapshot walks the accessibility tree: great for finding controls, wasteful
 * for reading a paragraph or a data table. This returns what the page actually
 * renders (`innerText`, so hidden nodes are skipped) or the cells of every
 * `<table>` under a root, trimmed to `maxChars` / `maxTables` / `maxRows`.
 * Reads only — no click, no scroll, no focus, no approval — and it works in the
 * `needs_human` and `taken_over` phases like `browser_snapshot`.
 * TICKET-057 / SPEC-004 stage B2.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 */
export function browserReadTool(bridge) {
  const DEFAULT_MAX_CHARS = 8_000
  const MAX_MAX_CHARS = 40_000
  const DEFAULT_MAX_TABLES = 10
  const MAX_MAX_TABLES = 20
  const DEFAULT_MAX_ROWS = 100
  const MAX_MAX_ROWS = 500
  // Page-level refusals carry a stable code but the generic click/type message
  // would say "ref" where a read has a loc/selector; keep the read wording here.
  const readFailure = (result, args) => {
    const code = typeof result?.error === 'string' && result.error !== '' ? result.error : 'read_failed'
    const loc = typeof result?.loc === 'string' && result.loc !== '' ? result.loc : typeof args?.loc === 'string' ? args.loc : ''
    const selector = typeof result?.selector === 'string' && result.selector !== '' ? result.selector : typeof args?.selector === 'string' ? args.selector : ''
    const ref = typeof result?.ref === 'string' && result.ref !== '' ? result.ref : typeof args?.ref === 'string' ? args.ref : ''
    const matched = Number.isFinite(result?.matched) ? result.matched : 0
    let message
    switch (code) {
      case 'stale_loc':
        message = `loc ${JSON.stringify(loc)} no longer matches anything in the page — it was replaced, removed, or you are on a different page now. Take a new browser_snapshot and use the loc from that snapshot.`
        break
      case 'bad_loc':
        message = `loc ${JSON.stringify(loc)} is not a stable page path. Copy the loc="css:…" value from a browser_snapshot, or pass no address to read the whole page.`
        break
      case 'stale_ref':
        message = `ref "${ref}" is no longer in the page; it was replaced or removed. Take a new browser_snapshot and use a ref from that snapshot.`
        break
      case 'bad_ref':
        message = `"${ref}" is not a ref. Use a ref from the latest browser_snapshot, e.g. e12.`
        break
      case 'not_found':
        message = selector !== ''
          ? `selector ${JSON.stringify(selector)} matched ${matched} element(s). Use a selector you can see in the page, or omit the address to read the whole page body.`
          : 'the root element was not found. Pass a loc/selector you can see in a snapshot, or omit the address to read the whole page body.'
        break
      case 'multiple':
        message = `selector ${JSON.stringify(selector)} matched ${matched} element(s). Pass strict:false to read the first match, or narrow the selector.`
        break
      case 'bad_selector':
        message = `selector ${JSON.stringify(selector)} is not a valid CSS selector.`
        break
      default:
        message = `the page could not read that root (${code}).`
    }
    const error = new Error(message)
    error.code = code
    return error
  }
  return {
    name: 'browser_read',
    description:
      'Read the rendered text of a page (or of one element) without walking the accessibility tree, or read '
      + 'the rows of every table under it. mode "text" (default) returns the visible text, whitespace-normalized '
      + 'and cut at maxChars (default 8000, max 40000). mode "table" returns up to maxTables tables (default 10) '
      + 'with caption, headers, rows (up to maxRows each, default 100) and row counts. Point it at a root with '
      + 'loc (the stable css: path from a snapshot) or selector; no address means the whole page body. Reads only: '
      + 'nothing is clicked, submitted or scrolled, so no approval is needed and it works in every phase. Use it '
      + 'instead of browser_snapshot when you want the words on the page, not the controls.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['text', 'table'], description: 'What to read. "text" (default) returns the rendered text; "table" returns table rows.' },
        loc: { type: 'string', description: 'Stable loc of the root element (the `css:…` path from a snapshot). Omit for the whole page body.' },
        selector: { type: 'string', description: 'CSS selector for the root element, when you know one. Pass at most one of loc / selector / ref.' },
        ref: { type: 'string', description: 'Ref of the root element from the latest browser_snapshot.' },
        strict: { type: 'boolean', description: 'With selector: fail with an error instead of using the first of several matches. Defaults to false.' },
        maxChars: { type: 'integer', description: `Text mode: maximum characters to return. Defaults to ${DEFAULT_MAX_CHARS}; clamped to 200–${MAX_MAX_CHARS}.` },
        maxTables: { type: 'integer', description: `Table mode: maximum tables to return. Defaults to ${DEFAULT_MAX_TABLES}; clamped to 1–${MAX_MAX_TABLES}.` },
        maxRows: { type: 'integer', description: `Table mode: maximum rows per table. Defaults to ${DEFAULT_MAX_ROWS}; clamped to 1–${MAX_MAX_ROWS}.` },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
          text: { type: 'string' },
          chars: { type: 'integer' },
          totalChars: { type: 'integer' },
          truncated: { type: 'boolean' },
          tables: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                caption: { type: 'string' },
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                rowCount: { type: 'integer' },
                truncated: { type: 'boolean' },
              },
            },
          },
          tableCount: { type: 'integer' },
          root: {
            type: 'object',
            properties: {
              tag: { type: 'string' },
              role: { type: 'string' },
              name: { type: 'string' },
              loc: { type: 'string' },
            },
          },
          url: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['mode'],
      },
      render(_args, value) {
        const rootName = value?.root?.name ? `${value.root.role ?? value.root.tag} "${String(value.root.name).slice(0, 60)}"` : value?.root?.tag ?? 'the page'
        if (value?.mode === 'table') {
          const tables = Array.isArray(value?.tables) ? value.tables : []
          if (tables.length === 0) {
            return [{ type: 'text', text: `No <table> elements were found under ${rootName}. The page may render its data as divs; use browser_read mode "text" or browser_snapshot instead.` }]
          }
          const lines = [`Read ${tables.length} table(s) under ${rootName}.`]
          tables.forEach((table, index) => {
            const caption = typeof table?.caption === 'string' && table.caption !== '' ? ` — ${table.caption}` : ''
            const rowCount = Number(table?.rowCount) || 0
            lines.push('')
            lines.push(`Table ${index + 1}${caption} (${rowCount} row(s))`)
            if (Array.isArray(table?.headers) && table.headers.length > 0) lines.push(`  ${table.headers.join(' | ')}`)
            const rows = Array.isArray(table?.rows) ? table.rows : []
            for (const row of rows.slice(0, 50)) lines.push(`  ${(Array.isArray(row) ? row : []).join(' | ')}`)
            if (table?.truncated === true) lines.push(`  … more rows not shown (raise maxRows)` )
          })
          if (value?.truncated === true) lines.push('', `… more tables not shown (raise maxTables).`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const chars = Number(value?.chars) || 0
        const total = Number(value?.totalChars) || chars
        const header = value?.truncated === true
          ? `Read ${chars} of ${total} rendered characters from ${rootName} (truncated; narrow it with loc/selector or raise maxChars).`
          : `Read ${chars} rendered character(s) from ${rootName}.`
        const text = typeof value?.text === 'string' ? value.text : ''
        return [{ type: 'text', text: text === '' ? `${header} The root rendered no text.` : `${header}\n\n${text}` }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const mode = args?.mode === undefined ? 'text' : args.mode
      if (mode !== 'text' && mode !== 'table') throw new Error('mode must be "text" or "table"')
      const addresses = ['ref', 'loc', 'selector'].filter((key) => typeof args?.[key] === 'string' && args[key].trim() !== '')
      if (addresses.length > 1) throw new Error('pass at most one of ref, loc or selector')
      const address = {}
      if (addresses.length === 1) address[addresses[0]] = String(args[addresses[0]]).trim()
      if (address.loc !== undefined && address.loc.slice(0, 4) !== 'css:') {
        throw new Error('loc must start with "css:" (copy the loc="css:…" value from a snapshot)')
      }
      const readInt = (name, fallback, low, high) => {
        if (args?.[name] === undefined) return fallback
        const raw = Number(args[name])
        if (!Number.isFinite(raw) || !Number.isInteger(raw)) throw new Error(`${name} must be an integer`)
        return Math.min(high, Math.max(low, raw))
      }
      const maxChars = readInt('maxChars', DEFAULT_MAX_CHARS, 200, MAX_MAX_CHARS)
      const maxTables = readInt('maxTables', DEFAULT_MAX_TABLES, 1, MAX_MAX_TABLES)
      const maxRows = readInt('maxRows', DEFAULT_MAX_ROWS, 1, MAX_MAX_ROWS)
      const result = await bridge.request(
        sessionId,
        'read',
        { mode, ...address, strict: args?.strict === true, maxChars, maxTables, maxRows, source: readSource() },
        20_000,
      )
      if (result?.ok !== true) throw readFailure(result, args)
      const root = result?.root !== null && typeof result?.root === 'object' ? result.root : undefined
      const value = {
        mode: result?.mode === 'table' ? 'table' : 'text',
        ...(typeof result?.url === 'string' && result.url !== '' ? { url: result.url } : {}),
        ...(typeof result?.title === 'string' ? { title: result.title } : {}),
        ...(root === undefined ? {} : { root }),
      }
      if (value.mode === 'table') {
        const tables = Array.isArray(result?.tables) ? result.tables : []
        value.tables = tables.filter((table) => table !== null && typeof table === 'object').map((table) => ({
          caption: typeof table.caption === 'string' ? table.caption : '',
          headers: Array.isArray(table.headers) ? table.headers.map((cell) => String(cell)) : [],
          rows: Array.isArray(table.rows) ? table.rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell)) : [])) : [],
          rowCount: Number.isInteger(table.rowCount) && table.rowCount >= 0 ? table.rowCount : 0,
          truncated: table.truncated === true,
        })).slice(0, 20)
        value.tableCount = Number.isInteger(result?.tableCount) ? result.tableCount : value.tables.length
        value.truncated = result?.truncated === true
        return value
      }
      const text = typeof result?.text === 'string' ? result.text : ''
      value.text = text
      value.chars = Number.isInteger(result?.chars) ? result.chars : text.length
      value.totalChars = Number.isInteger(result?.totalChars) ? result.totalChars : value.chars
      value.truncated = result?.truncated === true
      return value
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      const mode = args?.mode === 'table' ? 'table' : 'text'
      const target = typeof args?.loc === 'string' ? args.loc : typeof args?.selector === 'string' ? args.selector : 'the page'
      return { card: 'generic', title: `Read ${mode} from ${String(target).slice(0, 60)}`, kind: 'read', rawInput: args }
    },
    presentResult(_args, value) {
      if (value?.mode === 'table') {
        const count = Array.isArray(value?.tables) ? value.tables.length : 0
        return { card: 'generic', title: count === 0 ? 'No tables found' : `Read ${count} table(s)` }
      }
      const chars = Number(value?.chars) || 0
      return { card: 'generic', title: value?.truncated === true ? `Read ${chars} char(s) (truncated)` : `Read ${chars} char(s)` }
    },
  }
}

/**
 * The in-page element picker, read on every call like the other page scripts.
 *
 * TICKET-053: pointing is a small state machine (`start` / `poll` / `stop`)
 * driven by the panel; shipping the source with the command keeps the page half
 * and the host half from drifting apart.
 * @returns {string} the source of `dshPick`.
 */
export function pickSource() {
  return readFileSync(new URL('./inject/pick.js', import.meta.url), 'utf8')
}

/**
 * Source of the in-page feedback painter (TICKET-055).
 *
 * The panel draws marks on its own initiative after an action, so it asks for
 * this file through `GET /source?name=feedback` instead of carrying a copy.
 * @returns {string} the source of `dshFeedback`.
 */
export function feedbackSource() {
  return readFileSync(new URL('./inject/feedback.js', import.meta.url), 'utf8')
}

/**
 * `browser_pick` — ask the person in front of the panel to point at the page.
 *
 * Two modes. `element` (default) asks them to click one element — the fast,
 * accurate answer to "which element?" when a snapshot cannot tell targets apart
 * (icon-only buttons, repeated rows, canvas controls). `box` asks them to drag a
 * rectangle and returns every distinct element under it, capped by `limit` —
 * the answer to "these ten checkboxes" or "this card region". Picking is
 * read-only: the page never sees the press or click and nothing is submitted;
 * the answer is a stable `loc` (plus role/name/rect/point) for each pick, which
 * the agent then uses with the normal action tools. A timeout or Esc is a
 * normal answer, not an error.
 * TICKET-053 / TICKET-054 / SPEC-004 stage B4.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 */
export function browserPickTool(bridge) {
  const DEFAULT_TIMEOUT_MS = 60_000
  const MAX_TIMEOUT_MS = 120_000
  const DEFAULT_LIMIT = 20
  const MAX_LIMIT = 100
  return {
    name: 'browser_pick',
    description:
      'Ask the person in front of the panel to point at the page, then return structured references. '
      + 'mode "element" (default): they click one element; returns its stable loc, readable role/name, rect and '
      + 'viewport point. mode "box": they drag a rectangle; returns every distinct element under it (loc + '
      + 'role/name + rect + point each, at most `limit`, default 20, max 100) plus the box and the total hit '
      + 'count — use it for a group of checkboxes, a repeated list, or a canvas/region target. Pick one when a '
      + 'snapshot cannot tell targets apart (icon-only buttons, ten identical "delete" rows, canvas controls) or '
      + 'when you would only be guessing coordinates. Picking is read-only: the page never receives the press or '
      + 'click, so nothing is submitted, navigated or scrolled and the DOM is unchanged — follow it with '
      + 'browser_click { loc } / browser_type { loc } to actually act. No approval is needed. Returns '
      + 'picked:false with timedOut:true when the person does not finish in time (default 60000ms, max 120000) or '
      + 'cancelled:true when they pressed Esc, used the panel cancel button, or took the panel over; the page was '
      + 'not touched in either case.',
    parameters: {
      type: 'object',
      properties: {
        timeoutMs: {
          type: 'integer',
          description: `How long to wait for the person to point at the page, in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}; max ${MAX_TIMEOUT_MS}.`,
        },
        mode: {
          type: 'string',
          enum: ['element', 'box'],
          description: 'What to collect: "element" (one click, default) or "box" (drag a rectangle over many elements).',
        },
        limit: {
          type: 'integer',
          description: `Only for mode "box": the most elements to return. Defaults to ${DEFAULT_LIMIT}; clamped to 1–${MAX_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          picked: { type: 'boolean' },
          timedOut: { type: 'boolean' },
          cancelled: { type: 'boolean' },
          mode: { type: 'string' },
          box: {
            type: 'object',
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
          elements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                loc: { type: 'string' },
                info: {
                  type: 'object',
                  properties: { tag: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' } },
                  required: ['tag', 'role', 'name'],
                },
                rect: {
                  type: 'object',
                  properties: {
                    x: { type: 'integer' },
                    y: { type: 'integer' },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                  },
                  required: ['x', 'y', 'width', 'height'],
                },
                point: {
                  type: 'object',
                  properties: { x: { type: 'integer' }, y: { type: 'integer' } },
                  required: ['x', 'y'],
                },
              },
              required: ['loc', 'info', 'rect', 'point'],
            },
          },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          loc: { type: 'string' },
          info: {
            type: 'object',
            properties: { tag: { type: 'string' }, role: { type: 'string' }, name: { type: 'string' } },
            required: ['tag', 'role', 'name'],
          },
          rect: {
            type: 'object',
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
          point: {
            type: 'object',
            properties: { x: { type: 'integer' }, y: { type: 'integer' } },
            required: ['x', 'y'],
          },
          waitedMs: { type: 'integer' },
          url: { type: 'string' },
        },
        required: ['picked', 'waitedMs'],
      },
      render(_args, value) {
        if (value?.picked !== true) {
          const reason = value?.timedOut === true
            ? 'The person did not finish picking within the time budget'
            : 'Picking was cancelled (Esc, the panel cancel button, or the panel was taken over)'
          return [{
            type: 'text',
            text: `${reason}; the page was not touched. Make sure the browser panel is visible, then ask again — `
              + 'or fall back to browser_snapshot and a ref/loc.',
          }]
        }
        if (value?.mode === 'box') {
          const elements = Array.isArray(value.elements) ? value.elements : []
          const total = Number.isInteger(value.total) ? value.total : elements.length
          const box = value.box !== null && typeof value.box === 'object' ? value.box : {}
          const head = `The person drew a box over (${Math.round(Number(box.x) || 0)}, ${Math.round(Number(box.y) || 0)}) `
            + `${Math.round(Number(box.width) || 0)}×${Math.round(Number(box.height) || 0)} and it holds ${total} element(s).`
          if (elements.length === 0) {
            return [{
              type: 'text',
              text: `${head} Nothing actionable was under the box (empty space, or only the page background) — `
                + 'ask again and drag a box over the controls themselves. The page state is unchanged.',
            }]
          }
          const lines = elements.slice(0, 10).map((element) => {
            const elementInfo = element?.info !== null && typeof element.info === 'object' ? element.info : {}
            const elementRole = String(elementInfo.role ?? '').trim() !== '' ? String(elementInfo.role) : String(elementInfo.tag ?? 'element')
            const elementName = String(elementInfo.name ?? '').trim()
            const elementRect = element?.rect !== null && typeof element.rect === 'object' ? element.rect : {}
            return `* ${String(element?.loc ?? '')} — ${elementRole}${elementName === '' ? '' : ` "${elementName}"`} `
              + `(${Math.round(Number(elementRect.x) || 0)}, ${Math.round(Number(elementRect.y) || 0)} `
              + `${Math.round(Number(elementRect.width) || 0)}×${Math.round(Number(elementRect.height) || 0)})`
          })
          const shown = elements.slice(0, 10).length
          const notes = []
          if (shown < elements.length) notes.push(`${elements.length - shown} more element(s) are listed in the result; raise \`limit\` to get up to 100.`)
          if (value.truncated === true) notes.push('The box held more elements than the limit, so some were not collected.')
          return [{
            type: 'text',
            text: `${head} Move one at a time with browser_click { loc } / browser_type { loc }:\n${lines.join('\n')}`
              + `${notes.length === 0 ? '' : `\n${notes.join(' ')}`}`
              + '\nPicking itself did not click the page, and the page state is unchanged.',
          }]
        }
        const info = value.info && typeof value.info === 'object' ? value.info : {}
        const name = String(info.name ?? '').trim()
        const role = String(info.role ?? '').trim() !== '' ? String(info.role) : String(info.tag ?? 'element')
        const where = typeof value.loc === 'string' && value.loc !== ''
          ? `loc: ${value.loc}`
          : `point: (${Math.round(Number(value.point?.x) || 0)}, ${Math.round(Number(value.point?.y) || 0)})`
        const how = typeof value.loc === 'string' && value.loc !== ''
          ? `Use it with browser_click { loc: ${JSON.stringify(value.loc)} } or browser_type { loc: … }`
          : 'No stable path was found; act quickly with the point coordinates before the page scrolls or re-renders'
        return [{
          type: 'text',
          text: `The person picked ${role}${name === '' ? '' : ` "${name}"`} (${where}). ${how}. `
            + 'Picking itself did not click the page, and the page state is unchanged.',
        }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const mode = args?.mode === 'box' ? 'box' : 'element'
      let timeoutMs = DEFAULT_TIMEOUT_MS
      if (args?.timeoutMs !== undefined) {
        const raw = Number(args.timeoutMs)
        if (!Number.isFinite(raw) || !Number.isInteger(raw)) throw new Error('timeoutMs must be an integer number of milliseconds')
        timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(3_000, raw))
      }
      let limit = DEFAULT_LIMIT
      if (args?.limit !== undefined) {
        const raw = Number(args.limit)
        if (!Number.isFinite(raw) || !Number.isInteger(raw)) throw new Error('limit must be an integer')
        limit = Math.min(MAX_LIMIT, Math.max(1, raw))
      }
      const result = await bridge.request(sessionId, 'pick', {
        timeoutMs,
        mode,
        ...(mode === 'box' ? { limit } : {}),
        source: pickSource(),
      }, timeoutMs + 8_000)
      if (result?.ok !== true) throw actionFailure(result, 'pick')
      const waitedMs = Math.round(Number(result?.waitedMs) || 0)
      if (result?.picked === true && (mode === 'box' || result?.mode === 'box')) {
        const box = result.box !== null && typeof result.box === 'object' ? result.box : {}
        const rawElements = Array.isArray(result.elements) ? result.elements : []
        const elements = rawElements
          .filter((element) => element !== null && typeof element === 'object')
          .slice(0, MAX_LIMIT)
          .map((element) => {
            const info = element.info !== null && typeof element.info === 'object' ? element.info : {}
            const rect = element.rect !== null && typeof element.rect === 'object' ? element.rect : {}
            const point = element.point !== null && typeof element.point === 'object' ? element.point : {}
            return {
              loc: String(element.loc ?? ''),
              info: {
                tag: String(info.tag ?? ''),
                role: String(info.role ?? ''),
                name: String(info.name ?? ''),
              },
              rect: {
                x: Math.round(Number(rect.x) || 0),
                y: Math.round(Number(rect.y) || 0),
                width: Math.round(Number(rect.width) || 0),
                height: Math.round(Number(rect.height) || 0),
              },
              point: {
                x: Math.round(Number(point.x) || 0),
                y: Math.round(Number(point.y) || 0),
              },
            }
          })
        return {
          picked: true,
          mode: 'box',
          box: {
            x: Math.round(Number(box.x) || 0),
            y: Math.round(Number(box.y) || 0),
            width: Math.round(Number(box.width) || 0),
            height: Math.round(Number(box.height) || 0),
          },
          elements,
          total: Number.isInteger(result.total) ? result.total : elements.length,
          truncated: result.truncated === true,
          waitedMs,
          ...(typeof result.url === 'string' && result.url !== '' ? { url: result.url } : {}),
        }
      }
      if (result?.picked === true) {
        const info = result.info !== null && typeof result.info === 'object' ? result.info : {}
        const rect = result.rect !== null && typeof result.rect === 'object' ? result.rect : {}
        const point = result.point !== null && typeof result.point === 'object' ? result.point : {}
        return {
          picked: true,
          ...(typeof result.loc === 'string' && result.loc !== '' ? { loc: result.loc } : {}),
          info: {
            tag: String(info.tag ?? ''),
            role: String(info.role ?? ''),
            name: String(info.name ?? ''),
          },
          rect: {
            x: Math.round(Number(rect.x) || 0),
            y: Math.round(Number(rect.y) || 0),
            width: Math.round(Number(rect.width) || 0),
            height: Math.round(Number(rect.height) || 0),
          },
          point: {
            x: Math.round(Number(point.x) || 0),
            y: Math.round(Number(point.y) || 0),
          },
          waitedMs,
          ...(typeof result.url === 'string' && result.url !== '' ? { url: result.url } : {}),
        }
      }
      return {
        picked: false,
        ...(result?.timedOut === true ? { timedOut: true } : {}),
        ...(result?.cancelled === true ? { cancelled: true } : {}),
        waitedMs,
        ...(typeof result?.url === 'string' && result.url !== '' ? { url: result.url } : {}),
      }
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: args?.mode === 'box' ? 'Ask the person to pick a box of elements' : 'Ask the person to pick an element',
        kind: 'read',
      }
    },
    presentResult(_args, value) {
      if (value?.mode === 'box' && value?.picked === true) {
        const count = Array.isArray(value.elements) ? value.elements.length : 0
        return { card: 'generic', title: `Box picked (${count} element(s))` }
      }
      return {
        card: 'generic',
        title: value?.picked === true ? 'Element picked' : 'Nothing picked',
      }
    },
  }
}

/**
 * `browser_click` — click a ref, a CSS selector, or a viewport coordinate.
 *
 * The coordinate form exists for the things a DOM ref cannot express: canvas
 * maps, cross-origin frames, and anything a site draws itself. The selector form
 * exists for the things refs get wrong: stacked 3D cards whose labels overlap,
 * icon-only pagers, and anything that has no stable accessibility name. It
 * hit-tests first, so "a banner was covering it" is an error, not a success.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 */
export function browserClickTool(bridge) {
  return {
    name: 'browser_click',
    description:
      'Click something in the browser panel. Prefer a ref from the latest browser_snapshot; pass `loc` (the verified '
      + 'css: locator printed next to that ref) when you are working from an older snapshot — locators survive ref '
      + 'renumbering. Pass `selector` (CSS) when the element has no usable ref — a canvas-adjacent widget, a card '
      + 'stack, an icon-only pager; pass x/y (CSS pixels inside the panel, origin top-left) only for canvas widgets '
      + 'and cross-origin frames. A selector click fails as not_found / multiple / occluded / disabled instead of '
      + 'clicking the wrong thing. Links that wanted a new window are followed in the same view. One click per call; '
      + 'snapshot again afterwards.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the latest browser_snapshot, e.g. e5 or f1e2.' },
        loc: { type: 'string', description: 'A stable locator copied from a snapshot line, e.g. css:#save or css:body > div:nth-of-type(2) > button:nth-of-type(1). Use it when the ref you have may be stale; a vanished locator fails as stale_loc.' },
        selector: { type: 'string', description: 'A CSS selector, used when no ref fits. Must match exactly one visible element unless strict is false.' },
        strict: { type: 'boolean', description: 'With selector: false accepts the first of several matches instead of failing as multiple. Defaults to true.' },
        x: { type: 'integer', description: 'Viewport x in CSS pixels. Requires y; ignored when ref or selector is given.' },
        y: { type: 'integer', description: 'Viewport y in CSS pixels. Requires x.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...ACTION_OUTPUT.properties,
          x: { type: 'integer' },
          y: { type: 'integer' },
          targetFixed: { type: 'string' },
          blockedNewWindow: { type: 'string' },
          navigated: { type: 'boolean' },
          looksDisabled: { type: 'string' },
        },
        required: ['x', 'y'],
      },
      render(_args, value) {
        // A coordinate click has no element behind it (canvas, cross-origin
        // frame), and quoting an empty name there reads as a bug.
        const name = typeof value?.name === 'string' && value.name !== '' ? ` "${value.name}"` : ''
        const target = value?.role ? `${value.role}${name}` : 'the page'
        const lines = [`Clicked ${target} at (${value?.x ?? 0}, ${value?.y ?? 0}).`]
        if (typeof value?.targetFixed === 'string' && value.targetFixed !== '') {
          const isForm = value.targetFixed.startsWith('form')
          lines.push(`The ${isForm ? 'form' : 'link'} asked for target="${value.targetFixed.replace(/^form /, '')}"; it was ${isForm ? 'submitted' : 'followed'} in this view instead of opening a new window.`)
        }
        if (typeof value?.blockedNewWindow === 'string' && value.blockedNewWindow !== '') {
          lines.push(`window.open was blocked: ${value.blockedNewWindow}`)
        }
        if (value?.navigated === false) {
          lines.push('The address did not change: this click did not take us anywhere. Something inside the element handled the press in script (an overlay, a menu, a favourite button) instead of following the element itself — click the part that owns the link, such as the picture or the title, or pass x/y for that spot.')
        }
        if (typeof value?.looksDisabled === 'string' && value.looksDisabled !== '') {
          lines.push(`Heads up: its class list says "${value.looksDisabled}", which usually means the page is styling it as disabled — the click was dispatched, but the page may have ignored it. Check what changed before trusting this click.`)
        }
        return [{ type: 'text', text: `${lines.join('\n')}${dialogNote(value)}` }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const hasPoint = Number.isFinite(args?.x) && Number.isFinite(args?.y)
      const selector = typeof args?.selector === 'string' && args.selector.trim() !== '' ? args.selector.trim() : ''
      const loc = typeof args?.loc === 'string' && args.loc.trim() !== '' ? args.loc.trim() : ''
      if (loc !== '' && selector !== '') {
        throw new Error('pass either loc or selector, not both: a locator is already a CSS path.')
      }
      if (hasPoint && (selector !== '' || loc !== '')) {
        throw new Error('pass either a locator/selector or x/y, not both: a locator is resolved to a point for you.')
      }
      if (!hasPoint && selector === '' && loc === '') requireRef(args?.ref)
      const result = await bridge.request(
        sessionId,
        'click',
        {
          ref: !hasPoint && selector === '' && loc === '' ? requireRef(args?.ref) : undefined,
          loc: loc === '' ? undefined : loc,
          selector: selector === '' ? undefined : selector,
          strict: typeof args?.strict === 'boolean' ? args.strict : undefined,
          x: args?.x,
          y: args?.y,
          source: actionSource(),
        },
        20_000,
      )
      if (result?.ok !== true) throw actionFailure(result)
      return committed(withDialogs({
        ...(result.info ?? {}),
        x: result.x ?? 0,
        y: result.y ?? 0,
        ...(typeof result.targetFixed === 'string' ? { targetFixed: result.targetFixed } : {}),
        ...(Array.isArray(result.blockedNewWindow) && result.blockedNewWindow.length > 0
          ? { blockedNewWindow: result.blockedNewWindow.map((url) => String(url)).join(' ') }
          : {}),
        ...(typeof result.navigated === 'boolean' ? { navigated: result.navigated } : {}),
        ...(typeof result.looksDisabled === 'string' && result.looksDisabled !== ''
          ? { looksDisabled: result.looksDisabled }
          : {}),
      }, result))
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      const what = args?.loc ?? args?.selector ?? args?.ref ?? `${args?.x},${args?.y}`
      return { card: 'generic', title: `Click ${what}`, kind: 'edit', rawInput: args }
    },
    presentResult() {
      return { card: 'generic', title: 'Clicked' }
    },
  }
}

/**
 * `browser_drag` — press one element, move the pointer, release on another.
 *
 * Sliders, sortable lists, kanban cards and canvas handles only respond to a
 * real press-move-release. The page-side helper resolves both ends, hit-tests
 * the source and dispatches a pointer/mouse sequence with a frame between
 * steps, so framework drag libraries see the same events a human produces.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 */
export function browserDragTool(bridge) {
  return {
    name: 'browser_drag',
    description:
      'Drag something in the browser panel: press the `from` element, move the pointer, and release it over `to`. Use it '
      + 'for sliders, sortable lists, kanban cards and canvas handles that only respond to a real press-move-release. '
      + '`from` and `to` each name exactly one address — a ref from the latest browser_snapshot, a stable `loc` locator '
      + 'from a snapshot line, or a CSS `selector`; `to` may instead be a viewport point (`toX`/`toY`) or an offset from '
      + 'the source centre (`dx`/`dy`). `steps` sets how many moves are interpolated between press and release (2–30, '
      + 'default 8). The page-side sequence is synthetic: framework drag libraries (React DnD, dnd-kit, SortableJS, '
      + 'sliders, canvas handlers) are driven, the browser\'s native HTML5 drag-and-drop shuttle (draggable="true" with '
      + 'dragstart/drop) is not. Snapshot again afterwards.',
    parameters: {
      type: 'object',
      properties: {
        from: {
          type: 'object',
          description: 'The element to press: exactly one of ref, loc or selector.',
          properties: {
            ref: { type: 'string', description: 'A ref from the latest browser_snapshot, e.g. e5.' },
            loc: { type: 'string', description: 'A stable locator from a snapshot line, e.g. css:#slider.' },
            selector: { type: 'string', description: 'A CSS selector for an element with no usable ref.' },
          },
          additionalProperties: false,
        },
        to: {
          type: 'object',
          description: 'Where to release: exactly one of ref/loc/selector, or toX+toY, or dx+dy (offset from the source centre).',
          properties: {
            ref: { type: 'string', description: 'A ref for the drop target.' },
            loc: { type: 'string', description: 'A stable locator for the drop target.' },
            selector: { type: 'string', description: 'A CSS selector for the drop target.' },
            toX: { type: 'integer', description: 'Viewport x in CSS pixels for the release point; requires toY.' },
            toY: { type: 'integer', description: 'Viewport y in CSS pixels for the release point; requires toX.' },
            dx: { type: 'integer', description: 'Horizontal offset from the source centre, e.g. 80 for "move 80px right".' },
            dy: { type: 'integer', description: 'Vertical offset from the source centre.' },
          },
          additionalProperties: false,
        },
        steps: {
          type: 'integer',
          description: 'How many pointer moves are interpolated between press and release (2–30, default 8). More steps help pages that sample movement.',
        },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...ACTION_OUTPUT.properties,
          from: {
            type: 'object',
            properties: { x: { type: 'integer' }, y: { type: 'integer' } },
            required: ['x', 'y'],
          },
          to: {
            type: 'object',
            properties: { x: { type: 'integer' }, y: { type: 'integer' } },
            required: ['x', 'y'],
          },
          target: {
            type: 'object',
            properties: { name: { type: 'string' }, role: { type: 'string' }, tag: { type: 'string' } },
          },
          steps: { type: 'integer' },
        },
        required: ['from', 'to'],
      },
      render(_args, value) {
        const name = typeof value?.name === 'string' && value.name !== '' ? ` "${value.name}"` : ''
        const target = value?.role ? `${value.role}${name}` : 'the page'
        const from = `(${value?.from?.x ?? 0}, ${value?.from?.y ?? 0})`
        const to = `(${value?.to?.x ?? 0}, ${value?.to?.y ?? 0})`
        const lines = [`Dragged ${target} from ${from} to ${to}.`]
        const dropped = value?.target
        const droppedName = dropped !== null && typeof dropped === 'object' && typeof dropped.name === 'string' && dropped.name !== ''
          ? ` "${dropped.name}"`
          : ''
        if (dropped !== null && typeof dropped === 'object' && typeof dropped.role === 'string') {
          lines.push(`Released over ${dropped.role}${droppedName}.`)
        }
        lines.push('A drag is a write: check what the page shows now with browser_snapshot before guessing that it took effect.')
        return [{ type: 'text', text: `${lines.join('\n')}${dialogNote(value)}` }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      /** Read one address object, refusing anything ambiguous. */
      const addressOf = (value, label) => {
        const raw = value !== null && typeof value === 'object' ? value : {}
        const ref = typeof raw.ref === 'string' && raw.ref.trim() !== '' ? raw.ref.trim() : ''
        const loc = typeof raw.loc === 'string' && raw.loc.trim() !== '' ? raw.loc.trim() : ''
        const selector = typeof raw.selector === 'string' && raw.selector.trim() !== '' ? raw.selector.trim() : ''
        if ([ref, loc, selector].filter((one) => one !== '').length > 1) {
          throw new Error(`${label} takes exactly one of ref, loc or selector, not several: a locator is already a CSS path.`)
        }
        const toX = Number.isInteger(raw.toX) ? raw.toX : undefined
        const toY = Number.isInteger(raw.toY) ? raw.toY : undefined
        const dx = Number.isInteger(raw.dx) ? raw.dx : undefined
        const dy = Number.isInteger(raw.dy) ? raw.dy : undefined
        return { ref, loc, selector, toX, toY, dx, dy }
      }
      const from = addressOf(args?.from, 'from')
      const to = addressOf(args?.to, 'to')
      if (from.ref === '' && from.loc === '' && from.selector === '') {
        throw new Error('from needs a ref, loc or selector: the press has to land on an element.')
      }
      const hasPoint = to.toX !== undefined || to.toY !== undefined
      const hasDelta = to.dx !== undefined || to.dy !== undefined
      if (hasPoint === true && (to.toX === undefined || to.toY === undefined)) {
        throw new Error('to needs both toX and toY for a viewport point.')
      }
      const toCount = [to.ref, to.loc, to.selector].filter((one) => one !== '').length
        + (hasPoint === true ? 1 : 0)
        + (hasDelta === true ? 1 : 0)
      if (toCount === 0) {
        throw new Error('to needs a drop target: a ref/loc/selector, or toX+toY, or dx/dy.')
      }
      if (toCount > 1) {
        throw new Error('to takes exactly one drop target: a ref/loc/selector, or toX+toY, or dx/dy.')
      }
      const steps = Number.isInteger(args?.steps) ? args.steps : undefined
      const result = await bridge.request(
        sessionId,
        'drag',
        {
          ...(from.ref !== '' ? { ref: from.ref } : {}),
          ...(from.loc !== '' ? { loc: from.loc } : {}),
          ...(from.selector !== '' ? { selector: from.selector } : {}),
          ...(to.ref !== '' ? { toRef: to.ref } : {}),
          ...(to.loc !== '' ? { toLoc: to.loc } : {}),
          ...(to.selector !== '' ? { toSelector: to.selector } : {}),
          ...(hasPoint === true ? { toX: to.toX, toY: to.toY } : {}),
          ...(hasDelta === true ? { dx: to.dx, dy: to.dy } : {}),
          ...(steps === undefined ? {} : { steps }),
          source: actionSource(),
        },
        20_000,
      )
      if (result?.ok !== true) throw actionFailure(result, 'drag')
      return committed(withDialogs({
        ...(result.info ?? {}),
        from: result.from ?? { x: 0, y: 0 },
        to: result.to ?? { x: 0, y: 0 },
        ...(result.target !== null && typeof result.target === 'object'
          ? { target: result.target.info ?? result.target }
          : {}),
        ...(Number.isInteger(result.steps) ? { steps: result.steps } : {}),
      }, result))
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      const press = args?.from?.loc ?? args?.from?.selector ?? args?.from?.ref ?? 'element'
      return { card: 'generic', title: `Drag ${press}`, kind: 'edit', rawInput: args }
    },
    presentResult() {
      return { card: 'generic', title: 'Dragged' }
    },
  }
}

/**
 * Turn one page-side `fill` refusal into an error the model can act on. The
 * message says exactly how much was written before the failure — a batch that
 * stopped halfway is *not* the same as one that never ran.
 * @param {Record<string, unknown>} result - the page's `{ ok:false, error, … }`.
 * @returns {AgentBrowserError} the error to throw.
 */
function fillFailure(result) {
  const error = result?.error
  const filled = Array.isArray(result?.filled) ? result.filled.length : 0
  const index = Number.isInteger(result?.index) && result.index >= 0 ? `field ${result.index + 1} ` : ''
  const partial = filled > 0 ? `The first ${filled} field(s) were already filled; ` : 'Nothing was filled: '
  const messages = {
    stale_loc: `the loc ${JSON.stringify(String(result?.loc ?? ''))} no longer matches anything in the page. Take a new browser_snapshot and use a fresh loc.`,
    bad_loc: `the loc ${JSON.stringify(String(result?.loc ?? ''))} is not a css: locator.`,
    stale_ref: `ref ${JSON.stringify(String(result?.ref ?? ''))} is no longer in the page. Take a new browser_snapshot.`,
    bad_ref: `ref ${JSON.stringify(String(result?.ref ?? ''))} is not a ref.`,
    not_found: `no element matched selector ${JSON.stringify(String(result?.selector ?? ''))}.`,
    multiple: `selector ${JSON.stringify(String(result?.selector ?? ''))} matched ${String(result?.matched ?? 'several')} element(s); pass strict:false or narrow it.`,
    not_editable: `${index}is not a text field, a textarea or a select.`,
    needs_human: `${index}is a password field. Credentials stay with the human: ask the user to type it in the panel, then continue.`,
    disabled: `${index}is disabled.`,
    bad_option: `${index}does not have an option with that value or label.`,
    no_submit_target: 'submit:true was requested but the last field\'s form has no submit control. Name one with submit:{ loc } or click it with browser_click.',
    submit_failed: `the submit click threw ${String(result?.message ?? 'an error')}.`,
    no_fields: 'no fields were given.',
    too_many_fields: 'at most 50 fields can be filled in one call.',
  }
  const message = `${partial}${messages[error] ?? `the page refused the fill (${String(error ?? 'unknown')}).`}`
  const failure = new Error(message)
  if (typeof error === 'string' && error !== '') failure.code = error
  return failure
}

/**
 * `browser_fill` — write several form fields in one command, optionally submit.
 *
 * Values are typed the way `browser_type` types them (native setters plus
 * input/change events), but the page-side helper resolves *every* address before
 * the first keystroke: a stale locator or a password field fails without leaving
 * a half-filled form behind. One prompt covers the whole batch, because a form
 * is submitted or not submitted as a unit.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 */
export function browserFillTool(bridge) {
  return {
    name: 'browser_fill',
    description:
      'Fill several form fields in one call: each field carries its own stable `loc` (preferred), a `ref` from the '
      + 'latest browser_snapshot, or a CSS `selector`. Every address is checked before the first keystroke, so a stale '
      + 'locator or a password field fails without filling anything. Pass submit:true to click the last field\'s form '
      + 'submit control afterwards, or submit:{ loc } to name one. One confirmation covers the whole batch; password '
      + 'fields are refused — ask the user to type those in the panel.',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              loc: { type: 'string', description: 'Stable locator from a snapshot line, e.g. css:#email.' },
              ref: { type: 'string', description: 'Ref from the latest browser_snapshot, e.g. e3.' },
              selector: { type: 'string', description: 'CSS selector, when you already know one.' },
              value: { type: 'string', description: 'Text to put in the field (or the option value/label for a select).' },
              clear: { type: 'boolean', description: 'Replace the current value. Defaults to true; false appends.' },
            },
            required: ['value'],
            additionalProperties: false,
          },
          description: 'Fields to fill, in order. Each needs exactly one of loc / ref / selector.',
        },
        strict: { type: 'boolean', description: 'With selector: fail when it matches more than one element.' },
        submit: {
          description: 'true = click the form submit control; { loc|ref|selector } = click that control; omit = do not submit.',
          oneOf: [
            { type: 'boolean' },
            {
              type: 'object',
              properties: {
                loc: { type: 'string', description: 'Stable locator of the submit control, e.g. css:#save.' },
                ref: { type: 'string', description: 'Ref of the submit control.' },
                selector: { type: 'string', description: 'CSS selector of the submit control.' },
              },
              additionalProperties: false,
            },
          ],
        },
      },
      required: ['fields'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          filled: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tag: { type: 'string' },
                role: { type: 'string' },
                name: { type: 'string' },
                value: { type: 'string' },
                length: { type: 'integer' },
                selected: { type: 'string' },
              },
            },
          },
          submitted: { type: 'boolean' },
          navigated: { type: 'boolean' },
          effect: { type: 'string', enum: ['none', 'committed', 'unknown'] },
        },
        required: ['filled'],
      },
      render(_args, value) {
        const filled = Array.isArray(value?.filled) ? value.filled : []
        const lines = filled.map((field) => {
          const target = field?.role ? `${field.role} "${field?.name ?? ''}"` : 'field'
          const written = typeof field?.selected === 'string' && field.selected !== ''
            ? ` = ${JSON.stringify(field.selected)}`
            : typeof field?.value === 'string' ? ` = ${JSON.stringify(field.value)}` : ''
          return `* ${target}${written}`
        })
        let tail = ''
        if (value?.submitted === true) {
          tail = typeof value?.navigated === 'boolean'
            ? (value.navigated ? ' Submitted; the page navigated.' : ' Submitted (the address did not change).')
            : ' Submitted.'
        }
        return [{ type: 'text', text: `Filled ${filled.length} field(s):\n${lines.join('\n')}${tail}${dialogNote(value)}` }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const fields = Array.isArray(args?.fields) ? args.fields : []
      if (fields.length === 0) throw new Error('fields must contain at least one field')
      if (fields.length > 50) throw new Error('fields must contain at most 50 fields')
      const normalized = fields.map((field, index) => {
        if (field === null || typeof field !== 'object') throw new Error(`fields[${index}] must be an object`)
        const loc = typeof field.loc === 'string' && field.loc.trim() !== '' ? field.loc.trim() : ''
        const ref = typeof field.ref === 'string' && field.ref.trim() !== '' ? field.ref.trim() : ''
        const selector = typeof field.selector === 'string' && field.selector.trim() !== '' ? field.selector.trim() : ''
        if ([loc, ref, selector].filter((value) => value !== '').length !== 1) {
          throw new Error(`fields[${index}] needs exactly one of loc, ref or selector`)
        }
        if (loc !== '' && !loc.startsWith('css:')) throw new Error(`fields[${index}].loc must be a css: locator, e.g. "css:#email"`)
        if (typeof field.value !== 'string') throw new Error(`fields[${index}].value must be a string`)
        return {
          ...(loc === '' ? {} : { loc }),
          ...(ref === '' ? {} : { ref }),
          ...(selector === '' ? {} : { selector }),
          value: field.value,
          clear: field.clear !== false,
        }
      })
      let submit
      if (args?.submit === true) {
        submit = true
      } else if (args?.submit !== undefined && args?.submit !== null && typeof args?.submit === 'object') {
        const loc = typeof args.submit.loc === 'string' && args.submit.loc.trim() !== '' ? args.submit.loc.trim() : ''
        const ref = typeof args.submit.ref === 'string' && args.submit.ref.trim() !== '' ? args.submit.ref.trim() : ''
        const selector = typeof args.submit.selector === 'string' && args.submit.selector.trim() !== '' ? args.submit.selector.trim() : ''
        if ([loc, ref, selector].filter((value) => value !== '').length !== 1) {
          throw new Error('submit needs exactly one of loc, ref or selector')
        }
        if (loc !== '' && !loc.startsWith('css:')) throw new Error('submit.loc must be a css: locator, e.g. "css:#save"')
        submit = { ...(loc === '' ? {} : { loc }), ...(ref === '' ? {} : { ref }), ...(selector === '' ? {} : { selector }) }
      } else if (args?.submit !== undefined) {
        throw new Error('submit must be a boolean or an address object')
      }
      const result = await bridge.request(
        sessionId,
        'fill',
        {
          fields: normalized,
          ...(args?.strict === true ? { strict: true } : {}),
          ...(submit === undefined ? {} : { submit }),
          source: actionSource(),
        },
        60_000,
      )
      if (result?.ok !== true) throw fillFailure(result)
      const filled = (Array.isArray(result.fields) ? result.fields : []).map((field, index) => {
        const source = normalized[index] ?? {}
        const info = field?.info !== null && typeof field?.info === 'object' ? field.info : {}
        return {
          tag: String(info.tag ?? ''),
          role: String(info.role ?? ''),
          name: String(info.name ?? ''),
          value: typeof source.value === 'string' ? source.value : '',
          length: Number.isInteger(field?.length)
            ? field.length
            : (typeof source.value === 'string' ? source.value.length : 0),
          ...(typeof field?.selected?.label === 'string' && field.selected.label !== ''
            ? { selected: field.selected.label }
            : {}),
        }
      })
      return committed(withDialogs({
        filled,
        submitted: result.submit !== null && result.submit !== undefined,
        ...(typeof result.navigated === 'boolean' ? { navigated: result.navigated } : {}),
      }, result))
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      const count = Array.isArray(args?.fields) ? args.fields.length : 0
      return { card: 'generic', title: `Fill ${count} field(s)`, kind: 'edit', rawInput: args }
    },
    presentResult() {
      return { card: 'generic', title: 'Filled' }
    },
  }
}

/**
 * `browser_hover` — move the pointer over something without pressing it.
 *
 * Stacked controls (3D map cards, fly-out menus) only expose their buttons after
 * a `mouseover`; the move is a real input event, so the page runs its own hover
 * logic instead of the agent poking `element.click()` past it.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 */
export function browserHoverTool(bridge) {
  return {
    name: 'browser_hover',
    description:
      'Move the pointer over an element in the browser panel without clicking it. Use it before browser_click when a '
      + 'control only becomes reachable on hover (stacked cards that fan out, fly-out menus, tooltips). Pass a ref from '
      + 'the latest browser_snapshot, a stable `loc` locator from a snapshot line, a CSS selector, or x/y. Returns where '
      + 'the pointer rests and grew:true when the page reacted (a control expanded) — snapshot again, then click.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the latest browser_snapshot, e.g. e5 or f1e2.' },
        loc: { type: 'string', description: 'A stable locator copied from a snapshot line, e.g. css:#save. Use it when the ref you have may be stale; a vanished locator fails as stale_loc.' },
        selector: { type: 'string', description: 'A CSS selector, used when no ref fits. Must match exactly one visible element unless strict is false.' },
        strict: { type: 'boolean', description: 'With selector: false accepts the first of several matches instead of failing as multiple. Defaults to true.' },
        x: { type: 'integer', description: 'Viewport x in CSS pixels. Requires y; ignored when ref or selector is given.' },
        y: { type: 'integer', description: 'Viewport y in CSS pixels. Requires x.' },
        waitMs: { type: 'integer', description: 'Milliseconds to wait for the page to react to the hover. Defaults to 150 (max 2000).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...ACTION_OUTPUT.properties,
          x: { type: 'integer' },
          y: { type: 'integer' },
          grew: { type: 'boolean' },
        },
        required: ['x', 'y'],
      },
      render(_args, value) {
        const name = typeof value?.name === 'string' && value.name !== '' ? ` "${value.name}"` : ''
        const base = value?.role ? value.role : (value?.tag ? value.tag : '')
        const target = base !== '' ? `${base}${name}` : 'the page'
        const lines = [`Hovered ${target} at (${value?.x ?? 0}, ${value?.y ?? 0}).`]
        lines.push(value?.grew === true
          ? 'The layout changed under the pointer — something expanded. Snapshot again, then click the control you want.'
          : 'Nothing moved under the pointer (it was already expanded, or this control does not react to hover). Click the control you want, or retry with a larger waitMs.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const hasPoint = Number.isFinite(args?.x) && Number.isFinite(args?.y)
      const selector = typeof args?.selector === 'string' && args.selector.trim() !== '' ? args.selector.trim() : ''
      const loc = typeof args?.loc === 'string' && args.loc.trim() !== '' ? args.loc.trim() : ''
      if (loc !== '' && selector !== '') {
        throw new Error('pass either loc or selector, not both: a locator is already a CSS path.')
      }
      if (hasPoint && (selector !== '' || loc !== '')) {
        throw new Error('pass either a locator/selector or x/y, not both: a locator is resolved to a point for you.')
      }
      if (!hasPoint && selector === '' && loc === '') requireRef(args?.ref)
      const waitMs = Number.isFinite(args?.waitMs) ? Math.min(2000, Math.max(0, Math.round(args.waitMs))) : undefined
      const result = await bridge.request(
        sessionId,
        'hover',
        {
          ref: !hasPoint && selector === '' && loc === '' ? requireRef(args?.ref) : undefined,
          loc: loc === '' ? undefined : loc,
          selector: selector === '' ? undefined : selector,
          strict: typeof args?.strict === 'boolean' ? args.strict : undefined,
          x: hasPoint ? args.x : undefined,
          y: hasPoint ? args.y : undefined,
          waitMs,
          source: actionSource(),
        },
        20_000,
      )
      if (result?.ok !== true) throw actionFailure(result, 'hover')
      return {
        ...(result.info ?? {}),
        x: Math.round(result.x ?? 0),
        y: Math.round(result.y ?? 0),
        grew: result.grew === true,
      }
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      const what = args?.loc ?? args?.selector ?? args?.ref ?? `${args?.x},${args?.y}`
      return { card: 'generic', title: `Hover ${what}`, kind: 'edit', rawInput: args }
    },
    presentResult() {
      return { card: 'generic', title: 'Hovered' }
    },
  }
}

/**
 * `browser_scroll` — move the page so lazy content exists.
 *
 * Clicking a ref scrolls it into view, but that never triggers a lazy loader:
 * a list only asks for its next screen after a real scroll. `atBottom` is the
 * honest "there is nothing below this" signal, which is what a paging loop
 * needs to stop on instead of guessing (T1 / T6).
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 */
export function browserScrollTool(bridge) {
  return {
    name: 'browser_scroll',
    description:
      'Scroll the page in the browser panel. Pass ref/loc/selector to bring one element into view (best when a '
      + 'long page hides the thing you need), or dy (CSS pixels, default 600) to move down/up, or to:"top"/"bottom" '
      + 'to jump to an end; container (CSS selector) scrolls one scrollable box instead of the page. Addressed scroll '
      + 'returns the element rect plus visible/fullyVisible; unaddressed scroll returns the resulting position and '
      + 'atBottom (true when the page can go no further). Use it to trigger lazy loading before snapshotting again.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the latest browser_snapshot (e1, f1e2 …). Scrolls it into view.' },
        loc: { type: 'string', description: 'Stable loc copied from a snapshot (`css:…`); use it when the ref may have gone stale.' },
        selector: { type: 'string', description: 'CSS selector for the element to scroll into view (alternative to ref/loc).' },
        strict: { type: 'boolean', description: 'With selector: refuse when it matches more than one element. Defaults to false (first match).' },
        dy: { type: 'integer', description: 'Pixels to move: positive goes down, negative goes up. Ignored when `to` or an address is given. Defaults to 600.' },
        to: { type: 'string', enum: ['top', 'bottom'], description: 'Jump to the top or the bottom instead of moving by dy.' },
        container: { type: 'string', description: 'CSS selector of a scrollable element to scroll instead of the page.' },
        waitMs: { type: 'integer', description: 'Milliseconds to wait for lazy loading after the scroll. Defaults to 150; raise it for slow sites (max 2000).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['into-view', 'by-dy', 'to-edge'] },
          x: { type: 'integer' },
          y: { type: 'integer' },
          scrollHeight: { type: 'integer' },
          viewportHeight: { type: 'integer' },
          atBottom: { type: 'boolean' },
          matched: { type: 'boolean' },
          visible: { type: 'boolean' },
          fullyVisible: { type: 'boolean' },
          rect: {
            type: 'object',
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
          },
          info: {
            type: 'object',
            properties: {
              tag: { type: 'string' },
              role: { type: 'string' },
              name: { type: 'string' },
            },
          },
          frame: { type: 'string' },
          blockedNewWindow: { type: 'string' },
        },
        required: ['y', 'atBottom'],
      },
      render(_args, value) {
        if (value?.matched === true) {
          const what = value?.info !== null && typeof value?.info === 'object'
            ? `${value.info.role ?? value.info.tag ?? 'element'} "${value.info.name ?? ''}"`.trim()
            : 'element'
          const spot = `at (${value?.rect?.x ?? 0}, ${value?.rect?.y ?? 0}) ${value?.rect?.width ?? 0}×${value?.rect?.height ?? 0}`
          const visibility = value?.fullyVisible === true
            ? 'fully in view'
            : value?.visible === true ? 'partly in view' : 'still outside the viewport'
          return [{
            type: 'text',
            text: `Scrolled ${what} into view ${spot} — ${visibility}. Snapshot again to see it in context.`,
          }]
        }
        const end = value?.atBottom === true ? ' (at the bottom)' : ''
        const lines = [`Scrolled to y=${value?.y ?? 0} of ${value?.scrollHeight ?? 0}${end}. Snapshot again to see what has loaded.`]
        if (typeof value?.blockedNewWindow === 'string' && value.blockedNewWindow !== '') {
          lines.push(`window.open was blocked: ${value.blockedNewWindow}`)
        }
        return [{
          type: 'text',
          text: lines.join('\n'),
        }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const to = args?.to
      if (to !== undefined && to !== 'top' && to !== 'bottom') {
        throw new Error(`to must be "top" or "bottom", got ${JSON.stringify(String(to))}`)
      }
      const loc = typeof args?.loc === 'string' && args.loc.trim() !== '' ? args.loc.trim() : undefined
      const rawSelector = typeof args?.selector === 'string' && args.selector.trim() !== '' ? args.selector.trim() : undefined
      const hasRef = typeof args?.ref === 'string' && args.ref.trim() !== ''
      const addresses = [loc !== undefined, rawSelector !== undefined, hasRef].filter(Boolean).length
      if (addresses > 1) throw new Error('pass exactly one of ref, loc or selector')
      const addressed = addresses === 1
      if (addressed && (to !== undefined || args?.dy !== undefined || args?.container !== undefined)) {
        throw new Error('ref/loc/selector scroll the element into view; do not combine it with dy, to or container')
      }
      const dy = args?.dy === undefined ? undefined : Number(args.dy)
      if (dy !== undefined && !Number.isFinite(dy)) throw new Error('dy must be an integer number of pixels')
      const container = typeof args?.container === 'string' && args.container.trim() !== '' ? args.container.trim() : undefined
      const waitMs = Number.isFinite(args?.waitMs) ? args.waitMs : undefined
      const result = await bridge.request(
        sessionId,
        'scroll',
        {
          ...(addressed
            ? { ref: hasRef ? args.ref.trim() : undefined, loc, selector: rawSelector, strict: args?.strict === true }
            : { dy: dy === undefined ? undefined : Math.round(dy), to: to ?? undefined, container }),
          waitMs,
          source: actionSource(),
        },
        20_000,
      )
      if (result?.ok !== true) throw actionFailure(result, 'scroll')
      return {
        mode: result.mode === 'into-view' ? 'into-view' : result.to !== undefined ? 'to-edge' : 'by-dy',
        x: Math.round(result.x ?? 0),
        y: Math.round(result.y ?? 0),
        scrollHeight: Math.round(result.scrollHeight ?? 0),
        viewportHeight: Math.round(result.viewportHeight ?? 0),
        atBottom: result.atBottom === true,
        ...(result.matched === true
          ? {
              matched: true,
              visible: result.visible === true,
              fullyVisible: result.fullyVisible === true,
              rect: {
                x: Math.round(result.rect?.x ?? 0),
                y: Math.round(result.rect?.y ?? 0),
                width: Math.round(result.rect?.width ?? 0),
                height: Math.round(result.rect?.height ?? 0),
              },
              ...(result.info !== null && typeof result.info === 'object' ? { info: result.info } : {}),
              ...(typeof result.frame === 'string' && result.frame !== '' ? { frame: result.frame } : {}),
            }
          : {}),
        ...(Array.isArray(result.blockedNewWindow) && result.blockedNewWindow.length > 0
          ? { blockedNewWindow: result.blockedNewWindow.map((url) => String(url)).join(' ') }
          : {}),
      }
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      const what = args?.loc ? `to ${args.loc}` : args?.selector ? `to ${args.selector}` : args?.ref ? `to ${args.ref}` : args?.to ? `to ${args.to}` : `${args?.dy ?? 600}px`
      return { card: 'generic', title: `Scroll ${what}`, kind: 'edit', rawInput: args }
    },
    presentResult() {
      return { card: 'generic', title: 'Scrolled' }
    },
  }
}

/**
 * `browser_type` — put text into a field.
 *
 * Password fields are refused in the page before a single character is sent,
 * which is what keeps credentials out of the transcript (decision D07).
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 */
export function browserTypeTool(bridge) {
  return {
    name: 'browser_type',
    description:
      'Type text into a field identified by a ref from the latest browser_snapshot, or by the stable `loc` locator '
      + 'printed next to that ref. Clears the field first by default; pass submit:true to press Enter afterwards. '
      + 'Password fields are refused — ask the user to type those in the panel instead.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the latest browser_snapshot, e.g. e3.' },
        loc: { type: 'string', description: 'A stable locator copied from a snapshot line, e.g. css:#email. Use it when the ref you have may be stale; a vanished locator fails as stale_loc.' },
        text: { type: 'string', description: 'The text to put in the field.' },
        clear: { type: 'boolean', description: 'Replace the current value. Defaults to true; false appends.' },
        submit: { type: 'boolean', description: 'Press Enter after typing. Defaults to false.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...ACTION_OUTPUT.properties,
          length: { type: 'integer' },
          submitted: { type: 'boolean' },
        },
        required: ['length'],
      },
      render(_args, value) {
        const target = value?.role ? `${value.role} "${value.name ?? ''}"` : 'the field'
        const tail = value?.submitted === true ? ' and pressed Enter' : ''
        return [{ type: 'text', text: `Typed ${value?.length ?? 0} characters into ${target}${tail}.${dialogNote(value)}` }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const loc = typeof args?.loc === 'string' && args.loc.trim() !== '' ? args.loc.trim() : ''
      const ref = loc === '' ? requireRef(args?.ref) : undefined
      if (loc !== '' && args?.ref !== undefined) {
        throw new Error('pass either ref or loc, not both: a locator is the stable form of a ref.')
      }
      if (typeof args?.text !== 'string') throw new Error('text is required')
      const result = await bridge.request(
        sessionId,
        'type',
        { ref, loc: loc === '' ? undefined : loc, text: args.text, clear: args?.clear !== false, submit: args?.submit === true, source: actionSource() },
        20_000,
      )
      if (result?.ok !== true) throw actionFailure({ ...result, ...(loc === '' ? { ref } : { loc }) })
      return committed(withDialogs({ ...(result.info ?? {}), length: result.length ?? 0, submitted: result.submitted === true }, result))
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      return { card: 'generic', title: `Type into ${args?.loc ?? args?.ref ?? 'field'}`, kind: 'edit', rawInput: args }
    },
    presentResult() {
      return { card: 'generic', title: 'Typed' }
    },
  }
}

/**
 * `browser_press` — send one key, optionally with modifiers.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 */
export function browserPressTool(bridge) {
  return {
    name: 'browser_press',
    description:
      'Press one key in the browser panel: Enter, Tab, Escape, Backspace, Arrow keys, F5 to reload, or a single '
      + 'character, optionally with modifiers ("Alt+Left" goes back). Gives the page real keyboard input, so it '
      + 'works for focus order and keyboard shortcuts as well as text fields.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'A key or chord, e.g. "Enter", "Tab", "Escape", "Alt+Left", "F5".' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          keyCode: { type: 'string' },
          modifiers: { type: 'array', items: { type: 'string' } },
          handled: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          effect: { type: 'string', enum: ['none', 'committed', 'unknown'] },
        },
        required: ['key'],
      },
      render(_args, value) {
        if (typeof value?.handled === 'string' && value.handled !== '') {
          return [{ type: 'text', text: `Pressed ${value.key} — the panel performed "${value.handled}": ${value.from} → ${value.to}${dialogNote(value)}` }]
        }
        const mods = Array.isArray(value?.modifiers) && value.modifiers.length > 0 ? `${value.modifiers.join('+')}+` : ''
        return [{ type: 'text', text: `Pressed ${mods}${value?.keyCode ?? value?.key ?? ''}.${dialogNote(value)}` }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      if (typeof args?.key !== 'string' || args.key.trim() === '') throw new Error('key is required')
      const result = await bridge.request(sessionId, 'press', { key: args.key.trim() }, 20_000)
      if (result?.ok !== true) throw actionFailure(result)
      const value = {
        key: String(result.key ?? args.key),
        keyCode: String(result.keyCode ?? ''),
        modifiers: Array.isArray(result.modifiers) ? result.modifiers.map(String) : [],
      }
      if (typeof result.handled === 'string') {
        value.handled = result.handled
        value.from = String(result.from ?? '')
        value.to = String(result.to ?? '')
      }
      return committed(withDialogs(value, result))
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      return { card: 'generic', title: `Press ${args?.key ?? 'key'}`, kind: 'edit', rawInput: args }
    },
    presentResult() {
      return { card: 'generic', title: 'Key pressed' }
    },
  }
}

const UPLOAD_MAX_FILES = 5
const UPLOAD_MAX_FILE_BYTES = 2 * 1024 * 1024
const UPLOAD_MAX_TOTAL_BYTES = 4 * 1024 * 1024
/** Extension → MIME. Anything unknown is `application/octet-stream`. */
const UPLOAD_TYPES = Object.freeze({
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
})

/** `upload_rejected` — the refusal happened before anything reached the page. */
function uploadRejected(reason, message, details = {}) {
  return new AgentBrowserError(
    'upload_rejected',
    `upload refused before anything reached the page: ${message} Nothing was sent to the page.`,
    { details: { reason, ...details } },
  )
}

/**
 * Read one workspace file for upload.
 *
 * The bridge carries JSON, so bytes travel as base64; the page turns them back
 * into a `File`. Every refusal is a `upload_rejected` with a `reason`: the model
 * can fix the path instead of guessing whether something happened on the page.
 * @param {string} realRoot - real path of the session workspace.
 * @param {string} spec - path the model passed (relative to the workspace, or absolute).
 * @returns {{ name: string, bytes: Uint8Array }} file name and contents.
 */
function readUploadFile(realRoot, spec) {
  const target = isAbsolute(spec) ? spec : resolvePath(realRoot, spec)
  let real = ''
  try {
    real = realpathSync(target)
  } catch {
    throw uploadRejected('not_found', `no file called ${JSON.stringify(short(spec))} under the workspace.`, { file: short(spec) })
  }
  // `realpath` resolves symlinks and `..`, so the prefix check below is the one
  // that actually decides "inside the workspace": a link pointing out is refused.
  const prefix = (realRoot.endsWith(sep) ? realRoot : realRoot + sep).toLowerCase()
  if (real.toLowerCase().startsWith(prefix) === false) {
    throw uploadRejected(
      'outside_workspace',
      `that path is outside the session workspace, and browser_upload only reads files under it.`,
      { file: short(spec) },
    )
  }
  let stat = null
  try {
    stat = statSync(real)
  } catch {
    throw uploadRejected('not_found', `the workspace file ${JSON.stringify(short(spec))} could not be read.`, { file: short(spec) })
  }
  if (stat.isFile() !== true) {
    throw uploadRejected('not_a_file', `${JSON.stringify(short(spec))} is not a regular file.`, { file: short(spec) })
  }
  if (stat.size > UPLOAD_MAX_FILE_BYTES) {
    throw uploadRejected(
      'too_large',
      `${JSON.stringify(short(spec))} is ${stat.size} bytes; one file may be at most ${UPLOAD_MAX_FILE_BYTES} bytes.`,
      { file: short(spec), bytes: stat.size, limit: UPLOAD_MAX_FILE_BYTES },
    )
  }
  let bytes = null
  try {
    bytes = readFileSync(real)
  } catch {
    throw uploadRejected('not_readable', `the workspace file ${JSON.stringify(short(spec))} could not be read.`, { file: short(spec) })
  }
  return { name: basename(real), bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) }
}

/**
 * Base64 without Node's `Buffer`.
 *
 * Tool bodies do not always run in a realm that exposes `Buffer` (see
 * `sha256Hex`), and the bytes still have to cross the bridge as text.
 * @param {Uint8Array} bytes - bytes to encode.
 * @returns {string} base64 payload, no data-url prefix.
 */
export function encodeBase64(bytes) {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ''
  for (let i = 0; i < view.length; i += 3) {
    const a = view[i]
    const b = i + 1 < view.length ? view[i + 1] : 0
    const c = i + 2 < view.length ? view[i + 2] : 0
    out += table[a >> 2]
    out += table[((a & 0x03) << 4) | (b >> 4)]
    out += i + 1 < view.length ? table[((b & 0x0f) << 2) | (c >> 6)] : '='
    out += i + 2 < view.length ? table[c & 0x3f] : '='
  }
  return out
}

/** The MIME type a browser would infer from a filename. */
function uploadTypeOf(name) {
  return UPLOAD_TYPES[extname(String(name ?? '')).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * `browser_upload` — put workspace files into a page's `<input type="file">`.
 *
 * TICKET-047 / SPEC-004 stage B1. This is the first *irreversible* write the
 * plugin exposes: once the bytes are in the page, a form submit can send them
 * anywhere, so it is gated exactly like the other writes (site-level first-touch
 * approval, class `upload`) and its failures are `upload_rejected` with a
 * machine-readable `reason` until the moment the command is handed over.
 * There is no native picker: the host reads the file, ships base64, and the page
 * assembles a real `File` through `DataTransfer` — the same handover the
 * browser's own chooser performs. That is what makes hidden/styled file inputs
 * work, and what refuses sites that open a picker through JS.
 * @param {import('cordis').Context} ctx - plugin context, for `workingDirectory`.
 * @param {{ request: Function, inspect: Function, requestApproval: Function }} gate - approval seam.
 */
export function browserUploadTool(ctx, gate) {
  return {
    name: 'browser_upload',
    description:
      'Upload workspace files into a file input on the page (write action: the first use per site asks the user '
      + 'in the panel). Pass exactly one of ref / loc / selector for the target — it must be an <input type="file">. '
      + '`files` lists paths relative to the session workspace (absolute paths inside it also work): at most '
      + '5 files, 2 MiB each, 4 MiB total. The page receives real File objects with names, sizes and MIME types, '
      + 'and gets the same input/change events a native picker fires. It does not open a native file chooser, so '
      + 'hidden inputs behind styled buttons work; sites that open a chooser from JS (showOpenFilePicker) are '
      + 'refused. Refusals carry a reason and nothing is sent.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the latest browser_snapshot for the file input, e.g. e7.' },
        loc: { type: 'string', description: 'A stable locator copied from a snapshot line, e.g. css:#avatar. Fails as stale_loc when the page changed.' },
        selector: { type: 'string', description: 'A CSS selector for the file input, used when no ref fits.' },
        strict: { type: 'boolean', description: 'With selector: false accepts the first of several matches instead of failing as multiple. Defaults to true.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace paths, e.g. ["tmp/report.pdf"]. At most 5 files, 2 MiB each, 4 MiB total.',
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...ACTION_OUTPUT.properties,
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                size: { type: 'integer' },
                type: { type: 'string' },
              },
            },
          },
          multiple: { type: 'boolean' },
          url: { type: 'string' },
        },
        required: ['files'],
      },
      render(_args, value) {
        const files = Array.isArray(value?.files) ? value.files : []
        const listed = files
          .map((file) => `${String(file?.name ?? 'file')} (${Number(file?.size ?? 0)} B)`)
          .slice(0, 5)
          .join(', ')
        return [{
          type: 'text',
          text: `Uploaded ${files.length} file${files.length === 1 ? '' : 's'} into the page: ${listed}. `
            + 'The page saw a change event; snapshot again to see what it shows now.',
        }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const files = args?.files
      if (Array.isArray(files) === false || files.length === 0) {
        throw new Error('files must be a non-empty array of workspace file paths')
      }
      if (files.length > UPLOAD_MAX_FILES) {
        throw uploadRejected(
          'too_many_files',
          `browser_upload takes at most ${UPLOAD_MAX_FILES} files per call.`,
          { count: files.length, limit: UPLOAD_MAX_FILES },
        )
      }
      for (const item of files) {
        if (typeof item !== 'string' || item.trim() === '') throw new Error('each entry of files must be a non-empty path string')
      }
      const hasLoc = typeof args?.loc === 'string' && args.loc !== ''
      const hasRef = typeof args?.ref === 'string' && args.ref !== ''
      const hasSelector = typeof args?.selector === 'string' && args.selector !== ''
      if ([hasLoc, hasRef, hasSelector].filter(Boolean).length !== 1) {
        throw new Error('pass exactly one of ref, loc or selector: which file input to fill')
      }
      const address = hasLoc
        ? { loc: args.loc }
        : hasRef
          ? { ref: requireRef(args.ref) }
          : { selector: args.selector, strict: args?.strict }
      if (typeof gate?.inspect !== 'function') {
        throw new Error('this build cannot inspect a file input before uploading')
      }
      // Look at the address before reading a single byte: a stale locator or a
      // non-file target should fail instantly, not after the approval prompt.
      const seen = await gate.inspect(sessionId, address)
      if (seen.addressError !== '') {
        throw actionFailure({
          error: seen.addressError,
          loc: args?.loc,
          ref: args?.ref,
          selector: args?.selector,
        })
      }
      if (seen.known === true && seen.acceptsFiles !== true) {
        throw uploadRejected(
          'not_file_input',
          'that element is not an <input type="file">, so there is no picker to fill. '
            + 'Snapshot again and point at the file input itself.',
          { info: seen.target ?? null },
        )
      }
      // A single-file input cannot take a list: refuse before the prompt, the
      // same way a stale locator does. The page still checks again as a backstop.
      if (files.length > 1 && seen.known === true && seen.acceptsMultiple !== true) {
        throw uploadRejected(
          'multiple_not_allowed',
          `that file input takes a single file, but ${files.length} were given. `
            + 'Pass one file, or point at an input that allows multiple files.',
          { count: files.length },
        )
      }
      const root = await workspaceOf(ctx, exec)
      let realRoot = ''
      try {
        realRoot = realpathSync(root)
      } catch {
        throw uploadRejected('workspace_unavailable', 'the session workspace is not readable right now.', {})
      }
      const payload = []
      let total = 0
      for (const spec of files) {
        const file = readUploadFile(realRoot, spec.trim())
        total += file.bytes.length
        if (total > UPLOAD_MAX_TOTAL_BYTES) {
          throw uploadRejected(
            'too_large',
            `the files together exceed ${UPLOAD_MAX_TOTAL_BYTES} bytes.`,
            { bytes: total, limit: UPLOAD_MAX_TOTAL_BYTES },
          )
        }
        payload.push({
          name: file.name,
          type: uploadTypeOf(file.name),
          size: file.bytes.length,
          b64: encodeBase64(file.bytes),
        })
      }
      // The first irreversible write per site: same site-level first-touch gate
      // as every other write, with its own class so the prompt can say "upload"
      // instead of reusing a click's wording.
      await gate.requestApproval(sessionId, {
        actionClass: 'upload',
        origin: originOf(seen.url),
        url: seen.url,
        target: { files: payload.map(({ name, size }) => ({ name, size })), bytes: total },
      })
      const result = await gate.request(sessionId, 'upload', { ...address, files: payload, source: actionSource() }, 30_000)
      if (result?.ok !== true) throw actionFailure(result, 'upload')
      return committed({
        files: Array.isArray(result.files)
          ? result.files.map((file) => ({
            name: String(file?.name ?? 'file'),
            size: Number(file?.size) || 0,
            type: String(file?.type ?? ''),
          }))
          : [],
        multiple: result.multiple === true,
        ...(typeof result.url === 'string' && result.url !== '' ? { url: result.url } : {}),
      })
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      const count = Array.isArray(args?.files) ? args.files.length : 0
      return { card: 'generic', title: `Upload ${count} file${count === 1 ? '' : 's'}`, kind: 'edit', rawInput: args }
    },
    presentResult(_args, value) {
      const count = Array.isArray(value?.files) ? value.files.length : 0
      return { card: 'generic', title: `Uploaded ${count} file${count === 1 ? '' : 's'}` }
    },
  }
}

/**
 * `browser_eval` — run a script in the page and return its value.
 *
 * This is the escape hatch for everything the tree cannot express; it is also
 * the only tool whose power the model can misuse, so the description says so.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 * @param {{ maxChars?: number, rules?: ReturnType<typeof createPolicy> }} [options] - limits and the
 *   policy object; `rules.checkEval()` reads `evalEnabled` on every call, so a live toggle applies.
 */
export function browserEvalTool(bridge, options = {}) {
  const defaultMaxChars = Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : 8000
  const MIN_CHARS = 200
  const MAX_CHARS = 30_000
  const rules = options.rules ?? createPolicy()
  return {
    name: 'browser_eval',
    description:
      'Evaluate a JavaScript expression in the page and return its JSON value. Use it when the accessibility '
      + 'tree is not enough (reading a value the tree omits, waiting on a promise). It runs with the page\'s own '
      + 'privileges: never use it to work around a login or a human-verification check — hand those to the user.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'An expression or statement block, e.g. "document.title".' },
        awaitPromise: { type: 'boolean', description: 'Await a returned promise. Defaults to true.' },
        maxChars: {
          type: 'integer',
          // Same reason as browser_snapshot: the range is text + a clamp, not a
          // schema keyword the host subset does not have.
          description: `Character budget for the serialized result, clamped to 200–30000. Defaults to ${defaultMaxChars}.`,
        },
      },
      required: ['script'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          result: { type: 'string' },
          truncated: { type: 'boolean' },
          pending: { type: 'boolean' },
          effect: { type: 'string', enum: ['none', 'committed', 'unknown'] },
        },
        required: ['result'],
      },
      render(_args, value) {
        const notes = []
        if (value?.truncated === true) notes.push('result cut at the character budget')
        if (value?.pending === true) notes.push('the script returned a promise that was not awaited')
        const tail = notes.length > 0 ? `\n(${notes.join('; ')})` : ''
        return [{ type: 'text', text: `${value?.result ?? ''}${tail}${dialogNote(value)}` }]
      },
    },
    async execute(args, exec) {
      rules.checkEval()
      const sessionId = sessionOf(exec)
      if (typeof args?.script !== 'string' || args.script.trim() === '') throw new Error('script is required')
      const maxChars = Number.isFinite(args?.maxChars) ? rules.clampChars(args.maxChars, MAX_CHARS, MIN_CHARS) : defaultMaxChars
      const result = await bridge.request(
        sessionId,
        'eval',
        { script: args.script, awaitPromise: args?.awaitPromise !== false, maxChars },
        30_000,
      )
      if (result?.ok !== true) {
        // The script reached the page and threw: statements before the throw may
        // already have run, so this is the middle state, not a clean failure
        // (SPEC-004 B4). Never invite a retry.
        throw new AgentBrowserError(
          'action_unknown',
          `the script reached the page and threw: ${String(result?.error ?? 'unknown error')}. `
          + 'The page may have partially changed — take a browser_snapshot and check before retrying.',
          { details: { effect: 'unknown', delivered: true, type: 'eval' } },
        )
      }
      return committed(withDialogs({
        result: String(result.serialized ?? ''),
        truncated: result.truncated === true,
        pending: result.pending === true,
      }, result))
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      return { card: 'generic', title: 'Evaluate in page', kind: 'edit', rawInput: args }
    },
    presentResult() {
      return { card: 'generic', title: 'Page script result' }
    },
  }
}

/**
 * `browser_screenshot` — save a picture of the page into the workspace.
 *
 * `browser_snapshot`'s picture is a vision-budget thumbnail that disappears into
 * the attachment store; this one is a file on disk with a path, a size and a
 * hash, which is what a report or a review needs. A long page is stitched from
 * several viewport frames by the panel (see `Guest#screenshot`), so one call can
 * return the whole document instead of the first screen.
 * @param {import('cordis').Context} ctx - host context, for `workingDirectory`.
 * @param {{ request: Function }} gate - bridge gate carrying activation/fit policy.
 */
export function browserScreenshotTool(ctx, gate) {
  return {
    name: 'browser_screenshot',
    description:
      'Save a PNG of the page in the browser panel to `<workspace>/screenshots/` and return its path, size, '
      + 'dimensions and sha256. By default a page taller than the panel is stitched into one full-page image '
      + '(scrolling and joining frames); pass mode:"viewport" for just the visible screen. Use this when a '
      + 'screenshot is an artifact (a report figure, evidence for the user) instead of something to look at — '
      + 'it costs no vision budget. The image stops at maxHeight CSS pixels and says so when it did.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Optional file name, e.g. "list.png". Omit it for a timestamped name. Never overwrites: a duplicate becomes "name-1.png".',
        },
        mode: {
          type: 'string',
          enum: ['full', 'viewport'],
          description: 'full (default) stitches the whole page; viewport saves only what is on screen.',
        },
        maxHeight: {
          type: 'integer',
          description: 'Stop stitching after this many page CSS pixels. Defaults to 10000.',
        },
        overlap: {
          type: 'integer',
          description: 'CSS pixels of overlap between stitched frames, so no line is lost at a seam. Defaults to 40.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          sha256: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          frames: { type: 'integer' },
          mode: { type: 'string' },
          pageHeight: { type: 'integer' },
          truncated: { type: 'boolean' },
          /**
           * The same PNG as an image attachment, for the conversation card
           * (TICKET-023). It is not shown to the model — the render below stays
           * text-only so a screenshot costs no vision budget — and the ref is
           * plain JSON so it survives persistence and a restart.
           */
          thumb: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
            required: ['attachmentId', 'mediaType'],
          },
        },
        required: ['path', 'bytes', 'sha256'],
      },
      render(_args, value) {
        const size = Number.isFinite(value?.width) && Number.isFinite(value?.height)
          ? `${value.width} × ${value.height} px`
          : 'panel size'
        const frames = Number.isFinite(value?.frames) && value.frames > 1 ? `, ${value.frames} frames stitched` : ''
        const lines = [
          `Saved ${String(value?.path)} (${size}${frames}, ${formatBytes(value?.bytes)})`,
          'It is a file on disk, not a vision input: open it with the read tool only if you need to look at it.',
        ]
        if (value?.truncated === true) {
          lines.push(`Stopped at the height limit — the page is ${String(value?.pageHeight ?? 0)} CSS px tall. Raise maxHeight or take a second shot after scrolling.`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
      /** Card data for the inline thumbnail (TICKET-023); see `thumb` above. */
      presentationMeta(_args, value) {
        const meta = {
          path: String(value?.path ?? ''),
          bytes: Number(value?.bytes ?? 0),
          sha256: String(value?.sha256 ?? ''),
        }
        if (Number.isFinite(value?.width)) meta.width = value.width
        if (Number.isFinite(value?.height)) meta.height = value.height
        if (value?.truncated === true) meta.truncated = true
        if (value?.thumb !== undefined) meta.thumb = value.thumb
        return meta
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const mode = args?.mode === 'viewport' ? 'viewport' : 'full'
      let step = 'command'
      try {
        const result = await gate.request(
          sessionId,
          'screenshot',
          {
            mode,
            ...(Number.isFinite(args?.maxHeight) ? { maxHeight: Math.trunc(args.maxHeight) } : {}),
            ...(Number.isFinite(args?.overlap) ? { overlap: Math.trunc(args.overlap) } : {}),
          },
          60_000,
        )
        if (result?.ok === false) throw new Error(String(result?.error ?? 'the panel refused to take a screenshot'))
        // A command settles with the guest payload already unwrapped; older panels
        // nested it one level deeper, so both shapes are accepted.
        const value = result?.result ?? result
        const dataUrl = typeof value?.dataUrl === 'string' ? value.dataUrl : ''
        const comma = dataUrl.indexOf(',')
        if (!dataUrl.startsWith('data:image/png;base64,') || comma < 0) {
          throw new Error('the panel returned no PNG data')
        }
        step = 'decode'
        const bytes = decodeBase64(dataUrl.slice(comma + 1))
        step = 'workspace'
        const root = await workspaceOf(ctx, exec)
        const dir = join(root, 'screenshots')
        step = 'mkdir'
        await mkdir(dir, { recursive: true })
        step = 'reserve'
        const name = shotName(args?.name)
        const target = await uniquePath(dir, name)
        step = 'write'
        await writeFile(target, bytes)
        step = 'hash'
        const sha256 = sha256Hex(bytes)
        step = 'attach'
        const thumb = await attachImageBytes(ctx, bytes, 'browser-screenshot.png')
        return {
          path: relativeFrom(root, target),
          bytes: bytes.length,
          sha256,
          ...(Number.isFinite(value?.width) ? { width: Math.round(value.width) } : {}),
          ...(Number.isFinite(value?.height) ? { height: Math.round(value.height) } : {}),
          frames: Number.isFinite(value?.frames) ? Math.round(value.frames) : 1,
          mode: typeof value?.mode === 'string' ? value.mode : mode,
          pageHeight: Number.isFinite(value?.pageHeight) ? Math.round(value.pageHeight) : 0,
          truncated: value?.truncated === true,
          ...(thumb === undefined ? {} : { thumb }),
        }
      } catch (error) {
        // Keep the code: `cancelled` / `bridge_timeout` are what the model and
        // the UI branch on, so the step becomes context ON the structured error
        // instead of wrapping everything into a plain Error and losing the code.
        if (isAgentBrowserError(error)) {
          throw new AgentBrowserError(error.code, `${error.message} (screenshot step: ${step})`, {
            cause: error,
            retryable: error.retryable,
            details: { ...error.details, step },
          })
        }
        const reason = error instanceof Error ? error.message : String(error)
        // `step` turns an opaque host-context error into something reportable.
        throw new Error(`screenshot failed at ${step}: ${reason}`)
      }
    },
    /** Capturing moves the page and reads its pixels: never run two at once. */
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      return { card: 'generic', title: `Screenshot ${args?.mode ?? 'full'}`, kind: 'fetch', rawInput: args }
    },
    presentResult(_args, result) {
      return { card: 'generic', title: result?.isError === true ? 'Screenshot failed' : 'Screenshot saved' }
    },
  }
}

/**
 * sha256 of a byte array as lowercase hex.
 *
 * Implemented here rather than with `node:crypto` on purpose: a tool body can
 * run in a context whose host shims do not expose Node's `Buffer`, and both
 * `createHash(...).update(bytes)` and `crypto.subtle.digest` reach for it in
 * this host (`Buffer is not available for the current Context`). Forty lines of
 * arithmetic run anywhere.
 * @param {Uint8Array} bytes - bytes to hash.
 * @returns {string} lowercase hex digest.
 */
export function sha256Hex(bytes) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]
  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const length = bytes.length
  const padded = new Uint8Array((((length + 9 + 63) >> 6) << 6))
  padded.set(bytes)
  padded[length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor((length * 8) / 0x100000000))
  view.setUint32(padded.length - 4, (length * 8) >>> 0)
  const w = new Uint32Array(64)
  const rotr = (x, n) => (x >>> n) | (x << (32 - n))
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((word) => word.toString(16).padStart(8, '0')).join('')
}

/**
 * Decode base64 without Node's `Buffer`.
 *
 * Tool bodies do not always run in the same realm as their module (a sandboxed
 * context may not expose `Buffer` at all), so this stays a plain Uint8Array
 * build: it is also what `writeFile` and `createHash` accept.
 * @param {string} text - base64 payload, no data-url prefix.
 * @returns {Uint8Array} the decoded bytes.
 */
export function decodeBase64(text) {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let at = 0
  let buffer = 0
  let bits = 0
  for (const character of clean) {
    const value = table.indexOf(character)
    if (value < 0) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[at] = (buffer >> bits) & 0xff
      at += 1
    }
  }
  return at === out.length ? out : out.subarray(0, at)
}

/** A filesystem-safe name for a screenshot: one segment, ascii, ends in `.png`. */
export function shotName(input) {
  const raw = typeof input === 'string' && input.trim() !== '' ? basename(input.trim()) : ''
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80)
  const stem = cleaned.replace(/\.png$/i, '')
  if (stem === '') return `shot-${stamp()}.png`
  return `${stem}.png`
}

/** Never replace an existing screenshot: `a.png`, `a-1.png`, `a-2.png`. */
export async function uniquePath(dir, name) {
  const stem = name.replace(/\.png$/i, '')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(dir, attempt === 0 ? `${stem}.png` : `${stem}-${attempt}.png`)
    try {
      await writeFile(candidate, '', { flag: 'wx' })
      return candidate
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error(`could not find a free name for ${name} in screenshots/`)
}

/** A compact local timestamp, stable enough to sort and read. */
function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** Path as the model should see it: relative to the workspace, posix-style. */
function relativeFrom(root, absolute) {
  const normalRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normal = absolute.replace(/\\/g, '/')
  return normal.startsWith(`${normalRoot}/`) ? normal.slice(normalRoot.length + 1) : normal
}

/**
 * `browser_download` — save a file the page links to into the workspace.
 *
 * The page is not involved: the host fetches the url itself (see `downloads.js`
 * for why). That makes the tool usable on an attachment href that would
 * otherwise open a PDF viewer, and it gives the model a hash it can re-check
 * later. A failed download comes back as `download_failed` rather than a thrown
 * error, because the recovery is a *different* call (`browser_snapshot` the page,
 * `browser_eval` the href again) and the card should still render what happened.
 * @param {import('cordis').Context} ctx - host context, for `workingDirectory`.
 * @param {{ requestApproval?: Function }} gate - the gated bridge, for the first-touch permission check.
 * @param {{ dir?: string, maxBytes?: number, rules?: ReturnType<typeof createPolicy> }} [options] - target directory and size
 *   ceiling, plus the policy object, from config (`downloads.dir` / `downloads.maxBytes`).
 */
export function browserDownloadTool(ctx, gate, options = {}) {
  const dir = typeof options.dir === 'string' && options.dir !== '' ? options.dir : 'downloads'
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : undefined
  const rules = options.rules ?? createPolicy()
  return {
    name: 'browser_download',
    description:
      'Download a file (PDF, Word, Excel, zip) to `<workspace>/downloads/` and return its path, size and sha256. '
      + 'Pass an absolute http(s) url — resolve a relative href against the page url first (the snapshot prints it). '
      + 'Use this for attachments instead of opening them: a PDF opened in the panel only gives you a stub tree. '
      + 'If the result is `download_failed`, tell the user the download failed and why. Never describe the contents '
      + 'of a file you did not receive.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute http(s) URL of the file. Relative hrefs must be resolved against the page first.',
        },
        filename: {
          type: 'string',
          description:
            'Optional local name, e.g. "regulation-2024.pdf". Omit it: the server name or the url basename is usually '
            + 'more accurate. Existing files are never replaced — a duplicate becomes "name-1.pdf".',
        },
        referer: {
          type: 'string',
          description: 'Optional Referer, for sites that refuse a download that did not come from their page.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          sha256: { type: 'string' },
          mime: { type: 'string' },
          finalUrl: { type: 'string' },
          effect: { type: 'string', enum: ['none', 'committed', 'unknown'] },
          download_failed: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              stage: { type: 'string' },
              reason: { type: 'string' },
              url: { type: 'string' },
            },
            required: ['stage', 'reason'],
          },
        },
      },
      render(_args, value) {
        if (value?.download_failed !== undefined) {
          const failed = value.download_failed
          return [{
            type: 'text',
            text: `Download failed at ${String(failed.stage)}: ${String(failed.reason)}`
              + '\n\nNothing was saved. Do not describe the file contents; report the failure instead.',
          }]
        }
        return [{
          type: 'text',
          text: `Saved ${String(value?.path)} (${String(value?.bytes)} bytes, sha256 ${String(value?.sha256)})`,
        }]
      },
      /** Card data for the downloaded-file row (TICKET-023). */
      presentationMeta(_args, value) {
        if (value?.download_failed !== undefined) {
          const failed = value.download_failed
          return {
            failed: true,
            stage: String(failed?.stage ?? ''),
            reason: String(failed?.reason ?? ''),
          }
        }
        const meta = {
          path: String(value?.path ?? ''),
          bytes: Number(value?.bytes ?? 0),
          sha256: String(value?.sha256 ?? ''),
        }
        if (typeof value?.mime === 'string' && value.mime !== '') meta.mime = value.mime
        return meta
      },
    },
    async execute(args, exec) {
      if (typeof args?.url !== 'string' || args.url.trim() === '') throw new Error('url is required')
      const root = await workspaceOf(ctx, exec)
      // A download is a write against the site even though the page never sees
      // it, so it takes the same first-touch question as `type` and `submit`.
      // Running it before the fetch is what makes "nothing was sent" true.
      await gate?.requestApproval?.(sessionOf(exec), { actionClass: 'download', url: args.url.trim() })
      try {
        return committed(await downloadTo(root, {
          url: args.url.trim(),
          dir,
          ...(maxBytes === undefined ? {} : { maxBytes }),
          ...(typeof args?.filename === 'string' && args.filename.trim() !== '' ? { filename: args.filename.trim() } : {}),
          ...(typeof args?.referer === 'string' && args.referer.trim() !== '' ? { referer: args.referer.trim() } : {}),
          // The policy sees the final name and byte count, which is the only
          // point where the extension blacklist and size ceiling are truthful.
          checkTarget: ({ filename, bytes }) => rules.checkDownload(filename, bytes),
        }))
      } catch (error) {
        if (error instanceof DownloadError) {
          const where = error.url ?? error.finalUrl
          const failed = { code: 'download_rejected', stage: error.stage, reason: error.message }
          if (typeof where === 'string') failed.url = where
          return { download_failed: failed, effect: 'none' }
        }
        if (error instanceof AgentBrowserError && error.code === 'download_rejected') {
          return { download_failed: { code: 'download_rejected', stage: 'policy', reason: error.message }, effect: 'none' }
        }
        throw error
      }
    },
    /** No page is touched, so two downloads cannot race each other. */
    isConcurrencySafe() {
      return true
    },
    presentCall(args) {
      return { card: 'generic', title: 'Download file', kind: 'fetch', rawInput: args }
    },
    presentResult(_args, result) {
      return { card: 'generic', title: result?.isError === true ? 'Download failed' : 'File saved' }
    },
  }
}

/**
 * `browser_zoom` — scale the page inside the panel.
 *
 * The sidebar has a fixed width and most sites are laid out for a desktop one,
 * so a page at 100% either overflows or collapses into a phone layout. Zooming
 * out gives the page a wider layout viewport (which is what makes those sites
 * usable); zooming in makes small text readable. The same path backs the panel's
 * `− 100% +` control, so a test can drive it without a human hand.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 */
export function browserZoomTool(bridge) {
  return {
    name: 'browser_zoom',
    description:
      'Set how large the page inside the browser panel is (25%–300%). Zooming out enlarges the page\'s own layout '
      + 'viewport, which is how a desktop site becomes usable in the narrow sidebar; zooming in makes small text '
      + 'readable. Pass factor for an absolute value, delta to step from the current zoom, or reset:true for 100%. '
      + 'Refs and coordinates from a snapshot taken before the zoom are stale — snapshot again afterwards.',
    parameters: {
      type: 'object',
      properties: {
        factor: { type: 'number', description: 'Absolute zoom: 0.5 is half size, 1 is 100%, 2 is double. Between 0.25 and 3.' },
        delta: { type: 'number', description: 'Step from the current zoom, e.g. -0.1. Ignored when factor is given.' },
        reset: { type: 'boolean', description: 'Back to 100%. Ignored when factor is given.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          zoom: { type: 'number' },
          mode: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
        required: ['zoom'],
      },
      render(_args, value) {
        const pct = Math.round(Number(value?.zoom ?? 1) * 100)
        const sized = Number.isFinite(value?.width) && Number.isFinite(value?.height)
          ? ` The page now believes the panel is ${value.width} × ${value.height} CSS px.`
          : ''
        return [{
          type: 'text',
          text: `Zoom set to ${pct}%.${sized} Snapshot again before clicking: refs and coordinates from before the zoom no longer apply.`,
        }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const factor = Number.isFinite(args?.factor) ? Number(args.factor) : undefined
      const delta = Number.isFinite(args?.delta) ? Number(args.delta) : undefined
      const reset = args?.reset === true
      if (factor === undefined && delta === undefined && !reset) {
        throw new Error('pass factor, delta or reset:true')
      }
      if (factor !== undefined && (factor < 0.25 || factor > 3)) {
        throw new Error('factor must be between 0.25 and 3')
      }
      if (delta !== undefined && Math.abs(delta) > 1) {
        throw new Error('delta must be within ±1')
      }
      const result = await bridge.request(
        sessionId,
        'zoom',
        { factor, delta, reset: reset || undefined },
        20_000,
      )
      if (result?.ok !== true) throw new Error(String(result?.error ?? 'the panel refused to zoom'))
      const zoom = Number(result.zoom ?? 1)
      return {
        zoom: Math.round(zoom * 100) / 100,
        mode: typeof result.mode === 'string' ? result.mode : '',
        ...(Number.isFinite(result.width) ? { width: Math.round(result.width) } : {}),
        ...(Number.isFinite(result.height) ? { height: Math.round(result.height) } : {}),
      }
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      const what = args?.factor !== undefined ? `${Math.round(args.factor * 100)}%` : (args?.reset === true ? '100%' : `${args?.delta > 0 ? '+' : ''}${args?.delta ?? ''}`)
      return { card: 'generic', title: `Zoom ${what}`, kind: 'edit', rawInput: args }
    },
    presentResult(_args, value) {
      return { card: 'generic', title: `Zoom ${Math.round(Number(value?.zoom ?? 1) * 100)}%` }
    },
  }
}

/**
 * TICKET-056: let the model re-read its own recent actions.
 *
 * The recorder lives in the host process, so this tool works even while the
 * panel is closed or the conversation was compacted: it is the only place where
 * "which calls happened, did they take effect, which error code came back, and
 * where did that screenshot go" survives without context. Pure read: it never
 * touches the page and never asks the human.
 *
 * @param {ReturnType<typeof createTimeline>} timeline - the host-side recorder.
 */
export function browserTimelineTool(timeline) {
  const renderEntry = (entry) => {
    const millis = Number.isFinite(entry.at) ? entry.at : Date.parse(String(entry.at ?? ''))
    const at = Number.isFinite(millis) ? new Date(millis) : null
    const clock = at === null
      ? '??:??:??'
      : `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:${String(at.getSeconds()).padStart(2, '0')}`
    const mark = entry.ok === true ? 'ok' : 'FAILED'
    const effect = entry.ok === true && typeof entry.effect === 'string' && entry.effect !== '' ? ` (${entry.effect})` : ''
    const code = entry.ok === false && typeof entry.code === 'string' ? ` [${entry.code}]` : ''
    const took = Number.isFinite(entry.ms) ? ` ${entry.ms}ms` : ''
    const summary = typeof entry.summary === 'string' && entry.summary.trim() !== '' ? ` — ${entry.summary}` : ''
    const evidence = typeof entry.file === 'string' && entry.file !== ''
      ? `\n    file: ${entry.file}${Number.isInteger(entry.bytes) ? ` (${entry.bytes} B)` : ''}`
      : ''
    return `#${entry.seq} ${clock} ${mark} ${entry.tool}${code}${effect}${took}${summary}${evidence}`
  }

  return {
    name: 'browser_timeline',
    description:
      'Read back the browser actions this plugin has already executed, newest first — which tool ran, whether it took '
      + 'effect (effect: committed/unknown) or failed (with the stable error code), its arguments summary, and the file '
      + 'path of screenshots/downloads written along the way. The record lives in the DSH host process, so it keeps '
      + 'working while the browser panel is closed and after the conversation was compacted. Read-only: it never touches '
      + 'the page and needs no approval. The buffer holds the most recent 200 calls and is cleared when the plugin reloads.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many entries, newest first. Default 10, 1–50.' },
        tool: { type: 'string', description: 'Only entries for this tool name, e.g. "browser_click".' },
        failedOnly: { type: 'boolean', description: 'Only failed calls (this is the way to answer "did anything fail?").' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          total: { type: 'integer', description: 'Entries currently in the buffer.' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                seq: { type: 'integer' },
                at: { type: 'string', description: 'ISO timestamp.' },
                tool: { type: 'string' },
                ok: { type: 'boolean' },
                effect: { type: 'string' },
                code: { type: 'string' },
                summary: { type: 'string' },
                url: { type: 'string' },
                file: { type: 'string' },
                bytes: { type: 'integer' },
                ms: { type: 'integer' },
              },
              required: ['seq', 'at', 'tool', 'ok'],
            },
          },
        },
        required: ['total', 'entries'],
      },
      render(_args, value) {
        const entries = Array.isArray(value?.entries) ? value.entries : []
        if (entries.length === 0) {
          return [{
            type: 'text',
            text: 'No browser actions have been recorded yet in this host process. The record is filled by tool calls, so this is expected before the first one.',
          }]
        }
        const failed = entries.filter((entry) => entry.ok !== true).length
        const header = `${entries.length} recent action(s) (newest first), ${failed} failed; ${value.total} in the buffer.`
        const lines = entries.map(renderEntry)
        const hint = value.total > entries.length
          ? '\nPass a larger limit (up to 50) to see more.'
          : ''
        return [{ type: 'text', text: `${header}\n${lines.join('\n')}${hint}` }]
      },
    },
    async execute(args) {
      const requested = args?.limit
      if (requested !== undefined && (Number.isInteger(requested) === false || requested < 1 || requested > 50)) {
        throw new Error('limit must be an integer between 1 and 50')
      }
      const tool = typeof args?.tool === 'string' && args.tool !== '' ? args.tool : undefined
      const entries = timeline.list({
        limit: requested ?? 10,
        ...(tool === undefined ? {} : { tool }),
        failedOnly: args?.failedOnly === true,
      })
      return {
        total: timeline.size,
        entries: entries.map((entry) => ({
          seq: entry.seq,
          at: new Date(Number.isFinite(entry.at) ? entry.at : Date.now()).toISOString(),
          tool: entry.tool,
          ok: entry.ok,
          ...(typeof entry.effect === 'string' && entry.effect !== '' ? { effect: entry.effect } : {}),
          ...(typeof entry.code === 'string' && entry.code !== '' ? { code: entry.code } : {}),
          ...(entry.summary === '' ? {} : { summary: entry.summary }),
          ...(typeof entry.url === 'string' && entry.url !== '' ? { url: entry.url } : {}),
          ...(typeof entry.file === 'string' && entry.file !== '' ? { file: entry.file } : {}),
          ...(Number.isInteger(entry.bytes) ? { bytes: entry.bytes } : {}),
          ...(Number.isInteger(entry.ms) ? { ms: entry.ms } : {}),
        })),
      }
    },
    isConcurrencySafe() {
      return true
    },
    presentCall(args) {
      const scope = args?.failedOnly === true ? 'failed actions' : (typeof args?.tool === 'string' ? `${args.tool} calls` : 'recent actions')
      return { card: 'generic', title: `Read ${scope}`, kind: 'read', rawInput: args }
    },
    presentResult(_args, value) {
      const count = Array.isArray(value?.entries) ? value.entries.length : 0
      return { card: 'generic', title: `${count} action(s) in the timeline` }
    },
  }
}

const FILES_DEFAULT_LIMIT = 20
const FILES_MAX_LIMIT = 100

/** Clamp the `limit` argument of `browser_files`, rejecting non-integers. */
function filesLimit(input) {
  if (input === undefined || input === null) return FILES_DEFAULT_LIMIT
  if (Number.isInteger(input) === false || input < 1 || input > FILES_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${FILES_MAX_LIMIT}`)
  }
  return input
}

/** Accept an ISO date or a millisecond timestamp; return epoch ms. */
function parseSince(input) {
  if (input === undefined || input === null || input === '') return null
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string') {
    const numeric = Number(input)
    if (Number.isFinite(numeric) && numeric > 0 && /^\d+$/.test(input.trim())) return numeric
    const parsed = Date.parse(input)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new Error(`since must be an ISO date or milliseconds, e.g. "2026-11-28T08:00:00Z"`)
}

/** Short human size for the render. */
function filesSizeText(bytes) {
  const value = Number.isFinite(bytes) ? bytes : 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** `YYYY-MM-DD HH:MM` in local time for the render. */
function filesDateText(iso) {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return String(iso ?? '')
  const pad = (value) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * TICKET-058: list the files this session wrote into the workspace.
 *
 * The timeline (TICKET-056) remembers actions for one host process; screenshots
 * and downloads outlive that process, so the honest index is the disk itself.
 * This tool reads `screenshots/` and the configured downloads directory each
 * call — no cache, no bridge, no page. That is why it also answers while the
 * panel is closed or after DSH restarted.
 * @param {import('cordis').Context} ctx - host context, for `workingDirectory`.
 * @param {{ downloadDir?: string }} [options] - configured downloads directory name.
 */
export function browserFilesTool(ctx, options = {}) {
  const downloadDir = typeof options.downloadDir === 'string' && options.downloadDir !== ''
    ? options.downloadDir
    : 'downloads'
  return {
    name: 'browser_files',
    description:
      'List the files this browser work has written into the workspace: screenshots (`<workspace>/screenshots/`) and '
      + 'downloads (`<workspace>/${downloadDir}/`), newest first, with sizes and timestamps. Pure read: it never touches '
      + 'the page, works while the panel is closed and survives DSH restarts (it lists the disk, not a memory index). '
      + 'Filter with kind, match (path substring) or since; `total` says how many matched before the limit. '
      + 'Use it to find a screenshot you took earlier or to summarise which attachments were downloaded.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['all', 'screenshot', 'download'],
          description: 'Which files to list. Default "all".',
        },
        since: {
          type: 'string',
          description: 'Only files modified at or after this moment: an ISO date ("2026-11-28T08:00:00Z") or milliseconds as digits.',
        },
        match: {
          type: 'string',
          description: 'Only paths containing this substring (case-insensitive), e.g. "report" or "screenshots/".',
        },
        limit: {
          type: 'integer',
          description: `How many entries to return, 1–${FILES_MAX_LIMIT} (default ${FILES_DEFAULT_LIMIT}). total still reports every match.`,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          dirs: { type: 'array', items: { type: 'string' } },
          total: { type: 'integer' },
          screenshots: { type: 'integer' },
          downloads: { type: 'integer' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['screenshot', 'download'] },
                name: { type: 'string' },
                path: { type: 'string' },
                bytes: { type: 'integer' },
                at: { type: 'string' },
              },
              required: ['kind', 'name', 'path', 'bytes', 'at'],
            },
          },
        },
        required: ['total', 'files'],
      },
      render(_args, value) {
        const files = Array.isArray(value?.files) ? value.files : []
        const dirs = Array.isArray(value?.dirs) && value.dirs.length > 0 ? value.dirs.join(' / ') : 'screenshots/ or downloads/'
        if (files.length === 0) {
          return [{
            type: 'text',
            text: `No files under ${dirs} yet (nothing matched the filter). browser_screenshot writes screenshots/, browser_download writes downloads/.`,
          }]
        }
        const lines = files.map((file) => `* [${file.kind}] ${file.path} — ${filesSizeText(file.bytes)} · ${filesDateText(file.at)}`)
        const shown = files.length
        const total = Number.isInteger(value?.total) ? value.total : shown
        const older = total > shown ? `\n… ${total - shown} older file(s) not shown; raise limit (up to ${FILES_MAX_LIMIT}).` : ''
        const parts = []
        if (Number.isInteger(value?.screenshots)) parts.push(`${value.screenshots} screenshot(s)`)
        if (Number.isInteger(value?.downloads)) parts.push(`${value.downloads} download(s)`)
        const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : ''
        return [{ type: 'text', text: `${total} file(s) in the workspace, newest first${breakdown}.\n${lines.join('\n')}${older}` }]
      },
    },
    async execute(args, exec) {
      const kind = args?.kind === 'screenshot' || args?.kind === 'download' ? args.kind : 'all'
      const limit = filesLimit(args?.limit)
      const since = parseSince(args?.since)
      const match = typeof args?.match === 'string' ? args.match.trim().toLowerCase() : ''
      const root = await workspaceOf(ctx, exec)
      const dirs = []
      if (kind !== 'download') dirs.push({ kind: 'screenshot', dir: join(root, 'screenshots') })
      if (kind !== 'screenshot') dirs.push({ kind: 'download', dir: join(root, downloadDir) })
      const found = []
      for (const bucket of dirs) {
        let entries = []
        try {
          entries = await readdir(bucket.dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (entry.isFile() !== true) continue
          const absolute = join(bucket.dir, entry.name)
          let info
          try {
            info = await stat(absolute)
          } catch {
            continue
          }
          if (since !== null && info.mtimeMs < since) continue
          const path = relativeFrom(root, absolute)
          if (match !== '' && path.toLowerCase().includes(match) === false) continue
          found.push({
            kind: bucket.kind,
            name: entry.name,
            path,
            bytes: info.size,
            at: new Date(info.mtimeMs).toISOString(),
            mtime: info.mtimeMs,
          })
        }
      }
      found.sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path))
      const files = found.slice(0, limit).map(({ mtime, ...rest }) => rest)
      return {
        kind,
        dirs: dirs.map((bucket) => relativeFrom(root, bucket.dir)),
        total: found.length,
        screenshots: found.filter((file) => file.kind === 'screenshot').length,
        downloads: found.filter((file) => file.kind === 'download').length,
        files,
      }
    },
    /** Read-only disk listing: two of these cannot race each other. */
    isConcurrencySafe() {
      return true
    },
    presentCall(args) {
      const scope = args?.kind === 'screenshot' ? 'screenshots' : (args?.kind === 'download' ? 'downloads' : 'workspace files')
      return { card: 'generic', title: `List ${scope}`, kind: 'read', rawInput: args }
    },
    presentResult(_args, value) {
      const count = Number.isInteger(value?.total) ? value.total : 0
      return { card: 'generic', title: `${count} file(s) in the workspace` }
    },
  }
}

/**
 * Wrap the bridge so every command carries the current display policy, and a
 * write waits for the human the first time it touches a site.
 *
 * `activation` and `fitWidth` are volatile fields: their readers return the live
 * value, and a config-editor change must take effect on the next command without
 * re-registering the tools. The approval mode is read the same way, for a
 * sharper reason: it is a permission decision, and capturing it at build time
 * would let a settings change be silently ignored.
 *
 * Reads never ask (SPEC-003 C1): the user can watch the page change, and a read
 * cannot destroy anything. A click is classified from the page's own answer
 * about its target, so a plain link stays free and a submit asks.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 * @param {{ activation?: unknown, fitWidth?: unknown, approvals?: unknown }} [policy] - volatile readers.
 * @returns {{ request: Function, takeDigest: Function, requestApproval: Function }} the gated bridge.
 */
export function createGate(bridge, policy = {}) {
  const grants = createGrantBook()
  // `mode` is volatile (the schema wraps it in a reader), so it is unwrapped
  // here rather than in the pure approvals module: one place knows about readers.
  const settingsOf = () => {
    const raw = readField(policy?.approvals, undefined)
    if (raw === null || typeof raw !== 'object') return normalizeApprovals(undefined)
    return normalizeApprovals({
      mode: readField(raw.mode, undefined),
      timeoutMs: raw.timeoutMs,
      sensitiveSites: raw.sensitiveSites,
    })
  }
  const pageUrlOf = (sessionId) => {
    try {
      const page = typeof bridge.pageOf === 'function' ? bridge.pageOf(sessionId) : null
      return page !== null && typeof page === 'object' && typeof page.url === 'string' ? page.url : ''
    } catch (error) {
      return ''
    }
  }
  // Approval exists only when the host can actually ask: no transport (an older
  // profile, or a bare test bridge) keeps the 1.4.x behaviour of just acting.
  const canAsk = () => typeof bridge.approve === 'function' && typeof bridge.hasClient === 'function'
  const send = (sessionId, type, params, timeoutMs) => {
    // `exec.signal` reaches the tools through async context (see `createTools`),
    // so every tool call can be aborted without threading the signal through
    // eleven signatures — and a call that was aborted before it started never
    // touches the page at all.
    const signal = execSignals.getStore()?.signal
    if (signal?.aborted === true) {
      throw new AgentBrowserError(
        'cancelled',
        'the caller stopped this call before it reached the browser panel, so nothing was sent to the page.',
      )
    }
    const activation = readField(policy?.activation, DEFAULT_ACTIVATION)
    const fit = readField(policy?.fitWidth, true) === false ? 'none' : 'width'
    const options = { show: activationPolicy(activation).show(), fit }
    if (signal !== undefined) options.signal = signal
    return bridge.request(sessionId, type, params, timeoutMs, options)
  }
  /**
   * Ask the page what an address points at — classification only.
   *
   * A failure here is not a failed action: the target is then unknown, and an
   * unknown target is treated as a submit. Cancellation and a lost panel are the
   * exception, because they mean the action itself cannot happen and a prompt
   * would ask the user about nothing.
   */
  const inspect = async (sessionId, params) => {
    try {
      const seen = await send(sessionId, 'inspect', { ...params, source: actionSource() }, 8_000)
      if (seen === null || typeof seen !== 'object' || seen.ok === false) {
        return {
          known: false,
          isSubmit: false,
          acceptsFiles: false,
          acceptsMultiple: false,
          target: null,
          url: '',
          addressError: typeof seen?.error === 'string' ? seen.error : '',
        }
      }
      const target = seen.info !== null && typeof seen.info === 'object' ? seen.info : null
      return {
        known: true,
        isSubmit: seen.isSubmit === true,
        acceptsFiles: seen.acceptsFiles === true,
        acceptsMultiple: seen.acceptsMultiple === true,
        target,
        url: typeof seen.url === 'string' ? seen.url : '',
        addressError: '',
      }
    } catch (error) {
      if (isAgentBrowserError(error) === true
        && (error.code === 'cancelled' || error.code === 'bridge_closed'
          || error.code === 'panel_taken_over' || error.code === 'needs_human')) {
        throw error
      }
      return { known: false, isSubmit: false, target: null, url: '' }
    }
  }
  /**
   * Ask the human, once, whether this write may happen.
   *
   * `bridge.approve` carries the panel's `approval_*` failures unchanged: the
   * tool layer turns them into "nothing was sent to the page", and that honesty
   * is the product. A closed panel fails closed instead of guessing consent.
   */
  const confirmWrite = async (sessionId, request) => {
    const settings = settingsOf()
    if (settings.mode === 'off') return
    if (canAsk() === false) return
    const origin = typeof request?.origin === 'string' && request.origin !== ''
      ? request.origin
      : originOf(request?.url !== undefined ? request.url : pageUrlOf(sessionId))
    const actionClass = request?.actionClass
    if (shouldConfirm({
      mode: settings.mode,
      actionClass,
      origin,
      sensitiveSites: settings.sensitiveSites,
      grants,
      sessionId,
    }) === false) return
    if (bridge.hasClient() === false) {
      throw new AgentBrowserError(
        'approval_required',
        '面板不在，没法向用户确认。The panel is not attached right now, so the user cannot be asked; '
        + 'open the right sidebar browser tab for this session and retry. Nothing was sent to the page.',
      )
    }
    const target = request?.target ?? null
    const summary = summarize(actionClass, origin, target)
    const answer = await bridge.approve(sessionId, {
      origin,
      actionClass,
      summary,
      ...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
    })
    if (answer !== null && typeof answer === 'object' && answer.decision === 'site') {
      grants.grant(sessionId, origin)
    }
  }
  /**
   * The write class of one tool call, and the target that decides it.
   *
   * Only two tools need the page to answer first: a click's class depends on
   * whether its element submits a form, and an Enter press depends on whether
   * the focused control is inside one. Everything else is known from the call.
   */
  const confirmBefore = async (sessionId, type, params) => {
    // Nothing to ask when the feature is off or no panel can answer. Returning
    // here also keeps the pre-016 shape of a bare test bridge: one command per
    // tool call, no classification round trip.
    if (settingsOf().mode === 'off' || canAsk() === false) return
    // `upload` confirms itself: the tool inspects the file input first and asks
    // before it reads any bytes, then sends the files. Asking here as well would
    // show the same prompt twice for one command.
    if (type === 'upload') return
    if (type === 'click') {
      // A coordinate click names no element; it is treated as a read (C2), and
      // the user can see the pointer land in the panel.
      if (params?.x !== undefined || params?.y !== undefined) return
      const address = typeof params?.loc === 'string' && params.loc !== ''
        ? { loc: params.loc }
        : typeof params?.ref === 'string' && params.ref !== ''
          ? { ref: params.ref }
          : { selector: params?.selector, strict: params?.strict }
      const seen = await inspect(sessionId, address)
      // If the address itself cannot be resolved (`stale_loc` / `bad_loc` /
      // `stale_ref` / `bad_ref`), the same page-side resolution will fail for
      // the real action too: there is nothing to confirm and nothing to send,
      // so let the action report its own precise error instead of asking the
      // user about an action that can never happen.
      if (seen.addressError !== '') return
      await confirmWrite(sessionId, {
        actionClass: clickClass(seen.known === false ? null : { isSubmit: seen.isSubmit }),
        origin: originOf(seen.url),
        url: seen.url,
        target: seen.target,
      })
      return
    }
    if (type === 'drag') {
      // A drag is a write the page cannot classify for us: inspection sees one
      // ordinary element, whether the page will reorder a list, commit a kanban
      // card or only move a slider is decided later, in script. So the class is
      // always `drag` and the first touch per site asks.
      const where = typeof params?.loc === 'string' && params.loc !== ''
        ? { loc: params.loc }
        : typeof params?.ref === 'string' && params.ref !== ''
          ? { ref: params.ref }
          : { selector: params?.selector, strict: params?.strict }
      const seen = await inspect(sessionId, where)
      // Unresolvable source: the real action fails with the same precise error,
      // so asking first would only delay a guaranteed failure.
      if (seen.addressError !== '') return
      await confirmWrite(sessionId, {
        actionClass: 'drag',
        origin: originOf(seen.url),
        url: seen.url,
        target: seen.target,
      })
      return
    }
    if (type === 'type') {
      // A password box is hard-refused by the page itself (SPEC-003 C2), so
      // asking the user about it would promise something that can never happen.
      // Inspect first: one extra round trip only on the first write per site,
      // and the page's own refusal still produces the error the model sees.
      const where = typeof params?.loc === 'string' && params.loc !== '' ? { loc: params.loc } : { ref: params?.ref }
      const seen = await inspect(sessionId, where)
      // Unresolvable address: the page will refuse this exact command anyway;
      // asking the user would only delay a guaranteed failure (same rule as click).
      if (seen.addressError !== '') return
      if (seen.known === true && seen.target?.role === 'password') return
      await confirmWrite(sessionId, {
        actionClass: 'type',
        origin: originOf(seen.url),
        url: seen.url,
        target: seen.target,
      })
      return
    }
    if (type === 'fill') {
      // A batch is one form action: the prompt covers every field and names the
      // first one (the rest are listed by the tool's own result). The first
      // address answers the same questions `type` asks — is it resolvable, is it
      // a password box — and a batch that cannot be resolved fails on its own
      // precise error instead of asking about a guaranteed failure.
      const first = Array.isArray(params?.fields) && params.fields.length > 0 ? params.fields[0] : null
      if (first === null || typeof first !== 'object') return
      const where = typeof first.loc === 'string' && first.loc !== ''
        ? { loc: first.loc }
        : typeof first.ref === 'string' && first.ref !== ''
          ? { ref: first.ref }
          : { selector: first.selector, strict: params?.strict }
      const seen = await inspect(sessionId, where)
      if (seen.addressError !== '') return
      if (seen.known === true && seen.target?.role === 'password') return
      await confirmWrite(sessionId, {
        // Submitting is classified as `submit`; a fill that only writes stays a
        // `type` grant, so filling the same form twice asks once, like typing.
        actionClass: params?.submit !== undefined && params?.submit !== false ? 'submit' : 'type',
        origin: originOf(seen.url),
        url: seen.url,
        target: seen.target,
      })
      return
    }
    if (type === 'eval') {
      // The page is the only reliable witness of its own address. The panel's
      // `/page` telemetry is advisory and may not have landed yet; asking the
      // page costs one round trip and keeps the prompt naming the real site
      // (and keeps `sensitiveSites` honest) instead of saying "当前页面".
      const seen = await inspect(sessionId, {})
      await confirmWrite(sessionId, { actionClass: 'eval', origin: originOf(seen.url), url: seen.url })
      return
    }
    if (type === 'press') {
      if (SUBMIT_KEYS.includes(String(params?.key ?? '')) === false) return
      const seen = await inspect(sessionId, {})
      await confirmWrite(sessionId, {
        actionClass: pressClass(params?.key, seen.known === false ? null : { isSubmit: seen.isSubmit }),
        origin: originOf(seen.url),
        url: seen.url,
        target: seen.target,
      })
    }
  }
  return {
    request: async (sessionId, type, params, timeoutMs) => {
      await confirmBefore(sessionId, type, params)
      return send(sessionId, type, params, timeoutMs)
    },
    takeDigest: (sessionId) => bridge.takeDigest(sessionId),
    // `browser_upload` has to know what it is pointing at *before* it reads a
    // single byte (a stale locator or a non-file target must fail without a
    // prompt), so it gets the classification round trip directly.
    inspect: (sessionId, params) => inspect(sessionId, params),
    // `browser_download` never calls the bridge (the host fetches the file
    // itself), so it gets the permission check directly instead of via `request`.
    requestApproval: (sessionId, request) => confirmWrite(sessionId, request),
  }
}

/**
 * Every tool this plugin contributes, in model-facing order.
 *
 * The bridge handed to the tools is a thin gate over the real one: it stamps
 * the configured activation onto each command, so no tool has to know which
 * mode is in force (and `browser_download`, which never calls the bridge, is
 * unaffected by any of them).
 * @param {import('cordis').Context} ctx - plugin context.
 * @param {import('./bridge.js').Bridge} bridge - host half of the channel.
 * @param {import('./static.js').StaticSites} sites - workspace server.
 * @param {{
 *   activation?: unknown,
 *   fitWidth?: unknown,
 *   approvals?: unknown,
 *   evalEnabled?: unknown,
 *   sessions?: { allowlist?: unknown },
 *   limits?: { navigationTimeoutMs?: number, snapshotMaxChars?: number, evalMaxChars?: number },
 *   downloads?: { dir?: string, maxBytes?: number, extraBlockedExtensions?: unknown },
 *   searchFallback?: { enabled?: unknown, maxResults?: number },
 *   rules?: ReturnType<typeof createPolicy>,
 * }} [policy] - config values; volatile fields may be readers. `rules` is the
 *   shared policy object built by `apply.js` (so the host guard and the tool
 *   bodies enforce the same decisions); when absent one is built here.
 * @returns {Array<object>} the tool definitions.
 */
export function createTools(ctx, bridge, sites, policy = {}) {
  const gate = createGate(bridge, policy)
  // TICKET-056: the recorder is created with the tools so a single call can see
  // every action (they share this array), and `apply.js` can hand the same object
  // to the bridge for the panel strip.
  const timeline = createTimeline()
  const limits = policy?.limits ?? {}
  const downloads = policy?.downloads ?? {}
  const rules = policy?.rules ?? createPolicy({
    evalEnabled: policy?.evalEnabled,
    sessions: policy?.sessions,
    downloads: policy?.downloads,
  })
  // Constructed once, like the tools themselves: the enabled flag is a volatile
  // reader, so the decision is still taken per failed open (TICKET-027).
  const fallback = createSearchFallback({
    config: policy?.searchFallback,
    getWeb: () => {
      try {
        return ctx?.get?.('web') ?? null
      } catch {
        return null
      }
    },
    log: (message) => {
      try {
        ctx?.logger?.debug?.(`[agent-browser] ${message}`)
      } catch {
        // Logging must never turn a failed open into a second failure.
      }
    },
  })
  const tools = [
    browserOpenTool(ctx, gate, sites, {
      navigationTimeoutMs: limits.navigationTimeoutMs,
      rules,
      fallback,
    }),
    browserSnapshotTool(ctx, gate, { maxChars: limits.snapshotMaxChars, rules }),
    browserReadTool(gate),
    browserPickTool(gate),
    browserTabsTool(gate),
    browserWaitTool(gate),
    browserClickTool(gate),
    browserDragTool(gate),
    browserFillTool(gate),
    browserScrollTool(gate),
    browserHoverTool(gate),
    browserZoomTool(gate),
    browserScreenshotTool(ctx, gate),
    browserTypeTool(gate),
    browserPressTool(gate),
    browserUploadTool(ctx, gate),
    browserEvalTool(gate, { maxChars: limits.evalMaxChars, rules }),
    browserDownloadTool(ctx, gate, { dir: downloads.dir, maxBytes: downloads.maxBytes, rules }),
    browserTimelineTool(timeline),
    browserFilesTool(ctx, { downloadDir: downloads.dir }),
  ]
  // `exec.signal` is per call and the gate is shared, so the signal is carried in
  // async context instead of every tool parameter list. One wrapper here covers
  // all nineteen tools, which is also why no call site can forget it.
  const wrapped = tools.map((tool) => {
    const execute = tool.execute
    if (typeof execute !== 'function') return tool
    return {
      ...tool,
      execute: (args, exec) => execSignals.run({ signal: exec?.signal }, () => execute(args, exec)),
    }
  })
  // Every write tool gets `effect` on both paths (SPEC-004 B4, TICKET-042):
  // success results stamp `committed` themselves; anything thrown before the
  // command left the host is `none`; `action_unknown` already carries `unknown`.
  const writes = new Set(['browser_click', 'browser_drag', 'browser_type', 'browser_press', 'browser_upload', 'browser_eval', 'browser_download'])
  const typed = wrapped.map((tool) => {
    if (writes.has(tool.name) === false) return tool
    const execute = tool.execute
    return {
      ...tool,
      async execute(args, exec) {
        try {
          return await execute(args, exec)
        } catch (error) {
          throw notSent(error)
        }
      },
    }
  })
  // TICKET-056: one recorder pass over the final execute of every tool. It runs
  // after `notSent` so the entry shows the code the model actually received, and
  // it never changes the result (or swallows the error): the timeline is an
  // observer, not a middleware decision.
  const recorded = typed.map((tool) => {
    const execute = tool.execute
    if (typeof execute !== 'function') return tool
    return {
      ...tool,
      async execute(args, exec) {
        // Reading the log must not append to it, or every look would grow the
        // buffer by one and the "how many actions happened" answer would drift.
        const silent = tool.name === 'browser_timeline'
        const startedAt = Date.now()
        let session = ''
        try {
          session = sessionOf(exec)
        } catch {
          session = ''
        }
        const summary = summarizeArgs(args)
        try {
          const value = await execute(args, exec)
          if (!silent) {
            timeline.record({
              tool: tool.name,
              session,
              ok: true,
              effect: typeof value?.effect === 'string' && value.effect !== '' ? value.effect : null,
              code: null,
              summary,
              url: typeof value?.url === 'string' && value.url !== '' ? value.url : null,
              file: typeof value?.path === 'string' && value.path !== ''
                ? value.path
                : (typeof value?.file === 'string' && value.file !== '' ? value.file : null),
              bytes: Number.isInteger(value?.bytes) ? value.bytes : null,
              ms: Date.now() - startedAt,
            })
          }
          return value
        } catch (error) {
          if (!silent) {
            timeline.record({
              tool: tool.name,
              session,
              ok: false,
              effect: typeof error?.details?.effect === 'string' ? error.details.effect : null,
              code: typeof error?.code === 'string' && error.code !== '' ? error.code : 'error',
              summary,
              url: null,
              file: null,
              bytes: null,
              ms: Date.now() - startedAt,
            })
          }
          throw error
        }
      },
    }
  })
  recorded.timeline = timeline
  return recorded
}
