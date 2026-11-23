# 浏览器面板（Agent）

在 DeepSeek Harness 桌面端的**右侧栏**里放一个真浏览器面板，由 Agent 用工具操作；你可以随时点「我来接管」自己上手。

一句话定位：**内置的 `web_search` / `web_fetch` 负责"匿名、快速、只读"地取网页文字；这个插件负责"用你的登录身份、看得见、能动手、能留证据"的那一半。**

## 环境要求

| 项 | 要求 |
|---|---|
| 宿主 | **仅 DSH Desktop（Electron）**。面板依赖 Electron `<webview>` 与 `globalThis.dshDesktop.browser` 的浏览器租约，Web 版 profile 没有这两样 |
| 在 Web 版启用会怎样 | 面板不出现，浏览器工具返回明确的 `unavailable` / `panel_not_open` 类错误（不会静默超时）——**纯读取需求请直接用内置的 `web_fetch`** |
| DSH 版本 | `engines.dsh: >=0.2.2-rc.3 <0.3.0`（本机实测 `0.2.2-rc.5`） |
| 操作系统 | Windows / macOS 桌面端均可（面板本身是 Electron webview，不依赖特定系统能力） |
| 网络 | 通道只监听 `127.0.0.1`；页面访问走面板自己的网络栈（带你的登录态） |

为什么桌面限定：面板必须挂在 DSH 的右侧栏里，用户才能看见过程、随时接管；而"看得见"和"能用登录态"这两件事都绑在 Electron 的 webview 与租约上。这个取舍记录在仓库的 `docs/decisions/005-loopback-bridge-over-cdp.md`。

## 安装 / 升级 / 卸载

### 安装

```text
plugin_manager action: install_bundle target: <这个包的 tgz>
```

- 装完**不需要重启 DSH**；右侧栏引导页（点右侧栏上的 + ）里会出现一张 **「浏览器（Agent）」** 卡片，点它即开面板。
- 首次打开会让你在面板里自己登录目标站点；登录态留在面板的会话存储里，同一进程内后续页面与 Agent 直接复用。**重启 DSH 后可能需要重新登录一次**（会话不保证跨进程持久，见故障排查）。

### 升级

- 直接装新 tgz：`install_bundle` 会替换版本并重载插件。
- **profile 里那行 `config` 会原样保留**（只要 `id: agent-browser-panel` 与字段名没变）；如果你升级前改过配置，升级后不需要重写。
- 升级后如果面板还是旧样子：先刷新一次页面（客户端 bundle 会随版本号换），再检查 `plugin_manager list_plugins` 里本插件是否 `enabled: true` / `fiberPhase: active`。

### 卸载

```text
plugin_manager action: remove_bundle target: dsh-plugin-agent-browser
```

- 会同时清掉 profile 的 loader 条目与包目录；面板关闭、11 个工具消失。
- 通道与静态服务的端口随插件重载释放（默认系统分配，没有固定端口要清）。
- 工作区里已经产出的 `screenshots/`、`downloads/` **不会**被删（它们是普通文件，自己留着或清掉都行）。
- 开发者注意：如果之前是 `link:` 安装，`node_modules` 里会留一个 junction，Windows 下用 `(Get-Item <path> -Force).Delete()` 只删链接。

## 配置

### ⚠️ 先读这一条：patch 条目是整行替换，不是深合并

在 `cordis.patch.yml` 里给本插件写 `config` 时，**这一行的 config 会整体替换默认值**。只写 `activation: manual` 而漏掉其他字段，等于把漏掉的字段全部重置为默认（例如 `fitWidth` 会回到 `true`、`evalEnabled` 回到 `true`）——这属于静默改变行为。

**正确写法：把整份 config 抄全，只改你要改的那几行。** 下面这段就是"改一个字段、其余全保持默认"的模板，复制即用：

