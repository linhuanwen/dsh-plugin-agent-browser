/**
 * Host half entry point.
 *
 * Kept thin on purpose: this is the only file that imports schemastery, which
 * the DSH host provides but plain `node` cannot resolve. Everything worth
 * testing (config resolution, lifecycle, tool wiring) lives in `config.js`,
 * `apply.js` and `tools.js`.
 *
 * Config groups mirror the ticket that introduced them (TICKET-016, plus
 * `sessions` from TICKET-024 and `searchFallback` from TICKET-027): `bridge` /
 * `limits` / `downloads` / `static` / `sessions` / `searchFallback.maxResults`
 * are restart fields (the plugin is replaced when they change), while
 * `activation`, `fitWidth`, `evalEnabled`, `claimBrowserUse`, `routing` and
 * `searchFallback.enabled` are `.volatile()` — the loader hands back a reader, and
 * the host half reads it on every command, so a config-editor change applies live.
 */
import z from '@deepseek-ai/schemastery'
import { ACTIVATIONS } from './activation.js'
import { applyAgentBrowser } from './apply.js'
import { DEFAULTS } from './config.js'

export const name = 'dsh-plugin-agent-browser'

/** Tools, image attachments and the system-prompt registry are the host services we need. */
export const inject = ['tools', 'attachments', 'systemPrompt']

