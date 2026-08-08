# acplugin 1.0 —— Review 修复项实施设计（具体修改/设计方案）

> **历史审计材料：** 本文保留原始实施设计及其被否决的分支，不再是施工权威。P2、P14、P16、P17b 等结论已由 `.llmdoc-tmp/reviews/revised-review-fix-plan.md` 和 hardening spec 替代。

> 来源：`review-fix-plan.md`（已确认方案）逐项经 workflow 深读源码后产出的**实施级设计**。
> 每项含：决策、现状（file:line 锚点）、具体改动（diff 级）、边界与连带、测试、验收、工作量、风险。
> 生成方式：9 组并行深读（G1–G8，G6 拆为 G6a/G6b），综合 agent 因每日额度 429 未跑，改由主控直接汇编；内容逐字取自各设计 agent 的结构化产出。
> 日期：2026-08-07

## 实施顺序与依赖（务必先读）

- **P1 必须先于 P6**：P6 的端到端确定性测试是 P1 的回归护栏；二者建议同一分支提交（revert 验证需同分支）。
- **P16（utils 子包）宜先于 P8/P10 等平台/Core 改动**：让后续改动直接复用共享 helper，避免二次搬迁。P16 内部按 a→b→c→d 顺序（建包→接入构建图→平台改用→Hooks memoize）。
- **P14（dev 缓存）建议独立分支**：架构级，影响 lifecycle/run-project。
- 阶段：S1 发布阻断 → S2 正确性/工程化 → S3 架构级 → S4 规范/记录 → S5 低优清理。
- ⚠️ 标注的“待确认”点集中在文末清单。

---
## S1 — 发布阻断

### P1 · 删除 env 值子串脱敏(环境值不再进入报告文本的过滤链)

**决策：** 彻底删除 env 值子串脱敏:移除 environmentValues() + sanitizeReportText 里的 env split/join、reports.ts 的 protectedValues/environment 过滤整段、lifecycle.ts 的 process.env 默认与 environment 传入脱敏边界;保留 SECRET_KEY_PATTERN 键名脱敏、Bearer/Basic/token=inline 凭据正则、路径剥离。

**现状（锚点）：** 根因链共 4 处。(1) packages/core/src/diagnostics.ts:49-54 environmentValues():收集 options.environment 里长度>=4 的值,按长度降序;:73-74 在 sanitizeReportText 内 `for (const environmentValue of environmentValues(options.environment)) safe = safe.split(environmentValue).join('<redacted-env>')`。这是把任意 env 值当子串从自由文本里剪除——正是会把含 platform id 子串的 env(如 FOO=claude)误伤 platform id/path 的根因。(2) packages/core/src/diagnostics.ts:20-24 ReportRedactionOptions.environment 字段 + :46 JSDoc。(3) packages/core/src/reports.ts:115-134 serializeBuildResult:117-129 protectedValues(schemaVersion/command/platform id/apiVersion 等)Set,:131-132 `const environment = Object.fromEntries(Object.entries(options.environment ?? process.env).filter(([,v]) => v===undefined || !protectedValues.has(v)))`,:133 `stableJson(redactReportValue(result, { ...options, environment }))`。注意此处默认 `process.env`——这是生产路径(cli.ts:62/488 调用 serializeBuildResult(report) 不传 options)真正把机器 env 灌进脱敏集合的地方,违反 §18 确定性(机器 env 依赖)。(4) packages/core/src/lifecycle.ts:220 `const environment = Object.freeze({ ...(request.environment ?? process.env) })`,:224 `reportRedaction = Object.freeze({ roots:[...], environment })`,:226 传入 DiagnosticCollector。environment 变量另在 hook context 复用(:312/334/411/428 buildStart/buildEnd 的 context.environment)——那是给 Platform hook 读的合法能力,不是脱敏,不能删。

**具体改动：**

改 4 个文件,净删除为主。

A) diagnostics.ts:
- 删除整个 environmentValues() 函数(:43-54,含 JSDoc)。
- 删除 sanitizeReportText 内 :73-74 两行 env split/join for 循环。sanitizeReportText 结尾变为:凭据正则 + temp 正则 → roots split → 绝对路径正则 → 空白折叠 → trim。
- ReportRedactionOptions(:21-24)删掉 `readonly environment?: ...` 字段,只留 `roots?`。JSDoc(:20)改为“报告脱敏时可额外提供的工程边界”。
- compareStrings(:39-41)保留(propagateDependencies/sort 仍用)。

B) reports.ts:
- serializeBuildResult(:115-134)删掉 :117-129 protectedValues 整段 + :130-132 environment 计算整段。函数体缩为:`return stableJson(redactReportValue(result, options));`(options 现在只含 roots)。
- 顶部 import 无需改(redactReportValue 仍用)。

C) lifecycle.ts:
- :220 改为 `const environment = Object.freeze({ ...(request.environment ?? {}) });`(hook context 默认空 env,不再吃 process.env——满足“脱敏环境默认空”且 hook 仍拿到冻结对象)。
- :224 改为 `const reportRedaction = Object.freeze({ roots: [request.config.root, runtimeRoot] });`(去掉 environment 键)。
- :226 DiagnosticCollector(reportRedaction) / :301 failureSummary(finalCause, reportRedaction) / :757 createBuildResult(..., reportRedaction) 都不动,签名兼容(options 只是少了一个可选字段)。
- hook context 的 environment 传参(:312/334/411/428)保持——它们引用的是新的默认空 environment 变量,类型不变。

D) diagnostics.test.ts(P1 连带,详见 tests):现有 3 处依赖 `<redacted-env>`/env 子串行为的断言必须改,否则删除后测试红。

**边界与连带：** 1) 生产确定性:reports.ts 默认 `process.env` 是当前唯一机器 env 泄漏点,删掉即修 §18;cli.ts:62/488 无需改(继续调 serializeBuildResult(report),现在纯净)。 2) 所有 executeLifecycle 调用方(7 个 test 文件)现传 `environment: {}` 给 request.environment——保留 LifecycleRequest.environment 字段(hook 能力),这些调用无需改;只有语义从'空对象参与脱敏'变为'空对象仅供 hook',行为等价。 3) 无任何内置 platform/extension 在 hook 里读 environment(已 grep 确认 packages/platforms/*/src、extensions/*/src 无 `context.environment` 消费),故删除脱敏不影响任何 platform 逻辑。 4) 保留项不能误删:SECRET_KEY_PATTERN 键名脱敏(diagnostics.ts:123)、:66-67 Bearer/Basic/token=inline 正则、:68 temp 正则、:69-71 roots、:77 绝对路径正则全部保留。 5) redactReportValue 三个 options 传播点(:96/110/125)不变。 6) BuildStartContext/BuildEndContext.environment(contracts.ts:192/261)是公开 API,不删。

**测试：** 改 packages/core/test/diagnostics.test.ts:
- :99-108 稳定性用例:`{ environment: {} }` 改为 `{}`(或整体删第二参),断言 first===second 不变。
- :110-146 no-timestamp 用例:删 environment 参数 `{ environment: { REPORT_TOKEN: 'report-secret' } }`→改成不传;`report-secret` 现由 owner 上的 `Bearer report-secret` 经凭据正则命中(:66)仍被剪成 `<redacted-credential>`,故 `expect(json).not.toContain('report-secret')` 仍成立(不是靠 env 子串)。保留 not.toContain('/Users/example')/toContain('<path>')。
- :148-180 'redacts custom environment secrets' 用例:此用例只测 env 子串脱敏,P1 删后该能力不存在——删除整个 it 块(:148-180)。
- :189-212 'removes secret fields...' 用例:message `'value env-secret at /private/root/.acplugin-work-123/cache'` 与 `environment:{FIXTURE_SECRET:'env-secret'}`。删 environment 参数;`env-secret` 不再被脱敏,断言 `expect(json).not.toContain('env-secret')`(:207)删除;把描述里 'environment values' 去掉,改断言仍验证 credential/bytes/circular/roots(`/private/root`→`<path>` 经 roots split 仍成立)。
断言重点:P1 后 apiToken 字段仍 `<redacted-credential>`(键名脱敏);Bearer/token= 内联仍脱敏;绝对路径仍 `<path>`;纯 env 值不再脱敏。

**验收：** 1) `pnpm --filter @acplugin/core test` 全绿;grep `<redacted-env>`/`environmentValues`/`options.environment` 在 core/src 下 0 命中。 2) serializeBuildResult 不再引用 process.env(grep `process.env` 在 reports.ts 0 命中)。 3) lifecycle.ts reportRedaction 无 environment 键。 4) `pnpm -r typecheck` 通过(ReportRedactionOptions 字段删除后无类型引用残留)。 5) 全仓 `pnpm -r test` 绿(尤其 7 个 executeLifecycle 调用方与 platforms 测试不回归)。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** low。唯一活 caller 依赖是 diagnostics.test.ts 3 处断言(已在 tests 列明同步改)。ReportRedactionOptions.environment 删字段可能有仓外/文档引用——grep 已确认 src 内仅 diagnostics/reports/lifecycle 三处,test 内仅 diagnostics.test.ts;llmdoc 若描述该行为需另行更新(非本组代码范围)。


---

### P2 · buildEnd 移出 commit 事务的 afterSwap,清理失败只记诊断且不下调 committed/success

**决策：** commit 分支删除 afterSwap 回调,让事务完整提交(含删 backup);buildEnd 统一由外层 finally 的 finalize() 执行;在 buildEnd 之前用 buildFailed 快照锁定构建成败,使 buildEnd 抛错/发 error 诊断只进报告,不回滚已提交输出、不下调 committed/success。

**现状（锚点）：** packages/core/src/lifecycle.ts。commit 分支 :704-714 把 finalize() 塞进 commitDeliveryUnits 的 afterSwap:`async afterSwap() { originalError = await finalize(originalError); if (originalError !== undefined || diagnostics.hasErrors) throw ...; }`,`committed = true`(:714)在其后。afterSwap 在 transaction.ts:389 被调用,位于 output-swapped 之后、删除 backup(:407-413)之前的可回滚窗口——因此 buildEnd 抛错会走 transaction.ts:395-406 的回滚,删除刚交换成功的新输出并 restore backup,commit 抛出,`committed` 永远拿不到 true。non-commit 分支 :715-718 则在 try 内直接 `await finalize(originalError)`。外层 finally :724-729 已经会再跑一次 `finalize`(靠 :263 的 `finalized` 幂等标志)。success 计算在 :742-743:`!diagnostics.hasErrors && originalError === undefined && platforms.every(...primary...)`——finalize 内 buildEnd 失败会 `diagnostics.error(PLATFORM/EXTENSION_BUILD_END_FAILED)`(:320-322,:342-344)并把错误经 finalize 返回值写回 originalError,从而把 success 拉成 false。committed 声明 :261,finalized 注释 :262。

**具体改动：**

lifecycle.ts 四处编辑,transaction.ts 不动:

(1) 声明区 :261-263 新增快照变量:
```
 let committed = false;
+ /** buildEnd 之前锁定的构建成败快照,避免清理失败下调 success。 */
+ let buildFailed = false;
 /** 防止 finalize 重复执行 buildEnd。 */   // 顺手把原“afterSwap 与 finally 重复清理”注释改掉
 let finalized = false;
```

(2) commit 分支 :704-718 删掉 afterSwap,并删掉 non-commit 的内联 finalize:
```
 if (commit) {
-  await commitDeliveryUnits(request.config.outDir, finalUnits, {
-    projectRoot: request.config.root,
-    async afterSwap() {
-      originalError = await finalize(originalError);
-      if (originalError !== undefined || diagnostics.hasErrors)
-        throw originalError ?? new Error('Lifecycle cleanup failed.');
-    },
-  });
+  // 事务完全提交(含删 backup)后才标记 committed;buildEnd 交由外层 finally 统一执行,
+  // 清理失败只记诊断,不回滚已成功交换的输出,也不下调 committed/success。
+  await commitDeliveryUnits(request.config.outDir, finalUnits, { projectRoot: request.config.root });
   committed = true;
 } else {
   await validateDeliveryUnitMaterialization(finalUnits);
-  originalError = await finalize(originalError);
 }
```

(3) 外层 finally :724-729 在 finalize 前拍快照:
```
 } finally {
   if (originalError === undefined && diagnostics.hasErrors)
     originalError = new Error('Lifecycle failed; see diagnostics.');
+  // 在 buildEnd 之前锁定构建成败,使 buildEnd(清理)失败只体现为诊断,不下调 success。
+  buildFailed = originalError !== undefined || diagnostics.hasErrors;
   originalError = await finalize(originalError);
   await fs.rm(runtimeRoot, { recursive: true, force: true });
 }
```

(4) success :742-743 改用快照:
```
-  success: !diagnostics.hasErrors && originalError === undefined
-    && platforms.every(runtime => finalUnits.some(unit => unit.platform === runtime.resolved.platform.id && unit.role === 'primary')),
+  success: !buildFailed
+    && platforms.every(runtime => finalUnits.some(unit => unit.platform === runtime.resolved.platform.id && unit.role === 'primary')),
```
finalize 现在只在 finally 被调用一次(afterSwap 与 non-commit 内联调用都删了),`finalized` 幂等标志变为纯防御性,保留即可。

**边界与连带：** 1) 原 afterSwap“提交后仍在可回滚窗口清理”的意图是【故意丢弃】的——buildEnd 是清理钩子,拍板决定其失败不得回滚已提交构建;afterSwap 里除 finalize 外没有别的需要回滚窗口的工作,故整段回调删除,不需要另找地方保留。2) “含删 backup”由事务自身保证:transaction.ts:407-413 在 afterSwap 之后无条件删 backup,afterSwap 为空/不传时提交照样完整收尾,所以把 finalize 挪到外层 finally 后,commit 一定是完整终态才跑 buildEnd。3) committed 在 :714 于 commit 成功返回后赋值,buildEnd(finally)在其后运行,天然不下调 committed。4) buildFailed 在 finalize 前快照,只捕获 buildEnd 之前的 diagnostics.hasErrors/originalError:真正的构建/生成/提交失败(如锁冲突、commit 抛错走 catch :720)仍把 buildFailed 置真、success=false、committed=false,语义不变;仅 buildEnd 阶段的诊断被排除。5) finalUnits(:732 snapshot)不受 buildEnd 影响(BuildEndContext 只有 reportDiagnostic,不能改 units),success 的 every(primary) 判据稳定。6) originalError 经 finalize 返回值重赋后已无下游读取(success 改读 buildFailed),保留该赋值只为语义连续、零风险;确定性无影响(不引入 time/path/随机)。7) transaction.ts 的 afterSwap 选项(:31,:389)变为无调用方:【建议保留不动】,它是通用原子提交工具的合法扩展点,其回滚语义已被 transaction.test.ts 用 onPhase('output-swapped') 注入覆盖,删它属于动数据安全区的无谓 churn。

**测试：** packages/core/test/lifecycle.test.ts:
- 【保留】既有 :353 'continues later Platforms...'(validate 路径 + buildEnd 抛错 + 生成失败)——新代码下 buildFailed=true(生成阶段已有 PLATFORM_GENERATION_FAILED),success 仍 false,断言不变,已验证不回归。
- 【新增】build(提交)路径 + buildEnd 抛错用例,骨架:
```
it('commits and records a buildEnd failure as a diagnostic without downgrading success/committed', async () => {
  const events: string[] = [];
  const platform = definePlatform({
    id: 'commit-platform', apiVersion: '1', deliveryType: 'plugin',
    prepare: () => ({ documents: [], artifacts: [] }),
    generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [bytesArtifact('manifest.json', 'ok')] }),
    validateBundle: () => undefined,
    buildEnd(context) { events.push(`commit-platform:end:${context.status}`); throw new Error('buildEnd failure after commit'); },
  });
  const root = await temporaryRoot();
  await fs.mkdir(path.join(root, 'src'));
  const result = await executeLifecycle({ config: lifecycleConfig(root, 'build', [platform], []), loadTypeScriptModule: async () => undefined, environment: {} });
  expect(result.success).toBe(true);          // 不被 buildEnd 错误下调
  expect(result.committed).toBe(true);         // 不被下调
  expect(events).toEqual(['commit-platform:end:success']); // buildEnd 看到的 status 是构建期成功
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLATFORM_BUILD_END_FAILED', platform: 'commit-platform' }));
  // 关键:输出真的落盘且未被回滚(旧代码 afterSwap 抛错会删掉 dist/commit-platform)
  expect(await fs.readFile(path.join(root, 'dist', 'commit-platform', 'plugin', 'manifest.json'), 'utf8')).toBe('ok');
});
```
(outDir 默认 `<root>/dist`,两级布局 `<platform>/<unit-id>`,见 config.ts:431 与 transaction deliveryUnitRoots;bytesArtifact 已在文件顶部导入。)

**验收：** pnpm -C packages/core test 通过。新用例:success=true、committed=true、diagnostics 含 *_BUILD_END_FAILED、`<root>/dist/commit-platform/plugin/manifest.json` 内容为 'ok'(证明未回滚)。既有 lifecycle/transaction/ecosystem-contract 全绿。tsc/eslint 无新增告警(buildFailed 已被 success 读取,无未用变量)。确定性:未引入 time/绝对路径/随机/env。

**工作量：** M ｜ **独立分支：** 否 ｜ **风险：** success 语义发生【有意】变化:构建完整成功但 buildEnd 抛错时 success 现在为 true(诊断里仍带一条 error 级 *_BUILD_END_FAILED)。这符合拍板方案,但下游若有“success===true 即无任何 error 诊断”的隐含假设需知悉;已核查 cli.ts(:66/158/415)与 reports.ts 只透传 success 字段,无此耦合。


---

### P3 · 规范 ID 冲突检测 + 确定性消歧(per-kind 集合 + --all workspace 目录集合)

**决策：** 在每个规范工程内维护 per-kind 已用规范 ID 集合(skill/command/agent/mcp 各一),以及 --all 的 per-stage workspace 目录集合;safeId 生成的 ID 若已被占用,按确定性顺序追加 -2/-3… 消歧;落败/改名资源在报告中标 degraded 并给稳定原因,不再谎报 migrated;同时把非确定性的扫描顺序收敛为稳定排序,使消歧结果字节稳定。requires 引用重写为显式非目标(迁移产物根本不发出 requires,只有 claude-code 平台透传字符串,指向 legacy 名,无法可靠解析)。

**现状（锚点）：** safeId(packages/acplugin/src/migration/index.ts:221-225)把任意 legacy 名收敛成 kebab id,不同 legacy 名可折叠成同一 id(如 'My Skill' 与 'my-skill' 都 -> 'my-skill')。各迁移函数各自算 id 后直接写 src/<kind>/<id>: migrateSkill id=:318 destination='src/skills/${id}/SKILL.md':403 push item :415 write :417; migrateCommand id=:478 destination='src/commands/${id}.md':559 push :561; migrateAgent id=:631 destination='src/agents/${id}.md':706 push :708; mcp id=safeId(server.name):1375 destination='src/mcp/${id}/mcp.ts':1382 push :1396(安全)/ :1400+:1415(未映射)。所有写入经 Promise.all(writes)(:1358)与后续 await,同 id 直接覆盖文件,且两条 report item 都算 migrated(outcome 由字段最差值决定,migrationItem:184-202)。--all workspace(:1591-1612): id=safeId(plugin.meta.name):1595 -> projectRoot=path.join(stage,id):1597 -> 两 plugin 同 id 时第二个覆盖第一个整棵工程,projects.push(id):1610 产生重复 workspace 成员。确定性隐患: listDirs/listFiles(packages/acplugin/src/migration/legacy/utils/fs.ts:55-77)直接返回 readdirSync 顺序、未排序,scan.skills/commands/agents 顺序随文件系统变化,消歧若按此顺序决定谁保留 base id 则违反 §18。migrate 内收集 scan 的调用: writeCanonicalProject 内 for scan.skills(:1352)/scan.commands(:1354)/scan.agents(:1356),mcp for scan.mcp.servers(:1373)。

**具体改动：**

1) 新增确定性排序 helper(纯函数,置于 index.ts safeId 附近):
```
// 稳定 kebab 键;localeCompare 'en' 与文件已有排序一致
function byStableKey<T>(items: readonly T[], key: (x: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b), 'en'));
}
```
2) 新增 per-kind 消歧器(纯,无副作用,只吃已冻结输入):
```
/** 在给定已用集合内为 base 生成确定性唯一 id;返回 {id, disambiguated}。 */
function claimId(used: Set<string>, base: string): { id: string; disambiguated: boolean } {
  if (!used.has(base)) { used.add(base); return { id: base, disambiguated: false }; }
  for (let n = 2; ; n++) {           // -2, -3, ...
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) { used.add(candidate); return { id: candidate, disambiguated: true }; }
  }
}
```
3) 在 writeCanonicalProject(:1339)开头建立 per-kind 集合:
```
const usedIds = { skill: new Set<string>(), command: new Set<string>(), agent: new Set<string>(), mcp: new Set<string>() };
```
4) migrate* 函数签名各加一个 `used: Set<string>` 形参,内部把 `const id = safeId(x)` 改为:
```
const base = safeId(skill.dirName);            // 或 command.name / agent.fileName / server.name
const { id, disambiguated } = claimId(used, base);
```
   并在 name 字段 reportField 处把 mapped/degraded 判定改为:原判定 && !disambiguated,degraded 原因追加稳定文案。示例(migrateSkill name,:323):
