# TICKET-025 文档与决策：让下一个维护者不必重新推理

- **状态**：✅ 已完成（2026-11-21，装机 `1.3.6` 验收）
- **优先级**：P2（发布前必须完成：用户要自己装、别人也要装）
- **来源**：`docs/official-docs-review.md` #14/#15/#16（patch 整行替换语义、桌面限定属产品定义、不预防性拆分）
- **对应验收**：`spec/002-official-alignment-spec.md` B10
- **关联**：全部 ticket（每个落地后补对应文档）

## 1. 问题

插件行为已经比文档多得多，且三处关键语义只活在代码里：

1. **`cordis.patch.yml` 是整行替换，不是深合并**。用户想只改 `activation`，写了 `config: { activation: manual }`，结果 `fitWidth` 等字段被**丢掉并回落默认值**——这属于"静默改变行为"，必须在用户文档里用红字写。
2. **桌面限定没有正式声明**。非桌面环境下面板不出现、工具超时，用户只会以为"坏了"。这是产品定义（面板要 Electron `<webview>` + `dshDesktop.browser` 租约），应当明写，并做 fail fast。
3. **发布与安装步骤、配置表、卸载、故障排查**散在 README 与 tickets 里，没有一个"给装机的人看"的单页。
4. **架构决策没有 ADR**：为什么是 loopback 桥而不是 CDP、为什么不复用官方 browser-use（`docs/browser-use-contract.md` 已有证据但没进 decisions/）、为什么不拆多包。
5. **没写"该用哪个工具"**：用户（和模型）不知道什么时候该 `web_fetch`、什么时候该开面板，结果是读一篇新闻也开面板白烧视觉 token。内置 `web_search` / `web_fetch` 与插件的分工已在 `docs/web-tools-and-agent-browser.md` 定案（SPEC-002 B11），但没有进用户文档。

## 2. 修法

### 2.1 用户文档（`dist/dsh-plugin-agent-browser/README.md` 与仓库 README）

新增/改写五节：

| 节 | 内容 |
|---|---|
| **配置** | 完整字段表（来自 TICKET-016 的 Config）：字段、类型、默认值、是否需要重载、示例 YAML。**红字警告**：patch 条目是整行替换，只写你想改的字段等于把其余字段重置为默认——正确写法是**写全**该行 config |
| **环境要求** | 仅 DSH Desktop（Electron）；Web 版无 `<webview>`，面板不出现、工具返回 `unavailable`；DSH 版本范围（`engines.dsh` 同款） |
| **安装 / 升级 / 卸载** | 装 tgz → 重启 → 首次打开；升级时配置是否保留（patch 行不动就保留）；卸载后端口与临时文件去哪了 |
| **故障排查** | 表驱动：症状 → 原因 → 处置（面板空白 / 工具 20 s 超时 / 端口占用 / 截图看不到 / 登录态要重登） |
| **该用哪个工具** | `web_search(site:)` 找 → `web_fetch` 快读 → 读不到 / 要登录 / 要动手才 `browser_open`；附判据表（SPEC-002 B11，文案见 `docs/web-tools-and-agent-browser.md` §4） |

### 2.2 新增 decisions（ADR）

| 文件 | 决策 | 一句话理由 |
|---|---|---|
| `decisions/005-loopback-bridge-over-cdp.md` | 桥用 loopback HTTP 长轮询，不用 CDP | 面板已经是我们自己的 renderer，走 CDP 要重开一个浏览器进程，丢掉 `dshDesktop.browser` 的租约与登录态 |
| `decisions/006-no-reuse-of-browser-use.md` | 不复用官方 browser-use 工具 | 工具由 MCP server 带来（`@playwright/mcp` 等），本机未装且不可裁剪；唯一的官方接缝 `ctx.browserUse` 只是互斥锁。证据链见 `docs/browser-use-contract.md` |
| `decisions/007-single-package-three-roles.md` | 保持单包（host / client / tools 三角色） | 官方 practice 明确"不预防性拆分"；拆包只在需要按预设分发时才有收益 |
| `decisions/008-auth-dynamic-port.md` | 动态端口 + 每进程令牌 + 发现 | 固定 8792 导致双实例串台；只校验 Origin 等于没有校验（TICKET-019 落地后补实测数据） |
| `decisions/009-web-tools-division-of-labor.md` | 不新增搜索类工具；搜索引擎只当失败路径的 URL 解析器 | `ctx.web` 是"发现 + 快读"，面板是"身份 + 动手 + 证据"，两者只在公开静态文章重叠且内置更优；证据链见 `docs/web-tools-and-agent-browser.md`（SPEC-002 B11） |

### 2.3 文档与代码的一致性检查

新增一个可跑的检查（`tools/check-docs.mjs`，进 `npm test`）：

1. README 配置表里的字段名 ↔ `plugin/index.js` 的 `Config` 键，双向差集必须为空；
2. README 工具清单 ↔ `plugin/tools.js` 的工具名，双向差集必须为空；
3. `docs/browser-use-contract.md` 里引用的 `file:line` 仍指向存在的行（行号漂移超过 ±5 就报警，不失败）。

## 3. 单测 / 校验