export const Config = z.object({
  // A plain string rather than an enum schema: an unknown value must not stop
  // the plugin from loading, and `normalizeActivation` already fails towards
  // `auto` (the safe direction — see activation.js).
  activation: z.string()
    .default(DEFAULTS.activation)
    .description(`When the browser panel may open itself: ${ACTIVATIONS.join(' / ')}.`)
    .volatile(),
  // On by default: a narrow sidebar showing one column of a 1200px layout is the
  // common case, and the page reads better fitted. Off means "100%, scroll
  // sideways", which is a legitimate choice for an app-like page.
  fitWidth: z.boolean()
    .default(DEFAULTS.fitWidth)
    .description('Shrink the page after each navigation so its layout fits the panel width (no sideways scrolling).')
    .volatile(),
  // Off is the publishing default for a future release; on keeps 1.0.x behaviour
  // for this installation. When off, `browser_eval` fails with `eval_disabled:`.
  evalEnabled: z.boolean()
    .default(DEFAULTS.evalEnabled)
    .description('Allow browser_eval to run arbitrary JavaScript in the page. Turn off when the panel visits untrusted pages.')
    .volatile(),
  claimBrowserUse: z.boolean()
    .default(DEFAULTS.claimBrowserUse)
    .description('Hold the harness `browserUse` slot while this panel provides browser tools, so a second provider cannot drive the same page.')
    .volatile(),
  // Tool descriptions lose to skill bodies and to a user's AGENTS.md, which is
  // exactly where a profile that also ships `dsh-pilot` points browser work.
  // A system-prompt section is assembled for every step and outranks both, so
  // this is where the routing rule has to live (TICKET-035).
  routing: z.string()
    .default(DEFAULTS.routing)
    .description('Add a routing paragraph to the agent system prompt: off (the default), auto (only when another browser tool set is loaded), or on.')
    .volatile(),

  bridge: z.object({
    port: z.natural()
      .default(DEFAULTS.bridge.port)
      .description('Loopback port for the panel channel. 0 (default) lets the OS pick one; the panel learns it from the host discovery route, so two instances never collide.'),
    requestTimeoutMs: z.natural()
      .default(DEFAULTS.bridge.requestTimeoutMs)
      .description('How long a tool waits for the panel to pick up and finish its command.'),
  })
    .default({})
    .description('Panel channel: port and command timeout.'),

  limits: z.object({
    navigationTimeoutMs: z.natural()
      .default(DEFAULTS.limits.navigationTimeoutMs)
      .description('Budget for browser_open to finish loading a page.'),
    snapshotMaxChars: z.natural()
      .default(DEFAULTS.limits.snapshotMaxChars)
      .description('Default character budget for the accessibility tree in browser_snapshot.'),
    evalMaxChars: z.natural()
      .default(DEFAULTS.limits.evalMaxChars)
      .description('Default character budget for the serialized value in browser_eval.'),
  })
    .default({})
    .description('Per-tool budgets. Lowering snapshotMaxChars is the cheapest way to cut context cost.'),

  downloads: z.object({
    dir: z.string()
      .default(DEFAULTS.downloads.dir)
      .description('Directory under the session working directory that browser_download writes into.'),
    maxBytes: z.natural()
      .default(DEFAULTS.downloads.maxBytes)
      .description('Largest file browser_download will save.'),
    extraBlockedExtensions: z.array(z.string())
      .default([])
      .description('Extra file extensions to refuse on top of the built-in list (executables are already refused).'),
  })
    .default({})
    .description('browser_download target, size ceiling and extra extension denials.'),

  sessions: z.object({
    allowlist: z.array(z.string())
      .default([])
      .description('Session (agent) ids allowed to use the browser tools. Empty means every session may.'),
  })
    .default({})
    .description('Who may drive the browser; enforced by a host guard before any tool body runs.'),

  searchFallback: z.object({
    // Off by default, and it stays off through every release: on this host the
    // default search route is billed per call (TICKET-027 U7). Turning this on is
    // an explicit operator decision, so it is also `.volatile()` — the next failed
    // open behaves differently without reloading the panel.
    enabled: z.boolean()
      .default(DEFAULTS.searchFallback.enabled)
      .description('When a page fails to open (or asks for a human), run one site-scoped web search and add the candidates to the error. Each search may be billed; nothing is opened automatically.')
      .volatile(),
    maxResults: z.natural()
      .default(DEFAULTS.searchFallback.maxResults)
      .description('Most candidates one fallback search may attach to an error (1–10, clamped).'),
  })
    .default({})
    .description('Optional: on a failed open, suggest same-site pages found by web search. Off by default because searches may be billed.'),

  static: z.object({
    maxBytes: z.natural()
      .default(DEFAULTS.static.maxBytes)
      .description('Largest file the loopback workspace server will serve to the panel.'),
  })
    .default({})
    .description('The read-only workspace server that lets the panel open local files.'),

  approvals: z.object({
    // Volatile: the panel asks for consent per action, so flipping the mode in the
    // config editor applies to the next write without a reload.
    mode: z.string()
      .default(DEFAULTS.approvals.mode)
      .description('Write-action confirmation: first-touch (the default — reads never prompt, the first write on each site does) or off (1.4.x behaviour).')
      .volatile(),
    timeoutMs: z.natural()
      .default(DEFAULTS.approvals.timeoutMs)
      .description('How long the panel has to answer a confirmation prompt before the action is refused (2s–120s).'),
    sensitiveSites: z.array(z.string())
      .default([])
      .description('Sites that prompt on every write, even after the user allowed the site for this session. Host names or URLs.'),
  })
    .default({})
    .description('Site-level first-write confirmation for actions that change the page (SPEC-003, TICKET-037/038).'),

  dialogs: z.object({
    // Restart-scoped: the guards read the mode when they are injected on each
    // document, so the panel picks a change up on the next navigation.
    mode: z.string()
      .default(DEFAULTS.dialogs.mode)
      .description('What to do with a page\'s blocking JS dialogs: record (the default — answer conservatively, list them in the tool result) or off (native dialogs, which freeze the page until a person clicks).'),
  })
    .default({})
    .description('How the injected guards handle alert/confirm/prompt (TICKET-041).'),
})

/**
 * Register the bridge and every browser tool.
 * @param {import('cordis').Context} ctx - the plugin context.
 * @param {object} [config] - the row's validated config; volatile fields are readers.
 */
export function apply(ctx, config = {}) {
  applyAgentBrowser(ctx, config)
}
