# 内置联网工具 vs 面板浏览器：分工与边界

> 目的：回答「本插件和 DSH 新出的『网页搜索与抓取』是什么关系，要不要借搜索引擎增强插件」。
> 结论先给：**不是替代，是三层分工**。插件不新增搜索工具；搜索引擎在插件里的唯一正确角色是**失败路径上的 URL 解析器**。
> 核查时间：2026-11-21。对象：`api-docs.deepseek.com/zh-cn/guides/search`，以及 asar 内 `dsh-web` / `dsh-tool-web` / `dsh-web-search-deepseek` / `dsh-web-deepseek-api` / `dsh-web-fetch-http` 五个包。

## 0. 一句话结论

内置的 `web_search` / `web_fetch` 是**匿名身份的一次性取文本**：找得快、读得干净、不用开面板，但读不了登录后的页面，也点不动任何东西。本插件是**用户本人身份的一台真浏览器**：能点、能填、能留证据，代价是慢、贵（视觉 token）、且必须有人看着。

两者只在"读一篇公开静态文章"这一小块重叠，而在那块上内置几乎全面更优。所以关系是：**内置负责发现与快读，插件负责动手与取证**。

## 1. 三层能力，别混着说

| | ① 服务端联网工具 | ② 裸 API（直连） | ③ `ctx.web` seam | ④ 面板浏览器（本插件） |
|---|---|---|---|---|
| 形态 | 模型侧工具 `deepseek_web_search` / `deepseek_read_url` | `POST /v1/tools/search`、`/v1/tools/fetch` | DSH 内部服务，`dsh-tool-web` 消费它 | 右侧栏 Electron `<webview>` + 11 个 `browser_*` |
| 身份 | 服务端，匿名 | 匿名 | 取决于 provider | **用户本人**（进程内 partition，带 Cookie） |
| 执行 | 服务端 | 服务端 | HTTP（`dsh-web-fetch-http` 时） | 真 Chromium，执行 JS、渲染、输入事件 |
| 产物 | 答案 + URL 列表 / Markdown | 同左，字段更全 | `{content?, sources, truncated}` / `WebFetchResult` | 页面树、截图、下载原件、sha256 |
| 计费 | **不计费，只算 token** | **5 元 / 1000 次成功请求**（QPS Search 100 / Fetch 25） | 走哪个 provider 就按哪个算 | 本地，零费用，烧的是视觉 token |

注意 ② 与 ③ 不是并列产品，而是"同一份能力的两条接法"：DSH 把 ② 包成了 ③ 的一个 provider。**插件该接 ③，不该自己拼 HTTP 调 ②**（理由见 §6.5）。

## 2. 证据

### 2.1 服务端联网工具（免费，模型默认看到的就是它）

`dsh-web-search-deepseek`，locale 标题「DeepSeek 网页搜索」。搜索与抓取都在服务端完成，返回 `content`（提供方答案）+ `sources`。**不按次计费，只计 token**。

### 2.2 裸 API（按次计费）

- `POST https://api.deepseek.com/v1/tools/search`：`query` / `count`(1–50) / `ori_question` / `localization` / `need_content`；支持 `site:`、`-site:`、`-"…"`、`lang:`、`after:`、`before:`；返回 `rerank_score` / `title` / `url` / `snippet` / `summary` / `content` / `site_name` / `site_icon` / `date` / `authority`。
- `POST https://api.deepseek.com/v1/tools/fetch`：`url` → `{title, content}`（Markdown）。

### 2.3 `ctx.web` seam 与 provider 选择

```ts
// dsh-tool-web/src/index.ts
export const inject = ['tools', 'web', 'systemPrompt']
// dsh-tool-web/src/search.ts
const llmProvider = exec.agent?.session.requestContext()?.provider
const route = llmProvider === undefined ? {} : { llmProvider }
ctx.web.search({ query, maxResults, ...route }, signal)
```

工具注册带准入门控：`{ when: ({ modelSelection }) => ctx.web.searchReady(modelSelection.provider) }` —— 没配 provider 时工具**根本不出现**，而不是出现后报错。返回结构 `{ content?: string, sources: WebSearchSource[], truncated: boolean }`，source 含 `url` / `title` / `snippet` / `summary` / `date` 等。

设置页「网页搜索与获取设置」可分别指定 `searchProvider` / `fetchProvider`，默认「自动」。

### 2.4 `dsh-web-fetch-http` 的真实限制（"内置抓取"的天花板）

