# 确定性构建

在相同工程字节、配置、ACPlugin/Platform/Extension 版本、Node major 和 lockfile 下，生成内容与稳定报告应保持字节一致。

## 作者责任

- 不在 config、Platform 或 Extension build 中读取未声明的机器环境来改变产物。
- 不写时间戳、随机 ID、临时绝对路径或宿主目录。
- 使用主包的 `stableJson()`、`stableYaml()` 和稳定报告序列化器。
- 对文件和对象键采用明确稳定顺序。
- Secret 只保留 `{ env }` 引用，不读取值。

## 框架保证

- Scanner 和 Registry 对目录、资源和报告使用稳定排序。
- Artifact 记录固定 owner、mode、size 与 SHA-256。
- 报告不包含 Artifact bytes、时间、绝对路径、凭据或环境值。
- TypeDoc/VitePress 文档 build 关闭 last-updated，不在线 fetch 内容。

确定性不是跨任意 Node/依赖版本的承诺。升级 Node major、lockfile 或生成器版本后，应把变化作为正常版本化 diff 审查。
