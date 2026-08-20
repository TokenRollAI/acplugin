# ACPlugin 工作树交叉 Review 报告

> 审查范围：完整工作树（HEAD）
> 审查方式：只读。未编辑源码、未 stage/commit/reset/checkout、未发布或修改版本。
> 审查日期：2026-08-20

## 0. 基线核对（与预期不符，以实际为准）

| 项 | 预期 | 实际 |
|---|---|---|
| 分支 | `beta_1_0` | `beta_1_0` ✅ |
| 基线 commit | `889da32` | **HEAD = `51d6852`，比基线多 1 个 commit** |
| staged / unstaged / untracked | — | **全部为空，工作树完全干净** |

```
git status --short          → (空)
git branch --show-current   → beta_1_0
git rev-parse HEAD          → 51d68522ba6044fb60d06573491d4504688ddf56
git diff --check            → (无输出)
git diff --cached --check   → (无输出)
```

差异说明：整个重构（240 files / +11509 / −10848）实际落在 `51d6852` "feat(tests): add package boundaries tests for published packages" 这一个 commit 里，`889da32` 是它的父提交。**审查对象因此就是 HEAD 的完整树**，不存在需要单独审查的 staged/unstaged/untracked 增量。

### 全量门禁实跑结果（全部通过）

| 命令 | 结果 |
|---|---|
| `pnpm run lint`（含 `comments:check`） | ✅ exit 0 |
| `pnpm run typecheck` | ✅ exit 0 |
| `pnpm -r run test` | ✅ exit 0（跨包 17 files / 85 tests，各包合计约 150 tests，**0 skip**） |
| `pnpm run build` | ✅ exit 0 |
| `pnpm run docs:check` | ✅ exit 0 |
| `pnpm run release:verify` | ✅ exit 0 |

---

## 1. 结论摘要

**这次重构是一次真实的架构收敛，不是把复杂度摊到更多文件。** 核心证据：

- Core 的域切分（`api / compiler / config / contracts / lifecycle / output / package / project / resources / security / serialization / services`）在**文件级没有任何运行时导入环**（自建检测器扫 70 个文件，唯二两个环是 `contracts/` 内部的 `import type`，编译期擦除）。
- **生命周期确实只有一条路径**：`CLI → runProject() → createProject().run() → runKernelBuildSession()`；`Project.dev()` → `createDevSession()` 每轮也调用同一个 `runKernelBuildSession()`。没有第二条构建路径，没有绕过 Core 的分支。
- **Rolldown 只由 Core 驱动**：全仓 `rolldown` 值导入只出现在 `packages/core/src/compiler/engine-loader.ts` 与 `contracts/compiler.ts`；`chokidar` 只出现在 `packages/core/src/lifecycle/dev-session.ts`。Platform/Extension 源码零 `fs` 写入、零 bundler、零 watcher。
- **Core 零平台名分支**：`rg "claude-code|codex|cursor|antigravity|opencode|pi" packages/core/src` 无命中；Node Runtime 交付完全由 `platformSupportsNodeRuntime()` 的声明式 capability 决定（`resources/runtime/provider.ts:44-48`）。
- **Migration 隔离成立**：全仓唯一 Migration 入口是 `cli/commands/migrate.ts:34` 的 `await import('../../migration/index.js')`；构建产物中 `dist/index.mjs` 与 `dist/cli.mjs` 对 `migration` 的静态引用计数均为 0，Migration 落在独立 chunk `migration-CB1UljyK.mjs`。
- 无残留旧路径 import、无产品空目录、无 `TODO/FIXME/@ts-ignore/as any`、无 `.skip/.only`、`comment-coverage.json` 的 `enforcedFiles` 与实际文件集**逐条精确匹配**（259 条全部存在，177 个生产文件全部被覆盖）。

