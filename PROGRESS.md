# 侧边栏 Agent 浏览器 — 开发工作区记录

> 对外介绍与安装说明见 [README.md](README.md)。本文件保留开发期的进度日志（状态表、目录、踩坑、下一步），仅供追溯。


> 目标：在 DeepSeek Harness 桌面端右侧栏里放一块**真浏览器面板**，并让 Agent 能像人一样操作它——看得见、点得动、能被用户随时接管。
>
> 本目录是该项目的工作区：规格、决策记录、取证材料、分解后的 ticket 都在这里。

## 现在到哪了

| 项 | 状态 |
|---|---|
| 可行性调研（现有插件 / 内置面板 / 主进程约束） | ✅ 完成 |
| 设计评审（grilling，10 个决策点） | ✅ 完成 |
| 技术规格 | ✅ 本文档集 |
| Ticket 分解 | ✅ 11 张 |
| 文档校订（按 asar 源码修正 tab 注册契约、引用错、路径错） | ✅ 2026-11-19 |
| 探针验证（能否 acquire 租约 + 挂 webview + 执行 JS） | ✅ 2026-11-19，U1–U6 全过（`docs/cases/002-probe-results.md`） |
| TICKET-002 双面包骨架（面板出现 + `browser_open` 真的打开网页） | ✅ 2026-11-19（`plugin/`，见 `docs/cases/003-channel-and-mount.md`） |
| TICKET-003 快照引擎（a11y 树 + ref + 截图） | ✅ 2026-11-19，验收全过（`docs/cases/004-snapshot-engine.md`） |
| TICKET-004 动作工具（click / type / press / eval） | ✅ 2026-11-19，验收 9.5/10 过（延迟一条按实测记录，`docs/cases/005-action-tools.md`） |
| TICKET-005 接管开关 + 验证检测 | ✅ 2026-11-20，10 条验收全过，用户亲手点过两轮（`docs/cases/006-takeover.md`） |
| TICKET-006 本地静态服务（`browser_open({ path })`） | ✅ 2026-11-20，验收全过 + 14 例单测全绿（`docs/cases/007-local-files.md`） |
| TICKET-007 打包成正式 bundle | ✅ 2026-11-20，tgz 47 KB / 16 文件；安装→禁用→启用→卸载→重装全流程实测（`docs/cases/008-packaging.md`） |
| TICKET-008 下载通道 | ✅ 2026-11-20 完成并验收（`downloads.js` + 第 7 个工具 `browser_download`），单测 18/18、真站 PDF/DOC 落盘且与 `Get-FileHash` 一致；`1.0.5` 装进 profile（`host half applied (rev 8)`） |
| TICKET-009 动作面三缺口 | ✅ 2026-11-20 完成并验收（`browser_scroll` + `browser_click({selector})` + 新窗口策略 A15），单测 20 例、面板夹具真跑全通过；行为验收在 `1.0.14`，`1.0.15` 只修包内 README；已装进 profile（`host half applied (rev 17)`） |
| TICKET-010 hover 与叠卡控件 | ✅ 2026-11-20 完成并装机（`browser_hover`，`1.0.19` / `HOST_REV 21`）：真 `mouseMove` + 二次解析求 `grew`；百度地图 `#mapType` 悬停后卡片从 x=349/354/359 展开到 167/263/359，再点地球卡成功切到 `maptype=B_EARTH_MAP`；夹具 ⑦ 叠卡同样通过（`docs/tickets/010-hover-and-stacked-controls.md`） |
| TICKET-011 表单目标与商品卡命中 | ✅ 2026-11-20 完成并装机（`1.0.22` / `HOST_REV 24`，行为验收在此版）：捕获阶段改写 `form[target]` + 打补丁 `HTMLFormElement.prototype.submit` + `navigated:false` 诚实提示 + 高卡片先试上沿；1688 搜索与商品卡两条假成功路径复验通过（`docs/tickets/011-form-targets-and-card-clicks.md`）。`1.0.23` 只补包内 README 的已知限制 |
| TICKET-012 面板缩放 | ✅ 2026-11-20 完成并装机（`1.0.24` / `HOST_REV 25`）：`browser_zoom` + 顶部 `− 100% ＋`；走原生 `setZoomFactor`，页面排版视口真的变宽（769→1538 CSS px @50%），缩放后点击仍命中（`docs/tickets/012-panel-zoom.md`） |
| TICKET-013 失败导航不毁现场 | ✅ 2026-11-22 完成并装机（`1.3.9`，`CLIENT_REV 37`）：导航失败自动回退到上一页，错误带 `nav_dns` / `nav_refused` / `nav_reset` / `nav_cert` / `nav_blocked` 等 stage 与原始 URL；停在 `chrome-error://` 时 `browser_snapshot` 与动作直接拒绝执行（`navigation_failed`，不再返回空树）。单测 6 例、全量 150/150（`docs/tickets/013-failed-navigation.md` §6） |
| 诚实性补丁 1.0.25 / 1.0.26 | ✅ 1.0.25（行为验收版）：class 版 disabled 的控件点击后追加 `Heads up: its class list says "layui-disabled"…`，`window.open` 的拦截提示不再被滚动吞掉；1.0.26 只补包内 README 的两条已知限制（class-disabled、附件链接是黑洞）。单测 59/59 |
| TICKET-014 激活档位 + 验证识别加固 | ✅ 2026-11-20 完成并装机（`1.0.27` 代码 / `1.0.28` 包文档，`HOST_REV 27` / `CLIENT_REV 27`）：配置 `activation` 三档 `auto`（默认，只有需要页面的动作才展开）/ `always`（每次动作都亮，`browser_download` 除外）/ `manual`（agent 不展开，没开就立刻报错）；1688 那种"验证码拦截"滑块页现在能判成 `needs_human`。单测 71/71（`docs/tickets/014-activation-levels.md`，决策见 `docs/decisions/004`） |
| TICKET-015 宽度自适应 + 整页截图 | ✅ 2026-11-20 完成并装机（`1.0.39`，`HOST_REV 28` / `CLIENT_REV 28`）：导航后自动把页面缩到面板宽度（`fitWidth`，可关）；`browser_screenshot` 长页**滚动拼接**成整页 PNG 落盘 `screenshots/`。政采结果页 `sh 3588` → `768 × 2472`、2 帧 + 尾帧、`truncated:false`，页头到页脚连续无重复。单测 82/82（`docs/tickets/015-fit-width-and-fullpage-screenshots.md`） |
| spec §10 验收审计（A1–A13 逐条对照） | ✅ 2026-11-20 审计：11 条通过（其中 A5/A6/A8 带实现偏差），A9 按实测改 spec；**A12 于 2026-11-23 重启实测补上最后一条证据**（无残留壳、零状态恢复、首次 `browser_open` 一把成功）——A1–A13 共 13 条全部有结论（`docs/cases/009-spec-audit.md`） |
| 全部 ticket | ✅ 完成——插件已作为真包安装在 profile 里 |
| spec 增补 A14 / A15 / A16 / A17 / A18 / A19 | ✅ 2026-11-20 已加，且**六条都已实现并勾选**：A14（1.0.5 下载落盘）、A15（1.0.14 同视图导航 + `blockedNewWindow`，1.0.21/1.0.22 补表单与假成功）、A16（1.0.19 悬停展开）、A17（1.0.24 面板缩放）、A18（1.0.27 激活档位 `auto`/`always`/`manual`）、A19（1.0.39 宽度自适应 + 整页截图） |
| 操作能力验证案例集（V1–V12） | ✅ 2026-11-20：V1–V6 / V9 实测通过，V10 复现 1 次**截图静默失败**，**V12 端到端主案例**（搜索「杭州市」→ 地球/卫星视图 → 截图并识别）按真实人工路径跑通（见 `docs/cases/010-validation-cases.md`） |
| D12「agent 操作时是否禁止人工输入」 | ✅ 2026-11-20 定案为**暂缓**：用户决定先不做。结论与落地要求已留档（`docs/decisions/002-human-input-during-agent.md`） |
| 任务级案例集 T1–T8 | 2026-11-20：**六个案例已执行** —— T1（1688 选品）L3、T4（规章下载落盘）L3、T5（PDF → 文号/日期闭环）L3、T6（翻页去重）L2–L4、T7（新窗口/附件行为）行为已记录、T8（404/WAF 换路）换路成功；**T2/T3 按用户指示暂缓**（1688 先不跑）。带出 4 条新缺口：失败导航丢现场（TICKET-013）、站内搜索 no-op、附件链接黑洞（改走 `browser_download`）、class 版 disabled 误报成功（1.0.25 已补提示）——见 `docs/cases/011-task-cases.md` |
| 行业调研验证方案 R1–R8 | 🧪 2026-11-20 **R4 / R8 已跑通**：政采中标取数（167 条 → 3 条核验，合计 11,406,200 元，L3）+ 交付链（素材落盘 → `report.docx` 3 页 → 三跳审计 `pass:true`，6 个 URL 全 200）。其余六案待跑；判定看"结论能不能核对"（`docs/cases/012-industry-research-cases.md`、产物 `docs/cases/outputs/`） |
| 硬化能力验证案例集（H1–H8） | ✅ 2026-11-22 **全部执行（1.4.8）**：H1–H8 全过；执行记录见 `docs/cases/013-hardening-cases.md` §7。专考 1.1.0–1.4.3 这轮新增的边界行为——取消（排队/在飞）、失败换路（默认关是否逐字不变）、鉴权与双实例隔离、策略收紧（eval/扩展名/会话名单）、三张过程卡片视觉、13 码错误契约、配置面（volatile vs 重载、非法值拒绝加载）、验证墙误判与人工接管后继续。每条带"判负条件"，并映射到发布说明 5 条未验证项（`docs/cases/013-hardening-cases.md`）。**2026-11-22 实测**：H7/H2/H3/H4 ✅ L3 通过（H3 16/16 脚本断言、H7 含非法值拒绝、H4 需分相执行）、H5 ✅ 目视通过（1.4.8，卡片此前"不显示"实为陈旧客户端 bundle，详见 §7.6 与 `docs/tickets/030`）、H1 ✅ GUI 停止按钮在飞取消（§7.7，页面留在上一页、桥日志有 cancel 帧）、H6 ✅ 6/6 码（`cancelled` 由 §7.7 补、`panel_not_open` 见 `docs/cases/014` S6-M1）、H8 ✅ 验证墙人工接管后继续（§7.9，墙时 snapshot 可用、人点按钮后 eval 恢复并取到三行表格）。**2026-11-23 在装机 1.4.13 上复跑**：H2/H3/H4/H6/H7 五案全过、无回归（H3 16/16 断言、H4 四相 A→D、H7 含非法值拒绝、H6 补齐 `panel_not_open`），记录见 §7.11 |
| 实操场景案例集（S1–S6） | ✅ 2026-11-23 **全部执行**：S1/S2/S3/S4/S6 ✅ L3（S1 清单、S2 隐藏面板三态、S3 受限策略取数、S4 子代理会话隔离、S6 故障自助）；**S5 ✅ L3**（1688「验证码拦截」→ 人过滑块 → 登录 → 续跑搜「男士马丁靴」取 3 款商品 + 3/3 回访，`docs/cases/outputs/S5-商品清单.md`）；跨站点条件另记 Cloudflare 挑战页漏报（TICKET-033）。产物在 `docs/cases/outputs/S*.md`，执行记录见 `docs/cases/014-practical-cases.md` §7。不再按"调工具看返回值"验，而是给真实工作需求（政采中标清单 / 会议截图配图注 / 禁 eval 禁 .dat 下取数 / 批量会话与人工会话隔离 / 验证墙交接后继续 / 拿 code 自助排障），每案必须先真的发生一个障碍（`navigation_failed`/策略拦截/验证墙/重载窗口/会话拉黑），否则记"条件未触发"不算通过（`docs/cases/014-practical-cases.md`）。**2026-11-22 实测**：S2 三态（最小化→`hidden` 文案；恢复但面板不在前台→"produced no picture"；面板回前台→`Saved screenshots/…` 46.0 KB）；**发现**：收起侧边栏、切换侧栏页签都**不**触发 hidden（仍是可见，截图成功），只有最小化窗口会——已写进 §7.4 复跑注意。**2026-11-23 在装机 1.4.13 上复跑**：S3 / S4 / S6 三案全过（S3 禁 eval 禁 .dat 下用快照取 7 行并落 `docs/cases/outputs/s3-extracted-rows.csv`；S4 子代理 `session_not_allowed` 且桥 `enqueued` 不增；S6 `panel_not_open`/`bridge_timeout`/`nav_reset` 三故障三处置），记录见 §7.6 |
| browser-use 契约核查 | ✅ 2026-11-20：结论**不能复用**官方浏览器工具——`ctx.browserUse` 只是一把 48 行的进程级互斥锁（`register(name) → release`），工具由 `@playwright/mcp` 等 MCP server 带来且本机未装；只借那把锁 + 横切契约（`docs/design/browser-use-contract.md`） |
| 官方文档对照 | ✅ 2026-11-20：读了 `develop/basic/{index,tool,config,publish}`、`framework/{index,service}`、`practice/`、`docs/cases/cookbook/adding-a-tool`、`docs/cases/capability-seams`，得出 12 条改进（P0 三条 / P1 三条 / P2 六条）与落地顺序（`docs/design/official-docs-review.md`） |
| SPEC-002 官方对齐与发布硬化 | ✅ 2026-11-22：规格（B1–B11、M1–M5、U1–U7、版本 1.1.0–1.4.0，`docs/spec/002-official-alignment-spec.md`）+ 11 张 ticket（`docs/tickets/016`–`025`、`027`）已写；**M1 = 016/017/018 已实现、装机 `1.1.1` 验收通过**（含验收期修掉的 gate 吞参 bug）；**TICKET-019 = 动态端口 + 每进程令牌 + 宿主发现路由，已实现并装机 `1.2.1` 验收通过**（验收期另修 TICKET-026 纯文本误判）；**TICKET-020 = 结构化错误码，已实现并装机 `1.2.3` 验收通过**（基类为何只能用本地类见 ticket §6.2）；**TICKET-021 = 取消一路传到面板，已实现并装机 `1.2.4` 验收（队列侧全绿，GUI 手测三步见 ticket §6.5）**；**TICKET-022 = 工具定义契约锁定（不迁 `defineTool`，清掉宿主不支持的 `minimum`/`maximum`、截图步骤保住结构化 `code`），已实现并装机 `1.2.5` 验收（7 例契约测试，前提修正见 ticket §0）**；**TICKET-023 = Web 过程卡片三张（`tool.call.toolview`：截图缩略图 / open 链接 / download 摘要，图片走附件 ref），已实现并装机 `1.3.0` 验收（卡片数据落盘证据见 ticket §6.3，视觉待用户确认）**；验收期另修 **TICKET-028**（截图 hidden 判别 + 取帧重试预算 + 可读文案，`1.3.4` 装机验收）；**TICKET-024 = 策略接缝（policy.js + ctx.tools.guard()：scheme/扩展名/输出预算/会话名单统一入口，profile 层不改代码即可收紧），已实现并装机 1.3.5 验收**；**TICKET-025 = 用户文档重写（五节，含 14 字段表、"整行替换不是深合并"警告、故障排查 13 行）+ `docs/decisions/005`–`009` + `tools/check-docs.mjs`（六项检查 + 5/5 负向自检），已实现并装机 1.3.6 验收**；M4 全部完成。**M5 的 U6/U7 探针已于 2026-11-21 完成**：U6 ✅ 能拿到 `exec.agent.session.requestContext().provider`（本机 `opencode-go`）；U7 ✅ `ctx.get('web')` 可用、cordis **无可选注入**（硬 inject 缺失服务 → 插件 `pending`、`apply()` 不执行）⇒ 接缝走 `ctx.get('web')` 判空。**探针同时发现**：`dsh-web` 只把 `deepseek-official`/`deepseek-account` 两条 route 偏好到免费 provider，本机 route 会默认落到计费的 `deepseek-search-api` ⇒ `searchFallback` 默认关的约束不变（详见 `docs/design/web-tools-and-agent-browser.md` §6.4 与 `docs/tickets/027` §3.1）。**TICKET-029 = 发现路由注册竞态**（apply 早于 webServer → 宿主发现路由 404 → 所有工具 `bridge_timeout`；改为等 `webServer` 出现再注册 + 每请求解析 connection），已实现并装机 `1.3.7` 验收；**TICKET-013 = 失败导航回退**（面板回上一页、错误带 `nav_*` stage、错误页拒绝空树），已实现并装机 `1.3.9` 验收。**TICKET-027 = 失败换路（`search-fallback`：失败时附同站候选、显式 `opened: false`、默认关、只搜 1 次并标 provider/route），已实现并装机 `1.4.2` 验收** ⇒ **M1–M5 全部完成、B1–B11 全部交付**（1.4.3 只改用户文档）。**2026-11-21 增补 B11**（与内置 `web_search` / `web_fetch` 的分工）+ `docs/tickets/027`（失败换路，已实现）。**2026-11-23 上线测试期加固**：TICKET-030（面板地址栏 `[object Promise]`、启动早期 `report()` 丢失、陈旧客户端 bundle 造成的"H5 卡片不显示"误判，`1.4.8`）、TICKET-031（同名工具冲突诊断：注册改为逐工具 `try/catch`、`/health` 新增 `diagnostics` 暴露 `tools/registered/conflicts/failed`，`1.4.9`）；**G2 真实站点测试又修两处 P0**：TICKET-032（人工接管后点商品没反应——根因是页面守护只在动作命令执行时安装，改为独立 `inject/guards.js` 在 `dom-ready`/每次导航注入；同票补面板 ‹ › ⟳ 工具栏，`1.4.10`→`1.4.11`→`1.4.12`），并登记 TICKET-033（真实 Cloudflare/Turnstile 挑战页漏报 `needs_human`，P2 不修、写进已知限制）；`docs/cases/013` H1–H8 至此全部执行 ✅、`docs/cases/014` S1–S4/S6 执行 ✅、S5 真墙实测 ⚠️（交接与登录通过，检测漏报判负）。候选版本随 G2 修复重冻为 **1.4.12**（128,572 B / 25 文件 / sha256 `16CAC4FF6B9D25A7D78512A6272EFA7E42353C21919331807CDDDC0651925CD4`），全量单测 **178 例** |
| 发布说明（对外分发） | ✅ 2026-11-22：`docs/release/release-notes-1.4.md`——1.4.3 产物与元数据、安装/升级/卸载、相对 1.0.x 的行为变化（动态端口/令牌/错误码/取消/卡片/策略/失败换路/截图可见性）、配置与计费、7 条已知限制、9 条未验证项、可复跑的发布检查清单、跨版本回滚的字段清理规则 |
| 上线测试计划（Windows 首发） | 🚧 2026-11-23 G0 ✅ / G1 ✅（同机法）/ G2 ⚠️ 部分通过 / G3 ✅（PTC 冒烟）/ G4 ✅（回滚演练）（`docs/release/launch-test-plan.md`）：6 道门禁——G0 自动化基线（**178 单测** + check-docs 双向 + 负向自检 + 打包一致性）、G1 **干净机器安装**（同机法：改名 npm 全局 DSH + 重启，插件仍激活，裸导入风险排除；真干净机签字项待补）、G2 真实站点验证墙交接（人工）、G3 **PTC 冒烟** ✅（PTC 预设下程序化批量调 `browser_open`/`snapshot`/`eval`/`screenshot`，含 `scheme_rejected` 错误码与重试，工具可见可调、无嵌套崩溃；提示词里的 `fullPage` 不是有效参数，整页拼接证据在 TICKET-015）、G4 **回滚与升级演练** ✅（1.4.9↔1.4.8↔1.3.6 四次装卸，配置与用户数据零变化，旧版容忍 1.4.x 新键）、G5 发布判断 ✅ **已签字（2026-11-23 15:12）**（报告 `docs/release/launch-report-1.4.13.md`）：装机事故已闭环——`pnpm install` 恢复 14/14 依赖、`dsh-plugin-panel-browser` 移出 bundles、重启后 `/health` = `tools 11 / registered 11 / conflicts []`，15:08 装机冒烟通过（`browser_open` → `snapshot` → `screenshot` 88,769 B / `d370eea5…`）；含用例分级（H/S 全跑、V 抽跑、T/R 上线后回归）、Windows 环境矩阵、P0/P1/P2 缺陷分级与一票否决清单、证据格式与回滚规则。候选版本 **1.4.13**（128,654 B / 25 文件 / sha256 `16CAC4FF6B9D25A7D78512A6272EFA7E42353C21919331807CDDDC0651925CD4`，G2 修复后重冻），排期约 2.5 天；G2 结果：真墙检测漏报（TICKET-033，已知限制）、过墙后登录与接管可用（TICKET-032 修复） |
| 与内置联网工具的分工 | ✅ 2026-11-21 定案：内置 `web_search` / `web_fetch` 是「匿名的一次性取文本」，本插件是「用户本人身份的真浏览器」；只在"读公开静态文章"重叠且内置更优。**不新增搜索类工具**；链路改为 `web_search(site:)` 找 → `web_fetch` 快读 → 要登录/要动手/要证据才开面板；搜索引擎只在失败路径当 URL 解析器（`docs/design/web-tools-and-agent-browser.md`，约束 `docs/spec/002` B11，已实现 `docs/tickets/027`：`1.4.2` 装机，默认关、附候选不打开） |
| TICKET-032 接管后的浏览闭环 | ✅ 2026-11-23 完成并装机（`1.4.12`）：独立 `inject/guards.js` 在加载即注入（`_blank` → 同视图、`window.open` 分驾驶方），面板补 `‹ › ⟳` 工具栏；修掉 1.4.10 只装一半守护的根因（守护原来只在动作命令时安装） |
| TICKET-033 验证墙漏报 | ✅ 2026-11-24 实现，2026-11-25 真站回归通过（1.5.2）：补 Cloudflare Turnstile 文案/iframe 信号、两条窄单类别例外、短 meta refresh 视为跳转页不误报；detector 新增 `pending`，`browser_open` 在 pending 时二次检测，让 open 本身返回 `needs_human`。真站回归：`nopecha.com/demo/cloudflare` → `needs_human`、`browser_eval` 被拒、人工过 Turnstile 后 `/demo` 可读 57 refs、普通站不误报。单测 detect 14 例（`docs/tickets/033-challenge-detection-gap.md`） |
| TICKET-037 首次写动作确认（host 判定与门） | ✅ 2026-11-24 实现（1.5.0），2026-11-25 验收收口（1.5.2）：新增 `plugin/approvals.js`（纯逻辑：归一化/分类/指纹/站点授权/summary）、`bridge.approve()` + `/decision` + `/page` + `/pending` 的 `approvals` 帧、`createGate` 在动作前 `await` 一次批准（click/press 先 `inspect` 判定提交类，坐标点击按读）、`browser_download` 走 `requestApproval`；错误码 13→16（`approval_required`/`timeout`/`denied`）；1.5.1 补 `apply.js` 薄门转发三个方法；1.5.2 加 `READ_TYPES={snapshot,inspect}` 防读命令抢相位、`approve()` 先看人工相位（`docs/tickets/037-first-touch-approval.md`） |
| TICKET-038 面板确认条与可见性快速失败 | ✅ 2026-11-24 实现（1.5.0，`CLIENT_REV` 47→48），2026-11-25 验收收口（1.5.2）：面板顶部确认条（允许一次 / 本会话允许本站 / 拒绝 + 30s 倒计时 + Enter=拒绝 + Alt+1/2/3）、`/page` 地址上报、`visibilitychange` 立即回 `unavailable`（<1s 失败而不是烧 30s）、接管时 pending 自动 deny；窄面板三按钮同时可见（`docs/tickets/038-approval-confirm-bar.md`） |
| TICKET-039 approvals 配置、错误码文档与验收夹具 | ✅ 2026-11-24 实现（1.5.0），2026-11-25 验收收口（1.5.2）：`approvals.{mode,timeoutMs,sensitiveSites}` 三处同步（`config.js` DEFAULTS / `index.js` Config / dist README 字段表+YAML）、根 README 错误码 13→16 与已知限制、SPEC-002 B5 实现期修正、新增 `docs/cases/015-first-touch-cases.md`（F1–F12）与 `docs/release/release-notes-1.5.md`；check-docs 六项全绿（`docs/tickets/039-approval-config-and-cases.md`） |
| TICKET-041 JS 弹窗拦截与记录 | ✅ 2026-11-26 实现并真机通过（1.5.3，`record` 模式）：`inject/guards.js` rev 3 拦截 `alert/confirm/prompt` 并按保守答案继续（`alert`→undefined、`confirm`→false、`prompt`→null），记录进 `window.__dshDialogs` 并由客户端附到 `open/snapshot/click/type/press/eval` 结果（`blocked dialogs` 段落）；新增 `dialogs.mode`（`record` 默认 / `off` 原生）；`CLIENT_REV` 49→50（修 `readDialogs` 把数组 `JSON.stringify` 后交给会先解码一次的 `evaluate` 导致二次解析失败的 bug）；单测 245→251（guards 7→12、config 10→12）；真机证据 `docs/cases/016-js-dialogs-cases.md`；`off` 模式真机对照待 TICKET-040 |
| TICKET-042 写动作回执三态 `effect` + `action_unknown` | ✅ 2026-11-26 实现并真机通过（1.5.4）：`bridge.js` 新增 `WRITE_TYPES`，`#drain()` 标记 `delivered`，超时/取消/接管/关闭五条「已下发回执丢失」路径改抛 `action_unknown`（`retryable:false`，details `{effect:'unknown',delivered:true,type,reason}`）；`tools.js` 成功结果 `effect:'committed'`、未发出错误 `details.effect:'none'`、eval 页面抛错改 `action_unknown`；`errors.js` 16→17 码；新增 `plugin/test/effect.test.mjs` 8 例、`cancel.test.mjs` 改断言 → 全量 251→259；真机 `docs/cases/017-action-effect-cases.md`（eval 页面抛错、接管中断两条 unknown；`Guest.eval` 15s 上限使纯超时只能靠单测覆盖）。 |
| TICKET-040 客户端重载后白屏 | 🟡 2026-11-26 收口（不可复现，已文档化规避）：静态勘察确认 DSH 外壳无整页刷新（asar 内 `location.reload` 0 命中）、客户端 bundle 是原地 entry 重载（HMR → `entries.reload`）、React slot 有 `SlotErrorBoundary`、渲染进程异常走错误页；四组最小实验（E1 客户端 entry 重载、E2 host 半重建 + 确认条交互、E4 bundle 启停、E3 重载后静置 5 分钟）**全部阴性**，DSH 未重启。历史两次白屏都在「重载后约 1 分钟内 + 面板交互」窗口，但未撞到；无可回读日志（host stdout 不落盘 / 无 crash / journal 不记配置编辑），根因停在假设层。规避流程：验收前重启一次 DSH、一次配好；不要边验收边改配置/启停 bundle；改完等面板重挂后重新 open；万一白屏直接重启。详见 `docs/tickets/040-blank-window-on-client-reload.md` 与 `docs/release/release-notes-1.5.md` |
| TICKET-043 F7/F8 安全真机验收 | ✅ 2026-11-26 真机通过（1.5.4）：按「改配置 → 用户完全重启 DSH → 一次性验完」路径（不热重载、不启停 bundle），F7 `sensitiveSites: [127.0.0.1]` 同 origin 第一次「允许一次」成功、第二次仍弹条且拒绝后未写入；F8 `mode:'off'` 下 type/eval/提交点击全部直接执行、无确认条、无 `approval_*` 错误码；恢复备份后默认 first-touch 再次弹条。三次配置生效均靠重启 DSH，全程未白屏。证据见 `docs/cases/015` §5 |
| TICKET-044 `browser_wait` 等待条件 | ✅ 2026-11-27 实现并真机通过（1.5.5，阶段 B1 第一个能力）：新工具 `browser_wait({selector?,text?,gone?,timeoutMs?})`——恰好传一个 selector/text，`gone` 反转，`timeoutMs` 默认 10000（夹到 100–15000）；页面侧 `inject/wait.js` 单次同步判定（selector 非法按「没找到」），轮询放在面板（150ms 间隔、可取消），超时是正常结果（`matched:false, timedOut:true`）不是错误码；`bridge.js` 的 `READ_TYPES` 加 `wait`（不抢相位，`needs_human`/`taken_over` 下可用、零审批）；`CLIENT_REV` 51、工具总数 11→12（check-docs 期望数同步）、`test/wait.test.mjs` 16 例 + bridge 2 例 → 全量 259→**277**；真机验收已完成（`demo/wait.html`；四种情形全过，证据见 `docs/cases/018`） |
| TICKET-045 快照稳定定位符 `loc=` | ✅ 2026-11-27 实现（1.5.6，阶段 B2 观察增强）：快照为每个带 `ref` 的交互节点追加 `[loc="css:…"]`（`#id`/`[data-testid]`/`tag[name]` 锚点 + `nth-of-type` 位置路径，`querySelector` 自校验，iframe 内带 `f1:` 前缀，>120 字符省略）；`browser_click`/`browser_hover`/`browser_type` 支持按 `loc` 寻址（与 `selector`、坐标点击互斥；`type` 的 `ref`/`loc` 二选一），审批门的提交类判断与密码框早退对 `loc` 同样生效；新增 `bad_loc`/`stale_loc` 错误分型（`effect:'none'`，重试安全）；`CLIENT_REV` 52；新增 `test/snapshot-loc.test.mjs` 3 例、actions +6、gate +2 → 全量 277→**288**；真机证据 `docs/cases/019` |
| TICKET-047 `browser_upload` 文件上传 | ✅ 2026-11-27 实现并真机通过（1.5.8，阶段 B1 操作补全）：第 13 个工具 `browser_upload({ref?,loc?,selector?,strict?,files})`——宿主读工作区文件（`realpathSync` 后必须落在工作区内；单文件 2 MiB / 合计 4 MiB / 最多 5 个）→ base64 走桥 → 页面 `DataTransfer`+`File` 合成并赋给 `input.files`、派发 `input`/`change`（不走 CDP、不开原生选择器）；新增不可逆写 `actionClass:'upload'`（首次站点确认，文案只含站点与文件名）、第 19 个错误码 `upload_rejected`（`retryable:false`，路径越界/缺失/超限/非 file input 都在读字节与弹条前拒绝）、`effect` 三态照常（已下发丢回执 → `action_unknown`）；`CLIENT_REV` 53→54，工具数 12→13；`test/upload.test.mjs` 10 例 + gate 3 例 → 全量 296→**309**；真机 7 项 + 三个验收期缺陷（inspect 丢 `acceptsFiles`、漏传 `source`、注定失败列表先弹条）记录在 `docs/cases/021-browser-upload-cases.md` |
| TICKET-048 `browser_scroll` 寻址滚动 | ✅ 2026-11-27 实现并真机通过（1.5.9，阶段 B1 操作补全）：`browser_scroll({ref?,loc?,selector?})` 把元素滚进视口（地址与动作工具同一套：`loc > selector > ref`，三者互斥，且不能与 `dy`/`to`/`container` 混用）；页面侧 `scrollIntoView({block:"center",inline:"center"})`，回执新增 `mode:"into-view"`、元素 `rect`、`visible`、`fullyVisible`、`info`、`frame`，旧 `dy`/`to` 行为不变（`mode:"by-dy"`/`"to-edge"`）；纯读零审批，但仍属 `INPUT_TYPES`（人工相位下被拒且不改变相位，不新增例外），地址失效复用 `stale_loc`/`bad_loc`；无新错误码、`CLIENT_REV` 不变；`test/scroll.test.mjs` 8 例 + bridge 1 例 → 全量 309→**318**；真机 `demo/scroll.html`（按 loc 滚到远端按钮 fully in view、按 ref 滚回、dy 旧行为、stale_loc、地址与 dy 混用被拒），证据 `docs/cases/022` |
| TICKET-049 页面 console 尾巴 | ✅ 2026-11-27 实现并真机通过（1.5.10，阶段 B2 观察增强）：`browser_snapshot` 末尾附两次快照之间页面打印的 console 日志与未捕获错误（最多 10 条渲染，带 `[log]`/`[warn]`/`[error]`/`[pageerror]`/`[unhandled]` 前缀），**每次快照清空**；页面侧 guards rev 3→4 包装 `console.log/info/warn/error/debug`（仍调用原函数）并监听 `error`/`unhandledrejection`，环形缓冲 40 条、每条截 240 字；面板 `readConsole()` 读出即清空（`CLIENT_REV` 54→55）；无新工具、无新错误码；验收期修掉「表单外无 type 按钮被误判为提交类」（`isSubmitControl` 改为需 form owner，符合 SPEC-003 C2）；`test/console.test.mjs` 4 例 + guards 4 例 + actions 1 例 → 全量 318→**327**；真机 `demo/console.html`，证据 `docs/cases/023` |
| TICKET-050 面板标签页（tabs） | ✅ 2026-11-27 实现并真机通过（1.5.12，阶段 B3 面板能力）：新增第 14 个工具 `browser_tabs({action:"list"/"switch"/"close", tab})`，`browser_open` 新增 `newTab`；每标签一个真实 webview + 独立租约（同 workspace 分区共享登录态），面板顶部标签条（标题/高亮/×/＋），命令路由到活动标签，关最后一个先建空白，`MAX_TABS=6`；错误码 19→21（`tab_not_found`/`tab_limit`），`CLIENT_REV` 55→56，工具 13→14；桥把 `tabs` 加进 `READ_TYPES`，但 `switch`/`close` 在人工相位被拒、`list` 放行；单测新增 `tabs.test.mjs` 8 例，327→335；真机证据 `docs/cases/024`（1.5.11 为内部构建、未发布） |
| TICKET-051 页面 network 失败尾巴 | ✅ 2026-11-27 实现并真机通过（1.5.13，阶段 B2 观察增强）：`browser_snapshot` 末尾附两次快照之间页面自己发出的 `fetch`/`XMLHttpRequest` 失败（最近 10 条，`- [fetch] GET /api → 404, 14ms` / `→ failed — TypeError: Failed to fetch`），抬头 `page network (M failed of N request(s)):` 写清失败数与请求总数（成功只进分母），**每次快照清空**；页面侧 guards rev 4→5 包装 `fetch`/XHR（仍调用原实现；opaque `no-cors` 不算失败），环形缓冲 40 条、只记失败、URL 同源缩成 `path+query` 并截 200 字；面板 `readNetwork()` 读出即清空（`CLIENT_REV` 56→57）；无新工具、无新错误码；`test/network.test.mjs` 4 例 + guards 6 例 → 全量 335→**345**；真机 `demo/network.html`，证据 `docs/cases/025` |
| TICKET-052 `browser_drag` 拖拽 | ✅ 2026-11-27 实现并真机通过（1.5.14，阶段 B4 操作补全）：第 15 个工具 `browser_drag({from:{ref|loc|selector}, to:{ref|loc|selector}|toX+toY|dx+dy, steps?})`——页面侧合成 `PointerEvent`+`MouseEvent` 序列（pointerover→pointerdown→每步 pointermove(buttons=1)→pointerup，步间 `frameWait()`，每步落点由 `elementFromPoint` 决定），`steps` 2–30 默认 8；新增第六类写动作 `actionClass:'drag'`（无法用 inspect 判是否改状态，一律首次触站必问，文案只含站点与源元素名），`INPUT_TYPES`/`WRITE_TYPES` 同步收编（人工相位拒绝、超时/接管走 `action_unknown`）；`CLIENT_REV` 57→58，工具 14→15，错误码仍 21（复用 not_found/multiple/occluded/disabled/out_of_view）；`actions.test.mjs` 45 例（含 8 例页面侧拖拽）+ 新增 `drag.test.mjs` 7 例 → 全量 345→**360**；已知边界：原生 HTML5 DnD 与 OS 文件拖拽不覆盖；真机 `demo/drag.html`，证据 `docs/cases/026` |
| TICKET-053 `browser_pick` 页内点选 | ✅ 2026-11-27 实现并真机通过（1.5.15，阶段 B4 人机协作）：第 16 个工具 `browser_pick({timeoutMs?})`——请人在面板页面上点一个元素，回执 `loc`（`css:` 路径，无唯一路径时为空）/`info`/`rect`/`point`，随后用 `browser_click {loc}` 操作；**点选那一下页面收不到**（window 捕获 `preventDefault`+`stopImmediatePropagation`，pointerdown 命中后再装一次性吞 click），页面状态不变，纯读零审批、错误码仍 21；`needs_human` 放行、`taken_over` 拒绝（`panel_taken_over`）、超时/Esc 正常回执；面板新增「取消点选」按钮并开始点选时把焦点交给页面（Esc 需页面键盘焦点）；验收期修四件：`inject/pick.js` 漏打包、取消谓词误用 `state.phase`、click 漏进页面、`loc` 缺 `css:` 前缀（`pickLoc`）；`CLIENT_REV` 59→60，工具 15→16；`pick.test.mjs` 15 例 → 全量 360→**375**；真机 `demo/pick.html`，证据 `docs/cases/027` |
| TICKET-054 `browser_pick` 框选 | ✅ 2026-11-27 实现并真机通过（1.5.16，阶段 B4 人机协作）：`browser_pick` 增加 `mode:"box"`（工具数仍 16，模式收进参数）——人拉一个框，回执给出框内元素列表（每项 `loc`/`info`/`rect`/`point`）、`box`、`total`（去重命中数）、`truncated`，`limit` 默认 20（夹 1–100）；框选仍是纯读——页面收不到按下/拖动/松手与结束后的 click，拖框期间页面文字不会被选中（body `user-select:none`，结束恢复）；框太小/框内无元素返回空列表 + `total:0` 正常回执；Esc/面板取消按钮中止，`needs_human` 放行、`taken_over` 拒绝，超时正常回执；桥不改（`pick` 已在 `READ_TYPES`），无新增错误码（仍 21），`CLIENT_REV` 60→61；`pick.test.mjs` 15→26 例 → 全量 375→**386**；真机 `demo/box.html`（框选复选框区域 21 目标/limit 10 截断、框选三条列表 10 目标、页面计数前后不变、用返回的 `css:[data-testid="row-export"]` 真点一次计数 +1、element 模式对照不泄漏），证据 `docs/cases/028` |
| TICKET-046 快照 `cursor` 续读 | ✅ 2026-11-27 实现并真机通过（1.5.7，阶段 B2 观察增强）：`browser_snapshot` 被字符预算截断时返回 `cursor`（`<stamp>@<offset>`，stamp = URL FNV-1a 指纹 + 总行数 + 引用数 + 字符数），带 `cursor` 再调用只取下一段并插 `- continued from line N of M` 抬头；页面在两次快照之间变化 → 第 18 个错误码 `stale_cursor`（`retryable:true`，hint 重拍整棵树）；续读默认不附图（`CLIENT_REV` 53）；新增 `plugin/test/snapshot-cursor.test.mjs` 7 例 → 全量 289→**296**；真机 `demo/long.html`（截断 16/132→续读不重复、追加 10 行后旧 cursor → `stale_cursor`、续读默认不附图 291.5 KB→584 B），证据 `docs/cases/020` |

