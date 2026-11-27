# TICKET-054：`browser_pick mode:"box"` —— 让人拉一个框，一次指出一组目标

**状态**：✅ 已实现并真机通过（2026-11-27，1.5.16）· 阶段 B4（人机协作动词）
**发现**：2026-11-27（TICKET-053 点选指路之后）
**关联**：TICKET-053（`browser_pick`）、TICKET-045（`loc` 稳定地址）、SPEC-004 §4 B4、`docs/cases/027`、`docs/cases/028`

## 1. 缺口

TICKET-053 解决了「**是哪一个**」，但只解决一次一个：

- 「把这十个复选框都勾上」要人点十次、agent 调十次 pick；
- 「读一下这张表里所有行」要先 snapshot，但虚拟列表/重复行往往读不全；
- 「这个区域里的所有按钮」在快照里散落在不同层级，agent 还得自己圈。

人已经在面板前，**拉一个框**是最自然的批量指认方式：框住哪片区域，就把那片区域里的可交互目标交给 agent。它补的是「**是一组**」而不是「是一个」。

## 2. 准入四问（SPEC-004 B1）

| 问题 | 回答 |
|---|---|
| 读还是写？ | **读**：框选只捕获 pointer 事件、画一个浮层，不派发输入、不改 DOM；框选结束后浮层移除。因此零审批、不新增 `actionClass`。 |
| 可逆吗？ | 是：框选只是「圈范围」；Esc / 面板取消按钮可随时中止，再试一次。页面在框选过程中与结束后都收不到点击。 |
| 失败能否确定「没执行」？ | 能：结果只有 `picked`（带元素列表）、`cancelled`、`timedOut` 三种正常回执；框太小/框内无元素时返回空列表 + `total:0`，仍算正常回执。 |
| 人机墙 / 接管时能否拦住？ | 与 `pick` 相同：`needs_human` 放行、`taken_over` 拒绝（`panel_taken_over`）。 |

## 3. 设计

### 3.1 页面侧（`plugin/inject/pick.js` 扩展，不新增文件）

`dshPick(input)` 的 `input` 增加两个字段：

- `mode: 'element' | 'box'`（默认 `element`，旧行为逐字不变）；
- `limit: number`（默认 20，夹 1–100，只对 box 生效）。

**box 模式**（复用现有的 `start` 安装/清理框架）：

- `pointerdown`（主键）：记录锚点 `(x0,y0)`，`preventDefault` + `stopImmediatePropagation`，进入拖拽态；不立即 finish。
- `pointermove`：把浮层画成 `min→max` 的矩形（最小宽高 4px 才视为有效框）；继续吞掉事件。
- `pointerup`：结束拖拽，按 12px 网格在框内采样 `elementFromPoint`，去重（同一个元素只出现一次），跳过 `html`/`body`/浮层自身与 `rendered()===false` 的节点；每个元素给出 `{loc, info, rect, point}`（point 取元素中心）。去重后总数记 `total`，列表按 `limit` 截断并给 `truncated`。
- `click` 兜底与 `swallowNextClick` 沿用 element 模式：框选结束后的那一下 click 也不进页面。
- Esc 取消、`stop` 幂等清理，与 element 模式一致。
- 框选结果形如：`{mode:'box', box:{x,y,width,height}, elements:[{loc,info,rect,point}], total, truncated, url}`。

**边界**：iframe 内元素只能框到宿主 `<iframe>`；跨域内容不可见；网格采样可能漏掉比 12px 更小的目标（文档写明）；canvas 只会返回 `<canvas>` 整体。

### 3.2 面板侧（`plugin/client.js`，`CLIENT_REV` 60 → 61）

- `Guest.pick(params, isCancelled)`：把 `mode`/`limit` 透传给页面；进入时按模式给不同提示（`Drag a box over the page (Esc, or the cancel button, to stop)`）。
- 回执映射：element 模式保持旧字段；box 模式返回 `{picked:true, mode:'box', box, elements, total, truncated, waitedMs}`。
- 取消按钮 / `cancelPick()` / 焦点处理无需改动（同一套状态机）。

### 3.3 桥（`plugin/bridge.js`）

无需改动：`pick` 已在 `READ_TYPES`，`#assert` 的 `taken_over` 特判对两种模式都成立。

### 3.4 宿主侧（`plugin/tools.js`，仍是第 16 个工具）

- `browser_pick` 参数增加 `mode: {enum:['element','box'], default:'element'}`、`limit: {integer, 1–100, default:20}`；描述补 box 用法与采样边界。
- 输出 schema 增加 `mode`、`box`、`elements[]`、`total`、`truncated`；element 模式字段保持可选。
- render：box 模式输出 `The person drew a box over N element(s)`，逐行 `* loc — role "name" (x, y wxh)`（最多 10 行），并提示 `browser_click { loc: … }`；空列表提示「框内没有可操作目标，重试或放大框」。
- `isConcurrencySafe:false` 不变；错误码仍 21。

## 4. 证据

- `pick.test.mjs` 页面侧：box 拖拽产生正确矩形与元素列表；去重；`limit` 截断 + `truncated`；框太小/空框返回空列表；Esc 取消并恢复选区；点击仍不进页面（6 例）。
- `pick.test.mjs` 工具侧：`mode:"box"` 请求参数与回执映射；`limit` 默认与夹取；render 列表与截断；空框提示；element 模式逐字不变（11 例）。
- 全量：360 → **386**（`pick.test.mjs` 15 → 26 例）；工具数不变（16），`check-docs` 六项全绿。
- 真机：`demo/box.html` 框选复选框区域 21 个目标（limit 10 截断）、框选三条「导出」列表 10 个目标，页面点击计数前后不变；用框选返回的 `css:[data-testid="row-export"]` 直接 `browser_click` 成功（计数恰好 +1）；element 模式对照不泄漏；超时返回正常回执。证据落 `docs/cases/028-box-select-cases.md`。

### 4.1 真机证据摘要（2026-11-27，1.5.16，`docs/cases/028`）

- B1：框住 10 个复选框 → `it holds 21 element(s)`，10 行候选 loc + `The box held more elements than the limit…`。
- B2：`browser_click { loc: 'css:[data-testid="row-export"]' }` → `Clicked button "导出" at (575, 278).`，页面计数 4→5（`最后一次： button「row-export」`）。
- B3：干净框选三条列表 → 10 个元素（容器/文本/按钮都有），框选前后页面计数均为 4，用户确认「没有变蓝」。
- B4/B5：element 模式对照、超时回执均正常，页面计数不变。

## 5. 不做

- 不新增工具（动词数保持 16，模式收进参数）；
- 不做框内文本提取/OCR（那是 snapshot / eval 的事）；
- 不做框选后批量执行（agent 自己逐个 click，保持每个动作可审计）；
- 不覆盖跨域 iframe 内部与 OS 级拖拽。
