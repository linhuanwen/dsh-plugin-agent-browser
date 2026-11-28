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
 * @param {'click'|'drag'|'type'|'inspect'|'scroll'} op - what to do in the page.
 * @param {object} params - `{ ref, selector, strict, text, clear, dy, to, container }`,
 *   plus `{ toRef, toLoc, toSelector, toX, toY, dx, dy, steps }` for `drag`.
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

  /** Whether an element is a `<input type="file">` the browser can hand files to. */
  function isFileInput(node) {
    return node !== null && node !== undefined && node.tagName === 'INPUT' && String(node.type || '').toLowerCase() === 'file'
  }

  /**
   * Decode a base64 payload into bytes without touching Node APIs.
   *
   * The host reads the file and ships base64 (a bridge payload must be JSON);
   * the page turns it back into a `File`. `atob` exists in every renderer, so
   * the only job here is the byte copy.
   */
  function base64ToBytes(text) {
    var binary = atob(String(text || ''))
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
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
    if (tag === 'button') {
      if (type === 'submit') return true
      if (type !== '') return false
      // A button with no type attribute defaults to submit, but it can only
      // submit when it has a form owner; outside a form the click is a plain
      // click (SPEC-003 C2 says "form 内无 type button", TICKET-049 acceptance).
      return element.form !== null && element.form !== undefined
    }
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
    // Addressed scroll: bring one element into view instead of moving the page
    // by a fixed amount. It uses the same ref / loc / selector addresses the
    // action verbs use, so a snapshot's loc keeps working after refs renumber.
    var addressed = (typeof input.loc === 'string' && input.loc !== '')
      || (typeof input.selector === 'string' && input.selector !== '')
      || (typeof input.ref === 'string' && input.ref !== '')
    if (addressed) {
      var target = null
      var targetDoc = document
      var targetFrame = ''
      if (typeof input.loc === 'string' && input.loc !== '') {
        var targetAnchor = resolveLoc(input.loc)
        if (targetAnchor.error) {
          var locExtra = { loc: String(input.loc || '') }
          if (targetAnchor.frame) locExtra.frame = targetAnchor.frame
          return fail(targetAnchor.error, locExtra)
        }
        target = targetAnchor.element
        targetDoc = targetAnchor.doc
        targetFrame = targetAnchor.frame
      } else if (typeof input.selector === 'string' && input.selector !== '') {
        var targetPick = pickSelector(input.selector, input.strict)
        if (targetPick.error) {
          if (targetPick.error === 'multiple') return fail(targetPick.error, { matched: targetPick.matched, selector: targetPick.selector, candidates: targetPick.candidates })
          var selectorExtra = { matched: targetPick.matched, selector: targetPick.selector }
          if (typeof targetPick.message === 'string') selectorExtra.message = targetPick.message
          return fail(targetPick.error, selectorExtra)
        }
        target = targetPick.element
      } else {
        var targetFound = resolve(input.ref)
        if (targetFound.error) return fail(targetFound.error, { ref: String(input.ref || '') })
        target = targetFound.element
        targetDoc = targetFound.doc
        targetFrame = targetFound.frame
      }

      try {
        target.scrollIntoView({ block: 'center', inline: 'center' })
      } catch (error) {
        // Best effort, same as the action verbs: a detached element still has a rect.
      }

      var pageBox = document.scrollingElement || document.documentElement
      var pageViewport = window.innerHeight
      var pageWidth = window.innerWidth
      var targetRect = target.getBoundingClientRect()
      // `right` / `bottom` are always present on a real DOMRect, but computing
      // them keeps the answer honest for stubs and hand-built rects too.
      var rectLeft = Number(targetRect.left) || 0
      var rectTop = Number(targetRect.top) || 0
      var rectRight = targetRect.right === undefined ? rectLeft + (Number(targetRect.width) || 0) : targetRect.right
      var rectBottom = targetRect.bottom === undefined ? rectTop + (Number(targetRect.height) || 0) : targetRect.bottom
      var inViewport = rectBottom > 0 && rectTop < pageViewport && rectRight > 0 && rectLeft < pageWidth
      var fullyInViewport = rectTop >= 0 && rectBottom <= pageViewport && rectLeft >= 0 && rectRight <= pageWidth
      var pageMax = Math.max(0, (pageBox.scrollHeight || 0) - pageViewport)
      var pageY = pageBox.scrollTop || 0
      return JSON.stringify({
        ok: true,
        matched: true,
        mode: 'into-view',
        x: Math.round(pageBox.scrollLeft || 0),
        y: Math.round(pageY),
        scrollHeight: Math.round(pageBox.scrollHeight || 0),
        viewportHeight: Math.round(pageViewport),
        viewportWidth: Math.round(pageWidth),
        atBottom: pageY >= pageMax - 1,
        rect: {
          x: Math.round(targetRect.left),
          y: Math.round(targetRect.top),
          width: Math.round(targetRect.width),
          height: Math.round(targetRect.height),
        },
        visible: inViewport,
        fullyVisible: fullyInViewport,
        info: describe(target, targetDoc),
        frame: targetFrame,
        loc: typeof input.loc === 'string' ? input.loc : '',
        blockedNewWindow: takeBlocked(),
      })
    }

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

  /**
   * Resolve one field of a `fill` batch. Each field carries its own address
   * (`loc`, `ref` or `selector`), so this mirrors the top-level resolution
   * above instead of borrowing its single `element`.
   * @param {object} field - `{ loc?, ref?, selector?, strict? }`.
   * @returns {{element?: Element, doc?: Document, frame?: string, error?: string, extra?: object}}
   */
  function resolveFillField(field) {
    var spec = field !== null && typeof field === 'object' ? field : {}
    if (typeof spec.loc === 'string' && spec.loc !== '') {
      var anchored = resolveLoc(spec.loc)
      if (anchored.error) {
        var locExtra = { loc: String(spec.loc || '') }
        if (anchored.frame) locExtra.frame = anchored.frame
        return { error: anchored.error, extra: locExtra }
      }
      return { element: anchored.element, doc: anchored.doc, frame: anchored.frame }
    }
    if (typeof spec.selector === 'string' && spec.selector !== '') {
      var picked = pickSelector(spec.selector, spec.strict === true ? true : input.strict)
      if (picked.error) {
        if (picked.error === 'multiple') {
          return { error: 'multiple', extra: { matched: picked.matched, selector: picked.selector, candidates: picked.candidates } }
        }
        var selectorExtra = { matched: picked.matched, selector: picked.selector }
        if (typeof picked.message === 'string') selectorExtra.message = picked.message
        return { error: picked.error, extra: selectorExtra }
      }
      return { element: picked.element, doc: document, frame: '' }
    }
    var found = resolve(spec.ref)
    if (found.error) return { error: found.error, extra: { ref: String(spec.ref || '') } }
    return { element: found.element, doc: found.doc, frame: found.frame }
  }

  /**
   * @param {Element} element - a form control.
   * @returns {''|'text'|'select'|'password'} what `fill` can do with it.
   */
  function fillKindOf(element) {
    if (!element) return ''
    if (element.tagName === 'SELECT') return 'select'
    if (element.isContentEditable === true) return 'text'
    if (element.tagName === 'TEXTAREA') return 'text'
    if (element.tagName === 'INPUT'
      && !/^(checkbox|radio|file|submit|button|image|reset|range|color)$/i.test(element.type)) {
      return element.type === 'password' ? 'password' : 'text'
    }
    return ''
  }

  /** The native setter controlled frameworks actually listen to. */
  function setFieldValue(element, value) {
    try {
      var proto = element.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : element.tagName === 'SELECT'
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype
      var setter = Object.getOwnPropertyDescriptor(proto, 'value')
      if (setter && setter.set) {
        setter.set.call(element, value)
        return true
      }
    } catch (error) {
      // Fall through to the plain assignment.
    }
    try {
      element.value = value
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Write one value into one already-resolved field.
   * @param {Element} element - the control.
   * @param {string} kind - from `fillKindOf`.
   * @param {string} value - the text (or option value/label for select).
   * @param {boolean} clear - replace the current value (default).
   * @returns {object} `{ok:true,…}` or `{error,…}`.
   */
  function fillOneValue(element, kind, value, clear) {
    try {
      element.focus({ preventScroll: true })
    } catch (error) {
      try { element.focus() } catch (ignored) { /* detached element */ }
    }
    if (kind === 'select') {
      var options = element.options || []
      var chosen = null
      for (var i = 0; i < options.length; i += 1) {
        var option = options[i]
        var optionValue = String(option.value == null ? '' : option.value)
        var optionText = String(option.textContent == null ? '' : option.textContent).replace(/\s+/g, ' ').trim()
        if (optionValue === value || optionText === value
          || optionValue.toLowerCase() === value.toLowerCase()
          || optionText.toLowerCase() === value.toLowerCase()) {
          chosen = option
          break
        }
      }
      if (chosen === null) return { error: 'bad_option' }
      var chosenValue = String(chosen.value == null ? '' : chosen.value)
      if (!setFieldValue(element, chosenValue)) return { error: 'not_editable' }
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return {
        ok: true,
        selected: {
          value: chosenValue,
          label: String(chosen.textContent == null ? '' : chosen.textContent).replace(/\s+/g, ' ').trim(),
        },
      }
    }
    var inserted = false
    if (clear !== false && element.isContentEditable !== true) setFieldValue(element, '')
    if (element.isContentEditable === true) {
      if (clear !== false) element.textContent = ''
      try { inserted = document.execCommand('insertText', false, value) } catch (error) { inserted = false }
      if (!inserted) element.textContent = (element.textContent || '') + value
    } else {
      try { inserted = document.execCommand('insertText', false, value) } catch (error) { inserted = false }
      if (!inserted) {
        var current = clear === false ? String(element.value || '') : ''
        setFieldValue(element, current + value)
      }
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, inserted: inserted, length: value.length }
  }

  /**
   * `fill` — write several fields (and optionally submit) in one command.
   *
   * Every address and every editable/disabled check runs *before* the first
   * keystroke, so a stale locator or a password field fails without leaving a
   * half-filled form behind. The submit target is resolved up front for the
   * same reason.
   */
  function doFill() {
    var fields = Array.isArray(input.fields) ? input.fields : []
    if (fields.length === 0) return fail('no_fields', {})
    if (fields.length > 50) return fail('too_many_fields', { count: fields.length })
    var resolved = []
    for (var index = 0; index < fields.length; index += 1) {
      var field = fields[index] !== null && typeof fields[index] === 'object' ? fields[index] : {}
      var found = resolveFillField(field)
      if (found.error) {
        var failExtra = found.extra || {}
        failExtra.index = index
        failExtra.filled = []
        return fail(found.error, failExtra)
      }
      var kind = fillKindOf(found.element)
      var info = describe(found.element, found.doc)
      if (kind === '') return fail('not_editable', { index: index, info: info, filled: [] })
      if (kind === 'password') return fail('needs_human', { index: index, info: info, filled: [] })
      if (isDisabled(found.element)) return fail('disabled', { index: index, info: info, filled: [] })
      resolved.push({ field: field, element: found.element, doc: found.doc, kind: kind })
    }

    var submit = input.submit === undefined ? null : input.submit
    var submitTarget = null
    var submitMethod = ''
    if (submit !== null && submit !== false) {
      if (submit === true) {
        var form = resolved[resolved.length - 1].element.form || null
        if (form !== null) {
          var control = null
          try {
            control = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])')
          } catch (error) {
            control = null
          }
          if (control !== null) {
            submitTarget = control
            submitMethod = 'click'
          } else if (typeof form.requestSubmit === 'function') {
            submitTarget = form
            submitMethod = 'request-submit'
          }
        }
      } else if (typeof submit === 'object') {
        var targetFound = resolveFillField(submit)
        if (targetFound.error) {
          var targetExtra = targetFound.extra || {}
          targetExtra.index = -1
          targetExtra.filled = []
          return fail(targetFound.error, targetExtra)
        }
        submitTarget = targetFound.element
        submitMethod = 'click'
      }
      if (submitMethod === '') return fail('no_submit_target', { filled: [] })
      if (submitMethod === 'click' && isDisabled(submitTarget)) {
        return fail('disabled', { index: -1, info: describe(submitTarget, document), filled: [], submit: true })
      }
    }

    var written = []
    for (var step = 0; step < resolved.length; step += 1) {
      var entry = resolved[step]
      var value = typeof entry.field.value === 'string'
        ? entry.field.value
        : String(entry.field.value == null ? '' : entry.field.value)
      try {
        entry.element.scrollIntoView({ block: 'center', inline: 'center' })
      } catch (error) {
        // Detached/fixed elements still have a rect.
      }
      var write = fillOneValue(entry.element, entry.kind, value, entry.field.clear !== false)
      if (write.error) {
        return fail(write.error, {
          index: step,
          info: describe(entry.element, entry.doc),
          value: value,
          filled: written,
        })
      }
      written.push({
        index: step,
        info: describe(entry.element, entry.doc),
        value: value,
        length: write.length,
        inserted: write.inserted,
        selected: write.selected,
        rect: rectOf(entry.element),
      })
    }

    var submitted = null
    if (submitTarget !== null) {
      var submitInfo = describe(submitTarget, document)
      try {
        if (submitMethod === 'request-submit') submitTarget.requestSubmit()
        else submitTarget.click()
      } catch (error) {
        return fail('submit_failed', {
          message: String((error && error.message) || error),
          filled: written,
          submit: submitInfo,
        })
      }
      submitted = { info: submitInfo, method: submitMethod }
    }
    return JSON.stringify({
      ok: true,
      fields: written,
      submit: submitted,
      url: String(location.href || ''),
    })
  }

  installGuards()
  if (op === 'scroll') return doScroll()
  if (op === 'fill') return doFill()

  // `inspect` answers "what is this address?" before a write is approved. With
  // no ref/selector/locator it describes the focused control, which is what an
  // Enter press will act on. Nothing is mutated here.
  if (op === 'inspect' && typeof input.selector !== 'string' && typeof input.ref !== 'string' && typeof input.loc !== 'string') {
    var focused = document.activeElement
    return JSON.stringify({
      ok: true,
      info: focused && focused !== document.body ? describe(focused, document) : null,
      isSubmit: isSubmitControl(focused),
      acceptsFiles: isFileInput(focused),
      acceptsMultiple: isFileInput(focused) && focused.multiple === true,
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
      acceptsFiles: isFileInput(element),
      acceptsMultiple: isFileInput(element) && element.multiple === true,
      url: String(location.href || ''),
    })
  }

  // `upload` hands bytes the host already read from the workspace to a file
  // input. There is no native picker involved: a `File` is assembled in the
  // page and assigned through a `DataTransfer`, which is exactly what the
  // browser's own chooser ends up doing. File inputs are frequently hidden
  // (`display:none` behind a styled button), so this runs before any
  // scroll/visibility/hit-test step — the element does not have to be visible.
  if (op === 'upload') {
    if (!isFileInput(element)) return fail('not_file_input', { info: describe(element, doc) })
    var incoming = Array.isArray(input.files) ? input.files : []
    if (incoming.length === 0) return fail('no_files', {})
    if (element.multiple !== true && incoming.length > 1) {
      return fail('multiple_not_allowed', { count: incoming.length, multiple: false })
    }
    var transfer = null
    var uploaded = []
    try {
      transfer = new DataTransfer()
      for (var index = 0; index < incoming.length; index += 1) {
        var item = incoming[index] !== null && typeof incoming[index] === 'object' ? incoming[index] : {}
        var name = typeof item.name === 'string' && item.name !== '' ? item.name : 'file'
        var type = typeof item.type === 'string' ? item.type : ''
        var blob = new File([base64ToBytes(item.b64)], name, { type: type })
        transfer.items.add(blob)
        uploaded.push({ name: blob.name, size: blob.size, type: blob.type })
      }
    } catch (error) {
      return fail('upload_failed', { message: String((error && error.message) || error) })
    }
    if (uploaded.length === 0) return fail('no_files', {})
    try {
      element.files = transfer.files
    } catch (error) {
      return fail('upload_failed', { message: String((error && error.message) || error) })
    }
    // Sites listen for `change` (and some for `input`) to read the selected
    // files; firing both matches what a real picker does.
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return JSON.stringify({
      ok: true,
      info: describe(element, doc),
      files: uploaded,
      multiple: element.multiple === true,
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

  if (op === 'drag') {
    /**
     * Where a box sits in the top-level viewport.
     *
     * A box measured inside an iframe is frame-relative, but the pointer the
     * page sees is the panel's: the frame's own offset has to be added back.
     */
    function viewportPointOf(node, box, ownFrame) {
      var point = {
        x: Math.round(box.left + box.width / 2),
        y: Math.round(box.top + box.height / 2),
        width: Math.round(box.width),
        height: Math.round(box.height),
      }
      if (!ownFrame) return point
      var hostNode = document.querySelector('[data-dsh-frame="' + ownFrame + '"]')
      if (hostNode) {
        var hostBox = hostNode.getBoundingClientRect()
        point.x += Math.round(hostBox.left)
        point.y += Math.round(hostBox.top)
      }
      return point
    }

    /**
     * Dispatch one pointer/mouse pair to whatever sits under (x, y).
     *
     * Drag libraries listen to either family (React DnD, dnd-kit and Sortable
     * use pointer events; older widgets use mouse events), so both are sent —
     * the same way a real input device produces both. Coordinates are viewport
     * CSS pixels, exactly what `clientX` carries for a human.
     */
    function dragEvent(type, x, y, buttons, forced) {
      var node = forced || null
      if (!node) {
        try {
          node = document.elementFromPoint(x, y)
        } catch (error) {
          node = null
        }
      }
      if (!node) node = element
      var mouseType = type.replace(/^pointer/, 'mouse')
      var base = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: x,
        screenY: y,
        button: 0,
        buttons: buttons,
      }
      try {
        if (typeof window.PointerEvent === 'function') {
          node.dispatchEvent(new window.PointerEvent(type, {
            ...base,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            width: 1,
            height: 1,
            pressure: buttons === 1 ? 0.5 : 0,
          }))
        }
      } catch (error) {
        // A page that replaced PointerEvent simply gets the mouse events.
      }
      try {
        if (typeof window.MouseEvent === 'function') {
          node.dispatchEvent(new window.MouseEvent(mouseType, base))
        }
      } catch (error) {
        // Same rule as above.
      }
      return node
    }

    /**
     * The press-move-release sequence itself.
     *
     * Every move waits a frame so a framework that re-renders between events
     * (sortable lists do) sees the previous step before the next one arrives;
     * events are addressed to the element under the pointer, not the source.
     */
    async function dragSequence(from, to, steps) {
      var startNode = null
      try {
        startNode = document.elementFromPoint(from.x, from.y)
      } catch (error) {
        startNode = null
      }
      var start = startNode || element
      dragEvent('pointerover', from.x, from.y, 0, start)
      dragEvent('pointerdown', from.x, from.y, 1, start)
      var last = start
      for (var step = 1; step <= steps; step += 1) {
        await frameWait()
        var ratio = step / steps
        var x = Math.round(from.x + (to.x - from.x) * ratio)
        var y = Math.round(from.y + (to.y - from.y) * ratio)
        last = dragEvent('pointermove', x, y, 1)
      }
      await frameWait()
      dragEvent('pointerup', to.x, to.y, 0, last)
      await frameWait()
      return steps
    }

    async function dragPayload() {
      var box = element.getBoundingClientRect()
      var from = {
        x: Math.round(box.left + box.width / 2),
        y: Math.round(box.top + box.height / 2),
        width: Math.round(box.width),
        height: Math.round(box.height),
      }
      var now = describe(element, doc)
      if (box.width === 0 || box.height === 0) return fail('out_of_view', who({ info: now, rect: from }))
      if (isDisabled(element)) return fail('disabled', who({ info: now }))
      // The press has to land on the source, so the same hit test a click uses
      // applies; a covered handle cannot be dragged by a human either.
      if (!frame) {
        var picked = pickPoint(element, box)
        if (picked.ok !== true) {
          return fail(picked.error || 'occluded', who({ info: now, behind: picked.behind, point: from }))
        }
        from = picked.point
      }
      if (from.x < 0 || from.y < 0 || from.x > window.innerWidth || from.y > window.innerHeight) {
        return fail('out_of_view', who({ info: now, rect: from }))
      }

      var to = null
      var targetInfo = null
      var targetWho = {}
      if (typeof input.toLoc === 'string' && input.toLoc !== '') {
        var anchored = resolveLoc(input.toLoc)
        if (anchored.error) return fail(anchored.error, { target: true, loc: String(input.toLoc || '') })
        var anchoredBox = anchored.element.getBoundingClientRect()
        targetInfo = describe(anchored.element, anchored.doc)
        targetWho = { toLoc: String(input.toLoc) }
        if (anchoredBox.width === 0 || anchoredBox.height === 0) {
          return fail('out_of_view', { target: true, info: targetInfo, ...targetWho })
        }
        to = viewportPointOf(anchored.element, anchoredBox, anchored.frame)
      } else if (typeof input.toSelector === 'string' && input.toSelector !== '') {
        var chosen = pickSelector(input.toSelector, input.strict)
        if (chosen.error) {
          return fail(chosen.error, { target: true, matched: chosen.matched, selector: chosen.selector })
        }
        var chosenBox = chosen.element.getBoundingClientRect()
        targetInfo = describe(chosen.element, document)
        targetWho = { toSelector: String(input.toSelector) }
        if (chosenBox.width === 0 || chosenBox.height === 0) {
          return fail('out_of_view', { target: true, info: targetInfo, ...targetWho })
        }
        to = viewportPointOf(chosen.element, chosenBox, '')
      } else if (typeof input.toRef === 'string' && input.toRef !== '') {
        var found = resolve(input.toRef)
        if (found.error) return fail(found.error, { target: true, ref: String(input.toRef || '') })
        var foundBox = found.element.getBoundingClientRect()
        targetInfo = describe(found.element, found.doc)
        targetWho = { toRef: String(input.toRef) }
        if (foundBox.width === 0 || foundBox.height === 0) {
          return fail('out_of_view', { target: true, info: targetInfo, ...targetWho })
        }
        to = viewportPointOf(found.element, foundBox, found.frame)
      } else if (Number.isFinite(input.toX) && Number.isFinite(input.toY)) {
        to = { x: Math.round(input.toX), y: Math.round(input.toY) }
      } else if (Number.isFinite(input.dx) || Number.isFinite(input.dy)) {
        // A relative drop is what a slider needs: the handle's own centre is
        // where the press lands, so "move 80px right" is expressible without
        // knowing the viewport coordinates from a snapshot.
        to = {
          x: Math.round(from.x + (Number.isFinite(input.dx) ? input.dx : 0)),
          y: Math.round(from.y + (Number.isFinite(input.dy) ? input.dy : 0)),
        }
      } else {
        return fail('no_target', who({ info: now }))
      }
      if (to.x < 0 || to.y < 0 || to.x > window.innerWidth || to.y > window.innerHeight) {
        return fail('out_of_view', { target: true, point: to, ...targetWho })
      }

      var steps = Number.isFinite(input.steps) ? Math.round(input.steps) : 8
      steps = Math.min(30, Math.max(2, steps))
      var dispatched = await dragSequence(from, to, steps)
      return JSON.stringify({
        ok: true,
        info: now,
        from: from,
        to: to,
        target: targetInfo === null ? null : { info: targetInfo, point: to },
        matched: matched,
        steps: steps,
        dispatched: dispatched,
      })
    }

    return settleThen(dragPayload)
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
      rect: rectOf(element),
      inserted: inserted,
      length: text.length,
      focused: doc.activeElement === element,
    })
  }

  return fail('bad_op', { op: String(op) })
}
