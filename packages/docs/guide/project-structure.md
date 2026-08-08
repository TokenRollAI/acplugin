# 工程结构

一个完整作者工程可以包含：

```text
acplugin.config.ts
src/
├── commands/
│   └── deploy.md
├── skills/
│   └── review/
│       ├── SKILL.md
│       └── references/checklist.md
├── agents/
│   └── investigator.md
├── hooks/                  # 启用 Hooks Extension 时
│   └── session-start/hook.ts
└── mcp/                    # 启用 MCP Extension 时
    └── docs/mcp.ts
public/
└── templates/report.md
```

## Scanner 管理的内容

- Command 必须是 `src/commands/<id>.md` 的一级 Markdown 文件。
- Skill 必须是 `src/skills/<id>/SKILL.md`；同目录其他普通文件是 auxiliary resources。
- Agent 必须是 `src/agents/<id>.md` 的一级 Markdown 文件。
- ID 使用小写 kebab-case。Markdown 必须有合法 YAML Frontmatter 和非空正文。

`srcDir` 可在配置中修改，但三个 Canonical 目录的相对结构不变。符号链接、特殊文件和目录层级错误会被拒绝。

## Extension 管理的内容

`src/hooks` 与 `src/mcp` 不是 Core Component。相应 Extension 的 `discover` 阶段拥有这些作者格式；目录非空但未启用 Extension 时，构建会失败，而不是静默忽略。

## Public

默认 `public/` 中的普通文件会成为每个 Platform Draft 的公共输入。也可以通过 [Public 配置](/config/public-files)关闭、改目录或只复制选定路径。

## 输出

`dist/` 由事务层完整管理。Platform 和 Extension 只能写各自 workDir，再把经过 Core 授权的 Artifact 提交给候选 DeliveryUnit；不得直接写 `dist`。
