# 对照官方文档：改进与优化清单

> 目的：用官方文档（<https://deepseek-harness.github.io/deepseek-harness/develop/basic/>）当尺子量一遍我们的插件，找出**是官方明确要求而我们没做到**、以及**官方给了更好的做法**的地方。
> 核查时间：2026-11-20。对照对象：`plugin/` 源码（开发期）与 `dist/dsh-plugin-agent-browser` 1.0.39（发布物）。
> 读过的页：`develop/basic/{index,tool,config,publish}`、`develop/framework/{index,service}`、`develop/practice/`、`docs/cases/cookbook/adding-a-tool`、`docs/cases/capability-seams`（均为 `.md` 原文）。

图例：**P0** 发布前必修 · **P1** 下次迭代 · **P2** 可选/认知类 · 成本：S（<1h）/ M（半天）/ L（1 天以上）

## 总表

| # | 主题 | 官方要求 | 我们 | 优先级 | 成本 |
|---|---|---|---|---|---|
| 1 | 可调参数必须配置化 | [`config`] "凡是不同部署可能需要采用不同值的参数，都必须定义为配置字段" | 端口/超时/上限全硬编码 | P0 | M |
| 2 | 卸载顺序 | [`framework`] 多个异步处置器**并发**执行，顺序依赖必须放进同一个 `ctx.effect()` | 桥/静态/11 个工具共 13 个独立 effect | P0 | S |
| 3 | 包元数据 | [`publish`] 用 `engines.dsh` 声明兼容范围；dsh 包同时进 peer 与 dev | 无 `engines`、无 devDeps、`private:true` | P0 | S |
| 4 | 工具用 `defineTool` | [`cookbook`] 参数自动校验、`output.schema` + `render` 分离、PTC 可拿结构化值 | 手写定义、无 `output.schema` | P1 | L |
| 5 | 稳定错误码 | [`cookbook`] 预期失败抛带 `code` 的 `HarnessError` 子类 | 全是 `new Error('taken_over: …')` | P1 | M |
| 6 | 遵守 `exec.signal` | [`cookbook`] 取消时中止在飞工作，别吞成普通错误 | 只有 1 处用了 signal | P1 | M |
| 7 | 策略别内建在工具里 | [`cookbook`] 用 `tools/pre-execute` / `ctx.tools.guard()` | eval/下载/激活都写在工具体内 | P2 | M |
| 8 | Web 卡片要 client 插件 | [`cookbook`] 内置 Web Client **不消费** `presentCall/presentResult`，卡片走 keyed slot `tool.call.toolview` | 有 presentCall，但 Web 里没有专属卡片 | P2 | M |
| 9 | patch 是整行替换 | [`publish`] "patch 会替换目标行的整个 `config` 值，而不是深度合并" | 我们的行没有 config，但没写进用户文档 | P2 | S |
| 10 | 不预防性拆分 | [`practice`] "只有角色需要独立演进时，才使用不同包" | 单包三角色，符合 | — | — |
| 11 | 桌面限定 | 官方无此约束（面板本就是桌面概念） | 属产品定义 | — | — |
| 12 | 能力接缝证据 | [`capability-seams`] `ctx.browserUse` 只有 definition + 3 个 provider，**没有 consumer** | 印证"不能复用"（见 `browser-use-contract.md`） | — | — |

## 逐条

### 1. 端口 / 超时 / 上限必须变成配置字段（P0，M）

官方给的检验标准很硬：「能否在 `cordis.yml` 中改变这个值，而不需要修改代码？」

现状（全部硬编码）：

