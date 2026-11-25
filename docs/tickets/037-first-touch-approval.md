# TICKET-037 写动作判定与 approval 门（host 侧）

- 状态：✅ 已实现并真机验收（2026-11-24 实现；1.5.1 修好 apply.js 薄门未转发 approve/hasClient/pageOf；1.5.2 修好读命令抢相位与 approve 未先看人工相位；2026-11-25 真面板 F2/F3/F6/F9/F10/F12 全部通过，单测 245/245）
- 发现：2026-11-24（SPEC-003 C1–C6/C8/C10；决策 010）
- 关联：`docs/spec/003-first-touch-approval-spec.md`、`docs/decisions/010-first-touch-approval.md`、`docs/tickets/038-approval-confirm-bar.md`（UI）、`docs/tickets/039-approval-config-and-cases.md`（配置/文档/夹具）

## 1. 缺口

现在 agent 拿到会话后，写动作没有任何「第一次先问一句」的闸门：

| 工具 | 现状 | 缺口 |
|---|---|---|
| `browser_type` | 密码框硬拒（`plugin/inject/actions.js:659-660`） | 其余字段直接键入，可能是账号/地址/隐私 |
| `browser_click` | 只回 `navigated`，不区分普通链接与提交按钮（`plugin/tools.js` 的 click 回执，674/692/731） | 提交类点击直接发出，页面可能下订单/发消息 |
| `browser_press` | 直接发键 | 表单内 Enter 可触发提交 |
| `browser_download` | 扩展名/大小策略（`plugin/policy.js:144-157`） | 不确认来源与文件 |
| `browser_eval` | 可整体关闭（`plugin/policy.js:130-136`） | 开着时可在页面内任意读写 |

用户只能事后从回执和面板看见。目标不是「更安全」，是**把「敢让它碰登录态」变成一条可验证的产品规则**（SPEC-003 §1）。

## 2. 目标（契约，详见 SPEC-003）

- C1：默认 `first-touch`；读动作零确认。
- C2：写动作四类 `type`/`submit`/`download`/`eval`；密码箱维持硬拒。
- C3：站点级豁免与生命周期（每 `(sessionId, origin)` 一次、`sensitiveSites` 每次）。
- C4：批准即执行、只执行 0/1 次；grant 绑指纹；迟到 decision 忽略。
- C5：fail-closed——`approval_required`（不可见，立即）、`approval_timeout`（30s）、`approval_denied`（拒绝/接管/指纹不符）。
- C6：强制执行点在工具体内，面板只是入口。
- C8：`needs_human` 优先，不叠确认。
- C10：确认事件结构化日志，不含输入值/页面内容。

本工单只做 host 半点；面板确认条在 TICKET-038，配置与文档在 TICKET-039。

## 3. 实现草案（落点）

### 3.1 页面侧标记（只做「标记」，不做判断）

复用 `plugin/inject/guards.js` 现有捕获点：

- `submit` 捕获（`plugin/inject/guards.js:82-84`）与 `HTMLFormElement.prototype.submit` patch（`:91-99`）→ 设置 `window.__dshSensitive = { kind: 'submit', form, target }`；
- click 捕获 → 用 `closest('button[type=submit], input[type=submit], input[type=image]')` 或「位于 form 内且无显式 type 的 button」判定提交目标；
- press Enter 且焦点在 `input`/`textarea`/`contenteditable` 且属于某个 form → 同样的标记；
- 只提供「目标 + 表单归属」这类事实，**分类与是否弹确认由 host 决定**（页面标记可伪造，见 SPEC-003 §8.2）。

### 3.2 host 侧纯逻辑

新增 `plugin/approvals.js`：

- `classify(action)`：读/写分类 + `actionClass`（C2 表）；
- `fingerprint({ origin, actionClass, target })`：origin + class + target 归一化（ref 或 selector 字符串），不含输入值；
- `shouldConfirm({ mode, origin, actionClass, grants, sensitiveSites })`；
- `parseDecision(msg)`：校验 id、decision 枚举、fingerprint 匹配；
- `recordEvent(event)`：结构化日志（C10）。

