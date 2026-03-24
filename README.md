# acplugin

[![LINUX.DO](https://img.shields.io/badge/LINUX.DO-Community-f0b752?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0wIDE4Yy00LjQyIDAtOC0zLjU4LTgtOHMzLjU4LTggOC04IDggMy41OCA4IDgtMy41OCA4LTggOHoiLz48L3N2Zz4=)](https://linux.do)

[中文文档](./README.zh-CN.md)

Convert [Claude Code](https://claude.ai/code) plugins to [Codex CLI](https://github.com/openai/codex), [OpenCode](https://opencode.ai/), [Cursor](https://cursor.com/), and [Google Antigravity](https://antigravity.google/) formats.

## Install

```bash
npm install -g @disdjj/acplugin
```

Or use directly with `npx`:

```bash
npx @disdjj/acplugin convert .
```

## Quick Start

```bash
# Interactive wizard — just run acplugin!
acplugin

# Convert current project
acplugin convert .

# Convert from GitHub
acplugin convert anthropics/claude-code --all --to cursor

# Scan resources without converting
acplugin scan anthropics/claude-code
```

## Features

- Converts Skills, Instructions, MCP configs, Agents, Commands, and Hooks
- **4 target platforms**: Codex CLI, OpenCode, Cursor, Google Antigravity
- Full subagent conversion with proper format for each platform
- Automatic model mapping (Claude → GPT-5.4 / Gemini 3 Pro)
- Supports Claude Code Plugin marketplace format (multi-plugin repos)
- Interactive TUI with checkbox selection for plugins and platforms
- Direct GitHub repo support — no need to clone first
- Smart detection: auto-detects local projects, plugins, and marketplace repos

## Supported Conversions

| Resource         | Codex CLI                 | OpenCode                  | Cursor                | Antigravity             |
| ---------------- | ------------------------- | ------------------------- | --------------------- | ----------------------- |
| **Skills**       | `.agents/skills/`         | `.opencode/skills/`       | `.cursor/skills/`     | `.agent/skills/`        |
| **Instructions** | `AGENTS.md`               | `AGENTS.md`               | `.cursor/rules/*.mdc` | `GEMINI.md`             |
| **MCP Servers**  | `.codex/config.toml`      | `opencode.json`           | `.cursor/mcp.json`    | `.gemini/settings.json` |
| **Agents**       | `.codex/agents/*.toml`    | `.opencode/agents/*.md`   | `.cursor/agents/*.md` | `.gemini/agents/*.md`   |
| **Commands**     | Converted to Skills       | `.opencode/commands/`     | `.cursor/commands/`   | Converted to Skills     |
| **Hooks**        | Documented in `AGENTS.md` | Documented in `AGENTS.md` | Warnings only         | Warnings only           |

### Model Mapping

| Claude Code       | → Codex   | → Antigravity    |
| ----------------- | --------- | ---------------- |
| `sonnet` / `opus` | `gpt-5.4` | `gemini-3-pro`   |
| `haiku`           | `gpt-5.4` | `gemini-3-flash` |
| (not specified)   | `gpt-5.4` | `gemini-3-pro`   |

OpenCode and Cursor keep the original model value.

## CLI Reference

### `acplugin scan [source]`

Scan and list convertible resources.

```bash
acplugin scan .                              # Current directory
acplugin scan ./my-project                   # Local path
acplugin scan anthropics/claude-code         # GitHub repo
acplugin scan https://github.com/owner/repo  # Full GitHub URL
acplugin scan owner/repo --path plugins/foo  # Sub-path in repo
```

### `acplugin convert [source]`

Convert Claude Code plugins to target platform formats.

```bash
acplugin convert .                           # Interactive: select platforms
acplugin convert . --to cursor               # Specify platform
acplugin convert . --to codex,antigravity    # Multiple platforms
acplugin convert anthropics/claude-code      # From GitHub, interactive
acplugin convert anthropics/claude-code --all  # All plugins, no prompt
acplugin convert . -o ./output               # Custom output directory
acplugin convert . --dry-run                 # Preview without writing
```

**Options:**

| Option                 | Description                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| `-t, --to <platforms>` | Target platforms (comma-separated: `codex`, `opencode`, `cursor`, `antigravity`) |
| `-o, --output <path>`  | Output directory                                                                 |
| `-a, --all`            | Convert all plugins without interactive selection                                |
| `-p, --path <subpath>` | Sub-path within repository                                                       |
| `--dry-run`            | Show what would be generated without writing                                     |

## Examples

### Convert a local project

```bash
cd my-project
acplugin convert . --to cursor,antigravity
```

### Convert from GitHub Plugin Marketplace

```bash
# Interactive: browse and select plugins
acplugin convert anthropics/claude-code

# Convert all plugins to all platforms
acplugin convert anthropics/claude-code --all -o ./converted
```

### Scan a repo to see available resources

```bash
$ acplugin scan anthropics/claude-code

Claude Code Plugin Marketplace
✔ Found 13 plugin(s) with resources

1. agent-sdk-dev [development] — 3 resource(s)
2. code-review [productivity] — 1 resource(s)
3. commit-commands [productivity] — 3 resource(s)
...
```

### Private repos

Set `GITHUB_TOKEN` to access private repositories:

```bash
export GITHUB_TOKEN=ghp_xxx
acplugin convert my-org/private-plugins --all --to codex
```

## How It Works

1. **Scan** — Detects Claude Code resources: `.claude/` project structure, `.claude-plugin/` plugin format, or marketplace repos
2. **Select** — Interactive TUI lets you pick which plugins and platforms to target
3. **Convert** — Transforms each resource to the target platform's format, with model mapping and field adaptation
4. **Report** — Shows what was generated, with warnings for resources that couldn't be fully converted

Claude-specific features (like `context: fork`, `agent: Explore`) are preserved as HTML comments in the output files for reference.

## License

MIT
