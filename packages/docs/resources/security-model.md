# 安全模型

ACPlugin 把外部作者输入视为不可信数据，直到对应阶段完成结构、来源和最终候选验证。

## 路径与来源

- 配置路径必须在工程根内，输出不能与源码/Public 重叠。
- Component、Skill auxiliary、Public、Platform workDir、Extension workDir 各有独立来源授权。
- 拒绝绝对路径、NUL、`..`、符号链接、特殊文件和规范化冲突。
- `dist` 只由 transaction 层整体提交。

## 扩展协议

- Document patch 是 owner-aware add-only；没有覆盖优先级。
- Hook 作者只返回语义结果，wire 拥有目标协议；runner 有输入输出上限和稳定错误码。
- HTTP MCP Secret 使用环境引用，构建不读取值。
- Local stdio MCP 必须 bundle 并通过真实协议 smoke。

## 报告与错误

`buildEnd` 只收到脱敏异常摘要。稳定报告不会输出凭据、环境值、Artifact bytes、机器路径或临时路径。第三方 bundle 需要生成确定性许可材料。

Relaxed compatibility 不会绕过这些安全检查。
