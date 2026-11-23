# 决策 005：面板通道用回环 HTTP 长轮询，不用 CDP

> 状态：`已定并实现`（1.2.0 起稳定；`plugin/bridge.js`）。
> 日期：2026-11-21 归档（原始判断在 2026-11-20 建包时就已成立）。
> 关联：`docs/spec/001-agent-browser-plugin-spec.md` §3、`docs/tickets/019-bridge-auth-and-discovery.md`、`docs/design/browser-use-contract.md`。

## 背景

面板里的页面是我们自己的 Electron `<webview>`，已经挂在 DSH 桌面端的 renderer 里，并且已经拿到 `globalThis.dshDesktop.browser` 的租约（同一时刻只允许一个浏览器提供者）。Agent 需要一条从 host 侧（插件进程内）到 renderer 侧（面板）的命令通道。

候选有三条：

| 方案 | 做法 | 代价 |
|---|---|---|
| A CDP | host 侧起一个 Chrome DevTools Protocol 客户端，直接连页面的调试端口 | 需要在 Electron 里开远程调试端口，或者另起一个受控 Chromium；两种都会绕开 `dshDesktop.browser` 的租约，登录态要重新登，且面板就不再是"用户看得见的那一个浏览器" |
| B CDP over `webContents.debugger` | 用 Electron 主进程的 `webContents.debugger.attach()` 下发 CDP | 需要主进程侧能力（插件没有这个接缝），且协议面大、错误语义自己实现对不齐 |
| C 回环 HTTP 长轮询 | host 侧 listen 在 `127.0.0.1` 随机端口，renderer 用 `fetch` 轮询取命令、回结果 | 一次往返最多多等一个轮询间隔；但零新依赖、不用改 Electron 配置、租约与登录态原样保留 |

## 决策

选 **C**：`plugin/bridge.js` 在 `127.0.0.1` 上起一个 HTTP 服务，命令入队，面板长轮询 `GET /pending?wait=…` 取走，执行完 `POST /settle` 回包。轮询间隔在面板可见时 100 ms、隐藏时 500 ms，长轮询最多挂 900 ms。

## 理由

1. **租约和登录态是这个插件存在的理由**。走 CDP 等于换一个浏览器，用户要重新登录、人机验证要重过，插件就退化成一个新的 Playwright。
2. **通道只需要"命令 + 结果"**，不需要 CDP 的 DOM/网络/生命周期全套能力——页面内的 DOM 遍历和动作注入本来就用 `executeJavaScript` 做（见 `plugin/inject/*.js`），通道只负责把命令送过去。
3. **零依赖**：`node:http` 是标准库；renderer 侧 `fetch` 也是标准能力。
4. 轮询间隔的代价可接受：命令本身动辄几十到几百毫秒，多 100 ms 不改变使用感受；真正的延迟大头在页面加载。

## 后果

- 通道必须自己解决鉴权：回环地址不是边界（本机任何进程都能连）。1.2.0 起用"每进程 43 字符随机令牌 + Host 精确校验"，发现令牌经宿主认证路由下发（决策 008）。
- 通道是"半双工 + 轮询"，没有服务端推送能力；面板在后台时延迟变成 500 ms 量级。若将来需要事件流（例如页面错误实时上报），再评估 SSE/WebSocket，但**不改变"不换浏览器"这条**。
- `bridge.js` 的清理必须显式：`close()` 要 reject 在飞命令、销毁挂起的长轮询（TICKET-017/021 已落地），否则重载插件会留一个占着端口的僵尸服务。
