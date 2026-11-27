# 案例 029：动作后的页面内可见反馈（TICKET-055，1.5.22）

**一句话**：每个动作执行完后，面板在页面里画一笔落点痕迹——点击涟漪 + 实心点、悬停空心光标、滚动/输入的元素高亮框、拖拽的连线与两端圆点——让人看得见 agent 刚才碰到哪儿；痕迹是纯覆盖层（`pointer-events:none`），页面既收不到事件也不改状态，5 秒后自动消失。

- 能力入口：配置组 `feedback`（`enabled` 默认 `true`、`durationMs` 默认 `900`，100–5000 夹取），面板「设置」页新增「可见反馈」组；不新增工具、不新增错误码（仍 16 个工具 / 21 个错误码）。
- 环境：1.5.22、DSH 桌面端、面板右侧栏浏览器页签；验收集为 `demo/` 下的 console / approval-form / long / drag 四个夹具（由 `browser_open({path})` 打开，回环端口随会话分配）。
- 证据截图：`screenshots/ticket055-1522-click-mark.png`、`ticket055-1521-hover-mark.png`、`ticket055-1521-scroll-mark.png`、`ticket055-1521-type-mark2.png`、`ticket055-1521-drag-mark.png`。

## 1. 结论

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| E1 | 点击后画涟漪 + 实心点 | ✅ 点落在点击坐标上 | `browser_click {loc:"css:#log-error"}` → 截图蓝点在「console.error 一条」上 |
| E2 | 悬停后画空心光标点 | ✅ 空心圆环停在指针位置 | `browser_hover {loc:"css:#log-warn"}` → 截图空心圆在「console.warn 一条」上 |
| E3 | 寻址滚动后高亮目标元素 | ✅ 2px 蓝框包住目标元素 | `browser_scroll {loc:"css:#append"}` → 截图「追加 10 行」被蓝色框包住 |
| E4 | 输入后高亮输入框 | ✅ 蓝框 + 10% 蓝底 | `browser_type {loc:"css:input[name=\"nick\"]", text:"反馈高亮"}` → 截图昵称输入框被高亮 |
| E5 | 拖拽后画起点→终点连线 + 双点 | ✅ 细线 + 两端圆点 | `browser_drag {from:{loc:"css:#handle"}, to:{loc:"css:#lane"}, steps:6}` → 截图把手到轨道一条细线 |
| E6 | 配置 `durationMs` 生效 | ✅ 5000ms | 页面诊断日志 `{"step":"config","enabled":true,"durationMs":5000}`、`{"step":"source","length":10197}`、`{"step":"drawn","answer":{"ok":true,"kind":"click"}}` |
| E7 | 到点自动消失、层被移除 | ✅ | 超过 5000ms 后的截图无痕迹；诊断 `hasState:true`（计数保留）而 `layer:false`；单测覆盖计时器 |
| E8 | 关闭开关（`feedback.enabled:false`） | ⚠️ 单测覆盖、真机未验 | 真机验证需要改 profile 配置 + 完整重启 DSH；`config.test` 与 `feedback.test` 覆盖行为分支 |
| E9 | 「设置」页出现「可见反馈」组 | ✅ 源码 + 安装包核对 | 安装包 `client.js` 含 `title: '可见反馈'`（`CLIENT_REV = 64`）；表单 UI 未在实际设置页打开核对 |
| E10 | 覆盖层不向页面派发事件 | ✅ | 覆盖层 `pointer-events:none`；夹具自己的点击计数只随真实点击增长（E1 截图计数 3 = 3 次真实点击） |
| E11 | 1.5.22 最终包复验点击痕迹 | ✅ | `browser_click {loc:"css:#log-one"}` → 截图蓝点落在「console.log 一条」上 |

## 2. 命令与回执原文

```
browser_click {loc:"css:#log-error"}
Clicked button "console.error 一条" at (366, 164).

browser_hover {loc:"css:#log-warn"}
Hovered button "console.warn 一条" at (223, 164).
Nothing moved under the pointer (it was already expanded, or this control does not react to hover). …

browser_scroll {loc:"css:#append"}
Scrolled button "追加 10 行" into view at (24, 203) 78×25 — fully in view. Snapshot again to see it in context.

browser_type {loc:"css:input[name=\"nick\"]", text:"反馈高亮"}
Typed 4 characters into textbox "普通文本框".

browser_drag {from:{loc:"css:#handle"}, to:{loc:"css:#lane"}, steps:6}
Dragged button "拖拽把手" from (107, 289) to (409, 291).
Released over div "放置轨道".
A drag is a write: check what the page shows now with browser_snapshot before guessing that it took effect.
```

