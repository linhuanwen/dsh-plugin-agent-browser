# 硬化验证案例集（H1–H8）· 1.4.x 能力回归

> 目的：给 `dsh-plugin-agent-browser` 补一套**硬化能力**的可复跑案例。`reference/010` 考操作原语、`011` 考端到端任务、`012` 考信息质量；本集考的是 **1.1.0–1.4.3 这轮"发布硬化"新增的边界行为**——取消、失败换路、鉴权与隔离、策略收紧、过程卡片、错误契约、配置面、验证墙误判。
>
> 状态：**已执行完毕（2026-11-22）：H1–H8 全过 8/8**，执行记录见 §7。设计时插件版本 **1.4.3**（`CLIENT_REV 37`、`HOST_REV 31`），DSH 宿主 **0.2.2-rc.5**，GUI `http://127.0.0.1:9529`（端口每次启动会变，以运行时的为准）。版本锚点：H2/H3/H4/H6/H7 在 1.4.3，人工项 H1/H5/H8 在 1.4.8 复跑；1.4.12→1.4.13 的差异只有 `package.json` 与 `README.md`（逐文件哈希核对），代码未变，故结论对 1.4.13 有效。
> 视口同前：CSS **575 × 863**，`devicePixelRatio` **1.5**（截图 863 × 1295）。
> 分工边界：本集只覆盖**旧案例集无法覆盖的新行为**；V/T/R 三族已有的点（快照、点击、翻页、下载落盘、信息核对）不重复设计，只在需要时引用。
> **配套实操集：** `reference/014-practical-cases.md`（S1–S6）——本集是**功能级**（调一次工具、看一个码），014 是**实操级**（真实工作需求，且必须先真的撞上障碍再判产物）。建议 013 全绿后再跑 014；014 里每条都标了它对应哪条 H 案。

---

## 0. 覆盖矩阵

| 编号 | 考验点 | 对应工单 | 自动化 | 预判（基于已验收版本） | 实测（2026-11-22，1.4.3） |
|---|---|---|---|---|---|
| H1 | 取消：排队中与在飞中的命令能不能停，停完还能不能接着用 | 021 | ✅ 队列侧脚本 / 🖐 GUI 侧 | 队列侧已过（1.2.4 探针）；GUI 停止未手测 | ✅ 在飞取消已过（2026-11-22，1.4.8，见 §7.8） |
| H2 | 失败换路：打不开时给不给同站候选，默认关时是否**逐字不变** | 013 / 027 | ✅ | 1.4.2 已实测过（作为 golden 复跑） | ✅ 通过（L3；开关逐字一致） |
| H3 | 鉴权与隔离：不是这个面板的进程能不能驱动它；双实例会不会串台 | 019 / 029 | ✅ | 019 已验收；029 修的重载竞态需再跑一次 | ✅ 通过（16/16 脚本断言） |
| H4 | 策略收紧：组织侧能不能不改代码就禁 eval / 禁某类下载 / 只许某会话 | 024 | ✅ | 1.3.5 已验收四项 | ✅ 通过（需分相执行，见 §7.2） |
| H5 | 过程卡片：动作在对话流里看不看得见（截图缩略图 / open 链接 / download 摘要） | 023 / 028 | 🖐 视觉 + ✅ 数据 | 卡片数据早已落盘；早期"未渲染"实为陈旧客户端 bundle（旧 `CLIENT_REV`），客户端热换后正常 | ✅ 通过（2026-11-22 目视确认，1.4.8） |
| H6 | 错误契约：模型能不能只靠 `code` 分流，UI 拿得到结构化 info | 020 | ✅ 工具侧 / 🖐 UI 侧 | 1.2.3 已验 4 个码，13 码未全量 | ✅ 6/6 码实测（`cancelled` 由 H1 补，`panel_not_open` 见 `reference/014` S6-M1；见 §7.4/§7.8） |
| H7 | 配置面：改配置不改代码就能生效；非法值**拒绝加载**而不是静默回落 | 016 | ✅ | 1.1.1 已验收 volatitle/普通字段两条路径 | ✅ 通过（L3；非法值被拒且旧配置保留） |
| H8 | 验证墙：纯文本误判与"真墙"要分得开；人完成后能继续 | 026 / 014 | ✅ 前两步 / 🖐 第三步 | 026 已验前两步；人工接管后继续未验 | ✅ 三步全过（2026-11-22，🖐 人工点按钮，见 §7.9） |

通过线：H2/H3/H4/H6/H7 取 **L3**；H1/H5/H8 取 **L2 + 行为已记录**（GUI 侧人工参与，按 011 的 T3/T7 先例处理）。

---

## 1. 与既有案例集的分工

| 案例集 | 看什么 | 本集不重复的部分 |
|---|---|---|
| 010（V 系列） | 动作有没有生效 | 快照契约、点击闭环、坐标打穿 canvas、截图稳定性 |
| 011（T 系列） | 任务能不能交付产物 | 下载落盘、PDF 解析闭环、翻页去重、404/WAF 换路 |
| 012（R 系列） | 结论能不能核对 | 数字出处、版本时效、双源冲突、幻觉诱捕 |
| **013（H 系列）** | **边界行为是否按契约表现** | 取消语义、鉴权边界、策略入口、卡片可见性、错误码、配置面 |

一句话：**V 问"能不能动"，T 问"能不能干完"，R 问"干得对不对"，H 问"该不该动的边界上，它是怎么反应的"。**

---

## 2. 共同规则

### 2.1 判级（沿用 011）

| 级 | 含义 |
|---|---|
| L1 | 动作返回了（成功或失败，但语义未核） |
| L2 | 表现与契约一致（错误码、文案、界面元素对得上） |
| L3 | 边界处无副作用（失败后现场仍在、取消后不误伤、策略生效且可恢复） |
| L4 | 换个入口/换个会话重跑，结论一致 |

### 2.2 每条案例必须同时写"判负条件"

