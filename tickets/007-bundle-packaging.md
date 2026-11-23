# TICKET-007：打包交付（bundle 化 + 安装验证）

- 状态: ✅ 通过（2026-11-20）
- 优先级: P1（功能验收后做）
- 关联 Spec: `spec/001-agent-browser-plugin-spec.md` §11
- 依赖: TICKET-002 ~ TICKET-006
- 产物目录: `D:\Vibe coding\32 deepseek harness cebiankuang\dist\dsh-plugin-agent-browser\`

## 目标

把开发期"直接铺在 profile `node_modules`"的插件，变成一个能走 `plugin_manager install_bundle` 正式安装的包：插件管理里能看到图标、标题、详情页，能启用/禁用/卸载，卸载后无残留。

## 结果

产物 `dsh-plugin-agent-browser-1.0.3.tgz`：**47,430 字节、16 个文件**，装进 profile 后是 16 个文件的真目录（`LinkType` 为空，不再是 junction）。安装 → 禁用 → 启用 → 卸载 → 再安装全流程在真实桌面端跑通，除首次从 link 切到真包需要重启一次（见「实测发现」1）外，其余步骤都不需要重启。

## 交付物（实际结构）

```
dsh-plugin-agent-browser/
├── package.json          # name/version/exports/dsh.client/dsh.bundle.patch/files
├── cordis.patch.yml      # insert: id: agent-browser-panel
├── icon.svg              # 64×64，蓝底窗口 + 白色光标
├── README.md             # 用户向说明（安装/六个工具/接管/已知限制/卸载）
├── index.js              # host 面（Bridge + 工具注册 + StaticSites）
├── bridge.js             # 命令队列 + 相位机
├── tools.js              # 六个工具定义
├── static.js             # 工作区只读静态服务
├── client.js             # client 面（tab 注册 + 面板 + webview + 轮询泵）
├── inject/               # 注入页面的三段脚本
│   ├── snapshot.js
│   ├── actions.js
│   └── detect.js
├── locale/zh.json|en.json  # meta.title / meta.description / meta.detail
└── docs/DETAIL.md + docs/preview.svg   # 详情页（一行图片）
```

## 验收

- [x] `plugin_manager install_bundle` 安装成功，插件列表中出现「浏览器面板（Agent）」，图标正常 — 安装多次成功（`application: applied`）；文件名与 locale 已核对，**图标 / 标题 / 详情页由用户目视确认通过**（2026-11-20）
- [x] 插件管理详情页能打开，渲染 `docs/DETAIL.md`（`meta.detail` 指向它），无外链图片 — `preview.svg` 为自包含 640×300、无 `<text>`/`<foreignObject>`/外链
- [x] 禁用插件 → 右侧栏 tab 消失、`browser_*` 工具从工具列表消失、无报错 — `set_plugin enabled:false` → `application: applied`，桥接端口 8792 立即不可连接（host 半销毁），工具表刷新掉六个工具
- [x] 重新启用 → 一切恢复，无需重启应用 — `set_plugin enabled:true` → `applied`，`/health` 回 `{"clients":1,"parked":1}`，六个工具回表
- [x] 卸载插件 → 包目录被清、profile 的 `cordis.patch.yml` 无残留行、重启无报错 — 卸载后 `dependencies` 无该包、`dsh.profile.bundles` 无该条、`node_modules\dsh-plugin-agent-browser` 不存在、无 junction、patch 文件里 `agent-browser` 命中 0 处、桥接端口关闭
- [~] 全新环境验证：把 `dist/` 拷到另一台机器的 profile 装一遍 — **未做**（没有第二台机器）；替代证据是"卸载后从 tgz 重新安装即恢复可用"，覆盖了"包自身自洽、不依赖开发期 link 目录"
- [x] `meta.description` 里描述的行为与实际一致 — 六条工具、引导页入口、四态徽章、接管/交还、验证检测不绕过，逐条对照 `reference/005`/`006`/`007`
- [x] 包内不含 `node_modules`、不含源码 map、总体积 < 3 MiB — 47,156 字节（tgz）/ 155,272 字节（解包后）
- [x] 卸载后重新从 tgz 安装 → 六个工具与面板恢复，`browser_open({path:'demo/index.html'})` 端口 11179、快照带图、点击后 `hits: 1`

## 实际实现（与原计划的差异）

1. **没有 `lib/`、没有 `src/`、没有构建步骤**。整个插件是手写纯 JS（host 面 5 个 `.mjs` 风格的 `.js`、client 面 1 个文件），`main` 直接指 `./index.js`、`./client` 指 `./client.js`。原计划的 `tsc` + client bundle 在这条路径上没有收益：DSH 的 client 模块系统加载的是 `window.__ModuleLoader__.load({ id, factory })` 包裹的单文件，手写反而少一层。
2. **详情页是"一行图片"**，不是长篇 `detail.md`。`dsh-doc` 的 `plugin-details.md` 明确：`meta.detail` 指向的文档内容应当只有一行 `![alt](preview.svg)`，功能与用法写进 `meta.description`。因此 `docs/DETAIL.md` 只有一行，长文案全在 `locale/*.json` 的 `meta.description` 里。
3. **入口 id 从 `agent-browser` 改成 `agent-browser-panel`**（排障副作用，见下）；包版本因此到 `1.0.1`。
4. **工具是六个而非七个**：截图并进 `browser_snapshot`（`includeImage`），不单独占一个工具位——这是 TICKET-003 就定下的，此处一并记录与 spec §D05 的偏差。
5. 预估"半天到 1 天"，实际约 2 小时（含一次重启排障）。

## 实测发现

1. **loader 按包名缓存"已解析的真实路径"，只在进程内存里**。开发期插件是 link 安装（junction 指向 `D:\Vibe coding\32 deepseek harness cebiankuang\plugin`），换成从 tgz 装真包后，热重载会报：
   `failed to import: Error: ENOENT: no such file or directory, open 'D:\Vibe coding\32 deepseek harness cebiankuang\plugin\index.js'`
   排除过：删掉重装（仍失败）、版本号 1.0.0 → 1.0.1（仍失败）、loader 条目 id 改名（仍失败）——说明键是**包名**。磁盘上装的确实是真包、profile 的 `cordis.patch.yml` 也没有旧路径，因此只能是进程内缓存，**只有重启 DSH 能清**。重启后一切正常，之后再怎么禁用/启用/卸载/重装都不再需要重启。
2. **PowerShell 5.1 没有 `utf8NoBOM`**（`Set-Content -Encoding utf8NoBOM` 直接报枚举不匹配），而 `Set-Content -Encoding utf8` 会写 BOM，`dsh` 校验包时直接拒绝：`Cannot validate installed package dsh-plugin-agent-browser: SyntaxError: Unexpected token '﻿', "﻿{\n  "name"... is not valid JSON`。改包内 `package.json` 一律用编辑工具，或校验首字节是否为 `123,10`。
3. pnpm 安装时会警告 `Issues with peer dependencies found`——因为 `package.json` 故意不声明 `cordis` / `react` / `dsh-client-*` 的 peer。这是**有意的**：声明了反而会在 profile 里解析不到，导致安装失败。警告可忽略。
4. 卸载是干净的：依赖、`dsh.profile.bundles`、`node_modules` 目录、patch 行、监听端口全部回收，没有 junction 残留（开发期那次卸载残留过 junction，这次没有）。
5. `install_bundle` 支持 tgz 与目录两种目标；tgz 走 pnpm 正常解析（`+ dsh-plugin-agent-browser 1.0.3`，1.2–1.3 秒）。
6. 插件被禁用时 host 半立即销毁 → 桥接端口关闭 → 面板的轮询请求全部失败，但**不影响 DSH 本身**；重新启用后 client 半重新连上，无需刷新页面。
7. **`remove_bundle` 会清空 link 安装的源目录**：开发期 `plugin/` 有一次被清空，9 个源文件消失（`LastWriteTime` 与那次卸载同秒）。改成真包安装后再执行同一个操作，`plugin/`（10 个文件）与 `dist/`（17 个文件）都完好——所以是"卸载 link 安装会删链接目标里的内容"。恢复靠 `dist/` 里的副本，`tools/pack.mjs` 负责以后的双向搬运。
8. **包版本 ≠ 正在跑的代码**：1.0.2 → 1.0.3 只 `install_bundle` 时，磁盘是 1.0.3 而 `/logs` 里仍是 `client half applied {"rev":24}` —— client 半没重载。确认"新代码在跑"只能看 `/logs` 的 `rev`；要让 client 半重载必须 bump `CLIENT_REV` 且 `remove_bundle` + `install_bundle`。
9. 验收过程中顺带修掉两个真问题：`browser_open({ path })` 之前不接受前导斜杠（`path.isAbsolute('/demo/x')` 在 Windows 上是 true，被误判成 `path_escape`），现在三种写法都接受并有用例锁住；首次命令等面板挂载的宽限从 1.5s 提到 5s（`MOUNT_GRACE_MS`），因为"开 tab + 建 webview + 等 dom-ready + 拿租约"在刚重载后会超过 1.5s，原本表现为"面板不在屏幕上"的假失败。

## 任务分解（实际做法）

- [x] 按发布结构整理 `plugin/` → `dist/dsh-plugin-agent-browser/`（扁平，无 `lib/`）
- [x] 写 `package.json`：`exports` 六出口、`dsh.client`（`platform:'web'` + `immediately`）、`dsh.bundle.patch`、`files`
- [x] 写 `cordis.patch.yml` 的 `insert:` 行
- [x] 画 `icon.svg`（64×64，蓝底窗口 + 白色光标）
- [x] 写 `locale/zh.json`、`en.json`：`meta.title` / `meta.description` / `meta.detail`
- [x] 写 `docs/DETAIL.md`（一行图）+ `docs/preview.svg`（640×300，无文字）
- [x] 写 `README.md`：安装、六个工具表、接管、已知限制、卸载
- [x] `npm pack` 出 tgz，`tar -tzf` 核对 17 个文件、47,156 字节
- [x] `plugin_manager install_bundle` → 禁用 → 启用 → 卸载 → 再安装，全程实测
- [x] 重启一次清掉 loader 的路径缓存（唯一需要重启的步骤）

## 风险（落地情况）

| 风险 | 结果 |
|---|---|
| client bundle 加载失败 | 未发生：`__ModuleLoader__.load` 的 `id` 与包名一致，六个工具与面板均正常 |
| 详情页写了未验证内容 | 已规避：只写 `reference/005`/`006`/`007` 里有实测证据的行为 |
| 装到别的机器后 workspace 路径不存在 | 未验证（无第二台机器）；代码层面 `workingDirectory.ensure()` 失败会给明确错误 |
| `keepMounted` 在禁用插件时泄漏 webview | 未发生：禁用后 host 半销毁，`dispose` 里 `release()` 租约、`StaticSites.dispose()` 关端口 |

## 参考

- `dsh-doc` 的 `references/plugin-details.md`（元数据、详情页、体积上限）
- `dsh-doc` 的 `templates/decoration/*`（`package.json` / `cordis.patch.yml` / `client.js` 的最小形态）
- 验收全过程见 `reference/008-packaging.md`
