# ACPlugin Kernel v2 最终独立对抗式架构与代码交叉 Review

> Review 日期：2026-08-18（Asia/Shanghai）  
> Review 范围：`9086b37c21bcc700e163043abfb050f91242ffe9..当前完整工作树`，包含 staged、unstaged 和 Review 开始时已有的 untracked 文件  
> 方法：源码与类型契约审阅、llmdoc/ADR/spec/ticket/历史 Review 交叉核验、Standards/Spec 双轴独立 Review、全量质量门、真实 Kernel/public SDK 最小反例  
> 约束：未修改产品源码、测试、配置或正式文档；本文件是本轮唯一正式输出

## 1. Executive Verdict

**最终结论：`NOT_READY`。**

当前 Kernel v2 的主架构已经基本对齐“Core 基于 Rolldown 提供开箱即用跨平台 Plugin 框架”的定位：Core 确实拥有唯一生命周期、Compiler/Module/Watch、Asset、Package、Compatibility、Transaction 和 Report；Runtime 已成为 Core Framework Resource；Hooks/MCP/官方 Platform 已脱离 Integration-local bundler；官方生态是九个独立公开包；Platform/Extension 生产代码走 `/sdk`；Migration 保持 lazy/隔离。没有证据支持整体重写 Kernel，也没有发现为了文件数量或抽象洁癖而必须推倒重来的明显过度设计。

但当前仍有 **9 个 P1**：beta Changeset 会直接进入稳定 `1.0.0`；Patch 版本流程不会同步唯一生态版本快照；事务锁可被一次崩溃永久卡死，且持久化顺序缺少目录 fsync；DevSession 的 watcher/close 异常无法保证事件和终态；MCP smoke 可被非 MCP 程序绕过；OpenCode 最终 validator 可接受错误本地命令；managed-rolldown 的 deterministic 审计既误拒绝正常输出，又能放过绝对路径泄漏。这些问题分别会造成错误发行、旧输出恢复风险、dev 挂起、伪协议产物或机器路径进入交付物，因此不能以“全量测试已通过”替代修复。

建议是 **保留现有总体架构，针对 Transaction crash protocol、DevSession terminalization、managed deterministic audit 和 MCP/最终协议边界做局部重写或收口**。不建议重新引入 Scanner、Artifact、DeliveryUnit、Adapter、第二生命周期、Extension 顺序协议、Node Runtime Extension 或 Integration-local bundler。

Finding 汇总：

| 严重度 | 数量 | 结论 |
| --- | ---: | --- |
| P0 | 0 | 未发现立即导致普遍数据破坏或凭据直接泄漏的确定路径 |
| P1 | 9 | 阻断当前交付/发行 |
| P2 | 2 | 应在 beta 收口前修复 |
| P3 | 0 | 未保留无实际影响的风格类 Finding |

## 2. Review Baseline

### 2.1 Git 基线

- 实际分支：`beta_1_0`，与给定基线一致。
- 实际 HEAD：`9086b37c21bcc700e163043abfb050f91242ffe9`，与给定基线一致。
- 从 HEAD 到 Review 开始时完整工作树：318 个 tracked path 变化，约 `+27091/-18756`。
- Review 开始时已有 untracked 产品测试：`packages/acplugin/test/dev-session.test.ts`；它被实际 `pnpm run test` 收集并执行。
- `review2.md` 是用户在 Review 过程中指定的输出文件，不计入被审产品基线。
- `packages/core/src/kernel-types.ts:8` 仍为 `LIFECYCLE_API_VERSION = '1'`，满足硬约束。

### 2.2 实际验证结果

| 命令/验证 | 结果 | 关键证据 |
| --- | --- | --- |
| `pnpm run lint` | PASS | 中文注释守卫覆盖 195 个文件，ESLint 通过 |
| `pnpm run typecheck` | PASS | 13/14 workspace 项目通过 TypeScript 7 检查 |
| `pnpm run test` | PASS | 52 个 Test Files、288 个 tests 全部通过；pretest 同时完成全量 build |
| `pnpm run build` | PASS | 由 `test` pretest 和 `docs:check` 各执行一次；九个正式包及私有 Core 均成功构建 |
| `pnpm run docs:check` | PASS | TypeDoc、VitePress、docs verify、Playground build/typecheck/verify 均通过 |
| `pnpm run release:verify` | PASS（当前版本） | 九个当前 beta tarball、publint/ATTW、clean consumer 通过；不代表 version-packages 后仍通过 |
| `pnpm changeset status --output /dev/stdout` | 命令 PASS，计划 FAIL | 九个公开包的 `newVersion` 均为稳定 `1.0.0` |
| `git diff --check` / `git diff --cached --check` | PASS（最终快照） | 两种 diff 均无 whitespace error |

构建中的 `@iarna/toml` direct-eval warning 和 VitePress chunk-size warning 没有独立故障证据，本轮不作为 Finding。

### 2.3 `code-review` 双轴结果

| 轴 | 独立结论 |
| --- | --- |
| Standards | 确认有效 Changeset 会把当前 beta 九包直接升至 `1.0.0`；未发现需要把 SDK facade、独立 Platform validator 或 `runProject()` 薄入口判为 smell 的证据。最终工作树的两种 diff check 均通过。 |
| Spec | 独立确认 beta 发行错误、DevSession 异常终态、OpenCode local MCP validator 绕过、Transaction 持久化 barrier 缺口。主审进一步以真实反例确认 lock、MCP smoke、managed deterministic audit、MCP entry/schema 和 Extension 错误扩散。 |

