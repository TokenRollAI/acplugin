# ACPlugin 整体架构与实现正确性交叉 Review

> 审查方式：只读审查；除按要求写入本报告外，未编辑产品源码、配置或测试，未执行 stage/commit/reset/checkout、发布或版本修改。
>
> 审查日期：2026-08-20

## 结论摘要

**建议合并当前产品重构。** 未发现具备直接代码证据和可复现后果的 P0–P3 真实问题，也未发现需要整体重写的局部。

这次重构是职责收敛，而不是仅将复杂度摊到更多文件：生命周期、编译、资源授权、贡献合并和事务都落在 Core 的明确领域边界；Platform/Extension 未重新获得构建、watch、`dist` 或事务控制权。未发现第二条构建路径、运行时循环依赖、旧架构残留 import 或公开包边界泄漏。

## 基线与工作树

| 项目 | 预期 / 结果 |
| --- | --- |
| 分支 | `beta_1_0`，符合预期 |
| 指定基线 | `889da323a73d0016870390be32f82cc0c79c6a00` |
| 实际 HEAD | `51d68522ba6044fb60d06573491d4504688ddf56` |
| 与基线差异 | HEAD 比基线多 1 个提交；基线是 HEAD 的祖先；差异为 240 files、`+11509/-10848` |
| 审查开始时 | staged / unstaged / untracked 均为空 |
| 报告落盘前最终复核 | 仅 `review1.md`、`review2.md` 有外部文档改动；无 staged、无 untracked |

已执行的必做核验：

```text
git status --short
git branch --show-current
git rev-parse HEAD
git diff --check
git diff --cached --check
rg --files
```

两种 `git diff --check` 均通过。审查期间的 `review1.md` / `review2.md` 变动属于审查文档，不属于产品源码、构建配置或测试改动；历史文档中的断言未被直接采信，均以当前源码和实际门禁重新核验。

以下门禁均实际通过：

```text
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run docs:check
pnpm run release:verify
```

`release:verify` 实际覆盖九个公开 tarball、发布/类型边界和 clean-consumer。

## Findings

### 真实问题

无。P0 / P1 / P2 / P3 均为 0。

因此不存在需要提供最小修复、受影响包或回归测试的真实 finding。

## 重点核验与证据

- **唯一生命周期路径成立。** 主包 [`runProject()`](packages/acplugin/src/author/project.ts:22) 委托 Core；[`Project.run()`](packages/core/src/project/project.ts:184) 汇聚到唯一 [`runKernelBuildSession()`](packages/core/src/lifecycle/build-session.ts:103)；[`Project.dev()`](packages/core/src/project/project.ts:198) 仅创建 Core DevSession，后者每轮继续调用同一 BuildSession。CLI pipeline 也只调用 `runProject()`，没有平行构建路径或绕过 Core 的路径。

- **Rolldown、watch 与事务由 Core 独占。** 全仓 `rolldown` 运行时导入仅在 Core compiler driver，`chokidar` 仅在 [`dev-session.ts`](packages/core/src/lifecycle/dev-session.ts:4)。Platform/Extension 生产源码未发现直接 bundler、watcher、`dist` 写入或私有 Core runtime 依赖。事务入口集中在 [`output/transaction.ts`](packages/core/src/output/transaction.ts:59)。

- **Runtime 的 owner 与单次构建正确。** [`buildNodeRuntime()`](packages/core/src/resources/runtime/provider.ts:50) 使用 Core `portable-node` Compiler Service；[`platformSupportsNodeRuntime()`](packages/core/src/resources/runtime/provider.ts:44) 仅接受 plugin-local Node 20 ESM capability。Runtime 没有被重新包装成 Extension、descriptor 或 Manifest patch。

- **Extension 仍为无序、add-only 能力。** [`collectExtensionContributions()`](packages/core/src/resources/extensions.ts:314) 让 Contributor 并行读取同一 frozen base snapshot，且不暴露跨 Extension state；[`mergePackageContributions()`](packages/core/src/package/registry.ts:277) 按 owner 稳定排序，拒绝 owner/path/extension-point 冲突。

