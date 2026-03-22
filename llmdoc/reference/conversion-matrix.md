# Conversion Matrix

This document summarizes which Claude Code resource types are supported by each target platform, the supported input formats, and source types.

## 1. Core Summary

acplugin converts six Claude Code resource types (skills, instructions, MCP configs, agents, commands, hooks) across four target platforms (Codex, OpenCode, Cursor, Antigravity). All platforms now support agents natively via subagent files. Cursor outputs `.cursor-plugin/` format: `plugin.json` manifest + `skills/`, `agents/`, `commands/`, `rules/`, `mcp.json` at plugin root (compatible with Cursor Marketplace v2.5+). Antigravity maps: Skills → `.agent/skills/`, Instructions → `GEMINI.md`, MCP → `.gemini/settings.json`, Agents → `.gemini/agents/*.md`, Commands → Skills. OpenCode agents output `.opencode/agents/*.md` (fields: `mode: subagent`, `steps`, `permission`). Model names are mapped via `src/utils/model.ts` (Codex → `gpt-5.4`, Antigravity → `gemini-3-pro`/`gemini-3-flash`).

## 2. Source of Truth

- **Type Definitions:** `src/types.ts` - All resource types (`Skill`, `Instruction`, `MCPConfig`, `Agent`, `Command`, `Hooks`), plugin types (`PluginMeta`, `PluginScanResult`), and result types (`ScanResult`, `ConvertResult`, `ConvertedFile`).
- **GitHub Source Resolution:** `src/github.ts` - Parsing and downloading GitHub repos. Supported formats: `owner/repo`, `github:owner/repo#branch`, full URLs.
- **Plugin Scanner:** `src/scanner/plugin.ts` - Plugin format detection and scanning. Marketplace: `.claude-plugin/marketplace.json`. Single plugin: `.claude-plugin/plugin.json`. Plugin layout: `skills/`, `agents/`, `commands/`, `hooks/` directly in plugin root.
- **Project Scanner:** `src/scanner/claude.ts` - Standard Claude Code project scanning (`.claude/` directory layout).
- **TUI Selection:** `src/tui.ts` - Interactive plugin and platform selection via @inquirer/prompts.
- **Skill Converter:** `src/converter/skill.ts` - Platform-specific skill conversion logic.
- **Instruction Converter:** `src/converter/instructions.ts` - CLAUDE.md / rules conversion to AGENTS.md or .mdc.
- **MCP Converter:** `src/converter/mcp.ts` - MCP server config conversion to config.toml / opencode.json / mcp.json (Cursor plugin format).
- **Agent Converter:** `src/converter/agent.ts` - Native agent conversion for all four platforms. Cursor: `agents/*.md` (`name`, `description`, `model`, `readonly`). OpenCode: `.opencode/agents/*.md` (`mode: subagent`, `steps`, `permission`). Antigravity: `.gemini/agents/*.md` (tool-mapped `allowed-tools`).
- **Command Converter:** `src/converter/command.ts` - Command conversion across platforms. Antigravity converts commands to skills.
- **Hooks Converter:** `src/converter/hooks.ts` - Hook conversion with compatibility warnings for non-portable events.
- **Model Mapper:** `src/utils/model.ts` - Claude model → platform model mapping. Codex: `gpt-5.4`. Antigravity: `gemini-3-pro`/`gemini-3-flash`. OpenCode/Cursor: passthrough.
- **Codex Writer:** `src/writer/codex.ts` - Codex output orchestration.
- **OpenCode Writer:** `src/writer/opencode.ts` - OpenCode output orchestration.
- **Cursor Writer:** `src/writer/cursor.ts` - Cursor plugin format output. Generates `.cursor-plugin/plugin.json` manifest. Output paths remapped from `.cursor/` to plugin root: `skills/`, `agents/`, `commands/`, `rules/`, `mcp.json`.
- **Antigravity Writer:** `src/writer/antigravity.ts` - Antigravity (Google) output orchestration.
- **GitHub Action:** `.github/workflows/acplugin.yml` - CI workflow using `TokenRollAI/acplugin-action@v1`. Triggers on push to main when `.claude/` or `CLAUDE.md` changes. Auto-converts to all 4 platforms.
- **System Architecture:** `/llmdoc/architecture/system.md` - Full pipeline and execution flow.
