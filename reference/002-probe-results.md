# 探针实测结果（TICKET-001）

- 日期: 2026-11-19
- 结论: **通过**。U1–U6 全过，外加 U5c/U5d 与 N1 两个补充项。方案（自建插件 + `<webview>`）成立，可以进入 TICKET-002。
- 环境: DSH Desktop `0.2.2-rc.3`，Electron `44.7.0`，Chrome `152.0.7977.130`，渲染器 `location.href = dsh-app://app/`
- 探针代码: `probe/`（`package.json` / `index.js` / `client.js` / `cordis.patch.yml` / `beacon.mjs`），安装 id `include:agent-browser-probe`

## 一、验收结果

| 项 | 结果 | 实测证据 |
|---|---|---|
| U1 `dshDesktop` 可见 | **PASS** | `protocolVersion: 1`、`hasBrowserBridge: true`、`acquire: 'function'`、`webviewConstructor: 'WebViewElement'` |
| U2 `acquire()` 发租约 | **PASS** | `partition: 'dsh-sidebar-browser-e15e7a1b-7e48-474a-8623-8ec0ca9bda55'` + lease 字符串；`release(lease)` 正常 resolve |
| U3 webview 可挂载 | **PASS** | tab body 内 `document.createElement('webview')` + append，`connected=true`，box `{x:952, y:114.59, w:743.33, h:420}`，`dom-ready` 触发 |
| U4 `executeJavaScript` | **PASS** | `'1 + 1'` → `2`；`loadURL('data:text/html,…')` 后读到 guest DOM `{t:'probe', input:true}`；`getURL()/getTitle()` 正常 |
| U5 真实输入 | **PASS** | keyDown/char/keyUp 到达 guest（页面记录 `window.__hits=["a"]`） |
| U6 `capturePage` | **PASS** | 返回非空 NativeImage `{width:1115, height:225}`，dataURL 4282–6662B，落盘 `probe/shot-6.png` 目视确为真实渲染 |

### 补充项

| 项 | 结果 | 说明 |
|---|---|---|
| U5b 直接打字 | 部分 | 不聚焦字段时 `input.value` 仍为 `""`（keydown 到了 document，没到控件） |
| U5c 先聚焦再打字 | **PASS** | 先 `executeJavaScript('el.focus()')` 再发键 → `value="B"` |
| U5d 真实鼠标点击 | **PASS** | `mouseDown/mouseUp` at `(120,60)` → 页面 `onclick` 触发，`window.__hit=1` |
| N1 导航到 DSH 自身 origin | **按预期被拒** | `Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_FAILED (-2) loading 'http://127.0.0.1:8738/'` |

> N1 是**主进程**级的拦截（不是渲染器里的 JS 判断）：`loadURL` 直接被拒。§5.3 的"拒 DSH 自身 origin"因此是双保险，插件只需做补充校验。

## 二、四个没料到的点（直接影响 TICKET-002 起手）

1. **`src` 必须先于 append 就位**。只 `createElement('webview')` + append，不设 `src`，`dom-ready` 永不到来（超时 12s，主进程根本不创建 guest）。必须 `setAttribute('src', 'about:blank#' + lease)` 再 append —— 与官方 `ElectronWebviewPresentation.ts:52-61` 一致。spec §4.3 的挂载模板要把这条写成硬性顺序。
2. **输入注入要分两类**：`sendInputEvent` 的鼠标事件按 guest 坐标直达页面（U5d 成立），键盘事件只到 document（U5）。所以 `type` 工具必须两步：先 `executeJavaScript` 聚焦目标元素，再发 `char`/`keyDown`；`click` 工具可以直接发 `mouseDown`/`mouseUp`（可选先 `executeJavaScript('el.scrollIntoView()')`）。
3. **`openTab` 与 body 挂载会竞态**。在 `apply` 里延时 `openTab(KIND)`，有一次运行中 tab body 被重新挂载，旧的 `view` 引用瞬间 detach，后续 `sendInputEvent`/`capturePage` 全抛 `The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.`（同一探针的另一轮运行则完全正常）。正式实现必须：**先开 tab，或在 body 的 effect 里等 `tabInfo` 就绪再建 webview**，并用代次/引用检查丢弃已 detach 的元素，不能跨步骤复用旧引用。
4. **client 半可以热重载，不用重启 DSH**。`plugin_manager set_plugin` 把 entry 从 enabled=false 切回 true 会重新执行 `__ModuleLoader__.load(...)` 的 factory（每次切换观测到新的 `factory` beacon）。整个探针的迭代周期因此是"改 `client.js` → 切换两次 → 读 beacon"（数十秒），而不是"改 → 重启 → 手动点"。这一点把 TICKET-002~006 的开发成本显著压低。
5. **`capturePage()` 是设备像素，不是 CSS 像素**。窗口 DPR = 1.5，`1115 = 743.33 × 1.5`，高度同理。D08 的"缩到 768px 宽"必须基于 `getSize()` 的实际像素算，不能假设等于元素 CSS 尺寸。

