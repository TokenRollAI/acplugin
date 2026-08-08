# acplugin

[English](./README.md)

acplugin 是一个统一的 AI Plugin 框架和 CLI。开发者只维护一套 Commands、Skills、Agents，以及可选的 Hooks/MCP 源码，acplugin 将其构建为 Claude Code、Codex、Cursor、Antigravity、OpenCode 和 Pi 各自拥有的交付产物。

它不再以 Claude 工程为默认输入进行“格式转换”。规范化工程才是唯一事实来源，每个 Platform 负责最终 Manifest、路径、兼容性判断和确定性序列化。旧 Claude 工程/Plugin 的导入由隔离的 `acplugin migrate` 负责。

## 环境要求

- Node.js 20 或更高版本
- 生成工程和本仓库统一使用 pnpm

## 快速开始

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes
cd my-plugin
pnpm install
pnpm build
```

也可以在空工程中安装：

```bash
pnpm add -D @tokenroll/acplugin
```

```ts
// acplugin.config.ts
import { defineConfig } from '@tokenroll/acplugin';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: '可复用的 AI 工作流。',
});
```

默认同时生成 `dist/claude-code` 和 `dist/codex`。Cursor、Antigravity、OpenCode 和 Pi 需要显式启用，因为它们的兼容性和交付形态不同。

`acplugin.config.ts`、Hook descriptor 和 MCP descriptor 是由本地 Node.js 进程加载的可信工程代码，应按构建脚本同等标准审查。Migration 输入始终作为不可信数据处理，不会被当作规范 descriptor 执行。

## 工程目录

```text
my-plugin/
├── acplugin.config.ts
├── package.json
├── public/                         # 可选，复制到每个 Platform 根目录
└── src/
    ├── commands/
    │   └── review.md
    ├── skills/
    │   └── review/
    │       ├── SKILL.md
    │       └── references/
    ├── agents/
    │   └── reviewer.md
    ├── hooks/                      # 仅启用 Hooks Extension 后使用
    │   └── policy/hook.ts
    └── mcp/                        # 仅启用 MCP Extension 后使用
        └── docs/mcp.ts
```

ID 和目录名使用小写 kebab-case。Markdown Component 必须包含 YAML Frontmatter 和非空正文。符号链接、逃逸工程根目录的路径会被拒绝。

acplugin 不提供 Instructions Component。仓库级 Instructions 属于宿主/工程配置，而不是可安装 Plugin 的能力边界。

## 配置

`acplugin.config.ts` 可以导出对象，也可以导出接收 `{ command, mode }` 的同步/异步函数。

```ts
import { claudeCode, codex, defineConfig } from '@tokenroll/acplugin';

export default defineConfig(({ mode }) => ({
  name: 'team-review',
  version: '1.0.0',
  description: '团队代码审查工作流。',
  displayName: 'Team Review',
  platforms: [
    claudeCode(),
    codex({ strict: mode === 'production' }),
  ],
  public: {
    dir: 'public',
    copy: [
      { from: 'assets', to: 'assets' },
      { from: 'NOTICE.md', to: 'NOTICE.md' },
    ],
  },
  build: {
    outDir: 'dist',
    strict: true,
  },
}));
```

| 字段 | 含义 |
| --- | --- |
| `name/version/description` | 必填 Plugin 身份。 |
| `displayName` | 可选展示名称。 |
| `srcDir` | 规范化源码目录，默认 `src`。 |
| `public` | `false`、目录，或明确 copy 规则。 |
| `platforms` | Platform 工厂列表，默认 Claude Code + Codex。 |
| `extensions` | Hooks/MCP 等可选横向能力。 |
| `build.outDir` | 托管输出目录，默认 `dist`。 |
| `build.strict` | 遇到 degraded/unsupported 是否失败，默认 `true`。 |

主包导出全部内置 Platform 工厂：

```ts
import { antigravity, claudeCode, codex, cursor, openCode, pi } from '@tokenroll/acplugin';

const platforms = [claudeCode(), codex(), cursor(), antigravity(), openCode(), pi()];
```

Claude Code、Codex、Cursor 和 Antigravity 生成静态 Plugin 交付单元；OpenCode 生成 Workspace Overlay；Pi 生成 npm Package。`acplugin init --platform <id...>` 会显式写入所选工厂。

## 核心 Components

### Skill

```md
---
description: 审查代码的正确性和可维护性。
invocation:
  user: true
  model: true
requires:
  agents: [reviewer]
---
审查选定的改动并报告可执行的问题。
```

文件位置为 `src/skills/review/SKILL.md`。同目录下其他普通文件会作为 Skill 辅助资源复制。

### Command

```md
---
description: 审查指定改动。
argumentHint: <commit-or-branch>
requires:
  skills: [review]
