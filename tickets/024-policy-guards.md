# TICKET-024 策略接缝：把"允许做什么"挪出工具体

- **状态**：✅ 已完成（1.3.5 装机验收，2026-11-21）
- **优先级**：P2（现在能跑；但只要有人想在 profile 层禁掉 eval 或下载，就必须改我们的代码）
- **来源**：`docs/official-docs-review.md` #13（`tools/pre-execute` 观察事件与 `ctx.tools.guard()`）
- **对应验收**：`spec/002-official-alignment-spec.md` B9
- **关联**：TICKET-016（`evalEnabled` 现在只是工具体内的一个 `if`）

## 1. 问题

策略目前散落在工具体里，且**每一种策略都只有一处实现、没有统一入口**：

| 策略 | 现在的落点 | 问题 |
|---|---|---|
| 只允许 http/https | `plugin/tools.js:357-375`（`browser_open` 内部） | 只有 open 有；未来加"点击链接后跳到 file:"就绕过 |
| eval 开关 | TICKET-016 将要加在 `browser_eval` 体内 | 同上，且无法被组织级策略覆盖 |
| 下载扩展名黑名单 | `plugin/downloads.js`（TICKET-019 之前未做） | 同上 |
| 输出预算 | 每个工具的 `maxChars` | 每处自己 clamp |
| 会话允许名单 | 无 | 多 agent 协作时无法限制"只有某个 agent 能用浏览器" |

宿主已经提供了两个接缝：`ctx.tools.guard()`（注册一个 guard，`checkGuards(exec)` 时统一判定）与 `tools/pre-execute` 事件。用它们意味着：**在 profile 的 `cordis.patch.yml` 里就能收紧策略，不用改我们的代码**。

## 2. 修法

### 2.1 一个策略模块

`plugin/policy.js`（新文件，纯函数，可测）：

```js
export function createPolicy(config) {
  return {
    checkOpen(url) { return assertHttpUrl(url) },              // 抛 scheme_rejected
    checkEval() { if (!config.evalEnabled.get()) throw evalDisabled() },
    checkDownload(name, bytes) { /* 扩展名 + 大小 */ },
    clampChars(value, ceiling) { /* 上限 min(user, ceiling) */ },
    checkSession(sessionId) { /* 允许名单，空 = 全放行 */ },
  }
}
```

工具体只调 `policy.checkX()`，不再自带逻辑。

### 2.2 guard 注册

```js
ctx.effect(() => ctx.tools.guard((exec) => {
  const p = policy.checkSession(exec.sessionId); if (p) return p   // 返回错误即拒绝
}), 'agent-browser-guard')
```

（`guard` 的返回约定以 `ToolsService` 实现为准：`asar dsh/node_modules/@deepseek-ai/dsh-tools/src/index.ts` 里 `guard` / `checkGuards` 的方法体要读一次再定，**不猜签名**。）

### 2.3 配置来源三层

1. 插件 `Config`（用户自己的默认值）；
2. profile 的 `cordis.patch.yml` 条目 config（部署方收紧）；
3. 将来的组织策略（如果宿主提供）——留一个 `policySources` 数组，现在只有前两层。

## 3. 单测

新增 `plugin/test/policy-extra.test.mjs`（与 TICKET-016 的 `policy.test.mjs` 分开，免得一个文件过长）：

| # | 用例 |
|---|---|
| 1 | `checkOpen('file:///etc/passwd')` 抛 `scheme_rejected`；`http://`/`https://` 通过 |
| 2 | `evalEnabled.get() === false` 时 `checkEval()` 抛 `eval_disabled`；`.get()` 每调一次都重新读（volatile 生效） |
| 3 | 下载：`.exe/.msi/.bat/.cmd/.ps1/.lnk/.vbs/.scr` 被拒；`.pdf/.zip/.png` 通过；超 `maxBytes` 被拒；`code` 都是 `download_rejected` |
| 4 | `clampChars(99999, 4000) === 4000`；`clampChars(100, 4000) === 100` |
| 5 | `checkSession('s1')` 在空名单下通过、在 `['s2']` 下抛 `session_not_allowed` |
| 6 | guard 被拒时工具**没有**被执行（假 ctx.tools + 计数） |

## 4. 装机验收

| 项 | 做法 | 期望 |
|---|---|---|
| profile 层能收紧 | 只在 profile patch 里加 `config: { evalEnabled: false }`，不改插件 | `browser_eval` 直接拒，错误码 `eval_disabled` |
| 不收错误也行 | 不给任何 config | 默认与今天行为一致（除 eval 分发时默认关，见 TICKET-016） |
| 拒绝有说法 | 触发每种拒绝 | 错误里有 code + hint，不是一句 "not allowed" |
| 会话隔离 | 两个 agent，名单只含其一 | 另一个拿到 `session_not_allowed`，面板不动 |

