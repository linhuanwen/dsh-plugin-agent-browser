/**
 * TICKET-001 feasibility probe — client half.
 *
 * Answers six questions the spec assumes but nobody has measured:
 *   U1  does a profile-installed third-party client plugin see `globalThis.dshDesktop`?
 *   U2  does its `browser` bridge hand out a guest reservation (`acquire`)?
 *   U3  can the plugin create and mount an Electron `<webview>` in a Sidebar tab body?
 *   U4  does that `<webview>` expose `executeJavaScript`?
 *   U5  does it expose `sendInputEvent`, and does the guest actually receive input?
 *   U6  does it expose `capturePage` (TICKET-001 U6, the D08 screenshot risk)?
 *
 * Every observation is POSTed to a local beacon (see beacon.mjs) so the agent can
 * read the verdicts without asking a human to read a panel. The same lines are
 * rendered in the tab body, so the panel is also readable by eye.
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-agent-browser-probe',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement
		const BEACON = 'http://127.0.0.1:8791/beacon'
		const TYPE_ID = 'dsh-plugin-agent-browser-probe'
		const KIND = 'agent-browser-probe'
		const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

		/** Fire-and-forget POST; a failed beacon must never break the probe. */
		function beacon(step, data) {
			try {
				fetch(BEACON, {
					method: 'POST',
					mode: 'no-cors',
					headers: { 'content-type': 'text/plain;charset=UTF-8' },
					body: JSON.stringify({ at: new Date().toISOString(), step, data }),
				}).catch(() => {})
			} catch (error) { void error }
		}

		function webviewConstructorName() {
			try { return document.createElement('webview').constructor.name }
			catch (error) { return 'threw:' + String(error) }
		}

		beacon('factory', {
			href: location.href,
			userAgent: navigator.userAgent,
			hasDshDesktop: globalThis.dshDesktop !== undefined,
			protocolVersion: globalThis.dshDesktop?.protocolVersion ?? null,
			hasBrowserBridge: globalThis.dshDesktop?.browser !== undefined,
			acquire: typeof globalThis.dshDesktop?.browser?.acquire,
			webviewConstructor: webviewConstructorName(),
			moduleLoader: typeof window.__ModuleLoader__,
		})

		/** Resolve true when the event fires, false on timeout. */
		function waitEvent(element, name, timeoutMs) {
			return new Promise((resolve) => {
				let settled = false
				const done = (ok) => {
					if (settled) return
					settled = true
					element.removeEventListener(name, onEvent)
					resolve(ok)
				}
				const onEvent = () => done(true)
				element.addEventListener(name, onEvent)
				setTimeout(() => done(false), timeoutMs)
			})
		}

		/** The measured sequence; every step reports before it can fail. */
		async function exercise(host, say) {
			const desktop = globalThis.dshDesktop
			if (desktop === undefined || desktop.protocolVersion !== 1 || desktop.browser === undefined) {
				say('U1 FAIL — this renderer has no dshDesktop.browser bridge')
				return
			}
			const bridge = desktop.browser
			say('U1 PASS — dshDesktop.browser visible; acquire=' + typeof bridge.acquire)

			let reservation
			try {
				reservation = await bridge.acquire('agent-browser-probe')
				say('U2 PASS — acquire() → ' + JSON.stringify({
					partition: reservation.partition,
					lease: String(reservation.lease).slice(0, 8) + '…',
				}))
			} catch (error) {
				say('U2 FAIL — acquire() threw: ' + String(error))
				return
			}

			const view = document.createElement('webview')
			view.setAttribute('name', String(reservation.lease))
			view.setAttribute('partition', reservation.partition)
			view.setAttribute('allowpopups', '')
			// The shipped implementation seeds `src` before append: a webview with no
			// src never asks the main process for a guest, so `dom-ready` never fires.
			view.setAttribute('src', 'about:blank#' + String(reservation.lease))
			view.style.cssText = 'display:block;width:100%;height:420px;border:0;background:#fff'
			view.addEventListener('did-fail-load', event => say('U3 · did-fail-load ' + JSON.stringify({
				code: event.errorCode, description: event.errorDescription, url: event.validatedURL,
			})))
			view.addEventListener('crashed', () => say('U3 · guest crashed'))
			const ready = waitEvent(view, 'dom-ready', 15000)
			host.append(view)
			say('U3 · webview appended (' + view.constructor.name + ', connected=' + view.isConnected + ', box=' + JSON.stringify(view.getBoundingClientRect().toJSON()) + ')')
			if (!await ready) {
				say('U3 FAIL — no dom-ready within 15s; retrying through loadURL(about:blank)')
				try {
					await view.loadURL('about:blank')
					const settled = await waitEvent(view, 'did-stop-loading', 8000)
					if (!settled) { say('U3 FAIL — loadURL fallback also silent'); return }
					say('U3 PARTIAL — loaded only through loadURL(about:blank)')
				} catch (error) {
					say('U3 FAIL — loadURL fallback threw: ' + String(error))
					return
				}
			} else {
				say('U3 PASS — dom-ready fired')
			}

			try {
				const value = await view.executeJavaScript('1 + 1')
				say('U4 PASS — executeJavaScript("1 + 1") → ' + JSON.stringify(value))
			} catch (error) {
				say('U4 FAIL — executeJavaScript threw: ' + String(error))
			}

			const page = 'data:text/html,' + encodeURIComponent(
				'<!doctype html><meta charset="utf-8"><title>probe</title>' +
				'<body style="font:14px monospace;padding:8px">' +
				'<input id="q" placeholder="type here" style="font-size:16px">' +
				'<div id="log">ready</div></body>')
			try {
				await view.loadURL(page)
				say('U3b PASS — loadURL(data:) resolved')
			} catch (error) {
				say('U3b FAIL — loadURL threw: ' + String(error))
			}
			await waitEvent(view, 'did-stop-loading', 5000)
			try {
				const info = await view.executeJavaScript('({t: document.title, input: !!document.getElementById("q")})')
				say('U4b PASS — guest DOM readable: ' + JSON.stringify(info))
			} catch (error) {
				say('U4b FAIL — ' + String(error))
			}

			const record = 'window.__hits=[];' +
				'addEventListener("keydown",function(e){window.__hits.push(e.key);' +
				'var d=document.getElementById("log");if(d)d.textContent="keys:"+window.__hits.join(",")});"ok"'
			try { await view.executeJavaScript(record) } catch (error) { void error }

			if (typeof view.sendInputEvent !== 'function') {
				say('U5 FAIL — sendInputEvent is not a function')
			} else {
				try {
					if (typeof view.focus === 'function') view.focus()
					view.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
					view.sendInputEvent({ type: 'char', keyCode: 'A' })
					view.sendInputEvent({ type: 'keyUp', keyCode: 'A' })
					await sleep(400)
					const hits = await view.executeJavaScript('window.__hits')
					const seen = Array.isArray(hits) && hits.length > 0
					say((seen ? 'U5 PASS' : 'U5 PARTIAL') + ' — sendInputEvent keydown reached guest: ' + JSON.stringify(hits))
					if (seen) {
						const typed = await view.executeJavaScript('document.getElementById("q").value')
						say('U5b — guest input value after key events: ' + JSON.stringify(typed))
					}
				} catch (error) {
					say('U5 FAIL — ' + String(error))
				}
			}

			// U5c: key events only reach a control that already holds DOM focus.
			try {
				await view.executeJavaScript('document.getElementById("q").focus(); "focused"')
				view.sendInputEvent({ type: 'keyDown', keyCode: 'B' })
				view.sendInputEvent({ type: 'char', keyCode: 'B' })
				view.sendInputEvent({ type: 'keyUp', keyCode: 'B' })
				await sleep(300)
				const value = await view.executeJavaScript('document.getElementById("q").value')
				say('U5c — sendInputEvent into focused field: value=' + JSON.stringify(value))
			} catch (error) {
				say('U5c FAIL — ' + String(error))
			}

			// U5d: a real mouse press at guest coordinates must reach page handlers.
			try {
				await view.executeJavaScript(
					'window.__hit=0;var b=document.createElement("button");' +
					'b.textContent="click me";b.style.cssText="position:absolute;left:0;top:0;width:400px;height:120px";' +
					'b.onclick=function(){window.__hit+=1};document.body.appendChild(b);"ok"')
				await sleep(150)
				view.sendInputEvent({ type: 'mouseDown', x: 120, y: 60, button: 'left', clickCount: 1 })
				view.sendInputEvent({ type: 'mouseUp', x: 120, y: 60, button: 'left', clickCount: 1 })
				await sleep(300)
				const hit = await view.executeJavaScript('window.__hit')
				say((hit > 0 ? 'U5d PASS' : 'U5d FAIL') + ' — mouseDown/mouseUp reached guest (__hit=' + hit + ')')
			} catch (error) {
				say('U5d FAIL — ' + String(error))
			}

			if (typeof view.capturePage !== 'function') {
				say('U6 FAIL — capturePage is not a function')
			} else {
				try {
					const image = await view.capturePage()
					const dataUrl = image.toDataURL()
					say('U6 PASS — capturePage → ' + JSON.stringify({
						size: image.getSize(), dataUrlLength: dataUrl.length, empty: image.isEmpty(),
					}))
					beacon('screenshot', { dataUrl })
				} catch (error) {
					say('U6 FAIL — capturePage threw: ' + String(error))
				}
			}

			try {
				say('U3c — getURL/getTitle: ' + JSON.stringify({ url: view.getURL(), title: view.getTitle() }))
			} catch (error) {
				say('U3c FAIL — navigation getters: ' + String(error))
			}
			// N1: the DSH application origin must be refused by the main-process guard.
			try {
				await view.loadURL('http://127.0.0.1:8738/')
				say('N1 UNEXPECTED — loadURL(DSH origin) resolved; guard did not reject')
			} catch (error) {
				say('N1 PASS — loadURL(DSH origin) rejected: ' + String(error).slice(0, 200))
			}

			try {
				await bridge.release(reservation.lease)
				say('U2b PASS — release() resolved')
			} catch (error) {
				say('U2b FAIL — release() threw: ' + String(error))
			}
			say('DONE — probe finished')
		}

		/** The tab body: shows the transcript and hosts the guest element. */
		function ProbeBody() {
			const [, force] = React.useReducer((n) => n + 1, 0)
			const host = React.useRef(null)
			const started = React.useRef(false)
			const lines = React.useRef([])
			React.useEffect(() => {
				if (started.current) return
				started.current = true
				const say = (line) => {
					lines.current.push(line)
					beacon('run', { line, lines: lines.current.length })
					force()
				}
				globalThis.__AGENT_BROWSER_PROBE__ = lines.current
				Promise.resolve(exercise(host.current, say)).catch(error => say('FATAL — ' + String(error)))
			}, [])
			return h('div', { style: { height: '100%', overflow: 'auto', padding: '10px 12px' } },
				h('div', { style: { font: '12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace', whiteSpace: 'pre-wrap', marginBottom: 8 } },
					lines.current.length === 0
						? 'running…'
						: lines.current.map((line, index) => h('div', { key: index }, line))),
				h('div', { ref: host }))
		}

		function apply(ctx) {
			try {
				ctx.effect(() => ctx.sidebarRightTabs.register({
					id: TYPE_ID,
					kind: KIND,
					title: () => 'Browser Probe',
				}), 'agent-browser-probe: type')
				beacon('registered-type', {})
			} catch (error) {
				beacon('register-type-failed', { message: String(error) })
			}

			try {
				ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
					name: 'sidebar.right.pane.tab',
					key: TYPE_ID,
				}, ProbeBody)), 'agent-browser-probe: body')
				beacon('registered-body', {})
			} catch (error) {
				beacon('register-body-failed', { message: String(error) })
			}

			let attempts = 0
			const timer = setInterval(() => {
				attempts += 1
				try {
					ctx.sidebarRight.openTab(KIND)
					clearInterval(timer)
					beacon('opened-tab', { attempts })
				} catch (error) {
					if (attempts === 1) beacon('open-retry', { message: String(error) })
					if (attempts >= 30) {
						clearInterval(timer)
						beacon('open-failed', { message: String(error) })
					}
				}
			}, 500)
			ctx.effect(() => () => clearInterval(timer), 'agent-browser-probe: open')
		}

		exports.apply = apply
		exports.inject = ['slots', 'sidebarRight', 'sidebarRightTabs']
		return module.exports
	},
})
