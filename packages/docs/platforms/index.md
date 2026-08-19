# 官方平台

六个官方 Platform 都是独立 package。工程只安装和实例化需要的目标平台。

| Platform | Package | 主 Package | Component 策略 |
| --- | --- | --- | --- |
| [Claude Code](./claude-code.md) | `@tokenroll/acplugin-platform-claude-code` | Plugin / 可选 Marketplace | Command、Skill、Agent 原生 |
| [Codex](./codex.md) | `@tokenroll/acplugin-platform-codex` | Plugin / 可选 Marketplace | Skill 原生，Command 转 Skill，Agent 降级为 Skill |
| [Cursor](./cursor.md) | `@tokenroll/acplugin-platform-cursor` | Plugin | Command、Skill、Agent 原生，部分字段可能降级 |
| [Antigravity](./antigravity.md) | `@tokenroll/acplugin-platform-antigravity` | Plugin | Skill 原生，Command 转 Skill，Agent 降级为 Skill |
| [OpenCode](./opencode.md) | `@tokenroll/acplugin-platform-opencode` | Workspace | 三类资源原生，capability 转 tools/permissions |
| [Pi](./pi.md) | `@tokenroll/acplugin-platform-pi` | npm Package | Command 转 Prompt，Skill 原生，Agent 降级为 Skill |

工厂的 `strict` 可以覆盖全局兼容性策略。更细粒度的差异见[兼容性矩阵](/resources/compatibility-matrix)。
