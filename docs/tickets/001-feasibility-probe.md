# TICKET-001：可行性探针

- 状态: ✅ **通过**（2026-11-19）。六项全过，实测记录见 `docs/cases/002-probe-results.md`
- 优先级: P0（阻塞全部后续工作）
- 关联 Spec: `docs/spec/001-agent-browser-plugin-spec.md` §3、§4.1、§4.3、§12
- 目标目录: `C:\Users\林焕文\.dsh\profiles\desktop\node_modules\dsh-plugin-agent-browser\`（临时，探针结束后可复用为正式包骨架）

## 目标

用最小代价回答一个问题：**第三方客户端插件能不能在自己的面板里挂一个 webview，并在里面执行 JS、发真实输入、截图？**

这不是"顺便试试"，这是整个项目的生死线。探针不过，项目直接归档，退回 `dsh-pilot` 外部 Chrome 方案。

## 背景

官方面板能做到，是因为它在渲染器里 `document.createElement('webview')` + `bridge.acquire()`。主进程的 `will-attach-webview` 守卫**只校验租约归属窗口**，不校验发起方是哪个包——理论上任何插件都能复用。但官方包只用了导航能力，`executeJavaScript` / `sendInputEvent` / `capturePage` 是**未验证区**（见 `docs/cases/001-dsh-browser-internals.md` §12 的 U1–U6）。

## 验收

探针必须在**真实 DSH 桌面端**里跑（不是 unit test 环境），六条全过才算通过：

- [x] U1 `globalThis.dshDesktop?.protocolVersion === 1` 且 `browser` 存在
- [x] U2 `await browser.acquire(workspace)` 返回 `{ lease, partition }`（非空字符串）
- [x] U3 自建 webview（`name=lease`、`partition`、`src=about:blank#lease`）挂载后触发 `dom-ready`，且 `will-attach-webview` 未被 `preventDefault`
- [x] U4 `executeJavaScript('1+1')` 返回 `2`；`executeJavaScript('document.title')` 返回真实标题
- [x] U5 `sendInputEvent` 点击能触发页面上的真实事件（页面里 `<button onclick="window.__hit=1">`，点完 `executeJavaScript('window.__hit')` 得 1）— 实测 `mouseDown/mouseUp` → `__hit=1`；键盘事件见下
- [x] U6 `webview.capturePage()` 返回非空 NativeImage，宽高与视口一致（**先确认这个方法在 `<webview>` 标签上存在**：Electron 的 `capturePage` 长在 `webContents` 上，`WebviewTag` 是否透出它尚未核实；若不存在，记录 `getWebContentsId()` 路线是否可行）

> 实测补充（原始验收单里没写、但实现必须知道）：键盘 `sendInputEvent` 只到 document，**要先 `executeJavaScript('el.focus()')` 再发**才进得了输入框（U5c）；`capturePage()` 返回的是设备像素（DPR 1.5 下 `1115 = 743.33 × 1.5`）。

附带验证（不阻塞，但记录结果）：

- [ ] `webview.loadURL()` 能否导航到 `https://example.com`（不是被 `will-frame-navigate` 拦）— **未测**（探针全程用 `data:` URL，未碰外网）
- [x] 导航到 `http://127.0.0.1:8738` 是否被拒（应当被拒，验证 `isApplicationHost`）— **被主进程拒绝**：`Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_FAILED (-2)`
- [ ] typert 有没有 server→client 推送能力（查 `dsh-api-remotes` / `dsh-typert-protocol` 的事件 API；没有就走 100ms 拉取）— **未测**，留给 TICKET-002

## 探针实现（最小可跑）

1. 在 profile 的 `node_modules` 下建 `dsh-plugin-agent-browser/`（**双面包**，host 面先给空 `apply`）：
   ```
   package.json   { "name": "dsh-plugin-agent-browser", "type": "module",
                     "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
                     "dsh": { "client": { "platform": "web",
                                          "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"] } } }
   lib/index.js   ← host 面：`export function apply() {}`（占位，探针不放工具）
   lib/client.js  ← 手写、不用构建，直接 ESM
   ```
   > 不做 client-only 包。本 profile 里 `dsh-token-stats` / `dsh-plugin-wallpaper-engine` / `dsh-dream-skin` / `dshmarket` / `billion-context` **全是** `dsh.client { platform: 'web' }` + host 面的双面包，client-only 没有先例。
