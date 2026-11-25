# SPEC-003：站点级首次写动作确认（first-touch approval）

- 状态：已实现（1.5.2，2026-11-25 真机验收通过；实现拆分见 §14，验收记录见 `docs/cases/015-first-touch-cases.md` §4）
- 版本：v1（2026-11-24）
- 前置规格：`docs/spec/001-agent-browser-plugin-spec.md`（产品范围与 A1–A19 不动）、`docs/spec/002-official-alignment-spec.md`（工程约束 B1–B11 不动）
- 关联决策：`docs/decisions/010-first-touch-approval.md`（本规格是它的可验收形式）
- 关联调研：`docs/research/2026-11-24-browser-automation-competitive-report.md` §5–§6（「敢用」是护城河；竞品的人机接力只到 `request_help`/`ask-human`/`wait_for_human`，没有站点级信任闸门）
- 关联 ticket：`docs/tickets/033-challenge-detection-gap.md`（同属 1.5「信任地基」）、`docs/tickets/037`–`039`（本规格的实现拆分）
- 目标运行环境：DSH 桌面端 `0.2.2-rc.x`（Windows / macOS），发布形态为单包 bundle
- 改动面：`plugin/tools.js`、新增 `plugin/approvals.js`、`plugin/bridge.js`、`plugin/errors.js`、`plugin/config.js`、`plugin/index.js`、`plugin/client.js`、`plugin/inject/guards.js`

---

## 1. 目的

产品定位是「用户和 agent 共用一块真浏览器」（SPEC-001 §2）：浏览器是 DSH 侧栏里那个 webview，登录态天然是用户的，agent 用 11 个工具操作，用户随时能接管。

这个定位的护城河是**可见、可接管、登录态零搬运**。但它有一个尚未补齐的口子：**agent 一旦拿到会话，对任何站点的写动作（键入、提交、下载、eval）都没有确认**——用户只能事后从回执和面板里看见。密码框硬拒与下载扩展名/大小策略只覆盖了很窄的一类风险。

本规格要冻结一条规则，把它变成可验收的产品承诺：

> **凡是写动作，站点首次就确认；批准即执行且只执行一次；拒绝、超时、面板不可见一律不发出。**

三条贯穿全篇的判断：

1. **默认值 = 不打扰读**。日常查资料零确认；一个任务里最多打断两次（填写一次、提交一次）。
2. **fail-closed**。宁可不动，也不做未经确认的副作用；失败一律可重试、绝不重放（与 TICKET-034 之后的方向一致）。
3. **可观测的量替代不可观测的量**。「是否已登录」不可观测（webview 里读不到 HttpOnly Cookie，宿主 `app.asar` 的 `lib/main.js:18233-18244` 只给了权限/下载策略，没有 cookie 接缝）；「是否首次写动作」可观测。所以规则按后者写。

## 2. 非目标

| 不做 | 原因 |
|---|---|
| 检测「登录后页面」 | 没有可靠信号（见 §1 第 3 条）；按站点首次写动作取代 |
| 每个动作都确认（作为默认） | 打断成本过高，会把 agent 变成手动工具；只保留 `every-action` 可选档 |
| 把确认并入 `ctx.tools.guard` | 守卫是同步策略否决，确认需要等待；两套机制混在一起会让策略面失控（SPEC-002 B9 的边界不动） |
| 与宿主 approval 策略合并 | 宿主审批可能被用户设成 `never`；不能拿它承担「敢让它碰登录态」的产品承诺（决策 010 §10） |
| 改相位机语义 | `idle`/`agent`/`taken_over`/`needs_human` 四态不变（SPEC-001 §8.1）；等待确认时仍是 `agent`（动作还没发出） |
| 新增 headless / 远程 / CDP 第二后端 | 产品路线不在本规格（调研报告 §5 已判定不做） |
| 覆盖 upload | 当前没有 upload 工具；出现后复用同一 `actionClass` 机制 |
| 面板点选指路（十字准星） | 属 v2.0 协作台，单独开票 |

## 3. 术语

