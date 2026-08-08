# acplugin 1.0 重构 / 品牌升级 —— 架构与代码 Review 报告

> **历史审计材料：** 本文记录修复前的 review 快照，不是当前实施权威。实际施工以 `.llmdoc-tmp/specs/acplugin-1.0-hardening-spec.md`、对抗复核后的方案及当前源码/稳定 `llmdoc/` 为准。

> 审阅对象：`@tokenroll/acplugin` 1.0（TokenRoll）—— 平台中立 Plugin 作者工程 + CLI，将同一工程编译为 Claude Code、Codex、Cursor、Antigravity、OpenCode、Pi 六个平台的原生交付单元，外加 Hooks / MCP 两个可选官方 Extension。
> 基准规范：`.llmdoc-tmp/specs/tokenroll-acplugin-1.0-spec.md`
> 审阅日期：2026-08-07
> 审阅方式：主控独立通读 Core（scanner / lifecycle / transaction / contracts / documents / diagnostics / reports / config）+ 12 条子代理深读通道（Core×3、Platforms×2、Extensions、CLI、Migration、Testing/Tooling）+ 3 条外部调研通道（对比主流构建工具 / 平台 Schema 时效性 / 工具链时效性）+ 4 项高危发现的对抗式独立复核。共 16 个代理、~250 万 token、0 失败；全部 4 项复核结论为 **CONFIRMED**。

---

## 0. 结论速览（TL;DR）

**这是一次高质量的重构。** 架构设计是本次 review 的最大亮点：固定生命周期、owner-aware add-only 文档合并、事务式全量提交、符号品牌名义类型、按 owner 隔离的产物来源授权 —— 这些不是过度设计，而是针对「一份工程 → 六个平台、强所有权 / 强确定性 / 强安全边界」这个具体问题域**比主流插件系统的默认选择更贴切**的取舍。Core 的路径安全（符号链接逐段 lstat、NFC+大小写折叠冲突检测、`..`/绝对路径拒绝）、依赖图环检测、事务崩溃恢复（同文件系统 rename、死进程锁回收、回滚保留旧输出）都达到生产级水准。

**工程健康度（本机实测）：** `typecheck` ✅、`lint`（含 131 文件中文注释守卫）✅、`build`（含 publint + attw）✅、`test` **59/60**（唯一失败即下方 REDACT-1，且其失败依赖运行机器的环境变量 —— 这本身是一个 CI 卫生信号）。

**真正需要处理的问题集中在 5 处，无一是架构性缺陷：**

| # | 严重度 | 问题 | 位置 | 复核 |
|---|--------|------|------|------|
| **F1 (REDACT-1)** | 高 | 报告脱敏用「环境变量值子串替换」这一错误原语，默认作用于 `process.env`，破坏 §18 跨机确定性并会污染合法标识符（`claude-code` → `<redacted-env>-code`） | `core/src/diagnostics.ts:49-54,73-74`；`lifecycle.ts:220`；`reports.ts:131` | ✅ CONFIRMED ×3 |
| **F2** | 高 | `buildEnd` 清理错误在事务 `afterSwap` 内抛出，会**回滚一个已验证、已提交成功的构建**并报告为失败 —— 违反 §9.4「buildEnd 不得掩盖原始失败」 | `core/src/lifecycle.ts:704-714` | ✅ CONFIRMED |
| **F3** | 高 | Migration 无规范 ID 冲突防护：`safeId()` 多对一，冲突资源静默互相覆盖（`Promise.all` 竞争），报告却仍标记双方 `migrated` —— 静默数据丢失 + 虚假成功报告 | `acplugin/src/migration/index.ts:221-225,1350-1358,1591-1611` | ✅ CONFIRMED |
| **F4** | 高 | PR CI（`check.yml`）只跑 lint+typecheck，**从不运行测试或构建**；tarball/consumer 验收只存在于手动脚本 | `.github/workflows/check.yml:21-22` | ✅ CONFIRMED |
| **F5** | 高（时效） | `engines.node: ">=20"` 已过时且自相矛盾：Node 20 于 2026-04-30 EOL，ESLint 10 要求 ≥20.19，tsdown 0.22 根本不支持 Node 20（需 ≥22.18）；构建能过仅因开发机是 Node 22.21 | 三个公开包 `package.json` + 规范 §4.1 + `AGENTS.md` | 外部调研 |

除此之外还有一批中/低优先项（重复代码、二级平台兼容矩阵测试缺失、确定性测试缺口、注释守卫防漂移等），详见第 4~7 节。

---

## 1. 审阅范围与方法

