# 安全模型

ACPlugin 把 Markdown、路径、JSON 数据和待交付 Asset 视为不可信数据，直到对应阶段完成结构、来源和最终候选验证。TypeScript 配置、Platform、Extension 与其 descriptor 则是会在构建进程中执行的可信代码，安装或运行前必须像其他构建工具依赖一样审查。

## 可信 Integration 边界

Platform/Extension 与作者配置和 descriptor 不是进程沙箱。它们可以使用 Node.js 能力直接读取进程可访问的文件或环境；Core 不承诺阻止恶意 Integration。Core 的 owner-scoped Source、Module、Compiler、Execution 和 Asset Service 负责限制哪些来源和输出能进入受管 Package、报告与事务，并提供确定性和可审计边界。

Platform/Extension factory result 使用 `Symbol.for(...)` 的共享 registry brand，使同一生命周期 API 的主包 root、SDK 和 CLI bundle chunk 能识别同一类定义。该 Symbol 可被同进程代码访问或伪造，不是 private Symbol、权限令牌或安全边界；定义仍需通过精确 shape、API version、JSON copy/freeze 和生命周期校验。

## 路径与来源

- 配置路径必须在工程根内，输出不能与源码/Public 重叠。
- Component、Skill auxiliary、Public、Platform 与 Extension 各有独立的 owner-scoped Source/Asset 授权；物理 workDir 只对 Core Host 可见。
- 拒绝绝对路径、NUL、`..`、符号链接、特殊文件和规范化冲突。
- `dist` 只由 transaction 层整体提交。

## 扩展协议

- Document Contribution 是 owner-aware add-only；所有 Contributor 读取同一 base Package，没有覆盖优先级。
- Hook 作者只返回语义结果，wire 拥有目标协议；runner 有输入输出上限和稳定错误码。
- HTTP MCP Secret 使用环境引用，构建不读取值。
- Local stdio MCP 必须 bundle 并通过真实协议 smoke。

## 报告与错误

Session `close()` 只收到脱敏失败摘要。稳定报告不会输出凭据、环境值、Asset bytes、机器路径或临时路径。第三方 bundle 默认需要生成确定性许可材料。

Relaxed compatibility 不会绕过这些安全检查。
