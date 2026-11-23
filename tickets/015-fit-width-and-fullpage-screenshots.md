# TICKET-015 宽度自适应 + 整页截图

- **状态**：✅ 已完成并装机（`1.0.39`，`HOST_REV 28` / `CLIENT_REV 28`，2026-11-20）
- **优先级**：P0（2026-11-20 用户提出：报告里的截图"非常不全"）
- **来源**：`reference/012-industry-research-cases.md` R8 实跑暴露——`browser_snapshot` 的图只能框住首屏，桌面站还会横向溢出；当时靠 `browser_zoom({factor:0.75})` 手工压，才勉强拍到筛选状态和三条记录。
- **对应验收**：`spec/001-agent-browser-plugin-spec.md` A19

## 1. 问题

两件事，都是"页面比面板大"：

1. **横向**：侧栏不到 600 CSS px，而政采、地信、地图这类桌面站动辄 1000–1200 px 布局宽。不缩放时右侧整块看不见，agent 的快照里也没有——它不知道自己缺了什么。
2. **纵向**：`snapshot` 的截图是"当前视口"（一屏 863 px），长页面只能看到顶上一段。要做报告插图就得自己滚一次截一张再拼，而插件没有落盘原语。
3. 附带：`browser_zoom` 是**手动**的，每换一页都要重设；漏设一次就白跑一轮。

## 2. 修法

| 层 | 改动 |
| --- | --- |
| 配置 | `Config.fitWidth`（默认 `true`）：关掉就完全不自动缩放 |
| 下发 | `bridge.request(..., { show, fit })`，`command` 带 `fit: 'width' \| 'none'`；`#drain()` 重放队列时**必须带上 `show`/`fit`**（1.0.34 修：此前被丢掉，配置永远到不了面板） |
| 页面 | `Guest.fitToWidth()`：量 `innerWidth` 与 `document.documentElement.scrollWidth`，按比例 `Math.floor(zoom × w / sw × 100) / 100` 逐轮收敛（最多 4 轮，只缩不放，下限 0.25）；`load()` 收尾调一次、600 ms 后再补一次（图片/字体撑宽布局很常见）；`ResizeObserver` 在面板宽度变化时 `force` 重算 |
| 记账 | `zooms`（手动）/ `fitZooms`（自动）两张 Map + `zoomSource`，避免"自动缩放"覆盖用户手动设的值；用户设过手动档后，`fitWidth` 就不再动它 |
| 截图 | `Guest.screenshot()`：`sh <= h + 4` 走单帧；否则滚到顶，逐屏 `capturePage()` → `toDataURL()` → 面板内自己解 PNG（`DecompressionStream('deflate')` + 逐行反滤波）→ 按**实际滚动位置**裁掉重叠行 → 拼成一张 RGBA；`MAX_SHOT_ROWS = 16000` 与 `maxHeight`（默认 10 000）双重截断并置 `truncated`；末尾补一帧防丢页尾；`finally` 里恢复滚动位置 |
| 粘性元素 | 拼接前 `hidePinned()`（`position: fixed/sticky` 加 `visibility:hidden`），结束后 `restorePinned()`——否则页头会在每一帧重复出现 |
| 编码 | 手写 PNG：签名 + IHDR + IDAT（`CompressionStream('deflate')`）+ IEND，`crc32` 自己算；转 base64 走 `bytesToBase64`（不依赖 `btoa`） |
| 工具 | `browser_screenshot({name, mode, maxHeight, overlap})` → 落盘 `<workspace>/screenshots/`，`uniquePath` 用 `flag: 'wx'` 抢名（重名 `-1`、`-2`，绝不覆盖）；output `{path, bytes, sha256, width, height, frames, mode, pageHeight, truncated}` |

**为什么不在 host 侧拼**：`capturePage` 只能在 renderer 侧调，拼接自然跟着走；host 只负责落盘与哈希。

**为什么是 `toDataURL()` 而不是 `getBitmap()`**：`getBitmap()` 看起来更省事（直接给 BGRA），但**渲染进程没有 `Buffer`**，Electron 的 `NativeImage` 绑在一部分路径上会抛 `Buffer is not available for the current Context`（1.0.33 实测，`/settle` 回 `ok:false`，工具层只能看到同一句话）。改成 `toDataURL()` 拿标准 PNG，再用 `DecompressionStream` 解回来——代价是多一次编解码，换来的是**只依赖 Web 标准**。三个编解码函数用 `// --- png-*-begin/end` 标记切出来给 `png.test.mjs` 做逐像素对拍。

## 3. 单测

`plugin/test/shots.test.mjs`（8 例）：

