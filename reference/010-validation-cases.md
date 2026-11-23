# 侧栏 Agent 浏览器：验证案例集（V1–V12）

> 目的：给 `dsh-plugin-agent-browser` 一套**可复跑**的操作能力验证案例。每个案例都写明步骤、判定标准（过/不过怎么算）、以及本次实测结果。
>
> 实测时间：2026-11-20，DSH 侧栏面板 CSS 视口 **575 × 863**，`devicePixelRatio` **1.5**（截图 863 × 1295）。
> 证据截图：`reference/shots/`（`baidu-earth-hangzhou.png`＝V12 主案例、`guangzhou-terrain.png`、`baidu-guangzhou-14z.png`、`baidu-earth-guangzhou.png`＝历史）。
> **V12 是端到端主案例**（用户真实人工路径：搜索框输入「杭州市」→ 右下悬停展开切换模块选「地球」→ 截图 + 识别），其余案例是它的能力分解。

## 0. 覆盖矩阵与结论

| 编号 | 能力维度 | 自动化 | 本次结果 |
|---|---|---|---|
| V1 | 外网 https 首屏 + 截图 | ✅ | 通过（百度地图 canvas 站） |
| **V12** | **端到端：搜索 → 地球视图 → 截图识别** | ✅ | **通过（真实站点、真实路径）** |
| V2 | 工作区本地托管（`path`）+ 相对资源 + fetch | ✅ | 通过 |
| V3 | a11y 快照契约（ref / gen / 计数 / digest） | ✅ | 通过，1 ms / 509 B |
| V4 | ref 点击闭环（状态可见变化） | ✅ | 通过（`hits: 0 → 1`） |
| V5 | 坐标点击打穿 canvas | ✅ | 通过（百度地图 13z → 14z） |
| V6 | 表单 type + submit 跳转 | ✅ | 通过（百度真实搜索框；含 1 个假阴性坑） |
| V7 | 密码框拒填 → `needs_human` | ✅ | 见 V7 |
| V8 | 验证检测 + 人工接管门控 | 🖐 人工 | 见 V8 |
| V9 | 安全边界负向（`file://` / 自身地址） | ✅ | 通过（工具层拒绝） |
| V10 | 截图稳定性 + 窄面板适配 | ✅ | **发现 1 个静默失败** |
| V11 | 跨会话 `keepMounted` / 重启提示 | ✅ | `keepMounted` 过（A11）；重启项 2026-11-23 实测通过——重启后侧栏无残留壳、首次 `browser_open` 一把成功（见 V11 节「实测记录」） |

一条实测事实先摆出来：**百度地图网页版没有「地势图 / 地形图」图层**。对 `map.baidu.com` 全量 DOM 搜 `地势|地形` 命中 0，图层只有 地图 / 地球 / 全景 / 路线 / 路况 / 地铁 / 工具箱。

但用户随后澄清了真实意图（不是要百度出地势图，而是走人工同一条路）：**搜索框输入城市名 → 右下角切换模块选「地球」→ 对地球界面下的城市截图并识别内容**。这条路完全走得通，且「地球」模式在市级缩放下渲染为**卫星影像**，山体阴影、林斑、河网、建成区在影像里比任何"地势图层"都更直白——见 **V12**（端到端主案例，城市按用户要求用**杭州市**，广州那轮作为历史产物保留）。`guangzhou-terrain.png`（OpenTopoMap 晕渲）作为"真地势图"的补充源保留。

### 1.4.13 抽跑（2026-11-23，插件 1.4.13，面板 767×863 @ dpr 1.5）

1.4.13 相对 1.4.12 是**纯文档变更**（25 个文件逐哈希核对，只有 `package/package.json` 与 `package/README.md` 不同），但 1.4.9–1.4.12 动过代码（接管点击 TICKET-032、‹›⟳ 工具栏、`inject/guards.js`、`fitWidth`），所以对 P1 抽跑项做了一次重跑：

