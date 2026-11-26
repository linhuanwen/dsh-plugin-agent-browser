/**
 * Page-side click guards, injected on every document by the panel.
 *
 * Why this is separate from `inject/actions.js`: the guards in that file are
 * installed by `dshAction` itself, i.e. only once the host has run an action
 * command in the current document. A person who takes over a freshly loaded
 * page and clicks a product card has not run any command yet, so that document
 * had no listeners at all — the click asked for a `target="_blank"` window,
 * Chromium dropped it (the `<webview>` allows no popups) and the click looked
 * dead. The panel now injects this file on every `dom-ready` / navigation, so
 * the guard exists before the first human click (TICKET-032).
 *
 * `inject/actions.js` detects this file (`window.__dshGuardInstalled`) and
 * skips its own copy, so a document never wires two sets of guards.
 *
 * Mode is read from `window.__dshDriver` at event time, not baked in: the
 * phase can change many times around one document, and actions.js reads the
 * same flag.
 *
 * `agent`: new windows are refused (a popup is a window the panel cannot
 * drive); the requested url is recorded in `window.__dshBlocked` so the host
 * can report `blocked_new_window`.
 * `human`: the same click navigates this view instead — a person clicking a
 * link expects the page to change, not to be blocked.
 *
 * JS dialogs (TICKET-041) are handled here too, because they share the only
 * prerequisite the guards already have: this file runs on every document the
 * panel loads. `alert`/`confirm`/`prompt` block the guest's renderer until a
 * person clicks the OS dialog, which would hang every tool call; the wrapper
 * records the dialog and answers conservatively (`confirm` → false, `prompt` →
 * null) so the page keeps running and the agent can see what the page wanted.
 * `dialogs: 'off'` calls the original function instead (native behaviour).
 *
 * Network failures (TICKET-051) are recorded here for the same reason: the
 * page's own `fetch`/XHR failures are usually swallowed by the app, so a click
 * that "did nothing" can be an API call that returned 500 and a console that
 * never said so. The wrappers always call the original function; only failed
 * requests (non-2xx, transport error, XHR status 0) are remembered, and only
 * the counts are kept for successes.
 *
 * @param {'agent' | 'human'} driver - who is driving right now
 * @param {{ dialogs?: 'record' | 'off' }} [options] - dialog policy
 * @returns {{ rev: number, driver: string }} what was installed
 */
