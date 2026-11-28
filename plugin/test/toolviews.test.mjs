/**
 * TICKET-023 — the transcript rows for `browser_open` / `browser_screenshot` /
 * `browser_download`.
 *
 * Why this file is a bit unusual: `plugin/client.js` is not an ES module. DSH
 * loads a client half through `window.__ModuleLoader__`, the factory receives a
 * narrow `require`, and the factory closes over everything it needs. There is
 * no importable component to test. So this file evaluates the real bundle in a
 * `vm` sandbox with two stubs — `window.__ModuleLoader__` (to capture the
 * registration) and `react` (a hook-aware fake) — then calls `apply` with a fake
 * slot service and renders the registered views as plain functions.
 *
 * What it proves:
 *   1. every registered slot key is a real tool name (a typo silently renders
 *      the generic row, so the comparison has to be against `createTools`);
 *   2. the views render for every call phase (preparing / start / result) and
 *      with a missing or malformed `meta` (old records have none);
 *   3. the data the cards depend on actually rides in `presentationMeta`
 *      (`url` for open, `thumb` for screenshot, `sha256` for download);
 *   4. `presentCall`/`presentResult` were kept — they are still what non-Web
 *      clients use.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createTools } from '../tools.js'

const CLIENT = fileURLToPath(new URL('../client.js', import.meta.url))
const TOOLS = fileURLToPath(new URL('../tools.js', import.meta.url))

/**
 * A hook-aware stand-in for `react`.
 *
 * Hooks are indexed per render pass. `<component>()` is called directly, so the
 * order is the order the component wrote. Effects are collected and run by the
 * test, which is exactly how the real card behaves: render, commit, resolve the
 * attachment URL, render again.
 */
function createReact() {
  const cells = []
  const effects = []
  let index = 0
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.length <= 1 ? children[0] : children }
    },
    useState(initial) {
      const at = index++
      if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
      return [cells[at], (next) => { cells[at] = typeof next === 'function' ? next(cells[at]) : next }]
    },
    useEffect(effect) {
      const at = index++
      effects.push({ at, effect })
    },
  }
  return {
    React,
    /** Render one component; returns its element tree and its pending effects. */
    render(Component, props) {
      index = 0
      effects.length = 0
      return { tree: Component(props), effects: [...effects] }
    },
    /** Run every pending effect, the way React commits them. */
    commit(effects) {
      for (const { effect } of effects) effect()
    },
  }
}

/** Evaluate the real client bundle and return its plugin registration. */
async function loadClient(React) {
  const source = await readFile(CLIENT, 'utf8')
  let registration
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(next) { registration = next },
      },
      open() {},
      location: { href: 'http://127.0.0.1:0/' },
    },
    console,
    // The bundle starts a poll loop in `apply`; in this sandbox it must neither
    // reach the network nor keep the process alive.
    fetch: () => Promise.reject(new Error('offline: toolviews test')),
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
  return registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`toolviews test: unexpected require(${JSON.stringify(specifier)})`)
  })
}

/** Render the plugin's slot registrations out of a fake Cordis context. */
async function registeredViews() {
  const fake = createReact()
  const plugin = await loadClient(fake.React)
  const slots = []
  const injected = []
  const effects = []
  const ctx = {
    effect(fn, id) { effects.push(id); return fn() },
    slots: {
      inject(name, fn) { injected.push(name); return fn() },
      register(spec, Component) { slots.push({ spec, Component }); return () => {} },
    },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTab: () => {}, openTabIn: () => {}, openResource: () => {} },
    layout: {},
  }
  plugin.apply(ctx)
  assert.ok(injected.includes('tool.call.toolview'), 'the client half never injected tool.call.toolview')
  const views = new Map()
  for (const { spec, Component } of slots) {
    if (spec.name !== 'tool.call.toolview') continue
    views.set(spec.key, Component)
  }
  return { views, fake, effects, inject: plugin.inject }
}

/** Walk an element tree and collect elements matching a predicate. */
function walk(tree, visit) {
  if (tree === null || tree === undefined) return
  if (Array.isArray(tree)) {
    for (const item of tree) walk(item, visit)
    return
  }
  if (typeof tree !== 'object' || typeof tree.type !== 'string') return
  visit(tree)
  walk(tree.children, visit)
}