**但有一个 P1 级的系统性缺口**：**没有任何自动化门禁执行测试套件**。这次重构把安全网几乎全部押在架构守卫测试上（Rolldown 收敛、Chokidar 收敛、私有 Core import allowlist、`LIFECYCLE_API_VERSION`、九包边界、事务故障注入、CLI 子进程退出码），而这些测试在 CI 和 git hook 中**一次都不会跑**。

**建议合并**，但 P1-1 应在合并同批或紧随其后修复。

---

## 2. Findings

### P1-1 · 真实问题 · 没有任何自动化门禁运行测试套件

**证据**

```
.github/workflows/check.yml   : versions:check → lint → typecheck → docs:check
.github/workflows/patch.yml   : lint → typecheck
.github/workflows/verify.yml  : build → release:verify
.husky/pre-commit             : lint-staged → comments:check → typecheck
```

`rg "pnpm run test|vitest|release:preflight" .github/` → **零命中**。三个 workflow 是全部（`find . -maxdepth 3 -name "*.yml"` 已确认）。

**可复现后果**

本次重构新增/重排的全部守卫，只在有人手动跑 `pnpm run test` 时才生效：

- `packages/test/test/architecture/integration-boundaries.test.ts:31-46` 的 `directRolldownAllowlist` / `watcherAllowlist` / `privateCoreImportAllowlist`
- 同文件 `:147-151` 的 `LIFECYCLE_API_VERSION === '1'` 断言
- `packages/test/test/release/package-boundaries.test.ts` 全部九包 tarball 边界断言
- `packages/core/test/output/transaction.test.ts`（690 行事务/锁故障注入）
- `packages/test/test/cli/cli.test.ts`（子进程退出码、SIGINT=130）

也就是说：**一个把 `chokidar` 引入 Platform、或把 `@acplugin/core` 泄漏进公开 Platform 声明的 PR，可以顺利通过 CI 全绿**。这与 AGENTS.md「新增功能必须按风险补充……不得用缺少 fixture 的大面积 skip 代替验证」的意图直接冲突——测试写得很扎实，但没有被执行。

**最小修复**：在 `check.yml` 加一个 job（`test` 有 `pretest: pnpm run build`，独立 job 即可）：

```yaml
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with: { node-version: 22.18.0, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run test
```

并在 `patch.yml:124-125` 的 `lint`/`typecheck` 后补 `pnpm run test`（否则 version PR 会带着 P2-1 的失败进主干）。

**改动范围**：脚本/CI（`.github/workflows/check.yml`、`patch.yml`）。不动代码。
**测试建议**：无需新增测试；本条就是让既有测试生效。

---

### P2-1 · 真实问题 · 架构守卫测试硬编码九个包的精确版本号，且无任何同步机制

**证据**

`packages/test/test/architecture/workspace-layout.test.ts:10-17`

```ts
const platformPackages = [
  ['claude-code', '@tokenroll/acplugin-platform-claude-code', '0.0.2-beta'],
  ['codex',       '@tokenroll/acplugin-platform-codex',       '0.0.3-beta'],
  ...
] as const;
```
`:56` `expect(manifests.map(m => m.version)).toEqual(platformPackages.map(([,,v]) => v));`

同步脚本 `scripts/sync-ecosystem-versions.mjs:37-38` 只写 `packages/acplugin/src/ecosystem/versions.json`，**不触碰这个测试**。

**可复现后果**

`.changeset/pre.json` 处于 `mode: "pre"` / `tag: "beta"`，且 `.changeset/kernel-v2-sdk-boundary.md` 对全部九个公开包声明了 `major`。`version-packages`（= `changeset version && versions:sync`）执行后，九个包版本全部变化，该断言必然失败。

叠加 P1-1，这个失败**不会在任何 CI 中出现**——`patch.yml` 生成的 version PR 只跑 lint/typecheck，`check.yml` 也不跑测试。失败会推迟到某个开发者本地跑测试时才炸，且看起来像一个无关的架构守卫红灯。

**最小修复**：版本这一维已经有 `versions:check`（`check.yml:21`）保证 `versions.json` 与 manifest 一致，测试重复断言没有增量价值。二选一：

