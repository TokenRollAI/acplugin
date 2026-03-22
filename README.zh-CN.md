# acplugin

将 [Claude Code](https://claude.ai/code) 插件转换为 [Codex CLI](https://github.com/openai/codex)、[OpenCode](https://opencode.ai/) 和 [Cursor](https://cursor.com/) 格式。

## 安装

```bash
npm install -g @disdjj/acplugin
```

或直接使用 `npx`：

```bash
npx @disdjj/acplugin convert .
```

## 快速开始

```bash
# 转换当前项目
acplugin convert .

# 从 GitHub 转换
acplugin convert anthropics/claude-code --all --to cursor

# 仅扫描资源（不转换）
acplugin scan anthropics/claude-code
```

## 功能特性

- 转换 Skills、指令、MCP 配置、Agents、Commands 和 Hooks
- 支持 Claude Code Plugin marketplace 格式（多插件仓库）
- 交互式 TUI，支持 checkbox 多选插件和平台
- 直接支持 GitHub 仓库 — 无需先 clone
- 智能检测：自动识别本地项目、单插件和 marketplace 仓库

## 支持的转换

| 资源类型 | Codex CLI | OpenCode | Cursor |
|---------|-----------|----------|--------|
| **Skills** (SKILL.md) | `.agents/skills/` | `.opencode/skills/` | `.cursor/skills/` |
| **指令** (CLAUDE.md) | `AGENTS.md` | `AGENTS.md` | `.cursor/rules/*.mdc` |
| **MCP 服务器** (.mcp.json) | `.codex/config.toml` | `opencode.json` | `.cursor/mcp.json` |
| **Agents** (.claude/agents/) | 合并到 `AGENTS.md` | `.opencode/agents/` | `.cursor/rules/agent-*.mdc` |
| **Commands** (.claude/commands/) | 转换为 Skills | `.opencode/commands/` | `.cursor/commands/` |
| **Hooks** (settings.json) | 记录在 `AGENTS.md` | 记录在 `AGENTS.md` | 仅输出警告 |

## CLI 参考

### `acplugin scan [source]`

扫描并列出可转换的资源。

```bash
acplugin scan .                              # 当前目录
acplugin scan ./my-project                   # 本地路径
acplugin scan anthropics/claude-code         # GitHub 仓库
acplugin scan https://github.com/owner/repo  # 完整 GitHub URL
acplugin scan owner/repo --path plugins/foo  # 仓库内子路径
```

### `acplugin convert [source]`

将 Claude Code 插件转换为目标平台格式。

```bash
acplugin convert .                           # 交互式选择平台
acplugin convert . --to cursor               # 指定平台
acplugin convert . --to codex,cursor         # 多个平台
acplugin convert anthropics/claude-code      # 从 GitHub，交互式
acplugin convert anthropics/claude-code --all  # 全部插件，跳过选择
acplugin convert . -o ./output               # 自定义输出目录
acplugin convert . --dry-run                 # 预览模式，不写入文件
```

**选项：**

| 选项 | 说明 |
|------|------|
| `-t, --to <platforms>` | 目标平台（逗号分隔：`codex`、`opencode`、`cursor`） |
| `-o, --output <path>` | 输出目录 |
| `-a, --all` | 全部转换，跳过交互选择 |
| `-p, --path <subpath>` | 仓库内子路径 |
| `--dry-run` | 预览生成的文件，不实际写入 |

## 使用示例

### 转换本地项目

```bash
cd my-project
acplugin convert . --to cursor
```

### 从 GitHub Plugin Marketplace 转换

```bash
# 交互式：浏览并选择插件
acplugin convert anthropics/claude-code

# 全部插件转换到所有平台
acplugin convert anthropics/claude-code --all -o ./converted
```

### 扫描仓库查看可用资源

```bash
$ acplugin scan anthropics/claude-code

Claude Code Plugin Marketplace
✔ Found 13 plugin(s) with resources

1. agent-sdk-dev [development] — 3 resource(s)
2. code-review [productivity] — 1 resource(s)
3. commit-commands [productivity] — 3 resource(s)
...
```

### 私有仓库

设置 `GITHUB_TOKEN` 环境变量访问私有仓库：

```bash
export GITHUB_TOKEN=ghp_xxx
acplugin convert my-org/private-plugins --all --to codex
```

## 工作原理

1. **扫描** — 检测 Claude Code 资源：`.claude/` 项目结构、`.claude-plugin/` 插件格式或 marketplace 仓库
2. **选择** — 交互式 TUI 让你选择要转换的插件和目标平台
3. **转换** — 将每个资源转换为目标平台格式，保留内容并添加平台特定的元数据
4. **报告** — 显示生成结果，对无法完全转换的资源输出警告

Claude 特有的功能（如 `context: fork`、`agent: Explore`）会以 HTML 注释的形式保留在输出文件中，供参考。

## 许可证

MIT
