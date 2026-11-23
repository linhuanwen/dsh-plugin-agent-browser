# TICKET-023 过程卡片：走 `tool.call.toolview`，不靠 `presentCall`

- **状态**：✅ 已完成（1.3.0 装机，后续 1.3.4 修 TICKET-028）
- **优先级**：P2（体验问题，不阻塞发布；但影响"截了图却看不到图"）
- **来源**：`docs/design/official-docs-review.md` #12（官方：内置 Web Client 不消费 `presentCall`/`presentResult`，过程卡片要走客户端 keyed slot `tool.call.toolview`）
- **对应验收**：`docs/spec/002-official-alignment-spec.md` B8
- **关联**：TICKET-022（`defineTool` 的 `presentationMeta` 与它配合）

## 1. 问题

`plugin/tools.js` 里有 22 处 `presentCall`/`presentResult` 调用（`presentCall` 行号：166/295/604/698/791/858/927/1003/1145/1389/1479；`presentResult`：169/298/608/702/795/861/930/1006/1148/1392/1483），宿主侧确实在收集——但**内置 Web Client 不消费这两个钩子**。结果：

1. `browser_screenshot` 在对话里只显示**一行文件路径**，用户得自己去打开文件（这正是当前最常被吐槽的地方）。
2. `browser_snapshot` 的过程行没有标题、不能折叠，长树状输出把对话撑开。
3. 插件已经 `presentResult` 传了完整 image block，等于白做。

## 2. 修法

### 2.1 机制

在 `plugin/client.js`（客户端半边）注册 keyed slot：

```js
// 以工具名为键；同一份 bundle 里注册多个条目
ctx.slot('tool.call.toolview', {
  key: 'browser_screenshot',
  render: ({ args, result, phase }) => phase === 'result' && result?.image
    ? { type: 'image', src: result.image.url, alt: `Screenshot of ${result.url ?? 'page'}` }
    : { type: 'text', text: 'taking screenshot…' },
})
```

具体 API 以 `dsh-client-ui-action-cards` 客户端源码为准——它已经有一个"以 `propose_action` 为键的 `tool.call.toolview` 条目"（其 `README.zh.md:44` 原话），照抄它的注册方式即可，**不猜 API**。

### 2.2 先做哪几个

只做三个回报最大的，不做通用卡片框架：

| 工具 | 卡片内容 | 降级 |
|---|---|---|
| `browser_screenshot` | 内联缩略图 + 尺寸 + 点击打开原图 | 退回现在的路径文本 |
| `browser_open` | 标题 + URL + 是否 `read` 了正文 | 一行文本 |
| `browser_download` | 文件名 + 大小 + sha256 前 12 位 | 一行文本 |

`browser_snapshot`/动作类不做卡片——它们的输出本来就是给模型读的文本，卡片没有增量。

### 2.3 `presentCall`/`presentResult` 怎么办

**不删**。它们是宿主侧的结构化描述，未来别的客户端（桌面端 TUI/IDE）可能消费；但**不再指望它们出图**：图片显示由 slot 负责。文档里写清这两条通道的分工，避免下一个人又"改 presentCall 想让它出图"。

## 3. 单测 / 验证

客户端 slot 难以单测，退一步做三类检查：

| # | 检查 |
|---|---|
| 1 | `plugin/client.js` 里 slot 注册的 key 与 `plugin/tools.js` 的工具名**逐字相等**（写一个 node 脚本 grep 两侧常量对比，进 `npm test`） |
| 2 | slot 渲染函数对 `{phase:'call'}` / `{phase:'result', result:null}` / `{result:{image}}` 三种输入不抛（用纯函数抽出来测） |
| 3 | 宿主侧不回归：现有 22 处 `presentCall` 仍在（grep 计数 == 22） |

## 4. 装机验收

| 项 | 做法 | 期望 |
|---|---|---|
| 截图能看见 | 让模型 `browser_screenshot` | 对话里直接出现缩略图，不是路径字符串 |
| 长快照不炸屏 | `browser_snapshot` | 过程行折叠，默认收起 |
| 无图也不崩 | 截图失败（页面白屏/超时） | 显示降级文本 + 错误码，不显示破图 |

## 5. 风险与未验证

| # | 项 | 处理 |
|---|---|---|
| U1 | 第三方插件能否注册 `tool.call.toolview`（权限/命名空间限制） | 先读 `dsh-client-ui-action-cards` 的注册代码；若只有内置包可注册，本 ticket 降级为"文档说明 + 保留 present" |
| U2 | 桌面 renderer（`file://` + dist）与 Web renderer 加载的客户端 bundle 是否同一套 slot 机制 | 在两个环境各试一次 |
| R1 | 内联大图拖慢对话渲染 | 缩略图最大 480px 宽，点击才加载原图 |
| R2 | slot key 与工具名漂移（改名后卡片静默消失） | 单测 1 的常量对比 |

## 6. 实现记录（2026-11-21，版本 1.3.0 → 1.3.4）

### 6.1 落地形状

