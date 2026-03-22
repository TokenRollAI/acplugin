# acplugin

## 1. Identity

- **What it is:** A CLI tool that converts Claude Code plugin configurations into equivalent formats for Codex CLI, OpenCode, and Cursor IDE.
- **Purpose:** Enables developers to maintain a single Claude Code configuration and automatically generate compatible configurations for other AI coding platforms.

## 2. High-Level Description

acplugin follows a scan-convert-write pipeline. It scans a local directory or a GitHub repository for Claude Code resources (skills, instructions, MCP server configs, agents, commands, and hooks), then converts each resource type into the target platform's native format, and writes the output files. Conversion is one-way (Claude Code to others, never bidirectional). Claude-specific fields that have no equivalent on a target platform are preserved as HTML comments or generate compatibility warnings.

The tool supports three input formats: standard Claude Code project layout (`.claude/` directory), single plugin (`.claude-plugin/plugin.json`), and multi-plugin marketplace (`.claude-plugin/marketplace.json`). Sources can be local paths or GitHub repositories (auto-detected from `owner/repo` syntax). For marketplace repos, an interactive TUI allows selecting which plugins and target platforms to convert.

**Tech Stack:** TypeScript, Node.js, Commander.js, gray-matter, @iarna/toml, glob, @inquirer/prompts, chalk, ora.

**Entry point:** `src/index.ts` - CLI binary registered as `acplugin` in package.json.
