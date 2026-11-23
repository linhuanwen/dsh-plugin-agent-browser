# G3 冒烟提示词（PTC 模式用）

这是上线测试门禁 G3（PTC 模式冒烟）的执行提示词：直接整段复制到新建的 **PTC 预设会话**里发出去，跑完它会写 `tmp/g3-ptc-result.md`，我再读文件核对。

```text
这是上线测试门禁 G3（PTC 模式冒烟）。当前环境：DSH 0.2.2-rc.5，插件 dsh-plugin-agent-browser 1.4.13 已装机，右侧栏有「浏览器」页签。

请用 PTC 方式（写程序批量调用工具，而不是一步一步点）完成下面五组动作，并把结果写进 tmp/g3-ptc-result.md（工作区相对路径）。全程不要登录任何站点、不要下载文件、不要用 browser_eval 绕过验证。

1) 工具可见性：在一次调用里执行 browser_open({url:'https://example.com/'})，记录返回文本前 200 字符。
2) 读页面：同一段程序里执行 browser_snapshot({maxChars:600}) 与 browser_eval({script:'document.title'})，记录：snapshot 的首行（page "…" url=…）、节点/字节摘要；eval 的返回。
3) 结构化结果：执行 browser_screenshot({mode:'viewport'})，记录 path / bytes / sha256；再执行一次全页截图 browser_screenshot({fullPage:true})，记录 path / bytes / sha256 或错误文本。注意：PTC 嵌套调用不会带 presentationMeta，卡片可能不渲染，这是已知限制，不算失败——只看工具本身有没有报错、结果里有没有 path/bytes/sha256。
4) 错误码：执行 browser_open({url:'file:///C:/Windows/win.ini'})，确认错误文本以 scheme_rejected: 开头；然后执行 browser_open({url:'https://example.com/'}) 恢复。
5) 汇总：把下面表格填好写进 tmp/g3-ptc-result.md，最后一行写 "G3 PASS" 或 "G3 FAIL: <失败项>"。

| 项 | 期望 | 实测（原样摘录） | 结论 |
|---|---|---|---|
| PTC 下工具可见可调 | browser_open 成功打开 example.com | | ✅/❌ |
| snapshot + eval | 有 page 行、title 为 Example Domain | | |
| screenshot 结构化 | viewport 与 fullPage 两次都返回 path/bytes/sha256，无异常 | | |
| 错误码保留 | 错误文本以 scheme_rejected: 开头 | | |
| 无嵌套崩溃 | 全程无未捕获异常 | | |

规则：如果第一次 browser_open 返回 panel_not_open，等 2 秒重试一次（面板展开有延迟），两次结果都要写进文件并注明；如果返回 needs_human 或 panel_taken_over，直接停下，在文件里记录原始错误文本后结束，不要自行过验证。
```

## 我这边怎么核对

跑完你回一句"跑完了"，我读 `tmp/g3-ptc-result.md`，对照 G3 的通过标准复核：

- G3.1：工具在 PTC 下可调用、结果正常；
- G3.2：带 `presentationMeta` 的工具（screenshot）不报错（PTC 无嵌套 meta 属已知限制）；
- 另外确认错误码在 PTC 嵌套调用里没有被包装成字符串。

若没生成文件，直接把会话最后一段输出贴给我也行。
