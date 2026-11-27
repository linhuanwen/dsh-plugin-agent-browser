/**
 * In-page text / table reader (TICKET-057).
 *
 * The snapshot walks the accessibility tree: great for finding controls, wasteful
 * for reading an article or a data table. This reads what the page actually
 * renders — `innerText`, i.e. the text a person sees (hidden nodes excluded) —
 * or the rows of every table under a root, in one synchronous look.
 *
 * Reads only: it never clicks, focuses, scrolls, or writes. The panel calls it
 * as `(<source>)(input)`, the same single-function-expression convention as
 * `wait.js` / `actions.js` / `pick.js`.
 *
 * Address resolution mirrors `actions.js`: `ref` (from the latest snapshot),
 * `loc` (the stable `css:` path, optional `f1:` iframe prefix), or `selector`
 * (first match; `strict` turns several matches into an error). No address means
 * the whole page body.
 *
 * Failures reuse the stable codes: `bad_loc`, `stale_loc`, `not_found`,
 * `multiple`. No new error code (still 21).
 *
 * @param {{mode?: 'text'|'table', ref?: string, loc?: string, selector?: string,
 *   strict?: boolean, maxChars?: number, maxTables?: number, maxRows?: number}} [input]
 * @returns {{ok: boolean, mode?: string, error?: string, text?: string, chars?: number,
 *   totalChars?: number, truncated?: boolean, tables?: object[], tableCount?: number,
 *   root?: object, url?: string, title?: string}}
 */
