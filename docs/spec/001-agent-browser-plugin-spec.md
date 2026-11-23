# SPEC-001：侧边框 Agent 浏览器插件

- 状态：已定稿，待探针验证
- 版本：v1 草案（2026-11-19）
- 关联决策：`docs/decisions/001-grilling-decisions.md`（D01–D10）
- 关联取证：`docs/cases/001-dsh-browser-internals.md`
- 关联边界：`docs/design/web-tools-and-agent-browser.md`（内置 `web_search` / `web_fetch` 与本插件的分工：不抢"发现"，只管"动手"）
- 目标运行环境：DeepSeek Harness 桌面端 `0.2.2-rc.3`（Windows，Electron，`webviewTag` 开启）

---

## 1. 目标与非目标

### 1.1 目标

1. 在 DSH 桌面端**右侧栏**新增一个浏览器面板，用户可以像用浏览器一样看页面（地址栏、后退前进、刷新）。
2. **Agent 能操作这个面板里的页面**：打开网址、读页面结构、点击、输入、按键、执行 JS、截图。
3. 用户**随时可以接管**：一个按钮拿走控制权，自己过验证/登录/拖地图，再交还给 Agent 继续。
4. 全程**可见**：Agent 每做一步，用户能在面板里看到页面真的动了。这是本项目的产品核心，不是附属效果。

### 1.2 非目标（明确不做）

| 不做 | 原因 |
|---|---|
| 自动过验证 / 绕 CAPTCHA / 打码平台 | 绕过他人访问控制；与 `AGENTS.md:9` 冲突（D03） |
| 指纹伪装 / stealth 注入 / 伪造设备 token | 同上，且属军备竞赛 |
| 每个会话多标签（真浏览器式 tab 管理） | v2 再谈，v1 预留 `tabId` 字段（D02） |
| 下载文件 | 一律拦，提示用系统浏览器（D07） |
| HTTP Basic Auth 登录 | 主进程已 deny 该事件，无法支持 |
| 修改 DSH 官方包 / asar 内代码 | 升级即失效，不可维护（D07） |
| 无头运行 | 面板必须是可见窗口，否则产品目标落空 |
| 自建搜索索引 / 新增搜索类工具 | DSH 已有 `web_search` / `web_fetch`（`ctx.web` seam），负责"发现 + 快读"；本插件的增量价值是登录态、动手与证据。重复实现只会让模型在近义工具间乱选（分工与证据见 `docs/design/web-tools-and-agent-browser.md`，约束见 SPEC-002 B11） |

---

## 2. 用户看到的形态

```
┌─ 右侧栏 ────────────────────────────────┐
│ [浏览器（Agent）] [其他 tab] ...          │
├─────────────────────────────────────────┤
│ ← → ⟳  https://example.com      ⧉ 复制   │  ← 地址栏（只读显示）
├─────────────────────────────────────────┤
│ ● Agent 正在操作 · 第 3 步               │  ← 状态徽章
├─────────────────────────────────────────┤
│                                         │
│          （真实网页 webview）             │
│                                         │
├─────────────────────────────────────────┤
│              [ 我来接管 ]                │  ← 接管按钮
└─────────────────────────────────────────┘
```

**状态徽章四态**

| 状态 | 徽章文案 | 按钮 | 颜色 |
|---|---|---|---|
| `idle` | `● Agent 正在操作` | 「我来接管」 | 蓝（agent 主色） |
| `awaiting_human` | `● 需要你完成验证` | 「我来接管」 | 琥珀 |
| `taken_over` | `● 你已接管 00:12` | 「交还 Agent」 | 绿 |
| `error` | `● 页面打不开（原因）` | 「重试」 | 红 |

**接管期间**：webview 获得 focus，Agent 一切输入类调用返回 `taken_over`；页面里若有被检测到的 challenge 元素，画一圈红框 + 「点这里」气泡。

---

## 3. 架构

```
┌──────────────── Host 进程（Node）────────────────┐
│  dsh-plugin-agent-browser (host 面)              │
│   ├─ 注册 7 个 browser_* 工具                     │
│   ├─ 每条会话一份 BrowserSession 状态              │
│   │    { tabId, phase: idle|awaiting_human|       │
│   │      taken_over|error, queue, pending }       │
│   └─ 命令队列 + pending promise 表                 │
└───────────────┬─────────────────────────────────┘
                │ Typert Remote（client ↔ host）
                │ host 写命令 → client 拉取并回填结果
┌───────────────┴─────────────────────────────────┐
│  dsh-plugin-agent-browser (client 面, platform:web)│
│   ├─ ctx.sidebarRightTabs.register({kind:'agent-browser'})│
│   ├─ 面板 body：地址栏 / 徽章 / webview / 接管按钮  │
│   ├─ 轮询或订阅命令队列 → 在 guest 里执行          │
│   └─ executeJavaScript / sendInputEvent / capturePage│
└───────────────┬─────────────────────────────────┘
                │ Electron <webview>（租约）
┌───────────────┴─────────────────────────────────┐
│  主进程 lib/main.js（官方，不改）                  │
│   ├─ acquire/release 租约，partition 分配          │
│   ├─ will-attach-webview 校验（src=about:blank#id）│
│   └─ allowedNavigation：只放行 http/https          │
└─────────────────────────────────────────────────┘
```

