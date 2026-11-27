# TICKET-053：`browser_pick` —— 让人在页面上点一下，把目标交给 agent

**状态**：✅ 已实现并真机通过（2026-11-27，1.5.15）· 阶段 B4（人机协作动词）
**发现**：2026-11-27（阶段 B 第五个交互动词，TICKET-052 拖拽之后）
**关联**：SPEC-003（写动作确认，本能力不触发）、SPEC-004 §4 B4、TICKET-045（`loc` 稳定地址）、TICKET-039（动作分类）、`docs/cases/027`

## 1. 缺口

agent 要在页面上「操作那个东西」时，首先得知道**是哪一个**。现在有三条路，各有硬伤：

- `browser_snapshot` 给 `ref`/`loc`，但一串只有图标的按钮、列表里十个长得一样的「删除」、canvas 里画出来的控件，快照里读出来全是 `button ""` / `div`，agent 只能猜；
- `browser_inspect` 要 agent 先给出地址，**指不出来的时候用不上**；
- 靠坐标（`x`/`y`）猜，页面一滚动/重排就错。

而**人就坐在面板前面**。让他/她在页面上点一下目标，比让模型读三遍快照更快、更准。这个能力把「人的一次点击」变成结构化的引用（`loc` + 可读名 + 矩形 + 坐标），agent 随后用 `browser_click {loc}` 等既有动词操作。

## 2. 准入四问（SPEC-004 B1）

| 问题 | 回答 |
|---|---|
| 读还是写？ | 读：面板进入点选模式，**捕获**（preventDefault + stopImmediatePropagation）这一次点击，页面收不到；不派发任何输入、不改 DOM（只加一个高亮浮层，结束时移除）。因此**不需要确认条**，也不新增 `actionClass`。 |
| 可逆吗？ | 是：点选只是「指哪」；不满意可以 Esc 取消、再点一次。被选中的元素不会因为点选而获得焦点/被点击（页面不知道发生过这次点击）。 |
| 失败能否确定「没执行」？ | 能：结果只有 `picked` / `cancelled`（Esc 或接管）/ `timedOut` 三种，都是正常回执、不是错误；页面状态未变。 |
| 人机墙 / 接管时能否拦住？ | `needs_human` 下**放行**（人本来就在处理页面，让他指认验证墙上的元素是合理的）；`taken_over` 下**拒绝**（面板已归人所有，再让人替 agent 点东西是自相矛盾）——`#assert` 特判 `pick`。 |

## 3. 设计

### 3.1 页面侧（新 `plugin/inject/pick.js`，单函数表达式 `dshPick(input)`）

与 `inject/wait.js` 同一注入方式：面板按 `(<source>)(input)` 调用，状态挂在 `window.__dshPick` 上，**不依赖闭包跨调用存活**。

- **三个 action**，面板轮询驱动：
  - `start`：安装捕获监听（`pointermove` 高亮、`pointerdown` 选中、`click` 兜底、`keydown` Esc）+ 一个 `position:fixed;pointer-events:none` 高亮框（描边 + 半透明底）；光标改成 crosshair；返回 `{ok:true, installed:true}`；重复 start 幂等。
  - `poll`：返回 `{ok:true, picked:null|candidate, cancelled:boolean, hover:{x,y}|null}`；`picked` 出现后监听器已移除，但状态保留到 `stop`。
  - `stop`：移除浮层/监听、删除 `window.__dshPick`，返回 `{ok:true}`；幂等。
- **选中内容**：`{loc, info:{tag,role,name}, rect:{x,y,width,height}, point:{x,y}, url}`。`loc` 用与快照同一套 CSS 路径算法（最近锚点 `#id` / `[data-testid]` / `tag[name]` → `nth-of-type` 路径，`querySelector` 自校验，>120 字丢弃），因此选完可直接 `browser_click {loc:"css:…"}`；拿不到唯一 loc 时 `loc:''`，仍给 `point` 坐标兜底。
- **事件隔离**：捕获阶段 `preventDefault()` + `stopImmediatePropagation()`；只认主键（`button === 0`）；iframe 内元素无法从父文档拿到（点到的会是 `<iframe>` 宿主元素，`loc` 指向 iframe 本身——记录为边界）。
- 页面冻结/异常时一律 try/catch，不影响页面行为。

### 3.2 面板侧（`plugin/client.js`，`CLIENT_REV` 59 → 60）

