# 统一 Rolldown Compiler

Core 是一次 BuildSession 中唯一的 Rolldown owner。Platform、Extension 与第三方集成都通过 `context.compiler.compile()` 提交声明式 Job，不能创建自己的 bundler、watcher 或输出目录。

## `portable-node`

面向需要跨平台交付的 Node 20 ESM 可执行内容，也是内建 Runtime、Hooks 与本地 MCP 使用的 profile：

- 输出自包含 ESM bundle，只有 `node:` 内置模块保持 external；
- 静态/动态 import 必须可解析，拒绝原生扩展和隐式运行时依赖；
- 固定无 sourcemap，禁止输出绝对路径、时间戳和环境值；
- 许可证默认严格收集，无法确认第三方许可时失败；
- 模块图、descriptor、tsconfig、package 与 license 文件进入 Core Watch Registry。

作者可通过 `PortableNodeCompileOptions` 调整受限的 `resolve`、`transform` 和 `treeshake` JSON 字段，但不能注入 Rolldown Plugin 或回调。

## `managed-rolldown`

面向第三方 Platform/Extension 的高级构建。它暴露 Rolldown 能力的受管子集，包括 plugin，但 Core 始终接管：

- `cwd`、input 身份与 source scope；
- 输出目录、日志、watch 登记和关闭；
- 禁止 `writeBundle`、`watchChange`、`closeWatcher` 等越权 Hook；
- workDir、Asset 签发、模块图审计和确定性边界；
- 默认 `strict` 的第三方许可证策略。

显式 `licenses: 'ignore'` 表示调用方自行承担法律材料交付责任；它不会关闭路径、模块图或 owner 安全检查。Compile 输出只能作为 `GeneratedAssetRef` 进入 Package，不能在构建后复制、重命名或 patch `dist`。
