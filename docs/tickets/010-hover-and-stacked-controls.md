# TICKET-010 叠卡与悬停展开类控件（`browser_hover`）

- 状态: ✅ 已完成并装机（`1.0.19`，`HOST_REV 21`，2026-11-20）
- 优先级: P2（不阻塞 T1–T8；挡的是 V12 第 3 步这类"必须 hover 才展开"的控件）
- 关联: `docs/spec/001-agent-browser-plugin-spec.md` A6（坐标点击）、`docs/tickets/009-action-surface-gaps.md` 的"风险与残留"、`docs/cases/010-validation-cases.md` V12 第 3 步

## 问题（真站实测）

百度地图右下切换模块是三张叠在一起的 3D 卡片：

| 卡片 | `getBoundingClientRect` | z | `pointer-events` |
|---|---|---|---|
| `.mapTypeCard.normal.active` | (349, 738) 86×60 | 1 | auto |
| `.mapTypeCard.earth` | (354, 738) 86×60 | 2 | auto |
| `.mapTypeCard.panorama.choosedType` | (359, 738) 86×60 | 3 | auto |

三张卡只差 5 px（斜向叠压），**地球卡只露出 5 px 左缘**。1.0.12 的九点采样（中心 → 四边中点 → 四角）全部落在最上层的"全景"卡上，`browser_click({selector:'.mapTypeCard.earth'})` 稳定返回：

```
Error: selector ".mapTypeCard.earth" is covered by div "全景", so a click would land on that instead.
```

真人操作是：**鼠标移到模块上 → 卡片展开成一排 → 点"地球"**。当前动作面没有 hover 原语，所以这一步只能退回 `browser_eval`（`document.querySelector('.mapTypeCard.earth').click()`），而 eval 点击是**不可信输入**，会绕过前端的 hover 逻辑（本例恰好有效，但不能推广）。

## 期望行为

1. 新增 `browser_hover({selector?, strict?, x?, y?})`
   - 解析目标（复用 `pickSelector` / `pickPoint`），把鼠标移到该点（**不发 down**）；
   - 等 `waitMs`（默认 150）后复读位置与尺寸，返回 `{x, y, info, grew: true|false}`；
   - 命中测试与 `click` 同分型（`not_found`/`multiple`/`occluded`/`bad_selector`）。
2. `browser_click` 增加 `reveal: 'hover'`（可选）：`occluded` 时先 hover 遮挡者/目标，等一帧再重新采样，**最多一轮**，仍 `occluded` 就照旧报错（不无限重试）。
3. 结果文案要能区分"hover 之后点到了"与"没点"。

## 实现要点

- `plugin/client.js:691 clickAt(x, y)` 已经先发 `mouseMove` 再 `mouseDown`/`mouseUp`（`sendInputEvent`），**hover 只需截取那一步**：抽成 `moveTo(x, y)`，`clickAt` 复用它；
- `inject/actions.js` 增加 `op === 'hover'`：与 click 共用解析/命中测试，返回 `{ok:true, info, point}`，不调用 `neutralizeTarget`、不 `takeBlocked`；
- `bridge.js` 的 `INPUT_TYPES` 加 `hover`（用户接管时一并拒绝）；
- `tools.js` 注册第 9 个工具；dist README/locale 的"八个工具"改九个。

## 验收

- [x] 夹具新增"hover 才展开"的一块：`.stack` 三张卡叠压（与百度同样 5 px 偏移），`mouseover` 时加 `.open` 让三张平铺 → `browser_hover({selector:'#stack'})` 后 `browser_click({selector:'.card.earth'})` 应成功且页面事件可证；
- [x] 无 hover 展开的纯叠卡（只露 5 px）：直接点/直接 hover 那**一张卡**仍 `occluded`，错误文案分型正确且不误导；
- [x] 回归：`#covered`、`.pager`、`#submit`、`#deep`、`#pop`、`#blank` 行为不变（`docs/tickets/009` 的夹具原样跑一遍）；
- [x] 单测覆盖 hover 的解析与 `grew` 判定（3 例：解析+落点、遮挡分型、禁用控件可 hover）。

## 实现记录（1.0.19）

