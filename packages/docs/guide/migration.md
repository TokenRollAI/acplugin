# Migration

Migration 用于把旧 Claude 工程或 Plugin 转成新的 Canonical 源码。它位于主包的隔离 lazy chunk 中，正常 CLI 启动、Core、Platform 与 Extension 都不会 import legacy Scanner。

```bash
pnpm exec acplugin migrate ./legacy-project ./new-project --dry-run --json
```

## 安全边界

- 目标必须是新的或空目录；不会原地写旧工程。
- 可安全映射的 Commands、Skills、Agents 进入 Canonical 目录。
- Instructions、raw Hooks、外部命令 MCP 和其他不能安全映射的内容进入 `.acplugin-migration/unmapped/`。
- 旧 Hook 引用文件只作为待人工迁移材料保留，不会伪装成 typed Hook。
- 报告稳定列出每项来源、去向和未映射原因。

## Marketplace 来源

GitHub Marketplace 输入可通过 `--plugin <name>` 选择一个 Plugin，或用 `--all` 迁移全部。`--path` 指定仓库内子路径。

迁移完成后仍应手工检查 unmapped 内容，再在新目录中安装依赖并运行 `validate`。Migration 的容错读取不改变 Core 对新工程的严格类型规则。
