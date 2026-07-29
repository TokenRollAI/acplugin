# Conversion Matrix

This document summarizes which Claude Code resource types are supported by each target platform, the supported input formats, and source types.

## 1. Core Summary

acplugin converts six Claude Code resource types (skills, instructions, MCP configs, agents, commands, hooks) across five target platforms (Codex, OpenCode, Cursor, Antigravity, Pi). Codex/OpenCode/Cursor/Antigravity support agents natively via subagent files; Pi does not. Pi (pi-coding-agent, earendil-works/pi) is a minimal terminal harness whose only native file formats are Claude-style Skills (`.pi/skills/<name>/SKILL.md`) and instructions (`AGENTS.md`); Commands degrade to prompt templates (`.pi/prompts/*.md`), and MCP/Agents/Hooks have no Pi file format (extended via TypeScript extensions) so the Pi writer emits warnings instead. Model names pass through unchanged for Pi. Cursor outputs `.cursor-plugin/` format: `plugin.json` manifest + `skills/`, `agents/`, `commands/`, `rules/`, `mcp.json` at plugin root (plugin/marketplace format introduced in Cursor 3.9, 2026-06). Antigravity maps (CLI workspace convention, plural `.agents/`): Skills → `.agents/skills/`, Instructions → `GEMINI.md`, MCP → `.agents/mcp_config.json` (remote servers use `serverUrl`), Agents → `.agents/agents/*.md` (Claude tool list preserved as a comment — Antigravity's internal tool identifiers are unpublished), Commands → Skills. OpenCode agents output `.opencode/agents/*.md` (fields: `mode: subagent`, `steps`, `permission`); OpenCode MCP uses a single `command` string array + `environment` key + `enabled`. Model names are mapped via `src/utils/model.ts` (Codex → `gpt-5.6-sol`/`gpt-5.6-terra`, Antigravity → `gemini-3.1-pro-preview`/`gemini-3.6-flash`).

## 2. Source of Truth

- **Type Definitions:** `src/types.ts` - All resource types (`Skill`, `Instruction`, `MCPConfig`, `Agent`, `Command`, `Hooks`), plugin types (`PluginMeta`, `PluginScanResult`), and result types (`ScanResult`, `ConvertResult`, `ConvertedFile`). `PluginMeta` includes optional `displayName`, `homepage`, `repository`, `license`, `keywords` fields.
- **Integration Tests:** `src/__tests__/superpowers-integration.test.ts` - 51 integration tests using real superpowers plugin data covering full pipeline.
- **GitHub Source Resolution:** `src/github.ts` - Parsing and downloading GitHub repos. Supported formats: `owner/repo`, `github:owner/repo#branch`, full URLs.
- **Plugin Scanner:** `src/scanner/plugin.ts` - Plugin format detection and scanning. Marketplace: `.claude-plugin/marketplace.json`. Single plugin: `.claude-plugin/plugin.json`. Plugin layout: `skills/`, `agents/`, `commands/`, `hooks/` directly in plugin root.
- **Project Scanner:** `src/scanner/claude.ts` - Standard Claude Code project scanning (`.claude/` directory layout).
- **TUI Selection:** `src/tui.ts` - Interactive plugin and platform selection via @inquirer/prompts.
- **Skill Converter:** `src/converter/skill.ts` - Platform-specific skill conversion logic.
- **Instruction Converter:** `src/converter/instructions.ts` - CLAUDE.md / rules conversion to AGENTS.md or .mdc.
- **MCP Converter:** `src/converter/mcp.ts` - MCP server config conversion to config.toml / opencode.json / mcp.json (Cursor plugin format).
- **Agent Converter:** `src/converter/agent.ts` - Native agent conversion for Codex, OpenCode, Cursor, and Antigravity. Cursor: `agents/*.md` (`name`, `description`, `model`, `readonly`). OpenCode: `.opencode/agents/*.md` (`mode: subagent`, `steps`, `permission`). Antigravity: `.agents/agents/*.md` (Claude tool list preserved as an HTML comment; no `allowed-tools` allowlist emitted because Antigravity's internal tool identifiers are unpublished). The `'pi'` case throws because Pi has no subagent format and its writer never calls this converter.
- **Command Converter:** `src/converter/command.ts` - Command conversion across platforms. Antigravity converts commands to skills.
- **Hooks Converter:** `src/converter/hooks.ts` - Hook conversion with compatibility warnings for non-portable events. Cursor hooks get dedicated conversion: PascalCase → camelCase event names, `${CLAUDE_PLUGIN_ROOT}` stripped to relative paths, output as `hooks/hooks-cursor.json` with `{ version: 1 }` format.
- **Model Mapper:** `src/utils/model.ts` - Claude model → platform model mapping. Codex: `gpt-5.6-sol` (default), `gpt-5.6-terra` (haiku tier). Antigravity: `gemini-3.1-pro-preview`, `gemini-3.6-flash`. OpenCode/Cursor: passthrough.
- **Codex Writer:** `src/writer/codex.ts` - Codex output orchestration.
- **OpenCode Writer:** `src/writer/opencode.ts` - OpenCode output orchestration.
- **Cursor Writer:** `src/writer/cursor.ts` - Cursor plugin format output. Generates `.cursor-plugin/plugin.json` manifest with passthrough of `displayName`, `homepage`, `repository`, `license`, `keywords` and `hooks` field. Output paths remapped from `.cursor/` to plugin root: `skills/`, `agents/`, `commands/`, `rules/`, `mcp.json`.
- **Antigravity Writer:** `src/writer/antigravity.ts` - Antigravity (Google) output orchestration.
- **Pi Writer:** `src/writer/pi.ts` (`generatePi`) - Pi (pi-coding-agent) output orchestration. Converts Skills → `.pi/skills/`, Instructions → `AGENTS.md`, Commands → `.pi/prompts/*.md` (prompt templates). Emits warnings for MCP, agents, and hooks (no Pi file format). The MCP/agent/hooks converters throw or return null for the `'pi'` case since the writer never calls them.
- **GitHub Action:** `.github/workflows/acplugin.yml` - CI workflow using `TokenRollAI/acplugin-action@v1`. Triggers on push to main when `.claude/` or `CLAUDE.md` changes. Auto-converts to all 5 platforms.
- **System Architecture:** `/llmdoc/architecture/system.md` - Full pipeline and execution flow.
