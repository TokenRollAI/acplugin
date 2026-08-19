# Asset、Document 与 Package

## Asset

Asset 是 Core Registry 签发的不透明引用，来源为已验证源码、Compiler 输出或复制后的内存字节。mode 只允许 `0644`/`0755`。Core 绑定真实 issuer owner、结构化 origin、size 与 SHA-256；Package 只保存路径映射和 AssetRef。

路径会拒绝：

- POSIX/Win32 绝对路径、NUL 与任何 `..` 片段；
- 符号链接和特殊文件；
- 大小写、Unicode normalization、文件/目录前缀冲突；
- Platform/Extension/Framework 之间未经 grant 的跨 owner 引用。

## Document 与 Contribution

Platform `createPackage()` 创建结构化 JSON/YAML/TOML/frontmatter Document，并声明仍为空的 extension point。所有 Contributor 读取同一份不可变 base snapshot，只能提交字段路径和值；Core 统一验证并编码 Document。

add-only merge 不提供 replace、remove、数组 append 或深度覆盖。两个 owner 写同一字段或同一 Asset 路径会失败，不存在 first/last-writer-wins。

## Package 与 transaction

Platform `finalizePackage()` 为集中合并后的 snapshot 决定主 Package 身份并可追加自己的 Asset。Core 自动保留所有继承 Asset 的 owner、mode、size、hash 和 origin。主 Package 物化并通过 `validatePackage()` 后，Platform 才能派生可选 Distribution；Distribution 也要单独物化和校验。

所有所选 Package Unit 都通过后，Core 才按锁 → 恢复 → stage → 校验 → transaction/backup → swap → cleanup 提交托管 `dist`。任何失败保留上一份完整输出。
