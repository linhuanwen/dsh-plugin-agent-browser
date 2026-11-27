# 1.5.x 发布说明（信任闸门版）

> 目的：把 1.5.x 说清楚——它只做两件事：**验证墙漏报的修复**（TICKET-033）与**首次写动作确认**（SPEC-003 / TICKET-037–039）。没有新增工具、没有改工具 schema、没有动通道与快照格式。
>
> 1.5.1 是 1.5.0 的验收期修正，修两个只有装上真机才看得见的问题：
> 1. `plugin/apply.js` 交给工具体的是「claim + 展示策略」薄门（`gate`），而 `createGate` 靠 `approve`/`hasClient`/`pageOf` 判断宿主能不能问人；薄门没转发这三个方法，导致 `canAsk()` 永远为 false，写动作在真机上**一次都不确认**（单测的假桥本来就没有这些方法，所以 231 例全绿没照出它）。
> 2. 密码框的「硬拒」发生在**页面侧**（`inject/actions.js`），而审批在**宿主侧**先跑：打密码框会先弹出确认条、用户点了「允许」也只会换来拒绝，白等 30 秒。修法是 `browser_type` 先 `inspect` 目标，`role === 'password'` 就不进确认、交给页面直接硬拒。
>
> 修法都配了 `plugin/test/gate.test.mjs`（11 例）锁住：type/提交点击先 inspect 再问、密码框不问、普通链接与坐标点击不问、站点授权只问一次、mode off、宿主不能问时退回 1.4 行为、下载与拒绝路径、eval 先 inspect 拿页面 origin。单测 231→241。
>
> **1.5.2 是 1.5.1 的验收收口**，修三个真面板验收才暴露的问题：
> 1. `bridge.request()` 把除 `snapshot` 外的一切命令都当成「agent 在动作」，于是审批前的 `inspect` 会把 `needs_human` / `taken_over` 相位清回 `agent`——验证墙页面上 `browser_eval` 竟能直接跑掉。修法：`READ_TYPES = {snapshot, inspect}` 的读命令不再抢相位。
> 2. `bridge.approve()` 没先看人工相位，会在验证墙/接管期间弹出注定无法履行的确认条。修法：`approve()` 开头 `#assert(sessionId, 'type')`，人工相位优先（SPEC-003 C8）。
> 3. eval 提示的站点名取自面板 `/page` 遥测，本机宿主上该上报未落地，提示写成「当前页面」。修法：eval 审批前先让页面侧 `inspect` 提供 `location.href`，origin 不依赖遥测（`/page` 保留为遥测）。
> 同批补齐：`bridge.test.mjs` 新增 3 例（needs_human/taken_over 优先、读命令不抢相位）；`docs/cases/015` §4 记录全量真机验收。单测 241→245。
>
> **1.5.3 是阶段 A 的第一件能力补口（TICKET-041，JS 弹窗）**：页面里的 `alert/confirm/prompt` 过去完全没处理——渲染进程会被原生弹窗冻结，所有工具一起卡到超时。现在注入守卫（`inject/guards.js` rev 3）拦截并记录它们：`alert` 返回 `undefined`、`confirm` 返回 `false`、`prompt` 返回 `null`（保守答案，不替人点确定），内容以 `blocked dialogs` 段落出现在触发它的工具结果里；下一次 `snapshot` 也会带出迟到的弹窗。新增 `dialogs.mode`（`record` 默认 / `off` 恢复原生，会冻结页面直到人点掉）。冒烟期抓到一个只会在真机出现的 bug：`Guest.readDialogs()` 把数组 `JSON.stringify` 后交给会先 JSON 解码一次的 `evaluate`，二次解析失败被静默吞掉——改成直接返回数组（`CLIENT_REV` 49→50）。真机证据在 `docs/cases/016`；`off` 模式真机对照待 TICKET-040（白屏根因）结案后补。单测 245→251。
>
> **1.5.4 是阶段 A 的第二件（TICKET-042，写动作回执三态）**：写动作过去只有「成功 / 抛错」两种结局，无法回答「这次到底发出去了没有」。现在：成功结果带 `effect:'committed'`；没发出（参数/审批/策略/相位/入队前失败）带 `details.effect:'none'`；**已下发但回执丢失**（超时/断线/取消/接管/关闭）返回新错误码 `action_unknown`（`retryable:false`，hint 明确「先 `browser_snapshot` 核对，不要重发」）。`browser_eval` 的页面侧抛错也改报 `action_unknown`（脚本到过页面）。`bridge_timeout` 语义不变（未发出）。单测新增 `effect.test.mjs` 8 例、`cancel.test.mjs` 改断言，251→259；真机两条 unknown（eval 页面抛错、接管中断），见 `docs/cases/017`。已知边界：已下发后页面回报 `ok:false` 仍统一按 `none`（`browser_eval` 抛错除外），`type` 中途失败边界尚未细拆。
>
> **1.5.5 是阶段 B 的第一个能力（TICKET-044，`browser_wait`）**：页面异步是常态（等列表出现、等「保存成功」、等遮罩消失），此前 agent 只能用 `browser_eval` 轮询（写动作、要审批、容易跑在旧页面）、连续 `snapshot`（整棵 a11y 树，浪费上下文）或硬睡。现在新增第 12 个工具 `browser_wait({selector?, text?, gone?, timeoutMs?})`：恰好传一个 selector/text，`gone` 反转，`timeoutMs` 默认 10000（夹到 100–15000）；页面侧只做一次同步判定（`inject/wait.js`；selector 判定**可见**而不是 DOM 存在性——`display:none`/`visibility:hidden`/零盒子不算「出现」，避免隐藏骨架提前报成功；非法选择器按「没找到」处理），轮询在面板（150ms 间隔、可取消），**超时是正常结果**（`matched:false, timedOut:true`）而不是错误码。它是**纯读**：零审批；`needs_human` / `taken_over` 下仍可用且不抢相位（`bridge.js` 的 `READ_TYPES` 加 `wait`）。`CLIENT_REV` 50→51，工具总数 11→12（`check-docs` 期望数、根/用户 README 工具表同步）。单测新增 `wait.test.mjs` 16 例 + bridge 2 例，259→277。真机夹具 `demo/wait.html`，验收记录见 `docs/cases/018`。
>
> **1.5.7 是阶段 B 的第三个能力（TICKET-046，快照 `cursor` 续读）**：长页面的快照会超出字符预算被截断，此前只能拉大 `maxChars`（仍会截断）、缩小范围或重拍整棵树（重复付 token）。现在截断的快照会返回 `cursor`（`<stamp>@<offset>`，stamp 由 URL 指纹、总行数、引用数、字符数拼成），部署 `browser_snapshot({cursor})` 就取下一段：只包含新行、带一行续读抬头，续读默认不附图（省 token，可显式 `includeImage:true` 找回）。页面在两次快照之间变了（导航、列表增删、DOM 重渲染导致 stamp 变化）就返回**第 18 个错误码 `stale_cursor`**（可重试），不断言给出错位的一段。`CLIENT_REV` 52→53；单测新增 `snapshot-cursor.test.mjs` 7 例，289→296。真机证据见 `docs/cases/020`。
>
> **1.5.6 是阶段 B 的第二个能力（TICKET-045，快照稳定定位符 `loc=`）**：快照里的 `ref` 每次重编号，旧 ref 过期后只能整页重拍；现在快照会给每个交互节点追加 `[loc="css:…"]`——用 `#id` / `[data-testid]` / `tag[name]` 锚点加 `nth-of-type` 位置路径，路径经过 `querySelector` 自校验（指向别处就不打印），iframe 内带 `f1:` 前缀，超过约 120 字符省略。`browser_click` / `browser_hover` / `browser_type` 新增 `loc` 参数（跨快照有效；与 `selector`、坐标点击互斥；`type` 的 `ref`/`loc` 二选一）；审批门的提交类判断与密码框早退对 `loc` 同样生效。定位失败分 `bad_loc`（格式不认识）与 `stale_loc`（页面里已找不到），都带 `effect:'none'`、重试安全。`CLIENT_REV` 51→52。单测新增 `snapshot-loc.test.mjs` 3 例 + actions 6 例 + gate 3 例，277→289（第三例锁住「无法解析的 loc 不弹确认、直接由动作报 `stale_loc`」）。真机证据见 `docs/cases/019`。
>
> **TICKET-040（客户端重载后白屏）的结论与规避（2026-11-26）**：两次白屏都发生在「插件客户端/host 重载后约 1 分钟内 + 面板正在交互（确认条）」的窗口里，但四组最小实验（客户端 entry 重载、host 半重建 + 确认条、bundle 启停、重载后静置）均**未能复现**；静态勘察确认 DSH 外壳没有整页刷新、React slot 有错误边界、渲染进程异常会显示错误页而不是白屏，因此按「不可复现 + 文档化规避」收口。**使用与验收注意**：真机验收/演示前先重启一次 DSH、一次性配好插件配置；验收过程中不要改 `cordis.patch.yml`，也不要用 `plugin_manager` 启停插件 bundle；若必须改配置，等面板重挂（回 `about:blank`）后重新 `browser_open` 再继续。万一白屏，直接重启 DSH 即可恢复（会话与配置不丢）。详见 `docs/tickets/040-blank-window-on-client-reload.md`。
>
> **1.5.8 是阶段 B 的第四个能力（TICKET-047，`browser_upload`）**：agent 第一次能往页面里上传文件。宿主先读工作区文件（`realpathSync` 后必须落在工作区根目录内；单文件 2 MiB、合计 4 MiB、最多 5 个），base64 走长轮询交给面板，页面侧用 `DataTransfer` + `File` 合成文件、赋给 `<input type=file>.files` 并派发 `input`/`change`——不走 CDP、不打开宿主原生文件选择器（决策 005）。新增第 13 个工具 `browser_upload({ref?,loc?,selector?,strict?,files})`，新增不可逆写 `actionClass:'upload'`（第一次在站点上传要确认，文案只含站点与文件名、不含工作区路径），成功结果 `effect:'committed'`，失败统一 `upload_rejected`（第 19 个错误码，`retryable:false`，带 `reason`；路径越界/缺失/超限/目标不是 file input 都在读字节与弹条之前拒绝，`effect:'none'`）。`CLIENT_REV` 53→54。真机验收期修掉三个只有装上才看得见的问题（`inspect` 丢 `acceptsFiles`、上传命令漏传 `source`、注定失败的列表先弹确认条），单测 296→**309**；真机证据见 `docs/cases/021`。
>
> **1.5.9 是阶段 B 的第五个能力（TICKET-048，`browser_scroll` 寻址滚动）**：`browser_scroll` 过去只能移动页面（`dy` / `to` / `container`），想把某个元素滚进视口只能反复 snapshot、或 eval 写 `scrollIntoView`（写动作、要审批）、或点它（会真的点击）。现在 `browser_scroll({ref?,loc?,selector?})` 使用与动作工具相同的地址（`loc > selector > ref`，三者互斥，且不能与 `dy`/`to`/`container` 混用），在页面内 `scrollIntoView({block:"center",inline:"center"})`，回执新增 `mode:"into-view"`、元素 `rect`、`visible`、`fullyVisible`、`info`、`frame`；旧的 `dy`/`to` 行为逐字不变（`mode:"by-dy"`/`"to-edge"`）。它是**纯读**：零审批；但和既有的 `browser_scroll` 一样仍属 `INPUT_TYPES`——`needs_human`/`taken_over` 相位下会被直接挡住（`needs_human`/`panel_taken_over`）且不改变相位，不新增例外。地址失效复用 `stale_loc`/`bad_loc`，`effect:"none"`。无新增错误码（仍 19 个），`CLIENT_REV` 不变（`Guest.act` 白名单已含这些字段）。单测新增 `scroll.test.mjs` 8 例 + bridge 1 例，309→**318**；真机证据见 `docs/cases/022`。
>
> **1.5.10 是阶段 B 的第六个能力（TICKET-049，页面 console 尾巴）**：agent 点了按钮、页面没反应时，此前只能看到「DOM 没变」，看不到页面自己在 console 里说了什么。现在 `browser_snapshot` 的末尾会附上两次快照之间页面打印的 console 日志与未捕获错误（最近 10 条，每条带 `[log]`/`[warn]`/`[error]`/`[pageerror]`/`[unhandled]` 前缀），**每次快照清空**缓冲，同一条日志不会重复占上下文。实现上不新增工具、不新增错误码：guards 注入（rev 3→4）包装 `console.log/info/warn/error/debug`（仍调用原函数）并监听 `window` 的 `error`/`unhandledrejection`，环形缓冲 40 条、每条截 240 字；面板 `readConsole()` 读出即清空（`CLIENT_REV` 54→55）。验收期修掉一个分类缺陷：无 `type` 的 `<button>` 此前被一律当成提交类（导致普通按钮也弹确认条），现在只有**表单内**的无 type 按钮才算提交（`type="submit"` 始终算），符合 SPEC-003 C2 原文。单测新增 `console.test.mjs` 4 例 + guards 4 例 + actions 1 例，318→**327**；真机证据见 `docs/cases/023`。
>
> **1.5.12 是阶段 B 的第七个能力（TICKET-050，面板标签页 tabs）**：此前面板只有一页，`browser_open` 总在同一个 webview 里导航，开 B 就要丢掉 A 的滚动、表单与 SPA 路由。现在面板顶部多了一条标签条：`browser_open({ ..., newTab:true })` 在**新标签**里打开页面（当前页留在后面继续活着），新工具 `browser_tabs({ action:"list" / "switch" / "close", tab })` 列出、切换、关闭标签。`switch` 只换屏幕前的页，每张标签保有自己的滚动、输入与页面状态；`close` 关闭不存在的 id 报 `tab_not_found` 且什么都不关；关闭最后一个标签会先建一张空白页再销毁旧的（面板永远有页）；上限 `MAX_TABS = 6`，超了报 `tab_limit`。实现上每个标签是**一个真实 webview + 一份独立租约**（同一 workspace 复用同一 partition，所以登录态跨标签共享），`Guest` 增加 `tabId`/`onTitle`，让标题与导航回滚按标签记。桥把 `tabs` 加进 `READ_TYPES`（列标签不抢相位），但 `switch`/`close` 在 `taken_over`/`needs_human` 下被拒（用户正在看的那页不能被 agent 换走、验证墙也不能被藏起来）；`tabs` 不进 `WRITE_TYPES`（没有页内 effect，超时即「没执行」）。错误码 19→21，工具 13→14，`CLIENT_REV` 55→56。验收期修掉两处只有真机才看得见的问题：`list` 显示的 URL 是建标签时的缓存（改为回答前按需 `refreshUrls()` 读 `getURL()`）、空白页标题被 Electron 的 `getTitle()` 污染成 `about:blank#…`（`noteTitle` 过滤 + 快照兜底为「新标签页」）。单测新增 `tabs.test.mjs` 8 例并把工具计数改到 14，327→**335**；真机证据见 `docs/cases/024`。**注意**：1.5.11 是内部构建（未发布）；1.5.12 安装后若面板还是旧行为（标签条没出现、标题还是旧的），说明客户端 bundle 被 web shell 缓存了，完整重启一次 DSH 即可（本轮验收即如此）。

