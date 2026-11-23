# 参考 006：人工接管、验证检测与相位同步

TICKET-005 的实施记录。这份材料解释三件事：**谁在开车**（相位状态机存在哪里、怎么拦）、**怎么知道该停车**（检测器的信号与门槛）、**交接时两边各看到什么**（摘要 + 徽章）。

## 1. 为什么相位必须存在 host 侧

面板是 client 半的一部分，随时可能被卸载（切会话、收侧栏、重载插件）。如果"用户已接管"这个状态只活在面板的 React 状态里，那么一次重挂载就会把 Agent 放回驾驶位——用户正握着鼠标，Agent 却开始点击。所以：

- 相位的**唯一权威**是 host 侧的 `Bridge.#states`（`Map<sessionId, {phase, since, reason, signals, digest}>`）；
- 工具调用在**入队之前**过 `#assert(sessionId, type)`，被拒的命令根本不会进队列，面板连看都看不到；
- 面板只做两件事：把用户的操作报上去（`POST /phase`），以及把 host 的相位画出来（每次轮询的 `states` 字段）。

副作用是好的：切会话、换窗口、重载面板都不会让相位丢失——`since` 也在 host 侧，所以计时器重挂载后接着走。

## 2. 相位状态机

```
idle ──browser_open / 任何输入命令──▶ agent
agent ──用户点「我来接管」──────────▶ taken_over
taken_over ──用户点「交还 Agent」───▶ agent
任意态 ──检测命中（且非 taken_over）─▶ needs_human
needs_human ──用户点「我来接管」─────▶ taken_over
任意态 ──检测未命中（原 needs_human）▶ idle
```

`agent` 有 45s 的空闲衰减（`IDLE_MS`）：`stateOf()` 在返回时把超时的 `agent` 读作 `idle`，所以徽章不会永远停在"Agent 正在操作"。`idle` 与 `agent` 对工具调用没有区别（都能用），差别只在徽章文案与计时器。

## 3. 门控矩阵（`#assert`）

| 相位 | 读（snapshot） | 输入（click / type / press / eval） | 导航（open） |
|---|---|---|---|
| `idle` / `agent` | ✅ | ✅ | ✅ |
| `needs_human` | ✅ | ❌ `needs_human` 错误 | ✅ **放行** |
| `taken_over` | ✅ | ❌ `taken_over` 错误 | ❌ `taken_over` 错误 |

`needs_human` 放行 `open` 是实测后改的：面板卡在挑战页时，如果连导航都被拒，Agent 就没有任何合法出口，只能干等用户——而"换一页继续干活"是它应该能做的选择。`taken_over` 不放行：那时面板整个属于用户。

两条错误串都是给模型读的，所以带着下一步动作：

```
taken_over: 用户已接管，请等待交还。The user is driving the panel right now; wait until they
hand it back, then continue. Reads (browser_snapshot) still work.

needs_human: 页面需要人工验证（a human verification step is on screen）。Ask the user to complete
it in the panel; browser_snapshot still works so you can see when it is gone, and browser_open can
still navigate away from this page.
```

`setPhase` 里还有一条：一旦进入 `taken_over`，立刻 `#flushSession()` 清掉该会话队列并 reject 所有在等结果的命令（文案："the user took over while this command was queued"）。用户接手瞬间不该有半截命令落地。

## 4. 检测器（`plugin/inject/detect.js`）

三条信号，**至少要两类**，且其中必须有 DOM 或 URL/标题：

| 类别 | 依据 |
|---|---|
| `location` | URL 含 `challenges.cloudflare.com` / `/cdn-cgi/challenge-platform`；标题匹配 `just a moment`、`attention required`、`checking your browser`、`verifying you are human`、`请稍候`、`安全验证` |
| `dom` | `#challenge-stage`、`#challenge-form`、`#px-captcha`、`#px-captcha-wrapper`、`.cf-turnstile`、`iframe[src*=challenges.cloudflare.com]`、`iframe[src*=recaptcha]`、`iframe[src*=hcaptcha]`、`[class*=captcha i]`、`[id*=captcha i]` |
| `text` | 正文前 20000 字含 `verify you are human`、`checking your browser`、`checking if the site connection is secure`、`请完成安全验证`、`拖动滑块`、`滑动以完成拼图`、`人机验证` |

判定：`hit = 命中类别数 ≥ 2 && (dom || location)`。单靠一句 `[class*=captcha]` 或单靠一段文案都不算——这是零误报的来源。

命中时返回第一个有布局盒的命中元素矩形，面板拿它画红框。检测时机只有两个：**每次 `open` 之后**、**每次 `snapshot` 之后**。没有定时检测、没有周期快照——接管期间面板对页面零打扰。

## 5. 交接摘要（交还时 Agent 看到什么）

用户点「交还 Agent」时，面板**先自己拍一次快照**（`maxChars: 1200`，不带图），把它压成一行：

```
<标题> · <URL> · <N refs> · <第一行文本，截 120 字>
```

随 `POST /phase` 一起送到 host，存进 `#states.digest`。下一次工具调用（任意工具）时 `takeDigest()` **读后即清**，`browser_snapshot` 的文本尾部因此多一行：

```
While you were away: Just a moment... · http://127.0.0.1:8795/challenge · 1 refs · - page "Just a moment..."
```