### 3.1 为什么必须"客户端执行"

页面活在渲染器里的 `<webview>` 中。host 进程没有任何句柄能碰它：
- `DesktopBrowserBridge` 只暴露 `acquire/release/onOpenRequested`，注释明说 *"no Electron objects or arbitrary IPC cross this interface"*；
- 主进程**没有任何** `executeJavaScript` 调用点（全文 0 次命中）；
- 唯一能做 DOM 操作的位置，是渲染器里持有 webview 元素的那段代码。

所以：**工具在 host，执行在 client**，中间必须有一条自建通道。

### 3.2 通道设计（关键未知点，探针先验）

Typert Remote 的天然方向是 **client → host**（客户端调宿主方法）。而我们要的是 **host → client**（工具让面板干活）。两条实现路径：

| 方案 | 机制 | 何时用 |
|---|---|---|
| **A. 队列 + 拉取（兜底，默认先做）** | 工具把命令推进 host 侧队列并返回一个 Promise；客户端每 **100ms** 调一次 `remote.pull(sessionId)` 取命令；执行完调 `remote.complete(commandId, result)`；host 解 Promise | 不依赖任何不确定的推送能力，一定能work |
| **B. 事件推送（优选，若能验通）** | 用 DSH 的 scoped Remote Event 由 host 主动推 `command` 给客户端 | 若探针/骨架阶段确认 typert 支持 server→client 事件 |

**决策规则**：骨架阶段先做 A（保守），若在 `@deepseek-ai/dsh-api-*` 里找到现成的 server→client 事件通道，再换 B；两者对外接口一致，替换只发生在通道层。

**代价**：A 的每次动作多约 50–100ms 延迟。对 Agent 浏览器来说可接受（单步人类操作本身要几百毫秒）。

---

## 4. 面板规格（client 面）

### 4.1 tab 类型注册

字段以真实类型为准。已按 DSH `0.2.2-rc.3` 的 asar 源码核对（`@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts:94-139`，2026-11-19）：

```ts
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: 'agent-browser',            // 全局唯一；重复注册会抛错
  kind: 'agent-browser',
  priority: 'extension',          // 不抢 builtin 的 'browser' kind
  multiple: true,                 // 同一 pane 内允许并存多个
  keepMounted: true,              // 切 tab/切会话不销毁 DOM（保住页面状态）
  title: () => '浏览器（Agent）',   // 必填，且是 thunk：每次渲染重新取
  canOpen: (address) => address.startsWith('agent-browser://'),
  guide: [{                       // 省略 guide = 不出现在引导页 = 用户没有入口
    id: 'new',
    order: 30,
    title: () => '浏览器（Agent）',
    description: () => '在这个面板里打开网页，让 Agent 操作',
    commandId: 'agent-browser.new',   // 可选；需另有命令实现
  }],
}), 'agent-browser: type')
```

- **不要写 `titles: { zh, en }`，也没有顶层 `icon`**：`SidebarRightTabDefinition` 里没有这两个字段。`title` 是必填函数，`icon` 只存在于 `guide[]` 条目里。写错会**抛错**（不是静默降级）——`register()` 在字段非法/ id 重复 / 同 band 同 kind / 命中 fallback 时都会抛。
- `register()` 返回 disposer，必须包进 `ctx.effect(fn, 'label')`。官方实样见同目录 `index.ts:74`。
- **打开入口**：`ctx.sidebarRight.openTab(kind, { params })`（`service.ts:198-201` 定义选项、`243-249` 定义方法；选项 = placement + `params`）。`guide` 条目只负责"显示在引导页"，`commandId` 要另外实现命令；v1 直接让工具侧调 `openTab` 打开即可。
- **不接管**官方 `browser` kind（`priority: 'extension'` 但 kind 名不同），两个面板并存互不影响。
- **会话隔离**不是靠"注入"拿 `sessionId`：在 body 的 slot 注册里由框架以 `inject(sessionId, actions)` 传入，每个 session 一份 controller（`Map<sessionId, ...>`），与官方面板同构：

```ts
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: 'agent-browser',
  locale: 'agent-browser',                        // i18n namespace
  store,                                          // 本插件自己的 store 单例（跨会话共享）
  inject: (sessionId, actions) => controllerFor(sessionId, actions),  // 每会话一份
}, BrowserBody))
// 标题另注册一处：
ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab.title', key: 'agent-browser', store }, BrowserTitle))
```

（body / title 两处 slot 注册的官方实样：`index.ts:82-95`、`index.ts:102-104`。）

### 4.2 body 结构

