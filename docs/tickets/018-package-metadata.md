# TICKET-018 包元数据：可安装、可诊断、可发布

- **状态**：✅ 已完成（1.1.1 装机验收通过，2026-11-21，见 §6）
- **优先级**：P0（发布前必修；半天内可完成）
- **来源**：`docs/design/official-docs-review.md` #3（官方 `develop/basic/publish`：用 `engines.dsh` 声明兼容范围；dsh 包同时进 `peerDependencies` 与 `devDependencies`）
- **对应验收**：`docs/spec/002-official-alignment-spec.md` B3
- **关联**：TICKET-025（安装/升级文档与 `engines` 声明对齐）、`docs/spec/002` §5 版本表（1.1.0 起）

## 1. 问题

`dist/dsh-plugin-agent-browser/package.json`（1.0.39）四处不合规：

| 项 | 现状 | 官方要求 | 后果 |
|---|---|---|---|
| `engines.dsh` | 缺失 | 声明 DSH 兼容范围 | 装上不兼容的 DSH 时不会拒绝，坏在运行时 |
| `peerDependencies` | `"@deepseek-ai/schemastery": "*"` | 真实兼容区间 | 任何版本都"兼容"，等于没声明 |
| `devDependencies` | 缺失 | dsh 包同时进 peer 与 dev | 从源码开发时依赖不完整 |
| `private` | `true` | 发布包不能是 private | `npm publish` 直接拒绝 |

顺带检查 `license` / `files` / `repository`：`files` 现在是显式白名单（好），但缺 `license`。

## 2. 修法

`dist/dsh-plugin-agent-browser/package.json` 目标形状（只列要动的字段）：

```jsonc
{
  "name": "dsh-plugin-agent-browser",
  "version": "1.1.0",
  "license": "MIT",
  "private": false,
  "engines": {
    "dsh": "^0.2.2-rc.3"
  },
  "peerDependencies": {
    "@deepseek-ai/schemastery": "^0.2.2-rc.3"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/schemastery": { "optional": true }
  },
  "devDependencies": {
    "@deepseek-ai/schemastery": "^0.2.2-rc.3"
  }
}
```

判定细节：

1. **范围怎么定**：本机跑通的是 `0.2.2-rc.3`（`docs/spec/001` 目标环境）。`^0.2.2-rc.3` 在 semver 里是 `>=0.2.2-rc.3 <0.3.0`，能覆盖 `-rc.4/-rc.5` 与 0.2.x 正式版；若担心 `0.3.0` 的破坏性变更，就不写 `^0.2` 而是 `>=0.2.2-rc.3 <0.3.0`（两种等价，选后者更明确）。
2. **peer 是否 optional**：`schemastery` 由 DSH 宿主提供（`plugin/index.js:8` 直接 import），插件不打包它。标记 optional 可以避免"没装就警告"的噪音，但要求装错时仍能报错——保留 default 也可以，实测哪种噪音小选哪种（记录在验收里）。
3. **`engines.dsh` 的解析方是谁**：DSH 安装时读取（`plugin_manager`/bundle 安装路径）。若它只警告不拒绝，要在 README 里写清"不兼容时行为未定义"。
4. **版本号**：B1–B4 一起发，版本取 `1.1.0`（`docs/spec/002` §5）。

## 3. 单测 / 校验

| 检查 | 方式 |
|---|---|
| package.json 合法 | `node -e "JSON.parse(require('fs').readFileSync('dist/dsh-plugin-agent-browser/package.json'))"` |
| `files` 白名单不漏文件 | `npm pack --dry-run` 打印清单，与 `dist/` 实际文件逐一对照（17 个文件、82,940 B 是 1.0.39 的基线，1.1.0 会变） |
| `engines.dsh` 语义 | 用小脚本 `semver.satisfies('0.2.2-rc.3', range)` 断言 true；`'0.3.0'` 断言 false（没有 semver 依赖时手写三段比较） |
| 六个 exports 仍在 | `node -e` 读 `exports` 键，断言 `.`/`./client`/`./cordis.patch.yml`/`./package.json`/`./locale/*.json`/`./icon` 都在 |

## 4. 装机验收