```yaml
- id: agent-browser-panel
  config:
    activation: auto
    fitWidth: true
    evalEnabled: true
    claimBrowserUse: true
    routing: auto
    bridge:
      port: 0
      requestTimeoutMs: 20000
    limits:
      navigationTimeoutMs: 45000
      snapshotMaxChars: 8000
      evalMaxChars: 8000
    downloads:
      dir: downloads
      maxBytes: 52428800
      extraBlockedExtensions: []
    static:
      maxBytes: 33554432
    sessions:
      allowlist: []
    searchFallback:
      enabled: false
      maxResults: 5
```

### 完整字段表

| 字段 | 类型 | 默认值 | 生效方式 | 说明 |
|---|---|---|---|---|
| `activation` | `auto` \| `always` \| `manual` | `auto` | 即时 | 面板何时自己打开。见下文「什么时候打开面板」；未知值按 `auto` 处理 |
| `fitWidth` | boolean | `true` | 即时 | 每次导航后把缩放调到"整行排版塞进侧栏"；`false` 保持 100% 横向滚动 |
| `evalEnabled` | boolean | `true` | 即时 | 是否允许 `browser_eval` 在页面里跑任意 JS；关掉后该工具报 `eval_disabled`。给不可信页面建议关 |
| `claimBrowserUse` | boolean | `true` | 即时 | 占用宿主的 `browserUse` 互斥槽，避免第二个浏览器提供者同时驱动页面；宿主没有该接缝时自动降级 |
| `routing` | `auto` \| `on` \| `off` | `auto` | 即时 | 往 Agent 的系统提示词里加一段"什么时候该用本插件"的分流说明。`auto` 只在检测到**另一套浏览器工具**（`pilot_*` 或面板版 `browser_navigate` 等）时才加，单后端 profile 保持零噪音；`on` 总是加，`off` 不加。见下文「和别的浏览器工具共存」 |
| `bridge.port` | 整数 ≥ 0 | `0` | 改后重载 | 面板通道端口；`0` = 系统分配（推荐，双实例不冲突）。一般不需要改 |
| `bridge.requestTimeoutMs` | 整数 ≥ 1 | `20000` | 改后重载 | 单条命令的默认超时 |
| `limits.navigationTimeoutMs` | 整数 ≥ 1 | `45000` | 改后重载 | `browser_open` 等待页面加载的上限 |
| `limits.snapshotMaxChars` | 整数 ≥ 1 | `8000` | 改后重载 | `browser_snapshot` 默认字符预算（调用时可单独传 `maxChars`，范围 500–30000） |
| `limits.evalMaxChars` | 整数 ≥ 1 | `8000` | 改后重载 | `browser_eval` 返回值的默认字符预算（范围 200–30000） |
| `downloads.dir` | 字符串 | `downloads` | 改后重载 | 下载落盘目录（相对当前工作区） |
| `downloads.maxBytes` | 整数 ≥ 1 | `52428800`（50 MiB） | 改后重载 | 单文件下载上限 |
| `downloads.extraBlockedExtensions` | 字符串数组 | `[]` | 改后重载 | 追加禁止下载的扩展名（内置已拦 26 个可执行类扩展名，如 `exe` / `bat` / `ps1` / `lnk`） |
| `static.maxBytes` | 整数 ≥ 1 | `33554432`（32 MiB） | 改后重载 | 本地只读静态服务单文件上限（`browser_open({path})` 用） |
| `sessions.allowlist` | 字符串数组 | `[]` | 改后重载 | 允许驱动浏览器的会话 id 列表；空 = 所有会话可用。名单外会话会被 guard 在工具执行前拦下（`session_not_allowed`） |
| `searchFallback.enabled` | boolean | `false` | 即时 | 导航失败后的"同站候选"开关：`browser_open` 失败时多搜一次，把同站链接附在错误里。**默认关**，见下方计费提示 |
| `searchFallback.maxResults` | 整数 ≥ 1 | `5` | 改后重载 | 最多列几条候选（超过 10 按 10 算） |

