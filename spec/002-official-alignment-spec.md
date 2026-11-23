# SPEC-002：官方对齐与发布硬化

- 状态：草案（待实现）
- 版本：v1（2026-11-20）；2026-11-21 增补 B11（与内置联网工具的分工）、U6/U7 与 M5 批次；2026-11-21 夜间 U6/U7 探针完成（结论见 §7 与 `docs/web-tools-and-agent-browser.md` §7）；2026-11-22 规格外修复 TICKET-029（1.3.7）与 TICKET-013（1.3.9）；2026-11-22 TICKET-027 落地（1.4.2）⇒ **M1–M5 全部完成、B1–B11 全部交付**（1.4.3 仅用户文档）；2026-11-22 §7 的 U1–U5 已逐条回填（U3 关闭为「不适用」）
- 关联清单：`docs/official-docs-review.md`（12 条改进的出处、官方原文与 file:line 证据）
- 关联决策：`docs/browser-use-contract.md`（不复用官方浏览器工具）、`docs/web-tools-and-agent-browser.md`（与内置联网工具的分工）、`decisions/001`–`004`
- 前置规格：`spec/001-agent-browser-plugin-spec.md`（产品范围与 A1–A19 不动，本规格只加约束）
- 目标运行环境：DeepSeek Harness 桌面端 `0.2.2-rc.3`（Windows / Electron），发布形态为单包 bundle
- 对照的官方页面：`develop/basic/{index,tool,config,publish}`、`develop/framework/{index,service}`、`develop/practice/`、`reference/cookbook/adding-a-tool`、`reference/capability-seams`

---

## 1. 目的

`docs/official-docs-review.md` 用官方文档当尺子量出了 12 条"官方明确要求而我们没做到 / 官方给了更好做法"的地方。本规格把它们**收成 11 个可交付项（B1–B11）**，定下"什么算做到"和"先做哪些"，使 1.1 版既满足官方对插件的基本要求，又能作为**对外发布**的包交付（用户目标：装给别人用）。

三条贯穿全篇的判断：

1. **默认值一律等于现状**——升级不改变任何现有行为，除了 §5 列出的两处显式兼容性变更。
2. **凡是"不同部署可能需要不同值"的参数，都必须能只改配置、不改代码**（官方 `config` 页的硬标准）。
3. **不猜 API**——涉及未验证接缝（客户端能否收到 entry config、桌面端 fetch 能否到达 `ctx.webServer` 路由）的项，先写探针，再定方案，探针结论回填本规格。

## 2. 非目标

| 不做 | 原因 |
|---|---|
| 换 CDP / 重写传输层 | 现架构（面板 webview + 桥 + 静态服务）已跑通 14 个版本，收益不抵风险；传输只在 B4 内做"最小改造" |
| 复用官方 browser-use / Playwright MCP 工具 | 见 `docs/browser-use-contract.md`：seam 只是互斥锁，工具由 MCP server 决定，面板会消失 |
| 按预设拆分 host 半边 | 官方 `practice` 明确"只有角色需要独立演进时才拆包"；单包三角色符合该口径（B10 记录该决定） |
| 让面板在 Web profile 可用 | 面板依赖 Electron `<webview>` 与 `dshDesktop.browser` 租约，属产品定义（B10 记录） |
| 新增浏览器能力（多标签、下载队列、cookie 导出…） | 本规格是"对齐与硬化"，不加功能面 |
| 自建搜索索引 / 把"找资料"做成插件能力 | 内置已有 `web_search` / `web_fetch`（`ctx.web` seam）；插件重复实现只会造成工具面竞争与计费不透明。分工见 `docs/web-tools-and-agent-browser.md`，约束见 B11 |

## 3. 术语

| 词 | 含义 |
|---|---|
| 配置行 | profile `cordis.patch.yml` 里 `- insert: [{ id: agent-browser-panel, name: 'dsh-plugin-agent-browser' }]` 这一条；字段是 `config` 下的键 |
| volatile 字段 | schemastery `.volatile()` 修饰的字段：值是被解析成稳定引用的读取器，用 `.get()` 读；改动**不重启插件**（`@deepseek-ai/schemastery` README:393、loader `equalExceptVolatile`） |
| 接缝（seam） | 官方 `capability-seams` 的说法：ctx 上**声明**的能力（如 `ctx.browserUse`、`ctx.web`）与**消费**它的插件之间的契约 |
| 工具面 | 一次请求里发给模型的工具定义总量（当前 11 个、10,196 字符 ≈ 3.2k tokens） |

## 4. 要求

### B1 配置面：所有部署相关参数都是配置字段（P0）

官方 `config` 页的检验标准：**"能否在 `cordis.yml` 里改变这个值，而不需要修改代码？"**

现状全部硬编码：

