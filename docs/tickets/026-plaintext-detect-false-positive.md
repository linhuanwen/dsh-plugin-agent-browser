# TICKET-026 纯文本文档被误判为人机验证

- **状态**：✅ 已完成（1.2.1 装机）
- **优先级**：P1（验收期发现的假阳性：面板进入 `needs_human` 后拒绝一切输入工具）
- **来源**：TICKET-019 装机验收（打开自家 `README.md` 触发）
- **对应验收**：`docs/spec/002` B4 验收顺带（不新增 B 项；D03「检测到验证就交给用户」的假阳性成本条款）
- **关联**：TICKET-005/014（检测器来源）、TICKET-019（发现它的那次验收）

## 1. 问题

`plugin/inject/detect.js` 的判定规则之一是：

> 只有一种 `text` 信号、且页面可交互元素 ≤ 3 时，算命中墙（`textOnly`）。

这条规则原本为了 Alibaba 滑块墙（标题 + 正文短语，页面上没几个控件）。但它对**纯文本文档**同样成立：`text/plain` 页面没有控件（`interactive = 0`），只要正文里出现 `人机验证` 一词就命中。

2026-11-21 装机验收 TICKET-019 时，用 `browser_open({ path: 'README.md' })` 打开本项目 README（静态服务按 `.md` → `text/plain`），README 正文里本来就有"人机验证"章节，于是：

- 检测器回报 `hit: true`、`categories: ['text']`；
- 面板进入 `needs_human`，屏幕上出现"检测到人机验证，请你在面板里完成"横幅；
- `browser_eval` 等输入类工具被拒绝：`needs_human: 页面需要人工验证（a human verification step is on screen）`；
- 用户被迫为一篇纯文本点一次"完成"。

假阳性在这里不是"多看一眼"的成本，而是**把所有输入工具锁死**。

## 2. 修法

墙一定是 HTML 文档：Cloudflare / 阿里滑块 / reCAPTCHA 都是带脚本的 HTML。`text/plain`、JSON、日志这类响应**不可能**是挑战页。

`plugin/inject/detect.js`：

```js
var contentType = ''
try { contentType = String(document.contentType || '') } catch (error) { contentType = '' }
...
var textOnly = kinds.length === 1 && categories.text === true && interactive <= 3
if (textOnly && !/html/i.test(contentType)) textOnly = false
```

- 只影响 `textOnly` 分支；`dom` / `location` 两类证据的判定不变（真墙本来就会同时有其中一类）。
- `document.contentType` 在真实页面里是 `text/html`、`text/plain`、`application/xhtml+xml` 等；用 `/html/i` 同时覆盖 HTML 与 XHTML。
- 存量的 `application/json` 报错页、`.txt` 日志同样受益。

## 3. 单测

`plugin/test/detect.test.mjs` 的桩增加 `contentType` 字段（默认 `text/html`），新增两例：

| # | 用例 | 期望 |
|---|---|---|
| 1 | `contentType: 'text/plain'`，正文含"人机验证"，`interactive: 0` | `hit: false`，`categories: ['text']`（证据还在，只是不判墙） |
| 2 | `contentType: 'text/html'`，同样的正文与控件数 | `hit: true`（真墙仍判得出） |

全量 `node --test`：**106 / 106 通过**（较 104 例新增 2 例）。

## 4. 装机验收

| 项 | 做法 | 实测 |
|---|---|---|
| 纯文本不再误判 | `browser_open({ path: 'README.md' })` | 返回体无 `needs_human` 横幅；`browser_snapshot` 正常读出 README 文本；`browser_eval` 可用 |
| 真墙仍能判 | 打开 `tools/probe/challenge-check.html`（`<title>请稍候` + 正文`请完成安全验证`，无控件） | 打开即返回 `needs_human: a human verification step is on screen`；随后 `browser_open` 到别的页面即可清除 |

## 5. 风险与残留

| # | 项 | 处理 |
|---|---|---|
| R1 | 真墙被 `Content-Type` 写成非 HTML 的极端站点会漏判 | 漏判只导致 agent 撞墙（D03 原成本），不会锁死用户；且这类站点本身也带脚本，实践中是 HTML |
| R2 | `application/xhtml+xml` 命中 `/html/i` | 符合预期（XHTML 也是文档） |
| R3 | 同一规则对 JSON 报错页、`.txt` 日志 | 一并修复；不需要额外条件 |

## 6. 变更记录

- 1.2.1（2026-11-21）：`plugin/inject/detect.js` 增加 `contentType` 门；`plugin/test/detect.test.mjs` 桩与两例回归。
