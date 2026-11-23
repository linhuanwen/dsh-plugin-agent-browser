# TICKET-005：接管开关与验证检测

- 状态: ✅ 通过（2026-11-20）
- 优先级: P0
- 关联 Spec: `docs/spec/001-agent-browser-plugin-spec.md` §2、§4.2、§8.4、§10
- 依赖: TICKET-002、TICKET-004
- 实施位置: `plugin/inject/detect.js`、`plugin/bridge.js`、`plugin/tools.js`、`plugin/client.js`
- 实施记录: `docs/cases/006-takeover.md`

## 目标

把"遇到人机验证就交给用户"这件事做成**产品能力**，而不是靠 Agent 自觉：面板上常驻「我来接管 / 交还 Agent」，状态机在 host 侧硬性拦截工具调用；同时给 Agent 一个检测器，让它能识别"我现在被拦住了"并主动暂停。

## 背景

用户原话（m00234）："那这一块暂时不管，但是你要预留人工接管的功能，这样遇到验证我还能直接接管去过验证。" 决策 D05 定的是**显式双向开关**，不是"触碰即抢占"——因为一旦触碰抢占，Agent 的正常 `type` 会把自己踢出驾驶位。

不做的事（已与用户达成一致）：不自动过验证、不做 stealth 注入、不改指纹、不接打码平台、不伪造 token。检测器只负责**发现并停下**。

## 状态机（实际实现）

```
idle ──browser_open / 任何输入命令──▶ agent
agent ──用户点「我来接管」──────────▶ taken_over
taken_over ──用户点「交还 Agent」───▶ agent
任意态 ──检测命中（且非 taken_over）─▶ needs_human
needs_human ──用户点「我来接管」─────▶ taken_over
任意态 ──检测未命中（原 needs_human）▶ idle
```

`needs_human` 与 `taken_over` 的区别：前者是"检测器建议你介入"，工具仍可读、但仍拒绝输入；后者是"用户已实际接手"。两者都存 **host 侧**（`Bridge.#states`），跨工具调用/跨轮次保持；`since` 也在 host 侧，所以面板重挂载后计时器接着走。`agent` 有 45s 空闲衰减，徽章不会永远停在"Agent 正在操作"。

## 验收（全部实测）

