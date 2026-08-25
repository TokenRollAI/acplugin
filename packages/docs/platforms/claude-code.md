# Claude Code

## 安装与配置

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-platform-claude-code
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import claudeCode from '@tokenroll/acplugin-platform-claude-code';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [claudeCode()],
});
```

## Options

- `strict?: boolean`：覆盖全局兼容性严格度。
- `defaultEnabled?: boolean`：写入 Claude Code Plugin Manifest。
- `marketplace?: { name?, owner?, category?, tags? }`：额外生成自包含 Marketplace。省略时只生成 Plugin。

```ts
claudeCode({
  marketplace: {
    owner: { name: 'Example Team' },
    category: 'Developer Tools',
    tags: ['workflow'],
  },
})
```

## 交付与兼容性

主 Plugin 包含 `.claude-plugin/plugin.json`、`commands/`、`skills/` 与 `agents/`。Command 的 `{{arguments}}` 转为原生 `$ARGUMENTS`；三类 Component 均为 native。

Hooks/MCP 由独立 Extension Contributor 向 Manifest 的受控扩展点写入。Platform 本身不 import Extension package。配置 `marketplace` 时还生成 `.claude-plugin/marketplace.json`，并继承已经验证的完整主 Plugin Asset。

可信 Extension 也可通过本 package 的 `ClaudePackageComponent` 交付私有原生 Agent。Claude Code 在 finalization 自己校验 payload、处理与 canonical Agent 的命名冲突、生成 `agents/<id>.md` 并受控写入 `agents` Manifest 字段；Extension 不能直接写这些路径或 Manifest。

[Claude Code package API](/api/@tokenroll/acplugin-platform-claude-code/)
