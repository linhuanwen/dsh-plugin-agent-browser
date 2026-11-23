# TICKET-009：动作面补齐（滚动 / 语义点击 / 新窗口策略）

- 状态: ✅ 已完成，1.0.14 装机验收（2026-11-20）
- 优先级: P1（不阻塞 T4，但 T1 / T6 / T7 出不了干净结论）
- 关联 Spec: §5 工具契约、§10 **A15**
- 关联决策: `decisions/003-download-newwindow-and-task-cases.md` D14、D16
- 依赖: TICKET-004（动作工具）
- 改动目录: `plugin/`（`tools.js` / `client.js` / `bridge.js` / `inject/actions.js` / `test/actions.test.mjs`），打包进 `dist\dsh-plugin-agent-browser\`
- 验证夹具: `demo/ticket-009.html`

## 为什么三个一起做

三条都在**动作面**，改动集中在同一批文件（`tools.js` schema + `client.js` 的 guest 方法 + `inject/actions.js`），一次回归能全测完；分开做要重启三次应用、跑三遍同一套用例。

---

## ① `browser_scroll`：滚动原语（T1 懒加载 / T6 翻页必需）

**现状**：没有任何轮子/滚动工具。`inject/actions.js:93` 只有 `scrollIntoView({block:'center'})`——它能让"点 ref"自动滚入视口，但**触发不了懒加载**（不动就不会加载下一屏）。

```ts
browser_scroll({ dy?: number, to?: 'top' | 'bottom', container?: string /* selector */ })
```

- 默认 `dy: 600`；`to:'bottom'` 走 `window.scrollTo(0, document.body.scrollHeight)`；
- 滚动后**等一帧 + 150 ms** 再回快照，否则懒加载还没插桩；
- 返回 `{x, y, scrollHeight, viewportHeight, atBottom}`——`atBottom` 是 T6 判定"真的到底了"的独立信号。

**验收**：夹具页（虚拟列表 200 条）→ `scroll({to:'bottom'})` → 新快照出现末尾条目；连滚 3 次 `atBottom` 变 true；滚到底后 `scroll({dy:600})` 不报错。

## ② `browser_click({selector})`：语义点击（V12 / T1 分页）

**现状**：只有 `ref` 和 `x/y`。3D 卡片堆叠（V12 的 `.mapTypeCard`）与纯 icon 分页按钮必须靠 `browser_eval` 点——多一步、且 eval 失败时错误更难读。

- `click({selector})` 内部：`querySelectorAll` → 过滤不可见/零尺寸 → 取第一个 → `scrollIntoView` → **命中测试**（`elementFromPoint` 落在自身或后代，否则报 `occluded`，把"被弹层挡住"说清楚）→ 派发真实鼠标事件（`sendInputEvent`，保 `isTrusted`）。
- 失败要分型：`not_found` / `multiple`（>1 且未加 `strict:false`）/ `occluded` / `disabled`。

**验收**：V12 的 `.mapTypeCard.earth` 用 selector 点通；有弹层遮挡时返回 `occluded` 而不是静默失败；同一 selector 命中 3 个元素时返回 `multiple` 并在文案里列出各自文本。

## ③ 新窗口策略（**A15**）

**现状**：`setWindowOpenHandler` / `will-navigate` / `new-window` 全 0 命中 → `target="_blank"` 的行为未定义。

- `inject/actions.js`：点击前若 `el.target === '_blank'`（或 `el.target` 非 `_self`）→ 改成 `_self` 再点，**同视图导航**；
- `window.open` 猴子补丁（注入时安装）：记录 URL、返回 `null`，随下一次工具结果以 `blocked_new_window { url }` 暴露；
- 快照 header 的 `url` 必须与视图真实 URL 一致（导航了就不许还报旧 URL）。

**验收**：找一个 `target="_blank"` 的链接（1688 商品卡 / 规章附件）→ click 后**不出现新窗口**，同视图导航，快照 URL 变化；对 `window.open('https://example.com')` 的页面 → 返回 `blocked_new_window` 且附带 URL。

---

## 公共验收

- [x] 三个工具/行为都进工具表，`browser_snapshot` 不受影响（回归 V3/V4）
- [x] 单测：`selector` 命中测试的分型（`not_found`/`multiple`/`occluded`）用桩文档覆盖（`plugin/test/actions.test.mjs`，20 例）
- [x] 重打包（1.0.6 → 1.0.14 逐版修 bug 后定稿），`plugin_manager install_bundle` applied
- [x] `reference/010` 的 V12 补一句"地球切换用 selector 点击的真实结果"，`011` 的缺口表划掉 2/4 两条（6 已在 TICKET-008 完成）

## 实现记录（2026-11-20）

| 工具面 | 落地 |
|---|---|
| `browser_scroll` | `{dy?, to?:'top'\|'bottom', container?, waitMs?}`；页面或内层容器；滚后 `waitMs`（默认 150，上限 2000）再复读位置；返回 `{x,y,scrollHeight,viewportHeight,atBottom,blockedNewWindow?}`，`atBottom = y >= scrollHeight - viewportHeight - 1` |
| `browser_click({selector})` | `querySelectorAll` → 过滤 `display:none`/`visibility:hidden\|collapse`/`opacity:0`/零尺寸 → `scrollIntoView` → 等两帧 → 重新量矩形 → `elementFromPoint` 命中测试 → 失败分 `not_found`/`multiple`/`occluded`/`disabled`/`bad_selector`/`out_of_view`；`strict:false` 取第一个 |
| 新窗口 | A 标签 `target` 非 `_self/_top/_parent` 时改成 `_self` 再点（结果附 `targetFixed`）；`window.open` 猴子补丁返回 `null` 并记 URL，随**下一次**动作以 `blockedNewWindow` 报出 |
| 相位 | `bridge.js` 的 `INPUT_TYPES` 加入 `scroll`，用户接管/需人工时一并拒绝 |

**面板真跑（1.0.11，`http://127.0.0.1:<port>/demo/ticket-009.html`）**：

