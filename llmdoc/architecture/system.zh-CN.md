# 系统架构

> [English version](system.md)

## Pipeline

```text
acplugin.config.ts
  → 解析并验证配置
  → 初始化 Platforms 和 Extensions
  → Extension discover，再执行规范 Component/Public 扫描
  → Extension validate/build
  → Platform prepare
  → Extension Platform Adapters
  → Platform generate/validate/distribute
  → 建立不可变 DeliveryUnit/Artifact 图
  → 应用兼容性严格度
  → 仅验证物化，或执行受管输出事务
  → 生成稳定报告
```

`validate`、`inspect` 和 `build` 运行同一套 Pipeline，区别只在报告明细和提交行为。`dev` 会在合并后的每次重建中创建全新 Pipeline，纳入 Extension 登记的 Bundle 模块图，并在 watcher ready 后先补偿构建；重建失败时保留最后一次成功的完整输出。

## Core 包

`packages/core/src/` 负责：

- `types.ts`：公开 Config、Component、Artifact、兼容性和报告契约；
- `contracts.ts`：带品牌的 Platform、Extension、Adapter 和生命周期 API；
- `config.ts`：严格配置规范化和安全的项目相对目录；
- `scanner.ts`：规范 Markdown/Public 发现、Frontmatter 验证、依赖图检查和 Extension 目录门禁；
- `diagnostics.ts`：稳定排序的诊断与兼容性严格度；
- `artifacts.ts`：所有权、摘要、文件来源根目录、权限模式和冲突检查；
- `documents.ts`：add-only 逻辑 Document 扩展点和最终序列化；
- `delivery-units.ts`：主单元/分发单元所有权和不可变 Artifact 注册；
- `lifecycle.ts`：固定 Platform/Extension 编排和最终报告创建；
- `transaction.ts`：验证物化以及整个 `dist` 的锁、备份、交换和恢复；
- `serialization.ts`：确定性 JSON/YAML/Markdown 序列化。

Artifact 会拒绝绝对路径和目录穿越、符号链接、不支持的权限模式、来源目录逃逸，以及精确、大小写不敏感或 Unicode 规范化后的路径冲突。

## Platform 与 Extension 生命周期

```text
configResolved → buildStart → Extension discover → Core scan → Extension validate/build
→ Platform prepare → Adapter apply → Platform generate/validate/distribute → buildEnd
```

Platform 按配置顺序执行；Extension 同样按配置顺序执行，不形成隐藏依赖图。每个 Extension 只能写入 Core 提供的工作目录，并返回平台中立 Built State。其 Adapter 只能读取声明的 Document、在 Platform 拥有的扩展点增加字段、提交自有 Artifact 和报告兼容性。Platform 始终完整拥有生命周期、Manifest、Schema、Validator 和分发。

`buildEnd` 在成功或失败后按初始化的逆序执行。候选提交期间，事务会在逆序清理完成前保留旧输出作为回滚备份。清理失败会写入报告、传递给剩余清理 Hook，并把目录交换回滚到上一份完整输出。交换前失败则通过普通错误路径进入清理阶段。

## 内置 Platform

`packages/platforms/claude-code/` 生成原生 Commands、Skills、Agents、`.claude-plugin/plugin.json` 和可选 Marketplace 分发。

`packages/platforms/codex/` 生成原生 Skills、Command 回退 Skills、Agent 回退 Skills、调用策略元数据、`.codex-plugin/plugin.json` 和可选 Marketplace 分发。生成标识按大小写不敏感方式保留；任何冲突都会显式失败。

`packages/platforms/cursor/` 生成静态 Cursor Plugin，包含原生 Commands、Skills 和 Subagents。Manifest 使用固定的完整官方 Schema Fixture 验证；模型和非只读能力损失会明确报告，不使用猜测字段。

`packages/platforms/antigravity/` 生成静态 Plugin，包含原生 Skills、Command 回退 Skills、Agent 指导 Skills 和最小公开确认的 `plugin.json`。没有确认 Manifest 字段的元数据会报告为 omitted。

`packages/platforms/opencode/` 生成 Workspace Overlay，包含原生 Commands、Skills 和 Subagents。只有配置字段或 Extension Adapter 实际需要时才生成 `opencode.json`，绝不伪造通用 Package Manifest。

`packages/platforms/pi/` 生成 npm Package，包含原生 Skills、Command Prompt Templates 和 Agent 指导 Skills。Package Manifest 只声明 Pi 发现字段，不能泄漏 `private`、`workspaces` 或私有工作区依赖。

Platform 实现包均为私有包，并由 tsdown 内联进 `@tokenroll/acplugin`。公开门面只暴露稳定的 Platform 工厂和子路径契约，不暴露私有 Serializer 或 Validator。

## 官方 Extensions

`packages/extensions/hooks/` 发现 `src/hooks/<id>/hook.ts`，验证事件、Matcher、超时和结果语义，并把每个实现只构建一次，生成平台中立的 Node 20 ESM Handler。其六个内置 Platform Adapter 为各宿主生成经过验证的静态配置或运行时集成，并逐项报告不支持/降级事件。运行时失败只使用固定错误码且不输出 payload；第三方许可说明与 Handler 相邻。

`packages/extensions/mcp/` 发现 `src/mcp/<id>/mcp.ts`。远程 HTTP 只保留公开值和环境变量引用；本地 stdio 必须提供完整 Server 代码，统一 Bundle 一次 Node 20 ESM，拒绝无法解析的动态 import，并在 development 与 production 中都于不读取 Secret 引用值的前提下通过有边界的真实 initialize/tools-list smoke。该协议检查没有 mode 或缓存跳过分支。六个平台 Adapter 只生成宿主可安装的传输：Claude Code/Codex 支持两者，Cursor/Antigravity 支持远程 HTTP，OpenCode 支持远程/本地，Pi 对两者均报告不支持。

Extension build context 以 `addWatchFile()` 作为唯一依赖登记边界。官方 bundler 通过它上报实际 Rolldown 模块图；Core 校验绝对文件身份，具体 watcher 策略与 ready 补偿仍只由 CLI 负责。

## 受管输出事务

`dist` 是一套完整的受管目标集合：

1. 获取同级独占锁；
2. 恢复遗留的备份或事务记录；
3. 在同一文件系统的阶段目录中物化所有选中目标；
4. 重新计算并验证每个 Artifact 的大小、SHA-256、权限和普通文件状态；
5. 写入事务记录，并把旧输出重命名为备份；
6. 把阶段目录重命名为正式输出，同时保留回滚边界；
7. 成功完成逆序 Platform/Extension 清理，否则执行回滚；
8. 删除事务记录，并尽力清理备份。

提交前失败不会触碰旧输出。备份或交换后失败会执行回滚。如果只有清理过程被中断，下次运行会确定性地协调输出和备份。Core 测试会在每个可观测阶段注入失败。

## CLI 与包边界

`packages/acplugin/src/index.ts` 暴露公开门面；`project-config.ts` 使用 Jiti 重新加载受信任的 TypeScript 配置和描述文件，`run-project.ts` 把解析后的工程连接到 Core。嵌套配置对象会在进入生命周期前完成运行时 Schema 检查。`cli.ts` 负责命令、JSON/文本输出纪律、退出码、监听事件合并和 Migration 延迟导入。稳定诊断会隐藏外部异常、本机绝对路径和可识别的凭据形式。

普通公开门面和 CLI 启动过程不会导入 `migration/`。主包 tarball 不包含私有包导入或私有运行时依赖；`scripts/verify-release.mjs` 会在外部消费者中验证这一点。
