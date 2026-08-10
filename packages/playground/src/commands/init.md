---
description: 初始化一个通用的 ACPlugin 能力模板
argumentHint: <target>
requires:
  skills:
    - project-workflow
platforms:
  claude-code:
    allowedTools:
      - Read
      - Glob
      - Grep
    model: sonnet
  codex:
    displayName: Initialize capability template
    shortDescription: Plan a complete ACPlugin capability example.
    brandColor: '#FACC15'
    defaultPrompt: Initialize the ACPlugin capability template for the supplied target.
    products:
      - CHAT
      - CODEX
---

为 `{{arguments}}` 规划一个包含 Command、Skill、Agent、Hook、MCP 与 Public 文件的 ACPlugin capability template，并说明各资源的职责。

当前 Playground 只展示作者工程结构和平台构建能力，不替目标工程实现业务逻辑。
