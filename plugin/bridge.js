/**
 * Host half of the panel channel.
 *
 * The direction we need is host -> client: a tool call has to make the panel
 * navigate, type, or screenshot. DSH's Remote layer naturally runs the other
 * way (client -> host), so the channel here is the documented fallback from the
 * spec: the host parks commands in a per-session queue, and the client polls.
 *
 * The transport is loopback HTTP. It is deliberately the dumbest thing that
 * works: no protocol negotiation, no pairing, `curl` can inspect it, and the
 * panel can poll it from the renderer with a plain fetch. Only 127.0.0.1 is
 * bound, and every response is tagged so a stray server on the same port is
 * detectable.
 *
 * Loopback is not an authorization boundary: every local process, and every
 * page that can reach this port, is on it. So the port is random per process
 * and every request must carry a bearer token minted here. The panel learns
 * the pair from the host's `/agent-browser/discovery` route (same origin, past
 * the DSH connection fence), never from a file or a hard-coded constant.
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { AgentBrowserError, fromPanelMessage, isAgentBrowserError } from './errors.js'
import { DEFAULT_APPROVAL_TIMEOUT_MS, parseDecision } from './approvals.js'

/** Default port: 0 asks the OS for a free one, so two instances never collide. */
export const BRIDGE_PORT = 0
/** Path prefix, so the server can never be confused with an unrelated 127.0.0.1 service. */
export const BRIDGE_PREFIX = '/dsh-agent-browser'
/** Marker that a responder really is this plugin. */
export const BRIDGE_MARK = 'dsh-plugin-agent-browser/1'
/** How long a tool waits for the panel to pick up and finish a command. */
export const DEFAULT_TIMEOUT_MS = 20_000
/** Headers the panel may present the per-process token with. */
export const TOKEN_HEADERS = 'authorization, x-agent-browser-token'
/** Query parameter accepted on safe methods, where a header would force a preflight. */
export const TOKEN_QUERY = 'token'
/**
 * Largest JSON body the panel may post back.
 *
 * A screenshot comes back as a base64 data URL, so the size is the picture, not
 * a command: a busy map tile page reaches ~4.2 M characters, and a stitched tall
 * page can be several times that. The old 4 MiB cap was under the first real
 * case (TICKET-034: the reply was refused, the panel's settle never landed, and
 * the tool sat out its whole 60 s budget before reporting `bridge_timeout`).
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024

/** Phases a session can be in. `idle` is derived, the other three are stored. */
export const PHASES = ['idle', 'agent', 'taken_over', 'needs_human']

/** Tools that change or navigate the page; refused while a human has the wheel. */
const INPUT_TYPES = new Set(['open', 'click', 'drag', 'fill', 'scroll', 'hover', 'zoom', 'screenshot', 'type', 'press', 'eval'])

/**
 * Tools that only look; they must never take the wheel back from the human.
 *
 * `inspect` exists so the approval gate can classify an element before asking.
 * If a read like that flipped the phase to `agent`, a pending `needs_human` or
 * `taken_over` would be erased by the very call that checks whether asking is
 * allowed (SPEC-003 C8 keeps the human's phase on top of the approval gate).
 *
 * `tabs` is panel bookkeeping, not a page action: listing the open tabs or
 * switching between them must not steal control either. The mutating half
 * (`switch` / `close`) is still refused while a human is at the wheel — see
 * `#assert`, which gets the command's params for exactly this reason.
 *
 * `pick` (TICKET-053) never touches the page either, but it does ask the human
 * to click: it is a read type so it does not steal the phase, and `#assert`
 * refuses it under `taken_over` (the human already owns the panel) while
 * allowing it under `needs_human` (pointing at an element on a challenge page
 * is exactly when pointing helps).
 */
const READ_TYPES = new Set(['snapshot', 'inspect', 'wait', 'tabs', 'pick', 'read'])

/**
 * Commands whose effect cannot be proven absent once the panel pulled them.
 *
 * `#drain()` means the panel took the command: it is now sitting in the
 * renderer's queue, possibly already executing, and a lost result (timeout,
 * cancel, takeover, shutdown) no longer justifies "nothing was sent". These are
 * the commands that back `browser_click` / `browser_drag` / `browser_type` /
 * `browser_press` / `browser_eval`; the tool layer turns the resulting `action_unknown` error into
 * `effect: 'unknown'` (SPEC-004 B4, TICKET-042). `open`/`snapshot`/`scroll` are
 * deliberately absent: a navigation that did not report back is re-observable
 * and is not a write against the site.
 */
const WRITE_TYPES = new Set(['click', 'drag', 'fill', 'type', 'press', 'eval', 'upload'])

/** A session that has not acted for this long reads as `idle` instead of `agent`. */
const IDLE_MS = 45_000

/** How long `close()` waits for open connections before cutting them off. */
const CLOSE_TIMEOUT_MS = 2_000

/**
 * Per-session command queue plus the promises waiting on each command.
 *
 * One tool call = one command. The client pulls whatever is queued for its
 * session, executes in order, and settles every command exactly once; a
 * timeout settles it as an error so a closed panel never wedges a tool call.
 */
export class Bridge {
  /** @type {Map<string, Array<object>>} */
  #queues = new Map()
  /** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
  #waiting = new Map()
  /** @type {Set<string>} sessions whose panel has polled at least once */
  #seen = new Set()
  /** @type {Set<{ settle: () => void }>} parked long-polls */
  #waiters = new Set()
  /**
   * Who is driving each session's page, and since when.
   *
   * This lives on the host, not in the panel, because it has to survive a panel
   * rebuild, a page navigation, and a session switch: a user who took over five
   * minutes ago is still driving, even if they are looking at another chat.
   * @type {Map<string, { phase: string, since: number, reason: string, signals: string[], digest: string }>}
   */
  #states = new Map()
  #server = null
  #port = BRIDGE_PORT
  /** Bearer token every request must carry; minted once per process. */
  #token
  /** Listening origin, filled once the socket is bound (`''` before that). */
  #origin = ''
  #logger
  #enqueued = 0
  #pulled = 0
  /** Ring buffer of what the panel says it did; the host has no console to read. */
  #logs = []
  #logLimit = 200
  /** Memoized listen promise: `start()` may be called from `apply` and from a tool race. */
  #starting = null
  /** Page-side sources the panel may request by name (`snapshot`, …). */
  #sources = {}

