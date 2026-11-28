# 案例 033：表单批量填写 `browser_fill`（TICKET-059）

日期：2026-11-28 · 版本：1.5.26 · 夹具：`demo/form.html`

## 1. 结论

| # | 场景 | 结论 |
|---|---|---|
| F1 | 三字段一次填 + `submit:true` | ✅ 一次确认、一次回执，页面收到 `林先生 / demo@example.com / 上海` 并显示「已提交」 |
| F2 | `select` 按可见文本「上海」 | ✅ 命中 `option[value="sh"]`，页面选中「上海」 |
| F3 | 坏地址 + 好地址混排 | ✅ `Nothing was filled`，两个字段都保持原值（原子性） |
| F4 | 密码框 | ✅ `needs_human`，页面密码框保持空，未弹确认条 |
| F5 | 面板隐藏时发起 | ✅ `approval_required`，未下发任何键击 |
| F6 | 时间线回读 | ✅ `committed 5236ms`（含等人确认）、两次失败分别记 `[stale_loc]` / `[needs_human]` |
| F7 | `submit:{loc}` 变体 | ⚠️ 真机窗口被隐藏未取到（面板不可见时 `approval_required`）；由 `fill.test.mjs` 的「submit address forwarded + navigated」覆盖 |

## 2. 命令与回执原文

### F1–F2 批量填写 + 提交

```
browser_fill {
  fields: [
    { loc: "css:#name",  value: "林先生" },
    { loc: "css:#email", value: "demo@example.com" },
    { loc: "css:#city",  value: "上海" }
  ],
  submit: true
}
```

回执：

```
Filled 3 field(s):
* textbox "你的名字" = "林先生"
* textbox "you@example.com" = "demo@example.com"
* combobox "城市 北京 上海 深圳" = "上海"
Submitted (the address did not change).
```

页面下一拍快照（gen 2 / gen 3 同画面）：

```
- textbox "你的名字" value="林先生"
- textbox "you@example.com" value="demo@example.com"
- combobox "城市 北京 上海 深圳" value="sh" · option "上海" selected
- text "已提交： name = \"林先生\" email = \"demo@example.com\" city = \"sh\" note = \"\""
```

### F3 坏地址原子失败

```
browser_fill {
  fields: [
    { loc: "css:#nope",  value: "x" },
    { loc: "css:#email", value: "changed@example.com" }
  ]
}
```

回执：

```
Error: Nothing was filled: the loc "css:#nope" no longer matches anything in the page. Take a new browser_snapshot and use a fresh loc.
```

随后快照：邮箱仍是 `demo@example.com`（页面被截图与 gen 2 逐字节相同，sha256 一致，值未变）。

### F4 密码框拒绝

```
browser_fill { fields: [{ loc: "css:#secret", value: "hunter2" }] }
```

回执：

```
Error: Nothing was filled: field 1 is a password field. Credentials stay with the human: ask the user to type it in the panel, then continue.
```

页面密码框保持空。

### F5 面板隐藏

```
browser_fill { fields: [ ... ], submit: true }
```

回执：

```
Error: approval_required: 面板看不到，没法向用户确认。The panel could not show the permission prompt (closed or hidden), so nothing was sent to the page. Open the right sidebar browser tab for this session and retry.
```

### F6 时间线回读

```
browser_timeline { limit: 6 }
```

```
6 recent action(s) (newest first), 3 failed; 8 in the buffer.
#8 11:30:19 ok browser_snapshot 151ms
#7 11:30:14 FAILED browser_fill [needs_human] 62ms — fields=[{"loc":"css:#secret","value":"hunter2"}]
#6 11:30:10 FAILED browser_fill [stale_loc] 76ms — fields=[{"loc":"css:#nope","value":"x"},{"loc":"css:#e…
#5 11:30:02 ok browser_snapshot 139ms
#4 11:29:54 ok browser_fill (committed) 5236ms — fields=[{"loc":"css:#name","value":"林先生"},{"loc":"css:… submit=true
#3 11:21:16 FAILED browser_fill [approval_required] 106ms — fields=[{"loc":"css:#name","value":"林先生"},{"loc":"css:… submit=true
```

## 3. 验收期发现

1. **schema 子集不支持 `minItems`/`maxItems` 与联合 `type`**：首版 `parameters` 用了 `type:['boolean','object']` 和数组 `minItems`，tooldefs 契约测试直接拒绝；改成 `oneOf:[{type:'boolean'},{type:'object',…}]` 并把 1–50 校验留在 `execute`。
2. **工具描述里的嵌套反引号**：`` `…<workspace>/` `` 这种写法在模板字符串里会变成变量插值，模块加载即 `ReferenceError`；改成普通字符串拼接（README/描述里的反引号统一用外层双引号处理）。
3. **`submit` 后导航判定**：只等 350ms 比对 URL，足够覆盖同步跳转；SPA 异步提交需 `browser_wait` 复核。
4. **失败也进时间线**：`stale_loc` / `needs_human` / `approval_required` 都以对应稳定码入账；`approval_required` 是「未下发」，页面值必然不变。

## 4. 复跑

```powershell
node --test plugin/test/fill.test.mjs
node --test plugin/test/actions.test.mjs
node --test plugin/test/*.test.mjs          # 期望 440 / 440
node tools/check-docs.mjs                   # 期望七项全绿
```

真机：

```
browser_open { path: "demo/form.html" }
browser_snapshot                            # 记下 #name / #email / #city / #save 的 loc
browser_fill { fields: [...], submit: true }
browser_snapshot                            # 页面显示「已提交：…」
browser_timeline { limit: 6 }               # 看 committed 与失败码
```

## 5. 已知边界

- `submit` 只点「最后一个字段所在表单」的提交控件；跨表单提交请用 `submit:{loc}` 或 `browser_click`。
- 只支持 `text/textarea/contenteditable/select`；checkbox/radio/file/date 用 `browser_click` / `browser_upload`。
- `clear` 默认 true；追加模式依赖 `execCommand('insertText')`，个别接管了输入法/编辑器的页面可能只触发 setter 回退。
- 密码框、`disabled` 控件、`not_editable` 元素一律不写；所有字段先解析后击键，失败时页面最多停在被拒绝的那一步之前。
- 提交后只看 350ms 内 URL 是否变化；异步表单提交（`fetch` + 前端提示）需用 `browser_wait` / `browser_snapshot` / `network` 尾巴确认。
- 跨域 iframe 表单不覆盖（`f1:` 前缀只在同源 iframe 生效）。
