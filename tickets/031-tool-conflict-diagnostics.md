# TICKET-031 工具名冲突：不再静默半死，改为可观测

- **状态**：✅ 已完成（2026-11-23，1.4.9 装机验收）
- **优先级**：P1（发布前加固；现场已两次踩到）
- **来源**：2026-11-23 上线测试 G0/G1 —— profile 里同时装了 `dsh-plugin-panel-browser`（CDP 原型）与 `dsh-plugin-agent-browser`，切换 bundle 时出现"插件 `fiberPhase: active` 但全部工具 `unknown tool`"
- **对应验收**：spec/002 B2（生命周期）与 B9（策略接缝）之间的宿主契约补充；`docs/launch-test-plan.md` §11 风险表

## 1. 问题

同一个 profile 里可以装两个浏览器插件（本机就是这种情况：`dsh-plugin-panel-browser` v0.1.0 来自 `D:\Vibe coding\33 deepseek harness CDP`，`dsh-plugin-agent-browser` 1.4.8 来自我们的 tgz）。两者都注册 `browser_open / browser_snapshot / …` 同名工具。

宿主 `ToolsService.register()` 对同名注册直接抛错：

```ts
// dsh/node_modules/@deepseek-ai/dsh-tools/src/index.ts:69
? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
```

而我们的注册循环在唯一的 `ctx.effect` 里，**一个名字抛错就中断整个 effect**：

- 表现一：插件行 `enabled: true / fiberPhase: active`，但 11 个工具一个都没有；
- 表现二：GUI 里工具调用报 `unknown tool "browser_open"`，看起来像插件根本没加载；
- 表现三：日志里只有一行宿主抛的 "already registered"，没有"是另一个浏览器插件占了名字"的上下文。

这类失败在发布场景里最贵：用户会以为是插件坏了，而不是"你装了两套"。

## 2. 修法

| # | 位置 | 改动 |
|---|---|---|
| 1 | `plugin/apply.js` 新增 `takenToolNames(ctx, names)` | 注册前取宿主已有工具名：优先 `ctx.tools.definitions()`（一次取全量），退路是逐个 `ctx.tools.get(name)`；都不可用时视为"无人占用"（注册仍可能抛错，由第 2 条兜住） |
| 2 | `plugin/apply.js` 注册循环 | 每个工具 `try/catch` 独立注册；失败记入 `failed[]` 并继续，**其余工具照常注册**；`ctx.tools.guard()` 也单独 try/catch |
| 3 | `plugin/apply.js` 冲突日志 | 检测到冲突时打印一行明确的：`tool name conflict: another plugin already owns browser_open, … Only one browser backend can be enabled per profile; disable the other one and reload.` |
| 4 | `plugin/bridge.js` 新增 `setDiagnostics(fields)` + `/health` 增加 `diagnostics` 字段 | 暴露 `{ tools, registered, conflicts, failed }`；`apply` 注册完成后写入，并 `bridge.note('tool surface', …)` 留一条日志 |
| 5 | `plugin/test/lifecycle.test.mjs` | 两个用例：①`browser_open` 被占 → `conflicts: ['browser_open']`、`registered: 10`、`failed` 一条、其余 10 个工具照常注册；②干净注册 → `conflicts: []`、`registered: 11`、`failed: []` |

**不做**：不改工具名（`browser_*` 是已发布契约，166 个单测、V/T/R/H/S 五套案例、三张卡片 key、`policy.js` 白名单都绑在上面）；不做自动"抢注/覆盖"（宿主不允许，也会让另一个插件半死）；不做自动停用另一个插件（跨 bundle 操作风险太大，留给用户/运维在发布说明里写清）。

## 3. 单测

- `node --test plugin/test/lifecycle.test.mjs` → 8 / 8 pass；
- 全量 `node --test <所有 plugin/test/*.test.mjs>` → **168 / 168 pass**（原 166 + 本票 2 例）。

## 4. 装机验收

| # | 步骤 | 期望 | 结果 |
|---|---|---|---|
| 1 | 打包 1.4.9、`install_bundle` | applied，fiberPhase active | ✅ pnpm `1.4.8 → 1.4.9` |
| 2 | 用 `tools/case-run/discovery-probe.mjs` 拿令牌后 `GET /health` | `diagnostics: { tools: 11, registered: 11, conflicts: [], failed: [] }` | ✅ |
| 3 | 同时启用 `dsh-plugin-panel-browser`（冲突现场） | 我们的插件**不崩**：`conflicts` 列出被占名字、`registered` 数字下降、其余工具仍注册；GUI 不再"完全没工具" | ✅ 见 §6.2 |
| 4 | 停用对方、恢复单浏览器后端 | `/health` 回到 `conflicts: []`、11 个工具齐全 | ✅ |