与 011 的"判定落在产物上"同源：**只说"没报错"不算通过**。每条案例都列出"出现即判失败"的具体形态（见各案的 **判负** 行），例如"默认关时出现搜索行""非法配置被静默回落成默认值""取消后桥里仍残留待执行命令"。

### 2.3 人工边界

- 只有"验证墙 / 面板取消 / 视觉确认"三类允许人参与；其余人工介入即判失败。
- 人工参与的步骤必须在产物里写**人做了什么、什么时候做的**，供下次复跑判断环境差异。

### 2.4 预算

- 每案 ≤ 15 步、≤ 5 次 `browser_snapshot`（其余用 `browser_eval` 抽值，省 token）、≤ 2 次配置文件改动。
- 单案 10–15 分钟；需要等插件重载的步骤（改非 volatile 配置）按 **8 s** 计。
- 每次改动 profile patch 前先备份到 `tmp/patch-before.yaml`，跑完必须恢复并核对字节数（正常 2,071 字符 / 54 行，UTF-8、末尾换行）。

### 2.5 证据采集口径

| 证据 | 怎么取 |
|---|---|
| 桥是否活着、是否重启 | `GET http://127.0.0.1:<port>/dsh-agent-browser/health`（**带 token 才可读**；无 token 应为 403） |
| 是否发生过热替换 | `/health` 的 `enqueued/pulled` 计数**清零**=重启，继续增长=volatile 就地生效 |
| 错误码 | 直接读工具返回文本；应为 `Error: <code>: <人话> …` |
| 客户端是否换新 | 看行为差异或 `report` 日志；`CLIENT_REV` 不对外暴露 |
| 会话记录里的结构化字段 | 会话 `.zstd` 是多帧拼接，需逐帧解压（`set -euo pipefail` 写脚本，不要手工拼接） |

> ⚠️ 编辑纪律：`C:\Users\林焕文\.dsh\cordis.patch.yml` 与任何含中文的源文件，**只能用 write/edit 工具或 .NET `UTF8Encoding($false)` 写**。PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM（装包校验会报 `Unexpected token '\ufeff'`），`Get-Content`/`Set-Content` 混用会把中文变成 GBK 乱码。

---

## 3. 逐案设计

### H1 取消：命令能不能在"到达页面之前"停掉

**背景**：TICKET-021 让 `exec.signal` 一路传到桥与面板，队列里的命令可被摘除，已投递的命令只能"丢掉结果"。这条边界在单测与探针里过了，但**真实 GUI 里人按停止**这条路径没走通过。

**前置**：插件 1.4.3；面板已打开；准备一个长页面（如 `https://en.wikipedia.org/wiki/Web_browser`）与一个本地重页面（`browser_open({path})` 指向大 HTML）。

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 开长页面，`browser_snapshot({maxChars: 30000})` | 正常返回大快照 |
| 2 | 让宿主取消一次正在执行的 `browser_snapshot`（GUI 停止按钮） | ≤ 1 s 返回 `cancelled: …`；文案说明"已完成的部分不会被撤销" |
| 3 | 取消后立刻再 `browser_snapshot({maxChars: 600})` | 正常返回当前页，不报 `bridge_timeout` / `cancelled` |
| 4 | 把 `activation` 临时设为 `manual`，连发两条 `browser_open`（第二条排队） | 第一条执行；第二条在队列 |
| 5 | 取消第二条 | 返回 `cancelled:`；**页面仍停在第一条的结果**；队列里出现 1 个 cancel 帧（可从桥 `/pending` 或客户端日志观察） |
| 6 | 把 `activation` 改回默认 | 工具恢复，后续 open 正常 |

**判定**：L1 取消能返回；L2 返回码为 `cancelled` 且文案与 ticket §6 一致；L3 取消后无残留（再调用正常、页面未被误导航、序列里没有迟到回包导致的二次执行）。

**判负**：取消后 20 s 才返回（说明根本没走 abort）；取消排队命令后页面却导航了；取消后下一次调用报 `bridge_timeout`；同一命令被执行两次。

**预判**：队列侧全过（1.2.4 装机探针）；GUI 停止未手测，可能暴露"停止按钮只断了工具侧、面板还在读"的观感问题。

---

### H2 失败换路：打不开时给不给候选，关了是否逐字一致

**背景**：TICKET-013 负责"回得去"（回退到上一页、错误带 `nav_*` stage），TICKET-027 负责"还能去哪"（同站候选，默认关）。两者叠在一起，最容易出的问题是"开了不该开、关没关干净"。

**前置**：插件 1.4.3；当前页在 `https://example.com/`；`searchFallback.enabled` 默认 **false**。

| # | 步骤 | 期望 |
|---|---|---|
| 1 | `browser_open https://www.wikipedia.org:8080/` | `navigation_failed: nav_*: …`；含 "went back to https://example.com/"；**不含** `Search fallback` 行、不含 `alternatives` |
| 2 | 记下这段错误的完整文本（作为 baseline） | — |
| 3 | 在 profile patch 里把 `searchFallback.enabled` 设为 `true`（volatile，应立即生效） | 插件不重启；下一条命令开始走新配置 |
| 4 | 同一个 URL 再开一次 | 错误里出现 `Search fallback (1 call, provider≈…, model route=…, query="…")`、`Nothing was opened (opened: false)`、`- <title> — <url>` 候选 ≥ 0 条（0 条时也要有"没搜到同站"的说明） |
| 5 | 紧接 `browser_snapshot({maxChars: 600})` | 正常返回 example.com 的内容（现场没丢） |
| 6 | 关掉 `searchFallback.enabled`，重跑第 1 步 | 错误文本与第 2 步 baseline **逐字一致** |

**判定**：L1 开/关都返回错误；L2 打开时确有 1 次搜索标注、候选只来自同站/子域、`opened: false`；L3 关闭后逐字回到 baseline，且面板状态未受第 4 步影响。

**判负**：默认关时出现任何搜索痕迹；打开后自动打开了候选页；候选来自异构站点；一次失败触发 2 次以上搜索；错误里的摘要被当成页面正文写结论。