| 区块 | 内容 | 行为 |
|---|---|---|
| 地址栏 | 当前 URL（只读文本）+ 复制按钮 | 用户不可编辑（编辑权归 Agent 与接管态） |
| 工具条 | 后退 / 前进 / 刷新 | 复用 `webview` 的 `goBack/goForward/reload` |
| 状态徽章 | 四态文案 + 计时器（接管时） | 见 §2 |
| webview 容器 | Electron `<webview>` | 见 §4.3 |
| 接管按钮 | 「我来接管」/「交还 Agent」/「重试」 | 切换 phase |

### 4.3 webview 挂载（照官方做法复刻）

```ts
const reservation = await globalThis.dshDesktop!.browser!.acquire(workspaceKey)
const el = document.createElement('webview')
el.setAttribute('name', reservation.lease)          // 关键：租约 id 作为 name
el.setAttribute('partition', reservation.partition) // 关键：partition 必须一致
el.setAttribute('src', `about:blank#${reservation.lease}`) // 关键：bootstrap 地址
container.appendChild(el)
```

三条缺一不可，否则主进程 `will-attach-webview` 直接 `preventDefault()`，页面永远白屏。
`keepMounted: true` 保证切 tab/切会话时 DOM 不被销毁 → 页面状态、滚动位置、登录态都在。

---

## 5. 工具契约（host 面）

统一约定：
- 工具名前缀 `browser_`；参数为严格对象；返回体是 JSON 文本（模型可解析）。
- 每个工具都有可选 `tabId`（v1 忽略）；不带则作用于"本会话的 agent tab"，没有就报 `no_tab`（`browser_open` 例外，它会建）。
- 超时：导航 15s，`eval`/`snapshot` 5s，其他动作 10s。
- 同一 tab 内动作串行（队列），不同 tab 并行。
- **与内置联网工具的分工**：`browser_open` 的描述必须写明"公开静态页先试 `web_fetch`；要登录 / 要动手 / 要证据才开面板"。理由是读一篇公开文章用面板会白烧视觉 token，且模型默认不知道这条边界（依据 `docs/design/web-tools-and-agent-browser.md`，验收见 SPEC-002 B11）。

### 5.1 `browser_open`

```
browser_open({ url?, path?, tabId? })
```
| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string | 目标网址；无 scheme 时补 `https://`；走 §7 校验 |
| `path` | string | 本地文件绝对路径；内部起临时静态服务后导航（见 §8.3） |

返回 `{ ok, url, title, phase }`。
错误：`blocked_url`（含被拒原因 `protocol`/`credentials`/`application-origin`/`invalid`）、`timeout`、`needs_human`（页面出现验证，转到接管等待）、`taken_over`。

### 5.2 `browser_snapshot`

```
browser_snapshot({ includeImage?, maxChars?, tabId? })
```
| 参数 | 默认 | 说明 |
|---|---|---|
| `includeImage` | `true` | 是否附图（D08） |
| `maxChars` | `8000` | 文本树预算，上限 20000 |

返回 `{ ok, url, title, gen, text, refCount, truncated, image? }`。
`text` 是带 `[ref=eN]` 的缩进树（格式见 §6.4）；`gen` 是本次快照代次（新 ref 与之绑定）。

### 5.3 `browser_click`

```
browser_click({ ref?, x?, y?, nth?, tabId? })
```
- `ref` 与 `x/y` 二选一。`ref` 存在时走快照定位；否则按坐标点。
- `nth`：同 ref 多命中时的序号（默认 0）。
- 坐标是 **webview 视口内 CSS 像素**（左上角为原点）。

返回 `{ ok, target }`（target 描述实际命中的元素，便于模型确认）。
错误：`stale_ref`（代次不匹配或元素消失）、`out_of_view`（坐标越界）、`taken_over`。

### 5.4 `browser_type`

```
browser_type({ ref, text, submit?, clear?, tabId? })
```
- 先 focus 元素 → 全选清空（`clear` 默认 true）→ 逐字输入 → 可选回车。
- **命中 `input[type=password]` 时直接返回 `needs_human`**，不写任何字符（D07）。
- 返回 `{ ok, ref }`。

### 5.5 `browser_press`

```
browser_press({ key, tabId? })
```
- 支持 `Enter` / `Tab` / `Escape` / `Space` / 方向键 / `Alt+Left`（后退）/ `Alt+Right`（前进）/ `F5`（刷新）。
- 返回 `{ ok }`。
- **注**：后退/前进/刷新优先用快捷键实现以省工具位；若探针发现 guest 收不到快捷键，v1.1 增加 `browser_open({ op })`。

### 5.6 `browser_eval`

```
browser_eval({ script, awaitPromise?, tabId? })
```
- 在页面**主世界**执行 `script`（字符串，作为 async 函数体包一层）。
- 返回值必须可 JSON 序列化；超过 8000 字符截断并标 `truncated`。
- 定位：逃生口。取接口返回值、读诡异控件的值、绕过无法点击的组件。
- 返回 `{ ok, value, truncated }`。

