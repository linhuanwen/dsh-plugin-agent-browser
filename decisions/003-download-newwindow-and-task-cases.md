# D13–D15：下载通道、新窗口策略、任务级案例执行口径

> 来源：2026-11-20 用户审核 T1–T8 后逐条拍板（真实账号 / 基准站我定 / downloads 目录 / L 级按建议 / 人工边界按建议 / 不进 CI）+ 同意 spec 增补 A14、A15。
> 状态：`已定`，待开工（TICKET-008、TICKET-009）。
> 关联：`reference/011-task-cases.md`、`spec/001-agent-browser-plugin-spec.md` §10 A14/A15。

---

## D13 下载通道怎么做

**背景（代码核实，不是推测）**：`dist/dsh-plugin-agent-browser/` 全量 grep `will-download` / `downloadURL` **0 命中**，插件完全没有下载能力。而 `plugin/tools.js:8` 有 `from 'node:fs'`，说明**工具跑在 host（主进程/Node）侧**——这决定了可行方案。

| 代号 | 做法 | 结论 |
|---|---|---|
| A | host 侧新增工具：Node `fetch(url)` → 校验 → 写 `<workspace>/downloads/` → 回传 `{path,bytes,sha256,mime}` | ✅ **选中（主线）** |
| B | guest 内 `fetch(href,{credentials:'include'})` → base64 分块经 eval 回传 → host 写盘 | ✅ 选中为 `via:'page'` 补充路径（保 Cookie / Referer） |
| C | 监听 Electron `session.on('will-download')` | ❌ 否决：插件全程在 renderer（`client.js` 只有 `globalThis.dshDesktop.browser` 与 `<webview>`），拿不到 main 的 session 对象 |
| D | 不实现，让 agent 直接把 PDF 当页面读 | ❌ 否决：Chromium 内置 PDF 预览只给一小段文本树，拿不到文件本体，T4 的 L3 永远不过 |

**选 A 为主、B 为可选的原因**

- A 最干净：一个工具、一条链路、失败原因明确（`download_failed: {stage,url,reason}`），而且**不依赖面板是否打开**——可以直接下附件 href，不必先点开新窗口（顺带绕开 T7 的坑）。
- B 的必要性只在一处：需要登录态的下载（1688 的电子合同/规格书）。renderer 里 `fetch` 走的是 guest 的 session，天然带 Cookie；代价是要处理大文件分块与 8 000 字符的 eval 返回预算，所以列为 v1.1、按需开启。
- 两条路都必须遵守同一条**诚实约定**：失败就报失败，**禁止**用页面正文摘要冒充"已下载的附件内容"（T4/T5 的幻觉诱捕点）。

**落地时定死的参数**

| 项 | 值 |
|---|---|
| 落盘目录 | `<workspace>/downloads/`（首次使用时创建） |
| 文件名 | 从 `Content-Disposition` → URL basename → `download-<timestamp>` 依次回退；重名自动加 `-1`、`-2`，**绝不覆盖** |
| 大小上限 | 50 MiB（超出→ `download_failed: too_large`） |
| 超时 | 连接 10 s / 整体 60 s |
| 协议 | 只允许 http(s)；拒绝指向 DSH 自身地址（复用 A10 的同一套判断） |
| 哈希 | `sha256`（复跑时用于比对同一份规章有没有改版） |
| 权限 | 写入仅限 `downloads/` 下，不接受 `../` 穿越（写入方向的校验是新增的，`static.js` 只有读方向的 `resolveWithin`） |

> **执行期补记（2026-11-20，实跑 T4 后）**：文件名那一行的"从 `Content-Disposition`"要再加一道**百分号解码**。市场监管总局的附件返回 `attachment;filename=%E5%85%AC…pdf`（用百分号编码塞中文名，不是 RFC 5987 的 `filename*=`），1.0.4 原样落盘成 `%E5%85%AC…` 乱码名；1.0.5 加 `percentDecode()`（无 `%` 直返，解码失败则原样保留，保护 `100%.pdf` 这类真名字）后得到 `公平竞争审查条例实施办法.pdf`。判点：L3 除"文件存在"外还要看**文件名可读**。

---

## D14 新窗口策略（`target="_blank"` / `window.open`）

**约束**：同样因为插件在 renderer，**设不了** main 进程的 `setWindowOpenHandler`。