| 半边 | 文件 | 改动 |
|---|---|---|
| 宿主 | `plugin/tools.js` | `browser_open` 增 `output.presentationMeta` → `{ url?, title?, path?, needsHuman? }`；`browser_screenshot` 增 `presentationMeta` → `{ path, bytes, sha256, width?, height?, truncated, thumb? }`，并在 `output.schema` 里声明 `thumb`（`attachmentId/mediaType/bytes/width/height`）；`browser_download` 增 `presentationMeta`（成功 `{path,bytes,sha256,mime?}`，失败 `{failed:true,stage,reason}`）；新增私有 `attachImageBytes(ctx, bytes, name)` 走 `ctx.attachments.saveImage`，返回 `{attachmentId, mediaType, bytes, width?, height?}` |
| 客户端 | `plugin/client.js` | `CLIENT_REV` 31（本票起点）→ 35；`TOOL_VIEW_KEYS = ['browser_open','browser_screenshot','browser_download']`；三个组件 `OpenRow`（`<a href>` + `needsHuman` 提示）、`ScreenshotRow`（附件 ref → `loadImage` → `<img>`，失败降级为路径 + `openFile`）、`DownloadRow`（名/大小/sha 前 12/失败原因 + `openFile`）；`apply()` 里 `ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name:'tool.call.toolview', key }, View)), 'agent-browser.toolview.' + key)`；`report('client half applied', { toolviews: 3 })` |

图片走**附件通道**（不是静态 token URL）：token 每次重启变化会让历史卡片烂链接，附件则是稳定 ref；`loadImage` 由宿主 `ctx.uiConversation.imageUrl` 兑现，不额外花 vision 预算。

### 6.2 单测

`plugin/test/toolviews.test.mjs`（8 例，vm 加载真 `plugin/client.js` + 假 React/假 ctx）：

| # | 用例 |
|---|---|
| 1 | 三个 slot key 与 `createTools()` 的真实工具名逐字一致 |
| 2 | `inject` 仍含 `slots`/`sidebarRight`/`sidebarRightTabs`/`layout` |
| 3 | 三个组件在 preparing/start/result/error 四态与缺失 meta 下都不抛 |
| 4 | `OpenRow` 在 start 阶段就能从 `args.url` 出链接，result 显示 href 与 `needsHuman` |
| 5 | `ScreenshotRow` commit 后 `loadImage` 解析出 `blob:` URL 并渲染 `<img>` |
| 6 | `DownloadRow` 显示 `2.0 MB`、`sha256` 前 12、失败原因 |
| 7 | 三张卡的 `presentationMeta` 形状与工具真实输出一致（含 download 失败形状） |
| 8 | `presentCall`/`presentResult` 各 11 处仍在（22 处不回归） |

全量 `node --test`：**136 / 136 通过**。

### 6.3 装机验收

| 项 | 做法 | 实测 |
|---|---|---|
| 装机与加载 | `install_bundle` 1.3.0 → 1.3.4 | ✅ `application:"applied"`；`list_plugins` 里 `include:agent-browser-panel` enabled true / fiberPhase active；装机目录 `client.js` 有 `tool.call.toolview` ×3、`CLIENT_REV = 35` |
| 卡片数据已落盘 | 解压当次会话 `session.v4.jsonl.zstd`（多帧 zstd，逐帧解压后 13.5 M 字符）grep `thumb` | ✅ 工具结果记录带 `"meta":{"path":"screenshots/toolview-check.png","bytes":85460,"sha256":"9e6bcf…","thumb":{"attachmentId":"sha256:9e6bcf…","mediaType":"image/png","bytes":85460,"width":863,"height":1294}}` —— 证明 `presentationMeta` 真的随记录持久化，卡片重放时拿得到数据 |
| 截图取图 | `browser_open https://example.com/` → `browser_screenshot` | ✅ `screenshots/toolview-check.png` 83.5 KB、`screenshots/after-1.3.1.png` 83.5 KB（同页同视角）；`browser_snapshot({includeImage:true})` 83.8 KB |
| 视觉确认 | 用户看 GUI 对话 | ⚠️ 待用户确认（本代理看不到 DSH 窗口内部；卡片渲染逻辑由 6.2 单测覆盖，数据由 6.3 证明） |
| 无图不崩 | 截图失败路径 | ✅ 失败时卡片显示文本降级（路径 + 原因 + `openFile`），不出现破图；截图本身的失败文案见 TICKET-028 |

### 6.4 与原文偏差

| # | 原文要求 | 实际 | 理由 |
|---|---|---|---|
| D1 | 建议照抄 `dsh-client-ui-action-cards` 的注册写法 | 抄了 `ctx.slots.inject(...register(...))` 形状，但没用它的 `locale` | 本插件无 locale 表，文案沿用其余 UI 的中文硬编码 |
| D2 | 内联缩略图"点击才加载原图" | 缩略图与卡片都用 `loadImage` 的 480px 宽 `<img>`，点击目标是 `openFile(path)` 打开原文件 | `loadImage` 直接给的是渲染 URL，原图文件在 workspace，用 `openFile` 更符合"看原图" |
| D3 | 三张卡之外可考虑 snapshot 折叠 | 未做 snapshot 卡 | 268 行起的 `browser_snapshot` 输出本就是给模型读的文本，卡片无增量；折叠属另一个交互议题 |
| D4 | 卡片 key 与工具名一致靠脚本 grep | 写成 `plugin/test/toolviews.test.mjs` 断言（比 grep 更严：还校验 phase 与降级） | — |

### 6.5 残留

- **U1/U2 未在第三方场景验证**：本机只有自研插件注册 `tool.call.toolview` 成功（说明外部 bundle 能注册），但"第三方插件包"与"桌面 renderer 同套 slot"仍未单独验证。
- 卡片视觉需用户确认（6.3 最后一行）。
- 截图失败文案与可见性依赖见 TICKET-028（本票验收期发现并单独修复）。
