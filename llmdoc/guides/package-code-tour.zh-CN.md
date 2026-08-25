# ACPlugin Kernel v2 代码导览

本文只描述当前 Kernel v2。旧 `Draft/Adapter/DeliveryUnit/Artifact/BuildResult` 生命周期已经删除，不是兼容路径。

## 1. Workspace 与公开边界

| 目录 | Package | 可见性 | 责任 |
| --- | --- | --- | --- |
| `packages/acplugin` | `@tokenroll/acplugin` | 公开 | CLI、作者 façade、`/sdk`、Project API、init、隔离 Migration；bundle Core |
| `packages/core` | `@acplugin/core` | 私有 | Kernel、Resource/Host/Registry、Compiler、Package、事务、报告 |
| `packages/platforms/*` | 六个 `@tokenroll/acplugin-platform-*` | 公开 | 单一目标平台转换、Package、Distribution 与 candidate validator |
| `packages/extensions/hooks` | `@tokenroll/acplugin-extension-hooks` | 公开 | Hook 作者协议、单次构建、安全 runner、六平台 Contributor |
| `packages/extensions/mcp` | `@tokenroll/acplugin-extension-mcp` | 公开 | HTTP/stdio MCP 协议、stdio 构建/smoke、六平台 Contributor |
| `packages/test` | `@acplugin/test` | 私有 | 跨包、CLI、Migration、tarball 与架构测试 |
| `packages/docs` | `@acplugin/docs` | 私有 | VitePress 与九个公开 package 的 TypeDoc |
| `packages/playground` | `@acplugin/playground` | 私有 | 领域中立的真实全能力消费模板 |

公开调用面有意分成两层：

- `@tokenroll/acplugin`：普通作者使用 `defineConfig()`，程序化调用方使用 `createProject()`、`runProject()`、`Project.dev()`，并读取 schema-v3 `BuildReport`。
- `@tokenroll/acplugin/sdk`：Platform/Extension 实现使用 `definePlatform()`、`defineExtension()`、Session/Contributor/Compiler/Asset 契约与稳定序列化工具。

官方 Platform/Extension 以主包为 peer，只能 import `/sdk`，不能 import `@acplugin/core`。主包不 bundle 或重导出任何官方集成。

## 2. 固定执行图

```text
acplugin.config.ts
→ config load/resolve
→ Platform/Extension Session setup
→ canonical/Public/Runtime/Extension discovery
→ CanonicalProject assembly
→ Component/Extension validation
→ Extension/Core Runtime compilation
→ Platform.createPackage
→ Framework/Extension Contributor collection
→ Core add-only merge
→ Platform.finalizePackage
→ primary candidate materialize/validate
→ Distribution create/validate
→ compatibility/metadata finalization
→ aggregate materialization validation
→ managed transaction
→ reverse Session close
→ BuildReport schema v3
```

CLI、`runProject()`、`Project.run()` 与 `Project.dev()` 的每个重建轮次最终都进入 `packages/core/src/lifecycle/build-session.ts`。不存在 CLI 专用构建器或 Extension 自己的 pipeline。

## 3. 主包入口

| 文件 | 作用 |
| --- | --- |
| `packages/acplugin/src/index.ts` | 作者/程序化根入口；只导出配置、Project、报告和 Runtime path helper |
| `packages/acplugin/src/sdk.ts` | Integration 唯一实现入口，转出 Core `api/integration` |
| `packages/acplugin/src/author/project.ts` | 把公开 Project API 绑定到 Core lifecycle 与当前 Framework version |
| `packages/acplugin/src/cli.ts`、`src/cli/` | 薄入口与 init、validate、inspect、build、dev、migrate 命令；只消费 Project API |
| `packages/acplugin/src/scaffolding/` | 显式 Platform/Extension 脚手架与内建 Runtime 模板 |
| `packages/acplugin/src/ecosystem/` | init、Migration 与 release verifier 共用的公开生态版本快照 |
| `packages/acplugin/src/migration/` | 动态 import 的隔离迁移子系统 |

`defineConfig()` 是唯一作者 define factory，仅用于类型推断。Hook、MCP descriptor 与 Runtime 源码使用 plain default export / 目录约定，不需要 `defineHook()`、`defineMcpServer()`、`defineNodeRuntime()` 或 `nodeRuntime()`。

## 4. Core 契约层

