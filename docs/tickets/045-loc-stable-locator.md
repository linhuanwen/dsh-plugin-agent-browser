# TICKET-045 快照稳定定位符 `loc=`（阶段 B 观察增强）

- 状态：✅ 已完成（2026-11-27，1.5.6；单测通过，真机验收见 `docs/cases/019`）B2
- 发现：2026-11-27，阶段 B 第一能力（`browser_wait`）收口后规划「观察增强」时
- 关联：[SPEC-004](../spec/004-capability-admission-spec.md) §4 B1–B3、B6；[TICKET-044](044-browser-wait.md)（前一能力）
- 关联决策：[005](../decisions/005-loopback-bridge-over-cdp.md)（自建通道，不引入 CDP）

## 1. 缺口

快照里的 ref 只在**产生它的那次快照**里有效：每次 `browser_snapshot` 都从 1 开始重新编号
（`plugin/inject/snapshot.js` 的 `refCount`），旧 ref 要么被拒（`stale_ref`），要么更糟——
指向了另一个节点（页面结构变了、编号刚好撞上）。

实际使用中这逼出两种浪费：

1. 模型拿着上一次快照的 ref 去点，失败后必须**重新快照**（一张图 + 整棵树，视觉与上下文都贵）；
2. 更常见的是「先读后写」的两段式操作：`snapshot` → 思考 → 再 `snapshot` 确认 → 才敢点，
   因为中间只要页面自己动了一下，第一次的 ref 就不可信了。

竞品给出的答案是「稳定定位符」：`dsh-browser-cdp` 在快照行里打印
`[ref=N, loc=css:/role:/href:/text:]`，并在工具描述里明写 *Prefer loc= over @N across calls:
locs are stable, refs renumber each snapshot*（`src/index.ts:4497,4508`）。它的 `loc=` 还有
`role:` / `href:` / `text:` 等形态；我们只需要一种最小形态即可闭合缺口。

## 2. 准入四问（SPEC-004 B1）

| 问题 | 回答 |
| --- | --- |
| 读还是写？ | **不新增动作**：`loc` 只是 `browser_click` / `browser_hover` / `browser_type` 的另一种寻址方式，动作类别仍由工具本身决定（提交类点击 → `submit`，输入 → `type`），审批与人工相位照旧。`browser_snapshot` 多打印一个字段，属读。 |
| 可逆吗？ | 不适用：本能力不改变任何动作的语义，只把「寻址失败」从陌生位置换成可诊断的 `stale_loc`。 |
| 失败能否确定「没执行」？ | **能**。定位符解析失败发生在页面动作之前（`bad_loc` / `stale_loc`），错误带 `effect:'none'`，重试安全——与「ref 无效」同一等级。 |
| 人工相位能否绕过？ | 不能绕过任何规则：`loc` 命令仍走 `bridge.request`，`needs_human` / `taken_over` 的读/写分流、审批门的 `confirmBefore` 都不变。 |

四问全部有答案，且不新增不可逆动作，可按 SPEC-004 B2 的「读/可逆写」级别进主干。

## 3. 目标

1. 快照里每个带 `[ref=eN]` 的交互节点，**能算出一条稳定路径时**紧跟 `[loc="css:…"]`；
   算不出唯一路径就不打印（宁缺勿错）。
2. 路径要能跨快照使用：同一页面连续两次快照，第一次的 `loc` 在第二次之后仍然能定位同一个元素。
3. 定位失败要有独立错误码：`bad_loc`（格式不认识）与 `stale_loc`（页面里已找不到该路径），
   都带 `effect:'none'`。
4. 不改变现有 ref 行为、工具数量（仍 12）与配置字段（仍 21）；通道协议不变（`loc` 随命令参数下发）。

## 4. 实现

### 4.1 页面侧生成（`plugin/inject/snapshot.js`）

- 新增 `cssPathOf(el, doc)`：从元素向上找锚点，**由近及远**尝试
  `#id`（仅 `^[A-Za-z][\w.:-]*$` 的稳妥 id）→ `[data-testid="…"]` → `tag[name="…"]`
  （input/select/textarea/button/form）；锚点之下用 `tag:nth-of-type(n)` 补全；最多 12 层。
- **每条路径用 `doc.querySelector(path) === el` 自校验**：路径指向别处就丢弃——错误的定位符
  比没有定位符危险。最终整条路径也会校验一次；长度 > 120 字符不打印。