| 案例 | 结果 | 证据（1.4.13 实测） |
|---|---|---|
| V2 | ✅ | `browser_open({path:'demo/index.html'})` → `http://127.0.0.1:3177/t/demo/index.html`；快照 `gen 1 · 3 refs · 15 lines · 32 nodes walked · 1ms · 46.2 KB`；三条资源断言全中：`text "Stylesheet loaded:"` + `yes`、`img "a green square"`、`fetch('/data.json'): {"ok":true,"served":"from the workspace","items":[1,2,3]}` |
| V3 | ✅（1 处偏差） | `includeImage:false` 两次 → gen 1→2→3、ref `e1–e3` 稳定、纯文本 **511 B**（含图 46.2 KB = 图片负载）；`maxChars:120` → 末行 `… tree cut at the character budget; scroll or narrow the query and snapshot again.`。**偏差**：纯文本快照没有独立 digest 行，`Image sha256:<64hex>` 只在含图时出现 |
| V4 | ✅ | `browser_click({ref:'e3'})` → `Clicked button "click me" at (65, 294)`；再快照 `paragraph "hits: 1"` |
| V5 | ✅ | 面板宽 767 px，放大按钮 `BMap_button_new BMap_stdMpZoomIn` 中心 **CSS (734,710)**；`browser_click({x:734,y:710})` → 比例尺 `5 公里 → 2 公里`、`@…,12z → @…,13z` |
| V9 | ✅ | `file://` → `scheme_rejected`；`{path:'../outside.txt'}` → `path_escape: … outside the workspace`；`http://127.0.0.1:9522/`（DSH 自身）→ `navigation_failed: nav_aborted: … (ERR_FAILED)` 且面板回到原页（桥日志 `c13` 有 `navigation failed; going back`） |
| V12 | ✅ | 端到端复现，见下 |
| V10 | ❌ 新缺陷 | OpenTopoMap 截图挂死，见「坑 5」与 `tickets/034` |

V12 这次的三处变化值得记：① `browser_type({submit:true})` 现在**真的会重定位**（eval 得 `title: 杭州市 - 百度地图`、`href: …/search/杭州市/@13382475,3514398,12z`）——1.0.19 记录里的"Enter 只改 URL 不飞"陷阱不再复现；② `browser_hover({selector:'#mapType'})` 返回 `The layout changed under the pointer — something expanded.`，提示层已经会报"指针下布局变了"；③ 截图 `screenshots/v12-baidu-earth-hangzhou-1.4.13.png`，**2,079,549 B**，sha256 `fa366f132afbf178a9ca36559103e08f644bf36f706046d5f16bc1470cda2096`，1151×1294。识别命中 16 个标注类地物（良渚古城遗址公园、良渚文化村、兰里景区、东明山森林公园、杭州半山国家森林公园、京杭大运河杭州景区、西溪国家湿地公园、五常湿地公园、西湖风景区、午潮山国家森林公园、铜鉴湖公园、灵山景区、湘湖国家旅游度假区、新沙岛景区、麦田CBD、杭州南站、萧山站）+ 5 个行政区（拱墅 / 西湖 / 上城 / 滨江 / 萧山）+ 影像判读（西南午潮山—灵山深绿林斑与山体影、钱塘江自西南向东北的宽灰白水面、城区灰白高密度建成区与黄色路网、北部平原细碎绿斑）。弹层「下载百度地图 领100元券」占右上角，未影响点击。

### 坑 5（1.4.13 新抓，P1）：大图回执丢失 → 截图静默挂到 60 s 超时

同一批操作里，`browser_open('https://opentopomap.org/#map=10/23.13/113.26')` 后立刻 `browser_screenshot({mode:'viewport'})` **连续两次**返回：

```
Error: bridge_timeout: browser panel did not answer c26 (screenshot) within 60000ms.
Open the right sidebar browser tab for this session and retry. (screenshot step: command)
```

而同页 `browser_snapshot({includeImage:false})` 正常（`gen 1 · 12 refs · 60 nodes · 1ms`）。桥日志显示**取图其实成功了**，只是回执没到：

```
screenshot start {mode:viewport, w:767, h:863, dpr:1.5, vis:visible}
capture start {css:767} → capture got image {device:1151, height:1294}
capture done {sent:1151, chars:4239798}      ← +197 ms 就完成
（之后无任何回执，客户端等到 60 s 超时）
```

对照成功样本：`demo` 62,358 chars、百度地图 2,772,754 chars 都秒回；这次 **4,239,798 chars（约 4 MB）** 卡在回执/传输上。与坑 1（`css:0` 取图失败）**不是同一个 bug**：这次是取图成功、回执丢失，且错误停留 60 s 而不是 ~650 ms 放弃。处置：该站不截图，改用快照；登记 `tickets/034`。

---

## V1 外网 https 首屏 + 截图（canvas 地图站）

**目的**：验证 `browser_open(url)` 能把真实 https 站点装进侧栏、`browser_snapshot` 能同时拿到无障碍树与像素截图——这是"看得见"的最小闭环。

