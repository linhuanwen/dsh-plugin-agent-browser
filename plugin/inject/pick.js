/**
 * In-page element picker (TICKET-053).
 *
 * The person sitting in front of the panel points at the thing the agent should
 * act on; this script turns that one click into a structured reference (a stable
 * `loc`, a readable name, a rect and a viewport point). It is the page-side half
 * of `browser_pick`; the panel drives it as a tiny action state machine:
 *
 *     (<source>)({ action: 'start' })
 *     (<source>)({ action: 'poll' })     // called every ~150ms
 *     (<source>)({ action: 'stop' })
 *
 * State lives on `window.__dshPick` because each evaluate call is a separate
 * script: a closure across calls would not survive. The panel polls, so a
 * cancel frame, a user takeover or a closed panel can stop picking between
 * probes; a page that hangs a timer cannot trap the command (same split as
 * `inject/wait.js`, TICKET-044).
 *
 * The pick **consumes** the click: pointerdown / mousedown / click are handled
 * in the capture phase and stopped there, so the page never sees a click and
 * therefore cannot navigate or submit as a side effect. Picking only answers
 * "which element"; firing the real action is a separate `browser_click` /
 * `browser_type` call (a documented boundary, not an oversight).
 *
 * Local helpers mirror `inject/snapshot.js` (cssPathOf / describe) on purpose:
 * this file is injected alone and must not depend on another source being
 * present in the page.
 *
 * @param {{action?: 'start'|'poll'|'stop'}} [input]
 * @returns {object} {ok, installed?, picked?, cancelled?, hover?}
 */