```
const clean = ID_PATTERN.test(skill.dirName);
reportField(fields, 'name', source, clean && !disambiguated ? 'mapped' : 'degraded',
  disambiguated
    ? 'Canonical Skill ID collided with an earlier resource and was disambiguated with a numeric suffix.'
    : clean ? 'Directory identity maps directly to the canonical Skill ID.'
            : 'Skill identity required lowercase kebab-case normalization.');
```
   command(:483)、agent(:636)、mcp 两处(安全 :1386 / 未映射 :1403)同款改造。
5) 在 writeCanonicalProject 内把扫描集合排序后再遍历,消除 readdir 非确定性,并保证消歧顺序稳定:
```
for (const skill of byStableKey(scan.skills, s => s.dirName))
  writes.push(...migrateSkill(skill, scan.rootDir, outputRoot, items, usedIds.skill));
for (const command of byStableKey(scan.commands, c => c.name))
  writes.push(migrateCommand(command, scan.rootDir, outputRoot, items, usedIds.command));
for (const agent of byStableKey(scan.agents, a => a.fileName))
  writes.push(migrateAgent(agent, scan.rootDir, outputRoot, items, usedIds.agent));
```
   mcp for 循环(:1373)排序: `for (const server of byStableKey(scan.mcp?.servers ?? [], s => s.name))`,并把 usedIds.mcp 传入两个分支的 id 计算。
   注意排序键用消歧前的 legacy 名(dirName/name/fileName/server.name),使先出现者(字典序小)保留 base id,确定且可预测。
6) --all workspace 目录消歧(:1591-1612): 在 for 循环前建立 `const usedProjectDirs = new Set<string>();`,把 selected 先排序 `for (const plugin of byStableKey(selected, p => p.meta.name))`,循环内:
```
const { id, disambiguated } = claimId(usedProjectDirs, safeId(plugin.meta.name));
```
   disambiguated 时在该 plugin 的 metadata item 上补一条字段级 degraded(或在现有 name 字段 reason 说明目录消歧)。projectRoot=path.join(stage,id) 与 projects.push(id) 复用同一 id,保证目录与 workspace 成员一致且无覆盖。

**边界与连带：** 确定性: 必须先排序 scan 集合再消歧,否则 readdir 顺序决定谁拿 base id,违反 §18(fs.ts:55-77 未排序是根因)。排序键统一 localeCompare('en'),与文件既有排序风格(:461,:854,:909,:1170,:1231,:1391...)一致。跨 kind 不共享集合(skill 与 agent 同名不冲突,落到不同目录),正确;但 skill 与 mcp 都建 src/<id>/ 目录——不同 kind 前缀路径不同,无需合并集合。requires 引用重写: 迁移产物从不发出 requires 字段(已核实 index.ts 写入处只有 description/invocation/model/capabilities/platforms),故不存在悬空规范依赖需要重写;唯一 cross-ref 是 platforms['claude-code'].agent(skill,:384)与 platforms['claude-code'].skills(agent,:686),它们是 Claude Code 平台透传字符串、指向 legacy 名而非迁移后 id,无法保证一一对应,重写会引入错误猜测——明确列为非目标,不改。连带: migrate* 增加形参,唯一调用点在 writeCanonicalProject(:1352-1356,:1373),同步改;mcp id 现算两次(安全/未映射分支),消歧要在分支外先 claimId 一次再进入 if(source),避免同一 server 占两个 id。migrationItem 的 outcome 由字段最差值推导(:191-196),把 name 标 degraded 即自动使整条 item 至少 degraded,无需另改 outcome 逻辑。--all 目录消歧后 pnpm-workspace.yaml(:1612)自动使用去重后的 projects,正确。

**测试：** 文件: packages/test/test/migration.test.ts 新增用例。
用例1 'disambiguates colliding canonical IDs deterministically': 动态建 legacy project,两个 skill 目录 'my-skill' 与 'My Skill'(都 -> my-skill),迁移后断言: 存在 src/skills/my-skill/SKILL.md 与 src/skills/my-skill-2/SKILL.md(fs.access);report.items 含两条 kind:'skill',其中 id:'my-skill-2' 的 name 字段 outcome:'degraded' 且 reason 含 'disambiguated';两条都不得为 migrated 谎报(至少改名那条是 degraded)。运行两次(或对同一 fixture 两次 migrate 到不同 destination)断言 items 中 id 集合一致,验证确定性。
用例2 'disambiguates colliding workspace member directories': marketplace 两 plugin name 'Tools' 与 'tools'(都 -> tools),all:true,断言 report.projects 为 ['tools','tools-2'](有序、去重),且 src 两成员目录都存在、第一个未被覆盖(各自 skill 文件都在)。
用例3(可加固)'command/agent/mcp ID collisions are disambiguated not overwritten': 两个 command 文件名归一化同 id,断言两文件都写出且报告两条 item。
断言骨架示例:
```
expect(report.items.filter(i => i.kind === 'skill').map(i => i.id).sort()).toEqual(['my-skill', 'my-skill-2']);
await fs.access(path.join(root, 'migrated/src/skills/my-skill-2/SKILL.md'));
expect(report.items.find(i => i.id === 'my-skill-2')?.fields.find(f => f.field === 'name')?.outcome).toBe('degraded');
```
复用现有 afterEach 清理与 legacyProjectFixture 之外的动态 mkdtemp 模式(见现有用例 :203+)。

**验收：** 同一 kind 内规范 ID 冲突不再静默覆盖文件:每个冲突资源各自落盘且报告各有一条 item;落败/改名资源 name 字段为 degraded 且 reason 稳定说明消歧,整条 item outcome 不为 migrated。--all 下同名 workspace 目录得到 -2/-3 后缀、无覆盖,projects 有序且去重。迁移产物不发出任何 requires,故无悬空依赖;cross-ref 透传字符串保持不变。相同输入两次迁移产生字节一致的 report 与产物(排序保证)。现有全部 migration 测试仍通过。

**工作量：** M ｜ **独立分支：** 是 ｜ **风险：** 现有测试有对具体 id 的硬编码断言(如 kind:'skill' id:'hello'、id:'docs'、id:'review'),排序改动不改单资源 id,应不受影响;但需跑全套确认无顺序相关的隐式断言。selected(--all)现按 marketplace 清单顺序,改为按 name 排序会改变 projects 顺序——现有用例 :106 断言 projects:['first-plugin','second-plugin'] 恰好也是字典序,通过;需确认无其他依赖清单原序的断言(P9 已把清单原序标为 unmapped 记录,不受影响)。


---

### P5 · Node 开发 floor engines.node >=20 → >=22.18(保留 tsdown target:node20 与 Node20 产物描述)

**决策：** 把开发/运行 Node floor 从 >=20 提到 >=22.18,仅改决策点名的 4 处 engines.node + 规范§4.1 + AGENTS.md:14;所有 tsdown target:'node20' 与文档里描述『产物运行目标 Node 20 ESM』的文字一律不动。

**现状（锚点）：** 已 Read 确认真实行号。engines.node:'>=20' 全仓共 12 处,决策点名 4 处:
- packages/acplugin/package.json:11 → `"engines": { "node": ">=20" },`(单行)
- packages/core/package.json:6-8 → 多行 `"engines": {\n    "node": ">=20"\n  },`
- packages/test/package.json:6 → `"engines": { "node": ">=20" },`(单行)
- package.json:7-9(根) → 多行 `"engines": {\n    "node": ">=20"\n  },`
决策点名的两处文档 sync:
- .llmdoc-tmp/specs/tokenroll-acplugin-1.0-spec.md:57 → `- Node.js:`>=20`。`(§4.1 工具链,全角冒号/句号)
- AGENTS.md:14 → `- TypeScript 7、Node.js >=20、ESM-only;Package 的 `tsc` 来自 catalog 中的 `@typescript/native``
保留项(已核实,不改):10 个 tsdown.config.ts 全部 target:'node20'(acplugin:18、core、6 平台、hooks:8、mcp:11);产物运行目标描述 spec §899/§971、llmdoc/architecture/system.md:71/73(+zh)、conversion-matrix.md:47(+zh)、README.md:234/281(+zh:232/267)均写『Node 20 ESM』handler/server,是产物 floor 不是开发 floor。

**具体改动：**

6 处逐字替换(diff):

# packages/acplugin/package.json:11
-  "engines": { "node": ">=20" },
+  "engines": { "node": ">=22.18" },

# packages/core/package.json:6-8
   "engines": {
-    "node": ">=20"
+    "node": ">=22.18"
   },

# packages/test/package.json:6
-  "engines": { "node": ">=20" },
+  "engines": { "node": ">=22.18" },

# package.json(根):7-9
   "engines": {
-    "node": ">=20"
+    "node": ">=22.18"
   },

# .llmdoc-tmp/specs/tokenroll-acplugin-1.0-spec.md:57
-- Node.js:`>=20`。
+- Node.js:`>=22.18`。

# AGENTS.md:14
-- TypeScript 7、Node.js >=20、ESM-only;…
+- TypeScript 7、Node.js >=22.18、ESM-only;…

注:`>=22.18` 与 `>=22.18.0` semver 等价,按决策原文用 `>=22.18`。

**边界与连带：** 1) 决策只点名 4 处,但另有 8 处 engines.node 也是 '>=20':6 个私有平台(claude-code:6/cursor:6/codex:7/pi:6/antigravity:6/opencode:6)+ 2 个【公开】扩展(extensions/hooks/package.json:11、extensions/mcp/package.json:11)。hooks/mcp 与 acplugin 同属 Changesets fixed 发布组,若 acplugin 声明 >=22.18 而两扩展仍 >=20,发到 npm 的 engines 不一致 —— 需 decider 确认是『只改 4 处』还是『12 处一起』。本方案按决策先落 4 处并显式挂起其余 8 处。
2) CI 低于新 floor:.github/workflows/patch.yml:45 与 check.yml:18 均 `node-version: 20`,声明 floor 提到 22.18 后 CI 反而跑在不受支持版本上;建议同步改 22(超出决策 4 处范围,挂起待确认)。
3) catalog `@types/node: ^20.19.0`(pnpm-workspace.yaml:11 附近)是 Node 20 API 类型;不阻塞,可选升 ^22,挂起。
4) 反向护栏(最易踩):禁止全局 sed 把『Node 20』替换掉 —— tsdown target:'node20' 和所有『Node 20 ESM』产物描述必须原样保留,它们是生成的 handler/server 运行目标,与开发 floor 是两回事。
5) 决策未点名但语义同为开发 floor 的其它文档(README.md:11+zh:11、llmdoc/startup.md:7、state/sync.md:6、overview/project.md:27+zh:27、guides/usage.md:5+zh:5 皆『Node.js 20 or newer / >=20』)一致性上也应改 22.18,但不在决策命名集内,挂起待确认。
6) 确定性:engines 纯 manifest 元数据,不进任何产物字节,无 timestamp/路径风险。

**测试：** 无需新增 Vitest(manifest 字段无运行时行为)。验证即断言:
- `grep -R '"node"' packages/{acplugin,core,test}/package.json package.json` 全部显示 `>=22.18`。
- `pnpm -w run build && pnpm -w run typecheck && pnpm run release:verify` 全绿(release:verify 会 pack 三公开包并在干净 consumer 里装,顺带覆盖 manifest)。
- 反向断言:`grep -Rn "target: 'node20'" packages/**/tsdown.config.ts | wc -l` 仍为 10;`grep -Rn 'Node 20 ESM' README.md llmdoc` 计数不变。

**验收：** 4 处 engines 显示 >=22.18;spec§4.1+AGENTS.md:14 同步;10 个 tsdown target:node20 与所有『Node 20 ESM』产物文字未变;pnpm check/typecheck/build/release:verify 全绿;git diff 只含 engines 与两处文档 floor 文本。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** 唯一悬而未决:公开扩展 hooks/mcp 是否随 acplugin 一起提 22.18(发布组 engines 一致性)。建议连同 CI node-version 一并向 decider 确认后要么全改 12 处+CI,要么明确接受只改 4 处。


---

### P6 · 端到端护栏:同 fixture 重复构建字节相等 + env 无关性(含 platform id 子串的 env-like map)

**决策：** 在 packages/test/test/build.test.ts 新增 2 个用例(同一 describe):(a) 同 fixture build 两次,断言每个 artifact 的 SHA-256 + serializeBuildResult(--json 报告)完全字节相等(§19.2.8);(b) 用含 platform id/版本号子串的 env-like map(如 {FOO:'claude', BAR:'1.0.0'})跑一遍,断言 platform id/artifact path/文本完好,锁死 P1 不回归。

**现状（锚点）：** packages/test/test/build.test.ts:16-28 已有 project() fixture 工厂(mkdtemp 到 os.tmpdir + 写 src/skills/hello/SKILL.md + acplugin.config.ts),:30-32 afterEach 统一 rm。:34-58 已有 runProject build 用例并读取 dist 产物,证明 build+commit 路径可用。BuildResult 已直接暴露 `deliveryUnits[].artifacts[]` = `{path,owner,mode,size,sha256}`(lifecycle.ts:199-205 deliveryUnitReports),故拿 hash 无需重新读文件哈希——直接读 result。序列化用 packages/acplugin 导出的 serializeBuildResult(index.ts:39 re-export core;build.test.ts 从 '@tokenroll/acplugin' 导入)。runProject/executeProject(run-project.ts:14-22 RunProjectOptions)不暴露 environment 入口——生产走 process.env(P1 后已不进报告);故 env 无关性测试须在测试内临时改 process.env 包裹调用。

**具体改动：**

packages/test/test/build.test.ts:
- import 增补:`serializeBuildResult`、`claudeCode`(platform id 断言用其 .id;codex 已 import)。从 '@tokenroll/acplugin' 导入(index.ts 已 re-export serializeBuildResult:39 与各 platform 工厂)。

用例 (a) 重复构建字节相等:
```ts
it('produces byte-identical artifacts and JSON report across repeated builds', async () => {
  const rootA = await project();
  const rootB = await project(); // 各自独立 fixture,排除 outDir 复用干扰
  const first = await runProject({ cwd: rootA, command: 'build', mode: 'production', commit: true });
  const second = await runProject({ cwd: rootB, command: 'build', mode: 'production', commit: true });
  // 每个 artifact 的 sha256 相等(按稳定顺序,report 已确定性排序)
  const hashes = (r) => r.deliveryUnits.flatMap(u => u.artifacts.map(a => `${u.platform}/${u.id}/${a.path}:${a.sha256}`));
  expect(hashes(first)).toEqual(hashes(second));
  // --json 报告整篇字节相等(§19.2.8)。两 fixture root 不同,但报告已剥绝对路径→应完全一致
  expect(serializeBuildResult(first)).toBe(serializeBuildResult(second));
});
```
ponytail: 用两个独立 fixture 而非同 root 连跑两次,避免第二次 build 受既存 dist 影响、也顺带验证 root 路径不泄漏进报告。

用例 (b) env 无关性(P1 回归锁):
```ts
it('keeps platform ids, paths, and text intact regardless of environment values', async () => {
  const root = await project();
  const saved = process.env;
  // env-like map 的值故意含 platform id / 版本号子串
  process.env = { ...saved, FOO: 'claude', BAR: '1.0.0', BAZ: 'codex', QUX: 'plugin' };
  try {
    const result = await runProject({ cwd: root, command: 'build', mode: 'production', commit: true });
    const json = serializeBuildResult(result);
    expect(result.platforms).toEqual(expect.arrayContaining([claudeCode().id, codex().id]));
    // platform id / artifact path 未被 env 子串剪除
    expect(json).toContain('claude-code');
    expect(json).toContain('codex');
    const paths = result.deliveryUnits.flatMap(u => u.artifacts.map(a => a.path));
    expect(paths).toContain('.claude-plugin/plugin.json');
    expect(paths.some(p => p.includes('plugin.json'))).toBe(true);
    expect(json).not.toContain('<redacted-env>');
  } finally {
    process.env = saved;
  }
});
```
ponytail: 不加 runProject 的 env 入口(YAGNI)——生产本就读 process.env,直接包裹 process.env 即真实复现 P1 场景。

**边界与连带：** 1) 放包选择:必须在 packages/test(集成层,依赖 @tokenroll/acplugin 主包,能跑真实 runProject+commit+读产物);不放 core(core 无 runProject/无 platform 工厂,只能测 create/serializeBuildResult 单元,拿不到端到端 artifact)。 2) 可重复 fixture:复用现有 project() mkdtemp——两个独立 root 保证互不干扰;afterEach 已登记清理(splice 逻辑,新 root push 进 roots 即自动清)。 3) 两次 build 的报告为何应字节相等:report 已剥绝对路径(roots→<path>)、无 timestamp、artifact 排序确定;两 fixture 内容字节相同→sha256 相同→JSON 相同。若不等,即暴露非确定性(真 bug),正是护栏目的。 4) env map 值含子串是关键:'claude'⊂'claude-code','1.0.0'=config version 子串,'plugin'⊂路径——P1 前会被 environmentValues 剪成 <redacted-env> 破坏 id/path;P1 后完好。用例 (b) 是 P1 的红/绿护栏。 5) process.env 改写必须 try/finally 还原,且用例间 vitest 默认隔离;build.test.ts 现有 describe 非 sequential——process.env 改写会污染并发用例。缓解:给该 it 或整个新增部分用 `describe.sequential` 或把 (b) 放独立 `describe.sequential`,避免与并发用例竞争 process.env。ponytail: 最省是把 (b) 单独包一个 `describe.sequential('environment independence', ...)`。 6) commit:true 会写 dist,afterEach rm root 连带清 dist,无残留。

**测试：** 本项本身即测试。新增文件:无(就地加进 packages/test/test/build.test.ts 的 `describe('unified pipeline')` 内,(b) 建议独立 describe.sequential)。断言清单:
- (a) hashes(first) deepEqual hashes(second);serializeBuildResult(first) === serializeBuildResult(second)。
- (b) result.platforms 含 claude-code+codex;json 含 'claude-code'/'codex' 字面;artifact path 含 'plugin.json' 类;json 不含 '<redacted-env>'。
关键骨架已在 changes 给出。无需 mock,无需新 fixture 装置。

**验收：** 1) `pnpm --filter @tokenroll/acplugin test`(或 packages/test 的 vitest)两新用例绿。 2) 把 P1 改动 revert 后,用例 (b) 必须变红(env 值 'claude'/'plugin' 被 <redacted-env> 剪除导致 id/path 断言失败或 json 含 '<redacted-env>')——证明它真锁住回归;确认后再保留 P1。 3) 用例 (a) 在当前 main 上应已绿(若红说明既有非确定性,需先查);与 P1 无耦合。 4) 不引入 timestamp/绝对路径/随机依赖(fixture 用 mkdtemp 但报告已剥路径,故两 root 报告仍相等)。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** low-medium。风险点:(i) process.env 改写与并发用例竞争——用 describe.sequential 隔离(已在 edgeCases 给方案)。(ii) 若用例 (a) 在 main 上意外变红,说明存在预先未知的非确定性(如 artifact 顺序、mode、size 依赖机器),需先定位——但这正是护栏应捕获的,非本组代码风险。(iii) serializeBuildResult 字节相等依赖两 fixture 内容完全一致(project() 无参默认写死同内容,满足)。P1 与 P6 建议同一分支提交(P6 是 P1 的护栏,revert 验证需二者在同一 diff 上演示)。


---
## P4 · CI 加 test+build，发布分支加 release:verify（纯 YAML，属 S1）

**决策：** PR CI 加 `pnpm test` + `pnpm build`；新增 job 在发布分支/tag 跑 `release:verify`。纯 workflow YAML 改动，不在源码设计 agent 范围，方案已在 `review-fix-plan.md` 定稿。

**具体改动：**
- `.github/workflows/check.yml`：在 `lint` / `typecheck` 后追加 `- run: pnpm run test` 与 `- run: pnpm run build`（或合并为 `- run: pnpm run check`，其定义已是 `lint && typecheck && test && build`）。
- 新增 job（`if: startsWith(github.ref,'refs/tags/')` 或发布分支触发）跑 `- run: pnpm run release:verify`（tarball/publint/attw/private-dep-leak/clean-consumer/Pi-pack，§19.1.12）。快路径（PR）与重验收（发布）分离。

**验收：** 破坏测试或破坏构建的 PR 变红；release:verify 在 publish 前自动 gate。**工作量：** S ｜ **独立分支：** 否。

---
## S2 — 正确性 / 确定性 / 工程化

### P7 · 二级平台共享 fixture + 完整兼容矩阵 + validator 拒绝分支断言

