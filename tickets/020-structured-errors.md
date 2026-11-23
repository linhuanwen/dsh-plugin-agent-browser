# TICKET-020 结构化错误：稳定 code，而不是字符串前缀

- **状态**：✅ 已完成
- **优先级**：P1（与 TICKET-021 同一处边界，建议一起做）
- **来源**：`docs/official-docs-review.md` #9（官方 `develop/basic/tool` 的错误处理与 `HarnessError`）
- **对应验收**：`spec/002-official-alignment-spec.md` B5
- **关联**：TICKET-021（取消）、TICKET-022（defineTool 迁移时顺手换）

## 1. 问题

错误全是"人类可读字符串 + 前缀"，没有机器可读的 code：

| 位置 | 现在 |
|---|---|
| `plugin/tools.js:159` 附近 | `new Error('taken_over: 用户接管了浏览器…')` |
| `plugin/bridge.js` 超时路径 | `new Error('timeout: 面板 20s 内没有响应')` |
| `plugin/tools.js:357-375` | 拒非 http(s) 时抛 `new Error('unsupported scheme …')` |
| `plugin/downloads.js` | 超限 / 非法文件名各抛一条自由文本 |

后果：① 调用方（模型）只能靠读自然语言猜怎么恢复；② 面板 UI 只能 `String(error)`；③ 我们自己的单测只能 `assert.throws(..., /taken_over/)` 这种脆断言；④ 无法区分"重试有用"（timeout）与"重试没用"（scheme 被拒）。

## 2. 修法

### 2.1 错误类型

`plugin/errors.js`（新文件）：

```js
import { HarnessError } from '@deepseek-ai/dsh-llm'

export class AgentBrowserError extends HarnessError {
  constructor(code, message, { cause, retryable = false, details } = {}) {
    super(message, { cause })
    this.code = code
    this.retryable = retryable
    if (details) this.details = details
  }
}
```

> `HarnessError` 的构造函数参数要实测（`dsh-action-cards/lib/index.js:242` 只有 `class ActionCardError extends HarnessError {}` 的空子类先例）。若它不接受 `(message, {cause})`，就退成 `super(message)` + 自己挂字段，**不猜 API**。

### 2.2 错误码表（定稿）

| code | 触发 | retryable | 给模型的建议 |
|---|---|---|---|
| `panel_not_open` | 没有打开的页面就调 snapshot/click | false | 先 `browser_open` |
| `panel_taken_over` | 用户接管中 | true（等用户放手） | 提示用户点「交还控制」 |
| `needs_human` | 检测到登录/验证码 | false | 让用户手动处理 |
| `bridge_timeout` | 面板未在超时内响应 | true | 重试或检查面板是否在前台 |
| `bridge_closed` | 插件正在卸载/桥已关 | false | 报"插件已停用" |
| `unauthorized` | 令牌不对（TICKET-019） | false | 重启 DSH |
| `scheme_rejected` | `browser_open` 收到 file:/javascript:/data: | false | 只支持 http/https |
| `eval_disabled` | `evalEnabled: false` 时调 eval | false | 提示用户开配置 |
| `navigation_failed` | 页面加载出错 | true | 换 URL |
| `download_rejected` | 超过大小上限 / 扩展名被拒 | false | 换文件或调配置 |
| `budget_exceeded` | 输出超字符预算被截断（非错误，但需要 code 供 UI 区分） | — | 用 `read:true`/分段读 |

### 2.3 抛与呈现

- 工具内部一律抛 `AgentBrowserError`；`tools.js` 顶层不再 `catch` 后重包字符串。
- 迁移期保留旧前缀（`taken_over: …`）在 `message` 里，避免现存单测与 prompt 失配；code 是新增字段。
- `render()`/输出里带 `{ code, retryable, hint }`，让模型看到"该怎么恢复"而不只是一句人话。

## 3. 单测

新增 `plugin/test/errors.test.mjs`：

