# ADR-0003: Separate repository toolchain and published runtime support

- Status: Accepted
- Date: 2026-08-08
- Applies to: ACPlugin 1.0

## Context

The repository build tool and the published packages have different Node.js constraints. tsdown 0.22.14 requires `^22.18.0 || >=24.11.0`, while ACPlugin intends to keep a supported Node 20 runtime. The previous Commander 15 dependency prevented that intent because it requires Node 22.12 or newer. Other direct runtime dependencies also require precise minor ranges rather than the broad `>=20` declaration.

## Decision

1. Repository development, build, and release verification use `^22.18.0 || >=24.11.0`; the standard CI version is 22.18.0.
2. The CLI pins Commander 14.0.1, whose engine range still includes Node 20. Existing CLI behavior is protected by subprocess tests.
3. All public packages declare the intersection supported by their current direct runtime dependencies: `^20.19.0 || ^22.13.0 || >=23.5.0`.
4. Generated Hooks/MCP code and package bundles retain the `node20` target. `@types/node` remains on the Node 20.19 API baseline.
5. Private package manifests are not mass-rewritten to the repository toolchain range. Core is not published and its emitted code remains part of the Node 20-targeted main-package bundle.
6. The repository Actions use Node 22.18 while published package manifests keep the separately declared Node 20.19-compatible runtime range.

## Consequences

- Node 20 support is expressed by the package runtime range rather than the repository build-tool range.
- Contributors use the Node version required by the build tool without forcing every consumer to use it.
- Runtime dependency upgrades must re-check the public engine intersection.
- Commander 15 features cannot be used while Node 20 remains supported; such an upgrade requires a new runtime-floor decision.

## Rejected alternatives

- Keeping every manifest at `>=20`: claims support for versions rejected by direct dependencies.
- Raising all public packages to Node 22.18: unnecessarily couples consumers to the repository build tool.
- Keeping Commander 15 while claiming Node 20 support: internally contradictory.
- Installing the full workspace on Node 20 in CI: exercises unsupported dev tooling instead of the published runtime.

## Evidence

- Root `package.json:7-9,29-44`
- `packages/acplugin/package.json:11,31-57`
- `packages/platforms/*/package.json:11`
- `packages/extensions/hooks/package.json:11,21-28`
- `packages/extensions/mcp/package.json:11,20-27`
- `.github/workflows/lint.yml`
- `.github/workflows/typecheck.yml`
- Locked manifests: tsdown 0.22.14, Commander 14.0.1, Chokidar 5.0.0, Rolldown 1.2.2, and `@inquirer/prompts` 8.5.2