function dshGuards(driver, options) {
  var REV = 5
  var NAV_TARGETS = { _self: true, _top: true, _parent: true }
  var input = options || {}
  if (input.dialogs === 'off' || input.dialogs === 'record') window.__dshDialogsMode = input.dialogs

  window.__dshGuardRev = REV
  if (driver === 'human' || driver === 'agent') window.__dshDriver = driver

  function human() {
    return window.__dshDriver === 'human'
  }

  function remember(url) {
    try {
      if (Array.isArray(window.__dshBlocked) === false) window.__dshBlocked = []
      window.__dshBlocked.push(url)
    } catch (error) {
      // Recording is a courtesy; refusing the popup is the contract.
    }
  }

  /**
   * Record one dialog and keep the last few, newest last.
   *
   * The message is capped because a page can put anything in it; the host only
   * needs enough to tell the agent what the page wanted.
   */
  function rememberDialog(kind, message) {
    try {
      if (Array.isArray(window.__dshDialogs) === false) window.__dshDialogs = []
      window.__dshDialogs.push({
        kind: kind,
        message: String(message === undefined || message === null ? '' : message).slice(0, 300),
        at: Date.now(),
      })
      if (window.__dshDialogs.length > 20) window.__dshDialogs.splice(0, window.__dshDialogs.length - 20)
    } catch (error) {
      // A page that froze the array keeps its own behaviour.
    }
  }

  function dialogsOff() {
    return window.__dshDialogsMode === 'off'
  }

  /**
   * Replace the three blocking dialog functions with record-and-answer stubs.
   *
   * `alert` returns undefined, `confirm` returns false, `prompt` returns null:
   * the conservative answers, so a page that asked "are you sure?" does not
   * proceed on a guess. The originals are kept for `dialogs: 'off'`.
   */
  function installDialogs() {
    if (window.__dshDialogsInstalled === true) return
    try {
      var nativeAlert = window.alert
      var nativeConfirm = window.confirm
      var nativePrompt = window.prompt
      window.__dshDialogsInstalled = true
      window.__dshDialogs = Array.isArray(window.__dshDialogs) ? window.__dshDialogs : []
      window.alert = function (message) {
        if (dialogsOff() && typeof nativeAlert === 'function') return nativeAlert.call(window, message)
        rememberDialog('alert', message)
        return undefined
      }
      window.confirm = function (message) {
        if (dialogsOff() && typeof nativeConfirm === 'function') return nativeConfirm.call(window, message)
        rememberDialog('confirm', message)
        return false
      }
      window.prompt = function (message, defaultValue) {
        if (dialogsOff() && typeof nativePrompt === 'function') return nativePrompt.call(window, message, defaultValue)
        rememberDialog('prompt', message)
        return null
      }
    } catch (error) {
      // No dialog surface to patch: the page keeps the native dialogs.
    }
  }

  /**
   * Record one console line and keep the last few, newest last (TICKET-049).
   *
   * The page's own log is often the only account of why a click did nothing;
   * without it the agent can only guess from the DOM. Entries are capped and
   * trimmed because a page can log without limit and every character comes back
   * to the model.
   */
  function rememberLog(level, text) {
    try {
      if (Array.isArray(window.__dshConsole) === false) window.__dshConsole = []
      window.__dshConsole.push({
        level: level,
        text: String(text === undefined || text === null ? '' : text).slice(0, 240),
        at: Date.now(),
      })
      if (window.__dshConsole.length > 40) window.__dshConsole.splice(0, window.__dshConsole.length - 40)
    } catch (error) {
      // A page that froze the array keeps its own console behaviour.
    }
  }

  function logText(args) {
    var parts = []
    for (var index = 0; index < args.length; index += 1) {
      var value = args[index]
      var text
      try {
        if (typeof value === 'string') text = value
        else if (value instanceof Error) text = String(value.name || 'Error') + ': ' + String(value.message || '')
        else text = String(value)
      } catch (error) {
        text = '[unprintable]'
      }
      parts.push(text)
    }
    return parts.join(' ')
  }

  /**
   * Wrap the page's console and record uncaught errors, keeping the page's own
   * logging intact: the original function still runs. `__dshConsole` is drained
   * by the panel after a snapshot.
   */
  function installConsole() {
    if (window.__dshConsoleInstalled === true) return
    try {
      window.__dshConsoleInstalled = true
      window.__dshConsole = Array.isArray(window.__dshConsole) ? window.__dshConsole : []
      var levels = ['log', 'info', 'warn', 'error', 'debug']
      for (var index = 0; index < levels.length; index += 1) {
        (function (level) {
          var original = window.console && window.console[level]
          if (typeof original !== 'function') return
          window.console[level] = function () {
            try {
              rememberLog(level, logText(arguments))
            } catch (error) {
              // Recording is a courtesy; the page keeps running.
            }
            return original.apply(window.console, arguments)
          }
        })(levels[index])
      }
      window.addEventListener('error', function (event) {
        var message = event && event.message ? String(event.message) : 'script error'
        var where = event && event.filename ? ' (' + String(event.filename) + ':' + String(event.lineno || 0) + ')' : ''
        rememberLog('pageerror', message + where)
      })
      window.addEventListener('unhandledrejection', function (event) {
        var reason = event && event.reason
        var text
        try {
          text = reason instanceof Error
            ? String(reason.name || 'Error') + ': ' + String(reason.message || '')
            : String(reason)
        } catch (error) {
          text = '[unprintable]'
        }
        rememberLog('unhandled', text)
      })
    } catch (error) {
      // No console surface to patch: the page keeps its own logging.
    }
  }

  /**
   * Record one failed page request and keep the last few, newest last
   * (TICKET-051).
   *
   * The panel drains this on every snapshot. Only failures are stored so a
   * chatty page cannot flood the model with transport traffic; the total count
   * is kept separately so the tail can say "3 failed of 12 requests".
   */
  function rememberNet(entry) {
    try {
      if (Array.isArray(window.__dshNetwork) === false) window.__dshNetwork = []
      window.__dshNetwork.push(entry)
      if (window.__dshNetwork.length > 40) window.__dshNetwork.splice(0, window.__dshNetwork.length - 40)
    } catch (error) {
      // A page that froze the array keeps its own behaviour.
    }
  }

  function bumpNetTotal() {
    try {
      var total = typeof window.__dshNetCount === 'number' ? window.__dshNetCount : 0
      window.__dshNetCount = total + 1
    } catch (error) {
      // Counting is a courtesy; the request itself must not be affected.
    }
  }

  /**
   * Turn a request target into something short and readable.
   *
   * A full URL with its query string is often what tells two API calls apart,
   * but it can be long; same-origin targets lose the origin because the page is
   * already the context.
   */
  function netUrl(value) {
    var text
    try {
      text = String(value === undefined || value === null ? '' : value)
    } catch (error) {
      return '[unprintable]'
    }
    try {
      var base = window.location && typeof window.location.href === 'string' ? window.location.href : undefined
      var parsed = new URL(text, base)
      if (window.location && parsed.origin === window.location.origin) text = parsed.pathname + parsed.search
      else text = parsed.href
    } catch (error) {
      // A relative or opaque target: keep the page's own spelling.
    }
    return text.slice(0, 200)
  }

  function netErrorText(error) {
    try {
      if (error instanceof Error) return (String(error.name || 'Error') + ': ' + String(error.message || '')).slice(0, 200)
      return String(error).slice(0, 200)
    } catch (inner) {
      return '[unprintable]'
    }
  }

  /**
   * Wrap `fetch` and `XMLHttpRequest` to record failed requests (TICKET-051).
   *
   * Both wrappers call the original implementation, so the page keeps its own
   * semantics (`fetch` still returns the same promise, XHR still fires its
   * events). `no-cors` responses are opaque — the status is unreadable — and
   * are counted as success rather than reported as a failure.
   */
  function installNetwork() {
    if (window.__dshNetworkInstalled === true) return
    try {
      window.__dshNetworkInstalled = true
      window.__dshNetwork = Array.isArray(window.__dshNetwork) ? window.__dshNetwork : []
      window.__dshNetCount = typeof window.__dshNetCount === 'number' ? window.__dshNetCount : 0
      var nativeFetch = window.fetch
      if (typeof nativeFetch === 'function') {
        window.fetch = function (input, init) {
          var method = 'GET'
          try {
            if (init && typeof init === 'object' && init.method) method = String(init.method).toUpperCase()
            else if (input && typeof input === 'object' && input.method) method = String(input.method).toUpperCase()
          } catch (error) {
            // A frozen Request object keeps the default method label.
          }
          var started = Date.now()
          var pending = nativeFetch.apply(this, arguments)
          return pending.then(function (response) {
            bumpNetTotal()
            try {
              var opaque = response && (response.type === 'opaque' || response.type === 'opaqueredirect')
              if (opaque !== true && response && response.ok === false) {
                var status = typeof response.status === 'number' ? response.status : 0
                rememberNet({ kind: 'fetch', method: method, url: netUrl(input), status: status, ms: Date.now() - started })
              }
            } catch (error) {
              // Recording is a courtesy; the page keeps its response.
            }
            return response
          }, function (error) {
            bumpNetTotal()
            try {
              rememberNet({ kind: 'fetch', method: method, url: netUrl(input), status: 0, ms: Date.now() - started, error: netErrorText(error) })
            } catch (inner) {
              // Recording is a courtesy; the rejection still propagates.
            }
            throw error
          })
        }
      }
      var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype
      if (proto && proto.__dshNet !== true) {
        var originalOpen = proto.open
        var originalSend = proto.send
        proto.open = function (method, url) {
          try {
            this.__dshNetRequest = {
              method: String(method === undefined || method === null ? 'GET' : method).toUpperCase(),
              url: url,
              started: Date.now(),
            }
          } catch (error) {
            // The request still opens; only the label is lost.
          }
          return originalOpen.apply(this, arguments)
        }
        proto.send = function () {
          var request = this.__dshNetRequest
          if (request) {
            var target = this
            try {
              target.addEventListener('loadend', function () {
                bumpNetTotal()
                try {
                  var status = typeof target.status === 'number' ? target.status : 0
                  if (status >= 400 || status === 0) {
                    var entry = { kind: 'xhr', method: request.method, url: netUrl(request.url), status: status, ms: Date.now() - request.started }
                    if (status === 0) entry.error = 'request failed or aborted'
                    rememberNet(entry)
                  }
                } catch (error) {
                  // Recording is a courtesy; the page keeps its events.
                }
              })
            } catch (error) {
              // No listener surface: the request still sends.
            }
          }
          return originalSend.apply(this, arguments)
        }
        proto.__dshNet = true
      }
    } catch (error) {
      // No fetch/XHR surface to patch: the page keeps its own network behaviour.
    }
  }

  function rewriteTarget(node) {
    try {
      if (node === null || node === undefined || typeof node.getAttribute !== 'function') return
      var target = node.getAttribute('target')
      if (target === null || target === '' || NAV_TARGETS[target] === true) return
      node.setAttribute('target', '_self')
      var formtarget = node.getAttribute ? node.getAttribute('formtarget') : null
      if (formtarget !== null && formtarget !== '' && NAV_TARGETS[formtarget] !== true) {
        node.setAttribute('formtarget', '_self')
      }
    } catch (error) {
      // A page is free to wrap getAttribute in anything; the guard is best effort.
    }
  }

  function closestLink(node) {
    try {
      if (node === null || node === undefined) return null
      if (typeof node.closest === 'function') return node.closest('a[href], form')
    } catch (error) {
      return null
    }
    return null
  }

  function install() {
    if (window.__dshGuardInstalled === true) return
    window.__dshGuardInstalled = true
    window.__dshGuardRev = REV
    try {
      document.addEventListener('click', function (event) {
        rewriteTarget(closestLink(event.target))
      }, true)
      document.addEventListener('submit', function (event) {
        rewriteTarget(event.target)
      }, true)
    } catch (error) {
      // No capture phase: agent clicks still rewrite the target eagerly.
    }
    installDialogs()
    installConsole()
    installNetwork()
    // 1688's search button calls `form.submit()` directly, which fires no
    // `submit` event. Patching the method is the only way to catch that path.
    try {
      var proto = window.HTMLFormElement && window.HTMLFormElement.prototype
      if (proto && proto.__dshSubmit !== true) {
        var originalSubmit = proto.submit
        proto.submit = function () {
          rewriteTarget(this)
          return originalSubmit.apply(this, arguments)
        }
        proto.__dshSubmit = true
      }
    } catch (error) {
      // No prototype to patch: `submit` events and eager rewriting still apply.
    }
    try {
      window.open = function (url) {
        var requested = String(url === undefined || url === null ? '' : url)
        if (requested !== '' && human()) {
          // Same tab: the panel keeps driving what the person just asked for.
          try {
            window.location.assign(requested)
            return null
          } catch (error) {
            // Unparseable url: fall through to refusing it.
          }
        }
        remember(requested)
        return null
      }
    } catch (error) {
      // A page that froze `window.open` keeps its own semantics.
    }
  }

  install()
  return { rev: REV, driver: window.__dshDriver === 'human' ? 'human' : 'agent' }
}
