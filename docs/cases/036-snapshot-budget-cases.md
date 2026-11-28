# 案例 036：快照预算规划（TICKET-062）

- 日期：2026-11-28
- 版本：1.5.28（`CLIENT_REV 67`）
- 环境：DeepSeek Harness Desktop、右侧栏浏览器面板
- 夹具：`demo/dense.html`（长正文把交互节点推出预算之外 + 10 行同构文本）；静态服务端口 4447
- 结论表：

| # | 场景 | 结果 |
| --- | --- | --- |
| E1 | `browser_snapshot {maxChars:900}` 在长正文页 | ✅ 887 B 内交付整棵树：6 个 ref 全部保留，正文带 `… (+N chars elided)`，3 段正文折叠成 1 行提示，10 行列表折叠，无 cursor |
| E2 | `maxChars:500`（工具下限） | ✅ 按行切在 11/26，返回 `cursor:"aik4j8.26.6.1345@11"`，footer 提示续读 |
| E3 | 用 E2 的 cursor 续读 | ✅ `continued at line 12/26`，495 B，剩余 ref（textbox/保存/取消/帮助/回到顶部）完整，再次切在 22/26 给第二个 cursor |
| E4 | 默认预算（8000） | ✅ 26 行全文照旧，1.3 KB，与 1.5.27 一致 |
| E5 | 页面侧契约 | ✅ 页面只返回全量 `lines` + `stamp`，切片与 cursor 在宿主侧规划；`stale cursor` 仍由页面 stamp 校验 |

## 命令与回执原文

```text
browser_open {path:"demo/dense.html"}
→ Opened http://127.0.0.1:4447/t/demo/dense.html — 快照预算夹具

browser_snapshot {maxChars:900, includeImage:false}
→ Snapshot gen 1 · 6 refs · 26 lines · 78 nodes walked · 1ms · 887 B
  - heading "快照预算夹具" [ref=e1] [loc="css:html > body:nth-of-type(1) > h1:nth-of-type(1)"]
    - paragraph "第一段：快照是 agent 每次… (+73 chars elided)"
    - paragraph "第二段：交互节点和纯文本不应该同… (+59 chars elided)"
  - … 3 more paragraph item(s) elided (use browser_read for page content)
    - paragraph "第六段：再来一段，确保默认预算之… (+45 chars elided)"
    - textbox "写点什么" [ref=e2] [loc="css:input[name=\"note\"]"]
  - button "保存" [ref=e3] [loc="css:#save"]
  - button "取消" [ref=e4] [loc="css:#cancel"]
  - button "帮助" [ref=e5] [loc="css:#help"]
  - link "回到顶部" [ref=e6] [loc="css:html > body:nth-of-type(1) > div:nth-of-type(1) > a:nth-of-type(1)"]
  - text "列表行 01 — 同构内容同构内容同构内容"
  - text "列表行 02 — 同构内容同构内容同构内容"
- … 7 more text line(s) elided (use browser_read for page content)
  - text "列表行 10 — 同构内容同构内容同构内容"

browser_snapshot {maxChars:500, includeImage:false}
→ Snapshot gen 2 · 6 refs · 26 lines · 78 nodes walked · 1ms · 399 B
  …
… tree cut at the character budget (11/26 lines delivered).
  Call browser_snapshot({cursor:"aik4j8.26.6.1345@11"}) for the next slice.

browser_snapshot {cursor:"aik4j8.26.6.1345@11", maxChars:500, includeImage:false}
→ Snapshot gen 3 · 6 refs · 26 lines · 78 nodes walked · 1ms · 495 B continued at line 12/26
    - textbox "写点什么" [ref=e2] [loc="css:input[name=\"note\"]"]
  - button "保存" [ref=e3] [loc="css:#save"]
  - button "取消" [ref=e4] [loc="css:#cancel"]
  - button "帮助" [ref=e5] [loc="css:#help"]
  - link "回到顶部" [ref=e6] [loc="css:html > body:nth-of-type(1) > div:nth-of-type(1) > a:nth-of-type(1)"]
  …
… tree cut at the character budget (22/26 lines delivered).
  Call browser_snapshot({cursor:"aik4j8.26.6.1345@22"}) for the next slice.

browser_snapshot {includeImage:false}   # 默认 8000
→ Snapshot gen 4 · 6 refs · 26 lines · 78 nodes walked · 1ms · 1.3 KB
  （26 行全文，行为与 1.5.27 相同）
```

## 验收期发现

1. **长正文不是 `- text` 行，而是元素行**：真实页面里段落生成的是 `- paragraph "…"` 这类无语义引用行，首版规划器只省略 `- text "…"`，结果仍然按行切断、按钮拿不到。修复：把「带引号名字、无 ref/loc 的元素行」也纳入省略（保留 role、缩进与尾随状态）。
2. **折叠必须计入预算估计**：首版预算检查用未折叠的成本，页面里的长列表被判定装不下而直接切；折叠后明明能装下。修复：cap ≤ 80 时用折叠后的文本长度作为交付成本。
3. **role 识别用正则踩坑**：`/^\s*- ([a-z][\w-]*) "/.exec(...)` 在注入/解析链路里没有拿到角色（导致折叠的 key 为空、从不折叠），改为字符串解析（`trim` → `- ` → 找 ` "`）。
4. **客户端 bundle 缓存**：1.5.28 装机后面板仍跑 1.5.27 客户端（快照请求不带 `raw`），连 10 秒内截断行为都不变；完整重启 DSH 后新客户端生效。与 TICKET-055 的缓存现象一致，文档继续要求「行为没变就完整重启」。

## 复跑步骤

1. `node tools/pack.mjs` 确认包内含 `inject/snapshot.js`、`snapshot-plan.js`；`remove_bundle` + `install_bundle` 1.5.28。
2. 若面板行为与旧版一致（截断时没有省略标记），完整重启 DSH。
3. `browser_open {path:'demo/dense.html'}`，依次执行 E1–E4 的 `browser_snapshot` 调用并对照回执。

## 已知边界

- 省略只改「交付文本」，不改页面、不改引用编号；被省略的正文随时用 `browser_read` 读。
- 折叠只针对连续的纯正文行与同 role 的重复项，不折叠可交互行（带 `ref`/`loc` 的行永远原样）。
- 预算下限仍由工具夹到 500 字符、上限 30000；默认预算 8000 下行为不变。
- cursor 仍是「全量行号偏移」，页面变化（stamp 变化）后旧 cursor 失效（`stale_cursor`）。
- 跨域 iframe 内的树仍按既有规则标记为 `[cross-origin: use coordinates]`，预算规划不改变这一点。
