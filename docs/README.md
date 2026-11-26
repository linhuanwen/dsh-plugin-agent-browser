# 文档索引

这个目录放的是「写下来的东西」。产品代码在 `plugin/`、`dist/`，工程工具在 `tools/`，跑出来的截图在 `screenshots/`。

## design/ —— 设计判断

| 文件 | 讲什么 |
| --- | --- |
| [browser-use-contract.md](design/browser-use-contract.md) | 为什么不复用 DSH 官方的浏览器工具：48 行互斥锁、MCP provider、三条路线对比 |
| [web-tools-and-agent-browser.md](design/web-tools-and-agent-browser.md) | `web_search` / `web_fetch` / 侧栏浏览器三层怎么分工，什么时候该用哪一层 |
| [official-docs-review.md](design/official-docs-review.md) | 对着官方文档逐条核对的记录（含 file:line 引用） |

## spec/ —— 契约

| 文件 | 讲什么 |
| --- | --- |
| [001-agent-browser-plugin-spec.md](spec/001-agent-browser-plugin-spec.md) | 工具契约、状态机、快照格式、安全边界、A1–A13 验收项 |
| [002-official-alignment-spec.md](spec/002-official-alignment-spec.md) | B1–B11 / M1–M5 / U1–U7 与版本线 1.1.0–1.4.3 的对齐 |
| [003-first-touch-approval-spec.md](spec/003-first-touch-approval-spec.md) | 站点级首次写动作确认：C1–C12 可验收契约、判定表、桥协议、面板规格、验收与回滚（实现见 TICKET-037–039） |
| [004-capability-admission-spec.md](spec/004-capability-admission-spec.md) | 能力准入契约与两步走：准入四问、证据四件套、写动作三态语义、阶段 A 边界收口（040–043）与阶段 B 三层扩展 |

## decisions/ —— 为什么要这样选

10 篇短记录，每篇一个取舍（通道选型、不用 CDP、动态端口与令牌、单一包三种角色、站点级首次写动作确认……），索引见 [decisions/README.md](decisions/README.md)。

## cases/ —— 取证与案例

| 文件 | 讲什么 |
| --- | --- |
| [001-dsh-browser-internals.md](cases/001-dsh-browser-internals.md) ~ [009-spec-audit.md](cases/009-spec-audit.md) | 探针结果、通道与挂载、快照引擎、动作工具、接管、本地文件、打包、spec 审计 |
| [010-validation-cases.md](cases/010-validation-cases.md) | V1–V12 能力矩阵 + 1.4.13 抽跑记录 + 五个坑 |
| [011-task-cases.md](cases/011-task-cases.md) | T1–T8 任务型案例 |
| [012-industry-research-cases.md](cases/012-industry-research-cases.md) | R1–R8 行业调研案例 |
| [013-hardening-cases.md](cases/013-hardening-cases.md) | H1–H8 加固案例（鉴权、守卫、配置面、错误契约） |
| [014-practical-cases.md](cases/014-practical-cases.md) | S1–S6 实用案例（取表、下载、隔离、故障处置） |
| [015-first-touch-cases.md](cases/015-first-touch-cases.md) | F1–F12 首次写动作确认夹具（读动作零打扰、首次确认、拒绝/超时/不可见、站点豁免、敏感站、off 回退、提交分类、接管作废） |
| [016-js-dialogs-cases.md](cases/016-js-dialogs-cases.md) | JS 弹窗夹具：alert/confirm/prompt 保守拦截与记录、迟到的弹窗进入下一次结果、页面不冻结（record 模式；off 对照待 TICKET-040） |
| [017-action-effect-cases.md](cases/017-action-effect-cases.md) | 写动作回执三态：`effect: none/committed/unknown` + `action_unknown`；真机两条 unknown（eval 页面抛错、接管中断）与已知边界 |
| [018-browser-wait-cases.md](cases/018-browser-wait-cases.md) | `browser_wait` 四种情形真机：立即命中 / 等出现（可见性判定）/ 等消失 / 超时可接受；三个验收期发现 |
| [019-loc-locator-cases.md](cases/019-loc-locator-cases.md) | 快照稳定定位符 `loc="css:…"`：ref 过期后用 loc 完成输入/点击、`stale_loc` 与 `bad_loc` 的页面侧表现；三个验收期发现 |
| [020-snapshot-cursor-cases.md](cases/020-snapshot-cursor-cases.md) | 快照续读：长列表截断 → `cursor` 续读到尾、页面变化后 `stale_cursor`、不带 cursor 的旧行为对照；三个验收期发现 |
| [021-browser-upload-cases.md](cases/021-browser-upload-cases.md) | `browser_upload` 真机：单文件/多文件、单文件 input 拒绝列表、越界与非 file input 拒绝、拒绝确认零副作用；三个验收期发现 |
| [022-scroll-into-view-cases.md](cases/022-scroll-into-view-cases.md) | `browser_scroll` 寻址滚动：按 `loc` 滚到远端元素、按 `ref` 滚回顶部、旧 `dy` 行为不变、失效地址 `stale_loc`、地址与 `dy` 混用被拒 |
| [023-console-tail-cases.md](cases/023-console-tail-cases.md) | 页面 console 尾巴：`[log]`/`[error]`/`[pageerror]`/`[unhandled]` 进下一次快照、无新日志时不重复、普通按钮不再误判提交类 |
| [025-network-tail-cases.md](cases/025-network-tail-cases.md) | 页面 network 失败尾巴：fetch 成功只计数、fetch 404/传输失败/XHR 404 出现在下一次快照的 `page network (M failed of N request(s)):` 里、再快照不重复；分母含成功请求 |
| [024-tabs-cases.md](cases/024-tabs-cases.md) | 面板标签页：`newTab` 开第二张、`list` 标题与真实 URL、切换后页面状态保留、关最后一个回落空白页、`tab_not_found`/`tab_limit`；三个验收期发现（URL 缓存、空白页标题、客户端 bundle 缓存） |
| [cases/shots/](cases/shots/) | 案例截图原图 |
| [cases/outputs/](cases/outputs/) | 案例执行产物：R4/R8/S1–S6 的记录、素材与报告 |