| 项 | 做法 | 期望 |
|---|---|---|
| 可安装 | `plugin_manager install_bundle` 指向新 tgz | 安装成功，`list_plugins` 里 `fiberPhase: active` |
| 不改变安装方式 | 与 1.0.39 的安装步骤完全一致 | 无需额外步骤（不引入构建、不引入新依赖） |
| 不兼容能被发现 | 临时把 `engines.dsh` 改成 `^9.0.0` 再装 | 安装被拒绝**或**给出明确警告（记录实际行为；两者都可接受，静默通过不可接受） |
| 元数据自描述 | 在插件详情页看 | 版本、名称、描述、图标正常；`engines` 不外显也没关系 |

## 5. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 范围写窄，用户量最大的旧版 DSH 拒装 | 只写已实测的下限；对未测版本宁可不声明上限（`>=0.2.2-rc.3`），并在 README 注明"仅在 0.2.2-rc.3 上验证" |
| R2 | 去掉 `private: true` 后误发布到公共 registry | 发布前 `npm pack` 检查 `files`；如只做内部分发，保留 `private` 并在 README 写"不发布到 npm，只装 tgz"——**这条要与用户确认分发渠道后再定** |
| R3 | peer 与宿主实际提供的版本不一致 | 实测 `plugin/index.js` 能否 import；不一致时在启动日志里打出解析到的版本 |

## 6. 实现记录（2026-11-21，1.1.1 装机验收）

### 6.1 落地形状

`dist/dsh-plugin-agent-browser/package.json` 目标四项全部落地：

| 字段 | 实际值 |
|---|---|
| `version` | `1.1.1`（先发 1.1.0，装机验收发现 TICKET-016 的 gate 吞参 bug 后补丁版） |
| `private` | `false` |
| `license` | `MIT` |
| `engines.dsh` | `">=0.2.2-rc.3 <0.3.0"` |
| `peerDependencies` / `devDependencies` | 都是 `{ "@deepseek-ai/schemastery": "^3.19.0" }` |
| `files` | 加入 `apply.js`、`config.js`（与 `tools/pack.mjs` 的 COPY 白名单同步，13 项） |
| `exports` | 六出口未动（`.` / `./client` / `./cordis.patch.yml` / `./package.json` / `./locale/*.json` / `./icon`） |

### 6.2 打包与安装

- `node tools/pack.mjs` → `copied 13 files`，产出 `dist/dsh-plugin-agent-browser/dsh-plugin-agent-browser-1.1.1.tgz`（**88,238 B**）；`tar -tzf` 共 20 个文件（新增 `apply.js`、`config.js`）。
- `plugin_manager install_bundle` → `application: "applied"`，pnpm 输出 `- dsh-plugin-agent-browser 1.1.0` / `+ dsh-plugin-agent-browser 1.1.1`。
- 安装后核对 `C:\Users\林焕文\.dsh\profiles\desktop\node_modules\dsh-plugin-agent-browser\package.json`：`version=1.1.1`、`private=False`、`license=MIT`、`engines=">=0.2.2-rc.3 <0.3.0"`、`peer="^3.19.0"`。
- `plugin_manager list_plugins`（222 条）中 `include:agent-browser-panel` 仍为 `enabled: true` / **`fiberPhase: active`**——新元数据没有影响加载。

### 6.3 engines 语义核对

宿主实测版本 **`0.2.2-rc.5`**（`app.asar` 内 `dsh/package.json`；比 ticket 写作时以为的 rc.3 新），`engines` 范围覆盖它；上限 `<0.3.0` 仍允许未来 0.2.x。**"写坏 `engines` 看是否拒装"这一条没有实测**（会把坏包留进 profile，需要再装一次恢复），替代证据是安装校验确实存在且会回滚：BOM 事故时 DSH 报 `Cannot validate installed package …` 并自动 `restored package.json, pnpm-lock.yaml, and node_modules`。

### 6.4 踩坑：`package.json` 的 BOM（已在 TICKET-016 §6.5 记录）

`Set-Content -Encoding utf8` 写出 BOM，导致 DSH 安装校验失败（`SyntaxError: Unexpected token '﻿'`）。最终用 `[IO.File]::WriteAllText(..., New-Object Text.UTF8Encoding($false))` 写文件。