**决策：** 在四个平台各自的 test/platform.test.ts 内新增两个 describe 块:(A) 用同一份 skills-only 语义 fixture(user:false skill + argumentHint command + capable + write/shell agent)以 strict:false 跑 executeLifecycle,对 result.compatibility 断言精确 CompatibilityEntry 集合(toEqual 排序后数组);(B) 用 DeliveryUnitRegistry + withMaterializedDeliveryUnitCandidate 直接调用各平台导出的 validate*Bundle,喂入手工构造的畸形候选,断言其独占错误码(CURSOR_MANIFEST_FIELD_UNKNOWN/CURSOR_MANIFEST_REFERENCE_MISSING、PI_PACKAGE_WORKSPACE_LEAK、ANTIGRAVITY_UNDOCUMENTED_RESOURCE、OPENCODE_CONFIG_FIELD_UNKNOWN)。fixture 不做成跨包共享文件,每包内放一个 ~15 行本地 createSharedFixture(),因为四平台产物与断言各不相同,且 validator 未公开导出、只能包内深导入。

**现状（锚点）：** 四平台已各有 test/platform.test.ts,但只做 happy-path golden/schema 断言,均未断言 compatibility 集合,也未覆盖 validator 拒绝分支。锚点:
- packages/platforms/cursor/test/platform.test.ts:87-117(仅 schema+golden+工厂拒绝)
- packages/platforms/antigravity/test/platform.test.ts:51-76(仅最小 manifest golden)
- packages/platforms/opencode/test/platform.test.ts:45-97(config+发现目录)
- packages/platforms/pi/test/platform.test.ts:72-113(pnpm pack/install)
跨平台集成测试 packages/test/test/secondary-platforms.test.ts:270-275 只用 expect.arrayContaining 抽查 4 条 compat,非精确集合,且经子进程+真实 dist,无法深导入 validator。
关键事实:①resolveConfig 默认 strict=true(packages/core/src/config.ts:427);diagnostics.ts:485-505 applyCompatibilityStrictness 把任何 degraded/unsupported 在 strict 下升级为 COMPATIBILITY_STRICT error → build 失败。故 fixture 必须传 strict:false 才能 result.success===true 且拿到完整 compat 列表。②compat 无 requires 边 → 无依赖传播(lifecycle.ts:177-185、diagnostics.ts:346-409),result.compatibility 就是各平台 generateComponentArtifacts 内 reportCompatibility 直接调用集合。③result.compatibility 排序键:platform→subject→capability→level→reason(diagnostics.ts:201-218)。④validate*Bundle 已从各自 validator.ts 导出(cursor/validator.ts:115、pi/validator.ts:72、opencode/validator.ts:38、antigravity/validator.ts:22),但 index.ts 未再导出 → 测试须 import ../src/validator.js。⑤codex 测试已示范该模式(packages/platforms/codex/test/platform.test.ts:365-440):new DeliveryUnitRegistry(new Map())→ units.add(platform.id,{id,role:'primary',type,...,artifacts:[bytesArtifact(...)]}) → withMaterializedDeliveryUnitCandidate(unit,cb,root),cb 内构造 {command,mode,candidate,reportDiagnostic} 调 validateBundle。DeliveryUnitRegistry/withMaterializedDeliveryUnitCandidate/bytesArtifact/stableJson 均从 @acplugin/core 导出。

**具体改动：**

共享 fixture 语义(每包本地实现,frontmatter 精确):
  src/commands/release.md: `---\ndescription: Prepare a release.\nargumentHint: <version>\n---\nPrepare release {{arguments}}.\n`
  src/skills/review/SKILL.md: `---\ndescription: Review a change.\ninvocation:\n  user: false\n---\nReview the change.\n`  (scanner.ts:776 → user=false,model=true)
  src/agents/reviewer.md: `---\ndescription: Review code.\nmodel: capable\ncapabilities:\n  - filesystem:write\n  - shell\n---\nReview code.\n`

(A) 每包新增 it('emits the full field-level compatibility matrix'):
  const root=await createSharedFixture();
  const result=await executeLifecycle({config: relaxedConfig(root), loadTypeScriptModule: async()=>undefined, environment:{}});
  expect(result.success).toBe(true);
  expect(result.compatibility).toEqual(EXPECTED);  // 已按 subject→capability→level 手排,见下
relaxedConfig 复用各包现有 resolvedConfig 但传对应 factory({strict:false})(cursor/opencode/pi 现有 resolvedConfig 需加 strict:false 变体;antigravity 无 options 只有 strict → antigravity({strict:false}))。

各平台 EXPECTED(全部含 platform 字段;下列按最终排序列 subject/capability/level;transformation/reason 用 expect.objectContaining 省略自由文本或按源码精确串比对):
• cursor(components.ts:48-135)7 条,degraded 4:
  agent:reviewer|agent.capabilities|degraded; agent:reviewer|agent.model|degraded; agent:reviewer|component|native; command:release|argumentHint|degraded; command:release|component|native; skill:review|component|native; skill:review|invocation.user|degraded
• antigravity(components.ts:86-183)7 条:
  agent:reviewer|agent.capabilities|degraded; agent:reviewer|agent.model|degraded; agent:reviewer|component|degraded; command:release|argumentHint|degraded; command:release|component|transform; skill:review|component|native; skill:review|invocation|degraded
• opencode(components.ts:79-165)7 条:
  agent:reviewer|agent.capabilities|transform; agent:reviewer|agent.model|degraded; agent:reviewer|component|native; command:release|argumentHint|degraded; command:release|component|native; skill:review|component|native; skill:review|invocation|degraded
• pi(components.ts:85-179)7 条(注意 argumentHint 是 native、command component 是 transform):
  agent:reviewer|agent.capabilities|degraded; agent:reviewer|agent.model|degraded; agent:reviewer|component|degraded; command:release|argumentHint|native; command:release|component|transform; skill:review|component|native; skill:review|invocation|degraded

(B) 每包新增 it('rejects a malformed candidate at the final validate boundary'):
  const registry=new DeliveryUnitRegistry(new Map());
  const diagnostics: DiagnosticInput[]=[];
  const unit=await registry.add(<factory>().id, { id:<primaryId>, role:'primary', type:<type>, artifacts:[ ...crafted bytesArtifact... ] });
  await withMaterializedDeliveryUnitCandidate(unit, candidate=>validate<X>Bundle({command:'build',mode:'production',candidate,reportDiagnostic:d=>diagnostics.push(d)}), root);
  expect(diagnostics.map(d=>d.code)).toContain('<CODE>');
畸形候选构造(每平台至少覆盖其独占码):
• cursor(id:'plugin',type:'plugin',path '.cursor-plugin/plugin.json'): 写 {name:'x',version:'1.0.0',description:'d',bogus:true,commands:'./commands/*.md'} 且不产出任何 commands/ artifact → 断言 toContain 同时含 'CURSOR_MANIFEST_FIELD_UNKNOWN'(validator.ts:131-133)与 'CURSOR_MANIFEST_REFERENCE_MISSING'(:105-106)。
• antigravity(id:'plugin',type:'plugin'): plugin.json={name:'x'} 有效,但追加 bytesArtifact('commands/release.md','x') → 断言含 'ANTIGRAVITY_UNDOCUMENTED_RESOURCE'(validator.ts:50-51)。
• opencode(id:'workspace',type:'workspace',path 'opencode.json'): 写 {$schema:'...',bogus:1} → 断言含 'OPENCODE_CONFIG_FIELD_UNKNOWN'(validator.ts:56-58)。
• pi(id:'package',type:'package',path 'package.json'): 写含 private:true / workspaces:['x'] 的对象(其余字段用合法 name/version/description/type/keywords:['pi-package']/pi:{}) → 断言含 'PI_PACKAGE_WORKSPACE_LEAK'(validator.ts:92-93)。

**边界与连带：** ①确定性:fixture 内容与 strict:false 固定,compat 由 result.compatibility 已确定性排序,toEqual 用手排数组即可;不得依赖遍历顺序。②strict 陷阱:忘记 strict:false 会让 (A) result.success===false 且 compat 仍在(compat 收集独立于 strictness),但断言语义会误导 → 必须显式 strict:false。③antigravity 工厂 options 仅 {strict}(manifest.ts:30-39),relaxedConfig 用 antigravity({strict:false}) 且 resolveConfig 的 build 也可留默认;pi/opencode/cursor 现有 resolvedConfig 传了 workspace/package/marketplace 等选项,写 relaxed 变体时保留这些选项只追加 strict:false。④validator(B) 的 toContain 而非 toEqual:pi 的 private/workspaces 也会触发 PI_PACKAGE_FIELD_UNKNOWN(validator.ts:88-90),cursor bogus 字段亦然 → 用 expect(codes).toContain(独占码),勿断言精确集合。⑤withMaterializedDeliveryUnitCandidate 会在 validate 返回后复核 artifact 完整性(transaction.ts:203-204),validator 只读不改文件 → 安全;传 temporaryParent=root 复用已 mkdtemp 的目录(codex 测试同款)。⑥DeliveryUnitRegistry.add 会校验路径/owner/hash,crafted artifacts 全用 bytesArtifact(内存源)→ 无需 ArtifactSourcePolicies,new Map() 足够。⑦opencode workspace validator 对空 opencode.json 会 early-return(:48-49);(B) 必须写非空对象才走到字段检查。⑧antigravity/pi validator 在 manifest 读失败时 early-return 不同码 → crafted manifest 必须是合法 JSON 对象。⑨连带:不改任何 src;若未来 components.ts 增删 reportCompatibility,EXPECTED 需同步——在测试注释标注锚点 file:line 便于维护。⑩不动 packages/test/secondary-platforms.test.ts(它是真实 dist 集成层,职责不同)。

**测试：** 修改文件(不新建共享文件):
- packages/platforms/cursor/test/platform.test.ts:加 import { DeliveryUnitRegistry, bytesArtifact, stableJson, withMaterializedDeliveryUnitCandidate, type DiagnosticInput } from '@acplugin/core'; import { validateCursorBundle } from '../src/validator.js'; import { PLUGIN_MANIFEST_PATH } from '../src/manifest.js'; 新增 createSharedFixture()+relaxedConfig()+两个 it。
- packages/platforms/antigravity/test/platform.test.ts:同上,import { validateAntigravityBundle } from '../src/validator.js'; { PLUGIN_MANIFEST_PATH } from '../src/manifest.js'。
- packages/platforms/opencode/test/platform.test.ts:import { validateOpenCodeBundle } from '../src/validator.js'; { WORKSPACE_CONFIG_PATH } from '../src/config-document.js'。
- packages/platforms/pi/test/platform.test.ts:import { validatePiBundle } from '../src/validator.js'; { PACKAGE_MANIFEST_PATH } from '../src/manifest.js'。
断言骨架(cursor 为例):
  it('emits the full field-level compatibility matrix', async()=>{
    const root=await createSharedFixture();
    const result=await executeLifecycle({config:relaxedConfig(root),loadTypeScriptModule:async()=>undefined,environment:{}});
    expect(result.success).toBe(true);
    expect(result.compatibility).toEqual([
      expect.objectContaining({platform:'cursor',subject:'agent:reviewer',capability:'agent.capabilities',level:'degraded'}),
      expect.objectContaining({platform:'cursor',subject:'agent:reviewer',capability:'agent.model',level:'degraded'}),
      expect.objectContaining({platform:'cursor',subject:'agent:reviewer',capability:'component',level:'native'}),
      expect.objectContaining({platform:'cursor',subject:'command:release',capability:'argumentHint',level:'degraded'}),
      expect.objectContaining({platform:'cursor',subject:'command:release',capability:'component',level:'native'}),
      expect.objectContaining({platform:'cursor',subject:'skill:review',capability:'component',level:'native'}),
      expect.objectContaining({platform:'cursor',subject:'skill:review',capability:'invocation.user',level:'degraded'}),
    ]);
  });
  it('rejects a malformed candidate at the final validate boundary', async()=>{
    const root=await createSharedFixture();
    const registry=new DeliveryUnitRegistry(new Map());
    const diagnostics: DiagnosticInput[]=[];
    const unit=await registry.add(cursor().id,{id:'plugin',role:'primary',type:'plugin',artifacts:[
      bytesArtifact(PLUGIN_MANIFEST_PATH,stableJson({name:'x',version:'1.0.0',description:'d',bogus:true,commands:'./commands/*.md'})),
    ]});
    await withMaterializedDeliveryUnitCandidate(unit,candidate=>validateCursorBundle({command:'build',mode:'production',candidate,reportDiagnostic:d=>diagnostics.push(d)}),root);
    const codes=diagnostics.map(d=>d.code);
    expect(codes).toContain('CURSOR_MANIFEST_FIELD_UNKNOWN');
    expect(codes).toContain('CURSOR_MANIFEST_REFERENCE_MISSING');
  });
其余三平台镜像替换 factory/id/type/path/crafted-manifest/独占码(见 changes B)。可选:用 it.each 遍历 4 条 degraded 子集降低维护成本,但精确 toEqual 集合更能锁死回归,优先精确集合。

**验收：** ①pnpm --filter @acplugin/platform-cursor|-antigravity|-opencode|-pi run test 全绿(pretest 会先 build core)。②四个 (A) 用例 result.compatibility 精确等于上列 7 条集合(顺序无关用 arrayContaining 需额外断言 length===7;推荐 toEqual 排序数组直接锁顺序)。③四个 (B) 用例各自 codes.toContain 对应独占码:cursor 含 CURSOR_MANIFEST_FIELD_UNKNOWN+CURSOR_MANIFEST_REFERENCE_MISSING、antigravity 含 ANTIGRAVITY_UNDOCUMENTED_RESOURCE、opencode 含 OPENCODE_CONFIG_FIELD_UNKNOWN、pi 含 PI_PACKAGE_WORKSPACE_LEAK。④pnpm -r typecheck 通过(注意 exactOptionalPropertyTypes:各平台 tsconfig 继承 base,构造 DiagnosticInput/ctx 时字段齐全)。⑤重复运行两次 compat 与 diagnostics 字节稳定(无 timestamp/绝对路径:validator 消息已无宿主路径)。

**工作量：** M ｜ **独立分支：** 是 ｜ **风险：** ①EXPECTED 是从 components.ts 静态推导(无依赖传播、strict:false),若我对 isReadOnly([filesystem:write,shell])=false 的判断或某条 reportCompatibility 触发条件读偏,精确 toEqual 会红——已逐行核对四份 components.ts,置信度高,但落地时应先跑一次打印 result.compatibility 校准再锁数组。②pi (B) 若同一 crafted manifest 同时缺 pi 对象会提前 return(validator.ts:101-104)错过 workspace 检查——务必给合法 pi:{} 与 keywords:['pi-package']。③各平台现有 resolvedConfig 是 strict 默认(未显式);新增 relaxed 变体不要改动原 happy-path 用例的严格语义。


---

### P8 · scanner Public targetPath 反斜杠归一化两层统一,与 config.ts 对齐

**决策：** 把 collectPublicTree 与 finalizePublicFiles 的 targetPath 归一化从 split(path.sep).join('/') 改为 split(/[\\/]/).join('/'),两层统一并与 config.ts:248 的 split(/[\\/]/) 对齐,在空/绝对/.. 与冲突键计算之前完成。

**现状（锚点）：** packages/core/src/scanner.ts:895 (collectPublicTree 文件分支) 返回 `targetPath: target.split(path.sep).join('/')`;scanner.ts:926 (finalizePublicFiles) `const targetPath = file.targetPath.split(path.sep).join('/').replace(/^\.\//, '')`,随后 927 做 空/绝对/.. 检查、934 计算折叠冲突键。参照 config.ts:248 `rule.from.split(/[\\/]/).includes('..')` 用的是双分隔符正则。POSIX 上 path.sep==='/',split(path.sep) 不会切分反斜杠:一个合法(不含 ..、非绝对、能通过 config.ts:248 校验)的 copy 规则 `to: 'sub\\dir'` 经 path.join 递归后,在 POSIX 产出 targetPath `sub\dir/entry`(反斜杠原样保留),而 Windows(path.sep==='\\')产出 `sub/dir/entry` —— 同一工程字节在不同宿主 OS 产出不同 Artifact 路径,违反 §18 确定性。

**具体改动：**

两处同样改法(注意是 join('/') 正斜杠,不是空串——防止照抄方案里的 .join("") 笔误):

scanner.ts:895
- `return [{ sourcePath: source, targetPath: target.split(path.sep).join('/'), mode: modeFromStat(stat.mode) }];`
+ `return [{ sourcePath: source, targetPath: target.split(/[\\/]/).join('/'), mode: modeFromStat(stat.mode) }];`

scanner.ts:926
- `const targetPath = file.targetPath.split(path.sep).join('/').replace(/^\.\//, '');`
+ `const targetPath = file.targetPath.split(/[\\/]/).join('/').replace(/^\.\//, '');`

严格说只有 926(finalize)是承载检查/冲突键的那层,是必须改的;895 一并改是为方案要求的“两层统一”,避免中间表示夹带反斜杠段。归一化顺序无需调整:926 已在 927 的检查之前完成,仅换正则。

**边界与连带：** 确定性:此改动是修 §18 而非引入风险——把 backslash 的宿主差异消除,POSIX/Windows 都产出 `/` 分隔的稳定路径;不引入 timestamp/绝对路径/随机。安全:config.ts:448 在 hasErrors 时提前返回,含 `..` 的反斜杠 copy 规则其实在 config 阶段(CONFIG_PUBLIC_RULE_ESCAPE)已被拦,scanner 收不到,所以本项主线价值是跨平台确定性,`..` 一致性是与 config 的纵深防御。`.replace(/^\.\//,'')` 仍在 split+join 之后:前导 `.\` 会先被规范成 `./` 再被剥掉。默认整目录分支 target 从 '' 起、段来自 fs.readdir 不含分隔符,不受影响。无其它调用点:这两行是唯二做 targetPath 分隔符归一化的地方。

**测试：** packages/core/test/scanner.test.ts 新增一例(沿用 temporaryProject/projectConfig/scanProject 脚手架):
```
it('normalizes backslash Public targets to stable POSIX paths', async () => {
  const root = await temporaryProject();
  await fs.mkdir(path.join(root, 'public'), { recursive: true });
  await fs.writeFile(path.join(root, 'public/file.txt'), 'x');
  const diagnostics = new DiagnosticCollector();
  const { project } = await scanProject(
    projectConfig(root, { public: { copy: [{ from: 'file.txt', to: 'a\\\\b\\\\c.txt' }] } }),
    diagnostics,
  );
  expect(diagnostics.diagnostics).toEqual([]);
  expect(project.publicFiles.map(f => f.targetPath)).toEqual(['a/b/c.txt']);
});
```
断言 targetPath === 'a/b/c.txt'(宿主无关);修复前 POSIX 上会是 'a\\b\\c.txt'。config.ts:248 已确认 `to: 'a\\b\\c.txt'` 合法(非绝对、split(/[\\/]/) 无 '..')。

**验收：** 1) 新测试通过,targetPath 为 'a/b/c.txt';2) 现有 scanner.test.ts 全绿(默认目录/collision 用例不变);3) grep 确认仓库内不再有 `targetPath.split(path.sep)` 残留;4) 与 config.ts:248 正则一致。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** 唯一坑是照抄方案里的 `.join("")` 笔误——必须 `.join('/')`。否则无风险。


---

### P9 · report items[] 按稳定键 (kind → id → source) 排序

**决策：** 构建 MigrationReport 前对聚合的 items[] 按 (kind, id, source) 三级稳定键排序,不改任何扫描器行为、不改字段内容,仅使报告数组顺序确定。

**现状（锚点）：** items[] 在 migrate() 内按阶段/扫描顺序 push:marketplace item(:1581)、每工程 writeCanonicalProject 返回的 items(:1600-1608 --all / :1616 / :1626);工程内顺序为 metadata(:1247)→skills→commands→agents(Promise.all 前 push,:1352-1358)→instructions(:1360-1369)→mcp(:1373-1417)→hooks(:1419-1432)→plugin-files(:1434-1441)。report 对象在 index.ts:1635-1638 组装,items 直接引用累计数组,顺序即 push 顺序,受 scan 顺序(readdir 非确定)影响。stableJson 只排对象键,不排数组元素,故 report.json 中 items 顺序当前不确定。

**具体改动：**

在 index.ts 组装 report 前(:1634 注释行之前、:1635 之上)插入一次稳定排序,写回新数组:
```
// items 顺序不得依赖扫描器 readdir 顺序;按 (kind,id,source) 稳定排序保证报告确定性。
const sortedItems = [...items].sort((a, b) =>
  a.kind.localeCompare(b.kind, 'en')
  || a.id.localeCompare(b.id, 'en')
  || (a.source ?? '').localeCompare(b.source ?? '', 'en'));
