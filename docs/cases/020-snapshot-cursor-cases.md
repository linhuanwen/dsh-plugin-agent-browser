# 案例 020：快照字符预算与 `cursor` 续读（TICKET-046）

> 结论：**截断的快照会返回 `cursor`，带 `cursor` 再调用能接着读下一段且不重复已交付行**；
> 页面在两次快照之间变化（本案例为列表追加 10 行）后旧 `cursor` 返回 `stale_cursor`（可重试），
> 绝不给出错位内容；续读默认不附图（本夹具上 291.5 KB → 584 B）。
> 测试环境：DSH 0.2.2-rc.5 + 插件 **1.5.7**（`CLIENT_REV` 53，第 18 个错误码 `stale_cursor`），
> 夹具 `demo/long.html`（120 行长列表 + 「追加 10 行」/「重置为 120 行」按钮），宿主侧插件静态服务端口 `3931`。
> 本案例只验证「引擎」；指纹与切片算法由 `plugin/test/snapshot-cursor.test.mjs`（7 例）锁定。

## 1. 结论表

| 场景 | 命令要点 | 结果 |
| --- | --- | --- |
| 截断并拿到 cursor | `browser_open {path:'demo/long.html'}` → `browser_snapshot {maxChars:800, includeImage:false}` | `gen 1 · 3 refs · 16 lines … 779 B`；footer `… tree cut at the character budget (16/132 lines delivered). Call browser_snapshot({cursor:"11qyjc.132.3.8320@16"}) for the next slice.`；cursor 结构 `<stamp>@<offset>`，stamp = `urlHash.总行数.引用数.字符数` |
| 续读下一段 | `browser_snapshot {cursor:"11qyjc.132.3.8320@16", includeImage:false, maxChars:800}` | `gen 2 · 3 refs · 12 lines … continued at line 17/132`；正文首行 `- continued from line 17 of 132 (earlier part already delivered)`，随后从 `row 005` 继续（前一段止于 `row 004`，**无重复**）；footer 给出下一个 cursor `…@27` |
| 页面变化后旧 cursor | 用 loc 点击「追加 10 行」（`browser_click {loc:'css:#append'}`，读动作）→ 再用旧 cursor `…@27` | **立即** `Error: stale_cursor: the page changed since that cursor was issued; take a fresh browser_snapshot and continue from the cursor it returns.` |
| 重新快照后新 cursor 可用 | `browser_snapshot {maxChars:600, includeImage:false}` | `gen 4 · 3 refs · 13 lines … 584 B`，行数变 `142`、字符数变 `8811` → 新 stamp `11qyjc.142.3.8811@13`；后续续读 `continued at line 14/142` 正常 |
| 续读默认不附图 | `browser_snapshot {maxChars:600}`（默认附图）→ 用其 cursor 再调用（不传 `includeImage`） | 首个快照 `291.5 KB`（附 863×1294 截图）；续读 `584 B`、无 `Image sha256:` 行 —— 续读默认省掉截图 |
| 不带 cursor 的旧行为 | `browser_snapshot`（不传 cursor） | 与 1.5.6 一致：整棵树按 `maxChars` 截断、`truncated` 语义不变；不同在于 footer 现在给出 `cursor` 续读提示 |

## 2. 验收期发现

1. **指纹把「字符数」算进去很关键**：追加 10 行同时改变了总行数（132→142）与字符数（8320→8811），
   任一变化都会让旧 cursor 失效；这比只算行数更保守——同样的行数如果内容长度变了，偏移同样不可信。
2. **续读抬头计入预算，且行号口径要解释清楚**：第一段报 `16/132 lines delivered`，续读从「line 17」开始；
   抬头本身占一行预算，所以续读正文看起来晚一行，但**已交付行没有重复**（前段止于 `row 004`，后段始于 `row 005`）。
   文档与 render 文案统一用「continued at line N/M」口径，避免模型误判重复。
3. **续读默认不附图是实打实的省**：同一段内容，首拍（默认）291.5 KB，续读 584 B；
   需要截图时显式 `includeImage:true` 仍可附——与 TICKET-045 的 `loc` 一样，默认值服务「省上下文」。

## 3. 已知边界

- `cursor` 只按**整棵树的行偏移**续读，不绑定某个元素/子树；按元素续读留待 B2「快照语义」评估。
- 续读每次仍重走一遍 DOM（换取无跨快照缓存、实现简单、指纹可校验）；超大页面截断时反正也读不完，
  R1 的遍历成本可接受，节点上限暂不加。
- 指纹是 advisory：`cursor` 由模型显式携带、不是长期票据；页面变化而 stamp 恰好相同（极端）时，
  给的是「同一偏移的当前内容」，不会越界，但仍可能跳过新增内容——文档要求「页面变化后重新快照」。
- `cursor` 长度超过 300 字符会在发往面板前被拒（参数不合法），只接受本插件签发过的值。
- 续读不刷新 ref（快照每次重编号），跨快照定位继续用 `loc`（见 cases/019）。

## 4. 复跑方式

```powershell
# 单测（7 例）
node --test plugin/test/snapshot-cursor.test.mjs

# 全量（296 例）
node --test plugin/test/*.test.mjs

# 真机（插件 1.5.7 已装机、面板打开）
#   browser_open {path:'demo/long.html'}
#   browser_snapshot {maxChars:800, includeImage:false}
#     → 记下 footer 的 cursor（形如 11qyjc.132.3.8320@16）
#   browser_snapshot {cursor:'<cursor>', includeImage:false, maxChars:800}
#     → 期望 continued at line N/M，且正文不重复
#   browser_click {loc:'css:#append'}            # 读动作，追加 10 行
#   browser_snapshot {cursor:'<旧 cursor>'}      → 期望 stale_cursor
#   browser_snapshot {maxChars:600}              → 新 stamp、续读默认不附图
```
