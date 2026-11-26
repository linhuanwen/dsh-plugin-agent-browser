# 018 · `browser_wait` 真机案例（TICKET-044）

> 结论：**四种情形全部通过**（立即命中 / 等出现 / 等消失 / 超时），且「等出现」按**可见性**判定——`#late` 虽然从首帧就在 DOM 里，但 `display:none` 期间不会被误判为出现。测试环境：DSH 0.2.2-rc.5 + 插件 1.5.5（`CLIENT_REV` 51），夹具 `demo/wait.html`（页面加载后 8s 让 `#late` 显示、12s 让 `#vanishing` 消失、14s 把状态文本改成「状态：加载完成」）。

## 1. 命令与回执

| # | 命令 | 回执 | 判定 |
| --- | --- | --- | --- |
| W1 | `browser_wait { selector: '#late', timeoutMs: 2000 }`（页面刚重载，`#late` 尚隐藏） | `Waited 2.1s; the condition was not met (timed out).` | ✅ 隐藏骨架不算「出现」；超时是**正常结果**不是错误 |
| W2 | 重载后立刻 `browser_wait { selector: '#late', timeoutMs: 12000 }` | `Condition met after 5.2s: appeared.` | ✅ 真的等到可见（8s 计时器） |
| W3 | 重载后立刻 `browser_wait { selector: '#vanishing', gone: true, timeoutMs: 15000 }` | `Condition met after 5.0s: is gone.` | ✅ `gone` 等消失 |
| W4 | 重载后立刻 `browser_wait { text: '状态：加载完成', timeoutMs: 15000 }` | `Condition met after 9.7s: appeared.` | ✅ 文本等待（14s 计时器） |
| W5 | `browser_wait { selector: '#stable', timeoutMs: 2000 }` | `Condition met after 0.0s: appeared.` | ✅ 立即命中 |
| W6 | `browser_wait { selector: '#never-appears', timeoutMs: 2000 }` | `Waited 2.6s; the condition was not met (timed out).` | ✅ 从不出现 → 超时正常返回 |

（W1 与 W2 之间、W2–W4 之间各用 `browser_press F5` 重载夹具——`browser_open` 到同一 URL 不会重新导航，计时器不会重置。）

## 2. 验收中的三个真实发现

1. **「出现」必须是可见**：首版 `inject/wait.js` 只查 `document.querySelector(...) !== null`，`#late` 这种「首帧就在 DOM 里的隐藏骨架」会立刻假成功（第一次真机 W1 直接 `0.0s` 命中）。已改为 `getClientRects().length > 0` 且 `display`/`visibility` 未隐藏；`gone:true` 时隐藏元素算已消失。这决定 SPA 上这个工具是否可信。
2. **注入源码必须是单个函数表达式**：首版 `inject/wait.js` 有两个顶层函数声明，面板按 `(<source>)(input)` 注入时在页面里抛
   `Error: Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: Script failed to execute…`（页面侧其实是 SyntaxError）。已合并为一个函数（`isVisible` 内嵌），并加单测「the source is a single function expression the panel can call in place」防止回归。
3. **夹具自身的坑**：用户脚本里 `var status = document.getElementById('status')` 会被 `window.status`（遗留字符串属性）吞掉，`status.textContent = …` 静默失效——导致「等文本」一度假失败。夹具已改名 `statusBox` 并注释说明。

## 3. 已知边界

- 夹具用计时器制造变化，所以回执里的 `after Xs` 是「从命令开始轮询到命中」的时间，不等于页面计时器的原始值（含重载与往返误差）。
- 只做「一次同步探针 + 宿主侧轮询」，不支持 `waitForFunction` / `networkIdle` / URL 变化等待（SPEC-004 B1 的非目标）。
- `wait` 是读命令：不需要审批，`needs_human`/`taken_over` 期间可用且不抢相位（`plugin/test/bridge.test.mjs` 已覆盖）。
- 文本匹配走 `body.innerText`（渲染文本），`display:none` 里的文字不会被匹配——这是有意的。

## 4. 复跑方式

```powershell
# 单元测试（16 例）
node --test plugin/test/wait.test.mjs

# 真机（1.5.5 已装机、面板打开）
browser_open { path: 'demo/wait.html' }
# 然后按上表逐条执行；每次需要重置计时器时先 browser_press F5
```