| 词 | 含义 |
|---|---|
| 读动作 | 不改变站点状态、不提交数据的工具调用：`open`/`snapshot`/`scroll`/`hover`/`zoom`/`screenshot`，普通链接点击，非提交类按键 |
| 写动作 | 可能改变站点或带出数据的调用：`type`（非密码）、提交类点击、表单内 Enter、`download`、`eval` |
| `actionClass` | 写动作的四类之一：`type` / `submit` / `download` / `eval`（后续可加 `upload`） |
| `origin` | `scheme://host:port`；grant 的粒度单位 |
| grant | host 进程内存里的一次性授权记录 `{ id, fingerprint, origin, actionClass, scope: 'once' \| 'site', expiresAt }` |
| 指纹 | `origin + actionClass + target（ref/selector 解析结果）`；**不含**输入值（隐私），也不含时间 |
| first-touch | 每个 `(sessionId, origin)` 的第一次写动作必确认 |
| pending 确认 | 已下发到面板、尚未回 decision 的确认条 |
| 面板不可见 | 桥没有活跃轮询者，或 client 报 `document.visibilityState !== 'visible'` |

## 4. 要求

### C1 默认档与读动作零打扰（P0）

默认 `approvals.mode = 'first-touch'`。读动作（§3 定义）不产生任何确认，也不增加可见打断。

验收：新会话打开任意页面、做 snapshot/scroll/hover/zoom/screenshot，确认条出现次数为 0；面板日志无 approval 事件。

### C2 写动作分类表（P0）

| 工具 / 情形 | 分类 | 说明 |
|---|---|---|
| `browser_type`（密码框） | 拒绝 | 维持现状硬拒（`plugin/inject/actions.js:659-660`），不进入确认流程 |
| `browser_type`（其余可编辑元素） | `type` | 页面侧不判定字段语义，只区分密码 |
| `browser_click`（提交类元素） | `submit` | `button[type=submit]`、`input[type=submit]`、`input[type=image]`、位于 `form` 内的 `button`（无显式 type 时按 submit 处理） |
| `browser_click`（普通 `a[href]`、非表单按钮） | 读 | 副作用点击（JS handler 发请求）按读处理，见 §8 已知限制；`sensitiveSites` 可升级为写 |
| `browser_press`（`Enter`，焦点在 `input`/`textarea`/`contenteditable` 且属于某 `form`） | `submit` | 与 submit 按钮同类 |
| `browser_press`（其余按键） | 读 | 见 §8 已知限制 |
| `browser_download` | `download` | 确认发生在宿主 fetch 之前 |
| `browser_eval` | `eval` | `evalEnabled: false` 时仍是 `eval_disabled`（优先于确认） |
| `browser_open` / `snapshot` / `scroll` / `hover` / `zoom` / `screenshot` | 读 | — |

页面侧只负责**标记**（提交目标、表单归属），是否确认由 host 判定（§5）。页面标记不可信，只作为补充信号（§8）。

### C3 站点级豁免与生命周期（P0）

- 每个 `(sessionId, origin)` 的第一次写动作必确认一次。
- 用户在确认条上可以选：`允许一次`（只放行这一次）/ `本会话允许本站`（本 session 该 origin 后续写动作不再确认）/ `拒绝`。
- 粒度是 origin：`https://a.example.com` 与 `https://b.example.com` 各自第一次都要确认；换 origin 重新确认。
- 生命周期：grant 存在于 host 进程内存，session 结束（面板关闭/插件卸载/`CLIENT_REV` 重挂不算）即作废；不落盘。
- `sensitiveSites` 命中的 origin：即使已选过「本站允许」，每次写动作仍确认（该站点忽略 site 级 grant）。

### C4 单次执行与指纹（P0）

- 批准与执行是**同一个工具调用**：工具体拿到 grant 后执行一次，随即作废；不存在「批准了再重发一次」的窗口。
- grant 只对指纹匹配的动作有效：origin + actionClass + target 解析结果（ref 或 selector 归一化后的字符串）必须逐项相等，否则回 `approval_denied`（hint：重新发起工具调用）。
- 动作要么执行 0 次（拒绝/超时/指纹不符），要么执行 1 次；**不存在 2 次**。
- 迟到的 decision（面板在超时后才回）被忽略，不得让已超时的调用起死回生。

### C5 fail-closed 与三错误码（P0）