要点：

- **标"即时"的字段**（前四个）改动后不用重启插件，下一条命令就按新值走（面板在被接管时也不会被打断）。
- **标"改后重载"的字段**改动后插件会自动重载一次：桥重启、在飞命令失败、面板标签保留。不要频繁改这些字段。
- 拒绝类策略（scheme / 扩展名 / 大小 / 会话名单 / eval 开关）统一在 `plugin/policy.js` 里判定，错误都带稳定 code（`scheme_rejected`、`download_rejected`、`eval_disabled`、`session_not_allowed` 等），见 `docs/tickets/024-policy-guards.md`。

### 导航失败时的"同站候选"（`searchFallback`，默认关）

`browser_open` 失败（`navigation_failed` / `needs_human`）时，如果打开这个开关，插件会**再搜一次**、把同站链接附在错误后面，方便你换入口。注意：

- **默认关**。关着的时候错误文案与旧版本逐字一致，不会调用任何搜索。
- 一次失败最多搜 **1 次**；候选只取同站或子域（`www.` 去掉后比较），并明确写 `opened: false` —— Agent 只给候选、**不会自动打开**，要你自己 `browser_open`。
- 只把搜索结果的标题与 URL 给模型，**不会**把搜索摘要当页面内容塞进去。
- 计费：宿主 `dsh-web` 的搜索服务按次计费（DeepSeek 官方口径约 5 元 / 1000 次）。本机默认落 `deepseek-search-api`（计费档）；想走不按次计费但你自己的模型 token 的那档，需要在宿主 `dsh-web` 的配置里把 `searchProvider` 设成 `deepseek-official`。
- 查询形式是 `<host> <路径关键词>`（实测该 provider 不认 `site:` 操作符）；站点太冷门搜不到同站结果时就不出现候选，这是正常降级。

详见 `docs/tickets/027-search-fallback-navigation.md` 与仓库内 `docs/design/web-tools-and-agent-browser.md`。

### 什么时候打开面板（`activation`）

| 档位 | 行为 |
|---|---|
| `auto`（默认） | 只有需要页面的动作（`open`/`snapshot`/`click`/`type`/`press`/`scroll`/`hover`/`eval`/`zoom`/`screenshot`）才把面板展开；`browser_download` 不会打开面板 |
| `always` | 每次动作都把面板带到前台，方便你全程盯着看（`browser_download` 仍不点亮，它在后台跑，点亮也看不到过程） |
| `manual` | Agent 不替你开面板：没打开就直接报错并说明档位，适合"我要自己先开、你先别动" |

右栏没显示时面板标签拿不到页面（DSH 侧栏的结构限制），所以"后台静默跑一个看不见的浏览器"不存在；`manual` 只是把这个失败提前并说清楚。

## 该用哪个工具

优先用便宜的；只有"需要身份、需要看见、需要动手、需要留证据"才开浏览器面板。

| 场景 | 用什么 | 为什么 |
|---|---|---|
| 找网址 / 找资料在哪 | `web_search`（可带 `site:`） | 一次调用给候选，不占 vision、不开面板 |
| 读公开的静态文章 / 文档 | `web_fetch` | 匿名 HTTP + 正文转 Markdown，最便宜；内置工具读不到 JS 渲染页时再换面板 |
| 页面要登录 / 有你的账号态 | `browser_open` → 面板 | 面板用你的 Electron 登录态；`web_fetch` 不带 Cookie |
| 要点击、填表、翻页、等异步渲染 | `browser_*` 动作工具 | 只有面板能真的动页面 |
| 要人机验证 / 扫码 / 密码 | 面板 + **你来操作** | 插件只检测不绕过；密码框一律拒绝 |
| 需要"当时页面长这样"的证据 | `browser_screenshot` / `browser_snapshot` | 截图落盘带 sha256，可作为报告附件 |
| 打开失败、链接过期、站点下架 | 先用 `web_search` 找同站替代入口 | Agent 只给候选、不自动打开；也可以打开 `searchFallback` 让失败错误里直接附上同站候选（默认关，按次计费，见「配置」） |

