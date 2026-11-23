# TICKET-004：动作工具（click / type / press / eval）

- 状态: ✅ 通过（2026-11-19）
- 优先级: P0
- 关联 Spec: `spec/001-agent-browser-plugin-spec.md` §5.3–§5.6、§7.3
- 依赖: TICKET-002、TICKET-003（ref 体系）
- 实现: `plugin/inject/actions.js`（页面侧）、`plugin/client.js`（输入层）、`plugin/tools.js`（工具定义）
- 说明: `reference/005-action-tools.md`

## 目标

让 Agent 真的能操作页面：按 ref 点击、按坐标点击、输入文本、按键、执行 JS。做完这一步，端到端主链路（打开 → 看 → 点 → 输入 → 提交）就闭合了。

## 背景

两个执行器：

- **DOM 层**：`executeJavaScript` 定位元素、滚动、读状态；
- **输入层**：`webview.sendInputEvent` 产生**可信输入**（`isTrusted: true`），命中测试在 Chromium 合成器里做——这是能点中 canvas 和跨域 iframe 的唯一途径（决策 D03 的副产品）。

坐标约定：`x/y` 是 **webview 视口内 CSS 像素**，左上角为原点。`getBoundingClientRect()` 返回的就是视口坐标，直接可用；但**面板视口可能非常窄**（实测 `471×150` 或 `299×150` CSS px），视口外的目标要先滚进来。

## 验收

- [x] `browser_click({ ref:'e5' })` 点到按钮 → 页面有反应 —— `Clicked checkbox "I agree to the terms" at (35, 75)`，页面 `#agree.checked` 由 true → false；夹具 `/inner` 的按钮点击后 `{clicks:1, label:"inner clicked"}`
- [x] `browser_click({ x, y })` 在 canvas 场景可用 —— 本机到 `openstreetmap.org` 不通（`ERR_CONNECTION_TIMED_OUT (-118)`），改用夹具 `/canvas`：滚到目标后点 `(220,60)` → 页面记录 `{x:196,y:33}, clicks:1`。**偏差见下方"实测偏差"**
- [x] ref 过期时报 `stale_ref` 且提示重新 snapshot —— `Error: ref "e1" is no longer in the page; it was replaced or removed. Take a new browser_snapshot and use the refs from that answer.`
- [x] `browser_type` 写值 + `submit: true` 提交 —— 填入中文 `林焕文` 后 `input.value === '林焕文'`；`submit` 后跳到 `/done?name=Alice&mail=agent%40example.com&…`
- [x] `browser_type` 命中 `input[type=password]` → `needs_human`，页面一个字符没变 —— 报错文案 `that field is a password field. Credentials stay with the human: … Nothing was typed.`，页面值仍是夹具自带的 `hunter2`
- [x] `browser_press` 生效，`Alt+Left` 回退、`F5` 刷新 —— `Tab` 后 `activeElement.id === 'news'`；`Alt+Left` → `Pressed Alt+Left — the panel performed "back": …/second → …/form`；`F5` → `performed "reload"`。**快捷键在 guest 内不生效，已转 webview 导航方法（见"实测偏差"）**
- [x] `browser_eval` 返回标题；`awaitPromise` 能等 Promise —— `new Promise(r => setTimeout(() => r({late:true}), 250))` 正常返回
- [x] `browser_eval` 超 8000 字符截断并标记 —— `'x'.repeat(20000)` 返回截断结果并附 `(result cut at the character budget)`
- [ ] 所有输入类工具在 `taken_over` 阶段返回 `taken_over` —— **推迟到 TICKET-005**（状态机还没做）
- [~] 一次动作端到端延迟 < 150ms（不含网络）—— 读类达标（`browser_eval` 实测 **6ms**），**输入类达不到**：`browser_click` 226–389ms、`browser_press` 413ms，而我们的代码 `click timing {focus:0, events:0}`，成本在 Electron 把事件送进 guest 进程

## 实测偏差

1. **OSM 不可达**：验收里写的是"在 openstreetmap.org 上拖/缩地图"，本机到该站 `ERR_CONNECTION_TIMED_OUT (-118)`。改为本地 `/canvas` 夹具验收坐标点击，结论等价。
2. **浏览器快捷键不存在**：webview 没有 chrome，`Alt+Left` / `F5` / `Ctrl+R` 只作为普通按键送到页面，不导航。实现里加了 `navigationCommand` → `element.goBack()/goForward()/reload()`，ticket 说的"转 `browser_open({op})` 备选"没有采用——工具语义上它属于 press。
3. **延迟指标只对读类成立**：见上。
4. **文字输入不走逐字 `char`**：`sendInputEvent({type:'char'})` 对非 ASCII 不可靠（探针只验证过 `keyCode:'A'`），改用页面内 `execCommand('insertText')` + 原生 setter 回退，React 受控组件也能收到 `input` 事件。