**预判**：1.4.2 已用 `wikipedia.org:8080` 跑通（候选命中 `ja.wikipedia.org`），本案例作为 golden 回归。注意 `site:` 操作符实测不可用（provider 不认），查询形态是 `<host> <路径词>`。

---

### H3 鉴权与隔离：外部进程能不能驱动面板

**背景**：TICKET-019 之后桥是"随机端口 + 每进程 43 字符令牌 + Host 精确校验"；静态预览是 `/t/<token>/`。TICKET-029 修了"发现路由注册早于 webServer"的竞态。安全边界最容易在**重载之后**悄悄退化。

**前置**：插件 1.4.3；从 `/health` 或客户端日志拿到桥端口（`http://127.0.0.1:<port>`）。

| # | 步骤 | 期望 |
|---|---|---|
| 1 | `curl -s -o - -w '%{http_code}' http://127.0.0.1:<port>/dsh-agent-browser/health` | `403`，body 含 `"code":"unauthorized"` |
| 2 | 带一个错误 token（43 字符、随机）再试 | 仍 `403`；不因长度/格式崩溃 |
| 3 | 带正确 token 但把 `Host` 改成 `evil.example` | `403`，文案含 `untrusted host` |
| 4 | `curl -s http://<gui>:<gui_port>/agent-browser/discovery`（不带 cookie） | `401`（**不是 404**——404 说明发现路由没注册） |
| 5 | 本地起第二个 `Bridge({port: 0})`（脚本模拟第二实例），记录其端口与令牌 | 端口不同；用实例 A 的令牌打实例 B → `403` |
| 6 | `plugin_manager set_plugin enabled=false` 再 `true`，等 8 s | 旧端口连接被拒；新端口出现；`/agent-browser/discovery` 仍 401；**不刷新页面**再 `browser_open` 成功 |

**判定**：L1 请求有响应；L2 每条边界都按码拒绝（403/401/403）；L3 重载后鉴权没有降级、客户端能自动重发现。

**判负**：无 token 能读到 `/health`；发现路由 404；重载后工具全部 `bridge_timeout`（029 复发）；第二个实例能拿到第一个的会话。

**预判**：019/029 验收已过，本案例的价值在**重载后复验**——这是 029 的 R2 风险窗口。

---

### H4 策略收紧：不改代码能不能禁掉危险能力

**背景**：TICKET-024 把 scheme、eval 开关、下载扩展名、输出预算、会话名单统一到 `policy.js`，并挂到 `ctx.tools.guard()`（在工具体之前拦截）。

**前置**：插件 1.4.3；当前会话 id 已知（随便一个"别的会话 id"用于 allowlist 测试）。

| # | 步骤 | 期望 |
|---|---|---|
| A1 | 配置相 A：`evalEnabled: false` + `downloads.extraBlockedExtensions: [dat]`（非 volatile，触发重载） | 等 8 s 重载；`browser_eval` → `eval_disabled: …`；`browser_download https://httpbin.org/anything/probe.dat` → `download_rejected: …` |
| A2 | 配置相 B：A + `sessions.allowlist: [definitely-not-this-session]`（再重载） | 当前会话的**任何** `browser_*` 都被 guard 拒 → `session_not_allowed: …`（在工具体之前，不产生桥流量） |
| A3 | 配置相 C：删掉 `sessions` 段（保留 eval/下载项），等重载 | `browser_open` 恢复正常；`browser_eval` 仍 `eval_disabled`；`.dat` 仍被拒 ⇒ 逐项独立生效、无残留 |
| A4 | 配置相 D：删除整个临时 config 块 | 全部恢复默认：eval 可用（`1+1 → 2`）、`.dat` 可下、open 正常 |

> ⚠️ 必须分相：guard 在工具体之前，allowlist 一生效就会把 eval/下载也一并拦成 `session_not_allowed`。若把三项写进同一个配置块，A1 的两条断言永远看不到——这是本案例第一版的写法缺陷，2026-11-22 执行时发现并改成 A→D 四相。

**判定**：L1 配置能加载；L2 每条拒绝都带正确 code；L3 逐项可单独生效、删除后逐项恢复，且插件重载没有把工具弄丢。

**判负**：配置写对了但不生效；拒绝时返回普通 Error（丢 code）；删配置后仍有残留限制；重载后 `list_plugins` 里 `fiberPhase` 不是 `active`。

**预判**：1.3.5 已验收四项，但"逐项恢复"和"删配置后无残留"没串起来跑过。

---

### H5 过程卡片：动作在对话流里看不看得见

**背景**：TICKET-023 注册了三个 `tool.call.toolview`（截图缩略图 / open 链接 / download 摘要），TICKET-028 修了隐藏面板时的取帧与文案。**数据已证明落盘（会话记录里有 `meta.thumb`），但视觉从未确认。**

**前置**：插件 1.4.3；刷新 GUI 页面（客户端 bundle 换新后需要）。

| # | 步骤 | 期望 |
|---|---|---|
| 1 | `browser_open https://example.com/` | 对话里出现 open 卡片：标题 + **可点击** URL；失败时显示原因与人机验证提示 |
| 2 | `browser_screenshot({mode: 'viewport'})` | 卡片内联显示缩略图 + `宽 × 高 · 大小`；有"打开原文件"入口 |
| 3 | `browser_download https://httpbin.org/pdf`（或任意小 PDF） | 卡片显示文件名 + 大小 + `sha256` 前 12；有打开按钮 |
| 4 | 把面板切到后台/最小化后再截图 | 明确文案（`the browser panel is hidden right now …`），**不是** `UnknownVizError`；稍后回前台重试成功 |
| 5 | 刷新页面后重复第 1–3 步 | 卡片仍能出（说明不依赖旧客户端缓存） |

**判定**：L1 三个工具都成功；L2 卡片**真的渲染出来**且字段与工具返回值一致；L3 无图/隐藏时有可理解的降级，刷新后不丢。

**判负**：只出路径不出图（退回 1.0.x 行为）；`sha256` 与工具返回值不一致；隐藏面板时报 Electron 内部错误；刷新后卡片消失。

