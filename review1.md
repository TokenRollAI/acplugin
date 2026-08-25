# ACPlugin Platform Component Contribution — 独立只读架构与实现 Review

> 评审日期：2026-08-25
> 仓库：`/Users/zhaozhibin/WorkSpace/acplugin`
> 分支：`beta_1_0`　基线 & HEAD：`1c169af33cf4e091a1363883a12a817b2b7aed77`
> 范围：基线到当前工作树的全部未提交改动（全部已 staged，无 untracked）
> 性质：只读评审，未修改任何源码、测试、文档、Changeset、lockfile 或配置

## 整体结论

**有条件可合并**：架构边界正确、无安全/确定性缺陷、全量质量门通过；但 Platform finalization 的全部失败原因被 Core 完全脱敏，spec §6.4 要求的可识别 "unsupported platform component contribution" 错误未真正达成，且 spec §8 明确点名的若干测试（NFC collision、跨 Session/Platform origin、AssetRef 注入）未覆盖。

## 范围与证据

- 分支 `beta_1_0`，HEAD = 基线 `1c169af3`，全部改动已 staged，`git ls-files --others --exclude-standard` 为空
- 规模：66 文件，+2129 / −162；新增 2 个文件（1 changeset、1 跨包测试）

实际执行的验证命令与结果：

| 命令 | 结果 |
|---|---|
| `pnpm run lint` | 通过，无输出 |
| `pnpm run typecheck` | 13 个 workspace 全部 Done |
| `pnpm run build` | 通过（attw / publint 均无问题） |
| `pnpm run test` | 全绿：core+各包 84，`@acplugin/test` 17 文件 91 例 |
| `pnpm run docs:check` | 通过（docs build + verify + playground typecheck + verify） |
| `pnpm run versions:check` | 通过，无输出 |
| `pnpm changeset status` | 9 个公开包 major |
| `git diff --check` / `--cached --check` | clean |

补充实证：`packages/playground/dist/claude-code/plugin/.claude-plugin/plugin.json` 实际产物为 code-point 升序且正确含 `"agents": "./agents/"`；`packages/platforms/claude-code/test/golden/.claude-plugin/plugin.json` 是**完整字节 golden 且本轮未修改**（`platform.test.ts:130-132,252`）。这证伪了"`agents` 从 base 移到 finalization 会改变 manifest 字节顺序"的假设——根因是 `snapshotJson`（`security/json-snapshot.ts:109`）与 `addDocumentField`（`package/json-snapshot.ts:70`）都做键排序，两条路径字节等价。

## Findings

### P1

#### 1. Platform finalization 的失败原因被 Core 完全丢弃，无法区分"不支持 component 贡献"与任意其它 finalization 故障

- **严重级别**：P1
- **证据**：
  - `packages/core/src/lifecycle/integration-sessions.ts:213-218` — `runPlatformStage` 是 `try { … } catch { reportFailure(…, message) }`，裸 `catch` 不读取任何异常内容
  - `packages/core/src/lifecycle/platform-pipeline.ts:240-241` — 固定 message `Platform "${id}" primary Package finalization failed.`
  - 抛出侧：`platforms/codex/src/index.ts:76`、`antigravity/src/index.ts:62`、`pi/src/index.ts:68` 的 `throw new TypeError('Platform component contributions are not supported by …')`
  - 同一路径也吞掉 Claude/Cursor/OpenCode 的全部 payload 校验错误（`claude-code/src/index.ts:57-89` 的 unknown field / 非法 ID / 枚举错误、`:101-106` 的 collision）
