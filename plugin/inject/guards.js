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
 * @param {'agent' | 'human'} driver - who is driving right now
 * @returns {{ rev: number, driver: string }} what was installed
 */
function dshGuards(driver) {
  var REV = 2
  var NAV_TARGETS = { _self: true, _top: true, _parent: true }

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