## 3. Findings

### F-01 — [P1][Release] 有效 Changeset 会把九个 beta 包直接升级到稳定 `1.0.0`

- **置信度：100%**
- **精确位置：** `.changeset/initial-1-0-baseline.md:2-15`；`.changeset/kernel-v2-sdk-boundary.md:2-13`；`.github/workflows/patch.yml:50-117`。
- **当前行为：** 两份有效 Changeset 都把九个公开包声明为 `major`；第一份还明确写着 “Promote ... to stable 1.0.0”。`pnpm changeset status --output /dev/stdout` 实测九包的 `newVersion` 全部为 `1.0.0`。
- **为什么是故障：** 本轮明确基线是“当前处于 beta，允许 breaking change，但不得错误进入稳定 1.0”。Patch workflow 会无额外 prerelease 防线地在 `patch.yml:89` 执行 `pnpm version-packages`，因此这是可直接触发的错误发行计划，不是未来建议。
- **最小复现：** 在当前工作树执行 `pnpm changeset status --output /dev/stdout`；检查 `releases[*].newVersion`，九项均为 `1.0.0`。
- **最小修复：** 将未来稳定 1.0 promotion 从当前有效 Changeset 中移出；为 Kernel v2 采用明确、可自动验证的 beta prerelease 策略（Changesets pre mode 或仓库选定的等价方案），同时仍覆盖实际变更的九个包。
- **是否需要架构决策：** 不需要 Kernel ADR；需要维护者明确发行策略并记录在 release guide/Changesets 配置中。
- **修复后测试与 DoD：** `changeset status` 不产生任何稳定 `1.0.0`；九个实际变更包仍有有效 release entry；Patch workflow 对 beta/stable 目标增加断言；`release:verify` 继续验证相同九包。

### F-02 — [P1][Release] Patch 消费 Changeset 后不会更新 init/Migration 使用的唯一生态版本快照

- **置信度：99%**
- **精确位置：** `.github/workflows/patch.yml:65-117`；`packages/acplugin/src/ecosystem-versions.json:1-11`；`scripts/verify-release.mjs:14-19,134-168`。
- **当前行为：** Patch workflow 只执行 `pnpm version-packages` 和 `pnpm install --lockfile-only`，没有刷新 `ecosystem-versions.json`。init、Migration 和 release verifier 都读取该快照；verifier 又要求快照精确等于 package manifests。
- **为什么是故障：** 任意真实版本 PR 都会出现 manifests 已升级、快照仍是旧 beta 的状态。PR 的 Check 只跑 lint/typecheck/docs，可以合并；随后 `release:verify` 会失败，或在未运行该门时让 init/Migration 生成旧版本依赖。所谓“唯一 snapshot”实际成了需人工同步的第二真相源。
- **最小复现：** 将本次 `changeset status` 给出的 `newVersion` 与 `ecosystem-versions.json` 比较，所有九包都不同；按 workflow 的命令序列没有任何一步修改快照。`verify-release.mjs:143` 会在 version 后精确失败。
- **最小修复：** 增加一个仓库内版本快照生成器，从九个 manifest 生成稳定排序 JSON；在 `version-packages` 后、lockfile/lint 前强制执行。Check 中加入只读 `--check` 模式，禁止手工漂移。
- **是否需要架构决策：** 不需要；单一版本源已经是既定架构。
- **修复后测试与 DoD：** 在临时副本执行完整 Patch 命令序列；快照、manifests、init fixture、Migration fixture 和 `release:verify` 同时通过；只改一个独立包时快照只更新对应项。

### F-03 — [P1][Correctness] 事务锁在 create→write 窗口崩溃后会永久阻塞该输出目录

- **置信度：100%**
- **精确位置：** `packages/core/src/transaction.ts:429-457,622-630`；测试缺口位于 `packages/core/test/transaction-v2.test.ts:202-229,364-374`。
- **当前行为：** Core 先以 `wx` 创建最终 lock path，再写 JSON。进程在两者之间崩溃、写入失败或只写入部分内容时会留下空/截断锁。下一次构建在 `JSON.parse` 失败后统一抛出 “Managed output is locked”，不会恢复。首次 write 失败也没有 finally 关闭刚打开的 handle；最终 `rm(lock)` 失败被吞掉，同一仍存活进程的下一轮会把自己的残留 PID 视为活锁。
- **为什么是故障：** 一次可预期进程崩溃即可使 build/dev 永久无法提交，直到用户手工识别并删除内部 lock。它违反“死进程恢复”和 dev 连续重建契约，也使 lock 比 transaction marker 更脆弱。
- **最小复现：** 在临时工程创建空 `.dist.acplugin.lock` 后调用 `commitPackageUnits()`。实测返回 `Managed output is locked. SyntaxError: Unexpected end of JSON input`，且锁仍存在。现有测试只覆盖完整 `{ pid: deadPid }` 记录。
- **最小修复：** 用临时普通文件完整写入、`sync`、原子 hard-link/rename 到最终 lock 的方式同时完成“记录完整”和“互斥获取”；记录不可猜测 owner token，并确保所有失败路径关闭 handle。lock 清理失败不得静默伪装成成功，需要可恢复状态或稳定诊断，同时不能误删活进程的锁。
- **是否需要架构决策：** 不需要；只是在既定独占锁协议内补齐 crash safety。
- **修复后测试与 DoD：** 子进程或 FS fault seam 覆盖 create 后崩溃、部分写、write/sync/close/rm 失败、完整活 PID、完整死 PID、同 PID 残留及并发 writer；每个非活锁状态都可自动恢复，活锁绝不被抢占。

