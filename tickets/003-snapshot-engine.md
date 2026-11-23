# TICKET-003：快照引擎（可访问性树 + ref + 截图）

- 状态: ✅ 通过（2026-11-19）
- 优先级: P0
- 关联 Spec: `spec/001-agent-browser-plugin-spec.md` §5.2、§6
- 依赖: TICKET-002
- 目标目录: `D:\Vibe coding\32 deepseek harness cebiankuang\plugin\`（link 安装，无需构建）

## 目标

实现 `browser_snapshot`：把页面变成一段**模型读得懂的带 `[ref=eN]` 的缩进树**，同一次响应再附一张 768px 宽的截图。这是 Agent 的"眼睛"，它的质量决定整个插件好不好用。

## 背景

`dsh-pilot` 的快照**不可复用**——它只是给 Playwright 的 `ariaSnapshot` 文本做截断，ref 解析靠 Playwright 私有定位器（见 `reference/001-dsh-browser-internals.md` §10）。webview 里没有 Playwright，树与 ref 必须自己写。

关键设计（决策 D06）：
- 每次快照给 `<html data-dsh-gen="N">` 打代次，元素打 `data-dsh-ref="e12"`；
- 预算 8000 字符，按行截断；
- 同源 iframe 递归（ref 前缀 `f1e2`），跨域 iframe 只输出占位节点。

## 验收

- [x] 返回形如 `- heading "…" [ref=e1]` 的树，`refCount > 0`
      —— 夹具 `http://127.0.0.1:8795/` 输出 `- heading "Panel Test Page" [ref=e1]`，`refCount 4`
- [x] 带表单的页面能识别出 `textbox` / `checkbox` / `button`，并标注 `required` / `checked`
      —— `/form` 输出 15 refs：`textbox "Full name" [ref=e2] required`、`checkbox "I agree to the terms" [ref=e5] checked`、`combobox "Plan" [ref=e7] value="pro"` + 两个 `option`、`button "Create account" [ref=e11]`
- [x] 超长页面返回 `truncated: true`，且截断发生在行边界（不出现半行、不留悬空 ref）
      —— `/long`（6000 行链接）`maxChars=8000` → `truncated:true`、68 refs / 137 行 / 2ms；`maxChars=30000` → 249 refs / 500 行 / 5ms
- [x] 同一页面连续两次快照，`gen` 递增，旧 ref 不带入新代次
      —— 同一页面 `gen` 1→2→3，每次先清掉本帧全部 `data-dsh-ref` 再重打
- [x] 隐藏元素（`display:none` / `aria-hidden="true"`）不出现在树里
      —— `/form` 中 `.gone`（display:none）、`.ghost`（visibility:hidden）、`.faded`（opacity:0）、`aria-hidden` 区块全部消失；`.offscreen`（定位到视口外但已渲染）保留，属有意行为
- [x] 同源 iframe 内容被展开（ref 形如 `f1e2`）；跨域 iframe 输出占位节点并提示用坐标点击
      —— `/frames` → `- iframe "/inner"` 下 `heading "Inner frame" [ref=f1e3]`、`textbox "inside the frame" [ref=f1e4]`、`button "inner click" [ref=f1e5]`；跨域侧 `- iframe "http://127.0.0.1:8796/inner" [cross-origin: use coordinates]`
- [x] `includeImage: false` 时不附图、响应体积明显变小
      —— 同一页同一代次：带图 6.7 KB，不带图 1.0 KB（6.7×）
- [x] 默认响应带图，图宽 768px
      —— 面板 585 CSS px 宽时图 878 设备像素（DPR 1.5），面板 299 CSS px 宽时 449 像素；两者都 ≤ 768，超过时才 `resize({ width: 768 })`
- [x] 在 5000+ 节点的页面上，快照耗时 < 300ms（超时则截断，不挂死）
      —— `/heavy`（6000 个 `span`，12010 个 DOM 节点）→ `12010 nodes walked · 16ms`
- [x] 密码框只输出 `[value=***]`，绝不泄露明文
      —— `/form` 的 `type=password` → `textbox "Password" [ref=e4] value=***`

**唯一偏差**：`https://example.com/` 现在返回多语言落地页，没有 `<h1>Example Domain</h1>`，所以"example.com 上出 `heading "Example Domain"`"这条改成由夹具首页的 `<h1>` 证明。`refCount > 0` 在 example.com 上仍然成立。

## 任务分解