**步骤**

| # | 动作 | 期望 |
|---|---|---|
| 1 | `browser_open('https://map.baidu.com/')` | 侧栏自动展开；返回页标题「百度地图」与最终 URL |
| 2 | `browser_snapshot({includeImage:true})` | 返回树 + 图片；树里有 `textbox "搜地点、查公交、找路线"`、`link "广州市"` |
| 3 | 观察树的形状 | canvas 站点的**地图本体不在树里**（只有页脚链接与工具条文字），符合预期 |

**判定**：第 2 步图片非空且能看到地图形状 = 通过；树里出现地图要素 = 反常（说明该站暴露了 DOM 地图层，坐标用例要重写）。

**实测**：通过。树 `15 refs / 372 nodes walked`，图片 949.5 KB。canvas 本体确实不产生 ref——这正是 V5 必须存在的理由。

**地势图的替代方案**（广州，实测可用）：

- `https://opentopomap.org/#map=10/23.1300/113.2600` → Leaflet + SRTM 晕渲 + 等高线，**广州全域地势**清楚可见（花都/从化山地、番禺/南沙冲积平原、珠江口）。产物：`reference/shots/guangzhou-terrain.png`。
- `https://map.tianditu.gov.cn/` → mapbox-gl 内核，`SwitchMap` 控件里的「地形」+ 勾选「山影」可得晕渲地形；但桌面版布局宽约 1000 px，在 575 px 面板里**横向溢出**，右侧控件 `x>575` 点不到（见 V10 坑 4）。

---

## V2 工作区本地托管（`browser_open({path})`）

**目的**：验证"不碰网络也能给 Agent 一个可操作的页面"，以及相对资源（CSS / 图片 / `fetch`）在被托管的页面里正常。

**步骤**

1. `browser_open({path:'demo/index.html'})` → 期望返回 `http://127.0.0.1:<随机端口>/demo/index.html` 且提示 root 是工作区。
2. `browser_snapshot({includeImage:false})`。
3. 检查三条资源断言。

**判定**（三条全中才算通过）：

- 树里出现 `text "Stylesheet loaded:"` 后的 `text "yes"`；
- 树里出现 `img "a green square"`（相对路径图片被服务到）；
- 树里出现 `fetch('/data.json'): {"ok":true,...}`。

**实测**：通过。端口 `4614`，`3 refs / 15 lines / 32 nodes / 1 ms / 509 B`——本地页快照开销可忽略。

---

## V3 a11y 快照契约

**目的**：固定快照对外承诺的字段，防止后续改动悄悄丢字段。

**步骤**：同一页连续两次 `browser_snapshot({includeImage:false})`。

**判定**

| 断言 | 期望 |
|---|---|
| 表头格式 | `Snapshot gen <n> · <refs> refs · <lines> lines · <nodes> nodes walked · <ms> ms · <bytes> B` |
| `gen` 单调递增 | 第二次 = 第一次 + 1 |
| ref 稳定性 | 未改动页面时 ref 编号不变（`e1`…`eN`） |
| 树可被截断 | 传 `maxChars` 过小时末尾出现 `… tree cut at the character budget` |
| digest | 表头尾有 digest 行，同样输入下可复现 |

**实测**：通过。demo 页两次快照均 `3 refs`；百度地图页 `maxChars:700` 触发截断提示，`maxChars:1500` 正常返回。

> 注意：`gen` 是**快照代数**，不是导航代数——点一次按钮再快照，`gen` 也会 +1（V4 实测 1 → 2）。跨导航时 gen 重置为 1（OpenTopoMap 新页从 gen 1 开始），所以**不能**用 gen 判断"页面是否换过"。

---

## V4 ref 点击闭环

**目的**：验证"树里的 ref → 真输入事件 → 页面状态改变 → 新快照反映"这条链。

**步骤**

1. `browser_open({path:'demo/index.html'})`，快照得到 `button "click me" [ref=e3]`。
2. `browser_click({ref:'e3'})`。
3. 再快照，比对计数段落。

**判定**：`paragraph "hits: 0"` → `"hits: 1"`，且 `browser_click` 返回真实落点坐标（不是 ref 字符串）。

**实测**：通过。返回 `Clicked button "click me" at (65, 334)`；二次快照 `hits: 1`。

---

## V5 坐标点击打穿 canvas（本集核心）

**目的**：验证 spec A6 的原始场景——**canvas 地图上没有任何 ref，只能靠坐标 `sendInputEvent`**。项目此前把 A6 降级成本地 canvas 夹具，本案例把它恢复到真站点。

