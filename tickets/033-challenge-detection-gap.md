# TICKET-033 真实验证墙漏报：Cloudflare/Turnstile 挑战页没触发 needs_human

- **状态**：📋 待修（P2；不阻塞 Windows 首发，但必须写进已知限制与发布说明）
- **优先级**：P2（安全语义未破：登录框与下载仍拦；但"把挑战页当普通页继续操作"会浪费步数、诱发幻觉）
- **来源**：2026-11-23 上线测试 G2.1 —— `https://nopecha.com/demo/cloudflare` 真实 Cloudflare「正在进行安全验证」页
- **对应验收**：`reference/010-validation-cases.md` V8、`reference/013-hardening-cases.md` H8、`reference/014-practical-cases.md` S5

## 1. 现象

打开 `https://nopecha.com/demo/cloudflare`（NopeCHA 的 Cloudflare Turnstile 演示页）：

- 页面标题/正文是「请稍候…」+
  「正在进行安全验证 / 验证您是人类」一类挑战文案；
- **`needs_human` 没有触发**：`browser_snapshot` 与 `browser_eval` 照常执行（读到 `visible | 请稍候…`），工具链把挑战页当普通页面；
- 人在面板里完成 Turnstile 后，页面自动跳到 `https://nopecha.com/demo`，`browser_snapshot` 读到 25 refs / 1.9 KB——**交接后的继续执行没有问题**，问题只在"墙没被认出来"。

对照实验：1688 的「验证码拦截」页**能**触发 `needs_human`（`reference/014` §7.5），说明检测不是全失效，而是覆盖不到这类挑战页。

## 2. 原因（待验证的实现假设）

`plugin/inject/detect.js` 的判定是"文本信号 + 可交互元素数量"的启发式（`textOnly` 规则见 TICKET-026）：

- Cloudflare Challenge 的主体控件在**跨域 iframe**（`challenges.cloudflare.com`）与 shadow DOM 里，顶层文档没有可点的表单/按钮，也没有提交按钮；
- 挑战文案会被拆进 `title` / 少量文本 / `aria-label`，文本信号量与"验证码拦截"页不同；
- 现有规则依赖"有文本信号且可交互很少"这类组合，低估了 iframe 型挑战。

## 3. 修法方向（未实现）

在 `detect.js` 增加"iframe / 结构"信号，并收紧误报：

| 信号 | 判据 | 备注 |
|---|---|---|
| 挑战 iframe | `iframe[src*="challenges.cloudflare.com"]`、`src*="/cdn-cgi/challenge-platform/"`、`iframe[title*="challenge" i]` | 最强信号，跨域也能读 `src` |
| 挑战 form | `#challenge-form`、`#cf-challenge-running`、`[id*="challenge" i]` | Cloudflare 旧版/新版都在用 |
| 标题模式 | `/^(请稍候|Just a moment|Attention Required|Checking your browser|正在进行安全验证)/i` | 单独不够（秒跳页也这么写） |
| 组合判定 | 标题命中 **且**（挑战 iframe 或 主文档文本 < 200 字或 可见控件 ≤ 3） | 减少误报 |

误报风险：正常的"5 秒后跳转"倒计时页、部分站点的 loading 页；缓解=组合条件 + 只在 `browser_open` 首次落地后判定，用户离开该页即清除（现有 phase 机制已有）。

## 4. 验收（写好后）

1. `https://nopecha.com/demo/cloudflare` → `browser_open` 返回 `needs_human`，`browser_eval` 被拒（与 1688 一致）；
2. 正常页面（`https://example.com/`、`https://www.163.com/`）不触发；
3. 秒跳页（`<meta http-equiv="refresh" content="1;url=...">` 夹具）不触发；
4. 人完成挑战后，下一条工具调用不再返回 `needs_human`，`browser_snapshot` 正常。

## 5. 当前处置

- 上线不阻塞：`needs_human` 是"更好的人机交接"，不是安全边界；漏报时人仍然可以手动接管（面板上有「我来接管」），且不会泄露密码、不会绕过下载黑名单。
- 已写进发布说明/用户 README 的"已知限制"：遇到 Cloudflare 一类挑战页时，检测可能不触发，请人工接管后继续。
- 若任务落到挑战页且 Agent 仍在尝试操作，正确做法：报 `needs_human` 缺失问题、提示人接管，而不是在挑战页里乱点（S5 判负项）。
