# 1.4.x 发布说明（对外分发版）

> 目的：把「装给别人用」这件事说清楚——装什么、怎么升、跟 1.0.x 比哪些行为变了、已知限制与未验证项分别是什么。
> 日期：2026-11-23（版本基线 **1.4.13**；1.4.3 之后的行为变化见 §3 末尾两行）。适用对象：DSH **Desktop**，宿主实测 `0.2.2-rc.5`。
> 相关：用户侧文档见 `dist/dsh-plugin-agent-browser/README.md`；本版工程约束见 `docs/spec/002-official-alignment-spec.md`（B1–B11 全部交付、M1–M5 全部完成）。

## 1. 发布物

| 项 | 值 |
|---|---|
| 包名 / 版本 | `dsh-plugin-agent-browser` @ **1.4.13** |
| 产物 | `dist/dsh-plugin-agent-browser/dsh-plugin-agent-browser-1.4.13.tgz`，128,654 B / 25 文件；sha256 `16CAC4FF6B9D25A7D78512A6272EFA7E42353C21919331807CDDDC0651925CD4` |
| 许可 / 元数据 | `license: MIT`、`private: false`、`engines.dsh: ">=0.2.2-rc.3 <0.3.0"`、peer+dev `@deepseek-ai/schemastery ^3.19.0` |
| 宿主实测 | DSH `0.2.2-rc.5`（Windows 11，Desktop 形态） |
| 单测 | `166 / 166` 通过（`node --test` 全部 `plugin/test/*.test.mjs`） |
| 文档一致性 | `node tools/check-docs.mjs` 六项全绿；`node tools/check-docs-negative.mjs` 5/5 负向自检 |

## 2. 安装 / 升级 / 卸载

```powershell
# 安装或升级（同一命令）
plugin_manager install_bundle target="D:\...\dsh-plugin-agent-browser-1.4.13.tgz"

# 确认激活
plugin_manager list_plugins      # 目标行：include:agent-browser-panel / enabled true / fiberPhase active
```

- 装完**刷新一次 DSH 页面**（客户端 bundle 会随包更新；面板已打开时更保险）。
- 升级保留 profile 里的 `config` 行；若新版本新增字段，未写的字段走默认值。
- 卸载：把 `agent-browser-panel` 条目从 profile patch 删除并重载；包目录可后删。端口随重载释放，`screenshots/`、`downloads/` 是用户数据，不会被删。
- 用 `link:` 安装（开发态 junction）时，改动宿主侧源码需要重启 DSH；改 client 侧源码需要刷新页面。

## 3. 相对 1.0.x 的行为变化（会让人"咦"的地方）

| 变化 | 1.0.x | 1.4.x | 影响 |
|---|---|---|---|
| 桥端口 | 固定 `8792` | **系统分配**（默认 `bridge.port: 0`），面板经宿主发现路由 `/agent-browser/discovery` 拿到地址 | **外部脚本里写死 `127.0.0.1:8792` 会失效**；双实例不再抢端口 |
| 鉴权 | 只校验 Origin | 每进程 **43 字符随机令牌**（Bearer / `x-agent-browser-token` / GET 的 `?token=`）+ Host 精确校验 + 宿主 `connection.admit` 把门 | 外部 curl 无令牌一律 `401/403`；这是一个**安全增强**，不是回归 |
| 本地预览 | `http://127.0.0.1:<随机>/<path>` | `/t/<token>/<path>` + 命中 HTML 时种 HttpOnly `ab` cookie + Host 校验 | 分享出去的预览链接会失效（本来也不该分享） |
| 错误形状 | 字符串前缀 | 13 个稳定 `code`，message 以 `code: …` 开头（模型可读、UI 可分流） | 旧日志里的 `taken_over: …` 现在写作 `panel_taken_over: …` |
| 取消 | 不支持 | `exec.signal` 一路传到面板；排队命令可摘除，已投递的只保证"不再等/不再下发" | 已发到页面的动作**不撤销** |
| Web 卡片 | 纯文本行 | 三张 `tool.call.toolview`：截图缩略图 / open 链接 / 下载摘要（图片走附件 ref） | 首次需刷新页面 |
| 策略 | 散落在工具里 | `policy.js` 统一判定（scheme / 扩展名 / 大小 / 会话名单 / eval 开关）+ `ctx.tools.guard()` | 拒绝类错误都带 code |
| 失败导航 | 可能空树/丢现场 | 面板回上一页、错误带 `nav_*` stage、错误页拒绝快照 | 同站命中率变高 |
| 失败换路 | 无 | `searchFallback`（**默认关**）：失败时附同站候选、`opened: false`、一次失败最多搜 1 次 | 打开会产生搜索计费，见 §5 |
| 截图 | 静默超时 | 先判 `document.visibilityState`；窗口/面板不可见时给可读文案 | 截图前把 DSH 窗口和面板放到前台 |
| 人工接管后浏览（1.4.10–1.4.12） | 人点商品"没反应"、没有后退 | 页面加载即注入守护：`target="_blank"` 改同视图打开、`window.open` 按驾驶方处理；面板工具栏补 **‹ › ⟳** | 人接管后可正常点击/后退/前进/刷新（UI 改动需重启 DSH 一次生效） |
| 挑战页检测（1.4.12 现状） | — | Cloudflare/Turnstile 一类挑战页**可能不触发** `needs_human`（TICKET-033） | 遇到此类页面请人工接管；不要期待自动弹"需要人处理" |

