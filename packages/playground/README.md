# @acplugin/playground

这是一个不绑定具体产品领域的完整 ACPlugin capability template。它用真实公开 package、Canonical Scanner、Hooks/MCP bundler、Platform Adapter、DeliveryUnit validator 和托管事务构建六个平台产物。

```bash
pnpm --filter @acplugin/playground typecheck
pnpm --filter @acplugin/playground validate
pnpm --filter @acplugin/playground build
```

在干净 checkout 中请从仓库根运行 `pnpm playground:check`，它会先构建 CLI 与公开 packages。

## 包含的模板

- `init`、`update`、`prune`、`upgrade` 四个通用工程 Command；`init` 同时覆盖 argument hint、参数占位符和 Claude Code/Codex 平台字段。
- `project-workflow` Skill、四个通用工作流 references 和两个 Codex Skill icon auxiliary files。
- `investigator`、`reflector`、`recorder` 三个 Agent。
- 全部 11 个 portable Hook 事件，覆盖 matcher、timeout、status message、Codex context limit 和事件级语义结果。
- public、OAuth scopes、Bearer env/header 三种远程 HTTP MCP，以及可真实执行 `initialize`、`tools/list`、`tools/call` 的 local stdio MCP。
- runtime/schema/upgrade 静态资源示例、品牌 SVG 和四个 Public Markdown 模板。
- Claude Code/Codex 自包含 Marketplace，以及 Cursor、Antigravity、OpenCode、Pi 的主交付单元。

## 验证范围

仓库根的 `pnpm playground:check` 不只检查文件是否存在。`scripts/verify-playground.mjs` 会：

- 对六个平台的 211 条 compatibility 记录和 84 条预期降级/不支持项执行精确白名单校验。
- 比较 BuildResult Artifact Registry 与真实 `dist` 文件树，并按字节检查 Skill auxiliary、Public 和 Marketplace 继承产物。
- 解析 Manifest、Hooks 配置和 MCP 配置，确认所有引用存在，且 unsupported 能力没有伪造 Artifact。
- 用真实子进程执行每个受支持的 Hook `handler.mjs + wire.mjs`，并对三个 local MCP bundle 执行完整 JSON-RPC smoke。
- 用 Secret 探针扫描报告和产物，连续构建两次并比较全部文件 hash 与 mode。

## 模板边界

此工程只演示 ACPlugin 的作者资源、配置字段、平台转换和 Extension 协议。Command、Skill、Agent、Hook、MCP 与 Public 文件使用无持久化副作用的示例逻辑，第三方作者应替换为自己的产品能力。

Codex、Antigravity 和 Pi 会把 Agent 降级成 `agent-*` guidance Skill；Codex/Antigravity 还把 Command 转成 `command-*` Skill，Pi 转成 Prompt Template。配置使用 `strict: false` 以展示平台差异，但 verifier 只接受六平台矩阵中逐项声明的 degradation/unsupported。

本 workspace 是能力覆盖和 packaging smoke，不是任何具体产品的实现或平台官方 conformance suite。