- `decodeBase64` 与 `Buffer.from(text, 'base64')` **逐字节对拍**（含 `=` 补齐、含换行）；
- 非法字符被忽略、空串返回 0 字节；
- `sha256Hex('hello world')` = `b94d27b9…efcde9`、空输入 = `e3b0c442…b855`；
- `shotName` 三类：正常名、`../` 穿越被压平、空名回落到 `shot-<时间戳>.png`；
- `uniquePath` 不覆盖：已存在 `a.png` 时得 `a-1.png`，再生成得 `a-2.png`。

全量 **82 tests / 82 pass**（actions 27 + downloads 18 + static 14 + activation 6 + detect 6 + shots 8 + png 3）。

`plugin/test/png.test.mjs`（3 例）按 `// --- png-encoder-begin/end`、`png-decoder-begin/end`、`png-deflate-begin/end` 三个标记把**出厂代码原样切出来**，在 Node 里做「编码 → 解码 → 逐像素对拍」，因此测的不是副本：手写 PNG 的草丛里少一个 CRC 都会红。

## 4. 装机验收

| 项 | 证据 |
| --- | --- |
| 横向自适应 | `browser_open` 政采结果页 → `fit width {"panel":657,"zoom":1,"changed":false,"fits":true}`；另一页 `innerWidth 1114 / scrollWidth 1088`、`1012 / 1000`——排版宽度都塞进了面板 |
| 面板无尺寸时不装死 | 右栏收起时 `screenshot` 直接报 `the browser panel has no size on screen (it is hidden or collapsed)…`，而不是 `the page produced no image` |
| 单帧分支 | 短页面（`sh == h`）走 `capture(768)`，`mode: 'viewport'`，1 帧 |
| 整页拼接 | `screenshots/ccgp-full2.png`：`768 × 2472`、1,310,450 B、`2 frames stitched`、`truncated: false`；页面从页头到"主办单位…财政部国库司"页脚连续，无重复条带、无页头重复 |
| 首版拼接错位 | 1.0.38 的同一页给出 `768 × 2968` 且中段重复约 500 行——原因是尾帧按 `overlap` 常量裁剪，而实际 `scrollBy` 被 `maxScroll` 截断（`y` 从 1422.6 直接跳到 2125）。1.0.39 改为**按实际 `scrollY` 与已覆盖高度算裁剪量**，并打 `screenshot frame/tail` 日志 |

## 5. 实现期踩到的六个坑（都已修）

1. **`client.js` 语法错误**：`fitToWidth()` 与 `load()` 之间的注释块丢了 `/**` 开头，`npm pack` 不报、`node --check` 才报 `SyntaxError: Unexpected token '*'`；表现是 client 半部加载失败、面板空白。`tools/pack.mjs` 现在对每个 `.js` 跑 `node --check`，失败即中止打包。
2. **`Buffer` 不可用（host 侧）**：工具体在某个上下文里没有 `Buffer`，`Buffer.from(..., 'base64')` / `createHash().update(Buffer)` 都报 `Buffer is not available for the current Context`。改用纯 JS `decodeBase64` 与纯 JS sha256。
3. **`#drain()` 丢字段**：重放队列时 `map(({ id, type, params }) => …)` 把 `show`/`fit` 丢了——`fitWidth:false` 与 `activation:always` 因此永远不生效。
4. **返回值形状**：`/settle` 已把 guest 载荷解包一次，工具层又按 `result.ok !== true` 判，把成功当失败；改为只把 `ok === false` 当失败。
5. **`Buffer` 不可用（面板侧，更隐蔽）**：整页拼接原本读 `NativeImage.getBitmap()`，而渲染进程根本没有 `Buffer`，于是 `/settle` 回 `ok:false` + 同一句 `Buffer is not available…`。改成 `toDataURL()` + 面板内自己解 PNG（`DecompressionStream` + 反滤波），`png.test.mjs` 做编码/解码对拍。
6. **尾帧裁剪量算错**：`scrollBy` 会被 `maxScroll` 截断（`y` 从 1422.6 直接到 2125），按 `overlap` 常量裁就会多留约 500 行重复。改为用**实际 `scrollY` 与已覆盖高度**求差。

## 6. 风险与残留

| 风险 | 说明 |
| --- | --- |
| 自动缩放会变小字 | `fitWidth` 把桌面站压到 50% 左右时，截图里的正文偏小。报告用图建议配合 `browser_screenshot({mode:'viewport'})` 或先 `browser_hover` 定位再截 |
| 拼接对动态内容不友好 | 懒加载列表在拼接过程中会继续加载（`scrollHeight` 变），已用"最后一屏补一帧"缓解，但不保证与单屏完全一致 |
| `MAX_SHOT_ROWS = 16000` 是硬上限 | 超长页面会被截断并置 `truncated: true`，调用方必须看这个字段 |
| `transform:scale()` 退化路径 | 本机 `<webview>` 有 `setZoomFactor`，退化路径只在单测里走过 |
