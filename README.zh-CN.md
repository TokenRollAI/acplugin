# acplugin

[English](./README.md)

acplugin 是一个统一的 AI Plugin 框架和 CLI。开发者只维护一套 Commands、Skills、Agents，以及可选的 Hooks/MCP 源码，acplugin 将其构建为可安装的 Claude Code 和 Codex Plugin。

它不再以 Claude 工程为默认输入进行“格式转换”。规范化工程才是唯一事实来源，每个目标 Compiler 负责最终 Manifest、路径、兼容性判断和确定性序列化。旧 Claude 工程/Plugin 的导入由隔离的 `acplugin migrate` 负责。

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

默认同时生成 `dist/claude-code` 和 `dist/codex`。

`acplugin.config.ts`、Hook descriptor 和 MCP descriptor 是由本地 Node.js 进程加载的可信工程代码，应按构建脚本同等标准审查。Migration 输入始终作为不可信数据处理，不会被当作规范 descriptor 执行。

## 工程目录

```text
my-plugin/
├── acplugin.config.ts
├── package.json
├── public/                         # 可选，复制到每个目标根目录
└── src/
    ├── commands/
    │   └── review.md
    ├── skills/
    │   └── review/
    │       ├── SKILL.md
    │       └── references/
    ├── agents/
    │   └── reviewer.md
    ├── hooks/                      # 仅启用 Hooks Module 后使用
    │   └── policy/hook.ts
    └── mcp/                        # 仅启用 MCP Module 后使用
        └── docs/mcp.ts
```

ID 和目录名使用小写 kebab-case。Markdown Component 必须包含 YAML Frontmatter 和非空正文。符号链接、逃逸工程根目录的路径会被拒绝。

acplugin 不提供 Instructions Component。仓库级 Instructions 属于宿主/工程配置，而不是可安装 Plugin 的能力边界。

## 配置

`acplugin.config.ts` 可以导出对象，也可以导出接收 `{ command, mode }` 的同步/异步函数。

```ts
import { defineConfig } from '@tokenroll/acplugin';

export default defineConfig(({ mode }) => ({
  name: 'team-review',
  version: '1.0.0',
  description: '团队代码审查工作流。',
  displayName: 'Team Review',
  targets: [
    'claude-code',
    { id: 'codex', strict: mode === 'production' },
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
| `targets` | 目标集合，默认 Claude Code + Codex。 |
| `modules` | Hooks/MCP 等生命周期 Module。 |
| `build.outDir` | 托管输出目录，默认 `dist`。 |
| `build.strict` | 遇到 degraded/unsupported 是否失败，默认 `true`。 |
| `extensions` | 明确的目标平台逃生口。 |

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

| Component | Claude Code | Codex |
| --- | --- | --- |
| Skill | 原生 | 原生 |
| Command | 原生 Command | 显式调用的 `command-<id>` Skill |
| Agent | 原生 Agent | 降级为仅模型可调用的 `agent-<id>` fallback Skill |

Codex 可安装 Plugin 不能注册自定义的工程/用户 Agent。因此包含 Agent 时，严格 Codex 构建会失败；使用 `--no-strict` 才会生成 fallback，并明确报告模型、能力约束和注册语义丢失。

## Hooks Module

```bash
pnpm add -D @tokenroll/acplugin-module-hooks
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import hooks from '@tokenroll/acplugin-module-hooks';

export default defineConfig({
  name: 'policy-plugin',
  version: '1.0.0',
  description: '可移植策略 Hooks。',
  modules: [hooks()],
});
```

```ts
// src/hooks/policy/hook.ts
import { defineHook } from '@tokenroll/acplugin-module-hooks';

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

20 个 Claude-only 事件会为 Claude 构建，并在 Codex 目标报告 unsupported：

```text
Setup, UserPromptExpansion, PermissionDenied, PostToolUseFailure, PostToolBatch,
Notification, MessageDisplay, TaskCreated, TaskCompleted, StopFailure,
TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded,
FileChanged, WorktreeCreate, WorktreeRemove, Elicitation, ElicitationResult
```

