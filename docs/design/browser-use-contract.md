# browser-use 契约核查：为什么不能"直接调用内置浏览器工具"

> 目的：回答一个具体问题——**我们这 11 个 `browser_*` 工具能不能废弃，改成直接调用 Harness 内置的浏览器工具？**
> 结论先给：**不能**。官方的 `browserUse` 不是工具注册表，只是一把进程级互斥锁；真正的浏览器工具由 MCP server 提供，而本机没有安装这套东西。
> 核查时间：2026-11-20。核查对象：`@deepseek-ai/dsh-browser-use@0.2.2-rc.3`（从 npm 取 tarball 逐行读）、`@deepseek-ai/dsh-experimental-browser-use-runtime@0.2.2-rc.3`、本机 asar 与 `desktop` profile。

## 0. 一句话结论

复用不是"调一个函数"，而是"换一个产品"：把 `@playwright/mcp` 一家子 MCP server 装进来 → 工具集由 MCP server 决定（我们裁不动）→ 右侧栏面板消失（MCP 不认 Electron `<webview>`）→ 已登录的会话全部要重登。**唯一值得借的是那把锁**，用来防止两套浏览器工具同时抢同一个用户。

## 1. 证据链

### 1.1 `dsh-browser-use` 的全部内容：48 行，一个 Service，一个方法

`@deepseek-ai/dsh-browser-use@0.2.2-rc.3` 的 `src/index.ts` 一共 48 行，`export class BrowserUseRegistry extends Service`，构造时 `super(ctx, 'browserUse')`，对外只有：

| 成员 | 签名 | 作用 |
|---|---|---|
| `providerName` | `get providerName(): string \| undefined` | 谁占着 |
| `register` | `register(name: BrowserUseProviderName): () => Promise<void>` | 占位，返回释放函数 |

重复注册时抛的错原文：

```
browser use provider "<已注册的名字>" is already registered
```

成功路径走 `this.ctx.effect(...)`：注册占位，卸载时自动归还。**没有工具定义、没有 schema、没有 provider 工厂、没有 open/act 之类的动作面**。它就是一个带生命周期的互斥量。

这解释了它为什么出现在 `inject` 里却不像工具包：它提供的是**接缝（seam）**，不是能力。

### 1.2 工具从哪来：MCP server

`@deepseek-ai/dsh-experimental-browser-use-runtime@0.2.2-rc.3` 是 `SessionResources<T>` 的形状：每个 live Agent 一份资源、操作串行化、`close` 先于 `await`。它的浏览器工具来自**它桥接的 MCP server**：

- `@playwright/mcp@0.0.80`
- `chrome-devtools-mcp`
- `stagehand-native`

即：工具集 = 所选 MCP server 暴露的那一组，参数与返回格式由 MCP server 决定。**我们无法像 `ctx.tools.register()` 那样裁剪、改名、加我们的结构化错误**。想只留 5 个工具？做不到；想改 `snapshot` 的返回格式？做不到。

### 1.3 `ctx.web` 不是浏览器（容易被误认为"内置浏览器能力"）

`@deepseek-ai/dsh-web` 提供 `registerSearchProvider` / `registerFetchProvider` / `search()` / `fetch()`，返回 `WebFetchResult = { url, statusCode, body: { kind: 'html' | 'text', content }, truncated }`；非 2xx 是**结果**不是错误，`WebError` 只在无法安全取回或表示时抛。`@deepseek-ai/dsh-tool-web` 的 `inject` 是 `['tools', 'web', 'systemPrompt']`。

它是**独立 HTTP 客户端**：没有用户 Cookie、不执行 JS、不参与渲染。它和"面板里那台真浏览器"只覆盖交集的一小块（公开静态页），读不了登录态页面，也点不动。把它当"内置浏览器"会得出错误结论。

至于"要不要反过来借 `ctx.web` 的搜索增强插件"——那不是复用浏览器，而是**分工问题**：搜到的是一排 URL，插件要的是一个能打开的页面。结论与边界见 `docs/design/web-tools-and-agent-browser.md`（插件不新增搜索工具，搜索引擎只在失败路径当 URL 解析器）。

### 1.4 本机可用性：没装，而且正常渠道点不到

| 检查 | 结果 |
|---|---|
| asar 全量搜 `browser-use` / `BrowserUse` | **0 命中**（`D:\deepseek harness\resources\app.asar`，经 `tools/asar.mjs grep`） |
| profile `node_modules` | 只有 `dsh-plugin-agent-browser` 与 `playwright-core`，无 `dsh-browser-use` / `dsh-experimental-browser-use-runtime` |
| asar 里实际装的版本 | `@deepseek-ai/dsh-desktop-runtime@0.2.2-rc.3`、`@deepseek-ai/dsh-tools@0.2.2-rc.3` |
| npm 上同版 | `0.2.2-rc.3` 存在，可装 |
| npm dist-tags | **有坑**：`latest` = `0.1.6-alpha.1`（peer `@deepseek-ai/cordis ^0.1.6`，与 0.2.2 运行时不兼容）；`next` = `0.2.2-rc.5` |
| 插件市场 | profile 的 `cordis.patch.yml` 未配置市场索引（只有 `hd-events-local-v2`、`dsh-temp-redirect` 两条 insert），Discover 页看不到这些包 |

