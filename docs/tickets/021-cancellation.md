# TICKET-021 取消：把 `exec.signal` 一路传到面板

- **状态**：✅ 已完成（2026-11-21，版本 1.2.4）
- **优先级**：P1（与 TICKET-020 同一处边界；用户取消后仍继续动页面是"会咬人"的行为）
- **来源**：`docs/design/official-docs-review.md` #10（官方 `develop/basic/tool`：长任务必须尊重 `exec.signal`）
- **对应验收**：`docs/spec/002-official-alignment-spec.md` B6
- **关联**：TICKET-017（关闭时的排空）、TICKET-020（`cancelled` 错误码）

## 1. 问题

全仓只有 `plugin/tools.js:351` 一处读过 `exec.signal`（`browser_open` 的导航等待）。其余 10 个工具的调用**完全不可取消**：

1. 用户按 Esc / 关掉会话后，`browser_snapshot` 仍在面板里跑，跑完把一坨结果投回一个没人要的会话。
2. `bridge.request` 只有固定超时（`BRIDGE_TIMEOUT` 20 s），取消与超时在代码里是同一条路径——超时错误会误导成"面板没响应"。
3. **最要命的一条**：命令一旦出队给面板就必须执行。`browser_click` 已投递、模型已放弃这个任务，点击仍会落下——在一个用户正在填表的已登录页面上，这不是"多做了点事"，是"替用户按了按钮"。
4. 取消后队列里残留的旧命令会在下一次轮询被投递（`bridge.js` 的 `#drain` 一次取走全部），形成"迟到的点击"。

## 2. 修法

### 2.1 信号怎么合

```js
const { signal } = exec                       // ToolRunContext
const timeout = AbortSignal.timeout(policy.limits.requestTimeoutMs)
const combined = AbortSignal.any ? AbortSignal.any([signal, timeout]) : mergeSignals(signal, timeout)
await gate.request(sessionId, 'click', params, { signal: combined })
```

`AbortSignal.any` 在 Node ≥ 20.3 可用（Electron 0.2.2-rc.3 的 Node 版本要实测）；没有就手写 6 行 polyfill（`addEventListener('abort')` + 去掉定时器）。

### 2.2 桥侧

`plugin/bridge.js` 的 pending 表从 `resolve` 改成 `{ resolve, reject, timer, onAbort }`：

```js
request(sessionId, type, params, { signal, timeoutMs }) {
  const id = nextId()
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: setTimeout(() => this.#settle(id, 'timeout'), timeoutMs) }
    if (signal) {
      entry.onAbort = () => this.#abort(id)
      if (signal.aborted) return entry.onAbort()
      signal.addEventListener('abort', entry.onAbort, { once: true })
    }
    this.#pending.set(id, entry)
    this.#queue(sessionId).push({ id, type, params })   // 只在未被 abort 时入队
    this.#wake()
  })
}

#abort(id) {
  const entry = this.#pending.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  this.#pending.delete(id)
  this.#dropQueued(id)                                     // 关键：从会话队列里摘掉，避免"迟到的点击"
  this.#enqueue({ type: 'cancel', id })                    // 告知面板：若还在跑就停下
  entry.reject(new AgentBrowserError('cancelled', '调用已取消', { retryable: false }))
}
```

`#settle` 也要清掉 `onAbort` 监听（防泄漏）。

### 2.3 面板侧

`plugin/client.js` 收到 `{type:'cancel', id}` 时：若当前动作可行（导航中）就 `webview.stop()`；对不可撤销的（已发出的 click）只丢弃结果、不再回包。**不假装能撤销**——文档写明"取消只保证：不再投递、不再回包、结果不采用"。

### 2.4 超时与关闭的区分

三种终止原因用三个 code：`cancelled`（调用方取消）、`bridge_timeout`（超时）、`bridge_closed`（卸载中）。现在它们都变成一句 "timeout"，需要拆开。

## 3. 单测

