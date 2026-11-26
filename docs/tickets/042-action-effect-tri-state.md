# TICKET-042：写动作回执三态 `effect` + `action_unknown`

- 状态：✅ 已实现并真机通过（2026-11-26，1.5.4；阶段 A3，见 `docs/spec/004-capability-admission-spec.md` §4 B4、§6）
- 发现：2026-11-26（调研报告 P0-2 的落地项）
- 关联：`docs/spec/003-first-touch-approval-spec.md` C5（fail-closed 三错误码）、`docs/tickets/021-cancellation.md`、`docs/tickets/034-screenshot-large-capture-hang.md`、`docs/spec/004-capability-admission-spec.md` §4 B4

## 现象 / 缺口

现在的写动作（`browser_click`/`browser_type`/`browser_press`/`browser_eval`/`browser_download`）结果只有「成功 / 抛错」两态，无法回答用户和 agent 最关心的一句话：

> **这次动作到底发出去了没有？**

典型场景：

1. `browser_click` 返回 `bridge_timeout` —— 命令可能已经到页面并点了，也可能根本没发。agent 若自动重试，就可能提交两次（真实风险：下单、发帖、转账）。
2. 审批拒绝/超时 —— 明确没发，属于 `none`，可以安全重试。
3. 页面执行了动作但回执在返回路上丢了（面板崩溃/窗口隐藏）—— 属于 `unknown`，只能重新读页面核对。
4. `browser_eval` 执行了一半被取消 —— 部分副作用可能已发生，不能假装「没执行」。

browserpaw 的 `exit 4`（结果未知）+ `requestDispatched`、BrowserSkill 的 `effect_state`（none/committed/unknown）+ intent WAL、browser-cdp 的 `actionSent` 都在解同一个问题；我们目前只有错误码，没有三态语义。

## 目标

1. 所有写动作的结构化结果带 `effect: 'none' | 'committed' | 'unknown'`。
2. 未知态用新错误码 `action_unknown`（`retryable:false`）表达，hint 明确「先 `browser_snapshot` 核对，不要重发同一动作」。
3. 读动作不受影响（不需要 effect）。
4. 既有 16 码语义不动；`bridge_timeout` 在「命令未发出」时仍保留（例如审批前就超时）。

## 判定矩阵（实现依据）

| 阶段 | 失败点 | effect | 返回 |
|---|---|---|---|
| 参数校验 | 参数不合法、密码框硬拒、mode off 无关 | `none` | 既有错误码（如 `that field is a password field…`） |
| 审批 | 拒绝 / 超时 / 不可见 | `none` | `approval_denied` / `approval_timeout` / `approval_required` |
| 策略守卫 | `policy.guard` 否决 | `none` | `scheme_rejected` / `session_not_allowed` |
| 相位门 | `needs_human` / `taken_over` 拦住 | `none` | `needs_human` / `panel_taken_over` |
| 入队前 | 桥关闭/未授权 | `none` | `bridge_closed` / `unauthorized` |
| **已下发、等回执** | 面板超时/断线/取消 | **`unknown`** | **`action_unknown`**（新码，附原错误与 `delivered:true`） |
| 页面回执 | `ok:false` | `none` 或 `unknown`（按 `delivered` 与页面语义区分：点击未命中 = `none`，type 中途失败 = `unknown`） | 按动作类型 |
| 页面回执 | `ok:true` | `committed` | 成功结果 + `effect:'committed'` |

**不可逆动作的额外规则**：`submit`/`download`/`eval` 只要进入「已下发」阶段，无论后续结果如何都要标 `unknown`（除非已拿到 `ok:true`），并且**不自动重试**。

## 实现草案

1. **bridge.js**：`request()` 在超时/断线分支里判断命令是否已被 `#drain()` 拉走（`#pulled` 计数或 command 上的 `deliveredAt`）：
   - 未拉走 → 保持 `bridge_timeout`；
   - 已拉走 → 抛 `action_unknown`（details 带 `delivered:true`、原错误、动作类型）。
2. **tools.js**：写工具的结果统一经 `writeOutcome()` 包装，附加 `effect`；`action_unknown` 的 hint 与错误文案集中定义。
3. **errors.js**：新增 `action_unknown`（`retryable:false`，hint「结果不确定：先 snapshot 核对页面状态，不要重发同一动作」）；16→17 码。
4. **文案**：用户 README 故障排查表加一行；SPEC-003 的码表表述补一句（check-docs 不校验码表数量，但文档要同步）。
5. **不改**：读动作、审批错误码语义、`bridge_timeout` 的既有含义（未发出）。

## 实现（2026-11-26，1.5.4）

