# TICKET-041：JS 弹窗（alert/confirm/prompt/beforeunload）会卡死页面

- 状态：✅ 已实现并真机通过（2026-11-26，1.5.3；`record` 模式，`off` 模式真机对照等 TICKET-040 结案后补）P1（阶段 A2，见 `docs/spec/004-capability-admission-spec.md` §6）
- 发现：2026-11-26（全仓 grep 无任何 dialog/alert/confirm/beforeunload 处理）
- 关联：`docs/spec/004-capability-admission-spec.md` §6 A2、§4 B1、`docs/spec/003-first-touch-approval-spec.md`（写动作分类）、`docs/tickets/004-action-tools.md`（动作面）

## 实现（2026-11-26，方案 A）

- `plugin/inject/guards.js`（rev 2→3）：`dshGuards(driver, options)` 接收 `dialogs` 策略；`installDialogs()` 保存原生 `alert/confirm/prompt`，`record` 模式下分别返回 `undefined` / `false` / `null` 并把 `{kind, message(≤300 字), at}` 推进 `window.__dshDialogs`（最多 20 条）；`off` 模式调用原生函数。`install()` 末尾安装。
- `plugin/client.js`（CLIENT_REV 48→49→50）：`dialogsMode()` 读 `GET /config` 的 `values.dialogs.mode`（失败回 `record`）；`injectGuards` 把模式作为第二参数注入；`Guest.readDialogs()` 读取并清空 `window.__dshDialogs`（取最后 5 条，格式 `kind: message`）；`runCommand` 在 `open/snapshot/click/type/press/eval` 结果上附 `dialogs`。→ 真机冒烟发现 `readDialogs` 把数组 `JSON.stringify` 后再交给会 JSON 解码一次的 `evaluate`，二次解析失败并静默吞掉记录；改成直接返回数组（CLIENT_REV 49→50）。
- `plugin/tools.js`：`ACTION_OUTPUT` 与 snapshot schema 增 `dialogs`；`withDialogs()`/`dialogNote()` 统一把弹窗写进工具卡片（`blocked dialogs (answered conservatively; the page kept running):`）。
- 配置面：`dialogs.mode`（`record` 默认 / `off`）——`config.js` DEFAULTS+normalizeConfig、`index.js` Config、`apply.js` CONFIG_FIELDS+snapshotConfig（HOST_REV 36→37）、用户 README YAML+字段表+「JS 弹窗」小节+故障排查行。
- 夹具：`demo/dialogs.html`（alert/confirm/prompt/提交前 confirm 四类按钮，页面内记录返回值）。
- 测试：`plugin/test/guards.test.mjs` 7→12 例（三种弹窗记录与返回值、off 调原生、20 条上限与 300 字截断）；`config.test.mjs` 10→12 例；全量 245→251 全绿，check-docs 全绿（配置 21 字段、YAML 13 顶层）。

## 已知未覆盖

- `beforeunload` 仍未处理（原方案 C 依赖 guest `webContents`，与 iframe 探针同类；先只记录、不自动放行 —— 见下方 R3 与 U4）。
- 注入发生在 `dom-ready` 后：内联脚本在文档解析期弹的窗抓不到（U2）；恢复原生 `off` 模式下页面依旧会被弹窗冻结。

## 现象

页面里的阻塞式弹窗目前**完全没有处理**：

| 弹窗 | 现在的行为 | 后果 |
|---|---|---|
| `alert(msg)` | 页面线程阻塞，OS 模态框挂在 DSH 窗口上 | `executeJavaScript` 调用挂起 → 所有工具（snapshot/click/type/eval）超时；用户不点掉就一直卡 |
| `confirm(msg)` | 同上 | agent 既看不到「在问什么」，也无法回答 |
| `prompt(msg)` | 同上 | 同上，且涉及输入文本（写动作） |
| `beforeunload` | 导航/重载被拦 | `browser_open`/导航命令返回 `navigation_failed` 或静默无效，用户看不到「页面在留人」 |

`plugin/` 现有代码对以上四类**零处理**（`grep -i "dialog\|alert\|confirm\|beforeunload" plugin/` 只命中注释与无关变量）。这是「共用浏览器」在真实站点上一定会撞到的长尾：后台管理系统、老站点、退出确认页大量使用 `confirm`/`beforeunload`。

## 目标

1. 弹窗出现时，工具**不挂死**：在可控时间内返回一个明确结果（而不是 20s 超时）。
2. agent 能**看见**弹窗内容（类型 + 文本），并决定怎么处置（而不是只能等用户）。
3. 用户的接管权不变：`taken_over`/`needs_human` 相位下，弹窗处理同样要让位。
4. 默认保守：**记录并拦截**（不自动点确定），把决定权交回 agent/用户。

## 设计草案

### 3.1 机制选型（先做探针，见 §4）

按优先级尝试：

