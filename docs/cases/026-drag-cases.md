# 案例 026：`browser_drag` 真机验收（1.5.14）

**日期**：2026-11-27
**对象**：`browser_drag`（第 15 个工具）+ `actionClass: drag` 审批
**夹具**：`demo/drag.html`（工作区静态服务，`http://127.0.0.1:7339/t/demo/drag.html`）
**目的**：确认三种落点（loc→loc、`dx`/`dy`、`toX`/`toY`）都真的触发页面自己的 pointer 处理器；确认写动作确认条覆盖拖拽；确认失败路径在派发事件前就拒绝。

## 1. 结论

| 编号 | 检查 | 结果 |
|---|---|---|
| D1 | 工具注册 | ✅ `browser_drag` 出现在工具表（第 15 个），面板无需重启即加载 1.5.14 客户端（`CLIENT_REV 58`） |
| D2 | loc→loc 拖拽 | ✅ `from:{loc:"css:#handle"}` → `to:{loc:"css:#lane"}` 返回落点，页面状态变「已放进轨道」 |
| D3 | `dx`/`dy` 相对落点 | ✅ `to:{dx:260,dy:10}` → `(367, 299)` |
| D4 | `toX`/`toY` 绝对落点 | ✅ `from:{ref:"e2"}` → `to:{toX:409,toY:291}` → `(409, 291)` |
| D5 | 页面真的收到手势 | ✅ 夹具只监听 `pointerdown/pointermove/pointerup`，每次成功拖拽都让「次数」+1 |
| D6 | 写动作确认条 | ✅ 首次拖拽需确认；未确认时 `approval_timeout` 且页面无变化；授权后同一站点不再弹条 |
| D7 | 落点越界 | ✅ `toX:2000` → 「the drop target is outside the viewport … Nothing was dragged.」 |
| D8 | 源/目标失效 | ✅ `stale_loc`（`css:#nope`），且源地址不可解析时不弹确认条 |
| D9 | 读动作不受影响 | ✅ 拖拽前后 `browser_snapshot` 均只有 2 个 ref，页面自身无 console 错误尾巴 |

## 2. 命令与回执原文

安装 1.5.14 后确认面板（同版本重装会重挂面板；本版本无需完整重启 DSH）：

```
browser_tabs {action:"list"}
→ 1 tab(s), active t1.
  * t1: 新标签页
```

打开夹具：

```
browser_open {path:"demo/drag.html"}
→ Opened http://127.0.0.1:7339/t/demo/drag.html — 页面拖拽夹具
  Served from the workspace by a read-only local server on port 7339 (root: D:\Vibe coding\32 deepseek harness cebiankuang).
```

快照（`#handle` 是 `button`，`#lane` 只有文本、没有 ref，所以用 loc 定位）：

```
browser_snapshot
→ Snapshot gen 1 · 2 refs · 11 lines · 30 nodes walked · 1ms
  - page "页面拖拽夹具" url=http://127.0.0.1:7339/t/demo/drag.html
    - heading "页面拖拽夹具" [ref=e1] [loc="css:html > body:nth-of-type(1) > h1:nth-of-type(1)"]
    - button "拖拽把手" [ref=e2] [loc="css:#handle"]
```

loc→loc 拖拽：

```
browser_drag {from:{loc:"css:#handle"}, to:{loc:"css:#lane"}, steps:6}
→ Dragged button "拖拽把手" from (107, 289) to (409, 291).
  Released over div "放置轨道".
  A drag is a write: check what the page shows now with browser_snapshot before guessing that it took effect.
```

`dx`/`dy` 相对落点：

```
browser_drag {from:{loc:"css:#handle"}, to:{dx:260,dy:10}, steps:4}
→ Dragged button "拖拽把手" from (107, 289) to (367, 299).
```

`ref` + `toX`/`toY` 绝对落点：