  /**
   * TICKET-056: the host-side action recorder, or null when `apply` did not
   * hand one in (bare test bridges). The panel strip reads it through
   * `GET /timeline`; the model-facing tool holds the same object.
   * @type {{ list: Function, size: number } | null}
   */
  #timeline = null
  /**
   * The settings page's read/write path, when the host can edit the row.
   *
   * The bridge only transports it: `read()` answers the resolved config and the
   * per-field restart semantics; `write(patch)` hands a shallow patch to the
   * config editor, which validates it and owns the write. `null` means this
   * profile cannot save configuration (no editor, or a bare test bridge), and
   * `/config` then answers 501 instead of pretending the page is broken.
   * @type {null | { read: () => Promise<object> | object, write: (patch: object) => Promise<object> }}
   */
  #config = null
  /** Default budget for a command the panel has to pick up and finish. */
  #timeoutMs = DEFAULT_TIMEOUT_MS
  /** Set by `close()`/`dispose()`; a shut-down bridge must fail instead of queueing. */
  #closed = false
  /**
   * Ids the caller cancelled. Kept only so a late `/settle` from a panel that was
   * already executing the command is answered politely instead of as an error.
   * Bounded, because a long session would otherwise grow it forever.
   * @type {Set<string>}
   */
  #cancelled = new Set()
  /** Cap for `#cancelled`. */
  #cancelledLimit = 64
  /**
   * What the panel last said about each session's page.
   *
   * Approvals are scoped per origin, so the host has to know which site the
   * panel is on before it can decide whether to ask. The panel reports every
   * navigation; the value is advisory (the page could have moved on), but it is
   * the only origin the host can see.
   * @type {Map<string, { url: string, title: string }>}
   */
  #pages = new Map()
  /**
   * The one approval each session is waiting on, if any.
   *
   * One per session on purpose: two stacked prompts on a narrow panel would be
   * two chances to click the wrong one, and the tool layer never needs two
   * answers at once (commands for a session run in order).
   * @type {Map<string, object>}
   */
  #approvals = new Map()
  #approvalSeq = 0
  /**
   * When a panel last asked for work.
   *
   * A pending approval needs a visible panel to be shown on. If no poll arrives
   * after it was issued, nobody can see the prompt, so the host fails the call
   * fast (`approval_required`) instead of waiting out the whole timeout.
   */
  #lastPollAt = 0
  /**
   * Host-side facts `/health` should expose but the bridge cannot discover on its
   * own (which tools actually got registered, and whether another browser plugin
   * already owns their names). Set once by `apply`.
   * @type {Record<string, unknown>}
   */
  #diagnostics = {}

  constructor(options = {}) {
    this.#logger = options.logger ?? (() => {})
    this.#port = options.port ?? BRIDGE_PORT
    this.#token = options.token ?? randomBytes(32).toString('base64url')
    this.#sources = options.sources ?? {}
    this.#config = options.config ?? null
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Listening port (after `start`, this is the real one). */
  get port() {
    return this.#port
  }

  /** Bearer token the panel must present; also handed out by the discovery route. */
  get token() {
    return this.#token
  }

  /** Loopback origin of the listening socket (`''` before `start` resolves). */
  get origin() {
    return this.#origin
  }

  /** True once a panel has polled at least once. */
  hasClient() {
    return this.#seen.size > 0
  }

  /**
   * Merge host-side facts into the `/health` payload.
   *
   * Used for the tool surface: two browser plugins in one profile claim the same
   * `browser_*` names, and the loser used to die with an opaque "already
   * registered" error. Exposing the result here makes that visible from outside
   * the process (`GET /health` with the discovery token) instead of only in the
   * GUI console.
   * @param {Record<string, unknown>} fields - partial diagnostics to merge.
   */
  setDiagnostics(fields) {
    if (fields === null || typeof fields !== 'object') return
    this.#diagnostics = { ...this.#diagnostics, ...fields }
  }

  /**
   * Hand the bridge the recorder the tools write into (TICKET-056).
   *
   * Optional on purpose: tests and the panel-only path start a bridge without a
   * timeline, and `GET /timeline` must answer "nothing recorded" rather than
   * fail the whole settings/panel boot.
   * @param {{ list: Function, size: number } | null} timeline - the recorder.
   */
  setTimeline(timeline) {
    this.#timeline = timeline !== undefined && timeline !== null && typeof timeline.list === 'function'
      ? timeline
      : null
  }

  /**
   * Whether the Host header names this loopback listener.
   *
   * A rebound page sends the attacker's hostname here even though the socket
   * lands on 127.0.0.1, so an exact match is the one thing DNS cannot forge.
   * @param {import('node:http').IncomingMessage} req
   */
  #hostTrusted(req) {
    const host = String(req.headers.host ?? '')
    return host === `127.0.0.1:${this.#port}` || host === `localhost:${this.#port}`
  }