| # | 用例 |
|---|---|
| 1 | `new AgentBrowserError('x','m')` 的 `code === 'x'`、`instanceof HarnessError`、`instanceof Error` |
| 2 | 每个 `code` 都有对应文案与 `retryable` 值（表驱动，Code 表与实现不漂移） |
| 3 | `toJSON()`/序列化后 `code` 存活（跨进程/跨日志不丢） |
| 4 | 既有 71 例里依赖 `/taken_over/` 的断言仍绿（迁移期兼容） |

## 4. 装机验收

| 项 | 做法 | 期望 |
|---|---|---|
| 模型能读到 code | 让模型调 `browser_click` 而不先 open | 结果里出现 `panel_not_open` 与"先 open"的 hint，模型能自恢复 |
| UI 能分流 | 面板顶部条按 code 显示不同颜色/文案 | `needs_human` 显示"需要你操作"，`bridge_timeout` 显示"重试" |
| 日志不散架 | 看 `ctx.logger` 输出 | 一条错误一行，含 code 与 sessionId |

## 5. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | `HarnessError` 构造签名未知 | 先写一个 5 行探针脚本在 asar 里 `cat` 出 d.ts/实现；拿不到就用自己的 Error 基类（不继承），只保证 `code` 字段 |
| R2 | 改错误形状破坏 `plugin/test/*.test.mjs` 现有断言 | 迁移期双写（message 保旧前缀），单测 4 兜底 |
| R3 | code 表与实现漂移 | 单测 2 表驱动 |

## 6. 实现记录（2026-11-21，版本 1.2.3）

### 6.1 落地形状

| 文件 | 改动 |
|---|---|
| `plugin/errors.js`（新增 ~200 行） | `ERROR_CODES` 11 码（每码 `retryable` + `hint`）、`AgentBrowserError`（message 统一渲染成 `` `<code>: <text>` ``，未知 code 抛 `TypeError`，`toJSON()` 供日志/面板）、`isAgentBrowserError()`、`fromPanelMessage()`（面板自由文本 → code，认不出的保持原样不贴标签）、`HARNESS_ERROR_BASE` |
| `plugin/bridge.js` | `#assert` / `#flushSession` / 超时 / `#closed` / `close()` / `/settle` 六处改为抛 `AgentBrowserError`：`panel_taken_over`、`needs_human`、`bridge_timeout`、`bridge_closed`；面板回传的自由文本经 `fromPanelMessage()` 映射 |
| `plugin/tools.js` | `normalizeUrl()` 非 http(s) → `scheme_rejected`；eval 开关 → `eval_disabled`；`download_failed` 输出加 `code: 'download_rejected'`（output schema 同步加字段） |
| `plugin/apply.js` | 应用日志追加 `error codes: 11 (base: local)` |
| `tools/pack.mjs` | COPY 白名单加 `errors.js`（现 14 项） |
| `plugin/test/errors.test.mjs` | 新增 8 例 |

### 6.2 基类决策（R1 的实测结论，与原计划有偏差）