### F-04 — [P1][Correctness] Transaction 的“持久 marker”只 sync 文件内容，没有持久化目录项与 rename 顺序

- **置信度：90%**
- **精确位置：** `packages/core/src/transaction.ts:94-112,503-508,553-600`。整个文件唯一 `.sync()` 位于 `:102`；所有 `link`、`rename`、marker 删除和 backup 删除后均未 fsync parent directory。
- **当前行为：** `.writing` 内容会 `handle.sync()`，随后 hard-link 为最终 marker；但 marker 链接、`out→backup`、`stage→out`、committed marker 和 cleanup 的目录项都没有 durability barrier。恢复逻辑把“无 marker + backup + out 同时存在”认定为已提交 cleanup，直接删除 backup。
- **为什么是故障：** 在支持写回重排的文件系统上，机器/容器持久崩溃可能使 rename 已落盘而 pending/committed marker 的目录项丢失。恢复随后会把仍完整的旧 backup 删除并暴露未完成的新输出，违反“任一阶段失败保留上一份完整输出”。当前 fault tests 只模拟函数抛错或手工逻辑状态，不证明持久顺序。
- **最小复现/可验证路径：** 构造同级 `backup=old`、`out=new`、无 pending/committed marker 的持久状态并进入 recovery；`transaction.ts:503-508` 会保留 new 并删除 old backup。该状态正是目录项重排后可出现的歧义窗口。
- **最小修复：** 明确定义 durability barrier：pending marker link 后 fsync parent；每次 backup/output rename 后 fsync parent；committed marker发布后 fsync parent；删除 backup 与 markers 后按协议 fsync parent。Windows/非 POSIX 平台使用等价可证明的 adapter，不要只依赖文件内容 sync。
- **是否需要架构决策：** 若契约继续包含机器/持久崩溃恢复，则不需要新 ADR；若只承诺“单进程异常、不承诺掉电/宿主崩溃”，必须新增架构决策并收窄文档和测试措辞。
- **修复后测试与 DoD：** 可注入 FS 或持久状态模型覆盖每个 link/rename/unlink/barrier 窗口及 fsync 失败；任何未 committed 状态恢复旧输出，任何 durable committed 状态保留新输出；不存在会误删唯一完整副本的无 marker 歧义。

### F-05 — [P1][Correctness] DevSession watcher reconciliation 异常会产生无 `build-complete` 的轮次和未处理 rejection

- **置信度：98%**
- **精确位置：** `packages/core/src/kernel/dev-session.ts:205-215,245-313,355-399`。
- **当前行为：** `updateWatcher()` 在物理 watcher 成功前先替换 `knownObservations/knownBuildPaths`；`watcher.unwatch(removed)` 没有 await；`watcher.add()`、`getWatched()` 或 5 秒 readiness timeout 抛错时，公开 `build-start` 已发出，但 `round()` 在 `build-complete` 前 reject。`requestDrain()` 以 `void drain()` 丢弃该 rejection。
- **为什么是故障：** 它违反每个公开 start/complete 必须配对、失败轮可观察且 session 可继续恢复的明确契约。监听图的逻辑状态还可能领先于真实 watcher，导致错误去重或漏掉后续依赖事件。
- **最小复现/可验证路径：** 让动态 `watcher.add/getWatched` 永远不显示新路径或令 `unwatch/add` reject；事件序列停在 `build-start`，timer callback 形成 unhandled rejection。当前 DevSession 测试只覆盖成功 reconciliation 和业务失败报告，不覆盖 watcher API 失败。
- **最小修复：** 先完成并 await 物理 unwatch/add/readiness，再一次性提交三份逻辑 snapshot；`round()` 用受控 catch/finally 把 watcher 错误转换为 `phase: dev` 的失败报告并发布配对 complete；所有 fire-and-forget drain 必须显式捕获并进入同一状态机。
- **是否需要架构决策：** 不需要；事件配对和一个 active round 已由 spec 定义。
- **修复后测试与 DoD：** 注入 unwatch reject、add reject、getWatched reject/timeout；断言序号从 1 开始、start/complete 一一配对、无 `unhandledRejection`、last-good graph 保留、失败轮新依赖可恢复、后续成功原子替换 graph。

### F-06 — [P1][Correctness] DevSession close 异常不会进入 terminal state，`closed` 可永久悬挂