  /**
   * Whether the request carries this process's token.
   *
   * A header is required for state-changing calls; long-polls may pass it as a
   * query parameter instead, because a custom header would turn every poll into
   * a preflighted request. Tokens come from the discovery route, not from disk.
   * @param {import('node:http').IncomingMessage} req
   * @param {URL} url
   */
  #tokenMatches(req, url) {
    const authorization = req.headers.authorization
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined
    const custom = req.headers['x-agent-browser-token']
    const safe = req.method === 'GET' || req.method === 'HEAD'
    const query = safe ? (url.searchParams.get(TOKEN_QUERY) ?? undefined) : undefined
    return [bearer, custom, query].some((candidate) => typeof candidate === 'string' && sameToken(candidate, this.#token))
  }

  /**
   * Record a host-side event into the same ring the panel writes to.
   *
   * The host has no readable console, so anything that has to be observed
   * during development goes here and is read back with `/logs`.
   * @param {string} message - short tag.
   * @param {object} [data] - attached detail.
   */
  note(message, data = null) {
    this.#logs.push({ at: Date.now(), message, data })
    if (this.#logs.length > this.#logLimit) this.#logs.shift()
    this.#logger(message)
  }

  /**
   * Current control state of one session.
   *
   * `agent` decays to `idle` after a quiet minute so the badge does not claim
   * the agent is working when it has not touched the page for a while.
   * @param {string} sessionId - the agent session.
   * @returns {{ phase: string, since: number, reason: string, signals: string[], digest: string }}
   */
  stateOf(sessionId) {
    const state = this.#states.get(sessionId)
    if (state === undefined) return { phase: 'idle', since: 0, reason: '', signals: [], digest: '' }
    const phase = state.phase === 'agent' && Date.now() - state.since > IDLE_MS ? 'idle' : state.phase
    return { ...state, phase }
  }

  /**
   * Move a session into a phase.
   *
   * Entering `taken_over` also empties the queue and fails everything already
   * waiting: a command the panel would run under the user's hands is worse
   * than an error the agent can read.
   * @param {string} sessionId - the agent session.
   * @param {string} phase - one of `PHASES`.
   * @param {{ reason?: string, signals?: string[], digest?: string, since?: number }} [detail]
   */
  setPhase(sessionId, phase, detail = {}) {
    const previous = this.stateOf(sessionId)
    const next = {
      phase: PHASES.includes(phase) ? phase : 'idle',
      since: Number.isFinite(detail.since) ? Number(detail.since) : Date.now(),
      reason: typeof detail.reason === 'string' ? detail.reason : '',
      signals: Array.isArray(detail.signals) ? detail.signals.slice(0, 8).map(String) : [],
      digest: typeof detail.digest === 'string' ? detail.digest : previous.digest,
    }
    this.#states.set(sessionId, next)
    if (next.phase !== previous.phase || next.reason !== previous.reason) {
      this.note('phase', { session: short(sessionId), from: previous.phase, to: next.phase, reason: next.reason })
    }
    if (next.phase === 'taken_over') this.#flushSession(sessionId, 'the user took over while this command was queued')
    this.#wake()
  }

  /**
   * Refuse a command for the wrong driver.
   *
   * Read-only tools stay available while a human is working: the agent must be
   * able to see what changed, it just may not type or click. Navigation is the
   * one write that survives `needs_human`: a panel parked on a challenge page the
   * agent cannot solve would otherwise be a dead end — opening another URL is how
   * it gives up on this page and carries on. Under `taken_over` even navigation
   * stays refused, because there the human owns the panel outright.
   *
   * Tab bookkeeping is the other nuance (TICKET-050): `tabs` is a read type so
   * that listing tabs never steals the wheel, but `switch` / `close` change the
   * page the human is looking at — under any human phase they are refused with
   * the same codes, because hiding a verification wall or pulling the page out
   * from under the user is exactly what the human phase exists to prevent.
   * @param {string} sessionId - the agent session.
   * @param {string} type - command type.
   * @param {object} [params] - the command parameters (the tab action matters).
   */
  #assert(sessionId, type, params = {}) {
    const { phase } = this.stateOf(sessionId)
    const tabAction = type === 'tabs' ? params.action : ''
    const input = INPUT_TYPES.has(type) || (type === 'tabs' && tabAction !== 'list')
    // TICKET-053: picking is read-only, but it asks the human to click. Under
    // `taken_over` that contradicts "the user is driving", so it is refused with
    // the same code as an input; under `needs_human` it stays available.
    if (type === 'pick' && phase === 'taken_over') {
      throw new AgentBrowserError(
        'panel_taken_over',
        '用户已接管，请等待交还。The user is driving the panel right now, so it cannot ask them to '
        + 'point at an element; wait until they hand it back, then pick again.',
      )
    }
    if (phase === 'taken_over' && input) {
      throw new AgentBrowserError(
        'panel_taken_over',
        '用户已接管，请等待交还。The user is driving the panel right now; '
        + 'wait until they hand it back, then continue. Reads (browser_snapshot) still work.',
      )
    }
    if (phase === 'needs_human' && input && type !== 'open') {
      throw new AgentBrowserError(
        'needs_human',
        '页面需要人工验证（a human verification step is on screen）。'
        + 'Ask the user to complete it in the panel; browser_snapshot still works so you can see '
        + 'when it is gone, and browser_open can still navigate away from this page.',
      )
    }
  }

  /**
   * Take (once) the digest the panel left when the user handed control back.
   * @param {string} sessionId - the agent session.
   * @returns {string} one line describing the page, or ''.
   */
  takeDigest(sessionId) {
    const state = this.#states.get(sessionId)
    if (state === undefined || state.digest === '') return ''
    const digest = state.digest
    state.digest = ''
    return digest
  }

  /**
   * What the panel last said about a session's page.
   * @param {string} sessionId - the agent session.
   * @returns {{ url: string, title: string }} the last reported address and title.
   */
  pageOf(sessionId) {
    return this.#pages.get(sessionId) ?? { url: '', title: '' }
  }

  /**
   * Record where a session's panel is now.
   *
   * The panel reports this on every navigation; it is what a permission prompt
   * is scoped to, so a stale address here means a prompt for the wrong site.
   * @param {string} sessionId - the agent session.
   * @param {{ url?: unknown, title?: unknown }} [page] - what the panel saw.
   */
  notePage(sessionId, page = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    const url = typeof page?.url === 'string' ? page.url : ''
    const title = typeof page?.title === 'string' ? page.title : ''
    const previous = this.#pages.get(sessionId)
    this.#pages.set(sessionId, { url, title })
    if (previous === undefined || previous.url !== url) {
      this.note('page', { session: short(sessionId), url: shortUrl(url) })
    }
  }

  /** Pending approvals, in the shape the panel renders them. */
  #approvalFrames() {
    const frames = []
    for (const [sessionId, approval] of this.#approvals) {
      frames.push({
        session: sessionId,
        id: approval.id,
        origin: approval.origin,
        actionClass: approval.actionClass,
        summary: approval.summary,
        timeoutMs: approval.timeoutMs,
        issuedAt: approval.issuedAt,
      })
    }
    return frames
  }

