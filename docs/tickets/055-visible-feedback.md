# TICKET-055：页面内可见反馈 —— 让 agent 的动作在你眼前留下痕迹

**状态**：✅ 已实现并真机通过（2026-11-27，1.5.22；1.5.17–1.5.21 为内部构建）· 阶段 B2（可核对）
**发现**：2026-11-27（TICKET-054 框选之后，产品线候选 ①「页面内可见反馈」）
**关联**：TICKET-049（console 尾巴）、TICKET-051（network 尾巴）、SPEC-004 §4「可核对」、`docs/cases/029`

## 1. 缺口

面板里的浏览器是**真的**、**看得见**的，但 agent 的动作发生在页面内部，人看到的只是：

- 页面自己变了（按钮被点、列表滚动），**但从哪一点点的、点了哪个元素，看不见**；
- 拖拽更像魔法：结果出现时，人不知道起点终点在哪；
- 截图是静态的：两次快照之间发生了什么，只能靠页面状态反推；
- 想让人「看着它做一遍」时，没有可指认的痕迹。

目标是：**agent 每次点/悬停/滚动/拖拽后，在页面上留一个短暂的光标点、涟漪、元素高亮或连线**——只画在覆盖层里，页面完全收不到事件、布局不变。它是「可核对」的基础设施，也为 TICKET-056（动作时间线）提供页内视觉锚点。

## 2. 准入四问（SPEC-004 B1）

| 问题 | 回答 |
|---|---|
| 读还是写？ | 纯**呈现**：只在 `position:fixed` 覆盖层里画点/框/线，`pointer-events:none`，不派发输入、不改页面 DOM 与布局。不需要审批、不新增 `actionClass`。 |
| 可逆吗？ | 是：每笔痕迹按 `durationMs` 自动消失，切页即随文档卸载；失败静默、不影响原动作。 |
| 失败能否确定「没执行」？ | 能：反馈是动作成功/失败回执的**附属品**，画不出来只是没画；原动作的结果（`effect` 等）不受影响。 |
| 人机墙 / 接管时能否拦住？ | 反馈只跟随 agent 的动作回执，而动作本身已受人工相位约束（`needs_human` / `taken_over` 会拒绝），因此不需要新相位规则。 |

## 3. 设计

### 3.1 页面侧（新 `plugin/inject/feedback.js`）

单函数 `dshFeedback(input)`，action：`cursor` / `click` / `highlight` / `drag` / `clear`。

- 覆盖层：`#__dsh-feedback`，`position:fixed; inset:0; pointer-events:none; z-index:2147483645`；首次使用时创建，`clear` 或全部痕迹消失后移除。**不挂任何事件监听**、不做轮询，纯被动绘制。
- `cursor`：`{x,y}` 处画 12px 圆环（白底、蓝边、阴影），代表「光标在这里」。
- `click`：`{x,y}` 处画实心蓝点 + 向外扩散的圆环（CSS transition 放大并淡出），默认 900ms 后移除。
- `highlight`：`{rect:{x,y,width,height}}` 画矩形描边 + 10% 蓝底，用于滚动落点 / 类型输入的目标。
- `drag`：`{from:{x,y}, to:{x,y}}` 画起点圆点、终点圆点与两点连线（细线 + 半透明），代表拖拽路径。
- `durationMs`：默认 900，夹 100–5000；每笔痕迹独立计时移除。
- 护栏：层内节点上限 24，超出先清最早；`input` 不合法时安全返回 `{ok:false}`；整体 try/catch，绝不把错误抛回面板。

### 3.2 面板侧（`plugin/client.js`，`CLIENT_REV` 61 → 64；含「设置」页「可见反馈」组）

- 新增 `feedbackSource()`：`callHost('/source?name=feedback')` 取源码并缓存（同 guards 的取法）。
- 新增 `Guest.beacon(mark)`：`feedback.enabled === false` 时直接返回；否则 fire-and-forget `this.evaluate(`(${source})(${JSON.stringify(mark)})`)`，失败只 `report`。
- `runCommand` 各分支成功后按回执字段触发：
  - `click` → `{kind:'click', x:result.point.x, y:result.point.y}`；
  - `hover` → `{kind:'cursor', ...result.point}`；
  - `scroll`（寻址滚动，有 `rect`）→ `{kind:'highlight', rect:result.rect}`；
  - `drag` → `{kind:'drag', from:result.from, to:result.to}`；
  - `type` / `press`（回执带 `rect` 时）→ `{kind:'highlight', rect}`。
- 配置读取：面板挂载时 `GET /config` 一次（与 `dialogs.mode` 同处），取 `feedback.enabled` 与 `feedback.durationMs`；读不到时默认开启、900ms。

### 3.3 配置（`plugin/config.js` / `plugin/index.js` / `plugin/apply.js`）

新增组：

