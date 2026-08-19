# ACPlugin

[English](./README.md)

ACPlugin 是一个基于 Rolldown 的统一 AI Plugin 框架和 CLI。开发者只维护一套 Commands、Skills、Agents，以及可选的 Hooks、MCP、Node Runtime 源码，ACPlugin 将其构建为 Claude Code、Codex、Cursor、Antigravity、OpenCode 和 Pi 各自拥有的交付产物。

它不再以 Claude 工程为默认输入进行“格式转换”。规范化工程才是唯一事实来源，每个 Platform 负责最终 Manifest、路径、兼容性判断和确定性序列化。旧 Claude 工程/Plugin 的导入由隔离的 `acplugin migrate` 负责。

## 环境要求

- 已发布 CLI/运行时：Node.js `^20.19.0 || ^22.13.0 || >=23.5.0`
- 仓库开发/构建：Node.js `^22.18.0 || >=24.11.0`
- 生成工程和本仓库统一使用 pnpm

## 快速开始

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes
cd my-plugin
pnpm install
pnpm build
```

也可以在空工程中安装框架和需要的 Platform：

```bash
pnpm add -D @tokenroll/acplugin \
  @tokenroll/acplugin-platform-claude-code \
  @tokenroll/acplugin-platform-codex
```

```ts
// acplugin.config.ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: '可复用的 AI 工作流。',
  platforms: [claudeCode(), codex()],
});
```

`init` 在没有传入 `--platform` 时会选择 Claude Code 和 Codex，但会显式写入两个 package 及其 import。运行时没有隐式 Platform：每次构建只使用 `platforms` 中的实例。

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
    ├── mcp/                        # 仅启用 MCP Extension 后使用
    │   └── docs/mcp.ts
    └── runtime/                    # 可选，由 Core 托管的 Node Runtime 源码
        ├── cli.ts                  # 一级文件按约定成为入口
        └── internal/helpers.ts     # 嵌套文件作为普通依赖
```

ID 和目录名使用小写 kebab-case。Markdown Component 必须包含 YAML Frontmatter 和非空正文。符号链接、逃逸工程根目录的路径会被拒绝。

ACPlugin 不提供 Instructions Component。仓库级 Instructions 属于宿主/工程配置，而不是可安装 Plugin 的能力边界。

## 配置

`acplugin.config.ts` 可以导出对象，也可以导出接收 `{ command, mode }` 的同步/异步函数。

```ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';

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
| `platforms` | 必填的非空列表，内容是显式导入的 Platform 实例。 |
| `runtime` | 内建 Node Runtime 约定、显式入口、编译参数或 `false`。 |
| `extensions` | Hooks、MCP 等可选横向能力。 |
| `build.outDir` | 托管输出目录，默认 `dist`。 |
| `build.strict` | 遇到 degraded/unsupported 是否失败，默认 `true`。 |

官方 Platform 是以主包为 peer dependency 的独立 package：

```ts
import antigravity from '@tokenroll/acplugin-platform-antigravity';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';
import cursor from '@tokenroll/acplugin-platform-cursor';
import openCode from '@tokenroll/acplugin-platform-opencode';
import pi from '@tokenroll/acplugin-platform-pi';

const platforms = [claudeCode(), codex(), cursor(), antigravity(), openCode(), pi()];
```

Claude Code、Codex、Cursor 和 Antigravity 生成静态 Plugin Package；OpenCode 生成 Workspace Overlay；Pi 生成 npm Package。`acplugin init --platform <id...>` 会显式安装并写入所选 package。主包不会重新导出官方集成、按 ID 发现 package，也不会在构建时安装依赖。

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

Codex 可安装 Plugin 不能注册自定义的工程/用户 Agent。因此包含 Agent 时，严格 Codex 构建会失败；只有明确接受 fallback 及其结构化告警时，才应配置 `codex({ strict: false })`。

Package 形态、全部可移植 Hook 事件和 MCP 传输支持请查看[完整兼容矩阵](./llmdoc/reference/conversion-matrix.zh-CN.md)。

## Hooks Extension

```bash
pnpm add -D @tokenroll/acplugin-extension-hooks
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import hooks from '@tokenroll/acplugin-extension-hooks';

export default defineConfig({
  name: 'policy-plugin',
  version: '1.0.0',
  description: '可移植策略 Hooks。',
  platforms: [claudeCode()],
  extensions: [hooks()],
});
```

```ts
// src/hooks/policy/hook.ts
import type { Hook } from '@tokenroll/acplugin-extension-hooks';

export default {
  event: 'PreToolUse',
  matcher: 'Bash',
  timeout: 5,
  async run(input) {
    return input.cwd
      ? { decision: 'allow' }
      : { decision: 'deny', reason: '缺少工作目录。' };
  },
} satisfies Hook<'PreToolUse'>;
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

