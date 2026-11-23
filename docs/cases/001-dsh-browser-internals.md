# 取证材料：DSH 内置浏览器面板与桌面壳的内部机制

> 全部内容来自本机安装的 `0.2.2-rc.3`（`dshBuildCommit 6b729fedde0c8fd03af7afdf5a711aa64fe87c3b`），非文档推测。
> 用途：本项目所有实现都以这些事实为准；若升级后行为变化，需重新取证。

## 0. 环境与取证方法

| 项 | 值 |
|---|---|
| 安装目录 | `D:\deepseek harness\resources\app.asar\dsh` |
| 应用根 | `D:\deepseek harness\resources\app.asar\`（`package.json` 的 `main` 是 `lib/main.js`） |
| Electron 主进程 bundle | `D:\deepseek harness\resources\app.asar\lib\main.js`（828,725 B） |
| preload | `D:\deepseek harness\resources\app.asar\lib\preload-app.cjs`（120,841 B） |
| profile | `C:\Users\林焕文\.dsh\profiles\desktop` |
| Web GUI | `http://127.0.0.1:8738` |

**取证坑**：
- `read` 工具**可以**读 asar 内部路径；`grep`/`glob`/`Get-ChildItem`/`Select-String` **都不行**（报 "Invalid package" 或路径不存在）。
- 要在 asar 内做搜索，只能用 `ELECTRON_RUN_AS_NODE=1 "D:\deepseek harness\DeepSeek Harness.exe" <script.js>`，且脚本里**硬编码路径**（命令行参数带空格会被切碎）。
- PowerShell 5.1 下用 `Start-Process -Wait -RedirectStandardOutput` 抓输出最稳。

---

## 1. 主窗口开了 webview

```js
webPreferences: {
  preload,
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  webviewTag: primary,   // ← 关键
  devTools: true,
}
```

主进程里 `webviewTag` 出现 3 次，`will-attach-webview` 4 次，`guest` 53 次，**`executeJavaScript` 0 次**——主进程从不执行页面 JS，这是设计上的边界。

---

## 2. webview 租约守卫（`lib/main.js`，约 18140–18220 行）

```js
owner.on("will-attach-webview", (event, preferences, params) => {
  const id = params.src.startsWith("about:blank#") ? params.src.slice(12) : ""
  const lease = this.leases.get(id)
  if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
    event.preventDefault(); return
  }
  lease.attached = true
  for (const key of Object.keys(preferences)) if (key !== "disablePopups") Reflect.deleteProperty(preferences, key)
  Object.assign(preferences, {
    partition: lease.partition,
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    contextIsolation: true, sandbox: true, webSecurity: true,
    allowRunningInsecureContent: false, webviewTag: false, plugins: false,
    navigateOnDragDrop: false, disableDialogs: true, devTools: !app.isPackaged,
  })
  params.httpreferrer = ""
})
```

**对我们意味着**：
1. webview 的 `src` 必须以 `about:blank#<leaseId>` 起步，且 `partition` 与租约一致，否则挂不上。
2. 所有 preferences 会被强制覆写（沙箱化、禁用嵌套 webview、打包版无 devtools）。我们**干不掉**这层限制，也不需要——我们要的能力（`executeJavaScript`/`sendInputEvent`/`capturePage`）都在渲染器侧的 webview API 上。
3. 守卫**不检查发起方是哪个插件包**，只检查租约归属窗口。这是我们能复用租约的根本原因。

`did-attach-webview` 之后：

```js
guest.setWindowOpenHandler(({ url, postBody }) => {
  // 只有无 body 的 GET 且 allowedNavigation 通过，才开新 tab
  owner.send(DESKTOP_IPC.browserOpenRequested, { lease: attachedLease, url: new URL(url).href })
  return { action: "deny" }
})
guest.on("will-frame-navigate", (event) => {
  if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
})
guest.on("will-redirect", (event, url, _inPlace, mainFrame) => {
  if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
})
guest.on("will-attach-webview", (event) => { event.preventDefault() })   // 禁嵌套
guest.on("login", (event, _details, _authInfo, callback) => {            // 禁 Basic Auth
  event.preventDefault(); callback()
})
```

