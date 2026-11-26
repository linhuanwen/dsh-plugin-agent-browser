# 案例 023：页面 console 尾巴（TICKET-049，1.5.10）

**日期**：2026-11-27
**版本**：`dsh-plugin-agent-browser` 1.5.10（`CLIENT_REV` 55），DSH 0.2.2-rc.5（桌面端）
**夹具**：`demo/console.html`（本机静态服务端口 6066）
**目的**：证明页面在两次快照之间打印的 console 日志与未捕获错误，会作为 `browser_snapshot` 的尾巴出现，且每次快照清空、不重复占上下文；同时确认守卫改动没有影响页面自己的日志行为。

## 1. 结论

| # | 场景 | 结果 |
|---|---|---|
| C1 | 点击「console.log 一条」后快照 | 末尾出现 `page console (1 entry): - [log] 夹具：普通日志 1` ✅ |
| C2 | 连点 error / 抛同步异常 / Promise 拒绝后快照 | 末尾出现 `[error]`、`[pageerror] Uncaught Error: …(…:44)`、`[unhandled] Error: …` 三条 ✅ |
| C3 | 无新日志时再快照 | **没有** `page console` 段（缓冲已清空）✅ |
| C4 | 普通按钮点击 | 不再弹写动作确认条（`isSubmitControl` 只认 `type=submit` 或表单内无 type 按钮）✅ |
| C5 | 页面自身行为 | 五个按钮的点击计数正常、页面没有报错、日志区域正常更新 ✅ |

## 2. 复跑步骤

前置：面板已打开（右侧「浏览器」页签），插件 1.5.10 已启用。

```
browser_open {path: "demo/console.html"}          → http://127.0.0.1:<port>/t/demo/console.html
browser_snapshot {includeImage: false}            → 6 refs（e1 标题 … e6 未处理拒绝）
browser_click {ref: "e2"}                         → Clicked button "console.log 一条"
browser_snapshot {includeImage: false}            → 末尾 page console (1 entry) / [log]
browser_click {ref: "e4"}                         → console.error
browser_click {ref: "e5"}                         → 同步抛异常
browser_click {ref: "e6"}                         → Promise 拒绝
browser_snapshot {includeImage: false}            → 末尾 3 条：[error] [pageerror] [unhandled]
browser_snapshot {includeImage: false}            → 无 console 段（已清空）
```

单测：`node --test plugin/test/guards.test.mjs plugin/test/console.test.mjs plugin/test/actions.test.mjs`，全量 `node --test plugin/test/*.test.mjs`（327）。

## 3. 已知边界

- 只覆盖页面脚本期：`dom-ready` 之后注入，内联脚本解析期（首屏前）打的日志抓不到，与 `beforeunload` 同类限制。
- 缓冲上限 40 条、单条截 240 字；快照尾巴只渲染 10 条并明确写隐藏条数。
- 每次快照清空：两次快照之间的日志若中间没有快照就丢失 —— 这是为了不让上下文里反复出现同一条日志而刻意选的粒度。
- 不做网络观测（fetch/XHR/WebSocket）：是另一个独立能力，另行评估（SPEC-004 阶段 B2 的 console/network 条目只完成了 console 一半）。
