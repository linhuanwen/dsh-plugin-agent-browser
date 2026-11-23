# TICKET-027 失败换路：把"这个地址打不开"变成"这个站还有别的入口"

> 状态：✅ **已完成（2026-11-22，版本 1.4.2 装机验收；M5 最后一格）**
> 来源：`docs/web-tools-and-agent-browser.md` §5 的 C 方案（搜索引擎只当 URL 解析器）
> 对应验收：`spec/002-official-alignment-spec.md` B11 第 3/4 条
> 前置：TICKET-013（现场必须先保住，否则没有"从哪来"可拿来搜）

## 1. 问题

`browser_open` 失败时只有一个错误。模型能做的只有两件事：重试同一个 URL（T8 判据明确不超过 2 次），或者放弃整个站点。

但真实场景里"这个 URL 打不开"≠"这个站没有我要的东西"。T8 那次就是典型：

```
browser_open('https://www.bing.com/search?q=site%3Asamr.gov.cn+…')
→ ERR_CONNECTION_RESET (-101)
```

页面被重置了，可同一批规章还有列表页、移动版、镜像站——只是模型不知道地址，也不该为此在站内搜索框里瞎点（T6/T8 的 no-op 就是这么来的）。

搜索引擎恰好能回答这一个问题：**"这个站上，哪个 URL 更像我要的？"**它答不了"内容是什么"，我们也不需要它答。

## 2. 期望行为

| 场景 | 期望 |
|---|---|
| `navigation_failed`（DNS / 重置 / 403 / 404 / 证书） | 错误里多一个 `alternatives: [{ title, url, why }]`（≤ `maxResults` 条），`why` 说明命中词 |
| 落到登录墙 / 验证页（`needs_human`） | 同上——登录墙常常是"这个入口要登录，换个公开入口也许不用" |
| 搜索不可用（没有 provider / `web` 未加载） | **完全不出现** `alternatives`，错误与 1.2.x 逐字一致；不新增错误码、不降级成失败 |
| `searchFallback.enabled: false` | 与上面一行相同（默认就是 false，见 §3） |
| 候选返回后 | **绝不自动打开第一条**。开哪条由模型或人决定 |

## 3. 实现要点

### 3.1 探针（SPEC-002 U6 / U7）——✅ 2026-11-21 已完成

用两个一次性本地插件做的（`inject:['tools']`，挂在 `ctx.on('tools/result')`，把结果写到工作区文件；读完即删除并还原 profile patch）：

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| U6 | host 侧工具能否拿到 `exec.agent?.session.requestContext()?.provider` | ✅ 能 | `browser_open` 触发后：`hasAgent=true hasSession=true provider=opencode-go model=deepseek-v4.1-flash contextWindow=1000000` |
| U7 | `ctx.get('web')` 是否可用；可选注入怎么写 | ✅ 可用；**没有可选注入** | seam 暴露 `search/fetch/searchReady/fetchReady/listProviders`；`Inject = (keyof M)[] \| { [K]?: M[K] }`，`Fiber._refresh()` 任一注入缺失 → epoch=INACTIVE → 卸载 → `pending`；对照实验 `inject:['tools','definitely-not-a-service']` 的插件 `apply()` 从未执行、宿主与其他插件正常 |

**探针推翻了一个关键假设**：拿到 `llmProvider` 不等于能选到免费 provider。`dsh-web` 的选路是

```
configuredId = config.searchProvider ?? env DSH_WEB_SEARCH_PROVIDER
preferredId  = (llmProvider ∈ {deepseek-official, deepseek-account}) ? 'deepseek-official' : 'deepseek-search-api'
```

本机 route 是 `opencode-go` ⇒ **默认落在计费的 `deepseek-search-api`**；只有用户把 `dsh-web` 的 `searchProvider` 配成 `deepseek-official`（免费但吃模型 token）才会变。因此本工单的约束是：

