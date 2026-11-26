# TICKET-050：浏览器面板的标签页（tabs）

**状态**：✅ 已实现并真机通过（2026-11-27，1.5.12；1.5.11 为内部构建）· 阶段 B3（面板能力）
**发现**：2026-11-27（阶段 B 第三个能力；用户 m05908 批准）
**关联**：SPEC-004 §4 B3（面板能力）、TICKET-013（导航失败回滚）、TICKET-046（快照 cursor）、`docs/cases/024`

## 1. 缺口

面板从 1.4.x 起只有**一页**：`browser_open` 总是在同一个 webview 里导航。真实工作的很多环节需要两页同时活着：

- 列表页与详情页对照（点进第三条，再回列表点第五条）；
- 填到一半的表单不能丢（打开文档/搜索结果看一眼，回来继续填）；
- 两个候选站点比较（同一登录态下 A/B 两页）。

现在只能「开 A → 记住信息 → 开 B → 再开回 A」，开回去意味着页面状态（滚动、表单、SPA 路由）全丢，而 agent 的上下文里还得自己保存「刚才 A 页长什么样」。

## 2. 准入四问（SPEC-004 B1）

| 问题 | 回答 |
|---|---|
| 读还是写？ | 面板控制，不是页内动作：`list` / `switch` 纯读；`close` 只销毁面板里的一个 webview（会丢该页未保存的页面状态，但没有页内副作用、不向站点发请求），因此不新增 `actionClass`、不弹站内确认条。 |
| 可逆吗？ | `switch` 完全可逆；`close` 对页面状态不可逆，但可以用 `browser_open` 重新打开，且不会静默丢用户的页面——关闭必须显式给出 tab id。 |
| 失败能否确定「没执行」？ | 能：`list` / `switch` 是本地判定；`close` 在找不到 id 时报 `tab_not_found` 且什么都没关。 |
| 人机墙 / 接管时能否拦住？ | `list` 始终可用（agent 需要知道面板里有什么）；`switch` / `close` 在 `taken_over` 与 `needs_human` 下被拒绝（用户正在看的那一页不能被 agent 换走，验证墙也不能被藏起来）。 |

## 3. 设计

### 3.1 面板侧（`plugin/client.js`，`CLIENT_REV` 55 → 56）

- 新增 `TabStore`：一个 session 一份，持有 `[{ id, guest, slot, title, url }]` 与 `activeId`；
- 每个 tab 一个 `Guest`、一个 `slot`（`position:absolute;inset:0`，非活动 `display:none`）。`Guest` 原样复用：每个 `Guest.mount()` 自己 `acquire` 一份租约，同一 workspace 的 partition 由宿主复用，所以**同一登录态跨标签共享**；
- 第一个 tab 在面板挂载时创建（行为与 1.4.x 单页一致，`about:blank`）；后续 tab 由 `browser_open({ newTab:true })` 或面板「＋」按钮创建；
- 命令路由：`tabs` 命令交给 `runTabCommand`；`open` + `newTab` 先建 tab 再走原来的 open 分支；其余命令全部落到**活动 tab** 的 guest（工具暂不逐个加 `tab` 参数）；
- 关闭最后一个标签 → 先建一个空白新标签再销毁旧的（面板永远至少有一页）；
- 上限 `MAX_TABS = 6`，超了报 `tab_limit`；
- 面板顶部新增标签条：标题（页面 `title`，缺省用地址/`新标签页`）、活动高亮、`×` 关闭、`＋` 新标签页并聚焦地址栏；
- 每 tab 自己的 `title`：`Guest` 增 `onTitle` 钩子（`page-title-updated` / `did-stop-loading` 时读 `getTitle()`）；`Guest.tabId` 由 store 赋值，供导航回滚的「上一页」按 tab 记忆（1.5.10 之前按 session 记，多标签会串）。

### 3.2 宿主工具（`plugin/tools.js`，工具 13 → 14）