| 文件 | 作用 |
| --- | --- |
| `contracts/` | 按 common、config、component、project、integration、compiler、package、service、report 拆分的契约类型 |
| `api/definitions.ts` | `definePlatform()` / `defineExtension()` 精确字段验证、严格 JSON snapshot、品牌与冻结 |
| `api/author.ts` | 主包根入口允许公开的作者/报告类型 |
| `api/integration.ts` | `/sdk` 允许公开的 Integration 类型与工具 |
| `serialization/` | 确定性 JSON/YAML/frontmatter 与 Document 序列化 |

`LIFECYCLE_API_VERSION` 保持 `'1'`。该值表达当前 Session/Contributor 契约版本，不表示保留被删除的旧 shape。

Platform options 和 Extension options 必须是深度冻结的严格 JSON。定义对象拒绝未知字段、accessor、Symbol、稀疏数组、自定义 prototype、循环与非有限数字，防止 setup 后继续观察调用方 mutation。

## 5. Capability Registry 与 Host

Kernel 不把物理路径和任意文件系统权限交给 Integration，而是签发与当前 BuildSession/owner 身份绑定的 capability：

| 模块 | 能力 |
| --- | --- |
| `services/sources.ts` | 验证来源根、普通文件、symlink/特殊文件、SourceRef 授权 |
| `compiler/module-host.ts` | 通过唯一受管 Rolldown ESM 图加载可信 TypeScript/JavaScript config/descriptor |
| `compiler/compiler-service.ts` | 当前 Session 唯一 Rolldown owner，返回 GeneratedAssetRef 与脱敏模块图 |
| `services/execution.ts` | 在隔离 cwd、最小显式环境、超时和输出上限内执行 portable Node Asset |
| `services/assets.ts` | 签发 Source/Generated/Bytes AssetRef，记录 owner/origin/mode/size/hash 与 grant |
| `services/watch.ts` | 集中记录 Resource、Module、Compiler 实际读取的依赖 |
| `services/work-directories.ts` | 为 owner 管理不可伪造的内部 workDir；不公开物理写权限 |
| `services/session-scope.ts` | Session 结束后统一撤销所有 capability identity |

AssetRef 不是可伪造的 `{ path }`。Registry 使用对象身份验证当前 Session、真实 issuer 与 consumer grant；报告中的 origin 为结构化工程相对来源，不影响内容 hash。

## 6. Resource Provider

`packages/core/src/resources/` 把作者布局转换为唯一 `CanonicalProject`：

- `canonical/provider.ts`：Command、Skill、Agent Markdown/frontmatter、辅助资源与平台字段。
- `project-graph.ts`：拒绝缺失、自依赖和循环依赖。
- `public.ts`：默认 `public/` 和显式 copy mapping。
- `runtime/provider.ts`：内建 Node Runtime 自动/显式入口、编译与 capability-driven Contribution。
- `extensions.ts`：Extension discover/validate/build state snapshot、consumer plan 与 Contributor 收集。
- `registry.ts`：声明/认领资源根，拒绝未启用 Extension 遗留目录和根冲突。

所有 ID、目录项和报告集合按 code point 稳定排序；路径统一拒绝绝对路径、NUL、`..`、大小写/Unicode normalization 冲突与文件/目录前缀冲突。

## 7. 统一 Rolldown Compiler

`context.compiler.compile()` 提供两种 profile：

### `portable-node`

用于内建 Runtime、Hooks 和 local MCP。它固定 Node 20 ESM、自包含 bundle、只 externalize `node:` builtin、无 sourcemap，并拒绝未解析 import、原生扩展、隐式运行时依赖和不确定输出。许可证默认严格收集，实际包含第三方 package 时产生 `THIRD_PARTY_LICENSES.txt`。

作者只可调整 `PortableNodeCompileOptions` 的 JSON-safe `resolve`、`transform` 和 `treeshake` 子集，不能注入 plugin 或回调。

### `managed-rolldown`

供第三方 Integration 使用 Rolldown 的受管能力。Core 始终接管 cwd、input identity、输出、日志、watch、close、workDir 和 Asset 签发，禁止 `writeBundle`、`watchChange`、`closeWatcher` 等越权 Hook。许可证默认 `strict`；显式 `ignore` 仅表示调用方承担法律材料责任，不关闭其余安全审计。

Module graph 的实际 source、package、tsconfig 与 license 输入全部进入 Watch Registry。Platform/Extension 不得直接依赖 Rolldown并建立第二套 bundler。

## 8. Package、Document 与 Contribution

Platform `createPackage()` 返回：

- 结构化 Document（JSON/YAML/TOML/frontmatter）及明确的空 extension point；
- package-relative Asset mappings；
- Canonical Component 兼容性；
- metadata emitted/omitted 结论。

