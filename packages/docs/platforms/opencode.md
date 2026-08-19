# OpenCode

## 安装与配置

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-platform-opencode
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import openCode from '@tokenroll/acplugin-platform-opencode';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [openCode({ workspace: { schema: true } })],
});
```

## Options

- `strict?: boolean`：覆盖兼容性严格度。
- `workspace.schema?: boolean`：在按需生成的 `opencode.json` 中写入官方 JSON Schema URL。

不开放任意 workspace JSON 透传。

## 交付与兼容性

OpenCode 产生 workspace 主 Package，而不是安装型 Plugin：

```text
.opencode/commands/
.opencode/skills/
.opencode/agents/
opencode.json              # 有配置或 Extension 内容时生成
```

Command、Skill、Agent 都有原生 workspace 表示。Canonical capabilities 会转换为 OpenCode tools/permission 字段；无法精确固定 model 时按字段报告 degraded。HTTP 与 local stdio MCP 都可由官方 Contributor 加入 workspace 配置。

[OpenCode package API](/api/@tokenroll/acplugin-platform-opencode/)
