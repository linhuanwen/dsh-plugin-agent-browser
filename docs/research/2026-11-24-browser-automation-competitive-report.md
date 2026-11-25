# 浏览器自动化竞品调研：给 dsh-plugin-agent-browser 的建议

- 日期：2026-11-24
- 范围：用户点名的 5 个 GitHub 项目 + 本项目自身代码与宿主（DSH Desktop）源码
- 结论一句话：**不要换形态，补三条可靠性契约（验证墙 / 效果未知 / 带 Cookie 下载），把「面板就是用户那个浏览器」这条独占路走完。**

## 0. 先看结论

### 0.1 五项目定性

| 项目 | 形态 | 一句话判断 |
| --- | --- | --- |
| [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) | Rust CLI + daemon + Chrome 扩展 + Skill（+ MCP 出口） | 质量与工程化标杆，跨 harness 的事实标准候选；对我们的价值是「机制库」 |
| [GoldenLoaf24h/browserpaw](https://github.com/GoldenLoaf24h/browserpaw) | CLI-first + 原生消息 + MV3 扩展 + 48 行 Skill | 工程最狠的对手（1749 用例、37 个 tag）；v5 已删 MCP，证明「工具面越小越好」 |
| [ywleeo/browser-mcp](https://github.com/ywleeo/browser-mcp) | MCP server（Python）+ MV3 扩展 | 小而完整，安全策略最讲究；MCP 路线的典型代价样本 |
| [JohnXu22786/browser-automation](https://github.com/JohnXu22786/browser-automation) | MCP server + Playwright 无头 | 反面参考：无面板、无接管、ref 位置化会静默错位，已 2 个月不更新 |
| [drscrewdriver/dsh-browser-cdp](https://github.com/drscrewdriver/dsh-browser-cdp) | DSH 原生插件 + CDP + 包内 Chromium + 浮动观察窗 | 唯一同生态正面竞品；可靠性契约与定位稳定性值得抄，形态与我们相反 |

### 0.2 我们真正的位置

我们不是「又一个浏览器自动化」：在本次抽样与生态检索里，我们是**唯一把「用户看得见、能随时接管的那一个浏览器」租给 Agent 的实现**（`dshDesktop.browser.acquire` 租约 + 侧栏 `<webview>` + `keepMounted`）。这条护城河来自宿主，不来自代码，抄不走；代价是我们被宿主的三条策略咬住（见 §4.3）。

竞品在拼的东西已经从「能不能点」转向「点完以后能不能证明、点不确定的时候怎么办、token 花多少」。这三件事我们目前都只有一半：**有 13 个带 `retryable`/`hint` 的错误码，但没有「动作已经发出去了」这个状态**；有验证墙检测，但真实 Turnstile 漏报（TICKET-033）；有下载，但不带页面 Cookie。

### 0.3 如果只做三件事

1. **修 TICKET-033**（0.5 天）：真实 Cloudflare/Turnstile 漏报 `needs_human`，这是「Agent 在验证墙上硬撞」的唯一防线，也是唯一一处「已知会出错却挂着 P2」的地方。
2. **加「效果未知」语义**（1–1.5 天）：`click`/`type`/`press` 在超时或导航中断时回 `effect: 'unknown'` + `retry: 'reobserve'`，禁止静默重放。PROGRESS §12 已经踩过「首条命令超时但动作其实生效」。
3. **下载补「页面内取字节」通道**（1–2 天）：宿主在 webview 会话里 `will-download` 一律 `preventDefault()`（`lib/main.js:18242-18244`），所以带 Cookie 下载只能页面内 `fetch(credentials:'include')` 取 blob 回传；同时向上游提「租约下载通道」需求。

三件都在 1–2 周内可交付，且都能用现有 196 例测试体系验收。

## 1. 调研方法与口径

- **竞品**：GitHub API 取元数据（2026-11-24 快照），5 个仓库浅克隆到 `tmp/gh/`，逐个读 README / 包清单 / CI / 核心源码，产出 5 份带 `file:line` 的技术简报：`tmp/gh/{browserskill,browserpaw,browsermcp,browserauto,browsercdp}.brief.md`。本报告只保留判断与证据索引，细节查简报。
- **本项目**：读 `plugin/` 全部源码、`docs/` 全部决策与工单，跑 `node --test plugin/test/*.test.mjs`（196 例全绿），用 `node tools/asar.mjs` + 自写 `tmp/asar-slice.mjs` 读 DSH 宿主 `app.asar` 的 `lib/main.js` 相关行。
- **口径与局限**：
  - star 数只代表热度；本项目仓库 2026-11-23 才创建（6★），与 10.7k★ 的 Tencent 项目不可比，本报告不拿 star 当质量。
  - 生态检索里还有至少 5 个同类 DSH 插件（`dsh-browser` 1132★、`dsh-ego-browser` 571★、`dsh-browser` 202★、`dsh-tabbit` 129★、`dsh-browser-control` 75★），本次只登记元数据、未读源码，所以「唯一」一词仅限本次抽样的 5 个项目。
  - 竞品均未逐个真机跑通，能力判断来自源码与文档；不确定处在矩阵里标「未核实」。

## 2. 生态地图：三条路线，三个战场

| 路线 | 代表 | 谁在赢 | 我们的关系 |
| --- | --- | --- | --- |
| A. 「跨 harness 的浏览器接口」：CLI 或 MCP + 浏览器扩展 | BrowserSkill、browserpaw、browser-mcp | 赢在覆盖面：一个 server 通吃 Codex / Claude / Cursor / DSH | 不同战场，但他们会吃掉「随便一个 agent 都能用的浏览器」这块需求 |
| B. 「DSH 原生插件 + 自有浏览器」 | dsh-browser-cdp、dsh-browser、dsh-ego-browser、dsh-tabbit | 赢在能力上限：CDP 全权限、无头、远程、多标签 | **正面竞品**，尤其 dsh-browser-cdp |
| C. 「租用宿主已有的那一个可见浏览器」 | **我们** | 赢在信任与接管：用户登录态、看得见、随时能接 | 我们的独占位，但被宿主策略限制 |

三条路线的成本结构不同：A 的边际成本在「装机」和「权限」；B 在「另起一个浏览器」和「登录态搬运」；C 在「宿主给什么就只能用什么」。C 是唯一不需要用户重新登录、也不怕把密码喂给模型的路线，这在 DSH Desktop 这种「用户自己开着浏览器干活」的产品里是刚需。

值得注意的一个信号：**browserpaw v5 把 MCP 删掉了**（v4 是 127.0.0.1:12306/mcp），改成「48 行 Skill + 92 条 CLI」。这说明当工具面变大时，主流 harness 的上下文成本会反噬；而 BrowserSkill 用「11 个域工具 + 13 个按需 reference」解同一个问题。我们 11 个工具 10,568 字符常驻（§4.4），已经到了需要正视的量级。

## 3. 逐项目分析

### 3.1 Tencent/BrowserSkill（10,697★，MIT，0.5.0，周更）

- **形态**：Rust CLI（内嵌 daemon）+ Chrome/Edge MV3 扩展 + Skill + `bsk mcp` + 一个「只注册 skill」的 DSH 薄插件。DSH 侧没有侧栏 UI，靠 shell 跑 `bsk`（`packages/dsh-plugin-browserskill/src/index.mts:35-64`）。
- **链路**：agent → shell/MCP stdio → CLI → JSONL over UDS/命名管道 → daemon → WS JSON Protocol 2.0（127.0.0.1:52800）→ 扩展 → `chrome.debugger`/CDP → Chromium。
- **真正值钱的三个机制**：
  1. **`effect_state`（none / committed / unknown）+ intent WAL**：每个变更动作先记账，`unknown` 时先 `bsk_ledger`/`sync` 对账，**绝不重放**。这是对「动作到底发没发出去」最完整的答案。
  2. **`expect` 断言 + `observation_id`/`context_id`**：动作可以带「点完之后这行文字应该变成 X」的断言，比「返回 navigated」强一个量级，而且天然治 stale ref。
  3. **`request_help` 原语**：页面内弹条「请人工完成登录/验证」并阻塞等待，作为验证墙检测的兜底（漏报时 agent 还有一条正路）。
- **工程证据**：约 1298 个 Rust 测试、245 个 TS 测试文件、23 个真浏览器 eval 用例、CI 12 个 job（含 4 个真浏览器回归与 Windows daemon 生命周期）；15 个 ErrorCode + 123 个 RpcErrorReason。
- **教训（我们别抄的）**：三件套安装重（CLI + 商店扩展 + skill）、`chrome.debugger` 权限受商店审核、文档漂移（README 写协议 1.8，catalog 实际 2.0）。
- **对我们的意义**：机制库。它的 `effect_state` 与 `request_help` 是我们 P0/P1 建议的直接来源；它的安装成本正是我们「装一个插件就完事」的优势。

### 3.2 GoldenLoaf24h/browserpaw（43★，AGPL-3.0，v5.0.1，37 个 tag / 约 10 周）

- **形态**：CLI-first 四件套——CLI（唯一入口，JSON 回执，5 个退出码）+ MV3 扩展（DOM 索引、严格 locator、原生输入）+ Native host（起 Chrome、绑 127.0.0.1）+ 48 行 Skill。DSH 插件只 `ctx.skills.register`，**不注册任何工具**（`plugins/browserpaw-dsh/index.js:126-146`）。
- **工程证据**：177 个测试文件 / 1749 个用例 + 真 Chrome E2E + 打包 smoke；CI 三平台 + Node22 + xvfb 真 Chrome；单文件体积大（`dom-indexer` 101KB、`screenshot` 86KB）。AGPL-3.0-or-later 是硬约束：闭源集成有传染风险。
- **值得抄的五条**：
  1. **ref / index 永不复用**（`index-state.ts:31,89-91,117-124`，文档级 24bit 命名空间 + WeakRef 防泄漏）。我们目前每次快照重编号（`plugin/inject/snapshot.js:70,297-298`），跨快照必然 `stale_ref`；「不复用」能让模型两次快照之间手滑时不至于点到另一个元素。
  2. **快照硬预算 250 元素 / 6000 字符 + 紧凑行渲染**（`[12] link "标题" frame="3"`）。我们默认 8000 字符但对元素数不设限，长页面会整段吃掉预算。
  3. **坐标点击必须绑定新鲜 `captureId`**（`interact-index.ts:27-32`）。我们跨域 iframe 只能坐标，这条正好补「坐标点是拿旧布局算的」。
  4. **不确定态语义**：`requestDispatched` 标记 + `exit 4`「结果未知，先 observe 再动作」。
  5. **全局 Agent Control 暂停开关**：我们四态徽章里可以加「agent 暂停」。
- **更有意思的是产品信号**：v5 删 MCP、只留 Skill。这条路线认为「Agent 需要的是能力和文档，不是 92 个 schema」。我们 11 个工具常驻 10.6k 字符，正处在两派的分界线上。

### 3.3 ywleeo/browser-mcp（10★，MIT，Python，0.15.1）

- **形态**：纯 MCP server（stdio 唯一传输）+ 独立 MV3 扩展（`debugger` 权限跑 CDP）。DSH 侧只是 `cordis.patch.yml` 注册 `@deepseek-ai/dsh-mcp-client`，用 `uvx` 从 PyPI 拉起，工具名 `mcp__browser__*`，`index.js` 只有 `export {}`。
- **质量**：137 个 Python 测试 + 35 个扩展测试、三平台 CI、OIDC 发布、README 464 行 + ADR 539 行。这是本次抽样里「小项目做到最讲究」的一个。
- **值得抄的四条**：
  1. **工具描述写成「恢复指令」**：「ref 过期 → 重新 snapshot」「副作用前先确认」。我们的 hint 已经有了（`plugin/errors.js` 13 个码逐个带 `hint`），但描述层还没系统化。
  2. **不可变快照 + 字节分页**（`offset` / `complete` / `next_offset`）：比「给个 maxChars」更能治「读到一半被截断」。
  3. **URL 策略**：只 http(s)、禁 URL 内嵌凭据、DNS 答案必须 `is_global`、fake-IP 回退 DoH。我们目前只拦 scheme（`plugin/policy.js:64-80`），私网/回环 URL 是敞开的。
  4. **登录三态 fail-closed**：登录态不确定时返回 `login_url` 而不是硬闯。
- **它的代价就是我们的护城河**：进程外拿不到宿主 UI（侧栏可见浏览器、接管），policy / 审批 / 下载 / sha256 / 错误码 / 取消都没有挂点，图片 base64 还膨胀。

### 3.4 JohnXu22786/browser-automation（0★，停滞）

- **形态**：Playwright 无头 + MCP server + 约 30 行 Cordis 桥。默认 headless，登录态靠 `launchPersistentContext`/`storageState`；22 个 `web_*` 工具；71 个测试；最后提交 2026-09-30。
- **缺点几乎覆盖了这条路的全部坑**：无 UI、不可接管、无验证墙、无取消、无下载/上传/坐标/iframe/shadow/dialog/网络观测；**ref 是位置路径，SPA 下会静默错位**（点错的概率比报错更可怕）。
- **唯一可借鉴**：注入脚本「单一源码 + Node 编译」双用，让注入层能在 Node 里单测（我们的 `plugin/inject/*.js` 现在只能靠页面夹具测）。
- **结论**：一个「能演示、不能交付」的样本。我们文档里做竞品对比时可以拿它说明「为什么我们不做 MCP 化无头浏览器」。

### 3.5 drscrewdriver/dsh-browser-cdp（42★，MIT，npm 1.14.10）

- **形态**：DSH 原生 host+client 双半 + 包内 vendored `ego-linux` 运行时（418KB）+ 35 个 `bcdp_*` 工具 + 侧栏外挂的浮动观察窗（**不是** `<webview>` 内嵌，页面不是用户平时那个浏览器）。
- **规模**：`src` 31,870 行、106 个测试文件、1,355 个用例通过。本次抽样里工程密度最高的同类项目。
- **必须承认它做对的事**：
  1. **验证墙双探针 + `bcdp_wait_for_human`**（选择器 + 中文正则双探针；`src/captcha.ts:10-33`，300s 阻塞轮询在 `src/index.ts:5469`）。我们 TICKET-033 就是缺这层冗余。
  2. **`loc=` 稳定定位**：快照行是 `[ref=N, loc=css:/role:/href:]`，工具描述直接写「Prefer loc= over @N across calls: locs are stable, refs renumber each snapshot」（`src/index.ts:4497,4508`）。这是对「ref 每快照作废」最优雅的修正。
  3. **12 个错误码带 `retry: never|reobserve|retry` + `actionSent` + `hint`**，20 个变更工具保守地默认 `actionSent=true`（`src/errors.ts:45-160`）。
  4. **懒注入**：唯一常驻 `bcdp_help`（504 字符），按批次反注册/解锁其余工具（`src/toolTiers.ts:47-132`），README 声称省 98.1% 上下文（`package.json` 里仍写 91.9%，自家数字都对不齐）。
  5. **下载用 `page.waitForEvent('download')` + `saveAs`**（`src/index.ts:5027,5306-5310`），带 Cookie、带事件，不需要宿主 fetch。
  6. **兼容矩阵** `dshReleases`（1.x ↔ DSH 0.1.7+；0.17.x ↔ 0.1.2~0.1.5；v0.8.x ↔ 0.1.0/0.1.1）——一个插件要同时服务多条 DSH 版本的现实写法。
- **不要抄的**：35 个工具全量（哪怕懒注入，发现成本仍在）、独立浏览器影子（登录态要靠导入 cookie，`src/login-import.ts:1-34` 还得用真实浏览器二进制无头跑；Chrome 127+ 的 App-Bound Encryption 让它没法离线解密）、`--remote-allow-origins=*`（CDP 端口等于无鉴权）、junction 绕 Chromium 检测（脆且不体面）。
- **对我们的意义**：它是本次抽样里唯一会和我们抢「DSH 里用浏览器」用户的同类。它的优势（能力上限、无头、远程、多标签）我们短期补不上；我们的优势（登录态、可见、接管、零安装）它也拿不到。**它的存在说明「DSH 原生 + 更强能力」是有需求的——这是战略选项 B 的依据。**

## 4. 能力横评

### 4.1 矩阵（✅ 有 / 🟡 部分 / ❌ 无 / ? 未核实）

| 维度 | 我们 | browser-cdp | BrowserSkill | browserpaw | browser-mcp | browser-auto |
| --- | --- | --- | --- | --- | --- | --- |
| 浏览器来源 | 宿主租约的 `<webview>` | 包内 ego Chromium（独立 profile） | 用户 Chrome + 扩展 | 用户 Chrome + 扩展 | 用户 Chrome + 扩展 | Playwright Chromium |
| 用户登录态 | ✅ 就是用户那个会话 | 🟡 独立 profile + cookie 导入 | ✅ Agent Window 共享 / borrow tab | ✅ borrow tab affinity | ✅ 真实 Chrome profile | 🟡 persistent context |
| 用户看得见 | ✅ 侧栏面板即浏览器 | 🟡 浮动观察窗（只读看） | ❌ 无 UI | ❌ 无 UI | ❌ 无 UI | ❌ 无 UI |
| 用户可随时接管 | ✅ 四态徽章 + 直接点 | 🟡 「人机接力」按钮 | ❌ | 🟡 ask-human 弹条 | ❌ | ❌ |
| Agent 与用户同一个浏览器 | ✅ | ❌ 另起 | ✅ | ✅ | ✅ | ❌ |
| 跨域 iframe | 🟡 只能坐标 | ? | ✅ OOPIF frame graph | 🟡 frame 索引 + 坐标 | 🟡 像素点击绕开 | ? |
| 下载（带页面 Cookie） | ❌ 宿主 fetch 无 Cookie | ✅ `waitForEvent('download')` | ✅ `chrome.downloads` | ✅ `chrome.downloads` | 🟡 httpx + Referer | ❌ |
| 上传 | ✅ `DOM.setFileInputFiles` | ? | ✅ | ✅ | ✅ + 敏感目录黑名单 | ❌ |
| 无头 | ❌ | ? | ❌ | ❌ | ❌ | ✅ |
| 远程 | ❌ | ? | ✅ 反向 WSS + 配对/吊销 | ❌ | ❌ | ❌ |
| 多标签 | ❌ 一面板一页 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 取消 | ✅ | ✅ | ✅ deadline / cancel_at_deadline | ✅ CANCEL_TOOL + 5s ack | 🟡 协作式 deadline | ❌ |
| 错误契约 | ✅ 13 码 + retryable + hint | ✅ 12 码 + retry + actionSent | ✅ 15 码 + 123 reason + effect_state | ✅ 5 退出码 + unknown | ❌ 纯文本 | ❌ |
| 动作效果证据 | 🟡 只回 navigated | ✅ actionSent | ✅ effect_state + intent WAL | ✅ requestDispatched | ❌ | ❌ |
| 产物可证性 | ✅ 截图/下载 sha256 | ? | ? | ? | ? | ❌ |
| 验证墙 | 🟡 启发式检测（真实 Turnstile 漏报） | ✅ 双探针 + wait_for_human | ✅ request_help | ✅ 30+ 选择器 + ask-human | ✅ 登录三态 fail-closed | ❌ |
| 稳定定位 | 🟡 ref，每快照重编号 | ✅ `loc=` | 🟡 `@eN`（每快照新 ref-store） | ✅ index 永不复用 | ✅ ref 代际前缀 | ❌ 位置路径，静默错位 |
| 工具常驻成本 | 🟡 11 个 / 10,568 字符 | 🟡 35 个 + 懒注入（1 个常驻） | 🟡 11 域 + 13 reference | ✅ 48 行 skill + 92 CLI | 🟡 43 个 + toolset | 🟡 22 个 |
| 快照预算 | 🟡 8000 字符截断 | ? | ✅ max_tokens + cursor 续读 | ✅ 250 元素 / 6000 字符 | ✅ 200 元素 / 12k 文本 | 🟡 预算参数 |
| 策略/审批挂点 | ✅ `ctx.tools.guard` + policy.js | ? | ? | ✅ 全局暂停 | ❌ | ❌ |
| 安装成本 | ✅ 装插件 + 启用 | 🟡 npm 包 | ❌ CLI+扩展+skill 三件套 | ❌ CLI+扩展+skill+native host | 🟡 uvx + 扩展 | 🟡 插件 + playwright |
| 新增依赖 | ✅ 零 | 🟡 vendored 运行时 | 🟡 Rust 二进制 | 🟡 Node + pnpm | 🟡 Python + uv | 🟡 playwright |
| 许可 | MIT | MIT | MIT | **AGPL-3.0** | MIT | MIT |
| 测试规模 | 196 | 1,355 | ~1298 Rust + 2.7k TS | 1,749 用例 | 137 + 35 | 71 |
| 活跃度 | 1.4.24（今日 push） | 1.14.10（11-23） | 0.5.0 周更 | v5.0.1（11-22） | 0.15.1（11-23） | 2026-09-29 停滞 |

### 4.2 护城河（宿主给的，不是代码给的）

1. **登录态零搬运**：租约拿到的是用户已登录的会话，不需要 `Storage.getCookies`、不需要 cookie 库（browser-cdp 走的正是那条路，还得处理 App-Bound Encryption）。
2. **看得见、随时接管**：侧栏就是浏览器本体，用户点一下就从 agent 手里接管（`taken_over` 相位），agent 侧读工具只读、写工具被门（`plugin/bridge.js:268-289`）。
3. **零新依赖、零第二浏览器**：`node:http` + `fetch` 起循环回环通道（决策 005/008），不 vendored 运行时、不起 Chromium、不装 native host。
4. **策略与可证性**：13 个错误码带 `retryable`/`hint`（`plugin/errors.js`）、`ctx.tools.guard` 审批接缝、截图/下载 sha256、`sessions.allowlist`。这些是 MCP 路线天然没有的挂点。

### 4.3 结构性短板（宿主策略卡死，不是 bug）

| 短板 | 证据 | 能做什么 |
| --- | --- | --- |
| 带 Cookie 下载不可行 | 宿主对 webview 会话 `will-download` 一律 `preventDefault()`（`lib/main.js:18242-18244`） | 页面内 `fetch(credentials:'include')` 取 blob（§6 P0-3）；或向上游要租约下载通道 |
| 窗口后台不绘制、不收输入 | PROGRESS §10 实测：guest 不绘制、`sendInputEvent` 不收、`capturePage` 挂起 | probe `backgroundThrottling=no`，不行就在工具回执里明确报「面板不在前台」 |
| 跨域 iframe 只能坐标 | `plugin/inject/snapshot.js:272` 只输出占位 | 探针：宿主半拿 guest 的 `webContents.mainFrame.frames[].executeJavaScript`（Electron WebFrameMain） |
| 一面板一页、无多标签 | 产品定义（侧栏一个 tab） | 不做；需要多标签的用户本来就不该用面板 |
| 一个 profile 只能一个浏览器后端 | 宿主租约冲突 + `plugin/apply.js:365-366` 的 `OTHER_BROWSER_TOOLS` 接缝 | 文档讲清；`/browser-doctor` 里给出「关掉另一个后端」的指引 |

### 4.4 可补的短板（真正的竞争焦点）

1. **效果未知**：`click` 只回 `navigated`（`plugin/tools.js:674,692,731`），超时时调用方不知道点没点。竞品三家都有这一层。
2. **定位稳定性**：ref 每快照重编号，跨快照必失效；竞品用 `loc=` 或永不复用 index。
3. **验证墙召回**：TICKET-033 真实漏报；竞品是双探针 + 人工等待原语。
4. **快照可控性**：只有 `maxChars`，没有续读、没有元素数上限、没有 frames/遮挡头。
5. **工具面成本**：10,568 字符常驻（每次请求都付），browserpaw 用 48 行 skill 解了同一个问题。
6. **URL 策略**：只拦 scheme，私网/回环敞开（`plugin/policy.js:64-80`）；三家竞品都有私网策略。

## 5. 判断：我们该往哪走

一句话：**把「面板 = 用户那个浏览器」这条独占路走到底，用可靠性契约补齐能力差的观感，不追 CDP 的能力上限。**

- 追能力上限（CDP、独立浏览器、无头、远程）是 browser-cdp 的地盘，我们追不上也不该追：一旦独立浏览器进场，登录态优势立刻消失，我们变成「一个更弱的 browser-cdp」。
- 追通用分发（CLI/MCP 跨 harness）是 BrowserSkill/browserpaw 的地盘，我们只有 6★ 和他们 10.7k★ 打不了，且 MCP 化会丢掉面板、策略、接管这三个独占物。
- 剩下唯一正确的方向：**让「用面板干活」这件事在可靠性上不输任何对手**——动作可证、失败可辨、验证墙可停、大页面可读、token 可控。

## 6. 建议清单（按优先级）

每条给：问题 → 做法 → 落点 → 验收 → 成本 → 借鉴来源。

### P0-1 修 TICKET-033：真实 Cloudflare/Turnstile 漏报（0.5 天）

- **问题**：2026-11-23 G2.1 用 `https://nopecha.com/demo/cloudflare` 实测，标题「请稍候…」、正文「正在进行安全验证 / 验证您是人类」，`needs_human` 没触发，snapshot/eval 照常跑。
- **根因（我的补充分析，比 ticket 原文更具体）**：三因叠加。
  1. `PHRASES`（`plugin/inject/detect.js:88-104`）没有「正在进行安全验证」「验证您是人类」，正文 text 信号不命中；
  2. 判定是 `kinds >= 2` 才 hit（`:119-126`），只有标题命中时 `kinds=1`，`textOnly` 分支又只豁免 `text`、不豁免 `location`，于是单标题信号不触发；
  3. `detectChallenge` 只在 `open` 与 `snapshot` 两处跑（`plugin/client.js:536,546`），Turnstile 常在 `did-stop-loading` 之后才挂载，可能整段错过。
- **做法**：
  1. PHRASES 补 4–6 个词（「正在进行安全验证」「验证您是人类」「enable javascript and cookies」「请开启 javascript」）；
  2. 判定放宽：`location` 单信号 + `interactive <= 3` + 正文长度阈值 → 也算 hit（和 `textOnly` 对称）；
  3. `open` 成功后 2–3s 再跑一次 detect（或监听 `did-frame-finish-load`），补「晚挂载」；
  4. 保留现有红框定位（`:134-171`），它比面板级红框可靠（webview 合成层会盖住面板层）。
- **落点**：`plugin/inject/detect.js`、`plugin/client.js:536` 附近。
- **验收**：新增 4 个夹具（Turnstile 静态页命中、example.com 不误报、meta refresh 秒跳不误报、普通 iframe 不误报）；`docs/cases/010` V8 与 `docs/cases/013` H8 通过；关闭 TICKET-033。
- **借鉴**：browser-cdp `captcha.ts` 双探针；BrowserSkill `request_help`（漏报时的兜底，见 P1-4）。

### P0-2 动作「效果未知」语义（1–1.5 天）

- **问题**：`click`/`type`/`press` 超时或导航中断时，调用方无从判断动作是否已经生效。PROGRESS §12 记录过真实事故：重装后首条命令超时，但动作其实已生效。竞品（browserpaw `exit 4`、BrowserSkill `effect_state`、browser-cdp `actionSent`）三家都有这层。
- **做法**：
  1. 变更类工具统一回执加 `effect: 'none' | 'committed' | 'unknown'`（默认成功 `committed`，参数校验失败 `none`，超时/导航中断/取消 `unknown`）；
  2. 错误码新增 `action_unknown`（`retryable: true`，`hint: '先 browser_snapshot 再判断，不要重放这个动作'`）；
  3. `bridge_timeout` 的 hint 改成先快照再决定（现在是「把面板切前台重试」）；
  4. 面板侧 `reportPhase` 不受影响，只改工具回执层。
- **落点**：`plugin/tools.js`（click/hover/scroll/type/press 与 guard 失败路径）、`plugin/errors.js`、`plugin/bridge.js` 超时路径。
- **验收**：用 034 的「大图截图 bridge_timeout」套路造一个 click 超时夹具，断言 `effect: 'unknown'` 且 hint 禁止重放；196 例保持绿。
- **借鉴**：browserpaw `requestDispatched` + exit 4；BrowserSkill `effect_state` + intent WAL（我们不需要 WAL，先做回执这一层）。

### P0-3 下载补「页面内取字节」通道（1–2 天，另起上游需求）

- **问题**：宿主在 webview 会话里 `will-download` 一律 `preventDefault()`（`lib/main.js:18242-18244`），所以 `browser_download` 只能宿主 fetch，**不带页面 Cookie**；README 已列为已知限制。
- **做法（可自闭环）**：
  1. `browser_download({ url, filename, mode: 'page' | 'host' })`，`page` 模式：页面内 `fetch(url, { credentials: 'include' })` → `blob` → 8MB 分块 base64 → 宿主拼装落盘 + sha256；
  2. 同源直接可用；跨域先试 `page`，失败（CORS / CSP `connect-src`）自动回退 `host` 并在回执里标 `cookies: false`；
  3. 50MiB 上限与 base64 1.33 倍膨胀要在分块层算清楚。
- **做法（上游）**：向 DSH 提需求——租约增加下载通道（`sessionId` + 插件注册的 `will-download` handler），或允许插件在 lease 上注册下载策略。三家竞品都靠「浏览器原生下载事件」而不是反代 HTTP，这是形状问题不是技巧问题。
- **落点**：`plugin/downloads.js`、`plugin/inject/actions.js`（页面内取字节）、`plugin/client.js`（分块回传）。
- **验收**：同源附件（自建夹具 + 真实站点）下载字节与浏览器直下完全一致（比对 sha256）；跨域回退路径 `cookies:false` 可见；50MiB 拒绝；可执行扩展名仍拦截。
- **借鉴**：browser-cdp / browserpaw / BrowserSkill 的「原生下载事件」思路；browser-mcp 的「Python 侧带 Referer 直连」作为回退参考。

### P1-1 点击/输入后的可验证回执（1 天）

- **问题**：`click` 成功只回 `navigated`，模型无法确认「点到了没、点对没」。
- **做法**：点击前记录目标元素的特征（tag/role/文本/位置），点击后 150ms 内复核：元素消失、`aria-expanded` 翻转、URL 变化、焦点移动、DOM 变更计数，回执给 `verified: true | false | 'unknown'` + `signals: []`。
- **落点**：`plugin/inject/actions.js`（点后探测）、`plugin/tools.js`（回执字段）。
- **验收**：5 个夹具（普通链接跳转、SPA 无导航、`aria-expanded` 展开、被遮挡点击失败、点到但无任何变化）各自给出正确 `verified`。
- **借鉴**：BrowserSkill `expect` 断言（轻量版）；browser-cdp 的点击命中复核。

### P1-2 `loc=` 稳定定位，ref 退化为快捷方式（1–1.5 天）

- **问题**：ref 每快照重编号（`plugin/inject/snapshot.js:70,297-298`），跨快照必失效，模型手滑重放就点错元素。
- **做法**：快照行加 `loc=css:...`（优先 `data-*`/`aria-label`/role+name/结构路径），`click`/`type` 接受 `loc`；找不到时才报 `stale_ref` 并提示重读。ref 继续保留（省 token）。
- **落点**：`plugin/inject/snapshot.js`、`plugin/inject/actions.js`、`plugin/tools.js` 参数 schema。
- **验收**：两次快照之间用 `loc` 点击同一元素成功；用旧 ref 点击得到 `stale_ref` + 明确提示；196 例绿。
- **借鉴**：browser-cdp「Prefer loc= over @N」；browserpaw「index 永不复用」是同一问题的另一种解。

### P1-3 快照可控性：续读 + 元素预算 + frames/遮挡头（1 天）

- **问题**：只有 `maxChars` 截断（默认 8000，clamp 500–30000，`plugin/tools.js:292,312-316,368`），截断后模型只能猜；没有元素数上限；跨域 iframe 只有一行占位。
- **做法**：回执加 `truncated: true` + `nextOffset`（续读）；行数上限（如 400 行）+ 提示；跨域 iframe 行附带「可见区域矩形，可坐标点击」；顶部加一行 `frames: N (cross-origin: M)` 摘要。
- **落点**：`plugin/inject/snapshot.js`、`plugin/tools.js`。
- **验收**：长页面首屏 + 续读两段拼起来覆盖全文；含 3 个 iframe 的页面能看出哪几个可交互。
- **借鉴**：browser-mcp 字节分页；browserpaw 250 元素 / 6000 字符；BrowserSkill `[ctx:]`/cursor。

### P1-4 `browser_wait` 工具（0.5–1 天）

- **问题**：没有等待原语，agent 只能 `eval` 轮询或反复 snapshot。
- **做法**：`browser_wait({ for: 'selector'|'text'|'navigation'|'idle', selector?, text?, timeoutMs? })`，内部 MutationObserver + 超时；超时回 `waited: false` 而不是报错。顺带把「需要人工」的等待语义做好：检测到验证墙时回 `needs_human` + hint（与 P0-1 闭环）。
- **落点**：新 `plugin/inject/wait.js` + `plugin/tools.js`（工具数 11 → 12，schema 增加约 500 字符，可接受）。
- **验收**：3 个夹具（延迟渲染、点击后跳转、文本出现）；超时不抛错。
- **借鉴**：browser-automation 的 wait 六条件；browser-cdp `wait_for_human`；BrowserSkill `request_help`。

### P1-5 快照语义增强：遮挡与语义分层（0.5–1 天）

- **问题**：模型不知道某元素被弹窗/固定头挡住，也不知道页面「当前处于哪一层」（弹窗/菜单/侧栏）。
- **做法**：`elementFromPoint` 命中判定 → 被遮挡元素标 `[occluded]`；同名重复元素标 `[ctx: 侧栏]`；固定定位悬浮层单独分组。
- **落点**：`plugin/inject/snapshot.js`。
- **验收**：带固定 header 与弹窗的夹具里，被挡元素有标记。
- **借鉴**：BrowserSkill `observe` 的 layer 头 / 遮挡提示 / `[ctx:]`。

### P1-6 工具面成本：先做「按需描述瘦身」（0.5 天 + 观察）

- **问题**：11 个工具 schema 共 10,568 字符，每轮常驻（`click` 1205、`hover` 1203、`open` 1262、`screenshot` 1151、`download` 1066、`scroll` 975、`snapshot` 923、`zoom` 824、`eval` 749、`type` 705、`press` 505）。竞品里 browserpaw 已经用 48 行 skill 把这块干到近零。
- **判断**：**不建议现在做懒注入**。理由：① DSH 宿主是否支持运行中注册/反注册工具集未验证；② 描述里的「何时用/何时不用」是 A/B 实测出来的路由文案，压缩会伤路由（决策 D08 周边记录）；③ 我们 11 个工具的量级仍远低于 35/43 个全量。
- **做法（低风险小步）**：先把 `download`（1066）、`zoom`（824）、`press`（505）三个低频工具的描述压到现有 60%（保留恢复指令与安全句），预计省 800–1000 字符；观察一周路由是否退化。
- **落点**：`plugin/tools.js` 三个工厂的 description。
- **验收**：总字符 ≤ 9,700；`docs/cases/012` 行业调研案例仍走对工具。
- **借鉴**：browserpaw 的 skill 化（长期）；browser-cdp 懒注入的失败教训是「数字都对不齐」——先量再改。

### P1-7 用户指路：面板里点元素，生成 ref 给 agent（1–2 天，差异化）

- **问题**：用户想告诉 agent「就是这个按钮」，现在只能打字描述。
- **做法**：面板加「指给他看」模式：用户点一个元素 → 页面内生成最小 selector + ref + 文本摘要 → 作为一条消息塞进会话输入框（或面板日志）。竞品全都没有（它们没有可见面板）。
- **落点**：`plugin/client.js`（面板工具栏）、`plugin/inject/actions.js`（拾取）。
- **验收**：点一个带 `aria-label` 的按钮，注入的文本能被 `browser_click({ ref })` 直接使用。
- **借鉴**：无（这是护城河的直接变现）。

### P2-1 跨域 iframe 探针（0.5 天，结论决定后续）

- **问题**：跨域 iframe 只能坐标（`plugin/inject/snapshot.js:272`），坐标点击依赖布局新鲜度。
- **做法**：探针脚本——宿主半 `require('electron')` → `webContents.getAllWebContents()` 找到 guest → `mainFrame.frames[].executeJavaScript`（Electron `WebFrameMain`）读取跨域 frame 的 a11y 树。若可行，则 iframe 从「坐标」升级为「可读 + 可 ref」；若插件进程拿不到 `electron`，结论是「只能等上游」。
- **验收**：探针输出 `frameCount`、能否读到子 frame `document.body.innerText`。
- **借鉴**：BrowserSkill OOPIF frame graph（它是扩展侧，我们是宿主侧，路径不同但目标一致）。

### P2-2 后台绘制探针（0.25 天）

- **问题**：DSH 窗口在后台时 guest 不绘制、不收输入（PROGRESS §10）。
- **做法**：给 webview 加 `webpreferences="backgroundThrottling=no"` 试一次，记录 `capturePage` 与 `sendInputEvent` 是否恢复；不行就把「面板不在前台」变成明确错误回执而不是超时。
- **验收**：窗口切后台后调用 snapshot，要么成功，要么 1 秒内报 `panel_not_foreground`（新错误码）。

### P2-3 可选 CDP 第二后端（谨慎，2–3 周，仅当用户明确要能力上限）

- **判断**：值得做探针，不值得立刻做产品。browser-cdp 已经占住「DSH 里要 CDP」的心智（42★/1355 用例）。
- **做法**：只做「检测到已启用另一个浏览器后端时，给出清晰指引」+ 一个 `browser_backend` 只读探测工具，不做第二套工具注册（会与宿主租约冲突，`plugin/apply.js:365-366` 已经处理过这个冲突）。
- **验收**：profile 里同时启用两个后端时，agent 得到一条「请只留一个」的明确错误，而不是静默走错工具。

### P2-4 工程门禁补强（0.5 天）

- **问题**：本次调研发现两处文档漂移（`docs/README.md` 写「34 张工单」实际 36；`release/profile-install-baseline.md` 链接指向实际为 `.txt` 的文件，已顺手修正），以及 `dist/` 与 `plugin/` 的同步靠人记（bump `CLIENT_REV`）。
- **做法**：① `tools/check-docs.mjs` 加「目录文件数 vs 索引声明」与「相对链接存在性」检查；② 打包脚本加「`dist` 产物哈希 vs `plugin/` 源码哈希」比对，防装旧包；③ 错误码契约落一个 `plugin/errors.contract.json`，测试里断言 13 个码齐全。
- **验收**：故意写坏一个链接，`check-docs` 失败；故意改 `plugin/` 不打 `dist/`，打包检查失败。
- **借鉴**：BrowserSkill `protocol:check` 契约生成；browser-cdp 兼容矩阵。

### P2-5 分发（0.5–1 天，持续）

- **做法**：英文 README（现在中文为主，10.7k★ 的项目都是双语的）；兼容矩阵（对应 DSH 版本线，学 browser-cdp 的 `dshReleases` 表）；进 marketplace 目录；发布页贴 G0–G5 门禁结果。
- **判断**：我们 6★ 的原因一半是「今天才建仓」，另一半是「没有英文入口」。这条成本最低、杠杆最大。

### P2-6 安全：私网 URL 策略（0.5 天，可配置）

- **问题**：`browser_open` 只拦 scheme（`plugin/policy.js:64-80`），`http://127.0.0.1:PORT`、`192.168.x.x`、`localhost` 都放行。桌面场景风险中等（用户自己的机器），但「agent 把你路由器的管理页读走」是真实的。
- **做法**：配置项 `network.allowPrivate: false` 默认关，只对 agent 传入的 URL 生效；`browser_open({ path })` 的本地静态服务（127.0.0.1 随机端口）内部直通。给开发场景一个逃生阀（`allowPrivate: true`）。
- **验收**：默认配置下 `http://127.0.0.1:1/` 被拒且错误码清晰；`path` 模式仍正常。
- **借鉴**：browser-mcp 的 `is_global` + DoH 回退（我们桌面场景不需要 DoH，先做字面量 + `localhost`）。

## 7. 不建议做（反面教材）

1. **35/43 个工具全量注册**：browser-cdp 自己承认要懒注入省 98%，browser-mcp 用 toolset 只暴露一部分。我们的 11 个已经是合理量级，**不要**为了「能力全」往上堆。
2. **独立浏览器影子 + cookie 导入**：browser-cdp 要走这条路才能拿到登录态（`login-import.ts:1-34`），代价是 App-Bound Encryption、隐私面、用户信任。我们的租约路线在这件事上完胜，别倒退。
3. **`--remote-allow-origins=*` + 裸 CDP 端口**：等于把浏览器交出去。如果将来做 CDP 后端，鉴权必须走租约令牌。
4. **用 MCP 替换现有架构**：会丢面板、策略、接管、sha256、取消传播——我们所有独占物。MCP 适合「没有宿主的场景」，我们不是。
5. **按站点写死业务判定（JEV 类）**：脆、不可维护、不可泛化。
6. **把「无头/远程/多标签」当近期目标**：那是另一条产品线，做一半会两头不讨好。

## 8. 两周清单

| 时间 | 交付 | 验收 |
| --- | --- | --- |
| D1–D2 | P0-1 验证墙修复 + 4 个夹具；P0-2 回执语义 | 196 例 → 204 例全绿；TICKET-033 关闭；超时夹具断言 `effect:unknown` |
| D3–D5 | P0-3 下载 page 通道（同源 + 回退） | 同源附件 sha256 与浏览器直下一致 |
| D6–D8 | P1-2 `loc=` 定位；P1-3 快照续读 | 跨快照定位成功；长页面两段拼全文 |
| D9–D10 | P1-1 点击可验证；P2-4 文档/打包门禁 | 5 个点击夹具；`check-docs` 能抓坏链接 |
| D11–D12 | 报告落地 + README 英文版 + 兼容矩阵 | 用户能按 README 独立装通 |
| 持续 | P1-6 描述瘦身观察、P2-1/2-2 探针结论回填 TICKET | 每周记录工具面字符数与路由正确率 |

## 9. 附录：证据索引

- 竞品技术简报：`tmp/gh/browserskill.brief.md`、`tmp/gh/browserpaw.brief.md`、`tmp/gh/browsermcp.brief.md`、`tmp/gh/browserauto.brief.md`、`tmp/gh/browsercdp.brief.md`（均含 `file:line`）
- 本项目关键位置：
  - 验证墙：`plugin/inject/detect.js:33,38-57,88-104,119-126,134-171`；`plugin/client.js:467-503,536,546`；`docs/tickets/033-challenge-detection-gap.md`
  - 快照/ref：`plugin/inject/snapshot.js:70,214-215,222,249-272,297-298,322-329`；`plugin/tools.js:292,312-316,357,368`
  - 动作：`plugin/inject/actions.js:142,157-158,659-660`；`plugin/tools.js:674,692,731`
  - 错误码：`plugin/errors.js`（13 码，逐个带 `retryable` / `hint`）
  - 策略/下载：`plugin/policy.js:64-80`；`plugin/downloads.js`
  - 相位机：`plugin/bridge.js:49,268-289`；`plugin/client.js:441-455,945-989`
  - 宿主源码：`app.asar` → `lib/main.js:18242-18244`（will-download 拦截）、`:18233-18241`（会话权限全拒）、`:18245-18256`（URL 白名单）、`:18227-18231`（导航释放租约）、`:17666-17684`（登录会话）、`:1535-1571`（受信窗口下载）
- 测量口径：`node --test plugin/test/*.test.mjs`（196 例，687ms）；工具 schema 字符数 = 对 `plugin/tools.js` 11 个工厂的 `description + JSON.stringify(parameters)` 求和；LOC = `plugin/*.js` 8,171 + `plugin/inject/*.js` 1,305 + `plugin/test/*.mjs` 3,686。
- 元数据快照（2026-11-24，GitHub API）：见 `tmp/gh/*.brief.md` 头部。