1. `searchFallback.enabled` **默认 false 不能改**；
2. 启用后日志必须打出实际 `provider` id 与本次调用次数，让用户能对上账单；
3. 用户文档写清"在这台机器上开启 = 按次计费；要免费请先在 dsh-web 配置 `searchProvider: deepseek-official`"；
4. 不把 `'web'` 加进 `inject`，只用 `ctx.get('web')` 判空（U7 已证）。

### 3.2 调用形态

```js
// 只取 URL，不要 content
const route = provider ? { llmProvider: provider } : {}
const result = await ctx.web.search({ query, maxResults, ...route }, signal)
const alternatives = result.sources.map(s => ({ title: s.title, url: s.url, why: query }))
```

**不要把 `result.content`（提供方答案）透给模型**。一旦透了，模型会拿摘要当页面内容写结论——那正是本项目最不能出的错（结论必须可核对到页面）。

### 3.3 查询构造（纯函数，可单测）

```
site:<host> <标题里最具体的 2–4 个词>
```

- `host` 从失败 URL 取（去掉 `www.`）；没有 host（如 `chrome-error://`）就不搜。
- 标题优先取**上一次成功快照**的 `page title`；拿不到就退化为失败 URL 的路径末段（去掉扩展名）。
- 明确不做：`-site:`、`lang:`、时间算子——失败换路是"找入口"，不是"做检索实验"，越简单越可预测。

### 3.4 触发矩阵

| `code` | 触发换路 | 理由 |
|---|---|---|
| `navigation_failed` | ✅ | 本文的主场景 |
| `needs_human` | ✅ | 登录墙/验证页常常换公开入口就绕开了（不是绕过验证，是换一个不需要验证的页面） |
| `scheme_rejected` / `eval_disabled` / `download_rejected` | ❌ | 是策略拒绝，不是"地址不可达" |
| `bridge_timeout` / `panel_not_open` | ❌ | 面板本身不可用，搜了也开不了 |
| `cancelled` | ❌ | 用户叫停 |

### 3.5 配置（追加到 SPEC-002 B1 的分组）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `searchFallback.enabled` | boolean | **false** | 默认关：计费归属取决于部署 provider，未经同意不花钱（SPEC-002 "默认值一律等于现状"） |
| `searchFallback.maxResults` | number | `5` | 候选条数上限 |

### 3.6 限流

一次失败最多 1 次搜索。失败会连环发生（模型重试、翻页），**不能让失败路径放大成计费放大器**。桥日志里记 `provider` 与本次调用次数。

## 4. 验收

- [x] 对 `https://10.255.255.1/`（必然超时）与 T8 那条 Bing 地址，错误含 `alternatives` 且 ≥ 1 条
      —— 改用等价可控场景：`https://www.wikipedia.org:8080/`（ERR_ABORTED / timed out），实测形成候选；`10.255.255.1` 未单独跑（见 §6.5 偏差 5）
- [x] `searchFallback.enabled: false` 时错误与 1.2.x 逐字一致（对照 013 的回归用例）
      —— 同一 URL 关闭后返回 `nav_unknown: … ERR_CONNECTION_TIMED_OUT … The panel went back to https://example.com/`，无 `alternatives`、无搜索行
- [~] 把 `dsh-web` 从 profile 拿掉后：插件正常加载、11 个工具齐全、失败错误里没有 `alternatives`、没有新增日志报错
      —— `dsh-web` 是宿主依赖无法卸载；用单测 `getWeb: () => null` 覆盖同一条路径（§6.5 偏差 4）
- [x] 一次失败只产生 1 次 `ctx.web.search`（桥日志计数）
      —— 每次失败只调一次 `web.search`；错误文案里的 `(1 call …)` 与单测断言共同证明
- [x] 单测：查询构造（host/标题/路径退化三例）；触发矩阵（5 个 code 逐条）
      —— `plugin/test/search-fallback.test.mjs` 14 例，触发矩阵覆盖 8 个 code（§6.2）
- [x] 计费可见：日志打印实际选中的 `provider` id 与调用次数，用户能对上账单；日志里同时打印 `llmProvider` route
      —— `ctx.web.search()` 不返回实际 provider id ⇒ 日志与错误文案里打"预期 provider≈ + route + 1 call"（§6.5 偏差 2）