- 删除 `:56` 这一行断言与元组第三列；或
- 改为从 `packages/acplugin/src/ecosystem/versions.json` 读取期望值（保持 manifest↔snapshot 一致性断言，去掉字面量）。

推荐前者：`versions:check` 已覆盖。

**改动范围**：测试。
**测试建议**：改后跑 `pnpm --filter @acplugin/test run test`。

---

### P2-2 · 真实问题 · `lifecycle/session-scope.ts` 位置错误，造成 services ↔ lifecycle 域循环

**证据**

`services` 域有 4 个文件反向依赖 `lifecycle`：

```
packages/core/src/services/assets.ts:15          import { BuildSessionScope } from '../lifecycle/session-scope.js';
packages/core/src/services/sources.ts:11         同上
packages/core/src/services/watch.ts:3            同上
packages/core/src/services/work-directories.ts:4 同上
```

而 `lifecycle` 正向依赖 `services / output / package / resources`。按**值级**（排除 `import type`）计算的域依赖图存在 5 条环：

```
services -> compiler -> services
services -> lifecycle -> services
services -> lifecycle -> output -> services
services -> lifecycle -> output -> package -> services
services -> lifecycle -> resources -> services
```

其中后 4 条**全部且仅由这一个文件引起**。

`packages/core/src/lifecycle/session-scope.ts` 全文 28 行，**零 import**，只有一个 `#active` 布尔 + `token` + `assertActive()` + `close()`。它是 capability registry 的会话存活原语，不是生命周期编排逻辑；目录意图里 `lifecycle` 承载的是 build/dev session 编排。

**可复现后果**

不是运行时 bug（文件级无环，编译/构建正常）。后果是**目录分层不成立**：`services` 与 `lifecycle` 无法按依赖顺序理解或独立演进，任何试图给 Core 建立分层守卫（例如"services 不得依赖 lifecycle"）的静态规则都会立刻误报。这与本轮"目标目录意图"给出的域划分直接冲突——目录名承诺了分层，实际结构没有。

**最小修复**：把 `lifecycle/session-scope.ts` 整体移到 `services/session-scope.ts`（或 `security/`）。纯文件移动，零行为变化。需更新 6 处源码 import（4 个 services + `lifecycle/build-environment.ts:12` + 自身）与 17 处测试 import。移动后 `services -> lifecycle` 边消失，上述 4 条环同时消失。

**改动范围**：Core + Core 测试。
**测试建议**：移动后重跑 `pnpm --filter @acplugin/core run test`；可选地在 `integration-boundaries.test.ts` 增加一条"`packages/core/src/services/**` 不得 import `../lifecycle/`"的守卫，把这个不变量钉住。

---

### P3-1 · 真实问题（建议不修，改为显式记录）· services ↔ compiler 域循环

**证据**

```
services/modules.ts:12-14  → compiler/engine-loader.js, compiler/managed/boundary.js, compiler/portable-node/policy.js
compiler/compiler-service.ts:13,15,16,17 → services/assets.js, sources.js, watch.js, work-directories.js
compiler/job-normalizer.ts:12            → services/sources.js
```

**性质**：这是真实的双向域依赖，且不像 P2-2 那样能靠移一个文件解决。根因是 `ModuleHost`（`services/modules.ts`，318 行）本身就是一个 Rolldown 驱动的加载器，它在概念上属于 compiler 层；而 `CompilerHost` 需要 Asset/Source/Watch/WorkDirectory 服务来签发受管产物。

**建议不修的理由**：文件级仍然无环，行为正确，测试完整（`module-host.test.ts` 188 行 + `compiler-managed.test.ts` 614 行）。真正的修法是把 `services/modules.ts` 归入 `compiler/`，属于又一次目录搬迁，收益是分层纯度、成本是再一轮 import 扰动与 review。**在 P2-2 之后单独评估**，或直接在 ADR 里写明"compiler 与 services 是同层互依的两个 Core 服务域，不构成分层"，消除目录名带来的错误预期。

