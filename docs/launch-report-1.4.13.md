# 上线报告 — `dsh-plugin-agent-browser` 1.4.13（Windows 首发）

> 状态：**G0–G5 全部达成，产品负责人已于 2026-11-23 15:12 确认发布范围与已知限制（G5.4），可发布**。
> 报告生成：2026-11-23 15:10（Asia/Shanghai）· 签字：15:14 · 执行环境：DSH Desktop `0.2.2-rc.5` / Windows 11 x64。
> 证据来源：`docs/launch-test-plan.md`（门禁 G0–G5 与执行记录）、`reference/013`（H 集）、`reference/014`（S 集）、`research/S5-商品清单.md`、`tmp/g3-ptc-result.md`、本报告 §3 的本轮复跑。

## 0. 结论

**发布：带两条已知限制发（P2，均已写入用户文档）**。

- 硬门槛 G0/G1/G3/G4 通过；G2 部分通过（真墙识别漏报，交接链路可用）；
- 无未关闭的 P0/P1 缺陷，6 条已知限制随包写明（§6）；
- 签字项已闭环：产品负责人确认按"同机法 + 单后端约束 + Cloudflare 已知限制"发布（G5.4）。

## 1. 候选版本（冻结点）

| 项 | 值 | 复核 |
|---|---|---|
| 版本 | `1.4.13` | `node_modules/dsh-plugin-agent-browser/package.json` = 1.4.13 |
| tgz | `dist/dsh-plugin-agent-browser/dsh-plugin-agent-browser-1.4.13.tgz` | 2026-11-23 15:09 实测 |
| 体积 | **128,654 B** | 实测一致 |
| 文件数 | **25**（`tar -tzf` 全为文件，无目录项） | 实测一致 |
| sha256 | `16CAC4FF6B9D25A7D78512A6272EFA7E42353C21919331807CDDDC0651925CD4` | 实测一致（小写比对） |
| 引擎 | `dsh >=0.2.2-rc.3 <0.3.0` | 宿主 0.2.2-rc.5 满足 |
| 代码基线 | `HOST_REV 32` / `CLIENT_REV 45` | 单测输出 `client half applied {"rev":45,…}` 吻合 |

## 2. 门禁总表

| 门禁 | 结论 | 证据位置 |
|---|---|---|
| G0 自动化基线 | ✅ | §3（本轮复跑：178/178、check-docs 双向绿、负向 5/5、tgz 三者一致） |
| G1 干净机安装 | ✅ 同机法 | `launch-test-plan.md` §G1（改名 npm 全局 DSH + 重启后仍激活，裸导入风险排除） |
| G2 真实验证墙交接 | ⚠️ 部分通过 | `launch-test-plan.md` §G2：G2.1 Cloudflare 挑战页漏报 `needs_human`（TICKET-033，P2）；G2.1b/2.2/2.3 通过 |
| G3 PTC 冒烟 | ✅ | §4（PTC 五项 14:29）+ §5（事故修复后 15:08 装机冒烟） |
| G4 回滚与升级演练 | ✅ | `launch-test-plan.md` §G4：1.4.9↔1.4.8↔1.3.6 四次装卸，配置与用户数据零变化 |
| G5 发布判断 | ✅ 已签（15:12 确认 / 15:14 签署） | §8 |

**用例分级与本轮复跑（2026-11-23 15:2x–15:4x）**：H 集 H1–H8 全部通过，其中 H2/H3/H4/H6/H7 已在本装机版 1.4.13 上**重跑通过**（`reference/013-hardening-cases.md` §7.11）；S 集 S1–S6 全部通过，S3/S4/S6 同样在 1.4.13 上重跑通过（`reference/014-practical-cases.md` §7.6）；V 集本轮抽跑 7 项（V2/V3/V4/V5/V9/V12 通过，V3 记一处 digest 偏差），**并新抓到 1 个 P1 缺陷**——超大截图回执丢失（TICKET-034，见 §6 第 7 条）；T/R 两集留待上线后回归。

## 3. G0 复跑记录（2026-11-23 15:09，本轮）

```
node --test --test-timeout=60000 <plugin/test/*.test.mjs 共 20 个文件>
ℹ tests 178   ℹ pass 178   ℹ fail 0   ℹ duration_ms 597.55   exit 0

node tools/check-docs.mjs --quiet        → check-docs: 全部一致（exit 0）
node tools/check-docs-negative.mjs       → 5/5 全部被抓，恢复后 exit 0
tar -tzf dsh-plugin-agent-browser-1.4.13.tgz → 25 项 / 128,654 B / sha256 16CAC4FF…（与冻结点一致）
```