ACPlugin 把每个实现只 bundle 一次，生成自包含、平台中立的 Node 20 ESM Handler；经过验证的平台 wire profile 会一同编译进该 Bundle，负责原生输入校验、递归 camelCase 转换、root/data 映射和输出映射，不再依赖相邻运行时 JavaScript。共享 Handler 负责有界 JSON I/O、语义结果校验、安全错误和确定性的第三方许可证产物。宿主忽略的 meaningful matcher 会按具体 Hook 报告 `degraded`；不支持的事件不会生成伪运行时。

## MCP Extension

```bash
pnpm add -D @tokenroll/acplugin-extension-mcp
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import mcp from '@tokenroll/acplugin-extension-mcp';

export default defineConfig({
  name: 'tools-plugin',
  version: '1.0.0',
  description: '可移植 MCP 工具。',
  platforms: [claudeCode()],
  extensions: [mcp()],
});
```

远程 Streamable HTTP：

```ts
// src/mcp/docs/mcp.ts
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';

export default {
  transport: 'http',
  url: 'https://example.com/mcp',
  auth: { type: 'bearer', env: 'DOCS_TOKEN' },
  headers: { 'X-Tenant': { env: 'TENANT_ID' } },
} satisfies McpServer;
```

本地 stdio：

```ts
// src/mcp/local-tools/mcp.ts
import type { McpServer } from '@tokenroll/acplugin-extension-mcp';

export default {
  transport: 'stdio',
  entry: 'server.ts',
  env: { API_TOKEN: { env: 'LOCAL_API_TOKEN' } },
} satisfies McpServer;
```

本地 MCP 需要由作者提供完整的 stdio MCP 实现，ACPlugin 将其 bundle 为 Node 20 ESM。development 与 production 构建都会拒绝无法静态解析的运行时 dynamic import，只把声明的公开字面量环境值传给探测进程，并要求在超时和输出上限内完成 `initialize → initialized → tools/list` 协议 smoke；不会通过 mode 分支或缓存跳过该检查，任何 Secret 引用值也不会被读取。HTTP MCP 只需要声明远程 endpoint、认证和 Header 引用。生产 HTTP 必须使用 HTTPS，开发模式仅允许 loopback HTTP。

Claude Code、Codex 和 OpenCode 同时支持远程 HTTP 与 Bundle 后的本地 stdio；Cursor 与 Antigravity 只支持远程 HTTP；Pi 会报告 MCP 不支持。详见[完整兼容矩阵](./llmdoc/reference/conversion-matrix.zh-CN.md)。

## 内建 Node Runtime

```ts
// acplugin.config.ts
export default defineConfig({
  // ...元数据与显式 Platforms
  runtime: {
    entries: {
      cli: { entry: 'bin/cli.ts', kind: 'executable' },
      library: { entry: 'library.ts', kind: 'module' },
    },
    compile: { treeshake: true },
  },
});
```

省略 `runtime` 字段时，`src/runtime/` 下每个受支持的一级文件都会按约定成为可执行入口，嵌套文件仍作为普通依赖。显式 `runtime.entries` 会完整替换自动发现，`runtime: false` 则关闭该约定。每个入口会成为 `runtime/<id>/main.mjs` 下确定、自包含的 Node 20 ESM Bundle。npm 依赖进入 Bundle，只有 `node:` 内置模块保持 external；可执行入口 mode 为 `0755`，module 入口为 `0644`，需要时输出相邻第三方许可证。Core 只编译一次，Claude Code 与 Codex 继承同一份 framework-owned 字节；没有稳定本地 Node/Plugin Root 契约的平台报告 `unsupported`，且不生成替代 Asset。类型检查仍由工程自己的 `tsc --noEmit` 负责。

## Extension 生命周期

```text
config → setup Sessions → discover Resources → Canonical Project
→ validate → compile → Platform base Package → Contributors → Core merge
→ finalize → materialize/validate candidates → Distributions
→ compatibility → transaction → reverse close
```

Descriptor 通过 `context.modules` 加载，可执行产物通过 Core 统一的 `context.compiler` Rolldown Service 构建；模块、许可证、Plugin 与 tsconfig 依赖图会自动进入 `dev` 监听。集成只获得 owner-scoped 能力，不得维护私有 bundler，也不能直接写 `dist`。Platform Contributor 从同一份不可变 base Package 返回自有 Asset、声明的 Document extension point 字段和兼容性，不能替换 Platform 输出或观察其他 Extension state。Session `close` 始终按初始化逆序执行。

## CLI

```text
acplugin init [directory]
acplugin dev
acplugin validate
acplugin inspect
acplugin build
acplugin migrate <source> [destination]
```

通用参数包括 `--config`、`--platform`、`--mode` 和 `--json`。兼容性严格度通过 `acplugin.config.ts` 中的 `build.strict` 或 Platform factory override 声明。

- `validate`：完整生成并验证 Platform，但不写 `dist`。
- `inspect`：额外返回 Package/Asset 详情，但不写 `dist`。
- `build`：所有 Platform 成功后才原子替换完整 `dist`。
- `dev`：监听配置、Core Module/Build Service 的真实模块图、Components、Public、descriptor，以及 bundler/Plugin/license/tsconfig 依赖；Package 依赖按解析后的 package root 监听。每批新 watcher ready 后先补偿构建，失败时保留上次成功产物，修复后恢复构建。对托管的可执行 Bundle，Rolldown 无法纳入静态模块图的运行时计算 import 会直接被拒绝。
- 裸 `acplugin` 只打印 Help，不发起交互。