  /**
   * Ask the human in the panel to allow one write action.
   *
   * Resolves with `{ decision: 'once' | 'site' }` when the user allowed it, and
   * rejects with a stable `approval_*` error in every other case. Half an hour
   * of argument went into this shape: it fails closed on every path (closed
   * panel, hidden window, no answer, refusal, takeover), it never retries the
   * action itself, and it returns only once the human has decided or the budget
   * is gone.
   * @param {string} sessionId - the agent session whose panel should ask.
   * @param {{ origin?: string, actionClass?: string, summary?: string, timeoutMs?: number }} [options]
   * @returns {Promise<{ decision: 'once' | 'site' }>} the user's answer.
   */
  async approve(sessionId, options = {}) {
    if (this.#closed) throw new AgentBrowserError('bridge_closed', 'the browser panel bridge is shut down')
    // The human's phase outranks the prompt (SPEC-003 C8): asking "may I type?"
    // while a verification wall is up, or while the user owns the panel, would
    // paint a prompt the answer to which cannot be honoured anyway.
    this.#assert(sessionId, 'type')
    if (this.#approvals.has(sessionId)) {
      throw new AgentBrowserError(
        'approval_required',
        '另一个确认还在等你。Another permission prompt is already waiting for the user in this session; finish that one first.',
      )
    }
    if (this.#seen.size === 0) {
      throw new AgentBrowserError(
        'approval_required',
        '面板还没连上，没法向用户确认。The panel has never connected, so the user cannot be asked; '
        + 'open the right sidebar browser tab for this session (browser_open does it for you), then retry. '
        + 'Nothing was sent to the page.',
      )
    }
    const origin = typeof options.origin === 'string' ? options.origin : ''
    const actionClass = typeof options.actionClass === 'string' ? options.actionClass : 'write'
    const summary = typeof options.summary === 'string' ? options.summary : ''
    const wanted = Number(options.timeoutMs)
    const timeoutMs = Number.isFinite(wanted) && wanted > 0 ? Math.round(wanted) : DEFAULT_APPROVAL_TIMEOUT_MS
    return await new Promise((resolve, reject) => {
      const entry = {
        id: `a${++this.#approvalSeq}`,
        sessionId, origin, actionClass, summary, timeoutMs,
        issuedAt: Date.now(), resolve, reject, timer: null, watchdog: null,
      }
      this.#approvals.set(sessionId, entry)
      this.note('approval asked', {
        session: short(sessionId), origin: shortUrl(origin), actionClass, timeoutMs,
      })
      entry.timer = setTimeout(() => { this.#finishApproval(sessionId, entry, 'timeout') }, timeoutMs)
      entry.timer.unref?.()
      // Nobody is polling: the prompt cannot be on screen. Failing this fast is
      // what keeps a queued write from burning its whole budget on a closed tab.
      entry.watchdog = setTimeout(() => {
        if (this.#lastPollAt < entry.issuedAt) this.#finishApproval(sessionId, entry, 'unavailable')
      }, 500)
      entry.watchdog.unref?.()
      this.#wake()
    })
  }

  /**
   * Resolve one approval exactly once and drop it from the pending map.
   * @param {string} sessionId - the session that owns it.
   * @param {object} entry - the approval record created by `approve`.
   * @param {'once' | 'site' | 'deny' | 'timeout' | 'unavailable'} decision - the outcome.
   */
  #finishApproval(sessionId, entry, decision) {
    const current = this.#approvals.get(sessionId)
    if (current === undefined || current.id !== entry.id) return
    this.#approvals.delete(sessionId)
    clearTimeout(entry.timer)
    clearTimeout(entry.watchdog)
    if (decision === 'once' || decision === 'site') {
      this.note('approval granted', { session: short(sessionId), decision, origin: shortUrl(entry.origin) })
      entry.resolve({ decision })
      return
    }
    this.note('approval refused', { session: short(sessionId), decision })
    const what = entry.summary === '' ? '这次写操作' : entry.summary
    /** @type {{ code: string, text: string }} */
    let failure
    if (decision === 'deny') {
      failure = {
        code: 'approval_denied',
        text: `用户拒绝了${what}。The user refused this write action; nothing was sent to the page. `
          + 'Ask what they want done instead.',
      }
    } else if (decision === 'unavailable') {
      failure = {
        code: 'approval_required',
        text: '面板看不到，没法向用户确认。The panel could not show the permission prompt (closed or hidden), so nothing was sent to the page. '
          + 'Open the right sidebar browser tab for this session and retry.',
      }
    } else {
      failure = {
        code: 'approval_timeout',
        text: `用户 ${entry.timeoutMs}ms 内没有确认${what}。The user did not answer the permission prompt in time; `
          + 'nothing was sent to the page. Ask again when they are back.',
      }
    }
    entry.reject(new AgentBrowserError(failure.code, failure.text))
  }

  /** Drop one session's queue and fail its in-flight commands. */
  #flushSession(sessionId, reason) {
    // A pending prompt belongs to the agent's turn: once the human takes the
    // wheel, the answer would be about a page the agent no longer controls.
    const approval = this.#approvals.get(sessionId)
    if (approval !== undefined) this.#finishApproval(sessionId, approval, 'deny')
    const queue = this.#queues.get(sessionId)
    if (queue !== undefined && queue.length > 0) {
      this.note('flush', { session: short(sessionId), dropped: queue.length })
      this.#queues.delete(sessionId)
    }
    for (const [id, entry] of this.#waiting) {
      if (entry.sessionId !== sessionId) continue
      this.#waiting.delete(id)
      clearTimeout(entry.timer)
      // The human taking the wheel must not let a delivered write claim "nothing
      // happened": its effect stays unknown until the page is re-read.
      entry.reject(entry.delivered && WRITE_TYPES.has(entry.type)
        ? unknownOutcome(entry.type, 'the user took the panel over while it was executing')
        : new AgentBrowserError('panel_taken_over', reason))
    }
  }

  /**
   * Queue one command for a session and wait for the panel to settle it.
   * @param {string} sessionId - the agent's session; the panel polls its own session only.
   * @param {string} type - command type, e.g. `open`.
   * @param {object} params - command payload.
   * @param {number} [timeoutMs] - budget for the whole round trip (defaults to the
   *   bridge's configured `bridge.requestTimeoutMs`).
   * @param {{ show?: 'once'|'always'|'never', fit?: 'width'|'none', signal?: AbortSignal }} [options] -
   *   panel visibility instruction for this command (`once` when omitted), whether
   *   the page should be fitted to the panel width after navigation (`width` when
   *   omitted), and an abort signal owned by the caller (`exec.signal`).
   * @returns {Promise<object>} the command result.
   */
  async request(sessionId, type, params = {}, timeoutMs = this.#timeoutMs, options = {}) {
    if (this.#closed) throw new AgentBrowserError('bridge_closed', 'the browser panel bridge is shut down')
    const signal = options.signal
    // An already-aborted call must not reach the page at all: the queue is where
    // "a click the model no longer wants" would otherwise wait for its turn.
    if (signal?.aborted === true) throw cancelledError()
    await this.start()
    // A `close()` may have run while the first listen was still in flight.
    if (this.#closed) throw new AgentBrowserError('bridge_closed', 'the browser panel bridge is shut down')
    if (signal?.aborted === true) throw cancelledError()
    this.#assert(sessionId, type, params)
    if (READ_TYPES.has(type) === false) {
      const state = this.stateOf(sessionId)
      if (state.phase !== 'agent') this.setPhase(sessionId, 'agent', { reason: '' })
    }
    const id = `c${++this.#enqueued}`
    const show = options.show === 'always' || options.show === 'never' ? options.show : 'once'
    const fit = options.fit === 'none' ? 'none' : 'width'
    const started = Date.now()

    return new Promise((resolve, reject) => {
      /** @type {{ sessionId: string, type: string, delivered: boolean, resolve: (v: any) => void, reject: (e: Error) => void, timer: any, onAbort?: () => void }} */
      const entry = { sessionId, type, delivered: false, resolve, reject, timer: null }
      const finish = (error, value) => {
        clearTimeout(entry.timer)
        if (entry.onAbort !== undefined && signal !== undefined) {
          signal.removeEventListener('abort', entry.onAbort)
          entry.onAbort = undefined
        }
        this.#waiting.delete(id)
        if (error === null) {
          this.#logger(`resolve ${id} in ${Date.now() - started}ms`)
          resolve(value)
        } else {
          reject(error)
        }
      }
      entry.resolve = (value) => finish(null, value)
      entry.reject = (error) => finish(error, undefined)

      entry.timer = setTimeout(() => {
        this.#abandon(sessionId, id)
        // A write the panel already pulled may have run: report the middle state
        // instead of a retryable timeout (SPEC-004 B4, TICKET-042). Everything
        // else keeps the old `bridge_timeout` meaning: nothing reached the page.
        finish(entry.delivered && WRITE_TYPES.has(type)
          ? unknownOutcome(type, `the panel did not answer within ${timeoutMs}ms`)
          : new AgentBrowserError(
            'bridge_timeout',
            `browser panel did not answer ${id} (${type}) within ${timeoutMs}ms. `
            + 'Open the right sidebar browser tab for this session and retry.',
          ))
      }, timeoutMs)
      entry.timer.unref?.()

      this.#waiting.set(id, entry)
      if (signal !== undefined) {
        if (signal.aborted) {
          finish(cancelledError())
          return
        }
        entry.onAbort = () => this.#cancel(id, sessionId)
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }

      const command = { id, type, params, sessionId, enqueuedAt: Date.now(), show, fit }
      const queue = this.#queues.get(sessionId) ?? []
      queue.push(command)
      this.#queues.set(sessionId, queue)
      this.#logger(`enqueue ${id} ${type} session=${short(sessionId)}`)
      this.#wake()
    })
  }

  /**
   * Take one command back and tell the panel to stop it.
   *
   * Two different guarantees, and the difference matters:
   * - a command still in the queue is **removed**, so it never reaches the page;
   * - a command the panel already pulled is **not undone** — a click that landed
   *   is a click that landed. A `cancel` frame asks the panel to stop what it can
   *   (an in-flight navigation) and to drop the result instead of settling it.
   * @param {string} id - the command id.
   * @param {string} sessionId - the session that owns it.
   */
  #cancel(id, sessionId) {
    const entry = this.#waiting.get(id)
    if (entry === undefined) return
    this.#abandon(sessionId, id)
    this.#cancelled.add(id)
    while (this.#cancelled.size > this.#cancelledLimit) {
      const oldest = this.#cancelled.values().next().value
      this.#cancelled.delete(oldest)
    }
    // `show: 'never'` keeps the cancel frame from waking a panel that is not there;
    // it is a control frame, not something the user should see.
    const queue = this.#queues.get(sessionId) ?? []
    queue.push({
      id: `x${id}`,
      type: 'cancel',
      params: { target: id },
      sessionId,
      enqueuedAt: Date.now(),
      show: 'never',
      fit: 'width',
    })
    this.#queues.set(sessionId, queue)
    this.#wake()
    this.#logger(`cancel ${id}`)
    entry.reject(entry.delivered && WRITE_TYPES.has(entry.type)
      ? unknownOutcome(entry.type, 'the caller cancelled while the panel was executing it')
      : cancelledError(id))
  }

  /** Drop a command that timed out so a late panel does not execute it. */
  #abandon(sessionId, id) {
    const queue = this.#queues.get(sessionId)
    if (queue === undefined) return
    const at = queue.findIndex((command) => command.id === id)
    if (at >= 0) queue.splice(at, 1)
    if (queue.length === 0) this.#queues.delete(sessionId)
  }

  /**
   * Take everything queued, for every session at once.
   *
   * Draining all sessions in one poll is what lets a tool call open a tab in a
   * session the user is not currently looking at.
   * @returns {{ sessions: Record<string, Array<object>>, total: number }}
   */
  #drain() {
    const sessions = {}
    let total = 0
    for (const [sessionId, queue] of this.#queues) {
      if (queue.length === 0) continue
      sessions[sessionId] = queue.map(({ id, type, params, show, fit }) => {
        // From here on the panel owns the command: a lost result is no longer
        // evidence that nothing happened (TICKET-042).
        const entry = this.#waiting.get(id)
        if (entry !== undefined) entry.delivered = true
        return { id, type, params, show, fit }
      })
      total += queue.length
      this.#seen.add(sessionId)
    }
    if (total > 0) {
      this.#queues.clear()
      this.#pulled += total
    }
    return { sessions, total }
  }

  /** Park until a command arrives or `waitMs` passes. */
  async #park(waitMs) {
    await new Promise((resolve) => {
      const settle = () => {
        clearTimeout(timer)
        this.#waiters.delete(waiter)
        resolve()
      }
      const waiter = { settle }
      const timer = setTimeout(settle, waitMs)
      timer.unref?.()
      this.#waiters.add(waiter)
    })
  }