| 参数 | 位置 | 现在的值 |
|---|---|---|
| 桥端口 | `plugin/bridge.js:19`（`BRIDGE_PORT`）、`plugin/client.js:40`（`BRIDGE_URL`） | `8792` |
| 桥请求超时 | `plugin/bridge.js:25`（`DEFAULT_TIMEOUT_MS`） | `20_000` |
| 导航超时 | `plugin/tools.js:145` | `45_000` |
| 快照字符预算 | `plugin/tools.js:257` | `8000` |
| eval 字符预算 | `plugin/tools.js:986` | `8000` |
| 下载上限 | `plugin/downloads.js:22`（`MAX_BYTES`） | `50 MiB` |
| 下载目录 | `plugin/downloads.js:31`（`DOWNLOADS_DIR`） | `downloads` |
| 静态服务单文件上限 | `plugin/static.js:18`（`MAX_BYTES`） | `32 MiB` |

要求：

1. 上述全部成为 `Config` 字段（分组：`bridge` / `limits` / `downloads` / `static`），每个字段带 `.description()`，默认值 = 上表。
2. **必须 volatile 的**：`activation`、`fitWidth`、`evalEnabled`、`claimBrowserUse`——它们要能边用边切而不重启插件（重启 = 桥断开 + webview 重建，用户会看到面板闪一下）。
3. 非 volatile 的就地生效不了，必须在文档里写清"改这些要重载插件"。
4. 顺带修一处真 bug：`plugin/index.js:82` 调 `createTools(ctx, bridge, sites, activation)` 少传第五个参数，`plugin/tools.js:1502` 的 `fitWidth` 永远是 `undefined` ⇒ **`fitWidth: false` 目前不生效**。

### B2 生命周期：一个 effect、一套有序清理（P0）

官方 `framework` 页：多个异步处置器**并发**执行，依赖顺序的清理必须放进同一个 `ctx.effect()`。

现状 13 个独立 effect：`plugin/index.js:72`（桥）、`:78`（静态服务）、`:83`（每个工具一个）。卸载时可能"静态服务已关、工具仍在调""桥已断、工具在等 20s 超时"。

要求：合并为一个 `ctx.effect`，dispose 时按 **先摘工具 → 关桥 → 关静态服务** 的顺序串联，且任一环节抛错不得跳过后续环节。

### B3 包元数据：可安装、可诊断、可发布（P0）

官方 `publish` 页要求：用 `engines.dsh` 声明 DSH 兼容范围；dsh 包在 host 依赖里同时出现在 `peerDependencies` 与 `devDependencies`。

现状（`dist/dsh-plugin-agent-browser/package.json`，1.0.39）：无 `engines`、无 `devDependencies`、`peerDependencies` 是 `"*"`、`private: true`。

要求：

1. `engines.dsh` 给出真实范围（与本机 `0.2.2-rc.3` 实测通过）。
2. `@deepseek-ai/schemastery` 同时进 peer 与 dev，peer 范围收窄到真实兼容区间。
3. 去掉 `private: true`（发布需要），补齐 `license` / `files`。
4. 元数据变更不得改变安装方式（`plugin_manager install_bundle` 照旧）。

### B4 传输与鉴权：不再硬编码 8792、不再只认 Origin（P0）

现状：`plugin/bridge.js:367-372` 只校验 `Origin`，本机任意进程伪造一个头就能驱动面板（用用户已登录的 Cookie 点任意按钮）；`plugin/bridge.js:19` 与 `plugin/client.js:40` 两处硬编码 8792，第二个实例或被占用时 bind 失败 + 20s 超时，客户端还可能连到**另一个实例**的桥。

要求：

1. 先做探针，回答两个问题（结论回填本规格 §7）：
   - 我们的 client 插件 `apply(ctx, config)` 是否收到该 Loader 条目的 `config`？
   - 桌面渲染进程的 `fetch` 能否到达插件用 `ctx.webServer.register(route)` 注册的同源路由？
2. 按探针结论选方案（优先级从上到下）：
   - **A**：同源路由（`ctx.webServer.register`）+ DSH 自带浏览器认证，彻底删掉 8792 桥；
   - **B**：保留桥，端口由 host 随机、经 config 下发到 client（探针 1 为真时适用），每次进程启动生成随机 token，桥校验 `x-…-token`；
   - **C**：A/B 均不可行时的兜底——维持 8792，但把"本机任意进程可驱动面板"写进发布文档的已知风险，并在下一版重审。
3. 无论哪个方案，**多实例不串台**是验收硬条件：第二个 DSH 实例起来时，不得把命令投递到第一个实例的面板。

### B5 结构化错误：稳定的 code，而不是给人看的句子（P1）

官方 cookbook：预期失败抛带 `code` 的 `HarnessError` 子类。

现状：`plugin/tools.js` 里 `taken_over: …` / `needs_human: …` 等全是 `new Error('前缀: 文案')`，程序侧只能字符串匹配。