### 5.7 `browser_screenshot`

```
browser_screenshot({ fullPage?, width?, tabId? })
```
- `fullPage` 默认 `false`；`width` 默认 `768`（D08）。
- 返回图片（`capturePage()` 后按需 resize；`fullPage` 时先量 `scrollHeight` 再分段拼接）。
- 不落盘（D08）。

---

## 6. 快照引擎规格

### 6.1 注入方式

`webview.executeJavaScript(<stringified IIFE>)`，返回 JSON 字符串再解析。**主世界执行**，不受页面 CSP 限制。

### 6.2 遍历规则

1. 从 `document.documentElement` 深度优先。
2. **跳过不可见**：`display:none`、`visibility:hidden`、`opacity:0`、`aria-hidden="true"`、尺寸为 0 且非 `position:fixed` 的容器——但**不因 parent 跳过而跳过子孙**（很多站点用 `overflow:hidden` 容器装真控件）。
3. **纳入节点**三类：
   - 可交互：`a[href]`、`button`、`input`、`select`、`textarea`、`[role=button|link|checkbox|radio|tab|menuitem|combobox|textbox|switch]`、`[onclick]`、`[contenteditable]`；
   - 结构：`h1..h6`、`table/thead/tbody/tr/th/td`、`ul/ol/li`（仅当含文本）、`nav/main/aside/footer`（角色标注）；
   - 有语义文本的直接文本节点（长度 1–200，去空白后非空）。
4. **role 推断**：显式 `role` 属性优先；否则按 tag → role 映射表（`a`→link、`button`→button、`input[type=text]`→textbox、`input[type=checkbox]`→checkbox、`select`→combobox…）。
5. **name 推断**：依次取 `aria-label` → `aria-labelledby` 指向的文本 → `alt` → `title` → `placeholder` → 关联 `<label>` → 内部可见文本 → `value`（按钮类）。截断到 120 字符。
6. **状态标记**：`checked` / `disabled` / `expanded` / `selected` / `required` / `readonly`，以及 `value`（input/select 用 `[value="..."]`，密码框只输出 `[value=***]`）。

### 6.3 ref 规则

- 每个被输出且可交互的节点打 `data-dsh-ref="e<N>"`，N 在同一代次内自增。
- 代次号写在 `document.documentElement.dataset.dshGen`。
- 动作时先比对 `data-dsh-gen` 是否等于模型持有的 `gen`：不等 → `stale_ref`（提示重新 snapshot）。
- 同源 iframe：递归注入，ref 前缀 `f{n}`（`f1e2`）。

### 6.4 输出格式示例

```
- page "Example Domain" url=https://example.com
  - heading "Example Domain" [ref=e1]
  - paragraph "This domain is for use in illustrative examples..."
  - link "More information..." [ref=e2]
  - textbox "Email" [ref=e3] required
  - checkbox "记住我" [ref=e4] checked
  - button "登录" [ref=e5]
  - iframe "https://maps.example.com" [跨域，请用坐标点击]
```

缩进两空格一层；行内不换行；总长超过 `maxChars` 时按行截断并置 `truncated: true`。

### 6.5 与截图的配合

`includeImage: true` 时同一响应带 `image`。**分工**：文本树负责"结构 + 精确点位"，截图负责"布局、canvas、验证码、意外弹层"。Agent 指南里写明"文本树说不清时看截图"。

---

## 7. 安全与边界

### 7.1 URL 校验（客户端侧，照抄官方规则）

```ts
function parseBrowserAddress(input: string, applicationOrigin?: string):
  | { ok: true, target: { kind: 'http' | 'https', url: string } }
  | { ok: false, reason: 'empty' | 'invalid' | 'protocol' | 'credentials' | 'application-origin' }
```
- 无显式 scheme 时补 `https://`
- 拒绝带 `username/password` 的 URL
- 只放行 `http:` / `https:`
- 拒绝当前 DSH 文档 origin
- 长度上限 16 KiB

### 7.2 主进程侧（不可改，只能接受）

- `allowedNavigation(url)`：只放行 `http`/`https`，拒凭据，拒 DSH 应用主机（端口相同且 hostname 为 DSH 主机或 loopback）。
- `will-frame-navigate` / `will-redirect` 对主框架导航强制校验。
- guest 的 `login`（Basic Auth）事件被 deny；嵌套 webview 被 deny；弹窗只放行无 body 的 GET 且需 `allowedNavigation` 通过。

### 7.3 密码

`browser_type` 命中 `input[type=password]` → 立即返回 `needs_human`，字符一个都不写。密码只经用户的手，不进模型上下文。

### 7.4 下载

v1 一律拦（监听 `will-download` 或依赖主进程默认 deny），返回提示"用系统浏览器打开"。

### 7.5 本地文件（§8.3）

