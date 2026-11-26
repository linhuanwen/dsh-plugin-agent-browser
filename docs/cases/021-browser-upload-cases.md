# cases/021：`browser_upload` 真机验收（TICKET-047）

- 日期：2026-11-27
- 环境：DSH Desktop 0.2.2-rc.5 · 插件 **1.5.8**（`dsh-plugin-agent-browser-1.5.8.tgz`）· Windows
- 夹具：`demo/upload.html`（单文件 `#single`、多文件 `#multi`、观测区、事件日志）
- 结论：单文件/多文件上传与拒绝、越界、非 file input、单文件 input 拒绝列表、拒绝确认——全部与设计一致；
  验收期发现并修掉三个真机缺陷（见 §2）。

## 1. 结论表

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| 读快照 + 定位文件输入 | `browser_snapshot {includeImage:false}` | `#single` / `#multi` 以 `button` 角色出现，`loc="css:#single"`（file input 的 a11y 角色就是 button） |
| 单文件上传 | `browser_upload {loc:'css:#single', files:['tmp/upload-a.txt']}` | 确认条「向 127.0.0.1 上传 …」→ 允许一次 → `Uploaded 1 file into the page: upload-a.txt (33 B)`；页面观测区 `files = 1 个：upload-a.txt · 33 B · text/plain`，内容前 80 字符与源文件一致，事件日志有 `change` |
| 多文件上传 | `browser_upload {loc:'css:#multi', files:['tmp/upload-a.txt','tmp/upload-b.txt']}` | `Uploaded 2 files into the page: upload-a.txt (33 B), upload-b.txt (31 B)`，页面 `files = 2 个` |
| 单文件 input 收到列表 | `browser_upload {loc:'css:#single', files:[a,b]}` | **无确认条**，立即 `upload_rejected`：`that file input takes a single file, but 2 were given` |
| 路径越界 | `files:['C:/Windows/win.ini']` | **无确认条**，立即 `upload_rejected`：`that path is outside the session workspace` |
| 目标不是 file input | `loc:'css:#collect'`（普通按钮） | **无确认条**，立即 `upload_rejected`：`that element is not an <input type="file">` |
| 用户拒绝 | 单文件上传后点「拒绝」 | `approval_denied: 用户拒绝了向 127.0.0.1 上传 upload-b.txt`；快照仍是「还没有选择文件」，事件日志无 `change` |
| 不存在的文件 | `files:['../../outside.txt']` | `upload_rejected`（`not_found`），无确认条 |

## 2. 验收期发现并修掉的三个真机缺陷

1. **宿主侧丢掉了 `acceptsFiles`**：`createGate.inspect` 只回传 `{known,isSubmit,target,url,addressError}`，页面侧
   已经算出 `acceptsFiles`，但工具读不到 → 所有上传都被判「不是 file input」。修法：inspect 映射补
   `acceptsFiles` / `acceptsMultiple`，并加单测锁住（`gate.test.mjs`）。
2. **上传命令没带注入源码**：`gate.request('upload', {…, files})` 漏了 `source: actionSource()`，面板侧
   `Guest.act` 直接抛 `the action source was not delivered`。修法：请求参数补 `source`，上传单测断言 source 非空。
3. **注定失败的列表会先弹确认条**：单文件 input + 2 个文件原先在审批后才被页面拒绝，白等一次确认。修法：页面
   `inspect` 回传 `acceptsMultiple`，宿主在**读字节与弹条之前**判 `multiple_not_allowed`（与 `stale_loc`
   不弹条同一条原则）。三处修改后全量 307 → **309** 例。

## 3. 已知边界

- 只支持 `<input type=file>`：`showOpenFilePicker` / `showSaveFilePicker` 站点拿不到原生选择器，工具描述已写明。
- 限额：单文件 2 MiB、合计 4 MiB、最多 5 个；base64 走长轮询，单条消息约 13 MB（`SETTLE_BUDGET` 24 MiB 内）。
- 不支持目录上传（`webkitdirectory`）、拖拽、剪贴板文件；不做「上传后自动提交」（提交是另一个写动作，要自己的确认）。
- 页面若覆盖 `input.files` 的 setter 或业务脚本拒收，会回 `upload_failed`，不会假装成功。
- 未验证：真实站点（如头像上传）的 MIME/尺寸校验链；本夹具只证明「文件进入页面且事件正确」。

## 4. 复跑

```bash
node --test plugin/test/upload.test.mjs plugin/test/gate.test.mjs   # 9 + 14 例
node --test plugin/test/*.test.mjs                                   # 309 例
node tools/check-docs.mjs                                            # 六项
```

真机步骤：`browser_open {path:'demo/upload.html'}` → 快照拿 `loc` → `browser_upload`（单文件/多文件/拒绝/越界）。