详细论证与计费警示见仓库内 `docs/design/web-tools-and-agent-browser.md`。

### 和别的浏览器工具共存（`routing`）

一个 profile 里同时装了两套浏览器工具（例如本插件 + `dsh-pilot` 的 `pilot_*`）时，"Agent 会不会选本插件"不取决于工具描述写得好不好——技能正文与 `AGENTS.md` 的权重更高，模型会先照着它们走。

所以本插件往系统提示词里加一段分流说明（`routing`，默认 `auto`）：只在检测到另一套浏览器工具时才加，单后端 profile 完全不加。内容是事实性的一句话——**需要你的登录态、需要页面可见并由你随时接管、需要把文件带回来、需要一张留作证据的截图时，用 `browser_*`；公开静态文章用 `web_fetch` 更便宜**。

```yaml
- id: agent-browser-panel
  config:
    routing: auto   # auto | on | off
```

想彻底避免两套工具打架，最干净的做法仍是**一个 profile 只留一个浏览器后端**（见「已知限制」）。这一段只是在不得不共存时，把话说在模型一定会读到的地方。

**想知道它到底加没加**，不用猜：`/dsh-agent-browser/health` 里有一块 `diagnostics.routing`：

```json
{ "mode": "auto", "injected": true, "order": 3050, "competitors": ["pilot_navigate", "pilot_snapshot"] }
```

`injected: true` = 已注册且这次组装会带上正文；`competitors` 说明是被谁触发的。桥日志里同名的 `routing paragraph` 只在决策变化时写一条。

## 十一个工具

| 工具 | 作用 |
|---|---|
| `browser_open` | 打开一个 http(s) 地址；或传 `path` 打开工作区里的 HTML（自动起只读本地服务） |
| `browser_snapshot` | 读当前页面的无障碍树（带 `[ref=eN]`）+ 一张截图；`includeImage:false` 可省掉截图 |
| `browser_click` | 点某个 `ref`；没有可用 ref 时传 CSS `selector`（命中测试失败会分型报告 `not_found` / `multiple` / `occluded` / `disabled`）；canvas 与跨域 iframe 才用坐标（`x`/`y`，CSS 像素）。`target=_blank` 会被改成同视图导航 |
| `browser_scroll` | 滚动页面或某个容器（`dy` 像素 / `to:"top"|"bottom"` / `container` 选择器），返回位置与 `atBottom`；懒加载列表靠它触发 |
| `browser_hover` | 把指针移到元素上但不按（`ref` / `selector` / `x`,`y`），返回落点与 `grew`；叠卡、悬浮菜单这类"悬停才展开"的控件要先 hover 再点 |
| `browser_zoom` | 缩放页面（25%–300%）：`factor` 绝对值 / `delta` 步进 / `reset:true` 回 100%。缩小会给页面更宽的排版视口，桌面站才塞得进窄侧栏；面板顶部的 `− 100% ＋` 是同一个开关 |
| `browser_screenshot` | 把页面存成 PNG 文件到工作区 `screenshots/`（返回路径、尺寸、sha256）。默认**长页拼接成整页图**（自动滚动、重叠裁缝、临时隐藏 fixed/sticky 元素），`mode:"viewport"` 只存当前屏。重名加 `-1`，不覆盖 |
| `browser_type` | 往某个输入框写文字，`submit:true` 顺带回车；**密码框一律拒绝**，交给人来输 |
| `browser_press` | 按一个键或组合键；`Alt+Left` / `Alt+Right` / `F5` 会走面板的导航动作 |
| `browser_eval` | 在页面里求值（不够用时才用，永远不要用它绕过登录或验证）；可用 `evalEnabled: false` 整体关掉 |
| `browser_download` | 把一个附件（PDF/Word/Excel/zip）下到工作区 `downloads/`，返回路径、字节数与 sha256；重名自动加 `-1`，不覆盖旧文件。可执行类扩展名会被拒（`download_rejected`） |