要求：定义 `AgentBrowserError`，携带 `{ code, details, retryable }`；code 至少覆盖 `panel_not_open`、`panel_taken_over`、`needs_human`、`bridge_timeout`、`bridge_closed`、`unauthorized`、`scheme_rejected`、`eval_disabled`、`navigation_failed`、`download_rejected`、`cancelled`、`budget_exceeded`（完整码表见 `tickets/020-structured-errors.md` §2.2）。人读文案保留，但程序判定只看 `code`。

> **实现期修正（2026-11-21，TICKET-020）**：官方 cookbook 的 `AgentBrowserError extends HarnessError`（从 `@deepseek-ai/dsh-llm` 导入）对**外部插件不成立**——宿主跑在 `app.asar` 里，插件按裸包名解析到的是 Node 全局目录中另一份 DSH（实测 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\...`，另一个模块实例），子类化它过不了宿主 `dsh-tools` 的 `instanceof` 检查，`@deepseek-ai/dsh-error` 更是解析不到。最终用**本地同形基类**（`name`/`code`/`cause` 形状一致），`HARNESS_ERROR_BASE = 'local'`；`error.info` 恒为空是已知偏差，code 通过 message（`Error: <code>: <text>`）被模型读到。取证与偏差记录见 `tickets/020-structured-errors.md` §6.2。

### B6 取消：尊重 `exec.signal`（P1）

官方 cookbook：取消时中止在飞工作，别吞成普通错误。

现状：11 个工具里只有 `plugin/tools.js:351` 一处转了 `exec.signal`；`bridge.request` 只有固定超时，用户点"停止"之后，已经投递的点击仍会执行。

要求：

1. 每个工具的 `execute/run` 把 `exec.signal` 传进 `bridge.request`。
2. 桥支持"投递前取消"：命令还在队列里就移除；已投递的命令回 `cancelled` 并说明**动作可能已经发生**（诚实优先，不假装撤销）。
3. 取消与超时区分：`code: 'cancelled'` vs `code: 'bridge_timeout'`。

### B7 工具定义：锁定宿主契约（P1）

官方 cookbook：`defineTool` 提供参数自动校验、`output.schema` + `render` 分离"规范值"与"模型看到的文本"，PTC 才能拿到结构化返回值。

要求（见 TICKET-022）：

1. 每个工具定义都满足宿主 `register()` 的硬要求：`output: { schema, render, presentationMeta? }`；参数与输出 schema 都落在宿主受支持子集内（`type`/`oneOf`/`properties`/`required`/`additionalProperties`/`items`/`enum`/`const` + `description`/`title`/`default`/`examples`）。
2. 数值范围（如 `maxChars`）**不写** `minimum`/`maximum`：范围写进 `description`，工具体用 `clampBudget()` 夹取。
3. 结构化错误穿过工具内部分支不得丢失 `code`（如 `browser_screenshot` 的步骤包装）。
4. 以上三条用不依赖 Electron 的契约测试钉住。
5. 不改变工具名、参数名与默认值（模型侧契约不动）。

> **实现期修正（2026-11-21，`1.2.5`）**：原要求"11 个工具改用 `defineTool`、补 `output.schema`"的前提经复核**不成立**——11 个工具早已有 `output: { schema, render }` 与 `presentCall`/`presentResult`（如 `plugin/tools.js:183`）。`defineTool` 只是工厂函数，import 它会引入"插件解析到另一份 DSH"的隐性依赖（证据见 `tickets/020-structured-errors.md` §6.2），收益为零。故 B7 收窄为"契约锁定 + 子集清理 + 截图错误收口"，`presentationMeta` 随 B8（TICKET-023）落地。实现记录见 `tickets/022-define-tool-migration.md` §6。

### B8 会话内呈现：Web 卡片走 client slot（P2）

官方 cookbook：内置 Web Client **不消费** `presentCall` / `presentResult`；要卡片必须在 client 插件里注册以工具名为键的 `tool.call.toolview` 条目（参考 `@deepseek-ai/dsh-client-ui-action-cards`）。

现状：我们已有 22 处 `presentCall`/`presentResult`（`plugin/tools.js:166/169/295/298/604/608/698/702/791/795/858/861/927/930/1003/1006/1145/1148/1389/1392/1479/1483`），但 Web 里不生效：`browser_screenshot` 的结果在对话里只是一行路径。

要求：至少给 `browser_screenshot` / `browser_open` / `browser_download` 三个加 keyed slot 卡片（截图内联、打开结果给标题 + URL、下载给文件名 + 大小），并在桌面 Web 视图里实测；`presentCall`/`presentResult` 保留（别的客户端可能消费），但**不再指望它们出图**。

> **实现期修正（2026-11-21，`1.3.0`）**：要求落地为——宿主侧三工具各补 `output.presentationMeta`（截图额外带 `thumb` 附件 ref），客户端 `plugin/client.js` 注册三个 `tool.call.toolview` 条目（`CLIENT_REV` 31 起），图片走**附件通道** `ctx.attachments.saveImage` + `props.loadImage`，不用静态 token URL（重启后 token 会变，历史卡片会烂链）。截图卡片点击走 `openFile(path)` 打开原文件。视觉确认仍需用户目视；卡片数据已落盘证据见 `tickets/023-web-tool-cards.md` §6.3。验收期另发现截图取帧依赖面板可见 → `tickets/028-screenshot-capture-visibility.md`（`1.3.4` 修复）。

### B9 策略接缝：把"该不该做"从工具里拿出来（P2）

官方 cookbook：策略用 `tools/pre-execute` 或 `ctx.tools.guard()`，不要内建在工具实现里。

现状：eval 开关、下载扩展名、导航白名单都写在工具体内；eval 目前没有任何开关。

要求：`ctx.tools.guard()` 接入三类策略——`evalDisabled`、`downloadBlocked(ext)`、`navigationBlocked(scheme)`——策略读配置（B1），错误走 B5 的 `code`。工具实现只做"怎么做"，不做"能不能做"。

> **实现期修正（2026-11-21，`1.3.5`）**：落地为独立模块 `plugin/policy.js`（`createPolicy()` → `checkOpen` / `checkEval` / `checkDownload` / `clampChars` / `checkSession` / `guard`），工具体与 `ctx.tools.guard()` 共用同一策略实例；guard 是**进程级全局拦截器**，因此按 `exec.name` 只拦本插件 11 个工具（`BROWSER_TOOL_NAMES`）。三类策略之外补了第四条"会话名单"（`sessions.allowlist`，错误码 `session_not_allowed`，码表 13）；未做 `policySources` 第三层（宿主暂无组织策略来源）。实现记录与装机验收见 `tickets/024-policy-guards.md` §6。

### B10 文档与认知：把决定写下来（P2）

三条已经在 `docs/official-docs-review.md` 里论证、但没有落进用户文档的结论：

1. **patch 是整行替换**，不是深合并（官方 `publish` 原文）。用户改配置时若只写半行 `config`，其余字段会回到默认——必须写进安装文档。
2. **不预防性拆分**（官方 `practice` 原文）。单包三角色（host / client / 资源）符合口径，分拆的触发条件是"角色需要独立演进"。
3. **桌面限定**属产品定义：面板依赖 `<webview>` 与 `dshDesktop.browser` 租约，Web profile 不支持，文档明说而不是让用户撞墙。

要求：更新用户文档（`dist/dsh-plugin-agent-browser/README.md` 与包内 `docs/DETAIL.md`），并在本规格 §7 记录 `ctx.browserUse` 无 consumer 这条 seam 证据的引用位置。

> **实现期修正（2026-11-21，`1.3.6`）**：三条结论落进用户文档五节（环境要求 / 安装升级卸载 / 配置 / 该用哪个工具 / 故障排查），patch 整行替换用红字 + 全量模板 YAML 呈现；同时新增 `decisions/005`–`009` 五条 ADR 与 `decisions/README.md` 索引，把"为什么 loopback 不走 CDP / 为什么不复用 browser-use / 为什么不拆包 / 为什么动态端口+令牌 / 为什么不新增搜索工具"写死。另加 `tools/check-docs.mjs`（六项一致性检查）+ `tools/check-docs-negative.mjs`（5/5 负向自检）；因仓库无 CI，脚本用手动跑并在 README 开发循环标注（偏差见 `tickets/025-docs-and-decisions.md` §6.3）。**桌面限定的"Web profile 实测"仍未做**（本机只有 Desktop profile），文档措辞按代码路径写、标为待验。

### B11 与内置联网工具的分工：不抢"发现"，只管"动手"（P2）

`docs/web-tools-and-agent-browser.md` 的结论：内置 `web_search` / `web_fetch`（`ctx.web` seam）与插件是三层分工，只在"读一篇公开静态文章"这一小块重叠，而那块上内置更优。插件唯一的增量价值是**身份**（用户本人的登录态）、**动手**（完整输入栈）、**证据**（截图 / 原件 / sha256）。

要求：

1. **不新增搜索类工具**（`browser_find` 之类）：工具面已有 11 个 `browser_*` + 内置 `web_search` / `web_fetch`（约 3.2k tokens），第三个搜索工具只会降低模型命中率。
2. **把链路写进模型看得到的地方**：`browser_open` 的 description 与用户文档写清 `web_search(site:)` 找 → `web_fetch` 快读 → 读不到 / 要登录 / 要动手才 `browser_open`。现成文案见该文档 §4。
3. **将来做失败换路（`tickets/027`）时**：只允许走 `ctx.web.search`，**不得**自己拼 HTTP 调 `/v1/tools/search`——那会绕过部署的 provider 选择、`searchReady` 准入检查与计费归属（落地 `deepseek-search-api` 是 5 元 / 1000 次成功请求，落到服务端 provider 免费）。
4. **`web` 不得成为硬依赖**：profile 里没加载 `dsh-web` 时插件仍要正常加载并降级（`ctx.get('web')` 判空，同 `docs/browser-use-contract.md` §4 对 `browserUse` 的做法），且接入前必须先回答 §7 的 U6 / U7。

为什么是 P2：不改变任何现有行为，是"减少无效开面板"的卫生项；真正加能力的换路排在 021–025 之后。

> **实现期修正（2026-11-21，`1.3.6`）**：第 1 条与第 2 条已落地——工具面仍是 11 个 `browser_*`（`check-docs` 的"工具 11 个"检查会拦住新增）；用户文档新增「该用哪个工具」判据表，`browser_open` 描述仍保留"公开静态页先试 `web_fetch`"。
>
> **实现期修正（2026-11-22，`1.4.2`）**：第 3/4 条已落地（`tickets/027`）——①`browser_open` 的 `navigation_failed` / `needs_human` 失败路径可用 `ctx.web.search` 附同站候选（`searchFallback.enabled` 默认 **false**，开启后一次失败最多 1 次搜索，绝不自动打开，候选显式 `opened: false`）；②`web` 未加载或 `searchReady()` 为 false 时完全退化为旧错误，不新增错误码、不让插件变硬依赖。查询未用 `site:`（实测该 provider 返回 0 条），改为 `<host> <路径词>` 由客户端过滤同站。第四条约束（默认关）另有实现期发现：本机 route 会选计费 provider，故默认关的约束更硬。

## 5. 兼容性

| 变更 | 影响 | 处理 |
|---|---|---|
| `Config` 新增分组字段 | 现有配置行不受影响（缺省取默认） | 默认值 = 现状；`cordis.patch.yml` 里只写 `config: { activation: manual }` 仍然有效 |
| `fitWidth` 真正生效 | 之前设 `fitWidth: false` 的用户会发现"页面确实不缩了"（修复） | 记入 changelog 的 Fixed |
| 桥鉴权（B4） | 若走方案 A，`plugin/client.js` 的 `BRIDGE_URL` 常量删除；若走 B，端口与 token 由 host 下发 | 跨版本不保证混用；插件 host/client 同包发布，天然一致 |
| 工具面（B7） | 工具名/参数不变，返回值变为结构化对象 | PTC 调用方从"解析文本"改为"读字段"；旧文本仍由 `render` 提供 |

版本建议：B1–B4 落 **1.1.0**；B5–B7 落 **1.2.0**；B8–B11 随 1.3.0 或补丁版。

## 6. 批次与顺序

| 批次 | 内容 | 预估 | 出口条件 |
|---|---|---|---|
| M1 | B1 → B2 → B3 | 1.5 天 | `cordis.yml` 改 8 个参数全部生效；卸载无连接残留；包元数据通过 `plugin_manager` 安装 |
| M2 | B4（探针 → 方案 → 实现） | 1–2 天 | 第二实例不串台；伪造 Origin 不再够用（A：无桥；B：缺 token 401） |
| M3 | B5 → B6 → B7（第一批） | 1.5 天 | 程序侧只读 `code`；`exec.signal` 覆盖全部工具；3 个工具走 `defineTool` |
| M4 | B7（第二批）→ B8 → B9 → B10 → B11 | 1 天 | Web 里能看到截图卡片；策略可经配置关闭；文档三条结论 + 联网工具分工落盘（B11 只要求第 1/2 条，第 3/4 条随 `tickets/027`）——✅ 2026-11-21 完成（1.3.6） |
| M5 | U6/U7 探针（✅ 2026-11-21 完成）→ `tickets/013`（✅ 2026-11-22，1.3.9）→ B11 第 3/4 条（✅ 2026-11-22，`tickets/027` → 1.4.2） | 1 天 | 探针两条有明确结论（U6 能拿到 route、U7 无可选注入只能 `ctx.get`；**本机 route 默认选计费 provider**）；换路默认关、不自动打开、一次失败只搜一次、日志记 provider 与次数；关掉后错误与 1.2.x 一致 |

顺序的理由：B1 是所有后续配置项的地基；B2 是"改错了能干净卸载"的保障，必须在频繁改动的 M2 之前；B4 的探针结论影响 B1 中 `bridge` 字段的最终形状（方案 A 会删掉端口字段），所以 B4 的探针排在最前面、实现排在 B1/B2 之后。

## 7. 未验证与待决策

| # | 问题 | 为什么卡住 | 结论（2026-11-22 回填） |
|---|---|---|---|
| U1 | client `apply(ctx, config)` 能否收到 entry config | 决定 B4 走 A 还是 B；也决定 `activation` 等 volatile 字段能不能在面板侧读到 | ✅ **已验（2026-11-21，TICKET-019 §5.1）：不能**。`dsh-client-modules/src/client/entries.ts` 的 `create(loader, id)` 只传 `{ name: id }`；`manifest.ts` 的 `BootPluginRow` 只有 `{ id, inject, immediately }` ⇒ B4 走 B2（宿主发现路由下发地址与令牌）；面板侧不读 entry config，volatile 字段只影响 host 半边 |
| U2 | 桌面渲染进程 fetch 能否到达 `ctx.webServer.register` 的路由 | 官方 README 说 Electron 用 `file://` 加载 dist、经 IPC 桥接 fetch；能否命中同源路由未验 | ✅ **已验（2026-11-21，TICKET-019 §5.1）：能**。`lib/main.js:20791-20803` 的 `protocol.handle("dsh-app", …)` 对非静态路径调 `forwardWebRequest`（`:15348-15382`）：转发到宿主 origin、删掉原 cookie 并注入宿主认证 cookie ⇒ 渲染进程向 `/agent-browser/discovery` 发 fetch 会命中宿主路由；实测无 cookie → **401 而非 404** |
| U3 | `defineTool` 的 `output.render` 对 PTC 调用的实际返回形状 | 影响 B7 第二批与既有 22 处 presenter 的存废 | ⊘ **关闭（2026-11-22，不适用）**：B7 已收窄为「契约锁定、不迁 `defineTool`」（`tickets/022` §2：`defineTool` 只是参数语法糖 + 转换工厂，import 它要依赖 `%APPDATA%/npm` 下**另一份 DSH**，对分发不利）⇒ 本问题不再影响交付。PTC 侧可序列化性由 `plugin/test/tooldefs.test.mjs` 的 lossless JSON 检查覆盖；**PTC 端到端仍未实测**，列入发布说明的已知限制 |
| U4 | volatile 字段在插件界面的 configEditor 下改动的重启行为 | 官方文档说 volatile 就地更新，但我们的 `activation` 还牵动 gate 闭包 | ✅ **已验（2026-11-21，TICKET-016 §6.4）**：profile patch 改 `fitWidth`/`evalEnabled`（volatile）→ 插件不重载，`/health` 的 `enqueued/pulled` 计数 `7/7 → 9/9` 继续增长，下一跳命令即生效；改 `limits.snapshotMaxChars`（普通字段）→ 插件热替换、计数清零、桥重启。`activation` 档位由 `createGate` 每命令重读（`policy.test.mjs` 3 例） |
| U5 | 已投递动作的"不可撤销"语义 | 决定 B6 的错误文案与 `code` | ✅ **已验（2026-11-21，TICKET-021 §6）**：`cancelled` 文案明说 nothing already sent to the page can be undone，与 `bridge_timeout`/`bridge_closed` 三码可区分；队列侧可摘除、已投递命令迟到回包被 `ignored: true` 吸收。GUI 里由人按停止的一步仍留用户手测（`tickets/021` §6.5） |
| U6 | host 侧工具（经桥异步执行）能否拿到 `exec.agent?.session.requestContext()?.provider` | 决定 `ctx.web.search` 落到免费的服务端 provider 还是计费的 `deepseek-search-api`（B11 第 3 条） | ✅ **已验（2026-11-21）：能拿到**。运行时探针挂在 `tools/result`，`browser_open` 触发后读到 `provider=opencode-go`、`model=deepseek-v4.1-flash`、`contextWindow=1000000`。**但路由不等于免费**：`dsh-web` 的 `DEEPSEEK_MODEL_ROUTES` 只含 `deepseek-official`/`deepseek-account`，本机 route 不在其中 ⇒ 无论传不传 `llmProvider`，seam 默认选**计费**的 `deepseek-search-api`（详见 `docs/web-tools-and-agent-browser.md` §6.4） |
| U7 | 当前 desktop profile 是否加载 `dsh-web`；cordis 可选注入的确切写法 | 硬 inject 会让插件在没装 `dsh-web` 时**起不来**（11 个工具一起消失） | ✅ **已验（2026-11-21）**：①`ctx.get('web')` 在 `inject:['tools']` 下可用（seam 暴露 `search/fetch/searchReady/fetchReady/listProviders`，两条 provider 均在）；②cordis **没有可选注入**（`Inject = (keyof M)[] | { [K]?: M[K] }` 且 `Fiber._refresh()` 任一注入缺失即 epoch=INACTIVE → 卸载 → `pending`）；③对照实验：`inject:['tools','definitely-not-a-service']` 的插件 `apply()` 从未执行、`fiberPhase:"pending"`、宿主不受影响 ⇒ 接缝只能 `ctx.get('web')` 判空，**不得**把 `'web'` 加进 `inject` |