**预判**：视觉待人工确认（发布说明 U 项）。这是本集里**最需要人看**的一条。

---

### H6 错误契约：模型和 UI 能不能只看 code 分流

**背景**：TICKET-020 把错误统一成 `AgentBrowserError`，码表 13 个；模型内容里只有 message，但 message 以 `code: ` 开头，UI 侧靠 `error.info.code`。

**前置**：插件 1.4.3；能逐个触发下列场景。

| # | 触发 | 期望 code | 期望文案特征 |
|---|---|---|---|
| 1 | 面板未打开时 `browser_open` | `panel_not_open` | 说明"打开侧栏浏览器页签后重试" |
| 2 | `browser_open file:///C:/Windows/win.ini` | `scheme_rejected` | 列出收到的 scheme |
| 3 | `evalEnabled=false` 时 `browser_eval` | `eval_disabled` | 说明是安装选项关的 |
| 4 | 打不开的 URL | `navigation_failed` | 带 `nav_*` stage + 原始 URL |
| 5 | 取消一次长调用 | `cancelled` | 说明已投递动作不可撤销 |
| 6 | allowlist 不放行当前会话 | `session_not_allowed` | 说明由组织策略拦截 |

**判定**：L1 六个都能触发；L2 六个 message 都以 `code: ` 开头（`Error: ` 之后）；L3 模型能复述 code 且**不把 code 当页面内容**；UI 侧（会话记录）`error.info.code` 与 message 前缀一致。

**判负**：返回 `Error: undefined`；同一场景两次不同 code；UI 里 `info` 为空但 message 有 code（基线预期如此，因为基类是本地同形类——见 ticket 020 §6.2，**这一点要在执行记录里写清，不算通过也不算失败**）。

**预判**：020 已验 4 个码；`session_not_allowed`/`cancelled`/`budget_exceeded` 尚未在同一轮里串起来。

---

### H7 配置面：改配置真的会生效，写错真的会拒

**背景**：TICKET-016 把 8 个硬编码参数搬进 Config，其中 5 个是 volatile（`activation`/`fitWidth`/`evalEnabled`/`claimBrowserUse`/`searchFallback.enabled`），其余改动会热替换插件。

**前置**：插件 1.4.3；准备 baseline 页面（`https://en.wikipedia.org/wiki/Web_browser`）。

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 记录 baseline：`browser_snapshot()` 大小、`browser_eval` 读 `innerWidth/scrollWidth` | 例如 7.8 KB / 909 nodes；`innerWidth 575` |
| 2 | 设 `limits.snapshotMaxChars: 3000`（非 volatile，重载） | 同页快照 ≈ 2.8 KB 且带 `tree cut`；`/health` 计数清零（确认重启） |
| 3 | 设 `fitWidth: false`（volatile） | 不重启（计数继续涨）；`browser_zoom({reset:true})` 后 `scrollWidth > innerWidth`，横向滚动出现 |
| 4 | 设非法值：`limit.snapshotMaxChars: -5` 或 `searchFallback.maxResults: "x"` | 配置被拒：插件**不重载**、旧配置继续生效（`bridge` 端口与计数不变）；恢复合法值后正常 |
| 5 | 恢复全默认 | 快照回到基线；fitWidth 恢复；`fiberPhase: active` |

> ⚠️ 两条口径（2026-11-22 实测）：① **关掉 `fitWidth` 不会撤销已有的 fit 缩放**（每会话记住的 fit zoom），要先 `browser_zoom({reset:true})` 才能观察 100%；② 非法值是在加载期被 schemastery 拒掉的，表现为"这一次修改不生效、旧配置仍在跑"，并非整个插件崩掉——`normalizeConfig` 里的 `TypeError` 是单测覆盖的第二道防线。

**判定**：L1 配置能改；L2 volatile 与重载两类行为可分（计数清零与否）；L3 非法值被拒、恢复后无残留。

**判负**：改了没反应；非法值静默变成默认；配置生效但工具消失；恢复后仍需重启。

**预判**：1.1.1 已验收条款，可作回归。注意 profile patch 的 `config` 块是**整行替换**：只写 `bridge` 会让其他组回落默认——这本身要作为口径写进执行记录。

---

### H8 验证墙：误判与真墙

**背景**：TICKET-026 修了"纯文本页面含'人机验证'字样就误判"的问题；V8 的"人工接管后继续"一直没跑。

**前置**：插件 1.4.3；准备两个本地夹具（可用 `probe/` 临时放，跑完删）：`plain-notes.txt`（正文含"人机验证"四个字）与 `challenge-check.html`（title "请稍候"，正文"请完成安全验证"，0 控件）。

| # | 步骤 | 期望 |
|---|---|---|
| 1 | `browser_open({path: 'plain-notes.txt'})` | **不**返回 `needs_human`；快照能读出正文 |
| 2 | `browser_open({path: 'challenge-check.html'})` | 返回 `needs_human`（真墙） |
| 3 | 人工在面板里"完成"验证（🖐 人做，可以是点掉提示或换页） | 记录人做了什么、耗时 |
| 4 | 人完成后再次 `browser_snapshot` | 正常返回，不再 `needs_human`；`browser_open` 别的页也正常（状态已清） |

**判定**：L1 两步返回；L2 误判/真墙区分正确；L3 人工接管后不卡死（工具侧状态被清）；L4 换一个纯文本文件重跑，结论一致。

**判负**：纯文本含关键词仍被判墙；真墙被当普通页面往里面点；人完成后工具仍返回 `needs_human` / `taken_over`。

**预判**：前两步 1.2.1 已验；第 3/4 步从未跑过，**是本集最可能暴露问题的一条**。

---

## 4. 复跑顺序与成本

