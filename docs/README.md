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

## decisions/ —— 为什么要这样选

9 篇短记录，每篇一个取舍（通道选型、不用 CDP、动态端口与令牌、单一包三种角色……），索引见 [decisions/README.md](decisions/README.md)。

## cases/ —— 取证与案例

| 文件 | 讲什么 |
| --- | --- |
| [001-dsh-browser-internals.md](cases/001-dsh-browser-internals.md) ~ [009-spec-audit.md](cases/009-spec-audit.md) | 探针结果、通道与挂载、快照引擎、动作工具、接管、本地文件、打包、spec 审计 |
| [010-validation-cases.md](cases/010-validation-cases.md) | V1–V12 能力矩阵 + 1.4.13 抽跑记录 + 五个坑 |
| [011-task-cases.md](cases/011-task-cases.md) | T1–T8 任务型案例 |
| [012-industry-research-cases.md](cases/012-industry-research-cases.md) | R1–R8 行业调研案例 |
| [013-hardening-cases.md](cases/013-hardening-cases.md) | H1–H8 加固案例（鉴权、守卫、配置面、错误契约） |
| [014-practical-cases.md](cases/014-practical-cases.md) | S1–S6 实用案例（取表、下载、隔离、故障处置） |
| [cases/shots/](cases/shots/) | 案例截图原图 |
| [cases/outputs/](cases/outputs/) | 案例执行产物：R4/R8/S1–S6 的记录、素材与报告 |

## tickets/ —— 34 张工单

按时间编号，每张记录一个失败模式、根因与验收证据（`034-screenshot-large-capture-hang.md` 是最近的截图大载荷修复）。

## release/ —— 上线与发布

| 文件 | 讲什么 |
| --- | --- |
| [launch-test-plan.md](release/launch-test-plan.md) | G0–G5 上线门禁与逐项执行结果 |
| [launch-report-1.4.13.md](release/launch-report-1.4.13.md) | 1.4.13 Windows 首发的上线报告与签字 |
| [release-notes-1.4.md](release/release-notes-1.4.md) | 1.4.x 的产物、行为变化、未验证项与回滚 |
| [g3-ptc-prompt.md](release/g3-ptc-prompt.md) / [g3-ptc-result.md](release/g3-ptc-result.md) | G3 PTC 冒烟门的提示词与执行结果 |
| [profile-install-baseline.md](release/profile-install-baseline.txt) | 装机事故前的依赖基线快照 |

## assets/

`hero.svg`（手写示意图）、`icon.svg`、`case-*.jpg`（真实运行截图，`python tools/make-readme-assets.py` 可重新生成）。
