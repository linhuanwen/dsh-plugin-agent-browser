# 决策 010：共用浏览器的默认信任姿势——站点级首次写动作确认

> 状态：`已实现`（1.5.2，2026-11-25 真机验收通过：F1–F6、F9–F12；F7/F8 配置级契约覆盖）；可验收契约见 `docs/spec/003-first-touch-approval-spec.md`，实现拆分见 `docs/tickets/037-first-touch-approval.md`（host 判定与门）、`docs/tickets/038-approval-confirm-bar.md`（面板确认条）、`docs/tickets/039-approval-config-and-cases.md`（配置/文档/夹具）。
> 日期：2026-11-24 归档。
> 关联：`docs/spec/003-first-touch-approval-spec.md`、`docs/research/2026-11-24-browser-automation-competitive-report.md` §5–§6、`docs/tickets/033-challenge-detection-gap.md`、`docs/decisions/002-human-input-during-agent.md`（D12）。

## 背景

产品定位是「用户和 agent 共用一块真浏览器」：浏览器就是 DSH 侧栏里那个 webview，登录态天然是用户的，agent 通过工具操作，用户随时能接管。这条路的护城河是**可见、可接管、登录态零搬运**；但「敢让它碰你的登录态」不能只靠事后看，需要一个默认的信任姿势。

现状是：agent 拿到会话后，除密码键入被硬拒、`evalEnabled` 可关、下载有扩展名/大小限制、会话有 allowlist 外，对任何站点的 `type` / 表单提交 / `download` / `eval` 都没有确认——用户只会在回执和面板里**事后**看见。

竞品里「人机接力」是标配（BrowserSkill 的 `request_help`、browserpaw 的 `ask-human`、dsh-browser-cdp 的 `wait_for_human`、browser-mcp 的登录三态 fail-closed），但没有一家把「站点第一次被 agent 动手前问一句」做成产品默认：它们要么全自动，要么靠用户自己盯。

## 一个必须先承认的事实

**「登录后页面」检测不出来。** webview 里读不到 HttpOnly Cookie，宿主也没有把 cookie store 暴露给插件（`app.asar` 的 `lib/main.js:18233-18244` 只给了权限/下载策略，没有 cookie 接缝）。所以不能用「检测到已登录 → 才确认」这条规则，它依赖一个不存在的信号。

替代规则：**凡是写动作，站点首次就确认。** 登录后页面同样是写动作，被这条规则覆盖；读动作完全无感。

## 决策

1. 默认 `approvals.mode = 'first-touch'`。
2. **读动作不确认**：`browser_open`、`browser_snapshot`、`browser_scroll`、`browser_hover`、`browser_zoom`、`browser_screenshot`，以及点击普通链接导致的导航。
3. **写动作确认**：`browser_type`（密码框仍硬拒且不进确认）、提交类点击（`button[type=submit]`、`input[type=submit|image]`、表单内按钮）、表单输入框内的 Enter、`browser_download`、`browser_eval`（未来 upload 沿用同一类）。
4. **粒度**：每个 `(会话, origin)` 一次。批准后本次会话该 origin 不再打扰；换 origin 重新确认；会话结束作废。
5. 面板顶部一条确认条（不遮页面）：`example.com 想让 agent 填写「收货地址」并提交表单` + `[允许一次] [本会话允许本站] [拒绝]` + 30 秒倒计时。
6. **批准与执行是同一个请求**：grant 绑定动作指纹（origin + 动作类 + 目标），一次性使用；不存在「批准了再重发一次」的窗口。动作只可能执行 0 次或 1 次。
7. **fail-closed**：超时、面板不可见（DSH 窗口在后台不绘制，PROGRESS §10）、用户拒绝，一律**动作不发出**。新增三个错误码：
   - `approval_required`：面板不可用/不在眼前，可重试，hint 让用户回到窗口；
   - `approval_timeout`：30 秒无响应，可重试；
   - `approval_denied`：用户明确拒绝，不可重试，hint 让 agent 先问清楚再动手。
8. **强制执行点在工具体内**：body 通过 bridge 发 `confirm` 请求 → 面板渲染并回 decision → body 校验 grant 后才执行。UI 只是入口，绕过面板拿不到 grant。
9. `ctx.tools.guard` 职责不变：继续只做同步策略否决（会话 allowlist、eval 开关）。确认需要等待，与同步 guard 不合并。
10. **与宿主 approval 策略解耦**：宿主审批可能被用户设成 `never`（本会话即如此），不能拿它承担「敢让它碰登录态」的产品承诺；确认条由插件自己负责。
11. 相位机不变：等待确认时仍是 `agent` 相位（动作还没发出）。用户点「接管」时，pending 确认自动变成拒绝。
12. 配置：`approvals.mode`（`first-touch` 默认 / `every-action` / `off`）、`approvals.timeoutMs`（默认 30000）、`approvals.sensitiveSites`（默认空；列内站点每次提交都确认，适合网银/邮箱）。

## 理由

1. **信任要可验证**：用户不需要信任 agent，只需要信任「动手前问过我」这条规则。
2. **打断成本最低**：读无感，写每站一次；日常查资料零打扰，任务里最多两次（填写一次、提交一次）。
3. **用可观测的量替代不可观测的量**：「是否已登录」不可观测，「是否首次写动作」可观测。
4. **与「未知态」语义一致**：宁可不动，也不做未经确认的副作用；失败一律可重试、绝不重放（同 TICKET-034/报告 P0-2 的方向）。
5. **与产品定位一致**：竞品拼能力宽度，我们拼「敢用」；这条规则是「敢用」的最小可验证形式，且不依赖任何新权限。

## 后果

- 每个新站点第一次被 agent 动手时会打断用户一次；这是接受的代价，`approvals.mode: 'off'` 可一键全关。
- 新增 3 个错误码（13 → 16），需同步 `plugin/errors.js`、用户 README 的错误码表、`docs/cases` 的加固案例。
- 新增配置组 `approvals`（3 个字段）：实现时必须同步 `plugin/config.js` 的 `DEFAULTS`、`plugin/index.js` 的 Config schema、用户 README 的字段表与 YAML 示例——`node tools/check-docs.mjs` 会校验这三处一致。
- 面板 UI 从「只读回执 + 四态徽章」扩到「可交互确认条」，client 侧新增 grant 存储（按 `(sessionId, origin)`），需要 bump `CLIENT_REV`。
- 未验证项（进 TICKET-037 逐条验）：a) 窗口隐藏时能否**快速失败**而不是空等 30 秒；b) 点击是否「提交」的页面侧判定（含 `form.submit()` 直接调用——`plugin/inject/guards.js:91-99` 已 patch 该原型方法，可复用为标记点）；c) takeover 与 pending 确认的竞态；d) 确认条在窄面板下的排版。
- 未来若宿主暴露「租约审批」或 cookie 元数据，可以把「站点首次」细化为「未登录读 / 已登录写」两档；但默认值不应依赖宿主升级。