  /** Wake every parked poll; called as soon as a command is queued. */
  #wake() {
    for (const waiter of [...this.#waiters]) waiter.settle()
  }

  /**
   * Start listening. Binding 127.0.0.1 only: the panel is in this machine's renderer.
   * @returns {Promise<number>} the listening port.
   */
  async start() {
    if (this.#closed) throw new AgentBrowserError('bridge_closed', 'the browser panel bridge is shut down')
    this.#starting ??= this.#listen()
    return this.#starting
  }

  /** Bind the socket once; the promise is memoized by `start`. */
  async #listen() {
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        send(res, 500, { ok: false, error: String(error?.message ?? error) })
      })
    })
    server.on('error', (error) => {
      this.#logger(`bridge error: ${error.message}`)
    })
    this.#server = server
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#port, '127.0.0.1', () => {
        server.off('error', reject)
        const address = server.address()
        if (address !== null && typeof address === 'object') this.#port = address.port
        this.#origin = `http://127.0.0.1:${this.#port}`
        this.#logger(`bridge listening on ${this.#origin}${BRIDGE_PREFIX}`)
        resolve()
      })
    })
    // A `close()` that raced the first bind cannot see this socket: `#server` was
    // already taken by the shutdown, so the listen would otherwise leak.
    if (this.#closed) {
      server.closeAllConnections?.()
      server.close()
    }
    return this.#port
  }

  /**
   * Stop listening and fail every command still waiting.
   *
   * Asynchronous because `server.close()` waits for open connections and the
   * panel keeps a long-poll parked: without a bound on that wait, unloading the
   * plugin would hang. Waiting commands are failed with a stable `bridge_closed:`
   * prefix, so a tool call ends immediately instead of burning its timeout.
   * @returns {Promise<void>} resolves once the socket is closed (idempotent).
   */
  async close() {
    this.#closed = true
    for (const [id, entry] of this.#waiting) {
      entry.reject(entry.delivered && WRITE_TYPES.has(entry.type)
        ? unknownOutcome(entry.type, 'the plugin stopped while the panel was executing it')
        : new AgentBrowserError('bridge_closed', `the bridge stopped before ${id} settled`))
    }
    for (const [sessionId, approval] of [...this.#approvals]) {
      this.#approvals.delete(sessionId)
      clearTimeout(approval.timer)
      clearTimeout(approval.watchdog)
      approval.reject(new AgentBrowserError('bridge_closed', 'the plugin stopped while the user was being asked for permission'))
    }
    this.#waiting.clear()
    this.#queues.clear()
    this.#wake()
    const server = this.#server
    this.#server = null
    if (server === null) return
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        server.closeAllConnections?.()
        resolve()
      }, CLOSE_TIMEOUT_MS)
      timer.unref?.()
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Synchronous escape hatch for process teardown; prefer `close()` while unloading. */
  dispose() {
    this.#closed = true
    for (const [id, entry] of this.#waiting) {
      entry.reject(entry.delivered && WRITE_TYPES.has(entry.type)
        ? unknownOutcome(entry.type, 'the plugin stopped while the panel was executing it')
        : new AgentBrowserError('bridge_closed', `the bridge stopped before ${id} settled`))
    }
    for (const [sessionId, approval] of [...this.#approvals]) {
      this.#approvals.delete(sessionId)
      clearTimeout(approval.timer)
      clearTimeout(approval.watchdog)
      approval.reject(new AgentBrowserError('bridge_closed', 'the plugin stopped while the user was being asked for permission'))
    }
    this.#waiting.clear()
    this.#queues.clear()
    this.#wake()
    if (this.#server !== null) {
      this.#server.close()
      this.#server = null
    }
  }

  /** Route one HTTP request. */
  async #handle(req, res) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.#port}`)
    if (!url.pathname.startsWith(BRIDGE_PREFIX)) {
      send(res, 404, { ok: false, error: 'not this service', mark: BRIDGE_MARK })
      return
    }
    const route = url.pathname.slice(BRIDGE_PREFIX.length) || '/'
    const origin = req.headers.origin ?? ''
    if (!isPanelOrigin(origin)) {
      this.#logger(`rejected ${route} from origin=${origin || '(none)'}`)
      send(res, 403, { ok: false, error: 'unexpected origin', mark: BRIDGE_MARK })
      return
    }

    // The renderer runs on dsh-app://app, so every JSON POST is cross-origin and
    // arrives behind a preflight. Answering it here is what lets the panel settle
    // commands at all: a 404 on OPTIONS makes the browser drop the real request.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': origin === '' ? '*' : origin,
        'access-control-allow-headers': `content-type, ${TOKEN_HEADERS}`,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '600',
        'content-length': '0',
      })
      res.end()
      return
    }

    // Two independent fences beyond the origin check. Host catches DNS
    // rebinding (the attacker's name reaches a loopback address); the token is
    // the actual credential, since any local process can forge Origin.
    if (!this.#hostTrusted(req)) {
      this.#logger(`rejected ${route} with host=${String(req.headers.host ?? '')}`)
      send(res, 403, unauthorized('untrusted host'))
      return
    }
    if (!this.#tokenMatches(req, url)) {
      this.#logger(`rejected ${route} without a valid token`)
      send(res, 403, unauthorized('missing or invalid token'))
      return
    }

    if (route === '/health') {
      let queued = 0
      for (const queue of this.#queues.values()) queued += queue.length
      send(res, 200, {
        ok: true,
        mark: BRIDGE_MARK,
        origin: this.#origin,
        clients: this.#seen.size,
        seen: [...this.#seen].map(short),
        queued,
        waiting: this.#waiting.size,
        approvals: this.#approvals.size,
        parked: this.#waiters.size,
        enqueued: this.#enqueued,
        pulled: this.#pulled,
        logs: this.#logs.length,
        diagnostics: this.#diagnostics,
        states: [...this.#states].map(([sessionId, state]) => ({
          session: short(sessionId),
          // The full id is what a diagnostic needs to drive `/state` or `/phase`
          // by hand; this endpoint is loopback-only and answers the panel's peers.
          id: sessionId,
          phase: this.stateOf(sessionId).phase,
          since: state.since,
        })),
      })
      return
    }

    if (route === '/log' && req.method === 'POST') {
      const read = await readJsonOrRefuse(req, res)
      if (!read.ok) return
      const body = read.body
      const message = typeof body?.message === 'string' ? body.message : '(no message)'
      const entry = { at: Date.now(), message, data: body?.data ?? null }
      this.#logs.push(entry)
      if (this.#logs.length > this.#logLimit) this.#logs.shift()
      this.#logger(`panel: ${message}`)
      send(res, 200, { ok: true, mark: BRIDGE_MARK })
      return
    }

    if (route === '/logs' && req.method === 'GET') {
      send(res, 200, { ok: true, mark: BRIDGE_MARK, logs: this.#logs })
      return
    }

    // TICKET-056: the panel's action strip. A plain read of the host recorder,
    // so it answers even with no tool call in flight. The model has the same
    // data through `browser_timeline`; this route only saves the human from
    // asking. When no recorder was injected (bare bridge) the answer is an
    // empty table instead of an error, so an old panel cannot break the boot.
    if (route === '/timeline' && req.method === 'GET') {
      const rawLimit = Number(url.searchParams.get('limit') ?? 10)
      const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit))) : 10
      const tool = url.searchParams.get('tool') ?? ''
      const failedOnly = url.searchParams.get('failedOnly') === 'true'
      if (this.#timeline === null) {
        send(res, 200, { ok: true, mark: BRIDGE_MARK, total: 0, entries: [] })
        return
      }
      try {
        const entries = this.#timeline.list({
          limit,
          ...(tool === '' ? {} : { tool }),
          failedOnly,
        })
        send(res, 200, { ok: true, mark: BRIDGE_MARK, total: this.#timeline.size, entries })
      } catch (error) {
        send(res, 500, { ok: false, mark: BRIDGE_MARK, error: String(error?.message ?? error) })
      }
      return
    }

    // The settings page (a `settings.section` tab) reads and saves this row's
    // config through the same authenticated channel the panel uses. Saving is the
    // host's business: the adapter hands the patch to the config editor, which
    // validates the candidate and serializes the write.
    if (route === '/config' && req.method === 'GET') {
      if (this.#config === null) {
        send(res, 501, { ok: false, mark: BRIDGE_MARK, error: 'this profile cannot save plugin configuration' })
        return
      }
      try {
        send(res, 200, { ...(await this.#config.read()), ok: true, mark: BRIDGE_MARK })
      } catch (error) {
        send(res, 500, { ok: false, mark: BRIDGE_MARK, error: String(error?.message ?? error) })
      }
      return
    }

    if (route === '/config' && req.method === 'POST') {
      if (this.#config === null) {
        send(res, 501, { ok: false, mark: BRIDGE_MARK, error: 'this profile cannot save plugin configuration' })
        return
      }
      const read = await readJsonOrRefuse(req, res)
      if (!read.ok) return
      const patch = read.body?.patch
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0) {
        send(res, 400, { ok: false, mark: BRIDGE_MARK, error: 'patch must be a non-empty object' })
        return
      }
      try {
        const saved = await this.#config.write(patch)
        this.#logger(`config saved from the settings page: ${Object.keys(patch).join(', ')}`)
        send(res, 200, { ...saved, ok: true, mark: BRIDGE_MARK })
      } catch (error) {
        send(res, 400, { ok: false, mark: BRIDGE_MARK, error: String(error?.message ?? error) })
      }
      return
    }

    // Page-side code the panel needs on its own initiative, not only as part of
    // a command. The host owns these files, so the panel never carries a copy
    // that could drift from what the tools actually run.
    if (route === '/source' && req.method === 'GET') {
      const name = url.searchParams.get('name') ?? ''
      const read = this.#sources[name]
      if (typeof read !== 'function') {
        send(res, 404, { ok: false, mark: BRIDGE_MARK, error: `unknown source: ${name}` })
        return
      }
      try {
        send(res, 200, { ok: true, mark: BRIDGE_MARK, name, source: String(read()) })
      } catch (error) {
        send(res, 500, { ok: false, mark: BRIDGE_MARK, error: String(error?.message ?? error) })
      }
      return
    }

    // Panel reads the phase it should paint, including the reason a page needs
    // a human. Cheap and idempotent, so the badge can refresh without a command.
    if (route === '/state' && req.method === 'GET') {
      const who = url.searchParams.get('session')
      if (who === null || who === '') {
        send(res, 400, { ok: false, mark: BRIDGE_MARK, error: 'session is required' })
        return
      }
      this.#seen.add(who)
      send(res, 200, { ok: true, mark: BRIDGE_MARK, state: this.stateOf(who), page: this.pageOf(who) })
      return
    }

    // The panel is the only writer: only it knows what the user just clicked and
    // what the page looks like now.
    if (route === '/phase' && req.method === 'POST') {
      const read = await readJsonOrRefuse(req, res)
      if (!read.ok) return
      const body = read.body
      const who = typeof body?.session === 'string' ? body.session : ''
      if (who === '') {
        send(res, 400, { ok: false, mark: BRIDGE_MARK, error: 'session is required' })
        return
      }
      this.#seen.add(who)
      this.setPhase(who, String(body?.phase ?? 'idle'), {
        reason: typeof body?.reason === 'string' ? body.reason : '',
        signals: Array.isArray(body?.signals) ? body.signals : [],
        digest: typeof body?.digest === 'string' ? body.digest : undefined,
        since: Number(body?.since),
      })
      send(res, 200, { ok: true, mark: BRIDGE_MARK, state: this.stateOf(who) })
      return
    }

    if (route === '/pending' && req.method === 'GET') {
      const who = url.searchParams.get('session')
      if (who !== null && who !== '') this.#seen.add(who)
      // Long-poll: an idle panel parks its request here instead of asking again
      // every 100 ms, so a command reaches the page with no polling delay.
      this.#lastPollAt = Date.now()
      const waitMs = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) || 0, 0), 5_000)
      let pulled = this.#drain()
      if (pulled.total === 0 && this.#approvals.size === 0 && waitMs > 0) {
        await this.#park(waitMs)
        pulled = this.#drain()
      }
      // Only a returned poll proves a panel is there to show a prompt; the
      // timestamp is what `approve` watches to fail fast on a closed tab.
      this.#lastPollAt = Date.now()
      if (pulled.total > 0) this.#logger(`pull ${pulled.total} by ${short(who ?? '?')}`)
      const states = {}
      for (const [sessionId, state] of this.#states) {
        states[sessionId] = { ...state, phase: this.stateOf(sessionId).phase }
      }
      send(res, 200, {
        ok: true,
        mark: BRIDGE_MARK,
        sessions: pulled.sessions,
        states,
        approvals: this.#approvalFrames(),
      })
      return
    }

    // The panel's answer to a permission prompt. Rejected unless it names a
    // prompt this bridge is actually waiting on, and the answer is dropped for
    // an invisible panel (it cannot prove a human saw the prompt).
    if (route === '/decision' && req.method === 'POST') {
      const read = await readJsonOrRefuse(req, res)
      if (!read.ok) return
      const body = read.body ?? {}
      const id = typeof body.id === 'string' ? body.id : ''
      const who = typeof body.session === 'string' ? body.session : ''
      let owner = ''
      for (const [sessionId, approval] of this.#approvals) {
        if (approval.id !== id) continue
        if (who !== '' && who !== sessionId) continue
        owner = sessionId
        break
      }
      const entry = owner === '' ? undefined : this.#approvals.get(owner)
      if (entry === undefined) {
        send(res, 200, { ok: false, mark: BRIDGE_MARK, error: 'unknown or expired approval' })
        return
      }
      const decision = parseDecision(body.decision, { clientVisible: body.clientVisible !== false })
      if (decision === '') {
        send(res, 400, { ok: false, mark: BRIDGE_MARK, error: `unknown decision: ${String(body.decision)}` })
        return
      }
      this.#finishApproval(owner, entry, decision)
      send(res, 200, { ok: true, mark: BRIDGE_MARK })
      return
    }

    // Where the panel is, so a permission prompt can be scoped to the site.
    if (route === '/page' && req.method === 'POST') {
      const read = await readJsonOrRefuse(req, res)
      if (!read.ok) return
      const body = read.body ?? {}
      const who = typeof body.session === 'string' ? body.session : ''
      if (who === '') {
        send(res, 400, { ok: false, mark: BRIDGE_MARK, error: 'session is required' })
        return
      }
      this.#seen.add(who)
      this.notePage(who, { url: body.url, title: body.title })
      send(res, 200, { ok: true, mark: BRIDGE_MARK, page: this.pageOf(who) })
      return
    }

    if (route === '/settle' && req.method === 'POST') {
      const read = await readJsonOrRefuse(req, res)
      if (!read.ok) return
      const body = read.body
      const id = typeof body?.id === 'string' ? body.id : ''
      const entry = this.#waiting.get(id)
      if (entry === undefined) {
        // The caller already gave up on this command. Answer politely, so a panel
        // that was mid-flight does not log a spurious "unknown command" error.
        if (id !== '' && this.#cancelled.delete(id)) {
          send(res, 200, { ok: true, mark: BRIDGE_MARK, ignored: true })
          return
        }
        send(res, 200, { ok: false, mark: BRIDGE_MARK, error: 'unknown or expired command' })
        return
      }
      if (body.ok === false) {
        entry.reject(panelFailure(body))
      } else {
        entry.resolve(body.result ?? null)
      }
      send(res, 200, { ok: true, mark: BRIDGE_MARK })
      return
    }

    send(res, 404, { ok: false, error: `no route ${route}`, mark: BRIDGE_MARK })
  }
}