| 值 | 位置 | 现在的值 |
|---|---|---|
| 桥端口 | `plugin/bridge.js:19`（`BRIDGE_PORT`）、`plugin/client.js:40`（`BRIDGE_URL`） | `8792` |
| 桥请求超时 | `plugin/bridge.js:25`（`DEFAULT_TIMEOUT_MS`） | `20_000` |
| 导航超时 | `plugin/tools.js:145` | `45_000` |
| 快照/求值字符上限 | `plugin/tools.js:257`、`plugin/tools.js:986` | `8000` |
| 下载上限 | `plugin/downloads.js:22`（`MAX_BYTES`） | `50 MiB` |
| 静态服务单文件上限 | `plugin/static.js:18`（`MAX_BYTES`） | `32 MiB` |
| 下载目录 | `plugin/downloads.js:31`（`DOWNLOADS_DIR`） | `'downloads'` |

建议的 Config 形状（Schemastery，默认值就是今天的行为）：

```js
export const Config = Schema.object({
  activation: Schema.union(['auto', 'always', 'manual']).default('auto'),
  fitWidth: Schema.boolean().default(true),
  bridgePort: Schema.number().default(0),          // 0 = 由系统分配
  requestTimeoutMs: Schema.number().default(20000),
  navigationTimeoutMs: Schema.number().default(45000),
  snapshotMaxChars: Schema.number().default(8000),
  downloadMaxBytes: Schema.number().default(50 * 1024 * 1024),
  downloadsDir: Schema.string().default('downloads'),
  evalEnabled: Schema.boolean().default(false),    // 发布版默认关
  claimBrowserUse: Schema.boolean().default(true),
})
```

一个必须知道的副作用（官方 [`config`]）：**改普通字段会触发插件热替换**——对我们等于桥断开、webview 重建、页面丢失。所以：

- 端口、上限这类"装好就不动"的字段，普通字段够了；
- `activation` / `evalEnabled` / `claimBrowserUse` 这类"用户会边用边切"的，用 `.volatile()` + `configEditor` 就地改，避免每次切换都把页面砸掉（细节见 `~/.dsh` 的 `dsh-doc` references/configuration.md）。

### 2. 三个 effect 的卸载是并发的（P0，S）

官方 [`framework`] 原文：「处置器按注册顺序的逆序**开始**调用，但多个异步处置器会**并发**执行，不保证逐个完成。存在顺序依赖的清理步骤必须放进同一个 `ctx.effect()` 返回的处置器中。」

现状：`plugin/index.js:72`（`bridge.dispose()`）、`:78`（`void sites.dispose()`）、`:83`（每个工具一个 `ctx.tools.register`）是 13 个独立 effect（桥 1 + 静态服务 1 + 11 个工具）。卸载时它们会被同时触发 → 可能出现「静态服务已关，面板里正在加载的图片 404」「工具还在等桥的响应，桥已经关了」。

建议：合成一个有序 effect。

```js
ctx.effect(() => {
  const disposers = tools.map(t => ctx.tools.register(t))
  return async () => {
    for (const d of disposers.reverse()) await d?.()   // 1. 先摘工具
    await bridge.close()                               // 2. 再断桥（先拒掉在飞命令）
    await sites.dispose()                              // 3. 最后关静态服务
  }
})
```

顺带把 `browser_open` 的 `sites.ensure()` 与 dispose 做成引用计数（TICKET 里 A9 的历史问题本质是同一个：谁的生命周期更长）。

### 3. 包元数据三处缺口（P0，S）

官方 [`publish`]：

- 「使用 `engines.dsh` SemVer 范围声明组合包支持的 DSH 版本……安装和 profile 启动会拒绝当前运行的 DSH 不满足该范围的组合包」；
- 「需要与宿主共享实例的 dsh 包同时声明在 `peerDependencies` 与 `devDependencies` 中」。

现状 `dist/dsh-plugin-agent-browser/package.json`：无 `engines`；只有 `peerDependencies: { "@deepseek-ai/schemastery": "*" }`；无 `devDependencies`；`"private": true`（npm 发布会被拒）。

建议 diff：

```diff
-  "private": true,
+  "engines": { "dsh": ">=0.2.0 <0.3.0" },
+  "devDependencies": { "@deepseek-ai/schemastery": "^0.2.2" },
-    "@deepseek-ai/schemastery": "*"
+    "@deepseek-ai/schemastery": "^0.2.2"
```

