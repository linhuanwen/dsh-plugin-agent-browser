# TICKET-002：双面包骨架与面板成型

- 状态: 通过（2026-11-19）
- 优先级: P0
- 关联 Spec: `docs/spec/001-agent-browser-plugin-spec.md` §3、§4、§5
- 依赖: TICKET-001 通过
- 源码目录: `D:\Vibe coding\32 deepseek harness cebiankuang\plugin\`（link 安装进 profile，无独立 node_modules 副本）

## 目标

把探针升级成一个真正的双面包：host 面注册工具、client 面渲染面板、两者之间有一条能往返的命令通道。做完这一步，Agent 应该能调 `browser_open` 让面板真的打开一个网址——哪怕其它工具都还没实现。

## 背景

架构上必须"工具在 host、执行在 client"（Spec §3.1）。通道方向是反的：typert Remote 天然是 client→host，而我们需要 host→client。默认走**队列 + 100ms 拉取**（Spec §3.2 方案 A），若 TICKET-001 附带验证发现 typert 支持推送，再换成事件（对外接口不变）。

可直接照抄的树内模板：`@deepseek-ai/dsh-experimental-client-ui-forge`（host + client + remote + typert 四出口）。

## 验收

- [x] 包结构就位：`dsh` 字段里 `client.platform = 'web'`，host 面与 client 面分别构建出 `lib/index.js` / `lib/client.js` —— **偏差**：手写纯 JS、无构建步骤，`main`/`exports` 直接指向 `index.js` / `client.js`（构建链留给 TICKET-007）
- [x] DSH 启动后，右侧栏 guide 里出现「浏览器（Agent）」，点开是一个空面板（地址栏 + 徽章 + 空容器 + 接管按钮，按钮先不接逻辑）—— 已注册 `guide[]`；卡片走标准卡回退（只有 terminal 包自带自定义卡渲染器）
- [x] Agent 调 `browser_open(...)` → 面板自动展开、webview 真实加载、地址栏显示 URL、徽章显示"Agent 正在操作" —— 用本地测试页 `http://127.0.0.1:8795/` 验证，工具返回 `Opened http://127.0.0.1:8795/ — Panel Test Page`（标题来自 guest 的 `getTitle()`）
- [x] 命令通道往返可观测 —— 改成了**可回读**的实现：host 半在 `127.0.0.1:8792/dsh-agent-browser/logs` 保留客户端上报的环形缓冲（`curl` 可读），实测时间线 `poll start → panel mount → lease acquired → guest dom-ready → poll got work → dispatch → run → settled`
- [x] 同一会话重复 `browser_open` 复用同一个 tab，不重复创建（第二次调用没有新的 `panel mount`）
- [x] 会话 A 与会话 B 各自一个 tab，互不影响 —— **实测带限制**：非当前显示会话的 tab 会被创建（`openTabIn`），但它的 body 不会挂载（DSH 只渲染当前会话的侧栏），所以工具在 1.5s 内失败并明确说明"该会话的面板不在屏幕上"。见 `docs/cases/003-channel-and-mount.md`
- [x] `browser_open` 在 tab 尚未创建时能自建（`dispatch` 发现没有 runner → 入队 → `openTab` → 面板挂载后取走队列）—— 证据：子代理会话（无 tab）收到命令后日志出现 `openTab {how:'openTabIn'}` 并建出 tab；当前会话内"关掉 tab 再自建"未单独实测，留给 TICKET-003 的日常使用覆盖


## 实测发现（2026-11-19）

1. **Slot 分发键是 tab 定义的 `id`，不是 `kind`**。官方 `BROWSER_ID = '@deepseek-ai/dsh-client-ui-sidebar-browser'` 用作 `sidebar.right.pane.tab` 的 key，而 `kind = 'browser'` 只用于 `openTab`。用 kind 当 key 时 tab 会出现但 body 永远是空白。这是本轮唯一一个"代码对、界面空"的根因。
2. **渲染器到 loopback 的 JSON POST 需要 CORS 预检**。`dsh-app://app` 源发 `content-type: application/json` 会先发 `OPTIONS`；bridge 只回 404 → 预检失败 → `settle()` 永远到不了 host，工具侧表现为 20s 超时。现在 `OPTIONS` 返回 204 + allow 头。
3. **非当前会话的面板无法驱动**（见上）。产品上接受：面板的价值就是"看得见"，看不见的会话没有可操作的页面，明确报错好过静默等待。
4. **client 半的热重载只有一条可靠路径**：`plugin_manager set_plugin` 切换 host 条目的 enabled 状态**不会**重载 client 半（实测报告数为 0）；必须 `remove_bundle` + `install_bundle`（各 0.3s / 1.2s），client 半随即重新执行 factory。


## 任务分解

- [x] 建包骨架：`package.json`（`exports` 四出口 + `dsh.client` + `dsh.bundle.patch`）—— 纯 JS，无 tsconfig/构建
- [x] host 面：`index.js` 注册 `browser_open`（入队 + 等 Promise），`tools.js` 放 `ToolDefinition`
- [x] host 面：`bridge.js` 实现按会话的队列 + `/pending` / `/settle` / `/log` / `/logs` / `/health`
- [x] 通道：loopback HTTP（`127.0.0.1:8792`）+ 100ms 拉取（页面隐藏时 500ms，失败指数退避）—— 取代 ticket 原计划的 typert 通道，理由见 `docs/cases/003-channel-and-mount.md`
- [x] client 面：`client.js` 注册 tab 类型（`priority:'extension'`、`keepMounted:true`、`title: () => '浏览器'`、`guide:[...]`）
- [x] client 面：`Panel` 四区块布局（地址栏 / 徽章 / webview 容器 / 接管按钮）
- [x] client 面：`Guest` 类封装 acquire → createElement → 挂载 → 释放（探针代码正式化）
- [x] client 面：拉取循环（在 `apply` 里，不在面板里——没有 tab 时也要能收到命令并开 tab）
- [x] 自动展开右侧栏（`ctx.sidebarRight.openTab` / `openTabIn` + `ctx.layout.openRightbar`）
- [x] 手动验收：同一会话复用 tab；跨会话列出限制


## 风险

| 风险 | 处置 |
|---|---|
| 100ms 拉取让首帧变慢 | 首批命令走"打开 tab"时的即时拉取；稳态再降频 |
| 客户端 bundle 构建链不熟（需要 host 侧产 `lib/client.js`） | 照 forge 的目录结构与 tsconfig 抄 |
| 会话与 tab 的生命周期错配（session 结束但 tab 还在） | 订阅 session 生命周期事件，结束时 release 租约 |

## 预估

1 个工作日。

## 参考

- `docs/cases/001-dsh-browser-internals.md` §5、§6、§7
- 模板包：`D:\deepseek harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-experimental-client-ui-forge\`
