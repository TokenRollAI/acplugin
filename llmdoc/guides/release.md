# Releasing the public package cohort

The public packages are released at one version:

- `@tokenroll/acplugin`
- `@tokenroll/acplugin-module-hooks`
- `@tokenroll/acplugin-module-mcp`

Core, the built-in Compilers, and the test workspace are private and must not be published or appear as packed runtime dependencies.

## Prepare a release

1. Add a Changeset for user-visible changes and version the fixed package group with `pnpm version-packages`.
2. Confirm all three public manifests have the same version and Module peer dependencies still use `workspace:^` in the repository.
3. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm run check
   pnpm run release:verify
   ```

`release:verify` packs all three packages, checks their manifests and contents, installs the tarballs into a clean external consumer, then typechecks, imports, validates, and builds that consumer.

## Bootstrap the first npm identities

The first `1.0.0` publication is manual because each scoped package identity must exist before Trusted Publishing can be configured. From the exact verified revision, create a private temporary tarball directory and pack the cohort:

```bash
pnpm --filter @tokenroll/acplugin-module-hooks pack --pack-destination ./release-tarballs
pnpm --filter @tokenroll/acplugin-module-mcp pack --pack-destination ./release-tarballs
pnpm --filter @tokenroll/acplugin pack --pack-destination ./release-tarballs
```

An authorized organization maintainer publishes those tarball paths with `npm publish <tarball> --access public --otp <OTP>` in Hooks → MCP → main order. After every command, verify `npm view <name>@1.0.0 version`. Do not create a release tag until all three exact versions exist. No automated implementation or test may perform this bootstrap.

Then configure Trusted Publishing separately for each npm package, restricted to repository `TokenRollAI/acplugin`, workflow `publish-npm.yml`, and the protected `npm` GitHub environment.

## Publish later versions from a tag

Commit the release preparation to `main`, then create `tokenroll-vX.Y.Z`. The tag must exactly match the fixed cohort version. Publishing is performed only by `.github/workflows/publish-npm.yml`; do not publish a partial cohort manually.

The workflow verifies Node 20 and 24, rebuilds and inspects the tarballs, publishes Hooks and MCP before the main package, verifies every exact registry version, and only then creates the GitHub Release. Existing exact versions are skipped so a safely rerun workflow can complete an interrupted cohort.

The workflow uses OIDC/provenance and does not require a long-lived npm token.

## Safety rules

- Never use `npm unpublish` or mutate dist-tags as part of recovery.
- Never create the tag until local verification succeeds.
- Never publish private `@acplugin/*` workspace packages.
- If a publish is interrupted, rerun the same tag workflow; its exact-version checks preserve completed members and continue in dependency-safe order.