> **1.5.13 是阶段 B 的第八个能力（TICKET-051，页面 network 失败尾巴）**：点了按钮页面没反应的另一个大头是页面自己的请求失败——`fetch('/api/list')` 拿到 401/500、XHR 404、请求根本没发出去（`TypeError: Failed to fetch`），前端 catch 后 DOM 没有变化、console 里也常常不打印。现在 `browser_snapshot` 末尾会附上两次快照之间**页面自己发出**的 `fetch`/`XMLHttpRequest` 失败（最近 10 条，形如 `- [fetch] GET /api/list → 500, 12ms`、`- [fetch] GET http://… → failed — TypeError: Failed to fetch`），抬头 `page network (M failed of N request(s)):` 写清失败条数与请求总数（成功请求只进分母），**每次快照清空**。实现上不新增工具、不新增错误码：guards 注入 rev 4→5 包装 `fetch` 与 `XMLHttpRequest`（仍调用原实现，页面的 Promise/XHR 语义不变；`no-cors` 的 opaque 响应读不到状态，不算失败只计数），环形缓冲 40 条、只记失败、同源 URL 缩成 `path+query` 并截 200 字；面板 `readNetwork()` 读出即清空（`CLIENT_REV` 56→57）。不记录响应体/请求头/cookie/WebSocket/dom-ready 之前的请求。单测 guards 16→22 例 + 新增 `network.test.mjs` 4 例，335→**345**；真机证据见 `docs/cases/025`。
>
> **1.5.14 是阶段 B 的第九个能力（TICKET-052，`browser_drag`）**：很多页面只能用手势驱动——滑块调音量、看板卡片排序、拖选表格区域、canvas 上的把手。此前 agent 只能 `browser_click`（按下即抬，拖不动）或 eval 合成事件（写动作、还要审批）。现在新增第 15 个工具 `browser_drag({from, to, steps?})`：`from` 是页面元素地址（`ref`/`loc`/`selector` 之一），`to` 可以是另一个元素地址、视口坐标（`toX`/`toY`）或相对位移（`dx`/`dy`，相对源元素中心），`steps` 2–30 默认 8。拖拽在页面侧合成 `PointerEvent` + `MouseEvent` 序列（`pointerover` → `pointerdown` → 每步 `pointermove`(buttons=1) → `pointerup`，步间等一帧），落点由每步 `elementFromPoint` 决定，因此 React DnD / dnd-kit / SortableJS / slider 这类监听 pointer 事件的页面能真的收到手势；**原生 HTML5 drag-and-drop（`draggable="true"` 的 dragstart/drop）与 OS 文件拖拽不在 v1 覆盖范围**。拖拽是写动作：新增第六类 `actionClass: 'drag'`（无法从 inspect 判断是否提交/改状态，因此一律首次触站必问，文案只含站点与源元素可读名、不含坐标），`bridge.js` 的 `INPUT_TYPES`/`WRITE_TYPES` 同步收编（人工相位拒绝、超时/接管按 `action_unknown` 处理）。失败在派发前就定「没执行」：源/落点不存在或失效复用 `not_found`/`multiple`/`stale_loc`/`bad_ref`、被挡 `occluded`、越界 `out_of_view`、源禁用 `disabled`；无新增错误码（仍 21）。`CLIENT_REV` 57→58，工具 14→15。单测 `actions.test.mjs` 45 例（含 8 例页面侧拖拽）+ 新增 `drag.test.mjs` 7 例，345→**360**；真机证据见 `docs/cases/026`。
>
> **1.5.15 是阶段 B 的第十个能力（TICKET-053，`browser_pick` 页内点选）**：agent 要操作「那个东西」时，最缺的是「是哪一个」——一串只有图标的按钮、十个长得一样的「删除」、canvas 里画出来的控件，快照里读出来全是空名；inspect 要先有地址；猜坐标页面一滚就错。现在新增第 16 个工具 `browser_pick({ timeoutMs? })`：请在面板前的人直接在页面上点一个元素，回执给出结构化引用——`loc`（`css:` 稳定路径；没有唯一路径时为空）、`info`（tag/role/name）、`rect`、`point`，随后用 `browser_click { loc }` 等既有动词操作。**点选的那一下页面收不到**：页面侧在 window 捕获阶段 `preventDefault` + `stopImmediatePropagation`，并在 pointerdown 命中后装一次性 `click` 吞掉随后那一下（页面自己的 `document` 监听器也看不到），页面状态不变；因此它是**纯读**——零审批、无新错误码（仍 21），`needs_human` 下放行（人本来就在处理页面），`taken_over` 下拒绝（`panel_taken_over`，不能从人手里抢面板）；超时/Esc 都是正常回执（`{picked:false,timedOut:true}` / `{picked:false,cancelled:true}`）。`READ_TYPES` 加 `pick`。验收期修掉四个只有真机才看得见的问题：① `inject/pick.js` 漏进打包清单（`tools/pack.mjs` 补 COPY）；② 取消谓词误用模块级 `state.phase`（初始 booting）导致 pick 秒取消（改为 `phases.get(sessionId)?.phase === 'taken_over'`）；③ 点选的 click 漏进页面（监听器从 document 改挂 window + 一次性吞 click，修后页面点击计数为 0）；④ 回执 loc 缺 `css:` 前缀导致 `browser_click` 报「not a loc」（新增 `pickLoc`）。另因「焦点不在页面时 Esc 收不到」，面板新增「取消点选」按钮（点选进行中出现在缩放控件左侧），开始点选时也会把焦点交给页面。`CLIENT_REV` 59→60，工具 15→16。单测新增 `pick.test.mjs` 15 例并把计数改到 16，360→**375**；真机证据见 `docs/cases/027`。