- **置信度：99%**
- **精确位置：** `packages/core/src/kernel/dev-session.ts:457-482`；CLI 放大路径为 `packages/acplugin/src/cli.ts:178-188,215-220`。
- **当前行为：** `closeTask` 内顺序 await `active` 和 `watcher.close()`；任一 reject 都会跳过 poller 清理、`closed=true`、唯一 `closed` 事件、listeners 清理和 `resolveClosed()`。并发 `close()` 虽共享同一 rejected Promise，但 `session.closed` 永远不 settle。CLI signal handler丢弃 `close()` Promise，随后等待 `session.closed`，因此可能挂起而不是以 130 退出。
- **为什么是故障：** 关闭是生命周期安全边界；失败时仍必须撤销 watcher/timer/listener 并到达恰好一次 terminal state。当前实现会泄漏资源、悬挂测试/CLI/宿主进程，并使 SIGINT/SIGTERM drain 契约失效。
- **最小复现/可验证路径：** 令 active round 因 F-05 reject，或令 `FSWatcher.close()` reject，然后并发调用两次 `close()` 并等待 `session.closed`；共享 closeTask reject，但 `closed` 不解析且没有 closed event。
- **最小修复：** close 使用单一 try/finally terminalizer；分别捕获 active/watcher cleanup 错误，始终停止 debounce/poller、关闭可关闭资源、设置 closed、发布一次 closed、清空 listeners 并 resolve `closed`。`close()` 是否在 terminalize 后 reject 可保留，但必须有稳定、文档化语义。
- **是否需要架构决策：** 不需要新 ADR；需在公共 API 注释中锁定“cleanup error 与 `closed` settlement”的具体行为。
- **修复后测试与 DoD：** active reject、watcher.close reject、两者同时失败、并发 close、信号到达初始化/active/idle 三种窗口；`closed` 总是 settle，事件恰好一次，active round仍有 complete，CLI 最终 130，无 timer/listener/watcher 残留。

### F-07 — [P1][Correctness] MCP stdio smoke 只查两个 `id/result`，非 MCP 程序也能通过

- **置信度：100%**
- **精确位置：** `packages/extensions/mcp/src/build.ts:48-90`。
- **当前行为：** smoke 要求进程 exit 0，然后逐行 JSON.parse，并查找 `id === 1/2` 且存在 `result`。它不检查 `jsonrpc: '2.0'`、error envelope、重复/错误 ID、initialize 的 `protocolVersion/capabilities/serverInfo`，也不检查 tools/list 的 `result.tools` 数组。
- **为什么是故障：** “本地 stdio MCP 是完整实现，并通过真实 initialize/tools/list smoke”是明确契约。当前 validator 只证明程序打印了两行带 result 的 JSON，不能证明目标平台能建立 MCP 会话。
- **最小复现：** 创建 `server.ts`，启动后直接打印 `{"id":1,"result":{}}` 和 `{"id":2,"result":{}}` 并退出 0，不读取 stdin。通过真实 public `runProject({ command:'validate' })` 实测 `success: true, diagnostics: []`。
- **最小修复：** 建立严格响应解析器：JSON-RPC 版本必须为 2.0；request ID 唯一且类型/值精确；不得有 error；initialize 必须返回兼容 protocolVersion、对象 capabilities 和合法 serverInfo；tools/list 必须返回 `{ tools: [...] }` 且 tool descriptor 至少满足 MCP 基本结构。多余日志需按协议允许的 channel/消息形态处理。
- **是否需要架构决策：** 不需要；MCP handshake 已是既定要求。
- **修复后测试与 DoD：** 当前伪程序、重复 ID、error、错误 protocolVersion、缺 capabilities/serverInfo、非数组 tools 全部失败；真实最小 SDK server 成功；timeout/output 上限和原始 stdout/stderr 脱敏保持成立。

### F-08 — [P2][Correctness] MCP 作者 descriptor 的运行时校验不是 exact discriminated union，且文档化 `./server.ts` 被误拒绝

- **置信度：99%**
- **精确位置：** `packages/extensions/mcp/src/types.ts:41-64`；`packages/extensions/mcp/src/discovery.ts:12-13,72-78,146-180`；Core 路径规则 `packages/core/src/kernel/path-policy.ts:37-52`。
- **当前行为：** 顶层统一允许 HTTP/stdio 全部字段，transport-specific 多余字段会被静默忽略；auth 只查少数字段，不拒绝按 type 不允许的字段；development URL 只特别处理非 loopback `http:`，`ftp:` 等其他协议没有被 Extension 拒绝。公开类型注释写 stdio entry 默认 `./server.ts`，但 discovery 把显式 `./server.ts` 原样传给 Source Service，而 Core 正确拒绝 dot segment。
- **为什么是故障：** JS、`as never`、配置反序列化或第三方生成器可绕过 TS 联合类型；Extension 边界应给出稳定、精确的 portable intersection，而不是静默丢语义。更直接地，作者照公开 API 文档显式填写合法默认值会得到 `MCP_ENTRY_MISSING`。
- **最小复现：** `export default { transport:'stdio', entry:'./server.ts' }`，同目录实际存在 `server.ts`；真实 public validate 实测失败，唯一诊断为 `MCP_ENTRY_MISSING`。另可构造 `{transport:'http', entry:'server.ts'}` 或 `{auth:{type:'none',env:'X'}}`，当前 transport/auth-specific 多余字段不报错。
- **最小修复：** 在 snapshot 后按 transport/auth 建立 exact runtime schema，拒绝所有互斥/未知字段；URL 只允许 production HTTPS 或 development HTTPS/loopback HTTP；在 Source Service 前将被公开允许的单个 `./` 前缀显式规范成 `server.ts`，或同步修改公开契约只接受无 `./` 的安全相对路径。
- **是否需要架构决策：** 不需要；需选择并统一 entry 的公开拼写，但不改变架构。
- **修复后测试与 DoD：** 覆盖 HTTP×stdio 字段交叉、auth 三分支未知字段、ftp/file/带凭据 URL、`server.ts`/`./server.ts`、dot/parent/absolute、env/header ValueSource exactness；类型测试与运行时测试同构。

### F-09 — [P1][Correctness] OpenCode final candidate validator 可把任意现有 Asset 当作 local MCP server 并允许额外参数

