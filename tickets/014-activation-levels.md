# TICKET-014 面板激活档位 + 挑战识别加固

> 优先级：P1
> 状态：`✅ 已完成并装机`（代码 1.0.27，包文档 1.0.28，`HOST_REV 27` / `CLIENT_REV 27`，2026-11-20）
> 关联：`decisions/004-activation-and-challenge-detection.md`（D19 / D20）、`spec/001-agent-browser-plugin-spec.md` §10 A18 与「A8 补强」、`reference/011-task-cases.md` 缺口 8

---

## 1. 问题

两件事在 2026-11-20 一起暴露：

1. **面板开不开没有选择权**。`client.js` 的 `dispatch()` 只要本会话还没有 runner 就 `openTabIn`，也就是"第一次碰页面就展开右栏"；反过来，用户想让它别打扰时没有开关，想让它每次都亮出来时也没有开关。用户原话：「可以在插件里面写选项等级，可以设置全开，也可以默认按照现在的情况来」。
2. **滑块页没被认出来**。1688 首页落到 title「验证码拦截」、正文「请按住滑块，拖动到最右边」的阿里滑块页，`inject/detect.js` 判成普通页面，agent 继续往下点。

## 2. 修法

| 层 | 改动 |
|---|---|
| 配置 | `index.js` 导出 `Config = z.object({ activation: z.string().default('auto') })`（`@deepseek-ai/schemastery`），`apply(ctx, config)` 读它；日志行打 `host half applied (rev 27, activation=auto)` 便于核对 |
| 策略 | 新增 `activation.js`：`ACTIVATIONS`、`DEFAULT_ACTIVATION`、`normalizeActivation`（未知值回落 `auto`）、`showFor`（`auto→once` / `always→always` / `manual→never`）、`activationPolicy` |
| 下发 | `bridge.request(…, options)` 把 `show` 写进 command；`tools.js` 的 `createTools(ctx, bridge, sites, activation)` 建一个 `gate.request`，9 个走桥的工具都经它；`browser_download` 不经过 |
| 生效 | `client.js` `dispatch`：`show:'always'` 时即使有 runner 也 `openTabIn`；`show:'never'` 且没有 runner 时直接 `settle({ok:false, error:…activation="manual"…})`，不等 `MOUNT_GRACE_MS` |
| 识别 | `detect.js` 补标题词、滑块选择器、滑块文案；新增降级命中 `textOnly = kinds.length === 1 && categories.text && interactive <= 3` |
| 打包 | `tools/pack.mjs` 的 `COPY` 加 `activation.js`；`package.json` 的 `files` 加同名项，并声明 `peerDependencies: {"@deepseek-ai/schemastery": "*"}` |

## 3. 单测

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `plugin/test/activation.test.mjs` | 6 | 三档 → `show` 映射、未知值回落、非字符串回落、`manual` 不展开 |
| `plugin/test/detect.test.mjs` | 6 | 1688 真实滑块（title「验证码拦截」+ 正文「请按住滑块，拖动到最右边」→ `categories=['location','text']`、`hit:true`）、帮助页不算墙、纯文本少控件降级命中、正常站不误报 |

全量：`node --test plugin/test/actions.test.mjs plugin/test/downloads.test.mjs plugin/test/static.test.mjs plugin/test/activation.test.mjs plugin/test/detect.test.mjs` = **71 tests / 71 pass**。

> 注意：`node --test plugin/test/` 传目录会把 `smoke-download.mjs` 当测试文件而失败，必须显式列 `.test.mjs`。

## 4. 装机验收

| 步骤 | 结果 |
|---|---|
| `node tools/pack.mjs` | `1.0.27.tgz 70,638 B` → `1.0.28.tgz 70,653 B`，均 17 文件 |
| `plugin_manager install_bundle` | `{"stage":"enable","application":"applied"}`，pnpm 1.0.26 → 1.0.27 → 1.0.28 |
| 插件是否还能加载（`schemastery` 依赖） | 桥接日志 `host half applied (rev 27) {"activation":"auto"}`、`client half applied {"rev":27,"tabs":true,"sidebar":true,"openTabIn":true}` |
| 档位是否真到面板 | `dispatch {"id":"c1","type":"eval","session":"session-…","runner":true,"show":"once"}` |
| 加固后是否误报 | `browser_open('https://example.com/')` + 快照 → `1 refs · 8 lines · 866 B`，相位仍是 `idle`（没被误判成 `needs_human`） |

## 5. 残留

- `manual` / `always` **未做端到端**：需要改 profile 的 `cordis.patch.yml` 配置行并重载插件，为避免把用户配置改坏而只做了单测 + 代码路径覆盖。要验证时改这一行即可：
  ```yaml
  - id: agent-browser-panel
    config:
      activation: manual
  ```
- `activation` 只影响**是否展开**，不影响"右栏隐藏时标签拿不到 body"这个结构性限制：`manual` 会把失败提前并说清楚，但不会让 agent 在隐藏面板里后台跑。
- 识别加固是启发式的：新厂商的滑块（极验 v4、腾讯验证码新版）可能换文案，届时按同样的四处（标题词 / 选择器 / 文案 / 降级阈值）继续补。
