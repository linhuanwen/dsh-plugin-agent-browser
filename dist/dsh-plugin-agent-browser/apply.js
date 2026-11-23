/**
 * The host half's lifecycle, kept out of `index.js`.
 *
 * Two reasons for the split. First, unit-testable: `index.js` has to import
 * `@deepseek-ai/schemastery`, which only resolves inside the DSH host, so a test
 * that touches it cannot run under plain `node`. Second, TICKET-017 asks for one
 * `ctx.effect` with a defined teardown order — that is easier to see, and to
 * test, when the wiring is a plain function over injected collaborators.
 *
 * Teardown order matters: the tools go first (a tool call must not reach a
 * closed bridge), then the bridge (queued commands fail with `bridge_closed:`),
 * then the static servers. Each step is attempted even if an earlier one throws;
 * the collected failures surface as one `AggregateError`.
 */
import { DEFAULT_ACTIVATION } from './activation.js'
import { BRIDGE_MARK, BRIDGE_PREFIX, Bridge } from './bridge.js'
import { normalizeConfig, readField } from './config.js'
import { ERROR_CODES, HARNESS_ERROR_BASE } from './errors.js'
import { createPolicy } from './policy.js'
import { StaticSites } from './static.js'
import { createTools, guardsSource, snapshotSource } from './tools.js'

/** Bumped whenever the host half changes, so a reload can be told apart from a cache. */
export const HOST_REV = 32

/**
 * Tool names the host already has registered, from this plugin's point of view.
 *
 * Two browser plugins installed in one profile claim the same `browser_*` names,
 * and the host rejects the second registration with a bare "already registered"
 * error. That used to abort the whole `ctx.effect`, so the plugin looked active
 * (fiberPhase `active`) while none of its tools existed. Detection is best
 * effort: `definitions()` is the cheap path, `get()` per name is the fallback.
 * @param {import('cordis').Context} ctx - plugin context.
 * @param {string[]} names - names this plugin is about to register.
 * @returns {Set<string>} names already owned by someone else.
 */
function takenToolNames(ctx, names) {
  const taken = new Set()
  try {
    const definitions = ctx?.tools?.definitions?.()
    if (Array.isArray(definitions)) {
      for (const definition of definitions) {
        if (typeof definition?.name === 'string') taken.add(definition.name)
      }
    }
  } catch {
    // Fall through to the per-name lookup.
  }
  if (taken.size === 0) {
    for (const name of names) {
      try {
        if (ctx?.tools?.get?.(name) !== undefined) taken.add(name)
      } catch {
        // A host that cannot answer is treated as "free"; registration will throw
        // and the error is caught per tool below.
      }
    }
  }
  return taken
}

/** Same-origin route the panel reads the bridge address and token from. */
export const DISCOVERY_PATH = '/agent-browser/discovery'

/** Default logger: the host console plus the plugin logger when there is one. */
function makeLogger(ctx) {
  return (message) => {
    try {
      ctx.logger?.debug?.(`[agent-browser] ${message}`)
    } catch {
      // A missing logger is not worth failing a plugin over.
    }
    console.log(`[agent-browser] ${message}`)
  }
}

/**
 * Hold the `browserUse` slot while this panel is the browser tool provider.
 *
 * The seam is a process-wide mutex, not a tool source (see
 * `docs/browser-use-contract.md`): claiming it is how two browser controllers
 * avoid driving one page. Claiming is best-effort — if the seam is absent the
 * plugin must still work — and re-synced on every command so the
 * `claimBrowserUse` switch can be flipped live.
 * @param {import('cordis').Context} ctx - plugin context.
 * @param {() => boolean} wanted - read the `claimBrowserUse` volatile.
 * @param {(message: string) => void} log - logger.
 * @returns {{ sync: () => Promise<void>, release: () => Promise<void> }} the claim handle.
 */
function createClaim(ctx, wanted, log) {
  let release = null
  let held = false
  let chain = Promise.resolve()

  const drop = async (reason) => {
    const current = release
    release = null
    held = false
    if (current === null) return
    try {
      await current()
      log(`browserUse slot released (${reason})`)
    } catch (error) {
      log(`browserUse release failed: ${error?.message ?? error}`)
      throw error
    }
  }

  const sync = () => {
    chain = chain
      .then(async () => {
        const wants = wanted() === true
        if (wants === held) return
        if (!wants) {
          await drop('claimBrowserUse: false')
          return
        }
        const seam = ctx.get?.('browserUse')
        if (seam === undefined || seam === null || typeof seam.register !== 'function') {
          log('the browserUse seam is not present; no slot to claim')
          return
        }
        release = await seam.register('agent-browser-panel')
        held = true
        log('browserUse slot claimed')
      })
      .catch((error) => { log(`browserUse sync failed: ${error?.message ?? error}`) })
    return chain
  }

  return { sync, release: () => drop('unload') }
}