> **1.5.16 是阶段 B 的第十一个能力（TICKET-054，`browser_pick` 框选）**：1.5.15 的点选解决「是哪一个」，一次只解决一个；「把这十个复选框都勾上」「读一下这张表里所有行」「这个区域里的所有按钮」还是一次一个地指。现在 `browser_pick` 增加 `mode:"box"`（工具数仍 16，模式收进参数）：请在面板前的人**拉一个框**，回执给出框内元素列表——每项含 `loc`（`css:` 稳定路径）、`info`（tag/role/name）、`rect`、`point`，另有 `box`、`total`（去重后的真实命中数）、`truncated`；`limit` 默认 20（夹 1–100），超出时只返回前 limit 条并标 `truncated`，agent 再逐个 `browser_click { loc }`。框选仍是**纯读**：页面侧在 window 捕获阶段拦下 pointerdown/move/up、拖完再吞掉随后那一下 click，页面收不到按下/拖动/松手，也不改 DOM；页面里的文字不会被选中（body `user-select:none` 仅在框选期间生效，结束恢复）。框太小（宽或高 <4px）或框内没有可操作元素时返回空列表 + `total:0`，算正常回执；Esc / 面板「取消点选」按钮随时中止；`needs_human` 放行、`taken_over` 拒绝与 element 模式一致；超时仍是正常回执。无新增错误码（仍 21），桥无需改动（`pick` 已在 `READ_TYPES`），`CLIENT_REV` 60→61。实现边界：12px 网格采样可能漏掉更小的目标；列表同时包含容器与文本节点（它给的是候选，不是唯一答案）；跨域 iframe 只能框到宿主 `<iframe>`；canvas 只返回整体。单测 `pick.test.mjs` 15→26 例，360→**386**；真机证据见 `docs/cases/028`。

