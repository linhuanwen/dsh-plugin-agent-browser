# TICKET-048：`browser_scroll` 按 ref / loc / selector 滚动到元素

状态：✅ 已实现并真机通过（2026-11-27，1.5.9）· 阶段 B1（操作补全）
发现：2026-11-27（阶段 B 第二个能力 `loc=` 落地后的下一项）· 关联：[SPEC-004](../spec/004-capability-admission-spec.md) §6 / [TICKET-045](045-loc-stable-locator.md) / [TICKET-046](046-snapshot-cursor.md) / [TICKET-048 案例](../cases/022-scroll-into-view-cases.md)

## 1. 缺口

`browser_scroll` 只会移动页面：`dy` 像素、`to: top|bottom`、或滚某个 `container`。
于是「把某个元素滚进视口」只剩三条笨路：

1. `browser_snapshot` 反复读，人肉算距离；
2. `browser_eval` 里写 `el.scrollIntoView()`（写动作，要过审批，还绕过了工具契约）；
3. 直接 `browser_click`：动作工具确实会先滚入视口，但那是写动作，且会真的点击。

而模型拿到的 `loc="css:…"` / `ref` 已经是可靠地址，滚动却用不上它。

## 2. 准入四问（SPEC-004 B1）

| 问题 | 回答 |
| --- | --- |
| 读还是写？ | 读。不改变页面数据，不触发 `actionClass`，不需要审批。 |
| 可逆吗？ | 是。只移动滚动条位置，再来一次即可还原。 |
| 失败能否确定「没发出」？ | 是。地址解析在页面内完成，失败即 `bad_loc` / `stale_loc` / `not_found` / `multiple`，`effect:'none'`。 |
| 人机墙 / 接管时能否拦住？ | 可以。`scroll` 仍属 `INPUT_TYPES`（与既有的 `scroll` 一致）：`needs_human` / `taken_over` 下直接拒绝（`needs_human` / `panel_taken_over`），且不改变相位；它不新增例外。 |

## 3. 目标

1. `browser_scroll` 接受 `ref` / `loc` / `selector`（三者互斥），把目标滚进视口；
2. 返回元素 `rect`、`visible`、`fullyVisible`，让模型能判断「到了没」；
3. 旧的 `dy` / `to` / `container` 行为逐字不变；
4. 地址与 `dy` / `to` / `container` 不能混用（混用是用法错误，不是「顺便滚一下」）。

## 4. 实现

### 4.1 页面侧（`plugin/inject/actions.js` `doScroll()`）

- 新增 addressed 分支：地址解析复用 `resolveLoc` / `pickSelector` / `resolve`，优先级 `loc > selector > ref`（与动作工具一致）；
- 解析成功后 `target.scrollIntoView({ block: 'center', inline: 'center' })`（best effort，异常忽略）；
- 返回：`mode:'into-view'`、页面 `x/y/scrollHeight/viewportHeight`、`atBottom`、元素 `rect{x,y,width,height}`、`visible`、`fullyVisible`、`info{tag,role,name}`、`frame`、`loc`；
- `visible` = 与视口相交；`fullyVisible` = 四边都在视口内；`right`/`bottom` 缺失时用 `left+width` / `top+height` 兜底（stub 与手造 rect 也成立）。

### 4.2 工具侧（`plugin/tools.js` `browserScrollTool`）

- parameters 增加 `ref` / `loc` / `selector` / `strict`（原 `dy` / `to` / `container` / `waitMs` 保留）；
- output.schema 增加 `mode`（`into-view` / `by-dy` / `to-edge`）、`matched`、`visible`、`fullyVisible`、`rect`、`info`、`frame`；
- 校验：地址恰好一个；地址与 `dy` / `to` / `container` 不能混用；
- render：地址命中时 `Scrolled button "…" into view at (x, y) W×H — fully in view`；未命中保持旧文案。

### 4.3 客户端

`plugin/client.js` 无需改：`Guest.act` 的参数白名单已含这些字段，`Guest.scroll` 会在 `waitMs` 后重测页面位置并与页面返回合并（不覆盖 `rect` / `info`）。

## 5. 测试

`plugin/test/scroll.test.mjs` 8 例：

- 工具层：`dy` 旧行为与 source 透传；`loc` 映射 `rect` / `visible` / `fullyVisible` / `info` 且 render 含 `into view`；地址与 `dy`/`to` 混用、双地址互斥且零请求；`stale_loc` 透传；
- 页面层：`scrollIntoView` 恰好一次 + 回执；部分可见 → `visible:true` / `fullyVisible:false`；stale loc 不移动页面；`role:button` → `bad_loc`。

全量：309 → **318** 例（`scroll.test.mjs` 8 例 + `bridge.test.mjs` 1 例）。

## 6. 真机验收（2026-11-27，1.5.9）

见 [cases/022](../cases/022-scroll-into-view-cases.md)：`demo/scroll.html` 上按 `loc` 滚到远端按钮（`fully in view`）、按 `ref` 滚回顶部、`dy` 旧行为、`stale_loc`、地址与 `dy` 混用被拒。

## 7. 不做

1. 不做「滚到某坐标」（`x,y` 已由坐标点击覆盖）；
2. 不做无限滚动自动追页（策略问题，不是滚动原语）；
3. 不做 `scrollIntoViewIfNeeded` 的浏览器差异分支（`scrollIntoView` 够用）；
4. 不新增 `browser_scroll_to` 这类新工具名（把能力收进 `browser_scroll` 的参数）。

## 8. 风险

- R1：`scrollIntoView` 在长页面上触发懒加载，页面高度会变——回执里的 `scrollHeight` 是滚动后的快照，不是承诺；
- R2：`loc` / `ref` 失效在滚动里同样存在，复用 `stale_loc` / `stale_ref`，不引入新错误码；
- R3：跨域 iframe 内的元素仍然只能坐标点击（滚动同理），`loc` 带 `f1:` 前缀时走宿主 frame 定位，受既有 iframe 限制。