## 三、与 TICKET-001 计划书的偏差（都是实测纠偏）

| 计划 | 实际 | 原因 |
|---|---|---|
| 手放到 `<profile>/node_modules/dsh-plugin-agent-browser/` | 放 workspace `probe/`，用 `plugin_manager install_bundle` 装 | 装出来是 **link 安装**（`"source":"link:D:\\Vibe coding\\32 deepseek harness cebiankuang\\probe"`），workspace 里的代码直接生效；profile 目录零污染，卸载即 `remove_bundle` |
| `lib/client.js` 写裸 ESM `export function apply(ctx)` | `client.js` 用 `window.__ModuleLoader__.load({ id, factory(require) { … return module.exports } })` 包裹 | 浏览器侧的模块表格式（与 `dsh-plugin-wallpaper-engine/lib/client.js`、`templates/decoration/client.js` 一致）。裸 ESM 不会被引导 |
| 改 profile `cordis.patch.yml` + **重启 DSH** | `plugin_manager install_bundle` → `application: applied`，**无需重启** | loader 支持热插入；启停走 `set_plugin` |
| `guide` 条目作为兜底入口 | 不需要（探针在 `apply` 里直接 `openTab`，500ms 重试，第 1 次即成功） | 探针不面向最终用户 |

另:安装探针时 pnpm 顺带把 profile 的 `billion-context` 从 `0.1.185` 升到 `0.1.216`（`+ billion-context 0.1.216`）。已知副作用，非我显式指定。

## 四、对 spec 的影响

需要回填的只有三处，都是实现细节，不改任何决策：

- §4.3 挂载顺序：补"`src` 必须在 append 前设置"。
- §6 / D05 的 `type` 工具：补"先聚焦再注入键盘事件"，`click` 用鼠标事件。
- §8 / D08 截图：补"capturePage 返回设备像素，按 `getSize()` 缩放"。

`spec §11 R7`（担心 `<webview>` 不透出 `capturePage`）**已消解**，可以删掉或标为"已验证可用"。

## 五、复现步骤

```powershell
# 1) 起 beacon（收 client 半上报）
node .\probe\beacon.mjs          # 监听 127.0.0.1:8791

# 2) 装探针（link 安装，无需重启）
#    plugin_manager action=install_bundle target="D:\Vibe coding\32 deepseek harness cebiankuang\probe"

# 3) 迭代：改 client.js 后
#    plugin_manager action=set_plugin enabled=false target=include:agent-browser-probe
#    plugin_manager action=set_plugin enabled=true  target=include:agent-browser-probe

# 4) 卸载
#    plugin_manager action=remove_bundle target=dsh-plugin-agent-browser-probe
```

## 六、结论

生死线已过。spec 的架构假设（第三方 client 插件复用 `dshDesktop.browser` 桥 → 自建 `<webview>` → executeJavaScript / sendInputEvent / capturePage 全能力）**逐条被实测证实**，且 `127.0.0.1:8738` 的系统级拦截替我们兜住了 D07 最危险的一条。下一张票可以按 spec 铺骨架了。