- **主控独立通读**（作为子代理结论的交叉校验，非二手）：`scanner.ts`、`lifecycle.ts`、`transaction.ts`、`contracts.ts`、`documents.ts`、`diagnostics.ts`、`reports.ts`、`config.ts`、`artifacts.ts`、`run-project.ts`、`migration/index.ts`、`tsdown.config.ts`、`check-comments.mjs`、CLI JSON 输出路径。
- **12 条内部深读通道**：core-lifecycle / core-datamodel / core-scanner / platforms-primary(Claude,Codex) / platforms-secondary(Cursor,Antigravity,OpenCode,Pi) / extensions(Hooks,MCP) / acplugin-cli / migration / testing-tooling。每条逐文件比对规范 MUST/MUST NOT。
- **3 条外部调研通道**：① 与 Vite/Rollup/unplugin/esbuild/changesets/oclif 等主流方案对比架构取舍；② 用各平台 2026 官方文档核验生成的 manifest 形状；③ 核验 TS7/rolldown/tsdown/Vitest4/ESLint10/Node/ESM/pnpm-catalog 的时效与风险。
- **对抗式复核**：对 correctness/security/determinism/spec 类高危发现，另派独立代理重读源码、默认怀疑、能否证伪。4 项全部 CONFIRMED。

> 说明：所有「已确认」缺陷均有 `file:line` 证据并经复核；数据丢失 / 崩溃类问题一项也没有出现。4 项高危复核最终都定级为 `high` 而非 `critical` —— 因为即便触发，事务完整性仍保证磁盘要么是旧的完整输出、要么是新的完整输出，不会损坏。

---

## 2. 架构评估：设计是否合理

**总体：合理，且多处优于主流默认。** 逐项对照主流方案：

### 2.1 明确是「强项」的设计（保留）

- **固定、不可重排的生命周期（Platform-then-Extension，配置顺序，§9.4 十五步）。** 主流 Vite/Rollup 需要 `enforce`/`order` 是因为互不知晓的 userland 插件在**共享可变模块图**上争抢；acplugin 的问题域相反 —— 封闭的 6 平台 + 2 官方 Extension，且每个 document 字段只有唯一写者。用「配置顺序 = 执行顺序 + 单写者」从构造上消除了争抢，§10.2 的报告/产物确定性顺序自然成立。这是比 Rollup 更贴合、接近 esbuild「不给顺序保证、让你合并成一个插件」哲学的正确取舍。
- **owner-aware add-only `DocumentAddPatch`（对比主流 deep-merge）。** `patchDocument` 强制：父路径必须已存在且为对象、目标字段必须不存在（禁止 replace/remove/move/数组 append/隐式 deep-merge）、扩展点必须由 Platform 预声明且为空、每字段记录 Extension owner、重复写入直接冲突报错。deep-merge 的经典故障（同 key 静默 last-writer-wins、数组歧义）正是 §10.2 所禁止的非确定性；此处是对主流默认的**刻意且正确的反转**。（主控独读 `documents.ts` 逐行确认：`isEmptyField`/`addField` 用 `Object.hasOwn` 使 `__proto__` 污染 fail-closed，克隆时按 `localeCompare` 排序键 → 字节稳定序列化。）
- **事务式全量提交 + 崩溃恢复。** wx 锁文件 + 死进程 `kill(pid,0)/ESRCH` 回收、同级 stage 目录保证同文件系统 rename 原子性、旧 outDir 留作 backup、swap/afterSwap 失败回滚、下次取锁时清理中断事务/陈旧 stage、`AggregateError` 同时保留原始与回滚错误。这**高于同生态标准**（多数打包器 rimraf+write，崩溃即残缺输出），且精确匹配 §10.3「失败必须保留上一份完整输出、不得只提交成功平台」。
- **「用户配置不进编译器」边界。** Platform 只拿到深度冻结的 JSON options 快照，`normalizeJsonValue` 拒绝非普通对象/函数/非有限数/循环引用；`runProject` 只暴露 cwd/config/command/mode/platform 子集/strict/commit，无 Compiler Registry / 可变 Draft / 写回调逃逸口。配合按 owner 隔离、无共同父目录的产物来源授权，构成真正的多 owner 隔离安全边界（§18 威胁模型）。主流插件系统不做是因为它们的插件都是同等可信的 userland；acplugin 因为跨了 jiti 动态加载边界，做得更严是**对的**。
- **符号品牌名义类型。** 编译期 `declare const brand: unique symbol`（零运行时成本，防裸字符串冒充 id）+ 运行时模块私有 Symbol（在信任边界重校验 brand+apiVersion+shape）。因为配置经 jiti 从用户 TS 动态加载，运行时校验是必需的，不是镀金。
- **Draft → 只读快照 → Core 密封 DeliveryUnit 的状态窄化。** 比 Rollup 恒可变的 `OutputBundle` 更干净，且使「Platform 必须序列化每个 Document、透传每个继承 Artifact」这一不变量可校验（`lifecycle.ts:621-636` 缺失即抛错）；密封时附 sha256+size+mode 正是事务落盘后重新哈希校验的前提。
- **Extension build-once / adapter-reuse。** 与 unplugin「中立核心 + 逐目标适配」同理，但 adapter 是带 apiVersion 握手的一等契约、且「一 Extension 对一 Platform 唯一 adapter、bridge 与官方冲突是配置期错误而非隐式覆盖」比 unplugin 的隐式合并更严格。

### 2.2 架构层面的弱点 / 缺口

