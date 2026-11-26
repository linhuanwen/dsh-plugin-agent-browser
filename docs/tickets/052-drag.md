# TICKET-052：`browser_drag` —— 把指针按住、移动、松开

**状态**：✅ 已实现并真机通过（2026-11-27，1.5.14）· 阶段 B4（交互动词）
**发现**：2026-11-27（阶段 B 第四个交互动词，TICKET-048 寻址滚动之后）
**关联**：SPEC-004 §4 B4、TICKET-048（定位/命中测试复用）、TICKET-039（动作分类与校验）、`docs/cases/026`

## 1. 缺口

`browser_click` 能点、`browser_hover` 能悬停、`browser_scroll` 能把元素滚进视口，但**「按住一个东西拖到另一个地方」**这一类交互没有动词：

- 音量/价格/进度类**滑块**，只有拖动把手才会改值；
- **可排序列表**（SortableJS、dnd-kit）、看板卡片，排序靠 drop 落点决定；
- **canvas 应用**（地图、白板、绘图工具）的手柄只能拖；
- 文件/元素的**拖放区**（把附件拖进上传框）。

用 `browser_click` 假装拖拽（点一下、再点一下）在滑块上会变成「点轨道跳值」，在排序列表上什么都不会发生，而且回执会诚实地说「点了」，模型只能猜。这个能力补上「按住—移动—松开」这个基本手势。

## 2. 准入四问（SPEC-004 B1）

| 问题 | 回答 |
|---|---|
| 读还是写？ | 写：拖拽会改页面状态（排序、提交滑块），且**无法**从 inspect 判断会不会提交/落库——所以新增 `actionClass: 'drag'`，首次触站必问（见 §3.4）。 |
| 可逆吗？ | 单次拖拽本身可逆（拖回去），但落点可能触发不可逆业务（提交排序、保存布局）；因此按写动作确认，`effect` 三态照常（`committed` / `unknown`）。 |
| 失败能否确定「没执行」？ | 能：地址解析、命中测试、越界都在**派发第一个事件之前**失败 → `not_found` / `multiple` / `occluded` / `disabled` / `out_of_view`，`effect: none`。一旦开始派发事件，超时/接管按 `action_unknown` 处理（`plugin/bridge.js` `WRITE_TYPES` 已含 `drag`）。 |
| 人机墙 / 接管时能否拦住？ | 能：`drag` 进 `INPUT_TYPES`，`taken_over` 报 `panel_taken_over`、`needs_human` 报 `needs_human`；`snapshot`/`inspect`/`wait`/`tabs` 读动作不受影响。 |

## 3. 设计

### 3.1 页面侧（`plugin/inject/actions.js`，新 op `drag`）

- **源**：`ref` / `loc` / `selector` 三选一，复用既有解析与「滚进视口 + 等布局稳定」`settleThen`；源元素 0 尺寸 → `out_of_view`、禁用 → `disabled`、非 iframe 时 `pickPoint` 命中测试 → `occluded`（与 click 同一套规则，被盖住的把手人也拖不到）。
- **落点（`to`，五选一）**：
  - `toLoc` / `toSelector` / `toRef`：解析到元素后取矩形中心（iframe 内加 host 偏移）；
  - `toX` + `toY`：视口 CSS 像素坐标（canvas 手柄、没有 DOM 的落点）；
  - `dx` / `dy`：相对源中心的位移（滑块「向右 80px」不需要知道绝对坐标）。
- **事件序列**（`dragSequence`）：`pointerover` → `pointerdown`(buttons=1) → 每一步 `await frameWait()` 后 `pointermove`(buttons=1) → `pointerup`（`mouseover`/`mousedown`/`mousemove`/`mouseup` 同步派发，两种事件族都送到「光标下元素」而非源元素）。`steps` 2–30，默认 8；`elementFromPoint` 在中间空隙返回 null 时回退到源元素（不丢事件）。
- **为什么用页面侧合成事件，而不是宿主 `sendInputEvent`**：Electron 合成的「按下 + 移动」不保证触发原生拖拽（Chromium 的 drag 循环需要 OA 层输入），而页面侧序列对 React DnD、dnd-kit、SortableJS、slider、canvas 处理器都有效，且可以单测。代价见 §5。
- **落点校验**：坐标落点同样检查 `0 ≤ x ≤ innerWidth`、`0 ≤ y ≤ innerHeight`；元素落点 0 尺寸 → `out_of_view`（带 `target: true`）。所有失败都发生在派发前，`effect: none`。

### 3.2 面板侧（`plugin/client.js`，`CLIENT_REV` 57 → 58）

- `Guest.drag(params)`：把 `from`/`to` 参数交给 `act('drag', …)`，返回 `{ from, to, info, target, matched, steps }`；
- `runCommand` 增加 `drag` 分支；`DIALOG_TYPES` 加入 `drag`（拖拽触发的原生确认框照常记录）；
- 拖拽不经过原生输入管线，因此不需要 `sendInputEvent`、不改变缩放/焦点约定。

