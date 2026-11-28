# TICKET-062 快照预算：交互节点优先、重复结构压缩、自适应预算

状态：✅ 已实现并真机通过（2026-11-28，1.5.28）· 阶段 B2「可核对」收尾
日期：2026-11-28
相关：SPEC-004 §3 阶段 B2「token 预算打磨」、TICKET-046（cursor 续读）

## 1. 缺口（为什么要做）

快照是 agent 每次行动前都要付的固定税，现状有三个硬伤：

1. **预算按行号切，不看内容**。树是 DFS 平铺的一串行，预算用完就从中间截断：
   页面底部的一整排按钮（带 `ref`）可能一条都拿不到，而顶部一段 160 字的
   正文却占满了预算。
2. **交互节点和纯文本同权**。`- text "…"` 这类长文本与
   `- button "保存" [ref=e12] [loc="css:…"]` 抢同一个字符池；后者才是能点的东西。
3. **重复结构不压缩**。列表页、表格行、重复卡片会生成大量同构的文本行，
   一次快照的预算被同构内容吃掉。

行号截断 + 无法控制优先级，让 agent 在「预算内看不全、加大预算又太贵」之间来回试。

## 2. 准入四问

| 问题 | 回答 |
| --- | --- |
| 会不会动页面？ | 不会。只改变**交付给模型的文本**，页面树、`data-dsh-ref`、gen 都不变。 |
| 能不能反悔？ | 能。快照是纯读；换 `maxChars` / `cursor` 重新读即可，没有任何副作用。 |
| 失败时是「没执行」还是「可能执行了」？ | 没执行。规划器是宿主侧纯函数，失败就是没返回文本，页面未被触碰。 |
| 会不会抢控制权 / 需要人工相位？ | 不会。仍是 `READ_TYPES` 的读动作，`needs_human`/`taken_over` 下都能用。 |

## 3. 设计

### 3.1 页面侧只出原料（`plugin/inject/snapshot.js`）

- 遍历照旧，`lines` 仍全量构建，stamp 仍由
  `页身份 + totalLines + refCount + 全部行字符数` 组成（cursor 失效语义不变）。
- 新增 `raw: true`：不再在页面里按预算切片，而是把 `lines` 全量返回
  （`{lines, stamp, totalLines, refCount, visited, frames, …}`）。
- 旧 `text` 切片路径保留，作为不传 `raw` 时的兼容行为。
- 传输发生在宿主 IPC 里，不占模型 token；切片规划上移到宿主后，逻辑是纯函数，
  单测不必再造一个 DOM。

### 3.2 宿主侧规划器（新 `plugin/snapshot-plan.js`）

`planSnapshot(lines, { maxChars, from })` 返回
`{ text, delivered, nextOffset, truncated, mode, textCap }`：

1. **整页装得下**（全部行总字符 + 换行 ≤ 预算）：原样交付，`mode: 'full'`。
2. **装不下**：按 `textCap` 从大到小（160 / 120 / 80 / 60 / 40 / 20）试探，
   只有文本行按 `textCap` 省略（尾部替换为 `… (+N chars elided)`），
   `ref` 行、`page`/`iframe` 行、结构行永远完整；取**能全部装下的最大 textCap**，
   `mode: 'elided'`。这样交互节点不会因为上面的长正文被挤掉。
3. **最紧的 textCap 也装不下**：从 `from` 起按预算顺序交付；文本行仍按 20 省略，
   `ref` 行尽量保住；`mode: 'cut'`，`nextOffset` 指向下一条未交付行，
   客户端把 `stamp@nextOffset` 作为 cursor 返回，续读语义和现在一致。
4. **重复结构压缩**：仅在 `textCap <= 80` 且同一缩进下连续出现 ≥ 6 条纯文本行时，
   保留前 2 条 + `- … N more text line(s) elided (use browser_read for page content)` + 最后 1 条；
   被折叠的行计入已消费偏移（续读不会重复）。`mode: 'folded'`。
5. 所有省略/折叠都有确定文案，方便测试与文档引用。

### 3.3 工具接线（`plugin/tools.js` `browserSnapshotTool`）

- 对页面请求固定带 `raw: true`；收到 `lines` 时用 `planSnapshot` 生成
  `text` / `cursor` / `nextOffset` / `truncated`；收到旧 `text` 时保持旧行为（测试与回退兼容）。
- `cursor` 仍由工具返回给调用方：`stamp + '@' + nextOffset`；续读时把 offset 作为 `from`。
- 页面的 `stale` 分支不变（`stale_cursor`）。
- render 抬头/尾部文案不变，`L lines · V nodes walked` 仍如实反映。

