# 官方扩展

Hooks 与 MCP 是独立公开 Extension package，通过官方 Adapter 参与已配置 Platform 的构建。

- [Hooks](./hooks.md)统一书写语义 handler，由 Adapter 拥有目标 stdin/stdout 协议。
- [MCP](./mcp.md)覆盖 portable HTTP 声明与完整 local stdio server。

Extension 不是 Core 的 optional flag。只有安装 package、在 `extensions` 中实例化后，相应作者目录才合法。