| 错误码 | retryable | 触发 | hint |
|---|---|---|---|
| `approval_required` | true | 桥无活跃轮询者，或 client 报不可见；**不等待**，立即返回（目标 < 1s） | 让用户把面板带回前台后重试 |
| `approval_timeout` | true | `approvals.timeoutMs`（默认 30 000）内未回 decision | 用户可能不在，重试前先确认 |
| `approval_denied` | false | 用户点拒绝、用户在等待中点接管、指纹不符 | 先问用户想怎么做，不要自动重试 |

三码必须与既有 13 码一样走 `<code>: <text>` 的 message 格式，并带 `retryable`/`hint`/`details`（SPEC-002 B5）。`needs_human` 优先于确认：验证墙命中时进 `needs_human`，不再叠一条确认（§8）。

### C6 强制执行点不可绕过（P0）

- 判定与等待在**工具体内**：拿不到 grant，动作代码根本不进入（不存在「先做了再补确认」）。
- 面板只是呈现与回传 decision 的入口；绕过面板拿不到 grant。
- `ctx.tools.guard` 继续只做同步策略否决（`sessions.allowlist`、`evalEnabled`、下载扩展名/大小），不与确认合并。
- 宿主没有可用的 approval 频道，确认条由插件自己负责；因此用户把宿主审批设为 `never` 时本规则依然生效。

### C7 面板确认条（P0）

- 位置：面板顶部一条 28–32px 高的横条，不覆盖页面内容；窄面板（< 420px）允许折成两行。
- 文案只给「谁 + 要做什么」，**不回显输入值**：`example.com 想让 agent 填写表单并提交`；密码永不显示；`details` 里只放 actionClass 与目标的可读描述（如 `提交表单`、`下载 report.pdf`）。
- 三个按钮：`允许一次` / `本会话允许本站` / `拒绝`；30 秒倒计时进度条。
- 倒计时结束 = 超时（`approval_timeout`），不等于拒绝。
- 与相位的关系：pending 期间 phase 仍为 `agent`；四态徽章不新增状态，可在徽章旁加一个「待确认」小圆点（不得改变四态语义）。
- 用户在 pending 期间点「接管」→ pending 自动变拒绝，agent 收到 `approval_denied`（hint 说明用户已接管）。

### C8 与验证墙检测的优先级（P1）

`needs_human` 优先：验证墙命中时 snapshot/工具已经进只读态，此时不应再弹确认条。
实现取舍：确认流程只在**写动作发起时**触发；`detectChallenge` 的检测结果（`plugin/client.js:467-503`）先于确认判断，命中即回 `needs_human`，不再进入审批。

### C9 配置契约（P0）

新增 `approvals` 分组（字段名固定，默认值固定）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `approvals.mode` | `'first-touch' \| 'every-action' \| 'off'` | `'first-touch'` | `off` 时行为与 1.4.x 逐字一致 |
| `approvals.timeoutMs` | number | `30000` | 确认等待上限；范围 1 000–300 000，超界按 clamp 并警告 |
| `approvals.sensitiveSites` | string[] | `[]` | origin 列表；命中站点每次写动作都确认 |

实现时必须同步三处（`node tools/check-docs.mjs` 会校验）：`plugin/config.js` 的 `DEFAULTS`、`plugin/index.js` 的 `Config` schema、`dist/dsh-plugin-agent-browser/README.md` 的字段表与 YAML 示例。

### C10 可观测（P1）

- 每次确认记一条结构化事件（host 日志）：`{ sessionId, origin, actionClass, decision: 'once' \| 'site' \| 'deny' \| 'timeout' \| 'unavailable', latencyMs }`。
- **不记录**输入值、不记录页面内容、不记录 cookie（沿用现有的「密码永不进日志」口径）。
- 面板时间线（「agent 做了 7 件事」）属 v2.0，本规格只要求日志可查。

### C11 兼容性（P0）

| 变更 | 影响 | 处理 |
|---|---|---|
| 默认开启确认 | 1.4.x 用户升级后首次写动作会被问一次 | 用户 README 的「升级说明」写明；`approvals.mode: 'off'` 一键回到旧行为 |
| 工具名/参数/返回不变 | LLM 侧工具契约不变 | 只有错误码新增，无 schema 变更 |
| 错误码 13 → 16 | 程序侧按 `code` 判定 | 用户 README 错误码表、`docs/cases` 同步 |
| 新增配置字段 | 现有配置行不受影响（缺省取默认） | 默认值 = 新行为；不写 `approvals` 也生效 |
| `CLIENT_REV` bump | 面板需重载一次 | 发布说明里写明「首次安装后重开面板」 |

