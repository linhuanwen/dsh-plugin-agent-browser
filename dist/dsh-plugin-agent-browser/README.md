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

- 会同时清掉 profile 的 loader 条目与包目录；面板关闭、14 个工具消失。
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
    routing: off
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
    approvals:
      mode: first-touch
      timeoutMs: 30000
      sensitiveSites: []
    dialogs:
      mode: record
```

### 完整字段表

| 字段 | 类型 | 默认值 | 生效方式 | 说明 |
|---|---|---|---|---|
| `activation` | `auto` \| `always` \| `manual` | `auto` | 即时 | 面板何时自己打开。见下文「什么时候打开面板」；未知值按 `auto` 处理 |
| `fitWidth` | boolean | `true` | 即时 | 每次导航后把缩放调到"整行排版塞进侧栏"；`false` 保持 100% 横向滚动 |
| `evalEnabled` | boolean | `true` | 即时 | 是否允许 `browser_eval` 在页面里跑任意 JS；关掉后该工具报 `eval_disabled`。给不可信页面建议关 |
| `claimBrowserUse` | boolean | `true` | 即时 | 占用宿主的 `browserUse` 互斥槽，避免第二个浏览器提供者同时驱动页面；宿主没有该接缝时自动降级 |
| `routing` | `off` \| `auto` \| `on` | `off` | 即时 | 往 Agent 的系统提示词里加一段"什么时候该用本插件"的分流说明。**由人决定开不开**：默认 `off` 什么都不加；`auto` 只在检测到**另一套浏览器工具**（`pilot_*` 或面板版 `browser_navigate` 等）时才加；`on` 总是加。见下文「和别的浏览器工具共存」 |
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
| `approvals.mode` | `first-touch` \| `off` | `first-touch` | 即时 | 写动作确认：`first-touch` = 读动作从不打扰、每个站点第一次写动作（输入 / 提交 / 下载 / 执行脚本）在面板里问一次；`off` = 与 1.4.x 完全一致、不问。见下文「写动作确认」 |
| `approvals.timeoutMs` | 整数 | `30000` | 改后重载 | 面板确认条等你作答的上限（2s–120s）；超时按拒绝处理，动作不会发出 |
| `approvals.sensitiveSites` | 字符串数组 | `[]` | 改后重载 | 每次都问的站点（主机名或 URL）；即使本会话已允许该站点也照问 |
| `dialogs.mode` | `record` \| `off` | `record` | 改后重载 | 页面调用 `alert` / `confirm` / `prompt` 时怎么办。`record` = 拦截并保守作答（`confirm` 答 false、`prompt` 答 null），把弹窗内容列在工具结果里，页面不会卡死；`off` = 原生弹窗（会冻结页面直到人去点）。见下文「JS 弹窗」 |

要点：

- **标"即时"的字段**（前五个：`activation`、`fitWidth`、`evalEnabled`、`claimBrowserUse`、`routing`，以及 `approvals.mode`）改动后不用重启插件，下一条命令就按新值走（面板在被接管时也不会被打断）。
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
| `auto`（默认） | 只有需要页面的动作（`open`/`snapshot`/`click`/`type`/`press`/`scroll`/`hover`/`eval`/`zoom`/`screenshot`）才把面板展开，且**只在这个会话还没有活面板时展开一次**，之后不动布局（你收起侧栏就保持收起）；`browser_download` 不会打开面板 |
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

所以本插件准备好了一段分流说明，但**默认不往里加**——开不开由你决定（`routing`，默认 `off`）。打开后：`auto` 只在检测到另一套浏览器工具时才加，单后端 profile 完全不加；`on` 总是加。内容是事实性的一句话——**需要你的登录态、需要页面可见并由你随时接管、需要把文件带回来、需要一张留作证据的截图时，用 `browser_*`；公开静态文章用 `web_fetch` 更便宜**。

```yaml
- id: agent-browser-panel
  config:
    routing: auto   # off（默认） | auto | on
