---
description: 调查、实施和复核通用工程任务
invocation:
  user: true
  model: true
platforms:
  claude-code:
    allowedTools:
      - Read
      - Glob
      - Grep
    context: fork
    agent: Explore
  codex:
    displayName: Project workflow
    shortDescription: Plan, implement, and verify scoped project changes.
    iconSmall: ./assets/icon-small.svg
    iconLarge: ./assets/icon-large.svg
    brandColor: '#FACC15'
    defaultPrompt: Inspect the repository and propose a verified implementation plan.
    products:
      - CHAT
      - CODEX
---

# Project workflow capability template

在需要调查工程、规划改动、复核实现或准备交付时使用此 Skill。

## 工作方式

1. 确认任务范围、约束和预期输出。
2. 调查源码与测试并记录可复核证据，不把推测写成事实。
3. 实施最小改动，保留用户已有工作并明确风险。
4. 运行与风险匹配的验证，并给出可复现的交付说明。

## References

- [Planning](references/planning.md)
- [Verification](references/verification.md)
- [Review](references/review.md)
- [Context continuation](references/context-continuation.md)

这些 references 是通用工作流示例，第三方作者可以替换为自己的领域说明和辅助资源。
