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
├── mcp/                    # 启用 MCP Extension 时
│   └── docs/mcp.ts
└── runtime/                # 可选 Core Runtime 约定
    ├── cli.ts              # 一级文件自动成为入口
    └── internal/helper.ts  # 嵌套文件只作为依赖
public/
└── templates/report.md
```

## Scanner 管理的内容

- Command 必须是 `src/commands/<id>.md` 的一级 Markdown 文件。
- Skill 必须是 `src/skills/<id>/SKILL.md`；同目录其他普通文件是 auxiliary resources。
- Agent 必须是 `src/agents/<id>.md` 的一级 Markdown 文件。
- ID 使用小写 kebab-case。Markdown 必须有合法 YAML Frontmatter 和非空正文。

`srcDir` 可在配置中修改，但三个 Canonical 目录的相对结构不变。符号链接、特殊文件和目录层级错误会被拒绝。

## Extension 与 Runtime 管理的内容

`src/hooks` 与 `src/mcp` 不是 Core Component，由相应 Extension 的 `discover` 阶段拥有；目录非空但未启用 Extension 时，构建会失败。`src/runtime` 是 Core Framework Resource：一级 TS/JS 文件按约定成为入口，显式 `runtime.entries` 完整替换自动发现，`runtime: false` 关闭该能力。Descriptor 由 Core Module Service 执行，所有可执行代码由 Core Rolldown Build Service 构建。

## Public

默认 `public/` 中的普通文件会成为每个 Platform base Package 的 Framework Contribution。也可以通过 [Public 配置](/config/public-files)关闭、改目录或只复制选定路径。

## 输出

`dist/` 由事务层完整管理。Platform 和 Extension 只能把 Core 签发或授权的 AssetRef 映射到 Package；物理 workDir 与 `dist` 写入都只由 Core 管理。
