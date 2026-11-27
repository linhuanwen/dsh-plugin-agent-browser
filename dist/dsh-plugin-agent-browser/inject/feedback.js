/**
 * In-page marks after an agent action (TICKET-055).
 *
 * This file is injected as a single function expression:
 *
 *   (function dshFeedback(input) { ... })({ kind: 'click', x: 120, y: 80 })
 *
 * It draws in a pointer-transparent fixed overlay and dispatches no events, so
 * the page neither sees nor reacts to it. Presentation only: the caller treats
 * a failure as "nothing was drawn" and never blocks on the answer.
 *
 * Actions: `cursor` | `click` | `highlight` | `drag` | `clear`.
 * Kept to one self-contained function so tests can call it against a stub DOM.
 */
function dshFeedback(input) {
  const LAYER_ID = '__dsh-feedback'
  const STYLE_ID = '__dsh-feedback-style'
  const MAX_MARKS = 24
  const DEFAULT_MS = 900
  const Z_INDEX = '2147483645'

  const request = input !== null && typeof input === 'object' ? input : {}
  const action = typeof request.kind === 'string' ? request.kind : 'cursor'

  if (typeof document === 'undefined' || document === null) {
    return JSON.stringify({ ok: false, error: 'no document' })
  }

  function num(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  function duration() {
    const raw = num(request.durationMs)
    if (raw === null) return DEFAULT_MS
    return Math.min(5000, Math.max(100, Math.floor(raw)))
  }

  function viewportWidth() {
    const fromWindow = typeof window !== 'undefined' && window !== null ? num(window.innerWidth) : null
    if (fromWindow !== null) return fromWindow
    const fromDoc = document.documentElement !== undefined ? num(document.documentElement?.clientWidth) : null
    return fromDoc !== null ? fromDoc : 1024
  }

  function viewportHeight() {
    const fromWindow = typeof window !== 'undefined' && window !== null ? num(window.innerHeight) : null
    if (fromWindow !== null) return fromWindow
    const fromDoc = document.documentElement !== undefined ? num(document.documentElement?.clientHeight) : null
    return fromDoc !== null ? fromDoc : 768
  }

  function state() {
    const holder = typeof window !== 'undefined' && window !== null ? window : null
    if (holder === null) return null
    const existing = holder.__dshFeedback
    if (existing !== null && typeof existing === 'object') return existing
    const fresh = { marks: 0 }
    holder.__dshFeedback = fresh
    return fresh
  }

  function layerOf(create) {
    const found = document.getElementById(LAYER_ID)
    if (found !== null && found !== undefined) return found
    if (create !== true) return null
    const parent = document.body ?? document.documentElement
    if (parent === null || parent === undefined) return null
    const layer = document.createElement('div')
    layer.id = LAYER_ID
    layer.style.cssText = [
      'position:fixed',
      'left:0px',
      'top:0px',
      'right:0px',
      'bottom:0px',
      'pointer-events:none',
      'overflow:hidden',
      'z-index:' + Z_INDEX,
      'contain:strict',
    ].join(';')
    parent.appendChild(layer)
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = [
      '@keyframes __dsh-fb-pop{from{transform:scale(.4);opacity:.9}to{transform:scale(2.6);opacity:0}}',
      '@keyframes __dsh-fb-fade{from{opacity:1}to{opacity:0}}',
    ].join('')
    layer.appendChild(style)
    return layer
  }

  function detach(node) {
    try {
      if (node !== null && node !== undefined && node.parentNode !== null && node.parentNode !== undefined) {
        node.parentNode.removeChild(node)
      }
    } catch (error) {
      // A detached overlay is the same as a cleared one.
    }
  }

  function removeLayerIfEmpty(layer) {
    try {
      const children = layer !== null && layer !== undefined && Array.isArray(layer.childNodes) ? layer.childNodes : []
      const marks = children.filter((child) => child !== null && child !== undefined && child.id !== STYLE_ID)
      if (marks.length === 0) detach(layer)
    } catch (error) {
      // Best effort.
    }
  }

  function dropLater(layer, node, ms) {
    try {
      setTimeout(() => {
        detach(node)
        removeLayerIfEmpty(layer)
      }, ms)
    } catch (error) {
      // A missing timer only means the mark stays until the next navigation.
    }
  }

  function note(layer, node, ms) {
    const holder = state()
    layer.appendChild(node)
    if (holder !== null) holder.marks += 1
    // Keep the layer bounded: drop the oldest mark when the cap is reached.
    let marks = []
    try {
      marks = Array.isArray(layer.childNodes)
        ? layer.childNodes.filter((child) => child !== null && child !== undefined && child.id !== STYLE_ID)
        : []
    } catch (error) {
      marks = []
    }
    while (marks.length > MAX_MARKS) {
      const oldest = marks.shift()
      detach(oldest)
    }
    dropLater(layer, node, ms)
    return node
  }

  function round(value) {
    return Math.round(value * 10) / 10
  }

  function dot(x, y, size, filled) {
    const node = document.createElement('div')
    node.className = filled ? 'dsh-feedback-dot dsh-feedback-dot-fill' : 'dsh-feedback-dot'
    node.style.cssText = [
      'position:fixed',
      'left:' + round(x - size / 2) + 'px',
      'top:' + round(y - size / 2) + 'px',
      'width:' + size + 'px',
      'height:' + size + 'px',
      'box-sizing:border-box',
      'border-radius:50%',
      'border:2px solid #2f6feb',
      'background:' + (filled ? 'rgba(47,111,235,.85)' : 'rgba(255,255,255,.9)'),
      'box-shadow:0 0 0 2px rgba(255,255,255,.85),0 2px 8px rgba(15,23,42,.35)',
      'pointer-events:none',
    ].join(';')
    return node
  }

  function ring(x, y, size) {
    const node = document.createElement('div')
    node.className = 'dsh-feedback-ring'
    node.style.cssText = [
      'position:fixed',
      'left:' + round(x - size / 2) + 'px',
      'top:' + round(y - size / 2) + 'px',
      'width:' + size + 'px',
      'height:' + size + 'px',
      'box-sizing:border-box',
      'border-radius:50%',
      'border:2px solid rgba(47,111,235,.85)',
      'background:rgba(47,111,235,.12)',
      'pointer-events:none',
      'animation:__dsh-fb-pop .55s ease-out forwards',
    ].join(';')
    return node
  }

  function frame(rect) {
    const node = document.createElement('div')
    node.className = 'dsh-feedback-frame'
    node.style.cssText = [
      'position:fixed',
      'left:' + round(rect.left) + 'px',
      'top:' + round(rect.top) + 'px',
      'width:' + Math.max(0, round(rect.width)) + 'px',
      'height:' + Math.max(0, round(rect.height)) + 'px',
      'box-sizing:border-box',
      'border:2px solid rgba(47,111,235,.9)',
      'border-radius:3px',
      'background:rgba(47,111,235,.10)',
      'pointer-events:none',
      'animation:__dsh-fb-fade ' + duration() + 'ms ease-out forwards',
    ].join(';')
    return node
  }

  function line(from, to) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.sqrt(dx * dx + dy * dy)
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI
    const node = document.createElement('div')
    node.className = 'dsh-feedback-line'
    node.style.cssText = [
      'position:fixed',
      'left:' + round(from.x) + 'px',
      'top:' + round(from.y - 1) + 'px',
      'width:' + round(length) + 'px',
      'height:2px',
      'background:rgba(47,111,235,.55)',
      'transform-origin:0 50%',
      'transform:rotate(' + round(angle) + 'deg)',
      'pointer-events:none',
    ].join(';')
    return node
  }

  try {
    if (action === 'clear') {
      const existing = layerOf(false)
      if (existing !== null) detach(existing)
      const holder = state()
      if (holder !== null) holder.marks = 0
      return JSON.stringify({ ok: true, cleared: true })
    }

    const layer = layerOf(true)
    if (layer === null) return JSON.stringify({ ok: false, error: 'no layer' })
    const ms = duration()

    if (action === 'click') {
      const x = num(request.x)
      const y = num(request.y)
      if (x === null || y === null) return JSON.stringify({ ok: false, error: 'click needs x and y' })
      note(layer, ring(x, y, 18), 600)
      note(layer, dot(x, y, 12, true), ms)
      return JSON.stringify({ ok: true, kind: 'click' })
    }

    if (action === 'cursor') {
      const x = num(request.x)
      const y = num(request.y)
      if (x === null || y === null) return JSON.stringify({ ok: false, error: 'cursor needs x and y' })
      note(layer, dot(x, y, 14, false), ms)
      return JSON.stringify({ ok: true, kind: 'cursor' })
    }

    if (action === 'highlight') {
      const source = request.rect !== null && typeof request.rect === 'object' ? request.rect : {}
      const left = num(source.left) ?? num(source.x)
      const top = num(source.top) ?? num(source.y)
      const width = num(source.width)
      const height = num(source.height)
      if (left === null || top === null || width === null || height === null) {
        return JSON.stringify({ ok: false, error: 'highlight needs a rect' })
      }
      if (left < -viewportWidth() || top < -viewportHeight()) {
        return JSON.stringify({ ok: true, skipped: 'offscreen' })
      }
      note(layer, frame({ left, top, width, height }), ms)
      return JSON.stringify({ ok: true, kind: 'highlight' })
    }

    if (action === 'drag') {
      const from = request.from !== null && typeof request.from === 'object' ? request.from : {}
      const to = request.to !== null && typeof request.to === 'object' ? request.to : {}
      const fromX = num(from.x)
      const fromY = num(from.y)
      const toX = num(to.x)
      const toY = num(to.y)
      if (fromX === null || fromY === null || toX === null || toY === null) {
        return JSON.stringify({ ok: false, error: 'drag needs from and to' })
      }
      note(layer, line({ x: fromX, y: fromY }, { x: toX, y: toY }), ms)
      note(layer, dot(fromX, fromY, 10, false), ms)
      note(layer, dot(toX, toY, 10, true), ms)
      return JSON.stringify({ ok: true, kind: 'drag' })
    }

    return JSON.stringify({ ok: false, error: 'unknown kind "' + action + '"' })
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error) })
  }
}