> **1.5.22 是阶段 B 的第十二个能力（TICKET-055，页面内可见反馈）**：agent 点了、拖了、输入了，页面确实变了，但人看着面板只觉得「它刚才动了什么？」。现在只要动作回执里带坐标/矩形，面板就会在页面里补画一笔：点击是扩散环 + 圆点，悬停是空心光标点，滚动与输入是元素高亮框，拖拽是起点到终点的连线 + 两端圆点。痕迹画在一个独立的固定覆盖层里（`pointer-events:none`、固定 z-index、不派发事件、不读页面），**页面收不到任何东西**；每笔按 `feedback.durationMs`（默认 900ms，夹 100–5000）自动消失。配置新增 `feedback: { enabled: true, durationMs: 900 }`（关掉即完全静默，动作不受影响），设置页也多了一组「可见反馈」。实现用了新的 `inject/feedback.js`（`dshFeedback`：cursor/click/highlight/drag/clear，节点上限 24，非法输入安全返回）+ 面板侧 `Guest.beaconFor`/`Guest.beacon`（读 `/config` 与 `/source?name=feedback`，失败只记日志、绝不影响动作）；`CLIENT_REV` 61→64。验收期修掉五个问题：点映射只看 `point` 而 click/hover 回执是 `x/y`；type 回执缺 `rect`；**`inject/feedback.js` 漏进打包清单**（`tools/pack.mjs` COPY 漏列，诊断日志表现为 `source: length 0`；顺带新增 check-docs 第 7 项「inject 脚本 ↔ COPY 清单」双向比对）；客户端 bundle 缓存导致新代码不生效（需完整重启 DSH）；截图时延必须把动作与截图放进同一批工具调用。单测 386→**394**（`feedback.test.mjs` 7 例、config 2 例）；真机证据见 `docs/cases/029`。

