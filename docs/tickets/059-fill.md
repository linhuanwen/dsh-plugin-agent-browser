# TICKET-059 表单批量填写（`browser_fill`）

状态：✅ 已实现并真机通过（2026-11-28，1.5.26）· 阶段 B2「可核对」
目标版本：1.5.26

## 1. 缺口

- **一次一个字段太慢**：登录/资料/筛选表单动辄三五个字段，`browser_type` 一次一个，每个字段一次调用、一次确认，还剩「最后一次要按提交」的猜谜。
- **不原子**：逐字段输入时，第三个字段的 `stale_loc` 会让前两个字段已经写进页面——页面停在一个半填状态，人接手时不知道哪几个已经写了。
- **提交靠猜**：`browser_press` 的 Enter 只对「表单里聚焦的输入」成立，提交按钮在哪、表单有没有 submit 控件、点它会不会导航，全靠 agent 自己拼。
- **密码不该经手**：`browser_type` 的 CS 密码框已经一律拒绝，但批量填写是新入口，必须同样在「第一次击键前」就拒绝，而不是填到一半才报。

## 2. 准入四问

| 问题 | 答案 |
|---|---|
| 是不是页内动作？会不会改页面？ | 是写动作：填字段，可选提交；可能触发导航/请求。 |
| 可逆吗？ | 字段可重填；**提交通常不可逆**（创建订单、发消息）。所以带 `submit` 时按「提交」归类，一次确认。 |
| 失败能定「没执行」吗？ | **所有地址在第一次击键前解析完**（字段 + 提交目标 + 密码框 + 可编辑性），失败回执写明「已写 N 个」，`filled: []` 时页面完全没动。 |
| 人工相位怎么办？ | `fill` 属 `INPUT_TYPES` + `WRITE_TYPES`：`taken_over` / `needs_human` 下直接拒绝，不抢相位。 |

## 3. 设计

### 3.1 页面侧（`plugin/inject/actions.js`）

- 新增 `resolveFillField` / `fillKindOf` / `setFieldValue` / `fillOneValue`，以及 `doFill()`（`op === 'fill'` 分支）。
- 顺序固定：**先解析全部字段 → 再解析提交目标 → 才写第一个字段 → 最后提交**。
  - 字段地址三选一（`loc` / `ref` / `selector`，`strict` 只对 selector 生效）；重复/缺失地址报 `bad_loc` 一类既有码。
  - `fillKindOf`：`select`、`text`、`password`（拒绝，`needs_human`）、`''`（非可编辑，`not_editable`）。`disabled` 直接拒绝。
  - 写值：`select` 按 option 的 value 或可见文本匹配（大小写不敏感），未命中 `bad_option`；文本用 `execCommand('insertText')` 保留页面自己的 input/change 监听（失败回退原生 setter），`clear:false` 追加。
  - 提交：`submit:true` 取最后一个字段所在 `form` 的提交控件（`button[type=submit]` / `input[type=submit]` / 无 type 的 button），没有则 `form.requestSubmit()`，再无则 `no_submit_target`；`submit:{loc|ref|selector}` 点名控件；点击抛错回 `submit_failed`。
- 回执：`{ok, fields:[{index, info, value, length, inserted, selected, rect}], submit:{info, method}, url}`；失败带 `{index, info, value?, filled:[...]}`，工具层据此拼「Nothing was filled」/「The first N field(s) were already filled」。

### 3.2 面板侧（`plugin/client.js`）

- `CLIENT_REV` 65 → **66**；`Guest.fill(params)`：一次性 `act('fill')`；带 `submit` 时记录提交前 URL，结束后等 350ms 比对得 `navigated`；`DIALOG_TYPES` 加 `fill`；`runCommand` 加 `fill` 分支。
- 整批只产生一个命令、一次回执；`fill` 属 `INPUT_TYPES` / `WRITE_TYPES`，超时/接管按 `action_unknown` 处理。

### 3.3 工具层（`plugin/tools.js`）