## 一句话结论

- **没有任何现成插件能做这件事**。DSH 内置的右侧浏览器面板（`@deepseek-ai/dsh-client-ui-sidebar-browser`）只给你看，不给 Agent 控；`dsh-pilot` 能给 Agent 控，但开的是外部 Chrome，不在面板里。
- **自己做完全可行**：面板的 tab 类型是公开可插的，桌面端 `<webview>` 的租约入口挂在 `globalThis.dshDesktop.browser` 上，任何跑在同一渲染器里的客户端插件都能拿到。缺的那一层（host 工具 ↔ 面板 Remote 通道）在 `@deepseek-ai/dsh-experimental-client-ui-forge` 里有现成范式可抄。
- **有一条硬边界**：不做过验证/绕验证。产品里只做"检测到验证 → 暂停 → 用户接管 → 交还"。

## 目录

```
README.md                          对外介绍（首屏、安装、工具、案例）
PROGRESS.md                        ← 你在这里（开发期进度）
docs/
  browser-use-contract.md          为什么不能直接复用官方浏览器工具（证据链：48 行 Service、MCP provider、本机未装、三路线对比）+ 互斥锁接入设计与遗留验证
  web-tools-and-agent-browser.md   与内置 `web_search` / `web_fetch` 的分工：三层能力对比、唯一重叠区、`search → fetch → open` 判据表、四种"借搜索引擎"的做法与取舍、接 `ctx.web` 的 U6/U7 探针结论与计费风险
  official-docs-review.md          对照官方 7 页的 12 条改进清单（含 P0/P1/P2、成本、file:line 证据、落地顺序）
  launch-test-plan.md              Windows 首发上线测试计划：范围与不支持项、候选版本冻结清单、用例分级（H/S 全跑 · V 抽跑 · T/R 上线后）、G0–G5 门禁与通过标准、环境矩阵、执行顺序、缺陷分级与一票否决、证据模板、发布与回滚、上线后回归
  launch-report-1.4.13.md          1.4.13 上线报告：候选冻结点复核、G0–G5 逐条证据（含本轮 178/178 与装机冒烟）、G3 PTC 五项与两处偏差、装机事故时间线与修复、6 条已知限制、发布动作与 G5 签字表（**G5.4 已于 15:12 签字**），§9 归档 GitHub 仓库与初始提交
  release-notes-1.4.md             对外分发版发布说明：1.4.3 产物清单、安装/升级/卸载、相对 1.0.x 的行为变化、配置与计费、已知限制、未验证项、发布检查清单、跨版本回滚
docs/spec/
  001-agent-browser-plugin-spec.md 完整技术规格（工具契约、状态机、快照格式、安全边界）
  002-official-alignment-spec.md   官方对齐与发布硬化（B1–B11 全部交付、M1–M5 全部完成、U1–U7 已全部回填（U3 关闭）、版本 1.1.0–1.4.3）
docs/decisions/
  001-grilling-decisions.md        设计评审的 10 个决策 + 被否决的选项 + 被纠正的错误认知
  002-human-input-during-agent.md  D12：Agent 操作期间要不要禁止人工输入（**暂缓**，论证与落地要求留档）
  003-download-newwindow-and-task-cases.md  D13 下载通道 / D14 新窗口策略 / D15 任务级案例执行口径 / D16–D18 执行期修订（已定案）
  004-activation-and-challenge-detection.md D19 面板激活档位 / D20 挑战识别加固（已定并实现，1.0.27）
  005-loopback-bridge-over-cdp.md  通道选回环 HTTP 长轮询而不是 CDP（理由 / 代价 / 后果）
  006-no-reuse-of-browser-use.md   为什么不复用官方 `dsh-browser-use`（48 行 Registry 只是互斥锁，只借那把锁）
  007-single-package-three-roles.md 为什么保持单包三角色、不做预防性拆分（client bundle 只随已启用 Loader 条目走）
  008-auth-dynamic-port.md         动态端口 + 每进程令牌 + 宿主发现路由 + 静态 `/t/<token>/`（B2 的取舍与残留）
  009-web-tools-division-of-labor.md 与内置 `web_search`/`web_fetch` 的分工契约（不新增搜索工具；失败换路归 027）
  README.md                        决策索引（编号 / 主题 / 状态）+ 新增决策的书写约定
docs/cases/
  001-dsh-browser-internals.md     取证材料：asar 里的真实代码路径与关键代码片段
  002-probe-results.md             探针实测结果（U1–U6 逐项证据 + 四个坑）
  003-channel-and-mount.md         通道选型、Slot 分发键、CORS 预检、非当前会话限制、开发循环
  004-snapshot-engine.md           快照引擎：输出格式、截图链路、capturePage 三个坑、实测数据
  005-action-tools.md              动作工具：ref/坐标两条路、帧偏移、输入法、导航回退、长轮询延迟
  006-takeover.md                  接管：host 相位机、门控矩阵、检测器两类门槛、交接摘要、两个同源 bug
  007-local-files.md               本地文件：为什么必须挂 HTTP 壳、两道安全闸、错误码表、三个误判现象
  008-packaging.md                 打包：发布结构、exports 六出口、元数据规则、安装四态、link→包的一次重启、两道 Windows 坑
  009-spec-audit.md                spec §10 的 A1–A13 逐条审计：证据、三处实现偏差、A9 修正、A12 重启实测通过（2026-11-23）
  010-validation-cases.md          操作能力验证案例集 V1–V12：覆盖矩阵、坐标点击打 canvas、截图静默失败复现与修法、V12 端到端（搜索→地球→截图识别）
  011-task-cases.md                任务级案例集 T1–T8（**T1/T4/T5/T6/T7/T8 已执行，T2/T3 暂缓**）：1688 选品/比价/登录墙、规章下载落盘、PDF 文号闭环、翻页去重、新窗口与附件行为、404/WAF 换路 + 缺口登记
  012-industry-research-cases.md   行业调研验证方案 R1–R8（**R4 / R8 已跑通，其余六案待跑**）：医保目录/年报数字/法规时效/政采中标/文献结论/土地成交/供应商资质 + 素材落盘与正式报告，判"结论可核对"
  013-hardening-cases.md           硬化能力验证案例集 H1–H8（**全部执行**：H1–H8 ✅，见 §7）：取消/失败换路/鉴权隔离/策略收紧/过程卡片/错误契约/配置面/验证墙误判 + 每条"判负条件"与发布说明未验证项映射
  014-practical-cases.md           实操场景案例集 S1–S6（**全部执行（2026-11-23）**：S1–S6 全 ✅ L3，S5 见 `docs/cases/outputs/S5-商品清单.md`，见 §7）：用真实工作（政采清单/会议截图/受限策略取数/会话隔离/验证墙交接/故障接手）逼出硬化能力，每案带"障碍步 M 必须真的发生"规则
  shots/                           取证截图（`baidu-earth-hangzhou.png` 地球/卫星视图下的杭州（V12 主案例）、`guangzhou-terrain.png` 广州地势图、`baidu-guangzhou-14z.png` 坐标点击到 14z、`baidu-earth-guangzhou.png` 同视图下的广州（历史））
dist/
  dsh-plugin-agent-browser/         发布产物（扁平结构，纯 JS 无构建）
    dsh-plugin-agent-browser-1.5.16.tgz 364,587 B / 28 文件，现役版本，`plugin_manager install_bundle` 直接装（sha256 `bf7d8a46c1773e6728143e2aa2ced383e4b190f32c0ee8f08b85d853e2db8065`；相对 1.5.15：TICKET-054 框选——`browser_pick` 增加 `mode:"box"`，人拉框返回框内元素列表（`loc`/`info`/`rect`/`point` + `box`/`total`/`truncated`，`limit` 默认 20 夹 1–100），页面收不到框选事件、拖框不选中文字，纯读零审批、错误码仍 21，`CLIENT_REV` 60→61，工具数仍 16；真机证据 `docs/cases/028`）
    dsh-plugin-agent-browser-1.5.15.tgz 361,128 B / 28 文件，上一个版本，`plugin_manager install_bundle` 直接装（sha256 `6c0207aa63e98d3025d41b0ca9403b6301b1e22375d93f57116d6b463eb4b200`；相对 1.5.14：TICKET-053 页内点选——第 16 个工具 `browser_pick`，请人点元素拿 `loc`/`info`/`rect`/`point`，点选不触发页面（window 捕获 + 吞 click），纯读零审批、人工相位 needs_human 放行/taken_over 拒绝，面板「取消点选」按钮，`CLIENT_REV` 59→60，工具 15→16；真机证据 `docs/cases/027`）
    dsh-plugin-agent-browser-1.5.14.tgz 353,275 B / 28 文件，（历史）被 1.5.15 取代，`plugin_manager install_bundle` 直接装（sha256 `285eaf9f546d1a202429f073ad2ee1eecbb0898cc25dd04840148e9084d1851f`；相对 1.5.13：TICKET-052 拖拽——第 15 个工具 `browser_drag`，页面侧合成 pointer/mouse 序列（落点按 `elementFromPoint`），`from` 地址 + `to` 地址/视口点/`dx`+`dy`，`steps` 2–30；新增第六类写动作 `drag`（首次触站必问）；`CLIENT_REV` 57→58，工具 14→15，错误码仍 21；真机证据 `docs/cases/026`）
    dsh-plugin-agent-browser-1.5.13.tgz 348,861 B / 28 文件，（历史）被 1.5.14 取代，`plugin_manager install_bundle` 直接装（sha256 `1ADC4DFF24A33080372FD6078CC708724F4B235200CC53B89AFBCC270C1AB12B`；相对 1.5.12：TICKET-051 页面 network 失败尾巴——`browser_snapshot` 末尾附页面自己 fetch/XHR 的失败（最多 10 条、含状态/耗时/错误，抬头写 M failed of N request(s)，每次快照清空），guards rev 5 只记失败、成功只进分母，`CLIENT_REV` 56→57，无新工具/错误码；真机证据 `docs/cases/025`）
    （历史）dsh-plugin-agent-browser-1.5.12.tgz 346,051 B / 28 文件，被 1.5.13 取代，`plugin_manager install_bundle` 直接装（sha256 `4BAD7FA1CE8A3D029E7E6F98BA1FC8528BFBB34548AFD30B5535D4CB493BF0F5`；相对 1.5.10：TICKET-050 面板标签页（tabs）——新工具 `browser_tabs`（list/switch/close）与 `browser_open.newTab`，每标签独立真实 webview + 租约（同 workspace 共享登录态），面板标签条、关最后一个先建空白、`MAX_TABS=6`，错误码 19→21、`CLIENT_REV` 56、工具 13→14；`list` 显示真实 URL、空白标签显示「新标签页」；1.5.11 为内部构建、未发布；真机证据 `docs/cases/024`）
    （历史）dsh-plugin-agent-browser-1.5.10.tgz 339,454 B / 28 文件，被 1.5.12 取代，`plugin_manager install_bundle` 直接装（sha256 `0E1E4FFE5B6D64F80E5936CD29564B2C83F6ED358E6DD7B022FB472F412735CA`；相对 1.5.9：TICKET-049 页面 console 尾巴——`browser_snapshot` 末尾附加两次快照之间的页面 console/未捕获错误（最多 10 条、每次快照清空），无新工具、无新错误码、`CLIENT_REV` 54→55，并修掉「表单外无 type 按钮被误判为提交类」；真机证据 `docs/cases/023`）
    dsh-plugin-agent-browser-1.5.9.tgz 337,820 B / 28 文件，（历史）被 1.5.10 取代（sha256 `707FC466A4D5EC08D8BE6C0C9E70AE226A1D07D9D04A3C3FE42C06C912B6A0DC`；TICKET-048 `browser_scroll` 寻址滚动）
    dsh-plugin-agent-browser-1.5.8.tgz 336,112 B / 28 文件，上一个版本，`plugin_manager install_bundle` 直接装（sha256 `9ED041CB3CEA104A46A83D1E19BF7CF94C5521915E928892563F5CB58558DD91`；相对 1.5.7：TICKET-047 `browser_upload` 文件上传——第 13 个工具，把工作区文件合成 `File` 放进 `<input type=file>`，新增不可逆写审批类 `upload` 与第 19 个码 `upload_rejected`，`CLIENT_REV` 54；工具数 12→13、配置字段仍 21；真机证据 `docs/cases/021`）
    （历史）dsh-plugin-agent-browser-1.5.7.tgz 330,413 B / 28 文件，被 1.5.8 取代（sha256 `1EF93A55DADBF4783BD32BDCE78DE4EBC8ED935BC2554CE31964210C70613D3E`；TICKET-046 快照 `cursor` 续读）

dash-plugin-agent-browser-1.5.6.tgz 328,742 B / 28 文件，上一个版本，`plugin_manager install_bundle` 直接装（sha256 `1D2933C768F2BAB28CF708F103323B5A94F0F20B57530B4C8B946701A5E4DA22`；相对 1.5.5：TICKET-045 阶段 B2 观察增强——快照为带 ref 的交互节点追加 `[loc="css:…"]`（`#id`/`[data-testid]`/`tag[name]` 锚点 + `nth-of-type` 位置路径，`querySelector` 自校验，iframe 内带 `f1:` 前缀，>120 字符省略），`browser_click`/`browser_hover`/`browser_type` 支持 `loc` 寻址（与 selector、坐标互斥；type 的 ref/loc 二选一），`bad_loc`/`stale_loc` 分型且无法解析的地址不弹确认；`CLIENT_REV` 52；工具数仍 12、配置字段仍 21，工具 schema 只新增可选 `loc`；真机证据 `docs/cases/019`）
    （历史）dsh-plugin-agent-browser-1.5.5.tgz 325,936 B / 28 文件，被 1.5.6 取代（sha256 `F75E76AE347F2BAC0FB392DA9F6DF4B70AB145189DD31A27D99791157757C38A`；TICKET-044 `browser_wait` 见上方 ticket 行）
    （历史）dsh-plugin-agent-browser-1.5.4.tgz 322,516 B / 27 文件，被 1.5.5 取代，`plugin_manager install_bundle` 直接装（sha256 `A757E17C36DEEE479686B05867F4B4E1103FA76C9B9B539DF9333F5B0EE2F405`；相对 1.5.3：TICKET-042 写动作回执三态——写工具成功结果带 `effect:'committed'`、未发出错误带 `details.effect:'none'`，新增第 17 码 `action_unknown`（已拉走但回执丢失：超时/断线/取消/接管/关闭；`retryable:false`，hint 先 snapshot 核对勿重发）、`browser_eval` 页面抛错改报 `action_unknown`；工具 schema 未变（新增 `effect` 输出字段），`CLIENT_REV` 50、通道与快照格式未变；真机证据 `docs/cases/017-action-effect-cases.md`）
    （历史）dsh-plugin-agent-browser-1.5.3.tgz 320,316 B / 27 文件，现役版本，`plugin_manager install_bundle` 直接装（sha256 `8F6C19AE570CADB33B791DDD86CD505F7B87A73D02FC67D58AFFEA7876E5FFAF`；相对 1.5.2：TICKET-041 JS 弹窗拦截与记录——`inject/guards.js` rev 3 拦截 `alert/confirm/prompt` 并按保守答案继续（内容以 `blocked dialogs` 出现在工具结果、下一次 snapshot 也能带出）、新增 `dialogs.mode`（`record` 默认 / `off` 原生）、`CLIENT_REV` 48→50（弹窗结果回传 + `readDialogs` 二次解码修复）、config 顶层字段 11→12、工具 schema 未变；真机证据 `docs/cases/016-js-dialogs-cases.md`）
    （历史）dsh-plugin-agent-browser-1.5.2.tgz 317,228 B / 27 文件，被 1.5.3 取代（sha256 `093E706CCC19404BB2EC7710B7D816DE7F54A47F4D023950AF477E4FC3D8A787`；相对 1.4.24：TICKET-033 验证墙漏报修复 + SPEC-003 首次写动作确认（`approvals` 三字段、16 错误码、面板确认条、`CLIENT_REV` 48、新增 `approvals.js`）；1.5.1 修验收期宿主半缺陷（`apply.js` 薄门没转发 `approve`/`hasClient`/`pageOf` → `canAsk()` 恒 false、写动作不弹确认；密码框先弹条后被页面硬拒）；1.5.2 修相位优先级（`bridge.request()` 的读命令不再抢回 `agent` 相位、`approve()` 先看人工相位）与 eval 提示的 origin（改由页面侧 `inspect` 提供，不再依赖 `/page` 遥测）；工具 schema 未变、通道与快照格式未变；见 `docs/release/release-notes-1.5.md`）
    （历史）dsh-plugin-agent-browser-1.5.1.tgz 316,836 B / 27 文件，被 1.5.2 取代（sha256 `7143A2B793EF691A453DB637FDB5EC25ACEFE01E92B36AE867B1BA2607687CD5`，缺陷见上）；dsh-plugin-agent-browser-1.5.0.tgz 316,504 B / 27 文件，被 1.5.1 取代（sha256 `2994CD130E5397543A5C62FE04B61E18AC0D74D22FFE94590186AA9BDB4B6343`）；1.4.24 包 sha256 `55086470b4bb7c615ffbed19dfa998e08783b63158e66a1d269713d6b46620f5` 留作回滚
    dsh-plugin-agent-browser-1.4.24.tgz 301,545 B / 26 文件，上一个版本，`plugin_manager install_bundle` 直接装（sha256 `55086470b4bb7c615ffbed19dfa998e08783b63158e66a1d269713d6b46620f5`；相对 1.4.23 只是**详情页素材**：`docs/settings-page.png`（168,637 B，sha256 `49b8220e…`）随包发布，`docs/DETAIL.md` 在特性图下面补一行「设置 → 浏览器面板」的截图，插件页能直接看到配置入口；装机热生效，桥端口不变）
    dsh-plugin-agent-browser-1.4.23.tgz 141,446 B / 25 文件，文档版，`plugin_manager install_bundle` 直接装（sha256 `48c22bd32ece8adb7cec4e7de8ce204f5923241b0312822494a5ce255ef51383`；相对 1.4.22 **只改文档**：`README.md` 里 `activation` 的 `auto` 档写清「只在这个会话还没有活面板时展开一次，之后不动布局」，与根 README 新增的「「面板自动打开」到底管什么」小节对齐；装机行为与 1.4.22 完全一致）
    dsh-plugin-agent-browser-1.4.22.tgz 141,393 B / 25 文件，上一个版本，`plugin_manager install_bundle` 直接装（sha256 `c8c936deee833afdfdefd8563ec1fa1c7dff4c9107b42fc89ed4b5f11096f21e`；相对 1.4.18 加三件事：①设置页「浏览器面板」（`settings.section`，13 个字段成表单）②桥新增 `GET/POST /config`（读值 + 写配置，走宿主 config editor，不碰 `cordis.patch.yml`）③修掉写配置时的 `HMR transactions cannot be nested`（桥的请求回调继承 apply 的 HMR 事务，写前用 `hmr.executing.exit()` 跳出）。详见 `docs/tickets/036`）
    dsh-plugin-agent-browser-1.4.18.tgz 133,744 B / 25 文件，路由默认关版（sha256 `dc0498073be63dc39d097494cdd7ab12c802da4b692f9efa6f567406618f9e52`；`routing` 默认值 `auto` → `off`——分流说明改由人决定开不开，装机实测 `/health` 为 `mode: off / injected: false`，见 `docs/design/web-tools-and-agent-browser.md` §10.5）
    dsh-plugin-agent-browser-1.4.17.tgz 133,592 B / 25 文件，路由可观测版（sha256 `a03a22084bc2877162390c11ebba511c1244e6f9580a35bb1d4cce1e0e1fa17e`；`/health` 里出 `routing: {mode, injected, order, competitors}`，`apply.js` 导出 `routingState()`，`HOST_REV` 34，见 `docs/tickets/035`）
    dsh-plugin-agent-browser-1.4.16.tgz 132,675 B / 25 文件，默认路由版（sha256 `b9a735a3ad25abec4cdbf2aaa0350cb15e38a9ca4821a3ba340321acc37137e2`；把「什么时候用本插件」写进**系统提示词**段落 `agent-browser-routing`（order 3050），并加 `routing: auto|on|off` 配置，默认 `auto`；相对 1.4.15 见 `docs/tickets/035`）
    dsh-plugin-agent-browser-1.4.15.tgz 130,355 B / 25 文件，工具描述版（sha256 `8b969771e24ac17ae9aab93626742fc8bda3f5d731a8f720de4753c4b4c5f2e8`；相对 1.4.14 只改了 `browser_open` / `browser_snapshot` 的工具描述，补"When to use it / When not to"一段，正文见 `docs/design/web-tools-and-agent-browser.md` §10）
    dsh-plugin-agent-browser-1.4.14.tgz 130,042 B / 25 文件，截图回执修复版（sha256 `f5886f735eaf6b6f30582720ab9bf8e7d62f5a15999bec38db2d57052c244af2`；相对 1.4.13 只改了截图回执这一条：`bridge.js` 请求体上限 4 MiB → 32 MiB 并回 413 `budget_exceeded`，`client.js` 加 24 MiB 预检与纯错误重投，见 `docs/tickets/034`）
    dsh-plugin-agent-browser-1.4.13.tgz 128,654 B / 25 文件，Windows 首发冻结候选（sha256 `16CAC4FF6B9D25A7D78512A6272EFA7E42353C21919331807CDDDC0651925CD4`；历史：1.4.8 122,684 B、1.4.3 122,217 B、1.4.2 121,537 B、1.4.1 121,337 B、1.4.0 121,275 B、1.3.10 115,861 B、1.3.9 115,616 B、1.3.8 115,385 B、1.3.7 111,792 B、1.3.6 111,390 B / 22 文件、1.3.5 107,274 B、1.3.4 103,685 B / 21 文件、1.3.3 103,574 B、1.3.2 103,558 B、1.3.1 103,387 B、1.3.0 103,206 B、1.2.5 99,702 B、1.2.4 99,175 B、1.2.3 96,597 B、1.2.2 96,392 B、1.2.1 93,530 B、1.2.0 93,339 B、1.1.1 88,238 B、1.0.39 82,940 B / 17 文件、1.0.3 47,430 B / 16 文件）
    index.js / apply.js / config.js / errors.js / policy.js / navigation.js / bridge.js / tools.js / downloads.js / static.js / client.js / inject/ / locale/ / docs/ / icon.svg
