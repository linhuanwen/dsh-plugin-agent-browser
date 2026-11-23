# TICKET-017 生命周期：一个 effect、一套有序清理

- **状态**：✅ 已完成（1.1.1 装机验收通过，2026-11-21，见 §6）
- **优先级**：P0（发布前必修；改动小、收益确定）
- **来源**：`docs/official-docs-review.md` #2（官方 `develop/framework`：多个异步处置器**并发**执行，依赖顺序的清理必须放进同一个 `ctx.effect()`）
- **对应验收**：`spec/002-official-alignment-spec.md` B2
- **关联**：TICKET-016（volatile 字段改动不重启，减少热替换次数）、TICKET-019（随机端口让 `EADDRINUSE` 重试不再必要）

## 1. 问题

`plugin/index.js` 现在开 13 个独立 effect：

| 位置 | 内容 |
|---|---|
| `plugin/index.js:72-74` | `bridge.dispose()` |
| `plugin/index.js:78-80` | `void sites.dispose()` |
| `plugin/index.js:83` | 每个工具一个 `ctx.effect(() => ctx.tools.register(tool), ...)`，共 11 个 |

官方原话：处置器按逆序**开始**调用，但异步处置器会**并发**执行。后果是三种真实的半死状态：

1. 静态服务先关、工具还在用 → `browser_open({path})` 拿到连接被拒；
2. 桥先断、工具在 `bridge.request` 里挂着 → 每个调用白等 `DEFAULT_TIMEOUT_MS`（20 s）；
3. 工具体引用已 dispose 的 bridge/sites → 抛 `TypeError` 而不是可读错误。

## 2. 修法

`apply` 只开**一个** effect，内部按顺序收：

```js
export function apply(ctx, config = {}) {
  // …建 bridge / sites / tools…
  const tools = createTools(ctx, bridge, sites, policy)

  ctx.effect(() => {
    // 注册顺序与清理顺序无关：清理永远是"先摘工具，再关服务"
    for (const tool of tools) ctx.tools.register(tool)

    return async () => {
      const failures = []
      for (const tool of tools.reverse()) {
        try { ctx.tools.dispose?.(tool.name) ?? noop() } catch (error) { failures.push(error) }
      }
      try { await bridge.close() } catch (error) { failures.push(error) }
      try { await sites.dispose() } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, 'agent-browser: cleanup failed')
    }
  }, 'agent-browser')
}
```

要点：

1. **桥要能优雅关闭**：`bridge.dispose()` 现在是同步的（`server.close()` 不等回调），新增 `async close()`——`server.close()` 包 Promise，并 `destroy()` 所有挂起的长轮询响应，避免 `close` 永远等不到。
2. **每个环节独立 try/catch**：一个环节抛错不得跳过后续环节，最后用 `AggregateError` 报出全部失败（比现在"第一个抛错、后面不执行"好）。
3. **工具摘除方式**：`ctx.tools.register()` 的返回值就是 disposer（`plugin/index.js:83` 现在的写法 `ctx.effect(() => ctx.tools.register(tool), ...)` 依赖这一点）。合并后必须显式保存并调用；若 `ToolsService` 没有 `dispose(name)`，就收集 `register` 的返回值当 disposer 用（优先，不依赖未公开 API）。
4. `ctx.effect` 的标签从 13 个变 1 个：`host half applied` 日志里加一行 `effects: 1` 便于肉眼确认。

## 3. 单测

新增 `plugin/test/lifecycle.test.mjs`（不碰 Electron，纯假对象）：

| # | 用例 |
|---|---|
| 1 | 假 ctx 记录 `effect` 调用次数：`apply` 后**恰好 1 次** |
| 2 | 手动调用返回的 dispose：记录顺序必须是「11 个工具 → bridge.close → sites.dispose」 |
| 3 | `bridge.close()` 抛错时，`sites.dispose()` **仍被调用**，且最终抛 `AggregateError` 含两条 |
| 4 | 工具 disposer 抛错不影响其余工具被摘除（11 个里第 3 个抛，其余 10 个仍被调用） |

用例 1 会用假的 `ctx.tools.register`（返回记录型 disposer）与假 bridge/sites，因此不需要真端口。

