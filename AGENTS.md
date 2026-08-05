# acplugin 项目规范

## 项目定位

acplugin 是统一的 AI Plugin 框架和 CLI。作者通过规范化工程书写 Commands、Skills、Agents，以及可选 Hooks/MCP；框架默认编译为可安装的 Claude Code 和 Codex Plugin。

- 公开包：`@tokenroll/acplugin`、`@tokenroll/acplugin-module-hooks`、`@tokenroll/acplugin-module-mcp`
- 私有包：Core、两个内置 Compiler、内部 Test workspace
- 不提供 Instructions Component
- 旧 Claude 工程/Plugin 的导入仅属于隔离的 Migration 子系统

## 技术与工具约束

- TypeScript、Node.js >=20、ESM-only
- pnpm workspace，不使用 npm/yarn，不引入 Turborepo
- tsdown 负责 package bundle 和声明文件
- Vitest 只用于仓库内部测试
- Commander.js + `@inquirer/prompts` 负责 CLI/TUI
- Rolldown 只用于 Hooks/MCP 本地可执行内容 bundle

## Monorepo

```text
packages/
├── acplugin/               # 公开 CLI/facade，内含隔离 Migration
├── core/                   # 私有配置、扫描、生命周期、Artifact、事务
├── compiler-claude-code/   # 私有 Claude Code Compiler
├── compiler-codex/         # 私有 Codex Compiler
├── module-hooks/           # 公开可选 Hooks Module
├── module-mcp/             # 公开可选 MCP Module
└── test/                   # 私有跨包 Vitest 集成测试
```

`@tokenroll/acplugin` 构建时必须 bundle Core 和两个私有 Compiler。任何公开 tarball 的运行时依赖都不得出现 `@acplugin/*`。Hooks/MCP 通过 `workspace:^` peer 开发边，在 pack 后必须变为正常 `^x.y.z`。

## 统一构建架构

```text
Config → Module lifecycle → Canonical Scanner → Compiler → Artifact graph
       → full target validation → managed output transaction → report
```

Module 生命周期固定为：

```text
configResolved → discover → validate → build → generate(target) → buildEnd
```

- Module 按 `dependsOn` 拓扑排序，同级保持 config 顺序。
- State/Built State 只能向已声明依赖暴露。
- Module 只能写 Core 提供的 workDir，不能写 `dist`。
- Module 返回 Artifact、唯一归属的 Manifest 字段和 Compatibility，不得替换完整 Compiler。
- `buildEnd` 在成功/失败时均按初始化逆序执行。
- Converter/Compiler 的纯生成逻辑不得直接产生文件系统副作用。

## Canonical Components

- Command：`src/commands/<id>.md`
- Skill：`src/skills/<id>/SKILL.md`，同目录其他文件为辅助资源
- Agent：`src/agents/<id>.md`
- Public：默认 `public/`，支持 config copy 规则

所有 ID 使用小写 kebab-case。Markdown 必须有合法 YAML Frontmatter 和非空正文。依赖图必须拒绝缺失、自依赖、循环依赖。

兼容性必须显式：Claude 原生 Commands/Skills/Agents；Codex 原生 Skills、Commands 转显式 `command-<id>` Skill、Agents 降级为 `agent-<id>` fallback Skill。严格模式不得静默接受 degraded/unsupported。

## Hooks/MCP Module

- 未启用 Module 时发现 `src/hooks` 或 `src/mcp` 内容必须失败。
- Hook 作者只返回语义结果，目标 stdin/stdout 协议由 adapter 负责。
- Hook runner 必须限制输入/输出、捕获顶层错误、使用固定脱敏错误码。
- MCP 只支持 portable intersection：Streamable HTTP 与本地 stdio。
- HTTP 的 secret 使用 `{ env }` 引用，构建过程不得读取值。
- 本地 stdio MCP 必须是完整实现，并通过真实 `initialize`/`tools/list` smoke。
- bundle 包含第三方包时，必须生成相邻 `THIRD_PARTY_LICENSES.txt`。

## Artifact 与事务

- Artifact 只允许 `bytes` 或已验证的普通文件来源，mode 只允许 `0644/0755`。
- 拒绝绝对/穿越路径、符号链接、大小写及 Unicode 规范化冲突。
- `dist` 是框架完整托管目录；成功构建按选中目标集合整体替换。
- 事务顺序：锁 → 恢复 → stage → 校验 → transaction/backup → swap → cleanup。
- 任一目标/阶段失败必须保留上次完整输出；事务修改必须补 fault-injection 测试。
- 稳定报告和生成内容不得出现时间戳、绝对/临时路径、凭据或环境值。

## Migration 边界

Migration 位于 `packages/acplugin/src/migration/`，CLI 使用动态 import。`migration/legacy/` 只保留容错型 GitHub 下载与 Claude/plugin 扫描行为，为迁移读取服务；不得恢复旧 converter/writer/CLI/TUI。

- Core、Compiler、Modules、正常 CLI 启动不得 import Migration。
- Migration 不允许原地写入，也不把 Instructions/raw Hooks/外部命令 MCP 伪装为规范化资源。
- 无法安全映射的内容进入 `.acplugin-migration/unmapped/` 和稳定 report。
- 不要为了 Core 的严格类型规则大范围机械重写容错型 legacy 代码。

## 测试

- Core 单元测试：`packages/core/test/`
- 跨包集成：`packages/test/test/`
- Migration 集成：`packages/test/test/migration.test.ts`

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run release:verify
```

新增功能必须按风险补充：schema/graph、Compiler golden、Module 生命周期、事务故障、CLI 子进程/退出码、Watch 恢复、Hook adapter、MCP 协议、Migration 和 tarball consumer 测试。不得用缺少 fixture 的大面积 skip 代替验证。

## 发行

- 三个公开包统一版本，由 Changesets fixed group 管理。
- tag 格式为 `tokenroll-vX.Y.Z`。
- 首次 npm identity 需要手工 2FA bootstrap；不得由实现/测试自动发布。
- 后续 workflow 使用受保护 `npm` environment 和 OIDC/provenance，无长期 npm token。
- 发布顺序：Hooks Module → MCP Module → 主包；精确版本存在时跳过并验证。
- GitHub Release 只能在三个 Registry 精确版本均验证后创建。
- 禁止自动 unpublish、修改 dist-tag 或创建 tag，除非用户明确要求实际发布。

## Git 与改动安全

- commit message 使用 Conventional Commits。
- 保留用户已有 staged/unstaged 修改，不使用 reset/checkout 覆盖。
- 根目录旧版本产物和平台生成副本不应重新加入；仓库代理能力只维护 `.agents/skills/`。
- `.llmdoc-tmp/` 是忽略的规划/调查缓存；稳定知识更新到 `llmdoc/`。
