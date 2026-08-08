# CLI

## 初始化

```bash
pnpm exec acplugin init [directory] [options]
```

常用选项：`--yes`、`--name`、`--display-name`、`--description`、`--platform <platforms...>`、`--hooks`、`--mcp`、`--install`、`--json`。默认脚手架选择 Claude Code 与 Codex；这不是运行时默认。

## 项目流水线

```bash
pnpm exec acplugin validate
pnpm exec acplugin inspect
pnpm exec acplugin build
pnpm exec acplugin dev
```

共享选项：

| 选项 | 含义 |
| --- | --- |
| `-c, --config <path>` | 使用另一个 TypeScript 配置文件 |
| `--platform <id...>` | 只运行配置中已实例化的平台子集 |
| `--mode development\|production` | 传给函数式配置的模式 |
| `--strict` / `--no-strict` | 覆盖本次兼容性严格度 |
| `--json` | stdout 只输出一个稳定 JSON 报告 |

未知、重复、空或未配置的 `--platform` 会失败。旧 `--target` 已删除，不是兼容 alias。

## Migration

```bash
pnpm exec acplugin migrate <source> [destination] [options]
```

支持本地路径和受支持的 GitHub 来源。`--dry-run` 在临时存储中生成并验证；`--strict` 在存在 degraded/unmapped 资源时失败。详细边界见 [Migration](./migration.md)。

CLI 使用错误与构建失败使用非零退出码。机器消费时始终加 `--json`，不要解析人类可读文本。