---

## 3. 导航白名单（`lib/main.js:18259`）

```js
allowedNavigation(value) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol)
    && url.username === "" && url.password === ""
    && !this.isApplicationHost(url);
}
isApplicationHost(url) {
  const value = this.hostUrl();
  if (value === void 0) return false;
  const host = new URL(value);
  return url.port === host.port
    && (url.hostname === host.hostname || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}
```

**结论**：
- `file:` 被硬拒 → 本地文件必须走临时静态服务（决策 D10）。
- loopback **只在端口等于 DSH 端口时**被拦 → `http://127.0.0.1:3000` 可用，`http://127.0.0.1:8738` 不可用。
- 这层在 asar 里，改了升级即失效，不改（决策 D07）。

---

## 4. 渲染器拿得到租约（`globalThis.dshDesktop`）

`preload-app.cjs` 里：

```js
createProductApi() → {
  protocolVersion: 1,
  fileActions: { save, readClipboardImage },
  browser: createDesktopBrowserBridge(),   // { acquire, release, onOpenRequested }
  fileDrag: { prepare, cancel },
  ...
}

createDesktopBrowserBridge() → {
  acquire: (workspace) => ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace),
  release: (lease) => ipcRenderer.invoke(DESKTOP_IPC.browserRelease, lease),
  onOpenRequested(lease, listener) { ... },
}
```

IPC 名：`browserAcquire = "dsh-desktop:browser-acquire"`、`browserRelease = "dsh-desktop:browser-release"`、`browserOpenRequested = "dsh-desktop:browser-open-requested"`。

这个对象挂在 `globalThis.dshDesktop` 上，**任何跑在同一渲染器里的客户端插件都能取到**：

```ts
// @deepseek-ai/dsh-client-ui-sidebar-browser/src/client/index.ts:69-72
const carrier = (globalThis as typeof globalThis & {
  dshDesktop?: { readonly protocolVersion: number; readonly browser?: DesktopBrowserBridge }
}).dshDesktop
const desktop = carrier?.protocolVersion === 1 ? carrier.browser : undefined
```

---

## 5. 官方面板怎么挂 webview（照抄的模板）

`.../src/client/electron/ElectronWebviewPresentation.ts`：

```ts
createElement(reservation: DesktopBrowserReservation): WebviewElement {
  const element = document.createElement('webview') as WebviewElement
  element.className = css.webview
  element.dataset.sidebarBrowserFrame = 'webview'
  element.setAttribute('name', reservation.lease)          // 租约 id
  element.setAttribute('partition', reservation.partition) // 租约 partition
  ...
}
```

`ElectronWebViewImpl.createGuest`：

```ts
const reservation = await this.bridge.acquire(this.workspaceKey)
this.lease = reservation.lease
// 导航：src = `about:blank#${lease}`，随后 webview.loadURL(target.url)
```

`.../src/client/index.ts:97-101`：桌面路径按会话解析 workspace，partition 因此是 **workspace 级**：

```ts
if (desktop === undefined) {
  installFrames(ctx, () => createIframePage)
} else {
  ctx.inject(['workspaces'], scope => installFrames(scope, sessionId => options =>
    createElectronPage(options, desktop, signal => browserWorkspace(scope.workspaces.list, sessionId, signal))))
}
```

---

## 6. 侧栏 tab 是公开服务

`.../src/client/index.ts:40,74,82,102`：

```ts
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']
ctx.effect(() => ctx.sidebarRightTabs.register({ ...browserDefinition(t), keepMounted: desktop !== undefined }), 'ui-sidebar-browser.type')
scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({ name: 'sidebar.right.pane.tab', key: BROWSER_ID, inject: (sessionId, actions) => ... }))
ctx.slots.inject('sidebar.right.pane.tab.title', () => ...)
```

`.../src/client/tab-registry.ts:49,94-139,245-251`（2026-11-19 按 `0.2.2-rc.3` 复核全文）：

```ts
export type SidebarRightTabPriority = 'extension' | 'builtin' | 'fallback'
export interface SidebarRightTabDefinition {
  readonly id: string
  readonly kind: string
  readonly multiple?: boolean
  readonly keepMounted?: boolean
  readonly patterns?: readonly string[]
  readonly priority?: SidebarRightTabPriority          // 默认 'extension'
  readonly canOpen?: (address: string) => boolean
  readonly title: (address: string) => string          // 必填，thunk
  readonly guide?: readonly SidebarRightGuideEntry[]   // { id, order, title: () => string, description?, icon?, commandId? }
}
```

- **没有 `titles: { zh, en }`，也没有顶层 `icon`**：`title` 是必填 thunk，`icon` 只存在于 `guide[]` 条目里。（spec §4.1 的旧版写错了这两个字段，已按上表修正。）
- `guide` 省略 = 该类型不出现在右侧栏引导页 → 用户**没有可见入口**，必须自己调 `openTab`。
- 打开走 `ctx.sidebarRight.openTab(kind, options)` 或 `openResource(address, options)`（`service.ts:216-252`）；`openTab` 的 options = placement + `params`，`address` 必须是 `dsh-resource://` 才是 resource 那条路。
- 一个 kind 可同时挂一个 `builtin` 和一个 `extension`；`extension` 会接管该 kind，直到它注销。
- 同 band 重复注册、id 重复、命中 fallback → 抛错。