/**
 * Expose `{ origin, token }` to the panel's own origin.
 *
 * The client half never receives the loader row (client bundles are built from
 * `{ id, inject, immediately }` only), and a fixed port would collide with a
 * second DSH instance, so the address has to be handed over at runtime. The
 * route lives on the host's own web server, behind `connection.admit()`: only a
 * browser already holding this deployment's auth cookie can read it. That holds
 * for both shells — a GUI tab is same-origin, and the Electron renderer's
 * non-asset `dsh-app://` requests are forwarded to the host with the cookie
 * attached (`lib/main.js` `forwardWebRequest`).
 *
 * @param {import('cordis').Context} ctx - plugin context.
 * @param {Bridge} bridge - the bridge whose address is being published.
 * @param {(message: string) => void} log - logger.
 * @returns {() => void} disposer; a no-op when the host has no web server.
 */
function registerDiscovery(ctx, bridge, log) {
  const usable = (server) => server !== undefined && server !== null && typeof server.register === 'function'

  const install = (webServer) => webServer.register({
    kind: 'exact',
    path: DISCOVERY_PATH,
    handler: (request, response) => {
      const reply = (status, payload) => {
        const body = JSON.stringify(payload)
        response.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        response.end(request.method === 'HEAD' ? undefined : body)
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        reply(405, { ok: false, error: { code: 'method_not_allowed' } })
        return
      }
      // Resolved per request: the connection service may register after this
      // plugin is applied, and a cached `null` would answer 503 forever.
      const connection = ctx.get?.('connection')
      const admit = typeof connection?.admit === 'function' ? (candidate) => connection.admit(candidate) : null
      if (admit === null) {
        reply(503, { ok: false, error: { code: 'discovery_unavailable' } })
        return
      }
      const admission = admit(request)
      if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
        // 401 = no valid session cookie; 403 = the Host/Origin fence refused.
        // No `WWW-Authenticate`: that would pop a browser credentials dialog.
        reply(admission.rejection, { ok: false, error: { code: admission.rejection === 401 ? 'unauthorized' : 'forbidden' } })
        return
      }
      reply(200, {
        ok: true,
        mark: BRIDGE_MARK,
        prefix: BRIDGE_PREFIX,
        origin: bridge.origin,
        port: bridge.port,
        token: bridge.token,
      })
    },
  })

  const webServer = ctx.get?.('webServer')
  if (usable(webServer)) return install(webServer)

  // Cordis has no optional injection, and at boot (or right after a profile
  // reload) this plugin can be applied *before* the web server registers.
  // Giving up here used to leave the panel without a discovery route, which
  // surfaced only as `bridge_timeout` on every tool call. Wait for the service
  // instead, and publish as soon as it appears.
  if (typeof ctx.inject === 'function') {
    log('no webServer service yet: waiting for it before publishing the bridge address')
    let pending = null
    try {
      pending = ctx.inject(['webServer'], (scope) => {
        const late = scope.get?.('webServer')
        if (!usable(late)) {
          log('webServer injection fired but the service is unusable: the panel cannot learn the bridge address')
          return
        }
        log('webServer appeared later: publishing the bridge address now')
        const disposeRoute = install(late)
        scope.effect(() => disposeRoute, 'agent-browser.discovery')
      })
    } catch (error) {
      log(`could not wait for the webServer service: ${String(error?.message ?? error)}`)
      return () => {}
    }
    return () => {
      try {
        pending?.dispose?.()
      } catch {}
    }
  }

  log('no webServer service and no ctx.inject: the panel cannot learn the bridge address')
  return () => {}
}

/**
 * Wire the bridge, the workspace servers and every tool into one effect.
 *
 * @param {import('cordis').Context} ctx - plugin context.
 * @param {object} [config] - the loader row's config; volatile fields may be readers.
 * @param {{
 *   Bridge?: typeof Bridge,
 *   StaticSites?: typeof StaticSites,
 *   createTools?: typeof createTools,
 *   logger?: (message: string) => void,
 * }} [overrides] - test seams; production call passes nothing.
 * @returns {{ bridge: Bridge, sites: StaticSites, tools: Array<object> }} what was created.
 */