> 日期：2026-11-24（1.5.1 验收于 2026-11-25，1.5.2 同日晚收口，1.5.3 与 1.5.4 于 2026-11-26，1.5.5–1.5.10 于 2026-11-27，1.5.11 为内部构建、1.5.12 于 2026-11-27 收口，1.5.13 同日晚收口，1.5.14 紧接其后收口，1.5.15 于 2026-11-27 收口，1.5.16 紧随其后收口，1.5.22 同日深夜收口（1.5.17–1.5.21 为内部构建））。适用对象：DSH **Desktop**，宿主实测 `0.2.2-rc.5`。上一版基线：1.4.24。
> 相关：用户侧文档 `dist/dsh-plugin-agent-browser/README.md`；契约 `docs/spec/003-first-touch-approval-spec.md`；决策 `docs/decisions/010-first-touch-approval.md`；夹具 `docs/cases/015-first-touch-cases.md`。

## 1. 发布物

| 项 | 值 |
|---|---|
| 包名 / 版本 | `dsh-plugin-agent-browser` @ **1.5.22**（1.5.0 + 两轮验收期修正 + TICKET-041 JS 弹窗 + TICKET-042 写动作回执三态 + TICKET-044 `browser_wait` + TICKET-045 快照 `loc=` + TICKET-046 快照 `cursor` + TICKET-047 `browser_upload` + TICKET-048 `browser_scroll` 寻址滚动 + TICKET-049 页面 console 尾巴 + TICKET-050 面板标签页（tabs） + TICKET-051 页面 network 失败尾巴 + TICKET-052 拖拽 `browser_drag` + TICKET-053 页内点选 `browser_pick` + TICKET-054 `browser_pick` 框选（`mode:"box"`） + TICKET-055 页面内可见反馈（`feedback`），见开头；1.5.11 与 1.5.17–1.5.21 为内部构建、未发布） |
| 产物 | `dist/dsh-plugin-agent-browser/dsh-plugin-agent-browser-1.5.22.tgz`，369,607 B / 28 文件；sha256 `9e57decef56f3e42df3fdc0ab65a4c481c541cd72f9b7c4c65ce030b25f5d7cd`（历史 1.5.16 = 364,587 B / `bf7d8a46…`、1.5.15 = 361,128 B / `6c0207aa…`、1.5.14 = 353,275 B / `285eaf9f…`、1.5.13 = 348,861 B / `1ADC4DFF…`、1.5.12 = 346,051 B / `4BAD7FA1…`、1.5.10 = 339,454 B / `0E1E4FFE…`、1.5.9 = 337,820 B / `707FC466…`、1.5.8 = 336,112 B / `9ED041CB…`、1.5.7 = 330,413 B / `1EF93A55…`、1.5.6 = 328,742 B / `1D2933C7…`、1.5.5 = 325,936 B / `F75E76AE…`、1.5.4 = 322,516 B / `A757E17C…`） |
| 许可 / 元数据 | `license: MIT`、`private: false`、`engines.dsh: ">=0.2.2-rc.3 <0.3.0"`、peer+dev `@deepseek-ai/schemastery ^3.19.0` |
| 新增源文件 | `plugin/approvals.js`（1.5.0 起，纯逻辑）；`inject/guards.js` rev 3（1.5.3 起含弹窗守卫）；`plugin/inject/wait.js`（1.5.5 起，等待探针）；`plugin/inject/snapshot.js` 的 `cssPathOf` + `plugin/inject/actions.js` 的 `resolveLoc`（1.5.6 起，快照 `loc=` 生成与嗅探）；`plugin/inject/snapshot.js` 的 `cursor` 分页与 `stamp` 指纹（1.5.7 起，快照续读）；`inject/actions.js` 的 `isFileInput`/`base64ToBytes` 与 `upload` 分支、`plugin/tools.js` 的 `browserUploadTool`/`readUploadFile`（1.5.8 起，文件上传）；`plugin/client.js` 的 `TabStore`/`runTabCommand` 与 `plugin/tools.js` 的 `browserTabsTool`（1.5.12 起，面板标签页）；`plugin/inject/guards.js` rev 5 的 `fetch`/XHR 包装、`plugin/client.js` 的 `Guest.readNetwork` 与 `plugin/tools.js` 的 `networkNote`（1.5.13 起，页面 network 失败尾巴）；`plugin/inject/actions.js` 的 `drag` 分支（`dragEvent`/`dragSequence`/`dragPayload`）、`plugin/client.js` 的 `Guest.drag` 与 `plugin/tools.js` 的 `browserDragTool`（1.5.14 起，拖拽）；`plugin/inject/pick.js`（点选状态机 `start`/`poll`/`stop`）、`plugin/client.js` 的 `Guest.pick`/`Guest.cancelPick` 与 `plugin/tools.js` 的 `browserPickTool`/`pickSource`（1.5.15 起，页内点选）；`plugin/inject/pick.js` 的 box 模式（`collectInBox`/`installBoxListeners`/`limit`）、`plugin/client.js` 的 box 回执映射与 `plugin/tools.js` 的 `mode`/`limit`（1.5.16 起，框选）；`plugin/inject/feedback.js`（`dshFeedback`，1.5.22 起，动作后页面内痕迹）、`plugin/client.js` 的 `Guest.beaconFor`/`Guest.beacon` 与设置页「可见反馈」组 |
| 单测 | `394 / 394` 通过（`node --test plugin/test/*.test.mjs`；`actions.test.mjs` 45 例（含 8 例拖拽）、`drag.test.mjs` 7 例、`pick.test.mjs` 26 例、`network.test.mjs` 4 例、`tabs.test.mjs` 8 例、`console.test.mjs` 4 例、`scroll.test.mjs` 8 例、`upload.test.mjs` 10 例、`snapshot-cursor.test.mjs` 7 例、`snapshot-loc.test.mjs` 3 例、`wait.test.mjs` 16 例、`effect.test.mjs` 8 例、`guards.test.mjs` 22 例、`config.test.mjs` 14 例、`approvals.test.mjs` 18 例、`gate.test.mjs` 17 例、`feedback.test.mjs` 7 例） |
| 文档一致性 | `node tools/check-docs.mjs` 七项全绿（配置字段 23、工具 16、YAML 14 顶层字段、decisions 10、B11、file:line 12、打包清单：7 个 inject 脚本） |

