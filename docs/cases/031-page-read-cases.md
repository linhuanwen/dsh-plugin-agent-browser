# cases/031 `browser_read` 装机案例（1.5.24）

夹具：`demo/read.html`（长文 + 4 行报表 + 2 行表 + 一段 `display:none` 文字）。
静态服务端口由插件自动分配（本次 **14718**）。

## 1. 结论

| # | 结论 | 判定 |
|---|---|---|
| R1 | 无参数读整页正文：541 字符，按段落输出，`display:none` 的「隐藏文字」不出现 | ✅ |
| R2 | 表格模式：2 张表、表头与行列正确（`日期/渠道/金额`、`键/值`） | ✅ |
| R3 | `loc` 指定根：正文来自该元素，`maxChars` 截断并回报 `300 of 346` | ✅ |
| R4 | `ref` 指定根：读 `h1` 6 字符（dev ref 同样有效） | ✅ |
| R5 | 失效 `loc` 报 `stale_loc`，错误消息点名 loc、提示重新快照 | ✅ |
| R6 | `selector` 多命中且 `strict:true` 报 `multiple`，消息点名 selector 与命中数 | ✅ |
| R7 | 纯读零审批；`taken_over`/`needs_human` 下不被拦（真实 Bridge 单测覆盖） | ✅ |
| R8 | 预算夹取：`maxChars:100` 被夹到 200（页面侧下限），未报错 | ✅ |
| R9 | 全量 421/421、check-docs 七项全绿；1.5.24 装机无需重启面板 | ✅ |

## 2. 命令与回执原文

面板就绪后：

```
browser_open {path:"demo/read.html"}
→ Opened http://127.0.0.1:14718/t/demo/read.html — 页面阅读夹具

browser_read {}
→ Read 541 rendered character(s) from body "页面阅读夹具 验证 browser_read：读渲染出来的文字与表格，而不是无障碍树。页面上另有一段 display:n…"
  （正文按段落输出；「隐藏文字」未出现）

browser_read {mode:"table"}
→ Read 2 table(s) under body "页面阅读夹具 …"
  Table 1 — 十一月报表 (4 row(s))
    日期 | 渠道 | 金额
    2025-11-01 | 自然搜索 | 12.00
    …
  Table 2 — (no caption) (2 row(s))
    键 | 值
    窗口 | 最近七天

browser_read {loc:"css:#article", maxChars:300}
→ Read 300 of 346 rendered characters from div "十一月的发布说明…" (truncated; narrow it with loc/selector or raise maxChars).

browser_read {ref:"e1"}
→ Read 6 rendered character(s) from h1 "页面阅读夹具".

browser_read {loc:"css:#nope"}
→ Error: loc "css:#nope" no longer matches anything in the page — it was replaced, removed, or you are on a different page now. Take a new browser_snapshot and use a loc (or ref) from that snapshot.

browser_read {selector:"table", strict:true}
→ Error: selector "table" matched 2 element(s). Pass strict:false to read the first match, or narrow the selector.
```

人工相位：本机面板按钮长时间显示「我来接管」，用户两轮均未真正点中，未获得 `taken_over` 真机回执；由 `plugin/test/read.test.mjs` 的真实 `Bridge` 用例覆盖（`taken_over`/`needs_human` 下 `read` 正常入队，随后关桥变 `bridge_closed`，而非 `panel_taken_over`/`needs_human`）。

## 3. 验收期发现

1. **失败回执丢地址**：首包在 `loc` 失效时回执里 `loc` 为空串，工具层因此拼不出可执行文案 → `read.js` 失败分支补带实际地址与匹配数，工具层新增 `readFailure` 按码定制消息；重打包后 R5/R6 文案正常。
2. **预算下限**：页面侧把 `maxChars` 夹到 200（防止读到半行就断），工具层允许 200–40000；传 100 会被夹到 200，属设计内。
3. **`hidden` 文字**：`innerText` 天然忽略 `display:none`，与快照的无障碍树口径一致，无需额外判断。
4. **如果页面表格是 div 拼的**：本工具只认真 `<table>`；伪表格请用 `browser_snapshot` 或 `browser_eval`。

## 4. 复跑

```
node --test plugin/test/read.test.mjs      # 20 例
node --test plugin/test/*.test.mjs         # 421 例
node tools/check-docs.mjs                  # 七项全绿
```

## 5. 已知边界

- 只读 `innerText`，不读几何/可见性/样式；要位置用 `browser_snapshot` 或 `browser_pick`；
- HTML 源码走 `browser_eval` 的 `outerHTML`，本工具不提供源码模式；
- 只认 `<table>`；跨域 iframe 文本不可读（`f1:` 仅同源快照 ref）；
- 表格单元格最多保留 50 列，超出的列被丢弃（`truncated` 会提示行数，列上限不单独回报）；
- 读完不改变页面、不滚动、不聚焦，也不产生可点击的 ref。
