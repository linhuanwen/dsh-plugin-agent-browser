# 决策记录（ADR）索引

> 这里的每条记录回答"为什么这么做"，而不是"做了什么"；实现细节与验收证据在对应的 `tickets/` 与 `reference/` 里。
> 新增决策时：编号续接、文件名 `NNN-kebab-case.md`、开头写状态/日期/关联，然后背景 → 决策 → 理由 → 后果。

| # | 文件 | 主题 | 状态 |
|---|---|---|---|
| 001 | [001-grilling-decisions.md](001-grilling-decisions.md) | 设计决策台账（grilling 记录，D1–D11 等原始决策） | 已定 |
| 002 | [002-human-input-during-agent.md](002-human-input-during-agent.md) | D12 Agent 操作期间要不要"禁止人工输入" | 已定并实现 |
| 003 | [003-download-newwindow-and-task-cases.md](003-download-newwindow-and-task-cases.md) | D13–D15 下载通道、新窗口策略、任务级案例口径 | 已定并实现 |
| 004 | [004-activation-and-challenge-detection.md](004-activation-and-challenge-detection.md) | D19–D20 面板激活档位、挑战识别加固 | 已定并实现 |
| 005 | [005-loopback-bridge-over-cdp.md](005-loopback-bridge-over-cdp.md) | 通道用回环 HTTP 长轮询，不用 CDP | 已定并实现 |
| 006 | [006-no-reuse-of-browser-use.md](006-no-reuse-of-browser-use.md) | 不复用官方 browser-use 工具（只借互斥锁） | 已定并实现 |
| 007 | [007-single-package-three-roles.md](007-single-package-three-roles.md) | 保持单包（host / client / 资源三角色） | 已定 |
| 008 | [008-auth-dynamic-port.md](008-auth-dynamic-port.md) | 动态端口 + 每进程令牌 + 宿主发现路由 | 已定并实现 |
| 009 | [009-web-tools-division-of-labor.md](009-web-tools-division-of-labor.md) | 不新增搜索工具；搜索引擎只当失败路径的 URL 解析器 | 已定（失败换路待 TICKET-027） |