### C12 版本与回滚（P1）

- 与 TICKET-033 同批进 **1.5.0**（「信任地基」）。
- 回滚开关：`approvals.mode: 'off'`；回滚后行为必须与 1.4.x 逐字一致（走既有 11 工具 + 13 错误码路径）。
- 若某个子项延期（如面板确认条），可先发 host 侧但默认 `mode: 'off'`，不得发「会弹条但点不了」的半成品。

## 5. 判定与流程

```
工具 execute()
  ├─ 分类：读动作 → 直接执行（现有路径）
  ├─ 密码框 type → 立即拒绝（现有错误）
  ├─ evalEnabled=false 且是 eval → eval_disabled（现有）
  ├─ 策略守卫（ctx.tools.guard：allowlist / 下载扩展名与大小）→ 否决则返回现有错误
  └─ 写动作
       ├─ 已有 site grant（且非 sensitiveSites）→ 执行
       ├─ 桥无轮询者 / client 报不可见 → approval_required（立即）
       ├─ 下发 confirm 帧（长轮询响应携带）
       │    ├─ 面板渲染确认条 → 用户决策 → POST /decision
       │    ├─ 超时 → approval_timeout
       │    └─ 接管 → approval_denied
       ├─ decision 校验（id 单次、指纹匹配、decision ∈ {once, site, deny}）
       ├─ 批准 → 执行动作一次 → 若为 site 级则写入 host 内存 grant
       └─ 拒绝 → approval_denied
```

判定优先级（从高到低）：密码硬拒 > `eval_disabled` > 策略守卫 > `needs_human`（验证墙）> 审批 > 执行。

## 6. 桥协议

沿用现有长轮询通道（client 轮询 `/commands`，host 把待执行命令放进响应）。确认条复用同一通道，新增一帧类型，避免为 UI 另开推送：

| 方向 | 消息 | 形状 |
|---|---|---|
| host → client（轮询响应） | confirm 帧 | `{ kind: 'confirm', id, origin, actionClass, summary, timeoutMs, issuedAt }` |
| client → host | decision | `POST /decision` `{ id, decision: 'once' \| 'site' \| 'deny' \| 'unavailable', clientVisible: boolean }` |
| host 内部 | 等待 | `approve(id, timeoutMs)` 返回 Promise；超时/不可见/接管分别 resolve 成上表三码之一 |

约束：

1. confirm 帧与动作命令共用一次轮询，但**不得串行化动作**：pending 确认期间，读动作仍可执行（只读工具不经过审批）。
2. 同一 session 同一时刻最多一个 pending 确认；新的写动作在 pending 期间到达时，直接回 `approval_required`（hint：先完成当前确认），不排队。
3. confirm id 由 host 生成（单调递增 + 随机后缀），decision 只接受当前 pending 的 id。
4. 面板重挂（`keepMounted` 之外的极端情况）：host 在 300ms 内没等到轮询即判 `approval_required`，不悬挂。
5. `POST /decision` 需要与现有桥相同的令牌与 Host 校验（SPEC-002 B4 的鉴权不放松）。

## 7. 面板 UI 规格

- **结构**：`[站点 origin] · [动作描述]` + 三按钮 + 倒计时进度条；高度 28–32px；不遮页面，不改变 webview 布局。
- **文案规则**：动作描述只来自 `actionClass` 与目标的可读名（`提交表单`、`填写输入框`、`下载 report.pdf`、`执行页面脚本`）；不回显任何输入值；origin 显示 `host`（含端口），不显示完整 URL 的 query。
- **样式**：与现有四态徽章同一视觉语言；确认条出现时徽章旁显示小圆点；拒绝/超时后确认条 1s 内消失。
- **键盘**：`Enter` 默认聚焦「拒绝」（安全默认），`Alt+1/2/3` 对应三个按钮；不得让页面或 webview 抢走焦点。
- **可见性**：client 每次 decision 上报 `clientVisible`；`document.visibilityState !== 'visible'` 时不上报按钮可用，直接按不可见处理。
- **窄面板**：< 420px 时按钮折行、文案截断加省略号，但三个按钮必须同时可见（不允许出现「只看到允许」的布局）。

## 8. 安全边界与已知限制