| 顺序 | 案例 | 步数 | 时长 | 依赖 | 稳定性 |
|---|---|---|---|---|---|
| 1 | H7 配置面 | 5 | 6 min | 需要改 profile patch ×3 | 高（本地行为） |
| 2 | H6 错误契约 | 6 | 5 min | 无 | 高 |
| 3 | H3 鉴权与隔离 | 6 | 8 min | 需要桥端口/令牌（脚本取） | 高 |
| 4 | H4 策略收紧 | 5 | 8 min | 需要改 profile patch ×2 | 中（重载窗口） |
| 5 | H2 失败换路 | 6 | 6 min | 需要网络；改配置 ×1 | 中（站点可失败） |
| 6 | H5 过程卡片 | 5 | 5 min + 🖐 | 需刷新 GUI + 人看 | 高（视觉） |
| 7 | H1 取消 | 6 | 6 min + 🖐 | 需 GUI 停止按钮 | 中（时序） |
| 8 | H8 验证墙 | 4 | 8 min + 🖐 | 需人工过一次验证 | 低（依赖站点/人工） |

建议：先跑 H7/H6/H3（纯自动化，能立刻发现回归），再 H4/H2，最后 H5/H1/H8（要人）。

## 5. 与发布说明"未验证项"的映射

`docs/release-notes-1.4.md` §7 列的 9 条未验证项里，本集能关掉 5 条：

| 发布说明未验证项 | 由哪条案例关闭 |
|---|---|
| 取消的 GUI 手测 | H1 |
| 三张卡片的视觉效果 | H5 |
| hidden（面板隐藏）分支 | H5 第 4 步 |
| 会话名单/策略在真实配置下的表现 | H4 |
| 重载后鉴权不退化（029 R2） | H3 第 6 步 |

剩下 4 条（PTC 端到端、Web 非桌面形态、第三方插件注册 slot、macOS/Linux）需要换环境，不在本集范围。

## 6. 已知失败模式（判负基线，执行前先看）

| 形态 | 说明 | 出处 |
|---|---|---|
| `bridge_timeout` 全部超时 | 多半是发现路由没注册（029）或客户端没加载 | 029 §1 |
| `capturePage did not return` / `UnknownVizError` | 面板不可见（hidden）或首次绘制未完成 | 028 |
| `landed.startsWith is not a function` | 老版本客户端在 `getURL()` 非字符串时崩（1.3.8 事故） | 013 §6.4 |
| 配置报 `must be a boolean, got {}` | 嵌套 volatile 没拆读取器（1.4.0 事故） | 027 §6 |
| 装包报 `Unexpected token '\ufeff'` | 用 PowerShell 写了 BOM | 018 §6.5 |
| `site:` 查询 0 结果 | provider 不认该操作符，属已知偏差 | 027 §6.5 |

> 执行记录写在各案例标题下的「实测」小节（沿用 011/012 的写法），并把结论回填到本矩阵的"预判"列与 `README.md` 的状态表。

---

## 7. 执行记录（2026-11-22，插件 1.4.3 / 宿主 0.2.2-rc.5）

环境：GUI `http://127.0.0.1:9529`，面板视口 CSS 575×863 / dpr 1.5（与 010 一致），profile patch 基线 **2,071 字符 / 54 行**。辅助脚本放 `tmp/`：`patch-tool.mjs`（给 profile patch 追加/移除 `# >>> h-cases start` 标记块）、`discovery-probe.mjs`（自签宿主 cookie 打 `/agent-browser/discovery`，并用返回的令牌读 `/health`）、`bridge-logs.mjs`（读桥 `/logs`）、`make-h7-fixture.mjs`（生成可预期大小的本地页）、`h3-auth-probe.mjs`（H3 的 16 条断言）。

> 自签 cookie 的方法：`client-connection/browser-session.payload.secret` 对 `v1.<b64url(payload)>` 做 HMAC-SHA256，cookie 名 `dsh-auth-<b64url(sha256(authority))>`。只用于本机取证，不写进产品代码。

### 7.1 H7 配置面 — ✅ L3

| 步骤 | 实测 | 证据 |
|---|---|---|
| baseline | snapshot 158 行 / 263 节点 / 7.8 KB；`fitWidth` 默认 true 时 dpr 0.525、innerWidth 1643 | 夹具 `tmp/h7-page.html` |
| 普通字段 `limits.snapshotMaxChars: 3000` | **插件热替换**：桥端口 5987→10210、静态端口 12456→6885、`enqueued/pulled` 8/8→0/0（重启）；同页 snapshot 70 行 / 121 节点 / 2.8 KB，`tree cut` | 预算生效 |
| volatile `fitWidth: false` | 桥端口仍 10210、计数 1/1 未清零（就地更新）；`browser_zoom(reset)` 后 open → dpr 1.5、innerWidth 575、1900px 表格 `hscroll: true` | 无需重启 |
| volatile `fitWidth: true` | 端口不变；open → dpr 0.45、innerWidth 1917、`hscroll: false` | 同一进程内来回切 |
| 非法值 `limits.snapshotMaxChars: -5` | **不重载**（端口不变、计数继续），工具照常；snapshot 仍是 3000 预算（70 行）⇒ 非法配置被拒、**旧配置继续生效** | 未把插件弄丢 |
| 清空临时块 | 桥端口换新、计数归零（重载）；snapshot 169 行 / 286 节点 / 7.8 KB、eval 恢复 | profile patch 回到 2,071 字符 / 54 行 |

注意事项（供复跑者）：
1. **关掉 `fitWidth` 不会撤销已经存在的 fit 缩放**（每会话记住的 fit zoom）。要观察"关掉后 100%"，先 `browser_zoom({reset:true})` 再 open。
2. 插件热替换会顺带换掉静态服务端口，所以 `path` 打开的 URL 每次重载后都不同——这是正常现象，不是 404。
3. 非法值是在配置层（schemastery）被拒的，`normalizeConfig` 里那条 `TypeError` 是第二道防线（单测覆盖），外部运行时看不到它。

### 7.2 H4 策略收紧 — ✅ L3（**需分相执行**）

