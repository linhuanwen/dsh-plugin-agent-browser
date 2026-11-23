# TICKET-016 配置面：把可调参数变成配置字段

- **状态**：✅ 已完成（1.1.1 装机验收通过，2026-11-21；验收期发现并修掉一处策略被吞的真 bug，见 §6.3）
- **优先级**：P0（发布前必修；含一处真 bug）
- **来源**：`docs/official-docs-review.md` #1（官方 `develop/basic/config`："凡是不同部署可能需要采用不同值的参数，都必须定义为配置字段"）
- **对应验收**：`spec/002-official-alignment-spec.md` B1
- **关联**：TICKET-019（`bridge` 分组的最终形状取决于传输方案）

## 1. 问题

三件事混在一起：

1. **8 个部署相关参数全是硬编码**（清单见 `docs/official-docs-review.md` #1）：桥端口 8792 出现在 `plugin/bridge.js:19` 与 `plugin/client.js:40` 两处、请求超时 20 s（`bridge.js:25`）、导航超时 45 s（`tools.js:145`）、快照/eval 预算 8000（`tools.js:257` / `:986`）、下载 50 MiB（`downloads.js:22`）、静态服务 32 MiB（`static.js:18`）、下载目录 `downloads`（`downloads.js:31`）。用户想换任何一条，只能改代码重打包。
2. **`fitWidth: false` 现在是死配置**。`plugin/index.js:82` 调 `createTools(ctx, bridge, sites, activation)` 只传了 4 个参数，而 `plugin/tools.js:1502` 的签名是 `createTools(ctx, bridge, sites, activation, fitWidth)`；`undefined` 落进 `:1504` 的 `fit === 'none'` 判断，恒为 `'width'`。A19 的"可关"从来没生效过（用户没试过，所以没暴露）。
3. **没有 eval 开关**。`browser_eval` 是页面内任意 JS，分发场景应当默认关掉、由用户显式打开。

## 2. 修法

### 2.1 新配置面

`plugin/index.js` 的 `Config`（现在只有 `activation` / `fitWidth`，`:28-39`）扩成四组 + 两个开关：

```js
export const Config = z.object({
  // 热切换（volatile：不重启插件，用 .get() 读）
  activation: z.string().default(DEFAULT_ACTIVATION).volatile()
    .description(`When the panel may open itself: ${ACTIVATIONS.join(' / ')}.`),
  fitWidth: z.boolean().default(true).volatile()
    .description('Shrink the page so its layout fits the panel (no sideways scrolling).'),
  evalEnabled: z.boolean().default(true).volatile()
    .description('Allow browser_eval to run page JavaScript. Turn off when handing the plugin to other people.'),
  claimBrowserUse: z.boolean().default(true).volatile()
    .description('Claim the browserUse slot while this plugin owns the panel (see docs/browser-use-contract.md).'),

  // 改后需重载插件
  bridge: z.object({
    port: z.natural().default(8792).description('Loopback port of the host↔panel bridge. 0 lets the OS choose.'),
    requestTimeoutMs: z.natural().default(20_000).description('How long one command may wait for the panel.'),
  }).default({}),
  limits: z.object({
    navigationTimeoutMs: z.natural().default(45_000),
    snapshotMaxChars: z.natural().default(8000),
    evalMaxChars: z.natural().default(8000),
  }).default({}),
  downloads: z.object({
    dir: z.string().default('downloads').description('Workspace-relative directory for browser_download output.'),
    maxBytes: z.natural().default(50 * 1024 * 1024),
  }).default({}),
  static: z.object({
    maxBytes: z.natural().default(32 * 1024 * 1024).description('Largest single file the local static server will send.'),
  }).default({}),
})
```

嵌套对象的默认值若在 schemastery 下不自动填充（`z.object(...).default({})` 对缺省行的行为要用单测钉住），退回扁平键（`bridgePort`、`snapshotMaxChars`…）并同步改 `spec/002` 的字段表——**不猜，先测**。

### 2.2 管线接法

