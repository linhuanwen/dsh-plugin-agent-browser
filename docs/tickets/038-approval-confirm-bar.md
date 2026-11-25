# TICKET-038 面板确认条与可见性快速失败（client 侧）

- 状态：✅ 已实现并真机验收（2026-11-24 实现，`CLIENT_REV` 48；2026-11-25 真面板目视通过：确认条三按钮/倒计时/Enter=拒绝、可见性 <1s 快速失败、接管即作废；记录见 `docs/cases/015` §4）
- 发现：2026-11-24（SPEC-003 C5/C7；决策 010 §7）
- 关联：`docs/spec/003-first-touch-approval-spec.md`、`docs/tickets/037-first-touch-approval.md`（host 半）、`docs/tickets/032-takeover-navigation.md`（相位机与接管）、`docs/cases/015-first-touch-cases.md`（TICKET-039 落地）

## 1. 缺口

面板当前只有**只读**呈现：四态徽章 + 三张工具卡片（截图/下载/普通结果），没有任何可交互的确认控件。TICKET-037 会把 pending 确认通过长轮询下发到 client，但 client 侧没有：

1. 渲染确认条的位置与样式；
2. 三个决策按钮与倒计时；
3. 把 decision 回传 `/decision` 的通道（沿用现有桥，但这是新路径）；
4. 窗口不可见时的快速失败信号（`clientVisible`）；
5. pending 期间被用户接管的自动拒绝。

另外 SPEC-003 §8 的已知限制决定了：DSH 窗口在后台时 guest 不绘制（PROGRESS §10），确认条可能根本看不见——所以「快速失败」比「等 30 秒」更重要。

## 2. 目标（契约，详见 SPEC-003）

- C7：面板顶部 28–32px 确认条，不遮页面；文案只给「站点 + 要做什么」，不回显输入值；三按钮 `允许一次 / 本会话允许本站 / 拒绝` + 30s 倒计时；窄面板折行但三按钮同时可见；`Enter` 默认聚焦拒绝。
- C5：`document.visibilityState !== 'visible'` 时**立即**回 `{ decision: 'unavailable', clientVisible: false }`，让 host 在 1s 内返回 `approval_required`（不空等 30s）。
- C4：decision 只能回一次；面板重挂/超时后不再回；迟到的 decision 由 host 丢弃（client 侧也要防重复提交）。
- 相位机不变：pending 期间 phase 仍是 `agent`，徽章不新增状态（可加小圆点）；用户点接管 → pending 自动 `deny`，agent 收到 `approval_denied`。
- `CLIENT_REV` bump，保证重装后旧面板不残留。

## 3. 实现草案（落点 `plugin/client.js`）

### 3.1 确认条

- 在面板顶部插入一个固定高度的 `div.dsh-approval-bar`（不覆盖 webview，参与 flex 布局）；
- 文案：`{host} 想让 agent {动作描述}`；动作描述由 host 下发（`summary`），client 不再拼页面语义；
- 倒计时：`timeoutMs` 进度条 + 数字；到 0 时自动发 `timeout` 并隐藏；
- 三个按钮回调统一 `postDecision(id, decision)`。

### 3.2 与轮询的集成

- 轮询响应里出现 `kind: 'confirm'` 帧时：入队（同一时刻最多一个，见 SPEC-003 §6.2）、渲染确认条、启动倒计时；
- 已有 pending 时收到新的 confirm 帧：回 `unavailable` 并忽略（防御，正常不会发生）；
- 面板重挂/卸载：清空本地 pending，不阻塞轮询。

### 3.3 可见性与快速失败

- 每次渲染确认条前检查 `document.visibilityState`；不可见则立即 `postDecision(..., 'unavailable', false)` 并**不渲染**；
- 页面从可见变隐藏（`visibilitychange`）且仍有 pending：立即按不可见处理（同一次 decision）；
- 探针（U1）：后台窗口调用写动作，测量从发起到 `approval_required` 的耗时，目标 < 1s；结论回填 SPEC-003 §11。

### 3.4 接管竞态

- 用户点「接管」（现有相位切换路径）时：若本地有 pending，先 `postDecision('deny')` 再切 phase；若 POST 失败，仍切 phase（host 侧有 300ms 无轮询判 `approval_required` 兜底）；
- 用户点「停止/取消」导致工具调用结束时，pending 由 host 侧超时/取消收尾，client 侧隐藏确认条。

### 3.5 样式与无障碍

- 视觉与四态徽章同一语言；按钮 focus ring 可见；
- `Enter` 默认聚焦「拒绝」（安全默认），`Alt+1/2/3` 选择三按钮；
- 窄面板（< 420px）两行布局，三按钮必须同时可见；
- 禁用态：POST 在途时按钮置灰，防重复提交。

## 4. 验收

1. 真实装机：写动作触发确认条，三按钮可见、可点，点击后页面动作发生/不发生符合预期；
2. 倒计时 30s 到 0 → 自动 `timeout`，确认条消失，agent 收到 `approval_timeout`；
3. 面板不可见（切到别的窗口/最小化）→ 写动作在 1s 内返回 `approval_required`，不出现「空等 30s」；
4. 用户点接管 → pending 变拒绝，agent 收到 `approval_denied`；接管后 agent 不能再写；
5. 窄面板（400px）确认条不破版，三按钮同时可见；
6. `Enter` 默认拒绝；`Alt+1` 允许一次；重复点击不会重复 POST；
7. 读动作期间确认条不出现；同一时刻不会出现两条确认条；
8. 面板重挂后不残留 pending；`CLIENT_REV` 变化后旧面板不会静默调用 `/decision`；
9. 与 TICKET-033 配合：验证墙命中时只出 `needs_human` 提示，不叠确认条；
10. 视觉证据：截图存入 `screenshots/` 并在 TICKET-039 的 cases/015 引用。

## 5. 风险

- **窗口后台不绘制**：确认条可能不可见 → 依赖 C5 的快速失败；若 U1 探针发现 `visibilityState` 不可靠，退化为「host 侧 300ms 无轮询即失败」，并记入已知限制。
- **焦点被 webview 抢**：确认条出现时页面可能正在加载，需要确认条在 DOM 层级上位于 webview 之上且可用键盘到达；必要时用 `tabindex`/`focus()` 强制。
- **与接管/停止的竞态**：decision 与相位切换都可能发生，允许「decision 丢失」，host 侧必须能兜底（TICKET-037 已定：300ms 无轮询判不可见）。
- **重复 decision**：按钮禁用 + id 单次校验，双保险。
- **窄面板排版**：不追求好看，只保证三按钮同时可见（禁止出现只看到「允许」的布局）。

## 6. 不做

- 不改四态徽章语义；
- 不做「agent 动作时间线」（v2.0）；
- 不做页面内浮层（确认条在面板 chrome 里，不在 webview 内）；
- 不做多 pending 排队（同一时刻只允许一个）；
- 不改 host 侧判定与协议（TICKET-037 的契约）。