原步骤把 `sessions.allowlist` 和 `evalEnabled`/`downloads` 放在同一个配置块里，但 guard 在工具体之前拦截：allowlist 一旦生效，`browser_eval`/`browser_download` 也会先吃到 `session_not_allowed`，看不到 `eval_disabled`/`download_rejected`。实际执行改成四相：

| 相 | 配置 | 实测 |
|---|---|---|
| A | `evalEnabled:false` + `downloads.extraBlockedExtensions:[dat]` | 重载后 `browser_eval` → `Error: eval_disabled: …`；`browser_download https://httpbin.org/anything/probe.dat` → `Download failed at policy: download_rejected: refusing to download .dat files into the workspace` |
| B | A + `sessions.allowlist:[definitely-not-this-session]` | 重载后 `browser_open` → `Error: session_not_allowed: this session is not allowed to drive the browser (session_not_allowed)`（工具体之前拦截，桥无流量） |
| C | 去掉 `sessions` 段（保留 A） | 重载后 `browser_open` 正常；`browser_eval` 仍 `eval_disabled`；同一下载仍 `download_rejected` ⇒ 逐项独立生效、无残留 |
| D | 清空 | `browser_eval` → `2`；`.dat` 下载成功（371 B，sha256 `c779a592…`）；open 正常 |

建议把本案例 §3 的步骤改成 A→B→C→D 四相（已在本记录里给出可直接复用的配置形状），否则按字面执行会在第 1/2 步拿到 `session_not_allowed` 而误判失败。

### 7.3 H2 失败换路 — ✅ L3

1. 默认关（baseline）：`browser_open https://www.wikipedia.org:8080/` →
   `Error: navigation_failed: nav_unknown: the navigation failed for an unclassified reason (ERR_CONNECTION_TIMED_OUT): https://www.wikipedia.org:8080/. The panel went back to https://example.com/, so that page is still there.`
   （无 `Search fallback`、无候选）
2. 置 `searchFallback.enabled: true`（volatile，桥端口 9204 不变、计数 3/3→5/5 未清零）后同一 URL →
   第一段与 baseline 完全相同，追加：
   `Search fallback (1 call, provider≈deepseek-search-api, model route=opencode-go, query="wikipedia.org"): search results for this site, not links found on a page. Nothing was opened (opened: false); pick one and call browser_open yourself, or ask the user which one is right.` + `- ウィキペディア - Wikipedia — https://ja.wikipedia.org/wiki/?oldid=…`
   ✅ 1 次调用、同站（子域）、`opened:false`。
3. 紧接 `browser_snapshot({maxChars:600})` → `page "Example Domain" url=https://example.com/`、516 B、5 行（现场未丢）。
4. 置回 `false` 后同一 URL：错误文本与第 1 步**逐字一致**（无任何搜索痕迹）。

### 7.4 H6 错误契约 — ✅ 6/6（首测 4 条 + §7.7 补 `cancelled` + 2026-11-23 补 `panel_not_open`）

| # | 触发 | 实测 message |
|---|---|---|
| 1 | 面板未打开 | ✅ 2026-11-23 1.4.13 补测：`Error: panel_not_open: the browser panel of session session-… is not on screen, so the page cannot be driven. Open that session and its right sidebar browser tab, then retry.`（用户打开页签后重试成功） |
| 2 | `browser_open file:///C:/Windows/win.ini` | `Error: scheme_rejected: only http(s) URLs are allowed, got file:` |
| 3 | `evalEnabled:false` + `browser_eval` | `Error: eval_disabled: browser_eval is switched off by this installation (evalEnabled: false)` |
| 4 | `browser_open https://no-such-host.invalid/` | `Error: navigation_failed: nav_dns: the host name could not be resolved (ERR_NAME_NOT_RESOLVED): https://no-such-host.invalid/. The panel went back to …` |
| 5 | 取消长调用 | ⬜ 未触发（需 🖐 停止按钮，与 H1 同一步） |
| 6 | allowlist 不放行 | `Error: session_not_allowed: this session is not allowed to drive the browser (session_not_allowed)` |

观察：六条里实测的 4 条都满足 L2（`Error: <code>: …`）。注意第 6 条 message 里 code 出现两次（前缀 + 括号），是 `policy.js` 文案自带 `(code)` 与 `AgentBrowserError` 前缀叠加所致——**不影响分流**，但可在下一版把括号里的 code 去掉（低优先级，未开票）。UI 侧 `error.info.code` 未核（需要看会话记录/插件面板，属 🖐 项；基线预期 `info` 为空，因为基类是本地同形类，见 TICKET-020 §6.2）。

### 7.5 H3 鉴权与隔离 — ✅ L3（`tmp/h3-auth-probe.mjs`，16/16 PASS）

| 断言 | 结果 |
|---|---|
| discovery 返回 43 字符令牌 | PASS（port 9204） |
| 桥 `/health` 无令牌 / 错令牌 → 403，`code: unauthorized` | PASS ×3 |
| 伪造 `Host: evil.example`（令牌正确）→ 403 `untrusted host` | PASS |
| 正确令牌 → 200 | PASS |
| 静态 `/t/<token>/…` → 302 到 token-free 路径 + `ab` HttpOnly cookie | PASS |
| 带 cookie 的 302 目标 → 200；无 cookie / 错 token → 403 | PASS ×3 |
| 双实例：端口不同、令牌不同、互不接受对方令牌、各自接受自己 | PASS ×5 |

### 7.6 H5 过程卡片 — ✅ 目视通过（2026-11-22，1.4.8）

> 这一条曾连续三次被记成"卡片没渲染"，实际是**判据选错了**：我们看的是侧栏「轨迹」面板（时长/轮次/调用/子调用），那个面板只显示统计、永远不渲染卡片；真正要看的对话区其实早就出了卡片。