| 代号 | 做法 | 结论 |
|---|---|---|
| A | main 进程 `setWindowOpenHandler` 强制 deny + 同视图导航 | ❌ 不可行（无 main 权限） |
| B | **inject 层**：点 ref 前若目标带 `target="_blank"` 就先改成 `_self`；同时对 `window.open` 做猴子补丁，记录 URL 并返回 `null` | ✅ **选中** |
| C | 不处理，让行为保持未定义 | ❌ 否决：T7 会永远处于"行为未知"，线上表现为随机弹窗或静默丢导航 |

**固化行为**

1. `browser_click` 命中 `a[target=_blank]` → 页面内先 `el.target = '_self'` 再点击，**同视图导航**；
2. 页面自己调 `window.open(url)` → 补丁拦截，返回 `blocked_new_window {url}` 结构化结果，提示 agent "用 `browser_open(url)` 显式打开"；
3. 快照返回的 `url` 必须等于视图真实 URL（防止"导航了但树还是旧的"）。

---

## D15 任务级案例执行口径（用户 6 条拍板的落地）

| 项 | 定案 | 影响 |
|---|---|---|
| 1688 身份 | **真实账号**（扫码由人做，密码/二维码永不进模型） | T1 可判到 L3/L4 |
| 规章基准站 | **市场监管总局 `https://www.samr.gov.cn/`**（规章最密） | T4 固定入口，站改版就更新本文 |
| 下载目录 | `<workspace>/downloads/`，回传 `sha256` | T4 L3 判据 |
| 判定级别 | T1/T2/T4/T5/T6 取 **L3**；T7/T8 取"行为已记录 + 有结论" | 见 011 各案 |
| 人工介入 | **只有 T3** 允许人工登录/过验证；且必须走 `needs_human` 结构化通道 | 其余案例人工介入即判失败 |
| CI | **暂不进**，做人工触发的验收脚本（`node tools/task-cases.mjs T1`），每季跑一次 | 不阻塞日常开发 |

**顺带修正的两处文档过期**：`README.md` 目录里写的 `plugin/ package.json` 并不存在——`plugin/` 只有 `.js` 与子目录，**双面包清单只在 `dist/dsh-plugin-agent-browser/package.json`**（1.0.3，`files` 16 项）。改插件请改 `dist/` 那一份再重打 tgz。

---

## D16 语义点击的"测得准"vs"点得中"（TICKET-009 落地时定案）

**问题**：`browser_click({selector})` 的坐标由页面内计算，真正的鼠标事件由 host 的 `sendInputEvent` 派发，二者之间隔着一次进程往返。实测（`demo/ticket-009.html` 的 `#deep`）：`scrollIntoView` 本身触发懒加载，上方内容追加后目标被挤走约 1.2k px，工具按旧坐标点击 → **点到了别的元素且返回成功**，是最坏的一类失败（静默错点）。

| 选项 | 做法 | 结论 |
|---|---|---|
| A | 页面内直接 `element.click()`，不经坐标 | ❌ 否决：丢掉 `isTrusted`，canvas（百度地图缩放）与依赖真实指针事件的组件全失效 |
| B | 点完再回读 `elementFromPoint` 校正，错就重点一次 | ❌ 否决：错点已经发生，副作用不可回滚（可能已经触发导航或提交） |
| C | **量坐标前等两帧，`out_of_view` 时重滚重试（上限 2 次）；命中测试与取坐标在同一次同步块内完成** | ✅ **选中** |

**代价**：每次 selector 点击多约 1–2 帧（面板被后台节流时退化为 120 ms 定时器）；重试最多 2 次，仍失败报 `out_of_view` 并让 agent 重新快照。

**否决"纯坐标优先"的原因**：坐标点击仍然保留（canvas / 跨域 iframe 不得不用），但它从不做命中保证——所以默认路径必须是有语义的 `selector`/`ref`，坐标是兜底而不是首选。

**顺带固化**：失败载荷必须带调用者用的寻址方式（`selector` 或 `ref`），否则文案会写出 `ref ""` 这种自相矛盾的错误。

**执行期修订（1.0.12–1.0.14，同一天内的二次收紧）**：

| 版本 | 修订 | 为什么 D16 的 C 方案还不够 |
|---|---|---|
| 1.0.12 | 九点采样取点（中心 → 四边中点 → 四角），命中自身或后代才用 | 中心点落在遮挡物上不代表整个控件被盖住：半露的控件本来是可以点的 |
| 1.0.13 | 用 `stableThenPayload`（最多 6 轮"滚入视野 → 等两帧 → 高度稳定且完整在视口内"）取代"重试 2 次" | 只靠 `out_of_view` 触发重试，会在"高度还在长但目标暂时在视口内"时漏判 → 仍可能静默错点（夹具上复现过一次 `Clicked…` 但页面事件为 0） |
| 1.0.14 | `neutralizeTarget` / `takeBlocked` 移到"确认要点击"之后 | 失败的动作不该产生副作用，也不该吞掉上一条 `window.open` 拦截警告 |

