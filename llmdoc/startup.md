# Startup

Read [Project overview](overview/project.md) and [System architecture](architecture/system.md) before changing runtime behavior.

Keep these invariants:

- pnpm monorepo without Turbo; Node.js >=20; ESM-only.
- Only `@tokenroll/acplugin` and the official Hooks/MCP Extensions are public.
- Core owns one lifecycle and transaction; Extensions join through restricted Adapters, while Platforms own output schemas and distributions.
- Commands, Skills, and Agents are Core Components. Instructions are out of scope.
- Claude Code and Codex are the default Platforms; Cursor, Antigravity, OpenCode, and Pi are explicit opt-ins.
- Migration stays lazy and isolated under `packages/acplugin/src/migration/`; legacy code is not normal runtime architecture.
- Preserve deterministic, strict, whole-output builds and never expose private `@acplugin/*` runtime dependencies.

Use `pnpm run check` for repository validation and `pnpm run release:verify` for packed external-consumer verification.
