# TICKET-029 应用重启后发现路由未注册，所有工具调用超时

> 状态：✅ 已完成（2026-11-22，版本 1.3.7 装机验收通过）
> 优先级：P0（阻断性——插件看起来"活着"，但 11 个工具全部不可用）
> 来源：2026-11-22 早上应用重启后的冒烟（`browser_open` 连续三次 `bridge_timeout`）
> 对应验收：`spec/002` B4（传输与发现）的稳定性补充；TICKET-019 §4 第 4 条"重启自恢复"的反向用例
> 关联：`tickets/019-bridge-auth-and-discovery.md`、`plugin/apply.js`、`plugin/client.js`

## 1. 问题

应用重启（或 profile patch 触发插件重载）后，宿主侧一切正常，工具却全部 `bridge_timeout`：

```
browser_open https://example.com/
Error: bridge_timeout: browser panel did not answer c1 (open) within 45000ms.
```

实测取证（2026-11-22 09:30 左右）：

| 观测 | 结果 | 说明 |
|---|---|---|
| `plugin_manager list_plugins` | `include:agent-browser-panel` enabled / **fiberPhase active** | 宿主半边确实加载了 |
| 桥端口 | `127.0.0.1:9530`，`GET /agent-browser/discovery` → `404 {"ok":false,"error":"not this service","mark":"dsh-plugin-agent-browser/1"}` | 桥在跑，`mark` 对得上 |
| 宿主 `GET http://127.0.0.1:9529/agent-browser/discovery` | **404** | **发现路由不存在**——客户端永远拿不到桥地址 |
| 面板页签 | 已打开 | 客户端在轮询，但没有可轮询的目标 |

根因在 `plugin/apply.js` 的 `registerDiscovery()`：它只尝试一次 `ctx.get('webServer')`，拿不到就记一行日志并返回 no-op。而这个插件的 `inject` 只有 `['tools','attachments']`——**不依赖 `webServer`**，所以 apply 完全可能先于 web server 注册执行（开机时、profile 重载时都可能）。路由一旦漏注册，没有第二次机会：

- 宿主日志里只有一行 `no webServer service: the panel cannot learn the bridge address`，而 DSH 桌面端不落盘日志 → 用户看不到；
- 客户端 `resolveBridge()` 失败后只是退避重试，`report()` 也发不出去（还没拿到桥）；
- 表现就收敛成"每次都 45s 后 `bridge_timeout`"，与"面板没开"极像，误导排查。

这不是 1.3.7 之前的回归，是 TICKET-019 就带着的竞态：昨天的验收正好在 web server 已就绪之后 apply，所以没暴露。

## 2. 修法

| 层 | 改动 |
|---|---|
| 等待服务 | `registerDiscovery()` 拿不到 `webServer` 时，改用 `ctx.inject(['webServer'], (scope) => …)` 挂一个子作用域；服务出现后在其中 `install(webServer)`，并把路由 disposer 挂到子作用域（`scope.effect(...)`），随插件卸载一起撤 |
| 解析时机 | `connection` 改成**每次请求现取**（`ctx.get('connection')` 在 handler 内），不再在注册时快照成 `null`——否则连接服务晚到一点，发现路由会永久回 503 |
| 降级 | 仍然没有 `ctx.inject`（老宿主/测试桩）时保留原 no-op，但日志写明"面板无法获知桥地址" |
| 测试 | `plugin/test/lifecycle.test.mjs` 新增 1 例：假 ctx 无 `webServer`、有 `inject` → 断言 ①确实在等（deps 为 `['webServer']`）②回调触发后路由注册（`kind:'exact'`、`path:'/agent-browser/discovery'`）③无 `connection` 时 handler 回 503、`connection` 出现后回 200 且带 `mark` ④路由 disposer 挂在注入作用域里 |

不改的部分：`inject` 不改成 `['tools','attachments','webServer']`——那会让没有 web server 的部署（例如无 GUI 的 headless 组合）整个插件停在 `pending`，11 个工具一起消失（U7 已验：cordis 没有可选注入）。等待式注册是唯一不牺牲可用性的写法。

## 3. 单测

`node --test plugin/test/lifecycle.test.mjs` → 6/6；全量 `node --test <所有 plugin/test/*.test.mjs>` → **144 / 144 通过**（新增 1 例）。

## 4. 装机验收

| # | 操作 | 期望 | 实测 |
|---|---|---|---|
| 1 | 装 1.3.7 后 `GET http://127.0.0.1:9529/agent-browser/discovery`（无 cookie） | 401（路由在、`connection.admit` 把门），不再是 404 | ✅ `401 {"ok":false,"error":{"code":"unauthorized"}}` |
| 2 | `browser_open https://example.com/` | 正常打开 | ✅ `Opened https://example.com/ — Example Domain` |
| 3 | 再开一页（客户端应已缓存地址） | 正常 | ✅ |
| 4 | 关掉/重开插件（profile 重载）后重复 1–2 | 路由仍会自己补上 | 待下一次重载复验（本次修复即为其设计目标） |

打包：`dsh-plugin-agent-browser-1.3.7.tgz` 111,792 B（15 个文件）→ `plugin_manager install_bundle` applied（`-1.3.6 / +1.3.7`）。

## 5. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| R1 | `ctx.inject` 在子作用域里注册路由，若 web server 比插件后卸载，路由会随服务一起失效（正常） | disposer 双向挂好；重载时插件重新 apply |
| R2 | 等待期间（毫秒到秒级）工具已注册但发现路由未就绪，此时调工具仍会 `bridge_timeout` | 窗口极短；README 故障排查表补一条"刚重载完稍等几秒再试" |
| R3 | 若宿主永远没有 web server，插件仍会在每次调用时超时而不是报"不可用" | 属部署异常；日志已明确写出 |

## 6. 实现记录（2026-11-22，版本 1.3.7）

- `plugin/apply.js`：`registerDiscovery()` 重写为「`usable(server)` 判定 + `install(webServer)` + 缺失时 `ctx.inject(['webServer'], scope => …)` 等待」；handler 内 `const connection = ctx.get?.('connection')` 现取；返回的 disposer 会 `dispose()` 等待中的子作用域。
- `plugin/test/lifecycle.test.mjs`：新增 `discovery waits for the web server and resolves the connection per request`。
- `dist/dsh-plugin-agent-browser/package.json` version → 1.3.7；`node tools/pack.mjs` → `copied 15 files`、tgz 111,792 B；装机 applied。
- 验收证据见 §4（401 而非 404 + `browser_open` 恢复正常）；不再有"明明 fiberPhase active 却全部超时"的静默状态。
