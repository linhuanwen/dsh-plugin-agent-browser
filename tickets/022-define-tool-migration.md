# TICKET-022 工具定义契约锁定：受支持 schema 子集 + 结构化错误收口

- **状态**：✅ 已完成（2026-11-21，`1.2.5` 装机验收）
- **优先级**：P1（原计划"改动面最大"，前提复核后收窄为"契约锁定 + 错误收口"）
- **来源**：`docs/official-docs-review.md` #11（官方 `develop/basic/tool`：`defineTool` 定义参数、`output.schema` + `render` 定义返回值）
- **对应验收**：`spec/002-official-alignment-spec.md` B7
- **关联**：TICKET-020（错误类型）、TICKET-023（`presentCall`/`presentResult` 与过程卡片）

## 0. 前提复核（开工前，2026-11-21）

开票时的假设是"11 个工具全是手写字面量、没有 `output.schema`、没有 `render`、参数是手写 JSON Schema"。逐条核对 `plugin/tools.js` 后，前两条不成立：

| 原假设 | 事实（开工前） | 结论 |
|---|---|---|
| 没有 `output.schema` | 11 个工具都已有 `output: { schema, render }`（如 `browser_open` 在 `plugin/tools.js:183`） | ❌ 已存在，无需迁移 |
| 没有 `render` | 同上，且 `presentCall`/`presentResult` 各 11 处（`:166` 起） | ❌ 已存在 |
| 参数是手写 JSON Schema | 是手写，但用了 `minimum`/`maximum` 这类**宿主受支持子集之外**的关键字 | ✅ 真问题（见 §1） |
| 自校验与描述两处维护 | `tools.js` 里有 `Math.max/Math.min` 与描述里的范围各写一遍 | ✅ 真问题 |

据此把本票重定义为"把契约锁进测试、把子集外的关键字清掉、把结构化错误在截图步骤里保住"，**不引入 `defineTool`**。

## 1. 问题

1. **参数 schema 用了宿主不支持的约束关键字**：`browser_snapshot` / `browser_eval` 的 `maxChars` 带 `minimum`/`maximum`。宿主受支持子集（`dsh-tools 0.2.2-rc.5` 的 `src/json-schema.ts`）只有 `type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const` 加注解 `description`/`title`/`default`/`examples`；`minimum`/`maximum`/`pattern`/`format` 一律没有。参数侧目前不报错，是因为宿主只对 `output.schema` 调 `assertSupportedJsonSchema()`（`src/index.ts:128`），但同一份子集约束着 PTC 的类型生成，留着就是随宿主收紧而失效的定时炸弹。
2. **`browser_screenshot` 的 catch 把结构化错误降级成普通 `Error`**：取消（`cancelled`）或超时（`bridge_timeout`）在截图步骤里被包成 `new Error('screenshot failed at …')`，`code` 丢失，UI 无法分流、模型只能读文案。
3. **没有任何测试锁住定义形状**：`register()` 要求 `output: { schema, render, presentationMeta? }`，pipeline 还会用 `output.schema` 校验每次返回值（`src/pipeline.ts:547`，违反抛 `ToolOutputError`）。这两条一旦踩中，只有装机后才暴露。

## 2. 修法

### 2.1 不迁移到 `defineTool`（决策）

`defineTool`（`dsh-tools/src/schema.ts:555`）只是"参数语法糖 + 本地参数校验 + 输出 schema 转换"的工厂，产出的就是普通工具对象——而我们的对象本来就满足 `ToolDefinition`。迁移的代价是：