- `Guest.pick(params, isCancelled)`：`evaluate` 注入 source 后 `start`，每 150ms `poll`；命中/取消/超时都 `stop` 清理；`isCancelled` 在两次轮询之间检查（取消帧、**用户接管**（`state.phase !== 'agent'`）都会中止并清理，浮层不留在页面上）。
- 进入点选时 `setState({ note: 'Point at an element in the page (Esc, or the cancel button, to stop)', picking: true })`，结束后恢复 `{ note: 'Ready', picking: false }`。**焦点交给页面**（`this.element?.focus?.()`），否则页面收不到 Esc。
- 新增 `Guest.cancelPick()`：把 `window.__dshPick.cancelled = true`，下一次 poll 走取消路径；面板在 `view.picking === true` 时显示「取消点选」按钮（缩放控件左侧），这是焦点不在页面时唯一可靠的取消方式。
- `runCommand` 增加 `pick` 分支；`pick` 不需要 `DIALOG_TYPES`。

### 3.3 桥（`plugin/bridge.js`）

- `READ_TYPES` 加 `pick`（不抢相位、人工相位放行）；
- `#assert` 特判：`type === 'pick' && phase === 'taken_over'` → `panel_taken_over`（文案说明：用户正拿着面板，请先等交还）；
- 错误码不新增（仍 21 个）：超时/取消都是正常结果。

### 3.4 宿主侧（`plugin/tools.js`）

- 新工具 `browser_pick`（第 16 个）：参数 `timeoutMs`（默认 60000，夹 3000–120000，给人找元素的时间）；`isConcurrencySafe: false`（点选期间别的动作必须等）。
- 回执：`{picked, loc?, info?, rect?, point?, url?}`，未选中时 `{picked:false, timedOut:true}` 或 `{picked:false, cancelled:true}`；render 把 `role/name/loc` 拼成一句，并提示下一步用 `browser_click {loc}` 或 `browser_inspect`。
- 工具描述强调：**页面收不到这次点击**——点选只回答「是哪一个」，要真的点下去还得再调 `browser_click`。

## 4. 证据（计划）

| 类型 | 证据 |
|---|---|
| 单测 | `plugin/test/pick.test.mjs` **15 例**：页面侧（start 装浮层与监听、pointermove 高亮、pointerdown 吞掉点击并算 loc/info/rect、pointerdown 后的 click 不进页面、无 pointerdown 的合成 click 也被吞、Esc 取消清理、stop 幂等、重复 start 幂等）；工具侧（参数校验与零请求、超时/取消是正常回执、picked 映射与 render、`loc:""` 时用 point、`createTools` 注册 16 个）。`tooldefs`/`toolviews`/`wait` 计数 15→16 → 全量 360 → **375** |
| 门禁 | `node tools/check-docs.mjs` 六项全绿（工具 **16**、配置 21、YAML 13、decisions 10、B11、file:line 12） |
| 真机 | `docs/cases/027`（P1–P10）：图标按钮 pick→`css:#icon-btn`→`browser_click` 真点到（页面计数 pick 0 次 + click 1 次）；重复行回退 `nth-of-type` 路径并可点；canvas 点到整块画板；3s 超时正常回执；点选后页面计数为 0（点击不泄漏）；面板「取消点选」→ cancelled；`taken_over` 拒绝、交还后恢复；最终包端到端复验 |
| 文档 | 本 ticket + `docs/cases/027` + 两份 README（第 16 个工具）+ release notes 1.5.15 |

## 5. 已知边界 / 不做

- **页面收不到这次点击**（这是设计，不是缺陷）：点选回答「是哪一个」，要真的触发页面行为请随后 `browser_click`/`browser_type`。
- 跨域 iframe 内部元素不可达：点到的是 `<iframe>` 宿主元素，`loc` 指向 iframe；iframe 内元素用 `f1:` frame 地址或快照的 ref（跨域仍不可达，记录为边界）。
- 没有唯一 CSS 路径的深层匿名节点会得到 `loc:''`，此时用回执里的 `point` 坐标点击（页面滚动/重排后坐标会失效，建议立即用）。
- 不做多选/框选、不做「点选后直接执行动作」、不做拖拽起点点选（拖拽有 `browser_drag`，`from` 仍用地址）。
- 点选模式下页面其他交互被拦截（这是点选的本义）；Esc（需页面有键盘焦点）或面板「取消点选」或超时立即恢复。
- 不做跨页面点选（页面一导航就取消，由面板轮询检测 URL 变化实现）。
