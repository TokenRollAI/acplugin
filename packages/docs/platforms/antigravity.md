# Antigravity

## 安装与配置

```bash
pnpm add -D @tokenroll/acplugin @tokenroll/acplugin-platform-antigravity
```

```ts
import { defineConfig } from '@tokenroll/acplugin';
import antigravity from '@tokenroll/acplugin-platform-antigravity';

export default defineConfig({
  name: 'my-plugin',
  version: '1.0.0',
  description: 'Reusable AI workflows.',
  platforms: [antigravity({ strict: false })],
});
```

## Options

当前只开放 `strict?: boolean`。官方公开 Manifest 契约尚未确认的字段不会被猜测性写入。

## 交付与兼容性

Plugin 根使用最小 `plugin.json` 和 `skills/`：

- Skill 是 native；不能表达 invocation 开关时按字段报告 degraded。
- Command 转成带固定前缀的显式 Skill；argument hint UI 不可用时 degraded。
- Agent 转成指导型 Skill，model/capabilities 无法强制，因此 degraded。

除 `name` 外，统一元数据会按实际声明报告 omitted 与 warning，而不是写入未经确认的 Manifest 字段。包含 Agent 的工程需要显式审查 strict 策略。

Antigravity 当前不支持 Platform Component Contribution。非空私有 contribution 会在 finalization 失败，绝不会被伪装为 Skill。

[Antigravity package API](/api/@tokenroll/acplugin-platform-antigravity/)