## D17 像素级露出的叠卡：点还是报错（TICKET-009 真站验证后定案）

**问题**：百度地图右下 `.mapTypeCard.earth` 只露 5 px，九点采样全部落在上层"全景"卡上。要不要继续加密采样（比如 1 px 步进扫左缘）把它"抠"出来？

| 选项 | 做法 | 结论 |
|---|---|---|
| A | 继续加密采样（1 px 网格 / 边缘 2%）直到命中 | ❌ 否决：点中的是 5 px 的边缘像素，既不是真人会做的动作，也极易点进装饰/阴影；而且这类控件真人本来就是**先 hover 展开**再点 |
| B | 报 `occluded` 并给出遮挡者名字，把 hover 作为独立原语另开单 | ✅ **选中**（`tickets/010-hover-and-stacked-controls.md`，P2） |
| C | 自动退回 `element.click()`（eval 点击） | ❌ 否决：`isTrusted === false`，会绕过站点的展开逻辑，且与本插件的"可信输入"前提冲突 |

**边界固化**：**有可见面积的遮挡可以绕（九点采样）；整块被盖住的不猜，直接 `occluded` + 报遮挡者。** 需要 hover 才能展开的控件记为"当前动作面未支持"，不得用 eval 点击凑判定。

**D17 落地补充（2026-11-20，TICKET-010 完成）**：B 选项的 hover 已实现为 `browser_hover`（1.0.19）。真站验证：直接点地球卡仍 `occluded`（这条边界不变），但 `browser_hover({selector:'#mapType'})` 让三卡从 x=349/354/359 展开到 167/263/359，随后点击成功、URL 变 `maptype=B_EARTH_MAP`。**"先 hover 容器再点卡片"成为叠卡类控件的标准两步走**，`occluded` 文案也补了这句指引。

---

## D18 `browser_hover` 怎么实现：真指针移动 + 二次解析（TICKET-010 落地时定案）

**问题**：要让"悬停才展开"的控件展开，有三种做法，差别在"是不是可信输入"和"怎么判断它真的展开了"。

| 选项 | 做法 | 结论 |
|---|---|---|
| A | 页面内合成事件 `element.dispatchEvent(new MouseEvent('mouseover'))` | ❌ 否决：`isTrusted === false`，走不到 CSS `:hover`，站点的真实展开逻辑（transition/布局）不会触发 |
| B | 直接对目标卡 `element.click()` 凑结果 | ❌ 否决：绕过展开逻辑，与 D17 的 C 一致，属"作弊式通过" |
| C | **`webContents.sendInputEvent({type:'mouseMove'})` 发真指针移动 → 等 `waitMs` → 再解析一次同一目标，比较落点/文档高度/子树矩形指纹得出 `grew`** | ✅ **选中** |

**为什么需要"子树指纹"**：叠卡展开时**容器矩形不变**，只有子元素在动（百度三卡从 x=349/354/359 变 167/263/359）。最初只比较目标自身的宽高，恒报 `grew:false`；改成"落点位移 ∨ 文档高度变化 ∨ 目标子树（最多 40 个后代）坐标串变化"三者取或，才既覆盖"卡片平移"也覆盖"页面变高"。

**为什么 hover 允许禁用的控件**：禁用的按钮也能被悬停（真人也会把鼠标停在灰按钮上看 tooltip），所以 hover 路径**不做** `isDisabled` 检查；`click` 路径保留。

**为什么不做 `reveal:'hover'` 自动一轮**：原计划让 `browser_click` 在 `occluded` 时自动 hover 遮挡者再重采样。实做后放弃——自动 hover **谁**是有歧义的（遮挡者通常是整块浮层，hover 它不会让底下的卡片展开），而显式两步（先 hover 容器，再点卡片）每次都有独立结果可审计。宁可让调用方多写一行。

**边界固化**：① 直接 hover 被整块盖住的元素照样 `occluded`（悬停看不见的东西没有意义）；② `grew:false` 有两种含义（本来没反应 / 指针已在上面、早就展开了），文案把两种都说清楚，判定时要先看容器是否已展开；③ hover 与 click 一样算"有副作用的动作"，不进只读探测路径。


