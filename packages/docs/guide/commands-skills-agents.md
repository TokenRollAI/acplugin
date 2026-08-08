# Commands、Skills 与 Agents

三类 Component 都使用 YAML Frontmatter + 非空 Markdown 正文，并可通过 `requires` 建立依赖图。缺失依赖、自依赖和循环依赖都会在 Scanner 阶段失败。

## Command

```md
---
description: Deploy the selected service
argumentHint: "<service> [environment]"
requires:
  skills:
    - release-policy
---

Deploy `{{arguments}}` only after checking the release policy.
```

允许字段是 `description`、`argumentHint`、`requires`、`platforms`。`{{arguments}}` 是唯一规范参数占位符；是否保留参数 UI 由 Platform 的兼容性报告说明。

## Skill

```md
---
description: Apply the repository release policy
invocation:
  user: true
  model: true
---

Read [the checklist](references/checklist.md) before approving a release.
```

`invocation.user` 与 `invocation.model` 默认为 `true`，不能同时为 `false`。`SKILL.md` 之外的普通文件会以 binary-safe 方式作为 auxiliary files 处理。

## Agent

```md
---
description: Investigate source and return an evidence-backed report
model: capable
capabilities:
  - filesystem:read
  - search
---

Inspect the requested area, cite file locations, and stop after reporting evidence.
```

`model` 只接受 `inherit`、`fast`、`capable`。可移植 capabilities 是 `filesystem:read`、`filesystem:write`、`search`、`shell`、`network`、`delegate`。

## 平台专属字段

Frontmatter 的 `platforms.<id>` 只在对应 Platform 已配置时合法，并由该 Platform 自己验证。Core 不维护具体平台字段，也不会把未知对象透传到产物。

查看[兼容性矩阵](/resources/compatibility-matrix)了解三类 Component 在六个平台上的处理方式。