扩展 `plugin/test/bridge.test.mjs`（或新增 `cancel.test.mjs`）：

| # | 用例 |
|---|---|
| 1 | 已 abort 的 signal 传入 → 立即 reject `cancelled`，且**没有**命令被入队 |
| 2 | 入队后 abort → 队列被摘空、`cancel` 帧进队（用假面板取一次 drain 断言） |
| 3 | abort 后把队列交给假面板再回包 → 无 unhandled rejection、结果被丢弃 |
| 4 | 超时 → `bridge_timeout`；卸载中 → `bridge_closed`；三码互不混用 |
| 5 | 连续 100 次 request+abort → `#pending` 大小为 0、无监听泄漏（`process.listenerCount` 断言） |
| 6 | 工具层：`exec.signal` 已 abort 时 `browser_snapshot` 不去碰桥（用假 bridge 断言零调用） |

## 4. 装机验收

| 项 | 做法 | 期望 |
|---|---|---|
| 取消真的停 | 对一个大页面调 `browser_snapshot`，1 s 内取消 | 结果在 ~100 ms 内返回 `cancelled`；面板不再回吐该 id |
| 不迟到 | 取消一个排在慢导航后面的 `browser_click` | 点击**没有**发生（页面无变化） |
| 停止不误伤 | 取消 A 而不影响同会话后续的 B | B 正常执行；A 的 id 不会出现在后续 drain 里 |
| 关插件时干净 | 有 3 个在飞请求时停用插件 | 三个都以 `bridge_closed` 结束，无 20 s 挂起 |

## 5. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 面板已发出的点击无法撤销 | 文档与工具描述都写明"取消不保证撤销已完成动作"；不要在描述里承诺 stop |
| R2 | `cancel` 帧在旧版 client 里不认，被当未知类型丢弃 | 桥对未知帧已有兜底；client 升级后自然生效，协议版本号 +1 |
| R3 | `AbortSignal.any` 不可用 | 6 行 polyfill，单测 1/5 覆盖 |
| R4 | 忘记清 `onAbort` → 长跑会话内存增长 | 单测 5 用 listenerCount 钉住；`#settle` 统一清理 |

## 6. 实现记录（2026-11-21，版本 1.2.4）

### 6.1 落地形状

| 文件 | 改动 |
|---|---|
| `plugin/errors.js` | 新增 `cancelled` 码（`retryable: false`，hint 说明"已发出的动作不可撤销，重做前先重新读页面"）；码表 11 → 12 |
| `plugin/tools.js` | 模块级 `execSignals = new AsyncLocalStorage()`；`createGate` 在每个命令前读 `execSignals.getStore()?.signal`，已 abort 直接抛 `cancelled`（**零桥调用**），否则把 `signal` 放进 options；`createTools` 用一层 `map` 把 11 个工具的 `execute` 包进 `execSignals.run({ signal: exec?.signal }, …)`——一处改动覆盖全部工具，9 个 `bridge.request` 调用点一个都没碰 |
| `plugin/bridge.js` | `request(..., options.signal)`：入队前与 `start()` 后各查一次 `signal.aborted`；promise 内 `entry = { sessionId, resolve, reject, timer, onAbort }`，`finish()` 统一清 timer、摘 abort 监听、删 `#waiting`；abort 时走 `#cancel(id, sessionId)`：从会话队列摘掉命令、把 id 记进有界 `#cancelled`（上限 64）、入队 `{ type: 'cancel', params: { target }, show: 'never' }` 控制帧、reject `cancelled`；`/settle` 对 `#cancelled` 里的 id 回 `{ ok: true, ignored: true }` 并删记录 |
| `plugin/client.js` | `CLIENT_REV` 29 → 30；新增 `running`（id → guest）与有界 `cancelledIds`；`dispatch` 先处理 `cancel` 帧：记 id、`guest.stop()`、从 `deferred` 里摘掉还没跑的排队命令、**不回包**；`runCommand` 进入时登记 `running`、`finally` 删除，动作结束后若 id 在 `cancelledIds` 里则丢弃结果（成功/失败都丢），不 settle；`Guest.stop()` 调 `element.stop()`，只用于打断加载中的导航 |

