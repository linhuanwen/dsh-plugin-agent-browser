# TICKET-044：`browser_wait` —— 等待条件（阶段 B1 第一个能力）

- 状态：✅ 已完成（2026-11-27，1.5.5；真机通过）B1，见 `docs/spec/004-capability-admission-spec.md` §4 B1–B4、§6 阶段 B1
- 发现：2026-11-26（阶段 B 规划；B1 层第一个能力）
- 关联：`docs/spec/004-capability-admission-spec.md`（准入契约）、`docs/tickets/042-action-effect-tri-state.md`（写动作三态，本能力不涉及）、`docs/tickets/033-challenge-detection-gap.md`（读类命令的相位门先例）

## 准入四问（SPEC-004 B1）

| # | 问题 | 回答 |
|---|---|---|
| 1 | 读还是写？哪个 `actionClass`？ | **读**。它只问页面「条件成立了吗」，不派发任何输入事件、不点、不写。没有 `actionClass`，不进入审批（与 snapshot/scroll 同类）。 |
| 2 | 可逆吗？ | 不适用：不改变页面。可随时打断/重试，无副作用。 |
| 3 | 失败时能不能确定「没有发出」？ | 能。这是纯读：无论超时、取消、页面异常，页面状态都不由它改变；失败只会导致「不知道页面现在是什么样」，用 `browser_snapshot` 重读即可。不需要 fail-closed，也不会出现幽灵动作。 |
| 4 | `needs_human` / `taken_over` 相位下会不会绕过门？ | 不会。它是**读**，按 SPEC-004 B5 读命令仍应可用（人卡在验证墙上时，agent 等页面变化是合理的观测）；`bridge.js` 的 `READ_TYPES` 增加 `wait`，保证它不会把相位抢回 `agent`；`INPUT_TYPES` 不包含它，所以不会绕过人类优先。 |

**结论**：四问齐备，可进主干，且不需要新增错误码（超时是正常结果，返回 `matched:false`）。

## 缺口 / 为什么现在做

页面异步是常态：点了「加载」要等列表出现、提交表单后要等「保存成功」、弹层关闭后要等遮罩消失。现在 agent 只有三种笨办法：

1. `browser_eval` 轮询（写动作、要审批、每次一行脚本，最容易出「脚本跑在旧页面」的错）；
2. 连续 `browser_snapshot`（每次整棵 a11y 树 + 截图，token 浪费，且没有「等到」语义）；
3. 硬 `sleep`（不存在这个工具，只能靠模型自己乱猜）。

竞品都有：BrowserSkill 的 `bsk_session wait`、browserpaw 的 `wait`（waitForSelector/waitForText/waitForLoad……）、browser-cdp 的 `bcdp_wait`（waitForSelector/Text/URL/Function + state）。我们只做**最小且可验收**的一个：选择器/文本出现或消失。

## 目标

1. 新工具 `browser_wait`：`{ selector?, text?, gone?, timeoutMs? }`，恰好传 `selector`/`text` 之一。
2. 条件已成立时**立即返回**（不需要等到下一个 tick）；否则轮询到 `timeoutMs`（默认 10000，范围 100–15000）。
3. 结果：`{ matched, timedOut, found, gone, waitedMs, url? }`；超时是正常结果（`matched:false, timedOut:true`），不是错误。
4. 纯读：零审批；`needs_human` / `taken_over` 下仍可用；不抢相位。
5. 取消：host 取消后，面板在两次 probe 之间停下并丢弃结果（不像 `browser_eval` 那样只能等页面 promise）。

## 实现（2026-11-27，1.5.5）

- `plugin/inject/wait.js`（新）：`dshWait(input)` 单次同步判定，返回 `{matched, found, gone, selector, text}`；选择器非法按「没找到」处理（由工具层给文案），文本只在 `body.innerText/textContent` 里找；`invalid:true` 表示两个参数都空。
- `plugin/client.js`：`CLIENT_REV` 50→51；`Guest.wait(params, isCancelled)` 在面板侧轮询（150ms 间隔，budget 由 `timeoutMs` 决定），每次 probe 前检查取消回调；`runCommand` 增加 `wait` 分支；`DIALOG_TYPES` 加 `wait`（等页面期间弹出的 alert 也归到这次结果里）。
- `plugin/bridge.js`：`READ_TYPES` 加 `wait` —— 读命令不抢相位（`needs_human`/`taken_over` 下可用）。
- `plugin/tools.js`：`waitSource()` 读页面探针源码；`browserWaitTool(gate)` 做参数校验/夹取/转发；`createTools` 注册第 12 个工具；工具描述写明「纯读、无需确认、异步加载先等再快照」。
- 文档：两份 README 工具表改为 12 个并加 `browser_wait`；`tools/check-docs.mjs` 的期望数 11→12；`plugin/test/tooldefs.test.mjs` / `toolviews.test.mjs` 的固定 11 同步更新。
- 单测：`plugin/test/wait.test.mjs` 16 例（探针 9 + 面板同形调用 1 + 工具 6），`plugin/test/bridge.test.mjs` 新增 2 例（`wait` 在 `needs_human`/`taken_over` 下可用且不抢相位）。
- 全量：259 → **277 例**全绿；`node tools/check-docs.mjs` 六项全绿（工具 12 个）。

## 不做什么

- 不做 `waitForFunction`（任意函数=变成 eval 的替身，绕过读/写分类）；
- 不做 `waitForNetworkIdle`（需要 CDP/网络观测，属 B2/B3）；
- 不做 `waitForUrl`（导航已由 `open` 的 `did-stop-loading` 兜住；跨页 URL 等待放 B3 再议）；
- 不做页面内长 promise 轮询（取消不了，见适配器 `guest.eval` 的 15s 上限教训）。

## 验收

- [x] `node --test plugin/test/*.test.mjs` → 277/277；
- [x] `node tools/check-docs.mjs` 六项全绿（工具 12）；
- [x] 参数校验：恰好一个 selector/text；`gone` 必须布尔；`timeoutMs` 整数并夹到 100–15000；
- [x] 纯读：不触发审批；在 `needs_human`/`taken_over` 相位可用且不抢相位；
- [x] 真机：在 `demo/wait.html` 上验证「立即命中 / 等出现 / 等消失 / 超时」四条并写进 `docs/cases/018`（2026-11-27，1.5.5；另验证 text 等待与隐藏骨架不误判）。

## 语义补充（实现期）

selector 的「出现」按**可见**判定（`getClientRects().length > 0` 且 `display`/`visibility` 未隐藏），不是 DOM 存在性：SPA 常见「从首帧就在 DOM 里的隐藏骨架」，只查存在会在数据到达前就报成功。隐藏元素算「已消失」（`gone:true` 命中）。text 用 `body.innerText`（渲染文本），因此 `display:none` 里的文字不会匹配。
