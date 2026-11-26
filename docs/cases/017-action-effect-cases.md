# 017 · 写动作回执三态（effect）真机案例

> 对应 TICKET-042 / SPEC-004 B4。目标：写动作（`browser_click`/`browser_type`/`browser_press`/`browser_eval`/`browser_download`）的「发出去了没有」不再只有「成功 / 抛错」两种叙事。
>
> 真机环境：2026-11-26，DSH Desktop 宿主 `0.2.2-rc.5`，插件 **1.5.4**（tgz 322,516 B / sha256 `A757E17C36DEEE479686B05867F4B4E1103FA76C9B9B539DF9333F5B0EE2F405`），Windows。夹具 `demo/approval-form.html`（插件静态服务，origin 每次动态端口）。

## 1. 结论表

| 场景 | 期望 | 真机结果 |
|---|---|---|
| 读动作（普通按钮 click） | 正常执行，不带 effect 语义 | ✅ `Clicked button "普通按钮" at (126, 242).` |
| 写动作成功（click/type/press/eval/download，页面 `ok:true`） | 结构化结果 `effect:'committed'` | ✅ 单测覆盖（`plugin/test/effect.test.mjs` ⑤）；真机 `browser_eval` 正常返回 `"写动作确认夹具"`，无错误 |
| 参数/审批/策略/相位/入队前失败 | `effect:'none'` + 既有错误码 | ✅ 单测覆盖（⑥ 坏 ref → `details.effect==='none'` 且 bridge 零调用；`approval_denied`/`approval_timeout` 等码语义不变） |
| **已拉走、结果丢失（超时/断线/接管/关闭）** | **`action_unknown`（`retryable:false`）** | ✅ 真机两条（见 §2） |
| `browser_eval` 页面侧抛错 | `action_unknown`（脚本到过页面） | ✅ 真机两条（语法错误与人为抛错同一路径） |
| 未拉走就超时 | `bridge_timeout`（可安全重试） | ✅ 单测覆盖（②） |

## 2. 真机证据

### 2.1 eval 页面抛错 → `action_unknown`

```
browser_eval { script: "await new Promise((r) => setTimeout(r, 32000)); return 'slept'" }
→ Error: action_unknown: the script reached the page and threw: await is only valid in async functions
  and the top level bodies of modules. The page may have partially changed — take a
  browser_snapshot and check before retrying.
```

说明：`Guest.eval` 用 `eval(script)` 执行表达式/语句，**不支持顶层 `await`**；但这条错误走的是「脚本已到页面」分支，因此正确标成 `unknown`。想等待异步结果请 `return new Promise(...)`（`awaitPromise` 默认 `true`，会等它）。

### 2.2 12 秒 eval 执行中被接管 → `action_unknown`

1. `browser_eval { script: "new Promise((r) => setTimeout(() => r('late-result'), 12000))" }`
2. 用户在确认条点「允许一次」，命令下发后立刻点工具栏「我来接管」。
3. 工具返回：

```
Error: action_unknown: the eval command was already pulled by the panel, so the page may have
executed it; its result was lost (the user took the panel over while it was executing).
Take a browser_snapshot and check the page before deciding; do not resend the same action.
```

4. 随后 `browser_snapshot`：页面仍是 `写动作确认夹具`，`#count` 未被改写，7 refs 正常——**接管后不再有动作写进页面**，`unknown` 只是「无法证明没发生」，不是「一定没发生」。

## 3. 已知边界（诚实说明）

- 已下发后页面回报 `ok:false` 目前统一按 `effect:'none'` 处理（`browser_eval` 的页面抛错除外，显式 `unknown`）：现有页面动作的 `ok:false` 都带明确失败点（元素不存在/被遮挡/密码框），可安全重试；`browser_type` 的「中途失败」边界未细拆。
- 真机未制造出「面板 30 秒不回执」的纯超时路径：`Guest.eval` 自身 15 秒上限会先返回。纯超时分支由 `plugin/test/effect.test.mjs` 的 fake poll 流覆盖。
- `bridge_timeout` 语义不变（未发出）；`cancelled` 在「已拉走后取消」时改为 `action_unknown`（见 `plugin/test/cancel.test.mjs`）。

## 4. 复跑方式

```powershell
node --test plugin/test/effect.test.mjs plugin/test/cancel.test.mjs
node --test plugin/test/*.test.mjs   # 259 例
node tools/check-docs.mjs
```

真机复跑：装 1.5.4 → `browser_open { path: 'demo/approval-form.html' }` → 按 §2.2 步骤（需用户在面板上点「允许一次」再点「我来接管」）。
