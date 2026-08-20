# ADR-0001：Session 关闭、确定性输入与 dev 重建范围

- 状态：已接受
- 日期：2026-08-08
- 更新：2026-08-14
- 适用范围：Kernel v2、lifecycle API v1

## 背景

Kernel v2 用每次构建独占的 `PlatformSession` / `ExtensionSession` 取代共享生命周期 Hook。Session 可能持有必须在成功、失败或中止后释放的资源；同时，托管提交在必要的 Session 清理全部成功前必须仍可回滚。

构建输出和 schema-v2 报告还必须保持确定性，并且不泄漏机器路径或 Secret。旧生命周期曾暴露环境快照，也讨论过跨轮次 dev cache，但没有定义可序列化状态、实现指纹、可重放副作用和事务语义。

## 决策

1. Core 为每个已初始化的 Platform/Extension 创建隔离 Session，并按初始化逆序恰好调用一次 `close()`。
2. 对需要提交的构建，`close()` 在事务的 `afterSwap` 可回滚窗口运行。关闭失败会记录 `cleanup` 诊断、恢复旧输出，并得到 `success=false`、`committed=false`。
3. `validate`、`inspect`、失败构建和被中止的开发 Session 在事务外关闭已初始化集成，`committed=false`。单个关闭失败不阻止其余关闭，也不能覆盖 close 摘要中的首个业务失败。
4. 集成生命周期 Context 不接收环境变量快照。函数式配置只能观察 `{ command, mode }`；隔离执行只通过 `ExecutionService` 接收调用方显式提供的最小环境。
5. Core 和官方集成不得把时间、随机、机器路径、临时路径或 Secret 值写入 Asset/报告。脱敏只处理结构化 Secret、可识别凭据和已知物理根，不用任意环境值做无边界子串替换。
6. `Project.dev()` 对每个合并后的变更轮次执行完整 BuildSession，并保留最后一次成功输出。Kernel v2 不提供整条执行或跨轮次缓存。
7. 未来缓存必须先定义版本化 fingerprint、可序列化的 owner-scoped 状态与副作用、完整依赖发现、损坏恢复和 clean-build 等价测试。第三方集成默认不可缓存，除非未来协议显式允许。

## 影响

- 成功报告不能同时包含 error 诊断。
- cleanup 失败不能暴露部分提交的目标集合。
- dev 重建与 clean build 保持生命周期、依赖发现、校验和事务语义一致。
- 集成作者不能意外依赖框架无法审计的环境快照。

## 未采用方案

- 在事务失去回滚能力后才关闭 Session：可能留下“新输出已生效、构建却失败”的状态。
- dev cache 命中时直接返回旧报告：会跳过生命周期副作用、依赖发现、恢复和当前输出校验。
- 用所有环境值替换诊断中的同字子串：无关值可能破坏稳定协议身份。
- 让 cleanup 失败覆盖首个业务失败：会隐藏可行动原因，并让诊断依赖执行顺序。

## 证据

- `packages/core/src/lifecycle/build-session.ts`
- `packages/core/src/lifecycle/dev-session.ts`
- `packages/core/src/security/report-safety.ts`
- `packages/core/src/output/transaction.ts`
- `packages/core/src/contracts/`（`IntegrationCloseContext`、`ExecutionService`、`BuildReport`）