（`private:true` 是否去掉，取决于你走 npm 还是只发 tarball；发 tarball 可以留着。）

### 4. 改用 `defineTool` + `output.schema` / `render`（P1，L）

官方 [`cookbook`] 的硬要求：「**声明并返回一个规范 JSON 值。**`execute` 只返回推导出的值……工具主体不要返回内容块，也不要迫使调用方从自然语言中解析 id 和字段。」

现状：11 个工具都是手写定义（`plugin/tools.js:127` 起的 `async execute(args, exec)`），参数校验靠自己写（例如 `browser_open` 在 `:131` 自己判空），没有 `output.schema`；`presentResult` 只给一个标题（如 `:169` `{ card: 'generic', title: \`Browser…\` }`）。

改法（以 `browser_open` 为例）：

```js
ctx.tools.register(defineTool({
  name: 'browser_open',
  description: '…',
  parameters: { url: { type: 'string' }, path: { type: 'string' } },
  output: {
    schema: { type: 'object', properties: {
      url: { type: 'string' }, title: { type: 'string' },
      needsHuman: { type: 'boolean' }, port: { type: 'number' },
    }, additionalProperties: false },
    render: (_args, v) => [{ type: 'text', text: `Opened ${v.url}${v.title ? ` — ${v.title}` : ''}` }],
    presentationMeta: (_args, v) => ({ url: v.url, port: v.port }),   // 回放卡片用
  },
  async execute(args, exec) { /* 返回规范值 */ },
}))
```

顺带收益：PTC mode 里 `await tools.browser_open({url})` 能拿到**结构化**返回值而不是渲染后的字符串（官方 [`cookbook`]「PTC mode 自动触达你的工具」），这对"用脚本串一串浏览器动作"是实质提升。

### 5. 错误码（P1，M）

官方 [`cookbook`]：「每种预期失败都应抛出带稳定 `code` 的 `HarnessError` 子类……只有抛出的 `HarnessError` 会让结果保留 `error.name` 和 `error.code`。」

现状：`throw new Error('taken_over: 用户已接管……')`、`'needs_human: …'`（相位语义塞在消息里）。模型只能靠字符串前缀猜。

建议：`class BrowserError extends HarnessError`，code 取 `TAKEN_OVER` / `NEEDS_HUMAN` / `NOT_OPEN` / `NAVIGATION_FAILED` / `DOWNLOAD_BLOCKED` / `PANEL_UNAVAILABLE` / `REF_STALE`；消息保留中文人话。这样模型可以写 `if (err.code === 'TAKEN_OVER')`，而不是 `err.message.startsWith('taken_over')`。

### 6. `exec.signal`（P1，M）

官方 [`cookbook`]：「遵守 `exec.signal`。信号触发时取消进行中的工作……注册表会把它记录为 `AbortError` 与 `TOOL_ABORTED`。」

现状：只有 `plugin/tools.js:351`（`service.ensure(agent, exec.signal)`）用了它；`bridge.request(...)` 只有固定超时。用户在 UI 里点"停止"后，已经发出去的那次点击仍会执行——这是我们最该补的一类"取消不彻底"。

建议：`bridge.request(sessionId, type, params, { timeoutMs, signal })`；signal abort 时 reject 为 `AbortError`、同时给面板发一条 `cancel` 命令（面板侧丢弃该会话队列里未执行的动作）。

### 7. 策略外置（P2，M）

官方 [`cookbook`]：「尽量不要把部署策略内建到工具中。使用 `tools/pre-execute` 实现可扩展的允许／拒绝／询问策略……使用 `ctx.tools.guard()` 设置最终的单调拒绝。」

现状：`evalEnabled` 这种东西如果写在 `browser_eval` 的 `execute` 里，就只对该工具生效；PTC 里 `tools.browser_eval(...)` 也走同一工具体，所以还好——但"分发版默认禁止 eval""下载可执行文件要问"这类策略，放在 `pre-execute` 里更合适，而且用户/其他插件能看见并扩展。

