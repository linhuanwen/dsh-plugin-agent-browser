# 决策 006：不复用官方 browser-use 工具

> 状态：`已定并实现`（`plugin/tools.js` 自写 11 个工具）。
> 日期：2026-11-21 归档（证据链见 `docs/design/browser-use-contract.md`，2026-11-20 取证）。
> 关联：`docs/design/browser-use-contract.md`、`docs/tickets/019-bridge-auth-and-discovery.md`、`docs/spec/002` B11。

## 背景

DSH 生态里有官方浏览器工具链：`@deepseek-ai/dsh-browser-use` + `@deepseek-ai/dsh-experimental-browser-use-runtime`。直觉上应该复用它，而不是自己写一套工具。于是先把契约读穿，再决定。

## 取证（逐行读过 npm 上的同版本 tarball）

| 事实 | 证据 |
|---|---|
| `dsh-browser-use` 只是**一把进程级互斥锁**：48 行的 `BrowserUseRegistry extends Service`，唯一方法是 `register(name) => release` | `dsh-browser-use/src/index.ts`（48 行全文） |
| 真正的浏览器工具由 runtime 桥接的 **MCP server** 提供，工具集由 MCP server 决定 | `dsh-experimental-browser-use-runtime` 的 `SessionResources` + `@playwright/mcp@0.0.80` 等 |
| 本机**没有装**这一族：asar 全文 0 命中，profile 的 `node_modules` 只有本插件与 `playwright-core` | `tools/asar.mjs grep` 结果；`C:\Users\林焕文\.dsh\profiles\desktop\node_modules` |
| 要装也只能装"另一份 DSH 的副本"或另起 MCP server 进程，工具清单不可裁剪（官方给的 MCP 工具集是固定的） | `docs/design/browser-use-contract.md` §「为什么不能直接复用」 |
| 复用后**面板会消失**：MCP 驱动的是它自己启动的浏览器，不是右侧栏里用户看得见的那个 webview | 同上；且会丢掉登录态 |

## 决策

不复用官方 browser-use 工具，自写 11 个工具；只借用它**唯一值得借的那一半**——互斥锁：`claimBrowserUse` 配置（默认开）时，通过 `ctx.get('browserUse')?.register('agent-browser-panel')` 占住 slot，避免第二个浏览器提供者同时驱动页面；seam 不存在时零成本降级。

## 理由

1. 复用的前提是"能拿到同样的浏览上下文"，而官方工具链给的是**另一个浏览器进程**，与"右侧栏可见面板 + 用户可接管 + 登录态复用"这个产品定义冲突。
2. 工具集由 MCP server 固定提供，无法按本插件的产品需要裁剪（我们只需要 11 个，且要中英文文案、结构化错误码、过程卡片）。
3. 互斥锁那一半确实有价值（防止两套工具抢同一个页面），所以只借它。

## 后果

- 工具面自己维护：契约锁定测试（`plugin/test/tooldefs.test.mjs`）、错误码体系（TICKET-020）、取消（TICKET-021）都要自己做——已在做。
- 上游若把 browser-use 改成"驱动宿主面板"的形态，本决策需要重审；触发条件写在 `docs/design/browser-use-contract.md` 的「重审触发条件」。
- `claimBrowserUse` 是**软锁**：不装 browser-use 包时 `register` 直接降级为 no-op，不影响本插件启动。
