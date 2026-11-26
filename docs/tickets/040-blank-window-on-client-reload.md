# TICKET-040：客户端重载后整树白屏（DSH 桌面端）

- 状态：🟡 已收口（不可复现；已文档化规避流程，2026-11-26）P0（阶段 A1，见 `docs/spec/004-capability-admission-spec.md` §6）
- 发现：2026-11-25 两次实时发生；2026-11-26 立项
- 关联：`docs/spec/004-capability-admission-spec.md` §6 A1、`docs/cases/015-first-touch-cases.md` §4、`PROGRESS.md` 下一步第 13 条

## 现象

DSH 桌面端在**插件客户端重载后的几十秒内**整树白屏，不可恢复，只能重启 DSH。

| 次数 | 时间 | 触发前动作 | 结果 |
|---|---|---|---|
| 1 | 2026-11-25 17:40–17:42 | `plugin_manager set_bundle enabled:false` 再 `true`（插件 bundle 开关） | 17:42:39 整个 DSH 重启，GUI URL 变化；当时误判为「宿主不热替换」 |
| 2 | 2026-11-25 22:31 | 改 `cordis.patch.yml` 的热重载后，`browser_type` 触发确认条弹出 | 用户手动重启，进程 StartTime 22:32:24–30；用户原话「你触发那个网站的时候，harness 又全白了，只能重启」 |

两次的共性：**都在客户端重载（bundle 开关 / 配置热重载）后约 1 分钟内**，且当时面板正处于交互中（确认条即将/正在弹出）。

## 已排除

- **不是系统级崩溃**：Windows Application 事件日志近 40 分钟无 Application Error；`AppData\Roaming\@deepseek-ai\dsh-desktop\logs` 无新 `crash-*.log`；无 Crashpad 目录。
- **不是浏览器页面内容**：白屏时 DSH 的 Electron 渲染进程仍在（重启前可通过重启恢复；页面是本地夹具）。
- **不是 `client.js` 的 React 树结构问题**（代码审阅）：`useEffect` 全部在顶层无条件调用，渲染子节点全为字符串，正常路径不会让整树崩。
- **不是插件 `apply` 抛错**：重载后 `browser_snapshot` 能返回 `about:blank`，插件继续可用。

## 待验证假设（按嫌疑排序）

1. **H1 渲染进程在重载期间状态卡死**：DSH 的 web 运行时在客户端 bundle 换掉后，侧栏 webview + React 树处于半重载状态；若此时有焦点/输入事件（确认条按钮、键盘捕获），可能触发渲染进程不可恢复的挂起。
2. **H2 与 panel 的 `keydown`/`visibilitychange` 监听有关**：TICKET-038 新增的 `keydown`（Enter/Alt+1/2/3）与 `visibilitychange` 监听如果在重载窗口期被重复注册或指向已销毁的 guest，可能抛未捕获异常（Electron 渲染进程里未捕获异常通常不白屏，但需验证）。
3. **H3 宿主 sidePanel/chrome 层白屏**：DSH 外壳本身在白屏（不是 webview 内容），可能由 `plugin_manager` 的 enable/disable 流程触发。
4. **H4 与确认条 DOM/样式无关**：已核对确认条只是 `div` + 三个 `button`，无 portal/无绝对定位覆盖全屏。

## 静态勘察（2026-11-26，`app.asar` 源码）

> 逐文件读 `dsh/node_modules/@deepseek-ai/*` 与 `lib/main.js`（宿主 0.2.2-rc.5）。结论先写后面。

