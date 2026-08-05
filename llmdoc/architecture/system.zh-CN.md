# 系统架构

> [English version](system.md)

## Pipeline

```text
acplugin.config.ts
  → 解析并验证配置
  → 排序并初始化 Modules
  → 发现规范 Components/Public
  → 验证 Component 依赖图
  → 收集 Module 目标贡献
  → 为每个目标执行内置 Compiler
  → 建立不可变 Artifact 图
  → 应用兼容性严格度并完成最终验证
  → 仅验证物化，或执行受管输出事务
  → 生成稳定报告
```

`validate`、`inspect` 和 `build` 运行同一套 Pipeline，区别只在报告明细和提交行为。`dev` 会在合并后的每次重建中创建全新 Pipeline；重建失败时保留最后一次成功的完整输出。

## Core 包

`packages/core/src/` 负责：

- `types.ts`：公开 Config、Component、Module、Compiler、Artifact、兼容性和报告契约；
- `config.ts`：严格配置规范化和安全的项目相对目录；
- `scanner.ts`：规范 Markdown/Public 发现、Frontmatter 验证、依赖图检查和 Module 目录门禁；
- `diagnostics.ts`：稳定排序的诊断与兼容性严格度；
- `artifacts.ts`：所有权、摘要、文件来源根目录、权限模式和冲突检查；
- `builder.ts`：生命周期编排、Compiler 分发和最终 Artifact 图/报告创建；
- `transaction.ts`：验证物化以及整个 `dist` 的锁、备份、交换和恢复；
- `serialization.ts`：确定性 JSON/YAML/Markdown 序列化。

Artifact 会拒绝绝对路径和目录穿越、符号链接、不支持的权限模式、来源目录逃逸，以及精确、大小写不敏感或 Unicode 规范化后的路径冲突。

## Module 生命周期

```text
configResolved → discover → validate → build → generate(target) → buildEnd
```

Module 按 `dependsOn` 进行拓扑排序；无依赖关系的同级 Module 保持配置顺序。Module 只能访问显式声明依赖的 State/Built State，并且只能写入 Core 提供的工作目录。Module 可以返回目标 Artifact、由其唯一拥有的顶层 Manifest 字段和兼容性条目。Compiler 始终完整拥有 Manifest 和目标 Schema。

`buildEnd` 在成功或失败后按初始化的逆序执行。候选提交期间，事务会在逆序清理完成前保留旧输出作为回滚备份。清理失败会写入报告、传递给剩余清理 Hook，并把目录交换回滚到上一份完整输出。交换前失败则通过普通错误路径进入清理阶段。

## 内置 Compiler

`packages/compiler-claude-code/` 生成原生 Commands、Skills、Agents 和 `.claude-plugin/plugin.json`。

`packages/compiler-codex/` 生成原生 Skills、Command 回退 Skills、Agent 回退 Skills、调用策略元数据和 `.codex-plugin/plugin.json`。生成标识按大小写不敏感方式保留；任何冲突都会显式失败。

两个包均为私有包，并由 tsdown 内联进 `@tokenroll/acplugin`。

## 官方 Modules

`packages/module-hooks/` 发现 `src/hooks/<id>/hook.ts`，验证事件、Matcher、超时和结果语义，并为每个支持目标打包一个带 JSON 大小边界的独立运行器。字面量动态导入确保 Handler 及其依赖进入 Bundle。运行时失败只输出固定错误码，不输出输入载荷。第三方依赖许可文件与 Handler 相邻生成。

`packages/module-mcp/` 发现 `src/mcp/<id>/mcp.ts`。Streamable HTTP 声明会映射 URL、认证和 Header 环境变量引用，不会读取凭据。本地 stdio 入口会被打包为 Node 20 ESM，并携带相邻的第三方许可说明。

## 受管输出事务

`dist` 是一套完整的受管目标集合：

1. 获取同级独占锁；
2. 恢复遗留的备份或事务记录；
3. 在同一文件系统的阶段目录中物化所有选中目标；
4. 重新计算并验证每个 Artifact 的大小、SHA-256、权限和普通文件状态；
5. 写入事务记录，并把旧输出重命名为备份；
6. 把阶段目录重命名为正式输出，同时保留回滚边界；
7. 成功完成 Module 清理，否则执行回滚；
8. 删除事务记录，并尽力清理备份。

提交前失败不会触碰旧输出。备份或交换后失败会执行回滚。如果只有清理过程被中断，下次运行会确定性地协调输出和备份。Core 测试会在每个可观测阶段注入失败。

## CLI 与包边界

`packages/acplugin/src/index.ts` 使用 Jiti 重新加载受信任的 TypeScript 配置和描述 Module，并连接两个已内联 Compiler。嵌套配置对象会在进入 Pipeline 前完成运行时 Schema 检查。`cli.ts` 负责命令、JSON/文本输出纪律、退出码、监听事件合并和 Migration 延迟导入。稳定诊断会隐藏外部异常、本机绝对路径和可识别的凭据形式。

普通公开门面和 CLI 启动过程不会导入 `migration/`。主包 tarball 不包含私有包导入或私有运行时依赖；`scripts/verify-release.mjs` 会在外部消费者中验证这一点。
