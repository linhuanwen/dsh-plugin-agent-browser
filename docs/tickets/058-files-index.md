# TICKET-058 `browser_files`：下载与截图索引

- 状态：✅ 已实现并真机通过（2026-11-28，1.5.25）· 阶段 B2「可核对」
- 目标：第 19 个工具，把「刚才那张截图/下载存哪了」变成一次可过滤的列表查询
- 关联：SPEC-004 准入契约；TICKET-056 时间线；cases/032

## 1. 缺口

| 场景 | 现在怎么做 | 为什么疼 |
|---|---|---|
| 找十分钟前那张截图 | 翻聊天记录里的 `browser_screenshot` 回执 | 上下文压缩后回执没了，文件还在 `screenshots/` |
| 汇总「这次会话下载了哪些附件」 | 逐个回执抄路径 | 慢，且容易漏 |
| 确认下载目录里有什么 | 只能猜文件名 | 同名文件会被改成 `-1` 后缀，猜不准 |

时间线（TICKET-056）能回读最近 200 条动作，但它活在宿主进程里、重载即空，而且只记「动作」不记「文件」。文件是持久产物，应该能直接在磁盘上查。

## 2. 准入四问

| 问题 | 回答 |
|---|---|
| 它改变页面吗？ | 不。完全不经过面板与桥，只读工作区目录 |
| 失败了会留下半截状态吗？ | 不会。纯列目录 + stat |
| 需要人确认吗？ | 不需要。读动作 |
| 人工相位下能用吗？ | 能，而且**面板关着、DSH 重载后也能用**——与相位无关 |

## 3. 设计

### 3.1 工具 `browser_files`

```
browser_files({ kind?: "screenshot" | "download" | "all",
                since?: ISO 字符串或毫秒,
                match?: 文件名/路径子串,
                limit?: 20 })
```

- 目录：`<workspace>/screenshots/`（截图）与 `<workspace>/<downloads.dir>/`（下载，默认 `downloads/`，来自配置）。
- 每个条目：`{kind, name, path, bytes, at}`——`path` 是工作区相对、posix 风格（可直接交给其它工具/用户）。
- 排序：按 mtime 从新到旧；`total` 是过滤后的总数，`files` 最多 `limit` 条。
- `since` 接受 ISO 字符串或毫秒时间戳；非法值报 `since must be an ISO date or milliseconds`。
- 空目录不是错误：返回 `files: []` + 目录提示，让模型知道该用 `browser_screenshot` / `browser_download` 生成。
- 无新增错误码；不请求桥（`isConcurrencySafe: true`）。

实现位置：`plugin/tools.js` 的 `browserFilesTool(ctx, { downloadDir })`；helpers `filesLimit` / `parseSince` / `filesSizeText` / `filesDateText`；`createTools` 在时间线工具后注册。

### 3.2 渲染

```
3 file(s) in the workspace, newest first (2 screenshot(s), 1 download(s)).
* [screenshot] screenshots/list.png — 51.8 KB · 2026-11-28 08:40
* [download] downloads/regulation.pdf — 2.1 MB · 2026-11-28 08:31
```

## 4. 证据

- `plugin/test/files.test.mjs` **8/8**：默认列两类并按 mtime 倒序、`kind` 过滤、`match` 子串（大小写不敏感）、`since`（ISO 与毫秒、非法值）、`limit` 夹取与 `total` 口径、空/缺失目录、render 的 kind/大小/本地时间格式、工具元数据与 `isConcurrencySafe`。
- 全量 **421 → 429**；check-docs 七项全绿（配置 23、**工具 19**、YAML 14、decisions 10、B11、file:line 12、打包清单 8 inject + 15 宿主 + dist files）。
- 真机（cases/032，F1–F8）：37 张历史截图按时间列出并正确截断；`kind:"download"` 给空提示；`match`/`since` 过滤正确；面板关闭后仍立即返回（纯读）。

### 4.1 真实回执

```
37 file(s) in the workspace, newest first (37 screenshot(s), 0 download(s)).
* [screenshot] screenshots/ticket058-files-shot.png — 46.5 KB · 2026-11-28 08:52
...
… 17 older file(s) not shown; raise limit (up to 100).
```

```
1 file(s) in the workspace, newest first (1 screenshot(s), 0 download(s)).
* [screenshot] screenshots/ticket058-files-shot.png — 46.5 KB · 2026-11-28 08:52
```

**下载桶真机未取到**：`browser_download` 对 `127.0.0.1` 的地址在 validate 阶段被拒（`refusing to download from 127.0.0.1: that is this machine, not the web`，设计内）；外网下载需要面板可见 + 人点确认，当时人不在了。下载桶由单测覆盖，边界写在 cases/032。

### 4.2 验收期修掉的问题

1. description 里的嵌套反引号把模板字符串拆坏，模块加载即抛 `workspace is not defined`；
2. 空目录提示的实际文案是 `screenshots / downloads`（不是 `screenshots/ / downloads/`），测试断言跟随真实文案。

## 5. 不做

- 不删除、不移动、不重命名文件（删除是不可逆动作，另开能力再做）；
- 不做内容预览/OCR/缩略图（图片交给 read/vision 工具）；
- 不索引工作区里其它目录（只认截图与下载两个产出目录）；
- 不持久化索引（每次列目录，永远与磁盘一致）。

## 6. 验收清单

- [x] 单测全过（429/429）、check-docs 七项全绿
- [x] 1.5.25 打包/装机（384,156 B / sha256 `c347986c9624b14157a0b1a01a5d59bbff378446e17a256c756854b8925442b7`）
- [x] 真机：截图桶列表、过滤、面板关闭后可用
- [x] 下载桶：单测覆盖（真机受 loopback 下载策略限制，见 §4.1）
- [x] `docs/cases/032`、release notes 1.5.25、PROGRESS、docs 索引、两份 README