1. **「登录后页面」不可检测**（同 §1）。规则不依赖它。
2. **页面侧标记可被页面脚本伪造**：`window.__dshSensitive` 之类标记只作补充信号；host 侧对 click/press 的分类以自己解析的 ref/selector 与元素属性为准（与 snapshot 同源）。伪造标记最坏导致**多问一次**（fail-closed 方向），不会少问。
3. **非表单按钮的副作用点击按读处理**：JS handler 发请求、SPA 按钮切换状态等无法从 DOM 可靠判定；需要严格保护的站点用 `sensitiveSites` 升级为「该站所有写类动作都确认」。
4. **宿主硬拦 webview 下载**（`app.asar` `lib/main.js:18242-18244` 的 `will-download` → `event.preventDefault()`）：`browser_download` 走宿主 fetch，确认发生在 fetch 前，但下载内容仍不带页面 Cookie（现有已知限制，不因本规格改变）。
5. **不可撤销语义**：批准后动作已投递给页面，页面内不可撤销（沿用现有 `cancelled` 文案口径：nothing already sent to the page can be undone）。「执行 0 次或 1 次」只保证不重放，不保证可撤回。
6. **`eval` 被确认后即拥有页面内任意读写**：确认条文案必须明说「执行页面脚本」，不能弱化成「读取数据」。
7. **iframe**：同源 iframe 内的提交可判定（注入层已递归同源 frame，`plugin/inject/snapshot.js:249-263`）；跨域 iframe 只能坐标点击，按 `click` 分类处理，无法读取其内部表单语义。

## 9. 兼容性

见 C11。补充两点：

- 工具面不变（11 个工具、schema 字符数不增），本规格不新增工具，因此 `docs/spec/002` B7 的工具定义锁定不受影响。
- `docs/tickets/033`（验证墙）与本规格同批：033 修好后 `needs_human` 更可靠，审批与它互不干扰（C8）。

## 10. 批次与顺序

| 批次 | 内容 | 预估 | 出口条件 |
|---|---|---|---|
| M1（TICKET-037） | 页面侧标记 + `plugin/approvals.js` + 三错误码 + bridge confirm/decision + 工具接线 + 单测 | 1–1.5 天 | `mode: 'first-touch'` 下读动作零确认、写动作能拿到 grant 并只执行一次；`mode: 'off'` 与 1.4.x 行为逐字一致；单测覆盖指纹/超时/拒绝 |
| M2（TICKET-038） | 面板确认条 + 倒计时 + takeover 竞态 + `clientVisible` + `CLIENT_REV` bump | 1 天 | 真实装机可见确认条、三按钮可用、接管时 pending 自动拒绝；窄面板不破版 |
| M3（TICKET-039） | `approvals` 配置三处同步 + 错误码文档 + `docs/cases/015` 验收夹具 + 回滚说明 | 0.5–1 天 | `check-docs` 全绿；10 条验收夹具可复跑；用户 README 升级说明写好 |

顺序理由：M1 是契约与安全边界的地基，必须先于 UI；M2 依赖 M1 的 confirm 帧与 decision 端点；M3 的配置字段会触发 `check-docs` 的三处一致性检查，放在最后一次性收口，避免 UI 与配置互相返工。

## 11. 未验证与待决策

| # | 问题 | 为什么卡住 | 结论/验收方式 |
|---|---|---|---|
| U1 | DSH 窗口在后台时，client 能否可靠拿到 `document.visibilityState === 'hidden'` 并即时回 decision | 决定「窗口隐藏快速失败」能否 < 1s；PROGRESS §10 已证窗口后台不绘制、不收合成输入 | M2 阶段做 10 分钟探针（后台窗口 → 调用写动作 → 看耗时与 decision 内容），结论回填本表 |
| U2 | 提交判定的覆盖率：`form.submit()` 直接调用、`requestSubmit()`、JS `fetch` 提交 | 决定 `submit` 分类是否可靠；`plugin/inject/guards.js:91-99` 已 patch `HTMLFormElement.prototype.submit`，可复用为标记点 | 用夹具统计：表单按钮 / 回车 / `form.submit()` / `fetch` 四类，前三类必须命中，第四类明确写入已知限制 |
| U3 | grant 指纹是否要包含输入值 | 隐私（不能回显）与重放防护之间的平衡；当前决定不含值 | 依据：grant 只在单次工具调用内有效、动作代码不重发，值不入指纹不产生重放窗口 |
| U4 | `needs_human` 与 pending 确认同时发生时的优先级 | 需要真实验证墙页面才能复现 | 规格定为 `needs_human` 优先（C8）；M3 用 TICKET-033 的夹具复验 |
| U5 | 30 秒是否合适 | 取决于用户离场习惯，无数据 | 先按 30s 发，`timeoutMs` 可配；收集一轮真实使用后再定默认 |