## 8. 验收标准

- [ ] B1 改配置不改代码：8 个参数逐一在 `cordis.patch.yml` 改动并生效；`fitWidth: false` 真的不缩；volatile 字段改动**不**触发"host half applied"重载日志
- [ ] B2 卸载干净：卸载插件后桥端口释放、静态服务端口释放、无 `ECONNRESET` 日志、无 20s 卡顿
- [ ] B3 包可发布：`engines.dsh` 存在且范围正确；peer + dev 双声明；`npm pack` 产物可 `plugin_manager install_bundle` 装上并激活
- [ ] B4 不串台：同时开两个 DSH 实例，第二个实例的工具调用只影响自己的面板；伪造 Origin 的请求失败（A：404/无路由；B：401）
- [ ] B5 只读 code：`browser_click` 在接管态返回 `code: 'panel_taken_over'`；下载被拦返回 `code: 'download_rejected'`；取消返回 `cancelled` 且与 `bridge_timeout` 可区分（2026-11-21：11 个 code 与 message 前缀已落地并装机验证 `scheme_rejected` / `panel_not_open`，见 `tickets/020-structured-errors.md` §6.4；接管态与取消两条待 B6/B9 后联测）
- [ ] B6 取消生效：长任务中点停止，队列中命令被移除；已投递命令回 `cancelled` 且文案说明可能已发生（2026-11-21：`1.2.4` 落地，队列侧与装机探针全绿——排队命令被摘除只留 `cancel` 控制帧、已投递命令迟到回包被 `ignored` 吸收、三码分区分明；GUI 里由人按停止一步见 `tickets/021-cancellation.md` §6.5 三步手测）
- [ ] B7 契约锁定：11 个工具定义满足 `register()` 硬要求、参数与输出 schema 在宿主受支持子集内、数值范围走 `clampBudget()`、截图步骤不丢结构化 `code`（2026-11-21：`1.2.5` 落地 `plugin/test/tooldefs.test.mjs` 7 例并装机验收，见 `tickets/022-define-tool-migration.md` §6；PTC 侧"直接读字段"的端到端验证仍随 U3 待做）
- [ ] B8 卡片可见：Web 视图里 `browser_screenshot` 显示图片而不是一行路径；桌面视图同样可见（2026-11-21：`1.3.0` 落地三个 `tool.call.toolview` 条目 + `presentationMeta`。**数据侧已证**：会话记录里的工具结果带 `meta.thumb.attachmentId`（`tickets/023-web-tool-cards.md` §6.3）；**视觉侧待用户目视确认**（代理看不到 DSH 窗口内部）。同票验收期发现取帧依赖面板可见 → `tickets/028-screenshot-capture-visibility.md`（`1.3.4`））
- [x] B9 策略外置：配置关掉 eval 后 `browser_eval` 返回 `eval_disabled`；下载扩展名被拦并给出可读原因（2026-11-21：`1.3.5` 装机验收——profile 层 `evalEnabled: false` → `eval_disabled`；`extraBlockedExtensions: [dat]` → `download_rejected`（stage policy）；`sessions.allowlist` → `session_not_allowed` 且工具体未执行；移除配置后三项全部恢复默认。见 `tickets/024-policy-guards.md` §6.4）
- [x] B10 文档三条结论可见：安装文档写清 patch 整行替换、桌面限定、不拆分理由（2026-11-21：`1.3.6` 装机验收——用户 README 五节（红字整行替换警告 + 14 字段表 + 全量模板 YAML + 13 行故障排查）、`decisions/005`–`009` 五条 ADR + 索引、`tools/check-docs.mjs` 六项检查全绿、`tools/check-docs-negative.mjs` 5/5 负向自检。**Web profile 实测仍未做**，见 `tickets/025-docs-and-decisions.md` §6.3）
- [x] B11 分工落盘且不越界：第 1/2 条已落地（工具 11 个未新增搜索类工具、`browser_open` 描述保留"公开静态页先试 `web_fetch`"、用户 README 有 7 行判据表、`docs/web-tools-and-agent-browser.md` 被双处引用，`check-docs` 会持续校验）；第 3/4 条已落地（`1.4.2`，`tickets/027`）：失败换路默认关、附同站候选、`opened: false`、`web` 缺失时原样降级（单测 `getWeb: () => null` 覆盖），实测证据见 ticket §6.3/§6.4。