- **W1（中）无缓存 / 增量能力，但 §18 明确 MUST 一个 content/config/tool-version keyed 的 dev cache。** 现实现里 `dev` 每次防抖变更全量重跑 `executeProject`，jiti 显式关闭缓存（`project-config.ts:141` `moduleCache:false, fsCache:false`）。这是**实现与自身规范矛盾**的一处：`build-once extension bundle` 那条 §18 要求做到了，但 dev cache 这条完全没有。6 个小平台下全量重建在体感上可接受，所以作为产品缺口是次要的，作为 spec-conformance 缺口是真实的 —— **要么实现，要么把该 MUST 降级为 MAY**（推荐后者，符合 YAGNI）。
- **W2（中，规范表述）串行执行 + 「未来并行不得改变可观察顺序」是未预算的承诺。** 平台严格串行（`lifecycle.ts:510`），对 6 目标是合理的（YAGNI）；但平台本就独立（隔离 workDir、无共享可变状态），规范承诺「未来并行不改变可观察顺序」并非一行代码 —— 现有单一共享 `DiagnosticCollector` 未按此结构化，真要并行需先做「按平台分桶 → 配置顺序合并」。建议在规范里注明该承诺的代价，避免被读成「免费」。
- **A1（架构一致性，中）六个平台包 + 两默认平台间大量小工具函数逐字复制。** `report`/`isRecord`/`isNonEmptyString`/`SEMVER_PATTERN`/`serializeDocuments` 守卫/引用与路径安全 helper 在 6 个平台里各写一份；Codex 包内甚至有**三个行为等价但实现不同**的路径安全函数（`isSafeSkillPath` split、`isSafePluginReference` posix.normalize、`isSafeCodexPluginPath` split）。今天等价，但没有任何东西保证它们保持一致 —— 在「强确定性」姿态下，多份 `SEMVER_PATTERN`/`isRecord` 的潜在漂移是真实维护风险。建议把**平台无关的纯 helper**（不含平台语义，故不违反 §3「Core 不知具体平台」）提升到 Core 内部共享模块，并把 Codex 三个路径函数收敛为一个。

---

## 3. 已确认缺陷（详情、影响、修复建议）

### F1 / REDACT-1（高，跨 3 个通道 + 3 次独立复核确认）—— 报告脱敏原语选错

**根因：** `diagnostics.ts:49-54` 的 `environmentValues()` 收集**每一个**长度 ≥4 的 `process.env` 值，`sanitizeReportText`（:73-74）对每个值做 `safe.split(v).join('<redacted-env>')` —— **无边界的子串替换**，不是 token/词边界匹配。而 `executeLifecycle`（`lifecycle.ts:220` `request.environment ?? process.env`）与 `serializeBuildResult`（`reports.ts:131`，CLI 在 `cli.ts:62` 不传 options）都**默认落到 `process.env`**。

**双重危害（复核逐条复现）：**
1. **确定性（违反 §18 / 验收标准 8）：** `process.env` 不在 §18 列举的确定性输入内（工程字节、command/mode、Platform/Extension 版本、Node major、lockfile），却参与脱敏 → 同一工程字节在不同机器产出不同报告字节。本机 `SUPERSET_AGENT_ID=claude` / `SHELL=claude` 触发 `claude-code` → `<redacted-env>-code`、`.claude-plugin/plugin.json` → `.<redacted-env>-plugin/plugin.json`（这正是唯一失败测试的根因）。
2. **正确性：** 对结构字段（platform id、document id、artifact path）盲目子串替换，会污染任何恰好包含 ≥4 字符 env 值子串的**合法文本**：复核实测 `1.0.0`（`npm_package_version`）、`true`（`CI`）、`main`（`GIT_BRANCH`）、`node`（`_`）均被改写。用户读来 debug 的 `diagnostic.message`/`compatibility.reason`/`metadata.reason` 会被静默改成 `<redacted-env>`。CLI `--json` 里 `artifacts[].path` 被污染后指向磁盘上不存在的路径（磁盘从 `finalUnits` 原始字节提交，仍正确，于是**报告与磁盘 desync**）。

**为什么现有兜底不够：** `reports.ts:117-133` 的 `protectedValues` 只排除**完全相等**的 schema/身份值 —— `claude`（`claude-code` 的严格子串）不在其中，仍被替换；且该兜底只在 `serializeBuildResult` 路径，`createBuildResult` 返回给 `runProject()` 调用方的**程序化 BuildResult 完全没有保护**。这证明子串方案无法逐字段打补丁修好。

**修复（在共享函数一次修复所有 caller）：**
- 删除 env 值子串替换整条逻辑；真正的密钥已由结构化手段可靠处理（`SECRET_KEY_PATTERN` 脱敏凭据形对象键、`Bearer/Basic/token=` 正则脱敏内联凭据、路径剥离）。正确姿态是**在源头就不把密钥值放进报告文本**（§18 本就禁止为声明读取 Secret 值），而不是事后用机器本地 env 快照去 grep（既过度包含污染真实文本、又不足包含漏掉任何不在当前 env 或经过变换的密钥）。
- `executeLifecycle` 停止默认 `process.env`，脱敏环境默认空 → 报告与机器无关。
- 若仍要保留机器密钥兜底：只对显式声明的密钥引用（Hook/MCP descriptor 已声明它们读哪些 env 变量，§14）生效，且只作用于 free-text message/reason/hint，**绝不**碰 id/path/code 等结构字段。
- **配套测试**（见 F4/测试缺口）：用一个含 `claude`/`1.0.0` 等平台 id 子串的真实 env-like map 跑完整 lifecycle，断言 platform id / path 完好。

