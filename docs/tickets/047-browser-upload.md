# TICKET-047：`browser_upload` —— 把工作区文件放进 `<input type=file>`（TICKET-047）

- 状态：✅ 已完成（2026-11-27，1.5.8；单测 309/309、`check-docs` 全绿、真机 7 项通过）P1（阶段 B1 操作补全）
- 关联：SPEC-004（B1 准入四问 / B2 能力分类 / B3 证据四件套 / B4 effect 三态）、SPEC-003（C2 写动作分类）、
  cases/021、TICKET-037（首次写动作确认）、TICKET-042（`effect` 三态）
- 先行能力：`browser_click` / `browser_type` 的 `ref` / `loc` 寻址；宿主 `workspaceOf` 与下载器的路径校验

## 1. 缺口

真实浏览器里「上传」是最常见的写操作之一（头像、附件、导入 CSV），但 agent 现在没有任何入口：

1. `browser_click` 点「选择文件」只会弹出**宿主原生文件选择器**，它不在 webview 里、agent 看不见也点不到；
2. 一点办法只剩让用户手动选，或者把文件 base64 塞进页面 JS 自己造一个 `fetch`——绕过页面业务逻辑，且对
   `showOpenFilePicker` 这类站点无效。

竞品对照：browserpaw 用 `chrome.downloads` + `DOM.setFileInputFiles` 做原生上传/下载；browser-mcp 用
`DOM.setFileInputFiles`；BrowserSkill 先 arm `fileChooser` 再 `DOM.setFileInputFiles`。共同点是走调试协议。
我们不走 CDP（决策 005），所以改用**页面侧合成 File**：`DataTransfer` + `File` → `input.files` → `input`/`change`。
2026-11-27 已用真页面验证可行（`probe.txt` 25 B，`change` 事件与 FileReader 都正常，见 `docs/cases/021`）。

## 2. 准入四问（SPEC-004 B1）

| 问题 | 答案 |
| --- | --- |
| 读还是写？ | **写**。新增 `actionClass: 'upload'`，默认第一次在站点上执行前确认（`approvals.mode:'first-touch'`）。 |
| 可逆吗？ | **不可逆**：文件一旦进入页面业务逻辑就可能被提交/存盘；不能提供撤销。 |
| 失败时能确定「没执行」吗？ | 大部分能：路径越界/缺失/超限/目标不是 file input 都在**读字节之前**拒绝（`effect:'none'`，`upload_rejected` 带 `reason`）；命令已下发但回执丢失时按 `action_unknown`（可能已进入页面，不许重发）。 |
| 人机墙 / 接管能绕过吗？ | 不能：审批在工具体内；`needs_human` / `taken_over` 由 `bridge.request` 的 `#assert` 拦住，`upload` 在 `WRITE_TYPES` 里。 |

结论：通过准入，可进主干；因为不可逆，必须与 TICKET-042 的三态语义一起工作。

## 3. 目标

1. 新增第 13 个工具 `browser_upload({ ref?, loc?, selector?, strict?, files })`：`files` 是工作区相对路径数组。
2. 路径安全：`realpathSync` 解析后必须落在工作区根目录内（防 `..`、符号链接逃逸、绝对路径越界）。
3. 限额：单文件 2 MiB、合计 4 MiB、最多 5 个；超限在**读文件前**拒绝。
4. 目标校验：先用 `gate.inspect` 确认地址指向 `<input type=file>`；不是 file input 或地址失效时**不读文件、不弹确认**。
5. 审批：`requestApproval({ actionClass:'upload', origin, url, target:{ files:[{name,size}], bytes } })`，
   文案形如「向 example.com 上传 报告.pdf」，不含工作区路径。
6. 结果：`{ effect:'committed', files:[{name,size,type}], multiple, url }`；失败返回 `upload_rejected`（不可重试）或既有分型。

## 4. 实现

### 4.1 页面侧（`plugin/inject/actions.js`）

- 新增 `isFileInput(node)`（`node.tagName === 'INPUT' && node.type === 'file'`）与 `base64ToBytes(text)`（`atob` + `Uint8Array`）。
- 两处 `inspect` 响应加 `acceptsFiles`（是否 file input）与 `acceptsMultiple`（是否带 `multiple`），让宿主在**读字节前**知道目标对不对、能不能收列表。
- 新增 `op === 'upload'` 分支（放在 `inspect` 之后、`scrollIntoView` 之前——file input 常被 `display:none` 的装饰按钮包住）：
  - 非 file input → `not_file_input`；`input.files` 为空 → `no_files`；单文件 input 收到多个 → `multiple_not_allowed`（宿主侧已在弹条前预检，这里是兜底）；
  - 逐项 `new DataTransfer()` + `new File([bytes], name, { type })` → `transfer.items.add` → `element.files = transfer.files`；
  - 依次 `dispatchEvent(new Event('input', { bubbles:true }))` 与 `change`；
  - 成功返回 `{ ok:true, info, files:[{name,size,type}], multiple, url }`；构造/赋值异常 → `upload_failed`。

### 4.2 工具侧（`plugin/tools.js`）

