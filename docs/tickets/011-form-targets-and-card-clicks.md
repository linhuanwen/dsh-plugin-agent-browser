# TICKET-011 表单新窗口与商品卡命中（1.0.20 → 1.0.22）

> 状态：✅ **已完成并装机（1.0.22，`HOST_REV 24`，2026-11-20）**；`1.0.23` 为纯文档版（把"点了≠页面动了"写进包内 README 的已知限制），无代码改动。
> 来源：`docs/cases/011-task-cases.md` 的 T1 实测暴露的新缺口 ① ②（用户 m02147「先修复问题」）
> 相关：`docs/spec/001-agent-browser-plugin-spec.md` A15、A16；`docs/tickets/009-action-surface-gaps.md`（A15 初版）

## 1. 问题

T1 跑 1688 时，两条"看起来成功、实际什么都没发生"的路径把 A15 的覆盖范围钉出了两个洞：

1. **表单提交进新窗口，点击静默丢失**。1688 首页的搜索表单是 `<form target="_blank" action="//s.1688.com/selloffer/offer_search.htm">`，而搜索按钮**不在表单里**，它的脚本直接 `form.submit()`。
   - 1.0.19 只处理了 `a[target]`：`neutralizeTarget()` 只认 `A` 标签，点击路径根本碰不到那个 form。
   - Chromium 被要求开一个新窗口，而面板没有 `setWindowOpenHandler`，请求被丢掉：工具回 `Clicked button "搜索"`，URL 一动不动。
   - 更隐蔽的是 `form.submit()` **不触发 `submit` 事件**，所以"监听 submit 再改 target"这条路也堵着。
2. **商品卡中心被 hover 工具条占住**。列表卡是一整块 `<a class="offerCard">`，卡中心正是 `hoverActions` 里那个「找相似」`<span>`，它的脚本调 `window.open(similar_search.html…)`。
   - `pickPoint()` 的命中测试把"点到了卡片的后代"当成命中，于是选中的正是那张工具条。
   - `window.open` 被 A15 拦成 `null`，页面没动，工具却回 `Clicked link … target="_blank" was followed in this view` —— **假成功**。

两条的共同病根：**判定"点了"用的是"指针落在元素或其后代上"，而不是"页面真的动了"**。

## 2. 修法（三层）

| 层 | 改动 | 版本 |
| --- | --- | --- |
| `inject/actions.js` `installGuards()` | ① 捕获阶段监听 `submit`，把 `form[target]` 改 `_self`；② 给 `HTMLFormElement.prototype.submit` 打补丁（`proto.__dshSubmit` 幂等），在调用原方法前改 target —— 覆盖"按钮在表单外、脚本直接 `submit()`"这种路径 | 1.0.20 / 1.0.21 |
| `inject/actions.js` `neutralizeTarget()` | 由"只认 `A`"扩到：`A[target]`、`[formtarget]`、最近的 `form[target]`，返回值形如 `_blank` 或 `form _blank`（工具层据此区分 link / form 文案） | 1.0.20 |
| `inject/actions.js` `pickPoint()` | 两趟采样：先找"元素自己接到"的采样点（`hitTest` 新增 `exact`），没有才接受后代；对 `height > 120` 的 `A`（商品卡）改为**先试上沿 15% 区域**——那里是图片，按压会冒泡到链接本身 | 1.0.20 / 1.0.22 |
| `client.js` `click()` + `tools.js` | 需要导航的点击（有 `targetFixed` 或上一轮有 `blockedNewWindow`）在按前记 `location.href`，按后等 350 ms 再读一次，结果带 `navigated:false`；工具文案直说"地址没变，这一下没去任何地方，按的是元素内部某个控件" | 1.0.20 |
| 工具层 render | `targetFixed` 分 link / form 两套说法；`navigated:false` 附一句可执行建议（点图片或标题，或给 x/y） | 1.0.20 |

## 3. 单测（`plugin/test/actions.test.mjs`）

23 → **26 例**，新增：

- `a form target is rewritten too, so a search button actually submits` —— 按钮在 `form[target=_blank]` 里时，点击后 form 变 `_self`、`targetFixed` 含 `form`;
- `a programmatic form.submit() is rewritten too, and fires no submit event` —— 打补丁后 `form.submit()` 仍执行一次、target 已改；
- `card: the element own area wins over an inner overlay covering the centre` —— 中心被后代覆盖时选到卡片自己的区域。

全量：`node --test plugin/test/actions.test.mjs plugin/test/downloads.test.mjs plugin/test/static.test.mjs` = **58 / 58 pass**。

## 4. 真站验收（`https://www.1688.com/`，1.0.22）

| 步骤 | 结果 |
| --- | --- |
| 首页 `browser_type` 入「男士马丁靴」后点搜索按钮 | ✅ 页面跳到 `https://s.1688.com/selloffer/offer_search.htm?keywords=%C4%D0%CA%BF%C2%ED%B6%A1%D1%A5&spm=…`，title「男士马丁靴_男士马丁靴批发_男士马丁靴供应_阿里巴巴」。**1.0.21 起生效** |
| 结果页 `browser_click({selector:'a[class*="offerCard"][href*="724632396590"]'})` | ✅ 落到 `https://detail.1688.com/offer/724632396590.html?spm=…`，title 与卡片标题一致；`window.__dshBlocked` = `[]`（没再去点「找相似」）。**1.0.22 起生效** |
| 1.0.21 在同一张卡上的对照 | ❌ 回 `Clicked link "马丁靴男鞋秋季新款…" at (377, 424).` + `The address did not change: this click did not take us anywhere.`，`__dshBlocked` 里是 `similar_search.html?offerIds=724632396590…` —— 新的诚实提示先于修复出现，正好证明它抓得住这类假成功 |

## 5. 已知残留

- `pickPoint` 的"高卡片先试上沿"是按 1688 的版式推的通用规则，**不是通用解**：卡片若把可点区域放在别处（角标按钮、右下角购物车），仍可能需要显式 `x/y`。`navigated:false` 的文案就是为这种情形准备的。
- `HTMLFormElement.prototype.submit` 补丁对页面自己缓存的 `form.submit` 引用无效（极少见）；`requestSubmit()` 走 `submit` 事件那条路，已覆盖。
- 表单提交成功不再回报 `targetFixed`（改写发生在提交瞬间，晚于点击载荷）；需要时看下一步动作的 URL 变化。