- [x] 面板徽章四态可见且文案/配色区分 —— 日志逐态采样：`badge {"phase":"agent","label":"Agent 正在操作（00:37）"}`、`{"phase":"taken_over","label":"你已接管（00:00）"}`、`{"phase":"needs_human","label":"等待你处理（人机验证）"}`、`{"phase":"idle","label":"空闲"}`（另有 `booting` → `启动中`）。配色：agent 蓝、taken_over **白底**（`#ffffff` + `#98a2b3` 边）、needs_human 琥珀、idle 绿。文案用 `mm:ss` 而非 `0:37`。
- [x] 计时器在接管态与操作态都走字，切会话后不重置 —— 1s tick（`visibilityState === 'hidden'` 时跳过），起点取 host 的 `since`；`keepMounted` 下重挂载后实测继续走（`Agent 正在操作（00:37）`）。
- [x] 点「我来接管」→ 徽章变白底，随后五个输入类工具全部返回 `taken_over` —— 用户亲手点击后实测 `browser_click` / `browser_type` 均报 `Error: taken_over: 用户已接管，请等待交还。The user is driving the panel right now; wait until they hand it back, then continue. Reads (browser_snapshot) still work.`；`browser_press` / `browser_eval` / `browser_open` 走同一个 `#assert`，同一路径。被拒命令**不入队**。
- [x] 接管期间 `browser_snapshot` / 截图仍可用 —— 分类放行（`INPUT_TYPES` 之外一律放行）。这里修过一个真 bug：第一版对 `taken_over` 一律拒绝，连 snapshot 都拒，与错误文案自相矛盾。
- [x] 点「交还 Agent」→ 立即自动跑一次 `browser_snapshot` —— 面板侧 `handBack()` 先取 `GET /source?name=snapshot` 拿到遍历源码，跑一次 `maxChars: 1200` 的无图快照，压成一行摘要随 `POST /phase` 送到 host，下一次工具调用尾部出现 `While you were away: Just a moment... · http://127.0.0.1:8795/challenge · 1 refs · - page "Just a moment..." url=…`（读后即清，只出现一次）。
- [x] 接管期间**不**自动重试、**不**自动刷新、**不**周期性快照 —— 接管只改相位，不碰页面；检测只在 `open` 之后与 `snapshot` 之后各跑一次，没有定时器。`/health` 的 `enqueued` 在被拒期间不增长（拒绝发生在入队之前）。
- [x] 检测器命中验证页 → 徽章自动转「等待你处理」，`open` 之后的第一次 `snapshot` 返回 `needs_human: true` + hint —— 夹具 `/challenge`（`<title>Just a moment...</title>` + `#challenge-stage` + `.cf-turnstile` + `Verify you are human…`）上实测：`browser_open` 结果尾部即带 `needs_human: a human verification step is on screen…`；`browser_snapshot` 尾部 `needs_human: true — the page is showing a human verification step. … reads keep working, input tools are refused until it is gone.`
- [x] 普通页面零误报 —— `https://example.com/`（多语言正文、plugin 安装页）、`https://nowsecure.nl/` 均无 `needs_human`；夹具 `/`、`/form`、`/long`、`/frames`、`/canvas` 同样干净。
- [x] 检测到验证时面板出现红框标注、不遮挡操作 —— **用户目视确认通过**。框画在页面里（`#dsh-challenge-outline`，`position: fixed` + `pointer-events: none`），因为面板层的兄弟节点会被 `<webview>` 盖住（`elementFromPoint` 量到 `WEBVIEW`）；顺带修掉一个更根本的 bug：`<webview>` 一直是 Electron 默认 300×150，页面被挤在顶端一条里、框被裁掉，改成 `position:absolute; inset:0` 后视口从 `575×150` 变成 `575×863`。框现在也会出现在 Agent 收到的截图里。
- [x] 接管 → 手动过验证 → 交还 → Agent 继续，全链路走通 —— 用户在真实面板上点过两轮（`phase local {"phase":"taken_over","reason":"user took over"}` → `phase {"from":"taken_over","to":"agent"}`），交还后摘要如期送达，Agent 随后继续导航与快照。

## 实际实现（与原计划的差异）

- 状态机放在 **`plugin/bridge.js`** 的 `#states`（不是 `src/session.ts`）：`stateOf` / `setPhase` / `#assert` / `takeDigest` / `#flushSession`。`#health` 暴露 `states`，`/pending` 每轮回灌 `states`，新增 `GET /state?session=` 与 `POST /phase`。
- 面板 ↔ host 的相位同步走 **loopback HTTP**（与命令通道同一套），不是 typert 广播——`docs/cases/003-channel-and-mount.md` §1 已证明第三方拿不到 host→client 推送。
- 检测器是 `plugin/inject/detect.js`（纯字符串注入，host 每次调用读盘），返回 `{ hit, categories, signals[], rect, title, url }`。
- `needs_human` 的判定是 **`命中类别数 ≥ 2` 且 `(dom || location)`**，比原计划"命中任一即判定"更严——这是零误报的来源。
- 红框**画在页面里**（`#dsh-challenge-outline`），因此也会出现在 Agent 收到的截图里；最初画在面板层，被 `<webview>` 完全遮住（见「实测发现」7、8）。

## 实测偏差

1. **"真实 CF 站点"没能复现**：`https://nowsecure.nl/` 本次直接打开成功，没有出现 5 秒盾（页面是 NOWSECURE 落地页 + 一个 `about:blank` iframe），所以验收用夹具 `/challenge` 覆盖三类信号。真实 CF 挑战的 DOM 形态未在本轮得到验证。
2. **徽章文案是 `mm:ss`**（`00:37`），不是计划里的 `0:37`；接入 `since` 后统一两位更稳。
3. **`browser_screenshot` 这个工具不存在**：截图一直是 `browser_snapshot` 的附带产物（决策 D08），所以"接管期间截图仍可用"= 快照仍可用。
4. **`needs_human` 放行 `browser_open`**（计划里没写）：实测发现面板卡在挑战页时，若连导航都拒绝，Agent 没有任何出口。改为仅拦 `click/type/press/eval`，错误串里也说明"你可以用 browser_open 离开这一页"。`taken_over` 仍然连 `open` 一起拒。
5. **检测时机**：计划写"导航完成后 3 秒内 + 每次快照"，实现是"每次 `open` 之后 + 每次 `snapshot` 之后"，没有延时器——判定基于当时页面状态，比定时器更准且更省。