Core 把它复制为冻结的 `PlatformBasePackageSnapshot`。Framework Runtime/Public 与所有 Extension Contributor 都读取这一份相同 snapshot；Extension Contribution 并发收集，按 owner 稳定排序后集中合并。

Contribution 只能：

- 填写已声明、当前为空的 Document field path；
- 追加当前 owner 已签发或获 grant 的 Asset；
- 提交与 Extension 已声明 subject 绑定、仅由目标 Platform 解释的不透明 JSON Component payload；
- 精确覆盖 Extension validate 阶段声明的 compatibility tuple。

payload 不是 Canonical Component，Core 不读取其业务字段。只有 `finalizePackage()` 看到 merged payload；目标 Platform 负责 schema、命名空间、输出路径、渲染与 candidate validation。Claude Code、Cursor、OpenCode 首期各自支持原生 Agent payload；Codex、Antigravity、Pi 对非空 payload 稳定失败，绝不静默忽略或生成 fallback。

它不能读取其他 Contribution、替换/删除已有字段、append 任意数组、claim/suppress Canonical Component 或覆盖 Asset 路径。同一字段、路径或 tuple 竞争稳定失败，不使用 `extensions[]` 顺序解决。

`finalizePackage()` 读取 merged snapshot，只决定主 Package identity/type 并可追加 Platform 自有 Asset。Core 自动继承全部 base/contribution 内容。主 Package 通过完整临时候选校验后，Platform 才能创建 Marketplace Distribution；Distribution 也必须保持继承 Asset 完整性并再次校验。

相关实现位于：

- `package/registry.ts`
- `package/documents.ts`
- `package/candidate-materializer.ts`
- `package/distributions.ts`
- `package/compatibility.ts`
- `package/report-builder.ts`

## 9. Platform package

六个官方 Platform 都遵循同一结构：

```text
src/
├── index.ts             # factory、definePlatform、Session
├── types.ts             # 可选，公开 options 与目标格式类型
└── package/
    ├── components.ts    # Canonical Component 转换与 compatibility
    ├── manifest.ts      # 或 config-document.ts；结构化 Platform Document/metadata
    ├── protocol.ts      # 可选，目标协议的共享常量与 wire helper
    └── validator.ts     # 小平台使用；Claude Code/Codex 按 validation/* 协议域拆分
```

Platform 只声明能力，不要求 Core 按 ID 分支。当前 Claude Code/Codex 声明固定 Plugin-local Node 20 ESM capability；Runtime Provider 据此交付相同 AssetRef。其他 Platform 得到 `unsupported` 且无伪 Runtime。

主交付形态：Claude Code/Codex/Cursor/Antigravity 为 Plugin，OpenCode 为 Workspace，Pi 为 npm Package。Claude Code/Codex 可派生 Marketplace Distribution。

## 10. Extension package

Hooks 与 MCP 都采用：

```text
types.ts → discovery.ts → build.ts → contributors/<platform>.ts
```

Hooks 交付进 bundle 的 runner、integration 与 wire 源码集中在 `runtime/`；MCP 没有无实现意义的空 Runtime 层级。两者都通过公开 SDK 的唯一 strict JSON snapshot 建立 descriptor 数据边界。

### Hooks

- descriptor：`src/hooks/<id>/hook.ts` plain default export；
- build：每个 handler 经 Core `portable-node` 只 bundle 一次；
- runtime：编译进 handler 的 wire profile 拥有平台 stdin/stdout、camelCase、root/data 映射和稳定错误码；
- Contributors：为六个平台追加受支持 runtime/config，并逐事件/字段报告兼容性。

### MCP

- descriptor：`src/mcp/<id>/mcp.ts` plain HTTP/stdio 判别联合；
- HTTP：只交付 URL、header 与 `{ env }` Secret 引用，构建不读取值；
- stdio：完整 server 通过 Core `portable-node` 构建，并以真实 `initialize → initialized → tools/list` smoke 校验；
- Contributors：Claude Code/Codex/OpenCode 可消费 local stdio，Pi 全部 unsupported，其他平台按真实 transport 能力报告。

Extension 没有自己的 Rolldown、watcher、输出事务、依赖图或顺序 API。

## 11. 内建 Node Runtime

Runtime 不使用 descriptor 或 Extension factory：

