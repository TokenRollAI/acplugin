# @tokenroll/acplugin

## 0.0.3-beta

### Major Changes

- Add opaque, subject-bound Platform Component Contributions to the trusted Integration SDK. Core now transports strict JSON payloads and records scoped contributor provenance in BuildReport schema version 3 without acquiring Platform-specific Agent or target-format knowledge.

  Claude Code, Cursor, and OpenCode expose and render their own native Agent contribution payloads during Platform finalization. Codex, Antigravity, and Pi explicitly reject non-empty private component contributions rather than silently dropping them or generating fallback Skills.

  Harden `AssetService.fromBytes()` to accept only exact data-object inputs, exact generated-origin fields, and `string | Uint8Array` bytes so third-party Integrations cannot rely on accessor, hidden-field, or array-like coercion.

## 0.0.2-beta

### Major Changes

- 889da32: Replace the beta lifecycle contract with the Kernel v2 author facade and the `@tokenroll/acplugin/sdk` trusted-integration boundary while keeping `LIFECYCLE_API_VERSION` at `1`.

  Core now owns the fixed Platform/Extension session lifecycle, Rolldown-backed Module/Compiler services, capability-scoped Source/Asset/Execution services, Package Contribution merge, Core Node Runtime delivery, schema-v2 reports, DevSession watch coordination, and recoverable whole-output transactions.

  The CLI, project API, scaffolding, Migration validation, documentation, Playground, and packed-consumer verification now use this single architecture.
