/**
 * TICKET-036: the client half must put a page in the shell's Settings panel.
 *
 * The reason this needs a test at all: the shell finds a plugin's settings page
 * only through a `settings.section` slot registration. Without it the plugin is
 * installed, listed, and has no place in Settings  - which is exactly what the
 * user reported. A regression here is silent: the panel keeps working, and the
 * only symptom is a page that is not in a list.
 *
 * `plugin/client.js` is not an ES module (see toolviews.test.mjs), so the real
 * bundle is evaluated in a `vm` sandbox with a fake loader and a hook-aware
 * `react` stand-in, then `apply` is called with a fake slot service.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))

/** The smallest hook-aware React the settings page reads. */
function createReact() {
  const cells = []
  let index = 0
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.length <= 1 ? children[0] : children }
    },
    useState(initial) {
      const at = index++
      if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
      return [cells[at], (next) => { cells[at] = typeof next === 'function' ? next(cells[at]) : next }]
    },
    useEffect() {},
    useCallback(fn) { return fn },
    /** Render one component from a clean hook index. */
    render(Component) {
      index = 0
      return Component({})
    },
  }
}

/** Evaluate the bundle and return { plugin, slots, injected }. */
async function loadClient() {
  const React = createReact()
  const source = await readFile(CLIENT, 'utf8')
  let registration
  const sandbox = {
    window: {
      __ModuleLoader__: { load(next) { registration = next } },
      open() {},
      location: { href: 'http://127.0.0.1:0/' },
    },
    console,
    fetch: () => Promise.reject(new Error('offline: settings test')),
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    AbortController,
    Promise,
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'plugin/client.js' })
  assert.notEqual(registration, undefined, 'client.js did not register a module')
  const plugin = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`settings test: unexpected require(${JSON.stringify(specifier)})`)
  })

  const slots = []
  const injected = []
  const ctx = {
    effect(fn) { return fn() },
    slots: {
      inject(name, fn) { injected.push(name); return fn() },
      register(spec, Component) { slots.push({ spec, Component }); return () => {} },
    },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab() {}, openTabIn() {}, openResource() {} },
    layout: {},
  }
  plugin.apply(ctx)
  return { React, slots, injected }
}

/** Collect strings out of an element tree. */
function textOf(tree) {
  const parts = []
  const walk = (node) => {
    if (typeof node === 'string') { parts.push(node); return }
    if (Array.isArray(node)) { for (const item of node) walk(item); return }
    if (node === null || typeof node !== 'object') return
    walk(node.children)
  }
  walk(tree)
  return parts.join(' ')
}

test('the client half registers a settings.section page', async () => {
  const { slots, injected } = await loadClient()
  assert.ok(injected.includes('settings.section'), 'the client half never injected settings.section')
  const page = slots.find(({ spec }) => spec.name === 'settings.section')
  assert.notEqual(page, undefined, 'no settings.section registration')
  assert.equal(page.spec.id, 'dsh-plugin-agent-browser', 'the section id is what the shell keys the nav entry by')
  assert.equal(page.spec.order, 300)
  assert.equal(typeof page.spec.label, 'function', 'the shell expects a label per locale')
  assert.equal(page.spec.label(), '浏览器面板')
})

test('the page renders its title before any config has loaded', async () => {
  const { React, slots } = await loadClient()
  const page = slots.find(({ spec }) => spec.name === 'settings.section')
  const text = textOf(React.render(page.Component))
  assert.match(text, /浏览器面板/, 'the page must name itself while it loads')
  assert.match(text, /正在读取配置/, 'the first frame should say it is reading, not show an empty form')
})

test('the panel still registers its own sidebar tab next to the settings page', async () => {
  const { slots } = await loadClient()
  const names = slots.map(({ spec }) => spec.name)
  assert.ok(names.includes('sidebar.right.pane.tab'), 'the panel tab must survive the settings registration')
  assert.ok(names.includes('tool.call.toolview'), 'the transcript rows must survive as well')
})
