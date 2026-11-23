# 参考 003：命令通道与面板挂载（TICKET-002 实测）

记录 2026-11-19 实现 `plugin/` 骨架时确定下来的四件事实。它们都不在原始 spec 里，但都会决定后续实现怎么写。

## 1. 为什么通道是 loopback HTTP，而不是 typert

先确认了 DSH 的 Remote 方向性（取证见 `forge` 包与 `api-gateway`）：

- **host 侧暴露方法**：继承 `TypertRemoteService`，`super(ctx, '<namespace>')` + `@Remote` 即可，生成工件不是必需品（gateway `resolveDescriptor` 找不到 strict 定义时会走 `resolveSrcDescriptor` 运行时反射）。
- **client 侧调用**：`await ctx.remote.$mount(contribution)` 之后 `ctx.remote.<ns>.<method>(...)`，一元调用返回 `RemoteResult<T>`（`{ok:true,value}` / `{ok:false,error}`，不抛异常）。
- **反向（host → client）**：只有两条路，**都不适合第三方插件**：
  1. `@Remote({mode:'stream'})` —— 但流必须由 **client 发起**，host 只能响应并 `yield`；双向要靠同一条流的 uplink（client `handle.send()` → host `ctx.invocation.uplink()`）。要用它，客户端就得先挂一个 `./remote` 工件，还要把插件拆成 host/client 两个包（forge 就是这么拆的）。
  2. forwarded event（`ctx.remote.$on`）—— 可转发的 key 集合写死在应用层常量里（`@deepseek-ai/dsh-api-remotes/src/remote-events.ts:27` 的 `API_REMOTE_FORWARDED_EVENTS`：`agent-preset/selected`、`approval/request`、`api-session/activity` …），第三方包无法注册自己的事件。
  3. 另外 client 半的 `apply(ctx)` **拿不到插件配置**（`dsh-client-modules/src/client/entries.ts:182` 只传 `{ name }`），所以端口也不能用配置项注入。

结论：用 loopback HTTP 作命令通道（`127.0.0.1:8792/dsh-agent-browser`），host 排队 + client 100ms 拉取。它就是 spec §3.2 的方案 A，只是把"typert 推送"换成"本地 HTTP"，好处是零协议工件、`curl` 可直接检查、client 侧无依赖。**接口对外不变**：将来若改用 stream，只要保持 `Bridge` 的 `request()/settle()` 形状。

## 2. Slot 分发键是 tab 的 **id**，不是 kind

官方 `dsh-client-ui-sidebar-browser/src/client/definition.tsx`：

```ts
export const BROWSER_KIND = 'browser'
export const BROWSER_ID = '@deepseek-ai/dsh-client-ui-sidebar-browser'
// SidebarRightTabDefinition { id: BROWSER_ID, kind: BROWSER_KIND, multiple: true, ... }
```

而 `src/client/index.ts:82-95` 注册 body 用的是 `key: BROWSER_ID`。也就是说：

- `ctx.sidebarRight.openTab(kind)` / `openTabIn(sessionId, kind)` 用 **kind**；
- `ctx.slots.register({ name: 'sidebar.right.pane.tab', key })` 的 **key 必须是 tab 定义的 `id`**。

写错的表现极具迷惑性：tab 出现在侧栏、标题正确、**body 空白**，`openTab` 不报错，日志也看不出问题。本次就是先用了 kind 当 key，面板一直不挂载。

## 3. 渲染器 → loopback 的 POST 必须处理 CORS 预检

渲染器 origin 是 `dsh-app://app`。带 `content-type: application/json` 的 POST 属非简单请求，浏览器先发 `OPTIONS`。只回 404 时预检失败，真正的 POST 根本不会发出，表现为"host 入队了、client 也拉到了、但 settle 永远不到"→ 工具 20s 超时。bridge 现在在 origin 校验之后立刻回 `204` + `access-control-allow-*`（见 `plugin/bridge.js` 的 `OPTIONS` 分支）。

## 4. 非当前会话的面板不挂载，工具要快速失败

`openTabIn(sessionId, kind)` 能给任意会话建 tab，但 DSH 只渲染**当前显示会话**的侧栏，其它会话的 tab body 不会 mount。此时没有任何东西能驱动 webview，所以：

- 命令在 `deferred` 里等 `MOUNT_GRACE_MS`（原 1.5s，TICKET-007 验收时改成 **5s**：首次命令要开 tab、建 webview、等 `dom-ready`、拿租约，暖渲染器实测 1.0–1.8s，刚升级/刚重载后会超 1.5s；等久一点只是让失败消息晚到，等太短会把正常面板误判成"不在屏幕上"）；
- 仍无 runner 就 `settle(ok:false, error:'the browser panel of session … is not on screen …')`；
- 不静默等满 20s，也不擅自把用户的界面切到别的会话。

这是产品上的有意选择：面板的核心承诺是"看得见"，看不见的会话没有可操作的页面。

## 5. 开发循环

| 改动位置 | 生效方式 | 耗时 |
|---|---|---|
| `client.js` | `remove_bundle` → `install_bundle`（client 半重新执行 factory） | ~1.5s |
| `index.js` / `bridge.js` / `tools.js` | `set_plugin` 切 enabled（host 半重新 import） | ~1s |
| 只改工具描述等 | 同上，工具表会在下一步刷新 | — |

注意：`set_plugin` **不会**重载 client 半，别指望用它在浏览器侧看到改动。

## 6. 可观测性

渲染器没有可读的控制台，所以 client 半把关键节点 POST 到 host 的 `/log`，host 存环形缓冲（200 条），`/logs` 回读：

```
curl http://127.0.0.1:8792/dsh-agent-browser/logs
curl http://127.0.0.1:8792/dsh-agent-browser/health   # clients/queued/waiting/enqueued/pulled/logs
```

实测时间线（首次成功打开本地页）：

```
poll start → client half applied → panel mount → mount start → lease acquired
→ guest dom-ready → panel ready → poll got work → dispatch → run → settled
```

## 7. 留给后续 ticket 的问题

- `browser_open` 目前只等 `loadURL` resolve，没有等 `did-stop-loading`，SPA 首屏可能提前返回（TICKET-003 起统一"就绪"判据）。
- tab 生命周期没有跟会话生命周期挂钩：会话归档后租约仍持有，直到面板卸载（TICKET-004+）。
- 没有 takeover 门控：`human` 状态下输入类命令仍会被执行（TICKET-005）。