- **客户端 bundle 是原地重载，不是整页刷新**：`dsh-client-hmr` 的 host 半每 `pollIntervalMs`（默认 500ms）对每个 client bundle 做 `statSync`（mtime/ctime/size），变化则 `ctx.clientModules.rebuilt(id)`，并通过 SSE `/plugins/events` 广播 `{type:'rebuilt', id, rev}`；页面 `dsh-client-hmr` 的 client 半收到后调 `ctx.modules.entries.reload(id, rev)`（`dsh-client-modules/src/client/entries.ts`），顺序为 `invalidateForReplacement → prefetch → tearDownEntryFiber → removeOwnedStyles → import → entry.refresh() → fiber.await()`。**asar 内 `location.reload` 0 命中** → 白屏不是外壳整页 reload 造成。
- **配置热重载只重启 host 半**：`CONFIG_FIELDS` 里只有 `activation/fitWidth/evalEnabled/claimBrowserUse/routing` 是 volatile；`bridge/limits/downloads/sessions/searchFallback/static/approvals/dialogs` 都是 restart（host fiber 重建、bridge 换端口、面板重连），不触发 client bundle 重载。→ 22:31 事故更可能是「host 重建 + 面板重连/审批交互」，而不是 client entry 重载。
- **React 侧单点崩溃不会白屏**：`dsh-client-ui-renderer/src/client/scoped-slots.tsx` 里每个 slot entry 有 `SlotErrorBoundary`（fallback 为 `<Anchor data-slot-error>`），keyed slot 无 entry 时渲染 `fallback ?? null`。我们的 panel body / tab title 崩只会得到空 anchor。
- **侧栏宿主子系统确有「静默挂起」的先例**：`dsh-client-ui-sidebar-right/src/client/index.ts` 顶部注释明确警告——registry 必须在 `apply` 顶层构建，**不能放进 effect**，否则「browser boot 会无声卡死（no error at all）」。我们的插件只调 `ctx.sidebarRightTabs.register`，不建 registry，但这条注释说明该子系统能出现无错误挂起。
- **桌面主进程里的 webview 生命周期**：`lib/main.js` 的 `DesktopBrowserGuests` 用 `will-attach-webview` 校验 `about:blank#<lease>`，`did-attach-webview` 时把 guest 的键盘输入接到 `attachInput` 原生管线；`release()` 会 `guest.close()` 并等 `destroyed`；主窗口任何真实主框架导航、`render-process-gone`、窗口销毁都会 `releaseAll()`。→ webview 拆除/重建会同时牵动「WebContentsView + 原生输入管线」，这是目前最可疑的挂起来源，但**没有直接证据**。
- **渲染进程异常会显示错误页而不是白屏**：主窗口 `did-fail-load`/`preload-error`/`render-process-gone` 都走 `reportFatal`。静默白屏不像渲染进程崩溃。
- **可回读的证据不存在**：host stdout 只透传 app stdout（不落盘），桌面只在崩溃时写 `crash-*-host.log`，`plugin-operations/operations.jsonl` 只记 bundle install/remove、不记配置编辑。→ 想定位必须主动取日志或加持久化 trace。

## 定位计划

1. **E1「纯客户端重载」**：面板打开并加载 `demo/approval-form.html` → 只改安装目录 `C:\Users\林焕文\.dsh\profiles\desktop\node_modules\dsh-plugin-agent-browser\client.js` 的 mtime（内容不变）→ HMR 发现变化并 `reload` 客户端 entry → 2–3s 后 `browser_snapshot`，同时看用户屏幕是否白。若白屏 → 「仅 client entry 重载」即可复现，指向 webview 拆除/重建。
2. **E2「纯 host 重载」**：备份 profile patch 后改非 volatile 的 `limits.snapshotMaxChars`（8000→8001 再改回）触发 host fiber 重建（client 不重载）→ 打开夹具页 → `browser_type`（触发确认条）→ 观察是否白屏。对应 22:31 事故的触发条件。
3. **E3「对照」**：重载后不做任何面板交互静置 5 分钟，看是否白屏（区分「交互触发」与「必然」）。
4. **取日志（可选，需用户配合重启 DSH）**：带 `--enable-logging --log-level=0` 或 `ELECTRON_ENABLE_LOGGING=1` 启动并抓 stdout；或在插件 host 半加持久化 trace（把 bridge `/log` 环形缓冲 append 到文件，默认关）。
5. **规避方案（无论根因都要做）**：真机验收流程改为「先重启 DSH → 一次注入配置 → 不再热重载」，并在 release notes 里写明「不要用 bundle 开关/热重载来做验收」。

## 实验记录（2026-11-26）