## 5. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | `guard` 的返回约定不清，注册了但不生效 | 先写 3 行探针：注册一个永远拒的 guard，看工具是否被拦；生效再继续 |
| R2 | 策略层多一层以后，错误来源变二义（工具内还是 guard） | 所有策略错误统一由 `policy.js` 抛 `AgentBrowserError`，工具体不再自造策略错误 |
| R3 | `session_not_allowed` 与既有 `taken_over` 等码混用 | 归入 TICKET-020 的码表，新增一行，不另立体系 |

## 6. 实现记录（2026-11-21，版本 1.3.5）

### 6.1 落地形状

| 位置 | 落地 |
|---|---|
| `plugin/policy.js`（新增） | `createPolicy(config)` 返回 `{checkOpen, checkEval, checkDownload, clampChars, checkSession, guard}`；`BROWSER_TOOL_NAMES`（11 个）与 `DEFAULT_BLOCKED_EXTENSIONS`（26 个可执行扩展名）导出；所有配置位每次调用重读，普通值与 volatile 读取器都接受 |
| `plugin/errors.js` | 新增 `session_not_allowed`（`retryable:false`，hint 指向 `sessions.allowlist`），码表 11 → 13（含 TICKET-021 的 `cancelled`） |
| `plugin/tools.js` | 四个工具体改为经 `rules` 取策略：`open` 走 `checkOpen`、`snapshot`/`eval` 走 `clampChars`、`eval` 走 `checkEval`、`download` 走 `checkDownload`（经 `downloadTo` 的 `checkTarget` 钩子）；`clampBudget`/内联 scheme 判定删除 |
| `plugin/downloads.js` | `downloadTo` 新增 `options.checkTarget({filename, bytes, mime, finalUrl})`，在 `pickFilename` 之后、建目录/落盘之前调用 |
| `plugin/apply.js` | `HOST_REV` 31；构造 `rules` 并注入工具；单 effect 内 `ctx.tools.guard(exec => rules.guard(exec))`（无 `guard` 方法时降级记日志） |
| `plugin/config.js` / `index.js` | Config 新增 `downloads.extraBlockedExtensions` 与 `sessions.allowlist`；`normalizeConfig` 全量默认填充 + `texts()` 形状校验 |

guard 只对 `BROWSER_TOOL_NAMES` 生效：`ctx.tools.guard()` 是进程级全局拦截器，必须按 `exec.name` 过滤，否则会否决别的插件。

### 6.2 单测

`plugin/test/policy-extra.test.mjs` 6 例（与 ticket §3 一一对应，含"guard 拒绝时工具体零执行"的宿主流水线模拟）；`plugin/test/config.test.mjs` 补 `sessions`/`extraBlockedExtensions` 的默认与 4 个非法值用例。全量 **143 / 143 通过**。

### 6.3 打包装机

`tools/pack.mjs` 的 COPY 加 `policy.js`（15 项）→ `1.3.5`、tgz **107,274 B** → `install_bundle` applied（pnpm `-1.3.4 / +1.3.5`）；装机目录确认 `policy.js` 存在、`apply.js` 含 `HOST_REV = 31` / `createPolicy` / `policy guard registered (session allow list enforced)`。

### 6.4 装机验收

临时在 `C:\Users\林焕文\.dsh\cordis.patch.yml` 追加条目 config（用完已删除）：

| 项 | 做法 | 结果 |
|---|---|---|
| 会话名单拦在工具体之前 | `sessions.allowlist: [definitely-not-this-session]` | `browser_open` → `Error: session_not_allowed: this session is not allowed to drive the browser (session_not_allowed)` ✅ |
| profile 层收紧 eval | `evalEnabled: false` | `browser_eval` → `Error: eval_disabled: …`（改走 policy 路径）✅ |
| profile 层加扩展名 | `downloads.extraBlockedExtensions: [dat]` | `browser_download https://httpbin.org/anything/probe.dat` → `Download failed at policy: download_rejected: refusing to download .dat files into the workspace` ✅（loopback 夹具被下载器的"本机地址"检查先拒，故改用公网 URL） |
| 移除配置后恢复默认 | 删掉 config 块 | `browser_open` 正常、`browser_eval` 返回 `"Example Domain"`、同一 `.dat` 下载成功（371 B）✅ |

### 6.5 偏差与残留

1. 未做 `policySources` 数组：宿主当前没有第三层策略来源，空造一层接口属于猜测；等宿主提供组织策略再接（与 `docs/official-docs-review.md` 的"不预防性拆分"一致）。
2. `session_not_allowed` 没有独立 `retryable` 重试语义（模型拿到后应停止而非重试），hint 里只写"让操作者加名单"。
3. `downloadTo` 的 `checkTarget` 在**完整读取响应体之后**才调用（需要 `body.byteLength` 判大小），超大文件会先耗带宽；真正的上限仍由 `readCapped` 兜底。
4. 验收只覆盖单个 agent 会话的守卫路径，双 agent 隔离靠单测的名单语义推断（README 的 TICKET-010 已记录多实例并存，guard 是进程级、按 `agent.id` 判定，未做双开实测）。