## 2. 安装 / 升级 / 卸载

```powershell
plugin_manager install_bundle target="D:\...\dist\dsh-plugin-agent-browser\dsh-plugin-agent-browser-1.5.22.tgz"
plugin_manager list_plugins   # 目标行：include:agent-browser-panel / enabled true / fiberPhase active
```

- 装完**刷新一次 DSH 页面**：本次 `CLIENT_REV` 48→…→61（弹窗结果回传、二次解码修复、`wait` 命令分发、`cursor`/`console`/`network` 读取、标签页、拖拽、点选/框选与可见反馈都属于客户端 bundle），不刷新看不到；若确认刷新后仍是旧行为，完整重启 DSH（bundle 缓存会复用已执行过的旧模块）。
- **客户端 bundle 有缓存**：同版本重装、或只 touch 安装目录里的 `client.js`，web shell 会复用已执行过的 factory，面板重挂但跑的还是旧代码。装完若标签条没出现/标题还是旧的，**完整重启一次 DSH**（本轮验收即如此，1.5.12 首次安装后面板一度整轮无响应，重启恢复）。
- **`plugin/apply.js`、`bridge.js`、`tools.js` 属于宿主半**：本机实测 1.5.1 重装后新工具代码即时生效（`browser_type` 打密码框从「弹确认条等 30 秒」变成页面侧当场硬拒）；若装完行为没变，先重启 DSH 再看。同版本重装需 `remove_bundle` 再 `install_bundle`（同版本会被「already installed」挡回）。
- 升级保留 profile 里的 `config` 行；没写 `approvals` 的 profile 走默认值（`first-touch`，即**默认开启**）。
- 想完全回到 1.4.x 的无声行为：`approvals.mode: 'off'`，不需要降级包。
- 卸载同 1.4：删 profile patch 条目并重载，`screenshots/`、`downloads/` 是用户数据。

