# Manually releasing the public package cohort

> [中文对照](release.zh-CN.md)

The public packages are released at one version:

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-extension-hooks`
- `@tokenroll/acplugin-extension-mcp`

Core, the six built-in Platform packages, and the test workspace are private and must not be published or appear as packed runtime dependencies. Every npm publication, Registry check, Git tag, and GitHub Release is performed manually by an authorized maintainer. The repository has no automated publication workflow.

## Repository workflows

`Check` runs automatically for pull requests and performs only lint and typecheck.

`Patch` is manually dispatched from the repository default branch with a required target-branch input. The target branch must contain at least one effective Changeset that produces a public-package release; an empty Changeset does not pass the gate. Before any version write, the workflow checks the release plan with `pnpm changeset status`. It then consumes all Changesets with `pnpm version-packages`, verifies that the fixed public cohort version changed, refreshes the pnpm lockfile, runs lint and typecheck, and creates or updates a version PR whose base is the selected target branch.

The repository setting **Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests** must be enabled for `Patch` to create the PR with `GITHUB_TOKEN`. The workflow does not publish packages or create release references.

## Prepare a release

1. Add a Changeset for user-visible changes and version the fixed package group with `pnpm version-packages`.
2. Confirm all three public manifests have the same version and Extension peer dependencies still use `workspace:^` in the repository.
3. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run check
   pnpm run release:verify
   ```

`release:verify` packs all three packages in a temporary directory, runs type-resolution and package-lint checks on the actual tarballs, checks their manifests and contents, installs them into a clean external consumer, then imports/builds the default project and a generated six-Platform/two-Extension scaffold. It never publishes.

Commit the exact verified release preparation to `main` before packing the artifacts that will be published.

## Pack the release cohort

Create a private temporary directory outside the repository and pack in dependency-safe order:

```bash
ACPLUGIN_RELEASE_DIR="$(mktemp -d)"
pnpm --filter @tokenroll/acplugin-extension-hooks pack --pack-destination "$ACPLUGIN_RELEASE_DIR"
pnpm --filter @tokenroll/acplugin-extension-mcp pack --pack-destination "$ACPLUGIN_RELEASE_DIR"
pnpm --filter @tokenroll/acplugin pack --pack-destination "$ACPLUGIN_RELEASE_DIR"
```

Inspect the three generated tarball paths before continuing. They must be produced from the same verified revision and carry one exact version.

## Publish manually

An authorized TokenRoll npm organization maintainer publishes each generated tarball with 2FA. Use this strict order:

1. `@tokenroll/acplugin-extension-hooks`
2. `@tokenroll/acplugin-extension-mcp`
3. `@tokenroll/acplugin`

For each tarball, run the publication and exact-version check manually before continuing:

```bash
npm publish <tarball-path> --access public --otp <OTP>
npm view <package-name>@<version> version
```

Do not publish private `@acplugin/*` packages. If publication is interrupted, query every exact version and continue only with the first missing package in the prescribed order; npm versions are immutable and must not be republished.

## Create the release references manually

Only after all three exact npm versions are visible in the Registry may a maintainer create and push the matching tag:

```bash
git tag tokenroll-vX.Y.Z
git push origin tokenroll-vX.Y.Z
```

The tag does not trigger publication. Create the GitHub Release manually after verifying the pushed tag and all three Registry versions.

## Safety rules

- Never use `npm unpublish` or mutate dist-tags as part of recovery.
- Never create or push the tag before all three exact npm versions are verified.
- Never publish private `@acplugin/*` workspace packages.
- Never add or invoke automated npm publication, Tag creation, or GitHub Release automation without an explicit project decision.
- Remove the private temporary tarball directory after the release audit is complete.
