# TICKET-006：本地静态服务（让面板打开工作区里的网页）

- 状态: ✅ 通过（2026-11-20）
- 优先级: P1（不阻塞主链路，但直接决定"做地图/原型"这类用法能不能用）
- 关联 Spec: `docs/spec/001-agent-browser-plugin-spec.md` §9
- 依赖: TICKET-002
- 目标目录: `D:\Vibe coding\32 deepseek harness cebiankuang\plugin\`（源目录；link 安装进 profile）

## 目标

让 Agent 能把工作区里的一个 HTML 文件（比如地图原型、数据看板）直接甩到面板里跑起来：`browser_open({ path: 'map.html' })` → 内部起静态服务 → 返回 `{ url, port, root }` → 面板打开它。

> 不新增工具位：`path` 是 `browser_open` 的一个参数（与 `url` 二选一），工具总数保持 6 个。

## 背景

用户想干的事和他给的那张截图一致：右边是个网页（百度地图），Agent 在操作它。但如果页面是本地文件，`file://` 走不通——主进程 `allowedNavigation` 只放行 `http:`/`https:`，`will-frame-navigate` 会 `preventDefault()`（`D:\deepseek harness\resources\app.asar\lib\main.js:18259`）。所以本地页面必须"挂个 HTTP 壳"。

同时确认：`http://127.0.0.1:3000` 这类**非 DSH 端口**的 loopback 是被放行的（`isApplicationHost` 只在端口 8738 时拦），所以自带一个小静态服务器是合法路径。

## 验收

- [x] `browser_open({ path: 'demo/index.html' })` 返回 `{ url, port, root }`，面板自动打开且页面渲染正常
      —— `Opened http://127.0.0.1:5680/demo/index.html — Workspace Demo`，附 `Served from the workspace by a read-only local server on port 5680 (root: D:\Vibe coding\32 deepseek harness cebiankuang)`
- [x] 页面里的相对资源（`./a.css`、`img/b.png`、`fetch('./data.json')`）全部正常加载
      —— 快照 `img "a green square" [ref=e2]`、`Stylesheet loaded: yes`、`fetch('/data.json'): {"ok":true,"served":"from the workspace","items":[1,2,3]}`；`browser_eval` 得 `imgW: 64`、`css: "rgb(29, 78, 216)"`（`letter-spacing` 生效证明外链 CSS 真的用上了）
- [x] `browser_open({ path: '../secret.txt' })` 被拒（错误码 `path_escape`）
      —— `Error: path_escape: ../secret.txt resolves outside the workspace (D:\Vibe coding\32 deepseek harness cebiankuang); browser_open only serves files from the workspace`
- [x] `GET /..%2f..%2fetc%2fpasswd` 被拒（403），且日志里没有泄露主机路径
      —— `403 forbidden`，响应体只有 `forbidden` 两个词，不含 `D:\` 也不含文件名
- [x] 不存在的文件返回 404 + 明文说明，不抛栈
      —— `404` + 明文 `not found`
- [x] 服务只监听 `127.0.0.1`（`netstat` 确认不是 `0.0.0.0`）
      —— `Get-NetTCPConnection -LocalPort 5680` 只有 `127.0.0.1:5680`（PID 33172），无 `0.0.0.0`
- [x] 同一工作区重复传 `path` 复用同一个服务端口，不越开越多
      —— 同会话第二次打开 `demo/data.json` 仍走 5680
- [x] 会话结束/插件停用后端口关闭（`netstat` 确认已释放）
      —— `remove_bundle` 后 5680 与 8792 同时消失；`install_bundle` 重装后新 host 起新端口 10294（端口随进程生命周期）
- [x] 打开 `http://127.0.0.1:13098`（DSH 自身）仍被主进程拒绝，验证边界没被放宽
      —— `Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_FAILED (-2) loading 'http://127.0.0.1:13098/'`，之后可正常回到本地页

补充验收（本轮新增）：

- [x] 单测 `node --test plugin/test/static.test.mjs` → **13 pass / 0 fail**（穿越、编码、UNC、NUL、`%zz`、相对/绝对入参、`urlForPath` 编码、真实服务器集成）
- [x] `HEAD` 返回 200 + 正确 `content-type` + `cache-control: no-store`；`POST` 返回 405 + `allow: GET, HEAD`
- [x] 超大文件（33,554,433 字节）→ `413 file too large (33554433 bytes, limit 33554432)`
- [x] 目录请求补 `index.html`（`/demo/` 与 `/demo/index.html` 同页）

## 实际实现（与原计划的差异）

