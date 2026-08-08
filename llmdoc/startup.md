# Startup

Read [Project overview](overview/project.md) and [System architecture](architecture/system.md) before changing runtime behavior.

Keep these invariants:

- pnpm monorepo without Turbo; Node.js >=20; ESM-only.
- `@tokenroll/acplugin`, six official Platform packages, and the official Hooks/MCP Extensions are public and independently versioned; only Core and the test workspace are private.
- Core owns one lifecycle and transaction; Extensions join through restricted Adapters, while Platforms own output schemas and distributions.
- Commands, Skills, and Agents are Core Components. Instructions are out of scope.
- `platforms` is required and contains explicitly imported package instances. Only `init` selects Claude Code and Codex when no scaffold option is supplied.
- Migration stays lazy and isolated under `packages/acplugin/src/migration/`; legacy code is not normal runtime architecture.
- Preserve deterministic, strict, whole-output builds. Official integrations import only the public main-package SDK through peer dependencies, and no public package exposes a private `@acplugin/*` runtime dependency.

Use `pnpm run check` for repository validation and `pnpm run release:verify` for packed external-consumer verification.