---

## 7. 双面包（host + client + Remote）的树内模板

`@deepseek-ai/dsh-experimental-client-ui-forge` 的 `package.json`：

```json
{
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./remote": "./lib/typert.remote-client.js",
    "./typert": "./lib/typert.host.js"
  },
  "dsh": {
    "client": {
      "inject": ["@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-client-locale",
                 "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-layout",
                 "@deepseek-ai/dsh-client-ui-plugin-manager", "@deepseek-ai/dsh-client-ui-settings",
                 "@deepseek-ai/dsh-client-ui-sidebar-right", "@deepseek-ai/dsh-client-ui-workspace"],
      "platform": "web"
    }
  }
}
```

依赖：`@deepseek-ai/dsh-typert-protocol`、`dsh-storage-domain`、`zod`、`schemastery`、`picomatch`。

相关包定位（`packages.md`）：
- `@deepseek-ai/dsh-api-gateway` — "Typert Remote Host dispatcher and Client API endpoint"
- `@deepseek-ai/dsh-api-terminal-controller` — "Session-owned interactive terminals with shell discovery, screen recovery and typed Remote control"（**最接近本项目的类比**：宿主驱动一个客户端 UI）
- `@deepseek-ai/dsh-client-modules` — "Client module system, dual-face: node half composes the `__DSH_BOOT__` entry graph"

---

## 8. 官方面板的边界（README 原文）

- `.../README.md:12`：*"Browse HTTP(S) pages, including loopback services, inside independent right-Sidebar tabs. Web uses an iframe...; Desktop uses Electron `<webview>` with native navigation history and retained pages. **The package never injects Electron or Node access into visited content.**"*
- `.../README.md:59`：*"The address parser accepts HTTP and HTTPS, including loopback targets. **It rejects `file:` URLs**, script/data/blob input, embedded credentials, the DSH application origin, and malformed addresses. Document Preview owns local-file rendering."*
- `.../README.md:92`：**"## Model Experience — None, as Browser tabs are user-facing presentation state and register no tool, prompt section, or Session event."** ← 这就是"面板有了但 Agent 控不了"的官方确认。
- `.../README.md:110`：*"Desktop shares process-local storage partitions by canonical workspace CWD; Sessions without a resolved Workspace are isolated separately. **Cookies and Web storage do not survive application restart.** Guest permissions, downloads and native popups are denied; approved HTTP(S) popup requests open Sidebar tabs."*
- `.../README.md:43`：*"Client plugins can open a tab through `ctx.sidebarRight.openTab('browser', { params: { url } })`."*

---

## 9. 地址解析的官方实现（可照抄的 45 行）

`.../src/client/browser/url.ts`：