export function applyAgentBrowser(ctx, config = {}, overrides = {}) {
  const BridgeClass = overrides.Bridge ?? Bridge
  const StaticSitesClass = overrides.StaticSites ?? StaticSites
  const makeTools = overrides.createTools ?? createTools
  const log = overrides.logger ?? makeLogger(ctx)

  const settings = normalizeConfig(config)
  // One policy object for both seams: the tool bodies ask it right before they
  // act, and the host guard asks it before any body runs (TICKET-024). Values
  // are read per call, so volatile fields take effect without a reload.
  const rules = createPolicy({
    evalEnabled: config?.evalEnabled,
    sessions: config?.sessions,
    downloads: { ...config?.downloads, maxBytes: settings.downloads.maxBytes },
  })
  const activation = readField(config?.activation, DEFAULT_ACTIVATION)
  const fitWidth = readField(config?.fitWidth, true) !== false
  log(`host half applied (rev ${HOST_REV}, activation=${activation}, fitWidth=${fitWidth}, effects: 1)`)
  // Whether the host let us subclass HarnessError is worth one line: without it
  // the pipeline still shows the message, but `error.info.code` stays empty.
  log(`error codes: ${Object.keys(ERROR_CODES).length} (base: ${HARNESS_ERROR_BASE})`)

  const bridge = new BridgeClass({
    logger: log,
    port: settings.bridge.port,
    timeoutMs: settings.bridge.requestTimeoutMs,
    // The panel may need page-side code outside a tool call (the digest it shows
    // the agent when the human hands control back). Serving it from here keeps a
    // single copy of each in-page script, owned by the half that also ships it.
    sources: { snapshot: snapshotSource, guards: guardsSource },
  })
  bridge.note(`host half applied (rev ${HOST_REV})`, { activation })
  // Listen eagerly: a tool call may arrive before the first poll, and the bind
  // is cheap. Failures are logged and retried by the next `request`.
  bridge.start().catch((error) => { log(`bridge failed to start: ${error.message}`) })

  // Workspace pages are served over loopback: the panel cannot load file://.
  const sites = new StaticSitesClass({ logger: log, maxBytes: settings.static.maxBytes })

  const claim = createClaim(ctx, () => readField(config?.claimBrowserUse, true), log)
  // Claim eagerly as well: a second browser provider should be refused when the
  // plugin loads, not on the first click.
  void claim.sync()

  const gate = {
    request: async (sessionId, type, params, timeoutMs, options) => {
      // Re-read the claim live: flipping `claimBrowserUse` must take effect on
      // the next command, and the seam may appear after this plugin applied.
      await claim.sync()
      // `options` carries the display policy (`show`/`fit`) stamped on by
      // `createGate`; dropping it here would silently pin every command to the
      // default activation and to a width-fitted page.
      return bridge.request(sessionId, type, params, timeoutMs, options)
    },
    takeDigest: (sessionId) => bridge.takeDigest(sessionId),
  }

  const tools = makeTools(ctx, gate, sites, {
    activation: config?.activation,
    fitWidth: config?.fitWidth,
    evalEnabled: config?.evalEnabled,
    sessions: config?.sessions,
    limits: settings.limits,
    downloads: settings.downloads,
    // `enabled` stays a reader (volatile: one failed open can be retried after
    // turning it off); the cap is plain data, validated by `normalizeConfig`.
    searchFallback: {
      enabled: config?.searchFallback?.enabled,
      maxResults: settings.searchFallback.maxResults,
    },
    rules,
  })

  // Snapshot before registering: after this point every name above is ours.
  const taken = takenToolNames(ctx, tools.map((tool) => tool.name))

  ctx.effect(() => {
    const disposers = []
    const registered = []
    const failed = []
    // Someone else may own these names: the other browser plugin is a common
    // case, and on this host a duplicate registration throws. One bad name must
    // not take down the other ten tools, and the mismatch must be visible.
    const conflicts = tools.map((tool) => tool.name).filter((name) => taken.has(name))
    if (conflicts.length > 0) {
      log(`tool name conflict: another plugin already owns ${conflicts.join(', ')}. `
        + 'Only one browser backend can be enabled per profile; disable the other one and reload.')
    }
    for (const tool of tools) {
      try {
        disposers.push(ctx.tools.register(tool))
        registered.push(tool.name)
        log(`registered tool ${tool.name}`)
      } catch (error) {
        failed.push({ name: tool.name, error: String(error?.message ?? error) })
        log(`could not register tool ${tool.name}: ${error?.message ?? error}`)
      }
    }
    // A process-wide guard, filtered to our tool names: a denial happens before
    // the body runs, so a session outside the allow list cannot even touch the
    // panel (TICKET-024). Registered after the tools so `reverse()` below removes
    // it first.
    if (typeof ctx.tools.guard === 'function') {
      try {
        disposers.push(ctx.tools.guard((exec) => rules.guard(exec)))
        log('policy guard registered (session allow list enforced)')
      } catch (error) {
        failed.push({ name: 'tools.guard', error: String(error?.message ?? error) })
        log(`could not register the policy guard: ${error?.message ?? error}`)
      }
    } else {
      log('this host has no ctx.tools.guard(); session policy only applies in the tool bodies')
    }
    // The tool surface and any ownership clash go out on `/health`: a half-dead
    // plugin is otherwise indistinguishable from a working one from outside.
    bridge.setDiagnostics?.({
      tools: tools.length,
      registered: registered.length,
      conflicts,
      failed,
    })
    bridge.note('tool surface', { tools: tools.length, registered: registered.length, conflicts })
    // After the tools: a tool must never be able to reach a bridge whose address
    // the panel just lost. `reverse()` below calls this after every tool disposer.
    disposers.push(registerDiscovery(ctx, bridge, log))
    return async () => {
      const failures = []
      // Ordered teardown: tools, then the services they were using.
      for (const dispose of disposers.reverse()) {
        try {
          await dispose?.()
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        await claim.release()
      } catch (error) {
        failures.push(error)
      }
      try {
        await bridge.close()
      } catch (error) {
        failures.push(error)
      }
      try {
        await sites.dispose()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `agent-browser: ${failures.length} cleanup step(s) failed`)
      }
    }
  }, 'agent-browser')

  return { bridge, sites, tools }
}