### F2（高，复核确认）—— buildEnd 清理错误回滚已成功的构建

**根因：** commit 分支里 `finalize()`（会执行所有 platform/extension 的 `buildEnd`）被放进 `commitDeliveryUnits` 的 `afterSwap` 回调（`lifecycle.ts:708-712`）。`afterSwap` 在 `output-swapped` 之后、删除 backup 之前触发（`transaction.ts:388→407`）。若任意 `buildEnd` 抛错或发出 error 级诊断（`PLATFORM_/EXTENSION_BUILD_END_FAILED` 均 severity=error），`afterSwap` 重新抛出 → `commitUnitRoots` 把它当作 swap 失败：`fs.rm(resolved)` 删掉**刚刚换入、已通过 Registry + 候选校验的新输出**，再 `rename(backup, resolved)` 恢复旧 dist。于是一个通过全部 13 步的成功构建被拆毁，`committed` 停在 false、`success` 变 false —— 纯粹因清理阶段错误，正是 §9.4 禁止的「buildEnd 掩盖（此处是制造）失败」。

**影响：** 第三方或官方 platform/extension 的 `buildEnd` 抛错（Windows 上临时目录 EBUSY、日志错误等）会**销毁并回滚用户的 dist**、把成功 `build` 报成失败；期间还有一个 dist 短暂缺失的 I/O 窗口；且成功/失败取决于清理期环境 → 破坏确定性。缓解点（决定它是 high 而非 critical）：回滚落到一致状态（旧 dist 完整、无残缺、无损坏），且仅在 buildEnd 真的抛错时触发。**现有唯一 buildEnd 失败测试走的是 `validate`（不提交）路径，commit 路径的 afterSwap→回滚从未被测试覆盖。**

**修复：** 不要用 buildEnd 结果去 gate 事务 afterSwap。让 commit 完全完成（删 backup）后，在外层 finally 里跑 `finalize()`（与 non-commit 路径一致），把 buildEnd 错误记为诊断但**不下调 committed/success**。afterSwap 里不应放任何「本该回滚 swap」之外的工作（此处没有）。

### F3（高，复核确认）—— Migration 规范 ID 冲突导致静默数据丢失

**根因：** `safeId()`（`index.ts:221-225`）多对一：`my_tool`/`my-tool`/`My Tool` 都 → `my-tool`；无字母数字的名字 → 常量 `migrated-item`。全代码库**没有任何** emitted-ID/destination 注册表（各处 `new Set(...)` 都是字段白名单或关键词去重）。`copyText` 是 `fs.writeFile` = 静默覆盖。

**后果链（复核在每个位置确认）：**
- Skills：`destination = src/skills/<id>/SKILL.md`，无条件 push 一个 `migrated` item，写入在 `Promise.all(writes)`（:1358）下 —— 冲突 id 竞争、幸存者不确定、双方都被报告为成功。命令/agent/MCP 同样静默覆盖（MCP 顺序写入 → 确定性覆盖但仍双报）。
- `--all` workspace：`projectRoot = path.join(stage, safeId(plugin.meta.name))`（:1597）—— 同名 marketplace plugin 共享一个 stage 目录、互相覆盖 `acplugin.config.ts`/`package.json`，且 `projects.push(id)` 两次 → `pnpm-workspace.yaml` 出现重复 glob。
- **报告谎报成功：** 诊断只来自 `validateCanonicalProject` 重扫磁盘幸存文件，对 `items` 零可见性 —— 单个幸存 skill 校验通过 → `success=true`，而 `items` 仍列两者为 mapped。**违反 §17.2（每资源结论必须准确）与 §18（相同输入字节稳定输出）。**

**修复：** 维护 per-kind 的 emitted 规范 ID 集合（及 `--all` 的 per-stage workspace 目录集合）。冲突时确定性消歧（如 `<id>-2`）或把落败资源标 `unmapped`/`degraded` 并给稳定原因，使任何写入都不被静默覆盖、报告反映真实。

### F4（高，复核确认）—— CI 不跑测试与构建

**根因：** `check.yml` 唯一的 run 步骤是 `pnpm run lint` 与 `pnpm run typecheck`，**没有 `pnpm test`、没有 `pnpm build`**（除手动 `patch.yml` 外无其他 workflow）。全工作区 174 个 `it()` 与 tsdown 构建从不在 PR 上自动执行。

