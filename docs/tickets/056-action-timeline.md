# TICKET-056：动作时间线 —— 「刚才做过什么」可以回看

**状态**：✅ 已实现并真机通过（2026-11-27，1.5.23）· 阶段 B2（可核对）
**发现**：2026-11-27（TICKET-055 页面内可见反馈之后，产品线候选 ②「动作时间线与截图证据」）
**关联**：TICKET-042（写动作三态 `effect`）、TICKET-055（可见反馈）、SPEC-004 §4「可核对」

## 1. 缺口

1. **人离开一会儿就断片**：面板里一屏一屏地操作，人只能看到「现在」；「刚才点了几下、有没有一次失败的、那次截图存哪了」没有任何地方可查。
2. **agent 自己也答不上「刚才」**：上下文被压缩、会话续接、或换了一个会话之后，工具回执里的历史不在了；想复盘「我到底点过哪些」只能重新看快照。
3. **截图证据没有索引**：`browser_screenshot` 会存一份文件，但文件路径只在当次回执里；事后对「这张截图是哪一步拍的」无从对应。
4. **失败记录只活在错误消息里**：`stale_loc`、`needs_human`、`approval_timeout` 当时能看到，事后要回忆「哪一步失败过」只能翻聊天记录。

## 2. 准入四问（SPEC-004 B1）

| 问题 | 回答 |
|---|---|
| 属读还是写？ | **纯读**：只读宿主内存里的一张记录表，不发页面命令、不改页面、不改文件。 |
| 可逆吗？ | 是。记录表是进程内环形缓冲，最多 200 条，插件重载即清空；不影响任何动作。 |
| 失败能确定「没执行」吗？ | 能。记录只描述**已经发生**的工具调用；写不进去就返回空/旧表，不产生动作。 |
| 与人工相位的关系？ | `needs_human` / `taken_over` 下都可以查（人本就在处理页面，查看记录没有副作用）；不上报页面、不抢控制权。 |

## 3. 设计

### 3.1 宿主侧记录器（新 `plugin/timeline.js`，纯逻辑）

`createTimeline({ capacity = 200, now = Date.now })` → `{ record(entry), list({ limit, tool, failedOnly }), clear(), size }`。

每条记录：

```
{ seq, at, tool, session, ok, effect?, code?, summary, url?, file?, bytes?, ms }
```

- `summary` 是参数摘要（去掉 `source` 等大字段，截 120 字符），让人一眼看出「点的哪儿」；
- `effect` 取结果里的 `effect`（写动作三态）；`code` 取错误的 `.code`（桥/审批错误自带；页面级拒绝由 `actionFailure` 把 `result.error` 补到 `error.code`，消息不变）；
- `file`/`bytes` 取截图/下载类结果里的文件路径与大小——这就是「截图证据索引」；
- 容量满时丢最旧的（环形）；`browser_timeline` 自身的读取不记录（读日志不写日志）。

### 3.2 包一层工具执行（`plugin/tools.js` 的 `createTools`）

现有 wrapper 已统一注入 `exec.signal`，现在顺手计时并记录：开始时间、工具名、`sessionOf(exec)`、参数摘要；成功记 `ok:true` + `effect` + 文件；失败记 `ok:false` + `code`。**不改任何工具的回执**，记录只是旁路。

### 3.3 对外两条通道

1. **新工具 `browser_timeline`**（第 17 个工具，纯读、零审批）：
   `browser_timeline({ limit?: 1–50（默认 10）, tool?: string, failedOnly?: boolean })`
   返回最近的动作（新→旧），带 `seq/at/tool/ok/effect/code/summary/url/file/bytes`；渲染成一行一条：
   `#12 22:04:31 browser_click ok committed — loc=css:#log-one`。
   **不依赖面板**：面板关着也能查（记录在宿主进程里），这是它相对「从聊天记录里翻」的价值。
2. **面板内时间线**：面板底部/顶部一条可展开的「动作 N 条」条，显示最近几条的 `✓/✗/⚠ + 工具 + 时间`，数据来自桥的新只读路由 `GET /timeline?limit=8`（`CLIENT_REV` 64→65）。人不用问 agent 就能看到「刚才发生了什么」。

### 3.4 桥

`GET /timeline`（只读 JSON，带既有令牌校验）→ `{ ok:true, total, entries }`；`Bridge` 增加 `setTimeline(timeline)`（与 `setDiagnostics` 同样由 `apply.js` 注入），未注入时返回空表而不是报错。

## 4. 证据计划

- 新增 `plugin/test/timeline.test.mjs`（**7 例全过**）：记录/容量/过滤/顺序、`summarizeArgs` 去 `source`、工具层参数校验与渲染（含 `doesNotMatch(/undefined/)`）、页面级拒绝保留稳定码（`stale_loc`）、读日志不增长。
- 计数：工具 16→**17**（`tooldefs`/`toolviews`/`wait`/`pick` 的注册表测试同步；`check-docs` 工具数、两份 README「十七个工具」、`tools/pack.mjs` COPY 与 `dist/package.json files` 都已对齐）。
- 全量：394 → **401 / 401**；`node tools/check-docs.mjs` 七项全绿（配置 23、工具 17、YAML 14、decisions 10、B11、file:line 12、打包清单 7 inject + 15 宿主模块 + dist files）。
- 真机证据见 `docs/cases/030-action-timeline-cases.md`（T1–T11）。

### 4.1 真机证据（1.5.23，sha256 `5c984fb4507ca5fdaf22e3a86762617d24cd6d4c39fd525cc3e03cd8db2a7013`）

| # | 场景 | 回执 |
|---|---|---|
| 1 | 动作被记录、最新在前 | `browser_open demo/console.html` → `1 recent action(s) (newest first), 0 failed; 1 in the buffer.` / `#1 … ok browser_open 102ms — path=demo/console.html` |
| 2 | 读日志不写日志 | 再读一次 `browser_timeline {limit:5}` → 仍 `1 in the buffer` |
| 3 | 写动作带 effect | `Clicked button "console.log 一条" at (85, 164).` → `ok browser_click (committed) 141ms — loc=css:#log-one` |
| 4 | 截图文件索引 | `Saved screenshots/ticket056-final-shot.png` → `file: screenshots/ticket056-final-shot.png (53937 B)` |
| 5 | 失败保留稳定码 | `Error: loc "css:#nope-again" no longer matches…` → `FAILED browser_click [stale_loc] 100ms — loc=css:#nope-again` |
| 6 | `failedOnly` / `tool` / `limit` 提示 | `1 recent action(s) … 1 failed`；`tool:"browser_click"` → 2 条；`Pass a larger limit (up to 50) to see more.` |
| 7 | 重载清空 | 重装 1.5.23 后 buffer 从 0 起（首次只有当次 open） |
| 8 | 面板「动作 N 条」 | 用户目视确认按钮存在、点开能看到最近记录（含 FAILED） |

> 验收期修复：`timeline.js` 漏进 pack COPY（装机 `ERR_MODULE_NOT_FOUND`）与漏进 `dist/package.json files`（tgz 里没有）、`summary` 空串渲染成 `undefined`、页面级拒绝记成 `[error]`、读时间线自身入账——四处已修并有测试/门禁盯住。

## 5. 不做

- 不做自动截图（每次动作拍一张代价太大；截图仍由 `browser_screenshot` 显式触发，时间线只做索引）；
- 不做持久化（不写文件、不跨进程；重载即清空——需要长期留证请用截图与文档）；
- 不做时间线回放 / 撤销；
- 不记录页面内部事件（只记工具调用）；
- 不再新增错误码（仍 21）。