**步骤**

1. `browser_open('https://map.baidu.com/')`，等地图渲染。
2. `browser_eval` 读控件矩形（见下），拿到放大按钮中心 **CSS 坐标**。
3. `browser_click({x, y})`。
4. `browser_eval` 读 `.BMap_scaleTxt` 与 `location.href` 复核。

```js
// 读控件矩形：把"看不见的按钮"变成可点的坐标
[...document.querySelectorAll('[class*="zoom" i],[title*="放大"],[title*="缩小"]')]
  .map(e => { const r = e.getBoundingClientRect();
    return { c:(e.className||'').toString().slice(0,34), t:e.title||e.textContent,
             x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2) } });
```

**判定**（任一独立信号变化即可，两个都变最稳）：

- 比例尺文本变化：`2 公里` → `1 公里`；
- URL 里的缩放级别变化：`…,13z` → `…,14z`。

**实测**：通过。控件 `BMap_button_new BMap_stdMpZoomIn`（title=`放大一级`）位于 **CSS (542, 710)**；点击后比例尺 `2 公里 → 1 公里`，URL `@12613701,2624420,14z`。截图：`reference/shots/baidu-guangzhou-14z.png`。

**坑（本案例的隐藏成本）**：

- 图片坐标 ≠ CSS 坐标，必须除以 `devicePixelRatio`（本机 1.5）。893 px 处的按钮在 CSS 里是 595 处——直接按图片像素点会点到隔壁。
- 同一坐标在弹层出现时会命中弹层。本集实测中 (542, 685) 命中的是"定位您的位置"按钮，弹出地理位置授权，把整块地图挡住。

---

## V6 表单 type + submit 跳转

**目的**：验证文本输入走真实键盘输入（含 `submit:true` 回车提交），且写值后页面能跳转。

**步骤**

1. 打开带表单的夹具（`tools/testsite.mjs` 的 `/form`）。
2. `browser_snapshot` 取输入框 ref。
3. `browser_type({ref, text:'...', submit:true})`。
4. 再快照，断言 URL 与回显文本。

**判定**：URL 变化且新页面回显所填内容；`browser_type` 返回值里带写值方式（键盘 / 设值）说明。

**实测（夹具）**：本次未跑（夹具需 `node tools/testsite.mjs` 起服务）。`reference/009-spec-audit.md` 的 A5 记录为通过，带一个实现偏差：密码框拒绝时返回**工具级错误 `needs_human`**，不切换相位机。

**实测（百度地图真实搜索框，推荐口径）**：通过，但踩到**假阴性**。

| # | 动作 | 结果 |
|---|---|---|
| 1 | `browser_type({ref:'e11', text:'广州市', submit:true})` | 工具返回 `Typed 3 characters into textbox "搜地点、查公交、找路线" and pressed Enter.`；**URL / title 均未变**（仍「百度地图」）→ 看起来像失败 |
| 2 | `browser_click({ref:'e12'})`（蓝色搜索按钮） | 跳 `https://map.baidu.com/search/广州市/@12609455,2631454,12z?...`，title「广州市 - 百度地图」 |
| 3 | `browser_type({ref:'e11', text:'深圳市', submit:true})` | 直接跳 `search/深圳市/...`，title「深圳市 - 百度地图」→ **submit 其实一直是好的** |
| 4 | 手动 `focus('#sole-input')` 后 `browser_press('Enter')` | 同样不跳——因为查询词没变，URL 自然不变 |

**结论与判定口径修正**：第 1 步的"没跳转"不是 bug，是**同词重复搜索不产生可观测状态变化**。所以

- 判 submit 必须用**与当前内容不同的查询词**（否则必然假阴性，把好工具判成坏工具）；
- 提交成功的**独立信号**优先看 `document.title`（`<query> - 百度地图`）或 URL path 里的 `search/<query>`，不要只看 URL 是否变化；
- `e11` 输入 + `e12` 点击 与 `e11` + `submit:true` 两条路都通，用例应至少覆盖其中一条**真实路径**，纯夹具不算过关。

---

## V7 密码框拒填（安全边界，正向拒绝）

**目的**：确认"密码永不进入模型上下文"这条硬约束在动作层生效。

**步骤**

1. 快照含密码框的页面（`/form` 夹具）。
2. 对该 ref 调 `browser_type({ref, text:'secret'})`。

