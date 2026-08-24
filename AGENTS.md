# ACPlugin 项目规范

## 项目定位

ACPlugin 是基于 Rolldown 的统一 AI Plugin 框架和 CLI。作者通过规范化工程书写 Commands、Skills、Agents，以及可选 Hooks/MCP/Node Runtime；`init` 默认生成显式安装 Claude Code 与 Codex Platform 的工程，使用者也可安装 Cursor、Antigravity、OpenCode、Pi 或任意第三方 Platform。

- 公开包：`@tokenroll/acplugin`、六个 `@tokenroll/acplugin-platform-*`、`@tokenroll/acplugin-extension-hooks`、`@tokenroll/acplugin-extension-mcp`
- 私有包：Core、内部 Test、Docs、Playground workspace
- 不提供 Instructions Component
- 旧 Claude 工程/Plugin 的导入仅属于隔离的 Migration 子系统

## 技术与工具约束

- TypeScript 7、Node.js >=20、ESM-only；Package 的 `tsc` 来自 catalog 中的 `@typescript/native`
- pnpm workspace，不使用 npm/yarn，不引入 Turborepo
- tsdown 负责 package bundle 和声明文件
- Vitest 只用于仓库内部测试
- Commander.js + `@inquirer/prompts` 负责 CLI/TUI
- Core 基于 Rolldown 提供统一 Module/Build Service；Hooks、MCP、Node Runtime 与第三方集成都不得自建 Bundler
- VitePress 1.6 + TypeDoc 0.28 负责私有 Docs；TypeDoc 使用 TypeScript 6 Compiler API 兼容层

## Monorepo

```text
packages/
├── acplugin/               # 公开 CLI/facade，内含隔离 Migration
├── core/                   # 私有配置、Resource、Rolldown、Runtime、生命周期、Asset/Package、事务
├── platforms/              # 六个独立公开 Platform 实现包
│   ├── claude-code/
│   ├── codex/
│   ├── cursor/
│   ├── antigravity/
│   ├── opencode/
│   └── pi/
├── extensions/             # 两个正式公开横向 Extension 包
│   ├── hooks/
│   └── mcp/
├── test/                   # 私有跨包 Vitest 集成测试
├── docs/                   # 私有 VitePress/TypeDoc 文档工程
└── playground/             # 私有、领域中立的全能力消费模板
```

`@tokenroll/acplugin` 构建时必须 bundle Core，但不得 bundle 或重新导出官方 Platform/Extension。六个官方 Platform 与两个官方 Extension 都只能从主包公开 SDK 导入契约，并通过 `workspace:^` peer 开发边连接主包；pack 后必须变为正常 `^x.y.z`。任何公开 tarball 的运行时依赖都不得出现 `@acplugin/*`。

## 统一构建架构

```text
Config → fixed Core lifecycle → Resource discovery → Canonical Project
       → Platform base Package → unordered add-only Contributions
       → finalized Package candidates → compatibility → transaction → BuildReport
```

Core 固定生命周期为：

```text
config → setup Sessions → Resource/Extension discovery → Canonical Project
→ Component/Extension validation → Extension/Core Runtime compile
→ Platform.createPackage → Contributor collection → Core merge
→ Platform.finalizePackage → candidate materialize/validate
→ createDistributions/validate → compatibility propagation
→ managed transaction → reverse close
```

- Core 定义唯一阶段顺序、Context、诊断、兼容性、Asset 所有权和事务，不包含平台名称分支。
- Platform 负责一种目标平台的 Component 转换、结构化 Document、base Package、主 Package 身份、可选 Marketplace Distribution 和最终候选校验。
- Extension 负责横向作者能力；其 Built State 通过显式 `PlatformContributor` 对同一只读 base Package 返回无序 add-only `PackageContribution`。
- Contributor 只能读取 base Package、向声明的 extension point 新增字段、追加自有 Asset 和报告兼容性，不能替换 Platform、完整 Document 或已有字段。
- Platform/Extension 不获得物理 workDir 或 `dist` 写权限；Source、Module、Compiler、Execution 和 Asset Service 由 Core 按 owner 授权。
- Platform options 必须是深度冻结的 JSON；Extension 不提供依赖图和跨 Extension State 读取。
- Session `close` 在成功/失败时均按初始化逆序执行，收到的异常只能是脱敏摘要。
- CLI 与程序化 `runProject()` 必须只调用 Core 的唯一 Platform/Extension 生命周期，不得维护第二条构建路径。

## Canonical Components

- Command：`src/commands/<id>.md`
- Skill：`src/skills/<id>/SKILL.md`，同目录其他文件为辅助资源
- Agent：`src/agents/<id>.md`
- Public：默认 `public/`，支持 config copy 规则

所有 ID 使用小写 kebab-case。Markdown 必须有合法 YAML Frontmatter 和非空正文。依赖图必须拒绝缺失、自依赖、循环依赖。

兼容性必须显式：每个 Platform 都要逐资源报告 `native`、`transform`、`degraded` 或 `unsupported`。Claude 原生 Commands/Skills/Agents；Codex 原生 Skills、Commands 转 Skill、Agents 降级为 Skill；Cursor 原生三类 Component；Antigravity 以 Skill 转换 Command/Agent；OpenCode 生成 Workspace 原生资源；Pi 以 Prompt/Skill 转换 Command/Agent。严格模式不得静默接受 degraded/unsupported。

## Hooks/MCP Extension 与 Core Runtime

