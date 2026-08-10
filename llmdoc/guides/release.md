# Manually releasing independently versioned public packages

> [中文对照](release.zh-CN.md)

The repository has nine independently versioned public packages:

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-platform-claude-code`
- `@tokenroll/acplugin-platform-codex`
- `@tokenroll/acplugin-platform-cursor`
- `@tokenroll/acplugin-platform-antigravity`
- `@tokenroll/acplugin-platform-opencode`
- `@tokenroll/acplugin-platform-pi`
- `@tokenroll/acplugin-extension-hooks`
- `@tokenroll/acplugin-extension-mcp`

Core, the test workspace, Docs, and Playground are private and must not be published or appear as packed runtime dependencies. Every npm publication, Registry check, Git tag, and GitHub Release is performed manually by an authorized maintainer. The repository has no automated publication workflow.

Repository build and release tooling requires Node.js `^22.18.0 || >=24.11.0`; CI uses 22.18.0. All nine public packages currently declare the separate runtime range `^20.19.0 || ^22.13.0 || >=23.5.0`.

## Repository workflows

`Check` runs automatically for pull requests. One job performs lint and typecheck; an independent job runs `docs:check`, which rebuilds generated API pages, checks VitePress links/structure, and validates/builds the real Playground.

`Verify` is manually dispatched with read-only repository permissions. It builds and validates all nine tarballs from one revision on Node 22.18, uploads that exact artifact set, then consumes it in a clean Node 20.19 project. It never publishes or creates release references. Verifying one revision together does not make the packages a fixed version cohort.

`Patch` is manually dispatched from the repository default branch with a required target-branch input. The target branch must contain at least one effective Changeset that releases a public package; an empty Changeset does not pass the gate. Before any version write, the workflow checks the release plan with `pnpm changeset status`. It then consumes all Changesets with `pnpm version-packages`, verifies that at least one public version changed, refreshes the pnpm lockfile, runs lint and typecheck, and creates or updates a version PR whose base is the selected target branch.

The repository setting **Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests** must be enabled for `Patch` to create the PR with `GITHUB_TOKEN`. The workflow does not publish packages or create release references.

## Prepare a release

1. Add Changesets for the affected public packages. Integration changes should name their owning Platform or Extension package; change the main package only when its CLI or public SDK changes.
2. Inspect `pnpm changeset status`, consume the Changesets with `pnpm version-packages`, refresh the lockfile with `pnpm install --lockfile-only`, and confirm only the intended manifests changed. Versions need not match.
3. Confirm every official Platform/Extension still declares `@tokenroll/acplugin` as `workspace:^` in the repository. Packing must rewrite it to a normal `^x.y.z` peer range.
4. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run check
   pnpm run docs:check
   pnpm run release:verify
   ```

`release:verify` packs all nine packages in a temporary directory, runs type-resolution and package-lint checks on the actual tarballs, validates manifests and contents, verifies peer rewriting and private Symbol-brand interoperability through one main-package peer instance, then installs and builds a six-Platform/two-Extension scaffold in a clean external consumer. For the main package it parses the packed ESM graph, proves the CLI-to-Migration edge remains lazy, checks every external import against declared runtime dependencies, and rejects normal runtime dependencies on official integrations. It never publishes. CI passes `--tarball-dir <empty-directory>` to retain the exact verified files for the separate Node 20.19 consumer job; local calls can use the same option when tarballs need to be retained for release.

Commit the exact verified release preparation before publishing. Do not rebuild from another revision after verification.

## Select the tarballs to publish

Publish only packages whose versions changed in the release plan. Retain or download the exact nine-tarball artifact set produced by `release:verify`, then select the changed package tarballs from that set. The unchanged tarballs are cross-package verification inputs, not releases.

Before publishing an integration, inspect its packed peer range for `@tokenroll/acplugin`:

- if that range requires a new main-package version from the same release, publish and verify the main package first;
- if the range is already satisfied in the Registry, the integration can be published independently;
- Platform and Extension packages have no ordering dependency on one another.

## Publish manually

An authorized TokenRoll npm organization maintainer publishes each selected tarball with 2FA and immediately checks its exact version:

```bash
npm publish <tarball-path> --access public --otp <OTP>
npm view <package-name>@<version> version
```

For the first publication of the nine `0.0.1-beta` packages, a maintainer may use the simplified root command:

```bash
pnpm run publish:beta
```

The root `prepublish:beta` first runs a frozen install and `release:preflight`. The preflight performs lint and typecheck, builds the workspace once, runs tests with package pre/post scripts disabled, validates Docs/Playground without rebuilding the workspace, and finishes with `release:verify`. `pnpm -r publish` then selects only the public `@tokenroll/*` packages, pins the npmjs Registry and the `beta` tag, and lets every public package rebuild itself through `prepublishOnly` immediately before packing. This command is limited to the initial nine-package `0.0.1-beta` cohort; it must not be reused for stable or independently versioned incremental releases, or invoked by a Workflow.

If publication is interrupted, query every planned exact version and continue only with missing versions whose peer dependencies are already available. npm versions are immutable and must not be republished.

## Create release references manually

The old single-cohort `tokenroll-vX.Y.Z` tag cannot represent independently versioned packages and no longer applies. After an exact package version is visible in the Registry, a maintainer may create its package-specific tag and GitHub Release using the repository's separately approved naming convention. Do not guess or automate that convention in a workflow.

## Safety rules

- Never use `npm unpublish` or mutate dist-tags as part of recovery.
- Never publish an integration before its packed main-package peer range exists in the Registry.
- Never publish private `@acplugin/*` workspace packages.
- Never publish an unchanged package merely because all nine were verified together.
- Never create or push release references before their exact npm versions are verified.
- Never add or invoke automated npm publication, Tag creation, or GitHub Release automation without an explicit project decision.
- Remove private temporary tarball directories after the release audit is complete.
