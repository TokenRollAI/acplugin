# ADR-0001：生命周期完成、确定性输入与缓存范围

- 状态：已接受
- 日期：2026-08-08
- 适用版本：acplugin 1.0

## 背景

托管输出事务在新输出完成 swap、但旧输出仍可恢复的窗口执行 `buildEnd`。因此当前 `buildEnd` 失败会中止事务并恢复上一份完整输出。

生命周期 Hook 还会收到一次冻结的环境快照。与之无关的报告脱敏曾把所有环境值当成无边界子串替换；当某个环境值为 `claude` 时，它会破坏 `claude-code` 等协议身份。

1.0 规范提到 dev cache，却没有定义可序列化的 Extension 状态、实现指纹、可重放副作用或缓存命中时的事务语义。整条执行缓存会跳过可观察的生命周期 Hook，还可能在未验证当前输出目录时返回旧的 `committed` 结果。

## 决策

1. `buildEnd` 保持为完整构建事务的一部分。`buildEnd` 出错时回滚新输出，并得到 `success=false`、`committed=false`。
2. error 诊断不得与 `success=true` 共存。`committed` 表示当前调用是否完成托管提交，不表示以前某次调用曾提交过相同字节。
3. 保留 `BuildStartContext.environment` 与 `BuildEndContext.environment` 公共能力；Core 为一次调用捕获并冻结一份快照。
4. 捕获的环境快照属于确定性输入。Core 与内置实现不得把未声明时间、随机、路径或 Secret 值读取引入 Artifact/报告；可信项目配置和第三方 Extension 对自己主动观察的机器状态负责。
5. 报告脱敏处理结构化 secret 字段、可识别凭据形式、工程/运行根与临时路径；不得枚举任意环境值并替换同字子串。
6. acplugin 1.0 不实现整条执行或 Core 跨运行缓存。规范只约束“若实现 dev cache”时的行为，不要求 1.0 必须存在缓存。
7. 未来缓存必须先定义版本化 fingerprint、可序列化值、可重放的 owner-scoped effects、完整依赖发现、损坏恢复和 clean-build 等价测试。第三方实现默认不可缓存，除非显式加入未来协议。

## 影响

- 清理失败继续保留上一份完整交付产物。
- REDACT-1 可以在不静默删除生命周期环境能力的前提下修复。
- 无关环境值不再改写报告内容。
- 1.0 的每次 dev 重建仍执行完整生命周期与事务。
- 后续增量系统是显式架构能力，而不是围绕任意第三方代码的透明捷径。

## 未采用方案

- `success=true` 同时带 error 诊断：违反 Diagnostic Collector 与 CLI exit-code 契约。
- `buildEnd` 改为提交后清理并保留输出：只有 `committed=true, success=false` 才自洽，但 1.0 没有改变现有事务契约的必要。
- 把 Hook 环境改成空对象：静默破坏公共 Context，而且可信代码仍可读取全局进程状态。
- dev cache 命中时直接返回旧 `BuildResult`：会跳过 Hook、依赖发现、验证、事务恢复和当前输出校验。

## 证据

- `packages/core/src/lifecycle.ts:218-226,286-348,702-718`
- `packages/core/src/transaction.ts:383-413`
- `packages/core/src/contracts.ts:188-193,257-264`
- `packages/core/src/diagnostics.ts:17-79`
- `packages/core/src/reports.ts:108-133`
- 规范 §9.4、§10.3 与 §18
