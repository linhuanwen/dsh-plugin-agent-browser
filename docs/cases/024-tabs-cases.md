# 024 · 面板标签页真机验收（TICKET-050，1.5.12）

验收环境：DSH Desktop（宿主实测 `0.2.2-rc.5`）、插件 **1.5.12**（`dist/dsh-plugin-agent-browser/dsh-plugin-agent-browser-1.5.12.tgz`，346,051 B / 28 文件 / sha256 `4BAD7FA1CE8A3D029E7E6F98BA1FC8528BFBB34548AFD30B5535D4CB493BF0F5`）；工作区静态夹具由 `browser_open({ path })` 起在 `http://127.0.0.1:1931/t/demo/`。

> 本轮先在 1.5.11（内部构建，未发布）上跑通语义，最后修了两处显示层问题并把版本抬到 1.5.12；下面的命令与回执是 **1.5.12 最终包**重跑的原文。

## 1. 结论

| 编号 | 场景 | 结论 |
|---|---|---|
| T1 | `browser_open` 无 `newTab` | 在活动标签里导航（旧行为不变），`t1` 打开 wait 夹具 |
| T2 | `browser_open({ newTab:true })` | 新标签 `t2` 打开 console 夹具并自动激活，`t1` 留在后面 |
| T3 | `browser_tabs({action:'list'})` | 两行、活动行带 `*`、标题与真实 URL 都正确（URL 是回答前按需读的） |
| T4 | 活动标签上做动作 | `browser_click` 落在 `t2`；下一次快照尾部仍能拿到 `t2` 的 `page console` 条目 |
| T5 | `switch t1` → 快照 | 看到 wait 页自己的状态（计时器/状态文本），不是 `t2` 的内容 |
| T6 | `switch t2` → 快照 | 页面状态保留（`点击次数：1` 仍在），说明切换只换屏幕不重载 |
| T7 | `close t2` | 回执 `Closed t2.`，`list` 只剩 `t1` |
| T8 | `close t1`（最后一个） | 先建空白页再销毁旧的：`Closed t1.`，`list` 显示 `* t3: 新标签页`，面板未死 |
| T9 | `switch t9`（不存在） | `tab_not_found`，文案指向 `browser_tabs({ action: "list" })` |
| T10 | 6 个标签后再 `newTab` | `tab_limit`，文案指向先关一个 |
| T11 | 人工相位（接管/验证墙） | `list` 可用、`switch`/`close` 被拒——由 `plugin/test/tabs.test.mjs` 的真实 `Bridge` 用例锁住（真机复验需要真实验证墙，见 `docs/cases/015` F11 的墙状态） |

## 2. 证据原文

### T1 / T2 开两张标签

```text
browser_open { path: "demo/wait.html" }
  → Opened http://127.0.0.1:1931/t/demo/wait.html — browser_wait 夹具

browser_open { path: "demo/console.html", newTab: true }
  → Opened http://127.0.0.1:1931/t/demo/console.html — 页面 console 观测夹具
```

### T3 list（标题 + 真实 URL + 活动标记）

```text
browser_tabs { action: "list" }
  → 2 tab(s), active t2.

      t1: browser_wait 夹具 — http://127.0.0.1:1931/t/demo/wait.html
    * t2: 页面 console 观测夹具 — http://127.0.0.1:1931/t/demo/console.html
```

### T4 活动标签上的动作与 console 尾巴

```text
browser_click { ref: "e2" }
  → Clicked button "console.log 一条" at (85, 144).

browser_snapshot { includeImage: false }
  → …（6 refs）
    text "点击次数：1 最近一次：console.log 普通日志"

    page console (1 entry):
    - [log] 夹具：普通日志 1
```

### T5 / T6 切换保状态

```text
browser_tabs { action: "switch", tab: "t1" }
  → Switched to t1.

browser_snapshot { includeImage: false }
  → page "browser_wait 夹具" url=http://127.0.0.1:1931/t/demo/wait.html
    … status "状态：加载完成" …（wait 页自己的计时器状态）

browser_tabs { action: "switch", tab: "t2" }
  → Switched to t2.

browser_snapshot { includeImage: false }
  → text "点击次数：1 最近一次：console.log 普通日志"
```

### T7 / T8 关闭与「最后一个标签」

```text
browser_tabs { action: "close", tab: "t2" }
  → Closed t2.
    * t1: browser_wait 夹具 — http://127.0.0.1:1931/t/demo/wait.html

browser_tabs { action: "close", tab: "t1" }
  → Closed t1.
    * t3: 新标签页
```

### T9 不存在的标签

```text
browser_tabs { action: "switch", tab: "t9" }
  → Error: tab_not_found: there is no tab "t9" in this panel. Call browser_tabs({ action: "list" })
    and use an id from that answer.
```

### T10 上限

```text
browser_tabs { action: "list" }
  → 6 tab(s), active t8.
    …（t3 空白页、t4 wait、t5 console、t6 scroll、t7 long、t8 approval-form）

browser_open { path: "demo/wait.html", newTab: true }
  → Error: tab_limit: the panel already holds 6 tabs. Close one with
    browser_tabs({ action: "close", tab }) and try again.
```

随后逐个 `close` 回落到一张空白页，面板可继续正常使用。

## 3. 验收期发现（只有装上真机才看得见）

1. **`list` 的 URL 是旧的**：`TabStore` 最初在创建时缓存 `tab.url`（`about:blank#lease` 或空串），后续导航不刷新。改为回答 `list`/`switch`/`close` 前 `await store.refreshUrls()`，逐个 `getURL()` 写回；`about:blank` 前缀不当作真实地址。
2. **空白页标题被污染**：Electron 对无标题页的 `getTitle()` 会返回 `about:blank#<lease>`，`noteTitle` 把它当标题记下，于是最后一张标签显示成 UUID。修法两处：`noteTitle` 忽略 `about:blank` 开头的字符串；`snapshot()` 对「标题以 `about:blank` 开头」也按空白页处理，统一显示「新标签页」。
3. **客户端 bundle 缓存**：同版本重装或只 touch 安装目录 `client.js`，web shell 会复用已执行过的 bundle factory（`executedBundleUrls`），面板重挂但跑的还是旧代码。可靠做法是**完整重启 DSH**；版本号变化也不保证免重启（1.5.11→1.5.12 首次安装后面板一度整轮无响应，重启后恢复）。已写进发布说明的安装注意。

## 4. 复跑方式

```text
browser_open { path: "demo/wait.html" }
browser_open { path: "demo/console.html", newTab: true }
browser_tabs { action: "list" }
browser_click { ref: "e2" }
browser_snapshot { includeImage: false }     # 应看到 page console
browser_tabs { action: "switch", tab: "t1" }
browser_snapshot { includeImage: false }     # wait 页状态
browser_tabs { action: "switch", tab: "t2" }
browser_tabs { action: "close", tab: "t2" }
browser_tabs { action: "close", tab: "t1" }  # 应回落到新的「新标签页」
browser_tabs { action: "switch", tab: "t9" } # 应报 tab_not_found
```

## 5. 已知边界

- 面板重建（切 session、插件重载、重启 DSH）后标签不恢复——这是有意的 v1 取舍（不做标签持久化）。
- 页面 `window.open` 不会自动建标签：仍按既有同视图导航/拦截规则处理。
- 缩放按 session 记忆，切标签沿用同一比例（不做标签级独立缩放）。
- `switch`/`close` 在 `taken_over`/`needs_human` 下被拒；`list` 始终放行。
- 真机验收只覆盖夹具页；真实登录站点的多标签行为（Cookie 共享、弹窗站点）未逐站取样。
