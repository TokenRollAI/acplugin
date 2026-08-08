# ACPlugin 项目规范

## 项目定位

ACPlugin 是统一的 AI Plugin 框架和 CLI。作者通过规范化工程书写 Commands、Skills、Agents，以及可选 Hooks/MCP；`init` 默认生成显式安装 Claude Code 与 Codex Platform 的工程，使用者也可安装 Cursor、Antigravity、OpenCode、Pi 或任意第三方 Platform。

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
- Rolldown 只用于 Hooks/MCP 本地可执行内容 bundle
- VitePress 1.6 + TypeDoc 0.28 负责私有 Docs；TypeDoc 使用 TypeScript 6 Compiler API 兼容层

## Monorepo

```text
packages/
├── acplugin/               # 公开 CLI/facade，内含隔离 Migration
├── core/                   # 私有配置、扫描、生命周期、Artifact、事务
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
└── playground/             # 私有 llmdoc v3 主题真实消费模板
```

`@tokenroll/acplugin` 构建时必须 bundle Core，但不得 bundle 或重新导出官方 Platform/Extension。六个官方 Platform 与 Hooks/MCP Extension 都只能从主包公开 SDK 导入契约，并通过 `workspace:^` peer 开发边连接主包；pack 后必须变为正常 `^x.y.z`。任何公开 tarball 的运行时依赖都不得出现 `@acplugin/*`。

## 统一构建架构

```text
Config → fixed Core lifecycle → Canonical Scanner → Platform Draft
       → Extension Adapter → DeliveryUnit validation → managed output transaction → report
```

Core 固定生命周期为：

```text
configResolved → buildStart → Extension.discover → Scanner
→ Extension.validate/build → Platform.prepare → Adapter.apply
→ Platform.generateBundle/validateBundle → generateDistributions
→ compatibility propagation → transaction → buildEnd
```

- Core 定义唯一阶段顺序、Context、诊断、兼容性、Artifact 所有权和事务，不包含平台名称分支。
- Platform 负责一种目标平台的 Component 转换、结构化 Document、主 DeliveryUnit、可选 Marketplace Distribution 和最终候选校验。
- Extension 负责横向作者能力；其 Built State 通过显式 `ExtensionPlatformAdapter` 以 add-only 方式参与对应 Platform Draft。
- Adapter 只能读取已公开 Document、向声明的 extension point 新增字段、追加 Artifact 和报告兼容性，不能替换 Platform 或完整文档。
- 每个 Platform/Extension 只能写 Core 提供的独占 workDir，不能直接写 `dist`，文件型 Artifact 也按 owner 独立授权。
- Platform options 必须是深度冻结的 JSON；Extension 不提供依赖图和跨 Extension State 读取。
- `buildEnd` 在成功/失败时均按初始化逆序执行，收到的异常只能是脱敏摘要。
- CLI 与程序化 `runProject()` 必须只调用 Core 的唯一 Platform/Extension 生命周期，不得维护第二条构建路径。

## Canonical Components

- Command：`src/commands/<id>.md`
- Skill：`src/skills/<id>/SKILL.md`，同目录其他文件为辅助资源
- Agent：`src/agents/<id>.md`
- Public：默认 `public/`，支持 config copy 规则

所有 ID 使用小写 kebab-case。Markdown 必须有合法 YAML Frontmatter 和非空正文。依赖图必须拒绝缺失、自依赖、循环依赖。

兼容性必须显式：每个 Platform 都要逐资源报告 `native`、`transform`、`degraded` 或 `unsupported`。Claude 原生 Commands/Skills/Agents；Codex 原生 Skills、Commands 转 Skill、Agents 降级为 Skill；Cursor 原生三类 Component；Antigravity 以 Skill 转换 Command/Agent；OpenCode 生成 Workspace 原生资源；Pi 以 Prompt/Skill 转换 Command/Agent。严格模式不得静默接受 degraded/unsupported。

## Hooks/MCP Extension

- 未启用对应 Extension 时发现 `src/hooks` 或 `src/mcp` 内容必须失败。
- Hook 作者只返回语义结果，目标 stdin/stdout 协议由 adapter 负责。
- Hook runner 必须限制输入/输出、捕获顶层错误、使用固定脱敏错误码。
- MCP 只支持 portable intersection：Streamable HTTP 与本地 stdio。
- HTTP 的 secret 使用 `{ env }` 引用，构建过程不得读取值。
- 本地 stdio MCP 必须是完整实现，并通过真实 `initialize`/`tools/list` smoke。
- bundle 包含第三方包时，必须生成相邻 `THIRD_PARTY_LICENSES.txt`。

## Artifact 与事务

- Artifact 只允许 `bytes` 或已验证的普通文件来源，mode 只允许 `0644/0755`。
- 输出路径拒绝绝对路径、NUL 和任何 `..` 片段，并拒绝符号链接、大小写及 Unicode 规范化冲突。
- Platform 只能引用自己的 workDir 和 Scanner 精确发现的 Component/Skill 辅助文件；Extension 只能引用自己的 workDir；Public 只能引用 Scanner 精确发现的文件。
- Platform Draft、主 DeliveryUnit 和 Distribution 必须保留继承 Artifact 的 owner、mode、size 与 hash。
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
pnpm run release:verify
```

新增功能必须按风险补充：schema/graph、Platform golden、Extension/Adapter 生命周期、Artifact owner 隔离、事务故障、CLI 子进程/退出码、Watch 恢复、Hook adapter、MCP 协议、Migration 和 tarball consumer 测试。不得用缺少 fixture 的大面积 skip 代替验证。

## 发行

- 九个公开包由 Changesets 独立版本化；兼容性由 lifecycle `apiVersion` 和主包 peer range 表达，不使用 fixed group。
- `Check` Workflow 在 PR 上自动执行 lint/typecheck，并通过独立 Job 执行 `docs:check`。
- `Patch` Workflow 只能手工触发；从默认分支选择目标分支，在写版本前确认至少一个有效 Changeset 会升级公开包，再消费 Changesets、生成 changelog、升级各自声明的公开包版本，并创建回到该目标分支的版本 PR。
- 所有版本均由维护者从已验证 tarball 手工发布；仓库不得添加 Tag/npm 自动发布 Workflow。
- 每个变更的公开包都要验证 Registry 精确版本；依赖新的主包 peer range 时先发布主包，再发布对应 Platform/Extension。
- 对应 npm 版本存在后，再由维护者手工创建该版本的 Tag 和 GitHub Release。
- 禁止自动 publish/unpublish、修改 dist-tag、创建 Tag 或 GitHub Release，除非用户明确要求执行对应操作。

## Git 与改动安全

- commit message 使用 Conventional Commits。
- 保留用户已有 staged/unstaged 修改，不使用 reset/checkout 覆盖。
- 根目录旧版本产物和平台生成副本不应重新加入；仓库代理能力只维护 `.agents/skills/`。
- `.llmdoc-tmp/` 是忽略的规划/调查缓存；稳定知识更新到 `llmdoc/`。