**改动范围**：（若修）Core + 测试；（若不修）文档/ADR。

---

### P3-2 · 误报（已证伪）· 两个键排序比较器共存，但对输出字节不可观测

**证据**

```
packages/core/src/security/json-snapshot.ts:109   Object.keys(descriptors).sort(compareCodeUnits)     // UTF-16 code unit
packages/core/src/package/json-snapshot.ts:74     entries.sort(([l],[r]) => compareCodePoints(l, r))  // Unicode code point
```

两者对含星光平面字符（代理对）的键会给出**不同顺序**。

**证伪过程**：`addDocumentField()`（code-point 排序）的结果最终一定经过 `encodePackageDocument()`（`package/documents.ts:64`），后者无条件 `snapshotJson(document.value, ...)` **重新按 code unit 排序**再序列化。因此 `addDocumentField` 的内存顺序不进入任何输出字节、哈希或报告。`stableJson`（`serialization/json.ts:28`）同样用 code unit。

**判定：不是确定性 bug，无需修复。** 若要做一致性清理，最小改动是让 `addDocumentField` 也用 `compareCodeUnits`（`package/json-snapshot.ts:74`），一行。属可选。

---

### P3-3 · 真实问题 · Core 内保留了 3 处纯转发 re-export

**证据**

```
packages/core/src/lifecycle/build-session.ts:48-52   re-export createKernelBuildEnvironment / disposeKernelBuildEnvironment / KernelBuildEnvironment（来自 ./build-environment.js）
packages/core/src/package/json-snapshot.ts:10        export { snapshotJson }（来自 ../security/json-snapshot.js）
packages/core/src/output/transaction.ts:24           export type { ManagedOutputScope }（来自 ./transaction-files.js）
```

**后果**：这三处存在的唯一作用是让拆分前的 import 路径继续可用（`project/project.ts:20-25` 与 `dev-session.ts:15-20` 仍从 `build-session.js` 取 environment 函数）。AGENTS.md 明确"当前 beta 允许 breaking change，不需要保留旧架构兼容层或 shim"。这也是"拆文件后靠转发维持旧引用"这一反模式的典型形态——虽然规模极小（3 处）。

**最小修复**：把 3 个消费点改为直接从真实模块导入，删掉转发行。

**改动范围**：Core（约 5 行 import 调整）。
**测试建议**：typecheck 即可覆盖。

---

### P3-4 · 真实问题（可选） · `cli/output.ts` 为一个错误类反向依赖 `scaffolding/`

**证据**

`packages/acplugin/src/cli/output.ts:7` `import { InitError } from '../scaffolding/init.js';`，仅用于 `:79-80` 的一个 `instanceof` 分支。

`output.ts` 被全部 6 个 CLI 命令模块引用（build / dev / init / inspect / migrate / validate / pipeline），而 `scaffolding/init.ts` 静态拉入 `node:child_process` 与 `scaffolding/prompts.ts` → `@inquirer/prompts`。

**后果**：共享的展示层反向依赖一个 feature 模块。**没有实际运行时代价**——`packages/acplugin/src/index.ts:13` 本来就导出 `initializeProject`，`cli/program.ts:3` 又从 `index.js` 取 `ACPLUGIN_VERSION`，交互栈无论如何都会进入图（已在 `dist/src-*.mjs` 同一 chunk 中验证）。因此这是**纯分层问题，不是性能或体积问题**。

**最小修复**：让 `cli/commands/init.ts` 自己 catch `InitError` 并构造诊断，`output.ts` 只保留 `ProjectConfigError` 分支；或把 `InitError` 下沉到 `cli/` 共享位置。

**改动范围**：主包。**建议**：可选，优先级低于 P1/P2。

---

### P3-5 · 真实问题（可选） · Migration 从最宽的 `@acplugin/core` 根 barrel 导入

**证据**