1. **A. 注入层 hook**（现有架构内）：在 `plugin/inject/guards.js` 里 patch `window.alert/confirm/prompt`，把弹窗「非阻塞化」：记录 `{kind, message, at}`，`alert` 直接返回、`confirm` 返回 false（拦截）、`prompt` 返回 null；同时清空调用栈副作用。**优点**：零宿主依赖；**缺点**：注入在 `dom-ready` 后，页面脚本执行之前就弹的窗抓不到（例如内联 `<script>alert(1)</script>`）。
2. **B. `<webview>` 的 `preload`**：webview 支持 `preload` 属性的话，可在页面脚本前挂 hook（解决 A 的时序缺口）。**待探针**：DSH 宿主 `will-attach-webview` 是否允许第三方 `preload`（`lib/main.js` 有 `will-attach-webview` 校验 src/partition，需读是否拦 `preload`）。
3. **C. 宿主侧 `will-prevent-unload`**：处理 `beforeunload`。webview 的 guest `webContents` 在主进程里有 `will-prevent-unload` 事件，但插件 host 半能否拿到 guest webContents 需探针（与 iframe 探针同类问题）。
4. **D. 兜底**：以上都拿不到时，命令超时后返回 `needs_human` 并把「疑似弹窗」写进 hint（明确告诉用户「页面在等一个原生弹窗，请到面板点掉」）。

### 3.2 结果契约

- 弹窗被拦截时：`browser_eval`/`browser_click` 等动作照常执行到底，但在结构化结果里附 `dialogs: [{kind, message, at}]`（上限 5 条，去重）；`browser_snapshot` 的检测结果里也带 `dialogs`。
- 需要人处理时：复用 `needs_human` 相位，hint 写「页面弹出了 confirm，已拦截；如需继续请……」。
- `confirm` 默认返回 `false`、`prompt` 默认返回 `null`、`alert` 默认返回 `undefined`；不做「自动点确定」。
- `beforeunload`：若走 C，默认**放行**（导航是 agent 主动发起的），但导航结果里注明「页面曾尝试拦截卸载」。

### 3.3 配置面

新增 `dialogs.mode`：`'record'`（默认：记录 + 拦截）| `'off'`（不 hook，恢复原生行为）。**不做** `'auto-accept'`（静默放行会让 agent 能绕过页面自己的确认，等于绕过站点安全语义）。

### 3.4 测试

- 单测：hook 的纯逻辑（`plugin/inject/dialogs.js` 或并入 `guards.js`）用 stub `window` 跑，覆盖 alert/confirm/prompt 的返回值与记录、去重、上限。
- 单测：结果里 `dialogs` 的合并与截断。
- 真机 case：`demo/dialogs.html`（三个按钮分别 `alert`/`confirm`/`prompt`，一个 `beforeunload` 链接），验证「弹窗出现时 click 在 5s 内返回而非 20s 超时」「snapshot 能看到 dialogs」「off 模式回到原生弹窗」。

## 未验证（探针清单）

- [ ] U1：`<webview preload>` 是否可用（读宿主 `will-attach-webview` 校验；再用最小 webview 实测）。
- [ ] U2：注入 hook 能否覆盖内联脚本的早期 alert（`document_start` 级注入是否存在替代路径，如 `webContents.executeJavaScript` 在 `dom-ready` 前）。
- [ ] U3：Electron 27（DSH 0.2.2-rc.5 对应版本）里 alert/confirm 是否默认被 Electron 拦截（有些版本默认禁用 JS 对话框）——需实测。
- [ ] U4：`beforeunload` 的 `will-prevent-unload` 在 webview guest 上能否被 host 半感知。

## 验收

- [x] 弹窗页面上 `browser_snapshot`/`browser_click` 在 5s 内返回（不再 20s 超时）。
- [x] 结果/快照里能看到 `dialogs`（kind+message），`confirm` 默认被拦截（返回 false）而非无人应答。
- [ ] `dialogs.mode:'off'` 恢复原生行为（真机对照一次）——等 TICKET-040 白屏结案后补；当前仅单测覆盖。
- [x] 真机 case 记入 `docs/cases/016-js-dialogs-cases.md`。
- [x] 单测 ≥ 8 例；全量 245→251（guards 7→12、config 10→12），check-docs 全绿。
- [x] 错误码/文档：不新增错误码（复用 `needs_human`），用户 README 增「JS 弹窗」小节与已知限制。

## 风险

- R1：hook 改变页面语义，个别站点可能依赖 `confirm` 返回值做跳转 → 用 `mode:'off'` 兜底，文档写明。
- R2：早期弹窗（内联脚本）在注入前触发 → 只能靠 preload 或宿主侧方案解决；做不到就文档写清「首屏早期 alert 仍需人工点掉」。
- R3：`beforeunload` 处理不当会让「页面留人」变成静默失败 → 先只做记录，不做自动放行。