acplugin 负责 bundle、输入规范化、语义结果校验、有界 JSON I/O、错误脱敏和第三方许可证产物。目标协议以最新的 [Claude Code Hooks](https://code.claude.com/docs/en/hooks) 与 [Codex Hooks](https://learn.chatgpt.com/docs/hooks) 为准。

## MCP Module

```bash
pnpm add -D @tokenroll/acplugin-module-mcp
```

远程 Streamable HTTP：

```ts
// src/mcp/docs/mcp.ts
import { defineMcpServer } from '@tokenroll/acplugin-module-mcp';

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
import { defineMcpServer } from '@tokenroll/acplugin-module-mcp';

export default defineMcpServer({
  transport: 'stdio',
  entry: 'server.ts',
  env: { API_TOKEN: { env: 'LOCAL_API_TOKEN' } },
});
```

本地 MCP 需要由作者提供完整的 stdio MCP 实现，acplugin 将其 bundle 为 Node 20 ESM。HTTP MCP 只需要声明远程 endpoint、认证和 Header 引用。构建期间不会读取环境变量的秘密值。生产 HTTP 必须使用 HTTPS，开发模式仅允许 loopback HTTP。

参考 [Claude Code MCP](https://code.claude.com/docs/en/mcp) 和 [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp)。

## Module 生命周期

```text
configResolved → discover → validate → build → generate(target) → buildEnd
```

Module 可声明 `dependsOn`，只能使用 Core 提供的工作目录，输出 Artifact、归属明确的 Manifest 字段和兼容性结果。Module 不能替换 Compiler，也不能直接写 `dist`。`buildEnd` 始终按初始化逆序执行。

## CLI

```text
acplugin init [directory]
acplugin dev
acplugin validate
acplugin inspect
acplugin build
acplugin migrate <source> [destination]
```

通用参数包括 `--config`、`--target`、`--mode`、`--no-strict` 和 `--json`。

- `validate`：完整生成并验证目标，但不写 `dist`。
- `inspect`：额外返回 Artifact 详情，但不写 `dist`。
- `build`：所有目标成功后才原子替换完整 `dist`。
- `dev`：监听工程输入；失败时保留上次成功产物，修复后恢复构建。
- 裸 `acplugin` 只打印 Help，不发起交互。

退出码：`0` 成功、`1` 工程/构建/Migration 失败、`2` CLI 用法或框架内部失败、`130` 取消。非 watch 命令的 JSON 模式只向 stdout 输出一个带版本的文档。

## 确定性与安全

- Artifact 只允许普通文件，带 owner、mode、size 和 SHA-256。
- 拒绝绝对/穿越路径、符号链接、大小写/Unicode 冲突和未授权来源。
- 构建使用同文件系统 stage、锁、事务记录、备份和完整目录 swap。
- 任意目标失败都会保留上次完整 `dist`。
- 生成内容/报告不包含时间戳、临时路径、环境变量值或凭据。
- 未启用对应 Module 时，`src/hooks`/`src/mcp` 中存在内容会直接报错。

## 旧版本 Migration

Migration 只属于 CLI，采用动态加载，并与 Core/Compiler/正常启动路径隔离。

```bash
acplugin migrate ./legacy-project ./new-plugin \
  --name new-plugin \
  --description "迁移后的 Plugin"

acplugin migrate owner/repository ./new-workspace --all
```

支持本地 Claude 工程、单 Plugin、Marketplace 和 GitHub 来源。Skills、Commands、Agents 和可移植远程 HTTP MCP 会尽量映射；Instructions、原始 Hooks、Hook 实现文件、本地外部命令 MCP 和不支持的资源保存在 `.acplugin-migration/unmapped/`，同时生成稳定报告和人工处理项。Migration 不允许原地写入。

`--dry-run` 不写目标目录；`--strict` 在出现 degraded/unmapped 时失败。

## 包与仓库开发

公开包：

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-module-hooks`
- `@tokenroll/acplugin-module-mcp`

Core、Claude/Codex Compiler 和 Vitest Test workspace 均为私有实现包，不会成为公开运行时依赖。

```bash
pnpm install
pnpm run check
pnpm run release:verify
```

`release:verify` 会创建三个 pnpm tarball、检查 Manifest/文件列表、安装到 monorepo 外的干净消费者、执行配置类型检查、API import 和双目标构建，不会发布 npm。

PR 会自动执行 lint 和 typecheck。手工触发的 `Patch` Workflow 接收一个至少包含一份 Changeset 的目标分支，消费 Changesets 以升级版本并生成 changelog，随后创建一个合并回该目标分支的版本 PR。

所有 npm 版本都从已验证 tarball 手工发布，顺序为 Hooks → MCP → 主包。逐一验证 Registry 精确版本后，再由维护者手工创建对应的 `tokenroll-vX.Y.Z` Tag 和 GitHub Release；仓库不包含自动发布 Workflow。

## License

MIT
