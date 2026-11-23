# 设计决策台账（grilling 记录）

> 来源：2026-11-19 与用户的逐条评审。每条记录**问题、给的选项、最终选择、理由、被否决项**。
> 状态：全部为 `已定`，未开工前如有异议可推翻，但需在本文追加一条修订记录。

---

## D01 路线：怎么拿到"面板 + Agent 控制"

**选项**

| 代号 | 做法 | 结论 |
|---|---|---|
| A | 自建插件：自己的侧栏 tab 类型 + 自己的一套 `browser_*` 工具 + 自建 Remote 通道 | ✅ **选中** |
| B | 只驱动内置面板：用 `extension` 优先级接管 `browser` kind，或用 CDP 遥控内置面板里的 guest | ❌ 否决 |
| C | 维持现状：继续用 `dsh-pilot` 开外部 Chrome | ❌ 否决（作为兜底保留） |

**否决理由**

- B：接管 kind 就得把地址栏/历史/标签全重写，成本反而高于新建；走 CDP 要给 DSH 加 `--remote-debugging-port` 并**重启宿主应用**，且 Electron webview 的 guest 在 Playwright 的 CDP 视图里通常是 `webview` 类型 target，大概率选不到。
- C：永远做不到"面板里看着 Agent 操作"这个产品目标。

**A 的可行性依据**（详见 `reference/001-dsh-browser-internals.md`）
1. 侧栏 tab 类型是公开服务，插件可注册。
2. webview 租约入口挂在 `globalThis.dshDesktop.browser`，同一个渲染器里的任何插件都能用。
3. 主窗口 `webwebPreferences.webviewTag` 为真，`will-attach-webview` 只校验租约、不校验发起方包名。
4. "host 工具 + client 面板 + 类型化 Remote"在 `@deepseek-ai/dsh-experimental-client-ui-forge` 有完整范式。

---

## D02 面板 tab 与会话的绑定

**选项**：① 每会话一个专属 tab｜② 一个 tab 里多标签 + `tabId`｜③ 全局单 tab

**选中 ①**：Agent 第一次调 `browser_open` 时，若本会话还没有 agent tab 就新建一个，**并自动展开右侧栏**；此后本会话所有 `browser_*` 默认作用于它。

**理由**：官方 Browser 本来就是按会话隔离的（slot 注入拿到的就是 `sessionId`），照它的语义做最省事；多会话并行时互不踩地址栏。② 会让工具面膨胀 3–4 个、模型容易选错 tab；③ 两个会话并行直接互相打架。

**附带**：工具签名预留可选 `tabId`，v1 不实现，只为将来不破坏兼容。

---

## D03 能力边界：过验证

**用户初始想法**：既然操作方式像人，能不能顺带做成自动过验证。
**当时的追问**：见下。

| 目标 | 判定 |
|---|---|
| 点到 Turnstile 复选框（含跨域 iframe 内控件） | 技术可行（`sendInputEvent` 是可信输入，命中测试在合成器层） |
| 点完之后挑战真的通过 | 不可控。判定依据是 IP 信誉、TLS/JA3、canvas/WebGL 指纹一致性、设备侧 token；缺信号时对方给"无限循环 challenge" |
| 长期稳定通过 | 不可行，军备竞赛 |

**最终决定：不做自动过验证/绕过。** 理由两条：① 本质是绕过他人设置的访问控制、违反站点 ToS；② 与用户自己的全局规则冲突（`C:\Users\林焕文\.dsh\AGENTS.md:9`：*"Cloudflare / Turnstile 等人机验证……立刻停下来交给用户手动完成，不要尝试绕过"*）。

**替代**：显式人工接管（D04）。用户随后确认："那这一块暂时不管，但是你要预留人工接管的功能"。

---

## D04 接管态语义

**选项**：① 显式双向开关｜② 仅在检测到验证时触发｜③ 触碰即抢占（focus/键鼠自动接管，5 秒无操作交还）

