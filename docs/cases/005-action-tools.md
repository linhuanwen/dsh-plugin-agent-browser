# 动作工具：怎么点、怎么输、为什么慢

TICKET-004 的实现说明与实测记录。所有数字都来自本机 DSH Desktop 0.2.2-rc.3 + `tools/testsite.mjs` 夹具。

## 1. 两个执行器

| 层 | 手段 | 用途 |
|---|---|---|
| DOM 层 | `webview.executeJavaScript(source)` 注入页面函数 | 找元素、滚动、写值、读状态、执行任意 JS |
| 输入层 | `webview.sendInputEvent({...})` | 产生**可信输入**（`isTrusted: true`），命中测试在 Chromium 合成器里做 |

只有输入层能点中 canvas、跨域 iframe、被半透明遮罩挡住但仍可见的元素。DOM 层负责把"点哪儿"算出来。

### 注入方式

`plugin/inject/actions.js` 是一个自包含函数 `function dshAction(op, params)`，作为**字符串**随命令下发，客户端拼成

```js
(${source})(${JSON.stringify(op)}, ${JSON.stringify(args)})
```

再 `executeJavaScript(...)`。和快照遍历器一样，**每次调用读盘**（`actionSource()`），因为 host 模块会比文件编辑活得久（见 `docs/cases/004-snapshot-engine.md` §5）。

## 2. ref 解析：`data-dsh-ref` 是唯一真相

`inject/snapshot.js` 给每个可交互元素写属性：

```js
element.setAttribute('data-dsh-ref', ref)   // ref 是完整形式：e5 / f1e5
```

动作层直接按属性值精确查找，**不需要任何注册表**，因此：

- 页面重绘后 ref 失效 → 查不到 → `stale_ref`；
- 帧内元素的 ref 带前缀，属性值也带前缀，落到哪个文档由 `[data-dsh-frame="1"]` 的 iframe 决定。

```js
var match = REF.exec(ref)              // /^(f\d+)?e(\d+)$/
var frame = match[1] ? match[1].slice(1) : ''
var doc   = frame ? iframeDocument(frame) : document
var element = doc.querySelector('[data-dsh-ref="' + ref + '"]')
```

早期实现把帧内 ref 存成 `e5`、查找时只用 `e5`，导致 `browser_click({ref:'f1e5'})` 永远 `stale_ref`——这个坑写进 `docs/tickets/004-action-tools.md` 的实测发现。

## 3. 点击：先算点，再发事件

`op='click'`（页面侧）：

1. `scrollIntoView({ block:'center', inline:'center' })`；
2. `getBoundingClientRect()` 取中心；
3. 宽或高为 0 → `out_of_view`；点落在视口外 → `out_of_view`；
4. 返回 `{ ok, info:{tag,role,name}, point:{x,y,width,height} }`。

host 侧拿到 `point` 后发三个事件（`client.js` 的 `clickAt`）：

```js
element.sendInputEvent({ type:'mouseMove', x, y })
element.sendInputEvent({ type:'mouseDown', x, y, button:'left', clickCount:1 })
element.sendInputEvent({ type:'mouseUp',   x, y, button:'left', clickCount:1 })
```

### 帧内点击必须加 iframe 偏移

帧内 `getBoundingClientRect()` 是**帧坐标**，而 `sendInputEvent` 的坐标是**顶层 webview 视口**坐标。修正：

```js
if (found.frame) {
  host.scrollIntoView({ block:'center', inline:'center' })
  var r = host.getBoundingClientRect()
  center.x += Math.round(r.left)
  center.y += Math.round(r.top)
}
```

越界判断也随之改用顶层 `window.innerWidth/innerHeight`。

### 坐标分支（canvas / 跨域帧）

`browser_click({x,y})` 跳过 DOM 层直接发事件。坐标是**面板视口内 CSS 像素**，左上角为原点。

实测注意：**面板视口可能非常窄**。本机侧栏展开时 `window.innerWidth/innerHeight` 只有 `471×150` 或 `299×150`（CSS px），比页面小得多。所以要点击的目标很可能一开始就在视口外：

```js
window.scrollTo(0, 70)                     // 或 scrollIntoView
// 之后 getBoundingClientRect() 才是当前可点的位置
```

夹具 `/canvas` 验收：canvas rect `{x:24,y:27,w:301,h:201}`，点 `(220,60)` → 页面记录 `{x:196,y:33}`（= 220-24, 60-27），`clicks:1`。

## 4. 输入：为什么不是逐字发 `char`

`op='type'`（页面侧）：

1. `element.type === 'password'` → **立刻**返回 `needs_human`，一个字符都不发（凭据永不进 transcript / 日志）；
2. 非可编辑（无 `value` 且非 contenteditable）→ `not_editable`；
3. `focus({ preventScroll: true })`；
4. `clear !== false` 时用原生 setter 清空 + 派发 `input`：

```js
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '')
el.dispatchEvent(new Event('input', { bubbles: true }))
```