**影响：** 破坏任意测试或破坏 tsdown 构建的 PR 会绿灯通过必需 CI。§19.2.11 把 lint/typecheck/test/build/package-verification 都列为验收门，CI 只强制了前两个。尤其构建是「六个私有平台被内联进公开包」的环节 —— 一个**不可构建的发布**可能无人察觉地合入。附带：§19.1.12 的 tarball/publint/attw/clean-consumer/Pi-pack 验收只存在于手动 `release:verify` 脚本，任何自动门都不跑它。

**修复：** 给 `check.yml` 加 `pnpm run test` 与 `pnpm run build`（或直接 `pnpm run check`）；再加一个 job（至少在发布分支）跑 `pnpm run release:verify`，让 tarball/consumer 层被自动 gate 在 publish 之前。

### F5（高 / 时效）—— Node 20 floor 已过时且自相矛盾

**根因：** 三个公开包 + 规范 §4.1 + `AGENTS.md` 均声明 `engines.node ">=20"`。但 Node 20 已于 **2026-04-30 EOL**；ESLint 10.8 要求 `^20.19||^22.13||>=24`；**tsdown 0.22.14 要求 `^22.18||>=24.11`，根本不支持任何 Node 20**；构建能过仅因开发机是 Node 22.21。

**影响：** `">=20"` 已内部不一致且指向 EOL 运行时。Node 20.0–20.18 的消费者过不了 ESLint 自身引擎检查；开发/构建工具链在任何 Node 20 上都跑不起来。对一个把「Node major」作为确定性输入（§18）的产品，一个 EOL、自相矛盾的 floor 是真实缺陷。

**修复：** 三公开包 + 根 + 规范 §4.1 + `AGENTS.md` 的 `engines.node` 抬到 `">=22.18"`（或 `"^22.13 || >=24"` 对齐 ESLint）。若发布产物仍需 node20 目标（emitted 插件 target:node20 与开发工具链是两回事），把两者拆开：保留 emitted bundle 的 `target:'node20'`，但把开发/CI floor 声明为 22.18+。**不要在 1.0 宣传一个连自己构建工具都拒绝的 EOL 运行时。**

---

## 4. 与主流方案 / 其他构建工具对比（是否有短板或过时）

> 结论：**架构取舍普遍站得住脚**，多处优于主流默认（见 §2.1）。真正的「短板/过时」只有两处：W1 缺 dev 增量缓存（且与自身 §18 矛盾）、F5 Node floor 过时。工具链其余选择是**成熟押注而非预发布赌博**。

### 4.1 平台 Manifest / Schema 时效性（用各平台 2026 官方文档核验生成输出）

