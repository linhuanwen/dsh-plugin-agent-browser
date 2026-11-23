# TICKET-008：文件下载通道（`browser_download`）

- 状态: ✅ **已完成并验收**（2026-11-20；单测 18/18 绿，真站 PDF/DOC 已落盘并通过 `Get-FileHash` 复核；`1.0.5` 已装进 profile，桥接日志 `host half applied (rev 8)`）
- 优先级: **P0**（T4 / T5 阻塞在这一条，A14 无法验收）
- 关联 Spec: §5 工具契约、§10 **A14**
- 关联决策: `decisions/003-download-newwindow-and-task-cases.md` D13
- 依赖: TICKET-002（host 工具骨架）、TICKET-006（workspace root 概念）
- 改动目录: `dist\dsh-plugin-agent-browser\`（**唯一真包源**；`plugin/` 没有 package.json）

## 目标

让 agent 能把网页上的附件（`.pdf` / `.doc` / `.docx` / `.xls` / `.zip`）真正**下载到工作区**，并拿到可复核的路径与哈希；失败时给出结构化原因，**绝不**用页面正文摘要冒充附件内容。

## 工具契约

```ts
browser_download({
  url: string,           // 绝对 http(s) URL，或页面内相对 href（用当前视图 URL 解析）
  filename?: string,     // 可选，仅决定落盘名；不得含路径分隔符
  referer?: string,      // 可选，部分站点要求 Referer 才给文件
  via?: 'host' | 'page'  // 默认 'host'；'page' = 走 guest 的 session（保 Cookie），v1.1
})
```

**成功** → `{ ok: true, path, bytes, sha256, mime, finalUrl }`（`path` 为工作区相对路径，如 `downloads/gongsi-dengji-guanli-tiaoli.pdf`）

**失败** → 结构化错误，`stage` 区分归因：

| stage | 触发 | 文案要点 |
|---|---|---|
| `validate` | 非 http(s) / 指向 DSH 自身地址 / 文件名含穿越 | 明确说被拒原因（对齐 A10） |
| `connect` | DNS / TLS / 连接超时 10 s | 说清是网络，不是"文件不存在" |
| `http` | 4xx / 5xx | 带上状态码与 `finalUrl`（可能是 WAF 页） |
| `too_large` | > 50 MiB | 报出实际大小 |
| `write` | 磁盘/权限 | 报路径 |

## 实现要点（落点已经核过）

1. **新文件** `dist/dsh-plugin-agent-browser/downloads.js`：纯函数 + 一个 `downloadTo(root, opts)`。
   - `sanitizeFilename(name)`：去掉 `\/:*?"<>|` 与控制字符，`..` 直接拒。
   - `pickFilename(url, disposition, fallbackTs)`：`Content-Disposition` → URL basename → `download-<ts>`；重名追加 `-1`、`-2`（**绝不覆盖**）。
   - `downloadTo` 内部：`fetch` → 检查 `content-type`/`content-length` → `arrayBuffer()`（超限早退）→ `mkdir -p downloads/` → 写盘 → `sha256`。
   - 写入方向自建校验：目标必须是 `resolve(root,'downloads')` 的子路径（`static.js:resolveWithin` 只覆盖**读**方向，别复用成万能钥匙）。
2. **注册工具** `dist/dsh-plugin-agent-browser/tools.js`：照现有 6 个工具的 schema 风格加第 7 个；描述里必须写死一句"**未下载成功时不得描述文件内容**"。
3. **工作区 root**：与 `browser_open({path})` 用同一个 root 来源（现在由工具上下文给），不要新开一套。
4. **单测** `plugin/test/downloads.test.mjs`（照同目录 `static.test.mjs` 的 14 例风格；`test/` 不进包，`package.json` 的 `files` 字段不含它）：文件名清洗、重名递增、超限拒绝、非 http(s) 拒绝、`downloads/` 逃逸拒绝、sha256 稳定性。
5. **元数据同步**：包内 `README.md`、`docs/DETAIL.md`、`locale/*.json` 里"六个工具"的说法要改成七个。

## 实现记录（2026-11-20）

改动文件（`plugin/` 与 `dist/` 同步，`tools/pack.mjs` 的 COPY 清单已加 `downloads.js`）：

| 文件 | 改动 |
|---|---|
| `downloads.js`（新，15,619 B） | `sanitizeFilename` / `filenameFromDisposition` / `pickFilename` / `ensureDownloadsDir` / `resolveTarget` / `reserveTarget` / `assertDownloadable` / `readCapped` / `sha256` / `downloadTo`，全部导出便于单测 |
| `tools.js` | 加 `browserDownloadTool(ctx)`（第 7 个工具），`createTools` 追加；`DownloadError` 转成 `download_failed {stage, reason, url}` 返回值（不抛错，卡片仍可渲染） |
| `test/downloads.test.mjs`（新） | 18 例：命名/清洗/`filename*` 优先级/百分号编码解码/回退/穿越拒绝/`file:` 拒绝/回环拒绝/不覆盖/超限/404/HTML 冒充 PDF/连接失败 |
| `index.js` | `HOST_REV` 6 → 7（1.0.4）→ 8（1.0.5，`downloads.js` 改动也算 host 半） |
| `package.json` / `locale/*.json` / `README.md` | `1.0.5`、`files` 加 `downloads.js`、"六个工具"→"七个工具"、描述补 `browser_download` |

