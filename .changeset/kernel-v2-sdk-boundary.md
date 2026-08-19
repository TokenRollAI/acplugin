---
"@tokenroll/acplugin": major
"@tokenroll/acplugin-platform-claude-code": major
"@tokenroll/acplugin-platform-codex": major
"@tokenroll/acplugin-platform-cursor": major
"@tokenroll/acplugin-platform-antigravity": major
"@tokenroll/acplugin-platform-opencode": major
"@tokenroll/acplugin-platform-pi": major
"@tokenroll/acplugin-extension-hooks": major
"@tokenroll/acplugin-extension-mcp": major
---

Replace the beta lifecycle contract with the Kernel v2 author facade and the `@tokenroll/acplugin/sdk` trusted-integration boundary. Platform and Extension definitions now use per-build sessions, copied and deeply frozen JSON options, shared cross-entry brands, Package Contributions, capability-scoped Source/Asset/Compiler services, and report schema version 2 while keeping `LIFECYCLE_API_VERSION` at `1`.

Rewrite the Claude Code Platform around the Package API, Core-owned Document codecs, add-only Hooks/MCP extension points, capability-negotiated Core Node Runtime delivery, and validated primary AssetRef inheritance for Marketplace distributions.

Rewrite the Codex Platform around the Package API and make `<plugin-name>-<command-id>` the sole default generated Skill identity. Validate the complete Skill namespace before Asset creation, inherit Core Runtime and validated primary Assets, and remove the obsolete generated ID strategy option.

Rewrite the Cursor Platform around the Package API, Core-owned Document codecs, native Component Assets, add-only Hooks/MCP extension points, final candidate validation, and explicit unsupported Node Runtime compatibility.

Rewrite the Antigravity Platform around the Package API, Core-owned Document codecs, pre-Asset fallback Skill identity validation, add-only Hooks/MCP root Assets, final candidate validation, and explicit unsupported Node Runtime compatibility.

Rewrite the OpenCode Platform around a first-class workspace Package, Core-owned omit-if-empty Document codecs, native workspace Component Assets, an add-only MCP field, final candidate validation, and explicit unsupported Node Runtime compatibility without Plugin-root emulation.

Rewrite the Pi Platform around the Package API, Core-owned npm Manifest codec, native Prompt/Skill delivery, Agent guidance Skills, add-only Hooks discovery, final package validation, and explicit unsupported MCP and Node Runtime behavior.

Rewrite the Hooks Extension around Core-owned portable-node compilation, one shared Built Handler state, SDK-only Platform Contributors, deterministic protocol adapters, and Core-managed Asset/License delivery.

Rewrite the MCP Extension around Core-owned portable-node compilation and execution, one shared stdio Bundle state, SDK-only Platform Contributors, deterministic transport configuration, protocol smoke validation, and Core-managed Asset/License delivery.
