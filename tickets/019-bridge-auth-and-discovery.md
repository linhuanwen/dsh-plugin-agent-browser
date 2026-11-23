# TICKET-019 传输与鉴权：动态端口、每进程令牌、可发现

- **状态**：✅ 已完成（1.2.0 实现；1.2.1 装机验收，见 §6）
- **优先级**：P0（发布前必修：现版本任意本机进程可驱动面板）
- **来源**：`docs/official-docs-review.md` #6/#7（`ctx.webServer` 路由、`dsh-client-connection` 的 per-process 令牌与 cookie）+ 安全核查发现（`plugin/bridge.js` 只校验 Origin）
- **对应验收**：`spec/002-official-alignment-spec.md` B4
- **关联**：TICKET-016（端口/超时从配置来）、TICKET-017（`bridge.close()` 优雅关闭）

## 1. 问题

三个独立缺陷叠在一起：

1. **端口写死两处**：`plugin/bridge.js:19` 的 `BRIDGE_PORT=8792` 与 `plugin/client.js:40` 的 `BRIDGE_URL`。第二个 DSH 实例启动时 `#listen` 撞 EADDRINUSE 直接 reject（`bridge.js:332-341`），桥不启动、全部工具 20 s 超时；而**新实例的面板 client 仍连 8792**，于是它驱动的是**另一个进程**里的面板——跨实例串台，登录态也串。
2. **只有 Origin 白名单，没有凭证**：`bridge.js:367-372` 的 `isPanelOrigin(origin)` 是唯一的门。Origin 是请求头，本机任何进程（脚本、别的 app、恶意 npm 包）都能伪造。伪造后能做的事等于面板能做的事：操作已登录页面、读页面内容、触发下载。
3. **静态服务同样零鉴权**：`plugin/static.js` 绑随机端口（这点是对的），但拿到 URL 就能读**整个工作区的文件**（`resolveWithin` 只防越界，不防读者）。端口随机不是秘密——本机进程扫 127.0.0.1 的高位端口即可找到。

## 2. 修法

### 2.1 令牌怎么来

每次 `apply` 生成一次，进程内存持有，不落盘在显眼处：

```js
import { randomBytes } from 'node:crypto'
const token = randomBytes(32).toString('base64url')   // 43 字符
const gate = (req) => {
  const header = req.headers['authorization'] ?? ''
  const given = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-agent-browser-token']
  return typeof given === 'string' && timingSafeEqual(Buffer.from(given), Buffer.from(token))
}
```

`timingSafeEqual` 要求等长，先比长度再比内容（长度不同直接拒，不泄露信息）。

### 2.2 端口怎么定

`server.listen(0, '127.0.0.1')` 由系统分配（静态服务已经是这个写法，`static.js:159`），桥照抄：`BRIDGE_PORT` 降级为"配置里可选的固定端口"（默认 `0`）。

### 2.3 方案 A / B / C（与 `spec/002` B4 同名）

**方案 A（最彻底）**：删掉桥，面板 → host 改走同源 `ctx.webServer.register(route)`（`exact` 路由 + `resource(request, peer)`），鉴权复用 `dsh-client-connection` 的浏览器会话（`ctx.connection.admit(request)`）。前提是 U2 为真。收益：少一个服务、令牌问题整体消失、路由天然只有本 DSH 来源能打。代价：约 20 处 `bridge.request` 调用点要换传输；失去现在"面板不在前台也能排队、回来再取"的长轮询语义，需要用 `registerUpgrade` 长连接补。

**方案 B（推荐，本 ticket 主线）**：保留桥；端口随机、令牌每进程生成；令牌**怎么送到 client** 取决于 U1，按 B1 → B2 → B3 优先级选第一条可行的。

**方案 C（兜底）**：端口仍 `8792`、令牌照发；仅在 U1 与 U2 都为假时启用，并在发布文档"已知风险"里披露。

下表只决定**方案 B 的下发途径**：

| 下发途径 | 前提 | 探针 |
|---|---|---|
| **B1. 入口配置下发**（首选） | client `apply(ctx, config)` 能收到该 Loader 条目的 config | 在 `plugin/client.js` 的 `apply` 里打印 `config`，量一次即知。注意 `dsh-client-modules` 的 `ClientPackageSource` 注释提到 `baseUrl` 是"Resolution base of the config tree that owns the row"，暗示 config 与条目同行可达，但**未证实** |
| **B2. 宿主路由发现** | 能在同一来源上开一个只对已认证浏览器开放的路由 | `ctx.webServer.register({ path: '/agent-browser/discovery', exact: true, resource: (req) => ... })`，先过 `ctx.connection.admit(req)`，返回 `{ port, token }`。Electron 的 `file://` + IPC 桥接 fetch 能否命中该路由需实测 |
| **B3. 发现文件 + 固定端口回退** | 以上都不行 | 写 `$DSH_HOME/agent-browser/port.json`（`{ port, token, prefix, pid, version }`，`mode: 0o600`），client 仍连 8792 并从**页面 URL 的 hash** 里取令牌（宿主把令牌拼进面板 iframe 的 `src`）。最丑，但今天就能用 |

