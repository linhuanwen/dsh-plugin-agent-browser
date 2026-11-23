# TICKET-012 面板缩放（`browser_zoom` + 顶部 − 100% ＋）

> 状态：✅ **已完成并装机（1.0.24，`HOST_REV 25` / `CLIENT_REV 26`，2026-11-20）**

## 1. 问题

用户反馈："浏览器大小不能缩放"。实测根因有两条：

1. **面板没有缩放开关**。侧栏宽度由外壳决定（实测 CSS 视口 575×863，本次会话被拉宽后 769×863），插件没有改动它的手段；页面只能以 100% 渲染，桌面站（天地图约 1000 CSS px，`docs/cases/010-validation-cases.md` V9）要么横向溢出、要么被压成手机布局。
2. **`<webview>` 的缩放能力此前没有被使用**。`webview.setZoomFactor` 在本机 Electron 上存在（日志 `guest api { setZoomFactor: true, capturePage: "function", executeJavaScript: "function" }`），但面板与工具都没有调用它。

## 2. 修法

| 层 | 改动 |
|---|---|
| `client.js` `Guest` | 构造函数加 `zoom = 1`、`canZoom = false`；`mount()` 里探测 `typeof element.setZoomFactor === 'function'` 并上报 `guest api`；新增 `setZoom(factor)`（夹到 0.25–3、两位小数），原生因子可用时调 `setZoomFactor`，否则退化为"放大元素布局盒 + `transform: scale()`"；新增 `dipScale()` |
| `client.js` 输入 | `clickAt` / `moveTo` 的坐标乘以 `dipScale()`：原生缩放时页面 CSS 像素与设备像素不再 1:1，不换算就会点到别处 |
| `client.js` 会话 | 模块级 `zooms` Map（sessionId → factor），`dom-ready` 后恢复，面板重建不丢缩放 |
| `client.js` 面板 | 徽章行右侧加 `− / ${百分比} / ＋` 三个按钮：`−`/`＋` 步进 0.1，点百分比回 100%；`note` 改 `flex:1 minWidth:0` 让位 |
| `client.js` 命令 | `runCommand` 增 `zoom` 分支：`factor` 绝对 / `delta` 相对 / `reset` 回 1 |
| `bridge.js` | `INPUT_TYPES` 加 `zoom`（接管期同样拒绝） |
| `tools.js` | 新增 `browserZoomTool(bridge)`：`{factor?, delta?, reset?}`，校验 0.25–3 与 `|delta| ≤ 1`；render 报"现在页面以为面板是 W × H CSS px"并提示重新快照；`createTools` 返回 **10 个** |
| 版本/文案 | `HOST_REV 24 → 25`、`CLIENT_REV 25 → 26`、`package.json 1.0.24`、包内 README「十个工具」+ `browser_zoom` 行、`locale/zh|en` 描述 |

## 3. 验收（面板真跑，夹具 `demo/ticket-009.html`）

| 步骤 | 结果 |
|---|---|
| 基线 `browser_eval('({w:innerWidth,h:innerHeight,dpr})')` | `{"w":769,"h":863,"dpr":1.5}` |
| `browser_zoom({factor:0.5})` | `Zoom set to 50%. The page now believes the panel is 1538 × 1726 CSS px.` → 布局视口真的翻倍（不是把画面缩小） |
| 50% 下点击 `#dismiss2` | `Clicked button "知道了，关闭浮层" at (704, 412).`（CSS 坐标 → 内部按 ×0.5 发设备坐标） |
| 50% 下点击 `#ok` | `Clicked button "可以点的按钮" at (230, 337).`，页面事件 `ok · 可以点的按钮收到了点击` → **坐标换算正确，点到了真元素** |
| `browser_zoom({factor:1.5})` | `Zoom set to 150%. … 513 × 575 CSS px.`；`#dismiss` → `Clicked button "关闭浮层" at (186, 154).` |
| `browser_zoom({reset:true})` | 回到 `769 × 863` |

## 4. 边界与残留

- **缩放的是页面，不是侧栏**。侧栏宽度仍由 DSH 外壳决定；想把"看得见的内容变多"，缩小页面即可，但面板自身的像素宽度不变。
- 缩放改变页面的 CSS 视口，**旧快照的 ref 与坐标随之失效**——工具 render 已明说"snapshot again"。
- 只在 `native` 模式下验证过；`transform` 退化路径是为"某天 Electron 拿掉该 API"准备的，尚未在真机上走到，因此没有截图证据。
- 页面自己处理 `Ctrl+滚轮` 时与工具无冲突（我们不拦截滚轮）；面板未提供键盘快捷键。
- 缩放状态只活在内存里：重启 DSH 后回 100%（与 D03"面板不做持久化"一致）。