## 实测发现

1. **相位必须存 host**：面板随时可能被卸载（切会话、收侧栏、重载插件），相位若只活在前端，一次重挂载就会把 Agent 放回驾驶位，而用户正握着鼠标。
2. **轮询泵不自我重排 → 相位延迟 4.5s**：`startPolling` 的 `pump()` 只调一次、重排全靠 500ms 看门狗（门槛 4s），实测相位到面板要 4044–4662ms。修成 `finally { running = false; if (!stopped) next = setTimeout(() => void pump(), 0) }` 后同路径 **4–28ms**。
3. **轮询回来的旧相位会盖掉刚设的新相位**：检测刚设 `needs_human`，在途响应带着几毫秒前的 `agent` 回来，徽章闪一下。修法按 `since` 比较，旧的让位。
4. **面板自己发起快照需要源码**：`Guest.snapshot()` 要求 `params.source`，而源码原本只随命令下发。新增 `GET /source?name=snapshot`（`Bridge` 收 `sources: { snapshot: snapshotSource }`）——不把脚本复制进 client 包，避免两份漂移。
5. **`package.json` 带 BOM 会被 DSH 拒装**：`SyntaxError: Unexpected token '﻿'`，且会回滚 `package.json`/`pnpm-lock`/`node_modules`。用 PowerShell `Set-Content -Encoding utf8` 改文件就会中招。
6. **重装后 client 半可能不重载**：`client.js` 内容没变（只改 host）时 rev 不变，client 半不重新执行，命令排队到 45s 超时。改 client 必须 bump `CLIENT_REV`，且重装后等 `parked: 1` / `panel ready` 再发命令。
7. **`<webview>` 默认 300×150，`height:100%` 在 flex 项里救不了它**：页面会渲染在一个 150px 高的视口里——快照、点击坐标、红框全都"看起来正常但对不上"。必须 `position:absolute; inset:0` 对着定位父盒铺满。这条是"红框看不见"的真正原因。
8. **面板层画不出能盖住 guest 的东西**：`<webview>` 是独立合成层，兄弟节点无论 `z-index` 多高都在它下面（`elementFromPoint` 返回 `WEBVIEW`）。要显示在页面上就必须画进页面。
9. **`capturePage()` 在 guest 不重绘时会一直挂着**（窗口在后台、面板被遮挡）：快照降级成纯文本并说明缘由，不要把它当成通道故障。

## 风险（更新）

| 风险 | 处置 |
|---|---|
| 检测器误报把正常站点判成验证 | 双类别门槛 + `(dom \|\| location)` 硬要求；实测三个真站点零误报 |
| 红框标注挡住用户点挑战框 | `pointer-events: none` 描边层，已实现 |
| 用户忘了交还，Agent 一直卡住 | 徽章持续显示"你已接管"并走计时器；Agent 侧错误串明确写"等用户交还"；`agent` 有 45s 空闲衰减（不适用于 `taken_over`） |
| 计时器跨轮次丢失 | `since` 存 host 侧，client 只显示 |
| 检测器漏报（站点改版） | 宁可漏报不误报：漏报时 Agent 仍能读页面、只是没被告知"要停下"，用户看徽章与画面也能发现 |

## 参考

- 实施记录与全部证据：`docs/cases/006-takeover.md`
- 四态徽章形态：`docs/spec/001-agent-browser-plugin-spec.md` §2（状态表）+ §4.2（body 分区）
- 用户全局规则第 9 行（人机验证必须停下交给用户）