- asar 实测 `HarnessError`（`dsh/node_modules/@deepseek-ai/dsh-error/src/index.ts`，827 B）：`constructor(message, code, options?)`，`this.code = code`，`this.name = new.target.name`；`@deepseek-ai/dsh-llm` 只是 re-export。
- 宿主只对 `error instanceof HarnessError` 设 `error.info`（`dsh-tools/src/pipeline.ts:690`），而模型只读到 `Error: <message>`（`:719`）——所以 code 必须进 message，这一点原计划成立。
- **但插件拿不到宿主那份类**：profile 无 `@deepseek-ai/`；`createRequire(...).resolve('@deepseek-ai/dsh-llm')` 命中的是本机全局 npm 装的 DSH（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\...`），是**另一个模块实例**；`@deepseek-ai/dsh-error` 直接 MODULE_NOT_FOUND；`cordis-plugin-loader` 的 `resolve.mjs` 只解析插件入口包名，没有宿主模块联邦。子类化"另一份 DSH 的 HarnessError"过不了宿主的 `instanceof`。
- 结论：**不 import，改用本地同形基类**，`HARNESS_ERROR_BASE = 'local'`；`error.info` 恒为空（已文档化的偏差），code 靠 message 让模型读到。
- code 用小写（`panel_taken_over` 等），与生态现有大写风格（`NO_ADAPTER` / `TOOL_ABORTED`）不同：随 `spec/002` B5 与已发布文档保持一致，类型本身是任意 string。

### 6.3 单测

`plugin/test/errors.test.mjs` 8 例：code/retryable/hint/message 前缀/name；11 码表驱动（每码可构造、hint 非空、message 以 `code: ` 开头）；`toJSON()` JSON 往返保留 code/details；旧前缀兼容（`/taken_over/`、`/needs_human:/`、`/did not answer/`、`/eval_disabled:/`）；未知 code 抛 `TypeError`；`retryable` 可覆盖且不重复前缀；`fromPanelMessage` 五类映射 + 未知文本不贴 code；基类 `local` + `name`/`instanceof Error`。全量 **114/114 通过**（原 106 + 8）。

### 6.4 装机验收（1.2.3，tgz 96,597 B；`install_bundle` → applied；`include:agent-browser-panel` enabled / active）

| 验收项 | 实测 | 结论 |
|---|---|---|
| 模型能读到 code | `browser_open({ url: 'file:///C:/Windows/win.ini' })` → `Error: scheme_rejected: only http(s) URLs are allowed, got file:` | ✅ |
| `panel_not_open` 可恢复 | 重装后首次 `browser_open` → `Error: panel_not_open: the browser panel of session session-… is not on screen, so the page cannot be driven. Open that session and its right sidebar browser tab, then retry.`；同一条命令重试即成功 | ✅ |
| 正常路径不回归 | 重试打开 `https://example.com/` → `Opened … — Example Domain` | ✅ |
| 宿主发现路由仍把门 | `GET /agent-browser/discovery` 无 cookie → `401` | ✅ |
| UI 按 code 分流 | 面板顶部条仍是 `String(error)` | ❌ 未做，并入 TICKET-023 |
| 日志含 code + sessionId | 宿主 console 不落盘、外部不可观测；`/health`、`/logs` 只暴露桥自身日志 | ⚠️ 无法验收 |

### 6.5 偏差与残留

1. 基类为本地类（见 6.2），结构化 `error.info` 恒空——想让 UI 拿到 `{ name, code }` 需另想办法（例如工具 `output` 里带 `code` 字段，已对 `download_failed` 先做）。
2. `needs_human` / `panel_taken_over` / `bridge_timeout` 目前只有单测覆盖，未做真实装机触发（需真人接管或故意挂起面板），留作补充验收。
3. UI 分流未做，与 TICKET-023（过程卡片）一起处理更划算。
4. 事故留档：用 PowerShell `Get-Content -Raw` + `Set-Content -Encoding utf8` 整文件重写 `bridge.js`，PS 5.1 按 ANSI 解码 UTF-8 导致中文乱码、吞掉字符串收尾引号并留下私有区字符 `U+E6C6`，`node --check` 报 `SyntaxError`。用 `edit` 逐行恢复 + `[IO.File]::WriteAllText(..., New-Object Text.UTF8Encoding($false))` 修好。**含非 ASCII 的源文件只能走 write/edit，不能过 pwsh 文本 cmdlet。**

### 6.6 后续追加的码（码表 11 → 13）

| 时间 | 来源 | code | 说明 |
|---|---|---|---|
| 2026-11-21 | TICKET-021 | `cancelled` | 调用方中止，`retryable:false`（已发的动作不撤销） |
| 2026-11-21 | TICKET-024 | `session_not_allowed` | 会话不在 `sessions.allowlist`，由 `policy.js` 的 guard 在工具体之前拒绝 |

