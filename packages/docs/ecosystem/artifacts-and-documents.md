# Artifact 与 Document

## Artifact

Artifact 只有两种来源：驻留内存的 `bytes`，或已经验证的普通 `file`。mode 只允许 `0644`/`0755`。Core 计算 size 与 SHA-256，并在 owner 授权、路径和碰撞校验后才允许进入 DeliveryUnit。

路径拒绝：

- POSIX/Win32 绝对路径、NUL、任何 `..` 片段；
- 符号链接和特殊文件；
- 大小写、Unicode normalization、文件/目录冲突；
- Platform/Extension/Public 跨 owner 来源越权。

## Document

Platform `prepare` 可以创建结构化 JSON/YAML/TOML Document，并明确列出 extension points。Adapter 获得只读快照，只能 add-only patch 当前仍为空且已声明的字段。

owner-aware merge 不提供 replace、remove、array append 或深度覆盖。同一字段被两个 owner 写入时稳定失败。完成 Adapter 后，Platform 收到冻结的最终 Draft，再自行序列化和验证。

## DeliveryUnit 与 transaction

Platform 先生成并验证 primary DeliveryUnit，再可基于已验证主单元生成 Marketplace 等 Distribution。继承 Artifact 必须保留 owner、mode、size 与 hash。

所有选中目标都通过后，Core 才按锁 → 恢复 → stage → 校验 → backup → swap → cleanup 提交托管 `dist`。任何失败保留上一次完整输出。