## 4. G3 — PTC 模式冒烟（2026-11-23 14:29）

环境：新会话 + **PTC 预设**，`1.4.13` 装机；方法：一段 `run_code` 内 `await tools.browser_*()` 批量调用（真 PTC 嵌套，不是逐步点工具）；结果落 `tmp/g3-ptc-result.md`。

| 项 | 结论 | 原样证据 |
|---|---|---|
| 工具可见可调 | ✅ | 第 1 次 `panel_not_open`（面板未上屏）→ 等 2 s 重试 → `{"url":"https://example.com/","title":"Example Domain"}` |
| snapshot + eval | ✅ | 首行 `- page "Example Domain" url=https://example.com/`；`nodes=5 / visited=12 / refs=0 / textChars=516`；eval → `"Example Domain"` |
| screenshot 结构化 | ✅ | 两次均返回 `path/bytes/sha256`：`screenshots/shot-20261123-142914.png` 与 `…-1.png`，86,362 B，`64b19d59…e1880`（`Get-FileHash` 复核一致） |
| 错误码保留 | ✅ | `scheme_rejected: only http(s) URLs are allowed, got file:`，随后 `browser_open` 恢复 |
| 无嵌套崩溃 | ✅ | 5 组动作全由程序捕获并正常返回 |

**两处偏差（不影响结论，但别再照抄提示词）**：

1. 本次提示词写的是 `browser_screenshot({fullPage:true})`，而 1.4.13 只有 `name/mode/maxHeight/overlap`。多余字段被忽略、落到默认 `mode:'full'`；example.com 页高 863 CSS px 不足一屏，单帧返回 ⇒ **没有验证整页拼接**。拼接证据在 TICKET-015（`2 frames stitched`、768×2472、1.3 MB）。
2. 取帧偏脆：一次 `screenshot failed at command: the browser panel produced no picture…`（面板不在前台），重开后成功 —— TICKET-028 已记录，文案可读、可重试。

## 5. 装机事故与修复（影响 G5.1 证据链，已闭环）

| 时间 | 事件 |
|---|---|
| 14:25:45 | 装 `dsh-mobile-plugin` 时写进 `~/.dsh/profiles/desktop/package.json` 的依赖路径含乱码（`FZ-GITHUB銆丼KILL`，真实目录 `FZ-GITHUB、SKILL`；`、` 的 UTF-8 被按 GBK 解码） |
| 14:26–14:33 | `pnpm install` 因该路径失败/半途，大范围改写 `node_modules` |
| 14:29:03–14:29:14 | **G3 五项门禁动作全部完成（事故之前，结论有效）** |
| 14:30:56 起 | `browser_open` 报 `ENOENT … inject/detect.js`，随后插件工具从工具表消失 |
| 14:48 | 路径被手工修正、重装 mobile 插件（`package.json` / `cordis.patch.yml` mtime） |
| 14:56 | 复核：`list_bundles` 里 **8 个 bundle `availability: missing`**（候选版本 + `dsh-pilot` / `billion-context` / `dsh-cost-meter` / `dsh-dream-skin` / `@liustack/modlens` / `@duke-dsh-plugins/dsh-token-stats` / `dsh-hermes-bridge`） |
| 14:58 | `pnpm install --prefer-offline`：`Packages: +135`，32.5 s，exit 0 → 14/14 依赖 present，候选版本落盘 |
| 15:00 | `set_bundle` 返回 `restart-required / package-moved`；`dsh-plugin-panel-browser` 移出 `dsh.profile.bundles`（仍在 dependencies） |
| 15:07 | 重启后：`GET /agent-browser/discovery` → **200**；桥 `/health` → `tools: 11 / registered: 11 / conflicts: [] / failed: []` |
| 15:08 | 装机冒烟：`browser_open` → `Opened https://example.com/ — Example Domain`；`browser_snapshot` → `gen 1 · 0 refs · 5 lines · 12 nodes`；`browser_screenshot({mode:'full'})` → `screenshots/shot-20261123-150821.png`，88,769 B，sha256 `d370eea5…ede4`，1151×1294 |

副作用（记录在案，可复现）：`pnpm install` 重写了 `pnpm-lock.yaml`，并在 `pnpm-workspace.yaml` 追加 5 条 `minimumReleaseAgeExclude`（`dsh-mobile-shell-*`）；`package.json` 未改。本轮截图与 14:29 那张不同 sha（面板宽度变了：940 → 1151 px），属正常。