## 3. 相对 1.4.24 的行为变化（会让人"咦"的地方）

| 变化 | 1.4.24 | 1.5.0 | 影响 |
|---|---|---|---|
| 写动作 | 直接执行 | 默认**站点 × 会话第一次**问一次（输入 / 提交类点击/Enter / 下载 / eval / 上传文件 / 拖拽） | Agent 的自主动作会多一次等待；`approvals.mode='off'` 可关 |
| 面板 | 只有地址栏 + 四态徽章 | 顶部多一条确认条（允许一次 / 本会话允许本站 / 拒绝，30s 倒计时，Enter=拒绝）；1.5.12 起再加一条标签条（最多 6 个标签，标题/切换/关闭/新建，关最后一个先建空白） | 面板高度多约 88px；标签页让列表/详情、填一半的表单、A/B 两页可以同时活着 |
| 错误码 | 13 个 | **16 个**：新增 `approval_required`（面板不在/不可见，未下发）、`approval_timeout`（超时）、`approval_denied`（拒绝/接管）；1.5.4 起 17（`action_unknown`），1.5.7 起 18（`stale_cursor`），1.5.8 起 19（`upload_rejected`），1.5.12 起 21（`tab_not_found`、`tab_limit`）；1.5.14 仍 21（拖拽复用 `not_found`/`multiple`/`occluded`/`disabled`/`out_of_view`）；1.5.15/1.5.16 仍 21（点选与框选复用既有读路径） | 旧日志里的 13 码语义不变；新增三个都在 message 里带可读文案 |
| 验证墙 | 漏报 Cloudflare Turnstile 演示页 | 补「正在进行安全验证 / 验证您是人类 / 请稍候」等文案、`challenge-platform` iframe、打开后 2 秒内二次复检；meta refresh 秒跳页与纯静态验证页不再误报 | 判定函数 14 例单测；真站仍只回归过 nopecha 一例 |
| 接管 | 清空队列 | 接管时把**待确认**的写动作自动判为拒绝 | 不会出现「你接管了，30 秒后动作又冒出来」 |
| client 侧 | — | `POST /page` 上报地址、`POST /decision` 回传决定、`/pending` 响应多 `approvals` 帧 | 纯新增；旧面板（不刷新页面）不会有确认条，但也不会崩：`/decision` 不会被调用 |

## 4. 写动作确认怎么工作（用户视角）

- **读动作从不打扰**：`open`/`snapshot`/`scroll`/`hover`/`zoom`/`screenshot`、`browser_tabs({action:"list"})`、`browser_pick`（点选只回答「是哪一个」，页面收不到这次点击）、普通链接导航。
- **六类写动作**：输入文字、会提交表单的点击或表单内 Enter、下载、执行页面脚本、上传工作区文件（`browser_upload`，文案只含站点与文件名）、拖拽（`browser_drag`，文案只含站点与源元素可读名；拖拽无法预判是否改状态，一律按写动作首次触站必问）。密码框仍然是**直接硬拒**，不弹确认（密码不进文案、不进日志）。
- 第一次在某站点写：面板顶部出现「{站点} 想让 agent {做什么}」，三个选择：
  - **允许一次**：只放行这一次（批准与执行是同一个请求，动作恰好发生 0 或 1 次）；
  - **本会话允许本站**：本会话内同站点不再问（切换站点重置、会话结束作废）；
  - **拒绝** / 按 Enter：什么都不发，工具回 `approval_denied`。