## 9. 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | U1 为假（客户端收不到 config），且 U2 也为假 | B4 只能走 C，安全短板留在发布版 | 提前披露；把 token 方案降级为"同进程文件交换"的后续调研项 |
| R2 | `defineTool` 重写引入行为漂移 | 11 个工具是产品命脉 | 分批 + 逐工具对拍既有单测；工具名/参数不变 |
| R3 | volatile 字段与现有闭包设计冲突 | 改 `activation` 时要重建 gate | gate 内每次读 `.get()`，不在 `apply` 时快照 |
| R4 | 合并 effect 后卸载顺序写错 | 比现状更糟（工具挂在已关闭的桥上） | 单测断言 dispose 顺序（用假 bridge 记录调用序列） |
| R5 | 发布后用户把 token/端口配错 | 插件起不来 | 非法值由 schemastery 在**加载期**拒绝（loader 显示 schema 错误，插件不会带着错值启动——不做"静默回落"，那会让人以为配置生效了）；运行期只防"合法但极端"：端口被占时重试 3 次（100 ms 间隔），仍失败退回 `listen(0)` 并打 warn |
| R6 | B11 把 `web` 写成硬依赖 | 用户 profile 没装 `dsh-web` 时**整个插件起不来**（比"搜索不可用"糟得多） | `ctx.get('web')` 判空降级；搜索相关能力缺席时只退化为"没有换路"，不报错、不拦工具 |
| R7 | 失败换路悄悄产生费用 | 用户看到账单不知从哪来 | 换路只在失败路径触发；用户文档写明按 provider 计费（5 元 / 1000 次）；`tickets/027` 验收要求一次失败场景的调用次数可数 |