```
把 report 字面量(:1636)的 `items` 改为 `items: sortedItems,`。其余不动。可选:抽成 module 级纯函数 `sortMigrationItems(items)` 便于单测直接调用,但内联足够(YAGNI)。fields 内部顺序保持不变(字段报告有其自身语义顺序,且各处 Object.keys 已 localeCompare 排序,无需再动)。

**边界与连带：** id 可能重复(P3 消歧后应唯一;未做 P3 时同 kind 可能同 id)——加 source 作三级键可稳定区分绝大多数;若 kind+id+source 仍相同(理论上同一资源不会),排序稳定回退到 Array.sort 稳定性(Node 保证),无害。source 对聚合类 item(marketplace/metadata 用 '.'、hook-file 用相对路径)均有值或用 ?? '' 兜底,不会 throw。localeCompare('en') 与仓库既有排序一致,跨平台稳定。不触碰扫描器、不引入 Core 内部依赖(纯字符串比较),满足隔离子系统只用公开 API 约束。与 P3 协同:P3 已排序 scan 集合,P9 再对最终 items 排序是幂等叠加,二者独立成立。

**测试：** 文件: packages/test/test/migration.test.ts。
新增用例 'orders report items by stable (kind,id,source) key':造含多类资源(≥2 skills 乱序名、1 command、1 agent、1 instruction)的 legacy project,迁移后断言 report.items 的 (kind,id) 序列等于按键排序后的期望序列:
```
const keys = report.items.map(i => `${i.kind}:${i.id}`);
expect(keys).toEqual([...keys].sort((a,b)=>a.localeCompare(b,'en')));
```
更强的确定性断言:对同一 fixture 迁移两次(不同 destination),断言两次 report.items 的 (kind,id,source) 序列完全一致。也可在现有 'preserves Command, Skill, Agent, metadata...' 用例(:287)末尾追加一行断言 items 已排序,复用其丰富资源集,避免新建大 fixture。

**验收：** report.items 始终按 (kind,id,source) 升序;相同输入的两次迁移产生逐元素一致的 items 数组(且 report.json 字节一致)。扫描器输出、字段内容、成功/失败判定、各资源 destination 均不变。现有 migration 测试全部通过(现有断言用 toContainEqual/arrayContaining,不依赖顺序,不受影响)。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none — 纯数组重排,现有断言均为顺序无关(toContainEqual/arrayContaining/toMatchObject),无回归风险。可与 P3 同分支提交(同文件、同确定性主题)。


---

### P10 · pendingArtifacts 用 try/finally + Promise.allSettled 兜底,消除 apply 抛错时的未处理 rejection 窗口

**决策：** 把 `adapter.apply` 与 `Promise.all(pendingArtifacts)` 包进 try,在 finally 里 `await Promise.allSettled(pendingArtifacts)`,保证无论 apply 如何退出每个 emit promise 都被观察;Promise.all 仍负责把首个 rejection 作为构建失败向上抛。

**现状（锚点）：** packages/core/src/lifecycle.ts:556-580。Adapter 上下文的 emitArtifact 回调(:569-571)把 `draft.emitArtifact(...)` 返回的 promise `push` 进 `pendingArtifacts`(:557 声明),自身不 await。随后 :579-580:`await adapter.apply(context, extensionRuntime.built as never); await Promise.all(pendingArtifacts);`。若 apply 抛错(或某个 emit 先 reject 让 Promise.all 提前 reject),其余已在途的 emit promise 无人 await——形成未处理 rejection 窗口。该块整体位于平台生成 try/catch(:517-680)内,任何抛错会被 :675 捕获成 PLATFORM_GENERATION_FAILED + removePlatform。

**具体改动：**

仅改 :579-580:
```
-            await adapter.apply(context, extensionRuntime.built as never);
-            await Promise.all(pendingArtifacts);
+            try {
+              await adapter.apply(context, extensionRuntime.built as never);
+              await Promise.all(pendingArtifacts);
+            } finally {
+              // 无论 apply 如何退出,都观察每个 emit promise,消除未处理 rejection 窗口。
+              await Promise.allSettled(pendingArtifacts);
+            }
```
保持 12 空格缩进,置于 for-each extensionRuntime 循环体内。

**边界与连带：** 1) 成功路径行为不变:apply await 返回后 pendingArtifacts 已定型(apply 返回后 context 不再被使用,不会再 push),Promise.all 已 await 全部,finally 的 allSettled 只是对已 settled promise 再 await,零副作用。2) 失败路径:Promise.all 仍在 try 内 reject/抛出,驱动平台失败(PLATFORM_GENERATION_FAILED),finally 的 allSettled 只负责“观察”其余 rejection(附加 handler),不会吞掉原始错误(finally 不 return);allSettled 自身永不 reject。3) 确定性零影响:artifacts.ts:124 的 `artifacts` getter 按 path localeCompare 排序输出,产物顺序与 promise 结算顺序无关;且失败平台会被 removePlatform 丢弃。4) 不改契约、不改 emitArtifact 签名、不新增依赖。

**测试：** packages/core/test/lifecycle.test.ts 新增(os/path 已导入):
```
it('observes every emitted Artifact promise even when an Adapter throws before awaiting them', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const platform = definePlatform({ id: 'leak-platform', apiVersion: '1', deliveryType: 'plugin',
      prepare: () => ({ documents: [], artifacts: [] }),
      generateBundle: () => ({ id: 'plugin', role: 'primary', type: 'plugin', artifacts: [] }),
      validateBundle: () => undefined });
    const leaky = defineExtension({ name: 'leaky-extension', apiVersion: '1',
      discover: () => ({ enabled: true }),
      adapters: [{ extensionApiVersion: '1', platform: 'leak-platform', platformApiVersion: '1',
        apply(context) {
          // 校验阶段必然 reject 的 emit(来源既越权又不存在),随后 apply 在 Promise.all 之前抛错
          context.emitArtifact({ path: 'orphan.txt', source: { type: 'file', path: path.join(os.tmpdir(), 'acplugin-never-exists-xyz') } });
          throw new Error('adapter throws before Promise.all');
        } }] });
    const root = await temporaryRoot();
    const result = await executeLifecycle({ config: lifecycleConfig(root, 'validate', [platform], [leaky]), loadTypeScriptModule: async () => undefined, environment: {} });
    await new Promise(resolve => setTimeout(resolve, 0)); // 冲刷微/宏任务,让漏掉的 rejection 有机会触发
    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLATFORM_GENERATION_FAILED', platform: 'leak-platform' }));
    expect(unhandled).toEqual([]); // 修复前此断言失败:orphan promise 未被观察
  } finally { process.off('unhandledRejection', onUnhandled); }
});
```
该用例的鉴别力:旧代码 apply 抛错后从不 await Promise.all,orphan emit promise 无 handler → unhandledRejection 触发,`unhandled` 非空;新代码 finally 的 allSettled 在 executeLifecycle resolve 前就观察了它,`unhandled` 为空。

**验收：** pnpm -C packages/core test 通过;新用例在打了本补丁时绿、回退补丁时红(unhandled 非空)。既有 lifecycle 成功/失败用例产物顺序与断言不变。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none(纯兜底观察,不改成功/失败语义与产物;唯一新增测试依赖 process 级 unhandledRejection 监听 + 一个 setTimeout(0) 冲刷,属常见可靠模式)。


---

### P11 · 两 Extension 包加 publint+attw(对齐主包)+ tsconfig.base 开 isolatedDeclarations

**决策：** ① hooks/mcp 两个 tsdown.config.ts 各加 `publint: true` 与 `attw: { profile: 'esm-only', level: 'error' }`,与主包 packages/acplugin/tsdown.config.ts:22-23 完全一致;② tsconfig.base.json 开 `isolatedDeclarations: true`,并【必须同时】加 `declaration: true`(否则 TS5069),noEmit:true 已在,保持只检查不产出。两包代码经实测已 ID-clean,无需补类型标注。

**现状（锚点）：** 已 Read 并实测。
- packages/extensions/hooks/tsdown.config.ts:4-13,末尾 `sourcemap: false,` 后直接是 `deps: { neverBundle: ['@tokenroll/acplugin'] },`,无 publint/attw。
- packages/extensions/mcp/tsdown.config.ts:5-17,同样 `sourcemap: false,` 后接 `deps: { neverBundle: [...] },`,无 publint/attw。
- 参照物(已正确):packages/acplugin/tsdown.config.ts:22-23 = `publint: true,` + `attw: { profile: 'esm-only', level: 'error' },`。
- tsconfig.base.json:26-33 现有 strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes/verbatimModuleSyntax/isolatedModules/resolveJsonModule/skipLibCheck/noEmit,无 declaration、无 isolatedDeclarations。所有包 tsconfig 均 extends base 且 include `src/**/*.ts`+`test/**/*.ts`(core/6平台/hooks/mcp/acplugin/test 均已确认)。

**具体改动：**

# packages/extensions/hooks/tsdown.config.ts —— sourcemap 行后插 2 行
   sourcemap: false,
+  publint: true,
+  attw: { profile: 'esm-only', level: 'error' },
   deps: { neverBundle: ['@tokenroll/acplugin'] },

# packages/extensions/mcp/tsdown.config.ts —— 同样插 2 行
   sourcemap: false,
+  publint: true,
+  attw: { profile: 'esm-only', level: 'error' },
   deps: { neverBundle: ['@tokenroll/acplugin'] },

# tsconfig.base.json —— 在 isolatedModules 后插 2 行(位置任意,放此处最贴切)
     "isolatedModules": true,
+    "declaration": true,
+    "isolatedDeclarations": true,
     "resolveJsonModule": true,

代码改动:无。实测两包 src+test 已 ID-clean(见 tests),不需要任何显式返回类型标注。

**边界与连带：** 全部经真实工具链(tsdown v0.22.14 / tsc v7.0.2)实测:
1) 【已验证 attw profile 必须 esm-only】默认/strict profile 对两包报 `❌ No resolution (node10)` + `⚡ CJS resolves to ESM (node16-cjs)`;换 `profile:'esm-only'` 后两包均 `[attw] No problems found`、`[publint] No issues found`、build exit 0。原因:两包是纯 ESM(type:module、exports 仅 import 条件),esm-only 正是为此设计,忽略 node10/CJS 类问题 —— 与主包同款,故 level:'error' 安全。
2) 【已验证 isolatedDeclarations 需 declaration】单开 isolatedDeclarations 直接 `error TS5069: … cannot be specified without … 'declaration' or … 'composite'`。故必须同时加 declaration:true。
3) 【已验证 declaration+noEmit 只检查不产出】11 个 tsconfig 全跑 `tsc -p … --isolatedDeclarations --declaration` 均 exit 0,且 src 下无任何 .d.ts 落地(noEmit:true 生效)。
4) 【已验证全仓 ID-clean】core/hooks/mcp/acplugin/6平台/test 共 11 个 tsconfig 全部 exit 0 —— 与全包已用 `dts:{generator:'oxc'}` 一致(oxc dts 本就要求 isolated-declarations 可发射)。所以本项对 src 零改动。
5) 确定性:isolatedDeclarations 只影响 `tsc` 类型检查,tsdown 构建走 oxc 自己的 dts 管线,不读 tsconfig.declaration → dist 字节不变;attw/publint 是构建期 pass/fail 门禁,输出无 timestamp/路径,不进产物。
6) 主包已带这两门禁,base 全局开 isolatedDeclarations 是把『oxc-dts 可发射性』升级为 typecheck 层强制(纵深防御),无其它配置连带。
7) 应对(仅备用,当前用不到):若未来某文件不 ID-clean,tsc 会指名报 TS9xxx,最小修法是给该导出符号补显式返回类型/`satisfies`,不要退回全文件 any。

**测试：** 不新增 Vitest —— 门禁本身即测试(回归即构建失败)。验收用命令断言:
- `pnpm --filter @tokenroll/acplugin-extension-hooks run build` 与 `… -mcp run build` 输出含 `[attw] No problems found` + `[publint] No issues found`,exit 0。
- `pnpm -w run typecheck` 在 base 开 isolatedDeclarations+declaration 后全绿(覆盖 11 包 src+test)。
- 确定性:改前改后各跑一次 `pnpm -w run build`,`git status packages/*/dist` 无字节差异(证明 tsconfig 改动不影响产物)。

**验收：** 两扩展 build 均 attw(esm-only)+publint 绿;pnpm typecheck 全仓绿(含 declaration+isolatedDeclarations);pnpm build 产物字节与改动前一致;两 tsdown.config 的新增行与主包逐字一致。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none(三项改动均已用真实 tsdown/tsc 实测通过;唯一强约束是 declaration:true 必须与 isolatedDeclarations 同时加,方案已含)。


---

### P13 · 注释守卫防漂移:check-comments 增加生产 src glob,未登记文件即失败

**决策：** check-comments.mjs 递归收集 packages/*/src/**/*.ts,凡不在 comment-coverage.json.enforcedFiles 的生产源码文件即报错退出,防止新增源码文件绕过中文注释守卫。用 stdlib 递归 readdir(不用 fs.globSync,兼容 engines>=20)。

**现状（锚点）：** scripts/check-comments.mjs:135-146 main() 只遍历 coverage.enforcedFiles 做缺失注释检查,不校验是否有生产源码文件遗漏登记 —— 新加的 src 文件不进 enforcedFiles 就永远不被守卫,产生静默漂移。package.json engines.node='>=20';fs.globSync 直到 Node 22 才可用,不能依赖(当前机器 v22 但 CI/协作者可能 20)。已核实当前 packages/*/src/**/*.ts 共 32 个、0 个未登记,故引入该 gate 不会立即误红。

**具体改动：**

