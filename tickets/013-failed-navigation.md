# TICKET-013 失败导航不该毁掉现场

> 状态：✅ **已完成（2026-11-22，1.3.9 装机验收）**
> 分工：本 ticket 只负责"**回得去**"（现场不丢）；"**还能去哪**"（失败后给同站替代入口）是 `tickets/027-search-fallback-navigation.md`，且必须在本文合入之后做。

## 1. 问题

`browser_open` 打开一个不可达的地址时，报错是诚实的，但**webview 已经被带走**：

```
browser_open('https://www.bing.com/search?q=site%3Asamr.gov.cn+…')
→ Error: Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_CONNECTION_RESET (-101) loading '…'
```

随后 `browser_eval('({url:location.href,title:document.title})')`：

```json
{"url":"chrome-error://chromewebdata/","title":""}
```

也就是说：

1. 原来那页（`https://www.samr.gov.cn/`）**没了**，回不去；
2. 面板停在 Chromium 的内部错误页上，`title` 为空、没有 DOM 内容，后续 `browser_snapshot` 只会得到一棵空树；
3. 模型如果没注意到，会以为"页面还在"，继续在空白页上找元素 → 连环 `not_found`。

这与 T8 的判据（"若确实拿不到，汇报'被拦' + 已尝试的路径，不死循环重试"）冲突：现场丢了，就汇报不清"从哪来、要回哪去"。

## 2. 期望行为

| 场景 | 期望 |
|---|---|
| 导航失败（DNS / 连接重置 / 证书） | 错误里带 `stage`（`nav_dns` / `nav_refused` / `nav_reset` / `nav_cert`）与原始 URL，**并且面板回到失败前的地址**，或在错误里明说"上一页已丢失，当前停在错误页" |
| 失败后立刻 `browser_open` 合法地址 | 应能恢复（当前可以，已实测：重新打开列表页正常） |
| 失败后 `browser_snapshot` | 不返回空树装作正常；要么报 `page_unavailable`，要么把"停在错误页"写进结果 |

## 3. 实现要点（调研过的落点）

- `client.js` 的 `Guest.mount()` 持有 `element`（`<webview>`）；打开走的是 `loadURL` / `open` 命令，失败时抛的是 `GUEST_VIEW_MANAGER_CALL` 的原始错误。
- 保存"最后一次成功地址"：在 `dom-ready` 事件里记 `element.getURL()`，导航失败时用 `element.loadURL(previous)` 回退（webview 上可用）。
- 错误转换：把 Electron 的 `ERR_*` 字符串映射成上表的 `stage`，并把 `previousUrl` 一并带回给工具层，由 `render` 说清"当前停在错误页 / 已回到 X"。
- 不做：自动重试同一 URL（T8 判据里"重试同一 URL 超过 2 次 = 判失败"）。

## 4. 验收

- [x] 打开 `https://10.255.255.1/`（必然超时）或上面那条 Bing 地址，报错含 `stage` 且面板回到失败前地址 —— 改测立即失败的两条（`http://127.0.0.1:1/` → `nav_blocked`、`https://no-such-host.invalid/` → `nav_dns`），都回退到 `previousUrl`
- [x] 失败后 `browser_snapshot` 返回的是"原页面"的树，而不是空树 —— 实测回到 `Example Domain`
- [x] 失败后 `browser_open` 正常地址可用（回归）—— 实测 `https://example.org/` 正常
- [x] 单测：错误分型映射（纯函数，不依赖网络）—— `plugin/test/navigation.test.mjs` 6 例，全量 150/150

## 5. 风险

| 风险 | 说明 |
|---|---|
| 回退本身失败 | 连 `about:blank` 都进不去时，如实说"面板不可用"，不要假装 |
| 与 `needs_human` 混淆 | 连接失败不是人机验证，不应报 `needs_human`（会触发接管流程） |
| 与浏览器面板重挂冲突 | 装包后首条命令超时的 flake（见 `reference/011` §4）会让"失败"更难分辨，错误里要带 `phase` |
---