- **可复现**：`packages/test/test/platforms/native-component-contribution.test.ts:335-345` 已经复现——报告中只有 `code: 'PLATFORM_FINALIZE_PACKAGE_FAILED', phase: 'finalize'`，没有任何字段指向 component contribution
- **为何是实际问题（非偏好）**：spec §6.4 要求"产生稳定 `unsupported platform component contribution` 错误"，§7 要求"所有诊断只出现稳定 ID、相对资源位置和 Platform/Extension owner"——当前只有一个通用 ID，Extension 作者拿到报告后无法判断是自己的 payload 非法、ID 冲突，还是 Platform 根本不支持。这三种情况的修复动作完全不同。连带后果：`claude-code/test/platform.test.ts:322-324`、`cursor/test/platform.test.ts:286-299`、`opencode/test/platform.test.ts:271-287` 的 collision 断言只能断言这个通用 code，无法证明触发的是 collision 规则而非其它校验分支。
- **最小修复**：六个 Platform 在 `throw` 前用已有的 `context.diagnostics`（`FinalizePackageContext` 已提供）报告一条自有 code，例如 `CODEX_COMPONENT_CONTRIBUTION_UNSUPPORTED` / `CLAUDE_COMPONENT_COLLISION`。不需要改 Core：`platformHasErrors()` 已经会在 finalize 阶段发现 error 后中止。
- **修复风险与需补测试**：低风险，纯增量诊断。需把上述三处 collision 测试与跨包 reject 测试的断言改为具体 code，否则修复无法被证明。

### P2

#### 2. Claude / Cursor / OpenCode 各自维护一份不必要的可变 session 状态 `canonicalAgentIds`，引入 createPackage → finalizePackage 的隐性阶段顺序依赖

- **严重级别**：P2
- **证据**：`platforms/claude-code/src/index.ts:147,152,173,178`；`cursor/src/index.ts:102,107,125,130`；`opencode/src/index.ts:136,141,158`
- **可复现**：静态可见。`contracts/packages.ts:136-139` 的 `FinalizePackageContext<T> extends Omit<CreatePackageContext, 'assets'>` 已经带 `project`，且 `platform-pipeline.ts:251` 确实传入了 `project: options.project`
- **为何是实际问题**：这是三份完全冗余的闭包可变状态，把"canonical Agent 有多少个"这一 finalization 阶段现成可读的信息，改成必须依赖上一阶段写入。它不是当前的 bug（`build-session.ts:169` 每轮 build 都新建 Session，DevSession 重建不会串轮），但它是评审目标点名的"隐性完成顺序依赖"，且违反 Platform Session 无跨阶段隐式耦合的设计意图。
- **最小修复**：三处各删 2 行——移除 `let canonicalAgentIds`、移除 `createPackage` 里的赋值，`finalizePackage` 解构改为 `async finalizePackage({ project, package: mergedPackage, assets })`，内部用 `project.agents.map(agent => agent.id)`。Claude 处 `:178` 的条件改为 `project.agents.length + contributed.assets.length === 0`。
- **修复风险与需补测试**：极低，现有 golden 与 collision 测试即可回归。

#### 3. `componentContributors()` 绕过仓库统一的 data-boundary，对稀疏数组和 accessor 索引给出非稳定错误

- **严重级别**：P2
- **证据**：`packages/core/src/services/assets.ts:145-172` — 使用裸 `Array.isArray(value)` + `value.map(...)`；对照同语义的 `packages/core/src/package/registry.ts:310` 的 `finalizationOrigins()` 使用了 `dataArrayItems()`
- **可复现**：Platform 在 finalization 传 `componentOrigins: [ , origin]`（稀疏）→ `.map` 保留 hole → 下方 `for (const contributor of contributors)` 取到 `undefined` → 抛出 `Cannot read properties of undefined (reading 'owner')`，而非框架的稳定诊断文案。传 accessor 索引则会执行调用方 getter，这正是 `snapshotJson` / `dataArrayItems` 在全仓其它位置一律拒绝的行为。
- **为何是实际问题**：这是 Core 唯一一处 provenance 输入没有走统一边界的地方，与紧邻的 `finalizationOrigins` 行为不一致；规格要求边界对象的 getter / 稀疏数组处理一致。授权本身不会被绕过（`allowed.has()` 用 object identity），因此不是安全漏洞。
- **最小修复**：把 `if (!Array.isArray(value)) throw` 换成 `const items = dataArrayItems(value, 'Generated Asset componentOrigins')`，后续 `.map` 改在 `items` 上。
- **修复风险与需补测试**：低。补一条 `asset-registry.test.ts` 用例断言稀疏数组的稳定错误文案。

#### 4. AGENTS.md 未更新，仓库权威规范仍描述旧的 Contributor 能力边界