/** Only the DSH renderer may drive this queue. */
function isPanelOrigin(origin) {
  if (origin === 'dsh-app://app' || origin === 'null' || origin === '') return true
  return origin.startsWith('http://127.0.0.1:')
}

/** Constant-time token comparison; a length mismatch short-circuits instead of throwing. */
function sameToken(actual, expected) {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** One JSON response for a refused request; never a `WWW-Authenticate` challenge. */
function unauthorized(message) {
  return { ok: false, mark: BRIDGE_MARK, error: { code: 'unauthorized', message } }
}

/**
 * Turn a panel failure report into the error the caller sees.
 *
 * TICKET-013: a failed navigation also reports where it was going and whether
 * the panel managed to go back; carry that into `details` so the tool layer can
 * classify the failure without re-parsing the remote-method wrapper.
 * @param {{error?: unknown, navigation?: unknown}} [body] - the panel's settle body.
 * @returns {Error} an `AgentBrowserError` when the shape is recognised.
 */
function panelFailure(body = {}) {
  const text = String(body?.error ?? 'panel error')
  const failure = fromPanelMessage(text)
  const navigation = body?.navigation
  if (isAgentBrowserError(failure) === false || navigation === null || typeof navigation !== 'object') {
    return failure
  }
  const details = { ...(failure.details ?? {}) }
  if (typeof navigation.url === 'string' && navigation.url !== '') details.url = navigation.url
  if (typeof navigation.previousUrl === 'string' && navigation.previousUrl !== '') {
    details.previousUrl = navigation.previousUrl
  }
  details.restored = navigation.restored === true
  details.raw = text
  return new AgentBrowserError(failure.code, failure.message, {
    cause: failure,
    retryable: failure.retryable,
    details,
  })
}

/** The caller aborted a command before or while the panel was executing it. */
function cancelledError(id = '') {  const which = id === '' ? 'this call' : `${id}`
  return new AgentBrowserError(
    'cancelled',
    `the caller stopped ${which} before the panel finished it. `
    + 'Nothing already sent to the page can be undone, so re-read the page before acting again.',
  )
}

/**
 * The result of a write that the panel already pulled and then stopped reporting.
 *
 * This is the honest middle state (SPEC-004 B4): the command left the queue, so
 * "nothing happened" is no longer provable and the tool card must not invite a
 * retry. `delivered: true` and the original reason stay in `details` so a
 * support run can tell a timeout from a cancel from a takeover.
 * @param {string} type - command type (`click`, `type`, `press`, `eval`).
 * @param {string} reason - what interrupted the wait, in the caller's words.
 * @returns {AgentBrowserError} an `action_unknown` error, never retryable.
 */
function unknownOutcome(type, reason) {
  return new AgentBrowserError(
    'action_unknown',
    `the ${type} command was already pulled by the panel, so the page may have executed it; `
    + `its result was lost (${reason}). Take a browser_snapshot and check the page before deciding; `
    + 'do not resend the same action.',
    { details: { effect: 'unknown', delivered: true, type, reason } },
  )
}

/** One JSON response, with the CORS headers the renderer needs to read it. */
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': `content-type, ${TOKEN_HEADERS}`,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** A request body over `MAX_BODY_BYTES`; answered with a readable refusal, not a broken socket. */
class BodyTooLarge extends Error {
  /** @param {number} size - how much arrived before the cap was hit. */
  constructor(size) {
    super(`the reply was ${size} bytes, over the ${MAX_BODY_BYTES}-byte bridge limit`)
    this.name = 'BodyTooLarge'
  }
}

/** Read a JSON body. */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge(size)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Read a JSON body, answering with `413` when it is over the cap.
 *
 * A refused body used to fall through to the generic `500` handler while the
 * panel was still sending; the panel then logged a settle failure and nothing
 * ever settled the command. Answering 413 with a code the panel can branch on
 * lets it settle with a readable error instead of leaving the tool to time out.
 * @param {import('node:http').IncomingMessage} req - the request to drain.
 * @param {import('node:http').ServerResponse} res - where a refusal is written.
 * @returns {Promise<{ ok: boolean, body?: any }>} `ok: false` when a response was already sent.
 */
async function readJsonOrRefuse(req, res) {
  try {
    return { ok: true, body: await readJson(req) }
  } catch (error) {
    if (!(error instanceof BodyTooLarge)) throw error
    // Let the client finish uploading before the refusal goes out: answering
    // mid-upload would surface as a socket reset instead of a readable 413.
    req.resume()
    send(res, 413, {
      ok: false,
      mark: BRIDGE_MARK,
      error: { code: 'budget_exceeded', message: error.message },
      limit: MAX_BODY_BYTES,
    })
    return { ok: false }
  }
}

/** Short session id for logs. */
export function short(sessionId) {
  const text = String(sessionId ?? '')
  return text.length <= 8 ? text : `${text.slice(0, 8)}…`
}

/** Origin plus path for a log line; query and hash can carry tokens and must stay out. */
function shortUrl(address) {
  const text = String(address ?? '')
  if (text === '') return ''
  try {
    const url = new URL(text)
    return `${url.origin}${url.pathname}`.slice(0, 160)
  } catch {
    return text.slice(0, 160)
  }
}

/** Id for a command nobody asked for yet; exported for tests. */
export function newCommandId() {
  return randomUUID()
}