| 项 | 值 |
|---|---|
| `maxResponseBytes` | 5,000,000 |
| `maxBodyChars` | 100,000 |
| `timeoutMs` | 30,000 |
| `maxRedirects` | 5（同源） |
| URL 上限 | 2048 |
| 内容类型 | 只解码 html + text 系；二进制与 **PDF** 抛 `WEB_UNSUPPORTED_CONTENT_TYPE` |
| JS | 不执行 |
| `<meta charset>` | 忽略（按 HTTP 头与探测） |
| 内网 | 可访问 loopback 与内网地址 |

`dsh-web` 的 README 明确把 `web_extract`（Firecrawl / Tavily 那种"抽取 + 结构化"）列为**延期工作，不做**。

## 3. 重叠区只有一块

**唯一真正的重叠：读一篇公开、静态、无需登录的文章。** 在这件事上内置确实更好——一次 `web_fetch` 拿回干净 Markdown，不开面板、不截屏、不烧视觉 token、不等渲染。

三个决定性差异，不在"谁读得好"：

1. **身份**：内置匿名，插件是用户本人。登录后的内容、个人化结果、地区限制，内置结构性做不到。
2. **能否动手**：内置只接受一个 `url`；插件有完整输入栈（点击 / 输入 / 按键 / 悬停 / 滚动 / 缩放 / 下载 / eval）。
3. **产物**：内置给文本；插件给可核对的证据（截图、原件、sha256）。

## 4. 正确链路（写进文档与工具描述的就是这一段）

```
web_search（带 site: 锁域名）
   ↓ 拿到深层页 URL
web_fetch（先试快读；公开静态页到这里就结束）
   ↓ 403 / 登录墙 / 需要点击 / 需要看图 / 要留证据
browser_open（面板接管，进入"动手"阶段）
```

判据表：

| 目标 | 用哪个 | 理由 |
|---|---|---|
| 只要一段信息，来源是公开文章 | `web_fetch` | 快、免费、不占面板 |
| 只知道站点、不知道具体页 | `web_search` + `site:` | 比在站内搜索框里点更可靠（T6/T8 的 no-op 就是没这么做） |
| 要登录、要翻页、要选规格、要下载附件 | `browser_open` | 只有真浏览器带身份 |
| 要证明"我看到的就是这个" | `browser_open` + `browser_screenshot` | 文本不可核对 |
| 页面读不到（WAF / 403 / 必须 JS） | `browser_open` | 内置不执行 JS |

**给模型的现成文案**（可直接进 `browser_open` 的 description 与系统提示）：

> 公开静态页（新闻、文档、法规原文）优先用 `web_fetch`：一次调用拿回 Markdown，不开面板、不烧视觉 token。
> 需要登录态、需要点击/填表/翻页、需要看图或留证据，才用 `browser_open`。
> 找入口用 `web_search`，进站优先 `site:<域名> 关键词` 拿深层页 URL，不要在站内搜索框里试。

## 5. 四种"借搜索引擎"的做法，价值差得很远

搜索返回的是「答案 + 一排 URL」，插件要的永远是**一个能打开的 URL**。所以正中要害的角色不是"答案来源"，而是 **URL 解析器**。

| | 做法 | 增强什么 | 与 `web_search` 的关系 | 结论 |
|---|---|---|---|---|
| A | `browser_open({ query })`：搜 → 开第一条能开的 | 把"找 + 开"压成一步 | 部分重复 | **不做**：工具语义变糊，且会自动在带登录态的浏览器里打开陌生域名 |
| B | `browser_find`：只搜不开 | 几乎不增强 | 高度重复 | **不做** |
| C | 打开失败（403/404/`ERR_*`/登录墙）时搜同站替代页，返回 `alternatives[]` | 失败恢复 | 不重复，只在失败时付成本 | ✅ 已实现（`docs/tickets/027`，1.4.2，默认关）：实测 provider 不认 `site:` → 改 `<host> <路径词>` + 客户端同站过滤；候选显式 `opened: false` |
| D | 用 `site:` 绕过站内搜索框 | 直接命中 T6/T8 的真痛点 | 不重复 | **现在就做，零代码**：落进 §4 的文案 |

C 与 D 是同一个机制：**把搜索当 URL 解析器，不当答案来源**。D 今天就能用（改文档），C 需要代码（等探针）。

C 比 A 好的四条理由：