- 发射规则：ref 行追加 `[loc="css:…"]`；iframe 内的定位符带 `f1:` 前缀（与 ref 的 `f1e2` 同源）。

### 4.2 动作侧解析（`plugin/inject/actions.js`）

- 新增 `resolveLoc(loc)`：解析可选 `f\d+:` 前缀（经 `[data-dsh-frame]` 取回 frame 文档）→
  要求 `css:` scheme → `doc.querySelector(expr)`；空表达式/非法选择器 → `bad_loc`；
  找不到元素 → `stale_loc`。
- 分发优先级：`loc` > `selector` > `ref`（`loc` 是 `css:` 路径，与 selector 互斥由工具层校验）；
  `inspect` 的无地址分支条件加入 `loc`；所有拒绝的 `who()` 会带上 `loc`（或 frame 前缀）。

### 4.3 工具层（`plugin/tools.js`）

- `browser_snapshot` 的 description 说明 `[loc="css:#save"]` 的用途与 `stale_loc`。
- `browser_click` / `browser_hover` / `browser_type` 的 parameters 新增 `loc`；校验互斥：
  `loc` 与 `selector` 不能同时给；`loc`/`selector` 与 `x`/`y` 不能同时给；`type` 的
  required 从 `['ref','text']` 改为 `['text']`，由 `loc` 或 `ref` 二选一，二者都给直接报错。
- 审批门（`createGate.confirmBefore`）：click 的 inspect 地址与 type 的 inspect 地址都接受
  `loc`——提交类判断、密码框早退对 `loc` 寻址同样生效。

### 4.4 面板（`plugin/client.js`）

- `Guest.act` 的白名单参数增加 `loc`；`CLIENT_REV` 51→52。

## 5. 测试

- `plugin/test/snapshot-loc.test.mjs`（新增 3 例）：`#id` 锚点、无锚点时
  `html > body:nth-of-type(1) > button:nth-of-type(1)` 位置路径、**快照打印出的 loc 能被
  `inspect` 解析回同一个元素**（生成侧与解析侧对拍）。
- `plugin/test/actions.test.mjs`（新增 6 例）：`loc` 点击与 inspect、路径失效 → `stale_loc`
  且回显 `loc`、frame 前缀缺失 → `stale_loc` 且回显 `frame`、非 `css:` scheme → `bad_loc`、
  显式坏 ref 仍先报 `bad_ref`。
- `plugin/test/gate.test.mjs`（新增 2 例）：`loc` 点击先 inspect（用同一 locator）再 click、
  提交类 loc 点击仍进审批门；`loc` 输入先 inspect。
- 全量：**289/289**（原 277 + 12；其中 gate 多一例：无法解析的 loc 跳过确认、直接由动作报错）。

## 6. 验收

- [x] 快照给交互节点打印 `[loc="css:…"]`，同一行紧跟 `[ref=…]`
- [x] 有效 `loc` 能完成 click / hover / type，跨快照可用（真机，`docs/cases/019`）
- [x] `stale_loc` / `bad_loc` 带 `effect:'none'`，重试安全
- [x] `loc` 与 selector / x,y / ref 的互斥校验有单测
- [x] 工具数仍 12、配置字段仍 21，`node tools/check-docs.mjs` 全绿
- [x] 单测 289/289

## 7. 不做

- 不做 `role:` / `text:` / `href:` 等其他定位符形态（一种 `css:` 已足够；多形态会把「解析失败」
  变成猜谜）。
- 不做「定位符自动修复」（模糊匹配、重试别处）：错误的目标比失败更糟。
- 不把 `loc` 升级成快照的主寻址方式（ref 仍是首选；`loc` 是跨快照的稳定形式）。
- 不在 `browser_press` / `browser_scroll` 上加速度（它们不接受元素地址）。

## 8. 风险

- **R1 短路径不唯一**：`#id` 重复的页面里锚点校验会失败并退到位置路径；若整条路径仍指向别处，
  就不打印 loc（宁缺勿错）。
- **R2 位置路径随兄弟节点增删而失效**：这正是 `stale_loc` 的用途——错误必须让模型重新快照，
  而不是让它「猜一个差不多的元素」。
- **R3 快照变长**：每个 ref 行多 15–120 字符；交互节点多的页面会更早触发预算截断。
  这是把视觉/上下文成本换到定位稳定性上的刻意取舍；真机验收里观察是否明显变短。
- **R4 跨快照误用**：模型可能拿旧快照的 loc 操作别的页面（导航后）；`stale_loc` 兜底，
  且工具描述要求先快照。