- [x] 注入脚本 `plugin/inject/snapshot.js`：自包含函数 `function dshSnapshot(options)`，返回 JSON 字符串，作为 `executeJavaScript` 的参数（**纯字符串注入，不走打包**；host 每次调用读盘）
  - [x] 可见性判定：`visibility(el)` 返回 `'yes' | 'no' | 'deeper'`；`'no'` 时整棵子树跳过（`display:none` / `aria-hidden` / 0 尺寸），`opacity:0` 只静音自身文本
  - [x] 节点纳入规则：可交互 / 结构 / 语义文本；空名 `div`/`span` 不单独成行
  - [x] role 映射表（`TAG_ROLE` / `INPUT_ROLE`，显式 `role` 属性优先）
  - [x] name 推断链（`aria-label` → `aria-labelledby` → `alt` → `title` → `placeholder` → `<label>` → 内部文本 → `value`）
  - [x] 状态标记（`checked`/`disabled`/`expanded`/`selected`/`required`/`readonly`/`value`，密码恒为 `***`）
  - [x] ref 打点（`data-dsh-ref`）+ 代次（`data-dsh-gen`）
  - [x] iframe 递归（`f1e2`）与跨域占位
  - [x] 输出拼装 + 预算截断（超预算即停，天然按行）
- [x] 宿主侧结果整形：`{ url, title, gen, text, refCount, truncated, nodes, visited, ms, image }`（`plugin/tools.js`）
- [x] 截图：`capturePage()` → 按 CSS/设备像素比换算 → 超过 768 宽才缩放 → `ctx.attachments.saveImage()` → 以 `{ type:'image', attachment }` 内容块返回
- [x] 工具描述文案（`[ref=eN]` 用法、何时看截图、ref 只对本次快照有效）
- [x] 性能自测：`/heavy` 12010 节点 16ms（本地夹具；不依赖外网）
- [ ] 注入脚本单测（`node:test` 喂序列化 DOM）——**未做**：注入脚本要在真实渲染器里跑才有意义，纯 DOM 单测要引入 jsdom，留到 TICKET-007 的构建链里

## 实测发现（新增）

1. **`capturePage()` 会一直挂着直到 guest 真的画出第一帧**。新版面板刚挂载、或刚 `loadURL` 完就去截图，`capturePage()` 既不 resolve 也不 reject（超时前实测卡满 8s）。三处修正：
   - `mount()` 里 `dom-ready` 之后打一发 fire-and-forget 的 `capturePage()` 预热；
   - `load()` 等 `did-stop-loading` 再返回（`loadURL` 只等到导航提交）；
   - `capturePainted()` 以 1.2s 为单次上限重试 3 次，全失败就退回纯文本快照并附一句说明。
2. **`<option>` / `<optgroup>` 没有布局盒**，`getClientRects()` 为空，按通用可见性判定会把整个下拉框内容判成隐藏——平台控件要直接判可见。
3. **`<label for=…>` 会重复字段名**：`<label>` 自身的文本节点会把名字再输出一遍，`isBoundLabel()` 跳过"绑定了控件且内部不含控件"的 label 节点。
4. **`visibility:hidden` 的语义是"自身文本不可见、子元素可显式恢复"**，所以帧上带 `muted` 标记：文本不输出，但继续下钻子元素。
5. **截图是设备像素**：面板 585 CSS px + DPR 1.5 → 878 像素。D08 的"缩到 768px"必须用 `getSize()` 和 `getBoundingClientRect()` 一起换算，不能直接信 CSS 宽度。
6. **`includeImage:false` 省的是 5.7 KB/次**（6.7 KB → 1.0 KB）。截图走 attachment，不占工具结果正文。

## 风险（更新）

| 风险 | 处置 |
|---|---|
| role/name 推断不准，树里出现一堆 `generic` | 只输出**有把握**的节点，宁缺毋滥；不确定的直接省略 |
| 虚拟列表站点（只渲染视口内元素） | 快照反映当前视口，工具描述里写明"需要更多内容先滚动" |
| `capturePage` 在面板不可见时返回空图或挂住 | 预热 + 重试 + 6s 上限；失败降级为纯文本快照并说明原因 |
| 注入脚本被页面的 Trusted Types 策略干扰 | `executeJavaScript` 走主世界不受 CSP 限制；快照失败会带明确错误而不是空树 |
| 大页面遍历成本 | 遍历是线性的，实测 ~1.3µs/节点；超预算即停 |

## 参考

- 输出格式与全部实测数据：`reference/004-snapshot-engine.md`
- 输出样例：`spec/001-agent-browser-plugin-spec.md` §6.4
- ARIA 角色映射：W3C ARIA in HTML 的 implicit role 表
