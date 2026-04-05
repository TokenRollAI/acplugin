# acplugin

## 1. Identity

- **What it is:** A CLI tool that converts Claude Code plugin configurations into equivalent formats for Codex CLI, OpenCode, Cursor IDE, and Google Antigravity.
- **Purpose:** Enables developers to maintain a single Claude Code configuration and automatically generate compatible configurations for other AI coding platforms.

## 2. High-Level Description

acplugin follows a scan-convert-write pipeline. It scans a local directory or a GitHub repository for Claude Code resources (skills, instructions, MCP server configs, agents, commands, and hooks), then converts each resource type into the target platform's native format, and writes the output files. Conversion is one-way (Claude Code to others, never bidirectional). Claude-specific fields that have no equivalent on a target platform are preserved as HTML comments or generate compatibility warnings. A model mapping module (`src/utils/model.ts`) translates Claude model names to platform equivalents (e.g., `gpt-5.4` for Codex, `gemini-3-pro`/`gemini-3-flash` for Antigravity).

The tool supports three input formats: standard Claude Code project layout (`.claude/` directory), single plugin (`.claude-plugin/plugin.json`), and multi-plugin marketplace (`.claude-plugin/marketplace.json`). Sources can be local paths or GitHub repositories (auto-detected from `owner/repo` syntax). For marketplace repos, an interactive TUI allows selecting which plugins and target platforms to convert. Cursor output uses `.cursor-plugin/` format with `plugin.json` manifest and resources at plugin root (`skills/`, `agents/`, `commands/`, `rules/`, `mcp.json`), compatible with Cursor Marketplace (v2.5+). OpenCode generates `.opencode/agents/*.md` with `mode: subagent`, `steps`, `permission` fields; Antigravity generates `.gemini/agents/*.md` with tool-mapped `allowed-tools` lists. GitHub Actions also handles automation around the project itself: `.github/workflows/acplugin.yml` runs conversion on push to main, and `.github/workflows/publish-npm.yml` publishes `@disdjj/acplugin` to npm from matching `v*` tags via npm Trusted Publishing.

**Tech Stack:** TypeScript, Node.js, Commander.js, gray-matter, @iarna/toml, glob, @inquirer/prompts, chalk, ora.

**Entry point:** `src/index.ts` - CLI binary registered as `acplugin` in package.json.