只读静态服务，绑 `127.0.0.1`，随机端口，**只暴露目标文件所在目录**，拒绝 `..` 穿越，tab 关闭即 `kill`。

---

## 8. 运行时行为

### 8.1 会话与 tab 生命周期

| 事件 | 行为 |
|---|---|
| 本会话首次 `browser_open` | 创建 tab 类型实例 → `ctx.sidebarRight.openTab('agent-browser', {...})` → **自动展开右侧栏** |
| 切会话 | 各会话各自 tab（`keepMounted` 保 DOM）；切回来页面还在原处 |
| 关闭 tab | 释放租约（`release(lease)`）、停静态服务、清会话状态 |
| 会话结束 | 同上 |
| 应用重启 | 页面不恢复（Electron 不保留 guest 内存）；tab 壳保留，显示"上次的地址，点此重新打开" |

### 8.2 失败与恢复

- webview `did-fail-load` → phase=`error`，徽章显示原因，工具返回 `timeout` 或 `blocked_url`。
- guest 崩溃（`crashed`）→ 重建 webview（重新 acquire 租约）。
- 命令超时 → 标记该命令 `timeout`，客户端若迟到回填则丢弃（id 去重）。
- 接管发生时正在飞行的输入类命令 → 立即 resolve 为 `taken_over`，客户端执行前再校验一次 phase（双保险）。

### 8.3 本地静态服务

```
browser_open({ path: 'D:/work/report.html' })
→ 若无服务：spawn 只读 server（127.0.0.1:0，即随机端口）
→ root = dirname(path)，仅此目录
→ 导航到 http://127.0.0.1:<port>/report.html
→ tab 关闭时 server.close()
```
- 实现：Node 内置 `node:http` + `node:fs`，白名单化路径，`decodeURIComponent` 后必须 `path.resolve` 仍在 root 内。
- 端口必须 ≠ DSH 端口（否则被 `isApplicationHost` 拦）。
- 失败（端口不可用/权限）→ 返回提示，让 Agent 自行 `python -m http.server`。

### 8.4 验证检测（不做绕过）

- 检测信号：URL 命中已知验证域名（`challenges.cloudflare.com`、`hcaptcha.com`、`recaptcha`）、DOM 命中选择器（`#challenge-form`、`iframe[src*=turnstile]`、`[data-sitekey]`）、标题命中关键词（`Just a moment`、`Attention Required`）。
- 命中 → phase=`awaiting_human` → 徽章琥珀 + 在命中元素外画红框 → 当前工具调用返回 `needs_human`。
- 用户点「我来接管」→ `taken_over`；完成后点「交还 Agent」→ `idle`，Agent 从断点继续。
- **任何情况下不自动填充、不自动点击 challenge，不接第三方打码。**

---

## 9. 非功能要求

| 项 | 要求 |
|---|---|
| 快照耗时 | 普通页面 < 300ms；节点数 > 5000 时按预算截断而非全量返回 |
| 单步动作延迟 | < 150ms（不含网络） |
| token 预算 | 一次 snapshot 文本 ≤ 8000 字符 + 一张 768px 图 |
| 并发 | 同 tab 串行，多 tab 并行；同一时刻只有一个工具在改动页面 |
| 取消 | 用户接管 / 工具超时 / 会话中断，三者都能中断在飞命令 |
| 不污染宿主 | 不改 DSH 官方包，不动 `~/.dsh` 里的其他插件配置 |

---

## 10. 验收标准（端到端）