- **置信度：100%**
- **精确位置：** `packages/platforms/opencode/src/validator.ts:58-99`；目标契约 `.llmdoc-tmp/specs/acplugin-cross-review-remediation-spec.md:162-174`；官方输出 `packages/extensions/mcp/src/contributors/opencode.ts:24-27,60-67`。
- **当前行为：** local command 只要求字符串数组长度至少 2、首项为 `node`、第二项解析为任意现有 workspace Asset；没有要求恰好两个元素，也没有绑定 server ID、固定 `.opencode/mcp/<id>/server.mjs`、`.mjs` 类型或 executable mode。
- **为什么是故障：** 公开 SDK 第三方 Extension 可以占用合法 `workspace-config.mcp` point，让最终 candidate 通过，却生成目标平台必然无法作为 MCP server 执行的 wire data。Platform 是最终目标协议 owner，不能依赖官方 MCP Contributor 自律。
- **最小复现：** 最小第三方 Extension 贡献 `{ hostile:{ type:'local', command:['node','./opencode.json','--arbitrary'] } }`，不添加任何 server Asset；Platform 自己生成的 `opencode.json` 已在候选 Asset 集中。真实 Kernel validate 实测 `success:true, diagnostics:[]`。
- **最小修复：** 对 server `id` 要求 command 精确等于 `['node', './.opencode/mcp/<id>/server.mjs']`；对应 Asset 必须存在且为 `0755`，并拒绝额外参数和错误后缀。不要把官方 Extension owner 名硬编码进 Platform，以保留合法第三方 Contributor。
- **是否需要架构决策：** 不需要；remediation spec 已给出精确 wire contract。
- **修复后测试与 DoD：** 用 public `/sdk` 最小第三方 Extension 分别注入 wrong-id、任意现有 Asset、非 `.mjs`、额外 args、0644 Asset，全部在 `platform-validate` 失败；官方 MCP local fixture 继续通过。

### F-10 — [P1][Security] managed-rolldown deterministic 审计同时存在普通输出误拒绝与 chunk/asset 绝对路径漏检

- **置信度：100%**
- **精确位置：** `packages/core/src/compiler/managed-auditor.ts:177-235`；契约 `llmdoc/state/sync.md:11-13,19`、`packages/docs/ecosystem/build-service.md:17-27`。
- **当前行为：** deterministic 分支只对 chunk code 搜索每个完整 physical module file ID；不搜索 project/source/package/work/temp 根，也完全不扫描 emitted asset bytes。普通未压缩 Rolldown 输出含 `//#region <absolute module id>`，因此最小 deterministic job 被误拒；设置 `minify:true` 去掉该注释后，Plugin 在 `renderChunk` 注入 project root、在 `generateBundle` 发出同内容 asset，二者都通过。
- **为什么是故障：** 该 public policy 既不能作为可用的确定性模式，也不能实现“稳定输出无绝对/临时路径”的安全边界。第三方 Integration 在完全受支持的 render/generate hooks 内即可把机器路径写进最终 GeneratedAssetRef。
- **最小复现：** 实测同一最小 managed job：`deterministic:true,minify:false` 返回 `Managed Rolldown deterministic output contains an absolute source path`；改为 `minify:true` 并在 render/asset 注入临时工程根，编译成功，`main.mjs` 与 `leak.txt` 均 `containsRoot:true`。
- **最小修复：** deterministic profile 必须先禁止或规范 Rolldown 自带的物理 ID 注释，而不是要求调用方 minify；随后对所有输出 bytes（chunk 和 asset）扫描 Core 已知的 project/source/package/work/temp roots及平台路径形式。审计 marker 至少应包含根而非仅完整文件名。若短期无法给出可证明语义，应暂时移除/拒绝 public `deterministic:true`，不要保留误导性半实现。
- **是否需要架构决策：** 保留既定能力时不需要；若删减/改义 public policy，需要 SDK 级决策记录。
- **修复后测试与 DoD：** 未压缩、压缩、renderChunk、generateBundle string/Uint8Array asset、source map、Windows/POSIX path、project/work/package root 全覆盖；普通 deterministic build 成功，任一输出字节含受保护物理根均失败，报告仍不泄漏路径。

### F-11 — [P2][Correctness] Extension build 失败会被扩散成每个目标 Platform 的 contribution failure

- **置信度：100%**
- **精确位置：** `packages/core/src/kernel/build-session.ts:729-778,800-810`；`packages/core/src/resources/extension-provider.ts:323-365`。
- **当前行为：** build 失败的 Extension 不进入 `built[]`，但其 consumer plan 仍保留；`projectHasErrors()` 明确忽略 extension-owned errors，所以每个 Platform 继续 collect。`collectExtensionContributions()` 找不到 Built State 后抛错，外层再记录 `PLATFORM_CONTRIBUTION_FAILED`。
- **为什么是故障：** 单一 Extension compile 错误被错误归因给所有消费 Platform，污染 phase/owner，降低多平台诊断可操作性，也可能掩盖真正独立的 Platform contribution error。它不是安全隔离所需复杂度，而是 stage 状态没有收敛。
- **最小复现：** 一个 Extension validate 成功、build 抛错并声明 OpenCode contributor；真实 Kernel report 同时产生 `EXTENSION_BUILD_FAILED` 和 `PLATFORM_CONTRIBUTION_FAILED`。增加多个 Platform 时会线性扩散。
- **最小修复：** build 失败后从 contribution collection 中剔除该 Extension plan，或显式把 plan 标记 failed 并只跳过其 contributor；其他成功 Extension 和独立 Platform 继续执行。不要把 extension error 提升为 project-global error。
- **是否需要架构决策：** 不需要；仍保持无序、同 base、跨 Extension 隔离。
- **修复后测试与 DoD：** 一个失败 Extension、一个成功 Extension、两个 Platform；只出现一个 extension compile 诊断，成功 Extension 仍在两个 Platform 贡献，不出现派生 Platform error，close 仍逆序执行。