## 4. 配置面

16 个字段，分组：`activation` / `fitWidth` / `evalEnabled` / `claimBrowserUse` / `bridge.{port,requestTimeoutMs}` / `limits.{navigationTimeoutMs,snapshotMaxChars,evalMaxChars}` / `downloads.{dir,maxBytes,extraBlockedExtensions}` / `static.maxBytes` / `sessions.allowlist` / `searchFallback.{enabled,maxResults}`。

- 完整字段表、可复制模板、逐字段说明在用户 README 的「配置」一节；**patch 条目是整行替换，不是深合并**——只写一半字段会把另一半重置为默认。
- **即时生效**（volatile）：`activation`、`fitWidth`、`evalEnabled`、`claimBrowserUse`、`searchFallback.enabled`。
- 其余字段改动会触发插件热替换（桥重启、在飞命令失败）。
- 对外分发建议：把 `evalEnabled` 显式设为 `false`。本版默认仍为 `true`（保持 1.0.x 行为）；关掉后 `browser_eval` 返回 `eval_disabled`，卡死页面的兜底从"注入脚本"退化为"等/刷新/换页"。

## 5. 费用与安全边界（发布方必须转达）

- `searchFallback` 打开后，每次失败最多 1 次宿主搜索调用。宿主 `dsh-web` 的计费口径约 **5 元 / 1000 次**；本机默认 route 会落到计费的 `deepseek-search-api`。想走"不按次计费但吃模型 token"的档，需要宿主侧把 `dsh-web` 的 `searchProvider` 配成 `deepseek-official`。
- 插件不绕过人机验证、不输入密码；密码框一律拒绝。
- 下载默认拒绝 26 个可执行类扩展名；从本机地址下载也会被拒。
- 面板使用用户自己的登录态，天然带"用户身份"——这也是它相对 `web_fetch` 的价值与风险来源。

## 6. 已知限制

1. **桌面限定**：依赖 Electron `<webview>` 与 `dshDesktop.browser` 租约。Web 形态下没有面板、工具会返回 `panel_not_open`/`unavailable`；纯读取请用内置 `web_fetch`。
2. **取消不撤销**：已发到页面的点击/输入不会被收回，`cancelled` 文案明确要求"重新读页面再动手"。
3. **截图依赖可见**：面板页签没显示或 DSH 窗口被遮挡时取不到帧，给明确报错（TICKET-028 之后不再裸抛 Electron 内部错误）。
4. **本地预览只能服务工作区内文件**（`browser_open({path})`），不是任意文件服务器。
5. **帧率/位置**：`browser_zoom` 缩放后坐标一律按当前视口 CSS 像素解释，不自动换算。
6. **`sessions.allowlist` 默认空**（所有会话可用）；多人共用一台机器时应显式配置。
7. **令牌在渲染进程内存里**、静态 cookie 不按端口隔离、`/health` 不返回令牌——这些是已知残留（`docs/decisions/008`）。
8. **真实验证墙可能漏报**：Cloudflare/Turnstile 比"验证码拦截"类页面更难识别，可能不触发 `needs_human`（TICKET-033，P2 未修）；此时 agent 会把挑战页当普通页继续尝试，请人工接管（面板「我来接管」）。
9. **登录态不保证跨进程**：登录 cookie 留在面板会话里，同一进程内跨页面/跨插件重装保持；**重启 DSH 后可能需要重新登录**（2026-11-23 实测：重启后 1688 首页回到未登录）。

## 7. 未验证项清单（如实披露）