- [x] A1 右侧栏出现「浏览器（Agent）」tab，点开是空白浏览器面板
- [x] A2 Agent 调 `browser_open('https://example.com')` → 面板自动展开、页面真实加载、徽章显示"Agent 正在操作"
- [x] A3 Agent 调 `browser_snapshot` → 返回带 `[ref=eN]` 的树 + 截图；`Ref` 数量 > 0
- [x] A4 用 ref 点击页面里的链接 → URL 变化，二次 snapshot 反映新页面
- [x] A5 表单填入 + 提交 → 页面跳转，`type` 不碰密码框（**修正**：返回 `needs_human` 工具级错误，不切换相位）
- [x] A6 `browser_open` 到百度地图 → 用坐标 `click` 与 `press` 能缩放/拖动（canvas 场景）——**修正**：改用本地 canvas 夹具覆盖同一机制
- [x] A7 用户点「我来接管」→ Agent 的 `click` 返回 `taken_over`；用户操作后点「交还」→ Agent 恢复且页面未刷新
- [x] A8 打开一个带 Turnstile 的页面 → 徽章转琥珀、红框标出、工具返回 `needs_human`；用户手动通过后 Agent 继续——**修正**：用夹具覆盖三类信号，未刻意触发真实 CF 验证
- [ ] A9 `browser_open({path})` 打开本地 HTML → 静态服务起来、页面渲染、~~关 tab 后端口释放~~——**修正**：端口随插件生命周期释放，同一工作区复用，不随 tab 关闭
- [x] A10 `file://` 与 DSH 自身地址（`http://127.0.0.1:8738`）均被拒绝，返回明确原因（前者在工具层拦截，后者由主进程 `ERR_FAILED` 拒绝）
- [x] A11 切会话再切回 → 页面仍在原处（`keepMounted` 生效）
- [x] A12 重启应用 → tab 壳还在，提示"重新打开"（不假装恢复）——**2026-11-23 16:1x 实测通过**：重启后侧栏无残留壳、插件 `/health` 零状态恢复（`clients:0`、`states:[]`），首次 `browser_open` 一把成功；记录见 `docs/cases/010-validation-cases.md` V11 节「重启实测记录」与 `docs/cases/009-spec-audit.md` §10 表
- [x] A13 代码里搜不到任何自动过验证/打码相关实现（人工审计）
- [x] A14 **下载落盘**：在详情页点 `.pdf` / `.doc` / `.docx` 附件（或对附件 href 直接下载）→ 文件**真实写入** `<workspace>/downloads/`，工具返回 `{path, bytes, sha256, mime}`；失败时返回 `download_failed` 并**明说未下载**，禁止用正文摘要冒充附件内容（对应用例 T4 / T5）
- [x] A15 **新窗口策略**：`target="_blank"` 链接与 `window.open()` **不弹独立窗口**——行为固化为"同视图导航"，或返回 `blocked_new_window {url}` 让 agent 显式 `browser_open`；其后快照里的 URL 必须与实际视图一致（对应用例 T7）
- [x] A16 **悬停展开**：`browser_hover({ref|selector|x,y})` 能发出**真实指针移动**（不是合成事件），返回落点与 `grew`；对"悬停才展开"的叠卡控件（百度地图右下切换模块）先 hover 容器再点其中一张卡，能真正生效（对应用例 V12 第 3 步 / T1 详情页筛选器）
- [x] A17 **面板缩放**：`browser_zoom({factor|delta|reset})` 与面板顶部的 `− 100% ＋` 能改变页面在面板里的渲染比例（25%–300%）；缩小后页面的 `innerWidth` **真的变大**（拿到更宽的排版视口，而不是把画面缩小），且缩放后 `browser_click` 仍能点中目标；对应用例：把桌面站（天地图类）塞进窄侧栏
- [x] A18 **激活档位**：插件配置 `activation` 有 `auto`（默认）/ `always` / `manual` 三档，改档只改 profile 的配置行、不动代码。`auto`＝只有需要页面的动作（open/snapshot/click/type/press/scroll/hover/eval/zoom）才展开右栏，`browser_download` **永不**展开；`always`＝每次动作都把面板带到前台；`manual`＝agent 不展开，面板没开时**立即**报错并说清原因，而不是先等 5 秒挂载超时
- [x] A19 **宽度自适应与整页截图**：① 每次导航后默认把页面缩小到"排版宽度 ≤ 面板宽度"（`fitWidth`，可关），让桌面站在窄侧栏里不留横向滚动条；面板宽度变化时自动重算。② `browser_screenshot({name|mode|maxHeight|overlap})` 对长页面**滚动拼接**成立（不是只截首屏），图片真实落盘 `<workspace>/screenshots/` 并回 `{path, bytes, sha256, width, height, frames, truncated}`；`fixed`/`sticky` 元素在拼接时被隐藏，不会每帧重复（对应用例 R8 的列表图/详情图）

