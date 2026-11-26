# 首次写动作确认夹具集（F1–F12）· SPEC-003 的可复跑验收

> 目的：SPEC-003 把「站点级首次写动作确认」拆成 C1–C12 十二条契约，但契约本身跑不起来。本集给它 12 条**可复跑**的夹具：每条都在本地 demo 页上操作（`demo/` 下的静态页，经 `browser_open({path})` 打开），不依赖外网；只有 F11 需要一次真实验证墙，且标注为「需装机 + 外网」。
>
> 状态：**夹具已定义，待装机执行**（2026-11-24，插件 1.5.1 / 宿主 0.2.2-rc.5）。单测侧：`plugin/test/approvals.test.mjs` 18 例（判定矩阵）、`plugin/test/bridge.test.mjs` 14 例（审批传输流）、`plugin/test/policy.test.mjs` 3 例（门不带审批时的旧行为）。
> 与既有案例集关系：`010`(V) 考原语、`013`(H) 考边界、`014`(S) 考真实活，本集考**信任闸门本身**——问不问、问谁、答了以后恰好发生一次。

---

## 0. 夹具页与环境

| 项 | 值 |
|---|---|
| 打开方式 | `browser_open({ path: 'demo/approval-form.html' })`（本地只读服务，`http://127.0.0.1:<port>`） |
| 页面内容 | 一个 `form`（文本框 + `<button type=submit>提交</button>`）、一个普通 `<a href>`、一个 `<button type=button>`、一个 `<input type=password>`、一个可下载链接 |
| 配置 | 默认（`approvals.mode='first-touch'`、`timeoutMs=30000`、`sensitiveSites=[]`），除 F7/F8 单独改 |
| 记录 | 每条记 ① 确认条是否出现 ② 出现后第几秒 ③ 点击后工具回执 ④ 页面上动作是否恰好发生一次 ⑤ 下次同站是否再问 |

判级沿用 `014`：L2 = 行为对上；L3 = 行为对上且有回执/页面两侧证据；L4 = 换站点/换会话仍成立。

---

## 1. 覆盖矩阵

| 编号 | 验证 | 契约 | 前一步 | 预期 |
|---|---|---|---|---|
| F1 | 读动作零打扰 | C1 | — | `open`/`snapshot`/`scroll`/`hover`/`screenshot` 全程无确认条，耗时无可感知增加 |
| F2 | 首次写动作确认 | C2/C4 | F1 | `type` 首次弹出确认条；「允许一次」后文字进入输入框；第二次同站 `type` 不再问 |
| F3 | 拒绝即不执行 | C5 | F2 | 点「拒绝」→ 工具回 `approval_denied`，页面文字未变，令牌用尽 |
| F4 | 超时 fail-closed | C5 | F2 | 弹出后不操作 30s → `approval_timeout`，页面未变 |
| F5 | 面板不可见快速失败 | C5/C7 | F2 | 确认条出现前把 DSH 窗口切后台 → <1s 回 `approval_required`，不占 30s |
| F6 | 本会话允许本站 | C3 | F2 | 选「本会话允许本站」后，同 origin 的 `type`/`submit` 都不再问；换 origin 再问 |
| F7 | 敏感站每次必问 | C3 | F6 | `sensitiveSites=['127.0.0.1']` 时，即使已 site 授权，下一次写动作仍问 |
| F8 | mode off 逐字回退 | C12 | — | `approvals.mode='off'` 下所有工具调用与 1.4.24 逐字一致（回执、错误码、无确认条） |
| F9 | 提交类点击/Enter 分类 | C2 | F2 | 点 `button[type=submit]` 要问；点普通链接近似读；表单内 Enter 要问，表单外 Enter 不问 |
| F10 | 下载与 eval 确认 | C2 | — | `download` 与 `eval` 各问一次；密码框键入**不问**，直接硬拒（既有行为） |
| F11 | needs_human 优先 | C8 | — | 真实验证墙页面：先 `needs_human`，不弹审批（需装机 + 外网） |
| F12 | 接管即作废 | C7 | F2 | 确认条出现时点「我来接管」→ pending 自动 `approval_denied`；交还后回到 `agent`，再写会重新问 |

