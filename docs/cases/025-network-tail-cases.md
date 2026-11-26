# TICKET-051 案例：页面 network 失败尾巴（1.5.13）

**日期**：2026-11-27
**版本**：1.5.13（tgz 348,861 B / sha256 `1ADC4DFF24A33080372FD6078CC708724F4B235200CC53B89AFBCC270C1AB12B`）
**环境**：DSH Desktop 右侧栏浏览器面板；`demo/network.html` 由插件自带只读静态服务提供（本次 `http://127.0.0.1:14820/t/demo/network.html`）。

## 1. 结论

| 编号 | 场景 | 结果 |
|---|---|---|
| N1 | 页面 fetch 成功 | 只计数，不产生尾巴 ✅ |
| N2 | 页面 fetch 404 | 下一次快照末尾出现 `- [fetch] GET /t/demo/missing-after-fetch-404.json → 404, 14ms` ✅ |
| N3 | 页面 fetch 传输失败（不可达端口） | `- [fetch] GET http://127.0.0.1:1/network-down → failed, 16ms — TypeError: Failed to fetch` ✅ |
| N4 | 页面 XHR 404 | `- [xhr] GET /t/demo/missing-after-xhr-404.json → 404, 14ms` ✅ |
| N5 | 总数口径 | 尾巴抬头为 `page network (3 failed of 4 request(s)):`——1 次成功请求也计进分母 ✅ |
| N6 | 第二次快照 | 没有新的失败，快照里没有 `page network` 段（每次快照清空）✅ |
| N7 | 只有成功请求 | 快照没有 `page network` 段（失败列表为空时不占上下文）✅ |

## 2. 命令与回执原文

1. `browser_open { path: "demo/network.html" }` → `Opened http://127.0.0.1:14820/t/demo/network.html — 页面 network 观测夹具`；快照 5 refs（e2 `#fetch-ok`、e3 `#fetch-404`、e4 `#fetch-down`、e5 `#xhr-404`）。
2. 依次 `browser_click { ref }`：`Clicked button "fetch 成功" at (73, 140).`、`Clicked button "fetch 404" at (182, 140).`、`Clicked button "fetch 传输失败" at (306, 140).`、`Clicked button "XHR 404" at (428, 140).`
3. 下一次 `browser_snapshot`（gen 2）末尾：

```
page network (3 failed of 4 request(s)):
- [fetch] GET /t/demo/missing-after-fetch-404.json → 404, 14ms
- [fetch] GET http://127.0.0.1:1/network-down → failed, 16ms — TypeError: Failed to fetch
- [xhr] GET /t/demo/missing-after-xhr-404.json → 404, 14ms
```

4. 再下一次 `browser_snapshot`（gen 3）：页面内容与 gen 2 相同，**没有** `page network` 段。
5. 只点一次「fetch 成功」后的 `browser_snapshot`（gen 4）：`点击次数：5 最近一次：fetch 成功 200`，**没有** `page network` 段。

## 3. 验收期发现

- **分母来自总数而不是失败列表**：成功请求不会出现在尾巴里，但会计入 `networkTotal`；因此看到 `3 failed of 4` 时不要以为有第 4 条失败被隐藏。
- **同源 URL 被缩写**：`/t/demo/...` 是页面同源路径（省掉 origin）；跨源（`http://127.0.0.1:1/...`）保留完整 URL，方便区分是谁发的请求。
- **尾巴位置**：若同一批请求里既有失败又有页面 console，快照里先出 `page network`，再出 `page console`（宿主 render 顺序固定）。
- **客户端包缓存**：与 1.5.12 相同，`CLIENT_REV` 变化后应重新安装并（如面板行为还是旧的）完整重启 DSH；本次 1.5.13 装机后面板直接按新代码运行。

## 4. 复跑清单

1. `plugin_manager remove_bundle target="dsh-plugin-agent-browser"` → `install_bundle target="…dsh-plugin-agent-browser-1.5.13.tgz"`；右侧栏打开浏览器页签。
2. `browser_open { path: "demo/network.html" }` → `browser_snapshot` 取 refs。
3. 依次点击「fetch 成功」「fetch 404」「fetch 传输失败」「XHR 404」。
4. `browser_snapshot` → 核对 `page network (3 failed of 4 request(s)):` 三行；再快照 → 确认尾巴消失。

## 5. 已知边界

- 只看到 guards 注入之后、页面自己发出的 `fetch`/`XMLHttpRequest`；dom-ready 之前的请求、Service Worker 内部请求、WebSocket/EventSource 帧都不在范围内。
- 只记录失败，无响应体/请求头/cookie/瀑布图；成功请求只进分母。
- 页面在两次快照之间若没有快照，失败列表会按环形缓冲丢最旧的（上限 40 条，客户端只取最后 20 条）。
- 与 console 尾巴一样挂在 `browser_snapshot` 上，因此人工相位（`needs_human`/`taken_over`）下仍可用。