5. 写入：`document.execCommand('insertText', false, text)`，失败则回退原生 setter + `input`/`change`。

选 `insertText` 的理由：它保留 `beforeinput`/`input` 事件（React 受控组件能收到），中文与 emoji 一次到位，不需要为每个字符算 keyCode——逐字 `sendInputEvent({type:'char'})` 对非 ASCII 根本不可靠：探针阶段试过 `keyCode:'A'` 只到得了 ASCII。

`submit: true` → 再 `tap({ keyCode:'Enter' })`。

实测：填入中文 `林焕文` 后页面 `input.value === '林焕文'`；`submit` 后跳转 `/done?name=Alice&mail=…`。

## 5. 按键与"浏览器快捷键"不存在

`parseChord('Alt+Left')` → `{ keyCode:'Left', modifiers:['alt'] }`，支持 `Alt / Ctrl / Cmd / Meta / Shift` 与 `Enter / Tab / Escape / Backspace / Delete / Space / Arrow* / Home / End / PageUp / PageDown / F1–F12 / 单字符`。

**实测发现**：webview 没有浏览器 chrome，Chromium 不会把 `Alt+Left`、`F5`、`Ctrl+R` 当快捷键——事件照发，页面收到，但**不导航**（`location.href` 不变、`history.length` 不变）。

所以 press 命中这几个组合时改走 webview 自身的导航方法（`client.js` 的 `navigationCommand` + `Guest.navigate`）：

| 组合 | 动作 |
|---|---|
| `Alt+Left` | `element.goBack()` |
| `Alt+Right` | `element.goForward()` |
| `F5` / `Ctrl+R` | `element.reload()` |

每个都等 `did-stop-loading`（8s 上限）后返回 `{ handled, from, to }`，工具输出：

```
Pressed Alt+Left — the panel performed "back": http://127.0.0.1:8795/second → http://127.0.0.1:8795/form
```

这条曾经有个真 bug：client 已经返回 `handled`，但 `browserPressTool.execute()` 只回填了 key/keyCode/modifiers，工具结果里看不到——**字段要在 execute 里显式搬一次**。

## 6. eval

页面内包成 async IIFE，`awaitPromise` 默认 `true`：

```js
(async () => { return (eval(script)) })()
```

返回值 `JSON.stringify` 后按 `maxChars`（默认 8000）截断，末尾附 `(result cut at the character budget)`。`Promise` 会等到 resolve（实测 `new Promise(r => setTimeout(() => r({late:true}), 250))` 正常返回）。

工具描述里写明它是页面自身权限：**不能**用来绕过登录或人机验证。

## 7. 延迟：协议 6ms，输入 200–400ms

`bridge.js` 改成长轮询后（`/pending?wait=900`，队列空时挂起等待，入队 `#wake()` 立刻唤醒），host → client 的下发不再有 100ms 轮询周期：

| 动作 | `run` → `settled` | 说明 |
|---|---|---|
| `browser_eval` | **6ms** | 协议与注入成本 |
| `browser_click` | 226–389ms | 其中我们的代码 `click timing {focus:0, events:0}` |
| `browser_press` | 413ms | 同样卡在事件送达 |

结论：慢的不是通道，是 **Electron 把输入事件送进 guest 进程**的固有开销（本机 200–400ms）。ticket 里"一次动作端到端 < 150ms"这条只对读类（eval / snapshot）成立，输入类达不到——如实记录，不再硬追。

## 8. 通道可靠性（都踩过）

| 症状 | 原因 | 处置 |
|---|---|---|
| 面板不响应、工具超时 | client 半没重新加载（`set_plugin` 不够） | `remove_bundle` + `install_bundle`，**并改 `CLIENT_REV`**（只改版本号不可靠） |
| `/logs` 只剩两条 | `report()` 带了 `fetch(..., { keepalive:true })` | 去掉 `keepalive` |
| 命令被拉走但从不执行 | 自调度 `tick()` 链断了且无异常 | 改成定时器驱动的 pump + **500ms 看门狗**（`lastRound` 超 4s 就重启） |
| 鼠标事件全丢、键盘正常 | 面板重挂载后旧 runner 的 webview 已 detach | `Guest.isLive()` + dispatch 时丢弃陈旧 runner；每条命令 `try/catch` 后 `settle(ok:false)` |

`GET /health` 现在是排障第一站：`clients / seen / queued / waiting / parked / enqueued / pulled / logs`。`parked >= 1` 表示轮询活着。

## 9. 已知缺口（留给后面的 ticket）

1. 没有 `taken_over` 门控（TICKET-005）：用户接管期间 Agent 的输入类工具仍会生效。
2. `remove_bundle` + `install_bundle` 后的第一条命令偶发超时（旧 client 半把命令拉走后静默死亡，未证实）。
3. `browser_open` 等 `did-stop-loading` 有 25s 上限，超时只报错，不返回半成品状态。
4. 快照与动作之间没有代次校验：`browser_snapshot` 之后页面自己变了，ref 只在执行时才判定失效（`stale_ref`）。