- 默认把 `src/runtime/` 一级 TS/JS 文件当作 executable entry；
- `runtime.entries` 完整替换自动发现，可声明嵌套文件与 `module` kind；
- Core 使用一个逻辑 `portable-node` Job 编译全部入口，每个入口产生独立 `main.mjs` 和可选许可证；
- 固定输出路径为 `runtime/<id>/main.mjs` 与 `runtime/<id>/THIRD_PARTY_LICENSES.txt`；
- supported Platform 继承相同 Asset bytes，unsupported Platform 只报告兼容性。

语义 TypeScript 类型检查仍由作者工程 `tsc --noEmit` 负责；Runtime 编译只负责模块转换、bundle、交付、安全与许可证。

## 12. DevSession 与事务

`lifecycle/dev-session.ts` 是唯一 Chokidar owner：

- 同一时间只有一个 active BuildSession；
- active round 期间的变化合并到下一轮；
- 每轮根据 Resource/Module/Compiler 实际快照动态 reconciliation watcher；
- watcher ready 后补偿构建关闭初始扫描竞态；
- config 失败后仍保留必要恢复监听；
- rebuild 失败保留最后一次成功输出；
- signal drain 与 `close()` 幂等。

`output/transaction.ts` 对所选目标集合执行：

```text
lock → recovery → stage → materialization validation
→ transaction record/backup → swap → Session close → cleanup
```

commit 的 Session close 位于 swap 后仍可 rollback 的窗口。任何必要 close 失败都会恢复旧输出。subset 构建在锁内验证并保留未选 Platform；fault-injection 测试覆盖每个持久化边界。

## 13. BuildReport

schema-v3 `BuildReport` 包含：

- framework/compiler version、command、mode、success、committed；
- Component、Runtime、Extension、Platform 状态；
- Package Unit 与 Asset 的 path/owner/origin/mode/size/SHA-256；
- Component contribution 驱动的生成 Asset/finalization Document 的稳定 contributor owner/subject provenance；
- compatibility 与 metadata disposition；
- 绑定 phase/owner/platform/extension/component 的稳定诊断。

报告不包含 Asset bytes、原始异常、Secret 值、环境值、工程绝对路径、临时路径或时间戳。CLI `--json` 与程序化 API 返回同一结构。

## 14. 测试与质量门

| 目录/脚本 | 重点 |
| --- | --- |
| `packages/core/test/` | Resource/graph、Host、Compiler、Registry、Package、transaction、DevSession |
| `packages/platforms/*/test/` | Component 转换、golden、candidate validator、确定性 |
| `packages/extensions/*/test/` | descriptor、build、Contributor、compatibility、真实 runtime/protocol |
| `packages/test/test/{architecture,api,cli,platforms,extensions,release}/` | 架构、公开 API、CLI、六平台、Extension 与发行边界集成；Migration 保持根测试路径 |
| `scripts/verify-playground.mjs` | 全能力文件树、协议执行、Secret、双构建确定性 |
| `.github/workflows/changelog.yml` | `main` 合并后消费 Changeset 并维护版本/CHANGELOG PR |
| `.github/workflows/release.yml` | 手工发布稳定 npm 版本；beta 使用本地 pnpm 命令 |

完整门禁：

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run docs:check
```

## 15. 修改入口速查

| 变更 | 首要位置 | 必须联动 |
| --- | --- | --- |
| Canonical Component 字段/布局 | `resources/canonical/`、`contracts/components.ts` | 六 Platform 转换、graph、报告、golden |
| Package/Asset 安全不变量 | `services/assets.ts`、`package/*` | owner、candidate、transaction、report 测试 |
| Compiler profile | `compiler/*`、`contracts/compiler.ts` | Watch、license、Hooks/MCP/Runtime、SDK type tests |
| Platform 格式 | 对应 `packages/platforms/<id>` | compatibility、validator、Extension Contributor |
| Extension 作者协议 | 对应 `types.ts`/`discovery.ts` | build、六 Contributor、protocol smoke |
| Runtime 约定 | `resources/runtime/`、`config/resolver.ts` | capability、路径 helper、双平台交付与执行 |
| dev 监听 | `lifecycle/dev-session.ts`、各 Service watch observation | CLI 子进程、恢复、coalescing、close 测试 |
| 输出事务 | `output/transaction.ts` | fault injection、full/subset、rollback、cleanup |
| 公开 API | `api/author.ts` 或 `api/integration.ts`、主包入口 | TypeDoc、type tests、tarball consumer、peer range |

推荐阅读顺序：`acplugin/src/index.ts` 与 `sdk.ts` → `core/src/contracts/` → `lifecycle/build-session.ts` → Resource/Package Registry → 一个官方 Platform → Hooks/MCP → DevSession 与 output transaction → Playground/release verifier。