| 环节 | 证据 |
|---|---|
| 注册是否生效 | 桥日志 `client half applied {"rev":40,"toolviews":3}`；`toolview entries` 报 `count:64, ours:["browser_open","browser_screenshot","browser_download"]`，`entriesOfSlot` 的 `ourWinners` 同样三条 |
| 组件是否被渲染器调用 | 临时埋点 `toolview render {"key":"browser_open","phase":"result","toolName":"browser_open"}`，三个 key 各一次 |
| 缩略图通道 | `thumb probe resolved "blob:dsh-app://app/41482ca0-…"`（`loadImage(ImageAttachmentRef)` 正常） |
| 最终目视（用户截图） | `browser_open`：🌐「在面板里打开了网页」+ `Example Domain` + 可点链接 `https://example.com/`；`browser_screenshot`：🖼「浏览器截图 84.8 KB」+ 内联缩略图 + 路径 + 「在文件里打开」；`browser_download`：⬇「下载了文件 13.0 KB · sha256 3df79d34abbc」+ 文件名 + 「在文件里打开」 |

**根因（两点，都是环境而不是功能缺陷）**

1. 当时代码改动只进了磁盘、渲染器仍在跑升级前的旧客户端 bundle（`CLIENT_REV 37`）；客户端半侧要等下一次 `install_bundle` 才会热换。顺带的坑：`Ctrl+R` 没反应是因为键盘焦点落在 `<webview>` 里，快捷键被 guest 页吃掉。
2. 判据用错：轨迹面板 ≠ 对话区。

**顺带修掉的两处**

- 面板地址栏显示 `[object Promise]`：`Guest.url()` 直接回 `element.getURL()`，异步实现时把 Promise 存进了 state。改成本地 `lastAddress` 缓存 + `remember()`（`did-navigate` / `address()` 都写入），`CLIENT_REV 38`。
- 启动早期 `report()` 在 discovery 完成前会被静默丢弃，导致"客户端到底跑没跑"无从判断：加 `pendingReports`（上限 50）在拿到桥地址后补发。
- 排查用的临时埋点（`traceView`、`thumbProbe`、`onEntryError` 上报、`entries` 统计、window error 监听）已在 **1.4.8 / `CLIENT_REV 42`** 全部移除，166 单测仍全绿。

**复跑注意**：升级后先看桥日志里 `client half applied` 的 `rev` 是否为新值；若卡片不显示，点一下对话区（把焦点从 webview 移出）再 `Ctrl+R`，然后看**对话区**而不是轨迹面板。

### 7.7 H1 取消 — ✅ 在飞取消（2026-11-22，1.4.8，🖐 人工点停止）

> 就是 H6 #2 缺的那一条：由人在 GUI 里点停止，模型侧收到 `cancelled`。

**装置**：`tmp/slow-fixture.cjs`（本地 node 起 `127.0.0.1:7799`，`?ms=` 指定延迟毫秒，上限 30 s），用来制造一个"看得见的在飞导航"。启动：`node tmp/slow-fixture.cjs`。

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 先 `browser_open https://example.com/` 建立"上一页" | `Opened https://example.com/ — Example Domain` |
| 2 | `browser_open http://127.0.0.1:7799/?ms=30000&round=3`，人在约 16 s 处点停止 | 工具立即返回 `Error: cancelled: the caller stopped c14 before the panel finished it. Nothing already sent to the page can be undone, so re-read the page before acting again.` |
| 3 | 取消后立刻 `browser_eval` 读当前页 | `{"href":"https://example.com/","title":"Example Domain"}` ⇒ **页面留在上一页，没有被带走** |
| 4 | 桥日志（`/logs`，token 经发现路由） | `dispatch c14 open` → `run c14` → `cancel {"id":"c14","running":true}` → `cancel dropped error: navigation_failed: … ERR_FAILED (-2) loading 'http://127.0.0.1:7799/?ms=30000&round=3'` → `cancel dropped result {"id":"c14"}` ⇒ 取消帧到达面板、面板中止了加载、迟到结果被丢弃（没有 settle） |

**结论**：取消链路四段（工具侧 → 桥 → 面板 → 回包）全部实测通过；`cancelled` 文案同时给出"已发到页面的动作不能撤销、要重做先重读页面"的提示，符合 H6 对 message 的要求。

**观察（非缺陷，供复跑参考）**：

- 第一次尝试（`round=1`）时面板页签是新装的空页，取消后停在 `about:blank` —— 属预期（本来就没有上一页）。
- 第二次尝试（`round=2`）点击落在加载完成之后，桥日志只有 `settled ok:true`、没有 `cancel` 帧 —— 判"没赶上"即可，不算失败。
- 排队中取消（命令还没被面板拉走）由 `plugin/test/cancel.test.mjs` 的单元测试覆盖（队列被摘掉 + 入队 `cancel` 帧 + reject `cancelled`），GUI 侧无法稳定构造，不再另做人工验证。

### 7.9 H8 验证墙 — ✅ 三步全过（2026-11-22，1.4.8，🖐 人工点按钮）

> 这一条要证明的不是"能识别墙"（026 已验），而是**人把墙过掉之后模型能不能接上**。

**装置**：`probe/counterfeit-wall.html`（仿冒验证页：标题「请稍候…」、文案「请完成安全验证」、一个「我已完成验证」按钮，点击跳到）→ `probe/behind-wall-table.html`（三行表格：H8-001 1,280,000 / H8-002 735,000 / H8-003 2,410,500）。

| # | 步骤 | 结果 |
|---|---|---|
| 1 | `browser_open({ path: 'probe/counterfeit-wall.html' })` | `Opened http://127.0.0.1:5331/t/probe/counterfeit-wall.html — 请稍候…` 且附 `needs_human: a human verification step is on screen. Ask the user to complete it in the panel, then take a browser_snapshot to see whether it is gone.` |
| 2 | 墙上时调用 `browser_eval` | 被拒：`needs_human: 页面需要人工验证…`（文案里明确说 snapshot 仍可用、`browser_open` 仍可离开此页）——符合"墙时刻不给执行能力，但保留观察与脱身通道"的设计 |
| 3 | 人在面板里点「我已完成验证」 | 页面自行跳到 `http://127.0.0.1:5331/probe/behind-wall-table.html`（用户确认，随后我说"继续"） |
| 4 | 握手后先 `browser_snapshot(maxChars:2000)` | 成功：`gen 1 · 1 refs · 30 lines · 65 nodes · 781 B`，看到 `heading "墙后数据表 — 2026 年 11 月"` 与三行表格 |
| 5 | 再 `browser_eval` 取表格 | `needs_human` **已消失**，返回三行：`["1","H8-001","某单位数据治理平台采购","1,280,000","2026-11-18"]` / `["2","H8-002","某医院影像系统升级","735,000","2026-11-20"]` / `["3","H8-003","某高校科研数据服务","2,410,500","2026-11-21"]` |