> **增补说明（2026-11-20）**：A14 / A15 由任务级案例集（`docs/cases/011-task-cases.md` 的 T4 / T7）暴露的缺口新增。审 T 系列时用代码核实过：`dist/dsh-plugin-agent-browser/` 全量 grep `will-download|downloadURL` 与 `setWindowOpenHandler|will-navigate` 均 0 命中。
> **A14 实现状态**：✅ `1.0.5` 已实现并装进 profile（`downloads.js` + `browser_download`），单测 18/18；真站《公平竞争审查条例实施办法》PDF 1,492,642 B / DOC 103,936 B 落盘 `downloads/`，`sha256` 与 `Get-FileHash` 双向一致，同 URL 重下得 `-1.pdf` 且不覆盖。
> **A15 实现状态**：✅ `1.0.11` 实现，`1.0.14` 装机复验通过（TICKET-009）。`a[target=_blank]` 点击前改成 `_self`，结果附 `targetFixed`；`window.open` 补丁返回 `null` 并把 URL 挂在**下一次成功动作**结果的 `blockedNewWindow` 上（1.0.14 修：中途一次失败动作不再把这条警告吞掉）。夹具实测：`#blank` → 同视图跳到 `demo/index.html` 且快照 URL 同步；`#pop` → `window.open was blocked: https://example.com/from-fixture`，无新窗口出现。
> **A15 边界**：被脚本 `a.click()` 触发的 `target=_blank`（非工具点击路径）不经过 `neutralizeTarget`，仍依赖 `window.open` 补丁兜底；页面若自行 `location.assign` 则属同视图导航，本就不弹窗。
> **A15 补强（1.0.21 / 1.0.22，TICKET-011）**：① 表单路径也纳入——捕获阶段改写 `form[target]`，并给 `HTMLFormElement.prototype.submit` 打补丁（1688 的搜索按钮在表单外、脚本直接 `submit()`，不触发 `submit` 事件）；② "假成功"必须被揭穿——需要导航的点击在按前按后比对 `location.href`，结果带 `navigated:false` 并由工具文案直说"地址没变，这一下没去任何地方"；③ 商品卡这类"整块 `<a>` + 中心 hover 工具条"的控件，`pickPoint` 先找元素自己接到的点，`height > 120` 的链接先试上沿 15%（图片区，按压冒泡到链接）。实测：1688 首页搜索 → `s.1688.com/selloffer/offer_search.htm?keywords=…`；卡片 → `detail.1688.com/offer/724632396590.html`，`__dshBlocked` 为空。
> **A16 实现状态**：✅ `1.0.19` 实现并装机（TICKET-010，`HOST_REV 21`）。做法＝页面侧解析出落点（沿用 `pickPoint` 命中测试）→ `webContents` 发**真** `mouseMove` → 等 `waitMs`（默认 150）→ 再解析一次同一目标，比较落点、文档高度与子树矩形指纹得出 `grew`。真站实测：`https://map.baidu.com/` 三张 `.mapTypeCard` 悬停前 x=349/354/359（地球卡被全景卡压住）→ `browser_hover({selector:'#mapType'})` 后 x=167/263/359 → `browser_click({selector:'.mapTypeCard.earth'})` 成功，URL 变 `maptype=B_EARTH_MAP`、卡片 class 变 `mapTypeCard earth active`。
> **A16 边界**：直接 hover **被整块盖住的那张卡**仍如实报 `occluded`（悬停一个看不见的控件没有意义，也不会猜）；正确用法是 hover 它的**容器/模块**，让卡片自己展开。`grew:false` 有两种含义（本来就没反应 / 指针已经在上面、早就展开了），工具文案把两种都说了，判定时应先看容器是否已展开。
> **A17 实现状态**：✅ `1.0.24` 实现并装机（TICKET-012，`HOST_REV 25` / `CLIENT_REV 26`）。本机 `<webview>` 有 `setZoomFactor`（日志 `guest api {setZoomFactor:true}`），所以走原生缩放因子：页面自己的排版视口变宽/变窄，随后 `clickAt`/`moveTo` 把 CSS 坐标乘回设备像素。没有该 API 时退化为"放大元素布局盒 + `transform:scale()`"。实测：769×863 @100% → `zoom 0.5` 得 1538×1726，`browser_click({selector:'#ok'})` 命中真实按钮；`zoom 1.5` 得 513×575，点击同样命中。
> **A17 边界**：缩放的是**页面**，不是侧栏宽度（外壳管的事）；缩放会让旧快照的 ref/坐标失效，工具已提示重新快照；缩放状态只存内存，重启 DSH 回 100%（与 D03 一致）。
> **A18 实现状态**：✅ `1.0.27` 实现、`1.0.28` 装机（TICKET-014，`HOST_REV 27` / `CLIENT_REV 27`）。机制＝`export const Config`（schemastery）读 `activation`，`apply(ctx, config)` 建 `activationPolicy`；因为**可见性只能由客户端决定**（`sidebarRight.openTabIn` 在面板侧），档位随每条命令下发 `show: 'once' | 'always' | 'never'`，`client.js` 的 `dispatch` 据此决定是否 `openTabIn`、或直接失败。`browser_download` 走 host 侧 `fetch`、不经过桥，所以在 `always` 下也不会点亮面板（2026-11-20 用户拍板）。实测日志：`host half applied (rev 27) {"activation":"auto"}`、`dispatch {"id":"c1","type":"eval","runner":true,"show":"once"}`。
> **A18 边界**：`manual` / `always` 只做了单测与代码路径覆盖，**未做端到端**（需改 profile 配置行并重启插件，为避免把用户配置改坏而没有实跑）；"右栏不在屏幕上就永远拿不到 body"是结构性限制，`manual` 只是把这个失败提前并说清楚，不会让 agent 在隐藏面板里后台跑。
> **A19 实现状态**：✅ `1.0.39` 实现并装机（TICKET-015，`HOST_REV 28` / `CLIENT_REV 28`）。① 宽度自适应＝`Config.fitWidth`（默认开）→ `command.fit: 'width'` → `Guest.fitToWidth()` 按 `scrollWidth / innerWidth` 逐轮收敛（只缩不放，下限 0.25，`floor` 取整避免死循环），`load()` 收尾与 `ResizeObserver` 各触发一次；手动 `browser_zoom` 后自动适配不再插手。② 整页截图＝`browser_screenshot` 先量 `innerHeight/scrollHeight`，短页单帧、长页逐屏 `capturePage()` → `toDataURL()` → **JS 解码 PNG**（`DecompressionStream('deflate')` + 逐行反滤波）→ 按实际滚动位置裁掉重叠行 → 重新编码；`fixed/sticky` 元素在拼接前隐藏。实测政采结果页（`sh = 3588`、视口 `1463`）：2 帧 + 尾帧，`768 × 2472`、1,310,450 B、`truncated: false`，页面从页头到"主办单位"页脚连续无重复。

