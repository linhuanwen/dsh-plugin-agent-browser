# 参考 009 — spec §10 验收审计（A1–A13 逐条对照）

> 目的：七张 ticket 全绿不等于 spec 每条都验过。这份文档把 `docs/spec/001-agent-browser-plugin-spec.md` §10 的 A1–A13 与**当前安装的 1.0.3 真包**逐条对照，标出"通过 / 带偏差通过 / 未验证 / 不通过"，并给出证据位置。
>
> 审计时间：2026-11-20。审计对象：`dist/dsh-plugin-agent-browser` 1.0.3（装在 profile 里的真包）。

图例：✅ 通过（有实测证据）· ⚠️ 带偏差通过（行为达标，实现与 spec 写法不同）· ❔ 未验证（缺证据）· ❌ 不通过

## 总表

| # | 验收标准（spec 原文要点） | 结论 | 证据 / 说明 |
|---|---|---|---|
| A1 | 右侧栏出现「浏览器（Agent）」tab，点开是空白浏览器面板 | ✅ | 引导页条目已注册（`client.js` 的 `guide: [{ id:'open', order:40, title:()=>'浏览器（Agent）', description:()=>'让 Agent 在右侧打开真实网页，你可以随时接管' }]`）；**用户目视确认**：引导页里有这张卡，点开出现空白浏览器面板、引导 tab 被替换（2026-11-20） |
| A2 | `browser_open('https://example.com')` → 面板展开、真实加载、徽章"Agent 正在操作" | ✅ | 多次实测：`browser_open('https://example.com/')` → `Opened https://example.com/ — Example Domain`；`badge {"phase":"agent","label":"Agent 正在操作（00:02）"}` |
| A3 | `browser_snapshot` 返回 `[ref=eN]` 树 + 截图，ref 数 > 0 | ✅ | `/form` → 15 refs + 878×225 图；`/heavy` → 12010 节点 16ms；`includeImage:false` 时 1.0 KB（带图 6.7 KB） |
| A4 | ref 点击链接 → URL 变化，二次 snapshot 反映新页面 | ✅ | example.com 点 `link "Learn more" [ref=e1]` → `browser_eval` 得 `{href:'https://www.iana.org/help/example-domains'}`；二次快照页标题变 `Example Domains` |
| A5 | 表单填入 + 提交 → 跳转；`type` 不碰密码框（命中即 `needs_human`） | ⚠️ | 填+提交实测跳转 `/done?name=Alice&mail=…`；密码框返回 `that field is a password field. Credentials stay with the human… Nothing was typed.`，页面值仍为 `hunter2`。**偏差**：spec 写"命中即 `needs_human`"（读作相位切换），实现是**工具级错误**（`needs_human` 作为错误码出现在消息里），相位不变——因为密码框不等于有人机验证 |
| A6 | 坐标 `click` 与 `press` 在 canvas 场景可用（spec 举百度地图） | ⚠️ | 用本地 canvas 夹具替代：`scrollTo(0,70)` 后点 `(220,60)` → `{clicks:1, point:{x:196,y:33}}`。**偏差**：没在百度地图上做——需要外网 + 重资源页，而坐标点击的机制与站点无关；`press` 的键盘路径另有 Tab/Enter/Alt+Left/F5 四项实测 |
| A7 | 用户接管 → Agent `click` 返回 `taken_over`；交还后恢复且**页面未刷新** | ✅ | 用户亲手点两轮；`Error: taken_over: 用户已接管，请等待交还…`；交还后 `phase … to agent` 且紧随的 snapshot 是同一 URL（全程没有 reload 调用） |
| A8 | Turnstile 页 → 琥珀徽章 + 红框 + `needs_human`；用户通过后 Agent 继续 | ⚠️ | 用夹具 `/challenge`（标题 `Just a moment...` + `#challenge-stage` + `.cf-turnstile` + 英文文案）覆盖三类信号：徽章转琥珀、页面内红框（用户目视确认）、`browser_open`/`snapshot` 返回 needs_human、输入类被拒。**偏差**：真实 Cloudflare 挑战页未复现——`https://nowsecure.nl/` 那次没出挑战，且不该为验收去刻意触发人机验证 |
| A9 | `browser_open({path})` → 静态服务起来、页面渲染、**关 tab 后端口释放** | ❌ | 前两段 ✅（起服务、外链 CSS/图片/fetch 全对）。**第三段不成立**：端口只在插件 dispose 时关闭（`index.js` 的 `ctx.effect(() => () => sites.dispose())`），关 tab 不会释放。当前设计是"每个工作区一个服务、多个页面复用"，端口因此比 tab 活得久 |
| A10 | `file://` 与 DSH 自身地址均被拒绝，且给出明确原因 | ✅ | `browser_open('file:///C:/Windows/win.ini')` → `Error: only http(s) URLs are allowed, got file:`（工具层就挡，比交给主进程更早）。DSH 自身地址 → 主进程拒绝：`Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_FAILED (-2) loading 'http://127.0.0.1:13098/'`。**说明**：我们的代码里没有"拒绝 DSH origin"的显式判断，靠的是主进程；错误文本是 Electron 的 |
| A11 | 切会话再切回 → 页面仍在原处（`keepMounted` 生效） | ✅ | 实测（用户操作 + 日志双重证据）：面板里开着 `http://127.0.0.1:4614/demo/index.html`，切到另一个会话再切回，**页面与页面内状态都在**（按钮计数 `hits` 从 0 变成 4 仍保留）；`/logs` 里只有开机那一次 `panel mount`（1795139276839）与一次 `lease acquired`，切会话后**没有新的 mount / 租约**，说明 panel body 从未卸载。→ `keepMounted: true` 确实让侧栏 tab 跨会话存活 |
| A12 | 重启应用 → tab 壳还在，提示"重新打开"（不假装恢复） | ✅ | 2026-11-23 16:1x 实测（补上原先缺的证据）：重启前 `/health` 桥 **12125**、`clients:1`、`states:[session-e32e610d…]` → 完全退出 DSH 重开（宿主 9522 → **9515**，桥换到 **9516**）→ `/health` `clients:0`、`seen:[]`、`states:[]`、`enqueued:0`、`logs:4` ⇒ 插件侧**零状态恢复**，不存在"假装恢复"。用户目视重启后右侧栏：**没有**「浏览器」页签或空白壳。随后首次 `browser_open https://example.com/` 一把成功（`Opened … — Example Domain`，无 `panel_not_open`），`clients` 变 1、只挂本会话。留证 `screenshots/v11-restart-after-open.png` |
| A13 | 代码里搜不到任何自动过验证/打码实现 | ✅ | 对 `plugin/` 全量 grep `captcha|turnstile|2captcha|anti-captcha|hcaptcha|recaptcha|bypass|打码|过验证|solve`：命中项全部是**检测用的选择器**、`resolve()` 等同名函数、以及一句注释 `It only ever *reports*. Nothing here tries to solve, spoof, or click a…`。无任何求解、转发打码、绕过逻辑 |