- 常量：`UPLOAD_MAX_FILES=5`、`UPLOAD_MAX_FILE_BYTES=2 MiB`、`UPLOAD_MAX_TOTAL_BYTES=4 MiB`、`UPLOAD_TYPES`（常见扩展名 → MIME，未知 `application/octet-stream`）。
- `readUploadFile(realRoot, spec)`：`realpathSync` → 工作区前缀校验（`outside_workspace`）→ `statSync` 非文件（`not_a_file`）→ 超 2 MiB（`too_large`）→ 读失败（`not_readable`）。
- `uploadRejected(reason, message, details)`：`upload_rejected`（`retryable:false`，message 写明 nothing reached the page）。
- `browserUploadTool(ctx, gate)`：description 写明写动作/站点首次确认/限额/原生选择器不适用；
  parameters 为 `{ ref?, loc?, selector?, strict?, files }`（地址恰好一个）；output 基于 `ACTION_OUTPUT` 加 `files/multiple/url`。
- `execute`：参数与数量校验 → 地址校验（`gate.inspect`）→ `addressError` 直接 `actionFailure` → 非 file input 拒绝 →
  `workspaceOf(ctx, exec)` + `realpathSync(root)` → 逐文件读+累计限额 → `gate.requestApproval` → `gate.request('upload')` →
  `committed(...)`。`presentCall` / `presentResult` 用 `kind:'edit'`。
- `createGate` 增加 `inspect` 直通（上传必须在读字节前看目标）；`confirmBefore` 对 `upload` 直接 return（避免弹两次）。
- `actionFailure` 增加 `not_file_input` / `no_files` / `multiple_not_allowed` / `upload_failed` 四个 case。
- `createTools` 注册 `browserUploadTool`，`writes` 集合加 `browser_upload`。

### 4.3 桥与客户端

- `plugin/bridge.js` 的 `WRITE_TYPES` 加 `'upload'`（已下发丢回执 → `action_unknown`）。
- `plugin/client.js`：`CLIENT_REV` 53 → 54；`Guest.act` 的 args 白名单加 `files`；`runCommand` 加 `upload` 分支。

### 4.4 错误码

`errors.js` 追加第 19 个码：

```
upload_rejected: { retryable: false, hint: 'the file was refused before anything was sent to the page
  (path outside the workspace, missing, too large, or the target is not a file input); see reason.' }
```

## 5. 证据四件套（SPEC-004 B3）

- 单测：`plugin/test/upload.test.mjs` 10 例（成功/审批/越界/缺失/目录/限额/非 file input/stale_loc 不弹条/参数校验/单文件 input 收到列表在弹条前拒绝；页面侧 DataTransfer+File stub 的成功与拒绝路径）+ `gate.test.mjs` 3 例（upload 只问一次、拒绝后零下发、inspect 透传 `acceptsFiles`/`acceptsMultiple`）→ 全量 309。
- 真机 case：`docs/cases/021-browser-upload-cases.md`（单文件上传、多文件、越界拒绝、非 file input 拒绝、
  审批拒绝不落盘）。
- 错误码与 hint：`upload_rejected`（retryable false，带 `reason`）。
- 文档三处：根 README（工具表 + 写动作五类）、`dist/.../README.md`（工具表 + 要问清单）、release notes（1.5.8）。

## 6. 不做

- 不上 CDP / `DOM.setFileInputFiles`（决策 005），也不打开宿主原生文件选择器。
- 不做目录上传（`webkitdirectory`）、拖拽上传、剪贴板文件；不做文件内容转换/压缩。
- 不覆盖 `showOpenFilePicker` / `showSaveFilePicker` 站点（宿主策略下拿不到原生选择器；工具描述里已说明）。
- 不做「上传后自动点提交」；提交是另一个写动作，需要自己的确认。

## 7. 验收

- [x] 单测 296 → 309 全绿，`check-docs` 六项全绿（工具 13 个、配置 21 个）。
- [x] 真机：单文件上传后页面 `change` 事件可见（文件名/大小/类型正确），`effect: 'committed'`。
- [x] 真机：多文件 input 一次两个文件；单文件 input 传两个 → `multiple_not_allowed`。
- [x] 真机：工作区外路径 → `upload_rejected`（`outside_workspace`），且没有任何确认条。
- [x] 真机：目标不是 file input → `not_file_input`（不弹条）；拒绝确认 → `approval_denied` 且页面零变化。
- [x] 文档三处同步（根 README / 用户 README / release notes 1.5.8）、PROGRESS 与 docs 索引更新。

## 8. 真机验收记录（2026-11-27，1.5.8）

- 产物：`dsh-plugin-agent-browser-1.5.8.tgz`，336,112 B / 28 文件，sha256 `9ED041CB3CEA104A46A83D1E19BF7CF94C5521915E928892563F5CB58558DD91`；`CLIENT_REV` 54。
- 7 项情形全部通过（单文件/多文件/单文件 input 拒列表/越界/非 file input/不存在/拒绝确认零副作用），逐条命令与回执见 `docs/cases/021-browser-upload-cases.md`。
- 验收期抓到并修掉三个只会在真机出现的问题：(1) `createGate.inspect` 丢了 `acceptsFiles`，所有上传被判「不是 file input」；(2) 上传请求漏传 `source`，面板侧抛 `the action source was not delivered`；(3) 注定失败的列表先弹 30s 确认条——改为读字节/弹条前用 `acceptsMultiple` 预检。

## 9. 风险

- R1：`input.files` setter 可能在个别站点被业务脚本覆盖或只读；页面侧会回 `upload_failed`，不会假装成功。
- R2：2 MiB × 5 的 base64 走长轮询，单条消息约 13 MB（`SETTLE_BUDGET` 24 MiB 内）；再大就拒绝，不做分块上传。
- R3：页面若用 `showOpenFilePicker` 而不是 `<input type=file>`，本工具不适用；工具描述已写明，属已知限制。
- R4：上传不可逆，用户拒绝或超时后页面文件 input 不会被修改（动作在审批后才下发）。