`packages/acplugin/src/migration/validation.ts:8-14` 从 `@acplugin/core` 根导入 `defineExtension / definePlatform / stableJson / Diagnostic / PluginMetadata`——这五个符号全部可从更窄的 `@acplugin/core/integration`（前三个，见 `api/integration.ts:1-9,122-126`）与 `@acplugin/core/author`（后两个）取得。根 barrel `core/src/index.ts` 是 9 个 `export *`，包含 `runKernelBuildSession`、`commitPackageUnits`、`CompilerHost` 等全部内部实现。

对比：`author/project.ts:1-5` 同样用根 barrel，但那是**必要的**（`createKernelProject` / `runKernelProject` 不在 `/author` 上）。

**后果**：打包后被 tree-shake（migration chunk 只从共享 chunk 取 6 个符号，已验证），**无运行时后果**。只是让隔离子系统与 Core 私有实现之间保留了一条比必要更宽的类型/值面。

**最小修复**：`validation.ts` 改用 `@acplugin/core/integration` + `@acplugin/core/author`。**建议**：可选。

---

### P3-6 · 真实问题（文档） · `llmdoc/state/sync.md` 描述的仓库状态已失效

**证据**

- `llmdoc/state/sync.md` 第 3 行 Baseline 记为 `889da32`，实际 HEAD 为 `51d6852`。
- 同段 Workflow 声明 *"All changes remain local and uncommitted"* ——实际工作树完全干净，全部改动已提交。

**后果**：这是本轮审查被指定必读的"同步状态"文档。它现在会让下一个读者相信仍有未提交改动，从而做出错误的取舍（例如认为 `git stash`/`reset` 是安全的）。

**最小修复**：更新 baseline 为 `51d6852`，把 Workflow 一行改为"已提交到 `beta_1_0`，未 push / 未发布 / 未打 Tag"。

**改动范围**：文档。**测试建议**：无。

---

## 3. 误报与"不应实现"清单

以下都是我在审查中提出、**并逐条证伪**的疑点，明确判定为不需要修改：

| # | 疑点 | 证伪依据 | 判定 |
|---|---|---|---|
| 1 | `contracts/` 存在导入环（`integrations↔config`、`integrations↔packages`） | `config.ts:1-3`、`packages.ts:1-19` 全部是 `import type`，编译期擦除；文件级值导入无环 | 误报 |
| 2 | 主包 dist 在多个 chunk 中重复打包 Core（`definitions-*.mjs` 254KB + `src-*.mjs` 562KB） | 实际共享：`src-*.mjs` → `definitions-*.mjs`；`migration-*.mjs` → 两者；`sdk.mjs` → definitions；`index.mjs`/`cli.mjs` → src。首次 grep 模式漏了 `from "` 的空格 | 误报 |
| 3 | `packages/test/test/migration.test.ts` 未随其他测试进子目录 | AGENTS.md:122 明确指定该路径 | 误报 |
| 4 | 源码中的 "Kernel v2" / "Schema v2" 是已删模块的残留术语 | `report-builder.ts:125` 实际 `schemaVersion: 2`；`Kernel*` 是当前内部命名（`runKernelBuildSession` 等），不指向任何已删文件。属命名偏好，按要求不报告 | 误报 |
| 5 | `FAILURE_PHASE_ORDER`（`integration-sessions.ts:69-72`）可能漏 phase → `indexOf` 返回 −1 破坏排序 | 与 `contracts/reports.ts:103` 的 `DiagnosticPhase` 15 个成员逐一对应，无缺失 | 误报 |
| 6 | `LEGACY_LOCK_STABILITY_DELAY_MS`（`output/lock.ts:50,299`）是 beta 禁止的兼容 shim | 它是针对任何 create→write 非原子 writer 的有界观察窗，且被 `transaction.test.ts:600` "preserves a malformed legacy lock that becomes a live record during the bounded check" 精确覆盖 | **不应删除** |
| 7 | `output/lock.ts`（429 行，双层 guard + quarantine + PID 存活）属于"应整体重写"的局部 | 复杂度确实高，但每条分支都有故障注入覆盖：stale quarantine (`:387-415`)、malformed record (`:586`)、guard 竞争 (`:633-637`)、瞬时 close/rm 失败 (`:112-208`)。重写并发原语的风险远高于收益 | **不应重写** |
| 8 | `dev-session.ts:356` `runRound(_changes)` 参数完全未使用 | dev 每轮做完整确定性重建是既定设计（sync.md 已述），非遗漏 | 误报 |
| 9 | `llmdoc` / `.agents` 引用了已删路径（脚本报 29 处 MISSING） | 全部是 glob 模式（`packages/platforms/*`）或 core-src 相对路径（`lifecycle/build-session.ts`）；逐条解析后全部存在 | 误报 |
| 10 | `platformSucceeded` + `diagnostics.some(...)` 双重判断冗余（`build-session.ts:497`） | 非冗余：`platformSucceeded` 在 compatibility 阶段写入，之后 materialize/transaction 仍可能追加该平台诊断 | 误报 |

