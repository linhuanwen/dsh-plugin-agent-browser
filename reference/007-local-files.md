# 本地静态服务：为什么一定要"挂个 HTTP 壳"

> 记录 TICKET-006 的最终实现与踩过的坑。主要给两类读者：想改 `plugin/static.js` 的人，以及以后又想"直接用 file:// 打开吧"的人（答案是不要）。

## 1. 为什么 `file://` 不可行

主进程对 `<webview>` 的导航做了白名单（`D:\deepseek harness\resources\app.asar\lib\main.js:18259`）：

```js
if (!/^(https?|about|devtools):/i.test(url)) event.preventDefault()
```

`file://` 不在其中，`will-frame-navigate` 直接 `preventDefault()`，页面根本不会加载。所以本地 HTML 必须由 HTTP 提供。

loopback 是放行的：`isApplicationHost` 只在端口等于 DSH 自己的端口时才拦。这意味着"插件自己起一个 `127.0.0.1` 上的只读服务"是**合法且官方兼容**的路径，而不是绕过安全策略。

## 2. 形态：一个 host 侧单例，按工作区缓存

```
plugin/static.js
  resolveWithin(root, pathname)        # URL 路径 → 绝对路径（安全）
  resolveWorkspacePath(root, input)    # 工具入参 → 绝对路径（安全）
  urlForPath(origin, root, input)      # 绝对路径 → 可点开的 URL
  class StaticSites                    # 每个 realpath(root) 一个 http.Server
```

- `listen(0, '127.0.0.1')`：端口由系统分配，不写配置项，不暴露 `0.0.0.0`。
- key 用 `fs.realpath(root)`，所以 `a` 与 `a/../a` 复用同一个服务。
- `dispose()` 关掉所有 server；`plugin/index.js` 用 `ctx.effect(() => () => { void sites.dispose() }, 'agent-browser.static')` 挂生命周期。
- 端口是**进程级**资源：`remove_bundle` 后立刻释放，重装后是新端口。文档里不要写死端口号。

## 3. 两道安全闸

第一道在字符串层：

```js
const target = resolve(root, '.' + pathname)     // 必须先把 pathname 当相对路径
const rel = relative(root, target)
if (rel.startsWith('..') || isAbsolute(rel)) return { error: 'path_escape' }
```

拒绝清单：`\0`、`%zz` 之类解码失败、盘符前缀（`C:`）、UNC（`//host/share`）、反斜杠穿越（统一转成 `/` 再判）。

第二道在文件系统层：

```js
const real = await fs.realpath(target)           // 符号链接在这里被解析
if (!(real + sep).startsWith(root + sep)) → 403
```

只有第一道会被符号链接绕过，所以第二道不是冗余。

## 4. 错误码与响应约定

| 情况 | 响应 |
|---|---|
| 方法不是 GET/HEAD | `405` + `allow: GET, HEAD` |
| URL 解析失败 / 编码非法 | `400 bad_path` |
| 解析后越界 / 符号链接逃逸 | `403 forbidden` |
| 文件不存在 | `404 not found` |
| 目录 | 内部补 `index.html`，再按上面判断 |
| 大于 32 MiB | `413 file too large (N bytes, limit 33554432)` |
| 其他异常 | `500`，细节只进 host 日志（`error.code`） |

**响应体一律是单词，不带主机路径**。因为这个响应会渲染进面板，Agent 也能读到——把 `D:\...` 吐出去等于把本机目录结构泄漏给模型。

所有响应都带 `cache-control: no-store`（迭代时不要看到旧文件）和 `x-content-type-options: nosniff`。

## 5. 工具侧接线

`browser_open` 的 `url` / `path` 二选一：

```js
const root = await workspaceOf(ctx, exec)        // workingDirectory.ensure(agent, signal)
const site = await sites.ensure(root)
const url = urlForPath(site.origin, root, args.path)
```

- 工作区不是自己算的，而是 harness 的 `workingDirectory` 服务 → 与 DSH 其他功能对"工作区"的定义完全一致。
- `path` 模式下返回值多两个字段 `port` / `root`，渲染文案追加 `Served from the workspace by a read-only local server on port N (root: …)`，这样 Agent 自己能看到"这不是公网页面"。
- 返回的是 `origin + 相对路径`，所以页面里的相对资源天然可用。

**`path` 的三种写法都接受**：`demo/index.html`、`./demo/index.html`、`/demo/index.html`，以及落在工作区内的绝对路径 `D:\…\demo\index.html`。
这里踩过一个 Windows 陷阱：`path.isAbsolute('/demo/index.html')` 在 Windows 上是 **true**（它指当前盘根），所以最初按"绝对路径"处理 → 直接判成 `path_escape`。现在的判据是"盘符前缀或 UNC 前缀才算外部的绝对路径"，前导斜杠一律理解为"从工作区根开始"。`plugin/test/static.test.mjs` 里有用例锁住这三条。

## 6. 三个容易误判的现象

1. **点不到 / 截图空**：DSH 窗口在后台时，guest 不绘制也不接收合成输入（`sendInputEvent` 静默丢弃）。表现为 `browser_click` 返回成功但页面无变化、`capturePage()` 挂起。把窗口切到前台即恢复。这是 Electron 的行为，不是插件 bug。
2. **`ref "e3" is no longer in the page`**：多数情况不是页面坏了，而是上一次 `browser_snapshot` 的字符预算把后面的行（连同 ref）截掉了，`e3` 根本没被分配。
3. **端口对不上**：先确认是不是重装过 bundle。重装 = 新 host 实例 = 新端口。

## 7. 已知缺口

- 只有 GET/HEAD，没有 Range 请求支持，所以大视频不会分段加载（当前上限 32 MiB，实际场景用不到）。
- MIME 表是白名单式的，新增扩展名要改代码。
- 服务对"同一工作区的所有会话"共享一个端口，没有会话级隔离（同一台机器、同一用户下意义不大）。
