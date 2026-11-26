# 案例 019：快照稳定定位符 `loc=`（TICKET-045）

> 结论：**快照按预期给交互节点追加 `[loc="css:…"]`**；`loc` 能跨快照完成点击/悬停/输入/提交类点击，
> 定位失败时会快速分型（`stale_loc` / `bad_loc`）且**不弹确认**（地址根本解析不了，动作注定不会发生）。
> 测试环境：DSH 0.2.2-rc.5 + 插件 **1.5.6**（`CLIENT_REV` 52），夹具 `demo/approval-form.html`
> （`input[name="nick"]`、`#plain`、提交按钮、`#link`、`#file`），宿主侧插件静态服务端口 `14834`。
> 本案例只验证「引擎」；`loc` 的生成算法（锚点选择、自校验、长度上限）由
> `plugin/test/snapshot-loc.test.mjs` 与 `plugin/test/actions.test.mjs` 的 12 例锁定。

## 1. 结论表

| 场景 | 命令要点 | 结果 |
| --- | --- | --- |
| 快照打印 loc | `browser_open {path:'demo/approval-form.html'}` → `browser_snapshot` | 7 个 ref 全部带 `[loc="css:…"]`：`#plain`、`#link`、`#file`、`input[name="nick"]`、`input[name="secret"]` 用锚点，标题与按钮用 `html > body:nth-of-type(1) > …` 位置路径 |
| 跨快照点击（读） | 先多次快照（ref 重新编号）→ `browser_click {loc:'css:#plain'}` | `Clicked button "普通按钮" at (126, 242).`，**没有**用任何 ref |
| 跨快照悬停（读） | `browser_hover {loc:'css:#plain'}` | `Hovered button "普通按钮" at (126, 242).` |
| 跨快照输入（写） | `browser_type {loc:'css:input[name="nick"]', text:'loc 定位测试'}` | 确认条弹出（origin 正确写 `127.0.0.1`），用户点「允许一次」→ `Typed 8 characters into textbox "普通文本框".`；快照 `value="loc 定位测试"` |
| 跨快照提交类点击（写） | `browser_click {loc:'css:html > body:nth-of-type(1) > section:nth-of-type(1) > form:nth-of-type(1) > button:nth-of-type(1)'}` | 提交类判定由 `inspect` 用同一 locator 完成、确认后执行 → `Clicked button "提交"`，快照 `#count = 1` |
| 换页后旧 loc | 在 `demo/wait.html` 上 `browser_click {loc:'css:#plain'}` | **立即**返回 `Error: loc "css:#plain" no longer matches anything in the page — it was replaced, removed, or you are on a different page now. Take a new browser_snapshot …`（`stale_loc`，**没有**先弹 30 秒确认条） |
| 非 css scheme | `browser_click {loc:'role:button'}` | `Error: "role:button" is not a loc. Copy the whole loc="css:…" value from the latest browser_snapshot, e.g. css:#save …`（`bad_loc`） |

## 2. 验收期发现

1. **「定位失败」不能先弹确认条**：最初 `confirmBefore` 无论 `inspect` 成功与否都按提交类保守问一次，
   导致 `stale_loc` 的点击先等满 30 秒 `approval_timeout` 才失败——对一个注定不会发生的动作问用户，
   既误导人又浪费时间。修法：`inspect` 返回 `addressError`（`stale_loc`/`bad_loc`/`stale_ref`/`bad_ref`），
   `confirmBefore` 见到就跳过确认，让页面把精确错误报回来（`plugin/tools.js`；`gate.test.mjs` 新增第 12 例锁定）。
2. **错误文案要带「下一步做什么」**：`stale_loc` 明确要求「重新快照、用新快照的 loc/ref」，
   `bad_loc` 给出复制 `css:…` 的提示；否则模型容易换个 locator 猜。
3. **位置路径会很长**：`[data-testid]`/`name`/`#id` 锚点能显著缩短 loc（本页 `#plain` 只有 9 字符，
   而提交按钮的位置路径约 78 字符）；锚点选择顺序与 120 字符上限由单测对拍锁定。

## 3. 已知边界

- 同一快照内 `loc` 与 `ref` 等价；**跨快照**只有 `loc` 稳定（ref 每次从 1 重编号）。
- 页面重渲染后若元素被替换/移动，`loc` 可能落到别处或失效——`cssPathOf` 在生成时已用
  `querySelector(path) === element` 自校验，但页面后续变化只能靠 `stale_loc` 兜底。
- 重复 `#id`、无稳定锚点且兄弟节点频繁增删的页面，`loc` 会退化为位置路径，最不稳定，也可能被省略
  （超过 120 字符不打印）。此时工具描述要求「回到 ref」。
- `loc` 只支持 `css:` scheme（不做 `role:`/`text:`/`href:` 形态）；`a[href]` 链接的 href 仍在快照行的
  `href=` 属性里，需要可读的标识就用 `#id`/`name`/`data-testid` 锚点。

## 4. 复跑方式

```powershell
# 单测（12 例相关：snapshot-loc 3 + actions 6 + gate 3）
node --test plugin/test/snapshot-loc.test.mjs plugin/test/actions.test.mjs plugin/test/gate.test.mjs

# 全量（289 例）
node --test plugin/test/*.test.mjs

# 真机（插件 1.5.6 已装机、面板打开）
#   browser_open {path:'demo/approval-form.html'}
#   browser_snapshot                          → 记下 [loc="css:…"]
#   browser_click {loc:'css:#plain'}          → 读动作，成功
#   browser_hover {loc:'css:#plain'}
#   browser_type {loc:'css:input[name="nick"]', text:'loc 定位测试'}   → 用户点「允许一次」
#   browser_click {loc:'<提交按钮的 loc>'}     → 用户点「允许一次」，快照 #count = 1
#   browser_open {path:'demo/wait.html'} → browser_click {loc:'css:#plain'}  → stale_loc
#   browser_click {loc:'role:button'}         → bad_loc
```