---

## 4. 逐条回答重点审查问题

**1. 是否真的降低了认知复杂度？** 是。生产源码 27.9k 行（Core 14.0k / 主包 4.3k / Platform 6.3k / Extension 3.2k），测试 14.6k 行。核心证据不是文件数，而是**依赖方向**：文件级零运行时环；`build-session.ts` 从 1077 行降到 556 行，把 Platform 流水线（`platform-pipeline.ts` 310）、Session 契约校验（`integration-sessions.ts` 254）、环境构造（`build-environment.ts` 66）拆成职责明确、单向被调用的模块，且拆分后只留了 3 处转发 shim（P3-3）。Platform 大 validator 按协议域拆分（codex 8 个、claude-code 6 个）也是真实的领域切分，不是机械切片。

**2. Core 领域边界 / 依赖方向 / 公私 API？** 文件级一致，**目录级有 2 组环**（P2-2、P3-1）。公私 API 干净：SDK (`api/integration.ts`) 用**显式具名列表**导出 110 个类型 + 8 个值，零 Registry / 零 Kernel 实现泄漏；`core/src/index.ts` 虽是 9 个 `export *`，但它是私有包且只被主包内联，主包公开面 (`acplugin/src/index.ts:37-82`) 又是显式列表，过宽 barrel 被两层收敛住。无错误 barrel。

**3. 生命周期是否只有一条真实路径？** 是。`runProject()` 是 `createProject().run()` 的无逻辑 convenience（`project/project.ts:213-220`）；CLI 的 validate/inspect/build 全部走 `runPipeline()` → `runProject()`（`cli/commands/pipeline.ts:15`）；`dev` 走 `createProject().dev()` → `createDevSession()`，其 `runRound()` 每轮调 `runKernelBuildSession()`（`dev-session.ts:368`）。不存在第二条构建路径或绕过 Core 的分支。

**4. Rolldown 是否仍只由 Core 驱动？** 是，且有守卫。`integration-boundaries.test.ts:31-39` 把 Rolldown 锁死在 `compiler/engine-loader.ts` + `contracts/compiler.ts`，Chokidar 锁死在 `lifecycle/dev-session.ts`。Extension 通过 `context.compiler.compile()` 使用 Core（`hooks/src/build.ts:40`、`mcp/src/build.ts`），Platform/Extension 源码零 `fs` 写入、零 workDir、零 dist、零 license 管线。**唯一缺陷是这些守卫不在 CI 中运行（P1-1）。**

**5. Runtime / Hooks / MCP / Contribution 的 owner、Asset、兼容性、事务边界？** 未被破坏。Runtime 由 Core 以 `framework:node-runtime` owner 编译**一次**（`build-session.ts:378-386`），仅向声明精确 capability 的平台显式 `assets.grant()` 继承同一 `GeneratedAssetRef`（`platform-pipeline.ts:76-81`）。Contribution merge 严格 add-only：只能写入 base 声明的精确 extension point，双 owner 抢同一 point 直接抛错，重复 compatibility tuple 直接抛错，owner 排序保证与完成顺序无关（`package/registry.ts:277-367`）。事务边界完好：`afterSwap` 内关闭 Session，失败仍可回滚（`output/transaction.ts:140-154` + `build-session.ts:459-466`）。目录结构上 Hooks 有 `runtime/{runner,wire,integration}.ts`，MCP **没有**空 runtime 层 —— 符合目标意图。