check-comments.mjs:第 1 行 import 增加 readdirSync:
`import { readFileSync, readdirSync } from 'node:fs';`
新增两个纯函数:
```
/** 递归收集一个目录下的全部生产 TypeScript 源文件。 */
function collectSources(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSources(full));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(full);
  }
  return files;
}
/** 收集所有 packages/*/src 下的生产源码,路径规范化以便与 enforcedFiles 比对。 */
function productionSources() {
  const result = [];
  for (const pkg of readdirSync('packages', { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    try { result.push(...collectSources(path.join('packages', pkg.name, 'src'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result.map(file => path.normalize(file));
}
```
main() 在读 coverage 之后、缺失注释检查之前插入漂移 gate:
```
  const enforced = new Set(coverage.enforcedFiles.map(file => path.normalize(file)));
  const uncovered = productionSources().filter(file => !enforced.has(file));
  if (uncovered.length > 0) {
    process.stderr.write(`以下生产源码未纳入注释守卫覆盖范围：\n${uncovered.map(item => `- ${item}`).join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
```

**边界与连带：** 确定性:collectSources 对目录项 localeCompare 排序,输出稳定;路径统一 path.normalize 与 enforcedFiles(仓库根相对)比对——脚本本就假定 cwd=仓库根(COVERAGE_FILE='scripts/comment-coverage.json' 直接相对读取),npm script `comments:check` 从根运行,一致。范围仅生产 src(排除 .d.ts、dist、test/;packages/test 无 src 目录故其测试文件不被强制)。ENOENT(无 src 的包)吞掉。不改反向检查(enforcedFiles 里已删文件的陈旧项)——超出本项范围,且 missingComments 遇 ENOENT 本会抛,另议。当前 0 未登记,引入即绿。

**测试：** 该脚本无 vitest 宿主,采用最小可运行验收(ponytail 式 smallest check),写入 CI/手册:
1) 在 packages/core/src 放临时探针 `__drift_probe.ts`(不加入 enforcedFiles)→ `node scripts/check-comments.mjs`(或 pnpm comments:check)→ 断言退出码 1 且 stderr 含 'packages/core/src/__drift_probe.ts';删探针 → 退出码 0。
2) 回归:未加探针时 `pnpm comments:check` 仍打印 `中文注释守卫已覆盖 N 个文件。` 且退出 0。
可选:若要 CI 固化,加一个 node:test `scripts/check-comments.test.mjs` 只测 productionSources()/uncovered 计算(需先把这两函数 export);当前 YAGNI,不强制。

**验收：** 1) 存在任一 packages/*/src/**/*.ts(非 .d.ts)未登记 enforcedFiles 时 comments:check 非零退出并列出该文件;2) 全登记时行为与现状一致(打印覆盖数、退出 0);3) 不依赖 fs.globSync,Node 20 可运行;4) 现有 lint 流水线全绿。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none —— 已核实当前无未登记文件,不会引入误红;若将来有意保留某 src 文件不登记,需在脚本加显式白名单(当前无此需求,YAGNI)。


---
## S3 — 架构级（dev 缓存 + utils 去重）

### P14 · dev 增量缓存:Core 层通用记忆化(dev-only,内存跨 rebuild)

**决策：** 在 executeProject 之上包一层进程内缓存(NOT 在 executeLifecycle 内),粒度=整条 project 执行(输入指纹→上次 ProjectExecution),存储=内存 Map(跨 chokidar rebuild,不落磁盘),仅 command==='dev' 生效;key = stableJson(所有 component body+sourcePath+mode + publicFiles 内容 hash + 冻结 config 快照 + lifecycleWatchFiles 内容 hash + LIFECYCLE_API_VERSION + ACPLUGIN_VERSION + node major)。命中即跳过 executeLifecycle 直接复用上次 result/watchPaths;不进 dist 因为命中时根本不重新 commit(上次已 commit 且字节相同)。build 路径完全不接缓存。

**现状（锚点）：** 生命周期入口 packages/core/src/lifecycle.ts:218 executeLifecycle:每次运行 fs.mkdtemp 建 runtimeRoot(:222),结束 finally fs.rm(runtimeRoot)(:728) —— 所有 workDir 及其中 file-source artifact 每轮销毁。extension build 单次运行内复用雏形在 lifecycle.ts:485 `runtime.built = await runtime.extension.build?(...)`,build 只调一次,:579 各 platform adapter 复用同一 built;这是【单运行内】复用,无跨运行缓存。CLI dev 重建入口:packages/acplugin/src/cli.ts:378 performRebuild → executeProject;每次文件变更经 cli.ts:326 scheduleRebuild(50ms 防抖)→ rebuild()→ runRebuildQueue()→ performRebuild()。executeProject 在 packages/acplugin/src/run-project.ts:44,内部 run-project.ts:98 executeLifecycle 一次,收集 lifecycleWatchFiles(:103 onWatchFile),返回 ProjectExecution{result,projectRoot,outDir,watchPaths,dependencyRoots}(:124)。关键现实核对(与方案措辞不符,必须按真实源码设计):(1) scanner【未】给 component 附 SHA-256 —— grep 确认 sha256 只在 types.ts:291/318 的 Artifact/ArtifactReport 上,由 ArtifactRegistry 后期计算(artifacts.ts:42 hashFile);PluginProject.commands/skills/agents(types.ts:98-152)只带 body(已读入内存的文件内容)+sourcePath,publicFiles(types.ts:158)只带 sourcePath。故 L1 指纹必须由缓存层【自己算】,body 就是天然内容源,publicFiles 需读盘 hash。(2) 平台无 per-package semver:contracts.ts:15 LIFECYCLE_API_VERSION='1' 是唯一常量,platform/extension 只带 apiVersion。工具版本只能取 ACPLUGIN_VERSION + process.versions.node major。tsdown/rolldown 版本 core 未 import,见下 risks。(3) config 快照可 hash:run-project.ts:50 config:ResolvedConfig(types.ts:253)含 root/command/mode/metadata/srcDir/public/platforms/extensions/outDir/strict。

**具体改动：**

只加一个薄缓存层,不动 executeLifecycle 内部(§18 build 语义不能碰)。

【新增文件】packages/acplugin/src/dev-cache.ts(放 acplugin 主包而非 core:key 需 ACPLUGIN_VERSION,且 executeProject 就在主包;Core 不该知道 dev-watch 存储策略):
```ts
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import process from 'node:process';
import { stableJson, LIFECYCLE_API_VERSION, type ResolvedConfig } from '@acplugin/core';
import { ACPLUGIN_VERSION } from './index.js';
import type { ProjectExecution } from './run-project.js';

// ponytail: 进程内单例 Map,dev 进程生命周期即缓存生命周期;不落盘 => 天然不进 dist,进程退出即清。
const cache = new Map<string, ProjectExecution>();

async function sha256File(file: string): Promise<string> {
  try { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
  catch { return 'ENOENT'; } // 缺失文件参与 key => 下轮存在时 key 变、自然失效
}

// 只 hash 与产物字节相关的输入:component body(已在内存)、public 文件内容、
// extension bundler 实际读到的模块图(lifecycleWatchFiles)、冻结 config、工具版本。
export async function computeCacheKey(
  config: ResolvedConfig,
  watchedModuleFiles: readonly string[],
): Promise<string> {
  const project = /* 见下:需要 body。见 risks:executeProject 目前不返回 project */;
  const publicHashes = await Promise.all(config.public.enabled ? [] : []); // 见 changes 下方
  const fingerprint = {
    apiVersion: LIFECYCLE_API_VERSION,
    tool: ACPLUGIN_VERSION,
    node: process.versions.node.split('.')[0],
    command: config.command, mode: config.mode,
    config: { srcDir: config.srcDir, strict: config.strict, outDir: config.outDir,
      metadata: config.metadata, public: config.public,
      platforms: config.platforms.map(p => ({ id: p.platform.id, api: p.platform.apiVersion,
        delivery: p.platform.deliveryType, strict: p.strict, options: p.platform.options })),
      extensions: config.extensions.map(e => ({ name: e.name, api: e.apiVersion })) },
    modules: /* [path, sha256File(path)] 排序后数组 */,
    components: /* 见 risks: 需拿到 project 的 body/sourcePath/mode */,
  };
  return createHash('sha256').update(stableJson(fingerprint)).digest('hex');
}

export function getCached(key: string): ProjectExecution | undefined { return cache.get(key); }
export function setCached(key: string, value: ProjectExecution): void {
  if (cache.size > 8) cache.clear(); // ponytail: dev 单工程,>8 key 只可能是长会话漂移,整体清比 LRU 省
  cache.set(key, value);
}
```

【改 run-project.ts】把缓存作为 executeProject 的一层壳。有两个可行接法,取【壳法】(改动最小、不污染 build 路径):
1. 抽出现有 executeProject 主体为不带缓存的 `runProjectExecution(options)`(直接把当前 44-124 行原样改名)。
2. 新 executeProject 包壳:
```ts
export async function executeProject(options: RunProjectOptions): Promise<ProjectExecution> {
  if (options.command !== 'dev') return runProjectExecution(options); // build/validate/inspect 零缓存
  // dev:先 loadProjectConfig 拿 config + 先跑一次拿到 project+watchedModuleFiles 才能算 key —— 见 risks 的鸡生蛋。
  // 采用【运行后写、运行前查】需要在不执行 lifecycle 的情况下先得到指纹输入。
  // 落地方案见 edgeCases「指纹输入来源」。
}
```

【run-project.ts 需要新增返回 project】:computeCacheKey 需要 component body。ProjectExecution 当前不含 project。最小改动:executeLifecycle 已在内部 scanProject;但它不回传 project(只回 BuildResult)。选择【在缓存层独立 scanProject 一次算指纹】而不是改 executeLifecycle 签名 —— scanProject 是纯读、无副作用(scanner.ts:1183),dev 下多跑一次扫描成本可接受且不破坏 §18。即缓存层:loadProjectConfig → scanProject(config, throwaway DiagnosticCollector) 得 project.body → 若扫描有 error 则 key 不稳定,直接 fallback 到 runProjectExecution(不缓存)。

【public 文件 hash】config.public.enabled 时,glob/复制规则在 scanner 内已解析为 project.publicFiles(sourcePath),直接对每个 sourcePath sha256File。

【不进 dist 保证】命中路径【完全不调用 executeLifecycle】=> 不 mkdtemp、不 commit、不碰 outDir;上次 miss 时已 commit 且因 key 相同字节必然相同,dist 保持上次结果。这就是 dev-only 且不进稳定产物的物理保证。

**边界与连带：** 【指纹输入来源(核心坑)】key 需要 component body + extension 读到的模块图(lifecycleWatchFiles)。前者 scanProject 纯读可得;后者【只有跑完 lifecycle 才知道】(onWatchFile 在 build 阶段回调)。解法:两段式——(a) 用 scanProject 得到的 project.body + publicFiles hash + config + 工具版本算【源指纹 sourceKey】;(b) 模块图(node_modules 里的 extension handler)变化由 chokidar 的 dependencyRoots 监听已覆盖,其内容变化会触发 rebuild,但【不必进 key】——因为若 extension bundle 输入变了、chokidar 触发 rebuild、而 sourceKey 未变则会误命中。所以【模块图必须进 key】:改为缓存层在【首次 miss 执行后】用返回的 watchPaths∩(在 dependencyRoots 内的文件) 事后 hash 组成完整 key 存入;查时先算 sourceKey 找候选,再对候选记录的 moduleFiles 重新 hash 比对,任一变化即 miss。即缓存 value 附带 {moduleFileHashes},命中判定=sourceKey 命中 且 moduleFileHashes 全部逐一 re-hash 相等。这样避免鸡生蛋,且模块内容变化必然失效。
【确定性/§18】缓存只影响 dev 且命中时产物字节与上次 commit 完全一致(key 覆盖全部产物决定因素),不引入 timestamp/绝对路径/随机:key 里 config.root/outDir 是绝对路径但只进 hash 不进产物,且 dev 本就机器本地,不影响稳定产物字节。build 路径 command!=='dev' 直接绕过,§18 事务全量提交语义零改动。
【工具版本】ACPLUGIN_VERSION(index.ts 已导出)+ node major 足够触发跨版本失效;tsdown/rolldown 版本见 risks(用 lockfile hash 兜底)。
【失效条件】任一 component body、public 内容、config 快照字段、任一 module 文件内容、ACPLUGIN_VERSION、node major、LIFECYCLE_API_VERSION 变化 → key 变 → miss。scan 出 error → 不缓存(fallback)。
【连带改动】cli.ts 无需改(仍调 executeProject);run-project.ts export 需新增 runProjectExecution 供壳调用(或壳内联)。index.ts 无需导出 dev-cache(纯内部)。
【跨平台】全部走 stableJson(键排序)+ crypto sha256,无路径分隔符进产物;sha256File 读字节不解码,不受行尾/编码影响。
【connections】migrate/init 不经 executeProject,不受影响。

**测试：** 新增 packages/acplugin/test/dev-cache.test.ts(vitest),参照 lifecycle.test.ts 的 temporaryRoot 夹具与 config-loader.test.ts 的工程搭建风格。用例骨架:
1. hit: 同一工程连续两次 executeProject({command:'dev'}) —— 第二次命中,断言两次 result 深相等 且 executeLifecycle 只被调一次(spy/counter:在缓存层注入一个可观察计数,或断言 outDir 的 mtime 第二次未变作为「未重新 commit」证据)。
2. miss-on-source: 两次之间修改一个 command .md body → 断言未命中(result 反映新内容,且发生了新 commit)。
3. miss-on-tool-version: monkeypatch computeCacheKey 依赖的 ACPLUGIN_VERSION 或 process.versions.node → 断言 key 变、miss。用例通过导出 computeCacheKey 直接断言两组输入 key 不等,避免真的改进程版本。
4. miss-on-module-change: extension handler 文件内容变更 → 断言 moduleFileHashes 比对失败 → miss。
5. build-bypass: executeProject({command:'build'}) 两次 → 断言【从不】写入 cache(getCached 恒空),证明 build 不接缓存。
6. not-in-dist: 命中后断言 outDir 内容与首次完全一致 且 无新增临时 acplugin-work-* 目录残留(命中不 mkdtemp)。
关键断言点:computeCacheKey 是纯函数、同输入同 key、异输入异 key(直接单测最省)。副作用(executeLifecycle 调用次数)用注入计数器观察。

**验收：** 1. dev 下无源码/配置/工具/模块变化的连续 rebuild 第二次起命中,不重新执行 executeLifecycle、不重新 commit、不新建 acplugin-work-* 临时目录;2. 修改任一 component body/public 内容/config 字段/extension 模块内容/node major/ACPLUGIN_VERSION 均导致 miss 并产出与全量构建【逐字节相同】的结果;3. build/validate/inspect 完全不接触缓存(cache 恒空);4. 命中/失效均不改变 dist 字节(§18 稳定产物不受 dev 缓存影响);5. computeCacheKey 单测:同输入同 key、异输入异 key;6. 全部现有 core/acplugin 测试与 pnpm build 通过,无新私有 workspace 依赖(dev-cache.ts 只依赖 @acplugin/core 与本包)。

**工作量：** M ｜ **独立分支：** 是 ｜ **风险：** 【R1 tsdown/rolldown 版本不可得】方案硬约束要求 key 含 tsdown/rolldown/node major,但 core/acplugin 源码未 import tsdown/rolldown(它们是构建期工具,运行期不可见其 semver)。落地取舍:node major 用 process.versions.node;tsdown/rolldown 版本用【lockfile(pnpm-lock.yaml)内容 hash】作为工具链整体指纹的稳定代理(lockfile 变 => 工具版本可能变 => 失效),或退一步只用 ACPLUGIN_VERSION(主包 bump 时必然连带工具升级)。建议:key 里加 lockfile hash(读 config.root 向上找 pnpm-lock.yaml,读不到则跳过),既满足「工具版本变更失效」验收又不引入运行期依赖。需与用户确认代理是否可接受。
【R2 鸡生蛋(模块图)】extension 实际读的模块图只有跑完才知道 => 采用「sourceKey 找候选 + 候选记录的 moduleFileHashes 事后 re-hash 比对」两级命中(见 edgeCases),而非把模块图塞进单一 key。这是本项唯一有设计密度的部分,需在实现时确保 moduleFiles 取自 execution.watchPaths 中落在 dependencyRoots 内者。
【R3 独立 scanProject 双扫】缓存层为算指纹会额外 scanProject 一次(纯读,scanner.ts:1183)。dev 下可接受;若成为热点,可后续让 executeLifecycle 可选回传 project 复用扫描,但当前不做(YAGNI)。
【R4 需确认】是否接受「命中时跳过整条 lifecycle」而非「lifecycle 内 per-platform 记忆化」——方案原文提「记忆化边界在 prepare/generateBundle/build」,但那需在 executeLifecycle 内改造并捕获/重放 reportCompatibility/reportMetadata/reportDiagnostic/addWatchFile 全部副作用回调(lifecycle.ts:519-531,573,491-495)以保报告确定性,复杂度 L 且直接违反「build 事务全量」的边界清晰性。整条执行级缓存(壳法)语义等价、副作用天然被完整复用(直接返回上次 ProjectExecution)、且 executeLifecycle 零改动,是更贴合 §18 与依赖边界的落法。若用户坚持 per-platform 粒度,工作量升 L 且需独立设计副作用录制层。


---

### P16-a · 新建 private @acplugin/utils 包并汇入平台无关纯 helper（含 Codex 三路径函数合一）

**决策：** 在 packages/utils 建一个 private:true 的 @acplugin/utils 包(镜像 @acplugin/core 的包形态),集中六平台重复的纯守卫;三个 Codex 路径函数统一为单一 isSafeRelativeReference(严格超集,只更严不更松)。

**现状（锚点）：** 无 packages/utils(已确认:`ls packages/utils`→不存在)。重复副本(已逐一 Read 确认字节一致):isRecord 在 claude-code/src/validator.ts:99、codex/src/validator.ts:99、cursor/src/validator.ts:25、pi/src/validator.ts:23、opencode/src/validator.ts:18(均 `value!==null&&typeof value==='object'&&!Array.isArray(value)`,返回 `value is JsonRecord`);isNonEmptyString 在 claude-code/src/components.ts:48、codex/src/components.ts:53、cursor/src/manifest.ts:30、pi/src/manifest.ts:27(均 `typeof v==='string'&&v.trim().length>0`);report(带可选 fieldPath)在 claude validator:111、cursor validator:37、codex validator:111,report(无 fieldPath)在 antigravity validator:13、opencode validator:29、pi validator:34;readJson 在 claude validator:132、codex validator:132(逻辑相同,仅诊断码 CLAUDE_ vs CODEX_ 不同);referenceExists 在 claude validator:179、codex validator:210(字节一致;cursor validator:74 是 glob 版,不同,不迁);scopedArtifacts 在 claude validator:447、codex validator:229(字节一致)。三路径函数行为差异(关键):isSafePluginReference(claude:158/codex:189)用 path.posix.normalize,拒 `.`/`..`/`../`前缀/绝对/反斜杠/NUL/空;isSafeCodexPluginPath(codex/protocol.ts:71)与 isSafeSkillPath(codex/components.ts:75)彼此字节一致,不 normalize,改用 `relative.split('/').includes('..')` 拒任何 `..` 段,但放行裸 `.` 和 `.//foo`。tsconfig.base.json 有 `verbatimModuleSyntax:true`,平台已大量 `import type {...} from '@acplugin/core'`(如 claude validator.ts:3),证明 type-only import 在构建后被擦除、零运行时依赖。

**具体改动：**

新目录 packages/utils,四文件:
(1) packages/utils/package.json —— 拷 packages/platforms/claude-code/package.json 并改:name:'@acplugin/utils', version:'0.0.0', private:true, type:module, exports {'.':{types:'./dist/index.d.mts',import:'./dist/index.mjs'}}, scripts{build:'tsdown',test:'vitest run --passWithNoTests',typecheck:'tsc -p tsconfig.json'}, dependencies:{}(运行时零依赖), devDependencies 加 `@acplugin/core:'workspace:*'`(仅供类型)+ @types/node/tsdown/@typescript/native/vitest(catalog:)。
(2) packages/utils/tsconfig.json —— 字节同 platform:`{"extends":"../../tsconfig.base.json","include":["src/**/*.ts","test/**/*.ts"]}`(注意深度是 ../../ 因为 utils 在 packages/ 下,不是 packages/platforms/)。
(3) packages/utils/tsdown.config.ts —— 逐字拷 packages/core/tsdown.config.ts(entry src/index.ts, esm, node20, dts oxc, clean)。
(4) packages/utils/src/index.ts —— 内容:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { JsonValue } from '@acplugin/core'; // type-only → 擦除,零运行时依赖

export function isRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
// 统一后的单一路径守卫:严格超集(=两原实现拒绝集合的并集,只会拒更多,绝不放松)
export function isSafeRelativeReference(reference: string): boolean {
  if (!reference.startsWith('./') || reference.includes('\\') || reference.includes('\0')) return false;
  const relative = reference.slice(2);
  if (relative.length === 0) return false;
  if (relative.split('/').includes('..')) return false;               // 来自 Codex 守卫:拒任何 .. 段
  const normalized = path.posix.normalize(relative);                   // 来自 validator 守卫
  return normalized !== '.' && normalized !== '..'
    && !normalized.startsWith('../') && !path.posix.isAbsolute(normalized);
}
export function referenceExists(artifacts: ReadonlySet<string>, reference: string): boolean {
  const target = reference.slice(2).replace(/\/+$/u, '');
  if (artifacts.has(target)) return true;
  for (const artifact of artifacts) if (artifact.startsWith(`${target}/`)) return true;
  return false;
}
export function scopedArtifacts(paths: readonly string[], pluginRoot: string): ReadonlySet<string> {
  if (pluginRoot === '') return new Set(paths);
  const prefix = `${pluginRoot}/`;
  return new Set(paths.filter(p => p.startsWith(prefix)).map(p => p.slice(prefix.length)));
}
export function report(
  context: { reportDiagnostic: (d: { code: string; severity: 'error'; message: string; fieldPath?: readonly (string|number)[] }) => void },
  code: string, message: string, fieldPath?: readonly (string|number)[],
): void {
  context.reportDiagnostic({ code, severity: 'error', message, ...(fieldPath === undefined ? {} : { fieldPath }) });
}
export type JsonObjectResult =
  | { readonly ok: true; readonly value: Record<string, JsonValue> }
  | { readonly ok: false; readonly reason: 'read' | 'not-object' };
export async function readJsonObject(root: string, artifactPath: string): Promise<JsonObjectResult> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(root, artifactPath), 'utf8'));
    if (!isRecord(value)) return { ok: false, reason: 'not-object' };
    return { ok: true, value };
  } catch { return { ok: false, reason: 'read' }; }
}
```
report 的 context 参数用结构化最小签名(不 import PlatformValidateContext),既零 Core 运行时耦合又对所有平台的 context 兼容;scopedArtifacts 收 `readonly string[]`(不收 Core context 类型),迁移时调用点补 `.map(a=>a.path)`。

**边界与连带：** 确定性:所有函数纯、无 env/时间/随机/绝对路径,输出仅依赖输入字节 → 稳定。§3:函数名与实现均无平台 ID/Hooks/MCP 语义(isSafeRelativeReference 不叫 Plugin/Skill/Codex),诊断码字符串留在各平台调用点(见 P16-c),utils 不含码常量。§4.3:private:true 使其不进公开三包组;仅 type-only 依赖 core(擦除后运行时零依赖)。路径守卫统一后的行为收紧点(仅影响这三函数的旧放行值):`./a/../b`(旧 isSafePluginReference 放行→现拒)、`./.`(旧 Codex 守卫放行→现拒)、`.//foo`(旧 Codex 守卫放行→现拒);已 grep 六平台测试的路径字面量,唯一命中是 `./.mcp.json`(点开头文件名,非 `..` 段),经两实现与统一实现均判 true,无回归;且 acplugin 只生成 canonical 路径(`./commands`/`./skills/x`/`./hooks/hooks.json`/`./.mcp.json`),永不产出含 `..` 的引用。JsonRecord 类型:各平台本地 `type JsonRecord = Record<string, JsonValue>` 与 utils isRecord 返回的 `Record<string,JsonValue>` 同型,call-site 赋值不破类型。

**测试：** 新增 packages/utils/test/utils.test.ts(非平凡的路径守卫必须留一处可运行检查):
```ts
import { describe, it, expect } from 'vitest';
import { isSafeRelativeReference, referenceExists, scopedArtifacts, isRecord } from '../src/index.js';
describe('@acplugin/utils guards', () => {
  it('isSafeRelativeReference is a strict superset of the old guards', () => {
    for (const ok of ['./commands', './skills/x', './hooks/hooks.json', './.mcp.json']) expect(isSafeRelativeReference(ok)).toBe(true);
    for (const bad of ['../x', 'x', './', './..', './a/../b', './.', './/foo', './a\\b', './a\0b']) expect(isSafeRelativeReference(bad)).toBe(false);
  });
  it('referenceExists/scopedArtifacts match migrated behavior', () => {
    const a = new Set(['commands/a.md','skills/s/SKILL.md']);
    expect(referenceExists(a, './commands')).toBe(true);
    expect(referenceExists(a, './missing')).toBe(false);
    expect([...scopedArtifacts(['p/x','p/y','q/z'], 'p')].sort()).toEqual(['x','y']);
    expect(isRecord({})).toBe(true); expect(isRecord([])).toBe(false); expect(isRecord(null)).toBe(false);
  });
});
```
断言重点:三处收紧值(`./a/../b`,`./.`,`.//foo`)现判 false;canonical 路径与 `./.mcp.json` 仍 true。

**验收：** `pnpm --filter @acplugin/utils run build` 产出 dist/index.mjs + index.d.mts;`grep -c '@acplugin/core' packages/utils/dist/index.mjs` = 0(type-only 已擦除);`pnpm --filter @acplugin/utils run test`/`typecheck` 通过;package-boundaries 的公开三包组断言不受影响(private:true)。

**工作量：** M ｜ **独立分支：** 是 ｜ **风险：** 无未决;唯一实质行为变化是路径守卫统一后的三处收紧,已用测试 grep 证明无现存用例依赖旧放行。


---

### P16-b · 把 @acplugin/utils 接入构建图(主包 alwaysBundle 内联 + 平台依赖 + tsconfig paths + pretest 链),验证 §4.3 零泄漏

**决策：** @acplugin/utils 完全镜像 @acplugin/core 的处理:平台把它列为运行时 dependency(平台 dist 中 external),主包 tsdown deps.alwaysBundle 内联一次;pnpm-workspace 无需改。

**现状（锚点）：** packages/acplugin/tsdown.config.ts 的 deps.alwaysBundle 现有 @acplugin/core + 六个 platform + extension-mcp,onlyBundle 有 image-size/saxes/yaml/xmlchars。packages/acplugin/package.json devDependencies 有 @acplugin/core+六 platform(workspace:*),pretest(:27)=`pnpm --filter @acplugin/core run build && pnpm --filter '@acplugin/platform-*' run build`。tsconfig.base.json paths 有 @acplugin/core→packages/core/src/index.ts 等,无 utils。已确认平台 dist external 化 core:packages/platforms/claude-code/dist/index.mjs:1 `import {...} from "@acplugin/core"`;六平台 tsdown 均无 alwaysBundle(`grep -c alwaysBundle`=0)。pnpm-workspace.yaml packages 通配含 `packages/*`(已覆盖 packages/utils)。hooks pretest(package.json:17)含 `pnpm --filter @tokenroll/acplugin run build`(该步内联 utils→需 utils dist)。packages/test pretest 用 `pnpm --filter "...@tokenroll/acplugin" run build`(`...` 拓扑,已含 utils)。

**具体改动：**

