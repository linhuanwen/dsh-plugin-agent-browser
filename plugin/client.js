/**
 * Client half of the agent browser plugin.
 *
 * This is the half that owns the `<webview>`: the panel body, the guest
 * lifecycle, and the drain loop that turns host commands into page actions.
 *
 * Three things about this file are unusual and deliberate:
 *
 * 1. It is not ESM. DSH loads a client half through `window.__ModuleLoader__`,
 *    whose `factory(require)` runs once and returns a Cordis plugin object.
 *    `require` only resolves the renderer's shared module table (react, slots,
 *    ...), so the whole client half is one file on purpose.
 * 2. The poll loop lives in `apply`, not in the panel. A tool call can arrive
 *    while no browser tab exists, so something always-mounted has to notice it,
 *    open the tab, and only then let the panel take over.
 * 3. State that must survive a remount (a tab closing and reopening) is kept in
 *    module scope, next to a small subscriber set, rather than in the panel.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-agent-browser',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** The tab kind this plugin registers; the tool name is `browser_open`. */
    const KIND = 'agent-browser'
    /**
     * The tab type identity. This is also the keyed-Slot dispatch key, which is
     * what the pane body is looked up by — it is deliberately not the kind: the
     * official panel uses `kind: 'browser'` but a fully qualified id as its key.
     */
    const ID = 'dsh-plugin-agent-browser'
    /**
     * Bumped by hand so a reloaded client half proves it is the new bundle.
     * The renderer caches `client.js` aggressively, and a stale half looks
     * exactly like a bug in the host half.
     */
    const CLIENT_REV = 56
    /** The panel talks to the host half over loopback; both sides carry this mark. */
    const BRIDGE_PREFIX = '/dsh-agent-browser'
    const BRIDGE_MARK = 'dsh-plugin-agent-browser/1'
    /** Same-origin route the host half publishes its address and token on. */
    const DISCOVERY_PATH = '/agent-browser/discovery'
    /**
     * Where the host half is listening, learned at runtime.
     *
     * A client bundle never sees the loader row (`{ id, inject, immediately }` is
     * all the boot manifest carries) and the port is random per process so two
     * DSH instances cannot collide, so the address has to be discovered. Until
     * that succeeds no call is attempted; a rejected token re-discovers once, so
     * a host reload recovers without a panel reload.
     */
    let bridge = null
    /**
     * Reports produced before discovery finished.
     *
     * The panel starts polling and registers slots before the first discovery
     * round answers, and `report()` used to drop those lines silently — which is
     * exactly the window in which "did the toolview registration run?" has to be
     * answerable. Bounded so a dead host cannot grow the queue forever.
     */
    const pendingReports = []
    const PENDING_REPORT_LIMIT = 50
    /** How long an idle long-poll parks on the host before asking again. */
    const POLL_WAIT_MS = 900
    /** Retry delay after a failed poll. */
    const POLL_MS = 100
    const POLL_HIDDEN_MS = 500
    /**
     * How long a parked command waits for its session's pane to mount.
     *
     * The first command of a session has to open the sidebar tab, create the
     * `<webview>`, wait for `dom-ready` and acquire a lease — measured at
     * 1.0–1.8s on a warm renderer and longer right after an upgrade. Waiting a
     * bit too long only delays the failure message; waiting too little turns a
     * working panel into "the panel is not on screen".
     */
    const MOUNT_GRACE_MS = 5000

    const log = (message) => { console.log(`[agent-browser] ${message}`) }

    /**
     * Ask the host where its bridge is.
     *
     * `/agent-browser/discovery` is a host web-server route behind the DSH
     * connection fence: it answers only to a browser that already holds this
     * deployment's auth cookie. That is true of both shells — a GUI tab is
     * same-origin, and the Electron renderer's non-asset `dsh-app://` requests
     * are forwarded to the host with the cookie attached. The answer is cached
     * for the life of this bundle.
     * @param {boolean} [force] - forget the cache and ask again.
     * @returns {Promise<{ url: string, token: string }>} the bridge endpoint.
     */
    async function resolveBridge(force = false) {
      if (bridge !== null && force !== true) return bridge
      const response = await fetch(DISCOVERY_PATH, { cache: 'no-store', credentials: 'same-origin' })
      if (!response.ok) throw new Error(`discovery -> HTTP ${response.status}`)
      const data = await response.json()
      if (data?.ok !== true || data?.mark !== BRIDGE_MARK) throw new Error('discovery answered by something else')
      const port = Number(data.port)
      const token = String(data.token ?? '')
      if (!Number.isInteger(port) || port <= 0 || token === '') throw new Error('discovery returned no usable address')
      const origin = typeof data.origin === 'string' && data.origin !== '' ? data.origin : `http://127.0.0.1:${port}`
      bridge = { url: `${origin}${BRIDGE_PREFIX}`, token }
      log(`bridge discovered at ${origin}`)
      for (const item of pendingReports.splice(0)) report(item.message, item.data)
      return bridge
    }

    /**
     * Panel-side diagnostics, shipped to the host half.
     *
     * The renderer has no console anyone can read while the app is running, so
     * every interesting step is also POSTed to the bridge, where `curl
     * /dsh-agent-browser/logs` can see it. Reporting must never break the panel,
     * which is why every failure here is swallowed.
     */
    function report(message, data) {
      log(data === undefined ? message : `${message} ${JSON.stringify(data)}`)
      const target = bridge
      if (target === null) {
        if (pendingReports.length < PENDING_REPORT_LIMIT) pendingReports.push({ message, data })
        return
      }
      try {
        void fetch(`${target.url}/log`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
          body: JSON.stringify({ message, data: data ?? null }),
        }).catch(() => {})
      } catch {
        // Reporting is best effort, always.
      }
    }

    // ---------------------------------------------------------------- panel state
    /**
     * Panel-visible state, shared by every mounted body.
     *
     * `phase` mirrors the host's control state (it is the authority: the host is
     * what refuses a tool call). `since` is a host timestamp, so the elapsed
     * clock survives a panel rebuild or a session switch.
     */
    const state = {
      phase: /** @type {'booting'|'idle'|'agent'|'taken_over'|'needs_human'} */ ('booting'),
      since: 0,
      url: '',
      note: 'Starting…',
      commands: 0,
      /** Challenge box to outline, in viewport CSS pixels. */
      detection: /** @type {null | { rect: { x: number, y: number, width: number, height: number }, signals: string[] }} */ (null),
      /**
       * The permission prompt this panel should show, or null.
       *
       * Owned by the host: the panel only draws it and posts the answer. It is
       * here, next to the phase, because both are "what the human must know".
       */
      approval: /** @type {null | { session: string, id: string, origin: string, actionClass: string, summary: string, timeoutMs: number, issuedAt: number }} */ (null),
      digest: '',
    }
    const subscribers = new Set()

    /** Merge a patch into the shared state and repaint every mounted panel. */
    function setState(patch) {
      const changed = Object.keys(patch).some((key) => state[key] !== patch[key])
      Object.assign(state, patch)
      if (!changed) return
      for (const notify of subscribers) notify()
    }

    /** Subscribe one component to the shared state. */
    function usePanelState() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const notify = () => { bump((value) => value + 1) }
        subscribers.add(notify)
        return () => { subscribers.delete(notify) }
      }, [])
      return { ...state }
    }

    // ---------------------------------------------------------------- channel
    /** Commands pulled from the host but not yet executed, per session. */
    const deferred = new Map()
    /** Live panel runners, per session; a mounted body registers itself here. */
    const executors = new Map()
    /**
     * Last address that actually loaded a document, per session (TICKET-013).
     *
     * Kept outside the guest because a failed navigation is exactly the moment
     * the panel gets rebuilt (or the tab is switched away and back): the page a
     * failure should return to must survive that.
     */
    const lastGoodUrls = new Map()
    /**
     * How many tabs one panel may hold (TICKET-050).
     *
     * Each tab is a real `<webview>` with its own lease, and every guest also
     * gets a native input attachment in the host. Six is enough for the cases
     * that motivated tabs (list + detail + one comparison) without turning the
     * panel into a browser manager.
     */
    const MAX_TABS = 6
    /**
     * Zoom per session, kept outside React: a sidebar tab is rebuilt on a session
     * switch (and on `keepMounted` remounts), while the user's chosen zoom is a
     * preference about that page, not about that React instance.
     */
    const zooms = new Map()
    /**
     * Zoom chosen by "fit the page to the panel", per session.
     *
     * Kept apart from `zooms` on purpose: a fit zoom is derived from the current
     * page width, so it must not be mistaken for the user's own choice when the
     * next page happens to be narrow. Manual zoom always wins over a remembered
     * fit zoom.
     */
    const fitZooms = new Map()
    /**
     * Whether a session wants the page fitted to the panel width.
     *
     * Off means "leave the page at 100% and let it scroll sideways", which is
     * what a reader of a desktop-only site may still prefer.
     */
    const fits = new Map()

    /**
     * Commands currently executing, so a cancel frame can stop the one that is
     * in flight. Keyed by command id; cleared in `runCommand`'s `finally`.
     * @type {Map<string, Guest>}
     */
    const running = new Map()

    /**
     * Ids the host cancelled. A finished command consults this before settling,
     * so a cancelled action does not report a result the host has thrown away.
     * Bounded: only a handful of cancels can be pending at once.
     * @type {Set<string>}
     */
    const cancelledIds = new Set()

    /** Remember a cancelled id, retiring the oldest once the set is full. */
    function rememberCancelled(id) {
      cancelledIds.add(id)
      while (cancelledIds.size > 64) {
        const oldest = cancelledIds.values().next().value
        cancelledIds.delete(oldest)
      }
    }

    /** Device rows a stitched screenshot may reach, so one call cannot eat the panel. */
    const MAX_SHOT_ROWS = 16000

    /**
     * Largest settle body this panel will post.
     *
     * The host refuses anything over its own 32 MiB cap with `413`. Staying
     * below it here means an oversized picture is reported as a budget error in
     * a second, instead of being posted, refused, and leaving the tool to sit
     * out its whole command budget (TICKET-034).
     */
    const SETTLE_BUDGET = 24 * 1024 * 1024

    /** One JSON request to the host half. */
    async function callHost(path, init = {}) {
      // A request that never settles would hold the poll loop's `running` flag
      // forever (the renderer can freeze while a window is occluded, and a
      // parked long-poll then has no way to come back). Every call carries its
      // own abort deadline so `finally` always runs and the loop re-arms.
      const target = await resolveBridge()
      const timeoutMs = Number(init.timeoutMs ?? 12_000)
      const { timeoutMs: _ignored, ...rest } = init
      const method = String(rest.method ?? 'GET').toUpperCase()
      // A custom header on a GET would turn every 900ms poll into a preflighted
      // request; safe methods may present the token in the query instead.
      const viaQuery = method === 'GET' || method === 'HEAD'
      const separator = path.includes('?') ? '&' : '?'
      const url = viaQuery ? `${target.url}${path}${separator}token=${encodeURIComponent(target.token)}` : `${target.url}${path}`
      const headers = { ...(rest.headers ?? {}) }
      if (!viaQuery) headers.authorization = `Bearer ${target.token}`
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort() }, timeoutMs)
      try {
        let response
        try {
          response = await fetch(url, {
            cache: 'no-store',
            signal: controller.signal,
            ...rest,
            headers,
          })
        } catch (error) {
          // The host half may have restarted on a new port; ask again next time.
          bridge = null
          throw error
        }
        if (response.status === 401 || response.status === 403) {
          // A stale token: rediscover once before treating this as a real failure.
          bridge = null
          throw new Error(`bridge ${path} -> HTTP ${response.status} (token rejected)`)
        }
        if (!response.ok) {
          // The settings page needs the reason (a 501 "no config editor", a 400
          // "patch must be ..."), not just the status code.
          let detail = ''
          try {
            const body = await response.json()
            if (typeof body?.error === 'string') detail = body.error
          } catch {
            // Not JSON; the status alone has to do.
          }
          const failure = new Error(`bridge ${path} -> HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`)
          failure.status = response.status
          throw failure
        }
        const data = await response.json()
        if (data?.mark !== BRIDGE_MARK) throw new Error(`bridge ${path} answered by something else`)
        return data
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * Long-poll the host for queued commands.
     *
     * The request parks on the host until there is work or `wait` elapses, so an
     * idle panel costs one request per `wait` instead of ten per second, and a
     * command reaches the page with no polling delay at all.
     */
    async function drain(waitMs) {
      const query = `?wait=${waitMs}`
      const data = await callHost(`/pending${query}`, { method: 'GET', timeoutMs: waitMs + 6_000 })
      // The host is the authority on who is driving each session; every poll
      // carries the current phases, so a panel that just mounted (or one whose
      // user took over on another window) converges within one round trip.
      //
      // Except when the panel already knows better: a phase it just set (the
      // detector firing right after a command) can be newer than the one this
      // response was built from, and applying the older one makes the badge
      // flicker back for a beat before the report lands.
      const states = data.states
      if (states !== null && typeof states === 'object') {
        for (const [sessionId, state_] of Object.entries(states)) {
          if (state_ === null || typeof state_ !== 'object') continue
          const since = Number(state_.since ?? 0)
          const local = phases.get(sessionId)
          if (local !== undefined && local.since > since) continue
          setPhaseLocal(sessionId, String(state_.phase ?? 'idle'), since, String(state_.reason ?? ''))
        }
      }
      return { sessions: data.sessions ?? {}, approvals: data.approvals ?? [] }
    }

    /** Report one command's outcome back to the host. */
    async function settle(id, outcome) {
      let text = JSON.stringify({ id, ...outcome })
      // Over budget: say so with numbers instead of posting a body the host will
      // refuse. The tool then fails in a second rather than after its own timeout.
      if (text.length > SETTLE_BUDGET) {
        report('settle over budget', { id, chars: text.length, limit: SETTLE_BUDGET })
        text = JSON.stringify({
          id,
          ok: false,
          error: `budget_exceeded: the panel produced ${text.length} characters, over the ${SETTLE_BUDGET}-character reply budget, so nothing was delivered. `
            + 'Retake a smaller picture (mode "viewport", or a lower maxHeight) or read the page with browser_snapshot.',
        })
      }
      try {
        await callHost('/settle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: text,
        })
        report('settled', { id, ok: outcome.ok !== false })
      } catch (error) {
        const reason = String(error?.message ?? error)
        log(`settle ${id} failed: ${reason}`)
        // A refused or dropped reply must still settle the command: otherwise the
        // host only sees silence and the caller waits out its whole budget. One
        // retry without the payload turns a size problem into a readable error.
        if (outcome?.result === undefined) return
        await callHost('/settle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id,
            ok: false,
            error: `budget_exceeded: the panel produced ${text.length} characters but the host refused the reply (${reason}), so nothing was delivered. `
              + 'Retake a smaller picture (mode "viewport", or a lower maxHeight) or read the page with browser_snapshot.',
          }),
        })
          .then(() => report('settled without payload', { id, chars: text.length }))
          .catch((again) => log(`settle ${id} retry failed: ${String(again?.message ?? again)}`))
      }
    }

    /** Keep a command for this session until a panel mounts. */
    function deferCommand(sessionId, command) {
      const list = deferred.get(sessionId) ?? []
      list.push(command)
      deferred.set(sessionId, list)
    }

    // ------------------------------------------------------------ permissions
    /**
     * Tell the host where this session's panel is.
     *
     * A permission prompt is scoped to a site, and the host cannot read the
     * webview's address itself: the page is the only place that knows it. Failure
     * is silent on purpose — a stale address degrades the prompt's wording, and
     * nothing else.
     */
    async function reportPage(sessionId, page) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      try {
        await callHost('/page', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: sessionId, url: String(page?.url ?? ''), title: String(page?.title ?? '') }),
        })
      } catch (error) {
        report('page report failed', { error: String(error?.message ?? error) })
      }
    }

    /**
     * Answer one permission prompt.
     *
     * `clientVisible` is the honesty bit: a hidden panel cannot claim a human
     * saw the prompt, and the host turns that into `approval_required` instead
     * of treating silence as consent. The local prompt is cleared first so a
     * double click cannot answer twice.
     * @param {string} sessionId - the session that owns the prompt.
     * @param {string} id - the host's prompt id.
     * @param {'once' | 'site' | 'deny' | 'unavailable'} decision - the answer.
     */
    async function answerApproval(sessionId, id, decision) {
      clearApproval(id)
      try {
        await callHost('/decision', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id,
            session: sessionId,
            decision,
            clientVisible: globalThis.document?.visibilityState === 'visible',
          }),
        })
        report('approval answered', { id, decision })
      } catch (error) {
        // The host times the prompt out on its own; a lost answer is not worth
        // retrying (a second answer for the same id would be dropped anyway).
        report('approval answer failed', { id, decision, error: String(error?.message ?? error) })
      }
    }

    /** Forget a prompt locally (answered, expired, or withdrawn by the host). */
    function clearApproval(id) {
      const current = state.approval
      if (current === null || current.id !== id) return
      setState({ approval: null })
    }

    /**
     * Take the prompts the host is waiting on: show the newest, refuse the ones
     * this panel cannot honestly ask about.
     *
     * Refusing is the whole point. A prompt with no panel behind it (that session
     * is not mounted in this window, or the window is hidden) would otherwise sit
     * until the host's 30-second budget expired and the agent would look stuck.
     * @param {Array<object>} frames - `approvals` from one poll response.
     */
    function takeApprovals(frames) {
      if (Array.isArray(frames) === false) return
      const open = new Set()
      for (const frame of frames) {
        if (frame === null || typeof frame !== 'object') continue
        const session = String(frame.session ?? '')
        const id = String(frame.id ?? '')
        if (session === '' || id === '') continue
        open.add(id)
        if (globalThis.document?.visibilityState === 'visible' && executors.has(session)) {
          const shown = state.approval
          if (shown !== null && shown.id === id) continue
          setState({
            approval: {
              session,
              id,
              origin: String(frame.origin ?? ''),
              actionClass: String(frame.actionClass ?? ''),
              summary: String(frame.summary ?? ''),
              timeoutMs: Number(frame.timeoutMs) > 0 ? Number(frame.timeoutMs) : 30_000,
              issuedAt: Number(frame.issuedAt) > 0 ? Number(frame.issuedAt) : Date.now(),
            },
          })
          continue
        }
        report('approval refused locally', { id, session: short(session), visible: globalThis.document?.visibilityState })
        void answerApproval(session, id, 'unavailable')
      }
      const current = state.approval
      if (current !== null && open.has(current.id) === false) clearApproval(current.id)
    }

    /** Answer `deny` for whatever this session is waiting on (takeover path). */
    function denyPendingApproval(sessionId) {
      const current = state.approval
      if (current === null || current.session !== sessionId) return
      void answerApproval(sessionId, current.id, 'deny')
    }

    // ---------------------------------------------------------------- control
    /**
     * Who is driving each session, as last heard from the host.
     *
     * Kept per session rather than in the shared panel state so two chat tabs
     * cannot overwrite each other's badge.
     * @type {Map<string, { phase: string, since: number, reason: string, signals: string[] }>}
     */
    const phases = new Map()

    /**
     * Live guests per session, so a phase change can reach the page-side guard.
     *
     * @type {Map<string, Set<InstanceType<typeof Guest>>>}
     */
    const guestsBySession = new Map()

    /**
     * Injected click guards, fetched once from the host (TICKET-032).
     *
     * `inject/actions.js` installs the same guards, but only when an action
     * command runs. A person who takes over a freshly loaded page clicks before
     * any command, so the panel injects them on load and after every
     * navigation. Fetched from the bridge (`/source?name=guards`) instead of
     * bundled here: the host owns the file, and a copy would drift.
     * @type {string}
     */
    let guardsSourceCache = ''

    /** `dialogs.mode` from the host config, fetched once (`record` / `off`). @type {string} */
    let dialogsModeCache = ''

    /** Command types that can let a page show a JS dialog (TICKET-041). */
    const DIALOG_TYPES = new Set(['open', 'snapshot', 'wait', 'click', 'type', 'press', 'eval'])

    /**
     * Read the configured dialog policy.
     *
     * The guards are fetched as source like every other injected file; the mode
     * comes from the host so a user can turn native dialogs back on without a
     * panel rebuild. Unreadable config means `record`: the safe default.
     * @returns {Promise<'record' | 'off'>} what the guards should do.
     */
    async function dialogsMode() {
      if (dialogsModeCache !== '') return dialogsModeCache === 'off' ? 'off' : 'record'
      try {
        const response = await callHost('/config')
        const mode = String(response?.values?.dialogs?.mode ?? '')
        dialogsModeCache = mode === 'off' ? 'off' : 'record'
      } catch (error) {
        dialogsModeCache = 'record'
      }
      return dialogsModeCache === 'off' ? 'off' : 'record'
    }

    /** Record a control phase for one session and repaint. */
    function setPhaseLocal(sessionId, phase, since, reason = '') {
      const previous = phases.get(sessionId)
      if (previous !== undefined && previous.phase === phase && previous.since === since && previous.reason === reason) return
      phases.set(sessionId, { phase, since, reason })
      // The human drives the page whenever the agent is stopped either because
      // the user took over or because a wall needs them. In those phases a link
      // that wants a new window has to open in this view instead of dying.
      const human = phase === 'taken_over' || phase === 'needs_human'
      for (const guest of guestsBySession.get(sessionId) ?? []) guest.setDriver(human ? 'human' : 'agent')
      report('phase local', { session: short(sessionId), phase, since, reason })
      for (const notify of subscribers) notify()
    }

    /**
     * Tell the host who is driving this session, and mirror it locally.
     *
     * The host owns the phase because it is what gates tool calls; the panel only
     * ever reports a transition the user just made or a page it just met.
     * @param {string} sessionId - which session's panel this is.
     * @param {string} phase - `agent` / `taken_over` / `needs_human` / `idle`.
     * @param {{ reason?: string, signals?: string[], digest?: string, since?: number }} [detail]
     */
    async function reportPhase(sessionId, phase, detail = {}) {
      const since = Number.isFinite(detail.since) ? Number(detail.since) : Date.now()
      setPhaseLocal(sessionId, phase, since, detail.reason ?? '')
      try {
        const data = await callHost('/phase', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: sessionId, phase, since, ...detail }),
        })
        if (data?.state) setPhaseLocal(sessionId, data.state.phase, data.state.since, data.state.reason ?? '')
        report('phase', { to: phase, reason: detail.reason ?? '' })
      } catch (error) {
        report('phase failed', { to: phase, error: String(error?.message ?? error) })
      }
    }

    /**
     * Run the page-side detector and act on it.
     *
     * A hit promotes the session to `needs_human` (unless the user already took
     * over) and remembers the challenge box so the panel can outline it.
     * @param {string} sessionId - which session's panel this is.
     * @param {Guest} guest - the panel's guest.
     * @param {string} source - detector source.
     * @returns {Promise<object|null>} the detector's answer, or null.
     */
    async function detectChallenge(sessionId, guest, source) {
      if (typeof source !== 'string' || source === '') return null
      let detection = null
      try {
        detection = await withTimeout(guest.evaluate(`(${source})({})`), 8_000, 'detector timed out')
      } catch (error) {
        report('detect failed', { error: String(error?.message ?? error) })
        return null
      }
      if (detection === null || typeof detection !== 'object') return null
      const signals = Array.isArray(detection.signals)
        ? detection.signals.map((signal) => `${signal.kind}:${signal.detail}`).slice(0, 8)
        : []
      if (detection.hit === true) {
        const rect = detection.rect && detection.rect.width > 0 ? detection.rect : null
        setState({ detection: { rect, signals } })
        const previous = phases.get(sessionId)
        const current = previous?.phase ?? 'idle'
        if (current !== 'taken_over') {
          await reportPhase(sessionId, 'needs_human', {
            reason: 'human verification on screen',
            signals,
            // Already waiting? Keep the original stamp: the wall has been up
            // since then, and a fresh `since` on every snapshot would make a
            // long wait look like it just started.
            ...(current === 'needs_human' && Number.isFinite(previous?.since) ? { since: previous.since } : {}),
          })
        }
      } else if (state.detection !== null && (phases.get(sessionId)?.phase ?? 'idle') === 'needs_human') {
        // The wall is gone (the user solved it, or the page moved on).
        setState({ detection: null })
        await reportPhase(sessionId, 'idle', { reason: '' })
      } else if (state.detection !== null) {
        setState({ detection: null })
      }
      return detection
    }

    /** What the panel tells the agent when control comes back. */
    function digestOf(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return ''
      const title = typeof snapshot.title === 'string' && snapshot.title !== '' ? snapshot.title : '(untitled)'
      const url = typeof snapshot.url === 'string' ? snapshot.url : ''
      const refs = Number.isInteger(snapshot.refCount) ? snapshot.refCount : 0
      const first = String(snapshot.text ?? '').split('\n').find((line) => line.trim() !== '') ?? ''
      return `${title} · ${url} · ${refs} refs · ${first.trim().slice(0, 120)}`.trim()
    }

    /**
     * Run a `tabs` command: panel bookkeeping, no page is touched.
     *
     * `list` is what the agent calls before any switch; `switch` changes which
     * guest the following commands drive; `close` detaches one guest (and its
     * lease) — the last tab is never removed, a fresh blank one replaces it.
     * Errors carry `tab_not_found: …` / `tab_limit: …` prefixes so the bridge
     * classifies them with `fromPanelMessage`.
     * @param {TabStore} store - the panel's tab store.
     * @param {object} command - the queued command.
     * @returns {Promise<void>}
     */
    async function runTabCommand(store, command) {
      const action = command.params?.action
      const tabId = typeof command.params?.tab === 'string' ? command.params.tab : ''
      report('tabs', { id: command.id, action, tab: tabId })
      if (action !== 'list' && action !== 'switch' && action !== 'close') {
        throw new Error(`unknown tab action "${String(action)}": use list, switch or close`)
      }
      if (action !== 'list' && tabId === '') {
        throw new Error(`tab_not_found: pass the id of the tab to ${action} `
          + '(browser_tabs { action: "list" } shows the ids). Nothing was changed.')
      }
      setState({ commands: state.commands + 1, note: `Agent: tabs ${action}` })
      let result
      if (action === 'list') {
        await store.refreshUrls()
        const view = store.snapshot()
        result = { action, tabs: view.tabs, active: view.active }
      } else if (action === 'switch') {
        const tab = store.activate(tabId)
        if (tab === null) {
          throw new Error(`tab_not_found: there is no tab "${tabId}" in this panel. `
            + 'Call browser_tabs({ action: "list" }) and use an id from that answer.')
        }
        await store.refreshUrls()
        result = { action, tab: tab.id, url: tab.url, title: tab.guest.title(), ...store.snapshot() }
      } else {
        const tab = await store.close(tabId)
        await store.refreshUrls()
        result = { action, closed: tab.id, ...store.snapshot() }
      }
      if (cancelledIds.delete(command.id)) {
        report('cancel dropped result', { id: command.id })
        setState({ note: 'Cancelled' })
        return
      }
      await settle(command.id, { ok: true, result })
      setState({ note: 'Ready', url: store.activeGuest()?.url?.() ?? state.url })
    }

    /** Settle a command the panel could not even start (no tab, tab limit, …). */
    async function failCommand(command, error) {
      const message = String(error?.message ?? error)
      report('command failed before run', { id: command.id, error: message })
      await settle(command.id, { ok: false, error: message })
    }

    /** Run one command against a guest and settle it — unless the host cancelled it. */
    async function runCommand(guest, command, sessionId) {
      report('run', { id: command.id, type: command.type })
      setState({ commands: state.commands + 1, note: `Agent: ${command.type}` })
      // Fit policy travels with every command, so a session that wants 100% keeps
      // it across pages and remounts without the client half asking the host.
      if (command.fit === 'none' || command.fit === 'width') {
        const wanted = command.fit === 'width'
        guest.fitEnabled = wanted
        fits.set(sessionId, wanted)
      }
      running.set(command.id, guest)
      /** A cancelled command reports nothing: the host already rejected the call. */
      const dropped = () => {
        report('cancel dropped result', { id: command.id })
        setState({ note: 'Cancelled' })
      }
      try {
        let result
        if (command.type === 'open') {
          result = await guest.load(command.params?.url)
          let detection = await detectChallenge(sessionId, guest, command.params?.detect)
          // A Turnstile widget mounts after the document settles, so the first
          // look can see the wall's words and still no iframe. The detector
          // answers `pending`, and we look twice more before settling the tool
          // call (TICKET-033: the open call itself must return needs_human).
          for (let look = 0; look < 2 && detection?.pending === true; look += 1) {
            await new Promise((resolve) => setTimeout(resolve, 700))
            detection = await detectChallenge(sessionId, guest, command.params?.detect)
          }
          if (detection?.hit === true) {
            result = {
              ...result,
              needsHuman: true,
              signals: (detection.signals ?? []).map((signal) => `${signal.kind}:${signal.detail}`).slice(0, 8),
            }
          }
        } else if (command.type === 'wait') {
          // TICKET-044: read-only poll; the callback lets a cancel frame stop it
          // between probes instead of after the whole budget.
          result = await guest.wait(command.params, () => cancelledIds.has(command.id))
        } else if (command.type === 'snapshot') {
          result = await guest.snapshot(command.params)
          const detection = await detectChallenge(sessionId, guest, command.params?.detect)
          if (detection !== null) result = { ...result, detection }
          // TICKET-049: the page's own log, drained per snapshot.
          const consoleEntries = await guest.readConsole()
          if (consoleEntries.length > 0) {
            result = result !== null && typeof result === 'object' ? { ...result, console: consoleEntries } : { console: consoleEntries }
          }
        } else if (command.type === 'click') {
          result = await guest.click(command.params)
        } else if (command.type === 'inspect') {
          // Classification for the permission gate: read-only, no input events.
          result = await guest.act('inspect', command.params)
        } else if (command.type === 'scroll') {
          result = await guest.scroll(command.params)
        } else if (command.type === 'hover') {
          result = await guest.hover(command.params)
        } else if (command.type === 'zoom') {
          const params = command.params ?? {}
          let factor = Number.isFinite(params.factor) ? params.factor : Number.NaN
          if (!Number.isFinite(factor)) {
            if (params.reset === true) factor = 1
            else if (Number.isFinite(params.delta)) factor = guest.zoom + params.delta
            else throw new Error('zoom needs factor, delta or reset')
          }
          result = await guest.setZoom(factor)
        } else if (command.type === 'screenshot') {
          result = await guest.screenshot(command.params)
        } else if (command.type === 'type') {
          result = await guest.type(command.params)
        } else if (command.type === 'press') {
          result = await guest.press(command.params)
        } else if (command.type === 'upload') {
          // TICKET-047: the host already read the workspace files and shipped
          // them as base64; the page assembles File objects and fires the same
          // input/change a native picker would.
          result = await guest.act('upload', command.params)
        } else if (command.type === 'eval') {
          result = await guest.eval(command.params)
        } else {
          throw new Error(`unknown command type "${command.type}"`)
        }
        // TICKET-041: the page may have called alert/confirm/prompt while it
        // handled this command; the guards answered conservatively and recorded
        // it. Attach what happened so the tool card can show it.
        if (DIALOG_TYPES.has(command.type) === true) {
          const dialogs = await guest.readDialogs()
          if (dialogs.length > 0) {
            result = result !== null && typeof result === 'object' ? { ...result, dialogs } : { dialogs }
          }
        }
        if (cancelledIds.delete(command.id)) {
          dropped()
          return
        }
        await settle(command.id, { ok: true, result })
        setState({ note: 'Ready', url: guest.url() })
      } catch (error) {
        if (cancelledIds.delete(command.id)) {
          report('cancel dropped error', { id: command.id, error: String(error?.message ?? error) })
          dropped()
          return
        }
        report('run failed', { id: command.id, error: String(error?.message ?? error) })
        // TICKET-013: a failed open also reports where it tried to go and whether
        // the previous page came back; the host classifies the failure from it.
        const navigation = error?.navigation
        await settle(command.id, {
          ok: false,
          error: String(error?.message ?? error),
          ...(navigation === null || typeof navigation !== 'object' ? {} : { navigation }),
        })
        setState({ note: String(error?.message ?? error) })
      } finally {
        running.delete(command.id)
      }
    }

    /**
     * Route one command: to the live panel if this session has one, otherwise
     * park it, open that session's tab, and let the panel pick it up on mount.
     */
    function dispatch(ctx, sessionId, command) {
      // A cancel frame is a control frame, not work: the host already rejected the
      // call, so it is never executed and never settled. Stop what can be stopped
      // (an in-flight navigation) and mark the id so a late result is dropped.
      if (command.type === 'cancel') {
        const target = String(command.params?.target ?? '')
        if (target === '') return
        rememberCancelled(target)
        const guest = running.get(target)
        if (guest !== undefined) {
          try {
            guest.stop()
          } catch (error) {
            report('cancel stop failed', { id: target, error: String(error?.message ?? error) })
          }
        }
        // It may still be parked waiting for a panel to mount; drop it from there
        // too, so the queued command never runs at all.
        for (const [pendingSession, list] of deferred) {
          const at = list.findIndex((queued) => queued.id === target)
          if (at < 0) continue
          list.splice(at, 1)
          if (list.length === 0) deferred.delete(pendingSession)
        }
        report('cancel', { id: target, running: guest !== undefined, session: short(sessionId) })
        return
      }
      let runner = executors.get(sessionId)
      // A runner whose webview is no longer in the document belongs to a panel
      // that was torn down but never announced it: its guest still answers
      // `executeJavaScript`, so commands would half-work (reads succeed, input
      // silently disappears). Drop it and wait for the live panel instead.
      if (runner !== undefined && runner.isLive !== undefined && runner.isLive() === false) {
        report('dispatch dropped stale runner', { session: short(sessionId) })
        executors.delete(sessionId)
        runner = undefined
      }
      report('dispatch', { id: command.id, type: command.type, session: short(sessionId), runner: runner !== undefined, show: command.show ?? 'once' })
      // How much this command is allowed to disturb the layout (see activation.js):
      // `once` = open only if there is no live panel, `always` = bring it forward,
      // `never` = stay out of the way and fail fast when there is nothing to drive.
      const show = command.show === 'always' || command.show === 'never' ? command.show : 'once'
      if (runner !== undefined) {
        if (show === 'always') openTabIn(ctx, sessionId)
        report('dispatch invoke', { id: command.id })
        void runner(command)
        return
      }
      if (show === 'never') {
        report('dispatch refused invisible panel', { id: command.id, type: command.type, session: short(sessionId) })
        void settle(command.id, {
          ok: false,
          error: 'the browser panel is not open, and this plugin is set to activation="manual", so the agent will not open it. '
            + 'Open the right sidebar browser tab for this session, then retry — or change activation to auto.',
        })
        return
      }
      deferCommand(sessionId, command)
      openTabIn(ctx, sessionId)
      // A tab in a session whose sidebar is not on screen never gets a body, so
      // there is nothing to drive. Say so quickly instead of letting the host
      // wait out its whole budget: "visible" is a promise this panel keeps.
      const timer = setTimeout(() => {
        if (executors.has(sessionId)) return
        const list = deferred.get(sessionId) ?? []
        const at = list.findIndex((queued) => queued.id === command.id)
        if (at < 0) return
        list.splice(at, 1)
        if (list.length === 0) deferred.delete(sessionId)
        report('dispatch abandoned', { id: command.id, session: short(sessionId) })
        void settle(command.id, {
          ok: false,
          error: `the browser panel of session ${short(sessionId)} is not on screen, so the page cannot be driven. `
            + 'Open that session and its right sidebar browser tab, then retry.',
        })
      }, MOUNT_GRACE_MS)
      timer.unref?.()
    }

    /** Open this plugin's tab in the given session, bringing the column forward. */
    function openTabIn(ctx, sessionId) {
      const sidebar = ctx.sidebarRight
      let how = 'none'
      try {
        const showing = sidebar?.mounted?.getSnapshot?.()
        if (showing === sessionId) {
          sidebar.openTab(KIND)
          how = 'openTab(same)'
        } else if (typeof sidebar?.openTabIn === 'function') {
          sidebar.openTabIn(sessionId, KIND)
          how = 'openTabIn'
        } else {
          sidebar.openTab(KIND)
          how = 'openTab(fallback)'
        }
      } catch (error) {
        how = `failed: ${error?.message ?? error}`
      }
      report('openTab', { how, showing: short(ctx.sidebarRight?.mounted?.getSnapshot?.() ?? ''), session: short(sessionId) })
      try {
        ctx.layout?.openRightbar?.(true, false)
      } catch (error) {
        report('openRightbar failed', { error: String(error?.message ?? error) })
      }
    }

    /** Long-poll the host forever: cheap, self-throttling, never throws. */
    function startPolling(ctx) {
      let stopped = false
      let running = false
      let failures = 0
      let rounds = 0
      let lastRound = Date.now()
      /** Handle of the queued next round, so `dispose` can cancel it. */
      let next = null
      /**
       * One poll round.
       *
       * Each round re-arms the next one as soon as it finishes: with a parked
       * request, immediate re-arm *is* the low-latency path — without it the
       * only thing calling `pump` is the watchdog, and everything (commands and
       * phase changes alike) then waits out the watchdog interval.
       */
      const pump = async () => {
        if (stopped || running) return
        running = true
        try {
          const hidden = globalThis.document?.visibilityState === 'hidden'
          const pulled = await drain(hidden ? POLL_HIDDEN_MS : POLL_WAIT_MS)
          const sessions = pulled.sessions
          // A permission prompt is a first-class payload of the poll, not a
          // command: it is drawn in the panel and answered from there.
          takeApprovals(pulled.approvals)
          lastRound = Date.now()
          if (failures > 0) report('poll recovered')
          failures = 0
          const ids = Object.keys(sessions)
          if (ids.length > 0) report('poll got work', { sessions: ids.map(short) })
          // Liveness beacon: an idle panel is silent by design, so a missing
          // heartbeat is the only cheap way to tell "nothing to do" from "dead".
          rounds += 1
          if (rounds % 20 === 0) report('poll alive', { rounds })
          for (const [sessionId, commands] of Object.entries(sessions)) {
            for (const command of commands) {
              // One bad command must not kill the poll loop, and its failure has
              // to be visible: a swallowed throw here looks exactly like a panel
              // that never answered.
              try {
                dispatch(ctx, sessionId, command)
              } catch (error) {
                report('dispatch threw', { id: command.id, error: String(error?.message ?? error) })
                void settle(command.id, { ok: false, error: String(error?.message ?? error) })
              }
            }
          }
        } catch (error) {
          failures = Math.min(failures + 1, 4)
          if (failures === 1) report('poll unreachable', { error: String(error?.message ?? error) })
          // Back off while the host is not answering, so a missing bridge is quiet.
          await new Promise((resolve) => {
            setTimeout(resolve, Math.min(POLL_MS * 2 ** failures, 2000))
          })
        } finally {
          running = false
          if (!stopped) next = setTimeout(() => { void pump() }, 0)
        }
      }
      report('poll start')
      void pump()
      // Watchdog: kicks the pump again whenever the previous round stopped
      // coming back, so one dead fetch cannot end polling for good.
      const watchdog = setInterval(() => {
        if (stopped || running) return
        if (Date.now() - lastRound < 4_000) return
        void pump()
      }, 500)
      return () => {
        stopped = true
        clearInterval(watchdog)
        if (next !== null) clearTimeout(next)
      }
    }

    /** Short session id for logs. */
    function short(sessionId) {
      const text = String(sessionId ?? '')
      return text.length <= 8 ? text : `${text.slice(0, 8)}…`
    }

    // ---------------------------------------------------------------- the guest
    /**
     * One `<webview>` bound to one sidebar reservation.
     *
     * The contract with DSH is small: acquire a lease for this workspace, build
     * the element with that lease's `name` and `partition`, attach it, and
     * release the lease when the panel goes away. `src` must be set before the
     * element is attached or the guest is never created — the application checks
     * the lease at attach time, and `about:blank#<lease>` is how the official
     * panel satisfies that check.
     */
    class Guest {
      constructor(sessionId) {
        this.sessionId = sessionId
        this.element = null
        this.reservation = null
        this.bridge = null
        this.detached = false
        this.zoom = 1
        this.canZoom = false
        /** 'manual' once the agent or the user picks a zoom; 'fit' after a fit pass. */
        this.zoomSource = 'manual'
        this.fitEnabled = true
        this.observer = null
        /**
         * Last address the guest reported, as a plain string.
         *
         * `getURL()` may answer with a promise on the desktop bridge, so storing
         * its raw value put `[object Promise]` into the address bar. Events carry
         * a real string; keep the newest one and let sync reads use it.
         */
        this.lastAddress = ''
        /**
         * Who is allowed to have a popup turn into a same-view navigation.
         *
         * The page-side guard reads `window.__dshDriver`: `agent` blocks new
         * windows (a popup would be a window the panel cannot drive), `human`
         * follows the link in this view because a person clicking a product card
         * expects the product page to open. Phases drive it; see setPhaseLocal.
         */
        this.driver = 'agent'
        /**
         * Toolbar hook: called whenever the history position may have moved.
         * @type {null | ((state: { back: boolean, forward: boolean }) => void)}
         */
        this.onHistory = null
        /**
         * Which tab this guest belongs to (TICKET-050), assigned by `TabStore`.
         *
         * The session key is no longer unique for "the page I was on": with two
         * tabs open, a failed navigation in one of them must not roll back to the
         * other tab's last address. `goodUrlKey()` adds this id to the map key.
         */
        this.tabId = ''
        /**
         * Called when the document title changes, so the tab strip can relabel.
         * @type {null | ((title: string) => void)}
         */
        this.onTitle = null
        /** Title as last reported by the guest events; `getTitle()` is unreliable. */
        this.lastTitle = ''
        /**
         * Whether this guest is the tab on screen (set by `TabStore`).
         *
         * Only the visible tab may write the shared panel note/address state or
         * report the page to the host: a hidden tab loading in the background
         * would otherwise put its URL into the approval origin and the address bar.
         * @type {null | (() => boolean)}
         */
        this.isActive = null
        const siblings = guestsBySession.get(sessionId)
        if (siblings === undefined) guestsBySession.set(sessionId, new Set([this]))
        else siblings.add(this)
      }

      /** True unless a TabStore says another tab is on screen. */
      active() {
        return typeof this.isActive === 'function' ? this.isActive() : true
      }

      /** Key for the per-page "last good address" memory; one per tab. */
      goodUrlKey() {
        return this.tabId === '' ? this.sessionId : `${this.sessionId} ${this.tabId}`
      }

      /** Report the current address to the host, but only for the visible tab. */
      reportPageNow() {
        if (this.active()) void reportPage(this.sessionId, { url: this.url() })
      }

      /** Tell the page-side guard who is driving, now and after every navigation. */
      setDriver(mode) {
        const next = mode === 'human' ? 'human' : 'agent'
        if (this.driver === next) return
        this.driver = next
        this.applyDriver()
      }

      /** Re-apply the driver flag to whatever document is current. */
      applyDriver() {
        if (this.element === null || this.detached) return
        const flag = this.driver === 'human' ? 'human' : 'agent'
        void this.evaluate(`window.__dshDriver = ${JSON.stringify(flag)}`).catch(() => undefined)
      }

      /**
       * Install the click guards in the current document (TICKET-032).
       *
       * Guards have to exist before the first human click, and a person can
       * take over a page on which no action command has ever run. The source is
       * fetched once, then injected on every navigation; mode is the driver
       * flag, read by the guard at event time.
       * @returns {Promise<void>}
       */
      async injectGuards() {
        if (this.element === null || this.detached) return
        try {
          if (guardsSourceCache === '') {
            const response = await callHost('/source?name=guards')
            guardsSourceCache = String(response?.source ?? '')
          }
          if (guardsSourceCache === '') return
          const driver = this.driver === 'human' ? 'human' : 'agent'
          const dialogs = await dialogsMode()
          await this.evaluate(`(${guardsSourceCache})(${JSON.stringify(driver)}, ${JSON.stringify({ dialogs })})`)
        } catch (error) {
          // A page without listeners is the old behaviour, not a broken panel:
          // report it and retry on the next navigation.
          report('guards inject failed', { error: String(error?.message ?? error) })
        }
      }

      /**
       * Read and clear the JS dialogs the guards recorded (TICKET-041).
       *
       * Each read drains the list so the agent sees a dialog once; the guards
       * keep the newest 20, and five are enough for a tool card.
       * @returns {Promise<string[]>} `kind: message` lines, newest last.
       */
      async readDialogs() {
        if (this.element === null || this.detached) return []
        try {
          // Return the array itself, not a JSON string: evaluate() already
          // JSON-decodes string results, so stringifying here would be decoded
          // twice and JSON.parse would then fail on the second pass.
          const raw = await this.evaluate('(() => { const list = window.__dshDialogs ?? []; '
            + 'window.__dshDialogs = []; return list.slice(-5) })()')
          const list = Array.isArray(raw) ? raw : []
          return list
            .filter((entry) => entry !== null && typeof entry === 'object')
            .map((entry) => `${String(entry.kind ?? 'dialog')}: ${String(entry.message ?? '')}`)
        } catch (error) {
          return []
        }
      }

      /**
       * Drain the page's console buffer (TICKET-049).
       *
       * The guards wrap `console.*`, `error` and `unhandledrejection` into a
       * bounded array. Draining it on every snapshot keeps the panel's copy small
       * and lets the agent see what the page said since the last look.
       * @returns {Promise<Array<{ level: string, text: string }>>} newest last.
       */
      async readConsole() {
        if (this.element === null || this.detached) return []
        try {
          // Return the array itself: evaluate() JSON-decodes string results.
          const raw = await this.evaluate('(() => { const list = window.__dshConsole ?? []; '
            + 'window.__dshConsole = []; return list.slice(-20) })()')
          const list = Array.isArray(raw) ? raw : []
          return list
            .filter((entry) => entry !== null && typeof entry === 'object')
            .map((entry) => ({
              level: String(entry.level ?? 'log'),
              text: String(entry.text ?? ''),
            }))
        } catch (error) {
          return []
        }
      }

      /**
       * Report where we are in the session history, so the toolbar can enable
       * Back and Forward. A person who took over a page and followed a link
       * needs a way back; without this the panel is a one-way street.
       * @returns {{ back: boolean, forward: boolean }}
       */
      historyState() {
        return { back: this.canGoBack(), forward: this.canGoForward() }
      }

      canGoBack() {
        try {
          return this.element !== null && this.element.canGoBack?.() === true
        } catch {
          return false
        }
      }

      canGoForward() {
        try {
          return this.element !== null && this.element.canGoForward?.() === true
        } catch {
          return false
        }
      }

      /** Go back one history entry and report the new state. */
      async goBack() {
        if (this.element === null) return this.historyState()
        try {
          this.element.goBack?.()
        } catch {
          // Nothing to go back to: the toolbar state below says so.
        }
        return this.historyState()
      }

      /** Go forward one history entry and report the new state. */
      async goForward() {
        if (this.element === null) return this.historyState()
        try {
          this.element.goForward?.()
        } catch {
          // Nothing to go forward to.
        }
        return this.historyState()
      }

      /** Reload the current document without losing the panel. */
      async reloadPage() {
        if (this.element === null) return
        try {
          this.element.reload?.()
        } catch {
          // A reload that throws left the old document in place.
        }
      }

      /** Tell the toolbar what the history looks like now. */
      syncHistory() {
        if (typeof this.onHistory === 'function') this.onHistory(this.historyState())
      }

      /** Acquire the lease, build the element, and wait for `dom-ready`. */
      async mount(container) {
        const carrier = globalThis.dshDesktop
        const bridge = carrier?.protocolVersion === 1 ? carrier.browser : undefined
        if (bridge === undefined) throw new Error('the desktop browser bridge is unavailable')
        if (container === null || container === undefined) throw new Error('no container to mount into')
        report('mount start', { session: short(this.sessionId), carrier: carrier !== undefined })

        const reservation = await bridge.acquire(`agent-browser:${this.sessionId}`)
        report('lease acquired', { partition: reservation?.partition })
        const element = document.createElement('webview')
        this.bridge = bridge
        this.reservation = reservation
        this.element = element
        element.setAttribute('name', reservation.lease)
        element.setAttribute('partition', reservation.partition)
        // Must precede attachment: the guest is created against this address.
        element.setAttribute('src', `about:blank#${reservation.lease}`)
        // Absolute inset-0 against the (positioned) host box: a `<webview>` with
        // `height: 100%` inside a flex item resolves against an indefinite height
        // and silently keeps Electron's 300×150 default — the guest then renders
        // in a 150px-tall viewport while the panel looks 863px tall.
        element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;display:flex'
        container.appendChild(element)

        // Zoom capability is decided once, because it decides what a coordinate
        // means: with a native zoom factor the guest lays itself out in fewer CSS
        // pixels per device pixel, so an input event has to be scaled; without
        // one the element's layout box is enlarged instead and coordinates are
        // already in guest CSS pixels.
        this.canZoom = typeof element.setZoomFactor === 'function'
        report('guest api', {
          setZoomFactor: this.canZoom,
          capturePage: typeof element.capturePage,
          executeJavaScript: typeof element.executeJavaScript,
        })

        element.addEventListener('did-start-loading', () => { if (!this.detached && this.active()) setState({ note: 'Loading…' }) })
        element.addEventListener('did-stop-loading', () => {
          if (!this.detached && this.active()) setState({ note: 'Ready', url: this.url() })
          this.reportPageNow()
          this.applyDriver()
          void this.injectGuards()
          this.syncHistory()
          this.noteTitle(this.title())
        })
        element.addEventListener('did-navigate', (event) => { this.remember(event.url); this.reportPageNow(); this.applyDriver(); void this.injectGuards(); this.syncHistory(); this.noteTitle(this.title()); if (!this.detached && this.active()) setState({ url: this.url() }) })
        element.addEventListener('did-navigate-in-page', (event) => { this.remember(event.url); this.reportPageNow(); this.applyDriver(); void this.injectGuards(); this.syncHistory(); this.noteTitle(this.title()); if (!this.detached && this.active()) setState({ url: this.url() }) })
        element.addEventListener('page-title-updated', (event) => { if (typeof event?.title === 'string' && event.title !== '') this.noteTitle(event.title) })
        element.addEventListener('crashed', () => { setState({ note: 'The page crashed' }) })

        await once(element, 'dom-ready', 20_000)
        report('guest dom-ready', { url: this.url() })
        await this.injectGuards()
        // A zoom chosen earlier for this session outlives the tab it was set on.
        // A manual zoom wins over a remembered fit zoom, so a page the user
        // deliberately enlarged is not silently shrunk again.
        this.fitEnabled = fits.get(this.sessionId) ?? true
        const remembered = zooms.get(this.sessionId) ?? fitZooms.get(this.sessionId)
        if (remembered !== undefined && remembered !== 1) {
          await this.setZoom(remembered, zooms.has(this.sessionId) ? 'manual' : 'fit').catch(() => undefined)
        }
        // The panel can be resized from the app shell at any time; a fitted page
        // has to follow, or it starts scrolling sideways in a narrower sidebar.
        if (typeof ResizeObserver === 'function') {
          let timer = null
          this.observer?.disconnect?.()
          this.observer = new ResizeObserver(() => {
            if (timer !== null) clearTimeout(timer)
            timer = setTimeout(() => {
              timer = null
              if (this.zoomSource === 'fit') void this.fitToWidth({ force: true }).catch(() => undefined)
            }, 350)
          })
          this.observer.observe(element)
        }
        setState({ note: 'Ready', url: this.url() })
        // A brand-new guest has no frame to copy until it paints one, and
        // `capturePage` waits for exactly that. Asking once here means the very
        // first snapshot after the panel appears has a picture to show.
        void element.capturePage?.().catch(() => undefined)
      }

      /** Current guest URL, or the empty string before the first navigation. */
      url() {
        // The cheapest guarantee the tab strip can rely on: a string or ''.
        return typeof this.lastAddress === 'string' ? this.lastAddress : ''
      }

      /** Record an address the guest events reported, ignoring non-strings. */
      remember(address) {
        if (typeof address === 'string' && address !== '') this.lastAddress = address
      }

      /**
       * The guest's address as a plain string, and safe to compare.
       *
       * `getURL()` is not guaranteed to answer with a string (the desktop bridge
       * may hand back a URL object, or a promise for one), and `startsWith` on
       * whatever it returns is how TICKET-013's rollback first broke in装机.
       * Everything that compares addresses goes through here.
       * @returns {Promise<string>} the address, or '' when it cannot be read.
       */
      async address() {
        try {
          const value = await this.element?.getURL?.()
          const address = typeof value === 'string'
            ? value
            : value !== null && typeof value === 'object' && typeof value.href === 'string' ? value.href : ''
          this.remember(address)
          return address
        } catch {
          return ''
        }
      }

      /**
       * Best-effort stop for a cancelled command.
       *
       * This can abort a navigation that is still loading; it cannot take back a
       * click that already landed. That asymmetry is why the agent is told, in the
       * error text, to re-read the page before acting again.
       */
      stop() {
        try {
          this.element?.stop?.()
        } catch {
          // A torn-down guest has nothing to stop; the cancel frame is still
          // recorded, so its late result is dropped either way.
        }
      }

      /** Device-independent pixels per guest CSS pixel: 1 unless zoom is native. */
      dipScale() {
        return this.canZoom ? this.zoom : 1
      }

      /**
       * Scale the page inside the panel, and say what the page now believes.
       *
       * The sidebar has a fixed width, so a site laid out for 1000+ CSS pixels
       * either overflows or collapses into a phone layout. With a native zoom
       * factor the guest lays itself out in more CSS pixels per device pixel —
       * the desktop layout fits — and input coordinates must be scaled back to
       * device pixels. Without one the element's layout box is enlarged and the
       * compositor shrinks the result; coordinates then stay in guest pixels.
       */
      async setZoom(factor, source = 'manual') {
        const element = this.element
        if (element === null) throw new Error('the browser panel is not mounted')
        const wanted = Math.min(3, Math.max(0.25, Math.round(Number(factor) * 100) / 100))
        if (!Number.isFinite(wanted)) throw new Error('zoom must be a number')
        if (this.canZoom) {
          element.setZoomFactor(wanted)
        } else {
          element.style.transformOrigin = '0 0'
          element.style.transform = wanted === 1 ? '' : `scale(${wanted})`
          element.style.width = wanted === 1 ? '100%' : `${100 / wanted}%`
          element.style.height = wanted === 1 ? '100%' : `${100 / wanted}%`
        }
        this.zoom = wanted
        this.zoomSource = source
        if (source === 'fit') {
          fitZooms.set(this.sessionId, wanted)
          zooms.delete(this.sessionId)
        } else {
          zooms.set(this.sessionId, wanted)
          fitZooms.delete(this.sessionId)
        }
        const viewport = await this.evaluate(
          '({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })',
        ).catch(() => null)
        report('zoom', { factor: wanted, mode: this.canZoom ? 'native' : 'transform', source, viewport })
        return {
          ok: true,
          zoom: wanted,
          mode: this.canZoom ? 'native' : 'transform',
          width: viewport?.width ?? null,
          height: viewport?.height ?? null,
        }
      }

      /**
       * Shrink the page until its layout fits the panel width.
       *
       * A sidebar panel is ~600 CSS px wide while most government and commerce
       * sites are laid out for 1000+; at 100% the page then scrolls sideways and
       * a screenshot shows one slice of the layout. A native zoom factor is the
       * honest fix: the guest lays itself out in more CSS pixels, so the desktop
       * layout fits in the box and a capture shows all of it.
       *
       * Measured, not guessed: `scrollWidth` depends on the zoom it was measured
       * at (the page reflows), so this converges in a few passes, each one
       * shrinking by the ratio that is actually over. Never zooms *in* — a
       * narrow page keeps its 100%.
       */
      async fitToWidth(options = {}) {
        const element = this.element
        if (element === null || this.fitEnabled === false) return null
        const panel = element.getBoundingClientRect().width
        if (!(panel > 0)) return null
        const measure = () => this.evaluate(
          '({ w: window.innerWidth, sw: document.documentElement.scrollWidth,'
          + ' sh: document.documentElement.scrollHeight, x: window.scrollX, y: window.scrollY })',
        ).catch(() => null)
        let before = await measure()
        if (before === null) return null
        const started = this.zoom
        const trail = []
        for (let round = 0; round < 4; round += 1) {
          if (before.sw <= before.w + 2) break
          // Floor, not round: rounding can land a pixel or two *over* the target
          // and the loop then makes no progress (a page with a 1000px minimum
          // width is the common case). Slightly too small always fits.
          const wanted = Math.max(0.25, Math.min(1, Math.floor(this.zoom * (before.w / before.sw) * 100) / 100))
          if (Math.abs(wanted - this.zoom) < 0.005) break
          trail.push({ from: this.zoom, to: wanted, sw: before.sw, w: before.w })
          await this.setZoom(wanted, 'fit').catch(() => undefined)
          before = await measure()
          if (before === null) break
        }
        const changed = this.zoom !== started
        report('fit width', {
          panel: Math.round(panel),
          zoom: this.zoom,
          changed,
          fits: before === null ? null : before.sw <= before.w + 2,
          passes: trail.length,
          force: options.force === true,
        })
        return { zoom: this.zoom, changed, passes: trail.length }
      }

      /**
       * `loadURL` resolves when the navigation is committed, not when the first
       * frame is on screen; `capturePage` blocks until there is a frame to copy,
       * so opening and then immediately snapshotting used to hang for seconds.
       * Waiting for `did-stop-loading` here fixes both problems at the source.
       */
      async load(url) {
        if (typeof url !== 'string' || url === '') throw new Error('url is required')
        const element = this.element
        if (element === null) throw new Error('the browser panel is not mounted')
        const previous = lastGoodUrls.get(this.goodUrlKey()) ?? ''
        setState({ phase: 'loading', note: 'Loading…', url })
        const stopped = once(element, 'did-stop-loading', 25_000)
        try {
          await element.loadURL(url)
        } catch (error) {
          // TICKET-013: a failed navigation does not just raise — it takes the
          // guest with it. Chromium swaps the document for its internal error
          // page, so the page the user was looking at is gone and every later
          // read works on an empty tree. Put the previous address back before
          // reporting, and say which of the two happened.
          const raw = String(error?.message ?? error)
          const navigation = { url, previousUrl: previous, restored: false, raw }
          if (previous !== '' && previous !== url) {
            report('navigation failed; going back', { url, previous })
            try {
              const back = once(element, 'did-stop-loading', 15_000)
              await element.loadURL(previous)
              await back.catch(() => undefined)
              const now = await this.address()
              navigation.restored = now !== '' && now.startsWith('chrome-error://') === false
              if (navigation.restored) lastGoodUrls.set(this.goodUrlKey(), previous)
            } catch (rollbackError) {
              report('navigation rollback failed', { error: String(rollbackError?.message ?? rollbackError) })
            }
          }
          setState({
            phase: 'idle',
            note: navigation.restored ? 'Back on the previous page' : 'Navigation failed',
            url: await this.address(),
          })
          const failure = new Error(`navigation_failed: ${raw}`)
          failure.navigation = navigation
          throw failure
        }
        await stopped.catch(() => undefined)
        const landed = await this.address()
        if (landed !== '' && landed.startsWith('chrome-error://') === false) {
          lastGoodUrls.set(this.goodUrlKey(), landed)
        }
        // Fit after the load, not before: the width of the new page is only known
        // once it has laid out, and a fit zoom from the previous page would be
        // wrong here anyway.
        const fit = await this.fitToWidth().catch(() => null)
        // Late layout is the normal case, not the exception: fonts, images and
        // JS-rendered columns arrive after `did-stop-loading` and widen the page
        // under the zoom we just chose. One more pass a moment later catches it,
        // but only while the zoom is still ours to change (a manual zoom wins).
        if (this.zoomSource === 'fit') {
          setTimeout(() => {
            if (this.zoomSource === 'fit') void this.fitToWidth().catch(() => undefined)
          }, 600)?.unref?.()
        }
        const address = await this.address()
        this.noteTitle(this.title())
        setState({ url: address, phase: 'idle', note: 'Ready' })
        return { url: address, title: this.title(), ...(fit === null ? {} : { fit: fit.zoom }) }
      }

      /** Guest document title, best effort: the element's answer, else the last event. */
      title() {
        try {
          const value = this.element?.getTitle?.() ?? ''
          if (typeof value === 'string' && value !== '') return value
        } catch {
          // Fall back to the title the events reported.
        }
        return this.lastTitle
      }

      /** Remember a title the guest reported and tell the tab strip (TICKET-050). */
      noteTitle(title) {
        const blank = typeof title === 'string' && title.startsWith('about:blank')
        if (typeof title !== 'string' || title === '' || blank || title === this.lastTitle) return
        this.lastTitle = title
        if (typeof this.onTitle === 'function') this.onTitle(title)
      }

      /** Run source inside the guest and return what it produced, JSON-decoded. */
      async evaluate(source) {
        const element = this.element
        if (element === null) throw new Error('the browser panel is not mounted')
        const raw = await element.executeJavaScript(source, true)
        if (typeof raw !== 'string') return raw
        try {
          return JSON.parse(raw)
        } catch {
          return raw
        }
      }

      /**
       * TICKET-013: refuse to work on chromium's internal error page.
       *
       * It has no title and no document, so a snapshot there returns an empty
       * tree that looks like a real (but empty) page — the exact setup for a
       * chain of "element not found". Say what happened instead.
       * @param {string} what - the operation being refused, for the message.
       * @returns {Promise<Error | null>} the failure to throw, or null when a document is loaded.
       */
      async errorPageFailure(what) {
        const current = await this.address()
        if (current.startsWith('chrome-error://') === false) return null
        return new Error(
          `navigation_failed: the browser panel is showing its own error page (${current}) instead of a document, `
          + `so ${what} cannot run. Open a reachable address (or the previous page) first.`,
        )
      }

      /**
       * Read the page as an accessibility tree, plus a picture of the panel.
       *
       * The traversal source arrives with the command: the host owns it, the
       * page runs it, and nothing about the tree has to be parsed twice.
       */
      async snapshot(params) {
        const parked = await this.errorPageFailure('reading the page')
        if (parked !== null) throw parked
        const source = typeof params?.source === 'string' ? params.source : ''
        if (source === '') throw new Error('the snapshot source was not delivered')
        const maxChars = Number.isFinite(params?.maxChars) ? params.maxChars : 8000
        const cursor = typeof params?.cursor === 'string' ? params.cursor : ''
        report('snapshot start', { sourceChars: source.length, maxChars, cursor: cursor !== '' })
        // The source is an expression function declaration; call it with our options.
        const tree = await withTimeout(
          this.evaluate(`(${source}\n)(${JSON.stringify({ maxChars, cursor })})`),
          15_000,
          'the page did not answer the tree query',
        )
        if (tree === null || typeof tree !== 'object') throw new Error('the page returned no tree')
        report('snapshot evaluated', { gen: tree.gen, nodes: tree.nodeCount, refs: tree.refCount, ms: tree.ms })
        const result = { ...tree }
        // A continuation already has the reader oriented, so it does not spend a
        // screenshot on the next slice unless the caller explicitly asks.
        const wantImage = params?.includeImage === true || (params?.includeImage !== false && cursor === '')
        if (wantImage) {
          try {
            result.image = await this.capture(768)
          } catch (error) {
            report('capture failed', { error: String(error?.message ?? error) })
          }
        }
        return result
      }

      /**
       * Run one of the page-side action helpers (`inject/actions.js`).
       *
       * The host ships the source with every command, for the same reason the
       * snapshot source is shipped: the file on disk is the only copy of truth,
       * and the client half cannot read from disk.
       */
      async act(op, params) {
        const parked = await this.errorPageFailure(`${op}ing the page`)
        if (parked !== null) throw parked
        const source = typeof params?.source === 'string' ? params.source : ''
        if (source === '') throw new Error('the action source was not delivered')
        const args = {
          ref: params?.ref,
          loc: params?.loc,
          selector: params?.selector,
          strict: params?.strict,
          text: params?.text,
          clear: params?.clear,
          dy: params?.dy,
          to: params?.to,
          container: params?.container,
          files: params?.files,
        }
        return this.evaluate(`(${source}\n)(${JSON.stringify(op)}, ${JSON.stringify(args)})`)
      }

      /**
       * Click by ref, or at a viewport coordinate.
       *
       * A ref is resolved and scrolled into view inside the page, then the
       * click itself is a real `sendInputEvent` — trusted input, hit-tested by
       * Chromium, which is the only way to reach canvas and cross-origin frames.
       */
      async click(params) {
        if (Number.isFinite(params?.x) && Number.isFinite(params?.y)) {
          const point = { x: Math.round(params.x), y: Math.round(params.y) }
          await this.clickAt(point.x, point.y)
          return { ok: true, x: point.x, y: point.y, info: { tag: 'coordinate', role: 'point', name: '' } }
        }
        const action = await this.act('click', params)
        if (action === null || typeof action !== 'object') throw new Error('the page returned no answer')
        if (action.ok !== true) return action
        const point = action.point ?? { x: 0, y: 0 }
        // A click that had to rewrite a target, or that happened right after a
        // blocked popup, was expected to take us somewhere. If the address stays
        // put, the click landed on some inner control instead of the link —
        // exactly what a card overlay does — and the model must be told, not
        // handed a cheerful "Clicked link".
        const expected = (typeof action.targetFixed === 'string' && action.targetFixed !== '')
          || (Array.isArray(action.blockedNewWindow) && action.blockedNewWindow.length > 0)
        const before = expected ? await this.url() : ''
        await this.clickAt(point.x, point.y)
        let navigated
        if (expected) {
          await new Promise((resolve) => setTimeout(resolve, 350))
          try {
            navigated = (await this.url()) !== before
          } catch {
            navigated = undefined
          }
        }
        return {
          ok: true,
          x: point.x,
          y: point.y,
          info: action.info,
          matched: action.matched,
          targetFixed: action.targetFixed,
          blockedNewWindow: action.blockedNewWindow,
          ...(typeof action.looksDisabled === 'string' && action.looksDisabled !== ''
            ? { looksDisabled: action.looksDisabled }
            : {}),
          ...(typeof navigated === 'boolean' ? { navigated } : {}),
        }
      }

      /** The guest's current address, or '' when the page cannot be asked. */
      async url() {
        try {
          return String(await this.evaluate('location.href'))
        } catch {
          return ''
        }
      }

      /**
       * Move the pointer over a ref/selector without pressing anything.
       *
       * Some controls are only reachable after `mouseover` (stacked 3D cards fan
       * out, menus open). The move is a real input event, so the page reacts the
       * way it would to a human hovering — unlike `element.click()`.
       */
      async hover(params) {
        let point = null
        let first = null
        if (Number.isFinite(params?.x) && Number.isFinite(params?.y)) {
          point = { x: Math.round(params.x), y: Math.round(params.y) }
        } else {
          first = await this.act('hover', params)
          if (first === null || typeof first !== 'object') throw new Error('the page returned no answer')
          if (first.ok !== true) return first
          point = first.point ?? { x: 0, y: 0 }
        }
        await this.moveTo(point.x, point.y)
        const waitMs = Number.isFinite(params?.waitMs) ? Math.min(2000, Math.max(0, params.waitMs)) : 150
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        // Re-resolve the same target and compare: a stacked control that fanned
        // out reports a different point (or a taller page) than it did before the
        // move. Comparing only width/height missed cards that shift sideways.
        let grew = false
        let info = first?.info
        if (first !== null && !Number.isFinite(params?.x)) {
          const second = await this.act('hover', params)
          if (second?.ok === true) {
            const a = first.point ?? {}
            const b = second.point ?? {}
            grew = Math.abs((b.x ?? 0) - (a.x ?? 0)) > 1
              || Math.abs((b.y ?? 0) - (a.y ?? 0)) > 1
              || (second.pageHeight ?? 0) !== (first.pageHeight ?? 0)
              || (second.layout ?? '') !== (first.layout ?? '')
            info = second.info ?? info
          }
        }
        const under = '((x, y) => {'
          + ' const el = document.elementFromPoint(x, y);'
          + ' if (!el) return null;'
          + ' const label = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 60);'
          + ' return { tag: el.tagName.toLowerCase(), role: (el.getAttribute("role") || "").trim(), name: label };'
          + '})(' + point.x + ', ' + point.y + ')'
        const hit = await this.evaluate(under)
        if (hit && typeof hit === 'object' && hit.tag) info = hit
        report('hover', { x: point.x, y: point.y, waitMs: waitMs, grew: grew })
        return {
          ok: true,
          x: point.x,
          y: point.y,
          info,
          grew,
          matched: first?.matched,
        }
      }

      /** Send one left-button click at a viewport coordinate. */
      async clickAt(x, y) {
        const element = this.element
        if (element === null) throw new Error('the browser panel is not mounted')
        const started = Date.now()
        await this.moveTo(x, y)
        const focused = Date.now()
        const scale = this.dipScale()
        const base = { x: Math.round(x * scale), y: Math.round(y * scale) }
        element.sendInputEvent({ type: 'mouseDown', ...base, button: 'left', clickCount: 1 })
        element.sendInputEvent({ type: 'mouseUp', ...base, button: 'left', clickCount: 1 })
        report('click timing', { focus: focused - started, events: Date.now() - focused })
      }

      /** Move the pointer to a viewport coordinate without pressing a button. */
      async moveTo(x, y) {
        const element = this.element
        if (element === null) throw new Error('the browser panel is not mounted')
        try {
          element.focus()
        } catch {
          // Focus is a hint, not a requirement.
        }
        const scale = this.dipScale()
        element.sendInputEvent({ type: 'mouseMove', x: Math.round(x * scale), y: Math.round(y * scale) })
      }

      /**
       * Scroll the page (or one container) and report where it landed.
       *
       * Lazy lists only ask for the next screen after a real scroll event, and
       * the rows they insert need a frame to exist, so the numbers are read again
       * after a short wait instead of being trusted from the scroll call itself.
       */
      async scroll(params) {
        const action = await this.act('scroll', params)
        if (action === null || typeof action !== 'object') throw new Error('the page returned no answer')
        if (action.ok !== true) return action
        const waitMs = Number.isFinite(params?.waitMs) ? Math.min(2000, Math.max(0, params.waitMs)) : 150
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        const selector = typeof params?.container === 'string' ? params.container : ''
        const measure = '((selector) => {'
          + ' const box = selector ? document.querySelector(selector) : (document.scrollingElement || document.documentElement);'
          + ' if (!box) return null;'
          + ' const viewport = selector ? box.clientHeight : window.innerHeight;'
          + ' const max = Math.max(0, (box.scrollHeight || 0) - viewport);'
          + ' const y = box.scrollTop || 0;'
          + ' return { x: Math.round(box.scrollLeft || 0), y: Math.round(y), scrollHeight: Math.round(box.scrollHeight || 0), viewportHeight: Math.round(viewport), atBottom: y >= max - 1 };'
          + '})(' + JSON.stringify(selector) + ')'
        const after = await this.evaluate(measure)
        if (after === null || typeof after !== 'object') return action
        report('scroll', { waitMs: waitMs, y: after.y, atBottom: after.atBottom })
        return { ...action, ...after }
      }

      /**
       * Type into a ref.
       *
       * The page half refuses password fields before touching them, so a
       * credential can never end up in the transcript.
       */
      async type(params) {
        const action = await this.act('type', params)
        if (action === null || typeof action !== 'object') throw new Error('the page returned no answer')
        if (action.ok !== true) return action
        const submitted = params?.submit === true
        if (submitted) await this.tap({ keyCode: 'Enter', modifiers: [] })
        return {
          ok: true,
          info: action.info,
          length: action.length ?? 0,
          inserted: action.inserted === true,
          submitted,
        }
      }

      /** Press one key, with optional modifiers (`Alt+Left`, `Control+R`). */
      async press(params) {
        const chord = parseChord(params?.key)
        if (chord === null) return { ok: false, error: 'bad_key', key: String(params?.key ?? '') }
        const navigation = navigationCommand(chord)
        report('press', { key: String(params?.key ?? ''), keyCode: chord.keyCode, modifiers: chord.modifiers, handled: navigation })
        if (navigation !== null) {
          const moved = await this.navigate(navigation)
          return {
            ok: true,
            key: String(params?.key ?? ''),
            keyCode: chord.keyCode,
            modifiers: chord.modifiers,
            handled: navigation,
            from: moved.from,
            to: moved.to,
          }
        }
        await this.tap(chord)
        return { ok: true, key: String(params?.key ?? ''), keyCode: chord.keyCode, modifiers: chord.modifiers }
      }

      /**
       * Do a browser-level navigation.
       *
       * The guest has no browser chrome, so Chromium never sees `Alt+Left` or
       * `F5` as a shortcut — those keys only reach the page. Doing the
       * navigation through the webview keeps the command honest instead of
       * pretending a key press worked.
       */
      async navigate(op) {
        const element = this.element
        if (element === null) throw new Error('the browser panel is not mounted')
        const from = this.url()
        const stopped = once(element, 'did-stop-loading', 8_000)
        if (op === 'back') element.goBack()
        else if (op === 'forward') element.goForward()
        else element.reload()
        await stopped.catch(() => undefined)
        return { from, to: this.url() }
      }

      /** Send one key press as real input events. */
      async tap(chord) {
        const element = this.element
        if (element === null) throw new Error('the browser panel is not mounted')
        try {
          element.focus()
        } catch {
          // Focus is a hint, not a requirement.
        }
        const base = { keyCode: chord.keyCode, modifiers: chord.modifiers }
        const wantsChar = chord.keyCode.length === 1 || chord.keyCode === 'Enter' || chord.keyCode === 'Space'
        element.sendInputEvent({ type: 'keyDown', ...base })
        if (wantsChar) element.sendInputEvent({ type: 'char', ...base })
        element.sendInputEvent({ type: 'keyUp', ...base })
      }

      /**
       * Evaluate a script in the page and return its JSON value.
       *
       * The script is wrapped so that `document.title` and a full statement
       * block both work, and so that an exception comes back as data instead of
       * as an opaque rejection.
       */
      async eval(params) {
        const script = typeof params?.script === 'string' ? params.script : ''
        if (script === '') throw new Error('script is required')
        const maxChars = Number.isFinite(params?.maxChars) ? Math.trunc(params.maxChars) : 8000
        const awaitPromise = params?.awaitPromise !== false
        const source = `(async () => {
          const out = { ok: true, value: null, serialized: '', truncated: false, pending: false, error: null }
          let value
          try {
            value = eval(${JSON.stringify(script)})
            if (${awaitPromise} && value && typeof value.then === 'function') value = await value
            else if (!${awaitPromise} && value && typeof value.then === 'function') out.pending = true
          } catch (error) {
            out.ok = false
            out.error = String((error && error.message) || error)
            return out
          }
          let text
          try {
            text = JSON.stringify(value)
          } catch (error) {
            text = String(value)
          }
          if (typeof text !== 'string') text = String(value)
          if (text.length > ${maxChars}) {
            text = text.slice(0, ${maxChars})
            out.truncated = true
          }
          out.value = value === undefined ? null : null
          out.serialized = text
          return out
        })()`
        const out = await withTimeout(this.evaluate(source), 15_000, 'the page did not finish evaluating')
        return out
      }

      /**
       * Poll the page until a selector/text condition holds or the budget ends.
       *
       * The probe runs in the page (`inject/wait.js`), the loop runs here. That
       * split is deliberate (TICKET-044): a cancel frame can stop the wait
       * between probes, and a page that hangs a timer cannot trap the command in
       * one long-running promise. Read-only; it never touches the page.
       * @param {{selector?: string, text?: string, gone?: boolean, timeoutMs?: number, source?: string, intervalMs?: number}} params
       * @param {() => boolean} [isCancelled] - checked between probes.
       * @returns {Promise<object>} { ok, matched, found, gone, waitedMs, ticks, timedOut?, cancelled?, url? }
       */
      async wait(params, isCancelled) {
        const source = typeof params?.source === 'string' ? params.source : ''
        if (source === '') throw new Error('wait needs its page-side probe source')
        const timeoutMs = Number.isFinite(params?.timeoutMs) ? Math.max(100, params.timeoutMs) : 10_000
        const intervalMs = Number.isFinite(params?.intervalMs) ? Math.max(50, params.intervalMs) : 150
        const probeInput = JSON.stringify({
          selector: typeof params?.selector === 'string' ? params.selector : '',
          text: typeof params?.text === 'string' ? params.text : '',
          gone: params?.gone === true,
        })
        const started = Date.now()
        let ticks = 0
        for (;;) {
          const probe = await this.evaluate(`(${source})(${probeInput})`)
          ticks += 1
          if (probe?.invalid === true) throw new Error('wait needs a selector or text to look for')
          const waitedMs = Date.now() - started
          if (probe?.matched === true) {
            return { ok: true, matched: true, found: probe.found === true, visible: probe.visible === true, gone: probe.gone === true, waitedMs, ticks, url: this.url() }
          }
          if (isCancelled !== undefined && isCancelled() === true) {
            return { ok: true, cancelled: true, matched: false, found: probe?.found === true, visible: probe?.visible === true, gone: probe?.gone === true, waitedMs, ticks, url: this.url() }
          }
          if (waitedMs >= timeoutMs) {
            return { ok: true, matched: false, timedOut: true, found: probe?.found === true, visible: probe?.visible === true, gone: probe?.gone === true, waitedMs, ticks, url: this.url() }
          }
          await new Promise((resolve) => setTimeout(resolve, intervalMs))
        }
      }

      /**
       * Capture the panel as a PNG data URL.
       *
       * `capturePage` measures device pixels, so the scale between them and CSS
       * pixels is derived from the element box; the image is then kept at or
       * below `maxWidth` CSS pixels so one snapshot costs a predictable slice of
       * the vision budget.
       */
      async capture(maxWidth) {
        const element = this.element
        if (element === null) throw new Error('the browser panel is not mounted')
        if (typeof element.capturePage !== 'function') throw new Error('this build cannot capture the panel')
        report('capture start', { css: Math.round(element.getBoundingClientRect().width) })
        let image
        try {
          image = await withTimeout(this.capturePainted(element), 10_000, 'capturePage did not return')
        } catch (error) {
          // The outer budget can fire before the inner retries give up; either way
          // the caller gets the same actionable sentence instead of IPC wording.
          if (String(error?.message ?? '').includes('capturePage did not return')) {
            throw new Error('the browser panel produced no picture within 10s: the page had not painted yet, or the panel is not visible on screen. Bring the DSH window and the browser panel into view, then retry the screenshot.')
          }
          throw error
        }
        if (image === null || image === undefined) throw new Error('the page produced no image')
        if (typeof image.isEmpty === 'function' && image.isEmpty()) throw new Error('the page produced no image')
        const rect = element.getBoundingClientRect()
        const size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 }
        report('capture got image', { device: size.width, height: size.height, resize: typeof image.resize })
        const ratio = rect.width > 0 && size.width > 0 ? size.width / rect.width : 1
        const target = Math.min(size.width, Math.round((maxWidth ?? 768) * ratio))
        const scaled = size.width > target && typeof image.resize === 'function'
          ? image.resize({ width: target })
          : image
        const url = scaled.toDataURL()
        report('capture done', { sent: target, chars: typeof url === 'string' ? url.length : -1 })
        return url
      }

      /**
       * One screenshot frame as decoded RGBA rows, for stitching.
       *
       * The width is pinned to 768 so every frame lines up regardless of the
       * device pixel ratio; the height follows from the aspect ratio.
       */
      async captureFrame(element) {
        const image = await this.capturePainted(element)
        const size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 }
        if (!(size.width > 0) || !(size.height > 0)) throw new Error('the panel captured an empty frame')
        const scaled = size.width > 768 && typeof image.resize === 'function' ? image.resize({ width: 768 }) : image
        return await pngToRgba(scaled.toDataURL())
      }

      /**
       * Grab frames until the guest has actually painted one.
       *
       * `capturePage` rejects with `UnknownVizError` while the guest has no frame
       * yet — which is exactly the state right after `loadURL` resolves — and
       * returns an empty image while the panel is still being laid out. Both
       * heal within a few hundred milliseconds, so retry instead of dropping the
       * screenshot from an otherwise good snapshot.
       */
      async capturePainted(element) {
        // The last two delays cover a freshly navigated guest: its first paint
        // can lag `loadURL` by a second or two and every early attempt fails with
        // `UnknownVizError`, which used to escape as an opaque Electron error.
        const delays = [0, 300, 700, 1_500]
        for (const delay of delays) {
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
          try {
            const image = await withTimeout(element.capturePage(), 1_200, 'capturePage timed out')
            const empty = image === null || image === undefined
              || (typeof image.isEmpty === 'function' && image.isEmpty())
            if (!empty) return image
            report('capture retry', { delay, reason: 'empty' })
          } catch (error) {
            report('capture retry', { delay, reason: String(error?.message ?? error) })
          }
        }
        // Both failure modes mean the same thing to the caller — the guest is not
        // painting (it has no frame yet, or the window is occluded/hidden) — so
        // say what to do instead of surfacing the raw Electron wording.
        throw new Error('the browser panel produced no picture: the page had not painted yet, or the panel is not visible on screen. Bring the DSH window and the browser panel into view, then retry the screenshot.')
      }

      /**
       * Capture the page, stitched into one picture when it is taller than the panel.
       *
       * `capturePage` only ever returns what is on screen, so a long page needs
       * several frames: scroll by (viewport − overlap), capture, keep the new
       * rows, repeat. The frames are composed in device pixels and encoded once
       * at the end, which is why this reads `getBitmap()` instead of reusing the
       * data-URL path — decoding and re-encoding every frame would be pointless
       * work and lossier than it looks.
       *
       * Two honest limits are reported back rather than papered over: the image
       * stops at `maxHeight` CSS pixels, and anything that stays pinned to the
       * viewport (a fixed header, a chat bubble) is hidden from the second frame
       * on — otherwise it would be stamped into the picture once per screen.
       */
      async screenshot(params = {}) {
        const mode = params.mode === 'viewport' ? 'viewport' : 'full'
        const overlapCss = Number.isFinite(params.overlap) ? Math.max(0, Math.min(200, params.overlap)) : 40
        const maxHeightCss = Number.isFinite(params.maxHeight) ? Math.max(200, params.maxHeight) : 10_000
        // A page that grew wider after it loaded would be captured as one slice
        // of a horizontally scrolling layout, which is exactly what a report
        // picture cannot afford. Re-fit first, but never fight a manual zoom.
        if (mode === 'full' && this.zoomSource === 'fit') {
          await this.fitToWidth().catch(() => undefined)
        }
        const metrics = await this.evaluate(
          '({ w: window.innerWidth, h: window.innerHeight,'
          + ' sh: document.documentElement.scrollHeight, y: window.scrollY,'
          + ' dpr: window.devicePixelRatio, vis: document.visibilityState })',
        )
        report('screenshot start', { mode, ...metrics })
        // A collapsed sidebar leaves the guest with a 0×0 viewport: `capturePage`
        // then returns an empty image and the retry loop below would report a
        // mysterious "no image". Say what is actually wrong.
        if (!(metrics.w > 0) || !(metrics.h > 0)) {
          throw new Error('the browser panel has no size on screen (it is hidden or collapsed), so there is nothing to capture. Bring the right sidebar browser tab into view and retry.')
        }
        // A minimized/occluded window keeps its layout size but stops painting:
        // `capturePage` then times out on every retry and the call burns six
        // seconds before failing. A hidden document is a different condition from
        // a collapsed one, so name it instead of retrying.
        if (metrics.vis === 'hidden') {
          throw new Error('the browser panel is hidden right now (its pane or the app window is not visible), so the page is not being rendered and cannot be captured. Bring the panel into view and retry.')
        }
        if (mode === 'viewport' || metrics.sh <= metrics.h + 4) {
          const dataUrl = await this.capture(768)
          return {
            dataUrl,
            mode: 'viewport',
            frames: 1,
            width: null,
            height: null,
            pageHeight: metrics.sh,
            truncated: false,
          }
        }

        const element = this.element
        const chunks = []
        let width = 0
        let scale = 0
        let frames = 0
        let rows = 0
        let truncated = false
        let hidden = 0
        const startedAt = metrics.y
        /** Append one frame's rows, honouring both row budgets. */
        const push = (frame, skip) => {
          const limit = Math.min(
            MAX_SHOT_ROWS,
            Math.max(1, Math.round(maxHeightCss * scale)),
          )
          const take = Math.min(frame.height - skip, limit - rows)
          if (take <= 0) return false
          chunks.push(frame.rgba.subarray(skip * frame.width * 4, (skip + take) * frame.width * 4))
          rows += take
          return rows < limit
        }
        try {
          await this.evaluate('window.scrollTo(0, 0)')
          await settleFrames()
          let y = 0
          let covered = 0
          for (let guard = 0; guard < 60; guard += 1) {
            const frame = await this.captureFrame(element)
            if (width === 0) {
              width = frame.width
              scale = frame.height / metrics.h
            } else if (frame.width !== width) {
              throw new Error(`a frame came back ${frame.width}px wide instead of ${width}px`)
            }
            const skip = Math.max(0, Math.min(frame.height - 1, Math.round((covered - y) * scale)))
            report('screenshot frame', { y, sh: metrics.sh, frameH: frame.height, scale, skip, rows })
            covered = y + metrics.h
            frames += 1
            if (!push(frame, skip)) {
              truncated = true
              break
            }
            const scrolled = await this.evaluate(
              `(() => { window.scrollBy(0, ${Math.max(40, Math.round(metrics.h - overlapCss))}); return { y: window.scrollY, sh: document.documentElement.scrollHeight } })()`,
            ).catch(() => null)
            if (scrolled === null) break
            await settleFrames()
            y = scrolled.y
            if (frames > 1 && y === 0) break
            if (frames > 1 && hidden === 0) {
              hidden = await this.hidePinned().catch(() => 0)
            }
            if (y + metrics.h >= scrolled.sh - 2) {
              // Last screen: one more frame so the page bottom is included, and
              // drop the rows this screen shares with the previous one.
              const last = await this.captureFrame(element)
              const lastSkip = Math.max(0, Math.min(last.height - 1, Math.round((covered - y) * scale)))
              report('screenshot tail', { y, frameH: last.height, skip: lastSkip })
              push(last, lastSkip)
              break
            }
          }
        } finally {
          await this.evaluate(`window.scrollTo(0, ${Math.max(0, Math.round(startedAt))})`).catch(() => undefined)
          if (hidden > 0) await this.restorePinned().catch(() => undefined)
        }
        if (rows === 0 || width === 0) throw new Error('the capture produced no pixels')
        const height = rows
        const rgba = new Uint8Array(width * height * 4)
        let at = 0
        for (const chunk of chunks) {
          rgba.set(chunk, at)
          at += chunk.length
        }
        const png = await encodePng(width, height, rgba, deflateBytes)
        report('screenshot done', { width, height, frames, bytes: png.length, truncated })
        return {
          dataUrl: `data:image/png;base64,${bytesToBase64(png)}`,
          mode: 'full',
          frames,
          width,
          height,
          pageHeight: metrics.sh,
          truncated,
        }
      }

      /** Hide viewport-pinned elements so they do not repeat in every stitched frame. */
      async hidePinned() {
        const count = await this.evaluate(`(() => {
          let n = 0
          for (const el of document.querySelectorAll('body *')) {
            const style = getComputedStyle(el)
            if (style.position !== 'fixed' && style.position !== 'sticky') continue
            const box = el.getBoundingClientRect()
            if (box.width < 4 || box.height < 4) continue
            el.setAttribute('data-dsh-shot-hidden', '1')
            el.style.setProperty('visibility', 'hidden', 'important')
            n += 1
            if (n >= 40) break
          }
          return n
        })()`)
        report('screenshot hid pinned', { count })
        return typeof count === 'number' ? count : 0
      }

      /** Put pinned elements back after a stitched capture. */
      async restorePinned() {
        await this.evaluate(`(() => {
          for (const el of document.querySelectorAll('[data-dsh-shot-hidden]')) {
            el.style.removeProperty('visibility')
            el.removeAttribute('data-dsh-shot-hidden')
          }
        })()`).catch(() => undefined)
      }

      /**
       * True while this guest is still on screen.
       *
       * `executeJavaScript` keeps working on a detached webview — its guest
       * process lives on — so a stale panel can answer reads while its input
       * events go nowhere. Checking the DOM is the only way to tell.
       */
      isLive() {
        return this.detached !== true && this.element !== null && this.element.isConnected === true
      }

      /** Detach and hand the lease back. Safe to call twice. */
      destroy() {
        this.detached = true
        const siblings = guestsBySession.get(this.sessionId)
        if (siblings !== undefined) {
          siblings.delete(this)
          if (siblings.size === 0) guestsBySession.delete(this.sessionId)
        }
        const element = this.element
        this.element = null
        if (element !== null) {
          try {
            element.remove()
          } catch {
            // Removing an already-detached node is not an error worth reporting.
          }
        }
        const lease = this.reservation?.lease
        this.reservation = null
        if (lease !== undefined && this.bridge !== null) {
          void Promise.resolve(this.bridge.release(lease)).catch((error) => {
            log(`release failed: ${error?.message ?? error}`)
          })
        }
        this.bridge = null
      }
    }

    /**
     * The panel's tabs (TICKET-050).
     *
     * The panel is one visible box but the agent may need two live pages: a list
     * and a detail page, or a half-filled form and a document to read. Every tab
     * is a full `Guest` (own webview, own lease) inside its own slot; exactly one
     * slot is shown at a time. All tabs of a session share the workspace
     * partition, so the login that made the first page work also works after a
     * switch — the host reuses the partition per workspace.
     *
     * The store is plain DOM + guests, not React state: it is created in the
     * panel effect and destroyed with it, while the tab list the user sees is a
     * snapshot (`snapshot()`) pushed through `onChange`.
     */
    class TabStore {
      /**
       * @param {string} sessionId - the agent session this panel drives.
       * @param {HTMLElement} container - the host box the slots live in.
       * @param {{ onChange?: (view: { tabs: Array<object>, active: string }) => void, onNav?: (nav: { back: boolean, forward: boolean }) => void }} [hooks] -
       *   `onChange` repaints the tab strip, `onNav` updates the toolbar for the active tab.
       */
      constructor(sessionId, container, hooks = {}) {
        this.sessionId = sessionId
        this.container = container
        this.hooks = hooks
        /** @type {Array<{ id: string, guest: Guest, slot: HTMLElement, title: string, url: string }>} */
        this.tabs = []
        this.activeId = ''
        this.seq = 0
        this.destroyed = false
      }

      /** What the panel and the agent see: ids, titles, the active one. */
      snapshot() {
        return {
          tabs: this.tabs.map((tab) => {
            const url = typeof tab.url === 'string' ? tab.url : ''
            const blank = url === '' || url.startsWith('about:blank')
            const titled = typeof tab.title === 'string' && tab.title !== ''
              && !tab.title.startsWith('about:blank')
            return {
              id: tab.id,
              title: titled ? tab.title : (blank ? '新标签页' : url),
              url: blank ? '' : url,
              active: tab.id === this.activeId,
            }
          }),
          active: this.activeId,
        }
      }

      /**
       * Read each guest's real address before answering the agent.
       *
       * `getURL()` is asynchronous on the desktop bridge, so the tab structs
       * cannot stay current on their own: a background tab can finish loading
       * long after it was created. Reading on demand keeps `browser_tabs list`
       * honest without a periodic poll.
       */
      async refreshUrls() {
        for (const tab of this.tabs) {
          const raw = await tab.guest.address()
          const url = typeof raw === 'string' ? raw : ''
          if (url !== '' && !url.startsWith('about:blank')) tab.url = url
          if (tab.title === '') {
            const title = tab.guest.title()
            if (title !== '') tab.title = title
          }
        }
      }

      /** The tab struct currently on screen, or null before the first one exists. */
      activeTab() {
        const tab = this.tabs.find((entry) => entry.id === this.activeId)
        return tab === undefined ? null : tab
      }

      /** The guest the tools should drive, or null. */
      activeGuest() {
        const tab = this.activeTab()
        return tab === null ? null : tab.guest
      }

      /** Push the current tab list to React, if anyone is listening. */
      changed() {
        if (typeof this.hooks.onChange === 'function') this.hooks.onChange(this.snapshot())
      }

      /** Repaint the toolbar from the active tab. */
      navChanged() {
        const tab = this.activeTab()
        if (tab !== null && typeof this.hooks.onNav === 'function') this.hooks.onNav(tab.guest.historyState())
      }

      /**
       * Create a tab (a guest on `about:blank`), mount it in its own slot and
       * make it active. Throws `tab_limit: …` past MAX_TABS.
       * @returns {Promise<object>} the new tab struct.
       */
      async create() {
        if (this.destroyed) throw new Error('the browser panel went away while opening a tab')
        if (this.tabs.length >= MAX_TABS) {
          throw new Error(`tab_limit: the panel already holds ${MAX_TABS} tabs. `
            + 'Close one with browser_tabs({ action: "close", tab }) and try again.')
        }
        const id = `t${++this.seq}`
        const slot = document.createElement('div')
        slot.setAttribute('data-dsh-tab', id)
        slot.style.cssText = 'position:absolute;inset:0;display:none'
        this.container.appendChild(slot)
        const guest = new Guest(this.sessionId)
        guest.tabId = id
        const tab = { id, guest, slot, title: '', url: '' }
        this.tabs.push(tab)
        guest.onTitle = (title) => {
          tab.title = title
          this.changed()
        }
        guest.onHistory = (nav) => {
          if (this.activeId === id) this.hooks.onNav?.(nav)
        }
        guest.isActive = () => this.activeId === id
        try {
          await guest.mount(slot)
        } catch (error) {
          this.drop(tab)
          throw error
        }
        if (this.destroyed) {
          this.drop(tab)
          throw new Error('the browser panel went away while opening a tab')
        }
        tab.url = guest.url()
        this.activate(id)
        return tab
      }

      /** Show one tab's slot and hide the others; no-op for an unknown id. */
      activate(id) {
        const tab = this.tabs.find((entry) => entry.id === id)
        if (tab === undefined) return null
        if (this.activeId === id && tab.slot.style.display === 'block') return tab
        this.activeId = id
        for (const entry of this.tabs) entry.slot.style.display = entry.id === id ? 'block' : 'none'
        // The host scopes approval prompts and eval by "the page the panel is
        // on"; switching tabs must move that address with the screen, not leave
        // the last-loaded (possibly hidden) tab's URL behind.
        void reportPage(this.sessionId, { url: tab.guest.url() })
        this.navChanged()
        this.changed()
        return tab
      }

      /**
       * Close a tab. Closing the last one opens a fresh blank tab first, so the
       * panel is never left without a page to drive.
       * @param {string} id - tab id from `snapshot()`.
       * @returns {Promise<object>} the closed tab struct.
       */
      async close(id) {
        const tab = this.tabs.find((entry) => entry.id === id)
        if (tab === undefined) {
          throw new Error(`tab_not_found: there is no tab "${id}" in this panel. `
            + 'Call browser_tabs({ action: "list" }) and use an id from that answer. Nothing was closed.')
        }
        if (this.tabs.length === 1) await this.create()
        const wasActive = this.activeId === id
        const at = this.tabs.indexOf(tab)
        this.drop(tab)
        if (wasActive) {
          const next = this.tabs[Math.min(at, this.tabs.length - 1)]
          if (next !== undefined) this.activate(next.id)
        }
        return tab
      }

      /** Detach one tab's guest and slot; keeps the active pointer consistent. */
      drop(tab) {
        const at = this.tabs.indexOf(tab)
        if (at >= 0) this.tabs.splice(at, 1)
        try {
          tab.slot.remove()
        } catch {
          // Removing a node the browser already dropped is not an error.
        }
        tab.guest.destroy()
        if (this.activeId === tab.id) this.activeId = ''
        this.changed()
      }

      /** Tear down every tab; called from the panel effect cleanup. */
      async destroyAll() {
        this.destroyed = true
        for (const tab of [...this.tabs]) this.drop(tab)
      }
    }

    /**
     * Give up on a guest call that never answers.
     *
     * A `<webview>` method can hang without rejecting — a capture of a busy or
     * hidden guest is the known case — and the host is waiting on a promise that
     * would otherwise never settle. Reporting *which* step stalled is the point.
     */
    function withTimeout(promise, timeoutMs, message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${message} within ${timeoutMs}ms`)), timeoutMs)
        Promise.resolve(promise).then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    }

    /** Let the compositor catch up: two animation frames, then a short grace. */
    async function settleFrames() {
      await new Promise((resolve) => {
        if (typeof requestAnimationFrame !== 'function') return setTimeout(resolve, 120)
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 90)))
      })
    }

    // --- png-deflate-begin
    /** zlib-wrapped deflate, the only compression PNG allows for IDAT. */
    async function deflateBytes(bytes) {
      const stream = new CompressionStream('deflate')
      const writer = stream.writable.getWriter()
      void writer.write(bytes)
      void writer.close()
      const buffer = await new Response(stream.readable).arrayBuffer()
      return new Uint8Array(buffer)
    }
    // --- png-deflate-end

    // --- png-encoder-begin (extracted verbatim by plugin/test/png.test.mjs)
    /** CRC-32 table, built once on first use. */
    const CRC_TABLE = (() => {
      const table = new Uint32Array(256)
      for (let n = 0; n < 256; n += 1) {
        let c = n
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c >>> 0
      }
      return table
    })()

    function crc32(bytes) {
      let c = 0xffffffff
      for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
      return (c ^ 0xffffffff) >>> 0
    }

    /** One PNG chunk: length, type, data, CRC over type+data. */
    function pngChunk(type, data) {
      const out = new Uint8Array(12 + data.length)
      const view = new DataView(out.buffer)
      view.setUint32(0, data.length)
      for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
      out.set(data, 8)
      view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
      return out
    }

    /**
     * Encode RGBA rows as a PNG, with filter 0 on every scanline.
     *
     * Filtering is where PNG wins its bytes, but the content here is a
     * screenshot whose rows are already varied; deflate does the real work and a
     * filter pass would cost more code than it saves.
     */
    async function encodePng(width, height, rgba, deflate) {
      const stride = width * 4
      const raw = new Uint8Array((stride + 1) * height)
      for (let y = 0; y < height; y += 1) {
        const at = y * (stride + 1)
        raw[at] = 0
        raw.set(rgba.subarray(y * stride, y * stride + stride), at + 1)
      }
      const compressed = await deflate(raw)
      const header = new Uint8Array(13)
      const view = new DataView(header.buffer)
      view.setUint32(0, width)
      view.setUint32(4, height)
      header[8] = 8 // bit depth
      header[9] = 6 // colour type: RGBA
      header[10] = 0 // deflate
      header[11] = 0 // adaptive filtering
      header[12] = 0 // no interlace
      const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', compressed),
        pngChunk('IEND', new Uint8Array(0)),
      ]
      const total = parts.reduce((sum, part) => sum + part.length, 0)
      const out = new Uint8Array(total)
      let at = 0
      for (const part of parts) {
        out.set(part, at)
        at += part.length
      }
      return out
    }

    /** Base64 in chunks: one `fromCharCode` over megabytes would blow the stack. */
    function bytesToBase64(bytes) {
      let binary = ''
      const step = 0x8000
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
      }
      return btoa(binary)
    }
    // --- png-encoder-end

    // --- png-decoder-begin
    /** base64 → bytes, without `Buffer` (this renderer has none). */
    function base64ToBytes(text) {
      const binary = atob(text)
      const out = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
      return out
    }

    /** zlib inflate, the counterpart of `deflateBytes`. */
    async function inflateBytes(bytes) {
      const stream = new DecompressionStream('deflate')
      const writer = stream.writable.getWriter()
      void writer.write(bytes)
      void writer.close()
      return new Uint8Array(await new Response(stream.readable).arrayBuffer())
    }

    /** Read a big-endian uint32. */
    function readU32(bytes, at) {
      return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
    }

    /**
     * Decode a PNG `data:` URL into top-down RGBA rows.
     *
     * `NativeImage.getBitmap()` would be one call, but it returns a `Buffer` and
     * this renderer has no `Buffer`: the host answers `Buffer is not available
     * for the current Context`. `toDataURL()` is a plain string, so the pixels
     * are decoded here instead — Chromium writes 8-bit, non-interlaced PNGs.
     * @param {string} dataUrl - `data:image/png;base64,…`.
     * @returns {Promise<{width: number, height: number, rgba: Uint8Array}>} pixels.
     */
    async function pngToRgba(dataUrl) {
      const comma = dataUrl.indexOf(',')
      if (!dataUrl.startsWith('data:image/png;base64,') || comma < 0) {
        throw new Error('a captured frame was not a PNG')
      }
      const bytes = base64ToBytes(dataUrl.slice(comma + 1))
      let at = 8
      let width = 0
      let height = 0
      let channels = 4
      let bitDepth = 8
      let interlace = 0
      const parts = []
      while (at + 8 <= bytes.length) {
        const length = readU32(bytes, at)
        const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
        const data = bytes.subarray(at + 8, at + 8 + length)
        if (type === 'IHDR') {
          width = readU32(data, 0)
          height = readU32(data, 4)
          bitDepth = data[8]
          const colorType = data[9]
          channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
          interlace = data[12]
        } else if (type === 'IDAT') {
          parts.push(data)
        } else if (type === 'IEND') {
          break
        }
        at += 12 + length
      }
      if (width === 0 || height === 0) throw new Error('a captured frame had no header')
      if (channels === 0 || bitDepth !== 8 || interlace !== 0) {
        throw new Error(`a captured frame used an unsupported PNG layout (colour type ${channels === 4 ? 6 : 2}, depth ${bitDepth}, interlace ${interlace})`)
      }
      let total = 0
      for (const part of parts) total += part.length
      const joined = new Uint8Array(total)
      let offset = 0
      for (const part of parts) {
        joined.set(part, offset)
        offset += part.length
      }
      const raw = await inflateBytes(joined)
      const stride = width * channels
      const out = new Uint8Array(width * height * 4)
      let previous = new Uint8Array(stride)
      for (let y = 0; y < height; y += 1) {
        const filter = raw[y * (stride + 1)]
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
        const row = new Uint8Array(stride)
        for (let x = 0; x < stride; x += 1) {
          const left = x >= channels ? row[x - channels] : 0
          const up = previous[x]
          const corner = x >= channels ? previous[x - channels] : 0
          let value = line[x]
          if (filter === 1) value += left
          else if (filter === 2) value += up
          else if (filter === 3) value += (left + up) >> 1
          else if (filter === 4) {
            const estimate = left + up - corner
            const da = Math.abs(estimate - left)
            const db = Math.abs(estimate - up)
            const dc = Math.abs(estimate - corner)
            value += da <= db && da <= dc ? left : db <= dc ? up : corner
          }
          row[x] = value & 0xff
        }
        for (let x = 0; x < width; x += 1) {
          const from = x * channels
          const to = (y * width + x) * 4
          out[to] = row[from]
          out[to + 1] = row[from + 1]
          out[to + 2] = row[from + 2]
          out[to + 3] = channels === 4 ? row[from + 3] : 255
        }
        previous = row
      }
      return { width, height, rgba: out }
    }
    // --- png-decoder-end

    /** Electron key names for the keys a browser agent actually uses. */
    const KEY_NAMES = {
      enter: 'Enter',
      return: 'Enter',
      tab: 'Tab',
      escape: 'Escape',
      esc: 'Escape',
      backspace: 'Backspace',
      delete: 'Delete',
      del: 'Delete',
      space: 'Space',
      arrowleft: 'Left',
      left: 'Left',
      arrowright: 'Right',
      right: 'Right',
      arrowup: 'Up',
      up: 'Up',
      arrowdown: 'Down',
      down: 'Down',
      home: 'Home',
      end: 'End',
      pageup: 'PageUp',
      pagedown: 'PageDown',
      f1: 'F1',
      f2: 'F2',
      f3: 'F3',
      f4: 'F4',
      f5: 'F5',
      f6: 'F6',
      f7: 'F7',
      f8: 'F8',
      f9: 'F9',
      f10: 'F10',
      f11: 'F11',
      f12: 'F12',
    }

    const MODIFIERS = { alt: 'alt', ctrl: 'control', control: 'control', cmd: 'meta', meta: 'meta', shift: 'shift' }

    /**
     * Parse `"Alt+Left"` into an Electron `sendInputEvent` chord.
     * @returns {{ keyCode: string, modifiers: string[] } | null}
     */
    function parseChord(value) {
      if (typeof value !== 'string' || value.trim() === '') return null
      const parts = value.split('+').map((part) => part.trim()).filter((part) => part !== '')
      if (parts.length === 0) return null
      const modifiers = []
      let keyCode = null
      for (const part of parts) {
        const lower = part.toLowerCase()
        if (MODIFIERS[lower] !== undefined) modifiers.push(MODIFIERS[lower])
        else if (KEY_NAMES[lower] !== undefined) keyCode = KEY_NAMES[lower]
        else if (part.length === 1) keyCode = part.toUpperCase()
        else return null
      }
      if (keyCode === null) return null
      return { keyCode, modifiers }
    }

    /**
     * Browser navigation that a page-level key press cannot perform.
     * @returns {'back'|'forward'|'reload'|null}
     */
    function navigationCommand(chord) {
      const mods = new Set(chord.modifiers)
      const key = chord.keyCode
      if (mods.has('alt') && key === 'Left') return 'back'
      if (mods.has('alt') && key === 'Right') return 'forward'
      if (key === 'F5') return 'reload'
      if (mods.has('control') && (key === 'R' || key === 'F5')) return 'reload'
      return null
    }

    /** Resolve on the first matching DOM event, reject after `timeoutMs`. */
    function once(element, event, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          element.removeEventListener(event, onEvent)
          reject(new Error(`timed out waiting for "${event}"`))
        }, timeoutMs)
        function onEvent(event_) {
          clearTimeout(timer)
          element.removeEventListener(event, onEvent)
          resolve(event_)
        }
        element.addEventListener(event, onEvent)
      })
    }

    // ---------------------------------------------------------------- the panel
    /** The sidebar tab body: address bar, badge, guest host, takeover control. */
    function Panel(props) {
      const sessionId = props?.sessionId
      const view = usePanelState()
      const wrapRef = React.useRef(null)
      const hostRef = React.useRef(null)
      const tabsRef = React.useRef(null)
      const addressInputRef = React.useRef(null)
      const [address, setAddress] = React.useState('')
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      /**
       * Tab strip view, pushed by the store: `{ tabs: [...], active }`.
       *
       * Details are rendered by `TabStore` itself; React only needs the list to
       * draw. The active mode known to the store is also what routes every tool
       * command, so the strip can never disagree with the page being driven.
       */
      const [tabs, setTabs] = React.useState({ tabs: [], active: '' })
      const [zoom, setZoom] = React.useState(() => zooms.get(sessionId) ?? 1)
      /**
       * History availability for the Back/Forward buttons. Seeded by the guest
       * after mount and refreshed on every navigation; a stale `true` here is
       * harmless (the click is a no-op), a stale `false` would be annoying.
       */
      const [nav, setNav] = React.useState({ back: false, forward: false })

      // The badge clock: `since` comes from the host, so a rebuild or a session
      // switch never restarts the count. Repaint once a second, and skip ticks
      // while the window is hidden (no one is looking, and it costs nothing).
      const [, setTick] = React.useState(0)
      const control = phases.get(sessionId) ?? { phase: 'booting', since: 0, reason: '' }
      // Only this session's prompt belongs on this panel; another session's one
      // is drawn by the body that owns it.
      const approval = view.approval !== null && view.approval.session === sessionId ? view.approval : null
      /** Answer the shown prompt; the helpers do the clearing and the POST. */
      const answer = (decision) => {
        if (approval === null) return
        void answerApproval(approval.session, approval.id, decision)
      }
      React.useEffect(() => {
        const timer = setInterval(() => {
          if (document.visibilityState === 'hidden') return
          if (control.phase !== 'agent' && control.phase !== 'taken_over') return
          setTick((value) => value + 1)
        }, 1_000)
        return () => clearInterval(timer)
      }, [control.phase])

      // A prompt is a countdown, so it needs its own faster clock: one repaint a
      // second would show the wrong second half the time.
      React.useEffect(() => {
        if (approval === null) return undefined
        const timer = setInterval(() => {
          if (document.visibilityState === 'hidden') return
          setTick((value) => value + 1)
        }, 500)
        return () => clearInterval(timer)
      }, [approval?.id])

      // Enter refuses. A prompt that can be dismissed by reflex defaults to
      // "no": consent has to be a deliberate click on a button that says yes.
      React.useEffect(() => {
        if (approval === null) return undefined
        const onKey = (event) => {
          if (event.key === 'Enter') {
            // The address bar's Enter means "go", not "answer the prompt".
            if (event.target === addressInputRef.current) return
            event.preventDefault()
            answer('deny')
            return
          }
          if (event.altKey !== true) return
          if (event.key === '1') { event.preventDefault(); answer('once'); return }
          if (event.key === '2') { event.preventDefault(); answer('site'); return }
          if (event.key === '3') { event.preventDefault(); answer('deny') }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [approval?.id])

      // Hidden window: nobody can read the prompt, so nobody can consent to it.
      // Answer `unavailable` at once instead of letting the host wait 30 seconds.
      React.useEffect(() => {
        if (approval === null) return undefined
        const onVisibility = () => {
          if (document.visibilityState === 'visible') return
          void answerApproval(approval.session, approval.id, 'unavailable')
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [approval?.id])

      // Mirror the guest's URL into the address bar unless the user is typing.
      React.useEffect(() => {
        if (document.activeElement === addressInputRef.current) return
        if (view.url !== '') setAddress(view.url)
      })

      // The badge is the product's most important pixel; log every repaint so a
      // headless check can tell a wrong phase from a phase that never arrived.
      React.useEffect(() => {
        report('badge', { phase: control.phase, since: control.since, label: badgeLabel(control.phase, control.since) })
      }, [control.phase, control.since])

      // The outline is the product's claim that "this thing on screen is asking
      // for a human", so its geometry has to be checkable without eyes: log the
      // box, the wrapper origin it is placed against, and which element actually
      // owns the centre pixel (a webview that composites above the outline shows
      // up here as `top: WEBVIEW`).
      React.useEffect(() => {
        const wrap = wrapRef.current
        const rect = view.detection?.rect ?? null
        if (wrap === null || rect === null) {
          report('overlay', { hasWrap: wrap !== null, rect })
          return
        }
        const wrapRect = wrap.getBoundingClientRect()
        const cx = wrapRect.left + rect.x + rect.width / 2
        const cy = wrapRect.top + rect.y + rect.height / 2
        const top = document.elementFromPoint(cx, cy)
        report('overlay', {
          rect,
          wrap: {
            x: Math.round(wrapRect.left), y: Math.round(wrapRect.top),
            w: Math.round(wrapRect.width), h: Math.round(wrapRect.height),
          },
          point: { x: Math.round(cx), y: Math.round(cy) },
          top: top === null
            ? null
            : top.tagName + (typeof top.className === 'string' && top.className !== ''
              ? `.${top.className.slice(0, 32)}`
              : ''),
          viewport: { w: window.innerWidth, h: window.innerHeight },
        })
      }, [view.detection])

      React.useEffect(() => {
        let live = true
        const store = new TabStore(sessionId, hostRef.current, {
          onChange: (next) => {
            if (live) setTabs(next)
          },
          onNav: (next) => { if (live) setNav(next) },
        })
        tabsRef.current = store

        const runner = (command) => {
          if (command.type === 'tabs') {
            return runTabCommand(store, command).catch((error) => failCommand(command, error))
          }
          // `browser_open({ newTab:true })` adds a tab first, then loads the URL
          // into it; everything else runs against the tab on screen.
          if (command.type === 'open' && command.params?.newTab === true) {
            return (async () => {
              let tab
              try {
                tab = await store.create()
                setAddress('')
                setZoom(tab.guest.zoom)
              } catch (error) {
                await failCommand(command, error)
                return
              }
              await runCommand(tab.guest, command, sessionId)
            })()
          }
          const guest = store.activeGuest()
          if (guest === null) {
            return failCommand(command, new Error(
              'the browser panel has no tab yet (it is still starting); retry in a moment.',
            ))
          }
          return runCommand(guest, command, sessionId)
        }
        runner.isLive = () => {
          const guest = store.activeGuest()
          return guest !== null && guest.isLive()
        }
        executors.set(sessionId, runner)
        report('panel mount', { session: short(sessionId), hasHost: hostRef.current !== null })

        // Seed the badge from the host: the phase may predate this mount (the
        // user took over, or a challenge was met, before the tab was rebuilt).
        void callHost(`/state?session=${encodeURIComponent(sessionId)}`)
          .then((data) => {
            const state_ = data?.state
            if (state_ === undefined || !live) return
            setPhaseLocal(sessionId, state_.phase, state_.since, state_.reason ?? '')
            if (state_.phase === 'needs_human') {
              setState({ detection: { rect: null, signals: state_.signals ?? [] } })
            }
          })
          .catch(() => undefined)

        store.create()
          .then((tab) => {
            if (!live) return
            setFailure(null)
            setTabs(store.snapshot())
            setZoom(tab.guest.zoom)
            setNav(tab.guest.historyState())
            const queued = deferred.get(sessionId) ?? []
            deferred.delete(sessionId)
            report('panel ready', { session: short(sessionId), deferred: queued.length, tabs: store.tabs.length })
            for (const command of queued) void runner(command)
          })
          .catch((error) => {
            if (!live) return
            report('panel mount failed', { session: short(sessionId), error: String(error?.message ?? error) })
            setFailure(String(error?.message ?? error))
            setState({ note: String(error?.message ?? error) })
          })

        return () => {
          live = false
          if (executors.get(sessionId) === runner) executors.delete(sessionId)
          tabsRef.current = null
          void store.destroyAll()
        }
      }, [sessionId])

      /** The guest the panel chrome (address bar, zoom, takeover) acts on. */
      const guestNow = () => {
        const store = tabsRef.current
        return store === null ? null : store.activeGuest()
      }

      const go = () => {
        const target = address.trim()
        if (target === '') return
        const guest = guestNow()
        if (guest === null) return
        const url = /^[a-z]+:\/\//i.test(target) ? target : `https://${target}`
        void guest.load(url).catch((error) => { setFailure(String(error?.message ?? error)) })
      }

      /** Back/forward/reload for the human riding along in the panel. */
      const historyBack = () => {
        const guest = guestNow()
        if (guest === null) return
        void guest.goBack().then((next) => { setNav(next) }).catch(() => undefined)
      }

      const historyForward = () => {
        const guest = guestNow()
        if (guest === null) return
        void guest.goForward().then((next) => { setNav(next) }).catch(() => undefined)
      }

      const reloadPage = () => {
        const guest = guestNow()
        if (guest === null) return
        void guest.reloadPage()
      }

      /** Open a blank tab and put the caret in the address bar (TICKET-050). */
      const newTab = () => {
        const store = tabsRef.current
        if (store === null) return
        void store.create()
          .then((tab) => {
            setAddress('')
            setZoom(tab.guest.zoom)
            addressInputRef.current?.focus?.()
          })
          .catch((error) => {
            report('new tab failed', { error: String(error?.message ?? error) })
            setFailure(String(error?.message ?? error))
          })
      }

      /** Show another tab; the panel chrome follows the newly active guest. */
      const switchTab = (id) => {
        const store = tabsRef.current
        if (store === null) return
        const tab = store.activate(id)
        if (tab === null) return
        setZoom(tab.guest.zoom)
        setNav(tab.guest.historyState())
        setAddress(tab.guest.url())
      }

      /** Close one tab; the store keeps at least one page alive. */
      const closeTab = (id) => {
        const store = tabsRef.current
        if (store === null) return
        void store.close(id)
          .then(() => {
            const active = store.activeTab()
            if (active === null) return
            setAddress(active.guest.url())
            setZoom(active.guest.zoom)
            setNav(active.guest.historyState())
          })
          .catch((error) => {
            report('close tab failed', { error: String(error?.message ?? error) })
            setFailure(String(error?.message ?? error))
          })
      }

      /**
       * Zoom the page, not the chrome.
       *
       * The buttons exist because the panel is narrow and many sites are laid
       * out for a desktop width; the same path is reachable from the agent as
       * `browser_zoom`, so a test can drive it without a human hand.
       */
      const changeZoom = (next) => {
        const guest = guestNow()
        if (guest === null) return
        const factor = Math.min(3, Math.max(0.25, Math.round(next * 100) / 100))
        void guest.setZoom(factor)
          .then((applied) => { setZoom(applied.zoom) })
          .catch((error) => { setFailure(String(error?.message ?? error)) })
      }

      /** Hand the panel to the human. */
      const takeOver = () => {
        // A prompt about to be answered by the person who is taking the wheel is
        // moot: the agent must stop, not act on a consent that was never given.
        denyPendingApproval(sessionId)
        const guest = guestNow()
        if (guest !== null) {
          // Leave the page focused so the human can type straight away.
          void guest.evaluate('document.body?.focus?.(), true').catch(() => undefined)
        }
        void reportPhase(sessionId, 'taken_over', { reason: 'user took over', since: Date.now() })
      }

      /** Hand it back, and say what the agent missed while it was away. */
      const handBack = async () => {
        const guest = guestNow()
        setBusy(true)
        let digest = ''
        try {
          if (guest !== null) {
            // The digest is a snapshot, and a snapshot needs the traversal source.
            // It is fetched rather than bundled: the host owns that file, and a
            // copy here would drift from what the tools actually run.
            const source = String((await callHost('/source?name=snapshot'))?.source ?? '')
            const result = await guest.snapshot({ source, maxChars: 1_200, includeImage: false })
            digest = digestOf(result)
          }
        } catch (error) {
          report('handback snapshot failed', { error: String(error?.message ?? error) })
          // Something is better than nothing: the agent should still learn where
          // the page stands, even if the tree was unavailable.
          digest = [guest?.title?.() ?? '', guest?.url?.() ?? ''].filter((part) => part !== '').join(' · ')
        }
        setState({ note: 'Ready', url: guest?.url?.() ?? state.url })
        setBusy(false)
        await reportPhase(sessionId, 'agent', { reason: 'user handed back', since: Date.now(), digest })
      }

      const takenOver = control.phase === 'taken_over'
      const box = view.detection?.rect

      return h('div', { style: S.panel },
        h('div', { style: S.tabs, role: 'tablist', 'aria-label': '浏览器标签页' },
          ...tabs.tabs.map((tab) => h('div', {
            key: tab.id,
            style: tab.active === true ? S.tabOn : S.tab,
          },
          h('button', {
            type: 'button',
            style: S.tabName,
            onClick: () => switchTab(tab.id),
            title: tab.url === '' ? tab.title : `${tab.title} — ${tab.url}`,
          }, tab.title === '' ? tab.id : tab.title),
          h('button', {
            type: 'button',
            style: S.tabClose,
            onClick: (event) => { event.stopPropagation?.(); closeTab(tab.id) },
            title: 'Close this tab',
          }, '×'),
          )),
          h('button', { type: 'button', style: S.tabAdd, onClick: newTab, title: 'New tab' }, '+'),
        ),
        h('div', { style: S.bar },
          h('button', {
            type: 'button',
            style: { ...S.button, opacity: nav.back ? 1 : 0.4 },
            onClick: historyBack,
            disabled: nav.back !== true,
            title: 'Back to the previous page',
          }, '‹'),
          h('button', {
            type: 'button',
            style: { ...S.button, opacity: nav.forward ? 1 : 0.4 },
            onClick: historyForward,
            disabled: nav.forward !== true,
            title: 'Forward to the next page',
          }, '›'),
          h('button', {
            type: 'button',
            style: S.button,
            onClick: reloadPage,
            title: 'Reload this page',
          }, '⟳'),
          h('input', {
            ref: addressInputRef,
            style: S.input,
            value: address,
            placeholder: 'Search or enter address',
            spellCheck: false,
            onChange: (event) => { setAddress(event.target.value) },
            onKeyDown: (event) => { if (event.key === 'Enter') go() },
          }),
          h('button', { type: 'button', style: S.button, onClick: go, title: 'Open this address' }, 'Go'),
          h('button', {
            type: 'button',
            style: takenOver ? S.buttonOn : S.button,
            onClick: () => { void (takenOver ? handBack() : takeOver()) },
            disabled: busy,
            title: takenOver ? 'Give the panel back to the agent' : 'Take control of the page',
          }, takenOver ? (busy ? '交还中…' : '交还 Agent') : '我来接管'),
        ),
        h('div', { style: S.badgeRow },
          h('span', { style: { ...S.badge, ...badgeInk(control.phase) } }, badgeLabel(control.phase, control.since)),
          h('span', { style: S.note },
            failure ?? (control.phase === 'needs_human'
              ? 'Page is asking for a human: finish it in the panel, then hand it back'
              : view.note)),
          h('div', { style: S.zoom },
            h('button', {
              type: 'button',
              style: S.zoomButton,
              title: '缩小页面',
              onClick: () => changeZoom(zoom - 0.1),
            }, '−'),
            h('button', {
              type: 'button',
              style: S.zoomLabel,
              title: '点击回到 100%',
              onClick: () => changeZoom(1),
            }, `${Math.round(zoom * 100)}%`),
            h('button', {
              type: 'button',
              style: S.zoomButton,
              title: '放大页面',
              onClick: () => changeZoom(zoom + 0.1),
            }, '＋'),
          ),
        ),
        approval === null
          ? null
          : h('div', { style: S.approval, role: 'alertdialog', 'aria-label': '写操作确认' },
              h('div', { style: S.approvalText },
                h('div', { style: S.approvalTitle }, `Agent 想${approvalTitle(approval)}`),
                h('div', { style: S.approvalHint }, `若 ${approvalSecondsLeft(approval)} 秒内不作答将自动拒绝 · Enter 拒绝 · Alt+1/2/3 选择`),
              ),
              h('button', { type: 'button', style: S.approvalAllow, title: '只允许这一次', onClick: () => answer('once') }, '允许一次'),
              h('button', { type: 'button', style: S.approvalSite, title: '本站本会话不再询问', onClick: () => answer('site') }, '本会话允许本站'),
              h('button', { type: 'button', style: S.approvalDeny, title: '拒绝这次操作', onClick: () => answer('deny') }, '拒绝'),
            ),
        h('div', { ref: wrapRef, style: S.hostWrap },
          h('div', { ref: hostRef, style: S.host }),
          box === null || box === undefined
            ? null
            : h('div', {
                style: {
                  position: 'absolute',
                  left: box.x,
                  top: box.y,
                  width: box.width,
                  height: box.height,
                  border: '2px solid #d92d20',
                  borderRadius: 6,
                  boxShadow: '0 0 0 4px rgba(217,45,32,.12)',
                  pointerEvents: 'none',
                },
              }),
          view.detection !== null && (box === null || box === undefined)
            ? h('div', { style: S.detectNote }, '检测到人机验证，请你在面板里完成')
            : null,
        ),
      )
    }

    /** `mm:ss` since a host timestamp. */
    function elapsedLabel(since) {
      if (!Number.isFinite(since) || since <= 0) return ''
      const seconds = Math.max(0, Math.floor((Date.now() - since) / 1_000))
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
      const ss = String(seconds % 60).padStart(2, '0')
      return `（${mm}:${ss}）`
    }

    /** Badge text for a phase. */
    function badgeLabel(phase, since) {
      if (phase === 'agent') return `Agent 正在操作${elapsedLabel(since)}`
      if (phase === 'taken_over') return `你已接管${elapsedLabel(since)}`
      if (phase === 'needs_human') return '等待你处理（人机验证）'
      if (phase === 'booting') return '启动中'
      return '空闲'
    }

    /** Badge colors for a phase: white means the human has the wheel. */
    function badgeInk(phase) {
      if (phase === 'agent') return { background: '#e8f0ff', color: '#1a4fd6', borderColor: '#c7d8ff' }
      if (phase === 'taken_over') return { background: '#ffffff', color: '#101828', borderColor: '#98a2b3' }
      if (phase === 'needs_human') return { background: '#fffaeb', color: '#b54708', borderColor: '#fec84b' }
      return { background: '#ecfdf3', color: '#027a48', borderColor: '#bbf7d0' }
    }

    /** Seconds left on a prompt. The host also times it out; this is the display. */
    function approvalSecondsLeft(approval) {
      return Math.max(0, Math.ceil((approval.issuedAt + approval.timeoutMs - Date.now()) / 1_000))
    }

    /** What a prompt is about, in one readable line. */
    function approvalTitle(approval) {
      return approval.summary !== ''
        ? approval.summary
        : `在 ${approval.origin === '' ? '当前页面' : approval.origin} 做一次写操作`
    }

    /** Inline styles: the panel ships no CSS file, so nothing to scope. */
    const S = {
      panel: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: '#fff' },
      tabs: { display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px 0', borderBottom: '1px solid #eaecf0', overflowX: 'auto' },
      tab: { display: 'flex', alignItems: 'center', gap: 2, padding: '0 2px 0 8px', height: 26, fontSize: 11, color: '#475467', background: '#f9fafb', border: '1px solid #eaecf0', borderBottom: 'none', borderTopLeftRadius: 6, borderTopRightRadius: 6, maxWidth: 180, minWidth: 0 },
      tabOn: { display: 'flex', alignItems: 'center', gap: 2, padding: '0 2px 0 8px', height: 26, fontSize: 11, color: '#101828', background: '#fff', border: '1px solid #d0d5dd', borderBottom: 'none', borderTopLeftRadius: 6, borderTopRightRadius: 6, maxWidth: 180, minWidth: 0 },
      tabName: { minWidth: 0, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', border: 'none', background: 'transparent', fontSize: 11, color: 'inherit', cursor: 'pointer', padding: 0 },
      tabClose: { width: 18, height: 18, lineHeight: '16px', padding: 0, fontSize: 12, border: 'none', background: 'transparent', color: '#98a2b3', cursor: 'pointer' },
      tabAdd: { width: 24, height: 24, lineHeight: '22px', padding: 0, fontSize: 14, border: '1px solid #d0d5dd', background: '#fff', color: '#344054', cursor: 'pointer', borderRadius: 6, marginBottom: 2 },
      bar: { display: 'flex', gap: 6, padding: '8px 10px', borderBottom: '1px solid #eaecf0', alignItems: 'center' },
      input: { flex: '1 1 auto', minWidth: 0, height: 28, padding: '0 8px', fontSize: 12, borderRadius: 6, border: '1px solid #d0d5dd', outline: 'none' },
      button: { height: 28, padding: '0 10px', fontSize: 12, borderRadius: 6, border: '1px solid #d0d5dd', background: '#fff', color: '#344054', cursor: 'pointer', whiteSpace: 'nowrap' },
      buttonOn: { height: 28, padding: '0 10px', fontSize: 12, borderRadius: 6, border: '1px solid #f79009', background: '#fffaeb', color: '#b54708', cursor: 'pointer', whiteSpace: 'nowrap' },
      badgeRow: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid #f2f4f7' },
      badge: { fontSize: 11, lineHeight: '18px', padding: '0 8px', borderRadius: 999, border: '1px solid transparent', whiteSpace: 'nowrap' },
      note: { flex: '1 1 auto', minWidth: 0, fontSize: 11, color: '#667085', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      zoom: { display: 'flex', gap: 2, alignItems: 'center', flex: '0 0 auto' },
      zoomButton: { width: 22, height: 20, lineHeight: '18px', padding: 0, fontSize: 12, borderRadius: 4, border: '1px solid #d0d5dd', background: '#fff', color: '#344054', cursor: 'pointer' },
      zoomLabel: { minWidth: 40, height: 20, padding: '0 4px', fontSize: 11, borderRadius: 4, border: '1px solid #eaecf0', background: '#f9fafb', color: '#475467', cursor: 'pointer', whiteSpace: 'nowrap' },
      hostWrap: { position: 'relative', flex: '1 1 auto', minHeight: 0, display: 'flex' },
      host: { position: 'relative', flex: '1 1 auto', minHeight: 0, display: 'flex', background: '#fff' },
      detectNote: { position: 'absolute', right: 8, top: 8, fontSize: 11, padding: '2px 8px', borderRadius: 999, background: '#fffaeb', color: '#b54708', border: '1px solid #fec84b', pointerEvents: 'none' },
      approval: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid #fec84b', background: '#fffaeb' },
      approvalText: { flex: '1 1 140px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
      approvalTitle: { fontSize: 12, color: '#7a2e0e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      approvalHint: { fontSize: 11, color: '#b54708', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      approvalAllow: { height: 28, padding: '0 10px', fontSize: 12, borderRadius: 6, border: '1px solid #12b76a', background: '#ecfdf3', color: '#027a48', cursor: 'pointer', whiteSpace: 'nowrap' },
      approvalSite: { height: 28, padding: '0 10px', fontSize: 12, borderRadius: 6, border: '1px solid #d0d5dd', background: '#fff', color: '#344054', cursor: 'pointer', whiteSpace: 'nowrap' },
      approvalDeny: { height: 28, padding: '0 10px', fontSize: 12, borderRadius: 6, border: '1px solid #fda29b', background: '#fff', color: '#b42318', cursor: 'pointer', whiteSpace: 'nowrap' },
    }

    // ------------------------------------------------------------- tool views
    /**
     * Rows for three tools in the transcript (TICKET-023).
     *
     * `presentCall`/`presentResult` are collected by the host but the built-in
     * Web client does not consume them, so a screenshot used to be one line of
     * path text. A keyed `tool.call.toolview` slot keyed by the tool name is
     * what actually replaces the generic row; a typo in a key silently falls
     * back to the generic row, which is why the keys below are exported for the
     * test to compare against the tool names in `plugin/tools.js`.
     *
     * Cards are plain functions returning React elements. `useAttachmentUrl`
     * resolves the screenshot's attachment ref through the host, so no signed
     * URL and no extra vision tokens are involved.
     */
    const TOOL_VIEW_KEYS = ['browser_open', 'browser_screenshot', 'browser_download']

    const ViewS = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: '18px', minWidth: 0 },
      head: { display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 },
      icon: { flex: '0 0 auto', opacity: 0.85 },
      title: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      link: { color: 'inherit', textDecoration: 'underline', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' },
      sub: { opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      note: { opacity: 0.65, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' },
      thumb: { maxWidth: '100%', maxHeight: 220, borderRadius: 6, objectFit: 'contain', border: '1px solid rgba(127,127,127,0.28)', background: 'rgba(127,127,127,0.06)' },
      action: { alignSelf: 'flex-start', padding: 0, border: 0, background: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', opacity: 0.75 },
    }

    /** `meta` is the tool's persisted `presentationMeta`; never assume a shape. */
    function viewMeta(block) {
      const meta = block?.meta
      return meta !== null && typeof meta === 'object' ? meta : {}
    }

    /** Result prose, for cards that only want to echo the failure text. */
    function viewText(block) {
      const content = Array.isArray(block?.content) ? block.content : []
      return content
        .map((item) => (item && item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
        .filter((text) => text !== '')
        .join('\n')
    }

    /** Read an argument lazily; the accessor shape differs between phases. */
    function viewArg(block, name) {
      try {
        const args = block?.args
        if (args && typeof args.text === 'function') {
          const value = args.text(name)
          return typeof value === 'string' ? value : ''
        }
      } catch {
        // A lazy reader can throw while the call is still being prepared.
      }
      return ''
    }

    function viewSize(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / (1024 * 1024)).toFixed(1)} MB`
    }

    function viewFileName(path) {
      const text = typeof path === 'string' ? path : ''
      const parts = text.split(/[\\/]/).filter((part) => part !== '')
      return parts.length > 0 ? parts[parts.length - 1] : text
    }

    /** Resolve an image attachment ref to a displayable URL, once per record. */
    function useAttachmentUrl(loadImage, attachment) {
      const [url, setUrl] = React.useState('')
      React.useEffect(() => {
        let alive = true
        if (attachment === null || typeof attachment !== 'object' || typeof loadImage !== 'function') return undefined
        Promise.resolve()
          .then(() => loadImage(attachment))
          .then((value) => { if (alive) setUrl(typeof value === 'string' ? value : '') })
          .catch(() => { if (alive) setUrl('') })
        return () => { alive = false }
      }, [attachment, loadImage])
      return url
    }

    function ViewHead(icon, title, note) {
      return h('div', { style: ViewS.head },
        h('span', { style: ViewS.icon }, icon),
        h('span', { style: ViewS.title }, title),
        note === '' ? null : h('span', { style: ViewS.sub }, note))
    }

    /** `browser_open`: the address is clickable, so the user need not re-type it. */
    function OpenRow(props) {
      const meta = viewMeta(props.block)
      const failed = props.block?.isError === true
      const pending = props.phase !== 'result'
      const address = typeof meta.url === 'string' && meta.url !== '' ? meta.url : viewArg(props.block, 'url')
      const workspacePath = typeof meta.path === 'string' && meta.path !== '' ? meta.path : viewArg(props.block, 'path')
      const title = typeof meta.title === 'string' ? meta.title : ''
      const target = address !== '' ? address : workspacePath
      return h('div', { style: ViewS.wrap },
        ViewHead('🌐', failed ? '网页打开失败' : pending ? '正在打开网页…' : '在面板里打开了网页', title),
        target === '' ? null
          : address !== ''
            ? h('a', {
              href: address,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: ViewS.link,
              title: address,
            }, address)
            : h('span', { style: ViewS.link }, workspacePath),
        meta.needsHuman === true
          ? h('div', { style: ViewS.note }, '页面正在要人机验证，需要你在右侧浏览器面板里完成。')
          : null,
        failed ? h('div', { style: ViewS.note }, viewText(props.block)) : null)
    }

    /** `browser_screenshot`: the picture itself, plus where the file landed. */
    function ScreenshotRow(props) {
      const meta = viewMeta(props.block)
      const failed = props.block?.isError === true
      const pending = props.phase !== 'result'
      const thumb = meta.thumb
      const url = useAttachmentUrl(props.loadImage, thumb)
      const path = typeof meta.path === 'string' && meta.path !== '' ? meta.path : ''
      const dimensions = Number.isFinite(meta.width) && Number.isFinite(meta.height)
        ? `${meta.width} × ${meta.height} px`
        : ''
      const detail = [dimensions, viewSize(meta.bytes)].filter((part) => part !== '').join(' · ')
      return h('div', { style: ViewS.wrap },
        ViewHead('🖼', failed ? '截图失败' : pending ? '正在截图…' : '浏览器截图', detail),
        url !== '' ? h('img', { src: url, alt: path !== '' ? path : 'browser screenshot', style: ViewS.thumb }) : null,
        path === '' ? null : h('div', { style: ViewS.note }, path),
        meta.truncated === true ? h('div', { style: ViewS.note }, '页面比高度上限更长，截图是截断的。') : null,
        failed ? h('div', { style: ViewS.note }, viewText(props.block)) : null,
        path !== '' && typeof props.openFile === 'function'
          ? h('button', { type: 'button', style: ViewS.action, onClick: () => props.openFile(path) }, '在文件里打开')
          : null)
    }

    /** `browser_download`: name, size, and a digest prefix to tell files apart. */
    function DownloadRow(props) {
      const meta = viewMeta(props.block)
      const failed = props.block?.isError === true || meta.failed === true
      const pending = props.phase !== 'result'
      const path = typeof meta.path === 'string' && meta.path !== '' ? meta.path : ''
      const name = path === '' ? '' : viewFileName(path)
      const digest = typeof meta.sha256 === 'string' && meta.sha256 !== '' ? meta.sha256.slice(0, 12) : ''
      const detail = [viewSize(meta.bytes), digest === '' ? '' : `sha256 ${digest}`].filter((part) => part !== '').join(' · ')
      return h('div', { style: ViewS.wrap },
        ViewHead('⬇', failed ? '下载失败' : pending ? '正在下载…' : '下载了文件', detail),
        name === '' ? null : h('div', { style: ViewS.sub, title: path }, name),
        failed ? h('div', { style: ViewS.note }, meta.reason !== undefined ? String(meta.reason) : viewText(props.block)) : null,
        path !== '' && typeof props.openFile === 'function'
          ? h('button', { type: 'button', style: ViewS.action, onClick: () => props.openFile(path) }, '在文件里打开')
          : null)
    }

    /** Slot key → component; registered as keyed views in `apply`. */
    const TOOL_VIEWS = [
      ['browser_open', OpenRow],
      ['browser_screenshot', ScreenshotRow],
      ['browser_download', DownloadRow],
    ]

    // -------------------------------------------------------------- settings
    /**
     * A page in the shell's Settings panel (`settings.section`, TICKET-036).
     *
     * The page never reads the profile file and never guesses: it asks the host
     * half over the same authenticated bridge the panel uses (`GET /config`) and
     * saves through it (`POST /config`), which hands the patch to DSH's config
     * editor. Fields the schema marks volatile apply on the next tool call; the
     * rest reload the plugin, so the page says so before the button is pressed.
     */
    const SETTINGS_LABEL = '浏览器面板'
    const SETTINGS_ORDER = 300

    /** Read a nested path out of a plain config object. */
    const at = (object, path) => path.reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), object)

    /** Immutably set one nested path; untouched branches keep their identity. */
    function put(object, path, value) {
      const [head, ...rest] = path
      const child = object === null || typeof object !== 'object' ? {} : object
      return rest.length === 0 ? { ...child, [head]: value } : { ...child, [head]: put(child[head], rest, value) }
    }

    /**
     * What the page shows, grouped the way the schema groups it. `path` is
     * resolved against the config document, so a field this build does not have
     * is skipped instead of rendered as an empty control.
     */
    const SETTINGS_GROUPS = [
      {
        title: '行为',
        hint: '这些字段保存后立即生效，下一次工具调用就按新值执行。',
        fields: [
          { path: ['activation'], label: '面板自动打开', kind: 'select', options: [['auto', '自动（需要时）'], ['always', '每次调用都打开'], ['manual', '从不自动打开']] },
          { path: ['routing'], label: '系统提示词路由段', kind: 'select', options: [['off', '关（默认）'], ['auto', '检测到别的浏览器工具时才加'], ['on', '总是加']] },
          { path: ['fitWidth'], label: '导航后把页面缩到面板宽度', kind: 'bool' },
          { path: ['claimBrowserUse'], label: '占用 browserUse 槽，阻止第二个浏览器后端', kind: 'bool' },
          { path: ['evalEnabled'], label: '允许 browser_eval 在页面里执行脚本', kind: 'bool' },
        ],
      },
      {
        title: '预算',
        hint: '保存后插件会重新加载一次：桥端口变了，面板会自动重连。',
        fields: [
          { path: ['limits', 'navigationTimeoutMs'], label: '打开页面超时（毫秒）', kind: 'number', min: 1000, step: 1000 },
          { path: ['limits', 'snapshotMaxChars'], label: '快照默认字符上限', kind: 'number', min: 200, step: 200 },
          { path: ['limits', 'evalMaxChars'], label: 'eval 默认字符上限', kind: 'number', min: 200, step: 200 },
        ],
      },
      {
        title: '下载',
        hint: '浏览器下载落在会话工作目录下，这里是目录、体积上限和额外禁用的扩展名。',
        fields: [
          { path: ['downloads', 'dir'], label: '下载目录', kind: 'text' },
          { path: ['downloads', 'maxBytes'], label: '单文件上限（字节）', kind: 'number', min: 1, step: 1048576 },
          { path: ['downloads', 'extraBlockedExtensions'], label: '额外禁止的扩展名', kind: 'list', transform: (item) => item.replace(/^\./, '').toLowerCase() },
        ],
      },
      {
        title: '搜索兜底',
        hint: '页面打不开时用一次站内搜索补候选链接（每次可能计费），不会自动打开任何页面。',
        fields: [
          { path: ['searchFallback', 'enabled'], label: '开启搜索兜底', kind: 'bool', hint: '这一项立即生效。' },
          { path: ['searchFallback', 'maxResults'], label: '最多候选数', kind: 'number', min: 1, step: 1 },
        ],
      },
      {
        title: '会话白名单',
        hint: '留空表示所有会话都能驱动浏览器；填了就只允许列出的会话 id。',
        fields: [
          { path: ['sessions', 'allowlist'], label: '允许的会话 id', kind: 'list' },
        ],
      },
      {
        title: '本地文件服务',
        hint: '面板不能用 file://，工作区里的页面由回环服务提供；这里是单文件上限。',
        fields: [
          { path: ['static', 'maxBytes'], label: '单文件上限（字节）', kind: 'number', min: 1024, step: 1048576 },
        ],
      },
    ]

    /** Styles, inline on purpose: the client bundle carries no stylesheet. */
    const SET_S = {
      page: { padding: '24px 28px', maxWidth: 780, fontSize: 13, lineHeight: 1.6 },
      title: { fontSize: 17, fontWeight: 600, marginBottom: 4 },
      sub: { opacity: 0.7, marginBottom: 12 },
      status: { display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(127,127,127,0.08)', borderRadius: 8, padding: '8px 10px', marginBottom: 14, flexWrap: 'wrap' },
      group: { borderTop: '1px solid rgba(127,127,127,0.22)', padding: '10px 0' },
      groupTitle: { fontWeight: 600 },
      groupHint: { opacity: 0.7, marginBottom: 6 },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 32, padding: '4px 0' },
      label: { display: 'flex', flexDirection: 'column', gap: 2 },
      fieldHint: { opacity: 0.7, fontSize: 12 },
      input: { minWidth: 220, maxWidth: 320, padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', fontSize: 13 },
      bar: { display: 'flex', gap: 10, alignItems: 'center', borderTop: '1px solid rgba(127,127,127,0.22)', paddingTop: 12, marginTop: 8, flexWrap: 'wrap' },
      button: { padding: '6px 14px', borderRadius: 6, border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', fontSize: 13, cursor: 'pointer' },
      link: { padding: '4px 6px', border: 'none', background: 'transparent', color: '#3370ff', fontSize: 13, cursor: 'pointer' },
      note: { opacity: 0.7 },
      error: { color: '#d92d20', whiteSpace: 'pre-wrap', marginTop: 8 },
    }

    /** The settings page: load, edit, save, and one line of live status. */
    function SettingsPage() {
      const [doc, setDoc] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [health, setHealth] = React.useState(null)
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const data = await callHost('/config', { timeoutMs: 8000 })
          setDoc(data)
          setDraft(JSON.parse(JSON.stringify(data.values ?? {})))
          setError('')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [])

      const loadHealth = React.useCallback(async () => {
        try {
          setHealth(await callHost('/health', { timeoutMs: 6000 }))
        } catch (failure) {
          setHealth({ ok: false, error: String(failure?.message ?? failure) })
        }
      }, [])

      React.useEffect(() => {
        void load()
        void loadHealth()
      }, [load, loadHealth])

      const set = (path, value) => setDraft((current) => put(current ?? {}, path, value))

      const changed = () => {
        const fields = doc?.fields ?? {}
        const patch = {}
        for (const key of Object.keys(fields)) {
          if (JSON.stringify(at(draft, [key])) !== JSON.stringify(at(doc?.values, [key]))) patch[key] = at(draft, [key])
        }
        return patch
      }

      // A restart-class write reloads the plugin half-way through the request, so
      // the reply may never arrive even though the save landed. Ask again until the
      // new values are visible, and only then call it saved.
      const confirmAfterReload = async (patch) => {
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          try {
            const next = await callHost('/config', { timeoutMs: 8_000 })
            const landed = Object.keys(patch).every((key) => JSON.stringify(at(next.values, [key])) === JSON.stringify(patch[key]))
            if (landed) return next
          } catch {
            // The host half is still coming back; try again.
          }
        }
        return null
      }

      const save = async () => {
        const patch = changed()
        if (Object.keys(patch).length === 0) {
          setNote('没有改动。')
          return
        }
        setBusy(true)
        setError('')
        try {
          const data = await callHost('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch }),
            timeoutMs: 20_000,
          })
          setDoc(data)
          setDraft(JSON.parse(JSON.stringify(data.values ?? {})))
          setNote(data.restart === true ? '已保存，插件正在重新加载；面板会自动重连。' : '已保存，立即生效。')
          if (data.restart === true) setTimeout(() => { void loadHealth() }, 2500)
          else void loadHealth()
        } catch (failure) {
          const restartKeys = Object.keys(patch).filter((key) => doc?.fields?.[key] === 'restart')
          const confirmed = restartKeys.length > 0 ? await confirmAfterReload(patch) : null
          if (confirmed !== null) {
            setDoc(confirmed)
            setDraft(JSON.parse(JSON.stringify(confirmed.values ?? {})))
            setNote('已保存，插件已重新加载。')
            setTimeout(() => { void loadHealth() }, 2500)
          } else {
            setError(String(failure?.message ?? failure))
          }
        } finally {
          setBusy(false)
        }
      }

      const control = (field) => {
        const value = at(draft, field.path)
        if (field.kind === 'bool') {
          return h('input', { type: 'checkbox', checked: value !== false, onChange: (event) => set(field.path, event.target.checked) })
        }
        if (field.kind === 'select') {
          return h('select', { style: SET_S.input, value: String(value ?? ''), onChange: (event) => set(field.path, event.target.value) },
            field.options.map(([key, text]) => h('option', { key, value: key }, text)))
        }
        if (field.kind === 'number') {
          return h('input', {
            type: 'number',
            style: SET_S.input,
            value: value === undefined || value === null ? '' : String(value),
            min: field.min,
            step: field.step ?? 1,
            onChange: (event) => {
              const next = Number(event.target.value)
              set(field.path, Number.isFinite(next) ? Math.max(0, Math.round(next)) : 0)
            },
          })
        }
        if (field.kind === 'list') {
          return h('input', {
            type: 'text',
            style: SET_S.input,
            placeholder: '逗号分隔',
            value: Array.isArray(value) ? value.join(', ') : '',
            onChange: (event) => {
              const items = event.target.value.split(',').map((item) => item.trim()).filter((item) => item !== '')
              set(field.path, field.transform === undefined ? items : items.map(field.transform))
            },
          })
        }
        return h('input', {
          type: 'text',
          style: SET_S.input,
          value: value === undefined || value === null ? '' : String(value),
          onChange: (event) => set(field.path, event.target.value),
        })
      }

      if (doc === null) {
        return h('div', { style: SET_S.page },
          h('div', { style: SET_S.title }, SETTINGS_LABEL),
          h('div', { style: SET_S.note }, error === '' ? '正在读取配置…' : `读不到配置：${error}`),
          error === '' ? null : h('div', { style: SET_S.note }, '如果是 501，说明这个 profile 不能保存插件配置（没有 config editor）。'),
          h('button', { type: 'button', style: SET_S.button, onClick: () => { void load(); void loadHealth() } }, '重试'))
      }

      const patch = changed()
      const dirty = Object.keys(patch).length > 0
      const volatileKeys = Object.keys(doc.fields ?? {}).filter((key) => doc.fields[key] === 'volatile')
      const status = health === null
        ? '状态：读取中…'
        : health.ok === true
          ? `状态：桥 ${String(health.origin ?? '')} · 工具 ${String(health.diagnostics?.tools ?? '?')} 个 · 面板 client ${String(health.clients ?? 0)} 个`
          : `状态：读取失败（${String(health.error ?? '未知')}）`

      return h('div', { style: SET_S.page },
        h('div', { style: SET_S.title }, SETTINGS_LABEL),
        h('div', { style: SET_S.sub }, '让 Agent 在当前会话的右侧栏里操作真正的浏览器。这里改的是这个 profile 的这一行配置。'),
        h('div', { style: SET_S.status },
          h('span', null, status),
          h('button', { type: 'button', style: SET_S.link, onClick: () => void loadHealth() }, '刷新状态')),
        SETTINGS_GROUPS.map((group) => {
          const rows = group.fields.filter((field) => at(draft, field.path) !== undefined).map((field) => h('label', { key: field.path.join('.'), style: SET_S.row },
            h('span', { style: SET_S.label },
              field.label,
              field.hint === undefined ? null : h('span', { style: SET_S.fieldHint }, field.hint)),
            control(field)))
          if (rows.length === 0) return null
          return h('section', { key: group.title, style: SET_S.group },
            h('div', { style: SET_S.groupTitle }, group.title),
            h('div', { style: SET_S.groupHint }, group.hint),
            rows)
        }),
        h('div', { style: SET_S.bar },
          h('button', {
            type: 'button',
            style: busy || !dirty ? { ...SET_S.button, opacity: 0.5 } : SET_S.button,
            disabled: busy || !dirty,
            onClick: () => void save(),
          }, busy ? '保存中…' : '保存'),
          h('button', {
            type: 'button',
            style: SET_S.link,
            onClick: () => {
              setDraft(JSON.parse(JSON.stringify(doc.values ?? {})))
              setNote('已还原为当前配置。')
              setError('')
            },
          }, '还原'),
          h('span', { style: SET_S.note }, note !== '' ? note : (dirty ? '有未保存的改动。' : `保存后立即生效的字段：${volatileKeys.join('、') || '无'}`))),
        error === '' ? null : h('div', { style: SET_S.error }, error))
    }

    // ---------------------------------------------------------------- plugin
    /** Services this half needs; all are DSH client services. */
    const inject = ['slots', 'sidebarRight', 'sidebarRightTabs', 'layout']

    /** Register the tab type, its body, and start draining host commands. */
    function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        priority: 'extension',
        keepMounted: true,
        multiple: false,
        title: () => '浏览器',
        guide: [{
          id: 'open',
          order: 40,
          title: () => '浏览器（Agent）',
          description: () => '让 Agent 在右侧打开真实网页，你可以随时接管',
        }],
      }), 'agent-browser.tab')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
      }, Panel)), 'agent-browser.body')

      // Transcript rows (TICKET-023). Each key is a tool name; a wrong key never
      // renders, so `plugin/test/toolviews.test.mjs` compares these with
      // `plugin/tools.js` instead of trusting them.
      for (const [key, View] of TOOL_VIEWS) {
        ctx.effect(
          () => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, View)),
          `agent-browser.toolview.${key}`,
        )
      }

      ctx.effect(() => startPolling(ctx), 'agent-browser.poll')

      // Settings page (TICKET-036). Every plugin with a page in the shell's
      // Settings panel registers one of these; without it the plugin has no
      // place there at all, which is why "where do I turn this on?" was a fair
      // question. Wrapped like the other registrations: a shell without the
      // slot must lose the page, not the panel.
      let settingsPage = false
      ctx.effect(() => {
        const dispose = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: ID,
          order: SETTINGS_ORDER,
          label: () => SETTINGS_LABEL,
        }, SettingsPage))
        settingsPage = true
        return dispose
      }, 'agent-browser.settings')

            report('client half applied', { rev: CLIENT_REV, tabs: typeof ctx.sidebarRightTabs?.register === 'function', sidebar: typeof ctx.sidebarRight?.openTab === 'function', openTabIn: typeof ctx.sidebarRight?.openTabIn === 'function', toolviews: TOOL_VIEW_KEYS.length, settings: settingsPage })
    }

    return { inject, apply }
  },
})