- **严重级别**：P2
- **证据**：`AGENTS.md` 中 `grep -n "Component Contribution\|components\|finalization"` 零命中；`AGENTS.md:66-67` 仍写"Contributor 只能读取 base Package、向声明的 extension point 新增字段、追加自有 Asset 和报告兼容性"，`AGENTS.md:53-62` 的固定生命周期也未提 finalization documentFields
- **为何是实际问题**：T07 Scope 第 2 条明确要求"更新 AGENTS.md 反映该正式边界"。README、llmdoc/system.md、domain-glossary、conversion-matrix、compatibility-matrix、六个 platform doc 都已同步更新，唯独作为工程唯一硬约束来源的 AGENTS.md 落后，后续任何代理读它都会得到过时的能力边界。
- **最小修复**：在 `AGENTS.md:67` 补一句 opaque Platform Component Contribution，并在 `:62` 的生命周期文本里补 finalization documentFields。
- **修复风险与需补测试**：无代码风险。

#### 5. spec §8 明确点名但未覆盖的测试缺口

- **严重级别**：P2
- **证据（逐条）**：
  - **NFC collision 三家全缺**（spec §8.2 第 5 条）：生产代码 `claude-code/src/index.ts:100`、`cursor/src/index.ts:58`、`opencode/src/index.ts:94` 都做 `id.normalize('NFC').toLowerCase()`，但三个平台的 collision 测试只覆盖 case（Claude，`platform.test.ts:311-325`）或精确同名（Cursor `:286-299`、OpenCode `:271-287`）。`.normalize('NFC')` 整段删掉不会有任何测试失败。
  - **跨 BuildSession / 跨 Platform 的 component origin 未覆盖**（spec §8.1.6）：`services/assets.ts:274` 的 `record.session !== this.#scope.token || record.platform !== platform` 两个分支无测试；`asset-registry.test.ts:93-95` 与 `package-registry.test.ts:363` 里 platform 恒为 `'target'`。
  - **AssetRef / SourceRef 塞进 component value 未覆盖**（spec §8.1.1 逐字要求）：component value 路径只有 `package-registry.test.ts:233-239` 的"必须是 JSON object"。
  - **component 的异步完成顺序无关性未覆盖**（spec §8.1.3）：`package-registry.test.ts:175-199` 是唯一的异步顺序用例，其 contribution 只含 `documentFields` 和 `assets`（:186-188），断言（:197-198）也只比 documents/assets。配置顺序无关性已覆盖（:130-173）。
  - **T01/T02 定向测试文件未触及**：`packages/core/test/contracts/integration-definitions.test.ts`（泛型 factory/brand shape）与 `packages/core/test/package/distribution-registry.test.ts`（继承来源不丢失）在本轮 diff 中零改动。Distribution 继承由 `claude-code/test/platform.test.ts:337-375` 间接覆盖，泛型 brand 无覆盖。
  - **Codex/Antigravity/Pi 包内无 component 测试**（spec §8.2 末段"各增加一条"）：三个包的 `test/platform.test.ts` 中 `components` 零命中，reject 仅由跨包测试覆盖。
  - **"scope 外不接受 component origins"的类型断言缺失**（T02 定向测试）：`sdk-api.types.ts` 全文仅 1 处新 `@ts-expect-error`（:61，默认 never），无普通 `AssetService` 拒绝 `componentOrigins` 的编译期证明。运行时有 `assets.ts:150-151` 兜底。
- **最小修复**：按上表补齐；NFC 与 AssetRef 注入两项优先，因为它们对应的生产代码分支目前完全无保护。

#### 6. 跨包 reject 测试第 344 行是恒真的空断言

- **严重级别**：P2
- **证据**：`packages/test/test/platforms/native-component-contribution.test.ts:340,344` — 第 340 行已断言 `report.packages` 为 `[]`，第 344 行 `report.packages.flatMap(...).some(...)` 因此恒为 `false`
- **为何是实际问题**：这行的意图是证明"不生成 `agent-*` fallback"，但它没有检查任何东西。真正的证据应来自文件系统。
- **最小修复**：改为断言 `dist/<platform>/` 下不存在贡献产物，或断言目录未被创建。

### 建议

#### 7. 两个 changeset 描述内容重复

