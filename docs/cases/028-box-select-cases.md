# 028：`browser_pick mode:"box"` 框选验收（1.5.16）

**日期**：2026-11-27
**装机**：`dsh-plugin-agent-browser-1.5.16.tgz`（364,587 B / `BF7D8A46…`），面板无需重启即执行新客户端
**夹具**：`demo/box.html`（10 个复选框、3 行重复「导出」、订单卡片；页面用 `document.addEventListener('click', …, true)` 统计真实点击）
**服务地址**：`http://127.0.0.1:5099/t/demo/box.html`

## 1. 结论

| # | 验收点 | 结果 |
|---|---|---|
| B1 | 框选一片区域能拿到框内元素列表 | ✅ 框住 10 个复选框区域 → `it holds 21 element(s)`（total 21、limit 10、truncated true） |
| B2 | 框内的 loc 可直接用于既有动作工具 | ✅ 用框选返回的 `css:[data-testid="row-export"]` 调 `browser_click` → `Clicked button "导出" at (575, 278).`，页面计数 +1 |
| B3 | 框选本身不向页面派发按下/点击 | ✅ 干净框选前后页面计数不变（4 → 4），用户确认「没有变蓝」（无文本选区） |
| B4 | element 模式旧行为不受影响 | ✅ `browser_pick`（默认模式）点标题 → `The person picked h1 "框选夹具" (loc: css:html > body:nth-of-type(1) > h1:nth-of-type(1))…`，页面计数不变 |
| B5 | 超时是正常回执 | ✅ 第一次发起时人还没开始拖 → `The person did not finish picking within the time budget; the page was not touched.` |
| B6 | 小框/空框返回空列表（不报错） | ✅ 单测覆盖（宽高 <4px → 空 elements / total 0） |
| B7 | `limit` 截断与 `truncated` | ✅ 单测 `limit:1` → elements 1 / total 3 / truncated true；真机 limit 10 / total 21 → 截断提示 |
| B8 | Esc / 面板取消按钮 | ✅ 复用 TICKET-053 同一状态机（真机已在 027 验证取消按钮）；框选模式单测覆盖 Esc 取消并恢复选区 |
| B9 | 工具数保持 16、错误码保持 21 | ✅ check-docs 六项全绿（工具 16、配置 21、YAML 13、decisions 10、B11、file:line 12） |

## 2. 命令与回执原文

### B1 框住复选框区域（limit 10）

```
browser_pick { mode: "box", limit: 10, timeoutMs: 120000 }
The person drew a box over (16, 115) 668×135 and it holds 21 element(s). Move one at a time with browser_click { loc } / browser_type { loc }:
* css:body:nth-of-type(1) > div:nth-of-type(1) > label:nth-of-type(1) — label "条款一" (28, 127 149×33)
* css:#agree-1 — textbox "条款一" (47, 135 13×13)
* css:body:nth-of-type(1) > div:nth-of-type(1) > label:nth-of-type(2) — label "条款二" (197, 127 149×33)
…
The box held more elements than the limit, so some were not collected.
```

### B2 用框选到的 loc 点一下

```
browser_click { loc: 'css:[data-testid="row-export"]' }
Clicked button "导出" at (575, 278).
```

随后快照：`页面收到的点击：5 最后一次： button「row-export」`（此前为 4，恰好 +1）。

### B3 干净框选（三条「导出」列表）

```
browser_pick { mode: "box", limit: 10, timeoutMs: 120000 }
The person drew a box over (17, 243) 619×181 and it holds 10 element(s). Move one at a time with browser_click { loc } / browser_type { loc }:
* css:body:nth-of-type(1) > div:nth-of-type(2) — div "导出报表列表" (28, 255 583×156)
* css:body:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1) — div "导出 2025 年 11 月报表 导出" (28, 255 583×47)
…
* css:body:nth-of-type(1) > div:nth-of-type(2) > div:nth-of-type(1) > span:nth-of-type(1) — span "导出 2025 年 11 月报表" (43, 266 161×24)
* css:[data-testid="row-export"] — button "导出" (554, 265 43×25)
…
Picking itself did not click the page, and the page state is unchanged.
```

框选前后快照均为 `页面收到的点击：4`；用户同时确认「拉完了，没有变蓝」。

### B4 element 模式对照

```
browser_pick { timeoutMs: 120000 }
The person picked h1 "框选夹具" (loc: css:body:nth-of-type(1) > h1:nth-of-type(1)). Use it with browser_click { loc: … } or browser_type { loc: … }. Picking itself did not click the page, and the page state is unchanged.
```

页面计数仍为 4。

### B5 超时

```
browser_pick { mode: "box", limit: 10, timeoutMs: 120000 }
The person did not finish picking within the time budget; the page was not touched. Make sure the browser panel is visible, then ask again — or fall back to browser_snapshot and a ref/loc.
```

## 3. 验收期发现

1. **框选元素列表包含容器**：12px 网格采样会同时命中行容器、行内文本 span 和按钮（B3 的 10 条里 4 条是容器/文本）。这是预期行为——agent 自己挑合适的 loc；文档写明「列表是候选，不是唯一答案」。
2. **计数噪音不代表泄漏**：准备阶段页面计数被人工交互带到 4（打开后用户点过页面）；受控实验里 element 模式、干净框选、超时三次前后都不变，最后真实 click 精确 +1。基线应在受控实验前重置或用「同一动作前后对比」判断。
3. **文本选区只在框选外发生**：早期一次框选前用户先做了别的拖拽导致文字变蓝；在按照说明「只拉一次框」后没有变蓝，说明 box 模式的 `preventDefault`（pointerdown）+ body `userSelect:none` 生效。
4. **第一次发起超时是流程问题**：`browser_pick` 发起后人还没开始拖就超时——工具层把超时当正常回执，提示里明确「page was not touched」，不需要重试特殊处理。

## 4. 复跑步骤

```powershell
# 1) 打开夹具（端口随机构建，以回执为准）
browser_open { path: "demo/box.html" }

# 2) 框选复选框区域
browser_pick { mode: "box", limit: 10, timeoutMs: 120000 }
# 人：从「条款一」左上方拖到「条款十」右下方，松手

# 3) 用框选返回的 loc 点一下
browser_click { loc: 'css:[data-testid="row-export"]' }

# 4) 快照核对页面计数与最后一次点击
browser_snapshot {}
```

## 5. 已知边界

- 12px 网格采样：比 12px 更小的目标可能漏采；`limit` 默认 20（夹 1–100），`total` 是去重后的真实命中数；
- 跨域 iframe 只能框到宿主 `<iframe>` 本身；canvas 只返回 `<canvas>` 整体；
- 框选结束后的那一下 click 由 `swallowNextClick` 吞掉；框选过程中的按下/拖动/松手页面都收不到；
- 不做框内文本提取、批量执行，也不覆盖 OS 级拖拽。