---
使用 review Skill 审查 {{arguments}}。
```

文件位置为 `src/commands/review.md`。

### Agent

```md
---
description: 专注的只读代码审查者。
model: capable
capabilities: [filesystem:read, search]
---
检查改动和证据，只报告可执行的问题。
```

文件位置为 `src/agents/reviewer.md`。模型分级为 `inherit/fast/capable`；Capabilities 是语义声明，而不是目标平台工具名。

Components 可以依赖 Skills 和 Agents。缺失依赖、自依赖和循环依赖都会导致构建失败。

## 平台兼容性

| Component | Claude Code | Codex | Cursor | Antigravity | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- | --- |
| Skill | 原生 | 原生 | 原生 | 原生 | 原生 | 原生 |
| Command | 原生 | 转换为 Skill | 原生 | 转换为 Skill | 原生 | 转换为 Prompt |
| Agent | 原生 | 降级 Skill | 原生但有字段级限制 | 降级 Skill | 原生并转换能力字段 | 降级 Skill |

Codex 可安装 Plugin 不能注册自定义的工程/用户 Agent。因此包含 Agent 时，严格 Codex 构建会失败；使用 `--no-strict` 才会生成 fallback，并明确报告模型、能力约束和注册语义丢失。

交付单元、全部可移植 Hook 事件和 MCP 传输支持请查看[完整兼容矩阵](./llmdoc/reference/conversion-matrix.zh-CN.md)。

## Hooks Extension

```bash
pnpm add -D @tokenroll/acplugin-extension-hooks
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-extension-hooks';

export default defineConfig({
  name: 'policy-plugin',
  version: '1.0.0',
  description: '可移植策略 Hooks。',
  extensions: [hooks()],
});
```

```ts
// src/hooks/policy/hook.ts
import { defineHook } from '@tokenroll/acplugin-extension-hooks';

export default defineHook({
  event: 'PreToolUse',
  matcher: 'Bash',
  timeout: 5,
  async run(input) {
    return input.cwd
      ? { decision: 'allow' }
      : { decision: 'deny', reason: '缺少工作目录。' };
  },
});
```

11 个可移植事件：

```text
SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest,
PostToolUse, PreCompact, PostCompact, SubagentStart, SubagentStop, Stop
```

20 个 Claude Code-only 事件保持显式平台限定，不影响 Codex 兼容性：

```text
Setup, UserPromptExpansion, PermissionDenied, PostToolUseFailure, PostToolBatch,
Notification, MessageDisplay, TaskCreated, TaskCompleted, StopFailure,
TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded,
FileChanged, WorktreeCreate, WorktreeRemove, Elicitation, ElicitationResult
```

使用 `event: { platform: 'claude-code', name: 'Setup' }` 声明；裸字符串 `'Setup'` 会被拒绝。

acplugin 把每个实现只 bundle 一次，生成平台中立的 Node 20 ESM Handler；每个 Platform Adapter 贡献经过验证的静态或运行时集成，以及相邻的 `wire.mjs`，负责原生输入校验、递归 camelCase 转换和输出映射。共享 Handler 负责有界 JSON I/O、语义结果校验、安全错误和确定性的第三方许可证产物。宿主忽略的 meaningful matcher 会按具体 Hook 报告 `degraded`；不支持的事件不会生成伪运行时。

## MCP Extension

```bash
pnpm add -D @tokenroll/acplugin-extension-mcp
```

远程 Streamable HTTP：

```ts
// src/mcp/docs/mcp.ts
import { defineMcpServer } from '@tokenroll/acplugin-extension-mcp';

export default defineMcpServer({
  transport: 'http',
  url: 'https://example.com/mcp',
  auth: { type: 'bearer', env: 'DOCS_TOKEN' },
  headers: { 'X-Tenant': { env: 'TENANT_ID' } },
});
```

本地 stdio：

```ts
// src/mcp/local-tools/mcp.ts
import { defineMcpServer } from '@tokenroll/acplugin-extension-mcp';

