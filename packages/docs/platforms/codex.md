# Codex

## 安装与配置

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-platform-codex
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import codex from '@tokenroll/acplugin-platform-codex';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [codex()],
});
```

## Options

- `strict?: boolean`：覆盖兼容性严格度。
- `interface?`：安装界面的描述、开发者、分类、URL、颜色、图标、截图和默认 prompt。
- `marketplace?`：可选 Marketplace 名称、展示名、分类和 installation policy。
- `generatedSkillIds.command?: 'plugin-prefixed'`：显式选择 `<plugin-name>-<command-id>`；缺省仍为 `command-<id>`。

所有字段都通过受控 Schema 校验，不接受任意 Manifest 透传。

## 交付与兼容性

主 Plugin 以 `.codex-plugin/plugin.json` 和 `skills/` 为核心：

- Canonical Skill 保持 native。
- Command 默认转换为 `skills/command-<id>`；显式配置 `generatedSkillIds.command: 'plugin-prefixed'` 后使用 `skills/<plugin-name>-<id>`。参数占位符变成显式调用指导；`argumentHint` 无 UI 时为 degraded。
- Agent 转换为 `skills/agent-<id>` 的指导型 Skill，model/capabilities 只保留为文本，因此为 degraded。

存在 Agent 的工程默认 strict 会失败；只有明确接受这一降级时才使用 `codex({ strict: false })`。可选 Marketplace 写入 `.agents/plugins/marketplace.json`。

[Codex package API](/api/@tokenroll/acplugin-platform-codex/)