**整条通道结论：稳。** 六个生成器都匹配当下官方形状，文件位置全部正确（`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`.cursor-plugin/plugin.json`、Antigravity 根 `plugin.json`、`opencode.json`、Pi `package.json`），golden fixture 带 2026-08-06 核验日期（§21），两个 schema 易变平台（Antigravity 单字段、Pi）处理保守正确。**未发现**过时/改名/删除的必填字段、错误文件位置或能力误分类。

- **Claude Code（陷阱，非 bug）：** acplugin 输出的 `displayName` 与 `defaultEnabled` 在公共 SchemaStore JSON Schema 里**没有**，但在官方 plugins-reference 里**有且是当下字段** —— 即 acplugin 正确、社区 schema 滞后。**务必不要**为「对齐 SchemaStore」而删掉这两个合法字段。（建议在 `PLUGIN_FIELDS` 旁加一行注释注明此事 + `defaultEnabled` 需 Claude Code ≥v2.1.154。）
- **Codex：** 最详尽的通道，`.codex-plugin/plugin.json` + `interface` 子对象 + `.agents/plugins/marketplace.json` + `source` 对象形态 + 安装策略枚举 + `ON_INSTALL` 全字段匹配当下 Codex 文档。
- **Cursor：** fixture 与权威 GitHub `plugin.schema.json` 逐字段匹配（`additionalProperties:false`、`author` 无 `url`（故 `CURSOR_METADATA_AUTHOR_URL_OMITTED` 警告正确）、glob 路径形态）。
- **OpenCode / Antigravity / Pi：** MCP local/remote 形状、`{env:NAME}` 插值、workspace 无静态 manifest、Antigravity 单字段 + 逐字段 omitted 警告、Pi `pi` key + `pi-package` keyword + image/video 全部匹配当下文档。

### 4.2 与打包器 / CLI / 发布工具的架构对比

- **固定生命周期 vs Vite/Rollup 的 enforce/order：** acplugin 更贴合（封闭平台集、单写者），不是倒退。
- **add-only owner patch vs deep-merge：** acplugin 更优（确定、冲突可检、可归属）。
- **事务提交 vs 主流 rimraf+write：** acplugin 高于同生态标准。
- **CLI 选 Commander vs oclif/citty/clipanion：** 正确的「懒」选择 —— acplugin 的扩展性在 Platform/Extension 模型里（从 `acplugin.config.ts` 加载），**不**想要 oclif 的 CLI 插件（那会是第二个竞争性扩展面、绕过 §16.4 的口子）。Commander 固定命令集 + 低启动 + 小依赖足矩。
- **短板：** 串行无并行逃逸口（W2，可接受但规范承诺未预算）；**无 dev 增量缓存（W1）** —— 每次防抖全量重跑，是唯一「实现落后于自身规范」之处，主流（unbuild stub、Vite transform cache、Rollup watch 增量、changesets 只处理变更包）都有某种增量。建议把 §18 该 MUST 降为 MAY（此规模全量重建可接受），不要给 `build` 加增量（与事务全量提交刻意不兼容）。

### 4.3 工具链时效与风险

**整体成熟，不是「TS7 预览 / 两个 TypeScript 包」听起来的赌博。**
- **TypeScript 7.0 已于 2026-07-08 GA**（`@typescript/native` = `typescript@7.0.2`，暴露 `tsc`）；dts 用 `generator:'oxc'` 绕开 TS7 尚未 GA 的程序化 emit API（预计 7.1），声明完整生成（core 52KB）且经 attw+publint gate —— 这正是官方推荐的过渡策略。
- **双 TypeScript 是正确的、有据可查的官方过渡模式**（`typescript`=`@typescript/typescript6@6.0.2` 暴露 `tsc6`，仅供 typescript-eslint 与中文注释 AST 检查器使用，它们还需 7.1 才会重新暴露的旧 JS 编译器 API）。唯一成本是认知负担（`typescript` 实为 v6、`@typescript/native` 实为 v7，读起来反直觉）—— 建议加一行注释，并把「7.1 落地后删除 `tsc6` 回退」作为显式技术债。
- **Rolldown 1.0（2026-05-07 稳定）** 是链条里最稳的一环；Vitest 4.1.10 / ESLint 10 + flat config 都是当下稳定主版本。
- **两个真实脚印：** ① F5 Node floor（见上）；② **tsdown 仍是 0.x**（0.22，minor 间有破坏性变更），却是三个 1.0 公开包唯一构建工具 —— 建议在 catalog 里把 tsdown 从 `^` 收紧为**精确/波浪号**（`~0.22.14`），让 minor 升级成为**刻意**动作，并把「发布前 dist 字节 diff」接入 `release:verify`（§18/§19.2.8 本就要求可复现输出）。**不要**退回 tsup —— Rolldown/oxc 底座是对的长期押注。
- **次要：** 两个 Extension 包的 `tsdown.config.ts` **缺 attw/publint gate**（主包有）—— §19.1.12 要求三个 tarball 都过 publint+类型检查，建议补齐；`isolatedDeclarations` 未开启但处处用 oxc dts 快路径（其假设 ID 兼容）—— 建议在 `tsconfig.base.json` 开 `isolatedDeclarations:true` 把该假设变成编译期强制（主包已证明代码 ID-clean，改动近零）。

---

## 5. 各通道逐项评估

### Core（3 条通道）—— 全部「设计良好、忠于规范」
- **lifecycle：** 15 步顺序、per-platform 失败隔离（`errorCount` checkpoint + `removePlatform`）、buildEnd 严格逆序、事务全量提交/恢复均正确。缺陷仅 F2。次要：`pendingArtifacts` 在 adapter emit 后抛错有未处理 Promise rejection 窗口（中，`lifecycle.ts:557-580`，建议对每个 push 的 promise 挂 `.catch` 或用 `allSettled`）；per-object buildEnd `status` 在一次运行内可能标注不一致（低，建议进循环前算一次终态传给所有 buildEnd）。
- **data-model：** 符号品牌不可伪造、add-only patch 正确、深冻结/普通对象强制彻底、产物来源逐段符号链接检查、`hashFile` 流式。缺陷仅 F1 及其兜底不完整（reports 两条路径 env 集合不一致 —— 建议删除 env 子串脱敏后合并为单一脱敏边界）。低：`sortObject`/`cloneJson` 注释声称 localeCompare 键序，但 V8 对整数样式键强制数值序（确定但注释不准，建议改注释或转义数值键）；localeCompare('en') 依赖 ICU 版本（§18 只钉 Node major，small-icu 构建可能漂移 —— 建议对 id/path 类稳定键改用 code-unit 比较）。
- **scanner：** 符号链接分层防御（含祖先逐段 lstat `SOURCE_ROOT_SYMLINK`）、NFC+大小写折叠冲突、DFS 环检测带完整环路径、frontmatter fatal UTF-8 + `uniqueKeys`、Command-cannot-be-required 由 kind 限定图键天然成立、辅助文件字节+mode 保留 —— 均正确。**唯一真缺陷（中）：** Public copy `to` 目标归一化忽略反斜杠为分隔符（`scanner.ts:926,934`），而 config 层（`config.ts:248`）把反斜杠当分隔符做 `..` 检查 → Windows 路径冲突盲点 + 跨 OS 非确定性（`to:'sub\\file.txt'` 与 `to:'sub/file.txt'` 在 POSIX 被当两个目标、在 Windows 是同一物理路径静默覆盖）。建议 `finalizePublicFiles` 也用 `split(/[\\/]/).join('/')`。

### Platforms —— 「构建良好、贴合规范」，主要弱点是**测试**
- **Claude/Codex（primary）：** manifest 根结构、Codex 命令/agent→Skill fallback + 大小写 id 冲突校验、元数据去向、marketplace 自包含无远程副作用、兼容等级全部匹配 §12/§11.2/§15。`haiku`/`sonnet` 是 Claude 自家稳定别名、§12.2 明确允许（no-hardcoded-model 规则只针对 Cursor/OpenCode），非违规。手写严格 SVG 解析器是因 `image-size` 太宽松的合理偏离。弱点：~12 个 helper + marketplace 布局逐字复制（Codex 内 3 个路径安全实现，见 A1）；§21 核验日期注解只有 Claude Hook schema 有，更易变的 Codex plugin/interface/openai.yaml 没有（建议补）。
- **Cursor/Antigravity/OpenCode/Pi（secondary）：** delivery 类型、根结构、逐平台元数据、兼容矩阵全部正确；Antigravity「只官方确认字段」纪律、OpenCode omit-if-empty 不覆盖消费者 `package.json`、Pi prompt-template fallback 都到位。**最大风险面（中）：** 兼容矩阵与每个 validator 拒绝分支**几乎无测试**（cursor:2、antigravity:1、opencode:3、pi:1，且 fixture 都用 inherit-model + 默认 invocation，degraded/transform 代码路径从不在测试下执行）—— 一个静默丢失 degraded 条目/误分级 transform/削弱 validator 的回归会绿灯通过。建议加：用 `user:false` skill + 带 argumentHint 命令 + fast/capable+write/shell agent 的 fixture 断言精确 `CompatibilityEntry` 集合，并对畸形候选断言每个 validator 错误码。低：OpenCode validator 有一个**什么都不校验的惰性循环**（`validator.ts:43`，建议删除或让 fall-through 真的报 `OPENCODE_UNEXPECTED_ARTIFACT`）。

### Extensions（Hooks + MCP）—— 本次审阅**最强通道**
安全与确定性模型自洽、载重、非 cargo-cult：Hooks 每个 hook 只构建一次字节一致的中立 `handler.mjs` + 逐 adapter `wire.mjs`，运行时沙箱拦截 stdout/stderr/`process.exit`、装 uncaught/unhandledRejection、两 tick beforeExit 收尾、全部失败映射为稳定错误码且不泄露原始 payload，测试异常充分。MCP `{value}`(内联) 与 `{env}`(仅引用、构建从不读值) 分离到位、HTTPS-in-prod/loopback-dev、拒绝 native addon/未解析动态 import/额外 chunk、bounded 无密钥 smoke。六 adapter 兼容矩阵 cell-for-cell 匹配 §13.4/§14.4，peer 边界（`@tokenroll/acplugin`、rolldown external）干净。仅 4 项 低/info：`wire.mjs` 按 (adapter,hook) 重算而非 per-platform memoize（中，建议 memoize + 断言同平台跨 hook 字节一致）；Codex 非 tool 事件上有意义 matcher 未报 degraded（低）；stdio MCP smoke 每次 dev 重建都 spawn（低 DX，建议按 production gate 或按内容哈希缓存）；运行时拦截器一处死三元（info）。

### CLI —— 「扎实、贴合规范」
四命令共享一个 `runProject`/`executeProject`（§16.2）；退出码 0/1/2/130 正确（dev 自持 SIGINT，其余继承 Node 默认）；`--json` 严格单文档到 stdout、日志到 stderr；`--platform` 子集保留配置顺序并拒绝未配置/重复/空；strict 覆盖干净；jiti `moduleCache:false+fsCache:false` 给 dev 正确的新鲜重载且不自动加载 `.env`；tsdown 确实把 Core+六私有平台内联进主入口、MCP Extension 仅在 lazy migration chunk（§4.3 成立）；公开入口精选、平台子路径不泄露内部类型（§4.4）。缺陷除 F1 的 CLI 层显形外均属次要：legacy `--target` 检测扫原始 argv 会对值为 `-t`/`--target` 的位置参数误报（低，建议 parse 后检测或在 `--` 处停止扫描）；init 失败收敛成通用 `init failed.` 隐藏可操作原因（低 DX，建议透传 init 自己的校验消息）。

### Migration —— 隔离与安全路径「最强之一」，缺陷在确定性/保真
只经公开 API 触碰 Core（§17.1）；§4.3 lazy-chunk 隔离经构建产物实证成立（`dist/index.mjs` 不引用 migration/MCP，rolldown 不进任何发布产物）；字段级保真 + 最差字段 rollup、`report.json` 凭据脱敏、GitHub 源校验、符号链接/路径逃逸处理、安全的「仅无内联凭据+仅 env 引用认证的远程 HTTPS MCP 自动迁移」、dry-run + 原子 rename、§17.3 映射表全部匹配。缺陷：F3（规范 ID 冲突，高）；`report.json` 的 `items[]` 按未排序 `readdirSync` 顺序 → 跨文件系统字节不稳定（中，`utils/fs.ts:55-101`，建议对 items 按 kind→id→source 稳定排序）；生成工程重校验继承 F1（低，随 F1 根因修复自动解决）。架构 info：`validateCanonicalProject` 用进程级全局 Symbol 桥 + refcount 把公开 API 递给生成工程（CLI 串行安全，但并发编程式 migrate 会共享一个全局桥 —— 是 by-convention 而非结构性隔离，建议留注释说明串行前提）。

### Testing / Tooling —— 硬骨头覆盖强，弱在接线
强：`cli.test.ts` 9+ 个 SIGINT/exit-130/dev-recovery 场景（多数项目直接跳过）；`transaction.test.ts`+`locking.test.ts` 覆盖中断恢复与死进程锁回收；`migration.test.ts` 深覆盖脱敏/二进制/注入；`architecture.test.ts` 实现残留守卫（§19.2.10）；`verify-release.mjs` 是真正的 tarball/publint/attw/clean-consumer/Pi-pack 门。弱：F4（CI 不跑 test/build）；**无端到端重复构建字节相等测试**（§19.2.8/§18 —— 确定性只在序列化器层对乱序内存输入测过，正是 F1 破坏的那类保证却无测试可抓，中/高）；所有脱敏测试都注入受控 environment，**掩盖了生产用的 `process.env` 默认路径**（中，这正是 F1 在干净机器上仍绿的 CI 卫生原因）；`release:verify`/tarball 层只在手动脚本、任何自动门都不跑（中）；注释守卫无防漂移（中，`check-comments.mjs` 只遍历硬编码 131 项 `enforcedFiles`，新增 src 文件会静默逃逸 —— 建议 glob `src/**/*.ts` 并对缺失项失败）；注释守卫可被单个汉字满足（低，`CHINESE_PATTERN.test`，本质是 presence 检查，可接受但值得记为已知限制）；根 `pretest=build` 使构建失败显示为测试失败（低 DX）。

---

## 6. 建议的处理顺序

**发布 1.0 前必须处理（阻断级）：**
1. **F1 / REDACT-1** —— 删除 env 值子串脱敏、`executeLifecycle` 默认空脱敏环境；配一个含平台 id 子串的 env-like 回归测试。修好后唯一失败测试转绿，§18 确定性恢复。
2. **F2** —— 把 `finalize()`/buildEnd 移出事务 `afterSwap`，buildEnd 错误只记诊断、不下调 committed/success。
3. **F3** —— Migration 加 per-kind emitted ID + per-stage workspace 目录注册表，冲突时消歧或标 degraded/unmapped。
4. **F4** —— `check.yml` 加 `test`+`build`（或 `pnpm run check`）；发布分支加 `release:verify` job。
5. **F5** —— `engines.node` 抬到 `>=22.18`（或 `^22.13||>=24`），同步规范 §4.1 / `AGENTS.md`；如需保留 emitted node20 目标则拆分「运行时 floor / 构建 floor」。

**发布前建议处理（质量/一致性）：**
6. 端到端重复构建字节相等测试 + 生产 `process.env` 脱敏路径回归（补 §19.2.8 缺口，锁死 F1 不回归）。
7. 二级平台兼容矩阵 + validator 拒绝分支测试（补最大未测风险面）。
8. scanner Public `to` 反斜杠归一化对齐（补 Windows 确定性盲点）。
9. 两个 Extension 包补 attw+publint gate；`isolatedDeclarations:true`；tsdown catalog 收紧为 `~0.22.14`。
10. 注释守卫改为 glob `src/**/*.ts` 防漂移。

**可延后（低优 / 纯质量）：** 平台 helper 提取到 Core 共享模块（A1）、Codex 三路径函数合一、`pendingArtifacts` 未处理 rejection 加 `.catch`、Hooks `wire.mjs` per-platform memoize、OpenCode 惰性循环删除/落实、§21 核验日期注解补齐、migration `items[]` 稳定排序、dev 增量缓存决策（实现或把 §18 该 MUST 降为 MAY）、legacy `--target` 检测/init 错误消息 DX、`localeCompare` → code-unit（如需摆脱 ICU 依赖）。

---

## 7. 总评

按十分制：**架构设计 9/10，代码实现 8.5/10，规范一致性 8.5/10，测试与工程化 7/10，工具链现代度 8/10。**

这份重构在最难的地方（确定性、所有权、事务、安全边界）做对了，而且是**深思熟虑地**做对 —— 这些机制不是模板噪音，每一层都能对上一条 §10/§18 的具体要求。发现的问题没有一个动摇架构：F1 是一个原语选错（一处共享函数即可修复所有 caller）、F2 是一处生命周期与事务的接线错误、F3 是 migration 少了一个注册表、F4/F5 是 CI 与版本声明的工程卫生。全部可在小改动内闭合，且都带明确修复路径。

从「懒惰资深工程师」视角，值得一提的是**克制得当**：没有为单实现造接口、没有把 marketplace 做成空壳字段、CLI 没有引入第二套插件面 —— 反而是 F1 那处「主动去 grep 环境变量值」的额外机制才是应当删掉的复杂度。删掉它，同时修好其余四处接线，这就是一个可以自信发布的 1.0。