| 层 | 改动 |
|---|---|
| `plugin/inject/actions.js` | 新增 `op === 'hover'`：复用 selector/ref 解析与 `pickPoint` 命中测试（**不做 disabled 检查**——禁用的按钮也能悬停），返回 `{ok, point, rect, info, pageHeight, layout}`；`layout` 是目标子树最多 40 个后代的坐标指纹，用来判断"卡片是不是展开了"（容器自身矩形不变，子元素会动） |
| `plugin/client.js` | 新增 `guest.hover(params)`：先 `act('hover')` 求落点 → `moveTo`（真 `sendInputEvent mouseMove`）→ 等 `waitMs`（默认 150，上限 2000）→ 再 `act('hover')` 复读同一目标 → 比较落点/文档高度/子树指纹得出 `grew`；`runCommand` 增加 `hover` 分派 |
| `plugin/bridge.js` | `INPUT_TYPES` 加 `hover`（用户接管时一并拒绝） |
| `plugin/tools.js` | 第 9 个工具 `browser_hover({ref|selector|strict|x|y|waitMs})`，输出 `{tag, role, name, x, y, grew}`；`actionFailure(result, 'hover')` 的 `occluded`/`not_found`/`out_of_view` 换成悬停口吻（"the pointer would rest on that instead" / "nothing was hovered"） |
| 版本 | `package.json` 1.0.19、`HOST_REV` 21、tgz 63,046 B / 17 文件；dist README「九个工具」+ hover 行，locale zh/en 描述加 `browser_hover` |

**真站实测（2026-11-20，`https://map.baidu.com/`）**：

1. 直接点：`browser_click({selector:'.mapTypeCard.earth'})` → `Error: selector ".mapTypeCard.earth" is covered by div "全景", so a click would land on that instead.`
2. 悬停容器：`browser_hover({selector:'#mapType'})` → `Hovered div "全景" at (714, 768). The layout changed under the pointer — something expanded.`，随后三卡坐标 x=349/354/359 → **167/263/359**（地球卡与全景卡不再重叠）。
3. 再点：`browser_click({selector:'.mapTypeCard.earth'})` → `Clicked div "地球" at (620, 768).`，`location.href` 变 `https://map.baidu.com/@12610282,2625635,12.75z/maptype%3DB_EARTH_MAP`，卡片 class 变 `mapTypeCard earth active`。
4. 反向验证：`browser_hover({selector:'.mapTypeCard.earth'})`（直接悬停被压住的那张卡）→ `Error: selector ".mapTypeCard.earth" is covered by button "全景", so the pointer would rest on that instead. Move the covering element away …, then retry — nothing was hovered.`——**不猜**。

**夹具实测**：`#stack` 与百度同构（5 px 偏移、`mouseenter` 展开）；`browser_hover({selector:'#stack'})` → `Hovered button "地球" at (167, 544). The layout changed under the pointer — something expanded.` → `browser_click({selector:'.card.earth'})` → `Clicked button "地球" at (160, 542).`，`__dshFixture.stack()` = `{open:true, active:'earth', out:'当前：地球'}`。`grew:false` 的真实场景也验了：指针本来就停在已展开的控件上时如实报 "Nothing moved under the pointer"。

**单测**：`plugin/test/actions.test.mjs` 20 → 23 例；全量 `node --test plugin/test/actions.test.mjs plugin/test/downloads.test.mjs plugin/test/static.test.mjs` = **55 / 55 pass**。

**实现期踩到的两个坑**

1. **BOM 让安装整包被拒**：用 PowerShell `Set-Content -Encoding utf8` 改 `dist/.../package.json` 会写入 UTF-8 BOM，pnpm 装完后 DSH 校验报 `SyntaxError: Unexpected token '﻿', "﻿{"na"... is not valid JSON`，安装被回滚。改用 Node `JSON.parse` → `JSON.stringify` 重写（含 `.replace(/^\uFEFF/,'')` 兜底）。
2. **`grew` 不能只看自身矩形**：叠卡展开时容器矩形不变、只有子元素在动，最初版本恒报 `grew:false`；改成"子树坐标指纹 + 文档高度 + 落点位移"三者取或。

**已知残留（未做，属 TICKET-010 原文档的第 2 条）**：`browser_click({reveal:'hover'})` 未实现——现在要求调用方自己先 `browser_hover` 再 `browser_click`，两步比一步更啰嗦，但也更可观测（每次 hover 都留下一条结果）。如果以后确实嫌烦再补。

## 风险

| 风险 | 缓解 |
|---|---|
| 部分站点 hover 后才发网络请求，150 ms 不够 | `waitMs` 可调；`grew` 只是提示，不当作"展开成功"的证据 |
| hover 触发 tooltip 反而遮挡目标 | 只允许一轮 `reveal`，失败即报错；不做自动多点 hover |
| 悬停本身有副作用（预览浮层、自动播放） | 文档标明 hover 与 click 同样算"有副作用动作"，不放进只读探测路径 |