无论哪条，**令牌都不是明文常量**，且 client 拿不到时工具侧 fail fast 报 `unauthorized`，不静默降到无令牌模式。

### 2.4 静态服务

- URL 形状改为 `/t/<token>/<path>`；`plugin/tools.js` 里拼 URL 的三处（`browser_open` 的 `path` 分支等）同步改。
- 命中 HTML 文档时**顺带种 cookie** `ab=<token>; Path=/; SameSite=Lax; HttpOnly`——子资源请求（CSS/JS/图）不会带 query，靠 cookie 过门。这样"相对路径、根路径"两种写法的页面都能加载。
- `Host` 头必须精确等于 `127.0.0.1:<port>` 或 `localhost:<port>`，防 DNS rebinding。

### 2.5 桥

- 保留 `isPanelOrigin` 作为纵深防御（Origin 白名单 + 令牌双门）。
- 预检 `OPTIONS` 返回 204 时只回显白名单内的 Origin（现状已如此，`bridge.js:377-380`），并新增 `Access-Control-Allow-Headers: authorization, x-agent-browser-token`。
- 401/403 一律返回 JSON `{error: {code: 'unauthorized'}}`，**不要**用 `WWW-Authenticate: Basic`（会弹浏览器登录框）。

## 3. 单测

新增 `plugin/test/auth.test.mjs`（起真 server、绑 127.0.0.1:0，不碰 Electron）：

| # | 用例 |
|---|---|
| 1 | 无令牌请求 `POST /dsh-agent-browser/...` → 403 且 body 是 `{error:{code:'unauthorized'}}` |
| 2 | 错误令牌 → 403；正确令牌 → 进入原逻辑（用 GET 轮询端点断言 200/204） |
| 3 | `Host: evil.example` → 403（即使令牌正确） |
| 4 | 两个 bridge 实例同时启动：端口不同、各自令牌互不通过 |
| 5 | 静态服务：`/t/<正确token>/index.html` → 200 且 `set-cookie: ab=...`；`/t/<错误token>/...` → 403；带 cookie 无 query → 200 |
| 6 | 令牌比较：长度不同时立即返回 false（不抛 `RangeError`） |

## 4. 装机验收

| 项 | 做法 | 期望 |
|---|---|---|
| 双实例不串台 | 开两个 DSH 窗口，各自打开面板 | 两个面板各自可控；`netstat -ano` 里看到两个**不同**的 127.0.0.1 端口 |
| 无凭证打不进 | `curl -i -X POST http://127.0.0.1:<port>/dsh-agent-browser/dispatch -H "Origin: http://127.0.0.1:<dshport>"` | 403 / `unauthorized`，面板无反应 |
| 静态文件不裸奔 | 浏览器直接开 `http://127.0.0.1:<staticport>/`（不带 `/t/<token>`） | 403，不是文件列表也不是 404 |
| 重启自恢复 | 重启 DSH，面板重新打开一个站 | 自动连上新端口（无需手动改任何东西） |

## 5. 风险与未验证

| # | 项 | 处理 |
|---|---|---|
| U1 | client 能否收到 entry config（方案 A） | ✅ 已探明：**不能**。client 的 `apply(ctx, config)` 只收到 `{ name: id }`，Loader 条目的 config 不下发（证据见 §5.1）→ 本 ticket 走 B2 |
| U2 | 桌面 renderer 能否命中 `ctx.webServer` 路由（方案 B） | ✅ 已探明：**能**。`dsh-app://app` 的非静态路径由 `protocol.handle` 转发到宿主 origin 并注入认证 cookie（证据见 §5.1）→ B2 可用 |
| U3 | 令牌存在 renderer 内存里，页面内 XSS 可读 | 与现状同源风险（面板本来就能驱动浏览器），记录在 README 安全节 |
| R1 | 静态服务改 URL 形状会破坏已有的 `browser_open({path})` 用例与 71 个单测里的 3 个 | 改完跑全量；先加新形状，旧形状保留一个版本并打 deprecation 日志 |
| R2 | Windows 上 `mode: 0o600` 不生效 | 文档写"Windows 下靠 ACL，不保证"；发现文件里不放长效凭证（只在进程存活期有效） |
| R3 | cookie 被相邻端口页面读到（同主机 cookie 不按端口隔离） | cookie 值就是令牌，而令牌只对**特定端口的桥**有效；静态端口是随机的，实际风险低，但要写进风险节 |

### 5.1 探针取证（2026-11-21，静态读 asar）