| 文件 | 改动 |
|---|---|
| `plugin/index.js` | `apply` 里把四组配置解出来；`new Bridge({ port, requestTimeoutMs, ... })`、`new StaticSites({ maxBytes: config.static.maxBytes })`；`createTools(ctx, bridge, sites, { activation, fitWidth, limits, downloads, evalEnabled }, claimRef)` |
| `plugin/tools.js` | `createTools` 第 4/5 参改为一个 `policy` 对象；`45_000` / `8000` / `8000` 三处换成 `policy.limits.*`；删除 `:1504` 对 `fitWidth === false` 的直接判断，改为每次读 `policy.fitWidth.get()` |
| `plugin/bridge.js` | `Bridge` 构造函数接受 `port` / `timeoutMs`，模块级 `BRIDGE_PORT` / `DEFAULT_TIMEOUT_MS` 保留为默认值导出（`plugin/client.js` 仍要读端口，见 TICKET-019） |
| `plugin/static.js` | `StaticSites` 构造函数接受 `maxBytes`，默认仍是 32 MiB |
| `plugin/downloads.js` | `MAX_BYTES` / `DOWNLOADS_DIR` 变成参数（`resolveTarget(dir, name, maxBytes)`、`ensureDownloadsDir(root, dir)`），常量保留为默认值导出，现有 18 例单测不动 |
| `plugin/client.js` | 本轮**不改**；端口下发在 TICKET-019 一次做完 |

### 2.3 volatile 的读法

volatile 字段是"稳定引用的读取器"，不是值：`apply` 时拿到 `config.activation`，之后一律 `config.activation.get()`。因此 gate 不能在 `apply` 时把 `activationPolicy` 快照死，而要：

```js
const gate = {
  request: (sessionId, type, params, timeoutMs) =>
    bridge.request(sessionId, type, params, timeoutMs, {
      show: activationPolicy(policy.activation.get()).show(),
      fit: policy.fitWidth.get() === false ? 'none' : 'width',
    }),
}
```

## 3. 单测

| 文件 | 用例 |
|---|---|
| 新增 `plugin/test/config.test.mjs` | ① 缺省 `Config({})` 得到 8 个默认值；② 只写 `{ activation: 'manual' }` 不改动其余默认；③ 非法值（`bridge.port: -1`、`snapshotMaxChars: 'x'`）被 schema 拒绝而不是静默变 0；④ volatile 字段解析后 `.get()` 返回默认值、且对象身份稳定（连续两次 `.get()` 相等） |
| `plugin/test/shots.test.mjs`（存量） | 不变 |
| 新增 `plugin/test/policy.test.mjs` | `fitWidth.get()` 为 `false` 时 gate 产出的 `fit` 是 `'none'`；`true`/缺省是 `'width'`（用假 bridge 记录第 5 个参数即可，不需要 webview） |

## 4. 装机验收

| 项 | 做法 | 期望 |
|---|---|---|
| 配置真的生效 | 在 profile 的 `cordis.patch.yml` 给插件行加 `config: { limits: { snapshotMaxChars: 3000 } }`，重载插件，`browser_snapshot` 不传 `maxChars` | 返回被截断到 ~3000 字符，日志里的 `host half applied` 打出新值 |
| 热切换不重启 | 面板开着时把 `activation` 改 `manual`（configEditor 或改文件后重载行） | 不出现第二次 `host half applied`；下一次需要页面的动作直接报 `manual` 原因 |
| `fitWidth: false` 真生效 | 改成 `false` 后打开一个 1200px 宽的站 | 页面按 100% 渲染、出现横向滚动；日志里 `command.fit` 是 `'none'` |
| eval 关掉 | `evalEnabled: false`，调 `browser_eval` | 被拒且错误 `code: 'eval_disabled'`（错误码形状见 TICKET-020；本轮可先返回明确文案） |

## 5. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 改普通字段触发插件热替换（桥断、webview 重建），用户以为卡死 | 文档写清；需要边用边切的四个字段做成 volatile；`host half applied` 日志上加 `rev` 便于识别重载 |
| R2 | 嵌套对象默认值在 schemastery 下不填 | §2.1 已给退路（扁平键）；单测 ① 先红后绿 |
| R3 | `createTools` 签名从 4 参变 5 参，`dist/` 与 `plugin/` 不同步 | 只改 `plugin/`，`tools/pack.mjs` 重新生成 `dist/`；CI 里 `node --check` 已覆盖语法 |
| R4 | 端口可配但 client 仍写死 8792 | 明确写"端口在 TICKET-019 之前只有默认值可用"，避免发布半成品 |

## 6. 实现记录（2026-11-21，1.1.1 装机验收）

### 6.1 落地形状