**选中 ①**
- 面板常驻「我来接管」按钮；点击后状态置 `taken_over`。
- 此后**输入类**工具（`click` / `type` / `press` / `open` / `eval`）一律拒绝，返回 `taken_over`。
- **只读类**（`snapshot` / `screenshot`）仍可用。
- 用户点「交还 Agent」→ 回到 `idle`。
- 检测到 challenge 时自动进入 `awaiting_human`（暂停 + 红框高亮 + 提示）。

**理由**：用户诉求里"**直接**接管"要求能力随时可用，不能等检测；状态化能让 Agent 立刻知道自己被停了，而不是傻等超时。③ 被否：程序化输入也会触发 DOM 事件，容易自我抢占、来回抖动，调试成本高于收益。

**配套默认**：接管期间 Agent 不重试、不刷新、不快照轰炸（沿用 `AGENTS.md:19` 的交接纪律）；状态存在 host 侧，跨工具调用/跨轮次保持，直到显式交还。

---

## D05 工具面

**选项**：① 细粒度 7 个｜② 合并成 4 个（`browser_act({action})`）｜③ 极简 2 个（open + eval）

**选中 ①（七件套）**

| 工具 | 作用 |
|---|---|
| `browser_open` | 导航（URL / 本地路径 / 复用当前 tab） |
| `browser_snapshot` | 文本树 + 截图 |
| `browser_click` | 按 ref 或坐标点击 |
| `browser_type` | 输入文本（`submit` 可直接回车） |
| `browser_press` | 按键/快捷键（含前进后退刷新） |
| `browser_eval` | 逃生口：在页面主世界执行 JS 取结构化结果 |
| `browser_screenshot` | 全页/原尺寸截图 |

**理由**：这个插件的价值是"可靠地操作网页"，可靠性来自"一步一个动作、一个动作一个 ref"。7 个工具常驻约 2K token，比它省下的试错轮次便宜太多。② 的判别联合参数容易漏字段；③ 等于让模型手搓选择器，慢且脆，ref 体系直接废掉。

**注**：`browser_eval` 定位为逃生口（取接口返回值、绕诡异控件），不是主路径；它按**输入类**工具处理，接管期间同样拒绝。

---

## D06 快照格式

**选项**：① 自定义可访问性树 + `[ref=eN]`｜② 只列可交互元素（无层级）｜③ 直接给 HTML

**选中 ①**，并附三条硬规则：

1. **预算 8000 字符**，超出按行截断并返回 `truncated: true`。
2. **ref 失效检测**：导航/重渲染后旧 ref 失效时，`click` 返回 `stale_ref` 而不是静默点空。实现方式：每次快照给 `<html data-dsh-gen="N">` 打代次号，元素带 `data-dsh-ref="e12"`，动作时比对代次。
3. **iframe**：同源 iframe 递归展开（ref 前缀 `f1e2`）；跨域 iframe 只输出占位节点，提示用坐标点击。

**理由**：② 省 token 但模型看不见页面结构（勾选态、当前 tab、错误提示全读不到），会瞎点；③ token 爆炸且模型解析 HTML 很笨。① 与 `dsh-pilot` 的体验一致，用户不用换脑子。

**注**：`dsh-pilot` 的快照逻辑**不可复用**——它只是给 Playwright 的 `page.ariaSnapshot({mode:'ai'})` 文本做截断，ref 解析靠 Playwright 私有的 `aria-ref=` 定位器。webview 里没有 Playwright，树和 ref 都要我们自己写。

---

## D07 可访问范围（安全边界）

**初选**：③ 放开 `file://`。
**查证后被推翻**：主进程 `allowedNavigation` 硬性只放行 `http:`/`https:`，`will-frame-navigate` 与 `will-redirect` 都会 `preventDefault()`。渲染器侧能改，主进程侧只能改 asar 里的官方包——每次升级被覆盖，不在本项目范围。

**最终：实际落到 ①（照抄内置面板的规则）**

