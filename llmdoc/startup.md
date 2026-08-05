# Startup

Read [Project overview](overview/project.md) and [System architecture](architecture/system.md) before changing runtime behavior.

Keep these invariants:

- pnpm monorepo without Turbo; Node.js >=20; ESM-only.
- Only `@tokenroll/acplugin` and the official Hooks/MCP Modules are public.
- Core owns one lifecycle and transaction; Modules extend it, Compilers own target output.
- Commands, Skills, and Agents are Core Components. Instructions are out of scope.
- Claude Code and Codex are the default targets.
- Migration stays lazy and isolated under `packages/acplugin/src/migration/`; legacy code is not normal runtime architecture.
- Preserve deterministic, strict, whole-output builds and never expose private `@acplugin/*` runtime dependencies.

Use `pnpm run check` for repository validation and `pnpm run release:verify` for packed external-consumer verification.
