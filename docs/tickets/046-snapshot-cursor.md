# TICKET-046：快照预算与 `cursor` 续读（TICKET-046）

- 状态：✅ 已完成（2026-11-27，1.5.7；单测 296/296、`check-docs` 全绿、真机通过）P1（阶段 B2 观察增强）
- 关联：SPEC-004（B1 准入四问 / B3 证据四件套 / B5 人工优先级）、SPEC-001 §6（快照预算）、cases/020、TICKET-045（`loc=`）
- 先行能力：`browser_snapshot` 的 `maxChars`（默认 8000、夹 500–30000）

## 1. 缺口

快照超出字符预算时只有**截断**，没有**续读**。现在 agent 只有三条路：

1. 把 `maxChars` 拉到 30000，再截断一次（长页面还是读不完）；
2. 缩小查询范围（没有范围参数，只能改为点击/滚动后再拍）；
3. 重拍整棵树（每次从头，重复付 token，且不知道上一段读到哪里）。

竞品对照：dsh-browser-cdp 的不可变快照按字节分页（`offset / complete / next_offset`）；BrowserSkill 的
`observe` 输出带 `cursor` 续读；browserpaw 用 `observe --delta` 只给增量。共同点：**给下一段一个
可携带的游标**，而不是让调用方猜。

## 2. 准入四问（SPEC-004 B1）

| 问题 | 答案 |
| --- | --- |
| 读还是写？ | **读**。不新增动作类别，不触发审批（`actionClass` 不适用）。 |
| 可逆吗？ | 不适用：它不改变页面。 |
| 失败时能确定「没执行」吗？ | 能：没有任何副作用；错误只有「游标过期」和「参数不合法」两类。 |
| 人机墙 / 接管能绕过吗？ | 不能：`snapshot` 本来就是 `READ_TYPES`，`needs_human`/`taken_over` 下仍可读，且不会改变相位。 |

结论：通过准入，可进主干。

## 3. 目标

1. 截断的快照返回 `cursor`；`browser_snapshot({cursor})` 返回下一段，从上次断开处继续（不重复已交付行）。
2. 游标绑定**页面内容指纹**：页面变了（导航或 DOM 变化导致行数/引用数/字符数/URL 指纹变化）→
   返回新错误码 `stale_cursor`，提示「重新快照」，绝不给出错位的一段。
3. 续读是读动作：零审批、可用 `includeImage:false` 省图（续读不附截图）。
4. 兼容：不传 `cursor` 时行为与 1.5.6 一致；`truncated` 语义保留（还有更多 = truncated）。

## 4. 实现

### 4.1 页面侧（`plugin/inject/snapshot.js`）

- 遍历改为**完整遍历**（不再在预算处提前停），把整棵树的紧凑行收进 `lines`；预算与偏移在最后切分。
- 输出切片：`from = min(offset, total)`；从 `from` 起按 `maxChars` 取行；`from > 0` 时插入一行
  续读抬头 `- continued from line <from+1> of <total> (earlier part already delivered)`（计入预算）。
- 指纹 `stamp = <urlHash>.<total>.<refCount>.<chars>`（`urlHash` = FNV-1a 32 位、base36）。
- `cursor = stamp + '@' + nextOffset`；返回 `{ cursor?, more, nextOffset, totalLines, from }`。
- 传入 `cursor` 时解析出 `stamp@offset`；若当前 `stamp` 不匹配 → 返回 `{ stale: true }`（不返回错位文本）。

### 4.2 工具侧（`plugin/tools.js`）

- `parameters.cursor`（string，`additionalProperties:false` 不变）：`继续上一次被截断的快照；传入上次返回的 cursor`。
- `execute` 解析并夹取：`cursor` 长度 ≤ 300；请求参数带 `cursor`；`result.stale === true` →
  抛 `AgentBrowserError('stale_cursor', …)`。
- 输出映射 `{ from, totalLines, more, cursor }`；`truncated = result.more === true`。
- `render`：`from > 0` 时抬头写「continued from …」；`more` 时 footer 写
  `more: <n> lines remain — snapshot again with cursor="<cursor>"`，替换原来「narrow the query」的老文案（仍保留）。
- `includeImage`：带 `cursor` 时默认 false（续读不附图，省 token），显式 true 时仍可附。

### 4.3 客户端（`plugin/client.js`）

- `Guest.snapshot` 把 `cursor` 一并传给页面函数；`CLIENT_REV` 52 → 53。
- 续读（有 cursor）时不自动截图（除非调用方显式 `includeImage: true`）。

### 4.4 错误码

`errors.js` 追加第 18 个码：

```
stale_cursor: { retryable: true, hint: 'the page changed since that cursor was issued;
  take a fresh browser_snapshot (without cursor) and continue from its new cursor.' }
```

## 5. 证据四件套（SPEC-004 B3）

- 单测：`plugin/test/snapshot-cursor.test.mjs`（工具层 fake bridge：参数透传、映射、stale → 错误码、
  render 文案、cursor 长度夹取）。
- 真机 case：`docs/cases/020-snapshot-cursor-cases.md`（`demo/long.html` 长列表：截断 → 续读到底；
  页面变化后旧 cursor → `stale_cursor`；不传 cursor 与旧行为一致）。
- 错误码与 hint：`stale_cursor`（retryable true）。
- 文档三处：根 README（工具表 snapshot 行 + 错误码表）、`dist/.../README.md`（工具表 + 故障排查）、
  release notes（1.5.7）。

## 6. 不做

- 不做「按元素续读」（`cursor` 只按整棵树的偏移，不绑定某个节点）。
- 不做增量 diff（`--delta` 类观察），留到 B2 的「快照语义」一起评估。
- 不改默认 `maxChars`（8000），不改快照行格式。
- 不做跨快照缓存（每次续读仍重走一遍 DOM，换取实现简单与指纹可校验）。

## 7. 验收

- [x] 单元测试全绿（289 → 296，`snapshot-cursor.test.mjs` 7 例）；`check-docs` 六项全绿。
- [x] 真机：长列表截断后 `cursor` 续读能读完，且不重复已交付行（`docs/cases/020` 场景 1–2）。
- [x] 真机：页面变化后旧 `cursor` 返回 `stale_cursor`（追加 10 行后旧 cursor 立即被拒，`docs/cases/020` 场景 3）。
- [x] 不带 `cursor` 的快照与 1.5.6 行为一致（截断与 `truncated` 语义不变，footer 增加 cursor 提示）。
- [x] 文档三处同步、release notes 1.5.7 记录、PROGRESS/tickets 索引更新。

## 8. 风险

- R1：完整遍历让超大页面变慢（几百 ms 级）；以「截断时反正也读不完」为代价换取可续读，必要时后续加节点上限。
- R2：指纹用行数/引用数/字符数，极端情况下页面变了但四项相同 → 给出错位段。缓解：指纹含 URL；且
  `cursor` 由模型显式携带，不是长期票据；文档写明「页面变化后请重新快照」。
- R3：续读抬头占字符预算，第一段可能因此少一行；可接受（抬头本身是必要信息）。
