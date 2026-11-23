# G3 PTC 模式冒烟结果

- 执行时间：2026-11-23 14:29:03 – 14:29:14（Asia/Shanghai）
- 环境：DSH 0.2.2-rc.5；dsh-plugin-agent-browser 1.4.13；右侧栏「浏览器」页签
- 执行方式：run_code 单程序批量调用（PTC）；未登录站点、未下载文件、未用 browser_eval 绕过验证

## 1. 工具可见性（browser_open）

| 尝试 | 原始结果 |
|---|---|
| 第 1 次 | panel_not_open: the browser panel of session session-… is not on screen, so the page cannot be driven. Open that session and its right sidebar browser tab, then retry. |
| 第 2 次（等待 2 秒后） | {"url":"https://example.com/","title":"Example Domain"}（全文 55 字符，即返回文本前 200 字符） |

结论：✅ 重试后成功打开 example.com。

## 2. snapshot + eval

browser_snapshot({maxChars:600})：

- 首行：- page "Example Domain" url=https://example.com/
- 摘要：gen=1 · 0 refs · 5 lines · 12 nodes walked · 1ms · 84.8 KB；返回字段 nodes=5, visited=12, refCount=0, textChars=516, truncated=true

browser_eval({script:'document.title'})：

- 返回："Example Domain"

结论：✅ page 行存在，title 为 Example Domain。

## 3. screenshot 结构化

| 调用 | path | bytes | sha256 | 其他 |
|---|---|---|---|---|
| {mode:'viewport'} | screenshots/shot-20261123-142914.png | 86362 | 64b19d59e0a542805d316c36614d0c0111fd687ddfd2b55e1afbeb8e9a4e1880 | mode=viewport |
| {fullPage:true} | screenshots/shot-20261123-142914-1.png | 86362 | 64b19d59e0a542805d316c36614d0c0111fd687ddfd2b55e1afbeb8e9a4e1880 | mode=viewport，无错误 |

- 两个文件均实际落盘，标称 bytes 与 sha256 已用 Node fs 复核一致。
- {fullPage:true} 未报错且返回 path/bytes/sha256；返回的 mode 仍为 viewport，sha256 与 viewport 截图相同（该页面仅一个视口高，后续 mode:'full' 调用返回 pageHeight=863，故无法仅凭 sha256 区分整页/视口，但没有异常）。

结论：✅ 按门禁口径（两次均返回 path/bytes/sha256、无异常）通过。

## 4. 错误码

browser_open({url:'file:///C:/Windows/win.ini'})：

- 原始错误：scheme_rejected: only http(s) URLs are allowed, got file:
- 以 scheme_rejected: 开头：是

恢复：browser_open({url:'https://example.com/'}) → {"url":"https://example.com/","title":"Example Domain"}

结论：✅

## 5. 汇总

| 项 | 期望 | 实测（原样摘录） | 结论 |
|---|---|---|---|
| PTC 下工具可见可调 | browser_open 成功打开 example.com | 第 1 次 panel_not_open: the browser panel of session session-… is not on screen, so the page cannot be driven. Open that session and its right sidebar browser tab, then retry.；等待 2s 第 2 次 {"url":"https://example.com/","title":"Example Domain"} | ✅ |
| snapshot + eval | 有 page 行、title 为 Example Domain | - page "Example Domain" url=https://example.com/；nodes=5 / visited=12 / refs=0 / textChars=516；eval="Example Domain" | ✅ |
| screenshot 结构化 | viewport 与 fullPage 两次都返回 path/bytes/sha256，无异常 | viewport: screenshots/shot-20261123-142914.png, 86362B, 64b19d59…e1880；fullPage: screenshots/shot-20261123-142914-1.png, 86362B, 64b19d59…e1880（mode=viewport，无错误） | ✅ |
| 错误码保留 | 错误文本以 scheme_rejected: 开头 | scheme_rejected: only http(s) URLs are allowed, got file: | ✅ |
| 无嵌套崩溃 | 全程无未捕获异常 | 5 组动作全部由程序捕获并正常返回，无未捕获异常 | ✅ |

## 附注

1. 首次 panel_not_open 已按规则等待 2 秒重试一次，两次原始结果见 §1；全程未出现 needs_human / panel_taken_over。
2. 五步门禁动作完成后（14:30:56 起）做补充复测时环境发生变化：browser_open 返回 ENOENT: no such file or directory, open 'C:\Users\林焕文\.dsh\profiles\desktop\node_modules\dsh-plugin-agent-browser\inject\detect.js'；14:35 时 PTC 工具表里该插件的 browser_open / browser_snapshot / browser_eval / browser_screenshot 已不存在（调用返回 tools[name] is not a function），仅剩 browser_navigate / browser_act / browser_wait / browser_tabs / browser_close。当时 ~/.dsh/profiles/desktop/node_modules/dsh-plugin-agent-browser 目录不存在，而 dist/dsh-plugin-agent-browser/dsh-plugin-agent-browser-1.4.13.tgz 内包含 package/inject/detect.js。该变化发生在上述五项之后，疑为会话中途插件被卸载/重载（例如并行执行 G4）；建议发布前复核装机状态并复跑一次 G3。
3. 全程无未捕获异常；上述 ENOENT 与工具消失均由程序捕获并记录，未造成嵌套崩溃。

G3 PASS
