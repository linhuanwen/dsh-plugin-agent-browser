# CASE-032：`browser_files` 文件索引验收（1.5.25）

- 环境：DSH 桌面端 1.5.25 已装机；工作区 `D:\Vibe coding\32 deepseek harness cebiankuang`；夹具静态端口 `2397`。
- 结论：列表、过滤、排序、截断、空目录提示、纯读零审批全部通过；**下载桶真机未取到**（见「验收期发现」第 3 条，下载被 loopback 策略拒绝、外网下载又需要人点确认），下载桶由 `files.test.mjs` 覆盖。

## 1. 结论表

| # | 场景 | 结果 |
|---|---|---|
| F1 | `browser_files {}` 列全部 | ✅ 说出 `37 file(s) … (37 screenshot(s), 0 download(s))`，最新在前，带大小与时间，截断行 `… 17 older file(s) not shown; raise limit (up to 100).` |
| F2 | `kind:"download"` | ✅ 只查下载桶：`No files under downloads yet (nothing matched the filter).` + 提示该用哪个工具生成 |
| F3 | `match:"ticket055"` + `limit:5` | ✅ 命中 5 条 1.5.22 验收截图，路径大小写不敏感 |
| F4 | `since:"2026-11-28T00:00:00Z"` | ✅ 只留当天那张 `ticket058-files-shot.png` |
| F5 | 单测 `plugin/test/files.test.mjs` | ✅ 8/8：两类混排+mtime 排序、kind、match、since（ISO/毫秒/非法）、limit 截断与 `total` 口径、空目录、render 格式、工具元数据 |
| F6 | 纯读/零审批 | ✅ 调用无确认条、无等待；工具不依赖 `bridge`（构造参数只有 `ctx` 与下载目录名） |
| F7 | 面板关着 | ✅ 结束时面板已不可见（后续 `browser_download` 报 `approval_required: 面板看不到…`），`browser_files` 仍立即返回 |
| F8 | 历史文件 | ✅ 37 张里包含 11-23 的 1.4.x 验收截图：读的是磁盘而非进程内索引 |

## 2. 回执原文

F1：

```
37 file(s) in the workspace, newest first (37 screenshot(s), 0 download(s)).
* [screenshot] screenshots/ticket058-files-shot.png — 46.5 KB · 2026-11-28 08:52
* [screenshot] screenshots/ticket056-final-shot.png — 52.7 KB · 2026-11-27 22:44
* [screenshot] screenshots/ticket056-console-shot.png — 53.5 KB · 2026-11-27 22:38
* [screenshot] screenshots/ticket056-evidence-shot.png — 53.5 KB · 2026-11-27 22:35
* [screenshot] screenshots/ticket055-1522-click-mark.png — 55.3 KB · 2026-11-27 22:06
...
… 17 older file(s) not shown; raise limit (up to 100).
```

F2：

```
No files under downloads yet (nothing matched the filter). browser_screenshot writes screenshots/, browser_download writes downloads/.
```

F4：

```
1 file(s) in the workspace, newest first (1 screenshot(s), 0 download(s)).
* [screenshot] screenshots/ticket058-files-shot.png — 46.5 KB · 2026-11-28 08:52
```

## 3. 验收期发现

1. **`description` 里的嵌套反引号**：首版把 `` `<workspace>/${downloadDir}/ ` `` 写成模板字符串嵌模板字符串，解析后成了「`workspace` 未定义」，工具一加载就抛错。改为普通字符串拼接（`'… <workspace>/' + downloadDir + '/`' 等价写法）。
2. **渲染文案与测试断言不一致**：`dirs.join(' / ')` 渲染为 `screenshots / downloads`（不带斜杠），两处断言需要跟随真实文案。
3. **下载桶真机证据未取到**：`browser_download {url:"http://127.0.0.1:2397/t/demo/console.html"}` 被下载策略在 validate 阶段拒绝——`refusing to download from 127.0.0.1: that is this machine, not the web`（loopback 不算「网上的文件」，属设计内）；改试 `https://example.com/` 又因为面板已隐藏而 `approval_timeout`。因此下载桶由单测（写入 `downloads/*.pdf`、`kind:"download"`、`match`）覆盖，真机只验证了截图桶。**边界写明**：将来要补下载桶真机，需要面板可见 + 人点「允许一次」+ 外网地址。
4. **`browser_download` 的 validate 拒绝会以「工具调用成功」入时间线**：回执是 `{download_failed:{code:'download_rejected',stage:'validate'}}`（返回值而非抛错），TICKET-056 的记录器按「调用完成」记 `ok`。属已有语义，记在这里备查，不在本单修。

## 4. 复跑

1. `browser_screenshot {name:"ticket058-files-shot.png", mode:"viewport"}`；
2. `browser_files {}` → 应看到新文件在最前、total 增加；
3. `browser_files {kind:"download"}` → 显示下载桶状态（无则给出提示）；
4. `browser_files {match:"ticket058"}` → 只留本次截图；
5. `node --test plugin/test/files.test.mjs` → 8/8。

## 5. 已知边界

- 只索引 `<workspace>/screenshots/` 与 `<workspace>/<downloads.dir>/` 两个目录，不递归、不看工作区其它位置；
- 只列普通文件，不列目录；不读内容、不做缩略图；
- `since` 用文件 mtime（复制/解压可能保留旧 mtime）；
- 同名文件的去重后缀（`-1`）由写入方决定，索引只如实反映磁盘上的名字；
- 不删除/移动/重命名——删除是不可逆动作，另开能力；
- 列表是「当时磁盘」的快照，不缓存。