plugin/                             开发期插件源码（纯 JS，**无 package.json**；包清单只在 dist/）
  cordis.patch.yml                  插入 loader 条目 `agent-browser-panel`（`plugin_manager set_plugin target="include:agent-browser-panel"`）
  index.js                          host 入口：schemastery Config（四组 + 四个 volatile）→ 转调 `apply.js`
  apply.js                          host 装配：Bridge / StaticSites / 浏览器互斥申领 / 发现路由 / 唯一 `ctx.effect` 有序清理
  config.js                         默认值与归一化（`normalizeConfig`、`readField` 兼容 volatile 读取器）
  errors.js                         16 个稳定 code 的 `AgentBrowserError`（本地同形基类，见 ticket 020 §6.2）
  approvals.js                      首次写动作确认的纯逻辑：`normalizeApprovals` / `originOf` / `isSensitive` / `clickClass` / `pressClass` / `actionClassFor` / `fingerprint` / `summarize` / `createGrantBook` / `shouldConfirm` / `parseDecision`
  bridge.js                         host 侧命令队列 + 相位机（127.0.0.1 动态端口 + 每进程 43 字符令牌 + Host 校验，长轮询 + /logs /state /phase /source /page /decision，含 `approve()` 审批等待）
  static.js                         工作区只读静态服务（127.0.0.1 + 随机端口 + `/t/<token>/` 路径令牌 + `ab` cookie，路径双闸校验）
  downloads.js                      下载落盘（host 侧 fetch、50 MiB 上限、sha256、绝不覆盖）
  activation.js                     激活档位（auto/always/manual → 命令上的 show=once/always/never）
  policy.js                         策略层：scheme / 扩展名黑名单 / 输出预算 / 会话名单（createPolicy，工具体与 ctx.tools.guard() 共用）
  tools.js                          工具定义（open / snapshot / wait / click / scroll / hover / zoom / screenshot / type / press / eval / download，共 12 个；三个工具带 `presentationMeta`）
  search-fallback.js                失败换路：同站候选（`<host> <路径词>` 查询 → 客户端同站过滤；默认关）
  client.js                         client 入口：tab 类型 + 面板 body（徽章/接管/红框/确认条）+ 轮询器 + webview + 三个 `tool.call.toolview` 卡片
  inject/snapshot.js                页面内遍历器（纯字符串注入，每次调用读盘）
  inject/actions.js                 页面内动作器（定位/滚动/写入/密码拒），同一注入方式
  inject/wait.js                    页面内等待探针（单次同步判定 selector/text/gone，轮询与预算在面板）
  inject/detect.js                  页面内验证检测器（URL/标题 + DOM + 强文案/单类别例外 + 短 meta refresh 跳转判定 + `pending` 标记 + `contentType` 门 + 页面内红框）
  test/config.test.mjs              配置面单测（10 例：默认值/局部覆盖/非法值/读取器/approvals 组与非法 mode）
  test/policy.test.mjs              gate 策略单测（3 例：show/fit 每命令重读、缺省回落 auto）
  test/approvals.test.mjs           首次写动作确认纯逻辑单测（18 例：归一化/分类/指纹/授权本/敏感站/决定解析）
  test/policy-extra.test.mjs        策略接缝单测（6 例：scheme/扩展名黑名单/输出预算/会话名单/guard 先于工具体）
  test/lifecycle.test.mjs           生命周期单测（5 例：单 effect、逆序清理、单步失败不中断、AggregateError、display policy 透传）
  test/bridge.test.mjs              桥单测（20 例：关闭快速 reject、关闭后拒新、幂等；审批流 approve/decision/timeout/不可见/接管/page 回读；人工相位优先于审批提示、读命令不抢相位；`wait` 在 needs_human/taken_over 下可用；`scroll` 在 needs_human 下被拒且不改变相位）
  test/errors.test.mjs              错误码单测（8 例：码表/前缀/toJSON/旧前缀/面板文案映射）
  test/cancel.test.mjs              取消单测（7 例：预取消不入队、摘队列留 cancel 帧、迟到回包 ignored、三码区分、不影响其他会话、监听器不泄漏、工具层零调用）
  test/tooldefs.test.mjs            工具定义契约单测（7 例：register 硬要求、参数/输出 schema 子集、render lossless、budget 夹取）
  test/toolviews.test.mjs           过程卡片单测（8 例：key 对齐工具名、四态不抛、缩略图、下载摘要、presentationMeta 形状）
  test/navigation.test.mjs          导航失败单测（6 例：14 组 ERR_* → stage、code 抓取、证书不可重试、回退两套文案、`classifyOpenFailure` 保留 code、非导航错误原样返回）
  test/static.test.mjs              静态服务单测（`node --test`，含 token 路径/302 cookie/Host 校验）
  test/downloads.test.mjs           下载通道单测（18 例：命名/百分号解码/上限/不覆盖/分型）
  test/actions.test.mjs             动作面单测（45 例（含 TICKET-052 页面侧拖拽 8 例）：命中测试分型/两趟采样/表单目标/`navigated`/滚动/拦截警告/悬停三态/class 版 disabled）
  test/activation.test.mjs          激活档位单测（6 例：三档 → show 映射、未知值回落）
  test/detect.test.mjs              验证检测单测（14 例：1688 滑块命中、帮助页不算墙、纯文本降级命中、`contentType` 门、Turnstile 文案/iframe、pending、title-only、meta refresh 不误报）
  test/shots.test.mjs               截图落盘单测（8 例：命名清洗/重名不覆盖/base64 对拍/sha256）
  test/search-fallback.test.mjs     失败换路单测（14 例：查询构造/触发矩阵/默认关/volatile/不泄漏 content/降级/上限夹取）
  test/wait.test.mjs               等待工具单测（16 例：探针可见性（渲染/隐藏骨架/visibility/零盒子）/gone/text/非法选择器/invalid + 工具零审批/夹取/参数校验/页面报错/注册总数）
  test/snapshot-loc.test.mjs        快照 loc 单测（3 例：#id 锚点 / 位置路径 / 快照打印的 loc 交给 inspect 对拍）