---

## 2. 逐条步骤与证据

### F1 读动作零打扰

1. `browser_open({ path: 'demo/approval-form.html' })`。
2. 依次 `browser_snapshot`、`browser_scroll`、`browser_hover`、`browser_zoom`、`browser_screenshot`。
3. 断言：全程 `state.approval` 恒为 null（面板无确认条）；无 `/decision` 请求。

证据：面板截图 1 张（无确认条）+ 桥日志无 `approval` 行。

### F2 首次写动作确认（站点 × 会话一次）

1. `browser_type({ ref: 'e3', text: 'hello' })`。
2. 断言：确认条出现，文案含「输入文字」与站点 host；页面文字仍为空。
3. 点「允许一次」。
4. 断言：文字进入输入框；工具回执 `ok: true`；`/decision` 收到 `decision:'once'`。
5. 再次 `browser_type({ text: ' again' })`。
6. 断言：**不再**出现确认条（同 origin 已授权）。

证据：两次调用截图 + 桥日志（`approval` 一条、`POST /decision` 一条）。

### F3 拒绝即不执行

1. 新会话打开同一页，`browser_type`。
2. 点「拒绝」。
3. 断言：工具错误 `approval_denied`（`retryable: false`，hint 提示问用户想怎么做）；输入框仍为空；无第二次 `type` 命令到达页面。

证据：工具回执 + snapshot 前后对照。

### F4 超时 fail-closed

1. `approvals.timeoutMs=2000`（配置页改，即时生效）。
2. `browser_type`，等待 2s 不操作。
3. 断言：`approval_timeout`（`retryable: true`，hint 提示面板没在时限内回答）；页面未变；确认条自动消失。

### F5 面板不可见快速失败

1. 把 DSH 窗口切到后台（不最小化，切走即可）。
2. `browser_type`。
3. 断言：<1s 回 `approval_required`（不是 `approval_timeout`）；回到前台后确认条不残留。
4. 说明：宿主在窗口后台时不绘制 guest（PROGRESS §10），所以「不可见」必须快速失败，不能把 30s 预算烧掉。

### F6 站点级授权范围

1. `browser_type` → 选「本会话允许本站」。
2. 同页再 `type`、再点提交按钮。
3. 断言：都不再问。
4. 导航到另一 origin（如 `https://example.com`，或本地第二个端口）再 `type`。
5. 断言：重新问。

### F7 敏感站不享受豁免

1. `approvals.sensitiveSites=['127.0.0.1']`（改配置后重载）。
2. 先按 F6 授予本站，再 `type`。
3. 断言：仍问（每次写动作都问）。

### F8 mode off 逐字回退

1. `approvals.mode='off'`（改配置）。
2. 跑 F2 步骤。
3. 断言：无确认条、无 `/decision`；回执与 1.4.24 相同（`browser_type` 回 `inserted/length/focused`，`browser_click` 只回 `info/[...]/navigated`）。

### F9 提交分类

1. 点普通 `<a>`：不问（按读处理）。
2. 点 `<button type=submit>`：问，文案含「提交表单」。
3. 聚焦文本框按 `Enter`：问。
4. 聚焦普通按钮按 `Enter`：不问。

### F10 下载、eval、密码框

1. 点页面上的 `approval.txt` 链接触发 `browser_download({ url: <该文件的 http(s) 地址>, filename: 'approval.txt' })`：问，文案含「下载文件」；允许后文件落盘且 sha256 与回执一致。
2. `browser_eval({ expression: 'document.title' })`：问，文案含「执行页面脚本」。
3. `browser_type` 到密码框：**不弹确认**，直接回既有硬拒错误（密码绝不进入确认文案与日志）。

### F11 needs_human 优先（需装机 + 外网）

1. 打开 `https://nopecha.com/demo/cloudflare`（TICKET-033 的夹具页）。
2. `browser_open` 返回 `needs_human: true`，`eval` 被拒；不出现审批条。
3. 人完成挑战后 `snapshot` 恢复，再写动作才进入审批流程。

### F12 接管即作废

