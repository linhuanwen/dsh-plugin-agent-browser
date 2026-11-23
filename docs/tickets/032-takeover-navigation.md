# TICKET-032 人工接管后的浏览闭环：点击要能走、后退要有路

- **状态**：✅ 已完成（2026-11-23，1.4.12 装机验收；用户实测可点击、可后退/前进/刷新）
- **优先级**：P0（上线阻塞：G2 登录后接管，人点不动、退不回，等于面板只能在 Agent 手里用）
- **来源**：2026-11-23 上线测试 G2 —— 1688 验证码过墙并登录后，用户接管点商品卡"点了没反应"；修好点击后反馈"好像不具备回退的方式"
- **对应验收**：`docs/release/launch-test-plan.md` §3 G2（真实站点验证墙 + 登录 + 接管）；`docs/cases/014-practical-cases.md` S5

## 1. 问题

人工接管在真实站点上连撞两个缺口，**都是"人接管后不能像浏览器一样用"**：

1. **点击无效**。1688 商品卡用 `target="_blank"`（实测样本 target 全为 `_blank`）或 `window.open`。面板的 `<webview>` 不允弹窗（spec A15：弹窗是看不见也控不了的新窗口），旧守护把这类导航一并拦掉，于是点击"没有反应"。
2. **没有回退**。面板顶部只有 地址栏 + Go + 接管按钮。Agent 可以 `browser_open` 任意跳，人接管后点进商品详情就**回不到列表**（没有后退/前进/刷新）。

第一轮修（1.4.10）只修了一半，现场实测仍无效，根因在下一层：

> 守护代码在 `inject/actions.js` 的 `installGuards()` 里，而它由 `dshAction` 调用时才执行。人接管一个**刚加载**的页面、直接点商品时，本页**从未跑过任何动作命令**，也就没有任何监听器。点击照旧向 Chromium 要新窗口，被 `<webview>` 静默丢弃。

## 2. 修法

| 版本 | 分层 | 改动 |
|---|---|---|
| 1.4.10 | 页面守护 | `installGuards()` 增加 capture 阶段 click/submit：沿 `parentElement` 上溯到 `A`/`FORM`，把非 `_self/_top/_parent` 的 `target` 改写成 `_self`；`window.open` 改读 `window.__dshDriver`（human 且 http(s) → `location.assign`，agent → 返回 null 并记录） |
| 1.4.10 | 客户端 | `guestsBySession` 注册表；`Guest.driver / applyDriver() / setDriver()`；`setPhaseLocal()` 在 `taken_over` / `needs_human` 时广播 driver=human，`did-navigate` / `did-stop-loading` 重新 apply |
| 1.4.11 | 注入通道 | 新增 `plugin/inject/guards.js`（独立函数 `dshGuards(driver)`，rev 2）；`plugin/tools.js` 导出 `guardsSource()`；`plugin/apply.js` 的 `sources` 加 `guards`（经 `/source?name=guards` 下发）；`plugin/client.js` 新增 `Guest.injectGuards()`，在 `dom-ready`、`did-navigate`、`did-navigate-in-page`、`did-stop-loading` 后注入；`inject/actions.js` 检测 `window.__dshGuardInstalled` 后跳过自己的那套（避免双包 `window.open`） |
| 1.4.12 | 面板工具栏 | `Guest` 新增 `historyState() / canGoBack() / canGoForward() / goBack() / goForward() / reloadPage() / syncHistory()`；面板地址栏左侧加 **‹ › ⟳** 三个按钮，可用态随导航事件刷新；`CLIENT_REV` 45 |

单测：`plugin/test/actions.test.mjs` +3 例（1.4.10）、`plugin/test/guards.test.mjs` 7 例（1.4.11）；全量 **178 / 178**。

## 3. 验收证据

| # | 断言 | 证据 |
|---|---|---|
| 1 | 刚加载页面（未跑任何命令）已有守护 | `browser_eval` → `{guardInstalled:true, guardRev:2, driver:'agent'}` |
| 2 | capture 改写 `target` 并同视图跳转 | 合成点击 `target="_blank"` 的「足迹」链接 → 点击瞬间 `targetNow:"_self"`，页面在面板内跳到「我的收藏夹」 |
| 3 | 新文档重新注入守护 | 跳转后 `browser_eval` → `{guardRev:2, driver:'agent'}` |
| 4 | Agent 阶段仍拒新窗口 | `guards.test.mjs`：`window.open` 返回 null、`__dshBlocked` 记录、`location.assign` 未调用 |
| 5 | Human 阶段同视图导航 | `guards.test.mjs`：`window.open` → `location.assign(url)`，不记 blocked |
| 6 | 人接管点商品能进详情 | 用户实测 1.4.11：接管后点商品卡，面板内进入商品页 |
| 7 | 后退/前进/刷新可用 | 用户实测 1.4.12（重启 DSH 后）：‹ 回列表、› 前进、⟳ 刷新 |

## 4. 偏差与残留

- 跨域 iframe 内的点击不经过本页 listener（守护只装在顶层文档）；登录框这类跨域 iframe 里的交互一直由人直接操作。
- `window.open()` 无参数（先开空白窗再写入）仍被拒——那种窗口面板无法命名和驱动。
- 客户端 UI 改动要**重启一次 DSH（或刷新 GUI）**才出现：热更新只换逻辑，已挂载的组件仍是旧 bundle。已写进用户 README 故障排查。
- 1.4.12 只加"会话内历史"的按钮，不提供标签页历史（多标签仍由 sidebar 页签承担）。

## 5. 变更记录

| 版本 | 产物 | 说明 |
|---|---|---|
| 1.4.10 | 125,172 B | click/submit 改写 + `window.open` 分驾驶方 |
| 1.4.11 | 127,800 B | 独立 `inject/guards.js` + 加载即注入 + 7 例单测 |
| 1.4.12 | 128,572 B / sha256 `EA5DDFE1E75E000BDE98F4C15E0475BBD9B98269A05A90A292E92D2F798012D5` | 工具栏 ‹ › ⟳；全量 178/178 |
