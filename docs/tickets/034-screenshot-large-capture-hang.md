# TICKET-034 大图回执丢失：截图在面板里成功取到，但回执没回来，工具挂到 60 s 超时

- **状态**：✅ 已修并验证（2026-11-23 16:5x，1.4.14 装机；四条验收全过，现场记录见 §5）
- **优先级**：P1（安全语义未破、页面未丢；代价是每次 60 s 空等 + 工具报 `bridge_timeout`，模型会误判"面板没开"）
- **来源**：2026-11-23 15:2x 案例复跑（V 集抽跑，`docs/cases/010-validation-cases.md` 坑 5）—— `https://opentopomap.org/#map=10/23.13/113.26`
- **相关**：TICKET-013（失败导航回退）、TICKET-028（截图可见性 / 取帧重试预算）、`plugin/bridge.js`、`plugin/client/…` 的 screenshot 回执路径
- **对应验收**：`docs/cases/010-validation-cases.md` V10、`docs/cases/014-practical-cases.md` §7.6 S6

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
- 打点探针 `tools/case-run/settle-size-probe.mjs`（HMAC cookie → discovery → POST `/settle` 合成 body）逐档试探，阈值正好落在 4,194,304 B：

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

## 5. 验收状态（1.4.14 实测，2026-11-23 16:5x，面板 429×863 @ dpr 1.5）

装包后**未重启**就已生效（`install_bundle` 返回 `application: "applied"`，宿主半热应用）：对同一桥打点，34,000,000 字符的 settle 现在回 **413 `{"code":"budget_exceeded","message":"the reply was 33619648 bytes, over the 33554432-byte bridge limit"}`** —— 上限确实从 4,194,304 抬到了 33,554,432。

1. ✅ **真实站点 ≤10 s 返回**：`opentopomap.org` 连拍 3 次全部成功，桥日志逐帧计时 **197 / 188 / 201 ms**（`capture done` → `settled ok:true`），三张 **1,793,126 B 字节完全相同**（sha256 `b2d35dbf…`）。
2. ✅ **不累积、可重复**：同上三次；另外整页拼接也一次过（见下）。
3. ✅ **无回归**：`demo/index.html` 截图 45.7 KB（与修复前 62,358 chars 的回执一致）；百度地图在 429 px 面板下 740.2 KB 正常保存（此前 767 px 时是 2,079,549 B，尺寸差异只因面板宽度变了）。
4. ✅ **单测**：`plugin/test/bridge.test.mjs` 两条端到端用例（4.24 M 字符 settle 被接受 / 超 `MAX_BODY_BYTES` 回 413 且 `code:'budget_exceeded'`），全量 `node --test plugin/test/*.test.mjs` → **180/180**。

**跨过旧上限的关键证据**：`https://zh.wikipedia.org/wiki/杭州市` 整页截图（`mode:'full'`）——13 帧拼接、644×14,994 px、PNG **3,173,820 B** ⇒ base64 dataUrl ≈ **4,231,760 字符 / body ≈ 4,231,810 B**，**刚好越过旧的 4,194,304 B 上限**；本次 `screenshot done` → `settled ok:true` 共 **2,826 ms**，产物 `screenshots/v10-fullpage-large-payload-1.4.14.png`（sha256 `25a0ba1b98c2320ac52e86851e190cb69cf8741c415e46732009f298cf3abb21`）。这就是修复前必然挂 60 s 的那一类载荷。

## 6. 现状

- 1.4.14 已发布并装进 desktop profile（`node_modules` 版本 1.4.14，`MAX_BODY_BYTES` 在位）；1.4.13 冻结包仍在库里，首发报告结论不受影响。
- 已同步 `docs/cases/010-validation-cases.md`（V10 矩阵行 + 坑 5）、`docs/cases/014-practical-cases.md` §7.6、`docs/release/launch-report-1.4.13.md` §6 第 7 条与 `PROGRESS.md` 的 dist 清单。
- 未新增错误码：沿用 `budget_exceeded`（13 码契约不变）。