1. `browser_type` 触发确认条。
2. 点「我来接管」。
3. 断言：pending 立即 `approval_denied`（不是 timeout）；确认条消失；相位 `taken_over`。
4. 点「交还 Agent」，再 `browser_type`：重新问（pending 未跨相位保留）。

---

## 3. 发版门槛

| 门槛 | 证据 |
|---|---|
| 「提交恰好 1 次」 | F2 页面上表单提交计数为 1（demo 页把 `submit` 次数写进 `#count`） |
| 「窗口隐藏 <1s」 | F5 的时间戳（桥日志 `issuedAt` → 错误返回） |
| 「off 与 1.4.x 逐字一致」 | F8 的两次回执逐字 diff |
| 单测侧 | `node --test plugin/test/*.test.mjs` 245 例全绿；`node tools/check-docs.mjs` 全绿 |

未验证项（与 SPEC-003 §11 对应）：U1 窗口隐藏的 `visibilityState` 在侧栏里的真实取值；U2 提交判定对 `form.submit()`/`requestSubmit()`/`fetch` 的覆盖；U3 指纹是否需要包含输入值（当前不含）；U4 30s 默认是否合适；U5 `needs_human` 与审批同时命中时的优先级。

## 4. 装机验收记录（2026-11-25，1.5.1 → 1.5.2 / 宿主 0.2.2-rc.5）

真机 + `demo/approval-form.html`（插件静态服务与自建夹具服务器两种 origin），agent 侧调用、面板在右侧栏：

| 项 | 结果 | 证据 |
|---|---|---|
| F1 读动作零打扰 | ✅ | `browser_open` / `browser_snapshot` 直接返回，无确认条（快照 7 refs，1ms） |
| F2 允许一次 | ✅ | 用户点「允许一次」→ `Typed 6 characters`，快照 value 更新；同 origin 下一次写动作重新弹条 |
| F3 拒绝 | ✅ | `Error: approval_denied: 用户拒绝了在 127.0.0.1 的输入框里输入文字…nothing was sent to the page`，页面 value 未变 |
| F4 超时 | ✅ | 30s 无回答 → `approval_timeout`，文案「nothing was sent to the page」，页面未变 |
| F5 面板不可见 | ✅ | 窗口最小化 / 面板未渲染时 `browser_type`、`browser_eval` **立即**返回 `approval_required`（<1s，没烧 30s） |
| F6 站点级授权 | ✅ | 用户点「本会话允许本站」后，同 origin 再写直接执行、不再弹条（换端口 = 换 origin 会重新问） |
| F9 提交分类 | ✅ | 提交按钮点击前弹条（`actionClass=submit`），用户点「允许一次」后页面 `#count` 为 **1**，3 秒后仍为 1（夹具页 `preventDefault` 后自增，可观察「恰好一次」） |
| F10 密码框 | ✅ | 打密码框不弹条，页面侧当场硬拒（1.5.1 顺序修复） |
| F10 下载 | ✅ | `browser_download https://example.com/` 弹条（文案「从 example.com 下载文件」），点「拒绝」→ `approval_denied`，未发起任何网络请求 |
| F10 eval | ✅ | 面板可见时 `browser_eval` 弹条并等 30s；点「拒绝」→ `approval_denied`。1.5.2 修复后提示文案写「在 127.0.0.1 执行页面脚本」而不是「当前页面」（origin 改由页面侧 `inspect` 提供，不再依赖面板 `/page` 遥测） |
| F11 验证墙优先 | ✅ | `browser_open https://nopecha.com/demo/cloudflare` → `needs_human`；该页 `browser_eval` → `needs_human` 被拒（1.5.2 修复：审批提示不再盖过 `needs_human`）；用户在面板过 Turnstile 后跳到 `nopecha.com/demo`，`browser_snapshot` 立即可读、不再带 `needs_human` |
| F12 接管作废 | ✅ | pending 期间点「我来接管」→ 写动作立刻 `approval_denied`，页面为空、动手未发生 |
| F7 敏感站 / F8 mode off | ✅ 2026-11-26 真机（1.5.4，见 §5） | F7：同 origin 第一次「允许一次」成功、第二次仍弹条，拒绝后未写入；F8：`mode:'off'` 下 type/eval/提交点击全部直接执行、无确认条、无 `approval_*` 错误码 |

