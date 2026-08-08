# Cursor

## 安装与配置

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-platform-cursor
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import cursor from '@tokenroll/acplugin-platform-cursor';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [cursor()],
});
```

## Options

`CursorPlatformOptions` 支持 `strict`、`publisher`、`logo`、`category`、`tags` 和按客户端 ID 映射的 `minClientVersions`。Logo 只能是安全相对路径或合法远程 URL。

## 交付与兼容性

Plugin 包含 `.cursor-plugin/plugin.json`、`commands/`、`skills/` 与 `agents/`。三类 Component 都有原生表示，但字段仍逐项报告：

- Command `argumentHint` 在目标 UI 不可表达时 degraded。
- Skill 无法关闭显式 user invocation 时 degraded。
- Agent model 或 capability 无法精确强制时 degraded。

Hooks/MCP 的具体事件或 transport 支持由对应 Extension Adapter 报告，Platform 只提供受控 Manifest 扩展点。

[Cursor package API](/api/@tokenroll/acplugin-platform-cursor/)