两个探针都靠读实现定案（不需要跑运行时探针：证据是加载路径本身，不是行为猜测）。

**U1 = 不能（B1 不可行）**

| 证据 | 位置 | 事实 |
|---|---|---|
| 客户端条目构造 | `dsh-client-modules/src/client/entries.ts` `private async create(loader, id)` | `const options = { name: id }` 后 `loader.create(options)`——没有 config 字段 |
| 启动图行形状 | `dsh-client-modules/src/client/manifest.ts:127-135` `BootPluginRow` | 只有 `{ id, inject, immediately }` |
| 行来源 | `dsh-client-modules/src/index.ts:1073-1080` | 行由 `loaderName` + `baseUrl` 构造，无 config |

结论：client 半侧拿不到 Loader 条目 config，B1（"把端口/令牌写进插件配置让 client 读"）不成立。

**U2 = 能（B2 可用）**

| 证据 | 位置 | 事实 |
|---|---|---|
| scheme 定义 | `lib/main.js:1478` | `const SCHEME = "dsh-app"`，Electron 用自定义 scheme 加载 renderer |
| 协议处理器 | `lib/main.js:20791-20803` | `/`、`/index.html`、`/assets/*`、`/favicon.svg`、`/manifest.webmanifest` 由 dist 直接服务；**其余路径** `forwardWebRequest(request, hostUrl, hostCookie)` |
| 转发实现 | `lib/main.js:15348-15382` | 校验 `origin` 为 null 或 `dsh-app://app`；`target.pathname/search` 取自请求；删 `host/origin/cookie/sec-fetch-site`；`headers.set('cookie', cookie)`；`fetch(target, {redirect:'manual'})` 原样回传 |

结论：桌面 renderer 里 `fetch('/agent-browser/discovery')` 会被转发到宿主同源路由，并带上宿主认证 cookie ⇒ 探针路由放在 `ctx.webServer` 上，用 `ctx.connection.admit(req)` 把门，只对已认证浏览器会话返回 `{port, token}`。Web GUI 场景 renderer 本来就是宿主 origin，同源 fetch 天然带 cookie，同一套实现通吃两种壳。

> 备注：`dsh-host-webserver` README 写的是"Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch"，与 rc.5 实际的 `dsh-app://` + `protocol.handle` 有出入；以代码为准。

## 6. 实现记录（2026-11-21，版本 1.2.0 / 1.2.1）

### 6.1 落地形状

| 层 | 文件 | 做了什么 |
|---|---|---|
| 桥 | `plugin/bridge.js` | `BRIDGE_PORT` 降为 `0`（系统分配）；每实例 `randomBytes(32).toString('base64url')`（43 字符）作 `#token`；`#hostTrusted` 精确比对 `Host: 127.0.0.1:<port>` / `localhost:<port>`；`#tokenMatches` 接受 `Authorization: Bearer`、`x-agent-browser-token`，**仅 GET/HEAD** 接受 `?token=`；校验顺序 = 前缀 → OPTIONS → Host(403) → 令牌(403) → 路由；`/health` 增加 `origin`；`sameToken` 先比长度不抛异常；401/403 返回 `{ok:false,mark,error:{code:'unauthorized',message}}`，无 `WWW-Authenticate` |
| 静态 | `plugin/static.js` | URL 形状 `/t/<token>/<path>`（`urlForPath(origin, root, input, token)`）；HTML 文档命中 token 路径时 302 到 `/t/<rel>` 并种 `ab=<token>; Path=/; HttpOnly; SameSite=Lax`，子资源靠 cookie 过门；cookie 模式同样可访问 `/t/...`（剥前缀）；`Host` 用 `request.socket.localPort` 精确比对；裸 URL 一律 403 `forbidden` |
| 发现 | `plugin/apply.js` | `DISCOVERY_PATH='/agent-browser/discovery'`，`exact` 路由注册在 `ctx.webServer`；`ctx.get('connection').admit(req)` 未通过 → 401/403；无 `connection` 服务 → 503；非 GET/HEAD → 405；成功返回 `{ok,mark,prefix,origin,port,token}`；disposer 在单 effect 里排在工具之后（倒序执行时先于断桥） |
| 客户端 | `plugin/client.js` | `CLIENT_REV=29`；删除写死的 `BRIDGE_URL`，改 `resolveBridge()`：同源 `fetch('/agent-browser/discovery', {credentials:'same-origin'})` → 校验 `ok/mark/port/token` → 缓存；GET/HEAD 用 `?token=`（避免轮询触发预检），POST 用 Bearer；401/403/网络错误清缓存并重发现一次；发现失败时工具侧 fail fast，不降级 |
| 配置 | `plugin/config.js` `plugin/index.js` | `DEFAULTS.bridge.port = 0`，配置项保留（可选固定端口），描述改为"0 由系统分配，面板从宿主发现路由拿地址" |

