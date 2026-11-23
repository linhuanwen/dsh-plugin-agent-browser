# docs/cases/008 — 打包与交付

这份文档记录：怎样把一个开发期"铺在 profile 里"的插件，变成一个能正式安装、启用、禁用、卸载的包。所有结论都在 DSH Desktop 0.2.2-rc.3 上实测过，对应 TICKET-007。

产品本体见 `docs/cases/004`（快照）、`005`（动作）、`006`（接管）、`007`（本地文件）。

## 1. 发布结构

```
dsh-plugin-agent-browser/
├── package.json
├── cordis.patch.yml
├── icon.svg
├── README.md
├── index.js          ← main
├── bridge.js         ← host 面附加模块，靠相对 import 引入
├── tools.js
├── static.js
├── client.js         ← exports["./client"]
├── inject/{snapshot,actions,detect}.js
├── locale/{zh,en}.json
└── docs/DETAIL.md + docs/preview.svg
```

**不需要 `lib/` 也不需要构建步骤**。DSH 的 client 半由浏览器里的 `__ModuleLoader__.load({ id, factory })` 加载，`id` 必须等于包名；host 半就是普通 ESM，`main` 指过去即可。原计划里的 `tsc` + client bundle 在这条路径上没有收益。

目录可以扁平，`inject/*.js` 保持相对路径不变，这样从 `plugin/` 复制到 `dist/` 时不需要改任何代码。

## 2. package.json 的四个关键字段

```json
{
  "name": "dsh-plugin-agent-browser",
  "version": "1.0.3",
  "private": true,
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "bridge.js", "tools.js", "static.js", "client.js",
            "inject", "cordis.patch.yml", "locale", "docs", "icon.svg", "README.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true }
  }
}
```

- `exports["./client"]` 是 client 半的入口；`exports["./icon"]` 与 `exports["./locale/*.json"]` 是插件管理读取元数据用的。
- `dsh.client.immediately: true` 让 client 半在启动时加载，否则要等第一次打开对应 UI。
- **故意不写 `peerDependencies`**：声明了 `cordis` / `react` / `dsh-client-*` 之后，pnpm 在 profile 里解析不到这些包，安装会失败。代价是安装日志里有一行 `Issues with peer dependencies found` 警告——可以忽略。
- `files` 要显式列出，否则 `npm pack` 会把 `demo/`、测试之类的东西一起打进去。

## 3. cordis.patch.yml

```yaml
- insert:
    - id: agent-browser-panel
      name: 'dsh-plugin-agent-browser'
```

`id` 是 loader 条目的稳定标识（禁用/启用/卸载都靠它定位），`name` 是包名。**这两者都不影响 loader 的解析缓存**——缓存键是包名，见下面第 6 节。

## 4. 展示元数据

| 位置 | 作用 | 约束 |
|---|---|---|
| `locale/<lang>.json` 的 `meta.title` | 插件列表里的名字 | 短 |
| `meta.description` | **功能与用法**：有哪些工具、UI 在哪、接管语义、限制、关掉会失去什么 | 这是唯一能写长文案的地方 |
| `meta.detail` | 指向详情页文档，如 `"docs/DETAIL.md"` | 文档内容**只能有一行** `![alt](preview.svg)` |
| `docs/preview.svg` | 详情页那张图 | `640×300`、自包含、**禁止 `<text>` / `<foreignObject>` / `<script>` / 内联 CSS**、明暗主题都可读 |
| `icon.svg` | 列表图标 | ≤ 256 KiB |

没画到图就把 `meta.detail` 整条删掉，不留空指针。本包的两份 locale 都是这么写的：长文案在 `meta.description`，`docs/DETAIL.md` 只有一行图。

## 5. 安装 → 禁用 → 启用 → 卸载

```text
plugin_manager install_bundle target=<tgz 或目录>   # applied
plugin_manager set_plugin enabled=false target=include:agent-browser-panel
plugin_manager set_plugin enabled=true  target=include:agent-browser-panel
plugin_manager remove_bundle target=dsh-plugin-agent-browser
```

实测行为：

- **安装**：pnpm 走 `file:` 依赖，1.2–1.3 秒；`application: applied` 之后六个工具立刻出现在工具表里。
- **禁用**：host 半立即销毁——桥接端口 8792 随即不可连接，工具表里的六个工具消失。client 半的面板随之卸载。
- **启用**：host 半重建、端口回来，client 半重新连上（`/health` 里 `clients:1`、`parked:1`），六个工具回表。**不需要重启应用，也不需要刷新页面。**
- **卸载**：`dependencies`、`dsh.profile.bundles`、`node_modules/<包名>`、`cordis.patch.yml` 里的行全部回收，没有 junction 残留，端口关闭。
- **卸载后再从 tgz 安装**：直接 `applied`，工具与面板恢复，`browser_open({ path })` 正常工作。

## 6. 唯一需要重启的一次：link 安装 → 真包安装

开发期用 `dsh-plugin-agent-browser` 这个包名做 **link 安装**（profile 里是一个 junction，指向 `D:\Vibe coding\32 deepseek harness cebiankuang\plugin`）。换成从 tgz 装真包之后，热重载会失败：

```
dsh: warning: 1 entry did not activate
agent-browser-panel (dsh-plugin-agent-browser): failed to import:
Error: ENOENT: no such file or directory, open 'D:\Vibe coding\32 deepseek harness cebiankuang\plugin\index.js'
```

