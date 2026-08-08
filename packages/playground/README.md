# @acplugin/playground

这是以 llmdoc v3 为主题的 ACPlugin packaging/template smoke。它用真实公开 package、Canonical Scanner、Hooks bundler、Platform Adapter、DeliveryUnit validator 和托管事务构建 Claude Code/Codex 产物。

```bash
pnpm --filter @acplugin/playground typecheck
pnpm --filter @acplugin/playground validate
pnpm --filter @acplugin/playground build
```

在干净 checkout 中请从仓库根运行 `pnpm playground:check`，它会先构建 CLI 与公开 packages。

## 包含的模板

- `init`、`update`、`prune`、`upgrade` 四个 Command。
- `llmdoc` Skill 和四个 references auxiliary files。
- `investigator`、`reflector`、`recorder` 三个 Agent。
- `SessionStart`、`PreCompact`、`Stop` 三个可 bundle no-op Hook。
- runtime/schema/upgrade 边界说明和四个 Public Markdown 模板。

## 明确非目标

此工程不实现 Frontier 状态、fingerprint、knowledge graph、delta、transaction、rollback、`meta.json`、可执行 Schema、Migration runtime、MCP、增量更新或缓存。三个 Hook 返回 `void`，不会读写知识库。

Codex 会把 Command 生成 `command-*` Skill，把 Agent 降级成 `agent-*` guidance Skill；这不等同于 llmdoc v3 目标中的 `llmdoc-*` 命名或 scoped `runtime/agents`。因此配置使用 `strict: false`，并要求构建报告只出现这些已知 Agent 降级及其向依赖 Command 的传播。

`upgrade` 是显式 Command 骨架，但不能证明完整迁移正文被物理惰性加载。本 workspace 不是 llmdoc v3 产品实现或 conformance suite。