这条链路踩过一个坑：面板要跑快照，就需要页面侧的遍历源码，而那之前只在命令参数里随包下发。修法是 host 新增 `GET /source?name=snapshot`（`Bridge` 构造时收 `sources: { snapshot: snapshotSource }`），面板自己去取——**不把脚本复制进 client 包**，否则两份会漂移。取不到时降级成 `标题 · URL`，宁可有半条摘要也不能没有。

## 6. 徽章与配色

| 相位 | 文案 | 底色 |
|---|---|---|
| `booting` | 启动中 | 灰 |
| `idle` | 空闲 | 绿 |
| `agent` | `Agent 正在操作（mm:ss）` | 蓝 |
| `needs_human` | 等待你处理（人机验证） | 琥珀 |
| `taken_over` | `你已接管（mm:ss）` | **白**（`#ffffff` + `#98a2b3` 边） |

计时器 1s tick，只在 `agent` / `taken_over` 且 `document.visibilityState !== 'hidden'` 时走；起点是 host 的 `since`，所以切换会话再回来不会归零。

## 7. 相位同步的两个真 bug（都修了）

**① 轮询泵不自我重排** —— `startPolling` 的 `pump()` 只在启动时调用一次，重排全靠 500ms 看门狗，而看门狗有 `Date.now() - lastRound >= 4000` 的门槛。结果轮询周期变成 4s，长轮询等于废掉：相位变化要 4–4.5s 才到面板（实测六次：4044 / 4538 / 4566 / 4662 / 4605 / 4566 ms）。修法是每轮结束立刻排下一轮：

```js
} finally {
  running = false
  if (!stopped) next = setTimeout(() => { void pump() }, 0)
}
```

修完同一条路径实测 **4–28ms**（`taken_over` 28ms，其余 4–6ms）。看门狗保留，但退化成真正的兜底。

**② 轮询回来的旧相位会盖掉刚设的新相位** —— 检测刚把本地相位设成 `needs_human`，同一时刻在途的 `/pending` 响应带着几毫秒前的 `agent` 回来，徽章就闪一下再变回去。修法是比较 `since`，旧的让位：

```js
const local = phases.get(sessionId)
if (local !== undefined && local.since > since) continue
setPhaseLocal(sessionId, String(state_.phase ?? 'idle'), since, String(state_.reason ?? ''))
```

## 8. 开发循环（本轮又验证了一遍）

| 改了什么 | 生效方式 | 耗时 |
|---|---|---|
| `client.js`（含 `inject/*.js` 的使用方） | `remove_bundle` + `install_bundle`，**且必须改内容**（bump `CLIENT_REV`） | ~1.5s，client 半重新执行 factory |
| `bridge.js` / `tools.js` / `index.js` | 同上；只切 `set_plugin enabled` 会重建 host 但**不重载 client 半**，结果是 `pulled: 0` 全超时 | ~1.5s |
| `inject/snapshot.js` / `inject/detect.js` | 什么都不用做——host 每次调用读盘 | 0s |

两条新踩的坑：

- **重装后别马上发命令**：client 半要几秒才重新挂载（日志出现 `panel ready` 才算数），这期间发的命令会超时（45s 白等，尽管它最终会跑）。判据是 `GET /health` 的 `parked: 1`。
- **`package.json` 不能带 BOM**：PowerShell 的 `Set-Content -Encoding utf8` 会写 BOM，DSH 会以 `SyntaxError: Unexpected token '﻿'` 拒绝安装并回滚。改 JSON 一律用编辑器工具，或 `[System.IO.File]::WriteAllText(path, text, UTF8Encoding($false))`。

## 9. 红框：为什么画在页面里，不画在面板里

第一版把框画在面板的 DOM 层（`hostWrap` 的绝对定位兄弟节点）。它**从来没被看见过**，两次真因：

1. **`<webview>` 盖在兄弟节点之上**。`document.elementFromPoint()` 在框中心取到的是 `WEBVIEW`，不是那个框——面板里给的 `z-index` 再高也没用，guest 是独立合成层。判据：日志里的 `overlay` 行 `top: "WEBVIEW"`。
2. 更根本的一条：**`<webview>` 一直是 Electron 默认的 300×150**。`height: 100%` 在 flex 项里对着不确定高度解析，于是控件停在 150px，页面被挤在顶端一条里，框就算画对了也被裁在下面。实测视口 `575×150` → 改成 `position:absolute; inset:0` 后 `575×863`。

现在的做法：检测器**在页面里**画框（`#dsh-challenge-outline`，`position: fixed` + `pointer-events: none` + `z-index: 2147483646`），没有命中矩形时改成页顶的一条文字提示（"检测到人机验证，请你在面板里完成"）。三个好处：一定可见、跟着页面滚、并且**会出现在 Agent 收到的截图里**——原来的面板层版本永远进不了图。

`<webview>` 的那条 CSS 现在是：

```js
element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;display:flex'
```

## 10. 已知缺口

- 摘要只有一行，没有"页面结构变化"的差分（比如"表单多了 3 个字段"）。
- 相位只在内存里：DSH 重启后所有会话回到 `idle`。用户如果是在重启前接管的，重启后需要重新点一次——目前可接受，因为重启本身就中断了操作。
- 检测器的选择器是按公开的 CF / reCAPTCHA / hCaptcha / PerimeterX 形态写的，站点改版会漏报（不会误报）。
- guest 没在画的时候 `capturePage()` 会一直挂着（面板被遮挡、窗口在后台时），快照会降级成纯文本并在文案里说明；这是 Electron 的行为，不是我们的 bug。