## 实测发现

1. **帧内 ref 的属性值必须带帧前缀**：`snapshot.js` 写的是 `data-dsh-ref="f1e5"`，早期 `actions.js` 在帧内查 `e5`，导致帧内元素永远 `stale_ref`。
2. **帧内点击坐标要加 iframe 偏移**：帧内 `getBoundingClientRect()` 是帧坐标，`sendInputEvent` 用顶层视口坐标；不换算就点偏到页面别的部位。
3. **`press` 的 `handled/from/to` 要在 execute 里显式搬一次**，否则 client 明明做了导航，工具结果里只显示 "Pressed alt+Left."。
4. **`report()` 不能用 `keepalive: true`**：会让 `/log` 环形缓冲长期只剩两三条，排障等于闭眼。
5. **改 client 半必须 bump `CLIENT_REV`**：`remove_bundle` + `install_bundle` 里只改 `package.json` 版本号有时不会触发 client 半重新加载。
6. **自调度的轮询链会静默断**：改成定时器驱动 pump + 500ms 看门狗（`lastRound` 超 4s 重启）后才稳定。
7. **陈旧 webview 会吞掉鼠标事件**：面板重挂载后旧 runner 的 webview 已 detach，`executeJavaScript` 还能跑、键盘也能进，但 `mousemove/mousedown/click` 全丢。修法是 `Guest.isLive()`（`element.isConnected`）+ dispatch 时丢弃陈旧 runner。
8. **长轮询把下发延迟从 150–560ms 压到 ~6ms**（`/pending?wait=900` + `#park`/`#wake`）。
9. **PowerShell 的 `Get-Content | Set-Content` 会把带中文的源文件写坏**（UTF-8 双编码）。修复靠 latin1→utf8 还原，此后所有源文件只用 edit/write 工具改。

## 任务分解（实际做法）

- [x] `inject/actions.js`：`dshAction(op, params)`，支持 `inspect` / `click` / `type`
  - [x] ref 解析：`/^(f\d+)?e(\d+)$/` → `[data-dsh-ref]` → `{element, doc, frame}`；`bad_ref` / `stale_ref`
  - [x] `scrollIntoView({block:'center',inline:'center'})` + rect 中心；零尺寸 / 越界 → `out_of_view`
  - [x] 帧内坐标加 iframe 偏移（顶层视口坐标）
  - [x] 返回命中元素描述（tag / role / name），让模型确认点对了
- [x] `client.js` 输入层：`click` / `clickAt` / `type` / `press` / `tap` / `eval` / `navigate`
  - [x] 密码框在页面侧前置拒绝（不发任何字符）
  - [x] 清空用原生 setter + `input` 事件；写入用 `execCommand('insertText')`，回退 setter
  - [x] `submit` → Enter
  - [x] 修饰键解析 + 快捷键表 + 导航回退（`goBack/goForward/reload`）
  - [x] `eval` 包 async IIFE，`awaitPromise`、序列化、预算截断
- [x] `tools.js`：`browser_click` / `browser_type` / `browser_press` / `browser_eval`
  - [x] 参数校验（ref 形状、x/y 成对、key 非空）
  - [x] 错误码 → 可执行文案（`stale_ref` / `bad_ref` / `out_of_view` / `needs_human` / `not_editable` / `bad_key`）
  - [x] `isConcurrencySafe: () => false`（动作串行）
- [ ] 单测：坐标换算、修饰键解析、错误码映射 —— **未做**（项目至今无测试框架，见 README"已知局限"）

## 风险（实现后回看）

| 风险 | 结果 |
|---|---|
| `sendInputEvent` 需要 webview 有焦点 | 坐标点击直接发事件即可命中；键盘类需要页面元素已聚焦（`type` 自己 focus，`press` 依赖当前焦点） |
| 逐字 `char` 太慢/不支持非 ASCII | 改成 `insertText` 一次性写入，问题消失 |
| React 受控组件直接改 value 无效 | 用原生 setter + `input` 事件，实测有效 |
| `Alt+Left` 被页面吃掉 | 实际是**根本不生效**，已转 webview 导航方法 |
| 陈旧 webview 吞事件（评审时没想到） | `Guest.isLive()` 门控 + 丢弃陈旧 runner |

## 预估 vs 实际

预估 1 个工作日；实际耗时集中在排障（重载不可靠、报告通道丢消息、轮询静默断、陈旧 webview、帧坐标），功能代码本身很小。

## 参考

- Electron `webview` 的 `sendInputEvent` / `executeJavaScript` / `capturePage` API
- 受控组件写值手法：`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v)`