| # | 项 | 现状 |
|---|---|---|
| 1 | PTC 场景端到端（作为 PTC 工具被嵌套调用） | **未实测**。`docs/spec/002` U3 已关闭（B7 不迁 `defineTool`，该问题不再影响交付）；工具定义的 lossless JSON 由 `plugin/test/tooldefs.test.mjs` 覆盖 |
| 2 | Web 形态（非 Desktop） | 未实测；按代码路径写作"桌面限定"，用户 README 已标注 |
| 3 | 三张过程卡片的**视觉**效果 | ✅ 2026-11-22 用户目视确认（缩略图/链接/下载摘要三张卡都正常渲染；H5 记录见 `docs/cases/013-hardening-cases.md` §7.6） |
| 4 | 第三方插件注册同一 slot | 未在第三方包场景验证（`tool.call.toolview` 的 key 必须等于工具名） |
| 5 | macOS / Linux | 未测（当前只在 Windows 11 验证；路径与 `<webview>` 行为可能不同） |
| 6 | `dsh-web` 缺失时的降级 | 宿主依赖不能卸；用单测 `getWeb: () => null` 覆盖，真机未验 |
| 7 | 取消的 GUI 手测（由人按停止） | ✅ 2026-11-22 实测（H1：在飞导航 15 s 处点停止 → `cancelled`、面板回上一页；`docs/cases/013` §7.7） |
| 8 | 截图 hidden 分支（TICKET-028 修复后） | ✅ 2026-11-22 实测（S2：最小化窗口 → `hidden` 明确报错；`docs/cases/014` §7.4） |
| 9 | 下载策略检查时机 | `checkTarget` 在读完 body 后才调用：超大文件会先耗带宽（硬上限仍由 `readCapped` 兜） |
| 10 | 真实验证墙自动识别 | ⚠️ 部分验证（2026-11-23 G2 + S5）：1688「验证码拦截」能触发并完成交接续跑（S5 L3）；Cloudflare/Turnstile 挑战页漏报（TICKET-033） |

## 8. 发布检查清单（可复跑）

```powershell
cd "D:\Vibe coding\32 deepseek harness cebiankuang"

# 1) 单测（必须 178/178）
$files = Get-ChildItem plugin/test/*.test.mjs | ForEach-Object { $_.FullName }
node --test $files

# 2) 用户文档 ↔ 代码一致性（六项）+ 负向自检（5/5）
node tools/check-docs.mjs
node tools/check-docs-negative.mjs

# 3) 打包（产物进 dist/，同时做 node --check）
node tools/pack.mjs

# 4) 装机 + 激活确认
plugin_manager install_bundle target="D:\Vibe coding\32 deepseek harness cebiankuang\dist\dsh-plugin-agent-browser\dsh-plugin-agent-browser-1.4.13.tgz"

# 5) 冒烟：发现路由必须 401（不是 404）、工具能开页面
Invoke-WebRequest -Uri 'http://127.0.0.1:<gui-port>/agent-browser/discovery' -UseBasicParsing
#   → 401（未带宿主 cookie 时）
browser_open https://example.com/
browser_snapshot maxChars:600
```

## 9. 回滚

- `dist/dsh-plugin-agent-browser/` 里保留 1.0.3 起的全部 tgz，直接 `install_bundle` 旧包即可回滚。
- 跨版本回滚时建议**同时删掉旧版本不认识的配置字段**（清洁起见；1.4.9 实测旧版会静默忽略未知键、不阻塞加载）：
  - 回滚到 `< 1.3.5`：删 `sessions`、`downloads.extraBlockedExtensions`
  - 回滚到 `< 1.4.0`：删 `searchFallback`
  - 回滚到 `< 1.2.0`：删 `bridge` 组（旧版客户端硬编码 8792，配置 `port: 0` 会连不上）
- 回滚后重载插件、刷新页面，并确认 `include:agent-browser-panel` 的 `fiberPhase` 为 `active`。跨 minor 回滚后渲染器可能仍持有较新的客户端 bundle，表现为 `panel_not_open`，刷新页面或重开侧栏页签即可。
- 回滚演练记录（2026-11-23）：1.4.9 → 1.4.8 → 1.4.9 → 1.3.6 → 1.4.9 四次装卸全部 `applied`，两份 `cordis.patch.yml` 的 sha256 与 `screenshots/`、`downloads/`、`sessions/` 计数均未变化；详见 `docs/release/launch-test-plan.md` 的 G4 执行结果。