**判定**：返回 `needs_human` 类错误，页面未被写入，模型侧看不到任何密码字符；随后普通输入工具**仍可用**（只拒该字段，不锁全局）。

**实测**：见 A5 审计记录（通过，行为按修正后的契约）。

---

## V8 验证检测 + 人工接管门控（人工）

**目的**：验证"检测到验证 → 暂停 → 用户接管 → 交还"这条产品级硬边界。插件不做过验证，只做交接。

**步骤**

1. 打开验证夹具（`/frames` + 三类信号：URL / 标题 / DOM 文案）。
2. `browser_snapshot` → 断言 `needs_human: true` + 琥珀徽章 + 页面内红框 + `hint` 文案。
3. `browser_click`（任意 ref）→ 断言被拒（**读继续可用、写被拒**）。
4. 用户点「我来接管」→ Agent 侧任一动作返回 `taken_over`。
5. 用户在面板里操作 → 点「交还」→ Agent 恢复，**页面未刷新**（状态保留）。

**判定**：第 3、4 步的拒绝必须是**结构化错误码**（`needs_human` / `taken_over`），不是笼统失败；第 5 步后 `keepMounted` 保证页面状态还在。

**实测**：见 `reference/006-takeover.md`（A7/A8 通过，用户亲手接管过两轮）。**本次未重跑**——涉及人工点击，无法脚本化。

---

## V9 安全边界负向（越界必须被拒）

**目的**：确认三类"本不该打开"的目标都被拦，且**错误信息可读**。

| # | 目标 | 期望 | 实测 |
|---|---|---|---|
| 1 | `file:///C:/Windows/win.ini` | 工具层拒绝，明确说是协议问题 | ✅ `only http(s) URLs are allowed, got file:` |
| 2 | DSH 自身地址 `http://127.0.0.1:8738` | 主进程 `ERR_FAILED` 拒绝 | 见 A10（通过） |
| 3 | 工作区外的 `path`（`../`、UNC、NUL） | 静态服务双闸拦截 | 见 `plugin/test/static.test.mjs`（14 例全绿） |

**判定**：拒绝发生在**打开之前**，面板保持原页面不跳转（本次实测：拒绝后面板仍停在 OpenTopoMap，未被清空）。

---

## V10 截图稳定性 + 窄面板适配（本次抓到 bug）

**目的**：截图是"看得见"的另一半，但它是唯一依赖 GPU 合成帧的环节，最容易静默降级。

### 坑 1（bug 候选）：刚挂载 / 刚导航后快照可能拿不到截图，且**没有任何提示**

**复现**：`browser_open` 到一个新页面后立刻 `browser_snapshot({includeImage:true})`，连续两次。

**现象**：返回树完整，但**没有图片**，也没有任何解释文字；**实测连续 2 次**都拿不到图，第三次（约 1 分钟后）才正常出图。

**根因**（bridge 日志 `/dsh-agent-browser/logs` 实锤）：

```
"capture start"  {"css":0}
"capture retry"  {"delay":0,   "reason":"... UnknownVizError"}
"capture retry"  {"delay":250, "reason":"... UnknownVizError"}
"capture retry"  {"delay":400, "reason":"... UnknownVizError"}
"capture failed" {"error":"... UnknownVizError"}
```

两件事叠加：

1. `css: 0` —— 取图瞬间面板元素的 `getBoundingClientRect().width` 为 0（挂载后还没拿到布局），guest 没有可视帧，`capturePage()` 抛 `UnknownVizError`；
2. 重试预算只有 `0 / 250 / 400 ms`（合计 ~650 ms），落后的机关枪式重试打完就放弃。

**修法建议**（任选其一，建议 1+3）：

1. 把重试预算改成指数退避到 ~2 s，并在 `css === 0` 时先等一帧布局（`requestAnimationFrame` 两次或 `ResizeObserver` 观测到宽 > 0）再取图；
2. `"capture failed"` 时**不要静默**——在返回文本里补一行"本次未取到截图（面板尚未绘制），可稍后重试"；现在这条提示只在 `saveScreenshot` 失败时才会出现（`plugin/tools.js:280-284`），取图失败路径完全没有；
3. 面板不可见/尺寸为 0 时直接跳过取图并说明，别浪费 650 ms。

### 坑 2：窄面板下桌面站点横向溢出

天地图在 575 px 面板里布局宽 ~1000 px，右侧图层控件坐标 `x≈953`（> 视口 575），**点不到也截不到**（截图只覆盖视口）。判定标准应写成：**控件中心点的 CSS 坐标必须落在 `0 ≤ x < innerWidth`**，否则该用例只能用 `browser_eval` 驱动。