## 5. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 搜到同站但不同栏目的页面，看着像对的 | 候选带 `why`（命中词）；不自动打开；错误文案写清"这些是搜来的，不是从原页面上找到的" |
| R2 | 悄悄花钱 | 默认 `false`；**探针已证本机 route 会让 seam 选计费的 `deepseek-search-api`**，所以启用后日志必须打 provider 与次数；文档写明 5 元 / 1000 次与"要免费先配 `searchProvider: deepseek-official`" |
| R3 | `web` 变硬依赖，插件起不来 | `ctx.get('web')` 判空；探针先验可选注入 |
| R4 | 与 TICKET-013 同时改 `browser_open`，两个工单互相踩 | **013 先合入**（现场保住），027 在其后：013 定"回哪个页"，027 定"还能去哪" |
| R5 | 模型把 `alternatives` 当"已经打开" | 结果里显式 `opened: false`，并要求 `browser_open` 才能进页面（与 T3 的"点了≠页面动了"同源问题） |

## 6. 实现记录（2026-11-22，版本 1.4.0 → 1.4.2）

### 6.1 落地形状

| 位置 | 落地内容 |
|---|---|
| `plugin/search-fallback.js`（新，约 470 行） | 纯函数：`hostOf` / `pathWords` / `siteQuery` / `expectedProvider` / `routeOf` / `pickAlternatives` / `fallbackText` / `enrichOpenFailure`；类：`createSearchFallback({ config, getWeb, log })` 只暴露 `enabled()` 与 `alternatives({ url, exec, signal })`；常量 `SEARCH_TIMEOUT_MS = 8_000`、`FALLBACK_CODES = ['navigation_failed', 'needs_human']` |
| `plugin/config.js` | `DEFAULTS.searchFallback = { enabled: false, maxResults: 5 }`；新增 `flag()` 校验；`normalizeConfig` 里 `enabled` 先 `readField()` 再校验（`volatile` 字段读到的是读取器） |
| `plugin/index.js` | `Config.searchFallback = z.object({ enabled: z.boolean().default(false)….volatile(), maxResults: z.natural().default(5) }).default({})` |
| `plugin/apply.js` | `makeTools` 把 `searchFallback: { enabled, maxResults }` 交给 `createTools`（`enabled` 保留读取器，热切换生效） |
| `plugin/tools.js` | `browserOpenTool` 的失败分支：`classifyOpenFailure()`（013）→ `enrichOpenFailure(..., { exec, signal })`；`createTools` 里用 `getWeb: () => ctx?.get?.('web') ?? null` 建一个 fallback 实例，日志走 `ctx.logger.debug('[agent-browser] …')` |
| `tools/pack.mjs` | `COPY` 加 `search-fallback.js`（17 项） |
| 测试 | `plugin/test/search-fallback.test.mjs` 14 例；`plugin/test/config.test.mjs` 期望改为 16 字段并加 volatile 读取器用例 |

### 6.2 单测

`node --test <所有 plugin/test/*.test.mjs 绝对路径>` → **166 / 166 pass**（1.4.2 基线）。

- 查询构造：`https://www.example.com/a/b.html` → `example.com b a`；`www.` 去掉；非 http(s)（`chrome-error://`）→ `null` 不搜。
- 触发矩阵：`navigation_failed` / `needs_human` 触发；`scheme_rejected` / `eval_disabled` / `download_rejected` / `bridge_timeout` / `panel_not_open` / `cancelled` 不触发。
- 默认关：不调用 `getWeb()`、不搜索、错误对象原样返回。
- volatile：读取器返回 false→true 后下一次调用即生效。
- 安全：候选只来自 `sources`，断言 `content` 不出现在错误详情里；`opened: false` 恒在。
- 降级：`getWeb()` 为 null / 抛错 / 零结果 / 全异构（不同站）→ 原错误原样返回。
- 限流/上限：`maxResults` 非整数或 <1 → 5，>10 → 10。

