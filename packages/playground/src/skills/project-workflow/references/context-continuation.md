# Context continuation

长任务应保留最小续接信息：当前目标、已完成改动、验证结果、仍待处理步骤和不可违反的约束。

本模板的 `PreCompact` 与 `PostCompact` Hook 只展示协议结果，不持久化状态；真实 Extension 可以按产品需求实现自己的安全续接机制。