(1) packages/acplugin/tsdown.config.ts:在 deps.alwaysBundle 数组加 `'@acplugin/utils'`(与 core 并列)。
(2) packages/acplugin/package.json:devDependencies 加 `"@acplugin/utils": "workspace:*"`(与 @acplugin/core 同类,仅构建期内联用)。
(3) 六个 packages/platforms/*/package.json:各自 dependencies 从 `{"@acplugin/core":"workspace:*"}` 改为加一行 `"@acplugin/utils":"workspace:*"`。
(4) tsconfig.base.json paths:在 `@acplugin/core` 之后加 `"@acplugin/utils": ["./packages/utils/src/index.ts"]`(供 tsc typecheck 直接解析源码)。
(5) pretest 链补 utils 先建:
  - packages/acplugin/package.json:27 → 前置 `pnpm --filter @acplugin/utils run build && ` 再 core、platform-*。
  - packages/extensions/hooks/package.json:17 → 最前面加 `pnpm --filter @acplugin/utils run build && `(因其后 `@tokenroll/acplugin run build` 会内联 utils,需 dist 就绪)。
  - packages/test:无需改(`...@tokenroll/acplugin` 拓扑已含 utils)。
(6) pnpm-workspace.yaml:不改(packages/* 已覆盖 packages/utils)。

**边界与连带：** 构建顺序:平台 dependency 声明使 `pnpm -r run build`(根 build 脚本)拓扑先建 utils→platforms→acplugin,自动正确;硬编码 filter 的两处 pretest 已在(5)补齐。平台 dist external 化 utils(平台 tsdown 无 alwaysBundle,utils 是其 dependency→保持 import 字符串),主包 alwaysBundle 内联一次,与 core 完全同构,无重复内联/无 6 份副本膨胀。§4.3:主包 dist 内联后不得出现 `from '@acplugin/utils'`(已被现有 package-boundaries.test.ts:75 的 `/from\s+["']@acplugin\//` 覆盖)。hooks/mcp Extension dist 不 import utils(它们只 import @tokenroll/acplugin),现有 :117 `not.toContain('@acplugin/')` 仍成立。

**测试：** 无需新增 §4.3 测试 —— packages/test/test/package-boundaries.test.ts 已覆盖:(a) :75-76 断言主包 dist 无任何 `@acplugin/` import(涵盖 utils 泄漏);(b) :121-138 断言公开包恰为三包组(utils private:true 不入列)。只需在 P16 分支跑该测试确认仍绿。可选:在 :75 附近补一条注释性断言 `expect(source).not.toMatch(/@acplugin\/utils/)` 以显式点名(非必需,已被通配覆盖)。

**验收：** 全量 `pnpm run build` 拓扑成功;`grep -R "@acplugin/utils" packages/acplugin/dist` 无命中;packages/test 的 package-boundaries.test.ts 全绿;`pnpm --filter @tokenroll/acplugin run typecheck` 通过(paths 解析 utils 源码)。

**工作量：** S ｜ **独立分支：** 是 ｜ **风险：** 无未决。唯一坑是漏改 hooks pretest 会在 CI 报 `@tokenroll/acplugin run build` 找不到 utils/dist —— (5)已覆盖。


---

### P16-c · 六平台 validator/manifest/components/protocol 改用 @acplugin/utils 并删本地副本;Codex 三路径函数收敛为 isSafeRelativeReference

**决策：** 逐平台把重复守卫替换为 utils import 并删本地定义;三个 Codex 路径函数全部改调 isSafeRelativeReference;readJson 改薄封装 utils.readJsonObject 但保留各平台专属诊断码;cursor 的 glob 版 referenceExists 与各平台 report 诊断码保持本地。

**现状（锚点）：** 见 P16-a 已核实的全部 file:line。补充调用点:isSafePluginReference 在 claude validator 用于 :485、:558,在 codex validator 用于 :256、:279、:594、:644(含 validateBrandingImage:279);isSafeCodexPluginPath 仅在 codex/protocol.ts 内部使用 :128(screenshots)、:179(composerIcon/logo),未经 index.ts 再导出(index.ts 只导出 types/PLATFORM_ID/PLATFORM_API_VERSION/codex 工厂);isSafeSkillPath 仅在 codex/components.ts:131(iconSmall/iconLarge)使用。readJson 调用点:claude validator:637/669/675、codex validator:992/1024/1030。scopedArtifacts 调用点:claude validator:506、codex validator:870。

**具体改动：**

各文件顶部加 `import { isRecord, isNonEmptyString, report, referenceExists, scopedArtifacts, isSafeRelativeReference, readJsonObject } from '@acplugin/utils';`(按各文件实际用到的子集),删除对应本地定义:
- claude-code/src/validator.ts:删 isRecord(:99)、report(:111)、isSafePluginReference(:158)、referenceExists(:179)、scopedArtifacts(:447);把 :485/:558 的 isSafePluginReference→isSafeRelativeReference;:506 `scopedArtifacts(context, pluginRoot)`→`scopedArtifacts(context.candidate.unit.artifacts.map(a=>a.path), pluginRoot)`;readJson(:132)改薄封装:
```ts
async function readJson(context, artifactPath): Promise<JsonRecord|undefined> {
  const r = await readJsonObject(context.candidate.root, artifactPath);
  if (r.ok) return r.value;
  report(context, r.reason==='not-object'?'CLAUDE_MANIFEST_OBJECT_REQUIRED':'CLAUDE_MANIFEST_READ_FAILED',
    r.reason==='not-object'?`${artifactPath} must contain a JSON object.`:`${artifactPath} must be present and contain valid JSON.`);
  return undefined;
}
```
- codex/src/validator.ts:删 isRecord(:99)、report(:111)、isSafePluginReference(:189)、referenceExists(:210)、scopedArtifacts(:229);:256/:279/:594/:644 及 validateBrandingImage 内 isSafePluginReference→isSafeRelativeReference;:870 scopedArtifacts 调用同上补 `.map`;readJson(:132)同 claude 模式但用 CODEX_ 码;保留 parseYamlObject 本地(用 utils.isRecord)。
- codex/src/protocol.ts:删 isSafeCodexPluginPath(:71),:128/:179 改 isSafeRelativeReference,import 之。isCodexHttpsUrl/parseCodexSvgDimensions/codexInterfaceFieldIssue 等保留(平台语义)。
- codex/src/components.ts:删 isSafeSkillPath(:75)与本地 isNonEmptyString(:53),:131 改 isSafeRelativeReference,import isNonEmptyString/isSafeRelativeReference。isUniqueStringArray/reportFieldError 保留本地(reportFieldError 带 CODEX_COMPONENT_FIELD_INVALID 码 = 平台语义)。
- claude-code/src/components.ts:删本地 isNonEmptyString(:48),import 之(isUniqueStringArray/reportFieldError 留本地)。
- cursor/src/validator.ts:删 isRecord(:25)、report(:37),import 之;保留本地 isSafeReference(:57,glob 版语义不同)与 referenceExists(:74,glob 版);其 validateReference 诊断码不变。
- cursor/src/manifest.ts:删本地 isNonEmptyString(:30),import 之;SEMVER_PATTERN 见 P16-e。
- pi/src/validator.ts:删 isRecord(:23)、report(:34),import 之。
- pi/src/manifest.ts:删本地 isNonEmptyString(:27),import 之。
- opencode/src/validator.ts:删 isRecord(:18)、report(:29),import 之。
- antigravity/src/validator.ts:删 report(:13),import 之(该文件内联 JSON 解析用的是 `value===null||typeof...`,可选改用 utils.isRecord,非必需)。
各平台本地 `type JsonRecord = Record<string, JsonValue>` 别名保留(可读性,且与 utils 返回同型)。

**边界与连带：** 诊断码/消息全部留在平台调用点 → 输出字节不变 → 确定性 & §3 均守住(utils 不含任何平台码)。readJson 薄封装保持原双分支语义(parse 抛错→READ_FAILED;非对象→OBJECT_REQUIRED),逐平台核对码前缀。cursor 的 isSafeReference/referenceExists 是 glob 感知的不同实现,绝不可换成 utils 版(会破 glob 校验)。isSafeCodexPluginPath 未外泄(index 不再导出),删除安全。三处路径收紧(P16-a 已列)在这些真实调用点均只作用于生成路径,无回归。scopedArtifacts 签名从收 context 改收 `string[]`,两处调用点必须同步补 `.map(a=>a.path)`(漏改会类型报错,typecheck 兜底)。

**测试：** 无需改平台断言(诊断码/消息不变);但必须回归跑六平台 test:`pnpm --filter '@acplugin/platform-*' run test`。补一条 grep 守卫(可放 packages/test 或 CI):确认平台 src 不再有本地重复定义 —— `grep -rn 'function isRecord' packages/platforms/*/src` 应仅剩 0 处(全部迁走)。若某平台测试恰好断言了含 `..` 的路径为 valid(已 grep,无),才需调整;当前无。

**验收：** 六平台 `build`+`typecheck`+`test` 全绿;`grep -rn 'function isRecord\|function isNonEmptyString\|function isSafePluginReference\|function isSafeCodexPluginPath\|function isSafeSkillPath' packages/platforms/*/src` 仅剩 cursor 的 isSafeReference(glob)与各平台保留项,重复守卫归零;诊断输出与迁移前逐码一致(可对比迁移前 validate 快照)。

**工作量：** L ｜ **独立分支：** 是 ｜ **风险：** churn 面最大(触 12+ 文件、10+ 调用点);风险点是 readJson 封装漏掉某分支码 / scopedArtifacts 调用点漏补 .map —— 均由 typecheck + 平台测试兜底。建议与 P16-a/b 同分支原子落地(单独 commit 分文件)。


---

### P16-d · Hooks wire.mjs 改 per-platform memoize + 加同平台跨 hook 字节一致测试

**决策：** 在 createWireSource 内部做 per-platform 记忆化(Map<platform,string>),消除 per-(adapter,hook) 重复构造整段模板;在根出口一处修复,所有 adapter 调用点自动受益。

**现状（锚点）：** packages/extensions/hooks/src/wire-source.ts:29 `createWireSource(platform)` 是纯函数,返回值只依赖 `platform`(6 个字面量之一),但每次调用都重新拼整段 ~170 行模板字符串。调用点:adapters.ts:26 import,:356-360(applyAdapter 内 for-hook 循环,claude/codex)、:486-490(emitHookRuntime,cursor/antigravity/opencode/pi)。即 N 个 hook × 平台 → 重算 N 次同一串。产物路径 dist/<platform>/plugin/hooks/<id>/wire.mjs(见 hooks.test.ts:429/431)。

**具体改动：**

packages/extensions/hooks/src/wire-source.ts:把现 createWireSource 体改名为内部 `buildWireSource(platform)`,新 createWireSource 记忆化:
```ts
const WIRE_SOURCE_CACHE = new Map<HookAdapterPlatform, string>();
export function createWireSource(platform: HookAdapterPlatform): string {
  const cached = WIRE_SOURCE_CACHE.get(platform);
  if (cached !== undefined) return cached;
  const source = buildWireSource(platform);
  WIRE_SOURCE_CACHE.set(platform, source);
  return source;
}
function buildWireSource(platform: HookAdapterPlatform): string { /* 原 :30-217 体原样 */ }
```
adapters.ts:356-360 与 :486-490 不改(仍调 createWireSource(platform)),自动命中缓存。

**边界与连带：** 确定性:缓存值只由 platform(编译期常量)决定,与任何 build 输入无关,模块级缓存跨 build 复用同字节 → 引用透明,不违反‘纯函数/无副作用’的实质(无 fs/env/随机)。缓存至多 6 条字符串,内存可忽略。不改变任何产物字节(memoize 前后 wire.mjs 完全相同),不影响现有 hooks.test.ts:429 的 claude/codex wire 断言。选择在 wire-source.ts 一处修(rung 2/6:所有 caller 都过这里),而非在 adapters.ts 两个 emit 点各加缓存(会重复逻辑)。

**测试：** 在 packages/extensions/hooks/test/hooks.test.ts 现有 'builds all canonical events once...'(:357,已用 canonicalHooks() 为 claude+codex 建多 hook)末尾加断言:
```ts
for (const platform of ['claude-code', 'codex']) {
  const dir = path.join(root, `dist/${platform}/plugin/hooks`);
  const ids = (await fs.readdir(dir)).filter(n => n !== 'hooks.json');
  const wires = await Promise.all(ids.map(id => fs.readFile(path.join(dir, id, 'wire.mjs'), 'utf8')));
  for (const w of wires) expect(w).toBe(wires[0]); // 同平台跨 hook wire.mjs 字节一致
  expect(ids.length).toBeGreaterThan(1); // 确保确实多 hook 才有意义
}
// 跨平台仍应不同(claude 用 CLAUDE_PLUGIN_ROOT)
const cc = await fs.readFile(path.join(root, 'dist/claude-code/plugin/hooks', (await fs.readdir(path.join(root,'dist/claude-code/plugin/hooks'))).find(n=>n!=='hooks.json')!, 'wire.mjs'),'utf8');
const cx = await fs.readFile(path.join(root, 'dist/codex/plugin/hooks', (await fs.readdir(path.join(root,'dist/codex/plugin/hooks'))).find(n=>n!=='hooks.json')!, 'wire.mjs'),'utf8');
expect(cc).not.toBe(cx);
```

**验收：** hooks 包 test 全绿,新断言证明同平台每个 hook 的 wire.mjs 字节一致、跨平台不同;memoize 不改任何产物字节(可选:对同一 platform 调 createWireSource 两次断言 `===` 同一引用)。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** 无。此项不依赖 @acplugin/utils,可独立落地(但归入 G7 同分支即可)。


---

### P16-e · 标记不宜盲迁项(SEMVER_PATTERN 语义分歧)+ 可选低价值项(findCanonicalDocument)+ 落地顺序(建议先做)

**决策：** SEMVER_PATTERN 不盲迁(两副本语义不同,属平台语义,违反‘不含平台语义’判据),保留各平台本地或仅在产品确认放宽后统一;findCanonicalDocument 作为可选低 ROI 项,给出实现但允许时间盒内跳过;P16 整组建议在 G2/G4(Core/平台)改动之前先落地。

**现状（锚点）：** SEMVER_PATTERN 两份且不同:cursor/src/manifest.ts:22(exported,`/^...(?:-pre)?$/u`,无 build metadata、带 u 标志)vs codex/src/validator.ts:58(local,`/^...(?:-pre)?(?:\+build)?$/`,允许 build metadata、无 u 标志)。二者对 `1.2.3+build` 判定相反 → 语义分歧。findCanonicalDocument:无同名函数;实为各平台 serializeDocuments 内重复模式(claude manifest:191、antigravity manifest:101、codex manifest:259、cursor manifest:182、pi manifest:149、opencode config-document:103):`const m = documents.find(d=>d.id===ID); if(!m||m.path!==PATH||m.format!==FMT) throw '<平台> ... missing its canonical ... Document.'; if(documents.length!==1) throw '<平台> received an unknown Document.'`,其中 ID/PATH/FMT/throw 文案/length 约束均含平台特化。

**具体改动：**

SEMVER_PATTERN(推荐 A=不迁):保持现状,在 utils 不提供 SEMVER_PATTERN;各平台副本加一行注释说明分歧理由。备选 B(仅当产品同意放宽 cursor):utils 导出 `export const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/u`(全 semver),cursor/codex 均 import,并把 cursor 现有拒 build-metadata 的测试改为接受 —— 这是一次 spec 变更,需 changeset + 明确 sign-off。
findCanonicalDocument(可选):utils 加
```ts
import type { DraftDocument } from '@acplugin/core'; // type-only
export function findCanonicalDocument(documents: readonly DraftDocument[], id: string, path: string, format: string): DraftDocument | undefined {
  const doc = documents.find(d => d.id === id);
  return doc && doc.path === path && doc.format === format ? doc : undefined;
}
```
各平台 serializeDocuments 用 `const m = findCanonicalDocument(documents, ID, PATH, FMT); if(!m) throw '<平台>...';` 保留本地 throw 文案 + `documents.length!==1` 断言。

**边界与连带：** SEMVER:盲迁会改变 cursor 对 `x.y.z+build` 的接受性 → 破 spec/测试,故按任务自身‘不含平台语义’判据判定为不合格迁移项。findCanonicalDocument:extract 仅省 ~2 行 find+比较 × 6,平台仍各留 throw+length,净收益边际,并给 utils 引入 DraftDocument 类型耦合(type-only,尚可);opencode 是 config-document 且 format 可能不同,ID/PATH 各异,统一函数只吃这三参、不碰文案,§3 守住。落地顺序:P16 是纯重构(除三路径收紧),若在 G2/G4 之后做,G2/G4 会在 6 份副本上各自改动、随后 P16 再删并集中 → 双倍改动 + 合并冲突;先做 P16 则 G2/G4 直接基于去重后的单一实现,零重复劳动。

**测试：** SEMVER 若走备选 B:改 cursor 的 CURSOR_MANIFEST_VERSION_INVALID 相关用例,加 `1.2.3+build` 现判 valid 的断言,并加 changeset。findCanonicalDocument 若采用:六平台现有 serializeDocuments 的 '缺失 canonical/多余 document 抛错' 测试不变(文案与 length 语义保留)即为回归保证。

**验收：** SEMVER 决策记录在案(默认 A 不迁,除非拿到放宽 cursor 的 sign-off);若采用 findCanonicalDocument,六平台 serializeDocuments 测试全绿且抛错文案逐字不变;确认 P16 分支先于 G2/G4 合并(或至少 G2/G4 rebase 到 P16 之上)。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** SEMVER 备选 B 是 spec 变更,须产品确认——默认不做;findCanonicalDocument ROI 低,时间盒内可跳过不影响 P16 主目标。落地顺序若被打乱(G2/G4 先行)会显著增加 P16 合并成本 —— 需在计划层面锁定 P16 优先。


---
## S4 — 规范 / 记录（仅注释/文档，不改行为）

### P15 · 规范 §9.4 补写并行化前提与其结构成本

**决策：** 在 spec §9.4 “未来并行化不得改变可观察顺序” 句旁补一段实现前提:并行化前必须先让诊断/兼容性/元数据按 owner 分桶或排序键完全脱离插入时序,并替换现有基于插入序的 checkpoint。

**现状（锚点）：** .llmdoc-tmp/specs/tokenroll-acplugin-1.0-spec.md:629 只有一句承诺:『1.0 中 Platform 按配置顺序串行执行,避免生命周期副作用和报告顺序不确定。未来并行化不得改变可观察顺序。』未写清代价。实际耦合点:packages/core/src/lifecycle.ts:226 `const diagnostics = new DiagnosticCollector(reportRedaction)` 是所有 Hook/Scanner/Registry 共享的单实例;诊断最终顺序由 diagnostics.ts:179 sortDiagnostics 的内容键(platform/extension/owner/location/code/message)决定,已基本与插入序无关,但 (a) 全键相等的并列项回退到稳定排序的输入序,(b) lifecycle.ts:685 `const propagatedCompatibilityStart = compatibility.size` 配合 diagnostics.ts:418 applyStrictness(..., start) 的按下标切片,是显式依赖串行 append 顺序的 checkpoint。

**具体改动：**

在 spec 第 629 行那句之后新增一段(纯文档,Markdown 段落):
『实现前提:要让本承诺成立,诊断、兼容性与元数据结论要么排序键完全独立于产生时刻(见 §18),要么在合并前按 owner(platform:<id> / extension:<name> / public)分桶并按配置顺序重放。当前实现由所有 Hook、Scanner、Registry 共享单一 DiagnosticCollector(packages/core/src/lifecycle.ts 内 `new DiagnosticCollector(...)`),按插入顺序累积、仅在读取时用内容键做确定性排序;串行下其内容排序已消除顺序差异,但该结构并未按 owner 结构化,且兼容性严格度检查依赖位置 checkpoint(`compatibility.size` 快照 + applyStrictness 的 start 下标切片),该 checkpoint 显式假设串行 append。若未来并行执行各 Platform,必须先:①改为 owner 分桶收集,或证明所有报告排序键(含并列项 tie-break)完全独立于插入与并发时序;②用与并发无关的 owner/subject 归属替换位置 checkpoint。此为并行化必须预付的结构成本,不能塞进引入并行的同一改动里顺带完成。』

**边界与连带：** 纯 spec 文档改动,不触碰代码,不影响确定性/产物字节。措辞须准确:不要断言当前诊断顺序随并发漂移(内容键已排序);真正会漂移的是 tie-break 并列项与 compatibility 的位置 checkpoint。若 llmdoc/architecture 或 conversion-matrix 引用了 §9.4 行号,注意行号会因新增段落下移(它们按小节标题引用,通常无需改)。

**测试：** 无代码测试。验证:spec Markdown 渲染无破坏;若仓库有 llmdoc 链接检查(llmdoc:update),重跑确认 §9.4 锚点未失效。

**验收：** §9.4 承诺句下方存在该实现前提段,明确点名共享 DiagnosticCollector 与位置 checkpoint 两处成本;不新增任何代码或行为承诺。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none(需确保描述与代码事实一致:diagnostics 内容键已排序,勿夸大为‘串行才正确’)。


---

### P17d-1 · Codex/Claude 允许字段集补 §21 核验日期注解

**决策：** 给 Codex plugin/interface/openai.yaml 与 Claude manifest 的允许字段集 doc 注释补『核验日期:2026-08-06 + §21 官方来源』,镜像现有 Hook schema 注解风格。

**现状（锚点）：** 现有可镜像风格:packages/platforms/claude-code/test/platform.test.ts:466 `/** Claude Code Hook 官方契约核验日期:2026-08-06。 */`;README 用 `last rechecked on 2026-08-06`。待补的字段集注释均无日期:claude-code/src/validator.ts:6 `/** Claude Code Plugin 清单允许出现的官方根字段。 */`(PLUGIN_FIELDS),:81 MARKETPLACE_FIELDS,:84 MARKETPLACE_PLUGIN_FIELDS;codex/src/validator.ts:19 PLUGIN_FIELDS,:25 INTERFACE_FIELDS,:28 SKILL_METADATA_FIELDS(agents/openai.yaml),:32 SKILL_INTERFACE_FIELDS,:42/:45 MARKETPLACE_*;codex/src/protocol.ts:37 `/** Codex Plugin \`interface\` 当前允许的全部官方字段。 */`(CODEX_INTERFACE_FIELDS)。§21 来源(spec:1259/1261):Claude=https://code.claude.com/docs/en/plugins-reference,Codex=https://developers.openai.com/plugins/build/plugins。

**具体改动：**

逐条把 doc 注释末尾追加『核验日期:2026-08-06,来源见 §21 <URL>。』:
- claude-code/src/validator.ts:6 → `/** Claude Code Plugin 清单允许出现的官方根字段。核验日期:2026-08-06,来源见 §21 code.claude.com/docs/en/plugins-reference。 */`;同法处理 :81 MARKETPLACE_FIELDS、:84 MARKETPLACE_PLUGIN_FIELDS。
- codex/src/validator.ts:19 PLUGIN_FIELDS、:25 INTERFACE_FIELDS、:28 SKILL_METADATA_FIELDS(注明 agents/openai.yaml)、:32 SKILL_INTERFACE_FIELDS、:42/:45 MARKETPLACE_* → 追加 `核验日期:2026-08-06,来源见 §21 developers.openai.com/plugins/build/plugins。`
- codex/src/protocol.ts:37 CODEX_INTERFACE_FIELDS → 同上 Codex 来源。
日期用 2026-08-06 与 README/test 现有注解保持一致。

**边界与连带：** 纯注释,零运行时影响、零产物字节变化。所有注释含中文,满足 scripts/check-comments.mjs 的 CJK 要求。protocol.ts:37 注释含反引号 `interface`,追加文本勿破坏该 JSDoc。日期须与 hooks/README.md、mcp/README.md 的 2026-08-06 一致(不要各处不同日期)。

**测试：** 无新测试。跑 `pnpm -r typecheck` 与 eslint 确认注释未破坏解析;跑 check-comments.mjs 确认覆盖率不降。

**验收：** 上述每个字段集声明的前置注释都含 `核验日期:2026-08-06` 与对应 §21 URL;typecheck/eslint/check-comments 全绿。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none。


---

### P17d-2 · Claude displayName/defaultEnabled 的 SchemaStore 陷阱 + 版本门槛注释

**决策：** 在 Claude manifest 生成与 PLUGIN_FIELDS 处加注释:displayName/defaultEnabled 在官方 reference 存在但 SchemaStore 无;defaultEnabled 需 Claude Code ≥ v2.1.154。

**现状（锚点）：** packages/platforms/claude-code/src/manifest.ts:119 `...(metadata.displayName === undefined ? {} : { displayName: metadata.displayName })`,:125 `...(context.options.defaultEnabled === undefined ? {} : { defaultEnabled: ... })`;validator.ts:7-11 PLUGIN_FIELDS 已含 'displayName' 与 'defaultEnabled';manifest.ts:94 options 白名单 `new Set(['strict','defaultEnabled','marketplace'])`,:101-102 defaultEnabled 布尔校验。均无来源/版本陷阱说明。

**具体改动：**

① manifest.ts:125 defaultEnabled 上方加行内注释:`// defaultEnabled 仅存在于官方 plugins-reference,SchemaStore 的 plugin schema 尚未收录;且需 Claude Code ≥ v2.1.154 才生效,低版本会忽略该字段。`
② manifest.ts:119 displayName 上方加:`// displayName 见官方 reference,但 SchemaStore 无此字段,校 SchemaStore 会误报未知字段——以官方 reference 为准。`
③ validator.ts:7 PLUGIN_FIELDS 注释追加:`(displayName/defaultEnabled 依据官方 reference 收录,SchemaStore 尚缺;defaultEnabled 需 Claude Code ≥ v2.1.154)`。

