/**
 * In-page human-verification detector.
 *
 * Shipped as source and run with `executeJavaScript`, exactly like the snapshot
 * and action scripts, because it has to look at the live page.
 *
 * It only ever *reports*. Nothing here tries to solve, spoof, or click a
 * challenge: the product rule is that a verification wall is handed to the
 * human (decision D03), so a false negative is cheap and a false positive is
 * annoying — which is why two independent signal kinds normally have to agree.
 * TICKET-033 added the two narrow single-kind exceptions below (an iframe wall
 * whose top document only carries the title, and a wall whose words sit beside
 * a handful of links) and the `pending` hint the client half uses to re-run the
 * detector once a late-mounting Turnstile widget appears.
 *
 * @param {{maxText?: number}} [options]
 * @returns {string} JSON: { hit, pending, categories, signals, rect, title, url }
 */
function dshDetect(options) {
  var maxText = (options && options.maxText) || 20000
  var signals = []
  var categories = {}

  function add(kind, detail) {
    var category = kind === 'url' || kind === 'title' ? 'location' : kind
    categories[category] = true
    if (signals.length < 24) signals.push({ kind: kind, detail: String(detail).slice(0, 120) })
  }

  // ---- 1. where we are ------------------------------------------------------
  var url = ''
  var title = ''
  try { url = String(location.href) } catch (error) { url = '' }
  try { title = String(document.title || '') } catch (error) { title = '' }

  if (/challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform/i.test(url)) add('url', url)
  var TITLE_RE = /just a moment|attention required|请稍候|安全验证|验证码拦截|滑动验证|人机验证|security check|checking your browser|verifying you are human/i
  if (TITLE_RE.test(title)) add('title', title)

  // ---- 1b. a redirect is not a wall -----------------------------------------
  // 「请稍候…」 is what a challenge page says, and also what a one-second
  // interstitial says. The page itself tells them apart: a meta refresh with a
  // short delay is a redirect, and TICKET-033 acceptance 3 says it must not be
  // reported. Anything that *does* show a challenge widget keeps its dom signal
  // even behind a refresh, so only the weak rules are suppressed below.
  var redirect = false
  try {
    var meta = document.querySelector('meta[http-equiv="refresh" i]')
    if (meta !== null) {
      var metaContent = meta.getAttribute ? String(meta.getAttribute('content') || '') : ''
      var delaySeconds = parseFloat(metaContent)
      redirect = !Number.isFinite(delaySeconds) || delaySeconds <= 3
    }
  } catch (error) { redirect = false }

  // ---- 2. challenge widgets in the DOM -------------------------------------
  // Ordered: outer containers first, so the outline lands on the whole widget.
  var SELECTORS = [
    '#challenge-stage',
    '#challenge-form',
    '#px-captcha-wrapper',
    '#px-captcha',
    '.cf-turnstile',
    'iframe[src*="challenges.cloudflare.com"]',
    // Cloudflare's newer orchestrate pages and Turnstile widgets are iframes
    // whose path or title says `challenge`; the cross-origin iframe element is
    // still readable from the top document (TICKET-033).
    'iframe[src*="challenge-platform"]',
    'iframe[title*="challenge" i]',
    '#cf-challenge-running',
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="captcha"]',
    // Aliyun / Taobao slider ("请拖动滑块") and Tencent's equivalent: they ship
    // their own class names, so a generic `[class*="captcha"]` misses them.
    '#nc_1_wrapper',
    '.nc-container',
    '.nc_scale',
    '#baxia-dialog',
    '[id^="nc_"]',
    '[class*="captcha" i]',
    '[id*="captcha" i]',
  ]
  var rect = null
  for (var i = 0; i < SELECTORS.length; i += 1) {
    var element = null
    try { element = document.querySelector(SELECTORS[i]) } catch (error) { element = null }
    if (element === null) continue
    add('dom', SELECTORS[i])
    if (rect === null) {
      try {
        var box = element.getBoundingClientRect()
        if (box.width > 0 && box.height > 0) {
          rect = {
            x: Math.round(box.left),
            y: Math.round(box.top),
            width: Math.round(box.width),
            height: Math.round(box.height),
          }
        }
      } catch (error) { /* a detached node has no box */ }
    }
  }

  // ---- 3. words only the wall says -----------------------------------------
  var text = ''
  try { text = String(document.body ? document.body.innerText : '').slice(0, maxText) } catch (error) { text = '' }
  // A challenge wall is always an HTML document. A `text/plain` response (a
  // README, a log dump, an API error body) can mention any phrase without being
  // one — served by our own static server, the project README says 人机验证 and
  // tripped the text-only rule below on 2026-11-21.
  var contentType = ''
  try { contentType = String(document.contentType || '') } catch (error) { contentType = '' }
  var PHRASES = [
    'verify you are human',
    'verify you are a human',
    'checking your browser',
    'checking if the site connection is secure',
    'verifying you are human',
    '请完成安全验证',
    '拖动滑块',
    // Alibaba's slider wall says it this way, and the morning this was written
    // the page title was 「验证码拦截」 with body 「请按住滑块，拖动到最右边」 —
    // neither of which the list above matched.
    '请按住滑块',
    '拖动到最右边',
    '按住滑块拖',
    '滑块验证',
    '滑动验证',
    '人机验证',
    // TICKET-033: the Cloudflare Turnstile demo page only says these in its
    // body (the title is the site's own), so the widget iframe was the sole
    // signal and a lone dom hit never promotes the session.
    '正在进行安全验证',
    '验证您是人类',
    '请稍候',
  ]
  var STRONG_PHRASES = [
    '正在进行安全验证',
    '验证您是人类',
    'verify you are human',
    'verifying you are human',
    'checking your browser',
    '请完成安全验证',
  ]
  var lower = text.toLowerCase()
  var strongText = false
  for (var p = 0; p < PHRASES.length; p += 1) {
    if (lower.indexOf(PHRASES[p]) >= 0) {
      add('text', PHRASES[p])
      if (STRONG_PHRASES.indexOf(PHRASES[p]) >= 0) strongText = true
    }
  }

  // ---- verdict --------------------------------------------------------------
  // Two kinds must agree, and a lone DOM class is never enough on its own: a
  // widget without a challenge context is usually just a site's own form.
  //
  // Three exceptions, each learned from a real miss:
  // - Alibaba's slider wall says "拖动滑块" in its body and carries none of the
  //   known containers, so a text hit on a page with almost nothing to interact
  //   with also counts (a real form has more than three controls).
  // - TICKET-033: the Turnstile demo page puts the wall's words beside a small
  //   nav, so the same text hit counts with up to ten controls, but only when
  //   the phrase is one only a wall says (STRONG_PHRASES).
  // - TICKET-033: the challenge controls live in a cross-origin iframe, so the
  //   top document may carry only the title. A title hit on an empty page also
  //   counts — except behind a short meta refresh, which is the redirect
  //   interstitial that looks identical.
  // Over-reporting only costs the user one annoyed glance (D03).
  var interactive = 0
  try {
    interactive = document.querySelectorAll('input,button,select,textarea,a[href]').length
  } catch (error) { interactive = 0 }
  var html = /html/i.test(contentType)
  var kinds = Object.keys(categories)
  var textOnly = kinds.length === 1 && categories.text === true && interactive <= 3
  if (textOnly && !html) textOnly = false
  var strongTextOnly = kinds.length === 1 && categories.text === true && strongText === true && html && interactive <= 10
  var titleOnly = kinds.length === 1 && categories.location === true && html && interactive <= 3
  var hit = (kinds.length >= 2 && (categories.dom === true || categories.location === true)) || textOnly || strongTextOnly || titleOnly
  if (redirect && categories.dom !== true) hit = false
  // `pending` tells the client half the page may still be mounting its widget:
  // the wall's words are here, the second signal has not landed yet, so the open
  // tool should look again after a moment (TICKET-033).
  var pending = hit === false && !redirect && html && interactive <= 30 && (categories.text === true || categories.location === true)

  // ---- outline --------------------------------------------------------------
  // The outline is drawn *in the page*, not in the panel: a <webview> composites
  // above its sibling nodes whatever z-index they get, so a panel-level frame is
  // invisible (measured: `document.elementFromPoint` over the ring returns
  // WEBVIEW). Drawing here also puts the ring into the screenshot the agent
  // receives, which the panel-level version never did.
  var OUTLINE_ID = 'dsh-challenge-outline'
  try {
    var old = document.getElementById(OUTLINE_ID)
    if (old !== null) old.remove()
    if (hit) {
      var node = document.createElement('div')
      node.id = OUTLINE_ID
      node.setAttribute('data-dsh-outline', '1')
      var style = node.style
      style.position = 'fixed'
      style.boxSizing = 'border-box'
      style.pointerEvents = 'none'
      style.zIndex = '2147483646'
      style.font = '13px/1.4 -apple-system, "Segoe UI", sans-serif'
      if (rect !== null) {
        style.left = rect.x + 'px'
        style.top = rect.y + 'px'
        style.width = rect.width + 'px'
        style.height = rect.height + 'px'
        style.border = '2px solid #d92d20'
        style.borderRadius = '6px'
        style.boxShadow = '0 0 0 4px rgba(217,45,32,.12)'
      } else {
        // Nothing to ring (a wall made of text and a redirect): say it in words
        // at the top of the page instead of pointing at the wrong element.
        style.left = '50%'
        style.top = '12px'
        style.transform = 'translateX(-50%)'
        style.padding = '6px 12px'
        style.background = '#fffaeb'
        style.color = '#b54708'
        style.border = '1px solid #fec84b'
        style.borderRadius = '999px'
        node.textContent = '检测到人机验证，请你在面板里完成'
      }
      ;(document.body || document.documentElement).appendChild(node)
    }
  } catch (error) { /* decoration: never fail a detection over it */ }

  return JSON.stringify({
    hit: hit,
    pending: pending,
    redirect: redirect,
    categories: kinds,
    signals: signals,
    rect: rect,
    interactive: interactive,
    title: title.slice(0, 200),
    url: url.slice(0, 400),
  })
}