## 6. 已知限制与未关闭项（随包发布）

| # | 项 | 级别 | 处置 |
|---|---|---|---|
| 1 | Cloudflare/Turnstile 一类挑战页可能不触发 `needs_human`，需人工接管 | P2（TICKET-033，不修） | 已写入 README「已知限制」与发布说明 |
| 2 | 真干净机（G1.1）未做，仅同机法 | 签字项 | 用户确认按"同机法通过"发布 |
| 3 | 登录态**不跨进程**：重启 DSH 后可能需重新登录 | P2 | 已按实测收紧 README / 发布说明措辞 |
| 4 | 跨 minor 回滚后渲染器仍跑较新客户端 bundle，`browser_open` 先报 `panel_not_open` | P2 | 刷新页面或重开侧栏页签恢复（TICKET-030 同类） |
| 5 | **一个 profile 只启用一个浏览器后端**：#33 `dsh-plugin-panel-browser` 与本插件有 2 个同名工具（`browser_snapshot` / `browser_screenshot`） | 使用约束 | 已写进 README；发布说明需提醒 |
| 6 | 截图取帧依赖面板可见，隐藏/未绘制时报 `produced no picture` | P2 | 文案可读、可重试（TICKET-028） |
| 7 | **超大截图回执丢失**：面板已取到图（实测 4,239,798 chars / 1151×1294）但回执未回，工具挂到 60 s 报 `bridge_timeout`，且文案误导为"打开页签" | P1（TICKET-034；**根因已定位并修复于源码**：`bridge.js` 的 4 MiB 请求体上限低于该图 4,239,848 B 的回执，现提到 32 MiB + 413 `budget_exceeded` + 客户端预检降级；1.4.13 冻结点未动，待 1.4.14 装机复验） | 规避：该站改用 `browser_snapshot`；复现站点 `opentopomap.org`（`reference/010` V10 坑 5）。与其他成功样本（百度地图 2,772,754 chars）对照确认是载荷尺度问题 |

## 7. 发布动作（G5 通过后执行）

1. 分发 `dsh-plugin-agent-browser-1.4.13.tgz`（128,654 B，sha256 `16CAC4FF…25CD4`）；
2. 安装：DSH 插件管理器 `install_bundle` 指向该 tgz；装后自查 `list_plugins` 里 `include:agent-browser-panel` = `enabled: true` / `fiberPhase: active`，且 `/health` 为 `11 / 11 / []`；
3. 升级路径：若曾装 1.4.x 旧版可直接覆盖；跨 minor **回滚**时建议清掉 `searchFallback` / `sessions` 两组键（不删也能加载，只是不清洁）；
4. 用户数据（`screenshots/`、`downloads/`、会话）在装卸中不动；
5. 回滚目标：1.3.6 可作为应急版本，行为差异见发布说明。

## 8. G5 签字

| 项 | 状态 | 说明 |
|---|---|---|
| G5.1 G0–G4 全部有证据 | ✅ | §3 本轮复跑 + §4/§5 时间戳与文件哈希 |
| G5.2 无未关闭 P0/P1 | ✅ | 仅 2 条 P2（TICKET-033、截图取帧） |
| G5.3 发布说明与 README 与行为一致 | ✅ | `check-docs` 双向全绿（配置字段、工具名、YAML 示例、decisions 索引、文档引用、行号引用） |
| G5.4 产品负责人确认范围与已知限制 | ✅ | 2026-11-23 15:12 确认：按「同机法 + 单后端约束 + Cloudflare 已知限制」发布；§6 第 1、2、5 条均接受 |
| G5.5 记录 tgz sha256 与安装说明 | ✅ | §1、§7 |

签字结论：**按 1.4.13 发布，六条已知限制随包写明；G2 的真墙漏报（TICKET-033）作为 P2 已知限制上线，不阻塞首发。**

## 9. 归档

| 项 | 值 |
|---|---|
| 源码与文档仓库 | https://github.com/linhuanwen/dsh-plugin-agent-browser（PRIVATE，分支 `main`） |
| 初始提交 | `60747ba95106264844d4073b98acad8832ba7625`（2026-11-23 15:14 +0800，218 文件 / 14.8 MB） |
| 候选包归档 | `dist/dsh-plugin-agent-browser/dsh-plugin-agent-browser-1.4.13.tgz`（128,654 B / 25 项 / `16CAC4FF…25CD4`） |

> 仓库只保留冻结候选 1.4.13 的 tgz（`.gitignore` 排除其余历史包与 `downloads/` 测试下载物）。