### 6.2 单测

新增 `plugin/test/cancel.test.mjs` 7 例（比 §3 计划多一个"取消 A 不影响 B"）：已 abort 不入队、入队后 abort 摘队列 + cancel 帧、迟到回包 `ignored`、三码互不混用、100 次 request+abort 后 `getEventListeners(signal,'abort')` 为 0 且后续请求仍会超时（无残留 waiting）、取消一个会话不影响另一个、工具层 abort 零桥调用。

全量：`node --test <所有 plugin/test/*.test.mjs 绝对路径>` → **tests 121 / pass 121 / fail 0**（原 114 + 7）。

### 6.3 打包与装机

`dist/dsh-plugin-agent-browser/package.json` version → **1.2.4** → `node tools/pack.mjs` → `copied 14 files`、`dsh-plugin-agent-browser-1.2.4.tgz 99,175 bytes` → `plugin_manager install_bundle` → `application: "applied"`，pnpm `- 1.2.3 / + 1.2.4`；装机目录内 `client.js` 已是 `CLIENT_REV = 30` 且含 cancel 分支，`bridge.js` 含 `cancelledError` / `#cancel`。

### 6.4 装机验收

用临时脚本（验收后已删）直接加载**装机目录**里的 `bridge.js`，配假面板走真实 HTTP：

```
listening on http://127.0.0.1:10974 (token 43 chars)
queued cancel -> cancelled: cancelled: the caller stopped c1 before …
after cancel the queue holds 1 frame(s): cancel(c1)
in-flight cancel -> cancelled
late settle -> ok=true ignored=true
no panel -> bridge_timeout
close in flight -> bridge_closed
```

| 项 | 结论 |
|---|---|
| 取消真的停 | ⚠️ 部分：宿主与队列侧全程验证（已 abort 帧、100 次泄漏检查、装机探针）；"模型在 GUI 里中途按停止"需要人来触发，留 §6.5 的三步手测 |
| 不迟到 | ✅ 排队中的命令在 abort 后从队列消失，只留 cancel 控制帧 |
| 停止不误伤 | ✅ 单测"取消 A 不影响 B" + 探针里另一会话正常 settle |
| 关插件时干净 | ✅ 探针 `close in flight -> bridge_closed`（不等 20 s）；TICKET-017 的卸载路径复用同一 `close()` |
| 正常路径回归 | ✅ 装机后 `browser_open https://example.com/` → `Opened … Example Domain`，`browser_snapshot` 正常返回（含截图） |

### 6.5 偏差与残留

1. **没做 `AbortSignal.any`**（§2.1/R3）：超时本来就在桥里独立计时，合流只会让超时错误被 `cancelled` 抢走，与 §2.4"三码分开"的要求相反。取消只接受调用方的 `exec.signal`，超时只由桥的 timer 产生。
2. **没有 bump `BRIDGE_MARK`**（§5 R2 曾写"协议版本号 +1"）：旧面板收到 `cancel` 帧会把它当未知类型、以错误 settle；宿主此时已把该 id 记入 `#cancelled`，`/settle` 回 `ignored: true`，不会在用户界面上冒错。保持 mark 不变，换面板不必重建、登录态不丢，向前兼容更好。
3. **取消不撤销已完成的动作**（R1）：面板只对"加载中的导航"调 `stop()`；已发出的 click/type 不回滚。这一点写在 `cancelled` 错误的 hint 里，也建议在用户文档里复述。
4. **手测留给用户**（三步）：①对一个长页面（如 Wikipedia 大条目）调 `browser_snapshot`；②在 GUI 里中断该轮（按停止/新消息打断），预期 ~100 ms 内返回 `cancelled:` 而不是等 20 s；③对排队的 `browser_click` 重复一次，预期页面没有变化。