## 12. 验收标准

- [ ] C1 读动作零确认：新会话 open/snapshot/scroll/hover/zoom/screenshot 各一次，确认条出现次数 = 0
- [ ] C2 分类正确：type（非密码）→ `type`；提交按钮/表单内 Enter → `submit`；普通链接点击 → 读；download/eval → 各自类；密码框 → 维持硬拒
- [ ] C3 站点级豁免：允许一次后同站第二次写动作不再问；换 origin 再问；会话结束作废；`sensitiveSites` 命中站点每次问
- [ ] C4 单次执行：批准后提交恰好发生 1 次（夹具统计 submit 事件）；拒绝/超时/指纹不符时 0 次；迟到 decision 被忽略
- [ ] C5 fail-closed：面板不可见 < 1s 回 `approval_required`；30s 无响应回 `approval_timeout`；拒绝回 `approval_denied`（不可重试）
- [ ] C6 不可绕过：`mode: 'first-touch'` 下无 grant 的动作代码不执行；`ctx.tools.guard` 行为不变（allowlist / eval / 下载策略三条单测仍绿）
- [ ] C7 确认条：出现在面板顶部、不遮页面、三按钮同时可见、`Enter` 默认聚焦拒绝、倒计时结束 = 超时而非拒绝
- [ ] C8 优先级：验证墙命中时先 `needs_human`，不再叠确认（用 033 修好后的夹具）
- [ ] C9 配置：`approvals.mode/timeoutMs/sensitiveSites` 三处同步、`check-docs` 全绿、非法值在加载期被 schemastery 拒绝
- [ ] C10 可观测：确认事件含 session/origin/actionClass/decision/latency，且不含输入值与页面内容
- [ ] C11 兼容：`mode: 'off'` 与 1.4.x 逐字一致（196 例单测全绿 + 三个写动作手测）；工具 schema 字符数不增
- [ ] C12 回滚：`mode: 'off'` 立即恢复旧行为，无需重装插件（volatile 字段，SPEC-002 B1 口径）

## 13. 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 确认疲劳：用户习惯性点「允许」 | 闸门名义存在、实际失效 | 文案说明「要做什么」；默认 once-per-site 而非每次；`sensitiveSites` 给高危站点更强档 |
| R2 | 长任务被确认卡住，用户不在 | 任务失败率上升 | 30s 超时 + `approval_timeout` 可重试；hint 明说先确认用户在不在；v2.0 时间线补「离开期间发生了什么」 |
| R3 | 指纹不严，批准后动作被替换 | 安全承诺落空 | 指纹绑定 origin+class+target；decision id 单次；单测覆盖伪造指纹 |
| R4 | 页面伪造标记导致少问 | 比现状更糟 | 分类以 host 侧解析为准（C6、§8.2）；标记只用于补充「表单归属」 |
| R5 | 窗口隐藏时确认条看不见，agent 空等 | 体验回退 | C5 快速失败；U1 探针确认可见性信号 |
| R6 | 与 TICKET-033 的相位交互写错 | 双重拦截或互相覆盖 | C8 定优先级；M3 用同一夹具复验 |
| R7 | 默认开启引发存量用户不满 | 升级投诉 | 升级说明 + `mode: 'off'` 一键关闭；发布说明写清这是默认值变更 |

## 14. 关联 ticket

| 要求 | ticket | 批次 | 版本 |
|---|---|---|---|
| C1–C6、C8、C10（host 侧） | `docs/tickets/037-first-touch-approval.md` | M1 | 1.5.0 |
| C5（可见性快速失败）、C7（面板确认条） | `docs/tickets/038-approval-confirm-bar.md` | M2 | 1.5.0 |
| C9（配置三处）、C11/C12（兼容与回滚）、验收夹具 | `docs/tickets/039-approval-config-and-cases.md` | M3 | 1.5.0 |
