# 案例 016：JS 弹窗拦截与记录（`dialogs.mode: record`）

- 夹具：`demo/dialogs.html`（alert / confirm / prompt / 提交前 confirm / 延迟 300ms 的 alert）
- 相关工单：[`docs/tickets/041-js-dialogs.md`](../tickets/041-js-dialogs.md)
- 规格：[`docs/spec/004-capability-admission-spec.md`](../spec/004-capability-admission-spec.md) §4 B2、§6 A2
- 日期：2026-11-26
- 环境：DSH Desktop 0.2.2-rc.5（Windows）、`dsh-plugin-agent-browser@1.5.3`、`CLIENT_REV=50`、注入守卫 `rev=3`、默认 `dialogs.mode: record`

## 1 结论

| 检查项 | 结果 | 证据 |
|---|---|---|
| 弹窗不再卡死渲染进程 | ✅ 三次点击都在 1 秒内返回 | 点击结果即时返回，页面脚本继续执行 |
| `alert` 被拦截 | ✅ 返回 `undefined`，页面日志继续往下写 | 页面日志「alert 返回 undefined，页面继续执行」 |
| `confirm` 被拦截 | ✅ 返回 `false`（保守答案，不替人同意） | 页面日志「confirm 返回了 false」 |
| `prompt` 被拦截 | ✅ 返回 `null` | 页面日志「prompt 返回了 null」 |
| 弹窗内容进入工具结果 | ✅ `blocked dialogs` 段落列出 `kind: message` | 见 §2.1–2.3 |
| 迟到的弹窗进入下一次操作结果 | ✅ 点击 300ms 后才弹的 alert 被下一次 `browser_snapshot` 带出 | 见 §2.4 |
| 页面没有被冻结（守卫探针持续刷新） | ✅ 探针每 500ms 刷新，`rev=3 mode=record driver=agent` | 见 §2.5 |
| `dialogs.mode: off` 真机对照 | ⚪ 未做（见 §3） | 需再次热重载配置；此前两次白屏都发生在插件重载后几十秒内，暂不在生产 profile 上复现 |

## 2 过程

### 2.1 alert

```
browser_open { path: "demo/dialogs.html" }        → http://127.0.0.1:11424/t/demo/dialogs.html
browser_click { ref: "e3" }                       → Clicked button "弹出 alert" at (72, 260).

blocked dialogs (answered conservatively; the page kept running):
- alert: 这是一条 alert：页面想告诉你一件事。
```

随后 `browser_snapshot` 里页面日志为：
`alert 返回 undefined，页面继续执行。 [mode=record guardRev=3 recorded=1]`

### 2.2 confirm

```
browser_click { ref: "e5" }  → Clicked button "弹出 confirm（记录返回了什么）" at (149, 379).

blocked dialogs (answered conservatively; the page kept running):
- confirm: 确实要执行这个操作吗？
```

页面日志：`confirm 返回了 false。`

### 2.3 prompt

```
browser_click { ref: "e7" }  → Clicked button "弹出 prompt（记录返回了什么）" at (148, 497).

blocked dialogs (answered conservatively; the page kept running):
- prompt: 请输入一个名字：
```

页面日志：`prompt 返回了 null。`

### 2.4 迟到的弹窗（点击已返回，300ms 后才弹）

```
browser_click { ref: "e12" }   → Clicked button "延迟 300ms 弹出 alert" at (113, 726).
（等待 1.2s）
browser_snapshot               → 结果末尾：
blocked dialogs (answered conservatively; the page kept running):
- alert: 这是一个迟到的 alert：点击已经返回之后才弹。
```

页面探针此刻为 `recorded=1`（客户端尚未读取），说明「记录在页面、由下一次命令取走」的路径成立。

### 2.5 页面未被冻结

页面内 `#probe` 每 500ms 刷新一次：

```
守卫探针：rev=3 mode=record driver=agent recorded=0（每 500ms 刷新）
```

三次弹窗、一次延迟弹窗之后仍在刷新，说明渲染进程没有被原生弹窗阻塞。

## 3 未验证与注意

- `dialogs.mode: off` 的真机对照没做：切 off 需要再次热重载插件（改 `cordis.patch.yml` 或重装），而 2026-11-25 的两次白屏都出现在插件重载后几十秒内（[`docs/tickets/040`](../tickets/040-blank-window-on-client-reload.md)）。当前只在单测里验证「off 调用原生函数且不记录」（`plugin/test/guards.test.mjs`），真机等 TICKET-040 有结论后再补。
- 注入发生在 `dom-ready` 之后：内联脚本在解析期弹出的窗抓不到（TICKET-041 U2）；`beforeunload` 未处理（R3）。
- `dialogs.mode: off` 时页面会被原生弹窗冻结，需要人在面板里点掉——这正是默认不选 off 的原因。
- 验收期发现并修掉的真问题：`Guest.readDialogs()` 原来把数组 `JSON.stringify` 后交给 `evaluate`，而 `evaluate` 会先把字符串 JSON 解码一次，于是二次 `JSON.parse` 失败并静默返回空列表（弹窗记录被清空却没进结果）。改成直接返回数组（`CLIENT_REV` 49→50）。这类问题单测覆盖不到（client 侧无 DOM harness），只有真机才暴露。

## 4 复跑方式

1. 安装 1.5.3 并在 profile 里保持默认 `dialogs.mode: record`。
2. `browser_open { path: "demo/dialogs.html" }` → 等 1s 看探针出现 `rev=3 mode=record`。
3. 依次 `browser_click` 三个按钮，确认结果里出现 `blocked dialogs` 且页面日志记录返回值。
4. 点「延迟 300ms 弹出 alert」，等 1s 再 `browser_snapshot`，确认迟到的 alert 出现在快照结果里。