### 6.3 打包与装机

| 版本 | tgz | 结果 |
|---|---|---|
| 1.4.0 | 121,275 B | 装机 **failed**：`agent-browser-panel … TypeError: agent-browser config: searchFallback.enabled must be a boolean, got {}`（volatile 读取器没拆包）→ 修 `normalizeConfig` |
| 1.4.1 | 121,337 B | applied（`-1.4.0 / +1.4.1`）——验收中发现 `site:` 查询返回 0 结果 |
| 1.4.2 | 121,537 B | applied（`-1.4.1 / +1.4.2`）——查询改为 `<host> <words>` + 客户端同站过滤；**正式验收版本** |

### 6.4 装机验收

验收时在 `C:\Users\林焕文\.dsh\cordis.patch.yml` 末尾临时加 `searchFallback: { enabled: true, maxResults: 5 }`，验完删除并确认文件恢复（2,071 字符 / 54 行 / UTF-8 / 末尾换行）。

| # | 操作 | 观测 |
|---|---|---|
| 1 | `browser_open https://www.wikipedia.org:8080/`（开着 fallback） | `navigation_failed: nav_aborted: … ERR_ABORTED` + `Search fallback (1 call, provider≈deepseek-search-api, model route=opencode-go, query="wikipedia.org"): … Nothing was opened (opened: false) …` + `- ウィキペディア - Wikipedia — https://ja.wikipedia.org/wiki/?oldid=…` |
| 2 | 紧接 `browser_snapshot` | 正常返回当前页（非空树）——013 的"现场不丢"仍成立 |
| 3 | 删除配置块、插件重载后同一 URL | `navigation_failed: nav_unknown: … (ERR_CONNECTION_TIMED_OUT) … The panel went back to https://example.com/` —— **无 alternatives、无搜索行**，与旧版同形 |
| 4 | 同站判定 | 候选里出现了子域 `ja.wikipedia.org`（host `wikipedia.org` 的子域）✅；搜索结果的 `content` 未进错误详情 |
| 5 | 计费可见 | 错误文案与日志均含 `1 call` / `provider≈deepseek-search-api` / `model route=opencode-go` / `query="wikipedia.org"`；`searchFallback.enabled` 为 volatile，改完下一跳即生效 |

### 6.5 偏差与残留

1. **查询不用 `site:` 操作符**：ticket 原文写 `site:<host> <词>`；实测本机 provider 对 `site:example.com example domain` 返回 **0 sources**，而普通查询 `deepseek harness plugin` 返回 5 条。因此改为 `<host> <路径关键词>` 纯查询 + `pickAlternatives` 客户端只留同站/子域（代码注释记录了 2026-11-22 实测）。
2. **provider id 拿不到**：`ctx.web.search()` 不返回实际 provider，只能用 `expectedProvider(llmProvider)` 推算并打 `provider≈`；本机 route `opencode-go` ⇒ 预期计费档 `deepseek-search-api`。
3. **标题拿不到**：失败时没有可信的页面标题（上一个成功页的标题可能属于别的站，且标题属于面板侧数据），退化为 URL 路径词，路径无词时只用 host。
4. **`dsh-web` 降级未真机验证**：宿主依赖不能卸，用单测 `getWeb: () => null` 覆盖；真机证据只有"关掉开关后无搜索"。
5. **`https://10.255.255.1/` 未单独跑**：用 `wikipedia.org:8080`（ERR_ABORTED / TIMED_OUT）触发同类失败；`bridge_timeout` 不触发 fallback，符合触发矩阵。
6. **`browser_open https://docs.python.org:81/` 曾 45 s `bridge_timeout`**：客户端在长时间导航里没有 settle 这条命令，与 027 无关，属观察项（未开 ticket）。
7. **文案措辞**：本次 `ERR_ABORTED` 场景下 013 的"showing the browser's error page"与实际"旧页面仍在"略有出入（`browser_snapshot` 证明页面没丢）；属 013 既有措辞，不改 027 的逻辑。