## 接管

面板顶部有一条徽章，显示当前状态：

- `Agent 正在操作（mm:ss）`——Agent 在用
- `等待你处理（人机验证）`——检测到验证页，输入类工具被拦下
- `你已接管（mm:ss）`——你在面板里自己动手
- `空闲`——没人动

点 **「我来接管」** 之后，Agent 的 `open/click/type/press/eval` 全部会被拒绝（`browser_snapshot` 仍然可用，它要能看见你做了什么）。点 **「交还 Agent」** 时，面板会先截一张图，把「你不在时发生了什么」压缩成一行摘要交给 Agent，它下一次快照就能读到。

遇到 Cloudflare / reCAPTCHA 这类人机验证，插件**只检测、不绕过**：页面内会画一圈红框提示你，徽章转成「等待你处理」，你手动点完再交还。Agent 的调用会拿到 `needs_human`，它应当把控制权交给你而不是硬试。

## 页面自动适配面板宽度

默认 `fitWidth: true`：导航完成后（以及侧栏宽度变化时）面板会按页面的 `scrollWidth / innerWidth` 把缩放调到"整行排版塞得进侧栏"的值，只缩不放、下限 25%。这样 1200px 宽的桌面站在窄侧栏里不会只剩一列，截图也就能拍到完整的横向布局。

你手动用 `browser_zoom` 或顶部 `− 100% ＋` 调过之后，自动适配就不再插手，直到 `browser_zoom({ reset:true })` 或重开页面。

## 故障排查

| 症状 | 原因 | 处置 |
|---|---|---|
| 右侧栏里没有「浏览器（Agent）」卡片 | 插件未启用，或不在桌面端 | `plugin_manager list_plugins` 查 `include:agent-browser-panel`：`enabled` 应 true、`fiberPhase` 应 active；Web 版 profile 不支持 |
| 工具报 `panel_not_open` / 20 秒超时 | 面板标签没打开，或右栏被收起 | 点右侧栏 + 打开面板；`activation: manual` 时需你自己先开 |
| 工具突然全部变成 `unknown tool "browser_open"` | 同一 profile 里还有另一个浏览器插件（例如 CDP 原型）抢先注册了同名 `browser_*` 工具；宿主仓库里一次只能有一套 | 只启用一个：`plugin_manager list_bundles` 找到另一个 `*-browser` bundle 停用，保留 `dsh-plugin-agent-browser`，然后重启/重载。可用带令牌的 `GET /health` 看 `diagnostics.conflicts` 确认是哪一个 |
| 工具报 `session_not_allowed` | 配了 `sessions.allowlist` 且不含当前会话 | 把当前会话 id 加进名单，或清空名单 |
| 工具报 `needs_human` | 页面是人机验证墙 | 在面板里手动完成验证，再点「交还 Agent」 |
| 点击"没反应" / 截图超时 | DSH 窗口在后台或最小化，Chromium 不绘制也不收合成输入 | 把窗口切到前台再试（这是 Electron 行为，不是插件 bug） |
| 截图报 `the browser panel is hidden right now…` | 面板页签不可见 | 切到面板页签再截 |
| 打开页面报 `navigation_failed: nav_…: …ERR_…` | 网络/DNS/证书/端口被拦/页面自身错误（`nav_dns` / `nav_refused` / `nav_reset` / `nav_cert` / `nav_blocked` / `nav_timeout`…） | 失败时面板已自动回到上一页；提示 "could not go back" 才说明停在了浏览器错误页，直接 `browser_open` 一个可达地址即可。换 `web_fetch` 试一次也可以 |
| 工具报 `bridge_timeout` | 面板那一半没连上宿主桥：刚装完/刚重载的几秒内，或宿主发现路由还没就绪 | 等几秒重试；仍不行看 `plugin_manager list_plugins` 的 `fiberPhase`，并把面板页签打开（1.3.7 起发现路由会等 web server 就绪再注册） |
| `browser_eval` 报 `eval_disabled` | 配置里 `evalEnabled: false` | 需要时改回 true（即时生效） |
| 下载报 `download_rejected` | 扩展名在黑名单或超过 `downloads.maxBytes` | 确认文件类型；必要时调 `extraBlockedExtensions` / `maxBytes`（改后重载） |
| 下载拿到的是登录页而不是文件 | `browser_download` 走 host 侧 `fetch`，**不带页面 Cookie** | 登录态才可下的链接，请在面板里点（或让用户手动保存） |
| 端口占用 / 双实例冲突 | 显式把 `bridge.port` 设成了固定值 | 改回 `0`（系统分配）；静态服务一直是随机的 |
| 外部 curl 打面板通道返回 403 | 正常：通道要 Host 校验 + 每进程令牌 | 无需处理；令牌只经宿主发现路由下发给面板 |
| 重新登录 | 重启 DSH 后 cookie 丢失 / 换机器 / 站点主动过期 | 在面板里重新登录一次，本次进程内后续复用 |

