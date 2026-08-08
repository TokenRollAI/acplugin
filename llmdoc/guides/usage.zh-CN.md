# 使用 acplugin

> [English version](usage.md)

acplugin 工程只创作一份规范 Plugin，然后为 Claude Code、Codex、Cursor、Antigravity、OpenCode 和 Pi 编译由各 Platform 拥有的交付产物。运行环境需要 Node.js 20 或更高版本以及 pnpm。

## 创建工程

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes
cd my-plugin
pnpm install
pnpm build
```

`init` 可通过 `--hooks` 和 `--mcp` 加入官方 Hooks/MCP Extension。默认配置会构建 Claude Code 和 Codex，并使用 `src/`、`public/` 和 `dist/` 目录。也可以显式选择任意受支持组合：

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes \
  --platform claude-code codex cursor antigravity opencode pi \
  --hooks --mcp
```

启用 Extension 只会添加依赖、Import、配置项和空源码目录；`init` 不会伪造 Hook Handler 或 MCP Server。

## 创作 Components

Commands 放在 `src/commands/<id>.md`，Skills 放在 `src/skills/<id>/SKILL.md`，Agents 放在 `src/agents/<id>.md`。Component ID 使用小写 kebab-case。Markdown 文件必须包含 YAML Frontmatter 和非空正文。

必需的顶层身份信息直接写在 `acplugin.config.ts`：

```ts
import { defineConfig } from '@tokenroll/acplugin';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
});
```

acplugin 不提供 Instructions Component。只有启用对应官方 Extension 后，工程才允许存在 Hooks 或 MCP 目录。

TypeScript 配置以及已启用的 Hook/MCP 描述文件都是受信任、可执行的项目代码，应当像构建脚本一样接受 review。Legacy Migration 来源会作为不可信数据扫描，不会作为描述文件执行。

## 验证与构建

```bash
pnpm exec acplugin validate
pnpm exec acplugin inspect
pnpm exec acplugin build
pnpm exec acplugin dev
```

- `validate` 会在临时目录中生成并物化全部选中 Platform，不修改 `dist`；
- `inspect` 会增加 Artifact 明细，但不修改 `dist`；
- `build` 只有在全部 Platform 成功后才会原子替换完整受管输出；
- `dev` 监听配置、规范资源、Public、descriptor 和登记的 Bundle import，合并变更并用 watcher ready 后的补偿构建关闭竞态窗口；重建失败时保留最后一次成功输出。

通用选项包括 `--config`、`--platform <id...>`、`--mode`、`--no-strict` 和 `--json`。默认启用严格模式。例如，包含 Agent 的 Codex 构建会失败，因为 Codex 只能接收显式降级的 Skill 回退；当该结果符合预期时，可使用 `--no-strict` 明确接受。

现有工程通过公开工厂配置非默认 Platform：

```ts
import { antigravity, claudeCode, codex, cursor, defineConfig, openCode, pi } from '@tokenroll/acplugin';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode(), codex(), cursor(), antigravity(), openCode(), pi()],
  build: { strict: false },
});
```

OpenCode 产物是 Workspace Overlay，Pi 产物是 npm Package，不会被错误标记为静态 Plugin。启用严格多平台构建前应先查看[平台支持矩阵](../reference/conversion-matrix.zh-CN.md)。

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