export default defineMcpServer({
  transport: 'stdio',
  entry: 'server.ts',
  env: { API_TOKEN: { env: 'LOCAL_API_TOKEN' } },
});
```

本地 MCP 需要由作者提供完整的 stdio MCP 实现，acplugin 将其 bundle 为 Node 20 ESM。构建会拒绝无法静态解析的运行时 dynamic import，只把声明的公开字面量环境值传给探测进程，并要求在超时和输出上限内完成 `initialize → initialized → tools/list` 协议 smoke；任何 Secret 引用值都不会被读取。HTTP MCP 只需要声明远程 endpoint、认证和 Header 引用。生产 HTTP 必须使用 HTTPS，开发模式仅允许 loopback HTTP。

Claude Code、Codex 和 OpenCode 同时支持远程 HTTP 与 Bundle 后的本地 stdio；Cursor 与 Antigravity 只支持远程 HTTP；Pi 会报告 MCP 不支持。详见[完整兼容矩阵](./llmdoc/reference/conversion-matrix.zh-CN.md)。

## Extension 生命周期

```text
configResolved → buildStart → discover → validate → build → Platform prepare → Adapter → Platform generate/validate → buildEnd
```

Extension 只能使用 Core 提供的工作目录；build 应通过 `context.addWatchFile()` 登记实际读取的全部源码/依赖，使 `dev` 跟随完整模块图。其 Platform Adapter 可以提交 Artifact、在声明的 Document extension point 增加字段并报告兼容性；不能替换 Platform 流程，也不能直接写 `dist`。`buildEnd` 始终按初始化逆序执行。

## CLI

```text
acplugin init [directory]
acplugin dev
acplugin validate
acplugin inspect
acplugin build
acplugin migrate <source> [destination]
```

通用参数包括 `--config`、`--platform`、`--mode`、`--no-strict` 和 `--json`。

- `validate`：完整生成并验证 Platform，但不写 `dist`。
- `inspect`：额外返回 Artifact 详情，但不写 `dist`。
- `build`：所有 Platform 成功后才原子替换完整 `dist`。
- `dev`：监听配置、Components、Public、descriptor 和 Extension 登记的 Bundle 依赖；每批新 watcher ready 后先补偿构建，失败时保留上次成功产物，修复后恢复构建。
- 裸 `acplugin` 只打印 Help，不发起交互。

退出码：`0` 成功、`1` 工程/构建/Migration 失败、`2` CLI 用法或框架内部失败、`130` 取消。非 watch 命令的 JSON 模式只向 stdout 输出一个带版本的文档。

## 确定性与安全

- Artifact 只允许普通文件，带 owner、mode、size 和 SHA-256。
- 拒绝绝对/穿越路径、符号链接、大小写/Unicode 冲突和未授权来源。
- 构建使用同文件系统 stage、锁、事务记录、备份和完整目录 swap。
- 任意 Platform 失败都会保留上次完整 `dist`。
- 生成内容/报告不包含时间戳、临时路径、环境变量值或凭据。
- 未启用对应 Extension 时，`src/hooks`/`src/mcp` 中存在内容会直接报错。

## 旧版本 Migration

Migration 只属于 CLI，采用动态加载，并与 Core/Platform/正常启动路径隔离。

```bash
acplugin migrate ./legacy-project ./new-plugin \
  --name new-plugin \
  --description "迁移后的 Plugin"

acplugin migrate owner/repository ./new-workspace --all
```

支持本地 Claude 工程、单 Plugin、Marketplace 和 GitHub 来源。`--plugin <name>` 会把一个规范工程直接写到目标根；只有 `--all` 才创建由独立工程组成的 pnpm workspace。Skills、Commands、Agents 和可移植远程 HTTP MCP 会尽量映射；Instructions、原始 Hooks、Hook 实现文件、本地外部命令 MCP 和不支持的资源保存在 `.acplugin-migration/unmapped/`，同时生成稳定报告和人工处理项。每个生成工程都会在原子提交前通过公开 API 重新加载，并执行真实 Extension/Platform 验证。Migration 不允许原地写入。

`--dry-run` 不写目标目录；`--strict` 在出现 degraded/unmapped 时失败。

## 包与仓库开发

公开包：

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-extension-hooks`
- `@tokenroll/acplugin-extension-mcp`

Core、内置 Platform 实现和 Vitest Test workspace 均为私有包，会被内联或排除在公开运行时依赖之外。

```bash
pnpm install
pnpm run check
pnpm run release:verify
```

`release:verify` 会创建三个 pnpm tarball、检查 Manifest/文件列表和类型解析、安装到 monorepo 外的干净消费者、构建默认工程，并生成和构建六 Platform/两 Extension 脚手架；不会发布 npm。

PR 会自动执行 lint 和 typecheck。手工触发的 `Patch` Workflow 接收一个至少包含一份会升级公开包的有效 Changeset 的目标分支，消费 Changesets 以升级版本并生成 changelog，随后创建一个合并回该目标分支的版本 PR。

所有 npm 版本都从已验证 tarball 手工发布，顺序为 Hooks → MCP → 主包。逐一验证 Registry 精确版本后，再由维护者手工创建对应的 `tokenroll-vX.Y.Z` Tag 和 GitHub Release；仓库不包含自动发布 Workflow。

## License

MIT