function dshRead(input) {
  'use strict'

  function fail(error, extra) {
    var out = { ok: false, error: String(error) }
    if (extra !== null && typeof extra === 'object') {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) out[key] = extra[key]
      }
    }
    return out
  }

  function clampInt(value, fallback, low, high) {
    var number = typeof value === 'number' && isFinite(value) ? Math.floor(value) : fallback
    if (number < low) number = low
    if (number > high) number = high
    return number
  }

  function frameDocument(prefix) {
    var frame = document.querySelector(prefix === '' ? 'iframe' : 'iframe[name="' + prefix + '"]')
    // The snapshot gives iframes prefixed refs/locs (`f1:…`); resolve the frame
    // index form first, then fall back to the first iframe for plain prefixes.
    if (frame !== null && frame !== undefined) {
      try {
        return frame.contentDocument || null
      } catch (error) {
        return null
      }
    }
    return null
  }

  function resolveLoc(locator) {
    var text = String(locator || '')
    if (text.slice(0, 4) !== 'css:') return { error: 'bad_loc', matched: 0 }
    var path = text.slice(4)
    var frame = null
    var match = /^(f\d+):(.*)$/.exec(path)
    if (match !== null) {
      frame = frameDocument(match[1])
      path = match[2]
      if (frame === null) return { error: 'stale_loc', matched: 0 }
    }
    if (path === '') return { error: 'bad_loc', matched: 0 }
    var doc = frame === null ? document : frame
    var element = null
    try {
      element = doc.querySelector(path)
    } catch (error) {
      return { error: 'bad_loc', matched: 0 }
    }
    if (element === null || element === undefined) return { error: 'stale_loc', matched: 0 }
    return { element: element, doc: doc, frame: frame }
  }

  function resolveRef(ref) {
    var text = String(ref || '')
    if (text === '') return { error: 'bad_ref', matched: 0 }
    var frame = null
    var match = /^(f\d+)(e\d+)$/.exec(text)
    if (match !== null) {
      frame = frameDocument(match[1])
      if (frame === null) return { error: 'stale_ref', matched: 0 }
      text = match[2]
    }
    var doc = frame === null ? document : frame
    var element = null
    try {
      element = doc.querySelector('[data-dsh-ref="' + text + '"]')
    } catch (error) {
      return { error: 'bad_ref', matched: 0 }
    }
    if (element === null || element === undefined) return { error: 'stale_ref', matched: 0 }
    return { element: element, doc: doc, frame: frame }
  }

  function resolveSelector(selector, strict) {
    var doc = document
    var found = []
    try {
      found = doc.querySelectorAll(selector)
    } catch (error) {
      return { error: 'bad_loc', matched: 0 }
    }
    if (found.length === 0) return { error: 'not_found', matched: 0 }
    if (strict === true && found.length > 1) return { error: 'multiple', matched: found.length }
    return { element: found[0], doc: doc, frame: null }
  }

  function roleOf(element) {
    var explicit = element.getAttribute === undefined ? null : element.getAttribute('role')
    if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
    var tag = String(element.tagName || '').toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'input') {
      var type = String(element.type || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button') return 'button'
      return 'textbox'
    }
    return tag
  }

  function nameOf(element) {
    var candidates = ['aria-label', 'title', 'alt', 'placeholder', 'name']
    for (var i = 0; i < candidates.length; i += 1) {
      var value = element.getAttribute === undefined ? null : element.getAttribute(candidates[i])
      if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 80)
    }
    var text = typeof element.innerText === 'string' ? element.innerText : element.textContent
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  }

  function pathOf(element) {
    var tag = String(element.tagName || '').toLowerCase()
    if (tag === '') return ''
    var parts = []
    var node = element
    while (node !== null && node !== undefined && node.nodeType === 1 && parts.length < 24) {
      var name = String(node.tagName || '').toLowerCase()
      if (name === 'body' || name === 'html') break
      var id = node.getAttribute === undefined ? null : node.getAttribute('id')
      if (typeof id === 'string' && id !== '' && document.querySelector('#' + id) === node) {
        parts.unshift('#' + id)
        break
      }
      var testId = node.getAttribute === undefined ? null : node.getAttribute('data-testid')
      if (typeof testId === 'string' && testId !== '' && node.parentElement !== null) {
        parts.unshift(name + '[data-testid="' + testId + '"]')
        break
      }
      var parent = node.parentElement
      if (parent === null) break
      var index = 1
      var sibling = node
      while (sibling.previousElementSibling !== null) {
        sibling = sibling.previousElementSibling
        if (String(sibling.tagName || '').toLowerCase() === name) index += 1
      }
      parts.unshift(name + ':nth-of-type(' + index + ')')
      node = parent
    }
    if (parts.length === 0) return ''
    var path = parts.join(' > ')
    var check = null
    try {
      check = document.querySelector(path)
    } catch (error) {
      return ''
    }
    return check === element ? path : ''
  }

  function normalizedText(element) {
    var tag = String(element.tagName || '').toLowerCase()
    var raw = ''
    if (tag === 'input' || tag === 'textarea') {
      raw = typeof element.value === 'string' ? element.value : ''
    } else if (typeof element.innerText === 'string' && element.innerText !== '') {
      raw = element.innerText
    } else {
      raw = typeof element.textContent === 'string' ? element.textContent : ''
    }
    var lines = String(raw).replace(/\r\n?/g, '\n').split('\n')
    var out = []
    var blank = 0
    for (var i = 0; i < lines.length; i += 1) {
      var line = lines[i].replace(/[\t ]+/g, ' ').replace(/\s+$/, '')
      if (line === '') {
        blank += 1
        if (blank < 2 && out.length > 0) out.push('')
        continue
      }
      blank = 0
      out.push(line)
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop()
    return out.join('\n').trim()
  }

  function cellText(cell) {
    var text = typeof cell.innerText === 'string' && cell.innerText !== '' ? cell.innerText : cell.textContent
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  }

  function readTable(table, maxRows) {
    var caption = ''
    if (table.caption !== null && table.caption !== undefined) {
      caption = String(table.caption.innerText || table.caption.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    }
    if (caption === '') {
      var label = table.getAttribute === undefined ? null : table.getAttribute('aria-label')
      if (typeof label === 'string') caption = label.trim().slice(0, 200)
    }
    var sourceRows = []
    try {
      sourceRows = Array.prototype.slice.call(table.rows || [])
    } catch (error) {
      sourceRows = []
    }
    var headers = []
    var bodyRows = []
    var start = 0
    if (sourceRows.length > 0) {
      var first = sourceRows[0]
      var firstCells = Array.prototype.slice.call(first.cells || [])
      var hasHeaders = firstCells.length > 0
      for (var c = 0; c < firstCells.length; c += 1) {
        var tagName = String(firstCells[c].tagName || '').toLowerCase()
        if (tagName !== 'th' && first.parentElement !== null && first.parentElement.tagName !== undefined) {
          if (String(first.parentElement.tagName).toLowerCase() !== 'thead') hasHeaders = false
        }
      }
      if (hasHeaders) {
        for (var h = 0; h < firstCells.length && h < 50; h += 1) headers.push(cellText(firstCells[h]))
        start = 1
      }
    }
    var rowCount = Math.max(0, sourceRows.length - start)
    for (var r = start; r < sourceRows.length && bodyRows.length < maxRows; r += 1) {
      var cells = Array.prototype.slice.call(sourceRows[r].cells || [])
      var row = []
      for (var k = 0; k < cells.length && k < 50; k += 1) row.push(cellText(cells[k]))
      bodyRows.push(row)
    }
    return {
      caption: caption,
      headers: headers,
      rows: bodyRows,
      rowCount: rowCount,
      truncated: rowCount > bodyRows.length,
    }
  }

  var mode = input !== null && input !== undefined && input.mode === 'table' ? 'table' : 'text'
  var maxChars = clampInt(input === null || input === undefined ? undefined : input.maxChars, 8000, 200, 40000)
  var maxTables = clampInt(input === null || input === undefined ? undefined : input.maxTables, 10, 1, 20)
  var maxRows = clampInt(input === null || input === undefined ? undefined : input.maxRows, 100, 1, 500)

  var resolved = null
  var ref = input === null || input === undefined ? '' : String(input.ref || '')
  var loc = input === null || input === undefined ? '' : String(input.loc || '')
  var selector = input === null || input === undefined ? '' : String(input.selector || '')
  var echo = {}
  if (ref !== '') echo.ref = ref
  else if (loc !== '') echo.loc = loc
  else if (selector !== '') echo.selector = selector
  if (ref !== '') resolved = resolveRef(ref)
  else if (loc !== '') resolved = resolveLoc(loc)
  else if (selector !== '') resolved = resolveSelector(selector, input.strict === true)
  if (resolved !== null && resolved.error !== undefined) {
    echo.matched = typeof resolved.matched === 'number' ? resolved.matched : 0
    return fail(resolved.error, echo)
  }

  var root = resolved === null ? document.body : resolved.element
  if (root === null || root === undefined) {
    echo.matched = 0
    return fail('not_found', echo)
  }

  var rootInfo = {
    tag: String(root.tagName || '').toLowerCase(),
    role: roleOf(root),
    name: nameOf(root),
    loc: pathOf(root) === '' ? '' : 'css:' + pathOf(root),
  }

  var url = ''
  try {
    url = String(document.location.href || '')
  } catch (error) {
    url = ''
  }
  var title = String(document.title || '')

  if (mode === 'text') {
    var text = normalizedText(root)
    var totalChars = text.length
    var truncated = totalChars > maxChars
    if (truncated) text = text.slice(0, maxChars).replace(/\s+$/, '')
    return {
      ok: true,
      mode: 'text',
      text: text,
      chars: text.length,
      totalChars: totalChars,
      truncated: truncated,
      root: rootInfo,
      url: url,
      title: title,
    }
  }

  var tables = []
  if (String(root.tagName || '').toLowerCase() === 'table') tables = [root]
  else {
    try {
      tables = Array.prototype.slice.call(root.querySelectorAll('table'))
    } catch (error) {
      tables = []
    }
  }
  var out = []
  for (var t = 0; t < tables.length && out.length < maxTables; t += 1) out.push(readTable(tables[t], maxRows))
  return {
    ok: true,
    mode: 'table',
    tables: out,
    tableCount: tables.length,
    truncated: tables.length > out.length,
    root: rootInfo,
    url: url,
    title: title,
  }
}