function dshPick(input) {
  var win = typeof window !== 'undefined' ? window : null
  var doc = typeof document !== 'undefined' ? document : null
  if (win === null || doc === null) return { ok: false, error: 'pick needs a page document' }
  var action = input && typeof input.action === 'string' ? input.action : 'poll'

  function current() {
    var state = win.__dshPick
    return state !== null && typeof state === 'object' ? state : null
  }

  function url() {
    try {
      return win.location && typeof win.location.href === 'string' ? win.location.href : ''
    } catch (error) {
      return ''
    }
  }

  function remove(handle) {
    try {
      handle[0].removeEventListener(handle[1], handle[2], handle[3])
    } catch (error) {
      // A detached document or a frozen listener is not worth failing the pick.
    }
  }

  function cleanup(state) {
    if (state.cleaned !== true) {
      state.cleaned = true
      var listeners = state.listeners || []
      for (var index = 0; index < listeners.length; index += 1) remove(listeners[index])
      state.listeners = []
      var overlay = state.overlay
      if (overlay !== null && overlay !== undefined && overlay.parentNode) {
        try {
          overlay.parentNode.removeChild(overlay)
        } catch (error) {
          // Gone already.
        }
      }
      state.overlay = null
      try {
        if (doc.body && doc.body.style) doc.body.style.cursor = state.previousCursor || ''
      } catch (error) {
        // Styles are best effort.
      }
    }
    if (typeof state.releaseSwallow === 'function') {
      var release = state.releaseSwallow
      state.releaseSwallow = null
      try {
        release()
      } catch (error) {
        // The swallow listener is already gone.
      }
    }
  }

  /** True when the element is rendered (has a box); hidden shortcuts return false. */
  function rendered(element) {
    if (element === null || element === undefined) return false
    try {
      if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false
      var view = win && typeof win.getComputedStyle === 'function' ? win : null
      var style = view === null ? null : view.getComputedStyle(element)
      if (style !== null && style !== undefined) {
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
      }
      return true
    } catch (error) {
      return true
    }
  }

  /** Tag / role / accessible-ish name, short enough for a tool card. */
  function describe(element) {
    var tag = element && element.tagName ? String(element.tagName).toLowerCase() : ''
    var role = ''
    var label = ''
    try {
      role = element.getAttribute ? String(element.getAttribute('role') || '') : ''
      if (role === '') {
        if (tag === 'button') role = 'button'
        else if (tag === 'a') role = 'link'
        else if (tag === 'input') {
          var type = String(element.getAttribute('type') || 'text').toLowerCase()
          role = type === 'submit' || type === 'button' || type === 'reset' ? 'button' : 'textbox'
        } else if (tag === 'select') role = 'combobox'
        else if (tag === 'textarea') role = 'textbox'
        else if (tag === 'img') role = 'img'
      }
      var aria = element.getAttribute('aria-label')
      if (aria) label = String(aria)
      if (label === '') {
        var title = element.getAttribute('title')
        if (title) label = String(title)
      }
      if (label === '') {
        var placeholder = element.getAttribute('placeholder')
        if (placeholder) label = String(placeholder)
      }
      if (label === '' && element.labels && element.labels.length > 0) label = String(element.labels[0].innerText || element.labels[0].textContent || '')
      if (label === '') label = String(element.innerText || element.textContent || '')
    } catch (error) {
      label = ''
    }
    label = label.replace(/\s+/g, ' ').trim().slice(0, 80)
    return { tag: tag, role: role, name: label }
  }

  /** Short CSS path to an element, or '' when no verified path exists. */
  function cssPathOf(element) {
    var parts = []
    var node = element
    var depth = 0
    while (node && node.nodeType === 1 && depth < 12) {
      depth += 1
      var tag = String(node.tagName || '').toLowerCase()
      var anchor = ''
      var id = node.getAttribute ? node.getAttribute('id') : ''
      if (id && /^[A-Za-z][\w.:-]*$/.test(id)) anchor = '#' + id
      if (anchor === '' && node.getAttribute) {
        var testId = node.getAttribute('data-testid')
        if (testId && /^[\w.:-]+$/.test(testId)) anchor = '[data-testid="' + testId + '"]'
      }
      if (anchor === '' && node.getAttribute && (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' || tag === 'form')) {
        var name = node.getAttribute('name')
        if (name) anchor = tag + '[name="' + String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]'
      }
      if (anchor !== '') {
        var path = anchor + (parts.length === 0 ? '' : ' > ' + parts.join(' > '))
        var hit = null
        try {
          hit = doc.querySelector(path)
        } catch (error) {
          hit = null
        }
        if (hit === node) return path.length <= 120 ? path : ''
      }
      var parent = node.parentElement
      if (!parent) break
      var index = 1
      var kids = parent.children || []
      for (var i = 0; i < kids.length; i += 1) {
        if (kids[i] === node) break
        if (kids[i].tagName === node.tagName) index += 1
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')')
      node = parent
    }
    var joined = parts.join(' > ')
    if (joined === '') return ''
    if (joined.length > 120) return ''
    try {
      return doc.querySelector(joined) === element ? joined : ''
    } catch (error) {
      return ''
    }
  }

  /** The loc format every other tool accepts: css:<path>. */
  function pickLoc(element) {
    var path = cssPathOf(element)
    return path === '' ? '' : 'css:' + path
  }

  function rectOf(element) {
    try {
      var rect = element.getBoundingClientRect()
      return {
        x: Math.round(Number(rect.left) || 0),
        y: Math.round(Number(rect.top) || 0),
        width: Math.round(Number(rect.width) || 0),
        height: Math.round(Number(rect.height) || 0),
      }
    } catch (error) {
      return { x: 0, y: 0, width: 0, height: 0 }
    }
  }

  function listen(state, target, type, handler) {
    try {
      target.addEventListener(type, handler, true)
      state.listeners.push([target, type, handler, true])
    } catch (error) {
      // A sandboxed document may refuse some targets; the pick still works for
      // the ones that attached.
    }
  }

  /**
   * Swallow the one `click` that the browser fires after the pointerdown we
   * just consumed. The pick finishes on pointerdown (so it works even when the
   * page would cancel the click), which means listeners are already removed by
   * the time the click event is dispatched — without this, the page's own
   * document-level click listener would still see the pick.
   * @param {object} state
   */
  function swallowNextClick(state) {
    var released = false
    function release() {
      if (released) return
      released = true
      try {
        win.removeEventListener('click', onClick, true)
      } catch (error) {
        // Best effort.
      }
      try {
        win.removeEventListener('pointerup', onUp, true)
        win.removeEventListener('mouseup', onUp, true)
      } catch (error) {
        // Best effort.
      }
      state.releaseSwallow = null
    }
    function onClick(event) {
      try {
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        if (event && typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      } catch (error) {
        // Best effort.
      }
      release()
    }
    function onUp() {
      // The click (if any) is dispatched before the next macrotask.
      setTimeout(release, 0)
    }
    state.releaseSwallow = release
    try {
      win.addEventListener('click', onClick, true)
      win.addEventListener('pointerup', onUp, true)
      win.addEventListener('mouseup', onUp, true)
    } catch (error) {
      // A frozen window cannot swallow the click; the pick itself still works.
    }
  }

  function finish(state, picked, swallowClick) {
    state.picked = picked
    state.hover = null
    cleanup(state)
    if (swallowClick === true) swallowNextClick(state)
  }

  function start() {
    var existing = current()
    if (existing !== null && existing.cleaned !== true) return { ok: true, installed: true, already: true }
    var state = {
      picked: null,
      cancelled: false,
      hover: null,
      overlay: null,
      listeners: [],
      cleaned: false,
      previousCursor: '',
      startedAt: Date.now(),
    }
    win.__dshPick = state
    var overlay = null
    try {
      overlay = doc.createElement('div')
      overlay.setAttribute('data-dsh-pick', 'overlay')
      overlay.style.cssText = 'position:fixed;display:none;pointer-events:none;z-index:2147483646;'
        + 'border:2px solid #2f6feb;background:rgba(47,111,235,0.12);border-radius:4px;box-sizing:border-box;'
      if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(overlay)
    } catch (error) {
      overlay = null
    }
    state.overlay = overlay
    try {
      if (doc.body && doc.body.style) {
        state.previousCursor = doc.body.style.cursor || ''
        doc.body.style.cursor = 'crosshair'
      }
    } catch (error) {
      // Best effort.
    }

    listen(state, win, 'pointermove', function (event) {
      var x = Math.round(Number(event && event.clientX) || 0)
      var y = Math.round(Number(event && event.clientY) || 0)
      state.hover = { x: x, y: y }
      var element = null
      try {
        element = doc.elementFromPoint(x, y)
      } catch (error) {
        element = null
      }
      if (overlay !== null && element !== null && rendered(element)) {
        var rect = rectOf(element)
        overlay.style.left = rect.x + 'px'
        overlay.style.top = rect.y + 'px'
        overlay.style.width = rect.width + 'px'
        overlay.style.height = rect.height + 'px'
        overlay.style.display = 'block'
      } else if (overlay !== null) {
        overlay.style.display = 'none'
      }
    })
    listen(state, win, 'pointerdown', function (event) {
      if (event && typeof event.button === 'number' && event.button !== 0) return
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      if (event && typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
      var element = event && event.target ? event.target : null
      if (element === null || element === doc) return
      finish(state, {
        loc: pickLoc(element),
        info: describe(element),
        rect: rectOf(element),
        point: { x: Math.round(Number(event.clientX) || 0), y: Math.round(Number(event.clientY) || 0) },
        url: url(),
      }, true)
    })
    // Some pages synthesize clicks without a pointerdown (assistive tech, old
    // mouse handlers); catch those too, once, before they reach the page.
    listen(state, win, 'click', function (event) {
      if (state.picked !== null || state.cleaned === true) return
      if (event && typeof event.preventDefault === 'function') event.preventDefault()
      if (event && typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
      var element = event && event.target ? event.target : null
      if (element === null || element === doc) return
      finish(state, {
        loc: pickLoc(element),
        info: describe(element),
        rect: rectOf(element),
        point: { x: Math.round(Number(event.clientX) || 0), y: Math.round(Number(event.clientY) || 0) },
        url: url(),
      })
    })
    listen(state, win, 'keydown', function (event) {
      if (event && (event.key === 'Escape' || event.key === 'Esc')) {
        state.cancelled = true
        cleanup(state)
      }
    })
    return { ok: true, installed: true }
  }

  function poll() {
    var state = current()
    if (state === null) return { ok: true, picked: null, cancelled: false, hover: null, gone: true }
    if (state.picked !== null) return { ok: true, picked: state.picked, cancelled: false, hover: null }
    if (state.cleaned === true) {
      return { ok: true, picked: null, cancelled: true, hover: null, gone: true }
    }
    return { ok: true, picked: null, cancelled: state.cancelled === true, hover: state.hover, gone: false }
  }

  function stop() {
    var state = current()
    if (state !== null) cleanup(state)
    try {
      delete win.__dshPick
    } catch (error) {
      win.__dshPick = null
    }
    return { ok: true }
  }

  if (action === 'start') return start()
  if (action === 'stop') return stop()
  return poll()
}