| # | 检查 |
|---|---|
| 1 | `node tools/check-docs.mjs` 退出码 0 |
| 2 | 配置表示例 YAML 能被真实 `cordis.patch.yml` 解析（用一个最小的 loader 解析器或正则校验缩进） |
| 3 | 五个 ADR 都在 `decisions/README.md`（若存在目录索引）里被列出 |
| 4 | `docs/web-tools-and-agent-browser.md` 被 README 目录与本节 2.1 表格同时引用（B11 验收项之一） |

## 4. 装机验收

| 项 | 做法 | 期望 |
|---|---|---|
| 新人能装上 | 把 tgz 与 README 给一个没参与开发的人 | 20 分钟内装好并打开一个页面；不需要问我们 |
| 改配置不改代码 | 按 README 的 YAML 示例改 `activation` | 行为按预期变化；没有副作用（其余字段值在改之前记下来，改完比对） |
| 故障能自救 | 故意占住端口（若 TICKET-019 未做） | 按排查表能找到原因 |
| Web 版有明确说法 | 在 Web profile 启用插件 | 面板不出现 + 工具返回 `unavailable`，README 说的与实测一致 |

## 5. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 文档写了但没人维护，半年后全烂 | `check-docs.mjs` 进 CI；配置/工具清单以代码为唯一真源 |
| R2 | "桌面限定"让一部分用户直接放弃 | 明写理由（`<webview>` 与租约，见 `docs/browser-use-contract.md`）并给出替代：纯读取场景用内置 `web_fetch` |
| R3 | patch 整行替换的警告会吓到人 | 同时给"照抄全量 config 行"的现成片段，让用户复制即用 |

## 6. 实现记录（2026-11-21，版本 1.3.6）

### 6.1 落地形状

| 项 | 落点 | 说明 |
|---|---|---|
| 用户文档五节 | `dist/dsh-plugin-agent-browser/README.md` | 环境要求（仅 Desktop、Web 版行为与替代方案）/ 安装·升级·卸载 / 配置（⚠️整行替换警告 + 14 字段表 + 全量模板 YAML + 三层来源）/ 该用哪个工具（7 行判据表）/ 故障排查（13 行症状→原因→处置）；已知限制补"取消不撤销已完成动作" |
| ADR 005–009 | `decisions/005`–`009` + `decisions/README.md` | 统一格式：状态 / 日期 / 关联 + 背景 → 决策 → 理由 → 后果；索引表列出 001–009 并写明新增约定 |
| 一致性检查 | `tools/check-docs.mjs` | 六项：配置字段双向（14）、工具名双向（11）、示例 YAML 与 `DEFAULTS` 深比较（9 个顶层字段）、`decisions/` 索引双向（9）、B11 文档被仓库与用户 README 同时引用、`docs/` 内 `path:line` 行号仍在文件范围内（12 条） |
| 检查的负向自检 | `tools/check-docs-negative.mjs` | 逐个注入漂移（改工具名 / 改字段名 / 改 YAML 默认值 / 删索引链接 / 改 B11 路径），必须全部被抓住；结果 **5/5 抓住，恢复后 exit 0** |
| 开发循环 | 仓库 README §下一步 8 | 补"改 Config / 工具名 / 用户 README 后跑 `node tools/check-docs.mjs`；怀疑检查失效就跑负向自检" |

### 6.2 校验结果

| # | 项 | 结果 |
|---|---|---|
| 1 | `node tools/check-docs.mjs` | ✅ 六项全绿，exit 0 |
| 2 | 示例 YAML 解析与默认值比对 | ✅ 自写 YAML 子集解析器（缩进映射 / 标量 / 行内数组 / 映射数组）+ 与 `plugin/config.js` 的 `DEFAULTS` 深比较 |
| 3 | 五个 ADR 都被 `decisions/README.md` 列出 | ✅ 索引双向一致（001–009） |
| 4 | `docs/web-tools-and-agent-browser.md` 双处引用 | ✅ 仓库 README 与用户 README 都有 |
| 5 | 负向自检 | ✅ 5 个漂移全部被抓住，恢复后重新 exit 0 |

### 6.3 偏差与残留

| # | 偏差 | 说明 |
|---|---|---|
| 1 | 没进 `npm test` / CI | 仓库没有根 `package.json`、没有 CI（刻意保持"纯 JS + 手动工具"），只能手动跑；已在 README 开发循环里写成固定步骤 |
| 2 | 第 3 项检查从"行号漂移 ±5 报警"改成"行号必须落在文件范围内" | 原方案的 ±5 会在正常增删段落时天天误报；改为硬边界（引用越界必失败），漂移靠人读 |
| 3 | "新人 20 分钟装好"未做真人验收 | 没有第三方可测；用 `check-docs` + 负向自检 + 本次 1.3.6 重装流程替代，装好后用户可自行按 §安装节复核 |
| 4 | Web profile 行为（面板不出现 + `unavailable`）未实测 | 只在本机 Desktop profile 验过；README 的措辞按代码路径（`dshDesktop.browser` 缺失 → 工具报错）与 ticket 假设写，标为待验 |
| 5 | `check-docs-negative.mjs` 会临时改写 README / 索引 | 逐例恢复原文；异常退出时可能留残留，重跑前可 `node tools/check-docs.mjs` 确认状态 |