function textOf(tree) {
  const parts = []
  walk(tree, (node) => {
    if (node.children !== undefined) {
      const collect = (value) => {
        if (typeof value === 'string') parts.push(value)
        else if (Array.isArray(value)) for (const item of value) collect(item)
        else if (value && typeof value === 'object' && typeof value.type === 'string') collect(value.children)
      }
      collect(node.children)
    }
  })
  return parts.join(' ')
}

const startBlock = (args) => ({ args: { text: (name) => args[name] } })

test('every slot key is a real tool name', async () => {
  const { views } = await registeredViews()
  const toolNames = createTools(
    { attachments: undefined },
    { request: async () => ({ ok: true }), takeDigest: () => '' },
    { ensure: async () => ({ url: 'http://127.0.0.1:1', root: '.', port: 1, token: 't' }) },
    { activation: 'auto', fitWidth: true, evalEnabled: true },
  ).map((tool) => tool.name)
  assert.deepEqual([...views.keys()].sort(), ['browser_download', 'browser_open', 'browser_screenshot'])
  for (const key of views.keys()) {
    assert.ok(toolNames.includes(key), `slot key ${key} is not a tool in plugin/tools.js`)
  }
})

test('the client half still injects the services it renders with', async () => {
  const { inject } = await registeredViews()
  for (const name of ['slots', 'sidebarRight', 'sidebarRightTabs', 'layout']) {
    assert.ok(inject.includes(name), `client half no longer injects ${name}`)
  }
})

test('cards render for every phase and never throw on a missing meta', async () => {
  const { views, fake } = await registeredViews()
  const phases = [
    ['preparing', { phase: 'preparing', block: {} }],
    ['start', { phase: 'start', block: startBlock({ url: 'https://example.com/x' }) }],
    ['result', { phase: 'result', block: { isError: false, content: [{ type: 'text', text: 'ok' }], meta: undefined } }],
    ['error', { phase: 'result', block: { isError: true, content: [{ type: 'text', text: 'cancelled: stop' }], meta: {} } }],
  ]
  for (const [key, Component] of views) {
    for (const [name, props] of phases) {
      const { tree } = fake.render(Component, {
        ...props,
        loadImage: async () => 'blob:test',
        openFile: () => {},
      })
      assert.equal(typeof tree.type, 'string', `${key} did not render in ${name}`)
    }
  }
})

test('browser_open shows the address as a link and flags a human check', async () => {
  const { views, fake } = await registeredViews()
  const { tree } = fake.render(views.get('browser_open'), {
    phase: 'result',
    block: {
      isError: false,
      content: [{ type: 'text', text: 'Opened https://example.com' }],
      meta: { url: 'https://example.com/start', title: 'Example', needsHuman: true },
    },
  })
  const links = []
  walk(tree, (node) => { if (node.type === 'a') links.push(node) })
  assert.equal(links.length, 1, 'expected one anchor')
  assert.equal(links[0].props.href, 'https://example.com/start')
  assert.match(textOf(tree), /人机验证/)
  assert.match(textOf(tree), /Example/)

  const start = fake.render(views.get('browser_open'), {
    phase: 'start',
    block: startBlock({ url: 'https://example.com/early' }),
  })
  const early = []
  walk(start.tree, (node) => { if (node.type === 'a') early.push(node) })
  assert.equal(early[0]?.props.href, 'https://example.com/early', 'the URL should appear while the call is still running')
})

test('browser_screenshot resolves the attachment and then shows the image', async () => {
  const { views, fake } = await registeredViews()
  const props = {
    phase: 'result',
    loadImage: async (ref) => `blob:${ref.attachmentId}`,
    openFile: () => {},
    block: {
      isError: false,
      content: [{ type: 'text', text: 'Saved screenshots/shot.png (1440 × 900 px, 83.5 KB)' }],
      meta: {
        path: 'screenshots/shot.png',
        bytes: 85_504,
        width: 1440,
        height: 900,
        sha256: 'a'.repeat(64),
        thumb: { attachmentId: 'att_1', mediaType: 'image/png', bytes: 9000, width: 720, height: 450 },
      },
    },
  }
  const first = fake.render(views.get('browser_screenshot'), props)
  assert.equal(textOf(first.tree).includes('screenshots/shot.png'), true, 'the file path should be visible')
  fake.commit(first.effects)
  // The card loads its URL from a promise; let the whole chain settle, not just
  // one microtask turn.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const second = fake.render(views.get('browser_screenshot'), props)
  const images = []
  walk(second.tree, (node) => { if (node.type === 'img') images.push(node) })
  assert.equal(images.length, 1, 'expected one thumbnail')
  assert.equal(images[0].props.src, 'blob:att_1')
})

