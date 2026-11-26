/**
 * In-page wait probe.
 *
 * One cheap synchronous look at whether a condition holds right now. It never
 * sleeps, polls, or waits: the polling loop lives in the panel
 * (`client.js` → `Guest.wait`), so the host's timeout budget is enforced out
 * here, a cancel frame can stop the wait between probes, and a page that hangs
 * a timer cannot trap the command (TICKET-044).
 *
 * Reads only. It runs with the same trust as `detect.js`: the answer decides
 * what the agent does next, but nothing in this file changes the page.
 *
 * "Appears" means *visible*, not merely *attached*: frameworks commonly keep a
 * hidden skeleton/modal in the DOM from the first paint, so presence alone
 * would report success before the data arrived. `display:none`,
 * `visibility:hidden` and zero-box elements count as not visible; `aria-hidden`
 * alone does not (a visually rendered element is still there for the user).
 *
 * Kept as a single function expression on purpose: the panel calls it as
 * `(<source>)(input)`, which is how `actions.js` / `detect.js` are injected too.
 *
 * @param {{selector?: string, text?: string, gone?: boolean}} [input]
 * @returns {{matched: boolean, found: boolean, visible: boolean, gone: boolean, selector: string, text: string, invalid?: boolean}}
 *   `found` is raw presence, `visible` is "found and rendered"; `matched` is
 *   "the caller's condition is satisfied" — with `gone:true` that means *not
 *   visible* for a selector and *absent* for text.
 */
function dshWait(input) {
  var selector = typeof (input && input.selector) === 'string' ? input.selector : ''
  var text = typeof (input && input.text) === 'string' ? input.text : ''
  var gone = Boolean(input && input.gone === true)

  /** True when the element is actually rendered (has a box and is not hidden). */
  function isVisible(element) {
    if (element === null || element === undefined) return false
    try {
      if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false
      var view = typeof window !== 'undefined' ? window : document.defaultView
      var style = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(element) : null
      if (style !== null && style !== undefined) {
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
      }
      return true
    } catch (error) {
      // A cross-origin frame or a detached node can throw here; erring on
      // "visible" keeps the tool from looping forever on a node we cannot read.
      return true
    }
  }

  if (selector === '' && text === '') {
    return { matched: false, found: false, visible: false, gone: gone, selector: selector, text: text, invalid: true }
  }

  var found = false
  var visible = false
  if (selector !== '') {
    var element = null
    try {
      element = document.querySelector(selector)
    } catch (error) {
      // An invalid selector is a caller mistake, not a page state: report it as
      // "not found" so the tool's own validation (and its message) owns the
      // explanation instead of a raw DOMException reaching the transcript.
      element = null
    }
    found = element !== null && element !== undefined
    visible = found === true && isVisible(element)
  } else {
    var haystack = ''
    try {
      var body = document.body
      haystack = body === null || body === undefined ? '' : String(body.innerText || body.textContent || '')
    } catch (error) {
      haystack = ''
    }
    found = haystack.indexOf(text) !== -1
    visible = found
  }

  return {
    matched: gone === true ? visible === false : visible,
    found: found,
    visible: visible,
    gone: gone,
    selector: selector,
    text: text,
  }
}