页面内诊断日志（`window.__dshFeedbackLog`，面板每次 beacon 追加最近 20 步，仅用于验收）：

```
[{"step":"no-mark","type":"open","keys":["url","title","fit"]},
 {"step":"no-mark","type":"inspect","keys":["ok","info","isSubmit","acceptsFiles","acceptsMultiple","url"]},
 {"step":"start","kind":"click"},
 {"step":"config","enabled":true,"durationMs":5000},
 {"step":"source","length":10197},
 {"step":"drawn","answer":"{\"ok\":true,\"kind\":\"click\"}"}]
```

## 3. 验收期修掉的问题（按发现顺序）

1. **beacon 没被触发（点映射）**：`Guest.beaconFor` 期望 `answer.point`，而 `Guest.click` / `Guest.hover` 回执给的是 `x` / `y` → 首次真机点击后页面无任何痕迹。修：`point ?? (x, y)` 兼容两种形状（1.5.18）。
2. **输入没有 rect**：`actions.js` 的 type 分支回执不带元素矩形，type 高亮不会触发。修：type 回执补 `rect: rectOf(element)`，面板侧 `Guest.type` 透传（1.5.18）。
3. **`inject/feedback.js` 漏打包**：`tools/pack.mjs` 的 COPY 是显式清单，漏了这个新文件 → 装机包里没有 → 宿主 `/source?name=feedback` 500 → 面板缓存空串、静默不画（诊断日志 `step:"source", length:0` 定位）。修：COPY 补文件，并在 `tools/check-docs.mjs` 加**第 7 项**「`plugin/inject/*.js` ↔ COPY 清单」双向比对，漏列/多列都会失败（1.5.21）。
4. **客户端 bundle 缓存**：面板可能继续执行旧 bundle，版本号变化不保证刷新（1.5.17→1.5.18 曾复现）。规避：装新版本后若行为没变，完整重启 DSH；验收期统一按「先重启、再验收」执行。
5. **截图与 5s 窗口的时延**：模型往返 + 工具调用可能超过痕迹停留时间。验收方法：把「动作 + 截图」发在**同一条消息**里（连续两次工具调用），截图即在同一批内完成；需要放宽窗口时把 `feedback.durationMs` 调到 5000（上限）并重启 DSH。

## 4. 复跑步骤

1. 装 1.5.22（`plugin_manager remove_bundle` → `install_bundle target="dist/dsh-plugin-agent-browser/dsh-plugin-agent-browser-1.5.22.tgz"`），完整重启 DSH，打开右侧栏浏览器页签。
2. `browser_open {path:"demo/console.html"}` → `browser_click {loc:"css:#log-error"}` 与 `browser_screenshot` 同一批发出 → 截图应见蓝色实心点。
3. `browser_open {path:"demo/approval-form.html"}` → `browser_type` 打昵称框 + 同批截图 → 应见输入框高亮框。
4. `browser_open {path:"demo/long.html"}` → `browser_scroll {loc:"css:#append"}` + 同批截图 → 应见元素蓝框。
5. `browser_open {path:"demo/drag.html"}` → `browser_drag` 把手 → 轨道 + 同批截图 → 应见连线与两端圆点。
6. 可选：把 profile 的 `feedback.durationMs` 临时调到 5000 并重启 DSH，重复步骤 2 复验窗口；之后恢复 900。

## 5. 已知边界

- 关闭开关的「无痕迹」只在单测层覆盖；真机切换需要改 profile 配置 + 完整重启 DSH。
- 痕迹只画在顶层文档（不含跨域 iframe 内部）；页面自身 `z-index` 更高的浮层可能盖住痕迹（覆盖层用 `2147483645`）。
- 痕迹是纯呈现：不改变页面状态、不派发事件、不进工具回执；面板隐藏时动作照常执行，只是没人看得到痕迹。
- 每次动作最多两三个节点，5s 内自动移除；页面刷新/导航即清空（层随文档销毁）。
- `feedback.durationMs` 在面板挂载时读一次；改配置需要插件重载（设置页保存会自动重载）。