## 4. Architecture Matrix

| 子系统 | 架构匹配度 | 实现完整度 | 复杂度判断 | 建议 |
| --- | --- | --- | --- | --- |
| Core / Rolldown | 高 | 中高 | 两个 profile、capability host、真实 module/license/watch graph 是合理复杂度；deterministic audit 是局部错误实现 | 保留；局部修复 F-10 |
| Core Node Runtime | 高 | 高 | auto/explicit、一次 compile、多平台同 AssetRef、capability delivery 均直接对应需求 | 保留 |
| Hooks | 高 | 高 | 作者语义结果与 wire profile 分离、单次 portable build、runner 限制和六 Contributor 已成立 | 保留；补 exact JSON 边界回归即可 |
| MCP | 高 | 中 | Core compile/execution/secret reference 方向正确；descriptor exactness 与真实 handshake 未收口 | 局部修复 F-07/F-08 |
| Claude Code | 高 | 高 | 深层 Hook/MCP validator、Plugin/Marketplace owner 均在 Platform | 保留 |
| Codex | 高 | 高 | Command/Agent fallback、Skill metadata、Hooks/MCP final validation 完整 | 保留 |
| Cursor | 高 | 高 | 原生 Components、remote MCP 与 Hook final validation 成立 | 保留 |
| Antigravity | 高 | 高 | Skill transformation、remote MCP/Hook validator 和 unsupported Runtime 明确 | 保留 |
| OpenCode | 高 | 中 | first-class workspace 和唯一 `opencode.json` 已正确；local MCP closure 可绕过 | 局部修复 F-09 |
| Pi | 高 | 高 | Prompt/Skill 转换、MCP/Runtime unsupported 且不生成伪实现 | 保留 |
| Transaction | 中高 | 中 | marker/backup/stage/swap 的必要复杂度合理，逻辑窗口大多自洽；lock 与 durability barrier 不完整 | 聚焦 crash protocol 局部重写，不重写 Package/Asset |
| DevSession | 高 | 中 | 一个 active round、coalescing、last-good+failure graph 是合理状态机；异常 terminalization 不完整 | 局部重写 error/finally 路径 |
| Lifecycle / Package | 高 | 高 | 同一 frozen base、无序 add-only merge、owner/path/field conflict、merge 后 finalize/validate 已成立 | 保留 |
| Migration | 高 | 高 | CLI 唯一动态 import；legacy 只在隔离子系统内；正常 Core/Platform/Extension 无反向 import | 保留 |
| Docs / Playground | 高 | 高 | Runtime、九包、公开 API 和 Playground 基本同构；只剩质量门与少量语义锁定 | 局部修复 |
| Release | 中 | 低 | 九包独立 tarball/peer/consumer 边界已好；版本计划与快照自动化错误 | 优先修复 F-01/F-02 |

补充确认：

- Runtime 自动发现只取 `src/runtime/` 一级受支持 TS/JS，显式 `runtime.entries` 完整替换自动发现；嵌套文件只通过 Rolldown graph 成为依赖；空目录无 Runtime/compatibility 噪声。
- Runtime 只编译一次，Claude Code/Codex 通过同一 Built AssetRef 继承；其余平台只报告 unsupported，不生成伪 Runtime。
- `@tokenroll/acplugin` 构建实际 bundle 私有 Core；release verifier 证明没有 bundle/re-export 官方 Platform/Extension，九个 tarball 无 `@acplugin/*` 运行时边。
- Platform/Extension 正式源码通过 `@tokenroll/acplugin/sdk`；跨 tarball `Symbol.for` brand 在 clean consumer 中工作。
- Migration 仅在 `packages/acplugin/src/cli.ts:318` 动态 import；正常路径没有 Migration 反向边。
- `transpileModule`、Integration-local `bundler.ts/adapters.ts`、旧 Artifact/DeliveryUnit/Scanner 实现、第二 lifecycle 和 `output-paths.ts` 已从正式生产路径删除。

## 5. Over-design and Complexity Audit

### 5.1 合理且应保留的复杂度

- **SourceRef/AssetRef + owner registry：** 这是防 forged ref、跨 owner 读取、TOCTOU、symlink/special file、case/NFC collision 的真实安全边界，不是为了类型美观制造的层级。
- **base → unordered contributions → merged → finalize → materialize/validate：** 它同时解决扩展无顺序语义、Document point/Asset path 冲突、Platform 最终协议 owner 三个真实需求，职责清晰。
- **portable-node / managed-rolldown 双 profile：** Runtime/Hooks/MCP 需要受限可移植 executable；第三方 Integration 需要更广 Rolldown plugin 能力。二者是两个真实用例，不应强行合并。
- **Platform 独立 validator：** 六个公开 tarball拥有不同 wire protocol；重复少量 JSON/path helper 比把目标协议下沉 Core 更正确。
- **事务与 Dev 状态机：** whole-output 替换、subset commit、崩溃恢复、动态 graph 和 signal drain 本身就需要状态，不应以“比 Vite 配置多”判为过度设计。