- 第 20 个工具 `browser_fill({ fields:[{loc,ref,selector,value,clear?}], strict?, submit?: boolean|{loc,ref,selector} })`。
- 参数校验全部在本地完成（地址互斥、`loc` 必须 `css:`、值必须是字符串、1–50 个字段、submit 形状），不合格时一次请求都不发。
- 输出：`filled[]`（含可读名与写入结果）、`submitted`、`navigated?`，`effect: 'committed'`；render 输出 `Filled N field(s):` 列表与提交/导航状态。
- `fillFailure(result)` 把页面错误转成可操作文案并保留稳定码（`stale_loc` 点名 loc、密码框提示请人输入、`no_submit_target` 提示用 `submit:{loc}` 或 `browser_click`）。

### 3.4 审批（`createGate.confirmBefore`）

- `fill` 整批一次确认：inspect 第一个字段的地址 → 地址坏了直接交给动作报精确错误（不打扰人）→ 密码框不弹条（页面会拒绝）→ 否则 `confirmWrite({ actionClass: submit 存在 ? 'submit' : 'type' })`。
- 仅输入 → 按「输入」授权；带提交 → 按「提交」授权（同一站点会话授权可复用）。

## 4. 证据

### 4.1 单测

| 范围 | 结果 |
|---|---|
| `plugin/test/fill.test.mjs` | **6 / 6**：请求形状（fields/submit/source、60s）、committed 回执与 render、提交地址透传 + navigated、页面拒绝保留 code 与「first N filled」、`stale_loc` 说 Nothing was filled、10 种畸形参数零请求 |
| `plugin/test/actions.test.mjs` | **50 / 50**（新增 5 例页面侧：两字段写入、坏地址原子失败、密码框拒绝、`submit:true` 点中提交按钮、select 按 label 匹配 / `bad_option`） |
| 全量 | **440 / 440**（`node --test plugin/test/*.test.mjs`） |
| 文档一致性 | `node tools/check-docs.mjs` 七项全绿（配置字段 23、工具 20、YAML 14、decisions 10、B11、file:line 12、打包清单 8 inject + 15 宿主 + dist files） |

### 4.2 真机（`demo/form.html`，1.5.26 最终包，`docs/cases/033`）

- `browser_fill { fields: [name, email, city=上海], submit:true }` → 一次确认后 `Filled 3 field(s):` + 页面显示 `已提交： name = "林先生" email = "demo@example.com" city = "sh" note = ""`；select 选中「上海」。
- 坏地址 + 好地址混排 → `Error: Nothing was filled: the loc "css:#nope" no longer matches anything in the page…`，页面值一个都没变。
- 密码框 → `Error: Nothing was filled: field 1 is a password field. Credentials stay with the human…`，页面值不变。
- `browser_timeline` 回读：`#4 ok browser_fill (committed) 5236ms`、`#6 FAILED browser_fill [stale_loc]`、`#7 FAILED browser_fill [needs_human]`。
- 面板隐藏时 → `approval_required`（设计内），未下发任何键击。

## 5. 不做

- 不做多步向导 / 条件字段 / 依赖前面字段出现的动态表单（用多次 `browser_fill` + `browser_wait`）。
- 不填 checkbox/radio/file/date 控件（用 `browser_click` / `browser_upload`；`fillKindOf` 明确拒绝）。
- 不自动重试、不猜测字段含义、不读密码框、不处理跨域 iframe 内的表单。
- 不做「按标签名/占位符猜字段」（地址必须显式给 `loc`/`ref`/`selector`）。
- 提交后只等 350ms 观察地址变化，多步跳转/异步提交需自行 `browser_wait` / `browser_snapshot` 核对。

## 6. 验收清单

- [x] `browser_fill` 注册为第 20 个工具，计数（tooldefs/toolviews/wait/pick/read、check-docs、两份 README）全部同步
- [x] 页面侧 5 例 + 工具侧 6 例，全量 440/440
- [x] 1.5.26 打包装机（389,988 B / sha256 `ebedd8ad…`）
- [x] 真机：多字段一次填 + 提交、坏地址原子失败、密码拒绝、时间线回读
- [x] `docs/cases/033-fill-cases.md`、release notes、PROGRESS、docs/README、根/用户 README 全部更新
- [x] check-docs 七项全绿
