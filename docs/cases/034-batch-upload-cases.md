# 案例 034：批量上传（`browser_upload` 的 `fields` 形状）

> 版本 1.5.27（TICKET-060）· 2026-11-28 · 夹具 `demo/upload-multi.html` · 静态服务端口 6920

## 1. 结论

| # | 场景 | 结果 |
| --- | --- | --- |
| U1 | 打开夹具，两个 file input | 快照 3 refs：`e2` `css:#avatar`（单文件）、`e3` `css:#docs`（可多选） |
| U2 | `fields` 一次填两个 input（1 + 2 个文件） | **只弹一次确认条**；回执 `Uploaded 3 files across 2 input(s):` 并按 input 分组 |
| U3 | 页面侧效果 | 头像 `README.md（30188 B）`；附件 `form.html（2418 B）, drag.html（3771 B）`；汇总「页面收到 3 个文件」 |
| U4 | 单 input 旧形状 | 仍可用（`files` 参数），行为不变 |

## 2. 回执原文

```text
browser_upload {
  fields: [
    { loc: "css:#avatar", files: ["README.md"] },
    { loc: "css:#docs",   files: ["demo/form.html", "demo/drag.html"] }
  ]
}

→ Uploaded 3 files across 2 input(s):
  * 1. textbox "头像（单文件）" ← README.md (30188 B)
  * 2. textbox "附件（可多选）" ← form.html (2418 B), drag.html (3771 B)
  The page saw change events; snapshot again to see what it shows now.
```

快照（gen 2）页面文本：

```text
- text "README.md（30188 B）"
- text "form.html（2418 B）, drag.html（3771 B）"
- text "页面收到 3 个文件（input 还没提交，只是放进了选择器）。"
```

## 3. 验收期发现

1. **一次确认覆盖整批是可行的**：两个 input 只出现一个确认条，用户点一次「允许一次」后两条 `upload` 命令依次执行，中间没有再问。
2. **页面拿到的是真正的 File 对象**：页面自己的 `change` 监听读到了文件名与字节数，说明宿主传入的 `DataTransfer`/`File` 与单 input 路径完全同源。
3. **上限要同时给两级**：单 input 仍是 5 文件/4 MiB，整批是 10 input/20 文件/8 MiB；单测覆盖了 11 个 input 与 5×5 文件两种越界。

## 4. 复跑

```text
browser_open { path: "demo/upload-multi.html" }
browser_snapshot              # 拿 e2/e3 的 loc
browser_upload { fields: [
  { loc: "css:#avatar", files: ["README.md"] },
  { loc: "css:#docs",   files: ["demo/form.html", "demo/drag.html"] }
] }
browser_snapshot              # 页面应显示 3 个文件名与「页面收到 3 个文件」
```

## 5. 已知边界

- 批量是**宿主侧逐 input 执行**：第 2 个 input 失败时第 1 个已经填了，回执会说明「已写入几个」；
- 不提交表单（提交交给 `browser_fill { submit }` 或 `browser_click`）；
- 页面内 JS 打开文件选择器（`showOpenFilePicker`）仍拒绝；
- 文件内容来自工作区，单文件 2 MiB、单 input 4 MiB、整批 8 MiB。