**实测（不经过面板，直接调工具对象的 `execute`）**：

```
tools: browser_open, browser_snapshot, browser_click, browser_type, browser_press, browser_eval, browser_download
result: {"path":"downloads/dummy.pdf","bytes":13264,
         "sha256":"3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4",
         "mime":"application/pdf","finalUrl":"https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"}
404:  {"download_failed":{"stage":"http","reason":"the server answered 404 Not Found", ...}}
file: {"download_failed":{"stage":"validate","reason":"only http(s) URLs can be downloaded, got file:"}}
```

`dummy.pdf` 的 sha256 与公开值一致（`3df79d34…6adb4`），说明字节没有被动过。

**两个实现期发现**：① `w3.org/TR/PNG/` 会 301 到小写 `TR/png/` 然后 404——`finalUrl` 里能直接看出来，这就是为什么失败结果必须带 `finalUrl`；② `pickFilename` 遇到 `…/download?id=7` 这种取不出扩展名的 URL，会先按 mime 补 `.pdf`（得到 `download.pdf`），只有连 basename 都没有（`https://example.com/`）才退回 `download-<ts>.pdf`。

### 真站验收 + 第三个发现（1.0.5 的由来）

用 T4 的真实附件（市场监管总局《公平竞争审查条例实施办法》，`https://www.samr.gov.cn/cms_files/filemanager/…/attach/202610/…pdf?fileName=…`）跑 `browser_download`：

```
1.0.4: Saved downloads/%E5%85%AC%E5%B9%B3%E7%AB%9E%E4%BA%89…%E5%8A%9E%E6%B3%95.pdf (1,492,642 bytes)
1.0.5: Saved downloads/公平竞争审查条例实施办法.pdf                      (1,492,642 bytes, sha256 548f8f60…380f)
1.0.5: Saved downloads/公平竞争审查条例实施办法.doc                      (103,936 bytes, sha256 efa9b8d2…571d)
1.0.5: 再下一次同一 PDF → downloads/公平竞争审查条例实施办法-1.pdf（未覆盖原件）
```

**发现③（已修，1.0.5）**：该站返回 `Content-Disposition: attachment;filename=%E5%85%AC…pdf`——用百分号编码塞中文名，**不是** RFC 5987 的 `filename*=UTF-8''` 形式。1.0.4 的 `filenameFromDisposition` 只对 `filename*` 解码，`filename=` 原样返回，于是落盘成一个 80 多个字符的 `%E5%85%AC…` 乱码名（`ls` 里还能看见）。浏览器会解码它，所以工具也必须解。修法：新增内部 `percentDecode()`（无 `%` 直接返回；`decodeURIComponent` 失败则原样保留，这样 `100%.pdf` 这类真名字不会被吃掉），只作用于 `filename=` 分支。

旁证：`.doc` 文件头 `D0 CF 11 E0 A1 B1 1A E1`（OLE2）✓、`.pdf` 头 `%PDF-` ✓ 且有 22 页 `/Type /Page`、`/FlateDecode` 正常，说明存下来的是完整文件而非错误页。


## 验收

- [x] 落盘路径在 `<workspace>/downloads/` 下，文件魔数为 `%PDF-`（已跑通 `downloads/dummy.pdf`，13,264 B）
- [x] 同一 URL 连下两次 → 第二个文件名为 `xxx-1.pdf`，原文件未被覆盖（单测「a second download of the same url…」）
- [x] 非 http(s)（`file://`、`ftp://`）→ `download_failed stage=validate`
- [x] 50 MiB 上限：`content-length` 超限 → `stage=too_large`（单测注入 header）
- [x] 404 页 → `stage=http` 且 `finalUrl` 可见（已用 `example.com/…404.pdf` 与 w3.org 的 301→404 两种情形验证）
- [x] 文件名 `../../etc/passwd` → `stage=validate`（单测）
- [x] 单测全绿（18/18）；`node --check` 所有改动文件
- [x] 重打包并 `plugin_manager install_bundle` 安装后，工具表出现 `browser_download`（`1.0.4` → `1.0.5`，均已 `applied`；桥接日志 `host half applied (rev 8)`，面板自动重挂）
- [x] `sha256` 与本地 `Get-FileHash` 一致（真站 PDF：工具 `548f8f60…380f`，`Get-FileHash` 同为 `548f8f60…380f`）
- [x] 真实站点的中文文件名正确落盘（百分号编码已解码，见"发现③"）

## 不在本期

- `via:'page'`（guest session 带 Cookie 下载）→ v1.1，T1 需要登录态附件时再做。
- 断点续传 / 多线程。
- 下载事件推送（面板圆角进度条）——先把能力打通，UI 后置。

## 风险

| 风险 | 缓解 |
|---|---|
| 政府站有 Referer/UA 校验 | 默认带一个常规 UA，`referer` 可传；失败文案指向"可能需要 `referer`" |
| 直链里带一次性 token | 先 `browser_eval` 取 href 再立刻下载，中间不要重开页面 |
| 大文件把模型上下文冲爆 | 只回 `{path,bytes,sha256}`，**不回**任何文件内容 |