> **A19 边界**：截图走 `toDataURL()` 而不是 `NativeImage.getBitmap()`——本机渲染进程**没有 `Buffer`**，`getBitmap()` 会抛 `Buffer is not available for the current Context`（1.0.33 实测），所以面板侧自己解 PNG；解码只支持 Chromium 实际写出的 8-bit、非隔行、RGBA/RGB。面板被右栏收起时视口是 0×0，直接报 `the browser panel has no size on screen…`，不会静默出一张空图。拼接依赖滚动位置读数，页面在滚动中改变高度（懒加载）时以最后一帧补页尾，仍可能与单屏渲染有细微差异。

> **A8 补强（1.0.27，TICKET-014）**：`inject/detect.js` 的标题词加 `验证码拦截|滑动验证|人机验证|security check`，选择器加 `#nc_1_wrapper`、`.nc-container`、`.nc_scale`、`#baxia-dialog`、`[id^="nc_"]`、`iframe[src*="captcha"]`，文案加 `请按住滑块`、`拖动到最右边`、`按住滑块拖`、`滑块验证`、`滑动验证`；另加降级命中——**只有文本一类信号且页面可交互元素 ≤ 3** 也算墙（1688 实测 `请按住滑块，拖动到最右边` 属此类）。反例已固化成单测：帮助页「如何完成滑块验证」有几十个控件，不算墙。

> **审计记录（2026-11-20）**：逐条对照见 `docs/cases/009-spec-audit.md`（含证据位置与三个待决偏差）。本清单据此改为实际状态：11 条通过（其中 A5/A6/A8 带实现偏差），A9 的"关 tab 释放端口"不成立。**A12 已于 2026-11-23 重启实测通过**（当时缺的那条证据已补上）。至此 §10 的 A1–A13 共 13 条全部有结论：**12 条 ✅**（其中 A5/A6/A8 带实现偏差）、**A9 按实测改 spec**（服务随插件活，不随 tab 关释放）。

---

## 11. 风险与依赖

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 第三方插件无法 `acquire` 租约（主进程可能只认官方包） | 致命，方案作废 | **TICKET-001 探针先验**；失败则退回 `dsh-pilot` 外部 Chrome，本项目归档 |
| R2 | typert 不支持 server→client 推送 | 每次动作多 50–100ms | 默认走队列+100ms 拉取（§3.2 A 方案），不阻塞 |
| R3 | `executeJavaScript` 在 sandboxed guest 上被限制 | 致命 | 探针验证；官方包只用了导航，属未验证区 |
| R4 | `sendInputEvent` 对 guest 不生效或坐标偏 | 点击不可靠 | 探针验证；兜底改用 `element.click()` 合成事件（会丢 `isTrusted`，但多数站点够用） |
| R5 | 严格的 CSP / Trusted Types 站点干扰注入 | 部分站点快照失败 | 主世界执行不受 CSP 限制；若个别站点仍失败，退化为 `eval` 手工取数 |
| R6 | 快照在巨型页面（虚拟列表）上不准 | 元素 ref 对不上 | 预算截断 + 提示滚动；必要时坐标点击兜底 |
| R7 | `<webview>` 标签不透出 `capturePage()`（Electron 里该方法长在 `webContents` 上） | D08「每次附图」直接失效 | 探针 U6 先验；退化为纯文本树（需用户重新确认） |
| R8 | 模型分不清"该 `web_fetch` 还是该开面板" | 读一篇新闻也开面板，白烧视觉 token；或该动手时只用 `web_fetch` 拿回一堵登录墙 | 工具描述写明分工（§5 统一约定）+ SPEC-002 B11 验收；真实链路 `web_search(site:)` → `web_fetch` → `browser_open` |

---

## 12. 附：与 `dsh-pilot` 的关系

不替代、不冲突。两者场景不同：

| | 本插件 | `dsh-pilot` |
|---|---|---|
| 浏览器 | DSH 内嵌 webview | 外部 Chrome（CDP） |
| 可见性 | 面板内，与对话同屏 | 独立窗口 |
| 登录态 | 进程内 partition（重启失效） | 持久 Chrome profile（重启保留） |
| 适合 | 看网页、读文档、填表单、看 agent 操作 | 需要长期登录态、Cloudflare 已通过状态复用的站点 |

将来若把"持久登录态"补上（需主进程支持 partition 落盘），本插件可以吞掉 pilot 的场景；当前阶段两者并存。