排除过程（都失败）：删掉重装、版本号 1.0.0 → 1.0.1、loader 条目 id 从 `agent-browser` 改名成 `agent-browser-panel`。而磁盘上装的确实是真包（`LinkType` 为空、`index.js` 首行是包内注释），profile 的 `cordis.patch.yml` 里也没有旧路径。

**结论**：loader 把"这个包名解析到哪个真实路径"缓存在主进程内存里，键是包名。只有重启 DSH 能清。重启之后，再怎么做禁用/启用/卸载/重装都不需要重启。

这也是为什么开发期宁可一直用 link 安装，直到功能全验收完再打包——切换成本是"一次重启"。

### 6.1 一个真实事故：`remove_bundle` 清空了 link 安装的源目录

切换过程中，工作区的 `plugin/` 目录（当时是 link 安装的目标）在 `remove_bundle` 执行的同一秒被清空，9 个源文件全部消失（目录本身还在，`LastWriteTime` 与那次卸载完全吻合）。

**对照验证**：改成真包安装之后，同一个 `remove_bundle` 再跑一次，`plugin/` 的 10 个文件与 `dist/` 的 17 个文件都原封不动。所以这不是"卸载总会删源目录"，而是**卸载一个 link 安装时，会把链接目标里的内容当作自己的文件清掉**。

**没有丢代码**：`dist/dsh-plugin-agent-browser/` 里有一份逐字节相同的副本（CLIENT_REV 24 / HOST_REV 6），从它恢复即可；`plugin/test/static.test.mjs` 不在发布文件里，是按原语义重写的（14 例，见 §8）。

教训：

1. **打包目录是唯一可信来源**。`dist/` 里始终留着最新一份，开发目录再怎么折腾都能恢复。
2. 不要把 link 安装指向"唯一副本"的目录。要热改就用 `plugin/`，但请保证另有备份（本项目的备份就是 `dist/`）。
3. `tools/pack.mjs` 现在把这件事固化了：从 `plugin/` 复制 9 个源文件进 `dist/`，`npm pack`，打印体积与安装命令。

```powershell
node tools/pack.mjs
# copied 9 files from plugin/ into dist/
# dsh-plugin-agent-browser-1.0.3.tgz  47,430 bytes
```

开发循环因此变成：改 `plugin/...` → `node tools/pack.mjs` → `plugin_manager install_bundle <tgz>`。三步约 10 秒，不需要重启。**不要**再把 profile 切回 link 安装——那样会再需要一次重启才能回到真包。

还有一条配套的实测：`install_bundle` **升级版本时，如果 client 半的源码没变，client 半不会重新加载**（1.0.2 → 1.0.3 那次，日志里还是 `client half applied {"rev":24}`，包版本却已经是 1.0.3）。所以"确认新代码真的在跑"的唯一可靠办法是看 `/logs` 里的 `rev`，而不是看包版本。要让 client 半重载，就 bump `CLIENT_REV`，然后 `remove_bundle` + `install_bundle`（只 install 不行）。

（`pack.mjs` 自己踩到一个 Node 坑：Windows 上 `npm` 是 `.cmd` 垫片，`spawnSync` 不带 `shell: true` 会直接 `EINVAL`（CVE-2024-27980 之后的限制）。脚本里用 `spawnSync('npm pack --silent', { shell: true })`。）

## 7. 两个必须记住的 Windows 坑

1. **PowerShell 5.1 没有 `utf8NoBOM`**。`Set-Content -Encoding utf8NoBOM` 直接报枚举不匹配；`Set-Content -Encoding utf8` 会写 BOM，`dsh` 校验包时拒绝：
   `Cannot validate installed package dsh-plugin-agent-browser: SyntaxError: Unexpected token '﻿', "﻿{\n  "name"... is not valid JSON`
   改包内 JSON 一律用编辑工具；校验首字节应为 `123,10`（`{` 换行）。
2. **旧 node 进程不随 pwsh 作业结束而死**，重启夹具时会 `EADDRINUSE`。用 `Get-NetTCPConnection -LocalPort <port> -State Listen` 找 PID 再 `Stop-Process -Force`。

## 8. 体积参考

| 形态 | 大小 | 文件数 |
|---|---|---|
| `npm pack` 产物（tgz） | 47,430 B | 16 |
| 装进 profile 后（解包） | 155,5xx B | 16 |

远低于"总体积 < 3 MiB"的验收线，也没有 `node_modules` 与 sourcemap。

单测（不在发布文件里）：`node --test plugin/test/static.test.mjs` → 14 例全绿，覆盖 `..`/编码点/反斜杠/盘符/UNC/NUL/坏百分号、相对与绝对入参、URL 分段编码，以及一次真实起服务的集成测试（200 / HEAD 空体 / 404 `not found` / 403 不回显主机路径 / POST 405 / 同 root 复用端口）。

## 9. 已知缺口

- 没有在第二台机器上验证过（无第二台机器可用）。替代证据是"卸载后从 tgz 重装即恢复"，至少证明包自身自洽、不依赖开发期目录。
- tgz 没有签名，也没有发布到任何 registry；当前是 `file:` 依赖，换机器要带上 tgz 文件本身。
- `files` 是手工维护的，加文件时容易漏；漏了会在安装后表现为 404/ENOENT，而不是安装失败。
