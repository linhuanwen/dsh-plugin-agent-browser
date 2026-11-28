// Accessibility-tree snapshot for the agent browser panel.
//
// This file is NOT imported by the plugin. The host half reads it from disk and
// ships its text to the renderer, which runs it inside the guest page via
// `webview.executeJavaScript`. Keeping it in its own file means the traversal
// rules can be changed and exercised without touching the client bundle.
//
// The function must be self-contained: it runs in the page's main world with no
// imports and returns a JSON string (DOM nodes are not serialisable across the
// webview boundary).
function dshSnapshot(options) {
  var opts = options || {}
  var maxChars = typeof opts.maxChars === 'number' && opts.maxChars > 0 ? opts.maxChars : 8000
  // Continuation: `<stamp>@<line offset>`. The stamp pins the tree the offset
  // was measured on, so a page that changed underneath answers `stale` instead
  // of silently returning a shifted slice (TICKET-046).
  var cursor = typeof opts.cursor === 'string' ? opts.cursor.trim() : ''
  // Planning mode (TICKET-062): hand the whole tree to the host unstripped so
  // the host can decide what fits the budget (interactive nodes first). The
  // stamp is still computed here, so cursor validation stays page-side.
  var raw = opts.raw === true
  var wantText = opts.includeText !== false
  var started = typeof performance !== 'undefined' ? performance.now() : Date.now()

  var SKIP = {
    script: 1, style: 1, noscript: 1, template: 1, meta: 1, link: 1, base: 1,
    head: 1, title: 1, br: 1, wbr: 1, source: 1, track: 1, param: 1, area: 1,
  }
  var TAG_ROLE = {
    a: 'link', button: 'button', selectedcontent: 'option',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'img', input: 'textbox', select: 'combobox', textarea: 'textbox',
    option: 'option', optgroup: 'group', datalist: 'listbox',
    ul: 'list', ol: 'list', li: 'listitem', dl: 'list', dt: 'term', dd: 'definition',
    table: 'table', thead: 'rowgroup', tbody: 'rowgroup', tfoot: 'rowgroup',
    tr: 'row', td: 'cell', th: 'columnheader', caption: 'caption',
    nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    aside: 'complementary', form: 'form', article: 'article', section: 'region',
    figure: 'figure', figcaption: 'caption', fieldset: 'group', legend: 'legend',
    label: 'label', details: 'group', summary: 'button', dialog: 'dialog',
    p: 'paragraph', pre: 'code', code: 'code', blockquote: 'blockquote',
    hr: 'separator', progress: 'progressbar', meter: 'meter', output: 'status',
    search: 'search', menu: 'menu', address: 'group', mark: 'mark',
  }
  var INPUT_ROLE = {
    text: 'textbox', password: 'textbox', email: 'textbox', tel: 'textbox',
    url: 'textbox', search: 'searchbox', number: 'spinbutton', range: 'slider',
    checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button',
    reset: 'button', file: 'button', image: 'button', hidden: 'none',
    color: 'button', date: 'textbox', time: 'textbox', 'datetime-local': 'textbox',
    month: 'textbox', week: 'textbox',
  }
  // Roles worth an [ref=eN]: things an agent can act on or point at.
  var REF_ROLE = {
    link: 1, button: 1, checkbox: 1, radio: 1, combobox: 1, listbox: 1, option: 1,
    textbox: 1, searchbox: 1, switch: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1,
    menuitemradio: 1, slider: 1, spinbutton: 1, heading: 1, img: 1, treeitem: 1,
    dialog: 1, summary: 1,
  }
  // Container roles: their inner text is content, not their own display name.
  var CONTAINER = {
    list: 1, listbox: 1, menu: 1, table: 1, rowgroup: 1, row: 1, region: 1,
    article: 1, group: 1, form: 1, navigation: 1, main: 1, banner: 1,
    contentinfo: 1, complementary: 1, search: 1, dialog: 1, figure: 1,
  }
  // Roles whose visible text *is* the name: hide the duplicate text children.
  var NAME_FROM_TEXT = {
    link: 1, button: 1, heading: 1, option: 1, checkbox: 1, radio: 1, tab: 1,
    menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, treeitem: 1, switch: 1,
    summary: 1, mark: 1, output: 1, label: 1, legend: 1, caption: 1,
    paragraph: 1, listitem: 1, cell: 1, columnheader: 1, definition: 1, term: 1,
    code: 1, blockquote: 1,
  }

  var lines = []
  var chars = 0
  var refCount = 0
  var nodeCount = 0
  var visited = 0
  var frameIndex = 0
  var gen = 1

  function indent(depth) {
    var out = ''
    for (var i = 0; i < depth; i++) out += '  '
    return out
  }

  function push(line) {
    lines.push(line)
    chars += line.length + 1
    nodeCount++
    return true
  }

  function clean(value, limit) {
    if (typeof value !== 'string' || value === '') return ''
    var text = value.replace(/\s+/g, ' ').trim()
    if (limit && text.length > limit) text = text.slice(0, limit - 1) + '…'
    return text
  }

  function quote(value) {
    return JSON.stringify(value)
  }

  // FNV-1a over the URL: a cheap page identity for the cursor stamp. The stamp
  // also carries the line/ref/char totals, so a tree that changed in any of the
  // visible ways invalidates an older cursor.
  function hashUrl(value) {
    var h = 0x811c9dc5
    for (var i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i)
      h = (h * 0x01000193) >>> 0
    }
    return h.toString(36)
  }

  /**
   * Is this element part of the rendered page?
   *
   * Three answers, because the tree needs to know whether to skip the whole
   * subtree or just the node: an element nobody can see takes its children with
   * it (`display:none`, `opacity:0`, `aria-hidden`), except under
   * `visibility:hidden`, where a descendant may restore its own visibility.
   * Form options are laid out by the platform widget at zero size, so the box
   * test has to skip them or every `<select>` loses its options.
   * @returns {'yes'|'no'|'deeper'} whether to show, skip the subtree, or descend.
   */
  function visibility(el) {
    var style
    try {
      style = el.ownerDocument.defaultView.getComputedStyle(el)
    } catch (error) {
      return 'no'
    }
    if (!style) return 'no'
    if (el.getAttribute('aria-hidden') === 'true') return 'no'
    if (style.display === 'none') return 'no'
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'deeper'
    if (Number(style.opacity) === 0) return 'no'
    var tag = el.tagName.toLowerCase()
    if (tag === 'option' || tag === 'optgroup') return 'yes'
    var rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0 && style.position !== 'fixed') return 'no'
    return 'yes'
  }

  function roleOf(el, tag) {
    var explicit = clean(el.getAttribute('role'), 40)
    if (explicit) return explicit.split(/\s+/)[0]
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase()
      return INPUT_ROLE[type] || 'textbox'
    }
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : ''
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox'
    return TAG_ROLE[tag] || ''
  }

  /** True for a `<label for=…>` that does not contain the control it names. */
  function isBoundLabel(el) {
    if (el.tagName.toLowerCase() !== 'label') return false
    if (!el.getAttribute('for')) return false
    return el.querySelector('input, select, textarea, button') === null
  }

  function labelTextFor(el, doc) {    var id = el.id
    if (id) {
      var labels = doc.getElementsByTagName('label')
      for (var i = 0; i < labels.length; i++) {
        if (labels[i].htmlFor === id) {
          var text = clean(labels[i].textContent, 120)
          if (text) return text
        }
      }
    }
    var parent = el.parentElement
    for (var depth = 0; parent && depth < 3; depth++, parent = parent.parentElement) {
      if (parent.tagName && parent.tagName.toLowerCase() === 'label') {
        var inner = clean(parent.textContent, 120)
        if (inner) return inner
      }
    }
    return ''
  }

  function nameOf(el, tag, role, doc) {
    var value = clean(el.getAttribute('aria-label'), 120)
    if (!value) {
      var labelledBy = el.getAttribute('aria-labelledby')
      if (labelledBy) {
        value = clean(labelledBy.split(/\s+/).map(function (id) {
          var node = doc.getElementById(id)
          return node ? node.textContent : ''
        }).join(' '), 120)
      }
    }
    if (!value) value = clean(el.getAttribute('alt'), 120)
    if (!value) value = clean(el.getAttribute('title'), 120)
    if (!value) value = clean(el.getAttribute('placeholder'), 120)
    if (!value && (tag === 'input' || tag === 'textarea' || tag === 'select')) value = labelTextFor(el, doc)
    // A container's own text repeats whatever its element children say
    // (`paragraph "go to the second page"` over a link of the same text), so
    // text becomes a name only where there is nothing finer to descend into.
    if (!value && !CONTAINER[role] && el.children.length === 0) value = clean(el.innerText || '', 120)
    if (!value && (tag === 'input' || tag === 'button')) value = clean(el.getAttribute('value'), 120)
    return clean(value, 120)
  }

  function stateOf(el, tag, role) {
    var out = []
    if (el.disabled === true) out.push('disabled')
    if (el.required === true) out.push('required')
    if (el.readOnly === true) out.push('readonly')
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      var checked = el.getAttribute('aria-checked')
      if (checked === 'mixed') out.push('mixed')
      else if (checked === 'true' || el.checked === true) out.push('checked')
    }
    var expanded = el.getAttribute('aria-expanded')
    if (expanded === 'true') out.push('expanded')
    else if (expanded === 'false') out.push('collapsed')
    if (el.getAttribute('aria-selected') === 'true' || el.selected === true) out.push('selected')
    if (el.getAttribute('aria-pressed') === 'true') out.push('pressed')
    var isField = tag === 'input' || tag === 'textarea' || tag === 'select'
    if (isField && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'file') {
      if (el.type === 'password') {
        if (el.value) out.push('value=***')
      } else if (el.value !== undefined && el.value !== null && String(el.value).length > 0) {
        out.push('value=' + quote(clean(String(el.value), 60)))
      }
    }
    if (tag === 'a' && el.href) {
      var href = String(el.getAttribute('href') || '')
      if (href.charAt(0) !== '#' && href.slice(0, 11) !== 'javascript:') {
        out.push('href=' + quote(clean(el.href, 120)))
      }
    }
    return out
  }

  /**
   * A short CSS path to an element, or '' when no unique path is worth printing.
   *
   * Refs renumber on every snapshot, so a model that takes two snapshots in a
   * row cannot use the ref from the first one. This path survives renumbering
   * and structural re-renders of sibling nodes. It is verified against the very
   * element it was built for: a path that lands somewhere else is worse than no
   * path at all, because the action tools would act on the wrong node.
   *
   * Anchors are tried nearest-first (`#id`, `[data-testid]`, `tag[name]`), then
   * `tag:nth-of-type(n)` hops up to the body. Anything longer than the caller's
   * budget is dropped rather than truncated — a partial selector would either
   * match nothing or match the wrong node.
   */
  function cssPathOf(el, doc) {
    var parts = []
    var node = el
    for (var depth = 0; node && node.nodeType === 1 && depth < 12; depth += 1) {
      var tag = node.tagName.toLowerCase()
      var anchor = ''
      var id = node.getAttribute('id')
      if (id && /^[A-Za-z][\w.:-]*$/.test(id)) anchor = '#' + id
      if (!anchor) {
        var testId = node.getAttribute('data-testid')
        if (testId && /^[\w.:-]+$/.test(testId)) anchor = '[data-testid="' + testId + '"]'
      }
      if (!anchor && (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' || tag === 'form')) {
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
        if (hit === node) return path
      }
      var parent = node.parentElement
      if (!parent) {
        parts.unshift(tag)
        break
      }
      var index = 1
      var kids = parent.children
      for (var i = 0; i < kids.length; i += 1) {
        if (kids[i] === node) break
        if (kids[i].tagName === node.tagName) index += 1
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')')
      node = parent
    }
    var joined = parts.join(' > ')
    if (joined === '') return ''
    try {
      return doc.querySelector(joined) === el ? joined : ''
    } catch (error) {
      return ''
    }
  }

  function walk(start, startDepth, startPrefix, doc) {
    var stack = [{ node: start, depth: startDepth, prefix: startPrefix, named: false, muted: false }]
    while (stack.length > 0) {
      var frame = stack.pop()
      var node = frame.node
      visited += 1

      if (node.nodeType === 3) {
        if (!wantText || frame.named || frame.muted) continue
        var raw = clean(node.nodeValue, 160)
        if (!raw || raw.length < 2) continue
        var parentTag = node.parentElement ? node.parentElement.tagName.toLowerCase() : ''
        if (SKIP[parentTag]) continue
        push(indent(frame.depth) + '- text ' + quote(raw))
        continue
      }
      if (node.nodeType !== 1) continue
      var tag = node.tagName.toLowerCase()
      if (SKIP[tag]) continue

      if (tag === 'iframe' || tag === 'frame') {
        var src = clean(node.getAttribute('src') || '', 120)
        var inner = null
        try {
          inner = node.contentDocument || null
        } catch (error) {
          inner = null
        }
        if (inner && inner.documentElement) {
          frameIndex += 1
          inner.documentElement.setAttribute('data-dsh-gen', String(gen))
          // The prefix is also the handle the action tools use to re-enter this
          // frame: `f1e2` means ref `e2` inside `[data-dsh-frame="1"]`.
          node.setAttribute('data-dsh-frame', String(frameIndex))
          push(indent(frame.depth) + '- iframe ' + quote(src || 'about:blank'))
          stack.push({
            node: inner.body || inner.documentElement,
            depth: frame.depth + 1,
            prefix: 'f' + frameIndex,
            named: false,
            muted: false,
          })
        } else {
          push(indent(frame.depth) + '- iframe ' + quote(src) + ' [cross-origin: use coordinates]')
        }
        continue
      }

      var look = visibility(node)
      if (look === 'no') continue
      var shown = look === 'yes'
      // A `<label for=…>` that does not wrap its control only repeats the name
      // the control already carries, so the pair is reported once, on the field.
      if (shown && isBoundLabel(node)) continue
      var role = shown ? roleOf(node, tag) : ''
      var name = ''
      var emitted = false
      var childNamed = frame.named

      if (shown && role) {
        name = nameOf(node, tag, role, doc)
        var explicitRole = clean(node.getAttribute('role'), 40) !== ''
        if (!name && !explicitRole && (tag === 'div' || tag === 'span' || tag === 'section')) role = ''
      }

      if (shown && role) {
        var ref = ''
        var loc = ''
        if (REF_ROLE[role] === 1) {
          refCount += 1
          ref = frame.prefix + 'e' + refCount
          var path = cssPathOf(node, doc)
          if (path !== '') {
            var locator = (frame.prefix ? frame.prefix + ':' : '') + 'css:' + path
            // 120 characters keeps the locator smaller than the line it rides on
            // and below what a model can copy without wrapping.
            if (locator.length <= 120) loc = locator
          }
        }
        var line = indent(frame.depth) + '- ' + role
        if (name) line += ' ' + quote(name)
        if (ref) line += ' [ref=' + ref + ']'
        if (loc) line += ' [loc=' + quote(loc) + ']'
        var states = stateOf(node, tag, role)
        if (states.length > 0) line += ' ' + states.join(' ')
        emitted = push(line)
        if (ref && emitted) node.setAttribute('data-dsh-ref', ref)
        childNamed = Boolean(name) && NAME_FROM_TEXT[role] === 1
      }

      var childDepth = emitted ? frame.depth + 1 : frame.depth
      // Under `visibility:hidden` the node is invisible but a descendant may
      // turn itself back on, so text at this level is dropped while elements
      // keep descending.
      var childMuted = look === 'deeper'
      var kids = node.childNodes
      for (var i = kids.length - 1; i >= 0; i--) {
        stack.push({ node: kids[i], depth: childDepth, prefix: frame.prefix, named: childNamed, muted: childMuted })
      }
    }
  }

  var doc = document
  var rootEl = doc.documentElement
  var previous = parseInt(rootEl.getAttribute('data-dsh-gen') || '0', 10)
  gen = (isNaN(previous) ? 0 : previous) + 1
  rootEl.setAttribute('data-dsh-gen', String(gen))

  var stale = doc.querySelectorAll('[data-dsh-ref]')
  for (var s = 0; s < stale.length; s++) stale[s].removeAttribute('data-dsh-ref')

  var title = clean(doc.title || '', 120)
  push('- page ' + quote(title || 'untitled') + ' url=' + clean(location.href, 200))
  walk(doc.body || rootEl, 1, '', doc)

  var elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started
  var totalLines = lines.length
  var stamp = hashUrl(location.href) + '.' + totalLines + '.' + refCount + '.' + chars
  var from = 0
  var staleCursor = false
  if (cursor !== '') {
    var at = cursor.lastIndexOf('@')
    var offset = at > 0 ? parseInt(cursor.slice(at + 1), 10) : NaN
    if (at <= 0 || isNaN(offset) || offset < 0 || cursor.slice(0, at) !== stamp) {
      staleCursor = true
    } else {
      from = Math.min(offset, totalLines)
    }
  }
  if (staleCursor) {
    return JSON.stringify({
      gen: gen,
      url: location.href,
      title: title,
      text: '',
      refCount: refCount,
      nodeCount: 0,
      visited: visited,
      totalLines: totalLines,
      stale: true,
      ms: Math.round(elapsed),
      budget: maxChars,
    })
  }

  // TICKET-062: hand the unplanned tree to the host. Transport between the
  // guest page and the host costs no model tokens, and the host owns the pure
  // planner (plugin/snapshot-plan.js) which is a lot easier to test than a
  // DOM walk. `from` is still echoed so the host can resume a cursor.
  if (raw) {
    return JSON.stringify({
      gen: gen,
      url: location.href,
      title: title,
      lines: lines,
      refCount: refCount,
      nodeCount: totalLines,
      visited: visited,
      truncated: false,
      more: false,
      totalLines: totalLines,
      from: from,
      nextOffset: totalLines,
      cursor: '',
      stamp: stamp,
      frames: frameIndex,
      ms: Math.round(elapsed),
      budget: maxChars,
    })
  }

  var out = []
  var used = 0
  if (from > 0) {
    var banner = '- continued from line ' + (from + 1) + ' of ' + totalLines + ' (earlier part already delivered)'
    out.push(banner)
    used += banner.length + 1
  }
  var next = from
  while (next < totalLines) {
    var line = lines[next]
    if (used + line.length + 1 > maxChars) break
    out.push(line)
    used += line.length + 1
    next++
  }
  var more = next < totalLines
  return JSON.stringify({
    gen: gen,
    url: location.href,
    title: title,
    text: out.join('\n'),
    refCount: refCount,
    nodeCount: out.length,
    visited: visited,
    truncated: more,
    more: more,
    totalLines: totalLines,
    from: from,
    nextOffset: next,
    cursor: more ? stamp + '@' + next : '',
    frames: frameIndex,
    ms: Math.round(elapsed),
    budget: maxChars,
  })
}
