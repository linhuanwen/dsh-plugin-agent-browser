# TICKET-039 approvals 配置、错误码文档与验收夹具

- 状态：✅ 已实现并验收（2026-11-24 实现；2026-11-25 夹具 F1–F6、F9–F12 真机执行通过，F7/F8 为配置级契约覆盖；check-docs 六项全绿，单测 245/245；记录见 `docs/cases/015` §4）
- 发现：2026-11-24（SPEC-003 C9/C11/C12；决策 010 后果）
- 关联：`docs/spec/003-first-touch-approval-spec.md`、`docs/tickets/037-first-touch-approval.md`、`docs/tickets/038-approval-confirm-bar.md`、`docs/cases/010-validation-cases.md`（案例格式参考）

## 1. 缺口

TICKET-037/038 落地后，有三件事不收口就会「代码能跑、发布不可信」：

1. **配置**：新增 `approvals` 分组会触发 `node tools/check-docs.mjs` 的三处一致检查（`plugin/config.js` 的 `DEFAULTS` ↔ `plugin/index.js` 的 `Config` schema ↔ 用户 README 的字段表与 YAML 示例）。任何一处漏改，文档检查直接红。
2. **错误码**：13 码 → 16 码，用户 README 的错误码表、`docs/cases` 的加固案例、`docs/spec/002` B5 的口径都要同步；模型侧靠 `code` 判定，不能只写人读文案。
3. **验收**：SPEC-003 §12 的 C1–C12 目前没有可复跑的夹具；「提交恰好 1 次」「窗口隐藏 < 1s 快速失败」「off 与 1.4.x 逐字一致」这三条是发版门槛，必须有证据。

## 2. 目标

- C9：`approvals.mode`（`first-touch` 默认 / `every-action` / `off`）、`approvals.timeoutMs`（默认 30000，clamp 1 000–300 000）、`approvals.sensitiveSites`（默认 `[]`）三处同步，`check-docs` 全绿。
- C11：兼容性表落地——升级说明、工具 schema 不变（字符数不增）、错误码表 13→16。
- C12：回滚验证——`off` 与 1.4.x 行为逐字一致。
- 验收夹具：`docs/cases/015-first-touch-cases.md`，覆盖 C1–C12，可复跑（本地 demo 页优先，避免依赖外网）。

## 3. 实现草案

### 3.1 配置（三处 + 文档）

- `plugin/config.js` 的 `DEFAULTS` 增加 `approvals: { mode: 'first-touch', timeoutMs: 30_000, sensitiveSites: [] }`；
- `plugin/index.js` 的 `Config` schema 增加对应字段（`.description()`、枚举、数字范围；`mode` 建议 volatile——切档不该重启插件，SPEC-002 B1 口径）；
- `dist/dsh-plugin-agent-browser/README.md`：字段表 + YAML 示例（顶层全量模板也要含 `approvals`）；
- 校验：`approvals.mode` 非法值在**加载期**被 schemastery 拒绝（不做静默回落）；`timeoutMs` 超界 clamp + 警告。

### 3.2 错误码（13→16）

- `plugin/errors.js` 已有三码（TICKET-037 落）；本工单负责文档面：
  - 用户 README 的错误码表补三行（code / retryable / 何时出现 / hint）；
  - `docs/cases/013-hardening-cases.md` 或新 case 里补一条「审批拒绝」取证；
  - `docs/spec/002` B5 的「至少覆盖 13 码」表述改为「16 码」，避免规格漂移。

### 3.3 验收夹具 `docs/cases/015-first-touch-cases.md`

按现有 case 格式（编号 + 目的 + 步骤 + 期望 + 证据截图）写：

| 编号 | 场景 | 期望 | 关联 |
|---|---|---|---|
| F1 | 读动作零确认 | 确认条 0 次 | C1 |
| F2 | 首次 type → 允许一次 | 键入 1 次、无重复 | C2/C4 |
| F3 | 提交点击 → 允许 | submit 事件恰好 1 次 | C2/C4 |
| F4 | 拒绝 | `approval_denied`，DOM 未变 | C5 |
| F5 | 30s 超时 | `approval_timeout`，DOM 未变 | C5 |
| F6 | 面板不可见 | < 1s 返回 `approval_required` | C5、U1 |
| F7 | 同站第二次写动作 | 不再问；换 origin 再问 | C3 |
| F8 | `sensitiveSites` 命中 | 每次写都问 | C3 |
| F9 | 接管竞态 | pending 变拒绝，agent 收 `approval_denied` | C7 |
| F10 | `mode: 'off'` | 与 1.4.x 行为逐字一致（旧 196 例 + 三写动作手测） | C11/C12 |
| F11 | 验证墙 + 写动作 | 只出 `needs_human`，不叠确认 | C8（依赖 033） |
| F12 | 窄面板 | 三按钮同时可见、不破版 | C7 |

夹具要求：优先用本地 `browser_open({ path })` 的 demo 页（`demo/` 下已有夹具，可加 `approval-form.html`），只有 F11 需要外网验证墙页面。

### 3.4 发布面

- `docs/spec/003` 状态从「草案」改「已实现」并回填 §11 的 U1/U2 结论；
- 用户 README 增加「升级说明：1.5.0 起默认开启首次写动作确认；不想要可设 `approvals.mode: 'off'`」；
- `docs/release/release-notes-1.5.md`（或补进现有 release notes）：默认值变更、新增错误码、回滚方法；
- `node tools/check-docs.mjs` + `node --test plugin/test/*.test.mjs` 作为发版前两道门。

## 4. 验收

1. `node tools/check-docs.mjs` 全绿（配置字段数、YAML 示例、错误码表、工具数都不漂）；
2. `approvals.mode` 三档在真实装机上生效；`off` 时 1.4.x 行为逐字一致（旧 196 例 + 三写动作手测）；
3. 非法 `approvals.mode` 在加载期被拒（插件不带着错值启动）；`timeoutMs` 超界 clamp 并给警告；
4. 用户 README 错误码表 16 行、字段表含 `approvals` 三字段、YAML 示例含默认值；
5. `docs/cases/015-first-touch-cases.md` 12 条夹具可复跑，每条有证据（截图或日志片段）；F10 附 196 例单测输出；
6. SPEC-003 §11 的 U1/U2 结论回填，§12 勾选完成；spec 状态改「已实现」；
7. 升级说明与回滚说明进 release notes；
8. `git status` 只有预期的 docs/config 改动，无临时文件。

## 5. 风险

- **check-docs 三处漏同步**：这是最容易翻车的一步（新增配置字段的硬门槛）；实现时先用 `node tools/check-docs.mjs` 跑一次看红，再逐项补齐。
- **夹具依赖外网**：F11 需要真实验证墙页；其余全部用本地 demo 页，避免网络抖动导致「假绿」。
- **`mode: 'off'` 回归不彻底**：`off` 分支必须**不经过**审批代码路径（而不是「问了但自动允许」），单测要断言连 confirm 帧都不下发。
- **规格/文档漂移**：错误码从 13 改 16 后，`docs/spec/002` B5 与 cases/013 的旧表述要一起改，否则下次检查会互相矛盾。
- **发布说明缺失**：默认值变更属于用户可感知变化，必须写进升级说明，否则会被当成 bug 反馈。

## 6. 不做

- 不改 host/client 实现（归 037/038）；
- 不做英文 README / marketplace 上架（v2.5 路线，调研报告 §6 P2）；
- 不做面板时间线（v2.0）；
- 不补网银等敏感站预置名单（`sensitiveSites` 由用户配置）。