```

更稳的做法是把这条分工写进你自己的 `AGENTS.md`（人写规则，插件不抢解释权），插件这段留着当备用。

想彻底避免两套工具打架，最干净的做法仍是**一个 profile 只留一个浏览器后端**（见「已知限制」）。这一段只是在不得不共存时，把话说在模型一定会读到的地方。

**想知道它到底加没加**，不用猜：`/dsh-agent-browser/health` 里有一块 `diagnostics.routing`：

```json
{ "mode": "auto", "injected": true, "order": 3050, "competitors": ["pilot_navigate", "pilot_snapshot"] }
```

`injected: true` = 已注册且这次组装会带上正文；`competitors` 说明是被谁触发的。桥日志里同名的 `routing paragraph` 只在决策变化时写一条。

## 设置页（设置 → 浏览器面板）

装好之后，DSH 的「设置」左侧会多一页 **浏览器面板**（在本插件启用时出现，禁用即消失）。页面把上表的配置字段做成表单，不用再手改 YAML：

| 分组 | 字段 | 保存后 |
|---|---|---|
| 行为 | `activation`、`fitWidth`、`evalEnabled`、`claimBrowserUse`、`routing` | 立即生效，不用重启 |
| 预算 | `limits.navigationTimeoutMs`、`limits.snapshotMaxChars`、`limits.evalMaxChars` | 插件重新加载一次（约 1–2 s，面板自动重连） |
| 下载 | `downloads.dir`、`downloads.maxBytes`、`downloads.extraBlockedExtensions` | 同上 |
| 搜索兜底 | `searchFallback.enabled`、`searchFallback.maxResults` | 同上 |
| 会话白名单 | `sessions.allowlist` | 同上 |
| 本地文件服务 | `static.maxBytes` | 同上 |

页面顶部直接显示现况：桥的 origin 与端口、已注册几个工具、当前几个会话持有浏览器。保存时只提交改动过的顶层字段；"需要重启"的那几组会明确提示插件正在重新加载。写配置走的是 DSH 自己的 config editor（和你在「插件」里改 YAML 是同一个通道），所以 `cordis.patch.yml` 永远不会被本插件改写。

> 如果页面底部显示"这个 profile 不能保存插件配置"，说明宿主没有给它 config editor（多见于只读或内置 profile）——此时表单只读，改配置请用 YAML。

## 十五个工具

| 工具 | 作用 |
|---|---|
| `browser_open` | 打开一个 http(s) 地址；或传 `path` 打开工作区里的 HTML（自动起只读本地服务）；`newTab:true` 时在面板里另开一个标签，当前页留在后面不丢 |
| `browser_tabs` | 列出、切换、关闭面板里的标签页（`action: "list"` / `"switch"` / `"close"`，`tab` 传标签 id）；切换保留每个标签的页面状态，关最后一个会先开一张空白页 |
| `browser_snapshot` | 读当前页面的无障碍树（带 `[ref=eN]`；能算出稳定路径时紧跟 `[loc="css:…"]`）+ 一张截图；`includeImage:false` 可省掉截图；被字符预算截断时返回 `cursor`，带 `cursor` 再调用可续读下一段（页面变了会返回 `stale_cursor`）；页面自己打印的 console/未捕获错误也会附在末尾（最多 10 条，每次快照清空），页面自己发出的 fetch/XHR 失败同样附在末尾（最多 10 条，带状态/耗时/错误与请求总数） |
| `browser_wait` | 等某个 CSS 选择器或页面文字出现（`gone:true` 等它消失），超时返回 `timedOut`；纯读、无需确认，异步加载先等再快照（默认等 10s，最长 15s） |
| `browser_click` | 点某个 `ref`；ref 过期时传快照里的 `loc="css:…"`（跨快照有效），没有可用地址时传 CSS `selector`（命中测试失败会分型报告 `not_found` / `multiple` / `occluded` / `disabled`）；canvas 与跨域 iframe 才用坐标（`x`/`y`，CSS 像素）。`target=_blank` 会被改成同视图导航 |
| `browser_drag` | 拖拽：`from` 按住一个元素，移动指针，在 `to` 松开（`from` / `to` 各传一个 `ref` / `loc` / `selector`；`to` 也可以传视口坐标 `toX`+`toY`，或相对源中心的 `dx`/`dy`）。`steps` 是中间移动步数（2–30，默认 8）。适合滑块、可排序列表、看板卡片、canvas 手柄；页面侧派发 pointer/mouse 事件序列，**原生 HTML5 drag-and-drop（`draggable="true"` 的 dragstart/drop）不覆盖**。失败分型复用 `not_found` / `multiple` / `occluded` / `disabled` / `out_of_view` |
| `browser_scroll` | 滚动页面或某个容器（`dy` 像素 / `to:"top"|"bottom"` / `container` 选择器），或按 `ref` / `loc` / `selector` 把某个元素滚进视口（返回元素 `rect`、`visible` / `fullyVisible`）；返回位置与 `atBottom`，懒加载列表靠它触发 |
| `browser_hover` | 把指针移到元素上但不按（`ref` / `loc` / `selector` / `x`,`y`），返回落点与 `grew`；叠卡、悬浮菜单这类"悬停才展开"的控件要先 hover 再点 |
| `browser_zoom` | 缩放页面（25%–300%）：`factor` 绝对值 / `delta` 步进 / `reset:true` 回 100%。缩小会给页面更宽的排版视口，桌面站才塞得进窄侧栏；面板顶部的 `− 100% ＋` 是同一个开关 |
| `browser_screenshot` | 把页面存成 PNG 文件到工作区 `screenshots/`（返回路径、尺寸、sha256）。默认**长页拼接成整页图**（自动滚动、重叠裁缝、临时隐藏 fixed/sticky 元素），`mode:"viewport"` 只存当前屏。重名加 `-1`，不覆盖 |
| `browser_type` | 往某个输入框写文字（`ref` 或 `loc` 定位），`submit:true` 顺带回车；**密码框一律拒绝**，交给人来输 |
| `browser_press` | 按一个键或组合键；`Alt+Left` / `Alt+Right` / `F5` 会走面板的导航动作 |
| `browser_upload` | 把工作区里的文件放进页面的 `<input type=file>`（`ref` / `loc` / `selector` 定位，`files` 是工作区相对路径数组）。写动作、站点首次确认；单文件 2 MiB、合计 4 MiB、最多 5 个，路径出工作区会被拒（`upload_rejected`） |
| `browser_eval` | 在页面里求值（不够用时才用，永远不要用它绕过登录或验证）；可用 `evalEnabled: false` 整体关掉 |
| `browser_download` | 把一个附件（PDF/Word/Excel/zip）下到工作区 `downloads/`，返回路径、字节数与 sha256；重名自动加 `-1`，不覆盖旧文件。可执行类扩展名会被拒（`download_rejected`） |

## 接管

面板顶部有一条徽章，显示当前状态：

- `Agent 正在操作（mm:ss）`——Agent 在用
- `等待你处理（人机验证）`——检测到验证页，输入类工具被拦下
- `你已接管（mm:ss）`——你在面板里自己动手
- `空闲`——没人动

点 **「我来接管」** 之后，Agent 的 `open/click/drag/type/press/eval` 全部会被拒绝（`browser_snapshot` 仍然可用，它要能看见你做了什么）。点 **「交还 Agent」** 时，面板会先截一张图，把「你不在时发生了什么」压缩成一行摘要交给 Agent，它下一次快照就能读到。

遇到 Cloudflare / reCAPTCHA 这类人机验证，插件**只检测、不绕过**：页面内会画一圈红框提示你，徽章转成「等待你处理」，你手动点完再交还。Agent 的调用会拿到 `needs_human`，它应当把控制权交给你而不是硬试。

## 写动作确认（`approvals`，默认开启）

这块浏览器带着你的登录态，Agent 会在你没看的时候往里写字，所以默认姿势是：**读动作从不打扰，写动作每个站点第一次问一次**。

- **不问**（读动作）：`browser_open`、`browser_snapshot`、`browser_wait`、`browser_scroll`、`browser_hover`、`browser_zoom`、`browser_screenshot`、`browser_tabs({action:"list"})`，以及点到普通链接/按钮的 `browser_click`。
- **要问**（写动作）：`browser_type`（密码框本来就一律拒绝）、`browser_click` 命中提交类控件（`button[type=submit]`、`input[type=submit|image]`、表单里没有 `type` 的按钮）、`browser_drag`（拖拽可能是排序/提交滑块，无法预判，一律按写动作）、表单内的 `browser_press` Enter、`browser_eval`、`browser_download`、`browser_upload`。
- 面板顶部会弹一条黄色确认条：`Agent 想在 example.com 点击「提交」提交表单` + 倒计时 +「允许一次」「本会话允许本站」「拒绝」。**Enter = 拒绝**（反射性按键不该等于同意），快捷键 Alt+1 / Alt+2 / Alt+3。
- 拒绝或超时（默认 30 秒）：动作**不会发出**，Agent 拿到 `approval_denied` / `approval_timeout`。面板没打开或窗口不可见：`approval_required`，Agent 应当先请你打开面板，而不是干等。
- 粒度是「会话 + 站点」：换个站点重新问，会话结束作废；`approvals.sensitiveSites` 里的站点每次都问。你点「我来接管」时，未作答的确认自动按拒绝处理。
- 想完全回到 1.4.x 的无声行为：`approvals.mode: off`。
- **结果带三态 `effect`**：写动作成功时是 `committed`；在命令离开宿主前被拦下（参数、审批、策略、相位）是 `none`，重试安全；面板已经把命令拉走、回执却丢了（超时/取消/接管/插件停止）是 `unknown`——工具报 `action_unknown`（`retryable:false`），Agent 必须先 `browser_snapshot` 核对页面，**不要重发同一动作**。`submit` / `download` / `eval` / `upload` 尤其按未知处理（SPEC-004 §4 B4）。

## JS 弹窗（`dialogs`，默认拦截并记录）

页面里的 `alert` / `confirm` / `prompt` 会冻结渲染进程，直到有人点掉系统弹窗；Agent 在没人看的侧栏里遇到它们，所有工具就会一起挂到超时。默认行为是**拦截并记录**（TICKET-041）：

- `alert` → 直接返回，页面继续跑；`confirm` → 按「否」处理；`prompt` → 按「取消」处理。这三种都是保守答案，页面不会因为 Agent 擅自同意而继续。
- 弹窗内容会出现在随后那次操作的结果里（`blocked dialogs` 一栏），Agent 因此知道"页面问过什么、我答了什么"，而不是把它当成无事发生。
- 这些弹窗**不会**被自动升级成写动作审批：真正的写动作（输入/提交/下载/执行脚本）仍走上面的确认条；弹窗只是被记录。
- 想恢复原生行为（自己点弹窗）：`dialogs.mode: off`。此时页面会被弹窗冻结，直到你在面板里点掉——不建议开着它让 Agent 跑。

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
| 工具报 `approval_required` | 写动作需要你确认，但面板没开或窗口不可见 | 点开右侧栏「浏览器」面板，让确认条出现后重试 |
| 工具报 `approval_timeout` | 确认条 30 秒内没作答 | 重试，并在确认条上点「允许一次」或「本会话允许本站」 |
| 工具报 `approval_denied` | 你点了拒绝，或点了「我来接管」 | 想让它做就重试并允许；不想就让它换个做法（`approvals.mode: off` 可整体关闭） |
| 工具报 `action_unknown` | 写动作（点击/输入/按键/脚本）已经被面板拉走，但回执在超时、取消、接管或插件重载时丢了 | 页面**可能已经变了**：先 `browser_snapshot` 看状态，再决定下一步；不要直接重发同一动作 |
| 工具报 `stale_cursor` | 快照续读用的 `cursor` 过期了：页面在两次快照之间变了（导航、列表增删、DOM 重渲染） | 重新 `browser_snapshot`（不带 `cursor`）拿一份新快照，再用它返回的新 `cursor` 续读 |
| 工具结果里出现 `blocked dialogs` | 页面调用了 `alert` / `confirm` / `prompt` | 正常现象：已按保守答案处理并记录，页面没有卡死。想看真实弹窗内容就把 `dialogs.mode` 设为 `off`，但那会冻结页面直到你手动点掉 |
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
- 写动作确认按「站点」判断，不是按「这一页是否登录后」：面板读不到 HttpOnly Cookie，无法判断登录状态，所以规则是"每个站点第一次写动作问一次"（见 SPEC-003 / 决策 010）。
- 确认只覆盖四类已知写动作（输入、提交、下载、执行脚本）。页面自己接住的副作用（例如"加入购物车"这类 AJAX 按钮）按普通点击处理，不触发确认。