test/snapshot-cursor.test.mjs     快照续读单测（7 例：cursor 透传与截图抑制 / 字段映射 / stale → stale_cursor / 超长 cursor 拒绝 / render 续读文案）
  test/guards.test.mjs             接管守护与页面观测单测（22 例：安装标记/不重装、`_blank`→`_self`、嵌套节点、命名 target + form submit、agent 拦 `window.open`、human 同视图导航 + TICKET-041 弹窗 5 例、TICKET-049 console 4 例、TICKET-051 fetch/XHR 失败记录 6 例）
test/png.test.mjs                 PNG 编解码单测（3 例：按标记切出出厂代码，编码→解码逐像素对拍）——全量 **386 例**
test/upload.test.mjs              browser_upload 单测（10 例：路径/限额/审批前置/inspect 阈值/页面侧合成 File）
test/scroll.test.mjs              browser_scroll 寻址滚动单测（8 例：工具层 dy/loc 映射、地址互斥与零请求、stale_loc 透传；页面层 scrollIntoView 一次、rect/visible/fullyVisible、stale loc 不动页面、bad_loc）
    test/console.test.mjs             browser_snapshot 的 console 尾巴单测（4 例：映射与 render、无日志时逐字不变、只留 10 条并报隐藏数、畸形条目丢弃）
  test/tabs.test.mjs                面板标签页单测（8 例：open 的 newTab 透传、list 映射与 render、缺 tab 零请求、switch/close 回执、人工相位 list 放行而 switch 被拒、21 码与 tab_not_found 分类）
  test/network.test.mjs             browser_snapshot 的 network 失败尾巴单测（4 例：映射与 render、无失败时逐字不变、只留 10 条并报隐藏数、畸形条目丢弃）
  test/drag.test.mjs                browser_drag 单测（7 例：from/to 地址映射与 `effect`、ref+toSelector/视口点/dx-dy 参数名、非法入参零请求、occluded/越界文案）
  test/pick.test.mjs                browser_pick 单测（26 例：页面侧 start/hover/pointerdown 吞点击/Esc/stop 幂等/重复 start/window 捕获吞 click/无 pointerdown 的合成 click/`css:` 前缀；工具侧参数校验/超时/取消/映射与 render/注册总数）
