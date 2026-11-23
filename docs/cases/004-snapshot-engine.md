# 参考 004：快照引擎的实现与实测

- 状态: 已实测（2026-11-19）
- 关联: TICKET-003、spec §5.2 §6、决策 D06
- 代码: `plugin/inject/snapshot.js`（页面内遍历器）、`plugin/tools.js`（host 整形 + 截图落 attachment）、`plugin/client.js`（`Guest.snapshot/capture`）

## 1. 为什么是"页面内遍历 + 纯字符串注入"

DSH 的 webview 没有 Playwright，也不能在 guest 里 `import` 任何东西。唯一的通用通道是 `webview.executeJavaScript(source)`，所以：

- 遍历器写成**单个自包含函数** `function dshSnapshot(options)`，按字符串拼上参数后注入：`(${source})(${JSON.stringify({ maxChars })})`；
- 全部结果 `JSON.stringify` 一次返回，host 只做整形，不做 DOM 二次访问；
- ref 落在 DOM 上的 `data-dsh-ref` 属性里，动作工具（TICKET-004）只需 `querySelector('[data-dsh-ref="e12"]')`，host 与页面之间不需要维护任何注册表。

`plugin/inject/snapshot.js` **每次调用都重新读盘**（`snapshotSource()`）。理由：host 半的模块生命周期可能比一次文件编辑更长，实测过一次"磁盘 12228 字符、注入 12207 字符"的陈旧脚本，排查成本极高；12 KB 的读盘代价可以忽略。

## 2. 输出格式

第一行固定是页面本身：

```
- page "Signup Form" url=http://127.0.0.1:8795/form
```

之后每个可操作/有语义的节点一行，两空格缩进一层：

```
  - heading "Signup Form" [ref=e1]
  - form
    - paragraph "Full name"
      - textbox "Full name" [ref=e2] required
    - paragraph "I agree to the terms"
      - checkbox "I agree to the terms" [ref=e5] checked
    - paragraph "Plan Free Pro"
      - combobox "Plan" [ref=e7] value="pro"
        - option "Free" [ref=e8]
        - option "Pro" [ref=e9] selected
```

规则：

| 项 | 规则 |
|---|---|
| ref | 只有进入 `REF_ROLE` 的 role 才打 ref（link/button/textbox/checkbox/option/heading/img…），纯结构容器不打 |
| 名字 | `aria-label` → `aria-labelledby` → `alt` → `title` → `placeholder` → `<label>` → 内部文本 → `value` |
| 状态 | `disabled` / `required` / `readonly` / `checked`（含 `mixed`）/ `expanded`·`collapsed` / `selected` / `pressed` / `value="…"` / `href="…"` |
| 密码 | 恒为 `value=***`，不读 `value` 属性 |
| 隐藏 | `display:none` / `visibility:hidden` / `opacity:0` / 0 尺寸 / `aria-hidden="true"` 的子树整棵跳过；`opacity:0`、`visibility:hidden` 只静音自身文本 |
| 空名容器 | 无名 `div`/`span`/`section` 不单独成行，但不影响其子节点 |
| iframe | 同源：递归展开，ref 前缀 `f1`、`f2`…（`f1e3`）；跨域：`- iframe "<src>" [cross-origin: use coordinates]` |
| 预算 | `maxChars` 默认 8000，超预算立即停止并置 `truncated: true`，只在行边界断 |

## 3. 返回值

```json
{ "gen": 3, "url": "…", "text": "…", "refCount": 15, "nodeCount": 26,
  "visited": 68, "truncated": false, "ms": 1, "frames": 0 }
```

- `nodeCount`：输出行数（不含 `page` 首行）；
- `visited`：真正检查过的节点数（含被跳过、未成行的），用于性能取证；
- `gen`：本帧的 `data-dsh-gen` 自增后写回 `<html>` 与每个已展开子帧的 `documentElement`。

