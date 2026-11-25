# TICKET-033 真实验证墙漏报：Cloudflare/Turnstile 挑战页没触发 needs_human

- **状态**：✅ 已实现并真站回归（2026-11-24 实现，2026-11-25 在 1.5.2 真面板通过验收 1 与验收 4）
- **优先级**：P2（安全语义未破：登录框与下载仍拦；但"把挑战页当普通页继续操作"会浪费步数、诱发幻觉）
- **来源**：2026-11-23 上线测试 G2.1 —— `https://nopecha.com/demo/cloudflare` 真实 Cloudflare「正在进行安全验证」页
- **对应验收**：`docs/cases/010-validation-cases.md` V8、`docs/cases/013-hardening-cases.md` H8、`docs/cases/014-practical-cases.md` S5

## 1. 现象

打开 `https://nopecha.com/demo/cloudflare`（NopeCHA 的 Cloudflare Turnstile 演示页）：

- 页面标题/正文是「请稍候…」+
  「正在进行安全验证 / 验证您是人类」一类挑战文案；
- **`needs_human` 没有触发**：`browser_snapshot` 与 `browser_eval` 照常执行（读到 `visible | 请稍候…`），工具链把挑战页当普通页面；
- 人在面板里完成 Turnstile 后，页面自动跳到 `https://nopecha.com/demo`，`browser_snapshot` 读到 25 refs / 1.9 KB——**交接后的继续执行没有问题**，问题只在"墙没被认出来"。

对照实验：1688 的「验证码拦截」页**能**触发 `needs_human`（`docs/cases/014` §7.5），说明检测不是全失效，而是覆盖不到这类挑战页。

## 2. 原因（实测后修正）

原假设是"挑战控件在跨域 iframe + shadow DOM 里，顶层文档读不到"。读完 `detect.js` 与被漏报页面的信号构成后，真正的原因是三条叠加：

1. **文案不在短语表里**。`PHRASES` 有「请完成安全验证 / 拖动滑块 / 人机验证」，但没有「正在进行安全验证」「验证您是人类」「请稍候」；Turnstile 演示页的标题是站点自己的（`NopeCHA: Cloudflare Turnstile Demo`），墙的文案只出现在正文。于是 `text` 信号永远不成立。
2. **单类别信号永不命中**。判定要求 `kinds >= 2` 且（`dom` 或 `location` 命中）；而 `textOnly` 例外只豁免 `text`，标题/URL 单独命中时（`location` 一类）不触发，`dom` 单独命中也不触发。演示页的 iframe（`iframe[src*="challenges.cloudflare.com"]`）其实**读得到**——它只是孤零零一个 `dom` 信号。
3. **检测时机**。`detectChallenge` 只在 `open` 与 `snapshot` 各跑一次（`plugin/client.js:536,546`）；Turnstile 的 iframe 是异步挂载的，`open` 落地那一刻可能还没有 iframe。

## 3. 修法（已实现）

| 位置 | 改动 | 对应原因 |
|---|---|---|
| `plugin/inject/detect.js` `PHRASES` | 补「正在进行安全验证」「验证您是人类」「请稍候」「verifying you are human」，并新增 `STRONG_PHRASES`（只有墙会说的文案） | 1 |
| 同文件 `SELECTORS` | 补 `iframe[src*="challenge-platform"]`、`iframe[title*="challenge" i]`、`#cf-challenge-running` | 1/2（新式 orchestrate 页的 iframe src 不一定含 cloudflare 域名） |
| 同文件判定 | 新增两条**窄**单类别例外：①强文案命中且可交互 ≤10；②标题命中、可交互 ≤3、非短 meta refresh。原有「两类别」规则与 `textOnly` 规则不变 | 2 |
| 同文件 meta refresh | `content` 延迟 ≤3s 视为跳转页，抑制所有弱规则（有 `dom` 信号时不受影响） | 验收 3（秒跳页不误报） |
| 同文件返回值 | 新增 `pending`：未命中但已有文案/标题信号、可交互 ≤30 时为 `true` | 3 |
| `plugin/client.js` open 分支 | `pending` 时以 700ms 间隔**再检测两次**再结算工具调用（最多多花 1.4s，且只发生在带文案/标题信号的页） | 3（让 `browser_open` 本身返回 `needs_human`） |

`detect.js` 182 → 245 行；判定函数仍只读 `document` / `location`，不注入、不点击、不绕过（决策 D03）。

## 4. 验证

- `node --test plugin/test/detect.test.mjs`：**14/14**。新增 6 例：
  1. Turnstile 演示页（正文文案 + 挑战 iframe → `hit`，`categories = dom,text`）；
  2. 组件尚未挂载（只有文案+少量链接 → `hit:false, pending:true`）；
  3. 强文案旁有 8 个链接仍判墙；
  4. 空文档 + 标题「Just a moment...」判墙（title-only 例外）；
  5. 1 秒 meta refresh 秒跳页 → 不判墙、不 pending（验收 3）；
  6. 短 refresh 背后有挑战 iframe → 判墙（`dom` 信号优先）。
  原有 8 例（1688 滑块、帮助文章 40 控件不误报、纯文本 README 不误报、孤立的 captcha class 不误报等）全部保持通过。
- `node --test plugin/test/*.test.mjs`：**202/202**（原 196 + 新增 6）。
- **真站回归（2026-11-25，1.5.2 / DSH 0.2.2-rc.5，真面板）已通过**：
  1. `browser_open https://nopecha.com/demo/cloudflare` → 返回 `needs_human: a human verification step is on screen…`（页面标题「请稍候…」）；
  2. 该页上 `browser_eval` → `Error: needs_human: 页面需要人工验证…`，脚本未执行（这一条的通过还依赖 1.5.2 修掉的「审批提示不该盖过 `needs_human`」竞态，见 TICKET-037）；
  3. 用户在面板里手动过 Turnstile 后页面跳到 `https://nopecha.com/demo`，`browser_snapshot` 立即可读（57 refs）、不再带 `needs_human`；
  4. `browser_open`/`browser_snapshot` 在 example.com、163.com 等普通页不误报（1.5.x 装机验收期间反复读页无 `needs_human`）。
- `plugin/client.js` 的 open 二次检测属于渲染器半边，node 测试覆盖不到（`client.js` 不在 `plugin/test` 的加载范围），装机回归时看桥日志有第二次 `detect` 且 `open` 结果带 `needsHuman` 即可确认；`CLIENT_REV` 已 46 → 47。

## 5. 剩余风险

- 其他厂商（Akamai / PerimeterX / DataDome / 腾讯防水墙）的挑战页未取样，文案与结构可能又是另一套；本 ticket 只按 Cloudflare Turnstile 演示页的实测证据修。
- 无 meta refresh 的 JS 定时跳转 loading 页，仍可能被「标题单独命中」规则误判为墙（决策 D03 的取舍：多问一次比硬撞墙便宜）。
- title-only 例外的标题词表就是 `TITLE_RE`，厂商换文案就要补词——它是可维护的清单，不是通用识别。

## 6. 发布前要同步的文档

- 用户 `README.md`「已知限制」里「验证墙可能漏报」那条（当前行 238）改为：已验证 Cloudflare Turnstile 演示页，其他厂商挑战页仍可能漏报；
- `docs/release/release-notes-1.4.md` 是 1.4 的历史文档，不改；1.5.0 的发布说明里把「验证墙可能漏报」从已知限制移入「相对 1.4 的行为变化」并保留残余风险；
- `PROGRESS.md` 的 TICKET-033 行改为已实现。