test/gate.test.mjs                审批接缝单测（11 例：type/提交点击先 inspect 再问、密码框不问、普通链接与坐标点击不问、站点授权只问一次、mode off、宿主不能问时退回 1.4 行为、下载与拒绝路径、eval 先 inspect 拿页面 origin）
  test/smoke-download.mjs           真实下载冒烟脚本（不进包；`node plugin/test/smoke-download.mjs`）
screenshots/                         `browser_screenshot` 的落盘目录（整页拼接 PNG，重名加 `-1`/`-2` 绝不覆盖）
demo/                               静态服务的验收页（`index.html` + `a.css` + `data.json` + `img/b.png` + `ticket-009.html` 动作面夹具 + `approval-form.html` / `approval.txt` 首次写动作确认夹具 + `dialogs.html` JS 弹窗夹具 + `wait.html` 等待条件夹具 + `long.html` 快照续读夹具 + `scroll.html` 寻址滚动夹具 + `drag.html` 拖拽夹具与 pointer 计数 + `pick.html` 页内点选夹具（图标按钮 / 重复行 / canvas / 页面点击计数） + `box.html` 框选夹具（10 个复选框 / 3 行重复导出 / 订单卡片 / 页面点击计数））
tools/probe/                              探针实现（已卸载，保留作证据；`shot-*.png` 是 U6 截图）
tools/
  pack.mjs                          把 plugin/ 复制源文件进 dist/ 再 `npm pack`，打印体积与安装命令
  asar.mjs                          只读取证工具：ls / cat / grep asar 内文件
  testsite.mjs                      本地多页夹具（/ /form /long /heavy /frames /canvas + 8796 跨域 peer）
  check-docs.mjs                    文档 ↔ 代码一致性检查（配置字段 / 工具名 / 示例 YAML 默认值 / decisions 索引 / B11 引用 / docs 的 file:line 漂移），全绿退出 0
  check-docs-negative.mjs           check-docs 的负向自检：逐个注入漂移，必须被抓住（5/5）
