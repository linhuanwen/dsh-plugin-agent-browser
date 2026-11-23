# 决策 009：不新增搜索类工具，搜索引擎只当失败路径的 URL 解析器

> 状态：`已定`；其中"失败换路"部分尚未实现（`docs/tickets/027-search-fallback-navigation.md`，排 TICKET-013 之后）。
> 日期：2026-11-21 归档。
> 关联：`docs/design/web-tools-and-agent-browser.md`（SPEC-002 B11）、`docs/tickets/027-search-fallback-navigation.md`、`docs/spec/002` §B11 + U6/U7。

## 背景

内置 `web_search` / `web_fetch` 已经能匿名取公开网页文本；本插件能驱动一个带用户登录态的真浏览器。两者在"读一篇公开静态文章"上重叠，且**内置的更便宜**（一次 HTTP + 文本，不占 vision、不开面板）。于是有三个问题：

1. 要不要再写一个 `browser_search`？
2. 什么时候该用哪个工具？
3. 页面打不开（导航失败 / 撞人机验证）时，能不能用搜索引擎兜底？

## 决策

1. **不新增搜索类工具**。搜索能力归内置 `web_search`；插件不重复建设搜索 provider，也不自建 HTTP 去调搜索接口。
2. **分工写进用户文档与判据表**：`web_search(site:)` 找 → `web_fetch` 快读 → 读不到 / 要登录 / 要动手 / 要证据才 `browser_open`。
3. **搜索引擎只作为失败路径的 URL 解析器**：`navigation_failed` / `needs_human` 时，若配置开启（默认关）且同一次失败最多触发 1 次，用 `ctx.web.search` 给出同站候选（`alternatives[]`），**绝不自动打开**。**已于 2026-11-22 落地（TICKET-027，版本 1.4.2）**：查询用 `<host> <路径词>`（实测该 provider 不认 `site:`），客户端只留同站/子域，错误里显式 `opened: false`。

## 理由

1. 工具面对模型是稀缺资源（每个工具常驻 schema token）；再写一个搜索工具，收益是"少一次调用"，代价是常驻上下文与两套搜索结果格式不一致。
2. `ctx.web` 的 `search` 是宿主接缝，provider 由宿主决定；插件自建 HTTP 调搜索接口会绕过宿主的计费与配额（`/v1/tools/search` 有计费，见 `docs/design/web-tools-and-agent-browser.md`）。
3. "失败换路"是**低信任动作**：给候选链接可以，替用户点开不行——自动打开等于 agent 自己决定去哪个站，把可解释性丢了。

## 后果

- 用户/模型需要读判据表才知道何时开面板；这段文案已在 `docs/design/web-tools-and-agent-browser.md` §4 定稿，并已抄进用户 README（TICKET-025）。
- TICKET-027 的前置项（`docs/spec/002` 的 U6「host 侧工具能否拿到 `exec.agent.session.requestContext().provider`」、U7「`ctx.get('web')` 是否可用 / cordis 有没有可选注入」）**已于 2026-11-21 验完**：U6 能拿到（本机 `provider=opencode-go`），U7 `ctx.get('web')` 可用且 cordis **没有**可选注入（硬 inject 缺失服务 = 插件停在 `pending`、`apply()` 不执行）⇒ 接缝一律走 `ctx.get('web')` 判空，`inject` 不加 `'web'`。
- 但探针同时推翻了一个假设：拿到 route 不等于免费。`dsh-web` 只把 `deepseek-official`/`deepseek-account` 两条 route 偏好到免费 provider，**本机 `opencode-go` 会默认落到计费的 `deepseek-search-api`**。所以 `searchFallback` 保持默认关，且启用后必须记录 provider 与调用次数（详见 `docs/design/web-tools-and-agent-browser.md` §6.4，`docs/tickets/027` §3.1）。
- 失败换路已按本条决策上线（`searchFallback`，默认关、单次、不自动打开）；关掉时错误与旧版逐字一致，`web` 不可用时原样降级（`docs/tickets/027` §6.5 记录了四条实测偏差：`site:` 不可用、provider id 拿不到、标题拿不到、`dsh-web` 无法真机卸载）。
- 若将来宿主 `web` 接缝暴露"结果 URL 已验证"这类元数据，可以把失败换路从"给候选"升级成"给一个推荐 URL"，但仍不自动打开。