### 3.3 桥（`plugin/bridge.js`）

- `INPUT_TYPES` 加 `drag`（人工相位拒绝）；
- `WRITE_TYPES` 加 `drag`（超时/取消/接管/面板关闭 → `action_unknown`，提示「先看页面，不要重发」）；
- `READ_TYPES` 不变。

### 3.4 宿主侧（`plugin/tools.js` + `plugin/approvals.js`）

- 新工具 `browser_drag`（第 15 个）：`from`（`{ref|loc|selector}`）、`to`（三种落点之一）、`steps`；`isConcurrencySafe: false`（拖动会改布局，下一步动作必须等它结束）；
- 审批新增第六类 `actionClass: 'drag'`：`confirmBefore` 对 `type === 'drag'` 先 inspect 源元素（地址不可解析时直接交给动作报 `stale_loc`/`bad_loc`，不弹条），然后 `confirmWrite({ actionClass: 'drag', origin, target })`；`summarize` 文案「在 example.com 拖拽「音量滑块」」；
- `actionFailure(result, 'drag')` 为 `out_of_view` / `not_found` / `occluded` / `disabled` 提供 drag 专属文案（都强调「Nothing was dragged」）。

**错误码**：不新增（仍 21 个）。

## 4. 证据

| 类型 | 证据 |
|---|---|
| 单测 | `plugin/test/actions.test.mjs` 37 → **45** 例（loc→loc 事件序列与步数、ref→selector、dx/dy 相对落点、toX/toY 绝对落点、steps 夹取 2–30、目标越界、源 disabled、源 occluded、目标 0 尺寸）；`plugin/test/drag.test.mjs` **7** 例（参数映射、toX/toY 与 dx/dy 转发、render、5 类非法入参零请求、页面 `occluded`/`out_of_view` 文案）；approvals 六类断言、tooldefs/toolviews/wait 计数 14→15 → 全量 345 → **360** |
| 门禁 | `node tools/check-docs.mjs` 六项全绿（工具 **15**、配置 21、YAML 13、decisions 10、B11、file:line 12） |
| 真机 | `docs/cases/026`：`demo/drag.html` 上 loc→loc 拖进轨道、`ref` + `toX/toY`、`dx/dy` 三种落点都触发页面自己的 pointer 处理器（「已放进轨道 / 次数」更新）；写动作确认条与站点授权；越界与 stale loc 的失败文案 |
| 文档 | 本 ticket + `docs/cases/026` + 两份 README（第 15 个工具、动作类六类）+ release notes 1.5.14 |

### 4.1 真机证据（1.5.14，`demo/drag.html`）

- `browser_drag {from:{loc:"css:#handle"}, to:{loc:"css:#lane"}, steps:6}` → `Dragged button "拖拽把手" from (107, 289) to (409, 291).` / `Released over div "放置轨道".`，页面状态更新为「已放进轨道 (409, 291)」、次数 +1；
- `browser_drag {from:{loc:"css:#handle"}, to:{dx:260, dy:10}, steps:4}` → `Dragged button "拖拽把手" from (107, 289) to (367, 299).`；
- `browser_drag {from:{ref:"e2"}, to:{toX:409, toY:291}, steps:5}` → `Dragged button "拖拽把手" from (107, 289) to (409, 291).`；
- 写动作确认：第一次拖拽弹出确认条（用户选择允许），随后本会话本站授权生效；另一次拖拽在 30 秒内未确认 → `approval_timeout: 用户 30000ms 内没有确认在 127.0.0.1 拖拽「拖拽把手」。... Nothing was sent to the page.`（确认条覆盖 drag）；
- 失败路径：`toX:2000` → 「the drop target is outside the viewport … Nothing was dragged.」；`to:{loc:"css:#nope"}` → `stale_loc`；`from:{loc:"css:#nope"}` → `stale_loc` 且因为地址本身解析失败**不弹确认条**。

## 5. 已知边界 / 不做

- **不覆盖原生 HTML5 drag-and-drop**（`draggable="true"` + `dragstart`/`dragover`/`drop`）：默认行为在 Chromium 内部由 OA 层接管，页面侧合成事件换不来真正的 drag 会话。遇到这类页面用 `browser_snapshot` + 坐标点击绕开，或等后续用 host 原生输入专门做一版。
- 不做 OS 级文件拖拽（把桌面文件拖进页面）；上传走 `browser_upload`。
- `from` 只接受页面元素地址，不支持从坐标开始（没有元素就没有「按住谁」）。
- 不做多点触控/双指、不做路径曲线（贝塞尔/多段），`steps` 的线性插值覆盖 v1 的手势需求。
- 不做拖拽中截图/时间轴；需要观察中间态时先 `browser_hover` 或用 `browser_screenshot` 抓一次。
- 隐藏的 iframe 内目标、跨域 iframe 的落点坐标由既有 frame 偏移规则处理；跨域 iframe 的指针事件从组合根开始不可达，按已知限制记录。