**边界与连带：** 纯注释。版本号 v2.1.154 为既定事实,原样写入不要臆改。注释须中文(含少量英文字段名/版本号可接受,只要有 CJK)。不改变字段仍照常写出的行为(add-only)。

**测试：** 无新测试;typecheck/eslint/check-comments 复跑。

**验收：** manifest.ts 两处字段写出点与 validator.ts PLUGIN_FIELDS 均带该陷阱+版本注释;行为不变。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none。


---

### P17d-3 · sortObject/cloneJson 整数键实际按 JS 数值序的注释纠正

**决策：** 纠正/补全注释:整数索引键最终按 JS 数值序输出,localeCompare 只决定非整数字符串键顺序;此为 Object.fromEntries/defineProperty 后枚举重排整数键所致,且不依赖 ICU。

**现状（锚点）：** packages/core/src/serialization.ts:11-21 sortObject 用 `.sort(([a],[b]) => a.localeCompare(b,'en'))` 后 `Object.fromEntries`;文档注释(:3-10)只说『按键名排序对象』。packages/core/src/documents.ts:36-64 cloneJson 用 `Object.keys(object).sort((l,r)=>l.localeCompare(r,'en'))` 后 `Object.defineProperty`。已实测确认:两者最终枚举/序列化时整数键(如 '1','2','9','10')被引擎按数值升序前置,localeCompare 的 lexicographic 结果被覆盖;localeCompare 仅对非整数字符串键(如 'a','b')生效。

**具体改动：**

① serialization.ts sortObject JSDoc(:3-10)补一句:`注意:JS 引擎在枚举/序列化重建对象时会把整数索引键(如 '10')按数值升序前置,故这些键实际按数值序输出、localeCompare 只决定非整数字符串键的相对顺序;整数键顺序不依赖 ICU,反而更稳。`
② serialization.ts:17 `.sort(...localeCompare...)` 行尾/上方加行内注释:`// 对整数键无实效——Object.fromEntries 后枚举会按数值序重排,localeCompare 只排非整数字符串键。`
③ documents.ts:57 同款行内注释;并把 :53 注释『按稳定键顺序复制』收紧为『非整数键按 localeCompare、整数键按 JS 数值序复制』。

**边界与连带：** 纯注释,行为/字节不变(已实测输出顺序即当前实现输出)。与 §18 一致且更强:整数键排序不经 ICU,故 ICU 版本差异不影响整数键(与 P17d-4 呼应,注释可交叉引用)。措辞须与实测一致:不要写成‘localeCompare 决定所有键’。

**测试：** 可选(建议)最小回归断言,加到 packages/core/test/documents.test.ts:构造含键 {'10','2','1','b','a'} 的 document value,断言 cloneJson 后 `Object.keys(...)` === ['1','2','10','a','b'](整数数值序 + 字符串 localeCompare 序)。这是 §18 确定性的 load-bearing 断言。

**验收：** 两文件注释准确描述整数键=数值序、字符串键=localeCompare;若加断言则该断言通过;typecheck/check-comments 绿。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none——已用 node 实测证实原方案措辞正确(Object.fromEntries/defineProperty + 枚举把整数键重排为数值序),无与决策冲突。


---

### P17d-4 · localeCompare('en') 的 ICU 依赖注明(§18 只钉 Node major)

**决策：** 在共享比较器与 sortObject 处注明:字符串排序用 localeCompare('en'),其对 Unicode 边界字符的结果依赖 Node 内置 ICU 版本,而 §18 只钉 Node major;实际输入为 ASCII 标识符,故跨 ICU 稳定。

**现状（锚点）：** packages/core/src/diagnostics.ts:39-41 compareStrings 是诊断/兼容性/元数据排序的共享比较器(被 sortDiagnostics/sortCompatibility 等复用),用 `.localeCompare(...,'en')`;packages/core/src/serialization.ts:17 sortObject 同样用 localeCompare('en')。均未注明 ICU 依赖。

**具体改动：**

① diagnostics.ts:39 compareStrings 上方注释追加:`// localeCompare('en') 的整理结果在 Unicode 边界处依赖 Node 内置 ICU 版本;§18 只钉 Node major,故此处的确定性依赖‘输入均为 ASCII 标识符/kebab-case/相对路径’——这类输入的 localeCompare 跨 ICU 版本稳定。若未来排序键可能含任意 Unicode,需改用 code-unit 比较以彻底摆脱 ICU。`
② serialization.ts:17 加精简版:`// localeCompare('en') 依赖 ICU;当前键均为 ASCII,跨 ICU 稳定(见 diagnostics.ts compareStrings 注释)。`

**边界与连带：** 纯注释。与 P17d-3 呼应:整数键不经 localeCompare 故与 ICU 无关。注释须准确——不要暗示当前存在 bug;当前输入域(ASCII)下确定性成立。中文注释满足 check-comments。

**测试：** 无新测试;check-comments/typecheck 复跑。

**验收：** compareStrings 与 sortObject 均带 ICU 依赖说明并指出当前 ASCII 输入域使其稳定、以及未来 Unicode 输入的升级路径。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none。


---

### P17d-5 · Cursor logo 故意不做存在性校验的注释(可能是远程 URL)

**决策：** 在 Cursor validator 的引用存在性校验处注明:logo 虽在 MANIFEST_FIELDS 中被接受,但故意不纳入路径存在性检查,因为 Cursor 允许 logo 为远程 URL 而非 Plugin 根内文件。

**现状（锚点）：** packages/platforms/cursor/src/validator.ts:9 MANIFEST_FIELDS 含 'logo';:131-133 未知字段检查按 MANIFEST_FIELDS 放行 logo;:152-156 仅对 commands/skills/agents 做 validateReference 存在性检查,:157-163 仅对 hooks/mcpServers。logo 全程无路径安全/存在性校验,但无注释说明这是有意为之(原任务锚点 :152)。

**具体改动：**

在 validator.ts:152(commands/skills/agents 引用检查循环上方)插入注释:`// 注意:logo 虽是 MANIFEST_FIELDS 合法字段,但刻意不在此做路径存在性/安全校验——Cursor 允许 logo 为远程 URL(非 Plugin 根内相对路径),对其做 referenceExists 会误报。仅对确定为 Plugin 根内引用的字段(commands/skills/agents、hooks/mcpServers)校验。`

**边界与连带：** 纯注释,不改校验行为(logo 依旧只受未知字段白名单约束)。若日后要校验 logo,需先区分 URL 与相对路径两种形态——注释已点出。中文注释满足 check-comments。

**测试：** 无新测试;确认 cursor platform.test.ts 既有用例仍绿。

**验收：** validator.ts 引用检查段有该注释,解释 logo 被有意排除的原因;校验逻辑与产物不变。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none。


---

### P17d-6 · verify-release.mjs 增加 MCP tree-shake §4.3 断言

**决策：** 在发布验证中静态断言:主包 dist/index.mjs 的 eager(静态 import)图不含 MCP-extension 运行时符号(defineMcpServer),证明可选 MCP Extension 未被 eager 打包。

**现状（锚点）：** scripts/verify-release.mjs 现有 inspectTarball(:103) 解压主包但不做 eager-graph 检查;verifyMainOnlyMigration(:169) 只在运行时证明 MCP 扩展未被安装。实测(packages/acplugin/dist):index.mjs 静态 import 8 个 src-*.mjs,其中无 defineMcpServer;defineMcpServer/migration-validation-api 仅存在于 lazy 的 migration-*.mjs(由 cli.mjs 动态 import,不在 index.mjs 静态图)。字符串 `@tokenroll/acplugin-extension-mcp` 会合法出现在 eager 的 init/scaffold 代码中(src-BeOh0YMW.mjs:329/360/547 写生成文件),故不能用包名作标记。

**具体改动：**

新增纯函数(script 内)`assertMainEagerGraphExcludesMcp(packageRoot)`,并在 inspectTarball 内 `expectedName === '@tokenroll/acplugin'` 分支(:114 MCP 断言附近)调用:
```js
// §4.3:主包 eager 图不得静态拉入 MCP Extension 运行时符号;MCP 只能经 lazy chunk 动态加载。
async function assertMainEagerGraphReachable(distDir) {
  const seen = new Set();
  const stack = ['index.mjs'];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue; seen.add(rel);
    const code = await fs.readFile(path.join(distDir, rel), 'utf8');
    // 仅跟随静态 import/export ... from './x'(动态 import("…") 天然不匹配 => 被排除)
    for (const m of code.matchAll(/(?:from|import)\s*["'](\.\/[^"']+)["']/g))
      stack.push(m[1].replace(/^\.\//, ''));
  }
  return seen;
}
// 调用:
const distDir = path.join(destination, 'package/dist');
const eager = await assertMainEagerGraphReachable(distDir);
for (const rel of eager) {
  const code = await fs.readFile(path.join(distDir, rel), 'utf8');
  assert(!/\bdefineMcpServer\b/.test(code),
    `Main package eager graph (${rel}) statically pulls in MCP-extension symbol defineMcpServer; MCP must stay lazy (§4.3).`);
}
```
标记用 `defineMcpServer`(MCP 运行时公开符号,仅当扩展代码被内联时出现),不用包名字符串。

**边界与连带：** 确定性:必须跟随内容 hash 命名的 chunk 规范(如 src-CZQrAAf6.mjs),不能硬编码文件名——上面用图遍历解决。动态 import `import("…")` 必须被排除:正则以 `from|import` 后紧跟引号匹配,`import(` 后是 `(` 不匹配,天然排除 lazy 边界。若 tsdown 输出改用不带 `./` 前缀或裸 specifier 需同步正则(当前全部为 `./` 相对)。marker 需能抗 minify——当前 dist 未 minify 且 defineMcpServer 为导出/属性名不被改写;若未来开启 name-mangling,应改断言 chunk 集合本身(如断言 migration/mcp chunk 不在 eager 集合)。

**测试：** 断言本身即测试,随 `node scripts/verify-release.mjs`(或 pnpm 对应脚本)执行。反向验证:临时在 index.ts 顶部静态 `import { defineMcpServer } from '@tokenroll/acplugin-extension-mcp'` 重打包,确认脚本 fail(验证后回滚)。

**验收：** verify-release.mjs 运行时对主包 eager 图断言通过;人为把 MCP 运行时符号拉进 eager 图会使脚本非零退出。

**工作量：** M ｜ **独立分支：** 否 ｜ **风险：** marker 依赖 dist 未 mangle 导出/属性名(当前成立)。若发布构建启用符号混淆,defineMcpServer 可能消失——届时改为‘eager 图不得包含 migration/mcp 专属 chunk 文件’的集合断言。


---

### P17d-7 · cross-unit 图安全由 <platform>/<unit-id> 隔离提供的注释

**决策：** 注明:全局 DeliveryUnit/Artifact 图的跨单元安全,来自每个单元独占 <platform>/<unit-id> 两级根 + 单元内独立 ArtifactRegistry,路径不会跨单元冲突。

**现状（锚点）：** 锚点 lifecycle.ts:695-696 `const finalUnits = units.snapshot()`(即 spec 步骤 12 的全局图校验入口)无跨单元隔离说明。真正的隔离机制在:delivery-units.ts:14 `#units` 以 `(platform,unit-id)` 键、:32-34 #key、:56-58 重复键报错、:60 单元内独占 ArtifactRegistry;transaction.ts:216-228 deliveryUnitRoots 用 `${unit.platform}/${unit.id}` 作物理根并对重复根抛错(:223-225)。

**具体改动：**

① lifecycle.ts:695-696 快照处注释追加:`// 跨单元安全性由 <platform>/<unit-id> 隔离保证:每个 DeliveryUnit 独占该两级物化根(见 transaction.ts deliveryUnitRoots)且各自独立 ArtifactRegistry(delivery-units.ts),故不同单元的同名相对路径永不互相覆盖;此处只需校验全局图完整、无错误。`
② transaction.ts:222 `const key = ${unit.platform}/${unit.id}` 上方注释补:`// 该两级根即跨单元隔离边界:重复即报错,保证任意两单元的 Artifact 落到不相交子树。`

**边界与连带：** 纯注释。前提:platform 与 unit id 均已被 kebab-case 校验(delivery-units.ts:49、transaction.ts:220),隔离才无歧义——注释可点出此前提。不改行为/字节。

**测试：** 无新测试;确认 delivery-units.test.ts / transaction.test.ts 既有重复键用例覆盖该保证(如有则引用,无需新增)。

**验收：** lifecycle.ts 全局图校验处与 transaction.ts 根映射处均注明隔离由 <platform>/<unit-id> 提供;无行为变化。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none。


---

### P17d-8 · migration 全局 symbol bridge 的串行前提注释

**决策：** 注明:global symbol bridge + activeValidationProxies 引用计数只在‘所有并发迁移暴露同一不可变 api 且 runProject 校验按迁移串行’的前提下安全;它不隔离不同 api,并发差异 api 会后写覆盖。

**现状（锚点）：** packages/acplugin/src/migration/index.ts:46 `MIGRATION_VALIDATION_API = Symbol.for('tokenroll.acplugin.migration-validation-api')`,:48-49 `let activeValidationProxies = 0`;:1269-1271 validateCanonicalProject 里 `api = Object.freeze({ defineConfig, claudeCode, mcp, defineMcpServer })`→`Reflect.set(globalThis, ...)`→计数+1;:1322-1324 finally 计数-1、归零才 deleteProperty。注释(:48)只说『延迟删除全局桥接』,未写清并发前提。

**具体改动：**

把 index.ts:48 注释扩写为:`// 引用计数用于并发迁移共享全局桥接时延迟删除。安全前提:①每次迁移写入的 api 都是同一组不可变公开工厂({defineConfig,claudeCode,mcp,defineMcpServer}),故并发覆盖是幂等的;②每个生成工程的 runProject('validate') 就其自身而言是串行的,不依赖 per-call 的 api 身份。该桥接是进程/realm 级可变状态,不隔离不同 api——若未来令 api 随迁移变化(或在共享 realm 的 worker 中并行),最后写入者会覆盖其余,必须改为 per-migration 键或显式互斥。`
可在 :1270 Reflect.set 处加一行 `// ponytail: 进程级全局桥接,api 恒为同一冻结常量故并发幂等;api 若变异则需 per-migration 键。`

**边界与连带：** 纯注释。事实核对无误:api 恒为同一 frozen 常量(:1269),计数归零才删(:1323-1324),故当前并发相同 api 幂等安全。注释须中文。不改行为。

**测试：** 无新测试;确认 migration 相关测试仍绿。

**验收：** symbol/计数声明处注释写清‘同一不可变 api + 串行 runProject’前提及并发差异 api 的失效模式与升级路径。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none。


---

### P17d-9 · baseline changeset 故意不 bump 的说明

**决策：** 在 .changeset/initial-1-0-baseline.md 说明:空 frontmatter 是有意的——记录 1.0.0 架构基线但不触发任何包版本 bump,以满足首次手动发布前公开 cohort 固定在 1.0.0 的约束。

**现状（锚点）：** .changeset/initial-1-0-baseline.md 现为空 frontmatter(:1-2 `---`/`---`)+ 单行正文『Record the unreleased 1.0.0 architecture baseline without bumping the already prepared public cohort.』;未解释为何空 frontmatter=不 bump。约束依据:scripts/verify-release.mjs:348 断言 version==='1.0.0'『must remain at 1.0.0 before the first manual publish』;.changeset/config.json 三公开包 fixed 组、私有包 ignore。

**具体改动：**

保留空 frontmatter(不加任何 `'@tokenroll/...': patch` 行——加了就会 bump),把正文扩写为(英文正文即可,changeset 正文非注释、不受 check-comments 约束):
`Record the unreleased 1.0.0 architecture baseline without bumping the already-prepared public cohort.\n\nThe empty frontmatter is intentional: it declares zero package bumps, so "changeset version" produces no version change. The public cohort (@tokenroll/acplugin + hooks/mcp extensions, a fixed group in .changeset/config.json) must stay pinned at 1.0.0 until the first manual publish — enforced by scripts/verify-release.mjs (asserts version === '1.0.0'). This entry exists only to document the baseline in the changelog; do not add package:bump lines here.`

**边界与连带：** 关键:frontmatter 必须保持空,任何 `pkg: patch/minor/major` 行都会破坏 1.0.0 pin 并使 verify-release.mjs:348 失败。确定性:changeset 正文进 changelog,不入产物字节。此文件为 Markdown 正文,非源码注释,无需中文。

**测试：** 无代码测试。验证:`pnpm changeset status`(或等价)显示 0 个待 bump 包;`node scripts/verify-release.mjs` 的 version==='1.0.0' 断言仍通过。

**验收：** baseline changeset 正文解释了空 frontmatter=不 bump 及 1.0.0 pin 的来由与约束;frontmatter 仍为空;changeset status 无版本变更。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none(唯一雷区是误加 bump 行,已在文中显式警告)。


---

### P12 · 发布 runbook 记录 tsdown 0.x(0.22.x)破坏性风险(仅文档,不改 catalog pin)

**决策：** 在发布 runbook 记录 tsdown 处于 0.x(catalog 固定 ^0.22.14)、0.x minor 间可能有破坏性变更的风险;不改 pnpm-workspace.yaml 的 catalog pin。双语文档成对更新(release.md + release.zh-CN.md)。