**结论**：墙→交接→继续→取数的完整闭环成立；`needs_human` 不是"锁死会话"的错误，只是一个"此刻不能执行、但可以观察/离开"的状态，用户动作完成后下一次命令自动恢复正常能力。

**复跑注意**：点击动作必须由人做；模型侧能做的就是第 1、2、4、5 步。若用户没点按钮就说"继续"，`browser_snapshot` 会继续显示墙（仍是 `needs_human` 状态），不要据此判失败。

### 7.10 未执行与交接

**H 集已无剩余人工项**：H1–H8 全部实测完毕（H1 取消 §7.7、H5 卡片 §7.6、H6 补齐 §7.4/§7.7、H8 验证墙 §7.9；H2/H3/H4/H7 见 §7.1–§7.5）。原交接给 S 集的两项人工（S2 面板切后台截图、S5 真实站点验证墙）也已于 2026-11-22 / 11-23 完成，记录见 `reference/014-practical-cases.md` §7.4 / §7.5。

清理：`tmp/` 下的夹具与脚本保留到 H 集跑完；`downloads/probe.dat` 为验收产物（可删）；profile patch 已恢复基线（2,071 字符 / 54 行、无临时块）。

### 7.11 1.4.13 复跑（2026-11-23 15:2x–15:4x，插件 1.4.13 / 宿主 GUI 127.0.0.1:9522）

背景：1.4.9–1.4.12 动过代码（接管点击 TICKET-032、‹›⟳ 工具栏、`inject/guards.js` 独立注入、`fitWidth`），而 H 集结论锚在 1.4.3，故在装机版本 1.4.13 上把 H2/H3/H4/H6/H7 全部重跑。**结论：五案全过，无回归。**

| 案例 | 结果 | 1.4.13 关键证据 |
|---|---|---|
| H2 失败换路 | ✅ | baseline（`tmp/h2-baseline.txt`，196 字符）与关闭态逐字一致；`searchFallback.enabled:true` 后同一 URL 追加 `Search fallback (1 call, provider≈deepseek-search-api, model route=opencode-go, query="wikipedia.org")` + `Nothing was opened (opened: false)` + 同站候选（`ja.wikipedia.org` 子域）；页面未丢（`gen 1 · 5 lines · 516 B`）；`patch-tool clear` 后**再逐字一致** |
| H3 鉴权与隔离 | ✅ 16/16 | `tmp/h3-auth-probe.mjs` 全 PASS（无/错令牌 403、伪造 Host 403 `untrusted host`、静态 302 + `ab` HttpOnly cookie、双实例令牌互斥）；发现路由无 cookie 与假 cookie 均 **401**；`set_plugin include:agent-browser-panel false→true` 后 discovery 200、**未刷新 GUI** 直接可驱动 |
| H4 策略收紧 | ✅ 四相 A→D | A: `eval_disabled` + `download_rejected (.dat)`；B: allowlist `[definitely-not-this-session]` → 任何 `browser_*` 均 `session_not_allowed` 且**桥 `enqueued` 不增**；C: 删掉 `sessions` 后 open 恢复、eval/.dat 仍拒；D: 清空后 `1+1 → 2`、`.dat` 落盘（392 B，`downloads/probe.dat`） |
| H6 错误契约 | ✅ 6/6 | 本轮新增 `panel_not_open`（面板未开时）+ 复核 `scheme_rejected` / `eval_disabled` / `session_not_allowed` / `navigation_failed`；六条 message 都是 `Error: <code>: …` |
| H7 配置面 | ✅ | `limits.snapshotMaxChars:3000` → 同一夹具页快照 `2.8 KB / 14 refs / 70 lines`（默认 `7.7 KB / 47 refs / 169 lines`）；`fitWidth:false` + `browser_zoom({reset:true})` → `innerWidth 657 / scrollWidth 1908`、`window.scrollTo(600,0)` 后 `scrollX 600`；非法值 `snapshotMaxChars:-5` **被拒**、旧配置继续跑（桥日志仍 `snapshot start {maxChars:3000}`，且无新的 `host half applied` 帧）；清空后恢复默认 |

**本轮环境注记（复跑前必读）**

1. 每次改配置都会**重置桥端口与计数器**（本轮依次 12869 / 12457 / 3340 / 14295 / 2564 / 1399 / 12125 …），所以"`enqueued` 不增"这类断言必须在**同一次重启之后**取前后两读数。
2. **这台机器的 DNS 被劫持**：`no-such-host.invalid`、`nohost.test`、随机 `.com` 一律解析成功后被重置，实测落到 `navigation_failed: nav_reset (ERR_CONNECTION_CLOSED)`，**拿不到 `nav_dns`**。`nav_dns` 分类仍由单测覆盖（`plugin/test/navigation.test.mjs:31`，`ERR_NAME_NOT_RESOLVED (-105)` → `nav_dns`）。要真验 `nav_dns` 需换网络或改 hosts。
3. H7 的非法值不是"报错弹窗"型：写入后**没有任何新 apply 帧**，只有下一次操作还看着旧预算——判负条件要写成"旧配置仍生效"，不要等错误横幅。
4. 每次 `set_plugin` 都附同一条与本案无关的警告（`dream-skin (dsh-dream-skin): pending (waiting for service: webRuntime)`），不是回归。
5. `include:agent-browser-panel` 是插件条目 id；写 `agent-browser-panel` 会得到 `{"code":"unknown-plugin"}`。