- **Migration 保持 lazy 隔离。** 正常启动图唯一入口是 migrate command action 的动态导入：[ `migrate.ts:34`](packages/acplugin/src/cli/commands/migrate.ts:34)。正常主入口未静态导入 Migration；产物将其保留为独立 chunk。

- **公开包与 SDK 边界正确。** 主包仅公开 `.` 与 `/sdk`，私有 Core 被 bundle；官方 Platform/Extension 保持 peer + SDK 契约。发布边界测试明确检查主包不 bundle/re-export 官方集成且不泄漏 `@acplugin/*`：[ `package-boundaries.test.ts:72`](packages/test/test/release/package-boundaries.test.ts:72)。

- **测试重组未发现覆盖丢失。** 跨包 Vitest alias 已转向新领域目录：[ `packages/test/vitest.config.ts:14`](packages/test/vitest.config.ts:14)。全量测试、架构守卫、文档检查和发布验证均通过；comment coverage 中 259 个受约束文件均存在。

- **Core import graph 没有运行时 cycle。** 静态扫描中唯一 SCC 位于 contracts 类型层，相关边均为 `import type`，运行时会擦除；类型检查已经通过，不能作为循环依赖 finding。

- **旧路径和长期 shim 未残留。** 对已删除的 `kernel/`、旧 provider、旧 Platform 根实现、旧 Hook runtime 路径进行了 import 搜索；未发现产品导入残留，也未发现新领域目录中的产品源码空目录。

## 误报或不应实现

| 疑点 | 判定 | 理由 |
| --- | --- | --- |
| Platform validator 使用 `node:fs` | 误报 | 只读取 Core 物化的候选目录做最终校验，不等于获得 workDir 或 `dist` 写权限。 |
| Migration 内部使用 Core | 误报 | Migration 是 lazy chunk；禁止的是正常 CLI/Core/Platform/Extension 静态依赖 Migration，未发现该反向依赖。 |
| Core 根 export 较宽 | 不应修改 | Core 是私有 workspace 包；对外 Integration 面由主包 `/sdk` 限制，tarball 与 clean-consumer 已验证。 |
| Contracts 的 type-only SCC | 误报 | 不存在运行时初始化环，且无类型、构建或行为故障。 |
| Check workflow 未跑完整测试 | 不应作为本轮 finding | `AGENTS.md` 明确规定 Check 运行 lint/typecheck，docs 为独立 job；不能以不同流程偏好否定既定发布流程。 |
| 历史 `kernel` 术语、测试临时目录前缀 | 不应实现 | 不构成产品 import、启动路径或维护边界残留；不应为此恢复旧目录或增加 shim。 |

## 合并建议与修复顺序

1. **真实问题清单：** 无。
2. **误报或不应实现清单：** 见上节。
3. **是否建议合并当前工作树：** 建议合并当前产品重构。
4. **若不建议的最小修复顺序：** 不适用；无阻断修复项。
5. **审查文档说明：** 合并前请单独确认 `review1.md` 和本 `review2.md` 是否应纳入提交；它们不影响产品重构正确性。

## 对复杂度与架构初衷的最终判断

没有证据表明本次重构属于过度设计或过度拆分。文件数的增加对应可验证的真实不变量：跨平台协议、Asset owner 隔离、Extension add-only 合并、Runtime 单次构建、完整输出事务和 watch 恢复，不能由简单 bundler wrapper 自然保证。

它没有偏离“Nuxt 式框架核心拥有构建能力”的初衷：Core 仍拥有完整生命周期、Rolldown、Module/Compiler/Execution/Watch、Asset、Package merge、事务和报告；Platform 只承担目标协议转换与最终候选校验；Extension 保持横向、无序、add-only。当前无需整体重写，也不应为表面统一重新引入 Platform 通用 wire 层、Extension 依赖图或 Runtime Extension 抽象。
