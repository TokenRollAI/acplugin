# @tokenroll/acplugin

## 0.0.2-beta

### Major Changes

- 889da32: Replace the beta lifecycle contract with the Kernel v2 author facade and the `@tokenroll/acplugin/sdk` trusted-integration boundary while keeping `LIFECYCLE_API_VERSION` at `1`.

  Core now owns the fixed Platform/Extension session lifecycle, Rolldown-backed Module/Compiler services, capability-scoped Source/Asset/Execution services, Package Contribution merge, Core Node Runtime delivery, schema-v2 reports, DevSession watch coordination, and recoverable whole-output transactions.

  The CLI, project API, scaffolding, Migration validation, documentation, Playground, and packed-consumer verification now use this single architecture.