### 3.3 桥协议（`plugin/bridge.js`）

- 复用现有长轮询：轮询响应里携带 `{ kind: 'confirm', id, origin, actionClass, summary, timeoutMs, issuedAt }`；
- 新增 `POST /decision`：`{ id, decision: 'once'|'site'|'deny'|'unavailable', clientVisible }`；
- `approve(id, timeoutMs)` 返回 Promise：超时 resolve `approval_timeout`，无轮询者/不可见 resolve `approval_required`，接管 resolve `approval_denied`；
- 同一 session 同一时刻最多一个 pending 确认（SPEC-003 §6.2）；迟到的 decision 丢弃；
- 鉴权沿用现有令牌 + Host 校验，不放松（SPEC-002 B4）。

### 3.4 工具接线（`plugin/tools.js`）

- 变更类工具在**动作代码之前** `await requireApproval(...)`：拿不到 grant 直接抛错误码，动作代码不进入；
- `browser_type` 密码框保持现有硬拒（在审批之前）；`evalEnabled=false` 时 eval 先抛 `eval_disabled`（优先级已定，SPEC-003 §5）；
- 策略守卫（`ctx.tools.guard`）位置不动，仍先于审批；
- 批准后 grant 在本次调用内一次性使用，执行完即丢。

### 3.5 错误码（`plugin/errors.js`）

新增三码，各带 `retryable` 与 hint：`approval_required`（true）、`approval_timeout`（true）、`approval_denied`（false）。message 保持 `<code>: <text>` 形状（SPEC-002 B5）。

## 4. 验收

1. `mode: 'first-touch'`：新会话读动作（open/snapshot/scroll/hover/zoom/screenshot）→ 0 次确认；首次 `type` → 产生 pending 确认，允许后键入恰好 1 次；
2. 提交类点击 / 表单内 Enter → `submit` 类确认；允许后 submit 事件恰好 1 次；
3. 拒绝 → `approval_denied`，页面 DOM 未变，动作未发出；
4. 30s 无 decision → `approval_timeout`，页面未变，可重试；
5. 无轮询者（面板未开/不可见）→ `approval_required` 在 1s 内返回，不悬挂；
6. 指纹不符（伪造 decision 或换动作）→ `approval_denied`；
7. 同站第二次写动作不再问；换 origin 重新问；`sensitiveSites` 命中站点每次问；
8. `mode: 'off'` 与 1.4.x 行为逐字一致（196 例旧测试全绿）；
9. 单测覆盖：classify 表 / fingerprint / 超时 / 拒绝 / 不可见 / 迟到 decision / 接管竞态；
10. `node --test plugin/test/*.test.mjs` 全绿；`node tools/check-docs.mjs` 全绿。

## 5. 风险

- **窗口后台不绘制**（PROGRESS §10）：不可见判定要快，不能把确认条当成必然可见（C5、U1）。
- **分类漏判**：非表单按钮的 JS 副作用点击按读处理（SPEC-003 §8.3），需在文档里写明，不能假装覆盖。
- **grant 指纹**：必须绑 origin + class + target，否则批准一次可被复用（单测必覆盖）。
- **与待确认期间的其他命令**：pending 时新写动作直接回 `approval_required` 而非排队，避免队列死锁（SPEC-003 §6.2）。
- **与 TICKET-033 的相位交互**：`needs_human` 必须先判，否则会出现「验证墙 + 确认条」双拦截（C8）。

## 6. 不做

- 不做面板确认条与倒计时（TICKET-038）；
- 不做 `approvals` 配置字段与 README/案例同步（TICKET-039）；
- 不内置敏感站名单（`sensitiveSites` 由用户配置）；
- 不与 `ctx.tools.guard` 合并；
- 不覆盖 upload（等 upload 工具出现再复用 `actionClass`）；
- 不做面板点选指路（报告 §6 P1 的另一项，单独开票）。