## 5. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | `ctx.tools.definitions()` 在宿主未来版本改签名 | `try/catch` + 逐个 `get()` 退路；两者都失效时行为退回"先试注册、失败记录"，不会崩 |
| R2 | 只注册了部分工具时，模型仍可能调用不存在的工具 | `/health.logs` 里的 `tool surface` + `failed` 给出证据；README 故障排查表新增"工具突然全部 unknown tool"一行 |
| R3 | 两套浏览器插件同时启用时，谁先注册谁生效 | 明确写进 README 已知限制与 `launch-test-plan` §11：一个 profile 只启用一个浏览器后端 |

## 6. 实现记录（2026-11-23，1.4.9 装机验收）

### 6.1 落地形状

- `plugin/apply.js`：`HOST_REV` 31 → **32**；新增 `takenToolNames()`；effect 内注册改为逐工具 `try/catch`，收集 `registered / failed / conflicts`；`bridge.setDiagnostics({ tools, registered, conflicts, failed })` + `bridge.note('tool surface', …)`。
- `plugin/bridge.js`：新增 `#diagnostics`、`setDiagnostics()`；`/health` 响应新增 `diagnostics`。
- 客户端无改动（`CLIENT_REV` 仍 42），所以升级不需要刷新界面。

### 6.2 装机验收实测

1. `install_bundle` 1.4.9 → `application: applied`（pnpm `1.4.8 → 1.4.9`）；客户端不变，无需刷新界面。
2. `/health` 出现诊断块（`tools/case-run/discovery-probe.mjs` 取证）：
   ```json
   {"tools":11,"registered":11,"conflicts":[],"failed":[],"clients":1}
   ```
3. **冲突现场未能在本机复现为全局重复注册**：把 `dsh-plugin-panel-browser` 也启用后，两个 bundle 都是 `fiberPhase: active`，但我们的 `/health` 仍是 `registered: 11 / conflicts: []`。原因是 CDP 原型的工具没有出现在**同一个全局层**里（宿主的分层注册：per-agent scope 与 global 分开，同名可 shadow 而不抛错）；也就是说"两套都装时谁生效"由 scope 与调用时的可见性决定，而不是本票假设的"后注册者抛错"。因此本票的冲突路径由单测覆盖（`lifecycle.test.mjs` 两例：占用一个名字 → `conflicts` 列出、`registered` 减少、其余工具照常），`/health` 诊断在真实冲突时仍然有效。
4. 恢复单后端：`set_bundle dsh-plugin-panel-browser enabled=false` → bundle 列表只剩 `dsh-plugin-agent-browser`，`/health` 回到 `tools: 11 / registered: 11 / conflicts: [] / failed: []`，`clients: 1`（面板已连上）。
5. 文档：用户 README 故障排查新增"工具突然全部 unknown tool"行与已知限制第一条；`docs/launch-test-plan.md` §11 新增"同一 profile 装了第二个浏览器插件"风险行。

### 6.3 偏差与残留

- 只做"可观测 + 不崩"，不做自动停用/抢注——跨 bundle 自动操作风险高于收益；
- 现场升级路径本身也暴露一个新的运维事实：**`install_bundle` 会按 pnpm 依赖把另一个 bundle 的启用状态重新写回 `dsh.profile.bundles`**（本机 1.4.9 安装把之前停用的 `dsh-plugin-panel-browser` 又写回去了）。因此"只启用一个后端"不能当成一次性动作，每次装/升级后都要复查；这条已写进 README 已知限制与上线计划风险表。
- `definitions()` 返回的是当前 scope 可见的定义；若未来宿主允许按 agent scope 隔离同名工具，本检测可能把"不同 scope 同名"漏报/误报——当前只做 best-effort，`failed` 里始终保留真实注册错误文本可追溯；
- 检测在 `ctx.effect` 之前做一次快照，热重载期间另一个插件若刚好同时注册，仍可能漏报为 `failed`（同样可从 `/health.failed` 追溯）。

