---
name: npm-publish
description: Prepare, verify, or explicitly publish the fixed @tokenroll/acplugin public package cohort with Changesets, pnpm tarballs, and maintainer-operated npm 2FA. Use for release planning, versioning, dry runs, registry verification, and fully manual npm publication.
---

# Release the public cohort

Never create or push a tag, publish, unpublish, change a dist-tag, or create a GitHub Release without explicit user authorization for that exact live mutation. Repository workflows must not automate those actions.

## Prepare and verify

1. Confirm the three public packages have one version and Extensions use `workspace:^` for the main peer:
   - `@tokenroll/acplugin-extension-hooks`
   - `@tokenroll/acplugin-extension-mcp`
   - `@tokenroll/acplugin`
2. Add a Changeset and run `pnpm version-packages` when changing an existing release version. Keep private packages ignored.
3. Run:

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run release:verify
```

`release:verify` must prove that tarballs contain no private runtime dependency/source tests and that all three install, typecheck, import, validate, and build in an external clean consumer.

## Publish manually

From the verified source revision, create pnpm tarballs outside the repository and ask an authorized TokenRoll maintainer to publish them in this order with `--access public` and OTP:

1. Hooks Extension
2. MCP Extension
3. Main package

Verify every exact version with `npm view <name>@<version> version`. If interrupted, resume only at the first missing exact version; never republish an existing version.

## Create release references manually

Only after all three exact versions are visible may the authorized maintainer create and push the matching tag:

```text
tokenroll-vX.Y.Z
```

The tag does not trigger publication. Create the GitHub Release manually after verifying the pushed tag and Registry cohort. Never add an automated npm, Tag, dist-tag, or GitHub Release workflow without a new explicit project decision.