- 只放行 `http:` / `https:`；拒绝带凭据 URL、`file:`、`data:`、`javascript:`、`blob:`。
- 拒绝 DSH 自身 origin（`isApplicationHost`：端口等于 DSH 端口且 hostname 为 DSH 主机名或 `localhost`/`127.0.0.1`/`[::1]`）。
- **loopback 放行**：只要端口不是 DSH 的端口（当前 8738），`http://127.0.0.1:3000` 这类本地开发服务可以正常打开。
- 站内跨域跳转沿用主进程的 `browserOpenRequested`（新开 tab），不开特例。
- 密码框：`type` 命中 `input[type=password]` 直接返回 `needs_human`，密码绝不进模型上下文。
- 下载：v1 一律拦，提示"用系统浏览器打开"。
- 弹窗：主进程已有通道（无 body 的 GET 才放行），照用即可。

---

## D08 截图回传

**选项**：① 按需截图｜② 每次快照附图｜③ 不提供

**选中 ②**：`browser_snapshot` 每次都返回文本树 + 截图。

**配套**：截图缩到 **768px 宽**再回传（图片 token 大致减半）；保留 `includeImage?: boolean` 参数，默认 `true`，高频小步操作时 Agent 可主动关；图只进上下文**不落盘**。

**代价说明**：每步多约 0.7–1.5K 视觉 token，长流程成本上升。这是用户明确接受的取舍。

---

## D09 交付形态

**选项**：① 直接做成正式 bundle｜② 先塞 profile `node_modules` 手搓｜③ 先 ② 后 ①

**选中 ③**：开发期把包铺到 `C:\Users\林焕文\.dsh\profiles\desktop\node_modules\`，改完重启即生效；功能验收后补 `dsh.bundle.patch` + icon + locale `meta.*`，用 `plugin_manager install_bundle` 正式安装。

**理由**：核心资产是注入脚本和快照算法，需要反复调十几轮；走正式 bundle 每轮都要构建+重装+重启，时间全耗在打包上。

**命名**（未反对即按此）：包名 `dsh-plugin-agent-browser`；侧栏 tab 标题「浏览器（Agent）」；工具前缀 `browser_`；图标：蓝色光标 + 窗口的 SVG。

---

## D10 本地文件怎么开

**背景**：`file://` 被主进程硬拒（D07），但用户仍希望能打开本地 HTML。

**选项**：① 插件内起临时静态服务｜② 只提示让 Agent 自己起服务｜③ 交给 Document Preview

**选中 ①**：`browser_open({ path })` 时插件 spawn 一个**只读** http server，绑 `127.0.0.1` 随机端口，**只暴露指定文件所在目录**（阻断目录穿越），导航到 `http://127.0.0.1:<port>/<file>`，tab 关闭时回收进程。失败时退化到 ②（返回提示，让 Agent 自己用 shell 起服务）。

---

## 被纠正的错误认知（记录以免重犯）

| # | 曾断言 | 事实 | 证据 |
|---|---|---|---|
| C1 | "持久 profile 能让验证只出现一次，重启后仍在" | **错**。Cookies 与 Web storage **不跨应用重启**；partition 只在同一进程内按 workspace CWD 共享 | 内置面板 `README.md:110`：*"Cookies and Web storage do not survive application restart."* |
| C2 | "本地文件可以走 `file://`，把协议放宽就行" | **错**。主进程 `allowedNavigation` 只放行 http/https，`will-frame-navigate` 会拦 | `lib/main.js:18259`（见 `reference/001-dsh-browser-internals.md`） |
| C3 | "pilot 的快照逻辑可以搬过来复用" | **错**。它只是给 Playwright `ariaSnapshot` 做截断，ref 靠 Playwright 私有定位器 | `dsh-pilot/lib/snapshot.js`（1.5KB，纯后处理） |

---

## 修订记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-11-19 | 建立本文 | 设计评审收尾，转入立项 |