- 需要在插件里 `import { defineTool } from '@deepseek-ai/dsh-tools'`，而外部插件解析 `@deepseek-ai/*` 靠的是 Node 的全局目录（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\…`）里**另一份 DSH**，不是宿主 app.asar 那份（证据见 `tickets/020-structured-errors.md` §6.2）；
- 收益为零（参数校验宿主会做，输出 schema 宿主会校验），却给分发增加一条"必须装全局 DSH"的隐性依赖。

⇒ 保留手写定义，把宿主规则**复刻进单测**。这也是 `docs/official-docs-review.md` #11 的"实现期修正"。

### 2.2 参数：范围进描述，边界进代码

| 工具 | 改动 |
|---|---|
| `browser_snapshot` | 删 `minimum: 500` / `maximum: 30000`；描述改为 `Character budget for the tree, clamped to 500–30000. Defaults to …`；工厂内 `MIN_CHARS=500` / `MAX_CHARS=30_000`，execute 走 `clampBudget(args.maxChars, MIN_CHARS, MAX_CHARS)` |
| `browser_eval` | 同上（`MIN_CHARS=200`） |
| 其余 9 个 | 核过，无子集外关键字 |

`clampBudget(value, minimum, maximum)` 用 `Math.min(max, Math.max(min, Math.trunc(value)))`，注释写明"宿主子集没有 `minimum`/`maximum`，范围写在描述里、由工具体自己夹"。

### 2.3 截图错误不再降级

`browser_screenshot` 的 catch 改为：`isAgentBrowserError(error)` 时抛 `new AgentBrowserError(error.code, `${error.message} (screenshot step: ${step})`, { cause, retryable, details: {...error.details, step} })`，其余错误保持原样。这样 `cancelled` / `bridge_timeout` / `bridge_closed` 穿过截图步骤后 `code` 仍可被 UI 读到。

### 2.4 契约测试

新增 `plugin/test/tooldefs.test.mjs`，把宿主规则复刻成本地断言（不需要 Electron）。

## 3. 单测

`plugin/test/tooldefs.test.mjs`（7 例）：

| # | 用例 |
|---|---|
| 1 | 11 个工具名与顺序固定，无重复、符合 `browser_*` |
| 2 | 每个定义满足 `register()` 的硬要求：`description` 非空、`parameters` 为闭合 object、`output.render` 为函数、`presentationMeta` 若给必为函数、`timeoutMs` 若给必为正有限数（注释说明 rc.5 只校验不执行） |
| 3 | `parameters` 在宿主受支持子集内（未知关键字、oneOf 与 type 互斥且 ≥2 支、required ⊆ properties 且去重、enum/const 标量、default/examples lossless JSON） |
| 4 | `output.schema` 在受支持子集内 |
| 5 | `render({}, 最小合法值)` 返回非空 `ContentBlock[]`、首块 `type:'text'`、整体 lossless JSON；`presentationMeta` 亦然 |
| 6 | `browser_screenshot` 对 `AgentBrowserError('cancelled')` 保留 `code`，message 含 `(screenshot step: command)`，`details.step === 'command'` |
| 7 | budget 夹取：snapshot `5 → 500`、`10_000_000 → 30000`；eval `1 → 200`、`99_999 → 30000` |

## 4. 装机验收

| 项 | 做法 | 期望 | 结果 |
|---|---|---|---|
| 契约不破 | 装 `1.2.5` 后读 `list_plugins` | `include:agent-browser-panel` enabled / `fiberPhase: active` | ✅ |
| 输出校验通过 | `browser_open` + `browser_snapshot(maxChars: 600)` | 正常返回、`tree cut at the character budget` | ✅ |
| 截图渲染 | `browser_screenshot()` | 落盘并返回路径与尺寸 | ✅ |
| budget 夹取 | 单测 7 + 装机实测 `maxChars: 600` 生效 | 516 B（预算生效） | ✅ |
| 结构化错误保留 | 单测 6（真实取消需人在 GUI 按停止；`1.2.4` 已验证取消链路） | code 穿过截图步骤 | ✅ 单测覆盖 |

## 5. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 复刻的宿主规则与真实实现对不上（版本升级后子集变化） | 测试文件头注释写明依据的版本与源码位置（`dsh-tools 0.2.2-rc.5` `src/json-schema.ts` / `src/index.ts:128` / `src/pipeline.ts:547`），升 DSH 时先读这三处 |
| R2 | `clampBudget` 与描述里的范围漂移 | 测试 7 直接断言边界值；描述由同一组常量拼 |
| R3 | 截图错误包装改变文案，旧断言失效 | 只对结构化错误加后缀；普通错误文案不动；测试 6 断言后缀 |
| R4 | 输出 schema 写太严，现有返回值缺字段会 500 | 本次未收紧任何 `output.schema`，只加校验 |

## 6. 实现记录（2026-11-21，`1.2.5`）

### 6.1 落地形状

| 文件 | 改动 |
|---|---|
| `plugin/tools.js` | 新增 `clampBudget()` 助手；`browser_snapshot` / `browser_eval` 的 `maxChars` 去掉 `minimum`/`maximum`，范围进描述、execute 里夹取；`browser_screenshot` catch 保留结构化错误的 `code`（`AgentBrowserError` 重包 + `details.step`）；import 改为 `{ AgentBrowserError, isAgentBrowserError }` |
| `plugin/test/tooldefs.test.mjs` | 新增，7 例（见 §3） |

### 6.2 宿主契约依据（`dsh-tools 0.2.2-rc.5`）

- `src/contracts.ts`：`ToolDefinition` 强制 `output: { schema, render, presentationMeta? }`，`execute` 需 "observe or forward `exec.signal`"。
- `src/index.ts:128`：`register()` 校验 output 形状并调 `assertSupportedJsonSchema(output.schema)`；`timeoutMs` 只校验不执行（全 asar 只有 `src/index.ts:137` 与 `schema.ts:597` 读它）。
- `src/pipeline.ts:547` + `:618-644`：返回值按 `output.schema` 校验，`render`/`presentationMeta` 必须是 lossless JSON，违反抛 `ToolOutputError`。
- `src/json-schema.ts`：受支持子集见 §1，无数值范围/字符串格式/正则约束。

### 6.3 单测

`node --test plugin/test/tooldefs.test.mjs` → 7/7；全量 `node --test <所有 plugin/test/*.test.mjs 绝对路径>` → **128/128 通过**（原 121 + 7）。

### 6.4 打包与装机

`dist/dsh-plugin-agent-browser/package.json` version → `1.2.5` → `node tools/pack.mjs` → `copied 14 files`、`dsh-plugin-agent-browser-1.2.5.tgz 99,702 bytes` → `plugin_manager install_bundle` → `application:"applied"`，pnpm `- 1.2.4 / + 1.2.5`；装后核对 profile 内 `tools.js` 含 `clampBudget`（3 处）、无 `minimum: 500` / `maximum: 30000` 残留；`list_plugins` offset 195–225 查到 `include:agent-browser-panel` enabled true / `fiberPhase: active`；`browser_open https://example.com/` 正常，`browser_snapshot(maxChars: 600)` 返回 516 B（预算生效、`tree cut`），`browser_screenshot()` 落盘 `screenshots/shot-20261121-223137.png`（83.5 KB）。

### 6.5 与原票的偏差

| 原计划 | 实际 | 原因 |
|---|---|---|
| 11 个工具迁移到 `defineTool` | 不迁移，改为契约测试 + 子集清理 | 前提不成立（output/render 早已存在）；`defineTool` 只是工厂，import 会引入"另一份 DSH"的解析依赖，收益为零 |
| 补 `presentationMeta` | 不做，留给 TICKET-023 | 它是"过程卡片"的输入，和 Web 卡片渲染同一票才验证得动 |
| 声明 `timeoutMs` | 不加 | rc.5 只校验不执行，加了是假承诺；真正的预算是 `bridge.request` 的固定超时 |

### 6.6 残留

- **PTC 结构化的验证只到 schema 层**：模型/程序看到的仍是 `render()` 的文本块；"直接读字段"取决于调用侧（PTC）如何使用 `output.schema`，U3 仍未实测（需要 PTC 模式会话）。
- 本文档依据的宿主规则是 `0.2.2-rc.5`；升级 DSH 时先复核 `src/json-schema.ts` 与 `src/pipeline.ts` 的校验逻辑。