## 非功能要求（spec §9）

| 项 | spec | 实测 | 结论 |
|---|---|---|---|
| 快照耗时 | < 300ms | 普通页 1–2ms；12010 节点 16ms | ✅ 远超要求 |
| 单步动作延迟 | < 150ms（不含网络） | 读类 6–8ms；**输入类 226–413ms**，且我们自己的代码 0ms（`click timing {focus:0, events:0}`），慢在 Electron 把输入事件送进 guest | ❌ 输入类达不到，已记入 `docs/tickets/004` |
| token 预算 | 文本 ≤ 8000 字符 + 一张 768px 图 | 默认 `maxChars 8000`；图按 `min(deviceWidth, 768×ratio)` 缩放 | ✅ |
| 并发 | 同 tab 串行 | 所有动作工具 `isConcurrencySafe: () => false`，bridge 按会话串行入队 | ✅ |
| 取消 | 接管 / 超时 / 会话中断都能中断在飞命令 | 接管 → `#flushSession` 清队列并 reject；工具侧 45s/30s 超时；**会话中断未专门测** | ⚠️ |
| 不污染宿主 | 不改官方包 | 只动自己的 profile 条目与 `node_modules` | ✅ |

## 工具契约（spec §5）对照

六个工具与 spec §5.1–5.6 一一对应，参数与返回基本一致。**唯一的形态差异**：spec §5.7 的 `browser_screenshot` **没有单独实现**，它被并进 `browser_snapshot`（默认附图、`includeImage:false` 关掉）。理由：决策 D08 本就是"每次快照附图"，单独一个截图工具会造成两次视觉 token 消耗；实测数据也支持（带图 6.7 KB / 纯文本 1.0 KB）。

## 需要决定的三个偏差

1. **A9 端口不随 tab 关闭释放**。要么改实现（站点引用计数，最后一个用它的 tab 关掉时 `dispose`），要么改 spec 承认"服务随插件活"。倾向改 spec：同一个工作区共享一个服务是刻意选择（复用端口、少一次 listen），引用计数会引入"关掉 tab 时我正在读的图片 404"这类新问题。
2. **A5 的 `needs_human` 语义**。密码框返回的是工具级错误而不是相位切换，这是对的（否则用户一碰密码框，整个面板就被锁成"等待人工验证"）。建议把 spec 这句改成"返回 `needs_human` 错误，不切换相位"。
3. **A11 反而通过了**（原本以为会退化成空白）。既然 `keepMounted` 能让页面跨会话存活，就把它当成一条要守住的性质写进 spec 与 README：**切会话不清页面**。将来若改动挂载策略（例如为了省内存改成"只剩当前会话挂载"），必须重新验 A11。

## 待补测（已于 2026-11-23 全部补齐）

| # | 怎么做 | 看什么 | 结果 |
|---|---|---|---|
| A12 | 下次重启 DSH 后看一眼右侧栏 | 是否残留一个"浏览器"tab 壳；点开是空白浏览器面板（合格）还是直接报错 / 假装恢复了页面（不合格） | ✅ 2026-11-23 16:1x：无残留壳、插件侧零状态恢复、首次 `browser_open` 一把成功（详见 §10 表格 A12 行与 `docs/cases/010` V11 节） |

全部条目已于 2026-11-23 补齐：结果已写回本文件与 §10 表格，`README.md` 状态表与 `docs/cases/010` V11 节同步。A1 与 A11 于 2026-11-20 由用户目视/操作确认，A12 于 2026-11-23 由用户重启 + 目视确认。