**现状（锚点）：** 已 Read 确认。
- catalog pin:pnpm-workspace.yaml 第 11 行 `tsdown: ^0.22.14`(0.x 上的 caret = `>=0.22.14 <0.23.0`,已自动排除 0.23 minor 跳升)。
- llmdoc/guides/release.md(84 行)节:## Repository workflows / ## Prepare a release / ## Pack the release cohort / ## Publish manually / ## Create the release references manually / ## Safety rules(末节),无工具链风险条目。
- llmdoc/guides/release.zh-CN.md(84 行,成对)节:仓库工作流:13 / 准备发布:21 / 打包发布包组:37 / 手动发布:50 / 手动创建 Release 引用:67 / 安全规则:78(末节)。
- 仓库维护双语对照(release.md 头部有『[中文对照](release.zh-CN.md)』链接),故两文件都要加。

**具体改动：**

在两文件末节(EN `## Safety rules` / zh `## 安全规则`)之前各插入一个新小节,可直接粘贴:

# 追加到 llmdoc/guides/release.md(置于 `## Safety rules` 之前)
## Toolchain pins

`tsdown` is pinned in the workspace catalog at `^0.22.14`, a pre-1.0 `0.x` release. Under semver, `0.x` minors may ship breaking changes; the caret already excludes `0.23.0`. Do not bump the `tsdown` catalog entry as part of a routine release. When a `tsdown` upgrade is required, treat it as a separate deliberate change: bump the catalog pin on its own branch, run `pnpm run check` and `pnpm run release:verify`, and diff every package `dist/` to confirm the declaration output, `attw`, and `publint` results are unchanged before releasing.

# 追加到 llmdoc/guides/release.zh-CN.md(置于 `## 安全规则` 之前)
## 工具链固定版本

`tsdown` 在工作区 catalog 中固定为 `^0.22.14`(1.0 之前的 `0.x` 版本)。按 semver,`0.x` 的 minor 升级可能包含破坏性变更;caret 已排除 `0.23.0`。常规发布中不要顺带升级 catalog 里的 `tsdown`。确需升级时按独立且刻意的改动处理:在单独分支上修改 catalog pin,运行 `pnpm run check` 与 `pnpm run release:verify`,并 diff 每个包的 `dist/`,确认声明文件产物、`attw` 与 `publint` 结果不变后再发布。

**边界与连带：** 1) 纯文档,零代码/产物/确定性影响。
2) 必须成对改:只改一个语言会破坏 release.md↔release.zh-CN.md 对照。
3) 目标是【tracked】llmdoc/(非 .llmdoc-tmp/),note 会随仓库长期保留 —— 与 AGENTS.md:140『稳定知识更新到 llmdoc/』一致。
4) pin 不动:`^0.22.14` 已挡住 0.23,风险点其实是『有人手动把 catalog 提到 0.23+ 或跨 patch』时未复验 —— 文案已明确要求升级后重跑 check+release:verify 并 diff dist。

**测试：** 无(纯文档)。可选断言:`grep -l 'Toolchain pins' llmdoc/guides/release.md` 与 `grep -l '工具链固定版本' llmdoc/guides/release.zh-CN.md` 均命中;`grep 'tsdown:' pnpm-workspace.yaml` 仍为 `^0.22.14`。

**验收：** 两 release 文档各新增该小节且内容对照;pnpm-workspace.yaml 的 tsdown pin 未变;无任何 catalog/构建改动。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none。


---
## S5 — 低优批量清理

### P17a · 一行修复批:删死循环/死三元/冗余判断 + trim 空白 + -- 处停止 legacy 扫描

**决策：** 五处最小化清理与修正:OpenCode validator 空循环删除;Hooks 运行器死三元简化;scanner stringArray 空白校验改 trim;graph 冗余 byKey.has 删除;CLI legacy --target 扫描在 -- 处停止。

**现状（锚点）：** (a) packages/platforms/opencode/src/validator.ts:43-47 `for (const artifact of artifacts) { if (...) continue; /* 注释 */ }` —— 每次迭代非 continue 即落到注释,整个循环无副作用。
(b) packages/extensions/hooks/src/runtime-source.ts:140 (生成的运行器串) `interceptedBytes += Buffer.byteLength(typeof chunk === 'string' ? chunk : chunk);` —— 三元两支都是 chunk。
(c) packages/core/src/scanner.ts:292 `value.some(item => typeof item !== 'string' || item === '')` —— 只挡空串,放过纯空白。stringField(scanner.ts:264) 用的是 `value.trim() === ''`,不一致。
(d) packages/core/src/scanner.ts:1047-1050 visit 内 `for (const target of edges.get(node) ?? []) { if (byKey.has(target)) visit(target); }` —— edges 在 1003-1013 只 push 了 byKey.has 为真的 traversable 目标,这里的 byKey.has 恒真。
(e) packages/acplugin/src/cli.ts:679 `if (argv.slice(2).some(argument => argument === '--target' || argument === '-t' || argument.startsWith('--target=')))` —— 扫描 node+script 之后全部参数,包括 `--` 之后本应作为操作数/值的 `--target`,会误触发 legacy usage error。

**具体改动：**

(a) validator.ts:43-47 整段删除(48 行的 `if (!artifacts.has(WORKSPACE_CONFIG_PATH)) return;` 起保留)。
(b) runtime-source.ts:140
- `  interceptedBytes += Buffer.byteLength(typeof chunk === 'string' ? chunk : chunk);`
+ `  interceptedBytes += Buffer.byteLength(chunk);`
(Buffer.byteLength 对 string 与 Buffer 均可,行为等价。)
(c) scanner.ts:292
- `if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) {`
+ `if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {`
(短路保证 item.trim() 只在已窄化为 string 时求值。)
(d) scanner.ts:1047-1050
- `    for (const target of edges.get(node) ?? []) {`
- `      if (byKey.has(target))`
- `        visit(target);`
- `    }`
+ `    for (const target of edges.get(node) ?? [])`
+ `      visit(target);`
(e) cli.ts:678-684,把扫描限制在首个 `--` 之前:
```
    const flagArgs = argv.slice(2);
    const terminator = flagArgs.indexOf('--');
    const scanned = terminator === -1 ? flagArgs : flagArgs.slice(0, terminator);
    if (scanned.some(argument => argument === '--target' || argument === '-t' || argument.startsWith('--target='))) {
      program.error("option '--target' has been removed; use '--platform <id...>' instead", { exitCode: 2, code: 'acplugin.legacyTarget' });
    }
```

**边界与连带：** (a) validator 循环纯死代码,删后 validateOpenCodeBundle 语义不变;Public 安全性本就由 Core Artifact Registry 保证(原注释所述)。(b) 生成串行为完全等价,不改运行器语义。(c) 行为微变:纯空白的 requires.skills/agents/capabilities 现在在数组形态层报 FRONTMATTER_STRING_ARRAY,而非落到后续 ID_PATTERN/能力集报更晚的错;结果数组仍返回原值(不 trim 元素),不影响下游。(d) edges ⊆ byKey 恒成立,删除后遍历集合不变,环/缺失检测行为不变。(e) `['build','--target','unknown']` 仍报错(indexOf('--') 为 -1,全扫描);`--` 之后的 `--target` 不再误报。commander 未设 allowExcessArguments(false),`--` 后操作数不会因此崩。

**测试：** (a)(b)(d) 无行为变更,验收=现有 opencode/platform.test.ts、hooks.test.ts(SessionEnd oversized/log/output-forbidden 用例已覆盖 intercept 计数)、core/test/graph.test.ts 全绿,不新增。
(c) core/test/scanner.test.ts 新增:一个 command frontmatter `requires:\n  skills:\n    - '   '`,断言 diagnostics 含 `{ code: 'FRONTMATTER_STRING_ARRAY' }`。
(e) packages/test/test/cli.test.ts 新增(沿用 runCli 助手,cli.test.ts:174 同款):
```
it('does not treat --target after -- as the removed legacy flag', async () => {
  const usage = await runCli(['build', '--', '--target'], root);
  expect(usage.stderr).not.toContain('has been removed');
});
```
并保留 cli.test.ts:173-177 现有正向用例不变。

**验收：** 五处改完:lint(含 comments:check)通过;opencode/hooks/graph/scanner/cli 相关测试全绿;新增 (c)(e) 两例通过;现有 legacy --target 正向报错用例仍通过。

**工作量：** S ｜ **独立分支：** 否 ｜ **风险：** none —— 均为等价清理或更早/更一致的校验;(c) 唯一可见变化是空白输入的诊断码前移,需确认无测试断言旧的 COMPONENT_REQUIRES_ID_INVALID 针对空白输入(现有测试用的是非空白非法 ID,不受影响)。


---

### P17b · DX 批:init 失败透传具体原因 + stdio MCP smoke 按 production gate

**决策：** (1) 为 init 已知用户输入错误引入 InitError 并在 CLI 透传其校验消息(未知内部错误仍走通用安全消息);(2) MCP stdio smoke 仅在 mode==='production' 执行,dev 不每次 spawn;(3) pretest=build 的 DX 属可选,现状已由根 pretest 覆盖,建议不动。

**现状（锚点）：** cli.ts:598-601 init 的 catch 调 `writeFailure('init', error, options.json, false)`;writeFailure→failureReport(cli.ts:119-130) 仅对 ProjectConfigError 保留原诊断,其余一律输出通用 `COMMAND_FAILED: init failed.`,丢掉真实原因。init.ts 的用户输入校验全是裸 `throw new Error(...)`:97/99(目标非空目录/非目录)、213(缺目录)、227(名字非 kebab)、239(描述空)、258(无 Platform)、264/266(未知/重复 Platform);init.ts:103 是 re-throw 的底层 fs 异常(可能含绝对路径)。index.ts:125 只导出 initializeProject。mcp/src/bundler.ts:436-437 无条件 `const smokeFailure = await smokeTestServer(...)`;ExtensionBuildContext(contracts.ts:208 extends LifecycleContext) 带 command/mode。dev 每次重建都 spawn 子进程跑 5s 协议探测。根 package.json 已有 `pretest: pnpm run build`。

**具体改动：**

init.ts:顶部加 `export class InitError extends Error {}`;把 97/99/213/227/239/258/264/266 的 `throw new Error(...)` 全改为 `throw new InitError(...)`(103 的 re-throw 保持不变——未知 fs 错误不透传)。
index.ts:125
- `export { initializeProject } from './init.js';`
+ `export { initializeProject, InitError } from './init.js';`
cli.ts:顶部 import 增加 `InitError`;failureReport(119-130) 增支:
```
  const diagnostics = error instanceof ProjectConfigError
    ? error.diagnostics
    : error instanceof InitError
      ? [{ code: 'INIT_INVALID', severity: 'error' as const, message: error.message, phase: command }]
      : [{ code: internal ? 'FRAMEWORK_INTERNAL_FAILED' : 'COMMAND_FAILED', severity: 'error' as const, message: internal ? 'The command failed inside the framework.' : `${command} failed.`, phase: internal ? 'internal' : command }];
```
mcp/bundler.ts:436-437
- `      const smokeFailure = await smokeTestServer(bundle.server, server.definition);`
+ `      const smokeFailure = context.mode === 'production'
+        ? await smokeTestServer(bundle.server, server.definition)
+        : undefined;`
pretest:不改。若确需 `pnpm --filter X test` 前自动 build 依赖,再单独评估 per-package pretest,当前 YAGNI。

**边界与连带：** 确定性:mode 是 §18 显式可见输入,production 报 smoke、development 不报,是合规的按 mode 分叉,不引入非确定性。dev 下 broken server 的 bundle 仍被写入/提交——这是 dev 信任作者、不阻塞迭代的有意取舍,production/validate/inspect(默认 mode=production)仍全覆盖 smoke。InitError 只承载已知安全文案(无绝对路径);103 的底层 fs 异常仍收敛为通用消息,不泄露。init.test.ts:71 `rejects.toThrow('not empty')` 因 InitError extends Error、消息不变而继续通过。failureReport 的 phase 用 command(即 'init'),与既有 generic 支写法一致;Diagnostic.phase 接受该字符串。

**测试：** packages/test/test/cli.test.ts 新增(runCli):
```
it('surfaces the specific init validation reason', async () => {
  await fs.mkdir(path.join(root, 'occupied'));
  await fs.writeFile(path.join(root, 'occupied/keep.txt'), 'x');
  const r = await runCli(['init', 'occupied', '--yes', '--json'], root);
  const report = JSON.parse(r.stdout);
  expect(report.success).toBe(false);
  expect(report.diagnostics[0].code).toBe('INIT_INVALID');
  expect(report.diagnostics[0].message).toContain('not empty');
});
```
packages/extensions/mcp/test/mcp.test.ts 新增(对照 mcp.test.ts:374 的 production 反例):
```
it('skips the stdio smoke in development so dev rebuilds do not spawn servers', async () => {
  const root = await createProject({ remote: false, serverSource: 'process.exit(0);\n' });
  const result = await runProject({ cwd: root, command: 'build', mode: 'development' });
  expect(result.success).toBe(true);
  expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'MCP_STDIO_SMOKE_FAILED' }));
});
```
init.test.ts 现有用例保持不变(回归)。

**验收：** 1) `acplugin init <非空目录> --yes --json` 输出 code=INIT_INVALID 且 message 含真实原因('not empty'/'kebab-case' 等);未知内部错误仍为 COMMAND_FAILED;2) production 构建对 broken stdio server 仍报 MCP_STDIO_SMOKE_FAILED(mcp.test.ts:374 不变),development 不报且成功;3) InitError 从主包导出;4) init.test.ts 全绿。

**工作量：** M ｜ **独立分支：** 是 ｜ **风险：** InitError 是新公开导出(public-api.types.ts / package-boundaries 快照可能需同步登记);需确认 public-api 类型测试不因新导出失败。mcp gate 用 mode 而非 command:inspect(默认 production)也会 spawn 一次 smoke,可接受(一次性)。


---

### P17c · 兼容报告批:Codex 非-tool 事件有意义 matcher 报 degraded + {{arguments}} 独立 transform 行

**决策：** (1) reportCodexCompatibility 把 matcher 降级从仅 UserPromptSubmit/Stop 扩到所有非-tool 事件(排除 PreToolUse/PostToolUse/PermissionRequest),与 reportPortableCompatibility 同一规则,不再对非-tool 事件静默吞掉有意义 matcher;(2) Codex Command 正文含 {{arguments}} 时发一条独立 transform 兼容行,显式记录占位符被改写为自然语言。

**现状（锚点）：** packages/extensions/hooks/src/adapters.ts:282 `if (hasMeaningfulMatcher(options.matcher) && (name === 'UserPromptSubmit' || name === 'Stop'))` —— 只覆盖两个事件,SessionStart/PreCompact 等非-tool 事件带 matcher 时不报降级,作者被误导;对照 reportPortableCompatibility(adapters.ts:443-446)用的是 `event !== 'PreToolUse' && event !== 'PostToolUse' && event !== 'PermissionRequest'`。packages/platforms/codex/src/components.ts:307 command 正文 `.replaceAll('{{arguments}}', 'the arguments supplied with this explicit invocation')` 做了语义改写,但 301-325 的 command 循环只报了 component(transform,309)与 argumentHint(degraded,316),从未把 {{arguments}}→自然语言这条转换单独记账。

**具体改动：**

adapters.ts:282-289 改条件与 reason:
```
  if (hasMeaningfulMatcher(options.matcher)
    && name !== 'PreToolUse'
    && name !== 'PostToolUse'
    && name !== 'PermissionRequest') {
    context.reportCompatibility({
      subject: `hook:${hook.id}`,
      capability: 'matcher',
      level: 'degraded',
      reason: `Codex only honors matcher on tool events; it is ignored for ${name}.`,
    });
  }
```
codex/components.ts:在 command 循环 component 兼容行(结束于 315)之后、argumentHint 块之前插入:
```
    if (command.body.includes('{{arguments}}')) {
      context.reportCompatibility({
        subject: `command:${command.id}`,
        capability: 'arguments',
        level: 'transform',
        transformation: 'The {{arguments}} placeholder becomes natural-language guidance.',
        reason: 'Codex Skills cannot substitute Command arguments, so the placeholder is rewritten as descriptive text.',
      });
    }
```

**边界与连带：** 确定性:两处输入均为稳定工程字节/事件名,includes 判定确定。Strict 影响:transform 不触发 COMPATIBILITY_STRICT(codex platform.test.ts:170 中 command:release=transform 且 strict 构建成功已证),故新增 arguments 行不会破坏 release 的 strict 构建;非-tool matcher 的 degraded 才会在 strict 下失败,但那正是期望(把此前静默的语义损失显式化)。连带:canonicalHooks(hooks.test.ts:240)只在 PreToolUse(tool,排除)与 Stop(非-tool,原本已 degraded)设 matcher,其余事件无 matcher —— 因此 all-events 测试(hooks.test.ts:357)不产生新 degraded 行,result.success 仍为 true,377-382 仍过;codex Stop 专项(hooks.test.ts:740)行为不变。{{arguments}} 行会给 release(body 含 {{arguments}},platform.test.ts:57)与 deploy(platform.test.ts:194)各加一条,但相关断言均用 arrayContaining/toContainEqual,且已确认仓库无对 compatibility 的穷举 toEqual/快照,SKILL.md golden 不含 compat。

**测试：** packages/extensions/hooks/test/hooks.test.ts 新增(仅配 codex,避免 claude 结论干扰,模式仿 hooks.test.ts:769):
```
it('degrades Codex matcher on every non-tool event, not only Stop', async () => {
  const root = await createProject({
    hooks: [{ id: 'boot', definition: `{ event: 'SessionStart', matcher: 'startup', run() {} }` }],
    configImports: `import { codex } from ${JSON.stringify(acpluginEntry)};`,
    configFields: 'platforms: [codex()], build: { strict: true },',
  });
  const strict = await runProject({ cwd: root, command: 'validate', mode: 'production' });
  expect(strict.success).toBe(false);
  expect(strict.diagnostics).toContainEqual(expect.objectContaining({ code: 'COMPATIBILITY_STRICT', platform: 'codex' }));
  const relaxed = await runProject({ cwd: root, command: 'validate', mode: 'production', strict: false });
  expect(relaxed.compatibility).toContainEqual(expect.objectContaining({ platform: 'codex', subject: 'hook:boot', capability: 'matcher', level: 'degraded' }));
});
```
packages/platforms/codex/test/platform.test.ts 在既有 release 用例(146)追加断言:
```
expect(result.compatibility).toContainEqual(expect.objectContaining({ subject: 'command:release', capability: 'arguments', level: 'transform' }));
```

**验收：** 1) 带 matcher 的 SessionStart(非-tool)在 Codex 报 matcher degraded,strict 下失败、relaxed 下保留 degraded;2) Stop/UserPromptSubmit 行为不变;3) 含 {{arguments}} 的 Command 产出 capability='arguments' level='transform' 兼容行,不影响 strict 成功;4) all-events(hooks.test.ts:357)与 Stop 专项、codex golden 全绿。

**工作量：** M ｜ **独立分支：** 是 ｜ **风险：** 改的是兼容性报告契约:若 packages/test 有跨平台 compatibility 汇总/golden(已 grep 未发现穷举断言)需回归;matcher 规则以仓库自有模型(tool 事件=PreToolUse/PostToolUse/PermissionRequest)为准,若后续对 Codex 支持面有更精确认定需同步该三元。


---
## 待确认清单（⚠️ 落地前需拍板）

1. **⚠️ P5 — 公开扩展包 engines 一致性：** 是否让 `-extension-hooks` 与 `-extension-mcp` 也随主包把 `engines.node` 提到 `>=22.18`（发布组 3 包一致）、CI `node-version` 是否同步。二选一：全改 12 处 + CI，或明确接受只改 4 处（主包+core+test+根）。默认先只改 4 处。
2. **⚠️ P14 — dev 缓存的“工具版本指纹”（R1）：** 运行期看不到 tsdown/rolldown semver。可选代理：(a) `process.versions.node` + `pnpm-lock.yaml` 内容 hash（推荐，lockfile 变即失效）；(b) 退一步只用 `ACPLUGIN_VERSION`。需选定。
3. **⚠️ P16-e — `SEMVER_PATTERN` 语义分歧：** 六平台 semver 正则有有意的严格度差异，盲目合一属 spec 变更须产品确认。**默认不合一**，只合并真正等价的纯 helper；`findCanonicalDocument` ROI 低可跳过。
4. **P16 优先级锁定：** P16-c churn 最大（12+ 文件、10+ 调用点），若平台/Core 改动先落地会增加合并成本 —— 需锁定 P16 先行（已在顺序说明注明）。
5. **P2 — success 语义有意变化：** 构建成功但 buildEnd 抛错时 `success=true`（诊断仍带一条 error 级 `*_BUILD_END_FAILED`）。符合拍板；已核查无“success===true 即无 error 诊断”耦合。仅供知悉。
6. **P17d-6 / P17d-2 时效前提：** MCP tree-shake 断言依赖 dist 未混淆导出名；Claude 字段注释基于当前 reference/SchemaStore 事实。若发布构建启用混淆或上游 schema 变，按注释里的退路调整。