**6. Migration 是否仍 lazy 隔离？** 是。唯一入口 `cli/commands/migrate.ts:34` 的动态 import；`dist/index.mjs` 与 `dist/cli.mjs` 对 migration 的静态引用为 0；独立 chunk。唯一瑕疵是 P3-5（用了最宽的根 barrel，但被 tree-shake，无实际后果）。

**7. 包边界 / 产物 / peer / SDK subpath / clean-consumer？** 正确，且被三层验证：`workspace-layout.test.ts`（九包、`peerDependencies['@tokenroll/acplugin'] === 'workspace:^'`、无 `@acplugin/*` runtime dep）、`package-boundaries.test.ts`（dist 产物文本扫描 + 真实 `import()` 校验导出面 + `import("rolldown")` 必须是动态）、`release:verify` 实跑九个 tarball 的 clean consumer（已通过）。`exports` 精确为 `['.', './sdk']`。

**8. 测试重组是否丢覆盖 / 错 fixture / 漏 Vitest / 守卫失效？** 未丢。所有守卫路径已同步更新到新目录（`integration-boundaries.test.ts:32-33,38,43-45,149` 全部指向新路径且断言通过）。fixture 路径 `packages/test/fixtures/migration/claude-project/` 存在。**0 个 skip/only**。Extension 巨型测试拆分后（hooks 974→4 文件 15 tests，mcp 644→4 文件 12 tests）用例数与断言密度合理。唯一问题是 P2-1（版本字面量）与 P1-1（不在 CI 跑）。

**9. 文档 / 技能 / 脚本 / comment coverage / TypeDoc / release verification 是否指向已删模块？** 全部正确。`typedoc.json` 用 `entryPoints: src/index.ts` per package；`verify-release.mjs`、`verify-docs.mjs`、`public-packages.mjs` 路径全部有效；`comment-coverage.json` 259 条 `enforcedFiles` 逐条存在且完整覆盖 177 个生产文件；`llmdoc`/`.agents` 路径引用全部解析成功。**唯一过期的是 `llmdoc/state/sync.md` 的仓库状态描述（P3-6）。**

**10. 是否存在应该整体重写的局部？** **没有。** 我最认真评估的候选是 `output/lock.ts`（429 行、双层互斥、quarantine + 回滚、PID 存活探测、legacy 窗口）。结论是**不应重写**：每条分支都有针对性的故障注入测试（见误报表 #6/#7），且并发原语重写的回归风险显著高于当前的可读性收益。其余局部（`compiler/managed/options.ts` 508、`config/resolver.ts` 559、`services/assets.ts` 531）都是"边界校验密集但线性、可读、有测试"的形态，属于合理体量。

---

## 5. 真实问题清单（按优先级）

| # | 优先级 | 问题 | 范围 |
|---|---|---|---|
| P1-1 | **P1** | 没有任何 CI/hook 运行测试套件，全部架构守卫不生效 | 脚本/CI |
| P2-1 | P2 | `workspace-layout.test.ts` 硬编码九包版本，无同步机制，下次 `changeset version` 必失败 | 测试 |
| P2-2 | P2 | `lifecycle/session-scope.ts` 位置错误，制造 4 条 services↔lifecycle 域循环 | Core + 测试 |
| P3-1 | P3 | services ↔ compiler 域循环（建议记录为 ADR，不修） | 文档 / (Core) |
| P3-3 | P3 | Core 内 3 处纯转发 re-export shim | Core |
| P3-4 | P3 | `cli/output.ts` 为一个错误类反向依赖 `scaffolding/` | 主包 |
| P3-5 | P3 | `migration/validation.ts` 使用最宽的 `@acplugin/core` 根 barrel | 主包 |
| P3-6 | P3 | `llmdoc/state/sync.md` 的 baseline 与"未提交"描述已过期 | 文档 |