## research/ —— 外部调研

| 文件 | 讲什么 |
| --- | --- |
| [2026-11-24-browser-automation-competitive-report.md](research/2026-11-24-browser-automation-competitive-report.md) | 5 个同类项目（BrowserSkill / browserpaw / browser-mcp / browser-automation / dsh-browser-cdp）的横评，与我们护城河和短板的对照，P0–P2 建议与两周清单 |

## tickets/ —— 51 张工单

按时间编号，每张记录一个失败模式、根因与验收证据（`034-screenshot-large-capture-hang.md` 是截图大载荷修复，`037`–`039` 是「首次写动作确认」的实现拆分：host 判定/门 → 面板确认条 → 配置与夹具，`040`–`043` 是「阶段 A 边界收口」：白屏根因 → JS 弹窗 → 写动作三态 → F7/F8 真机验收；`044` 是「阶段 B1 第一个能力」：`browser_wait` 等待条件——纯读、零审批、`needs_human`/`taken_over` 下可用；`045` 是「阶段 B2 观察增强」：快照 `loc="css:…"` 稳定定位符，ref 换新后仍可寻址，`bad_loc`/`stale_loc` 分型；`046` 是「阶段 B2 观察增强」：快照被预算截断时返回 `cursor`，带 `cursor` 再调用续读下一段，页面变化返回 `stale_cursor`；`047` 是「阶段 B1 操作补全」：`browser_upload` 把工作区文件合成 `File` 放进 `<input type=file>`——首个不可逆写动作，接 `upload` 审批类与 `upload_rejected`（19 码）；`048` 是「阶段 B1 操作补全」：`browser_scroll` 支持按 `ref`/`loc`/`selector` 把元素滚进视口，回执带元素 `rect` 与 `visible`/`fullyVisible`；`049` 是「阶段 B2 观察增强」：快照末尾附页面 console 尾巴；`050` 是「阶段 B3 面板能力」：面板标签页 `browser_tabs` 与 `browser_open.newTab`，多标签共享登录态、切换保状态）。

## release/ —— 上线与发布

| 文件 | 讲什么 |
| --- | --- |
| [launch-test-plan.md](release/launch-test-plan.md) | G0–G5 上线门禁与逐项执行结果 |
| [launch-report-1.4.13.md](release/launch-report-1.4.13.md) | 1.4.13 Windows 首发的上线报告与签字 |
| [release-notes-1.4.md](release/release-notes-1.4.md) | 1.4.x 的产物、行为变化、未验证项与回滚 |
| [release-notes-1.5.md](release/release-notes-1.5.md) | 1.5.x 累积发布说明：1.5.0 信任闸门版（验证墙漏报修复 + 首次写动作确认）、1.5.4 写动作三态、1.5.5–1.5.12 阶段 B 能力（wait/loc/cursor/upload/寻址滚动/console 尾巴/标签页） |
| [g3-ptc-prompt.md](release/g3-ptc-prompt.md) / [g3-ptc-result.md](release/g3-ptc-result.md) | G3 PTC 冒烟门的提示词与执行结果 |
| [profile-install-baseline.txt](release/profile-install-baseline.txt) | 装机事故前的依赖基线快照 |

## assets/

`hero.svg`（手写示意图）、`icon.svg`、`case-*.jpg`（真实运行截图，`python tools/make-readme-assets.py` 可重新生成）。
