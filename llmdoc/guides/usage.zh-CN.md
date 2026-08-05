# 使用 acplugin

> [English version](usage.md)

acplugin 工程只创作一份规范 Plugin，然后编译出可安装的 Claude Code 和 Codex Plugin。运行环境需要 Node.js 20 或更高版本以及 pnpm。

## 创建工程

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes
cd my-plugin
pnpm install
pnpm build
```

`init` 可通过 `--hooks` 和 `--mcp` 加入官方 Hooks/MCP Module。默认配置会构建两个目标，并使用 `src/`、`public/` 和 `dist/` 目录。

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

acplugin 不提供 Instructions Component。只有启用对应官方 Module 后，工程才允许存在 Hooks 或 MCP 目录。

TypeScript 配置以及已启用的 Hook/MCP 描述文件都是受信任、可执行的项目代码，应当像构建脚本一样接受 review。Legacy Migration 来源会作为不可信数据扫描，不会作为描述 Module 执行。

## 验证与构建

```bash
pnpm exec acplugin validate
pnpm exec acplugin inspect
pnpm exec acplugin build
pnpm exec acplugin dev
```

- `validate` 会在临时目录中生成并物化全部选中目标，不修改 `dist`；
- `inspect` 会增加 Artifact 明细，但不修改 `dist`；
- `build` 只有在全部目标成功后才会原子替换完整受管输出；
- `dev` 监听输入并合并变更；重建失败时保留最后一次成功输出。

通用选项包括 `--config`、可重复的 `--target`、`--mode`、`--no-strict` 和 `--json`。默认启用严格模式。例如，包含 Agent 的 Codex 构建会失败，因为 Codex 只能接收显式降级的 Skill 回退；当该结果符合预期时，可使用 `--no-strict` 明确接受。

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

Migration 也支持受支持的 GitHub 来源格式、单个 Claude Plugin 和 Marketplace。使用 `--dry-run` 可避免写入目标目录，使用 `--strict` 可在存在任何降级或未映射资源时失败。不可移植资源会随报告保存在 `.acplugin-migration/unmapped/`；Migration 绝不会原地修改来源。