`.changeset/kernel-v2-sdk-boundary.md:27` 新增段落与 `.changeset/platform-component-contributions.md:11-13` 表述同一件事，CHANGELOG 会出现两段近义描述。建议只保留新 changeset 的完整描述，旧 changeset 只保留必须的 `schema version 3` 文字修正。

包覆盖本身正确：`hooks`/`mcp` 未出现在新 changeset 是对的（其 src 零改动，major bump 由旧 changeset 提供）。

## 架构评价

### 是否偏离"Core 通用、Platform 语义、Extension 映射"的边界：未偏离

- Core 侧 `grep` 无 `agent` / `tool` / `role` / `model` / Claude/Cursor/OpenCode 路径或 Platform ID 分支。`registry.ts:328-349` 的 `componentSnapshot()` 只做 subject 语法 + subject membership + `snapshotJson` + JSON-object 断言，注释明确声明不读 value 字段，代码也确实不读。
- Platform 侧各自独立持有 union、parser、collision key、renderer、路径与 Manifest 决策。三份 `nativeAgent()` 的字段集完全不同（Claude 13 字段、Cursor 4 字段、OpenCode 6 字段 + wire map），没有相互泄漏。
- Extension 侧 `context.base` 仍是 `PlatformBasePackageSnapshot`，`components` 只出现在 `MergedPackageSnapshot`（`contracts/packages.ts:82-85`），Extension 无法观察其它 Contribution。

### 是否存在过度设计：否

逐一评估四个新机制，每一个都对应 spec 中不可省略的约束：

- **泛型**：是让 Platform payload type 在 Contributor 编写处生效的唯一手段，且在 Core 边界（`contracts/integrations.ts:283-287`、`lifecycle/integration-sessions.ts:22,33`）正确擦除为 `JsonObject`。
- **origin object identity + `#componentOrigins` WeakMap**（`services/assets.ts:212`）：不可省略。owner/subject 是纯文本，Platform 可以任意编造；只有 Core 私有 WeakMap 中的对象 identity 能构成授权边界。
- **finalization point**：不可省略。Claude/Cursor 必须在合并完成后才知道该不该写 `agents`；让 Platform 在 `createPackage` 决定则无法感知 contribution，让 Extension 写则破坏 Manifest 所有权。
- **`FinalizationAssetService` + `scope.close()`**（`platform-pipeline.ts:245,257-260`）：不可省略。WeakMap 记录已含 platform+session，单看"能否伪造"确实冗余；但 scope 的真实作用是防止 Platform 在 `validatePackage` / `createDistributions` 回调里继续签发带 component provenance 的 Asset——这正是 spec §3 逐字要求的"createPackage、Extension build/contribute、Distribution 和其他 Platform 回调得到的 AssetService 不接受该字段"。

### 是否存在不必要复杂度：一处

即 Finding 2 的 `canonicalAgentIds`。

三个 Platform 的 `contributedAgents()` 高度重复（各约 25 行）看起来像可抽取的复杂度，但这是**有意且正确的重复**：spec §2.2 明确写"平台类型相似不构成 Core 共享模型的理由"。抽到 Core 会立刻把 Agent 语义倒灌进 Core；抽到共享包会制造 Platform 间的隐式耦合，使任一 Platform 未来收窄字段时被绑架。不建议动。

### 必需、不能简化的复杂度

- origin 的 WeakMap identity 绑定
- finalization scope 的即时撤销
- `snapshotJson` 的严格 JSON 边界（同时提供 deep freeze、键排序、getter/Symbol/cycle/稀疏拒绝，是 `componentValueKey` 排序稳定的前提）
- `documentSnapshot` 中 extension/finalization point 的不重叠检查（`registry.ts:149-154`，两个 owner 命名空间隔离的唯一保障）
- merge 的三级排序（owner → subject → stable JSON）

### 最小重构方向

只有 Finding 2 需要重构，三个文件各删 2 行、改 1 行解构。其余保持原状。

## 规格符合性矩阵