## 10. 与 SPEC-001 的关系

`spec/001` 定义"插件是什么、有哪些工具、验收 A1–A19"；本规格定义"这些实现要满足哪些工程约束、发布前必须补齐什么"。两者不冲突：B1–B11 全部是**实现方式**的约束，不改任何 A 项的产品行为。若某条 B 项与 A 项冲突（例如 B4 方案 A 要删掉桥），以 A 项的产品行为为准，改实现路径而不是改验收。

## 11. 关联 ticket

| 要求 | ticket | 批次 | 版本 |
|---|---|---|---|
| B1 配置面 | `tickets/016-config-surface.md` | M1 | 1.1.0 |
| B2 生命周期 | `tickets/017-lifecycle-single-effect.md` | M1 | 1.1.0 |
| B3 包元数据 | `tickets/018-package-metadata.md` | M1 | 1.1.0 |
| B4 传输与鉴权 | `tickets/019-bridge-auth-and-discovery.md`（+ `tickets/029` 注册竞态补丁） | M2 | 1.2.1 / 1.3.7 |
| B5 结构化错误 | `tickets/020-structured-errors.md` | M3 | 1.2.3 |
| B6 取消 | `tickets/021-cancellation.md` | M3 | 1.2.4 |
| B7 工具契约锁定 | `tickets/022-define-tool-migration.md` | M3 | 1.2.5 |
| B8 过程卡片 | `tickets/023-web-tool-cards.md` | M4 | 1.3.0 |
| B9 策略接缝 | `tickets/024-policy-guards.md` | M4 | 1.3.5 |
| B10 文档与决策 | `tickets/025-docs-and-decisions.md` | M4 | 1.3.6 |
| B11 联网工具分工 | `tickets/025-docs-and-decisions.md`（第 1/2 条）+ `tickets/027-search-fallback-navigation.md`（第 3/4 条） | M4 / M5 | 1.3.6 / 1.4.2 |