### 5.2 可删除或收敛的复杂度

- `managed-rolldown.policy.deterministic` 当前是半实现：修完整，否则 beta 阶段直接移除，不能让调用方用 minify 偶然规避误报。
- DevSession 同时提前修改 `knownObservations/knownBuildPaths`、再异步修改 `watchedPaths`，造成三份状态不同步；应收敛为一次可测试的原子 reconcile，而不是继续堆补偿条件。
- Release 的手工 `ecosystem-versions.json` 更新责任应由生成器消除，避免第二真相源。
- failed Extension plan 不应继续流入每个平台的 contribution 阶段；删除这条派生路径比增加错误映射层更简单。

### 5.3 错误抽象与不应新增的抽象

- 当前没有证据表明 Core/Facade/Platform/Extension/Resource Provider 的总体分层错误；`runProject()`/`Project` 薄 facade 和 SDK `definePlatform/defineExtension` brand 工厂有清晰公共边界，不是无职责 Middle Man。
- 不应把六平台 Hook/MCP validator 抽成 Core “通用目标协议”；只有安全路径/JSON codec/Asset ownership 属于 Core，wire schema 必须留在 Platform。
- 不应恢复 Extension dependency graph、顺序、claim/suppress/override、跨 Extension state；当前没有两个以上真实用例，且会破坏 add-only 模型。
- 不应把 Runtime 再包装为 descriptor/factory/Contributor/Manifest patch 或公开 Extension。
- 不应为修复 F-11 增加第二生命周期；只需让现有 stage plan 显式收敛失败状态。

### 5.4 与 Nuxt/Vite、tsdown/Rolldown 类关系的判断

ACPlugin 比典型 Vite plugin runner 更复杂，但主要增量来自它承诺的 **多平台最终协议、owner-isolated author assets、第三方 Integration capability、全目录原子提交、严格 compatibility tuple 和持久 dev graph**。这些不是简单 bundler wrapper 会自然提供的能力，因此总体复杂度合理。真正偏离“开箱即用”的部分不是抽象数量，而是少数安全选项/异常状态机没有兑现自己的契约；修复这些局部后，无需整体重写。

## 6. Previous Finding Audit

| 历史重要结论 | 当前状态 | 本轮证据 |
| --- | --- | --- |
| Transaction 缺少 pending/committed 区分，swap 后崩溃恢复歧义 | **已解决（逻辑进程崩溃层面）** | `.writing → sync → hard-link`、pending+committed 双 marker 与现有 crash-state tests 已建立；但 F-03/F-04 的 lock/durability 仍成立 |
| DevSession 尚未实现/CLI 自建 watcher | **已被新架构取代** | Core `createDevSession()` 是唯一 watcher owner，CLI 只订阅事件 |
| DevSession 初始化伪事件、sequence、listener isolation、active close 配对 | **已解决（成功路径）** | 新 untracked 测试实际通过；sequence 1、start/complete、一次 closed、并发 close identity、listener auto-remove 均有证据 |
| DevSession error/watch/close 收敛 | **仍然成立** | F-05/F-06 |
| 五个平台只验证 sidecar 引用、不验证完整 wire | **大部分已解决** | Claude/Codex/Cursor/Antigravity 深层 validator 和 hostile fixtures 已存在；OpenCode local closure 仍有 F-09 |
| OpenCode MCP 生成错误 sidecar/与 workspace config 不同构 | **已解决** | 官方 Contributor 只写 `workspace-config.mcp`，最终生成唯一 `opencode.json` |
| Runtime 被实现为 Extension/descriptor/factory | **已被新架构取代** | Core Framework Resource、固定 owner、一次 portable compile、capability delivery 已成立 |
| Hooks/MCP 自建 bundler/adapters | **已解决** | 旧文件删除，二者调用同一 Core portable-node/Execution/License 基础设施 |
| 主包 bundle/re-export 官方 Integration，公开包泄漏 `@acplugin/*` | **已解决** | 九 tarball release verify 和 clean consumer 通过 |
| SDK brand 跨独立 tarball 不工作 | **已解决** | 共享 `Symbol.for(...apiVersion)`，clean consumer 实际通过 |
| parseAst 顶层加载、Migration 污染正常启动 | **已解决** | Migration 是 CLI dynamic chunk；正常 Core/Platform/Extension 无 import |
| OpenCode/Runtime/发行文档仍描述旧 Adapter/DeliveryUnit/Runtime Extension | **已被新架构取代/基本解决** | 正式架构文档明确当前模型；旧词只在历史/legacy 语境出现时不构成 Finding |
| 发行 consumer、peer rewrite、版本快照未建立 | **部分解决** | tarball/peer/consumer 和当前快照验证已通过；beta Changeset 与 version 后 snapshot 更新仍为 F-01/F-02 |
| `@iarna/toml` eval warning、VitePress chunk warning | **误报（缺少实际故障）** | 当前构建/文档/consumer 全通过，本轮无新影响证据 |

## 7. Test and Verification Gaps

这些是现有质量门通过后仍未覆盖的关键缺口；其中已能产生确定故障的部分已升级为 Findings：