## 已知限制

- 一个 profile 只能启用一个浏览器后端：两套插件都注册 `browser_*` 工具，宿主会拒绝第二次注册。启用前先用 `plugin_manager list_bundles` 停掉另一个。
- 面板视口就是侧栏宽度，可能很窄；坐标点击前建议先滚到目标附近。
- 跨域 iframe 只能给占位，里面的元素必须用坐标点。
- DSH 窗口在后台（或最小化）时，Chromium 不绘制也不接收合成输入：这时点击会"没反应"、截图会超时。把窗口切到前台即可。
- 密码框内容永不进入对话；本地服务只监听 `127.0.0.1`，只读，仅当前工作区，且需要每进程令牌。
- 相位（接管/验证）存在内存里，重装插件或重启 DSH 后回到空闲。
- `browser_click({ selector })` 会挑一个**真的能点到**采样点；整块被盖住的控件（例如只露几像素的叠卡）不猜，直接报 `occluded` 并给出遮挡者名字。这类控件先用 `browser_hover` 让它展开，再点里面的按钮。
- `browser_download` 走 host 侧 `fetch`，**不带页面 Cookie**：需要登录态才能下载的链接会拿到登录页而不是文件（结果里的 `mime` / `finalUrl` 能看出来）。
- "点了"不等于"页面动了"：会触发导航的点击（`target=_blank`、表单提交）在按下后比对 URL；没动就回 `navigated: false` 并说明可能被页面脚本接走了——这时别把"点到了"当成"成功了"。
- 页面把控件标成 disabled 用的往往是 class（`layui-disabled` 之类），不是 `disabled` 属性：这类点击照发，结果里会带 `Heads up: its class list says …`。
- **附件链接是黑洞**：`target=_blank` 的 PDF/DOC 附件点了既不导航也不落盘（Electron 当下载处理，本插件没有下载处理器）。附件一律用 `browser_download({ url })`。
- `browser_screenshot` 的整页拼接有上限：默认 `maxHeight:10000` CSS 像素、最多 16000 设备像素行，超了就停下并在结果里说 `truncated`。`fixed`/`sticky` 元素在拼接期间会被临时隐藏（否则每一帧都会重复印一遍页头），拼完恢复。面板在后台或最小化时截图会超时，和点击一样要把窗口切到前台。
- 取消（`browser_*` 调用被中断）保证的是"不再等、不再下发新命令"；**已经发到页面里的动作不会撤销**（例如已经按下的点击）。
