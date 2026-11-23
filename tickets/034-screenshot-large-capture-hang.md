# TICKET-034 大图回执丢失：截图在面板里成功取到，但回执没回来，工具挂到 60 s 超时

- **状态**：📋 待修（P1；不阻塞首发，但"截图看起来卡死 60 s"在真实站点可复现，属体验级故障）
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

## 3. 原因（推断，未验证）

1. 回执载荷是 base64/字符数组（`chars` 计数即载荷字符数），4.24 MB 量级可能超过 host ↔ client 通道单帧上限或触发分片逻辑缺陷；
2. `screenshot` 的回执没有超时前的分片重组保障，也没有"取图成功但回执失败"的中间态错误码 ⇒ 客户端只能等 60 s；
3. `bridge.request` 的 timeout 分支只抛 `bridge_timeout`，不携带 `capture done` 已发生的细节，模型因此无法判断"图已生成"，只能盲猜。

## 4. 修法方向（未实现）

| # | 方向 | 说明 |
|---|---|---|
| 1 | 载荷降级 | 超过阈值（如 2 MB chars）自动改走"落盘 + 只回路径/缩略图"，避免大载荷过桥 |
| 2 | 分片回执 | 大回执按 512 KB 分片，带序号与总片数，host 侧重组；缺片即报可读错误 |
| 3 | 中间态错误码 | 新增 `capture_delivered`（图已生成、回执丢失）或让 `bridge_timeout` 的 details 带上 `stage:'delivery'` 与 `bytes`，错误文案改成"截图已生成但回执超时，可重试或改用 viewport/降低质量" |
| 4 | 不误导的文案 | `bridge_timeout` 不再无脑提示"打开右侧栏页签"，改为按 details 分支 |

## 5. 验收（写好后）

1. 打开 `https://opentopomap.org/#map=10/23.13/113.26`，`browser_screenshot({mode:'viewport'})` 在 ≤10 s 内返回（成功保存，或返回带 `bytes` 的明确错误）；
2. 同一页连续截图 3 次不累积超时；
3. `demo` / 百度地图两个成功样本回执字节数与修复前一致（无回归）；
4. `plugin/test` 增补一条"大载荷回执"单测（可用合成 4 MB buffer，不必依赖真实站点）。

## 6. 现状（1.4.13）

- 未修；规避方式：该站只用 `browser_snapshot`，不截图。
- 已写入 `reference/010-validation-cases.md`（V10 坑 5）与 `reference/014-practical-cases.md` §7.6（S6 第二个故障的实测来源）。
- 不阻塞 Windows 首发：首发站点清单里没有需要 4 MB 级截图的页面；但应在发布说明"已知限制"里补一句。
