# 决策 007：保持单包（host / client / 资源三角色）

> 状态：`已定`（发布形态：一个 `dsh-plugin-agent-browser` 包，`dsh.bundle.patch` + `dsh.client` + `exports` 六出口）。
> 日期：2026-11-21 归档。
> 关联：`docs/spec/002` B10 第 2 条、`docs/tickets/025-docs-and-decisions.md`、`plugin/cordis.patch.yml`。

## 背景

插件在运行时扮演三个角色：

1. **host 半侧**：`plugin/index.js` + `apply.js`，注册工具、起桥、起静态服务、注册发现路由（Loader 条目 `agent-browser-panel`）。
2. **client 半侧**：`plugin/client.js`，注册右侧栏 tab、面板 body、三个 `tool.call.toolview` 卡片（`dsh.client` 指向 `./client`）。
3. **资源/文档**：`locale/*.json`、`icon.svg`、`README.md`、`docs/DETAIL.md`、`docs/preview.svg`（`exports` 六出口）。

一个自然的诱惑是拆成三个包（host / client / 资源），以便按 Agent 预设分别分发。

## 决策

**保持一个包。** 不拆分，也不在包内做"预防性的模块切分"。

## 理由

1. **官方口径**：`develop/practice` 原文明确"不预防性拆分"，分拆的触发条件是"角色需要独立演进"，不是"将来可能有人想单独装"。
2. **拆了也拿不到想要的效果**：客户端 bundle 只随**已启用的 Loader 条目**提供（`dsh-client-modules` 的 boot 图就是从 Loader 条目扫出来的），把 host 半边挪进预设并不能让 client 半边跟着走——要拆必须拆成两个 Loader 条目，而预设机制对"客户端 entry"没有独立开关。这条在 `docs/design/browser-use-contract.md` 与 `docs/design/official-docs-review.md` #10 都有记录。
3. **三角色共享同一份常量**：`CLIENT_REV`/`HOST_REV` 的版本对齐、错误码表、配置默认值，拆包后要么复制粘贴（漂移），要么再加一个公共包（多一层依赖）。

## 后果

- 包内文件继续按角色分目录（`inject/`、`locale/`、`docs/`），但**不引入子包边界**。
- 如果将来真的要按预设分发：触发条件是"需要在同一个 profile 里并存两个面板实现"或"client 半边需要独立热更新"；届时按两 Loader 条目拆分，并接受"面板不再随预设启停、只能随 profile 启停"的代价——这一点已经写在 `docs/design/official-docs-review.md` #10 的风险栏里。
