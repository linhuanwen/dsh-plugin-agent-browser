# 案例 030：动作时间线与截图证据（TICKET-056，1.5.23）

**一句话**：宿主进程里保留最近 200 条动作记录——工具名、成败、`effect`、错误码、参数摘要、截图/下载的文件路径与字节数、耗时——两条出口：`browser_timeline` 工具（纯读、零审批、面板关着也能查）+ 面板底部的「动作 N 条」可展开条；记录只活在当前进程，重载/重装清空，不落盘。

- 能力入口：新工具 `browser_timeline({ limit, tool, failedOnly })`（第 17 个工具），只读路由 `GET /timeline`，面板 `CLIENT_REV` 65；不新增错误码（仍 21 个）。
- 环境：1.5.23、DSH 桌面端、右侧栏浏览器页签；夹具 `demo/console.html`（由 `browser_open({path})` 打开，回环端口随会话分配）。
- 证据截图：`screenshots/ticket056-final-shot.png`（最终包上点击与截图落盘）。

## 1. 结论

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| T1 | 动作被记录（open / click / screenshot / 失败） | ✅ | `browser_timeline` 列出 4 条，最新在前 |
| T2 | 截图文件路径与字节数进入记录 | ✅ | `file: screenshots/ticket056-final-shot.png (53937 B)` |
| T3 | 写动作标出 `effect` | ✅ | `ok browser_click (committed) 141ms — loc=css:#log-one` |
| T4 | 失败带稳定错误码 | ✅ | `FAILED browser_click [stale_loc] 100ms — loc=css:#nope-again` |
| T5 | `failedOnly:true` 只出失败 | ✅ | 只返回 1 条（`stale_loc`） |
| T6 | `tool` 过滤 | ✅ | `tool:"browser_click"` 只返回两条 click |
| T7 | `limit` 与剩余提示 | ✅ | 抬头 `N in the buffer` + `Pass a larger limit (up to 50) to see more.` |
| T8 | 读日志不写日志 | ✅ | 连续两次 `browser_timeline {limit:5}`：`1 in the buffer` 不变 |
| T9 | 重载/重装清空记录 | ✅ | 重装 1.5.23 后第一次查询 buffer 从 0 开始（仅含本次 open） |
| T10 | 面板底部「动作 N 条」 | ✅ | 用户目视确认：看到按钮、点开能看到最近记录（含 FAILED） |
| T11 | 纯读、不需要面板/审批 | ✅ | `browser_timeline` 不经过 bridge 命令队列、不弹确认条；面板「动作 N 条」读的是 `GET /timeline` |

## 2. 命令与回执原文（1.5.23 最终包）

```
browser_open {path:"demo/console.html"}
Opened http://127.0.0.1:6342/t/demo/console.html — 页面 console 观测夹具
Served from the workspace by a read-only local server on port 6342 (root: D:\Vibe coding\32 deepseek harness cebiankuang).

browser_timeline {limit:5}
1 recent action(s) (newest first), 0 failed; 1 in the buffer.
#1 22:43:52 ok browser_open 102ms — path=demo/console.html

browser_timeline {limit:5}          ← 再读一次，buffer 不变
1 recent action(s) (newest first), 0 failed; 1 in the buffer.
#1 22:43:52 ok browser_open 102ms — path=demo/console.html

browser_click {loc:"css:#log-one"}
Clicked button "console.log 一条" at (85, 164).

browser_screenshot {name:"ticket056-final-shot.png"}
Saved screenshots/ticket056-final-shot.png (panel size, 52.7 KB)

browser_click {loc:"css:#nope-again"}
Error: loc "css:#nope-again" no longer matches anything in the page — it was replaced, removed, or you are on a different page now. Take a new browser_snapshot and use a loc (or ref) from that snapshot.

browser_timeline {limit:10}
4 recent action(s) (newest first), 1 failed; 4 in the buffer.
#4 22:44:31 FAILED browser_click [stale_loc] 100ms — loc=css:#nope-again
#3 22:44:27 ok browser_screenshot 147ms — name=ticket056-final-shot.png
    file: screenshots/ticket056-final-shot.png (53937 B)
#2 22:44:15 ok browser_click (committed) 141ms — loc=css:#log-one
#1 22:43:52 ok browser_open 102ms — path=demo/console.html
```

过滤（在 sha `78f69617…` 的 1.5.23 构建上取，最终包同样可用）：

```
browser_timeline {limit:5, failedOnly:true}
1 recent action(s) (newest first), 1 failed; 4 in the buffer.
#4 22:39:09 FAILED browser_click [stale_loc] 177ms — loc=css:#nope-not-here

browser_timeline {tool:"browser_click"}
2 recent action(s) (newest first), 1 failed; 5 in the buffer.
#4 22:39:09 FAILED browser_click [stale_loc] 177ms — loc=css:#nope-not-here
#2 22:38:08 ok browser_click (committed) 168ms — loc=css:#log-one
```

> 注：该构建上「读时间线」自身也会入账（total 5→6），最终包已改成读日志不记账，T8 复验通过。

## 3. 验收期发现（五个，全部已修）

1. `timeline.js` 漏进 `tools/pack.mjs` 的 COPY 清单 → 装机 `failed to import: ERR_MODULE_NOT_FOUND`（第三次同类事故）；`tools/check-docs.mjs` 第 7 项从「inject 脚本」扩到「宿主模块」，双向比对 COPY。
2. 即使 COPY 有，`dist/dsh-plugin-agent-browser/package.json` 的 `files` 没列 `timeline.js`，`npm pack` 依白名单裁剪 → tgz 里没有；check-docs 第 7 项再比对 `files`。
3. `summary` 空串被渲染成 `undefined`（execute 省略空字段、render 只判 `=== ''`）→ render 改类型判定 + 单测 `doesNotMatch(/undefined/)`。
4. 页面级拒绝在时间线里记成 `[error]`（`actionFailure` 返回的是 plain Error）→ `actionFailure` 给错误补 `error.code = result.error`（不改消息），记录出 `[stale_loc]`。
5. 读取时间线会把自己也记进去 → `browser_timeline` 的调用跳过记录，单测补「读不增长」。

## 4. 复跑步骤

1. `browser_open {path:"demo/console.html"}`。
2. 连做 `browser_click {loc:"css:#log-one"}`、`browser_screenshot {name:"…"}`、以及一次注定失败的 `browser_click {loc:"css:#nope"}`。
3. `browser_timeline {limit:10}`：应看到 4 条、`[stale_loc]`、截图 `file:` 与字节数、`(committed)`。
4. 再读一次 `browser_timeline`：`N in the buffer` 不变。
5. `browser_timeline {failedOnly:true}` / `{tool:"browser_click"}` 验证过滤。
6. 面板底部「动作 N 条」展开，确认条目与工具回执一致；重装后记录归零。

## 5. 已知边界

- 只活在宿主进程：DSH 退出、插件重载/重装即清空；不持久化、不写日志文件。
- 容量 200 条（环形），更早的被顶掉；`limit` 上限 50。
- 只记「工具调用」，不记页面内部事件（点击处理器、路由变化）、不记其他插件的动作。
- 时间来自本机时钟；截图/下载才有 `file`/`bytes`。
- `summary` 是参数摘要：去掉 `source` 大字段、对象截断、整体 120 字，不保证完整还原参数。
- 不自动截图、不回放、不撤销；纯读，不改变相位、不触发审批。
