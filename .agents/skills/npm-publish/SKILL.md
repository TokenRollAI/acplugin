---
name: npm-publish
description: Prepare, verify, or explicitly publish the fixed @tokenroll/acplugin public package cohort with Changesets, pnpm tarballs, manual first-release 2FA, or the protected OIDC tag workflow. Use for release planning, versioning, dry runs, registry verification, and npm publication.
---

# Release the public cohort

Never create a tag, publish, unpublish, or change a dist-tag without explicit user authorization for that live mutation.

## Prepare and verify

1. Confirm the three public packages have one version and Modules use `workspace:^` for the main peer:
   - `@tokenroll/acplugin-module-hooks`
   - `@tokenroll/acplugin-module-mcp`
   - `@tokenroll/acplugin`
2. Add a Changeset and run `pnpm version-packages` when changing an existing release version. Keep private packages ignored.
3. Run:

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run release:verify
```

`release:verify` must prove that tarballs contain no private runtime dependency/source tests and that all three install, typecheck, import, validate, and build in an external clean consumer.

## First npm identity bootstrap

The first `1.0.0` publication is manual because each scoped package identity and 2FA must exist before Trusted Publishing can be configured. From the verified source revision, create pnpm tarballs and ask the authorized user to publish them in this order with `--access public` and OTP:

1. Hooks Module
2. MCP Module
3. Main package

Verify every exact version with `npm view <name>@<version> version`. Do not create the release tag until the cohort is complete.

## Subsequent OIDC releases

After npm Trusted Publishing is configured for `.github/workflows/publish-npm.yml` and the protected `npm` environment, push only the exact tag:

```text
tokenroll-vX.Y.Z
```

The workflow reruns verification, skips exact versions already present, publishes Modules before the main package, waits for registry visibility, and creates the GitHub Release last. It must not require a long-lived npm token and must never call unpublish.
