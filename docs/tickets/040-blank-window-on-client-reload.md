# TICKET-040：客户端重载后整树白屏（DSH 桌面端）

- 状态：📋 待办 P0（阶段 A1，见 `docs/spec/004-capability-admission-spec.md` §6）
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

## 定位计划

1. **取渲染进程日志**：重启 DSH 时带 `--enable-logging --log-level=0`（或设 `ELECTRON_ENABLE_LOGGING=1`），复现后看 `main.log`/renderer 控制台是否有未捕获异常。注意：需要用户配合重启，且不改动生产 profile。
2. **做最小复现**：只做「改配置热重载（改 `limits.snapshotMaxChars`）→ 等面板重挂 → 用 `browser_snapshot`/`browser_type`」，不引入审批条；若仍白屏 → 与确认条无关（H4 排除）。
3. **对照实验**：客户端重载后**不做任何面板交互**，等 5 分钟；若白屏 → 与交互无关（H1 弱化、H3 强化）。
4. **自查 DSH 侧栏实现**：用 `tools/asar.mjs` 读 `app.asar` 里 sidePanel/webview 重挂逻辑，确认 bundle 变化时宿主对 panel 做了什么（是否 `reload` 整个 webview/窗口）。
5. **规避方案（无论根因都要做）**：真机验收流程改为「先重启 DSH → 一次注入配置 → 不再热重载」，并在 release notes 里写明「不要用 bundle 开关/热重载来做验收」。

## 验收

- [ ] 能给出白屏的稳定复现步骤（或 4 组对照实验全部否定「可复现」并说明限制）。
- [ ] 若可复现：有根因定位（代码行/宿主行为）与修法；修法后连续 3 次重载+交互不白屏。
- [ ] 若不可复现：把「白屏规避流程」写进宣传/验收文档，并在 `PROGRESS.md` 下一步里记录。
- [ ] 真机验收流程（TICKET-043）不再依赖热重载。

## 注意

- 不要再拿**生产 profile 的 `cordis.patch.yml`** 做热重载实验；用临时 profile 或改回后立刻重启。
- 做实验前先备份 `C:/Users/林焕文/.dsh/profiles/desktop/cordis.patch.yml`（2026-11-25 已有 `.bak-f78` 先例）。
- 若需拿渲染进程崩溃信息，不要开 `--remote-debugging-port`（会与宿主安全策略冲突）；优先 stdout 日志。