1. **成本只在失败时付**——成功路径零额外调用、零额外 token；
2. **不改成功路径语义**——`browser_open` 仍是"打开这个 URL"，不变成"替我做决定"；
3. **安全面最小**——失败时给候选、由模型或人挑，而不是自动去开陌生域名；
4. **工具面不膨胀**——已有 11 个 `browser_*` 加 `web_search` / `web_fetch`，再加近义工具只会降低命中率。

## 6. 若将来接 `ctx.web`：技术前置与风险

### 6.1 注入

`dsh-tool-web` 就是 `inject = ['tools', 'web', 'systemPrompt']`。我们的 `plugin/index.js:23` 现在是 `['tools', 'attachments']`，加 `'web'` 即可。

### 6.2 硬依赖会拖垮插件

`web` 写进 `inject` 后，profile 里若没加载 `dsh-web`，**整个插件起不来**（11 个工具一起消失）。这一点已实测确认（2026-11-21 探针，见 §7）：

- cordis 的 `Inject` 类型是 `(keyof M)[] | { [K in keyof M]?: M[K] }`——**没有可选注入的写法**，数组/映射里的服务全部是必需；
- `Fiber._refresh()` 只要有一个注入服务拿不到就把 epoch 置 `INACTIVE`，`_setEpoch()` 随即卸载，fiber 停在 `pending`；
- 对照实验：一个只 `inject: ['tools', 'definitely-not-a-service']` 的本地插件，`apply()` **从未执行**，`list_plugins` 里 `fiberPhase: "pending"`，宿主与其他插件照常。

所以可选接缝只能用 `ctx.get('web')` 判空降级（`docs/design/browser-use-contract.md` §4 对 `browserUse` 用的就是这个写法，`dsh-tools` 的 pipeline 对 `approval` 也是 `ctx.get('approval')`）。**不要**把 `'web'` 加进 `inject`。

### 6.3 路由拿得到拿不到，决定落在哪计费

`llmProvider` 来自 `exec.agent?.session.requestContext()?.provider`。**已实测可得**（2026-11-21，运行时探针挂在 `tools/result` 上，`browser_open` 触发）：

```
hasAgent=true hasSession=true
provider=opencode-go  model=deepseek-v4.1-flash  contextWindow=1000000
```

但拿到 route **不等于**能选到免费 provider——见下一节。它只决定 `dsh-web` 默认偏好哪一只。

### 6.4 计费归属要透明

`ctx.web` 在本机实际装了两只搜索 provider（`listProviders()` 原样输出）：

| provider | 描述（原文摘要） | 价格 |
|---|---|---|
| `deepseek-official` | No per-search charge, but every search uses extra model tokens. Requires a DeepSeek account or API key. | 不按次收费，但**吃模型 token**，需要账号/API Key |
| `deepseek-search-api` | Incurs charges, paid by the account or API key chosen under Billing. | **按次计费**（5 元 / 1000 次成功请求） |

`dsh-web` 的选路规则（`src/index.ts:229-240`，rc.5）：

```ts
const configuredId = this.config.searchProvider.get() ?? process.env.DSH_WEB_SEARCH_PROVIDER
const preferredId = llmProvider !== undefined && DEEPSEEK_MODEL_ROUTES.has(llmProvider)
  ? 'deepseek-official' : 'deepseek-search-api'
```

`DEEPSEEK_MODEL_ROUTES = new Set(['deepseek-official', 'deepseek-account'])`。**本机 LLM route 是 `opencode-go`**，不在集合里 ⇒ 无论传不传 `llmProvider`，**seam 默认都会选 `deepseek-search-api`（计费那只）**；只有在用户把 `dsh-web` 的 `searchProvider` 配成 `deepseek-official`、或 route 切到 DeepSeek 官方时才会免费。

这条推翻了一个早期假设（"落服务端 provider 免费"是取决于部署配置的，不是默认值）。对 TICKET-027 的约束：默认 `false` 不能改；启用后必须把 `provider` 与调用次数写进日志，让用户能对上账单；文档要写清"在这台机器上开启 = 按次计费"。

### 6.5 禁止自建 HTTP 调 `/v1/tools/search`

自己拼 HTTP 会绕过三件事：部署的 provider 选择、`searchReady` 的准入检查、以及计费归属。等于在插件里藏一个不透明支出，还多一份要维护的 API 适配。

### 6.6 安全面

