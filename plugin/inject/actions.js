/**
 * Page-side half of the action tools: resolve a ref or a selector, scroll it
 * into view, hit-test it, and report where it is (or why it cannot be acted on).
 *
 * Injected as `(${source})(op, params)` and expected to return JSON. The host
 * never touches the DOM directly —`executeJavaScript` is the only way in —so
 * everything that needs a document lives here.
 *
 * Refs come from `inject/snapshot.js`: `data-dsh-ref` on the element, and
 * `data-dsh-frame="1"` on the iframe whose refs are prefixed `f1`.
 *
 * Everything here uses a deliberately small DOM surface —`querySelectorAll`,
 * `elementFromPoint`, `getBoundingClientRect`, `getComputedStyle`— so the same
 * source can be exercised in a unit test with a stub document
 * (`test/actions.test.mjs`).
 */

/**
 * @param {'click'|'type'|'inspect'|'scroll'} op - what to do in the page.
 * @param {object} params - `{ ref, selector, strict, text, clear, dy, to, container }`.
 * @returns {string} JSON: `{ ok: true, …}` or `{ ok: false, error, …}`.
 */
function dshAction(op, params) {
  var input = params || {}
  var REF = /^(f\d+)?e(\d+)$/

  function fail(error, extra) {
    var out = { ok: false, error: error }
    if (extra) for (var key in extra) out[key] = extra[key]
    return JSON.stringify(out)
  }

  /**
   * Install the two guards that keep a click inside this one view.
   *
   * `window.open` is replaced once per document: every call is recorded and
   * answered with `null`, because a popup would be a window the panel cannot
   * see or drive (spec A15). The recorded urls travel back with the next
   * action result so the host can report `blocked_new_window`.
   */
  function installGuards() {
    // The panel injects `inject/guards.js` on every document (TICKET-032), so a
    // document the person is looking at already has the guards before their
    // first click. That copy is a superset of this one; wiring a second set
    // would double-wrap `window.open` and split `__dshBlocked`.
    if (window.__dshGuardInstalled === true) return
    if (window.__dshGuardRev === 1) return
    window.__dshGuardRev = 1
    window.__dshBlocked = []
    try {
      window.open = function (url) {
        var requested = String(url == null ? '' : url)
        try {
          window.__dshBlocked.push(requested)
        } catch (error) {
          // Recording is a courtesy; refusing the popup is the contract.
        }
        // A human who clicked a card that opens a new tab expects to go there.
        // The agent gets `null` plus a `blocked_new_window` note instead, because
        // a popup would be a window the panel cannot see or drive (spec A15).
        if (window.__dshDriver === 'human' && /^https?:\/\//i.test(requested)) {
          try {
            window.location.assign(requested)
          } catch (error) {
            // No navigation surface here: the block still holds.
          }
        }
        return null
      }
    } catch (error) {
      // A page that froze `window.open` keeps its own semantics.
    }
    // The human's clicks never go through `dshAction`, so the same-view rewrite
    // has to happen on the capture path too: a `target="_blank"` link otherwise
    // asks Chromium for a window the panel does not have, and the click looks
    // dead. Rewriting the attribute keeps the navigation inside this view.
    try {
      document.addEventListener('click', function (event) {
        var element = event.target
        var depth = 0
        while (element && element !== document && depth < 8) {
          if (element.tagName === 'A' || element.tagName === 'FORM') {
            neutralizeTarget(element)
            return
          }
          element = element.parentElement
          depth += 1
        }
      }, true)
    } catch (error) {
      // No capture phase: agent clicks still rewrite the target eagerly.
    }
    // A form whose target is `_blank` submits into a window the panel never
    // sees, and Chromium drops that request silently: the click "succeeds" and
    // nothing happens. Rewriting the target on the way out is the same deal we
    // make for links, and it also catches Enter-key submissions that never go
    // through a click at all.
    try {
      document.addEventListener('submit', function (event) {
        var form = event.target
        if (!form || form.tagName !== 'FORM') return
        var target = form.getAttribute('target')
        if (!target || /^_(self|top|parent)$/i.test(target)) return
        form.setAttribute('target', '_self')
      }, true)
    } catch (error) {
      // No submit interception: clicks still rewrite the target eagerly.
    }
    // 1688's search button is outside the form and calls `form.submit()`
    // directly, which fires no `submit` event at all. Patching the method is
    // the only way to catch that path.
    try {
      var proto = window.HTMLFormElement && window.HTMLFormElement.prototype
      if (proto && proto.__dshSubmit !== true) {
        var original = proto.submit
        proto.submit = function () {
          try {
            var target = this.getAttribute('target')
            if (target && !/^_(self|top|parent)$/i.test(target)) this.setAttribute('target', '_self')
          } catch (error) {
            // A frozen form keeps its own semantics.
          }
          return original.apply(this, arguments)
        }
        proto.__dshSubmit = true
      }
    } catch (error) {
      // No prototype to patch: `submit` events and eager rewriting still apply.
    }
  }

  /** Urls `window.open` was asked for since the last result, oldest first. */
  function takeBlocked() {
    var list = Array.isArray(window.__dshBlocked) ? window.__dshBlocked.slice(0, 5) : []
    window.__dshBlocked = []
    return list
  }

  /** The document that owns a ref, or null when the frame is gone. */
  function frameDocument(prefix) {
    if (!prefix) return document
    var host = document.querySelector('[data-dsh-frame="' + prefix + '"]')
    if (!host) return null
    try {
      return host.contentDocument || null
    } catch (error) {
      return null
    }
  }

  function resolve(ref) {
    var match = REF.exec(String(ref || ''))
    if (!match) return { error: 'bad_ref' }
    var frame = match[1] ? match[1].slice(1) : ''
    var doc = frameDocument(frame)
    if (!doc) return { error: 'stale_ref', frame: frame }
    // `data-dsh-ref` carries the full ref, prefix included (`f1e5` inside `f1`).
    var element = doc.querySelector('[data-dsh-ref="' + (match[1] || '') + 'e' + match[2] + '"]')
    if (!element) return { error: 'stale_ref', frame: frame }
    return { element: element, doc: doc, frame: frame }
  }

  /**
   * The element a stable `css:` locator points at.
   *
   * Refs renumber on every snapshot, so a model that holds a ref across two
   * snapshots acts on a stale or — worse — a different node. The snapshot
   * prints a verified CSS path next to each ref for exactly this case. The
   * shape is `css:<selector>` with the same optional `f1:` frame prefix the
   * refs use. A locator is advisory: if the page re-rendered away from it the
   * answer is `stale_loc` and the caller takes a fresh snapshot, never a guess.
   */
  function resolveLoc(locator) {
    var text = String(locator || '')
    var frame = ''
    var doc = document
    var prefixed = /^(f\d+):([\s\S]*)$/.exec(text)
    if (prefixed) {
      frame = prefixed[1].slice(1)
      text = prefixed[2]
      doc = frameDocument(frame)
      if (!doc) return { error: 'stale_loc', frame: frame }
    }
    if (text.slice(0, 4) !== 'css:') return { error: 'bad_loc' }
    var expression = text.slice(4)
    if (expression === '') return { error: 'bad_loc' }
    var element = null
    try {
      element = doc.querySelector(expression)
    } catch (error) {
      return { error: 'bad_loc' }
    }
    if (!element) return { error: 'stale_loc', frame: frame }
    return { element: element, doc: doc, frame: frame }
  }

  /** A short, human-readable description of what the ref points at. */
  function describe(element, doc) {
    var tag = element.tagName.toLowerCase()
    var role = element.getAttribute('role') || ''
    if (!role) {
      if (tag === 'a') role = 'link'
      else if (tag === 'button') role = 'button'
      else if (tag === 'select') role = 'combobox'
      else if (tag === 'textarea') role = 'textbox'
      else if (tag === 'input') {
        var type = String(element.type || 'text').toLowerCase()
        if (type === 'password') role = 'password'
        else if (type === 'checkbox' || type === 'radio') role = type
        else if (/^(submit|button|reset|image)$/.test(type)) role = 'button'
        else role = 'textbox'
      } else role = tag
    }
    var name = element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('title') || ''
    if (!name && element.labels && element.labels.length > 0) {
      name = (element.labels[0].innerText || '').trim()
    }
    if (!name && element.id && doc) {
      var label = doc.querySelector('label[for="' + element.id.replace(/"/g, '\\"') + '"]')
      if (label) name = (label.innerText || '').trim()
    }
    if (!name) {
      var text = (element.innerText || element.value || '').replace(/\s+/g, ' ').trim()
      name = text.slice(0, 80)
    }
    return { tag: tag, role: role, name: String(name).replace(/\s+/g, ' ').trim().slice(0, 80) }
  }

  /**
   * Whether activating this control submits a form.
   *
   * The three shapes the spec names (SPEC-003 C2): an explicit submit button, a
   * submit/image input, or a `<button>` inside a form with no type of its own —
   * whose default type is submit. Everything else (links, `type="button"`) is a
   * read as far as the permission gate is concerned.
   */
  function isSubmitControl(element) {
    if (!element || element.nodeType !== 1) return false
    var tag = element.tagName.toLowerCase()
    var type = String(element.getAttribute('type') || '').toLowerCase()
    if (tag === 'button') return type === '' || type === 'submit'
    if (tag === 'input') return type === 'submit' || type === 'image'
    return false
  }

  /** Inline style says "not rendered" (display/visibility) or fully transparent. */
  function hiddenByStyle(element) {
    var style = null
    try {
      style = window.getComputedStyle ? window.getComputedStyle(element) : null
    } catch (error) {
      style = null
    }
    if (!style) return false
    if (style.display === 'none') return true
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return true
    if (style.opacity === '0') return true
    return false
  }

  function rectOf(element) {
    try {
      return element.getBoundingClientRect()
    } catch (error) {
      return { left: 0, top: 0, width: 0, height: 0 }
    }
  }

  /** Disabled in the html sense, or announced as disabled to assistive tech. */
  function isDisabled(element) {
    if (element.disabled === true) return true
    var aria = element.getAttribute('aria-disabled')
    return aria === 'true'
  }

  /**
   * Class-based "disabled" (layui, antd, Bootstrap all do this).
   *
   * These controls are still clickable — the page just ignores the click. We do
   * not refuse to click them (plenty of sites style a working control this way),
   * but the model needs the hint, otherwise "Clicked" reads like success.
   */
  function looksDisabled(element) {
    for (var node = element, depth = 0; node && depth < 4; node = node.parentElement, depth += 1) {
      var cls = typeof node.className === 'string' ? node.className : ''
      var hit = /(?:^|[\s_-])(disabled|is-disabled|layui-disabled)(?:$|[\s_-])/i.exec(cls)
      if (hit) return hit[1].toLowerCase()
    }
    return ''
  }

  /**
   * Pick the one element a selector means.
   *
   * Invisible and zero-size matches are dropped first: portals keep a stack of
   * hidden copies of the same card, and those are never what the model wants.
   * More than one survivor is an error unless the caller said `strict: false`.
   */
  function pickSelector(selector, strict) {
    var all
    try {
      all = document.querySelectorAll(selector)
    } catch (error) {
      return { error: 'bad_selector', selector: selector, message: String(error && error.message ? error.message : error) }
    }
    var candidates = []
    for (var i = 0; i < all.length; i += 1) candidates.push(all[i])
    var usable = []
    for (var j = 0; j < candidates.length; j += 1) {
      var element = candidates[j]
      if (hiddenByStyle(element)) continue
      var rect = rectOf(element)
      if (rect.width <= 0 || rect.height <= 0) continue
      usable.push(element)
    }
    if (usable.length === 0) return { error: 'not_found', matched: candidates.length, selector: selector }
    if (usable.length > 1 && strict !== false) {
      return {
        error: 'multiple',
        matched: usable.length,
        selector: selector,
        candidates: usable.slice(0, 5).map(function (element) {
          return describe(element, document)
        }),
      }
    }
    return { element: usable[0], matched: usable.length }
  }

  /**
   * Is the element really the thing at that point?
   *
   * A modal overlay, a cookie banner or the site's own tooltip sits on top of
   * the target and swallows the click; Chromium then dispatches to the overlay
   * and the tool reports success for an action that never happened. Walking up
   * from `elementFromPoint` also accepts a click on a child (<span> inside
   * <button>), which is what a human would hit too.
   */
  function hitTest(element, point) {
    var top = null
    try {
      top = document.elementFromPoint(point.x, point.y)
    } catch (error) {
      top = null
    }
    if (!top) return { ok: true, exact: false }
    var node = top
    while (node) {
      if (node === element) return { ok: true, exact: node === top }
      node = node.parentElement || null
    }
    return { ok: false, behind: describe(top, document) }
  }

  /**
   * Choose a point inside the element that really reaches it.
   *
   * Stacked/overlapping controls (百度地图的 3D 卡片、图钉、悬浮按钮) have a
   * centre that lands on a neighbour; only part of the box is visible. Sample
   * the centre first, then the edge midpoints, then the quarter points, and use
   * the first sample that hit-tests to the element or one of its descendants.
   */
  function pickPoint(element, box) {
    var fractions = [
      [0.5, 0.5],
      [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5],
      [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8],
    ]
    // A tall card is one big link with a toolbar parked in the middle (1688 puts
    // 找相似 exactly there, and its script opens a popup). Aim for the top strip
    // first: on a card that is the picture, and a press there bubbles to the link.
    if (element.tagName === 'A' && box.height > 120) {
      fractions = [
        [0.5, 0.15], [0.2, 0.2], [0.8, 0.2], [0.5, 0.35],
        [0.5, 0.5], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5],
        [0.2, 0.8], [0.8, 0.8],
      ]
    }
    var samples = []
    for (var i = 0; i < fractions.length; i += 1) {
      var point = {
        x: Math.round(box.left + box.width * fractions[i][0]),
        y: Math.round(box.top + box.height * fractions[i][1]),
        width: Math.round(box.width),
        height: Math.round(box.height),
      }
      if (point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight) continue
      samples.push(point)
    }
    if (samples.length === 0) return { ok: false, error: 'out_of_view' }
    // Two passes. First look for a sample the element itself receives: a card
    // that wraps its picture in one big <a> often has an inner overlay sitting
    // in the middle (1688's "找相似" panel), and only the element's own area
    // follows the card's link. Only then accept a child receiving the click.
    var firstMiss = null
    for (var a = 0; a < samples.length; a += 1) {
      var exact = hitTest(element, samples[a])
      if (exact.ok === true && exact.exact === true) return { ok: true, point: samples[a] }
      if (exact.ok !== true && firstMiss === null) firstMiss = exact
    }
    for (var b = 0; b < samples.length; b += 1) {
      var inside = hitTest(element, samples[b])
      if (inside.ok === true) return { ok: true, point: samples[b] }
    }
    return { ok: false, error: 'occluded', behind: firstMiss ? firstMiss.behind : null }
  }

  /**
   * Turn `target="_blank"` (or any named target) into a same-view navigation.
   *
   * The attribute is changed, not the DOM: a popup would be an invisible window
   * (spec A15), while `_self` keeps the link working in the panel's view.
   */
  /**
   * Turn `target="_blank"` (or any named target) into a same-view navigation.
   *
   * The attribute is changed, not the DOM: a popup would be an invisible window
   * (spec A15), while `_self` keeps the link working in the panel's view. Forms
   * count too: a `<form target="_blank">` submits into a window Chromium drops
   * without a trace, so the search button looks dead.
   */
  function neutralizeTarget(element) {
    var fixed = []
    if (element.tagName === 'A') {
      var target = element.getAttribute('target')
      if (target && !/^_(self|top|parent)$/i.test(target)) {
        element.setAttribute('target', '_self')
        fixed.push(target)
      }
    }
    var formTarget = element.getAttribute ? element.getAttribute('formtarget') : null
    if (formTarget && !/^_(self|top|parent)$/i.test(formTarget)) {
      element.setAttribute('formtarget', '_self')
      fixed.push('formtarget=' + formTarget)
    }
    var form = element.closest ? element.closest('form') : null
    if (form) {
      var formTargetAttr = form.getAttribute('target')
      if (formTargetAttr && !/^_(self|top|parent)$/i.test(formTargetAttr)) {
        form.setAttribute('target', '_self')
        fixed.push('form ' + formTargetAttr)
      }
    }
    return fixed.length > 0 ? fixed.join(', ') : null
  }

  /** Scroll the page (or a container) and report where it landed. */
  function doScroll() {
    var box = null
    var selector = input.container ? String(input.container) : ''
    if (selector !== '') {
      try {
        box = document.querySelector(selector)
      } catch (error) {
        return fail('bad_selector', { selector: selector })
      }
      if (!box) return fail('not_found', { selector: selector })
    } else {
      box = document.scrollingElement || document.documentElement
    }
    if (!box) return fail('not_scrollable', {})

    var viewport = selector === '' ? window.innerHeight : box.clientHeight
    var before = box.scrollTop || 0
    if (input.to === 'top') box.scrollTop = 0
    else if (input.to === 'bottom') box.scrollTop = box.scrollHeight
    else box.scrollTop = before + (typeof input.dy === 'number' && isFinite(input.dy) ? input.dy : 600)

    var y = box.scrollTop || 0
    var max = Math.max(0, (box.scrollHeight || 0) - viewport)
    return JSON.stringify({
      ok: true,
      // Fractional device pixels show up here on hidpi screens; the host schema
      // is integers, so round at the source instead of trusting the caller.
      x: Math.round(box.scrollLeft || 0),
      y: Math.round(y),
      before: Math.round(before),
      scrollHeight: Math.round(box.scrollHeight || 0),
      viewportHeight: Math.round(viewport),
      // Fractional device pixels mean "one short" is the honest answer near the end.
      atBottom: y >= max - 1,
      blockedNewWindow: takeBlocked(),
    })
  }

  installGuards()
  if (op === 'scroll') return doScroll()

  // `inspect` answers "what is this address?" before a write is approved. With
  // no ref/selector/locator it describes the focused control, which is what an
  // Enter press will act on. Nothing is mutated here.
  if (op === 'inspect' && typeof input.selector !== 'string' && typeof input.ref !== 'string' && typeof input.loc !== 'string') {
    var focused = document.activeElement
    return JSON.stringify({
      ok: true,
      info: focused && focused !== document.body ? describe(focused, document) : null,
      isSubmit: isSubmitControl(focused),
      url: String(location.href || ''),
    })
  }

  var element = null
  var doc = document
  var frame = ''
  var matched = 0

  if (typeof input.loc === 'string' && input.loc !== '') {
    var anchored = resolveLoc(input.loc)
    if (anchored.error) {
      var locExtra = { loc: String(input.loc || '') }
      if (anchored.frame) locExtra.frame = anchored.frame
      return fail(anchored.error, locExtra)
    }
    element = anchored.element
    doc = anchored.doc
    frame = anchored.frame
    matched = 1
  } else if (typeof input.selector === 'string' && input.selector !== '') {
    var picked = pickSelector(input.selector, input.strict)
    if (picked.error) {
      if (picked.error === 'multiple') return fail(picked.error, { matched: picked.matched, selector: picked.selector, candidates: picked.candidates })
      var extra = { matched: picked.matched, selector: picked.selector }
      if (typeof picked.message === 'string') extra.message = picked.message
      return fail(picked.error, extra)
    }
    element = picked.element
    matched = picked.matched
  } else {
    var found = resolve(input.ref)
    if (found.error) return fail(found.error, { ref: String(input.ref || '') })
    element = found.element
    doc = found.doc
    frame = found.frame
    matched = 1
  }

  if (op === 'inspect') {
    return JSON.stringify({
      ok: true,
      info: describe(element, doc),
      isSubmit: isSubmitControl(element),
      url: String(location.href || ''),
    })
  }

  try {
    element.scrollIntoView({ block: 'center', inline: 'center' })
  } catch (error) {
    // Scrolling is best effort: a detached or fixed element still has a rect.
  }

  var rect = element.getBoundingClientRect()
  var info = describe(element, doc)
  var center = {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }

  // Inside a frame the rect is frame-relative, but mouse events go to the
  // top-level viewport, so the iframe's own offset has to be added.
  if (frame) {
    var host = document.querySelector('[data-dsh-frame="' + frame + '"]')
    if (host) {
      try {
        host.scrollIntoView({ block: 'center', inline: 'center' })
      } catch (error) {
        // Same best-effort rule as above.
      }
      var hostRect = host.getBoundingClientRect()
      center.x += Math.round(hostRect.left)
      center.y += Math.round(hostRect.top)
    }
  }

  // Every refusal carries how the caller addressed the target, so the host can
  // say `selector "#covered"` instead of `ref ""` in the error text.
  var who = function (extra) {
    var out = extra || {}
    if (typeof input.loc === 'string' && input.loc !== '') out.loc = input.loc
    else if (typeof input.selector === 'string' && input.selector !== '') out.selector = input.selector
    else if (typeof input.ref === 'string' && input.ref !== '') out.ref = input.ref
    return out
  }

  // Two frames, with a timer fallback for panels that throttle rAF in the
  // background — a hidden panel still has to make progress.
  function frameWait() {
    return new Promise(function (resolve) {
      var done = false
      function go() {
        if (done) return
        done = true
        resolve()
      }
      try {
        if (typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(function () {
            window.requestAnimationFrame(go)
          })
        }
      } catch (error) {
        // Fall through to the timer.
      }
      setTimeout(go, 120)
    })
  }

  /**
   * Scroll the target into view and wait until the page stops growing around it.
   *
   * Pages that lazy-load on scroll append content *above* the target, so the
   * rectangle measured before the growth is stale — and a stale point means a
   * click that lands on a different element while still reporting success.
   * Each round re-scrolls after the layout settles; the payload is built only
   * once the height is stable and the target is fully inside the viewport.
   */
  async function settleThen(build) {
    var previousHeight = -1
    for (var round = 0; round < 6; round += 1) {
      try {
        element.scrollIntoView({ block: 'center', inline: 'center' })
      } catch (error) {
        // A detached element cannot be scrolled; the payload call will say so.
      }
      await frameWait()
      var root = document.scrollingElement || document.documentElement
      var height = root ? root.scrollHeight || 0 : 0
      var box = element.getBoundingClientRect()
      var inside = box.top >= 0 && box.left >= 0
        && box.bottom <= (window.innerHeight || 0)
        && box.right <= (window.innerWidth || 0)
      if (inside && height === previousHeight) break
      previousHeight = height
    }
    return build()
  }

  if (op === 'hover') {
    /**
     * A cheap fingerprint of the element and its subtree.
     *
     * Fanning out three stacked cards moves the cards, not their container, so
     * comparing the container's own box says "nothing happened" while the
     * control has plainly expanded. Coordinates of the descendants catch it.
     */
    function layoutOf(node) {
      var parts = []
      var kids = []
      try {
        kids = node.querySelectorAll('*')
      } catch (error) {
        kids = []
      }
      var limit = Math.min(kids.length, 40)
      for (var i = 0; i < limit; i += 1) {
        var r = kids[i].getBoundingClientRect()
        parts.push(Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + ',' + Math.round(r.height))
      }
      return parts.join('|')
    }

    // Hover is a real move without a press: pages that expand a stacked control
    // on `mouseover` need it before the cards can be clicked individually.
    function hoverPayload() {
      var hoverBox = element.getBoundingClientRect()
      var plain = {
        x: Math.round(hoverBox.left + hoverBox.width / 2),
        y: Math.round(hoverBox.top + hoverBox.height / 2),
        width: Math.round(hoverBox.width),
        height: Math.round(hoverBox.height),
      }
      if (hoverBox.width === 0 || hoverBox.height === 0) return fail('out_of_view', who({ info: info, rect: plain }))
      if (!frame) {
        var hoverPick = pickPoint(element, hoverBox)
        if (hoverPick.ok !== true) {
          return fail(hoverPick.error || 'occluded', who({ info: info, behind: hoverPick.behind, point: plain }))
        }
        plain = hoverPick.point
      }
      return JSON.stringify({
        ok: true,
        info: info,
        point: plain,
        rect: plain,
        matched: matched,
        pageHeight: (document.scrollingElement || document.documentElement || {}).scrollHeight || 0,
        layout: layoutOf(element),
      })
    }

    return settleThen(hoverPayload)
  }

  if (op === 'click') {
    function clickPayload() {
      var box = element.getBoundingClientRect()
      var spot = {
        x: Math.round(box.left + box.width / 2),
        y: Math.round(box.top + box.height / 2),
        width: Math.round(box.width),
        height: Math.round(box.height),
      }
      var now = describe(element, doc)
      if (box.width === 0 || box.height === 0) return fail('out_of_view', who({ info: now, rect: spot }))
      if (isDisabled(element)) return fail('disabled', who({ info: now }))
      // Inside a frame the point is already translated to the top viewport, so
      // the top document's hit test is the wrong one; the frame path skips it.
      if (!frame) {
        var picked = pickPoint(element, box)
        if (picked.ok !== true) {
          return fail(picked.error || 'occluded', who({ info: now, behind: picked.behind, point: spot }))
        }
        spot = picked.point
      }
      if (spot.x < 0 || spot.y < 0 || spot.x > window.innerWidth || spot.y > window.innerHeight) {
        return fail('out_of_view', who({ info: now, rect: spot }))
      }
      // Only a click that will actually be dispatched may rewrite the link target
      // and drain the blocked-popup list: a failed attempt must leave both alone,
      // or the warning disappears without ever reaching the model.
      var fixedTarget = neutralizeTarget(element)
      var blocked = takeBlocked()
      return JSON.stringify({
        ok: true,
        info: now,
        point: spot,
        matched: matched,
        targetFixed: fixedTarget,
        blockedNewWindow: blocked,
        looksDisabled: looksDisabled(element),
      })
    }

    return settleThen(clickPayload)
  }

  if (op === 'type') {
    if (element.type === 'password') {
      // Never type into a password field: the whole point of the takeover
      // model is that credentials stay with the human (decision D07).
      return fail('needs_human', { info: info })
    }
    var editable = element.isContentEditable === true
      || element.tagName === 'TEXTAREA'
      || (element.tagName === 'INPUT' && !/^(checkbox|radio|file|submit|button|image|reset|range|color)$/i.test(element.type))
    if (!editable) return fail('not_editable', { info: info })

    try {
      element.focus({ preventScroll: true })
    } catch (error) {
      element.focus()
    }

    if (input.clear !== false) {
      if (element.isContentEditable) {
        element.textContent = ''
      } else {
        // The native setter plus an input event is what controlled frameworks
        // (React and friends) actually listen to.
        var proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        var setter = Object.getOwnPropertyDescriptor(proto, 'value')
        if (setter && setter.set) setter.set.call(element, '')
        else element.value = ''
        element.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    var text = typeof input.text === 'string' ? input.text : ''
    var inserted = false
    if (text !== '') {
      if (element.isContentEditable) {
        try {
          inserted = document.execCommand('insertText', false, text)
        } catch (error) {
          inserted = false
        }
        if (!inserted) element.textContent = (element.textContent || '') + text
      } else {
        try {
          inserted = document.execCommand('insertText', false, text)
        } catch (error) {
          inserted = false
        }
        if (!inserted) {
          var proto2 = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
          var setter2 = Object.getOwnPropertyDescriptor(proto2, 'value')
          var current = input.clear === false ? (element.value || '') : ''
          if (setter2 && setter2.set) setter2.set.call(element, current + text)
          else element.value = current + text
        }
        element.dispatchEvent(new Event('input', { bubbles: true }))
      }
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }

    return JSON.stringify({
      ok: true,
      info: info,
      inserted: inserted,
      length: text.length,
      focused: doc.activeElement === element,
    })
  }

  return fail('bad_op', { op: String(op) })
}