docs/cases/outputs/                           调研类产物（012 的交付物 + S 集产物：`S1-中标清单.md` / `S3-表格数据.md` / `S4-会话隔离.md` / `S5-商品清单.md` / `S6-故障处置.md`）
  R4-政府采购.md                    政采中标取数：167 条 → 3 条核验、合计 11,406,200 元（L3 通过）
  R8-交付链/                        交付链样板：report.docx（3 页 / 1 表 / 并排双图）+ assets/{data.csv,sources.json,shot-list.png 768×2472,shot-detail.png 768×2779}（两张都是整页拼接截图）
tools/cases/
  r8-assets.mjs                     把抽到的记录写成 data.csv + sources.json（图片登记 bytes/宽高/sha256）
  r8-report.py                      python-docx 生成 report.docx（摘要/方法/发现表/双图/来源/不确定项）
  r8-audit.py                       三跳审计：报告数字 → csv 行 → sources.json → URL（全部 200 才退出 0）
  r8-refresh-shots.mjs              整页截图重拍后，重算 bytes/宽高/sha256 并回写 sources.json
docs/tickets/
  001-feasibility-probe.md         探针：验证"第三方插件能不能挂 webview 并执行 JS"
  002-package-skeleton.md          双面包骨架 + 侧栏 tab 出现
  003-snapshot-engine.md           快照引擎（a11y 树 + ref + 截图）
  004-action-tools.md              动作工具（click/type/press/open/eval）
  005-takeover-and-detection.md    人工接管状态机 + 验证检测
  006-local-static-server.md       本地文件：临时只读静态服务
  007-bundle-packaging.md          打包成正式 bundle 并安装
  008-file-downloads.md            ✅ 已完成：`browser_download` 下载落盘（spec A14，T4 已通过 L3）
  009-action-surface-gaps.md       ✅ 已完成：`browser_scroll` / `browser_click({selector})` / 新窗口策略（A15，1.0.14 装机验收）
  010-hover-and-stacked-controls.md ✅ 已完成：`browser_hover` 真指针移动 + `grew`（A16，1.0.19 装机，百度叠卡已点通）
  011-form-targets-and-card-clicks.md ✅ 已完成：表单目标 + 商品卡命中（A15 补强，1.0.22 装机）
  012-panel-zoom.md                ✅ 已完成：面板缩放 `browser_zoom` + 顶部 − 100% ＋（A17，1.0.24 装机）
  013-failed-navigation.md         ✅ 已完成：失败导航回退到失败前地址 + 错误页拒绝空树、错误带 `nav_*` stage（1.3.9 装机验收）
  014-activation-levels.md         ✅ 已完成：激活档位 `auto`/`always`/`manual` + 滑块验证识别加固（A18，1.0.27 装机）
  015-fit-width-and-fullpage-screenshots.md ✅ 已完成：宽度自适应 + 整页拼接截图（A19，1.0.39 装机）
  016-config-surface.md            ✅ 已完成：8 个硬编码参数配置化 + 四个 volatile 开关 + `fitWidth` 死配置（1.1.1 装机验收）
  017-lifecycle-single-effect.md   ✅ 已完成：13 个 effect 合成一个，卸载按「摘工具 → 关桥 → 关静态」（1.1.1 装机验收）
  018-package-metadata.md         ✅ 已完成：`engines.dsh` / peer+dev 双声明 / license / private（1.1.1 装机验收）
  019-bridge-auth-and-discovery.md ✅ 已完成：动态端口 + 每进程令牌 + 宿主发现路由 `/agent-browser/discovery`（B2，1.2.1 装机验收）
  020-structured-errors.md        ✅ 已完成：11 个稳定 code + message 内置 code（本地同形基类，ticket §6.2）（1.2.3 装机验收）
  021-cancellation.md             ✅ 已完成：`exec.signal` 经 async context 传到桥，排队中可撤回、已投递只丢结果（1.2.4；GUI 手测见 ticket §6.5）
  022-define-tool-migration.md    ✅ 已完成：契约锁定——11 个定义满足宿主硬要求、schema 在受支持子集内、`maxChars` 走 `clampBudget()`、截图不丢 `code`（不迁 `defineTool`，见 ticket §0/§6.5）（1.2.5 装机验收）
  023-web-tool-cards.md           ✅ 已完成：`tool.call.toolview` 三张卡（截图内联缩略图 / open 链接 / download 摘要），图片走附件 ref（1.3.0 装机；验收期另修 028）
  024-policy-guards.md            ✅ 已完成：策略挪进 `policy.js` + `ctx.tools.guard()`（1.3.5 装机验收）
  025-docs-and-decisions.md       ✅ 已完成：用户文档五节（环境 / 安装升级卸载 / 配置含 14 字段表与整行替换警告 / 该用哪个工具 / 故障排查）+ `docs/decisions/005`–`009` + `tools/check-docs.mjs`（六项一致性检查，负向自检 5/5）（1.3.6 装机验收）
  026-plaintext-detect-false-positive.md ✅ 已完成：纯文本文档不再被判人机验证（1.2.1 装机验收）
  027-search-fallback-navigation.md ✅ 已完成（2026-11-22，`1.4.2` 装机验收）：失败换路——`navigation_failed` / `needs_human` 时用 `ctx.web.search` 给同站替代入口（默认关、绝不自动打开、一次失败最多 1 次搜索、显式 `opened: false`；本机 route 选计费 provider，文案标 provider≈/route/1 call；`site:` 实测不可用 → 改 `<host> <路径词>` + 客户端同站过滤）
  028-screenshot-capture-visibility.md ✅ 已完成：截图取帧依赖面板可见——hidden 先判别、首次绘制重试预算加长、失败文案改可读（1.3.4 装机验收）
  029-discovery-registration-race.md ✅ 已完成：发现路由注册竞态（apply 早于 webServer → 宿主路由 404 → 全部 `bridge_timeout`），改为等 `webServer` 出现再注册、每请求现取 connection（1.3.7 装机验收）
  030-address-bar-and-stale-bundle.md ✅ 已完成（1.4.8）：面板地址栏 `[object Promise]`（`getURL()` 异步）改本地地址缓存；启动早期 `report()` 加待发队列；并记录"升级后卡片不显示"实为陈旧客户端 bundle + 看错轨迹面板的误判（H5 目视通过）
  031-tool-conflict-diagnostics.md ✅ 已完成（1.4.9）：同名 `browser_*` 工具冲突不再让插件静默半死——注册改逐工具 `try/catch`、冲突名与失败项经 `/health.diagnostics` 暴露；现场另确认 `install_bundle` 会把另一浏览器 bundle 的启用状态写回 `dsh.profile.bundles`
