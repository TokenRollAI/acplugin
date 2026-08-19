# Startup

Read [Project overview](overview/project.md) and [System architecture](architecture/system.md) before changing runtime behavior.

Keep these invariants:

- pnpm monorepo without Turbo; Node.js >=20; ESM-only.
- `@tokenroll/acplugin`, six official Platform packages, and the official Hooks/MCP Extensions are public and independently versioned; Core, test, Docs, and Playground are private. Node Runtime is built into Core.
- Core owns one lifecycle and transaction; Extensions join through unordered add-only Contributors, while Platforms own Package schemas and distributions.
- Commands, Skills, and Agents are Core Components. Instructions are out of scope.
- `platforms` is required and contains explicitly imported package instances. Only `init` selects Claude Code and Codex when no scaffold option is supplied.
- Migration stays lazy and isolated under `packages/acplugin/src/migration/`; legacy code is not normal runtime architecture.
- Preserve deterministic, strict, whole-output builds. Official integrations import only the public main-package SDK through peer dependencies, and no public package exposes a private `@acplugin/*` runtime dependency.

Use `pnpm run check` for runtime repository validation, `pnpm run docs:check` for Docs/Playground validation, and `pnpm run release:verify` for packed external-consumer verification.