1. **`plugin/errors.js`**：`ERROR_CODES` 新增第 17 码 `action_unknown`（`retryable:false`，hint「the action may already have reached the page but its result was lost. Take a browser_snapshot and check the page state before deciding; do NOT resend the same action.」）。
2. **`plugin/bridge.js`**：新增 `WRITE_TYPES = new Set(['click','type','press','eval'])`（`open`/`snapshot`/`scroll` 故意不在内：导航失败可重观测）；`request()` 的 entry 记 `type` 与 `delivered:false`；`#drain()` 把每条被拉走的命令标 `delivered = true`；超时、`#cancel`、`#flushSession`（接管）、`close()`/`dispose()` 五条「已下发但回执丢失」路径统一走 `unknownOutcome(type, reason)` → `action_unknown`（details `{effect:'unknown', delivered:true, type, reason}`）；未下发仍保留 `bridge_timeout` / `cancelled` / `panel_taken_over` / `bridge_closed` 原语义。
3. **`plugin/tools.js`**：`committed(value)` 给成功结果加 `effect:'committed'`；`notSent(error)` 在写工具抛错时补 `details.effect:'none'`；`browser_eval` 页面侧 `ok:false`（脚本已到页面并抛错）改抛 `action_unknown`（details `effect:'unknown', delivered:true`）；`browser_download` 成功 `committed(...)`、`download_failed` 两路径显式 `effect:'none'`；`ACTION_OUTPUT` 与 press/eval/download 的 output schema 加 `effect` 枚举；`createTools()` 末尾统一包一层，写工具 catch 后 `notSent(err)`。
4. **测试**：`plugin/test/effect.test.mjs`（8 例：拉走后写超时→unknown、未拉走写→bridge_timeout、拉走后读→bridge_timeout、接管→unknown、四类写成功均 committed、参数失败→none 且 bridge 零调用、eval 页面抛错→unknown、下载拒绝→none）；`plugin/test/cancel.test.mjs` 改断言「已拉走后取消→action_unknown」；全量 251→**259 例**。
5. **文档**：根 `README.md`（17 码、effect 三态段、取消限制补 unknown）、`dist/.../README.md`（effect bullet + 故障排查 `action_unknown` 行）、SPEC-004 B4/码表、SPEC-003 码表备注。

**真机证据**（1.5.4，宿主 0.2.2-rc.5，见 `docs/cases/017-action-effect-cases.md`）：

- `browser_eval` 脚本在页面里抛错 → `action_unknown: the script reached the page and threw: …`；
- 12 秒 eval 执行中用户点「我来接管」→ `action_unknown: the eval command was already pulled by the panel, so the page may have executed it; its result was lost (the user took the panel over while it was executing). …`，随后 `browser_snapshot` 确认页面状态未变。

**诚实说明**：

- 「已下发后页面回报 `ok:false`」目前统一按 `none` 处理（例外：`browser_eval` 的页面抛错显式 `unknown`）。原因是现有页面动作返回的 `ok:false` 都带明确失败点（元素不存在、被遮挡、密码框等），可以安全重试；`type` 的「中途失败」边界尚未细拆，等 SPEC-004 准入下一个能力时再评估。
- 真机上没有制造出「面板 30 秒不回执」的纯超时路径：`Guest.eval` 自身 15 秒上限会先返回，所以真机用的证据是「接管中断」与「脚本抛错」；纯超时分支由 `effect.test.mjs` 的 fake poll 流覆盖。

## 测试

- 单测：bridge「已拉走再超时 → `action_unknown`」与「未拉走 → `bridge_timeout`」两分支（用现有 fake poll 流）。
- 单测：`effect` 判定矩阵（`plugin/test/effect.test.mjs` 或并入 gate 测试）。
- 单测：不可逆动作 `unknown` 不重试（模拟 agent 侧：错误 `retryable:false`）。
- 真机：`browser_eval` 在页面上执行 `fetch` 后让面板超时（可通过临时杀掉客户端/隐藏窗口制造）→ 回执应为 `action_unknown` 而不是 `bridge_timeout`。
- 回归：既有 251 例全绿；新增 ≥8 例。

## 验收

- [x] 写工具成功结果带 `effect:'committed'`；审批拒绝/参数失败带 `effect:'none'`。
- [x] 「已下发后超时」返回 `action_unknown`（`retryable:false`），且 bridge 测试覆盖两个分支。
- [x] 错误码 16→17，check-docs 全绿，文档三处同步。
- [x] 真机 case 至少一条（`docs/cases/017-action-effect-cases.md`）。
- [x] 既有 251 例不回归，新增 ≥8 例（259 例全绿）。

## 风险

- R1：agent 可能把 `unknown` 当失败重试 → hint 与工具描述必须写死「不要重发」；必要时在工具描述里加「先 snapshot 核对」。
- R2：`bridge_timeout` 的既有测试断言文案例 → 需要逐个核对受影响的测试，若断言依赖「超时即 bridge_timeout」，改成按 delivered 分支。
- R3：`delivered` 判定不准（pull 后命令在面板侧排队但还没执行）→ 保守起见把「已拉走」一律当 `unknown`，宁可多一次核对，不误报 committed。
