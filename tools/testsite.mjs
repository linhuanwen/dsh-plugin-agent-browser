/**
 * A throwaway local site for driving the browser panel without the internet.
 *
 * Every page here exists to prove one property of the snapshot engine, so the
 * coverage is deliberate: `/form` for roles and states, `/long` for the node
 * budget and the 300 ms target, `/frames` for iframe expansion, `/hidden` for
 * what must *not* appear.
 *
 *   node tools/testsite.mjs 8795
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8795)
const peer = port + 1

const STYLE = `<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; color: #101828; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  input, button, select { font: inherit; padding: 4px 8px; }
  #log { margin-top: 12px; color: #475467; white-space: pre-wrap; }
  a { color: #1a4fd6; }
  .gone { display: none; }
  .ghost { visibility: hidden; }
  .faded { opacity: 0; }
  .offscreen { position: absolute; left: -9999px; }
</style>`

const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Panel Test Page</title>${STYLE}</head>
<body>
  <h1 id="title">Panel Test Page</h1>
  <p>Type in the field, press the button, and the log below records it.</p>
  <input id="q" placeholder="type here" aria-label="Search field">
  <button id="go" type="button">click me</button>
  <p id="log">hits: 0 — keys: </p>
  <p><a id="link" href="/second">go to the second page</a></p>
  <script>
    const log = document.getElementById('log')
    let hits = 0
    const keys = []
    document.getElementById('go').addEventListener('click', () => {
      hits += 1
      log.textContent = 'hits: ' + hits + ' — keys: ' + keys.join('')
    })
    document.getElementById('q').addEventListener('keydown', (event) => {
      keys.push(event.key)
      log.textContent = 'hits: ' + hits + ' — keys: ' + keys.join('')
    })
  </script>
</body>
</html>`

const formPage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Signup Form</title>${STYLE}</head>
<body>
  <h1>Signup Form</h1>
  <form id="form" action="/done">
    <p><label for="name">Full name</label><br><input id="name" name="name" required></p>
    <p><label for="mail">Email</label><br><input id="mail" name="mail" type="email" required placeholder="you@example.com"></p>
    <p><label for="pass">Password</label><br><input id="pass" name="pass" type="password" value="hunter2"></p>
    <p><input id="agree" name="agree" type="checkbox" checked><label for="agree">I agree to the terms</label></p>
    <p><input id="news" name="news" type="checkbox"><label for="news">Send me news</label></p>
    <p><label for="plan">Plan</label>
      <select id="plan" name="plan"><option value="free">Free</option><option value="pro" selected>Pro</option></select></p>
    <p><textarea id="notes" name="notes" placeholder="Anything else?"></textarea></p>
    <p><button id="submit" type="submit">Create account</button>
       <button id="cancel" type="button">Cancel</button>
       <input id="locked" type="text" value="read only" readonly></p>
    <p><input id="off" type="text" value="disabled" disabled></p>
  </form>
  <div class="gone"><button id="invisible">never visible</button></div>
  <div class="ghost">ghost text</div>
  <div class="faded">faded text</div>
  <div class="offscreen"><a href="/second">offscreen link</a></div>
  <div aria-hidden="true"><button id="aria-hidden">also never visible</button></div>
</body>
</html>`

const longPage = (count) => {
  const items = []
  for (let i = 0; i < count; i++) {
    items.push(`<li class="row"><a href="/second">item ${i}</a> <span>row ${i} of the long list</span></li>`)
  }
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Long Page</title>${STYLE}</head>
<body>
  <h1>Long Page</h1>
  <p>${count} rows, for the budget and the stopwatch.</p>
  <ul id="list">${items.join('')}</ul>
</body>
</html>`
}

const framesPage = `<!doctype html><html lang="en">
<head><meta charset="utf-8"><title>Frames</title>${STYLE}</head>
<body>
  <h1>Frames</h1>
  <p><a href="/">back home</a></p>
  <iframe id="same" src="/inner" width="400" height="120"></iframe>
  <iframe id="other" src="http://127.0.0.1:${peer}/inner" width="400" height="120"></iframe>
</body>
</html>`

const innerPage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Inner</title>${STYLE}</head>
<body>
  <h2>Inner frame</h2>
  <input id="inner-field" placeholder="inside the frame">
  <button id="inner-button" type="button" onclick="this.textContent = 'inner clicked'; window.__innerClicks = (window.__innerClicks ?? 0) + 1">inner click</button>
</body>
</html>`

/**
 * A page with thousands of nodes that produce almost no lines.
 *
 * The empty-ish spans force the walker to measure every node (style, layout box)
 * while the tree stays short, which is the only way to time a 5000-node page
 * through a tool whose output is capped at 30 000 characters.
 */
