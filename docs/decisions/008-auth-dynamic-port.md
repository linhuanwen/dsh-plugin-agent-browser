# 决策 008：动态端口 + 每进程令牌 + 宿主发现路由

> 状态：`已定并实现`（1.2.0 → 1.2.1 修纯文本误判；1.3.5 仍在用）。
> 日期：2026-11-21 归档。
> 关联：`docs/tickets/019-bridge-auth-and-discovery.md`、`docs/tickets/026-plaintext-detect-false-positive.md`、`docs/design/official-docs-review.md` #2。

## 背景

1.0.x 的通道有两个硬编码与两个空洞：

| 问题 | 代码位置 |
|---|---|
| 端口死写 8792（host 与 client 各一份常量） | `plugin/bridge.js` 的 `BRIDGE_PORT`、`plugin/client.js` 的 `BRIDGE_URL` |
| 同机第二个 DSH 实例 bind 失败（20 s 超时），client 还可能连到**另一个实例**的桥 | 同上 |
| 桥只校验 `Origin`，没有凭证 | `plugin/bridge.js` 的 `isPanelOrigin` |
| 静态服务随机端口、零鉴权 | `plugin/static.js` |

`Origin` 头在本机是**可伪造的**，所以"只放行 `http://127.0.0.1:*`"等于没有鉴权：本机任意进程都能驱动面板，而面板里是用户已登录的站点。

## 决策

1. **端口动态**：`bridge.port` 默认 `0`，由系统分配；静态服务一直 `listen(0)`。
2. **令牌**：每次 `apply` 生成 `randomBytes(32).toString('base64url')`（43 字符），桥与静态服务共用；校验用 `timingSafeEqual`（先比长度再常量时间比较）。
3. **发现**：host 在 `ctx.webServer` 上注册 `GET /agent-browser/discovery`，**先过宿主的 `connection.admit(req)`**（未认证 401 / 不信任 403），成功后返回 `{ok, mark, prefix, origin, port, token}`；client 半边启动时 `fetch('/agent-browser/discovery', {credentials:'same-origin'})` 拿地址与令牌并缓存，失败时退避重试、网络错误或 401/403 时清空缓存重新发现。
4. **静态路径令牌**：HTML 文档经 `/t/<token>/<path>` 访问时回 302 并种 `ab=<token>; Path=/; HttpOnly; SameSite=Lax`，子资源靠 cookie；非路径令牌的裸 URL 一律 403。
5. **Host 精确校验**：只接受 `127.0.0.1:<port>` / `localhost:<port>`，伪造 `Host: evil.example` 也 403。

## 理由

- 回环地址不是安全边界，**凭证**才是；而凭证不能硬编码（硬编码等于公开），只能每次启动随机生成并走已验证的通道下发。
- 发现走宿主自己的认证路由，等于**复用宿主已经建立的会话认证**（cookie），不新造一套登录。
- 动态端口同时解掉"双实例串台"和"端口被占用"两个问题（TICKET-019 验收实测：双实例各开 10960 / 6985，令牌互不通过）。
- 令牌不落盘、不进日志、不写进 URL 以外的地方；`/health` 不回令牌。

## 后果

- 多一个路由注册与一个 token 生命周期；`ctx.webServer` 不存在时（理论上非宿主环境）发现路由降级为 no-op，此时工具会因拿不到桥地址而明确报错，不会静默连错。
- 令牌在 renderer 内存里（`plugin/client.js` 的 `bridge` 变量），刷新页面会重新发现——这比"令牌写死在 URL 里跨重启失效"更稳。
- 静态服务的 cookie 不按端口隔离（同一 `127.0.0.1` 域），因此**同一台机器上另一个插件的静态服务不应复用同名 cookie**；这是遗留风险，记在 TICKET-019 §6.5。
