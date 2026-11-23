# TICKET-028 截图取帧依赖面板可见，失败信息不可读

- **状态**：✅ 已完成（1.3.4 装机）
- **优先级**：P2（验收期体验问题：截图是 023 卡片的主角，失败时直接暴露 Electron IPC 文案，会让人以为插件坏了）
- **来源**：TICKET-023 装机验收（截图卡片验收时连续踩到）
- **对应验收**：`docs/spec/002-official-alignment-spec.md` B8 验收"无图也不崩"
- **关联**：TICKET-015（全页截图与拼接）、TICKET-023（截图卡片）

## 1. 问题

TICKET-023 装机验收时，`browser_screenshot` 连续出现三种失败，且都不可自我解释：

| # | 现象 | 现场证据 |
|---|---|---|
| 1 | `Error: screenshot failed at command: capturePage did not return within 6000ms` | 2026-11-21 22:46 连续两次；同一页面 `browser_snapshot(includeImage: true)` 却能截出 83.8 KB 图 |
| 2 | `Error: screenshot failed at command: Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: UnknownVizError` | 重装 1.3.1 后导航到 example.com 立刻截图 |
| 3 | `capturePage timed out within 1200ms` ×3 后失败 | 面板页签不显示时 |

同一时刻用 `browser_eval` 读到 `{"vis":"hidden","hidden":true,"w":575,"h":863}`（窗口被遮挡/页签不显示），说明：

- 面板**可见**但**还没画完**时，`capturePage` 会拒绝 `UnknownVizError`，旧的 3 次重试（0/250/400 ms、每次 1 200 ms 超时）不足以覆盖首次绘制延迟；
- 面板**不可见**时页面不产帧，`capturePage` 一直挂起，旧代码于是把 6 s 花光再抛 `did not return`；
- 两条路径都把 Electron 内部措辞原样透给模型和用户。

## 2. 修法（`plugin/client.js`，`CLIENT_REV` 31 → 35）

| 层 | 改动 | 理由 |
|---|---|---|
| 可见性判别 | `metrics` 的 evaluate 增加 `vis: document.visibilityState`；`vis === 'hidden'` 立即抛 `the browser panel is hidden right now (its pane or the app window is not visible), so the page is not being rendered and cannot be captured. Bring the panel into view and retry.` | 与已有的 `0×0 折叠` 分支（`has no size on screen`）区分开：两种情况修法不同 |
| 首次绘制重试 | `capturePainted` 的延迟表 `[0, 250, 400]` → `[0, 300, 700, 1 500]`，每次 `capturePage` 仍是 1 200 ms 超时 | 覆盖 `loadURL` 解析后 1–3 s 才出第一帧的窗口 |
| 统一措辞 | 重试耗尽不再透出 `UnknownVizError`，统一抛 `the browser panel produced no picture: the page had not painted yet, or the panel is not visible on screen. Bring the DSH window and the browser panel into view, then retry the screenshot.` | 模型与用户都能据此采取动作；原始原因保留在 `/logs` 的 `capture retry` 行 |
| 外层预算 | `capture()` 的 `withTimeout(..., 6 000, 'capturePage did not return')` → `10 000`，并在 catch 里把超时改写成同一句话 | 内层 4 次重试最坏约 7.3 s，旧的 6 s 外框会先触发并给出不可读文案 |

## 3. 单测

客户端半边运行在 Electron `<webview>` 里，`capturePage` 无法在 node 侧驱动，本票**不新增单测**（沿用 TICKET-023 的 `plugin/test/toolviews.test.mjs` 保证 `plugin/client.js` 仍可被 vm 加载、注册流程不变）。回归口径为：

- 全量 `node --test`：**136 / 136 通过**；
- 装机后第一次截图（导航后立即调用）必须成功或给出可读文案。

## 4. 装机验收

| 项 | 做法 | 实测 |
|---|---|---|
| 导航后立即截图 | 装 1.3.4 → `browser_open https://example.com/` → 立刻 `browser_screenshot({mode:'viewport'})` | ✅ 成功：`screenshots/paint-race-check.png`（83.5 KB，与 1.3.0 验收时同一页面同尺寸） |
| hidden 判别 | 面板页签不显示/窗口被遮挡时截图 | ⚠️ 条件在 1.3.0 验收时被观测到（`vis: hidden` + `capturePage timed out`），1.3.1+ 已部署判别分支；本轮装机后窗口回到前台，未能再复现 hidden 状态，故该分支只验证了"代码在装机包内"（`plugin/client.js:1425`），未做二次现场触发 |
| 失败文案 | 断网/窗口遮挡等失败路径 | 文案已统一为 "produced no picture … Bring the DSH window and the browser panel into view"；原始原因保留在 `/logs` 的 `capture retry` |
| 不回归 | `browser_snapshot({includeImage:true})`、`browser_open`、`browser_download` | ✅ 均正常 |

## 5. 风险与残留

| # | 项 | 处理 |
|---|---|---|
| R1 | 窗口被遮挡时 `capturePage` 可能一直挂起，仍会花满 10 s 才报错 | 已给出可读文案；要根治需查 Electron `webContents` 遮挡状态，超出本票范围，记入 B8 残留 |
| R2 | 统一文案遮蔽了 `UnknownVizError` 等原始原因 | `/logs` 的 `capture retry` 每轮都记录了原始 `reason`，排查时可取 |
| R3 | 该路径无单测 | 依赖 023 的 vm 冒烟 + 装机验收；若将来把 `capturePage` 抽成可注入的适配层，可补单测 |
| R4 | 版本连跳（1.3.1 → 1.3.4 为同一问题迭代） | 均未对外发布，仅本机装机验收；发布说明里只需列 1.3.4 |

## 6. 变更记录

- 1.3.1（2026-11-21）：`document.visibilityState === 'hidden'` 判别与明确文案；`CLIENT_REV` 32。
- 1.3.2：`capturePainted` 重试预算 `[0,300,700,900]`；`CLIENT_REV` 33。
- 1.3.3：重试预算定为 `[0,300,700,1500]`、外层预算 10 s、统一失败文案；`CLIENT_REV` 34。
- 1.3.4：外层超时也改写成同一句可读文案（不再透出 `did not return within 10000ms`）；`CLIENT_REV` 35；装机验收通过。