```

## 关键事实速查（都是在本机装好的版本上验证过的）

- DSH 版本 `0.2.2-rc.5`（2026-11-21 实测装机；更早的记录基于 `0.2.2-rc.3`），`dshBuildCommit 6b729fedde0c8fd03af7afdf5a711aa64fe87c3b`
- 主窗口 `webPreferences.webviewTag: primary`（webview 可用）
- 主进程只放行 `http:` / `https:`，`file:` 硬拒（`lib/main.js:18259`）
- webview 的 `src` 必须是 `about:blank#<leaseId>`，且 partition 与租约一致，否则 `will-attach-webview` 直接 `preventDefault()`
- 租约来源：`globalThis.dshDesktop.browser.acquire(workspace)`（`protocolVersion === 1`）
- 侧栏 tab 可插：`ctx.sidebarRightTabs.register({...})`；必须 `title: () => string`（**没有 `titles` 字典，也没有顶层 `icon`**），`guide[]` 决定是否出现在引导页，`priority` 是 `'extension' | 'builtin' | 'fallback'`；打开面板用 `ctx.sidebarRight.openTab(kind, { params })`
- 截图的视觉 token 不便宜，但 `browser_snapshot` **默认每次附图**——这是刻意的取舍（决策 D08），截图缩到 768px 宽、可用 `includeImage:false` 临时关掉
- 面板 body **跨会话存续**：`keepMounted: true` 让侧栏 tab 在切会话后不卸载，页面与页面内状态都留着（2026-11-20 实测，切回来 `hits` 计数还在）。以后若为省内存改成"只挂当前会话"，必须重新验这条
- "点了"不等于"页面动了"：需要导航的点击现在会比对 URL 并回 `navigated:false`（1.0.20+），判定任务时先看地址与快照 URL 是否一致

## 下一步

