# 整体结论

一句话结论：**不建议合并**；finalization 的字段路径未经过既有无行为数据边界，实际会执行 getter 并接受稀疏数组，违反严格输入与确定性契约。

## 范围与证据

- 分支：`beta_1_0`
- HEAD / 基线：均为 `1c169af33cf4e091a1363883a12a817b2b7aed77`
- 改动：66 个已暂存文件，`+2129/-162`；无 unstaged、无 untracked。
- 已执行且通过：`git diff --check`、`git diff --cached --check`、`pnpm run lint`、`pnpm run typecheck`、`pnpm run test`、`pnpm run build`、`pnpm run docs:check`、`pnpm run versions:check`。
- 测试中包括 Core `26 files / 166 tests`、跨包集成 `17 files / 91 tests`；构建的 `attw`、`publint` 通过。
- `pnpm changeset status` 显示 9 个公开包均为 major，和 Changeset 覆盖范围一致。
- 最终复查工作树与 diff 检查仍保持上述状态。

## Findings

### P0

未发现。

### P1

#### finalization 字段路径会执行 getter，并接受稀疏数组

- 严重级别：P1
- 证据：
  - `packages/core/src/package/json-snapshot.ts:15` 用 `Array.isArray`、`.some()` 和展开运算符读取未受信任路径，没有使用既有的严格数组边界。
  - 新增的 `finalizationPoints` 经 `packages/core/src/package/registry.ts:147` → `packages/core/src/package/registry.ts:105` → `snapshotFieldPath()` 进入该缺口。
  - Platform finalizer 返回的 `documentFields.path` 也经 `packages/core/src/package/registry.ts:482` 进入同一缺口。
  - 对比既有正确边界：`packages/core/src/security/data-boundary.ts:41` 会拒绝 getter、稀疏数组、Symbol、自定义字段和非标准 Array prototype。
- 可复现方式：
  - 传入下列路径作为 Platform `createPackage()` 的 `finalizationPoints` 元素，或作为 `finalizePackage().documentFields[].path`：
    ```ts
    let reads = 0
    const path: string[] = []
    Object.defineProperty(path, '0', {
      enumerable: true,
      get() {
        reads += 1
        return 'agents'
      },
    })
    path.length = 1
    ```
  - 对实际构建产物中的同一函数验证，结果为 `["agents"]`，且 `reads === 2`；getter 已在 Core 校验期间执行。
  - `const path: string[] = []; path.length = 1` 也会被接受并快照成 `[undefined]`。若 base point 和 finalization field 都使用该值，后续 `addDocumentField()` 会把字段写成 `"undefined"`。
- 为什么它是实际问题，而非偏好：
  - 规格要求严格 JSON/无行为边界，且 finalization 必须仅操作稳定、精确的预声明空字段。这里 Core 在“验证”时执行了集成方行为，稀疏路径还能绕过“string segment”判断，破坏 deterministic validation 和 add-only 字段契约。
  - 这不是 Asset/provenance 越权，但它是新 finalization surface 直接可达的输入验证缺陷。
- 最小修复方案：
  - 在 `snapshotFieldPath()` 先调用 `dataArrayItems(value, label)`，再对返回的密集快照检查非空和字符串 segment，冻结该安全副本。
- 修复风险与需要补的测试：
  - 风险低；仅会拒绝原本就不符合 SDK `DocumentFieldPath` 契约的数组。
  - 覆盖 base `extensionPoints`、新增 `finalizationPoints`、Extension `documentFields.path`、Platform `documentFields.path` 的 getter、稀疏数组、Symbol、自定义字段、修改 prototype 情况；断言 getter 从未执行。

### P2

#### 新增 Component API 没有经过真实 tarball 的类型消费者验证

- 严重级别：P2
- 证据：
  - `packages/test/test/platforms/native-component-contribution.test.ts:144` 手工复制 workspace `dist/*.mjs` 并合成 package.json；该代理不包含 `.d.mts`，也不经过 `pnpm pack`。
  - 该测试的配置在 `packages/test/test/platforms/native-component-contribution.test.ts:194` 作为运行时源码加载，并未在干净消费者中编译新的官方 payload 泛型。
  - 现有真实 pack 测试的第三方声明仅验证旧的 `AcpluginPlatform` / `AcpluginExtension` 外形：`packages/test/test/api/sdk-package-boundary.test.ts:126`；其运行时贡献仍是 `documentFields/assets`，未使用 `components` 或 `FinalizationAssetService`：`packages/test/test/api/sdk-package-boundary.test.ts:141`。
- 可复现方式：
  - 对主包以及 Claude/Cursor/OpenCode 包执行 `pnpm pack`，在 workspace 外只安装 tarball；用 `tsc` 编译一个从官方 Platform 根入口导入 `*PackageComponent`、从 `@tokenroll/acplugin/sdk` 导入 `PlatformContributor`/`FinalizationAssetService` 的第三方 Extension，再运行一次 build。
  - 当前测试集没有执行此路径。
