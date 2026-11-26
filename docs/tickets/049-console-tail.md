# TICKET-049：把页面自己的 console 尾巴带进快照

**状态**：✅ 已完成（2026-11-27，1.5.10；单测 327/327、check-docs 全绿、真机通过）· 阶段 B2（观察增强）
**发现**：2026-11-27（阶段 B 观察增强第一个能力）
**关联**：SPEC-004 §4 B2/B3、SPEC-003 C2（提交类判定）、TICKET-041（guards 注入）、TICKET-046（快照 cursor）、`docs/cases/023`

## 1. 缺口

agent 点了一个按钮、填了一个表单，页面没反应时，它只能看到「DOM 没变」——但页面在 console 里可能已经说了原因：

- `console.error('接口 401')`
- `Uncaught TypeError: undefined is not a function`
- `Unhandled rejection: timeout`

这些信息此前对 agent 完全不可见：它只能用 `browser_eval` 去读（写动作、要审批）、或者猜。人在旁边看一眼 devtools 就知道了，agent 看不到。

## 2. 准入四问（SPEC-004 B1）

| 问题 | 回答 |
|---|---|
| 读还是写？ | 纯读：只旁听页面已有的日志，不产生新的页面动作，不新增 `actionClass`。 |
| 可逆吗？ | 不适用（没有副作用）。 |
| 失败能否确定「没执行」？ | 能：不经过审批与动作路径，失败就是「没读到」，`effect` 不适用。 |
| 人机墙 / 接管时能否拦住？ | 不涉及——它挂在 `browser_snapshot` 上，而 `snapshot` 本来就是 `READ_TYPES`，人工相位下仍可用。 |

## 3. 设计

### 3.1 页面侧（`plugin/inject/guards.js`，rev 3 → 4）

在已有的 guards 注入里增加 `installConsole()`：

- 包装 `console.log/info/warn/error/debug`：记录 `{level, text}` 后**调用原函数**（页面自己的 log 行为不变）；
- 监听 `window.addEventListener('error')` → `level: 'pageerror'`，带 `message (file:line)`；
- 监听 `window.addEventListener('unhandledrejection')` → `level: 'unhandled'`；
- 环形缓冲 `window.__dshConsole` 上限 40 条，每条文本截 240 字（页面可以无限制打日志，模型按字符付费）；
- 页面把 `window.__dshConsole` 换成非数组（冻结/覆盖）时，下一次记录会重建数组，页面不受影响。

### 3.2 面板侧（`plugin/client.js`，`CLIENT_REV` 54 → 55）

`Guest.readConsole()`：`evaluate` 读出并清空 `window.__dshConsole`（只取最后 20 条），返回 `[{level, text}]`。`runCommand` 的 `snapshot` 分支在结果上附 `console`（非空时）。

**每次快照清空**：同一条日志不会在后续快照里重复占上下文；代价是两次快照之间的日志如果不足一次快照就丢失——与「快照是当前视图」的粒度一致。

### 3.3 宿主侧（`plugin/tools.js`）

- `browser_snapshot` 的 output schema 增加 `console: [{level, text}]`；
- render 末尾附 `page console (N entries):` + 最后 10 条 `- [level] text`，被隐藏的条数明确写出（`… N earlier entries not shown`）；
- snapshot 描述里说明这条尾巴的存在与「每次快照清空」。

### 3.4 验收期修掉的一个分类缺陷

真机第一次点击夹具按钮时弹了确认条：`isSubmitControl()` 把**任何无 `type` 的 `<button>`** 都当成提交类（HTML 默认 type 是 submit）。但按钮只有在**有 form owner** 时才真的能提交；表单外的无 type 按钮被点击只是一次点击。SPEC-003 C2 的原文就是「form 内无 type button」。修法：`element.form !== null && element.form !== undefined` 才判提交类；`type="submit"` 仍始终算提交。新增 `actions.test.mjs` 一例（表单外无 type → 读；表单内无 type → 写；显式 submit → 写）。

## 4. 证据

| 类型 | 证据 |
|---|---|
| 单测 | guards 12 → 16 例（记录、截断/上限、error/unhandled、缓冲被替换后重建）；`plugin/test/console.test.mjs` 4 例（映射、无日志时逐字不变、render 只留 10 条并报隐藏数、畸形条目丢弃）；`actions.test.mjs` 1 例（表单所有者判定）→ 全量 318 → **327** |
| 真机 | `docs/cases/023`：`demo/console.html` 上点 log/error/throw/reject 后，下一次快照末尾依次出现 `[log]`、`[error]`、`[pageerror]`、`[unhandled]`；再下一次快照不再重复（已清空）；普通按钮点击不再弹确认条 |
| 错误码 | 无新增（仍 19 个）；`effect` 不适用（读） |
| 文档 | 本 ticket + `docs/cases/023` + 两份 README 的 `browser_snapshot` 行 + release notes 1.5.10 |

## 5. 不做

- 不做 `browser_console` 新工具：观察结果挂在快照上，避免第 14 个工具与每轮 schema 成本。
- 不做网络观测（fetch/XHR/PerformanceObserver）：另一个独立能力，单独评估。
- 不做 console 级别过滤/搜索参数：v1 只给尾巴，需要更细时再加。
- 不记录 dom-ready 之前（内联脚本解析期）的日志：guards 注入时机即此。