| 规格主题 | 状态 | 证据 | 缺口/风险 |
|---|---|---|---|
| 1. strict JSON envelope、subject 验证、deep freeze、稳定排序 | 符合 | `registry.ts:328-349`（envelope + `snapshotJson`）、`:455-457`（owner→subject→JSON 三级排序） | `componentSubject()` 正则（`:286`）是 subject membership 检查之外的冗余前置校验，若既有 subject 语法更宽会误拒 |
| 2. Core 对 payload 不透明 | 符合 | Core 全量 `grep` 无 agent/tool/role/model/平台路径；`componentSnapshot` 不读 value 字段 | 未发现 |
| 3. provenance 不可伪造、跨 session/platform 拒绝 | 实现符合，测试不足 | `assets.ts:264-278`（identity + session + platform 三重校验）、`registry.ts:303-320` | 跨 session / 跨 platform 分支无测试（Finding 5） |
| 4. finalization field 只写 Platform 预声明空位、不与 extension point 重叠 | 符合 | `registry.ts:149-154`（重叠拒绝）、`:467-504`（undeclared / duplicated / add-only） | 「finalization point 指向非空字段」「跨 Document」「非 owner Platform 写入」三个分支无测试 |
| 5. 贡献 Agent 与 canonical Agent 的 case/NFC collision | 实现符合，NFC 无测试 | `claude-code/src/index.ts:100`、`cursor:58`、`opencode:94` | NFC 分支三家全无测试（Finding 5） |
| 6. Claude / Cursor / OpenCode 原生交付完整 | 符合 | 三家 union + parser + renderer + 路径；Claude/Cursor 写 Manifest finalization point，OpenCode 按 spec §6.3 不声明 | 未发现 |
| 7. Codex / Antigravity / Pi 稳定拒绝，不生成伪 fallback | 部分符合 | `codex:75-77`、`antigravity:61-63`、`pi:67-69`；跨包测试 `:335-345` 证明 `packages === []` | 错误不可识别为 component 问题（Finding 1）；三包内无自有测试；无 fallback 的文件系统证据是空断言（Finding 6） |
| 8. Marketplace 继承贡献 Asset 的 hash/owner/mode/origin | 符合 | `claude-code/src/package/manifest.ts:239`（同一 AssetRef 透传）；`platform.test.ts:368-373` 四项逐一断言 | 未发现 |
| 9. 无 contribution 时产物与行为不变 | 符合（已实证） | golden 字节文件本轮零改动；`platform.test.ts:252` 全字节比对，场景含 canonical agent 且无 extension | 无 before/after 直接比对测试，但 golden 未变即等价证明 |
| 10. BuildReport v3 与 `LIFECYCLE_API_VERSION === '1'` | 符合 | `contracts/reports.ts:124`、`report-builder.ts:125`；`LIFECYCLE_API_VERSION` 未改；`verify-playground.mjs:313` 已同步 | 未发现 |
| 11. docs / README / matrix / playground / Changeset 与真实行为一致 | 部分符合 | README:335、system.md:80,88、glossary、conversion-matrix、compatibility-matrix、六个 platform doc、extension-authoring 全部更新且描述准确 | **AGENTS.md 未更新**（Finding 4）；两个 changeset 描述重复（Finding 7） |

### 类型 API 与消费者体验（C 轴）单列结论

`packages/acplugin/dist/index.d.mts` 中 `FinalizationAssetService|PackageComponentOrigin|ContributedPackageComponent|PackageContribution` 命中 0；`dist/sdk.d.mts` 命中 2；四个 `.d.mts` 中 `*NativeAgentComponent|*PackageComponent` 命中 0。主包/SDK 边界正确，Platform 具体 payload 只从各自包根导出。`sdk-api.types.ts:61` 证明默认 `never` 在编译期拒绝写入 payload。

## 测试评价

### 已证明的行为