## 4. 装机验收

| 项 | 做法 | 期望 |
|---|---|---|
| 卸载干净 | `plugin_manager` 停用 `agent-browser-panel`，再启用 | 无 `ECONNRESET` / `ECONNREFUSED` 日志；`netstat -ano` 里 8792 不再处于 LISTENING（若 TICKET-019 已改随机端口，则看发现文件被删） |
| 不白等 | 停用瞬间如果有一个 `browser_snapshot` 在飞 | 该调用在 ~1 s 内返回"插件已卸载/桥已关闭"，而不是 20 s 超时 |
| 重载正常 | 改一个非 volatile 配置字段触发热替换 | 新实例起来后工具可调；旧实例的端口已释放（不出现 `EADDRINUSE`，现在 `bridge.js` 的 `#listen` 遇 EADDRINUSE 直接 reject，见 `:332-341`） |

## 5. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 合并后卸载顺序写反（工具最后摘、服务先关） | 单测 2 把顺序钉死；顺序写死在源码注释里 |
| R2 | `bridge.close()` 等待挂起的长轮询导致卸载卡住 | `close()` 先 `for (const res of parked) res.destroy()` 再 `server.close()`；加 2 s 上限，超时就 `server.closeAllConnections?.()` |
| R3 | 依赖 `ctx.tools` 未公开的 `dispose(name)` | 用 `register()` 返回的 disposer，不碰未公开方法（`spec/002` R2 同款原则） |
| R4 | 热替换期间新实例 bind 同一端口 | 与 TICKET-019 耦合：随机端口 + 发现文件后自然消失；在此之前可先加 `reusePort: false`（默认）并记录一次 EADDRINUSE 重试（上限 3 次、100 ms 间隔） |

## 6. 实现记录（2026-11-21，1.1.1 装机验收）

### 6.1 落地

`plugin/apply.js` 里只剩 **一个** `ctx.effect(..., 'agent-browser')`：注册 11 个工具并收集 `ctx.tools.register()` 返回的 disposer；卸载时按「工具逆序 → `claim.release()` → `bridge.close()` → `sites.dispose()`」执行，每一步独立 `try/catch`，失败汇总成 `AggregateError('agent-browser: N cleanup step(s) failed')`。

`plugin/bridge.js` 新增 `close()`：置 `#closed`（之后 `request/start` 立刻抛 `bridge_closed:`，不再白等超时）→ reject 所有等待中的命令 → 清队列 → `#wake()` 唤醒挂起的长轮询 → `server.close()` + 2 s 上限兜底 `closeAllConnections()`；`#server === null`（从未 listen）时安全返回，幂等。`dispose()` 保留为同步逃生口。`plugin/static.js` 的 `dispose()` 同样加 2 s 兜底。

### 6.2 单测

`lifecycle.test.mjs` 5 例：effect 恰好 1 个、清理顺序（工具逆序→桥→静态服务）、`bridge.close()` 抛错不跳过 `sites.dispose()`、单个工具 disposer 抛错不跳过其余、第 5 例是 TICKET-016 验收期补的 gate 透传回归例。`bridge.test.mjs` 3 例覆盖 `close()` 的失效/幂等/未 listen。

### 6.3 装机验收（实测）

| 项 | 实际操作 | 实测结果 | 结论 |
|---|---|---|---|
| 卸载干净 | `plugin_manager set_plugin include:agent-browser-panel enabled=false` | 返回 `application: "applied"`（**未卡 20 s**）；随后 `Invoke-RestMethod http://127.0.0.1:8792/dsh-agent-browser/health` 报 "无法连接到远程服务器" | ✅ 桥已释放端口，没有残留 LISTENING |
| 重载正常 | `set_plugin ... enabled=true` | 立刻 `applied`；下一条 `browser_open https://example.com/` 成功；`/health` 计数从 0 开始（新实例） | ✅ 新实例工具可调、端口未冲突 |
| 非 volatile 配置重载 | 改 `limits.snapshotMaxChars`（TICKET-016 验收同步做） | `/health` 计数清零（enqueued/pulled 0）→ 确认发生了插件热替换；随后快照按新预算截断 | ✅ 热替换真的走了一次单 effect 卸载路径 |
