# 案例 035：批量下载（`browser_download` 的 `urls` 形状）

> 版本 1.5.27（TICKET-061）· 2026-11-28 · 外网 URL 直接从宿主 fetch（不经页面 Cookie）

## 1. 结论

| # | 场景 | 结果 |
| --- | --- | --- |
| D1 | 两个 URL 一次确认 | 确认条文案带数量：「从 example.com 下载 2 个文件」 |
| D2 | 一个成功、一个 404 | 回执 `Saved 1 of 2 file(s):`，成功项给 path/bytes/sha256，失败项单列原因 |
| D3 | 逐项结果 | 成功文件落到 `downloads/`，`browser_files { kind: "download" }` 能列出来 |
| D4 | 整批里混入本机地址 | **整批拒绝、不弹确认、零传输**；回执明说「another URL failed validation」与哪个 URL 不合格 |
| D5 | 全失败 | `download_failed` + `effect: "none"`，渲染抬头改成「Nothing was downloaded: the batch was refused before any transfer」 |

## 2. 回执原文

确认条之前的超时（说明数量已带进文案，且什么都没发）：

```text
Error: approval_timeout: 用户 30000ms 内没有确认从 example.com 下载 2 个文件。
The user did not answer the permission prompt in time; nothing was sent to the page.
```

部分成功：

```text
browser_download { urls: ["https://example.com/", "https://example.com/definitely-not-a-real-file-xyz"] }

→ Saved 1 of 2 file(s):
  * downloads/download-1795849460075 (577 bytes, sha256 25ddf2c8…)

  Failed:
  * https://example.com/definitely-not-a-real-file-xyz — http: the server answered 404 Not Found

  Those files were not saved; say so instead of describing them.
```

`browser_files { kind: "download" }`：

```text
1 file(s) in the workspace, newest first (0 screenshot(s), 1 download(s)).
* [download] downloads/download-1795849460075 — 577 B · 2026-11-28 15:04
```

整批校验失败（无确认条）：

```text
browser_download { urls: ["https://example.com/", "http://127.0.0.1:1/x"] }

→ Nothing was downloaded: the batch was refused before any transfer (2 url(s)).

  Failed:
  * https://example.com/ — validate: not attempted: another URL in this batch failed validation, so the whole batch was refused
  * http://127.0.0.1:1/x — validate: refusing to download from 127.0.0.1: that is this machine, not the web
```

## 3. 验收期发现

1. **「数量」必须进审批文案**：第一次调用时确认条写的是「下载 2 个文件」，用户没看面板超时，一条都没发——这条超时本身就是「先审批后 fetch」的证据。
2. **整批失败不能把好 URL 也怪罪**：初版把同一条校验错误套到每个 URL 上，回执看起来像「example.com 也是本机地址」。改成只有不合格项带自己的原因，其余标 `not attempted`。
3. **「Saved 0 of 2」会误导**：整批在传输前被拒时，抬头改成「Nothing was downloaded: …」，避免暗示尝试过。
4. **下载落盘与索引闭环**：成功文件能在 `browser_files` 里查到，`downloads/` 就是「下载了什么」的唯一事实源。

## 4. 复跑

```text
browser_download { urls: ["https://example.com/", "https://example.com/definitely-not-a-real-file-xyz"] }
browser_files { kind: "download" }
browser_download { urls: ["https://example.com/", "http://127.0.0.1:1/x"] }   # 应整批拒绝、无确认条
```

## 5. 已知边界

- 串行下载（≤10 个），不做并发；
- 不带页面 Cookie（宿主 fetch），需要登录态的下载不在范围内（TICKET-063 探针）；
- 逐项执行：开跑后个别失败不回滚已完成的文件，回执如实列出；
- 本机/内网地址一律拒绝（`127.0.0.1`、`localhost` 等）；
- 页面内点链接触发的下载仍被宿主 `will-download` 硬拦，不在本工具范围。