### 坑 3：弹层吞掉坐标点击

百度地图首屏就有两个弹层（地理位置授权、打车券广告），都会盖住画布；坐标点击会先命中弹层。用例里必须先执行"关弹层"步骤（按文本点「取消」/「×」），并在判定前复核目标元素仍在原位。

### 坑 4：dpr 换算

截图 863 × 1295 = CSS 575 × 863 × **1.5**。写坐标用例时一律以 `getBoundingClientRect()` 的 CSS 值为准，不要从截图量像素。

---

## V11 跨会话存活 / 重启提示（A11 + A12，✅ 已通过）

- **`keepMounted`**：切到别的会话再切回，页面与页面内状态（如 `hits` 计数）应保留——`reference/009` 记录为通过（A11）。
- **重启**：重启应用后 tab 壳还在，但**不假装恢复**页面，应提示"重新打开"（spec A12）。

### 重启检查清单（2026-11-23 交接，当天已执行 ✅）

一次完整重启可同时覆盖 A12 与 V11 的重启项，按下面四步做一遍即可（执行记录见下一节「重启实测记录」）。

| # | 在哪里做 | 动作 | 期望 / 要记的 |
|---|---|---|---|
| 1 | 本会话（重启前） | `browser_open https://example.com/` 让页签处于打开状态；跑 `node tmp/browser-health.mjs 127.0.0.1:9522`，记下 `port`（当前为 12125） | 页签可见；桥端口有记录，供第 4 步比对 |
| 2 | 系统 | **完全退出** DSH（托盘退出或任务管理器确认进程已结束，不是刷新窗口），再重新打开 | — |
| 3 | 重启后，先别点任何东西 | 打开本工作区的会话，看右侧栏 | **A12**：不残留「浏览器」页签或空白壳（残留就记下它显示什么：标题 / 空白 /"重新打开"按钮）。**V11**：若保留 tab 壳，必须*不假装恢复*页面，应提示"重新打开"，不得出现上一轮的 example.com 内容 |
| 4 | 本会话（重启后） | 调一次 `browser_open https://example.com/`，再跑一次 `browser-health.mjs` | 自动拉起新页签且打开成功；桥端口与第 1 步**不同**（插件随宿主重建），`tools=11 registered=11` |

补充说明：

- 第 4 步若首次调用报 `panel_not_open`，**重试一次**再判定（G3 记录里就有"面板刚打开时首次调用失败、2 s 后重试成功"的先例），两次都失败才算不通过；本次一把成功，未触发。
- 这条清单不涉及配置改动，无需 `patch-tool`；跑之前确认 `patch-tool check` 是 `hasBlock=false`。

### 重启实测记录（2026-11-23 16:1x，插件 1.4.13，宿主 127.0.0.1:9522 → 9515）✅

| # | 实测 | 结论 |
|---|---|---|
| 1 | 重启前 `/health`：桥 **12125**，`clients:1`、`states:[session-e32e610d…]` | 基线：重启前确实有一次活动中的面板 |
| 2 | 完全退出 DSH 后重开，宿主 **http://127.0.0.1:9515**，桥 **9516**（换了端口 ⇒ 插件实例确系重建）；`/health` → `clients:0`、`seen:[]`、`states:[]`、`enqueued:0`、`pulled:0`、`logs:4` | 插件侧**没有**恢复任何页面/会话状态：不假装恢复，页面与名额都从零开始 |
| 3 | 用户目视（重启后、任何工具调用之前）：右侧栏**没有**「浏览器」页签或空白壳 | A12 的"不残留壳"符合 |
| 4 | 首次 `browser_open https://example.com/` → `Opened https://example.com/ — Example Domain`，**一次成功、无 `panel_not_open`** | V11 重启项的自动拉起成立；G3 那次"首次调用失败需重试"未复现 |
| 5 | 随后 `/health`：`clients:1`、`enqueued:1`、`pulled:1`、`states:[{id:"session-e32e610d-cec7-44b8-98bd-d8d7bc6b9551", phase:"agent"}]`、`tools:11 registered:11 conflicts:[]` | 面板按需新建、只挂一个会话；工具面完整 |

留证：`screenshots/v11-restart-after-open.png`（重启后首次打开 example.com 的面板视图，86.7 KB）。

---

## V12 端到端主案例：搜索「杭州市」→ 地球视图 → 截图并识别

