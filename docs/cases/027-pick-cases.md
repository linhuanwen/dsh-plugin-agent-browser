# 案例 027：`browser_pick` —— 让人在页面上点一下（TICKET-053，1.5.15）

**结论**：人在右侧栏面板里点一个元素，agent 拿到 `loc`（`css:` 稳定路径）+ 可读名 + 矩形 + 落点；点选的这一下**页面收不到**（计数不动），要真的点下去还得再调 `browser_click {loc}`。超时、面板「取消点选」、用户接管都是正常/明确的结果，不新增错误码。

二进制：`dist/dsh-plugin-agent-browser/dsh-plugin-agent-browser-1.5.15.tgz`（361,128 B / sha256 `6c0207aa63e98d3025d41b0ca9403b6301b1e22375d93f57116d6b463eb4b200`）；`CLIENT_REV` 59→**60**；工具 15→**16**；单测 **375/375**；`check-docs` 六项全绿（工具 16）。

夹具：`demo/pick.html`（图标按钮、三行同名「导出」、canvas 画板；页面用 `document.addEventListener('click', …, true)` 统计**真正收到**的点击）。本地静态服务端口每轮不同，下文的 `127.0.0.1:<port>` 按实际回执为准。

## 1. 结论表

| # | 场景 | 结果 |
|---|---|---|
| P1 | 点无文字图标按钮 `⚙` | 回执 `The person picked button "设置" (loc: css:#icon-btn). Use it with browser_click { loc: "css:#icon-btn" } or browser_type { loc: … }. Picking itself did not click the page, and the page state is unchanged.` |
| P2 | 用 P1 的 `loc` 真点 | `Clicked button "设置" at (48, 175).`；随后 `browser_eval` 读到 `{"clicks":"1","last":"button「设置」"}`（pick 0 次 + click 1 次） |
| P3 | 点第二行「导出」（三行同名、`data-testid` 相同） | `The person picked button "导出" (loc: css:body:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(2) > button:nth-of-type(1)). …`（无法用 `data-testid` 唯一定位时回退 `nth-of-type` 路径）；`browser_click` 该 loc → `Clicked button "导出" at (450, 293).` |
| P4 | 点 canvas 画板 | `The person picked canvas "画板" (loc: css:#board). …`（快照只有整块画板，没有子元素） |
| P5 | 3 秒没人点 | `The person did not click an element within the time budget; the page was not touched. Make sure the browser panel is visible, then ask again — or fall back to browser_snapshot and a ref/loc.` |
| P6 | 点选后立刻看页面计数 | `页面收到的点击：0`、`最后一次：（还没有）`——点选那一下被吞掉，页面自己的 `document` capture 监听器也没看到 |
| P7 | 点选进行中点面板「取消点选」 | `Picking was cancelled (Esc or the panel was taken over); the page was not touched. …` |
| P8 | 面板「我来接管」后 pick | `Error: panel_taken_over: 用户已接管，请等待交还。The user is driving the panel right now, so it cannot ask them to point at an element; wait until they hand it back, then pick again.` |
| P9 | 交还 Agent 后 pick | 正常进入点选（本轮没人点，按 P5 超时返回）——人工相位解除后恢复 |
| P10 | 最终包端到端 | pick 拿到 `css:#icon-btn` → `browser_click` → `Clicked button "设置" at (48, 175).`，快照 `最后一次： button「设置」`；再做一次 pick（`css:[data-testid="row-export"]`）计数不变，随后一次 `browser_click` 计数 +1（`2 → 3`）——pick 不透传点击、click 恰好 1 次 |

## 2. 验收期的五个缺陷（都在真机上才暴露）

1. **`inject/pick.js` 没进包**：首次装 1.5.15 后 `browser_pick` 报 `ENOENT: …dsh-plugin-agent-browser\inject\pick.js`。`tools/pack.mjs` 的 COPY 是显式清单，新增注入源必须同时登记；补上后包从 356,221 B 变 360,000 B（copied 21 files）。
2. **pick 秒返 cancelled**：`runCommand` 的 pick 取消谓词误用了模块级 `state.phase`（初始 `'booting'`，之后没人更新），第一次轮询就判「非 agent」。改为 `phases.get(sessionId)?.phase === 'taken_over'`（`needs_human` 必须放行——pick 正是人指出障碍物的方式）。
3. **点选的那一下漏进页面**：页面自己的 `document` capture click 监听器注册得更早，pointerdown 阶段 finish+cleanup 之后，浏览器仍会把随后的 `click` 派发给 document，页面计数 +1。修复：所有监听器从 `document` 改挂 `window`（window 捕获阶段先于 document），并在 pointerdown 命中后安装一次性 `swallowNextClick`（window capture click，吞掉随后那一下；`pointerup`/`mouseup` 用 `setTimeout(release,0)` 兜底）。修后 P6 计数为 0。
4. **回执 loc 少了 `css:` 前缀**：pick 返回裸路径，而所有工具要求 `css:` 前缀，`browser_click {loc:"#icon-btn"}` 报 `"#icon-btn" is not a loc`。新增 `pickLoc(element)`，回执统一 `css:<path>`。
5. **Esc 在焦点不在页面时无效**：用户按 Esc 没有反应（焦点在聊天输入框，webview 收不到 keydown），随后点了背景 → pick 到 `html`、`loc:''`、只剩 point。修复：开始点选后 `Guest.pick` 主动 `this.element?.focus?.()`，并新增面板「取消点选」按钮（`view.picking` 时出现在缩放控件左侧，`Guest.cancelPick()` 置 `window.__dshPick.cancelled = true`）。文档写清：**页面有键盘焦点时 Esc 可取消；焦点不在页面时用面板按钮**。

## 3. 复跑清单

1. `plugin_manager install_bundle target="…dsh-plugin-agent-browser-1.5.15.tgz"`；面板不可见时先打开右侧栏浏览器页签。
2. `browser_open { path: "demo/pick.html" }`。
3. `browser_pick { timeoutMs: 120000 }`，在面板里点 `⚙` → 得到 `loc: css:#icon-btn`。
4. `browser_click { loc: "css:#icon-btn" }` → 页面计数 +1（pick 本身不加）。
5. 再 `browser_pick` 点第二行「导出」→ loc 为 `nth-of-type` 路径；`browser_click` 该 loc 成功。
6. `browser_pick { timeoutMs: 3000 }` 不点 → 超时正常回执。
7. 点选期间点面板「取消点选」→ `cancelled`；点「我来接管」后 `browser_pick` → `panel_taken_over`；交还后恢复。

## 4. 已知边界

- **页面收不到这次点击**是设计：pick 只回答「是哪一个」，要触发页面行为必须再调动作工具。
- canvas 只能点到画板整体；跨域 iframe 内元素不可达（只能点到 iframe 宿主）。
- 无唯一 CSS 路径的节点返回 `loc:''`，只能用回执里的 `point` 坐标（滚动/重排后失效）。
- 不做多选/框选、不做「点选即执行」、不做拖拽起点点选、不做跨页面点选（页面一导航就取消）。
- Esc 依赖页面键盘焦点；面板按钮是可靠路径。