- 30 秒不回答：按拒绝处理（`approval_timeout`），**不会**在你离开后偷偷执行。
- 面板不可见 / 没打开：立即失败（`approval_required`），不烧 30 秒预算，也不会在没有人的时候执行。
- 你点「我来接管」：待确认的写动作立即作废。

## 5. 已知限制与未验证项

- **按站点判断，不按登录态**：面板读不到 HttpOnly Cookie，无法区分「登录后页面」；用「站点首次写动作」这个可观测信号代替（ADR 010 §2）。
- **只覆盖六类写动作**：输入文字（type）、会提交表单的点击/Enter（submit）、下载（download）、页面脚本（eval）、上传文件（upload）、拖拽（drag）；非表单按钮的副作用（如「删除」按钮发 `fetch`）按读处理。
- **页面侧标记可伪造**：页面能把自己伪装成提交按钮，但最坏结果只是**多问一次**，不会少问。
- **F7/F8 已于 2026-11-26 真机验收通过（1.5.4）**：F7（`sensitiveSites` 每次必问）——同一 origin 第一次「允许一次」成功后，第二次写动作仍弹条，拒绝后未写入；F8（`mode:'off'` 逐字回退）——type/eval/提交点击全部直接执行，无确认条、无 `approval_*` 错误码。验收走「改配置 → 完全重启 DSH → 一次性验完」的安全路径（不热重载、不启停 bundle），证据见 `docs/cases/015` §5 与 `docs/tickets/043`。仍在契约层锁住的有：`plugin/test/config.test.mjs`、`plugin/test/approvals.test.mjs`、`plugin/test/gate.test.mjs`。U1 窗口隐藏时 `visibilityState` 的真实取值已由 F5 间接证实（面板不可见时 `<1s` 返回 `approval_required`）；U2（提交判定对 `form.submit()`/`requestSubmit()`/`fetch` 的覆盖）与 U4（30s 默认值）仍待更多真机样本。
- **面板 `/page` 遥测在本机宿主未落地**：不影响判定（写动作的 origin 来自页面侧 `inspect`），只影响遥测与未来的提示文案；已记入 TICKET-037 的后续项。
- **标签页的已知边界**：面板重建（切 session / 插件重载 / 重启 DSH）后标签不恢复；页面 `window.open` 不自动建标签；缩放按 session 共享；上限 6 个（`tab_limit`）；真机只验收了夹具页，真实登录站点的多标签行为未逐站取样。
- **拖拽的边界**：只覆盖页面脚本（pointer/mouse 事件族）实现的拖拽；原生 HTML5 drag-and-drop（`draggable="true"` 的 dragstart/drop）与 OS 文件拖拽不覆盖；`from` 必须是页面元素地址（不能从空白坐标起拖）；轨迹是线性插值（`steps` 2–30），没有多段路径/曲线；跨域 iframe 的指针事件受既有 frame 规则限制。
- **可见反馈的边界**：痕迹是纯覆盖层（`pointer-events:none`、固定 z-index），可能被页面自身的高 z-index 元素遮住；只覆盖回执里带坐标的动作（click/hover/scroll/type/drag）；关掉 `feedback.enabled` 需改配置重启后生效（分支由单测覆盖，真机未逐项验）；默认 900ms，要截图留证可调到 5000。
- **点选的边界**：页面收不到这次点击（这是设计）；Esc 只在页面有键盘焦点时生效，焦点在聊天框时用面板「取消点选」按钮；没有唯一 CSS 路径的元素 `loc` 为空、只能用 `point`（滚动/重排后失效）；跨域 iframe 只能点到宿主；不做逐元素多选、不做「点选即执行」、不做拖拽起点点选、页面一导航就取消。
- **框选的边界**：`browser_pick {mode:"box"}` 让人拉框，返回框内候选元素列表——12px 网格采样，比 12px 更小的目标可能漏采；列表包含容器与文本节点（是候选，不是唯一答案）；`limit` 默认 20（夹 1–100），`total` 是去重后真实命中数；跨域 iframe 只能框到宿主；canvas 只返回整体；拖框期间的按下/拖动/松手与框选结束后的那一下 click 页面都收不到；框太小/框内无元素返回空列表，属正常回执。
- **network 尾巴的边界**：只覆盖 guards 注入之后页面自己发出的 `fetch`/XHR；不记录响应体、请求头、cookie、Service Worker 内部请求、WebSocket/EventSource 帧，也不记录 dom-ready 之前的请求；成功的请求只进分母、不出现在尾巴里。
- **真实验证墙**只回归过 `nopecha.com/demo/cloudflare` 一页（needs_human → eval 被拒 → 人工过墙后恢复，均通过）；其他厂商墙未取样。

## 6. 回滚

| 手段 | 做什么 |
|---|---|
| 配置回滚 | `approvals.mode: 'off'` → 读/写动作都与 1.4.24 一致（F8 夹具验收项） |
| 版本回滚 | 重装 `dsh-plugin-agent-browser-1.4.24.tgz`（sha256 `55086470b4bb7c615ffbed19dfa998e08783b63158e66a1d269713d6b46620f5`） |
| 只回滚验证墙 | 无单独开关；033 的改动只在 `inject/detect.js` + `client.js` 的 open 复检，回滚整包即可 |