- 滚动：`to:'bottom'` 连滚把懒加载从 30 条推到 200 条，末次 `y=10375 of 11239 (at the bottom)`；到底再 `dy:600` 不报错、位置不动；`container:'#box'` 滚内层 500→2858，页面不动；`container:'#nope'` 报 `no element matched selector "#nope" (0 node(s)) …`。
- 语义点击：`#covered` 被浮层挡住 → `Error: selector "#covered" is covered by div "这是一个遮挡浮层…"，Nothing was clicked.`；`.pager` → `matched 3 visible elements: button "上一页", button "1", button "下一页"`；`#submit` → `that control is disabled ("提交（disabled）")`；关掉浮层后 `#covered` 真的收到点击（页面事件日志可证）。
- 新窗口：`#blank` → 同视图跳到 `demo/index.html` 并附 `The link asked for target="_blank"; it was followed in this view instead of opening a new window.`；`#pop` 触发 `window.open` → 返回 null，下一次动作带回 `window.open was blocked: https://example.com/from-fixture`。
- 懒加载位移：`#deep` 在页面底部且上方会因滚动追加内容，1.0.9 上曾点到空处（点前量到的坐标随后被挤走）→ 改为"量前等两帧 + `out_of_view` 时重滚重试一次（最多 2 次）"后命中（页面事件 `deep` = 1）。

**实现期发现（按发现顺序）**：① 高分屏 `scrollTop` 是小数 → 三处取整，否则 schema 报 `"value.y" must be an integer`；② `client.js` 的 click 只回传 `point`，`targetFixed`/`blockedNewWindow`/`matched` 全被吞 → 补透传；③ `occluded` 文案曾出现 `ref ""` → 失败载荷补 `selector`；④ 滚动失败沿用点击文案（"nothing to click"）→ `actionFailure(result, 'scroll')` 分开措辞；⑤ 懒加载把目标挤出视口 → 见上"懒加载位移"。