- 跨包测试是本轮最强的一环：`native-component-contribution.test.ts:13-21,43,95,145-160` 使用真实 `dist/index.mjs` 复制进临时 `node_modules`，在独立 Node ESM 子进程执行 —— Vitest 的 `resolve.alias`（`packages/test/vitest.config.ts:19-35` 确实把 9 个包名指向 `src`）对子进程不生效。**"测试只在 source alias 下成立"的风险在这个文件上不成立**；文件中唯一的包导入是第 7 行的 `import type`。
- 三平台原生交付、路径、owner、`contributors` provenance、两次构建 `packages` 深度相等（:289）
- inspect 不提交（:302）、失败保留上次输出（:308）、DevSession 重建（:325-326）
- Claude Marketplace 对贡献 Agent 的 owner/mode/sha256/origin 四项继承（`claude-code/test/platform.test.ts:368-373`）
- 无 contribution 时 origin 不含空 `contributors`（`asset-registry.test.ts:66-71`，`toEqual` 严格断言）
- 伪造 origin（同形冻结对象）在 Asset 与 Document 两条路径均被拒（`asset-registry.test.ts:107-109`、`package-registry.test.ts:379-382`）
- 配置顺序与 contribution 内数组顺序对 merged component 序列无影响（`package-registry.test.ts:130-173`）

### 尚未证明但规格要求的行为

见 Finding 5 全表：NFC collision ×3、跨 session/platform origin、AssetRef/SourceRef 注入、component 的异步顺序无关性、泛型 brand shape、finalization point 三个剩余分支、三个 unsupported 平台的包内测试、`AssetService` 拒绝 `componentOrigins` 的编译期断言。

### 可能产生假阳性的测试边界

1. 三家 collision 测试与跨包 reject 测试都只断言 `PLATFORM_FINALIZE_PACKAGE_FAILED`。任何让 `finalizePackage` 抛错的实现缺陷（例如 ID 正则误报）都会让它们继续通过。这是 Finding 1 的直接后果，也是修 Finding 1 的主要收益。
2. `native-component-contribution.test.ts:344` 恒真（Finding 6）。
3. `report-builder.test.ts:60-66` 用 `toMatchObject`，无法证明 `contributors` 字段不存在；该保证实际只由 `asset-registry.test.ts:66-71` 提供。
4. dev / inspect / 失败回滚三条测试的 fixture 虽然带 component contribution，但全部文件断言指向 `skills/base/SKILL.md`（:296,303,308,313,326），从未断言 `agents/observer.md` 在这些场景下的状态。

## 最终建议

### 必须在合并前修复

1. **Finding 1** —— 六个 Platform 在 `throw` 前用 `context.diagnostics.report()` 发出自有稳定 code，并把三家 collision 测试与跨包 reject 测试的断言改为该具体 code。这同时消除本轮最主要的测试假阳性面。
2. **Finding 5 中的两项高优先**：NFC collision 测试（三家生产代码的 `.normalize('NFC')` 目前完全无保护）、component value 注入 `AssetRef`/`SourceRef` 的拒绝测试（spec §8.1.1 逐字要求）。
3. **Finding 4** —— AGENTS.md 补两句，恢复权威规范与实现一致。

### 可后续处理

- Finding 2（`canonicalAgentIds` 三处删除）—— 纯清理，无行为变化，但建议顺手做掉，成本 6 行
- Finding 3（`componentContributors` 改用 `dataArrayItems`）
- Finding 6（第 344 行改为文件系统断言）
- Finding 5 剩余各项：跨 session/platform origin、component 异步顺序、finalization point 三个分支、三个 unsupported 平台的包内测试、`sdk-api.types.ts` 的 scope 外 `@ts-expect-error`
- Finding 7（changeset 去重）

### 明确不建议做的"过度设计"项

- 不要把三家的 `contributedAgents()` / `nativeAgent()` / `agentCollisionKey()` 抽取到 Core 或新共享包。重复是 spec §2.2 的刻意选择，抽取会立刻把 Agent 语义倒灌进 Core 并制造 Platform 间耦合。
- 不要移除 `FinalizationAssetService` 的 scope/close 机制去"简化"为纯 WeakMap 校验。虽然 WeakMap 记录已含 platform+session 足以防伪造，但 scope 撤销是阻止 Platform 在 `validatePackage`/`createDistributions` 中延续 provenance 签发的唯一手段，spec §3 逐字要求。
- 不要为让诊断更精确而在 Core 引入 component-aware 的错误类型或阶段。Finding 1 的正确修法在 Platform 侧用现有 `context.diagnostics`，Core 不需要任何改动。
- 不要新增 Slot、component registry、Extension 排序、claim/suppress 或 raw Manifest patch —— 当前实现已在无这些机制的前提下满足全部功能需求，spec §9 的扩展性判据成立。