```yaml
feedback:
  enabled: true
  durationMs: 900
```

- `CONFIG_FIELDS.feedback = 'restart'`（面板挂载时读一次，改动后重建面板生效）；
- `snapshotConfig` 输出 `feedback: { enabled, durationMs }`；
- 配置叶子 21 → **23**，YAML 顶层 13 → **14**；两份 README 的配置示例与说明同步。

### 3.4 工具、桥、错误码

均无改动：工具数仍 16、错误码仍 21；反馈不产生新的结果字段（不进工具回执，避免上下文税）。

## 4. 证据

- 新增 `plugin/test/feedback.test.mjs`（7 例）：cursor 位置、click 圆点+扩散环、highlight 矩形、drag 双点+连线、计时器到点清空并移除覆盖层、40 次绘制被 24 上限截断且非法输入安全返回、`clear` 删除覆盖层、`feedbackSource()` 可读出源码。
- `plugin/test/config.test.mjs`：`feedback` 组默认值 `{enabled:true,durationMs:900}`、关闭、5000、6000→5000、10→100、以及三项非法值（2 例 + 错误表 3 行）。
- 全量：386 → **394**；`check-docs` **七项**全绿（配置 23、工具 16、YAML 14、decisions 10、B11、file:line 12、**打包清单：7 个 inject 脚本都已列入 COPY**）。
- 真机：E1–E11 全部通过，证据与回执原文见 `docs/cases/029-visible-feedback-cases.md`；验收期修掉五个问题（见 §4.1）。

### 4.1 真机证据与验收期修掉的问题

真机（1.5.22，右侧栏面板；夹具 `demo/console.html`、`approval-form.html`、`long.html`、`drag.html`）：

| 场景 | 回执 / 结果 | 截图 |
|---|---|---|
| click | `Clicked button "console.error 一条" at (366, 164).` → 蓝点落在按钮上 | `screenshots/ticket055-1521-mark-fast.png` |
| hover | `Hovered button "console.warn 一条" at (223, 164).` → 空心圆环停在指针处 | `screenshots/ticket055-1521-hover-mark.png` |
| scroll | `Scrolled button "追加 10 行" into view at (24, 203) 78×25 — fully in view.` → 元素蓝框 | `screenshots/ticket055-1521-scroll-mark.png` |
| type | `Typed 4 characters into textbox "普通文本框".` → 输入框高亮框 + 蓝底 | `screenshots/ticket055-1521-type-mark2.png` |
| drag | `Dragged button "拖拽把手" from (107, 289) to (409, 291).` → 连线 + 两端圆点 | `screenshots/ticket055-1521-drag-mark.png` |
| 配置生效 | 页面诊断日志 `{"step":"config","enabled":true,"durationMs":5000}`、`{"step":"source","length":10197}`、`{"step":"drawn","answer":{"ok":true,"kind":"click"}}` | — |
| 1.5.22 复验 | `browser_click {loc:"css:#log-one"}` → 蓝点落在「console.log 一条」 | `screenshots/ticket055-1522-click-mark.png` |
| 关闭开关 | 单测覆盖（真机切换需改 profile + 重启 DSH），列为已知边界 | — |

验收期修掉的问题（按发现顺序）：

1. **点映射错**：`beaconFor` 只认 `answer.point`，而 `click`/`hover` 回执是 `x`/`y` → 痕迹从不触发。修：两种形状都接受（1.5.18）。
2. **type 无 rect**：`actions.js` 的 type 分支不带元素矩形。修：回执补 `rect`，面板侧透传（1.5.18）。
3. **`inject/feedback.js` 漏打包**：`tools/pack.mjs` COPY 显式清单漏文件 → 装机包缺文件 → 宿主 `/source?name=feedback` 500 → 面板缓存空串、静默不画（诊断日志 `step:"source", length:0`）。修：COPY 补文件 + `check-docs` 新增第 7 项「inject 脚本 ↔ COPY 清单」双向比对（1.5.21）。
4. **客户端 bundle 缓存**：版本变化不保证面板刷新，旧 bundle 会继续跑。规避：装新版本后行为没变就完整重启 DSH（写进案例与发布说明）。
5. **截图时延**：模型往返常超过痕迹窗口。验收方法：动作与截图发在同一条消息里；需要放宽时把 `feedback.durationMs` 调到 5000 上限。

## 5. 不做

- 不做常驻鼠标指针跟随（只在动作回执后画一笔）；
- 不做「关闭开关」的真机验收（需改 profile 配置 + 重启 DSH，单测覆盖行为分支，案例里写明）；
- 不做动画/性能调优（CSS transition + setTimeout 足够）；
- 不让页面收到任何事件、不读页面内容（纯绘制）；
- 不做跨 iframe 的反馈坐标换算（主文档坐标；iframe 内的动作按宿主坐标画）；
- 反馈不进工具回执（不增加上下文税）。