```ts
export const MAX_BROWSER_URL_LENGTH = 16 * 1024
export type BrowserAddressFailure = 'empty' | 'invalid' | 'protocol' | 'credentials' | 'application-origin'

export function parseBrowserAddress(input: string, applicationOrigin?: string): BrowserAddressResult {
  const trimmed = input.trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  if (trimmed.length > MAX_BROWSER_URL_LENGTH) return { ok: false, reason: 'invalid' }
  const explicitScheme = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/u.test(trimmed)
  const candidate = explicitScheme ? trimmed : `https://${trimmed}`
  let url: URL
  try { url = new URL(candidate) } catch { return { ok: false, reason: 'invalid' } }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    if (applicationOrigin !== undefined && applicationOrigin !== 'null') {
      try { if (url.origin === new URL(applicationOrigin).origin) return { ok: false, reason: 'application-origin' } } catch {}
    }
    return { ok: true, target: { kind: url.protocol === 'https:' ? 'https' : 'http', url: url.href, title: url.hostname } }
  }
  return { ok: false, reason: 'protocol' }
}
```

跨包 import 不可靠（客户端是打包产物），**照抄这段逻辑**即可。

---

## 10. `dsh-pilot` 的快照不可复用

`C:\Users\林焕文\.dsh\profiles\desktop\node_modules\dsh-pilot\lib\snapshot.js`（1,531 B）全文只做三件事：

```js
const REF_MARKER = /\[ref=([a-z0-9]+)\]/g
export function buildSnapshot(snapshot, maxChars) { /* 按行截断 + 统计 ref 数 */ }
export function isRefShaped(ref) { return /^(f\d+)*e\d+$/.test(ref) }
```

它的输入是 Playwright 的 `page.ariaSnapshot({ mode: 'ai' })`，ref 的解析靠 Playwright 私有的 `aria-ref=` 定位器。**webview 里没有 Playwright**，树和 ref 必须自己写（决策 D06）。

其他文件规模：`engine.js` 14,146 B、`index.js` 32,967 B、`policy.js` 6,211 B、`cancellation.js` 2,963 B。

---

## 11. Bundle 打包的官方要求

来自 `dsh-doc/references/host-plugin.md`：

- bundle = 一个包，`package.json` 里声明 `dsh.bundle.patch` 指向一个 `cordis.patch.yml`，里面用 `insert:` 插入插件行。
- 安装走 `plugin_manager install_bundle`，**不要**用 shell 手工铺。
- 展示元数据来自 locale JSON 的 `meta.title` / `meta.description` / `meta.detail`。
- 图标：`./icon` 导出或顶层 `icon`（SVG/PNG/JPEG/WebP，≤256 KiB）。
- 详情文档 ≤1 MiB（`pluginManager.detailMaxBytes`），且**只能写已验证的行为**。

---

## 12. 未知项 → 探针实测状态（2026-11-19）

| # | 未知 | 影响 | 结论 |
|---|---|---|---|
| U1 | 第三方 `platform: 'web'` 客户端插件能否读到 `globalThis.dshDesktop.browser` 并 `acquire()` | 致命 | ✅ **已验证可用**：`protocolVersion: 1`，`acquire()` 返回 `{ lease, partition }` |
| U2 | 自建 `<webview>`（`name`/`partition`/`about:blank#lease`）能否通过 `will-attach-webview` | 致命 | ✅ **已验证可用**；注意 `src` 必须在 append **之前**就位，否则 guest 根本不创建 |
| U3 | `webview.executeJavaScript()` 在 sandboxed guest 上是否可用 | 致命 | ✅ **已验证可用**：`1+1 → 2`，可读 guest DOM |
| U4 | `webview.sendInputEvent()` 能否驱动 guest（坐标是否精确） | 高 | ✅ **已验证可用**：`mouseDown/mouseUp` 直达页面 `onclick`；键盘事件只到 document，**需先 `executeJavaScript` 聚焦控件** |
| U5 | `webview.capturePage()` 返回值与性能 | 中 | ✅ **已验证可用**：返回 NativeImage，尺寸是**设备像素**（DPR 1.5 下 `1115 = 743.33 × 1.5`） |
| U6 | typert 是否支持 host→client 推送（否则用 100ms 拉取） | 中 | ⬜ **仍未验证**（探针没碰 Remote 通道，留给 TICKET-002） |

完整实测记录见 `docs/cases/002-probe-results.md`。
