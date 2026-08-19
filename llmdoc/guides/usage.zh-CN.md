# 使用 ACPlugin

> [English version](usage.md)

ACPlugin 工程只创作一份规范 Plugin，然后为 Claude Code、Codex、Cursor、Antigravity、OpenCode 和 Pi 编译由各 Platform 拥有的交付产物。运行环境需要 Node.js `^20.19.0 || ^22.13.0 || >=23.5.0` 以及 pnpm。

## 创建工程

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes
cd my-plugin
pnpm install
pnpm build
```

`init` 可通过 `--hooks` 和 `--mcp` 加入官方 Hooks 与 MCP Extension；`--node-runtime` 只生成内建约定入口 `src/runtime/main.ts`，不会添加额外 package 或 factory。未传 `--platform` 时，它的脚手架选择是 Claude Code 和 Codex，但仍会显式写入两个 Platform 依赖、import 和配置项。也可以改为选择任意受支持组合：

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes \
  --platform claude-code codex cursor antigravity opencode pi \
  --hooks --mcp --node-runtime
```

每个所选 Platform 都是独立 package。启用 Extension 同样只会添加依赖、Import、配置项和空源码目录；`init` 不会伪造 Hook Handler 或 MCP Server。内建 Runtime 模板是真实、中立的可执行源码，依赖 Core 默认的 `src/runtime` 自动发现。构建运行时不会默认发现或安装 package。

已知的 `init` 输入错误使用稳定的 `INIT_INVALID` 诊断，并保留安全、可操作的原因；对应的专用错误类型保持内部实现，不从公开门面导出。

## 创作 Components

Commands 放在 `src/commands/<id>.md`，Skills 放在 `src/skills/<id>/SKILL.md`，Agents 放在 `src/agents/<id>.md`。Component ID 使用小写 kebab-case。Markdown 文件必须包含 YAML Frontmatter 和非空正文。

必需的顶层身份信息直接写在 `acplugin.config.ts`：

```ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode(), codex()],
});
```

ACPlugin 不提供 Instructions Component。只有启用对应官方 Extension 后，工程才允许存在 Hooks 或 MCP 目录。`src/runtime` 由 Core 拥有：一级 TS/JS 文件按约定成为入口，`runtime.entries` 可替换自动发现，`runtime: false` 可关闭该能力。

TypeScript 配置以及已启用的 Hook/MCP 描述文件都是受信任、可执行的项目代码，应当像构建脚本一样接受 review。Legacy Migration 来源会作为不可信数据扫描，不会作为描述文件执行。

## 验证与构建

```bash
pnpm exec acplugin validate
pnpm exec acplugin inspect
pnpm exec acplugin build
pnpm exec acplugin dev
```

- `validate` 会在临时目录中生成并物化全部选中 Platform，不修改 `dist`；
- `inspect` 会增加 Package 与 Asset 明细，但不修改 `dist`；
- `build` 只有在全部所选 Platform 成功后才会原子替换完整受管 Package 集合；
- `dev` 监听配置、规范资源、Public、descriptor 和 Core Module/Build Service 的真实图，其中包括 Plugin、license 与 tsconfig 依赖；解析后的依赖会贡献 package root。托管 Bundle 中 Rolldown 无法表示在静态模块图内的运行时计算 import 会被拒绝。Dev 会合并变更，用 watcher ready 后的补偿构建关闭竞态窗口，并在重建失败时保留最后一次成功输出。

通用选项包括 `--config`、`--platform <id...>`、`--mode` 和 `--json`。默认启用严格模式，并通过 `build.strict` 或 Platform factory override 配置。例如，包含 Agent 的 Codex 构建会失败，因为 Codex 只能接收显式降级的 Skill 回退；当该结果符合预期时，可使用 `codex({ strict: false })` 明确接受。

现有工程需要显式安装并导入每个 Platform package：

```ts
import { defineConfig } from '@tokenroll/acplugin';
import antigravity from '@tokenroll/acplugin-platform-antigravity';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';
import codex from '@tokenroll/acplugin-platform-codex';
import cursor from '@tokenroll/acplugin-platform-cursor';
import openCode from '@tokenroll/acplugin-platform-opencode';
import pi from '@tokenroll/acplugin-platform-pi';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode(), codex(), cursor(), antigravity(), openCode(), pi()],
  build: { strict: false },
});
```

`platforms` 是必填项，`--platform <id...>` 只会筛选该列表中已经实例化的 ID。主包不重新导出官方工厂，也不提供 Platform subpath。OpenCode 产物是 Workspace Overlay，Pi 产物是 npm Package，不会被错误标记为静态 Plugin。启用严格多平台构建前应先查看[平台支持矩阵](../reference/conversion-matrix.zh-CN.md)。

Codex 默认把 Command 转换为显式的 `<plugin-name>-<id>` Skill。对于 Plugin `my-plugin`，Command `bootstrap` 会生成 `my-plugin-bootstrap`；这不会改变 canonical Command ID 或其他 Platform。

## Public 文件

默认情况下，`public/` 中的普通文件会复制到每个目标根目录。如果只需复制其中一部分，可以使用显式规则：

```ts
public: {
  dir: 'public',
  copy: [
    { from: 'assets', to: 'assets' },
    { from: 'NOTICE.md', to: 'NOTICE.md' },
  ],
},
```

符号链接、目录穿越、路径冲突以及可信根目录之外的来源都会被拒绝。

## 迁移旧工程

```bash
pnpm exec acplugin migrate ./legacy-project ./new-plugin \
  --name new-plugin \
  --description "Migrated plugin"
```

Migration 也支持受支持的 GitHub 来源格式、单个 Claude Plugin 和 Marketplace。`--plugin <name>` 在目标根输出一个工程，`--all` 输出 pnpm workspace。使用 `--dry-run` 可避免写入目标目录，使用 `--strict` 可在存在任何降级或未映射资源时失败。生成工程会经过公开配置加载和真实 Extension/Platform 验证。不可移植资源会随报告保存在 `.acplugin-migration/unmapped/`；Migration 绝不会原地修改来源。