自动打开搜索结果 = 让不可信输入决定"在带登录态的浏览器里访问哪个域"——钓鱼、CSRF、会话泄露都从这里进。缓解：默认不自动开，只在失败换路时**返回候选**。

### 6.7 工具面预算

当前工具面 11 个、10,196 字符 ≈ 3.2k tokens（`docs/spec/002` 术语表口径）。搜索类工具已有两个，**不要成为第三个**。

## 7. 未验证项（2026-11-21 两条都已验完）

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| U6 | host 侧工具能否拿到 `exec.agent?.session.requestContext()?.provider` | ✅ 能 | `browser_open` 触发后读到 `provider=opencode-go`、`model=deepseek-v4.1-flash`、`contextWindow=1000000`（探针挂在 `ctx.on('tools/result')`） |
| U7 | 当前 desktop profile 是否加载 `dsh-web`；cordis 可选注入怎么写 | ✅ 已加载；**没有可选注入** | `ctx.get('web')` 在 `inject:['tools']` 下可用（`search/fetch/searchReady/fetchReady/listProviders` 齐全）；对照实验 `inject:['tools','definitely-not-a-service']` 的插件 `apply()` 从未执行、`fiberPhase:"pending"`、宿主不受影响 |

结论：C 方案（失败换路）技术上可行，但**必须默认关**——因为 U6 拿到的 route 在本机会让 seam 选到计费的 `deepseek-search-api`（§6.4）。✅ 已于 2026-11-22 按此落地（`docs/tickets/027`，1.4.2）：默认关、一次失败最多 1 次搜索、只附同站候选、绝不自动打开；实测偏差（`site:` 不可用、provider id 不可得、标题不可得）记在 ticket §6.5。

探针是一次性本地插件（读结果后已删除并还原 profile patch），复现要点：`inject:['tools']` + `ctx.on('tools/result', (exec, result) => …)` + 把 `exec.agent?.session?.requestContext?.()` 与 `ctx.get('web').listProviders()` 写文件。

## 8. 复现步骤

```powershell
cd "D:\Vibe coding\32 deepseek harness cebiankuang"

# 看 seam 与 provider 的原文
node tools/asar.mjs cat "D:\deepseek harness\resources\app.asar" "dsh/node_modules/@deepseek-ai/dsh-tool-web/src/search.ts"
node tools/asar.mjs grep "D:\deepseek harness\resources\app.asar" "maxResponseBytes" "dsh/node_modules/@deepseek-ai/dsh-web-fetch-http/"

# 看我们自己注入了什么
Select-String -Path plugin\index.js -Pattern "export const inject"
```

## 9. 与其他文档的关系

| 文档 | 回答的问题 |
|---|---|
| 本文 | 内置 `web_search` / `web_fetch` 与本插件怎么分工、要不要借搜索引擎 |
| `docs/design/browser-use-contract.md` | 能不能直接复用官方 browser-use / Playwright MCP 工具（答案：不能，只是互斥锁） |
| `docs/spec/002` B11 | 把本文结论变成可验收的工程要求 |
| `docs/tickets/027` | 失败换路（§5 的 C）的实现工单 —— ✅ 已完成（1.4.2，见 ticket §6） |
| `docs/tickets/013` | 失败导航回退（换路的前提：现场不能丢） |

## 10. 2026-11-23 对照实验：把"何时用"写进工具描述，能让 Agent 主动选 `browser_*` 吗？

**结论：不能——至少不能单独生效。** 描述是必要条件，真正决定的是同一 profile 里还有没有别的浏览器工具在抢。

### 10.1 设计

同一提示词、两个独立子代理，改前（1.4.14）与改后（1.4.15）各跑一次，要求子代理在末尾输出一行 `TOOLS_USED: …`：

| 组 | 提示词要它做的事 | 期望 |
|---|---|---|
| A | 读公开静态文章 `https://zh.wikipedia.org/wiki/杭州市`，3 条要点 | 仍用 `web_fetch`（不该开面板） |
| B | 打开登录墙站点 `https://www.zhihu.com/`，列 3 条首页标题 | 改用 `browser_open`（该开面板） |

改后版本在 `plugin/tools.js` 里给 `browser_open`（`:153`）与 `browser_snapshot`（`:292`）各加了一段"When to use it / When not to"——正文就是 §4 那套分工，措辞与本文一致。

### 10.2 结果