1. Transaction 没有 empty/truncated lock、write/sync/close/rm lock failure、活/死 PID race、marker final truncation/mismatch、backup/marker 删除失败及 parent fsync barrier 的完整 fault model。
2. Transaction 现有 phase injection 是同进程 throw+rollback，不等价于进程被杀或目录项持久化重排；需要 subprocess/crash-state tests。
3. DevSession 没有 watcher `unwatch/add/getWatched/close` rejection/timeout、active reject、`unhandledRejection`、并发 close failure 测试。
4. `DevSession.current` 在旧 Kernel spec（最近完成轮，包括失败）与较新 remediation spec/实现（最近成功或首轮失败）之间冲突。当前实现遵循较新规则，但公共类型没有写明；应先锁定语义，再加 success→failure→recovery 测试。本轮不把实现本身判为 Finding。
5. MCP smoke 没有负向 JSON-RPC/MCP shape matrix；现有“正常 server”用例不足以证明 handshake。
6. MCP descriptor 没有 transport/auth exact union、协议 scheme 和显式 `./server.ts` 回归。
7. managed deterministic tests 当前为零；应覆盖 Rolldown region comments、chunk/asset bytes、root variants 和 minify/non-minify。
8. OpenCode hostile fixture已有 malformed escape，但没有“指向任意已存在 Asset”和额外 args；本轮 public-style Kernel fixture已证明绕过。
9. Extension build failure没有断言不产生派生 Platform diagnostics。
10. `packages/core/src/compiler/portable-policy.ts:6-7` 的 builtin allowlist来自执行构建的宿主 Node，而产物契约是 Node 20。当前没有找到可稳定复现的 Node 22-only builtin反例，因此不列 Finding；应在 Node 20 job对每个允许 external 做真实 import/execute closure。
11. 当前本地 `release:verify` 在 Node 22 运行；workflow 的 Node 20 consumer设计正确，但本轮未在本机切换 Node 20 重跑。该项应继续由 CI Verify job守卫。

## 8. Recommended Fix Order

### Phase 0 — 立即冻结错误发行路径

- **Scope：** F-01、F-02；移出 stable promotion Changeset，确定 beta prerelease 规则，增加版本快照 generator/check。
- **Non-goals：** 不 publish、不创建 tag/release、不统一九包版本、不引入 fixed group。
- **测试：** changeset status、Patch 临时副本演练、lint/typecheck、diff check、release:verify。
- **DoD：** 不可能由当前 Patch 产生稳定 1.0；version PR 自动同步 snapshot；所有当前质量门通过。

### Phase 1 — 修复输出完整性协议

- **Scope：** F-03、F-04；锁的原子发布/owner、目录 durability barrier、完整 persistent crash matrix。
- **Non-goals：** 不重写 AssetRegistry、PackageUnit、candidate materialization 或 subset semantics。
- **测试：** 子进程 kill + FS fault injection 覆盖每个 marker/link/rename/unlink/fsync/cleanup 窗口。
- **DoD：** 活 writer 不被抢占；死/截断锁自动安全恢复；未 committed 永远回到旧完整输出；durable committed 永远保留新完整输出；无人工删除内部文件要求。

### Phase 2 — 让 DevSession 所有路径到达可观察终态

- **Scope：** F-05、F-06；原子 watcher reconcile、round error report、close finally terminalizer、CLI signal error path。
- **Non-goals：** 不增加第二 watcher、跨 round cache或 Integration watcher hook。
- **测试：** watcher API fault matrix、active failure、并发 close、listener failure、SIGINT/SIGTERM 三窗口、current 语义回归。
- **DoD：** 每个 start 有且仅有一个 complete；closed 恰好一次且 Promise 必 settle；无 unhandled rejection/悬挂 handle；last-good 输出/graph恢复成立。

### Phase 3 — 收紧 Core build 与 MCP/Platform 信任边界

- **Scope：** F-07、F-08、F-09、F-10。
- **Non-goals：** 不把目标 wire 下沉 Core；不新增第三套 compiler profile；不限制合法第三方 Contributor 只能来自官方包。
- **测试：** managed chunk/asset绝对路径矩阵、真实 MCP handshake负例、descriptor exact union、OpenCode public SDK hostile fixture。
- **DoD：** deterministic 普通 build可用且所有 bytes 无物理根；伪 MCP失败；作者文档化 entry成功；OpenCode只接受固定 local bundle closure；官方六平台输出继续通过。

### Phase 4 — 清理派生诊断并完成最终回归

- **Scope：** F-11、`DevSession.current` 公共语义、历史 finding 状态与文档同步。
- **Non-goals：** 不增加 Extension dependency/order/override 系统，不为了共用 validator 制造 Core wire abstraction。
- **测试：** failed+successful Extensions×多 Platform、全量 commands、九 tarball clean consumer、Node 20 Verify job。
- **DoD：** 错误 owner/phase 精确，无派生噪声；文档/类型/测试描述同一 current 语义；所有临时反例转为仓库回归测试。

最终统一 DoD：

```text
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run docs:check
pnpm run release:verify
git diff --check
git diff --cached --check
pnpm changeset status --output /dev/stdout
```

除命令全部通过外，`changeset status` 还必须保持 beta，且本报告列出的 hostile/crash fixtures 必须从“错误地成功/悬挂”变为预期失败或安全恢复。

## 9. Final Decision

**`NOT_READY`**

原因不是总体架构偏航，也不是需要推倒 Kernel v2；原因是当前仍有可复现的 release blocker、transaction crash blocker、DevSession terminal-state blocker、MCP protocol false positive、OpenCode final-validation bypass 和 managed deterministic output leak。先按 Phase 0–3 修复 P1，再完成 Phase 4 和全量 DoD，可重新评估为 `READY_WITH_NON_BLOCKING_FOLLOWUPS` 或 `READY`。