**已实现（2026-11-21）**：B1–B3 → `1.1.1`，B4 → `1.2.1`（含 TICKET-026 修复），B5 → `1.2.3`，B6 → `1.2.4`，B7 → `1.2.5`（收窄为契约锁定，见 B7 实现期修正），B8 → `1.3.0`（另 `1.3.4` 随 TICKET-028 修截图取帧），B9 → `1.3.5`（策略接缝，含会话名单第四条策略），B10 → `1.3.6`（用户文档五节 + 五条 ADR + 文档一致性检查），B11 第 1/2 条 → `1.3.6`。每张 ticket 的 §6 是实现记录；M4 已全部完成。

**已实现（2026-11-22）**：B11 第 3/4 条 → `tickets/027`，`1.4.2` 装机验收（`1.4.3` 仅用户文档）⇒ **M5 完成，B1–B11 全部交付**。

**规格外修复（2026-11-22）**：`tickets/029`（发现路由注册竞态——apply 早于 `webServer` 时路由漏注册，表现是 `fiberPhase: active` 但所有工具 `bridge_timeout`；改为等 `webServer` 出现再注册 + 每请求解析 `connection`）→ `1.3.7`；`tickets/013`（失败导航回退——面板回上一页、错误带 `nav_*` stage、错误页拒绝空树）→ `1.3.9`（首版 1.3.8 装机即暴露 `<webview>.getURL()` 非字符串，1.3.9 加 `Guest.address()` 修正）。M5 的 B11 第 3/4 条随后由 `tickets/027` 完成（见上一段）。
