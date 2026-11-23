# D19–D20：面板激活档位、挑战识别加固

> 来源：2026-11-20 用户提出「什么时候该开侧边浏览器，要讨论下」，随后拍板「默认 auto；`always` 下 `browser_download` 不亮；验证识别可以做」。
> 状态：`已定并实现`（1.0.27 代码、1.0.28 包文档，`HOST_REV 27` / `CLIENT_REV 27`）。
> 关联：`tickets/014-activation-levels.md`、`spec/001-agent-browser-plugin-spec.md` §10 A18 / A8 补强、`reference/011-task-cases.md` 缺口 8。

---

## D19 面板什么时候自己打开

**背景（代码事实）**：`plugin/client.js` 的 `dispatch()` 在本会话还没有 runner 时会 `deferCommand` → `openTabIn(ctx, sessionId)`（`:408`，依次尝试 `sidebarRight.openTabIn(sessionId, KIND)`、`openTab(KIND)`，最后 `ctx.layout?.openRightbar?.(true, false)`），`MOUNT_GRACE_MS` 内没挂上就返回 `the browser panel of session … is not on screen, so the page cannot be driven.`。注释写明结构性约束：**右栏不在屏幕上，标签永远拿不到 body**——所以"后台静默跑一个看不见的浏览器"在 DSH 的侧栏模型里做不到，只能选择"展开"或"快速失败"。

用户的需求原话（m02938）：「为了方便自己不动手，但是又能看到过程……取数其实不用开侧方，但是如果网站要过验证，肯定是要人工验证的……先人工验证、登录，之后再 agent 接手具体操作，用户在旁边监督看着」。

| 代号 | 做法 | 结论 |
|---|---|---|
| A | 纯手动：agent 永不展开，没开就报错 | ❌ 否决为默认：第一次用就报错，违背"不用自己动手" |
| B | 惰性自动开：第一次需要页面时才展开（现状） | ✅ **选为默认（`auto`）** |
| C | 先问一句「我要开浏览器，可以吗」 | ❌ 否决：每个任务多一次打断，且用户要的正是"别问我、直接做给我看" |
| D | 声明式：工具参数带 `visible:false` 由 agent 自行选择 | ⚠️ 保留为将来扩展：agent 无法在**拿到页面之前**判断页面长什么样，让它盲选只会瞎猜 |
| E | 粘性会话：打开后一直保持可见直到任务结束 | ⚠️ 部分吸收：`always` 档就是它的粗粒度版本 |

**三档语义（已实现）**

| 档位 | 谁来开 | `browser_download` | 面板未打开时 |
|---|---|---|---|
| `always` | 每次动作都把面板带到前台（`show:'always'`） | **不点亮**（host 侧 fetch，与面板无关；用户拍板） | 展开 |
| `auto` **默认** | 只有需要页面的动作才展开（`show:'once'`） | 不展开 | 展开；仍失败才报错 |
| `manual` | agent 永不展开（`show:'never'`） | 不展开 | **立即**报错并说明档位，不等 5 s 挂载超时 |

**为什么档位要在 host 定、在 client 生效**：可见性只能由客户端决定（`sidebarRight.openTabIn`），所以 host 读 `Config` → `activationPolicy` → 每条命令带 `show` 字段下发；client 的 `dispatch` 据此决定 `openTabIn` 或直接 `settle({ok:false})`。这样改档只需改 profile 配置行，不动代码：

```yaml
- id: agent-browser-panel
  config:
    activation: auto      # always | auto | manual
```

**为什么 `always` 不点亮 `browser_download`**：下载走 host 侧 `fetch`，根本不经过桥，点亮面板只会平白制造一次视觉跳变，而用户看不到任何"过程"（真正的下载过程在 Node 里）。要观察下载，看工具返回的 `bytes`/`sha256` 更有信息量。

---

## D20 挑战识别怎么加固

**背景**：1688 首页落在阿里滑块页（title「验证码拦截」，正文「请按住滑块，拖动到最右边」），`detect.js` **没判中**，agent 直接开干去了。原因有三：`TITLE_RE` 不认「验证码拦截」；`PHRASES` 只有「拖动滑块」而实际是「请按住滑块，拖动到最右边」；滑块容器的选择器（`#nc_1_wrapper`、`.nc-container`）不在列表里。

| 代号 | 做法 | 结论 |
|---|---|---|
| A | 只补词表（标题/文案/选择器） | ⚠️ 不够：滑块页往往只有一句文案 + 一个 iframe，命中不稳定 |
| B | 补词表 + **降级命中**：只有文本一类信号、且可交互元素 ≤ 3 也算墙 | ✅ **选中** |
| C | 用截图做视觉判断 | ❌ 否决：需要模型看图，成本高且不可复用；快照链路本身还有偶发失败 |

**判据（已实现）**：`hit = (命中类别 ≥ 2 且 (DOM 或 location 有信号)) || (只有 text 一类 && interactive ≤ 3)`。

**为什么宁多报**：误报的代价是"停手问人"，漏报的代价是"agent 在验证页上瞎点"——后者浪费更多步数，还可能把 IP/账号搞脏（D03 已定同一取向）。反例也固化成单测：搜索到「如何完成滑块验证」的帮助页有几十个控件，`interactive` 很大，不判墙。
