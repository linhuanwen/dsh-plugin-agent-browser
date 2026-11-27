# TICKET-057 `browser_read`：读渲染出来的文字与表格

- 状态：✅ 已实现并真机通过（2026-11-27，1.5.24）· 阶段 B2「可核对」
- 目标：第 18 个工具，把「页面上写着什么」一次读出来，不再靠无障碍树逐行拼
- 关联：SPEC-004 准入契约；cases/031

## 1. 缺口

| 场景 | 现在怎么做 | 为什么疼 |
|---|---|---|
| 读一篇文章 / 公告 / 条款 | `browser_snapshot` 把整棵树按行给出来，正文被切成 text 节点 | 上下文税高，且树的顺序不等于人读的顺序 |
| 读一张数据表 | 快照只给 `table > rowgroup > row > cell` 结构 | 行列关系要 agent 自己拼，容易错行错列 |
| 只要正文、不要控件 | 快照总是把按钮/输入框一起给 | 预算被控件占掉，正文被截断 |

## 2. 准入四问

| 问题 | 回答 |
|---|---|
| 它改变页面吗？ | 不。只读 `innerText` / 表格结构，不点击、不滚动、不聚焦、不改 DOM |
| 失败了会留下半截状态吗？ | 不会。失败发生在读取前（地址解析失败）或读取中（无副作用），没有「做了一半」 |
| 需要人确认吗？ | 不需要。它是读动作（`READ_TYPES`），和其它读一样零审批 |
| 人工相位下能用吗？ | 能。`needs_human` 与 `taken_over` 下都放行——人接管时 agent 仍然要能看见页面（与 `browser_snapshot` 同级） |

## 3. 设计

### 3.1 页面侧 `plugin/inject/read.js`

单函数表达式 `dshRead(input)`，面板以 `(<source>)(input)` 注入（与 `wait`/`pick` 同约定）。一次同步读取，返回对象（不是 JSON 字符串）。

- 地址解析：`ref`（最新快照的 `data-dsh-ref`）/ `loc`（`css:` 稳定路径，支持 `f1:` 前缀进 iframe）/ `selector`（首个匹配；`strict:true` 时多个匹配报 `multiple`）。三者至多一个；都不传 = 整页 `document.body`。
- `mode: "text"`：取根元素的 `innerText`（隐藏节点不算），`\r\n` 归一、行内空白折叠、连续空行压成一个、首尾留白去掉；按 `maxChars` 截断并回报 `chars` / `totalChars` / `truncated`。
- `mode: "table"`：根下所有 `<table>`（根本身是 table 也算），每张给 `caption`（`caption` 文本或 `aria-label`）、`headers`（首行全为 `th` 或位于 `thead` 时取出）、`rows`（单元格文本，最多 `maxRows` 行）、`rowCount`、`truncated`；最多 `maxTables` 张。
- 失败复用稳定码：`bad_loc` / `stale_loc` / `not_found` / `multiple` / `bad_ref` / `stale_ref`，失败回执里带走本次地址与命中数，供工具层拼出可执行的错误文案。**不新增错误码。**

### 3.2 面板侧 `plugin/client.js`

`Guest.read(params)`：校验命令里带的 reader source，拼 `{mode, ref/loc/selector, strict, maxChars, maxTables, maxRows}` 后一次 `evaluate`。`runCommand` 增加 `read` 分支；`READ_TYPES` 增加 `'read'`（人工相位放行、零审批，与 `snapshot` 同级）。

### 3.3 工具侧 `plugin/tools.js`

`browserReadTool(bridge)`：参数 `{mode, loc, selector, ref, strict, maxChars 200–40000 默认 8000, maxTables 1–20 默认 10, maxRows 1–500 默认 100}`；把地址/模式/预算校验前置（地址互斥、`loc` 必须以 `css:` 开头、数字必须整数并夹取），然后一次 `bridge.request(sessionId, 'read', …, 20s)`；输出统一成 `{mode, text|tables, chars/totalChars/truncated 或 tableCount/truncated, root, url, title}`；render 文本模式给「读了多少字符/是否截断」，表格模式按表渲染表头与行；`isConcurrencySafe=false`（与其它页面工具一样串行）。错误文案在工具内单独维护（`readFailure`），`loc`/`selector` 会出现在消息里。

### 3.4 计数与打包

工具 17→18：`tooldefs`/`toolviews`/`wait`/`pick` 注册表测试、`tools/check-docs.mjs` 的固定数字、两份 README「十八个工具」同步；`tools/pack.mjs` 的 COPY 与 `dist/package.json` 的 `files` 必须包含 `inject/read.js`（check-docs 第 7 项会拦）。

## 4. 证据

| 层 | 证据 |
|---|---|
| 页面侧 | `plugin/test/read.test.mjs`：正文归一/截断、loc/selector/ref、stale/bad/multiple 稳定码、隐藏文字不进结果、表格表头与行列、`maxRows`/`maxTables` 截断、源码是单函数表达式 |
| 工具侧 | 同文件：一次 `read` 命令、零审批、地址互斥、`loc` 前缀、数字校验与夹取、表格映射与渲染、空表提示、错误码与消息、截断文案 |
| 相位 | 同文件：真实 `Bridge` 在 `taken_over` 与 `needs_human` 下均不拦截 `read`（排队后关闭桥 → `bridge_closed`） |
| 总量 | 全量 **421/421**（原 401 + read 20） |
| 门禁 | `node tools/check-docs.mjs` 七项全绿（配置 23、工具 18、YAML 14、decisions 10、B11、file:line 12、打包清单 8 inject + 15 宿主 + dist files） |

### 4.1 真机证据

夹具 `demo/read.html`（长文 + 一张 4 行报表 + 一张 2 行表 + 一段 `display:none` 文字）：

```
browser_read {} → Read 541 rendered character(s) from body …（正文按段落，隐藏文字未出现）
browser_read {mode:"table"} → Read 2 table(s) under body …
  Table 1 — 十一月报表 (4 row(s))
    日期 | 渠道 | 金额
    2025-11-01 | 自然搜索 | 12.00
    …
browser_read {loc:"css:#article"} → Read 300 of 346 rendered characters from div "十一月的发布说明…"（截断抬头）
browser_read {ref:"e1"} → Read 6 rendered character(s) from h1 "页面阅读夹具".
browser_read {loc:"css:#nope"} → Error: loc "css:#nope" no longer matches anything in the page …
browser_read {selector:"table", strict:true} → Error: selector "table" matched 2 element(s). Pass strict:false to read the first match, or narrow the selector.
```

## 5. 不做

- 不读布局几何（坐标/可见性/字体）——要位置用快照或 `browser_pick`；
- 不做 HTML 源码模式（用 `browser_eval` 取 `outerHTML`）；
- 不做表格外推（div 伪表格不猜，只认真 `<table>`）；
- 不做跨域 iframe 内文本（地址前缀只支持同源 `f1:` 快照 ref）；
- 不新增错误码、不新增审批动作类。

## 6. 验收清单

- [x] 正文、表格、loc/ref/selector、截断、隐藏文字
- [x] `stale_loc` / `multiple` / `not_found` 文案可执行
- [x] 人工相位（`taken_over` / `needs_human`）可用
- [x] 单测 421/421、check-docs 七项全绿
- [x] 1.5.24 打包（381,295 B / sha `ddb4226e…`）并装机
- [x] 真机 R1–R7、`docs/cases/031`