| 轮次 | A 组 `TOOLS_USED` | B 组 `TOOLS_USED` |
|---|---|---|
| 改前（1.4.14） | `web_fetch, web_fetch, pilot_navigate, pwsh, web_search, pwsh, grep, read, pwsh` | `skill, pilot_navigate` |
| 改后（1.4.15） | `web_fetch, pilot_navigate, call_hermes, web_search` | `skill, pilot_navigate` |

两组都没有出现 `browser_*`：**0/2 → 0/2**。B 组两次都先读 `browser-pilot` 技能、再调 `pilot_navigate`，被 origin policy 拒绝后直接收工。

### 10.3 为什么

本机 profile 同时装了 `dsh-pilot`（`pilot_*` 七个工具）和本插件（`browser_*` 十一个），而且：

- 技能目录里的 `browser-pilot` 技能写明"目标站点一律用 `pilot_*` 工具"；
- 用户全局 `~/.dsh/AGENTS.md` 的浏览器协作协议同样规定一律用 `pilot_*`。

模型先撞上这两条强指令，就选了 `pilot_navigate`；它被拒绝后宁可换 `web_search` / `call_hermes`，也不会回头找 `browser_*`。工具描述排在技能与全局规则之后，权重不够。

### 10.4 可操作结论

1. **一个 profile 只留一个浏览器后端**（README「安全与隐私」已写）——这条比任何描述措辞都决定性。
2. 描述改动保留（1.4.15）：在只有 agent-browser 的 profile 里，它是分流依据；在双后端 profile 里它不害事，但也救不了场。
3. 若要在双后端 profile 里也能选中 `browser_*`，只能改上层指令：在 `~/.dsh/AGENTS.md`（或技能正文）里写明"默认 `pilot_*`；需要右侧栏可见面板、用户接管或截图留证时用 `browser_*`"——这是路由问题，不是描述问题。
4. 本实验的另一条副产品：`pilot_navigate` 对 `zhihu.com` / `zh.wikipedia.org` 都被 origin policy 拒绝（审批已关、这两个源不在 allowlist），所以本机走 pilot 的浏览器路径对这两个站点是**不可用**的。

### 10.5 插件侧默认开启 + 条件注入（1.4.16 / 1.4.17）

§10.4 第 3 条说的是"要改上层指令"，但那要求用户去改全局规则。产品负责人选了另一条路：**把分流做进插件，默认开启、按条件注入**。

- `routing` 配置三态：`auto`（默认）/ `on` / `off`。
- `auto` = 只在**检测到另一套浏览器工具**时把段落加进系统提示词：每次组装时扫 `ctx.tools.definitions()`，看有没有 `pilot_` 前缀或面板版独有的 `browser_navigate` / `browser_act` / `browser_wait` / `browser_tabs` / `browser_close`。单后端 profile 因此保持零噪音。
- 段落名 `agent-browser-routing`，order **3050**（`TOOL_COMPUTER_USE` 3000 与 `MCP_SERVERS` 3100 之间），每次组装重新求值，所以后加载的后端也看得见。
- 正文（`ROUTING_TEXT`）只陈述自己的分工，不点名任何别的插件：需要用户的登录态 / 要 JS 或点击才出内容 / 要下载文件 / 要一张留作证据的截图 → 用 `browser_*`，`browser_open` 先开面板；公开静态文章走 `web_fetch` 更便宜。

**"到底注进去了没有"必须可查**，否则只能拿子代理的工具选择当证据——那分不清"没注入"和"注入了但被无视"。1.4.17 起 `/health` 直接给：

```json
"routing": {
  "mode": "auto",
  "injected": true,
  "order": 3050,
  "competitors": ["pilot_navigate", "pilot_snapshot", "pilot_act", "pilot_wait", "pilot_screenshot", "pilot_close"]
}
```

装机 1.4.17 后实测就是这一段：段落已注册、`injected: true`、竞争者就是 pilot 那六个工具。行为侧同时看到了变化——同一条 A 提示词（静态维基词条）在 1.4.16 之后出现了 `browser_open`（`web_fetch` 与 `pilot_navigate` 先后失败时），而 1.4.14/1.4.15 两轮里 `browser_*` 一次都没出现；但 B 提示词（知乎登录墙）仍先选 `pilot_navigate`。

结论保持不变、只是更精确：段落是**必要条件**，不是充分条件。技能正文与 `AGENTS.md` 仍排在它前面，模型在冲突时会先服从"一律用 `pilot_*`"。要彻底改观只有两条：`~/.dsh/AGENTS.md` 补一句分流，或者这个 profile 只留一个后端。