**为什么它是主案例**：这条路径就是用户的人工操作原样——"在百度地图页面中的搜索框里输入城市，然后网页右下角有个切换模块，分别可以选地图、全景、地球，我实际上需求的是地球界面下的截图识别"。它一次性串起 V1（外网首屏）、V5/V6（真实输入）、V10（截图）、以及**模型侧视觉识别**这条最容易被忽略的验收项。城市按用户 2026-11-20 的要求改为**杭州市**（此前一轮用广州市，产物保留为历史）。

**步骤与实测（1.0.19，2026-11-20）**

| # | 动作 | 期望 | 实测 |
|---|---|---|---|
| 1 | `browser_open('https://map.baidu.com/')` | 面板出现「百度地图」 | ✅ |
| 2 | `browser_type({ref:'e11', text:'杭州市', submit:true})` | title 变「杭州市 - 百度地图」 | ⚠️ 只改了 URL 与标题（path `search/杭州市`），**地图中心与缩放没动，画面仍是上一座城市** |
| 3 | `browser_click({ref:'e12'})`（搜索按钮） | 地图真正飞到杭州 | ✅ URL 变 `@13382474.999,3514398.008,11.85z`，比例尺 5 公里 |
| 4 | `browser_hover({selector:'#mapType'})` → `browser_click({selector:'.mapTypeCard.normal'})` | 回到街道图（清掉上一轮残留的 `maptype`） | ✅ `mapTypeCard normal active`，URL 里 `maptype` 消失 |
| 5 | `browser_hover({selector:'#mapType'})` → `browser_click({selector:'.mapTypeCard.earth'})` | 进入地球/卫星模式 | ✅ `mapTypeCard earth active`，URL 追加 `maptype=B_EARTH_MAP`，11.7z |
| 6 | `browser_snapshot({includeImage:true})` | 拿到 863×1295 截图 | ✅ **2,029,006 B** |
| 7 | **识别截图内容** | 说出可核对的地名/地物 + 地势判读 | ✅ 见下 |

> **新发现的判定陷阱（1.0.19 实测）：Enter 提交 ≠ 重定位。** 第 2 步 `submit:true` 只把 URL 改成 `search/<词>`、标题改掉，**地图不动**——截图里还是上一座城市。所以"搜索成功"不能只看 title/path，要看 URL 里的 `@<x>,<y>,<z>z` 是否变化，或者干脆看图上地名换没换。第 3 步点搜索按钮才真正飞过去。V6 那条"同词重复搜索 URL 不变"是另一个方向的假阴性，两者合起来才是完整口径：**判搜索生效 = `@center,zoom` 变化 ∨ 图上地名变化**。

> **第 5 步为什么必须两步（hover 再 click）**：右下角是 3D 卡片堆叠，三张卡 `86 × 60`，初始 x = 349 / 354 / 359、z = 1/2/3，**地球卡只露 5 px 左缘**，直接 `browser_click({selector:'.mapTypeCard.earth'})` 会如实报 `Error: selector ".mapTypeCard.earth" is covered by div "全景", so a click would land on that instead.`（九点采样全部落在"全景"卡上）。悬停容器后三张卡展开到 x = 167 / 263 / 359，再点即可。若悬停后仍重叠，说明该站用的不是 hover 机制，**如实记"未支持"并报告，不得用 eval 点击凑判定**。

**第 7 步的识别（可核对清单，出图即判）**

- **标注类地物**（直接读图上的字）：杭州西站、杭州南站、临平南站、海宁西站、西湖风景区、西溪国家湿地公园、午潮山国家森林公园、铜鉴湖公园、湘湖国家旅游度假区、新沙岛景区、良渚古城遗址公园、良渚文化村、东明山森林公园、麦田 CBD、半山国家森林公园。
- **行政区标注**：余杭区、临平区、拱墅区、西湖区、上城区、滨江区、萧山区。
- **影像判读**（地势/水系，图上没有字，靠灰度与纹理）：
  - 西南 / 西侧（午潮山—西山一带）**深绿色连片林斑 + 山体阴影**，走向东北—西南，是天目山余脉的低山丘陵；
  - 中部上城 / 拱墅 / 西湖为**灰白高密度建成区**连片，路网呈黄白色密网；
  - **钱塘江**以宽阔的灰白水面自西南向东北穿过，江面明显宽于城区内河，东侧为萧山平原；
  - 北部余杭—良渚—临平一带是**平原农田与建设用地交错**，绿斑细碎、没有连片山体；
  - 东南部（萧山南部—湘湖）再次出现成片林斑，与西南山地呼应。