验收期发现并修掉的三个真问题（都只有在真面板上才看得见）：
1. **1.5.0 写动作完全不弹条**：`plugin/apply.js` 的薄门没有向 `createGate` 转发 `approve`/`hasClient`/`pageOf`，`canAsk()` 恒 false；单测假桥本来就没有这三个方法，231 例全绿也没照出。1.5.1 修复，`gate.test.mjs` 锁住。
2. **密码框先弹条再被页面硬拒**：审批在宿主侧先跑、硬拒在页面侧后跑。1.5.1 改成 `browser_type` 先 `inspect`，`role=password` 直接不进确认。
3. **`needs_human` 被审批与读命令盖过**：`bridge.request()` 对除 `snapshot` 外的一切命令都把 phase 置回 `agent`，审批前的 `inspect` 因此会清掉 `needs_human`/`taken_over`；`bridge.approve()` 也没有先看人工相位。1.5.2 修复：新增 `READ_TYPES={snapshot,inspect}` 不抢相位，`approve()` 先 `#assert`（人工相位优先，SPEC-003 C8）；`bridge.test.mjs` 增加 3 例锁住。同批还修了 eval 提示的 origin（改由页面侧 `inspect` 提供，面板 `/page` 上报在本机宿主未落地，仅作遥测保留）。

装机结论：**F1–F6、F9–F12 于 1.5.2 真机通过**；F7/F8 于 2026-11-26 在 1.5.4 上补做真机验收（见 §5）——至此 **F1–F12 全部真机通过**。单测当时 245 例（1.5.2）→ 现 259 例（1.5.4），`node tools/check-docs.mjs` 六项一致。

## 5. F7/F8 真机验收（2026-11-26，1.5.4 / 宿主 0.2.2-rc.5）

按 TICKET-043 的安全路径：改配置 → 用户**完全重启 DSH** → 一次性验完；不用热重载、不用 bundle 启停，全程未白屏。

### F7 敏感站每次必问

- 备份 patch 为 `.bak-f7`，注入 `approvals: {mode: first-touch, timeoutMs: 30000, sensitiveSites: [127.0.0.1]}`（`tmp/add-approvals-f7.mjs on`，UTF-8 无 BOM）；用户重启 DSH。
- `browser_open {path:'demo/approval-form.html'}` → 新 origin `http://127.0.0.1:5359/t/demo/approval-form.html`（无任何授权），snapshot 7 refs。
- `browser_type e2 'F7 sensitive first'` → 弹条，用户点「允许一次」→ `Typed 18 characters`。
- **同一 origin 第二次** `browser_type e2 'F7 sensitive second should be denied'` → **再次弹条**（`sensitiveSites` 覆盖站点豁免），用户点「拒绝」→ `approval_denied`；snapshot 值仍是 `F7 sensitive first`，第二次未写入 → ✅。

### F8 mode off 完全不问

- 配置改 `approvals: {mode: "off"}`（`tmp/add-approvals-f7.mjs off`），用户重启。
- `browser_open` 夹具 → `http://127.0.0.1:1304/t/demo/approval-form.html`；`browser_type e2 'F8 mode off no prompt'` 直接成功；`browser_eval {script:'document.title'}` 直接返回 `"写动作确认夹具"`；`browser_click e4`（提交）直接点击、`#count` 变 1；无确认条、无 `approval_*` 错误码 → ✅（与 1.4.x 无审批行为一致）。

### 恢复

- `tmp/add-approvals-f7.mjs strip` 删除 approvals 块；`Compare-Object` 与 `.bak-f7` 逐行一致（7200 B、UTF-8 无 BOM）。
- 用户第三次重启后 `browser_type` 再次弹条，用户点「拒绝」→ `approval_denied`、未写入 → 默认 `first-touch` 已恢复 ✅。
- 三次配置生效都依赖「用户完全重启 DSH」，与 TICKET-040 的规避流程一致。
