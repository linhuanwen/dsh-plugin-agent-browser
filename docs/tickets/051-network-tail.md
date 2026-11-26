# TICKET-051：把页面自己的网络失败尾巴带进快照

**状态**：✅ 已实现并真机通过（2026-11-27，1.5.13）· 阶段 B2（观察增强）
**发现**：2026-11-27（阶段 B 观察增强第二个能力，TICKET-049 的孪生能力）
**关联**：SPEC-004 §4 B2/B3、TICKET-041（guards 注入）、TICKET-049（console 尾巴）、`docs/cases/025`

## 1. 缺口

TICKET-049 之后 agent 能看到「页面在 console 里说了什么」，但页面「点了没反应」的另一个大头是**请求本身出了问题**，而这些失败大多不会进 console：

- `fetch('/api/list')` → 401 / 500，前端 catch 住以后只显示「加载失败」；
- XHR 请求 404，页面把错误吞掉只把列表留空；
- 请求根本没发出去/被网络层拒绝（`TypeError: Failed to fetch`），DOM 上看不出任何区别。

人打开 devtools 的 Network 面板一眼就知道，agent 之前只能靠再发一次请求去猜（那又是写动作、要审批）。这个能力观察的是**页面自己发出的请求**，不是面板发出的请求。

## 2. 准入四问（SPEC-004 B1）

| 问题 | 回答 |
|---|---|
| 读还是写？ | 纯读：只旁听页面已有的 fetch/XHR，不产生新的页面动作、不重放请求、不新增 `actionClass`。 |
| 可逆吗？ | 不适用（没有副作用；被包装的函数仍调用原实现）。 |
| 失败能否确定「没执行」？ | 能：不经过审批与动作路径，失败就是「没读到」，`effect` 不适用。 |
| 人机墙 / 接管时能否拦住？ | 不涉及——挂在 `browser_snapshot` 上，而 `snapshot` 本来就是 `READ_TYPES`，人工相位下仍可用。 |

## 3. 设计

### 3.1 页面侧（`plugin/inject/guards.js`，rev 4 → 5）

新增 `installNetwork()`，与 `installConsole()` 同样的「包装 + 环形缓冲 + 调用原实现」模式：

- 包装 `window.fetch`：拿到响应后看 `ok`/`status`；`no-cors` 的 opaque 响应（`type === 'opaque'` / `'opaqueredirect'`，读不到状态）**不算失败**，只计数；
- 包装 `XMLHttpRequest.prototype.open/send`：`send` 时挂 `loadend`，读 `status`；
- 只把**失败**记进 `window.__dshNetwork`：fetch 状态非 2xx（非 opaque）、fetch 传输异常（`status: 0` + `error`）、XHR `status >= 400` 或 `status === 0`；
- 每条 `{ kind: 'fetch'|'xhr', method, url, status, ms, error? }`；URL 解析成同源 `path+query`、太长截断；缓冲上限 40 条；
- 另记 `window.__dshNetCount`：页面发出的 fetch/XHR **总数**（成功也计数），让尾巴能说「N 个请求里 M 个失败」；
- 页面把 `window.__dshNetwork` 换成非数组时，下一次记录重建；
- 包装失败（页面冻结 fetch/XHR）时页面行为不变——记录是尽力而为。

**不做**：响应体、请求头、cookie、WebSocket/EventSource、`PerformanceObserver` 的静态资源、瀑布图。看的是「失败」，不是「全部流量」。

### 3.2 面板侧（`plugin/client.js`，`CLIENT_REV` 56 → 57）

`Guest.readNetwork()`：`evaluate` 读出并清空 `window.__dshNetwork` 与 `window.__dshNetCount`，只取最后 20 条，返回 `{ entries, total }`。`runCommand` 的 `snapshot` 分支在结果上附 `network`（非空时）与 `networkTotal`（> 0 时）。

**每次快照清空**：与 console 尾巴一致；同一次失败不会在后续快照里重复占上下文。

### 3.3 宿主侧（`plugin/tools.js`）

- `browser_snapshot` output schema 增加 `network: [{kind, method, url, status, ms, error?}]` 与 `networkTotal`；
- render 末尾附 `page network (M failed of N request(s)):` + 最后 10 条 `- [kind] METHOD url → status, ms — error`，被隐藏的条数明确写出；
- snapshot 描述里说明这条尾巴与「每次快照清空」。

## 4. 证据

| 类型 | 证据 |
|---|---|
| 单测 | guards 16 → **22** 例（fetch 成功只计数、fetch 500 记录、fetch 异常记录且 Promise 仍 reject、opaque 不算失败、XHR 500/传输失败、缓冲上限与截断）；`plugin/test/network.test.mjs` 4 例（映射、无失败时逐字不变、render 只留 10 条并报隐藏数、畸形条目丢弃）→ 全量 335 → **345** |
| 真机 | `docs/cases/025`：`demo/network.html` 上点「成功请求 / 404 / fetch 传输失败 / XHR 404」后，下一次快照末尾出现 `page network (3 failed of 4 request(s)):` 三条失败；再下一次快照不再重复（已清空）；只点成功请求时不产生尾巴 |
| 错误码 | 无新增（仍 21 个）；`effect` 不适用（读） |
| 文档 | 本 ticket + `docs/cases/025` + 两份 README 的 `browser_snapshot` 行 + release notes 1.5.13 |

### 4.1 真机证据（1.5.13，`demo/network.html`）

依次点「fetch 成功」「fetch 404」「fetch 传输失败」「XHR 404」后的快照尾巴：

```
page network (3 failed of 4 request(s)):
- [fetch] GET /t/demo/missing-after-fetch-404.json → 404, 14ms
- [fetch] GET http://127.0.0.1:1/network-down → failed, 16ms — TypeError: Failed to fetch
- [xhr] GET /t/demo/missing-after-xhr-404.json → 404, 14ms
```

第二次快照（无新请求）没有 `page network` 段；只点成功请求后的快照也没有尾巴（成功只进分母）。完整命令与回执见 `docs/cases/025-network-tail-cases.md`。

## 5. 不做

- 不做 `browser_network` 新工具：观察结果挂在快照上，避免第 15 个工具与每轮 schema 成本。
- 不做网络请求重放/修改（那是写动作，要走审批与 effect 三态）。
- 不做 `mode: off` 配置：v1 只记录失败、量很小；真嫌吵再加（配置叶子字段会多一个，需同步门禁）。
- 不记录 dom-ready 之前的请求（guards 注入时机即此）。
- 不保证看到 Service Worker 内部发起的请求与 WebSocket 帧。