- 计划写 `src/host/static.ts`（TypeScript + `lib/` 构建产物），实际是 **`plugin/static.js` 纯 JS 单文件**。理由与 TICKET-002 一致：本机没有 TS 工具链，link 安装 + 纯 JS 已足够；构建链留到 TICKET-007。
- `browser_open` 仍然只有 `url` 一个字段时为必填的旧行为已改为**二选一**：schema 去掉 `required: ['url']`，`path` 与 `url` 同给时 `url` 优先（并在文案里说明 `path` 被忽略）。
- 根目录来源不是自己实现的"会话工作区查询"，而是 harness 自带服务：`ctx.get('workingDirectory').ensure(agent, signal)` → 会话工作目录。这样"工作区"的定义与 DSH 其他功能完全一致。
- 端口一律 `listen(0)`，所以每次 host 进程生命周期内第一次打开才会分配，之后同 root 复用（见验收第 7 条）。

## 实测发现

1. **本地页的"相对资源"能用，是因为服务把每个资源都当独立请求处理**：`./a.css` 与 `img/b.png` 都走 `resolveWithin`，所以穿越防护对每个子资源同样生效——不是只保护入口 HTML。
2. **`realpath` 复查是必须的第二道闸**：`path.resolve` 只挡住字符串层面的 `..`，符号链接仍可指向工作区外；`fs.realpath` 后再比一次前缀才闭合。
3. **错误信息里不能带主机路径**：403/404 统一返回单词（`forbidden` / `not found`），详细原因只写进 host 日志（`error.code`）。这条是有意为之——这个响应会被渲染进面板，Agent 也能读到。
4. **端口是进程级资源**：`remove_bundle` 卸载后端口立即释放、重装后换端口，说明生命周期挂在 host 插件实例上（`ctx.effect(() => () => sites.dispose())`）。因此文档里不要写死端口。
5. **面板的 webview 在窗口切到后台时不绘制、也不收合成输入**：本轮一度以为"点击失灵"，实测发现 `window.__ev` 完全收不到事件、`capturePage()` 同时挂起；把 DSH 窗口切到前台后，点击立刻恢复（`hits: 1`）。这条对"抓截图/坐标点击"的影响最大，已记入 `docs/cases/006`。
6. **`browser_snapshot` 的字符预算会把 ref 一起截掉**：预算小到只剩标题时，后面的 `[ref=e3]` 根本没生成，随后点它报 `ref "e3" is no longer in the page`。这是正确行为（refs 只对产生它的那次快照有效），但容易误判成"页面坏了"。

## 任务分解（实际做法）

- [x] `plugin/static.js`：`node:http` 服务器，`listen(0, '127.0.0.1')`，`StaticSites` 按 `realpath(root)` 缓存
- [x] 路径安全：`resolveWithin` / `resolveWorkspacePath` / `realpath` 前缀复查 / 拒绝盘符与 UNC
- [x] MIME 表（html/css/js/mjs/json/map/txt/md/csv/svg/png/jpg/jpeg/gif/webp/ico/woff/woff2/ttf/wasm/mp4/webm）+ `index.html` 兜底
- [x] 注册进 `browser_open`：`url` / `path` 二选一，返回 `{ url, port, root }`
- [x] 生命周期挂 host 插件：`ctx.effect(() => () => { void sites.dispose() }, 'agent-browser.static')`
- [x] 单测 `plugin/test/static.test.mjs`（13 例）
- [x] 实测页 `demo/index.html` + `demo/a.css` + `demo/data.json` + `demo/img/b.png`

## 风险（已落地状态）

| 风险 | 处置 | 状态 |
|---|---|---|
| 用户误把服务开在公网 | 硬编码 `127.0.0.1`，不暴露配置项 | ✅ `netstat` 确认 |
| 符号链接逃逸 | `fs.realpath` 后再校验一次前缀 | ✅ 已实现 |
| 大文件拖慢面板 | > 32 MiB 直接 413 | ✅ 实测 413 |
| 端口被占 | 端口 0 由系统分配 | ✅ 实测 |
| 路径穿越 | 字符串层 + realpath 层双检 | ✅ 13 例单测 |

## 预估

计划半天；实际约 40 分钟（含 13 例单测与夹具页）。

## 参考

- `docs/cases/001-dsh-browser-internals.md` §3（`allowedNavigation` 全文）
- `docs/cases/007-local-files.md`（本轮新增：设计、安全边界、错误码表）
- 官方对本地文件的定位：Document Preview 管 `file://`，Browser 只管 `http(s)`
