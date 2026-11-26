# TICKET-043：F7/F8 安全真机验收（不依赖热重载）

- 状态：📋 待办 P1（阶段 A4，见 `docs/spec/004-capability-admission-spec.md` §6）
- 发现：2026-11-25 F7/F8 尝试被两次白屏打断（TICKET-040）
- 关联：`docs/spec/003-first-touch-approval-spec.md` C3（站点级豁免）、C9（配置）、`docs/cases/015-first-touch-cases.md` §4、`docs/tickets/040`

## 背景

`docs/cases/015` §4 的装机验收表里，F1–F6、F9–F12 已真机通过，**F7（`approvals.sensitiveSites` 每次必问）/ F8（`approvals.mode:'off'` 完全不问）只有契约级覆盖**。2026-11-25 尝试真机验收时：

1. 改 `cordis.patch.yml` 会热重载插件（已证实：`limits.snapshotMaxChars` 改 200 后 snapshot 输出变小，改回恢复）；
2. 热重载窗口里出现「审批不弹条 / inspect 返回空 origin」的瞬态（插桩证明运行时 settings 正确、`canAsk=true`、`confirmBefore` 被调用；重载完成后又恢复正常）；
3. 随后两次白屏（TICKET-040）打断验收。

结论：**F7/F8 本身没有发现功能缺陷，但验收方法（热重载注入配置）不可靠**。本 ticket 要换一条安全、可重复的验收路径，把 F7/F8 从「契约级」补成「真机」。

## 目标

1. F7 真机：配置 `sensitiveSites: [127.0.0.1]` 后，**同一站点第二次写动作仍然弹确认条**（站点豁免对敏感站无效）。
2. F8 真机：配置 `approvals.mode:'off'` 后，写动作**完全不弹条、直接执行**（与 1.4.x 行为一致）。
3. 全程不触发热重载、不再冒白屏风险；若配置必须生效，采用「重启后一次注入」。

## 安全验收流程（替代热重载）

### 第一步：准备（不碰生产 profile 的热重载）

- 备份 `C:/Users/林焕文/.dsh/profiles/desktop/cordis.patch.yml` 到 `cordis.patch.yml.bak-f78b`。
- 用 `write`/`edit` 工具（**不要用 PowerShell 文本管道**）在 `agent-browser-panel.config` 下加：

```yaml
    approvals:
      timeoutMs: 30000
      sensitiveSites:
        - 127.0.0.1
```

- **让用户手动重启 DSH**（或等它在白屏排查结论出来前不使用热重载），重启后先 `plugin_manager list_bundles` 确认插件 active，再 `browser_snapshot` 确认面板重挂。

### 第二步：F7 真机（敏感站每次必问）

1. `browser_open { path: 'demo/approval-form.html' }`（记录当前插件静态端口）。
2. `browser_type e2 'F7-A'` → 用户点「允许一次」→ 成功；**第二次** `browser_type e2 'F7-B'` → **必须再次弹条**（敏感站不享受站点豁免）。
3. 用户点「拒绝」→ 回 `approval_denied`，输入框保持 `F7-A`。
4. 记录：确认条是否出现、origin 是否写对 `127.0.0.1`、两次是否都弹。

### 第三步：F8 真机（mode off 完全不问）

1. 把配置改成 `approvals: { mode: off, timeoutMs: 30000, sensitiveSites: [127.0.0.1] }`，再次让用户手动重启。
2. `browser_open` 同一夹具、`browser_type e2 'F8-off'` → **不弹条、立即执行**；`browser_click e4`（提交）→ 不弹条；`browser_eval` → 不弹条。
3. 对照：与 1.4.x 的「无审批」行为逐字一致（无 `approval` 相关错误码、无确认条 DOM）。

### 第四步：恢复

- `Copy-Item cordis.patch.yml.bak-f78b → cordis.patch.yml`（去掉临时 approvals 块，回默认 first-touch）。
- 让用户重启一次 DSH 或等下次重启生效；`browser_snapshot` 确认面板正常。
- 若中途再次白屏：立即停，按 TICKET-040 记录证据，本 ticket 保持未完成。

## 验收

- [ ] F7 真机：敏感站第二次写动作仍弹条（有截图或工具回执记录）。
- [ ] F8 真机：off 模式下 type/click/eval 全部不弹条、直接执行，且无 approval 错误码。
- [ ] 结束后 profile 配置已恢复默认（`approvals` 键不存在），面板正常。
- [ ] 结果写进 `docs/cases/015-first-touch-cases.md` §4（把 F7/F8 从「⚪ 契约级」改为「✅ 真机」）与 `docs/release/release-notes-1.5.md` 已知限制。
- [ ] 若 F7/F8 任一不通过：建缺陷 ticket，写清复现路径（这是功能缺陷，不是验收方法问题）。

## 注意

- **不要用 `plugin_manager set_bundle enabled:false/true`** 来「清豁免」：这条路径是第一次白屏的触发动作（TICKET-040）。
- 换 origin 不要用 `localhost`（插件静态服务只认 `127.0.0.1`，会 403 `forbidden`）；需要新 origin 时用 `tmp/serve-demo.mjs` 起另一个 127.0.0.1 端口。
- 验收期间不要同时做代码热重载 / 装包；装包会重挂面板（已知行为）。