### 3.4 预算上限

`limits.snapshotMaxChars` 仍是默认 8000、单次 `maxChars` 仍夹 500–30000；
本次不改默认值，只改「同样的预算里装什么」。

## 4. 证据

- 新 `plugin/snapshot-plan.js`：宿主侧纯函数 `planSnapshot(lines,{maxChars,from})`。
  - 整页装得下 → `mode:"full"`，逐字交付；
  - 装不下 → 按 `TEXT_CAPS = [160,120,80,60,40,20]` 从大到小省略**正文**（`- text` 行与无 `ref`/`loc` 的元素行如 `- paragraph "…"`），
    取能装下整棵树的最大 cap；带 `ref`/`loc` 的行、page/iframe 头永不改写；
  - cap ≤ 80 时折叠连续 ≥6 条同 role 的正文/重复项：保留前 2 条 + `- … N more … elided (use browser_read…)` + 最后 1 条；
  - 折叠后的长度计入预算估计（否则长列表明明能装下却被判超预算）；
  - 极紧预算 → 顺序交付、切在行边界并返回 `nextOffset`，由 cursor 续读。
- 页面侧 `inject/snapshot.js`：`options.raw === true` 时只返回**全量行数组**与 `stamp`（不再自己切片）；旧 `text` 路径保留，行为不变。
- `plugin/client.js`：`CLIENT_REV 66→67`，快照请求透传 `raw`。
- `plugin/tools.js`：`browser_snapshot` 请求带 `raw:true`；收到 `lines`+`stamp` 时用规划器决定交付文本与 cursor（`<stamp>@<offset>`），`stale_cursor` 仍由页面 stamp 校验；旧答案形状原样兼容。
- 打包：`tools/pack.mjs` 与 `dist/package.json` 的 `files` 都加入 `snapshot-plan.js`（check-docs 第 7 项双向校验）。
- 测试：`plugin/test/snapshot-plan.test.mjs` **17 例**（整页装下、正文省略但 ref 保留、自适应 cap、极紧预算 cut+nextOffset、ref 行不缩、长正文元素行省略、同 role 折叠、`from` 续读、非法输入防御、确定性、`elideTextLine`/`elideNameLine` 边界、工具级 `lines` 路径与旧 text 路径）；全量 **470/470**；check-docs 七项全绿（配置 23、工具 20、YAML 14、decisions 10、B11、file:line 12、打包清单 8 inject + 16 宿主 + dist files）。
- 真机：`demo/dense.html` 端口 4447，`maxChars:900` 交付 887 B 整棵树、6 个 ref 全在、正文两段带 `… (+N chars elided)`、3 段合并提示、列表 10 行折叠成 2 行；`maxChars:500` 切在 11/26 给 cursor；用该 cursor 续读得 `continued at line 12/26`、剩余 ref 完整、再切 22/26；默认 8000 仍是 26 行全文。回执原文见 `docs/cases/036-snapshot-budget-cases.md`。

### 4.1 验收期修复

1. 真实页面的长正文是 `- paragraph "…"` **元素行**，不是 `- text` 行；首版只省略 text 行 → 仍然截断。修复：无 `ref`/`loc` 的带引号元素行一并省略（保留 role/缩进/尾随状态）。
2. 折叠后的长度没有计入预算估计 → 长列表被误判超预算而直接切。修复：cap ≤ 80 时用折叠后的文本长度作为交付成本。
3. `roleTokenOf` 的正则没有拿到角色（折叠 key 恒空、从不折叠）→ 改为字符串解析。
4. 1.5.28 装机后面板仍在跑旧客户端（请求不带 `raw`），需完整重启 DSH；与 TICKET-055 的 bundle 缓存现象一致。

## 5. 不做

- 不改默认预算、不按 token 计数（仍按字符）。
- 不做语义摘要（不调用模型压缩页面）。
- 不做跨快照的缓存/去重。
- 不改 cursor 的失效语义，不持久化快照。
- 不改变任何 `ref`/`loc` 的生成规则。

## 6. 验收清单

- [x] `planSnapshot` 纯函数单测全过（17 例）
- [x] 工具级 lines 路径单测全过，旧 text 路径不退化
- [x] 全量测试（470/470） + check-docs 七项全绿
- [x] 1.5.28 打包（398,353 B / sha256 `98c27b7a…`）、装机
- [x] 真机：默认预算、900 预算、cursor 续读两片（`docs/cases/036`）
- [x] `docs/cases/036-snapshot-budget-cases.md` 记录回执原文
- [x] release notes / PROGRESS / docs README / 两份 README 更新