const heavyPage = (count) => {
  const spans = []
  for (let i = 0; i < count; i++) spans.push('<span class="n">x</span>')
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Heavy Page</title>${STYLE}</head>
<body>
  <h1>Heavy Page</h1>
  <p>${count} tiny nodes, almost no output.</p>
  <div id="heavy">${spans.join('')}</div>
</body>
</html>`
}

/**
 * A canvas page: painting happens in the canvas, so nothing in the
 * accessibility tree can be clicked by ref and coordinates are the only way in.
 */
const canvasPage = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Canvas</title>${STYLE}</head>
<body>
  <h1>Canvas</h1>
  <p>Click the drawing area; the tree cannot see what is painted.</p>
  <canvas id="board" width="300" height="200" style="border:1px solid #999"></canvas>
  <p id="count">canvas clicks: 0</p>
  <script>
    const board = document.getElementById('board')
    const ctx = board.getContext('2d')
    ctx.fillStyle = '#eef2f7'; ctx.fillRect(0, 0, 300, 200)
    window.__canvasClicks = 0
    board.addEventListener('click', (event) => {
      const box = board.getBoundingClientRect()
      const x = Math.round(event.clientX - box.left)
      const y = Math.round(event.clientY - box.top)
      window.__canvasClicks += 1
      window.__lastPoint = { x, y }
      ctx.fillStyle = '#1d4ed8'
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill()
      document.getElementById('count').textContent = 'canvas clicks: ' + window.__canvasClicks
                              + ' at ' + x + ',' + y
    })
  </script>
</body>
</html>`

/**
 * A page shaped like a Cloudflare interstitial.
 *
 * The point is the *signals*, not a real challenge: a title phrase, a selector
 * match, and body copy. Two categories must agree before the panel calls it a
 * wall, so this fixture checks the detector's happy path rather than its taste.
 */
const challengePage = `<!doctype html>
<html><head><title>Just a moment...</title></head>
<body>
  <h1>Checking your browser before accessing example.com</h1>
  <div id="challenge-stage" style="width:320px;height:120px;border:1px dashed #999">
    <p>Verify you are human by completing the action below.</p>
    <div class="cf-turnstile" style="width:300px;height:65px;border:1px solid #ccc"></div>
  </div>
  <noscript>Enable JavaScript and cookies to continue</noscript>
</body></html>`

/** Every route, so both ports serve the same thing. */
function render(path) {
  if (path === '/second') {
    return '<!doctype html><title>Second Page</title><h1 id="title">Second Page</h1><a id="back" href="/">back</a>'
  }
  if (path === '/form') return formPage
  if (path === '/frames') return framesPage
  if (path === '/inner') return innerPage
  if (path === '/canvas') return canvasPage
  if (path === '/challenge') return challengePage
  if (path === '/long') return longPage(6000)
  if (path === '/heavy') return heavyPage(6000)
  return page
}

function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/done') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Created</title><h1>Created</h1><a href="/form">back</a>')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(render(url.pathname))
}

createServer(handle).listen(port, '127.0.0.1', () => {
  console.log(`test page on http://127.0.0.1:${port}/`)
})
createServer(handle).listen(peer, '127.0.0.1', () => {
  console.log(`cross-origin peer on http://127.0.0.1:${peer}/ (for /frames)`)
})
