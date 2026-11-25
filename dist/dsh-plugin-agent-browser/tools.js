/**
 * The tools the agent sees.
 *
 * Every tool here is a thin shell: validate, ask the panel to do it, return
 * what the panel says. All browser state lives in the panel (it owns the
 * `<webview>`), so nothing in this file caches a page.
 */
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, join } from 'node:path'
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
        opened = await bridge.request(sessionId, 'open', { url, detect: detectSource() }, navigationTimeoutMs)
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
          nodes: { type: 'integer' },
          visited: { type: 'integer' },
          ms: { type: 'integer' },
          needs_human: { type: 'boolean' },
          hint: { type: 'string' },
          signals: { type: 'array', items: { type: 'string' } },
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
        const header = `Snapshot gen ${value?.gen ?? 0} · ${counts}`
        const footer = value?.truncated === true ? '\n… tree cut at the character budget; scroll or narrow the query and snapshot again.' : ''
        const warned = value?.needs_human === true
          ? `\n\nneeds_human: true — ${value?.hint ?? 'this page is asking for a human.'}`
          : ''
        const blocks = [{ type: 'text', text: `${header}\n${value?.text ?? ''}${footer}${warned}${digestLine(String(value?.digest ?? ''))}` }]
        if (value?.image) blocks.push({ type: 'image', attachment: value.image })
        return blocks
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const maxChars = Number.isFinite(args?.maxChars) ? rules.clampChars(args.maxChars, MAX_CHARS, MIN_CHARS) : defaultMaxChars
      const includeImage = args?.includeImage !== false
      const result = await bridge.request(
        sessionId,
        'snapshot',
        { source: snapshotSource(), detect: detectSource(), maxChars, includeImage },
        30_000,
      )
      const value = {
        url: typeof result?.url === 'string' ? result.url : '',
        title: typeof result?.title === 'string' ? result.title : '',
        gen: Number.isInteger(result?.gen) ? result.gen : 0,
        text: typeof result?.text === 'string' ? result.text : '',
        refCount: Number.isInteger(result?.refCount) ? result.refCount : 0,
        truncated: result?.truncated === true,
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
  const ref = typeof result?.ref === 'string' ? result.ref : ''
  switch (result?.error) {
    case 'stale_ref':
      return new Error(`ref "${ref}" is no longer in the page; it was replaced or removed. ${REF_HELP}`)
    case 'bad_ref':
      return new Error(`"${ref}" is not a ref. Use a ref from the latest browser_snapshot, e.g. e12 or f1e3.`)
    case 'out_of_view':
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
        `${mode === 'hover' ? 'nothing to hover' : 'nothing to click'}: ${result?.selector ? `selector ${JSON.stringify(result.selector)}` : 'the target'} `
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
      return new Error(
        `${what} is covered by ${cover}, `
        + 'so a click would land on that instead. Dismiss the overlay (or click the covering element), then retry. '
        + 'Nothing was clicked.',
      )
    }
    case 'disabled':
      return new Error(
        `that control is disabled${typeof result?.info?.name === 'string' && result.info.name !== '' ? ` ("${result.info.name}")` : ''}, `
        + 'so clicking it would do nothing. Look for another control, or wait until the page enables it.',
      )
    case 'bad_selector':
      return new Error(
        `"${String(result?.selector ?? '')}" is not a usable CSS selector: ${String(result?.message ?? 'the page could not parse it')}`,
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
  },
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
      'Click something in the browser panel. Prefer a ref from the latest browser_snapshot; pass `selector` (CSS) '
      + 'when the element has no usable ref — a canvas-adjacent widget, a card stack, an icon-only pager; pass x/y '
      + '(CSS pixels inside the panel, origin top-left) only for canvas widgets and cross-origin frames. '
      + 'A selector click fails as not_found / multiple / occluded / disabled instead of clicking the wrong thing. '
      + 'Links that wanted a new window are followed in the same view. One click per call; snapshot again afterwards.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the latest browser_snapshot, e.g. e5 or f1e2.' },
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
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const hasPoint = Number.isFinite(args?.x) && Number.isFinite(args?.y)
      const selector = typeof args?.selector === 'string' && args.selector.trim() !== '' ? args.selector.trim() : ''
      if (!hasPoint && selector === '') requireRef(args?.ref)
      if (hasPoint && selector !== '') {
        throw new Error('pass either selector or x/y, not both: a selector is resolved to a point for you.')
      }
      const result = await bridge.request(
        sessionId,
        'click',
        {
          ref: selector === '' && !hasPoint ? requireRef(args?.ref) : undefined,
          selector: selector === '' ? undefined : selector,
          strict: typeof args?.strict === 'boolean' ? args.strict : undefined,
          x: args?.x,
          y: args?.y,
          source: actionSource(),
        },
        20_000,
      )
      if (result?.ok !== true) throw actionFailure(result)
      return {
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
      }
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      const what = args?.selector ?? args?.ref ?? `${args?.x},${args?.y}`
      return { card: 'generic', title: `Click ${what}`, kind: 'edit', rawInput: args }
    },
    presentResult() {
      return { card: 'generic', title: 'Clicked' }
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
      + 'the latest browser_snapshot, a CSS selector, or x/y. Returns where the pointer rests and grew:true when the '
      + 'page reacted (a control expanded) — snapshot again, then click.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the latest browser_snapshot, e.g. e5 or f1e2.' },
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
      if (!hasPoint && selector === '') requireRef(args?.ref)
      if (hasPoint && selector !== '') {
        throw new Error('pass either selector or x/y, not both: a selector is resolved to a point for you.')
      }
      const waitMs = Number.isFinite(args?.waitMs) ? Math.min(2000, Math.max(0, Math.round(args.waitMs))) : undefined
      const result = await bridge.request(
        sessionId,
        'hover',
        {
          ref: selector === '' && !hasPoint ? requireRef(args?.ref) : undefined,
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
      const what = args?.selector ?? args?.ref ?? `${args?.x},${args?.y}`
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
      'Scroll the page in the browser panel. Pass dy (CSS pixels, default 600) to move down or up, or to:"top"/'
      + '"bottom" to jump to an end. Pass container (CSS selector) to scroll one scrollable box instead of the page. '
      + 'Returns the resulting position plus atBottom (true when the page can go no further). Use it to trigger lazy '
      + 'loading before snapshotting again.',
    parameters: {
      type: 'object',
      properties: {
        dy: { type: 'integer', description: 'Pixels to move: positive goes down, negative goes up. Ignored when `to` is given. Defaults to 600.' },
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
          x: { type: 'integer' },
          y: { type: 'integer' },
          scrollHeight: { type: 'integer' },
          viewportHeight: { type: 'integer' },
          atBottom: { type: 'boolean' },
          blockedNewWindow: { type: 'string' },
        },
        required: ['y', 'atBottom'],
      },
      render(_args, value) {
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
      const dy = args?.dy === undefined ? undefined : Number(args.dy)
      if (dy !== undefined && !Number.isFinite(dy)) throw new Error('dy must be an integer number of pixels')
      const container = typeof args?.container === 'string' && args.container.trim() !== '' ? args.container.trim() : undefined
      const waitMs = Number.isFinite(args?.waitMs) ? args.waitMs : undefined
      const result = await bridge.request(
        sessionId,
        'scroll',
        { dy: dy === undefined ? undefined : Math.round(dy), to: to ?? undefined, container, waitMs, source: actionSource() },
        20_000,
      )
      if (result?.ok !== true) throw actionFailure(result, 'scroll')
      return {
        x: Math.round(result.x ?? 0),
        y: Math.round(result.y ?? 0),
        scrollHeight: Math.round(result.scrollHeight ?? 0),
        viewportHeight: Math.round(result.viewportHeight ?? 0),
        atBottom: result.atBottom === true,
        ...(Array.isArray(result.blockedNewWindow) && result.blockedNewWindow.length > 0
          ? { blockedNewWindow: result.blockedNewWindow.map((url) => String(url)).join(' ') }
          : {}),
      }
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      const what = args?.to ? `to ${args.to}` : `${args?.dy ?? 600}px`
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
      'Type text into a field identified by a ref from the latest browser_snapshot. Clears the field first by '
      + 'default; pass submit:true to press Enter afterwards. Password fields are refused — ask the user to type '
      + 'those in the panel instead.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the latest browser_snapshot, e.g. e3.' },
        text: { type: 'string', description: 'The text to put in the field.' },
        clear: { type: 'boolean', description: 'Replace the current value. Defaults to true; false appends.' },
        submit: { type: 'boolean', description: 'Press Enter after typing. Defaults to false.' },
      },
      required: ['ref', 'text'],
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
        return [{ type: 'text', text: `Typed ${value?.length ?? 0} characters into ${target}${tail}.` }]
      },
    },
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const ref = requireRef(args?.ref)
      if (typeof args?.text !== 'string') throw new Error('text is required')
      const result = await bridge.request(
        sessionId,
        'type',
        { ref, text: args.text, clear: args?.clear !== false, submit: args?.submit === true, source: actionSource() },
        20_000,
      )
      if (result?.ok !== true) throw actionFailure({ ...result, ref })
      return { ...(result.info ?? {}), length: result.length ?? 0, submitted: result.submitted === true }
    },
    isConcurrencySafe() {
      return false
    },
    presentCall(args) {
      return { card: 'generic', title: `Type into ${args?.ref ?? 'field'}`, kind: 'edit', rawInput: args }
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
        },
        required: ['key'],
      },
      render(_args, value) {
        if (typeof value?.handled === 'string' && value.handled !== '') {
          return [{ type: 'text', text: `Pressed ${value.key} — the panel performed "${value.handled}": ${value.from} → ${value.to}` }]
        }
        const mods = Array.isArray(value?.modifiers) && value.modifiers.length > 0 ? `${value.modifiers.join('+')}+` : ''
        return [{ type: 'text', text: `Pressed ${mods}${value?.keyCode ?? value?.key ?? ''}.` }]
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
      return value
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
        },
        required: ['result'],
      },
      render(_args, value) {
        const notes = []
        if (value?.truncated === true) notes.push('result cut at the character budget')
        if (value?.pending === true) notes.push('the script returned a promise that was not awaited')
        const tail = notes.length > 0 ? `\n(${notes.join('; ')})` : ''
        return [{ type: 'text', text: `${value?.result ?? ''}${tail}` }]
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
      if (result?.ok !== true) throw new Error(`the script threw: ${String(result?.error ?? 'unknown error')}`)
      return {
        result: String(result.serialized ?? ''),
        truncated: result.truncated === true,
        pending: result.pending === true,
      }
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
        return await downloadTo(root, {
          url: args.url.trim(),
          dir,
          ...(maxBytes === undefined ? {} : { maxBytes }),
          ...(typeof args?.filename === 'string' && args.filename.trim() !== '' ? { filename: args.filename.trim() } : {}),
          ...(typeof args?.referer === 'string' && args.referer.trim() !== '' ? { referer: args.referer.trim() } : {}),
          // The policy sees the final name and byte count, which is the only
          // point where the extension blacklist and size ceiling are truthful.
          checkTarget: ({ filename, bytes }) => rules.checkDownload(filename, bytes),
        })
      } catch (error) {
        if (error instanceof DownloadError) {
          const where = error.url ?? error.finalUrl
          const failed = { code: 'download_rejected', stage: error.stage, reason: error.message }
          if (typeof where === 'string') failed.url = where
          return { download_failed: failed }
        }
        if (error instanceof AgentBrowserError && error.code === 'download_rejected') {
          return { download_failed: { code: 'download_rejected', stage: 'policy', reason: error.message } }
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
        return { known: false, isSubmit: false, target: null, url: '' }
      }
      const target = seen.info !== null && typeof seen.info === 'object' ? seen.info : null
      return {
        known: true,
        isSubmit: seen.isSubmit === true,
        target,
        url: typeof seen.url === 'string' ? seen.url : '',
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
    if (type === 'click') {
      // A coordinate click names no element; it is treated as a read (C2), and
      // the user can see the pointer land in the panel.
      if (params?.x !== undefined || params?.y !== undefined) return
      const address = typeof params?.ref === 'string' && params.ref !== ''
        ? { ref: params.ref }
        : { selector: params?.selector, strict: params?.strict }
      const seen = await inspect(sessionId, address)
      await confirmWrite(sessionId, {
        actionClass: clickClass(seen.known === false ? null : { isSubmit: seen.isSubmit }),
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
      const seen = await inspect(sessionId, { ref: params?.ref })
      if (seen.known === true && seen.target?.role === 'password') return
      await confirmWrite(sessionId, {
        actionClass: 'type',
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
    browserClickTool(gate),
    browserScrollTool(gate),
    browserHoverTool(gate),
    browserZoomTool(gate),
    browserScreenshotTool(ctx, gate),
    browserTypeTool(gate),
    browserPressTool(gate),
    browserEvalTool(gate, { maxChars: limits.evalMaxChars, rules }),
    browserDownloadTool(ctx, gate, { dir: downloads.dir, maxBytes: downloads.maxBytes, rules }),
  ]
  // `exec.signal` is per call and the gate is shared, so the signal is carried in
  // async context instead of every tool parameter list. One wrapper here covers
  // all eleven tools, which is also why no call site can forget it.
  return tools.map((tool) => {
    const execute = tool.execute
    if (typeof execute !== 'function') return tool
    return {
      ...tool,
      execute: (args, exec) => execSignals.run({ signal: exec?.signal }, () => execute(args, exec)),
    }
  })
}
