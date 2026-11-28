# TICKET-061 批量下载（`browser_download` 的 `urls` 形状）

- **状态**：✅ 已实现并真机通过（2026-11-28，1.5.27）· 阶段 B2「可核对」的批量版
- **来源**：用户 m10790「快照遮挡就暂时不做了，然后按照顺序开始吧」——顺序里的第二项
- **相关**：TICKET-023（单 URL 下载）、TICKET-058（`browser_files` 索引）、TICKET-060（批量上传）

## 1. 缺口

报告下载常常一次要点好几份（月度报表、附件图片、对账单）：

1. 现在一次一个 URL、一次一条确认，用户要连点好几下；
2. agent 逐个调用时，中途失败容易说不清「哪些下到了、哪些没有」；
3. 逐个调用时，对话记录里散落多条 `download_failed`，`browser_files` 里也看不出这是一批。

## 2. 准入四问

| 问题 | 回答 |
| --- | --- |
| 是读还是写？ | 写（会访问站点、落盘文件），一次确认覆盖整批 |
| 是否可逆？ | 文件可删，但「已经发出请求」不可逆——所以整批 URL 在确认**之前**做协议/本机地址校验 |
| 失败能否确定「没执行」？ | 整批校验失败时能（`effect: none`）；开跑后是逐项成败，失败会明确列出，不回滚已完成的项 |
| 人工相位下怎么办？ | 不碰面板，`needs_human` / `taken_over` 不影响；面板看不见时确认条会失败并说「nothing was sent」 |

## 3. 设计

### 3.1 工具形状

```jsonc
// 单文件（旧形状，完全不变）
{ "url": "https://example.com/a.pdf", "filename": "a.pdf" }

// 批量（新形状，最多 10 个）
{ "urls": [
    { "url": "https://example.com/a.pdf", "filename": "a.pdf" },
    "https://example.com/b.pdf"
] }
```

- 每项可以是 URL 字符串，或 `{ url, filename?, referer? }`；
- 整批先过 `assertDownloadable`（绝对 http(s)、非本机地址），任何一条不过 → 整批不执行、不弹确认条；
- 通过后一次 `requestApproval`（`actionClass: 'download'`，`target.count` 让确认条能说「下载 3 个文件」）；
- 逐项 `downloadTo`（宿主侧 fetch，不带页面 Cookie）；
- 结果：`files[]`（成功项，含 path/bytes/sha256/mime/finalUrl/url）与 `failures[]`（失败项，含 url/code/stage/reason）；全失败时返回 `download_failed` 且 `effect: 'none'`。

### 3.2 为什么不做「并发拉取」

`downloadTo` 本身可并发，但并发会让「第几项失败」的语义变差，也会同时占用多个连接；先串行、先把逐项结果做诚实，等 SPEC-004 的并行能力单独立项时再说。

### 3.3 审批文案

`approvals.summarize('download', …)` 在 `target.count > 1` 时说「从 site 下载 N 个文件」，单文件文案不变。

## 4. 证据

- 新增 `plugin/test/download.test.mjs` 8 例：单 URL 旧形状不变；两个 URL 一次确认（`target.count === 2`）、两个文件都列出；一个失败一个成功 → `files` 1 / `failures` 1 / render 说明；全失败 → `download_failed` + `effect: none`；坏 URL 整批拒绝（零确认零 fetch）；本机地址整批拒绝；策略拒绝逐项标注 `stage: 'policy'`；数量/形状校验。
- 全量 453/453；`node tools/check-docs.mjs` 七项全绿。
- 真机：`docs/cases/035-batch-download-cases.md`。

## 4.1 真机证据（1.5.27）

- 确认条带数量：`browser_download { urls: ["https://example.com/", "https://example.com/definitely-not-a-real-file-xyz"] }` 首次因无人确认超时 → `approval_timeout: 用户 30000ms 内没有确认从 example.com 下载 2 个文件。…nothing was sent`；
- 用户盯面板后重发 → `Saved 1 of 2 file(s):` + `downloads/download-1795849460075 (577 bytes, sha256 25ddf2c8…)`，失败项单列 `http: the server answered 404 Not Found`；
- `browser_files { kind: "download" }` → `1 file(s) in the workspace … [download] downloads/download-1795849460075 — 577 B`；
- 整批混入本机地址 → `Nothing was downloaded: the batch was refused before any transfer (2 url(s)).`，无确认条、零传输。

## 5. 不做

- 并发下载；
- 带页面 Cookie 的下载（单独探针，TICKET-063）；
- 页面内点链接触发下载（宿主 `will-download` 硬拦，见决策 005）；
- 下载后的自动解压/预览。

## 6. 验收清单

- [x] 单 URL 旧形状不回归
- [x] 批量一次确认、逐项结果、失败不影响成功项
- [x] 整批校验在确认条之前
- [x] 数量上限与形状校验有测试
- [x] 全量测试 + 文档门禁
- [x] 真机：两个 URL 一次确认、一份成功一份 404、`browser_files` 能看到成功那份