### 6.2 单测（`plugin/test/auth.test.mjs` 6 例 + 改造）

| 用例 | 断言 |
|---|---|
| 无令牌请求 | 403 且 `error.code === 'unauthorized'` |
| 错令牌 / 短令牌 / 正确令牌（query + header） | 403 / 403 不抛 `RangeError` / 200 且 `mark` 正确 |
| 状态变更方法不接受 query 令牌 | `POST /log?token=…` → 403 |
| 伪造 `Host: evil.example`（令牌正确） | 403 `untrusted host` |
| 两个桥实例 | 端口不同、令牌互不通过、各自 200 |
| 静态服务 | 裸 URL 403、错 token 403、正确 token 302 + `HttpOnly` cookie |

全量 `node --test`（`plugin/test/*.test.mjs`）：**106 / 106 通过**（含 016/017 新增与存量 71 例）。

### 6.3 装机验收（1.2.0 → 1.2.1，实测）

| 项 | 实测 |
|---|---|
| 端口动态 | DSH 进程监听 `6324`（宿主）、`7763`（静态，按需）、`13503 → 10960`（桥，重载后换端口）；**`8792` 无监听** |
| 无凭证打不进 | 本机另一进程 `GET /dsh-agent-browser/health` → `403 {"ok":false,"mark":"dsh-plugin-agent-browser/1","error":{"code":"unauthorized","message":"missing or invalid token"}}` |
| DNS rebinding | `Host: evil.example` + 正确令牌 → `403 ... "untrusted host"` |
| 发现路由不裸奔 | 无 DSH 会话 cookie 访问 `GET http://127.0.0.1:6324/agent-browser/discovery` → `401 {"ok":false,"error":{"code":"unauthorized"}}` |
| 静态不裸奔 | 另一进程 `GET http://127.0.0.1:7763/probe/static-check.html` → `403 forbidden` |
| 静态 cookie 链路 | `probe/static-check.html` 经 token URL 打开 → 302 → `/t/probe/static-check.html`；页面内实测 `document.cookie === ''`（HttpOnly）、外部 CSS 生效（`rgb(1, 2, 3)`）、外部 JS 执行（`script and cookie check ok`） |
| 客户端发现 | `browser_open example.com` 正常（工具→桥→面板全链路）；`set_plugin enabled=false` 后 900 ms 内桥与静态端口全部关闭（仅剩 6324）；`enabled=true` 后新端口 `10960`，**不刷新页面**再 `browser_open` 即成功（客户端自动重发现） |
| 双实例不串台 | 另起一个 `Bridge({port:0})` 实例 → 端口 `6985`；用它的令牌打 DSH 桥 → 403；两实例同时存活，关掉模拟实例后 DSH 桥不受影响 |
| 自恢复 | 重新启用后 `/health`、发现路由、工具均恢复；`/health` 计数从 0 开始 |

### 6.4 与 ticket 原文的偏差

1. **方案 A 不做**：U2 虽为真，但方案 A 要替换约 20 处 `bridge.request` 并重做"排队—长轮询"语义，收益（少一个服务）不抵改动面；B2 已让令牌不下发到页面、端口不可预测。
2. **静态 302/cookie 只对 HTML 文档做**：`text/plain`、`application/json` 等无子资源的响应直接 200，不种 cookie（本次验收的 README.md 即走这条）。
3. **CORS 仍回显 `*`**：面板 Origin 在 Electron 壳里是 `dsh-app://app`、在 Web 壳里是宿主 origin，白名单已无法枚举全；令牌 + Host 双门使 CORS 不再是边界（浏览器是否放行已不影响"没有令牌拿不到数据"）。
4. **令牌不落盘**：进程内内存持有；重启即失效，面板靠发现路由重新取（对应 §4"重启自恢复"）。

### 6.5 已知残留

- **U3 不变**：令牌在 renderer（client 半侧）内存里，同源运行的其他客户端插件理论上可读；与"面板本来就能驱动浏览器"同级风险，发布文档安全节披露。
- cookie 与端口：同主机 cookie 不按端口隔离（R3），但静态端口随机且 cookie 值只对当前进程的静态服务有效。
- 未把令牌写进 `/health`（该端点匿名可打，只回 `mark/origin` 与计数）。

### 6.6 验收期顺手修的 bug（另立 TICKET-026）

验收中打开自家 `README.md`（`text/plain`）时，`inject/detect.js` 的"文本短语 + 交互元素少"规则把它判成人机验证，面板进入 `needs_human` 并拒绝输入工具。已加"纯文本文档永不判墙"（`document.contentType` 不含 `html` 时禁用 text-only 判定），补 2 例回归。详见 `tickets/026-plaintext-detect-false-positive.md`。