- 为什么它是实际问题，而非偏好：
  - 规格 §8.3 明确要求“官方公开 SDK type declarations 与 packed public package 边界”。当前 runtime proxy 已很好地覆盖真实 `.mjs` 行为，但无法证明 tarball 的 declarations、exports、peer rewrite 与新泛型在干净消费者中共同可用。
- 最小修复方案：
  - 扩展现有 `sdk-package-boundary`：打包主包及三个人支持 Component 的官方 Platform；在外部 consumer 中运行 `tsc` 和一次真实 build。
- 修复风险与需要补的测试：
  - 仅增加测试时间和 fixture 维护；能捕获 declarations/export map/peer dependency 在发布边界的回归。

### 建议

未发现需要单独跟踪的纯可维护性建议。

## 架构评价

- Core 边界：符合。新增 Core 代码仅处理 opaque JSON、排序、origin identity、Asset/provenance 和 finalization point；未引入 Claude/Cursor/OpenCode、平台路径或私有 Agent wire model。Core 内既有 canonical Agent 语义不属于本次倒灌。
- 是否过度设计：否。`WeakMap` origin registry、回调后立即撤销的 `FinalizationAssetService`、只写预声明空位的 finalization point，都是阻断伪造 provenance、跨 session/platform 重用和 Manifest 越权所需的最小安全边界。
- 不必要复杂度：未发现双生命周期、旧 renderer、旧输出路径或为兼容首版遗留的 shim。
- 不应简化的部分：不要删除 scoped asset service、object-identity provenance、Core codec 的 Document 最终签发，或 deterministic owner/value 排序。
- 最小重构方向：只修复 P1 的路径快照边界并补测试；不应为此引入 Slot、registry、Extension 排序/依赖、raw Manifest patch 或 Core Agent 类型。

## 规格符合性矩阵

| 规格主题 | 状态 | 证据 | 缺口/风险 |
| --- | --- | --- | --- |
| Component strict JSON、subject、深冻、排序 | 符合 | `componentSnapshot()` + `snapshotJson()` | 无 |
| Core payload 不透明 | 符合 | Core 仅 snapshot/sort，不读取 payload 字段 | 无 |
| provenance 防伪与 scope | 符合 | WeakMap、finalization scope、回调后 close | 无 |
| finalization 空位及不与 Extension point 重叠 | 部分符合 | 点位/overlap/claim 逻辑正确 | P1：字段路径输入不严格 |
| Agent case/NFC collision | 符合 | 三个平台各自 collision key 与测试 | 无 |
| Claude/Cursor/OpenCode 原生交付 | 符合 | 各自 parser、renderer、finalize 与平台测试 | 无 |
| Codex/Antigravity/Pi 非空拒绝 | 符合 | 各自 `finalizePackage()` 显式失败及集成测试 | 无 |
| Claude Marketplace 继承 | 符合 | Marketplace 使用已验证 primary AssetRef；测试校验 hash/owner/mode/origin | 无 |
| 无 contribution 的既有行为 | 符合 | 现有平台套件、全量回归与条件化 finalization | 无 |
| Report v3、API version `'1'` | 符合 | `schemaVersion: 3`，`LIFECYCLE_API_VERSION === '1'` | 无 |
| Docs/README/matrix/Changeset | 符合 | 文档、转换矩阵、两份 Changeset 与实际平台行为一致 | 无 |
| packed consumer 边界 | 部分符合 | 已有 runtime dist proxy 与旧 SDK tarball 测试 | P2：新 API 未在 clean tarball 类型消费者覆盖 |

## 测试评价

- 已证明：Core payload snapshot/排序/subject 覆盖；origin 伪造与 scope 撤销；finalization point 的常规 add-only 约束；Claude/Cursor/OpenCode 渲染、collision、Manifest；三个不支持平台的显式拒绝；Claude Marketplace inheritance；inspect、失败保留旧输出、DevSession rebuild、确定性和全量质量门。
- 尚未证明但规格要求：新增 SDK 泛型、官方 Platform payload declarations、`FinalizationAssetService` 在真实 packed consumer 的联合类型与运行时边界（P2）。
- 可能产生假阳性的边界：native contribution 集成测试避免了 Vitest alias，并运行真实 `dist`，这是有效证据；但它的手工 runtime proxy 不等价于 tarball 的 `.d.mts`、exports 和 peer dependency 改写。

## 最终建议

- 合并前必须修复：P1 严格字段路径边界及其四条调用路径测试。
- 应在宣布本轮规格完成前补齐：P2 的 clean tarball TypeScript consumer 测试。
- 明确不建议做：不要用新增 Slot/registry/排序依赖/raw Manifest patch 解决该问题；也不要移除 scoped provenance 或让 Core 引入平台 Agent 业务类型。