退出码：`0` 成功、`1` 工程/构建/Migration 失败、`2` CLI 用法或框架内部失败、`130` 取消。非 watch 命令的 JSON 模式只向 stdout 输出一个带版本的文档。

## 确定性与安全

- Asset 是 owner-scoped 不可变引用，报告包含 mode、size、SHA-256 和结构化 origin。
- 拒绝绝对/穿越路径、符号链接、大小写/Unicode 冲突和未授权来源。
- 构建使用同文件系统 stage、锁、事务记录、备份和完整目录 swap。
- 任意 Platform 失败都会保留上次完整 `dist`。
- 生成内容/报告不包含时间戳、临时路径、环境变量值或凭据。
- 未启用对应 Extension 时，`src/hooks` 或 `src/mcp` 中存在内容会直接报错；`src/runtime` 由 Core 直接拥有。

## 旧版本 Migration

Migration 只属于 CLI，采用动态加载，并与 Core/Platform/正常启动路径隔离。

```bash
acplugin migrate ./legacy-project ./new-plugin \
  --name new-plugin \
  --description "迁移后的 Plugin"

acplugin migrate owner/repository ./new-workspace --all
```

支持本地 Claude 工程、单 Plugin、Marketplace 和 GitHub 来源。`--plugin <name>` 会把一个规范工程直接写到目标根；只有 `--all` 才创建由独立工程组成的 pnpm workspace。Skills、Commands、Agents 和可移植远程 HTTP MCP 会尽量映射；Instructions、原始 Hooks、Hook 实现文件、本地外部命令 MCP 和不支持的资源保存在 `.acplugin-migration/unmapped/`，同时生成稳定报告和人工处理项。生成工程在原子提交前会经过公开配置加载、真实 Core Module Service、Scanner、生命周期和隔离的 Migration Validator；安装依赖后再由正式 Platform/Extension 完成完整语义验证。Migration 不允许原地写入。

`--dry-run` 不写目标目录；`--strict` 在出现 degraded/unmapped 时失败。

## 文档工程与 Playground

除公开包外，仓库还包含两个仅供仓库使用的私有 workspace：

- `packages/docs` 是 VitePress 文档站，按 Guide、Config、Platform、Extension、Ecosystem、Playground 和 Resources 组织内容。每次启动或构建文档前，TypeDoc 都会为九个公开 package 根入口重新生成 API 页面和 sidebar。
- `packages/playground` 是一个领域中立的六平台/Hooks/MCP/Node Runtime 全能力模板。它验证规范 Commands、带辅助资源的 Skill、Agents、全部 portable Hook 事件、HTTP 与本地 MCP、Node Runtime、Public 文件和 Claude Code/Codex Marketplace，不实现特定产品业务。

```bash
pnpm run docs:dev       # 生成 API 页面并启动 VitePress
pnpm run docs:build     # 生成 API 页面并构建静态站点
pnpm run docs:check     # 检查文档结构/构建和真实 Playground
```

自动生成的 API Markdown/sidebar、VitePress cache/产物和 Playground `dist` 都可重建，并由 Git 忽略。

## 包与仓库开发

公开包：

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-platform-claude-code`
- `@tokenroll/acplugin-platform-codex`
- `@tokenroll/acplugin-platform-cursor`
- `@tokenroll/acplugin-platform-antigravity`
- `@tokenroll/acplugin-platform-opencode`
- `@tokenroll/acplugin-platform-pi`
- `@tokenroll/acplugin-extension-hooks`
- `@tokenroll/acplugin-extension-mcp`

官方集成使用与第三方 package 相同的公开 lifecycle SDK，并把主包声明为 peer dependency。Core、Vitest Test workspace、Docs 和 Playground 保持私有；Core 会内联进主包，任何公开运行时清单都不得包含 `@acplugin/*`。

```bash
pnpm install
pnpm run check
pnpm run docs:check
pnpm run release:verify
```

`release:verify` 会从同一 Revision 创建九个公开 tarball，检查 Manifest、文件列表、类型解析、peer rewrite 和品牌互操作，并在 monorepo 外的干净消费者中构建六 Platform/两个 Extension 脚手架并验证内建 Runtime；不会发布 npm。

PR 会自动执行 lint/typecheck，并通过独立的 Docs/Playground 质量门。手工触发的 `Patch` Workflow 接收一个至少包含一份会升级公开包的有效 Changeset 的目标分支，消费 Changesets 以升级版本并生成 changelog，随后创建一个合并回该目标分支的版本 PR。

九个公开 package 独立版本化，只发布发生版本变化的 package。如果新的集成版本要求尚未发布的主包 peer range，先发布并验证该主包版本；除此之外，各集成之间没有固定顺序。每个 Registry 精确版本、package 对应的 Tag 和 GitHub Release 都由维护者手工处理；仓库不包含自动发布 Workflow。

## License

MIT
