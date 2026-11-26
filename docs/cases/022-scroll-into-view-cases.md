# browser_scroll 寻址滚动案例（TICKET-048）

日期：2026-11-27 · 插件 1.5.9 · 宿主 DSH 0.2.2-rc.5 · 夹具 `demo/scroll.html`（页面顶部两个按钮，80 行列表之后再放远端按钮 / 输入框）

## 1. 结论

| # | 情形 | 命令 | 结果 |
| --- | --- | --- | --- |
| S1 | 按 `loc` 滚到远端元素 | `browser_scroll {loc:"css:#deep"}` | `Scrolled button "远端按钮 deep" into view at (24, 778) 103×25 — fully in view.` ✅ |
| S2 | 按 `ref` 滚回顶部元素 | `browser_scroll {ref:"e2"}` | `Scrolled button "顶部按钮" into view at (24, 203) 69×25 — fully in view.` ✅ |
| S3 | 旧的 `dy` 行为不变 | `browser_scroll {dy:600}` | `Scrolled to y=600 of 2951. Snapshot again to see what has loaded.` ✅ |
| S4 | 失效地址 | `browser_scroll {loc:"css:#nope"}` | `Error: loc "css:#nope" no longer matches anything in the page — …Take a new browser_snapshot…`（`stale_loc`）✅ |
| S5 | 地址与 dy 混用 | `browser_scroll {loc:"css:#deep", dy:100}` | `Error: ref/loc/selector scroll the element into view; do not combine it with dy, to or container` ✅ |
| S6 | 地址解析失败不弹确认条 | S4/S5 | 均为读动作/用法错误，无 `approval_*`、无 30s 等待 ✅ |

## 2. 验收期说明

- 快照里的 `loc` 只出现在「有 ref 的交互节点」上（`REF_ROLE`），列表项这类纯文本节点没有 `loc`——所以夹具把远端目标做成按钮 / 输入框，这也是真实用户的典型场景（表单在长页底部）。
- `scrollIntoView` 会触发懒加载，回执里的 `scrollHeight` 是滚动后的值；不要把第一次的 `scrollHeight` 当成页面最终高度。
- 与 `loc=` 定位（TICKET-045）共用解析器：唯一的差别是滚动只要求「可见」，不要求可点击/可编辑。

## 3. 已知边界

- 只作用于当前文档与同源 iframe；跨域 iframe 内元素仍只能坐标点击，滚动同理受限。
- `container`（滚某个可滚动容器内部）+ 地址不混用：地址滚动作用于页面视口。若目标是「把容器内元素滚到容器可见区」，当前用 `browser_scroll {container, dy}` 手动滚容器。
- `visible` / `fullyVisible` 是滚动完成那一刻的测量值；固定定位头尾可能让 `fullyVisible` 为 false（被覆盖），这是页面布局事实。

## 4. 复跑

```bash
node --test plugin/test/scroll.test.mjs
node --test plugin/test/*.test.mjs   # 318 例
node tools/check-docs.mjs
```

真机步骤：`browser_open {path:'demo/scroll.html'}` → `browser_snapshot` → `browser_scroll {loc:"css:#deep"}` → `browser_scroll {ref:"<顶部元素>"}` → `browser_scroll {loc:"css:#nope"}`。
