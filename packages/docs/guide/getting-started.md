# 快速开始

## 环境要求

作者工程使用 pnpm、ESM 和 TypeScript。公开包当前支持 Node.js `^20.19.0 || ^22.13.0 || >=23.5.0`。

## 用 CLI 初始化

下面的命令创建一个私有工程，默认显式安装并配置 Claude Code 与 Codex：

```bash
pnpm dlx @tokenroll/acplugin init my-plugin --yes --install
cd my-plugin
pnpm validate
pnpm build
```

`init` 的默认平台只属于脚手架；运行时没有隐藏默认值。最终 `acplugin.config.ts` 总是包含独立 package imports 和必填的 `platforms` 数组。

## 手工建立最小工程

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
  description: 'Reusable AI workflows.',
  platforms: [claudeCode(), codex()],
});
```

添加一个 Skill：

```md
<!-- src/skills/review/SKILL.md -->
---
description: Review a change and report actionable findings
---

Inspect the requested change, verify each finding against source, and report severity.
```

然后运行：

```bash
pnpm exec acplugin validate
pnpm exec acplugin inspect
pnpm exec acplugin build
```

默认输出目录是 `dist/`。它是框架完整托管的目录，不要在其中保存手写文件。继续阅读[工程结构](./project-structure.md)和[构建与校验](./build-and-validate.md)。