| 文件 | 实际改动 |
|---|---|
| 新增 `plugin/config.js` | `DEFAULTS`（四个 volatile + `bridge{port,requestTimeoutMs}` + `limits{navigationTimeoutMs,snapshotMaxChars,evalMaxChars}` + `downloads{dir,maxBytes}` + `static{maxBytes}`）、`readField(value, fallback)`（兼容 `{get()}` 读取器）、`natural()/text()` 校验、`normalizeConfig()` 全量补默认 |
| 新增 `plugin/apply.js` | `HOST_REV = 29`；`applyAgentBrowser(ctx, config, overrides)`：建桥/静态服务、`createClaim`（`ctx.get('browserUse')?.register(...)`）、gate 包装、**单个** `ctx.effect`（供 TICKET-017 复用） |
| `plugin/index.js` | 只留 schemastery `Config`（四组 `z.object({...}).default({})`、四个 `.volatile()`）+ `apply` 转调 |
| `plugin/bridge.js` | 构造接受 `requestTimeoutMs`（默认仍 20 s）；`static.js` 接受 `maxBytes`；`downloads.js` 的 `ensureDownloadsDir/readCapped/downloadTo` 接受 `dir/maxBytes` |
| `plugin/tools.js` | 新增导出 `createGate(bridge, policy)`：每条命令现读 `activation`/`fitWidth`；`createTools(ctx, bridge, sites, policy)`（第 4 参由 `activation` 改为 `policy` 对象，`fitWidth` 不再丢失）；`browser_snapshot`/`browser_eval`/`browser_open`/`browser_download` 的预算从 policy 取 |
| `tools/pack.mjs` | `COPY` 白名单加入 `apply.js`、`config.js`（13 项），否则 dist 缺文件 |

### 6.2 单测

`node --test plugin/test/{config,policy,lifecycle,bridge}.test.mjs` 共 15 例；全量 **tests 98 / pass 98 / fail 0**（含存量）。`config.test.mjs` 5 例覆盖默认值与非法值，`policy.test.mjs` 3 例钉住"每命令重读读取器"，`bridge.test.mjs` 3 例覆盖 `close()`。

**已知边界**：schemastery 只在 `app.asar` 内且依赖 `@deepseek-ai/cosmokit`，plain `node` 无法 import，故 **schema 层的默认填充/非法值拒绝没有单测**，由装机验收覆盖（见 §6.4 第一行与改坏配置的行为）。

### 6.3 验收期发现并修掉的真 bug（1.1.0 → 1.1.1）

`apply.js` 里包 claim 的 gate 原来写成 `request: async (sessionId, type, params, timeoutMs) => bridge.request(...)`，4 个形参把 `createGate` 传进来的第 5 个参数 `{ show, fit }` 吞掉了 —— 结果是 **所有命令永远走默认 activation 与 width 适配**，`fitWidth: false` 依然无效（与 §1 第 2 条同症状、不同根因）。修复为透传 `options`，并补 `lifecycle.test.mjs` 第 5 例（assert 第 5 参原样到达 bridge）。

### 6.4 装机验收（实测）

验收办法：在 `C:\Users\林焕文\.dsh\cordis.patch.yml` 给 `agent-browser-panel` 加 `config` 行，靠 profile 层的文件监听重载；**验收后该 config 行已删除**，插件已回到默认值（快照 7.8 KB / eval 可用）。

| 项 | 实际操作 | 实测结果 | 结论 |
|---|---|---|---|
| 配置生效（非 volatile） | `limits.snapshotMaxChars: 3000`，对 Wikipedia「Web browser」不传 `maxChars` | `2.8 KB · 521 nodes walked` + "tree cut at the character budget"；删掉该配置后同一页 `7.8 KB · 909 nodes` | ✅ 截断预算确实从部署配置读 |
| 热切换不重启（volatile） | 面板开着时把 `fitWidth: false → true`、`evalEnabled: true → false` | 等 4 s 后 `/health` 计数 `enqueued=7 / pulled=7` 连续增长到 `9 / 9`（**未重置 = 未重启**）；下一条命令立刻按新值工作 | ✅ volatile 就地更新 |
| `fitWidth: false` 真生效 | 100% 缩放下开 `Comparison_of_web_browsers`（宽表页） | `innerWidth 767`、`scrollWidth 1172`、`hscroll: true`；bridge `/logs` 无 `fit width`。改回 `true` 后同一页出现 `fit width {"panel":767,"zoom":0.54,"fits":true}`、`hscroll: false` | ✅ 修复后 1.0.x 的死配置真正可关 |
| eval 关掉 | `evalEnabled: false`，调 `browser_eval` | `Error: eval_disabled: browser_eval is switched off by this installation (evalEnabled: false)` | ✅ |

### 6.5 打包注意（踩过一次）

用 `Set-Content -Encoding utf8` 改 `dist/.../package.json` 会写出 **BOM**，DSH 安装校验 JSON 解析直接失败：`Cannot validate installed package dsh-plugin-agent-browser: SyntaxError: Unexpected token '﻿'`（并自动回滚 node_modules/package.json/pnpm-lock.yaml）。修法是 `[IO.File]::WriteAllText($p, $text, (New-Object Text.UTF8Encoding($false)))`，之后 1.1.1 安装成功。
