# TICKET-034 大图回执丢失：截图在面板里成功取到，但回执没回来，工具挂到 60 s 超时

- **状态**：🔧 已修于源码（2026-11-23 16:3x，`main` 分支；1.4.13 冻结点不受影响）——待发 1.4.14 后在装机版上做实地复验
- **优先级**：P1（安全语义未破、页面未丢；代价是每次 60 s 空等 + 工具报 `bridge_timeout`，模型会误判"面板没开"）
- **来源**：2026-11-23 15:2x 案例复跑（V 集抽跑，`reference/010-validation-cases.md` 坑 5）—— `https://opentopomap.org/#map=10/23.13/113.26`
- **相关**：TICKET-013（失败导航回退）、TICKET-028（截图可见性 / 取帧重试预算）、`plugin/bridge.js`、`plugin/client/…` 的 screenshot 回执路径
- **对应验收**：`reference/010-validation-cases.md` V10、`reference/014-practical-cases.md` §7.6 S6

## 1. 现象

`browser_open('https://opentopomap.org/#map=10/23.13/113.26')` 之后立刻 `browser_screenshot({mode:'viewport'})`，**连续两次**都相同：

```
Error: bridge_timeout: browser panel did not answer c26 (screenshot) within 60000ms.
Open the right sidebar browser tab for this session and retry. (screenshot step: command)
```

同页其它工具有求必应：`browser_snapshot({includeImage:false})` → `gen 1 · 12 refs · 60 nodes walked · 1ms`；`browser_eval` 正常。**面板是开着的**（错误文案里的"Open the right sidebar browser tab"是误导——它把任何 `bridge_timeout` 都往这句上引导）。

## 2. 桥日志（`/dsh-agent-browser/logs`，tail 60）

```
screenshot start {mode:viewport, w:767, h:863, dpr:1.5, vis:visible}
capture start {css:767}
capture got image {device:1151, height:1294}
capture done {sent:1151, chars:4239798}      ← 距 start 约 197 ms
（此后无 settled / 无 error / 无任何帧，客户端等到 60 s 超时）
```

对照成功样本（同一面板、同一会话）：

| 页面 | `capture done` 的 `chars` | 结果 |
|---|---|---|
| `demo/index.html` | 62,358 | 秒回 |
| `map.baidu.com`（1151×1294） | 2,772,754 | 秒回 |
| `opentopomap.org`（1151×1294） | **4,239,798** | 无回执 → 60 s 超时 |

⇒ 与 TICKET-028 的坑 1（`css: 0`、`capturePage()` 抛 `UnknownVizError`、~650 ms 放弃）**不是同一个故障**：此处取图成功，失败在"回执/传输"这一段；区别还在超时形态（60 s 静默 vs 0.65 s 报错）。

## 3. 原因（已验证）

**不是通道分片缺陷，而是一条硬编码的请求体上限。**

- 回执走 `POST /dsh-agent-browser/settle`，body 是 `JSON.stringify({id, ok, result:{dataUrl}})`；opentopomap 那张 dataUrl 4,239,798 chars ⇒ body ≈ **4,239,848 B**。
- `plugin/bridge.js` 的 `readJson(req)` 原本写着 `if (size > 4 * 1024 * 1024) throw new Error('body too large')`（4 MiB = **4,194,304 B**）。超限后 `#handle` 的 `.catch` 回 500，面板的 `settle()` 抛错、命令永不 settle，工具只能等满自己的 60,000 ms 再报 `bridge_timeout`。
- 打点探针 `tmp/settle-size-probe.mjs`（HMAC cookie → discovery → POST `/settle` 合成 body）逐档试探，阈值正好落在 4,194,304 B：

| body 字节 | 结果 |
|---|---|
| 62,358 / 2,772,754 / 4,180,000 / 4,190,000 | 200 |
| **4,194,050** | **200** |
| **4,239,848**（本次事故） | **500 `{"ok":false,"error":"body too large"}`** |
| 8,000,000 | 500 同款 |

⇒ 4 MiB 恰好卡在"百度地图能过、opentopomap 过不去"之间，这也解释了为什么两个成功样本一直没暴露问题。

## 4. 修法（已实现）

| # | 方向 | 落地情况 |
|---|---|---|
| 1 | 放宽上限 | ✅ `plugin/bridge.js` 新增 `export const MAX_BODY_BYTES = 32 * 1024 * 1024`，`readJson` 按它判断 |
| 2 | 超限要可读 | ✅ 新增 `class BodyTooLarge` + `readJsonOrRefuse(req, res)`：超限回 **413** 且 body 带 `{error:{code:'budget_exceeded', message}, limit}`，`/log`、`/phase`、`/settle` 三处都改走它（原先只会落进 500 兜底） |
| 3 | 客户端预检 + 必 settle | ✅ `plugin/client.js` 新增 `SETTLE_BUDGET = 24 * 1024 * 1024`：超预算直接 settle 成 `budget_exceeded: …` 并带字符数，不再发 24 MB 级 body；POST 失败且带 payload 时**再重投一次纯错误 settle**，保证命令一定被 settle，最坏情况秒级报错而不是 60 s 空等 |
| 4 | 文案 | ✅ 错误消息写明"the panel produced N characters … Retake a smaller picture (mode \"viewport\", or a lower maxHeight) or read the page with browser_snapshot."，不再让模型以为面板没开 |

未新增错误码：沿用既有的 `budget_exceeded`（`retryable: true`），避免动 `plugin/errors.js` 的 13 码契约与文档表格。

## 5. 验收状态

1. ⬜ 真实站点 ≤10 s 返回 —— 需 1.4.14 装机后重跑 `opentopomap.org`（本轮只有源码级证据）
2. ⬜ 同页连截 3 次不累积 —— 同上
3. ⬜ `demo` / 百度地图无回归 —— 同上（单测层面已覆盖 4.24 M 字符回执）
4. ✅ `plugin/test/bridge.test.mjs` 新增两条：**4.24 M 字符 settle 被接受**（端到端 `start()` → `request()` → `/pending` 取 id → `/settle` → 断言 200 且 payload 完整）与**超过 `MAX_BODY_BYTES` 回 413/`budget_exceeded`**；全量 `node --test plugin/test/*.test.mjs` 180/180 通过

## 6. 现状

- **源码已修**（`main`），1.4.13 冻结点（tgz `128,654 B` / `16cac4ff…`）未变，首发结论不受影响。
- 已同步 `reference/010-validation-cases.md`（V10 矩阵行 + 坑 5 根因）与 `docs/launch-report-1.4.13.md` §6 第 7 条（由"未修"改为"源码已修、待 1.4.14 复验"）。
- 发布说明里保留"已知限制"一句，直到 1.4.14 实地复验通过。