## 1.0.12 → 1.0.14（同日第二轮收紧，均已装机验证）

| 版本 | 改动 | 触发原因 | 验证 |
|---|---|---|---|
| 1.0.12 | `pickPoint(element, box)` 九点采样：中心 → 四边中点 → 四角 0.2/0.8，取第一个命中自身或后代的采样点 | 百度地图右下 `.mapTypeCard` 三张卡片只差 5 px 互相叠压，中心点永远落在上层卡上 | 单测 +2（半覆盖取可见侧 / 全覆盖仍 `occluded`） |
| 1.0.13 | `stableThenPayload()`：最多 6 轮"`scrollIntoView` → 等两帧 → 读 `scrollHeight` 与矩形 → 高度稳定且完整在视口内才出载荷" | `#deep` 在刚打开的夹具上有过"报 `Clicked…` 但页面事件数为 0"（懒加载在量坐标后把目标挤走） | 新开夹具点 `#deep` 两次，页面事件 `deep` 均为 1、条目到 200 |
| 1.0.14 | `takeBlocked()` / `neutralizeTarget()` 移到"确认要点击"之后 | `#pop` 触发的拦截警告会被中途一次 `occluded` 失败吞掉，模型再也看不到 | `#pop` → `#covered`（失败）→ `#dismiss2` 的回包带 `window.open was blocked: https://example.com/from-fixture` |

**真站结论（重要）**：`browser_click({selector:'.mapTypeCard.earth'})` 在百度地图上**仍然报 `occluded`**。实测三张卡 `normal`(349,738) / `earth`(354,738) / `panorama choosedType`(359,738)、各 86×60、`pointer-events:auto`、z 1/2/3 → 地球卡只露 **5 px 左缘**，九点采样也全落在"全景"卡上。这是**叠卡控件需要"先 hover/展开再点"**的结构性限制，不是命中测试的 bug → 已开 `tickets/010-hover-and-stacked-controls.md`（P2）。语义点击的边界因此写死为：**被 ≥30% 面积可见的遮挡可绕开；被整块盖住的不猜，直接报 `occluded` 并给出遮挡者名字**。

## 风险与残留

| 项 | 现状 |
|---|---|
| iframe 内的 `selector` 点击 | 不支持（只支持 ref）；`selector` 只在主文档 `querySelectorAll` |
| 叠卡/悬停展开类控件 | 只露几像素的卡片、hover 才展开的浮层**点不到**（百度地图 `.mapTypeCard.earth` 实测仍 `occluded`）；需 `browser_hover`，见 `tickets/010-hover-and-stacked-controls.md` |
| `elementFromPoint` 与 sticky 头 | 命中测试会把"被吸顶栏盖住"判为 `occluded`，属预期，但文案只报最上层元素名 |
| `waitMs` 仍是经验值 | 默认 150，最慢站点可调 600；`atBottom` 是独立信号，不依赖等待时长 |
| 文案编码事故 | 用 PowerShell 读写含中文的测试文件时被 ANSI 往返破坏 6 行，已用 Node 脚本修复；**以后改含中文的源文件一律用 `write`/`edit` 或 Node，不走 `Get-Content`/`Set-Content`** |

## 风险

| 风险 | 缓解 |
|---|---|
| 改 `target` 会被部分站点的事件处理感知（他们可能读 `event.target`） | 只改 `el.target` 属性、不改 DOM 结构；失败可回退为"点击前拦截并直接 `browser_open(href)`" |
| `elementFromPoint` 在 iframe 内坐标系不同 | iframe 内的 selector 点击本期不支持，明确报 `unsupported_frame` |
| 滚动等待 150 ms 是经验值 | 提供 `waitMs` 可选参数，默认 150，最慢站点可调 `600` |