工具侧再包一层 `browser_snapshot` 的 `output.schema`，把 `image` 作为 `ImageAttachmentRef` 放进返回值，`render()` 时拼成 `[{type:'text'}, {type:'image', attachment}]`（图片内容块必须走 attachment，见 `docs/cases/002` §3）。

## 4. 截图

```
capturePage() → isEmpty()? → getSize()（设备像素）
  ratio  = deviceWidth / cssWidth          // DPR，实测 1.5
  target = min(deviceWidth, round(768 * ratio))
  resize({ width: target })                // 只在确实超宽时
  toDataURL() → base64 → ctx.attachments.saveImage()
```

**`capturePage()` 会在 guest 没有可复制的帧时一直挂着**——不 reject、不 resolve。实测三种触发条件：面板刚挂载、刚 `loadURL` 完、面板不可见。处置见 §5。

## 5. 三个必须记住的坑

1. **预热**：`Guest.mount()` 在 `dom-ready` 之后立刻打一发 `element.capturePage().catch(() => {})`，让第一帧尽早产生。加这一步之前，"新面板 + 立刻快照"必然拿到无图快照。
2. **等 `did-stop-loading`**：`loadURL()` 只等到导航提交，不等文档加载完；`browser_open` 现在多等一个 `did-stop-loading`（上限 15s），否则紧接着的快照会在白屏上拍图。
3. **重试而不是一次定生死**：`capturePainted()` 单次上限 1.2s、最多 3 次（间隔 0/250/400ms），全失败就返回纯文本树并在正文补一句说明。整条链路的外层上限 6s。

## 6. 实测数据（本地夹具 `tools/testsite.mjs`）

夹具同时监听 `8795`（同源）与 `8796`（跨域 iframe 用），`node tools/testsite.mjs 8795` 启动。

| 页面 | 断言 | 结果 |
|---|---|---|
| `/` | 基础树 + ref | `4 refs`，`- heading "Panel Test Page" [ref=e1]`、`textbox "Search field" [ref=e2]` |
| `/form` | role/状态/密码/隐藏 | 15 refs；`required`、`checked`、`selected`、`readonly`、`disabled`、`value="pro"`、`value=***` 全部正确；隐藏区块 0 泄漏 |
| `/long`（6000 行） | 截断 | 8000 预算 → `truncated:true`，68 refs / 137 行 / 2ms；30000 预算 → 249 refs / 500 行 / 5ms |
| `/heavy`（12010 节点） | 性能 | `visited 12010`，**16ms**（预算内几乎不产出行，测的是纯遍历成本） |
| `/frames` | iframe | 同源展开为 `f1e3`/`f1e4`/`f1e5`；跨域输出占位 |
| `/form` | 体积 | 带图 6.7 KB；`includeImage:false` → 1.0 KB |

gen 递增：同一页面连续三次快照 → 1、2、3。

## 7. 已知偏差

- `https://example.com/` 已变成多语言落地页，**没有** `<h1>Example Domain</h1>`，ticket 里那条验收改由夹具首页 `<h1>` 证明。
- 注入脚本还没有 `node:test` 单测：纯 DOM 单测需要 jsdom，留到 TICKET-007 的构建链里一并做。
- `.offscreen`（绝对定位到视口外但已渲染）**会**出现在树里。判断"是否在视口内"要额外算 `IntersectionObserver` 或矩形交集，当前认为多输出比漏输出安全。

## 8. 下一步（TICKET-004 会用到的约定）

- 动作工具按 `[data-dsh-ref="e12"]` 找元素；iframe 内的 ref 要先进 `f1` 对应的 `contentDocument`；
- 点击：`executeJavaScript` 里 `scrollIntoView({block:'center'})` + `getBoundingClientRect()` 取中心点，再 `sendInputEvent` 发 `mouseDown`/`mouseUp`；
- 输入：先 `focus()`，再发 `keyDown`/`char`/`keyUp`（实测必须聚焦，否则 `value` 为空，见 `docs/cases/002` U5c）。