- `browser_open` 增加 `newTab: boolean`（默认 `false`，旧行为不变），透传给客户端 `open` 命令；
- 新增 `browser_tabs({ action: 'list' | 'switch' | 'close', tab })`：`list` 返回 `[{id,title,url,active}]`，`switch` / `close` 必须给 `tab`；命令走桥的 `tabs` 类型（本地处理，不 eval 页面）；
- 错误码 19 → 21：`tab_not_found`（可重试，hint 先 `browser_tabs list`）、`tab_limit`（不可重试，hint 关一个再开）。

### 3.3 桥（`plugin/bridge.js`）

- `tabs` 加进 `READ_TYPES`：它不碰页面，不能因为列个标签就把 `taken_over` / `needs_human` 抢回 `agent`；
- `#assert` 对 `tabs` 的 `switch` / `close` 单独判人工相位（`list` 放行），错误文案沿用 `panel_taken_over` / `needs_human`；
- `tabs` 不进 `WRITE_TYPES`：没有页内 effect，超时就是「没执行」。

## 4. 验收

- [x] `browser_open({ url, newTab:true })` 在面板里开第二个标签，第一个标签的页面状态保留；
- [x] `browser_tabs({action:'list'})` 看到两个标签，第二个是 active；
- [x] `browser_tabs({action:'switch', tab:'t1'})` 切回，`browser_snapshot` 读到的是第一个页面的内容；
- [x] 在 t1 上点一个链接，t2 的页面不受影响；切回 t2 仍是原页面；
- [x] `browser_tabs({action:'close', tab:'t2'})` 关闭后 `list` 只剩一个；关闭不存在的 id 报 `tab_not_found`；
- [x] 关闭最后一个标签后仍有一个空白标签可用（且标题显示「新标签页」而不是 `about:blank#…`）；
- [x] `list` / `switch` 显示真实 URL（回答前按需 `getURL()`，不依赖创建时的缓存）；
- [x] 人工相位（接管/验证墙）下 `list` 可用、`switch`/`close` 被拒；
- [x] 单测：tab 工具层 + open 的 `newTab` 透传 + 计数 13 → 14；全量 327 → 335；
- [x] `node tools/check-docs.mjs` 全绿；两份 README 工具数与错误码数同步。

## 4.1 真机证据（2026-11-27，1.5.12）

原文命令与回执见 `docs/cases/024-tabs-cases.md`：开两张标签 → `list` 标题/URL/活动标记正确 → 在 `t2` 点击后 console 尾巴照常出现 → `switch t1` 看到 wait 页自己的状态、`switch t2` 后点击计数仍在（切换不重载）→ `close t2` 剩一张 → `close t1` 先建空白页（`* t3: 新标签页`）→ `switch t9` 报 `tab_not_found` → 6 张后再开报 `tab_limit` → 清理回一张空白页。人工相位下 `list` 放行、`switch`/`close` 被拒由 `plugin/test/tabs.test.mjs` 的真实 `Bridge` 用例覆盖。

验收期修掉两处显示层问题：① `TabStore` 建标签时缓存的 URL 不随导航更新（改为 `refreshUrls()` 按需读）；② Electron 对无标题页的 `getTitle()` 返回 `about:blank#<lease>`，把空白页标题污染成 UUID（`noteTitle` 过滤 + `snapshot()` 兜底）。另记一条环境坑：web shell 会缓存已执行的客户端 bundle，同版本重装不换代码，**改客户端后要完整重启 DSH 才可靠**（见 `docs/cases/024` §3.3）。

## 5. 不做

- 不做每个页面工具都带 `tab` 参数：v1 只驱动活动标签，需要并行时由 agent 先 `switch`；
- 不做拖拽排序 / 标签持久化 / 标签恢复：面板重建（切 session、重载）后标签是新的空白页；
- 不做标签级独立缩放：缩放仍按 session 记忆（切标签沿用同一比例）；
- 不做 `window.open` 自动建标签：页面弹窗仍按 TICKET-032/033 的同视图导航与拦截规则处理。