- **图上的高速/快速路**：长深高速（G25）、沪昆高速、杭长（宜）高速、上塘高架、秋石高架路、德胜快速路、钱塘快速路、机场公路（S4）、彩虹快速路。

**判定**：截图非空且尺寸 863×1295；URL 含 `search/杭州市` 且含 `maptype=B_EARTH_MAP`；识别结果**至少命中 3 个标注类地物 + 1 条影像判读**（地势或水系）。只说"这是一张地图"= 不过。

**边界**：地球模式在 **11.7z** 渲染的是**卫星影像**，不是从太空看的地球仪；真正的 3D 地球仪要缩到很低层级（约 4z 以下）。所以"地球界面下的城市截图"= 卫星影像，这是正常结果，不是没切成功。

**产物**：`reference/shots/baidu-earth-hangzhou.png`（2,029,006 B，sha256 `187f6584…c83b597`）。历史：`reference/shots/baidu-earth-guangzhou.png`（广州市，1,804,238 B）。

---

## 附：本次暴露的工具缺口

| 缺口 | 影响 | 变通 |
|---|---|---|
| 无**拖拽**原语（只有单点 click） | 地图平移、滑块、拖拽排序类用例做不了 | `browser_eval` 合成 pointer 序列，或多次点击（精度差） |
| 无**滚轮**原语 | 地图滚轮缩放（页面滚动已由 `browser_scroll` 覆盖，1.0.14） | `browser_scroll` 只能程序化滚动，不产生 wheel 事件；地图仍只能点 +/- |
| 截图失败**静默** | 模型以为拿到了图，其实没有（V10 坑 1） | 判 `result.image` 是否存在；必要时重试快照 |
| 无 `screenshot()` 独立工具 | 只要图不要树时也必须走快照（付树的开销） | `includeImage:false` 只关图，不能只出图 |
| `frame` 用例缺少坐标偏移口径文档 | 跨域 iframe 内坐标计算易错 | 以 `reference/005` 的帧偏移记录为准 |
| ~~无**语义点击**原语~~ **已上线（1.0.14）** | 卡片堆叠/图标按钮这类"有 DOM 无 ref 且位置相近"的控件，现在可用 `browser_click({selector})`（失败会给 `not_found`/`multiple`/`occluded`/`disabled` 分型） | 只露几像素的叠卡仍点不到 → `tickets/010`（`browser_hover`） |
| ~~无 **hover** 原语~~ **已上线（1.0.19）** | `browser_hover({ref\|selector\|x,y})` 发真实指针移动，返回落点与 `grew`；百度叠卡实测：悬停 `#mapType` 展开后点地球卡成功 | 直接悬停"被整块盖住的那张卡"仍报 `occluded`——要先悬停容器/模块 |

## 复跑清单（10 分钟版）

```text
1) browser_open({path:'demo/index.html'})            → V2 + V3
2) browser_click({ref:'e3'}) + snapshot              → V4（hits 0→1）
3) browser_open({url:'file:///C:/Windows/win.ini'})  → V9（必须被拒）
4) browser_open({url:'https://map.baidu.com/'})      → V1
5) eval 读 zoom 按钮矩形 → click(x,y) → eval 读比例尺 → V5（2 公里→1 公里）
6) 同上但**导航后立刻**连拍两次快照                    → V10 坑 1（应能复现"无图"）
7) browser_open({url:'https://opentopomap.org/#map=10/23.13/113.26'}) → 出截图存证
8) 百度：type('杭州市',submit) → **点 e12**（Enter 只改 URL 不重定位）→ hover('#mapType') → click('.mapTypeCard.normal')（可选，回到街道图）→ hover('#mapType') → click('.mapTypeCard.earth') → 快照 → 识别   → V12（主案例）
9) browser_open({path:'demo/ticket-009.html'}) → click({selector:'#covered'})→occluded；close 浮层→click 成功；scroll to bottom ×4→fx.items 200；click({selector:'#pop'})→下一次动作带 blockedNewWindow → 动作面回归（TICKET-009）
10) 附件一律不点、直接下：article → browser_download({url:'…/102fb615…pdf'}) → 回 path/bytes/sha256 → A14 回归（点链接是黑洞，见 T7）
```

判定口径统一为：**树 + 图 + 可复核的独立信号**（URL / 文本 / 比例尺）三者之二变化，才算这条能力真的通了；V12 再加一条**识别**口径（3 个标注类地物 + 1 条影像判读）。
