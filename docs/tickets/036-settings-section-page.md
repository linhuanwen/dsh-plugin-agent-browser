# TICKET-036 设置里没有本插件：补一页 `settings.section` + 可写的配置通道

- 状态：✅ 已完成（1.4.19 设置页上线，1.4.21 写配置修通 + 重启类字段的重连确认，1.4.22 把注册结果写进 client 日志）
- 发现：2026-11-24（用户问「设置里面好像没有这一个项目？怎么选」）
- 版本锚点：`dsh-plugin-agent-browser` 1.4.19 → 1.4.22，装机 `1.4.22`（141,393 B / sha256 `c8c936deee833afdfdefd8563ec1fa1c7dff4c9107b42fc89ed4b5f11096f21e`）

## 1. 现象

插件在「设置 → 插件」里能看到（`plugin_manager list_bundles` 也有这一行），但设置左侧导航里**没有它**：装好之后仍然只能手改 `cordis.patch.yml` 才能调 `routing` / 快照上限 / 下载目录这些参数。

用户截图（2026-11-24 08:38）里的左侧导航：账号与余额 / 通用设置 / 模型 / Theme 外观 / 内置插件 / 移动端 / Agent 预设 / Token 统计 / 费用 / 插件市场 / DSH 插件库 / bili设置 —— 有 `settings.section` 注册的第三方插件（Token 统计、费用、插件市场、bili）都自带顶级条目，本项目没有，所以位置为空。

## 2. 原因

设置导航由 client 侧 Slot `settings.section`（kind list，字段 `id` 必需、可选 `order`/`label`）拼出来。**不注册就不出现**，与是否启用、是否装好无关。此前本项目的 client half 只注册了右侧栏的 `sidebartab` 与消息里的 `toolview`，没有设置页。

另一个坑：`dsh-plugin-agent-browser` 的 host half 没有任何写配置的入口——原来想「设置页直接改 YAML」是错的（`references/configuration.md` 明令禁止插件读写 profile 的 `cordis.patch.yml`），唯一合法通道是宿主的 `configEditor.edit(entry, fn)`。

## 3. 实现

### 3.1 设置页（`plugin/client.js`）

- `SETTINGS_LABEL = '浏览器面板'`、`SETTINGS_ORDER = 300`；
- `apply()` 里 `ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: ID, order: SETTINGS_ORDER, label: () => SETTINGS_LABEL }, SettingsPage)), 'agent-browser.settings')`；
- 页面顶部是现况（桥 origin/端口、工具数、持有浏览器的会话数，来自 `/health`），下面是六组表单：行为（`activation` / `fitWidth` / `evalEnabled` / `claimBrowserUse` / `routing`）、预算（`limits.*`）、下载（`downloads.*`）、搜索兜底（`searchFallback.*`）、会话白名单（`sessions.allowlist`）、本地文件服务（`static.maxBytes`）；
- 保存时只提交与当前值不同的**顶层字段**（`configEditor` 按整组替换，嵌套改动整组重发）。

### 3.2 配置通道（桥 + host half）

| 位置 | 内容 |
|---|---|
| `plugin/apply.js` | `CONFIG_FIELDS`（5 个 volatile + 6 个 restart）、`snapshotConfig()`、`createConfigChannel(ctx, …)`（`ctx.get('configEditor')` + `ctx.fiber.entry`，缺一个就返回 `null`，页面转只读）、`configChannelDiagnostics()`；`HOST_REV` 35 → 36 |
| `plugin/bridge.js` | `GET /dsh-agent-browser/config` → `{values, fields}`；`POST /config`（body `{patch}`）→ 写入后回 `{values, fields, restart}`；没有适配器时两条都回 `501`；`/health` 的 `diagnostics` 增 `config: true/false`、`hmr: {service, exit}` |
| `plugin/client.js` | `CLIENT_REV` 46；`callHost` 失败时带上宿主返回的 `error` 文本与 `status` |

### 3.3 `HMR transactions cannot be nested`（1.4.19 撞到的墙）

第一次 `POST /config {"routing":"auto"}` 回 `400 {"ok":false,"mark":"dsh-plugin-agent-browser/1","error":"HMR transactions cannot be nested"}`。

根因在宿主 `Hmr` 服务（`app.asar`）：

```js
executing = new AsyncLocalStorage()
runExclusive(operation) {
  if (this.executing.getStore()) return Promise.reject(new Error('HMR transactions cannot be nested'))
  const task = this.operations.then(async () => { …; return this.executing.run(true, operation) })
  …
}
```

`apply()` 本身跑在 `runReload` → `runExclusive` 的 `executing.run(true, …)` 里；桥的 HTTP server 是在 `apply()` 里创建的，于是**每个请求回调都继承了那个 store**，`configEditor.edit()` 内部的 `runExclusive` 就被判成嵌套。

修法（`createConfigChannel` 里）：

```js
const hmr = ctx.get('hmr')
const exit = typeof hmr?.executing?.exit === 'function' ? (run) => hmr.executing.exit(run) : (run) => run()
await exit(() => editor.edit(entry, (current) => ({ ...current, ...patch })))
```

`AsyncLocalStorage.exit()` 只在这一段写操作里退出 ambient 事务；服务缺失时退化成直接调用，失败照旧抛给页面。`configChannelDiagnostics()` 把 `hmr: {service, exit}` 放进 `/health`，以后再遇到同类问题可一眼判断是环境问题还是代码问题。

### 3.4 重启类字段的断线（1.4.21）

`limits` / `downloads` / `sessions` / `searchFallback` / `static` / `bridge` 是非 volatile：`configEditor` 会整行重载插件，`POST /config` 的响应经常来不及回来（`fetch failed`），但**写入其实已经落盘**。页面原来会报错，现在（`confirmAfterReload()`）改成：patch 里有 restart 类字段时，最多轮询 6 次（每次 1 s）重新 `GET /config`，看到目标值就显示「已保存，插件已重新加载」。

## 4. 证据

| 步骤 | 结果 |
|---|---|
| `node --test plugin/test/*.test.mjs` | 196/196（新增 `settings.test.mjs` 6 条 + `settings-section.test.mjs` 3 条） |
| `GET /config`（探针 `tools/case-run/config-probe.mjs`） | 200，`values` 11 个顶层字段、`fields` 与 `CONFIG_FIELDS` 一致 |
| `POST /config {"routing":"auto"}` | 200；`/health` → `routing: {mode: "auto", injected: true}`（桥端口 6734 → 14449，行被重载） |
| `POST /config {"routing":"off"}` | 200；`/health` → `mode: "off", injected: false`（原地生效，端口不变） |
| `POST /config {"limits":{…,"snapshotMaxChars":10000}}` | 写入落盘（复读 10000），响应被重载切断 → 1.4.21 据此加了重连确认；随后恢复 8000 |
| 装机 | 1.4.21 装毕，`/health` `config: true`、`hmr: {service: true, exit: true}`、`tools 11 / registered 11` |

## 5. 注意

- 页面**只**通过宿主 config editor 写配置；插件永远不碰 `cordis.patch.yml`。
- 表单保存的是「整组替换」语义：改 `limits.snapshotMaxChars` 要把整组 `limits` 发上来（页面已自动这么做）。
- 设置页不解决"两个浏览器后端谁说话算数"的问题（那是 `routing` + `AGENTS.md` 的事，见 TICKET-035）。
- 若 profile 没有 config editor（只读/内置 profile），`/config` 回 `501`，页面转只读并提示。