1. ~~**TICKET-001 探针**~~ ✅ 已通过（2026-11-19）：`acquire → 挂 webview → executeJavaScript → sendInputEvent → capturePage` 五件事全部实测成立。
2. ~~**TICKET-002**~~ ✅ 已通过（2026-11-19）：双面包骨架成型，`browser_open` 从工具一路打到真网页。
3. ~~**TICKET-003** 快照引擎~~ ✅ 已通过（2026-11-19）：a11y 树 + `[ref=eN]` + iframe 递归 + 768px 截图，2010 节点 16ms。
4. ~~**TICKET-004** 动作工具~~ ✅ 已通过（2026-11-19）：`browser_click`（ref / 坐标）、`browser_type`（含 `submit`）、`browser_press`（含 `Alt+Left` 回退）、`browser_eval` 全部在真实桌面端跑通；协议开销 6ms，输入事件送达另计 200–300ms（见 `docs/cases/005-action-tools.md`）。
5. ~~**TICKET-005** 人工接管 + 验证检测~~ ✅ 已通过（2026-11-20）：host 侧相位机（`#states`）+ 四态徽章 + 双向接管 + `needs_human` / `taken_over` 门控 + 交还摘要全部实测；用户在真实面板上亲手接管、交还过两轮（见 `docs/cases/006-takeover.md`）。
6. ~~**TICKET-006** 本地静态服务~~ ✅ 已通过（2026-11-20）：`browser_open({ path })` 走 `127.0.0.1` 随机端口只读服务，相对资源（CSS / 图片 / fetch）全部正常，穿越与符号链接双闸拦截，14 例单测全绿（见 `docs/cases/007-local-files.md`）。
7. ~~**TICKET-007** 打包成正式 bundle~~ ✅ 已通过（2026-11-20）：发布结构 + `npm pack`（47,430 B / 16 文件），`plugin_manager` 安装 → 禁用 → 启用 → 卸载 → 重装全流程实测，图标与详情页经用户目视确认；`dist/dsh-plugin-agent-browser/` 是可直接分发的产物（见 `docs/cases/008-packaging.md`）。唯一需要重启的一次是"link 安装 → 真包安装"，因为 loader 按包名把旧解析路径缓存在主进程内存里。
8. 开发迭代方式（实测得出，别忘）：profile 现在装的是**真包**，所以循环是「改 `plugin/...` → `node tools/pack.mjs` → `plugin_manager install_bundle <tgz>`」（约 10 秒）。改 `client.js` 要 bump `CLIENT_REV` 才会真的重新执行 client 半；`set_plugin` 只重载 host 半。重装后等 `/health` 的 `parked: 1` 再发命令。**不要**切回 link 安装——loader 按包名缓存解析路径，切回去要再重启一次 DSH 才能回到真包。改了 `plugin/index.js` 的 Config、工具名或用户 README 之后，跑 `node tools/check-docs.mjs`（双向校验；想确认检查本身没失效就跑 `node tools/check-docs-negative.mjs`）。
9. 一条危险的实测行为：对曾经 link 安装过的包执行 `remove_bundle`，会**删掉链接目标目录里的文件**（本项目的 `plugin/` 就这么被清空过一次）。可靠副本是 `dist/`，`node tools/pack.mjs` 可以从它恢复/重打包。**同理：含中文的源文件不要用 PowerShell 文本管道改**（`Get-Content -Raw | Set-Content` 会把 UTF-8 按 GBK 往返，本项目 README 就这么坏过一次），只用 `write` / `edit` 或 Node 读写。
10. 新踩到的一条 Electron 行为：**DSH 窗口在后台时 guest 不绘制、也不接受 `sendInputEvent`**——`browser_click` 会返回成功但页面毫无反应，`capturePage()` 同时挂起。把窗口切到前台立即恢复，不是插件 bug。
11. 联网工具的分工已经定案（2026-11-21）：**不要给插件加搜索工具**，模型侧已有 `web_search` / `web_fetch`；插件要把 `browser_open` 的描述改成"公开静态页先试 `web_fetch`，要登录/要动手/要证据才开面板"。唯一值得做的增强——失败换路（`docs/tickets/027`）已于 2026-11-22 落地（1.4.2，默认关）；U6/U7 探针结论保留在 `docs/design/web-tools-and-agent-browser.md`。
12. 热更新后的访客页：装包会让面板重挂（当前页面变空白），且**重装后第一条命令常超时**（`browser panel did not answer … within 20000ms`）——动作往往已经生效，先 `browser_snapshot` 或 `browser_eval` 看真实状态，别急着重试。
13. 1.5.x 装机验收完成（2026-11-25，1.5.1 → 1.5.2 / 宿主 0.2.2-rc.5）：245 例单测 + check-docs 六项全绿；**F1–F6、F9–F12 全部真机通过**——读动作零打扰、允许一次、拒绝不执行、30s 超时、面板不可见 `<1s` 快速失败、站点授权（换 origin 重问）、提交恰好 1 次（`#count`=1 且 3s 后仍 1）、密码框页面侧硬拒、下载/eval 确认与拒绝、`nopecha` 真实验证墙（needs_human → eval 被拒 → 人工过墙后恢复）、接管作废；F7/F8 属配置级、由 config/approvals/gate 三套单测覆盖（记录见 `docs/cases/015` §4）。验收期修掉三个只有真面板才看得见的问题：①宿主半薄门漏转发 `approve`/`hasClient`/`pageOf`（1.5.1，写动作一次都不确认）②密码框先弹条后被页面硬拒（1.5.1）③`bridge.request()` 的读命令把 `needs_human`/`taken_over` 相位抢回 `agent`、`approve()` 未先看人工相位（1.5.2，验证墙页面上 eval 竟能跑）；顺带把 eval 提示的 origin 从面板 `/page` 遥测改为页面侧 `inspect`（`/page` 上报在本机宿主未落地，仅作遥测）。

14. **两步走**（2026-11-26 定，见 `docs/spec/004-capability-admission-spec.md`）：先做阶段 A 边界收口（`TICKET-040` 白屏根因 → `041` JS 弹窗 → `042` 写动作三态 `effect`/`action_unknown` → `043` F7/F8 安全真机验收），期间**不加新 `browser_*` 动词**；阶段 A 四件结案后再按阶段 B 三层扩能力（操作补全 → 观察增强 → 高风险）。加任何新能力前先回答准入四问并交证据四件套；写动作三态未落地前，禁止新增不可逆写动作。**期间若再白屏，暂停一切真机验收，只做代码与文档。**
    - 进度（2026-11-26）：**阶段 A 全部结案**——`041` ✅（1.5.3，`record` 模式，`off` 对照已并入 043）；`042` ✅ 已实现并真机通过（1.5.4，259 例；真机两条 unknown：eval 页面抛错、接管中断；纯超时分支由单测覆盖）；`040` 🟡 已收口（不可复现 + 文档化规避，四组实验阴性，DSH 未重启；根因停在假设层）；`043` ✅ 真机通过（F7 敏感站每次必问、F8 `mode:'off'` 完全不问；改配置→用户重启 DSH→一次性验完，未用热重载，全程未白屏；证据见 `docs/cases/015` §5）。下一步：阶段 B 按 SPEC-004 §6 三层扩能力（操作补全 → 观察增强 → 高风险），每个能力先过准入四问 + 交证据四件套；`042` 遗留的「页面 ok:false 的 type 中途失败边界」留到下一次能力准入时评估。
- 进度（2026-11-27）：**阶段 B 第一个能力 `browser_wait` 已收口**——代码/单测（16 例，全量 277）/两份 README/check-docs 全绿；1.5.5 已装机（`325,936 B / sha F75E76AE…`）；真机四情形通过并写成 `docs/cases/018`（含三个验收期发现：可见性判定、注入源码必须是单个函数表达式、夹具 `window.status` 坑）。下一步按 SPEC-004 §6 继续阶段 B：观察增强（快照语义/`loc=`）或操作补全其余项，先过准入四问。
- 进度（2026-11-27，晚）：**阶段 B 第二个能力 `loc=` 已收口**——快照为带 ref 的节点追加 `[loc="css:…"]`（`#id`/`[data-testid]`/`tag[name]` 锚点 + `nth-of-type` 路径，`querySelector` 自校验，iframe 前缀 `f1:`，>120 字符省略）；`browser_click`/`browser_hover`/`browser_type` 支持 loc 寻址（与 selector、坐标互斥；type 的 ref/loc 二选一），审批门与密码框早退对 loc 生效；错误分型 `bad_loc`/`stale_loc`（`effect:'none'`）；`CLIENT_REV` 52；单测 277→289；1.5.6 已装机，真机证据见 `docs/cases/019`。

- 进度（2026-11-27，夜）：**阶段 B 第四个能力 `browser_upload` 文件上传（TICKET-047）已实现并真机通过**——宿主读工作区文件（realpath 校验 + 2 MiB/4 MiB/5 个限额）→ base64 走桥 → 页面 `DataTransfer`+`File` 赋给 `input.files` 并派发 `input`/`change`；新增不可逆写审批类 `upload` 与第 19 个码 `upload_rejected`，`effect` 三态照常；单测 296→309，1.5.8 已装机，真机证据 `docs/cases/021`。
- 进度（2026-11-27，夜）：**阶段 B 第三个能力 `cursor` 快照续读（TICKET-046）已实现**——`browser_snapshot` 被预算截断时返回 `cursor`（`<stamp>@<offset>`，stamp=URL 指纹+总行数+引用数+字符数），带 `cursor` 再调用只取下一段并插续读抬头，页面变了返回第 18 个码 `stale_cursor`；续读默认不附图（`CLIENT_REV` 53），单测 289→296；1.5.7 已装机，真机证据见 `docs/cases/020`。
- 进度（2026-11-27，夜）：**阶段 B 第六个能力「页面 console 尾巴」（TICKET-049）已实现并真机通过**——`browser_snapshot` 末尾附两次快照之间的页面 console/未捕获错误（最多 10 条，每次快照清空），guards rev 4 包装 console 并监听 `error`/`unhandledrejection`，`CLIENT_REV` 54→55；顺带修掉「表单外无 type 按钮被误判为提交类」；无新工具/无新错误码；单测 318→327，1.5.10 已装机，真机证据 `docs/cases/023`。

- 进度（2026-11-27，夜）：阶段 B 第五个能力 `browser_scroll` 寻址滚动（TICKET-048）已实现并真机通过——`browser_scroll({ref?,loc?,selector?})` 把元素滚进视口（与 `dy`/`to`/`container` 互斥），页面侧 `scrollIntoView`，回执含 `rect`/`visible`/`fullyVisible`/`info`/`frame`；纯读零审批（仍属 `INPUT_TYPES`，人工相位下被拒且不改变相位），地址失效复用 `stale_loc`/`bad_loc`；无新错误码、`CLIENT_REV` 不变；单测 309→318，1.5.9 已装机，真机证据 `docs/cases/022`。
- 进度（2026-11-27，深夜）：**阶段 B 第八个能力「页面 network 失败尾巴」（TICKET-051）已实现并真机通过**——`browser_snapshot` 末尾附两次快照之间页面自己发出的 fetch/XHR 失败（最多 10 条，抬头 `page network (M failed of N request(s)):`，成功只进分母，每次快照清空）；guards rev 4→5 包装 fetch/XHR（仍调原实现，opaque 不算失败），`CLIENT_REV` 56→57，无新工具/无新错误码；单测 335→345，1.5.13 已装机，真机证据 `docs/cases/025`。
- 进度（2026-11-27，深夜）：**阶段 B 第九个能力「拖拽」（TICKET-052）已实现并真机通过**——第 15 个工具 `browser_drag({from, to, steps?})`：`from` 页面元素地址，`to` 可为元素地址/视口坐标（`toX`/`toY`）/相对位移（`dx`/`dy`），`steps` 2–30 默认 8；页面侧合成 `PointerEvent`+`MouseEvent` 序列（每步 `elementFromPoint` 派发、步间等帧），React DnD/dnd-kit/SortableJS/slider 生效，原生 HTML5 DnD 与 OS 文件拖拽不覆盖；新增第六类写动作 `actionClass:'drag'`（一律首次触站必问），人工相位拒绝、超时/接管按 `action_unknown`；`CLIENT_REV` 57→58，工具 14→15，错误码仍 21；单测 345→360（actions 45 含拖拽 8、drag.test 7），1.5.14 已装机，真机证据 `docs/cases/026`。
- 进度（2026-11-27，更晚）：**阶段 B 第十一个能力「框选」（TICKET-054）已实现并真机通过**——`browser_pick` 增加 `mode:"box"`：人拉一个框，回执给出框内元素列表（`loc`/`info`/`rect`/`point` + `box`/`total`/`truncated`，`limit` 默认 20 夹 1–100）；框选仍是纯读，页面收不到按下/拖动/松手与结束后的 click，拖框时页面文字不会被选中；无新工具/错误码，`CLIENT_REV` 60→61；`pick.test.mjs` 15→26 例 → 全量 375→386；1.5.16 已装机，真机证据 `docs/cases/028`。
- 进度（2026-11-27，深夜）：**阶段 B 第十个能力「页内点选」（TICKET-053）已实现并真机通过**——第 16 个工具 `browser_pick({timeoutMs?})`：请人点页面元素，回执 `loc`/`info`/`rect`/`point`，再用 `browser_click {loc}` 操作；点选那一下页面收不到（window 捕获 + 一次性吞 click），纯读零审批、错误码仍 21，`needs_human` 放行、`taken_over` 拒绝、超时/Esc 正常回执，面板加「取消点选」按钮并交焦点给页面；`CLIENT_REV` 59→60，工具 15→16；`pick.test.mjs` 15 例 → 全量 360→375；1.5.15 已装机，真机证据 `docs/cases/027`。
- 进度（2026-11-27，夜）：**阶段 B 第七个能力「面板标签页」（TICKET-050）已实现并真机通过**——第 14 个工具 `browser_tabs({action:"list"/"switch"/"close", tab})` 与 `browser_open.newTab`；每标签一个真实 webview + 独立租约（同 workspace 共享登录态），面板标签条、活动标签路由、关最后一个先建空白、`MAX_TABS=6`；错误码 19→21（`tab_not_found`/`tab_limit`），`CLIENT_REV` 56；`list` 显示真实 URL、空白标签显示「新标签页」；单测 327→335，1.5.12 已装机，真机证据 `docs/cases/024`（1.5.11 为内部构建）。
