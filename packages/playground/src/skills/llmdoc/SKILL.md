---
description: 规划和维护 llmdoc v3 风格的项目知识
invocation:
  user: true
  model: true
---

# llmdoc v3 authoring template

在需要调查项目、提出知识候选、审查过期内容或规划显式升级时使用此 Skill。

## 工作方式

1. 先确认任务范围与当前知识边界。
2. 调查源码并记录可复核证据，不把推测写成事实。
3. 区分候选变化、冲突、删除建议和仍需用户确认的决策。
4. 只有完整 runtime 才能计算 fingerprint、更新 graph 并执行 transaction。

## References

- [Frontier](references/frontier.md)
- [Transaction](references/transaction.md)
- [Reflection promotion](references/reflection-promotion.md)
- [Compact continuation](references/compact-continuation.md)

这些 references 描述目标模型，不代表 playground 已实现相应状态机或持久化逻辑。