- 未启用对应 Extension 时发现 `src/hooks` 或 `src/mcp` 内容必须失败；`src/runtime` 由 Core 直接拥有。
- Hook 作者只返回语义结果，目标 stdin/stdout 协议由 Contributor 负责。
- Hook runner 必须限制输入/输出、捕获顶层错误、使用固定脱敏错误码。
- MCP 只支持 portable intersection：Streamable HTTP 与本地 stdio。
- HTTP 的 secret 使用 `{ env }` 引用，构建过程不得读取值。
- 本地 stdio MCP 必须是完整实现，并通过真实 `initialize`/`tools/list` smoke。
- bundle 包含第三方包时，必须生成相邻 `THIRD_PARTY_LICENSES.txt`。
- Node Runtime 默认把 `src/runtime/` 下受支持的一级 TS/JS 文件作为 executable 入口；嵌套文件只作为依赖。`runtime.entries` 完整替换自动发现，`runtime: false` 显式关闭。
- Core 在 Scanner 后使用 `portable-node` 对每个 Runtime 入口只构建一次，owner 固定为 `framework:node-runtime`，并仅向声明稳定 Plugin-local Node 20 ESM capability 的平台交付。
- Runtime 固定输出 `runtime/<id>/main.mjs` 与可选相邻许可证，不需要 descriptor、factory、Extension Contributor 或 Manifest patch。
- 第三方 Platform/Extension 可使用 Core `managed-rolldown`，但 `cwd`、input、日志、输出目录、watch 与 close 始终由 Core 接管；许可证默认 `strict`，显式 `ignore` 表示调用方自行承担法律材料交付责任。

## Asset 与事务

- Asset 只允许 Core 签发的 Source、Generated 或 Bytes 引用，mode 只允许 `0644/0755`。
- 输出路径拒绝绝对路径、NUL 和任何 `..` 片段，并拒绝符号链接、大小写及 Unicode 规范化冲突。
- Platform 只能引用 Core 授权的 Component/Skill 辅助 Source 和自身 owner-scoped Service 生成的 Asset；Extension 只能引用自身发现或生成的 Asset；Public 只能引用 Core 精确发现的文件。
- base/merged/primary Package 和 Distribution 必须保留继承 Asset 的 owner、mode、size 与 hash。
- `dist` 是框架完整托管目录；成功构建按选中目标集合整体替换。
- 事务顺序：锁 → 恢复 → stage → 校验 → transaction/backup → swap → cleanup。
- 任一目标/阶段失败必须保留上次完整输出；事务修改必须补 fault-injection 测试。
- 稳定报告和生成内容不得出现时间戳、绝对/临时路径、凭据或环境值。

## Migration 边界

Migration 位于 `packages/acplugin/src/migration/`，CLI 使用动态 import。`migration/legacy/` 只保留容错型 GitHub 下载与 Claude/plugin 扫描行为，为迁移读取服务；不得恢复旧 converter/writer/CLI/TUI。

- Core、Platform、Extension、正常 CLI 启动不得 import Migration。
- Migration 不允许原地写入，也不把 Instructions/raw Hooks/外部命令 MCP 伪装为规范化资源。
- 无法安全映射的内容进入 `.acplugin-migration/unmapped/` 和稳定 report。
- 不要为了 Core 的严格类型规则大范围机械重写容错型 legacy 代码。

## 测试

- Core 单元测试：`packages/core/test/`
- 跨包集成：`packages/test/test/`
- Migration 集成：`packages/test/test/migration.test.ts`
- 根 workspace 与各正式 Package 统一使用 catalog 中的 `@typescript/native` 执行 TypeScript 7 编译和类型检查；依赖旧 Compiler API 的 Lint/注释工具及 TypeDoc 使用 `@typescript/typescript6` 兼容别名。

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run docs:check
```

新增功能必须按风险补充：schema/graph、Platform golden、Extension/Contributor 生命周期、Runtime 单次构建与能力交付、Asset owner 隔离、事务故障、CLI 子进程/退出码、Watch 恢复、Hook Contributor、MCP 协议、Migration 和 tarball consumer 测试。不得用缺少 fixture 的大面积 skip 代替验证。

## 发行

- 九个公开包由 Changesets 独立版本化；兼容性由 lifecycle `apiVersion` 和主包 peer range 表达，不使用 fixed group。
- `Lint` 与 `Typecheck` Workflows 在 PR 创建、更新时独立执行；完整测试、Docs/Playground 和 tarball consumer 检查由开发者按改动风险运行。
- `Changelog` Workflow 在 `main` 收到合并后检查未消费 Changeset，并只创建或更新版本与 CHANGELOG PR；它不发布任何 package。
- `Release` Workflow 只能手工触发，只发布稳定 semver 版本到 npm `latest`；它不创建 Tag、GitHub Release 或独立 dist-tag 操作。
- beta 版本由维护者在本地使用 `pnpm run publish:beta` 发布；先使用 `pnpm run publish:beta:dry-run` 检查结果。
- 发布一律使用根命令的 `pnpm -r --filter '@tokenroll/*' publish --ignore-scripts`，让 pnpm 在已完成的根构建后打包公开 workspace、改写 `workspace:^` 并按依赖拓扑处理；不得恢复自定义 tarball 发布器或 Registry 轮询协议。
- 禁止 unpublish、创建 Tag、GitHub Release 或修改已有 dist-tag，除非用户明确要求执行对应操作。

## Git 与改动安全

- commit message 使用 Conventional Commits。
- 保留用户已有 staged/unstaged 修改，不使用 reset/checkout 覆盖。
- 根目录旧版本产物和平台生成副本不应重新加入；仓库代理能力只维护 `.agents/skills/`。
- `.llmdoc-tmp/` 是忽略的规划/调查缓存；稳定知识更新到 `llmdoc/`。