## 6. 实现记录（2026-11-22，版本 1.3.8 → 1.3.9 装机验收）

状态：✅ 已完成。首版 1.3.8 装机后首条命令就暴露了 `landed.startsWith is not a function`——`<webview>.getURL()` 在本宿主里返回的不是字符串，1.3.9 补了 `Guest.address()`（接受字符串 / `{href}` / Promise）后通过。

### 6.1 落地形状

| 层 | 文件 | 做了什么 |
|---|---|---|
| 分类 | `plugin/navigation.js`（新） | `classifyNavigationFailure(raw)` → `{stage, explain, code, retryable}`，规则表覆盖 DNS / refused / reset / cert / timeout / offline / blocked / aborted，其余 `nav_unknown`；`chromeErrorCode()` 抓 `ERR_*`；证书、DNS、blocked 标 `retryable:false` |
| 文案 | 同上 | `navigationFailureText(classified, {url, previousUrl, restored})` → `nav_x: 解释 (ERR_XXX): url` + "went back to …" / "could not go back … error page" |
| 面板 | `plugin/client.js` | `CLIENT_REV 36→37`；模块级 `lastGoodUrls`（活在 guest 之外，扛页签重建）；`Guest.load()` 失败时回退到上一页并带 `navigation:{url,previousUrl,restored,raw}`；新增 `Guest.address()`；`Guest.errorPageFailure()` 在 `snapshot` / `act` 前拦住 `chrome-error://` 页面 |
| 宿主桥 | `plugin/bridge.js` | `/settle` 失败帧改走 `panelFailure(body)`，把 `navigation` 并进 `AgentBrowserError.details` |
| 工具层 | `plugin/tools.js` | 导出 `classifyOpenFailure(error, url)`；`browser_open` 捕获后重分类，message 带 stage，details 带 `stage/code/restored` |
| 错误码 | `plugin/errors.js` | `fromPanelMessage()` 先认客户端带来的稳定 `code:` 前缀（不再靠散文猜），`page_unavailable` → `navigation_failed` |

### 6.2 单测

`plugin/test/navigation.test.mjs`（新，6 例）：14 组 Electron 包装串 → stage；`ERR_*` 抓取与 `nav_*` 命名；证书不可重试 / reset 可重试；回退成功与失败两套文案；`classifyOpenFailure` 保留 code + stage/restored；非导航错误原样返回。全量 **150 / 150** 通过。

### 6.3 装机验收（1.3.9，GUI http://127.0.0.1:9529）

| 检查 | 结果 |
|---|---|
| 失败不丢现场 | `browser_open http://127.0.0.1:1/` → `navigation_failed: nav_blocked: … (ERR_UNSAFE_PORT)`. The panel went back to https://example.com/ ✅ |
| 失败后快照 | 紧接 `browser_snapshot` → `page "Example Domain" url=https://example.com/`，5 行正文，非空树 ✅ |
| DNS 失败 | `https://no-such-host.invalid/` → `navigation_failed: nav_dns: the host name could not be resolved (ERR_NAME_NOT_RESOLVED)`，同样回退 ✅ |
| 失败后可恢复 | 再 `browser_open https://example.org/` → `Opened … — Example Domain` ✅（未自动重试原 URL） |
| 客户端自动换新 | 装 1.3.8/1.3.9 后无需刷新页面，新 `CLIENT_REV` 立即生效（由 1.3.8 的 `landed` 报错反证） |

### 6.4 与原文偏差 / 残留

- 未做「自动重试同一 URL」——原文即禁止。
- `https://10.255.255.1/` 这条验收换成 `http://127.0.0.1:1/`（立即拒绝）与不存在的域名（立即 DNS 失败）：两者都在毫秒级复现，不用等超时；timeout 分支由单测覆盖。
- 回退目标只记"最后一次成功打开"的地址，不做多级历史；页内跳转（`did-navigate`）不算。
- `chrome-error://` 判定依赖 Electron 的 URL 形状，换了宿主实现要复核（风险已记入 §5）。