| # | 目的 | 操作 | 结果 |
|---|---|---|---|
| E1 | 只重载插件客户端 entry | 面板已打开夹具页；把安装目录 `…\node_modules\dsh-plugin-agent-browser\client.js` 的 mtime 改到当前（内容与 sha256 不变，157,544 B） | **未白屏**。HMR 发现变化并重载客户端 entry：面板重挂、webview 重建（新 lease `about:blank#15449853-…`、snapshot gen 归 1），随后 `browser_open` 正常、静态服务端口不变（14476）。用户确认屏幕正常。 |
| E2 | 只重建 host 半 + 确认条交互 | 备份 profile patch 到 `.bak-e2`；`limits.snapshotMaxChars` 8000→8001 触发插件 host 重建 | **未白屏**。host 确实重建（静态服务端口 14476 → 2984），面板自动重连；随后 `browser_type e2` 弹确认条、用户点「允许一次」成功输入（用户还在页面里手动输入并点了按钮）。 |
| E3 | 重载后静置 5 分钟不交互 | 面板在 11:27:37 因 E4 重挂为 `about:blank` 后不再触碰面板，只做文档编辑，≥5 分钟后检查 | **未白屏**（11:34 检查，面板/工具均正常） |
| E4 | bundle 启停（对应 17:40–17:42 事故路径） | `plugin_manager set_bundle enabled:false`（11:27:14）→ 3s 后 `enabled:true`（11:27:23） | **未白屏、DSH 未重启**：主进程仍是 10:25:15 启动的实例（只有两个 utility 进程 11:27:30/37 新起）；面板重挂为 `about:blank#19af405a…`、`browser_snapshot` 正常，用户确认屏幕正常。 |

E1/E2 说明：**单纯「客户端 entry 重载」或「host 半重建 + 审批交互」都不足以复现白屏**。E4 用的正是 17:40 事故的真实操作（journal 里 `reason:"bundle"` 的 enable 操作，settled 17:40:28 与 17:41:42），本次也没有白屏、没有重启。→ 四组实验全部阴性。

## 结论（2026-11-26）

- **无法稳定复现**：E1（客户端 entry 重载）、E2（host 半重建 + 确认条交互）、E4（bundle 启停，与 17:40 事故同路径）、E3（重载后静置 5 分钟）均未白屏，DSH 进程也没有重启。
- 静态勘察的机制解释：重载是「原地拆除/重建 entry + webview」，React slot 有 `SlotErrorBoundary`，渲染进程异常会显示错误页。白屏更像**重载窗口期内的瞬态竞态**（webview 的 WebContentsView + 主进程原生输入管线/合成器）；两次历史事故都落在「重载后约 1 分钟内 + 面板正在交互」这个窗口里，但未能在本次实验中撞到。
- 证据限制：历史事故无可回读日志（host stdout 不落盘、无 crash 文件、plugin journal 只记 bundle 操作、不记配置编辑），因此根因只能停在假设层（H1/H2/H3）。

## 规避流程（已写进 release notes 与 PROGRESS）

1. 真机验收/演示前**先重启一次 DSH**，之后一次性配好插件配置；验收过程中**不要**改 `cordis.patch.yml`，也**不要**用 `plugin_manager` 启停 bundle。
2. 如果必须改配置：改完等面板重挂（会回到 `about:blank`）→ 重新 `browser_open` 目标页 → 再继续；不要停在「确认条刚弹出」的瞬间做其它操作。
3. 万一白屏：直接重启 DSH，会话与插件配置都会恢复（已多次实测）。
4. TICKET-043（F7/F8 验收）改为「改配置 → 重启 DSH → 一次性验完」，不依赖热重载。

## 验收

- [x] 能给出白屏的稳定复现步骤（或 4 组对照实验全部否定「可复现」并说明限制）。→ 4 组实验全部阴性，限制见「结论」。
- [ ] 若可复现：有根因定位（代码行/宿主行为）与修法；修法后连续 3 次重载+交互不白屏。→ N/A（未能复现）
- [x] 若不可复现：把「白屏规避流程」写进宣传/验收文档，并在 `PROGRESS.md` 下一步里记录。
- [x] 真机验收流程（TICKET-043）不再依赖热重载。

## 注意

- 不要再拿**生产 profile 的 `cordis.patch.yml`** 做热重载实验；用临时 profile 或改回后立刻重启。
- 做实验前先备份 `C:/Users/林焕文/.dsh/profiles/desktop/cordis.patch.yml`（2026-11-25 已有 `.bak-f78` 先例）。
- 若需拿渲染进程崩溃信息，不要开 `--remote-debugging-port`（会与宿主安全策略冲突）；优先 stdout 日志。