test('browser_download shows size and a digest prefix, and echoes failures', async () => {
  const { views, fake } = await registeredViews()
  const ok = fake.render(views.get('browser_download'), {
    phase: 'result',
    block: {
      isError: false,
      content: [],
      meta: { path: 'downloads/regulation-2024.pdf', bytes: 2_048_000, sha256: 'abcdef0123456789'.repeat(4) },
    },
  })
  const okText = textOf(ok.tree)
  assert.match(okText, /regulation-2024\.pdf/)
  assert.match(okText, /2\.0 MB/)
  assert.match(okText, /sha256 abcdef012345/)

  const failed = fake.render(views.get('browser_download'), {
    phase: 'result',
    block: {
      isError: false,
      content: [{ type: 'text', text: 'Download failed at connect: refused' }],
      meta: { failed: true, stage: 'connect', reason: 'connection refused' },
    },
  })
  assert.match(textOf(failed.tree), /下载失败/)
  assert.match(textOf(failed.tree), /connection refused/)
})

test('the cards read fields the tools really put in presentationMeta', () => {
  const tools = createTools(
    { attachments: undefined },
    { request: async () => ({ ok: true }), takeDigest: () => '' },
    { ensure: async () => ({ url: 'http://127.0.0.1:1', root: '.', port: 1, token: 't' }) },
    { activation: 'auto', fitWidth: true, evalEnabled: true },
  )
  const meta = (name, args, value) => {
    const tool = tools.find((candidate) => candidate.name === name)
    assert.equal(typeof tool?.output?.presentationMeta, 'function', `${name} has no presentationMeta`)
    return tool.output.presentationMeta(args, value)
  }

  assert.deepEqual(meta('browser_open', { url: 'https://example.com/a' }, {
    url: 'https://example.com/a',
    title: 'Example',
    needs_human: true,
  }), { url: 'https://example.com/a', title: 'Example', needsHuman: true })
  // A workspace `path` is what makes the open card useful even without a title.
  assert.deepEqual(meta('browser_open', { path: 'demo.html' }, { url: 'http://127.0.0.1:9/t/x/demo.html' }), {
    url: 'http://127.0.0.1:9/t/x/demo.html',
    path: 'demo.html',
  })

  const shot = meta('browser_screenshot', { name: 'a.png' }, {
    path: 'screenshots/a.png',
    bytes: 900,
    sha256: 'b'.repeat(64),
    width: 800,
    height: 600,
    truncated: false,
    thumb: { attachmentId: 'att_1', mediaType: 'image/png', bytes: 800, width: 720, height: 540 },
  })
  assert.equal(shot.path, 'screenshots/a.png')
  assert.equal(shot.width, 800)
  assert.equal(shot.height, 600)
  assert.equal(shot.thumb.attachmentId, 'att_1', 'the thumbnail ref must survive into the persisted meta')

  assert.deepEqual(meta('browser_download', { url: 'https://e.com/f.pdf' }, {
    path: 'downloads/f.pdf',
    bytes: 2048,
    sha256: 'c'.repeat(64),
    mime: 'application/pdf',
  }), { path: 'downloads/f.pdf', bytes: 2048, sha256: 'c'.repeat(64), mime: 'application/pdf' })
  // A download failure is a *successful* tool result with a failure payload, so
  // the meta has to describe it instead of vanishing.
  assert.deepEqual(meta('browser_download', { url: 'https://e.com/x' }, {
    download_failed: { code: 'download_rejected', stage: 'connect', reason: 'refused' },
  }), { failed: true, stage: 'connect', reason: 'refused' })
})

test('presentCall / presentResult were kept for the clients that do use them', async () => {
  const source = await readFile(TOOLS, 'utf8')
  const calls = source.match(/^\s*presentCall\(/gm) ?? []
  const results = source.match(/^\s*presentResult\(/gm) ?? []
  assert.equal(calls.length, 20, `expected 20 presentCall definitions, found ${calls.length}`)
  assert.equal(results.length, 20, `expected 20 presentResult definitions, found ${results.length}`)
})