### 8. Web UI 卡片（P2，M）

官方 [`cookbook`]「Web Client 展示」：**「内置 Web Client 不消费 `presentCall` 或 `presentResult`」**；卡片要在 client 插件里注册 keyed slot `tool.call.toolview`。

现状：我们在 `plugin/tools.js` 里写了 `presentCall`/`presentResult`（`:166`、`:169` 等 22 处），这些对 Web 界面**不生效**（对 ACP/其他消费方才生效）。所以现在 `browser_screenshot` 在对话里只是一行路径文本。

建议：在 `plugin/client.js` 里注册 `tool.call.toolview`，为 `browser_screenshot` / `browser_snapshot` 渲染图片卡片（读 `result.meta.path` 或直接内联 data URL）。这是"看得见的提升"，也是把"截图落盘 → 用户还要自己去开文件夹"这条断链接上。

### 9. patch 的整行替换语义（P2，S，文档）

官方 [`publish`]：「patch 会替换目标行的整个 `config` 值，而不是深度合并各键。」

推论给用户：升级我们的包时，如果他们曾在自己的 profile patch 里覆盖过 `agent-browser-panel` 这一行，**整行 config 会被替换**。我们自己的 `cordis.patch.yml` 只 insert 不带 config，所以不受影响；但发布说明里要写一句"要改配置请在自己那一层重述整行"。

### 10–11. 明确不需要改的

- **不预防性拆分**（[`practice`]）：「只有角色需要独立演进时，才使用不同包。简单的工具插件无需拆分。」我们把面板 UI、host 工具、桥放一个包里是对的；之前讨论的"host 半边预设化"只在**要对外分发且需要按会话开关**时才做。
- **桌面限定**：官方没有"浏览器面板"这种能力的跨平台承诺（`ctx.browserUse` 的路由也是 MCP/外部浏览器）。我们的面板依赖 `globalThis.dshDesktop.browser` 是产品定义，不是缺陷；该做的是非桌面时 fail fast（不注册工具、不显示页签），这条已在 P0 清单里。

### 12. 能力接缝表给出的额外证据（写进 contract 文档）

官方 [`capability-seams`] 的 `ctx.browserUse` 一行：definition = `browser-use`，providers = `experimental-browser-use-playwright-mcp` / `chrome-devtools-mcp` / `stagehand-native`，**consumer 列是空的**。同一张表里 `ctx.web` 有 consumer（`tool-web`）。这从官方自己的架构图层面确认了：**没有任何官方包把 browserUse 暴露成模型工具**——工具是 MCP server 自己带进来的。这条已并入 `docs/design/browser-use-contract.md` 的 1.2 节。

## 落地顺序（建议）

1. **本周**（都是小改动，一天内）：#2 合并 effect、#3 包元数据、#1 的前半（Config 字段 + 读值替换硬编码）。
2. **下一迭代**：#5 错误码 → #6 signal（这两个一起做，因为都在 `bridge.request` 的边界上）→ #1 的后半（volatile + configEditor）。
3. **再往后**：#4 defineTool 重写工具面（与"5 核心工具收敛"合并成一次改动）、#8 截图卡片。
4. **发布前**：跑一遍 `dsh --profile <name> --dump-config` 确认层；`dsh plugin add ./xxx.tgz` 走一遍冷安装。

## 附：官方文档里没写、但我们踩过的

- 客户端插件（`dsh.client` / slot / webview 租约）在 `develop/` 下没有专页，最深的是 `docs/cases/subsystems/` 与各包 README；我们的 `docs/cases/001`、`003` 是这部分的一手材料。
- 组合包的"层顺序"（[`publish`]：bundles → profile patch → home patch → `--patch`）解释了为什么用户能在自己那层改我们的行为，也解释了为什么"我们的默认值要保守"。
