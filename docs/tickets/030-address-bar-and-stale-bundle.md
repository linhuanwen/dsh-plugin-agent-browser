# TICKET-030 面板地址栏显示 `[object Promise]`，以及"升级后卡片不显示"的误判

- **状态**：✅ 已完成（1.4.8 装机）
- **优先级**：P2（不影响工具调用，但地址栏是面板的第一眼信息；后半个问题浪费了两轮排查）
- **来源**：`docs/cases/013-hardening-cases.md` H5（过程卡片目视验收）
- **对应验收**：docs/spec/002 B8（过程卡片）、H5 目视通过
- **关联**：TICKET-023（三张卡片）、TICKET-028（截图可见性）

## 1. 问题

H5 验收要求"截图缩略图 / open 链接 / download 摘要"能在对话区看见。实际撞到三件事：

| # | 现象 | 现场证据 |
|---|---|---|
| 1 | 面板地址栏显示 `[object Promise]`，不是 URL | 用户 2026-11-22 11:52 截图；`Guest.url()` 直接回 `this.element?.getURL?.()` |
| 2 | 客户端早期 `report()` 丢失，"客户端到底跑没跑"无从判断 | 桥 `/logs` 只有 `poll alive`，`client half applied` 不在；`report()` 在 `bridge === null` 时静默 return |
| 3 | 连续三次把 H5 判成"卡片没渲染" | 实际是**陈旧客户端 bundle + 看错面板**（详见 2.3） |

## 2. 修法

### 2.1 地址栏（`plugin/client.js`）

| 层 | 改动 | 理由 |
|---|---|---|
| 缓存 | 新增 `this.lastAddress = ''` 与 `remember(address)`（只收非空字符串）；`url()` 返回缓存值 | `getURL()` 是可异步的宿主实现，直接放进 state 就成了 Promise |
| 写入点 | `address()` 成功后 `remember()`；`did-navigate` / `did-navigate-in-page` 监听器先 `remember(event.url)` 再 `setState({ url: this.url() })` | 导航事件比轮询更及时，且不会把 Promise 塞进 state |
| 版本 | `CLIENT_REV` 37 → 38 | |

### 2.2 启动早期上报（`plugin/client.js`）

`report()` 在 `bridge === null`（发现路由还没回来）时改为入队：`pendingReports`（上限 `PENDING_REPORT_LIMIT = 50`），`resolveBridge()` 成功后按序补发。这样"客户端装了哪一版、注册了什么"在升级后第一秒就能在桥日志里看到。

### 2.3 "卡片不显示"其实是两件事

1. **渲染器在跑旧 bundle**：代码改动只落盘、没有装机时，渲染器仍是上一版 `CLIENT_REV`。客户端半侧要等下一次 `install_bundle` 才会热换；刷新页面时如果键盘焦点在 `<webview>` 里，`Ctrl+R` 会被 guest 页吃掉，看起来像"刷新无效"。
2. **判据选错**：侧栏「轨迹」面板（时长 / 轮次 / 调用 / 子调用）只显示调用统计，**永远不渲染卡片**；要判定 H5 必须看**对话区**。

诊断期加的临时埋点（`traceView`、`thumbProbe`、`ctx.slots.onEntryError` 上报、`entries`/`entriesOfSlot` 统计、window error 监听）已在 1.4.8 全部删除。

## 3. 验证

| # | 验证 | 结果 |
|---|---|---|
| 1 | 桥日志出现 `client half applied {"rev":42,"toolviews":3}` | ✅ |
| 2 | 客户端条目：`toolview entries {count:64, ours:[3 个 key], ourWinners:[同 3 个]}` | ✅（诊断版实测，已随埋点删除） |
| 3 | 缩略图通道：`loadImage(ImageAttachmentRef)` → `blob:dsh-app://app/41482ca0-…` | ✅ |
| 4 | 目视：🌐 标题+可点链接；🖼 缩略图 + `84.8 KB`；⬇ 文件名+大小+`sha256 3df79d34abbc` | ✅（用户截图确认） |
| 5 | 地址栏显示真实 URL（不再是 `[object Promise]`） | ✅ |
| 6 | 全量单测 | 166 / 166 |

## 4. 偏差与残留

- 桥日志只保留 200 条，`client half applied` 在长时间运行后会被 `poll alive` 冲掉；排查时优先"重装一次再看第一条日志"，不要指望历史。
- 渲染器热换的时机不由插件控制（宿主行为），文档只能写"升级后若界面没变化，点一下对话区再 `Ctrl+R`"。
- 轨迹面板不是卡片判定面，这一点写进了 `docs/cases/013` §7.6，避免下次再判错。