（P3-2 已归入误报表：不是确定性 bug，一行可选清理。）

---

## 6. 合并建议

**建议合并当前工作树。**

理由：六个门禁全部实跑通过；架构不变量（单生命周期、Rolldown/Chokidar 归 Core、Core 零平台分支、add-only Contribution、Migration 隔离、九包边界、`LIFECYCLE_API_VERSION='1'`）逐条以源码与产物证据确认成立；无残留旧路径、无空目录、无 skip、无 `any`/`ts-ignore`。已发现的问题**没有一条是运行时正确性缺陷**——最高优先级的 P1-1 是流程缺口，P2 两条是可维护性缺口。

### 最小修复顺序（按依赖）

1. **P1-1** — 先给 CI 加 `test` job（`check.yml` + `patch.yml`）。必须最先做：它决定后面每一条改动是否会被自动验证。
2. **P2-1** — 删除/改写 `workspace-layout.test.ts` 的版本字面量断言。必须在 P1-1 之后、任何 `changeset version` 之前，否则第一次带测试的 CI 就红。
3. **P2-2** — `lifecycle/session-scope.ts` → `services/session-scope.ts`（纯移动 + 23 处 import），可选补一条分层守卫。此时 P1-1 已生效，移动有网。
4. **P3-6** — 更新 `llmdoc/state/sync.md`（零风险，可与任意一步同批）。
5. **P3-3 / P3-4 / P3-5 / P3-1** — 可选清理，任意顺序，或作为后续 PR。

---

## 7. 对"是否过度设计 / 过度拆分 / 偏离 Nuxt 式框架初衷"的最终判断

**没有过度设计，没有过度拆分，也没有偏离初衷。**

- **框架仍然拥有构建能力**，这一点是本轮最关键的成功项。Core 独占 Rolldown（`engine-loader.ts` 是全仓唯一驱动点）、独占 Chokidar、独占 workDir/dist/事务/许可证/Asset 签发；Platform 与 Extension 只能通过 `context.compiler.compile()`、`assets.service(owner)`、`sources.service(owner)` 拿到 owner 受限的能力句柄，拿不到物理路径也拿不到写权限。Extension 是真正的无序 add-only 横向能力：无依赖图、无跨 Extension state、无 override/delete，冲突确定性失败。这就是 Nuxt 式"框架拥有构建、模块只做贡献"的形态，而且比大多数实现更严格。

- **拆分是有依据的，不是切片**。判断标准是拆完之后依赖是否变单向、是否需要转发 shim 维系旧引用。这里文件级零环、只留 3 处极小转发（P3-3），Platform 大 validator 是按协议域（hooks / mcp / manifest / marketplace / skills / assets）而非按行数拆的。相比之下，`build-session.ts` 1077→556 行同时把状态机保持在**一个函数**里而没有拆成 12 个 stage 类——这恰恰是克制的证据。

- **真正的复杂度集中在正确的地方**：安全边界（`security/`：data-boundary、path-policy、json-snapshot、report-safety）、确定性（稳定排序、owner 排序、无时间戳/绝对路径）、事务与锁。这些是框架必须承担、消费者不该重复实现的部分，与"持续使用的构建框架而非一次性脚手架"的定位一致。

- **唯一的结构性缺口是目录名承诺的分层没有完全兑现**（P2-2、P3-1）。这不是过度设计，是分层不彻底——P2-2 一个文件移动就能消掉四分之三。

- **最需要修的不是代码，是流程**。这套架构的长期可维护性完全建立在架构守卫测试上，而这些测试目前不在任何自动化门禁中运行（P1-1）。**架构守得住不取决于它写得多好，取决于它跑不跑。** 这是本次 review 唯一的 P1。
