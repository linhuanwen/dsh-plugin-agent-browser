# TICKET-060 批量上传（`browser_upload` 的 `fields` 形状）

- **状态**：✅ 已实现并真机通过（2026-11-28，1.5.27）· 阶段 B2「可核对」的写动作批量版
- **来源**：用户 m10790「快照遮挡就暂时不做了，然后按照顺序开始吧」——顺序里的第一项
- **相关**：TICKET-047（单 input 上传）、TICKET-059（`browser_fill` 的批量写范式）、SPEC-003（首写确认）

## 1. 缺口

一个真实表单常常有多个文件输入（头像、附件、证明材料），现有一个 `browser_upload` 只能填一个 input：

1. 三个 input 要调三次，用户被弹三次确认条；
2. 每次都要断开地址、重新确认「刚才那批文件是不是没传完」；
3. agent 分别调用时，中途失败会留下「一部分传了、一部分没传」的外部状态，但它自己不知道从哪儿续。

## 2. 准入四问

| 问题 | 回答 |
| --- | --- |
| 是读还是写？ | 写（文件进入页面），比单 input 更重，所以更需要一次确认覆盖整批 |
| 是否可逆？ | 否。但**动手前**把所有地址、所有文件都校验完，任何一条不过门就整批不执行 |
| 失败能否确定「没执行」？ | 能：地址/文件/大小问题全部在弹确认条之前抛出，语义仍是「nothing was sent」 |
| 人工相位（验证墙/接管）下怎么办？ | 复用 `INPUT_TYPES`：`needs_human`、`taken_over` 下直接拒绝，不打扰人 |

## 3. 设计

### 3.1 工具形状

```jsonc
// 单 input（旧形状，完全不变）
{ "loc": "css:#avatar", "files": ["tmp/a.png"] }

// 批量（新形状）
{ "fields": [
    { "loc": "css:#avatar", "files": ["tmp/a.png"] },
    { "loc": "css:#docs",   "files": ["tmp/spec.pdf", "tmp/spec-zh.pdf"] }
] }
```

- `fields` 每项自带地址（ref / loc / selector 恰一）与 `files`；
- 上限：最多 10 个 input、20 个文件、单文件 2 MiB、单 input 合计 4 MiB、整批合计 8 MiB；
- 一次 `requestApproval`（`actionClass: 'upload'`，`target.fields` 记录 input 数量），**然后**逐 input 发一条 `upload` 命令；
- 结果同时给 `files`（全部文件扁平列表）与 `fields`（每个 input 的 `info`、文件、`multiple`、`url`）。

### 3.2 页面侧

不用改：一条命令仍然只填一个 `<input type="file">`，批量只是在宿主侧循环。这样页面的「File + DataTransfer + input/change」语义与 TICKET-047 完全一致，也避免在页面里一次性解析多个地址。

### 3.3 审批文案

`approvals.summarize('upload', …)` 在 `target.fields > 1` 时说「向 site 的 N 个输入框上传 …」，单 input 文案保持不变。

## 4. 证据

- `plugin/test/upload.test.mjs` 新增 5 例：两个 input 一次确认 + 两条命令（地址各自正确）；第二条地址 stale → 整批拒绝、零确认零命令；第二条不是 file input → `upload_rejected` 且 `details.index === 1`；10 个 input / 20 个文件上限；`fields` 形状校验。
- 全量 453/453；`node tools/check-docs.mjs` 七项全绿（工具 20 个不变）。
- 真机：`docs/cases/034-batch-upload-cases.md`。

## 4.1 真机证据（1.5.27）

- `browser_open { path: "demo/upload-multi.html" }` → 快照 3 refs（`e2` `css:#avatar`、`e3` `css:#docs`）；
- `browser_upload { fields: [{loc:"css:#avatar",files:["README.md"]},{loc:"css:#docs",files:["demo/form.html","demo/drag.html"]}] }` → **一个确认条**（用户点「允许一次」）→ `Uploaded 3 files across 2 input(s):`，逐 input 分组列出文件名与字节数；
- 快照 gen 2：页面显示 `README.md（30188 B）`、`form.html（2418 B）, drag.html（3771 B）`、`页面收到 3 个文件`。

## 5. 不做

- 跨 input 的「全部成功才写入页面」事务（页面拿不到回滚能力）；
- 页面内原生选择器（`showOpenFilePicker`）；
- 上传后自动提交（提交是另一个动作，交给人/`browser_click` 决定）。

## 6. 验收清单

- [x] 单 input 旧形状不回归
- [x] 批量一次确认、逐项结果、失败可定位到第几个 input
- [x] 所有地址与文件在确认条之前校验完
- [x] 上限（input / 文件 / 字节）有测试
- [x] 全量测试 + 文档门禁
- [x] 真机：两个 input 一次填完、页面收到 3 个文件、无第二个确认条
