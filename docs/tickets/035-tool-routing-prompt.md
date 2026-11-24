# TICKET-035 双后端 profile 下 Agent 不选 `browser_*`：把分流写进系统提示词

- 状态：🔧 已实现（1.4.16 注入 + 1.4.17 可观测 + 1.4.18 默认关、人工开启），行为侧**部分改善、未全胜**，最终以 `AGENTS.md` 的人写规则为主
- 优先级：P1（功能在双后端 profile 里等于不可用）
- 关联：`docs/design/web-tools-and-agent-browser.md` §10（对照实验 + §10.5 实现）、`docs/tickets/016`（配置面）、1.4.15（只改描述，未奏效）

## 1. 现象

同一提示词、两个子代理任务，在装着 `dsh-plugin-agent-browser` 与 `dsh-pilot` 的 profile 上各跑一轮，末尾让子代理自报 `TOOLS_USED`：

| 轮次 | A：公开静态文章 | B：登录墙站点 |
|---|---|---|
| 1.4.14（未改） | `web_fetch, web_fetch, pilot_navigate, pwsh, …` | `skill, pilot_navigate` |
| 1.4.15（描述已改） | `web_fetch, pilot_navigate, call_hermes, web_search` | `skill, pilot_navigate` |

两轮都没有出现任何 `browser_*`：**0/2 → 0/2**。B 组两次都先读 `browser-pilot` 技能、再调 `pilot_navigate`，被 origin policy 拒绝后直接收工。

## 2. 原因

不是描述写得不够清楚，而是**权重**：技能正文与用户 `AGENTS.md` 都写着"目标站点一律用 `pilot_*`"，它们排在工具描述之前。模型先撞上强指令，选了 `pilot_navigate`；被拒后宁可换 `web_search` / `call_hermes`，也不会回头找 `browser_*`。

## 3. 修法：往系统提示词里加一段路由说明

DSH 的 `systemPrompt` 服务让插件注册有序的 prompt 段落（`ctx.systemPrompt.section({ name, order, text })`），每步组装，权重高于工具描述。

- **段落名** `agent-browser-routing`，**order 3050**（在 `TOOL_COMPUTER_USE` 3000 与 `MCP_SERVERS` 3100 之间，跟其它工具指引放一起）。
- **正文**（`ROUTING_TEXT`，英文，与工具描述同一口径）：说明 `browser_*` 驱动的是右侧栏里那块 Electron 面板、页面对用户可见且可随时接管，因此"要用户的登录态 / 要 JS 或点击才出内容 / 要下载文件 / 要一张留作证据的截图"时用它；公开静态文章用 `web_fetch` 更便宜；`browser_open` 负责先把面板打开。
- **不点名别的插件**：双后端是运营者的安排，插件不该在提示词里编排别人；它只陈述自己提供什么。
- **配置 `routing`**：`off`（**默认**：由人决定开不开）/ `auto` / `on`，即时生效。
  - `auto` 只在**检测到另一套浏览器工具**时才加：工具名以 `pilot_` 开头，或出现面板版独有的 `browser_navigate` / `browser_act` / `browser_wait` / `browser_tabs` / `browser_close`。
  - 检测在**每次组装时**做（`ctx.tools.definitions()`），所以后加载的后端也能被看见；单后端 profile 保持零噪音。
- **宿主没有 `systemPrompt` 服务**时不抛错，只记一条日志，工具照常注册。

## 4. 验收

1. `plugin/test/routing.test.mjs` 6 条：auto+competitor 注入 / auto 单后端不注入 / 面板版名字也识别 / on 强制 / off 静默 / 未知值回落 auto / 无 prompt 服务不炸且工具照常注册 / 决策发布到 `/health` 且只在变化时发一次。✅ 6/6。
2. 全量单测 186/186。
3. **注入可查**：装机 1.4.17 后 `GET /dsh-agent-browser/health` 的 `diagnostics.routing` = `{"mode":"auto","injected":true,"order":3050,"competitors":["pilot_navigate","pilot_snapshot","pilot_act","pilot_wait","pilot_screenshot","pilot_close"]}`。✅
4. 行为复测：A（静态文章）在 1.4.16 后首次出现 `browser_open`（`web_fetch` 与 `pilot_navigate` 都失败时）；B（知乎登录墙）仍先选 `pilot_navigate` ⇒ **部分改善，未全胜**。技能正文与 `AGENTS.md` 的"一律用 `pilot_*`"仍压在段落之上。
5. `check-docs` 全绿（新增配置字段进用户 README 字段表与 YAML 示例）。

## 4.1 怎么查"到底注进去了没有"

不要拿子代理的工具选择当唯一证据——那分不清"没注入"和"注入了但被无视"。看 `/health`：

```bash
node tools/case-run/browser-health.mjs 127.0.0.1:<GUI 端口>
```

`diagnostics.routing.injected` 为 `true` 就说明段落已注册且这一次组装会带正文；`competitors` 写明是被谁触发的（本机是 `pilot_*` 六个）。桥日志里同名 `routing paragraph` 只在决策变化时出现一次，不会每步刷屏。

## 5. 注意

- 这段提示词解决的是"模型知道该用谁"，不解决"两套后端抢同一块面板"：一个 profile 只留一个浏览器后端仍是更干净的做法（README「已知限制」）。
- `routing: auto` 只看工具名，不看后端是否健康：`pilot` 的 CDP 端点没起时它照样算"competitor"，注入仍然正确——那段话本来讲的是分工，不是可用性。