```
browser_drag {from:{ref:"e2"}, to:{toX:409,toY:291}, steps:5}
→ Dragged button "拖拽把手" from (107, 289) to (409, 291).
```

页面状态（快照摘录）：

```
browser_snapshot
→ - text "状态："
  - text "已放进轨道 (409, 291)"
  - text "次数："
```

## 3. 确认条（写动作）

同一页面上，未授权站点时拖拽会先弹确认条。一次未在 30 秒内确认：

```
browser_drag {from:{loc:"css:#handle"}, to:{dx:260,dy:10}, steps:4}
→ Error: approval_timeout: 用户 30000ms 内没有确认在 127.0.0.1 拖拽「拖拽把手」。
  The user did not answer the permission prompt in time; nothing was sent to the page.
  Ask again when they are back.
```

用户点「本会话允许本站」后，同一站点的后续拖拽不再弹条（D2–D4 均直接执行）。确认文案只写「站点 + 拖拽 + 目标可读名」，不回显坐标与页面内容。

## 4. 失败路径

```
browser_drag {from:{loc:"css:#handle"}, to:{toX:2000,toY:200}}
→ Error: the drop target is outside the viewport even after scrolling to it, so the drag cannot be
  completed safely. The page may be moving the element (a sticky bar or lazy loading); take a new
  browser_snapshot and retry. Nothing was dragged.

browser_drag {from:{loc:"css:#handle"}, to:{loc:"css:#nope"}}
→ Error: loc "css:#nope" no longer matches anything in the page — it was replaced, removed, or you
  are on a different page now. Take a new browser_snapshot and use a loc (or ref) from that snapshot.

browser_drag {from:{loc:"css:#nope"}, to:{loc:"css:#lane"}}
→ Error: loc "css:#nope" no longer matches anything in the page — ...
```

第三条同时验证了一个细节：**源地址解析失败时不会弹确认条**（`confirmBefore` 先 inspect，`addressError` 直接交给动作报精确错误），避免为注定失败的动作打扰人。

## 5. 验收期发现

1. **中间点会落到「空隙」**：`elementFromPoint` 在把手与轨道之间返回 null 时，`dragEvent` 回退到源元素——行为正确（真实指针也在源元素上移动），但单测按「事件是否落在源/目标元素」计数会误导；断言改成「整条序列的 `pointermove`(buttons=1) 总数 = steps」。
2. **确认条覆盖 `drag` 需要单独接**：`confirmBefore` 只认识 click/type/eval/press/upload；拖拽无法从 inspect 分类，因此新增第六类 `actionClass: 'drag'` 并一律按写动作处理（首次触站必问）。
3. **原生 DnD 不是同一机制**：夹具用 pointer 事件实现所以通过；`draggable="true"` 的页面仍不覆盖（见 ticket §5）。

## 6. 复跑清单

1. `plugin_manager remove_bundle` + `install_bundle dist/dsh-plugin-agent-browser/dsh-plugin-agent-browser-1.5.14.tgz`；
2. `browser_tabs {action:"list"}` 确认面板可用；
3. `browser_open {path:"demo/drag.html"}` + `browser_snapshot`；
4. 依次执行 D2/D3/D4 三条 `browser_drag`；
5. 未授权站点先验证 D6（确认条/超时），再验证 D7/D8；
6. `browser_snapshot` 确认「次数」增加、`page console` / `page network` 无异常尾巴。

## 7. 已知边界

- 只覆盖页面脚本（pointer/mouse 事件族）实现的拖拽；**原生 HTML5 drag-and-drop 与 OS 文件拖拽不覆盖**。
- `from` 必须是页面元素地址；不能从空白坐标开始拖。
- `steps` 是线性插值（2–30）；没有多段路径/曲线。
- 跨域 iframe 内的元素可以解析坐标，但指针事件从组合根开始的行为受既有 frame 规则限制。
- 拖拽中不截图、不记录中间态；确认条文字不含坐标，验收时以返回的 `from`/`to` 与页面状态为准。