2. `lib/client.js` 内容：`export function apply(ctx)` 里
   - `ctx.effect(() => ctx.sidebarRightTabs.register({ id:'agent-browser-probe', kind:'agent-browser-probe', priority:'extension', multiple:true, keepMounted:true, title: () => '探针', guide: [{ id:'open', order:30, title: () => '探针', description: () => '可行性探针' }] }), 'probe: type')`
     （**没有 `titles`、没有顶层 `icon`**，见 spec §4.1）
   - 注册 `sidebar.right.pane.tab` 的 body：一个 `<div>`，里面按顺序 try/catch 跑 U1–U6，把每一步的结果以文本写进 div（**人能直接看见**），同时 `console.log`。
   - 页面用 `executeJavaScript` 注入：`document.body.innerHTML = '<button id=b onclick="window.__hit=1">hit</button>'`；点它用 `sendInputEvent({type:'mouseDown', x:20, y:20, button:'left', clickCount:1})` + `mouseUp`。
3. 在 profile 的 `cordis.patch.yml` 里 `insert` 一行启用它（或按该 profile 现有插件行的格式追加）。
4. 重启 DSH 桌面端。**探针不会自己出现**（`guide` 条目只是引导页的一个盒子），必须显式打开：
   - 首选：在 `apply` 里直接 `ctx.sidebarRight.openTab('agent-browser-probe', { params: { probe: true } })`，或加一个短延时/按钮触发；
   - 兜底：右侧栏 → 引导页 → 点「探针」盒子（需要 `guide` + 一条命令实现）。
5. 读结果。

> 探针不注册工具、不碰 Remote——host 面的 `apply` 是空占位，**只验证渲染器能力**。做成双面包只是为了让加载路径和正式包一致（免得 TICKET-002 才发现 host 面加载方式不对）。

## 失败分支

| 失败点 | 处置 |
|---|---|
| U1（拿不到 `dshDesktop`） | 说明 preload 的产品 API 只对官方包可见 → 方案作废，归档本项目，回到 `dsh-pilot` |
| U2（acquire 被拒） | 同上（主进程可能校验了调用方） |
| U3（webview 挂不上） | 检查三要素（`name`/`partition`/`about:blank#lease`）；若确认无误仍失败，方案作废 |
| U4（executeJavaScript 不可用） | 方案作废（Agent 没法读页面） |
| U5（sendInputEvent 无效） | **降级可行**：改用 `element.click()` + 原生 `input` 事件派发（丢 `isTrusted`，多数站点仍可用），但要重估可靠性 |
| U6（capturePage 失败或方法不存在） | **降级可行**：去掉截图能力，只保留文本树（违背决策 D08，需用户重新确认）。若 `WebviewTag` 完全不透出截图能力，再评估"host 面经主进程 `webContents.fromId(id).capturePage()`"是否有可用 IPC——注意 `DesktopBrowserBridge` 注释明说它不跨 Electron 对象，这条路的希望不大 |

## 任务分解

- [x] 建探针包骨架（`package.json` + `lib/client.js`）
- [x] 写 U1–U6 的串行验证脚本，结果同时写 DOM 和 console
- [x] 在 profile 里启用并重启
- [x] 记录每步实际输出（截图 + 文本）到 `docs/cases/002-probe-results.md`
- [x] 判定通过/失败，更新 `README.md` 的状态表
- [x] 若通过：把探针代码整理成 TICKET-002 的骨架起点

## 实测偏差（计划书 vs 现实）

计划书里的三条实现假设被实测推翻，已在 `docs/cases/002-probe-results.md` §3 记全：

1. **不用手放 profile `node_modules`**：放 workspace 目录用 `plugin_manager install_bundle` 装，得到的是 link 安装，代码改动直接生效，profile 零污染。
2. **client 半不是裸 ESM**：必须包 `window.__ModuleLoader__.load({ id, factory(require){ … return module.exports } })`，`exports.inject` / `exports.apply` 挂在返回对象上（同 `tools/probe/client.js`）。
3. **不用重启 DSH**：`install_bundle` 即 `applied`；迭代靠 `set_plugin` 关→开，client 半会重新加载（数十秒一轮）。
4. 探针的 `guide` 兜底入口没做也不需要——`apply` 里直接 `ctx.sidebarRight.openTab(KIND)`，500ms 重试，第 1 次成功。

## 预估

30–60 分钟（含一次应用重启）。风险点在于 profile 的插件加载格式，若 `cordis.patch.yml` 的写法不对，多花 15 分钟。

## 参考

- `docs/cases/001-dsh-browser-internals.md` §4（租约入口）、§5（官方挂载模板）、§12（未知项）
- 官方模板：`D:\deepseek harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-client-ui-sidebar-browser\src\client\electron\ElectronWebviewPresentation.ts`