也就是说：**用户在我们的界面里点不到"官方浏览器工具"**；要装就得手写 patch 指定 `0.2.2-rc.3` 精确版本，装完再自己解决 MCP server 的启动与配置。

## 2. 三条路线

| | A. 官方 MCP 全家桶 | B. 自写工具 + 借接缝（**推荐**） | C. 两套并行 |
|---|---|---|---|
| 工具维护 | 官方维护，随版本升级 | 我们维护（已 15 张 ticket 的沉淀） | 双份 |
| 右侧栏面板 | **消失**——MCP 驱动的是外部浏览器 | 保留 | 保留 |
| 用户登录态 | 要重登（新浏览器实例） | 复用面板现有会话 | 复用 |
| 工具面可控 | ❌ 由 MCP server 决定 | ✅ 可裁剪、可门控 | ❌ 两套都是黑盒 |
| 接管/相位语义 | 无（MCP 不认识 `taken_over`） | 有 | 冲突 |
| 模型侧 token | 未知（取决于 MCP server，可能很大） | 已知（现 10196 字符 ≈ 3.2k，可收敛到 ~1.5k） | 叠加 |

C 的具体坏处：两套工具同名不同义时模型会乱选；两套都碰用户会话时互相踩状态。**直接排除**。

A 的隐藏成本：MCP server 的进程与端口归谁管、登录态归属、`playwright` 的浏览器二进制分发（约 150 MB）、以及"用户看得见吗"——面板是我们产品的定义，A 把它删了。

## 3. 决定

走 **B**：工具与面板继续自写，只从官方借三样横切契约：

1. **互斥锁**（`browserUse` 接缝）——防止我们和别的浏览器插件同时驱动同一个用户；
2. **`presentCall` / `presentResult` + locale** 的展示契约——让工具卡在 UI 里长得像官方工具；
3. **结构化错误**（官方的 `WebError` 范式）与 `ctx.systemPrompt` 片段——错误可被模型稳定识别，系统提示不必靠工具描述硬塞。

不借：MCP 全家桶、`SessionResources` 的资源模型（我们的资源是桥 + 一个 webview，生命周期已由 `ctx.effect` 管住）。

## 4. 互斥锁的接入设计

```js
// apply() 里，注册工具之前
const slot = ctx.get('browserUse')            // seam 不存在时是 undefined
let releaseSlot = null
let tools = []

const claim = () => {
  if (!slot || releaseSlot) return
  releaseSlot = slot.register('agent-browser-panel')   // 同步占位，返回异步释放
  ctx.logger?.info?.('browser use claimed by agent-browser-panel')
}
const drop = async () => {
  tools.forEach(t => t.dispose?.())
  tools = []
  const r = releaseSlot; releaseSlot = null
  if (r) await r()
}

ctx.effect(() => {
  if (config.claimBrowserUse !== false) {
    try { claim() } catch (err) { ctx.logger?.warn?.(`browser use busy: ${err.message}`) }
  }
  return () => { void drop() }
})
```

约束（来自官方契约原文）：

- `register()` 返回 `() => Promise<void>`，**释放是异步的**：必须先 `dispose` 自己的工具，再 `await release()`，否则别的插件拿到锁时我们的工具还在跑；
- 重复注册**抛错**（不是返回 null）：要 `try/catch` 并降级为"不占锁继续工作 + 日志"，不要因此让插件加载失败；
- `ctx.effect` 负责卸载路径：插件卸载 → 释放锁；
- 配置项 `claimBrowserUse`（默认开）：用户装了两套浏览器工具时，可以关掉让另一方独占。

## 5. 尚未验证 / 遗留

1. **没有真实安装验证**：本机没装 browser-use，上面关于"注册后别的插件会失败"的行为是从源码推的，未在运行时观察过。装 `0.2.2-rc.3` + `@playwright/mcp@0.0.80` 后应补一次双插件实测。
2. **peer 版本矩阵**：`0.2.2-rc.3` 的 peer 范围未逐条比对（`latest` 的 `^0.1.6` 是明确不兼容的坑）。
3. **MCP 工具面的真实 token 成本**：未测；如果将来要评估 A 路线，应先量 schema。
4. **触发重审的条件**：官方若把浏览器能力做成 `ctx.tools.register()` 风格的插件面工具（而非 MCP），或把 `browserUse` 扩展成带 `open/act` 的 provider 接口，本文档结论需重跑。

## 6. 复现步骤

```powershell
# 1. 确认没装
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-browser-use"

# 2. 读官方源码（tarball 里就是 48 行）
npm pack @deepseek-ai/dsh-browser-use@0.2.2-rc.3
tar -xzf deepseek-ai-dsh-browser-use-0.2.2-rc.3.tgz
Get-Content package/src/index.ts
```

asar 侧（Windows 上只能经工作区的 `tools/asar.mjs`；`app.asar` 里的 `dsh/` 不能直接用 PowerShell 打开）：

```powershell
cd "D:\Vibe coding\32 deepseek harness cebiankuang"
node tools/asar.mjs grep "browser-use" "D:\deepseek harness\resources\app.asar"
```
